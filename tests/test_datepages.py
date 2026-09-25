"""Wikipedia's date pages in every language: what each calls its page for a
day, and the day's events read from it.

tests/fixtures/datepages.json holds each language's real September 25 page
(the Parsoid HTML mwoffliner builds its ZIMs from, fetched 2026-09-25) cut
to its events heading, its first event lines and the heading after them.

Run: pytest tests/test_datepages.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)

from zimi import datepages  # noqa: E402

with open(
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "fixtures", "datepages.json"
    ),
    encoding="utf-8",
) as _f:
    PAGES = json.load(_f)


@pytest.mark.parametrize(
    "lang,mmdd,title",
    [
        ("en", "0925", "September_25"),
        ("simple", "0925", "September_25"),
        ("de", "0925", "25._September"),
        ("fr", "0925", "25_septembre"),
        ("fr", "0101", "1er_janvier"),
        ("es", "0925", "25_de_septiembre"),
        ("pt", "0925", "25_de_setembro"),
        ("it", "0501", "1º_maggio"),
        ("ru", "0925", "25_сентября"),
        ("uk", "0925", "25_вересня"),
        ("pl", "0925", "25_września"),
        ("zh", "0925", "9月25日"),
        ("ja", "0925", "9月25日"),
        ("ko", "0925", "9월_25일"),
        ("he", "0925", "25_בספטמבר"),
        ("ar", "0925", "25_سبتمبر"),
        ("fa", "0925", "۲۵_سپتامبر"),
        ("hi", "0925", "25_सितंबर"),
        ("hi", "0925", "२५_सितम्बर"),  # the page itself; the other is its redirect
        ("nl", "0925", "25_september"),
        ("tr", "0925", "25_Eylül"),
        ("vi", "0925", "25_tháng_9"),
    ],
)
def test_each_language_names_its_date_page_its_own_way(lang, mmdd, title):
    assert title in datepages.date_page_titles(lang, mmdd)


def test_a_language_zimi_does_not_know_falls_back_to_the_english_and_numeric_names():
    assert datepages.date_page_titles("xx", "0925") == ["September_25", "9月25日"]


@pytest.mark.parametrize(
    "bad", ["0015", "1301", "0000", "0230", "0431", "25-9", "", None, "09250"]
)
def test_only_a_real_day_is_a_date(bad):
    assert datepages.valid_mmdd(bad) is None
    assert datepages.date_page_titles("en", bad) == []


def test_february_29_is_a_day():
    assert datepages.valid_mmdd("0229") == (2, 29)


EXPECTED = {
    "en": [("275", "Marcus_Claudius_Tacitus"), ("762", "Muhammad_al-Nafs_al-Zakiyya")],
    "de": [("275", "Tacitus_(Kaiser)"), ("1066", "Schlacht_von_Stamford_Bridge")],
    "fr": [("70", "Première_guerre_judéo-romaine"), ("275", "Marcus_Claudius_Tacite")],
    "es": [("275", "Claudio_Tácito"), ("1066", "Era_vikinga")],
    "pt": [("233", "Alexandre_Severo"), ("275", "Tácito_(imperador)")],
    "ru": [("1066", "Битва_при_Стамфорд-Бридже"), ("1303", "Землетрясение_в_Хундуне")],
    "zh": [("275", "羅馬元老院"), ("1066", "哈罗德二世")],
    "ja": [
        ("275", "マルクス・クラウディウス・タキトゥス"),
        ("762", "アッバース朝"),
    ],
    "ko": [("1066", "스탬퍼드브리지_전투"), ("1396", "니코폴리스_전투")],
    "he": [("275", "טקיטוס_(קיסר_רומי)"), ("762", "מוחמד_א-נפס_א-זכיה")],
    "ar": [("275", "ماركوس_كلاوديوس_تاسيتس"), ("1066", "معركة_جسر_ستامفورد")],
    "hi": [("2011", "करबला"), ("2011", "नेपाल")],
    "it": [("235", "Papa_Ponziano"), ("275", "Marco_Claudio_Tacito")],
}


@pytest.mark.parametrize("lang", sorted(EXPECTED))
def test_the_events_of_a_real_date_page_in_each_language(lang):
    """Only the events section (the births after it are not events), each
    line's year as a card shows it (275, not 0275 or 275年), and the most specific article the
    line names (never the year's own page)."""
    events = datepages.extract_events(PAGES[lang], lang)
    assert [(e["year"], e["link"]) for e in events][:2] == EXPECTED[lang]
    assert all(e["text"] and not e["text"][0].isdigit() for e in events)


def test_hidden_sort_keys_are_not_part_of_the_year():
    # German and Portuguese write 0275 with the 0 hidden.
    assert ">0</span>" in PAGES["de"]
    assert datepages.extract_events(PAGES["de"], "de")[0]["year"] == "275"


def test_a_year_over_several_events_is_each_event_s_year():
    # Hindi writes "2011-" once with the events of that year in a list under it.
    assert [e["year"] for e in datepages.extract_events(PAGES["hi"], "hi")] == [
        "2011",
        "2011",
    ]


def test_words_joined_to_a_link_stay_joined():
    """Hebrew glues a prefix to the word a link starts; Chinese has no spaces
    at all. A tag is not a space."""
    he = datepages.extract_events(PAGES["he"], "he")[0]["text"]
    assert "לקיסר" in he
    zh = datepages.extract_events(PAGES["zh"], "zh")[0]["text"]
    assert " " not in zh


def test_percent_encoded_links_are_article_paths():
    """mwoffliner writes every link that is not ASCII percent-encoded."""
    page = (
        '<h2 id="x">प्रमुख घटनाएँ</h2><ul><li><a href="%E0%A5%A8%E0%A5%A6%E0%A5%A7%E0%A5%A7">2011</a> - '
        '<a href="%E0%A4%A8%E0%A5%87%E0%A4%AA%E0%A4%BE%E0%A4%B2">नेपाल</a> में</li></ul>'
    )
    assert datepages.extract_events(page, "hi")[0]["link"] == "नेपाल"


def test_a_link_to_another_language_s_wikipedia_is_not_this_one_s_article():
    page = (
        '<h2>Events</h2><ul><li><a href="./1237">1237</a> – The '
        '<a href="https://de.wikipedia.org/wiki/Vertrag_von_York">Treaty of York in German</a> '
        '<a href="./York">York</a></li></ul>'
    )
    assert datepages.extract_events(page, "en")[0]["link"] == "York"


def test_a_red_link_is_not_the_line_s_article():
    """zh.wikipedia names 克勞狄·塔西佗 in a red link (``class="new"``, an
    article not yet written): it is not in the ZIM, so the line's pick is the
    next most specific article."""
    page = (
        '<h2>大事记</h2><ul><li><a href="./275年">275年</a>：'
        '<a href="./克勞狄·塔西佗?action=edit&amp;redlink=1" class="new">克勞狄·塔西佗</a>'
        '繼任，<a href="./羅馬元老院">羅馬元老院</a>推舉</li></ul>'
    )
    assert datepages.extract_events(page, "zh")[0]["link"] == "羅馬元老院"


def test_native_digits_read_as_years():
    page = '<h2>رویدادها</h2><ul><li><a href="./۱۸۹۷">۱۸۹۷</a> – <a href="./ویلیام_فاکنر">ویلیام فاکنر</a> زاده شد</li></ul>'
    assert datepages.extract_events(page, "fa") == [
        {"year": "1897", "text": "ویلیام فاکنر زاده شد", "link": "ویلیام_فاکنر"}
    ]


def test_an_unknown_language_finds_its_events_by_any_known_heading_or_by_shape():
    page = PAGES["de"].replace("Ereignisse", "Something")
    assert datepages.extract_events(page, "xx")  # dated lines, found by their shape
    assert datepages.extract_events(PAGES["ru"], "xx")  # "События", known from Russian


def test_a_page_with_only_its_lead_has_no_events():
    # A mini build keeps only the lead.
    assert (
        datepages.extract_events(
            "<p>25 September is the 268th day of the year.</p>", "en"
        )
        == []
    )
