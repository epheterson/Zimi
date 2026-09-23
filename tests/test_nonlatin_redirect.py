"""A redirect whose target is not a Latin title (issue #86).

Arabic Wikipedia's العائلة_اللغوية is a redirect to أسرة لغات. Zimi answered
it with a Location header built from the raw entry path, and an HTTP header
is Latin-1: writing it raised inside the stdlib, the response went out with
no Location, and the reader was told the server had failed. The same link
opened in Kiwix, which percent-encodes it.

Run: pytest tests/test_nonlatin_redirect.py -v
"""

import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from conftest_zim import _Article  # noqa: E402

# The two titles from the report, and a Cyrillic one: this is about the
# alphabet, not about Arabic.
TARGET = "A/أسرة_لغات"
SOURCE = "A/العائلة_اللغوية"
CYRILLIC_TARGET = "A/Языковая_семья"
CYRILLIC_SOURCE = "A/Семья_языков"


def _build(path):
    from libzim.writer import Creator

    with Creator(path).config_indexing(True, "ara") as c:
        c.set_mainpath(TARGET)
        c.add_item(_Article(TARGET, "أسرة لغات", b"<html><body><h1>family</h1></body></html>"))
        c.add_item(_Article(CYRILLIC_TARGET, "Языковая семья", b"<html><body><h1>family</h1></body></html>"))
        c.add_redirection(SOURCE, "العائلة اللغوية", TARGET, {})
        c.add_redirection(CYRILLIC_SOURCE, "Семья языков", CYRILLIC_TARGET, {})
        c.add_metadata("Title", "Non-Latin fixture")
        c.add_metadata("Language", "ara")
        c.add_metadata("Description", "redirects whose targets are not Latin")
    return path


class TestNonLatinRedirect(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer

        import zimi

        cls._tmp = tempfile.mkdtemp(prefix="zimi-nonlatin-")
        _build(os.path.join(cls._tmp, "nonlatin.zim"))
        os.environ["ZIM_DIR"] = cls._tmp
        zimi.ZIM_DIR = cls._tmp
        zimi.ZIMI_DATA_DIR = os.path.join(cls._tmp, ".zimi")
        os.makedirs(zimi.ZIMI_DATA_DIR, exist_ok=True)
        zimi.load_cache()
        cls._srv = ThreadingHTTPServer(("127.0.0.1", 0), zimi.ZimHandler)
        threading.Thread(target=cls._srv.serve_forever, daemon=True).start()
        cls._base = "http://127.0.0.1:%d" % cls._srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls._srv.shutdown()
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def _no_redirect_get(self, path):
        class _NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None

        opener = urllib.request.build_opener(_NoRedirect)
        try:
            resp = opener.open(self._base + path)
            return resp.status, resp.headers
        except urllib.error.HTTPError as e:
            return e.code, e.headers

    def _redirect_to(self, source, target):
        status, headers = self._no_redirect_get(
            "/w/nonlatin/" + urllib.parse.quote(source, safe="/")
        )
        self.assertEqual(status, 302)
        location = headers.get("Location")
        self.assertIsNotNone(location, "a redirect with no Location is the bug")
        # Latin-1 is what a header is written in: the point of the encoding.
        location.encode("latin-1")
        self.assertEqual(
            urllib.parse.unquote(location), "/w/nonlatin/" + target
        )
        return location

    def test_an_arabic_redirect_names_its_target(self):
        self._redirect_to(SOURCE, TARGET)

    def test_a_cyrillic_redirect_names_its_target(self):
        self._redirect_to(CYRILLIC_SOURCE, CYRILLIC_TARGET)

    def test_a_section_of_a_non_latin_page_is_a_redirect_too(self):
        # A title-index suggestion can name a section ("page#section"); the
        # entry is the page, and the section rides along as the fragment.
        section = "قسم"
        status, headers = self._no_redirect_get(
            "/w/nonlatin/" + urllib.parse.quote(TARGET + "#" + section, safe="/")
        )
        self.assertEqual(status, 302)
        location = headers.get("Location")
        location.encode("latin-1")
        self.assertEqual(
            urllib.parse.unquote(location), "/w/nonlatin/%s#%s" % (TARGET, section)
        )

    def test_the_target_is_reachable_at_the_address_given(self):
        location = self._redirect_to(SOURCE, TARGET)
        with urllib.request.urlopen(self._base + location) as resp:
            self.assertEqual(resp.status, 200)
            self.assertIn(b"family", resp.read())


if __name__ == "__main__":
    unittest.main()


class TestNonLatinAttachment(unittest.TestCase):
    """The same fault as the redirect, in the two places a file is offered
    by name: an EPUB inside a ZIM, and a ZIM served to a peer at /dl/.

    A name that is not Latin-1 cannot go in the header as written; RFC 6266
    carries it in filename* with an ASCII fallback beside it.
    """

    def _header(self, name):
        import zimi.http as http

        value = http.ZimHandler._attachment(name)
        # What the stdlib does when it writes the header. This is the test.
        ("Content-Disposition: %s\r\n" % value).encode("latin-1")
        return value

    def test_an_ascii_name_is_left_alone(self):
        self.assertEqual(self._header("book.epub"), 'attachment; filename="book.epub"')

    def test_an_arabic_name_is_carried_in_filename_star(self):
        value = self._header("كتاب.epub")
        self.assertIn("filename*=UTF-8''", value)
        self.assertIn(urllib.parse.quote("كتاب.epub", safe=""), value)

    def test_a_cyrillic_name_is_carried_in_filename_star(self):
        value = self._header("Языковая семья.zim")
        self.assertIn(urllib.parse.quote("Языковая семья.zim", safe=""), value)

    def test_a_quote_in_a_name_cannot_break_out_of_the_header(self):
        value = self._header('a"quote.zim')
        self.assertNotIn('"a"quote', value)
        self.assertTrue(value.startswith('attachment; filename="a_quote.zim"'))
