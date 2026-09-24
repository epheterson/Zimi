"""An unknown ZIM or article is a 404 on /read and /search, as the API guide
promises ("404 unknown zim/path") and /chunks already answered. They
answered 200 with the error in the body; the body is unchanged."""

import os
import sys
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_nonlatin_redirect import TestNonLatinRedirect  # noqa: E402


class TestNotFoundStatus(TestNonLatinRedirect):
    def _status(self, path):
        try:
            with urllib.request.urlopen(self._base + path) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    def test_unknown_zim_and_article(self):
        self.assertEqual(self._status("/read?zim=nope&path=x"), 404)
        self.assertEqual(self._status("/read?zim=nonlatin&path=A/No_such_page"), 404)
        self.assertEqual(self._status("/search?q=family&zim=nope"), 404)
        self.assertEqual(self._status("/search?q=family&zim=nope"), 404)  # the cached answer too
        self.assertEqual(self._status("/search?q=family&zim=nonlatin"), 200)

    test_an_arabic_redirect_names_its_target = None
    test_a_cyrillic_redirect_names_its_target = None
    test_a_section_of_a_non_latin_page_is_a_redirect_too = None
    test_the_target_is_reachable_at_the_address_given = None


if __name__ == "__main__":
    unittest.main()
