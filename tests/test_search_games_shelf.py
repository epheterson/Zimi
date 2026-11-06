"""The games ZIM answers a search with its games, not its files.

The 1.15.2 proof searched "chess": under the Games row the results listed
"README-chess-openings" (data/README-chess-openings.txt), the engine's
README, and "Chess - ZimiGames" with the snippet "Hint Flip" (its button
labels). Only the shelf's games are found, under their names, with their
blurbs as the snippet.
"""

import os
import sys
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import gamelinks  # noqa: E402
from zimi import search as _search  # noqa: E402
from zimi import server as _server  # noqa: E402

RAW = [
    {"path": "data/README-chess-openings.txt", "title": "README-chess-openings", "snippet": "Openings, from lichess"},
    {"path": "engines/fairy/README.txt", "title": "README", "snippet": "Fairy-Stockfish"},
    {"path": "chess.html", "title": "Chess - ZimiGames", "snippet": "Hint Flip"},
    {"path": "shell.css", "title": "shell.css", "snippet": ""},
]


class GamesInSearchTests(unittest.TestCase):
    def _search(self):
        with (
            mock.patch.object(_server, "get_zim_files", lambda: {"zimi_games": "/nowhere/zimi_games.zim"}),
            mock.patch.object(_server, "_zim_list_cache", [{"name": "zimi_games", "entries": 800, "language": "en"}]),
            mock.patch.object(_search, "_get_fts_archive", lambda name: (object(), threading.Lock())),
            mock.patch.object(_search, "search_zim", lambda *a, **k: [dict(r) for r in RAW]),
            mock.patch.object(_search, "_title_index_exact", lambda *a, **k: []),
            mock.patch.object(_search, "_search_places", lambda *a, **k: []),
        ):
            return _search.search_all("chess", limit=10)["results"]

    def test_only_the_shelfs_games_are_found(self):
        paths = [r["path"] for r in self._search()]
        self.assertEqual(paths, ["chess.html"])

    def test_a_game_is_named_and_described_as_the_shelf_does(self):
        chess = next(g for g in gamelinks.rows() if g["path"] == "chess.html")
        (hit,) = self._search()
        self.assertEqual(hit["title"], chess["title"])
        self.assertEqual(hit["snippet"], chess["blurb"])


if __name__ == "__main__":
    unittest.main()
