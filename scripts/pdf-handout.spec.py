"""Synthetic regression tests for the bounded PDF handout sidecar."""

from __future__ import annotations

import importlib.util
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

import pypdfium2 as pdfium


sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("pdf-handout.py")
SPEC = importlib.util.spec_from_file_location("course_os_pdf_handout", SCRIPT)
handout = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = handout
SPEC.loader.exec_module(handout)


PAGE_W = 612
PAGE_H = 792


def _text(label: str, x: int, y: int) -> str:
    return f"BT /F1 12 Tf {x} {y} Td ({label}) Tj ET\n"


def _paired_page(label: str, cross_boundary: bool = False) -> dict:
    content = [
        "0 0 0 RG 1 w\n",
        "120 410 360 270 re S\n",
        "120 100 360 270 re S\n",
        _text(f"{label}_TOP", 140, 650),
        _text(f"{label}_BOTTOM", 140, 330),
        _text("1", 556, 20),
    ]
    if cross_boundary:
        # A table-like object touches both proposed regions and their gutter.
        content.append("255 330 90 120 re S\n")
    return {"content": "".join(content)}


def _single_slide(label: str) -> dict:
    return {
        "content": (
            "0 0 0 RG 1 w\n120 410 360 270 re S\n"
            + _text(label, 140, 650)
            + _text("3", 556, 20)
        )
    }


def _two_column_page() -> dict:
    return {
        "content": (
            "0 0 0 RG 1 w\n"
            + _text("LEFT_COLUMN_TEXT", 70, 650)
            + _text("RIGHT_COLUMN_TEXT", 340, 650)
            + _text("1", 556, 20)
        )
    }


def _pdf_bytes(pages: list[dict]) -> bytes:
    objects: dict[int, bytes] = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    page_refs: list[str] = []
    for index, item in enumerate(pages):
        page_ref = 4 + index * 2
        stream_ref = page_ref + 1
        page_refs.append(f"{page_ref} 0 R")
        stream = item["content"].encode("ascii")
        rotation = f" /Rotate {int(item.get('rotation', 0))}" if item.get("rotation") else ""
        page = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}]"
            f"{rotation} /Resources << /Font << /F1 3 0 R >> >>"
            f" /Contents {stream_ref} 0 R >>"
        ).encode("ascii")
        objects[page_ref] = page
        objects[stream_ref] = (
            f"<< /Length {len(stream)} >>\nstream\n".encode("ascii")
            + stream
            + b"endstream"
        )
    objects[2] = (
        f"<< /Type /Pages /Count {len(pages)} /Kids [{' '.join(page_refs)}] >>"
    ).encode("ascii")

    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0] * (max(objects) + 1)
    for object_id in range(1, max(objects) + 1):
        offsets[object_id] = len(output)
        output.extend(f"{object_id} 0 obj\n".encode("ascii"))
        output.extend(objects[object_id])
        output.extend(b"\nendobj\n")
    xref_offset = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        (
            f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(output)


def _decode_rgb_png(data: bytes) -> tuple[int, int, bytes]:
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise AssertionError("PNG signature missing")
    offset = 8
    width = height = color_type = bit_depth = None
    compressed = bytearray()
    while offset < len(data):
        size = struct.unpack(">I", data[offset : offset + 4])[0]
        kind = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + size]
        offset += size + 12
        if kind == b"IHDR":
            width, height, bit_depth, color_type, *_ = struct.unpack(">IIBBBBB", payload)
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break
    if bit_depth != 8 or color_type != 2:
        raise AssertionError("expected the sidecar's 8-bit RGB PNG")
    raw = zlib.decompress(compressed)
    row_bytes = width * 3
    pixels = bytearray(row_bytes * height)
    source = target = 0
    for _ in range(height):
        if raw[source] != 0:
            raise AssertionError("unexpected PNG row filter")
        source += 1
        pixels[target : target + row_bytes] = raw[source : source + row_bytes]
        source += row_bytes
        target += row_bytes
    return width, height, bytes(pixels)


class HandoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="course-os-pdf-handout-")
        self.root = Path(self.temp.name)
        self.source = self.root / "synthetic.pdf"

    def tearDown(self):
        self.temp.cleanup()

    def write(self, pages: list[dict]) -> Path:
        self.source.write_bytes(_pdf_bytes(pages))
        return self.source

    def test_repeated_frames_mixed_final_single_and_unsafe_page(self):
        self.write(
            [
                _paired_page("A"),
                _paired_page("B"),
                _single_slide("FINAL_SUMMARY"),
                _paired_page("C", cross_boundary=True),
                _two_column_page(),
                {**_paired_page("ROTATED"), "rotation": 90},
            ]
        )
        result = handout.run(
            str(self.source), {"purpose": "inspect"}, str(self.root / "inspect")
        )
        inspection = result["inspection"]
        self.assertEqual(inspection["physicalPageCount"], 6)
        self.assertEqual(inspection["logicalPageCount"], 8)
        self.assertEqual(result["pages"], [])
        self.assertLessEqual(len(inspection["previews"]), 6)
        self.assertEqual([page["mode"] for page in inspection["pages"]], [
            "top-bottom", "top-bottom", "top-bottom", "original", "original", "original"
        ])
        self.assertEqual(len(inspection["pages"][2]["regions"]), 1)
        self.assertIn("graphic", inspection["pages"][3]["reason"])
        self.assertEqual(inspection["pages"][3]["options"], ["original"])
        self.assertEqual(inspection["pages"][4]["options"], ["original"])
        self.assertEqual(inspection["pages"][5]["rotation"], 90)

        converted = handout.run(
            str(self.source), {"purpose": "convert"}, str(self.root / "converted")
        )
        self.assertEqual(len(converted["pages"]), 8)
        self.assertIn("A_TOP", converted["pages"][0]["text"])
        self.assertNotIn("A_BOTTOM", converted["pages"][0]["text"])
        self.assertIn("A_BOTTOM", converted["pages"][1]["text"])
        self.assertNotIn("A_TOP", converted["pages"][1]["text"])
        self.assertIn("FINAL_SUMMARY", converted["pages"][4]["text"])
        self.assertEqual(converted["pages"][-1]["sourceRegion"]["rotation"], 90)

        with self.assertRaises(handout.HandoutError) as error:
            handout.run(
                str(self.source),
                {"purpose": "convert", "choices": {"4": "top-bottom"}},
                str(self.root / "unsafe"),
            )
        self.assertEqual(error.exception.code, "PDF_LAYOUT_UNSAFE")

    def test_original_mode_preserves_each_page_pixel_for_pixel(self):
        self.write(
            [
                _paired_page("A"),
                _paired_page("B"),
                _single_slide("FINAL"),
                _two_column_page(),
                {**_paired_page("ROTATED"), "rotation": 90},
            ]
        )
        result = handout.run(
            str(self.source),
            {"purpose": "convert", "mode": "original"},
            str(self.root / "original"),
        )
        self.assertEqual(result["inspection"]["logicalPageCount"], 5)
        self.assertTrue(
            all(page["mode"] == "original" for page in result["inspection"]["pages"])
        )
        source = pdfium.PdfDocument(str(self.source))
        try:
            for index, output in enumerate(result["pages"]):
                actual = _decode_rgb_png(Path(output["imagePath"]).read_bytes())
                bitmap = source[index].render(
                    scale=handout.RENDER_SCALE,
                    rev_byteorder=True,
                    fill_color=(255, 255, 255, 255),
                    optimize_mode="print",
                )
                try:
                    expected = (
                        bitmap.width,
                        bitmap.height,
                        bytes(handout._bitmap_rgb(bitmap)),
                    )
                finally:
                    bitmap.close()
                self.assertEqual(actual, expected, f"original page {index + 1}")
        finally:
            source.close()

    def test_fingerprint_uses_effective_plan_and_is_stable(self):
        self.write([_paired_page("A"), _paired_page("B")])
        automatic = handout.run(
            str(self.source), {"purpose": "inspect"}, str(self.root / "auto")
        )["inspection"]
        repeated = handout.run(
            str(self.source), {"purpose": "inspect"}, str(self.root / "auto-again")
        )["inspection"]
        original = handout.run(
            str(self.source),
            {"purpose": "inspect", "mode": "original"},
            str(self.root / "whole"),
        )["inspection"]
        self.assertEqual(automatic["fingerprint"], repeated["fingerprint"])
        self.assertNotEqual(automatic["fingerprint"], original["fingerprint"])
        self.assertEqual(len(automatic["previews"]), 2)

    def test_left_right_frames_are_supported_in_reading_order(self):
        def horizontal(label: str) -> dict:
            return {
                "content": (
                    "0 0 0 RG 1 w\n"
                    "40 260 250 280 re S\n"
                    "322 260 250 280 re S\n"
                    + _text(f"{label}_LEFT", 60, 500)
                    + _text(f"{label}_RIGHT", 340, 500)
                )
            }

        self.write([horizontal("ONE"), horizontal("TWO")])
        result = handout.run(
            str(self.source), {"purpose": "convert"}, str(self.root / "lr")
        )
        self.assertEqual(result["inspection"]["pages"][0]["mode"], "left-right")
        self.assertIn("ONE_LEFT", result["pages"][0]["text"])
        self.assertIn("ONE_RIGHT", result["pages"][1]["text"])
        self.assertEqual(result["pages"][0]["sourceRegion"]["order"], 1)
        self.assertEqual(result["pages"][1]["sourceRegion"]["order"], 2)


if __name__ == "__main__":
    unittest.main()
