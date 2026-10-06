/**
 * The browser half of the plugin.
 *
 * `lib/client.js` is not imported — it is *evaluated the way the shell evaluates
 * it*: a `window.__ModuleLoader__.load({ id, factory })` registration whose
 * factory receives a `require` and must return the plugin exports. That is the
 * whole contract, and a bundle that registers but exports nothing usable is a
 * plugin that silently does nothing in the app. So this suite drives the real
 * file through a real registration, then renders the registered component.
 *
 * The React used here is a small stub that records the element tree instead of
 * committing to a DOM. That is deliberate: the assertions worth making are about
 * *what the panel asks for and what it shows* — the routes it calls, the code it
 * displays, the devices it lists — not about CSS or event plumbing. A stub also
 * means the suite runs with no dependencies, which is what keeps this package
 * installable by copying a folder.
 *
 * Two traps this harness is built to avoid, because both would make the suite
 * pass while testing nothing:
 *
 *   1. **`document` must be a real global at call time.** The bundle reads it
 *      when `apply()` runs, not when the file is evaluated. Injecting it as a
 *      `new Function` parameter freezes it to its load-time value.
 *   2. **`require('react')` must receive the same stub the assertions walk.**
 *      Handing the bundle a second, private React instance produces elements the
 *      test cannot see, which reads as "the panel rendered nothing".
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'lib', 'client.js')

const results = []
/**
 * Queue one check.
 *
 * Checks are collected and then run **one at a time**, deliberately. Rendering
 * the panel installs a stub `fetch` and a stub module registration on the shared
 * global object, so two overlapping renders would clobber each other's stubs and
 * the failure would look like "the panel rendered nothing" rather than like a
 * test-harness race. Serial execution is what makes the globals safe.
 */
const pending = []
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn()
      results.push({ name, ok: true })
      console.log(`PASS  ${name}`)
    } catch (error) {
      results.push({ name, ok: false, detail: error.message })
      console.log(`FAIL  ${name}\n      ${error.message}`)
    }
  })
}

// ------------------------------------------------------- browser environment

/**
 * Install the browser globals the bundle expects, for the whole run.
 *
 * These stay installed rather than being swapped per test: the bundle captures
 * nothing at load time, so a single honest environment is both simpler and a
 * closer match to the real shell.
 */
function installBrowser() {
  const styles = []
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        globalThis.window.__dshRegistration = entry
      },
    },
  }
  globalThis.document = {
    documentElement: { lang: 'zh-CN' },
    head: {
      appendChild(node) {
        styles.push(node)
      },
    },
    createElement() {
      const attributes = {}
      return {
        style: {},
        textContent: '',
        setAttribute(name, value) {
          attributes[name] = value
        },
        getAttribute(name) {
          return attributes[name]
        },
        select() {},
        remove() {
          this.removed = true
        },
      }
    },
    body: { appendChild() {}, },
    execCommand: () => true,
    visibilityState: 'visible',
  }
  // `navigator` is a getter-only global in modern Node, so it has to be defined
  // rather than assigned. The bundle only reads `navigator.clipboard`, and only
  // from the copy handler, which these tests do not drive.
  if (globalThis.navigator?.clipboard === undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: undefined },
      configurable: true,
      writable: true,
    })
  }
  return { styles }
}

const browser = installBrowser()

// --------------------------------------------------------------- react stub

/**
 * A minimal React stand-in.
 *
 * Elements are plain `{ type, props, children }` records, so a test can walk the
 * tree. Hooks live in a slot array that `begin()` rewinds, which is what lets a
 * test drive several render passes by hand — this is a single-pass renderer, not
 * a scheduler.
 */
function makeReact() {
  const state = { hooks: [], index: 0, effects: [], refs: [] }

  const React = {
    createElement(type, props, ...children) {
      const flat = children.length === 1 ? children[0] : children.length === 0 ? undefined : children
      return { type, props: props ?? {}, children: flat }
    },
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const i = state.index++
      if (!(i in state.hooks)) state.hooks[i] = typeof initial === 'function' ? initial() : initial
      const set = (value) => {
        state.hooks[i] = typeof value === 'function' ? value(state.hooks[i]) : value
      }
      return [state.hooks[i], set]
    },
    useEffect(fn) {
      state.effects.push(fn)
    },
    useMemo(fn) {
      return fn()
    },
    useRef(initial) {
      const i = state.index++
      if (!(i in state.refs)) state.refs[i] = { current: initial }
      return state.refs[i]
    },
    useCallback(fn) {
      return fn
    },
  }

  return {
    React,
    state,
    /**
     * Render one pass, resolving function components the way React does.
     *
     * This is the part that is easy to get wrong: `h(Panel, props)` is an
     * *element* whose `type` is a function, not the panel's output. A walker that
     * stops there sees a single opaque node and reports "nothing rendered" for a
     * component that is working perfectly. So a function `type` is invoked — with
     * hooks drawn from the shared slot array, in call order, exactly as React
     * would — and the result is expanded in its place.
     *
     * @param {object} element - the root element to render
     * @returns the expanded tree of host elements and text
     */
    render(element) {
      state.index = 0
      state.effects = []
      return expand(element)
    },
    /** The effects declared by the most recent `render`. */
    takeEffects() {
      return state.effects
    },
  }
}

/** Recursively resolve function components into host elements. */
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node

  // A function `type` is a component: call it and expand what it returns.
  if (typeof node.type === 'function') return expand(node.type(node.props))

  return { ...node, children: expand(node.children) }
}

/**
 * Evaluate `lib/client.js` as a classic script and materialize its factory.
 *
 * @param {{ React: object }} react - the stub the bundle's `require('react')` must receive
 */
function loadBundle(react) {
  delete globalThis.window.__dshRegistration
  // `new Function(source)` with no parameters is exactly how a classic script
  // sees the world: every free identifier resolves through the real global scope.
  // eslint-disable-next-line no-new-func
  new Function(fs.readFileSync(clientPath, 'utf8'))()
  const registration = globalThis.window.__dshRegistration
  assert.ok(registration, 'the bundle should register itself via window.__ModuleLoader__.load')
  const require = (specifier) => {
    if (specifier === 'react') return react.React
    throw new Error(`the bundle must not require "${specifier}" — it is not a platform module`)
  }
  return { registration, exports: registration.factory(require) }
}

/** Load the bundle with a fresh React and return everything a test needs. */
function setup() {
  const react = makeReact()
  const { registration, exports } = loadBundle(react)
  const DICT = exports.__test.DICT
  const translate = (key) => {
    const table = DICT.zh
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key
  }
  return { react, registration, exports, translate }
}

/**
 * Register the section the way the shell does, returning the component.
 *
 * @param {{ slots?: object, locale?: object, effect?: Function }} overrides
 */
function register(harness, overrides = {}) {
  const registrations = []
  const effects = []
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    locale: {
      bind: () => harness.translate,
      register: () => {},
      getLocale: () => ({ active: 'zh-CN' }),
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (options, Component) => {
        registrations.push({ options, Component })
        return () => {}
      },
    },
    ...overrides,
  }
  harness.exports.apply(ctx)
  assert.equal(registrations.length, 1, 'apply() should register exactly one slot entry')
  return { ...registrations[0], registrations, effects }
}

// -------------------------------------------------------------- tree walking

/** Walk an element tree, collecting every node the predicate accepts. */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

/** Every string in the tree, concatenated — the panel's visible text. */
function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (typeof node === 'object') textOf(node.children, out)
  return out
}

const text = (tree) => textOf(tree).join(' ')
const buttonLabels = (tree) =>
  findAll(tree, (node) => node.type === 'button').map((node) => textOf(node).join(''))

// -------------------------------------------------------------- render driver

/** A status payload shaped exactly like `lib/api.js` produces. */
function statusPayload(overrides = {}) {
  return {
    version: 1,
    pluginVersion: '1.0.0',
    name: 'DSH Harness',
    enabled: true,
    listening: true,
    discovery: true,
    port: 19387,
    addresses: ['192.168.1.5', '10.0.0.7'],
    primaryAddress: '192.168.1.5',
    baseUrl: 'http://192.168.1.5:19387',
    pairUrl: 'dshmobile://pair?host=192.168.1.5&port=19387&code=021088',
    code: '021088',
    codeExpiresAt: Date.now() + 9 * 60_000,
    codeTtlMinutes: 10,
    locked: false,
    devices: [],
    ...overrides,
  }
}

/**
 * Render the panel through its real mount path and return the settled tree.
 *
 * Two passes are needed and both are honest: the first collects the effects the
 * component declares, and running them is what performs the initial `fetch`.
 * The second renders against the state that request produced — which is exactly
 * the sequence a real renderer performs.
 *
 * @returns the tree, plus every request the panel made.
 */
async function renderPanel({ payload = statusPayload(), fetchImpl } = {}) {
  const harness = setup()
  const { Component } = register(harness)
  const calls = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (fetchImpl !== undefined) return fetchImpl(String(url), init)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(typeof payload === 'function' ? payload() : payload),
      headers: { get: () => null },
    }
  }
  try {
    const props = { t: harness.translate, locale: 'zh' }
    // Pass 1: render, then run the effects it declared — that is what issues the
    // initial fetch. This mirrors a real renderer, which also commits before it
    // flushes effects.
    harness.react.render(Component(props))
    for (const effect of harness.react.takeEffects()) effect()
    // Two macrotask turns: one for the fetch to settle, one for its `then` to
    // update state. State writes land in the shared hook slots either way.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Pass 2: render against the state that request produced.
    const tree = harness.react.render(Component(props))
    return { tree, calls, harness }
  } finally {
    globalThis.fetch = previousFetch
  }
}

// -------------------------------------------------------------- registration

check('the bundle registers itself under the plugin id', () => {
  const { registration } = setup()
  assert.equal(registration.id, 'dsh-mobile-connect')
  assert.equal(typeof registration.factory, 'function')
})

check('the factory exports the apply/inject/name contract', () => {
  const { exports } = setup()
  assert.equal(typeof exports.apply, 'function')
  // `inject` is the Cordis *service* list — an array of names, not a function.
  // (It is unrelated to `dsh.client.inject` in package.json, which orders module
  // arrival.) The shell reads both, so getting the shape wrong here means the
  // section never mounts.
  assert.ok(Array.isArray(exports.inject), `inject should be an array, got ${typeof exports.inject}`)
  assert.deepEqual(exports.inject, ['slots', 'locale'])
  assert.equal(exports.name, 'dsh-mobile-connect')
})

check('the bundle requires nothing beyond the platform react module', () => {
  // `loadBundle`'s `require` throws on anything but `react`, so getting here at
  // all proves the bundle is dependency-free — which is what keeps the package
  // installable by copying a folder.
  const { exports } = setup()
  assert.ok(exports.__test, 'the test seams should be exported')
})

check('apply registers exactly one settings.section with a stable id and order', () => {
  const harness = setup()
  const { options } = register(harness)
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'dsh-mobile-connect')
  assert.equal(typeof options.order, 'number')
  // A thunk, so the nav label follows a locale switch without re-registering.
  assert.equal(typeof options.label, 'function')
  assert.equal(typeof options.label(), 'string')
  assert.ok(options.label().length > 0)
  assert.equal(options.locale, harness.exports.__test.NS)
})

check('apply injects a stylesheet and removes it on teardown', () => {
  const harness = setup()
  const before = browser.styles.length
  const { effects } = register(harness)
  assert.equal(browser.styles.length, before + 1, 'one <style> should be injected')
  const style = browser.styles[browser.styles.length - 1]
  assert.equal(style.getAttribute('data-plugin'), 'dsh-mobile-connect')
  assert.ok(style.textContent.includes('.dmc_root'), 'the sheet should carry the panel rules')
  const dispose = effects.find((fn) => typeof fn === 'function')
  assert.ok(dispose, 'the stylesheet effect should return a disposer')
  dispose()
  assert.equal(style.removed, true, 'teardown should remove the stylesheet')
})

check('the section declares no children slots it does not render', () => {
  // Declaring a child slot is a claim of ownership; an unused claim would let
  // this entry shadow another plugin's seat for no reason.
  const harness = setup()
  const { options } = register(harness)
  assert.equal(options.children, undefined)
})

// ------------------------------------------------------------------- render

check('the panel reads /status on mount', async () => {
  const { calls } = await renderPanel()
  assert.ok(calls.length >= 1, 'the panel should make a request')
  assert.equal(calls[0].url, '/api/dsh-mobile-connect/status')
})

check('the panel shows the address, the code and the countdown', async () => {
  const { tree } = await renderPanel()
  const shown = text(tree)
  assert.ok(shown.includes('http://192.168.1.5:19387'), `address missing from: ${shown}`)
  assert.ok(shown.includes('021088'), `code missing from: ${shown}`)
  assert.ok(/剩余 \d+:\d\d/.test(shown), `countdown missing from: ${shown}`)
})

check('the panel renders the QR as an image pointing at the host route', async () => {
  const { tree } = await renderPanel()
  const images = findAll(tree, (node) => node.type === 'img')
  assert.equal(images.length, 1, 'exactly one QR image')
  assert.match(images[0].props.src, /^\/api\/dsh-mobile-connect\/qr\.svg/)
  // The alt text names the code, so a screen reader conveys the same fact.
  assert.ok(images[0].props.alt.includes('021088'))
})

check('a rotated code remounts the QR so the browser refetches it', async () => {
  const first = await renderPanel({ payload: statusPayload({ code: '111111' }) })
  const second = await renderPanel({ payload: statusPayload({ code: '222222' }) })
  const keyOf = (result) => findAll(result.tree, (node) => node.type === 'img')[0].props.key
  assert.notEqual(keyOf(first), keyOf(second), 'a new code must produce a new image key')
})

check('the panel lists paired devices with their names', async () => {
  const { tree } = await renderPanel({
    payload: statusPayload({
      devices: [
        { index: 0, name: '我的 iPhone', pairedAt: Date.now() - 3600_000, lastSeenAt: Date.now() - 60_000 },
        { index: 1, name: 'Pixel', pairedAt: Date.now() - 7200_000, lastSeenAt: Date.now() - 7200_000 },
      ],
    }),
  })
  const shown = text(tree)
  assert.ok(shown.includes('我的 iPhone'), `first device missing: ${shown}`)
  assert.ok(shown.includes('Pixel'), `second device missing: ${shown}`)
  assert.equal(findAll(tree, (node) => node.type === 'li').length, 2)
})

check('an empty device list says so instead of rendering a bare table', async () => {
  const { tree } = await renderPanel()
  assert.ok(text(tree).includes('还没有配对过任何手机'), `empty state missing: ${text(tree)}`)
  assert.equal(findAll(tree, (node) => node.type === 'li').length, 0)
})

check('the remove-all action is absent when nothing is paired', async () => {
  const { tree } = await renderPanel()
  assert.ok(!buttonLabels(tree).includes('移除全部'), `should not render: ${buttonLabels(tree).join('|')}`)
})

check('the remove-all action is present once a device is paired', async () => {
  const { tree } = await renderPanel({
    payload: statusPayload({ devices: [{ index: 0, name: 'A', pairedAt: Date.now(), lastSeenAt: Date.now() }] }),
  })
  assert.ok(buttonLabels(tree).includes('移除全部'), `remove-all missing: ${buttonLabels(tree).join('|')}`)
})

check('an expired code replaces the digits with an explanation', async () => {
  const { tree } = await renderPanel({
    payload: statusPayload({ code: null, codeExpiresAt: null, pairUrl: null }),
  })
  const shown = text(tree)
  assert.ok(!shown.includes('021088'), 'an expired code must not be shown')
  assert.ok(shown.includes('当前没有有效配对码'), `expired notice missing: ${shown}`)
  // And no QR is drawn for a code that no longer works.
  assert.equal(findAll(tree, (node) => node.type === 'img').length, 0)
})

check('a code past its expiry renders as expired even if the payload still carries it', async () => {
  // The countdown is computed locally from `codeExpiresAt`, so a status response
  // that arrives just before expiry must not keep showing live digits.
  const { tree } = await renderPanel({
    payload: statusPayload({ code: '021088', codeExpiresAt: Date.now() - 1000 }),
  })
  const shown = text(tree)
  assert.ok(!shown.includes('021088'), `a lapsed code must not be shown: ${shown}`)
  assert.equal(findAll(tree, (node) => node.type === 'img').length, 0)
})

check('a locked code is reported as locked, not merely expired', async () => {
  const { tree } = await renderPanel({
    payload: statusPayload({ code: null, codeExpiresAt: null, locked: true, pairUrl: null }),
  })
  assert.ok(text(tree).includes('连续输错'), `lockout notice missing: ${text(tree)}`)
})

check('a machine with no LAN address shows the warning and no QR', async () => {
  const { tree } = await renderPanel({
    payload: statusPayload({
      addresses: [],
      primaryAddress: null,
      baseUrl: null,
      pairUrl: null,
      code: null,
      codeExpiresAt: null,
    }),
  })
  assert.ok(text(tree).includes('没有找到局域网地址'), `no-address warning missing: ${text(tree)}`)
  assert.equal(findAll(tree, (node) => node.type === 'img').length, 0)
})

check('extra LAN addresses are surfaced for the manual-entry path', async () => {
  const { tree } = await renderPanel()
  assert.ok(text(tree).includes('10.0.0.7'), `the secondary address should be listed: ${text(tree)}`)
})

check('a stopped listener is reported, not hidden', async () => {
  const { tree } = await renderPanel({ payload: statusPayload({ listening: false, discovery: false }) })
  const shown = text(tree)
  assert.ok(shown.includes('未监听'), `stopped state missing: ${shown}`)
  assert.ok(shown.includes('局域网自动发现已关闭'), `discovery-off state missing: ${shown}`)
})

check('a backend failure renders an error with a retry, not a blank page', async () => {
  const { tree } = await renderPanel({
    fetchImpl: async () => {
      throw new Error('connection refused')
    },
  })
  const shown = text(tree)
  assert.ok(shown.includes('无法连接插件后端'), `error state missing: ${shown}`)
  assert.ok(shown.includes('connection refused'), `the reason should be shown: ${shown}`)
  assert.ok(buttonLabels(tree).includes('重试'), `retry button missing: ${buttonLabels(tree).join('|')}`)
})

check('the panel never renders a device token', async () => {
  const { tree } = await renderPanel({
    payload: statusPayload({ devices: [{ index: 0, name: 'A', pairedAt: Date.now(), lastSeenAt: Date.now() }] }),
  })
  assert.ok(!/[0-9a-f]{64}/.test(text(tree)), 'a 64-hex token must never appear in the DOM')
})

check('every button is explicitly type=button so it cannot submit a form', async () => {
  const { tree } = await renderPanel({
    payload: statusPayload({ devices: [{ index: 0, name: 'A', pairedAt: Date.now(), lastSeenAt: Date.now() }] }),
  })
  const buttons = findAll(tree, (node) => node.type === 'button')
  assert.ok(buttons.length > 0, 'the panel should render buttons')
  for (const button of buttons) assert.equal(button.props.type, 'button')
})

check('the panel calls no route other than /status on mount', async () => {
  // A mount that already mutated something would rotate the code just by the
  // user opening Settings.
  const { calls } = await renderPanel()
  for (const call of calls) {
    assert.equal(call.init?.method ?? 'GET', 'GET', `unexpected ${call.init?.method} to ${call.url}`)
    assert.equal(call.url, '/api/dsh-mobile-connect/status')
  }
})

// ------------------------------------------------------------- dictionaries

check('both dictionaries define exactly the same keys', () => {
  const { exports } = setup()
  const zh = Object.keys(exports.__test.DICT.zh).sort()
  const en = Object.keys(exports.__test.DICT.en).sort()
  assert.deepEqual(zh.filter((key) => !en.includes(key)), [], 'keys missing from en')
  assert.deepEqual(en.filter((key) => !zh.includes(key)), [], 'keys missing from zh')
})

check('every placeholder in a zh string also appears in its en counterpart', () => {
  const { exports } = setup()
  const placeholders = (value) => (String(value).match(/\{[a-zA-Z]+\}/g) ?? []).sort()
  for (const key of Object.keys(exports.__test.DICT.zh)) {
    assert.deepEqual(
      placeholders(exports.__test.DICT.zh[key]),
      placeholders(exports.__test.DICT.en[key]),
      `placeholder mismatch for "${key}"`,
    )
  }
})

check('the component references no translation key outside the dictionaries', () => {
  // Every `t('…')` call in the source must resolve. A missing key renders the
  // raw key into the UI, which is the classic untranslated-string bug.
  const { exports } = setup()
  const source = fs.readFileSync(clientPath, 'utf8')
  const known = new Set(Object.keys(exports.__test.DICT.zh))
  const called = new Set()
  for (const match of source.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) called.add(match[1])
  assert.ok(called.size > 20, `the scan found only ${called.size} keys — it has probably stopped matching`)
  assert.deepEqual([...called].filter((key) => !known.has(key)), [], 'unknown translation keys')
})

check('every dictionary key is actually used somewhere', () => {
  const { exports } = setup()
  const source = fs.readFileSync(clientPath, 'utf8')
  const called = new Set()
  for (const match of source.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) called.add(match[1])
  const unused = Object.keys(exports.__test.DICT.zh).filter((key) => !called.has(key))
  assert.deepEqual(unused, [], `unused dictionary keys: ${unused.join(', ')}`)
})

// ----------------------------------------------------------------- helpers

check('countdown formats a duration and floors at zero', () => {
  const { exports } = setup()
  const { countdown } = exports.__test
  assert.equal(countdown(9 * 60_000 + 30_000), '9:30')
  assert.equal(countdown(61_000), '1:01')
  assert.equal(countdown(5_000), '0:05')
  assert.equal(countdown(0), '0:00')
  assert.equal(countdown(-1000), '0:00')
  assert.equal(countdown(undefined), '0:00')
})

check('ago degrades from "just now" to days', () => {
  const { exports } = setup()
  const { ago } = exports.__test
  const t = (key) => exports.__test.DICT.zh[key]
  const now = Date.now()
  assert.equal(ago(now - 5_000, t), '刚刚')
  assert.equal(ago(now - 5 * 60_000, t), '5 分钟前')
  assert.equal(ago(now - 3 * 3600_000, t), '3 小时前')
  assert.equal(ago(now - 2 * 86_400_000, t), '2 天前')
  assert.equal(ago(0, t), '从未')
  assert.equal(ago(undefined, t), '从未')
})

check('stamp renders a real timestamp and a dash for nothing', () => {
  const { exports } = setup()
  const { stamp } = exports.__test
  assert.equal(stamp(0, 'zh'), '—')
  assert.equal(stamp(undefined, 'en'), '—')
  assert.ok(stamp(Date.now(), 'zh').length > 4)
})

// -------------------------------------------------------------------- report

for (const run of pending) await run()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length > 0 ? 1 : 0)
