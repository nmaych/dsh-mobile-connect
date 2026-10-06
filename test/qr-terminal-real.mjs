// Decode the ACTUAL terminal QR output the plugin prints, using a real decoder.
//
// The earlier round-trip test rebuilt a bitmap from the half-block characters
// and decoded that. This does something closer to reality: it draws the real
// terminal output as a terminal emulator would, then hands the image to ZXing.
//
// NOTE ON STYLE: the child process communicates through files, not stdio.
// Capturing a child's output over a pipe is blocked in this environment
// (EPERM), so Python is spawned with stdio ignored and writes its answer to a
// file that this script then reads.
import { encode, toTerminal } from '../lib/qr.js'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PY = 'C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'
const LIBS = 'E:\\deepseekworkspace\\dsh-mobile-connect\\.pylibs-decoders'

/** The exact URL shape the plugin puts in the QR. */
const URLS = [
  'dshmobile://pair?host=192.168.1.5&port=19387&code=021088',
  'dshmobile://pair?host=10.0.0.42&port=19387&code=998877',
  'http://192.168.3.103:19387/?code=147293',
]

/** Draw a terminal rendering and decode it. Writes results to `outPath`. */
const SCRIPT = `
import sys, json
sys.path.insert(0, r'${LIBS}')
from PIL import Image, ImageDraw
import zxingcpp

spec_path, out_path = sys.argv[1], sys.argv[2]
with open(spec_path, encoding='utf-8') as f:
    spec = json.load(f)

rows = spec['rows']
scale = spec.get('scale', 2)
FULL, UPPER, LOWER = '\\u2588', '\\u2580', '\\u2584'

cw = 2 * scale
ch = 2 * scale
width = max(len(r) for r in rows) * cw
height = len(rows) * ch

img = Image.new('L', (width, height), 255)
d = ImageDraw.Draw(img)

for y, line in enumerate(rows):
    for x, g in enumerate(line):
        if g == ' ':
            continue
        px, py = x * cw, y * ch
        if g == FULL:
            d.rectangle([px, py, px + cw - 1, py + ch - 1], fill=0)
        elif g == UPPER:
            d.rectangle([px, py, px + cw - 1, py + scale - 1], fill=0)
        elif g == LOWER:
            d.rectangle([px, py + scale, px + cw - 1, py + ch - 1], fill=0)

# Upscale, as a terminal at a readable size would look to a camera.
big = img.resize((width * 3, height * 3), Image.NEAREST)
res = zxingcpp.read_barcode(big)
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump({'text': res.text if res else None}, f)
`

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-term-'))
const scriptFile = path.join(tmpDir, 'decode.py')
fs.writeFileSync(scriptFile, SCRIPT, 'utf8')

const results = []
for (const [index, url] of URLS.entries()) {
  const terminal = toTerminal(encode(url, { errorCorrection: 'M' }))
  const rows = terminal.split('\n').filter((l) => l.length > 0)

  const specFile = path.join(tmpDir, `spec-${index}.json`)
  const outFile = path.join(tmpDir, `out-${index}.json`)
  fs.writeFileSync(specFile, JSON.stringify({ rows, scale: 2 }), 'utf8')
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile)

  // stdio is ignored: output is exchanged through files instead.
  const run = spawnSync(PY, [scriptFile, specFile, outFile], {
    stdio: 'ignore',
    timeout: 120000,
  })

  let decoded = null
  if (fs.existsSync(outFile)) {
    try {
      decoded = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    } catch (error) {
      decoded = { text: null, error: `bad output file: ${error.message}` }
    }
  } else {
    decoded = { text: null, error: `python exited ${run.status ?? '?'} without writing output` }
  }

  const ok = decoded.text === url
  results.push({ url, ok, decoded })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${url}`)
  if (!ok) console.log(`      ${JSON.stringify(decoded)}`)
}

console.log()
const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} terminal QR codes decoded by ZXing`)
process.exit(passed === results.length ? 0 : 1)
