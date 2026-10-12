"""Extract numbered dish names from DOCX; never invent nutritional data.

Usage: python scripts/import-food-name-suggestions.py /path/to/foods.docx
Writes a reproducible compressed asset and provenance manifest, not DB rows.
"""
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile


def extract_names(path):
    with ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    text = "\n".join("".join(t.text or "" for t in p.findall(".//w:t", ns))
                     for p in root.findall(".//w:p", ns))
    entries = re.findall(r"(\d+)\)\s*(.*?)(?=\d+\)|$)", text, re.S)
    if not entries or [int(n) for n, _ in entries] != list(range(1, len(entries) + 1)):
        raise ValueError("Expected consecutive numbered dish names starting at 1")
    unique = {}
    for _, value in entries:
        name = " ".join(value.split())
        if not name or len(name) > 200:
            raise ValueError("Dish names must contain 1–200 characters")
        unique.setdefault(name.lower(), name)
    return sorted(unique.values(), key=str.lower), len(entries)


if __name__ == "__main__":
    source = Path(sys.argv[1])
    names, entry_count = extract_names(source)
    target = Path(__file__).resolve().parents[1] / "assets"
    payload = json.dumps(names, ensure_ascii=False, separators=(",", ":")).encode()
    compressed = gzip.compress(payload, mtime=0)
    (target / "food-name-suggestions.json.gz").write_bytes(compressed)
    manifest = {
        "source_document": source.name,
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "asset_sha256": hashlib.sha256(compressed).hexdigest(),
        "source_entries": entry_count,
        "unique_names": len(names),
        "nutrition_status": "unavailable",
        "description": "User-supplied names only; recipes, serving sizes and nutrition are unverified.",
    }
    (target / "food-name-suggestions.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"names": len(names), "compressed_bytes": len(compressed)}))
