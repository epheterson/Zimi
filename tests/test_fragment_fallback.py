#!/usr/bin/env python3
"""Fragment-fallback for single-page docs (GitHub #38).

Single-page devdocs ZIMs (e.g. devdocs_en_markdown) surface suggestion/title
paths like ``index#backslash`` where the real ZIM entry is ``index`` and
``#backslash`` is an in-page fragment. Zimi must:

  1. Split the fragment off the path (``split_entry_fragment``).
  2. On a failed entry lookup, retry with the base entry — serving its content
     for API JSON routes (/read, /chunks) and 302-redirecting the /w/ HTML route
     to ``/w/<zim>/index#backslash`` so the browser scrolls to the section.

The full-page 404 in the bug report was ``{"error": "Entry 'index#backslash'
not found in devdocs_en_markdown"}`` from a URL of ``.../index%23backslash``.
"""

import os
import sys
import tempfile
import threading
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.search as search  # noqa: E402
import zimi.server as server  # noqa: E402

from conftest_zim import build_fixture_zim  # noqa: E402


# ---------------------------------------------------------------------------
# Unit: split_entry_fragment
# ---------------------------------------------------------------------------
class TestSplitEntryFragment(unittest.TestCase):
    def test_no_fragment(self):
        self.assertEqual(server.split_entry_fragment("index"), ("index", ""))

    def test_single_page_anchor(self):
        self.assertEqual(
            server.split_entry_fragment("index#backslash"), ("index", "backslash")
        )

    def test_nested_path_with_anchor(self):
        self.assertEqual(
            server.split_entry_fragment("api/misc/index#autolink"),
            ("api/misc/index", "autolink"),
        )

    def test_splits_on_first_hash_only(self):
        self.assertEqual(server.split_entry_fragment("index#a#b"), ("index", "a#b"))


# ---------------------------------------------------------------------------
# Fake-archive helper (mirrors tests/test_chunks.py)
# ---------------------------------------------------------------------------
def _fake_single_page_zim(zim_name="devdocs_en_markdown"):
    """Fake archive whose only real entry is ``index``; ``index#anchor`` KeyErrors.

    Returns (cleanup, archive).
    """
    archive = MagicMock()
    entry = MagicMock()
    entry.title = "Markdown"
    item = entry.get_item.return_value
    item.content = bytearray(
        b"<html><body><h1>Markdown</h1>"
        b"<p>Backslash escapes turn special characters into literals.</p>"
        b"</body></html>"
    )
    item.mimetype = "text/html"

    def _lookup(path):
        if path == "index":
            return entry
        raise KeyError(path)

    archive.get_entry_by_path.side_effect = _lookup

    saved = {}
    for name, fn in {
        "get_zim_files": lambda: {zim_name: "/fake/path.zim"},
        "get_archive": lambda n=None: archive,
        "open_archive": lambda p=None: archive,
    }.items():
        saved[name] = getattr(server, name)
        setattr(server, name, fn)

    def cleanup():
        for name, orig in saved.items():
            setattr(server, name, orig)

    return cleanup, archive


class TestReadArticleFragmentFallback(unittest.TestCase):
    ZIM = "devdocs_en_markdown"

    def test_fragment_path_serves_base_entry(self):
        cleanup, _ = _fake_single_page_zim(self.ZIM)
        try:
            result = search.read_article(self.ZIM, "index#backslash")
        finally:
            cleanup()
        self.assertNotIn("error", result)
        self.assertEqual(result["title"], "Markdown")
        self.assertIn("Backslash escapes", result["content"])

    def test_missing_path_without_fragment_still_errors(self):
        cleanup, _ = _fake_single_page_zim(self.ZIM)
        try:
            result = search.read_article(self.ZIM, "does-not-exist")
        finally:
            cleanup()
        self.assertIn("error", result)

    def test_chunks_fragment_path_chunks_base_entry(self):
        cleanup, _ = _fake_single_page_zim(self.ZIM)
        try:
            result = search.chunk_article(self.ZIM, "index#backslash")
        finally:
            cleanup()
        self.assertNotEqual(result.get("error"), "not_found")
        self.assertTrue(result.get("chunks"))


# ---------------------------------------------------------------------------
# Integration: /w/ HTML route redirects to base entry + raw fragment
# ---------------------------------------------------------------------------
def _start_server(zim_dir, port=0):
    import zimi
    from http.server import ThreadingHTTPServer

    os.environ["ZIM_DIR"] = zim_dir
    zimi.ZIM_DIR = zim_dir
    zimi.ZIMI_DATA_DIR = os.path.join(zim_dir, ".zimi")
    os.makedirs(zimi.ZIMI_DATA_DIR, exist_ok=True)
    zimi.load_cache()

    srv = ThreadingHTTPServer(("127.0.0.1", port), zimi.ZimHandler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    return srv, srv.server_address[1]


class TestServeFragmentRedirect(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="zimi-frag-")
        build_fixture_zim(os.path.join(cls._tmpdir, "survival.zim"))
        cls._server, cls._port = _start_server(cls._tmpdir)
        cls._base = f"http://127.0.0.1:{cls._port}"

    @classmethod
    def tearDownClass(cls):
        cls._server.shutdown()
        import shutil

        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    def _no_redirect_get(self, path):
        import urllib.request

        class _NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None

        opener = urllib.request.build_opener(_NoRedirect)
        try:
            resp = opener.open(self._base + path)
            return resp.status, resp.headers
        except urllib.error.HTTPError as e:
            return e.code, e.headers

    def test_fragment_path_redirects_to_base_with_raw_fragment(self):
        import urllib.error  # noqa: F401 (used in _no_redirect_get)

        # /w/survival/A/Water%23section — entry 'A/Water' exists, '#section' is a
        # fragment. Expect 302 → /w/survival/A/Water#section (raw '#').
        status, headers = self._no_redirect_get("/w/survival/A/Water%23section")
        self.assertEqual(status, 302)
        location = headers.get("Location", "")
        self.assertTrue(location.endswith("#section"), location)
        self.assertIn("/w/survival/A/Water", location)
        self.assertNotIn("%23", location)


if __name__ == "__main__":
    unittest.main()
