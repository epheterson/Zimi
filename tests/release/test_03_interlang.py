"""Language switching: reading an article and jumping to another edition."""

import pytest

from fixtures_zim import WIKI_EN_NAME, WIKI_FR_NAME
from conftest import quote

pytestmark = pytest.mark.gate("language switching")


def test_installed_languages_are_summarised(gate_server):
    status, body = gate_server.get_json("/languages")
    assert status == 200
    by_code = {entry["code"]: entry for entry in body}
    assert {"en", "fr"} <= set(by_code), f"language summary is missing editions: {body}"
    assert by_code["fr"]["zims"] == [WIKI_FR_NAME]
    assert by_code["en"]["name"] and by_code["fr"]["name"], "no native language names"
    assert by_code["en"]["zim_count"] == len(by_code["en"]["zims"])


def test_an_article_offers_its_sibling_edition(gate_server):
    """The switcher in the reader. Both editions carry this path; the French one
    must come back, with the path the reader can actually open."""
    status, body = gate_server.get_json(
        f"/article-languages?zim={WIKI_EN_NAME}&path={quote('A/Water_purification')}"
    )
    assert status == 200
    languages = body["languages"]
    assert languages, "no sibling edition offered for an article that exists in two"
    match = next((entry for entry in languages if entry["lang"] == "fr"), None)
    assert match, f"French edition not offered: {languages}"
    assert match["zim"] == WIKI_FR_NAME
    assert match["name"], "sibling has no display name to put in the switcher"

    status, _headers, raw = gate_server.get(
        f"/w/{match['zim']}/{quote(match['path'])}?raw=1"
    )
    assert status == 200, "the switcher offered a path that does not serve"
    assert "Purification de l'eau".encode() in raw


def test_the_switch_works_in_both_directions(gate_server):
    status, body = gate_server.get_json(
        f"/article-languages?zim={WIKI_FR_NAME}&path={quote('A/Fire')}"
    )
    assert status == 200
    codes = {entry["lang"]: entry["zim"] for entry in body["languages"]}
    assert codes.get("en") == WIKI_EN_NAME, f"no way back to English: {body}"


def test_an_unknown_zim_is_a_clean_404(gate_server):
    status, body = gate_server.get_json(
        "/article-languages?zim=not_installed&path=A/Fire"
    )
    assert status == 404
    assert "error" in body


def test_an_article_with_no_sibling_returns_an_empty_list(gate_server):
    status, body = gate_server.get_json(
        f"/article-languages?zim=survival&path={quote('A/Shelter')}"
    )
    assert status == 200
    assert body["languages"] == []
