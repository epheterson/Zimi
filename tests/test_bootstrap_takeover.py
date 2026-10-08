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

ADJACENT = "192.0.2.149"  # a LAN peer — private-tier, but NOT the host
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

    def test_a_peer_is_told_whether_a_setup_key_exists(self):
        """The desktop app never issues a key (only `zimi serve` prints one).
        A key field for a key that does not exist is a dead end, so the page
        is told, and sends the visitor to the host instead."""
        self._as_peer(ADJACENT)
        status, body = self._get("/manage/status")
        self.assertEqual(status, 403, body)
        self.assertIs(body.get("setup_key_issued"), False, body)
        manage.ensure_setup_key()
        status, body = self._get("/manage/status")
        self.assertIs(body.get("setup_key_issued"), True, body)

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


class FirstRunLanTests(unittest.TestCase):
    """Since 1.13.1 a fresh install does nothing until its setup page is
    answered, so the advisory's long-open door is only open between first
    start and the owner's first visit. While the page is up, the owner's own
    home network answers it without the key, as in every other self-hosted
    app. Docker bridges, tailnets, proxied requests and installs that ran
    before the page existed still need the key."""

    setUp = BootstrapTakeoverTests.setUp
    _as_peer = BootstrapTakeoverTests._as_peer
    _post = BootstrapTakeoverTests._post
    _get = BootstrapTakeoverTests._get

    def tearDown(self):
        manage._setup_gate = False
        BootstrapTakeoverTests.tearDown(self)

    # The setup page's answer: a password, kept inside the network.
    ANSWER = {"require_password": True, "external": False, "password": "owner-pw-123"}

    def _claim(self, ip, gate=True, headers=None, started_ago=60):
        manage._setup_gate = gate
        manage._write_app_update_prefs(setup_started=__import__("time").time() - started_ago)
        self._as_peer(ip)
        return self._post("/manage/access", self.ANSWER, headers=headers)

    def test_the_home_network_answers_a_fresh_setup_page_without_the_key(self):
        for ip in ("192.168.1.20", "10.0.0.31", "fd12:3456::7"):
            with self.subTest(ip=ip):
                manage._setup_gate = True
                manage._write_app_update_prefs(setup_started=__import__("time").time())
                self._as_peer(ip)
                status, body = self._get("/manage/has-password")
                self.assertTrue(body.get("keyless"), body)
        status, body = self._claim("192.168.1.20")
        self.assertEqual(status, 200, body)
        self.assertTrue(manage._get_manage_password_hash())

    def test_a_docker_bridge_or_a_tailnet_still_needs_the_key(self):
        for ip in ("172.17.0.5", TAILNET, "169.254.3.4", "fd7a:115c:a1e0::12"):
            with self.subTest(ip=ip):
                status, body = self._claim(ip)
                self.assertEqual(status, 403, body)
                self.assertFalse(manage._get_manage_password_hash())

    def test_an_install_without_the_page_still_needs_the_key_from_the_lan(self):
        """An install that ran before 1.13.1 never shows the page: unclaimed
        for months is the advisory's case, and its LAN still needs the key."""
        status, body = self._claim("192.168.1.20", gate=False)
        self.assertEqual(status, 403, body)
        self.assertFalse(manage._get_manage_password_hash())

    def test_a_proxied_request_is_not_the_home_network(self):
        for headers in ({"X-Forwarded-For": "203.0.113.9"}, {"Via": "1.1 nginx"},
                        {"X-Forwarded-Proto": "https"}, {"CF-Ray": "8a1b"}):
            with self.subTest(headers=headers):
                status, body = self._claim("192.168.1.20", headers=headers)
                self.assertEqual(status, 403, body)
                self.assertFalse(manage._get_manage_password_hash())

    def test_after_the_first_hour_the_home_network_needs_the_key(self):
        """A proxy that adds no header makes the internet look like the LAN;
        the window bounds what that can cost."""
        status, body = self._claim("192.168.1.20", started_ago=manage.FIRST_RUN_LAN_SECONDS + 5)
        self.assertEqual(status, 403, body)
        self.assertFalse(manage._get_manage_password_hash())

    def test_after_the_first_hour_the_host_needs_the_key_too(self):
        """A proxy on the same host that adds no header makes the internet
        look like loopback; past the hour, the host reads the key from the log."""
        status, body = self._claim("127.0.0.1", started_ago=manage.FIRST_RUN_LAN_SECONDS + 5)
        self.assertEqual(status, 403, body)
        self.assertFalse(manage._get_manage_password_hash())
        status, body = self._claim("127.0.0.1")
        self.assertEqual(status, 200, body)

    def test_under_kubernetes_no_network_is_the_home_network(self):
        """A NodePort can hand the internet a 10.x node address."""
        os.environ["KUBERNETES_SERVICE_HOST"] = "10.96.0.1"
        try:
            status, body = self._claim("10.0.0.31")
            self.assertEqual(status, 403, body)
        finally:
            del os.environ["KUBERNETES_SERVICE_HOST"]

    def test_the_servers_own_container_network_is_not_the_home_network(self):
        """Docker Desktop hands compose networks 192.168.x: a neighbour there
        is the advisory's attacker in a home-looking range."""
        from zimi import netguard
        import ipaddress as ipa

        real = netguard._own_networks
        netguard._own_networks = (ipa.ip_network("192.168.61.0/24"),)
        try:
            status, body = self._claim("192.168.61.7")
            self.assertEqual(status, 403, body)
            self.assertFalse(manage._get_manage_password_hash())
        finally:
            netguard._own_networks = real


class OwnNetworksTests(unittest.TestCase):
    """Which subnets a neighbouring container comes from."""

    def setUp(self):
        import ipaddress as ipa
        from zimi import netguard

        self.ng, self.net = netguard, ipa.ip_network
        self.lan = ("eth0", self.net("192.168.1.0/24"))
        self.bridge = ("docker0", self.net("172.17.0.0/16"))
        self.compose = ("br-1a2b", self.net("192.168.61.0/24"))

    def test_a_bridge_network_container_distrusts_every_subnet_it_is_on(self):
        nets = self.ng.own_networks(routes=[("eth0", self.net("192.168.61.0/24"))], addrs=[], in_container=True)
        self.assertEqual(nets, (self.net("192.168.61.0/24"),))

    def test_a_host_network_container_distrusts_only_the_bridges(self):
        nets = self.ng.own_networks(routes=[self.lan, self.bridge, self.compose], addrs=[], in_container=True)
        self.assertNotIn(self.lan[1], nets)
        self.assertIn(self.compose[1], nets)

    def test_every_kind_of_virtual_bridge_counts(self):
        libvirt = ("virbr0", self.net("192.168.122.0/24"))
        nets = self.ng.own_networks(routes=[self.lan, libvirt], addrs=[], in_container=False)
        self.assertEqual(nets, (libvirt[1],))

    def test_a_bare_host_keeps_its_lan(self):
        self.assertEqual(self.ng.own_networks(routes=[self.lan], addrs=[], in_container=False), ())

    def test_proc_net_route_is_read_little_endian(self):
        import tempfile

        with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8") as fh:
            fh.write("Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n")
            fh.write("eth0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\n")
            fh.write("eth0\t0001A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\n")
        self.assertEqual(self.ng._ipv4_routes(fh.name), [("eth0", self.net("192.168.1.0/24"))])
        os.remove(fh.name)


if __name__ == "__main__":
    unittest.main()
