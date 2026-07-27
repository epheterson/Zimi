"""Unauthenticated-surface hardening for the multi-user release.

Three gaps that a restricted account or an anonymous client could otherwise
exploit:
- POST /login ran credential checks (600k PBKDF2 rounds) with no rate limit,
  so one endpoint served both password guessing and CPU exhaustion.
- GET /languages read the raw ZIM cache, so a `limited` user could enumerate
  the whole library by name.
- The Q-ID interlanguage path answers from SQLite without ever opening an
  Archive, so it never hit the fail-closed allowlist check that guards the
  other strategies.
"""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as _srv  # noqa: E402
from zimi import http as _http  # noqa: E402
from zimi import users  # noqa: E402


class TestLoginRateLimit(unittest.TestCase):
    """The login bucket is separate from — and much tighter than — the API one."""

    def setUp(self):
        with _http._rate_lock:
            _http._rate_buckets.clear()
            _http._rate_buckets_login.clear()

    tearDown = setUp

    def _login_attempt(self, ip="203.0.113.9"):
        return _http._check_rate_limit(
            ip,
            limit=_http.RATE_LIMIT_LOGIN,
            buckets=_http._rate_buckets_login,
        )

    def test_login_attempts_are_capped(self):
        for _ in range(_http.RATE_LIMIT_LOGIN):
            self.assertEqual(self._login_attempt(), 0)
        self.assertGreater(self._login_attempt(), 0)

    def test_login_cap_is_tighter_than_the_api_cap(self):
        self.assertLess(_http.RATE_LIMIT_LOGIN, _http.RATE_LIMIT)

    def test_login_bucket_is_independent_of_the_api_bucket(self):
        """Browsing must not spend a client's login budget, or vice versa."""
        for _ in range(_http.RATE_LIMIT_LOGIN):
            self._login_attempt()
        self.assertGreater(self._login_attempt(), 0)
        self.assertEqual(_http._check_rate_limit("203.0.113.9"), 0)

    def test_cap_is_per_ip(self):
        for _ in range(_http.RATE_LIMIT_LOGIN):
            self._login_attempt("203.0.113.9")
        self.assertGreater(self._login_attempt("203.0.113.9"), 0)
        self.assertEqual(self._login_attempt("203.0.113.10"), 0)


class TestLanguagesRespectsAllowlist(unittest.TestCase):
    """GET /languages must show a restricted user only their own ZIMs."""

    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer

        import zimi

        cls._tmp = tempfile.mkdtemp()
        os.environ["ZIM_DIR"] = cls._tmp
        zimi.ZIM_DIR = cls._tmp
        zimi.ZIMI_DATA_DIR = os.path.join(cls._tmp, ".zimi")
        os.makedirs(zimi.ZIMI_DATA_DIR, exist_ok=True)
        cls._srv_http = ThreadingHTTPServer(("127.0.0.1", 0), zimi.ZimHandler)
        threading.Thread(target=cls._srv_http.serve_forever, daemon=True).start()
        cls._base = f"http://127.0.0.1:{cls._srv_http.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls._srv_http.shutdown()
        import shutil

        shutil.rmtree(cls._tmp, ignore_errors=True)

    def setUp(self):
        self._orig_cache = _srv._zim_list_cache
        _srv._zim_list_cache = [
            {"name": "wikipedia_en_simple", "language": "eng"},
            {"name": "wikipedia_fr_all", "language": "fra"},
        ]
        users.create_user("Kid", "pw123", allowlist=["wikipedia_en_simple"])
        self._token = users.create_session("Kid")

    def tearDown(self):
        _srv._zim_list_cache = self._orig_cache
        users.delete_user("Kid")
        _srv.clear_request_allow()

    def _languages(self, token=None):
        req = urllib.request.Request(f"{self._base}/languages")
        if token:
            req.add_header("Authorization", "Bearer " + token)
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())

    def test_restricted_user_sees_only_allowed_zims(self):
        langs = self._languages(self._token)
        names = [n for entry in langs for n in entry["zims"]]
        self.assertEqual(names, ["wikipedia_en_simple"])
        self.assertNotIn("fra", [entry["code"] for entry in langs])

    def test_anonymous_still_sees_everything(self):
        names = [n for entry in self._languages() for n in entry["zims"]]
        self.assertCountEqual(names, ["wikipedia_en_simple", "wikipedia_fr_all"])


if __name__ == "__main__":
    unittest.main()
