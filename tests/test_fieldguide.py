"""The Field Guide: situations over the open sources and the library.

Zimi writes no first-aid or survival instruction. What a situation shows is
quoted word for word from a source with its edition, place, licence and a
link, and these tests hold that to the letter: every quote is complete, its
licence is on the allowed list, its words are in the source it names (the
sources' text is kept in tests/fixtures/fieldguide), and nothing from a
source we may not quote is there. The keyword table finds a situation in ten
languages without hijacking a search for something else, the search answer
carries the hint, and a situation finds its pages in the installed ZIMs and
names, with sizes, the ZIMs that would add more.

Run: pytest tests/test_fieldguide.py -v
"""

import gzip
import json
import os
import re
import sys
import threading
import urllib.parse
import urllib.request

import pytest

pytestmark = pytest.mark.fieldguide_on

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fieldguide_fixture as fx  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import fieldguide as fg  # noqa: E402

FIXTURES = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fixtures", "fieldguide"
)
LANGS = ("en", "es", "fr", "de", "pt", "ru", "ar", "he", "hi", "zh")
# What a source's text layer gives and a quote does not: bullet glyphs, the
# whitespace of wrapped lines, hyphens (a word split at a line end).
_GLYPHS = ""


def _fixture(name):
    with gzip.open(
        os.path.join(FIXTURES, name + ".txt.gz"), "rt", encoding="utf8"
    ) as f:
        return f.read()


def _flat(text):
    return re.sub(r"[\s\-" + _GLYPHS + "]+", "", text)


# The running heads, feet and page numbers a text layer puts between the lines
# of a page break: not the source's words.
_FURNITURE = re.compile(
    r"^\s*(?:\d{1,3}(?:-\d{1,3})?"
    r"|Chapter \d+"
    r"|.*\(081-[A-Z0-9-]+\)"
    r"|\d{1,2} \w+ \d{4}\s+TC 4-02\.1.*"
    r"|.*TC 4-02\.1(?:, C\d)?\s+\d{1,2} \w+ \d{4})\s*$"
)


def _source_text(name):
    return _flat(
        "\n".join(
            ln for ln in re.split(r"[\n\f]", _fixture(name)) if not _FURNITURE.match(ln)
        )
    )


def _all_quotes():
    return [(sid, q) for sid, qs in fg.quotes()["quotes"].items() for q in qs]


def _fixture_name(q):
    if q["source"] == "ready":
        return "ready-" + q["slug"]
    return fg.quotes()["sources"][q["source"]]["fixture"]


# ── the quotes ──────────────────────────────────────────────────────────────


def test_every_quote_has_source_edition_place_licence_and_link():
    doc = fg.quotes()
    assert doc["quotes"], "no quotes"
    for sid, q in _all_quotes():
        where = sid + " / " + q.get("id", "?")
        src = doc["sources"][q["source"]]
        assert q["heading"].strip(), where
        assert q["locator"].strip(), where
        assert q["lines"] and all(
            isinstance(x, str) and x.strip() for x in q["lines"]
        ), where
        assert (q.get("edition") or src["edition"]).strip(), where + " has no edition"
        assert (q.get("year") or src["year"]) > 1900, where + " has no year"
        assert src["publisher"].strip() and src["title"].strip(), where
        assert src["licence"] in doc["licences"], "%s: licence %r is not allowed" % (
            where,
            src["licence"],
        )
        assert q["url"].startswith("https://"), where


def test_nothing_from_a_source_we_may_not_quote():
    blob = (
        json.dumps(fg.quotes()["sources"]).lower()
        + json.dumps([q["url"] for _s, q in _all_quotes()]).lower()
    )
    for banned in (
        "hesperian",
        "wikihow",
        "redcross.org",
        "adam",
        "/ency/",
        "medlineplus",
        "tccc",
        "jts.health.mil",
    ):
        assert banned not in blob, banned
    assert set(fg.quotes()["licences"]) <= {
        "US-PD",
        "CC BY 4.0",
        "CC BY-SA 4.0",
        "CC BY 3.0",
        "CC BY-SA 3.0",
    }


def test_quotes_are_the_sources_own_words():
    """Each line is in the text of the source it names (kept as a fixture),
    allowing for what a text layer changes (listed in the quote's ocr)."""
    texts = {}
    for sid, q in _all_quotes():
        name = _fixture_name(q)
        texts.setdefault(name, _source_text(name))
        lines = list(q["lines"])
        if q.get("table"):
            t = q["table"]
            lines += (
                t["head"] + [c for row in t["rows"] for c in row] + [t.get("foot", "")]
            )
        for line in lines:
            printed = line
            for right, wrong in q.get("ocr", []):
                printed = printed.replace(right, wrong)
            assert _flat(printed) in texts[name], "%s / %s: not in %s: %r" % (
                sid,
                q["id"],
                name,
                line[:90],
            )


def test_a_quote_cut_short_or_changed_is_caught():
    """The check above is not vacuous: a changed word is not found."""
    text = _source_text("tc4021")
    assert _flat("Twist the windlass until the bleeding stops.") in text
    assert _flat("Twist the windlass until the bleeding slows.") not in text


def test_every_situation_has_quotes_and_the_groups_name_each_once():
    d = fg.data()
    in_groups = [s for g in d["groups"] for s in g["situations"]]
    assert sorted(in_groups) == sorted(
        d["situations"]
    ), "a situation is in no group or two"
    for sid in in_groups:
        assert fg.quotes()["quotes"].get(sid), sid + " has no quotes"


# The passage each card opens on: what a frightened person can do in the
# next minute, in plain words, not the newest or the most tactical.
FIRST_PASSAGE = {
    "emergency_call": ("g911", "Calling 911"),
    "bleeding": ("atp", "Application of Direct Pressure"),
    "not_breathing": ("atp", "External chest compressions"),
    "choking": ("atp", "Opening the Obstructed Airway: Conscious Casualty"),
    "heart_attack": ("cdc_ha", "Symptoms"),
    "shock": ("atp", "Prevention of Shock"),
    "recovery_position": ("atp", "Check responsiveness and the recovery position"),
    "cold": ("ready", "Hypothermia"),
    "burns": ("ready", "Home Fires: clothes on fire"),
    "heat": ("ready", "Heat-Related Illnesses"),
    "broken_bone": ("atp", "Apply the splint"),
    "bites": ("niosh", "If a snake bites you"),
    "allergic": ("atp", "Treatment for Anaphylactic Shock"),
    "poison": ("hrsa", "What should I do if I think someone has been poisoned?"),
    "lost": ("usfs", "Stop, Think, Observe, Plan"),
    "signal": ("nps", "Signal for help"),
    "shelter": ("nps", "Await rescue: find shelter, keep warm"),
    "water": ("epa", "Consider how the water looks and how to filter it if needed"),
    "flood": ("ready", "During a Flood"),
    "earthquake": ("ready", "Protect Yourself During Earthquakes"),
    "wildfire": ("ready", "Stay Safe During"),
    "storm": ("ready", "If You Are Under A Tornado or Severe Weather Warning"),
    "power_out": ("ready", "Generator Safety"),
    "carbon_monoxide": ("cdc_co", "Symptoms"),
    "food": ("ready", "Food Safety and Sanitation"),
}


def test_every_card_opens_on_its_plain_first_passage():
    quotes = fg.quotes()["quotes"]
    assert sorted(FIRST_PASSAGE) == sorted(quotes), "a situation has no first passage"
    for sid, (source, heading) in FIRST_PASSAGE.items():
        first = quotes[sid][0]
        assert (first["source"], first["heading"]) == (source, heading), sid


def test_the_first_words_are_what_to_do_in_the_next_minute():
    """Bleeding opens on direct pressure itself, with none of the combat
    phases' jargon before it; not breathing opens on the compression steps."""
    q = fg.quotes()["quotes"]
    first = q["bleeding"][0]["lines"][0]
    assert first.startswith("Direct pressure can and should be used")
    for jargon in ("CUF", "TFC", "hasty", "windlass", "After packing"):
        assert jargon not in first, jargon
    steps = " ".join(q["not_breathing"][0]["lines"])
    assert "Place the heel of one hand on the center of the person's chest" in steps
    assert "100 to 120 compressions per minute" in steps
    assert (
        q["not_breathing"][1]["source"] == "cdc_ca"
    ), "the signs and the call come second"


def test_the_order_is_what_to_do_first():
    def headings(sid):
        return [q["heading"] for q in fg.quotes()["quotes"][sid]]

    bleeding = headings("bleeding")
    assert bleeding.index("Application of Direct Pressure") < bleeding.index(
        "Application of Tourniquets"
    )
    cold = headings("cold")
    assert cold.index("Hypothermia") < cold.index("Frostbite")
    lost = [(q["source"], q["heading"]) for q in fg.quotes()["quotes"]["lost"]]
    assert lost[0][0] == "usfs" and lost[1][0] == "nps", "stay put comes first"
    storm = headings("storm")
    assert storm[0].startswith("If You Are Under A Tornado")


def test_the_current_manual_leads_and_the_superseded_one_says_so():
    doc = fg.quotes()
    assert doc["sources"]["atp"]["edition"].endswith("2026")
    assert "superseded" not in doc["sources"]["atp"]
    assert doc["sources"]["tc4021"]["superseded"].startswith("ATP 4-02.11")
    for sid, qs in doc["quotes"].items():
        used = [q["source"] for q in qs]
        if "tc4021" in used and "atp" in used:
            assert used.index("atp") < used.index("tc4021"), sid
    assert fg.situation("cold")["quotes"][-1]["source"]["superseded"]


def test_no_tactical_or_enemy_words_in_a_layperson_card():
    for sid, qs in fg.quotes()["quotes"].items():
        for q in qs:
            text = " ".join(q["lines"]).lower().replace("greatest enemy", "")
            assert "enemy" not in text, (sid, q["id"])


def test_no_mark_the_sources_do_not_state():
    marks = fg.data()["marks"]
    assert set(marks.values()) <= {"M", "A", "R", "C", "H"}
    assert not any(m in marks.values() for m in ("3h", "3d", "3w"))
    assert marks == {
        "bleeding": "M",
        "recovery_position": "A",
        "shock": "C",
        "cold": "H",
    }


def test_a_cross_linked_situation_names_a_real_one():
    sits = fg.data()["situations"]
    for sid, qs in fg.quotes()["quotes"].items():
        for q in qs:
            for other in q.get("related", []):
                assert other in sits and other != sid, (sid, other)
    assert "power_out" in {
        r for q in fg.quotes()["quotes"]["flood"] for r in q.get("related", [])
    }
    assert "flood" in {
        r for q in fg.quotes()["quotes"]["power_out"] for r in q.get("related", [])
    }


def test_sources_that_pair_naturally_are_cross_linked():
    """Flood and Power out, Power out and Carbon monoxide, Cold and Shelter,
    Lost and Signal: each card offers its partner (See also), both ways."""
    for a, b in (
        ("flood", "power_out"),
        ("power_out", "carbon_monoxide"),
        ("carbon_monoxide", "power_out"),
        ("cold", "shelter"),
        ("shelter", "cold"),
        ("lost", "signal"),
        ("signal", "lost"),
        ("power_out", "flood"),
    ):
        assert b in fg.situation(a)["related"], (a, b)
        assert b in fg.situation_bare(a)["related"], (a, b)
    assert fg.situation("water")["related"] == []


def test_the_electricity_warning_is_the_flood_cards_second_quote():
    flood = fg.quotes()["quotes"]["flood"]
    assert flood[0]["heading"] == "During a Flood"
    assert "Do not touch electrical equipment if it is wet" in " ".join(
        flood[1]["lines"]
    )


def test_the_disclaimer_is_the_one_sentence():
    assert fg.DISCLAIMER == "Not medical advice. Call emergency services if you can."
    assert fg.home()["disclaimer"] == fg.DISCLAIMER


def test_the_shell_knows_every_situation_and_has_every_word_it_asks_for():
    """app.js lists the situations (to check an address) and the words it
    hands the page; each must exist, in every language."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, "zimi", "static", "app.js"), encoding="utf8") as f:
        js = f.read()
    listed = re.search(r"var _FIELDGUIDE_SITUATIONS = \[(.*?)\];", js, re.S).group(1)
    assert sorted(re.findall(r"'(\w+)'", listed)) == sorted(fg.data()["situations"])
    words = re.search(r"var _FIELDGUIDE_WORDS = \[(.*?)\];", js, re.S).group(1)
    keys = re.findall(r"'(fieldguide_\w+)'", words) + [
        "fieldguide",
        "fieldguide_search_placeholder",
    ]
    keys += ["fieldguide_s_" + sid for sid in fg.data()["situations"]]
    for lang in LANGS:
        with open(
            os.path.join(root, "zimi", "static", "i18n", lang + ".json"),
            encoding="utf8",
        ) as f:
            have = json.load(f)
        assert not [k for k in keys if k not in have], lang


def test_no_authored_instruction_in_the_data():
    """Our own words are names and navigation: the situation data holds no
    sentences of advice (the keywords are words people type)."""
    for sid, sit in fg.data()["situations"].items():
        for lang, words in sit["keywords"].items():
            assert all(len(w.split()) <= 6 for w in words), (sid, lang)


# ── what is typed ───────────────────────────────────────────────────────────

TYPED = {
    "bleeding": {
        "en": [
            "bleeding",
            "tourniquet",
            "how to stop bleeding",
            "Stop Bleeding!",
            "my friend is bleeding",
            "blood",
        ],
        "fr": ["saignement", "il saigne"],
        "de": ["blutung", "blutet"],
        "es": ["sangrando", "sangrado"],
        "ru": ["кровотечение"],
        "ar": ["ينزف"],
        "zh": ["止血"],
    },
    "water": {
        "en": ["drinking water", "purify water", "boil water", "thirsty"],
        "es": ["agua potable", "purificar agua"],
        "de": ["wasser abkochen", "trinkwasser"],
        "ru": ["питьевая вода"],
        "zh": ["饮用水"],
    },
    "lost": {
        "en": [
            "i am lost",
            "i'm lost",
            "which way is south",
            "which way is north",
            "no gps",
        ],
        "es": ["estoy perdido"],
        "zh": ["迷路", "我迷路了"],
    },
    "cold": {
        "en": ["hypothermia", "frostbite", "he has hypothermia"],
        "es": ["hipotermia"],
        "de": ["unterkühlung"],
        "zh": ["低温症"],
    },
    "heat": {
        "en": ["heat stroke", "dehydration"],
        "es": ["golpe de calor"],
        "de": ["hitzschlag"],
    },
    "not_breathing": {
        "en": ["cpr", "not breathing", "he is not breathing", "she stopped breathing"],
        "es": ["reanimación", "no respira"],
    },
    "heart_attack": {
        "en": ["heart attack", "chest pain", "i think i am having a heart attack"],
        "es": ["infarto"],
        "de": ["herzinfarkt"],
    },
    "burns": {
        "en": ["scald", "clothes on fire", "my clothes are on fire"],
        "es": ["quemadura"],
        "fr": ["brûlure"],
    },
    "shock": {
        "en": ["going into shock", "signs of shock"],
        "es": ["estado de choque"],
        "fr": ["état de choc"],
    },
    "recovery_position": {
        "en": ["unconscious", "recovery position", "he passed out"],
        "de": ["bewusstlos"],
    },
    "emergency_call": {"en": ["call 911", "what to tell 911", "how to call 911"]},
    "broken_bone": {
        "en": ["broken leg", "broken arm", "how to splint"],
        "de": ["beinbruch"],
    },
    "bites": {
        "en": ["snake bite", "bee sting", "bitten by a snake"],
        "de": ["schlangenbiss"],
    },
    "allergic": {"en": ["allergic reaction", "anaphylaxis", "epipen"]},
    "poison": {
        "en": ["poisoning", "poison control", "my child swallowed bleach"],
        "de": ["vergiftung"],
    },
    "carbon_monoxide": {
        "en": ["carbon monoxide", "co poisoning", "carbon monoxide detector"]
    },
    "shelter": {"en": ["build a shelter", "make a fire", "stay warm"]},
    "food": {"en": ["preserve food", "hungry", "food safety"]},
    "signal": {"en": ["signal for help", "sos", "distress signal"]},
    "flood": {
        "en": ["flood", "flash flood", "water rising", "the water is rising"],
        "es": ["inundación"],
        "de": ["hochwasser"],
    },
    "earthquake": {
        "en": ["earthquake", "aftershock"],
        "es": ["terremoto"],
        "zh": ["地震"],
    },
    "wildfire": {"en": ["wildfire", "forest fire"], "es": ["incendio forestal"]},
    "storm": {"en": ["tornado", "hurricane", "thunderstorm"], "fr": ["ouragan"]},
    "power_out": {
        "en": ["power outage", "blackout", "no power"],
        "de": ["stromausfall"],
        "es": ["apagón"],
    },
}


@pytest.mark.parametrize("sid", sorted(TYPED))
def test_typed_words_name_their_situation(sid):
    for lang, texts in TYPED[sid].items():
        for text in texts:
            assert fg.match(text, lang) == sid, (lang, text)
            assert fg.lookup(text, lang)[1] == "card", (lang, text)


# A bare word that could be about anything is a small link, never the card.
AMBIGUOUS = {
    "water": "water",
    "signal": "signal",
    "storm": "storm",
    "food": "food",
    "fire": "wildfire",
    "generator": "power_out",
    "shock": "shock",
    "cold": "cold",
    "burn": "burns",
    "lost": "lost",
    "shelter": "shelter",
}


# A parent types "baby": the infant passage leads, never the adult's thrusts.
@pytest.mark.parametrize(
    "query,lang",
    [
        ("baby choking", "en"),
        ("my infant is choking", "en"),
        ("newborn choked", "en"),
        ("bebé atragantado", "es"),
        ("婴儿噎住", "zh"),
    ],
)
def test_a_baby_named_gets_the_infant_passage_first(query, lang):
    h = fg.hint(query, lang)
    assert h["id"] == "choking" and h["who"] == "infant"
    tagged = [q for q in fg.quotes()["quotes"]["choking"] if q.get("who") == "infant"]
    assert tagged and tagged[0]["heading"].startswith("Infants")


@pytest.mark.parametrize("query", ["choking", "my friend is choking", "baby food"])
def test_no_baby_named_no_one_singled_out(query):
    h = fg.hint(query)
    assert h is None or h["who"] is None


def test_every_who_tag_is_one_the_words_can_name():
    names = set(fg.data()["who"])
    for qs in fg.quotes()["quotes"].values():
        for q in qs:
            assert q.get("who") in names | {None}


@pytest.mark.parametrize("word", sorted(AMBIGUOUS))
def test_a_bare_ambiguous_word_is_a_link_not_a_card(word):
    assert fg.lookup(word) == (AMBIGUOUS[word], "link")
    h = fg.hint(word)
    assert h["kind"] == "link" and h["installed"] == []


# What a frightened person types, which must reach the card that answers it.
SENTENCES = {
    "cut leg": "bleeding",
    "cut finger": "bleeding",
    "bleeding hand": "bleeding",
    "my friend has a deep cut": "bleeding",
    "i cant breathe": "choking",
    "i can't breathe": "choking",
    "heimlich": "choking",
    "something stuck in throat": "choking",
    "stay put": "lost",
    "lost at night": "lost",
}


@pytest.mark.parametrize("text", sorted(SENTENCES))
def test_what_a_frightened_person_types_reaches_its_card(text):
    assert fg.lookup(text) == (SENTENCES[text], "card"), text


def test_a_bare_lost_is_the_small_help_now_link_and_never_offers_lit():
    from zimi import http

    assert fg.lookup("lost") == ("lost", "link")
    answer = {"results": [], "did_you_mean": "lit"}
    guided = http._with_fieldguide(answer, fg.hint("lost"))
    assert "did_you_mean" not in guided and guided["fieldguide"]["id"] == "lost"
    assert answer["did_you_mean"] == "lit", "the cached answer is left as it was"
    assert http._with_fieldguide(answer, None)["did_you_mean"] == "lit"


def test_a_clear_emergency_is_a_card():
    for text in ("bleeding", "not breathing", "tourniquet", "heart attack"):
        assert fg.lookup(text)[1] == "card", text


def test_heart_attack_and_chest_pain_do_not_land_on_cpr():
    for text in ("heart attack", "chest pain", "pain in my chest"):
        assert fg.match(text) == "heart_attack", text
    assert fg.match("cardiac arrest") == "not_breathing"


CHOKING_WORDS = [
    "choking",
    "he is choking",
    "heimlich",
    "heimlich maneuver",
    "can't breathe",
    "i cant breathe",
    "I can't breathe",
    "something stuck in throat",
    "something is stuck in my throat",
]


@pytest.mark.parametrize("text", CHOKING_WORDS)
def test_choking_words_find_the_choking_card(text):
    assert fg.lookup(text) == ("choking", "card"), text


def test_the_choking_card_is_the_armys_words_and_an_open_infant_source():
    """Back blows, then abdominal thrusts, word for word from ATP 4-02.11;
    infants have their own open passage, and each quote says what it covers
    in the source's own sentence."""
    qs = fg.quotes()["quotes"]["choking"]
    assert [q["source"] for q in qs] == ["atp", "wp_choking", "atp"]
    thrusts = " ".join(qs[2]["lines"])
    assert thrusts.startswith(
        "5-33. Prior to applying abdominal thrust, first responders should administer five back blows."
    )
    assert "Press the fists into the abdomen" in thrusts
    infants = " ".join(qs[1]["lines"])
    assert (
        "Abdominal thrusts are not recommended in children less than one year old"
        in infants
    )
    for q in qs:
        if "scope" in q:
            assert q["scope"].strip() in " ".join(q["lines"]), (
                q["id"] + ": scope is the source's own sentence"
            )
        assert q["related"] == ["not_breathing"]
    assert qs[0]["scope"]
    # The infant passage names who it is for in its heading and opens on
    # what to do: back slaps, then chest compressions.
    assert "Infants" in qs[1]["heading"] and "scope" not in qs[1]
    assert qs[1]["lines"][0].startswith("First aid for choking infants alternates")
    sit = fg.situation("choking")
    assert [q["source"]["licence"] for q in sit["quotes"]] == [
        "US-PD",
        "CC BY-SA 4.0",
        "US-PD",
    ]


# Searches that are about something else and must get nothing.
NOT_ABOUT_HELP = [
    "sed",
    "brand",
    "generator docs",
    "signal processing",
    "water cycle",
    "the lost city of atlantis",
    "burn notice",
    "heat pump installation",
    "food network",
    "storm of the century lyrics",
    "cold war",
    "shock absorber",
    "knots",
    "python tutorial",
    "wikipedia",
    "",
    "   ",
    "x" * 200,
]


@pytest.mark.parametrize("text", NOT_ABOUT_HELP)
def test_a_normal_search_gets_no_card_and_no_link(text):
    for lang in LANGS:
        assert fg.lookup(text, lang) is None, (lang, text)


def test_only_the_readers_language_and_english_are_read():
    assert fg.match("blutet", "en") is None
    assert fg.match("blutet", "de") == "bleeding"
    assert fg.match("agua", "en") is None
    assert fg.lookup("agua", "es") == ("water", "link")
    assert fg.match("止血", "en") is None and fg.match("止血", "zh") == "bleeding"
    assert fg.match("bleeding", "de") == "bleeding", "English is always read"
    assert fg.match("blutet", "xx") is None, "an unknown language reads English only"


def test_every_language_can_find_every_situation():
    for sid, sit in fg.data()["situations"].items():
        for lang in LANGS:
            assert sit["keywords"].get(lang), "%s has no %s keywords" % (sid, lang)


def test_first_aid_and_survival_name_the_field_guide_itself():
    for lang, text in (
        ("en", "first aid"),
        ("en", "survival"),
        ("es", "primeros auxilios"),
        ("de", "erste hilfe"),
        ("zh", "急救"),
    ):
        assert fg.lookup(text, lang) == ("", "link"), text


def test_no_phrase_names_two_situations():
    seen = {}
    for sid, sit in fg.data()["situations"].items():
        for kind in ("keywords", "within", "ambiguous"):
            for lang, words in sit.get(kind, {}).items():
                for w in words:
                    n = (lang, fg.normalize(w))
                    assert seen.setdefault(n, sid) == sid, "%r is in %s and %s" % (
                        w,
                        seen[n],
                        sid,
                    )


def test_normalize_keeps_scripts_it_must_and_drops_accents_it_may():
    assert fg.normalize("  Hipotermía! ") == "hipotermia"
    assert fg.normalize("I'm LOST") == "im lost"
    assert fg.normalize("प्राथमिक चिकित्सा") == "प्राथमिक चिकित्सा"
    assert fg.normalize("نزيف") == "نزيف"


def test_matching_is_a_lookup_not_a_scan():
    """The search path pays an in-memory dict lookup (the table is built
    once) and reads no ZIM."""
    fg.match("bleeding")
    built = fg._index
    for _ in range(3):
        fg.match("water")
    assert fg._index is built


# ── a library to open a situation in ────────────────────────────────────────


@pytest.fixture(scope="module")
def library(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("fieldguide")
    zdir = tmp / "zims"
    zdir.mkdir()
    fx.build_library(str(zdir))
    mp = pytest.MonkeyPatch()
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(tmp / "data"))
    os.makedirs(str(tmp / "data"), exist_ok=True)
    mp.setenv("ZIMI_OFFLINE", "1")
    srv.load_cache(force=True)
    fg._reset_for_tests()
    yield str(zdir)
    mp.undo()
    fg._reset_for_tests()


@pytest.fixture
def empty_library(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIM_DIR", str(tmp_path))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    srv.load_cache(force=True)
    fg._reset_for_tests()
    yield
    # Hand the library back as it was: a worker that runs this and then a test on the module's `library` would
    # otherwise find the empty folder's list still loaded (xdist deals one module's tests across workers).
    monkeypatch.undo()
    srv.load_cache(force=True)
    fg._reset_for_tests()


def test_an_empty_library_still_answers_every_situation(empty_library):
    for sid in fg.data()["situations"]:
        s = fg.situation(sid)
        assert s["quotes"], sid
        assert s["answers"] == []
        for q in s["quotes"]:
            assert q["source"]["licence"] and q["url"].startswith("https://")
            assert q["library"]["state"] == "missing"


def test_a_missing_zim_is_named_with_its_size_and_a_way_to_get_it(empty_library):
    s = fg.situation("flood")
    pieces = {m["piece"]: m for m in s["missing"]}
    assert "ready" in pieces and pieces["ready"]["size_bytes"] > 1_000_000_000
    assert pieces["ready"]["url"].startswith("https://")
    quote_options = {o["piece"] for q in s["quotes"] for o in q["library"]["options"]}
    assert "ready" in quote_options


def test_a_manual_quote_offers_the_field_manual_and_the_full_army_library(
    empty_library, monkeypatch
):
    # Building the manual is offered only online; the test's own ZIMI_OFFLINE must not decide it.
    monkeypatch.setattr(fg, "_offline", lambda: False)
    s = fg.situation("bleeding")
    tc = next(q for q in s["quotes"] if q["source"]["id"] == "atp")
    options = {o["piece"]: o for o in tc["library"]["options"]}
    assert set(options) == {"field_manual", "armypubs"}
    assert (
        options["field_manual"]["build"] == "field_manual"
        and not options["field_manual"]["url"]
    )
    assert options["armypubs"]["size_bytes"] > 1_000_000_000


def test_a_dated_source_says_so_and_a_current_one_does_not(empty_library):
    shelter = fg.situation("shelter")
    assert {q["source"]["id"]: q["source"]["dated"] for q in shelter["quotes"]} == {
        "nps": False,
        "fm2176": True,
    }
    bleeding = fg.situation("bleeding")
    assert not any(q["source"]["dated"] for q in bleeding["quotes"])
    assert all(q["source"]["year"] >= 2026 for q in bleeding["quotes"])


def test_a_quote_with_no_zim_behind_it_links_only_to_its_source(empty_library):
    s = fg.situation("water")
    epa = next(q for q in s["quotes"] if q["source"]["id"] == "epa")
    assert epa["library"] == {"state": "missing", "options": []}
    assert epa["url"].startswith("https://www.epa.gov/")


def test_installed_zims_deepen_the_quotes_and_list_their_pages(library):
    s = fg.situation("flood")
    ready = next(q for q in s["quotes"] if q["source"]["id"] == "ready")
    assert ready["library"]["state"] == "installed"
    assert ready["library"]["open"] == {
        "zim": "www.ready.gov",
        "path": "www.ready.gov/floods",
    }
    page = next(a for a in s["answers"] if a["kind"] == "page")
    assert page["path"] == "www.ready.gov/floods" and page["piece"] == "ready"
    assert page["year"] == 2024


def test_a_document_library_is_listed_by_title(library):
    s = fg.situation("water")
    docs = [a for a in s["answers"] if a["kind"] == "doc"]
    assert {d["title"] for d in docs} == {
        "Distillation For Home Water Treatment",
        "Giardia",
    }
    assert all(
        d["path"].startswith("files/") and d["zim"] == "zimgit-water" for d in docs
    )


def test_the_field_manual_zim_carries_the_manual_quotes(library):
    s = fg.situation("bleeding")
    atp = next(q for q in s["quotes"] if q["source"]["id"] == "atp")
    assert atp["library"]["state"] == "installed"
    assert atp["library"]["open"] == {
        "zim": "zimi_field_manual",
        "path": "ATP_4-02.11_Casualty_Response.pdf",
    }
    tc = next(
        q for q in fg.situation("cold")["quotes"] if q["source"]["id"] == "tc4021"
    )
    assert tc["library"]["open"]["path"] == "TC_4-02.1_First_Aid.pdf"
    fm = next(
        q for q in fg.situation("shelter")["quotes"] if q["source"]["id"] == "fm2176"
    )
    assert fm["library"]["open"]["path"] == "FM_21-76_Survival.pdf"


def test_encyclopedia_pages_are_found_by_title(library):
    s = fg.situation("cold")
    titles = [a["title"] for a in s["answers"] if a["piece"] == "wikipedia"]
    assert "Hypothermia" in titles


def test_pages_come_before_searches_and_newer_before_older(library):
    s = fg.situation("bleeding")
    kinds = [a["kind"] for a in s["answers"]]
    assert kinds == sorted(kinds, key=lambda k: k == "search")


def test_other_languages_get_their_own_wikipedia_searched_in_their_words(library):
    es = fg.situation("cold", lang="es")
    row = next(a for a in es["answers"] if a["piece"] == "wikipedia_es")
    assert (
        row["kind"] == "search"
        and row["zim"] == "wikipedia_es_medicine"
        and row["q"] == "hipotermia"
    )
    assert not any(
        a["piece"] == "wikipedia_es" for a in fg.situation("cold")["answers"]
    )
    # The quotes stay English until a person has checked a translation.
    assert [q["lines"] for q in es["quotes"]] == [
        q["lines"] for q in fg.situation("cold")["quotes"]
    ]


def test_the_search_hint_names_the_situation_and_what_is_installed(library):
    h = fg.hint("tourniquet")
    assert h["id"] == "bleeding" and h["href"] == "/#fieldguide/bleeding"
    assert h["kind"] == "card"
    assert {"piece": "wikipedia", "name": "Wikipedia"} in h["installed"]
    assert fg.hint("water cycle") is None
    assert fg.hint("first aid") == {
        "id": "",
        "kind": "link",
        "href": "/#fieldguide",
        "installed": [],
        "who": None,
    }


def test_the_search_hint_reads_no_zim(library, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("the search path opened a ZIM")

    monkeypatch.setattr(srv, "get_archive", boom)
    monkeypatch.setattr(srv, "open_archive", boom)
    assert fg.hint("flood")["id"] == "flood"


def test_the_library_lists_sizes_and_installed_state(library):
    sets = {s["id"]: s for s in fg.library()["sets"]}
    core = {p["piece"]: p for p in sets["core"]["pieces"]}
    assert (
        core["zimgit_water"]["installed"]
        and core["zimgit_water"]["zim"] == "zimgit-water"
    )
    assert (
        not core["zimgit_medicine"]["installed"]
        and core["zimgit_medicine"]["size_bytes"] > 0
    )
    assert core["zimgit_medicine"]["url"].startswith("https://")
    assert core["field_manual"]["installed"]
    assert sets["core"]["missing"] > 0 and sets["core"]["missing_bytes"] > 0


def test_the_catalog_names_in_the_data_exist():
    from zimi import catalog_snapshot

    names = {e["name"] for e in catalog_snapshot.entries()}
    for pid, piece in fg.data()["pieces"].items():
        for n in piece.get("catalog", []):
            assert n in names, "%s: %s is not in the catalog" % (pid, n)


# ── over HTTP ───────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def served(library):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _get(base, path):
    try:
        with urllib.request.urlopen(base + path, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def test_the_front_lists_the_groups_in_order(served):
    status, body = _get(served, "/fieldguide")
    assert status == 200
    assert [g["id"] for g in body["groups"]] == ["hurt", "survive", "disaster"]
    hurt = body["groups"][0]["situations"]
    assert [s["id"] for s in hurt][:3] == [
        "emergency_call",
        "bleeding",
        "not_breathing",
    ]
    assert {s["id"]: s["mark"] for s in hurt}["bleeding"] == "M"
    assert sum(len(g["situations"]) for g in body["groups"]) == 25
    assert body["disclaimer"] == fg.DISCLAIMER


def test_a_situation_over_http_and_unknown_is_404(served):
    status, body = _get(served, "/fieldguide/situation?id=bleeding")
    assert status == 200 and body["quotes"] and body["disclaimer"]
    status, body = _get(served, "/fieldguide/situation?id=../../etc")
    assert status == 404
    status, body = _get(served, "/fieldguide/situation")
    assert status == 404


def test_the_library_and_match_routes(served):
    status, body = _get(served, "/fieldguide/library")
    assert status == 200 and body["sets"]
    status, body = _get(served, "/fieldguide/match?q=hypothermia")
    assert status == 200 and body == {"id": "cold", "kind": "card", "who": None}
    status, body = _get(served, "/fieldguide/match?q=water+cycle")
    assert status == 200 and body == {"id": None, "kind": None, "who": None}
    status, body = _get(served, "/fieldguide/match?q=blutet&ui=de")
    assert body == {"id": "bleeding", "kind": "card", "who": None}
    status, body = _get(served, "/fieldguide/match?q=blutet")
    assert body == {"id": None, "kind": None, "who": None}
    status, body = _get(served, "/fieldguide/match?q=my+baby+is+choking")
    assert body == {"id": "choking", "kind": "card", "who": "infant"}


def test_search_answers_with_the_situation_and_stays_quiet_otherwise(served):
    status, body = _get(served, "/search?q=" + urllib.parse.quote("hypothermia"))
    assert status == 200
    assert (
        body["fieldguide"]["id"] == "cold"
        and body["fieldguide"]["href"] == "/#fieldguide/cold"
    )
    status, body = _get(served, "/search?q=" + urllib.parse.quote("water cycle"))
    assert "fieldguide" not in body
    status, body = _get(served, "/search?q=hypothermia&zim=wikipedia_en_top")
    assert "fieldguide" not in body, "a search inside one ZIM is not asking for help"


def test_the_stream_carries_the_hint_in_its_first_line(served):
    with urllib.request.urlopen(
        served + "/search?q=tourniquet&stream=1&fast=1", timeout=30
    ) as r:
        first = json.loads(r.readline())
    assert (
        first["phase"] == "fast" and first["result"]["fieldguide"]["id"] == "bleeding"
    )


def test_the_guide_routes_are_rate_limited_like_the_apps():
    from zimi import http

    assert "/fieldguide" in http._RATE_LIMITED_API_PATHS
    assert "/fieldguide/" in http._RATE_LIMITED_API_PREFIXES


# ── the field manual ────────────────────────────────────────────────────────


def _tiny_manuals():
    import hashlib

    items, blobs = [], {}
    for name, title in (
        ("A_First_Aid.pdf", "Manual A"),
        ("B_Survival.pdf", "Manual B"),
    ):
        body = b"%PDF-1.4 " + name.encode()
        url = "https://example.invalid/" + name
        items.append(
            {
                "file": name,
                "title": title,
                "date": "1992-06-05",
                "description": "A test manual.",
                "url": url,
                "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
            }
        )
        blobs[url] = body
    return tuple(items), blobs


@pytest.fixture
def build_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIM_DIR", str(tmp_path / "zims"))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "zims"))
    os.makedirs(str(tmp_path / "data"))
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    fg._reset_for_tests()
    yield tmp_path / "zims"
    fg._reset_for_tests()


def test_the_field_manual_is_built_from_checked_downloads_with_creates_folder_mode(
    build_dir, monkeypatch
):
    import io

    from zimi import p2p

    monkeypatch.setattr(p2p, "is_offline", lambda: False)
    manuals, blobs = _tiny_manuals()
    heard = []
    out = fg.build_field_manual(
        out_dir=str(build_dir),
        progress=heard.append,
        fetch=lambda url: io.BytesIO(blobs[url]),
        manuals=manuals,
    )
    assert out["assets"] == 2 and os.path.exists(out["path"]) and out["registered"]
    assert any("Manual A" in h for h in heard)
    srv.load_cache(force=True)
    docs = fg._docs("zimi_field_manual", ["*"], "zimi-database.js")
    assert sorted(d[1] for d in docs) == ["Manual A", "Manual B"]
    assert not [
        f for f in os.listdir(str(build_dir)) if f.startswith("zimi-field-manual-")
    ], "scratch left behind"


def test_a_file_that_is_not_the_expected_one_is_refused(build_dir, monkeypatch):
    import io

    from zimi import creator, p2p

    monkeypatch.setattr(p2p, "is_offline", lambda: False)
    manuals, blobs = _tiny_manuals()
    blobs[manuals[0]["url"]] = b"%PDF-1.4 something else entirely"
    with pytest.raises(creator.CreateError, match="not the file"):
        fg.build_field_manual(
            out_dir=str(build_dir),
            fetch=lambda url: io.BytesIO(blobs[url]),
            manuals=manuals,
        )
    assert not [f for f in os.listdir(str(build_dir)) if f.endswith(".zim")]


def test_offline_builds_nothing(build_dir, monkeypatch):
    from zimi import creator, p2p

    monkeypatch.setattr(p2p, "is_offline", lambda: True)
    with pytest.raises(creator.CreateError, match="OFFLINE"):
        fg.build_field_manual(
            out_dir=str(build_dir),
            fetch=lambda url: (_ for _ in ()).throw(AssertionError("fetched")),
        )


def test_the_shipped_manual_addresses_are_the_verified_originals():
    for m in fg.MANUALS:
        assert m["url"].startswith(
            (
                "https://upload.wikimedia.org/wikipedia/commons/",
                "https://armypubs.army.mil/epubs/",
            )
        ), m["file"]
        assert len(m["sha256"]) == 64 and m["bytes"] > 1_000_000
    assert {m["title"] for m in fg.MANUALS} == {
        "ATP 4-02.11 Casualty Response",
        "TC 4-02.1 First Aid",
        "FM 21-76 Survival",
        "TC 3-21.76 Ranger Handbook",
    }


# ── the build as a Create job, over HTTP ────────────────────────────────────


def _post(base, path, body=None, headers=None):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body or {}).encode(),
        headers=dict({"Content-Type": "application/json"}, **(headers or {})),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


@pytest.fixture
def served_empty(build_dir, monkeypatch):
    from http.server import ThreadingHTTPServer

    from zimi import manage, p2p
    from zimi.http import ZimHandler

    monkeypatch.setattr(p2p, "is_offline", lambda: False)
    monkeypatch.setattr(manage, "setup_pending", lambda: False)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    monkeypatch.undo()
    srv.load_cache(force=True)
    fg._reset_for_tests()


def _wait_job(base, want=("done", "error"), seconds=60):
    import time

    end = time.time() + seconds
    while time.time() < end:
        _s, st = _get(base, "/manage/fieldmanual")
        if st["state"] in want:
            return st
        time.sleep(0.2)
    raise AssertionError("the build did not finish: %r" % st)


def test_building_offline_is_refused_with_409_and_says_offline(
    served_empty, monkeypatch
):
    from zimi import p2p

    monkeypatch.setattr(p2p, "is_offline", lambda: True)
    status, body = _post(served_empty, "/manage/fieldmanual")
    assert (status, body["error"]) == (409, "offline")


def test_build_is_not_offered_offline_and_is_with_its_size_and_source(
    empty_library, monkeypatch
):
    from zimi import p2p

    monkeypatch.setattr(p2p, "is_offline", lambda: False)
    got = fg.situation("bleeding")
    atp = next(q for q in got["quotes"] if q["source"]["id"] == "atp")
    build = next(o for o in atp["library"]["options"] if o.get("build"))
    assert build["size_bytes"] == sum(m["bytes"] for m in fg.MANUALS) > 80_000_000
    assert build["source"] == "Army Publishing Directorate and Wikimedia Commons"
    monkeypatch.setattr(p2p, "is_offline", lambda: True)
    fg._reset_for_tests()
    got = fg.situation("bleeding")
    atp = next(q for q in got["quotes"] if q["source"]["id"] == "atp")
    assert not any(o.get("build") for o in atp["library"]["options"])
    row = next(
        p
        for s in fg.library()["sets"]
        for p in s["pieces"]
        if p["piece"] == "field_manual"
    )
    assert "build" not in row


def test_building_when_it_is_installed_is_refused_with_409(served_empty, monkeypatch):
    monkeypatch.setattr(fg, "installed_manual", lambda: True)
    status, body = _post(served_empty, "/manage/fieldmanual")
    assert (status, body["error"]) == (409, "installed")


def _tiny_fetch(monkeypatch):
    import io

    manuals, blobs = _tiny_manuals()
    monkeypatch.setattr(fg, "MANUALS", manuals)
    monkeypatch.setattr(fg, "_fetch_pinned", lambda url: io.BytesIO(blobs[url]))
    return manuals


def test_the_build_runs_as_a_create_job_and_lands_in_the_library(
    served_empty, monkeypatch
):
    _tiny_fetch(monkeypatch)
    status, body = _post(served_empty, "/manage/fieldmanual")
    assert (
        status == 200 and body["status"] == "started" and body["mode"] == "fieldmanual"
    )
    done = _wait_job(served_empty)
    assert done["state"] == "done", done
    status, listing = _get(served_empty, "/manage/create/status")
    assert status == 200


def test_a_failed_build_says_why_in_the_createerror_words_only(
    served_empty, monkeypatch
):
    manuals = _tiny_fetch(monkeypatch)
    monkeypatch.setattr(
        fg,
        "_fetch_pinned",
        lambda url: (_ for _ in ()).throw(RuntimeError("secret /home/eric/.ssh path")),
    )
    status, _b = _post(served_empty, "/manage/fieldmanual")
    assert status == 200
    st = _wait_job(served_empty)
    assert st["state"] == "error"
    assert "secret" not in json.dumps(st) and ".ssh" not in json.dumps(st)
    assert "server log" in st["message"]


def test_a_createerror_message_reaches_the_page_as_it_is(served_empty, monkeypatch):
    from zimi import creator

    def refuse(item, dest, fetch):
        raise creator.CreateError(
            "ATP 4-02.11 Casualty Response is not the file this build expects"
        )

    _tiny_fetch(monkeypatch)
    monkeypatch.setattr(fg, "_download_manual", refuse)
    _post(served_empty, "/manage/fieldmanual")
    st = _wait_job(served_empty)
    assert st["state"] == "error" and "not the file this build expects" in st["message"]


def test_the_pinned_fetch_refuses_a_redirect():
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Moved(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/elsewhere")
            self.end_headers()

        def log_message(self, *a):
            pass

    httpd = HTTPServer(("127.0.0.1", 0), Moved)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        opener = urllib.request.build_opener(fg._NoRedirect)
        with pytest.raises(urllib.error.HTTPError) as err:
            opener.open(
                "http://127.0.0.1:%d/a.pdf" % httpd.server_address[1], timeout=10
            )
        assert err.value.code == 302
        from zimi import creator

        with pytest.raises(creator.CreateError, match="moved"):
            fg._download_manual(
                {"url": "http://x", "title": "T", "bytes": 1, "sha256": "0"},
                os.devnull,
                lambda url: (_ for _ in ()).throw(
                    urllib.error.HTTPError(url, 302, "Found", {}, None)
                ),
            )
        with pytest.raises(creator.CreateError, match="https"):
            fg._fetch_pinned("http://example.invalid/a.pdf")
    finally:
        httpd.shutdown()


# ── who the guide answers before the library is theirs ──────────────────────


def test_the_sign_in_screen_still_gets_the_words_and_none_of_the_library(
    served, monkeypatch
):
    from zimi import users

    monkeypatch.setattr(users, "get_public_access", lambda: ("private", None))
    monkeypatch.setattr(users, "resolve_request_user", lambda h: None)
    monkeypatch.setattr(users, "_request_is_admin", lambda h: False)
    status, body = _get(served, "/fieldguide/situation?id=bleeding")
    assert (
        status == 200
        and body["quotes"]
        and body["answers"] == []
        and body["missing"] == []
    )
    assert all(
        q["library"] == {"state": "missing", "options": []} for q in body["quotes"]
    )
    status, home = _get(served, "/fieldguide")
    assert status == 200 and all(
        s["installed"] == 0 for g in home["groups"] for s in g["situations"]
    )
    assert _get(served, "/fieldguide/library")[0] == 401
    assert _get(served, "/search?q=bleeding")[0] == 401
    # The "What's happening?" box: the guide's own phrase lists, no ZIM read.
    assert _get(served, "/fieldguide/match?q=baby+is+choking") == (
        200,
        {"id": "choking", "kind": "card", "who": "infant"},
    )
    # Nothing past the door by a route's spelling.
    for path in (
        "/fieldguide/library/",
        "/fieldguide//library",
        "/fieldguide/../search?q=x",
        "/fieldguide/%2e%2e/search?q=x",
    ):
        assert _get(served, path)[0] == 401, path


def test_a_fresh_install_still_gets_the_words(served, monkeypatch):
    from zimi import manage

    monkeypatch.setattr(manage, "setup_pending", lambda: True)
    status, body = _get(served, "/fieldguide/situation?id=lost")
    assert status == 200 and body["quotes"] and body["answers"] == []
    assert _get(served, "/fieldguide/match?q=bleeding")[1]["id"] == "bleeding"
    assert _get(served, "/fieldguide/library")[0] != 200


def test_a_signed_in_visitor_gets_the_library_with_the_words(served):
    status, body = _get(served, "/fieldguide/situation?id=flood")
    assert status == 200 and body["answers"], "the installed pages are listed"


def test_print_all_is_every_situation_in_order_with_its_address(served):
    status, body = _get(served, "/fieldguide/print")
    assert status == 200
    ids = [s["id"] for s in body["situations"]]
    assert (
        ids == [i for g in fg.data()["groups"] for i in g["situations"]]
        and len(ids) == 25
    )
    for sit in body["situations"]:
        assert sit["quotes"]
        assert all(q["url"].startswith("https://") for q in sit["quotes"])


def test_every_quote_is_dated_by_its_guidance():
    from zimi import fieldguide as fg

    q = fg.quotes()
    for sid, items in q["quotes"].items():
        for item in items:
            view = fg._source_view(item["source"], item)
            assert view["as_of"], "%s has no guidance date" % item["id"]
    # The infant passage dates to its revision; a change outdates its base edition.
    infant = next(i for i in q["quotes"]["choking"] if i["source"] == "wp_choking")
    assert fg._source_view("wp_choking", infant)["as_of"] == "2026-08"
    assert fg._as_of("January 2016, Change 2 of 7 December 2018", 2018) == "2018-12"
    assert fg._as_of("Page last updated 03/10/2026", 2026) == "2026-03"
    assert fg._as_of("Sept. 23, 2026", 2026) == "2026-09"
