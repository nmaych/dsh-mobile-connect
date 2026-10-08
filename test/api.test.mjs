/**
 * The desktop GUI's HTTP surface.
 *
 * Two things here are security-relevant and get dedicated coverage:
 *
 *   1. **the trust fence** — these routes sit under a prefix longer than the
 *      kernel's `/api`, so `webServer` dispatch reaches them *before* the
 *      connection service's admission check. A route that answers a
 *      non-loopback `Host` would be a DNS-rebinding hole in the app itself.
 *   2. **`peekCode` never reissues** — the panel polls `/status`. If a read
 *      rotated the code, the code on screen would expire before the user could
 *      type it, which is a bug the UI cannot recover from.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PairingService } from '../lib/pairing.js'
import { API_PREFIX, createApiRoutes } from '../lib/api.js'
import { rejectionFor, structuralRejection } from '../lib/trust.js'

const results = []
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

const silent = { info() {}, warn() {} }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmc-api-test-'))

/**
 * A pairing service with a live code and its own store.
 *
 * The store directory is fresh per call on purpose: `PairingService` loads
 * `devices.json` on construction, so a shared directory would leak devices
 * between checks and make the device-list assertions order-dependent.
 */
function makePairing(ttlMinutes = 10, storeDir = fs.mkdtempSync(path.join(root, 's-'))) {
  const pairing = new PairingService({ storeDir, ttlMinutes, log: silent })
  pairing.issueCode()
  return pairing
}

/**
 * A live server around one handler, so the tests exercise real HTTP — status
 * codes, headers, and body framing included — rather than a mocked response.
 */
async function withServer(handler, fn) {
  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    server.closeAllConnections?.()
  }
}

/** Build the runtime thunk bag the routes read from. */
function makeRuntime(overrides = {}) {
  return {
    pluginVersion: '1.0.0',
    port: () => 19387,
    addresses: () => ['192.168.1.5', '10.0.0.7'],
    primaryAddress: () => '192.168.1.5',
    listening: () => true,
    discovery: () => true,
    publish: () => {},
    ...overrides,
  }
}

function makeHandler(pairing, runtime, extra = {}) {
  return createApiRoutes({
    pairing,
    config: { name: 'DSH Harness', codeTtlMinutes: 10 },
    runtime,
    log: silent,
    ...extra,
  })
}

// ---------------------------------------------------------------- status route

check('GET /status reports the address, the live code and no devices', async () => {
  const pairing = makePairing()
  const code = pairing.peekCode()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const response = await fetch(`${base}${API_PREFIX}/status`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.baseUrl, 'http://192.168.1.5:19387')
    assert.equal(body.code, code)
    assert.equal(body.port, 19387)
    assert.equal(body.primaryAddress, '192.168.1.5')
    assert.deepEqual(body.addresses, ['192.168.1.5', '10.0.0.7'])
    assert.deepEqual(body.devices, [])
    assert.equal(body.locked, false)
    assert.equal(body.listening, true)
  })
})

check('GET /status is never cached', async () => {
  const pairing = makePairing()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const response = await fetch(`${base}${API_PREFIX}/status`)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  })
})

check('GET /status reports the expiry as an absolute timestamp', async () => {
  const pairing = makePairing(10)
  const before = Date.now()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const body = await (await fetch(`${base}${API_PREFIX}/status`)).json()
    assert.ok(Number.isFinite(body.codeExpiresAt), 'codeExpiresAt should be a number')
    // 10 minutes, within the slack of the round trip.
    const delta = body.codeExpiresAt - before
    assert.ok(delta > 9 * 60_000 && delta <= 10 * 60_000 + 5_000, `unexpected delta ${delta}`)
  })
})

check('the pairUrl the panel shows encodes the same code as the status', async () => {
  const pairing = makePairing()
  const code = pairing.peekCode()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const body = await (await fetch(`${base}${API_PREFIX}/status`)).json()
    assert.equal(
      body.pairUrl,
      `dshmobile://pair?host=192.168.1.5&port=19387&code=${code}`,
    )
  })
})

check('GET /status lists devices without leaking their token hashes', async () => {
  const pairing = makePairing()
  const redeemed = pairing.redeem(pairing.peekCode(), '我的手机')
  assert.equal(redeemed.ok, true)
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const body = await (await fetch(`${base}${API_PREFIX}/status`)).json()
    assert.equal(body.devices.length, 1)
    assert.equal(body.devices[0].name, '我的手机')
    assert.equal(body.devices[0].index, 0)
    const serialized = JSON.stringify(body)
    assert.ok(!serialized.includes(redeemed.token), 'the device token must never reach the browser')
    assert.ok(!serialized.includes(redeemed.device.hash), 'the token hash must never reach the browser')
  })
})

check('the panel shows one row after the same phone pairs twice', async () => {
  // The reported bug, at the surface the user actually looks at: pairing twice
  // from one phone made 「已配对设备」 list the same device twice.
  const pairing = makePairing()
  pairing.redeem(pairing.peekCode(), 'Pixel 8', 'install-abc')
  pairing.redeem(pairing.peekCode(), 'Pixel 8', 'install-abc')
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const body = await (await fetch(`${base}${API_PREFIX}/status`)).json()
    assert.equal(body.devices.length, 1, `expected one row, got ${JSON.stringify(body.devices)}`)
    assert.equal(body.devices[0].name, 'Pixel 8')
    // The indices the panel posts back to /forget must address that one row.
    assert.equal(body.devices[0].index, 0)
  })
})

check('GET /status tolerates a machine with no LAN address', async () => {  const pairing = makePairing()
  const runtime = makeRuntime({ addresses: () => [], primaryAddress: () => null })
  await withServer(makeHandler(pairing, runtime), async (base) => {
    const body = await (await fetch(`${base}${API_PREFIX}/status`)).json()
    assert.equal(body.primaryAddress, null)
    assert.equal(body.baseUrl, null)
    assert.equal(body.pairUrl, null)
  })
})

check('GET /status reports no URL at all while the gateway is unbound', async () => {
  // Regression: `runtime.port()` answers `null` before `listen()` succeeds, and
  // a `port === undefined` guard let that through to string interpolation — the
  // panel rendered `http://192.168.1.5:null`, an address that looks real, copies
  // like a real address, and cannot work. Every unusable port must read as null.
  for (const unbound of [null, undefined, 0, -1, 65536, Number.NaN, '19387']) {
    const pairing = makePairing()
    const runtime = makeRuntime({ port: () => unbound, listening: () => false })
    await withServer(makeHandler(pairing, runtime), async (base) => {
      const body = await (await fetch(`${base}${API_PREFIX}/status`)).json()
      assert.equal(body.baseUrl, null, `baseUrl leaked for port ${String(unbound)}`)
      assert.equal(body.pairUrl, null, `pairUrl leaked for port ${String(unbound)}`)
      assert.equal(body.port, null, `port leaked for ${String(unbound)}`)
      // Scan string values only: a real `null` is *supposed* to serialize as
      // `:null`, so the bug shows up as the substring sitting inside a URL.
      const strings = []
      const collect = (value) => {
        if (typeof value === 'string') strings.push(value)
        else if (Array.isArray(value)) value.forEach(collect)
        else if (value && typeof value === 'object') Object.values(value).forEach(collect)
      }
      collect(body)
      assert.ok(
        !strings.some((value) => value.includes(':null')),
        `a URL contained a literal ":null" for port ${String(unbound)}`,
      )
    })
  }
})

check('GET /qr.svg refuses to encode an unbound port', async () => {
  const pairing = makePairing()
  const runtime = makeRuntime({ port: () => null, listening: () => false })
  await withServer(makeHandler(pairing, runtime), async (base) => {
    const response = await fetch(`${base}${API_PREFIX}/qr.svg`)
    assert.equal(response.status, 409)
    assert.ok(!(await response.text()).includes('svg'))
  })
})

// ------------------------------------------------------------- polling safety

check('polling /status never rotates the code', async () => {
  const pairing = makePairing()
  const code = pairing.peekCode()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    for (let i = 0; i < 5; i += 1) {
      const body = await (await fetch(`${base}${API_PREFIX}/status`)).json()
      assert.equal(body.code, code, `poll ${i} changed the code`)
    }
    assert.equal(pairing.peekCode(), code)
  })
})

check('an expired code reports null instead of minting a replacement', async () => {
  // 0.02 minutes = 1.2s, so the code lapses between the two reads.
  const pairing = new PairingService({ storeDir: fs.mkdtempSync(path.join(root, 's-')), ttlMinutes: 0.02, log: silent })
  pairing.issueCode()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const first = await (await fetch(`${base}${API_PREFIX}/status`)).json()
    assert.ok(first.code !== null, 'the code should be live immediately')
    await new Promise((resolve) => setTimeout(resolve, 1400))
    const second = await (await fetch(`${base}${API_PREFIX}/status`)).json()
    assert.equal(second.code, null, 'an expired code must read as null')
    assert.equal(second.codeExpiresAt, null)
  })
})

check('a locked code is reported as locked', async () => {
  const pairing = makePairing()
  for (let i = 0; i < 8; i += 1) pairing.redeem('000000', 'attacker')
  assert.equal(pairing.isLocked, true)
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const body = await (await fetch(`${base}${API_PREFIX}/status`)).json()
    assert.equal(body.locked, true)
    assert.equal(body.code, null)
  })
})

// ------------------------------------------------------------------- qr route

check('GET /qr.svg renders an SVG for the live code', async () => {
  const pairing = makePairing()
  const code = pairing.peekCode()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const response = await fetch(`${base}${API_PREFIX}/qr.svg`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /image\/svg\+xml/)
    assert.equal(response.headers.get('x-dsh-mobile-connect-code'), code)
    const svg = await response.text()
    assert.match(svg, /^<\?xml/)
    assert.match(svg, /<svg /)
    // The deep link is carried in the symbol's description, so the SVG itself
    // proves which payload was encoded.
    assert.ok(svg.includes(`code=${code}`), 'the SVG should describe the live pair URL')
  })
})

check('GET /qr.svg refuses when there is no live code', async () => {
  const pairing = new PairingService({ storeDir: fs.mkdtempSync(path.join(root, 's-')), ttlMinutes: 0.01, log: silent })
  pairing.issueCode()
  await new Promise((resolve) => setTimeout(resolve, 900))
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const response = await fetch(`${base}${API_PREFIX}/qr.svg`)
    assert.equal(response.status, 409)
  })
})

check('GET /qr.svg clamps an absurd scale instead of emitting a huge file', async () => {
  const pairing = makePairing()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const small = await (await fetch(`${base}${API_PREFIX}/qr.svg?scale=1`)).text()
    const huge = await (await fetch(`${base}${API_PREFIX}/qr.svg?scale=100000`)).text()
    assert.ok(huge.length < 20_000, `an unbounded scale produced ${huge.length} bytes`)
    assert.ok(huge.length > small.length, 'a larger scale should still be larger')
  })
})

check('a rotated code yields a different SVG', async () => {
  const pairing = makePairing()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const first = await (await fetch(`${base}${API_PREFIX}/qr.svg`)).text()
    pairing.issueCode()
    const second = await (await fetch(`${base}${API_PREFIX}/qr.svg`)).text()
    assert.notEqual(first, second, 'the QR must follow the current code')
  })
})

check('the QR quiet zone stays at the ISO minimum', async () => {
  const pairing = makePairing()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const svg = await (await fetch(`${base}${API_PREFIX}/qr.svg?scale=4`)).text()
    // 4 modules of quiet zone at scale 4 = 16px of margin on each side. A
    // regression to `toSvg`'s old default of 2 would show up as 8px.
    const viewBox = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg)
    assert.ok(viewBox, 'the SVG should declare a viewBox')
    const side = Number(viewBox[1])
    // (modules + 2 * quietZone) * scale, so the symbol itself is side - 32.
    assert.equal(side % 4, 0)
    assert.ok(side >= (21 + 8) * 4, `side ${side} is too small for a 21-module symbol plus a 4-module quiet zone`)
  })
})

// ------------------------------------------------------------------- actions

check('POST /code issues a fresh code and returns the new status', async () => {
  const pairing = makePairing()
  const before = pairing.peekCode()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const response = await fetch(`${base}${API_PREFIX}/code`, { method: 'POST' })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.match(body.code, /^[0-9]{6}$/)
    assert.notEqual(body.code, before)
    assert.equal(pairing.peekCode(), body.code)
    assert.equal(body.baseUrl, 'http://192.168.1.5:19387')
  })
})

check('POST /code clears a lockout', async () => {
  const pairing = makePairing()
  for (let i = 0; i < 8; i += 1) pairing.redeem('000000', 'attacker')
  assert.equal(pairing.isLocked, true)
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const body = await (await fetch(`${base}${API_PREFIX}/code`, { method: 'POST' })).json()
    assert.equal(body.locked, false)
    assert.match(body.code, /^[0-9]{6}$/)
  })
})

check('POST /forget removes one device by index', async () => {
  const pairing = makePairing()
  pairing.redeem(pairing.peekCode(), 'first')
  pairing.redeem(pairing.peekCode(), 'second')
  // Newest first: index 0 is 'second'.
  assert.equal(pairing.listDevices()[0].name, 'second')
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const response = await fetch(`${base}${API_PREFIX}/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ index: 0 }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.devices.length, 1)
    assert.equal(body.devices[0].name, 'first')
  })
})

check('POST /forget rejects a missing or negative index', async () => {
  const pairing = makePairing()
  pairing.redeem(pairing.peekCode(), 'first')
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    for (const payload of [{}, { index: -1 }, { index: 'x' }, { index: 1.5 }]) {
      const response = await fetch(`${base}${API_PREFIX}/forget`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      assert.equal(response.status, 400, `payload ${JSON.stringify(payload)} should be refused`)
    }
    // A malformed body is refused too, and the device list is untouched.
    const bad = await fetch(`${base}${API_PREFIX}/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(bad.status, 400)
    assert.equal(pairing.deviceCount, 1)
  })
})

check('POST /forget on an out-of-range index is a 404, not a silent success', async () => {
  const pairing = makePairing()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const response = await fetch(`${base}${API_PREFIX}/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ index: 7 }),
    })
    assert.equal(response.status, 404)
  })
})

check('POST /forget-all empties the list and reports how many went', async () => {
  const pairing = makePairing()
  pairing.redeem(pairing.peekCode(), 'a')
  pairing.redeem(pairing.peekCode(), 'b')
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const body = await (await fetch(`${base}${API_PREFIX}/forget-all`, { method: 'POST' })).json()
    assert.equal(body.ok, true)
    assert.equal(body.removed, 2)
    assert.deepEqual(body.devices, [])
    assert.equal(pairing.deviceCount, 0)
  })
})

check('mutations republish status.json so the file cannot lag the GUI', async () => {
  let published = 0
  const pairing = makePairing()
  const runtime = makeRuntime({ publish: () => { published += 1 } })
  await withServer(makeHandler(pairing, runtime), async (base) => {
    await fetch(`${base}${API_PREFIX}/code`, { method: 'POST' })
    assert.equal(published, 1, 'POST /code should republish')
    await fetch(`${base}${API_PREFIX}/forget-all`, { method: 'POST' })
    assert.equal(published, 2, 'POST /forget-all should republish')
    // A read is not a mutation and must not write the file.
    await fetch(`${base}${API_PREFIX}/status`)
    assert.equal(published, 2, 'GET /status must not republish')
  })
})

// ------------------------------------------------------------------ routing

check('an unknown route under the prefix is a JSON 404', async () => {
  const pairing = makePairing()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    const response = await fetch(`${base}${API_PREFIX}/nope`)
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type'), /application\/json/)
  })
})

check('the wrong method on a known route is a 404, not a mutation', async () => {
  const pairing = makePairing()
  const code = pairing.peekCode()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    // A GET must not be able to rotate the code.
    assert.equal((await fetch(`${base}${API_PREFIX}/code`)).status, 404)
    assert.equal(pairing.peekCode(), code)
    // A POST must not be able to read the status as if it were a mutation.
    assert.equal((await fetch(`${base}${API_PREFIX}/status`, { method: 'POST' })).status, 404)
  })
})

check('a trailing slash is tolerated', async () => {
  const pairing = makePairing()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    assert.equal((await fetch(`${base}${API_PREFIX}/status/`)).status, 200)
  })
})

// -------------------------------------------------------------- the trust fence

check('the structural fence admits a loopback Host', () => {
  assert.equal(structuralRejection({ headers: { host: '127.0.0.1:19387' } }), undefined)
  assert.equal(structuralRejection({ headers: { host: 'localhost:19387' } }), undefined)
})

check('the structural fence refuses a non-loopback Host (DNS rebinding)', () => {
  // The attack: a hostile name resolves to 127.0.0.1, so the request reaches
  // the server while its Host header still names the attacker.
  assert.equal(structuralRejection({ headers: { host: 'evil.example' } }), 403)
  assert.equal(structuralRejection({ headers: { host: '192.168.1.5:19387' } }), 403)
  assert.equal(structuralRejection({ headers: {} }), 403)
})

check('the structural fence refuses a cross-site fetch', () => {
  assert.equal(
    structuralRejection({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } }),
    403,
  )
})

check('the structural fence refuses a mismatched Origin', () => {
  assert.equal(
    structuralRejection({ headers: { host: '127.0.0.1:19387', origin: 'http://evil.example' } }),
    403,
  )
  // A same-authority Origin is fine.
  assert.equal(
    structuralRejection({ headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' } }),
    undefined,
  )
})

check('a hostile Host cannot read the pairing code over HTTP', async () => {
  const pairing = makePairing()
  await withServer(makeHandler(pairing, makeRuntime()), async (base) => {
    // `fetch` will not let us forge Host, so the fence is exercised directly and
    // then confirmed to be wired into the route.
    const hostile = { headers: { host: 'evil.example' }, method: 'GET', url: `${API_PREFIX}/status` }
    assert.equal(rejectionFor(hostile, undefined), 403)
    assert.equal(rejectionFor(hostile, { admit: () => ({ rejection: 403 }) }), 403)
    // And the real route answers a normal loopback caller.
    assert.equal((await fetch(`${base}${API_PREFIX}/status`)).status, 200)
  })
})

check('the connection service, when present, decides', () => {
  const req = { headers: { host: '127.0.0.1:19387' } }
  // A connection service that admits wins over the structural fence.
  assert.equal(rejectionFor(req, { admit: () => undefined }), undefined)
  // One that refuses is honoured even though the structural fence would pass.
  assert.equal(rejectionFor(req, { admit: () => ({ rejection: 401 }) }), 401)
  // One that throws falls back to the structural fence rather than 500-ing.
  assert.equal(
    rejectionFor({ headers: { host: 'evil.example' } }, {
      admit: () => {
        throw new Error('boom')
      },
    }),
    403,
  )
})

check('the routes enforce the fence themselves', async () => {
  const pairing = makePairing()
  // A connection service that rejects everything stands in for "the app would
  // refuse this caller"; every route must then refuse it too.
  const handler = makeHandler(pairing, makeRuntime(), { connection: { admit: () => ({ rejection: 401 }) } })
  await withServer(handler, async (base) => {
    for (const [method, suffix] of [
      ['GET', '/status'],
      ['GET', '/qr.svg'],
      ['POST', '/code'],
      ['POST', '/forget-all'],
    ]) {
      const response = await fetch(`${base}${API_PREFIX}${suffix}`, { method })
      assert.equal(response.status, 401, `${method} ${suffix} should have been refused`)
    }
  })
})

// -------------------------------------------------------------------- report

await Promise.all(pending)
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length > 0 ? 1 : 0)
