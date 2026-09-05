"""GHSA-5mw2-53vv-9pw6 — the passwordless-bootstrap takeover, and its fix.

The advisory: on a passwordless instance, `_check_manage_auth` granted admin
to any *private-tier* client — the whole RFC1918 LAN, a Docker bridge, a
Tailscale tailnet — so an adjacent device could race the owner to claim the
first admin password and lock them out (CWE-306).

The fix splits the bootstrap door. Being ON the host (loopback) needs no
secret. Every remote client must present the one-time setup key the server
prints to its log. These tests reproduce the attacker's exact sequence from a
simulated adjacent address and prove it is now refused, then prove the two
legitimate doors — local, and remote-with-key — still open.

The adjacent peer's address is injected by overriding `_client_ip` for the
duration of a test. A forwarded header cannot do it — `_client_ip` REJECTS a
forwarded value that itself claims a trusted-tier (LAN/CGNAT) address,
precisely so a peer can't spoof one to borrow that trust (its own tests cover
that). Overriding `_client_ip` places the peer off-host and exercises the
real bootstrap gate, the real set-password route, and the real key check.
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
from zimi import manage  # noqa: E402

ADJACENT = "10.0.0.149"  # a LAN peer — private-tier, but NOT the host
TAILNET = "100.100.7.42"  # a tailnet peer — the sharp edge the report names


class BootstrapTakeoverTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.mkdtemp(prefix="zimi-bootstrap-")
        server.ZIM_DIR = self._dir
        server.ZIMI_DATA_DIR = os.path.join(self._dir, ".zimi")
        os.makedirs(server.ZIMI_DATA_DIR, exist_ok=True)
        # A truly default instance: no password, no key yet.
        os.environ.pop("ZIMI_MANAGE_PASSWORD", None)
        manage._env_pw_hash_cache = None
        server.load_cache()
        self._srv = ThreadingHTTPServer(("127.0.0.1", 0), zhttp.ZimHandler)
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()
        self._base = f"http://127.0.0.1:{self._srv.server_address[1]}"
        self._real_client_ip = zhttp.ZimHandler._client_ip

    def _as_peer(self, ip):
        """Make every request for the rest of this test appear to come from
        ``ip`` — a real non-loopback peer, which a forwarded header cannot
        fake past the anti-spoof rule."""
        zhttp.ZimHandler._client_ip = lambda _self, _ip=ip: _ip

    def tearDown(self):
        zhttp.ZimHandler._client_ip = self._real_client_ip
        self._srv.shutdown()
        manage._env_pw_hash_cache = None
        import shutil

        shutil.rmtree(self._dir, ignore_errors=True)

    def _post(self, path, body, headers=None):
        req = urllib.request.Request(
            f"{self._base}{path}",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", **(headers or {})},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read() or "{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or "{}")

    def _get(self, path, headers=None):
        req = urllib.request.Request(f"{self._base}{path}", headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read() or "{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or "{}")

    # ── the attack, now refused ──────────────────────────────────────────────

    def test_adjacent_client_cannot_claim_the_first_password(self):
        """The advisory's PoC, step for step, from a LAN address."""
        self._as_peer(ADJACENT)
        # Step 1: the manage surface refuses this client and asks for the key,
        # not a password (which does not exist yet).
        status, body = self._get("/manage/status")
        self.assertEqual(status, 403, body)
        self.assertTrue(body.get("needs_setup_key"), body)
        # Step 2: the takeover call itself — set-password with no key — fails.
        status, body = self._post("/manage/set-password", {"password": "attacker-pw"})
        self.assertEqual(status, 403, body)
        # Step 3: and the owner is NOT locked out — no password was set, so a
        # local bootstrap still works (proven below).
        self.assertFalse(manage._get_manage_password_hash())

    def test_a_tailnet_peer_is_remote_too(self):
        """100.64/10 was the report's sharpest example: a mesh-VPN peer is not
        the living room. It gets the same locked answer as the LAN."""
        self._as_peer(TAILNET)
        status, body = self._post("/manage/set-password", {"password": "attacker-pw"})
        self.assertEqual(status, 403, body)

    def test_a_wrong_key_is_no_key(self):
        self._as_peer(ADJACENT)
        status, body = self._post(
            "/manage/set-password",
            {"password": "attacker-pw"},
            headers={"X-Zimi-Setup-Key": "WRONG-0000-0000"},
        )
        self.assertEqual(status, 403, body)

    # ── the two doors that still open ────────────────────────────────────────

    def test_the_host_itself_bootstraps_freely(self):
        """Loopback needs no secret — being on the machine is the proof."""
        status, body = self._post("/manage/set-password", {"password": "owner-pw"})
        self.assertEqual(status, 200, body)
        self.assertTrue(manage._get_manage_password_hash())

    def test_a_remote_client_with_the_key_bootstraps_and_spends_it(self):
        key = manage.ensure_setup_key()
        self.assertTrue(key)
        self._as_peer(ADJACENT)
        hdr = {"X-Zimi-Setup-Key": key}
        status, body = self._post(
            "/manage/set-password", {"password": "owner-pw"}, headers=hdr
        )
        self.assertEqual(status, 200, body)
        # The key is spent the instant the password exists: a second remote
        # attempt with the same key is now just an unauthorized request.
        status, body = self._post(
            "/manage/set-password", {"password": "someone-else"}, headers=hdr
        )
        self.assertEqual(status, 401, body)


if __name__ == "__main__":
    unittest.main()
