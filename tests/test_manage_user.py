"""Optional management username (v1.8).

Covers the full auth matrix for the OPTIONAL username that can sit alongside
the password: configured-via-env, configured-via-file, and the default
not-configured (any value passes) case — plus that a legacy single-line
password file (no username) keeps working unchanged.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as _srv  # noqa: E402
from zimi import manage  # noqa: E402


class _FakeHandler:
    """Minimal stand-in for ZimHandler: just headers + client privacy."""

    def __init__(self, headers=None, private=True):
        self.headers = headers or {}
        self._private = private

    def _is_private_client(self):
        return self._private


def _bearer(pw, user=None):
    h = {"Authorization": "Bearer " + pw}
    if user is not None:
        h["X-Zimi-User"] = user
    return h


class TestManageUsername(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._orig_data_dir = _srv.ZIMI_DATA_DIR
        _srv.ZIMI_DATA_DIR = self._tmp
        # Clean env + caches so each case starts from a known state.
        for var in ("ZIMI_MANAGE_PASSWORD", "ZIMI_MANAGE_USER", "ZIMI_API_TOKEN"):
            os.environ.pop(var, None)
        manage._env_pw_hash_cache = None

    def tearDown(self):
        _srv.ZIMI_DATA_DIR = self._orig_data_dir
        for var in ("ZIMI_MANAGE_PASSWORD", "ZIMI_MANAGE_USER", "ZIMI_API_TOKEN"):
            os.environ.pop(var, None)
        manage._env_pw_hash_cache = None
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)

    # ── Storage round-trip ──

    def test_set_password_stores_username_on_second_line(self):
        manage._set_manage_password("secret", username="Alice")
        with open(manage._password_file(), encoding="utf-8") as f:
            lines = f.read().split("\n")
        self.assertEqual(len(lines), 2)
        self.assertIn("$", lines[0])  # PBKDF2 salt$hash
        self.assertEqual(lines[1], "Alice")
        self.assertEqual(manage._get_manage_user(), "Alice")

    def test_bare_password_change_preserves_username(self):
        manage._set_manage_password("secret", username="Alice")
        manage._set_manage_password("newsecret")  # username=None → preserve
        self.assertEqual(manage._get_manage_user(), "Alice")
        self.assertTrue(
            manage._verify_password("newsecret", manage._get_manage_password_hash())
        )

    def test_empty_username_clears_it(self):
        manage._set_manage_password("secret", username="Alice")
        manage._set_manage_password("secret", username="")
        self.assertEqual(manage._get_manage_user(), "")

    def test_clearing_password_clears_username(self):
        manage._set_manage_password("secret", username="Alice")
        manage._set_manage_password("")
        self.assertEqual(manage._get_manage_user(), "")
        self.assertEqual(manage._get_manage_password_hash(), "")

    def test_env_username_wins_over_file(self):
        manage._set_manage_password("secret", username="Alice")
        os.environ["ZIMI_MANAGE_USER"] = "Bob"
        self.assertEqual(manage._get_manage_user(), "Bob")

    # ── Legacy file (single-line hash, no username) ──

    def test_legacy_single_line_hash_still_authenticates(self):
        # Write ONLY the hash — exactly the pre-v1.8 file shape.
        with open(manage._password_file(), "w", encoding="utf-8") as f:
            f.write(manage._hash_pw("legacypw"))
        self.assertEqual(manage._get_manage_user(), "")
        h = _FakeHandler(_bearer("legacypw"), private=False)
        self.assertIsNone(manage._check_manage_auth(h))

    # ── Auth matrix: username NOT configured (any value passes) ──

    def test_no_username_correct_pw_no_header_passes(self):
        manage._set_manage_password("secret")  # no username
        h = _FakeHandler(_bearer("secret"), private=False)
        self.assertIsNone(manage._check_manage_auth(h))

    def test_no_username_correct_pw_arbitrary_header_passes(self):
        manage._set_manage_password("secret")
        h = _FakeHandler(_bearer("secret", "whatever"), private=False)
        self.assertIsNone(manage._check_manage_auth(h))

    def test_no_username_wrong_pw_fails(self):
        manage._set_manage_password("secret")
        h = _FakeHandler(_bearer("wrong", "whatever"), private=False)
        self.assertTrue(manage._check_manage_auth(h))

    # ── Auth matrix: username configured (must match, case-insensitive) ──

    def test_username_configured_matching_passes(self):
        manage._set_manage_password("secret", username="Alice")
        h = _FakeHandler(_bearer("secret", "Alice"), private=False)
        self.assertIsNone(manage._check_manage_auth(h))

    def test_username_configured_case_insensitive_match_passes(self):
        manage._set_manage_password("secret", username="Alice")
        h = _FakeHandler(_bearer("secret", "aLiCe"), private=False)
        self.assertIsNone(manage._check_manage_auth(h))

    def test_username_configured_wrong_username_fails(self):
        manage._set_manage_password("secret", username="Alice")
        h = _FakeHandler(_bearer("secret", "Bob"), private=False)
        self.assertTrue(manage._check_manage_auth(h))

    def test_username_configured_missing_header_fails(self):
        manage._set_manage_password("secret", username="Alice")
        h = _FakeHandler(_bearer("secret"), private=False)
        self.assertTrue(manage._check_manage_auth(h))

    def test_username_configured_wrong_pw_right_username_fails(self):
        manage._set_manage_password("secret", username="Alice")
        h = _FakeHandler(_bearer("wrong", "Alice"), private=False)
        self.assertTrue(manage._check_manage_auth(h))

    def test_env_username_enforced(self):
        manage._set_manage_password("secret")  # no file username
        os.environ["ZIMI_MANAGE_USER"] = "Carol"
        manage._env_pw_hash_cache = None
        ok = _FakeHandler(_bearer("secret", "carol"), private=False)
        self.assertIsNone(manage._check_manage_auth(ok))
        bad = _FakeHandler(_bearer("secret", "dave"), private=False)
        self.assertTrue(manage._check_manage_auth(bad))

    # ── API token path is exempt from the username gate ──

    def test_api_token_ignores_username(self):
        manage._set_manage_password("secret", username="Alice")
        token = manage._generate_api_token()
        try:
            # No X-Zimi-User at all — API token must still authenticate.
            h = _FakeHandler(_bearer(token), private=False)
            self.assertIsNone(manage._check_manage_auth(h))
        finally:
            manage._revoke_api_token()

    def test_challenge_is_generic_for_wrong_username(self):
        """No username-enumeration signal: wrong username → the same generic
        401 unauthorized body as a wrong password."""
        manage._set_manage_password("secret", username="Alice")
        wrong_user = _FakeHandler(_bearer("secret", "Bob"), private=False)
        wrong_pw = _FakeHandler(_bearer("wrong", "Alice"), private=False)
        self.assertEqual(
            manage._manage_auth_challenge(wrong_user),
            manage._manage_auth_challenge(wrong_pw),
        )


if __name__ == "__main__":
    unittest.main()
