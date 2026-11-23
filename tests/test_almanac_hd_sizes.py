"""Almanac HD in two sizes: HD (one file under 2 GiB) and Maximum (zimsplit chunks), one installed at a time.

Maximum's chunks are fetched into a hidden folder of the library, each checked against its sha256, and the whole book
is checked before it replaces HD (and HD replaces Maximum the same way). The 1.16 development set (the flavour plus
parts) is still read, and once a size replaces it, what it leaves is listed with the older copies, never deleted.

Run: pytest tests/test_almanac_hd_sizes.py -v
"""

import hashlib
import json
import os
import shutil
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from conftest_zim import build_fixture_zim, remove_zim_file, split_fixture_zim  # noqa: E402

from zimi import almanachd, library, outbound  # noqa: E402

HD_FILE = "zimi_almanac_maxi_2026-11c.zim"
MAX_FILE = "zimi_almanac_ultra_2026-11c.zim"


def _sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def _rel(max_entry=None):
    rel = {
        "file": HD_FILE,
        "size": 1_990_000_000,
        "sha256": "ab" * 32,
        "tag": "v1.16.0",
    }
    if max_entry:
        rel["max"] = max_entry
    return rel


MAX = {
    "file": MAX_FILE,
    "size": 4_000_000_000,
    "sha256": "cd" * 32,
    "chunks": [
        {"file": MAX_FILE + "aa", "size": 2_000_000_000, "sha256": "01" * 32},
        {"file": MAX_FILE + "ab", "size": 2_000_000_000, "sha256": "02" * 32},
    ],
}


@pytest.fixture
def prefs(monkeypatch):
    from zimi import manage

    saved = {}
    monkeypatch.setattr(manage, "_read_app_update_prefs", lambda: dict(saved))
    monkeypatch.setattr(
        manage, "_write_app_update_prefs", lambda **kw: saved.update(kw)
    )
    monkeypatch.setattr(almanachd.POLICY, "_offline", lambda: False)
    monkeypatch.delenv(almanachd.ENV, raising=False)
    return saved


@pytest.fixture
def lib(tmp_path, monkeypatch, prefs):
    """A real library folder the server scans; the release names HD and Maximum."""
    from zimi import server as srv

    zdir = tmp_path / "zims"
    zdir.mkdir()
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(tmp_path / "data", exist_ok=True)
    monkeypatch.setenv("ZIMI_BUILTIN_ZIMS", "0")
    box = {"rel": _rel(MAX), "queued": []}
    monkeypatch.setattr(almanachd, "release", lambda read=False: box["rel"])

    def enqueue(url, mirrors, filename, size_bytes=None, extra=None):
        box["queued"].append(
            {"url": url, "filename": filename, "size_bytes": size_bytes, "extra": extra}
        )
        return str(len(box["queued"])), None

    monkeypatch.setattr(library, "_enqueue_zim_download", enqueue)
    monkeypatch.setattr(library, "_active_downloads", {})
    monkeypatch.setattr(library, "_download_queue", [])
    almanachd._just_queued.clear()
    box["dir"] = str(zdir)

    def scan():
        with srv._zim_lock:
            srv.load_cache(force=True)

    box["scan"] = scan
    scan()
    yield box
    with srv._zim_lock:
        srv._zim_files_cache = None


def test_the_manifest_lists_maximum_as_chunks_that_add_up():
    import zimi.server as srv

    v = "1.16.0"
    good = almanachd.parse_manifest(json.dumps(_rel(MAX)), version=v)
    assert (
        good["file"] == HD_FILE
        and good["max"]["file"] == MAX_FILE
        and len(good["max"]["chunks"]) == 2
    )
    # Out of order, a chunk at 2 GiB, or chunks that do not add up: no Maximum, HD still offered.
    for bad in (
        dict(MAX, chunks=[MAX["chunks"][1], MAX["chunks"][0]]),
        dict(MAX, chunks=[dict(MAX["chunks"][0], size=2**31), MAX["chunks"][1]]),
        dict(MAX, size=MAX["size"] + 1),
        dict(MAX, file="../evil.zim"),
    ):
        rel = almanachd.parse_manifest(json.dumps(_rel(bad)), version=v)
        assert rel and rel["file"] == HD_FILE and "max" not in rel, bad
    assert srv  # imported for the version default the parser reads


def test_both_sizes_are_offered_and_one_is_in_use(lib):
    st = almanachd.status()
    assert st["kind"] is None and set(st["offers"]) == {"hd", "max"}
    assert (
        st["offers"]["max"]["size"] == MAX["size"]
        and st["offer"]["size"] == _rel()["size"]
    )
    build_fixture_zim(os.path.join(lib["dir"], HD_FILE))
    lib["scan"]()
    st = almanachd.status()
    assert (
        st["kind"] == "hd"
        and st["installed"]
        and set(st["offers"]) == {"max"}
        and st["offer"] is None
    )


def test_choosing_maximum_fetches_each_chunk_into_a_hidden_folder_each_checked(
    lib, prefs
):
    dl_id, err = almanachd.start({"name": "admin"}, kind="max")
    assert err is None and dl_id == "1"
    names = [q["filename"] for q in lib["queued"]]
    assert names == [almanachd.STAGE_DIR + "/" + c["file"] for c in MAX["chunks"]]
    for q, c in zip(lib["queued"], MAX["chunks"]):
        assert (
            q["url"].endswith("/v1.16.0/" + c["file"]) and q["size_bytes"] == c["size"]
        )
        assert q["extra"]["_chunk"] and q["extra"]["_sha256"] == c["sha256"]
    assert prefs[almanachd.KIND_KEY] == "max"
    # Asked again while they come: nothing queued twice.
    almanachd.start({"name": "admin"}, kind="max")
    assert len(lib["queued"]) == 2
    # The scan never reads the staging folder.
    assert not almanachd.STAGE_DIR.replace(".", "").startswith(
        "/"
    ) and almanachd.STAGE_DIR.startswith(".")


def test_automatically_fetches_hd_unless_maximum_was_chosen(lib, prefs, monkeypatch):
    prefs[almanachd.POLICY.prefs_key] = outbound.AUTO
    monkeypatch.setattr(
        almanachd, "_manifest", {"rel": None, "tried": 0.0, "busy": False}
    )

    class Inline:
        def __init__(self, target, **kw):
            self.target = target

        def start(self):
            self.target()

    monkeypatch.setattr(almanachd.threading, "Thread", Inline)
    almanachd.on_almanac_open()
    assert [q["filename"] for q in lib["queued"]] == [HD_FILE]
    lib["queued"].clear()
    almanachd._just_queued.clear()
    prefs[almanachd.KIND_KEY] = "max"
    monkeypatch.setattr(
        almanachd, "_manifest", {"rel": None, "tried": 0.0, "busy": False}
    )
    almanachd.on_almanac_open()
    assert [q["filename"] for q in lib["queued"]] == [
        almanachd.STAGE_DIR + "/" + c["file"] for c in MAX["chunks"]
    ]


def _stage_real_maximum(lib, corrupt=False):
    """A real book, split between clusters, staged as Maximum's chunks; the release names their real sizes and sha256s."""
    tmp = os.path.join(lib["dir"], "..", "src")
    os.makedirs(tmp, exist_ok=True)
    book = build_fixture_zim(
        os.path.join(tmp, MAX_FILE),
        metadata={"Name": "zimi_almanac", "Flavour": "ultra"},
    )
    whole = _sha(book)
    chunks = split_fixture_zim(book, 4096)
    assert len(chunks) >= 2
    stage = os.path.join(lib["dir"], almanachd.STAGE_DIR)
    os.makedirs(stage, exist_ok=True)
    entry = {
        "file": MAX_FILE,
        "size": sum(os.path.getsize(c) for c in chunks),
        "sha256": "00" * 32 if corrupt else whole,
        "chunks": [
            {"file": os.path.basename(c), "size": os.path.getsize(c), "sha256": _sha(c)}
            for c in chunks
        ],
    }
    for c in chunks:
        shutil.move(c, os.path.join(stage, os.path.basename(c)))
    lib["rel"] = _rel(entry)
    return entry


def test_a_staged_maximum_is_checked_whole_then_replaces_hd(lib, prefs):
    build_fixture_zim(os.path.join(lib["dir"], HD_FILE))
    lib["scan"]()
    assert almanachd.current() == "hd"
    entry = _stage_real_maximum(lib)
    assert almanachd.finish_max() is True
    files = sorted(os.listdir(lib["dir"]))
    assert files == [
        c["file"] for c in entry["chunks"]
    ], files  # HD gone, the stage folder gone, the book in
    assert (
        almanachd.current() == "max"
        and almanachd.base() == "/w/%s/hd/" % almanachd.MAX_NAME
    )
    assert prefs[almanachd.KIND_KEY] == "max"
    row = almanachd.library_row()
    assert row["kind"] == "max" and [p["file"] for p in row["packs"]] == [MAX_FILE]


def test_a_maximum_that_fails_its_check_changes_nothing(lib):
    build_fixture_zim(os.path.join(lib["dir"], HD_FILE))
    lib["scan"]()
    _stage_real_maximum(lib, corrupt=True)
    assert almanachd.finish_max() is False
    assert os.path.exists(os.path.join(lib["dir"], HD_FILE))
    assert os.listdir(os.path.join(lib["dir"], almanachd.STAGE_DIR)) == []
    assert almanachd.current() == "hd"


def test_choosing_hd_removes_maximum_once_hd_is_in(lib, prefs, monkeypatch):
    from zimi import server as srv

    entry = _stage_real_maximum(lib)
    almanachd.finish_max()
    assert almanachd.current() == "max"
    build_fixture_zim(os.path.join(lib["dir"], HD_FILE))
    lib["scan"]()
    scans = []
    real_load = srv.load_cache
    monkeypatch.setattr(srv, "load_cache", lambda *a, **k: scans.append(k) or real_load(*a, **k))
    almanachd.on_installed("hd")
    assert scans == [], "the size switch rescanned the library under the lock"
    assert sorted(os.listdir(lib["dir"])) == [HD_FILE]
    assert almanachd.current() == "hd" and prefs[almanachd.KIND_KEY] == "hd"
    assert entry


def test_the_development_set_is_still_read_and_left_as_older_copies(lib, prefs):
    from zimi import server as srv

    old_core = "zimi_almanac_maxi_2026-11b.zim"
    old_part = "zimi_almanac_hd_moon_2026-11b.zim"
    build_fixture_zim(os.path.join(lib["dir"], old_core))
    build_fixture_zim(os.path.join(lib["dir"], old_part))
    lib["scan"]()
    assert almanachd.current() == "hd" and almanachd.parts_present() == {
        "moon": "zimi_almanac_hd_moon"
    }
    assert almanachd.superseded() == []
    # The new HD comes in: the old set is no longer read, and is listed, never removed.
    build_fixture_zim(os.path.join(lib["dir"], HD_FILE))
    lib["scan"]()
    almanachd.on_installed("hd")
    assert os.path.exists(os.path.join(lib["dir"], old_core)) and os.path.exists(
        os.path.join(lib["dir"], old_part)
    )
    assert almanachd.parts_present() == {}
    listed = {o["file"] for o in srv.older_copies()} | {
        o["file"] for o in almanachd.superseded()
    }
    assert {old_core, old_part} <= listed, listed
    row = almanachd.library_row()
    assert row["kind"] == "hd" and [p["file"] for p in row["packs"]] == [HD_FILE]


def test_a_chunk_resumes_after_a_restart_still_checked():
    chunk = MAX["chunks"][1]
    item = {
        "url": almanachd.RELEASE_URL.format(tag="v1.16.0", file=chunk["file"]),
        "filename": almanachd.STAGE_DIR + "/" + chunk["file"],
        "size_bytes": chunk["size"],
        "sha256": chunk["sha256"],
    }
    got = almanachd.saved_release(item)
    assert (
        got
        and got["chunk"]
        and got["url_file"] == chunk["file"]
        and got["sha256"] == chunk["sha256"]
    )
    # A chunk recorded outside the stage folder, or a name that is not a chunk of Maximum, is not ours.
    assert almanachd.saved_release(dict(item, filename=chunk["file"])) is None
    assert (
        almanachd.saved_release(dict(item, url=item["url"].replace("ultra", "other")))
        is None
    )


def test_a_chunk_is_not_opened_alone_as_a_zim():
    import inspect

    src = inspect.getsource(library._download_thread)
    assert 'if not dl.get("_chunk")' in src and "almanachd.finish_max(dl)" in src


def test_maximum_is_cut_between_clusters_and_its_manifest_names_every_chunk(tmp_path):
    sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))
    import build_almanac_maxi as maxi
    from libzim.reader import Archive

    book = build_fixture_zim(str(tmp_path / MAX_FILE))
    chunks = maxi.split_book(book, str(tmp_path / "out"), part=4096)
    assert len(chunks) >= 2 and [os.path.basename(c) for c in chunks] == almanachd.chunk_names(MAX_FILE)[: len(chunks)]
    starts = set(maxi.cluster_offsets(book))
    at = 0
    for c in chunks[:-1]:
        at += os.path.getsize(c)
        assert at in starts  # every cut is where a cluster begins
    a = Archive(chunks[0])
    assert a.has_fulltext_index and a.filesize == os.path.getsize(book)
    hd_file = build_fixture_zim(str(tmp_path / HD_FILE))
    out = maxi.write_manifest(hd_file, "v1.16.0", str(tmp_path), max_book=book, max_chunks=chunks)
    rel = almanachd.parse_manifest(open(out).read(), version="1.16.0")
    assert rel["max"]["sha256"] == _sha(book) and [c["file"] for c in rel["max"]["chunks"]] == [os.path.basename(c) for c in chunks]


def test_before_the_manifest_only_hd_is_offered_maximum_only_once_the_release_names_it(lib, monkeypatch, tmp_path):
    pin = tmp_path / "pin.json"
    pin_text = json.dumps({"file": "t.zim", "size": 201_724_127, "sha256": "ab" * 32, "tag": "v1.15.3",
                           "hd_size": 1_983_068_162, "max_size": 4_814_876_312})
    pin.write_text(pin_text, encoding="utf-8")
    monkeypatch.setattr(almanachd, "TILES_PIN", str(pin))
    monkeypatch.setattr(almanachd, "_version", lambda: "1.16.0")
    lib["rel"] = None
    st = almanachd.status()
    # The pin describes this code's own build, not what the running version's release carries (1.15.5's had no
    # Maximum and a 211 MB HD): Maximum waits for the manifest.
    assert st["offers"] == {"hd": {"size": 1_980_000_000, "approx": True}}
    assert st["offer"]["size"] == 1_980_000_000   # the line under the globe says the same
    # Once the manifest is read, the release's own figures.
    lib["rel"] = _rel(MAX)
    st = almanachd.status()
    assert st["offers"]["hd"] == {"size": _rel()["size"]} and st["offers"]["max"] == {"size": MAX["size"]}


def test_the_shipped_pin_names_both_sizes():
    pin = json.load(open(almanachd.TILES_PIN))
    assert pin["hd_size"] > 1_000_000_000 and pin["max_size"] > pin["hd_size"]


# ── Against a local fake release: the real manifest read, the real download queue, every way it can go wrong ──


class _Release:
    """A release on 127.0.0.1: the manifest and each file, with Range; ``corrupt`` serves wrong bytes for a file,
    ``drop`` closes a file's transfer half way the first time, ``gone`` answers 404 for a file (or, named by the
    manifest's own name, for the manifest), ``hold`` stops a file's transfer half way until ``go`` is set (``held``
    says it is stopped). Counts the requests per file and their Range."""

    def __init__(self, files, manifest):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        self.files, self.manifest, self.corrupt, self.drop, self.asked = dict(files), manifest, set(), set(), []
        self.gone, self.hold, self.held, self.go = set(), set(), threading.Event(), threading.Event()
        rel = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                name = self.path.rsplit("/", 1)[1]
                rng = self.headers.get("Range")
                rel.asked.append((name, rng))
                if name in rel.gone:
                    self.send_response(404)
                    self.end_headers()
                    return
                if name == "zimi_almanac_maxi.json":
                    body = json.dumps(rel.manifest).encode()
                elif name in rel.files:
                    body = rel.files[name]
                    if name in rel.corrupt:
                        body = bytes(len(body))
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                start = int(rng.split("=")[1].split("-")[0]) if rng else 0
                part = body[start:]
                self.send_response(206 if rng else 200)
                self.send_header("Content-Length", str(len(part)))
                if rng:
                    self.send_header("Content-Range", "bytes %d-%d/%d" % (start, len(body) - 1, len(body)))
                self.end_headers()
                if name in rel.hold:
                    self.wfile.write(part[: len(part) // 2])
                    self.wfile.flush()
                    rel.held.set()
                    rel.go.wait(30)
                    self.close_connection = True
                    return
                if name in rel.drop:
                    rel.drop.discard(name)
                    self.wfile.write(part[: len(part) // 2])
                    self.wfile.flush()
                    self.close_connection = True
                    return
                self.wfile.write(part)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d/{tag}/{file}" % self.httpd.server_address[1]

    def requests_for(self, name):
        return [r for n, r in self.asked if n == name]


@pytest.fixture
def real(tmp_path, monkeypatch, prefs):
    """HD installed, this version's release on a local server with Maximum as real chunks, the real queue."""
    from zimi import server as srv

    zdir = tmp_path / "zims"
    zdir.mkdir()
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(tmp_path / "data", exist_ok=True)
    monkeypatch.setenv("ZIMI_BUILTIN_ZIMS", "0")
    monkeypatch.setenv("ZIMI_TORRENT", "0")
    monkeypatch.setattr(srv, "ZIMI_VERSION", "1.16.0")
    monkeypatch.setattr(library, "_active_downloads", {})
    monkeypatch.setattr(library, "_download_queue", [])
    monkeypatch.setattr(almanachd, "_manifest", {"rel": None, "tried": 0.0, "busy": False})
    monkeypatch.setattr(almanachd, "_just_queued", {})
    monkeypatch.setattr(almanachd, "_last_error", {})
    build_fixture_zim(str(zdir / HD_FILE))
    src = tmp_path / "src"
    src.mkdir()
    book = build_fixture_zim(str(src / MAX_FILE), metadata={"Name": "zimi_almanac", "Flavour": "ultra"})
    whole = _sha(book)
    chunks = split_fixture_zim(book, 4096)
    files = {os.path.basename(c): open(c, "rb").read() for c in chunks}
    hd_bytes = open(zdir / HD_FILE, "rb").read()
    manifest = dict(_rel(), size=len(hd_bytes), sha256=hashlib.sha256(hd_bytes).hexdigest(), max={
        "file": MAX_FILE, "size": sum(len(b) for b in files.values()), "sha256": whole,
        "chunks": [{"file": n, "size": len(b), "sha256": hashlib.sha256(b).hexdigest()} for n, b in files.items()]})
    server = _Release(dict(files, **{HD_FILE: hd_bytes}), manifest)
    monkeypatch.setattr(almanachd, "RELEASE_URL", server.base)

    def scan():
        with srv._zim_lock:
            srv.load_cache(force=True)

    scan()
    server.scan, server.dir, server.names = scan, str(zdir), [n for n in files]
    yield server
    server.httpd.shutdown()
    with srv._zim_lock:
        srv._zim_files_cache = None


def _gone(path, timeout=10):
    """True once ``path`` is deleted. Windows keeps a chunk until the stalled transfer lets go of it, and the
    cleanup retries in the background, so this waits for it."""
    import time

    end = time.time() + timeout
    while os.path.exists(path) and time.time() < end:
        time.sleep(0.05)
    return not os.path.exists(path)


def _settle(timeout=30):
    """Until the queue has nothing of ours left running and any install has finished."""
    import time

    end = time.time() + timeout
    while time.time() < end:
        with library._download_lock:
            live = [d for d in list(library._active_downloads.values()) + list(library._download_queue)
                    if not d.get("done")]
        if not live and not almanachd._finish_lock.locked():
            time.sleep(0.2)
            return
        time.sleep(0.05)
    raise AssertionError("downloads did not settle")


def _choose_max():
    almanachd.start({"name": "admin"}, kind="max")
    _settle()


def test_maximum_comes_in_from_the_release_checked_and_hd_goes_only_then(real):
    assert almanachd.current() == "hd"
    _choose_max()
    assert almanachd.current() == "max", almanachd.status().get("error")
    assert sorted(os.listdir(real.dir)) == sorted(real.names)   # HD removed, the stage folder gone
    assert not almanachd.status().get("error")


def test_a_release_without_maximum_is_not_offered_and_choosing_it_says_so(real, caplog):
    real.manifest.pop("max")
    almanachd.release(read=True)
    st = almanachd.status()
    assert "max" not in st["offers"]
    with caplog.at_level("WARNING", logger="zimi"):
        assert almanachd.start({"name": "admin"}, kind="max") == (None, "unavailable")
    assert almanachd.status()["error"] == {"kind": "max", "reason": "missing"}
    assert any("Maximum did not come in: missing" in r.getMessage() for r in caplog.records)
    assert almanachd.current() == "hd"


def test_a_damaged_chunk_is_said_hd_stays_and_a_retry_fetches_only_that_chunk(real):
    bad = real.names[1]
    real.corrupt.add(bad)
    _choose_max()
    st = almanachd.status()
    assert st["error"] == {"kind": "max", "reason": "checksum"} and almanachd.current() == "hd"
    assert os.path.exists(os.path.join(real.dir, HD_FILE))
    real.corrupt.clear()
    _choose_max()
    assert almanachd.current() == "max"
    assert len(real.requests_for(real.names[0])) == 1   # the good chunk was not fetched again
    assert len(real.requests_for(bad)) == 2


def test_a_book_that_is_not_the_releases_is_refused_whole_and_hd_stays(real):
    real.manifest["max"]["sha256"] = "00" * 32
    _choose_max()
    assert almanachd.status()["error"] == {"kind": "max", "reason": "checksum"}
    assert almanachd.current() == "hd" and os.listdir(os.path.join(real.dir, almanachd.STAGE_DIR)) == []


def test_a_dropped_connection_is_said_and_the_retry_resumes_the_chunk_where_it_stopped(real):
    cut = real.names[1]
    real.drop.add(cut)
    _choose_max()
    assert almanachd.status()["error"] == {"kind": "max", "reason": "network"} and almanachd.current() == "hd"
    _choose_max()
    assert almanachd.current() == "max"
    first, second = real.requests_for(cut)
    assert first is None and second and second.startswith("bytes=") and not second.startswith("bytes=0-")
    assert len(real.requests_for(real.names[0])) == 1


def test_a_full_disk_is_said(real, monkeypatch):
    monkeypatch.setattr(library, "_refuse_for_disk_space", lambda size, dest=None: "Not enough disk space (1 MB free, 5 MB needed)")
    almanachd.start({"name": "admin"}, kind="max")
    assert almanachd.status()["error"] == {"kind": "max", "reason": "disk"} and almanachd.current() == "hd"


def test_a_restart_mid_download_resumes_only_what_is_missing(real):
    # As a restart finds it: the first chunk staged whole, the second half there.
    stage = os.path.join(real.dir, almanachd.STAGE_DIR)
    os.makedirs(stage)
    with open(os.path.join(stage, real.names[0]), "wb") as f:
        f.write(real.files[real.names[0]])
    with open(os.path.join(stage, real.names[1]) + ".tmp", "wb") as f:
        f.write(real.files[real.names[1]][:1000])
    _choose_max()
    assert almanachd.current() == "max"
    assert real.requests_for(real.names[0]) == []
    assert real.requests_for(real.names[1]) == ["bytes=1000-"]


def test_automatically_fetches_at_once_when_the_manifest_was_already_read(real, prefs, monkeypatch):
    import zimi.server as srv

    remove_zim_file(os.path.join(real.dir, HD_FILE))
    real.scan()
    almanachd.release(read=True)   # read moments ago (Ask first's yes, say): no six-hour wait
    prefs[almanachd.POLICY.prefs_key] = outbound.AUTO
    almanachd.on_almanac_open()
    _settle()
    assert almanachd.current() == "hd" and srv  # HD fetched and in


def test_a_chunk_that_fails_the_instant_it_is_queued_is_fetched_again_on_retry(lib, monkeypatch):
    # The queue can end a transfer (404, refused) before start() has returned from queueing it; the note that it was
    # "just queued" must not outlive that failure, or the retry is skipped as already on its way for a minute.
    fail = {"on": True}
    queued = []

    def enqueue(url, mirrors, filename, size_bytes=None, extra=None):
        queued.append(filename)
        if fail["on"]:
            almanachd.on_failed({"filename": filename}, "network", "HTTP 404")
        return str(len(queued)), None

    monkeypatch.setattr(library, "_enqueue_zim_download", enqueue)
    almanachd.start({"name": "admin"}, kind="max")
    first = len(queued)
    fail["on"] = False
    almanachd.start({"name": "admin"}, kind="max")
    assert first >= 1 and len(queued) > first


# ── Every failure is said, HD stays, and nothing half-written is read as a book ──


def _no_half_book(real):
    """Whatever happened, the library holds no part of Maximum a scan could read, and HD is still what is in use."""
    real.scan()
    assert almanachd.MAX_NAME not in almanachd._have()
    assert not [f for f in os.listdir(real.dir) if f.startswith("zimi_almanac_ultra")]
    assert almanachd.current() == "hd" and os.path.exists(os.path.join(real.dir, HD_FILE))


def _said(real, caplog, reason, text):
    st = almanachd.status()
    assert st["error"] == {"kind": "max", "reason": reason}, st
    assert any(text in r.getMessage() for r in caplog.records if r.levelname in ("WARNING", "ERROR")), [r.getMessage() for r in caplog.records]
    _no_half_book(real)


def test_a_manifest_that_cannot_be_reached_is_said_as_the_network_not_as_a_missing_release(real, caplog):
    real.httpd.shutdown()
    real.httpd.server_close()
    almanachd._manifest.update(rel=None, tried=0.0, why=None)
    with caplog.at_level("INFO", logger="zimi"):
        assert almanachd.start({"name": "admin"}, kind="max") == (None, "unavailable")
    _said(real, caplog, "network", "could not read the release manifest")
    assert not almanachd.status()["missing"]   # unreachable is not "this version has none": nothing says it is absent


def test_a_manifest_that_is_not_on_the_release_is_said_as_missing(real, caplog):
    real.gone.add("zimi_almanac_maxi.json")
    almanachd._manifest.update(rel=None, tried=0.0, why=None)
    with caplog.at_level("INFO", logger="zimi"):
        almanachd.start({"name": "admin"}, kind="max")
    _said(real, caplog, "missing", "could not read the release manifest")


def test_a_chunk_that_is_not_on_the_release_is_said_and_a_retry_fetches_only_it(real, caplog):
    gone = real.names[1]
    real.gone.add(gone)
    with caplog.at_level("INFO", logger="zimi"):
        _choose_max()
    _said(real, caplog, "missing", "did not come in: missing")
    real.gone.clear()
    _choose_max()
    assert almanachd.current() == "max"
    assert len(real.requests_for(real.names[0])) == 1


def test_every_failure_leaves_no_half_book_and_no_hd_change(real, caplog):
    real.corrupt.add(real.names[0])
    with caplog.at_level("INFO", logger="zimi"):
        _choose_max()
    _said(real, caplog, "checksum", "did not come in: checksum")
    assert not os.path.exists(os.path.join(real.dir, almanachd.STAGE_DIR, real.names[0]))   # a damaged chunk is not kept


def test_zimi_offline_fetches_nothing_and_says_so(real, caplog):
    almanachd.POLICY._offline = lambda: True
    with caplog.at_level("INFO", logger="zimi"):
        assert almanachd.start({"name": "admin"}, kind="max") == (None, "never")
    assert real.asked == []
    assert any("not fetched" in r.getMessage() and "ZIMI_OFFLINE" in r.getMessage() for r in caplog.records)
    st = almanachd.status()
    assert st["offers"] == {} and st["mode"] == outbound.NEVER
    _no_half_book(real)


def test_choosing_hd_again_while_maximum_comes_in_stops_it_and_hd_stays(real, caplog, monkeypatch):
    monkeypatch.setattr(almanachd, "CANCEL_WAIT_S", 0.5)   # the held transfer is stuck mid-read, as a stalled one is
    real.hold.add(real.names[1])
    almanachd.start({"name": "admin"}, kind="max")
    assert real.held.wait(20)
    stage = os.path.join(real.dir, almanachd.STAGE_DIR)
    assert almanachd.status()["downloading"]["kind"] == "max" and os.path.isdir(stage)
    with caplog.at_level("INFO", logger="zimi"):
        assert almanachd.start({"name": "admin"}, kind="hd") == (None, "installed")   # HD is in use: this is Cancel
    real.go.set()
    _settle()
    assert almanachd.status()["downloading"] is None and _gone(stage)
    assert almanachd.chosen() == "max" or almanachd.current() == "hd"
    assert any("stopped fetching Maximum" in r.getMessage() for r in caplog.records)
    assert not almanachd.status().get("error")
    _no_half_book(real)
    # Maximum can still be had later, from the start.
    real.hold.clear()
    _choose_max()
    assert almanachd.current() == "max"


def test_cancel_stops_what_is_coming_and_clears_the_stage(real, monkeypatch):
    monkeypatch.setattr(almanachd, "CANCEL_WAIT_S", 0.5)
    real.hold.add(real.names[1])
    almanachd.start({"name": "admin"}, kind="max")
    assert real.held.wait(20)
    almanachd.cancel()
    real.go.set()
    _settle()
    assert _gone(os.path.join(real.dir, almanachd.STAGE_DIR))
    assert almanachd.status()["downloading"] is None
    _no_half_book(real)


def test_manage_says_why_a_size_did_not_come(real):
    """/manage/tidy carries the same error the gear shows, for Manage to say in words."""
    from http.server import ThreadingHTTPServer
    import threading
    import urllib.request

    from zimi.http import ZimHandler

    real.corrupt.add(real.names[1])
    _choose_max()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        body = json.load(urllib.request.urlopen("http://127.0.0.1:%d/manage/tidy" % httpd.server_address[1]))
    finally:
        httpd.shutdown()
    assert body["almanac_hd_error"] == {"kind": "max", "reason": "checksum"}, body


# ── What is said before the manifest is read, a choice saved by an older build, and a release served from elsewhere ──


def _pin(tmp_path, monkeypatch):
    pin = tmp_path / "pin.json"
    pin.write_text(json.dumps({"file": "t.zim", "size": 201_724_127, "sha256": "ab" * 32, "tag": "v1.15.3",
                               "hd_size": 1_983_068_162, "max_size": 4_814_876_312}), encoding="utf-8")
    monkeypatch.setattr(almanachd, "TILES_PIN", str(pin))


@pytest.mark.parametrize("version, size", [("1.15.5", None), ("1.15.6", None), ("1.16.0", 1_980_000_000)])
def test_the_size_shown_before_the_manifest_is_read_is_only_one_that_is_true(lib, monkeypatch, tmp_path, version, size):
    """The pin's sizes are 1.16's files (HD 1.98 GB); 1.15's HD was 211 MB. A version not built from the pin claims none."""
    _pin(tmp_path, monkeypatch)
    monkeypatch.setattr(almanachd, "_version", lambda: version)
    lib["rel"] = None
    st = almanachd.status()
    assert st["offers"] == {"hd": ({"size": size, "approx": True} if size else {"size": None})}
    assert st["offer"]["size"] == size and "max" not in st["offers"]


def test_a_maximum_saved_by_an_older_build_falls_back_to_hd_under_automatically_and_says_so_once(lib, prefs, caplog):
    prefs[almanachd.KIND_KEY] = "max"                       # the owner's server: saved before it was known
    prefs[almanachd.POLICY.prefs_key] = outbound.AUTO
    lib["rel"] = _rel()                                      # this version's release has HD and no Maximum
    with caplog.at_level("INFO", logger="zimi"):
        almanachd._auto_start()
        assert almanachd.error() == {"kind": "max", "reason": "missing"}   # the gear says it...
        almanachd._auto_start()                                            # ...and the next visit does not repeat it
    fetched = [q["filename"] for q in lib["queued"]]
    assert HD_FILE in fetched and not [f for f in fetched if "ultra" in f]
    assert prefs[almanachd.KIND_KEY] == "hd"                 # put back: the next visit does not say it again
    said = [r for r in caplog.records if "Maximum did not come in: missing" in r.getMessage()]
    assert len(said) == 1


def test_an_unreachable_release_keeps_a_saved_maximum(lib, prefs):
    prefs[almanachd.KIND_KEY] = "max"
    prefs[almanachd.POLICY.prefs_key] = outbound.AUTO
    lib["rel"] = None                                        # could not be read: no reason to give up the choice
    almanachd._auto_start()
    assert prefs[almanachd.KIND_KEY] == "max"


def test_a_release_can_be_served_from_an_address_of_ones_own(monkeypatch):
    monkeypatch.setattr(almanachd, "_version", lambda: "1.16.0")
    assert almanachd.manifest_url().startswith("https://github.com/epheterson/Zimi/releases/download/v1.16.0/")
    monkeypatch.setenv(almanachd.URL_ENV, "http://192.168.1.20:8000/{file}")
    assert almanachd.manifest_url() == "http://192.168.1.20:8000/zimi_almanac_maxi.json"
    assert almanachd.url({"tag": "v1.16.0", "file": HD_FILE}) == "http://192.168.1.20:8000/" + HD_FILE
    monkeypatch.setenv(almanachd.URL_ENV, "http://nas.lan/{tag}/{file}")
    assert almanachd.manifest_url() == "http://nas.lan/v1.16.0/zimi_almanac_maxi.json"
    # A restart resumes a chunk the address recorded, and only that address's.
    link = almanachd.url({"tag": "v1.16.0", "file": MAX_FILE + "aa"})
    saved = {"url": link, "size_bytes": 5, "sha256": "ab" * 32, "filename": almanachd.STAGE_DIR + "/" + MAX_FILE + "aa"}
    assert almanachd.saved_release(saved)["chunk"] and almanachd.saved_release(saved)["tag"] == "v1.16.0"
    monkeypatch.delenv(almanachd.URL_ENV)
    assert almanachd.saved_release(saved) is None
    monkeypatch.setenv(almanachd.URL_ENV, "http://192.168.1.20:8000/{file}")
    plain = dict(saved, url=almanachd.url({"tag": "v1.16.0", "file": MAX_FILE + "aa"}))
    assert almanachd.saved_release(plain)["tag"] == "v1.16.0"


@pytest.mark.parametrize("bad", ["ftp://x/{file}", "http://x/nofile", "file:///{file}", "http://x/{file}/{evil}"])
def test_an_address_that_is_not_http_with_a_file_is_ignored_and_said(monkeypatch, caplog, bad):
    monkeypatch.setenv(almanachd.URL_ENV, bad)
    with caplog.at_level("WARNING", logger="zimi"):
        assert almanachd.release_url_template() == almanachd.RELEASE_URL
    assert any(almanachd.URL_ENV in r.getMessage() for r in caplog.records)


def test_zimi_offline_still_wins_over_an_address_of_ones_own(real, monkeypatch):
    monkeypatch.setenv(almanachd.URL_ENV, real.base)
    almanachd.POLICY._offline = lambda: True
    assert almanachd.start({"name": "admin"}, kind="max") == (None, "never") and real.asked == []


def test_maximum_comes_in_from_an_address_of_ones_own_and_not_from_github(real, monkeypatch):
    monkeypatch.setattr(almanachd, "RELEASE_URL", "https://github.com/epheterson/Zimi/releases/download/{tag}/{file}")
    monkeypatch.setenv(almanachd.URL_ENV, real.base)
    _choose_max()
    assert almanachd.current() == "max", almanachd.status().get("error")
    assert real.requests_for(real.names[0]) == [None]


def test_only_the_data_sets_own_names_are_exempt_from_the_rate_limit():
    from zimi import http

    assert http._is_almanac_hd_file("/w/zimi_almanac_maxi/hd/moon/0/0/0.webp")
    assert http._is_almanac_hd_file("/w/zimi_almanac_hd_moon/hd.json")
    assert not http._is_almanac_hd_file("/w/zimi_almanac_x/hd/anything.webp")
    assert not http._is_almanac_hd_file("/w/zimi_almanac/hd/a.webp")
    assert http._rate_class("/w/zimi_almanac_x/hd/a.webp")[0]


def test_the_keeper_budget_holds_both_own_apps_whole():
    """The games and the Almanac kept in one burst are ~1,200 files; the keeper's own bucket must be larger."""
    from zimi import http

    assert http.RATE_LIMIT_CONTENT * http.RATE_LIMIT_KEEP_FACTOR >= 1500


# ── The space a size takes, and taking it off ──


def _own_almanac(real):
    """The Almanac's own ZIM sitting in the library folder: no remove ever touches it."""
    path = os.path.join(real.dir, "zimi_almanac_2026-11.zim")
    build_fixture_zim(path, metadata={"Name": "zimi_almanac"})
    real.scan()
    return path


def test_the_space_each_size_takes_is_its_files_summed(real):
    st = almanachd.status()
    assert st["sizes"] == {"hd": os.path.getsize(os.path.join(real.dir, HD_FILE))}
    _choose_max()
    st = almanachd.status()
    assert st["sizes"] == {"max": sum(len(real.files[n]) for n in real.names)}   # a split book: every chunk


def test_remove_takes_a_size_off_the_disk_and_the_offer_comes_back_and_it_can_be_had_again(real):
    own = _own_almanac(real)
    almanachd.release(read=True)
    freed, err = almanachd.remove()
    assert err is None and freed > 0
    assert not os.path.exists(os.path.join(real.dir, HD_FILE)) and os.path.exists(own)
    assert almanachd.current() is None and almanachd.base() is None
    st = almanachd.status()
    assert st["installed"] is False and st["sizes"] == {} and "hd" in st["offers"] and "max" in st["offers"]
    almanachd.start({"name": "admin"}, kind="hd")
    _settle()
    assert almanachd.current() == "hd" and almanachd.status()["sizes"]["hd"] == freed


def test_remove_takes_maximum_with_every_chunk_and_leaves_the_almanac(real):
    own = _own_almanac(real)
    _choose_max()
    assert almanachd.current() == "max"
    freed, err = almanachd.remove("max")
    assert err is None and freed == sum(len(real.files[n]) for n in real.names)
    assert sorted(os.listdir(real.dir)) == [os.path.basename(own)] and almanachd.current() is None
    _choose_max()                                  # and again
    assert almanachd.current() == "max"


def test_remove_with_nothing_there_says_so_and_a_size_not_in_use_is_left_alone(real):
    assert almanachd.remove("max") == (0, "none")
    assert os.path.exists(os.path.join(real.dir, HD_FILE))   # HD was not asked for
    almanachd.remove()
    assert almanachd.remove() == (0, "none")


def test_remove_over_http_is_the_managers_and_answers_the_new_state(real):
    import threading
    import urllib.request
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/manage/almanac-hd" % httpd.server_address[1]
    try:
        req = urllib.request.Request(url, json.dumps({"remove": True, "kind": "hd"}).encode(), {"content-type": "application/json"})
        body = json.load(urllib.request.urlopen(req))
        assert body["installed"] is False and body["freed"] > 0
        try:
            urllib.request.urlopen(urllib.request.Request(url, json.dumps({"remove": True}).encode(), {"content-type": "application/json"}))
            raise AssertionError("nothing left to remove should answer an error")
        except urllib.error.HTTPError as e:
            assert e.code == 404
    finally:
        httpd.shutdown()


def test_a_release_that_does_not_carry_maximum_says_so_for_it(real):
    real.manifest.pop("max")
    almanachd.release(read=True)
    st = almanachd.status()
    assert st["absent"] == {"max": "missing"} and "max" not in st["offers"]
