"""The first thing anyone does: search the library and read what they find."""

import pytest

from fixtures_zim import SURVIVAL_NAME, WIKI_EN_NAME
from conftest import quote

pytestmark = pytest.mark.gate("search, suggest and read")


def test_search_spans_every_source(gate_server):
    status, body = gate_server.get_json("/search?q=water&limit=20")
    assert status == 200
    assert body["results"], "search found nothing in a library that contains water"
    assert (
        len(body["by_source"]) >= 2
    ), f"search only reached {list(body['by_source'])} — cross-source search is broken"
    top = body["results"][0]
    assert top["zim"] and top["path"] and top["title"]


def test_search_without_a_query_is_a_clean_400(gate_server):
    status, body = gate_server.get_json("/search")
    assert status == 400
    assert "error" in body


def test_suggest_completes_a_partial_word(gate_server):
    status, body = gate_server.get_json("/suggest?q=wat&limit=10")
    assert status == 200
    hits = [item for entries in body.values() for item in entries]
    assert hits, "suggest returned nothing for a prefix that matches a real title"
    assert all(h.get("path") and h.get("title") for h in hits)


def test_reading_an_article_serves_its_content(gate_server):
    path = f"/w/{WIKI_EN_NAME}/{quote('A/Water_purification')}?raw=1"
    status, headers, raw = gate_server.get(path)
    assert status == 200
    assert headers.get("Content-Type", "").startswith("text/html")
    assert b"Water purification" in raw


def test_an_unchanged_article_answers_304(gate_server):
    """The reader re-requests constantly; a broken ETag re-sends every article."""
    path = f"/w/{WIKI_EN_NAME}/{quote('A/Water_purification')}?raw=1"
    _status, headers, _raw = gate_server.get(path)
    etag = headers.get("ETag")
    assert etag, "no ETag on article content — every reload refetches the whole article"
    status, _headers, body = gate_server.get(path, headers={"If-None-Match": etag})
    assert status == 304
    assert body == b""


def test_read_endpoint_returns_plain_text(gate_server):
    status, body = gate_server.get_json(
        f"/read?zim={WIKI_EN_NAME}&path={quote('A/Water_purification')}"
    )
    assert status == 200
    assert "Water purification" in body["content"]


def test_chunks_are_offered_to_agents(gate_server):
    status, body = gate_server.get_json(
        f"/chunks?zim={WIKI_EN_NAME}&path={quote('A/Water_purification')}"
    )
    assert status == 200
    assert body["chunks"], "/chunks returned no chunks for a real article"
    assert body["chunks"][0]["text"].strip()


def test_list_and_random_and_health(gate_server):
    status, listing = gate_server.get_json("/list")
    assert status == 200
    names = {z["name"] for z in listing}
    assert {WIKI_EN_NAME, SURVIVAL_NAME} <= names, f"library is missing ZIMs: {names}"

    # Unscoped /random only draws from ZIMs with more than 100 entries, which
    # no fixture reaches — scope it to one source, which is the same code path.
    status, body = gate_server.get_json(f"/random?zim={WIKI_EN_NAME}")
    assert status == 200
    assert body.get("path"), f"/random gave nothing back: {body}"
    assert body["zim"] == WIKI_EN_NAME

    status, body = gate_server.get_json("/health")
    assert status == 200
    assert body["status"] == "ok"
    assert body["zim_count"] == len(listing)
