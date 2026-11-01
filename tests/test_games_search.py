"""The main search's Games row: GET /games-search (zimi/gamelinks.py search_index).

Every tile of the shelf is findable by its name in the reader's language, nothing
is offered without the games ZIM, and the index costs a request no ZIM read.
"""

import glob
import os
import re
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi  # noqa: F401,E402
from libzim.reader import Archive  # noqa: E402
from zimi import gamelinks  # noqa: E402
from zimi import server as _srv  # noqa: E402

GAMES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "builtin", "games")
# The built games ZIM, opened here: the server's own pool depends on what other tests in the same worker left behind.
GAMES_ZIM = sorted(glob.glob(os.path.join(os.path.dirname(GAMES), "zimi_games_*.zim")))[-1]


class SearchIndexTests(unittest.TestCase):
    def setUp(self):
        for p in (
            mock.patch.object(gamelinks.ownzims, "enabled", lambda: True),
            mock.patch.object(_srv, "_zim_list_cache", [{"name": "zimi_games"}]),
            mock.patch.object(_srv, "get_archive", lambda name: Archive(GAMES_ZIM) if name == "zimi_games" else None),
        ):
            p.start()
            self.addCleanup(p.stop)

    def test_every_tile_of_the_shelf_is_there_with_its_page(self):
        with open(os.path.join(GAMES, "index.html"), encoding="utf-8") as f:
            hrefs = set(re.findall(r'<a class="ar-game" href="([^"#?]+\.html)"', f.read()))
        got = {g["p"] for g in gamelinks.search_index("en")}
        assert len(hrefs) > 100
        assert got == hrefs

    def test_names_come_in_the_readers_language_and_english_still_finds_them(self):
        by = {g["p"]: g for g in gamelinks.search_index("de")}
        assert by["solitaire.html"]["n"] == "Solitär"
        assert "solitaire" in by["solitaire.html"]["h"].lower() and "solitär" in by["solitaire.html"]["h"].lower()
        assert by["puzzles/net.html"]["n"]  # a puzzle is named too
        # a language the games lack falls back to English, a malformed one to English
        assert {g["n"] for g in gamelinks.search_index("xx")} == {g["n"] for g in gamelinks.search_index("en")}
        assert gamelinks.search_index("../../etc")

    def test_kinds_and_families_are_words_a_game_is_found_by(self):
        by = {g["p"]: g for g in gamelinks.search_index("en")}
        assert "logic puzzles" in by["puzzles/net.html"]["h"].lower()
        assert "puzzles" in by["puzzles/net.html"]["h"].lower()
        assert "cards" in by["solitaire.html"]["h"].lower()

    def test_the_library_drawer_is_not_a_word(self):
        assert not any("library" in g["h"].lower() for g in gamelinks.search_index("en"))

    def test_nothing_without_the_games_zim(self):
        with mock.patch.object(_srv, "_zim_list_cache", []):
            assert gamelinks.search_index("en") == []
        with mock.patch.object(_srv, "zim_allowed", lambda name: False):
            assert gamelinks.search_index("en") == []

    def test_an_installed_package_without_the_source_still_finds_games(self):
        # the wheel, the image and the desktop apps ship games.json and the tile pictures, not the shelf page or its words
        import tempfile
        with tempfile.TemporaryDirectory() as empty, mock.patch.object(gamelinks.ownzims, "SOURCE_ROOT", empty), \
                mock.patch.object(gamelinks, "_shelf", None), mock.patch.object(gamelinks, "_shelf_text", {}):
            by = {g["p"]: g for g in gamelinks.search_index("de")}
        assert len(by) > 100 and by["solitaire.html"]["n"] == "Solitär"


if __name__ == "__main__":
    unittest.main()
