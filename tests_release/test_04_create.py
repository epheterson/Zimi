"""Making a ZIM: point Zimi at a folder and get a served source out of it."""

import os

import pytest

from fixtures_zim import build_source_folder
from conftest import quote

pytestmark = pytest.mark.gate("ZIM creation from a folder")

CREATE_TIMEOUT_SEC = 180


@pytest.fixture(scope="module")
def source_folder(tmp_path_factory):
    return build_source_folder(str(tmp_path_factory.mktemp("gate-source")))


def test_probe_describes_the_folder_before_committing(gate_server, source_folder):
    """The Create page shows you what you are about to get. If the probe lies or
    breaks, every creation becomes a leap of faith."""
    status, body = gate_server.post_json(
        "/manage/create/probe", {"mode": "folder", "source": source_folder}
    )
    assert status == 200, body
    assert body.get("ok") is True, f"probe refused a plain readable folder: {body}"
    assert body["mode"] == "folder"
    assert body["files"] == 3, f"probe miscounted the folder: {body}"
    assert body["bytes"] > 0
    assert body["main"] == "index.html", f"probe picked the wrong main page: {body}"


def test_probe_refuses_a_path_that_is_not_a_folder(gate_server, tmp_path):
    missing = str(tmp_path / "there-is-nothing-here")
    status, body = gate_server.post_json(
        "/manage/create/probe", {"mode": "folder", "source": missing}
    )
    assert status == 400, body
    assert "error" in body


def test_a_folder_becomes_a_zim_that_serves(gate_server, source_folder):
    status, body = gate_server.post_json(
        "/manage/create",
        {"mode": "folder", "source": source_folder, "title": "Gate Field Notes"},
    )
    assert status == 200, body
    assert body.get("status") == "started", body

    state = gate_server.poll_json(
        "/manage/create/status",
        lambda s: s.get("done") is True,
        timeout=CREATE_TIMEOUT_SEC,
    )
    assert state.get("ok") is True, f"creation failed: {state}"
    assert not state.get("error"), state

    # The new ZIM must join the live library without a restart…
    status, listing = gate_server.get_json("/list")
    assert status == 200
    created = [z for z in listing if z.get("title") == "Gate Field Notes"]
    assert created, f"the created ZIM never joined the library: {listing}"
    entry = created[0]
    assert entry["entries"] > 0

    # …and its content must actually serve.
    main_path = entry.get("main_path")
    assert main_path, f"created ZIM has no main page: {entry}"
    status, _headers, raw = gate_server.get(
        f"/w/{entry['name']}/{quote(main_path)}?raw=1"
    )
    assert status == 200, f"created ZIM will not serve its main page: {status}"
    assert b"Field notes" in raw

    # …and it must be findable.
    status, results = gate_server.get_json(
        f"/search?q=boiling&zim={quote(entry['name'])}&limit=10"
    )
    assert status == 200
    assert results["results"], f"nothing searchable in the created ZIM: {results}"


def test_the_created_zim_carries_its_provenance(gate_server, source_folder, tmp_path):
    """Every ZIM Zimi writes says who made it. A reader that trusts a ZIM's
    origin needs that metadata present, not just intended."""
    pytest.importorskip("libzim.reader")
    from libzim.reader import Archive

    status, listing = gate_server.get_json("/list")
    assert status == 200
    created = [z for z in listing if z.get("title") == "Gate Field Notes"]
    assert created, "run after the creation check — nothing was created"
    path = os.path.join(gate_server.zim_dir, created[0]["file"])
    assert os.path.exists(path), path

    archive = Archive(path)
    scraper = bytes(archive.get_metadata("Scraper")).decode("utf-8", "replace")
    assert "zimi" in scraper.lower(), f"no Zimi provenance in Scraper: {scraper!r}"
