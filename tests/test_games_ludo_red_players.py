"""Ludo in Red: the four players' yards and tokens sit on four clearly separate steps of red (they were within 70 points of 255 of
each other, 95 to 166 by luminance), and each token has a ring of its own.

Run: pytest tests/test_games_ludo_red_players.py -v
"""

import os
import re

CSS = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "builtin", "games", "ludo.css"), encoding="utf-8").read()
PLAYERS = ["#c13d3b", "#3d9555", "#d9a42d", "#3066b6"]   # ludo.js COLORS


def _red_fill(hex_colour):
    m = re.search(r'night-red :is\(\.ld-yard, \.ld-center, \.ld-disc\)\[fill="%s"\][^{]*\{ fill: (#[0-9a-f]{6}) !important' % hex_colour, CSS)
    assert m, hex_colour
    return m.group(1)


def _lum(h):
    r, g, b = (int(h[i:i + 2], 16) for i in (1, 3, 5))
    return 0.299 * r + 0.587 * g + 0.114 * b


def test_each_player_has_its_own_step_of_red():
    lums = [_lum(_red_fill(c)) for c in PLAYERS]
    assert lums == sorted(lums)
    assert all(b - a >= 20 for a, b in zip(lums, lums[1:])), lums


def test_each_player_has_its_own_ring_and_a_readable_number():
    for c in (1, 2, 3):
        assert re.search(r"night-red \.ld-disc\.c%d \{ stroke:" % c, CSS), c
    assert "night-red .ld-num.c2, :root.gs.night-red .ld-num.c3 { fill: #1e0402" in CSS
