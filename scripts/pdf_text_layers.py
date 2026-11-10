#!/usr/bin/env python3
"""How many PDF pages in a ZIM have no text layer (scans), for the OCR decision.

    python scripts/pdf_text_layers.py path/to/collection.zim [--json]

Reads every application/pdf entry with PyMuPDF (the same reader the document
index uses, zimi.docindex.pdf_scan) and reports, per PDF and in total, the
pages read and the pages that came back with no text. Counts only; builds
nothing and writes nothing. Needs PyMuPDF and libzim.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from zimi import docindex  # noqa: E402
from zimi import server as srv  # noqa: E402


def scan(zim_path):
    """``[{path, pages, blank}]`` for each PDF of the ZIM (blank: no text)."""
    archive = srv.open_archive(zim_path)
    out = []
    for entry, item in srv.walk_entries(archive, bounded=False):
        if (item.mimetype or "").lower() != docindex.PDF_MIME:
            continue
        try:
            _, pages, blank = docindex.pdf_scan(bytes(item.content))
        except Exception as e:  # a damaged PDF is reported, not fatal
            out.append({"path": entry.path, "pages": 0, "blank": 0, "error": str(e)})
            continue
        out.append({"path": entry.path, "pages": pages, "blank": blank})
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("zim")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    if not srv.HAS_PYMUPDF:
        sys.exit("PyMuPDF is not installed (pip install PyMuPDF)")
    rows = scan(args.zim)
    pages = sum(r["pages"] for r in rows)
    blank = sum(r["blank"] for r in rows)
    total = {"pdfs": len(rows), "pages": pages, "pages_without_text": blank}
    if args.json:
        print(json.dumps({"total": total, "pdfs": rows}, indent=2))
        return
    for r in rows:
        note = f"  ({r['error']})" if r.get("error") else ""
        print(f"{r['blank']:>6} / {r['pages']:<6} {r['path']}{note}")
    share = f" ({100 * blank / pages:.0f}%)" if pages else ""
    print(f"{len(rows)} PDFs, {pages} pages, {blank} without a text layer{share}")


if __name__ == "__main__":
    main()
