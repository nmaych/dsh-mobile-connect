/**
 * The real end-to-end test: a phone's entire journey through the gateway.
 *
 * Unlike gateway.test.mjs (which uses a fake Harness to isolate the proxy), this
 * runs against a **real** `dsh web` with the plugin installed, and exercises the
 * full path a phone takes:
 *
 *   discover -> pair with the code -> list sessions -> create -> prompt ->
 *   stream a live turn -> cancel
 *
 * If this passes, the phone needs no port forwarding and no knowledge of the
 * Harness's internal auth.
 *
 * usage: node test/e2e-live.mjs <gatewayBase> [code]
 *   e.g. node test/e2e-live.mjs http://127.0.0.1:19399
 *        (omit the code to have the script read it from the plugin's stdout log)
 */
import crypto from 'node:crypto'
import fs from 'node:fs'

const base = (process.argv[2] ?? 'http://127.0.0.1:19399').replace(/\/$/, '')
const codeArg = process.argv[3]

/**
 * Find the live pairing code.
 *
 * The plugin publishes `status.json` under the Harness home, which is the
 * stable way to read the current code. The console log is a fallback for a
 * human watching the terminal.
 */
function discoverCode() {
  if (codeArg) return codeArg
  if (process.env.DSH_CONNECT_CODE) return process.env.DSH_CONNECT_CODE

  const candidates = []
  if (process.env.DSH_CONNECT_STATUS) candidates.push(process.env.DSH_CONNECT_STATUS)
  const home = process.env.DSH_HOME
  if (home) candidates.push(`${home}/status.json`)
  candidates.push('E:/deepseekworkspace/dsh-mobile-connect/test/dshhome/status.json')

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      if (typeof parsed.code === 'string' && /^\d{6}$/.test(parsed.code)) return parsed.code
      if (parsed.locked === true) {
        throw new Error('the pairing code is locked out; restart the Harness for a fresh one')
      }
    } catch (error) {
      if (String(error.message).includes('locked out')) throw error
      // Try the next candidate.
    }
  }
  throw new Error(`no pairing code found; tried ${candidates.join(', ')}`)
}

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

let token = ''
let sessionId = ''

/** Call the Harness through the gateway, exactly as the phone does. */
async function rpc(namespace, method, args) {
  const rpcId = crypto.randomUUID()
  const res = await fetch(`${base}/api/${namespace}/${method}?t=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: `${namespace}/${method}`,
      payload: { args },
    }),
  })
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const body = await res.json()
  if (body.result?.ok === true) return body.result.value
  throw new Error(`${body.result?.error?.code}: ${body.result?.error?.message}`)
}

/** Open a logical stream through the gateway's WebSocket tunnel. */
function openStream(endpoint, args, onItem, onOpen) {
  return new Promise((resolve, reject) => {
    const streamId = crypto.randomUUID()
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/remote.mux?t=${token}`)
    let opened = false

    const timer = setTimeout(() => {
      if (!opened) reject(new Error('timed out opening the stream'))
    }, 20000)

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
    }
    ws.onerror = () => {
      if (!opened) {
        clearTimeout(timer)
        reject(new Error('WebSocket error'))
      }
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.streamId !== streamId) return
      if (msg.type === 'item') {
        if (!opened) {
          opened = true
          clearTimeout(timer)
          onOpen?.()
          resolve({ ws, streamId })
        }
        onItem(msg.value)
      } else if (msg.type === 'end') {
        ws.close()
      } else if (msg.type === 'error') {
        if (!opened) {
          clearTimeout(timer)
          reject(new Error(`${msg.error.code}: ${msg.error.message}`))
        }
      }
    }
  })
}

// ---------------------------------------------------------------- the journey

check('the gateway is reachable and asks for pairing', async () => {
  const res = await fetch(`${base}/.dsh-mobile-connect/info`)
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  const info = await res.json()
  if (info.service !== 'dsh-mobile-connect') throw new Error(`unexpected service ${info.service}`)
  console.log(`      gateway: ${info.name}, ${info.deviceCount} paired device(s)`)
})

check('the Harness is unreachable without a device token', async () => {
  const res = await fetch(`${base}/api/session/list`, { method: 'POST' })
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`)
  await res.arrayBuffer()
})

check('the pairing code is accepted and returns a device token', async () => {
  const code = discoverCode()
  const res = await fetch(`${base}/.dsh-mobile-connect/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'E2E 测试设备' }),
  })
  const body = await res.json()
  if (!body.ok) throw new Error(`${body.reason}: ${body.message}`)
  token = body.token
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('token is not 32 random bytes')
  console.log(`      paired using code ${code}`)
})

check('session/list works through the gateway', async () => {
  const value = await rpc('session', 'list', { _request: {} })
  const items = value.items ?? []
  console.log(`      ${items.length} session(s) visible`)
  if (items[0]) {
    console.log(`      newest: ${JSON.stringify(items[0].projections?.values?.title ?? items[0].sessionId)}`)
  }
})

check('session/create works through the gateway', async () => {
  const value = await rpc('session', 'create', { request: {} })
  sessionId = value.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('no sessionId returned')
  console.log(`      created ${sessionId}`)
})

check('session/modelCatalog works through the gateway', async () => {
  const catalog = await rpc('session', 'modelCatalog', {})
  const groups = catalog.groups ?? []
  if (groups.length === 0) throw new Error('no model providers available')
  console.log(`      providers: ${groups.map((g) => g.id).join(', ')}`)

  // Prefer a provider that does not need an environment API key, so the turn
  // below can actually complete. `deepseek-web` authenticates through the
  // account the desktop is already signed in to.
  const preferred = ['deepseek-web', 'deepseek-account']
  const group =
    groups.find((g) => preferred.includes(g.id)) ??
    groups[0]
  const model = group.models[0]
  await rpc('session', 'selectModel', {
    request: {
      sessionId,
      provider: group.id,
      model: model.id,
      ...(model.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}),
    },
  })
  console.log(`      selected ${group.id}/${model.id}`)
})

check('a full model turn streams through the gateway WebSocket', async () => {
  const seen = {
    snapshot: false,
    userMessage: false,
    turnStart: false,
    turnEnd: false,
    assistantMessage: false,
    liveFrames: 0,
    text: '',
    endReason: null,
  }

  const stream = await openStream(
    'session/follow',
    {
      request: {
        address: { kind: 'session', sessionId },
        assistantStream: true,
        maxMessages: 50,
      },
    },
    (item) => {
      if (item.type === 'snapshot') seen.snapshot = true
      else if (item.type === 'event') {
        const e = item.event
        if (e.type === 'user/message') seen.userMessage = true
        if (e.type === 'turn/start') seen.turnStart = true
        if (e.type === 'turn/end') {
          seen.turnEnd = true
          seen.endReason = e.data?.reason
        }
        if (e.type === 'assistant/message') {
          seen.assistantMessage = true
          for (const b of e.data?.message?.content ?? []) {
            if (b.type === 'text') seen.text += b.text
          }
        }
      } else if (item.type === 'assistant-stream') {
        seen.liveFrames += 1
        const f = item.frame
        if (f?.type === 'chunk' && f.chunk?.type === 'text-delta') seen.text += f.chunk.text
      }
    },
  )

  if (!seen.snapshot) throw new Error('the stream did not open with a snapshot')

  await new Promise((r) => setTimeout(r, 1200))
  await rpc('session', 'prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Reply with exactly: GATEWAY OK' }],
      clientTimeZone: 'Asia/Shanghai',
    },
  })

  const deadline = Date.now() + 120000
  while (Date.now() < deadline && !seen.turnEnd) await new Promise((r) => setTimeout(r, 400))
  try {
    stream.ws.close()
  } catch {
    // Already closed.
  }

  console.log(
    `      events: user=${seen.userMessage} start=${seen.turnStart} end=${seen.turnEnd} ` +
      `assistant=${seen.assistantMessage} live=${seen.liveFrames}`,
  )
  console.log(`      turn/end reason: ${JSON.stringify(seen.endReason)}`)
  console.log(`      text: ${JSON.stringify(seen.text.slice(0, 120))}`)

  if (!seen.turnEnd) throw new Error('the turn never finished')
  if (!seen.assistantMessage) throw new Error('no durable assistant message arrived')
  if (!seen.text.includes('GATEWAY OK')) {
    throw new Error(`assistant text did not contain the expected marker: ${JSON.stringify(seen.text.slice(0, 200))}`)
  }
  if (seen.liveFrames === 0) throw new Error('no live assistant-stream frames arrived')
})

check('session/cancel works through the gateway', async () => {
  const value = await rpc('session', 'cancel', { request: { sessionId } })
  if (value?.accepted !== true) throw new Error(`unexpected result ${JSON.stringify(value)}`)
})

check('the phone never receives a session cookie', async () => {
  const res = await fetch(`${base}/api/session/list?t=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method: 'session/list',
      payload: { args: { _request: {} } },
    }),
  })
  const cookies = res.headers.getSetCookie?.() ?? []
  await res.arrayBuffer()
  if (cookies.length > 0) throw new Error(`cookies leaked: ${JSON.stringify(cookies)}`)
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
