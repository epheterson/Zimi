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
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as _srv  # noqa: E402
from zimi import manage, search, users  # noqa: E402


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

    def test_session_expires_after_ttl(self):
        users.create_user("Kid", "pw123")
        token = users.create_session("Kid")
        self._age_session(token, users.SESSION_TTL_S + 60)
        self.assertIsNone(users.resolve_session(token))

    def test_session_without_created_is_rejected(self):
        """A hand-edited or corrupt entry must not become an immortal token."""
        users.create_user("Kid", "pw123")
        token = users.create_session("Kid")
        sessions = users._load_sessions()
        sessions[users._token_hash(token)].pop("created")
        users._save_sessions(sessions)
        self.assertIsNone(users.resolve_session(token))

    def test_login_prunes_expired_sessions(self):
        users.create_user("Kid", "pw123")
        stale = users.create_session("Kid")
        self._age_session(stale, users.SESSION_TTL_S + 60)
        fresh = users.create_session("Kid")
        sessions = users._load_sessions()
        self.assertNotIn(users._token_hash(stale), sessions)
        self.assertIn(users._token_hash(fresh), sessions)

    def _age_session(self, token, seconds):
        sessions = users._load_sessions()
        ent = sessions[users._token_hash(token)]
        ent["created"] = int(ent["created"]) - seconds
        users._save_sessions(sessions)

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


# ── Search-result cache must not leak across allowlists ────────────────────


class TestSearchCacheRespectsAllowlist(_UsersBase):
    """The HTTP /search result cache is keyed per request. Its key MUST fold in
    the requester's allowlist identity, or an all-access session's broad results
    leak to a restricted user issuing the same query (and vice-versa)."""

    def setUp(self):
        super().setUp()
        _srv._search_cache_clear()

    def tearDown(self):
        _srv._search_cache_clear()
        super().tearDown()

    def _key(self, q="water", scope="", limit=5, fast=False):
        # Built exactly as http.py's /search handler builds it, for the CURRENT
        # request-allow context.
        return _srv._search_cache_key(q, scope, limit, fast)

    def test_anonymous_entry_not_served_to_restricted_user(self):
        # Anonymous (all-access) search populates the cache…
        _srv.clear_request_allow()
        _srv._search_cache_put(self._key(), {"results": ["ALL-ACCESS"]})
        # …a restricted user issuing the SAME query gets a MISS, so the filtered
        # path recomputes rather than serving the broad cached results.
        _srv.set_request_allow({"alpha"})
        self.assertIsNone(_srv._search_cache_get(self._key()))

    def test_restricted_entry_not_served_to_anonymous(self):
        _srv.set_request_allow({"alpha"})
        _srv._search_cache_put(self._key(), {"results": ["ALPHA-ONLY"]})
        _srv.clear_request_allow()
        self.assertIsNone(_srv._search_cache_get(self._key()))

    def test_two_different_allowlists_do_not_share(self):
        _srv.set_request_allow({"alpha"})
        _srv._search_cache_put(self._key(), {"results": ["ALPHA-ONLY"]})
        _srv.set_request_allow({"beta"})
        self.assertIsNone(_srv._search_cache_get(self._key()))

    def test_identical_allowlist_shares_entry(self):
        # Keyed caching, NOT a bypass: same allow-set → same key → cache HIT,
        # order-independent (sorted tuple).
        _srv.set_request_allow({"alpha", "beta"})
        _srv._search_cache_put(self._key(), {"results": ["A+B"]})
        _srv.clear_request_allow()
        _srv.set_request_allow({"beta", "alpha"})
        hit = _srv._search_cache_get(self._key())
        self.assertIsNotNone(hit)
        self.assertEqual(hit["results"], ["A+B"])

    def test_allow_identity_is_folded_into_key(self):
        _srv.clear_request_allow()
        k_none = _srv._search_cache_key("q", "", 5, False)
        _srv.set_request_allow({"alpha"})
        k_alpha = _srv._search_cache_key("q", "", 5, False)
        self.assertNotEqual(k_none, k_alpha)
        self.assertIsNone(k_none[-1])
        self.assertEqual(k_alpha[-1], ("alpha",))


# ── "Did you mean" must not leak forbidden title-words to restricted users ──


class TestDidYouMeanRespectsAllowlist(_UsersBase):
    """The did_you_mean vocab is built globally from every ZIM's titles, so a
    correction is suppressed for restricted sessions (a suggested word could
    come from a ZIM outside the allowlist). All-access sessions keep it."""

    def setUp(self):
        super().setUp()
        self._orig_files = _srv._zim_files_cache
        self._orig_list = _srv._zim_list_cache
        _srv._zim_files_cache = {}
        _srv._zim_list_cache = []
        self._orig_dym = search._maybe_did_you_mean
        # Force a correction so the guard is the only thing that can hide it.
        search._maybe_did_you_mean = lambda q: "corrected"

    def tearDown(self):
        _srv._zim_files_cache = self._orig_files
        _srv._zim_list_cache = self._orig_list
        search._maybe_did_you_mean = self._orig_dym
        super().tearDown()

    def test_all_access_gets_suggestion(self):
        _srv.clear_request_allow()
        result = _srv.search_all("xyzzy", limit=5)
        self.assertEqual(result.get("did_you_mean"), "corrected")

    def test_restricted_user_gets_no_suggestion(self):
        _srv.set_request_allow({"alpha"})
        result = _srv.search_all("xyzzy", limit=5)
        self.assertNotIn("did_you_mean", result)


# ── Roles: creation, migration, role-aware allowlist sync ──────────────────


class TestRoles(_UsersBase):
    def test_create_default_role_is_user(self):
        users.create_user("Grown", "pw")
        self.assertEqual(users.list_users()[0]["role"], "user")
        self.assertTrue(users.list_users()[0]["all_access"])

    def test_create_admin_is_all_access(self):
        users.create_user("Sec", "pw", role="admin")
        u = users.list_users()[0]
        self.assertEqual(u["role"], "admin")
        self.assertTrue(u["all_access"])
        self.assertTrue(users.is_admin_user("sec"))

    def test_create_limited_forces_role_and_list(self):
        users.create_user("Kid", "pw", allowlist=["a"], role="limited")
        u = users.list_users()[0]
        self.assertEqual(u["role"], "limited")
        self.assertEqual(u["allowlist"], ["a"])

    def test_admin_ignores_allowlist(self):
        users.create_user("Sec", "pw", allowlist=["a"], role="admin")
        self.assertTrue(users.list_users()[0]["all_access"])

    def test_invalid_role_rejected(self):
        ok, err = users.create_user("X", "pw", role="superuser")
        self.assertFalse(ok)
        self.assertIn("role", err)

    def test_role_inferred_when_none(self):
        # Backward-compatible callers pass no role; an allowlist → limited.
        users.create_user("Kid", "pw", allowlist=["a"])
        self.assertEqual(users.list_users()[0]["role"], "limited")

    def test_set_allowlist_syncs_role(self):
        users.create_user("Kid", "pw", role="user")
        users.set_allowlist("Kid", ["a"])
        self.assertEqual(users.list_users()[0]["role"], "limited")
        users.set_allowlist("Kid", None)
        self.assertEqual(users.list_users()[0]["role"], "user")

    def test_set_allowlist_rejected_for_admin(self):
        users.create_user("Sec", "pw", role="admin")
        ok, _ = users.set_allowlist("Sec", ["a"])
        self.assertFalse(ok)

    def test_set_role_promote_and_demote(self):
        users.create_user("Kid", "pw", allowlist=["a"], role="limited")
        users.set_role("Kid", "user")
        self.assertTrue(users.list_users()[0]["all_access"])
        users.set_role("Kid", "admin")
        self.assertTrue(users.is_admin_user("Kid"))
        users.set_role("Kid", "limited", ["b"])
        self.assertEqual(users.list_users()[0]["allowlist"], ["b"])

    def test_set_role_drops_sessions(self):
        users.create_user("Kid", "pw")
        token = users.create_session("Kid")
        users.set_role("Kid", "limited", ["a"])
        self.assertIsNone(users.resolve_session(token))

    def test_migration_legacy_record_without_role(self):
        # A legacy users.json (no role) must migrate: allowlist → limited, else user.
        import json

        legacy = {
            "version": 1,
            "users": {
                "kid": {"name": "Kid", "pw": "x", "allowlist": ["a"]},
                "gro": {"name": "Gro", "pw": "x", "allowlist": None},
            },
        }
        with open(users._users_path(), "w", encoding="utf-8") as f:
            json.dump(legacy, f)
        by_name = {u["name"]: u for u in users.list_users()}
        self.assertEqual(by_name["Kid"]["role"], "limited")
        self.assertEqual(by_name["Gro"]["role"], "user")


# ── Admin hierarchy: primary vs secondary through the real handler ─────────


class TestAdminHierarchy(_UsersBase):
    def setUp(self):
        super().setUp()
        manage._set_manage_password("adminpw")

    def _post(self, handler, data):
        from types import SimpleNamespace

        manage.handle_manage_post(handler, SimpleNamespace(path="/manage/users"), data)
        return handler.last

    def _primary(self):
        return _FakeHandler(_bearer("adminpw"), private=False)

    def _secondary(self):
        users.create_user("Sec", "secpw", role="admin")
        token = users.create_session("Sec")
        return _FakeHandler(_bearer(token, "Sec"), private=False)

    def test_secondary_admin_passes_manage_auth(self):
        h = self._secondary()
        self.assertIsNone(manage._check_manage_auth(h))
        self.assertEqual(manage.admin_kind(h), "secondary")

    def test_primary_admin_kind(self):
        self.assertEqual(manage.admin_kind(self._primary()), "primary")

    def test_role_user_session_still_401_on_manage(self):
        users.create_user("Plain", "pw", role="user")
        token = users.create_session("Plain")
        h = _FakeHandler(_bearer(token, "Plain"), private=False)
        self.assertTrue(manage._check_manage_auth(h))

    def test_role_user_sees_full_library(self):
        users.create_user("Plain", "pw", role="user")
        token = users.create_session("Plain")
        self.assertIsNone(users.request_allow(_FakeHandler(_cookie(token))))

    def test_secondary_can_crud_regular_user(self):
        h = self._secondary()
        code, body = self._post(
            h, {"action": "create", "name": "Kid", "password": "pw", "role": "user"}
        )
        self.assertEqual(code, 200)
        self.assertTrue(any(u["name"] == "Kid" for u in body["users"]))
        code, _ = self._post(h, {"action": "delete", "name": "Kid"})
        self.assertEqual(code, 200)

    def test_secondary_cannot_create_admin(self):
        h = self._secondary()
        code, _ = self._post(
            h, {"action": "create", "name": "Kid2", "password": "pw", "role": "admin"}
        )
        self.assertEqual(code, 403)

    def test_secondary_cannot_touch_other_admin(self):
        # A second admin exists; our secondary must not delete/demote them.
        users.create_user("Other", "pw", role="admin")
        h = self._secondary()
        code, _ = self._post(h, {"action": "delete", "name": "Other"})
        self.assertEqual(code, 403)
        code, _ = self._post(h, {"action": "set-role", "name": "Other", "role": "user"})
        self.assertEqual(code, 403)

    def test_primary_can_manage_admins(self):
        h = self._primary()
        code, _ = self._post(
            h, {"action": "create", "name": "Sec2", "password": "pw", "role": "admin"}
        )
        self.assertEqual(code, 200)
        code, _ = self._post(h, {"action": "delete", "name": "Sec2"})
        self.assertEqual(code, 200)

    def test_nobody_can_modify_primary_row(self):
        # The primary admin is synthetic — no action may target its name.
        for h in (self._primary(), self._secondary()):
            code, _ = self._post(h, {"action": "delete", "name": "admin"})
            self.assertEqual(code, 403)

    def test_primary_row_and_self_kind_in_get(self):
        from types import SimpleNamespace

        h = self._primary()
        manage.handle_manage_get(h, SimpleNamespace(path="/manage/users"), {})
        code, body = h.last
        self.assertEqual(code, 200)
        self.assertEqual(body["primary_admin"]["name"], "admin")
        self.assertEqual(body["self_kind"], "primary")


# ── last_login: stamped on login, echoed additively, never fatal ───────────


class TestLastLogin(_UsersBase):
    def test_new_user_has_zero_last_login(self):
        users.create_user("Kid", "pw123")
        self.assertEqual(users.list_users()[0]["last_login"], 0)

    def test_record_login_stamps_current_time(self):
        users.create_user("Kid", "pw123")
        before = int(time.time())
        users.record_login("kid")  # casefold key resolves
        stamped = users.list_users()[0]["last_login"]
        self.assertGreaterEqual(stamped, before)

    def test_record_login_missing_user_is_noop(self):
        # A deleted-mid-request account must not raise or create a ghost record.
        users.record_login("ghost")
        self.assertEqual(users.list_users(), [])

    def test_last_login_persists_on_record(self):
        users.create_user("Kid", "pw123")
        users.record_login("Kid")
        self.assertIn("last_login", users.get_user("Kid"))

    def test_record_login_updates_on_second_login(self):
        users.create_user("Kid", "pw123")
        users.record_login("Kid")
        first = users.get_user("Kid")["last_login"]
        # Force a distinct later stamp regardless of clock granularity.
        with users._lock:
            u = users._load_users()
            u[users._key("Kid")]["last_login"] = first - 100
            users._save_users(u)
        users.record_login("Kid")
        self.assertGreater(users.get_user("Kid")["last_login"], first - 100)


# ── Admin password-reset (set-password) auth matrix through the endpoint ────


class TestAdminPasswordReset(_UsersBase):
    """The Users pane resets a user's password via POST /manage/users
    action=set-password. Verify the hierarchy holds for that action too."""

    def setUp(self):
        super().setUp()
        manage._set_manage_password("adminpw")

    def _post(self, handler, data):
        from types import SimpleNamespace

        manage.handle_manage_post(handler, SimpleNamespace(path="/manage/users"), data)
        return handler.last

    def _primary(self):
        return _FakeHandler(_bearer("adminpw"), private=False)

    def _secondary(self):
        users.create_user("Sec", "secpw", role="admin")
        token = users.create_session("Sec")
        return _FakeHandler(_bearer(token, "Sec"), private=False)

    def test_primary_resets_regular_user(self):
        users.create_user("Kid", "oldpw", role="user")
        code, _ = self._post(
            self._primary(),
            {"action": "set-password", "name": "Kid", "password": "newpw"},
        )
        self.assertEqual(code, 200)
        self.assertIsNone(users.authenticate("Kid", "oldpw"))
        self.assertIsNotNone(users.authenticate("Kid", "newpw"))

    def test_secondary_resets_regular_user(self):
        users.create_user("Kid", "oldpw", role="user")
        code, _ = self._post(
            self._secondary(),
            {"action": "set-password", "name": "Kid", "password": "newpw"},
        )
        self.assertEqual(code, 200)
        self.assertIsNotNone(users.authenticate("Kid", "newpw"))

    def test_secondary_cannot_reset_admin(self):
        users.create_user("Other", "oldpw", role="admin")
        code, _ = self._post(
            self._secondary(),
            {"action": "set-password", "name": "Other", "password": "x"},
        )
        self.assertEqual(code, 403)
        self.assertIsNotNone(users.authenticate("Other", "oldpw"))  # unchanged

    def test_nobody_resets_primary_via_users(self):
        for h in (self._primary(), self._secondary()):
            code, _ = self._post(
                h, {"action": "set-password", "name": "admin", "password": "x"}
            )
            self.assertEqual(code, 403)

    def test_reset_missing_user_fails(self):
        code, _ = self._post(
            self._primary(),
            {"action": "set-password", "name": "ghost", "password": "x"},
        )
        self.assertEqual(code, 400)

    def test_login_stamps_last_login_field(self):
        # End-to-end: set-password lets the user in, and record_login (called
        # from _handle_login) would stamp last_login. Assert the field surfaces.
        users.create_user("Kid", "pw123", role="user")
        users.record_login("Kid")
        row = next(u for u in users.list_users() if u["name"] == "Kid")
        self.assertGreater(row["last_login"], 0)


if __name__ == "__main__":
    unittest.main()
