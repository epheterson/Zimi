"""Tests for the /dl/<name> peer file-serving endpoint (LAN ZIM sharing).

Covers the raw-.zim HTTP streaming transport: full GET, Range/resume,
unknown-file 404, and the private-IP share gate that keeps the open
internet from vacuuming multi-GB files off a publicly-proxied instance.
"""

import os
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import zimi.server as _srv
from zimi.http import ZimHandler

# Deterministic body big enough to span multiple range slices.
_BODY = bytes(range(256)) * 64  # 16 KiB


class PeerFileServeIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls._zim_path = os.path.join(cls._tmp.name, "testzim_2026-01.zim")
        with open(cls._zim_path, "wb") as f:
            f.write(_BODY)
        # Inject straight into the file-mapping cache — no real archive needed,
        # the endpoint only touches the filesystem.
        cls._saved_cache = _srv._zim_files_cache
        _srv._zim_files_cache = {"testzim": cls._zim_path}

        # Sharing is opt-in (off) by default; these tests exercise the
        # serving path, so switch it on for the class.
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

    def _url(self, path):
        return f"http://127.0.0.1:{self._port}{path}"

    def test_full_download_by_name(self):
        with urllib.request.urlopen(self._url("/dl/testzim")) as r:
            self.assertEqual(r.status, 200)
            self.assertEqual(r.headers.get("Accept-Ranges"), "bytes")
            self.assertEqual(int(r.headers.get("Content-Length")), len(_BODY))
            self.assertEqual(r.read(), _BODY)

    def test_full_download_by_filename(self):
        with urllib.request.urlopen(self._url("/dl/testzim_2026-01.zim")) as r:
            self.assertEqual(r.status, 200)
            self.assertEqual(r.read(), _BODY)

    def test_range_request_returns_partial(self):
        req = urllib.request.Request(
            self._url("/dl/testzim"), headers={"Range": "bytes=100-199"}
        )
        with urllib.request.urlopen(req) as r:
            self.assertEqual(r.status, 206)
            self.assertEqual(
                r.headers.get("Content-Range"), f"bytes 100-199/{len(_BODY)}"
            )
            body = r.read()
        self.assertEqual(body, _BODY[100:200])
        self.assertEqual(len(body), 100)

    def test_suffix_range(self):
        req = urllib.request.Request(
            self._url("/dl/testzim"), headers={"Range": "bytes=-50"}
        )
        with urllib.request.urlopen(req) as r:
            self.assertEqual(r.status, 206)
            self.assertEqual(r.read(), _BODY[-50:])

    def test_unknown_file_404(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(self._url("/dl/does_not_exist"))
        self.assertEqual(ctx.exception.code, 404)


class PeerShareGateTests(unittest.TestCase):
    """Unit-test the share gate without a socket by faking `self`."""

    def _allowed(self, ip):
        fake = types.SimpleNamespace(_client_ip=lambda: ip)
        return ZimHandler._peer_share_allowed(fake)

    def setUp(self):
        # Gate tests probe the IP logic; sharing itself must be on (it is
        # opt-in/off by default since v1.7.0).
        os.environ["ZIMI_PEER_SHARE"] = "1"
        os.environ.pop("ZIMI_PEER_SHARE_PUBLIC", None)

    def tearDown(self):
        for k in ("ZIMI_PEER_SHARE", "ZIMI_PEER_SHARE_PUBLIC"):
            os.environ.pop(k, None)

    def test_loopback_allowed(self):
        self.assertTrue(self._allowed("127.0.0.1"))

    def test_private_lan_allowed(self):
        self.assertTrue(self._allowed("10.0.0.149"))
        self.assertTrue(self._allowed("192.168.1.5"))

    def test_public_ip_blocked_by_default(self):
        self.assertFalse(self._allowed("8.8.8.8"))

    def test_public_ip_allowed_when_opted_in(self):
        os.environ["ZIMI_PEER_SHARE_PUBLIC"] = "1"
        self.assertTrue(self._allowed("8.8.8.8"))

    def test_sharing_disabled_blocks_even_lan(self):
        os.environ["ZIMI_PEER_SHARE"] = "0"
        self.assertFalse(self._allowed("10.0.0.149"))

    def test_garbage_ip_blocked(self):
        self.assertFalse(self._allowed("not-an-ip"))


if __name__ == "__main__":
    unittest.main()
