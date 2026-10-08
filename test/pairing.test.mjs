// Unit tests for the pairing service: the security-critical piece.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PairingService } from '../lib/pairing.js'

const results = []
// Checks may be async (the expiry test waits), so each runs as a promise that
// the summary below awaits. `check` itself stays synchronous so the call sites
// read as plain statements.
const pending = []
function check(name, fn) {
  pending.push(
    (async () => {
      try {
        await fn()
        results.push({ name, ok: true })
        console.log(`PASS  ${name}`)
      } catch (error) {
        results.push({ name, ok: false, detail: error.message })
        console.log(`FAIL  ${name}\n      ${error.message}`)
      }
    })(),
  )
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-connect-test-'))
const silent = { info() {}, warn() {} }

check('issues a 6-digit code', () => {
  const p = new PairingService({ storeDir: dir, ttlMinutes: 10, log: silent })
  const code = p.issueCode()
  assert.match(code, /^[0-9]{6}$/, `expected 6 digits, got ${code}`)
})

check('a fresh code is live', () => {
  const p = new PairingService({ storeDir: dir, ttlMinutes: 10, log: silent })
  p.issueCode()
  assert.equal(p.hasLiveCode, true)
})

check('redeeming the right code returns a token', () => {
  const p = new PairingService({ storeDir: dir, ttlMinutes: 10, log: silent })
  const code = p.issueCode()
  const result = p.redeem(code, '测试手机')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.token, /^[0-9a-f]{64}$/, 'token should be 32 random bytes as hex')
})

check('a redeemed token authenticates', () => {
  const p = new PairingService({ storeDir: dir, ttlMinutes: 10, log: silent })
  const code = p.issueCode()
  const { token } = p.redeem(code, '测试手机')
  const device = p.verifyDeviceToken(token)
  assert.ok(device, 'token should resolve to a device')
  assert.equal(device.name, '测试手机')
})

check('a wrong token does not authenticate', () => {
  const p = new PairingService({ storeDir: dir, ttlMinutes: 10, log: silent })
  p.issueCode()
  assert.equal(p.verifyDeviceToken('deadbeef'.repeat(8)), undefined)
  assert.equal(p.verifyDeviceToken(''), undefined)
  assert.equal(p.verifyDeviceToken(undefined), undefined)
})

check('the code is single-use: a second redeem of the same code fails', () => {
  const p = new PairingService({ storeDir: dir, ttlMinutes: 10, log: silent })
  const code = p.issueCode()
  assert.equal(p.redeem(code, 'a').ok, true)
  const second = p.redeem(code, 'b')
  assert.equal(second.ok, false, 'the old code must not work again')
})

check('a wrong code is rejected', () => {
  const p = new PairingService({ storeDir: dir, ttlMinutes: 10, log: silent })
  const code = p.issueCode()
  const wrong = code === '000000' ? '111111' : '000000'
  const result = p.redeem(wrong, 'attacker')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'mismatch')
})

check('brute force burns the code', () => {
  const p = new PairingService({ storeDir: dir, ttlMinutes: 10, log: silent })
  const real = p.issueCode()
  // Guess wrong until the budget runs out.
  let last
  for (let i = 0; i < 8; i += 1) {
    const guess = String(i).padStart(6, '0') === real ? '999999' : String(i).padStart(6, '0')
    last = p.redeem(guess, 'attacker')
  }
  assert.equal(last.ok, false)
  assert.equal(last.reason, 'locked', `expected locked, got ${last.reason}`)
  // The real code must no longer work either — that is the point of burning it.
  const after = p.redeem(real, 'owner')
  assert.equal(after.ok, false, 'a burned code must not be redeemable')
})

check('an expired code is refused', async () => {
  // A 50ms TTL, then wait past it. The service works in milliseconds so this
  // does not need a ten-minute sleep.
  const tiny = new PairingService({ storeDir: dir, ttlMinutes: 50 / 60000, log: silent })
  const shortCode = tiny.issueCode()
  assert.equal(tiny.hasLiveCode, true)
  await new Promise((r) => setTimeout(r, 90))
  assert.equal(tiny.hasLiveCode, false, 'the code should have lapsed')
  const result = tiny.redeem(shortCode, 'late')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'expired', `expected expired, got ${result.reason}`)
})

check('devices survive a restart', () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-connect-persist-'))
  const first = new PairingService({ storeDir: dir2, ttlMinutes: 10, log: silent })
  const code = first.issueCode()
  const { token } = first.redeem(code, '持久化手机')

  const second = new PairingService({ storeDir: dir2, ttlMinutes: 10, log: silent })
  const device = second.verifyDeviceToken(token)
  assert.ok(device, 'a paired device must still authenticate after a restart')
  assert.equal(device.name, '持久化手机')
})

check('the token is not stored in plaintext', () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-connect-hash-'))
  const p = new PairingService({ storeDir: dir3, ttlMinutes: 10, log: silent })
  const code = p.issueCode()
  const { token } = p.redeem(code, 'hash 检查')
  const raw = fs.readFileSync(path.join(dir3, 'devices.json'), 'utf8')
  assert.ok(!raw.includes(token), 'the raw token must never be written to disk')
})

check('revoking a device invalidates its token', () => {
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-connect-revoke-'))
  const p = new PairingService({ storeDir: dir4, ttlMinutes: 10, log: silent })
  const a = p.redeem(p.issueCode(), '手机A')
  const b = p.redeem(p.issueCode(), '手机B')
  assert.equal(p.deviceCount, 2)
  assert.equal(p.revokeByIndex(0), true)
  assert.equal(p.deviceCount, 1)
  // Newest first: 手机B was paired last, so index 0 removed it.
  assert.equal(p.verifyDeviceToken(b.token), undefined, 'the revoked device must be refused')
  assert.ok(p.verifyDeviceToken(a.token), 'the other device must still work')
})

check('revokeAll clears everything', () => {
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-connect-revokeall-'))
  const p = new PairingService({ storeDir: dir5, ttlMinutes: 10, log: silent })
  const { token } = p.redeem(p.issueCode(), '手机')
  assert.equal(p.revokeAll(), 1)
  assert.equal(p.verifyDeviceToken(token), undefined)
  assert.equal(p.deviceCount, 0)
})

check('a corrupt store does not crash startup', () => {
  const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-connect-corrupt-'))
  fs.writeFileSync(path.join(dir6, 'devices.json'), '{ this is not json')
  const p = new PairingService({ storeDir: dir6, ttlMinutes: 10, log: silent })
  assert.equal(p.deviceCount, 0)
  // And it must still be usable.
  assert.equal(p.redeem(p.issueCode(), 'x').ok, true)
})

check('timing-safe compare does not throw on odd input', () => {
  const p = new PairingService({ storeDir: dir, ttlMinutes: 10, log: silent })
  p.issueCode()
  // A length mismatch must return false, not throw.
  assert.equal(p.redeem('1', 'x').ok, false)
  assert.equal(p.redeem(undefined, 'x').ok, false)
  assert.equal(p.redeem(null, 'x').ok, false)
})

// -------------------------------------------------- pairing the same phone twice

/**
 * A store no other check has touched.
 *
 * The checks above share one `dir`, which is fine for what they assert, but
 * every check below counts devices — and a shared store would carry their
 * devices in, making the count depend on how many checks ran first.
 */
function fresh() {
  return new PairingService({
    storeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-connect-dup-')),
    ttlMinutes: 10,
    log: silent,
  })
}

check('pairing the same device twice leaves one device, not two', () => {
  // The reported bug: connect twice from one phone and the panel showed two
  // identical paired devices. The second record held a token the phone had
  // already overwritten, so it was a row that could never be used or cleaned up.
  const p = fresh()
  const first = p.redeem(p.issueCode(), 'Pixel 8', 'install-abc')
  const second = p.redeem(p.issueCode(), 'Pixel 8', 'install-abc')
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(p.deviceCount, 1, 'a re-pair must replace, not append')
  assert.equal(p.listDevices().length, 1)
})

check('a re-pair invalidates the token the phone just abandoned', () => {
  const p = fresh()
  const first = p.redeem(p.issueCode(), 'Pixel 8', 'install-abc')
  const second = p.redeem(p.issueCode(), 'Pixel 8', 'install-abc')
  assert.equal(p.verifyDeviceToken(first.token), undefined, 'the superseded token must be refused')
  assert.ok(p.verifyDeviceToken(second.token), 'the current token must work')
})

check('a re-pair keeps the original pairedAt but refreshes lastSeenAt', () => {
  // The panel removes a device by its index in a list ordered by `pairedAt`.
  // Letting a re-pair bump that timestamp would reorder rows under a user who is
  // about to remove a different one, so the original moment is kept.
  const p = fresh()
  const first = p.redeem(p.issueCode(), 'Pixel 8', 'install-abc')
  const second = p.redeem(p.issueCode(), 'Pixel 8', 'install-abc')
  assert.equal(second.device.pairedAt, first.device.pairedAt)
  assert.ok(second.device.lastSeenAt >= first.device.lastSeenAt)
})

check('a re-pair can rename the device', () => {
  const p = fresh()
  p.redeem(p.issueCode(), 'Pixel 8', 'install-abc')
  p.redeem(p.issueCode(), '我的 Pixel', 'install-abc')
  assert.equal(p.listDevices()[0].name, '我的 Pixel')
})

check('two phones of the same model each keep their own row', () => {
  // Identity, not the name, is what decides a replacement. Two identical labels
  // must stay two devices as long as they identified themselves separately.
  const p = fresh()
  p.redeem(p.issueCode(), 'Pixel 8', 'install-a')
  p.redeem(p.issueCode(), 'Pixel 8', 'install-b')
  assert.equal(p.deviceCount, 2, 'same name is not the same device')
})

check('an unidentified client still appends, as before', () => {
  // Backwards compatibility: an app build from before this field existed sends
  // no identity, and the desktop must keep working with it rather than merging
  // rows it cannot tell apart.
  const p = fresh()
  const first = p.redeem(p.issueCode(), 'Pixel 8')
  const second = p.redeem(p.issueCode(), 'Pixel 8')
  assert.equal(p.deviceCount, 2)
  assert.ok(p.verifyDeviceToken(first.token), 'the earlier anonymous device stays valid')
  assert.ok(p.verifyDeviceToken(second.token))
})

check('an identified phone merges the anonymous leftovers of its own name', () => {
  // The upgrade path: the user already has duplicate rows on disk from the old
  // append-only behaviour. They carry no identity, so the first identified
  // pairing from that phone is the only chance to reconcile them.
  const p = fresh()
  p.redeem(p.issueCode(), 'Pixel 8')
  p.redeem(p.issueCode(), 'Pixel 8')
  assert.equal(p.deviceCount, 2, 'precondition: the old behaviour left two rows')

  const adopted = p.redeem(p.issueCode(), 'Pixel 8', 'install-abc')
  assert.equal(p.deviceCount, 1, 'the leftovers must be merged into the identified device')
  assert.ok(p.verifyDeviceToken(adopted.token))
})

check('a different phone\'s identified row is never merged by name', () => {
  // The bound on the name-based cleanup: it only ever touches records that
  // identified nothing. An identified row belongs to someone.
  const p = fresh()
  const other = p.redeem(p.issueCode(), 'Pixel 8', 'install-other')
  p.redeem(p.issueCode(), 'Pixel 8', 'install-mine')
  assert.equal(p.deviceCount, 2, 'an identified row must not be swept up by a name match')
  assert.ok(p.verifyDeviceToken(other.token), 'the other phone must still authenticate')
})

check('the identity is not exposed to the desktop GUI', () => {
  const p = fresh()
  p.redeem(p.issueCode(), 'Pixel 8', 'install-abc')
  const serialized = JSON.stringify(p.listDevices())
  assert.ok(!serialized.includes('install-abc'), 'the device list must not carry the identity')
})

check('a re-pair survives a restart without duplicating', () => {
  const dir7 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-connect-repair-'))
  const first = new PairingService({ storeDir: dir7, ttlMinutes: 10, log: silent })
  first.redeem(first.issueCode(), 'Pixel 8', 'install-abc')

  const second = new PairingService({ storeDir: dir7, ttlMinutes: 10, log: silent })
  const { token } = second.redeem(second.issueCode(), 'Pixel 8', 'install-abc')
  assert.equal(second.deviceCount, 1, 'the identity must survive persistence')
  assert.ok(second.verifyDeviceToken(token))
})

check('an absurd or non-string identity is treated as none', () => {
  // A hostile or buggy client must not be able to make two devices collide by
  // sending a giant identity, and a non-string must not throw.
  const p = fresh()
  for (const bogus of [undefined, null, 42, {}, 'x'.repeat(500), '   ']) {
    assert.equal(p.redeem(p.issueCode(), 'Pixel 8', bogus).ok, true)
  }
  assert.equal(p.deviceCount, 6, 'each unidentified pairing appends')
})

// ------------------------------------------------- the upgrade path, on disk

/** Write a store file by hand, the way a pre-identity release left it. */
function storeWith(devices) {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-connect-legacy-'))
  fs.writeFileSync(
    path.join(storeDir, 'devices.json'),
    JSON.stringify({ version: 1, devices }, null, 2),
    'utf8',
  )
  return storeDir
}

check('starting up merges the duplicate rows already on disk', () => {
  // The user's actual situation: the duplicates exist *before* the update, and
  // the list must be clean the first time the plugin starts afterwards — not
  // only after each phone happens to pair again. Records from before the field
  // existed carry no identity, so startup is where they can be reconciled.
  const storeDir = storeWith([
    { hash: 'a'.repeat(64), name: 'Pixel 8', pairedAt: 1000, lastSeenAt: 1000 },
    { hash: 'b'.repeat(64), name: 'Pixel 8', pairedAt: 2000, lastSeenAt: 2000 },
  ])
  const p = new PairingService({ storeDir, ttlMinutes: 10, log: silent })
  assert.equal(p.deviceCount, 1, 'the duplicate rows must be merged at startup')
  assert.equal(p.listDevices()[0].name, 'Pixel 8')
})

check('startup merging keeps the record from the latest pairing', () => {
  // Keeping the newest matters: the phone overwrites its stored token on every
  // pairing, so the *latest* pairing is the one whose token still works. Keeping
  // the wrong one would log the user out for nothing.
  const storeDir = storeWith([
    { hash: 'old'.padEnd(64, '0'), name: 'Pixel 8', pairedAt: 1000, lastSeenAt: 1000 },
    { hash: 'new'.padEnd(64, '0'), name: 'Pixel 8', pairedAt: 2000, lastSeenAt: 2000 },
  ])
  const p = new PairingService({ storeDir, ttlMinutes: 10, log: silent })
  const devices = p.listDevices()
  assert.equal(devices.length, 1)
  assert.equal(devices[0].pairedAt, 2000, 'the latest pairing must survive')
})

check('startup merging trusts pairedAt over a stale lastSeenAt', () => {
  // `lastSeenAt` cannot decide this on its own: the abandoned record was the one
  // still being *used* right up until the re-pair, so it often looks newer. The
  // pairing order is what identifies the live token.
  const storeDir = storeWith([
    { hash: 'old'.padEnd(64, '0'), name: 'Pixel 8', pairedAt: 1000, lastSeenAt: 9000 },
    { hash: 'new'.padEnd(64, '0'), name: 'Pixel 8', pairedAt: 2000, lastSeenAt: 2000 },
  ])
  const p = new PairingService({ storeDir, ttlMinutes: 10, log: silent })
  assert.equal(
    p.listDevices()[0].pairedAt,
    2000,
    'the later pairing is the live one even though the older row was seen more recently',
  )
})

check('startup merging leaves different names alone', () => {
  const storeDir = storeWith([
    { hash: 'a'.repeat(64), name: 'Pixel 8', pairedAt: 1000, lastSeenAt: 1000 },
    { hash: 'b'.repeat(64), name: '我的 iPhone', pairedAt: 2000, lastSeenAt: 2000 },
  ])
  const p = new PairingService({ storeDir, ttlMinutes: 10, log: silent })
  assert.equal(p.deviceCount, 2, 'unrelated devices must not be merged')
})

check('startup merging never touches a record that identified itself', () => {
  // The bound that keeps this from deleting a working device: an identified
  // record is a known phone, not a leftover. Two phones of the same model that
  // both paired after the update must both survive a restart.
  const storeDir = storeWith([
    { hash: 'a'.repeat(64), name: 'Pixel 8', pairedAt: 1000, lastSeenAt: 1000, deviceId: 'install-a' },
    { hash: 'b'.repeat(64), name: 'Pixel 8', pairedAt: 2000, lastSeenAt: 2000, deviceId: 'install-b' },
  ])
  const p = new PairingService({ storeDir, ttlMinutes: 10, log: silent })
  assert.equal(p.deviceCount, 2, 'identified devices must survive startup untouched')
})

check('startup merging is idempotent and persists its result', () => {
  const storeDir = storeWith([
    { hash: 'a'.repeat(64), name: 'Pixel 8', pairedAt: 1000, lastSeenAt: 1000 },
    { hash: 'b'.repeat(64), name: 'Pixel 8', pairedAt: 2000, lastSeenAt: 2000 },
  ])
  const first = new PairingService({ storeDir, ttlMinutes: 10, log: silent })
  assert.equal(first.deviceCount, 1)

  // A second start must find the merged store, not the original duplicates.
  const second = new PairingService({ storeDir, ttlMinutes: 10, log: silent })
  assert.equal(second.deviceCount, 1, 'the merge must have been written to disk')
  const onDisk = JSON.parse(fs.readFileSync(path.join(storeDir, 'devices.json'), 'utf8'))
  assert.equal(onDisk.devices.length, 1)
})

check('a store with no duplicates is left exactly as it was', () => {
  // The merge must not rewrite (and so must not risk) a store that is already
  // correct — including one holding a single anonymous device.
  const storeDir = storeWith([
    { hash: 'a'.repeat(64), name: 'Pixel 8', pairedAt: 1000, lastSeenAt: 1000 },
  ])
  const before = fs.readFileSync(path.join(storeDir, 'devices.json'), 'utf8')
  new PairingService({ storeDir, ttlMinutes: 10, log: silent })
  assert.equal(
    fs.readFileSync(path.join(storeDir, 'devices.json'), 'utf8'),
    before,
    'an untouched store must not be rewritten',
  )
})

await Promise.all(pending)

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
const failed = results.filter((r) => !r.ok)
if (failed.length > 0) {
  console.log('failures:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
}
process.exit(failed.length > 0 ? 1 : 0)
