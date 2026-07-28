"""Anonymous-access policy (1.8.1): open / limited / private.

The public-access policy decides what an ANONYMOUS (not logged-in) visitor may
see. It reuses the multi-user allowlist machinery — anonymous simply gets an
allow-set instead of the all-access sentinel — so every existing choke point
(get_zim_files / list_zims / zim_allowed / search-cache key) filters it with no
new leak surface. This suite pins:

- storage: default open, round-trip, env override, fail-closed on corruption
- request_allow per mode × identity (anonymous / admin / logged-in user)
- the private-mode request gate (login surface reachable, reads 401)
- leak checks under `limited`: the same choke points filter anonymous, and the
  /languages- and almanac-style bypass paths (zim_allowed) stay filtered too
- admin endpoints: GET/POST /manage/public-access are admin-only and round-trip
"""

import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as _srv  # noqa: E402
from zimi import manage, users  # noqa: E402
from zimi.http import SESSION_COOKIE_MAX_AGE, ZimHandler  # noqa: E402


class _FakeHandler:
    """Minimal ZimHandler stand-in: headers + client privacy + _json capture."""

    def __init__(self, headers=None, private=True):
        self.headers = headers or {}
        self._private = private
        self.responses = []

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


def _gate(handler, path):
    """Invoke the real private-mode gate against a fake handler."""
    return ZimHandler._private_access_block(handler, SimpleNamespace(path=path))


class _AccessBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._orig_data_dir = _srv.ZIMI_DATA_DIR
        _srv.ZIMI_DATA_DIR = self._tmp
        for var in (
            "ZIMI_MANAGE_PASSWORD",
            "ZIMI_MANAGE_USER",
            "ZIMI_API_TOKEN",
            "ZIMI_PUBLIC_ACCESS",
        ):
            os.environ.pop(var, None)
        manage._env_pw_hash_cache = None
        _srv.clear_request_allow()

    def tearDown(self):
        _srv.ZIMI_DATA_DIR = self._orig_data_dir
        for var in (
            "ZIMI_MANAGE_PASSWORD",
            "ZIMI_MANAGE_USER",
            "ZIMI_API_TOKEN",
            "ZIMI_PUBLIC_ACCESS",
        ):
            os.environ.pop(var, None)
        manage._env_pw_hash_cache = None
        _srv.clear_request_allow()
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)


# ── Storage: default, round-trip, env override, fail-closed ────────────────


class TestPolicyStorage(_AccessBase):
    def test_default_is_open_when_no_file(self):
        # Legacy install: no access.json → open (whole library to anonymous).
        mode, allow = users.get_public_access()
        self.assertEqual(mode, "open")
        self.assertEqual(allow, [])

    def test_set_and_get_limited_round_trip(self):
        ok, err = users.set_public_access("limited", ["a", "b", "b"])  # de-dup
        self.assertTrue(ok, err)
        mode, allow = users.get_public_access()
        self.assertEqual(mode, "limited")
        self.assertEqual(sorted(allow), ["a", "b"])

    def test_open_and_private_ignore_allowlist(self):
        users.set_public_access("private", ["a", "b"])
        _, allow = users.get_public_access()
        self.assertEqual(allow, [])  # not stored for non-limited modes

    def test_invalid_mode_rejected(self):
        ok, err = users.set_public_access("wideopen")
        self.assertFalse(ok)
        self.assertIn("mode", err)

    def test_env_override_wins_over_file(self):
        users.set_public_access("open")
        os.environ["ZIMI_PUBLIC_ACCESS"] = "private"
        mode, _ = users.get_public_access()
        self.assertEqual(mode, "private")

    def test_env_override_ignored_when_invalid(self):
        users.set_public_access("limited", ["a"])
        os.environ["ZIMI_PUBLIC_ACCESS"] = "bogus"
        mode, allow = users.get_public_access()
        self.assertEqual(mode, "limited")
        self.assertEqual(allow, ["a"])

    def test_corrupt_file_fails_closed_to_private(self):
        # A present-but-unreadable policy must NOT silently fall open.
        with open(users._access_path(), "w", encoding="utf-8") as f:
            f.write("{not valid json")
        mode, _ = users.get_public_access()
        self.assertEqual(mode, "private")

    def test_corrupt_file_with_env_open_respects_env(self):
        # The admin's env escape hatch still works over a corrupt file.
        with open(users._access_path(), "w", encoding="utf-8") as f:
            f.write("garbage")
        os.environ["ZIMI_PUBLIC_ACCESS"] = "open"
        mode, _ = users.get_public_access()
        self.assertEqual(mode, "open")

    def test_unknown_mode_in_file_fails_closed(self):
        with open(users._access_path(), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "mode": "sideways"}, f)
        mode, _ = users.get_public_access()
        self.assertEqual(mode, "private")

    def test_status_surfaces_env_control(self):
        users.set_public_access("limited", ["a"])
        os.environ["ZIMI_PUBLIC_ACCESS"] = "private"
        st = users.public_access_status()
        self.assertEqual(st["mode"], "private")  # effective
        self.assertEqual(st["stored_mode"], "limited")  # what was saved
        self.assertTrue(st["env_controlled"])
        self.assertEqual(st["env_mode"], "private")


# ── request_allow across mode × identity ───────────────────────────────────


class TestRequestAllowByMode(_AccessBase):
    def test_open_anonymous_all_access(self):
        users.set_public_access("open")
        self.assertIsNone(users.request_allow(_FakeHandler(private=False)))

    def test_limited_anonymous_gets_public_allowlist(self):
        users.set_public_access("limited", ["a", "b"])
        # A non-private anonymous client (e.g. WAN visitor) is restricted.
        allow = users.request_allow(_FakeHandler(private=False))
        self.assertEqual(allow, {"a", "b"})

    def test_private_anonymous_gets_empty_set(self):
        users.set_public_access("private")
        allow = users.request_allow(_FakeHandler(private=False))
        self.assertEqual(allow, set())  # defence in depth; gate 401s first

    def test_admin_all_access_in_limited(self):
        manage._set_manage_password("adminpw")
        users.set_public_access("limited", ["a"])
        h = _FakeHandler(_bearer("adminpw"), private=False)
        self.assertIsNone(users.request_allow(h))

    def test_admin_all_access_in_private(self):
        manage._set_manage_password("adminpw")
        users.set_public_access("private")
        h = _FakeHandler(_bearer("adminpw"), private=False)
        self.assertIsNone(users.request_allow(h))

    def test_logged_in_limited_user_unaffected_by_open_policy(self):
        users.set_public_access("open")
        users.create_user("Kid", "pw", allowlist=["x"], role="limited")
        token = users.create_session("Kid")
        allow = users.request_allow(_FakeHandler(_cookie(token)))
        self.assertEqual(allow, {"x"})

    def test_logged_in_user_own_allowlist_not_public_one(self):
        # A logged-in user keeps THEIR allowlist even under limited public mode.
        users.set_public_access("limited", ["public_only"])
        users.create_user("Kid", "pw", allowlist=["kid_only"], role="limited")
        token = users.create_session("Kid")
        allow = users.request_allow(_FakeHandler(_cookie(token)))
        self.assertEqual(allow, {"kid_only"})

    def test_all_access_user_stays_all_access_under_limited(self):
        users.set_public_access("limited", ["a"])
        users.create_user("Grown", "pw", role="user")
        token = users.create_session("Grown")
        self.assertIsNone(users.request_allow(_FakeHandler(_bearer(token))))


# ── Private-mode request gate ──────────────────────────────────────────────


class TestPrivateGate(_AccessBase):
    def setUp(self):
        super().setUp()
        users.set_public_access("private")

    def test_login_surface_paths_pass(self):
        for p in (
            "/",
            "/whoami",
            "/health",
            "/login",
            "/logout",
            "/favicon.png",
            "/static/app.js",
            "/static/i18n/en.json",
            "/manage/has-password",
        ):
            h = _FakeHandler(private=False)
            self.assertFalse(_gate(h, p), p)
            self.assertEqual(h.responses, [], p)

    def test_read_endpoints_blocked_for_anonymous(self):
        for p in ("/search", "/list", "/read", "/suggest", "/w/wiki/Foo", "/random"):
            h = _FakeHandler(private=False)
            self.assertTrue(_gate(h, p), p)
            code, body = h.last
            self.assertEqual(code, 401, p)
            self.assertTrue(body.get("login_required"), p)

    def test_admin_bypasses_gate(self):
        manage._set_manage_password("adminpw")
        h = _FakeHandler(_bearer("adminpw"), private=False)
        self.assertFalse(_gate(h, "/search"))
        self.assertEqual(h.responses, [])

    def test_logged_in_user_bypasses_gate(self):
        users.create_user("Kid", "pw", allowlist=["a"], role="limited")
        token = users.create_session("Kid")
        h = _FakeHandler(_cookie(token), private=False)
        self.assertFalse(_gate(h, "/search"))
        self.assertEqual(h.responses, [])

    def test_open_mode_never_gates(self):
        users.set_public_access("open")
        h = _FakeHandler(private=False)
        self.assertFalse(_gate(h, "/search"))

    def test_limited_mode_never_gates(self):
        # limited filters via the allow-set, it does NOT 401 — reads still work.
        users.set_public_access("limited", ["a"])
        h = _FakeHandler(private=False)
        self.assertFalse(_gate(h, "/search"))


# ── Leak checks under `limited`: anonymous is filtered by every choke point ─


class TestLimitedLeakChecks(_AccessBase):
    def setUp(self):
        super().setUp()
        _srv._zim_files_cache = {"a": "/z/a.zim", "b": "/z/b.zim", "c": "/z/c.zim"}
        _srv._zim_list_cache = [
            {"name": "a", "entries": 500, "language": "en", "title": "Alpha"},
            {"name": "b", "entries": 500, "language": "en", "title": "Beta"},
            {"name": "c", "entries": 500, "language": "fr", "title": "Gamma"},
        ]
        users.set_public_access("limited", ["a"])
        # Simulate the do_GET preamble: the request-allow context is set from the
        # anonymous policy for a non-private (WAN) visitor.
        self._allow = users.request_allow(_FakeHandler(private=False))
        _srv.set_request_allow(self._allow)

    def tearDown(self):
        _srv._zim_files_cache = None
        _srv._zim_list_cache = None
        super().tearDown()

    def test_allow_set_is_public_allowlist(self):
        self.assertEqual(self._allow, {"a"})

    def test_get_zim_files_filtered(self):
        self.assertEqual(set(_srv.get_zim_files()), {"a"})

    def test_list_zims_filtered(self):
        self.assertEqual({z["name"] for z in _srv.list_zims()}, {"a"})

    def test_zim_allowed_bypass_paths_filtered(self):
        # /languages, /article-languages and almanac-links go through zim_allowed
        # rather than get_zim_files — assert they see the same filtered view.
        self.assertTrue(_srv.zim_allowed("a"))
        self.assertFalse(_srv.zim_allowed("b"))
        self.assertFalse(_srv.zim_allowed("c"))

    def test_get_archive_fails_closed_for_forbidden(self):
        _srv._archive_pool["b"] = object()
        try:
            self.assertIsNone(_srv.get_archive("b"))
        finally:
            _srv._archive_pool.pop("b", None)

    def test_shared_cache_not_mutated(self):
        _srv.get_zim_files()
        _srv.clear_request_allow()
        self.assertEqual(set(_srv.get_zim_files()), {"a", "b", "c"})


# ── Admin endpoints for the policy ─────────────────────────────────────────


class TestPublicAccessEndpoints(_AccessBase):
    def setUp(self):
        super().setUp()
        manage._set_manage_password("adminpw")
        _srv._zim_files_cache = {"a": "/z/a.zim", "b": "/z/b.zim"}
        _srv._zim_list_cache = [
            {"name": "a", "language": "en", "title": "Alpha", "article_count": 10},
            {"name": "b", "language": "fr", "title": "Beta", "article_count": 20},
        ]

    def tearDown(self):
        _srv._zim_files_cache = None
        _srv._zim_list_cache = None
        super().tearDown()

    def _admin(self):
        return _FakeHandler(_bearer("adminpw"), private=False)

    def _post(self, data, path="/manage/public-access"):
        h = self._admin()
        manage.handle_manage_post(h, SimpleNamespace(path=path), data)
        return h.last

    def _get(self, path="/manage/public-access"):
        h = self._admin()
        manage.handle_manage_get(h, SimpleNamespace(path=path), {})
        return h.last

    def test_get_returns_status_and_picker_options(self):
        code, body = self._get()
        self.assertEqual(code, 200)
        self.assertEqual(body["public_access"]["mode"], "open")
        opts = {o["name"]: o for o in body["zim_options"]}
        self.assertEqual(opts["a"]["title"], "Alpha")
        self.assertEqual(opts["a"]["language"], "en")
        self.assertEqual(opts["a"]["article_count"], 10)

    def test_post_sets_limited_and_persists(self):
        code, body = self._post({"mode": "limited", "allowlist": ["a"]})
        self.assertEqual(code, 200)
        self.assertEqual(body["public_access"]["mode"], "limited")
        self.assertEqual(body["public_access"]["allowlist"], ["a"])
        # Persisted to disk.
        self.assertEqual(users.get_public_access()[0], "limited")

    def test_post_invalid_mode_rejected(self):
        code, _ = self._post({"mode": "everything"})
        self.assertEqual(code, 400)

    def test_users_get_includes_policy_and_options(self):
        users.set_public_access("limited", ["b"])
        code, body = self._get("/manage/users")
        self.assertEqual(code, 200)
        self.assertEqual(body["public_access"]["mode"], "limited")
        self.assertIn("zim_options", body)

    def test_endpoints_reject_non_admin_user(self):
        users.create_user("Kid", "pw", allowlist=["a"], role="limited")
        token = users.create_session("Kid")
        h = _FakeHandler(_bearer(token, "Kid"), private=False)
        manage.handle_manage_post(
            h, SimpleNamespace(path="/manage/public-access"), {"mode": "open"}
        )
        code, _ = h.last
        self.assertEqual(code, 401)
        # The policy never changed.
        self.assertEqual(users.get_public_access()[0], "open")

    def test_get_rejects_non_admin_user(self):
        users.create_user("Kid", "pw", allowlist=["a"], role="limited")
        token = users.create_session("Kid")
        h = _FakeHandler(_bearer(token, "Kid"), private=False)
        manage.handle_manage_get(h, SimpleNamespace(path="/manage/public-access"), {})
        code, _ = h.last
        self.assertEqual(code, 401)


# ── Session-cookie attributes (login persistence over plain http) ──────────


class TestSessionCookieAttributes(_AccessBase):
    """The ``zimi_session`` cookie carries ``Secure`` ONLY behind an HTTPS proxy.

    A LAN instance is plain http, and a browser silently DROPS a ``Secure``
    cookie set over http:// — so gating Secure on the forwarded proto is what
    lets a login stick on the LAN. ``HttpOnly`` + ``SameSite=Lax`` are always
    present; ``Max-Age`` appears only when 'remember' is set (else it is a
    session cookie the browser clears on close).
    """

    def _cookie(self, remember, proto=None):
        headers = {}
        if proto is not None:
            headers["X-Forwarded-Proto"] = proto
        h = _FakeHandler(headers, private=False)
        return ZimHandler._session_cookie(h, "TOK", remember)

    def test_plain_http_omits_secure(self):
        parts = self._cookie(remember=True).split("; ")
        self.assertNotIn("Secure", parts)
        self.assertIn("HttpOnly", parts)
        self.assertIn("SameSite=Lax", parts)
        self.assertEqual(parts[0], "zimi_session=TOK")

    def test_https_proxy_sets_secure(self):
        parts = self._cookie(remember=True, proto="https").split("; ")
        self.assertIn("Secure", parts)

    def test_https_proto_case_insensitive(self):
        self.assertIn("Secure", self._cookie(remember=True, proto="HTTPS").split("; "))

    def test_http_forwarded_proto_no_secure(self):
        # An explicit ``http`` forwarded proto (proxy that terminates TLS
        # elsewhere but forwards http to us) must NOT set Secure.
        self.assertNotIn(
            "Secure", self._cookie(remember=True, proto="http").split("; ")
        )

    def test_remember_sets_max_age(self):
        self.assertIn(
            "Max-Age=" + str(SESSION_COOKIE_MAX_AGE), self._cookie(remember=True)
        )

    def test_no_remember_is_session_cookie(self):
        self.assertNotIn("Max-Age", self._cookie(remember=False))

    def test_expire_cookie_clears_with_max_age_zero(self):
        c = ZimHandler._expire_cookie(_FakeHandler())
        self.assertIn("zimi_session=;", c)
        self.assertIn("Max-Age=0", c)


# ── whoami recognises a token-authed admin (client boot-gate contract) ──────


class TestWhoamiAdminToken(_AccessBase):
    """The admin's credential is a Bearer token, not the session cookie the
    named-user path rides on. In private mode the boot gate sends that token on
    /whoami; the server MUST answer role=admin (never anonymous+login_required),
    or a just-signed-in admin gets bounced back to the login screen on reload.
    """

    def setUp(self):
        super().setUp()
        self._orig_manage = _srv.ZIMI_MANAGE
        _srv.ZIMI_MANAGE = True
        manage._set_manage_password("adminpw")
        users.set_public_access("private")

    def tearDown(self):
        _srv.ZIMI_MANAGE = self._orig_manage
        super().tearDown()

    def test_admin_bearer_token_resolves_to_admin(self):
        h = _FakeHandler(_bearer("adminpw"), private=False)
        ZimHandler._handle_whoami(h)
        code, body = h.last
        self.assertEqual(code, 200)
        self.assertEqual(body.get("role"), "admin")
        self.assertNotIn("login_required", body)

    def test_anonymous_gets_login_required(self):
        h = _FakeHandler({}, private=False)
        ZimHandler._handle_whoami(h)
        code, body = h.last
        self.assertEqual(code, 200)
        self.assertEqual(body.get("role"), "anonymous")
        self.assertTrue(body.get("login_required"))


if __name__ == "__main__":
    unittest.main()
