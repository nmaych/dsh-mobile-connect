/**
 * Pairing — the only way a phone gets in.
 *
 * The desktop shows a 6-digit code; the phone trades that code for a long-lived
 * device token. The code is short because a human retypes it, the token is 32
 * random bytes because a machine carries it.
 *
 * Brute force is the threat that matters: six digits is only a million
 * combinations, so the code is defended by an attempt budget rather than by
 * entropy. Guessing wrong enough times invalidates the code, so an attacker
 * locks themselves out instead of converging on the answer.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Digits a human retypes from the desktop screen. */
const CODE_DIGITS = 6
/** Wrong guesses allowed against one code before it is burned. */
const MAX_FAILED_ATTEMPTS = 8
/** Device tokens are bearer credentials, so they carry full entropy. */
const TOKEN_BYTES = 32

/** Constant-time string compare that tolerates unequal lengths. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  if (left.byteLength !== right.byteLength) return false
  return crypto.timingSafeEqual(left, right)
}

/** Hash a device token for storage, so a leaked file grants nothing. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/** Generate a numeric code with a leading zero preserved. */
function generateCode() {
  let out = ''
  for (let i = 0; i < CODE_DIGITS; i += 1) out += String(crypto.randomInt(0, 10))
  return out
}

/**
 * Owns the pairing code and the registry of paired devices.
 *
 * Devices persist across restarts (a phone should not re-pair every time the
 * desktop reboots); the code does not, because it is a short-lived secret.
 */
export class PairingService {
  #code = ''
  #codeIssuedAt = 0
  #ttlMs
  #failedAttempts = 0
  /** True once a code has been burned by repeated wrong guesses. */
  #locked = false
  #devices = new Map()
  #storeFile
  #log

  /**
   * @param options.storeDir - directory holding `devices.json`.
   * @param options.ttlMinutes - how long one code stays valid.
   * @param options.log - logger with `info`/`warn`.
   */
  constructor({ storeDir, ttlMinutes, log }) {
    // Millisecond granularity: a caller asking for 30 seconds should get 30
    // seconds, not a rounded-up minute. The floor only guards against a
    // non-finite value turning the code into an immortal one.
    const millis = Math.round(Number(ttlMinutes) * 60 * 1000)
    this.#ttlMs = Number.isFinite(millis) && millis > 0 ? millis : 10 * 60 * 1000
    this.#storeFile = path.join(storeDir, 'devices.json')
    this.#log = log
    this.#load()
  }

  // --------------------------------------------------------------- the code

  /**
   * Issue a fresh code, invalidating any previous one.
   *
   * Called at startup and after every successful pairing, so a code is never
   * reusable once it has done its job. It also clears a lockout: a user who was
   * locked out asks the desktop for a new code, and that request is the
   * legitimate path back in.
   *
   * @returns the new code.
   */
  issueCode() {
    this.#code = generateCode()
    this.#codeIssuedAt = Date.now()
    this.#failedAttempts = 0
    this.#locked = false
    return this.#code
  }

  /** Whether a code is currently valid. */
  get hasLiveCode() {
    return this.#code !== '' && Date.now() - this.#codeIssuedAt < this.#ttlMs
  }

  /** Whether the last code was burned by repeated wrong guesses. */
  get isLocked() {
    return this.#locked
  }

  /** Seconds until the current code expires, or 0 when there is none. */
  get codeExpiresInSeconds() {
    if (!this.hasLiveCode) return 0
    return Math.max(0, Math.round((this.#codeIssuedAt + this.#ttlMs - Date.now()) / 1000))
  }

  /**
   * Absolute expiry of the current code as epoch milliseconds, or null when
   * there is none.
   *
   * The GUI counts down against this rather than against a seconds-remaining
   * value it captured earlier: a client that re-derives the deadline from a
   * rounded remainder drifts away from the real expiry with every poll.
   */
  get codeExpiresAt() {
    if (!this.hasLiveCode) return null
    return this.#codeIssuedAt + this.#ttlMs
  }

  /** The current code, reissuing one when the old has expired. */
  currentCode() {
    if (!this.hasLiveCode) this.issueCode()
    return this.#code
  }

  /**
   * The current code without ever issuing one.
   *
   * This is what a read-only surface must use. {@link currentCode} silently mints
   * a replacement when the old code has lapsed, which is right for a human
   * asking "what is my code?" and catastrophic for a GUI that polls: every poll
   * after the TTL would rotate the code out from under the user typing it, and
   * the code on screen would never be the code that works.
   *
   * @returns the live code, or null when there is none.
   */
  peekCode() {
    return this.hasLiveCode ? this.#code : null
  }

  /**
   * Trade a code for a device token.
   *
   * @param code - the value the user retyped.
   * @param name - a human label for the device list.
   * @returns `{ ok: true, token }` or `{ ok: false, reason }` where reason is
   *   one of `no-code`, `expired`, `locked`, `mismatch`.
   */
  redeem(code, name) {
    // A burned code reports `locked`, not `no-code`: the user is still looking
    // at a code on screen, so "there is no code" would be a lie that sends them
    // hunting for the wrong problem.
    if (this.#locked) return { ok: false, reason: 'locked' }
    if (!this.hasLiveCode) {
      return { ok: false, reason: this.#code === '' ? 'no-code' : 'expired' }
    }

    if (!safeEqual(String(code ?? '').trim(), this.#code)) {
      this.#failedAttempts += 1
      if (this.#failedAttempts >= MAX_FAILED_ATTEMPTS) {
        // Burn the code: the legitimate user just asks the desktop for a new one.
        this.#code = ''
        this.#locked = true
        this.#log?.warn?.(
          `[dsh-mobile-connect] 配对码连续输错 ${MAX_FAILED_ATTEMPTS} 次，已作废。请重新生成。`,
        )
        return { ok: false, reason: 'locked' }
      }
      return { ok: false, reason: 'mismatch' }
    }

    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex')
    const record = {
      hash: hashToken(token),
      name: String(name ?? '').trim().slice(0, 64) || '未命名设备',
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
    }
    this.#devices.set(record.hash, record)
    this.#persist()

    // One code, one device: the next phone needs a fresh code.
    this.issueCode()
    return { ok: true, token, device: record }
  }

  // -------------------------------------------------------------- the devices

  /**
   * Resolve a presented token to its device record.
   * @returns the record, or undefined when the token is unknown.
   */
  verifyDeviceToken(token) {
    if (typeof token !== 'string' || token.length === 0) return undefined
    const record = this.#devices.get(hashToken(token))
    if (record === undefined) return undefined
    // Touch at most once a minute: this is bookkeeping, not a hot path.
    if (Date.now() - record.lastSeenAt > 60_000) {
      record.lastSeenAt = Date.now()
      this.#persist()
    }
    return record
  }

  /** Paired devices, newest first, without their token hashes. */
  listDevices() {
    return [...this.#devices.values()]
      .map((d) => ({ name: d.name, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt }))
      .sort((a, b) => b.pairedAt - a.pairedAt)
  }

  /**
   * Forget one device by its position in {@link listDevices}.
   * @returns true when a device was removed.
   */
  revokeByIndex(index) {
    const ordered = [...this.#devices.values()].sort((a, b) => b.pairedAt - a.pairedAt)
    const target = ordered[index]
    if (target === undefined) return false
    this.#devices.delete(target.hash)
    this.#persist()
    return true
  }

  /** Forget every device. */
  revokeAll() {
    const count = this.#devices.size
    this.#devices.clear()
    this.#persist()
    return count
  }

  get deviceCount() {
    return this.#devices.size
  }

  /**
   * Write a machine-readable status file.
   *
   * The console panel is for a human; this is for anything that needs to know
   * the current code without screen-scraping (a helper script, the desktop UI,
   * a test). It lives in the Harness home beside the credential store, so it
   * inherits the same filesystem protections. The code it contains is short
   * lived and rate limited, so this adds no meaningful exposure.
   *
   * @param extra - additional fields to publish (port, addresses, …).
   */
  writeStatusFile(extra = {}) {
    const statusFile = path.join(path.dirname(this.#storeFile), 'status.json')
    const payload = {
      version: 1,
      code: this.hasLiveCode ? this.#code : null,
      codeExpiresAt: this.hasLiveCode ? this.#codeIssuedAt + this.#ttlMs : null,
      locked: this.#locked,
      deviceCount: this.#devices.size,
      updatedAt: Date.now(),
      ...extra,
    }
    try {
      fs.mkdirSync(path.dirname(statusFile), { recursive: true })
      const tmp = `${statusFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      fs.renameSync(tmp, statusFile)
    } catch (error) {
      this.#log?.warn?.(`[dsh-mobile-connect] 写入状态文件失败：${error?.message ?? error}`)
    }
    return statusFile
  }

  // ------------------------------------------------------------ persistence

  #load() {
    try {
      if (!fs.existsSync(this.#storeFile)) return
      const parsed = JSON.parse(fs.readFileSync(this.#storeFile, 'utf8'))
      for (const entry of parsed?.devices ?? []) {
        if (typeof entry?.hash !== 'string') continue
        this.#devices.set(entry.hash, {
          hash: entry.hash,
          name: typeof entry.name === 'string' ? entry.name : '未命名设备',
          pairedAt: Number(entry.pairedAt) || 0,
          lastSeenAt: Number(entry.lastSeenAt) || 0,
        })
      }
    } catch (error) {
      // A corrupt store must not stop the desktop from booting; the cost is
      // that already-paired phones have to pair again.
      this.#log?.warn?.(
        `[dsh-mobile-connect] 读取已配对设备失败（${error?.message ?? error}），本次将重新开始配对。`,
      )
    }
  }

  #persist() {
    try {
      fs.mkdirSync(path.dirname(this.#storeFile), { recursive: true })
      const payload = JSON.stringify({ version: 1, devices: [...this.#devices.values()] }, null, 2)
      const tmp = `${this.#storeFile}.tmp`
      fs.writeFileSync(tmp, payload, 'utf8')
      fs.renameSync(tmp, this.#storeFile)
    } catch (error) {
      this.#log?.warn?.(`[dsh-mobile-connect] 保存已配对设备失败：${error?.message ?? error}`)
    }
  }
}
