"""The names at a landing site can be read on a phone ("Still can't read the titles of the things at the site").

In the strip of what is here each name was 11 px white on the ground itself, in a 68 px column that cut a name of three lines
("Lunar Module descent stage") and broke words mid-way; the named craters on the picture were 11 px at 80 % white, and could lie
across one another. Now every name stands on a dark plate at 12 px or more, whole words in two lines, none cut, none on another.

Headless Chromium at a phone's size.

Run: pytest tests/test_almanac_site_labels_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_almanac_sites_browser as base  # noqa: E402

base.GL_ARGS.append("--disable-accelerated-2d-canvas")
served = base.served
page = base.page

# The strip is pictures: each button carries its name as its label (its own caption is clipped away), and the chosen thing's whole
# name stands on a line over the strip (#as-name). What is read on the picture is that line and the named craters.
NAMES = """() => Array.from(document.querySelectorAll('#as-name, #as-feats b')).filter(e => e.offsetWidth).map(e => {
  var r = e.getBoundingClientRect(), cs = getComputedStyle(e);
  return { t: e.textContent, strip: !!e.closest('#as-strip') || e.id === 'as-name', x: r.left, y: r.top, w: r.width, h: r.height, px: parseFloat(cs.fontSize),
    plate: cs.backgroundColor, cut: Math.round((e.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight)) > 2, dim: [e.scrollHeight, e.clientHeight, cs.lineHeight, e.clientWidth],
    words: e.textContent.split(/\\s+/).every(w => { var s = document.createElement('span'); s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + cs.font; s.textContent = w; document.body.appendChild(s); var ok = s.offsetWidth <= e.clientWidth; s.remove(); return ok; }) }; })"""


@pytest.mark.parametrize("body,site", [("moon", "Apollo 15"), ("mars", "Perseverance")])
def test_every_name_at_a_site_is_readable_whole_and_clear_of_the_others(page, body, site):
    base._visit(page, body, site)
    page.wait_for_timeout(3000)
    # Every button in the strip is named, and choosing the longest name puts it whole on the line over the strip.
    labels = page.evaluate("() => Array.from(document.querySelectorAll('#as-strip .as-item')).map(i => i.getAttribute('aria-label') || '')")
    assert labels and all(labels), labels
    longest = max(labels, key=len)
    page.evaluate(
        "(l) => Array.from(document.querySelectorAll('#as-strip .as-item')).filter(i => i.getAttribute('aria-label') === l)[0].click()",
        longest,
    )
    page.wait_for_timeout(500)
    line = page.evaluate(
        """() => { var n = document.getElementById('as-name'), r = n.getBoundingClientRect(), cs = getComputedStyle(n);
          return { said: n.textContent, px: parseFloat(cs.fontSize), oneLine: r.height < 2 * parseFloat(cs.fontSize),
            inside: r.left >= 0 && r.right <= innerWidth, whole: n.scrollWidth <= n.clientWidth }; }"""
    )
    assert line["said"] == longest and line["px"] >= 12 and line["oneLine"] and line["inside"] and line["whole"], line
    names = page.evaluate(NAMES)
    for n in names:
        assert n["px"] >= 12, n  # no smaller than this on a phone
        if not n["strip"]:
            assert n["plate"] not in ("rgba(0, 0, 0, 0)", "transparent"), n  # a crater's name stands on a plate
            assert not n["cut"], str(n["dim"]) + n["t"]
            assert n["words"], n
    boxes = [n for n in names if not n["strip"]]
    for i, a in enumerate(boxes):
        for b in boxes[i + 1 :]:
            assert not (
                a["x"] < b["x"] + b["w"]
                and b["x"] < a["x"] + a["w"]
                and a["y"] < b["y"] + b["h"]
                and b["y"] < a["y"] + a["h"]
            ), (a, b)
