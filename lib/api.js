/**
 * The desktop GUI's HTTP surface.
 *
 * The in-app panel needs the same facts the terminal panel prints — the LAN
 * address, the live pairing code, and which phones are paired — plus the three
 * actions a user actually performs (issue a new code, drop one device, drop
 * them all). This module is that surface, and nothing more: it owns no state
 * beyond a QR cache, and every mutation goes through the same {@link PairingService}
 * the `/connect` command uses.
 *
 * ## Why a QR route rather than a browser-side encoder
 *
 * `qr.js` is the most heavily tested file in this package: its matrices are
 * compared module-by-module against a reference implementation, and its output
 * is scanned back by real decoders. Shipping a second encoder into the browser
 * bundle would put the GUI's QR on a different code path from the one those
 * tests cover — and a QR that renders but does not scan is the one failure a
 * user cannot diagnose. So the host renders the symbol and the client displays
 * it as an image.
 *
 * ## Trust
 *
 * These routes live under a prefix longer than the kernel's `/api`, so
 * `webServer`'s longest-prefix dispatch runs them *before* the connection
 * service's own admission check. {@link rejectionFor} re-applies that decision
 * here; see `trust.js` for why that is not optional.
 *
 * @module dsh-mobile-connect/api
 */
import { baseUrlFor, pairUrlFor } from './pair-url.js'
import { encode, toSvg } from './qr.js'
import { rejectionFor } from './trust.js'

/** The route prefix this module answers on. */
export const API_PREFIX = '/api/dsh-mobile-connect'

/** Largest accepted request body: an index or a boolean, nothing more. */
const BODY_LIMIT = 4096

/** QR scales the route will honour, so a caller cannot ask for a 100 MB SVG. */
const MIN_QR_SCALE = 2
const MAX_QR_SCALE = 16

/**
 * Build the request handler for the plugin's API surface.
 *
 * @param {object} deps
 * @param {import('./pairing.js').PairingService} deps.pairing
 * @param {object} deps.config - resolved plugin config
 * @param {object} deps.runtime - live facts about the gateway (port, addresses, …)
 * @param {object} [deps.connection] - the harness `connection` service, when mounted
 * @param {object} [deps.log] - Cordis logger
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApiRoutes({ pairing, config, runtime, connection, log }) {
  /** Rendered symbols, keyed by the exact payload and scale that produced them. */
  const qrCache = new Map()

  /**
   * The bound port, or `null` when nothing is listening.
   *
   * `runtime.port()` reports `null` while the gateway is unbound, and a naive
   * `port === undefined` guard lets that `null` through to string interpolation:
   * the panel would then render `http://192.168.1.5:null` as if it were a real
   * address, and the user would type it into their phone. Anything that is not a
   * usable port number is treated as "no port" here, once, for every caller.
   *
   * @returns {number|null}
   */
  const boundPort = () => {
    const port = runtime.port()
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
  }

  /** Everything the panel needs, computed fresh so a poll never reads a stale code. */
  const status = () => {
    const addresses = runtime.addresses() ?? []
    const primary = runtime.primaryAddress() ?? addresses[0] ?? null
    const port = boundPort()
    // `peekCode`, never `currentCode`: the panel polls this route, and an
    // auto-reissuing read would rotate the code on every poll after the TTL —
    // the user would be typing a code that expires before they finish.
    const code = pairing.peekCode()

    return {
      version: 1,
      pluginVersion: runtime.pluginVersion ?? '1.0.0',
      name: config.name,
      enabled: true,
      listening: runtime.listening(),
      discovery: runtime.discovery(),
      port: port ?? null,
      addresses,
      primaryAddress: primary,
      // Both URLs are built here rather than in the client, so the address the
      // panel shows, the address the QR encodes, and the address the terminal
      // printed can never disagree.
      baseUrl: primary === null || port === null ? null : baseUrlFor({ host: primary, port }),
      pairUrl:
        primary === null || port === null || code === null
          ? null
          : pairUrlFor({ host: primary, port, code }),
      code,
      codeExpiresAt: pairing.hasLiveCode ? pairing.codeExpiresAt : null,
      codeTtlMinutes: config.codeTtlMinutes,
      locked: pairing.isLocked,
      devices: pairing.listDevices().map((device, index) => ({
        index,
        name: device.name,
        pairedAt: device.pairedAt,
        lastSeenAt: device.lastSeenAt,
      })),
    }
  }

  /** Publish the same facts to `status.json`, so the file never lags the GUI. */
  const publish = () => {
    try {
      runtime.publish?.()
    } catch (error) {
      log?.warn?.(`[dsh-mobile-connect] 更新状态文件失败：${error?.message ?? error}`)
    }
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = String(req.method ?? 'GET').toUpperCase()
    const routePath = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'

    const json = (statusCode, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }

    const rejection = rejectionFor(req, connection)
    if (rejection !== undefined) {
      return json(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    }

    try {
      // --- read ---------------------------------------------------------------
      if (method === 'GET' && routePath === '/status') {
        return json(200, status())
      }

      // --- the QR symbol ------------------------------------------------------
      if (method === 'GET' && routePath === '/qr.svg') {
        return sendQr(req, res, url)
      }

      // --- actions ------------------------------------------------------------
      if (method === 'POST' && routePath === '/code') {
        // Rotating the code is the documented way back in after a lockout, so
        // this also clears one. The panel is told the result rather than being
        // asked to guess.
        const code = pairing.issueCode()
        publish()
        log?.info?.('[dsh-mobile-connect] 已在桌面界面中生成新的配对码。')
        return json(200, { ok: true, code, ...status() })
      }

      if (method === 'POST' && routePath === '/forget') {
        const body = await readJsonBody(req)
        const index = Number(body?.index)
        if (!Number.isInteger(index) || index < 0) {
          return json(400, { ok: false, error: 'invalid-index', message: '请给出要移除的设备序号。' })
        }
        const removed = pairing.revokeByIndex(index)
        if (!removed) {
          return json(404, { ok: false, error: 'not-found', message: '那台设备已经不在列表里了。' })
        }
        publish()
        log?.info?.(`[dsh-mobile-connect] 已移除第 ${index + 1} 台设备，它需要重新配对。`)
        return json(200, { ok: true, ...status() })
      }

      if (method === 'POST' && routePath === '/forget-all') {
        const count = pairing.revokeAll()
        publish()
        if (count > 0) {
          log?.info?.(`[dsh-mobile-connect] 已移除全部 ${count} 台设备，它们都需要重新配对。`)
        }
        return json(200, { ok: true, removed: count, ...status() })
      }

      return json(404, { ok: false, error: 'not-found', message: 'not found' })
    } catch (error) {
      // A handler that throws must still answer: the webServer would otherwise
      // destroy the socket and the panel would show a network error instead of
      // the real problem.
      log?.warn?.(`[dsh-mobile-connect] 桌面界面请求失败：${error?.message ?? error}`)
      if (!res.headersSent) {
        return json(500, { ok: false, error: 'internal', message: String(error?.message ?? error) })
      }
      res.end()
      return undefined
    }
  }

  /**
   * Render the current pairing code as an SVG.
   *
   * The route deliberately encodes the *live* code rather than one supplied by
   * the caller. Two reasons: a stale query parameter would otherwise let the
   * panel display a symbol for a code that no longer works, and an endpoint that
   * encodes arbitrary text is a QR-generation service nobody asked for.
   */
  function sendQr(req, res, url) {
    const code = pairing.peekCode()
    if (code === null) {
      return refuseQr(res, '当前没有有效的配对码，请先生成一个。')
    }

    const host = runtime.primaryAddress() ?? runtime.addresses()?.[0] ?? null
    if (host === null) {
      return refuseQr(res, '这台电脑还没有局域网地址，手机暂时连不上。')
    }

    const port = boundPort()
    if (port === null) {
      // Deliberately a different message from the address case above: "no
      // address" and "not listening" have unrelated fixes — join a network
      // versus free the port — and one catch-all sentence sends the user to
      // whichever of the two they did not have.
      return refuseQr(res, '手机连接服务当前没有在监听，请检查端口是否被别的程序占用。')
    }

    const requested = Number(url.searchParams.get('scale'))
    const scale = Number.isInteger(requested)
      ? Math.min(MAX_QR_SCALE, Math.max(MIN_QR_SCALE, requested))
      : 5

    const cacheKey = `${code}|${host}|${port}|${scale}`
    let svg = qrCache.get(cacheKey)
    if (svg === undefined) {
      const pairUrl = pairUrlFor({ host, port, code })
      svg = toSvg(encode(pairUrl), {
        // ISO/IEC 18004's minimum quiet zone. `toSvg` defaults to it already;
        // naming it here records that the GUI is not allowed to shrink it for
        // looks, because a tight margin is what makes a projected QR unscannable.
        quietZone: 4,
        scale,
        title: `DSH Mobile 配对码 ${code}`,
        description: pairUrl,
      })
      // The code rotates at most a few times a session; a small bound keeps a
      // long-lived process from accumulating one entry per rotation forever.
      if (qrCache.size > 16) qrCache.clear()
      qrCache.set(cacheKey, svg)
    }

    res.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'no-store',
      // The encoded code travels back so a caller can detect that the symbol it
      // just received belongs to a newer code than the one on screen.
      'x-dsh-mobile-connect-code': code,
      'content-length': Buffer.byteLength(svg),
    })
    res.end(svg)
    return undefined
  }
}

/**
 * Answer a QR request with a plain-text reason instead of a symbol.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} body
 */
function refuseQr(res, body) {
  res.writeHead(409, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
  return undefined
}

/**
 * Read a small JSON body, tolerating an absent or malformed one.
 *
 * The remainder of an oversized body is *drained, not abandoned*: returning
 * early from inside a `for await` loop invokes the iterator's `return()`, which
 * destroys the readable, so Node can never reach the end of the request body and
 * the socket is never released.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<any>}
 */
async function readJsonBody(req, limit = BODY_LIMIT) {
  const chunks = []
  let size = 0
  let oversized = false
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      oversized = true
      chunks.length = 0
      continue
    }
    if (!oversized) chunks.push(chunk)
  }
  if (oversized || chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}
