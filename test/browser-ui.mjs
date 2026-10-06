/**
 * Real-browser verification of the desktop panel.
 *
 * Every other suite in this package is offline: `client.test.mjs` evaluates the
 * bundle against a stub React and a stub DOM. That proves the component's logic,
 * but it cannot prove the things that actually decide whether a user sees the
 * panel:
 *
 *   * that the *real* shell boots this bundle and materializes its factory;
 *   * that the *real* slot system accepts the `settings.section` registration;
 *   * that the section shows up in the real sidebar and opens;
 *   * that the QR `<img>` the browser actually loads is a real SVG;
 *   * that the buttons are wired to real state changes, not just to a repaint.
 *
 * Only a real browser against a real Harness can show that, so this drives
 * headless Chrome over the DevTools Protocol and asserts on both the DOM and the
 * plugin's own `/status` route. Reading state back through `/status` is what
 * makes the action checks meaningful: the assertion is that a device was really
 * removed, not that a list re-rendered.
 *
 * Chrome is launched with a throwaway profile and killed at the end.
 *
 * Usage:
 *   node test/browser-ui.mjs <chrome.exe> <dsh-url-with-token> [out-dir]
 *
 * The URL is the `dsh web:` startup line, which carries the process token; the
 * page exchanges it for a session cookie exactly as a human clicking the link.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.argv[2]
const APP_URL = process.argv[3]
const OUT = process.argv[4] ?? path.join(os.tmpdir(), 'dmc-browser-ui')

if (!CHROME || !APP_URL) {
  console.error('usage: node test/browser-ui.mjs <chrome.exe> <dsh-url-with-token> [out-dir]')
  process.exit(2)
}
fs.mkdirSync(OUT, { recursive: true })

/**
 * Pick a port nothing is listening on.
 *
 * A fixed default is a trap: any unrelated local service squatting on it makes
 * Chrome fail to expose its endpoint, and the run dies with "Chrome never
 * exposed its CDP endpoint" — a message that blames Chrome for a collision it
 * did not cause. Binding port 0 and reading back what the OS assigned is the
 * only way to be sure.
 */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const CDP_PORT = Number(process.env.CDP_PORT ?? 0) || (await freePort())

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmc-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,1000',
    '--remote-allow-origins=*',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function cdpEndpoint() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (r.ok) return await r.json()
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('Chrome never exposed its CDP endpoint')
}

/** Minimal CDP client over the WebSocket Node ships natively. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 0
  const pending = new Map()
  const listeners = new Set()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
      return
    }
    for (const fn of listeners) fn(msg)
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = (nextId += 1)
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { ws, ready, send, on: (fn) => listeners.add(fn) }
}

async function main() {
  const version = await cdpEndpoint()
  console.log(`chrome   : ${version.Browser}`)

  const created = await (
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(APP_URL)}`, {
      method: 'PUT',
    })
  ).json()
  const cdp = connect(created.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')

  const consoleErrors = []
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(
        msg.params?.exceptionDetails?.exception?.description ??
          msg.params?.exceptionDetails?.text ??
          'unknown exception',
      )
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
    }
  })

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (r.exceptionDetails) {
      throw new Error(
        `${r.exceptionDetails.text}: ${r.exceptionDetails.exception?.description ?? ''}`,
      )
    }
    return r.result.value
  }

  const waitFor = async (expression, label, timeoutMs = 45000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        if (await evaluate(expression)) return true
      } catch {
        /* navigation in flight */
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await sleep(400)
    }
  }

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', {})
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'))
  }

  /** Click the first visible element whose text matches one of `needles`. */
  const clickText = async (needles, { scope = 'body' } = {}) =>
    await evaluate(`(() => {
      const needles = ${JSON.stringify(needles)}
      const root = document.querySelector(${JSON.stringify(scope)}) || document.body
      const nodes = [...root.querySelectorAll('button,[role="button"],a,[role="tab"],[role="menuitem"]')]
      for (const el of nodes) {
        const label = ((el.getAttribute('aria-label')||'') + ' ' + (el.title||'') + ' ' + (el.innerText||'')).trim()
        if (!label) continue
        if (!needles.some(n => label.includes(n))) continue
        if (el.offsetParent === null) continue
        el.scrollIntoView({ block: 'center' })
        el.click()
        return label
      }
      return null
    })()`)

  /** The panel's live facts, straight from the plugin's own route. */
  const status = async () =>
    await evaluate(`(async () => {
      const r = await fetch('/api/dsh-mobile-connect/status', { credentials: 'include' })
      return await r.json()
    })()`)

  const panelText = async () =>
    await evaluate(`(() => {
      const root = document.querySelector('.dmc_root')
      return root ? root.innerText : document.body.innerText
    })()`)

  // ------------------------------------------------------- shell + panel load
  console.log('\n== app shell ==')
  await waitFor('document.readyState === "complete"', 'document complete')
  await waitFor('!!document.querySelector("#root, [data-dsh-root], body > div")', 'a mounted root')
  await waitFor('document.body.innerText.trim().length > 0', 'non-empty body text')
  await sleep(2500)
  record('the app shell loads', true, APP_URL.replace(/\?token=.*/, '?token=…'))
  await shot('01-shell.png')

  console.log('\n== Settings → 手机连接 ==')
  const openedSettings = await clickText(['设置', 'Settings'])
  record('the settings control is present', Boolean(openedSettings), openedSettings ?? 'not found')
  await sleep(2000)
  await waitFor(
    'document.body.innerText.includes("手机连接") || document.body.innerText.includes("Mobile Connect")',
    'the plugin nav entry',
  )
  const openedSection = await clickText(['手机连接', 'Mobile Connect'])
  record('the plugin nav entry is present', Boolean(openedSection), openedSection ?? 'not found')
  await waitFor('!!document.querySelector(".dmc_root")', 'the panel root', 20000)
  await sleep(1500)
  await shot('02-panel.png')

  const text = await panelText()
  fs.writeFileSync(path.join(OUT, 'panel.txt'), text)
  record('the panel renders', text.includes('手机连接地址'), `${text.length} chars`)

  const before = await status()
  console.log(`  baseline: code=${before.code} devices=${before.devices.length} port=${before.port}`)
  record('the gateway is listening', before.listening === true, `port ${before.port}`)
  record('a live 6-digit code exists', /^\d{6}$/.test(before.code ?? ''), before.code ?? 'none')
  record('the panel shows that code', text.includes(before.code), before.code)
  record(
    'the panel shows the LAN address',
    typeof before.baseUrl === 'string' && text.includes(before.baseUrl),
    before.baseUrl,
  )
  record(
    'the panel shows the device list',
    before.devices.length === 0
      ? text.includes('还没有配对过任何手机')
      : before.devices.every((d) => text.includes(d.name)),
    `${before.devices.length} paired`,
  )
  record('the panel renders the QR image', await evaluate(`!!document.querySelector('.dmc_root img.dmc_qr')`))

  // The QR the browser actually fetched must be a real, decoded SVG.
  const qr = await evaluate(`(async () => {
    const img = document.querySelector('.dmc_root img.dmc_qr')
    if (!img) return { ok: false, why: 'no qr img' }
    const res = await fetch(img.src, { credentials: 'include' })
    const body = await res.text()
    return {
      ok: res.ok, status: res.status, type: res.headers.get('content-type'),
      code: res.headers.get('x-dsh-mobile-connect-code'),
      isSvg: body.includes('<svg'), naturalW: img.naturalWidth, complete: img.complete,
    }
  })()`)
  record('the QR loads as a real SVG in the browser', Boolean(qr?.ok && qr?.isSvg && qr?.naturalW > 0), JSON.stringify(qr))
  record('the QR carries the code the panel shows', qr?.code === before.code, `${qr?.code} vs ${before.code}`)

  // -------------------------------------------------------------- 生成新码
  console.log('\n== 生成新码 ==')
  const gen = await clickText(['生成新码', 'New code'], { scope: '.dmc_root' })
  record('生成新码 is present and clickable', Boolean(gen), gen ?? 'not found')
  await sleep(2500)
  const afterGen = await status()
  record(
    '生成新码 rotated the code',
    afterGen.code !== before.code && /^\d{6}$/.test(afterGen.code ?? ''),
    `${before.code} -> ${afterGen.code}`,
  )
  record('the new code is the one on screen', (await panelText()).includes(afterGen.code), afterGen.code)
  await shot('03-rotated.png')

  // -------------------------------------------------------------- 移除
  console.log('\n== 移除 ==')
  const devicesBefore = (await status()).devices
  if (devicesBefore.length === 0) {
    record('a device exists to remove', false, 'no devices paired; cannot exercise 移除')
  } else {
    const doomed = devicesBefore[0]
    const remove = await clickText(['移除', 'Remove'], { scope: '.dmc_root' })
    record('移除 is present and clickable', Boolean(remove), remove ?? 'not found')
    await sleep(1200)
    record('移除 opens a confirmation step', (await evaluate(`!!document.querySelector('.dmc_confirm')`)) === true)
    record(
      'nothing is removed before confirming',
      (await status()).devices.length === devicesBefore.length,
      `${devicesBefore.length} unchanged`,
    )
    await shot('04-confirm.png')

    const confirmed = await clickText(['确定移除', 'Remove'], { scope: '.dmc_confirm' })
    record('确定移除 is present and clickable', Boolean(confirmed), confirmed ?? 'not found')
    await sleep(2500)
    const afterRemove = await status()
    record(
      'exactly one device was removed',
      afterRemove.devices.length === devicesBefore.length - 1,
      `${devicesBefore.length} -> ${afterRemove.devices.length}`,
    )
    record(
      'the removed device is the one that disappeared',
      !afterRemove.devices.some((d) => d.name === doomed.name && d.pairedAt === doomed.pairedAt),
      `removed "${doomed.name}"`,
    )
    record('the panel no longer lists it', !(await panelText()).includes(doomed.name))
    await shot('05-removed.png')
  }

  // -------------------------------------------------------------- 移除全部
  console.log('\n== 移除全部 ==')
  const beforeAll = (await status()).devices.length
  if (beforeAll === 0) {
    record('devices exist to clear', false, 'nothing left to remove')
  } else {
    const clear = await clickText(['移除全部', 'Remove all'], { scope: '.dmc_root' })
    record('移除全部 is present and clickable', Boolean(clear), clear ?? 'not found')
    await sleep(1200)
    const confirmedAll = await clickText(['确定移除', 'Remove'], { scope: '.dmc_confirm' })
    record('the bulk confirmation is clickable', Boolean(confirmedAll), confirmedAll ?? 'not found')
    await sleep(2500)
    const afterAll = await status()
    record('移除全部 emptied the list', afterAll.devices.length === 0, `${beforeAll} -> ${afterAll.devices.length}`)
    record('the panel shows the empty state', (await panelText()).includes('还没有配对过任何手机'))
    await shot('06-cleared.png')
  }

  // -------------------------------------------------------------- 刷新
  console.log('\n== 刷新 ==')
  const refreshed = await clickText(['刷新', 'Refresh'], { scope: '.dmc_root' })
  record('刷新 is present and clickable', Boolean(refreshed), refreshed ?? 'not found')
  await sleep(1500)
  record('the backend still answers after the whole run', (await status()).listening === true)

  record('no console errors were logged', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || 'none')

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  console.log(`artifacts: ${OUT}`)

  try {
    cdp.ws.close()
  } catch {
    /* ignore */
  }
  chrome.kill()
  return failed.length === 0
}

main()
  .then((ok) => {
    console.log(ok ? '\nRESULT: PASS' : '\nRESULT: FAIL')
    process.exit(ok ? 0 : 1)
  })
  .catch((error) => {
    console.error('\nRESULT: ERROR')
    console.error(error?.stack ?? error)
    try {
      chrome.kill()
    } catch {
      /* ignore */
    }
    process.exit(1)
  })
