/**
 * Request trust fence for the plugin's own HTTP surface.
 *
 * `webServer` dispatch is longest-prefix-wins, and this plugin registers
 * `/api/dsh-mobile-connect` — a longer prefix than the kernel's `/api`. Without
 * a fence of its own these routes would run *before* the connection service's
 * admission check and would therefore answer any caller that can reach the
 * loopback port, including one that the app itself would refuse.
 *
 * Two layers, tried in order:
 *
 * 1. the composition's own `connection` service when present — the exact
 *    admission decision the kernel applies to its `/api` routes (trust fence
 *    plus browser-auth cookie), so this plugin is never weaker than the app;
 * 2. a structural replica of that fence for compositions without the service:
 *    loopback host only, no cross-site fetches, and an `Origin`/`Referer` that
 *    matches the `Host` authority whenever the client supplies one.
 *
 * Note what this fence does *not* protect: the routes it guards expose the
 * pairing code to anyone already admitted to the app, which is the same audience
 * the terminal panel addresses. The LAN gateway in `gateway.js` has its own,
 * separate device-token gate and is unaffected by this module.
 *
 * @module dsh-mobile-connect/trust
 */

/** Hostnames a same-machine caller can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/**
 * Decide one request.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object|undefined} connection - the harness `connection` service, when the composition mounts one
 * @returns {number|undefined} an HTTP status to reject with, or `undefined` to let the handler run
 */
export function rejectionFor(req, connection) {
  if (connection && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(req)
      if (admission && typeof admission === 'object' && 'rejection' in admission) {
        return admission.rejection
      }
      return undefined
    } catch {
      // A connection service that throws is a composition bug; fall through to
      // the structural fence rather than answering 500 for every request.
    }
  }
  return structuralRejection(req)
}

/**
 * The replica fence. Same shape as the kernel's own API admission: DNS
 * rebinding defence via the `Host` header, cross-site fetch refusal, and an
 * `Origin`/`Referer` authority match.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {number|undefined}
 */
export function structuralRejection(req) {
  const host = authorityOf(req.headers.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403

  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 403

  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const authority = authorityOf(raw.trim())
    if (authority === null) return 403
    // The web server speaks plain http on a loopback bind, so an Origin that
    // claims https — or any other scheme — is not this page.
    if (
      authority.scheme !== host.scheme ||
      authority.hostname !== host.hostname ||
      authority.port !== host.port
    ) {
      return 403
    }
  }
  return undefined
}

/**
 * Split a Host/Origin/Referer value into `{ scheme, hostname, port }`.
 *
 * @param {unknown} value
 * @param {'http'|'https'} [defaultScheme]
 * @returns {{ scheme: string, hostname: string, port: string }|null}
 */
function authorityOf(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}
