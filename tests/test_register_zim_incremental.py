"""Post-download registration must not starve the server (#51).

The old completion path ran ``load_cache(force=True)`` while holding
``_zim_lock``: a full re-open + re-scan of EVERY archive in the library under
the one lock every libzim request needs. On a Raspberry Pi serving a big
library from a NAS mount that held the lock for minutes — every request
starved, the browser gave up, and the log filled with broken pipes that read
like a crash. These tests pin the replacement contract:

- metadata extraction for the ONE new file runs OFF the lock;
- the lock is held only for the in-memory splice (milliseconds);
- no other archive in the library is re-opened;
- the resulting library state matches what a full rescan would produce;
- the finalize path only falls back to the full rescan when incremental
  registration cannot work.
"""

import json
import os
import sys
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import build_fixture_zim  # noqa: E402
import zimi.server as server  # noqa: E402
import zimi.library as library  # noqa: E402


def _setup_library(tmp_path, monkeypatch, n_existing=2):
    """Fresh ZIM_DIR with n small real ZIMs, scanned into the live caches."""
    zdir = tmp_path / "zims"
    zdir.mkdir()
    for i in range(n_existing):
        build_fixture_zim(str(zdir / f"existing{i}_en_2026-0{i + 1}.zim"))
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    server._zim_files_cache = None
    server._zim_list_cache = None
    server.load_cache(force=True)
    return zdir


def _names():
    return {z["name"] for z in server._zim_list_cache}


# ---------------------------------------------------------------------------
# Correctness: the incremental splice must equal what a rescan would produce
# ---------------------------------------------------------------------------


def test_register_new_zim_scans_only_the_new_file(tmp_path, monkeypatch):
    zdir = _setup_library(tmp_path, monkeypatch)
    gen_before = server._cache_generation
    new_path = str(zdir / "newwiki_en_2026-07.zim")
    build_fixture_zim(new_path)

    real_extract = server._extract_zim_metadata
    extracted = []

    def counting_extract(name, path):
        extracted.append(name)
        return real_extract(name, path)

    monkeypatch.setattr(server, "_extract_zim_metadata", counting_extract)
    assert server.register_zim_file(new_path) is True

    # Exactly one archive was opened for metadata — the new one. The old
    # force-rescan opened every archive in the library.
    assert extracted == ["newwiki"]
    assert "newwiki" in server._zim_files_cache
    assert server._zim_files_cache["newwiki"] == new_path
    entry = next(z for z in server._zim_list_cache if z["name"] == "newwiki")
    assert entry["entries"] == 3
    assert entry["file"] == "newwiki_en_2026-07.zim"
    # Fresh install: first_seen ~now, no update stamp.
    assert abs(entry["first_seen"] - time.time()) < 120
    assert entry["updated_at"] is None
    # ETag/interlang invalidation must fire — a new ZIM changes answers.
    assert server._cache_generation == gen_before + 1
    # Persisted, so a restart does not rescan it.
    disk = json.load(open(server._cache_file_path()))
    assert "newwiki_en_2026-07.zim" in disk["files"]


def test_register_matches_full_rescan_state(tmp_path, monkeypatch):
    """The spliced entry carries the same fields load_cache would compute."""
    zdir = _setup_library(tmp_path, monkeypatch)
    new_path = str(zdir / "newwiki_en_2026-07.zim")
    build_fixture_zim(new_path)
    assert server.register_zim_file(new_path) is True
    spliced = next(z for z in server._zim_list_cache if z["name"] == "newwiki")

    server.load_cache(force=True)
    rescanned = next(z for z in server._zim_list_cache if z["name"] == "newwiki")
    for key in (
        "name",
        "file",
        "size_bytes",
        "entries",
        "title",
        "language",
        "main_path",
        "category",
        "article_count",
    ):
        assert spliced.get(key) == rescanned.get(key), key


def test_register_update_inherits_first_seen_and_stamps_updated(tmp_path, monkeypatch):
    zdir = _setup_library(tmp_path, monkeypatch, n_existing=1)
    old_file = "existing0_en_2026-01.zim"
    old_entry = next(z for z in server._zim_list_cache if z["file"] == old_file)
    original_first_seen = old_entry["first_seen"]

    # The download machinery removes older versions before registering.
    new_path = str(zdir / "existing0_en_2026-07.zim")
    build_fixture_zim(new_path)
    os.remove(str(zdir / old_file))
    assert server.register_zim_file(new_path, removed_files=[old_file]) is True

    entries = [z for z in server._zim_list_cache if z["name"] == "existing0"]
    assert len(entries) == 1
    assert entries[0]["file"] == "existing0_en_2026-07.zim"
    # Same logical ZIM: keep the true install date, badge as "Updated".
    assert entries[0]["first_seen"] == original_first_seen
    assert entries[0]["updated_at"] is not None
    disk = json.load(open(server._cache_file_path()))
    assert old_file not in disk["files"]
    assert "existing0_en_2026-07.zim" in disk["files"]


def test_register_merges_domains_without_reopening_library(tmp_path, monkeypatch):
    """The domain map must gain the new ZIM's domains WITHOUT the full
    rebuild — that rebuild re-opens every unmapped archive under _zim_lock,
    which with a cold pool (right after a prior download's cache clear) is
    the same library-wide open storm the incremental path exists to kill."""
    import zimi.interlang as interlang

    zdir = _setup_library(tmp_path, monkeypatch)
    # Cold pool: the state after any finalize's cache clear.
    server._archive_pool.clear()
    new_path = str(zdir / "stackoverflow.com_en_all_2026-07.zim")
    build_fixture_zim(new_path)

    real_open = server.open_archive
    opens = []

    def counting_open(path):
        opens.append(os.path.basename(path))
        return real_open(path)

    monkeypatch.setattr(server, "open_archive", counting_open)
    assert server.register_zim_file(new_path) is True
    # Exactly one archive open: the new file. No library-wide reopen.
    assert opens == ["stackoverflow.com_en_all_2026-07.zim"]
    assert interlang._domain_zim_map.get("stackoverflow.com") == "stackoverflow"
    assert interlang._domain_zim_map.get("www.stackoverflow.com") == "stackoverflow"
    # The server-module re-export stays fresh for /manage/status readers.
    assert server._domain_zim_map.get("stackoverflow.com") == "stackoverflow"


def test_register_unreadable_file_returns_false(tmp_path, monkeypatch):
    zdir = _setup_library(tmp_path, monkeypatch)
    bad = zdir / "broken_en_2026-07.zim"
    bad.write_bytes(b"this is not a zim")
    assert server.register_zim_file(str(bad)) is False
    assert "broken" not in server._zim_files_cache


# ---------------------------------------------------------------------------
# The starvation contract itself
# ---------------------------------------------------------------------------

_EXTRACT_SLEEP = 6.0  # simulated slow-NAS metadata extraction
_LATENCY_BOUND = 4.0  # generous — the point is "not minutes", CI machines vary


def _slow_extract(monkeypatch, entered, sleep_s=_EXTRACT_SLEEP):
    """Make metadata extraction slow, as on a saturated NAS mount."""
    real_extract = server._extract_zim_metadata

    def slow(name, path):
        entered.set()
        time.sleep(sleep_s)
        return real_extract(name, path)

    monkeypatch.setattr(server, "_extract_zim_metadata", slow)


def test_zim_lock_is_free_while_metadata_extracts(tmp_path, monkeypatch):
    zdir = _setup_library(tmp_path, monkeypatch)
    new_path = str(zdir / "slowwiki_en_2026-07.zim")
    build_fixture_zim(new_path)
    entered = threading.Event()
    _slow_extract(monkeypatch, entered, sleep_s=2.0)

    result = {}
    t = threading.Thread(
        target=lambda: result.update(ok=server.register_zim_file(new_path)),
        daemon=True,
    )
    t.start()
    assert entered.wait(timeout=30), "registration never reached extraction"
    # While extraction sleeps, the lock every request needs must be free.
    t0 = time.monotonic()
    acquired = server._zim_lock.acquire(timeout=1.0)
    waited = time.monotonic() - t0
    if acquired:
        server._zim_lock.release()
    assert acquired, "_zim_lock held during metadata extraction (starvation bug)"
    assert waited < 1.0
    t.join(timeout=60)
    assert result.get("ok") is True


def test_requests_answer_while_registration_runs(tmp_path, monkeypatch):
    """End-to-end #51 shape: /read (which acquires _zim_lock) must answer
    within seconds while a new ZIM is being registered, not queue behind it."""
    zdir = _setup_library(tmp_path, monkeypatch)
    from zimi.http import ZimHandler

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        new_path = str(zdir / "slowwiki_en_2026-07.zim")
        build_fixture_zim(new_path)
        entered = threading.Event()
        _slow_extract(monkeypatch, entered)
        t = threading.Thread(
            target=server.register_zim_file, args=(new_path,), daemon=True
        )
        t.start()
        assert entered.wait(timeout=30)

        t0 = time.monotonic()
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/read?zim=existing0&path=A/Water",
            timeout=_EXTRACT_SLEEP + 30,
        ) as r:
            assert r.status == 200
            body = json.loads(r.read())
        elapsed = time.monotonic() - t0
        assert "Water" in body.get("title", "") or body.get("content")
        assert elapsed < _LATENCY_BOUND, (
            f"/read took {elapsed:.1f}s during registration — requests are "
            "starving behind the new-ZIM scan again (#51)"
        )
        t.join(timeout=60)
    finally:
        httpd.shutdown()
        httpd.server_close()


# ---------------------------------------------------------------------------
# Finalize wiring: incremental first, full rescan only as fallback
# ---------------------------------------------------------------------------


def _neutralize_finalize(monkeypatch, tmp_path):
    """Stub the finalize side-quests so only the registration wiring runs."""
    monkeypatch.setattr(library._srv, "ZIM_DIR", str(tmp_path))
    monkeypatch.setattr(library._srv, "_search_cache_clear", lambda: None)
    monkeypatch.setattr(library._srv, "_suggest_cache_clear", lambda: None)
    monkeypatch.setattr(library._srv, "_clean_stale_title_indexes", lambda: None)
    monkeypatch.setattr(library._srv, "_build_all_qid_indexes", lambda: None)
    monkeypatch.setattr(library._srv, "_append_history", lambda ev: None)


def _mk_dl(tmp_path):
    dest = str(tmp_path / "thing_en_2026-07.zim")
    open(dest, "wb").write(b"x")
    return {
        "filename": "thing_en_2026-07.zim",
        "dest": dest,
        "url": "https://example.org/thing_en_2026-07.zim",
        "total_bytes": 1,
    }


def test_finalize_registers_incrementally_no_full_rescan(tmp_path, monkeypatch):
    _neutralize_finalize(monkeypatch, tmp_path)
    registered = []
    monkeypatch.setattr(
        library._srv,
        "register_zim_file",
        lambda path, removed_files=(): registered.append((path, tuple(removed_files)))
        or True,
    )

    def no_rescan(force=False):
        raise AssertionError(
            "load_cache must not run when incremental registration succeeds"
        )

    monkeypatch.setattr(library._srv, "load_cache", no_rescan)
    dl = _mk_dl(tmp_path)
    library._post_download_finalize(dl)
    assert registered == [(dl["dest"], ())]


def test_finalize_falls_back_to_rescan_when_register_fails(tmp_path, monkeypatch):
    _neutralize_finalize(monkeypatch, tmp_path)
    monkeypatch.setattr(
        library._srv, "register_zim_file", lambda path, removed_files=(): False
    )
    rescans = []
    monkeypatch.setattr(
        library._srv, "load_cache", lambda force=False: rescans.append(force)
    )
    library._post_download_finalize(_mk_dl(tmp_path))
    assert rescans == [True]


def test_finalize_falls_back_when_register_raises(tmp_path, monkeypatch):
    _neutralize_finalize(monkeypatch, tmp_path)

    def boom(path, removed_files=()):
        raise RuntimeError("disk went away")

    monkeypatch.setattr(library._srv, "register_zim_file", boom)
    rescans = []
    monkeypatch.setattr(
        library._srv, "load_cache", lambda force=False: rescans.append(force)
    )
    library._post_download_finalize(_mk_dl(tmp_path))
    assert rescans == [True]


def test_finalize_passes_removed_old_versions(tmp_path, monkeypatch):
    _neutralize_finalize(monkeypatch, tmp_path)
    old = tmp_path / "thing_en_2026-01.zim"
    old.write_bytes(b"old")
    registered = []
    monkeypatch.setattr(
        library._srv,
        "register_zim_file",
        lambda path, removed_files=(): registered.append(tuple(removed_files)) or True,
    )
    library._post_download_finalize(_mk_dl(tmp_path))
    assert registered == [("thing_en_2026-01.zim",)]
    assert not old.exists()
