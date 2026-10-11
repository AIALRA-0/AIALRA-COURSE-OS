"""Real ZIP/XML checks, without LibreOffice, network or private inputs."""
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile

INSPECTOR = pathlib.Path(__file__).with_name("inspect-pptx.py")
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
PART_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


class PptxInspection(unittest.TestCase):
    def run_package(self, members=(), relationships=None, compression=zipfile.ZIP_DEFLATED):
        with tempfile.TemporaryDirectory(prefix="course-os-inspect-") as tmp:
            file = pathlib.Path(tmp) / "fixture.pptx"
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(file, "w", compression=compression) as z:
                    z.writestr("[Content_Types].xml", "<Types />")
                    z.writestr("ppt/presentation.xml", "<presentation />")
                    if relationships is not None:
                        z.writestr("ppt/slides/_rels/slide1.xml.rels", relationships)
                    for name, data in members:
                        z.writestr(name, data)
            result = subprocess.run([sys.executable, "-B", str(INSPECTOR), str(file)], capture_output=True, text=True, timeout=10)
            self.assertTrue(result.stdout.strip(), result.stderr)
            return result.returncode, json.loads(result.stdout)

    def relationship(self, target, mode="Internal", kind="image"):
        return f'<Relationships xmlns="{REL_NS}"><Relationship Id="r1" Type="{PART_NS}/{kind}" Target="{target}" TargetMode="{mode}" /></Relationships>'

    def test_binary_and_literal_examples_are_not_security_fields(self):
        for compression in [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED]:
            with self.subTest(compression=compression):
                code, result = self.run_package([
                    ("ppt/media/image.bin", b"../ file:// <!ENTITY http://169.254.169.254"),
                    ("ppt/slides/slide1.xml", "<slide><text>&lt;!ENTITY example ../ file://</text></slide>")
                ], self.relationship("../media/image.bin"), compression)
                self.assertEqual(code, 0); self.assertTrue(result["accepted"])

    def test_valid_package_relative_targets_and_web_hyperlinks_remain_allowed(self):
        for target, mode, kind in [("../media/image.png", "Internal", "image"),
                                   ("/ppt/media/image.png", "Internal", "image"),
                                   ("https://example.org/course", "External", "hyperlink")]:
            with self.subTest(target=target):
                code, result = self.run_package(relationships=self.relationship(target, mode, kind))
                self.assertEqual(code, 0); self.assertTrue(result["accepted"])

    def test_unsafe_member_names_and_duplicate_members_are_rejected(self):
        for name in ["../evil.xml", "ppt/../../evil.xml", "/tmp/evil.xml", r"..\evil.xml", r"C:\evil.xml"]:
            with self.subTest(name=name):
                code, result = self.run_package([(name, "<x />")])
                self.assertEqual(code, 2); self.assertEqual(result["issue"], "PPTX_PATH_TRAVERSAL")
        code, result = self.run_package([("ppt/presentation.xml", "<other />")])
        self.assertEqual(code, 2); self.assertEqual(result["issue"], "PPTX_DUPLICATE_ENTRY")

    def test_real_external_resources_and_disguised_targets_are_rejected(self):
        cases = [("safe%3F/../../../../evil.xml", "Internal", "image"), ("safe%23/../../../../evil.xml", "Internal", "image"), ("file:///etc/not-a-real-file", "External", "image"),
                 ("http://169.254.169.254/", "External", "hyperlink"),
                 ("https://example.org/image.png", "External", "image"),
                 ("file:///etc/not-a-real-file", "Internal", "image"),
                 ("http://169.254.169.254/", "Internal", "image"),
                 ("../../../evil.xml", "Internal", "image"),
                 ("%2e%2e/%2e%2e/%2e%2e/evil.xml", "Internal", "image")]
        for compression in [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED]:
            for target, mode, kind in cases:
                with self.subTest(target=target, compression=compression):
                    code, result = self.run_package(relationships=self.relationship(target, mode, kind), compression=compression)
                    self.assertEqual(code, 2); self.assertFalse(result["accepted"])

    def test_entity_declarations_in_utf8_and_utf16_stop_before_consumer(self):
        text = '<?xml version="1.0"?><!DOCTYPE slide [<!ENTITY x SYSTEM "file:///not-a-real-file">]><slide>&x;</slide>'
        for encoding in ["utf-8", "utf-16"]:
            for member in ["ppt/slides/slide1.xml", "docProps/core.xml", "ppt/slides/_rels/slide1.xml.rels"]:
                with self.subTest(encoding=encoding, member=member):
                    code, result = self.run_package([(member, text.encode(encoding))])
                    self.assertEqual(code, 2); self.assertEqual(result["issue"], "PPTX_XML_ENTITY_UNSAFE")

    def test_malformed_xml_and_existing_expansion_limit_remain_rejected(self):
        code, result = self.run_package(relationships="<broken>")
        self.assertEqual(code, 2); self.assertEqual(result["issue"], "PPTX_XML_INVALID")
        code, result = self.run_package([("ppt/media/image.bin", b"a" * 50000)])
        self.assertEqual(code, 2); self.assertEqual(result["issue"], "PPTX_COMPRESSION_RATIO_TOO_HIGH")


if __name__ == "__main__":
    unittest.main()
