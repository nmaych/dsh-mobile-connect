/**
 * End-to-end test for the LAN gateway.
 *
 * Boots a fake "Harness" on loopback that reproduces the two fences the real one
 * applies (Host must be loopback, and a signed cookie must be presented), then
 * drives the gateway exactly as a phone would:
 *
 *   1. unauthenticated request is refused
 *   2. a wrong pairing code is refused
 *   3. the right code yields a device token
 *   4. the token unlocks proxied HTTP, with Host rewritten and the cookie added
 *   5. the token unlocks a WebSocket upgrade
 *   6. the cookie never leaks back to the phone
 *   7. revocation takes effect
 *
 * Run: node test/gateway.test.mjs
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PairingService } from '../lib/pairing.js'
import { LanGateway } from '../lib/gateway.js'

const results = []
// Cases are queued, not started: they share state (pair -> use token -> revoke)
// so they must run strictly in order.
const queue = []
function check(name, fn) {
  queue.push({ name, fn })
}

/** Run every queued case in order and report. */
async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn()
      results.push({ name, ok: true })
      console.log(`PASS  ${name}`)
    } catch (error) {
      results.push({ name, ok: false, detail: error.message })
      console.log(`FAIL  ${name}\n      ${error.message}`)
    }
  }
}

const silent = { info() {}, warn() {}, error() {} }

// --------------------------------------------------------------- fake Harness

const SESSION_COOKIE = `dsh-auth-${crypto.randomBytes(16).toString('hex')}=signed-value`
const PROCESS_TOKEN = crypto.randomBytes(24).toString('hex')
let lastUpstreamRequest = null

/** Mirrors the real server's Host fence plus cookie authentication. */
const fakeHarness = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')

  // The token exchange mints the cookie and redirects, exactly like dsh web.
  if (url.pathname === '/' && url.searchParams.get('token') === PROCESS_TOKEN) {
    res.writeHead(303, {
      location: './',
      'set-cookie': `${SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Strict`,
    })
    res.end()
    return
  }

  const host = req.headers.host ?? ''
  const isLoopback = /^127\.0\.0\.1(:\d+)?$/.test(host)

  if (url.pathname.startsWith('/api/')) {
    if (!isLoopback) {
      res.writeHead(403)
      res.end('forbidden: host fence')
      return
    }
    if (!(req.headers.cookie ?? '').includes(SESSION_COOKIE.split('=')[0])) {
      res.writeHead(401)
      res.end('unauthorized')
      return
    }
    lastUpstreamRequest = {
      host,
      cookie: req.headers.cookie ?? '',
      url: req.url,
      // Recorded so a test can prove the hop does not forward `Expect`.
      expect: req.headers.expect ?? null,
    }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'upstream=secret' })
    res.end(JSON.stringify({ ok: true, sawHost: host, path: url.pathname }))
    return
  }

  res.writeHead(404)
  res.end('not found')
})

// A WebSocket-ish upgrade endpoint, so the tunnel can be exercised.
const fakeUpgraded = new Set()
fakeHarness.on('upgrade', (req, socket) => {
  const isLoopback = /^127\.0\.0\.1(:\d+)?$/.test(req.headers.host ?? '')
  const authed = (req.headers.cookie ?? '').includes(SESSION_COOKIE.split('=')[0])
  if (!isLoopback || !authed) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  // Track it: an upgraded socket is not covered by closeAllConnections(), so
  // without this the test process would never exit.
  fakeUpgraded.add(socket)
  socket.on('close', () => fakeUpgraded.delete(socket))
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n',
  )
  // Echo one frame back so the test can prove the pipe is live.
  socket.write('hello-from-harness')
})

const harnessPort = await new Promise((resolve) => {
  fakeHarness.listen(0, '127.0.0.1', () => resolve(fakeHarness.address().port))
})

// ------------------------------------------------------------------ the setup

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-connect-gw-'))
const pairing = new PairingService({ storeDir, ttlMinutes: 10, log: silent })
const gateway = new LanGateway({
  pairing,
  localPort: harnessPort,
  localHost: '127.0.0.1',
  config: { name: 'Test Harness', pluginVersion: '1.0.0' },
  log: silent,
})
const gatewayPort = await gateway.listen()
assert.ok(gatewayPort, 'the gateway should bind')

// Capture a session the way the plugin does at startup.
const captured = await gateway.captureSession(
  `http://127.0.0.1:${harnessPort}/?token=${PROCESS_TOKEN}`,
)
assert.equal(captured, true, 'the gateway should capture a session from the local Harness')

const base = `http://127.0.0.1:${gatewayPort}`

/** Issue a request the way a phone would. */
async function phone(pathname, { token, init } = {}) {
  const url = token === undefined ? `${base}${pathname}` : `${base}${pathname}${pathname.includes('?') ? '&' : '?'}t=${token}`
  return fetch(url, init)
}

// ------------------------------------------------------------------- the tests

check('the info endpoint answers without pairing', async () => {
  const res = await fetch(`${base}/.dsh-mobile-connect/info`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.service, 'dsh-mobile-connect')
  assert.equal(body.deviceCount, 0)
})

check('an unpaired request to the Harness is refused', async () => {
  const res = await phone('/api/session/list', { init: { method: 'POST' } })
  assert.equal(res.status, 401, `expected 401, got ${res.status}`)
})

check('a request with a bogus token is refused', async () => {
  const res = await phone('/api/session/list', {
    token: 'f'.repeat(64),
    init: { method: 'POST' },
  })
  assert.equal(res.status, 401)
})

check('a wrong pairing code is refused', async () => {
  const code = pairing.issueCode()
  const wrong = code === '000000' ? '111111' : '000000'
  const res = await fetch(`${base}/.dsh-mobile-connect/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: wrong, name: '攻击者' }),
  })
  assert.equal(res.status, 401, `expected 401, got ${res.status}`)
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.equal(body.reason, 'mismatch')
  assert.ok(body.message.includes('不正确'), 'the message should say the code is wrong')
})

check('the right code yields a device token', async () => {
  const code = pairing.currentCode()
  const res = await fetch(`${base}/.dsh-mobile-connect/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: '测试手机' }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.match(body.token, /^[0-9a-f]{64}$/)
  globalThis.__token = body.token
})

check('the token unlocks the Harness through the gateway', async () => {
  const res = await phone('/api/session/list', {
    token: globalThis.__token,
    init: { method: 'POST' },
  })
  assert.equal(res.status, 200, `expected 200, got ${res.status}`)
  const body = await res.json()
  assert.equal(body.ok, true)
})

check('pairing the same phone twice over HTTP adds only one device', async () => {
  // The reported symptom, end to end: connect twice from one phone and the
  // desktop's list showed the same device twice. The second pairing left behind
  // a record whose token the phone had already replaced.
  //
  // A dedicated instance, like the lockout case below: this check pairs devices,
  // and the shared fixture's device count is asserted later on.
  const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-connect-dup-'))
  const dupPairing = new PairingService({ storeDir: dupDir, ttlMinutes: 10, log: silent })
  const dupGateway = new LanGateway({
    pairing: dupPairing,
    localPort: harnessPort,
    localHost: '127.0.0.1',
    config: { name: 'Duplicate Test', pluginVersion: '1.0.0' },
    log: silent,
  })
  const dupPort = await dupGateway.listen()
  const dupBase = `http://127.0.0.1:${dupPort}`

  try {
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${dupBase}/.dsh-mobile-connect/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: dupPairing.currentCode(),
          name: 'Pixel 8',
          deviceId: 'install-abc',
        }),
      })
      assert.equal(res.status, 200, `pairing ${i + 1} should succeed`)
      await res.arrayBuffer()
    }

    const info = await (await fetch(`${dupBase}/.dsh-mobile-connect/info`)).json()
    assert.equal(info.deviceCount, 1, 'two pairings from one phone must leave one device')
    assert.equal(
      dupPairing.listDevices().filter((d) => d.name === 'Pixel 8').length,
      1,
      'the device list must not contain the same phone twice',
    )
  } finally {
    await dupGateway.close()
  }
})

check('the gateway rewrote Host to loopback', async () => {
  assert.ok(lastUpstreamRequest, 'the upstream should have been called')
  assert.match(
    lastUpstreamRequest.host,
    /^127\.0\.0\.1:\d+$/,
    `Host should be loopback, got ${lastUpstreamRequest.host}`,
  )
})

check('the gateway attached the captured session cookie', async () => {
  assert.ok(
    lastUpstreamRequest.cookie.includes(SESSION_COOKIE.split('=')[0]),
    'the upstream request should carry the browser session',
  )
})

check('the upstream cookie is not leaked back to the phone', async () => {
  const res = await phone('/api/session/list', {
    token: globalThis.__token,
    init: { method: 'POST' },
  })
  const setCookie = res.headers.getSetCookie?.() ?? []
  assert.equal(setCookie.length, 0, `the phone must not receive cookies, got ${JSON.stringify(setCookie)}`)
  await res.arrayBuffer()
})

check('an Expect: 100-continue request is proxied, not answered with 502', async () => {
  // Regression: `expect` used to be forwarded verbatim to the upstream hop.
  // Node's own HTTP client (`fetch`/undici) refuses that header outright with
  // UND_ERR_NOT_SUPPORTED, so the gateway answered 502 "无法连接到本机 DSH 服务"
  // for every client that sends it — .NET's HttpClient and `curl` both do.
  // The interim 100 is the *gateway's* to send, so the header must not travel.
  const observed = await new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: gatewayPort })
    let buffer = ''
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(buffer)
    }, 5000)
    sock.on('connect', () => {
      const body = JSON.stringify({ hello: 'expect' })
      sock.write(
        `POST /api/session/list?t=${globalThis.__token} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${gatewayPort}\r\n` +
          `content-type: application/json\r\n` +
          `content-length: ${Buffer.byteLength(body)}\r\n` +
          `expect: 100-continue\r\n\r\n`,
      )
      // Wait for the interim 100 before sending the body, exactly as a
      // conforming client does.
      setTimeout(() => sock.write(body), 200)
    })
    sock.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      if (buffer.includes('"ok":true') || /^HTTP\/1\.\d 5\d\d/.test(buffer)) {
        clearTimeout(timer)
        sock.destroy()
        resolve(buffer)
      }
    })
    sock.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })

  const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(observed)?.[1])
  // The interim 100 comes first; the final status is the last one in the stream.
  const allStatuses = [...observed.matchAll(/HTTP\/1\.\d (\d{3})/g)].map((m) => Number(m[1]))
  const final = allStatuses.at(-1)
  assert.ok(
    allStatuses.includes(100),
    `the gateway should answer the interim 100 itself, saw ${JSON.stringify(allStatuses)} (first=${status})`,
  )
  assert.equal(
    final,
    200,
    `expected a proxied 200, got ${final}; stream was ${JSON.stringify(observed.slice(0, 300))}`,
  )
  assert.equal(
    lastUpstreamRequest?.expect ?? null,
    null,
    'the Expect header must not be forwarded upstream',
  )
})

check('a WebSocket upgrade is tunnelled through', async () => {
  const token = globalThis.__token
  const received = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('upgrade timed out')), 5000)
    const done = (value) => {
      clearTimeout(timer)
      resolve(value)
    }
    const req = http.request({
      host: '127.0.0.1',
      port: gatewayPort,
      path: `/api/remote.mux?t=${token}`,
      headers: { connection: 'Upgrade', upgrade: 'websocket' },
    })
    req.on('upgrade', (res, socket, head) => {
      assert.equal(res.statusCode, 101, `expected 101, got ${res.statusCode}`)
      // The first payload can arrive in `head` (same TCP segment as the 101)
      // or as a later `data` event; accept either.
      if (head !== undefined && head.length > 0) {
        socket.destroy()
        return done(head.toString())
      }
      socket.once('data', (chunk) => {
        socket.destroy()
        done(chunk.toString())
      })
      socket.resume()
    })
    req.on('response', (res) => {
      res.resume()
      clearTimeout(timer)
      reject(new Error(`upgrade refused with ${res.statusCode}`))
    })
    req.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    req.end()
  })
  assert.equal(received, 'hello-from-harness')
})

check('an unpaired WebSocket upgrade is refused', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: gatewayPort,
      path: '/api/remote.mux',
      headers: { connection: 'Upgrade', upgrade: 'websocket' },
    })
    req.on('upgrade', () => resolve(101))
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
    setTimeout(() => reject(new Error('timed out')), 5000)
  })
  assert.equal(status, 401, `expected 401, got ${status}`)
})

check('revoking the device closes the door', async () => {
  assert.equal(pairing.revokeAll(), 1)
  const res = await phone('/api/session/list', {
    token: globalThis.__token,
    init: { method: 'POST' },
  })
  assert.equal(res.status, 401, 'a revoked token must stop working')
})

check('an oversized pairing body is refused and the socket is released', async () => {
  // Regression: readJsonBody used to `return` from inside its `for await` loop,
  // which destroys the readable and leaves the socket open forever. The client
  // here keeps writing past the limit, which is what exposes the leak — a
  // client that has already flushed the whole body does not.
  const limit = 4096
  const total = 200_000
  const observed = await new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: gatewayPort })
    const state = { status: undefined, released: false }
    sock.on('connect', () => {
      sock.write(
        `POST /.dsh-mobile-connect/pair HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${gatewayPort}\r\n` +
          `content-type: application/json\r\n` +
          `content-length: ${total}\r\n\r\n`,
      )
      let sent = 0
      const trickle = setInterval(() => {
        if (sent >= total) return clearInterval(trickle)
        sock.write('a'.repeat(limit))
        sent += limit
      }, 10)
      setTimeout(() => {
        clearInterval(trickle)
        sock.destroy()
        resolve(state)
      }, 1500)
    })
    sock.on('data', (chunk) => {
      const match = chunk.toString('latin1').match(/^HTTP\/1\.\d (\d{3})/)
      if (match !== null && state.status === undefined) state.status = Number(match[1])
    })
    sock.on('end', () => {
      state.released = true
    })
    sock.on('close', () => {
      state.released = true
    })
    sock.on('error', () => {
      state.released = true
    })
  })

  assert.equal(
    observed.status,
    413,
    `an oversized body must be refused from its declared length, got ${observed.status}`,
  )
  assert.equal(observed.released, true, 'the server must release the connection')
})

check('a protocol-relative or absolute request target cannot redirect the hop', async () => {
  // Regression: #targetUrl used to concatenate the raw request line onto the
  // loopback origin, so `//host/x` and `/\host/x` reached the upstream verbatim
  // and were re-interpreted there. The target must stay on the configured origin.
  const seen = []
  const probeUpstream = http.createServer((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  const probePort = await new Promise((resolve) =>
    probeUpstream.listen(0, '127.0.0.1', () => resolve(probeUpstream.address().port)),
  )
  const { LanGateway: Gateway } = await import('../lib/gateway.js')
  const probeGateway = new Gateway({
    pairing,
    localPort: probePort,
    localHost: '127.0.0.1',
    config: { name: 'Target probe', pluginVersion: '1.0.0' },
    log: silent,
  })
  const probeGatewayPort = await probeGateway.listen()
  const probeCode = pairing.issueCode()
  const paired = await fetch(`http://127.0.0.1:${probeGatewayPort}/.dsh-mobile-connect/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: probeCode, name: 'target-probe' }),
  })
  const probeToken = (await paired.json()).token

  try {
    for (const raw of ['//evil.example/x', '/\\evil.example/x']) {
      seen.length = 0
      await new Promise((resolve) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: probeGatewayPort,
            method: 'GET',
            path: `${raw}?t=${probeToken}`,
          },
          (res) => {
            res.resume()
            res.on('end', resolve)
          },
        )
        req.on('error', resolve)
        req.end()
      })
      const forwarded = seen[0] ?? ''
      assert.ok(
        !forwarded.startsWith('//') && !forwarded.includes('evil.example'),
        `${JSON.stringify(raw)} reached the upstream as ${JSON.stringify(forwarded)}`,
      )
    }
  } finally {
    await probeGateway.close()
    probeUpstream.closeAllConnections?.()
    await new Promise((resolve) => probeUpstream.close(resolve))
  }
})

check('a burst of wrong codes locks the code out', async () => {
  // A dedicated instance: this case is about the attempt budget, so it must not
  // inherit counter state from the cases above.
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-connect-lock-'))
  const lockPairing = new PairingService({ storeDir: lockDir, ttlMinutes: 10, log: silent })
  const lockGateway = new LanGateway({
    pairing: lockPairing,
    localPort: harnessPort,
    localHost: '127.0.0.1',
    config: { name: 'Lock Test', pluginVersion: '1.0.0' },
    log: silent,
  })
  const lockPort = await lockGateway.listen()
  const lockBase = `http://127.0.0.1:${lockPort}`

  try {
    const code = lockPairing.issueCode()
    const statuses = []
    const reasons = []
    for (let i = 0; i < 8; i += 1) {
      // Never send the real code by accident.
      const guess = String(i).padStart(6, '0') === code ? '999999' : String(i).padStart(6, '0')
      const res = await fetch(`${lockBase}/.dsh-mobile-connect/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: guess, name: '攻击者' }),
      })
      const body = await res.json()
      statuses.push(res.status)
      reasons.push(body.reason)
    }

    assert.equal(
      statuses.at(-1),
      429,
      `the last of 8 wrong guesses must be locked; sequence was ${JSON.stringify(statuses)} / ${JSON.stringify(reasons)}`,
    )
    assert.equal(reasons.at(-1), 'locked')

    // The legitimate user must now be refused too — that is what burning the
    // code means, and it is why the desktop issues a fresh one.
    const res = await fetch(`${lockBase}/.dsh-mobile-connect/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: '真正的机主' }),
    })
    assert.equal(res.status, 429, 'a burned code must stay dead')
    await res.arrayBuffer()
  } finally {
    await lockGateway.close()
  }
})

// ---------------------------------------------------------------------- done

await runAll()

// Teardown, then force exit: a leaked socket from a failed case must not turn
// a reported failure into a hang.
try {
  await gateway.close()
} catch {
  // Already closed.
}
try {
  await new Promise((resolve) => {
    for (const socket of fakeUpgraded) socket.destroy()
    fakeUpgraded.clear()
    fakeHarness.closeAllConnections?.()
    fakeHarness.close(() => resolve())
    const timer = setTimeout(resolve, 1000)
    timer.unref?.()
  })
} catch {
  // Already closed.
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
const failed = results.filter((r) => !r.ok)
if (failed.length > 0) {
  console.log('failures:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
}
process.exit(failed.length > 0 ? 1 : 0)
