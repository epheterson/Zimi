"""ZimiKart on a phone: your own kart is in view from the first frame, and a thumb rolls from Left to Right.

At the start the grid's next row sat between the camera and your kart, so the screen was other drivers' backs. And a
held Left kept the finger after it slid onto Right (pointer capture), so steering the other way meant lifting the thumb.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_kart_touch_browser.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_games_persist_browser import VIEW, browser, served  # noqa: E402,F401

SLIDE = """() => {
  const [l, r] = [...document.querySelectorAll('.kt-pad[data-p="0"] .kt-steer .kt-btn')], rr = r.getBoundingClientRect(), lr = l.getBoundingClientRect();
  const ev = (t, el, x, y) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: y }));
  ev('pointerdown', l, lr.x + 10, lr.y + 10);
  const held = [l.getAttribute('aria-pressed'), r.getAttribute('aria-pressed')];
  ev('pointermove', l, rr.x + rr.width / 2, rr.y + rr.height / 2);
  const slid = [l.getAttribute('aria-pressed'), r.getAttribute('aria-pressed')];
  return { held, slid };
}"""


def _race(browser, served):
    ctx = browser.new_context(viewport=VIEW, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto("%s/kart.html?debug" % served)
    page.locator(".ar-sheet-actions .gs-primary").first.tap()
    page.wait_for_function("() => window.__kart && __kart.g.race && __kart.g.race.karts.length === 8")
    return ctx, page


def test_a_thumb_slides_from_left_to_right(served, browser):
    ctx, page = _race(browser, served)
    got = page.evaluate(SLIDE)
    assert got["held"] == ["true", "false"]
    assert got["slid"] == ["false", "true"], got
    ctx.close()


def test_no_kart_behind_you_is_drawn_over_yours(served, browser):
    """The view leaves out every kart behind yours, and keeps yours."""
    ctx, page = _race(browser, served)
    got = page.evaluate("""() => {
      const karts = __kart.g.race.karts, k = karts.find(o => o.human === 0), cam = {};
      KartView.follow(cam, k, 0, true);
      const cm = KartEngine.makeCamera(cam.x, cam.y, cam.yaw, { w: 200, h: 21, f: 170, hz: 60 });
      const along = o => (o.x - k.x) * cm.fx + (o.y - k.y) * cm.fy;
      return { behind: karts.filter(o => along(o) < -4).length, shown: KartView.shownKarts(cm, k, karts).map(o => [o === k, along(o)]) };
    }""")
    assert any(mine for mine, _ in got["shown"]), "your own kart is shown"
    assert all(d >= -4 for _, d in got["shown"]), got
    ctx.close()
