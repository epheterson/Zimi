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

from conftest_zim import build_fixture_zim, split_fixture_zim  # noqa: E402

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


def test_choosing_hd_removes_maximum_once_hd_is_in(lib, prefs):
    entry = _stage_real_maximum(lib)
    almanachd.finish_max()
    assert almanachd.current() == "max"
    build_fixture_zim(os.path.join(lib["dir"], HD_FILE))
    lib["scan"]()
    almanachd.on_installed("hd")
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
