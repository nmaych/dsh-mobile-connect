// Independently falsify the "decoder-limited, not our bug" excuse.
//
// The QR suite excuses a failure when ZXing also rejects segno's matrix for the
// same payload. That excuse is only honest if it is TRUE, so this checks it from
// outside the harness: build the empty-string symbol with segno, and with ours,
// confirm the matrices are identical, then confirm ZXing rejects BOTH.
import { encode, encodeDetails } from '../lib/qr.js'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PY = 'C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'
const LIBS = 'E:\\deepseekworkspace\\dsh-mobile-connect\\.pylibs-decoders'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-excuse-'))

const script = `
import sys, json
sys.path.insert(0, r'${LIBS}')
sys.path.insert(0, r'E:\\deepseekworkspace\\dsh-mobile-connect\\.pylibs')
import numpy as np
from PIL import Image
import zxingcpp

spec_path, out_path = sys.argv[1], sys.argv[2]
with open(spec_path, encoding='utf-8') as f:
    spec = json.load(f)

def to_image(rows, scale=8, quiet=4):
    n = len(rows)
    size = (n + quiet * 2) * scale
    img = Image.new('L', (size, size), 255)
    px = img.load()
    for y, row in enumerate(rows):
        for x, v in enumerate(row):
            if not v:
                continue
            for dy in range(scale):
                for dx in range(scale):
                    px[(x + quiet) * scale + dx, (y + quiet) * scale + dy] = 0
    return img

out = {}
# Ours
ours = to_image(spec['ours'])
r = zxingcpp.read_barcode(ours)
out['ours_zxing'] = r.text if r else None

# segno's, for the same payload and level.
#
# These flags must match test/segno-matrix.py exactly: qr.js always uses byte
# mode with UTF-8 and never picks Micro QR, so the reference has to be pinned
# the same way or the comparison is between two different encodings.
import segno
q = segno.make(spec['payload'], error=spec['level'], mode='byte', encoding='utf-8',
               micro=False, boost_error=False)
ref_rows = [[1 if v else 0 for v in row] for row in q.matrix]
out['identical'] = ref_rows == spec['ours']
out['ref_size'] = len(ref_rows)
out['ref_version'] = q.version
out['ref_mask'] = q.mask

ref = to_image(ref_rows)
r2 = zxingcpp.read_barcode(ref)
out['ref_zxing'] = r2.text if r2 else None

with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(out, f)
`

const scriptFile = path.join(tmp, 'check.py')
fs.writeFileSync(scriptFile, script, 'utf8')

let problems = 0

for (const [label, payload] of [
  ['empty string', ''],
  ['single space', ' '],
]) {
  const level = 'M'
  const details = encodeDetails(payload, { errorCorrection: level })
  const ours = details.matrix.map((row) => row.map((v) => (v ? 1 : 0)))

  const specFile = path.join(tmp, 'spec.json')
  const outFile = path.join(tmp, 'out.json')
  fs.writeFileSync(specFile, JSON.stringify({ payload, level, ours }), 'utf8')
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile)

  const run = spawnSync(PY, [scriptFile, specFile, outFile], { stdio: 'ignore', timeout: 120000 })
  if (!fs.existsSync(outFile)) {
    console.log(`SKIP  ${label}: python exited ${run.status ?? '?'} without output`)
    continue
  }
  const result = JSON.parse(fs.readFileSync(outFile, 'utf8'))

  console.log(`\n${label} (${level}):`)
  console.log(`  ours: ${details.size}x${details.size} v${details.version} mask ${details.mask}`)
  console.log(`  segno: ${result.ref_size}x${result.ref_size} v${result.ref_version} mask ${result.ref_mask}`)
  console.log(`  matrices identical to segno : ${result.identical}`)
  console.log(`  ZXing on ours               : ${JSON.stringify(result.ours_zxing)}`)
  console.log(`  ZXing on segno's            : ${JSON.stringify(result.ref_zxing)}`)

  const oursDecoded = result.ours_zxing === payload
  const refDecoded = result.ref_zxing === payload

  let verdict
  if (oursDecoded && refDecoded) {
    verdict = 'no excuse needed: ZXing decodes both correctly'
  } else if (result.identical === true && !oursDecoded && !refDecoded) {
    verdict = 'excuse VERIFIED: byte-identical to the reference, and ZXing rejects both'
  } else if (!result.identical) {
    verdict = 'PROBLEM: our matrix differs from the reference'
  } else if (!oursDecoded && refDecoded) {
    verdict = 'PROBLEM: the reference decodes where ours does not'
  } else {
    verdict = 'inconclusive'
  }
  console.log(`  => ${verdict}`)

  // Track whether any case left a claim unsupported.
  if (verdict.startsWith('PROBLEM')) problems += 1
}

console.log()
console.log('This check is independent of the QR harness: it re-derives the reference')
console.log('matrix from segno and re-runs ZXing, rather than trusting the harness tally.')
process.exit(problems === 0 ? 0 : 1)
