"""Tests for the ZIM-name → SearXNG category mapping (W1.6).

The category hint is a stable per-result field that lets external consumers
(SearXNG, downstream tools) route Zimi hits into the right tab — general,
images, video, etc.
"""

import pytest

from zimi.search import _zim_category


@pytest.mark.parametrize(
    "name,expected",
    [
        # Wikipedia variants land in general
        ("wikipedia_en_top", "general"),
        ("wikipedia_en_all_maxi", "general"),
        ("wikipedia_fr_medicine", "general"),
        # Stack Exchange / dev docs / books → general
        ("stackexchange_en_all", "general"),
        ("stackoverflow.com_en_all", "general"),
        ("devdocs_en_react", "general"),
        ("freecodecamp", "general"),
        ("appropedia", "general"),
        ("gutenberg_en_all", "general"),
        ("rationalwiki_en_all_2024-04", "general"),
        ("explainxkcd", "general"),
        # zimgit (PDF collections) → general
        ("zimgit-prepper-en", "general"),
        # TED → video
        ("ted_en_technology", "video"),
        ("ted_en_business_2024-01", "video"),
        # Wikimedia Commons → images (image archive)
        ("wikimedia_commons_en", "images"),
        # APOD = Astronomy Picture of the Day → images
        ("apod.nasa.gov", "images"),
        # Unknown / odd names default to general
        ("some_random_unknown_zim", "general"),
        ("", "general"),
    ],
)
def test_zim_category_mapping(name, expected):
    assert _zim_category(name) == expected


def test_zim_category_is_case_insensitive():
    assert _zim_category("Wikipedia_EN_TOP") == "general"
    assert _zim_category("TED_en_technology") == "video"


def test_zim_category_returns_string():
    assert isinstance(_zim_category("anything"), str)
