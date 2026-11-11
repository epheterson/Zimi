"""A court card's picture fills the card under the index, and a covered court in a fan shows its index row only.

Two invariants, measured in Solitaire on phone, tablet and desktop tables:
- the picture frame is one even margin in from the left, right and bottom, and fills the card under the index row:
  frame width / card width >= 0.86 and frame height / (card height less the index row) >= 0.92, for all twelve courts;
- in a fanned column a covered court shows its index row and no part of the frame or its picture.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_court_fill_browser.py -v
(ZIMI_GAMES_DIR points the test at another copy of the games folder, to prove it fails on an older one.)
"""

import functools
import http.server
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import GAMES, browser  # noqa: E402,F401

pytest.importorskip("playwright")

FACE_W, FACE_H, INDEX_ROW = (
    100,
    140,
    40,
)  # a face's units; the index row ends where the picture frame starts (COURT_TOP)
MIN_W, MIN_H = 0.86, 0.92
SIZES = [(390, 844), (820, 1100), (1440, 900)]
KINGS = {"K": 13, "Q": 12, "J": 11}


def cid(rank, suit):
    return suit * 13 + rank - 1


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def served():
    handler = functools.partial(
        _Quiet, directory=os.environ.get("ZIMI_GAMES_DIR", GAMES)
    )
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % srv.server_address[1]
    srv.shutdown()


SET_TABLE = """(spec) => {
  const s = JSON.parse(JSON.stringify(ZimiSolitaire.session.state));
  Object.keys(s.piles).forEach(k => s.piles[k] = []);
  Object.keys(spec).forEach(k => s.piles[k] = spec[k].map(([id, up]) => ({ id, up: !!up })));
  ZimiSolitaire.session.reset(s);
}"""


def open_table(browser, served, width, height, spec):
    ctx = browser.new_context(viewport={"width": width, "height": height})
    page = ctx.new_page()
    page.goto("%s/solitaire.html" % served)
    page.wait_for_function(
        "() => window.ZimiSolitaire && ZimiSolitaire.session && ZimiSolitaire.session.state"
    )
    page.wait_for_selector(".zc-card:not(.zc-off)")
    page.evaluate(SET_TABLE, spec)
    page.wait_for_function(
        "(n) => document.querySelectorAll('.zc-card:not(.zc-off)').length >= n",
        arg=sum(len(v) for v in spec.values()),
    )
    page.wait_for_timeout(900)
    return ctx, page


@pytest.mark.parametrize("width,height", SIZES, ids=lambda v: str(v))
def test_a_court_frame_fills_the_card_under_the_index(browser, served, width, height):
    # Every court alone at the bottom of a column (seven columns: K, Q, J of two suits and one more), twice.
    ids = [cid(r, s) for s in range(4) for r in (13, 12, 11)]
    cols = ["t%d" % i for i in range(7)]
    for batch in (ids[:7], ids[7:]):
        ctx, page = open_table(
            browser, served, width, height, {c: [[i, 1]] for c, i in zip(cols, batch)}
        )
        rows = page.evaluate(
            """() => [...document.querySelectorAll('.zc-card:not(.zc-off)')].map(c => {
            const r = c.getBoundingClientRect(), f = c.querySelector('.zc-ct-row .zc-rule').getBoundingClientRect();
            return { id: +c.dataset.id, cw: r.width, ch: r.height, fw: f.width, fh: f.height,
                     left: f.left - r.left, right: r.right - f.right, bottom: r.bottom - f.bottom, top: f.top - r.top };
        })"""
        )
        assert len(rows) == len(batch)
        for r in rows:
            row_h = r["ch"] * INDEX_ROW / FACE_H
            assert r["fw"] / r["cw"] >= MIN_W, r
            assert r["fh"] / (r["ch"] - row_h) >= MIN_H, r
            # one margin on three sides (a pixel of rounding), the picture starts under the index row
            assert (
                max(r["left"], r["right"], r["bottom"])
                - min(r["left"], r["right"], r["bottom"])
                < 1.0
            ), r
            assert r["top"] >= row_h - 1.0, r
        ctx.close()


@pytest.mark.parametrize("width,height", SIZES, ids=lambda v: str(v))
def test_a_covered_court_shows_its_index_row_only(browser, served, width, height):
    # K, Q, J, 10 of a suit fanned face up in each of four columns: the K, Q and J are covered.
    spec = {"t%d" % s: [[cid(r, s), 1] for r in (13, 12, 11, 10)] for s in range(4)}
    ctx, page = open_table(browser, served, width, height, spec)
    rows = page.evaluate(
        """(spec) => {
        const out = [];
        Object.keys(spec).forEach(col => {
          const cards = spec[col].map(([id]) => document.querySelector('.zc-card[data-id="' + id + '"]'));
          cards.slice(0, -1).forEach((c, i) => {
            const r = c.getBoundingClientRect(), f = c.querySelector('.zc-ct-row .zc-rule').getBoundingClientRect();
            out.push({ id: spec[col][i][0], shown: cards[i + 1].getBoundingClientRect().top - r.top, frameTop: f.top - r.top, ch: r.height });
          });
        });
        return out;
    }""",
        spec,
    )
    assert len(rows) == 12
    for r in rows:
        assert r["shown"] > r["ch"] * 0.15, r  # the index row is still readable
        assert (
            r["shown"] <= r["frameTop"] + 0.01
        ), r  # and none of the frame or its picture shows
    ctx.close()
