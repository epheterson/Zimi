"""Trusted-header SSO (Cloudflare Access) — verification and the trust gate.

This is auth code that accepts a token from a request, so the tests are written
as a threat matrix rather than a feature list. Every case below is something an
attacker (or a broken deployment) actually does:

- a signature forged with the wrong key, or tampered with after signing
- an expired token, a not-yet-valid one, one issued in the future
- a token for a different Access application (aud) or a different team (iss)
- ``alg: none`` and an HS256 downgrade, the two classic JWT verifier breaks
- a key id that is not in the published JWKS, and a JWKS that cannot be fetched
- a header sent to an instance where SSO is not configured
- a header sent by a client that is not the proxy
- an SSO claim whose name collides with an existing local-password account

Real RS256 vectors are used throughout: the keypair below is fixed so the tests
neither generate keys nor depend on a crypto library, and signing (the half Zimi
does NOT implement) is done here with the same modular exponentiation. When
``cryptography`` happens to be installed, one extra test cross-checks Zimi's
verifier against it.
"""

import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from typing import Any, cast

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as _srv  # noqa: E402
from zimi import http as _http  # noqa: E402
from zimi import manage, sso, users  # noqa: E402

# A fixed 2048-bit RSA keypair, and a second one to forge with. Test material
# only — nothing signs with these outside this file.
_TEST_N = 18929451221437715798204091416013888322140397243059770352516852810208483320468616957541409863073078091282359967005540467932934446699115677609396149354367094655366037960904215145286510872728657271926555413167541803456069645376446843935936194590976916582138638664926350541020775772617211557638237721002157629824171170640340512437652173991686968923052524731733101035717645889936582751881584208493034883686474733728806941876488376959723719946289947202772351622188936454703248395272289287344404333891701096304677018912009638507885358083049629822748227795547462779449946012608349626283181885525941016551232652985589938252881
_TEST_D = 831896095736416494267271169365233898649892947895376890056618738049276999407505606612226945195756754442656978983431102090801227228912466812050126536645502445792403532870454201254497953806307699762889167175153704282884323719808092909493653403743107189973953173445514909388030237694223702965618368394032597364813626624481989433357178870559627716275998863995369818211581777404363075959394837337553619555065235843897419578951786829851399975677677178521781568793582533459494422355245175140111103172093324873960510957867594173295342427787716343677874292367082057205386905770455116485909179293133229981637815387157489492895
_OTHER_N = 21278023896954439054208925312105740788552411746576352736659989364354023563531084102673652699195543980842077963337179683056502106633538273470081436790254559512068930668124565622196751448607201372409306281580594194368227465992822253460942107938322728467062605508106213113307427576479332010466141022141195372535157343458715648424008403348865028853296318388550374441130233613552351680061757986380637616105404617969407653839080374130664589910220437836134097859193755267891092493087195113843691559398286305289462789997815658188049251278198926096528386019042955709980526934776413592922293691289742206118677927272403558681803
_OTHER_D = 2192996512076823147102464043526835621958241377271617171365334058036364987104547165288450602815452367648775738946869404599007331419751198073663198876966819082720746939863701092438286123252778455985758568120849649600381348231510717777773371806298745280235201014762705288216351367400546989711057105666306119349172705997377981011473528827321847686320522939854353395961344433974116783916490428492067115326857744010752806552915595947150669605643241921817738577120260139998215564989380568008657121953308672701915565402551679236372181002019312062246960234379728825169600826032384013439423447137578727396892131721368951735661
_E = 65537

_TEAM = "testteam.cloudflareaccess.com"
_ISS = "https://" + _TEAM
_AUD = "8f1b2c3d4e5f60718293a4b5c6d7e8f900112233445566778899aabbccddeeff"
_OTHER_AUD = "00000000000000000000000000000000000000000000000000000000deadbeef"
_KID = "test-key-1"
_EMAIL = "eric@zosia.io"

#: Sentinel for "remove this claim entirely" in the token builder.
_ABSENT = object()


def _b64u(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64u_json(doc):
    return _b64u(json.dumps(doc, separators=(",", ":")).encode("utf-8"))


def _b64u_int(value):
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return _b64u(raw)


def _pkcs1_sign(n, d, signing_input):
    """RSASSA-PKCS1-v1_5 SHA-256 signing — the half Zimi deliberately lacks."""
    k = (n.bit_length() + 7) // 8
    digest_info = sso._SHA256_DIGEST_INFO + hashlib.sha256(signing_input).digest()
    em = b"\x00\x01" + b"\xff" * (k - len(digest_info) - 3) + b"\x00" + digest_info
    return pow(int.from_bytes(em, "big"), d, n).to_bytes(k, "big")


def make_token(header=None, claims=None, key=(_TEST_N, _TEST_D), signature=None):
    """Build a JWT. ``header``/``claims`` override the valid defaults; a value of
    ``_ABSENT`` drops the claim. ``signature`` substitutes raw signature bytes."""
    now = int(time.time())
    hdr = {"alg": "RS256", "kid": _KID, "typ": "JWT"}
    body = {
        "iss": _ISS,
        "aud": _AUD,
        "exp": now + 300,
        "iat": now - 5,
        "sub": "cf-sub-1",
        "email": _EMAIL,
    }
    for target, overrides in ((hdr, header), (body, claims)):
        for k, v in (overrides or {}).items():
            if v is _ABSENT:
                target.pop(k, None)
            else:
                target[k] = v
    signing_input = (_b64u_json(hdr) + "." + _b64u_json(body)).encode("ascii")
    sig = (
        signature
        if signature is not None
        else _pkcs1_sign(key[0], key[1], signing_input)
    )
    return signing_input.decode("ascii") + "." + _b64u(sig)


def jwks_doc(kid=_KID, n=_TEST_N, e=_E):
    return {
        "keys": [
            {
                "kid": kid,
                "kty": "RSA",
                "alg": "RS256",
                "use": "sig",
                "n": _b64u_int(n),
                "e": _b64u_int(e),
            }
        ]
    }


class _Handler:
    """ZimHandler stand-in: headers, socket peer, and captured JSON replies."""

    def __init__(self, token=None, peer="127.0.0.1", headers=None):
        self.headers = dict(headers or {})
        if token is not None:
            self.headers[sso.SSO_HEADER] = token
        self.client_address = (peer, 43210)
        self.responses = []

    def _json(self, code, data):
        self.responses.append((code, data))
        return None

    def _is_private_client(self):
        return True

    def _client_ip(self):
        return self.client_address[0]


def record(name):
    """The stored record for ``name``, asserted present — every caller here has
    just created or resolved it."""
    rec = users.get_user(name)
    assert rec is not None, "expected a stored record for %r" % name
    return rec


def sso_block(handler):
    """Run the real handler gate against a stand-in request object."""
    return _http.ZimHandler._sso_block(cast(Any, handler))


class _SSOBase(unittest.TestCase):
    """Configured-and-reachable SSO, with the certs fetch stubbed."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._orig_data_dir = _srv.ZIMI_DATA_DIR
        _srv.ZIMI_DATA_DIR = self._tmp
        self._orig_env = {
            k: os.environ.get(k)
            for k in (
                "ZIMI_SSO_TEAM",
                "ZIMI_SSO_AUD",
                "ZIMI_SSO_ROLE",
                "ZIMI_SSO_PROXY",
                "ZIMI_OFFLINE",
            )
        }
        os.environ["ZIMI_SSO_TEAM"] = _TEAM
        os.environ["ZIMI_SSO_AUD"] = _AUD
        for k in ("ZIMI_SSO_ROLE", "ZIMI_SSO_PROXY", "ZIMI_OFFLINE"):
            os.environ.pop(k, None)
        self.fetches = []
        self.jwks = jwks_doc()
        self._orig_fetch = sso._fetch_jwks
        sso._fetch_jwks = self._fake_fetch
        sso.reset_caches()

    def tearDown(self):
        sso._fetch_jwks = self._orig_fetch
        sso.reset_caches()
        for k, v in self._orig_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        _srv.ZIMI_DATA_DIR = self._orig_data_dir
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _fake_fetch(self, url):
        self.fetches.append(url)
        return self.jwks

    def resolve(self, token=None, peer="127.0.0.1", headers=None):
        return sso.resolve(_Handler(token, peer, headers))

    def assertRejected(self, token, expect=None):
        name, reason = self.resolve(token)
        self.assertIsNone(name)
        self.assertIsNotNone(reason, "token was accepted but must not be")
        if expect:
            self.assertEqual(reason, expect)
        return reason


# ============================================================================
# The happy path — what everything else is a deviation from
# ============================================================================


class TestValidToken(_SSOBase):
    def test_a_valid_token_signs_the_user_in(self):
        name, reason = self.resolve(make_token())
        self.assertIsNone(reason)
        self.assertEqual(name, "eric")
        rec = record("eric")
        self.assertEqual(rec["role"], "user")
        self.assertIsNone(rec["pw"], "a federated account must carry no password")
        self.assertEqual(rec["flags"]["sso"]["email"], _EMAIL)
        self.assertEqual(rec["flags"]["sso"]["iss"], _ISS)

    def test_the_account_is_created_once_and_reused(self):
        self.resolve(make_token())
        created = record("eric")["created"]
        sso.reset_caches()
        name, _ = self.resolve(make_token(claims={"sub": "cf-sub-1"}))
        self.assertEqual(name, "eric")
        self.assertEqual(len(users.list_users()), 1)
        self.assertEqual(record("eric")["created"], created)

    def test_the_default_role_is_configurable(self):
        os.environ["ZIMI_SSO_ROLE"] = "admin"
        name, _ = self.resolve(make_token())
        self.assertTrue(users.is_admin_user(name))
        self.assertEqual(
            manage._secondary_admin_authorized(_Handler(make_token())),
            True,
            "an SSO account mapped to admin is a SECONDARY admin",
        )

    def test_a_limited_default_role_starts_with_an_empty_shelf(self):
        os.environ["ZIMI_SSO_ROLE"] = "limited"
        handler = _Handler(make_token())
        self.assertEqual(users.request_allow(handler), set())

    def test_an_all_access_role_resolves_to_the_whole_library(self):
        self.assertIsNone(users.request_allow(_Handler(make_token())))

    def test_the_listing_reports_how_the_account_authenticates(self):
        self.resolve(make_token())
        users.create_user("Local", "pw123")
        listed = {u["name"]: u["auth"] for u in users.list_users()}
        self.assertEqual(listed, {"eric": "sso", "Local": "local"})

    def test_a_federated_account_cannot_be_password_logged_in(self):
        """No password is stored, so the password path must refuse outright
        rather than let a hash comparison decide what ``None`` means."""
        self.resolve(make_token())
        for candidate in ("", "None", "null", "pw123"):
            self.assertIsNone(users.authenticate("eric", candidate))

    def test_the_identity_is_verified_once_per_request(self):
        """Keep-alive reuses the handler, so the memo must be cleared per
        request — and used within one."""
        handler = _Handler(make_token())
        self.assertEqual(sso.resolve(handler), sso.resolve(handler))
        sso.clear_request_cache(handler)
        handler.headers[sso.SSO_HEADER] = make_token(claims={"exp": 1})
        self.assertIsNotNone(sso.resolve(handler)[1])


# ============================================================================
# Threat matrix — signature and algorithm
# ============================================================================


class TestSignatureThreats(_SSOBase):
    def test_a_signature_from_another_key_is_rejected(self):
        self.assertRejected(make_token(key=(_OTHER_N, _OTHER_D)), "signature")

    def test_a_tampered_payload_is_rejected(self):
        """The exact attack the whole module exists for: keep the signature,
        rewrite the claims."""
        header, payload, signature = make_token().split(".")
        forged = json.loads(base64.urlsafe_b64decode(payload + "=="))
        forged["email"] = "attacker@evil.example"
        tampered = header + "." + _b64u_json(forged) + "." + signature
        self.assertRejected(tampered, "signature")
        self.assertEqual(users.list_users(), [])

    def test_alg_none_is_rejected(self):
        # The usual spelling carries an empty signature segment, which this
        # rejects as malformed before the algorithm is even read; the variant
        # with junk bytes exercises the algorithm pin itself.
        self.assertRejected(make_token(header={"alg": "none"}, signature=b""))
        self.assertRejected(
            make_token(header={"alg": "none"}, signature=b"\x00"), "alg:none"
        )

    def test_an_hs256_downgrade_is_rejected(self):
        """The public JWKS key as an HMAC secret would let anyone mint tokens."""
        now = int(time.time())
        hdr = _b64u_json({"alg": "HS256", "kid": _KID, "typ": "JWT"})
        body = _b64u_json(
            {"iss": _ISS, "aud": _AUD, "exp": now + 300, "iat": now, "email": _EMAIL}
        )
        import hmac as _hmac

        key = _TEST_N.to_bytes(256, "big")
        mac = _hmac.new(key, (hdr + "." + body).encode(), hashlib.sha256).digest()
        self.assertRejected(hdr + "." + body + "." + _b64u(mac), "alg:HS256")

    def test_other_rsa_and_ec_algorithms_are_rejected(self):
        for alg in ("RS512", "PS256", "ES256", "rs256", ""):
            self.assertRejected(make_token(header={"alg": alg}), "alg:%s" % alg)

    def test_a_missing_or_wrong_key_id_is_rejected(self):
        self.assertRejected(make_token(header={"kid": _ABSENT}), "kid-missing")
        self.assertRejected(make_token(header={"kid": "rotated-away"}), "kid-unknown")

    def test_a_non_jwt_typ_is_rejected(self):
        self.assertRejected(make_token(header={"typ": "JWE"}), "typ")

    def test_a_wrong_length_signature_is_rejected(self):
        self.assertRejected(make_token(signature=b"\x00" * 100), "signature")

    def test_a_signature_larger_than_the_modulus_is_rejected(self):
        self.assertRejected(make_token(signature=b"\xff" * 256), "signature")

    def test_malformed_tokens_are_rejected(self):
        for bad in (
            "",
            "not-a-jwt",
            "a.b",
            "a.b.c.d.e",
            "!!!." + _b64u_json({}) + ".sig",
            _b64u_json({"alg": "RS256"}) + ".!!!.sig",
            _b64u_json([1, 2]) + "." + _b64u_json({}) + ".sig",
            "  ",
            "x" * 9000,
            # Outside the base64url alphabet. Base64 decoding SKIPS characters
            # it does not recognise rather than refusing them, so a token has to
            # be rejected on its charset before it is ever decoded.
            "héader.payload.sig",
            _b64u_json({"alg": "RS256"}) + "+x." + _b64u_json({}) + ".sig",
            "YWJj==." + _b64u_json({}) + ".sig",
            "\x00.\x00.\x00",
        ):
            name, reason = self.resolve(bad)
            self.assertIsNone(name, "accepted %r" % bad[:40])
            if bad.strip():
                self.assertIsNotNone(reason, "did not reject %r" % bad[:40])

    def test_the_verifier_agrees_with_a_real_crypto_library(self):
        try:
            from cryptography.hazmat.primitives import hashes
            from cryptography.hazmat.primitives.asymmetric import padding, rsa
        except ImportError:
            self.skipTest("cryptography not installed")
        key = rsa.generate_private_key(public_exponent=_E, key_size=2048)
        numbers = key.private_numbers().public_numbers
        message = b"header.payload"
        signature = key.sign(message, padding.PKCS1v15(), hashes.SHA256())
        self.assertTrue(
            sso._rsa_verify_pkcs1_v15_sha256(numbers.n, numbers.e, signature, message)
        )
        self.assertFalse(
            sso._rsa_verify_pkcs1_v15_sha256(
                numbers.n, numbers.e, signature, b"header.payload2"
            )
        )


# ============================================================================
# Threat matrix — claims
# ============================================================================


class TestClaimThreats(_SSOBase):
    def test_an_expired_token_is_rejected(self):
        now = int(time.time())
        self.assertRejected(make_token(claims={"exp": now - 3600}), "exp")

    def test_a_missing_expiry_is_rejected(self):
        self.assertRejected(make_token(claims={"exp": _ABSENT}), "exp")

    def test_an_infinite_expiry_is_rejected(self):
        """``json.loads`` accepts ``Infinity`` by default, so a token can ask to
        never expire."""
        raw = '{"iss":"%s","aud":"%s","exp":Infinity,"iat":0,"email":"%s"}' % (
            _ISS,
            _AUD,
            _EMAIL,
        )
        header = _b64u_json({"alg": "RS256", "kid": _KID, "typ": "JWT"})
        payload = _b64u(raw.encode())
        signing_input = (header + "." + payload).encode("ascii")
        signature = _pkcs1_sign(_TEST_N, _TEST_D, signing_input)
        self.assertRejected(header + "." + payload + "." + _b64u(signature), "exp")

    def test_a_string_expiry_is_rejected(self):
        """A numeric date is a number; coercing a string here would accept a
        token that a strict verifier refuses."""
        self.assertRejected(make_token(claims={"exp": "99999999999"}), "exp")

    def test_a_token_issued_in_the_future_is_rejected(self):
        now = int(time.time())
        self.assertRejected(make_token(claims={"iat": now + 3600}), "iat")

    def test_a_not_yet_valid_token_is_rejected(self):
        now = int(time.time())
        self.assertRejected(make_token(claims={"nbf": now + 3600}), "nbf")

    def test_small_clock_skew_is_tolerated(self):
        now = int(time.time())
        name, reason = self.resolve(make_token(claims={"exp": now - 5, "iat": now + 5}))
        self.assertIsNone(reason)
        self.assertEqual(name, "eric")

    def test_a_token_for_another_access_application_is_rejected(self):
        """Replay across applications inside the same Cloudflare account."""
        self.assertRejected(make_token(claims={"aud": _OTHER_AUD}), "aud")
        self.assertRejected(make_token(claims={"aud": [_OTHER_AUD]}), "aud")
        self.assertRejected(make_token(claims={"aud": _ABSENT}), "aud")

    def test_an_audience_list_containing_our_tag_is_accepted(self):
        name, reason = self.resolve(make_token(claims={"aud": [_OTHER_AUD, _AUD]}))
        self.assertIsNone(reason)
        self.assertEqual(name, "eric")

    def test_a_prefix_of_the_audience_is_not_a_match(self):
        self.assertRejected(make_token(claims={"aud": _AUD[:-1]}), "aud")

    def test_a_token_from_another_team_is_rejected(self):
        self.assertRejected(
            make_token(claims={"iss": "https://evil.cloudflareaccess.com"}), "iss"
        )

    def test_a_token_with_no_usable_identity_is_rejected(self):
        for claims in (
            {"email": _ABSENT},
            {"email": ""},
            {"email": "not-an-email"},
            {"email": 42},
            {"email": _ABSENT, "common_name": "service-token"},
        ):
            self.assertRejected(make_token(claims=claims), "no-identity")
        self.assertEqual(users.list_users(), [])


# ============================================================================
# Threat matrix — trust gating
# ============================================================================


class TestTrustGate(_SSOBase):
    def test_an_unconfigured_instance_ignores_the_header(self):
        """The bypass this gate exists to prevent: anyone can send a header."""
        for missing in ("ZIMI_SSO_TEAM", "ZIMI_SSO_AUD"):
            with self.subTest(missing=missing):
                original = os.environ.pop(missing)
                sso.reset_caches()
                try:
                    self.assertFalse(sso.is_configured())
                    self.assertEqual(self.resolve(make_token()), (None, None))
                    self.assertEqual(users.list_users(), [])
                finally:
                    os.environ[missing] = original

    def test_an_http_team_url_disables_sso(self):
        os.environ["ZIMI_SSO_TEAM"] = "http://testteam.cloudflareaccess.com"
        self.assertFalse(sso.is_configured())
        self.assertEqual(self.resolve(make_token()), (None, None))

    def test_a_header_from_a_public_peer_is_ignored(self):
        # 9.9.9.9, not a documentation range: current Python reports TEST-NET
        # addresses as private, which would make this test pass for the wrong
        # reason.
        self.assertEqual(self.resolve(make_token(), peer="9.9.9.9"), (None, None))
        self.assertEqual(users.list_users(), [])

    def test_an_explicit_proxy_allowlist_excludes_everyone_else(self):
        os.environ["ZIMI_SSO_PROXY"] = "10.9.0.4/32"
        self.assertEqual(self.resolve(make_token(), peer="10.9.0.5"), (None, None))
        self.assertEqual(self.resolve(make_token(), peer="127.0.0.1"), (None, None))
        name, reason = self.resolve(make_token(), peer="10.9.0.4")
        self.assertIsNone(reason)
        self.assertEqual(name, "eric")

    def test_a_dual_stack_peer_matches_an_ipv4_allowlist(self):
        """A dual-stack listener reports 10.9.0.4 as ::ffff:10.9.0.4, which no
        IPv4 CIDR contains — the operator's allowlist must still work."""
        os.environ["ZIMI_SSO_PROXY"] = "10.9.0.4/32"
        name, reason = self.resolve(make_token(), peer="::ffff:10.9.0.4")
        self.assertIsNone(reason)
        self.assertEqual(name, "eric")
        self.assertEqual(
            self.resolve(make_token(), peer="::ffff:10.9.0.5"), (None, None)
        )

    def test_forwarded_headers_cannot_manufacture_a_trusted_peer(self):
        """Trust keys off the socket peer, never a header — the same class of
        input that is on trial."""
        os.environ["ZIMI_SSO_PROXY"] = "10.9.0.4/32"
        spoof = {
            "X-Forwarded-For": "10.9.0.4",
            "CF-Connecting-IP": "10.9.0.4",
        }
        self.assertEqual(
            self.resolve(make_token(), peer="9.9.9.9", headers=spoof), (None, None)
        )

    def test_no_header_is_simply_anonymous(self):
        self.assertEqual(self.resolve(None), (None, None))
        handler = _Handler(headers={"Authorization": "Bearer whatever"})
        self.assertEqual(sso.resolve(handler), (None, None))

    def test_an_invalid_token_never_falls_through_to_another_credential(self):
        """A rejection must not be downgraded into "anonymous" — on an open
        instance that would quietly serve the library to a forged token."""
        users.create_user("Kid", "pw123", allowlist=["only-this"])
        token = users.create_session("Kid")
        handler = _Handler(
            make_token(key=(_OTHER_N, _OTHER_D)),
            headers={"Authorization": "Bearer " + token},
        )
        self.assertIsNotNone(sso.resolve(handler)[1])
        self.assertTrue(sso_block(handler))
        self.assertEqual(handler.responses[0][0], 401)

    def test_the_proxy_identity_outranks_a_session_cookie(self):
        users.create_user("Kid", "pw123", allowlist=["only-this"])
        cookie = users.create_session("Kid")
        handler = _Handler(make_token(), headers={"Cookie": "zimi_session=" + cookie})
        self.assertEqual(users.resolve_request_user(handler), "eric")


# ============================================================================
# Threat matrix — account mapping
# ============================================================================


class TestAccountMapping(_SSOBase):
    def test_an_existing_local_account_is_never_taken_over(self):
        """A claim value that happens to match a local account name must not
        sign anyone into it — the classic federation account-takeover bug.

        The SSO identity gets its own (differently named) account instead of a
        refusal: nothing is adopted, the local account is untouched, and the
        admin can see both in the user list and reconcile them.
        """
        users.create_user("eric", "localpw", role="admin")
        name, reason = self.resolve(make_token())
        self.assertIsNone(reason)
        self.assertEqual(name, "eric-zosia.io")
        listed = {u["name"]: (u["auth"], u["role"]) for u in users.list_users()}
        self.assertEqual(listed["eric"], ("local", "admin"))
        self.assertEqual(listed["eric-zosia.io"], ("sso", "user"))
        self.assertEqual(users.authenticate("eric", "localpw"), "eric")

    def test_both_candidate_names_taken_is_a_refusal_not_a_takeover(self):
        users.create_user("eric", "localpw")
        users.create_user("eric-zosia.io", "localpw")
        self.assertRejected(make_token(), "name-conflict")
        self.assertEqual(len(users.list_users()), 2)
        for name in ("eric", "eric-zosia.io"):
            self.assertIsNone(users.federated_identity(record(name)))

    def test_a_shared_local_part_falls_back_to_the_full_address(self):
        first, reason = self.resolve(make_token())
        self.assertIsNone(reason)
        self.assertEqual(first, "eric")
        sso.reset_caches()
        second, reason = self.resolve(
            make_token(claims={"email": "eric@other.example", "sub": "cf-sub-2"})
        )
        self.assertIsNone(reason)
        self.assertEqual(second, "eric-other.example")
        self.assertEqual(len(users.list_users()), 2)

    def test_a_reserved_name_falls_back_to_the_full_address(self):
        name, reason = self.resolve(
            make_token(claims={"email": "admin@corp.example", "sub": "cf-sub-3"})
        )
        self.assertIsNone(reason)
        self.assertEqual(name, "admin-corp.example")

    def test_a_changed_email_keeps_the_same_account(self):
        self.resolve(make_token())
        sso.reset_caches()
        name, reason = self.resolve(
            make_token(claims={"email": "e.pheterson@zosia.io"})
        )
        self.assertIsNone(reason)
        self.assertEqual(name, "eric", "same subject, renamed at the IdP")
        self.assertEqual(len(users.list_users()), 1)
        self.assertEqual(
            record("eric")["flags"]["sso"]["email"], "e.pheterson@zosia.io"
        )

    def test_an_admin_role_change_survives_later_logins(self):
        """The configured role is a creation default, not a per-login assertion:
        re-applying it would silently undo an admin's own change."""
        self.resolve(make_token())
        users.set_role("eric", "limited", ["wikipedia_en"])
        sso.reset_caches()
        name, _ = self.resolve(make_token())
        self.assertEqual(name, "eric")
        self.assertEqual(record("eric")["role"], "limited")
        self.assertEqual(users.request_allow(_Handler(make_token())), {"wikipedia_en"})

    def test_a_deleted_account_is_recreated_on_the_next_request(self):
        self.resolve(make_token())
        users.delete_user("eric")
        sso.reset_caches()
        name, reason = self.resolve(make_token())
        self.assertIsNone(reason)
        self.assertEqual(name, "eric")


# ============================================================================
# JWKS — rotation, unreachability, offline, persistence
# ============================================================================


class TestSigningKeys(_SSOBase):
    def test_an_unreachable_certs_endpoint_rejects_every_token(self):
        self.jwks = None
        self.assertRejected(make_token(), "no-keys")

    def test_an_unreachable_certs_endpoint_does_not_break_password_auth(self):
        """A JWKS outage must never lock an admin out of the paths that have
        nothing to do with SSO."""
        self.jwks = None
        users.create_user("Kid", "pw123")
        token = users.create_session("Kid")
        handler = _Handler(headers={"Authorization": "Bearer " + token})
        self.assertFalse(sso_block(handler))
        self.assertEqual(users.resolve_request_user(handler), "Kid")
        self.assertEqual(users.authenticate("Kid", "pw123"), "Kid")

    def test_a_garbage_certs_document_rejects_every_token(self):
        for doc in ({}, {"keys": "nope"}, {"keys": [{"kty": "EC"}]}, {"keys": [{}]}):
            sso.reset_caches()
            self.jwks = doc
            self.assertRejected(make_token(), "no-keys")

    def test_an_undersized_signing_key_is_never_used(self):
        self.assertEqual(sso._parse_jwks(jwks_doc(n=(1 << 1024) + 1)), {})
        self.assertEqual(len(sso._parse_jwks(jwks_doc())), 1)

    def test_unknown_key_ids_cannot_amplify_requests_to_the_certs_endpoint(self):
        """A token bearing an unknown key id looks exactly like a key rotation,
        so it must be able to trigger a refetch — but at most one per cooldown,
        or a flood of invented key ids turns this instance into an amplifier."""
        self.resolve(make_token())
        self.assertEqual(len(self.fetches), 1)
        for i in range(20):
            sso._token_cache.clear()
            self.assertRejected(make_token(header={"kid": "invented-%d" % i}))
        self.assertEqual(len(self.fetches), 1, "the cooldown must hold")

    def test_a_rotated_key_is_picked_up_after_the_cooldown(self):
        self.resolve(make_token())
        self.jwks = jwks_doc(kid="test-key-2")
        rotated = make_token(header={"kid": "test-key-2"})
        self.assertRejected(rotated, "kid-unknown")
        sso._token_cache.clear()
        sso._jwks_attempt.clear()  # the cooldown has elapsed
        name, reason = self.resolve(rotated)
        self.assertIsNone(reason)
        self.assertEqual(name, "eric")
        self.assertEqual(len(self.fetches), 2)

    def test_cached_keys_keep_verifying_when_a_refresh_fails(self):
        self.resolve(make_token())
        self.jwks = None
        self._age_keys(sso._JWKS_TTL_S + 60)
        sso._token_cache.clear()
        name, reason = self.resolve(make_token())
        self.assertIsNone(reason, "a failed refresh must not invalidate known keys")
        self.assertEqual(name, "eric")

    def test_cached_keys_stop_verifying_once_far_too_old(self):
        self.resolve(make_token())
        self.jwks = None
        self._age_keys(sso._JWKS_STALE_MAX_S + 60)
        sso._token_cache.clear()
        self.assertRejected(make_token(), "no-keys")

    def test_keys_survive_a_restart_on_disk(self):
        self.resolve(make_token())
        self.assertEqual(len(self.fetches), 1)
        sso.reset_caches()  # a fresh process: memory empty, disk intact
        name, reason = self.resolve(make_token())
        self.assertIsNone(reason)
        self.assertEqual(name, "eric")
        self.assertEqual(len(self.fetches), 1, "the disk copy must be reused")

    def test_offline_never_reaches_the_network(self):
        os.environ["ZIMI_OFFLINE"] = "1"
        self.assertRejected(make_token(), "no-keys")
        self.assertEqual(self.fetches, [])

    def test_offline_still_verifies_against_a_cached_copy(self):
        self.resolve(make_token())
        sso.reset_caches()
        os.environ["ZIMI_OFFLINE"] = "1"
        name, reason = self.resolve(make_token())
        self.assertIsNone(reason)
        self.assertEqual(name, "eric")
        self.assertEqual(len(self.fetches), 1)

    def _age_keys(self, seconds):
        entry = sso._jwks_cache[sso.certs_url()]
        entry["fetched"] -= seconds
        sso._jwks_attempt.clear()


# ============================================================================
# End to end through the real server
# ============================================================================


class TestThroughTheServer(_SSOBase):
    """The wiring: a real socket, real header parsing, the real do_GET path."""

    PORT = 8896

    def setUp(self):
        super().setUp()
        from http.server import ThreadingHTTPServer

        self._orig_zim_dir = _srv.ZIM_DIR
        _srv.ZIM_DIR = self._tmp
        self._server = ThreadingHTTPServer(("127.0.0.1", self.PORT), _http.ZimHandler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        self._base = "http://127.0.0.1:%d" % self.PORT

    def tearDown(self):
        self._server.shutdown()
        self._server.server_close()
        _srv.ZIM_DIR = self._orig_zim_dir
        super().tearDown()

    def _get(self, path, token=None, header_name=sso.SSO_HEADER):
        req = urllib.request.Request(self._base + path)
        if token is not None:
            req.add_header(header_name, token)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            try:
                return e.code, json.loads(body)
            except ValueError:
                return e.code, {}

    def test_a_valid_header_is_a_signed_in_user(self):
        status, body = self._get("/whoami", make_token())
        self.assertEqual(status, 200)
        self.assertEqual(body["role"], "user")
        self.assertEqual(body["name"], "eric")

    def test_the_header_name_is_matched_case_insensitively(self):
        status, body = self._get(
            "/whoami", make_token(), header_name="cf-access-jwt-assertion"
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["name"], "eric")

    def test_no_header_is_anonymous(self):
        status, body = self._get("/whoami")
        self.assertEqual(status, 200)
        self.assertEqual(body["role"], "anonymous")

    def test_a_tampered_token_gets_a_401_with_no_detail(self):
        header, payload, signature = make_token().split(".")
        forged = json.loads(base64.urlsafe_b64decode(payload + "=="))
        forged["email"] = "attacker@evil.example"
        status, body = self._get(
            "/whoami", header + "." + _b64u_json(forged) + "." + signature
        )
        self.assertEqual(status, 401)
        self.assertEqual(body, {"error": "authentication required"})
        self.assertEqual(users.list_users(), [])

    def test_an_expired_token_gets_a_401_on_a_data_endpoint(self):
        status, _ = self._get("/list", make_token(claims={"exp": 1}))
        self.assertEqual(status, 401)

    def test_an_admin_role_reaches_manage_through_the_header(self):
        os.environ["ZIMI_SSO_ROLE"] = "admin"
        status, body = self._get("/whoami", make_token())
        self.assertEqual(status, 200)
        self.assertEqual(body["role"], "admin")
        self.assertTrue(body["secondary"])


if __name__ == "__main__":
    unittest.main()
