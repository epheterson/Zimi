"""Fixture ZIMs for the release gate: a small library shaped like a real one.

Deliberately NOT under tests/ — the gate is a pre-release step, not part of the
default `pytest tests/` run. It reuses tests/conftest_zim.py's item classes so
there is one definition of "how you write a fixture ZIM" in the repo.

The library it builds:

  wikipedia_en_all_2026-01.zim   Source → en.wikipedia.org, 4 linked articles
  wikipedia_fr_all_2026-01.zim   Source → fr.wikipedia.org, the SAME paths in French
  survival_en_2026-06.zim        a second source so cross-source search is real
  field-guides/mushrooms_en_2026-01.zim   a subfolder, for folder→category

The two wikipedia editions share article paths on purpose: that is what the
language switcher matches on when a ZIM carries no Wikidata Q-ID index. Articles
are kept under 2 KB so Q-ID extraction is skipped and the title path is what
gets exercised.
"""

import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _REPO_ROOT)

from tests.conftest_zim import _Article, build_fixture_zim  # noqa: E402

#: Article paths present in BOTH language editions — the language switcher's
#: match key, and the set the cross-ZIM link tests resolve against.
SHARED_WIKI_PATHS = (
    "A/Water_purification",
    "A/Fire",
    "A/Boiling",
    "A/Chlorine_(disinfectant)",
)

WIKI_EN = "wikipedia_en_all_2026-01.zim"
WIKI_FR = "wikipedia_fr_all_2026-01.zim"
SURVIVAL = "survival_en_2026-06.zim"
MUSHROOMS = os.path.join("field-guides", "mushrooms_en_2026-01.zim")

#: ZIM short names as the server derives them from those filenames (the
#: language and date tokens, and a trailing _all, are stripped).
WIKI_EN_NAME = "wikipedia"
WIKI_FR_NAME = "wikipedia_fr"
SURVIVAL_NAME = "survival"
MUSHROOMS_NAME = "mushrooms"
MUSHROOMS_FOLDER = "field-guides"
MUSHROOMS_CATEGORY = "Field Guides"

_EN_BODY = {
    "A/Water_purification": (
        b"<html><head><title>Water purification</title></head><body>"
        b"<h1>Water purification</h1><p>Making water safe to drink. See "
        b"<a href='Fire'>Fire</a>, <a href='../A/Boiling'>Boiling</a> and "
        b"<a href='Chlorine_(disinfectant)'>Chlorine</a>.</p></body></html>"
    ),
    "A/Fire": b"<html><body><h1>Fire</h1><p>Combustion for heat.</p></body></html>",
    "A/Boiling": b"<html><body><h1>Boiling</h1><p>Water at 100 C.</p></body></html>",
    "A/Chlorine_(disinfectant)": (
        b"<html><body><h1>Chlorine</h1><p>A water disinfectant.</p></body></html>"
    ),
}

_FR_BODY = {
    "A/Water_purification": (
        b"<html><head><title>Purification de l'eau</title></head><body>"
        b"<h1>Purification de l'eau</h1><p>Rendre l'eau potable.</p></body></html>"
    ),
    "A/Fire": b"<html><body><h1>Feu</h1><p>La combustion.</p></body></html>",
    "A/Boiling": b"<html><body><h1>Ebullition</h1><p>L'eau a 100 C.</p></body></html>",
    "A/Chlorine_(disinfectant)": (
        b"<html><body><h1>Chlore</h1><p>Un desinfectant.</p></body></html>"
    ),
}

_EN_TITLES = {
    "A/Water_purification": "Water purification",
    "A/Fire": "Fire",
    "A/Boiling": "Boiling",
    "A/Chlorine_(disinfectant)": "Chlorine (disinfectant)",
}

_FR_TITLES = {
    "A/Water_purification": "Purification de l'eau",
    "A/Fire": "Feu",
    "A/Boiling": "Ebullition",
    "A/Chlorine_(disinfectant)": "Chlore",
}


def _build_wiki_edition(path, lang_iso3, index_lang, source_url, bodies, titles, title):
    """A wikipedia-shaped ZIM whose Source metadata puts it on a real host."""
    from libzim.writer import Creator

    with Creator(path).config_indexing(True, index_lang) as creator:
        creator.set_mainpath(SHARED_WIKI_PATHS[0])
        for entry_path in SHARED_WIKI_PATHS:
            creator.add_item(
                _Article(entry_path, titles[entry_path], bodies[entry_path])
            )
        creator.add_metadata("Title", title)
        creator.add_metadata("Language", lang_iso3)
        creator.add_metadata("Description", "release gate fixture")
        creator.add_metadata("Source", source_url)
    return path


def build_gate_library(zim_dir):
    """Write the whole fixture library into `zim_dir`; return {label: path}."""
    os.makedirs(os.path.join(zim_dir, "field-guides"), exist_ok=True)
    paths = {
        "wiki_en": os.path.join(zim_dir, WIKI_EN),
        "wiki_fr": os.path.join(zim_dir, WIKI_FR),
        "survival": os.path.join(zim_dir, SURVIVAL),
        "mushrooms": os.path.join(zim_dir, MUSHROOMS),
    }
    _build_wiki_edition(
        paths["wiki_en"],
        "eng",
        "eng",
        "https://en.wikipedia.org/",
        _EN_BODY,
        _EN_TITLES,
        "Test Wikipedia (en)",
    )
    _build_wiki_edition(
        paths["wiki_fr"],
        "fra",
        "fra",
        "https://fr.wikipedia.org/",
        _FR_BODY,
        _FR_TITLES,
        "Test Wikipedia (fr)",
    )
    build_fixture_zim(paths["survival"])
    build_fixture_zim(paths["mushrooms"])
    return paths


def build_source_folder(root):
    """A small folder of documents for `zimi create --mode folder` to convert."""
    os.makedirs(root, exist_ok=True)
    files = {
        "index.html": (
            "<html><head><title>Field notes</title></head><body>"
            "<h1>Field notes</h1><p>Notes from the field. "
            "<a href='boiling.html'>Boiling</a></p></body></html>"
        ),
        "boiling.html": (
            "<html><head><title>Boiling</title></head><body>"
            "<h1>Boiling</h1><p>Bring water to a rolling boil for one minute."
            "</p></body></html>"
        ),
        "notes.txt": "Carry a filter. Boil when in doubt.\n",
    }
    for name, body in files.items():
        with open(os.path.join(root, name), "w", encoding="utf-8") as f:
            f.write(body)
    return root
