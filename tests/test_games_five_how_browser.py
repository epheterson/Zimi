"""Five Letters: the how-to-play sheet opens once by itself on a device, and the "?" in the bar reopens it.

It has the shape every game's How to play has (after Wordle's): one line, two bullets, three
example rows each naming its letter, and a note; Escape closes it straight away.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_five_how_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

SHOTS = os.environ.get("FL_SHOTS")


def open_page(served, browser, **kw):
    ctx = browser.new_context(viewport=kw.pop("viewport", VIEW), has_touch=True, **kw)
    page = ctx.new_page()
    page.goto("%s/fiveletters.html" % served)
    page.wait_for_selector(".fl-tile")
    return ctx, page


def test_sheet_shows_once_then_the_question_mark_reopens_it(served, browser):
    ctx, page = open_page(served, browser)
    page.wait_for_selector(".gs-sheet:not([hidden]) .fl-how")
    sheet = page.locator(".gs-sheet:not([hidden])")
    assert sheet.locator(".gs-how-line").inner_text() == "Guess the word in six tries."
    assert sheet.locator(".gs-how-list li").count() == 2
    assert sheet.locator(".fl-how-ex").count() == 3
    assert sheet.locator(".fl-how-cap").first.inner_text() == "C is in the word and in the right spot."
    assert sheet.locator(".fl-tile.correct").count() == 1
    assert sheet.locator(".fl-tile.present").count() == 1
    assert sheet.locator(".fl-tile.absent").count() == 1
    assert page.locator(".fl-how-note").inner_text().strip()
    page.keyboard.press("Escape")
    assert page.locator(".gs-sheet:not([hidden])").count() == 0
    page.reload()
    page.wait_for_selector(".fl-tile")
    page.wait_for_timeout(400)
    assert page.locator(".gs-sheet:not([hidden])").count() == 0, "seen once, remembered on the device"
    page.locator("#fl-help").click()
    page.wait_for_selector(".gs-sheet:not([hidden]) .fl-how")
    ctx.close()


def test_shots(served, browser):
    if not SHOTS:
        return
    os.makedirs(SHOTS, exist_ok=True)
    for scheme in ("light", "dark"):
        for name, vp in (("m", VIEW), ("d", {"width": 1280, "height": 800})):
            ctx, page = open_page(served, browser, viewport=vp, color_scheme=scheme)
            page.wait_for_selector(".gs-sheet:not([hidden]) .fl-how")
            page.wait_for_timeout(300)
            page.screenshot(path="%s/how-%s-%s.png" % (SHOTS, name, scheme))
            page.keyboard.press("Escape")
            page.screenshot(path="%s/board-%s-%s.png" % (SHOTS, name, scheme))
            ctx.close()
