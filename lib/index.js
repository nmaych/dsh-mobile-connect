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

/** Box width for the startup panel. */
const PANEL_WIDTH = 62

/** Print the pairing panel with the code, the address, and a QR code. */
async function printPanel({ config, port, address, code, ttlMinutes, deviceCount, log }) {
  const host = address ?? '<本机局域网地址>'
  const baseUrl = `http://${host}:${port}`
  // A dedicated scheme so the QR opens DSH Mobile rather than a browser. The app
  // registers `dshmobile://pair` in its manifest, so scanning this connects
  // directly — the user never types the address or the code.
  const pairUrl = `dshmobile://pair?host=${encodeURIComponent(host)}&port=${port}&code=${code}`

  const lines = []
  const rule = '─'.repeat(PANEL_WIDTH - 2)
  lines.push(`┌─ DSH Mobile Connect ${'─'.repeat(PANEL_WIDTH - 16)}┐`)
  lines.push(`│ 手机连接地址  ${baseUrl.padEnd(PANEL_WIDTH - 17)}│`)
  lines.push(`│ 配对码        ${String(code).padEnd(PANEL_WIDTH - 17)}│`)
  lines.push(`│ 有效期        ${`${ttlMinutes} 分钟`.padEnd(PANEL_WIDTH - 17)}│`)
  if (deviceCount > 0) {
    lines.push(`│ 已配对设备    ${`${deviceCount} 台`.padEnd(PANEL_WIDTH - 17)}│`)
  }
  lines.push(`├${rule}┤`)
  for (const text of [
    '用 DSH Mobile 扫描下面的二维码，或手动输入上面的地址，',
    '然后填入配对码。配对一次即可，之后自动连接。',
  ]) {
    lines.push(`│ ${text.padEnd(PANEL_WIDTH - 3)}│`)
  }
  lines.push(`└${rule}┘`)

  // The QR is a convenience; a failure here must not hide the code.
  let qrText = ''
  try {
    const { encode, toTerminal } = await import('./qr.js')
    qrText = `\n${toTerminal(encode(pairUrl))}\n`
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
    return
  }
  const captured = await gateway.captureSession(authenticatedUrl)
  if (!captured) {
    ctx.logger?.warn?.('[dsh-mobile-connect] 本机会话未建立，手机连接可能不可用。')
  }

  // --- listen --------------------------------------------------------------
  const port = await gateway.listen()
  if (port === undefined) return

  // --- discovery -----------------------------------------------------------
  const address = preferredLanAddress()
  let discovery
  let discoveryAddress = address
  if (config.discovery) {
    discovery = new Discovery({ port, address, log: ctx.logger, instanceName: config.name })
    await discovery.start()
  }

  // --- announce ------------------------------------------------------------
  const code = pairing.issueCode()
  const statusExtras = {
    port,
    addresses: lanAddresses(),
    primaryAddress: address ?? null,
    name: config.name,
  }
  const statusFile = pairing.writeStatusFile(statusExtras)
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
  const refreshStatus = () => pairing.writeStatusFile(statusExtras)
  const statusTimer = setInterval(refreshStatus, 15_000)
  statusTimer.unref?.()

  if (address === undefined) {
    ctx.logger?.warn?.(
      '[dsh-mobile-connect] 没有找到局域网地址。请确认电脑已连上 Wi-Fi 或网线，然后重启 dsh web。',
    )
  } else {
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
  const refresh = setInterval(() => {
    if (discovery === undefined) return
    const now = preferredLanAddress()
    if (now !== discoveryAddress) {
      discovery.close()
      discoveryAddress = now
      discovery = new Discovery({ port, address: now, log: ctx.logger, instanceName: config.name })
      discovery.start().catch(() => {})
      ctx.logger?.info?.(`[dsh-mobile-connect] 网络地址变为 ${now}，已更新局域网广播。`)
    } else {
      discovery.reannounce?.()
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
        const argument = String(invocation?.rawInput ?? '').trim()
        const [verb, rest] = argument.split(/\s+/, 2)

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
          if (!Number.isInteger(index) || index < 0) {
            return { kind: 'error', text: '请给出要移除的设备序号，例如 /connect forget 1。' }
          }
          const removed = pairing.revokeByIndex(index)
          if (!removed) return { kind: 'error', text: `没有第 ${rest} 台设备。用 /connect devices 查看列表。` }
          return { kind: 'success', text: '已移除。那台手机需要重新配对才能连接。' }
        }

        if (verb === 'forget-all' || verb === '全部移除') {
          const count = pairing.revokeAll()
          return {
            kind: 'success',
            text: count === 0 ? '本来就没有已配对的设备。' : `已移除全部 ${count} 台设备，它们都需要重新配对。`,
          }
        }

        // Default: (re)issue a code and show the connection details.
        const fresh = pairing.issueCode()
        const host = preferredLanAddress() ?? '<本机局域网地址>'
        return {
          kind: 'success',
          text: [
            `手机连接地址：http://${host}:${port}`,
            `配对码：${fresh}（${config.codeTtlMinutes} 分钟内有效）`,
            '',
            '在 DSH Mobile 里输入上面的地址和配对码即可。',
          ].join('\n'),
        }
      },
    })
  })

  // --- teardown ------------------------------------------------------------
  ctx.effect(
    () => () => {
      clearInterval(refresh)
      clearInterval(statusTimer)
      discovery?.close()
      void gateway.close()
    },
    'dsh-mobile-connect: lan gateway',
  )
}
