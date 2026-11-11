"""Wiki Race: one race, one result. Tap a link, give up before its page arrives (a slow disk, a slow kiwix-serve), and the
late page counts for nothing: no step, no second end sheet, no "You won" after "You gave up".

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_wikirace_one_result_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

# The fewest links from where the race stands to its target, over the race's own provider.
ROUTE = """async () => { const R = __race.race, P = __race.provider, to = R.pair.end.path;
  const prev = {}, q = [R.steps[R.steps.length - 1].path]; prev[q[0]] = null;
  for (let i = 0; i < q.length && i < 400; i++) { const pg = await P.open(q[i]);
    for (const l of (pg.links || [])) { const p = l.path || l; if (p in prev) continue; prev[p] = q[i];
      if (p === to) { const out = [p]; let x = q[i]; while (prev[x] !== null) { out.unshift(x); x = prev[x]; } return out; } q.push(p); } }
  return null; }"""
SLOW_MS = 1500


def test_a_page_that_lands_after_give_up_counts_for_nothing(browser, served):
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    page.goto("%s/wikirace.html" % served)
    page.wait_for_function("window.__race && __race.race && __race.provider")
    page.evaluate(
        "() => { window.__sheets = []; const real = ZimiShell.endSheet;"
        " ZimiShell.endSheet = function (o) { __sheets.push(o.result); return real.apply(this, arguments); }; }"
    )
    page.click("button.gm-play")
    page.wait_for_function("__race.race.begun && __race.race.page")
    route = page.evaluate(ROUTE)
    assert route, "the built-in set has a route to the target"
    for path in route[:-1]:
        page.click('.rc-link[data-path="%s"]' % path)
        page.wait_for_function(
            "p => __race.race.steps[__race.race.steps.length - 1].path === p", arg=path
        )
    steps = page.evaluate("__race.race.steps.length")
    # From here every page takes SLOW_MS to come.
    page.evaluate(
        "ms => { const P = __race.provider, real = P.open.bind(P);"
        " P.open = p => real(p).then(pg => new Promise(r => setTimeout(() => r(pg), ms))); }",
        SLOW_MS,
    )
    page.click(
        '.rc-link[data-path="%s"]' % route[-1]
    )  # the winning link, still loading...
    page.evaluate(
        "document.getElementById('rc-give').click()"
    )  # ...when the player gives up
    page.wait_for_timeout(SLOW_MS * 2)
    assert page.evaluate("__sheets") == ["lose"], page.evaluate("__sheets")
    assert (
        page.evaluate("__race.race.steps.length") == steps
    ), "the late page is not a step of the race"
    assert page.evaluate("__race.race.gave") is True
    ctx.close()


def test_a_page_the_first_player_was_loading_does_not_land_in_the_seconds_turn(browser, served):
    """Two on one phone: the first player gives up with a link still loading; the second player's turn reuses the race, and
    the late page must not become a step of it."""
    ctx = browser.new_context(viewport=VIEW)
    page = ctx.new_page()
    page.goto("%s/wikirace.html" % served)
    page.wait_for_function("window.__race && __race.race && __race.provider")
    page.click("button.gm-play")
    page.wait_for_function("__race.race.begun && __race.race.page")
    # Two on one phone: the race the page runs is the hot-seat one (its own code paths: give up hands the phone over).
    page.evaluate("() => { __race.race.mode = 'hotseat'; __race.race.hot = { turn: 0, res: [] }; }")
    link = page.evaluate("document.querySelector('.rc-link').dataset.path")
    page.evaluate(
        "ms => { const P = __race.provider, real = P.open.bind(P);"
        " P.open = p => real(p).then(pg => new Promise(r => setTimeout(() => r(pg), ms))); }",
        SLOW_MS,
    )
    page.click('.rc-link[data-path="%s"]' % link)
    page.evaluate("document.getElementById('rc-give').click()")
    page.click("button.gm-play")  # the hand-off: Ready, player 2
    page.wait_for_function("__race.race.hot.turn === 1")
    page.wait_for_timeout(SLOW_MS * 2)
    assert page.evaluate("__race.race.steps.length") == 1, "the first player's late page is not a step of the second player's turn"
    ctx.close()
