"""Reference QR matrices from segno, for cross-checking ../lib/qr.js.

Usage (single case):
    python segno-matrix.py <errorLevel> <base64-utf8-text>

Usage (batch):
    python segno-matrix.py --batch <path-to-json-file>
    JSON file: [{"ec": "M", "b64": "<base64>"}, ...]

Output format (single case):
    VERSION <n>
    MASK <n>
    SIZE <n>
    ROWS
    <row of '0'/'1'>  x SIZE

Batch output uses "=== CASE <index>" separators before each single-case block.

The text is passed base64-encoded so that non-ASCII content survives the
Windows process boundary unchanged.

segno is forced into byte mode with UTF-8 so that the reference symbol is
directly comparable with qr.js, which always uses byte mode / UTF-8:
    - mode='byte'         -> never selects numeric/alphanumeric/kanji
    - encoding='utf-8'    -> never falls back to ISO-8859-1 for Latin-1 text
    - micro=False         -> Model 2 QR codes only, never Micro QR
    - boost_error=False   -> keep the requested error level exactly

Note: segno's ``Code.matrix`` does NOT include a quiet zone (contrary to what
the task description assumed) -- it is the bare ``version * 4 + 17`` matrix.
"""

import base64
import json
import sys

sys.path.insert(0, r"E:\deepseekworkspace\dsh-mobile-connect\.pylibs")

import segno  # noqa: E402


def emit(text, ec):
    try:
        qr = segno.make(text, error=ec, mode="byte", encoding="utf-8",
                        micro=False, boost_error=False)
    except segno.DataOverflowError:
        # The data does not fit in any version-40 symbol at this level.
        return "OVERFLOW"
    matrix = qr.matrix
    out = [f"VERSION {qr.version}", f"MASK {qr.mask}", f"SIZE {len(matrix)}", "ROWS"]
    for row in matrix:
        out.append("".join("1" if v else "0" for v in row))
    return "\n".join(out)


def main():
    argv = sys.argv[1:]
    if argv and argv[0] == "--batch":
        with open(argv[1], "r", encoding="utf-8") as fh:
            cases = json.load(fh)
        chunks = []
        for i, case in enumerate(cases):
            text = base64.b64decode(case["b64"]).decode("utf-8")
            chunks.append(f"=== CASE {i}\n{emit(text, case['ec'])}")
        print("\n".join(chunks))
        return 0

    if len(argv) == 1 and argv[0] == "--selftest":
        print(emit("HELLO WORLD", "M"))
        return 0

    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    ec, b64 = argv
    print(emit(base64.b64decode(b64).decode("utf-8"), ec))
    return 0


if __name__ == "__main__":
    sys.exit(main())
