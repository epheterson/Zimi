"""Tests for downloading a ZIM directly from a LAN peer over HTTP.

The headline test (`test_offline_peer_pull_end_to_end`) runs a real,
internet-free transfer: one in-process Zimi HTTP server seeds a fake .zim
via /dl/, and the actual download machinery (enqueue → thread → mirror loop
→ size verify → atomic rename) pulls it into a fresh ZIM_DIR. No mocks on
the transport — only peer *discovery* is stubbed.
"""

import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import zimi.library as lib
import zimi.server as _srv
from zimi.http import ZimHandler

_BODY = bytes(range(256)) * 512  # 128 KiB


class PeerDownloadUnitTests(unittest.TestCase):
    """Build-the-record logic, with enqueue + discovery stubbed."""

    def _run(self, peer, fname, peers, listing=None):
        captured = {}

        def fake_enqueue(dl):
            captured.clear()
            captured.update(dl)
            return False

        with (
            patch("zimi.library._enqueue_or_start", side_effect=fake_enqueue),
            patch("zimi.p2p_discovery.get_peers", return_value=peers),
            patch("zimi.p2p_discovery.fetch_peer_list", return_value=(listing or [])),
        ):
            dl_id, err = lib._start_peer_download(peer, fname)
        return dl_id, err, captured

    def test_builds_trusted_url_from_discovery(self):
        peers = [{"name": "zimi-mini", "host": "10.0.0.149", "port": 8899}]
        listing = [{"file": "wikipedia_en_2026-01.zim", "size_bytes": 12345}]
        dl_id, err, dl = self._run(
            "zimi-mini", "wikipedia_en_2026-01.zim", peers, listing
        )
        self.assertIsNone(err)
        self.assertTrue(dl_id)
        self.assertEqual(
            dl["url"], "http://10.0.0.149:8899/dl/wikipedia_en_2026-01.zim"
        )
        self.assertEqual(dl["_source"], "peer")
        self.assertEqual(dl["peer_name"], "zimi-mini")
        self.assertEqual(dl["size_bytes"], 12345)

    def test_unknown_peer_rejected(self):
        dl_id, err, _ = self._run("ghost", "x_2026-01.zim", [])
        self.assertIsNone(dl_id)
        self.assertEqual(err, "Peer not found")

    def test_bad_filename_rejected_before_lookup(self):
        # basename strips the path; not-a-.zim → rejected
        dl_id, err, _ = self._run(
            "zimi-mini",
            "../../etc/passwd",
            [{"name": "zimi-mini", "host": "h", "port": 1}],
        )
        self.assertIsNone(dl_id)
        self.assertTrue(err)


class OfflinePeerPullTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Seeder: serve a fake .zim from /dl/ on a loopback port.
        cls._seed_dir = tempfile.TemporaryDirectory()
        seed_path = os.path.join(cls._seed_dir.name, "testpeer_2026-01.zim")
        with open(seed_path, "wb") as f:
            f.write(_BODY)
        cls._saved_cache = _srv._zim_files_cache
        _srv._zim_files_cache = {"testpeer": seed_path}

        cls._server = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
        cls._port = cls._server.server_address[1]
        cls._thread = threading.Thread(target=cls._server.serve_forever, daemon=True)
        cls._thread.start()

        # Downloader lands files in a *separate* fresh dir.
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

    def test_offline_peer_pull_end_to_end(self):
        peers = [{"name": "zimi-seed", "host": "127.0.0.1", "port": self._port}]
        listing = [{"file": "testpeer_2026-01.zim", "size_bytes": len(_BODY)}]
        # Stub post-download finalize: it kicks off Q-ID index building against
        # the import-time default ZIM dir — irrelevant to (and noisy for) a
        # transport test. The file landing + done flag happen before it runs.
        with (
            patch("zimi.p2p_discovery.get_peers", return_value=peers),
            patch("zimi.p2p_discovery.fetch_peer_list", return_value=listing),
            patch("zimi.library._post_download_finalize"),
            # The install gate libzim-validates every downloaded file; these
            # transport tests' payloads aren't real ZIMs, so stub the check.
            patch.object(lib._srv, "open_archive", return_value=object()),
        ):
            dl_id, err = lib._start_peer_download("zimi-seed", "testpeer_2026-01.zim")
            self.assertIsNone(err)

            dest = os.path.join(self._dl_dir.name, "testpeer_2026-01.zim")
            deadline = time.time() + 15
            while time.time() < deadline:
                dl = _srv._active_downloads.get(dl_id, {})
                if dl.get("done"):
                    break
                time.sleep(0.1)
        dl = _srv._active_downloads.get(dl_id, {})
        self.assertTrue(dl.get("done"), "download did not finish in time")
        self.assertIsNone(dl.get("error"), f"download errored: {dl.get('error')}")
        self.assertTrue(os.path.isfile(dest), "ZIM did not land in ZIM_DIR")
        with open(dest, "rb") as f:
            self.assertEqual(f.read(), _BODY, "transferred bytes differ from source")


class PeerHostGateTests(unittest.TestCase):
    """SSRF guard: only LAN/loopback IP literals are valid peer hosts."""

    def test_lan_and_loopback_allowed(self):
        for h in ("10.0.0.5", "192.168.1.10", "172.16.3.4", "127.0.0.1"):
            self.assertTrue(lib._is_lan_host(h), h)

    def test_offlan_and_metadata_rejected(self):
        # 169.254.169.254 = cloud metadata (link-local); 8.8.8.8/1.1.1.1 public
        for h in ("169.254.169.254", "169.254.0.1", "8.8.8.8", "1.1.1.1"):
            self.assertFalse(lib._is_lan_host(h), h)

    def test_hostname_rejected(self):
        self.assertFalse(lib._is_lan_host("evil.example.com"))
        self.assertFalse(lib._is_lan_host(""))

    def test_enqueue_rejects_offlan_peer(self):
        peers = [{"name": "evil", "host": "169.254.169.254", "port": 80}]
        with (
            patch("zimi.p2p_discovery.get_peers", return_value=peers),
            patch("zimi.p2p_discovery.fetch_peer_list", return_value=[]),
        ):
            dl_id, err = lib._start_peer_download("evil", "x_2026-01.zim")
        self.assertIsNone(dl_id)
        self.assertEqual(err, "Peer host not on LAN")


class PeerRedirectRefusalTests(unittest.TestCase):
    """A peer that passes the host check still can't 302 us off-LAN."""

    @classmethod
    def setUpClass(cls):
        class _Redir(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", "http://10.0.0.1/dl/evil_2026-01.zim")
                self.end_headers()

            def log_message(self, format, *args):
                pass

        cls._server = ThreadingHTTPServer(("127.0.0.1", 0), _Redir)
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
        _srv.ZIM_DIR = cls._saved_zim_dir
        lib._srv.ZIM_DIR = cls._saved_zim_dir
        cls._dl_dir.cleanup()

    def test_peer_download_refuses_redirect(self):
        peers = [{"name": "zimi-redir", "host": "127.0.0.1", "port": self._port}]
        listing = [{"file": "evil_2026-01.zim", "size_bytes": 10}]
        with (
            patch("zimi.p2p_discovery.get_peers", return_value=peers),
            patch("zimi.p2p_discovery.fetch_peer_list", return_value=listing),
            patch("zimi.library._post_download_finalize"),
            # The install gate libzim-validates every downloaded file; these
            # transport tests' payloads aren't real ZIMs, so stub the check.
            patch.object(lib._srv, "open_archive", return_value=object()),
        ):
            dl_id, err = lib._start_peer_download("zimi-redir", "evil_2026-01.zim")
            self.assertIsNone(err)
            deadline = time.time() + 10
            while time.time() < deadline:
                if _srv._active_downloads.get(dl_id, {}).get("done"):
                    break
                time.sleep(0.1)
        dl = _srv._active_downloads.get(dl_id, {})
        self.assertTrue(dl.get("done"))
        # Redirect surfaced as an HTTP 302 failure — we did NOT follow it.
        self.assertIn("302", dl.get("error") or "")
        self.assertFalse(
            os.path.isfile(os.path.join(self._dl_dir.name, "evil_2026-01.zim"))
        )


if __name__ == "__main__":
    unittest.main()
