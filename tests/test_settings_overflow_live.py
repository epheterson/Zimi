"""No settings or Manage pane can be made wider than its card by what is in it (#150).

A very long data-dir path, a very long ZIM file name and a very long environment value are put
where Zimi shows them, and every Manage tab and every Settings section is walked at 360, 734 and
1280 px, in Chromium and (when Playwright's Firefox is installed) Firefox. In each: nothing sticks
out past the card unless it sits in a box that scrolls on its own, no pane scrolls sideways under
overflow:hidden (that is a clipped pane), and the page itself has no sideways scroll.

Run: pytest tests/test_settings_overflow_live.py -v
"""

import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as srv  # noqa: E402

WIDTHS = (360, 734, 1280)
SECTIONS = ("library", "preferences", "languages", "creator", "server", "users")
TABS = ("browse", "installed", "collections", "downloads", "history")
LONG_NAME = "a_remarkably_long_zim_file_name_that_never_wraps_" * 3 + "en_all_2026-01"
LONG_DIR = "/home/someone/" + "very-long-folder-name-" * 8 + "zims"
LONG_ENV = "/mnt/" + "unbroken-path-segment-" * 12

# Elements past the right edge of the card, ignoring those inside a box that scrolls or clips by itself.
OFFENDERS = """(root) => {
  const card = document.querySelector(root) || document.body;
  const right = card.getBoundingClientRect().right + 1;
  const scrolls = (e) => { for (let p = e.parentElement; p && p !== card; p = p.parentElement) {
    const o = getComputedStyle(p).overflowX; if (o !== 'visible') return true; } return false; };
  const out = [];
  for (const e of card.querySelectorAll('*')) {
    const r = e.getBoundingClientRect();
    if (!r.width || getComputedStyle(e).display === 'none' || e.closest('[hidden]')) continue;
    if (r.right > right && !scrolls(e)) out.push((e.id || e.className || e.tagName) + ' ' + Math.round(r.right - right));
    if (out.length > 5) break;
  }
  const clipped = Array.from(document.querySelectorAll('.ms-pane, .manage-tab-content, .manage-settings'))
    .filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map(e => (e.id || e.className) + ' ' + (e.scrollWidth - e.clientWidth));
  const s = document.scrollingElement;
  return { out, clipped, page: s.scrollWidth - s.clientWidth };
}"""


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    from http.server import ThreadingHTTPServer

    from libzim.writer import Creator

    from conftest_zim import _MediaItem
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("overflow")
    zdir = tmp / "zims"
    zdir.mkdir()
    with Creator(str(zdir / (LONG_NAME + ".zim"))).config_indexing(False, "eng") as cr:
        cr.set_mainpath("home")
        cr.add_item(
            _MediaItem("home", "text/html", b"<html><body><h1>Home</h1></body></html>")
        )
        for k, v in {
            "Title": LONG_NAME,
            "Language": "eng",
            "Name": LONG_NAME,
            "Description": LONG_NAME,
            "Date": "2026-01-04",
        }.items():
            cr.add_metadata(k, v)
    data = tmp / LONG_DIR.strip("/")
    data.mkdir(parents=True)
    old = srv.ZIM_DIR, srv.ZIMI_DATA_DIR, os.environ.get("ZIMI_EXTRA_ZIM_DIRS")
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = str(zdir), str(data)
    os.environ["ZIMI_EXTRA_ZIM_DIRS"] = LONG_ENV
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old[0], old[1]
    if old[2] is None:
        os.environ.pop("ZIMI_EXTRA_ZIM_DIRS", None)
    else:
        os.environ["ZIMI_EXTRA_ZIM_DIRS"] = old[2]


def test_nothing_in_settings_or_manage_outgrows_its_card(served):
    pytest.importorskip("playwright")
    from playwright.sync_api import sync_playwright

    shots = os.environ.get("ZIMI_OVERFLOW_SHOTS")
    problems, ran = [], []
    with sync_playwright() as pw:
        for name in ("chromium", "firefox"):
            try:
                br = getattr(pw, name).launch()
            except Exception:
                continue
            ran.append(name)
            for w in WIDTHS:
                pg = br.new_page(viewport={"width": w, "height": 900})
                pg.goto(served + "/?manage=library")
                pg.wait_for_function(
                    "() => document.querySelector('.manage-tab')", timeout=20000
                )
                pg.wait_for_function(
                    "() => document.getElementById('ms-pane') && !document.querySelector('#ms-pane .loading')",
                    timeout=20000,
                )

                def check(label, root=".manage-wrap"):
                    pg.wait_for_timeout(700)
                    got = pg.evaluate(OFFENDERS, root)
                    if got["out"] or got["clipped"] or got["page"] > 0:
                        problems.append("%s %dpx %s: %s" % (name, w, label, got))
                    if shots:
                        pg.screenshot(
                            path=os.path.join(shots, "%s-%d-%s.png" % (name, w, label))
                        )

                for tab in TABS:
                    pg.evaluate("t => switchManageTab(t)", tab)
                    check(tab)
                pg.evaluate("() => switchManageTab('settings')")
                for sec in SECTIONS:
                    pg.evaluate("s => switchMs(s)", sec)
                    check(sec)
                # Create's forms: every mode's panel, in its own page.
                pg.goto(served + "/")
                pg.wait_for_function("() => typeof openCreate === 'function'", timeout=20000)
                pg.evaluate("() => openCreate()")
                pg.wait_for_selector("#create-modes .create-chip", timeout=20000)
                for i in range(pg.locator("#create-modes .create-chip").count()):
                    chip = pg.locator("#create-modes .create-chip").nth(i)
                    if chip.is_enabled():
                        chip.click()
                        check("create-%d" % i, "#create-picker")
                pg.close()
            br.close()
    assert ran, "no browser could be launched"
    assert not problems, "\n".join(problems)
