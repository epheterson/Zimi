"""Trusted-header SSO — Cloudflare Access identity, verified in stdlib.

Cloudflare Access is not an IdP an application talks to: it authenticates at the
edge and forwards the result to the origin as an RS256-signed JWT in the
``Cf-Access-Jwt-Assertion`` header. Nothing about that token arrives over a
channel Zimi opened, so the OpenID Connect Core 3.1.3.7 rule-6 shortcut (TLS to
the token endpoint standing in for a signature check) does NOT apply here and
this module does real signature verification.

Verification is verify-only RSA, which is why it fits in the stdlib and why
hand-rolling it is defensible: PKCS#1 v1.5 verification is ``pow(sig, e, n)``
followed by comparing a deterministic encoding, there is no key material to
protect, and every value compared is public — so the timing side-channels that
make hand-rolled *signing* reckless do not exist. The protocol around it is the
part that needs care, and that is what the rest of this file is: JWKS
fetch/cache/rotation, strict ``alg`` pinning, and audience/issuer/expiry checks.

The security contract, in full:

1. **Off unless configured.** Both the team domain and the Access application
   AUD tag must be set (``ZIMI_SSO_TEAM`` + ``ZIMI_SSO_AUD``, or the matching
   config-file keys). On a bare install the header is not read at all — anyone
   can send a header, so an auto-trusting default would be a login bypass.
2. **Only from the proxy.** The header is honored only when the DIRECT socket
   peer is the tunnel. Not ``_client_ip()`` — that consults forwarded headers,
   which is the same class of input we are deciding whether to trust. Default:
   any private/loopback peer (cloudflared beside the app or in a sibling
   container); narrow it with ``ZIMI_SSO_PROXY``. A header from anywhere else is
   ignored entirely, so a forger on the LAN gets exactly the treatment they
   would have got with no header at all.
3. **Fail closed, three ways.** No header → anonymous, the normal password/token
   flow is untouched. Header from an untrusted peer → ignored. Header from the
   proxy that does not verify → 401, never a fall-through to the claimed
   identity and never a fall-through to another credential.
4. **RS256 only.** ``alg: none`` and an HS256 downgrade (which would let anyone
   who can read the public JWKS mint tokens) are rejected before any key lookup.

``ZIMI_OFFLINE`` and JWKS reachability: verification needs the team's public
certs. A cached copy is kept in memory and on disk (``<data-dir>/sso_jwks.json``)
and is honored until it expires, so a restart or a network blip does not break
logins. When a refresh cannot happen — offline, or the endpoint is down — the
cached keys keep verifying for up to ``_JWKS_STALE_MAX_S``; past that, tokens are
rejected. No failure mode here can make an invalid token valid, and none of it
touches the password/API-token paths, so an operator is never locked out of an
instance they can reach directly.
"""

import base64
import binascii
import hashlib
import hmac
import ipaddress
import json
import logging
import math
import os
import re
import threading
import time
import urllib.error
import urllib.request

import zimi.server as _srv

log = logging.getLogger("zimi")

#: The header Cloudflare Access injects on every proxied request. Matched
#: case-insensitively by the stdlib header mapping, which is what lets the same
#: name work behind proxies that normalize casing.
SSO_HEADER = "Cf-Access-Jwt-Assertion"

#: The claim carrying the identity we map onto a Zimi account. Cloudflare Access
#: always emits ``email`` for a human login. Service-token access (which carries
#: ``common_name`` and no email) is deliberately unmapped: a machine credential
#: should not silently become a user account.
IDENTITY_CLAIM = "email"

#: Only RS256. Pinned before any key is looked up so an attacker cannot pick the
#: algorithm — the classic JWT break is to hand a verifier ``none`` (no signature
#: to check) or HS256 (verified with the *public* key as an HMAC secret).
_ALLOWED_ALG = "RS256"

#: DER prefix of the EMSA-PKCS1-v1_5 DigestInfo for SHA-256 (RFC 8017 §9.2).
_SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")

#: Refuse an implausibly small signing key even if a JWKS offers one, and cap
#: the public exponent so a malformed JWKS cannot make every verification an
#: expensive modular exponentiation. Real keys use 65537.
_MIN_RSA_BITS = 2048
_MAX_RSA_EXPONENT = 1 << 64

#: An Access JWT is around a kilobyte; the cap is slack, not a fit.
_MAX_TOKEN_CHARS = 8192

#: Exactly three base64url segments. The signature segment may be empty (that is
#: how an ``alg: none`` token is spelled) so the rejection reason stays honest.
_JWT_RE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$")

#: Tolerance for clock drift between the edge and this host, applied to exp/iat/nbf.
_CLOCK_SKEW_S = 60

#: How long a token stays in the verified-token cache. Bounded well below a
#: token's own lifetime so a revocation at the edge takes effect promptly; the
#: cache exists to keep a page-load's worth of requests from each re-verifying.
_TOKEN_CACHE_TTL_S = 60
_TOKEN_CACHE_MAX = 512

#: Normal JWKS refresh interval, and the hard limit on how long a cached copy
#: may keep verifying when refreshes are failing (offline, endpoint down).
_JWKS_TTL_S = 3600
_JWKS_STALE_MAX_S = 7 * 24 * 3600
#: Floor between forced refetches, so a flood of tokens bearing unknown key ids
#: cannot turn this instance into a request amplifier against the certs endpoint.
_JWKS_REFETCH_COOLDOWN_S = 60
_JWKS_MAX_BYTES = 256 * 1024
_JWKS_TIMEOUT_S = 10

#: Repeat rejections for the same (peer, reason) log once per interval; the rest
#: go to debug. A forged-header flood must not become a disk-filling log flood.
_REJECT_LOG_INTERVAL_S = 60

#: Where a verified result is memoized for the life of one request. Keep-alive
#: reuses the handler object, so http.py clears this at the top of every request.
_REQUEST_ATTR = "_zimi_sso_result"

_lock = threading.Lock()
#: {certs_url: {"fetched": ts, "keys": {kid: (n, e)}}}
_jwks_cache = {}
#: {certs_url: ts} — last attempted fetch, successful or not.
_jwks_attempt = {}
#: {sha256(config||token): (expiry_ts, name_or_None, reason_or_None)}
_token_cache = {}
#: {(peer, reason): ts}
_reject_logged = {}


# ============================================================================
# Configuration
# ============================================================================


def _env(name):
    return (os.environ.get(name) or "").strip()


def team_base_url():
    """The Access team's base URL, or "" when SSO is not configured.

    Accepts every spelling an operator plausibly pastes: the bare team name,
    the team domain, or the full URL.
    """
    raw = _env("ZIMI_SSO_TEAM")
    if not raw:
        return ""
    raw = raw.rstrip("/")
    if raw.startswith("https://"):
        host = raw[len("https://") :]
    elif raw.startswith("http://"):
        # Refuse to derive an https issuer from an http spelling: the certs URL
        # must be TLS, and silently upgrading hides an operator's mistake.
        log.warning("SSO: ZIMI_SSO_TEAM must be https; ignoring %r", raw)
        return ""
    else:
        host = raw
    host = host.split("/")[0].strip()
    if not host:
        return ""
    if "." not in host:
        host += ".cloudflareaccess.com"
    return "https://" + host


def audience():
    return _env("ZIMI_SSO_AUD")


def default_role():
    """Role given to an account created on its first SSO login.

    A creation default, not a per-login assertion: with no group mapping in this
    phase the only source is this static value, and re-applying it on every
    login would silently undo an admin's promotion or demotion of the account.
    """
    from zimi import users as _users

    role = _env("ZIMI_SSO_ROLE").lower()
    return role if role in _users._ROLES else "user"


def _proxy_cidrs():
    """The CIDRs the header may arrive from, or None for "any private peer"."""
    raw = _env("ZIMI_SSO_PROXY")
    if not raw:
        return None
    nets = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            nets.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            log.warning("SSO: ignoring invalid ZIMI_SSO_PROXY entry %r", part)
    return nets or None


def is_configured():
    """True when both the team domain and the audience tag are set."""
    return bool(team_base_url()) and bool(audience())


def status():
    """Admin/diagnostic view of the SSO configuration (no secrets involved —
    the team domain and AUD tag are both public identifiers)."""
    base = team_base_url()
    proxies = _proxy_cidrs()
    return {
        "enabled": is_configured(),
        "provider": "cloudflare",
        "issuer": base,
        "audience_set": bool(audience()),
        "default_role": default_role(),
        "proxy_cidrs": [str(n) for n in proxies] if proxies else [],
    }


def log_boot_state():
    """One line at startup so the operator can see what is in effect."""
    if not is_configured():
        return
    if _proxy_cidrs() is None:
        log.warning(
            "SSO enabled (%s): trusting %s from ANY private-network peer. Zimi must "
            "not be reachable except through the proxy, or set ZIMI_SSO_PROXY to the "
            "proxy's address.",
            team_base_url(),
            SSO_HEADER,
        )
    else:
        log.info("SSO enabled (%s), default role %s", team_base_url(), default_role())
    if _is_offline():
        log.warning(
            "SSO: ZIMI_OFFLINE is set — signing keys cannot be refreshed; logins "
            "work only while a cached copy of the Access certs is valid."
        )


def _is_offline():
    from zimi import p2p as _p2p

    return _p2p.is_offline()


# ============================================================================
# JOSE primitives
# ============================================================================


def _b64url_decode(segment):
    """Strict base64url decode of a JWT or JWKS segment. None if malformed."""
    if not isinstance(segment, str) or not segment:
        return None
    # A JWT segment is unpadded base64url. Reject the padded and standard-base64
    # spellings rather than normalizing them: this is parsing attacker input,
    # and leniency here is how two implementations end up disagreeing about
    # what a token says.
    if any(c in segment for c in "+/= \t\r\n"):
        return None
    try:
        return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
    except (binascii.Error, ValueError):
        return None


def _b64url_uint(value):
    """Decode a JWKS base64url big-endian integer (``n``/``e``). None if bad."""
    raw = _b64url_decode(value) if isinstance(value, str) else None
    if not raw:
        return None
    return int.from_bytes(raw, "big")


def _json_segment(segment):
    raw = _b64url_decode(segment)
    if raw is None:
        return None
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    return doc if isinstance(doc, dict) else None


def _split_token(token):
    """(header, payload, signing_input, signature) or None.

    Rejects anything that is not exactly three base64url segments — including
    the JWE/nested shapes a five-segment token would carry, and anything
    outside the base64url alphabet, which base64 decoding would otherwise skip
    over rather than refuse.
    """
    if not isinstance(token, str) or len(token) > _MAX_TOKEN_CHARS:
        return None
    if not _JWT_RE.match(token):
        return None
    parts = token.split(".")
    header = _json_segment(parts[0])
    payload = _json_segment(parts[1])
    signature = _b64url_decode(parts[2])
    if header is None or payload is None or signature is None:
        return None
    signing_input = (parts[0] + "." + parts[1]).encode("ascii", "strict")
    return header, payload, signing_input, signature


def _rsa_verify_pkcs1_v15_sha256(n, e, signature, signing_input):
    """RSASSA-PKCS1-v1_5 verification with SHA-256 (RFC 8017 §8.2.2).

    Recover ``sig^e mod n``, then check it against the one encoded message that
    a valid signature over this input can produce. Everything compared is
    public, so the comparison is about correctness, not secrecy.
    """
    k = (n.bit_length() + 7) // 8
    if len(signature) != k:
        return False
    s = int.from_bytes(signature, "big")
    if s >= n:
        return False
    em = pow(s, e, n).to_bytes(k, "big")
    digest_info = _SHA256_DIGEST_INFO + hashlib.sha256(signing_input).digest()
    padding_len = k - len(digest_info) - 3
    if padding_len < 8:
        return False
    expected = b"\x00\x01" + b"\xff" * padding_len + b"\x00" + digest_info
    return hmac.compare_digest(em, expected)


# ============================================================================
# JWKS — fetch, cache (memory + disk), rotate
# ============================================================================


def certs_url():
    base = team_base_url()
    return base + "/cdn-cgi/access/certs" if base else ""


def _jwks_disk_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, "sso_jwks.json")


def _parse_jwks(doc):
    """{kid: (n, e)} for every usable RSA signing key in a JWKS document."""
    keys = {}
    if not isinstance(doc, dict):
        return keys
    entries = doc.get("keys")
    if not isinstance(entries, list):
        return keys
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("kty") != "RSA":
            continue
        if entry.get("use") not in (None, "sig"):
            continue
        if entry.get("alg") not in (None, _ALLOWED_ALG):
            continue
        kid = entry.get("kid")
        n = _b64url_uint(entry.get("n"))
        e = _b64url_uint(entry.get("e"))
        if not isinstance(kid, str) or n is None or e is None:
            continue
        if n.bit_length() < _MIN_RSA_BITS:
            continue
        if e < 3 or e > _MAX_RSA_EXPONENT or not e % 2:
            continue
        keys[kid] = (n, e)
    return keys


def _load_jwks_disk(url):
    """The persisted JWKS for ``url`` as ``(fetched_ts, keys)``, or None.

    Survives a restart, which is what keeps a rebooted air-gapped or
    intermittently-connected instance logging people in.
    """
    try:
        with open(_jwks_disk_path(), encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, ValueError, OSError):
        return None
    if not isinstance(data, dict) or data.get("version") != 1:
        return None
    entry = (data.get("sources") or {}).get(url)
    if not isinstance(entry, dict):
        return None
    try:
        fetched = int(entry.get("fetched", 0))
    except (TypeError, ValueError):
        return None
    keys = _parse_jwks(entry.get("jwks"))
    if fetched <= 0 or not keys:
        return None
    return fetched, keys


def _store_jwks_disk(url, fetched, doc):
    """Persist a fetched JWKS. Best-effort: read-only media is not an error."""
    try:
        with open(_jwks_disk_path(), encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or data.get("version") != 1:
            data = {"version": 1, "sources": {}}
    except (FileNotFoundError, ValueError, OSError):
        data = {"version": 1, "sources": {}}
    sources = data.get("sources")
    if not isinstance(sources, dict):
        sources = {}
    sources[url] = {"fetched": fetched, "jwks": doc}
    _srv._atomic_write_json(
        _jwks_disk_path(), {"version": 1, "sources": sources}, indent=2
    )


def _fetch_jwks(url):
    """GET the certs document. Returns the parsed doc, or None on any failure."""
    req = urllib.request.Request(url, headers={"User-Agent": "Zimi"})
    try:
        with urllib.request.urlopen(
            req, timeout=_JWKS_TIMEOUT_S, context=_srv.SSL_CTX
        ) as resp:
            raw = resp.read(_JWKS_MAX_BYTES + 1)
    except (urllib.error.URLError, OSError, ValueError) as e:
        log.warning("SSO: could not fetch signing keys from %s: %s", url, e)
        return None
    if len(raw) > _JWKS_MAX_BYTES:
        log.warning("SSO: signing key document from %s is too large", url)
        return None
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        log.warning("SSO: signing key document from %s is not valid JSON", url)
        return None
    return doc if isinstance(doc, dict) else None


def _signing_keys(url, want_kid):
    """The verification keys for ``url``, refreshing when needed. None if there
    are none usable.

    Refreshes when the cache is stale or when ``want_kid`` is unknown (a key
    rotation looks exactly like that), subject to a cooldown. When a refresh
    cannot happen the cached keys keep working until ``_JWKS_STALE_MAX_S`` — a
    stale *public* key can only ever verify signatures it could already verify,
    so this extends availability without widening what is accepted.
    """
    now = int(time.time())
    with _lock:
        entry = _jwks_cache.get(url)
        if entry is None:
            disk = _load_jwks_disk(url)
            if disk:
                entry = {"fetched": disk[0], "keys": disk[1]}
                _jwks_cache[url] = entry
        if entry is not None and now - entry["fetched"] < _JWKS_TTL_S:
            if want_kid is None or want_kid in entry["keys"]:
                return entry["keys"]
        if now - _jwks_attempt.get(url, 0) < _JWKS_REFETCH_COOLDOWN_S:
            # We asked recently. Serve whatever is cached and let the caller
            # turn a miss into a rejection — retrying per request would make an
            # unreachable certs endpoint cost every caller a connect timeout.
            return _usable_stale_keys(entry, now)
        _jwks_attempt[url] = now

    doc = None
    if _is_offline():
        log.debug("SSO: offline, not fetching signing keys")
    else:
        doc = _fetch_jwks(url)

    keys = _parse_jwks(doc) if doc else {}
    with _lock:
        if keys:
            _jwks_cache[url] = {"fetched": now, "keys": keys}
            _store_jwks_disk(url, now, doc)
            return keys
        stale = _usable_stale_keys(_jwks_cache.get(url), now)
    if stale:
        log.warning("SSO: refresh failed; verifying against cached signing keys")
    return stale


def _usable_stale_keys(entry, now):
    """A cached key set that may keep verifying despite a failed refresh, or
    None once it is older than ``_JWKS_STALE_MAX_S``."""
    if entry and now - entry["fetched"] < _JWKS_STALE_MAX_S:
        return entry["keys"]
    return None


# ============================================================================
# Token verification
# ============================================================================


def verify_token(token, issuer, aud, now=None):
    """Verify an Access JWT. Returns ``(claims, None)`` or ``(None, reason)``.

    ``reason`` is a short machine-ish string for the server log. It is never
    sent to the client: telling a caller *why* their token failed is free
    reconnaissance, and every failure means the same thing to a browser.
    """
    now = int(time.time()) if now is None else int(now)
    parts = _split_token(token)
    if parts is None:
        return None, "malformed"
    header, payload, signing_input, signature = parts

    # Algorithm first, before a key is even looked up: `none` and an HS256
    # downgrade must never reach code that could treat them as verified.
    if header.get("alg") != _ALLOWED_ALG:
        return None, "alg:%s" % (header.get("alg"),)
    typ = header.get("typ")
    if typ is not None and (not isinstance(typ, str) or typ.upper() != "JWT"):
        return None, "typ"
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        return None, "kid-missing"

    url = certs_url()
    keys = _signing_keys(url, kid) if url else None
    if not keys:
        return None, "no-keys"
    key = keys.get(kid)
    if key is None:
        return None, "kid-unknown"
    if not _rsa_verify_pkcs1_v15_sha256(key[0], key[1], signature, signing_input):
        return None, "signature"

    # Only now are the claims worth reading.
    if payload.get("iss") != issuer:
        return None, "iss"
    if not _audience_matches(payload.get("aud"), aud):
        return None, "aud"

    exp = _claim_int(payload.get("exp"))
    if exp is None or now > exp + _CLOCK_SKEW_S:
        return None, "exp"
    iat = _claim_int(payload.get("iat"))
    if iat is None or iat > now + _CLOCK_SKEW_S:
        return None, "iat"
    nbf = _claim_int(payload.get("nbf"))
    if nbf is not None and now + _CLOCK_SKEW_S < nbf:
        return None, "nbf"
    return payload, None


def _claim_int(value):
    """A numeric-date claim as an int, or None.

    Rejects bools and strings — a JWT numeric date is a number, and coercing
    ``"9999999999"`` here would accept a token a strict verifier rejects. Also
    rejects the non-finite floats ``json.loads`` accepts by default: ``exp:
    Infinity`` would otherwise be a never-expiring token, and converting it
    raises rather than compares.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return int(value)


def _audience_matches(claim, expected):
    """True when the ``aud`` claim contains exactly the configured tag.

    A token minted for a *different* Access application carries a different
    AUD, so this is what stops one replayed across applications inside the same
    Cloudflare account.
    """
    if not expected:
        return False
    if isinstance(claim, str):
        return hmac.compare_digest(claim, expected)
    if isinstance(claim, list):
        return any(
            isinstance(a, str) and hmac.compare_digest(a, expected) for a in claim
        )
    return False


# ============================================================================
# Identity → Zimi account
# ============================================================================


def _derive_username(email):
    """Candidate account names for an email address, best first.

    Zimi usernames are ``[\\w .\\-]{1,32}`` (users.py), which an email's ``@``
    does not satisfy — so the local part is the readable first choice and the
    sanitized full address is the fallback that keeps two people who share a
    local part across domains apart.
    """
    from zimi import users as _users

    local = email.split("@")[0]
    full = email.replace("@", "-")
    out = []
    for raw in (local, full):
        name = "".join(c if (c.isalnum() or c in "_ .-") else "-" for c in raw)[:32]
        name = name.strip()
        if name and _users._valid_name(name) and name not in out:
            out.append(name)
    return out


def resolve_identity(claims):
    """(identity_dict, None) for a verified token, or (None, reason)."""
    email = claims.get(IDENTITY_CLAIM)
    if not isinstance(email, str) or not email.strip() or "@" not in email:
        return None, "no-identity"
    sub = claims.get("sub")
    return {
        "provider": "cloudflare",
        "iss": claims.get("iss") or "",
        "sub": sub if isinstance(sub, str) else "",
        "email": email.strip(),
    }, None


def account_for(identity):
    """The Zimi account name for a verified identity, creating it on first
    login. Returns ``(name, None)`` or ``(None, reason)``.

    The lookup is by stored identity, not by name, so an account's name is
    fixed at creation and never moves under it. An account that belongs to
    someone else is never adopted — signing into an existing local-password
    account because a claim happened to match its name is the classic
    federation takeover bug. Instead the next candidate name is tried, and only
    when every candidate is taken is this a refusal: a person locked out with an
    unexplainable 401 is the likelier outcome of a strict rule here, and it
    protects nothing that trying the next name does not.
    """
    from zimi import users as _users

    existing = _users.find_federated_user(identity)
    if existing:
        _users.touch_federated_user(existing, identity)
        return existing, None

    candidates = _derive_username(identity["email"])
    if not candidates:
        return None, "unusable-name"
    for name in candidates:
        if _users.get_user(name) is None:
            ok, err = _users.create_federated_user(name, default_role(), identity)
            if ok:
                log.info(
                    "SSO: created account %s for %s (role=%s)",
                    name,
                    identity["email"],
                    default_role(),
                )
                return name, None
            # Lost a race to a concurrent request for the same identity: the
            # record now exists, so resolve it the same way the next request
            # would rather than inventing a second account.
            if err == "user already exists":
                again = _users.find_federated_user(identity)
                if again:
                    return again, None
            return None, "create-failed"
    log.warning(
        "SSO: refusing %s — the account name(s) %s already belong to someone else",
        identity["email"],
        ", ".join(candidates),
    )
    return None, "name-conflict"


# ============================================================================
# Request resolution — the entry point http.py and users.py call
# ============================================================================


def _peer_trusted(handler):
    """True when the DIRECT socket peer may assert an identity header.

    Deliberately not ``handler._client_ip()``: that method consults forwarded
    headers, and headers are precisely what is on trial here.
    """
    address = getattr(handler, "client_address", None)
    if not address:
        return False
    try:
        peer = ipaddress.ip_address(address[0])
    except (ValueError, IndexError, TypeError):
        return False
    # A dual-stack listener reports an IPv4 peer as ::ffff:10.0.0.5, which no
    # IPv4 CIDR contains — so an operator's correct-looking allowlist would
    # silently never match. Compare on the address they actually wrote down.
    mapped = getattr(peer, "ipv4_mapped", None)
    if mapped is not None:
        peer = mapped
    nets = _proxy_cidrs()
    if nets is not None:
        return any(peer in net for net in nets)
    from zimi import http as _http

    return _http._is_trusted_net(peer)


def _header_token(handler):
    headers = getattr(handler, "headers", None)
    if not headers:
        return ""
    try:
        return (headers.get(SSO_HEADER) or "").strip()
    except (AttributeError, TypeError):
        return ""


def _log_reject(handler, reason):
    """Log a rejection, throttled per (peer, reason) so a flood stays cheap."""
    address = getattr(handler, "client_address", None)
    peer = address[0] if address else "?"
    now = time.time()
    key = (peer, reason)
    with _lock:
        last = _reject_logged.get(key, 0)
        if now - last < _REJECT_LOG_INTERVAL_S:
            log.debug("SSO: rejected token from %s (%s)", peer, reason)
            return
        _reject_logged[key] = now
        if len(_reject_logged) > 256:
            _reject_logged.clear()
    log.warning("SSO: rejected %s from %s (%s)", SSO_HEADER, peer, reason)


def _cache_key(token, issuer, aud):
    return hashlib.sha256(
        ("\x00".join((issuer, aud, token))).encode("utf-8", "replace")
    ).hexdigest()


def _cached_result(key, now):
    with _lock:
        entry = _token_cache.get(key)
        if entry and entry[0] > now:
            return entry[1], entry[2]
        if entry:
            del _token_cache[key]
    return None


def _cache_result(key, name, reason, now):
    with _lock:
        if len(_token_cache) >= _TOKEN_CACHE_MAX:
            _token_cache.clear()
        _token_cache[key] = (now + _TOKEN_CACHE_TTL_S, name, reason)


def _resolve_uncached(handler):
    if not is_configured():
        return None, None
    token = _header_token(handler)
    if not token:
        return None, None
    if not _peer_trusted(handler):
        # Not a rejection: an untrusted peer's header is treated as if it were
        # never sent, so a forger on the LAN cannot lock anyone out either.
        log.debug("SSO: ignoring %s from an untrusted peer", SSO_HEADER)
        return None, None

    issuer, aud = team_base_url(), audience()
    now = int(time.time())
    key = _cache_key(token, issuer, aud)
    cached = _cached_result(key, now)
    if cached is not None:
        if cached[1]:
            _log_reject(handler, cached[1])
        return cached

    claims, reason = verify_token(token, issuer, aud, now=now)
    if reason is None and claims is not None:
        identity, reason = resolve_identity(claims)
        if identity is not None:
            name, reason = account_for(identity)
            if name:
                _cache_result(key, name, None, now)
                return name, None
    # Cache the rejection too: a client that keeps replaying a dead token
    # shouldn't get a fresh RSA verify (or a JWKS probe) every request.
    _cache_result(key, None, reason, now)
    _log_reject(handler, reason)
    return None, reason


def resolve(handler):
    """Resolve the request's SSO identity.

    Returns ``(name, None)`` when the header carried a verified identity,
    ``(None, None)`` when there is no SSO identity to consider (not configured,
    no header, or a peer that may not assert one — all of which proceed as a
    normal anonymous request), and ``(None, reason)`` when a header that SHOULD
    have been trustworthy was not, which the caller must turn into a 401.

    Never raises: a bug in here must not be able to take down request handling
    for a deployment that does not even use SSO. An internal failure with a
    header present resolves as a rejection, which is the fail-closed direction.
    """
    cached = getattr(handler, _REQUEST_ATTR, None)
    if cached is not None:
        return cached
    try:
        result = _resolve_uncached(handler)
    except Exception:
        log.exception("SSO: identity resolution failed")
        result = (None, "internal") if _header_token(handler) else (None, None)
    try:
        setattr(handler, _REQUEST_ATTR, result)
    except AttributeError:
        pass
    return result


def clear_request_cache(handler):
    """Drop the memoized result. Called at the top of every request because a
    keep-alive connection reuses the handler object across requests."""
    try:
        delattr(handler, _REQUEST_ATTR)
    except AttributeError:
        pass


def reset_caches():
    """Drop every cached key and verdict (config changes, tests)."""
    with _lock:
        _jwks_cache.clear()
        _jwks_attempt.clear()
        _token_cache.clear()
        _reject_logged.clear()
