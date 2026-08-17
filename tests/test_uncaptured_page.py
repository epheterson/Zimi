#!/usr/bin/env python3
"""A missing page in a mirrored-URL ZIM is answered in words, not in JSON.

A ZIM written by warc2zim holds a WEBSITE: every entry path is the address it
was fetched from. Following a link inside one to a page the capture never
reached used to produce `{"error": "Entry 'www.apple.com/mac/' not found in
apple-alive"}` — a server fault by its tone, naming a path nobody recognises
as the URL it is. These tests pin the replacement: the same miss, in a ZIM
whose paths are URLs, is a page that says what happened, shows the address,
and offers the live web as an explicit choice.

The three things that must stay true, and each one is a test below: an ARTICLE
ZIM is untouched (its missing entry is still a 404 and still JSON), a
SUBRESOURCE never gets prose (an HTML body handed to `<script src>` is a syntax
error), and the address in the page is escaped (an entry path is attacker-
influenced text — it came off the web).
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

import zimi.server as server  # noqa: E402
import zimi.http as zhttp  # noqa: E402


class _FakeItem:
    def __init__(self, data, mimetype):
        self._data = data
        self.mimetype = mimetype
        self.size = len(data)

    @property
    def content(self):
        return memoryview(self._data)


class _FakeEntry:
    def __init__(self, item, title="Fake"):
        self._item = item
        self.title = title
        self.is_redirect = False

    def get_item(self):
        return self._item


class _FakeArchive:
    """A ZIM that answers the two questions the detection asks.

    ``tags`` is what the Tags metadata says (None = the ZIM has none, which is
    most ZIMs), and ``entries`` is everything it holds — including, for a
    warc2zim capture, the replay shell that identifies one structurally."""

    def __init__(self, entries, tags=None):
        self._entries = entries
        self._tags = tags

    def get_entry_by_path(self, path):
        if path in self._entries:
            return self._entries[path]
        raise KeyError(path)

    def has_entry_by_path(self, path):
        return path in self._entries

    def get_metadata(self, name):
        if name == "Tags" and self._tags is not None:
            return self._tags.encode()
        raise RuntimeError(f"no {name} in this fake archive")


PAGE = _FakeEntry(_FakeItem(b"<html><body>captured</body></html>", "text/html"))

# Zimi's own alive engine, known by the tag it writes.
ALIVE_ZIM = "apple-alive"
ALIVE_ENTRIES = {"www.apple.com/": PAGE}
# Somebody else's zimit ZIM: no Zimi tag, known by the replay shell it embeds.
ZIMIT_ZIM = "example-zimit"
ZIMIT_ENTRIES = {
    "example.com/": PAGE,
    zhttp._REPLAY_SHELL_ENTRY: _FakeEntry(_FakeItem(b"// wombat", "text/javascript")),
}
# An ordinary article ZIM, which must not change at all.
ARTICLE_ZIM = "survival"
ARTICLE_ENTRIES = {"A/Water": PAGE}

_ARCHIVES = {
    ALIVE_ZIM: _FakeArchive(ALIVE_ENTRIES, tags="zimi:alive;_ftindex:yes"),
    ZIMIT_ZIM: _FakeArchive(ZIMIT_ENTRIES),
    ARTICLE_ZIM: _FakeArchive(ARTICLE_ENTRIES, tags="_category:other"),
}

# What a browser sends when it navigates an iframe, and what Zimi's own service
# worker sends when it forwards that same navigation — Chrome stamps the
# forwarded request `Sec-Fetch-Dest: empty`, which is why Accept is consulted.
AS_IFRAME = {"Sec-Fetch-Dest": "iframe", "Accept": "text/html,*/*;q=0.8"}
AS_FORWARDED = {"Sec-Fetch-Dest": "empty", "Accept": "text/html,*/*;q=0.8"}
AS_SCRIPT = {"Sec-Fetch-Dest": "script", "Accept": "*/*"}
AS_XHR = {"Sec-Fetch-Dest": "empty", "Accept": "*/*"}


def _start_server(zim_dir):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    os.environ["ZIM_DIR"] = zim_dir
    server.ZIM_DIR = zim_dir
    server.ZIMI_DATA_DIR = os.path.join(zim_dir, ".zimi")
    os.makedirs(server.ZIMI_DATA_DIR, exist_ok=True)
    server.load_cache()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


class TestUncapturedPage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="zimi-uncaptured-")
        cls._server, port = _start_server(cls._tmpdir)
        cls._base = f"http://127.0.0.1:{port}"
        cls._saved = {
            name: getattr(server, name)
            for name in ("get_zim_files", "get_archive", "open_archive")
        }
        server.get_zim_files = lambda: {n: f"/fake/{n}.zim" for n in _ARCHIVES}
        server.get_archive = lambda n=None: _ARCHIVES.get(n)
        server.open_archive = lambda p=None: None

    @classmethod
    def tearDownClass(cls):
        for name, orig in cls._saved.items():
            setattr(server, name, orig)
        cls._server.shutdown()
        import shutil

        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    def setUp(self):
        # The detection is cached per library generation; these tests swap the
        # archives under a single generation, so each starts from no answer.
        with zhttp._mirrors_urls_lock:
            zhttp._mirrors_urls_cache.clear()

    def _get(self, path, headers=None):
        req = urllib.request.Request(f"{self._base}{path}")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.headers, resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read().decode("utf-8")

    # ── the page ───────────────────────────────────────────────────────────

    def test_a_missing_page_is_explained_and_names_its_url(self):
        status, headers, body = self._get(
            f"/w/{ALIVE_ZIM}/www.apple.com/mac/", AS_IFRAME
        )
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers.get("Content-Type", ""))
        # The address, reconstructed from the entry path, said out loud.
        self.assertIn("https://www.apple.com/mac/", body)
        # And offered as a link OUT, which is the only way to leave.
        self.assertIn('href="https://www.apple.com/mac/"', body)
        self.assertIn("wasn't captured", body)
        # No JSON error survives anywhere in it.
        self.assertNotIn('{"error"', body)

    def test_a_zimit_zim_is_recognised_without_zimis_tag(self):
        """The property belongs to the FILE. A zimit ZIM downloaded from Kiwix
        was never near this machine's capture engine and behaves the same."""
        status, _headers, body = self._get(
            f"/w/{ZIMIT_ZIM}/example.com/pricing", AS_IFRAME
        )
        self.assertEqual(status, 200)
        self.assertIn("https://example.com/pricing", body)

    def test_the_service_workers_forwarded_navigation_is_still_a_navigation(self):
        """The regression that cost an afternoon: behind Zimi's service worker
        the iframe's navigation arrives with Sec-Fetch-Dest: empty."""
        status, _headers, body = self._get(
            f"/w/{ALIVE_ZIM}/www.apple.com/mac/", AS_FORWARDED
        )
        self.assertEqual(status, 200)
        self.assertIn("https://www.apple.com/mac/", body)

    def test_the_reader_gets_its_own_language_and_theme_keys(self):
        """The page translates itself in the browser off the reader's stored
        preference — so the keys it reads have to be the reader's keys."""
        _status, _headers, body = self._get(
            f"/w/{ALIVE_ZIM}/www.apple.com/mac/", AS_IFRAME
        )
        self.assertIn("zimi_ui_lang", body)
        self.assertIn("zimi_app_theme", body)
        self.assertIn("uncaptured_title", body)  # the i18n key, for the swap

    def test_an_entry_path_cannot_write_markup_into_the_page(self):
        """An entry path came off the web. It is shown, so it is escaped."""
        status, _headers, body = self._get(
            f"/w/{ALIVE_ZIM}/evil.example/%22%3E%3Cscript%3Ealert(1)%3C/script%3E",
            AS_IFRAME,
        )
        self.assertEqual(status, 200)
        self.assertNotIn("<script>alert(1)</script>", body)
        self.assertIn("&lt;script&gt;", body)

    # ── everything this must NOT change ────────────────────────────────────

    def test_an_article_zim_still_answers_a_miss_with_json(self):
        status, headers, body = self._get(f"/w/{ARTICLE_ZIM}/A/Nope", AS_IFRAME)
        self.assertEqual(status, 404)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        self.assertEqual(
            json.loads(body)["error"], f"Entry 'A/Nope' not found in {ARTICLE_ZIM}"
        )

    def test_a_missing_subresource_still_answers_with_json(self):
        for label, headers_in in (("script", AS_SCRIPT), ("xhr", AS_XHR)):
            with self.subTest(label):
                status, headers, body = self._get(
                    f"/w/{ALIVE_ZIM}/www.apple.com/app.js", headers_in
                )
                self.assertEqual(status, 404)
                self.assertIn("application/json", headers.get("Content-Type", ""))
                self.assertIn("not found", json.loads(body)["error"])

    def test_a_page_that_was_captured_is_served_as_itself(self):
        status, headers, body = self._get(f"/w/{ALIVE_ZIM}/www.apple.com/", AS_IFRAME)
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers.get("Content-Type", ""))
        self.assertIn("captured", body)
        self.assertNotIn("uncaptured_title", body)

    def test_the_served_english_is_the_english_every_locale_translates(self):
        """The page is rendered server-side and re-translated in the browser
        off the same keys. Two copies of one sentence drift, so this pins them
        together: what the server sends IS what en.json says."""
        i18n = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "zimi",
            "static",
            "i18n",
            "en.json",
        )
        with open(i18n, encoding="utf-8") as fh:
            strings = json.load(fh)
        for key, text in zhttp._UNCAPTURED_STRINGS.items():
            self.assertEqual(strings.get(key), text, key)

    def test_a_missing_zim_gets_prose_for_documents_and_json_for_assets(self):
        """A deleted source's old bookmarks and history entries land here;
        raw JSON on a phone screen reads as a server fault (it did, on
        2026-08-15). A page being OPENED gets the gone-source page; a script
        or image fetching keeps the JSON it can parse."""
        status, _headers, body = self._get("/w/nosuchzim/anything", AS_IFRAME)
        self.assertEqual(status, 200)
        self.assertIn("This source isn't in the library", body)
        status, _headers, body = self._get(
            "/w/nosuchzim/anything.png", {"Sec-Fetch-Dest": "image"}
        )
        self.assertEqual(status, 404)
        self.assertIn("not found", json.loads(body)["error"])


if __name__ == "__main__":
    unittest.main()
