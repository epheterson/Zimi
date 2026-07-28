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
