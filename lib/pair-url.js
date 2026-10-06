/**
 * The one place that decides what a phone is told.
 *
 * Two surfaces show the same thing now — the terminal panel and the in-app GUI —
 * and the QR code encodes whatever the deep link says. Deriving the address and
 * the link in two places is exactly how a GUI ends up displaying a code the QR
 * does not carry, so both callers go through these helpers.
 *
 * @module dsh-mobile-connect/pair-url
 */

/**
 * The HTTP base a phone should open.
 *
 * @param {{ host: string, port: number }} options
 * @returns {string}
 */
export function baseUrlFor({ host, port }) {
  return `http://${host}:${port}`
}

/**
 * The deep link the QR code carries.
 *
 * A dedicated scheme so scanning opens DSH Mobile rather than a browser: the app
 * registers `dshmobile://pair` in its manifest, so the user never retypes the
 * address or the code.
 *
 * @param {{ host: string, port: number, code: string }} options
 * @returns {string}
 */
export function pairUrlFor({ host, port, code }) {
  return `dshmobile://pair?host=${encodeURIComponent(host)}&port=${port}&code=${code}`
}
