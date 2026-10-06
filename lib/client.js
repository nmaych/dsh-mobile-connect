/**
 * dsh-mobile-connect — browser half.
 *
 * Contributes one settings section (`settings.section` id `dsh-mobile-connect`)
 * that shows what the terminal panel shows, in the app:
 *
 *   1. the LAN address a phone should open, and the live pairing code;
 *   2. the QR code that connects a phone without retyping either;
 *   3. the list of paired devices, each with a remove action;
 *   4. the two mutations a user actually performs — issue a new code, and drop
 *      every device.
 *
 * ## Why this file is hand-written
 *
 * It is a plain ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides, and every colour taken from a theme
 * variable so the page survives a scheme switch. That is the same shape the
 * shipped client plugins use, and it keeps the package installable by copying a
 * folder — which matters, because this plugin's whole pitch is that it has no
 * dependencies to install.
 *
 * ## Data flow
 *
 * Everything is read over this plugin's own same-origin `/api/dsh-mobile-connect/*`
 * routes (see `api.js`) rather than through a typed Remote binding. The host half
 * serves those routes from the same process on every composition this plugin
 * targets, and the desktop shell forwards same-origin requests to that process.
 *
 * The QR is an `<img>` pointing at `/qr.svg`, not a browser-side encoder. `qr.js`
 * is the file whose matrices are verified module-by-module against a reference
 * implementation and scanned back by real decoders; a second encoder in this
 * bundle would be untested code producing the one artefact a user cannot debug.
 */

/** Route prefix served by `lib/api.js`. */
const API = '/api/dsh-mobile-connect'
/** Locale namespace this plugin registers its dictionaries under. */
const NS = 'settings.dshMobileConnect'

window.__ModuleLoader__.load({
  id: 'dsh-mobile-connect',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useMemo, useRef, useCallback } = React

    const inject = ['slots', 'locale']

    // ── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: '手机连接',
        title: '手机连接',
        subtitle: '同一 Wi-Fi 下用手机直连这台电脑的 Harness',
        loading: '正在读取手机连接状态…',
        loadFailed: '无法连接插件后端',
        retry: '重试',
        address: '手机连接地址',
        copy: '复制',
        copied: '已复制',
        copyFailed: '复制失败，请手动选中上面的地址',
        code: '配对码',
        codeExpires: '剩余 {time}',
        codeExpired: '配对码已过期',
        codeLocked: '配对码已因连续输错作废',
        noCode: '当前没有有效配对码',
        newCode: '生成新码',
        newCodeHint: '生成新码会让旧码立即失效。',
        ttl: '{n} 分钟内有效',
        qr: '扫码配对',
        qrHint: '用 DSH Mobile 扫描，或在手机上手动输入上面的地址和配对码。',
        qrUnavailable: '二维码暂时不可用，请手动输入地址。',
        devices: '已配对设备',
        deviceCount: '{n} 台',
        noDevices: '还没有配对过任何手机。',
        devicesHint: '配对一次即可，之后自动连接。',
        pairedAt: '配对时间',
        lastSeen: '最近使用',
        remove: '移除',
        removeAll: '移除全部',
        removeAllConfirm: '确定移除全部 {n} 台设备？它们都需要重新配对。',
        removeOneConfirm: '移除「{name}」？那台手机需要重新配对才能连接。',
        cancel: '取消',
        confirm: '确定移除',
        removed: '已移除。那台手机需要重新配对才能连接。',
        removedAll: '已移除全部 {n} 台设备。',
        actionFailed: '操作失败：{message}',
        statusListening: '正在监听',
        statusStopped: '未监听',
        statusDiscovery: '局域网自动发现已开启',
        statusNoDiscovery: '局域网自动发现已关闭',
        noAddress: '没有找到局域网地址。请确认电脑已连上 Wi-Fi 或网线。',
        otherAddresses: '本机还有其它地址：{list}',
        refresh: '刷新',
        never: '从未',
        justNow: '刚刚',
        minutesAgo: '{n} 分钟前',
        hoursAgo: '{n} 小时前',
        daysAgo: '{n} 天前',
      },
      en: {
        nav: 'Phone',
        title: 'Phone connection',
        subtitle: 'Reach this desktop Harness from a phone on the same Wi-Fi',
        loading: 'Reading phone-connection status…',
        loadFailed: 'Cannot reach the plugin backend',
        retry: 'Retry',
        address: 'Phone address',
        copy: 'Copy',
        copied: 'Copied',
        copyFailed: 'Copy failed — select the address above manually',
        code: 'Pairing code',
        codeExpires: '{time} left',
        codeExpired: 'The pairing code has expired',
        codeLocked: 'The code was voided after too many wrong attempts',
        noCode: 'No live pairing code',
        newCode: 'New code',
        newCodeHint: 'A new code invalidates the old one immediately.',
        ttl: 'valid for {n} minutes',
        qr: 'Scan to pair',
        qrHint: 'Scan with DSH Mobile, or type the address and code on the phone.',
        qrUnavailable: 'The QR code is unavailable — type the address instead.',
        devices: 'Paired devices',
        deviceCount: '{n}',
        noDevices: 'No phone has paired yet.',
        devicesHint: 'Pairing once is enough; the app reconnects by itself.',
        pairedAt: 'Paired',
        lastSeen: 'Last used',
        remove: 'Remove',
        removeAll: 'Remove all',
        removeAllConfirm: 'Remove all {n} devices? Each will have to pair again.',
        removeOneConfirm: 'Remove “{name}”? That phone will have to pair again.',
        cancel: 'Cancel',
        confirm: 'Remove',
        removed: 'Removed. That phone must pair again.',
        removedAll: 'Removed all {n} devices.',
        actionFailed: 'Action failed: {message}',
        statusListening: 'Listening',
        statusStopped: 'Not listening',
        statusDiscovery: 'LAN discovery on',
        statusNoDiscovery: 'LAN discovery off',
        noAddress: 'No LAN address found. Check that this computer is on Wi-Fi or Ethernet.',
        otherAddresses: 'Other addresses on this machine: {list}',
        refresh: 'Refresh',
        never: 'never',
        justNow: 'just now',
        minutesAgo: '{n} min ago',
        hoursAgo: '{n} h ago',
        daysAgo: '{n} d ago',
      },
    }

    // ── styles ────────────────────────────────────────────────────────────────
    // Every colour is a `--dsw-alias-*` token with a light-mode literal as the
    // fallback, so the page follows the active theme instead of pinning itself
    // to one scheme. `data-plugin` makes the injected sheet attributable.
    const CSS = `
.dmc_root{display:flex;flex-direction:column;gap:16px;padding:2px 0 8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#1f2328)}
.dmc_head{display:flex;flex-direction:column;gap:4px}
.dmc_h1{margin:0;font-size:17px;line-height:24px;font-weight:600}
.dmc_sub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dmc_pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
.dmc_pill{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:999px;padding:1px 9px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap}
.dmc_pill b{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
.dmc_dot{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-label-tertiary,#9ca3af);flex:none}
.dmc_dot.ok{background:var(--dsw-alias-state-success-primary,#16a34a)}
.dmc_dot.warn{background:var(--dsw-alias-state-warn-primary,#b45309)}
.dmc_dot.err{background:var(--dsw-alias-state-error-primary,#dc2626)}
.dmc_card{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.dmc_cardtitle{display:flex;align-items:baseline;gap:8px;margin:0;font-size:13px;font-weight:600}
.dmc_cardhint{font-size:11px;line-height:17px;font-weight:400;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dmc_pair{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.dmc_left{display:flex;flex-direction:column;gap:12px;flex:1 1 260px;min-width:0}
.dmc_field{display:flex;flex-direction:column;gap:3px;min-width:0}
.dmc_label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dmc_value{display:flex;align-items:center;gap:8px;min-width:0}
.dmc_mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:20px;overflow-wrap:anywhere;min-width:0}
.dmc_addr{font-size:12.5px;color:var(--dsw-alias-label-primary,#1f2328)}
.dmc_code{font-size:26px;line-height:34px;font-weight:600;letter-spacing:.16em;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f2328)}
.dmc_code.gone{letter-spacing:normal;font-size:13px;font-weight:400;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dmc_btn{font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l3,#d9dde3);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;white-space:nowrap;flex:none}
.dmc_btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4f6ef7);color:var(--dsw-alias-brand-primary,#4f6ef7)}
.dmc_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px}
.dmc_btn:disabled{opacity:.5;cursor:default}
.dmc_btn.primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4f6ef7));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}
.dmc_btn.primary:hover:not(:disabled){opacity:.9;color:var(--dsw-alias-label-primary-foreground,#fff)}
.dmc_btn.danger{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626)}
.dmc_btn.danger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff}
.dmc_actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dmc_note{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dmc_qrbox{flex:0 0 auto;display:flex;flex-direction:column;gap:6px;align-items:center}
.dmc_qr{width:196px;height:196px;display:block;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:#fff}
.dmc_qrph{width:196px;height:196px;display:grid;place-items:center;text-align:center;padding:14px;box-sizing:border-box;border:1px dashed var(--dsw-alias-border-l3,#d9dde3);border-radius:10px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dmc_qrcap{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dmc_list{display:flex;flex-direction:column;gap:0;margin:0;padding:0;list-style:none;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;overflow:hidden}
.dmc_row{display:flex;align-items:center;gap:12px;padding:9px 12px;background:var(--dsw-alias-bg-layer-1,#fff);min-width:0}
.dmc_row + .dmc_row{border-top:1px solid var(--dsw-alias-border-l2,#f0f1f3)}
.dmc_ix{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;font-weight:600;flex:none}
.dmc_dev{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}
.dmc_devname{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmc_devmeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b93a1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmc_confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#b45309) 10%, transparent);border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary,#b45309) 30%, transparent);border-radius:9px;padding:8px 11px;font-size:12px;line-height:18px}
.dmc_confirm span{flex:1 1 200px;min-width:0}
.dmc_err{display:flex;align-items:flex-start;gap:8px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#dc2626) 10%, transparent);border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary,#dc2626) 30%, transparent);border-radius:9px;padding:8px 11px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#dc2626);overflow-wrap:anywhere}
.dmc_warn{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#b45309) 10%, transparent);border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary,#b45309) 30%, transparent);border-radius:9px;padding:8px 11px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary,#b45309);overflow-wrap:anywhere}
.dmc_empty{padding:14px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
.dmc_sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (max-width:620px){.dmc_pair{gap:14px}.dmc_qr,.dmc_qrph{width:168px;height:168px}}
`

    // ── helpers ───────────────────────────────────────────────────────────────
    /**
     * One API call with a timeout.
     *
     * The timeout matters more here than it looks: this component is a settings
     * section, and a request that hangs forever leaves a spinner the user cannot
     * dismiss. An abort surfaces as an ordinary error the panel renders.
     */
    async function api(path, options) {
      const { timeout = 8000, ...rest } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, {
          ...rest,
          redirect: 'error',
          signal: ctrl.signal,
        })
        const text = await response.text()
        let payload
        try {
          payload = text === '' ? {} : JSON.parse(text)
        } catch {
          payload = { error: text.slice(0, 200) }
        }
        if (!response.ok) throw new Error(payload?.message ?? payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (path, body) =>
      api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })

    /** Format a countdown as `m:ss`, or `—` once it has run out. */
    function countdown(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '0:00'
      const total = Math.floor(ms / 1000)
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
    }

    /** A coarse "time ago" label, localised through the caller's `t`. */
    function ago(at, t) {
      const value = Number(at)
      if (!Number.isFinite(value) || value <= 0) return t('never')
      const delta = Date.now() - value
      if (delta < 60_000) return t('justNow')
      if (delta < 3_600_000) return t('minutesAgo').replace('{n}', String(Math.floor(delta / 60_000)))
      if (delta < 86_400_000) return t('hoursAgo').replace('{n}', String(Math.floor(delta / 3_600_000)))
      return t('daysAgo').replace('{n}', String(Math.floor(delta / 86_400_000)))
    }

    /** Absolute local timestamp, used where an exact moment is more useful. */
    function stamp(at, locale) {
      const value = Number(at)
      if (!Number.isFinite(value) || value <= 0) return '—'
      try {
        return new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')
      } catch {
        return new Date(value).toISOString()
      }
    }

    /** Copy to the clipboard, preferring the async API and falling back to a selection. */
    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // Permission denied or an insecure context; fall through to the legacy path.
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    // ── the section ───────────────────────────────────────────────────────────

    /**
     * The whole panel.
     *
     * State is one status payload plus a few transient flags. The status is
     * polled slowly (the code is the only thing that moves on its own, and the
     * countdown is computed locally from `codeExpiresAt`) so an open settings
     * page does not hammer the host.
     */
    function Panel(props) {
      const t = props.t
      const locale = props.locale
      const [state, setState] = useState({ status: 'loading', data: undefined, error: '' })
      const [busy, setBusy] = useState('')
      const [actionError, setActionError] = useState('')
      const [notice, setNotice] = useState('')
      const [confirm, setConfirm] = useState(undefined)
      const [copied, setCopied] = useState('')
      // `now` drives the countdown. A single interval for the whole panel beats
      // one per rendered value, and 1s is the resolution the display actually has.
      const [now, setNow] = useState(() => Date.now())
      const alive = useRef(true)

      const load = useCallback(
        async (quiet = false) => {
          if (!quiet) setState(current => ({ ...current, status: 'loading' }))
          try {
            const data = await api('/status')
            if (!alive.current) return
            setState({ status: 'ready', data, error: '' })
          } catch (error) {
            if (!alive.current) return
            setState(current => ({
              status: current.data === undefined ? 'error' : 'ready',
              data: current.data,
              error: String(error?.message ?? error),
            }))
          }
        },
        [],
      )

      useEffect(() => {
        alive.current = true
        void load()
        return () => {
          alive.current = false
        }
      }, [load])

      // Poll for changes made elsewhere (a phone pairing in another window, the
      // `/connect` command, another desktop window). Slow on purpose: the panel
      // is not a live view of a hot path.
      useEffect(() => {
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') void load(true)
        }, 15_000)
        return () => clearInterval(timer)
      }, [load])

      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [])

      const data = state.data
      const code = data?.code ?? null
      const expiresAt = data?.codeExpiresAt ?? null
      const remaining = expiresAt === null ? 0 : Math.max(0, expiresAt - now)
      const live = code !== null && remaining > 0

      const run = async (key, fn, success) => {
        setBusy(key)
        setActionError('')
        setNotice('')
        try {
          const next = await fn()
          if (!alive.current) return
          if (next !== undefined) setState({ status: 'ready', data: next, error: '' })
          else await load(true)
          if (success !== undefined) setNotice(success)
        } catch (error) {
          if (alive.current) setActionError(String(error?.message ?? error))
        } finally {
          if (alive.current) {
            setBusy('')
            setConfirm(undefined)
          }
        }
      }

      const copy = async (label, text) => {
        const ok = await copyText(text)
        setCopied(ok ? label : '')
        setActionError(ok ? '' : t('copyFailed'))
        if (ok) setTimeout(() => alive.current && setCopied(''), 2000)
      }

      if (state.status === 'loading' && data === undefined) {
        return h('div', { className: 'dmc_root' }, h('p', { className: 'dmc_note' }, t('loading')))
      }

      if (data === undefined) {
        return h(
          'div',
          { className: 'dmc_root' },
          h(
            'div',
            { className: 'dmc_err' },
            h('b', null, t('loadFailed')),
            h('span', null, state.error),
          ),
          h('div', { className: 'dmc_actions' }, h('button', { type: 'button', className: 'dmc_btn', onClick: () => void load() }, t('retry'))),
        )
      }

      const baseUrl = data.baseUrl
      const devices = Array.isArray(data.devices) ? data.devices : []
      const others = (data.addresses ?? []).filter(a => a !== data.primaryAddress)

      // The QR is keyed by code + expiry so a rotation remounts the <img> and
      // the browser refetches instead of showing the previous symbol.
      const qrKey = live ? `${code}:${expiresAt}` : ''

      return h(
        'div',
        { className: 'dmc_root' },
        // ---- header -------------------------------------------------------
        h(
          'header',
          { className: 'dmc_head' },
          h('h2', { className: 'dmc_h1' }, t('title')),
          h('p', { className: 'dmc_sub' }, t('subtitle')),
          h(
            'div',
            { className: 'dmc_pills' },
            h(
              'span',
              { className: 'dmc_pill' },
              h('span', { className: `dmc_dot ${data.listening ? 'ok' : 'err'}` }),
              data.listening ? t('statusListening') : t('statusStopped'),
              data.port === null ? null : h('b', null, ` :${data.port}`),
            ),
            h(
              'span',
              { className: 'dmc_pill' },
              h('span', { className: `dmc_dot ${data.discovery ? 'ok' : ''}` }),
              data.discovery ? t('statusDiscovery') : t('statusNoDiscovery'),
            ),
            h('span', { className: 'dmc_pill' }, h('b', null, t('devices')), ` ${t('deviceCount').replace('{n}', String(devices.length))}`),
          ),
        ),

        actionError === '' ? null : h('div', { className: 'dmc_err' }, h('span', null, t('actionFailed').replace('{message}', actionError))),
        notice === '' ? null : h('div', { className: 'dmc_warn' }, notice),
        data.primaryAddress === null
          ? h('div', { className: 'dmc_warn' }, t('noAddress'))
          : null,

        // ---- address + code + QR ------------------------------------------
        h(
          'section',
          { className: 'dmc_card' },
          h('h3', { className: 'dmc_cardtitle' }, t('qr'), h('span', { className: 'dmc_cardhint' }, t('qrHint'))),
          h(
            'div',
            { className: 'dmc_pair' },
            h(
              'div',
              { className: 'dmc_left' },
              h(
                'div',
                { className: 'dmc_field' },
                h('span', { className: 'dmc_label' }, t('address')),
                h(
                  'div',
                  { className: 'dmc_value' },
                  h('code', { className: 'dmc_mono dmc_addr' }, baseUrl ?? '—'),
                  baseUrl === null
                    ? null
                    : h(
                        'button',
                        {
                          type: 'button',
                          className: 'dmc_btn',
                          onClick: () => void copy('addr', baseUrl),
                        },
                        copied === 'addr' ? t('copied') : t('copy'),
                      ),
                ),
              ),
              h(
                'div',
                { className: 'dmc_field' },
                h('span', { className: 'dmc_label' }, t('code')),
                h(
                  'div',
                  { className: 'dmc_value' },
                  live
                    ? h('code', { className: 'dmc_mono dmc_code' }, code)
                    : h(
                        'span',
                        { className: 'dmc_code gone' },
                        data.locked ? t('codeLocked') : data.code === null ? t('noCode') : t('codeExpired'),
                      ),
                  live
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dmc_btn',
                          onClick: () => void copy('code', code),
                        },
                        copied === 'code' ? t('copied') : t('copy'),
                      )
                    : null,
                ),
                h(
                  'span',
                  { className: 'dmc_label' },
                  live
                    ? `${t('codeExpires').replace('{time}', countdown(remaining))} · ${t('ttl').replace('{n}', String(data.codeTtlMinutes))}`
                    : t('newCodeHint'),
                ),
              ),
              h(
                'div',
                { className: 'dmc_actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dmc_btn primary',
                    disabled: busy !== '',
                    onClick: () => void run('code', () => post('/code')),
                  },
                  busy === 'code' ? '…' : t('newCode'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dmc_btn',
                    disabled: busy !== '',
                    onClick: () => void load(),
                  },
                  t('refresh'),
                ),
              ),
              others.length === 0
                ? null
                : h('p', { className: 'dmc_note' }, t('otherAddresses').replace('{list}', others.join('、'))),
            ),
            h(
              'div',
              { className: 'dmc_qrbox' },
              live && qrKey !== ''
                ? h('img', {
                    key: qrKey,
                    className: 'dmc_qr',
                    // `scale` is a rendering hint only; the route encodes the
                    // live code itself, so a stale `src` can never show a
                    // symbol for a code that no longer works.
                    src: `${API}/qr.svg?scale=6`,
                    alt: `${t('code')} ${code}`,
                    width: 196,
                    height: 196,
                  })
                : h('div', { className: 'dmc_qrph' }, live ? t('qrUnavailable') : t('noCode')),
              h('span', { className: 'dmc_qrcap' }, t('qr')),
            ),
          ),
        ),

        // ---- devices ------------------------------------------------------
        h(
          'section',
          { className: 'dmc_card' },
          h(
            'h3',
            { className: 'dmc_cardtitle' },
            t('devices'),
            h('span', { className: 'dmc_cardhint' }, t('devicesHint')),
          ),
          devices.length === 0
            ? h('div', { className: 'dmc_empty' }, t('noDevices'))
            : h(
                'ul',
                { className: 'dmc_list' },
                devices.map(device =>
                  h(
                    'li',
                    { key: `${device.index}:${device.pairedAt}`, className: 'dmc_row' },
                    h('span', { className: 'dmc_ix' }, String(device.index + 1)),
                    h(
                      'span',
                      { className: 'dmc_dev' },
                      h('span', { className: 'dmc_devname' }, device.name),
                      h(
                        'span',
                        { className: 'dmc_devmeta' },
                        `${t('pairedAt')} ${stamp(device.pairedAt, locale)} · ${t('lastSeen')} ${ago(device.lastSeenAt || device.pairedAt, t)}`,
                      ),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dmc_btn danger',
                        disabled: busy !== '',
                        onClick: () => setConfirm({ kind: 'one', device }),
                      },
                      t('remove'),
                    ),
                  ),
                ),
              ),
          confirm?.kind === 'one'
            ? h(
                'div',
                { className: 'dmc_confirm' },
                h('span', null, t('removeOneConfirm').replace('{name}', confirm.device.name)),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dmc_btn danger',
                    disabled: busy !== '',
                    onClick: () =>
                      void run('forget', () => post('/forget', { index: confirm.device.index }), t('removed')),
                  },
                  busy === 'forget' ? '…' : t('confirm'),
                ),
                h('button', { type: 'button', className: 'dmc_btn', onClick: () => setConfirm(undefined) }, t('cancel')),
              )
            : null,
          devices.length === 0
            ? null
            : h(
                'div',
                { className: 'dmc_actions' },
                confirm?.kind === 'all'
                  ? h(
                      Fragment,
                      null,
                      h('span', { className: 'dmc_note' }, t('removeAllConfirm').replace('{n}', String(devices.length))),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dmc_btn danger',
                          disabled: busy !== '',
                          onClick: () =>
                            void run(
                              'forget-all',
                              () => post('/forget-all'),
                              t('removedAll').replace('{n}', String(devices.length)),
                            ),
                        },
                        busy === 'forget-all' ? '…' : t('confirm'),
                      ),
                      h('button', { type: 'button', className: 'dmc_btn', onClick: () => setConfirm(undefined) }, t('cancel')),
                    )
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'dmc_btn danger',
                        disabled: busy !== '',
                        onClick: () => setConfirm({ kind: 'all' }),
                      },
                      t('removeAll'),
                    ),
              ),
        ),
      )
    }

    // ── registration ──────────────────────────────────────────────────────────

    /** The active language tag, read at render time so a switch needs no subscription. */
    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active ?? ctx.locale?.locale
        if (typeof value === 'string' && value !== '') return value.startsWith('zh') ? 'zh' : 'en'
      } catch {
        // A locale service that is absent or shaped differently must not break
        // the panel; the shell mirrors the language onto <html lang>.
      }
      return (document.documentElement.lang || 'en').startsWith('zh') ? 'zh' : 'en'
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-mobile-connect: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-mobile-connect')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-mobile-connect: styles')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-mobile-connect',
            // After the shipped sections (0/10/…) and before third-party
            // extras that ask for a high slot. The exact number only has to be
            // stable, so the entry does not move between releases.
            order: 45,
            label: () => t('nav'),
            locale: NS,
          },
          props => h(Panel, { ...props, t: Object.assign(x => t(x), { locale: localeTag(ctx) }), locale: localeTag(ctx) }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-mobile-connect'
    // Headless test seams: the panel is exercised against a stubbed React in
    // `test/client.test.mjs`, which needs the pure helpers to assert on.
    exports.__test = { Panel, countdown, ago, stamp, DICT, NS, API }
    return module.exports
  },
})
