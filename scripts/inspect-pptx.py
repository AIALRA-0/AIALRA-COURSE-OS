import json
import pathlib
import posixpath
import sys
import zipfile
from urllib.parse import unquote, urlsplit
from xml.parsers import expat
from xml.etree import ElementTree

MAX_ENTRIES = 10000
MAX_ENTRY_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_RATIO = 120
PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
RELATIONSHIP_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_RELATIONSHIP_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def fail(code: str) -> None:
    print(json.dumps({"accepted": False, "issue": code}))
    raise SystemExit(2)


def safe_xml(data: bytes):
    parser = expat.ParserCreate()
    def reject(*args):
        fail("PPTX_XML_ENTITY_UNSAFE")
    parser.StartDoctypeDeclHandler = reject
    parser.EntityDeclHandler = reject
    parser.ExternalEntityRefHandler = reject
    try:
        parser.Parse(data, True)
        return ElementTree.fromstring(data)
    except (expat.ExpatError, ElementTree.ParseError):
        fail("PPTX_XML_INVALID")


def internal_target(relationship_path: str, raw_target: str) -> None:
    target = urlsplit(raw_target)
    path = unquote(target.path)
    if target.scheme or target.netloc or "\\" in path:
        fail("PPTX_EXTERNAL_RELATIONSHIP")
    # Resolve from the owning part, rather than the _rels file.
    base = posixpath.dirname(posixpath.dirname(relationship_path))
    parts = [] if path.startswith("/") else [p for p in base.split("/") if p]
    for part in path.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                fail("PPTX_PATH_TRAVERSAL")
            parts.pop()
        else:
            parts.append(part)


def slide_titles(archive: zipfile.ZipFile, names: set[str]) -> list[str]:
    relationship_path = "ppt/_rels/presentation.xml.rels"
    if relationship_path not in names:
        return []
    try:
        presentation = safe_xml(archive.read("ppt/presentation.xml"))
        relationships = safe_xml(archive.read(relationship_path))
        targets = {
            item.get("Id"): item.get("Target")
            for item in relationships.findall(f"{{{PACKAGE_RELATIONSHIP_NS}}}Relationship")
        }
        titles = []
        for item in presentation.findall(f".//{{{PRESENTATION_NS}}}sldId"):
            target = targets.get(item.get(f"{{{RELATIONSHIP_NS}}}id"))
            if not target:
                titles.append("")
                continue
            path = posixpath.normpath(target.lstrip("/") if target.startswith("/") else f"ppt/{target}")
            if path not in names:
                titles.append("")
                continue
            slide = safe_xml(archive.read(path))
            title = ""
            for shape in slide.findall(f".//{{{PRESENTATION_NS}}}sp"):
                placeholder = shape.find(f"{{{PRESENTATION_NS}}}nvSpPr/{{{PRESENTATION_NS}}}nvPr/{{{PRESENTATION_NS}}}ph")
                if placeholder is None or placeholder.get("type") not in ("title", "ctrTitle"):
                    continue
                paragraphs = shape.findall(f"{{{PRESENTATION_NS}}}txBody/{{{DRAWING_NS}}}p")
                title = " ".join(
                    "".join(node.text or "" for node in paragraph.findall(f".//{{{DRAWING_NS}}}t")).strip()
                    for paragraph in paragraphs
                ).strip()
                if title:
                    break
            titles.append(title)
        return titles
    except ElementTree.ParseError:
        return []


def main() -> None:
    source = pathlib.Path(sys.argv[1]).resolve()
    if not source.is_file():
        fail("PPTX_SOURCE_MISSING")
    try:
        with zipfile.ZipFile(source) as archive:
            infos = archive.infolist()
            names = {item.filename for item in infos}
            if len(names) != len(infos):
                fail("PPTX_DUPLICATE_ENTRY")
            if len(infos) > MAX_ENTRIES:
                fail("PPTX_TOO_MANY_ENTRIES")
            if "[Content_Types].xml" not in names or "ppt/presentation.xml" not in names:
                fail("PPTX_STRUCTURE_INVALID")
            total = 0
            for item in infos:
                normalized = pathlib.PurePosixPath(item.filename)
                if item.filename.startswith(("/", "\\")) or ".." in normalized.parts or "\\" in item.filename or ":" in normalized.parts[0]:
                    fail("PPTX_PATH_TRAVERSAL")
                if item.file_size > MAX_ENTRY_BYTES:
                    fail("PPTX_ENTRY_TOO_LARGE")
                total += item.file_size
                if total > MAX_TOTAL_BYTES:
                    fail("PPTX_EXPANDED_SIZE_TOO_LARGE")
                if item.compress_size > 0 and item.file_size / item.compress_size > MAX_RATIO:
                    fail("PPTX_COMPRESSION_RATIO_TOO_HIGH")
                if item.filename.lower().endswith((".xml", ".rels")) and item.file_size:
                    document = safe_xml(archive.read(item))
                    if not item.filename.lower().endswith(".rels"):
                        continue
                    if document.tag != f"{{{PACKAGE_RELATIONSHIP_NS}}}Relationships":
                        fail("PPTX_RELATIONSHIP_XML_INVALID")
                    for relationship in document.findall(f"{{{PACKAGE_RELATIONSHIP_NS}}}Relationship"):
                        raw_target = relationship.get("Target", "")
                        mode = relationship.get("TargetMode", "internal").lower()
                        if mode != "external":
                            internal_target(item.filename, raw_target)
                            continue
                        target = urlsplit(raw_target)
                        is_web_link = relationship.get("Type", "") == f"{RELATIONSHIP_NS}/hyperlink" and target.scheme.lower() in ("http", "https") and bool(target.hostname)
                        if not is_web_link or target.hostname == "169.254.169.254":
                            fail("PPTX_EXTERNAL_RELATIONSHIP")
            titles = slide_titles(archive, names)
    except (zipfile.BadZipFile, ValueError):
        fail("PPTX_ZIP_INVALID")
    print(json.dumps({"accepted": True, "entries": len(infos), "expandedBytes": total, "slideTitles": titles}))


if __name__ == "__main__":
    main()
