"""A community catalog card carries its mark as a glyph in the icon's corner, not as words in the subtitle.

Run: pytest tests/test_catalog_community_corner_browser.py -v
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
from test_almanac_corners_browser import base  # noqa: E402,F401

SHOT = os.environ.get("CORNER_SHOTS", "")

_DRAW = """(src) => {
  const it = { name: 'x', title: 'Some Book', summary: 'Made by someone', article_count: 12, size_bytes: 5e6,
               source: src, download_url: 'https://e.org/x.zim' };
  const host = document.createElement('div');
  host.id = 'corner-host'; host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:100%;z-index:99999;background:var(--bg)';
  host.innerHTML = '<div class="catalog-grid">' + renderCatalogItem(it) + '</div>';
  document.body.appendChild(host);
  const card = host.querySelector('.catalog-item'), mark = card.querySelector('.community-corner');
  const sub = card.querySelector('.ci-meta').textContent;
  const c = card.getBoundingClientRect(), m = mark && mark.getBoundingClientRect();
  return { has: !!mark, sub: sub, label: mark && mark.getAttribute('aria-label'),
           right: m && c.right - m.right, top: m && m.top - c.top, inside: m && m.left >= c.left && m.bottom <= c.bottom,
           in_actions: !!mark && !!mark.closest('.ci-actions'), clear: !!m && document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2) !== null && mark.contains(document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2)) };
}"""


def _page(pw, base, width, theme):
    br = pw.chromium.launch()
    pg = br.new_context(viewport={"width": width, "height": 700}, service_workers="block").new_page()
    pg.goto(base + "/")
    pg.wait_for_function("() => typeof communityIcon === 'function'", timeout=60000)
    pg.add_script_tag(url=base + "/static/manage.js")
    pg.wait_for_function("() => typeof renderCatalogItem === 'function'", timeout=60000)
    pg.evaluate("t => document.documentElement.setAttribute('data-theme', t)", theme)
    return br, pg


def test_the_mark_sits_in_the_card_corner_and_not_in_the_subtitle(base):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        for width, theme in ((390, "dark"), (390, "light"), (1280, "dark")):
            br, pg = _page(pw, base, width, theme)
            got = pg.evaluate(_DRAW, "community")
            if SHOT:
                pg.screenshot(path=os.path.join(SHOT, "corner-%d-%s.png" % (width, theme)))
            br.close()
            assert got["has"] and got["inside"], got
            assert got["sub"].find(got["label"]) < 0, "the subtitle no longer names it: %r" % got
            assert got["in_actions"] and got["clear"], got   # the actions row since a84498c8f


def test_a_kiwix_card_has_no_mark(base):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br, pg = _page(pw, base, 390, "dark")
        got = pg.evaluate(_DRAW, "kiwix")
        br.close()
        assert not got["has"], got
