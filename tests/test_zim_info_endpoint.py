#!/usr/bin/env python3
"""GET /zim-info — what a ZIM says about itself, to whoever may see the ZIM.

The endpoint answers two questions from one path: everything one ZIM knows
about itself (?zim=), and the compact provenance facts the library cards turn
into type badges (?kinds=1). Both read METADATA — nothing here is derived from
a filename or a title.

What this pins:

- shape: a Zimi-created ZIM returns its openZIM fields plus its parsed
  X-Zimi-History records, and the counts/blocked objects survive the trip;
- honesty: a ZIM published by somebody else returns ITS fields, an empty
  history and no kind — no invented rows, no borrowed provenance;
- gating parity with /list: the endpoint is readable by anyone who may read
  /list (anonymous included), and a ZIM filtered out of /list for a restricted
  reader is a 404 here, not a metadata leak;
- derivation: the alive tag, the converter and the Scraper suffix decide the
  kind, and a ZIM from the unrelated "zimit" scraper is not mistaken for one of
  Zimi's;
- memoization: the provenance walk reads each file's archive once.

Built on real libzim ZIMs written by the test itself, served by a real
ThreadingHTTPServer on an ephemeral port, so the gate under test is the one
that actually runs.
"""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402
from zimi import http as zhttp  # noqa: E402
from zimi import users as _users  # noqa: E402
from zimi import zimwriter  # noqa: E402
from zimi.http import ZimHandler  # noqa: E402

CREATED_HISTORY = [
    {
        "ts": 1786747674,
        "zimi": "1.9.0",
        "op": "created",
        "mode": "site",
        "detail": "captured 148 pages from https://handbook.example.org",
        "counts": {"pages": 148, "assets": 902, "bytes": 48213774},
        "blocked": {
            "requests": 214,
            "domains": 37,
            "list": "stevenblack-hosts",
            "snapshot": "2026-07-01",
        },
    },
    {
        "ts": 1786800000,
        "zimi": "1.9.0",
        "op": "edited",
        "mode": "site",
        "detail": "removed 4 pages",
    },
]

# Metadata written onto the fixture archives. `made` is a Zimi capture, `found`
# is shaped like a ZIM somebody else published and Zimi merely downloaded.
MADE_META = {
    "Title": "Field Handbook",
    "Description": "148 pages captured from handbook.example.org by Zimi",
    "LongDescription": "The public field handbook, captured so it reads offline.",
    "Creator": "Zimi",
    "Publisher": "Zimi",
    "Source": "https://handbook.example.org/",
    "X-Zimi-Source": "https://handbook.example.org/",
    "Scraper": "Zimi 1.9.0",
    "Tags": "_category:other;_ftindex:yes",
    zimwriter.HISTORY_METADATA_KEY: json.dumps(CREATED_HISTORY),
}
FOUND_META = {
    "Title": "Lit Docs",
    "Description": "Lit documentation, by DevDocs",
    "Creator": "DevDocs",
    "Publisher": "openZIM",
    "Scraper": "devdocs2zim v0.2.1",
    "Tags": "devdocs;lit",
}


def _build(path, metadata):
    """Write a small real ZIM carrying `metadata`."""
    from libzim.writer import Blob, ContentProvider, Creator, Hint, Item

    class _P(ContentProvider):
        def __init__(self, content):
            super().__init__()
            self.content = content
            self._fed = False

        def get_size(self):
            return len(self.content)

        def feed(self):
            if self._fed:
                return Blob(b"")
            self._fed = True
            return Blob(self.content)

    class _A(Item):
        def get_path(self):
            return "index.html"

        def get_title(self):
            return "Index"

        def get_mimetype(self):
            return "text/html"

        def get_contentprovider(self):
            return _P(b"<html><body><h1>Index</h1></body></html>")

        def get_hints(self):
            return {Hint.FRONT_ARTICLE: True}

    base = {"Language": "eng", "Date": "2026-08-05", "Name": os.path.basename(path)}
    with Creator(path).config_indexing(True, "eng") as creator:
        creator.set_mainpath("index.html")
        for key, value in {**base, **metadata}.items():
            creator.add_metadata(key, value)
        creator.add_item(_A())
    return path


class ZimInfoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="zimi-zim-info-")
        _build(os.path.join(cls._tmp, "made.zim"), MADE_META)
        _build(os.path.join(cls._tmp, "found.zim"), FOUND_META)
        cls._saved_dir = server.ZIM_DIR
        cls._saved_data = server.ZIMI_DATA_DIR
        os.environ["ZIM_DIR"] = cls._tmp
        server.ZIM_DIR = cls._tmp
        server.ZIMI_DATA_DIR = os.path.join(cls._tmp, ".zimi")
        os.makedirs(server.ZIMI_DATA_DIR, exist_ok=True)
        server.load_cache()
        cls._server = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        threading.Thread(target=cls._server.serve_forever, daemon=True).start()
        cls._base = f"http://127.0.0.1:{cls._server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls._server.shutdown()
        cls._server.server_close()
        server.ZIM_DIR = cls._saved_dir
        server.ZIMI_DATA_DIR = cls._saved_data
        os.environ.pop("ZIM_DIR", None)

    def setUp(self):
        zhttp._zim_kind_memo.clear()
        os.environ.pop("ZIMI_PUBLIC_ACCESS", None)

    def tearDown(self):
        os.environ.pop("ZIMI_PUBLIC_ACCESS", None)

    # ── helpers ────────────────────────────────────────────────────────────

    def _get(self, path):
        """(status, parsed body) for an ANONYMOUS request — no credential of
        any kind, which is the reader this endpoint has to serve."""
        try:
            with urllib.request.urlopen(self._base + path, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    # ── shape ──────────────────────────────────────────────────────────────

    def test_created_zim_reports_its_own_metadata(self):
        status, info = self._get("/zim-info?zim=made")
        self.assertEqual(status, 200)
        self.assertEqual(info["title"], "Field Handbook")
        self.assertEqual(info["creator"], "Zimi")
        self.assertEqual(info["publisher"], "Zimi")
        self.assertEqual(info["scraper"], "Zimi 1.9.0")
        self.assertEqual(info["source"], "https://handbook.example.org/")
        self.assertEqual(info["date"], "2026-08-05")
        self.assertEqual(info["language"], "en")
        self.assertEqual(info["language_raw"], "eng")
        self.assertIn("_ftindex:yes", info["tags"])
        self.assertTrue(info["readable"])
        self.assertGreater(info["size_bytes"], 0)
        self.assertEqual(info["file"], "made.zim")

    def test_history_records_survive_intact(self):
        _, info = self._get("/zim-info?zim=made")
        self.assertEqual(len(info["history"]), 2)
        created, edited = info["history"]
        self.assertEqual(created["op"], "created")
        self.assertEqual(created["mode"], "site")
        self.assertEqual(created["counts"]["pages"], 148)
        # The nested object the timeline renders as its own line — it must not
        # be flattened or dropped in transit.
        self.assertEqual(created["blocked"]["requests"], 214)
        self.assertEqual(created["blocked"]["list"], "stevenblack-hosts")
        self.assertEqual(edited["op"], "edited")

    def test_kind_rides_along_with_the_full_payload(self):
        _, info = self._get("/zim-info?zim=made")
        self.assertEqual(info["kind"]["mode"], "site")
        self.assertEqual(info["kind"]["engine"], "")
        # One creation record plus one edit.
        self.assertEqual(info["kind"]["edits"], 1)

    # ── honesty about ZIMs Zimi did not make ────────────────────────────────

    def test_foreign_zim_shows_its_publishers_fields_and_no_history(self):
        status, info = self._get("/zim-info?zim=found")
        self.assertEqual(status, 200)
        self.assertEqual(info["creator"], "DevDocs")
        self.assertEqual(info["publisher"], "openZIM")
        self.assertEqual(info["scraper"], "devdocs2zim v0.2.1")
        self.assertEqual(info["history"], [])
        self.assertIsNone(info["kind"])
        # No Source was ever written, so none is claimed.
        self.assertEqual(info["source"], "")

    def test_kinds_lists_only_the_zims_zimi_made(self):
        status, body = self._get("/zim-info?kinds=1")
        self.assertEqual(status, 200)
        self.assertIn("made", body["kinds"])
        self.assertNotIn("found", body["kinds"])

    # ── errors ─────────────────────────────────────────────────────────────

    def test_missing_parameter_is_a_400(self):
        status, body = self._get("/zim-info")
        self.assertEqual(status, 400)
        self.assertIn("error", body)

    def test_unknown_zim_is_a_404(self):
        status, _ = self._get("/zim-info?zim=no_such_zim")
        self.assertEqual(status, 404)

    # ── gating parity with /list ────────────────────────────────────────────

    def test_anonymous_reader_gets_the_same_zims_as_list(self):
        """An open instance serves /zim-info to exactly who it serves /list."""
        status, listing = self._get("/list")
        self.assertEqual(status, 200)
        names = sorted(z["name"] for z in listing)
        self.assertEqual(names, ["found", "made"])
        for name in names:
            code, info = self._get("/zim-info?zim=" + name)
            self.assertEqual(code, 200, name)
            self.assertEqual(info["name"], name)

    def test_limited_mode_hides_from_both_endpoints_identically(self):
        """A ZIM an anonymous reader may not see is absent from /list AND a 404
        here — the panel must never become the leak the listing prevents."""
        ok, err = _users.set_public_access("limited", ["made"])
        self.assertTrue(ok, err)
        # A passwordless instance treats a loopback client AS the admin, and an
        # admin is all-access by design — so the restricted reader only exists
        # once the instance has a password to not have.
        os.environ["ZIMI_MANAGE_PASSWORD"] = "restricted-reader-test"
        try:
            # Guard against a vacuous pass: the policy really is in force.
            mode, allow = _users.get_public_access()
            self.assertEqual((mode, sorted(allow)), ("limited", ["made"]))
            _, listing = self._get("/list")
            self.assertEqual([z["name"] for z in listing], ["made"])
            self.assertEqual(self._get("/zim-info?zim=made")[0], 200)
            self.assertEqual(self._get("/zim-info?zim=found")[0], 404)
            _, kinds = self._get("/zim-info?kinds=1")
            self.assertEqual(list(kinds["kinds"]), ["made"])
        finally:
            os.environ.pop("ZIMI_MANAGE_PASSWORD", None)
            _users.set_public_access("open")

    # ── memoization ────────────────────────────────────────────────────────

    def test_provenance_is_read_once_per_file(self):
        """The kinds walk opens archives; on a 500 GB library it may do that
        exactly once, not once per home render."""
        reads = []
        real = zhttp._read_zim_metadata

        def counting(archive):
            reads.append(1)
            return real(archive)

        zhttp._read_zim_metadata = counting
        try:
            self._get("/zim-info?kinds=1")
            first = len(reads)
            self._get("/zim-info?kinds=1")
            self._get("/zim-info?kinds=1")
            self.assertEqual(len(reads), first, "provenance re-read a memoized file")
            self.assertEqual(first, 2, "expected one read per installed ZIM")
        finally:
            zhttp._read_zim_metadata = real


class KindDerivationTests(unittest.TestCase):
    """The rules that turn metadata into a badge, in isolation."""

    def test_history_mode_names_the_kind(self):
        kind = zhttp._zimi_kind(
            {zimwriter.HISTORY_METADATA_KEY: json.dumps(CREATED_HISTORY)}
        )
        self.assertEqual(kind["mode"], "site")
        self.assertEqual(kind["engine"], "")
        self.assertEqual(kind["ts"], CREATED_HISTORY[0]["ts"])
        self.assertEqual(kind["blocked"]["requests"], 214)

    def test_alive_tag_makes_it_a_replay(self):
        kind = zhttp._zimi_kind(
            {
                "Tags": "_ftindex:yes;zimi:alive",
                "Scraper": "warc2zim 2.2.0 + Zimi 1.9.0",
            }
        )
        self.assertEqual(kind["engine"], "alive")
        # A replay carries no Zimi history — warc2zim writes the file — so the
        # engine is the whole answer and the mode stays empty.
        self.assertEqual(kind["mode"], "")

    def test_converted_archive_without_the_tag_is_an_import(self):
        kind = zhttp._zimi_kind(
            {"Tags": "_ftindex:yes", "Scraper": "warc2zim 2.2.0 + Zimi 1.9.0"}
        )
        self.assertEqual(kind["mode"], "import")
        self.assertEqual(kind["engine"], "")

    def test_a_foreign_zim_has_no_kind(self):
        self.assertIsNone(zhttp._zimi_kind({"Scraper": "mwoffliner 1.14.0"}))
        self.assertIsNone(zhttp._zimi_kind({}))

    def test_zimit_is_not_zimi(self):
        """The substring trap: another scraper's name starts the same way."""
        self.assertIsNone(zhttp._zimi_kind({"Scraper": "zimit 2.1.9"}))

    def test_truncated_history_still_yields_a_mode(self):
        """A ZIM edited past the record cap has lost its creation record; the
        earliest surviving record that names a mode stands in for it."""
        records = [
            {"op": "truncated", "mode": "history", "counts": {"records": 7}},
            {"op": "edited", "mode": "folder", "ts": 12345},
        ]
        kind = zhttp._zimi_kind({zimwriter.HISTORY_METADATA_KEY: json.dumps(records)})
        self.assertEqual(kind["mode"], "folder")

    def test_mangled_history_reads_as_no_history_not_as_an_error(self):
        kind = zhttp._zimi_kind(
            {zimwriter.HISTORY_METADATA_KEY: "{not json", "Scraper": "Zimi 1.9.0"}
        )
        self.assertEqual(kind["mode"], "")
        self.assertEqual(kind["edits"], 0)


if __name__ == "__main__":
    unittest.main()
