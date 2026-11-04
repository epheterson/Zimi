"""Keep offline, the way the movie apps do downloads, at 390 px.

  - one tap: "Keep offline" in a tile's menu starts at once, no confirm step, and
    the menu then offers Remove; the tile shows a filled disc when it is here;
  - it asks only when it will not fit (a toast) or is a big share of what is left
    (one line), and neither line has a number in it;
  - a ring on the tile while it comes, with a tiny menu to pause or cancel;
    nothing on tiles that are not on the phone;
  - the On this phone view: a storage bar (kept vs free), Manage with a remove
    button on each tile, Almanac and Help now as tiles;
  - offline: a kept ZIM opens from its tile, one that is not says why in a line,
    Discover shows only cards whose ZIM is kept, and the status is a small pill.

Screenshots (read by a person): ZIMI_SHOTS=/some/dir pytest tests/test_keep_flow_live.py
"""

import os
import re
import shutil
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_keep_phone_live as kp  # noqa: E402
import test_keep_resume_live as rs  # noqa: E402
from test_keep_phone_live import (
    _device,
    poll,
    pw,
    shot,
    wait_shell_kept,
)  # noqa: E402,F401
from test_offline_truth_live import Server, _free_port  # noqa: E402

ZIM = "wikipedia"
OTHER = "wikiquote"
NUMBER = re.compile(r"\d")


@pytest.fixture
def world(tmp_path):
    zims, data = tmp_path / "zims", tmp_path / "data"
    zims.mkdir()
    data.mkdir()
    kp.wf.build_library(str(zims))
    if os.path.exists(rs.REAL):
        shutil.copy(rs.REAL, zims)
    srv = Server(str(zims), str(data), _free_port())
    srv.start()
    proxy = rs.SlowProxy(srv.port, _free_port())
    yield srv, proxy
    proxy.stop()
    srv.stop()


def phone(pw):
    dev = _device(pw)
    dev["viewport"] = {"width": 390, "height": 844}
    br = pw.chromium.launch()
    return br, br.new_context(**dev)


def open_menu(pg, zim):
    pg.evaluate(
        "(z) => document.querySelector(`.stat-card[data-zim='${z}']`).scrollIntoView({block: 'center'})",
        zim,
    )
    pg.wait_for_timeout(300)
    x, y = pg.evaluate(
        "(z) => { const r = document.querySelector(`.stat-card[data-zim='${z}']`).getBoundingClientRect(); return [r.left + 80, r.top + r.height / 2]; }",
        zim,
    )
    pg.mouse.click(x, y, button="right")
    pg.wait_for_selector("#zim-ctx-menu.visible", timeout=5000)


def library(pw, world):
    srv, proxy = world
    br, ctx = phone(pw)
    pg = ctx.new_page()
    pg.goto(proxy.base + "/", wait_until="load")
    pg.wait_for_selector(".stat-card", timeout=30000)
    wait_shell_kept(pg)
    pg.wait_for_function("() => typeof _keepStart === 'function'")
    pg.evaluate("() => _keepLoad()")
    return br, ctx, pg


def menu_labels(pg):
    return pg.evaluate(
        "() => [...document.querySelectorAll('#zim-ctx-menu .ctx-item')].map(e => e.innerText.trim())"
    )


def test_one_tap_from_the_menu_then_remove(pw, world):
    br, ctx, pg = library(pw, world)
    assert not pg.query_selector(".keep-ico"), "before the first keep, tiles stay calm"
    open_menu(pg, ZIM)
    labels = menu_labels(pg)
    assert labels.index("Keep offline") == labels.index("Download ZIM file") + 1, labels
    shot(pg, "f1-menu")
    pg.click("[data-action='keep-start']")
    # No question was asked: nothing modal appeared, and it comes.
    assert not pg.query_selector(".pw-overlay.open")
    pg.wait_for_selector(
        ".stat-card[data-zim='%s'] .keep-ico.kept" % ZIM, timeout=30000
    )
    assert not pg.query_selector(".stat-card[data-zim='%s'] .keep-ico.pull" % OTHER)
    # One is kept: the others stay plain (no arrow on every card), and the card's ⋯ offers the keep.
    shot(pg, "f1-kept")
    # The home redraws once the phone's list has it: act on the cards after that.
    pg.wait_for_function("(z) => _keepNames.has(z)", arg=ZIM, timeout=15000)
    pg.wait_for_timeout(500)
    assert not pg.query_selector(".stat-card[data-zim='%s'] .keep-ico" % OTHER)
    pg.evaluate("(z) => document.querySelector(`.stat-card[data-zim='${z}']`).scrollIntoView({block: 'center'})", OTHER)
    pg.click(".stat-card[data-zim='%s'] .card-more" % OTHER)
    pg.click("#zim-ctx-menu [data-action='keep-start']")
    assert not pg.query_selector(".pw-overlay.open")
    pg.wait_for_selector(".stat-card[data-zim='%s'] .keep-ico.kept" % OTHER, timeout=30000)
    open_menu(pg, ZIM)
    assert "Remove from this phone" in menu_labels(
        pg
    ) and "Keep offline" not in menu_labels(pg)
    pg.click("[data-action='keep-remove']")
    pg.click("#ac-ok")   # it asks first (test_keep_files_live holds the wording)
    pg.wait_for_function("(z) => !document.querySelector(`.stat-card[data-zim='${z}'] .keep-ico`)", arg=ZIM, timeout=15000)
    pg.wait_for_function("(z) => !_keepNames.has(z)", arg=ZIM, timeout=15000)
    pg.wait_for_timeout(500)   # the home redraws once the phone's list has changed
    # The other goes the same way, from its ⋯: the last kept ZIM leaves no mark anywhere.
    pg.evaluate("(z) => document.querySelector(`.stat-card[data-zim='${z}']`).scrollIntoView({block: 'center'})", OTHER)
    pg.click(".stat-card[data-zim='%s'] .card-more" % OTHER)
    pg.click("#zim-ctx-menu [data-action='keep-remove']")
    pg.click("#ac-ok")
    pg.wait_for_function("() => !document.querySelector('.keep-ico')", timeout=15000)
    ctx.close()
    br.close()


def stub_room(pg, free):
    pg.evaluate("(f) => { KeepStore.room = async () => ({ quota: 0, usage: 0, free: f }); }", free)


def test_it_asks_only_when_it_will_not_fit_or_is_a_big_share(pw, world):
    br, ctx, pg = library(pw, world)
    size = pg.evaluate("async (z) => (await KeepStore.probe(z, {})).size", ZIM)
    # Where the room figure is real: a big share of what is left asks one line,
    # no numbers; saying no keeps nothing.
    pg.evaluate("() => { KeepStore.estimateIsFuzzy = () => false; }")
    stub_room(pg, size * 2)
    pg.evaluate("(z) => { _keepStart(z); }", ZIM)
    pg.wait_for_selector(".pw-overlay.open h3", timeout=10000)
    line = pg.inner_text(".pw-overlay.open h3")
    assert not NUMBER.search(line), line
    shot(pg, "f2-big-share")
    pg.click("#ac-cancel")
    pg.wait_for_timeout(500)
    assert not pg.query_selector(".stat-card[data-zim='%s'] .keep-ico" % ZIM)
    # It will not fit: a sheet, not a toast, and nothing starts.
    stub_room(pg, size // 2)
    pg.evaluate("(z) => { _keepStart(z); }", ZIM)
    pg.wait_for_selector(".keep-sheet", timeout=10000)
    assert not pg.query_selector(".keep-sheet [data-act='try']")
    pg.click(".keep-sheet [data-act='cancel']")
    assert not pg.query_selector(".stat-card[data-zim='%s'] .keep-ico" % ZIM)
    # Safari's figure is a rough guess: a ZIM that fits it starts with no question.
    pg.evaluate("() => { KeepStore.estimateIsFuzzy = () => true; }")
    stub_room(pg, size * 2)
    pg.evaluate("(z) => { _keepStart(z); }", ZIM)
    pg.wait_for_selector(".stat-card[data-zim='%s'] .keep-ico.kept" % ZIM, timeout=30000)
    assert not pg.query_selector(".pw-overlay.open")
    ctx.close()
    br.close()


@pytest.mark.fieldguide_on
def test_ring_while_it_comes_the_view_and_manage(pw, world):
    if not os.path.exists(rs.REAL):
        pytest.skip("the real 70 MB ZIM is not here")
    srv, proxy = world
    br, ctx, pg = library(pw, world)
    # One kept, one coming slowly, the rest plain.
    pg.evaluate("(z) => _keepStart(z)", ZIM)
    pg.wait_for_selector(
        ".stat-card[data-zim='%s'] .keep-ico.kept" % ZIM, timeout=30000
    )
    pg.evaluate("(z) => _keepStart(z)", rs.NAME)
    pg.wait_for_selector(
        ".stat-card[data-zim='%s'] .keep-ico.pull" % rs.NAME, timeout=30000
    )
    pg.wait_for_timeout(2500)
    pg.evaluate(
        "() => { const h = [...document.querySelectorAll('.cat-heading')].find(e => /On this phone/i.test(e.innerText)); h.scrollIntoView({block: 'start'}); window.scrollBy(0, -70); }"
    )
    shot(pg, "f3-library-kept-coming-plain")
    arc = pg.evaluate(
        "(z) => document.querySelector(`.stat-card[data-zim='${z}'] .kr-arc`).getAttribute('stroke-dasharray')",
        rs.NAME,
    )
    assert re.match(r"^[\d.]+ 100$", arc) and not arc.startswith("0 "), arc
    # The card's ⋯: where it stands in real numbers, then Pause and Cancel download.
    pg.click(".stat-card[data-zim='%s'] .card-more" % rs.NAME)
    pg.wait_for_selector("#zim-ctx-menu .ctx-keep-note")
    note = pg.inner_text("#zim-ctx-menu .ctx-keep-note")
    assert re.search(r"[\d.]+%", note) and " / " in note, note
    assert pg.query_selector("#zim-ctx-menu [data-action='keep-pause']") and pg.query_selector("#zim-ctx-menu [data-action='keep-cancel']")
    shot(pg, "f4-ring-menu")
    pg.click("#zim-ctx-menu [data-action='keep-pause']")
    pg.wait_for_selector(
        ".stat-card[data-zim='%s'] .keep-ico.paused" % rs.NAME, timeout=15000
    )

    # The view: a storage bar, Manage, Almanac and Help now as tiles.
    pg.evaluate("() => _keepOpenView()")
    pg.wait_for_selector(".keep-storage")
    poll(
        pg, "() => /free/.test(document.getElementById('keep-s-free').textContent)", 15
    )
    used, free = pg.inner_text("#keep-s-used"), pg.inner_text("#keep-s-free")
    assert re.match(r"^[\d.]+ (KB|MB|GB) kept$", used) and re.match(
        r"^[\d.]+ (KB|MB|GB|TB) free$", free
    ), (used, free)
    names = pg.evaluate(
        "() => [...document.querySelectorAll('.stats-grid .stat-card')].map(c => c.querySelector('.zt').innerText)"
    )
    assert "Wikipedia" in names and "Almanac" in names and "Help now" in names, names
    assert rs.NAME not in pg.evaluate(
        "() => [...document.querySelectorAll('.stat-card')].map(c => c.dataset.zim)"
    )
    shot(pg, "f5-view")
    pg.click("button.keep-manage-btn")
    pg.wait_for_selector(".keep-rm")
    shot(pg, "f6-view-manage")
    pg.click(".keep-rm")
    pg.click("#ac-ok")
    pg.wait_for_function(
        "() => !document.querySelector('.stat-card.kept')", timeout=15000
    )
    ctx.close()
    br.close()


def test_offline_a_kept_zim_opens_the_others_say_why_discover_is_only_what_opens(
    pw, world
):
    srv, proxy = world
    br, ctx, pg = library(pw, world)
    pg.evaluate("(z) => _keepStart(z)", ZIM)
    pg.wait_for_selector(
        ".stat-card[data-zim='%s'] .keep-ico.kept" % ZIM, timeout=30000
    )
    # The day's Discover cards as they were drawn online: one for the ZIM on the
    # phone, one for another, both with a title.
    pg.evaluate("""() => {
          const key = 'zimi_disc6-en_2026-10-15';
          const card = (zim, title) => ({ zim: zim, path: 'Main_Page', title: title, type: 'random', thumbnail: null, label: title });
          localStorage.setItem(key, JSON.stringify([{ type: 'today' }, card('wikipedia', 'Card of the kept one'), card('wikiquote', 'Card of the away one')]));
        }""")
    pg.evaluate("() => { const l = [KeepStore.state()]; }")
    wait_prime = pg.evaluate(
        "async () => (await (await fetch('/keep-local/list')).json()).zims.length"
    )
    assert wait_prime == 1
    srv.stop()
    ctx.set_offline(True)
    pg.close()

    pg = ctx.new_page()
    pg.goto(proxy.base + "/", wait_until="commit")
    pg.wait_for_selector(".stat-card.kept", timeout=20000)
    pg.wait_for_timeout(1500)
    pill = pg.inner_text("#conn-pill").strip()
    assert pill in ("Offline", "No server"), pill
    shot(pg, "f7-offline-home")
    # Discover is always first; the kept section follows it, in the library's own tiles.
    order = pg.evaluate(
        """() => { const kids = [...document.querySelectorAll('#output > *')];
          const d = kids.findIndex(e => e.id === 'discover-row');
          const k = kids.findIndex(e => /this phone/i.test(e.innerText || '') && e.classList.contains('cat-heading'));
          return [d, k]; }"""
    )
    assert order[0] == 0 and order[1] > order[0], order
    # Discover: the last copy, only what opens.
    disc = pg.evaluate(
        "() => (document.querySelector('.discover-scroll') || {}).innerText || ''"
    )
    assert "Card of the kept one" in disc and "Card of the away one" not in disc, disc

    # Not on the phone: a line says why, nothing opens.
    pg.evaluate(
        "(z) => document.querySelector(`.stat-card[data-zim='${z}']`).scrollIntoView({block: 'center'})",
        OTHER,
    )
    pg.click(".stat-card[data-zim='%s']" % OTHER)
    pg.wait_for_function(
        "() => /Not on this phone/.test(document.body.innerText)", timeout=5000
    )
    shot(pg, "f8-not-here")
    # On the phone: straight from the tile.
    pg.evaluate(
        "(z) => document.querySelector(`.stat-card.kept[data-zim='${z}']`).scrollIntoView({block: 'center'})",
        ZIM,
    )
    pg.click(".stat-card.kept[data-zim='%s']" % ZIM)
    kp.wait_article(pg, "Welcome to Wikipedia")
    ctx.close()
    br.close()


@pytest.mark.parametrize("theme", ["dark", "light", "red"])
def test_the_pill_and_the_tiles_hold_in_every_theme(pw, world, theme):
    srv, proxy = world
    br, ctx = phone(pw)
    ctx.add_init_script("localStorage.setItem('zimi_app_theme', '%s')" % theme)
    pg = ctx.new_page()
    pg.goto(proxy.base + "/", wait_until="load")
    pg.wait_for_selector(".stat-card", timeout=30000)
    wait_shell_kept(pg)
    pg.evaluate("() => _keepLoad()")
    pg.evaluate("(z) => _keepStart(z)", ZIM)
    pg.wait_for_selector(
        ".stat-card[data-zim='%s'] .keep-ico.kept" % ZIM, timeout=30000
    )
    srv.stop()
    ctx.set_offline(True)
    pg.close()
    pg = ctx.new_page()
    pg.goto(proxy.base + "/", wait_until="commit")
    pg.wait_for_selector(".stat-card.kept", timeout=20000)
    pg.wait_for_timeout(1200)
    pg.evaluate("() => window.scrollTo(0, 0)")
    shot(pg, "t-%s-offline-home" % theme)
    colors = pg.evaluate(
        """() => { const p = getComputedStyle(document.getElementById('conn-pill')); const i = getComputedStyle(document.querySelector('.keep-ico'));
                   return [p.color, p.backgroundColor, i.color, getComputedStyle(document.body).backgroundColor]; }"""
    )
    assert colors[0] != colors[1] and colors[2] != colors[3], colors
    if theme == "red":
        assert pg.evaluate(
            "() => document.documentElement.classList.contains('night-red')"
        )
    pg.click("#conn-pill")
    shot(pg, "t-%s-pill-menu" % theme)
    ctx.close()
    br.close()


# ── feedback in every view, the too-big sheet, the grouped menu ─────────────


def set_view(pg, view):
    pg.evaluate("(v) => { localStorage.setItem('zimi_library_view', v); renderHome(); }", view)
    pg.wait_for_timeout(400)


@pytest.mark.parametrize("view", ["list", "tiles"])
def test_the_ring_and_the_tick_show_in_the_list_and_the_compact_grid(pw, world, view):
    br, ctx, pg = library(pw, world)
    set_view(pg, view)
    pg.evaluate("(z) => _keepStart(z)", ZIM)
    pg.wait_for_selector(".stat-card[data-zim='%s'] .keep-ico.kept" % ZIM, timeout=30000)
    box = pg.evaluate(
        """(z) => { const c = document.querySelector(`.stats-grid .stat-card[data-zim='${z}']`);
          const i = c.querySelector('.keep-ico'), a = c.getBoundingClientRect(), b = i.getBoundingClientRect();
          return { inside: b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom,
                   w: b.width, grid: !!c.closest('.stats-grid.tiles') }; }""",
        ZIM,
    )
    assert box["inside"] and box["w"] >= 14, box
    assert box["grid"] == (view == "tiles")
    pg.evaluate("(z) => document.querySelector(`.stat-card[data-zim='${z}']`).scrollIntoView({block: 'center'})", ZIM)
    shot(pg, "g-%s-tick" % view)
    if os.path.exists(rs.REAL):
        pg.evaluate("(z) => _keepStart(z)", rs.NAME)
        pg.wait_for_selector(".stat-card[data-zim='%s'] .keep-ico.pull" % rs.NAME, timeout=30000)
        arc = pg.evaluate("(z) => document.querySelector(`.stat-card[data-zim='${z}'] .kr-arc`).getAttribute('stroke-dasharray')", rs.NAME)
        assert arc.endswith(" 100"), arc
        pg.evaluate("(z) => document.querySelector(`.stat-card[data-zim='${z}']`).scrollIntoView({block: 'center'})", rs.NAME)
        shot(pg, "g-%s-ring" % view)
    ctx.close()
    br.close()


def test_keep_messages_are_pinned_where_a_phone_sees_them(pw, world):
    br, ctx, pg = library(pw, world)
    pg.evaluate("() => _keepNotice('One at a time.')")
    r = pg.evaluate("() => { const e = document.getElementById('keep-notice').getBoundingClientRect(); return [e.top, e.bottom, innerHeight]; }")
    assert 0 < r[0] < 140 and r[1] < r[2] / 3, r   # under the top bar, nowhere near the bottom
    ctx.close()
    br.close()


def test_too_big_says_so_in_labels_and_offers_a_smaller_version(pw, world):
    br, ctx, pg = library(pw, world)
    big = 74 * 10**9
    pg.evaluate(
        "(b) => { KeepStore.room = async () => ({ quota: 0, usage: 0, free: 38e9 }); KeepStore.probe = async () => ({ ok: true, size: b }); }",
        big,
    )
    # Where the figure is real: the end of it, with a smaller version to take instead.
    pg.evaluate("() => { KeepStore.estimateIsFuzzy = () => false; }")
    pg.evaluate("() => { _keepStart('wikipedia_en'); }")
    pg.wait_for_selector(".keep-sheet")
    title = pg.inner_text(".keep-sheet h3")
    rows = pg.inner_text(".keep-sheet-rows")
    assert title == "Too big for this phone's Zimi space", title
    assert "Needs 74 GB" in rows and "Zimi may use 38 GB here" in rows, rows
    assert not pg.query_selector(".keep-sheet [data-act='try']"), "a real figure is not argued with"
    assert pg.query_selector(".keep-sheet-pick"), "a smaller version of the same title is offered"
    shot(pg, "s1-too-big-real")
    pg.click(".keep-sheet [data-act='cancel']")
    assert not pg.query_selector(".stat-card[data-zim='wikipedia_en'] .keep-ico")

    # Safari's figure is a rough guess: the sheet says so and lets it try.
    pg.evaluate("() => { KeepStore.estimateIsFuzzy = () => true; }")
    pg.evaluate("() => { _keepStart('wikipedia_en'); }")
    pg.wait_for_selector(".keep-sheet [data-act='try']")
    assert "rough estimate" in pg.inner_text(".keep-sheet-note")
    shot(pg, "s2-too-big-safari")
    # Taking the smaller version starts it at once.
    pg.evaluate("() => { KeepStore.probe = async () => ({ ok: true, size: 60000 }); }")
    pg.click(".keep-sheet-pick")
    pg.wait_for_selector(".stat-card[data-zim='wikipedia_en_simple'] .keep-ico.kept", timeout=30000)
    ctx.close()
    br.close()


def test_the_menu_is_in_groups_about_file_move_delete(pw, world):
    br, ctx, pg = library(pw, world)
    open_menu(pg, ZIM)
    groups = pg.evaluate(
        """() => { const out = [[]]; for (const e of document.querySelectorAll('#zim-ctx-menu > *')) {
            if (e.classList.contains('ctx-sep')) out.push([]); else out[out.length - 1].push(e.innerText.trim().replace(/\\s+/g, ' ')); }
          return out; }"""
    )
    assert groups[-4:] == [["About this ZIM"], ["Download ZIM file", "Keep offline", "Don’t auto-update this ZIM"], ["Move to… ›"], ["Delete"]], groups
    shot(pg, "m-grouped-menu")
    ctx.close()
    br.close()
