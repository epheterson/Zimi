"""ZimiGames <-> encyclopedia links (zimi/gamelinks.py, builtin/games/games.json).

- games.json: every page exists, every Q-ID is well formed and listed once,
  every game page carries its About link (scripts/games_links.py wrote it).
- build(): the background answer, over real Q-ID index tables: every
  language's article, a ZIM with no index and no title match left out, and
  the exact-title probe for an English ZIM with no index.
- links(): the shape GET /games-links serves, minus ZIMs the request may not
  see, and nothing at all without the games ZIM.
- a learned Q-ID that is no game's does not rework anything.
"""

import os
import re
import shutil
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(
    0,
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
    ),
)

import zimi  # noqa: F401,E402
from zimi import gamelinks  # noqa: E402
from zimi import server as _srv  # noqa: E402
from tests.test_almanac_links import _QidFixtureMixin, _make_qid_index  # noqa: E402
import games_links  # noqa: E402

CHESS, GO = 718, 11413


class GamesJsonTests(unittest.TestCase):
    def test_every_path_exists_and_every_qid_is_well_formed(self):
        rows = games_links.load()
        assert len(rows) > 40
        for r in rows:
            assert re.fullmatch(r"Q\d+", r.get("qid", "Q0")), r   # a puzzle with no encyclopedia article has no Q-ID, and no wiki title
            assert os.path.isfile(os.path.join(games_links.GAMES, r["path"])), r
            assert r["title"] and r["blurb"] and (r["wiki"] if r.get("qid") else True), r
        qids = [r["qid"] for r in rows if r.get("qid")]
        assert len(qids) == len(set(qids)), "one game per Q-ID"

    def test_every_game_page_carries_its_about_link(self):
        for path, row in games_links.primary_by_path(games_links.load()).items():
            with open(os.path.join(games_links.GAMES, path), encoding="utf-8") as f:
                assert games_links.footer(row) in f.read(), (
                    path + ": run scripts/games_links.py"
                )

    def test_about_page_knows_every_game(self):
        with open(os.path.join(games_links.GAMES, "about.html"), encoding="utf-8") as f:
            page = f.read()
        for r in games_links.load():
            assert '"%s":{' % games_links.about_key(r) in page, r["path"]


class GamesLinksTests(_QidFixtureMixin, unittest.TestCase):
    def setUp(self):
        self._setup_qids()
        _make_qid_index(self.tmp, "wikipedia_en_test", {"A/Chess": CHESS})
        _make_qid_index(self.tmp, "wikipedia_fr_test", {"A/Echecs": CHESS, "A/Go": GO})
        _srv._zim_list_cache = [
            {"name": "wikipedia_en_test", "language": "en"},
            {"name": "wikipedia_fr_test", "language": "fr"},
            {"name": "wikipedia_de_noindex", "language": "de"},
            {"name": "devdocs_en_python", "language": "en"},
            {"name": "zimi_games", "language": "en"},
        ]
        self._memo = dict(gamelinks._memo)
        # The English index lacks Go: the exact-title probe finds it.
        self._probe = mock.patch.object(
            gamelinks,
            "_almanac_title_entry_path",
            lambda zim, title: (
                "A/Go_(game)"
                if (zim, title) == ("wikipedia_en_test", "Go (game)")
                else None
            ),
        )
        self._probe.start()
        # The suite turns Zimi's own ZIMs off; this one is about them. A listing
        # the memo has not seen makes links() work the answer out.
        self._on = mock.patch.object(gamelinks.ownzims, "enabled", lambda: True)
        self._on.start()
        self._seen = mock.patch.object(_srv, "_listing_seen", frozenset({"changed"}))
        self._seen.start()

    def tearDown(self):
        self._seen.stop()
        self._on.stop()
        self._probe.stop()
        gamelinks._memo.update(self._memo)
        self._teardown_qids()

    def test_build_finds_each_languages_article_and_skips_the_rest(self):
        found = gamelinks.build()
        assert {(a["zim"], a["lang"], a["path"]) for a in found["Q718"]} == {
            ("wikipedia_en_test", "en", "A/Chess"),
            ("wikipedia_fr_test", "fr", "A/Echecs"),
        }
        assert {(a["zim"], a["path"]) for a in found["Q11413"]} == {
            ("wikipedia_fr_test", "A/Go"),
            ("wikipedia_en_test", "A/Go_(game)"),
        }
        assert all(a["zim"].startswith("wikipedia_") for v in found.values() for a in v)
        assert not any(
            a["zim"] == "wikipedia_de_noindex" for v in found.values() for a in v
        ), "no index and not English: no article rather than a guess"

    def test_links_shape_and_visibility(self):
        gamelinks._refresh()  # the background's work, done here so the answer is there
        with mock.patch.object(
            _srv, "zim_allowed", lambda name: name != "wikipedia_fr_test"
        ):
            data = gamelinks.links()
        assert data["games"]["Q718"] == {
            "zim": "zimi_games",
            "path": "chess.html",
            "title": "Chess",
        }
        assert [a["zim"] for a in data["articles"]["Q718"]] == ["wikipedia_en_test"]
        assert all(set(g) == {"zim", "path", "title"} for g in data["games"].values())

    def _settle(self):
        for _ in range(200):
            if not gamelinks._building.locked():
                return
            time.sleep(0.02)
        raise AssertionError("the background build did not finish")

    def test_a_request_never_builds_it_serves_the_last_good_answer(self):
        old = {"Q718": [{"zim": "wikipedia_en_test", "lang": "en", "path": "A/Old"}]}
        gamelinks._memo.update(token=frozenset({"older"}), articles=old)
        started, release, threads = threading.Event(), threading.Event(), []

        def slow_build():
            threads.append(threading.current_thread())
            started.set()
            release.wait(5)
            return {}

        with mock.patch.object(gamelinks, "build", slow_build):
            t0 = time.monotonic()
            data = gamelinks.links()
            assert time.monotonic() - t0 < 1, "the request did not wait for the build"
            assert [a["path"] for a in data["articles"]["Q718"]] == ["A/Old"]
            assert started.wait(5) and threads[0] is not threading.current_thread()
            release.set()
            self._settle()
        assert gamelinks.links()["articles"] == {}, "the new answer once it is built"

    def test_a_failing_build_is_not_rerun_by_every_request(self):
        gamelinks._memo.update(token=frozenset({"older"}), articles={})
        calls = []

        def broken():
            calls.append(1)
            raise RuntimeError("corrupt index")

        saved = gamelinks._failed_at
        try:
            with mock.patch.object(gamelinks, "build", broken):
                gamelinks.links()
                self._settle()
                for _ in range(20):
                    gamelinks.links()
                time.sleep(0.2)
                self._settle()
                assert len(calls) == 1, "backed off after the failure"
                gamelinks._failed_at = time.monotonic() - gamelinks._RETRY_AFTER_FAILURE_S - 1
                gamelinks.links()
                self._settle()
                assert len(calls) == 2, "tried again once the back-off has passed"
        finally:
            gamelinks._failed_at = saved

    def test_no_games_zim_means_no_links(self):
        _srv._zim_list_cache = _srv._zim_list_cache[:-1]
        assert gamelinks.links() == {"games": {}, "almanac": {}, "articles": {}}

    def test_a_learned_qid_that_is_no_games_changes_nothing(self):
        with mock.patch.object(gamelinks, "_refresh") as refresh:
            gamelinks.qids_changed(42)
            refresh.assert_not_called()
            gamelinks.qids_changed(CHESS)
            gamelinks.qids_changed()
            assert refresh.call_count == 2


_NODE_TEST = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "test_games_recent.cjs"
)
_DAYS = ["2026-10-24", "2026-10-25", "2026-12-31", "2027-01-01", "2028-02-29"]


class GameOfTheDayTests(unittest.TestCase):
    def setUp(self):
        # The cards are offered while the games ZIM is in the library (gone, they are not).
        patch = mock.patch.object(_srv, "_zim_list_cache", [{"name": "zimi_games"}])
        patch.start()
        self.addCleanup(patch.stop)

    def test_no_card_without_the_games_zim(self):
        with mock.patch.object(gamelinks.ownzims, "enabled", lambda: True), mock.patch.object(_srv, "_zim_list_cache", []):
            assert gamelinks.day_card("2026-10-24") is None
            assert gamelinks.random_card() is None

    def test_every_game_says_why_in_one_line(self):
        for r in games_links.load():
            assert r.get("why") and "\n" not in r["why"], r["path"]
            assert "—" not in r["why"], "no em dashes in user-facing text"

    def test_every_game_page_notes_itself_as_played(self):
        import games_recent

        pages = games_recent.pages()
        assert len(pages) > 70
        for path in pages:
            with open(os.path.join(games_recent.GAMES, path), encoding="utf-8") as f:
                assert games_recent.tag(path) in f.read(), (
                    path + ": run scripts/games_recent.py"
                )
        for r in games_links.load():
            assert r["path"] in pages, r["path"]

    def test_fixed_day_gives_a_fixed_game(self):
        # The same four rows and the same answers as test_games_recent.cjs.
        rows = [
            {"path": "one.html"},
            {"path": "one.html"},
            {"path": "two.html"},
            {"path": "three.html"},
        ]
        assert gamelinks.game_of_day("2026-10-24", rows)["path"] == "two.html"
        assert gamelinks.game_of_day("20261024", rows)["path"] == "two.html"
        assert gamelinks.game_of_day("2026-10-25", rows)["path"] == "one.html"
        assert gamelinks.game_of_day("soon", rows) is None
        assert gamelinks.game_of_day("2026-10-24", []) is None
        # FNV-1a's published vectors: recent.js is held to the same ones.
        assert gamelinks._fnv1a("") == 0x811C9DC5
        assert gamelinks._fnv1a("a") == 0xE40C292C
        assert gamelinks._fnv1a("foobar") == 0xBF9CF968

    def test_shelf_and_discover_agree(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        out = subprocess.run(
            [node, _NODE_TEST, "--days"] + _DAYS,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        shelf = dict(line.split() for line in out.splitlines())
        assert set(shelf) == set(_DAYS)
        for day in _DAYS:
            assert gamelinks.game_of_day(day)["path"] == shelf[day], day

    def test_discover_card_is_the_days_game(self):
        with mock.patch.object(gamelinks.ownzims, "enabled", lambda: True):
            card = gamelinks.day_card("20261024")
        game = gamelinks.game_of_day("2026-10-24")
        assert card == {
            "zim": "zimi_games",
            "path": game["path"],
            "title": game["title"],
            "blurb": game["why"],
            "thumbnail": gamelinks.thumbnail(game["path"]),
        }
        assert card["thumbnail"], "the day's game has a picture inside the ZIM"
        assert gamelinks.thumbnail("chess.html") == "/w/zimi_games/thumbs/chess.svg"
        assert gamelinks.thumbnail("puzzles/fifteen.html") == "/w/zimi_games/thumbs/puzzles/fifteen.svg"
        assert gamelinks.thumbnail("puzzles/mines.html") == "/w/zimi_games/puzzles/icons/mines.png"
        assert gamelinks.thumbnail("nothing.html") is None
        with mock.patch.object(gamelinks.ownzims, "enabled", lambda: True):
            assert gamelinks.day_card("not a day") is None
            with mock.patch.object(_srv, "zim_allowed", lambda name: False):
                assert gamelinks.day_card("20261024") is None
        assert gamelinks.day_card("20261024") is None, "Zimi's own ZIMs are off"

    def test_every_days_card_says_the_shelf_title_not_wikipedias(self):
        shelf = {}
        for r in gamelinks.rows():
            shelf.setdefault(r["path"], r)
        with mock.patch.object(gamelinks.ownzims, "enabled", lambda: True):
            for n in range(366):
                day = "%04d%02d%02d" % (2026 + (n + 300) // 366, 1 + ((n + 300) % 366) // 31 % 12, 1 + n % 28)
                card = gamelinks.day_card(day)
                assert card["title"] == shelf[card["path"]]["title"], (day, card)
        # "Checkers" is the shelf's name for what Wikipedia calls "English draughts"
        assert shelf["checkers.html"]["title"] == "Checkers" != shelf["checkers.html"]["wiki"]

    def test_random_is_always_a_game_of_the_shelf(self):
        shelf = {r["path"]: r["title"] for r in gamelinks.rows()}
        with mock.patch.object(gamelinks.ownzims, "enabled", lambda: True):
            picks = [gamelinks.random_card() for _ in range(300)]
            assert {c["path"] for c in picks} <= set(shelf), "never about.html, a stylesheet or a script"
            assert all(c["title"] == shelf[c["path"]] for c in picks), "the shelf's title, not the wiki's"
            assert len({c["path"] for c in picks}) > 20, "a roll, not one game"
            # the dice move on from the game being played
            assert all(gamelinks.random_card(exclude="chess.html")["path"] != "chess.html" for _ in range(100))
            with mock.patch.object(_srv, "zim_allowed", lambda name: False):
                assert gamelinks.random_card() is None
        assert gamelinks.random_card() is None, "Zimi's own ZIMs are off"


if __name__ == "__main__":
    unittest.main()
