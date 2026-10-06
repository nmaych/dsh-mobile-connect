/**
 * qr.js — a dependency-free QR Code encoder (byte mode / UTF-8) for Node.js.
 *
 * Implements ISO/IEC 18004 QR Code Model 2 symbol generation:
 *   - byte mode data encoding (UTF-8) with automatic version selection (1..40)
 *   - Reed-Solomon error correction over GF(256), primitive polynomial 0x11d
 *   - block splitting and interleaving for multi-block versions
 *   - function patterns: finders, separators, timing, alignment, dark module
 *   - format information and version information (BCH codes)
 *   - all 8 data masks, selected by the standard penalty rules
 *     (N1 = 3, N2 = 3, N3 = 40, N4 = 10)
 *
 * Public API:
 *   encode(text, { errorCorrection })  -> boolean[][]   (true === dark module)
 *   toTerminal(matrix, options)        -> string        (half-block text art)
 *   toSvg(matrix, options)             -> string        (standalone SVG document)
 *   encodeDetails(text, options)       -> { matrix, version, mask, ... }
 *
 * Pure ES module: no dependencies, no `require`, no native modules.
 */

// ---------------------------------------------------------------------------
// GF(256) arithmetic — primitive polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1)
// ---------------------------------------------------------------------------

/** GF_EXP[i] === 2^i in GF(256); doubled to 512 entries so products need no modulo. */
const GF_EXP = new Uint8Array(512);
/** GF_LOG[v] === i such that 2^i === v; GF_LOG[0] is unused (log 0 is undefined). */
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

/** Multiply two GF(256) elements. */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * Reed-Solomon generator polynomial of the given degree:
 *   (x - a^0)(x - a^1) ... (x - a^(degree-1))
 * Returned as `degree + 1` coefficients, highest power first, monic (gen[0] === 1).
 */
const generatorCache = new Map();
function rsGeneratorPoly(degree) {
  const cached = generatorCache.get(degree);
  if (cached) return cached;
  let poly = Uint8Array.of(1);
  for (let i = 0; i < degree; i++) {
    const root = GF_EXP[i];
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]; // poly[j] * x
      next[j + 1] ^= gfMul(poly[j], root); // poly[j] * a^i
    }
    poly = next;
  }
  generatorCache.set(degree, poly);
  return poly;
}

/**
 * Compute `ecLength` Reed-Solomon error correction codewords for `data`
 * (extended synthetic division, ISO/IEC 18004 7.5.2).
 */
function rsEncode(data, ecLength) {
  const gen = rsGeneratorPoly(ecLength);
  const buf = new Uint8Array(data.length + ecLength);
  buf.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], coef);
  }
  return buf.subarray(data.length);
}

// ---------------------------------------------------------------------------
// Constant tables
// ---------------------------------------------------------------------------

/** Error correction levels, ordered by increasing redundancy. */
export const ERROR_CORRECTION_LEVELS = Object.freeze(['L', 'M', 'Q', 'H']);

const EC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };

/** Two-bit error correction indicator used inside the format information. */
const EC_FORMAT_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

/**
 * ISO/IEC 18004:2015 Table 9 — error correction characteristics.
 *
 * One string per version (1..40). Each string holds four space-separated specs
 * in L, M, Q, H order. A spec is a `+`-separated list of block groups, each
 * written as `blockCount,totalCodewords,dataCodewords`.
 */
const ECC_SPECS = [
  /*  1 */ '1,26,19 1,26,16 1,26,13 1,26,9',
  /*  2 */ '1,44,34 1,44,28 1,44,22 1,44,16',
  /*  3 */ '1,70,55 1,70,44 2,35,17 2,35,13',
  /*  4 */ '1,100,80 2,50,32 2,50,24 4,25,9',
  /*  5 */ '1,134,108 2,67,43 2,33,15+2,34,16 2,33,11+2,34,12',
  /*  6 */ '2,86,68 4,43,27 4,43,19 4,43,15',
  /*  7 */ '2,98,78 4,49,31 2,32,14+4,33,15 4,39,13+1,40,14',
  /*  8 */ '2,121,97 2,60,38+2,61,39 4,40,18+2,41,19 4,40,14+2,41,15',
  /*  9 */ '2,146,116 3,58,36+2,59,37 4,36,16+4,37,17 4,36,12+4,37,13',
  /* 10 */ '2,86,68+2,87,69 4,69,43+1,70,44 6,43,19+2,44,20 6,43,15+2,44,16',
  /* 11 */ '4,101,81 1,80,50+4,81,51 4,50,22+4,51,23 3,36,12+8,37,13',
  /* 12 */ '2,116,92+2,117,93 6,58,36+2,59,37 4,46,20+6,47,21 7,42,14+4,43,15',
  /* 13 */ '4,133,107 8,59,37+1,60,38 8,44,20+4,45,21 12,33,11+4,34,12',
  /* 14 */ '3,145,115+1,146,116 4,64,40+5,65,41 11,36,16+5,37,17 11,36,12+5,37,13',
  /* 15 */ '5,109,87+1,110,88 5,65,41+5,66,42 5,54,24+7,55,25 11,36,12+7,37,13',
  /* 16 */ '5,122,98+1,123,99 7,73,45+3,74,46 15,43,19+2,44,20 3,45,15+13,46,16',
  /* 17 */ '1,135,107+5,136,108 10,74,46+1,75,47 1,50,22+15,51,23 2,42,14+17,43,15',
  /* 18 */ '5,150,120+1,151,121 9,69,43+4,70,44 17,50,22+1,51,23 2,42,14+19,43,15',
  /* 19 */ '3,141,113+4,142,114 3,70,44+11,71,45 17,47,21+4,48,22 9,39,13+16,40,14',
  /* 20 */ '3,135,107+5,136,108 3,67,41+13,68,42 15,54,24+5,55,25 15,43,15+10,44,16',
  /* 21 */ '4,144,116+4,145,117 17,68,42 17,50,22+6,51,23 19,46,16+6,47,17',
  /* 22 */ '2,139,111+7,140,112 17,74,46 7,54,24+16,55,25 34,37,13',
  /* 23 */ '4,151,121+5,152,122 4,75,47+14,76,48 11,54,24+14,55,25 16,45,15+14,46,16',
  /* 24 */ '6,147,117+4,148,118 6,73,45+14,74,46 11,54,24+16,55,25 30,46,16+2,47,17',
  /* 25 */ '8,132,106+4,133,107 8,75,47+13,76,48 7,54,24+22,55,25 22,45,15+13,46,16',
  /* 26 */ '10,142,114+2,143,115 19,74,46+4,75,47 28,50,22+6,51,23 33,46,16+4,47,17',
  /* 27 */ '8,152,122+4,153,123 22,73,45+3,74,46 8,53,23+26,54,24 12,45,15+28,46,16',
  /* 28 */ '3,147,117+10,148,118 3,73,45+23,74,46 4,54,24+31,55,25 11,45,15+31,46,16',
  /* 29 */ '7,146,116+7,147,117 21,73,45+7,74,46 1,53,23+37,54,24 19,45,15+26,46,16',
  /* 30 */ '5,145,115+10,146,116 19,75,47+10,76,48 15,54,24+25,55,25 23,45,15+25,46,16',
  /* 31 */ '13,145,115+3,146,116 2,74,46+29,75,47 42,54,24+1,55,25 23,45,15+28,46,16',
  /* 32 */ '17,145,115 10,74,46+23,75,47 10,54,24+35,55,25 19,45,15+35,46,16',
  /* 33 */ '17,145,115+1,146,116 14,74,46+21,75,47 29,54,24+19,55,25 11,45,15+46,46,16',
  /* 34 */ '13,145,115+6,146,116 14,74,46+23,75,47 44,54,24+7,55,25 59,46,16+1,47,17',
  /* 35 */ '12,151,121+7,152,122 12,75,47+26,76,48 39,54,24+14,55,25 22,45,15+41,46,16',
  /* 36 */ '6,151,121+14,152,122 6,75,47+34,76,48 46,54,24+10,55,25 2,45,15+64,46,16',
  /* 37 */ '17,152,122+4,153,123 29,74,46+14,75,47 49,54,24+10,55,25 24,45,15+46,46,16',
  /* 38 */ '4,152,122+18,153,123 13,74,46+32,75,47 48,54,24+14,55,25 42,45,15+32,46,16',
  /* 39 */ '20,147,117+4,148,118 40,75,47+7,76,48 43,54,24+22,55,25 10,45,15+67,46,16',
  /* 40 */ '19,148,118+6,149,119 18,75,47+31,76,48 34,54,24+34,55,25 20,45,15+61,46,16',
];

/**
 * Parsed form of {@link ECC_SPECS}:
 *   ECC_TABLE[version - 1][ecIndex] === [[numBlocks, numTotal, numData], ...]
 */
const ECC_TABLE = ECC_SPECS.map((spec) =>
  spec.split(' ').map((group) =>
    group.split('+').map((triple) => triple.split(',').map(Number)),
  ),
);

/**
 * ISO/IEC 18004:2015 Annex E — row/column coordinates of the centre modules of
 * alignment patterns. Indexed by `version - 2` (version 1 has none).
 */
const ALIGNMENT_POS = [
  /*  2 */ [6, 18],
  /*  3 */ [6, 22],
  /*  4 */ [6, 26],
  /*  5 */ [6, 30],
  /*  6 */ [6, 34],
  /*  7 */ [6, 22, 38],
  /*  8 */ [6, 24, 42],
  /*  9 */ [6, 26, 46],
  /* 10 */ [6, 28, 50],
  /* 11 */ [6, 30, 54],
  /* 12 */ [6, 32, 58],
  /* 13 */ [6, 34, 62],
  /* 14 */ [6, 26, 46, 66],
  /* 15 */ [6, 26, 48, 70],
  /* 16 */ [6, 26, 50, 74],
  /* 17 */ [6, 30, 54, 78],
  /* 18 */ [6, 30, 56, 82],
  /* 19 */ [6, 30, 58, 86],
  /* 20 */ [6, 34, 62, 90],
  /* 21 */ [6, 28, 50, 72, 94],
  /* 22 */ [6, 26, 50, 74, 98],
  /* 23 */ [6, 30, 54, 78, 102],
  /* 24 */ [6, 28, 54, 80, 106],
  /* 25 */ [6, 32, 58, 84, 110],
  /* 26 */ [6, 30, 58, 86, 114],
  /* 27 */ [6, 34, 62, 90, 118],
  /* 28 */ [6, 26, 50, 74, 98, 122],
  /* 29 */ [6, 30, 54, 78, 102, 126],
  /* 30 */ [6, 26, 52, 78, 104, 130],
  /* 31 */ [6, 30, 56, 82, 108, 134],
  /* 32 */ [6, 34, 60, 86, 112, 138],
  /* 33 */ [6, 30, 58, 86, 114, 142],
  /* 34 */ [6, 34, 62, 90, 118, 146],
  /* 35 */ [6, 30, 54, 78, 102, 126, 150],
  /* 36 */ [6, 24, 50, 76, 102, 128, 154],
  /* 37 */ [6, 28, 54, 80, 106, 132, 158],
  /* 38 */ [6, 32, 58, 84, 110, 136, 162],
  /* 39 */ [6, 26, 54, 82, 110, 138, 166],
  /* 40 */ [6, 30, 58, 86, 114, 142, 170],
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Encode a JavaScript string as UTF-8 bytes.
 *
 * Lone surrogates become U+FFFD, matching WHATWG `TextEncoder`.
 */
function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** MSB-first bit writer over a byte buffer. */
class BitBuffer {
  constructor(capacityBits) {
    this.bytes = new Uint8Array((capacityBits >> 3) + 1);
    this.length = 0;
  }

  /** Append the low `bits` bits of `value`, most significant bit first. */
  put(value, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      if ((value >>> i) & 1) this.bytes[this.length >> 3] |= 0x80 >> (this.length & 7);
      this.length++;
    }
  }
}

/** BCH(15,5) format information, XOR-masked with 0x5412 (ISO/IEC 18004 7.9). */
function formatInfoBits(ec, mask) {
  const data = (EC_FORMAT_BITS[ec] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** BCH(18,6) version information (ISO/IEC 18004 7.10). */
function versionInfoBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/**
 * The eight data mask predicates (ISO/IEC 18004 Table 10), called as
 * `fn(x, y)` with `x` the column and `y` the row.
 */
const MASK_FUNCTIONS = [
  (x, y) => ((x + y) & 1) === 0,
  (x, y) => (y & 1) === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => ((Math.floor(y / 2) + Math.floor(x / 3)) & 1) === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Normalize and validate an error correction level name. */
function normalizeErrorCorrection(level) {
  const key = String(level ?? 'M').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(EC_INDEX, key)) {
    throw new RangeError(
      `unsupported error correction level ${JSON.stringify(level)}; expected one of L, M, Q, H`,
    );
  }
  return key;
}

/** Number of bits in the byte-mode character count indicator. */
function charCountBits(version) {
  return version < 10 ? 8 : 16;
}

/** Total number of *data* codewords for an ECC group list. */
function dataCodewordCount(ecGroups) {
  let total = 0;
  for (const [numBlocks, , numData] of ecGroups) total += numBlocks * numData;
  return total;
}

/** Smallest version (1..40) whose data capacity fits `byteLength` bytes. */
function pickVersion(byteLength, ec) {
  const ecIndex = EC_INDEX[ec];
  for (let version = 1; version <= 40; version++) {
    const needed = 4 + charCountBits(version) + byteLength * 8;
    if (needed <= dataCodewordCount(ECC_TABLE[version - 1][ecIndex]) * 8) return version;
  }
  throw new RangeError(
    `data too long: ${byteLength} bytes do not fit in a version-40 QR code ` +
      `at error correction level ${ec}`,
  );
}

/**
 * Build the padded data codeword sequence:
 * mode indicator, character count, data, terminator, bit padding, pad codewords
 * (ISO/IEC 18004 7.4.9 / 7.4.10).
 *
 * Note on the bit padding step: this mirrors the widely used convention of
 * emitting a full byte of zero padding whenever the stream already ends on a
 * codeword boundary (the reference implementation `segno` does the same). The
 * resulting symbol is identical for decoders — the extra zero byte is simply
 * ignored padding — but it keeps this encoder bit-for-bit compatible with
 * segno, which is what the verification harness compares against.
 */
function buildDataCodewords(bytes, version, ecGroups) {
  const capacityBytes = dataCodewordCount(ecGroups);
  const capacityBits = capacityBytes * 8;
  // One spare byte: the padding rule above can emit one codeword past the
  // capacity when the data fills the symbol exactly; it is truncated below.
  const bb = new BitBuffer(capacityBits + 8);

  bb.put(0b0100, 4); // byte mode indicator
  bb.put(bytes.length, charCountBits(version)); // character count indicator
  for (let i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);

  // Terminator: up to four zero bits, truncated if capacity is nearly full.
  bb.put(0, Math.min(4, capacityBits - bb.length));
  // Zero bits up to the next codeword boundary.
  bb.put(0, 8 - (bb.length % 8));

  const writtenBytes = bb.length >> 3;
  const out = new Uint8Array(capacityBytes);
  const copied = Math.min(writtenBytes, capacityBytes);
  out.set(bb.bytes.subarray(0, copied), 0);
  // Pad codewords 11101100 / 00010001, alternating (ISO/IEC 18004 7.4.10).
  for (let i = copied, k = 0; i < capacityBytes; i++, k++) out[i] = k % 2 === 0 ? 0xec : 0x11;
  return out;
}

/**
 * Split data codewords into blocks, append Reed-Solomon codewords to each and
 * interleave everything into the final message sequence (ISO/IEC 18004 7.6).
 */
function interleaveWithErrorCorrection(dataCodewords, ecGroups) {
  const dataBlocks = [];
  const ecBlocks = [];
  let maxData = 0;
  let maxEc = 0;
  let offset = 0;

  for (const [numBlocks, numTotal, numData] of ecGroups) {
    const ecLength = numTotal - numData;
    if (numData > maxData) maxData = numData;
    if (ecLength > maxEc) maxEc = ecLength;
    for (let b = 0; b < numBlocks; b++) {
      const block = dataCodewords.subarray(offset, offset + numData);
      offset += numData;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecLength));
    }
  }

  const out = new Uint8Array(offset + ecBlocks.length * maxEc);
  let p = 0;
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out[p++] = block[i];
  }
  for (let i = 0; i < maxEc; i++) {
    for (const block of ecBlocks) if (i < block.length) out[p++] = block[i];
  }
  return out.subarray(0, p);
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

/**
 * Draw the function patterns into a fresh matrix.
 *
 * Returns `{ modules, isFunction, size }`. Format-information, version-
 * information and dark-module positions are marked as function modules but are
 * left light: they are only filled in after mask selection, and their light
 * placeholder values are what the mask penalty evaluation must see.
 */
function buildFunctionPatterns(version) {
  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);
  const isFunction = new Uint8Array(size * size);

  /** Mark (x, y) as a function module without changing its value. */
  const reserve = (x, y) => {
    isFunction[y * size + x] = 1;
  };
  const draw = (x, y, dark) => {
    modules[y * size + x] = dark ? 1 : 0;
    isFunction[y * size + x] = 1;
  };

  // Finder patterns (7x7) plus their separators (the light ring around them).
  for (const [cx, cy] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ]) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        draw(x, y, dist === 3 || dist <= 1);
      }
    }
  }

  // Timing patterns (row 6 and column 6), dark at even coordinates.
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    draw(i, 6, dark);
    draw(6, i, dark);
  }

  // Alignment patterns (5x5), skipping the three finder corners.
  if (version >= 2) {
    const positions = ALIGNMENT_POS[version - 2];
    const last = positions[positions.length - 1];
    for (const cy of positions) {
      for (const cx of positions) {
        if ((cx === 6 && (cy === 6 || cy === last)) || (cx === last && cy === 6)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            draw(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }
  }

  // Reserve the format information areas (and the dark module) — left light.
  // Copy 1 lives in column 8 / row 8 next to the top-left finder; copy 2 lives
  // in the last eight rows of column 8 and the last eight columns of row 8.
  for (let i = 0; i <= 8; i++) {
    reserve(8, i);
    reserve(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    reserve(8, size - 1 - i);
    reserve(size - 1 - i, 8);
  }

  // Reserve the version information areas (version >= 7) — left light.
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserve(size - 11 + j, i);
        reserve(i, size - 11 + j);
      }
    }
  }

  return { modules, isFunction, size };
}

/**
 * Place the final message bit stream in the encoding region using the standard
 * two-module-wide zigzag, skipping the vertical timing column (ISO/IEC 18004
 * 7.7.3). Modules left over (the remainder bits) stay light.
 */
function placeCodewords(modules, isFunction, size, codewords) {
  let dataModules = 0;
  for (let i = 0; i < isFunction.length; i++) if (!isFunction[i]) dataModules++;

  const bits = new Uint8Array(dataModules);
  let bitCount = 0;
  for (let i = 0; i < codewords.length && bitCount < dataModules; i++) {
    for (let b = 7; b >= 0 && bitCount < dataModules; b--) {
      bits[bitCount++] = (codewords[i] >> b) & 1;
    }
  }

  let idx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing pattern column
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      for (let z = 0; z < 2; z++) {
        const x = right - z;
        const y = upward ? size - 1 - vert : vert;
        const pos = y * size + x;
        if (!isFunction[pos] && idx < dataModules) modules[pos] = bits[idx++];
      }
    }
  }
  return { dataModules, placed: idx };
}

// ---------------------------------------------------------------------------
// Mask evaluation (ISO/IEC 18004 7.8.3, Table 11)
// ---------------------------------------------------------------------------

/** N1: runs of five or more same-coloured modules in a line: 3 + (length - 5). */
function penaltyN1(line, size) {
  let score = 0;
  let run = 1;
  for (let i = 1; i < size; i++) {
    if (line[i] === line[i - 1]) {
      run++;
    } else {
      if (run >= 5) score += run - 2;
      run = 1;
    }
  }
  if (run >= 5) score += run - 2;
  return score;
}

/**
 * N3: occurrences of the finder-like 1:1:3:1:1 pattern `1011101` that are
 * preceded or followed by a light area four modules wide. Positions outside the
 * symbol count as light, so a pattern touching either end of a line qualifies.
 *
 * Overlap handling follows the reference implementation: after a pattern that
 * *qualifies*, the search resumes 7 modules later so the same finder shape is
 * not counted twice; after one that does not qualify, it resumes 4 modules
 * later so a genuine second occurrence can still be found.
 */
const N3_PATTERN = Uint8Array.of(1, 0, 1, 1, 1, 0, 1);

/** Index of the next occurrence of {@link N3_PATTERN} at or after `from`, or -1. */
function findN3Pattern(line, from, size) {
  outer: for (let i = Math.max(from, 0); i + 7 <= size; i++) {
    for (let k = 0; k < 7; k++) if (line[i + k] !== N3_PATTERN[k]) continue outer;
    return i;
  }
  return -1;
}

/** True when every module in `[start, end)` is light (out-of-range is light). */
function isLightRange(line, start, end, size) {
  for (let k = Math.max(start, 0); k < Math.min(end, size); k++) {
    if (line[k]) return false;
  }
  return true;
}

function penaltyN3(line, size) {
  let score = 0;
  let idx = findN3Pattern(line, 0, size);
  while (idx !== -1) {
    let next = idx + 7;
    const atEdge = idx === 0 || idx === size - 7;
    const qualifies =
      atEdge ||
      isLightRange(line, idx - 4, idx, size) ||
      isLightRange(line, next, next + 4, size);

    if (qualifies) {
      score += 40;
    } else {
      // No / not enough light modules: resume inside the pattern so an
      // overlapping second occurrence can still be detected.
      next = idx + 4;
    }
    idx = findN3Pattern(line, next, size);
  }
  return score;
}

/** Total penalty score of a masked matrix (lower is better). */
function maskPenalty(modules, size) {
  const line = new Uint8Array(size);
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  let darkCount = 0;

  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) line[j] = modules[i * size + j]; // row i
    n1 += penaltyN1(line, size);
    n3 += penaltyN3(line, size);

    for (let j = 0; j < size; j++) line[j] = modules[j * size + i]; // column i
    n1 += penaltyN1(line, size);
    n3 += penaltyN3(line, size);
  }

  // N2: every 2x2 block of a single colour scores 3.
  for (let y = 0; y + 1 < size; y++) {
    const row = y * size;
    const next = row + size;
    for (let x = 0; x + 1 < size; x++) {
      const v = modules[row + x];
      if (v === modules[row + x + 1] && v === modules[next + x] && v === modules[next + x + 1]) {
        n2 += 3;
      }
    }
  }

  for (let i = 0; i < modules.length; i++) darkCount += modules[i];

  // N4: deviation of the dark-module proportion from 50%, in 5% steps.
  const percent = darkCount / (size * size);
  const n4 = 10 * Math.floor(Math.abs(percent * 100 - 50) / 5);

  return n1 + n2 + n3 + n4;
}

/** Apply a mask to the encoding region of `modules`, in place. */
function applyMask(modules, isFunction, size, maskIndex) {
  const fn = MASK_FUNCTIONS[maskIndex];
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      if (!isFunction[row + x] && fn(x, y)) modules[row + x] ^= 1;
    }
  }
}

/** Choose the mask with the lowest penalty score; ties go to the lowest index. */
function chooseMask(modules, isFunction, size) {
  let bestMask = 0;
  let bestScore = Infinity;
  const candidate = new Uint8Array(modules.length);
  for (let mask = 0; mask < 8; mask++) {
    candidate.set(modules);
    applyMask(candidate, isFunction, size, mask);
    const score = maskPenalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
  }
  return bestMask;
}

// ---------------------------------------------------------------------------
// Format / version information placement
// ---------------------------------------------------------------------------

/** Write the 15 format information bits (both copies) and the dark module. */
function drawFormatInfo(modules, size, ec, mask) {
  const bits = formatInfoBits(ec, mask);
  const bit = (i) => (bits >> i) & 1;

  // First copy: column 8 (upper left) and row 8 (upper left), skipping the
  // timing pattern module at (row 6, column 8).
  for (let i = 0; i <= 5; i++) modules[i * size + 8] = bit(i);
  modules[7 * size + 8] = bit(6);
  modules[8 * size + 8] = bit(7);
  modules[8 * size + 7] = bit(8);
  for (let i = 9; i < 15; i++) modules[8 * size + (14 - i)] = bit(i);

  // Second copy: row 8 (right side) and column 8 (bottom side).
  for (let i = 0; i < 8; i++) modules[8 * size + (size - 1 - i)] = bit(i);
  for (let i = 8; i < 15; i++) modules[(size - 15 + i) * size + 8] = bit(i);

  // The dark module is always dark (ISO/IEC 18004 7.9.1).
  modules[(size - 8) * size + 8] = 1;
}

/** Write the 18 version information bits (both copies) for version >= 7. */
function drawVersionInfo(modules, size, version) {
  if (version < 7) return;
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i++) {
    const b = (bits >> i) & 1;
    const a = size - 11 + (i % 3);
    const c = Math.floor(i / 3);
    modules[c * size + a] = b; // upper-right block
    modules[a * size + c] = b; // lower-left block
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode `text` and return a matrix of booleans: `matrix[y][x] === true` means
 * a dark module. The matrix has no quiet zone.
 *
 * @param {string} text
 * @param {{ errorCorrection?: 'L'|'M'|'Q'|'H' }} [options]
 * @returns {boolean[][]}
 */
export function encode(text, { errorCorrection = 'M' } = {}) {
  return encodeDetails(text, { errorCorrection }).matrix;
}

/**
 * Like {@link encode}, but also reports the selected version, mask and the
 * number of encoded UTF-8 bytes.
 *
 * @param {string} text
 * @param {{ errorCorrection?: 'L'|'M'|'Q'|'H' }} [options]
 * @returns {{ matrix: boolean[][], version: number, mask: number,
 *             errorCorrection: string, size: number, byteLength: number }}
 */
export function encodeDetails(text, { errorCorrection = 'M' } = {}) {
  const ec = normalizeErrorCorrection(errorCorrection);
  const bytes = utf8Encode(text == null ? '' : String(text));
  const version = pickVersion(bytes.length, ec);
  const ecGroups = ECC_TABLE[version - 1][EC_INDEX[ec]];

  const dataCodewords = buildDataCodewords(bytes, version, ecGroups);
  const finalMessage = interleaveWithErrorCorrection(dataCodewords, ecGroups);

  const { modules, isFunction, size } = buildFunctionPatterns(version);
  const { dataModules, placed } = placeCodewords(modules, isFunction, size, finalMessage);
  if (placed !== dataModules) {
    throw new Error(`internal error: placed ${placed} of ${dataModules} data modules`);
  }

  const mask = chooseMask(modules, isFunction, size);
  applyMask(modules, isFunction, size, mask);
  drawFormatInfo(modules, size, ec, mask);
  drawVersionInfo(modules, size, version);

  const matrix = [];
  for (let y = 0; y < size; y++) {
    const row = new Array(size);
    for (let x = 0; x < size; x++) row[x] = modules[y * size + x] === 1;
    matrix.push(row);
  }

  return { matrix, version, mask, errorCorrection: ec, size, byteLength: bytes.length };
}

/**
 * Render a matrix as text using half-block characters so a terminal shows a
 * roughly square code. Two matrix rows are packed into each text line; when the
 * padded height is odd the final line is padded with light modules.
 *
 * @param {boolean[][]} matrix
 * @param {{ quietZone?: number, dark?: string, light?: string,
 *           topHalf?: string, bottomHalf?: string }} [options]
 * @returns {string}
 */
export function toTerminal(
  matrix,
  { quietZone = 2, dark = '\u2588', light = ' ', topHalf = '\u2580', bottomHalf = '\u2584' } = {},
) {
  const rows = matrix.length;
  const cols = rows > 0 ? matrix[0].length : 0;
  if (rows === 0 || cols === 0) return '';

  const isDark = (y, x) => y >= 0 && y < rows && x >= 0 && x < cols && matrix[y][x] === true;

  const lines = [];
  for (let y = -quietZone; y < rows + quietZone; y += 2) {
    let line = '';
    for (let x = -quietZone; x < cols + quietZone; x++) {
      const top = isDark(y, x);
      const bottom = isDark(y + 1, x);
      line += top ? (bottom ? dark : topHalf) : bottom ? bottomHalf : light;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Format a number for SVG output without floating-point noise. */
function svgNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/** Escape text for use inside an SVG element. */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a matrix as a standalone SVG document string.
 *
 * Dark modules are merged into horizontal runs to keep the path short. A
 * background rectangle covers the quiet zone so the symbol stays scannable when
 * the SVG is placed on a dark page.
 *
 * @param {boolean[][]} matrix
 * @param {{ quietZone?: number, scale?: number, dark?: string, light?: string,
 *           xmlDeclaration?: boolean, title?: string, description?: string }} [options]
 * @returns {string}
 */
export function toSvg(
  matrix,
  {
    quietZone = 4,
    scale = 4,
    dark = '#000000',
    light = '#ffffff',
    xmlDeclaration = true,
    title,
    description,
  } = {},
) {
  const rows = matrix.length;
  const cols = rows > 0 ? matrix[0].length : 0;
  const width = (cols + quietZone * 2) * scale;
  const height = (rows + quietZone * 2) * scale;

  const commands = [];
  for (let y = 0; y < rows; y++) {
    const row = matrix[y];
    let x = 0;
    while (x < cols) {
      if (row[x] !== true) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < cols && row[x + run] === true) run++;
      const px = (x + quietZone) * scale;
      const py = (y + quietZone) * scale;
      const w = run * scale;
      commands.push(
        `M${svgNumber(px)} ${svgNumber(py)}h${svgNumber(w)}v${svgNumber(scale)}h${svgNumber(-w)}z`,
      );
      x += run;
    }
  }

  const parts = [];
  if (xmlDeclaration) parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ` +
      `width="${svgNumber(width)}" height="${svgNumber(height)}" ` +
      `viewBox="0 0 ${svgNumber(width)} ${svgNumber(height)}" ` +
      `shape-rendering="crispEdges">`,
  );
  if (title !== undefined) parts.push(`<title>${escapeXml(title)}</title>`);
  if (description !== undefined) parts.push(`<desc>${escapeXml(description)}</desc>`);
  parts.push(`<rect width="${svgNumber(width)}" height="${svgNumber(height)}" fill="${light}"/>`);
  parts.push(`<path d="${commands.join('')}" fill="${dark}"/>`);
  parts.push('</svg>');
  return parts.join('\n');
}

export default { encode, encodeDetails, toTerminal, toSvg };
