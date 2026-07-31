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
