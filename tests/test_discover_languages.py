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


# ── Word of the day ───────────────────────────────────────────────────────

# fixture -> (part of speech, the definition starts with), from each
# edition's entry for a word of its own language.
WORDS = {
    "wikt_en_kettle.html": ("Noun", "(cooking) A vessel for boiling a liquid"),
    "wikt_de_Haus.html": (
        "Substantiv, n",
        "zu einem bestimmten Zweck erbautes Gebäude",
    ),
    "wikt_fr_maison.html": ("Nom commun", "(Construction) Bâtiment servant de logis"),
    "wikt_es_casa.html": ("Sustantivo femenino", "Edificación destinada a vivienda."),
    "wikt_pt_casa.html": ("Substantivo", "construção que serve de moradia"),
    "wikt_ru_dom.html": (
        "Существительное",
        "архитектурное сооружение, предназначенное",
    ),
    "wikt_zh_diannao.html": ("名詞", "原用於數字計算的電子計算機"),
    "wikt_ar_qahafa.html": ("فعل", "قحف المطرُ ـ قَحْفًا: اشتدّ فجأة"),
    "wikt_he_revava.html": ("שם־עצם", "עשרת אלפים; 10,000."),
    "wikt_hi_ghar.html": ("संज्ञा", "निवास या रहने का स्थान।"),
    # Hindi Wiktionary's transcriptions of a printed dictionary: headword,
    # grammar and etymology, then the numbered senses.
    "wikt_hi_chinghad.html": ("संज्ञा", "चीख मारने का शब्द । चिल्लाहट ।"),
}
# The headwords of the fixtures whose file names are transliterated, so the
# repository's paths stay ASCII.
HEADWORDS = {
    "dom": "дом",
    "diannao": "電腦",
    "qahafa": "قَحَفَ",
    "revava": "רבבה",
    "ghar": "घर",
    "chinghad": "चिंघाड़",
    "Haeuser": "Häuser",
}


def _word(fixture):
    from zimi.previews import _extract_preview_wiktionary

    _, lang, word = fixture[: -len(".html")].split("_", 2)
    word = HEADWORDS.get(word, word)
    result = {}
    _extract_preview_wiktionary(
        _fixture(fixture), f"wiktionary_{lang}_all", result, lang, word
    )
    return result


@pytest.mark.parametrize("fixture", sorted(WORDS))
def test_word_of_the_day_reads_the_editions_own_language_section(fixture):
    got = _word(fixture)
    pos, definition = WORDS[fixture]
    assert got.get("part_of_speech") == pos
    assert (got.get("blurb") or "").startswith(definition), got
    assert not got.get("other_language") and not got.get("boring")


@pytest.mark.parametrize(
    "fixture",
    [
        "wikt_de_house.html",  # "house (Englisch)"
        "wikt_es_house.html",  # "Inglés"
        "wikt_pt_house.html",  # "Inglês"
        "wikt_ru_house.html",  # "Английский"
        "wikt_zh_house.html",  # "英語"
        "wikt_ar_mashers.html",  # "إنجليزية"
    ],
)
def test_a_word_of_another_language_is_passed_over(fixture):
    assert _word(fixture).get("other_language") is True


@pytest.mark.parametrize(
    "fixture",
    [
        "wikt_en_houses.html",  # "plural of house"
        "wikt_de_Haeuser.html",  # "Deklinierte Form"
        "wikt_fr_maisons.html",  # "Forme de nom commun"
        "wikt_pt_casas.html",  # "Forma de substantivo"
    ],
)
def test_an_inflected_form_is_passed_over(fixture):
    assert _word(fixture).get("boring") is True


def test_a_french_word_on_french_wiktionary_is_french_even_when_english_too():
    # fr.wiktionary's "house" opens with a French section (house music);
    # that is the word of the day there, not the English noun below it.
    got = _word("wikt_fr_house.html")
    assert got.get("part_of_speech") == "Nom commun"
    assert "Genre musical" in got.get("blurb", "")


def test_the_card_passes_over_what_it_cannot_show():
    from zimi.http import _random_pick_verdict

    def verdict(preview):
        return _random_pick_verdict(
            {"path": "A/x"},
            dict({"thumbnail": None, "blurb": "a sense"}, **preview),
            is_gutenberg=False,
            is_wiktionary=True,
            is_wikiquote=False,
            require_thumb=True,
        )

    assert verdict({}) == "accept"
    assert verdict({"other_language": True}) == "fallback"
    assert verdict({"boring": True}) == "fallback"
    assert verdict({"blurb": None}) == "fallback"


def test_a_hebrew_wiktionary_zim_reads_as_hebrew(tmp_path):
    """Through the ZIM, as /random reads it: the language comes from the
    archive's own metadata, not from its file name."""
    from libzim.reader import Archive

    from zimi.previews import _extract_preview

    path = _html_zim(
        str(tmp_path / "renamed.zim"),
        "heb",
        "wiktionary_he_all",
        {
            "רבבה": ("רבבה", _fixture("wikt_he_revava.html")),
            "Geschäft": ("Geschäft", "<h2>Geschäft</h2><ol><li>עסק</li></ol>"),
        },
    )
    archive = Archive(path)
    got = _extract_preview(archive, "renamed-wiktionary", "רבבה")
    assert got["part_of_speech"] == "שם־עצם"
    assert got["blurb"].startswith("עשרת אלפים")
    # A German word on the Hebrew Wiktionary is not the Hebrew word of the day.
    assert _extract_preview(archive, "renamed-wiktionary", "Geschäft").get(
        "other_language"
    )


# ── Quote of the day ──────────────────────────────────────────────────────

# fixture -> (language, page title, the quote starts with, who said it).
# Each edition lays its quotes out its own way (see _wikiquote_candidates).
QUOTES = {
    # German: the quote in its own marks, then "– the work it is from".
    "quote_de_heidegger.html": (
        "de",
        "Martin Heidegger",
        "Der Mensch ist der Nachbar des Seins.",
        "Martin Heidegger",
    ),
    "quote_de_pruederie.html": ("de", "Prüderie", "Prüderie ist eine Art", "Stendhal"),
    # French: <div class="citation">, the source in a list after it.
    "quote_fr_cezanne.html": (
        "fr",
        "Paul Cézanne",
        "Toute ma vie, j'ai travaillé",
        "Paul Cézanne",
    ),
    # Spanish: «…» with the author in a list nested under it.
    "quote_es_fiesta.html": (
        "es",
        "Fiesta",
        "El primer mérito de un cuadro",
        "Eugène Delacroix",
    ),
    # Portuguese: the quote in a list, "- Fonte: Author." indented after it.
    "quote_pt_comic_sans.html": (
        "pt",
        "Comic Sans",
        "Se você ama a Comic Sans",
        "Vincent Connare",
    ),
    # Hebrew: a bare list of quotes on the person's own page.
    "quote_he_richter.html": ("he", "הדוויג ריכטר", "דמוקרטיה היא", "הדוויג ריכטר"),
    # Chinese: "quote。—— author 《work》".
    "quote_zh_hangzhou.html": ("zh", "杭州市", "江南忆，最忆是杭州。", "白居易"),
    # Arabic: a paragraph between «…».
    "quote_ar_einstein.html": (
        "ar",
        "ألبرت أينشتاين",
        "شيئان لا حدود لهما",
        "ألبرت أينشتاين",
    ),
    # Hindi: one quote per list, no marks.
    "quote_hi_gupt.html": ("hi", "मन्मथनाथ गुप्त", "प्रगतिशील होना", "मन्मथनाथ गुप्त"),
}


@pytest.mark.parametrize("fixture", sorted(QUOTES))
def test_quote_of_the_day_reads_each_wikiquotes_layout(fixture):
    from zimi.previews import _extract_preview_wikiquote

    lang, title, quote, author = QUOTES[fixture]
    got = {"title": None}
    _extract_preview_wikiquote(_fixture(fixture), got, title, lang)
    assert (got.get("blurb") or "").startswith("“" + quote), got
    assert got["blurb"].endswith("”")
    assert (got.get("attribution") or "").startswith(author), got


def test_a_quote_in_another_script_is_passed_over_for_one_in_the_wikis_own():
    from zimi.previews import _extract_preview_wikiquote

    page = (
        "<ul><li>It is hard to win an argument with a smart person, but it is "
        "damn near impossible to win an argument with a stupid person.</li></ul>"
        "<ul><li>想要吵贏一個聰明的人是很困難的，但是想要吵贏一個智障根本幾乎不可能。</li></ul>"
    )
    got = {"title": None}
    _extract_preview_wikiquote(page, got, "比爾·莫瑞", "zh")
    assert got["blurb"].startswith("“想要吵贏")
    assert got["attribution"] == "比爾·莫瑞"


def test_a_translation_label_and_a_disambiguation_notice_are_not_the_quote():
    from zimi.previews import _extract_preview_wikiquote

    # he.wikiquote gives a film's English line, then its translation.
    page = (
        '<ul><li>".You can\'t stop the time Charlie, Time is changing, People are '
        'changing"<ul><li>תרגום: "אתה לא יכול לעצור את הזמן צ\'רלי, הזמן משתנה, '
        'אנשים משתנים."</li></ul></li></ul>'
    )
    got = {"title": None}
    _extract_preview_wikiquote(page, got, "כבלים", "he")
    assert got["blurb"].startswith("“אתה לא יכול"), got
    # fr.wikiquote opens a disambiguation page with an italic notice.
    page = (
        "<dl><dd><div class=\"\"><i>Cette page d’homonymie répertorie les "
        "différents sujets et articles partageant un même nom.</i></div></dd></dl>"
    )
    got = {"title": None}
    _extract_preview_wikiquote(page, got, "Disque", "fr")
    assert not got.get("blurb")


def test_a_chinese_lead_sentence_is_a_blurb():
    from zimi.previews import _extract_preview_blurb

    assert _extract_preview_blurb("<p>鄞州区是浙江省宁波市的一个市辖区。</p>") == (
        "鄞州区是浙江省宁波市的一个市辖区。"
    )
