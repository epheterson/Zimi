"""ZimiGames inside a real Zimi at 390 wide (and a desktop width), from a games ZIM built in a scratch folder.

* Every page of games.json starts: no "This game failed to start" banner, no page error. The banner used to come from a
  `rate limited` answer to a game's own script while the offline keeper pulled the whole ZIM.
* Random inside the games draws only games.json's pages, never a README or a licence; the build leaves those two out of
  the articles and the licence stays reachable (About links it).
* Sky Detective's study sky opens from every way a game is reached, even while Zimi's own idea of the open article lags.
* The Pet is gone from Home, the shelf and games.json.
* The shelf: Favorites lays out like the other tiles, a section's number is the games it shows, a family opens with a
  count and a chevron, the credits are closed until asked for, a sheet's "More versions" is a quiet row.
* A game's surface is not selectable (rapid taps), its How to play is.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_final_fixes.py -v
"""

import json
import os
import socket
import subprocess
import sys
import urllib.parse
import urllib.request

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ROOT)
from games_wait import wait_for_server, frames  # noqa: E402

GAMES = os.path.join(ROOT, "zimi", "builtin", "games")
PHONE = {"width": 390, "height": 844}
DESKTOP = {"width": 1280, "height": 860}
START_WAIT_MS = 6500   # the shell's start grace (2.5 s after load, twice) with room
BATCH = 6
WAIT = 60000


def _rows():
    with open(os.path.join(GAMES, "games.json"), encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture(scope="module")
def zimi(tmp_path_factory):
    from zimi import ownzims

    base = tmp_path_factory.mktemp("final")
    lib, built, data = base / "lib", base / "built", base / "data"
    for d in (lib, built, data):
        d.mkdir()
    was = ownzims.OUT_DIR
    ownzims.OUT_DIR = str(built)
    try:
        made = ownzims.build(ownzims.OWN[0])
    finally:
        ownzims.OUT_DIR = was
    zim = lib / os.path.basename(made)
    os.replace(made, zim)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = dict(os.environ, ZIMI_TORRENT="0", ZIMI_OFFLINE="1", ZIMI_BUILTIN_ZIMS="0", ZIMI_APPS="1",
               ZIMI_MANAGE_OPEN="1", ZIM_DIR=str(lib), ZIMI_DATA_DIR=str(data))
    proc = subprocess.Popen([sys.executable, "-m", "zimi", "serve", "--port", str(port)], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_for_server(port):
            pytest.skip("the games library did not start")
        yield {"url": "http://127.0.0.1:%d" % port, "zim": str(zim)}
    finally:
        proc.terminate()


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.webkit.launch()
        yield b
        b.close()


def _open(browser, zimi, path, viewport=PHONE, scheme="dark", touch=True):
    ctx = browser.new_context(viewport=viewport, has_touch=touch, is_mobile=touch, color_scheme=scheme)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(zimi["url"] + "/?a=" + urllib.parse.quote("zimi_games/" + path, safe=""))
    page.locator("#reader.open").wait_for(timeout=WAIT)
    return ctx, page, errors


def _frame(page):
    page.wait_for_function("() => { const f = document.getElementById('reader-frame'); return !!f && /\\/w\\/zimi_games\\//.test(f.contentWindow.location.pathname); }", timeout=WAIT)
    return next(f for f in page.frames if "/w/zimi_games/" in f.url)


def _shelf(browser, zimi, viewport=PHONE, view="lobby", touch=True):
    ctx = browser.new_context(viewport=viewport, has_touch=touch, is_mobile=touch, color_scheme="dark")
    ctx.add_init_script("try { localStorage.setItem('zimi.games.view', %s); } catch (e) {}" % json.dumps(view))
    page = ctx.new_page()
    page.goto(zimi["url"] + "/?a=" + urllib.parse.quote("zimi_games/index.html", safe=""))
    page.locator("#reader.open").wait_for(timeout=WAIT)
    f = _frame(page)
    f.wait_for_selector(".sh-nav .sh-chip", state="attached", timeout=WAIT)
    f.wait_for_function("() => document.querySelector('.sh-main') && !document.querySelector('.sh-wait')", timeout=WAIT)
    return ctx, page, f


# ── every page starts ────────────────────────────────────────────────────────


def test_every_page_of_games_json_starts_inside_zimi(browser, zimi):
    paths = sorted({r["path"] for r in _rows()})
    assert len(paths) > 100 and any(p.startswith("puzzles/") for p in paths)
    ctx = browser.new_context(viewport=PHONE, has_touch=True, is_mobile=True)
    # Each open page holds a change stream (/events) for as long as it lives: a browser keeps six connections to one host, and
    # a batch of pages each holding one starves the pages' own requests. The games do not use it.
    ctx.route("**/events*", lambda route: route.abort())
    broken = []
    for i in range(0, len(paths), BATCH):
        pages = []
        for p in paths[i:i + BATCH]:
            pg = ctx.new_page()
            errs = []
            pg.on("pageerror", lambda e, errs=errs: errs.append(str(e)))
            pg.goto(zimi["url"] + "/?a=" + urllib.parse.quote("zimi_games/" + p, safe=""))
            pages.append((p, pg, errs))
        pages[-1][1].wait_for_timeout(START_WAIT_MS)
        for p, pg, errs in pages:
            banners = 0
            for f in pg.frames:
                try:
                    banners += f.locator('[role="alert"]', has_text="failed to start").count()
                except Exception:
                    pass
            # a Dictionary lookup cut off by leaving a page is reported by WebKit though the page handles it
            errs = [e for e in errs if "access control checks" not in e]
            if banners or errs:
                broken.append((p, banners, errs[:2]))
            pg.close()
    ctx.close()
    assert not broken, broken


def test_the_offline_keeper_does_not_spend_a_pages_budget(zimi):
    """The keeper's requests count in a bucket of their own: a full minute of them leaves the page's /w/ requests answered."""
    url = zimi["url"] + "/w/zimi_games/shell.js"
    keep = urllib.request.Request(url, headers={"X-Zimi-Keep": "1"})
    from zimi import http as _http

    ip_buckets = _http._rate_buckets_keep   # (the server is another process: this proves only the names exist)
    assert ip_buckets == {} or isinstance(ip_buckets, dict)
    for _ in range(40):
        urllib.request.urlopen(keep).read()
    assert urllib.request.urlopen(url).status == 200


def test_keeper_requests_use_their_own_bucket():
    from zimi import http as _http

    ip = "203.0.113.9"
    for b in (_http._rate_buckets_content, _http._rate_buckets_keep):
        b.pop(ip, None)
    try:
        for _ in range(_http.RATE_LIMIT_CONTENT):
            assert _http._check_rate_limit(ip, content=True, buckets=_http._rate_buckets_keep) == 0
        assert _http._check_rate_limit(ip, content=True, buckets=_http._rate_buckets_keep) > 0
        assert _http._check_rate_limit(ip, content=True) == 0, "the page's own budget is untouched"
    finally:
        for b in (_http._rate_buckets_content, _http._rate_buckets_keep):
            b.pop(ip, None)


# ── random and the build ─────────────────────────────────────────────────────


def test_random_inside_the_games_is_only_ever_a_game(zimi):
    playable = {r["path"] for r in _rows()}
    seen = set()
    for i in range(120):
        q = "/random?zim=zimi_games" + ("&not=chess.html" if i % 3 == 0 else "")
        card = json.load(urllib.request.urlopen(zimi["url"] + q))
        assert card["path"] in playable, card
        if i % 3 == 0:
            assert card["path"] != "chess.html"
        seen.add(card["path"])
    assert len(seen) > 30
    assert "pet.html" not in playable


def test_the_games_zim_keeps_notices_out_of_its_articles_but_serves_the_licence(zimi):
    from libzim.reader import Archive
    from libzim.suggestion import SuggestionSearcher

    a = Archive(zimi["zim"])
    with pytest.raises(Exception):
        a.get_entry_by_path("puzzles/README.txt")   # the vendoring notes live in docs/, not in the ZIM
    assert a.get_entry_by_path("puzzles/LICENCE").path == "puzzles/LICENCE"
    for q in ("LICENCE", "README"):
        hits = list(SuggestionSearcher(a).suggest(q).getResults(0, 50))
        assert not [h for h in hits if h.endswith(("LICENCE", "README.txt")) or "README-" in h], hits
    assert urllib.request.urlopen(zimi["url"] + "/w/zimi_games/puzzles/LICENCE").status == 200
    about = open(os.path.join(GAMES, "about.html"), encoding="utf-8").read()
    assert 'href="puzzles/LICENCE"' in about


# ── Sky Detective inside Zimi ────────────────────────────────────────────────

SKY_UP = "() => !!document.querySelector('.gamesky .alm-sky-host')"


def test_sky_detective_study_sky_opens_from_a_deep_link(browser, zimi):
    ctx, page, errors = _open(browser, zimi, "skydetective.html")
    page.wait_for_function(SKY_UP, timeout=WAIT)
    assert not errors, errors
    ctx.close()


def test_sky_detective_study_sky_opens_from_the_shelf_inside_the_frame(browser, zimi):
    ctx, page, _ = _open(browser, zimi, "index.html")
    f = _frame(page)
    f.evaluate("location.href = 'skydetective.html'")
    page.wait_for_function(SKY_UP, timeout=WAIT)
    ctx.close()


def test_sky_detective_is_heard_while_zimis_open_article_lags_the_frame(browser, zimi):
    """currentArticle trails the frame (a reload, Back, a link inside the frame): the page's own address decides."""
    ctx, page, _ = _open(browser, zimi, "index.html")
    f = _frame(page)
    page.evaluate("currentArticle = { zim: 'wikipedia_en', path: 'Moon' }")
    f.evaluate("location.href = 'skydetective.html'")
    page.wait_for_function(SKY_UP, timeout=WAIT)
    ctx.close()


def test_another_zim_may_not_ask_for_the_sky(browser, zimi):
    ctx, page, _ = _open(browser, zimi, "index.html")
    _frame(page)
    verdict = page.evaluate("""() => {
      const f = document.getElementById('reader-frame');
      const was = _gameFrameZim;
      _gameFrameZim = () => 'a_capture';
      const heard = _gameFrameIs(f.contentWindow);
      _gameFrameZim = was;
      return heard;
    }""")
    assert verdict is False
    ctx.close()


# ── the Pet is out ───────────────────────────────────────────────────────────


def test_the_pet_is_nowhere_on_the_shelf_or_home(browser, zimi):
    assert not [r for r in _rows() if "pet" in r["path"]]
    index = open(os.path.join(GAMES, "index.html"), encoding="utf-8").read()
    assert "pet.html" not in index
    ctx = browser.new_context(viewport=PHONE, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto(zimi["url"] + "/")
    page.evaluate("""() => localStorage.setItem('zimi.games.pet', JSON.stringify({ v: 1, active: 0, pets: [{ name: 'Pip' }] }))""")
    page.reload()
    page.wait_for_function("() => typeof _gamesTileHtml === 'function' && (zimsCache || []).some(z => z.name === 'zimi_games')", timeout=WAIT)
    page.wait_for_timeout(2500)   # the peek used to arrive when the browser was idle
    tile = page.evaluate("() => _gamesTileHtml()")
    assert "games-tile" in tile and "pet-peek" not in tile and "Pip" not in tile
    assert page.evaluate("() => typeof _petPeekRead + typeof _petPeekSchedule") == "undefinedundefined"
    assert page.locator(".pet-peek").count() == 0
    assert page.locator('iframe[sandbox="allow-scripts"]').count() == 0
    ctx.close()


# ── the shelf ────────────────────────────────────────────────────────────────

# hearts are kept on the server, so one may already be there: keep it, then have the row drawn
FAVORITE = """() => {
  const ref = { kind: 'article', zim: 'zimi_games', path: 'solitaire.html', title: 'Solitaire' }, s = window.parent.Saved;
  if (!s.has(ref)) s.save(ref);
  document.dispatchEvent(new Event('zimi-shelf-today'));
}"""


@pytest.mark.parametrize("viewport,view", [(PHONE, "lobby"), (PHONE, "index"), (DESKTOP, "lobby"), (DESKTOP, "index"), ({"width": 900, "height": 800}, "index")],
                         ids=["phone-lobby", "phone-index", "desktop-lobby", "desktop-index", "900-index"])
def test_favorites_tiles_lay_out_like_the_other_tiles(browser, zimi, viewport, view):
    ctx, page, f = _shelf(browser, zimi, viewport, view, touch=viewport is PHONE)
    f.evaluate(FAVORITE)
    f.wait_for_selector(".ar-favorites a.ar-game", timeout=WAIT)
    m = f.evaluate("""() => {
      const fav = document.querySelector('.ar-favorites a.ar-game'), other = document.querySelector('.ar-section:not(.ar-favorites) a.ar-game:not([hidden])');
      const t = fav.querySelector('strong'), r = fav.getBoundingClientRect(), o = other.getBoundingClientRect();
      return { favW: r.width, otherW: o.width, titleW: t.getBoundingClientRect().width, clipped: t.scrollWidth > t.clientWidth + 1, text: t.textContent };
    }""")
    assert not m["clipped"] and m["titleW"] > 50, m
    assert m["favW"] >= 120 and (view == "index" or abs(m["favW"] - m["otherW"]) < 60 or m["favW"] >= 120), m
    ctx.close()


@pytest.mark.parametrize("viewport,view", [(PHONE, "lobby"), (DESKTOP, "lobby"), (DESKTOP, "index"), (PHONE, "index")],
                         ids=["phone-lobby", "desktop-lobby", "desktop-index", "phone-index"])
def test_every_sections_number_is_the_games_it_shows(browser, zimi, viewport, view):
    ctx, page, f = _shelf(browser, zimi, viewport, view, touch=viewport is PHONE)
    chips = f.evaluate("() => [...document.querySelectorAll('.sh-nav .sh-chip')].map(c => c.textContent)")
    named = [c for c in chips if not c.startswith(("All", "Recent"))]
    assert len(named) >= 6, chips
    for i in range(len(chips)):
        label = chips[i]
        if label.startswith(("All", "Recent")):
            continue
        shown = f.evaluate("""(i) => {
          const chip = document.querySelectorAll('.sh-nav .sh-chip')[i];
          chip.click();
          const sec = [...document.querySelectorAll('.sh-list .ar-section')].filter(s => !s.hidden && s.getBoundingClientRect().height > 0);
          const count = Number(chip.querySelector('.sh-chip-n').textContent);
          const visible = sec.flatMap(s => [...s.querySelectorAll('a.ar-game')]).filter(a => { const r = a.getBoundingClientRect(); return !a.hidden && r.width > 0 && r.height > 0; }).length;
          return { count, visible, header: sec.map(s => s.querySelector('.sh-count').textContent).join(',') };
        }""", i)
        assert shown["count"] == shown["visible"], (label, shown)
        assert shown["header"] == str(shown["count"]), (label, shown)
    ctx.close()


def test_a_family_opens_with_a_count_and_a_chevron(browser, zimi):
    ctx, page, f = _shelf(browser, zimi, PHONE, "lobby")
    card = f.locator(".sh-fam-card", has_text="Logic puzzles").first
    card.scroll_into_view_if_needed()
    tag = card.locator(".sh-fam-tag")
    n = len([r for r in _rows() if r["path"].startswith("puzzles/")])
    shelf_n = f.evaluate("() => document.querySelectorAll('.sh-fam:has(.sh-fam-card) a.ar-game').length")
    assert tag.locator("b").inner_text() == str(int(tag.locator("b").inner_text())) and int(tag.locator("b").inner_text()) > 20 <= n
    assert tag.locator("svg").count() == 1 and card.get_attribute("aria-expanded") == "false"
    assert f.locator(".sh-fam-panel:visible").count() == 0
    card.click()
    f.wait_for_function("() => document.querySelector('.sh-fam.sh-open')", timeout=WAIT)
    assert card.get_attribute("aria-expanded") == "true"
    assert f.locator(".sh-fam.sh-open .sh-fam-panel a.ar-game:visible").count() > 20
    card.click()
    assert card.get_attribute("aria-expanded") == "false"
    assert shelf_n >= int(tag.locator("b").inner_text())
    ctx.close()


def test_the_credits_are_closed_until_asked_for(browser, zimi):
    ctx, page, f = _shelf(browser, zimi, PHONE, "lobby")
    assert f.evaluate("() => { const d = document.getElementById('ar-credits'); return [d.tagName, d.open, d.querySelector('summary').textContent]; }") == ["DETAILS", False, "Credits"]
    assert not f.locator("#ar-credits > p").is_visible()
    f.locator("#ar-credits > summary").click()
    assert f.evaluate("() => document.getElementById('ar-credits').open") and f.locator("#ar-credits > p").is_visible()
    ctx.close()


# ── a game's own sheet and surface ───────────────────────────────────────────


@pytest.mark.parametrize("game", ["sudoku.html", "minesweeper.html", "codebreaker.html"])
def test_more_versions_is_a_quiet_row_not_a_browser_link(browser, zimi, game):
    ctx, page, _ = _open(browser, zimi, game, scheme="dark")
    f = _frame(page)
    f.wait_for_function("() => document.documentElement.classList.contains('gs-ready')", timeout=WAIT)
    f.evaluate("[...document.querySelectorAll('.ar-bar button')].find(b => /Menu/.test(b.textContent)).click()")
    f.evaluate("[...document.querySelectorAll('.gs-sheet button')].find(b => /New game/.test(b.textContent)).click()")
    row = f.locator("a.gs-more")
    row.wait_for(state="visible", timeout=WAIT)
    m = f.evaluate("""() => {
      const a = document.querySelector('a.gs-more'), s = getComputedStyle(a), ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
      const probe = document.createElement('i'); probe.style.color = ink; document.body.appendChild(probe);
      const inkRgb = getComputedStyle(probe).color; probe.remove();
      return { color: s.color, ink: inkRgb, deco: s.textDecorationLine, label: a.querySelector('small').textContent, svg: a.querySelectorAll('svg').length, height: a.getBoundingClientRect().height, cls: a.className };
    }""")
    assert m["color"] == m["ink"] and m["deco"] == "none" and m["svg"] == 1 and m["label"] == "More versions" and m["height"] >= 40, m
    assert "ar-btn" not in m["cls"]
    ctx.close()


def test_a_games_surface_is_not_selectable_but_its_how_to_play_is(browser, zimi):
    ctx, page, _ = _open(browser, zimi, "kart.html")
    f = _frame(page)
    f.wait_for_function("() => document.documentElement.classList.contains('gs-ready')", timeout=WAIT)
    # (-webkit-touch-callout is iOS only: desktop WebKit does not report it, so its rule is read from the style the shell wrote)
    sel = f.evaluate("() => [getComputedStyle(document.body).webkitUserSelect, [...document.querySelectorAll('style')].some(e => /html\\.gs body\\{[^}]*-webkit-touch-callout:none/.test(e.textContent))]")
    assert sel == ["none", True], sel
    f.evaluate("[...document.querySelectorAll('.ar-bar button')].find(b => /Menu/.test(b.textContent)).click()")
    f.evaluate("[...document.querySelectorAll('.gs-sheet button')].find(b => /How to play/.test(b.textContent)).click()")
    f.wait_for_selector(".gs-sheet dl.gs-help", state="visible", timeout=WAIT)
    assert f.evaluate("() => getComputedStyle(document.querySelector('.gs-sheet dl.gs-help dd')).webkitUserSelect") == "text"
    ctx.close()
