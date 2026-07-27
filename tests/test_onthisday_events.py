#!/usr/bin/env python3
"""On-this-day date relevance: honest event-line picks for the discover card.

Background: the Today / "On This Day" card used to load the Wikipedia
``Month_Day`` page and follow a *random* internal link. Those links are often
the generic background topic of an event (e.g. ``American_Revolution``), so a
card dated "today" opened an article that never mentions today's date — the
card felt broken.

The fix parses the page's EVENT LINES ("1777 – <a>Battle…</a> …") and picks the
article the event actually names, returning the event context (year + sentence)
so the card can show the date even when the target article doesn't restate it.

These tests cover the parser (`_extract_otd_events`, `_otd_norm_link`) and the
`_get_dated_entry` Wikipedia strategy: specific-link choice, year-link skip,
citation cleanup, section boundary, large-section (no 100KB truncation),
404 link fall-through, and missing-page fallback.
"""

import os
import sys
import types
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.search as search  # noqa: E402

# ---------------------------------------------------------------------------
# Synthetic Month_Day fixture — shaped like real mwoffliner/Parsoid HTML:
# year link, en-dash, then the event sentence with one or more article links,
# plus a <sup> citation marker. Includes an event line with NO article link
# (only a year), a BC year, a Births section, and a Holidays section whose
# links must be excluded (they fall after the section boundary).
# ---------------------------------------------------------------------------
FIXTURE = """
<div class="mw-heading mw-heading2"><h2 id="Events">Events</h2></div>
<ul>
<li><a href="./1777" title="1777">1777</a> –
    <a href="./Battle_of_Foo" title="Battle of Foo">Battle of Foo</a>:
    American forces under <a href="./George_W" title="George W">George W</a>
    win a skirmish.<sup class="reference"><a href="#cite_note-1">[1]</a></sup></li>
<li><a href="./356_BC" title="356 BC">356 BC</a> –
    The <a href="./Temple_of_Artemis" title="Temple of Artemis">Temple of Artemis</a>,
    one of the Seven Wonders, is destroyed by arson.</li>
<li><a href="./1900" title="1900">1900</a> – A vague event with no article link.</li>
</ul>
<div class="mw-heading mw-heading2"><h2 id="Births">Births</h2></div>
<ul>
<li><a href="./1824" title="1824">1824</a> –
    <a href="./Alexandre_Dumas" title="Alexandre Dumas">Alexandre Dumas</a>,
    French author (died 1895).</li>
</ul>
<div class="mw-heading mw-heading2"><h2 id="Holidays_and_observances">Holidays and observances</h2></div>
<ul>
<li><a href="./Christmas" title="Christmas">Christmas</a> – not a dated event line.</li>
</ul>
<div class="mw-heading mw-heading2"><h2 id="References">References</h2></div>
"""


class TestNormLink(unittest.TestCase):
    def test_absolute_wiki_url(self):
        self.assertEqual(
            search._otd_norm_link(
                "https://en.wikipedia.org/wiki/Siward,_Earl_of_Northumbria"
            ),
            "Siward,_Earl_of_Northumbria",
        )

    def test_relative_dot(self):
        self.assertEqual(search._otd_norm_link("./1777"), "1777")

    def test_relative_dotdot_namespace(self):
        self.assertEqual(
            search._otd_norm_link("../A/Battle_of_Dunsinane"), "Battle_of_Dunsinane"
        )

    def test_strips_fragment_and_query(self):
        self.assertEqual(search._otd_norm_link("A/Foo#section?x=1"), "Foo")

    def test_bare_relative(self):
        self.assertEqual(
            search._otd_norm_link("Temple_of_Artemis"), "Temple_of_Artemis"
        )


class TestExtractEvents(unittest.TestCase):
    def setUp(self):
        self.events = search._extract_otd_events(FIXTURE)

    def test_parses_events_and_births_not_holidays(self):
        # 1777, 356 BC, 1824 — the no-link 1900 line and the Christmas holiday
        # line are both excluded.
        self.assertEqual(len(self.events), 3)

    def test_years_in_document_order(self):
        self.assertEqual([e["year"] for e in self.events], ["1777", "356 BC", "1824"])

    def test_picks_most_specific_link_not_year(self):
        # Longest anchor text on the line wins ("Battle of Foo" > "George W");
        # the leading year link ("1777") is never chosen.
        self.assertEqual(self.events[0]["link"], "Battle_of_Foo")
        self.assertNotIn("1777", [e["link"] for e in self.events])

    def test_year_link_skipped_line_without_article_dropped(self):
        # The 1900 line has only a year link → no target → not returned.
        self.assertNotIn("1900", [e["year"] for e in self.events])

    def test_citation_markers_stripped(self):
        self.assertNotIn("[1]", self.events[0]["text"])
        self.assertNotIn("[", self.events[0]["text"])

    def test_event_text_is_the_sentence_without_year(self):
        self.assertTrue(self.events[0]["text"].startswith("Battle of Foo"))
        self.assertNotIn("1777", self.events[0]["text"])

    def test_holidays_section_excluded(self):
        self.assertNotIn("Christmas", [e["link"] for e in self.events])

    def test_bc_year_preserved(self):
        self.assertEqual(self.events[1]["year"], "356 BC")
        self.assertEqual(self.events[1]["link"], "Temple_of_Artemis")


class TestLargeSectionNotTruncated(unittest.TestCase):
    """A late event past the old 100KB cap must still be found."""

    def test_event_beyond_100kb_is_parsed(self):
        pad = "<p>%s</p>\n" % ("filler " * 20)
        big = (
            '<div class="mw-heading mw-heading2"><h2 id="Events">Events</h2></div>\n'
            "<ul>\n"
            + pad * 1200  # ~150KB of padding inside the Events section
            + '<li><a href="./2020">2020</a> – '
            '<a href="./Late_Event">Late Event</a> occurs.</li>\n</ul>\n'
            '<div class="mw-heading mw-heading2"><h2 id="References">References</h2></div>'
        )
        self.assertGreater(len(big), 100000)
        events = search._extract_otd_events(big)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["link"], "Late_Event")


# ---------------------------------------------------------------------------
# _get_dated_entry integration — fake archive holding a Month_Day page and its
# target articles (mirrors the MagicMock style in tests/test_fragment_fallback).
# ---------------------------------------------------------------------------
def _fake_entry(
    title, html="<html><body>x</body></html>", mimetype="text/html", path=None
):
    entry = MagicMock()
    entry.is_redirect = False
    entry.title = title
    entry.path = path if path is not None else title
    item = entry.get_item.return_value
    item.content = html.encode("utf-8")
    item.mimetype = mimetype
    item.size = len(html)
    return entry


class _NoShuffle:
    """rng stand-in that leaves order intact so picks are deterministic."""

    @staticmethod
    def shuffle(seq):
        return None


class TestGetDatedEntry(unittest.TestCase):
    def _archive(self, page_html, articles, missing=()):
        """Build a fake archive: 'July_27' serves page_html, articles is a
        {path: entry} map, and any path in `missing` raises KeyError."""
        archive = MagicMock()

        def _lookup(path):
            if path in missing:
                raise KeyError(path)
            base = path[2:] if path.startswith("A/") else path
            if base in ("July_27",):
                return _fake_entry("July 27", page_html, path="A/July_27")
            if base in articles:
                return articles[base]
            raise KeyError(path)

        archive.get_entry_by_path.side_effect = _lookup
        return archive

    def test_returns_event_context(self):
        articles = {
            "Battle_of_Foo": _fake_entry("Battle of Foo", path="A/Battle_of_Foo"),
        }
        archive = self._archive(FIXTURE, articles)
        result = search._get_dated_entry(
            archive, "wikipedia_en_all", "0727", rng=_NoShuffle()
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["title"], "Battle of Foo")
        self.assertEqual(result["event_year"], "1777")
        self.assertTrue(result["event_text"].startswith("Battle of Foo"))
        self.assertEqual(result["path"], "A/Battle_of_Foo")

    def test_404_link_falls_through_to_next_event(self):
        # Battle_of_Foo 404s in this subset ZIM → next line's article is used.
        articles = {
            "Temple_of_Artemis": _fake_entry(
                "Temple of Artemis", path="A/Temple_of_Artemis"
            ),
        }
        archive = self._archive(
            FIXTURE,
            articles,
            missing=("A/Battle_of_Foo", "Battle_of_Foo", "A/George_W", "George_W"),
        )
        result = search._get_dated_entry(
            archive, "wikipedia_en_all", "0727", rng=_NoShuffle()
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["title"], "Temple of Artemis")
        self.assertEqual(result["event_year"], "356 BC")

    def test_missing_date_page_falls_back(self):
        # No Month_Day page and empty FTS → fail-soft None (no crash).
        archive = MagicMock()
        archive.get_entry_by_path.side_effect = KeyError("nope")

        fake_search = MagicMock()
        fake_search.getEstimatedMatches.return_value = 0
        fake_searcher = MagicMock()
        fake_searcher.search.return_value = fake_search
        orig_searcher, orig_query = search.Searcher, search.Query
        search.Searcher = lambda *a, **k: fake_searcher
        search.Query = MagicMock
        try:
            result = search._get_dated_entry(
                archive, "wikipedia_en_all", "0727", rng=_NoShuffle()
            )
        finally:
            search.Searcher, search.Query = orig_searcher, orig_query
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
