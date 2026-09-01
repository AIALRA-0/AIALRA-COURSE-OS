import json
import pathlib
import re
import sys
import zipfile

MAX_ENTRIES = 10000
MAX_ENTRY_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_RATIO = 120


def fail(code: str) -> None:
    print(json.dumps({"accepted": False, "issue": code}))
    raise SystemExit(2)


def main() -> None:
    source = pathlib.Path(sys.argv[1]).resolve()
    if not source.is_file():
        fail("PPTX_SOURCE_MISSING")
    try:
        with zipfile.ZipFile(source) as archive:
            infos = archive.infolist()
            names = {item.filename for item in infos}
            if len(infos) > MAX_ENTRIES:
                fail("PPTX_TOO_MANY_ENTRIES")
            if "[Content_Types].xml" not in names or "ppt/presentation.xml" not in names:
                fail("PPTX_STRUCTURE_INVALID")
            total = 0
            for item in infos:
                normalized = pathlib.PurePosixPath(item.filename)
                if item.filename.startswith(("/", "\\")) or ".." in normalized.parts:
                    fail("PPTX_PATH_TRAVERSAL")
                if item.file_size > MAX_ENTRY_BYTES:
                    fail("PPTX_ENTRY_TOO_LARGE")
                total += item.file_size
                if total > MAX_TOTAL_BYTES:
                    fail("PPTX_EXPANDED_SIZE_TOO_LARGE")
                if item.compress_size > 0 and item.file_size / item.compress_size > MAX_RATIO:
                    fail("PPTX_COMPRESSION_RATIO_TOO_HIGH")
                if item.filename.endswith(".rels") and item.file_size:
                    body = archive.read(item).decode("utf-8", errors="ignore")
                    if re.search(r'TargetMode\s*=\s*["\']External["\']', body, re.I):
                        fail("PPTX_EXTERNAL_RELATIONSHIP")
    except zipfile.BadZipFile:
        fail("PPTX_ZIP_INVALID")
    print(json.dumps({"accepted": True, "entries": len(infos), "expandedBytes": total}))


if __name__ == "__main__":
    main()
