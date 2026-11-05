"""ZimiGames follow the person in a real browser (Eric, 2026-11-04: "at least
each person should have their own view"; "Yes to storing per account across
browsers").

- Two people on one browser each see only their own stats: signing out takes a
  person's games off the screen, signing back in brings them back.
- One person on two browsers: what they played on one is on the other.
- A browser's games from before anyone signed in go into the first account
  that signs in, quietly when that account had none, and never into a second.
- Password switched off: each browser keeps its own, and nothing goes up.

A game writes its storage from the reader frame; here a same-origin frame
writes it, as a game page would.

Run: pytest tests/test_games_sync_live.py -v
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
import zimi.users as users  # noqa: E402

PASSWORD = "correct horse 1"
STATS = "zimi.games.stats"
KID_STATS = json.dumps(
    {"v": 1, "g": {"sudoku.html": {"n": 3, "w": 2}}, "days": {}, "best": 0}
)
MUM_STATS = json.dumps(
    {"v": 1, "g": {"chess.html": {"n": 1, "w": 0}}, "days": {}, "best": 0}
)


@pytest.fixture
def served(tmp_path, monkeypatch):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import build_wiki_fixture_zim

    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_wiki_fixture_zim(str(zdir / "wiki.zim"))
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(data))
    monkeypatch.setattr(srv, "ZIMI_BUILTIN_ZIMS", False, raising=False)
    srv.load_cache(force=True)
    users.create_user("kid", PASSWORD, role="user")
    users.create_user("mum", PASSWORD, role="user")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _ready(pg):
    pg.wait_for_function(
        "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
        timeout=30000,
    )


def _browser(br, base, seed=None):
    ctx = br.new_context(viewport={"width": 390, "height": 844})
    pg = ctx.new_page()
    pg.goto(base + "/")
    _ready(pg)
    pg.evaluate(
        "(s) => { localStorage.clear(); for (var k in s) localStorage.setItem(k, s[k]); }",
        seed or {},
    )
    pg.reload()
    _ready(pg)
    return pg


def _sign_in(pg, who):
    assert (
        pg.evaluate(
            "(a) => doLogin(a[0], a[1], true).then(r => r.status)", [who, PASSWORD]
        )
        == 200
    )
    pg.reload()
    _ready(pg)
    pg.wait_for_function("(w) => _gamesAccount === w", arg=who, timeout=10000)
    pg.wait_for_timeout(1500)


def _sign_out(pg):
    with pg.expect_navigation():
        pg.evaluate("() => userLogout()")
    _ready(pg)


def _game_writes(pg, key, value):
    """As a game page does: from a frame of the same origin, so the shell hears it as a storage event."""
    pg.evaluate(
        """(a) => { var f = document.getElementById('t-game');
             if (!f) { f = document.createElement('iframe'); f.id = 't-game'; f.style.display = 'none'; document.body.appendChild(f); }
             f.contentWindow.localStorage.setItem(a[0], a[1]); }""",
        [key, value],
    )


def _stats(pg):
    return pg.evaluate("(k) => localStorage.getItem(k)", STATS)


def _sent(pg):
    """Wait until nothing is pending (the push answered)."""
    pg.wait_for_function(
        "() => !Object.keys(_gamesState().pending).length", timeout=15000
    )


def test_two_people_on_one_browser_each_see_their_own(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = _browser(br, served)
        _sign_in(pg, "kid")
        _game_writes(pg, STATS, KID_STATS)
        _sent(pg)
        assert users.GAMES.load("kid")["settings"][STATS]["v"] == KID_STATS
        _sign_out(pg)
        assert _stats(pg) is None, "Kid's games left the screen with Kid"
        _sign_in(pg, "mum")
        assert _stats(pg) is None, "Mum sees none of Kid's"
        _game_writes(pg, STATS, MUM_STATS)
        _sent(pg)
        _sign_out(pg)
        _sign_in(pg, "kid")
        pg.wait_for_function(
            "(a) => localStorage.getItem(a[0]) === a[1]",
            arg=[STATS, KID_STATS],
            timeout=10000,
        )
        assert (
            STATS not in users.GAMES.load("mum")["settings"]
            or users.GAMES.load("mum")["settings"][STATS]["v"] == MUM_STATS
        )
        br.close()


def test_one_person_on_two_browsers_sees_the_same(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        phone = _browser(br, served)
        _sign_in(phone, "kid")
        _game_writes(phone, STATS, KID_STATS)
        _sent(phone)
        tablet = _browser(br, served)
        _sign_in(tablet, "kid")
        tablet.wait_for_function(
            "(a) => localStorage.getItem(a[0]) === a[1]",
            arg=[STATS, KID_STATS],
            timeout=10000,
        )
        br.close()


def test_a_browsers_games_go_to_the_first_account_quietly_and_never_to_a_second(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = _browser(br, served, {STATS: KID_STATS})
        toasts = []
        pg.expose_function("_seenToast", lambda m: toasts.append(m))
        pg.evaluate(
            "() => { var o = _showToast; _showToast = function (m) { window._seenToast(m); return o.apply(this, arguments); }; }"
        )
        _sign_in(pg, "kid")
        _sent(pg)
        assert users.GAMES.load("kid")["settings"][STATS]["v"] == KID_STATS
        assert not toasts, "an empty account takes them without a word"
        _sign_out(pg)
        _sign_in(pg, "mum")
        _sent(pg)
        assert (
            STATS not in users.GAMES.load("mum")["settings"]
        ), "never into a second person"
        br.close()


def test_password_off_keeps_each_browsers_own(served, monkeypatch):
    from playwright.sync_api import sync_playwright

    from zimi import manage

    manage._set_manage_password("adminpw-live-games")
    monkeypatch.setenv("ZIMI_MANAGE_OPEN", "1")
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = _browser(br, served)
        sent = []
        pg.on(
            "request",
            lambda r: sent.append(r.url) if "/userdata/games" in r.url else None,
        )
        assert pg.evaluate("() => _gamesAccount") is None
        _game_writes(pg, STATS, KID_STATS)
        pg.wait_for_timeout(4000)
        assert _stats(pg) == KID_STATS and not sent
        assert users.GAMES.load(users.PRIMARY_ADMIN_DATA)["rev"] == 0
        br.close()
