"""Wiktionary ZIMs for Dictionary, made from real pages.

tests/fixtures/dictionary/ holds pages read out of Kiwix's own builds on
Eric's NAS (wiktionary_en_all_nopic_2026-02: water, water/translations, eau;
wiktionary_en_all_maxi_2024-05: water; wiktionary_en_simple_all_nopic_2026-04:
water; wiktionary_mt_all_nopic_2026-07: ilma) and French Wiktionary's
Parsoid HTML for eau and water put in mwoffliner's shape (sections unwrapped
into div.mw-heading, links made relative, the audio taken out as mwoffliner
takes it out), each cut down to a few languages, a dozen of each list and a
handful of translations. The markup is the pages' own.

No Wiktionary ZIM Kiwix publishes carries a recording: the English maxi
build of 2024 has 8.2 million entries and no audio file, every audio table's
file cell an empty span. ``with_audio`` gives Simple English's "water" one,
in the shape a build that kept them would have, so a recording is offered
where there is one and nowhere else.
"""

import gzip
import os

from libzim.writer import Creator

from wiki_fixture import _Page

HERE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fixtures", "dictionary"
)
MW = "mwoffliner 1.17.5"
# An Ogg page header, enough to be what it says it is.
OGG = b"OggS\x00\x02" + b"\x00" * 58
AUDIO_PATH = "-/En-us-water.ogg"


def page(name):
    with gzip.open(os.path.join(HERE, name + ".html.gz"), "rb") as f:
        return f.read()


def with_audio(html):
    """Simple English's "water", its US recording kept in the ZIM."""
    us = b'<td class="unicode audiolink">Audio (US)</td><td class="audiofile">'
    assert us in html
    return html.replace(
        us,
        us
        + b'<audio controls="" preload="none"><source src="'
        + AUDIO_PATH.encode()
        + b'" type="audio/ogg"></audio>',
        1,
    )


def _front(title):
    return (
        '<html><body><div class="mw-parser-output"><p>%s</p></div></body></html>'
        % title
    ).encode()


# French words with one sense each: enough for the front's More words.
MORE_FR = [
    ("feu", "Dégagement de chaleur et de lumière."),
    ("terre", "Planète où vivent les humains."),
    ("lune", "Satellite naturel de la Terre."),
    ("soleil", "Étoile autour de laquelle tourne la Terre."),
    ("pierre", "Matière minérale dure et solide."),
    ("arbre", "Grande plante ligneuse à tronc."),
    ("vent", "Mouvement naturel de l’air."),
    ("neige", "Eau congelée qui tombe en flocons."),
    ("fleur", "Partie colorée d’une plante."),
    ("nuage", "Amas de gouttelettes en suspension."),
]


def _sense(definition):
    return (
        '<html lang="fr"><body><div class="mw-parser-output"><h2 id="Français">'
        "Français</h2><h3>Nom commun</h3><ol><li>%s</li></ol></div></body></html>"
        % definition
    ).encode()


def _zim(path, meta, pages, main):
    with Creator(path).config_indexing(True, meta.get("Language", "eng")) as c:
        c.set_mainpath(main)
        for p, title, blob, *mime in pages:
            c.add_item(_Page(p, title, blob, *(mime or ["text/html"])))
        for k, v in meta.items():
            c.add_metadata(k, v)


EN = "wiktionary_en_all_nopic_2026-02.zim"
FR = "wiktionary_fr_all_nopic_2026-01.zim"
SIMPLE = "wiktionary_en_simple_all_nopic_2026-04.zim"
MT = "wiktionary_mt_all_nopic_2026-07.zim"


def build_library(zdir):
    _zim(
        os.path.join(zdir, EN),
        {
            "Scraper": MW,
            "Name": "wiktionary_en_all",
            "Language": "eng",
            "Title": "Wiktionary",
            "Description": "English Wiktionary",
        },
        [
            ("Wiktionary:Main_Page", "Wiktionary:Main Page", _front("Wiktionary")),
            ("water", "water", page("en_water")),
            ("water/translations", "water/translations", page("en_water_translations")),
            ("eau", "eau", page("en_eau")),
        ],
        "Wiktionary:Main_Page",
    )
    _zim(
        os.path.join(zdir, FR),
        {
            "Scraper": MW,
            "Name": "wiktionary_fr_all",
            "Language": "fra",
            "Title": "Wiktionnaire",
            "Description": "Wiktionnaire",
        },
        [
            (
                "Wiktionnaire:Page_d’accueil",
                "Wiktionnaire:Page d’accueil",
                _front("Wiktionnaire"),
            ),
            ("eau", "eau", page("fr_eau")),
            ("water", "water", page("fr_water")),
        ]
        + [(w, w, _sense(d)) for w, d in MORE_FR],
        "Wiktionnaire:Page_d’accueil",
    )
    _zim(
        os.path.join(zdir, SIMPLE),
        {
            "Scraper": MW,
            "Name": "wiktionary_en_simple_all",
            "Language": "eng",
            "Title": "Simple English Wiktionary",
            "Description": "Simple",
        },
        [
            ("Main_Page", "Main Page", _front("Simple English Wiktionary")),
            ("water", "water", with_audio(page("simple_water"))),
            (AUDIO_PATH, "En-us-water.ogg", OGG, "audio/ogg"),
        ],
        "Main_Page",
    )
    _zim(
        os.path.join(zdir, MT),
        {
            "Scraper": MW,
            "Name": "wiktionary_mt_all",
            "Language": "mlt",
            "Title": "Wikizzjunarju",
            "Description": "Wikizzjunarju",
        },
        [
            ("Il-Paġna_prinċipali", "Il-Paġna prinċipali", _front("Wikizzjunarju")),
            ("ilma", "ilma", page("mt_ilma")),
        ],
        "Il-Paġna_prinċipali",
    )
    return zdir
