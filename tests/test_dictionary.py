"""Dictionary: one word across every Wiktionary in the library.

The pages are Kiwix's own (tests/dictionary_fixture.py says which builds),
read the way the app reads them: by language of the word, part of speech,
senses, pronunciation by accent, etymology, the words around it and
translations; a recording offered only where the ZIM holds one; then the
whole word through HTTP, and in a browser at a phone's width.

Run: pytest tests/test_dictionary.py -v
"""

import json
import os
import sys
import threading
import urllib.error
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dictionary_fixture as fx  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import dictionary as dic  # noqa: E402


def parsed(name, path, lang, zim="wiktionary_en_all", has=None):
    return dic.parse_page(fx.page(name).decode(), path, lang, zim, archive_has=has)


def lang_of(page, code):
    return next(lg for lg in page["langs"] if lg["code"] == code)


def parts(lg):
    return [p for g in lg["groups"] for p in g["parts"]]


def text(segs):
    return dic._plain(segs)


# ── English Wiktionary, 2026 (div.mw-heading) ──────────────────────────────


def test_english_water_by_language_part_and_sense():
    page = parsed("en_water", "water", "en")
    assert [lg["code"] for lg in page["langs"]] == ["en", "fr"]
    en = lang_of(page, "en")
    assert len(en["groups"]) == 2  # Etymology 1 (the noun) and 2 (the verb)
    assert text(en["groups"][0]["ety"]).startswith("From Middle English water")
    noun, verb = parts(en)
    assert (noun["pos"], verb["pos"]) == ("Noun", "Verb")
    assert "plural waters" in text(noun["head"])
    first = noun["senses"][0]
    assert "inorganic compound" in text(first["d"])
    assert first["ex"][0].startswith("By the action of electricity")
    assert "ice" in [w["w"] for w in first["syn"]]
    # A thesaurus is the wiki's page, not a word.
    assert not any(w["t"].startswith("Thesaurus:") for w in first["syn"])
    # Each linked word is a way on: "liquid" is the word liquid.
    assert ["liquid", "liquid"] in first["d"]
    assert first["sub"][0]["d"]
    # The noun's translations live on a page of their own.
    assert noun["trans_see"] == "water/translations#Noun"
    fr = next(i for i in verb["trans"][0]["items"] if i["lang"] == "fr")
    assert fr["name"] == "French" and fr["words"][0] == {
        "w": "arroser",
        "t": "arroser#French",
    }
    derived = next(w for w in noun["words"] if w["kind"] == "derived")
    assert derived["title"] == "Derived terms" and len(derived["items"]) > 5


def test_english_water_sounds_by_accent():
    pron = lang_of(parsed("en_water", "water", "en"), "en")["pron"]
    by = {r["accent"]: r["ipa"] for r in pron["ipa"]}
    assert by["Received Pronunciation"][0] == "/ˈwɔː.tə/"
    assert any(a.endswith("cot–caught merger") for a in by)
    assert pron["hyphenation"] == "wa‧ter"
    assert pron["rhymes"] == ["-ɔːtə(ɹ)"]
    # The labels of recordings survive in the ZIM; the recordings do not.
    assert pron["audio"] == []


def test_the_french_word_water_on_english_wiktionary():
    fr = lang_of(parsed("en_water", "water", "en"), "fr")
    assert fr["name"] == "French"
    (noun,) = parts(fr)
    assert text(noun["senses"][0]["d"]) == "toilet, bathroom"
    assert fr["pron"]["ipa"][0]["ipa"] == ["/wa.tɛʁ/"]


def test_english_eau_three_languages_and_homophones():
    page = parsed("en_eau", "eau", "en")
    assert [lg["code"] for lg in page["langs"]] == ["en", "bch", "fr"]
    en = lang_of(page, "en")
    assert len(en["groups"]) == 2
    assert "ewe" in [w["w"] for w in en["pron"]["homophones"]]
    fr = lang_of(page, "fr")
    sense = parts(fr)[0]["senses"][0]
    assert ["water", "water#English"] in sense["d"] or any(
        isinstance(s, list) and s[1].startswith("water") for s in sense["d"]
    )
    # An etymology's words lead back: Latin aqua.
    assert any(
        isinstance(s, list) and s[1] == "aqua#Latin" for s in fr["groups"][0]["ety"]
    )


def test_a_page_of_translations_is_kept_by_part_of_speech():
    page = parsed("en_water_translations", "water/translations", "en")
    noun = page["langs"][0]["trans_by"]["noun"]
    first = noun[0]
    assert first["gloss"] == "inorganic compound H₂O"
    by = {i["lang"]: i for i in first["items"]}
    # Linked one directory up: water/translations links ../eau#French.
    assert by["fr"]["words"][0] == {"w": "eau", "t": "eau#French"}
    assert by["de"]["words"][0]["w"] == "Wasser"
    assert by["cmn"]["name"] == "Mandarin" and by["cmn"]["words"][0].get("tr")


# ── English Wiktionary, 2024 (<details>, no language codes on translations) ─


def test_the_2024_build_wrapped_in_details():
    page = parsed("en2024_water", "A/water", "en")
    en = lang_of(page, "en")
    noun, verb = parts(en)
    assert noun["trans_see"] == "A/water/translations#Noun"
    assert "A substance" in text(noun["senses"][0]["d"])
    # Its links are relative to A/: "liquid" is A/liquid, the word liquid.
    assert any(isinstance(s, list) and s[1] == "liquid" for s in noun["senses"][0]["d"])
    # Its translations carry no code: the language is the row's name.
    fr = next(i for t in verb["trans"] for i in t["items"] if i["name"] == "French")
    assert fr["lang"] == "" and fr["words"][0]["w"] == "arroser"
    # Its synonyms are a thesaurus page, which is the wiki's, not a word.
    assert not any(w["t"].startswith("Thesaurus") for x in noun["words"] for w in x["items"])


# ── French Wiktionary (Parsoid, in mwoffliner's shape) ─────────────────────


def test_french_eau():
    page = parsed("fr_eau", "eau", "fr", "wiktionary_fr_all")
    fr = lang_of(page, "fr")
    assert fr["name"] == "Français"
    (noun,) = parts(fr)
    assert noun["pos"] == "Nom commun"
    assert text(noun["senses"][0]["d"]).startswith("Liquide transparent")
    assert noun["senses"][0]["ex"]
    assert fr["pron"]["ipa"][0]["ipa"] == ["\\o\\"]
    # "(Région à préciser)" names no region.
    assert all(r["accent"] != "Région à préciser" for r in fr["pron"]["ipa"])
    t = noun["trans"][0]
    assert t["gloss"] == "Liquide transparent"
    by = {i["lang"]: i for i in t["items"]}
    assert by["de"]["name"] == "Allemand" and by["de"]["words"][0] == {
        "w": "Wasser",
        "t": "Wasser#de",
    }
    assert by["en"]["words"][0]["w"] == "water"
    kinds = {w["kind"] for w in noun["words"]}
    assert {"synonyms", "derived", "related", "homophones"} <= kinds


def test_french_wiktionary_on_the_english_word():
    page = parsed("fr_water", "water", "fr", "wiktionary_fr_all")
    en = lang_of(page, "en")
    assert en["name"] == "Anglais"
    accents = [r["accent"] for r in en["pron"]["ipa"]]
    assert "États-Unis" in accents and "Royaume-Uni" in accents
    assert [p["pos"] for p in parts(en)] == ["Nom commun", "Verbe"]


# ── small Wiktionaries ─────────────────────────────────────────────────────


def test_simple_english_has_no_language_headings():
    page = parsed("simple_water", "water", "en", "wiktionary_en_simple_all")
    (en,) = page["langs"]
    assert en["code"] == "en"
    assert [p["pos"] for p in parts(en)] == ["Noun", "Verb"]
    assert {r["accent"] for r in en["pron"]["ipa"]} == {"UK", "US"}
    assert parts(en)[0]["senses"][0]["syn"][0]["w"] == "dihydrogen monoxide"


def test_maltese_by_its_headword():
    page = parsed("mt_ilma", "ilma", "mt", "wiktionary_mt_all")
    (mt,) = page["langs"]
    assert (mt["code"], mt["name"]) == ("mt", "Malti")
    by = {i["lang"]: i for t in parts(mt)[0]["trans"] for i in t["items"]}
    assert by["en"]["words"][0] == {"w": "water", "t": "water#Ingliż"}


# ── a recording only where the ZIM has one ─────────────────────────────────


def test_a_recording_is_offered_only_when_the_zim_holds_it():
    html = fx.with_audio(fx.page("simple_water")).decode()
    held = {fx.AUDIO_PATH}
    got = dic.parse_page(
        html, "water", "en", "wiktionary_en_simple_all", archive_has=lambda p: p in held
    )
    audio = got["langs"][0]["pron"]["audio"]
    # The US recording is in the ZIM; the UK one is a label with nothing behind it.
    assert audio == [{"label": "Audio (US)", "accent": "US", "path": fx.AUDIO_PATH}]
    assert (
        dic.parse_page(html, "water", "en", "wiktionary_en_simple_all", archive_has=lambda p: False)["langs"][0]["pron"]["audio"]
        == []
    )
    # A link to Commons is not a recording in the library.
    remote = html.replace(fx.AUDIO_PATH, "//upload.wikimedia.org/x/En-us-water.ogg")
    assert (
        dic.parse_page(remote, "water", "en", "wiktionary_en_simple_all", archive_has=lambda p: True)["langs"][
            0
        ]["pron"]["audio"]
        == []
    )


def test_a_real_build_has_labels_and_no_recordings():
    for name, path in (
        ("en_water", "water"),
        ("en2024_water", "A/water"),
        ("en_eau", "eau"),
    ):
        for lg in parsed(name, path, "en", has=lambda p: True)["langs"]:
            assert lg["pron"]["audio"] == []


# ── the library ────────────────────────────────────────────────────────────


@pytest.fixture
def library(tmp_path, monkeypatch):
    zdir = tmp_path / "zims"
    zdir.mkdir()
    fx.build_library(str(zdir))
    monkeypatch.delenv("ZIMI_APPS", raising=False)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    dic._reset_for_tests()
    srv.load_cache(force=True)
    return zdir


def test_the_wiktionaries(library):
    ws = dic.home()["wiktionaries"]
    assert {w["lang"] for w in ws} == {"en", "fr", "mt"} and len(ws) == 4


def test_a_word_across_every_wiktionary(library):
    got = dic.lookup("water", ["en", "fr"], ["English", "French"])
    assert got["found"] and len(got["sources"]) == 3
    groups = {g["code"]: g for g in got["langs"]}
    assert set(groups) == {"en", "fr"}
    # English described by three Wiktionaries, each in its own words.
    en = groups["en"]
    assert set(en["names"].values()) == {"English", "", "Anglais"}
    assert [e["zim"] for e in en["entries"]][0] == "wiktionary"
    simple = next(e for e in en["entries"] if e["zim"] == "wiktionary_en_simple")
    assert simple["pron"]["audio"] == [
        {
            "label": "Audio (US)",
            "accent": "US",
            "path": fx.AUDIO_PATH,
            "zim": "wiktionary_en_simple",
        }
    ]
    # The noun's translations, fetched from water/translations, narrowed to
    # the reader's languages, saying how many there are.
    noun = next(e for e in en["entries"] if e["zim"] == "wiktionary")["groups"][0][
        "parts"
    ][0]
    first = noun["trans"][0]
    assert [i["lang"] for i in first["items"]] == ["fr"] and first["n"] > 5
    every = dic.lookup("water", ["en", "fr"], [], every=True)
    noun = next(e for e in every["langs"][0]["entries"] if e["zim"] == "wiktionary")[
        "groups"
    ][0]["parts"][0]
    assert len(noun["trans"][0]["items"]) == noun["trans"][0]["n"] > 5


def english_noun(got):
    """English Wiktionary's noun "water", wherever the reader's languages put it."""
    en = next(g for g in got["langs"] if g["code"] == "en")
    return next(e for e in en["entries"] if e["zim"] == "wiktionary")["groups"][0]["parts"][0]


def test_a_translation_leads_to_its_word(library):
    water = dic.lookup("water", ["fr"], ["French"])
    noun = english_noun(water)
    target = noun["trans"][0]["items"][0]["words"][0]["t"]
    assert target == "eau#French"
    word, _, section = target.partition("#")
    eau = dic.lookup(word, ["fr"], ["French"])
    french = next(g for g in eau["langs"] if g["code"] == "fr")
    # The French word, as both Wiktionaries describe it, under one heading.
    assert section in french["names"].values()
    assert {e["zim"] for e in french["entries"]} == {"wiktionary", "wiktionary_fr"}


def test_suggestions_and_a_word_nobody_has(library):
    assert dic.suggest("wa")["words"][0] == {
        "w": "water",
        "zims": ["wiktionary", "wiktionary_en_simple", "wiktionary_fr"],
    }
    got = dic.lookup("watr")
    assert not got["found"] and got["langs"] == []


def test_a_kept_page_is_not_changed_by_a_lookup(library):
    dic.lookup("water", ["fr"], [])
    dic.lookup("water", ["de"], [], every=True)
    again = dic.lookup("water", ["fr"], [])
    noun = english_noun(again)
    assert [i["lang"] for i in noun["trans"][0]["items"]] == ["fr"]


# ── through HTTP ───────────────────────────────────────────────────────────


@pytest.fixture
def served(library):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _get(url):
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def test_the_routes(served, monkeypatch):
    status, home = _get(served + "/dictionary/home")
    assert status == 200 and len(home["wiktionaries"]) == 4
    status, got = _get(
        served + "/dictionary/word?w=eau&langs=en,fr&names=English,French"
    )
    assert (
        status == 200
        and got["found"]
        and {g["code"] for g in got["langs"]} >= {"en", "fr"}
    )
    status, got = _get(served + "/dictionary/suggest?q=ea")
    assert status == 200 and got["words"][0]["w"] == "eau"
    assert _get(served + "/dictionary/today?day=19990101") == (
        200,
        {"day": "19990101", "words": []},
    )
    assert _get(served + "/dictionary/nothing")[0] == 404
    # A server that does not offer Dictionary does not answer for it.
    monkeypatch.setenv("ZIMI_APPS", "wiki,books")
    assert _get(served + "/dictionary/home")[0] == 404


def test_the_page_is_served_with_the_shared_parts_inlined(served):
    with urllib.request.urlopen(served + "/static/dictionary.html", timeout=10) as r:
        body = r.read().decode()
    assert "<!--@apps.css@-->" not in body and "function zpath(" in body
    with urllib.request.urlopen(
        served + "/w/wiktionary_en_simple/" + fx.AUDIO_PATH, timeout=10
    ) as r:
        assert r.read().startswith(b"OggS")
