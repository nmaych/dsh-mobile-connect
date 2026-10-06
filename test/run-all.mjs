/**
 * Run every offline test suite in one go.
 *
 * The live suites (`e2e-live`, `transparency`) need a running Harness and are
 * invoked separately — see the README.
 *
 * usage: node test/run-all.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const suites = [
  ['pairing', 'pairing.test.mjs', '配对逻辑：配对码、设备令牌、限流、持久化'],
  ['gateway', 'gateway.test.mjs', '网关：代理、Host 改写、Cookie 注入、WebSocket 隧道'],
  ['qr-unit', 'qr-unit.test.mjs', '二维码 API 契约与渲染器单元测试'],
  ['qr-matrix', 'qr-verify.mjs', '二维码矩阵：与参考实现逐模块比对'],
  ['qr-terminal', 'qr-terminal-real.mjs', '二维码终端渲染：交给真实解码器扫描'],
]

/**
 * Extra QR suite that needs the optional Python decoders installed by
 * tools/pypi-decoders.mjs. Skipped (not failed) when they are missing, so
 * offline runs stay green.
 */
const optionalSuites = [
  ['qr-decode', 'qr-decode-verify.mjs', '二维码：真实解码器端到端可扫描性验证', '.pylibs-decoders'],
  ['qr-excuse', 'qr-excuse-check.mjs', '二维码：独立复核"解码器局限"的豁免是否成立', '.pylibs-decoders'],
]

const results = []
for (const [name, file, description] of suites) {
  console.log(`\n${'='.repeat(64)}`)
  console.log(`${name} — ${description}`)
  console.log('='.repeat(64))
  const run = spawnSync(process.execPath, [path.join(here, file)], {
    stdio: 'inherit',
    cwd: path.join(here, '..'),
  })
  results.push({ name, code: run.status ?? 1 })
}

for (const [name, file, description, requirement] of optionalSuites) {
  console.log(`\n${'='.repeat(64)}`)
  console.log(`${name} — ${description}`)
  console.log('='.repeat(64))
  if (!existsSync(path.join(here, '..', requirement))) {
    console.log('SKIP — run "node tools/pypi-decoders.mjs" to enable this suite')
    continue
  }
  const run = spawnSync(process.execPath, [path.join(here, file)], {
    stdio: 'inherit',
    cwd: path.join(here, '..'),
  })
  results.push({ name, code: run.status ?? 1 })
}

console.log(`\n${'='.repeat(64)}`)
console.log('SUMMARY')
console.log('='.repeat(64))
for (const { name, code } of results) {
  console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${name}`)
}
const failed = results.filter((r) => r.code !== 0)
console.log(`\n${results.length - failed.length}/${results.length} suites passed`)
process.exit(failed.length > 0 ? 1 : 0)
