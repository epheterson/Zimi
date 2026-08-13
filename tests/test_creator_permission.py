"""The per-user CREATE permission (``can_create``): a named account that may
make ZIMs from the web without being any kind of admin.

Three contracts under test:
- users.py: the flag round-trips, admins are implicitly true, revoking removes
  the key, and users.json stays at schema version 1 (a roster written by this
  code loads under the PRIOR loader's semantics — the additive-key rule).
- manage.py: the route matrix. Anonymous → 401; a signed-in user WITHOUT the
  flag → 403; a creator → 200 on the URL-mode create/status/probe/cancel
  surfaces but 403 on folder/import/browse (server-path reads stay with the
  primary admin); admins are unchanged.
- http.py: /whoami exposes ``can_create`` so the client can shape its UI.
"""

import json
import os
import sys
import tempfile
import unittest
from urllib.parse import urlparse

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


def _bearer(token):
    return {"Authorization": "Bearer " + token}


class _Base(unittest.TestCase):
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


# ── The flag itself ─────────────────────────────────────────────────────────


class TestCanCreateFlag(_Base):
    def test_default_is_false(self):
        users.create_user("Kid", "pw123")
        self.assertFalse(users.user_can_create("Kid"))
        self.assertFalse(users.list_users()[0]["can_create"])

    def test_grant_revoke_round_trip(self):
        users.create_user("Maker", "pw123")
        ok, err = users.set_can_create("Maker", True)
        self.assertTrue(ok, err)
        self.assertTrue(users.user_can_create("Maker"))
        self.assertTrue(users.list_users()[0]["can_create"])
        ok, err = users.set_can_create("Maker", False)
        self.assertTrue(ok, err)
        self.assertFalse(users.user_can_create("Maker"))

    def test_admins_are_implicitly_true(self):
        users.create_user("Boss", "pw123", role="admin")
        self.assertTrue(users.user_can_create("Boss"))
        self.assertTrue(users.list_users()[0]["can_create"])

    def test_setting_the_flag_on_an_admin_is_refused(self):
        users.create_user("Boss", "pw123", role="admin")
        ok, err = users.set_can_create("Boss", True)
        self.assertFalse(ok)
        self.assertIn("admin", err or "")

    def test_unknown_user_is_an_error(self):
        ok, err = users.set_can_create("Ghost", True)
        self.assertFalse(ok)
        self.assertEqual(err, "user not found")

    def test_unknown_name_never_creates(self):
        self.assertFalse(users.user_can_create("Ghost"))

    def test_flag_survives_a_role_change_to_limited(self):
        # The flag is orthogonal to the read-scope role: a limited account can
        # be a creator (capture the web, read only its shelf).
        users.create_user("Maker", "pw123")
        users.set_can_create("Maker", True)
        users.set_role("Maker", "limited", ["wiki_a"])
        self.assertTrue(users.user_can_create("Maker"))


# ── Schema compatibility: version stays 1, the key is additive ──────────────


def _load_users_prior_semantics(path):
    """The PRIOR (1.8) ``_load_users`` contract, restated: a dict with
    ``version == 1`` and a dict of users, or {} on any mismatch. Unknown keys
    inside a record were never inspected, so they are tolerated by omission."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or data.get("version") != 1:
        return {}
    loaded = data.get("users", {})
    return loaded if isinstance(loaded, dict) else {}


class TestSchemaCompat(_Base):
    def _raw(self):
        with open(os.path.join(self._tmp, "users.json"), encoding="utf-8") as f:
            return json.load(f)

    def test_version_stays_1_with_the_flag_present(self):
        users.create_user("Maker", "pw123")
        users.set_can_create("Maker", True)
        raw = self._raw()
        self.assertEqual(raw["version"], 1)
        self.assertIs(raw["users"]["maker"]["can_create"], True)

    def test_roster_loads_under_the_prior_loader(self):
        users.create_user("Maker", "pw123")
        users.create_user("Kid", "pw456")
        users.set_can_create("Maker", True)
        loaded = _load_users_prior_semantics(os.path.join(self._tmp, "users.json"))
        self.assertEqual(set(loaded), {"maker", "kid"})
        # The prior reader sees every field it knew about, untouched.
        self.assertEqual(loaded["maker"]["name"], "Maker")
        self.assertEqual(loaded["maker"]["role"], "user")
        self.assertTrue(loaded["maker"]["pw"])

    def test_revoke_removes_the_key_entirely(self):
        # Never-granted and granted-then-revoked records are byte-identical:
        # revoking POPS the key rather than writing false.
        users.create_user("Maker", "pw123")
        users.set_can_create("Maker", True)
        users.set_can_create("Maker", False)
        self.assertNotIn("can_create", self._raw()["users"]["maker"])

    def test_ungranted_roster_carries_no_new_key(self):
        users.create_user("Kid", "pw123")
        self.assertNotIn("can_create", self._raw()["users"]["kid"])


# ── Route matrix ────────────────────────────────────────────────────────────


class _RouteBase(_Base):
    """Password-protected instance with one of each identity."""

    def setUp(self):
        super().setUp()
        manage._set_manage_password("adminpw")
        users.create_user("Kid", "pw123")
        users.create_user("Maker", "pw456")
        users.set_can_create("Maker", True)
        users.create_user("Boss", "pw789", role="admin")
        self.anon = {}
        self.plain = _bearer(users.create_session("Kid"))
        self.creator = _bearer(users.create_session("Maker"))
        self.secondary = _bearer(users.create_session("Boss"))
        self.primary = _bearer("adminpw")
        # The engines never run: every reachable endpoint is replaced with a
        # sentinel so the matrix is purely about who gets through the gate.
        self._orig = {}
        for fn in ("_create_start", "_create_probe", "_create_cancel"):
            self._orig[fn] = getattr(manage, fn)
        manage._create_start = lambda data: ({"sentinel": "start"}, 200)
        manage._create_probe = lambda data: ({"sentinel": "probe"}, 200)
        manage._create_cancel = lambda job_id=None: ({"sentinel": "cancel"}, 200)
        self._orig["_create_browse"] = manage._create_browse
        manage._create_browse = lambda path: ({"sentinel": "browse"}, 200)

    def tearDown(self):
        for fn, orig in self._orig.items():
            setattr(manage, fn, orig)
        super().tearDown()

    def _post(self, path, data, headers):
        h = _FakeHandler(headers, private=True)
        manage.handle_manage_post(h, urlparse(path), data)
        assert h.last is not None, path
        return h.last

    def _get(self, path, headers, params=None):
        h = _FakeHandler(headers, private=True)
        manage.handle_manage_get(h, urlparse(path), params or {})
        assert h.last is not None, path
        return h.last


URL_BODY = {"mode": "page", "source": "https://example.org/"}
FOLDER_BODY = {"mode": "folder", "source": "/etc"}
IMPORT_BODY = {"mode": "import", "source": "/etc/passwd"}


class TestRouteMatrix(_RouteBase):
    def test_anonymous_is_401_everywhere(self):
        for status, body in (
            self._post("/manage/create", dict(URL_BODY), self.anon),
            self._post("/manage/create/probe", dict(URL_BODY), self.anon),
            self._post("/manage/create/cancel", {}, self.anon),
            self._get("/manage/create/status", self.anon),
            self._get("/manage/create/browse", self.anon),
        ):
            self.assertEqual(status, 401)
            self.assertTrue(body["needs_password"])

    def test_plain_user_is_403_everywhere(self):
        for status, body in (
            self._post("/manage/create", dict(URL_BODY), self.plain),
            self._post("/manage/create/probe", dict(URL_BODY), self.plain),
            self._post("/manage/create/cancel", {}, self.plain),
            self._get("/manage/create/status", self.plain),
            self._get("/manage/create/browse", self.plain),
        ):
            self.assertEqual(status, 403)
            # Authenticated-but-unauthorized: no password prompt signal.
            self.assertNotIn("needs_password", body)

    def test_creator_gets_the_url_mode_surfaces(self):
        status, body = self._post("/manage/create", dict(URL_BODY), self.creator)
        self.assertEqual((status, body["sentinel"]), (200, "start"))
        status, body = self._post("/manage/create/probe", dict(URL_BODY), self.creator)
        self.assertEqual((status, body["sentinel"]), (200, "probe"))
        status, body = self._post("/manage/create/cancel", {}, self.creator)
        self.assertEqual((status, body["sentinel"]), (200, "cancel"))
        status, body = self._get("/manage/create/status", self.creator)
        self.assertEqual(status, 200)
        self.assertIn("active", body)

    def test_creator_never_touches_the_server_disk(self):
        for status, body in (
            self._post("/manage/create", dict(FOLDER_BODY), self.creator),
            self._post("/manage/create", dict(IMPORT_BODY), self.creator),
            self._post("/manage/create/probe", dict(FOLDER_BODY), self.creator),
            self._post("/manage/create/probe", dict(IMPORT_BODY), self.creator),
            self._get("/manage/create/browse", self.creator),
        ):
            self.assertEqual(status, 403)
            self.assertIn("primary admin", body["error"])

    def test_revoking_the_flag_closes_the_door(self):
        users.set_can_create("Maker", False)
        status, _ = self._post("/manage/create", dict(URL_BODY), self.creator)
        self.assertEqual(status, 403)

    def test_primary_admin_is_unchanged(self):
        status, body = self._post("/manage/create", dict(FOLDER_BODY), self.primary)
        self.assertEqual((status, body["sentinel"]), (200, "start"))
        status, body = self._get("/manage/create/browse", self.primary)
        self.assertEqual((status, body["sentinel"]), (200, "browse"))
        status, _ = self._get("/manage/create/status", self.primary)
        self.assertEqual(status, 200)

    def test_secondary_admin_keeps_url_modes_only(self):
        status, body = self._post("/manage/create", dict(URL_BODY), self.secondary)
        self.assertEqual((status, body["sentinel"]), (200, "start"))
        status, body = self._post("/manage/create", dict(FOLDER_BODY), self.secondary)
        self.assertEqual(status, 403)
        self.assertIn("primary admin", body["error"])
        status, _ = self._get("/manage/create/browse", self.secondary)
        self.assertEqual(status, 403)


# ── Granting through /manage/users ──────────────────────────────────────────


class TestUsersPostAction(_RouteBase):
    def test_primary_admin_grants_and_revokes(self):
        status, body = self._post(
            "/manage/users",
            {"action": "set-can-create", "name": "Kid", "can_create": True},
            self.primary,
        )
        self.assertEqual(status, 200)
        kid = next(u for u in body["users"] if u["name"] == "Kid")
        self.assertTrue(kid["can_create"])
        self.assertTrue(users.user_can_create("Kid"))
        status, body = self._post(
            "/manage/users",
            {"action": "set-can-create", "name": "Kid", "can_create": False},
            self.primary,
        )
        self.assertEqual(status, 200)
        self.assertFalse(users.user_can_create("Kid"))

    def test_secondary_admin_may_grant_to_regular_users(self):
        status, _ = self._post(
            "/manage/users",
            {"action": "set-can-create", "name": "Kid", "can_create": True},
            self.secondary,
        )
        self.assertEqual(status, 200)
        self.assertTrue(users.user_can_create("Kid"))

    def test_secondary_admin_cannot_touch_an_admin(self):
        status, _ = self._post(
            "/manage/users",
            {"action": "set-can-create", "name": "Boss", "can_create": True},
            self.secondary,
        )
        self.assertEqual(status, 403)

    def test_granting_to_an_admin_role_is_a_400(self):
        status, _ = self._post(
            "/manage/users",
            {"action": "set-can-create", "name": "Boss", "can_create": True},
            self.primary,
        )
        self.assertEqual(status, 400)

    def test_user_session_cannot_grant(self):
        status, _ = self._post(
            "/manage/users",
            {"action": "set-can-create", "name": "Kid", "can_create": True},
            self.creator,
        )
        self.assertEqual(status, 401)


# ── /whoami exposure ────────────────────────────────────────────────────────


class TestWhoami(_Base):
    def _whoami(self, headers):
        from zimi import http as _http

        h = _FakeHandler(headers, private=True)
        _http.ZimHandler._handle_whoami(h)  # type: ignore[arg-type]
        assert h.last is not None
        return h.last

    def test_creator_sees_can_create_true(self):
        users.create_user("Maker", "pw123")
        users.set_can_create("Maker", True)
        status, body = self._whoami(_bearer(users.create_session("Maker")))
        self.assertEqual(status, 200)
        self.assertEqual(body["role"], "user")
        self.assertTrue(body["can_create"])

    def test_plain_user_sees_can_create_false(self):
        users.create_user("Kid", "pw123")
        status, body = self._whoami(_bearer(users.create_session("Kid")))
        self.assertEqual(status, 200)
        self.assertFalse(body["can_create"])


if __name__ == "__main__":
    unittest.main()
