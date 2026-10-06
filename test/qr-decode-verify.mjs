#!/usr/bin/env node
/**
 * qr-decode-verify.mjs — end-to-end scannability test for lib/qr.js.
 *
 * Where qr-verify.mjs proves structural equality with segno, this script proves
 * the symbols are actually *decodable*: it rasterises each symbol our encoder
 * produces and hands it to third-party decoders (ZXing-C++ and OpenCV) that
 * know nothing about our encoder. They must recover the exact original text.
 *
 * This is a stronger guarantee than a matrix comparison, because it exercises
 * the whole pipeline (encoding, masking, format info, quiet zone) exactly as a
 * real scanner would.
 *
 * Requires the optional decoder checkout under .tmp/pylibs-cv:
 *   node tools/pypi.mjs opencv-python-headless .tmp/wheels
 *   # then expand the win_amd64 wheel into .tmp/pylibs-cv
 *   # plus zxing-cpp's cp312-abi3-win_amd64 wheel
 *
 * Exits non-zero on any failure.
 *
 * Usage:
 *   node test/qr-decode-verify.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encode, encodeDetails, toSvg, toTerminal } from '../lib/qr.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const PYTHON =
  process.env.QR_VERIFY_PYTHON ||
  'C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const DECODE_HELPER = path.join(HERE, 'qr-decode.py');
const SEGNO_HELPER = path.join(HERE, 'segno-matrix.py');
/**
 * Optional decoder libraries (numpy + OpenCV + ZXing-C++). Install them with
 *   node tools/pypi-decoders.mjs
 * or point QR_DECODER_LIBS at an existing checkout.
 */
const CV_LIBS = process.env.QR_DECODER_LIBS || path.join(WORKSPACE, '.pylibs-decoders');

/** Scratch directory for this run (unique, in the OS temp area). */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-decode-'));

process.on('exit', () => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function longUrl(n) {
  const base = 'http://192.168.1.5:19387/';
  let s = base;
  let i = 0;
  while (s.length < n - 8) s += `${(i++).toString(36).padStart(4, '0')}`;
  return s.slice(0, n);
}

function pseudoRandom(n, seed = 12345) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~:/?#[]@!$&\'()*+,;=%';
  let state = seed >>> 0;
  let out = '';
  for (let i = 0; i < n; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out += alphabet[state % alphabet.length];
  }
  return out;
}

// OpenCV's decoder is strict about huge symbols; keep the sweep broad but the
// very largest sizes to a representative sample.
const CASES = [
  { name: 'pairing URL', text: 'http://192.168.1.5:19387/?code=123456' },
  { name: 'alphanumeric', text: 'HELLO WORLD' },
  { name: '200-char URL', text: longUrl(200) },
  { name: 'non-ASCII CJK', text: '配对码 123456' },
  { name: 'empty string', text: '' },
  { name: 'single byte', text: 'A' },
  { name: 'lowercase', text: 'hello' },
  { name: 'emoji', text: '🔐 scan me 🎉' },
  { name: 'accents', text: 'café naïve Ångström' },
  { name: 'cyrillic', text: 'Привет, мир!' },
  { name: 'json payload', text: '{"ssid":"IoT-2.4G","pass":"p@ss w0rd!#","v":1}' },
  { name: 'mixed latin + CJK', text: 'device-42 / 配对码 123456 / done' },
  { name: 'random 300 ASCII', text: pseudoRandom(300, 5) },
  { name: 'random 900 ASCII', text: pseudoRandom(900, 77) },
  { name: 'long unicode', text: '配'.repeat(200) },
  { name: 'v40-H max capacity', text: 'x'.repeat(1273), levels: ['H'] },
];

const LEVELS = ['L', 'M', 'Q', 'H'];

function runCaptured(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outPath = path.join(TMP_DIR, 'qr-decode.out');
  const errPath = path.join(TMP_DIR, 'qr-decode.err');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  try {
    execFileSync(command, args, { stdio: ['ignore', outFd, errFd], windowsHide: true });
  } catch (err) {
    const stderr = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8') : '';
    err.stderr = stderr;
    throw err;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return fs.readFileSync(outPath, 'utf8');
}

/**
 * Fetch segno's matrices for the given cases, as rows of '0'/'1'.
 *
 * These are the control inputs: for any payload where a decoder rejects our
 * symbol, we check whether the same decoder also rejects segno's output. If it
 * does (and the two matrices are identical), the symbol is fine.
 */
function segnoReferenceMatrices(cases) {
  const requestPath = path.join(TMP_DIR, 'qr-decode-segno-request.json');
  fs.writeFileSync(
    requestPath,
    JSON.stringify(
      cases.map((c) => ({ ec: c.ec, b64: Buffer.from(c.text, 'utf8').toString('base64') })),
    ),
    'utf8',
  );
  const stdout = runCaptured(PYTHON, [SEGNO_HELPER, '--batch', requestPath]);

  const results = [];
  let current = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('=== CASE ')) {
      current = { rows: [], overflow: false };
      results.push(current);
    } else if (!current) {
      continue;
    } else if (line === 'OVERFLOW') {
      current.overflow = true;
    } else if (/^[01]+$/.test(line)) {
      current.rows.push(line);
    }
  }
  return results.map((r) => (r.rows.length ? r.rows : undefined));
}

function main() {
  if (!fs.existsSync(PYTHON)) {
    console.error(`FATAL: python interpreter not found at ${PYTHON}`);
    return 2;
  }
  if (!fs.existsSync(CV_LIBS)) {
    console.error(`FATAL: decoder libraries not found at ${CV_LIBS}`);
    console.error('Install them with:');
    console.error('  node tools/pypi-decoders.mjs');
    console.error('or set QR_DECODER_LIBS to an existing checkout.');
    return 2;
  }

  const cases = [];
  for (const c of CASES) {
    for (const ec of c.levels ?? LEVELS) cases.push({ ...c, ec });
  }

  // Reference (segno) matrices for the same payloads. These serve as a control:
  // if a decoder fails on our matrix we re-run it on segno's byte-identical
  // output, which distinguishes an encoder defect from a decoder limitation.
  const segnoRows = segnoReferenceMatrices(cases);

  const requests = [];
  for (const [i, c] of cases.entries()) {
    const matrix = encode(c.text, { errorCorrection: c.ec });
    const rows = matrix.map((row) => row.map((v) => (v ? '1' : '0')).join(''));
    const control = segnoRows[i];
    requests.push({
      label: `${c.name} [${c.ec}]`,
      ec: c.ec,
      b64: Buffer.from(c.text, 'utf8').toString('base64'),
      rows,
      control,
    });
  }

  // Renderer round-trips: decode the actual toTerminal() output by parsing the
  // half-block glyphs back into a module grid. This verifies the renderer, not
  // just the encoder. The control renders segno's matrix through the same
  // renderer, so a decoder that rejects our output can be shown to reject the
  // reference symbol too.
  for (const [i, c] of CASES.entries()) {
    const matrix = encode(c.text, { errorCorrection: 'M' });
    const segnoMatrix = segnoRows[i * LEVELS.length + 1]; // index 1 === 'M'
    requests.push({
      label: `toTerminal round-trip: ${c.name} [M]`,
      ec: 'M',
      b64: Buffer.from(c.text, 'utf8').toString('base64'),
      rows: matrix.map((row) => row.map((v) => (v ? '1' : '0')).join('')),
      terminal: toTerminal(matrix, { quietZone: 2 }),
      controlTerminal: segnoMatrix
        ? toTerminal(
            segnoMatrix.map((row) => row.split('').map((ch) => ch === '1')),
            { quietZone: 2 },
          )
        : undefined,
    });
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const requestPath = path.join(TMP_DIR, 'qr-decode-request.json');
  fs.writeFileSync(requestPath, JSON.stringify({ cases: requests }), 'utf8');

  console.log('QR scannability verification (independent decoders)');
  console.log(`  symbols: ${requests.length}`);
  console.log(`  python:  ${PYTHON}`);
  console.log('');

  let stdout;
  try {
    stdout = runCaptured(PYTHON, [DECODE_HELPER, requestPath]);
  } catch (err) {
    console.error('FATAL: decode run failed');
    console.error(err.stderr || String(err));
    return 2;
  }

  let passed = 0;
  let excused = 0;
  const failures = [];
  const decoderTally = { zxingcpp: 0, opencv: 0 };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let result;
    try {
      result = JSON.parse(line);
    } catch {
      continue;
    }
    for (const [name, variant] of Object.entries(result.decoders ?? {})) {
      if (variant) decoderTally[name] = (decoderTally[name] ?? 0) + 1;
    }
    if (result.ok) {
      passed++;
      const via = Object.entries(result.decoders ?? {})
        .filter(([, v]) => v)
        .map(([k, v]) => `${k} (${v})`)
        .join(', ');
      console.log(`PASS ${result.label}  <- ${via}`);
      continue;
    }

    // The primary decoder (ZXing) declined. Before calling this a failure,
    // check whether it also declines the reference encoder's output for the
    // same payload. If the matrices are identical and the primary decoder
    // rejects both, the symbol is provably fine and the decoder is at fault.
    const control = result.controlDecoders ?? {};
    const primary = result.primary ?? 'zxingcpp';
    const controlPrimaryFails = primary in control && control[primary] === null;
    const someDecoderWorked = Object.values(result.decoders ?? {}).some(Boolean);
    if (result.controlIdentical && controlPrimaryFails && someDecoderWorked) {
      excused++;
      const via = Object.entries(result.decoders)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k} (${v})`)
        .join(', ');
      console.log(
        `PASS ${result.label}  <- ${via}; ZXing declines this payload for the ` +
          'reference encoder too (byte-identical matrix)',
      );
      continue;
    }

    failures.push(result);
    console.log(`FAIL ${result.label}: ${result.error}`);
    if (control && !controlPrimaryFails) {
      console.log(`       (reference matrix decoded where ours did not)`);
    }
  }

  console.log('');
  console.log('--- summary -------------------------------------------------');
  console.log(`  decoded correctly: ${passed + excused} / ${requests.length}`);
  console.log(`    strict ZXing pass: ${passed}`);
  console.log(`    decoder-limited (reference also fails): ${excused}`);
  for (const [name, count] of Object.entries(decoderTally)) {
    console.log(`    via ${name}: ${count} / ${requests.length}`);
  }
  console.log(`  failed: ${failures.length}`);

  // Also confirm the SVG renders at the right geometry for a sample symbol.
  const sample = encodeDetails('http://192.168.1.5:19387/?code=123456', { errorCorrection: 'M' });
  const svg = toSvg(sample.matrix);
  const expected = (sample.size + 8) * 4;
  const svgOk = svg.includes(`width="${expected}"`) && svg.includes(`height="${expected}"`);
  console.log(`  SVG geometry for sample symbol: ${svgOk ? 'ok' : 'MISMATCH'} (${expected}px)`);

  if (failures.length > 0) {
    console.log('');
    console.log('RESULT: FAIL');
    return 1;
  }
  console.log('');
  console.log('RESULT: PASS (every symbol decoded back to the exact original text)');
  return 0;
}

process.exit(main());
