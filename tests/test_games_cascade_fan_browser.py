"""A cascade solitaire's fan opens into the height the phone has (FreeCell used the top 40 percent of the screen),
and a long column still fits.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_cascade_fan_browser.py -v
"""


import functools
import http.server
import json
import os
import threading
import time

import pytest

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)
PHONE = {"width": 390, "height": 844}


@pytest.fixture(scope="module")
def site():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=GAMES)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/" % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:
            pytest.skip("Chromium is not installed: %s" % e)
        yield b
        b.close()


@pytest.fixture
def phone(browser):
    ctx = browser.new_context(
        viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True
    )
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.errors = errors
    yield page
    ctx.close()


def open_game(page, site, name, wait_for, minimum_cards=1):
    page.goto(site + name + ".html")
    page.wait_for_function(wait_for, timeout=8000)
    page.wait_for_function(
        "(n) => document.querySelectorAll('.zc-card[data-id]').length >= n",
        arg=minimum_cards,
        timeout=8000,
    )
    page.wait_for_timeout(2500)  # the deal's cards fly in


def card_point(page, card_id):
    return page.evaluate(
        """(id) => { const e = document.querySelector('.zc-card[data-id="' + id + '"]'); if (!e) return null;
        const b = e.getBoundingClientRect(); return { x: b.x + Math.min(10, b.width / 3), y: b.y + b.height * 0.25 }; }""",
        card_id,
    )


def tap_card(page, card_id):
    p = card_point(page, card_id)
    for _ in range(20):
        assert p, "card %s is not on the table" % card_id
        page.wait_for_timeout(120)
        q = card_point(page, card_id)
        if q == p:
            break
        p = q
    page.touchscreen.tap(p["x"], p["y"])



# ── the fan opens into the height the phone has ──────────────────────────────

# The tallest column's cards by their own boxes: { cards, the widest step between two, card height, lowest edge }.
LONGEST_COLUMN = """() => {
  const cols = {};
  document.querySelectorAll('.zc-card[data-id]').forEach(e => {
    const b = e.getBoundingClientRect();
    (cols[Math.round(b.left)] = cols[Math.round(b.left)] || []).push({ top: Math.round(b.top), bottom: b.bottom, h: b.height });
  });
  // The tallest fan: the column whose cards spread over the most height (a stock or a foundation is a stack on one spot).
  const spread = c => Math.max(...c.map(x => x.top)) - Math.min(...c.map(x => x.top));
  const longest = Object.values(cols).sort((a, b) => spread(b) - spread(a))[0].sort((a, b) => a.top - b.top);
  const tops = [...new Set(longest.map(x => x.top))];
  return { n: tops.length, step: Math.max(...tops.slice(1).map((t, i) => t - tops[i]).filter(g => g <= longest[0].h)), h: longest[0].h, bottom: Math.max(...longest.map(x => x.bottom)), height: innerHeight };
}"""
OLD_FAN_SHARE = 0.34  # ZimiCards.FAN_UP_SHARE before the fan learnt to grow


@pytest.mark.parametrize(
    "name, ready",
    [
        (
            "freecell",
            "() => window.ZimiFreeCell && window.ZimiFreeCell.session && window.ZimiFreeCell.session.state",
        ),
        (
            "yukon",
            "() => window.ZimiYukon && window.ZimiYukon.session && window.ZimiYukon.session.state",
        ),
        (
            "spider",
            "() => window.ZimiSpider && window.ZimiSpider.session && window.ZimiSpider.session.state",
        ),
    ],
)
def test_the_fan_of_a_cascade_opens_into_the_height_the_phone_has(
    phone, site, name, ready
):
    open_game(phone, site, name, ready, 40)
    col = phone.evaluate(LONGEST_COLUMN)
    assert col["step"] > col["h"] * (OLD_FAN_SHARE + 0.1), (
        "the fan still huddles: %r" % col
    )
    assert col["bottom"] < col["height"], "the fan runs off the phone: %r" % col
    # With air under the lowest card: a fan that grew does not sit on the bottom edge.
    assert col["bottom"] < col["height"] - 20, "the fan sits on the phone's bottom edge: %r" % col
    assert not phone.errors


def test_a_long_column_still_fits_when_the_fan_has_grown(phone, site):
    """The step is the smaller of the room and the growth cap: a 19-card column of FreeCell does not leave the table."""
    open_game(
        phone,
        site,
        "freecell",
        "() => window.ZimiFreeCell && window.ZimiFreeCell.session && window.ZimiFreeCell.session.state",
        40,
    )
    phone.evaluate(
        """() => { const api = window.ZimiFreeCell, st = api.session.state, cols = Object.keys(st.piles).filter(k => /^c\\d|^col|^t\\d/.test(k) || (st.piles[k].length > 5 && k !== 'stock'));
          const all = [].concat(...cols.map(k => st.piles[k])); const to = cols[0];
          cols.forEach(k => { st.piles[k] = []; }); st.piles[to] = all.slice(0, 19); st.piles[cols[1]] = all.slice(19);
          api.session.reset ? api.session.reset(st) : null; }"""
    )
    phone.wait_for_timeout(1500)
    col = phone.evaluate(LONGEST_COLUMN)
    assert col["n"] >= 19
    assert col["bottom"] <= col["height"], "a long column runs off the phone: %r" % col
