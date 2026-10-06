/**
 * dsh-mobile-connect — reach this desktop's Harness from a phone on the same Wi-Fi.
 *
 * `dsh web` binds loopback only and refuses `--host 0.0.0.0`, so a phone cannot
 * reach it without hand-rolling a port forward. This plugin is the deliberate
 * alternative: an authenticated LAN gateway in front of the same server.
 *
 * It does three things:
 *   1. listens on the LAN and forwards to loopback, rewriting `Host` so the
 *      Harness trust fence admits the request;
 *   2. gates every request behind a paired device token, obtained by typing a
 *      6-digit code the desktop displays;
 *   3. advertises itself over mDNS so the phone finds it without an IP.
 *
 * @module dsh-mobile-connect
 */
import { PairingService } from './pairing.js'
import { Discovery } from './discovery.js'
import { LanGateway, lanAddresses, preferredLanAddress } from './gateway.js'
import { API_PREFIX, createApiRoutes } from './api.js'
import { baseUrlFor, pairUrlFor } from './pair-url.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-mobile-connect'

/**
 * `webServer` gives us the loopback port to forward to; `connection` gives us
 * the process token needed to capture a browser session for the gateway.
 */
export const inject = ['webServer', 'connection']

// schemastery is provided by the Harness, but it is not a hard requirement:
// the plugin stays installable by copying the folder, and falls back to manual
// defaults when the module is absent.
let z
try {
  ;({ default: z } = await import('@deepseek-ai/schemastery'))
} catch {
  z = undefined
}

const DEFAULTS = {
  enabled: true,
  host: '0.0.0.0',
  port: 19387,
  name: 'DSH Harness',
  codeTtlMinutes: 10,
  discovery: true,
}

/** Coerce raw config into the resolved shape, rejecting obvious mistakes. */
function resolveConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) }

  config.enabled = config.enabled !== false
  config.discovery = config.discovery !== false

  const port = Number(config.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`dsh-mobile-connect: port 必须是 1-65535 之间的整数，收到 ${JSON.stringify(config.port)}`)
  }
  config.port = port

  if (typeof config.host !== 'string' || config.host.trim() === '') {
    throw new Error('dsh-mobile-connect: host 不能为空')
  }
  config.host = config.host.trim()

  const ttl = Number(config.codeTtlMinutes)
  config.codeTtlMinutes = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULTS.codeTtlMinutes

  config.name = String(config.name ?? DEFAULTS.name).slice(0, 48)

  return config
}

/** Only exported when schemastery is available, so config errors surface early. */
const schema = z?.object({
  enabled: z.boolean().default(true).description('是否启用手机连接网关'),
  host: z.string().default('0.0.0.0').description('网关监听地址，0.0.0.0 表示局域网所有网卡'),
  port: z.natural().max(65535).default(19387).description('网关监听端口'),
  name: z.string().default('DSH Harness').description('手机端显示的名称'),
  codeTtlMinutes: z.number().default(10).description('配对码有效期（分钟）'),
  discovery: z.boolean().default(true).description('是否通过 mDNS 让手机自动发现'),
})

export { schema as Config }

/** Box width for the startup panel, in terminal cells. */
const PANEL_WIDTH = 62

/**
 * Whether a code point occupies two terminal cells (East Asian Wide/Fullwidth).
 *
 * `String.prototype.padEnd` counts UTF-16 code units, but a CJK character is
 * one unit and two cells wide. Padding a column whose label is Chinese with
 * `padEnd` therefore lands each row's right border in a different column. The
 * ranges below are the standard wide/fullwidth blocks.
 */
function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi, CJK symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana .. CJK compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6)
  )
}

/** Visible width of a string in terminal cells. */
function displayWidth(text) {
  let width = 0
  for (const ch of String(text)) width += isWideCodePoint(ch.codePointAt(0)) ? 2 : 1
  return width
}

/**
 * Pad to a visible width of `cells`, truncating when the text is too long.
 *
 * Truncation matters: an over-long value (a long address, a large device count)
 * would otherwise push the border out and break the box.
 */
function padDisplay(text, cells) {
  const value = String(text)
  const width = displayWidth(value)
  if (width > cells) {
    // Trim by code point until it fits, leaving room for the ellipsis.
    let out = ''
    let used = 0
    for (const ch of value) {
      const w = isWideCodePoint(ch.codePointAt(0)) ? 2 : 1
      if (used + w > cells - 1) break
      out += ch
      used += w
    }
    return `${out}…`
  }
  return value + ' '.repeat(cells - width)
}

/** Render one `│ label value │` row of the panel. */
function panelRow(label, value) {
  const labelWidth = 14
  const content = `${padDisplay(label, labelWidth)}${padDisplay(value, PANEL_WIDTH - 4 - labelWidth)}`
  return `│ ${content} │`
}

/** Print the pairing panel with the code, the address, and a QR code. */
async function printPanel({ config, port, address, code, ttlMinutes, deviceCount, log }) {
  const host = address ?? '<本机局域网地址>'
  const baseUrl = baseUrlFor({ host, port })
  // A dedicated scheme so the QR opens DSH Mobile rather than a browser. The app
  // registers `dshmobile://pair` in its manifest, so scanning this connects
  // directly — the user never types the address or the code.
  const pairUrl = pairUrlFor({ host, port, code })

  const inner = PANEL_WIDTH - 2
  const title = ' DSH Mobile Connect '
  const lines = []
  // `┌─` + title + rule + `┐` must total PANEL_WIDTH cells.
  lines.push(`┌─${title}${'─'.repeat(PANEL_WIDTH - 3 - displayWidth(title))}┐`)
  lines.push(panelRow('手机连接地址', baseUrl))
  lines.push(panelRow('配对码', code))
  lines.push(panelRow('有效期', `${ttlMinutes} 分钟`))
  if (deviceCount > 0) {
    lines.push(panelRow('已配对设备', `${deviceCount} 台`))
  }
  lines.push(`├${'─'.repeat(inner)}┤`)
  for (const text of [
    '用 DSH Mobile 扫描下面的二维码，或手动输入上面的地址，',
    '然后填入配对码。配对一次即可，之后自动连接。',
  ]) {
    lines.push(`│ ${padDisplay(text, inner - 2)} │`)
  }
  lines.push(`└${'─'.repeat(inner)}┘`)

  // The QR is a convenience; a failure here must not hide the code.
  let qrText = ''
  try {
    const { encode, toTerminal } = await import('./qr.js')
    // Quiet zone 4 is the ISO/IEC 18004 minimum; toTerminal's default of 2 is
    // below it and costs scan reliability for no benefit.
    qrText = `\n${toTerminal(encode(pairUrl), { quietZone: 4 })}\n`
  } catch {
    qrText = `\n（二维码不可用，请手动输入地址）\n`
  }

  const output = `\n${lines.join('\n')}\n${qrText}`
  // console.log keeps the panel intact; the Cordis logger prefixes every line.
  console.log(output)
  log?.info?.(`[dsh-mobile-connect] 手机可访问 ${baseUrl}`)
}

/**
 * Mount the gateway, pairing service, and discovery responder.
 *
 * @param ctx - Cordis context carrying `webServer` and `connection`.
 * @param rawConfig - plugin config.
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  if (!config.enabled) {
    ctx.logger?.info?.('[dsh-mobile-connect] 已在配置中关闭，手机将无法连接。')
    return
  }

  const localPort = ctx.webServer?.port
  if (!Number.isInteger(localPort)) {
    ctx.logger?.warn?.('[dsh-mobile-connect] 本机 Web 服务尚未就绪，手机连接未启用。')
    return
  }

  // Device records live under the Harness home so they survive a restart and
  // follow the user's DSH_HOME.
  let storeDir
  try {
    const { resolveDshHome } = await import('@deepseek-ai/dsh-home-paths')
    storeDir = resolveDshHome()
  } catch {
    storeDir = process.env.DSH_HOME ?? process.cwd()
  }
  const pairing = new PairingService({
    storeDir,
    ttlMinutes: config.codeTtlMinutes,
    log: ctx.logger,
  })

  const gateway = new LanGateway({
    pairing,
    localPort,
    localHost: '127.0.0.1',
    config: { ...config, pluginVersion: '1.0.0' },
    log: ctx.logger,
  })

  // --- state the desktop GUI reads -----------------------------------------
  // Declared before anything that can fail, and before the routes that read it.
  //
  // Order matters here and used to be wrong: the LAN bind comes after the
  // credentials exchange, and both can fail for ordinary reasons (the port is
  // taken by another Harness, the network is down). When the panel was mounted
  // *after* those steps, every one of those failures also hid the GUI — which is
  // exactly backwards, because the panel is where a user would go to find out
  // what went wrong. Mounting first means the panel always loads and reports the
  // real state, including "not listening".
  let discovery
  let statusTimer
  let refresh

  // Recomputed on every write rather than captured once: a laptop that changes
  // networks keeps its port but gains a new address, and both `status.json` and
  // the desktop GUI must follow it instead of serving a stale one.
  const statusExtras = () => ({
    port: gateway.port ?? null,
    addresses: lanAddresses(),
    primaryAddress: preferredLanAddress() ?? null,
    name: config.name,
  })
  const refreshStatus = () => pairing.writeStatusFile(statusExtras())

  const runtime = {
    pluginVersion: '1.0.0',
    // `gateway.port` is undefined until `listen()` binds and undefined again once
    // the socket closes, so it is the honest answer in every state — including
    // the one where the bind failed.
    port: () => gateway.port ?? null,
    addresses: () => lanAddresses(),
    primaryAddress: () => preferredLanAddress() ?? null,
    listening: () => gateway.port !== undefined,
    discovery: () => discovery !== undefined,
    publish: refreshStatus,
  }

  ctx.inject(['webServer', 'connection'], (apiCtx) => {
    const handler = createApiRoutes({
      pairing,
      config,
      runtime,
      connection: apiCtx.connection,
      log: ctx.logger,
    })
    apiCtx.effect(
      () => apiCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'dsh-mobile-connect: desktop api routes',
    )
    ctx.logger?.info?.(`[dsh-mobile-connect] 桌面界面接口已挂载于 ${API_PREFIX}`)
  })

  // --- credentials ---------------------------------------------------------
  // The gateway is on loopback, so it can mint a browser session exactly like a
  // local browser: open the token URL, keep the cookie. The phone never sees it.
  const localUrl = `http://127.0.0.1:${localPort}`
  let authenticatedUrl
  try {
    authenticatedUrl = ctx.connection.authenticatedUrl(localUrl)
  } catch (error) {
    ctx.logger?.warn?.(
      `[dsh-mobile-connect] 无法取得本机访问凭据：${error?.message ?? error}。手机连接未启用。`,
    )
    // The panel stays mounted: it reports `listening: false`, and its pairing
    // code is still meaningful for a phone that will connect after a restart.
    return
  }
  const captured = await gateway.captureSession(authenticatedUrl)
  if (!captured) {
    ctx.logger?.warn?.('[dsh-mobile-connect] 本机会话未建立，手机连接可能不可用。')
  }

  // --- listen --------------------------------------------------------------
  const port = await gateway.listen()
  if (port === undefined) return

  // Own the listening socket from this point on. Registering teardown the
  // moment the port is bound means any later failure in this function still
  // releases it — previously teardown was registered at the very end, so a
  // throw in between left a LAN socket listening, orphaned and unreachable,
  // with nothing holding a reference to close it.
  ctx.effect(
    () => () => {
      if (refresh !== undefined) clearInterval(refresh)
      if (statusTimer !== undefined) clearInterval(statusTimer)
      discovery?.close()
      void gateway.close()
    },
    'dsh-mobile-connect: lan gateway',
  )

  // --- discovery -----------------------------------------------------------
  const address = preferredLanAddress()
  let discoveryAddress = address

  // Announce the missing address *before* anything tries to use it. A machine
  // with no LAN interface is an ordinary state (Wi-Fi down, IPv6-only, laptop
  // resumed off-network), and this warning used to sit after the Discovery
  // construction that cannot survive it — which made it dead code on exactly
  // the path that needed it.
  if (address === undefined) {
    ctx.logger?.warn?.(
      '[dsh-mobile-connect] 没有找到局域网地址。请确认电脑已连上 Wi-Fi 或网线，然后重启 dsh web。手机暂时只能手动输入地址（当前也没有地址可用）。',
    )
  } else if (config.discovery) {
    try {
      discovery = new Discovery({ port, address, log: ctx.logger, instanceName: config.name })
      await discovery.start()
    } catch (error) {
      // Discovery is a convenience; a failure here must not stop the gateway,
      // which the user can still reach by typing the printed address.
      discovery = undefined
      ctx.logger?.warn?.(
        `[dsh-mobile-connect] 局域网自动发现未启用：${error?.message ?? error}。可以在手机上手动输入地址。`,
      )
    }
  }

  // --- announce ------------------------------------------------------------
  const code = pairing.issueCode()
  refreshStatus()
  await printPanel({
    config,
    port,
    address,
    code,
    ttlMinutes: config.codeTtlMinutes,
    deviceCount: pairing.deviceCount,
    log: ctx.logger,
  })

  // The status file must track code rotation: after a phone pairs, the plugin
  // issues a new code, and anything reading the file should see the new one.
  statusTimer = setInterval(refreshStatus, 15_000)
  statusTimer.unref?.()

  // A machine with several addresses is worth mentioning: the phone may have
  // reached a different interface than the one we picked.
  if (address !== undefined) {
    const others = lanAddresses().filter((a) => a !== address)
    if (others.length > 0) {
      ctx.logger?.info?.(
        `[dsh-mobile-connect] 本机还有其它地址：${others.join('、')}。手机连不上时，可以在 DSH Mobile 里改用其中一个。`,
      )
    }
  }

  // --- keep discovery fresh ------------------------------------------------
  // A laptop that changes networks keeps the same port but a new address, and a
  // stale mDNS record would send the phone somewhere unreachable.
  //
  // Everything here is wrapped: an exception thrown out of a timer callback is
  // an uncaught exception, and Node's default action is to terminate the
  // process — which would take the whole Harness down because a laptop
  // suspended and resumed off-network. Losing discovery is acceptable; losing
  // `dsh web` is not.
  refresh = setInterval(() => {
    try {
      if (discovery === undefined) return
      const now = preferredLanAddress()
      if (now === discoveryAddress) {
        discovery.reannounce?.()
        return
      }
      // The address changed. If we no longer have one, stop advertising rather
      // than announcing a stale record the phone cannot reach.
      discovery.close()
      discovery = undefined
      discoveryAddress = now
      if (now === undefined) {
        ctx.logger?.warn?.(
          '[dsh-mobile-connect] 网络地址已消失，已停止局域网广播。手机需要手动输入地址，或等网络恢复后重启 dsh web。',
        )
        return
      }
      discovery = new Discovery({ port, address: now, log: ctx.logger, instanceName: config.name })
      discovery.start().catch(() => {})
      ctx.logger?.info?.(`[dsh-mobile-connect] 网络地址变为 ${now}，已更新局域网广播。`)
    } catch (error) {
      // Never let a discovery failure escape into the event loop.
      ctx.logger?.warn?.(`[dsh-mobile-connect] 更新局域网广播失败：${error?.message ?? error}`)
    }
  }, 60_000)
  refresh.unref?.()

  // --- the `/connect` command ---------------------------------------------
  // Somewhere to re-read the code or drop a lost phone without restarting.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'connect',
      description: '查看手机连接地址与配对码，或管理已配对的设备',
      input: { hint: '[code|devices|forget <序号>|forget-all]' },
      handler: (invocation) => {
        // Split into at most two parts, then normalize: users type "forget all"
        // as readily as "forget-all", and both must mean the same thing.
        const parts = String(invocation?.rawInput ?? '')
          .trim()
          .split(/\s+/)
          .filter((p) => p !== '')
        const rawVerb = (parts[0] ?? '').toLowerCase()
        const rest = parts[1]
        const verb = rawVerb === 'forget' && rest?.toLowerCase() === 'all' ? 'forget-all' : rawVerb

        if (verb === '' || verb === 'code' || verb === 'show') {
          // (Re)issue a code and show the connection details.
          const fresh = pairing.issueCode()
          refreshStatus()
          const host = preferredLanAddress() ?? '<本机局域网地址>'
          return {
            kind: 'success',
            text: [
              `手机连接地址：${baseUrlFor({ host, port })}`,
              `配对码：${fresh}（${config.codeTtlMinutes} 分钟内有效）`,
              '',
              '在 DSH Mobile 里输入上面的地址和配对码即可。',
              '也可以打开桌面版的「设置 → 手机连接」，那里有二维码和已配对设备列表。',
            ].join('\n'),
          }
        }

        if (verb === 'devices' || verb === '设备') {
          const devices = pairing.listDevices()
          if (devices.length === 0) {
            return { kind: 'success', text: '还没有配对过任何手机。' }
          }
          const rows = devices.map((d, i) => {
            const when = new Date(d.lastSeenAt || d.pairedAt).toLocaleString('zh-CN')
            return `${i + 1}. ${d.name}（最近使用 ${when}）`
          })
          return {
            kind: 'success',
            text: `已配对 ${devices.length} 台设备：\n${rows.join('\n')}\n\n用 /connect forget <序号> 移除其中一台。`,
          }
        }

        if (verb === 'forget' || verb === '移除') {
          const index = Number(rest) - 1
          if (rest === undefined || !Number.isInteger(index) || index < 0) {
            return {
              kind: 'error',
              text:
                '请给出要移除的设备序号，例如 /connect forget 1；移除全部请用 /connect forget-all。' +
                '用 /connect devices 查看列表。',
            }
          }
          const removed = pairing.revokeByIndex(index)
          if (!removed) return { kind: 'error', text: `没有第 ${rest} 台设备。用 /connect devices 查看列表。` }
          refreshStatus()
          return { kind: 'success', text: '已移除。那台手机需要重新配对才能连接。' }
        }

        if (verb === 'forget-all' || verb === '全部移除') {
          const count = pairing.revokeAll()
          refreshStatus()
          return {
            kind: 'success',
            text: count === 0 ? '本来就没有已配对的设备。' : `已移除全部 ${count} 台设备，它们都需要重新配对。`,
          }
        }

        // An unrecognised verb is an error, not a request for a new code:
        // silently rotating the code used to invalidate whatever the user was
        // about to type, and hid the typo that caused it.
        return {
          kind: 'error',
          text: [
            `无法识别的参数：${rawVerb}`,
            '',
            '可用：',
            '  /connect              显示地址与配对码（会重新生成一个）',
            '  /connect devices      查看已配对的手机',
            '  /connect forget 1     移除第 1 台',
            '  /connect forget-all   移除全部',
          ].join('\n'),
        }
      },
    })
  })
}
