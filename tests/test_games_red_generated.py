"""The Games' Red rules for a stylesheet's own colours are generated (scripts/games_red.py); a stylesheet edited without
regenerating would ship a game with light colours in Red. Run: python3 scripts/games_red.py"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

import games_red  # noqa: E402


def test_every_games_stylesheet_has_its_current_red_block():
    stale = [fn for fn in sorted(os.listdir(games_red.GAMES)) if fn.endswith(".css")
             and games_red.generated(os.path.join(games_red.GAMES, fn)) != open(os.path.join(games_red.GAMES, fn), encoding="utf-8").read()]
    assert not stale, "run python3 scripts/games_red.py: %s" % stale


def test_the_converter_maps_by_luminance_onto_black_to_red():
    assert games_red.convert("#fff") == "#ff2010"
    assert games_red.convert("#000") == "#000000"
    assert games_red.convert("rgba(255, 255, 255, 0.5)") == "rgba(255, 32, 16, 0.5)"
    assert games_red.convert("var(--ink)") == "var(--ink)"
