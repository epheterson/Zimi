"""The Almanac page's corners on a phone, as the ZIM's readers meet them in ten languages.

- the clock reads 18:32, not 32:18, in Hebrew and Arabic, and a calendar's Latin month name is its own run in a right-to-left row
- no card label in the head is cut off, at 360 px, in any of the ten languages, and a row's tiles share a height and a value line

Run: pytest tests/test_almanac_corners_browser.py -v
"""

import os
import sys
import threading

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

LANGS = "ar de en es fr he hi pt ru zh".split()
NEW_YORK = '{"lat":40.71,"lon":-74.0,"name":"New York"}'
SYDNEY = '{"lat":-33.87,"lon":151.2,"name":"Sydney, Australia"}'
LONG = '{"lat":-77.8,"lon":166.7,"name":"McMurdo Station Antarctica Research Base"}'
SETTLE_MS = 5000


@pytest.fixture(scope="module")
def base(tmp_path_factory):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    env = pytest.MonkeyPatch()
    env.setenv("ZIMI_TORRENT", "0")
    env.setenv("ZIMI_OFFLINE", "1")
    root = tmp_path_factory.mktemp("alm_corners")
    (root / "zims").mkdir()
    (root / "data").mkdir()
    saved = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR)
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(root / "zims"), str(root / "data")
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = saved
    env.undo()


def _open(pw, base, lang="en", width=390, place=NEW_YORK, init=""):
    br = pw.chromium.launch()
    ctx = br.new_context(
        viewport={"width": width, "height": 844},
        device_scale_factor=2,
        has_touch=True,
        is_mobile=True,
        service_workers="block",
        locale=lang,
    )
    ctx.add_init_script(
        "try{localStorage.setItem('zimi_almanac_place',%r);localStorage.setItem('zimi_ui_lang',%r)}catch(e){};%s"
        % (place, lang, init)
    )
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    pg.goto(base + "/#almanac")
    pg.wait_for_selector("#almanac-head-time .ep", timeout=60000)
    pg.wait_for_timeout(SETTLE_MS)
    return br, pg, errs


@pytest.mark.parametrize("lang", ["he", "ar"])
def test_the_clock_reads_left_to_right_in_a_right_to_left_language(base, lang):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, errs = _open(pw, base, lang)
        x = pg.evaluate(
            "() => { const h = document.querySelector('#almanac-head-time .ep[data-p=\"hour\"]'),"
            " m = document.querySelector('#almanac-head-time .ep[data-p=\"min\"]');"
            " return [h.getBoundingClientRect().left, m.getBoundingClientRect().left]; }"
        )
        assert x[0] < x[1], "hours must stand left of minutes: %r" % x
        br.close()
        assert not errs, errs


def test_a_latin_month_is_its_own_run_in_a_hebrew_calendar_row(base):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, base, "he")
        rows = pg.evaluate(
            "() => { const d = document.createElement('div'); d.innerHTML = _almRenderCrossRef(_almSelectedJDN);"
            " return [...d.querySelectorAll('.alm-crossref-date')].map(e => e.innerHTML); }"
        )
        latin = [r for r in rows if "Aban" in r]
        assert latin and '<bdi dir="ltr">Aban</bdi>' in latin[0], rows
        # A row with no Latin in it is left alone.
        assert any("bdi" not in r for r in rows), rows
        br.close()


@pytest.mark.parametrize("lang", LANGS)
def test_no_head_label_is_cut_off_at_360(base, lang):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg, _ = _open(pw, base, lang, width=360)
        cut = pg.evaluate(
            "() => [...document.querySelectorAll('#almanac-head .alm-card-lbl')].filter(e => e.offsetParent)"
            ".map(e => { const s = getComputedStyle(e); return [e.innerText, e.scrollWidth - e.clientWidth, e.scrollHeight - e.clientHeight, s.textOverflow, s.whiteSpace]; })"
            ".filter(r => r[1] > 0 || r[2] > 0 || r[3] === 'ellipsis' || r[4] === 'nowrap')"
        )
        assert not cut, cut
        # Every tile is as tall as the others in its row, and its value sits on the same line as theirs.
        rows = pg.evaluate(
            "() => { const by = {}; [...document.querySelectorAll('#almanac-head .alm-card')].filter(e => e.offsetParent).forEach(e => {"
            " const r = e.getBoundingClientRect(), v = e.querySelector('.alm-card-val').getBoundingClientRect();"
            " (by[Math.round(r.top)] = by[Math.round(r.top)] || []).push([Math.round(r.height), Math.round(v.top)]); }); return Object.values(by); }"
        )
        assert sum(len(r) for r in rows) >= 5, rows
        for row in rows:
            assert max(h for h, _ in row) - min(h for h, _ in row) <= 1, rows
            assert max(v for _, v in row) - min(v for _, v in row) <= 1, rows
        # A row whose labels all fit on one line has no empty line above them.
        gaps = pg.evaluate(
            "() => { const by = {}; [...document.querySelectorAll('#almanac-head .alm-card')].filter(e => e.offsetParent).forEach(e => {"
            " const l = e.querySelector('.alm-card-lbl'); if (!l) return; const rg = document.createRange(); rg.selectNodeContents(l);"
            " const t = rg.getBoundingClientRect(), c = e.getBoundingClientRect();"
            " (by[Math.round(c.top)] = by[Math.round(c.top)] || []).push(Math.round(t.top - c.top)); }); return Object.values(by).map(r => Math.min(...r)); }"
        )
        assert gaps and max(gaps) <= 13, gaps
        br.close()
