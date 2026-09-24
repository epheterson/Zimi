#!/usr/bin/env python3
"""Integration tests — start a real Zimi server and hit HTTP endpoints.

These tests verify the full request/response cycle including routing,
content types, static file serving, and management flows. No ZIM files needed
for most tests.

Usage:
    python3 -m pytest tests/test_server.py -v
"""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error

# Make zimi importable from repo root
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _start_server(zim_dir, port=0):
    """Start a Zimi server on the given port, return (server, actual_port)."""
    import zimi
    from http.server import ThreadingHTTPServer

    os.environ["ZIM_DIR"] = zim_dir
    os.environ["ZIMI_MANAGE"] = "1"

    zimi.ZIM_DIR = zim_dir
    zimi.ZIMI_DATA_DIR = os.path.join(zim_dir, ".zimi")
    os.makedirs(zimi.ZIMI_DATA_DIR, exist_ok=True)
    zimi.ZIMI_MANAGE = True
    zimi.load_cache()

    server = ThreadingHTTPServer(("127.0.0.1", port), zimi.ZimHandler)
    actual_port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, actual_port


class TestServerEndpoints(unittest.TestCase):
    """Test HTTP endpoints against a running server."""

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp()
        cls._server, cls._port = _start_server(cls._tmpdir)
        cls._base = f"http://127.0.0.1:{cls._port}"
        # Generate an API token so manage/collections endpoints authenticate
        from zimi.manage import _generate_api_token

        cls._api_token = _generate_api_token()

    @classmethod
    def tearDownClass(cls):
        cls._server.shutdown()
        import shutil

        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    def _auth_request(self, url, method="GET", data=None):
        """Build a request with API token auth."""
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self._api_token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        return req

    def _get(self, path, expect_json=True):
        url = f"{self._base}{path}"
        req = self._auth_request(url)
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
            if expect_json:
                return json.loads(data), resp.status
            return data, resp.status

    def _get_status(self, path):
        """GET and return just the status code (handles 4xx/5xx)."""
        url = f"{self._base}{path}"
        req = self._auth_request(url)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status
        except urllib.error.HTTPError as e:
            return e.code

    def _post(self, path, body=None):
        """POST JSON and return (parsed_json, status_code)."""
        url = f"{self._base}{path}"
        payload = json.dumps(body or {}).encode()
        req = self._auth_request(url, method="POST", data=payload)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read()), resp.status
        except urllib.error.HTTPError as e:
            return json.loads(e.read()), e.code

    def _delete(self, path):
        """DELETE and return (parsed_json, status_code)."""
        url = f"{self._base}{path}"
        req = self._auth_request(url, method="DELETE")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read()), resp.status
        except urllib.error.HTTPError as e:
            return json.loads(e.read()), e.code

    # ── Health ──

    def test_health(self):
        data, status = self._get("/health")
        self.assertEqual(status, 200)
        self.assertEqual(data["status"], "ok")
        self.assertIn("version", data)
        self.assertIn("zim_count", data)

    def test_health_has_pdf_support_field(self):
        data, _ = self._get("/health")
        self.assertIn("pdf_support", data)

    # ── Web UI ──

    def test_ui_returns_html(self):
        url = f"{self._base}/"
        with urllib.request.urlopen(url, timeout=10) as resp:
            content_type = resp.headers.get("Content-Type", "")
            self.assertIn("text/html", content_type)
            body = resp.read().decode()
            self.assertIn("Zimi", body)

    def test_favicon(self):
        status = self._get_status("/favicon.ico")
        self.assertEqual(status, 200)

    def test_apple_touch_icon(self):
        status = self._get_status("/apple-touch-icon.png")
        self.assertEqual(status, 200)

    # ── List (empty library) ──

    def test_list_empty(self):
        data, status = self._get("/list")
        self.assertEqual(status, 200)
        self.assertIsInstance(data, list)
        self.assertEqual(len(data), 0)

    # ── Search ──

    def test_search_empty_library(self):
        data, status = self._get("/search?q=test&limit=5")
        self.assertEqual(status, 200)
        self.assertEqual(data["total"], 0)
        self.assertIn("results", data)
        self.assertIn("elapsed", data)
        self.assertIn("partial", data)

    def test_search_fast_empty(self):
        data, status = self._get("/search?q=test&limit=5&fast=1")
        self.assertEqual(status, 200)
        self.assertTrue(data["partial"])

    def test_search_full_not_partial(self):
        data, status = self._get("/search?q=test&limit=5")
        self.assertEqual(status, 200)
        self.assertFalse(data["partial"])

    def test_search_nonexistent_zim(self):
        # 404, as api-and-mcp.md documents for an unknown zim; the body still
        # carries the error.
        req = self._auth_request(f"{self._base}/search?q=test&zim=does_not_exist")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(ctx.exception.code, 404)
        self.assertIn("error", json.loads(ctx.exception.read()))

    def test_search_missing_query(self):
        status = self._get_status("/search")
        self.assertEqual(status, 400)

    def test_search_nonexistent_collection(self):
        status = self._get_status("/search?q=test&collection=no_such_collection")
        self.assertEqual(status, 400)

    # ── Suggest ──

    def test_suggest_empty(self):
        data, status = self._get("/suggest?q=test")
        self.assertEqual(status, 200)
        # Suggest returns a dict keyed by ZIM name
        self.assertIsInstance(data, (list, dict))

    def test_suggest_missing_query(self):
        status = self._get_status("/suggest")
        self.assertEqual(status, 400)

    # ── Random ──

    def test_random_empty_library(self):
        data, status = self._get("/random")
        self.assertEqual(status, 200)
        self.assertIn("error", data)

    def test_random_nonexistent_zim(self):
        status = self._get_status("/random?zim=does_not_exist")
        self.assertEqual(status, 404)

    # ── Read ──

    def test_read_missing_params(self):
        status = self._get_status("/read")
        self.assertEqual(status, 400)

    def test_read_missing_path(self):
        status = self._get_status("/read?zim=wikipedia")
        self.assertEqual(status, 400)

    # ── Snippet ──

    def test_snippet_missing_params(self):
        status = self._get_status("/snippet")
        self.assertEqual(status, 400)

    # ── Catalog ──

    def test_catalog_missing_zim(self):
        status = self._get_status("/catalog")
        self.assertEqual(status, 400)

    # ── Collections ──

    def test_collections_empty(self):
        data, status = self._get("/collections")
        self.assertEqual(status, 200)
        self.assertIsInstance(data, dict)

    def test_collections_crud(self):
        """Create, read, and delete a collection."""
        # Create
        data, status = self._post(
            "/collections",
            {"name": "test-coll", "label": "Test Collection", "zims": []},
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["collection"], "test-coll")

        # Read — should be in the list
        data, status = self._get("/collections")
        self.assertIn("test-coll", data.get("collections", {}))

        # Delete
        data, status = self._delete("/collections?name=test-coll")
        self.assertEqual(status, 200)

        # Verify deleted
        data, status = self._get("/collections")
        self.assertNotIn("test-coll", data.get("collections", {}))

    def test_collections_create_missing_name(self):
        data, status = self._post("/collections", {"zims": []})
        self.assertEqual(status, 400)

    def test_collections_auto_name_from_label(self):
        data, status = self._post(
            "/collections", {"label": "My Dev Docs", "zims": ["devdocs_python"]}
        )
        self.assertEqual(status, 200)
        # Should auto-generate name from label
        self.assertTrue(len(data["collection"]) > 0)
        # Clean up
        self._delete(f"/collections?name={data['collection']}")

    # ── Static files (pdf.js) ──

    def test_static_pdfjs_viewer(self):
        status = self._get_status("/static/pdfjs/web/viewer.html")
        self.assertEqual(status, 200)

    def test_static_pdfjs_js(self):
        status = self._get_status("/static/pdfjs/build/pdf.mjs")
        self.assertEqual(status, 200)

    def test_static_pdfjs_css(self):
        status = self._get_status("/static/pdfjs/web/viewer.css")
        self.assertEqual(status, 200)

    def test_static_cache_headers(self):
        url = f"{self._base}/static/pdfjs/web/viewer.html"
        with urllib.request.urlopen(url, timeout=10) as resp:
            cc = resp.headers.get("Cache-Control", "")
            self.assertIn("immutable", cc)

    def test_static_path_traversal_blocked(self):
        status = self._get_status("/static/../zimi.py")
        self.assertIn(status, (400, 403))

    def test_static_double_dot_in_middle(self):
        status = self._get_status("/static/pdfjs/../../../zimi.py")
        self.assertIn(status, (400, 403))

    def test_static_nonexistent_404(self):
        status = self._get_status("/static/does_not_exist.txt")
        self.assertEqual(status, 404)

    # ── Management endpoints ──

    def test_manage_status(self):
        data, status = self._get("/manage/status")
        self.assertEqual(status, 200)
        self.assertIn("zim_count", data)
        self.assertIn("total_size_gb", data)
        self.assertTrue(data["manage_enabled"])

    def test_manage_stats(self):
        data, status = self._get("/manage/stats")
        self.assertEqual(status, 200)
        self.assertIn("metrics", data)
        self.assertIn("disk", data)
        self.assertIn("auto_update", data)
        self.assertIn("title_index", data)

    def test_manage_usage(self):
        data, status = self._get("/manage/usage")
        self.assertEqual(status, 200)

    def test_manage_has_password(self):
        """has-password returns password status (no auth required)."""
        status = self._get_status("/manage/has-password")
        self.assertEqual(status, 200)

    def test_manage_downloads_empty(self):
        data, status = self._get("/manage/downloads")
        self.assertEqual(status, 200)
        self.assertIn("downloads", data)
        self.assertIsInstance(data["downloads"], list)

    def test_manage_check_updates_empty(self):
        data, status = self._get("/manage/check-updates")
        self.assertEqual(status, 200)
        self.assertIn("updates", data)
        self.assertEqual(data["count"], 0)

    def test_manage_history(self):
        data, status = self._get("/manage/history")
        self.assertEqual(status, 200)
        self.assertIn("history", data)

    def test_manage_refresh(self):
        data, status = self._post("/manage/refresh")
        self.assertEqual(status, 200)
        self.assertEqual(data["status"], "refreshed")
        self.assertIn("zim_count", data)

    def test_manage_catalog_fetch(self):
        """The catalog endpoint answers from whatever the fetcher returns.

        It used to call Kiwix's real OPDS feed and accept 200 or 502, which
        made the whole matrix depend on the internet: a slow runner timed the
        CLIENT out before either status arrived, and the failure was a red
        badge on the README rather than anything about Zimi. The upstream call
        is stubbed now, so this tests our proxy — which is all it ever claimed
        to test."""
        import zimi.server as _srv

        original = _srv._fetch_kiwix_catalog
        _srv._fetch_kiwix_catalog = lambda *a, **k: (
            1,
            [{"name": "fixture_en_all", "title": "Fixture", "size": 1}],
            None,
        )
        try:
            data, status = self._get("/manage/catalog?count=1")
            self.assertEqual(status, 200)
            self.assertEqual(data.get("total"), 1)
        finally:
            _srv._fetch_kiwix_catalog = original

    def test_manage_catalog_falls_back_when_the_feed_is_unreachable(self):
        """An unreachable feed is answered from the shipped snapshot.

        It used to be a 502, and the catalog view answered that by replacing
        itself with one error line: no categories, no library, and none of the
        ZIMs a LAN peer was offering, which do not depend on Kiwix at all.
        """
        import zimi.server as _srv
        from zimi import catalog_snapshot

        if not catalog_snapshot.available():
            self.skipTest("no snapshot built in this checkout")

        original = _srv._fetch_kiwix_catalog
        _srv._fetch_kiwix_catalog = lambda *a, **k: (0, [], "upstream unreachable")
        try:
            data, status = self._get("/manage/catalog?count=1")
            self.assertEqual(status, 200)
            self.assertEqual(data.get("source"), "snapshot")
            self.assertTrue(data.get("as_of"), "an old catalog must be dated")
            self.assertTrue(data.get("stale"))
            self.assertTrue(data.get("items"))
        finally:
            _srv._fetch_kiwix_catalog = original

    def test_manage_catalog_still_errors_with_nothing_to_fall_back_on(self):
        """The floor. No live fetch, no cache and no snapshot is a genuine
        failure and must say so rather than render an empty library as if it
        were the real one."""
        import zimi.server as _srv
        from zimi import library as _lib

        original = _srv._fetch_kiwix_catalog
        original_offline = _lib.offline_catalog
        _srv._fetch_kiwix_catalog = lambda *a, **k: (0, [], "upstream unreachable")
        _lib.offline_catalog = lambda: ([], "none", "")
        try:
            self.assertEqual(self._get_status("/manage/catalog?count=1"), 502)
        finally:
            _srv._fetch_kiwix_catalog = original
            _lib.offline_catalog = original_offline

    def test_manage_download_missing_url(self):
        data, status = self._post("/manage/download", {})
        self.assertEqual(status, 400)
        self.assertIn("error", data)

    def test_manage_download_bad_url(self):
        data, status = self._post("/manage/download", {"url": "not-a-real-url"})
        # Should either reject or start (and fail later), both are OK
        self.assertIn(status, (200, 400))

    def test_manage_cancel_nonexistent(self):
        data, status = self._post("/manage/cancel", {"id": "fake-id-123"})
        self.assertEqual(status, 404)

    def test_manage_clear_downloads(self):
        data, status = self._post("/manage/clear-downloads")
        self.assertEqual(status, 200)
        self.assertIn("removed", data)

    def test_manage_delete_invalid_filename(self):
        data, status = self._post("/manage/delete", {"filename": "../etc/passwd"})
        self.assertEqual(status, 400)

    def test_manage_delete_nonexistent(self):
        data, status = self._post("/manage/delete", {"filename": "no_such_file.zim"})
        self.assertEqual(status, 404)

    def test_manage_delete_non_zim(self):
        data, status = self._post("/manage/delete", {"filename": "readme.txt"})
        self.assertEqual(status, 400)

    def test_manage_delete_finds_a_zim_in_a_subfolder(self):
        """Everything `zimi create` writes lands in created/, and the library
        lists it by BASENAME. Joining that onto ZIM_DIR looked in the wrong
        directory, so the delete 404'd, the file survived and the next scan
        brought it back — with the -2/-3 capture suffix climbing forever (Eric:
        "the ones I deleted kept coming back")."""
        import os
        import zimi.server as _s

        sub = os.path.join(_s.ZIM_DIR, "created")
        os.makedirs(sub, exist_ok=True)
        target = os.path.join(sub, "made_here.zim")
        with open(target, "wb") as fh:
            fh.write(b"not a real zim, but a real file")
        saved = _s._zim_files_cache
        _s._zim_files_cache = dict(saved or {})
        _s._zim_files_cache["made_here"] = target
        try:
            data, status = self._post("/manage/delete", {"filename": "made_here.zim"})
            self.assertEqual(status, 200, data)
            self.assertFalse(os.path.exists(target), "the file must actually be gone")
        finally:
            _s._zim_files_cache = saved
            if os.path.exists(target):
                os.remove(target)

    def test_manage_delete_refuses_a_path_outside_the_library(self):
        """The name→path lookup must not become a way to delete anything the
        library happens to point at from outside ZIM_DIR."""
        import os
        import tempfile
        import zimi.server as _s

        outside = os.path.join(tempfile.mkdtemp(prefix="zimi-outside-"), "evil.zim")
        with open(outside, "wb") as fh:
            fh.write(b"do not delete me")
        saved = _s._zim_files_cache
        _s._zim_files_cache = dict(saved or {})
        _s._zim_files_cache["evil"] = outside
        try:
            _data, status = self._post("/manage/delete", {"filename": "evil.zim"})
            self.assertEqual(status, 404)
            self.assertTrue(
                os.path.exists(outside), "must not delete outside the library"
            )
        finally:
            _s._zim_files_cache = saved
            os.remove(outside)

    # ── Tmp file cleanup ──

    def test_manage_cleanup_tmp_empty(self):
        """Cleanup with no tmp files returns empty list."""
        data, status = self._post("/manage/cleanup-tmp")
        self.assertEqual(status, 200)
        self.assertIn("removed", data)
        self.assertEqual(len(data["removed"]), 0)

    def test_manage_cleanup_tmp_removes_files(self):
        """Cleanup removes genuinely orphaned .zim.tmp files."""
        # A bare partial with no active/queued/pending download record is
        # orphaned, so cleanup removes it (a still-wanted partial would be
        # protected — see test_partial_cleanup).
        tmp_path = os.path.join(self._tmpdir, "test_dl.zim.tmp")
        with open(tmp_path, "wb") as f:
            f.write(b"partial" * 100)
        # Verify it shows in stats
        data, _ = self._get("/manage/stats")
        self.assertTrue(
            any(
                t["filename"] == "test_dl.zim.tmp"
                for t in data.get("disk", {}).get("tmp_files", [])
            )
        )
        # Clean up
        data, status = self._post("/manage/cleanup-tmp")
        self.assertEqual(status, 200)
        self.assertEqual(len(data["removed"]), 1)
        self.assertFalse(os.path.exists(tmp_path))

    def test_manage_stats_disk_fields(self):
        """Stats disk section includes tmp_files array."""
        data, status = self._get("/manage/stats")
        self.assertEqual(status, 200)
        self.assertIn("disk", data)
        self.assertIn("tmp_files", data["disk"])
        self.assertIn("zim_dir", data["disk"])
        self.assertIn("data_dir", data["disk"])

    # ── Password management (v1.6) ──

    def test_set_password(self):
        """set-password works when no password is set (first-time setup)."""
        data, status = self._post("/manage/set-password", {"password": "test123"})
        self.assertEqual(status, 200)
        # Changing requires current password
        data, status = self._post("/manage/set-password", {"password": "changed"})
        self.assertEqual(status, 401)
        # Clear for other tests
        self._post("/manage/set-password", {"password": "", "current": "test123"})

    def test_has_password(self):
        """has-password returns status without auth."""
        data, status = self._get("/manage/has-password")
        self.assertEqual(status, 200)
        self.assertIn("has_password", data)

    # ── Auto-update config ──

    def test_auto_update_toggle(self):
        # Enable
        data, status = self._post(
            "/manage/auto-update", {"enabled": True, "frequency": "weekly"}
        )
        self.assertEqual(status, 200)
        self.assertTrue(data["enabled"])
        self.assertEqual(data["frequency"], "weekly")

        # Disable
        data, status = self._post("/manage/auto-update", {"enabled": False})
        self.assertEqual(status, 200)
        self.assertFalse(data["enabled"])

    def test_auto_update_invalid_frequency(self):
        data, status = self._post("/manage/auto-update", {"frequency": "hourly"})
        self.assertEqual(status, 400)

    # ── FTS build ──

    def test_build_fts_missing_name(self):
        data, status = self._post("/manage/build-fts", {})
        self.assertEqual(status, 400)

    def test_build_fts_nonexistent_zim(self):
        data, status = self._post("/manage/build-fts", {"name": "no_such_zim"})
        self.assertEqual(status, 404)

    # ── /w/ content route ──

    def test_w_nonexistent_zim(self):
        """A document request for a missing ZIM gets the styled gone-source
        page (a deleted source's old bookmarks land here); a subresource still
        gets the JSON 404 it can parse."""
        url = f"{self._base}/w/nonexistent_zim/A/Test"
        # As a page being opened: prose, 200.
        req = urllib.request.Request(url)
        req.add_header("Sec-Fetch-Dest", "iframe")
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(resp.status, 200)
            self.assertIn(b"isn't in the library", resp.read())
        # As an image subresource: JSON 404.
        req = urllib.request.Request(url + ".png")
        req.add_header("Sec-Fetch-Dest", "image")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                status = resp.status
        except urllib.error.HTTPError as e:
            status = e.code
        self.assertEqual(status, 404)

    # ── 404 for unknown routes ──

    def test_unknown_route_404(self):
        status = self._get_status("/nonexistent-endpoint")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
