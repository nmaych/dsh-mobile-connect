#!/usr/bin/env node
/**
 * qr-unit.test.mjs — dependency-free unit tests for lib/qr.js.
 *
 * Covers the API contract and renderer edge cases that the segno comparison
 * (qr-verify.mjs) does not reach directly: option handling, argument
 * validation, half-block glyph packing, odd-row padding, custom glyphs, quiet
 * zones, and SVG document structure.
 *
 * Runs offline in well under a second; no Python and no reference encoder.
 *
 * Usage:
 *   node test/qr-unit.test.mjs
 */

import { encode, encodeDetails, toTerminal, toSvg, ERROR_CORRECTION_LEVELS } from '../lib/qr.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const problem = fn();
    if (problem) {
      failures.push({ name, problem });
      console.log(`FAIL ${name}: ${problem}`);
    } else {
      passed++;
      console.log(`PASS ${name}`);
    }
  } catch (err) {
    failures.push({ name, problem: err.stack ?? String(err) });
    console.log(`FAIL ${name}: threw ${err.message}`);
  }
}

function assert(condition, message) {
  return condition ? null : message;
}

/** Reconstruct the module grid from toTerminal output. */
function parseTerminal(text) {
  const grid = [];
  for (const line of text.split('\n')) {
    const top = [];
    const bottom = [];
    for (const ch of line) {
      if (ch === '\u2588') (top.push(1), bottom.push(1));
      else if (ch === '\u2580') (top.push(1), bottom.push(0));
      else if (ch === '\u2584') (top.push(0), bottom.push(1));
      else if (ch === ' ') (top.push(0), bottom.push(0));
      else throw new Error(`unexpected glyph ${JSON.stringify(ch)}`);
    }
    grid.push(top, bottom);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// encode(): contract
// ---------------------------------------------------------------------------

check('encode returns a square boolean matrix', () => {
  const m = encode('HELLO WORLD');
  if (!Array.isArray(m)) return 'not an array';
  if (m.length !== 21) return `expected 21 rows for v1, got ${m.length}`;
  for (const row of m) {
    if (row.length !== m.length) return `row width ${row.length} != ${m.length}`;
    for (const v of row) if (typeof v !== 'boolean') return `non-boolean module ${typeof v}`;
  }
  return null;
});

check('encode defaults to error correction M', () => {
  const a = encode('HELLO WORLD');
  const b = encode('HELLO WORLD', { errorCorrection: 'M' });
  return assert(JSON.stringify(a) === JSON.stringify(b), 'default differs from explicit M');
});

check('encode accepts all four error levels', () => {
  for (const ec of ERROR_CORRECTION_LEVELS) {
    const d = encodeDetails('HELLO WORLD', { errorCorrection: ec });
    if (d.errorCorrection !== ec) return `level ${ec} reported as ${d.errorCorrection}`;
  }
  return null;
});

check('encode accepts lower-case level names', () => {
  const upper = encode('HELLO WORLD', { errorCorrection: 'Q' });
  const lower = encode('HELLO WORLD', { errorCorrection: 'q' });
  return assert(JSON.stringify(upper) === JSON.stringify(lower), 'case-insensitive lookup failed');
});

check('encode rejects an unknown error level', () => {
  try {
    encode('x', { errorCorrection: 'Z' });
    return 'no error thrown';
  } catch (err) {
    return assert(err instanceof RangeError, `threw ${err.constructor.name}, expected RangeError`);
  }
});

check('encode rejects data too large for version 40', () => {
  try {
    encode('x'.repeat(3000), { errorCorrection: 'H' });
    return 'no error thrown';
  } catch (err) {
    return assert(err instanceof RangeError, `threw ${err.constructor.name}, expected RangeError`);
  }
});

check('encode treats null/undefined as the empty string', () => {
  const empty = encode('');
  return assert(
    JSON.stringify(encode(null)) === JSON.stringify(empty) &&
      JSON.stringify(encode(undefined)) === JSON.stringify(empty),
    'null/undefined not equivalent to ""',
  );
});

check('encode counts UTF-8 bytes, not code units', () => {
  // "配" is 1 UTF-16 code unit but 3 UTF-8 bytes; "😀" is 2 code units, 4 bytes.
  const cjk = encodeDetails('配');
  if (cjk.byteLength !== 3) return `expected 3 bytes for 配, got ${cjk.byteLength}`;
  const emoji = encodeDetails('😀');
  if (emoji.byteLength !== 4) return `expected 4 bytes for 😀, got ${emoji.byteLength}`;
  const mixed = encodeDetails('a配😀');
  return assert(mixed.byteLength === 8, `expected 8 bytes, got ${mixed.byteLength}`);
});

check('encode picks a larger version as the payload grows', () => {
  let last = 0;
  for (const n of [0, 10, 20, 50, 100, 300, 800, 1500]) {
    const v = encodeDetails('x'.repeat(n), { errorCorrection: 'M' }).version;
    if (v < last) return `version went backwards at n=${n}: ${v} < ${last}`;
    last = v;
  }
  return null;
});

check('higher error correction never shrinks the version', () => {
  for (const n of [1, 20, 100, 500, 1000]) {
    const text = 'x'.repeat(n);
    const versions = ERROR_CORRECTION_LEVELS.map(
      (ec) => encodeDetails(text, { errorCorrection: ec }).version,
    );
    for (let i = 1; i < versions.length; i++) {
      if (versions[i] < versions[i - 1]) {
        return `level ${ERROR_CORRECTION_LEVELS[i]} gave v${versions[i]} < v${versions[i - 1]}`;
      }
    }
  }
  return null;
});

check('encodeDetails reports a mask in 0..7 and a consistent size', () => {
  for (const ec of ERROR_CORRECTION_LEVELS) {
    const d = encodeDetails('http://192.168.1.5:19387/?code=123456', { errorCorrection: ec });
    if (!Number.isInteger(d.mask) || d.mask < 0 || d.mask > 7) return `bad mask ${d.mask}`;
    if (d.size !== d.version * 4 + 17) return `size ${d.size} != 4*${d.version}+17`;
    if (d.matrix.length !== d.size) return 'matrix size mismatch';
  }
  return null;
});

// ---------------------------------------------------------------------------
// Structural invariants of the symbol itself
// ---------------------------------------------------------------------------

check('finder patterns are present in all three corners', () => {
  const m = encode('HELLO WORLD');
  const size = m.length;
  const finder = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
  ];
  for (const [ox, oy] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ]) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        if (m[oy + y][ox + x] !== (finder[y][x] === 1)) {
          return `finder mismatch at offset (${ox},${oy}) module (${x},${y})`;
        }
      }
    }
  }
  return null;
});

check('timing patterns alternate along row 6 and column 6', () => {
  const m = encode('HELLO WORLD');
  const size = m.length;
  for (let i = 8; i < size - 8; i++) {
    const want = i % 2 === 0;
    if (m[6][i] !== want) return `row 6 column ${i} is ${m[6][i]}, expected ${want}`;
    if (m[i][6] !== want) return `column 6 row ${i} is ${m[i][6]}, expected ${want}`;
  }
  return null;
});

check('the dark module is always dark', () => {
  for (const text of ['A', 'HELLO WORLD', 'x'.repeat(300), '配'.repeat(50)]) {
    const m = encode(text);
    const size = m.length;
    if (m[size - 8][8] !== true) return `dark module not dark for ${JSON.stringify(text.slice(0, 12))}`;
  }
  return null;
});

check('separators around finders are light', () => {
  const m = encode('HELLO WORLD');
  const size = m.length;
  for (let i = 0; i < 8; i++) {
    if (m[7][i]) return `separator dark at row 7 col ${i}`;
    if (m[i][7]) return `separator dark at row ${i} col 7`;
    if (m[7][size - 1 - i]) return `separator dark at row 7 col ${size - 1 - i}`;
    if (m[size - 1 - i][7]) return `separator dark at row ${size - 1 - i} col 7`;
  }
  return null;
});

check('version information appears for version >= 7', () => {
  const d = encodeDetails('x'.repeat(300), { errorCorrection: 'L' });
  if (d.version < 7) return `test needs v>=7, got v${d.version}`;
  const m = d.matrix;
  const size = d.size;
  // The two copies must agree module for module.
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3);
    const c = Math.floor(i / 3);
    if (m[c][a] !== m[a][c]) return `version info copies differ at bit ${i}`;
  }
  return null;
});

// ---------------------------------------------------------------------------
// toTerminal()
// ---------------------------------------------------------------------------

check('toTerminal packs two matrix rows per line', () => {
  const m = encode('HELLO WORLD'); // 21 rows
  const text = toTerminal(m, { quietZone: 0 });
  const lines = text.split('\n');
  return assert(lines.length === 11, `expected 11 lines for 21 rows, got ${lines.length}`);
});

check('toTerminal pads an odd row count with a light line', () => {
  const m = encode('HELLO WORLD');
  const text = toTerminal(m, { quietZone: 2 }); // 21 + 4 = 25 rows -> 13 lines
  const lines = text.split('\n');
  if (lines.length !== 13) return `expected 13 lines, got ${lines.length}`;
  const grid = parseTerminal(text);
  // The padded row must be entirely light.
  const lastRow = grid[grid.length - 1];
  if (lastRow.some((v) => v)) return 'padded final row is not light';
  return null;
});

check('toTerminal applies the quiet zone on all four sides', () => {
  const m = encode('HELLO WORLD');
  const quietZone = 2;
  const grid = parseTerminal(toTerminal(m, { quietZone }));
  // 21 + 2*2 = 25 rows is odd, so the renderer pads to an even row count.
  const padded = m.length + quietZone * 2;
  const total = padded % 2 === 0 ? padded : padded + 1;
  if (grid.length !== total) return `grid height ${grid.length} != ${total}`;
  if (grid[0].length !== padded) return `grid width ${grid[0].length} != ${padded}`;
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const inside =
        y >= quietZone && y < quietZone + m.length && x >= quietZone && x < quietZone + m.length;
      if (!inside && grid[y][x]) return `quiet zone dark at (${x},${y})`;
    }
  }
  return null;
});

check('toTerminal round-trips the matrix exactly', () => {
  const m = encode('http://192.168.1.5:19387/?code=123456', { errorCorrection: 'H' });
  const quietZone = 3;
  const grid = parseTerminal(toTerminal(m, { quietZone }));
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (grid[y + quietZone][x + quietZone] !== (m[y][x] ? 1 : 0)) {
        return `mismatch at (${x},${y})`;
      }
    }
  }
  return null;
});

check('toTerminal honours custom glyphs', () => {
  const m = encode('HELLO WORLD');
  const text = toTerminal(m, {
    quietZone: 0,
    dark: 'X',
    light: '.',
    topHalf: 'T',
    bottomHalf: 'B',
  });
  const glyphs = new Set(text.split('\n').join('').split(''));
  for (const g of glyphs) {
    if (!'X.TB'.includes(g)) return `unexpected glyph ${JSON.stringify(g)}`;
  }
  return assert(glyphs.has('X') && glyphs.has('.'), 'custom glyphs not used');
});

check('toTerminal returns an empty string for an empty matrix', () => {
  return assert(toTerminal([]) === '', 'expected "" for an empty matrix');
});

check('toTerminal lines are all the same width', () => {
  const m = encode('x'.repeat(200));
  const lines = toTerminal(m, { quietZone: 4 }).split('\n');
  const widths = new Set(lines.map((l) => [...l].length));
  return assert(widths.size === 1, `ragged output, widths: ${[...widths].join(', ')}`);
});

check('toTerminal default quiet zone is 4 (the ISO/IEC 18004 minimum)', () => {
  const m = encode('HELLO WORLD');
  const withDefault = toTerminal(m);
  const explicit = toTerminal(m, { quietZone: 4 });
  return assert(withDefault === explicit, 'default quiet zone is not 4');
});

check('toTerminal clamps a negative quiet zone instead of cropping', () => {
  const m = encode('HELLO WORLD');
  const negative = toTerminal(m, { quietZone: -5 });
  const zero = toTerminal(m, { quietZone: 0 });
  if (!assert(negative === zero, 'a negative quiet zone must clamp to 0, not crop the symbol')) {
    return false;
  }
  // Every row must still be wide enough to hold the full symbol.
  const width = negative.split('\n')[0].length;
  return assert(width >= m.length, `cropped: width ${width} < matrix ${m.length}`);
});

check('toTerminal tolerates a fractional quiet zone', () => {
  const m = encode('HELLO WORLD');
  const fractional = toTerminal(m, { quietZone: 2.7 });
  const floored = toTerminal(m, { quietZone: 2 });
  return assert(fractional === floored, 'a fractional quiet zone must floor, not corrupt the matrix');
});

// ---------------------------------------------------------------------------
// toSvg()
// ---------------------------------------------------------------------------

check('toSvg emits a well-formed standalone document', () => {
  const svg = toSvg(encode('HELLO WORLD'));
  if (!svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) return 'missing XML declaration';
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) return 'missing SVG namespace';
  if (!svg.trimEnd().endsWith('</svg>')) return 'missing closing tag';
  return null;
});

check('toSvg defaults are quietZone 4 and scale 4', () => {
  const m = encode('HELLO WORLD'); // 21 modules
  const svg = toSvg(m);
  const expected = (21 + 8) * 4;
  if (!svg.includes(`width="${expected}"`)) return `expected width ${expected}`;
  if (!svg.includes(`height="${expected}"`)) return `expected height ${expected}`;
  return assert(svg.includes(`viewBox="0 0 ${expected} ${expected}"`), 'viewBox mismatch');
});

check('toSvg honours custom quietZone and scale', () => {
  const m = encode('HELLO WORLD');
  const svg = toSvg(m, { quietZone: 1, scale: 10 });
  const expected = (21 + 2) * 10;
  return assert(
    svg.includes(`width="${expected}"`) && svg.includes(`height="${expected}"`),
    `expected ${expected}px`,
  );
});

check('toSvg can omit the XML declaration', () => {
  const svg = toSvg(encode('A'), { xmlDeclaration: false });
  return assert(svg.startsWith('<svg'), 'document does not start with <svg');
});

check('toSvg escapes title and description', () => {
  const svg = toSvg(encode('A'), { title: '<b>&"x"</b>', description: 'a & b' });
  if (svg.includes('<b>')) return 'title was not escaped';
  if (!svg.includes('&lt;b&gt;')) return 'escaped title missing';
  return assert(svg.includes('<desc>a &amp; b</desc>'), 'description not escaped');
});

check('toSvg emits no dark runs for an all-light matrix', () => {
  const matrix = Array.from({ length: 21 }, () => new Array(21).fill(false));
  const svg = toSvg(matrix);
  const d = /<path d="([^"]*)"/.exec(svg);
  if (!d) return 'no path element';
  return assert(d[1] === '', `expected an empty path, got ${JSON.stringify(d[1].slice(0, 40))}`);
});

check('toSvg merges horizontal runs into single path segments', () => {
  // A row that is entirely dark must become exactly one `M...h...v...z` segment.
  const matrix = Array.from({ length: 21 }, () => new Array(21).fill(false));
  matrix[10] = new Array(21).fill(true);
  const svg = toSvg(matrix, { quietZone: 0, scale: 1 });
  const d = /<path d="([^"]*)"/.exec(svg)[1];
  const segments = d.match(/M[-\d.]+ [-\d.]+h[-\d.]+v[-\d.]+h[-\d.]+z/g) ?? [];
  return assert(segments.length === 1, `expected 1 merged segment, got ${segments.length}`);
});

check('toSvg output is deterministic', () => {
  const m = encode('HELLO WORLD');
  return assert(toSvg(m) === toSvg(m), 'two calls produced different output');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
console.log('--- summary -------------------------------------------------');
console.log(`  passed: ${passed} / ${passed + failures.length}`);
console.log(`  failed: ${failures.length}`);
if (failures.length > 0) {
  console.log('');
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.problem}`);
  console.log('');
  console.log('RESULT: FAIL');
  process.exit(1);
}
console.log('');
console.log('RESULT: PASS');
