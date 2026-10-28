"""ZimiGames' strings: text.js is what text/en.json says, and every string id a game file asks for exists.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 python3 -m pytest tests/test_games_text.py -q
"""

import json
import os
import re
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
GAMES = os.path.join(ROOT, "zimi", "builtin", "games")

# Files that draw strings through T(): the shared ones.
SHARED = ["shell.js", "cards.js", "cardtable.js", "shelf.js", "recent.js", "boardkit.js", "gamepad.js"]
# Games that draw their strings through TX() (add a game here when its sweep is done).
CONVERTED = ["spades.js", "euchre.js", "belote.js", "durak.js", "scopa.js", "koikoi.js", "cribbage.js", "gin.js", "crazyeights.js", "skat.js", "truco.js", "bridge.js", "canasta.js", "climbing.js", "bigtwo.js", "tienlen.js", "holdem.js", "blackjack.js", "teenpatti.js", "hearts.js", "handoff.js", "solitaire.js", "freecell.js", "spider.js", "pyramid.js", "golf.js", "tripeaks.js"]
_KEY = re.compile(r"""\bTX?\(\s*['"]([a-z][A-Za-z0-9_.]*)['"]""")
# The arcade, kids, puzzle and word pages: their .js and .html (data-t, data-t-aria and data-t-title carry ids too).
PAGES = ["snake", "bricks", "pinball", "rocks", "lastline", "lander", "paddles", "circuit", "roadrush", "hopper", "muncher",
         "crossing", "blast", "quest", "kart", "stacker", "memory", "echo", "noughts", "snakesandladders", "pet", "2048",
         "sudoku", "minesweeper", "sokoban", "codebreaker", "fiveletters", "letterbyletter", "quizzical", "jigsaw",
         "wikirace", "whereintheworld", "timeline", "higherlower", "spellingbee", "minicrossword", "firstlines", "flags", "roundkit", "telephone", "bluff", "babel", "skydetective", "droppin", "passkit"]
_ATTR = re.compile(r'data-t(?:-aria|-title)?="([a-z][A-Za-z0-9_.]*)"')


def table():
    with open(os.path.join(GAMES, "text", "en.json"), encoding="utf-8") as f:
        return json.load(f)


def test_text_js_is_current():
    out = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "games_text.py"), "--check"], capture_output=True, text=True)
    assert out.returncode == 0, out.stdout + out.stderr


def test_every_string_id_exists():
    have, missing = table(), []
    for name in SHARED + CONVERTED:
        path = os.path.join(GAMES, name)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            for key in _KEY.findall(f.read()):
                # A key ending in a dot is a prefix a dynamic id is built from (cards.rank. + 12): its members are checked by the tests that build them.
                if not key.endswith(".") and key not in have:
                    missing.append(name + ": " + key)
    assert not missing, "string ids with no English text: " + ", ".join(sorted(set(missing)))


def test_every_asked_id_has_english_and_every_english_is_asked_for():
    """scripts/games_text.py audit(): a gap in the table shows a player a bare id; an unused entry is dead weight."""
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import games_text

    assert games_text.audit() == []


def test_plurals_have_one_and_other():
    for key, value in table().items():
        if isinstance(value, dict):
            assert "other" in value, key + " needs an 'other' form"


def test_every_page_string_id_exists():
    have, missing = table(), []
    for name in PAGES:
        for ext in (".js", ".html"):
            path = os.path.join(GAMES, name + ext)
            if not os.path.exists(path):
                continue
            with open(path, encoding="utf-8") as f:
                text = f.read()
            for key in _KEY.findall(text) + _ATTR.findall(text):
                if not key.endswith(".") and key not in have:
                    missing.append(name + ext + ": " + key)
    assert not missing, "string ids with no English text: " + ", ".join(sorted(set(missing)))


def test_every_language_has_every_string():
    """Each of the nine text/<lang>.json files carries exactly English's ids, with every slot kept and plural entries
    in the categories the language uses (scripts/games_text.py translations_audit())."""
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import games_text

    assert games_text.translations_audit() == []


def test_the_checker_catches_a_missing_extra_and_mismatched_string():
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import games_text

    have = {"a.one": "Hello {name}", "a.n": {"one": "{n} card", "other": "{n} cards"}, "a.plain": "Back"}
    ok = {"a.one": "Hallo {name}", "a.n": {"one": "{n} Karte", "other": "{n} Karten"}, "a.plain": "Zurueck"}
    assert games_text.translation_problems("de", have, ok) == []
    assert games_text.translation_problems("de", have, {k: v for k, v in ok.items() if k != "a.plain"}) == ["de: missing a.plain"]
    assert games_text.translation_problems("de", have, dict(ok, **{"a.extra": "x"})) == ["de: extra a.extra"]
    assert any("slots" in p for p in games_text.translation_problems("de", have, dict(ok, **{"a.one": "Hallo {nom}"})))
    assert any("plain string" in p for p in games_text.translation_problems("de", have, dict(ok, **{"a.plain": {"one": "x", "other": "y"}})))
    assert any("does not use" in p for p in games_text.translation_problems("de", have, dict(ok, **{"a.n": {"one": "{n} Karte", "few": "x {n}", "other": "{n} Karten"}})))
    assert games_text.translation_problems("zh", have, dict(ok, **{"a.n": {"other": "{n} 张牌"}})) == []

