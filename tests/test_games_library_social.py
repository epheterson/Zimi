"""The games for friends and for the real sky, run in a browser the three ways the library games run (inside Zimi, inside the
kiwix-serve stand-in, and with no server): Wikipedia Telephone, Dictionary Bluff, Babel, Sky Detective, Drop Pin, and Wiki Race
for two on one phone. Each leaves and returns (page hidden, page reloaded, library there and gone) to the same position, and
the games that hand the phone over come back behind the cover, never with a secret on the screen.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_library_social.py -v
"""

import json
import os
import re
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from games_wait import frames, seen, shows, truthy, visible, watch  # noqa: E402
from test_games_library_more import (
    MODES,
    browser,
    leave_and_return,
    open_game,
    tap,
    world,
)  # noqa: E402,F401

GONE = pytest.mark.parametrize(
    "gone", [False, True], ids=["library there", "library gone"]
)
MODE = pytest.mark.parametrize("mode", MODES)
CLUE = "A long answer for any quiz at all"  # no word of a title in the fixture or the built-in articles


def cover(page):
    return page.locator(".pk-cover").count()


def ready_cover(page):
    page.wait_for_selector(".pk-cover button")
    page.click(".pk-cover button")
    page.wait_for_function("() => !document.querySelector('.pk-cover')")
    frames(page)


def covered(page):
    """The phone is behind a cover (a hand-over, or back from leaving)."""
    page.wait_for_selector(".pk-cover")
    return cover(page)


# ── Wikipedia Telephone ──────────────────────────────────────────────────────


@GONE
@MODE
def test_telephone(browser, world, mode, gone):
    ctx, page, errors = open_game(
        browser, world, mode, "telephone.html", "window.__tp && __tp.g && __tp.g.secret"
    )
    assert (page.evaluate("__tp.zim") != "") == (
        mode != "builtin"
    ), "the Wikipedia is used when there is one"
    assert cover(page) == 1, "the first player starts behind a cover"
    ready_cover(page)
    secret = page.evaluate("__tp.g.secret")
    assert secret["title"] in page.locator(".tp-secret").inner_text()
    # a clue that names the article is refused (only a word of four letters or more counts as its name: "Eve" cannot be refused)
    if any(len(w) >= 4 for w in re.split(r"\W+", secret["title"])):
        page.fill("#tp-clue", "It is the one called " + secret["title"])
        watch(page, "#tp-msg")
        tap(page, page.locator("#tp-actions .gm-play"))
        seen(page, "must not say")   # (the line clears itself after a couple of seconds)
        assert cover(page) == 0
    page.fill("#tp-clue", CLUE)
    tap(page, page.locator("#tp-actions .gm-play"))
    assert covered(page) == 1, "the phone is passed behind a cover"
    # leaving with the clue written: back behind the cover, the same clue, the secret not on the screen
    before, after = leave_and_return(ctx, page, world, mode, "telephone.html", gone, "JSON.stringify(__tp.g)")
    assert after == before and covered(page) == 1
    assert secret["title"] not in page.locator("body").inner_text().replace(
        page.locator(".pk-card").inner_text(), ""
    )
    ready_cover(page)
    assert CLUE in page.locator(".tp-clue").inner_text()
    if gone and mode != "builtin":
        ctx.close()   # (the search is the library's, and it is gone: the clue is all that can be checked)
        assert not errors, errors
        return
    # the first guess is right: three points
    page.fill("#tp-search", secret["title"])
    page.wait_for_selector("#tp-results button")
    page.locator("#tp-results button", has_text=secret["title"]).first.click()
    page.wait_for_function(truthy("__tp.g.points[0] === 3"))
    shows(page, "#tp-score", "Together")
    before, after = leave_and_return(ctx, page, world, mode, "telephone.html", gone, "JSON.stringify(__tp.g)")
    assert after == before and page.evaluate("__tp.g.phase") == "reveal"
    # on to the next round: the other player gives, behind a cover
    tap(page, page.locator("#tp-actions .gm-play"))
    page.wait_for_selector(".pk-cover")
    assert (
        "Player 2" in page.locator(".pk-card h2").inner_text()
        and page.evaluate("__tp.g.round") == 1
    )
    assert not errors, errors
    ctx.close()


# ── Dictionary Bluff ─────────────────────────────────────────────────────────


@GONE
@MODE
def test_dictionary_bluff(browser, world, mode, gone):
    ready = "window.__bluff && __bluff.g && __bluff.g.words && __bluff.g.words.length"
    # The game draws random words from the library's Wiktionary and, when too few of the draw are playable words (seven letters
    # or more, with a definition of their own), deals its built-in ones instead: that is the game's fallback, and the small
    # fixture library meets it in about one deal in twenty-five. A fresh page is another draw.
    for _ in range(8):
        ctx, page, errors = open_game(browser, world, mode, "bluff.html", ready)
        if mode != "zimi" or page.evaluate("__bluff.dict") != "":
            break
        ctx.close()
    if mode == "zimi":
        assert page.evaluate("__bluff.dict") != "", "Zimi's random Wiktionary words were used; refused: %s" % page.refused[:6]
    if mode == "builtin":
        assert page.evaluate("__bluff.dict") == ""
    words = page.evaluate("__bluff.g.words")
    assert len(words) == 3 and all(w["word"] and w["real"] for w in words)
    fakes = [
        "a small tool for pressing flowers",
        "the quiet hour after a big storm",
        "a kind of soft grey cloth",
    ]
    for i, fake in enumerate(fakes):
        ready_cover(page)
        assert ("Player %d" % (i + 1)) in page.locator(".bl-label").inner_text()
        page.fill("#bl-fake", fake)
        tap(page, page.locator("#bl-actions .gm-play"))
    page.wait_for_function(truthy("__bluff.g.phase === 'vote'"))
    assert covered(page) == 1
    before, after = leave_and_return(ctx, page, world, mode, "bluff.html", gone, "JSON.stringify(__bluff.g)")
    assert after == before and covered(page) == 1, "back behind the cover, the vote where it was"
    for i in range(3):
        ready_cover(page)
        assert page.locator(".bl-option").count() == 3, "your own fake is not on offer"
        tap(page, page.locator(".bl-option").first)
    page.wait_for_function(truthy("__bluff.g.phase === 'reveal'"))
    assert (
        page.locator(".bl-option.real").count() == 1
        and "The real definition" in page.locator(".bl-option.real").inner_text()
    )
    assert sum(page.evaluate("__bluff.g.totals")) >= 0
    assert not errors, errors
    ctx.close()


# ── Babel ────────────────────────────────────────────────────────────────────


@GONE
@MODE
def test_babel(browser, world, mode, gone):
    ctx, page, errors = open_game(
        browser,
        world,
        mode,
        "babel.html",
        "window.__babel && __babel.g && __babel.g.words",
    )
    g = page.evaluate("__babel.g")
    assert len(g["words"]) == 5 and all(len(w["clues"]) == 5 for w in g["words"])
    assert page.locator(".bb-clue:not(.hidden)").count() == 2
    if mode == "builtin":
        assert page.evaluate("__babel.dict") == "" and all(
            c["name"] == "" for w in g["words"] for c in w["clues"]
        )
    else:
        assert page.evaluate("__babel.dict") != "" and any(
            c["name"] for w in g["words"] for c in w["clues"]
        ), "the Wiktionary's translations were read"
    page.fill("#bb-field", "zzzz")
    page.keyboard.press("Enter")
    page.wait_for_function(truthy("__babel.g.shown === 3"))
    frames(page)
    assert (
        page.evaluate("__babel.g.shown") == 3
        and page.locator(".bb-clue:not(.hidden)").count() == 3
    )
    before, after = leave_and_return(ctx, page, world, mode, "babel.html", gone, "JSON.stringify(__babel.g)")
    assert after == before and page.locator(".bb-clue:not(.hidden)").count() == 3
    answer = g["words"][0]["answer"]
    page.fill("#bb-field", answer)
    page.keyboard.press("Enter")
    page.wait_for_function(truthy("__babel.g.phase === 'reveal'"))
    visible(page, "#bb-next")
    assert (
        page.evaluate("__babel.g.points[0]") == 3
        and page.evaluate("__babel.g.phase") == "reveal"
    )
    assert (
        page.locator("#bb-next").is_visible()
        and answer in page.locator("#bb-msg").inner_text()
    )
    assert not errors, errors
    ctx.close()


# ── Sky Detective ────────────────────────────────────────────────────────────


@GONE
@MODE
def test_sky_detective(browser, world, mode, gone):
    ctx, page, errors = open_game(
        browser,
        world,
        mode,
        "skydetective.html",
        "window.__sky && __sky.g && __sky.g.qs",
    )
    g = page.evaluate("__sky.g")
    assert len(g["qs"]) == 6 and [q["kind"] for q in g["qs"]] == ["name", "find"] * 3
    # the sky is studied first (the page's own named dome here: no Zimi to show the Almanac's): no question yet, a Start
    assert g["study"] is True and page.locator(".rk-choice").count() == 0
    assert page.locator("#sk-next").inner_text() == "Start" and page.locator("#sk-look").is_hidden()
    before, after = leave_and_return(ctx, page, world, mode, "skydetective.html", gone, "JSON.stringify(__sky.g)")
    assert before == after and page.evaluate("__sky.g.study") is True, "a study left comes back as a study"
    tap(page, page.locator("#sk-next"))
    assert page.evaluate("__sky.g.study") is False
    assert (
        page.locator(".rk-choice").count() == 4 and len(page.evaluate("__sky.vis")) >= 8
    )
    first = g["qs"][0]
    watch(page, "#sk-msg")
    tap(page, page.locator(".rk-choice", has_text=first["answer"]).first)
    seen(page, "Right")
    assert page.locator(".rk-choice.right").count() == 1
    before, after = leave_and_return(ctx, page, world, mode, "skydetective.html", gone, "JSON.stringify(__sky.g) + [...document.querySelectorAll('.rk-choice')].map(b => b.className + b.disabled).join()")
    assert before == after
    tap(page, page.locator("#sk-next"))
    # a find clue: tap exactly where the object is
    point = page.evaluate(
        "(() => { const q = __sky.g.qs[__sky.g.at], o = __sky.vis.find(x => x.id === q.id), p = SkyKit.dome(o.alt, o.az), r = document.getElementById('sk-dome').getBoundingClientRect(), R = r.width / 2 - 22;"
        " return [r.left + r.width / 2 + p.x * R, r.top + r.height / 2 + p.y * R]; })()"
    )
    watch(page, "#sk-msg")
    page.mouse.click(point[0], point[1])
    page.wait_for_function(truthy("__sky.g.score === 2"))
    seen(page, "Right")
    assert not errors, errors
    ctx.close()


# ── Drop Pin ─────────────────────────────────────────────────────────────────


@GONE
@MODE
def test_drop_pin(browser, world, mode, gone):
    ctx, page, errors = open_game(
        browser, world, mode, "droppin.html", "window.__drop && __drop.g && __drop.g.qs"
    )
    g = page.evaluate("__drop.g")
    assert (3 <= len(g["qs"]) <= 5) if mode == "zimi" else len(g["qs"]) == 5   # (the fixture's map holds four places)
    if mode == "zimi":
        assert (
            g["mode"] == "map" and page.evaluate("__drop.zim") == "osm_test"
        ), "your own StreetZim map is the board"
        assert (
            page.locator("#dp-frame").is_visible()
            and page.locator("#dp-cross").is_visible()
        )
        target = g["qs"][0]
        # the map is a frame with a hash the way StreetZim writes it: put its middle on the place
        page.evaluate(
            "document.getElementById('dp-frame').contentWindow.location.hash = 'map=14/%s/%s'"
            % (target["lat"], target["lon"])
        )
        page.click("#dp-drop")
        page.wait_for_function(truthy("__drop.g.ans"))
        assert (
            page.evaluate("__drop.g.ans.pts") == 100
            and "+100" in page.locator("#dp-msg").inner_text()
        )
    else:
        assert (
            g["mode"] == "world"
            and page.locator("#dp-world").is_visible()
            and not page.locator("#dp-frame").is_visible()
        )
        target = g["qs"][0]
        box = page.locator("#dp-world").bounding_box()
        ratio = box["height"] / box["width"]
        h = 800 * ratio
        y0 = (400 - h) / 2
        sx = box["x"] + box["width"] * (target["lon"] + 180) / 360
        sy = box["y"] + ((90 - target["lat"]) * 400 / 180 - y0) / h * box["height"]
        page.mouse.click(sx, sy)
        frames(page)
        page.click("#dp-drop")
        page.wait_for_function(truthy("__drop.g.ans"))
        assert (
            page.evaluate("__drop.g.ans.pts") >= 95
        ), "a tap on the place scores nearly everything"
    before, after = leave_and_return(ctx, page, world, mode, "droppin.html", gone, "JSON.stringify(__drop.g)")
    visible(page, "#dp-next")
    assert after == before
    tap(page, page.locator("#dp-next"))
    assert page.evaluate("__drop.g.at") == 1 and page.evaluate("__drop.g.ans") is None
    assert not errors, errors
    ctx.close()


# ── Wiki Race for two ────────────────────────────────────────────────────────


def start_two_players(page):
    page.get_by_role("button", name="Menu").click()
    page.locator(".gs-item", has_text="New game").click()
    page.locator(".gs-seg button", has_text="Two players").click()
    page.locator(".gs-actions button", has_text="Start").last.click()
    page.wait_for_selector(".rc-card .gm-play")


def begin(page):
    """Press the card's play button and wait for the race page (or the notice that the article is missing) to replace the card."""
    page.click(".rc-card .gm-play")
    page.wait_for_function("() => !document.querySelector('.rc-card .gm-play')")


def give_up(page, then):
    """Give up from the Menu; `then` is the page's own sign that it was taken (the next card, or the end sheet)."""
    page.get_by_role("button", name="Menu").click()
    page.locator(".gs-extras button", has_text="Give up").first.click()
    page.wait_for_function(truthy(then))


@GONE
@MODE
def test_wiki_race_for_two(browser, world, mode, gone):
    ready = "window.__race && __race.provider && __race.race"
    ctx, page, errors = open_game(browser, world, mode, "wikirace.html", ready)
    start_two_players(page)
    assert "Player 1" in page.locator(".rc-card h2").inner_text()
    first = page.evaluate("[__race.race.pair.start.path, __race.race.pair.end.path]")
    begin(page)
    tap(page, page.locator(".rc-link").first)
    give_up(page, "__race.race.hot.res.length === 1 && document.querySelector('.rc-card h2')")
    assert "Pass the phone to Player 2" in page.locator(".rc-card h2").inner_text()
    # between the two races: leaving and coming back keeps player 1's result and the hand-over
    leave_and_return(ctx, page, world, mode, "wikirace.html", gone, "__race.race.hot.res.length + (document.querySelector('.rc-card h2') || {textContent: ''}).textContent")
    page.wait_for_selector(".rc-card h2")
    assert "Pass the phone to Player 2" in page.locator(".rc-card h2").inner_text()
    assert page.evaluate("__race.race.hot.res.length") == 1
    if gone and mode != "builtin":
        ctx.close()   # (the second race needs the library's articles, and it is gone: the hand-over is all that can be checked)
        assert not errors, errors
        return
    page.click(".rc-card .gm-play")
    page.wait_for_function("() => { const h = document.querySelector('.rc-card h2'); return h && !h.textContent.includes('Pass the phone') && document.querySelector('.rc-card .gm-play'); }")
    assert "Player 2" in page.locator(".rc-card h2").inner_text()
    assert (
        page.evaluate("[__race.race.pair.start.path, __race.race.pair.end.path]")
        == first
    ), "the same race for both"
    begin(page)
    if page.locator(".rc-link").count():  # (with the library gone there is no article to follow)
        tap(page, page.locator(".rc-link").first)
    give_up(page, "document.querySelector('.ar-sheet:not([hidden])')")
    assert (
        "Draw" in page.locator(".ar-sheet:not([hidden])").inner_text()
    ), "both gave up: a draw"
    assert not errors, errors
    ctx.close()
