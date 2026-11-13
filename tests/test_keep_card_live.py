"""A library card at 390 px: its state on its icon, its one control ⋯.

  - a card's foot holds its marks (a favorite's star; the ring while a ZIM comes
    to the phone, the check once here) and, in the corner, its one button ⋯;
    marks are never buttons, and a ZIM the phone does not hold has none;
  - ⋯ opens the card's menu: Keep offline there is the ring at once; too big
    for the phone still refuses plainly; Remove asks first;
  - a 74 GB pull shows movement: a sliver of ring from the first byte, a line in
    the menu that moves while it is open, and a total even when the proxy sends
    no length; a failed pull says why on the ring, in a notice and in the menu,
    which offers Retry;
  - offline: Discover first, the pill's hint wraps inside its popover, and an
    app's back arrow leads home; online: On this phone opens the categories;
  - storage the browser refuses, or a page without HTTPS, offers nothing.

Run: pytest tests/test_keep_card_live.py -v
"""

import http.client
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_keep_phone_live as kp  # noqa: E402
from test_keep_flow_live import library  # noqa: E402
from test_keep_flow_live import phone as kp_phone  # noqa: E402
from test_keep_phone_live import _device, pw, wait_shell_kept  # noqa: E402,F401
from test_offline_truth_live import Server, _free_port  # noqa: E402
import wiki_fixture as wf  # noqa: E402

BIG_NAME = "wikipedia_en_simple"
SMALL = "wikiquote"
BIG = 74 * 10**9


class BigProxy:
    """Forwards to the real server, except that the whole-file stream of BIG_NAME claims to be 74 GB and arrives slowly;
    `chunked` leaves out every length header, as a proxy that re-chunks a long stream can.
    """

    def __init__(self, upstream_port, port):
        outer = self
        self.chunked = False

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def do_GET(self):
                rng = self.headers.get("Range", "")
                stream = self.path.startswith("/keep/" + BIG_NAME) and (
                    rng == "" or (rng.endswith("-") and rng != "bytes=0-0")
                )
                if stream:
                    return self.big(int(rng[6:-1]) if rng else 0)
                conn = http.client.HTTPConnection(
                    "127.0.0.1", upstream_port, timeout=30
                )
                try:
                    conn.request(
                        "GET",
                        self.path,
                        headers={
                            k: v
                            for k, v in self.headers.items()
                            if k.lower() not in ("host", "connection")
                        },
                    )
                    r = conn.getresponse()
                    body = r.read()
                    self.send_response(r.status)
                    for k, v in r.getheaders():
                        if k.lower() not in (
                            "transfer-encoding",
                            "connection",
                            "content-length",
                        ):
                            self.send_header(k, v)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except Exception:
                    pass
                finally:
                    conn.close()

            def big(self, start):
                self.send_response(200 if outer.chunked else 206)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("ETag", '"big"')
                if outer.chunked:
                    self.send_header("Transfer-Encoding", "chunked")
                else:
                    self.send_header(
                        "Content-Range", "bytes %d-%d/%d" % (start, BIG - 1, BIG)
                    )
                    self.send_header("Content-Length", str(BIG - start))
                self.end_headers()
                chunk = b"\0" * 65536
                try:
                    while True:
                        self.wfile.write(
                            (b"%x\r\n" % len(chunk) + chunk + b"\r\n")
                            if outer.chunked
                            else chunk
                        )
                        time.sleep(0.02)
                except Exception:
                    return

        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), H)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % port

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def world(tmp_path):
    zims, data = tmp_path / "zims", tmp_path / "data"
    zims.mkdir()
    data.mkdir()
    wf.build_library(str(zims))
    srv = Server(str(zims), str(data), _free_port())
    srv.start()
    proxy = BigProxy(srv.port, _free_port())
    yield srv, proxy
    proxy.stop()
    srv.stop()


def mark(pg, zim):
    """The keep mark on a card's icon, or None."""
    return pg.evaluate(
        """(z) => { const c = document.querySelector(`.stat-card[data-zim='${z}']`), b = c && c.querySelector('.keep-ico'); if (!b) return null;
          const r = b.getBoundingClientRect(), m = c.querySelector('.card-more').getBoundingClientRect();
          return { k: b.dataset.k, tag: b.tagName, events: getComputedStyle(b).pointerEvents, foot: !!b.closest('.card-foot'),
                   line: Math.abs((r.top + r.bottom) / 2 - (m.top + m.bottom) / 2), left_of_more: r.right <= m.left,
                   dash: (b.querySelector('.kr-arc') || document.body).getAttribute('stroke-dasharray') }; }""",
        zim,
    )


def _wait_until_the_card_stops_moving(pg, zim):
    """The card has the same place on the screen over several frames in a row.

    The page closes an open menu on any scroll of the page, so a menu opened while the card is still being brought into
    view (or moved by a late layout) is closed by that movement.
    """
    pg.wait_for_function(
        """(z) => {
            const top = document.querySelector(`.stat-card[data-zim='${z}']`).getBoundingClientRect().top;
            const w = window.__cardStill = window.__cardStill && window.__cardStill.z === z ? window.__cardStill : { z: z, top: null, n: 0 };
            w.n = w.top === top ? w.n + 1 : 0;
            w.top = top;
            return w.n >= 5;
        }""",
        arg=zim,
        timeout=30000,
        polling="raf",
    )
    pg.evaluate("() => { window.__cardStill = null; }")


def more(pg, zim):
    """Tap the card's ⋯ and return the menu's lines."""
    pg.evaluate(
        "(z) => document.querySelector(`.stat-card[data-zim='${z}']`).scrollIntoView({block: 'center'})",
        zim,
    )
    _wait_until_the_card_stops_moving(pg, zim)
    b = pg.evaluate(
        "(z) => { const r = document.querySelector(`.stat-card[data-zim='${z}'] .card-more`).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }",
        zim,
    )
    pg.mouse.click(b[0], b[1])
    pg.wait_for_selector("#zim-ctx-menu.visible", timeout=5000)
    return pg.evaluate(
        "() => [...document.querySelectorAll('#zim-ctx-menu > .ctx-item')].map(e => e.innerText.trim())"
    )


def pick(pg, action):
    pg.click("#zim-ctx-menu [data-action='%s']" % action)
    pg.wait_for_selector("#zim-ctx-menu.visible", state="hidden", timeout=5000)


def keep_one(pg):
    """One ZIM kept; the pull spy is installed after it."""
    pg.evaluate("(z) => _keepStart(z)", "wikipedia")
    pg.wait_for_selector(
        ".stat-card[data-zim='wikipedia'] .keep-ico.kept", timeout=30000
    )


def spy_pull(pg):
    pg.evaluate(
        """() => { window.__pulls = []; const real = KeepStore.pull; KeepStore.pull = function() { window.__pulls.push([...arguments]); return real.apply(KeepStore, arguments); };
                   KeepStore.room = async () => ({ quota: 0, usage: 0, free: 5e11 }); }"""
    )


def test_a_card_marks_its_state_in_its_foot_beside_its_one_control(pw, world):
    br, ctx, pg = library(pw, world)
    keep_one(pg)
    for view in ("list", "tiles"):
        pg.evaluate(
            "(v) => { localStorage.setItem('zimi_library_view', v); renderHome(); }",
            view,
        )
        pg.wait_for_function(
            "(v) => { const g = document.querySelector('#output .stats-grid'); return !!g && g.classList.contains('tiles') === (v === 'tiles'); }",
            arg=view,
        )
        # A ZIM the phone does not hold has no mark at all, and nothing on any card but ⋯ is a button.
        assert mark(pg, SMALL) is None
        kinds = pg.evaluate(
            "(z) => [...document.querySelector(`.stat-card[data-zim='${z}']`).querySelectorAll('button')].map(b => b.className)",
            SMALL,
        )
        assert kinds == ["card-more"], kinds
        # The check sits in the card's foot, on ⋯'s line and before it, and it is a mark, not a target.
        m = mark(pg, "wikipedia")
        assert m["k"] == "kept" and m["tag"] == "SPAN" and m["events"] == "none", m
        assert m["foot"] and m["line"] <= 3 and m["left_of_more"], m
        # ⋯ is the bottom-right corner of every card, with marks or without.
        corner = pg.evaluate(
            "(z) => { const c = document.querySelector(`.stat-card[data-zim='${z}']`).getBoundingClientRect(), b = document.querySelector(`.stat-card[data-zim='${z}'] .card-more`).getBoundingClientRect(); return [c.right - b.right, c.bottom - b.bottom]; }",
            SMALL,
        )
        assert 0 <= corner[0] <= 8 and 0 <= corner[1] <= 8, (view, corner)
        w = pg.evaluate(
            "(z) => document.querySelector(`.stat-card[data-zim='${z}'] .card-more`).getBoundingClientRect().width",
            SMALL,
        )
        assert w >= (44 if view == "list" else 34), (view, w)
    # ⋯ opens the card's menu and goes nowhere.
    lines = more(pg, SMALL)
    assert (
        "Keep offline" in lines
        and "Add to favorites" in lines
        and "About this ZIM" in lines
    ), lines
    assert pg.evaluate("() => location.pathname") == "/"
    ctx.close()
    br.close()


def test_a_scroll_inside_the_open_menu_does_not_close_it(pw, world):
    """The page closes a menu on a scroll of the page; the menu's own (an item brought into view, a line that grows)
    is not the page's, and closed a menu the moment it opened."""
    br, ctx, pg = library(pw, world)
    more(pg, SMALL)
    scrolled = pg.evaluate("""() => new Promise((done) => {
            const m = document.getElementById('zim-ctx-menu');
            m.style.maxHeight = '120px';
            m.style.overflowY = 'auto';
            m.addEventListener('scroll', () => done(m.scrollTop), { once: true });
            m.scrollTop = 40;
        })""")
    assert pg.evaluate(
        "() => document.getElementById('zim-ctx-menu').classList.contains('visible')"
    ), "closed by its own scroll"
    assert scrolled > 0
    ctx.close()
    br.close()


def test_keep_offline_from_the_menu_is_the_ring_at_once(pw, world):
    br, ctx, pg = library(pw, world)
    keep_one(pg)
    spy_pull(pg)
    pg.evaluate(
        "() => { KeepStore.probe = async () => { await new Promise(r => setTimeout(r, 1500)); return { ok: true, size: 60000 }; }; }"
    )
    more(pg, SMALL)
    pick(pg, "keep-start")
    # The probe has not answered yet and the mark is already the ring.
    assert mark(pg, SMALL)["k"] == "pull", mark(pg, SMALL)
    assert pg.evaluate("() => window.__pulls.length") == 0
    pg.wait_for_function("() => window.__pulls.length === 1", timeout=10000)
    assert not pg.query_selector(".pw-overlay.open"), "no question for a small ZIM"
    ctx.close()
    br.close()


def test_too_big_for_the_phone_still_refuses_plainly(pw, world):
    br, ctx, pg = library(pw, world)
    keep_one(pg)
    pg.evaluate(
        "([z, b]) => { _zimInfo(z).size_bytes = b; KeepStore.room = async () => ({ quota: 0, usage: 0, free: 38e9 }); KeepStore.probe = async () => ({ ok: true, size: b }); KeepStore.estimateIsFuzzy = () => false; }",
        [SMALL, BIG],
    )
    more(pg, SMALL)
    pick(pg, "keep-start")
    pg.wait_for_selector(".keep-sheet", timeout=10000)
    rows = pg.inner_text(".keep-sheet-rows")
    assert "Needs 74 GB" in rows and "38 GB" in rows, rows
    pg.click(".keep-sheet [data-act='cancel']")
    pg.wait_for_function(
        "(z) => !document.querySelector(`.stat-card[data-zim='${z}'] .keep-ico`)",
        arg=SMALL,
        timeout=5000,
    )
    ctx.close()
    br.close()


def test_removing_a_kept_zim_asks_first(pw, world):
    br, ctx, pg = library(pw, world)
    keep_one(pg)
    lines = more(pg, "wikipedia")
    assert "Remove from this phone" in lines, lines
    pick(pg, "keep-remove")
    pg.wait_for_selector(".pw-overlay.open", timeout=5000)
    assert "wikipedia" in pg.evaluate(
        "() => [..._keepNames]"
    ), "nothing goes before the answer"
    pg.click("#ac-ok")
    pg.wait_for_function("() => !document.querySelector('.keep-ico')", timeout=15000)
    ctx.close()
    br.close()


def test_a_74gb_pull_visibly_moves_in_the_menu(pw, world):
    srv, proxy = world
    br, ctx, pg = library(pw, world)
    keep_one(pg)
    pg.evaluate(
        "([z, b]) => { _zimInfo(z).size_bytes = b; KeepStore.room = async () => ({ quota: 0, usage: 0, free: 5e11 }); }",
        [BIG_NAME, BIG],
    )
    more(pg, BIG_NAME)
    pick(pg, "keep-start")
    pg.wait_for_function(
        "(z) => { const b = document.querySelector(`.stat-card[data-zim='${z}'] .keep-ico`); return b && b.dataset.k === 'pull'; }",
        arg=BIG_NAME,
        timeout=15000,
    )
    pg.wait_for_function("() => KeepStore.state().written > 2e6", timeout=20000)
    # At this size a percent is 740 MB: the arc still shows from the first byte.
    m = mark(pg, BIG_NAME)
    assert float(m["dash"].split()[0]) >= 4, m
    lines = more(pg, BIG_NAME)
    assert "Pause" in lines and "Cancel download" in lines, lines
    note = pg.inner_text("#zim-ctx-menu .ctx-keep-note")
    assert "74 GB" in note and "/s" in note, note
    pg.wait_for_function(
        "(was) => document.querySelector('#zim-ctx-menu .ctx-keep-note').textContent !== was",
        arg=note,
        timeout=15000,
    )  # the line moves while the menu is open
    # Pause keeps it as a ring that offers Resume.
    pick(pg, "keep-pause")
    pg.wait_for_function(
        "(z) => { const b = document.querySelector(`.stat-card[data-zim='${z}'] .keep-ico`); return b && b.dataset.k === 'paused'; }",
        arg=BIG_NAME,
        timeout=10000,
    )
    lines = more(pg, BIG_NAME)
    assert "Resume" in lines and "Cancel download" in lines, lines
    pick(pg, "keep-cancel")
    pg.wait_for_function(
        "(z) => !document.querySelector(`.stat-card[data-zim='${z}'] .keep-ico`)",
        arg=BIG_NAME,
        timeout=10000,
    )
    ctx.close()
    br.close()


def test_a_proxy_that_sends_no_length_still_gives_the_ring_a_total(pw, world):
    srv, proxy = world
    proxy.chunked = True
    br, ctx, pg = library(pw, world)
    keep_one(pg)
    pg.evaluate(
        "([z, b]) => { _zimInfo(z).size_bytes = b; KeepStore.room = async () => ({ quota: 0, usage: 0, free: 5e11 }); KeepStore.probe = async () => ({ ok: true, size: 0 }); }",
        [BIG_NAME, BIG],
    )
    more(pg, BIG_NAME)
    pick(pg, "keep-start")
    pg.wait_for_function("() => KeepStore.state().written > 1e6", timeout=20000)
    assert (
        pg.evaluate("() => KeepStore.state().size") == BIG
    ), "the library's byte count is the total when the stream has none"
    pg.evaluate("() => KeepStore.stop()")
    # And a one-byte answer with no Content-Range is not mistaken for a one-byte ZIM.
    size = pg.evaluate(
        """async () => { const f = window.fetch; window.fetch = async () => new Response('x', { status: 206 });
                         const p = await KeepStore.probe('a', {}); window.fetch = f; return p.size; }"""
    )
    assert size == 0, size
    ctx.close()
    br.close()


def test_a_failed_pull_shows_on_the_ring_and_the_menu_offers_retry(pw, world):
    br, ctx, pg = library(pw, world)
    keep_one(pg)
    pg.evaluate(
        """(z) => { KeepStore.state = () => ({ name: z, phase: 'idle', written: 5e9, size: 74e9, error: 'network', speed: 0, at: 0, retrying: false });
                   _keepIconSync(); }""",
        BIG_NAME,
    )
    assert mark(pg, BIG_NAME)["k"] == "failed"
    lines = more(pg, BIG_NAME)
    note = pg.inner_text("#zim-ctx-menu .ctx-keep-note")
    assert "connection dropped" in note and "Retry" in lines, (note, lines)
    ctx.close()
    br.close()


def test_a_pull_that_fails_says_why(pw, world):
    br, ctx, pg = library(pw, world)
    keep_one(pg)
    pg.evaluate(
        "() => { KeepStore.room = async () => ({ quota: 0, usage: 0, free: 5e11 }); KeepStore.probe = async () => ({ ok: true, size: 60000 }); }"
    )
    # The server goes away between the size and the bytes.
    pg.route("**/keep/" + SMALL, lambda route: route.fulfill(status=410, body=""))
    more(pg, SMALL)
    pick(pg, "keep-start")
    pg.wait_for_function(
        "() => { const n = document.getElementById('keep-notice'); return n && !n.hidden && n.textContent.length > 0; }",
        timeout=60000,
    )
    assert mark(pg, SMALL)["k"] == "failed"
    ctx.close()
    br.close()


# ── offline and the home ─────────────────────────────────────────────────────


def go_offline(pw, world):
    srv, proxy = world
    br, ctx, pg = library(pw, world)
    keep_one(pg)
    pg.wait_for_timeout(1500)
    srv.stop()
    ctx.set_offline(True)
    pg.close()
    pg = ctx.new_page()
    pg.goto(proxy.base + "/", wait_until="commit")
    pg.wait_for_selector(".stat-card.kept", timeout=20000)
    pg.wait_for_timeout(1500)
    return br, ctx, pg


def test_offline_the_pill_hint_wraps_and_an_apps_back_arrow_goes_home(pw, world):
    br, ctx, pg = go_offline(pw, world)
    pg.click("#conn-pill")
    pg.wait_for_selector("#zim-ctx-menu.visible")
    r = pg.evaluate(
        """() => { const i = document.querySelector('#zim-ctx-menu .ctx-info'), m = document.getElementById('zim-ctx-menu').getBoundingClientRect(), b = i.getBoundingClientRect();
                   return { ws: getComputedStyle(i).whiteSpace, over: i.scrollWidth > i.clientWidth + 1, right: m.right, left: m.left, w: innerWidth, h: b.height }; }"""
    )
    assert (
        r["ws"] == "normal"
        and not r["over"]
        and r["left"] >= 0
        and r["right"] <= r["w"]
    ), r
    assert r["h"] > 30, "it wraps onto more than one line: %r" % r
    pg.keyboard.press("Escape")
    # An app opened offline: the arrow is there and goes back to the home it came from.
    pg.evaluate("() => window.scrollTo(0, 0)")
    pg.click("a.stat-card[href='#dictionary']")
    pg.wait_for_function("() => _isAppPage()", timeout=10000)
    assert (
        pg.evaluate(
            "() => getComputedStyle(document.getElementById('back-btn')).display"
        )
        != "none"
    )
    pg.click("#back-btn")
    pg.wait_for_function(
        "() => !_isAppPage() && !!document.querySelector('.stat-card.kept')",
        timeout=10000,
    )
    assert pg.evaluate("() => location.pathname + location.hash") == "/"
    ctx.close()
    br.close()


def test_online_on_this_phone_opens_the_categories(pw, world):
    br, ctx, pg = library(pw, world)
    keep_one(pg)
    pg.evaluate(
        "() => { collectionsCache = Object.assign({}, collectionsCache, { collections: { mine: { label: 'Mine', zims: ['wikiquote'] } } }); renderHome(); }"
    )
    pg.wait_for_selector(".cat-heading")
    heads = pg.evaluate(
        "() => [...document.querySelectorAll('#output .cat-heading')].map(e => e.innerText.trim().toLowerCase())"
    )
    # Directly below the collections, before the big library flow.
    assert (
        heads.index("mine") + 1
        == heads.index("on this phone")
        < heads.index("encyclopedias")
    ), heads
    ctx.close()
    br.close()


def _page_with(pw, world, init_js):
    """A phone page whose browser is changed by `init_js` before any script of the app runs."""
    srv, proxy = world
    br, ctx = kp_phone(pw)
    ctx.add_init_script(init_js)
    pg = ctx.new_page()
    pg.goto(proxy.base + "/", wait_until="load")
    pg.wait_for_selector(".stat-card", timeout=30000)
    pg.wait_for_function("() => typeof _keepStart === 'function'")
    return br, ctx, pg


def _about_keep_note(pg, zim):
    pg.evaluate("(z) => _openZimAbout(z)", zim)
    pg.wait_for_selector("#zi-keep .keep-note", timeout=15000)
    return pg.inner_text("#zi-keep .keep-note")


def test_storage_the_browser_refuses_is_never_offered(pw, world):
    # Safari's Private Browsing: getDirectory is there and throws when used.
    br, ctx, pg = _page_with(
        pw,
        world,
        "navigator.storage.getDirectory = () => Promise.reject(new DOMException('no', 'UnknownError'));",
    )
    pg.wait_for_function("() => _keepStorageOk === false", timeout=10000)
    assert not pg.query_selector(".keep-ico"), "no mark a tap cannot keep"
    assert "cannot keep files" in _about_keep_note(pg, SMALL)
    ctx.close()
    br.close()


def test_an_insecure_address_says_https_is_needed(pw, world):
    br, ctx, pg = _page_with(
        pw, world, "Object.defineProperty(window, 'isSecureContext', { value: false });"
    )
    assert pg.evaluate("() => _keepAvailable()") is False
    assert "HTTPS" in _about_keep_note(pg, SMALL)
    ctx.close()
    br.close()


def test_the_menu_opens_on_a_part_kept_zim_after_a_reload(pw, world):
    # A big pull left part-way (the app closed): after a reload the card shows the
    # paused ring before the keep scripts have loaded, and its ⋯ must still open.
    srv, proxy = world
    br, ctx, pg = library(pw, world)
    keep_one(pg)
    pg.evaluate(
        "([z, b]) => { _zimInfo(z).size_bytes = b; KeepStore.room = async () => ({ quota: 0, usage: 0, free: 5e11 }); }",
        [BIG_NAME, BIG],
    )
    more(pg, BIG_NAME)
    pick(pg, "keep-start")
    pg.wait_for_function("() => KeepStore.state().written > 2e6", timeout=20000)
    pg.evaluate("() => KeepStore.stop()")
    pg.wait_for_function("() => KeepStore.state().phase !== 'pulling'", timeout=15000)
    pg.reload(wait_until="load")
    pg.wait_for_selector(
        ".stat-card[data-zim='%s'] .keep-ico.paused" % BIG_NAME, timeout=20000
    )
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    lines = more(pg, BIG_NAME)
    assert "Resume" in lines and "Cancel download" in lines, lines
    assert not errors, errors
    ctx.close()
    br.close()


def test_on_a_phone_the_menu_is_a_sheet_from_the_bottom(pw, world):
    br, ctx, pg = library(pw, world)
    more(pg, SMALL)
    # The sheet comes up by a transition: read it where it stands.
    pg.wait_for_function(
        "() => { const b = document.getElementById('zim-ctx-menu').getBoundingClientRect(); return Math.abs(b.bottom - innerHeight) <= 1; }",
        timeout=30000,
    )
    r = pg.evaluate(
        """() => { const m = document.getElementById('zim-ctx-menu'), b = m.getBoundingClientRect();
          return { sheet: m.classList.contains('sheet'), left: b.left, right: b.right, bottom: b.bottom, w: innerWidth, h: innerHeight,
                   head: (m.querySelector('.ctx-head') || {}).innerText || '', backdrop: !document.getElementById('ctx-backdrop').hidden }; }"""
    )
    assert (
        r["sheet"]
        and r["left"] == 0
        and r["right"] == r["w"]
        and abs(r["bottom"] - r["h"]) <= 1
    ), r
    assert "Wikiquote" in r["head"] and r["backdrop"], r
    # A submenu opens in place under its row, inside the sheet.
    pg.click("#zim-ctx-menu > .ctx-item:has(> .ctx-sub)")
    sub = pg.evaluate(
        """() => { const s = document.querySelector('#zim-ctx-menu .sub-open > .ctx-sub'), b = s && s.getBoundingClientRect();
          return s && { pos: getComputedStyle(s).position, left: b.left, right: b.right, w: innerWidth }; }"""
    )
    assert (
        sub and sub["pos"] == "static" and sub["left"] >= 0 and sub["right"] <= sub["w"]
    ), sub
    # The backdrop closes it.
    pg.mouse.click(195, 40)
    pg.wait_for_function(
        "() => !document.getElementById('zim-ctx-menu').classList.contains('visible')",
        timeout=3000,
    )
    assert pg.evaluate("() => document.getElementById('ctx-backdrop').hidden")
    ctx.close()
    br.close()
