"""Project NOMAD's own API as the back end for NOMAD's library folder.

With the opt-in on and NOMAD's admin answering with the shapes of 1.35.x, the
catalog's Download and Update and the Delete button act through NOMAD, so its
database, Kiwix library, content updates and assistant stay in step. Off, or
when NOMAD answers unexpectedly, the folder is read-only exactly as before.

A fake NOMAD stands in for the admin: it speaks the routes and shapes read from
NOMAD v1.35.1's source (admin/start/routes.ts, zim_controller.ts,
downloads_controller.ts) and does the file work the way NOMAD does.

Run: pytest tests/test_nomad_api.py -v
"""

import json
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as server  # noqa: E402
from zimi import library, libfolders, nomadapi  # noqa: E402

from conftest_zim import build_fixture_zim  # noqa: E402

OLD = "wikipedia_en_100_mini_2026-01.zim"
NEW = "wikipedia_en_100_mini_2026-10.zim"
OTHER = "medlineplus_en_all_2026-01.zim"
URL = "https://download.kiwix.org/zim/wikipedia/" + NEW

REQUIRED = list(nomadapi.REQUIRED_PATHS)


class FakeNomad:
    """The slice of NOMAD's admin API Zimi uses."""

    def __init__(self, folder, version="1.35.1", paths=None):
        self.folder = folder
        self.version = version
        self.paths = REQUIRED if paths is None else paths
        self.jobs = {}
        self.calls = []
        self.polls_to_finish = 2
        self.fail_with = None
        self.rows_have_old = True
        self.httpd = None

    def listing(self):
        names = sorted(n for n in os.listdir(self.folder) if n.endswith(".zim"))
        return {
            "files": [
                {"type": "file", "name": n, "key": "/app/storage/zim/" + n}
                for n in names
            ]
        }

    def finish(self, job):
        build_fixture_zim(os.path.join(self.folder, job["filename"]))
        if self.rows_have_old:
            # What NOMAD does for a resource it recorded: the old edition goes.
            for n in os.listdir(self.folder):
                if (
                    n.startswith("wikipedia_en_100_mini_")
                    and n != job["filename"]
                    and n.endswith(".zim")
                ):
                    os.remove(os.path.join(self.folder, n))

    def start(self):
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body):
                raw = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(n) or b"{}")

            def do_GET(self):
                fake.calls.append(("GET", self.path))
                if self.path == "/api/health":
                    return self._send(200, {"status": "ok"})
                if self.path == "/api/openapi.json":
                    return self._send(
                        200,
                        {
                            "info": {"version": fake.version},
                            "paths": {p: {} for p in fake.paths},
                        },
                    )
                if self.path == "/api/zim/list":
                    return self._send(200, fake.listing())
                if self.path == "/api/downloads/jobs":
                    rows = []
                    for jid, job in list(fake.jobs.items()):
                        if job["state"] == "done":
                            continue
                        job["polls"] += 1
                        if fake.fail_with:
                            job["state"] = "failed"
                        elif job["polls"] > fake.polls_to_finish:
                            fake.finish(job)
                            job["state"] = "done"
                            continue
                        rows.append(
                            {
                                "jobId": jid,
                                "url": job["url"],
                                "progress": 40,
                                "downloadedBytes": 400,
                                "totalBytes": 1000,
                                "status": (
                                    job["state"]
                                    if job["state"] == "failed"
                                    else "active"
                                ),
                                "failedReason": fake.fail_with,
                            }
                        )
                    return self._send(200, rows)
                self._send(404, {"message": "no"})

            def do_POST(self):
                fake.calls.append(("POST", self.path))
                body = self._body()
                if self.path == "/api/zim/download-remote":
                    jid = str(len(fake.jobs) + 1)
                    name = body["url"].split("/")[-1]
                    fake.jobs[jid] = {
                        "url": body["url"],
                        "filename": name,
                        "polls": 0,
                        "state": "active",
                        "meta": body.get("metadata"),
                    }
                    return self._send(
                        200,
                        {
                            "message": "Download started successfully",
                            "filename": name,
                            "jobId": jid,
                            "url": body["url"],
                        },
                    )
                if self.path.startswith("/api/downloads/jobs/") and self.path.endswith(
                    "/cancel"
                ):
                    jid = self.path.split("/")[-2]
                    fake.jobs.pop(jid, None)
                    return self._send(200, {"success": True, "message": "cancelled"})
                self._send(404, {"message": "no"})

            def do_DELETE(self):
                fake.calls.append(("DELETE", self.path))
                name = urllib.parse.unquote(self.path.rsplit("/", 1)[-1])
                fake.held_at_delete = server._zim_short_name(name) in server._archive_pool
                path = os.path.join(fake.folder, name)
                if not os.path.exists(path):
                    return self._send(404, {"message": "not found"})
                os.remove(path)
                self._send(200, {"message": "ZIM file deleted successfully"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return "http://127.0.0.1:%d" % self.httpd.server_address[1]

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def box(tmp_path, monkeypatch):
    """Zimi's library, a NOMAD-shaped folder with two ZIMs, and a fake NOMAD."""
    own = tmp_path / "zims"
    nomad = tmp_path / "nomad" / "storage" / "zim"
    own.mkdir()
    nomad.mkdir(parents=True)
    data = tmp_path / "data"
    data.mkdir()
    build_fixture_zim(str(nomad / OLD))
    build_fixture_zim(str(nomad / OTHER))
    (nomad / "kiwix-library.xml").write_text("<library/>", encoding="utf-8")
    monkeypatch.delenv(libfolders.ENV, raising=False)
    monkeypatch.delenv(nomadapi.ENV, raising=False)
    monkeypatch.setattr(server, "ZIM_DIR", str(own))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(data))
    monkeypatch.setattr(nomadapi, "POLL_S", 0.05)
    server._zim_files_cache = None
    server._zim_list_cache = None
    libfolders.add(str(nomad))
    server.load_cache(force=True)
    fake = FakeNomad(str(nomad))
    url = fake.start()
    nomadapi._forget_probe()
    yield fake, url, nomad
    fake.stop()
    nomadapi._forget_probe()


def _turn_on(url):
    nomadapi.save(True, url)
    return nomadapi.probe(force=True)


def _wait(cond, seconds=8):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return cond()


def _names(folder):
    return sorted(n for n in os.listdir(folder) if n.endswith(".zim"))


# ---------------------------------------------------------------------------
# Off by default, on by choice
# ---------------------------------------------------------------------------


def test_read_only_until_the_owner_turns_it_on(box):
    fake, url, nomad = box
    assert nomadapi.settings()["enabled"] is False
    assert nomadapi.probe(force=True)["reason"] == nomadapi.REASON_OFF
    assert nomadapi.managed() is False
    assert fake.calls == [], "NOMAD is not even asked while the setting is off"
    names = {os.path.basename(p) for p in library._owned_zim_files().values()}
    assert OLD not in names


def test_the_storage_card_does_not_ask_nomad_at_every_open(box):
    # Probing every candidate can take ~48 s when none answers; the card reads
    # the last answer and asks again only after a change forgot it.
    fake, url, nomad = box
    _turn_on(url)
    asked = len(fake.calls)
    assert nomadapi.view()["reason"] == nomadapi.REASON_OK
    assert nomadapi.view()["reason"] == nomadapi.REASON_OK
    assert len(fake.calls) == asked
    nomadapi.save(True, url)
    assert nomadapi.view()["reason"] == nomadapi.REASON_OK
    assert len(fake.calls) > asked


def test_the_environment_turns_it_on_and_locks_the_page(box, monkeypatch):
    fake, url, nomad = box
    monkeypatch.setenv(nomadapi.ENV, url)
    cfg = nomadapi.settings()
    assert (cfg["enabled"], cfg["url"], cfg["locked"]) == (True, url, True)
    assert nomadapi.probe(force=True)["reason"] == nomadapi.REASON_OK


def test_a_good_answer_makes_nomad_the_back_end(box):
    fake, url, nomad = box
    state = _turn_on(url)
    assert (state["reason"], state["version"]) == (nomadapi.REASON_OK, "1.35.1")
    assert nomadapi.managed() is True
    names = {os.path.basename(p) for p in library._owned_zim_files().values()}
    assert {OLD, OTHER} <= names


@pytest.mark.parametrize(
    "version,paths,reason",
    [
        ("1.36.0", None, nomadapi.REASON_VERSION),
        ("1.34.9", None, nomadapi.REASON_VERSION),
        ("1.35.1", ["/api/zim/list"], nomadapi.REASON_SHAPE),
    ],
)
def test_an_unexpected_nomad_leaves_the_folder_read_only(box, version, paths, reason):
    fake, url, nomad = box
    fake.version = version
    if paths is not None:
        fake.paths = paths
    assert _turn_on(url)["reason"] == reason
    assert nomadapi.managed() is False
    names = {os.path.basename(p) for p in library._owned_zim_files().values()}
    assert OLD not in names


def test_an_address_that_does_not_answer_is_read_only(box):
    fake, url, nomad = box
    assert _turn_on("http://127.0.0.1:9")["reason"] == nomadapi.REASON_UNREACHABLE
    assert nomadapi.managed() is False


def test_the_address_must_be_a_web_address(box):
    with pytest.raises(ValueError):
        nomadapi.save(True, "file:///etc/passwd")


def test_without_a_nomad_folder_there_is_nothing_to_manage(box):
    fake, url, nomad = box
    libfolders.remove(str(nomad))
    assert _turn_on(url)["reason"] == nomadapi.REASON_NO_FOLDER


def test_the_page_treats_nomads_zims_as_its_own_only_through_nomad(box):
    from zimi.http import _mark_external

    fake, url, nomad = box
    rows = _mark_external([{"name": "wikipedia_en_100", "entries": 5}])
    assert rows[0].get("external") == libfolders.NOMAD_LABEL and "via" not in rows[0]
    _turn_on(url)
    rows = _mark_external([{"name": "wikipedia_en_100", "entries": 5}])
    assert rows[0].get("via") == libfolders.NOMAD_LABEL and "external" not in rows[0]


# ---------------------------------------------------------------------------
# Download and update
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="NOMAD runs on Linux, where it removes the old edition while Zimi still"
    " reads it; Windows refuses to remove a file another process holds open",
)
def test_a_catalog_download_is_nomads_job_and_zimi_shows_its_progress(box):
    fake, url, nomad = box
    _turn_on(url)
    fake.polls_to_finish = 4
    dl_id, err = library._start_download(URL, size_bytes=1000)
    assert err is None
    posted = [c for c in fake.calls if c[0] == "POST"]
    assert posted[0] == ("POST", "/api/zim/download-remote")
    assert fake.jobs["1"]["meta"]["title"], "NOMAD needs a title with the metadata"
    assert _wait(lambda: library._download_by_id(dl_id).get("downloaded_bytes") == 400)
    row = next(d for d in library._get_downloads() if d["id"] == dl_id)
    assert (row["downloaded_bytes"], row["total_bytes"], row["done"]) == (
        400,
        1000,
        False,
    )
    assert row["is_update"] is True
    assert _wait(lambda: library._download_by_id(dl_id)["done"])
    assert library._download_by_id(dl_id)["error"] is None
    # Zimi wrote nothing into NOMAD's folder: the new ZIM is NOMAD's work, and
    # NOMAD replaced the recorded old edition itself.
    assert _names(str(nomad)) == sorted([NEW, OTHER])
    assert _wait(lambda: "wikipedia_en_100" in server.get_zim_files())
    assert os.path.basename(server.get_zim_files()["wikipedia_en_100"]) == NEW
    assert not any(n.endswith(".tmp") for n in os.listdir(nomad))
    assert not os.listdir(server.ZIM_DIR), "nothing landed in Zimi's own library"


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="the fake NOMAD deletes a file Zimi still has open; NOMAD itself runs in a Linux container",
)
def test_a_renamed_zims_successor_through_nomad_removes_the_old_name_and_carries_its_settings(
    box, monkeypatch
):
    from zimi import renames

    fake, url, nomad = box
    _turn_on(url)
    moved = []
    monkeypatch.setattr(library, "_carry_zim_state", lambda a, b: moved.append((a, b)))
    # The update check found OTHER renamed upstream to the download's name.
    monkeypatch.setitem(renames._pending, "wikipedia_en_100_mini", str(nomad / OTHER))
    dl_id, err = library._start_download(URL, size_bytes=1000)
    assert err is None
    assert _wait(lambda: library._download_by_id(dl_id)["done"])
    assert _wait(lambda: ("DELETE", "/api/zim/" + OTHER) in fake.calls), fake.calls
    assert _wait(lambda: moved), "the old name's settings were not carried"
    assert OTHER not in _names(str(nomad))
    assert moved == [("medlineplus", "wikipedia_en_100")]


def test_the_off_switch_keeps_downloads_in_zimis_own_library(box, monkeypatch):
    fake, url, nomad = box
    started = []
    monkeypatch.setattr(
        library, "_enqueue_or_start", lambda dl: started.append(dl) or False
    )
    dl_id, err = library._start_download(URL, size_bytes=1000)
    assert err is None and started and started[0]["dest"].startswith(server.ZIM_DIR)
    assert fake.calls == []


def test_a_peer_pull_never_goes_through_nomad(box, monkeypatch):
    fake, url, nomad = box
    _turn_on(url)
    started = []
    monkeypatch.setattr(
        library, "_enqueue_or_start", lambda dl: started.append(dl) or False
    )
    library._enqueue_zim_download(
        "http://192.168.1.5:8899/dl/x",
        ["http://192.168.1.5:8899/dl/x"],
        NEW,
        extra={"_source": "peer"},
    )
    assert started and not [c for c in fake.calls if c[0] == "POST"]


def test_a_failed_nomad_job_is_a_failed_download_here(box):
    fake, url, nomad = box
    _turn_on(url)
    fake.fail_with = "disk full"
    dl_id, err = library._start_download(URL, size_bytes=1000)
    assert err is None
    assert _wait(lambda: library._download_by_id(dl_id)["done"])
    assert library._download_by_id(dl_id)["error"] == "Download failed"
    assert _names(str(nomad)) == sorted([OLD, OTHER])


def test_cancelling_here_cancels_nomads_job(box):
    fake, url, nomad = box
    _turn_on(url)
    fake.polls_to_finish = 10_000
    dl_id, err = library._start_download(URL, size_bytes=1000)
    assert err is None
    assert _wait(lambda: library._download_by_id(dl_id).get("downloaded_bytes") == 400)
    assert library._cancel_download(dl_id) == ("cancelling", 200)
    assert _wait(lambda: library._download_by_id(dl_id)["done"])
    assert ("POST", "/api/downloads/jobs/1/cancel") in fake.calls
    assert library._download_by_id(dl_id)["error"] == "Cancelled"
    assert "1" not in fake.jobs


def test_a_handed_off_download_is_not_resumed_by_zimi_after_a_restart(box):
    fake, url, nomad = box
    _turn_on(url)
    fake.polls_to_finish = 10_000
    dl_id, err = library._start_download(URL, size_bytes=1000)
    with library._download_lock:
        library._persist_pending_downloads()
    with open(library._pending_downloads_path(), encoding="utf-8") as f:
        assert json.load(f)["pending"] == []
    library._cancel_download(dl_id)
    _wait(lambda: library._download_by_id(dl_id)["done"])


def test_nomad_refusing_a_download_is_an_error_not_a_hang(box):
    fake, url, nomad = box
    _turn_on(url)
    fake.httpd.RequestHandlerClass.do_POST = lambda self: self._send(
        409, {"message": "A download for this URL is already in progress"}
    )
    dl_id, err = library._start_download(URL, size_bytes=1000)
    assert dl_id is None and "already in progress" in err


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


class _Handler:
    def __init__(self):
        self.sent = None
        self.headers = {}
        self.client_address = ("127.0.0.1", 0)

    def _json(self, code, body):
        self.sent = (code, body)


def test_delete_asks_nomad_and_the_zim_leaves_the_library(box):
    from zimi import manage

    fake, url, nomad = box
    _turn_on(url)
    assert server.get_archive(server._zim_short_name(OTHER)) is not None
    h = _Handler()
    manage._delete_through_nomad(h, OTHER)
    assert h.sent[0] == 200
    assert fake.held_at_delete is False, "Zimi still held the ZIM open when NOMAD deleted it"
    assert ("DELETE", "/api/zim/" + OTHER) in fake.calls
    assert _names(str(nomad)) == [OLD]
    assert "medlineplus" not in server.get_zim_files()


def test_delete_of_a_zim_nomad_does_not_have_is_a_404_not_a_crash(box):
    from zimi import manage

    fake, url, nomad = box
    _turn_on(url)
    h = _Handler()
    manage._delete_through_nomad(h, "nothing_en_2026-01.zim")
    assert h.sent[0] == 404


def test_delete_stays_refused_when_nomad_mode_is_off(box):
    fake, url, nomad = box
    with pytest.raises(nomadapi.NomadError):
        nomadapi.delete(OTHER)
    assert _names(str(nomad)) == sorted([OLD, OTHER])


def test_zimi_never_writes_to_nomads_folder_itself(box):
    """Through all of the above, the only writer is NOMAD (the fake)."""
    fake, url, nomad = box
    before = {
        e.name: (e.stat().st_size, e.stat().st_mtime_ns) for e in os.scandir(nomad)
    }
    _turn_on(url)
    nomadapi.probe(force=True)
    server.load_cache(force=True)
    after = {
        e.name: (e.stat().st_size, e.stat().st_mtime_ns) for e in os.scandir(nomad)
    }
    assert before == after
