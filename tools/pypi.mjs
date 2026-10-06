// Resolve a PyPI wheel URL for a pure-Python package, using Node's TLS stack.
// usage: node pypi.mjs <package> [destDir]
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const pkg = process.argv[2]
const destDir = process.argv[3] || '.'

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'node' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        return resolve(get(new URL(res.headers.location, url).toString()))
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}

const meta = JSON.parse((await get(`https://pypi.org/pypi/${pkg}/json`)).toString())
const version = meta.info.version
// Prefer a py3-none-any wheel: pure Python, no build step.
const files = meta.releases[version]
const wheel = files.find((f) => f.filename.endsWith('-py3-none-any.whl')) || files.find((f) => f.filename.endsWith('.whl'))
if (!wheel) { console.error('no wheel found'); process.exit(1) }

console.log(`${pkg} ${version} -> ${wheel.filename}`)
const buf = await get(wheel.url)
fs.mkdirSync(destDir, { recursive: true })
const out = path.join(destDir, wheel.filename)
fs.writeFileSync(out, buf)
console.log(`saved ${out} (${(buf.length / 1024).toFixed(0)} KB)`)
console.log('WHEEL=' + out)
