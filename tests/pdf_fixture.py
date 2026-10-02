"""A real multi-page PDF for the PDF reader's tests: text on every page (so
pdf.js's find has something to find), an outline (so the contents sheet has
something to list), letter-sized pages. Written by hand, no dependency.

``multipage_pdf(pages=12)`` returns the bytes. Page ``n`` reads "Chapter n"
and a paragraph; page 7 alone carries the word "aquifer".
"""

_LOREM = (
    "Water is drawn from wells, rivers and rain. Each method of treatment "
    "removes something different: sediment settles, filters strain, boiling "
    "kills, and distillation leaves the salts behind."
)


def _page_stream(n):
    lines = ["Chapter %d" % n, ""]
    words = _LOREM.split()
    line = ""
    for w in words * 6:
        if len(line) + len(w) > 70:
            lines.append(line)
            line = ""
        line += w + " "
    lines.append(line)
    if n == 7:
        lines += ["", "The aquifer below the plain holds the town's water."]
    out = [
        "BT",
        "/F1 28 Tf",
        "72 700 Td",
        "(%s) Tj" % lines[0],
        "/F1 12 Tf",
        "0 -40 Td",
    ]
    for ln in lines[2:]:
        out.append("(%s) Tj" % ln.replace("(", "\\(").replace(")", "\\)"))
        out.append("0 -16 Td")
    out.append("ET")
    return "\n".join(out).encode("latin-1")


def multipage_pdf(pages=12, title="Water Treatment Handbook"):
    objs = {}
    # 1 catalog, 2 pages, 3 font, 4 outlines, 5 info; then page/content pairs, then outline items.
    first = 6
    page_ids = [first + 2 * i for i in range(pages)]
    outline_ids = [first + 2 * pages + i for i in range(pages)]
    objs[1] = b"<</Type/Catalog/Pages 2 0 R/Outlines 4 0 R/PageMode/UseNone>>"
    objs[2] = b"<</Type/Pages/Kids[%s]/Count %d>>" % (
        b" ".join(b"%d 0 R" % p for p in page_ids),
        pages,
    )
    objs[3] = b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"
    objs[4] = b"<</Type/Outlines/First %d 0 R/Last %d 0 R/Count %d>>" % (
        outline_ids[0],
        outline_ids[-1],
        pages,
    )
    # Everything About this PDF shows, so its test knows what to expect.
    objs[5] = (
        b"<</Title(%s)/Author(Ada Waters)/Subject(Treating water at home)"
        b"/Keywords(water, filters, boiling)/Creator(Zimi Test Writer)"
        b"/Producer(pdf_fixture.py)/CreationDate(D:20240815093000Z)"
        b"/ModDate(D:20240901120000Z)>>" % title.encode("latin-1")
    )
    for i, pid in enumerate(page_ids):
        stream = _page_stream(i + 1)
        objs[pid] = (
            b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents %d 0 R>>"
            % (pid + 1)
        )
        objs[pid + 1] = (
            b"<</Length %d>>stream\n" % len(stream) + stream + b"\nendstream"
        )
    for i, oid in enumerate(outline_ids):
        links = b""
        if i:
            links += b"/Prev %d 0 R" % outline_ids[i - 1]
        if i < pages - 1:
            links += b"/Next %d 0 R" % outline_ids[i + 1]
        objs[oid] = (
            b"<</Title(Chapter %d)/Parent 4 0 R/Dest[%d 0 R/XYZ 0 792 null]%s>>"
            % (
                i + 1,
                page_ids[i],
                links,
            )
        )
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for k in sorted(objs):
        offsets[k] = len(out)
        out += b"%d 0 obj\n" % k + objs[k] + b"\nendobj\n"
    xref = len(out)
    n = max(objs) + 1
    out += b"xref\n0 %d\n0000000000 65535 f \n" % n
    for k in range(1, n):
        out += b"%010d 00000 n \n" % offsets[k]
    out += b"trailer\n<</Size %d/Root 1 0 R/Info 5 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (
        n,
        xref,
    )
    return bytes(out)


if __name__ == "__main__":
    import sys

    sys.stdout.buffer.write(multipage_pdf())
