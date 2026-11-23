"""Library operations: removing a ZIM, and where a ZIM's category comes from.

Deleting used to trigger a full library rescan under the global ZIM lock, which
froze every other request for as long as the rescan took — minutes on a real
library. The splice that replaced it is invisible in a unit test; the proof is
that the server's own log says it never rescanned, and that it kept answering.
"""

import pytest

from fixtures_zim import (
    MUSHROOMS_CATEGORY,
    MUSHROOMS_FOLDER,
    MUSHROOMS_NAME,
    SURVIVAL,
    SURVIVAL_NAME,
    WIKI_EN_NAME,
)

pytestmark = pytest.mark.gate("library operations")

#: What a full rescan prints. Seeing a new one after a delete is the regression.
RESCAN_MARKER = "Cache built:"


def _rescan_count(server):
    return server.log_text().count(RESCAN_MARKER)


def test_a_subfolder_becomes_a_category(gate_server):
    """Dropping ZIMs into folders is how a big library gets organised."""
    status, listing = gate_server.get_json("/list")
    assert status == 200
    entry = next((z for z in listing if z["name"] == MUSHROOMS_NAME), None)
    assert entry, f"the ZIM in a subfolder is missing from the library: {listing}"
    assert entry["folder"] == MUSHROOMS_FOLDER, entry
    assert (
        entry["category"] == MUSHROOMS_CATEGORY
    ), f"subfolder did not become a category: {entry}"

    root_entry = next(z for z in listing if z["name"] == WIKI_EN_NAME)
    assert not root_entry.get("folder"), "a root ZIM was given a folder"


def test_deleting_a_zim_removes_it_without_rescanning(gate_server):
    before = _rescan_count(gate_server)

    status, listing = gate_server.get_json("/list")
    assert SURVIVAL_NAME in {z["name"] for z in listing}

    status, body = gate_server.post_json("/manage/delete", {"filename": SURVIVAL})
    assert status == 200, body
    assert body.get("status") == "deleted", body

    status, listing = gate_server.get_json("/list")
    assert status == 200
    assert SURVIVAL_NAME not in {
        z["name"] for z in listing
    }, "the deleted ZIM is still listed"

    log = gate_server.log_text()
    assert _rescan_count(gate_server) == before, (
        "deleting a ZIM triggered a FULL library rescan under the ZIM lock — "
        "on a real library that is a multi-minute freeze"
    )
    assert (
        "without a library rescan" in log
    ), "no splice happened; the delete path fell back to something slower"


def test_the_server_still_answers_after_a_delete(gate_server):
    """The freeze showed up as everything else timing out, so check everything else."""
    status, body = gate_server.get_json("/search?q=water&limit=5")
    assert status == 200
    assert body["results"]

    status, body = gate_server.get_json("/health")
    assert status == 200 and body["status"] == "ok"

    status, domains = gate_server.get_json("/resolve?domains=1")
    assert status == 200
    assert domains.get("en.wikipedia.org") == WIKI_EN_NAME
    assert not any(
        zim == SURVIVAL_NAME for zim in domains.values()
    ), "a deleted ZIM still owns domains in the resolver map"


def test_deleting_something_that_is_not_there_is_a_clean_404(gate_server):
    status, body = gate_server.post_json(
        "/manage/delete", {"filename": "no_such_file_en_2026-01.zim"}
    )
    assert status == 404
    assert "error" in body


def test_a_traversal_filename_is_refused(gate_server):
    status, body = gate_server.post_json(
        "/manage/delete", {"filename": "../../etc/passwd"}
    )
    assert status == 400
    assert "error" in body
