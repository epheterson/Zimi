"""Multi-user v1 (v1.8): named accounts + per-user ZIM allowlists.

Covers the full matrix the feature must hold:
- user CRUD (create/list/delete/set-password/set-allowlist) + validation
- authentication + session issue/resolve/drop (fail-closed)
- per-user allowlist FILTERING through the single choke points
  (get_zim_files / list_zims / get_archive / zim_allowed) and request_allow()
- security: a user session token never passes admin /manage/* auth; admin and
  anonymous stay all-access; username enumeration blocked (generic errors)
- legacy installs (no users.json) are completely untouched
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as _srv  # noqa: E402
from zimi import manage, users  # noqa: E402


class _FakeHandler:
    """Minimal ZimHandler stand-in: headers + client privacy + _json capture."""

    def __init__(self, headers=None, private=True):
        self.headers = headers or {}
        self._private = private
        self.responses = []  # [(code, data), ...]

    def _is_private_client(self):
        return self._private

    def _json(self, code, data):
        self.responses.append((code, data))
        return None

    @property
    def last(self):
        return self.responses[-1] if self.responses else None


def _bearer(token, user=None):
    h = {"Authorization": "Bearer " + token}
    if user is not None:
        h["X-Zimi-User"] = user
    return h


def _cookie(token):
    return {"Cookie": "zimi_session=" + token}


class _UsersBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._orig_data_dir = _srv.ZIMI_DATA_DIR
        _srv.ZIMI_DATA_DIR = self._tmp
        for var in ("ZIMI_MANAGE_PASSWORD", "ZIMI_MANAGE_USER", "ZIMI_API_TOKEN"):
            os.environ.pop(var, None)
        manage._env_pw_hash_cache = None
        _srv.clear_request_allow()

    def tearDown(self):
        _srv.ZIMI_DATA_DIR = self._orig_data_dir
        for var in ("ZIMI_MANAGE_PASSWORD", "ZIMI_MANAGE_USER", "ZIMI_API_TOKEN"):
            os.environ.pop(var, None)
        manage._env_pw_hash_cache = None
        _srv.clear_request_allow()
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)


# ── Legacy install: nothing exists, nothing changes ────────────────────────


class TestLegacyUntouched(_UsersBase):
    def test_no_users_file_lists_empty(self):
        self.assertEqual(users.list_users(), [])

    def test_no_users_request_allow_is_none(self):
        # No creds, no users.json → all-access (anonymous view).
        self.assertIsNone(users.request_allow(_FakeHandler()))

    def test_get_zim_files_unfiltered_when_allow_none(self):
        _srv._zim_files_cache = {"a": "/z/a.zim", "b": "/z/b.zim"}
        try:
            _srv.clear_request_allow()
            self.assertEqual(set(_srv.get_zim_files()), {"a", "b"})
        finally:
            _srv._zim_files_cache = None


# ── CRUD + validation ──────────────────────────────────────────────────────


class TestUserCrud(_UsersBase):
    def test_create_and_list(self):
        ok, err = users.create_user("Kid", "pw123", allowlist=["wiki_a"])
        self.assertTrue(ok, err)
        listed = users.list_users()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["name"], "Kid")
        self.assertFalse(listed[0]["all_access"])
        self.assertEqual(listed[0]["allowlist"], ["wiki_a"])
        # v2 seam present + empty.
        self.assertEqual(listed[0]["flags"], {})

    def test_list_never_leaks_hash(self):
        users.create_user("Kid", "pw123")
        self.assertNotIn("pw", users.list_users()[0])

    def test_all_access_user(self):
        ok, _ = users.create_user("Grown", "pw123", allowlist=None)
        self.assertTrue(ok)
        self.assertTrue(users.list_users()[0]["all_access"])

    def test_duplicate_rejected_case_insensitive(self):
        users.create_user("Kid", "pw123")
        ok, err = users.create_user("kid", "pw456")
        self.assertFalse(ok)
        self.assertIn("exists", err)

    def test_reserved_name_rejected(self):
        for bad in ("admin", "Administrator", "root", "anonymous"):
            ok, err = users.create_user(bad, "pw123")
            self.assertFalse(ok, bad)

    def test_invalid_name_rejected(self):
        for bad in ("", "  ", "a/b", "x" * 33, "no\nnewline"):
            ok, _ = users.create_user(bad, "pw123")
            self.assertFalse(ok, repr(bad))

    def test_empty_password_rejected(self):
        ok, _ = users.create_user("Kid", "")
        self.assertFalse(ok)

    def test_delete(self):
        users.create_user("Kid", "pw123")
        ok, _ = users.delete_user("kid")  # casefold
        self.assertTrue(ok)
        self.assertEqual(users.list_users(), [])

    def test_delete_missing(self):
        ok, err = users.delete_user("ghost")
        self.assertFalse(ok)

    def test_set_password(self):
        users.create_user("Kid", "pw123")
        self.assertIsNotNone(users.authenticate("Kid", "pw123"))
        ok, _ = users.set_password("kid", "newpw")
        self.assertTrue(ok)
        self.assertIsNone(users.authenticate("Kid", "pw123"))
        self.assertIsNotNone(users.authenticate("Kid", "newpw"))

    def test_set_allowlist_round_trip(self):
        users.create_user("Kid", "pw123", allowlist=["a"])
        ok, _ = users.set_allowlist("kid", ["b", "c", "b"])  # de-dup
        self.assertTrue(ok)
        self.assertEqual(users.list_users()[0]["allowlist"], ["b", "c"])
        # None → all-access
        users.set_allowlist("kid", None)
        self.assertTrue(users.list_users()[0]["all_access"])

    def test_password_uses_pbkdf2_like_admin(self):
        users.create_user("Kid", "pw123")
        stored = users.get_user("Kid")["pw"]
        # salt$hash shape — same as manage._hash_pw
        self.assertIn("$", stored)
        self.assertTrue(manage._verify_password("pw123", stored))


# ── Authentication + sessions ──────────────────────────────────────────────


class TestAuthSessions(_UsersBase):
    def test_authenticate(self):
        users.create_user("Kid", "pw123")
        self.assertEqual(users.authenticate("Kid", "pw123"), "Kid")
        self.assertEqual(users.authenticate("kid", "pw123"), "Kid")  # casefold
        self.assertIsNone(users.authenticate("Kid", "wrong"))
        self.assertIsNone(users.authenticate("ghost", "pw123"))

    def test_session_issue_resolve_drop(self):
        users.create_user("Kid", "pw123")
        token = users.create_session("Kid")
        self.assertEqual(users.resolve_session(token), "Kid")
        users.drop_session(token)
        self.assertIsNone(users.resolve_session(token))

    def test_session_stored_hashed_not_plaintext(self):
        users.create_user("Kid", "pw123")
        token = users.create_session("Kid")
        with open(users._sessions_path(), encoding="utf-8") as f:
            raw = f.read()
        self.assertNotIn(token, raw)

    def test_deleting_user_invalidates_sessions(self):
        users.create_user("Kid", "pw123")
        token = users.create_session("Kid")
        users.delete_user("Kid")
        self.assertIsNone(users.resolve_session(token))

    def test_password_change_invalidates_sessions(self):
        users.create_user("Kid", "pw123")
        token = users.create_session("Kid")
        users.set_password("Kid", "newpw")
        self.assertIsNone(users.resolve_session(token))

    def test_resolve_request_user_bearer_and_cookie(self):
        users.create_user("Kid", "pw123")
        token = users.create_session("Kid")
        self.assertEqual(
            users.resolve_request_user(_FakeHandler(_bearer(token))), "Kid"
        )
        self.assertEqual(
            users.resolve_request_user(_FakeHandler(_cookie(token))), "Kid"
        )
        # Bogus token → None (fail closed)
        self.assertIsNone(users.resolve_request_user(_FakeHandler(_bearer("garbage"))))


# ── request_allow: the identity → allow-set mapping ────────────────────────


class TestRequestAllow(_UsersBase):
    def test_restricted_user_gets_set(self):
        users.create_user("Kid", "pw123", allowlist=["a", "b"])
        token = users.create_session("Kid")
        allow = users.request_allow(_FakeHandler(_cookie(token)))
        self.assertEqual(allow, {"a", "b"})

    def test_all_access_user_gets_none(self):
        users.create_user("Grown", "pw123", allowlist=None)
        token = users.create_session("Grown")
        self.assertIsNone(users.request_allow(_FakeHandler(_bearer(token))))

    def test_anonymous_gets_none(self):
        self.assertIsNone(users.request_allow(_FakeHandler()))


# ── Filtering through the choke points ─────────────────────────────────────


class TestFiltering(_UsersBase):
    def setUp(self):
        super().setUp()
        _srv._zim_files_cache = {"a": "/z/a.zim", "b": "/z/b.zim", "c": "/z/c.zim"}
        _srv._zim_list_cache = [
            {"name": "a", "entries": 500, "language": "en"},
            {"name": "b", "entries": 500, "language": "en"},
            {"name": "c", "entries": 500, "language": "fr"},
        ]

    def tearDown(self):
        _srv._zim_files_cache = None
        _srv._zim_list_cache = None
        super().tearDown()

    def test_get_zim_files_filtered(self):
        _srv.set_request_allow({"a"})
        self.assertEqual(set(_srv.get_zim_files()), {"a"})

    def test_get_zim_files_does_not_mutate_cache(self):
        _srv.set_request_allow({"a"})
        _srv.get_zim_files()
        _srv.clear_request_allow()
        self.assertEqual(set(_srv.get_zim_files()), {"a", "b", "c"})

    def test_list_zims_filtered(self):
        _srv.set_request_allow({"b", "c"})
        names = {z["name"] for z in _srv.list_zims()}
        self.assertEqual(names, {"b", "c"})
        # Shared cache untouched
        _srv.clear_request_allow()
        self.assertEqual(len(_srv._zim_list_cache), 3)

    def test_zim_allowed(self):
        _srv.set_request_allow({"a"})
        self.assertTrue(_srv.zim_allowed("a"))
        self.assertFalse(_srv.zim_allowed("b"))
        _srv.clear_request_allow()
        self.assertTrue(_srv.zim_allowed("b"))

    def test_get_archive_fails_closed_for_disallowed(self):
        # Pre-pool a fake handle for 'b'; a restricted user must still get None.
        _srv._archive_pool["b"] = object()
        try:
            _srv.set_request_allow({"a"})
            self.assertIsNone(_srv.get_archive("b"))
            _srv.clear_request_allow()
            self.assertIsNotNone(_srv.get_archive("b"))
        finally:
            _srv._archive_pool.pop("b", None)


# ── Security: user tokens can't reach admin endpoints ──────────────────────


class TestUserVsAdminBoundary(_UsersBase):
    def test_session_token_not_admin(self):
        manage._set_manage_password("adminpw")
        users.create_user("Kid", "pw123", allowlist=["a"])
        token = users.create_session("Kid")
        # Session token as a manage Bearer → unauthorized (never matches admin).
        h = _FakeHandler(_bearer(token, "Kid"), private=False)
        self.assertTrue(manage._check_manage_auth(h))

    def test_user_password_not_admin(self):
        manage._set_manage_password("adminpw")
        users.create_user("Kid", "pw123")
        # A user's own password is not the admin password.
        h = _FakeHandler(_bearer("pw123", "Kid"), private=False)
        self.assertTrue(manage._check_manage_auth(h))

    def test_admin_still_authenticates(self):
        manage._set_manage_password("adminpw")
        h = _FakeHandler(_bearer("adminpw"), private=False)
        self.assertIsNone(manage._check_manage_auth(h))

    def test_manage_users_post_rejects_user_token(self):
        from types import SimpleNamespace

        manage._set_manage_password("adminpw")
        users.create_user("Kid", "pw123", allowlist=["a"])
        token = users.create_session("Kid")
        h = _FakeHandler(_bearer(token, "Kid"), private=False)
        manage.handle_manage_post(
            h,
            SimpleNamespace(path="/manage/users"),
            {"action": "delete", "name": "Kid"},
        )
        code, _ = h.last
        self.assertEqual(code, 401)
        # The user still exists — the delete never ran.
        self.assertEqual(len(users.list_users()), 1)


# ── verify_admin_credentials (unified /login helper) ───────────────────────


class TestAdminCredentials(_UsersBase):
    def test_correct(self):
        manage._set_manage_password("adminpw")
        self.assertTrue(manage.verify_admin_credentials("admin", "adminpw"))

    def test_wrong_password(self):
        manage._set_manage_password("adminpw")
        self.assertFalse(manage.verify_admin_credentials("admin", "nope"))

    def test_passwordless_has_no_admin_login(self):
        self.assertFalse(manage.verify_admin_credentials("admin", "anything"))

    def test_username_gate_enforced(self):
        manage._set_manage_password("adminpw", username="Alice")
        self.assertTrue(manage.verify_admin_credentials("alice", "adminpw"))
        self.assertFalse(manage.verify_admin_credentials("bob", "adminpw"))


# ── Admin manage/users CRUD via the real handler ───────────────────────────


class TestManageUsersEndpoint(_UsersBase):
    def _admin(self):
        return _FakeHandler(_bearer("adminpw"), private=False)

    def setUp(self):
        super().setUp()
        manage._set_manage_password("adminpw")

    def _post(self, data):
        from types import SimpleNamespace

        h = self._admin()
        manage.handle_manage_post(h, SimpleNamespace(path="/manage/users"), data)
        return h.last

    def test_create_delete_cycle(self):
        code, body = self._post(
            {"action": "create", "name": "Kid", "password": "pw123", "allowlist": ["a"]}
        )
        self.assertEqual(code, 200)
        self.assertEqual(len(body["users"]), 1)
        code, body = self._post({"action": "delete", "name": "Kid"})
        self.assertEqual(code, 200)
        self.assertEqual(body["users"], [])

    def test_unknown_action(self):
        code, _ = self._post({"action": "frobnicate"})
        self.assertEqual(code, 400)

    def test_get_lists_users_and_zims(self):
        from types import SimpleNamespace

        _srv._zim_files_cache = {"a": "/z/a.zim"}
        try:
            self._post(
                {"action": "create", "name": "Kid", "password": "pw", "allowlist": []}
            )
            h = self._admin()
            manage.handle_manage_get(h, SimpleNamespace(path="/manage/users"), {})
            code, body = h.last
            self.assertEqual(code, 200)
            self.assertIn("users", body)
            self.assertIn("a", body["zims"])
        finally:
            _srv._zim_files_cache = None


if __name__ == "__main__":
    unittest.main()
