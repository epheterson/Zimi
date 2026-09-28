"""mwoffliner-shaped wikis for Zimipedia's reader: a Wikipedia in English
(full, with an infobox, citations and sister links), the same article in an
English mini with no Q-ID or references, in Simple English and in Hebrew,
and the sister wikis it points to. The pages are cut down from Kiwix's own
builds (Parsoid HTML: <section>s, div.mw-heading > h2, sup.mw-ref, an
ol.mw-references), which is what mwoffliner 1.17 and 2.0 write.

build_library(zdir) writes the ZIMs; the Wikipedias' Q-ID indexes are built
by the caller (index_wikipedias) as the server does at start.
"""

import os
import zlib

from conftest_zim import _StringProvider
from libzim.writer import Creator, Hint, Item

MW = "mwoffliner 1.17.5"
EINSTEIN_QID = "Q937"


class _Page(Item):
    def __init__(self, path, title, blob, mime="text/html"):
        super().__init__()
        self.path, self.title, self.blob, self.mime = path, title, blob, mime

    def get_path(self):
        return self.path

    def get_title(self):
        return self.title

    def get_mimetype(self):
        return self.mime

    def get_contentprovider(self):
        return _StringProvider(self.blob)

    def get_hints(self):
        return {Hint.FRONT_ARTICLE: self.mime == "text/html"}


def _png(w, h):
    """A plain PNG, w x h, one colour."""
    import struct

    def chunk(kind, data):
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + b"\xc8\x9c\x6a" * w for _ in range(h))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def page(title, body, lang="en", rtl=False, short=""):
    d = "rtl" if rtl else "ltr"
    return (
        '<!DOCTYPE html><html lang="%s" dir="%s"><head><meta charset="UTF-8"><title>%s</title></head>'
        '<body class="mediawiki %s"><div class="mw-page-container"><main id="content" class="mw-body">'
        '<header class="mw-body-header vector-page-titlebar"><h1 id="firstHeading" class="firstHeading mw-first-heading">'
        '<span class="mw-page-title-main">%s</span></h1></header>'
        '<div id="bodyContent" class="vector-body"><div id="mw-content-text" class="mw-body-content" lang="%s" dir="%s">'
        '<div class="mw-parser-output" lang="%s" dir="%s">%s%s</div></div></div></main></div></body></html>'
        % (
            lang,
            d,
            title,
            d,
            title,
            lang,
            d,
            lang,
            d,
            (
                (
                    '<div class="shortdescription nomobile noexcerpt noprint searchaux" style="display:none">%s</div>'
                    % short
                )
                if short
                else ""
            ),
            body,
        )
    ).encode("utf-8")


def cite(n):
    return (
        '<sup class="mw-ref reference" id="cite_ref-%d" rel="dc:references" typeof="mw:Extension/ref">'
        '<a href="#cite_note-%d"><span class="mw-reflink-text"><span class="cite-bracket">[</span>%d'
        '<span class="cite-bracket">]</span></span></a></sup>' % (n, n, n)
    )


def section(i, level, hid, text, body):
    return (
        '<section data-mw-section-id="%d"><div class="mw-heading mw-heading%d"><h%d id="%s">%s</h%d></div>%s</section>'
        % (i, level, level, hid, text, level, body)
    )


FILLER = " ".join(
    ["The theory changed how physics describes space, time and gravity."] * 14
)

INFOBOX = (
    '<table class="infobox biography vcard"><tbody><tr><th colspan="2" class="infobox-above">Albert Einstein</th></tr>'
    '<tr><td colspan="2" class="infobox-image"><span typeof="mw:File"><a href="./File:Einstein_1921.png" class="mw-file-description">'
    '<img src="./I/Einstein_1921.png" width="220" height="280" alt="Einstein in 1921"></a></span>'
    '<div class="infobox-caption">Einstein in 1921</div></td></tr>'
    '<tr><th scope="row" class="infobox-label">Born</th><td class="infobox-data">14 March 1879<br><a href="./Ulm">Ulm</a></td></tr>'
    '<tr><th scope="row" class="infobox-label">Died</th><td class="infobox-data">18 April 1955</td></tr>'
    '<tr><th scope="row" class="infobox-label">Fields</th><td class="infobox-data"><a href="./Physics">Physics</a></td></tr>'
    "</tbody></table>"
)
SISTERS = (
    '<div class="side-box side-box-right sistersitebox"><div class="side-box-text plainlist">Wikiquote has quotations related to: '
    '<i><b><a rel="mw:WikiLink/Interwiki" href="https://en.wikiquote.org/wiki/Albert_Einstein" class="extiw external">Albert Einstein</a></b></i></div></div>'
    '<div class="side-box side-box-right sistersitebox"><div class="side-box-text plainlist">Wikisource has original works by or about: '
    '<i><b><a rel="mw:WikiLink/Interwiki" href="https://en.wikisource.org/wiki/Author:Albert_Einstein" class="extiw external">Albert Einstein</a></b></i></div></div>'
)
REFS = (
    '<div class="mw-references-wrap"><ol class="mw-references references">'
    + "".join(
        '<li id="cite_note-%d"><span class="mw-cite-backlink"><a href="#cite_ref-%d">↑</a></span> '
        '<span id="mw-reference-text-cite_note-%d" class="mw-reference-text reference-text">Source number %d: '
        "<i>Annalen der Physik</i>, %d.</span></li>" % (n, n, n, n, 1900 + n)
        for n in (1, 2, 3)
    )
    + "</ol></div>"
)
AUTHORITY = (
    '<div class="navbox authority-control"><a href="https://www.wikidata.org/wiki/%s#identifiers">Wikidata</a></div>'
    % EINSTEIN_QID
)

EINSTEIN = page(
    "Albert Einstein",
    '<section data-mw-section-id="0">'
    + INFOBOX
    + "<p><b>Albert Einstein</b> was a German-born theoretical physicist who developed the theory of relativity.%s "
    'He is best known for his work on <a rel="mw:WikiLink" href="./Physics" title="Physics">physics</a> and for the '
    'equation linking mass and <a rel="mw:WikiLink" href="./Energy" title="Energy">energy</a>.%s</p>'
    "<p>He received the Nobel Prize in Physics in 1921.%s</p></section>"
    % (cite(1), cite(2), cite(3))
    + section(1, 2, "Life", "Life", "<p>%s</p>" % FILLER)
    + section(2, 3, "Early_life", "Early life", "<p>%s</p>" % FILLER)
    + section(3, 2, "Relativity", "Relativity", "<p>%s</p><p>%s</p>" % (FILLER, FILLER))
    + section(4, 2, "Legacy", "Legacy", "<p>%s</p>" % FILLER)
    + section(5, 2, "Other_websites", "Other websites", SISTERS)
    + section(6, 2, "References", "References", REFS)
    + AUTHORITY,
    short="German-born physicist (1879 to 1955)",
)
PHYSICS = page(
    "Physics",
    '<section data-mw-section-id="0"><p><b>Physics</b> is the science of matter, energy, space and time. '
    'It studies how the <a href="./Albert_Einstein">universe</a> behaves.</p></section>',
)
ENERGY = page(
    "Energy",
    '<section data-mw-section-id="0"><p><b>Energy</b> is the ability to do work.</p></section>',
)
MAIN = page("Main Page", "<p>Welcome to Wikipedia.</p>")

MINI_EINSTEIN = page(
    "Albert Einstein",
    '<section data-mw-section-id="0"><p><b>Albert Einstein</b> was a German-born theoretical physicist.%s '
    "He developed the theory of relativity, one of the two pillars of modern physics, and is best known "
    "for the mass and energy equivalence formula. He received the 1921 Nobel Prize in Physics.</p></section>"
    % cite(1),
)
SIMPLE_EINSTEIN = page(
    "Albert Einstein",
    '<section data-mw-section-id="0"><p><b>Albert Einstein</b> was a scientist who worked on physics.</p></section>'
    + section(1, 2, "Life", "Life", "<p>He was born in Germany.</p>")
    + AUTHORITY,
)
HE_TITLE = "אלברט_איינשטיין"
HE_EINSTEIN = page(
    "אלברט איינשטיין",
    '<section data-mw-section-id="0"><p><b>אלברט איינשטיין</b> היה פיזיקאי תאורטי יהודי יליד גרמניה.%s</p></section>'
    % cite(1)
    + section(
        1, 2, "חייו", "חייו", "<p>%s</p>" % ("איינשטיין נולד באולם שבגרמניה. " * 30)
    )
    + section(
        2,
        2,
        "הערות_שוליים",
        "הערות שוליים",
        '<ol class="mw-references references"><li id="cite_note-1"><span class="mw-reference-text">מקור ראשון.</span></li></ol>',
    )
    + AUTHORITY,
    lang="he",
    rtl=True,
)


def _zim(path, name, lang, title, pages, main):
    with Creator(path).config_indexing(True, lang) as cr:
        cr.set_mainpath(main)
        for p, t, blob, mime in pages:
            cr.add_item(_Page(p, t, blob, mime))
        for k, v in {
            "Scraper": MW,
            "Name": name,
            "Language": lang,
            "Title": title,
            "Description": title,
            "Date": "2026-09-01",
            "Creator": "Wikipedia",
        }.items():
            cr.add_metadata(k, v)


def build_library(zdir):
    """Write the wikis into zdir. Their names in the library: wikipedia,
    wikipedia_en (the mini), wikipedia_en_simple, wikipedia_he, wikiquote,
    wiktionary, wikisource."""
    os.makedirs(zdir, exist_ok=True)
    img = _png(22, 28)
    H = "text/html"
    _zim(
        os.path.join(zdir, "wikipedia_en_all_maxi_2026-08.zim"),
        "wikipedia_en_all",
        "eng",
        "Wikipedia",
        [
            ("Main_Page", "Main Page", MAIN, H),
            ("Albert_Einstein", "Albert Einstein", EINSTEIN, H),
            ("Physics", "Physics", PHYSICS, H),
            ("Energy", "Energy", ENERGY, H),
            ("I/Einstein_1921.png", "", img, "image/png"),
        ],
        "Main_Page",
    )
    _zim(
        os.path.join(zdir, "wikipedia_en_top_mini_2026-09.zim"),
        "wikipedia_en_top",
        "eng",
        "Best of Wikipedia",
        [
            ("Main_Page", "Main Page", MAIN, H),
            ("Albert_Einstein", "Albert Einstein", MINI_EINSTEIN, H),
        ],
        "Main_Page",
    )
    _zim(
        os.path.join(zdir, "wikipedia_en_simple_all_nopic_2026-05.zim"),
        "wikipedia_en_simple_all",
        "eng",
        "Simple English Wikipedia",
        [
            ("Main_Page", "Main Page", MAIN, H),
            ("Albert_Einstein", "Albert Einstein", SIMPLE_EINSTEIN, H),
        ],
        "Main_Page",
    )
    _zim(
        os.path.join(zdir, "wikipedia_he_all_nopic_2026-04.zim"),
        "wikipedia_he_all",
        "heb",
        "ויקיפדיה",
        [
            ("Main_Page", "Main Page", MAIN, H),
            (HE_TITLE, "אלברט איינשטיין", HE_EINSTEIN, H),
        ],
        "Main_Page",
    )
    _zim(
        os.path.join(zdir, "wikiquote_en_all_nopic_2026-07.zim"),
        "wikiquote_en_all",
        "eng",
        "Wikiquote",
        [
            ("Main_Page", "Main Page", MAIN, H),
            (
                "Albert_Einstein",
                "Albert Einstein",
                page(
                    "Albert Einstein",
                    "<ul><li>Imagination is more important than knowledge.</li></ul>",
                ),
                H,
            ),
        ],
        "Main_Page",
    )
    _zim(
        os.path.join(zdir, "wiktionary_en_all_nopic_2026-07.zim"),
        "wiktionary_en_all",
        "eng",
        "Wiktionary",
        [
            ("Main_Page", "Main Page", MAIN, H),
            (
                "physics",
                "physics",
                page(
                    "physics",
                    "<h2>English</h2><ol><li>The science of matter and energy.</li></ol>",
                ),
                H,
            ),
        ],
        "Main_Page",
    )
    _zim(
        os.path.join(zdir, "wikisource_en_all_nopic_2026-07.zim"),
        "wikisource_en_all",
        "eng",
        "Wikisource",
        [
            ("Main_Page", "Main Page", MAIN, H),
            (
                "Author:Albert_Einstein",
                "Author:Albert Einstein",
                page("Author:Albert Einstein", "<p>Works.</p>"),
                H,
            ),
        ],
        "Main_Page",
    )


def index_wikipedias():
    """Build the Wikipedias' Q-ID indexes, as the server does at start."""
    import zimi.server as srv
    from zimi import interlang

    for name, path in srv.get_zim_files().items():
        if interlang._zim_project_name(name) == "wikipedia":
            interlang._build_qid_index(name, path)

