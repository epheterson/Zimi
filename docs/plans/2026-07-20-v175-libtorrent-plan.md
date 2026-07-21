# v1.7.5 libtorrent Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the aria2c sidecar with in-process libtorrent-rasterbar as Zimi's single BitTorrent engine, with HTTP as the universal fallback floor.

**Architecture:** One concrete `LibtorrentBackend` class in `p2p.py` owning an `lt.session` + alert-pump thread; `get_backend()` tries `import libtorrent` and returns `None` (→ HTTP) if absent. All aria2 code, its four compensation layers, its bundling, and the backend-selection machinery are deleted. `library.py` keeps calling the same normalized methods; its aria2-specific workarounds (GID rebind, `.aria2` control-file check, seed-ratio normalize block) are removed.

**Tech Stack:** libtorrent-rasterbar 2.0.x Python bindings (`import libtorrent`), Python stdlib only otherwise. No new pip deps declared — libtorrent is a soft import.

**Design doc:** `docs/plans/2026-07-20-v175-libtorrent.md` (approved 2026-07-20).

## Global Constraints

- libtorrent is NEVER a declared dependency in `pyproject.toml`/`requirements.txt` — soft import only.
- The normalized `status()` dict contract is preserved verbatim: keys `state` (`downloading|waiting|paused|error|complete|removed|unknown`), `gid`, `completed_bytes`, `total_bytes`, `down_speed`, `up_speed`, `peers`, `seeders`, `ratio`, `info_hash`, `error_code`, `error_message`.
- The `list_managed()` entry contract (what `library.py`/`manage.py` parse): keys `gid` (str), `status` (`active|paused|error`), `files` (list of `{"path": abs_path}`), `uploadLength` (str int), `totalLength` (str int), `infoHash` (str).
- **`remove(tid, delete_files=True)` must NEVER delete payload files outside the staging dir.** aria2's version only cleared session results; deleting a seed must never delete the ZIM in `ZIM_DIR`.
- Every env/UI knob keeps working unchanged: `ZIMI_BT` blob (`port=`, `ratio=`, `up=`, `down=`, `dht=`, `upnp=`, `mirror=`, `seed=`, `staging=`), legacy `ZIMI_TORRENT`/`ZIMI_SEED`/etc., persisted UI prefs.
- Zimi enforces seed-ratio caps itself via the seed ledger (`library.py`); the engine always seeds uncapped per-torrent. Do not implement per-torrent ratio caps in libtorrent.
- No completion claims without running the tests and showing output. Full suite green before every commit.
- Commits go on branch `v1.7.5`. Commit footer: `Co-Authored-By: Claude <noreply@anthropic.com>`. Never push, tag, or publish without Eric's explicit go.
- macOS dev box has NO libtorrent (Python 3.14, no wheel). Unit tests must run against the fake `lt` stub; real-engine tests are `pytest.importorskip("libtorrent")`-gated and run inside the Docker image.

## File Map

| File | Action |
|---|---|
| `tests/fake_lt.py` | Create — in-memory fake of the libtorrent API surface we use |
| `tests/test_libtorrent_backend.py` | Create — unit tests against the fake; importorskip-gated real-engine tests |
| `zimi/p2p.py` | Rewrite engine half: add `_lt()` + `LibtorrentBackend`; delete `find_aria2c`, `Aria2Backend`, `get_backend_name`, `seed_options`, `effective_seed_options`; simplify `get_backend` |
| `zimi/library.py` | Remove aria2-specific seams (GID rebind, `.aria2` check, options dicts, seed-ratio normalize block) |
| `zimi/manage.py` | `/manage/bt-status` reports libtorrent availability instead of binary-on-PATH |
| `tests/test_p2p.py` | Rewrite aria2-specific tests for the new backend |
| `tests/test_bt_seeding.py`, `test_bt_attempt.py`, `test_mirror_mode.py`, `test_http_seed.py`, `test_dl_source.py` | Update fakes/assertions where aria2-shaped |
| `Dockerfile` | Swap `aria2` for libtorrent (pip wheel on pinned-Python base, or apt) |
| `.github/workflows/desktop-release.yml` | Delete aria2 sidecar steps; pin build Python to 3.12; collect libtorrent into bundles |
| `zimi_desktop.spec` | Delete `ZIMI_ARIA2_DIR` block; add libtorrent binary collection |
| `ci/bundle_aria2_macos.sh` | Delete |
| `CHANGELOG.md`, `CLAUDE.md` | Update |

---

### Task 1: Fake libtorrent module + LibtorrentBackend core (TDD)

**Files:**
- Create: `tests/fake_lt.py`
- Create: `tests/test_libtorrent_backend.py`
- Modify: `zimi/p2p.py` (add `_lt()` accessor + `LibtorrentBackend` after the `BTBackend` ABC; delete nothing yet)

**Interfaces:**
- Produces: `p2p._lt()` → module or None; `p2p._lt_module` (test injection point); `class LibtorrentBackend` with the full `BTBackend` surface plus `ensure_running()`, `stop()`, `set_global_rate_limits(up_kb, down_kb)`, `purge_stopped(keep_errors=True)` (no-op).
- Torrent id (`tid`) = 40-char v1 info-hash hex string.

- [ ] **Step 1: Write the fake.** `tests/fake_lt.py` — a minimal stand-in implementing exactly the API surface the backend uses (session, add_torrent → handle, torrent_status with `state`/`flags`/`errc`/`total_done`/`total_wanted`/rates/counts/`all_time_upload`/`save_path`, `parse_magnet_uri`, `load_torrent_file`, `load_torrent_buffer`, `read_resume_data`, `write_resume_data_buf`, alert queue with `save_resume_data_alert`, `torrent_flags`, `torrent_status.states`, `session.delete_files`). Handles must be scriptable: tests set `handle._status.state = fake_lt.torrent_status.seeding` etc.

```python
"""In-memory fake of the libtorrent 2.0 Python API surface Zimi uses.

Tests inject this as zimi.p2p._lt_module so LibtorrentBackend runs
without the real (unimportable-on-dev-Mac) libtorrent. Only what the
backend touches is implemented — if the backend starts using a new lt
API, add it here first (that's the point: the fake IS the contract).
"""

import os


class _Enum(int):
    pass


class torrent_flags:
    paused = 1 << 0
    auto_managed = 1 << 1
    update_subscribe = 1 << 2
    upload_mode = 1 << 3


class torrent_status:
    # state enum values (match lt names, not numbers — code compares identities)
    checking_files = _Enum(1)
    downloading_metadata = _Enum(2)
    downloading = _Enum(3)
    finished = _Enum(4)
    seeding = _Enum(5)
    checking_resume_data = _Enum(7)

    def __init__(self):
        self.state = torrent_status.downloading
        self.flags = 0
        self.total_done = 0
        self.total_wanted = 0
        self.download_payload_rate = 0
        self.upload_payload_rate = 0
        self.num_peers = 0
        self.num_seeds = 0
        self.all_time_upload = 0
        self.save_path = ""
        self.name = ""
        self.errc = _ErrorCode(0, "")


class _ErrorCode:
    def __init__(self, value, message):
        self._value = value
        self._message = message

    def value(self):
        return self._value

    def message(self):
        return self._message


class _FileStorage:
    def __init__(self, paths):
        self._paths = paths

    def num_files(self):
        return len(self._paths)

    def file_path(self, i):
        return self._paths[i]


class _TorrentInfo:
    def __init__(self, name="test.zim", size=1000, paths=None):
        self._name = name
        self._size = size
        self._paths = paths or [name]

    def name(self):
        return self._name

    def total_size(self):
        return self._size

    def files(self):
        return _FileStorage(self._paths)


class _InfoHashes:
    def __init__(self, hex_v1):
        self.v1 = _Sha1(hex_v1)


class _Sha1:
    def __init__(self, hex_str):
        self._hex = hex_str

    def __str__(self):
        return self._hex


class add_torrent_params:
    def __init__(self, hex_v1="a" * 40, ti=None):
        self.save_path = ""
        self.flags = torrent_flags.auto_managed
        self.ti = ti
        self.info_hashes = _InfoHashes(hex_v1)
        self.name = ti.name() if ti else ""


class torrent_handle:
    def __init__(self, atp):
        self._atp = atp
        self._status = torrent_status()
        self._status.save_path = atp.save_path
        self._status.name = atp.name
        if atp.ti is not None:
            self._status.total_wanted = atp.ti.total_size()
        self._valid = True
        self._paused = bool(atp.flags & torrent_flags.paused)

    def is_valid(self):
        return self._valid

    def status(self):
        if self._paused:
            self._status.flags |= torrent_flags.paused
        else:
            self._status.flags &= ~torrent_flags.paused
        return self._status

    def torrent_file(self):
        return self._atp.ti

    def info_hashes(self):
        return self._atp.info_hashes

    def pause(self):
        self._paused = True

    def resume(self):
        self._paused = False

    def save_resume_data(self, flags=0):
        self._session._alerts.append(save_resume_data_alert(self))

    def unset_flags(self, flags):
        self._atp.flags &= ~flags


class save_resume_data_alert:
    def __init__(self, handle):
        self.handle = handle
        self.params = handle._atp

    def what(self):
        return "save_resume_data"


class save_resume_data_failed_alert:
    def __init__(self, handle):
        self.handle = handle

    def what(self):
        return "save_resume_data_failed"


class session:
    delete_files = 1

    def __init__(self, settings=None):
        self.settings = dict(settings or {})
        self._torrents = {}
        self._alerts = []
        self.removed = []  # (hex, delete_files_flag) — test hook

    def add_torrent(self, atp):
        hexh = str(atp.info_hashes.v1)
        if hexh in self._torrents:
            raise RuntimeError("torrent already exists in session")
        h = torrent_handle(atp)
        h._session = self
        self._torrents[hexh] = h
        return h

    def find_torrent(self, sha1):
        return self._torrents.get(str(sha1))

    def remove_torrent(self, handle, flags=0):
        hexh = str(handle._atp.info_hashes.v1)
        self._torrents.pop(hexh, None)
        handle._valid = False
        self.removed.append((hexh, bool(flags & session.delete_files)))

    def apply_settings(self, settings):
        self.settings.update(settings)

    def pop_alerts(self):
        out, self._alerts = self._alerts, []
        return out

    def pause(self):
        self.settings["_paused"] = True


class alert:
    class category_t:
        status_notification = 1 << 0
        error_notification = 1 << 1
        storage_notification = 1 << 2


def parse_magnet_uri(uri):
    # magnet:?xt=urn:btih:<40 hex>...
    marker = "btih:"
    i = uri.index(marker) + len(marker)
    return add_torrent_params(hex_v1=uri[i : i + 40].lower())


def load_torrent_file(path):
    name = os.path.basename(path).replace(".torrent", "")
    import hashlib

    hexh = hashlib.sha1(path.encode()).hexdigest()
    return add_torrent_params(hex_v1=hexh, ti=_TorrentInfo(name=name))


def load_torrent_buffer(buf):
    import hashlib

    hexh = hashlib.sha1(bytes(buf)).hexdigest()
    return add_torrent_params(hex_v1=hexh, ti=_TorrentInfo(name="from-buffer.zim"))


def read_resume_data(buf):
    import json

    d = json.loads(bytes(buf).decode())
    atp = add_torrent_params(hex_v1=d["hex"], ti=_TorrentInfo(name=d["name"]))
    atp.save_path = d["save_path"]
    return atp


def write_resume_data_buf(atp):
    import json

    return json.dumps(
        {
            "hex": str(atp.info_hashes.v1),
            "name": atp.name or "unknown",
            "save_path": atp.save_path,
        }
    ).encode()


version = "fake-2.0"
```

- [ ] **Step 2: Write the failing tests.** `tests/test_libtorrent_backend.py`. Cover: import gate, tid = info-hash, magnet/buffer/file dispatch, duplicate add returns existing tid, status mapping (downloading/paused/error/seeding→complete/invalid→removed), status key completeness, list_managed contract keys, **remove never deletes payload outside staging**, remove inside staging does delete, rate-limit apply, resume-data round-trip.

```python
"""LibtorrentBackend unit tests — run against tests/fake_lt.py.

The real libtorrent is not importable on the dev Mac (no 3.14 wheel);
these tests inject the fake as p2p._lt_module. Real-engine smoke tests
live at the bottom behind pytest.importorskip and run in the Docker CI
image only.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import fake_lt  # noqa: E402

from zimi import p2p  # noqa: E402


@pytest.fixture
def backend(tmp_path, monkeypatch):
    monkeypatch.setattr(p2p, "_lt_module", fake_lt)
    monkeypatch.setattr(p2p, "_lt_import_failed", False)
    b = p2p.LibtorrentBackend(
        bt_port=6881,
        data_dir=str(tmp_path),
        staging_dir=str(tmp_path / "staging"),
    )
    yield b
    b.stop()


MAGNET = "magnet:?xt=urn:btih:" + "ab" * 20 + "&dn=test.zim"


class TestImportGate:
    def test_lt_returns_none_when_unimportable(self, monkeypatch):
        monkeypatch.setattr(p2p, "_lt_module", None)
        monkeypatch.setattr(p2p, "_lt_import_failed", True)
        assert p2p._lt() is None

    def test_available_false_without_libtorrent(self, tmp_path, monkeypatch):
        monkeypatch.setattr(p2p, "_lt_module", None)
        monkeypatch.setattr(p2p, "_lt_import_failed", True)
        b = p2p.LibtorrentBackend(
            bt_port=6881, data_dir=str(tmp_path), staging_dir=str(tmp_path / "s")
        )
        assert b.available() is False


class TestAddTorrent:
    def test_magnet_returns_info_hash_tid(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        assert tid == "ab" * 20

    def test_local_torrent_file(self, backend, tmp_path):
        tid = backend.add_torrent(
            str(tmp_path / "wikipedia.torrent"), dest_dir=str(tmp_path / "staging")
        )
        assert len(tid) == 40

    def test_duplicate_add_returns_existing_tid(self, backend, tmp_path):
        t1 = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        t2 = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        assert t1 == t2

    def test_save_path_is_dest_dir(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        assert backend.status(tid)  # add succeeded
        h = backend._handles[tid]
        assert h._atp.save_path == str(tmp_path / "staging")


class TestStatus:
    def test_downloading(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        st = backend.status(tid)
        assert st["state"] == "downloading"
        assert st["gid"] == tid
        assert st["info_hash"] == tid

    def test_seeding_reports_complete(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        h = backend._handles[tid]
        h._status.state = fake_lt.torrent_status.seeding
        assert backend.status(tid)["state"] == "complete"

    def test_finished_reports_complete(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        h = backend._handles[tid]
        h._status.state = fake_lt.torrent_status.finished
        assert backend.status(tid)["state"] == "complete"

    def test_paused(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        backend.pause(tid)
        assert backend.status(tid)["state"] == "paused"
        backend.resume(tid)
        assert backend.status(tid)["state"] == "downloading"

    def test_error(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        h = backend._handles[tid]
        h._status.errc = fake_lt._ErrorCode(5, "boom")
        st = backend.status(tid)
        assert st["state"] == "error"
        assert st["error_message"] == "boom"

    def test_unknown_tid_reports_removed(self, backend):
        assert backend.status("f" * 40)["state"] == "removed"

    def test_contract_keys_present(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        st = backend.status(tid)
        for key in (
            "state",
            "gid",
            "completed_bytes",
            "total_bytes",
            "down_speed",
            "up_speed",
            "peers",
            "seeders",
            "ratio",
            "info_hash",
            "error_code",
            "error_message",
        ):
            assert key in st, key

    def test_ratio_from_all_time_upload(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        h = backend._handles[tid]
        h._status.total_wanted = 1000
        h._status.all_time_upload = 2500
        assert backend.status(tid)["ratio"] == 2.5


class TestListManaged:
    def test_contract_shape(self, backend, tmp_path):
        backend.add_torrent(
            str(tmp_path / "wikipedia.torrent"), dest_dir=str(tmp_path / "staging")
        )
        entries = backend.list_managed()
        assert len(entries) == 1
        raw = entries[0]
        for key in ("gid", "status", "files", "uploadLength", "totalLength", "infoHash"):
            assert key in raw, key
        assert raw["status"] == "active"
        assert raw["files"][0]["path"].startswith(str(tmp_path / "staging"))

    def test_paused_status_string(self, backend, tmp_path):
        tid = backend.add_torrent(
            str(tmp_path / "a.torrent"), dest_dir=str(tmp_path / "staging")
        )
        backend.pause(tid)
        assert backend.list_managed()[0]["status"] == "paused"


class TestRemoveSafety:
    """remove(delete_files=True) deletes payload ONLY inside staging.

    aria2's remove cleared session results and never touched payload;
    a naive libtorrent delete_files mapping would delete library ZIMs
    on stop_mirror_seeds(). This is the guard.
    """

    def test_seed_remove_never_deletes_library_payload(self, backend, tmp_path):
        zim_dir = tmp_path / "zims"
        zim_dir.mkdir()
        tid = backend.add_torrent(
            str(tmp_path / "seed.torrent"), dest_dir=str(zim_dir)
        )
        backend.remove(tid, delete_files=True)
        ses = backend._ses
        assert ses.removed == [(tid, False)]  # lt delete_files flag NOT set

    def test_staging_remove_deletes_partial_payload(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        backend.remove(tid, delete_files=True)
        ses = backend._ses
        assert ses.removed == [(tid, True)]  # partial download → clean up

    def test_remove_drops_handle(self, backend, tmp_path):
        tid = backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        backend.remove(tid)
        assert tid not in backend._handles
        assert backend.status(tid)["state"] == "removed"


class TestRateLimits:
    def test_kb_converted_to_bytes(self, backend, tmp_path):
        backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        backend.set_global_rate_limits(2048, 512)
        assert backend._ses.settings["upload_rate_limit"] == 2048 * 1024
        assert backend._ses.settings["download_rate_limit"] == 512 * 1024

    def test_zero_means_unlimited(self, backend, tmp_path):
        backend.add_torrent(MAGNET, dest_dir=str(tmp_path / "staging"))
        backend.set_global_rate_limits(0, 0)
        assert backend._ses.settings["upload_rate_limit"] == 0
        assert backend._ses.settings["download_rate_limit"] == 0


class TestResume:
    def test_resume_round_trip(self, backend, tmp_path):
        tid = backend.add_torrent(
            str(tmp_path / "keep.torrent"), dest_dir=str(tmp_path / "staging")
        )
        backend._handles[tid].save_resume_data()
        backend._pump_alerts_once()
        resume_file = os.path.join(backend.resume_dir, tid + ".fastresume")
        assert os.path.exists(resume_file)
        # Fresh backend loads it back
        b2 = p2p.LibtorrentBackend(
            bt_port=6882,
            data_dir=str(tmp_path),
            staging_dir=str(tmp_path / "staging"),
        )
        b2._ensure_session()
        assert tid in b2._handles
        b2.stop()

    def test_remove_deletes_resume_file(self, backend, tmp_path):
        tid = backend.add_torrent(
            str(tmp_path / "gone.torrent"), dest_dir=str(tmp_path / "staging")
        )
        backend._handles[tid].save_resume_data()
        backend._pump_alerts_once()
        backend.remove(tid)
        assert not os.path.exists(
            os.path.join(backend.resume_dir, tid + ".fastresume")
        )


# ── Real-engine smoke (Docker CI only — needs importable libtorrent) ──────


class TestRealEngine:
    def test_real_session_starts_and_stops(self, tmp_path, monkeypatch):
        lt = pytest.importorskip("libtorrent")
        monkeypatch.setattr(p2p, "_lt_module", lt)
        monkeypatch.setattr(p2p, "_lt_import_failed", False)
        b = p2p.LibtorrentBackend(
            bt_port=16881,
            data_dir=str(tmp_path),
            staging_dir=str(tmp_path / "staging"),
        )
        assert b.available() is True
        assert b.is_alive() is True
        b.stop()
        assert b.is_alive() is False

    def test_real_add_local_torrent_and_seed(self, tmp_path, monkeypatch):
        lt = pytest.importorskip("libtorrent")
        monkeypatch.setattr(p2p, "_lt_module", lt)
        monkeypatch.setattr(p2p, "_lt_import_failed", False)
        # Build a real single-file torrent for a fixture payload
        payload_dir = tmp_path / "zims"
        payload_dir.mkdir()
        payload = payload_dir / "fixture.zim"
        payload.write_bytes(b"Z" * 65536)
        fs = lt.file_storage()
        lt.add_files(fs, str(payload))
        t = lt.create_torrent(fs)
        lt.set_piece_hashes(t, str(payload_dir))
        torrent_path = tmp_path / "fixture.torrent"
        torrent_path.write_bytes(lt.bencode(t.generate()))

        b = p2p.LibtorrentBackend(
            bt_port=16882,
            data_dir=str(tmp_path),
            staging_dir=str(tmp_path / "staging"),
        )
        tid = b.add_torrent(str(torrent_path), dest_dir=str(payload_dir))
        deadline = __import__("time").monotonic() + 20
        state = None
        while __import__("time").monotonic() < deadline:
            state = b.status(tid)["state"]
            if state == "complete":
                break
            __import__("time").sleep(0.2)
        assert state == "complete"  # hash-checked the existing file → seeding
        entries = b.list_managed()
        assert entries[0]["files"][0]["path"] == str(payload)
        b.stop()
```

- [ ] **Step 3: Run tests to verify they fail.**

Run: `python3 -m pytest tests/test_libtorrent_backend.py -x -q`
Expected: FAIL — `AttributeError: module 'zimi.p2p' has no attribute '_lt_module'` (backend not written yet).

- [ ] **Step 4: Implement `LibtorrentBackend` in `zimi/p2p.py`.** Insert after the `BTBackend` ABC (below line 556), before the aria2 section. Complete code:

```python
# ============================================================================
# libtorrent — the in-process engine (v1.7.5+)
# ============================================================================

_lt_module = None
_lt_import_failed = False

# .torrent metadata fetches: bounded so a hostile/misbehaving URL can't
# balloon memory. Real Kiwix .torrent files are tens of KB.
TORRENT_FETCH_TIMEOUT_S = 30
TORRENT_FETCH_MAX_BYTES = 10 * 1024 * 1024


def _lt():
    """Import libtorrent lazily; None when unavailable (→ HTTP floor).

    Not a hard dependency: the PyPI package has patchy wheel coverage
    (nothing for 3.13+/some platforms). Docker installs it; pip installs
    of zimi work without it and simply don't torrent.
    """
    global _lt_module, _lt_import_failed
    if _lt_module is not None:
        return _lt_module
    if _lt_import_failed:
        return None
    try:
        import libtorrent

        _lt_module = libtorrent
    except ImportError:
        _lt_import_failed = True
        log.info("libtorrent not importable — BT off, downloads use HTTP")
        return None
    return _lt_module


class LibtorrentBackend(BTBackend):
    """In-process libtorrent session. One engine, no sidecar.

    Replaces the aria2 subprocess (v1.7.5) and with it the four
    out-of-process compensation layers: RPC port-walking, process
    liveness polling, the followedBy two-GID dance, and the
    OPENSSL_MODULES env hack. Torrent ids are v1 info-hash hex.

    list_managed() entries keep the historical key names library.py
    parses (gid/status/files/uploadLength/totalLength) — that dict shape
    is the contract, not an aria2-ism.
    """

    def __init__(self, *, bt_port: int, data_dir: str, staging_dir: str) -> None:
        self.bt_port = bt_port
        self.data_dir = data_dir
        self.staging_dir = staging_dir
        self.bt_dir = os.path.join(data_dir, "bt")
        self.resume_dir = os.path.join(self.bt_dir, "resume")
        self.session_state_path = os.path.join(self.bt_dir, "session-state")
        self._ses = None
        self._handles: dict[str, Any] = {}
        self._lock = threading.Lock()
        self._alert_stop = threading.Event()
        self._alert_thread: threading.Thread | None = None

    # ── availability / lifecycle ──────────────────────────────────────────

    def available(self) -> bool:
        if _lt() is None:
            return False
        try:
            self._ensure_session()
            return True
        except Exception as e:
            log.warning("libtorrent session failed to start: %s", e)
            return False

    def is_alive(self) -> bool:
        return self._ses is not None

    def ensure_running(self) -> None:
        self._ensure_session()

    def _ensure_session(self) -> None:
        with self._lock:
            if self._ses is not None:
                return
            lt = _lt()
            if lt is None:
                raise RuntimeError("libtorrent not importable")
            os.makedirs(self.resume_dir, exist_ok=True)
            os.makedirs(self.staging_dir, exist_ok=True)
            settings = {
                "listen_interfaces": f"0.0.0.0:{self.bt_port},[::]:{self.bt_port}",
                "enable_dht": is_dht_enabled(),
                "enable_upnp": is_upnp_enabled(),
                "enable_natpmp": is_upnp_enabled(),
                "upload_rate_limit": get_bt_up_limit_kb() * 1024,
                "download_rate_limit": get_bt_down_limit_kb() * 1024,
                "alert_mask": (
                    lt.alert.category_t.status_notification
                    | lt.alert.category_t.error_notification
                    | lt.alert.category_t.storage_notification
                ),
            }
            self._ses = lt.session(settings)
            log.info("libtorrent session up (bt port %d)", self.bt_port)
            self._load_resume_files(lt)
            self._alert_stop.clear()
            self._alert_thread = threading.Thread(
                target=self._alert_loop, name="lt-alerts", daemon=True
            )
            self._alert_thread.start()

    def stop(self) -> None:
        with self._lock:
            ses, self._ses = self._ses, None
        if ses is None:
            return
        self._alert_stop.set()
        if self._alert_thread is not None:
            self._alert_thread.join(timeout=2)
        # Ask every handle for resume data, then drain the alerts that
        # carry it — this is what makes restarts not re-download.
        pending = 0
        for h in self._handles.values():
            try:
                if h.is_valid():
                    h.save_resume_data()
                    pending += 1
            except Exception:
                pass
        deadline = time.monotonic() + 5.0
        while pending > 0 and time.monotonic() < deadline:
            for alert in ses.pop_alerts():
                name = alert.what()
                if name == "save_resume_data":
                    self._write_resume_file(alert)
                    pending -= 1
                elif name == "save_resume_data_failed":
                    pending -= 1
            time.sleep(0.05)
        self._handles.clear()

    # ── resume persistence ────────────────────────────────────────────────

    def _resume_path(self, tid: str) -> str:
        return os.path.join(self.resume_dir, tid + ".fastresume")

    def _write_resume_file(self, alert) -> None:
        lt = _lt()
        try:
            tid = str(alert.params.info_hashes.v1)
            buf = lt.write_resume_data_buf(alert.params)
            tmp = self._resume_path(tid) + ".tmp"
            with open(tmp, "wb") as f:
                f.write(buf)
            os.replace(tmp, self._resume_path(tid))
        except Exception as e:
            log.debug("resume-data write failed: %s", e)

    def _load_resume_files(self, lt) -> None:
        try:
            names = os.listdir(self.resume_dir)
        except OSError:
            return
        for name in names:
            if not name.endswith(".fastresume"):
                continue
            path = os.path.join(self.resume_dir, name)
            try:
                with open(path, "rb") as f:
                    atp = lt.read_resume_data(f.read())
                h = self._ses.add_torrent(atp)
                self._handles[str(atp.info_hashes.v1)] = h
            except Exception as e:
                log.warning("stale resume file %s dropped: %s", name, e)
                try:
                    os.unlink(path)
                except OSError:
                    pass

    # ── alert pump ────────────────────────────────────────────────────────

    def _alert_loop(self) -> None:
        while not self._alert_stop.wait(1.0):
            try:
                self._pump_alerts_once()
            except Exception as e:
                log.debug("alert pump error: %s", e)

    def _pump_alerts_once(self) -> None:
        ses = self._ses
        if ses is None:
            return
        for alert in ses.pop_alerts():
            if alert.what() == "save_resume_data":
                self._write_resume_file(alert)

    # ── BTBackend impl ────────────────────────────────────────────────────

    def add_torrent(
        self, source: str, *, dest_dir: str, options: dict | None = None
    ) -> str:
        lt = _lt()
        self._ensure_session()
        if source.startswith("magnet:"):
            atp = lt.parse_magnet_uri(source)
        elif source.startswith(("http://", "https://")):
            atp = lt.load_torrent_buffer(self._fetch_torrent_bytes(source))
        else:
            atp = lt.load_torrent_file(source)
        atp.save_path = dest_dir
        # No auto_managed: Zimi is the manager (ledger enforces caps,
        # policy passes stop seeds). Auto-management would resurrect
        # paused torrents behind our back.
        atp.flags &= ~lt.torrent_flags.auto_managed
        tid = str(atp.info_hashes.v1)
        with self._lock:
            if tid in self._handles and self._handles[tid].is_valid():
                return tid  # duplicate add — already managed
            try:
                h = self._ses.add_torrent(atp)
            except Exception:
                existing = self._ses.find_torrent(atp.info_hashes.v1)
                if existing is not None and existing.is_valid():
                    self._handles[tid] = existing
                    return tid
                raise
            self._handles[tid] = h
        return tid

    def _fetch_torrent_bytes(self, url: str) -> bytes:
        """Bounded .torrent metadata fetch. This collapses aria2's
        two-phase metadata GID: by the time we add to the session we
        already hold the full torrent, so 'complete' can only ever mean
        the content is complete (the corrupt-ZIM class of bug is gone
        by construction)."""
        req = urllib.request.Request(url, headers={"User-Agent": "zimi"})
        with urllib.request.urlopen(req, timeout=TORRENT_FETCH_TIMEOUT_S) as resp:
            data = resp.read(TORRENT_FETCH_MAX_BYTES + 1)
        if len(data) > TORRENT_FETCH_MAX_BYTES:
            raise RuntimeError(f".torrent metadata too large from {url}")
        return data

    def pause(self, tid: str) -> None:
        h = self._handles.get(tid)
        if h is not None and h.is_valid():
            h.pause()

    def resume(self, tid: str) -> None:
        h = self._handles.get(tid)
        if h is not None and h.is_valid():
            h.resume()

    def remove(self, tid: str, *, delete_files: bool = False) -> None:
        """delete_files only ever deletes payload under the staging dir.

        aria2's remove cleared session bookkeeping and never touched
        payload; libtorrent's delete_files flag REALLY deletes. Mapping
        them naively would let stop_mirror_seeds() delete library ZIMs.
        Staging partials are ours to clean; library files never."""
        lt = _lt()
        with self._lock:
            h = self._handles.pop(tid, None)
        if h is not None and h.is_valid() and self._ses is not None:
            in_staging = False
            try:
                save_path = os.path.normpath(h.status().save_path)
                staging = os.path.normpath(self.staging_dir)
                in_staging = save_path == staging or save_path.startswith(
                    staging + os.sep
                )
            except Exception:
                pass
            flags = lt.session.delete_files if (delete_files and in_staging) else 0
            try:
                self._ses.remove_torrent(h, flags)
            except Exception as e:
                log.debug("remove_torrent failed for %s: %s", tid, e)
        try:
            os.unlink(self._resume_path(tid))
        except OSError:
            pass

    def status(self, tid: str) -> dict:
        lt = _lt()
        h = self._handles.get(tid)
        if h is None or not h.is_valid():
            return {
                "state": "removed",
                "gid": tid,
                "completed_bytes": 0,
                "total_bytes": 0,
                "down_speed": 0,
                "up_speed": 0,
                "peers": 0,
                "seeders": 0,
                "ratio": 0.0,
                "info_hash": tid,
                "error_code": "",
                "error_message": "",
            }
        s = h.status()
        if s.errc.value() != 0:
            state = "error"
        elif bool(s.flags & lt.torrent_flags.paused):
            state = "paused"
        elif s.state in (lt.torrent_status.seeding, lt.torrent_status.finished):
            # Content is done — caller installs the file; seeding
            # continues on the live handle exactly like aria2's
            # active+seeder remap did.
            state = "complete"
        else:
            # checking_files / downloading_metadata / downloading /
            # checking_resume_data all present as in-progress.
            state = "downloading"
        total = int(s.total_wanted)
        return {
            "state": state,
            "gid": tid,
            "completed_bytes": int(s.total_done),
            "total_bytes": total,
            "down_speed": int(s.download_payload_rate),
            "up_speed": int(s.upload_payload_rate),
            "peers": int(s.num_peers),
            "seeders": int(s.num_seeds),
            "ratio": float(s.all_time_upload) / max(total, 1),
            "info_hash": tid,
            "error_code": str(s.errc.value()) if s.errc.value() else "",
            "error_message": s.errc.message() if s.errc.value() else "",
        }

    def list_managed(self) -> list[dict]:
        lt = _lt()
        out = []
        for tid, h in list(self._handles.items()):
            if not h.is_valid():
                continue
            try:
                s = h.status()
            except Exception:
                continue
            if s.errc.value() != 0:
                status = "error"
            elif bool(s.flags & lt.torrent_flags.paused):
                status = "paused"
            else:
                status = "active"
            ti = h.torrent_file()
            files = []
            total = int(s.total_wanted)
            if ti is not None:
                fs = ti.files()
                files = [
                    {"path": os.path.join(s.save_path, fs.file_path(i))}
                    for i in range(fs.num_files())
                ]
                total = int(ti.total_size())
            out.append(
                {
                    "gid": tid,
                    "status": status,
                    "files": files,
                    "uploadLength": str(int(s.all_time_upload)),
                    "totalLength": str(total),
                    "infoHash": tid,
                }
            )
        return out

    def set_global_rate_limits(self, up_kb: int, down_kb: int) -> None:
        self._ensure_session()
        self._ses.apply_settings(
            {
                "upload_rate_limit": max(0, int(up_kb)) * 1024,
                "download_rate_limit": max(0, int(down_kb)) * 1024,
            }
        )

    def purge_stopped(self, keep_errors: bool = True) -> None:
        """No-op: libtorrent has no stopped-results ledger to groom.
        Finished downloads keep seeding on their live handle; policy
        passes remove() them when a cap is hit."""
```

Also add `import urllib.request` presence check — the module already imports `urllib.request` at the top (line 29). No new imports needed beyond what exists.

- [ ] **Step 5: Run the tests.**

Run: `python3 -m pytest tests/test_libtorrent_backend.py -q`
Expected: all PASS except the two `TestRealEngine` tests SKIP (no libtorrent locally).

- [ ] **Step 6: Full suite.**

Run: `python3 -m pytest tests/ -q -x --ignore=tests/test_article_languages.py`
Expected: everything green (aria2 still present and default — nothing else changed yet).

- [ ] **Step 7: Commit.**

```bash
git add tests/fake_lt.py tests/test_libtorrent_backend.py zimi/p2p.py
git commit -m "feat: in-process LibtorrentBackend alongside aria2

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Selection flip + aria2 deletion in p2p.py

**Files:**
- Modify: `zimi/p2p.py` — delete `find_aria2c` (45–68), `seed_options` (331–346), `effective_seed_options` (466–475), the whole `Aria2Backend` class (564–906), `get_backend_name` (220–225); rewrite `get_backend` (918–962) and `shutdown_backend` (976–982); update module docstring (1–16).
- Modify: `tests/test_p2p.py` — rewrite aria2-specific tests.
- Test: `tests/test_p2p.py`

**Interfaces:**
- Consumes: `LibtorrentBackend` from Task 1.
- Produces: `get_backend(data_dir=...)` returns `LibtorrentBackend | None` (None when BT disabled OR libtorrent unimportable OR session fails). `shutdown_backend()` stops any backend with a `stop` attr. `get_backend_name`, `find_aria2c`, `seed_options`, `effective_seed_options` NO LONGER EXIST — later tasks remove their callers.

- [ ] **Step 1: Update the p2p tests first.** In `tests/test_p2p.py`: delete `test_backend_default_is_aria2`, `test_backend_name_normalized`, `test_get_backend_returns_none_when_aria2_missing`, `test_get_backend_returns_none_for_unknown_backend`, `test_get_backend_returns_none_when_aria2_rpc_unreachable`, `test_status_maps_aria2_states`, `test_status_computes_ratio`, `test_status_handles_zero_total`, `test_is_alive_reflects_process_state` (their subjects are deleted; LibtorrentBackend equivalents already exist in test_libtorrent_backend.py). Replace with:

```python
def test_get_backend_none_without_libtorrent(monkeypatch, tmp_path):
    monkeypatch.setattr(p2p, "_backend_singleton", None)
    monkeypatch.setattr(p2p, "_lt_module", None)
    monkeypatch.setattr(p2p, "_lt_import_failed", True)
    monkeypatch.setenv("ZIMI_TORRENT", "1")
    assert p2p.get_backend(data_dir=str(tmp_path)) is None


def test_get_backend_libtorrent_singleton(monkeypatch, tmp_path):
    import sys, os
    sys.path.insert(0, os.path.dirname(__file__))
    import fake_lt

    monkeypatch.setattr(p2p, "_backend_singleton", None)
    monkeypatch.setattr(p2p, "_lt_module", fake_lt)
    monkeypatch.setattr(p2p, "_lt_import_failed", False)
    monkeypatch.setenv("ZIMI_TORRENT", "1")
    b1 = p2p.get_backend(data_dir=str(tmp_path))
    b2 = p2p.get_backend(data_dir=str(tmp_path))
    assert isinstance(b1, p2p.LibtorrentBackend)
    assert b1 is b2
    p2p.shutdown_backend()
```

Keep every config-knob test (`test_torrent_enabled_by_default`, ports, staging, `peek_backend`, etc.) — those functions are untouched.

- [ ] **Step 2: Run to see the new tests fail** (get_backend still builds aria2).

Run: `python3 -m pytest tests/test_p2p.py -q`
Expected: new tests FAIL, old deleted ones gone.

- [ ] **Step 3: Rewrite selection + delete aria2.** New `get_backend`:

```python
def get_backend(*, data_dir: str) -> BTBackend | None:
    """Return the libtorrent backend, or None (→ HTTP floor).

    None when: BT disabled, libtorrent unimportable on this install, or
    the session fails to start. Never crashes Zimi for a BT problem —
    HTTP is the universal transport underneath.
    """
    global _backend_singleton
    with _backend_lock:
        if not is_torrent_enabled():
            return None
        if _backend_singleton is not None:
            return _backend_singleton
        backend = LibtorrentBackend(
            bt_port=get_bt_port(),
            data_dir=data_dir,
            staging_dir=get_staging_dir(data_dir),
        )
        if not backend.available():
            log.info("BT unavailable (libtorrent missing?) — HTTP downloads only")
            return None
        log.info(
            "BT engine libtorrent ready on port %d (staging=%s)",
            backend.bt_port,
            backend.staging_dir,
        )
        _backend_singleton = backend
        return backend
```

New `shutdown_backend`:

```python
def shutdown_backend() -> None:
    """Stop the running engine (if any). Safe to call repeatedly."""
    global _backend_singleton
    with _backend_lock:
        if _backend_singleton is not None:
            try:
                _backend_singleton.stop()
            except Exception:
                pass
        _backend_singleton = None
```

Delete: `find_aria2c`, `get_backend_name`, `seed_options`, `effective_seed_options`, `class Aria2Backend`. Update the module docstring to describe the single-engine model. The `BTBackend` ABC STAYS for now (fakes in 4 test files subclass it) — flattening it is a follow-up inside this release only if the fakes are also updated; not worth forcing here.

- [ ] **Step 4: Fix ripples in zimi/ (callers of deleted names).** `grep -rn "find_aria2c\|get_backend_name\|seed_options\|effective_seed_options" zimi/` — expected hits: `manage.py:621` area and `library.py:662,1575-1577,1717-1722,1860-1865` (handled in Tasks 3–4; for THIS commit, library.py/manage.py must still import cleanly — do Tasks 2–4 as one atomic commit if the interpreter can't load in between. Preferred: proceed to Tasks 3 and 4 and commit all three together with the suite green.)

- [ ] **Step 5: (joint commit happens at end of Task 4).**

---

### Task 3: manage.py — /manage/bt-status for one engine

**Files:**
- Modify: `zimi/manage.py:615-640` (the `/manage/bt-status` block)

**Interfaces:**
- Consumes: `p2p.peek_backend()`, `p2p.is_torrent_enabled()`, `p2p._lt()` .
- Produces: JSON keys `enabled`, `backend` (now always `"libtorrent"`), `engine_importable` (bool, replaces `binary_present`), `sidecar_running` key KEPT with same name (the UI reads it) but now means "session alive".

- [ ] **Step 1: Replace the aria2 probing block.** Current code calls `p2p.get_backend_name()` and `p2p.find_aria2c()`; replace:

```python
        elif parsed.path == "/manage/bt-status":
            # Surface the BT engine state so the user can self-diagnose:
            # enabled? libtorrent importable on this install? session up?
            from zimi import p2p

            enabled = p2p.is_torrent_enabled()
            engine_importable = p2p._lt() is not None

            # Live state — peek only. A status view must never start the
            # engine (with BT on by default that would mean every settings
            # visit spins up a session).
            backend = p2p.peek_backend() if enabled else None
            engine_alive = backend is not None and backend.is_alive()

            if not enabled:
                status = "off"
            elif backend is not None:
                status = "ready"
            elif not engine_importable:
                status = "unavailable"
            else:
                # Importable, session just not started yet — it starts at
                # boot or on first download, so report ready-to-torrent.
                status = "ready"
```

Keep the rest of the handler's response shape; wherever it emitted `backend_name` emit `"libtorrent"`, wherever `binary_present` emit `engine_importable`, and keep the `sidecar_running`/alive key populated from `engine_alive`. **Read the full handler before editing** (lines ~600–700) and preserve upload/download totals logic (`manage.py:555` reads `uploadLength` from `list_managed` — the Task 1 contract already provides it).

- [ ] **Step 2:** `grep -n "binary_present\|backend_name\|aria2" zimi/manage.py zimi/static/app.js` — update the app.js consumer if it branches on `backend_name`/`binary_present` (expected: `bt-status` rendering around the settings panel; keep the JSON keys the UI actually reads, or update both sides together).

---

### Task 4: library.py — remove the aria2 seams

**Files:**
- Modify: `zimi/library.py` at exactly these seams:
  - `~1575-1577`: `seed_opts = _p2p.effective_seed_options()` / `seed_options(...)` — delete both branches; pass `options=None`.
  - `~1619-1623`: GID rebind comment + `tid = status.get("gid") or tid` — delete (libtorrent tids are stable; `status()["gid"]` still returns tid so this line is harmless, but it's dead — remove with its misleading comment).
  - `~1636`: `os.path.exists(staged + ".aria2")` control-file check — delete just the `.aria2` clause; KEEP the `not os.path.exists(staged)` check and KEEP the libzim `open_archive` validation (engine-agnostic corruption guards).
  - `~1346,1376-1378`: the `get_opts`/seed-ratio normalize block in `apply_seed_policy` — delete (no aria2 numeric ratios exist anymore; the ledger is the sole cap enforcement). Keep the uploadLength accumulation (`1391-1392`) — the contract still provides it.
  - `~660-665, 1715-1725, 1855-1868`: aria2 options dicts (`{"seed-ratio": "0", "bt-seed-unverified": "true", ...}`) passed to `add_torrent` — replace each `options={...}` with `options=None`. The intent ("verify existing file, then seed, never fetch") is libtorrent's native behavior when `save_path` points at the existing file.
- Test: existing suites `tests/test_bt_seeding.py`, `tests/test_bt_attempt.py`, `tests/test_mirror_mode.py`, `tests/test_http_seed.py`, `tests/test_dl_source.py`

**Interfaces:**
- Consumes: Task 1's contract (`status()`, `list_managed()` shapes).
- Produces: `library.py` calls only contract methods; no aria2-shaped options anywhere.

- [ ] **Step 1: Make each edit above.** Read 20 lines around each seam first; the line numbers drift after Task 2's deletions. Use `grep -n "effective_seed_options\|seed_options\|\.aria2\|followedBy\|seed-ratio\|bt-seed-unverified\|get_options" zimi/library.py` to find them all — the edit is done when that grep returns zero hits.

- [ ] **Step 2: Update test fakes.** The fakes in `test_bt_seeding.py`/`test_bt_attempt.py`/`test_mirror_mode.py` subclass or mimic `BTBackend`. Run the suites; failures will be assertions on aria2 options (e.g. expecting `seed-ratio` in captured `add_torrent` options) or fakes returning shapes missing contract keys. Fix assertions to match `options=None` and fakes to emit the Task 1 `list_managed` contract. Do NOT weaken behavioral assertions (e.g. "seed added after download", "mirror-off stops only mirror seeds") — only their aria2-specific surface.

- [ ] **Step 3: Full suite.**

Run: `python3 -m pytest tests/ -q --ignore=tests/test_article_languages.py`
Expected: all green, `TestRealEngine` skipped.

- [ ] **Step 4: Zero-reference check + line counts.**

Run: `grep -rn "aria2\|Aria2" zimi/ --include="*.py" | grep -v "^Binary"`
Expected: no functional references (historical comments/docstrings mentioning the migration are fine — keep the two corrupt-ZIM war-story comments if their lesson still applies, rewritten to name the old engine in past tense).

- [ ] **Step 5: Commit Tasks 2+3+4 together** (single atomic engine-swap commit; the tree never has a broken import in between).

```bash
git add zimi/p2p.py zimi/library.py zimi/manage.py tests/
git commit -m "feat!: libtorrent replaces the aria2 sidecar — one in-process engine

Deletes Aria2Backend and its four out-of-process compensation layers
(RPC port-walking, process liveness polling, followedBy GID rebind,
OPENSSL_MODULES hack). HTTP remains the universal fallback when
libtorrent isn't importable.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Docker image ships libtorrent

**Files:**
- Modify: `Dockerfile` (line 3–6 area: the aria2 apt install)
- Modify: `docker-compose.yml` only if it references aria2 (grep first)

**Interfaces:**
- Produces: `import libtorrent` succeeds inside the image.

- [ ] **Step 1: Read the Dockerfile top to identify the base image.** Decision rule:
  - Base is `python:3.11-slim`/`python:3.12-slim` (Debian): `pip install libtorrent==2.0.*` in the image (manylinux wheels exist for cp311/cp312) — preferred, version-pinned, no apt/dist-packages path games.
  - Base is `debian:*` with system python: `apt-get install -y python3-libtorrent` instead.
  Remove `aria2` from the apt list either way.

- [ ] **Step 2: Build + verify locally (Mac).**

Run: `docker compose build 2>&1 | tail -5 && docker compose run --rm --entrypoint python3 zimi -c "import libtorrent; print(libtorrent.version)"`
Expected: prints a `2.0.x` version string.

- [ ] **Step 3: Run the real-engine tests inside the container.**

Run: `docker compose run --rm --entrypoint python3 zimi -m pytest tests/test_libtorrent_backend.py -q` (mount tests via `-v $PWD/tests:/app/tests` if the image doesn't COPY them)
Expected: ALL tests pass including `TestRealEngine` (no skips).

- [ ] **Step 4: Container smoke — server boots, BT status ready.**

Run: `docker compose up -d && sleep 5 && curl -s http://localhost:8899/manage/bt-status | python3 -m json.tool && docker compose down`
Expected: `"backend": "libtorrent"`, status `ready` (or `off` if BT disabled in compose env — then verify with ZIMI_TORRENT=1).

- [ ] **Step 5: Commit.**

```bash
git add Dockerfile docker-compose.yml
git commit -m "build: Docker image ships libtorrent, drops aria2

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Desktop builds bundle libtorrent (DMG + AppImage)

**Files:**
- Modify: `.github/workflows/desktop-release.yml` — delete the two "Prepare aria2 sidecar" steps (~104–123), the aria2c signing line (~269), pin `python-version: "3.12"` in every build job, add `pip install libtorrent==2.0.*` to the build-deps step.
- Modify: `zimi_desktop.spec` — delete the `ZIMI_ARIA2_DIR` block (63–79); add libtorrent collection.
- Delete: `ci/bundle_aria2_macos.sh`

**Interfaces:**
- Produces: DMG and AppImage where `import libtorrent` works; if a wheel is missing for a platform, that build still succeeds and runs HTTP-only (soft import) — the release is never hostage to bundling.

- [ ] **Step 1: zimi_desktop.spec.** Replace the aria2 block with:

```python
# libtorrent (in-process BT engine): PyInstaller misses compiled-extension
# dylibs without an explicit collect. Soft dependency — if the build venv
# has no libtorrent wheel this collects nothing and the app runs HTTP-only.
from PyInstaller.utils.hooks import collect_dynamic_libs, collect_submodules
lt_bins = collect_dynamic_libs('libtorrent')
lt_hidden = collect_submodules('libtorrent')
```

and wire `binaries=libzim_bins + lt_bins` and `hiddenimports=[...existing..., *lt_hidden]` into the `Analysis(...)` call.

- [ ] **Step 2: desktop-release.yml.** Delete aria2 steps + signing line; ensure `actions/setup-python` uses `python-version: "3.12"`; add `pip install "libtorrent==2.0.*"` where build deps install; make it non-fatal per platform: `pip install "libtorrent==2.0.*" || echo "::warning::no libtorrent wheel — this build runs HTTP-only"`.

- [ ] **Step 3: Validate the spec locally as far as the Mac allows.** Local Python is 3.14 (no wheel), so a local PyInstaller run exercises the soft-import path only:

Run: `python3 -c "from PyInstaller.utils.hooks import collect_dynamic_libs; print(collect_dynamic_libs('libtorrent'))"`
Expected: `[]` and no crash (proves the spec tolerates wheel absence). Full validation happens on the CI runners at release time — flag this explicitly in the PR body as the one thing not verifiable pre-CI.

- [ ] **Step 4: Commit.**

```bash
git add .github/workflows/desktop-release.yml zimi_desktop.spec
git rm ci/bundle_aria2_macos.sh
git commit -m "build: desktop bundles libtorrent, aria2 sidecar retired

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Docs + changelog

**Files:**
- Modify: `CHANGELOG.md` — new `[1.7.5] - Unreleased` section; ALSO fix the duplicate `### Security` header in `[1.7.4]` (lines 39/41) while in the file.
- Modify: `CLAUDE.md` — Architecture section: `p2p.py` description (aria2 sidecar → in-process libtorrent), update its line count, update the "ZIM transfer model" paragraph (BT bundling claim: "bundled in Docker and the desktop DMG/AppImage" still true, engine name changes).
- Modify: `README.md` — ONLY if it names aria2 (grep first); minimal touch, Eric reviews all public text.

- [ ] **Step 1:** CHANGELOG entry (Keep-a-Changelog):

```markdown
## [1.7.5] - Unreleased

### Changed
- BitTorrent engine: the bundled aria2c sidecar is replaced by in-process
  libtorrent. Real per-torrent stats, fast-resume across restarts, no more
  RPC ports or orphaned sidecar processes. Where libtorrent isn't available
  (e.g. bare `pip install zimi`), downloads simply use HTTP as always.

### Removed
- aria2 backend and bundling (Docker package, desktop sidecar binaries,
  `ZIMI_BT_BACKEND` selection). `ZIMI_BT` configuration is unchanged.
```

- [ ] **Step 2:** `grep -rn -i "aria2" CLAUDE.md README.md docs/*.md` and update each live doc (plans/ history stays as-is — it's a record).

- [ ] **Step 3: Commit.**

```bash
git add CHANGELOG.md CLAUDE.md README.md
git commit -m "docs: libtorrent migration notes, 1.7.4 changelog dedup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: End-to-end validation gate (before ANY deploy/PR)

No file changes — a verification checklist with evidence required for each line:

- [ ] **Full suite on Mac:** `python3 -m pytest tests/ -q --ignore=tests/test_article_languages.py` → paste tail (must be green; real-engine tests skip).
- [ ] **Full suite in Docker:** real-engine tests pass (no skips) — Task 5 Step 3 output.
- [ ] **Real-swarm download in container:** pick the smallest real Kiwix ZIM with a torrent (e.g. a `_nopic` mini), `curl -X POST` the manage download endpoint with BT on, watch `/manage/downloads` until complete, verify the ZIM opens (server lists it). This is the one test that exercises DHT/trackers/UPnP against the real world.
- [ ] **Seed continuity:** in the container, confirm the finished download appears in `list_managed` as an active seed and `/manage/bt-status` upload counters move (or are at least present).
- [ ] **Restart resume:** `docker compose restart`, confirm the seed comes back from `.fastresume` files without re-hashing from zero (log line) and the seed ledger still shows intent.
- [ ] **Kill-the-toggle:** flip BT off via the UI/pref, confirm session shuts down (`bt-status: off`), flip on, confirm it returns.
- [ ] **NAS deploy** — ONLY after Eric's explicit go, using `./deploy.sh` semantics but NAS-only (skip desktop build steps). After deploy: `/manage/bt-status` ready, mirror seeds re-adopted from ledger, WAN + LAN 200s.
- [ ] **PR** — open only with Eric's explicit go; body text is his to review; no session links.

---

## Execution notes

- Tasks 2–4 are one atomic commit (the tree must never fail to import).
- If the real-swarm test can't complete in-container on the Mac (NAT double-hop), it moves to the NAS validation step — note it in the PR body rather than skipping silently.
- `p2p_nat.py` (UPnP) stays untouched this release even though libtorrent has native UPnP — both running is harmless (same port mapping requested twice), and removing it is a 1.7.6 cleanup with its own test pass.
- Phases 2–4 of v1.7.5 (agent-API `/chunks` + OpenAPI + benchmark; polish batch; cheap wins) are SEPARATE plan docs written after this lands — each independently shippable on the same branch.
