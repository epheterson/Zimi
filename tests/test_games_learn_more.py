"""ZimiGames leading out into what Zimi already has, inside a real Zimi (the reader's frame, same origin), at 390 wide.

Sky Detective studies the Almanac's own sky before it asks (the {zimi: 'game-sky'} message, static/almanac-gamesky.js), and each
answer can be seen again in that sky. The other library games offer one quiet link on a round's or an end sheet into the real
thing: an article, a word in the Dictionary, a place on the StreetZim map, the route of a race as articles. Every link leaves
the game and Back returns to the same position. Without Zimi around (a plain static server) there is no link into Zimi, and
Sky Detective studies on its own named dome.

The games' folder is built into a games ZIM in a scratch directory (never the committed one), served beside
tests/games_library_fixture.py's second library.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_learn_more.py -v      (SHOTS=<dir> keeps the pictures)
"""

import functools
import http.server
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import urllib.parse

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ROOT)
from games_wait import wait_for_server, becomes, frames  # noqa: E402

GAMES = os.path.join(ROOT, "zimi", "builtin", "games")
VIEW = {"width": 390, "height": 844}
SHOTS = os.environ.get("SHOTS", "")
WAIT = 60000


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def zimi(tmp_path_factory):
    if os.environ.get("LEARN_MORE_URL"):   # a Zimi already running over the same library (for working on these tests)
        yield os.environ["LEARN_MORE_URL"]
        return
    import games_library_fixture as fx
    from zimi import ownzims

    base = tmp_path_factory.mktemp("learn")
    fx.build(str(base))
    zdir, built = base / "lib", base / "built"
    shutil.copytree(
        base / "zims2", zdir
    )  # the second library: the lists, a Wiktionary, a Gutenberg and a map
    built.mkdir()
    (base / "data").mkdir()
    shutil.copytree(GAMES, base / "src" / "games")   # a snapshot: the build must not read files that are being edited
    was = (ownzims.OUT_DIR, ownzims.SOURCE_ROOT)
    ownzims.OUT_DIR, ownzims.SOURCE_ROOT = str(built), str(base / "src")
    try:
        made = ownzims.build(ownzims.OWN[0])
    finally:
        ownzims.OUT_DIR, ownzims.SOURCE_ROOT = was
    shutil.copy(made, zdir / os.path.basename(made))
    port = free_port()
    # No ZIMI_RATE_LIMIT: set, it also caps this machine at 8 open change streams, and a module of pages holds more than
    # that until their heartbeat; unset, the loopback is unlimited. The delete test lost its stream to that 429.
    env = dict(
        os.environ,
        ZIMI_TORRENT="0",
        ZIMI_OFFLINE="1",
        ZIMI_BUILTIN_ZIMS="0",
        ZIMI_APPS="1", ZIMI_MANAGE_OPEN="1",
        ZIM_DIR=str(zdir),
        ZIMI_DATA_DIR=str(base / "data"),
    )
    proc = subprocess.Popen(
        [sys.executable, "-m", "zimi", "serve", "--port", str(port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        if not wait_for_server(port):
            pytest.skip("the fixture library did not start")
        yield "http://127.0.0.1:%d" % port
    finally:
        proc.terminate()


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        for kind in (p.webkit, p.chromium):
            try:
                b = kind.launch()
            except Exception:
                continue
            yield b
            b.close()
            return
        pytest.skip("no browser installed")


def shot(page, name):
    if SHOTS:
        try:   # the picture is of the page, not of its spinner
            page.wait_for_function("() => { const l = document.getElementById('reader-loading'); return !l || l.classList.contains('hidden'); }", timeout=8000)
        except Exception:
            pass
        frames(page, 3)
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, name + ".png"))


def open_game(browser, zimi, name, ctx=None):
    ctx = ctx or browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    errors = []
    # WebKit reports the Dictionary's "more words" fetch, cut off by leaving the page, as a page error though the page
    # catches it (get() in dictionary.html); that one request is not what these tests are about.
    page.on("pageerror", lambda e: errors.append(str(e)) if not ("/dictionary/random?" in str(e) and "access control checks" in str(e)) else None)
    page.goto(zimi + "/?a=" + urllib.parse.quote("zimi_games/" + name, safe=""))
    page.locator("#reader.open").wait_for(timeout=WAIT)
    return ctx, page, errors


def game(page, name):
    """The game's own frame (the reader frame holds one page at a time; this waits for the one asked for)."""
    page.wait_for_function(
        "n => document.getElementById('reader-frame').contentWindow.location.pathname.endsWith(n)",
        arg="/" + name,
        timeout=WAIT,
    )
    frame = next(f for f in page.frames if f.url.split("?")[0].endswith("/" + name))
    frame.wait_for_function(
        "() => document.documentElement.classList.contains('gs-ready')", timeout=WAIT
    )
    return frame


def hosted(frame):
    return frame.evaluate("ZimiShell.hosted")


def click(frame, selector):
    loc = frame.locator(selector).first
    loc.wait_for(state="visible", timeout=WAIT)
    loc.click()
    frames(frame.page, 2)


def reader_path(page):
    return page.evaluate(
        "document.getElementById('reader-frame').contentWindow.location.pathname"
    )


def wait_path(page, pattern):
    page.wait_for_function(
        "p => new RegExp(p).test(document.getElementById('reader-frame').contentWindow.location.pathname + document.getElementById('reader-frame').contentWindow.location.hash)",
        arg=pattern,
        timeout=WAIT,
    )


def back_to(page, name):
    page.go_back()
    return game(page, name)


# ── Sky Detective ────────────────────────────────────────────────────────────


def test_sky_detective_studies_the_almanacs_sky_first(browser, zimi):
    ctx, page, errors = open_game(browser, zimi, "skydetective.html")
    f = game(page, "skydetective.html")
    assert hosted(f)
    # The Almanac's own sky opens over the page before any question, names on (its label plan), in the player's place and moment.
    page.locator(".gamesky .alm-sky-host").wait_for(state="attached", timeout=WAIT)
    assert page.evaluate(
        "typeof _skyHost === 'object' && _skyHost && _skyHost.s.hosted"
    ), "AlmanacSkyView did not mount"
    assert f.evaluate("__sky.g.study") is True
    assert (
        page.evaluate("_skyLabelPlan(_skyHost.s, t => t.length * 7).length") > 0
    ), "no names on the sky"
    frames(page, 4)
    shot(page, "sky-study")
    # look around: a drag turns the view, the wheel zooms
    before = page.evaluate("({..._skyHost.look})")
    box = page.locator(".gamesky-host").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 120, cy + 40, steps=6)
    page.mouse.up()
    page.evaluate("document.querySelector('.gamesky-host').dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true, cancelable: true }))")   # mobile WebKit has no mouse wheel
    frames(page, 4)
    after = page.evaluate("({..._skyHost.look})")
    assert after["az"] != before["az"] and after["fov"] < before["fov"], (before, after)
    shot(page, "sky-study-turned")
    # the sky is shown for the game's moment, and put back after
    focus = page.evaluate("_almFocus === null ? 0 : _almFocus.getTime()")
    assert focus == f.evaluate("__sky.g.ms") or focus == 0
    page.locator(".gamesky-btn.primary").click()
    page.locator(".gamesky").wait_for(state="detached", timeout=WAIT)
    f.wait_for_function("() => __sky.g.study === false", timeout=WAIT)
    assert page.evaluate("_almFocus") is None and page.evaluate("_skyHost") is None
    assert f.locator("#sk-q").inner_text(), "the first question is not up"
    assert not errors, errors
    ctx.close()


def test_back_closes_the_study_sky_and_stays_in_the_game(browser, zimi):
    """Browser Back and Zimi's back arrow each close the sky over the game, and the game (not the shelf) is still there."""
    for how in ("browser", "arrow"):
        ctx, page, errors = open_game(browser, zimi, "skydetective.html")
        f = game(page, "skydetective.html")
        page.locator(".gamesky .alm-sky-host").wait_for(state="attached", timeout=WAIT)
        if how == "browser":
            page.go_back()
        else:
            page.evaluate("goBack()")
        page.locator(".gamesky").wait_for(state="detached", timeout=WAIT)
        frames(page, 4)
        assert page.evaluate("_almFocus") is None and page.evaluate("_skyHost") is None
        assert reader_path(page).endswith("/skydetective.html"), "Back left the game"
        assert f.evaluate("__sky.g.study") is True
        # and the page is as it was: a second Back is the ordinary one (it is not swallowed)
        f.locator("#sk-look").wait_for(state="visible", timeout=WAIT)
        click(f, "#sk-look")
        page.locator(".gamesky .alm-sky-host").wait_for(state="attached", timeout=WAIT)
        page.locator(".gamesky-btn.primary").click()   # Start: takes its own step back without leaving
        page.locator(".gamesky").wait_for(state="detached", timeout=WAIT)
        f.wait_for_function("() => __sky.g.study === false", timeout=WAIT)
        frames(page, 4)
        assert reader_path(page).endswith("/skydetective.html")
        assert not errors, errors
        ctx.close()


@pytest.mark.parametrize("width", [390, 375])
def test_no_name_in_the_study_sky_overlaps_a_mark_or_another_name(browser, zimi, width):
    ctx = browser.new_context(viewport={"width": width, "height": 812}, has_touch=True, is_mobile=True)
    ctx, page, errors = open_game(browser, zimi, "skydetective.html", ctx)
    game(page, "skydetective.html")
    page.locator(".gamesky .alm-sky-host").wait_for(state="attached", timeout=WAIT)
    seen = 0
    for az, alt, fov in [(180, 35, 90), (90, 10, 90), (270, 10, 70), (0, 15, 100), (180, 5, 120), (135, 20, 60), (225, 12, 80)]:
        page.evaluate("([a, l, f]) => { AlmanacSkyView.setView(_skyHost.host, a, l, f); _skyHostDraw(); }", [az, alt, fov])
        frames(page, 3)
        bad = page.evaluate("""() => {
          const s = _skyHost.s, measure = t => t.length * 7 * s.dpr, plan = _skyLabelPlan(s, measure), obs = _skyLabelObstacles(s, measure, 0);
          const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0, out = [];
          plan.forEach((p, i) => {
            plan.forEach((q, j) => { if (j > i && hit(p.box, q.box)) out.push(p.text + ' x ' + q.text); });
            obs.forEach(o => { if (hit(p.box, o)) out.push(p.text + ' on ' + (o.of ? 'a body' : 'the compass')); });
          });
          return { n: plan.length, out };
        }""")
        assert not bad["out"], (az, alt, fov, bad)
        seen += bad["n"]
    assert seen > 10, "too few names were checked"
    page.evaluate("AlmanacSkyView.setView(_skyHost.host, 90, 10, 90); _skyHostDraw()")
    frames(page, 4)
    shot(page, "sky-labels-%d" % width)
    assert not errors, errors
    ctx.close()


def test_a_sky_answer_is_seen_again_in_the_same_sky_and_the_round_survives_a_reload(
    browser, zimi
):
    ctx, page, errors = open_game(browser, zimi, "skydetective.html")
    f = game(page, "skydetective.html")
    page.locator(".gamesky-btn.primary").click()
    f.wait_for_function("() => __sky.g.study === false", timeout=WAIT)
    # answer the first question (a name, or a tap on the thing named)
    kind = f.evaluate("__sky.g.qs[0].kind")
    if kind == "name":
        click(f, ".rk-choice")
    else:
        f.evaluate(
            """() => { const o = __sky.vis.filter(x => x.id === __sky.g.qs[0].id)[0], r = document.getElementById('sk-dome').getBoundingClientRect();
          const p = SkyKit.dome(o.alt, o.az), R = r.width / 2 - 22;
          document.getElementById('sk-dome').dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width / 2 + p.x * R, clientY: r.top + r.height / 2 + p.y * R, bubbles: true })); }"""
        )
    f.locator("#sk-sky").wait_for(state="visible", timeout=WAIT)
    shot(page, "sky-answer")
    click(f, "#sk-sky")
    page.locator(".gamesky .gamesky-ring").wait_for(state="visible", timeout=WAIT)
    # the view is centred on the answer
    target = f.evaluate(
        "(() => { const o = __sky.vis.filter(x => x.id === __sky.g.qs[0].id)[0]; return { az: o.az, alt: o.alt }; })()"
    )
    look = page.evaluate("_skyHost.look")
    assert (
        abs(((look["az"] - target["az"] + 540) % 360) - 180) < 1
        and abs(look["alt"] - target["alt"]) < 1
    ), (look, target)
    frames(page, 4)
    shot(page, "sky-show")
    page.locator(".gamesky-btn.primary").click()
    page.locator(".gamesky").wait_for(state="detached", timeout=WAIT)
    # leave and return: the answered question is still answered
    position = "JSON.stringify(__sky.g) + document.getElementById('sk-q').textContent + document.getElementById('sk-score').textContent"
    f.evaluate("window.dispatchEvent(new Event('pagehide'))")
    before = f.evaluate(position)
    page.reload()
    f2 = game(page, "skydetective.html")
    (
        becomes(f2, position, before)
        if False
        else f2.wait_for_function("() => window.__sky && __sky.g", timeout=WAIT)
    )
    assert f2.evaluate(position) == before
    assert not page.locator(
        ".gamesky"
    ).count(), "the sky must not reopen on a round already under way"
    assert not errors, errors
    ctx.close()


def test_a_study_left_before_starting_comes_back_as_a_study_without_reopening_the_sky(
    browser, zimi
):
    ctx, page, errors = open_game(browser, zimi, "skydetective.html")
    f = game(page, "skydetective.html")
    page.locator(
        ".gamesky-btn:not(.primary)"
    ).click()  # Close: back to the page's own study
    page.locator(".gamesky").wait_for(state="detached", timeout=WAIT)
    assert f.evaluate("__sky.g.study") is True
    f.locator("#sk-look").wait_for(state="visible", timeout=WAIT)
    shot(page, "sky-study-card")
    f.evaluate("window.dispatchEvent(new Event('pagehide'))")
    page.reload()
    f2 = game(page, "skydetective.html")
    f2.wait_for_function(
        "() => window.__sky && __sky.g && __sky.g.study === true", timeout=WAIT
    )
    frames(page, 4)
    assert not page.locator(".gamesky").count()
    click(f2, "#sk-look")  # the sky opens again on request
    page.locator(".gamesky .alm-sky-host").wait_for(state="attached", timeout=WAIT)
    page.locator(".gamesky-btn.primary").click()
    f2.wait_for_function("() => __sky.g.study === false", timeout=WAIT)
    assert not errors, errors
    ctx.close()


def test_sky_detective_outside_zimi_studies_on_its_own_named_dome(browser):
    class Plain(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k):
            pass

    srv = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(Plain, directory=GAMES)
    )
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto("http://127.0.0.1:%d/skydetective.html" % srv.server_address[1])
        page.wait_for_function(
            "() => window.__sky && __sky.g && __sky.g.study === true", timeout=WAIT
        )
        assert not page.evaluate("ZimiShell.hosted")
        assert (
            page.locator("#sk-look").is_hidden()
            and page.locator("#sk-next").is_visible()
        )
        assert page.locator("#sk-next").inner_text() == "Start"
        frames(page, 3)
        shot(page, "sky-study-standalone")
        page.locator("#sk-next").click()
        page.wait_for_function("() => __sky.g.study === false", timeout=WAIT)
        assert page.locator("#sk-q").inner_text()
        assert not errors, errors
        ctx.close()
    finally:
        srv.shutdown()


# ── the other games: one quiet link, and Back returns to the same position ───

ROUND_POSITION = "JSON.stringify(__round.round) + __round.at + ':' + __round.score + document.getElementById('rk-n').textContent"


@pytest.mark.parametrize(
    "name,pattern",
    [
        ("flags.html", r"^/w/wikipedia/"),
            ("firstlines.html", r"^/w/gutenberg/"),
    ],
)
def test_a_round_of_choices_links_the_answer_and_back_returns(
    browser, zimi, name, pattern
):
    ctx, page, errors = open_game(browser, zimi, name)
    f = game(page, name)
    f.wait_for_function(
        "() => window.__round && __round.zim && __round.round.length > 0", timeout=WAIT
    )
    # a question whose answer the library has a page for (a list links to articles a small ZIM may leave out: those get no link)
    for _ in range(8):
        click(f, ".rk-choice")
        try:
            f.locator("#rk-read").wait_for(state="visible", timeout=4000)
            break
        except Exception:
            click(f, "#rk-next")
    f.locator("#rk-read").wait_for(state="visible", timeout=100)
    assert hosted(f)
    if name == "flags.html":
        shot(page, "learn-flags")
    before = f.evaluate(ROUND_POSITION)
    f.evaluate("window.dispatchEvent(new Event('pagehide'))")
    click(f, "#rk-read")
    wait_path(page, pattern)
    assert "zimi_games" not in reader_path(page)
    shot(page, "learn-out-" + name.split(".")[0])
    f2 = back_to(page, name)
    f2.wait_for_function(
        "() => window.__round && __round.round.length > 0", timeout=WAIT
    )
    f2.wait_for_function(
        "p => (0, eval)(p) === " + repr(before), arg=ROUND_POSITION, timeout=WAIT
    )
    f2.locator("#rk-read").wait_for(state="visible", timeout=WAIT)
    shot(page, "learn-back-" + name.split(".")[0])
    assert not errors, errors
    ctx.close()


def test_higher_or_lower_carries_the_answers_article_and_links_it_only_when_the_zim_has_it(browser, zimi):
    """The lists link their rows to articles; the fixture's small Wikipedia holds few of them, so what is asked is that the link is
    there exactly when the page is (the round trip itself is Flags' and First Lines')."""
    ctx, page, errors = open_game(browser, zimi, "higherlower.html")
    f = game(page, "higherlower.html")
    f.wait_for_function("() => window.__round && __round.zim && __round.round.length > 0", timeout=WAIT)
    assert f.evaluate("__round.round.some(q => q.path && q.zim)"), "no question carries its answer's article"
    for _ in range(8):
        click(f, ".rk-choice")
        asked = f.evaluate("JSON.stringify(__round.round[__round.at])")
        has = f.evaluate("q => q.path && q.zim ? GamesLib.hasPage(q.zim, q.path) : false", __import__("json").loads(asked))
        frames(page, 8)
        assert f.locator("#rk-read").is_visible() == bool(has), asked
        if has:
            break
        click(f, "#rk-next")
    assert not errors, errors
    ctx.close()


def test_quizzical_links_the_article_and_back_returns(browser, zimi):
    ctx, page, errors = open_game(browser, zimi, "quizzical.html")
    f = game(page, "quizzical.html")
    f.wait_for_function(
        "() => window.__quiz && __quiz.zim && __quiz.round.length > 0", timeout=WAIT
    )
    click(f, ".qz-choice")
    f.locator("#qz-read").wait_for(state="visible", timeout=WAIT)
    position = "JSON.stringify(__quiz.round) + document.getElementById('qz-n').textContent + document.getElementById('qz-score').textContent"
    before = f.evaluate(position)
    f.evaluate("window.dispatchEvent(new Event('pagehide'))")
    click(f, "#qz-read")
    wait_path(page, r"^/w/(wikipedia|wiktionary)/")   # a round asks about both
    f2 = back_to(page, "quizzical.html")
    f2.wait_for_function(
        "p => window.__quiz && (0, eval)(p) === " + repr(before),
        arg=position,
        timeout=WAIT,
    )
    f2.locator("#qz-read").wait_for(state="visible", timeout=WAIT)
    assert not errors, errors
    ctx.close()


def test_babel_opens_the_word_in_the_dictionary_and_back_returns(browser, zimi):
    ctx, page, errors = open_game(browser, zimi, "babel.html")
    f = game(page, "babel.html")
    f.wait_for_function(
        "() => window.__babel && __babel.g && __babel.dict", timeout=WAIT
    )
    # give the round up by guessing wrong until it reveals
    for _ in range(12):
        if f.evaluate("__babel.g.phase") != "play":
            break
        f.fill("#bb-field", "zzzzz")
        f.locator("#bb-guess").click()
        frames(page, 2)
        if f.locator("#bb-more").is_visible():
            f.locator("#bb-more").click()
    f.locator("#bb-read").wait_for(state="visible", timeout=WAIT)
    f.wait_for_function(
        "() => /Dictionary/.test(document.getElementById('bb-read').textContent)",
        timeout=WAIT,
    )
    shot(page, "learn-babel")
    position = "JSON.stringify(__babel.g)"
    before = f.evaluate(position)
    f.evaluate("window.dispatchEvent(new Event('pagehide'))")
    click(f, "#bb-read")
    page.wait_for_function(
        "() => document.getElementById('reader-frame').contentWindow.location.pathname.endsWith('dictionary.html')",
        timeout=WAIT,
    )
    shot(page, "learn-babel-dictionary")
    f2 = back_to(page, "babel.html")
    f2.wait_for_function(
        "p => window.__babel && __babel.g && (0, eval)(p) === " + repr(before),
        arg=position,
        timeout=WAIT,
    )
    shot(page, "learn-back-babel")
    assert not errors, errors
    ctx.close()


def test_drop_pin_opens_the_place_on_the_map_and_back_returns(browser, zimi):
    ctx, page, errors = open_game(browser, zimi, "droppin.html")
    f = game(page, "droppin.html")
    f.wait_for_function(
        "() => window.__drop && __drop.g && __drop.g.mode === 'map'", timeout=WAIT
    )
    f.locator("#dp-drop").wait_for(state="visible", timeout=WAIT)
    # the fixture's map is a stand-in with no map in it: say where the "map" is looking, as StreetZim writes it into the hash
    f.evaluate("document.getElementById('dp-frame').contentWindow.location.hash = 'map=12/10.5/20.5'")
    f.evaluate("document.getElementById('dp-drop').click()")
    f.locator("#dp-map").wait_for(state="visible", timeout=WAIT)
    shot(page, "learn-droppin")
    place = f.evaluate(
        "(() => { const q = __drop.g.qs[__drop.g.at]; return [q.name, q.lat, q.lon]; })()"
    )
    assert place[0] in f.locator("#dp-map").inner_text()
    position = "JSON.stringify(__drop.g)"
    before = f.evaluate(position)
    f.evaluate("window.dispatchEvent(new Event('pagehide'))")
    click(f, "#dp-map")
    page.wait_for_function(
        "() => /\\/w\\/osm_test\\/index\\.html/.test(document.getElementById('reader-frame').contentWindow.location.pathname)",
        timeout=WAIT,
    )
    assert "map=14/" in page.evaluate(
        "document.getElementById('reader-frame').contentWindow.location.hash + location.hash"
    )
    shot(page, "learn-droppin-map")
    f2 = back_to(page, "droppin.html")
    f2.wait_for_function(
        "p => window.__drop && __drop.g && (0, eval)(p) === " + repr(before),
        arg=position,
        timeout=WAIT,
    )
    f2.locator("#dp-map").wait_for(state="visible", timeout=WAIT)
    assert not errors, errors
    ctx.close()


def test_where_in_the_world_opens_the_place_on_the_map_and_back_returns(browser, zimi):
    ctx, page, errors = open_game(browser, zimi, "whereintheworld.html")
    f = game(page, "whereintheworld.html")
    f.wait_for_function("() => window.__world && __world.round.length && __world.maps.length", timeout=WAIT)
    # the places of the player's own map: Menu > New game > Your maps > Start
    page.locator("#game-menu-btn").click()
    f.get_by_role("button", name="New game").first.click()
    f.get_by_role("button", name="Your maps").click()
    f.get_by_role("button", name="Start").click()
    f.wait_for_function("() => __world.round.length && __world.round[0].zim", timeout=WAIT)
    click(f, "#wm-svg")
    click(f, "#wm-guess")
    f.locator("#wm-map").wait_for(state="visible", timeout=WAIT)
    shot(page, "learn-world")
    name = f.evaluate("__world.round[0].name")
    assert name in f.locator("#wm-map").inner_text()
    position = "JSON.stringify(__world.round) + JSON.stringify(__world.pending) + document.getElementById('wm-score').textContent"
    before = f.evaluate(position)
    f.evaluate("window.dispatchEvent(new Event('pagehide'))")
    click(f, "#wm-map")
    page.wait_for_function("() => /\\/w\\/osm_test\\/index\\.html/.test(document.getElementById('reader-frame').contentWindow.location.pathname)", timeout=WAIT)
    f2 = back_to(page, "whereintheworld.html")
    f2.wait_for_function("p => window.__world && __world.round.length && (0, eval)(p) === " + repr(before), arg=position, timeout=WAIT)
    f2.locator("#wm-map").wait_for(state="visible", timeout=WAIT)
    assert not errors, errors
    ctx.close()


def test_five_letters_opens_the_word_in_the_dictionary_after_the_round(browser, zimi):
    ctx, page, errors = open_game(browser, zimi, "fiveletters.html")
    f = game(page, "fiveletters.html")
    f.wait_for_function("() => window.__five && __five.game", timeout=WAIT)
    for _ in range(6):   # six guesses of a real word end the round, won or lost
        if f.evaluate("__five.game.status") != "playing":
            break
        for ch in "about":
            f.locator('.fl-key[data-k="%s"]' % ch).click()
        f.locator('.fl-key[data-k="Enter"]').click()
        f.wait_for_function("() => !__five.busy", timeout=WAIT)
    f.wait_for_function("() => __five.game.status !== 'playing'", timeout=WAIT)
    f.locator("#fl-learn").wait_for(state="visible", timeout=WAIT)
    shot(page, "learn-fiveletters")
    f.evaluate("window.dispatchEvent(new Event('pagehide'))")
    click(f, "#fl-learn")
    page.wait_for_function("() => document.getElementById('reader-frame').contentWindow.location.pathname.endsWith('dictionary.html')", timeout=WAIT)
    f2 = back_to(page, "fiveletters.html")
    f2.wait_for_function("() => window.__five && __five.game && __five.game.status !== 'playing'", timeout=WAIT)
    f2.locator("#fl-learn").wait_for(state="visible", timeout=WAIT)
    assert not errors, errors
    ctx.close()


def test_wiki_race_end_sheet_offers_the_route_as_articles_and_back_returns(
    browser, zimi
):
    ctx, page, errors = open_game(browser, zimi, "wikirace.html")
    f = game(page, "wikirace.html")
    f.wait_for_function(
        "() => window.__race && __race.provider && !__race.provider.built && __race.race",
        timeout=WAIT,
    )
    click(f, ".rc-card .gm-play")
    click(f, ".rc-link")
    f.wait_for_function("() => __race.race.steps.length > 1", timeout=WAIT)
    f.evaluate("document.getElementById('rc-give').click()")
    f.locator(".rc-review-link").first.wait_for(state="visible", timeout=WAIT)
    assert f.locator(".rc-review-link").count() >= 2
    shot(page, "learn-wikirace")
    position = "JSON.stringify(__race.race.steps) + __race.race.pair.start.path + __race.race.pair.end.path"
    before = f.evaluate(position)
    f.evaluate("window.dispatchEvent(new Event('pagehide'))")
    f.locator(".rc-review-link").first.click()
    wait_path(page, r"^/w/wikipedia/")
    f2 = back_to(page, "wikirace.html")
    f2.wait_for_function(
        "p => window.__race && __race.race && (0, eval)(p) === " + repr(before),
        arg=position,
        timeout=WAIT,
    )
    assert not errors, errors
    ctx.close()


def test_without_zimi_around_there_is_no_link_into_it(browser):
    """From a plain folder the games draw no Dictionary, map or open-in-reader links (the article links stay plain links)."""

    class Plain(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k):
            pass

    srv = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(Plain, directory=GAMES)
    )
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        ctx = browser.new_context(viewport=VIEW)
        page = ctx.new_page()
        page.goto("http://127.0.0.1:%d/droppin.html" % srv.server_address[1])
        page.wait_for_function("() => window.__drop && __drop.g", timeout=WAIT)
        page.evaluate("document.getElementById('dp-pin') || 0")
        assert page.evaluate("GamesLib.hosted()") is False
        assert page.evaluate("GamesLib.tell({ zimi: 'open' })") is False
        assert page.locator("#dp-map").is_hidden()
        ctx.close()
    finally:
        srv.shutdown()


def test_a_link_to_a_zim_deleted_while_the_game_is_open_goes_away(browser, zimi):
    """The games read the library once at load; deleting a ZIM from Manage in the meantime must still take its "Read about"
    link away (the change stream says so), and a link made after that is not drawn. Last in the file: it removes a ZIM
    from the module's library."""
    import json

    ctx, page, errors = open_game(browser, zimi, "quizzical.html")
    f = game(page, "quizzical.html")
    f.wait_for_function("() => window.__quiz && __quiz.zim && __quiz.round.length > 0", timeout=WAIT)
    click(f, ".qz-choice")
    f.locator("#qz-read").wait_for(state="visible", timeout=WAIT)
    zim = f.evaluate("document.getElementById('qz-read').dataset.lzim")
    assert zim
    shot(page, "learn-link-before-delete")
    filename = f.evaluate("z => fetch('/list').then(r => r.json()).then(l => l.find(x => x.name === z).file)", zim)
    r = f.evaluate(
        "n => fetch('/manage/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: n }) }).then(r => r.status)",
        filename,
    )
    assert r == 200, r
    f.wait_for_function("() => document.getElementById('qz-read').hidden", timeout=WAIT)
    assert f.locator("#qz-read").is_hidden()
    shot(page, "learn-link-after-delete")
    assert not json.loads(json.dumps(errors)), errors
    ctx.close()
