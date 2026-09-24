"""A password is kept nowhere: the admin's browser keeps a session token.

Remember me stored the primary admin's password in localStorage in plain
text: the client's manage Bearer WAS the password. /login now returns the
admin session it already minted, the client keeps that, and changing the
password ends the old sessions and hands back a new one.
"""

import json
import os
import sys
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_nonlatin_redirect import TestNonLatinRedirect  # noqa: E402


class TestNoStoredPassword(TestNonLatinRedirect):
    def _req(self, path, data=None, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(
            self._base + path, data=json.dumps(data).encode() if data is not None else None,
            headers=headers, method="POST" if data is not None else "GET",
        )
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, {}

    def test_the_admin_keeps_a_session_not_the_password(self):
        from zimi import manage

        manage._set_manage_password("first-pw")
        try:
            status, body = self._req("/login", {"username": "admin", "password": "first-pw"})
            self.assertEqual((status, body.get("role")), (200, "admin"))
            token = body.get("token")
            self.assertTrue(token)
            self.assertNotEqual(token, "first-pw")
            self.assertEqual(self._req("/manage/status", token=token)[0], 200)

            # Changing the password: the current one is asked for, the old
            # sessions end, and a new one comes back.
            status, body = self._req(
                "/manage/set-password", {"current": "first-pw", "password": "second-pw", "username": "admin"}, token=token
            )
            self.assertEqual(status, 200)
            fresh = body.get("token")
            self.assertTrue(fresh and fresh not in ("second-pw", token))
            self.assertEqual(self._req("/manage/status", token=token)[0], 401)
            self.assertEqual(self._req("/manage/status", token=fresh)[0], 200)
            # a wrong current password changes nothing
            status, _ = self._req("/manage/set-password", {"current": "nope", "password": "x"}, token=fresh)
            self.assertEqual(status, 401)
        finally:
            manage._set_manage_password("")

    test_an_arabic_redirect_names_its_target = None
    test_a_cyrillic_redirect_names_its_target = None
    test_a_section_of_a_non_latin_page_is_a_redirect_too = None
    test_the_target_is_reachable_at_the_address_given = None


if __name__ == "__main__":
    unittest.main()
