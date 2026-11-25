"""Bookmarks: save a set, export it as a standalone ZIM, take it away."""

import os
import shutil
import subprocess

import pytest

from fixtures_zim import WIKI_EN_NAME, WIKI_FR_NAME
from conftest import REPO_ROOT, quote

pytestmark = pytest.mark.gate("bookmarks export")

EXPORT_TIMEOUT_SEC = 180

BOOKMARKS = [
    {
        "zim": WIKI_EN_NAME,
        "path": "A/Water_purification",
        "title": "Water purification",
        "section": "Water",
    },
    {"zim": WIKI_EN_NAME, "path": "A/Boiling", "title": "Boiling", "section": "Water"},
    {"zim": WIKI_FR_NAME, "path": "A/Fire", "title": "Feu", "section": "Feu"},
]


def _zimcheck_binary():
    """zimcheck if this machine has one — the gate must not require kiwix-tools."""
    found = shutil.which("zimcheck")
    if found:
        return found
    for candidate in (
        os.path.join(REPO_ROOT, "scratchpad", "zimcheck"),
        os.path.join(REPO_ROOT, "scratchpad", "kiwix-tools", "zimcheck"),
    ):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


@pytest.fixture(scope="module")
def exported_zim(gate_server, tmp_path_factory):
    """Export the bookmarks once, download the result, hand back the local file."""
    status, body = gate_server.post_json(
        "/manage/export-bookmarks", {"bookmarks": BOOKMARKS}
    )
    assert status == 200, body
    assert body.get("status") == "started", body

    state = gate_server.poll_json(
        "/manage/export-bookmarks",
        lambda s: s.get("phase") in ("done", "error"),
        timeout=EXPORT_TIMEOUT_SEC,
    )
    assert state["phase"] == "done", f"export failed: {state}"
    names = state.get("files") or ([state["file"]] if state.get("file") else [])
    assert names, f"export reported done with no file: {state}"

    status, headers, raw = gate_server.get(f"/dl/{quote(names[0])}")
    assert status == 200, f"the export would not download: {status}"
    assert headers.get("Content-Type") == "application/octet-stream"
    assert names[0] in headers.get("Content-Disposition", "")
    assert len(raw) == int(headers["Content-Length"])

    local = tmp_path_factory.mktemp("gate-export") / names[0]
    local.write_bytes(raw)
    return str(local)


def test_an_empty_export_is_refused(gate_server):
    status, body = gate_server.post_json("/manage/export-bookmarks", {"bookmarks": []})
    assert status == 400
    assert "error" in body


def test_the_export_downloads_and_opens(exported_zim):
    pytest.importorskip("libzim.reader")
    from libzim.reader import Archive

    assert os.path.getsize(exported_zim) > 0
    archive = Archive(exported_zim)
    assert archive.all_entry_count > 0
    assert archive.main_entry is not None, "the export has no main page to open on"


def test_every_bookmarked_article_made_it_in(exported_zim):
    pytest.importorskip("libzim.reader")
    from libzim.reader import Archive

    archive = Archive(exported_zim)
    titles = set()
    for index in range(archive.all_entry_count):
        try:
            titles.add(archive._get_entry_by_id(index).title)
        except Exception:
            continue
    for bookmark in BOOKMARKS:
        assert bookmark["title"] in titles, (
            f"{bookmark['title']} was bookmarked but is not in the export: "
            f"{sorted(titles)}"
        )


def test_the_export_carries_its_provenance(exported_zim):
    pytest.importorskip("libzim.reader")
    from libzim.reader import Archive

    archive = Archive(exported_zim)
    scraper = bytes(archive.get_metadata("Scraper")).decode("utf-8", "replace")
    assert "zimi" in scraper.lower(), f"export has no Zimi provenance: {scraper!r}"


def test_zimcheck_accepts_the_export(exported_zim):
    binary = _zimcheck_binary()
    if not binary:
        pytest.skip("zimcheck not installed — install kiwix-tools for the full check")
    result = subprocess.run(
        [binary, "-A", exported_zim], capture_output=True, text=True, timeout=300
    )
    assert (
        result.returncode == 0
    ), f"zimcheck rejected the export:\n{result.stdout[-3000:]}\n{result.stderr[-2000:]}"
