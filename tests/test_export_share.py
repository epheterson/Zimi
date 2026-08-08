"""Sharing generated bookmark ZIMs — the travel half of the export feature.

An export is only useful on another device if (a) /dl/ serves it like any
other ZIM with browser-grade download headers, and (b) the peer pull path
accepts the filenames zimwriter actually produces. These tests pin both,
plus a full offline pull of an export-named file through the real download
machinery (mirroring test_peer_download's transport harness).
"""

import os
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import zimi.library as lib
import zimi.server as _srv
import zimi.zimwriter as zw
from zimi.http import ZimHandler

_EXPORT_FILE = "zimi-bookmarks_2026-08-07.zim"
_BODY = bytes(range(256)) * 64  # 16 KiB


class ExportDownloadHeaderTests(unittest.TestCase):
    """The Download button saves /dl/<file> straight from the browser: the
    response must carry attachment headers so the click downloads instead of
    navigating, with the real filename and exact length."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls._zim_path = os.path.join(cls._tmp.name, _EXPORT_FILE)
        with open(cls._zim_path, "wb") as f:
            f.write(_BODY)
        cls._saved_cache = _srv._zim_files_cache
        # Exports register in the library under their basename stem, exactly
        # like any downloaded ZIM — /dl/ resolves them from the same mapping.
        _srv._zim_files_cache = {"zimi-bookmarks_2026-08-07": cls._zim_path}
        os.environ["ZIMI_PEER_SHARE"] = "1"
        cls._server = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        cls._port = cls._server.server_address[1]
        cls._thread = threading.Thread(target=cls._server.serve_forever, daemon=True)
        cls._thread.start()

    @classmethod
    def tearDownClass(cls):
        cls._server.shutdown()
        cls._server.server_close()
        _srv._zim_files_cache = cls._saved_cache
        cls._tmp.cleanup()
        os.environ.pop("ZIMI_PEER_SHARE", None)

    def _get(self, path, headers=None):
        import urllib.request

        req = urllib.request.Request(
            f"http://127.0.0.1:{self._port}{path}", headers=headers or {}
        )
        return urllib.request.urlopen(req)

    def test_export_download_headers(self):
        with self._get("/dl/" + _EXPORT_FILE) as r:
            self.assertEqual(r.status, 200)
            self.assertEqual(
                r.headers.get("Content-Disposition"),
                f'attachment; filename="{_EXPORT_FILE}"',
            )
            self.assertEqual(r.headers.get("Content-Type"), "application/octet-stream")
            self.assertEqual(int(r.headers.get("Content-Length")), len(_BODY))
            self.assertEqual(r.headers.get("Accept-Ranges"), "bytes")
            self.assertEqual(r.read(), _BODY)

    def test_export_range_resume(self):
        with self._get(
            "/dl/" + _EXPORT_FILE, headers={"Range": "bytes=1000-1999"}
        ) as r:
            self.assertEqual(r.status, 206)
            self.assertEqual(r.read(), _BODY[1000:2000])

    def test_gate_matches_dl_posture(self):
        """Sharing off blocks the export download too — same switch, same gate.
        (Loopback/LAN-only remains the default; WAN needs the public opt-in.)"""
        import urllib.error, urllib.request

        os.environ["ZIMI_PEER_SHARE"] = "0"
        try:
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(
                    f"http://127.0.0.1:{self._port}/dl/{_EXPORT_FILE}"
                )
            self.assertEqual(ctx.exception.code, 403)
        finally:
            os.environ["ZIMI_PEER_SHARE"] = "1"


class ExportNameRoundTripTests(unittest.TestCase):
    """What zimwriter writes, the peer pull path must accept — otherwise a
    peer can list an export but never fetch it."""

    def test_default_export_name_is_pullable(self):
        clean, err = lib._validate_zim_filename(_EXPORT_FILE)
        self.assertIsNone(err)
        self.assertEqual(clean, _EXPORT_FILE)

    def test_nonclobber_suffix_is_pullable(self):
        # _output_path appends -2, -3, … when the base name exists.
        clean, err = lib._validate_zim_filename("zimi-bookmarks_2026-08-07-2.zim")
        self.assertIsNone(err)
        self.assertEqual(clean, "zimi-bookmarks_2026-08-07-2.zim")

    def test_output_path_names_survive_validation(self):
        # Round-trip against the real generator: seed collisions so the
        # non-clobber counter engages, then validate every produced name.
        with tempfile.TemporaryDirectory() as d:
            for _ in range(3):
                base = "zimi-bookmarks_2026-08-07"
                out = zw._output_path(d, base)
                open(out, "wb").close()
                clean, err = lib._validate_zim_filename(os.path.basename(out))
                self.assertIsNone(err, f"{out} rejected: {err}")
                self.assertEqual(clean, os.path.basename(out))


class ExportPeerPullTests(unittest.TestCase):
    """Full offline pull of an export from a peer: /dl/ seeder → enqueue →
    download thread → size verify → atomic rename into ZIM_DIR."""

    @classmethod
    def setUpClass(cls):
        cls._seed_dir = tempfile.TemporaryDirectory()
        seed_path = os.path.join(cls._seed_dir.name, _EXPORT_FILE)
        with open(seed_path, "wb") as f:
            f.write(_BODY)
        cls._saved_cache = _srv._zim_files_cache
        _srv._zim_files_cache = {"zimi-bookmarks_2026-08-07": seed_path}

        cls._server = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        cls._port = cls._server.server_address[1]
        cls._thread = threading.Thread(target=cls._server.serve_forever, daemon=True)
        cls._thread.start()

        cls._dl_dir = tempfile.TemporaryDirectory()
        cls._saved_zim_dir = _srv.ZIM_DIR
        _srv.ZIM_DIR = cls._dl_dir.name
        lib._srv.ZIM_DIR = cls._dl_dir.name

    @classmethod
    def tearDownClass(cls):
        cls._server.shutdown()
        cls._server.server_close()
        _srv._zim_files_cache = cls._saved_cache
        _srv.ZIM_DIR = cls._saved_zim_dir
        lib._srv.ZIM_DIR = cls._saved_zim_dir
        cls._seed_dir.cleanup()
        cls._dl_dir.cleanup()

    def test_peer_pull_of_export_end_to_end(self):
        peers = [{"name": "zimi-seed", "host": "127.0.0.1", "port": self._port}]
        # The peer's /list advertises the export with its flag, exactly as
        # server.py emits it — size flows into the truncation check.
        listing = [
            {"file": _EXPORT_FILE, "size_bytes": len(_BODY), "zimi_export": True}
        ]
        with (
            patch("zimi.p2p_discovery.get_peers", return_value=peers),
            patch("zimi.p2p_discovery.is_share_enabled", return_value=True),
            patch("zimi.p2p_discovery.fetch_peer_list", return_value=listing),
            patch("zimi.library._post_download_finalize"),
            # Transport test: the payload isn't a real ZIM, skip libzim validation.
            patch.object(lib._srv, "open_archive", return_value=object()),
        ):
            dl_id, err = lib._start_peer_download("zimi-seed", _EXPORT_FILE)
            self.assertIsNone(err)
            deadline = time.time() + 15
            while time.time() < deadline:
                if _srv._active_downloads.get(dl_id, {}).get("done"):
                    break
                time.sleep(0.1)
        dl = _srv._active_downloads.get(dl_id, {})
        self.assertTrue(dl.get("done"), "export pull did not finish in time")
        self.assertIsNone(dl.get("error"), f"export pull errored: {dl.get('error')}")
        dest = os.path.join(self._dl_dir.name, _EXPORT_FILE)
        self.assertTrue(os.path.isfile(dest), "export did not land in ZIM_DIR")
        with open(dest, "rb") as f:
            self.assertEqual(f.read(), _BODY)


if __name__ == "__main__":
    unittest.main()
