"""Cross-ZIM link resolution — the feature that shipped silently dead.

The browser asks /resolve?domains=1 once, then rewrites any link whose host is
in that map into an in-library jump. When the map came back empty the feature
looked fine in code review and did nothing in production, so this check boots
the server the ordinary way (load_cache, not register_zim_file) and asserts the
map a real client receives is populated.
"""

import os
import re
import shutil

import pytest

from fixtures_zim import WIKI_EN_NAME, WIKI_FR_NAME
from conftest import quote

pytestmark = pytest.mark.gate("cross-ZIM link resolution")

_HREF_RE = re.compile(rb'href="(https://[^"]+)"')


def test_a_normally_booted_server_publishes_its_domain_map(gate_server):
    status, domains = gate_server.get_json("/resolve?domains=1")
    assert status == 200
    assert domains, (
        "/resolve?domains=1 is EMPTY on a normally-booted server — the browser's "
        "cross-ZIM pre-check is dead and every external link stays external"
    )
    assert domains.get("en.wikipedia.org") == WIKI_EN_NAME
    assert domains.get("fr.wikipedia.org") == WIKI_FR_NAME


def test_a_canonical_url_maps_into_the_installed_zim(gate_server):
    url = "https://en.wikipedia.org/wiki/Boiling"
    status, body = gate_server.get_json(f"/resolve?url={quote(url)}")
    assert status == 200
    assert body.get("found") is True, f"{url} did not resolve into the library: {body}"
    assert body["zim"] == WIKI_EN_NAME
    assert body["path"] == "A/Boiling"

    # …and the path it hands back must actually serve.
    status, _headers, raw = gate_server.get(
        f"/w/{body['zim']}/{quote(body['path'])}?raw=1"
    )
    assert status == 200
    assert b"Boiling" in raw


def test_a_url_with_no_installed_home_is_answered_honestly(gate_server):
    status, body = gate_server.get_json(
        f"/resolve?url={quote('https://example.invalid/wiki/Nothing')}"
    )
    assert status == 200
    assert body.get("found") is False


def test_batch_resolve_answers_every_url(gate_server):
    urls = [
        "https://en.wikipedia.org/wiki/Fire",
        "https://fr.wikipedia.org/wiki/Water_purification",
        "https://example.invalid/wiki/Nothing",
    ]
    status, body = gate_server.post_json("/resolve", {"urls": urls})
    assert status == 200
    results = body["results"]
    assert set(results) == set(urls)
    assert results[urls[0]]["zim"] == WIKI_EN_NAME
    assert results[urls[1]]["zim"] == WIKI_FR_NAME
    assert results[urls[2]]["found"] is False


def test_an_exported_bookmarks_link_resolves_back_home(gate_server, tmp_path):
    """A link that left the library as a canonical web URL must come home."""
    pytest.importorskip("libzim.reader")
    from libzim.reader import Archive

    status, body = gate_server.post_json(
        "/manage/export-bookmarks",
        {
            "bookmarks": [
                {
                    "zim": WIKI_EN_NAME,
                    "path": "A/Water_purification",
                    "title": "Water purification",
                    "section": "Gate",
                }
            ]
        },
    )
    assert status == 200 and body.get("status") == "started", body
    state = gate_server.poll_json(
        "/manage/export-bookmarks", lambda s: s.get("phase") in ("done", "error")
    )
    assert state["phase"] == "done", state
    exported = state.get("files") or [state.get("file")]
    assert exported and exported[0], state

    local = tmp_path / exported[0]
    status, _headers, raw = gate_server.get(f"/dl/{quote(exported[0])}")
    assert status == 200, f"exported ZIM would not download: {status}"
    local.write_bytes(raw)

    archive = Archive(local)
    article = bytes(
        archive.get_entry_by_path("A/0_Water_purification").get_item().content
    )
    web_links = [m.group(1) for m in _HREF_RE.finditer(article)]
    wiki_links = [u for u in web_links if b"en.wikipedia.org" in u]
    assert (
        wiki_links
    ), "the export rewrote no link to a canonical URL — nothing to resolve back"
    for url in wiki_links:
        status, resolved = gate_server.get_json(f"/resolve?url={quote(url.decode())}")
        assert status == 200
        assert (
            resolved.get("found") is True
        ), f"exported link {url!r} does not come home"
        assert resolved["zim"] == WIKI_EN_NAME


def test_deleting_a_zim_drops_its_domain_claims(gate_server, tmp_path_factory):
    """A domain must stop resolving the moment its ZIM leaves the library."""
    from conftest import boot
    from fixtures_zim import WIKI_FR

    root = tmp_path_factory.mktemp("gate-domain-prune")
    zim_dir = os.path.join(str(root), "zims")
    shutil.copytree(gate_server.zim_dir, zim_dir)
    with boot(zim_dir=zim_dir, data_dir=os.path.join(str(root), "data")) as server:
        status, before = server.get_json("/resolve?domains=1")
        assert before.get("fr.wikipedia.org") == WIKI_FR_NAME

        status, body = server.post_json("/manage/delete", {"filename": WIKI_FR})
        assert status == 200 and body.get("status") == "deleted", body

        status, after = server.get_json("/resolve?domains=1")
        assert status == 200
        assert (
            "fr.wikipedia.org" not in after
        ), "a deleted ZIM still claims its domain — links resolve to nothing"
        assert after.get("en.wikipedia.org") == WIKI_EN_NAME
