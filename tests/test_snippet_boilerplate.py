"""Tests for snippet boilerplate-skip (previews.extract_snippet).

iFixit device pages bake one repeated <meta description> (a featured-guide
blurb) into every page. extract_snippet must prefer the page's own summary
block over that boilerplate, without regressing ZIM types whose meta
description IS the right snippet (wikipedia/gutenberg/ted-style).

Fixtures are trimmed to the load-bearing structure of the real iFixit ZIM
markup fetched from the NAS (banner-blurb / itemprop="description" span, with
the wrong SSD meta description in <head>).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi.previews import extract_snippet  # noqa: E402

# Real iFixit device-page shape (trimmed). The <meta description> is the
# repeated featured-guide boilerplate; the banner-blurb span is the truth.
IFIXIT_AMERIWATER = """<!DOCTYPE html><html><head>
<title>AmeriWater Water Purification System</title>
<meta name="description" content="How to replace or upgrade the SSD in your Lenovo Legion Y530-15ICH.">
</head><body>
<div class="banner-bucket banner-summary"><div class="banner-text">
<h1 class="banner-title">AmeriWater Water Purification System</h1>
<p class="banner-blurb">
  <span class="topicHeaderText originalText" itemprop="description">
    Water Purification System is a Sterilization manufactured by AmeriWater. Model numbers 00HC-2015, 00HC-2045.</span>
</p></div></div>
</body></html>"""

IFIXIT_ACER = """<!DOCTYPE html><html><head>
<title>Acer Aspire 5253</title>
<meta name="description" content="How to replace or upgrade the SSD in your Lenovo Legion Y530-15ICH.">
</head><body>
<p class="banner-blurb"><span itemprop="description">
A general purpose laptop released in 2010 with a 15.6&#34; screen.</span></p>
</body></html>"""


def test_ifixit_prefers_device_blurb_over_boilerplate_meta():
    snip = extract_snippet(IFIXIT_AMERIWATER, "ifixit")
    assert "AmeriWater" in snip
    assert "SSD" not in snip
    assert "Lenovo" not in snip


def test_ifixit_second_device_also_correct():
    snip = extract_snippet(IFIXIT_ACER, "ifixit")
    assert snip.startswith("A general purpose laptop")
    assert "SSD" not in snip


def test_itemprop_description_used_without_banner_class():
    html = """<head><meta name="description" content="How to replace the SSD in your Lenovo Legion.">
    </head><body><span itemprop="description">A widget that does a specific useful thing.</span></body>"""
    snip = extract_snippet(html, "ifixit")
    assert snip == "A widget that does a specific useful thing."


# ── Regressions: meta description must still win where it's the right source ──


def test_wikipedia_meta_description_still_used():
    html = """<head><meta name="description"
    content="Paris is the capital and most populous city of France."></head>
    <body><p>Paris (French pronunciation) is the capital of France.</p></body>"""
    snip = extract_snippet(html, "wikipedia_en_all")
    assert snip == "Paris is the capital and most populous city of France."


def test_og_description_variant_used():
    html = """<head><meta content="A talk about the future of biology and life."
    property="og:description"></head><body></body>"""
    snip = extract_snippet(html, "ted_en")
    assert snip == "A talk about the future of biology and life."


def test_gutenberg_meta_description_used():
    html = """<head><meta name="description"
    content="Pride and Prejudice by Jane Austen — a classic novel of manners."></head>
    <body></body>"""
    snip = extract_snippet(html, "gutenberg_en")
    assert "Pride and Prejudice" in snip


def test_no_meta_falls_back_to_main_body_skipping_nav():
    html = """<head></head><body>
    <nav>Home | About | Contact | Menu | Search the site here</nav>
    <main>The genuine article prose starts here and runs on with real content words.</main>
    </body>"""
    snip = extract_snippet(html, "generic")
    assert snip.startswith("The genuine article prose")
    assert "Home" not in snip


def test_toc_boilerplate_stripped_from_body_fallback():
    html = """<head></head><body>
    <div class="js-dynamic-toc-section">Table of contents Introduction Steps Comments</div>
    <article>Actual body content that should become the snippet text here.</article>
    </body>"""
    snip = extract_snippet(html, "ifixit")
    assert snip.startswith("Actual body content")
    assert "Table of contents" not in snip


def test_short_own_summary_ignored():
    """A too-short blurb (<20 chars) should not pre-empt a good meta desc."""
    html = """<head><meta name="description" content="A properly detailed description of the subject matter here."></head>
    <body><p class="banner-blurb"><span itemprop="description">Hi</span></p></body>"""
    snip = extract_snippet(html, "ifixit")
    assert snip.startswith("A properly detailed description")


def test_empty_html_returns_empty_string():
    assert extract_snippet("", "x") == ""


# A Wikipedia article as mwoffliner writes it: no <meta description>, an
# infobox table before the lead, citation markers in the lead.
WIKIPEDIA_NO_META = """<!DOCTYPE html><html><head><title>Albert Einstein</title></head><body>
<div class="hatnote">"Einstein" redirects here. For other uses, see Einstein (disambiguation).</div>
<table class="infobox biography vcard"><tbody><tr><th scope="row" class="infobox-label">Born</th>
<td class="infobox-data">14 March 1879<br><div class="birthplace"><a rel="mw:WikiLink" href="Ulm" title="Ulm">Ulm</a>,
Kingdom of Wurttemberg</div></td></tr></tbody></table>
<p></p>
<p><b>Albert Einstein</b><sup class="mw-ref reference"><a href="#cite_note-1">[a]</a></sup> (14 March 1879 - 18 April 1955)
was a German-born theoretical physicist best known for developing the theory of relativity.</p>
<p>Born as a subject to the Kingdom of Wurttemberg, Einstein moved to Switzerland in 1895.</p>
</body></html>"""


def test_a_wikipedia_article_without_meta_gives_its_lead_sentence():
    """Found on the NAS: the snippet was infobox debris ending in a raw tag,
    '14 March 1879 <a rel="mw:WikiLink" href="Ulm" t'."""
    snip = extract_snippet(WIKIPEDIA_NO_META, "wikipedia")
    assert snip.startswith("Albert Einstein (14 March 1879"), snip
    assert "[a]" not in snip and "<" not in snip


# Hebrew Wikipedia as mwoffliner 1.17 writes a lead with a pronunciation
# button (MediaWiki's Phonos): its data-ooui attribute carries the button's
# own HTML, "<" and ">" included, and the prefix ב is glued to the linked
# word after it. Cut down from the real smörgåsbord page (he top mini).
HEBREW_PHONOS = (
    '<!DOCTYPE html><html lang="he" dir="rtl"><head><title>סמרגוסבורד</title></head><body>'
    '<p id="mwAw"><b>סְמֵרגוֹסבּורד</b> (<span typeof="mw:Transclusion">ב</span>'
    '<a rel="mw:WikiLink" href="%D7%A9%D7%95%D7%95%D7%93%D7%99%D7%AA" title="שוודית">שוודית</a>'
    '<span>: </span><span class="ext-phonos" typeof="mw:Extension/phonos">'
    '<span class="noexcerpt ext-phonos-PhonosButton" data-ooui="{&quot;_&quot;:&quot;mw.Phonos.PhonosButton&quot;,'
    "&quot;label&quot;:{&quot;html&quot;:&quot;<b><span dir=\\&quot;auto\\&quot;>sm\\u00f6rg\\u00e5sbord<\\/span><\\/b>&quot;},"
    '&quot;classes&quot;:[&quot;noexcerpt&quot;]}"><a class="oo-ui-buttonElement-button"><b>smörgåsbord</b></a></span></span>'
    ') היא ארוחת מזנון סקנדינבית, <a rel="mw:WikiLink" href="x" title="x">ב</a>נורווגיה היא נקראת koldtbord.</p>'
    "</body></html>"
)


def test_an_attribute_holding_markup_is_not_read_as_text():
    """Found in the Hebrew top mini: the day's article and every card of the
    page read '"},"data":{"ipa":"",...' where its first words should be."""
    from zimi.previews import inline_text, strip_html

    snip = extract_snippet(HEBREW_PHONOS, "wikipedia_he")
    for text in (snip, strip_html(HEBREW_PHONOS), inline_text(HEBREW_PHONOS)):
        assert "ooui" not in text and '"}' not in text and "\\u00f6" not in text, text
    assert snip.startswith("סְמֵרגוֹסבּורד (בשוודית: smörgåsbord"), snip
    # A prefix and the linked word it is glued to stay one word.
    assert "בנורווגיה" in snip, snip


def test_a_tag_cut_off_by_the_read_still_goes():
    """A read can end inside a tag, with a quote left open."""
    from zimi.previews import inline_text, strip_html

    cut = '<p>Albert Einstein was born in <a rel="mw:WikiLink" href="Ul'
    assert strip_html(cut) == "Albert Einstein was born in"
    assert inline_text(cut) == "Albert Einstein was born in"


def test_a_tag_cut_off_at_the_end_of_the_read_is_not_left_as_text():
    """The handler reads the start of a page; a read can end inside a tag."""
    snip = extract_snippet(
        '<html><body><main>Born 14 March 1879 in <a rel="mw:WikiLink" href="Ulm" t', "x"
    )
    assert "<" not in snip and "href" not in snip, snip


def test_a_script_cut_off_at_the_end_of_the_read_is_not_the_snippet():
    """mwoffliner's Wikivoyage pages open with a config script longer than
    the handler's read (Paris: past 64 KB), and its code came back as the
    snippet in Zimipedia's search."""
    page = '<html><head><title>Paris</title><script id="mwoffliner-jsConfigVars">\n  document.documentElement.classList.replace("client-nojs", "client-js")\n  RLCONF = {"wgBreakFrames":false'
    snip = extract_snippet(page, "wikivoyage_en_europe")
    assert "document." not in snip and "RLCONF" not in snip, snip
