#!/usr/bin/env python3
"""Unit tests for RAG chunking — chunk_article() core logic + /chunks route.

The suite mocks archives (like the preview tests) so no real ZIM is needed:
we hand chunk_article synthetic HTML through a fake archive and assert on the
deterministic IDs, clamp behaviour, paragraph packing + overlap, and offsets.
Route-level 400/404 paths run against a live server with an empty library.
"""

import hashlib
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.search as search  # noqa: E402
import zimi.server as server  # noqa: E402


def _fake_zim(monkeypatch_targets, html, zim_name="testzim", mimetype="text/html"):
    """Point search.chunk_article at a one-article fake archive serving `html`.

    Returns a cleanup callable restoring the patched server functions.
    """
    archive = MagicMock()
    entry = MagicMock()
    entry.title = "Fixture Article"
    item = entry.get_item.return_value
    item.content = bytearray(html.encode("utf-8"))
    item.mimetype = mimetype
    archive.get_entry_by_path.return_value = entry

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

    return cleanup


class TestChunkArticle(unittest.TestCase):
    ZIM = "testzim"
    PATH = "A/Fixture"

    def _chunk(self, html, **kw):
        cleanup = _fake_zim(None, html, zim_name=self.ZIM)
        try:
            return search.chunk_article(self.ZIM, self.PATH, **kw)
        finally:
            cleanup()

    # ── Deterministic IDs ──

    def test_ids_deterministic(self):
        html = "<p>" + " ".join(f"word{i}" for i in range(400)) + "</p>"
        a = self._chunk(html, size=400, overlap=40)
        b = self._chunk(html, size=400, overlap=40)
        self.assertEqual(a["content_rev"], b["content_rev"])
        self.assertEqual([c["id"] for c in a["chunks"]], [c["id"] for c in b["chunks"]])
        self.assertTrue(a["chunks"], "expected multiple chunks")

    def test_changed_text_changes_rev_and_ids(self):
        base = "<p>" + " ".join(f"word{i}" for i in range(400)) + "</p>"
        changed = base.replace("word0", "wordZ", 1)
        a = self._chunk(base, size=400, overlap=40)
        b = self._chunk(changed, size=400, overlap=40)
        self.assertNotEqual(a["content_rev"], b["content_rev"])
        self.assertNotEqual(a["chunks"][0]["id"], b["chunks"][0]["id"])

    def test_id_scheme_matches_spec(self):
        html = "<p>alpha beta gamma delta</p>"
        r = self._chunk(html, size=200, overlap=0)
        # content_rev = sha256(stripped_text)[:12]
        stripped = "alpha beta gamma delta"
        self.assertEqual(
            r["content_rev"], hashlib.sha256(stripped.encode()).hexdigest()[:12]
        )
        seq0 = r["chunks"][0]
        want = hashlib.sha256(
            f"{self.ZIM}|{self.PATH}|{r['content_rev']}|0|200|0".encode()
        ).hexdigest()[:16]
        self.assertEqual(seq0["id"], want)

    # ── Clamps ──

    def test_size_clamped_low(self):
        r = self._chunk("<p>x</p>", size=10)
        self.assertEqual(r["size"], search.CHUNK_SIZE_MIN)

    def test_size_clamped_high(self):
        r = self._chunk("<p>x</p>", size=999999)
        self.assertEqual(r["size"], search.CHUNK_SIZE_MAX)

    def test_overlap_clamped_to_half_size(self):
        r = self._chunk("<p>x</p>", size=400, overlap=999999)
        self.assertEqual(r["overlap"], 200)

    def test_overlap_clamped_negative(self):
        r = self._chunk("<p>x</p>", size=400, overlap=-50)
        self.assertEqual(r["overlap"], 0)

    def test_defaults(self):
        r = self._chunk("<p>hello world</p>")
        self.assertEqual(r["size"], search.CHUNK_SIZE_DEFAULT)
        self.assertEqual(r["overlap"], search.CHUNK_OVERLAP_DEFAULT)

    # ── Packing + overlap ──

    def test_no_chunk_exceeds_size(self):
        # Many short paragraphs that must be packed and split.
        html = "".join(f"<p>{'ab '*30}</p>" for _ in range(10))
        r = self._chunk(html, size=200, overlap=20)
        for c in r["chunks"]:
            self.assertLessEqual(c["end"] - c["start"], 200)

    def test_oversize_paragraph_hard_split_at_words(self):
        # One paragraph far larger than size → multiple chunks, split on spaces.
        html = "<p>" + " ".join(f"token{i}" for i in range(300)) + "</p>"
        r = self._chunk(html, size=250, overlap=0)
        self.assertGreater(r["total_chunks"], 1)
        for c in r["chunks"]:
            self.assertLessEqual(c["end"] - c["start"], 250)
            # word-boundary split → no chunk core starts/ends mid-"token"
            self.assertFalse(c["text"].lstrip().startswith("oken"))

    def test_overlap_prefix_is_prev_tail(self):
        html = "<p>" + " ".join(f"num{i}" for i in range(300)) + "</p>"
        overlap = 30
        r = self._chunk(html, size=250, overlap=overlap)
        self.assertGreater(r["total_chunks"], 1)
        # Reconstruct stripped text to compute expected prefixes.
        stripped = " ".join(f"num{i}" for i in range(300))
        chunks = r["chunks"]
        for i in range(1, len(chunks)):
            prev = chunks[i - 1]
            expected_prefix = stripped[
                max(prev["start"], prev["end"] - overlap) : prev["end"]
            ]
            self.assertTrue(
                chunks[i]["text"].startswith(expected_prefix),
                f"chunk {i} missing overlap prefix",
            )

    def test_first_chunk_has_no_prefix(self):
        html = "<p>" + " ".join(f"w{i}" for i in range(300)) + "</p>"
        r = self._chunk(html, size=250, overlap=30)
        stripped = " ".join(f"w{i}" for i in range(300))
        first = r["chunks"][0]
        self.assertEqual(first["text"], stripped[first["start"] : first["end"]])

    # ── Offsets ──

    def test_offsets_sane(self):
        html = "".join(f"<p>{'lorem ipsum '*20}</p>" for _ in range(8))
        r = self._chunk(html, size=300, overlap=40)
        stripped_len = _stripped_len(r)
        for c in r["chunks"]:
            self.assertGreaterEqual(c["start"], 0)
            self.assertLess(c["start"], c["end"])
            self.assertLessEqual(c["end"], stripped_len)

    def test_seq_is_contiguous(self):
        html = "<p>" + " ".join(f"t{i}" for i in range(500)) + "</p>"
        r = self._chunk(html, size=300, overlap=0)
        self.assertEqual([c["seq"] for c in r["chunks"]], list(range(len(r["chunks"]))))

    # ── Empty / error ──

    def test_empty_article(self):
        r = self._chunk("<html><body></body></html>", size=400)
        self.assertEqual(r["total_chunks"], 0)
        self.assertEqual(r["chunks"], [])

    def test_unknown_zim(self):
        cleanup = _fake_zim(None, "<p>x</p>", zim_name="realzim")
        try:
            r = search.chunk_article("ghost", self.PATH)
        finally:
            cleanup()
        self.assertEqual(r.get("error"), "not_found")

    def test_unknown_path(self):
        cleanup = _fake_zim(None, "<p>x</p>", zim_name=self.ZIM)
        # Make the archive raise KeyError for any path.
        server.get_archive = lambda n=None: _raising_archive()
        try:
            r = search.chunk_article(self.ZIM, "A/Missing")
        finally:
            cleanup()
        self.assertEqual(r.get("error"), "not_found")


def _raising_archive():
    a = MagicMock()
    a.get_entry_by_path.side_effect = KeyError("nope")
    return a


def _stripped_len(result):
    """Largest end offset is <= len(stripped_text); recompute from chunks."""
    if not result["chunks"]:
        return 0
    return max(c["end"] for c in result["chunks"])


class TestChunksRoute(unittest.TestCase):
    """Route-level 400/404 against a live empty-library server."""

    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer
        import zimi

        cls._tmp = tempfile.mkdtemp()
        os.environ["ZIM_DIR"] = cls._tmp
        zimi.ZIM_DIR = cls._tmp
        zimi.ZIMI_DATA_DIR = os.path.join(cls._tmp, ".zimi")
        os.makedirs(zimi.ZIMI_DATA_DIR, exist_ok=True)
        zimi.load_cache()
        cls._srv = ThreadingHTTPServer(("127.0.0.1", 0), zimi.ZimHandler)
        cls._port = cls._srv.server_address[1]
        threading.Thread(target=cls._srv.serve_forever, daemon=True).start()
        cls._base = f"http://127.0.0.1:{cls._port}"

    @classmethod
    def tearDownClass(cls):
        cls._srv.shutdown()
        import shutil

        shutil.rmtree(cls._tmp, ignore_errors=True)

    def _status(self, path):
        try:
            with urllib.request.urlopen(f"{self._base}{path}", timeout=10) as resp:
                return json.loads(resp.read()), resp.status
        except urllib.error.HTTPError as e:
            return json.loads(e.read()), e.code

    def test_missing_params(self):
        _, status = self._status("/chunks")
        self.assertEqual(status, 400)

    def test_missing_path(self):
        _, status = self._status("/chunks?zim=wikipedia")
        self.assertEqual(status, 400)

    def test_unknown_zim_404(self):
        _, status = self._status("/chunks?zim=ghost&path=A/None")
        self.assertEqual(status, 404)

    def test_generic_error_string(self):
        data, _ = self._status("/chunks")
        # Never leak internals — error is a short generic string.
        self.assertIn("error", data)
        self.assertNotIn("Traceback", json.dumps(data))


if __name__ == "__main__":
    unittest.main()
