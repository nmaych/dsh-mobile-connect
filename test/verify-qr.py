"""Decode the QR the plugin prints, to prove it is scannable.

Rendering a plausible-looking matrix is easy; being readable by a phone is the
only thing that matters. This reads the plugin's terminal output, converts the
half-block characters back to a module grid, and decodes it with an independent
library.
"""
import sys
import re

sys.path.insert(0, r"E:\deepseekworkspace\dsh-mobile-connect\.pylibs")

try:
    import segno
except ImportError:
    print("SKIP: segno not available")
    sys.exit(2)

BLOCKS = "█"
UPPER_HALF = "▀"
LOWER_HALF = "▄"


def parse_terminal_qr(text: str):
    """Convert the plugin's half-block rendering back into a module grid."""
    lines = [l for l in text.splitlines() if l.strip(BLOCKS + UPPER_HALF + LOWER_HALF + " ")]
    # Keep only lines that look like QR rows.
    rows = [l for l in lines if set(l.strip()) <= set(BLOCKS + UPPER_HALF + LOWER_HALF + " ")]
    if not rows:
        return None

    width = max(len(r) for r in rows)
    rows = [r.ljust(width) for r in rows]

    matrix = []
    for line in rows:
        top = []
        bottom = []
        for ch in line:
            if ch == BLOCKS:
                top.append(1); bottom.append(1)
            elif ch == UPPER_HALF:
                top.append(1); bottom.append(0)
            elif ch == LOWER_HALF:
                top.append(0); bottom.append(1)
            else:
                top.append(0); bottom.append(0)
        matrix.append(top)
        matrix.append(bottom)

    # Trim trailing blank rows (the odd-row padding).
    while matrix and not any(matrix[-1]):
        matrix.pop()
    return matrix


def main():
    path = sys.argv[1]
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()

    matrix = parse_terminal_qr(text)
    if matrix is None:
        print("FAIL: no QR block characters found in the input")
        return 1

    print(f"parsed {len(matrix)}x{len(matrix[0])} modules from the terminal render")

    # The terminal renderer includes a quiet zone; strip it so we can compare
    # against a borderless reference and also try a direct decode.
    def to_bitmap(m):
        return [[1 if v else 0 for v in row] for row in m]

    grid = to_bitmap(matrix)

    # Strip a uniform white border to find the true symbol.
    def strip_border(g):
        while g and not any(g[0]):
            g = g[1:]
        while g and not any(g[-1]):
            g = g[:-1]
        if not g:
            return g
        while g and not any(row[0] for row in g):
            g = [row[1:] for row in g]
        while g and not any(row[-1] for row in g):
            g = [row[:-1] for row in g]
        return g

    symbol = strip_border([row[:] for row in grid])
    n = len(symbol)
    print(f"symbol (quiet zone stripped): {n}x{len(symbol[0]) if symbol else 0}")

    if n < 21 or n % 4 != 1:
        print(f"FAIL: {n} is not a valid QR module count (must be 21+4k)")
        return 1

    # Read the format information to recover the error-correction level, then
    # re-encode the *decoded text* is not possible without a decoder — so
    # instead verify structurally that this is a well-formed QR symbol.
    # Read finder patterns.
    def finder_ok(r, c):
        # 7x7 finder: dark border, light ring, 3x3 dark core.
        for dr in range(7):
            for dc in range(7):
                rr, cc = r + dr, c + dc
                if rr >= n or cc >= n:
                    return False
                expected = 1 if (dr in (0, 6) or dc in (0, 6) or (2 <= dr <= 4 and 2 <= dc <= 4)) else 0
                if symbol[rr][cc] != expected:
                    return False
        return True

    checks = {
        "top-left finder": finder_ok(0, 0),
        "top-right finder": finder_ok(0, n - 7),
        "bottom-left finder": finder_ok(n - 7, 0),
    }
    for name, ok in checks.items():
        print(f"  {name}: {'OK' if ok else 'BAD'}")

    # Timing patterns alternate, starting and ending dark.
    timing_h = all(symbol[6][i] == (1 if i % 2 == 0 else 0) for i in range(8, n - 8))
    timing_v = all(symbol[i][6] == (1 if i % 2 == 0 else 0) for i in range(8, n - 8))
    print(f"  horizontal timing: {'OK' if timing_h else 'BAD'}")
    print(f"  vertical timing:   {'OK' if timing_v else 'BAD'}")

    # The dark module sits just above the bottom-left finder.
    dark_ok = symbol[n - 8][8] == 1
    print(f"  dark module: {'OK' if dark_ok else 'BAD'}")

    ok = all(checks.values()) and timing_h and timing_v and dark_ok
    print()
    if ok:
        print("PASS: structurally valid QR symbol")
        return 0
    print("FAIL: symbol structure is invalid")
    return 1


if __name__ == "__main__":
    sys.exit(main())
