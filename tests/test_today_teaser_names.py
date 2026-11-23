"""The Today card's fallback teaser names its shower or holiday in the
person's language, through the strings the Almanac already carries."""

import json
import os
import re
import shutil
import subprocess

import pytest

STATIC = os.path.join(os.path.dirname(__file__), "..", "zimi", "static")
APP = open(os.path.join(STATIC, "app.js"), encoding="utf-8").read()
LANGS = ("de", "ru", "ar", "fr", "es", "pt", "zh", "hi", "he")


def _strings(lang):
    with open(os.path.join(STATIC, "i18n", lang + ".json"), encoding="utf-8") as f:
        return json.load(f)


def _teaser_names():
    block = re.search(r"var showers = \[(.*?)\];", APP, re.S).group(1)
    showers = re.findall(r"\[\d+,\d+,'([^']+)',\d+\]", block)
    hols = re.search(r"var holidays = \[(.*?)\];", APP, re.S).group(1)
    return showers, re.findall(r"\[\d+,\d+,(?:\"([^\"]+)\"|'([^']+)')\]", hols)


def test_the_teaser_names_go_through_the_language():
    assert "name: _teaserName('alm_shower_', s[2])" in APP
    assert "name: _teaserName('alm_hol_', h[2])" in APP


@pytest.mark.skipif(not shutil.which("node"), reason="needs node")
@pytest.mark.parametrize("lang", LANGS)
def test_a_shower_is_named_in_the_language(lang):
    fn = re.search(r"function _teaserName\(.*?\n}\n", APP, re.S).group(0)
    strings = _strings(lang)
    showers, _ = _teaser_names()
    script = (
        "var S=%s;function t(k){return S[k]||k}%s"
        "console.log(JSON.stringify(%s.map(function(n){return _teaserName('alm_shower_',n)})))"
    ) % (json.dumps(strings), fn, json.dumps(showers))
    out = json.loads(subprocess.check_output(["node", "-"], input=script, text=True, encoding="utf-8"))
    want = [
        strings["alm_shower_" + re.sub(r"[^a-z0-9]+", "_", n.lower())] for n in showers
    ]
    assert out == want


def _fn(name):
    return re.search(r"function %s\(.*?\n}\n" % name, APP, re.S).group(0)


@pytest.mark.skipif(not shutil.which("node"), reason="needs node")
def test_a_card_in_another_language_than_the_page_carries_its_code():
    script = (
        "var _currentLang='de';function _normLang(l){return l.slice(0,2)}"
        "function _langDisplayName(c){return c}function esc(s){return s}function escAttr(s){return s}"
        "function t(k){return k}function tPluralH(k,n){return n}"
        + re.search(r"var _OWN_ZIM_APP = [^\n]*\n", APP).group(0)
        + _fn("_zimLangBadgeInfo")
        + _fn("_langBadge")
        + _fn("_cardLangBadge")
        + "console.log(JSON.stringify(["
        "_cardLangBadge({name:'apod',language:'eng'}),_cardLangBadge({name:'x',language:'deu'}),"
        "_cardLangBadge({name:'x',language:'eng,fra'}),_cardLangBadge(null)]))"
    )
    got = json.loads(subprocess.check_output(["node", "-"], input=script, text=True, encoding="utf-8"))
    assert "EN" in got[0] and got[1:] == ["", "", ""], got


def test_a_destructive_menu_item_is_coloured_before_it_is_touched():
    css = open(os.path.join(STATIC, "app.css"), encoding="utf-8").read()
    assert re.search(r"\.ctx-item\.danger\s*\{[^}]*color:\s*var\(--error\)", css)


def test_a_card_icon_waits_on_the_cards_surface_not_on_white():
    css = open(os.path.join(STATIC, "app.css"), encoding="utf-8").read()
    assert re.search(
        r"\.card-icon img\.iw:not\(\.ld\)\s*\{[^}]*background:\s*transparent", css
    )
    assert 'loading="lazy" class="iw" onload="this.classList.add(' in APP
    assert APP.count("_cardIconImg(z.name)") == 2
