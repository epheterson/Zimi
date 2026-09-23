"""Turning apps off holds across a refresh (#88).

The shell carries the apps the server offers, and its ETag carries them too,
but a revalidation was checked against the plain shell's ETag: a browser
holding the every-app shell was told "304 Not Modified" after the apps were
turned off, and a refresh brought them all back.
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


class TestAppsSettingSticks(TestNonLatinRedirect):
    def _get(self, path, headers=None):
        req = urllib.request.Request(self._base + path, headers=headers or {})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, r.headers, r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            return e.code, e.headers, ""

    def _set_apps(self, shown):
        req = urllib.request.Request(
            self._base + "/manage/apps", data=json.dumps({"shown": shown}).encode(),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req) as r:
            return json.load(r)

    def test_a_refresh_after_turning_apps_off_gets_the_new_shell(self):
        from zimi import server as srv
        from zimi import manage

        saved = manage._read_app_update_prefs().get("apps")
        try:
            self._set_apps(list(srv.APP_NAMES))
            status, headers, body = self._get("/")
            every_app = headers["ETag"]
            self.assertNotIn("data-zimi-apps", body)
            self._set_apps([])
            status, headers, body = self._get("/", {"If-None-Match": every_app})
            self.assertEqual(status, 200)
            self.assertIn('data-zimi-apps="0"', body)
            # and the new shell is itself revalidated as unchanged
            status, _, _ = self._get("/", {"If-None-Match": headers["ETag"]})
            self.assertEqual(status, 304)
        finally:
            self._set_apps(list(srv.APP_NAMES) if saved is None or saved is True else saved)

    test_an_arabic_redirect_names_its_target = None
    test_a_cyrillic_redirect_names_its_target = None
    test_a_section_of_a_non_latin_page_is_a_redirect_too = None
    test_the_target_is_reachable_at_the_address_given = None


if __name__ == "__main__":
    unittest.main()
