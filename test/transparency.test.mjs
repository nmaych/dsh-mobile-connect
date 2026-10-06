/**
 * Prove the gateway is transparent.
 *
 * The interesting question is not "does a model turn work" (that depends on
 * which providers the profile has configured) but "does the gateway change
 * anything". This runs the *same* calls twice — once straight at the Harness on
 * loopback with its own process token, once through the gateway with a device
 * token — and compares the results.
 *
 * Any difference in the RPC payloads means the gateway is not transparent.
 *
 * usage: node test/transparency.test.mjs <harnessPort> <gatewayBase> <processToken> [code]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'

const harnessPort = Number(process.argv[2] ?? 19566)
const gatewayBase = (process.argv[3] ?? 'http://127.0.0.1:19399').replace(/\/$/, '')
const processToken = process.argv[4]
const codeArg = process.argv[5]

const results = []
const queue = []
function check(name, fn) {
  queue.push({ name, fn })
}
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

// ------------------------------------------------------- direct (loopback)

let directCookie = ''

/** Pair directly with the Harness, as a local browser would. */
async function openDirectSession() {
  const res = await fetch(`http://127.0.0.1:${harnessPort}/?token=${processToken}`, {
    redirect: 'manual',
  })
  await res.arrayBuffer()
  const cookies = res.headers.getSetCookie?.() ?? []
  directCookie = cookies.map((c) => c.split(';', 1)[0]).join('; ')
  if (directCookie === '') throw new Error('could not obtain a direct session cookie')
}

/** One RPC straight at the Harness. */
async function directRpc(namespace, method, args) {
  const rpcId = crypto.randomUUID()
  const res = await fetch(`http://127.0.0.1:${harnessPort}/api/${namespace}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: directCookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: `${namespace}/${method}`,
      payload: { args },
    }),
  })
  const text = await res.text()
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  const body = JSON.parse(text)
  if (body.result?.ok === true) return body.result.value
  throw new Error(`${body.result?.error?.code}: ${body.result?.error?.message}`)
}

// --------------------------------------------------------- through the gateway

let deviceToken = ''

function discoverCode() {
  if (codeArg) return codeArg
  if (process.env.DSH_CONNECT_CODE) return process.env.DSH_CONNECT_CODE
  const home = process.env.DSH_HOME ?? 'E:/deepseekworkspace/dsh-mobile-connect/test/dshhome'
  const parsed = JSON.parse(fs.readFileSync(`${home}/status.json`, 'utf8'))
  if (typeof parsed.code !== 'string') throw new Error('no live code in status.json')
  return parsed.code
}

async function pairThroughGateway() {
  const res = await fetch(`${gatewayBase}/.dsh-mobile-connect/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: discoverCode(), name: '透明性测试' }),
  })
  const body = await res.json()
  if (!body.ok) throw new Error(`${body.reason}: ${body.message}`)
  deviceToken = body.token
}

/** One RPC through the gateway, as the phone does it. */
async function gatewayRpc(namespace, method, args) {
  const rpcId = crypto.randomUUID()
  const res = await fetch(`${gatewayBase}/api/${namespace}/${method}?t=${deviceToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: `${namespace}/${method}`,
      payload: { args },
    }),
  })
  const text = await res.text()
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  const body = JSON.parse(text)
  if (body.result?.ok === true) return body.result.value
  throw new Error(`${body.result?.error?.code}: ${body.result?.error?.message}`)
}

/** Strip fields that legitimately differ between two calls. */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      // Volatile bookkeeping, not a transparency signal.
      if (k === 'updatedAt' || k === 'asOfSeq' || k === 'lastSeenAt' || k === 'startedAt') continue
      out[k] = normalize(v)
    }
    return out
  }
  return value
}

/**
 * A minimal WebSocket client for the direct route.
 *
 * Node's global `WebSocket` cannot attach a `Cookie` header, and the direct
 * route needs one. Only text frames are handled, which is all the mux uses.
 */
function rawWebSocket(url, headers, onText, onOpen, onError) {
  const target = new URL(url)
  const key = crypto.randomBytes(16).toString('base64')
  const req = http.request({
    host: target.hostname,
    port: target.port,
    path: target.pathname + target.search,
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': key,
      'sec-websocket-version': '13',
      ...headers,
    },
  })

  req.on('upgrade', (_res, socket, head) => {
    let buffer = Buffer.concat([head ?? Buffer.alloc(0)])
    const send = (text) => {
      const payload = Buffer.from(text, 'utf8')
      // Client frames must be masked.
      const mask = crypto.randomBytes(4)
      const masked = Buffer.alloc(payload.length)
      for (let i = 0; i < payload.length; i += 1) mask[i & 3] ^= 0
      for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3]
      let header
      if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length])
      } else {
        header = Buffer.alloc(4)
        header[0] = 0x81
        header[1] = 0x80 | 126
        header.writeUInt16BE(payload.length, 2)
      }
      socket.write(Buffer.concat([header, mask, masked]))
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      // Parse as many complete frames as the buffer holds.
      for (;;) {
        if (buffer.length < 2) return
        const opcode = buffer[0] & 0x0f
        let length = buffer[1] & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        if (buffer.length < offset + length) return
        const payload = buffer.subarray(offset, offset + length)
        buffer = buffer.subarray(offset + length)
        if (opcode === 0x1) onText(payload.toString('utf8'))
        else if (opcode === 0x8) {
          socket.destroy()
          return
        }
      }
    })

    socket.on('error', (error) => onError?.(error))
    onOpen(send, socket)
  })

  req.on('response', (res) => onError?.(new Error(`upgrade refused: HTTP ${res.statusCode}`)))
  req.on('error', (error) => onError?.(error))
  req.end()
}

// ------------------------------------------------------------------- the tests

check('both routes can authenticate', async () => {
  await openDirectSession()
  await pairThroughGateway()
})

check('session/list returns the same shape both ways', async () => {
  const direct = await directRpc('session', 'list', { _request: {} })
  const proxied = await gatewayRpc('session', 'list', { _request: {} })

  const d = (direct.items ?? []).map((i) => i.sessionId).sort()
  const g = (proxied.items ?? []).map((i) => i.sessionId).sort()
  if (JSON.stringify(d) !== JSON.stringify(g)) {
    throw new Error(`session ids differ:\n  direct:  ${JSON.stringify(d)}\n  gateway: ${JSON.stringify(g)}`)
  }
  console.log(`      both routes see ${d.length} session(s)`)

  // Compare one full item field by field.
  if (direct.items?.[0] && proxied.items?.[0]) {
    const a = JSON.stringify(normalize(direct.items[0]))
    const b = JSON.stringify(normalize(proxied.items[0]))
    if (a !== b) {
      throw new Error(`first item differs:\n  direct:  ${a.slice(0, 300)}\n  gateway: ${b.slice(0, 300)}`)
    }
  }
})

check('session/modelCatalog is byte-identical both ways', async () => {
  const direct = await directRpc('session', 'modelCatalog', {})
  const proxied = await gatewayRpc('session', 'modelCatalog', {})
  const a = JSON.stringify(normalize(direct))
  const b = JSON.stringify(normalize(proxied))
  if (a !== b) {
    throw new Error(`catalog differs:\n  direct:  ${a.slice(0, 400)}\n  gateway: ${b.slice(0, 400)}`)
  }
  console.log(`      ${(direct.groups ?? []).length} provider group(s), identical`)
})

check('a failing turn fails identically both ways', async () => {
  // This profile has no API key for its provider, so a turn errors. The point
  // is that it errors the *same* way through both routes: if the gateway
  // mangled requests or responses, the failure would differ.
  async function runTurn(rpc, label) {
    const { sessionId } = await rpc('session', 'create', { request: {} })
    const catalog = await rpc('session', 'modelCatalog', {})
    const group = (catalog.groups ?? [])[0]
    if (group === undefined) throw new Error('no provider available')
    const model = group.models[0]
    await rpc('session', 'selectModel', {
      request: {
        sessionId,
        provider: group.id,
        model: model.id,
        ...(model.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}),
      },
    })

    // Follow the session until the turn ends.
    const outcome = await new Promise((resolve, reject) => {
      const streamId = crypto.randomUUID()
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error(`${label}: turn timed out`))
        }
      }, 60000)

      const handle = (text) => {
        const msg = JSON.parse(text)
        if (msg.streamId !== streamId || msg.type !== 'item') return
        if (msg.value?.type === 'event' && msg.value.event?.type === 'turn/end') {
          settled = true
          clearTimeout(timer)
          resolve(msg.value.event.data?.reason)
        }
      }

      const fail = (error) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`${label}: ${error.message}`))
        }
      }

      const onOpen = (send) => {
        send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: 'session/follow',
          payload: {
            args: {
              request: {
                address: { kind: 'session', sessionId },
                assistantStream: true,
                maxMessages: 20,
              },
            },
          },
        }))
        setTimeout(() => {
          rpc('session', 'prompt', {
            request: {
              requestId: crypto.randomUUID(),
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: 'hi' }],
              clientTimeZone: 'Asia/Shanghai',
            },
          }).catch(() => {})
        }, 800)
      }

      if (label === 'direct') {
        rawWebSocket(
          `ws://127.0.0.1:${harnessPort}/api/remote.mux`,
          { cookie: directCookie },
          handle,
          onOpen,
          fail,
        )
      } else {
        const ws = new WebSocket(`${gatewayBase.replace(/^http/, 'ws')}/api/remote.mux?t=${deviceToken}`)
        ws.onopen = () => onOpen((text) => ws.send(text))
        ws.onmessage = (ev) => handle(ev.data)
        ws.onerror = () => fail(new Error('WebSocket error'))
      }
    })
    return outcome
  }

  const directReason = await runTurn(directRpc, 'direct')
  const gatewayReason = await runTurn(gatewayRpc, 'gateway')

  const a = JSON.stringify(normalize(directReason))
  const b = JSON.stringify(normalize(gatewayReason))
  console.log(`      direct  turn/end: ${a.slice(0, 160)}`)
  console.log(`      gateway turn/end: ${b.slice(0, 160)}`)
  if (a !== b) throw new Error(`turn outcomes differ:\n  direct:  ${a}\n  gateway: ${b}`)
})

// ------------------------------------------------------------------- report

await runAll()

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
const failed = results.filter((r) => !r.ok)
if (failed.length > 0) {
  console.log('failures:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
}
process.exit(failed.length > 0 ? 1 : 0)
