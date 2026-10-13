"""An external qBittorrent as the engine (#53), against a fake qBittorrent.

The fake speaks the part of Web API v2 Zimi uses, keeps its own view of the
disk under remote paths (as a container that mounts it elsewhere would), and
completes a download when the test says so.
"""

import http.server
import json
import os
import re
import sys
import threading
import time
import urllib.parse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import library, p2p  # noqa: E402
from zimi import btclient  # noqa: E402
from zimi import qbittorrent as qbt  # noqa: E402
from zimi.metalink import bencode  # noqa: E402

REMOTE_DL = "/downloads"
REMOTE_LIB = "/zims"


def _torrent(name, length=11):
    info = {
        b"name": name.encode(),
        b"length": length,
        b"piece length": 16384,
        b"pieces": b"x" * 20,
    }
    data = bencode({b"announce": b"http://t.invalid/a", b"info": info})
    return data, library._torrent_info_hash(data)


class FakeQbt:
    """State plus a threaded HTTP server. ``disk`` maps a remote root to the
    local directory it really is."""

    def __init__(self, disk, password=None, v5=True):
        self.disk = disk
        self.password = password
        self.v5 = v5
        self.torrents = {}
        self.categories = set()
        self.logins = 0
        fake = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body=b"", ctype="text/plain"):
                if isinstance(body, (dict, list)):
                    body, ctype = json.dumps(body).encode(), "application/json"
                elif isinstance(body, str):
                    body = body.encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                if getattr(self, "_cookie", None):
                    self.send_header("Set-Cookie", self._cookie)
                self.end_headers()
                self.wfile.write(body)

            def _authed(self):
                return fake.password is None or "SID=good" in (
                    self.headers.get("Cookie") or ""
                )

            def _form(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n)
                ctype = self.headers.get("Content-Type", "")
                if ctype.startswith("multipart/"):
                    boundary = ctype.split("boundary=")[1].encode()
                    out = {}
                    for part in raw.split(b"--" + boundary):
                        head, sep, body = part.partition(b"\r\n\r\n")
                        m = re.search(rb'name="([^"]+)"', head)
                        if sep and m:
                            out[m.group(1).decode()] = body[:-2] if body.endswith(b"\r\n") else body
                    return out
                return {k: v[0] for k, v in urllib.parse.parse_qs(raw.decode()).items()}

            def do_GET(self):
                self._route("GET")

            def do_POST(self):
                self._route("POST")

            def _route(self, method):
                u = urllib.parse.urlsplit(self.path)
                path, q = u.path[len("/api/v2/") :], {
                    k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()
                }
                form = self._form() if method == "POST" else {}
                if path == "auth/login":
                    fake.logins += 1
                    if form.get("password") == fake.password:
                        self._cookie = "SID=good; path=/"
                        return self._send(200, "Ok.")
                    return self._send(200, "Fails.")
                if not self._authed():
                    return self._send(403, "Forbidden")
                return fake.handle(self, path, q, form)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def local(self, remote):
        for r, l in self.disk.items():
            if remote == r or remote.startswith(r + "/"):
                return l + remote[len(r) :]
        raise AssertionError(f"fake qBittorrent cannot see {remote}")

    def handle(self, h, path, q, form):
        if path == "app/version":
            return h._send(200, "v5.2.3" if self.v5 else "v4.6.7")
        if path == "app/webapiVersion":
            return h._send(200, "2.11.4" if self.v5 else "2.9.3")
        if path == "app/preferences":
            return h._send(200, {"save_path": REMOTE_DL + "/"})
        if path == "torrents/createCategory":
            if form["category"] in self.categories:
                return h._send(409, "exists")
            self.categories.add(form["category"])
            return h._send(200)
        if path == "torrents/add":
            data = form.pop("torrents")
            form = {k: v.decode() if isinstance(v, bytes) else v for k, v in form.items()}
            tid = library._torrent_info_hash(data)
            m = re.search(rb"4:name(\d+):", data)
            name = data[m.end(): m.end() + int(m.group(1))].decode()
            save = form.get("savepath") or f"{REMOTE_DL}/{form['category']}"
            self.torrents[tid] = {
                "hash": tid, "name": name, "category": form["category"],
                "save_path": save, "content_path": f"{save}/{name}", "state": "downloading",
                "progress": 0.0, "size": 11, "completed": 0, "uploaded": 0,
                "num_seeds": 1, "num_leechs": 0, "skip": form.get("skip_checking"),
            }
            # 5.2 answers with counts; earlier versions with "Ok.".
            if self.v5:
                return h._send(200, {"added_torrent_ids": [tid], "failure_count": 0, "pending_count": 0, "success_count": 1})
            return h._send(200, "Ok.")
        if path == "torrents/info":
            rows = list(self.torrents.values())
            if "hashes" in q:
                rows = [t for t in rows if t["hash"] in q["hashes"].split("|")]
            if "category" in q:
                rows = [t for t in rows if t["category"] == q["category"]]
            return h._send(200, rows)
        if path == "torrents/delete":
            t = self.torrents.pop(form["hashes"])
            if form["deleteFiles"] == "true" and os.path.exists(self.local(t["content_path"])):
                os.remove(self.local(t["content_path"]))
            return h._send(200)
        if path == "torrents/setLocation":
            t = self.torrents[form["hashes"]]
            src = self.local(t["content_path"])
            t["save_path"] = form["location"]
            t["content_path"] = f"{form['location']}/{t['name']}"
            os.replace(src, self.local(t["content_path"]))
            return h._send(200)
        if path == "torrents/setShareLimits":
            # qBittorrent 5.2 refuses the call without these (a real 5.2.3
            # answered "Missing required parameters: shareLimitAction").
            missing = [k for k in ("inactiveSeedingTimeLimit", "shareLimitAction") if k not in form]
            if self.v5 and missing:
                return h._send(400, "Missing required parameters: " + ", ".join(missing))
            for x in form["hashes"].split("|"):
                self.torrents[x]["limits"] = (
                    form["ratioLimit"], form["seedingTimeLimit"], form.get("shareLimitAction")
                )
            return h._send(200)
        if path == "torrents/setAutoManagement":
            return h._send(200)
        if path == "torrents/setCategory":
            if form["category"] not in self.categories:
                return h._send(409, "no such category")
            for x in form["hashes"].split("|"):
                self.torrents[x]["category"] = form["category"]
            return h._send(200)
        if path in ("torrents/stop", "torrents/start") and not self.v5:
            return h._send(404)
        if path in ("torrents/stop", "torrents/pause"):
            self.torrents[form["hashes"]]["state"] = (
                "stoppedDL" if self.v5 else "pausedDL"
            )
            return h._send(200)
        if path in ("torrents/start", "torrents/resume"):
            self.torrents[form["hashes"]]["state"] = "downloading"
            return h._send(200)
        return h._send(404)

    def finish(self, tid, payload=b"hello world"):
        t = self.torrents[tid]
        path = self.local(t["content_path"])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(payload)
        t.update(state="stalledUP", progress=1.0, completed=t["size"])

    def close(self):
        self.server.shutdown()


@pytest.fixture
def world(tmp_path):
    dl_local = tmp_path / "qbt-downloads"
    lib_local = tmp_path / "library"
    staging = tmp_path / "staging"
    for d in (dl_local, lib_local, staging):
        d.mkdir()
    fake = FakeQbt({REMOTE_DL: str(dl_local), REMOTE_LIB: str(lib_local)})
    yield fake, dl_local, lib_local, staging
    fake.close()


def _backend(fake, lib_local, staging, paths):
    cfg = {
        "kind": "qbittorrent",
        "url": fake.url,
        "user": "",
        "password": "",
        "category": "zimi",
        "paths": btclient.parse_paths(paths),
    }
    b = qbt.QBittorrentBackend(
        cfg, library_dir=str(lib_local), staging_dir=str(staging)
    )
    assert b.available()
    return b


def _write_torrent(tmp_path, name):
    data, tid = _torrent(name)
    p = tmp_path / (name + ".torrent")
    p.write_bytes(data)
    return str(p), tid


# ── paths ────────────────────────────────────────────────────────────────


def test_path_mappings_go_both_ways_and_prefer_the_longest(tmp_path):
    pairs = btclient.parse_paths(
        f"/downloads={tmp_path}/dl; /downloads/zimi={tmp_path}/z\n junk \n"
    )
    assert len(pairs) == 2
    assert btclient.to_local("/downloads/zimi/a.zim", pairs) == os.path.join(str(tmp_path), "z", "a.zim")
    assert btclient.to_local("/downloads/other/a.zim", pairs) == os.path.join(str(tmp_path), "dl", "other", "a.zim")
    assert btclient.to_remote(f"{tmp_path}/z/a.zim", pairs) == "/downloads/zimi/a.zim"
    # Unmapped: the same path locally (the *arr default), unknown remotely.
    assert btclient.to_local("/elsewhere/a.zim", pairs) == "/elsewhere/a.zim"
    assert btclient.to_remote("/elsewhere/a.zim", pairs) is None


def test_a_windows_qbittorrent_maps_to_posix_paths(tmp_path):
    pairs = btclient.parse_paths(f"D:\\Torrents={tmp_path}/t")
    assert btclient.to_local("D:\\Torrents\\zimi\\a.zim", pairs) == os.path.join(
        str(tmp_path), "t", "zimi", "a.zim"
    )
    assert btclient.to_remote(f"{tmp_path}/t/zimi", pairs) == "D:\\Torrents\\zimi"


# ── the client ──────────────────────────────────────────────────────────


def test_logs_in_when_asked_and_says_so_when_the_password_is_wrong(tmp_path):
    fake = FakeQbt({REMOTE_DL: str(tmp_path)}, password="s3cret")
    try:
        assert qbt.Client(fake.url, "admin", "s3cret").text("app/version") == "v5.2.3"
        assert fake.logins == 1
        with pytest.raises(btclient.ClientError, match="refused the username or password"):
            qbt.Client(fake.url, "admin", "wrong").text("app/version")
    finally:
        fake.close()


def test_probe_reports_what_zimi_can_see(world):
    fake, dl_local, lib_local, _ = world
    cfg = {"kind": "qbittorrent", "url": fake.url, "user": "", "password": "", "category": "zimi", "paths": []}
    got = btclient.probe(cfg, library_dir=str(lib_local))
    assert got["ok"] and got["version"] == "v5.2.3"
    assert not got["visible"] and not got["library_mapped"]
    cfg["paths"] = btclient.parse_paths(f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}")
    got = btclient.probe(cfg, library_dir=str(lib_local))
    assert got["visible"] and got["library_mapped"]
    bad = btclient.probe(dict(cfg, url="http://127.0.0.1:9"), library_dir=None)
    # A key the page words in its own language; the details stay in the log.
    assert not bad["ok"] and bad["error_key"] == "btc_err_unreachable" and "error" not in bad


# ── the engine ──────────────────────────────────────────────────────────


def test_a_download_lands_in_zimis_category_where_both_can_see_it(world, tmp_path):
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local}")
    src, tid = _write_torrent(tmp_path, "wiki.zim")
    assert b.add_torrent(src, dest_dir=str(staging)) == tid
    t = fake.torrents[tid]
    assert t["category"] == "zimi" and "zimi" in fake.categories
    # Staging is not mapped, so the category's own folder.
    assert t["save_path"] == f"{REMOTE_DL}/zimi"
    assert b.status(tid)["state"] == "downloading"
    # A restart adding it again finds it.
    assert b.add_torrent(src, dest_dir=str(staging)) == tid
    assert len(fake.torrents) == 1
    b.pause(tid)
    assert b.status(tid)["state"] == "paused"
    b.resume(tid)
    fake.finish(tid)
    assert b.status(tid)["state"] == "complete"
    assert b.payload_path(tid, "wiki.zim", str(staging)) == str(
        dl_local / "zimi" / "wiki.zim"
    )


def test_qbittorrent_4_pauses_and_resumes(tmp_path):
    fake = FakeQbt({REMOTE_DL: str(tmp_path)}, v5=False)
    try:
        b = _backend(fake, tmp_path / "lib", tmp_path, "")
        src, tid = _write_torrent(tmp_path, "w.zim")
        b.add_torrent(src, dest_dir=str(tmp_path))
        b.pause(tid)
        assert b.status(tid)["state"] == "paused"
        b.resume(tid)
        assert b.status(tid)["state"] == "downloading"
    finally:
        fake.close()


def test_with_the_library_mapped_qbittorrent_moves_it_in_and_keeps_seeding(
    world, tmp_path
):
    fake, dl_local, lib_local, staging = world
    b = _backend(
        fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}"
    )
    src, tid = _write_torrent(tmp_path, "wiki.zim")
    b.add_torrent(src, dest_dir=str(staging))
    fake.finish(tid)
    payload = b.payload_path(tid, "wiki.zim", str(staging))
    dest = str(lib_local / "wiki.zim")
    assert b.install(tid, payload, dest) == tid
    assert open(dest, "rb").read() == b"hello world"
    assert not os.path.exists(payload)
    assert fake.torrents[tid]["save_path"] == REMOTE_LIB
    # Stopping the seed never deletes a library file.
    b.remove(tid, delete_files=True)
    assert tid not in fake.torrents and os.path.exists(dest)


def test_without_the_library_mapped_zimi_links_it_out_and_qbittorrent_keeps_its_own(
    world, tmp_path
):
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local}")
    src, tid = _write_torrent(tmp_path, "wiki.zim")
    b.add_torrent(src, dest_dir=str(staging))
    fake.finish(tid)
    payload = b.payload_path(tid, "wiki.zim", str(staging))
    dest = str(lib_local / "wiki.zim")
    b.install(tid, payload, dest)
    assert os.path.exists(dest) and os.path.exists(payload)
    # Its own copy goes with the torrent; the library's stays.
    b.remove(tid, delete_files=True)
    assert not os.path.exists(payload) and os.path.exists(dest)


def test_a_library_mapping_removed_later_never_lets_the_client_delete_the_zim(world, tmp_path):
    """Seeding a library ZIM in place, then the library folder's mapping is
    removed (or mistyped) in Settings: the client's path no longer translates,
    and a seed stop with files must not delete the ZIM through its mount."""
    fake, dl_local, lib_local, staging = world
    both = f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}"
    b = _backend(fake, lib_local, staging, both)
    removed, mistyped = f"{REMOTE_DL}={dl_local}", f"{REMOTE_DL}={dl_local};{REMOTE_LIB}x={lib_local}"
    for name, paths in (("wiki.zim", removed), ("other.zim", mistyped)):
        src, tid = _write_torrent(tmp_path, name)
        b.add_torrent(src, dest_dir=str(staging))
        fake.finish(tid)
        dest = str(lib_local / name)
        b.install(tid, b.payload_path(tid, name, str(staging)), dest)
        _backend(fake, lib_local, staging, paths).remove(tid, delete_files=True)
        assert tid not in fake.torrents and os.path.exists(dest), paths


def test_a_hand_over_with_the_library_unmapped_keeps_an_unfinished_library_seed(world, tmp_path):
    """A library seed that is not whole (a recheck found it differs) is
    in-flight to release(); with the library's mapping gone its path does not
    translate, and the hand-over must not have the client delete it."""
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}")
    src, tid = _write_torrent(tmp_path, "wiki.zim")
    b.add_torrent(src, dest_dir=str(staging))
    fake.finish(tid)
    dest = str(lib_local / "wiki.zim")
    b.install(tid, b.payload_path(tid, "wiki.zim", str(staging)), dest)
    fake.torrents[tid].update(state="downloading", progress=0.5, completed=5)
    _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local}").release()
    assert tid not in fake.torrents and os.path.exists(dest)


def test_a_finished_copy_paused_in_the_client_is_still_a_seeder(world, tmp_path):
    """Complete is about the data, not the run state: a paused finished copy
    still counts against the ratio cap and is retired with its library file."""
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local}")
    src, tid = _write_torrent(tmp_path, "wiki.zim")
    b.add_torrent(src, dest_dir=str(staging))
    fake.finish(tid)
    b.pause(tid)
    (row,) = b.list_managed()
    assert (row["status"], row["seeder"]) == ("paused", "true")


def test_seeding_the_library_needs_qbittorrent_to_see_it(world, tmp_path):
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local}")
    src, _ = _write_torrent(tmp_path, "wiki.zim")
    with pytest.raises(btclient.ClientError, match="cannot see the library"):
        b.add_torrent(src, dest_dir=str(lib_local))
    b = _backend(
        fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}"
    )
    tid = b.add_torrent(src, dest_dir=str(lib_local), options={"seed_mode": True})
    t = fake.torrents[tid]
    assert t["save_path"] == REMOTE_LIB and t["skip"] == "true"


def test_never_touches_a_torrent_outside_its_category(world, tmp_path):
    fake, dl_local, lib_local, staging = world
    b = _backend(fake, lib_local, staging, f"{REMOTE_DL}={dl_local}")
    fake.torrents["f" * 40] = {
        "hash": "f" * 40,
        "category": "tv",
        "content_path": f"{REMOTE_DL}/tv/x",
        "state": "uploading",
        "progress": 1.0,
        "size": 1,
    }
    b.remove("f" * 40, delete_files=True)
    assert "f" * 40 in fake.torrents
    assert b.list_managed() == []


def test_the_download_loop_installs_through_qbittorrent(world, tmp_path, monkeypatch):
    """library._try_bt_download end to end with the external engine: the
    file arrives in the library and qBittorrent keeps seeding it there."""
    fake, dl_local, lib_local, staging = world
    b = _backend(
        fake, lib_local, staging, f"{REMOTE_DL}={dl_local};{REMOTE_LIB}={lib_local}"
    )
    src, tid = _write_torrent(tmp_path, "wiki.zim")
    monkeypatch.setattr(library._srv, "open_archive", lambda path: object())
    monkeypatch.setattr(p2p, "is_seeding_enabled", lambda: True)
    monkeypatch.setattr(p2p, "get_seed_ratio_cap", lambda: 1.0)
    seeded = []
    monkeypatch.setattr(
        library, "record_seed", lambda f, origin="download": seeded.append(f)
    )
    monkeypatch.setattr(library, "_record_torrent_metadata", lambda *a, **k: None)
    dl = {
        "id": "1",
        "filename": "wiki.zim",
        "dest": str(lib_local / "wiki.zim"),
        "started": time.time(),
    }
    threading.Timer(0.3, fake.finish, args=(tid,)).start()
    got = library._try_bt_download(
        b, dl, torrent_url=src, staging_dir=str(staging), poll_interval=0.05
    )
    assert got == "success"
    assert open(dl["dest"], "rb").read() == b"hello world"
    assert fake.torrents[tid]["save_path"] == REMOTE_LIB
    assert seeded == ["wiki.zim"] and dl["bt_gid"] == tid


def test_settings_pick_the_engine_and_never_hand_back_the_password(
    tmp_path, monkeypatch
):
    for k in btclient.ENV.values():
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(p2p, "_prefs_path", str(tmp_path / "prefs.json"))
    assert btclient.config() is None and p2p.engine_name() == "libtorrent"
    for k, v in (
        ("url", "http://qbt:8080/"),
        ("password", "pw"),
        ("paths", "/downloads=/data/dl"),
    ):
        p2p.set_pref(btclient.PREF[k], v)
    cfg = btclient.config()
    assert cfg["url"] == "http://qbt:8080" and cfg["category"] == "zimi"
    assert cfg["paths"] == [("/downloads", "/data/dl")]
    assert p2p.engine_name() == "qbittorrent"
    from zimi import manage

    view = manage._btc_view()
    assert view["password_set"] is True and "pw" not in json.dumps(view)
    # The environment owns it when set.
    monkeypatch.setenv("ZIMI_BT_CLIENT_URL", "http://other:8080")
    assert (
        btclient.config()["url"] == "http://other:8080"
        and manage._btc_locked() == "ZIMI_BT_CLIENT_URL"
    )


def test_while_anyone_can_change_settings_the_connection_comes_only_from_the_environment(monkeypatch):
    from zimi import manage

    for k in btclient.ENV.values():
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(manage, "manage_open", lambda: True)
    monkeypatch.setattr(manage, "manage_open_env", lambda: None)
    assert manage._btc_locked() == "open"
    monkeypatch.setattr(manage, "manage_open_env", lambda: True)
    assert manage._btc_locked() is None


def test_reads_both_answers_to_an_add():
    assert qbt._added(b"Ok.")
    assert qbt._added(b'{"added_torrent_ids":["ab"],"failure_count":0,"pending_count":0,"success_count":1}')
    assert qbt._added(b'{"failure_count":0,"pending_count":1,"success_count":0}')
    assert not qbt._added(b"Fails.")
    assert not qbt._added(b'{"failure_count":1,"pending_count":0,"success_count":0}')
