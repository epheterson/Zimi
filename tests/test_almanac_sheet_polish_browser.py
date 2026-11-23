"""The Go to sheet's polish, from an iPhone: the search field and the pills stay pinned while the list scrolls under
them (and the pill follows the section), the pinned head is the sheet's own colour edge to edge, and the band's gear works at a
landing site (the site's touch layer used to sit over it).

Run: pytest tests/test_almanac_sheet_polish_browser.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_almanac_sites_browser as base  # noqa: E402

served = base.served
page = base.page

SHEET_OPEN = "() => { _aeShowGo(true); }"
PINNED = """() => {
  var body = document.querySelector('#ae-go .ae-go-body'), h = body.querySelector('.ae-go-head'), q = document.getElementById('ae-go-q'),
      pills = body.querySelector('.ae-go-pills'), b = body.getBoundingClientRect();
  var heads = Array.from(document.querySelectorAll('#ae-go-groups h4[data-g]'));
  var moons = heads.filter(x => x.getAttribute('data-g') === 'alm_go_moons')[0];
  body.scrollTop += moons.getBoundingClientRect().top - b.top + 60;
  body.dispatchEvent(new Event('scroll'));
  var r = e => e.getBoundingClientRect(), hr = r(h);
  return { top: body.scrollTop, headTop: Math.round(hr.top - b.top), field: r(q).top >= b.top - 1 && r(q).bottom <= hr.bottom + 1, pills: r(pills).top >= b.top - 1 && r(pills).bottom <= hr.bottom + 1,
           lit: Array.from(document.querySelectorAll('[data-ae-pill].active')).map(x => x.dataset.aePill), pos: getComputedStyle(h).position };
}"""
COLOURS = """() => {
  var sheet = document.getElementById('ae-go'), h = sheet.querySelector('.ae-go-head'), s = sheet.getBoundingClientRect(), r = h.getBoundingClientRect();
  return { sheet: getComputedStyle(sheet).backgroundColor, head: getComputedStyle(h).backgroundColor, left: Math.round(r.left - s.left), right: Math.round(s.right - r.right) };
}"""


def _orbit(pg):
    pg.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); if (_ae.mission) _amStop(false); _aeShowGo(false); }")
    pg.evaluate("() => _aePreset('moon')")
    pg.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)


def test_the_field_and_the_pills_stay_pinned_and_the_lit_pill_follows_the_list(page):
    _orbit(page)
    page.click("#ae-find")
    page.wait_for_selector("#ae-go", state="visible")
    page.wait_for_function("() => !!_aeLm && document.querySelectorAll('#ae-go-groups h4[data-g]').length > 2", timeout=60_000)
    got = page.evaluate(PINNED)
    assert got["pos"] == "sticky" and got["top"] > 100, got
    assert got["headTop"] <= 0 and got["field"] and got["pills"], ("the search field and the pills stay at the top of the scrolled sheet", got)
    assert got["lit"] == ["moons"], ("the pill is the section scrolled into", got)
    page.click("#ae-find")


def test_the_pinned_head_is_the_sheets_colour_edge_to_edge(page):
    _orbit(page)
    page.click("#ae-find")
    page.wait_for_selector("#ae-go", state="visible")
    got = page.evaluate(COLOURS)
    assert got["sheet"] == got["head"] and got["head"] != "rgba(0, 0, 0, 0)", got
    assert got["left"] <= 1 and got["right"] <= 1, ("the band is not cut short of the sheet's sides", got)
    page.click("#ae-find")


def _gear_opens_settings(pg, how):
    pg.evaluate(SHEET_OPEN)
    pg.wait_for_selector("#ae-band-gear", state="visible")
    hit = pg.evaluate("() => { var g = document.getElementById('ae-band-gear'), r = g.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!t && !!t.closest('#ae-band-gear'); }")
    assert hit, (how, "something sits over the gear")
    pg.tap("#ae-band-gear")
    pg.wait_for_function("() => _ae.setOpen === true && !document.getElementById('ae-set').hidden", timeout=10_000)
    pg.tap("#ae-band-gear")
    pg.wait_for_function("() => !_ae.setOpen", timeout=10_000)
    pg.evaluate("() => _aeShowGo(false)")


def test_the_gear_opens_the_settings_in_orbit_at_a_site_driving_and_on_a_mission(page):
    _orbit(page)
    _gear_opens_settings(page, "orbit")
    base._visit(page, "moon", "Apollo 15")
    _gear_opens_settings(page, "stand")
    base._visit(page, "moon", "Apollo 15", drive=True)
    _gear_opens_settings(page, "drive")
    page.evaluate("() => { _aeSiteLeave(true); _aePreset('moon'); }")
    page.evaluate("() => _aeMissionStart('apollo11')")
    page.wait_for_function("() => !!_ae.mission && !!document.getElementById('am-hud')", timeout=120_000, polling=200)
    _gear_opens_settings(page, "mission")
    page.evaluate("() => _amStop(false)")
    page.evaluate("() => _aePreset('earth')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.evaluate("() => enterFly()")
    page.wait_for_function("() => !!_ae.ship", timeout=300_000, polling=250)
    _gear_opens_settings(page, "ufo")
    page.evaluate("() => _afStop()")
    page.evaluate("() => _aeLetGo()")
    page.wait_for_function("() => !_ae.ship && !_ae.shipExit && !_ae.fly", timeout=60_000, polling=250)   # the next test starts in orbit view


def test_a_landing_sites_button_says_see_it_in_all_ten_languages():
    import glob
    import json

    stand, see = {}, {}
    for f in glob.glob(os.path.join(base.ROOT, "zimi", "static", "i18n", "almanac", "*.json")):
        d = json.load(open(f, encoding="utf-8"))
        lang = os.path.basename(f)[:-5]
        stand[lang], see[lang] = d["alm_stand_here"], d["alm_site_visit"]
    assert len(see) == 10 and see["en"] == "See it", see
    assert all(see[k] and see[k] != stand[k] for k in see), ("each language's button is not its Stand here", see, stand)
    assert len(set(see.values())) == 10, see


def test_the_site_card_button_says_see_it(page):
    page.evaluate("() => { if (typeof _aeSiteLeave === 'function') _aeSiteLeave(true); _ae.sent = null; _aeNow(); }")
    page.evaluate("() => _aePreset('moon')")
    page.wait_for_function("() => !_ae.fly", timeout=300_000, polling=250)
    page.evaluate("() => _aeLmOpen('moon', _aeLm.moon.filter(r => r[0] === 'Apollo 15')[0])")
    page.wait_for_function("() => !!document.getElementById('as-visit')", timeout=120_000, polling=250)
    got = page.evaluate("() => { var b = document.getElementById('as-visit'); return [b.textContent, b.getAttribute('aria-label'), b.getBoundingClientRect().height]; }")
    assert got[0] == "See it" and got[1] in (None, "See it") and got[2] >= 44, got


def _sent_ready(pg):
    pg.evaluate("() => { _aeShowGo(false); _aeSentStart(); _aeTracksLoad(); _aeLmLoad(); }")
    pg.wait_for_function("() => !!_aeSent && !!_aeTracks && !!_aeLm", timeout=60_000)


def test_only_craft_with_a_model_and_a_place_today_are_listed_and_found(page):
    _sent_ready(page)
    got = page.evaluate(
        """() => {
          var listed = _aeSentListedObjects(), all = _aeSent.objects, bad = listed.filter(function (o) {
            var go = _aeSentNow(o).go; return _aeSent.pics[o.model] === undefined || ['site', 'craft', 'spot'].indexOf(go) < 0; }).map(o => o.id);
          var tess = _aeSent.byId.tess;
          return { n: listed.length, all: all.length, bad: bad, tessKept: !!tess && tess.name, tessListed: listed.indexOf(tess) >= 0,
                   found: _aeSentFind('tess'), rows: _aeSentRows().indexOf('TESS') >= 0, grid: _aeSentGrid().indexOf('TESS') >= 0,
                   fly: _aeGoGroups().filter(g => g[0] === 'alm_go_craft').map(g => g[1]).reduce((a, b) => a.concat(b), []).filter(k => k !== 'iss' && k !== AE_GO_LOADING && !AE_CRAFT_MODEL[k]) };
        }"""
    )
    assert got["bad"] == [] and 40 < got["n"] < got["all"], got
    assert got["tessKept"] and not got["tessListed"] and got["found"] == [] and not got["rows"] and not got["grid"], got   # its data stays, the sheet leaves it out
    assert got["fly"] == [], ("a probe with no model is not a place to fly to", got)


def test_a_crafts_name_on_its_card_can_be_selected(page):
    _sent_ready(page)
    page.evaluate("() => _aeGoPick('sent:tess')")   # (not listed, but the card still opens for a deep link)
    page.wait_for_function("() => !!_ae.sent && !!document.querySelector('#ae-card h3')", timeout=30_000)
    sel = page.evaluate("() => { var s = getComputedStyle(document.querySelector('#ae-card h3')); return [s.userSelect, s.webkitUserSelect]; }")
    assert "text" in sel, sel
    page.evaluate("() => { _ae.sent = null; _aeRenderCard(); }")
