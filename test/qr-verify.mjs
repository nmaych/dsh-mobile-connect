#!/usr/bin/env node
/**
 * qr-verify.mjs — cross-check lib/qr.js against the segno reference encoder.
 *
 * For every (test string, error correction level) pair this script:
 *   1. encodes with lib/qr.js,
 *   2. encodes the identical string with segno (Python) at the same level,
 *   3. compares the two matrices module by module, plus the chosen version,
 *      mask, and symbol size,
 *   4. checks that the SVG and terminal renderers agree with the matrix.
 *
 * Exits non-zero if any case fails.
 *
 * Usage:
 *   node test/qr-verify.mjs            # full run
 *   node test/qr-verify.mjs --quick    # fewer cases, faster
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encode, encodeDetails, toTerminal, toSvg } from '../lib/qr.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const PYTHON =
  process.env.QR_VERIFY_PYTHON ||
  'C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const SEGNO_HELPER = path.join(HERE, 'segno-matrix.py');

/**
 * Scratch directory for this run.
 *
 * A unique directory per run keeps concurrent or overlapping runs from
 * clobbering each other's request/response files, and keeps the child-process
 * stdout redirection files alive for the whole run. It lives in the OS temp
 * area rather than the repository, because the workspace may be cleaned by
 * other tooling while a long verification run is in flight.
 */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-verify-'));

process.on('exit', () => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const QUICK = process.argv.includes('--quick');
const EXHAUSTIVE = process.argv.includes('--exhaustive');
const FUZZ_COUNT = (() => {
  const arg = process.argv.find((a) => a.startsWith('--fuzz='));
  if (arg) return Number(arg.slice('--fuzz='.length));
  return process.argv.includes('--fuzz') ? 150 : 0;
})();

// ---------------------------------------------------------------------------
// Test corpus
// ---------------------------------------------------------------------------

/** Build a URL of roughly `n` characters. */
function longUrl(n) {
  const base = 'http://192.168.1.5:19387/';
  let s = base;
  let i = 0;
  while (s.length < n - 8) s += `${(i++).toString(36).padStart(4, '0')}`;
  return s.slice(0, n);
}

/** Deterministic pseudo-random ASCII string. */
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

const CASES = [
  // --- the cases named in the task -----------------------------------------
  { name: 'pairing URL', text: 'http://192.168.1.5:19387/?code=123456' },
  { name: 'alphanumeric', text: 'HELLO WORLD' },
  { name: '200-char URL', text: longUrl(200) },
  { name: 'non-ASCII CJK', text: '配对码 123456' },

  // --- boundaries and edge cases -------------------------------------------
  { name: 'empty string', text: '' },
  { name: 'single byte', text: 'A' },
  { name: 'single digit', text: '7' },
  { name: 'lowercase only', text: 'hello' },
  { name: 'two chars', text: 'AB' },
  { name: 'numeric-ish', text: '0123456789' },
  { name: 'url short', text: 'https://a.co' },
  { name: 'emoji (4-byte UTF-8)', text: '🔐 scan me 🎉' },
  { name: 'combining + accents', text: 'café naïve Ångström' },
  { name: 'cyrillic', text: 'Привет, мир!' },
  { name: 'arabic RTL', text: 'رمز الاقتران ١٢٣' },
  { name: 'whitespace only', text: '   ' },
  { name: 'newlines + tabs', text: 'line1\nline2\ttabbed\r\n' },
  { name: 'json payload', text: '{"ssid":"IoT-2.4G","pass":"p@ss w0rd!#","v":1}' },
  { name: 'mixed latin + CJK', text: 'device-42 / 配对码 123456 / done' },

  // --- version-boundary probes (v1..v40 coverage) --------------------------
  { name: 'exact v1-M capacity', text: 'x'.repeat(14) },
  { name: 'v1-M overflow -> v2', text: 'x'.repeat(15) },
  { name: 'v9/v10 boundary (byte)', text: pseudoRandom(230, 7) },
  { name: 'v26/v27 boundary (byte)', text: pseudoRandom(1200, 11) },
  { name: 'v40-H max capacity', text: 'x'.repeat(1273) },
  { name: 'random 500 ASCII', text: pseudoRandom(500, 99) },
  { name: 'random 1200 ASCII', text: pseudoRandom(1200, 4242) },
  { name: 'long unicode', text: '配'.repeat(300) },
  { name: 'near-max lorem', text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(21) },
];

/**
 * Strings that exceed the capacity of a version-40 symbol at the given level.
 * Both encoders must reject them; we check that they agree.
 */
const OVERFLOW_CASES = [
  { name: 'v40-H overflow (1274 bytes)', text: 'x'.repeat(1274), ec: 'H' },
  { name: 'v40-Q overflow (1664 bytes)', text: 'x'.repeat(1664), ec: 'Q' },
  { name: 'v40-M overflow (2332 bytes)', text: 'x'.repeat(2332), ec: 'M' },
  { name: 'v40-L overflow (2954 bytes)', text: 'x'.repeat(2954), ec: 'L' },
];

/**
 * Randomly generated payloads of assorted lengths and alphabets, to shake out
 * edge cases that hand-written cases miss. Seeded so failures reproduce.
 */
function fuzzCases(count) {
  const alphabets = [
    'abcdefghijklmnopqrstuvwxyz',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 $%*+-./:',
    '0123456789',
    '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
    'αβγδεζηθικλμνξοπρστυφχψω',
    'абвгдежзийклмнопрстуфхцчшщ',
    '一二三四五六七八九十',
    '😀😁😂🤣😃😄😅😆',
  ];
  const cases = [];
  let state = 0xc0ffee;
  const rand = (n) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % n;
  };
  for (let i = 0; i < count; i++) {
    const alphabet = alphabets[rand(alphabets.length)];
    // Bias toward short payloads but include some large ones.
    const length = rand(3) === 0 ? 1 + rand(60) : 1 + rand(1500);
    let text = '';
    for (let k = 0; k < length; k++) {
      const ch = alphabet[rand(alphabet.length)];
      text += ch;
    }
    cases.push({ name: `fuzz#${i} (${alphabet.length} chars, len ${length})`, text });
  }
  return cases;
}

/**
 * Boundary probe for every version 1..40 at every level: a payload that just
 * fits the version, and one byte more (which must roll over to the next
 * version). Capacities are measured through the public API, so this exercises
 * version selection against segno's independent capacity tables.
 */
function boundaryCases() {
  const cases = [];
  for (let version = 1; version <= 40; version++) {
    for (const ec of LEVELS) {
      const capacity = byteCapacity(version, ec);
      if (capacity === null) continue;
      cases.push({
        name: `v${version}-${ec} exact fit (${capacity}B)`,
        text: pseudoRandom(capacity, version * 131 + ec.charCodeAt(0)),
        expectVersion: version,
      });
      if (version < 40) {
        cases.push({
          name: `v${version}-${ec} overflow (${capacity + 1}B)`,
          text: pseudoRandom(capacity + 1, version * 131 + ec.charCodeAt(0) + 7),
          expectVersion: version + 1,
        });
      }
    }
  }
  return cases;
}

/**
 * Largest payload (in bytes) that still encodes as `version` at `ec`.
 *
 * Measured black-box through the public API: `version` is monotonically
 * non-decreasing in the payload length, so a binary search finds the largest
 * length that does not spill into `version + 1`.
 */
function byteCapacity(version, ec) {
  // Returns Infinity once the payload no longer fits any symbol, so the search
  // treats "too large for version 40" as "larger than any version".
  const versionFor = (n) => {
    try {
      return encodeDetails('x'.repeat(n), { errorCorrection: ec }).version;
    } catch {
      return Infinity;
    }
  };
  if (versionFor(0) > version) return null;
  let lo = 0;
  let hi = 1;
  while (versionFor(hi) <= version) {
    lo = hi;
    hi *= 2;
    if (hi > 8000) break;
  }
  // Invariant: versionFor(lo) <= version < versionFor(hi).
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (versionFor(mid) <= version) lo = mid;
    else hi = mid;
  }
  return lo;
}

const LEVELS = ['L', 'M', 'Q', 'H'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a child process and return its stdout.
 *
 * The straightforward `execFileSync(..., { encoding: 'utf8' })` pipes stdout
 * through a named pipe. Under the DSH Windows sandbox that is denied with
 * EPERM, so on that specific failure we fall back to redirecting the child's
 * stdout to a real file descriptor and reading the file back. Both paths use
 * `child_process.execFileSync`; only the stdio wiring differs.
 */
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

  // The scratch directory may have been removed since the last run.
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outPath = path.join(TMP_DIR, 'qr-verify-segno.out');
  const errPath = path.join(TMP_DIR, 'qr-verify-segno.err');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  try {
    execFileSync(command, args, { stdio: ['ignore', outFd, errFd], windowsHide: true });
  } catch (err) {
    const stderr = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8') : '';
    err.stderr = stderr;
    err.message = `${err.message}\n${stderr}`;
    throw err;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return fs.readFileSync(outPath, 'utf8');
}

/** Run the segno helper in batch mode and parse its output. */
function segnoBatch(cases) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const requestPath = path.join(TMP_DIR, 'qr-verify-request.json');
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
      current = { rows: [], version: null, mask: null, size: null, overflow: false };
      results.push(current);
    } else if (!current) {
      continue;
    } else if (line === 'OVERFLOW') {
      current.overflow = true;
    } else if (line.startsWith('VERSION ')) {
      current.version = Number(line.slice(8));
    } else if (line.startsWith('MASK ')) {
      current.mask = Number(line.slice(5));
    } else if (line.startsWith('SIZE ')) {
      current.size = Number(line.slice(5));
    } else if (line === 'ROWS' || line === '') {
      // header / trailing newline
    } else {
      current.rows.push(line.split('').map((c) => c === '1'));
    }
  }
  return results;
}

/** Short human-readable label for a request (used in logs and failure dumps). */
function labelFor(req) {
  const shown = req.text.length > 40 ? `${req.text.slice(0, 37)}...` : req.text;
  return `${JSON.stringify(shown)} [${req.ec}]`;
}

/** Compare two boolean matrices; returns null when equal, else a description. */
function firstDifference(a, b) {
  if (a.length !== b.length) return `row count ${a.length} vs ${b.length}`;
  for (let y = 0; y < a.length; y++) {
    if (a[y].length !== b[y].length) return `row ${y} width ${a[y].length} vs ${b[y].length}`;
    for (let x = 0; x < a[y].length; x++) {
      if (a[y][x] !== b[y][x]) {
        return `module (x=${x}, y=${y}) ours=${a[y][x] ? 1 : 0} segno=${b[y][x] ? 1 : 0}`;
      }
    }
  }
  return null;
}

/** Count differing modules. */
function diffCount(a, b) {
  let n = 0;
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < a[y].length; x++) if (a[y][x] !== b[y][x]) n++;
  }
  return n;
}

/** ASCII-art the matrix, for failure diagnostics. */
function ascii(matrix, mark) {
  return matrix
    .map((row, y) =>
      row.map((v, x) => (mark && mark(y, x) ? 'X' : v ? '#' : '.')).join(''),
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// Renderer self-checks
// ---------------------------------------------------------------------------

/** Verify toTerminal packs two matrix rows per line and honours the quiet zone. */
function checkTerminal(matrix, quietZone = 2) {
  const text = toTerminal(matrix, { quietZone });
  const lines = text.split('\n');
  const expectedLines = Math.ceil((matrix.length + quietZone * 2) / 2);
  if (lines.length !== expectedLines) {
    return `line count ${lines.length} != ${expectedLines}`;
  }
  const width = matrix[0].length + quietZone * 2;
  for (const line of lines) {
    // Every glyph must be exactly one cell wide.
    if ([...line].length !== width) return `line width ${[...line].length} != ${width}`;
  }
  // Reconstruct the module grid from the half blocks and compare.
  const size = matrix.length;
  const grid = [];
  for (const line of lines) {
    const top = [];
    const bottom = [];
    for (const ch of line) {
      top.push(ch === '█' || ch === '▀');
      bottom.push(ch === '█' || ch === '▄');
    }
    grid.push(top, bottom);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const got = grid[y + quietZone][x + quietZone];
      if (got !== matrix[y][x]) return `terminal round-trip mismatch at (x=${x}, y=${y})`;
    }
  }
  // Quiet zone must be entirely light.
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const inside =
        i >= quietZone && i < quietZone + size && j >= quietZone && j < quietZone + size;
      if (!inside && grid[i][j]) return `quiet zone not light at (row=${i}, col=${j})`;
    }
  }
  return null;
}

/** Verify toSvg geometry: viewBox, size, and one path rect per dark run. */
function checkSvg(matrix, quietZone = 4, scale = 4) {
  const svg = toSvg(matrix, { quietZone, scale });
  if (!svg.startsWith('<?xml')) return 'missing XML declaration';
  if (!svg.trimEnd().endsWith('</svg>')) return 'missing closing </svg>';
  const size = matrix.length;
  const expected = (size + quietZone * 2) * scale;
  if (!svg.includes(`width="${expected}"`) || !svg.includes(`height="${expected}"`)) {
    return `expected width/height ${expected}`;
  }
  if (!svg.includes(`viewBox="0 0 ${expected} ${expected}"`)) return 'viewBox mismatch';

  // Parse the path back into a module grid and compare with the matrix.
  const d = /<path d="([^"]*)"/.exec(svg);
  if (!d) return 'no <path> element';
  const grid = Array.from({ length: size + quietZone * 2 }, () =>
    new Array(size + quietZone * 2).fill(false),
  );
  const re = /M(-?[\d.]+) (-?[\d.]+)h(-?[\d.]+)v(-?[\d.]+)h(-?[\d.]+)z/g;
  let m;
  let runs = 0;
  while ((m = re.exec(d[1])) !== null) {
    runs++;
    const x0 = Number(m[1]) / scale;
    const y0 = Number(m[2]) / scale;
    const w = Number(m[3]) / scale;
    const h = Number(m[4]) / scale;
    if (h !== 1) return `run height ${h} != 1`;
    for (let i = 0; i < w; i++) {
      if (grid[y0][x0 + i]) return `overlapping runs at (row=${y0}, col=${x0 + i})`;
      grid[y0][x0 + i] = true;
    }
  }
  if (runs === 0 && matrix.some((r) => r.some(Boolean))) return 'no dark runs emitted';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (grid[y + quietZone][x + quietZone] !== matrix[y][x]) {
        return `SVG round-trip mismatch at (x=${x}, y=${y})`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(PYTHON)) {
    console.error(`FATAL: python interpreter not found at ${PYTHON}`);
    console.error('Set QR_VERIFY_PYTHON to override.');
    return 2;
  }
  if (!fs.existsSync(SEGNO_HELPER)) {
    console.error(`FATAL: segno helper not found at ${SEGNO_HELPER}`);
    return 2;
  }

  const activeCases = QUICK ? CASES.slice(0, 8) : CASES;

  // Build the full (case, level) matrix of requests, then ask segno once.
  const requests = [];
  for (const c of activeCases) for (const ec of LEVELS) requests.push({ ...c, ec });
  if (!QUICK) for (const c of OVERFLOW_CASES) requests.push({ ...c, overflowProbe: true });
  if (EXHAUSTIVE) {
    for (const c of boundaryCases()) {
      requests.push({ ...c, ec: c.name.match(/-(L|M|Q|H) /)[1] });
    }
  }
  if (FUZZ_COUNT > 0) {
    for (const c of fuzzCases(FUZZ_COUNT)) for (const ec of LEVELS) requests.push({ ...c, ec });
  }

  console.log('QR encoder verification against segno');
  console.log(`  cases: ${activeCases.length} strings x ${LEVELS.length} levels = ${requests.length} symbols`);
  if (!QUICK) console.log(`  including ${OVERFLOW_CASES.length} expected-overflow probes`);
  if (EXHAUSTIVE) console.log('  including a version-boundary probe for every version 1..40 x L/M/Q/H');
  if (FUZZ_COUNT > 0) console.log(`  including ${FUZZ_COUNT} random fuzz payloads x L/M/Q/H`);
  console.log(`  python: ${PYTHON}`);
  console.log('');

  let reference;
  try {
    reference = segnoBatch(requests);
  } catch (err) {
    console.error('FATAL: segno reference run failed');
    console.error(err.stderr ? String(err.stderr) : String(err));
    return 2;
  }
  if (reference.length !== requests.length) {
    console.error(`FATAL: segno returned ${reference.length} of ${requests.length} cases`);
    return 2;
  }

  let passed = 0;
  const failures = [];
  const maskMismatches = [];
  const versionMismatches = [];
  const versionsSeen = new Set();
  const masksSeen = new Set();

  requests.forEach((req, i) => {
    const label = labelFor(req);
    const ref = reference[i];

    let details;
    try {
      details = encodeDetails(req.text, { errorCorrection: req.ec });
    } catch (err) {
      // Both encoders must agree on which inputs are simply too large.
      if (ref.overflow) {
        passed++;
        console.log(`PASS ${label} both encoders reject (data too large)`);
      } else {
        failures.push({ label, reason: `our encoder threw: ${err.message}` });
        console.log(`FAIL ${label}: our encoder threw: ${err.message}`);
      }
      return;
    }

    if (ref.overflow) {
      const reason = 'segno rejects as too large but our encoder produced a symbol';
      failures.push({ label, reason });
      console.log(`FAIL ${label}: ${reason}`);
      return;
    }

    const ours = details.matrix;
    const refMatrix = ref.rows;
    versionsSeen.add(details.version);
    masksSeen.add(details.mask);

    const problems = [];

    if (req.expectVersion !== undefined && details.version !== req.expectVersion) {
      problems.push(`expected version ${req.expectVersion} for this payload length`);
    }
    if (details.size !== ref.size) problems.push(`size ${details.size} vs segno ${ref.size}`);
    if (details.version !== ref.version) {
      problems.push(`version ${details.version} vs segno ${ref.version}`);
      versionMismatches.push({ label, ours: details.version, segno: ref.version });
    }
    if (details.mask !== ref.mask) {
      problems.push(`mask ${details.mask} vs segno ${ref.mask}`);
      maskMismatches.push({ label, ours: details.mask, segno: ref.mask });
    }

    const diff = firstDifference(ours, refMatrix);
    if (diff) {
      const n = diffCount(ours, refMatrix);
      problems.push(`matrix differs: ${diff} (${n} module(s) differ)`);
    }

    const terminalProblem = checkTerminal(ours);
    if (terminalProblem) problems.push(`toTerminal: ${terminalProblem}`);
    const svgProblem = checkSvg(ours);
    if (svgProblem) problems.push(`toSvg: ${svgProblem}`);

    if (problems.length === 0) {
      passed++;
      console.log(`PASS ${label} v${details.version} mask ${details.mask} ${details.size}x${details.size}`);
    } else {
      failures.push({ label, reason: problems.join('; ') });
      console.log(`FAIL ${label}`);
      for (const p of problems) console.log(`       - ${p}`);
      if (diff) {
        const mark = (y, x) => ours[y][x] !== refMatrix[y]?.[x];
        console.log('       ours:');
        console.log(ascii(ours, mark).split('\n').map((l) => `         ${l}`).join('\n'));
        console.log('       segno:');
        console.log(ascii(refMatrix, mark).split('\n').map((l) => `         ${l}`).join('\n'));
      }
    }
  });

  console.log('');
  console.log('--- summary -------------------------------------------------');
  console.log(`  passed: ${passed} / ${requests.length}`);
  console.log(`  failed: ${failures.length}`);
  console.log(`  versions exercised: ${[...versionsSeen].sort((a, b) => a - b).join(', ')}`);
  console.log(`  masks exercised: ${[...masksSeen].sort((a, b) => a - b).join(', ')}`);
  console.log(`  version mismatches: ${versionMismatches.length}`);
  console.log(`  mask mismatches: ${maskMismatches.length}`);
  for (const m of maskMismatches) console.log(`    mask: ${m.label} ours=${m.ours} segno=${m.segno}`);
  for (const m of versionMismatches) {
    console.log(`    version: ${m.label} ours=${m.ours} segno=${m.segno}`);
  }

  if (failures.length > 0) {
    // Persist the exact failing inputs so they can be replayed and debugged.
    // This lives in the workspace (not the scratch dir) so it survives the run.
    const dumpPath = path.join(WORKSPACE, 'qr-verify-failures.json');
    const failedLabels = new Set(failures.map((f) => f.label));
    fs.writeFileSync(
      dumpPath,
      JSON.stringify(
        requests
          .filter((req) => failedLabels.has(labelFor(req)))
          .map((req) => ({
            name: req.name ?? null,
            ec: req.ec,
            text: req.text,
            expectVersion: req.expectVersion ?? null,
          })),
        null,
        2,
      ),
      'utf8',
    );
    console.log('');
    console.log(`Failing inputs written to ${dumpPath}`);
    console.log('');
    console.log('FAILURES:');
    for (const f of failures) console.log(`  - ${f.label}: ${f.reason}`);
    console.log('');
    console.log('RESULT: FAIL');
    return 1;
  }
  console.log('');
  console.log('RESULT: PASS (all symbols byte-identical to segno)');
  return 0;
}

process.exit(main());
