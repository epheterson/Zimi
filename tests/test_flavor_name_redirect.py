"""A link to a topic build's old flavor name moves to the shared name.

wikipedia_en_medicine_nopic and _maxi were two names; now both are
wikipedia_en_medicine. Bookmarks, history and shared links carry the old
one, and open through /w/, which redirects them.
"""

import os
import sys
import unittest
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_nonlatin_redirect import TARGET, TestNonLatinRedirect  # noqa: E402


class TestFlavorNameRedirect(TestNonLatinRedirect):
    def _head(self, path):
        class _NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None

        try:
            r = urllib.request.build_opener(_NoRedirect).open(self._base + path)
            return r.status, r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.headers

    def test_an_old_nopic_name_moves_to_the_shared_one(self):
        quoted = urllib.parse.quote(TARGET, safe="/")
        status, headers = self._head(f"/w/nonlatin_nopic/{quoted}")
        self.assertEqual(status, 301)
        self.assertEqual(headers["Location"], f"/w/nonlatin/{quoted}")

    def test_an_unknown_name_is_still_unknown(self):
        status, _ = self._head("/w/nothing_here_nopic/A/X")
        self.assertNotEqual(status, 301)

    test_an_arabic_redirect_names_its_target = None
    test_a_cyrillic_redirect_names_its_target = None
    test_a_section_of_a_non_latin_page_is_a_redirect_too = None
    test_the_target_is_reachable_at_the_address_given = None


if __name__ == "__main__":
    unittest.main()
