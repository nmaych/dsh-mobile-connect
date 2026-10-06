"""Independent decoders for QR matrices produced by lib/qr.js.

This is the strongest available evidence that a symbol is genuinely scannable:
the matrix is rasterised with a quiet zone and handed to third-party decoders
that know nothing about our encoder. They must recover the exact original text.

Decoders (used in this order, whichever are importable):
  1. ZXing-C++  -- the C++ port of ZXing, the library behind most real-world
                   scanner apps. This is the primary, authoritative check.
  2. OpenCV     -- cv2.QRCodeDetector, a useful secondary signal. Its detector
                   is known to give up on very dense symbols (we confirmed it
                   fails identically on segno's byte-identical output for the
                   same inputs), so a ZXing pass is what decides the verdict.

Reads a JSON request file:
    {"cases": [{"label": "...", "b64": "<base64 utf-8 text>",
                "rows": ["0101...", ...],           # module grid to decode
                "terminal": "...",                  # optional: decode this
                                                    # toTerminal() output instead
                "control": ["0101...", ...],        # optional reference matrix
                "controlTerminal": "..."            # optional reference terminal
               }]}
Writes one JSON result object per line to stdout:
    {"label": ..., "ok": true, "decoders": {"zxingcpp": "scale=8,qz=4"}}
    {"label": ..., "ok": false, "error": "..."}

The optional ``control`` / ``controlTerminal`` fields carry the reference
encoder's output for the same payload. When the primary decoder rejects ours,
the same decoder is run on the control: if it rejects that too, the symbol is
provably fine and the decoder is the limitation.
"""

import base64
import json
import os
import sys

sys.path.insert(
    0,
    os.environ.get(
        "QR_DECODER_LIBS", r"E:\deepseekworkspace\dsh-mobile-connect\.pylibs-decoders"
    ),
)

import numpy as np  # noqa: E402

try:
    import zxingcpp  # noqa: E402
except ImportError:  # pragma: no cover
    zxingcpp = None

try:
    import cv2  # noqa: E402
except ImportError:  # pragma: no cover
    cv2 = None

# (module size in pixels, quiet zone in modules), most standard first.
RASTERISATIONS = (
    (8, 4),
    (4, 4),
    (6, 6),
    (10, 8),
    (16, 4),
    (12, 8),
    (20, 8),
)


def rasterise(rows, scale, quiet_zone):
    """Turn module rows into a uint8 image (255 light, 0 dark).

    Rows may be strings of '0'/'1' (as produced by the matrix comparison) or
    sequences of 0/1 ints (as produced by parse_terminal), so the test is on the
    character value rather than on identity.
    """
    grid = np.array(
        [[0 if str(c) == "1" else 255 for c in row] for row in rows], dtype=np.uint8
    )
    padded = np.full(
        (grid.shape[0] + 2 * quiet_zone, grid.shape[1] + 2 * quiet_zone), 255, dtype=np.uint8
    )
    padded[quiet_zone:quiet_zone + grid.shape[0], quiet_zone:quiet_zone + grid.shape[1]] = grid
    return np.kron(padded, np.ones((scale, scale), dtype=np.uint8))


# Half-block glyphs emitted by toTerminal(): each text cell is two stacked
# modules, so the terminal rendering can be parsed back into a module grid and
# decoded. This checks the *renderer*, not just the encoder.
DARK_GLYPH = "\u2588"     # full block -> both modules dark
UPPER_GLYPH = "\u2580"    # upper half -> top dark, bottom light
LOWER_GLYPH = "\u2584"    # lower half -> top light, bottom dark
LIGHT_GLYPH = " "         # space      -> both light


def parse_terminal(text):
    """Rebuild a module grid from `toTerminal()` output (2 module rows/line)."""
    grid = []
    for line in text.split("\n"):
        if line == "":
            continue
        top = []
        bottom = []
        for ch in line:
            if ch == DARK_GLYPH:
                top.append(1)
                bottom.append(1)
            elif ch == UPPER_GLYPH:
                top.append(1)
                bottom.append(0)
            elif ch == LOWER_GLYPH:
                top.append(0)
                bottom.append(1)
            elif ch == LIGHT_GLYPH:
                top.append(0)
                bottom.append(0)
            else:
                raise ValueError(f"unexpected glyph {ch!r} (U+{ord(ch):04X})")
        grid.append(top)
        grid.append(bottom)
    return grid


def decode_zxingcpp(rows, expected):
    """Return a description of the first rasterisation ZXing decodes, else None."""
    for scale, quiet_zone in RASTERISATIONS:
        img = rasterise(rows, scale, quiet_zone)
        try:
            results = zxingcpp.read_barcodes(img)
        except Exception:  # pragma: no cover
            continue
        for r in results:
            if r.format == zxingcpp.BarcodeFormat.QRCode and r.text == expected:
                return f"scale={scale}, quietZone={quiet_zone}"
    return None


def decode_opencv(rows, expected):
    """Return a description of the first rasterisation OpenCV decodes, else None."""
    detector = cv2.QRCodeDetector()
    for scale, quiet_zone in RASTERISATIONS:
        img = rasterise(rows, scale, quiet_zone)
        try:
            text, points, _ = detector.detectAndDecode(img)
        except cv2.error:  # pragma: no cover
            continue
        if text == expected and points is not None and len(points) > 0:
            return f"scale={scale}, quietZone={quiet_zone}"
    return None


def decode_all(rows, expected):
    """Run every available decoder over one matrix."""
    out = {}
    if zxingcpp is not None:
        out["zxingcpp"] = decode_zxingcpp(rows, expected)
    if cv2 is not None:
        out["opencv"] = decode_opencv(rows, expected)
    return out


def main():
    if zxingcpp is None and cv2 is None:
        print("no decoder available", file=sys.stderr)
        return 2

    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        request = json.load(fh)

    for case in request["cases"]:
        expected = base64.b64decode(case["b64"]).decode("utf-8")

        # `terminal` means "decode the renderer's text output"; the module grid
        # is recovered by parsing the half-block glyphs.
        rows = parse_terminal(case["terminal"]) if case.get("terminal") else case["rows"]
        decoders = decode_all(rows, expected)

        payload = {"label": case["label"], "decoders": decoders}

        # ZXing-C++ is authoritative when present; otherwise use OpenCV.
        primary = "zxingcpp" if zxingcpp is not None else "opencv"
        payload["primary"] = primary
        payload["ok"] = decoders.get(primary) is not None

        # When the primary decoder fails, decode the equivalent reference output
        # as well, so the harness can distinguish an encoder/renderer defect from
        # a decoder limitation. The control uses the same representation (plain
        # grid vs terminal text) as the case under test.
        if not payload["ok"]:
            control_rows = None
            if case.get("terminal") and case.get("controlTerminal"):
                control_rows = parse_terminal(case["controlTerminal"])
            elif case.get("control"):
                control_rows = case["control"]
            if control_rows is not None:
                payload["controlDecoders"] = decode_all(control_rows, expected)
                payload["controlIdentical"] = control_rows == rows

        if not payload["ok"]:
            payload["error"] = f"{primary}: not decoded"
        print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
