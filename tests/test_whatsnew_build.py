"""scripts/whatsnew.py reads the own-ZIM highlights out of the changelog."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

import whatsnew  # noqa: E402

LOG = """## [1.2.3]

### Highlights

- ZimiGames: over 100 offline games.
- **Sky Detective:** studies the Almanac's sky before it asks.
- **Sky:** the star chart scrubs through time.
- The Almanac and the games are real ZIMs.
"""


def test_plain_labels_count_and_sky_detective_is_a_game_not_the_almanac():
    got = whatsnew.build(LOG)["1.2.3"]
    assert got["zimi_games"] == ["ZimiGames: over 100 offline games.", "Sky Detective: studies the Almanac's sky before it asks."]
    assert got["zimi_almanac"] == ["Sky: the star chart scrubs through time."]
