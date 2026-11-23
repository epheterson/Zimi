"""Articles <-> the Almanac's 3D view (zimi/gamelinks.py almanac_3d_links, almanac_view; GET /almanac-view).

- The closed set comes from the view's own data files: every body, craft, mission and landmark with a Wikidata Q-ID has an
  address that opens the view on it, a mission's replay winning over its craft's row.
- An article whose Q-ID is in the set gets its address; one that is not, or a request without the Almanac in the
  library, or a ZIM it may not see, gets none.
- Every landmark the view names has its Q-ID, but for the few the gazetteer gives none.
"""

import json
import os
import sys
import unittest
from unittest import mock
from urllib.parse import parse_qs

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi  # noqa: F401,E402
from zimi import gamelinks  # noqa: E402
from zimi import server as _srv  # noqa: E402
from tests.test_almanac_links import _QidFixtureMixin, _make_qid_index  # noqa: E402

EARTH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static", "earth")
APOLLO_11, ISS, MARS, AFRICA = "Q43653", "Q25271", "Q111", "Q15"


class ClosedSetTests(unittest.TestCase):
    def test_every_kind_the_view_shows_has_an_address(self):
        links = gamelinks.almanac_3d_links()
        assert parse_qs(links[APOLLO_11]) == {"v": ["moon"], "m": ["mission"], "k": ["apollo11,-3,0,1"]}, links[APOLLO_11]
        assert parse_qs(links[ISS]) == {"v": ["iss"], "x": ["sent:iss"]}
        assert links[MARS] == "v=mars"
        assert parse_qs(links[AFRICA]) == {"v": ["earth"], "x": ["lm:earth:Africa"]}
        # Every craft and body the view draws, and nearly every landmark.
        sent = json.load(open(os.path.join(EARTH, "sent-v1.json"), encoding="utf-8"))["objects"]
        assert all(o["qid"] in links for o in sent)
        assert sum(1 for v in links.values() if "x=lm:" in v) > 4000

    def test_landmarks_carry_their_qids(self):
        for name, floor in (("landmarks-v1.json", 0.98), ("landmarks-earth-v1.json", 0.8)):
            d = json.load(open(os.path.join(EARTH, name), encoding="utf-8"))
            qi = d["fields"].index("qid")
            rows = [r for b, rs in d.items() if isinstance(rs, list) and b not in ("fields", "sources") for r in rs]
            have = sum(1 for r in rows if r[qi])
            assert have / len(rows) >= floor, (name, have, len(rows))


class ArticleTests(_QidFixtureMixin, unittest.TestCase):
    def setUp(self):
        self._setup_qids()
        _make_qid_index(self.tmp, "wikipedia_en_test", {"A/Apollo_11": int(APOLLO_11[1:]), "A/Chess": 718})
        _srv._zim_list_cache = [{"name": "wikipedia_en_test", "language": "en"}, {"name": "zimi_almanac", "language": "en"}]
        self._on = mock.patch.object(gamelinks.ownzims, "enabled", lambda: True)
        self._on.start()

    def tearDown(self):
        self._on.stop()
        self._teardown_qids()

    def test_an_article_on_something_the_view_shows_gets_its_address(self):
        assert "m=mission" in gamelinks.almanac_view("wikipedia_en_test", "A/Apollo_11")
        assert gamelinks.almanac_view("wikipedia_en_test", "A/Chess") is None

    def test_nothing_without_the_almanac_or_for_a_zim_out_of_reach(self):
        with mock.patch.object(_srv, "zim_allowed", lambda name: name != "wikipedia_en_test"):
            assert gamelinks.almanac_view("wikipedia_en_test", "A/Apollo_11") is None
        _srv._zim_list_cache = [{"name": "wikipedia_en_test", "language": "en"}]
        assert gamelinks.almanac_view("wikipedia_en_test", "A/Apollo_11") is None


if __name__ == "__main__":
    unittest.main()
