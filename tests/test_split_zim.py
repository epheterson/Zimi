"""Split ZIMs: one book stored as name.zimaa, name.zimab, ... (zimsplit's
output, made for FAT32's 4 GB file cap) is one book in the library.

The fixtures are real ZIMs cut the way zimsplit cuts them, between clusters
(conftest_zim.split_fixture_zim), so libzim reads them as it reads the real
thing, full-text index included."""

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest_zim import build_fixture_zim, split_fixture_zim  # noqa: E402
import zimi.server as server  # noqa: E402
from zimi import health, library, zimcheck, zimparts  # noqa: E402

BOOK = "splitbook_en_all_2026-01.zim"
OTHER_SPLIT = "otherbook_en_all_2026-01.zim"
WHOLE = "wholebook_en_all_2026-01.zim"
# Below the fixture's smallest gap between clusters: every cluster boundary
# becomes a cut, three chunks, the full-text index whole in the last one.
PART_SIZE = 100


def _make_split(folder, filename):
    """A real ZIM at ``folder/filename``, cut into chunks; their paths."""
    return split_fixture_zim(
        build_fixture_zim(os.path.join(folder, filename)), PART_SIZE
    )


class _Library(unittest.TestCase):
    """A library with a split book, a second split book and a whole one."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="zimi-split-")
        self.zdir = os.path.join(self._tmp, "zims")
        os.makedirs(self.zdir)
        self.chunks = _make_split(self.zdir, BOOK)
        self.other = _make_split(self.zdir, OTHER_SPLIT)
        self.whole = build_fixture_zim(os.path.join(self.zdir, WHOLE))
        self._saved = (server.ZIM_DIR, server.ZIMI_DATA_DIR, server.ZIMI_MANAGE)
        server.ZIM_DIR = self.zdir
        server.ZIMI_DATA_DIR = os.path.join(self._tmp, "data")
        os.makedirs(server.ZIMI_DATA_DIR)
        server.ZIMI_MANAGE = True
        self._rescan()

    def tearDown(self):
        server.ZIM_DIR, server.ZIMI_DATA_DIR, server.ZIMI_MANAGE = self._saved
        server._zim_files_cache = None
        server._zim_list_cache = None
        server._archive_pool.clear()
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _rescan(self):
        server._zim_files_cache = None
        server._zim_list_cache = None
        server._archive_pool.clear()
        server.load_cache(force=True)

    def _entry(self, name="splitbook"):
        return [z for z in server.list_zims() if z["name"] == name]


class TestScan(_Library):
    def test_the_fixture_is_three_chunks_with_its_index_whole(self):
        self.assertEqual(
            [os.path.basename(p)[-2:] for p in self.chunks], ["aa", "ab", "ac"]
        )

    def test_a_split_book_is_one_book_under_the_name_a_whole_file_would_get(self):
        zims = server.get_zim_files()
        self.assertEqual(zims["splitbook"], self.chunks[0])
        self.assertEqual(server._zim_base_name(BOOK), "splitbook")
        self.assertEqual(sorted(zims), ["otherbook", "splitbook", "wholebook"])

    def test_the_library_lists_it_once_with_every_chunks_bytes(self):
        (entry,) = self._entry()
        self.assertEqual(entry["file"], BOOK)
        self.assertEqual(
            entry["size_bytes"], sum(os.path.getsize(p) for p in self.chunks)
        )
        self.assertEqual(entry["parts"], 3)
        self.assertEqual(entry["date"], "2026-01")
        self.assertNotIn("parts", self._entry("wholebook")[0])

    def test_a_whole_file_beside_its_chunks_is_the_one_served(self):
        shutil.copy(self.whole, os.path.join(self.zdir, BOOK))
        self._rescan()
        self.assertEqual(
            server.get_zim_files()["splitbook"], os.path.join(self.zdir, BOOK)
        )

    def test_a_split_book_in_a_subfolder_is_found(self):
        sub = os.path.join(self.zdir, "stick")
        os.makedirs(sub)
        for p in self.chunks:
            shutil.move(p, sub)
        self._rescan()
        self.assertEqual(
            server.get_zim_files()["splitbook"],
            os.path.join(sub, os.path.basename(self.chunks[0])),
        )

    def test_the_metadata_cache_stays_a_hit_on_the_next_load(self):
        server._zim_list_cache = None
        server.load_cache(force=False)
        (entry,) = self._entry()
        self.assertEqual(entry["file"], BOOK)
        self.assertEqual(entry["parts"], 3)

    def test_catalog_counts_the_split_book_as_installed(self):
        self.assertIn("splitbook_en_all", library._installed_bases())


class TestHealth(_Library):
    def test_the_health_check_reads_the_whole_book(self):
        row = health._check_one({"name": "splitbook"}, self.chunks[0], {})
        self.assertTrue(row["opens"])
        self.assertEqual(row["issues"], [])
        self.assertEqual(row["entries"], 3)

    def test_zimi_check_verifies_the_checksum_across_chunks(self):
        findings = zimcheck.check(self.chunks[0])
        self.assertFalse(
            [f for f in findings if f["check"] in ("open", "checksum")], findings
        )

    def test_zimi_check_given_a_later_chunk_checks_the_book(self):
        findings = zimcheck.check(self.chunks[1])
        self.assertFalse(
            [f for f in findings if f["check"] in ("open", "checksum")], findings
        )


class TestMissingChunk(_Library):
    def setUp(self):
        super().setUp()
        os.remove(self.chunks[1])
        self._rescan()

    def test_the_book_stays_listed_and_says_which_chunk_is_missing(self):
        (entry,) = self._entry()
        self.assertEqual(entry["missing_part"], "splitbook_en_all_2026-01.zimab")
        self.assertEqual(entry["entries"], "?")

    def test_no_archive_is_opened_on_a_half_book(self):
        self.assertIsNone(server.get_archive("splitbook"))
        self.assertIsNotNone(server.get_archive("otherbook"))

    def test_the_health_check_names_the_missing_chunk(self):
        row = health._check_one({"name": "splitbook"}, self.chunks[0], {})
        self.assertFalse(row["opens"])
        self.assertIn("missing chunk splitbook_en_all_2026-01.zimab", row["issues"])

    def test_zimi_check_names_the_missing_chunk(self):
        findings = zimcheck.check(self.chunks[0])
        self.assertEqual(findings[0]["check"], "open")
        self.assertIn(
            "missing chunk splitbook_en_all_2026-01.zimab", findings[0]["message"]
        )


class TestMissingLastChunk(_Library):
    def test_a_missing_last_chunk_is_named_as_a_short_book(self):
        os.remove(self.chunks[2])  # no gap to see: libzim's size check finds it
        self._rescan()
        self.assertIsNone(server.get_archive("splitbook"))
        findings = zimcheck.check(self.chunks[0])
        self.assertEqual(findings[0]["check"], "open")
        self.assertIn("missing or cut short", findings[0]["message"])
        row = health._check_one({"name": "splitbook"}, self.chunks[0], {})
        self.assertTrue(any("missing or cut short" in i for i in row["issues"]))


class TestExtensionCase(_Library):
    """A FAT stick or a Windows copy can leave .ZIM, .Zim or .ZIMAA."""

    def setUp(self):
        super().setUp()
        build_fixture_zim(os.path.join(self.zdir, "caps_en_all_2026-01.ZIM"))
        build_fixture_zim(os.path.join(self.zdir, "mixed_en_all_2026-01.Zim"))
        for p in _make_split(self.zdir, "upsplit_en_all_2026-01.zim"):
            os.rename(p, p[: -len(".zimaa")] + p[-len(".zimaa") :].upper())
        self._rescan()

    def test_whole_files_in_any_case_are_named_as_lower_case_ones(self):
        rows = {z["name"]: z for z in server.list_zims()}
        for name, file in (
            ("caps", "caps_en_all_2026-01.zim"),
            ("mixed", "mixed_en_all_2026-01.zim"),
        ):
            self.assertEqual(server._zim_base_name(file), name)
            self.assertEqual(rows[name]["file"], file)
            self.assertEqual(rows[name]["date"], "2026-01")
            self.assertEqual(rows[name]["entries"], 3)

    def test_upper_case_chunks_are_one_book(self):
        rows = [z for z in server.list_zims() if z["name"] == "upsplit"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["file"], "upsplit_en_all_2026-01.zim")
        self.assertEqual(rows[0]["parts"], 3)
        first = server.get_zim_files()["upsplit"]
        self.assertTrue(first.endswith(".ZIMAA"))
        # libzim finds later chunks by lower-case names: a filesystem that
        # ignores case reads the book, one that does not says to rename.
        if os.path.exists(first[:-2] + "ab"):
            self.assertIsNotNone(server.get_archive("upsplit"))
        else:
            row = health._check_one({"name": "upsplit"}, first, {})
            self.assertIn("rename them to .zimaa", " ".join(row["issues"]))

    def test_delete_finds_a_book_by_its_lower_case_name(self):
        self.assertEqual(
            zimparts.path_of(self.zdir, "caps_en_all_2026-01.zim").lower(),
            os.path.join(self.zdir, "caps_en_all_2026-01.zim").lower(),
        )
        self.assertEqual(
            zimparts.on_disk(zimparts.path_of(self.zdir, "upsplit_en_all_2026-01.zim")),
            sorted(
                p
                for p in (os.path.join(self.zdir, n) for n in os.listdir(self.zdir))
                if "upsplit" in p
            ),
        )


class TestParts(unittest.TestCase):
    def test_book_filename_and_parts(self):
        tmp = tempfile.mkdtemp(prefix="zimi-parts-")
        try:
            chunks = _make_split(tmp, BOOK)
            self.assertEqual(zimparts.book_filename(chunks[0]), BOOK)
            self.assertEqual(zimparts.parts(chunks[0]), chunks)
            self.assertEqual(zimparts.in_folder(tmp), [chunks[0]])
            self.assertEqual(zimparts.path_of(tmp, BOOK), chunks[0])
            self.assertIsNone(zimparts.missing_part(chunks[0]))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_a_byte_cut_through_the_index_loses_full_text_and_aligned_keeps_it(self):
        """Why the fixture cuts between clusters: libzim reads a Xapian index
        only when it sits whole in one chunk. zimsplit never cuts inside a
        cluster and the index is one cluster; `split -b` cuts anywhere."""
        from libzim.reader import Archive

        tmp = tempfile.mkdtemp(prefix="zimi-parts-")
        try:
            aligned = _make_split(tmp, "a_en_all_2026-01.zim")
            byte_cut = split_fixture_zim(
                build_fixture_zim(os.path.join(tmp, "b_en_all_2026-01.zim")),
                8000,
                aligned=False,
            )
            self.assertTrue(Archive(aligned[0]).has_fulltext_index)
            self.assertFalse(Archive(byte_cut[0]).has_fulltext_index)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestUpdates(_Library):
    def test_auto_update_leaves_a_split_book_alone(self):
        newer = {
            "name": "splitbook_en_all",
            "date": "2026-06-01",
            "download_url": "https://download.kiwix.org/zim/x/splitbook_en_all_2026-06.zim",
            "title": "Split",
            "language": "eng",
            "size_bytes": 1,
        }
        whole = dict(
            newer,
            name="wholebook_en_all",
            download_url=newer["download_url"].replace("split", "whole"),
        )
        saved = (library._full_catalog, library._check_streetzim_updates)
        library._full_catalog = lambda: [newer, whole]
        library._check_streetzim_updates = lambda installed: []
        try:
            names = {u["name"] for u in library._check_updates()}
        finally:
            library._full_catalog, library._check_streetzim_updates = saved
        self.assertIn("wholebook", names)  # the probe works
        self.assertNotIn("splitbook", names)


class TestRoutes(_Library):
    def setUp(self):
        super().setUp()
        from http.server import ThreadingHTTPServer

        from zimi.http import ZimHandler
        from zimi.manage import _generate_api_token

        self._srv = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()
        self._base = f"http://127.0.0.1:{self._srv.server_address[1]}"
        self._token = _generate_api_token()

    def tearDown(self):
        self._srv.shutdown()
        self._srv.server_close()
        super().tearDown()

    def _req(self, path, payload=None, headers=None):
        body = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(
            self._base + path, data=body, method="POST" if body else "GET"
        )
        req.add_header("Authorization", f"Bearer {self._token}")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        if body:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_an_entry_is_served(self):
        st, body = self._req(
            "/w/splitbook/A/Water", headers={"Sec-Fetch-Dest": "iframe"}
        )
        self.assertEqual(st, 200)
        self.assertIn(b"Water purification", body)

    def test_full_text_search_finds_it(self):
        st, body = self._req("/search?q=boil&zim=splitbook")
        data = json.loads(body)
        self.assertEqual([r["path"] for r in data["results"]], ["A/Water"])
        self.assertFalse(data.get("incomplete"))

    def test_list_has_one_row(self):
        st, body = self._req("/list")
        rows = [z for z in json.loads(body) if z["name"] == "splitbook"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["file"], BOOK)

    def test_delete_removes_every_chunk_and_nothing_else(self):
        st, _ = self._req("/manage/delete", {"filename": BOOK})
        self.assertEqual(st, 200)
        self.assertFalse([p for p in self.chunks if os.path.exists(p)])
        self.assertTrue(all(os.path.exists(p) for p in self.other))
        self.assertTrue(os.path.exists(self.whole))
        self._rescan()
        self.assertNotIn("splitbook", server.get_zim_files())

    def test_a_peer_cannot_pull_a_split_book(self):
        st, body = self._req("/dl/splitbook")
        self.assertEqual(st, 409)
        self.assertEqual(json.loads(body)["error_key"], "split_not_shared")
        st, _ = self._req("/dl/wholebook", headers={"Range": "bytes=0-3"})
        self.assertEqual(st, 206)


class TestPeerList(unittest.TestCase):
    def test_a_peers_split_books_are_not_offered(self):
        from zimi import p2p_discovery

        rows = [
            {"name": "a", "file": "a.zim"},
            {"name": "b", "file": "b.zim", "parts": 3},
        ]
        self.assertEqual(p2p_discovery.pullable(rows), [rows[0]])


if __name__ == "__main__":
    unittest.main()
