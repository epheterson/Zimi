"""Per-user server-side data storage (v1.8.1): bookmarks/history/preferences
kept per named user under ZIMI_DATA_DIR/userdata/<key>.json.

Two layers are exercised:
  • the users.py storage primitives (load/save/delete/all/restore) and their
    isolation guarantees, and
  • the /userdata GET/POST endpoints, which must be gated to the SESSION user —
    a user can only ever touch their OWN blob; anonymous/admin-without-a-user is
    refused (their data stays in the browser).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.http as http  # noqa: E402
import zimi.server as server  # noqa: E402
import zimi.users as users  # noqa: E402


def _setup(monkeypatch, tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(data_dir))
    return data_dir


# ── Storage primitives ──


def test_save_and_load_roundtrip(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    ok, err = users.save_user_data(
        "Alice", {"bookmarks": [{"zim": "a", "path": "b"}], "preferences": {"x": "1"}}
    )
    assert ok and err is None
    blob = users.load_user_data("Alice")
    assert blob["bookmarks"] == [{"zim": "a", "path": "b"}]
    assert blob["preferences"] == {"x": "1"}
    assert "updated" in blob


def test_load_missing_returns_empty(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    blob = users.load_user_data("nobody")
    assert (
        blob["bookmarks"] == [] and blob["history"] == [] and blob["preferences"] == {}
    )
    assert blob["folders"] == []  # v2: folders are first-class in the empty blob


def test_folders_roundtrip(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    folders = [{"id": "f1", "name": "Medical", "parent": "", "order": 0}]
    bookmarks = [{"zim": "a", "path": "b", "folder": "f1", "order": 0}]
    ok, err = users.save_user_data(
        "Alice", {"bookmarks": bookmarks, "folders": folders}
    )
    assert ok and err is None
    blob = users.load_user_data("Alice")
    assert blob["folders"] == folders
    # The per-bookmark folder/order fields ride opaquely inside the list.
    assert blob["bookmarks"][0]["folder"] == "f1"


def test_folders_default_empty_when_absent(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    # A pre-v2 blob (no folders key) saves cleanly with folders → [].
    ok, _ = users.save_user_data("Bob", {"bookmarks": [{"zim": "a", "path": "b"}]})
    assert ok
    assert users.load_user_data("Bob")["folders"] == []


def test_key_is_casefolded(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    users.save_user_data("Alice", {"bookmarks": [{"zim": "a", "path": "b"}]})
    # A differently-cased name resolves to the SAME blob.
    assert users.load_user_data("ALICE")["bookmarks"] == [{"zim": "a", "path": "b"}]


def test_users_are_isolated_on_disk(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    users.save_user_data("alice", {"bookmarks": [{"zim": "A", "path": "1"}]})
    users.save_user_data("bob", {"bookmarks": [{"zim": "B", "path": "2"}]})
    assert users.load_user_data("alice")["bookmarks"] == [{"zim": "A", "path": "1"}]
    assert users.load_user_data("bob")["bookmarks"] == [{"zim": "B", "path": "2"}]


def test_oversize_blob_rejected(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    huge = [{"zim": "z", "path": "p" * 1000} for _ in range(6000)]
    ok, err = users.save_user_data("alice", {"bookmarks": huge})
    assert not ok and err == "data too large"


def test_delete_user_removes_their_data(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    users._save_users({"alice": {"name": "alice", "pw": "H", "role": "user"}})
    users.save_user_data("alice", {"bookmarks": [{"zim": "a", "path": "b"}]})
    assert os.path.exists(users._userdata_path("alice"))
    users.delete_user("alice")
    assert not os.path.exists(users._userdata_path("alice"))


def test_key_traversal_is_refused(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    for bad in ("..", ".", "a/b", ""):
        assert users._safe_userdata_key(bad) is None


def test_all_and_restore_roundtrip(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    users.save_user_data("alice", {"bookmarks": [{"zim": "a", "path": "1"}]})
    users.save_user_data("bob", {"history": [{"zim": "b", "path": "2"}]})
    snap = users.all_user_data()
    assert set(snap) == {"alice", "bob"}
    # Wipe and restore from the snapshot.
    users.delete_user_data("alice")
    users.delete_user_data("bob")
    assert users.all_user_data() == {}
    n = users.restore_user_data(snap)
    assert n == 2
    assert users.load_user_data("alice")["bookmarks"] == [{"zim": "a", "path": "1"}]


def test_restore_overwrite_clears_extras(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    users.save_user_data("stale", {"bookmarks": [{"zim": "x", "path": "y"}]})
    users.restore_user_data({"fresh": {"bookmarks": []}}, overwrite=True)
    assert set(users.all_user_data()) == {"fresh"}  # "stale" was cleared


# ── Endpoint gating (/userdata) ──


class _Handler(http.ZimHandler):
    """Minimal ZimHandler stand-in — no socket, just enough to run the two
    /userdata handlers and capture their response."""

    def __init__(self, session_user=None):
        self._session_user = session_user
        self.status = None
        self.body = None
        self.headers = {}

    def _json(self, status, body):
        self.status = status
        self.body = body
        return None


def test_userdata_get_requires_signed_in_user(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    monkeypatch.setattr(users, "resolve_request_user", lambda h: None)  # anon/admin
    h = _Handler()
    h._handle_userdata_get()
    assert h.status == 401


def test_userdata_post_saves_only_session_user(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    # The session identity — NOT anything in the body — decides whose blob is hit.
    monkeypatch.setattr(users, "resolve_request_user", lambda h: "alice")
    h = _Handler()
    h._handle_userdata_post({"bookmarks": [{"zim": "a", "path": "b"}], "name": "bob"})
    assert h.status == 200
    # Written under alice; bob is untouched (no cross-user write path).
    assert users.load_user_data("alice")["bookmarks"] == [{"zim": "a", "path": "b"}]
    assert users.load_user_data("bob")["bookmarks"] == []


def test_userdata_get_returns_own_blob(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    users.save_user_data("alice", {"bookmarks": [{"zim": "a", "path": "b"}]})
    monkeypatch.setattr(users, "resolve_request_user", lambda h: "alice")
    h = _Handler()
    h._handle_userdata_get()
    assert h.status == 200
    assert h.body["bookmarks"] == [{"zim": "a", "path": "b"}]


# ── Saved (1.12): the account's copy of the store, merged, never replaced ──

CASES = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "saved_merge_cases.json"
)
DAY_MS = 86400 * 1000


def _store(**parts):
    s = users._saved_empty()
    s.update(parts)
    return s


def _item(path, title="T", ts=1000, **extra):
    rec = {
        "kind": "article",
        "zim": "w",
        "path": path,
        "title": title,
        "added": ts,
        "ts": ts,
    }
    rec.update(extra)
    return rec


def test_merge_cases_shared_with_the_browser():
    """The same cases app.js's Saved._merge passes (tests/test_saved_store.cjs):
    the two twins agree record for record."""
    import json

    with open(CASES, encoding="utf-8") as f:
        cases = json.load(f)["cases"]
    for case in cases:
        got = users._merge_saved(
            users._clean_saved(case["a"]),
            users._clean_saved(case["b"]),
            case["now"],
            case.get("budget"),
        )
        assert got == _store(**case["expect"]), case["name"]


def test_the_version_is_two_and_the_empty_blob_has_a_store(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    assert users._USERDATA_VERSION == 2
    assert users.load_user_data("nobody")["saved"] == users._saved_empty()
    users.save_user_data("alice", {"history": []})
    assert users.load_user_data("alice")["version"] == 2


def test_a_delete_on_one_device_survives_a_sync_from_another(monkeypatch, tmp_path):
    """Two phones on one account. Both have X; phone A deletes it and syncs;
    phone B, which still has X, syncs after. X stays deleted, on the server
    and in what phone B is handed back."""
    _setup(monkeypatch, tmp_path)
    x = _item("A/X")
    both = _store(
        items={"w\nA/X": x}, members={"liked\tw\nA/X": {"order": 0, "ts": 1000}}
    )
    ok, _, _ = users.sync_user_data("alice", {"saved": both}, now_ms=1500)
    assert ok
    phone_a = _store(gone={"i:w\nA/X": 2000, "m:liked\tw\nA/X": 2000})
    users.sync_user_data("alice", {"saved": phone_a}, now_ms=2100)
    ok, _, doc = users.sync_user_data("alice", {"saved": both}, now_ms=2200)
    assert ok
    assert doc["saved"]["items"] == {} and doc["saved"]["members"] == {}
    assert users.load_user_data("alice")["saved"]["items"] == {}
    # Saved again later on phone B, it is back.
    again = _store(items={"w\nA/X": _item("A/X", ts=3000)})
    _, _, doc = users.sync_user_data("alice", {"saved": again}, now_ms=3100)
    assert list(doc["saved"]["items"]) == ["w\nA/X"]


def test_two_devices_writing_in_turn_lose_nothing(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    users.sync_user_data("alice", {"saved": _store(items={"w\nA/A": _item("A/A")})})
    _, _, doc = users.sync_user_data(
        "alice", {"saved": _store(items={"w\nA/B": _item("A/B", ts=1100)})}
    )
    assert set(doc["saved"]["items"]) == {"w\nA/A", "w\nA/B"}


def test_a_sync_leaves_the_fields_it_does_not_send(monkeypatch, tmp_path):
    """The shell sends only the store as it syncs; the history, preferences
    and 1.11's bookmarks kept on the server stay as they were (the old keys
    stay readable for one release)."""
    _setup(monkeypatch, tmp_path)
    users.save_user_data(
        "alice",
        {
            "bookmarks": [{"zim": "w", "path": "A/Old"}],
            "folders": [{"id": "f1", "name": "F"}],
            "history": [{"zim": "w", "path": "A/H"}],
            "preferences": {"apps": True},
        },
    )
    users.sync_user_data("alice", {"saved": _store(items={"w\nA/X": _item("A/X")})})
    blob = users.load_user_data("alice")
    assert blob["bookmarks"] == [{"zim": "w", "path": "A/Old"}]
    assert blob["folders"] == [{"id": "f1", "name": "F"}]
    assert blob["history"] == [{"zim": "w", "path": "A/H"}]
    assert blob["preferences"] == {"apps": True}
    assert list(blob["saved"]["items"]) == ["w\nA/X"]
    # A preferences write keeps the store.
    users.sync_user_data("alice", {"preferences": {"apps": False}})
    assert list(users.load_user_data("alice")["saved"]["items"]) == ["w\nA/X"]


def test_the_clients_shape_is_never_trusted(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    ok, _, doc = users.sync_user_data(
        "alice",
        {
            "saved": {
                "items": {
                    "w\nA/X": _item("A/X", title="t" * 900),
                    "evil": _item("A/Y"),
                    "w\nA/Z": "not a record",
                },
                "lists": ["not", "a", "map"],
                "positions": {
                    "w\nA/P": _item("A/P", where={"f": float("inf"), "c": 3})
                },
                "legacy": "yes",
            }
        },
    )
    assert ok
    saved = doc["saved"]
    assert list(saved["items"]) == ["w\nA/X"]
    assert len(saved["items"]["w\nA/X"]["title"]) == users._SAVED_TITLE_MAX
    assert saved["lists"] == {}
    assert saved["positions"]["w\nA/P"]["where"] == {"c": 3}
    assert saved["legacy"] is False
    ok, _, _ = users.sync_user_data("alice", {"saved": "garbage"})
    assert ok  # nothing merged in, nothing lost


def test_nothing_saved_is_dropped_to_make_room(monkeypatch, tmp_path):
    """Past the byte budget the oldest tombstones go, then the oldest places;
    a store still over it is refused whole and what was kept stays."""
    _setup(monkeypatch, tmp_path)
    items = {"w\nA/%d" % i: _item("A/%d" % i, ts=1000 + i) for i in range(40)}
    gone = {"i:w\nA/old%d" % i: 500 + i for i in range(40)}
    ok, _, doc = users.sync_user_data(
        "alice", {"saved": _store(items=items, gone=gone)}, now_ms=2000
    )
    assert ok and len(doc["saved"]["items"]) == 40
    size = users._saved_bytes(doc["saved"])
    # Room for the items and half the tombstones: the oldest half go.
    half = dict(doc["saved"], gone=dict(sorted(gone.items(), key=lambda g: g[1])[20:]))
    assert users._saved_bytes(half) < size
    monkeypatch.setattr(users, "_SAVED_MAX_BYTES", users._saved_bytes(half))
    ok, _, doc = users.sync_user_data("alice", {"saved": _store()}, now_ms=2000)
    assert ok and len(doc["saved"]["items"]) == 40
    assert sorted(doc["saved"]["gone"].values()) == list(range(520, 540))
    assert users._saved_bytes(doc["saved"]) <= users._SAVED_MAX_BYTES
    # No room for what was saved: refused, never trimmed, the file as it was.
    monkeypatch.setattr(users, "_SAVED_MAX_BYTES", 1000)
    more = {"w\nA/new": _item("A/new", ts=3000)}
    ok, err, doc = users.sync_user_data(
        "alice", {"saved": _store(items=more)}, now_ms=3000
    )
    assert not ok and err == "saved too large" and doc is None
    kept = users.load_user_data("alice")["saved"]
    assert len(kept["items"]) == 40 and "w\nA/new" not in kept["items"]


def test_the_size_is_the_files_own(monkeypatch, tmp_path):
    """Titles in Chinese take three bytes a character in the file, not the
    six of an ASCII escape, and 1.11's bookmarks kept beside the store do not
    count against it."""
    _setup(monkeypatch, tmp_path)
    title = "漢" * 500
    items = {"w\nA/%d" % i: _item("A/%d" % i, title=title) for i in range(1500)}
    ok, err, _ = users.sync_user_data("alice", {"saved": _store(items=items)})
    assert ok, err
    path = users._userdata_path("alice")
    assert os.path.getsize(path) < users._SAVED_MAX_BYTES + 4096
    old = [{"zim": "w", "path": "A/%d" % i, "title": "x" * 900} for i in range(3500)]
    ok, err = users.save_user_data(
        "bob", {"bookmarks": old, "saved": _store(items=items)}
    )
    assert ok, err


def test_places_are_kept_per_app(monkeypatch, tmp_path):
    """Zimipedia keeps a place per article read: its places never push
    Bookshelf's books out of Continue."""
    _setup(monkeypatch, tmp_path)
    books = {
        "g\nB.%d" % i: _item("B.%d" % i, ts=1000 + i, app="books", kind="book")
        for i in range(3)
    }
    for k, r in books.items():
        r["zim"], r["path"] = k.split("\n")
    wiki = {
        "w\nA/%d" % i: _item("A/%d" % i, ts=5000 + i, app="wiki")
        for i in range(users._SAVED_POS_PER_APP + 20)
    }
    for r in list(books.values()) + list(wiki.values()):
        del r["added"]
    _, _, doc = users.sync_user_data(
        "alice", {"saved": _store(positions=dict(books, **wiki))}
    )
    kept = doc["saved"]["positions"]
    assert all(k in kept for k in books)
    assert (
        sum(1 for r in kept.values() if r["app"] == "wiki") == users._SAVED_POS_PER_APP
    )
    assert "w\nA/0" not in kept and "w\nA/%d" % (users._SAVED_POS_PER_APP + 19) in kept


def test_a_clock_that_runs_ahead_is_held_to_the_servers(monkeypatch, tmp_path):
    """A device a day fast saves X; a delete ten minutes later on a device
    with the right time still holds."""
    _setup(monkeypatch, tmp_path)
    now = 1790000000000
    fast = _store(items={"w\nA/X": _item("A/X", ts=now + DAY_MS)})
    _, _, doc = users.sync_user_data("alice", {"saved": fast}, now_ms=now)
    rec = doc["saved"]["items"]["w\nA/X"]
    assert rec["ts"] == rec["added"] == now + users._SAVED_FUTURE_MS
    later = now + 10 * 60 * 1000
    _, _, doc = users.sync_user_data(
        "alice", {"saved": _store(gone={"i:w\nA/X": later})}, now_ms=later
    )
    assert doc["saved"]["items"] == {}


def test_a_write_that_does_not_land_is_a_failure(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    users.sync_user_data("alice", {"saved": _store(items={"w\nA/A": _item("A/A")})})
    # The rename that lands the write fails; a read-only directory would do
    # it on POSIX but not on Windows, where the mode bit is ignored.
    def _refuse(src, dst):
        raise PermissionError(13, "refused", dst)

    with monkeypatch.context() as m:
        m.setattr(server.os, "replace", _refuse)
        ok, err, doc = users.sync_user_data(
            "alice", {"saved": _store(items={"w\nA/B": _item("A/B")})}
        )
    assert not ok and err == "write failed" and doc is None
    assert list(users.load_user_data("alice")["saved"]["items"]) == ["w\nA/A"]


def test_userdata_post_too_large_is_413(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    monkeypatch.setattr(users, "resolve_request_user", lambda h: "alice")
    monkeypatch.setattr(users, "_SAVED_MAX_BYTES", 100)
    h = _Handler()
    h._handle_userdata_post({"saved": _store(items={"w\nA/B": _item("A/B")})})
    assert h.status == 413 and h.body == {"error": "saved too large"}


def test_old_tombstones_are_forgotten(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    gone = {"i:w\nA/Old": 1000, "i:w\nA/New": 91 * DAY_MS}
    _, _, doc = users.sync_user_data(
        "alice", {"saved": _store(gone=gone)}, now_ms=91 * DAY_MS + 1000
    )
    assert doc["saved"]["gone"] == {"i:w\nA/New": 91 * DAY_MS}


def test_userdata_post_merges_and_hands_back_the_store(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    monkeypatch.setattr(users, "resolve_request_user", lambda h: "alice")
    users.sync_user_data("alice", {"saved": _store(items={"w\nA/A": _item("A/A")})})
    h = _Handler()
    h._handle_userdata_post({"saved": _store(items={"w\nA/B": _item("A/B")})})
    assert h.status == 200
    assert set(h.body["saved"]["items"]) == {"w\nA/A", "w\nA/B"}


def test_a_file_that_cannot_be_read_is_never_written_over(monkeypatch, tmp_path):
    """A data file that is there but unreadable (bad bytes, a permission
    change after a restore) must not be taken for an empty one: the next
    sync would merge into nothing and write that over the file."""
    _setup(monkeypatch, tmp_path)
    users.sync_user_data("alice", {"saved": _store(items={"w\nA/A": _item("A/A")})})
    path = users._userdata_path("alice")
    with open(path, "rb") as f:
        good = f.read()
    with open(path, "wb") as f:
        f.write(b"\xff\xfe not json")
    ok, err, doc = users.sync_user_data(
        "alice", {"saved": _store(items={"w\nA/B": _item("A/B", ts=1100)})}
    )
    assert (ok, err, doc) == (False, "read failed", None)
    with open(path, "rb") as f:
        assert f.read() == b"\xff\xfe not json"  # untouched, for someone to rescue
    # The endpoint says the server failed, so the device keeps it and retries.
    h = _Handler()
    monkeypatch.setattr(users, "resolve_request_user", lambda _h: "alice")
    h._handle_userdata_post({"saved": _store()})
    assert h.status == 503
    with open(path, "wb") as f:
        f.write(good)
    assert list(users.load_user_data("alice")["saved"]["items"]) == ["w\nA/A"]


def test_a_merge_restore_keeps_what_was_saved_since_the_backup(monkeypatch, tmp_path):
    """Restoring last month's backup in merge mode merges each user's saved
    store; what they saved after the backup stays. A backup from before 1.12
    carries no store and leaves the kept one as it is."""
    _setup(monkeypatch, tmp_path)
    users.sync_user_data("alice", {"saved": _store(items={"w\nA/A": _item("A/A")})})
    backup = users.all_user_data()
    users.sync_user_data(
        "alice", {"saved": _store(items={"w\nA/B": _item("A/B", ts=2000)})}
    )
    users.sync_user_data("bob", {"saved": _store(items={"w\nB/B": _item("B/B")})})
    assert users.restore_user_data(backup) == 1
    assert set(users.load_user_data("alice")["saved"]["items"]) == {"w\nA/A", "w\nA/B"}
    old = {"bob": {"bookmarks": [{"zim": "b", "path": "old"}]}}
    assert users.restore_user_data(old) == 1
    bob = users.load_user_data("bob")
    assert list(bob["saved"]["items"]) == ["w\nB/B"]
    assert bob["bookmarks"] == [{"zim": "b", "path": "old"}]
    # Overwrite still writes the backup as it was.
    users.restore_user_data(backup, overwrite=True)
    assert set(users.load_user_data("alice")["saved"]["items"]) == {"w\nA/A"}
    assert set(users.all_user_data()) == {"alice"}
