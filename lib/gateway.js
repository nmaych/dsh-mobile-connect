/**
 * LAN gateway — lets a phone on the same Wi-Fi reach `dsh web` directly.
 *
 * ## Why this exists
 *
 * `dsh web` binds loopback only and refuses `--host 0.0.0.0`, because exposing
 * remote code execution to a network is a bad default. That leaves a desktop
 * user with no way to reach their own Harness from a phone without hand-rolling
 * a port forward, which is both fiddly and unauthenticated.
 *
 * This gateway is the deliberate, authenticated alternative: it listens on the
 * LAN, requires a paired device, and forwards to loopback.
 *
 * ## How the two fences are satisfied
 *
 * The Harness puts two independent checks in front of `/api`:
 *
 *  1. A **Host/Origin fence**. The request's `Host` must be loopback or a
 *     declared trusted authority. The gateway forwards to `127.0.0.1` and
 *     rewrites `Host` to `127.0.0.1:<port>`, which is unambiguously loopback.
 *     A hostile DNS name therefore cannot reach the bridge through here.
 *
 *  2. **Browser-session authentication** — an authority-bound signed cookie.
 *     The gateway obtains one for itself at startup (it is on loopback, so it
 *     can perform the token exchange), and attaches it to every forwarded
 *     request. This is the piece that makes the design work: the phone never
 *     sees the cookie, and the gateway only ever forwards requests that already
 *     carried a valid device token.
 *
 * The phone is authenticated at the gateway; the gateway is authenticated at
 * the Harness. Neither check is bypassed.
 */
import http from 'node:http'
import { networkInterfaces } from 'node:os'

/** Maximum accepted body for the pairing endpoint: a 6-digit code and a name. */
const PAIR_BODY_LIMIT = 4096

/** Header hop-by-hop values that must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Every non-internal IPv4 address this machine has.
 *
 * These are the addresses a phone can actually reach, so they are what the
 * pairing instructions and the mDNS advert should name.
 */
export function lanAddresses() {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address)
    }
  }
  return out
}

/** Pick the address most likely to be on the phone's network. */
export function preferredLanAddress() {
  const all = lanAddresses()
  // 192.168.x and 10.x are the common home/office ranges; 172.16-31 is the
  // Docker/WSL range and usually not the one a phone can reach.
  const home = all.find((a) => a.startsWith('192.168.'))
  if (home !== undefined) return home
  const ten = all.find((a) => a.startsWith('10.'))
  if (ten !== undefined) return ten
  return all.find((a) => !a.startsWith('172.')) ?? all[0]
}

/**
 * The LAN gateway server.
 *
 * One instance owns one listening socket and forwards to the local Harness.
 */
export class LanGateway {
  #server
  #pairing
  #log
  #localPort
  #localHost
  #cookie = ''
  #config
  #startedAt = 0
  /**
   * Tunnelled sockets.
   *
   * `server.closeAllConnections()` deliberately leaves upgraded sockets alone,
   * so without this set a live phone would keep the process alive through
   * shutdown and `close()` would never settle.
   */
  #tunnels = new Set()

  /**
   * @param options.pairing - the {@link PairingService} gating access.
   * @param options.localPort - the loopback port `dsh web` listens on.
   * @param options.localHost - loopback host, normally `127.0.0.1`.
   * @param options.config - resolved plugin config.
   * @param options.log - Cordis logger.
   */
  constructor({ pairing, localPort, localHost, config, log }) {
    this.#pairing = pairing
    this.#localPort = localPort
    this.#localHost = localHost
    this.#config = config
    this.#log = log
  }

  /** The bound port, or undefined before `listen()`. */
  get port() {
    return this.#server?.address()?.port
  }

  // ------------------------------------------------------------- credentials

  /**
   * Capture a browser session from the local Harness.
   *
   * The gateway is on loopback, so it can do exactly what a local browser does:
   * open `/?token=…` and keep the cookie that comes back. The process token is
   * read from the Connection service rather than scraped from stdout.
   *
   * @param authenticatedUrl - `connection.authenticatedUrl('http://127.0.0.1:p')`.
   * @returns true when a session cookie was captured.
   */
  async captureSession(authenticatedUrl) {
    try {
      const response = await fetch(authenticatedUrl, { redirect: 'manual' })
      // Consume the body so the socket is released.
      await response.arrayBuffer().catch(() => {})

      const raw = response.headers.getSetCookie?.() ?? []
      const pairs = []
      for (const entry of raw) {
        const pair = entry.split(';', 1)[0]?.trim()
        if (pair !== undefined && pair !== '' && pair.includes('=')) pairs.push(pair)
      }
      if (pairs.length === 0) {
        this.#log?.warn?.(
          '[dsh-mobile-connect] 未能取得本机会话凭据，手机连接后将无法访问。请重启 dsh web 后重试。',
        )
        return false
      }
      this.#cookie = pairs.join('; ')
      return true
    } catch (error) {
      this.#log?.warn?.(
        `[dsh-mobile-connect] 连接本机服务失败：${error?.message ?? error}。手机将暂时无法使用。`,
      )
      return false
    }
  }

  // ------------------------------------------------------------------ listen

  /**
   * Bind the LAN socket.
   *
   * A bind failure is reported and swallowed rather than thrown: a desktop with
   * no network, or a port already taken, should still boot the Harness.
   *
   * @returns the bound port, or undefined when the bind failed.
   */
  async listen() {
    const { host, port } = this.#config

    this.#server = http.createServer((req, res) => {
      this.#handleHttp(req, res).catch((error) => {
        this.#log?.warn?.(`[dsh-mobile-connect] 转发请求出错：${error?.message ?? error}`)
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        }
        res.end('网关转发失败')
      })
    })

    this.#server.on('upgrade', (req, socket, head) => {
      this.#handleUpgrade(req, socket, head)
    })

    // Never let a socket error take the process down.
    this.#server.on('clientError', (error, socket) => {
      this.#log?.warn?.(`[dsh-mobile-connect] 客户端连接异常：${error?.message ?? error}`)
      socket.destroy()
    })

    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          this.#server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          this.#server.off('error', onError)
          resolve()
        }
        this.#server.once('error', onError)
        this.#server.once('listening', onListening)
        this.#server.listen(port, host)
      })
    } catch (error) {
      const code = error?.code
      const hint =
        code === 'EADDRINUSE'
          ? `端口 ${port} 已被占用。请把 config.port 改成别的端口。`
          : code === 'EACCES'
            ? `没有权限监听端口 ${port}。请换一个大于 1024 的端口。`
            : '请检查电脑的网络连接。'
      this.#log?.warn?.(`[dsh-mobile-connect] 无法在 ${host}:${port} 上启动：${hint}`)
      this.#server = undefined
      return undefined
    }

    this.#startedAt = Date.now()
    return this.port
  }

  /** Close the listening socket and every tunnel through it. */
  async close() {
    const server = this.#server
    if (server === undefined) return
    this.#server = undefined

    // Destroy tunnels first: an upgraded socket keeps the server's connection
    // count above zero, so `close()` would otherwise never call back.
    for (const socket of this.#tunnels) {
      try {
        socket.destroy()
      } catch {
        // Already gone.
      }
    }
    this.#tunnels.clear()

    await new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
      // Belt and braces: if a socket still refuses to release, do not hang the
      // caller's shutdown.
      const timer = setTimeout(resolve, 2000)
      timer.unref?.()
    })
  }

  // -------------------------------------------------------------- forwarding

  /**
   * Build the loopback target URL for one incoming request.
   *
   * Built from the *parsed* URL rather than by concatenating the raw request
   * line. String concatenation let shapes like `//evil.example/x`, `/\evil.example`
   * and `%2f`-encoded dot segments travel to the upstream verbatim, where a
   * second, different interpretation applies — the gateway would authorize one
   * path and the upstream act on another. Taking `pathname`/`search` from the
   * URL object means the target authority is always the configured loopback
   * address and the path is the normalized one we authenticated.
   *
   * @returns a URL whose origin is the local Harness.
   */
  #targetUrl(url) {
    const base = `http://${this.#localHost}:${this.#localPort}`
    // `url` is the already-parsed request URL; keep its query but never its
    // authority (a protocol-relative or absolute request target must not be
    // able to redirect the hop).
    return new URL(`${url.pathname}${url.search}`, base)
  }

  /**
   * Headers to forward upstream.
   *
   * `Host` becomes loopback so the Harness trust fence admits the request; the
   * browser-session cookie is attached here and never travels to the phone.
   */
  #upstreamHeaders(req, { withCookie }) {
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower)) continue
      if (lower === 'host') continue
      if (lower === 'cookie') continue
      // `Expect: 100-continue` is answered *here*, not upstream. Node's HTTP
      // server sends the interim `100 Continue` itself when no `checkContinue`
      // listener is registered, so by the time this handler runs the client has
      // already been told to send the body and we are streaming it. Forwarding
      // the header would ask a second server to make the same decision — and
      // Node's own `fetch` (undici) refuses it outright with
      // `UND_ERR_NOT_SUPPORTED`, turning every such request into a 502 that
      // looks like "the desktop is down". Dropping it is both correct and what
      // keeps clients like .NET's HttpClient and `curl` working.
      if (lower === 'expect') continue
      if (value !== undefined) headers[lower] = value
    }
    headers.host = `${this.#localHost}:${this.#localPort}`
    if (withCookie && this.#cookie !== '') headers.cookie = this.#cookie
    return headers
  }

  /** Handle one proxied HTTP request. */
  async #handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://placeholder')

    // --- the gateway's own endpoints, answered locally ---------------------
    if (url.pathname.startsWith('/.dsh-mobile-connect/')) {
      return this.#handleLocalApi(req, res, url)
    }

    // --- everything else needs a paired device -----------------------------
    const device = this.#authenticate(req, url)
    if (device === undefined) {
      return this.#writeUnauthorized(res)
    }

    // --- proxy --------------------------------------------------------------
    const init = {
      method: req.method,
      headers: this.#upstreamHeaders(req, { withCookie: true }),
      redirect: 'manual',
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req
      init.duplex = 'half'
    }

    let upstream
    try {
      upstream = await fetch(this.#targetUrl(url), init)
    } catch (error) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`无法连接到本机 DSH 服务：${error?.message ?? error}`)
      return
    }

    const headers = {}
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower)) return
      // The upstream cookie is for the gateway's own session; the phone has no
      // use for it and must not be able to replay it.
      if (lower === 'set-cookie') return
      // `fetch` transparently decompresses the body, so relaying the encoding
      // header would tell the client to gunzip plain bytes. `content-length`
      // is likewise the compressed size and no longer describes the body;
      // Node recomputes it (or switches to chunked) if we drop it.
      if (lower === 'content-encoding' || lower === 'content-length') return
      headers[key] = value
    })

    res.writeHead(upstream.status, headers)
    if (upstream.body === null) {
      res.end()
      return
    }
    await upstream.body.pipeTo(
      new WritableStream({
        write(chunk) {
          res.write(chunk)
        },
        close() {
          res.end()
        },
        abort() {
          res.destroy()
        },
      }),
    ).catch(() => res.destroy())
  }

  /**
   * Proxy a WebSocket upgrade.
   *
   * `dsh web` serves its remote mux at `/api/remote.mux` over a WebSocket. Node's
   * HTTP client cannot upgrade, so the tunnel is opened by hand: send the
   * upgrade request, validate the `101`, then splice the two sockets.
   */
  #handleUpgrade(req, socket, head) {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    const device = this.#authenticate(req, url)
    if (device === undefined) {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n' +
          '未配对：请先在 DSH Mobile 中完成配对。',
      )
      socket.destroy()
      return
    }

    const headers = this.#upstreamHeaders(req, { withCookie: true })
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    // Preserve the original Host so the Harness can apply its own fence, but
    // as loopback (the fence accepts loopback on any port).
    headers.host = `${this.#localHost}:${this.#localPort}`

    const upstream = http.request({
      host: this.#localHost,
      port: this.#localPort,
      method: 'GET',
      path: req.url,
      headers,
    })

    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? 'Switching Protocols'}`]
      for (const [key, value] of Object.entries(upRes.headers)) {
        const lower = key.toLowerCase()
        if (lower === 'set-cookie') continue
        if (Array.isArray(value)) {
          for (const v of value) lines.push(`${key}: ${v}`)
        } else if (value !== undefined) {
          lines.push(`${key}: ${value}`)
        }
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upHead !== undefined && upHead.length > 0) socket.write(upHead)
      if (head !== undefined && head.length > 0) upSocket.write(head)

      // From here the two sockets are one pipe; any error closes both.
      // Track the pair so shutdown can tear them down deterministically.
      this.#tunnels.add(socket)
      this.#tunnels.add(upSocket)
      const drop = () => {
        this.#tunnels.delete(socket)
        this.#tunnels.delete(upSocket)
      }
      upSocket.on('error', () => socket.destroy())
      socket.on('error', () => upSocket.destroy())
      upSocket.on('close', () => {
        drop()
        socket.destroy()
      })
      socket.on('close', () => {
        drop()
        upSocket.destroy()
      })
      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })

    upstream.on('response', (upRes) => {
      // The upstream refused the upgrade (e.g. 401/403). Relay the status so the
      // client sees a real answer rather than a hang.
      upRes.resume()
      socket.write(
        `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? ''}\r\nconnection: close\r\n\r\n`,
      )
      socket.destroy()
    })

    upstream.on('error', () => {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n')
      socket.destroy()
    })

    upstream.end()
  }

  // ---------------------------------------------------------- authentication

  /**
   * Identify the calling device.
   *
   * The token rides in a query parameter rather than a header because browsers
   * cannot set headers on a WebSocket handshake, and the same credential has to
   * work for both transports.
   *
   * @returns the device record, or undefined when unauthenticated.
   */
  #authenticate(req, url) {
    const token = url.searchParams.get('t')
    return this.#pairing.verifyDeviceToken(token)
  }

  #writeUnauthorized(res) {
    res.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end('未配对或配对已失效。请在 DSH Mobile 中重新配对。')
  }

  // -------------------------------------------------------- local endpoints

  /** Endpoints the gateway answers itself, never proxied. */
  async #handleLocalApi(req, res, url) {
    const send = (status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      })
      res.end(text)
    }

    switch (`${req.method} ${url.pathname}`) {
      // Unauthenticated on purpose: this is how a phone learns the gateway is
      // there and what to do next. It exposes no secret and no Harness data.
      case 'GET /.dsh-mobile-connect/info':
        return send(200, {
          service: 'dsh-mobile-connect',
          version: this.#config.pluginVersion ?? '0.0.0',
          name: this.#config.name,
          pairingRequired: true,
          deviceCount: this.#pairing.deviceCount,
          startedAt: this.#startedAt,
        })

      // The one endpoint a phone reaches before it is paired. It is rate
      // limited inside the PairingService, not here.
      case 'POST /.dsh-mobile-connect/pair': {
        // Refuse an oversized body from its declared length, before reading a
        // single byte. The pairing payload is a 6-digit code and a short name,
        // so anything larger is a mistake or an attack; answering immediately
        // keeps a hostile peer from occupying a connection while it uploads.
        const declared = Number(req.headers['content-length'])
        if (Number.isFinite(declared) && declared > PAIR_BODY_LIMIT) {
          res.writeHead(413, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'close',
          })
          res.end(JSON.stringify({ ok: false, reason: 'too-large', message: '请求体过大。' }))
          req.resume() // Drain so the socket can close.
          return undefined
        }

        const body = await readJsonBody(req)
        const result = this.#pairing.redeem(body?.code, body?.name)
        if (result.ok) {
          this.#log?.info?.(
            `[dsh-mobile-connect] 新设备已配对：${result.device.name}。当前共 ${this.#pairing.deviceCount} 台。`,
          )
          return send(200, {
            ok: true,
            token: result.token,
            // The phone needs the LAN authority to build absolute URLs, and it
            // is the only place that knows which interface the phone reached.
            host: req.headers.host ?? '',
          })
        }
        const messages = {
          'no-code': '桌面端当前没有配对码。请在桌面端运行 dsh-mobile-connect 生成。',
          expired: '配对码已过期。请在桌面端重新生成。',
          locked: '配对码已因多次输错作废。请在桌面端重新生成。',
          mismatch: '配对码不正确，请核对后重试。',
        }
        // 429 for a burned code: retrying will not help until the desktop acts.
        const status = result.reason === 'locked' ? 429 : 401
        return send(status, { ok: false, reason: result.reason, message: messages[result.reason] })
      }

      default:
        return send(404, { ok: false, message: 'not found' })
    }
  }
}

/**
 * Read a small JSON body, tolerating an empty or malformed one.
 *
 * An oversized body is *drained, not abandoned*. Returning early from inside a
 * `for await` loop invokes the iterator's `return()`, which destroys the
 * readable; Node can then never reach the end of the request body, so the
 * socket is never closed and a client that keeps writing holds a connection
 * open indefinitely. Since this endpoint is reachable without pairing, that is
 * a remote socket-exhaustion path. Consuming the remainder costs nothing —
 * the body is already bounded by the caller's limit in spirit, and a caller
 * that wants to refuse early should check `content-length` before we get here.
 *
 * @returns the parsed body, or undefined when absent, oversized, or malformed.
 */
async function readJsonBody(req, limit = PAIR_BODY_LIMIT) {
  const chunks = []
  let size = 0
  let oversized = false
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      // Stop retaining, but keep consuming so the stream ends normally.
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
