"""Odd One Out's setup sheet and the shared option rows, looked at the way a phone shows them: portrait, landscape and Hebrew.

Each case is a defect found by playing the game: the setup sheet opened scrolled to its Start button (the title half out of
the card); in landscape the Pictures choices ran past the card's edge and Players were slivers; in Hebrew and Arabic the
segmented controls rounded the wrong ends and the score's "+1" read "1+".

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_pa_oddone_layout.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from games_wait import frames, game_ready  # noqa: E402
from test_games_persist_browser import GAMES, browser  # noqa: E402,F401

import functools  # noqa: E402
import http.server  # noqa: E402
import threading  # noqa: E402

import pytest  # noqa: E402


@pytest.fixture(scope="module")
def served():
    """The games folder (PA_GAMES_DIR points it at another copy, to prove a test fails on old code)."""
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler,
        directory=os.environ.get("PA_GAMES_DIR") or GAMES,
    )
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()


PORTRAIT = {"width": 390, "height": 844}
LANDSCAPE = {"width": 844, "height": 390}
MIN_TOUCH_PX = 32


def open_setup(browser, served, view, lang=None):
    ctx = browser.new_context(
        viewport=view, has_touch=True, is_mobile=True, device_scale_factor=2
    )
    page = ctx.new_page()
    page.goto("%s/oddone.html%s" % (served, "#lang=%s&dir=rtl" % lang if lang else ""))
    game_ready(page, "window.__oddone")
    page.wait_for_selector("#oo-sheet:not([hidden]) .ar-sheet-card")
    frames(page, 4)
    return ctx, page


def test_the_setup_sheet_opens_at_its_top_not_scrolled_to_start(served, browser):
    for view in (PORTRAIT, LANDSCAPE):
        ctx, page = open_setup(browser, served, view)
        top = page.evaluate(
            "document.querySelector('#oo-sheet .ar-sheet-card').scrollTop"
        )
        assert top == 0, "the sheet opened scrolled %dpx down at %s" % (top, view)
        ctx.close()


def test_nothing_in_the_landscape_setup_runs_past_the_card_or_is_a_sliver(
    served, browser
):
    ctx, page = open_setup(browser, served, LANDSCAPE)
    bad = page.evaluate(
        """(min) => { const card = document.querySelector('#oo-sheet .ar-sheet-card').getBoundingClientRect(), out = [];
          for (const b of document.querySelectorAll('#oo-sheet .ar-sheet-card button')) { const r = b.getBoundingClientRect();
            if (!r.width) continue;
            if (r.right > card.right + 0.5 || r.left < card.left - 0.5) out.push(['past the card', b.textContent.trim(), Math.round(r.left), Math.round(r.right)]);
            if (r.width < min) out.push(['sliver', b.textContent.trim(), Math.round(r.width)]); }
          return out; }""",
        MIN_TOUCH_PX,
    )
    assert not bad, bad
    ctx.close()


def test_in_hebrew_the_first_segment_is_rounded_at_the_right_end(served, browser):
    ctx, page = open_setup(browser, served, PORTRAIT, "he")
    corners = page.evaluate(
        """() => { const seg = document.querySelector('#oo-sheet .gs-seg:not(.pl-grid)'), btns = [...seg.querySelectorAll('.ar-btn')];
          const radii = b => { const cs = getComputedStyle(b); return { tl: parseFloat(cs.borderTopLeftRadius), tr: parseFloat(cs.borderTopRightRadius) }; };
          const first = btns[0], last = btns[btns.length - 1];
          return { firstIsRight: first.getBoundingClientRect().left > last.getBoundingClientRect().left, first: radii(first), last: radii(last) }; }"""
    )
    assert corners["firstIsRight"], "the first option sits at the right in Hebrew"
    assert corners["first"]["tr"] > 0 and corners["first"]["tl"] == 0, corners
    assert corners["last"]["tl"] > 0 and corners["last"]["tr"] == 0, corners
    ctx.close()


def test_in_hebrew_points_and_lists_read_right_to_left(served, browser):
    ctx, page = open_setup(browser, served, PORTRAIT, "he")
    got = page.evaluate(
        """() => { const mk = (tag, cls, host) => { const e = document.createElement(tag); e.className = cls; host.appendChild(e); return e; };
          const host = document.createElement('div'); document.body.appendChild(host);
          const li = mk('li', '', mk('ul', 'oo-scores', host)), pts = mk('span', 'oo-pts', li), total = mk('span', 'oo-total', li);
          const order = mk('ol', 'oo-order', host);
          const cs = e => getComputedStyle(e);
          return { bidi: cs(pts).unicodeBidi, dir: cs(pts).direction, order: cs(order).textAlign, total: cs(total).textAlign }; }"""
    )
    assert got["bidi"] == "isolate" and got["dir"] == "ltr", (
        "'+1' must not turn into '1+': %s" % got
    )
    assert got["order"] in ("start", "right") and got["total"] in ("end", "left"), got
    ctx.close()
