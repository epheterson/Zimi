"""Discover in every language: the day's cards read each wiki in its own words.

The fixtures in tests/fixtures/discover_i18n are the wikis' own pages, cut
short: Wikipedia's page for 25 September in each of the ten languages the
interface speaks, Wiktionary entries from each edition, and Wikiquote pages
as Kiwix ships them. Every test here failed before Discover learned the
languages: On this day only knew "September_25" and "Events", Word of the
day only knew <h2 id="English">, and Quote of the day only knew the English
Wikiquote's nested lists.

Run: pytest tests/test_discover_languages.py -v
"""

import os
import random
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from zimi import search, wikilang  # noqa: E402

FIX = os.path.join(HERE, "fixtures", "discover_i18n")
LANGS = ("en", "de", "fr", "es", "pt", "ru", "zh", "ar", "he", "hi")


def _fixture(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return f.read()


# ── On this day ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "lang,expected",
    [
        ("en", ["September_25"]),
        ("de", ["25._September"]),
        ("fr", ["25_septembre"]),
        ("es", ["25_de_septiembre"]),
        ("pt", ["25_de_setembro"]),
        ("ru", ["25_сентября"]),
        ("zh", ["9月25日"]),
        ("ar", ["25_سبتمبر"]),
        ("he", ["25_בספטמבר"]),
        # Hindi files the page as "२५ सितम्बर"; "25 सितंबर" redirects to it.
        ("hi", ["25_सितंबर", "25_सितम्बर", "२५_सितंबर", "२५_सितम्बर"]),
    ],
)
def test_a_day_page_is_named_in_the_wikis_own_words(lang, expected):
    assert wikilang.date_page_titles(lang, 9, 25) == expected


def test_the_first_of_the_month_and_unknown_languages():
    assert wikilang.date_page_titles("fr", 1, 1) == ["1er_janvier"]
    assert wikilang.date_page_titles("de", 3, 1) == ["1._März"]
    assert wikilang.date_page_titles("zh", 12, 31) == ["12月31日"]
    assert wikilang.date_page_titles("it", 9, 25) == []
    assert wikilang.date_page_titles("en", 13, 1) == []


# The first dated line of each page whose article the line names, as the
# card shows it: the year without its leading zero or 年, and the sentence
# with its links flattened and no space pushed into a Hebrew prefix letter
# or between Chinese words.
FIRST_EVENT = {
    "en": ("275", "Marcus_Claudius_Tacitus", "For the last time, the Roman Senate"),
    "de": ("275", "Tacitus_(Kaiser)", "Marcus Claudius Tacitus wird durch den Senat"),
    "fr": ("70", "Première_guerre_judéo-romaine", "destruction de Jérusalem"),
    "es": ("275", "Claudio_Tácito", "en Roma, tras el asesinato"),
    "pt": ("233", "Alexandre_Severo", "Alexandre Severo é derrotado"),
    "ru": ("1066", "Битва_при_Стамфорд-Бридже", "битва при Стамфорд-Бридже"),
    "zh": ("275", "羅馬元老院", "在奧勒良遭到軍官暗殺身亡後，羅馬元老院推舉"),
    "ar": ("275", "ماركوس_كلاوديوس_تاسيتس", "للمرة الأخيرة، مجلس الشيوخ"),
    "he": ("275", "טקיטוס_(קיסר_רומי)", "קלאודיוס טקיטוס מתמנה לקיסר"),
    "hi": ("2011", "करबला", "इराक के शिया मुसलमानों"),
}


@pytest.mark.parametrize("lang", LANGS)
def test_on_this_day_reads_each_wikipedias_date_page(lang):
    events = search._extract_otd_events(_fixture(f"otd_{lang}.html"))
    assert len(events) >= 5, lang
    year, link, text = FIRST_EVENT[lang]
    assert (events[0]["year"], events[0]["link"]) == (year, link)
    assert events[0]["text"].startswith(text), events[0]["text"]


def test_russian_holidays_before_the_events_are_not_events():
    # ru.wikipedia puts "Праздники и памятные дни" above "События".
    events = search._extract_otd_events(_fixture("otd_ru.html"))
    assert all(e["year"].isdigit() and int(e["year"]) >= 1000 for e in events)


def test_links_that_leave_the_wiki_are_not_picked():
    # he.wikipedia follows a name with "(אנג')", a link to the English
    # article. It is not in the ZIM, so it must not be the line's pick.
    for ev in search._extract_otd_events(_fixture("otd_he.html")):
        assert not ev["link"].isascii(), ev


# ── On this day, through a real ZIM ───────────────────────────────────────


def _html_zim(path, language, name, pages):
    """A ZIM of HTML pages: ``pages`` is {path: (title, html)}."""
    from conftest_zim import _Article
    from libzim.writer import Creator

    with Creator(path).config_indexing(False, "eng") as creator:
        creator.set_mainpath(next(iter(pages)))
        for p, (title, body) in pages.items():
            creator.add_item(_Article(p, title, body.encode("utf-8")))
        for key, value in (
            ("Title", name),
            ("Name", name),
            ("Language", language),
            ("Description", "fixture"),
        ):
            creator.add_metadata(key, value)
    return path


OTD_ZIMS = {
    # lang: (ISO 639-3 as Kiwix writes it, the page's path, the article)
    "de": ("deu", "25._September", "Tacitus_(Kaiser)"),
    "zh": ("zho", "9月25日", "羅馬元老院"),
    "he": ("heb", "25_בספטמבר", "טקיטוס_(קיסר_רומי)"),
    "hi": ("hin", "२५_सितम्बर", "करबला"),
}


@pytest.mark.parametrize("lang", sorted(OTD_ZIMS))
def test_the_dated_pick_comes_from_the_wikis_own_date_page(tmp_path, lang):
    from libzim.reader import Archive

    iso3, page, article = OTD_ZIMS[lang]
    name = f"wikipedia_{lang}_all"
    path = _html_zim(
        str(tmp_path / f"{name}_nopic_2026-07.zim"),
        iso3,
        name,
        {
            page: (page.replace("_", " "), _fixture(f"otd_{lang}.html")),
            article: (article.replace("_", " "), "<p>article</p>"),
        },
    )
    archive = Archive(path)
    got = search._get_dated_entry(archive, name, "0925", rng=random.Random(1))
    assert got and got["path"] == article, got
    assert got["event_year"] == FIRST_EVENT[lang][0]
    listed = search.otd_events(archive, "0925")
    assert [e["path"] for e in listed] == [article]
