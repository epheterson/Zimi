"""The 3D view's search sheet is three plain parts, each one outcome, and no name in it is ever cut.

"This view still cuts off the name of things and some objects have models out there, sites to
see and launches to watch, and the list kinda links it together weirdly, it's hard to know what will happen when I tap. The main
list should be objects to fly to and see. Then landing sites. Then launches."

The list is: things to fly to (bodies, spacecraft, what was sent), places to stand (landing sites, pads, the landers on their
worlds), launches to watch (a mission opens at its liftoff). A part's rows carry one cue (the walker on a place to stand, the
rocket on a launch). A name wraps to as many lines as it needs, in the grid, the list, Sent and the search answers.

Run: pytest tests/test_almanac_sheet_regroup_browser.py -v
"""

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from test_almanac_places_browser import GL_ARGS, library  # noqa: E402,F401
from test_almanac_go_sheet_browser import LANDSCAPE, PORTRAIT, _open  # noqa: E402

DESKTOP = {"width": 1280, "height": 900}

# Every element in the sheet that carries a name, and whether the browser cuts it.
CUT_NAMES = """() => {
  var cut = [];
  var sheet = document.querySelector('#ae-go');
  Array.from(sheet.querySelectorAll('.ae-go-row, .ae-sent-pick')).forEach(function (row) {
    Array.from(row.querySelectorAll('span:not(.ae-go-thumb):not(.ae-go-mark), b, small')).forEach(function (n) {
      if (n.closest('.ae-go-thumb') || !n.textContent.trim()) return;
      var cs = getComputedStyle(n), r = [];
      if (n.scrollWidth > n.clientWidth + 1) r.push('wider');
      if (n.scrollHeight > n.clientHeight + 1) r.push('taller');
      if (cs.textOverflow === 'ellipsis') r.push('ellipsis');
      if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') r.push('clamp');
      if (r.length) cut.push(n.textContent.trim().slice(0, 40) + ' ' + r.join(','));
    });
  });
  return cut;
}"""

# The sheet's rows in document order: [kind of node, text or key].
SEQUENCE = """() => {
  var host = document.querySelector('#ae-go-groups'), out = [];
  Array.from(host.querySelectorAll('h4.ae-go-sec, h4[data-g], [data-ae-go]')).forEach(function (n) {
    if (n.tagName === 'H4') out.push(['h', n.textContent.trim(), n.className]);
    else out.push(['k', n.getAttribute('data-ae-go'), (n.querySelector('.ae-go-mark') || {}).dataset ? n.querySelector('.ae-go-mark').dataset.mark : '']);
  });
  return out;
}"""


def _sheet(pw, base, view, mode, scheme="light"):
    br = pw.chromium.launch(args=GL_ARGS)
    ctx, pg, errors = _open(br, base, view, scheme)
    pg.evaluate("v => localStorage.setItem('zimi_go_view', v)", mode)
    pg.click("#ae-find")
    pg.wait_for_selector("#ae-go", state="visible")
    pg.wait_for_function("() => !!_aeLm && !!_aeSent && !!_aeTracks", timeout=60_000)
    pg.wait_for_timeout(800)
    pg.evaluate("_aeGoRender()")
    return br, pg, errors


@pytest.mark.parametrize("mode", ["grid", "list"])
def test_the_list_is_things_to_fly_to_then_places_to_stand_then_launches(library, mode):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _sheet(pw, library, PORTRAIT, mode)
        try:
            seq = pg.evaluate(SEQUENCE)
            parts = [s[1] for s in seq if s[0] == "h" and "ae-go-sec" in s[2]]
            assert parts == ["Fly to", "Landing sites", "Launches"], parts
            at = {p: i for i, p in enumerate(s[1] for s in seq if s[0] == "h" and "ae-go-sec" in s[2])}
            part = None
            kinds = {"Fly to": set(), "Landing sites": set(), "Launches": set()}
            for s in seq:
                if s[0] == "h" and "ae-go-sec" in s[2]:
                    part = s[1]
                elif s[0] == "k" and part:
                    kinds[part].add(s[1].split(":")[0] if ":" in s[1] else "body")
            # Bodies and spacecraft are flown to; landing sites, pads and (grid) landers are stood at; a mission is a launch.
            assert kinds["Fly to"] <= {"body", "sent"}, kinds
            assert {"lm", "pad"} <= kinds["Landing sites"] and kinds["Landing sites"] <= {"lm", "pad", "sent"}, kinds
            assert kinds["Launches"] == {"ms"}, kinds
            # The three sections hold the keys the old groups held, none dropped.
            keys = [s[1] for s in seq if s[0] == "k"]
            assert keys.index("earth") < keys.index("lm:moon:0") < keys.index("pad:apollo11") < keys.index("ms:apollo11")
            # One cue per part: the walker on every place to stand, the rocket on every launch, nothing on a thing to fly to.
            for s in seq:
                if s[0] != "k":
                    continue
                want = "launch" if s[1].startswith("ms:") else "walk" if s[1].startswith(("lm:", "pad:")) else ""
                assert s[2] == want, s
            assert not errors, errors
        finally:
            br.close()


# A tile or row that wraps its name stands on the one below it: no two rows of a list overlap, and no name breaks inside a word.
OVERLAPS = """() => {
  var bad = [];
  Array.from(document.querySelectorAll('#ae-go .ae-go-list, #ae-go .ae-sent-tiles')).forEach(function (l) {
    var rs = Array.from(l.children).filter(function (c) { return c.classList.contains('ae-go-row'); }).map(function (c) { return [c, c.getBoundingClientRect()]; });
    for (var i = 0; i < rs.length; i++) for (var j = i + 1; j < rs.length; j++) {
      var a = rs[i][1], b = rs[j][1];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(rs[i][0].textContent.trim() + ' / ' + rs[j][0].textContent.trim());
    }
  });
  Array.from(document.querySelectorAll('#ae-go .ae-go-row span:not(.ae-go-thumb):not(.ae-go-mark)')).forEach(function (n) {
    if (n.closest('.ae-go-thumb') || n.children.length) return;
    var words = n.textContent.trim().split(/\\s+/), probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + getComputedStyle(n).font;
    document.body.appendChild(probe);
    // (a word wider than its box may only break where it hyphenates, never mid-letter)
    words.forEach(function (w) { probe.textContent = w; if (probe.getBoundingClientRect().width > n.clientWidth + 1 && getComputedStyle(n).hyphens !== 'auto') bad.push('broken word: ' + w); });
    probe.remove();
  });
  return bad;
}"""


@pytest.mark.parametrize("mode", ["grid", "list"])
def test_wrapped_names_overlap_nothing_and_break_no_word_on_the_phone(library, mode):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _sheet(pw, library, PORTRAIT, mode)
        try:
            bad = pg.evaluate(OVERLAPS)
            assert not bad, "\n".join(bad)
        finally:
            br.close()


@pytest.mark.parametrize("mode", ["grid", "list"])
@pytest.mark.parametrize("name,view", [("portrait", PORTRAIT), ("landscape", LANDSCAPE), ("desktop", DESKTOP)])
def test_no_name_in_the_sheet_is_cut(library, name, view, mode):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _sheet(pw, library, view, mode)
        try:
            assert pg.evaluate(CUT_NAMES) == []
            pg.evaluate("_aeGoJump('sent')")   # the Sent list, rows with their words under the name
            pg.wait_for_timeout(300)
            assert pg.evaluate(CUT_NAMES) == []
            pg.evaluate("_aeGoJump('all')")
            pg.fill("#ae-go-q", "o")   # the search answers, one list of every part
            pg.wait_for_timeout(500)
            assert pg.evaluate(CUT_NAMES) == []
            assert not errors, errors
        finally:
            br.close()


SPY = """() => {
  window.__called = [];
  ['_aePreset', '_aeGoVisit', '_aeMissionStart', '_aeGoPad', '_aeSentPick'].forEach(function (n) {
    window[n] = function () { window.__called.push([n, Array.prototype.slice.call(arguments).map(function (a) { return typeof a === 'string' ? a : (a && a.row ? a.body + ':' + a.row[0] : '?'); })]); };
  });
}"""


def test_a_tap_does_the_one_thing_its_part_promises(library):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errors = _sheet(pw, library, PORTRAIT, "list")
        try:
            pg.evaluate(SPY)
            taps = [
                ("mercury", ["_aePreset", ["mercury"]]),   # a thing to fly to: the camera goes there
                ("lm:moon:0", ["_aeGoVisit", ["moon:Apollo 11"]]),   # a place to stand: its site, its card
                ("ms:apollo11", ["_aeMissionStart", ["apollo11"]]),   # a launch: that mission, from its start
            ]
            for key, want in taps:
                pg.evaluate("() => { window.__called.length = 0; _aeShowGo(true); _aeGoRender(); }")
                pg.evaluate("k => document.querySelector('#ae-go-groups [data-ae-go=\"' + k + '\"]').scrollIntoView()", key)
                pg.click('#ae-go-groups [data-ae-go="%s"]' % key)
                assert pg.evaluate("window.__called") == [want], (key, pg.evaluate("window.__called"))
        finally:
            br.close()
