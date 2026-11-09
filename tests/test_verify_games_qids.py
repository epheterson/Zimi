"""The games' Q-ID audit: its judging is offline, and the 2026-11 findings stay fixed."""

import os
import sys
import unittest

sys.path.insert(
    0,
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
    ),
)
import verify_games_qids as audit  # noqa: E402


def _res(q=None, missing=False, disambig=False):
    return {"q": q, "title": "x", "disambig": disambig, "missing": missing}


class AuditTests(unittest.TestCase):
    def test_flags_missing_disambiguation_and_wrong_item(self):
        found = [
            ("Q1", "A", "a.html"),
            ("Q2", "B", "b.html"),
            ("Q3", "C", "c.html"),
            ("Q4", "D", "d.html"),
        ]
        res = {
            "A": _res("Q1"),
            "B": _res(missing=True),
            "C": _res("Q3", disambig=True),
            "D": _res("Q9"),
        }
        bad = audit.audit(found, res)
        assert [(b[0], b[3]) for b in bad] == [
            ("Q2", "missing"),
            ("Q3", "disambiguation page"),
            ("Q4", "is Q9"),
        ]

    def test_a_redirect_the_item_itself_is_filed_under_still_fits(self):
        found = [("Q5", "Old name", "e.html"), ("Q6", "Other", "f.html")]
        res = {"Old name": _res("Q50"), "Other": _res("Q60")}
        bad = audit.audit(
            found, res, lambda qids: {"Q5": "Old name", "Q6": "Not Other"}
        )
        assert [b[0] for b in bad] == ["Q6"]


class ShelfTests(unittest.TestCase):
    def test_games_that_had_no_article_do_not_claim_one(self):
        rows = {r[2]: r for r in audit.entries()}
        assert "puzzles/net.html" not in rows  # NetWalk has no English article
        assert (
            rows["tripeaks.html"][1] == "Tri Peaks (game)"
        )  # "Tri Peaks" is a disambiguation page
        assert (
            rows["blast.html"][0] == "Q3444160"
        )  # the series; the 1990 item's page differs from the 1983 game


if __name__ == "__main__":
    unittest.main()
