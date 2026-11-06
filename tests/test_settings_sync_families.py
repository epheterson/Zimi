"""Every setting a person makes follows the account (Eric, 2026-10-21: "Things a
user changes while signed in should sync to all sessions all browsers").

One test per key family: each key the page lists in app.js's _PREF_KEYS lands in
the settings store, comes back, and is announced to the account's other windows;
a person's choices that live outside the shell (the Almanac's, the app pages',
a puzzle's preferences) are in that list, or ride the games store, by name.
"""

import json
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402
from zimi import changes, users  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def _pref_keys():
    """app.js's _PREF_KEYS as the key strings, through SK."""
    src = _read("zimi/static/app.js")
    sk = dict(
        re.findall(
            r"^\s+([A-Z_0-9]+):\s*'([^']+)'",
            re.search(r"var SK = \{(.*?)\n\};", src, re.S).group(1),
            re.M,
        )
    )
    names = re.findall(
        r"SK\.([A-Z_0-9]+)",
        re.search(r"var _PREF_KEYS = \[(.*?)\];", src, re.S).group(1),
    )
    return [sk[n] for n in names]


FAMILIES = {
    "shell": [
        "zimi_ui_lang",
        "zimi_library_view",
        "zimi_reader_theme",
        "zimi_app_theme",
        "zimi_welcome_dismissed",
        "zimi_reader_settings_coach",
        "zimi_tts_suggested",
        "zimi_maps_source",
    ],
    "almanac": [
        "zimi_almanac_place",
        "zimi_almanac_clocks",
        "zimi_almanac_clocks_view",
        "zimi_almanac_units",
        "zimi_sky_settings",
        "zimi_ae_orbits",
        "zimi_alm_landmarks",
        "zimi_alm_hd_later",
        "zimi_orrery_tried",
    ],
    "apps": [
        "zimi_wiki_view",
        "zimi_wiki_lang",
        "zimi_pdf_dark",
        "zimi_pdf_spread",
        "zimi_pdf_view",
        "zimitube_sort",
        "zimitube_autoplay",
        "zimitube_theater",
        "reddot_follow",
    ],
}


@pytest.fixture
def data(monkeypatch, tmp_path):
    d = tmp_path / "data"
    d.mkdir()
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(d))
    return d


def test_every_family_key_is_a_pref_key():
    keys = set(_pref_keys())
    for family, names in FAMILIES.items():
        assert set(names) <= keys, (family, sorted(set(names) - keys))


@pytest.mark.parametrize("family", sorted(FAMILIES))
def test_family_lands_in_the_store_and_is_announced(data, family):
    before = changes.resume_from(None)
    changes_ = {k: {"v": json.dumps({"k": k})} for k in FAMILIES[family]}
    ok, err, doc = users.change_settings("Kid", changes_, by="window-a")
    assert ok, err
    assert not doc.get("refused")
    kept = users.load_settings("Kid")["settings"]
    assert {k: kept[k]["v"] for k in FAMILIES[family]} == {
        k: v["v"] for k, v in changes_.items()
    }
    # Announced once per change, to that account's windows (not the one that made it).
    seen = [(t, o, b) for _, t, o, b in list(changes._log) if _ > before]
    assert ("settings", "Kid", "window-a") in seen


def test_every_pref_key_the_page_lists_is_accepted_and_all_fit_together(data):
    keys = _pref_keys()
    ok, err, doc = users.change_settings("Kid", {k: {"v": "1"} for k in keys})
    assert ok, err
    assert not doc.get("refused"), doc.get("refused")
    assert set(users.load_settings("Kid")["settings"]) == set(keys)
    assert len(keys) <= users.SETTINGS.max_keys


def test_a_games_setting_and_a_puzzles_preferences_ride_the_games_store(data):
    ok, err, doc = users.GAMES.change(
        "Kid",
        {
            "zimi.games.settings": {"v": json.dumps({"g": {"sound": False}})},
            "zimi.games.puzzleprefs.net": {"v": "Show grid lines\n0"},
            "zimi.zimcity.stats": {"v": "{}"},
        },
    )
    assert ok, err
    assert not doc.get("refused")
    assert "zimi.games.puzzleprefs.net" in users.GAMES.load("Kid")["settings"]


def test_the_puzzles_page_keeps_its_preferences_under_a_key_the_account_takes():
    src = _read("zimi/builtin/games/puzzles/zimi-fit.js")
    assert '"zimi.games.puzzleprefs."' in src
    assert users.GAMES.key_re.match("zimi.games.puzzleprefs.net")


def test_no_setting_of_a_person_is_written_raw_in_the_almanac_or_app_pages():
    """A choice goes through the one door (_prefWrite / prefWrite), never setItem."""
    for rel, door in (
        ("zimi/static/almanac.js", "_prefWrite"),
        ("zimi/static/almanac-earth.js", "_prefWrite"),
        ("zimi/static/almanac-sky.js", "_prefWrite"),
        ("zimi/static/almanac-tides.js", "_prefWrite"),
        ("zimi/static/almanac-orrery.js", "_prefWrite"),
        ("zimi/static/wiki.html", "prefWrite"),
        ("zimi/static/tube.html", "prefWrite"),
        ("zimi/static/reddot.html", "prefWrite"),
    ):
        src = _read(rel)
        assert door + "(" in src, rel
        for line in src.splitlines():
            m = re.search(r"localStorage\.setItem\(\s*([A-Za-z_.]+|'[^']+')", line)
            if not m:
                continue
            key = m.group(1)
            assert not re.search(
                r"zimi_(almanac_(place|clocks|units)|sky_settings|ae_orbits|alm_|orrery_tried|wiki_(view|lang))|"
                r"zimitube_|reddot_follow|SK\.ALM|AE_(ORBITS|LM_LAYER|HD_LATER)_KEY|AT_UNITS_KEY|_ALM_(PLACE|CLOCKS)_KEY|_ALM_CLOCKS_VIEW_KEY|"
                r"SKY_SETTINGS_KEY|_ORRERY_TRIED_KEY|^VIEW_KEY|^LANG_KEY",
                key,
            ), (rel, line.strip())
