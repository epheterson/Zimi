"""The download mirrors a ZIM download draws on, driven end to end.

Fake download mirrors (tests/download_mirrors_fixture.py) are real HTTPS
servers on loopback, listed in a Kiwix-shaped .meta4. A download is started the
way the catalog starts one, and the tests read what the downloads status
reports, which bytes land, and what each mirror was asked for.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.library as lib  # noqa: E402
from download_mirrors_fixture import (  # noqa: E402,F401
    download_mirrors,
    download_status,
    wait_for,
)


def _start(mirrors):
    dl_id, err = lib._start_download(mirrors.meta4_url)
    assert err is None, err
    return dl_id


def test_mirror_count_is_the_number_of_download_mirrors_in_the_meta4(download_mirrors):
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    dl_id = _start(mirrors)
    assert wait_for(lambda: download_status(dl_id)["done"]), "download never finished"
    assert download_status(dl_id)["mirror_count"] == 3


def test_status_lists_each_download_mirror_with_its_country(download_mirrors):
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    dl_id = _start(mirrors)
    assert wait_for(lambda: download_status(dl_id)["done"]), "download never finished"
    rows = download_status(dl_id)["mirrors"]
    assert sorted((r["url"], r["host"], r["country"]) for r in rows) == sorted(
        (m.url, m.host, m.country) for m in mirrors.mirrors
    )
    # The one that served the file is active; nothing is measured yet.
    assert sorted(r["state"] for r in rows) == ["active", "ready", "ready"]
    assert all(
        (r["speed_bps"], r["measured_at"], r["reason"]) == (None, None, None)
        for r in rows
    )


def test_a_queued_download_reports_an_empty_mirror_list(download_mirrors, monkeypatch):
    monkeypatch.setenv("ZIMI_MAX_CONCURRENT_DOWNLOADS", "1")
    slow = download_mirrors(countries=("us",), filename="slowone_2026-01.zim")
    slow.mirrors[0].chunk_delay = 0.05
    waiting = download_mirrors(countries=("nl", "fr"), filename="waiting_2026-01.zim")
    _start(slow)
    queued_id = _start(waiting)
    row = download_status(queued_id)
    assert row["queued"] is True
    assert row["mirrors"] == []


# ── seam 2: the /manage/downloads route ────────────────────────────────────

# Every field the downloads status carried before download mirrors were
# listed. Clients (the SPA, scripts) read these; they keep their names.
_EXISTING_ACTIVE_FIELDS = {
    "id", "filename", "url", "mirror_host", "mirror_count", "size_bytes",
    "total_bytes", "downloaded_bytes", "percent", "done", "error", "elapsed",
    "is_update", "queued", "paused", "source", "bt_peers", "checking",
    "switching_direct", "reused_bytes",
}


def test_manage_downloads_route_lists_the_download_mirrors(download_mirrors, monkeypatch):
    import json
    import threading
    import urllib.request
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler
    from zimi.manage import _generate_api_token

    monkeypatch.setattr(srv, "ZIMI_MANAGE", True, raising=False)
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    dl_id = _start(mirrors)
    assert wait_for(lambda: download_status(dl_id)["done"]), "download never finished"

    server = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{server.server_address[1]}/manage/downloads",
            headers={"Authorization": f"Bearer {_generate_api_token()}"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            rows = json.loads(resp.read())["downloads"]
    finally:
        server.shutdown()
        server.server_close()
    row = next(r for r in rows if r["id"] == dl_id)
    assert _EXISTING_ACTIVE_FIELDS <= set(row)
    assert row["mirror_count"] == 3
    assert sorted(m["country"] for m in row["mirrors"]) == ["fr", "nl", "us"]
    assert row["probing"] is False


# ── the direct URL stays the fallback ──────────────────────────────────────


def _finished_bytes(mirrors):
    import zimi.server as srv

    with open(os.path.join(srv.ZIM_DIR, mirrors.filename), "rb") as f:
        return f.read()


def test_a_meta4_with_no_usable_mirror_downloads_from_the_direct_url(download_mirrors):
    mirrors = download_mirrors(countries=("us",))
    mirrors.set_meta4(listed=[])
    dl_id = _start(mirrors)
    assert wait_for(lambda: download_status(dl_id)["done"]), "download never finished"
    assert download_status(dl_id)["error"] is None
    assert download_status(dl_id)["mirror_count"] == 1
    assert _finished_bytes(mirrors) == mirrors.body


def test_the_direct_url_is_tried_when_every_listed_mirror_fails(download_mirrors):
    mirrors = download_mirrors(countries=("nl", "fr"))
    for m in mirrors.mirrors:
        m.fail_status = 503
    dl_id = _start(mirrors)
    assert wait_for(lambda: download_status(dl_id)["done"]), "download never finished"
    row = download_status(dl_id)
    assert row["error"] is None
    assert _finished_bytes(mirrors) == mirrors.body
    # Every listed mirror refused, so the direct URL served the file. It is not
    # a download mirror: no listed mirror is active, and each shows it failed.
    assert [r["state"] for r in row["mirrors"]] == ["failed", "failed"]


def test_the_direct_url_waits_until_every_listed_mirror_has_been_tried(
    download_mirrors,
):
    # Whatever order the download mirrors are tried in, the direct URL
    # (Kiwix's redirector) comes after them.
    mirrors = download_mirrors(countries=("us", "nl", "fr"))
    dl_id = _start(mirrors)
    assert wait_for(lambda: download_status(dl_id)["done"]), "download never finished"
    assert download_status(dl_id)["error"] is None
    assert mirrors.origin.requests == [], "the direct URL was tried first"
    assert [r["state"] for r in download_status(dl_id)["mirrors"]].count("active") == 1
