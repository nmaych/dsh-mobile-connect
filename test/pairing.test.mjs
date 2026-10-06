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

await Promise.all(pending)

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
const failed = results.filter((r) => !r.ok)
if (failed.length > 0) {
  console.log('failures:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
}
process.exit(failed.length > 0 ? 1 : 0)
