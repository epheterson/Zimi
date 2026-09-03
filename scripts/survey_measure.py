"""What the creation survey measures.

Three views of one job: the FLOW (what the progress stream felt like while
it ran), the ZIM (what was written), and the PAGE (what a phone-width
browser painted when it opened the result). Pure functions where possible;
the page measurement drives a Playwright page and is the one with side
effects (screenshots).
"""

import os
import re
import time

# Markup that has no business in rendered text. The first four are the
# attribute soup a captured cnn.com front page once opened on; the last two
# are the general case.
LEAK_MARKERS = [
    "data-fave-thumbnails",
    "data-source-html",
    'href="&quot;',
    "&quot;https://",
    "<div",
    "</a>",
]

_COUNT_RE = re.compile(r"(\d[\d,]*)\s+(assets|pages|images|entries|variants|queued)")


def flow_facts(events, started):
    """``events`` are ``{"ts": float, "line": str}`` records in arrival order;
    ``started`` is when the job was submitted. Returns when the first line
    arrived, the longest silence between lines, the lines whose counter went
    DOWN relative to the last time that counter was seen, and the count."""
    lines = [e for e in events if e.get("line")]
    if not lines:
        return {
            "first_line_s": None,
            "longest_gap_s": None,
            "backwards": [],
            "lines": 0,
        }
    first = round(lines[0]["ts"] - started, 2)
    gaps = [b["ts"] - a["ts"] for a, b in zip(lines, lines[1:])]
    longest = round(max(gaps), 2) if gaps else 0.0
    seen, backwards = {}, []
    for e in lines:
        for num, what in _COUNT_RE.findall(e["line"]):
            n = int(num.replace(",", ""))
            # "queued" is a frontier, and a frontier is supposed to shrink.
            if what != "queued" and what in seen and n < seen[what]:
                backwards.append(e["line"])
            seen[what] = n
    return {
        "first_line_s": first,
        "longest_gap_s": longest,
        "backwards": backwards,
        "lines": len(lines),
    }


def zim_facts(path):
    """Size, entry count, the Counter metadata as a dict, main path, title,
    and whether the mandatory 48px illustration is present."""
    from libzim.reader import Archive

    a = Archive(path)
    counter = {}
    try:
        raw = bytes(a.get_metadata("Counter")).decode("utf-8", "replace")
        for part in raw.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                counter[k.strip()] = int(v)
    except Exception:
        pass
    main = a.main_entry
    if main.is_redirect:
        main = main.get_redirect_entry()
    try:
        title = bytes(a.get_metadata("Title")).decode("utf-8", "replace")
    except Exception:
        title = ""
    return {
        "bytes": os.path.getsize(path),
        "entries": a.entry_count,
        "counter": counter,
        "main_path": main.path,
        "title": title,
        "illustration": bool(a.has_illustration(48)),
    }


_PAGE_JS = """async () => {
  const fr = document.querySelector('iframe'); const d = fr.contentDocument; const w = fr.contentWindow;
  const under = d.elementFromPoint(200, 20); const cs = under ? w.getComputedStyle(under) : null;
  const text = d.body ? (d.body.innerText || '') : '';
  return {
    images: d.images.length, painted: [...d.images].filter(i => i.naturalWidth > 0).length,
    text_chars: text.length, text_head: text.slice(0, 4000),
    under_topbar: under ? {tag: under.tagName, cls: (under.className || '').toString().slice(0, 60),
                           bg: cs.backgroundColor, h: Math.round(under.getBoundingClientRect().height)} : null,
    scroll_h: d.documentElement.scrollHeight, title: d.title,
  };
}"""


def page_facts(page, base, name, shots_dir):
    """Open ``/w/<name>`` in ``page`` (already sized to a phone), scroll to the
    bottom, and report what painted. Two screenshots land in ``shots_dir``."""
    os.makedirs(shots_dir, exist_ok=True)
    wire, errors = [], []
    page.on(
        "response", lambda r: wire.append(int(r.headers.get("content-length") or 0))
    )
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    t0 = time.time()
    page.goto(base + "/w/" + name, wait_until="load", timeout=120000)
    load_s = round(time.time() - t0, 2)
    page.wait_for_timeout(1200)
    shots = [os.path.join(shots_dir, "top.png")]
    page.screenshot(path=shots[0], timeout=20000)
    height = page.evaluate(
        "document.querySelector('iframe').contentDocument.documentElement.scrollHeight"
    )
    for y in range(0, int(height), 700):
        page.evaluate(
            "y => document.querySelector('iframe').contentWindow.scrollTo(0, y)", y
        )
        page.wait_for_timeout(80)
        if y == 700:
            shots.append(os.path.join(shots_dir, "one-down.png"))
            page.screenshot(path=shots[-1], timeout=20000)
    page.wait_for_timeout(2000)
    facts = page.evaluate(_PAGE_JS)
    leaked = [m for m in LEAK_MARKERS if m in facts.pop("text_head")]
    facts.update(
        load_s=load_s,
        leaked=leaked,
        console_errors=errors[:5],
        requests=len(wire),
        wire_bytes=sum(wire),
        shots=shots,
    )
    return facts
