"""Pages for the lean MCP tests, shaped like the scrapers' own.

WIKI is cut down from mwoffliner's Wikipedia (Parsoid sections, the
mw-heading wrappers, a taxobox, footnote marks, MathML with its TeX
annotation and fallback image, a navbox, the reference list). DEVDOCS is
devdocs' page shell around an article. The Stack Exchange question is
sotoki_fixture.QUESTION. build() writes the three as real ZIMs.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import _Article  # noqa: E402
from libzim.writer import Creator  # noqa: E402
from sotoki_fixture import QUESTION  # noqa: E402


# Filler so the page is long enough to come back as an outline. Each
# paragraph names its section, so a test can tell which one it got.
def _filler(name, n=40):
    return "".join(
        f"<p>{name} paragraph {i}: water moves through the cycle by "
        "evaporation, condensation, precipitation and runoff, "
        "and every stage of it carries heat from one place to another.</p>"
        for i in range(n)
    )


WIKI = (
    "<!DOCTYPE html><html><head><title>Water</title>"
    "<style>.mw-parser-output .hatnote{font-style:italic}</style>"
    '<script>var x = "chrome";</script></head>'
    '<body class="mediawiki"><div class="mw-page-container">'
    '<header class="mw-body-header"><h1 id="firstHeading">Water</h1></header>'
    '<nav id="toc">Contents: History, Chemistry</nav>'
    '<div id="mw-content-text"><div class="mw-parser-output">'
    '<section data-mw-section-id="0">'
    '<div class="hatnote navigation-not-searchable">For other uses, see Water (disambiguation).</div>'
    '<table class="infobox"><tbody>'
    '<tr><th colspan="2">Water</th></tr>'
    '<tr><td colspan="2"><img src="./_assets_/w.jpg" alt="A glass"></td></tr>'
    "<tr><th>Formula</th><td>H<sub>2</sub>O</td></tr>"
    "<tr><td>Boiling point:</td><td>100 °C<br>212 °F</td></tr>"
    "</tbody></table>"
    '<p><b>Water</b> is an <a rel="mw:WikiLink" href="Inorganic_compound">inorganic compound</a>'
    ' with the chemical formula H<sub>2</sub>O.<sup class="mw-ref reference" id="cite_ref-1">'
    '<a href="#cite_note-1"><span class="cite-bracket">[</span>1<span class="cite-bracket">]</span></a></sup>'
    " It is <i>transparent</i> and nearly colorless.</p>"
    '<p>Its density follows <span class="mwe-math-element"><span class="mwe-math-mathml-inline mwe-math-mathml-a11y" style="display: none;">'
    '<math alttext="{\\displaystyle \\rho =m/V}"><semantics><mrow><mi>ρ</mi></mrow>'
    '<annotation encoding="application/x-tex">{\\displaystyle \\rho =m/V}</annotation></semantics></math></span>'
    '<img src="./_assets_/m.svg" class="mwe-math-fallback-image-inline" alt="{\\displaystyle \\rho =m/V}"></span>'
    " at room temperature.</p>"
    '<figure typeof="mw:File/Thumb"><a href="File:Drop.jpg"><img src="./_assets_/d.jpg"></a>'
    "<figcaption>A water drop hitting a surface</figcaption></figure>"
    "</section>"
    '<section data-mw-section-id="1"><div class="mw-heading mw-heading2"><h2 id="History">History</h2>'
    '<span class="mw-editsection"><a href="edit">edit</a></span></div>'
    + _filler("History")
    + '<section data-mw-section-id="2"><div class="mw-heading mw-heading3"><h3 id="Ancient_uses">Ancient uses</h3></div>'
    "<ul><li>Irrigation<ul><li>Canals</li></ul></li><li>Drinking</li></ul>"
    "</section></section>"
    '<section data-mw-section-id="3"><div class="mw-heading mw-heading2"><h2 id="Chemistry">Chemistry</h2></div>'
    + _filler("Chemistry")
    + '<div class="mwe-math-element"><span class="mwe-math-mathml-display mwe-math-mathml-a11y" style="display: none;">'
    '<math display="block"><semantics><mrow></mrow><annotation encoding="application/x-tex">{\\displaystyle 2H_{2}+O_{2}\\to 2H_{2}O}</annotation></semantics></math></span></div>'
    '<table class="wikitable"><caption>Phases</caption><tbody>'
    "<tr><th>Phase</th><th>Range</th></tr>"
    "<tr><td>Ice</td><td>below 0 °C</td></tr>"
    "<tr><td>Liquid | water</td><td>0–100 °C</td></tr>"
    "</tbody></table>"
    '<pre class="lang-python">print("H2O")\nprint("done")</pre>'
    "</section>"
    '<section data-mw-section-id="4"><div class="mw-heading mw-heading2"><h2 id="References">References</h2></div>'
    '<div class="mw-references-wrap"><ol class="references"><li id="cite_note-1">'
    '<span class="mw-cite-backlink">^</span> <span class="reference-text">Greenwood, <i>Chemistry of the Elements</i>, 1997.</span></li></ol></div>'
    "</section>"
    '<div class="navbox" role="navigation">Navbox: Oxygen compounds</div>'
    "</div></div></div>"
    "<footer>This article is issued from Wikipedia.</footer>"
    "</body></html>"
)

# mwoffliner's pointer into another page's section.
STUB = (
    "<html><head><title>Uses of water</title>"
    '<meta http-equiv="refresh" content="0;URL=\'./Water#Ancient_uses\'" />'
    '</head><body><a href="./Water#Ancient_uses">Uses of water</a></body></html>'
)

DEVDOCS = (
    '<html class="_theme-default"><head><meta charset="utf-8"><title>Lit Documentation</title></head>'
    '<body><div class="_app"><devdocs-navbar current="index"></devdocs-navbar>'
    '<div class="_container"><main class="_content"><div class="_page _lit"><article>'
    "<h1>What is Lit?</h1>"
    "<p>Lit is a simple library for building fast, lightweight <strong>web components</strong>.</p>"
    '<div class="heading h2"><h2 id="install">Install</h2></div>'
    "<p>Use <code>npm i lit</code> to add it.</p>"
    "<pre data-language=\"javascript\">import {LitElement} from 'lit';\nclass MyEl extends LitElement {}</pre>"
    "</article></div></main></div></div></body></html>"
)

QUESTION_PATH = "questions/567/how-can-i-chop-onions-without-crying"


def build(directory):
    """Three ZIMs in ``directory``: a wiki, a Stack Exchange site, devdocs."""
    os.makedirs(directory, exist_ok=True)
    zims = {
        "wikipedia_en_test_2026-01.zim": (
            "Water",
            [
                ("Water", "Water", WIKI),
                ("Uses_of_water", "Uses of water", STUB),
            ],
            {"Title": "Wikipedia", "Scraper": "mwoffliner 1.14"},
        ),
        "cooking.stackexchange.com_en_all_2026-01.zim": (
            QUESTION_PATH,
            [(QUESTION_PATH, "How can I chop onions without crying?", QUESTION)],
            {"Title": "Cooking", "Scraper": "sotoki 2.1"},
        ),
        "devdocs_en_lit_2026-01.zim": (
            "index",
            [("index", "What is Lit?", DEVDOCS)],
            {"Title": "Lit", "Scraper": "devdocs2zim"},
        ),
    }
    for filename, (main, pages, meta) in zims.items():
        with Creator(os.path.join(directory, filename)).config_indexing(
            True, "eng"
        ) as creator:
            creator.set_mainpath(main)
            for path, title, html in pages:
                creator.add_item(_Article(path, title, html.encode("utf-8")))
            for key, value in dict(meta, Language="eng", Description="fixture").items():
                creator.add_metadata(key, value)
    return directory
