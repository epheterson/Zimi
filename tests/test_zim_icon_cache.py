#!/usr/bin/env python3
"""A ZIM's name is not a version, so its icon may not be cached as one.

``/w/<name>/-/icon`` used to answer with ``ETag: "icon-<name>"`` and
``Cache-Control: public, max-age=604800, immutable``. Both halves say the same
false thing: that the bytes behind this URL can never change. They change all
the time —

  * a ZIM is replaced by a newer build under the same filename (the whole
    premise of the auto-updater),
  * a capture is re-run and writes the same name again, which is exactly what
    somebody does while getting a capture right,
  * a ZIM that had no illustration gains one.

`immutable` instructs the browser not to revalidate at all, so whichever answer
it happened to get first — the previous build's icon, or a 404 from before the
file existed — was the answer it kept for a week. And only in that browser.
Eric made a ZIM and its icon was missing in the window he made it from and
present in a private one. That is a cache report, not an icon report.

What is pinned here: the tag identifies the CONTENT, the response is
revalidated rather than assumed, a 304 is still available so this stays cheap
on a page full of source tiles, and a miss is never remembered.
"""

import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402

ZIM = "iconic"
ICON_A = b"\x89PNG\r\n\x1a\n" + b"first build's illustration"
ICON_B = b"\x89PNG\r\n\x1a\n" + b"a DIFFERENT illustration, same filename"


class _FakeArchive:
    """An archive whose illustration can be swapped, or removed entirely —
    which is the point: the same ZIM name, different content behind it."""

    def __init__(self):
        self.icon = ICON_A

    def get_metadata(self, name):
        if name == "Illustration_48x48@1" and self.icon is not None:
            return self.icon
        raise RuntimeError(f"no {name} in this archive")

    def get_entry_by_path(self, path):
        raise KeyError(path)


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


class TestZimIconCache(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="zimi-icon-")
        cls._server, port = _start_server(cls._tmpdir)
        cls._base = f"http://127.0.0.1:{port}"
        cls.archive = _FakeArchive()
        cls._saved = {
            name: getattr(server, name)
            for name in ("get_zim_files", "get_archive", "open_archive")
        }
        server.get_zim_files = lambda: {ZIM: "/fake/iconic.zim"}
        server.get_archive = lambda n=None: cls.archive
        server.open_archive = lambda p=None: cls.archive

    @classmethod
    def tearDownClass(cls):
        for name, orig in cls._saved.items():
            setattr(server, name, orig)
        cls._server.shutdown()
        import shutil

        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    def setUp(self):
        type(self).archive.icon = ICON_A

    def _get(self, headers=None):
        req = urllib.request.Request(f"{self._base}/w/{ZIM}/-/icon")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    # ── the tag names the content ──────────────────────────────────────────

    def test_the_icon_is_served(self):
        status, headers, body = self._get()
        self.assertEqual(status, 200)
        self.assertEqual(body, ICON_A)
        self.assertEqual(headers.get("Content-Type"), "image/png")

    def test_replacing_the_zim_changes_the_tag(self):
        """The regression, stated plainly: same URL, same ZIM name, different
        bytes — and the validator has to be able to tell."""
        _s, first, _b = self._get()
        type(self).archive.icon = ICON_B
        _s, second, body = self._get()
        self.assertEqual(body, ICON_B)
        self.assertNotEqual(
            first.get("ETag"),
            second.get("ETag"),
            "a name-based ETag cannot tell two builds apart, so the browser "
            "never learns the icon changed",
        )

    def test_the_tag_does_not_carry_the_zims_name(self):
        """A tag built from the name is the bug in miniature — it is stable
        across exactly the change it needs to detect."""
        _s, headers, _b = self._get()
        self.assertNotIn(ZIM, headers.get("ETag", ""))

    def test_the_same_icon_keeps_its_tag(self):
        """And it must be stable when nothing changed, or every page load
        re-downloads every icon."""
        _s, one, _b = self._get()
        _s, two, _b = self._get()
        self.assertEqual(one.get("ETag"), two.get("ETag"))

    # ── revalidated, not assumed ───────────────────────────────────────────

    def test_the_browser_is_told_to_ask(self):
        """`immutable` means "never ask again", which is only true of content
        that cannot change. This can."""
        _s, headers, _b = self._get()
        cc = headers.get("Cache-Control", "")
        self.assertNotIn("immutable", cc)
        self.assertIn("must-revalidate", cc)
        self.assertIn("max-age=0", cc)

    def test_an_unchanged_icon_costs_an_empty_reply(self):
        """Correct and cheap: the ask is answered 304 with no body, so a home
        page full of source tiles pays a handful of empty replies."""
        _s, headers, _b = self._get()
        etag = headers.get("ETag")
        status, headers304, body = self._get({"If-None-Match": etag})
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")
        self.assertEqual(headers304.get("ETag"), etag)

    def test_a_stale_validator_gets_the_new_icon(self):
        """The end-to-end shape of Eric's bug, and the proof it is closed: a
        browser holding the previous build's copy asks with the tag it has and
        is handed the new bytes rather than told it is still current."""
        _s, headers, _b = self._get()
        old_etag = headers.get("ETag")
        type(self).archive.icon = ICON_B
        status, _h, body = self._get({"If-None-Match": old_etag})
        self.assertEqual(status, 200)
        self.assertEqual(body, ICON_B)

    # ── a miss is never remembered ─────────────────────────────────────────

    def test_a_missing_icon_is_not_cached(self):
        """A ZIM gains an illustration when it is rebuilt or re-captured. The
        browser that asked a moment too early must not keep the "no" — that is
        the same week-long wrong answer from the other direction."""
        type(self).archive.icon = None
        status, headers, _b = self._get()
        self.assertEqual(status, 404)
        self.assertEqual(headers.get("Cache-Control"), "no-store")

    def test_a_zim_that_gains_an_icon_shows_it(self):
        type(self).archive.icon = None
        self.assertEqual(self._get()[0], 404)
        type(self).archive.icon = ICON_A
        status, _h, body = self._get()
        self.assertEqual(status, 200)
        self.assertEqual(body, ICON_A)


if __name__ == "__main__":
    unittest.main()
