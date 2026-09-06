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
        self._real_socket_peer_ip = zhttp.ZimHandler._socket_peer_ip

    def _as_peer(self, ip):
        """Make every request for the rest of this test appear to come from
        ``ip`` — a real non-loopback peer, which a forwarded header cannot
        fake past the anti-spoof rule.

        The SOCKET moves too, not just the resolved client IP. Stubbing
        _client_ip alone left the connection genuinely on loopback, so these
        tests were modelling a remote attacker who, to the code that decides
        who counts as the host, was sitting at the machine. That is the gap
        the same-host reverse proxy fell through."""
        zhttp.ZimHandler._client_ip = lambda _self, _ip=ip: _ip
        zhttp.ZimHandler._socket_peer_ip = lambda _self, _ip=ip: _ip

    def tearDown(self):
        zhttp.ZimHandler._client_ip = self._real_client_ip
        zhttp.ZimHandler._socket_peer_ip = self._real_socket_peer_ip
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

    def test_a_same_host_reverse_proxy_does_not_make_everyone_the_host(self):
        """The advisory's fix, reopened by the commonest deployment there is.

        These tests replace _client_ip wholesale, so until this one nothing
        ever executed the function that decides who counts as the host. In
        production a reverse proxy on the SAME machine — Synology, nginx in
        front of 8899, the usual NAS shape — connects from 127.0.0.1 and puts
        the real client in X-Forwarded-For. _client_ip refuses to let that
        header claim a trusted-tier address, so it falls back to the direct
        peer, which is loopback: every remote client behind that proxy became
        the host and skipped the setup key.

        So this test does NOT stub the peer. The socket really is loopback,
        exactly as it is in that deployment, and the forwarded header is the
        only thing distinguishing it from the owner sitting at the machine.
        """
        for header in ("X-Forwarded-For", "X-Real-IP", "CF-Connecting-IP"):
            with self.subTest(header=header):
                status, body = self._post(
                    "/manage/set-password",
                    {"password": "attacker-owns-it"},
                    headers={header: "192.168.1.50"},
                )
                self.assertEqual(status, 403, body)
                self.assertFalse(
                    manage._get_manage_password_hash(),
                    f"a client forwarded by {header} claimed the first password",
                )

    def test_the_lan_can_be_trusted_but_only_on_purpose(self):
        """Issue #59: 1.9.0 removed a way people actually run Zimi.

        Before the advisory, a passwordless instance treated any private
        client as admin, and plenty of single-household servers depended on
        that: no password, LAN only, done. The fix was right and the
        replacement was missing, so those users found Settings simply shut.

        The opt-in has to be typed by whoever runs the server, and with it off
        — the default, and what every other test here exercises — the LAN is
        still refused."""
        self._as_peer(ADJACENT)
        status, _ = self._post("/manage/set-password", {"password": "nope"})
        self.assertEqual(status, 403, "the default must still refuse the LAN")

        os.environ["ZIMI_LAN_ADMIN"] = "1"
        try:
            status, body = self._get("/manage/stats")
            self.assertEqual(status, 200, body)
        finally:
            os.environ.pop("ZIMI_LAN_ADMIN", None)

        status, _ = self._get("/manage/stats")
        self.assertEqual(status, 403, "switching it back off must shut the door")

    def test_lan_admin_does_not_hand_the_internet_the_keys(self):
        """The escalation `lan_admin` would otherwise carry.

        Behind a reverse proxy on the same host, _client_ip cannot identify
        the caller: it refuses the forwarded address as a trusted-tier claim
        and falls back to the hop, which is loopback. Every client of that
        proxy therefore resolves as "private" — including one on the far side
        of the internet. Left at `_is_private_client`, turning on lan_admin
        would have made all of them the admin of a passwordless server.
        """
        os.environ["ZIMI_LAN_ADMIN"] = "1"
        try:
            status, body = self._post(
                "/manage/set-password",
                {"password": "attacker-owns-it"},
                headers={"X-Forwarded-For": "8.8.8.8"},
            )
            self.assertEqual(status, 403, body)
            self.assertFalse(
                manage._get_manage_password_hash(),
                "lan_admin let a forwarded client claim the first password",
            )
            # And a genuinely direct private peer still gets in, which is the
            # entire point of the setting.
            self._as_peer(ADJACENT)
            status, body = self._get("/manage/stats")
            self.assertEqual(status, 200, body)
        finally:
            os.environ.pop("ZIMI_LAN_ADMIN", None)

    def test_manage_open_asks_nobody_for_anything(self):
        """The opt out, and the reason it does not reason about the network.

        Every other answer Zimi gives to "I do not want a password" asks where
        the request came from, and that question has now been got wrong twice
        in two days: a LAN rule cannot see a client behind a reverse proxy, and
        a proxy rule cannot tell that client from the internet. This one asks
        nothing, so a forwarded request, a WAN address and the host itself all
        get the same answer.
        """
        os.environ["ZIMI_MANAGE_OPEN"] = "1"
        try:
            # From the far side of the internet, forwarded, no credential.
            status, body = self._get(
                "/manage/stats", headers={"X-Forwarded-For": "8.8.8.8"}
            )
            self.assertEqual(status, 200, body)
            # And a genuinely remote peer, no headers at all.
            self._as_peer(ADJACENT)
            status, body = self._get("/manage/stats")
            self.assertEqual(status, 200, body)
        finally:
            os.environ.pop("ZIMI_MANAGE_OPEN", None)

        # Off again, and the door shuts on the same client.
        status, _ = self._get("/manage/stats")
        self.assertEqual(status, 403)

    def test_manage_open_is_off_unless_it_is_asked_for(self):
        """It cannot be arrived at by accident: no value but an explicit
        affirmative turns it on."""
        from zimi import manage as _m

        for value in ("", "0", "false", "no", "off", "maybe"):
            os.environ["ZIMI_MANAGE_OPEN"] = value
            self.assertFalse(_m.manage_open(), f"{value!r} should not open it")
        os.environ.pop("ZIMI_MANAGE_OPEN", None)
        self.assertFalse(_m.manage_open(), "unset must be closed")

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
