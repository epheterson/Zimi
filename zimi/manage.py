"""Manage endpoints and authentication for Zimi.

Handles /manage/* routes: library status, downloads, catalog, settings,
history, stats, and admin authentication. Called from ZimHandler in http.py.
"""

import hashlib
import hmac
import json
import logging
import os
import re
import sys
import secrets
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import zimi.server as _srv

log = logging.getLogger("zimi")

# ============================================================================
# Password & Authentication
# ============================================================================

_PW_ITERATIONS = 600_000  # OWASP 2023 recommendation for PBKDF2-SHA256


def _hash_pw(pw, salt=None):
    """Hash password with PBKDF2-SHA256 + random salt. Returns 'salt$hash'."""
    if salt is None:
        salt = os.urandom(16)
    else:
        salt = bytes.fromhex(salt)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, _PW_ITERATIONS)
    return salt.hex() + "$" + dk.hex()


def _is_legacy_hash(stored):
    """Check if stored hash is a v1.5 unsalted SHA-256 hex string."""
    return stored and "$" not in stored and len(stored) == 64


def _verify_legacy(candidate, stored):
    """Verify a password against a v1.5 unsalted SHA-256 hash."""
    legacy = hashlib.sha256(candidate.encode()).hexdigest()
    return hmac.compare_digest(legacy, stored)


def _upgrade_legacy_hash(candidate):
    """Re-hash a verified password from v1.5 format to PBKDF2. Called after
    successful legacy verification to transparently migrate the password file.

    Best-effort: on read-only media the write fails soft and the legacy hash
    simply keeps verifying on every login — migration retries next time."""
    if _set_manage_password(candidate):
        log.info("Migrated password from v1.5 SHA-256 to PBKDF2")


def _atomic_write_text(path, content):
    """Write a small credential file via tmp + os.replace. True on success.

    Same error discipline as server._atomic_write_json: never raises. These
    were the last two write paths that threw a traceback on read-only media —
    the HTTP callers turn a False into a generic 500 JSON, and the real
    OSError stays in the server log (repo rule: no str(e) in responses)."""
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
        return True
    except OSError as e:
        log.warning("Cannot write %s: %s", path, e)
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False


_env_pw_hash_cache = None  # cached hash for ZIMI_MANAGE_PASSWORD env var


def _password_file():
    return os.path.join(_srv.ZIMI_DATA_DIR, "password")


def _get_manage_password_hash():
    """Get password hash from env var or file.

    The password file holds the hash on its first line; an OPTIONAL username
    may follow on the second line (see _file_username). Only the first line is
    the hash, so legacy single-line files keep working unchanged."""
    global _env_pw_hash_cache
    # Env var takes priority (Docker deployments)
    pw = os.environ.get("ZIMI_MANAGE_PASSWORD", "")
    if pw:
        if _env_pw_hash_cache is None:
            _env_pw_hash_cache = _hash_pw(pw)
        return _env_pw_hash_cache
    # Fall back to password file (set via UI)
    try:
        with open(_password_file(), encoding="utf-8") as f:
            stored = f.readline().strip()  # first line only — line 2 is username
        # Empty or too-short to be a valid hash — treat as no password
        if not stored or len(stored) < 10:
            return ""
        return stored
    except (FileNotFoundError, OSError):
        return ""


def _file_username():
    """Optional username stored on the second line of the password file, or ''.

    A plain identifier (not a secret) — legacy files have no second line and
    return ''. Env var ZIMI_MANAGE_USER (see _get_manage_user) overrides this."""
    try:
        with open(_password_file(), encoding="utf-8") as f:
            lines = f.read().split("\n")
        if len(lines) >= 2:
            return lines[1].strip()
    except (FileNotFoundError, OSError):
        pass
    return ""


def _get_manage_user():
    """Configured management username, or '' if none. Env var wins over file.

    OPTIONAL: when '' the login accepts any username (pure keychain UX);
    when set, the login username must match it case-insensitively. Original
    case is preserved for display; matching is done case-folded by callers."""
    env_user = os.environ.get("ZIMI_MANAGE_USER", "").strip()
    if env_user:
        return env_user
    return _file_username()


def _set_manage_password(pw, username=None):
    """Save hashed password to file (line 1) with an optional username (line 2),
    or clear the file. Uses atomic write.

    username semantics: None preserves whatever username the file already had
    (so a plain password change never wipes it); '' clears it; a non-empty
    string sets it. Clearing the password (pw falsy) clears username too.

    Returns True on success, False when the file cannot be written (read-only
    media) — in which case nothing below (session drop, log) happens either,
    because the old password is still the one in force."""
    pf = _password_file()
    if not pw:
        content = ""  # cleared — no hash, no username
    else:
        if username is None:
            username = _file_username()  # preserve existing on a bare pw change
        content = _hash_pw(pw)
        if username and username.strip():
            content += "\n" + username.strip()
    if not _atomic_write_text(pf, content):
        return False
    # A password rotation must revoke old admin session cookies immediately (the
    # pre-cookie model, where the Bearer WAS the password, did so implicitly). The
    # rotating admin's own Bearer still authenticates and /whoami re-mints a fresh
    # cookie, so this never locks out the person making the change.
    try:
        from zimi import users as _users

        _users.drop_admin_sessions()
    except Exception:
        pass
    log.info("Manage password %s", "set" if pw else "cleared")
    return True


# ── first-run setup key (GHSA-5mw2-53vv-9pw6) ───────────────────────────────
#
# Bootstrap trust used to be "any private-tier client sets the first admin
# password". On a LAN, a Docker bridge, or a tailnet that is too many hands:
# an adjacent device could race the owner to claim admin. The fix splits the
# bootstrap door in two — the HOST itself (loopback) needs no secret, and any
# REMOTE client must present this setup key, which the server generates on
# first start and prints to its own log. No third door: LAN and tailnet peers
# without the key get the same locked response a public client does.
def _setup_key_file():
    return os.path.join(_srv.ZIMI_DATA_DIR, "setup-key")


def _read_setup_key():
    try:
        with open(_setup_key_file(), encoding="utf-8") as f:
            return f.readline().strip()
    except (FileNotFoundError, OSError):
        return ""


def ensure_setup_key():
    """Guarantee a setup key exists while the instance is passwordless, and
    return it. A no-op (returns '') once a password is set — the key's whole
    life is the bootstrap window. Idempotent: the same key persists across
    restarts until it is spent, so a printed code stays valid."""
    if _get_manage_password_hash():
        return ""
    existing = _read_setup_key()
    if existing:
        return existing
    key = "-".join(
        secrets.token_hex(2).upper() for _ in range(3)
    )  # e.g. 7Q2K-9F4M-XR8T shape, from a real CSPRNG
    # 0600, best-effort: a key only the server and root can read.
    _atomic_write_text(_setup_key_file(), key + "\n")
    try:
        os.chmod(_setup_key_file(), 0o600)
    except OSError:
        pass
    return key


def _clear_setup_key():
    try:
        os.remove(_setup_key_file())
    except (FileNotFoundError, OSError):
        pass


def _bootstrap_key_ok(handler):
    """True when a remote bootstrap request carries the valid setup key, in
    the Authorization: Bearer header or an X-Zimi-Setup-Key header. Constant-
    time compared. Absent key file (already spent) → nothing matches."""
    want = _read_setup_key()
    if not want:
        return False
    got = (handler.headers.get("X-Zimi-Setup-Key") or "").strip()
    if not got:
        auth = handler.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            got = auth[7:].strip()
    return bool(got) and hmac.compare_digest(got, want)


def _api_token_file():
    """API token file path inside ZIMI_DATA_DIR."""
    return os.path.join(_srv.ZIMI_DATA_DIR, "api_token")


def _get_api_token():
    """Get stored API token (plaintext, for constant-time comparison)."""
    env_token = os.environ.get("ZIMI_API_TOKEN", "")
    if env_token:
        return env_token
    try:
        with open(_api_token_file(), encoding="utf-8") as f:
            return f.read().strip()
    except (FileNotFoundError, OSError):
        return ""


def _generate_api_token():
    """Generate a new random API token, save to disk, return it.

    Returns None when the token cannot be persisted (read-only media): a
    token handed out but not on disk would stop authenticating at the next
    restart, which is worse than a clean refusal now."""
    import secrets

    token = secrets.token_urlsafe(32)
    if not _atomic_write_text(_api_token_file(), token):
        return None
    log.info("API token generated")
    return token


def _revoke_api_token():
    """Delete the API token file."""
    try:
        os.remove(_api_token_file())
        log.info("API token revoked")
    except FileNotFoundError:
        pass


def _verify_password(candidate, stored_pw):
    """Verify a password against the stored hash. Handles legacy and PBKDF2."""
    if _is_legacy_hash(stored_pw):
        if _verify_legacy(candidate, stored_pw):
            _upgrade_legacy_hash(candidate)
            return True
        return False
    if "$" not in stored_pw:
        return False
    salt = stored_pw.split("$")[0]
    return hmac.compare_digest(_hash_pw(candidate, salt), stored_pw)


def verify_admin_credentials(username, password):
    """Verify a (username, password) pair against the ADMIN account, header-free.

    Used by the unified /login endpoint so admin creds entered in the same modal
    as user creds still authenticate. Mirrors _check_manage_auth's password +
    optional-username gate, but takes explicit values instead of reading headers.
    Returns False on a passwordless instance (nothing to log into as admin).
    """
    stored_pw = _get_manage_password_hash()
    if not stored_pw:
        return False
    if not _verify_password(password, stored_pw):
        return False
    configured_user = _get_manage_user()
    if configured_user:
        return (username or "").strip().casefold() == configured_user.strip().casefold()
    return True


#: Returned by _check_manage_auth when the only reason a request is denied is
#: that the instance has NO password and the client is non-private. There is no
#: password to enter, so the UI must explain rather than prompt (see issue #36).
PUBLIC_LOCKED = "public_locked"


def _primary_admin_authorized(handler):
    """True if the request carries PRIMARY-admin credentials: the password-file
    account (password hash or configured username+password) or the API token,
    OR a private client on a passwordless instance (legacy open admin).

    The primary admin is the top of the hierarchy — the only account that can
    manage other admins and that no secondary admin can delete or demote.
    """
    stored_pw = _get_manage_password_hash()
    if not stored_pw:
        # Passwordless: LAN/loopback clients are the (only) primary admin.
        return handler._is_private_client()

    # A primary-admin SESSION token (users.create_admin_session): minted when the
    # admin password verified, delivered as the HttpOnly zimi_session cookie so
    # header-less transports carry admin identity — the /w/ reader iframe (a
    # browser navigation that can't send Authorization) and the plain-fetch data
    # endpoints (/list, /search, …). Without this, a private/limited-mode admin
    # loads an EMPTY library and blank article iframes. Checked FIRST (before the
    # Bearer-format gate below) so a cookie-only request with no Authorization
    # header still resolves as admin. Accepted from either the cookie (browsers)
    # or the Bearer header (an API client may present it). As unforgeable as the
    # password Bearer: a random token, hashed at rest.
    from zimi import users as _users

    if _users.is_admin_session(_users._cookie_token(handler)):
        return True
    if _users.is_admin_session(_users._bearer_token(handler)):
        return True

    auth = handler.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False
    candidate = auth[7:]

    # API token — a machine credential, carries no username gate (keeps
    # existing scripts/agents working unchanged).
    stored_token = _get_api_token()
    if stored_token and hmac.compare_digest(candidate, stored_token):
        return True

    # Password — plus, when a username is configured, it must match.
    if _verify_password(candidate, stored_pw):
        configured_user = _get_manage_user()
        if configured_user:
            provided = handler.headers.get("X-Zimi-User", "")
            if provided.strip().casefold() != configured_user.strip().casefold():
                # Wrong/missing username reads exactly like a wrong password:
                # generic denial, no username-enumeration signal.
                return False
        return True
    return False


def _secondary_admin_authorized(handler):
    """True if the request is a SECONDARY admin: a users.json account with
    role=admin, authenticated by its session token (Bearer or cookie). They get
    manage powers, but the hierarchy in ``_handle_users_post`` still bars them
    from touching the primary admin or managing other admins."""
    from zimi import users as _users

    name = _users.resolve_request_user(handler)
    return bool(name) and _users.is_admin_user(name)


def admin_kind(handler):
    """Classify an authorized manage request: ``'primary'`` (password-file /
    API-token / passwordless-private), ``'secondary'`` (role=admin session), or
    ``None`` (not an admin). Drives the primary-only hierarchy checks."""
    if _primary_admin_authorized(handler):
        return "primary"
    if _secondary_admin_authorized(handler):
        return "secondary"
    return None


def _check_manage_auth(handler):
    """Check authorization for manage endpoints. Returns a truthy value if
    unauthorized (``True`` for a genuine password/token requirement,
    ``PUBLIC_LOCKED`` for the passwordless-but-non-private case), ``None`` if
    authorized.

    Auth model:
    - No password set → open access for private clients; non-private clients
      are locked (PUBLIC_LOCKED) until a password is set from the LAN
    - Password set → Bearer token must match password or API token (PRIMARY
      admin), OR a role=admin session token (SECONDARY admin)
    - API token is optional (requires password to be set first)
    """
    stored_pw = _get_manage_password_hash()
    if not stored_pw:
        # Bootstrap window (GHSA-5mw2-53vv-9pw6). Being ON the host is the one
        # ownership proof that needs no secret; every remote client — LAN,
        # Docker bridge, tailnet alike — must present the setup key the server
        # printed to its log. Private-tier is no longer a free pass: it was
        # wide enough for an adjacent device to race the owner to the first
        # password. No password yet means no admin yet, so this same gate
        # guards ALL of /manage, not just set-password.
        # getattr fallback is for test doubles only: the real ZimHandler
        # always carries _is_loopback_client, so production always takes the
        # strict loopback path — and test_bootstrap_takeover pins that, so a
        # refactor that lost the method would fail loudly rather than silently
        # widen the door back to _is_private_client.
        is_local = getattr(handler, "_is_loopback_client", handler._is_private_client)
        if is_local():
            return None
        if _bootstrap_key_ok(handler):
            return None
        return PUBLIC_LOCKED

    if _primary_admin_authorized(handler) or _secondary_admin_authorized(handler):
        return None
    return True


def _manage_auth_challenge(handler):
    """Return the ``(status, body)`` to send for a denied manage request, or
    ``None`` when the client is authorized.

    Distinguishes the two failure modes that used to both surface as a bare
    ``401 needs_password`` and left the SPA prompting for a password that does
    not exist (issue #36):

    - passwordless instance, non-private client → ``403 public_locked`` with
      ``needs_password: False`` (nothing to enter; the UI explains instead)
    - password/token required or wrong → ``401 unauthorized`` with
      ``needs_password: True`` (the UI prompts, exactly as before)
    """
    result = _check_manage_auth(handler)
    if result is None:
        return None
    if result == PUBLIC_LOCKED:
        # Passwordless and off-host. A PRIVATE-tier client — a LAN or tailnet
        # peer who could plausibly read the server log — is told a setup key
        # exists so the SPA prompts for it. A genuine WAN visitor gets the
        # opaque lock: no hint a key exists, nothing to brute-force. Being on
        # the same trust network is the price of even seeing the key prompt.
        if not _get_manage_password_hash() and handler._is_private_client():
            return (
                403,
                {
                    "error": "needs_setup_key",
                    "needs_password": False,
                    "needs_setup_key": True,
                },
            )
        return (403, {"error": "public_locked", "needs_password": False})
    return (401, {"error": "unauthorized", "needs_password": True})


def _creator_authorized(handler):
    """True if the request may drive ZIM creation: any authorized admin
    (primary or secondary, including the passwordless-private legacy admin),
    or a signed-in named user whose account carries ``can_create``."""
    if _check_manage_auth(handler) is None:
        return True
    from zimi import users as _users

    name = _users.resolve_request_user(handler)
    return bool(name) and _users.user_can_create(name)


def _creator_denial(handler):
    """The ``(status, body)`` refusing a create-surface request, or ``None``
    when authorized (see ``_creator_authorized``).

    A signed-in user WITHOUT the permission gets a plain 403 — they are
    authenticated, so the admin password prompt (``needs_password``) would be
    the wrong door to point at. Everyone else gets the standard manage
    challenge: 401 for anonymous/wrong credentials, ``public_locked`` for the
    passwordless-public case.
    """
    if _creator_authorized(handler):
        return None
    from zimi import users as _users

    if _users.resolve_request_user(handler):
        return (403, {"error": "creation is not enabled for this account"})
    return _manage_auth_challenge(handler)


# ============================================================================
# App update check — is a newer ZIMI APPLICATION release out?
#
# Deliberately distinct from the ZIM-content "Auto-update" feature
# (library.py / /manage/auto-update), which refreshes installed ZIM files.
# Keep every name here prefixed "app_update" so the two can never be
# conflated in code, endpoints, or UI strings.
# ============================================================================

_APP_UPDATE_URL = "https://api.github.com/repos/epheterson/Zimi/releases/latest"
# The "beta" channel needs the full list: GitHub's /releases/latest endpoint
# deliberately skips pre-releases, so a beta is only reachable by listing.
# Newest-first, one page is far more history than a version check needs.
_APP_UPDATE_LIST_URL = (
    "https://api.github.com/repos/epheterson/Zimi/releases?per_page=20"
)
_APP_RELEASES_PAGE = "https://github.com/epheterson/Zimi/releases"
# Passive reads (opening the Manage server pane) reuse the cached answer for
# a day; a failed check backs off only an hour so one DNS hiccup doesn't
# blind the row for 24h. "Check now" bypasses both but keeps a short flood
# guard — GitHub's anonymous API quota is 60 req/h and a mashed button must
# not eat it. There is NO boot-time or background caller by design: the only
# trigger is an admin actually looking at (or poking) the Manage row.
_APP_UPDATE_TTL = 24 * 3600
_APP_UPDATE_ERROR_TTL = 3600
_APP_UPDATE_FORCE_GUARD = 60
_app_update_lock = threading.Lock()  # single-flight: concurrent admins share one fetch

# Update channels. "latest" (the default, and what every install had before
# channels existed) only ever sees finished releases, the day they ship;
# "beta" takes whatever is newest — a pre-release or a final, whichever is
# higher-versioned. Deliberately NOT called "stable": that word promises a
# validation program this project does not run, and the two channels ship the
# same code with the same testing, only at different times.
APP_UPDATE_CHANNELS = ("latest", "beta")
APP_UPDATE_CHANNEL_DEFAULT = "latest"
APP_UPDATE_CHANNEL_ENV = "ZIMI_UPDATE_CHANNEL"
# Names people reach for that mean one of the two real channels. Accepting
# them beats rejecting a deploy because someone wrote the obvious word —
# "stable" most of all, since it is the word everyone types for a default
# channel and the one an earlier build of this feature wrote to disk.
_APP_UPDATE_CHANNEL_ALIASES = {
    "stable": "latest",
    "stable-only": "latest",
    "release": "latest",
    "releases": "latest",
    "final": "latest",
    "betas": "beta",
    "pre": "beta",
    "prerelease": "beta",
    "pre-release": "beta",
    "edge": "beta",
    "newest": "beta",
}

# Update delay: hold a release back until it has been public for N days, so a
# fleet can let other people find the sharp edges first. 0 (the default, and
# every pre-1.9 install's behavior) offers a release the moment it exists.
# The choices the UI offers; any integer in range is still accepted over the
# API and the env var, because a fleet policy of "11 days" is nobody's bug.
APP_UPDATE_DELAY_ENV = "ZIMI_UPDATE_DELAY_DAYS"
APP_UPDATE_DELAY_DEFAULT = 0
APP_UPDATE_DELAY_CHOICES = (0, 1, 3, 7, 14, 30)
APP_UPDATE_DELAY_MAX = 365  # a year of deferral is already an eternity

# Ordering for pre-release suffixes within one numeric version. Unknown words
# land above rc so a novel stream ("1.9.0-preview2") still moves forward, and
# ties break on the word itself for determinism.
_PRERELEASE_STAGES = {"alpha": 0, "a": 0, "beta": 1, "b": 1, "rc": 2, "c": 2}
_PRERELEASE_UNKNOWN_STAGE = 3
_FINAL_STAGE = 9  # a final release outranks every pre-release of its version


def _app_update_cache_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, "app_update.json")


def _app_update_prefs_path():
    """Both app-update preferences (channel + delay) share one small file. The
    name is the one the channel-only build wrote, so an existing preference
    survives the upgrade untouched."""
    return os.path.join(_srv.ZIMI_DATA_DIR, "app_update_channel.json")


def _read_app_update_prefs():
    try:
        with open(_app_update_prefs_path(), "r", encoding="utf-8") as f:
            saved = json.load(f)
    except (OSError, ValueError):
        return {}
    return saved if isinstance(saved, dict) else {}


def _write_app_update_prefs(**updates):
    """Merge into the prefs file — writing the channel must never drop the
    delay, and vice versa."""
    prefs = _read_app_update_prefs()
    prefs.update(updates)
    _srv._atomic_write_json(_app_update_prefs_path(), prefs)


def normalize_update_channel(value):
    """'Beta ' → 'beta', 'latest' → 'latest', 'stable' → 'latest' (the word
    for this channel that the API, the env var and an earlier build all
    accept), junk → None."""
    name = (value or "").strip().lower()
    name = _APP_UPDATE_CHANNEL_ALIASES.get(name, name)
    return name if name in APP_UPDATE_CHANNELS else None


def normalize_update_delay_days(value):
    """A whole number of days in [0, APP_UPDATE_DELAY_MAX], or None for
    anything that isn't one. Strings are accepted so an env var and a JSON
    body can share this path; booleans are not, because True is not 1 day."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        days = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return days if 0 <= days <= APP_UPDATE_DELAY_MAX else None


def is_update_channel_env_locked():
    """True when ZIMI_UPDATE_CHANNEL names a real channel. Same contract as
    every other env-locked setting: the environment wins and the UI says so
    rather than offering a control that silently does nothing."""
    return normalize_update_channel(os.environ.get(APP_UPDATE_CHANNEL_ENV)) is not None


def is_update_delay_env_locked():
    """True when ZIMI_UPDATE_DELAY_DAYS holds a usable number of days."""
    return normalize_update_delay_days(os.environ.get(APP_UPDATE_DELAY_ENV)) is not None


def get_update_channel():
    """The channel in force: env var, then the saved preference, then latest."""
    from_env = normalize_update_channel(os.environ.get(APP_UPDATE_CHANNEL_ENV))
    if from_env:
        return from_env
    saved = normalize_update_channel(_read_app_update_prefs().get("channel"))
    return saved or APP_UPDATE_CHANNEL_DEFAULT


def get_update_delay_days():
    """The delay in force: env var, then the saved preference, then none."""
    from_env = normalize_update_delay_days(os.environ.get(APP_UPDATE_DELAY_ENV))
    if from_env is not None:
        return from_env
    saved = normalize_update_delay_days(_read_app_update_prefs().get("delay_days"))
    return APP_UPDATE_DELAY_DEFAULT if saved is None else saved


def set_update_channel(value):
    """Persist the channel preference. Returns (channel, error) — error is a
    short code the caller turns into an HTTP status."""
    channel = normalize_update_channel(value)
    if not channel:
        return None, "invalid_channel"
    if is_update_channel_env_locked():
        return None, "env_locked"
    _write_app_update_prefs(channel=channel)
    return channel, None


def set_update_delay_days(value):
    """Persist the update delay. Same (value, error) contract as the channel."""
    days = normalize_update_delay_days(value)
    if days is None:
        return None, "invalid_delay"
    if is_update_delay_env_locked():
        return None, "env_locked"
    _write_app_update_prefs(delay_days=days)
    return days, None


def _parse_app_version(tag):
    """'v1.9.0' / '1.9' / '1.9.0-beta1' → ((1, 9, 0), 'beta1'), else None.

    The numeric tuple (padded to three parts so 1.9 == 1.9.0) drives the
    comparison; the suffix only marks pre-releases. Unparseable tags return
    None so a garbage GitHub tag can never masquerade as an update."""
    m = re.match(r"[vV]?(\d+(?:\.\d+)*)[-+.]?(.*)$", (tag or "").strip())
    if not m or not m.group(1):
        return None
    nums = tuple(int(p) for p in m.group(1).split("."))
    return (nums + (0,) * 3)[: max(3, len(nums))], m.group(2).strip()


def _prerelease_rank(suffix):
    """Sortable rank for a version suffix: '' (a final release) outranks every
    pre-release of the same numbers, and within pre-releases alpha < beta < rc
    < anything unrecognized, then by trailing number."""
    if not suffix:
        return (_FINAL_STAGE, 0, "")
    m = re.match(r"([A-Za-z]*)[.\-_]?(\d*)", suffix)
    word = (m.group(1) if m else "").lower()
    num = int(m.group(2)) if m and m.group(2) else 0
    stage = _PRERELEASE_STAGES.get(word, _PRERELEASE_UNKNOWN_STAGE)
    return (stage, num, "" if word in _PRERELEASE_STAGES else word)


def _app_version_sort_key(tag):
    """(numbers, pre-release rank) for a tag, or None if it can't be parsed."""
    parsed = _parse_app_version(tag)
    if not parsed:
        return None
    nums, suffix = parsed
    # Pad to a fixed width so (1, 9) and (1, 9, 0, 1) compare positionally.
    return (nums + (0,) * 4)[:4], _prerelease_rank(suffix)


def _app_version_newer(remote, current, allow_prerelease=False):
    """True only when `remote` is a strictly newer release than `current`.

    Same-number comparisons are conservative by default: a final release
    outranks its own pre-releases, but beta-vs-beta never reports an update —
    better to miss an edge case than nag someone already current. On the
    "beta" channel `allow_prerelease` turns that ordering on, because
    telling an rc1 user about rc2 is the entire point of the channel."""
    r, c = _app_version_sort_key(remote), _app_version_sort_key(current)
    if not r or not c:
        return False
    if r[0] != c[0]:
        return r[0] > c[0]
    r_final, c_final = r[1][0] == _FINAL_STAGE, c[1][0] == _FINAL_STAGE
    if r_final != c_final:
        return r_final  # a final beats its own pre-release, never the reverse
    if not allow_prerelease:
        return False  # pre-vs-pre off the beta channel: stay quiet
    return r[1] > c[1]


def detect_install_type():
    """Best-effort: how was this Zimi installed? Drives which upgrade
    instruction the Manage UI shows — a wrong guess only yields a suboptimal
    instruction, so lean conservative and fall through to 'pip'.

    Order matters: container/package sandboxes outrank the frozen-app flag
    because the outermost wrapper decides how you upgrade."""
    env = os.environ
    declared = env.get("ZIMI_INSTALL_TYPE", "").strip().lower()
    if declared:
        # Escape hatch for packagers (and tests): trust an explicit label.
        return declared
    if (
        os.path.exists("/.dockerenv")
        or os.path.exists("/run/.containerenv")  # podman's marker file
        or env.get("container")  # OCI convention (podman, systemd-nspawn)
    ):
        return "docker"
    if env.get("SNAP") and env.get("SNAP_NAME"):
        return "snap"
    if env.get("APPIMAGE"):
        return "appimage"
    if getattr(sys, "frozen", False) or getattr(sys, "_MEIPASS", None):
        if sys.platform == "darwin":
            return "desktop-mac"
        if sys.platform.startswith("win"):
            return "desktop-windows"
        return "desktop"  # frozen Linux build outside an AppImage wrapper
    paths = "%s %s" % (sys.prefix or "", sys.executable or "")
    if "/Cellar/" in paths or "/opt/homebrew/" in paths or "/home/linuxbrew/" in paths:
        # Heuristic only: a plain pip install into a brew-owned Python
        # matches too. The brew instruction is still the closest fit we can
        # detect from inside the process.
        return "homebrew"
    return "pip"


def _read_app_update_cache():
    try:
        with open(_app_update_cache_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _github_json(url):
    """GET a GitHub API URL and decode it. Raises on anything but success —
    every caller is inside the check's try/except."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Zimi/%s (+%s)" % (_srv.ZIMI_VERSION, _APP_RELEASES_PAGE),
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(req, timeout=10, context=_srv.SSL_CTX) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _pick_newest_release(releases):
    """The highest-versioned published release in a GitHub /releases list.

    Sorting by version rather than trusting the list order matters: GitHub
    orders by publish date, so a final patch cut after a beta would otherwise
    hide the beta from the channel that exists to show it. Drafts and
    unparseable tags are skipped."""
    best, best_key = None, None
    for rel in releases if isinstance(releases, list) else []:
        if not isinstance(rel, dict) or rel.get("draft"):
            continue
        key = _app_version_sort_key(rel.get("tag_name"))
        if key and (best_key is None or key > best_key):
            best, best_key = rel, key
    return best


def _parse_release_timestamp(value):
    """GitHub's `published_at` ('2026-08-01T12:00:00Z') → epoch seconds, or
    None when it is missing or unparseable. A release with no usable stamp
    can't be aged, and is treated as mature everywhere downstream: an update
    must never become permanently invisible because a field went missing."""
    text = (value or "").strip() if isinstance(value, str) else ""
    if not text:
        return None
    try:
        stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)  # GitHub always sends UTC
    return stamp.timestamp()


def _update_hold_until(published_ts, delay_days, now=None):
    """The epoch second an update this fresh becomes offerable, or None when
    it already is (no delay set, no publish date, or the wait is over).

    Evaluated on every read rather than baked into the cache, so a verdict of
    "too fresh" ages out on its own instead of being frozen for a day by the
    cached check that produced it."""
    if not delay_days or not published_ts:
        return None
    ready_at = published_ts + delay_days * 86400
    return ready_at if (now or time.time()) < ready_at else None


def check_app_update(force=False, channel=None):
    """Return {latest, checked_at, url, channel, error?}, hitting GitHub only
    when the cached answer is stale (or `force`, for the Check-now button).

    ZIMI_OFFLINE outranks everything including force and channel — zero
    network calls. Network failures are silent by contract: one debug line,
    the last good answer keeps serving, and the failure is stamped so passive
    reads back off instead of re-probing a dead link on every pane visit.

    A cached answer from the other channel is never reused: switching channel
    is exactly when the admin wants a fresh look."""
    from zimi import p2p  # is_offline() — the single air-gap switch

    if p2p.is_offline():
        return dict(_read_app_update_cache(), offline=True)
    channel = normalize_update_channel(channel) or get_update_channel()
    now = time.time()

    def _fresh(entry):
        # Raw comparison against the canonical name we write, deliberately not
        # run through the alias table: a cached entry labelled with a name this
        # build no longer writes came from a build whose channel names meant
        # something else, and re-checking is cheaper than trusting it.
        if entry.get("channel") != channel:
            return False
        age = now - entry.get("checked_at", 0)
        if force:
            return age < _APP_UPDATE_FORCE_GUARD
        return age < (_APP_UPDATE_ERROR_TTL if entry.get("error") else _APP_UPDATE_TTL)

    cached = _read_app_update_cache()
    if _fresh(cached):
        return cached
    with _app_update_lock:
        cached = _read_app_update_cache()  # a concurrent caller may have won
        if _fresh(cached):
            return cached
        try:
            if channel == "latest":
                # /releases/latest is already "newest final release" — one
                # request, and GitHub does the pre-release filtering.
                rel = _github_json(_APP_UPDATE_URL)
            else:
                rel = _pick_newest_release(_github_json(_APP_UPDATE_LIST_URL))
            if not isinstance(rel, dict):
                raise ValueError("no usable release in feed")
            entry = {
                "checked_at": now,
                # Tags arrive as "v1.9.0" — store the bare version the UI shows.
                "latest": (rel.get("tag_name") or "").strip().lstrip("vV"),
                "url": rel.get("html_url") or _APP_RELEASES_PAGE,
                "channel": channel,
                "prerelease": bool(rel.get("prerelease")),
                # Kept raw (epoch) so the update delay is re-evaluated on every
                # read instead of the cache freezing a "too fresh" verdict.
                "published_ts": _parse_release_timestamp(rel.get("published_at")),
            }
        except Exception as e:
            log.debug("app-update check failed: %s", e)
            entry = dict(cached, checked_at=now, channel=channel, error=True)
        _srv._atomic_write_json(_app_update_cache_path(), entry)
        return entry


def _app_update_payload(force=False):
    """The /manage/app-update response: check state + install-type routing.

    A newer release that hasn't been public long enough for the configured
    delay reports `update_held` + `held_until` instead of `update_available`,
    so the UI can say "1.9.1 is out, offering it in 3 days" rather than
    pretending the release doesn't exist.

    Note the two unrelated meanings of the word in this payload: the `latest`
    field is the newest version string on whichever channel is in force, while
    the `channel` field being "latest" names the finished-releases channel."""
    from zimi import p2p

    channel = get_update_channel()
    delay_days = get_update_delay_days()
    state = check_app_update(force=force, channel=channel)
    latest = state.get("latest") or None
    newer = bool(
        latest
        and _app_version_newer(
            latest, _srv.ZIMI_VERSION, allow_prerelease=(channel == "beta")
        )
    )
    held_until = (
        _update_hold_until(state.get("published_ts"), delay_days) if newer else None
    )
    return {
        "current": _srv.ZIMI_VERSION,
        "latest": latest,
        "update_available": newer and held_until is None,
        "update_held": held_until is not None,
        "held_until": held_until,
        "delay_days": delay_days,
        "delay_days_locked": is_update_delay_env_locked(),
        "delay_env": APP_UPDATE_DELAY_ENV,
        "delay_choices": list(APP_UPDATE_DELAY_CHOICES),
        "checked_at": state.get("checked_at") or None,
        "error": bool(state.get("error")),
        "offline": p2p.is_offline(),
        "install_type": detect_install_type(),
        "releases_url": state.get("url") or _APP_RELEASES_PAGE,
        "channel": channel,
        "channels": list(APP_UPDATE_CHANNELS),
        "channel_locked": is_update_channel_env_locked(),
        "channel_env": APP_UPDATE_CHANNEL_ENV,
        "prerelease": bool(state.get("prerelease")),
    }


def _cache_info_payload():
    """Size breakdown of the Zimi data dir (indexes + caches, NOT the ZIM
    library). Walks only the small-file-count data dir — never the ZIM files.

    Returns the original {caches, total_bytes} shape (backward compatible)
    plus:
      - data_dir_total_bytes: everything under the data dir
      - breakdown: ordered segments for the stacked bar (title/qid indexes,
        catalog caches, staging, other) — each {key, size_bytes[, count]}
      - top_zims: largest per-ZIM title-index contributors, largest first
    """
    import glob as _glob

    data_dir = _srv.ZIMI_DATA_DIR

    def _dir_size(path):
        total = 0
        for f in _glob.glob(os.path.join(path, "**"), recursive=True):
            if os.path.isfile(f):
                try:
                    total += os.path.getsize(f)
                except OSError:
                    pass
        return total

    def _file_size(path):
        try:
            return os.path.getsize(path)
        except OSError:
            return 0

    def _index_dir_stats(path):
        """(total bytes, .db file count) for an index directory, (0, 0) if absent."""
        if not os.path.isdir(path):
            return 0, 0
        return _dir_size(path), len(_glob.glob(os.path.join(path, "*.db")))

    titles_dir = os.path.join(data_dir, "titles")
    title_bytes, title_count = _index_dir_stats(titles_dir)
    qid_bytes, qid_count = _index_dir_stats(os.path.join(data_dir, "qids"))
    metadata_bytes = _file_size(os.path.join(data_dir, "cache.json"))
    suggest_bytes = _file_size(os.path.join(data_dir, "suggest_cache.json"))

    # Catalog caches = the JSON metadata/catalog files at the data-dir root
    # (metadata cache, suggest cache, offline catalog, history, layout, …).
    catalog_bytes = 0
    if os.path.isdir(data_dir):
        for f in _glob.glob(os.path.join(data_dir, "*.json")):
            catalog_bytes += _file_size(f)

    # Staging = in-progress downloads. May live outside the data dir (env
    # override), so track whether it's already counted in the dir walk.
    from zimi import p2p as _p2p

    staging_dir = _p2p.get_staging_dir(data_dir)
    staging_bytes = _dir_size(staging_dir) if os.path.isdir(staging_dir) else 0
    staging_in_data = os.path.abspath(staging_dir).startswith(
        os.path.abspath(data_dir) + os.sep
    )

    data_total = _dir_size(data_dir) if os.path.isdir(data_dir) else 0
    accounted = (
        title_bytes
        + qid_bytes
        + catalog_bytes
        + (staging_bytes if staging_in_data else 0)
    )
    other_bytes = max(0, data_total - accounted)

    # Top per-ZIM contributors: title-index files are one .db per ZIM.
    top_zims = []
    if os.path.isdir(titles_dir):
        sizes = []
        for f in _glob.glob(os.path.join(titles_dir, "*.db")):
            name = os.path.basename(f)[: -len(".db")]
            sizes.append({"name": name, "size_bytes": _file_size(f)})
        sizes.sort(key=lambda s: s["size_bytes"], reverse=True)
        top_zims = sizes[:6]

    caches = {
        "title_indexes": {
            "path": "titles/",
            "size_bytes": title_bytes,
            "count": title_count,
        },
        "qid_indexes": {"path": "qids/", "size_bytes": qid_bytes, "count": qid_count},
        "metadata_cache": {"path": "cache.json", "size_bytes": metadata_bytes},
        "suggest_cache": {"path": "suggest_cache.json", "size_bytes": suggest_bytes},
    }
    breakdown = [
        {"key": "title_indexes", "size_bytes": title_bytes, "count": title_count},
        {"key": "qid_indexes", "size_bytes": qid_bytes, "count": qid_count},
        {"key": "catalog_caches", "size_bytes": catalog_bytes},
        {"key": "staging", "size_bytes": staging_bytes},
        {"key": "other", "size_bytes": other_bytes},
    ]
    bar_total = sum(seg["size_bytes"] for seg in breakdown)
    return {
        "caches": caches,
        "total_bytes": sum(c["size_bytes"] for c in caches.values()),
        "data_dir_total_bytes": bar_total,
        "breakdown": breakdown,
        "top_zims": top_zims,
    }


# ============================================================================
# Library layout — shared validate/apply (used by /manage/library-layout POST
# and the backup importer so the two never drift).
# ============================================================================


def _validate_library_layout(overrides, order, sections=None):
    """Return an error string if `overrides`/`section_order`/`sections` are
    malformed, else None. Any may be None (that half is simply skipped)."""
    if overrides is not None:
        if (
            not isinstance(overrides, dict)
            or len(overrides) > _srv._LAYOUT_MAX_OVERRIDES
        ):
            return "invalid overrides"
        for k, v in overrides.items():
            if (
                not isinstance(k, str)
                or not isinstance(v, str)
                or len(k) > _srv._LAYOUT_STR_MAX
                or len(v) > _srv._LAYOUT_STR_MAX
            ):
                return "invalid overrides"
    if order is not None:
        if not isinstance(order, list) or len(order) > _srv._LAYOUT_MAX_ORDER:
            return "invalid section_order"
        for s in order:
            if (
                not isinstance(s, str)
                or len(s) > _srv._LAYOUT_STR_MAX
                or not _srv._SECTION_KEY_RE.match(s)
            ):
                return "invalid section_order"
    if sections is not None:
        if not isinstance(sections, list) or len(sections) > _srv._LAYOUT_MAX_SECTIONS:
            return "invalid sections"
        for s in sections:
            if not isinstance(s, str) or not s or len(s) > _srv._LAYOUT_STR_MAX:
                return "invalid sections"
    return None


def _apply_library_layout(overrides, order, sections=None):
    """Merge-patch the persisted layout. `overrides` merges key-by-key (empty
    value clears an entry); `section_order` and `sections` fully replace when
    present. Returns the saved layout. Caller must have validated first."""
    with _srv._library_layout_lock:
        layout = _srv._load_library_layout()
        if overrides is not None:
            merged = dict(layout.get("overrides", {}))
            for k, v in overrides.items():
                if v == "":
                    merged.pop(k, None)  # empty value = revert to heuristic
                else:
                    merged[k] = v
            layout["overrides"] = merged
        if order is not None:
            layout["section_order"] = list(order)
        if sections is not None:
            # De-dupe case-insensitively, first spelling wins, so a declared
            # empty section can't accumulate near-duplicate rows.
            seen, deduped = set(), []
            for name in sections:
                key = name.strip().lower()
                if key and key not in seen:
                    seen.add(key)
                    deduped.append(name)
            layout["sections"] = deduped
        _srv._save_library_layout(layout)
    return layout


# ============================================================================
# Backup bundle — export/import a Zimi setup.
#
# SCHEMA (zimi-backup, version 3). Two scopes:
#   • "device" — everyone's backup: the installed library list, collections/
#     favorites, and the home layout. The client folds its own per-browser
#     state (bookmarks/history/preferences) in on top; that never touches the
#     server. This is the v1 shape plus a `scope` field. (The redesigned SPA
#     splits this: the "My data" card round-trips the per-browser half through
#     /userdata for a signed-in user; the "Server backup" card owns everything
#     below. The device bundle stays for API clients and back-compat.)
#   • "server" — ADMIN-ONLY. Everything the server owns: the device fields
#     PLUS users.json (WITH password hashes — it's the admin's own backup),
#     the anonymous-access policy, the download schedule, the BitTorrent/
#     sharing prefs, the seed-intent ledger, and (v3) the hot-cache list, the
#     auto-update config, the server-side event history, and every named
#     user's server-stored My-data blob (user_data).
#
# Import MERGES by default (union by identity, incoming wins on conflict) and
# is a two-step: a "preview" pass returns a diff summary and applies nothing;
# only an explicit "apply" writes. An `overwrite` flag replaces wholesale where
# the caller wants that. Keep `_BACKUP_SCHEMA_VERSION` in lockstep with the
# client's `_BACKUP_SCHEMA_VERSION`.
# ============================================================================

_BACKUP_SCHEMA = "zimi-backup"
_BACKUP_SCHEMA_VERSION = 3

# Every restorable state key a bundle can carry, in plan order. The headless
# CLI (`zimi restore`) reports "skipped" as the bundle keys the apply plan did
# not touch (env-locked settings, server keys riding on a device-scope
# bundle), so this list must stay in lockstep with the labels that
# _compute_backup and _plan_server_scope emit.
_BUNDLE_STATE_KEYS = (
    "collections",
    "library_layout",
    "users",
    "public_access",
    "schedule",
    "bt_prefs",
    "seed_intents",
    "hot_zims",
    "auto_update",
    "history",
    "user_data",
)


def _bundle_scope(data):
    """The scope a bundle declares. Missing (v1 bundles) → 'device'. Anything
    other than 'server' is treated as 'device' so server-only keys can never be
    processed off a device bundle."""
    return (
        "server"
        if (isinstance(data, dict) and data.get("scope") == "server")
        else "device"
    )


def _build_backup_bundle(scope="device"):
    """Assemble a backup bundle. ``scope='server'`` adds the admin-only server
    state on top of the device fields (caller enforces the admin gate)."""
    library = [
        {
            "name": z["name"],
            "file": z.get("file"),
            "date": z.get("date", ""),
            "language": z.get("language", ""),
            "article_count": z.get("article_count"),
            "size_bytes": z.get("size_bytes"),
            "title": z.get("title", z["name"]),
        }
        for z in _srv.list_zims()
    ]
    bundle = {
        "schema": _BACKUP_SCHEMA,
        "schema_version": _BACKUP_SCHEMA_VERSION,
        "scope": "device",
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "zimi_version": _srv.ZIMI_VERSION,
        "library": library,
        "collections": _srv._load_collections(),
        "library_layout": _srv._load_library_layout(),
    }
    if scope == "server":
        from zimi import library as _lib
        from zimi import p2p
        from zimi import users as _users

        sched = _lib._load_download_schedule()
        mode, allow, _ = _users._load_access()
        au_enabled, au_freq = _lib._load_auto_update_config()
        bundle["scope"] = "server"
        bundle["users"] = _users._load_users()  # WITH hashes — admin's own backup
        bundle["public_access"] = {"mode": mode, "allowlist": allow}
        bundle["schedule"] = {
            "enabled": sched["enabled"],
            "start": sched["start"],
            "end": sched["end"],
            "upload_restrict": sched["upload_restrict"],
            "upload_trickle_kb": sched["upload_trickle_kb"],
        }
        bundle["bt_prefs"] = p2p.all_prefs()
        bundle["seed_intents"] = _lib.seed_ledger_snapshot()
        # v3 additions — the rest of what a full restore needs to resurrect an
        # instance: the hot-cache list, the auto-update config, the server-side
        # event history, and every named user's server-stored My-data blob.
        bundle["hot_zims"] = _srv.get_hot_zims()
        bundle["auto_update"] = {"enabled": au_enabled, "frequency": au_freq}
        bundle["history"] = _srv._load_history()
        bundle["user_data"] = _users.all_user_data()
    return bundle


# ── Merge primitives (pure — compute the merged value + counts, persist later) ──


def _collection_newer(incoming, current):
    """Conflict winner for a same-named collection. Honors an optional
    ``updated`` epoch when both carry one; otherwise incoming wins (it's the
    backup the admin chose to restore)."""
    try:
        inc_t = float(incoming.get("updated"))
        cur_t = float(current.get("updated"))
    except (TypeError, ValueError):
        return True
    return inc_t >= cur_t


def _merge_collections(cur, incoming, overwrite):
    """Union favorites (dedupe) and named collections (by name, newest-wins).
    Returns (merged, counts)."""
    inc_fav = [f for f in incoming.get("favorites", []) if isinstance(f, str)]
    inc_cols = incoming.get("collections", {})
    if overwrite:
        fav = list(dict.fromkeys(inc_fav))[:100]
        merged = {"version": 1, "favorites": fav, "collections": dict(inc_cols)}
        counts = {
            "fav_added": len(fav),
            "fav_dupes": 0,
            "col_added": len(inc_cols),
            "col_replaced": 0,
        }
        return merged, counts
    fav = list(cur.get("favorites", []))
    dupes = 0
    for f in inc_fav:
        if f in fav:
            dupes += 1
        else:
            fav.append(f)
    cols = dict(cur.get("collections", {}))
    added = replaced = 0
    for name, obj in inc_cols.items():
        if name in cols:
            if _collection_newer(obj, cols[name]):
                cols[name] = obj
            replaced += 1
        else:
            cols[name] = obj
            added += 1
    merged = {"version": 1, "favorites": fav[:100], "collections": cols}
    counts = {
        "fav_added": max(0, len(fav[:100]) - len(cur.get("favorites", []))),
        "fav_dupes": dupes,
        "col_added": added,
        "col_replaced": replaced,
    }
    return merged, counts


def _merge_layout(cur, incoming, overwrite):
    """Merge the home layout: overrides union (incoming wins per ZIM), sections
    union, section_order replaced when present (an ordering — merging is
    meaningless). Returns (overrides, order, sections, counts)."""
    inc_over = incoming.get("overrides") or {}
    inc_order = incoming.get("section_order")
    inc_sections = incoming.get("sections") or []
    cur_over = cur.get("overrides") or {}
    cur_sections = cur.get("sections") or []
    if overwrite:
        over = dict(inc_over)
        order = inc_order if isinstance(inc_order, list) else cur.get("section_order")
        sections = list(inc_sections)
        counts = {
            "over_added": len(inc_over),
            "over_changed": 0,
            "order_changed": inc_order is not None,
            "sections_added": len(inc_sections),
        }
        return over, order, sections, counts
    over = dict(cur_over)
    added = changed = 0
    for k, v in inc_over.items():
        if k in over:
            if over[k] != v:
                changed += 1
                over[k] = v
        else:
            over[k] = v
            added += 1
    sections = list(cur_sections)
    sec_added = 0
    seen = {s.strip().lower() for s in cur_sections if isinstance(s, str)}
    for s in inc_sections:
        if isinstance(s, str) and s.strip().lower() not in seen:
            seen.add(s.strip().lower())
            sections.append(s)
            sec_added += 1
    order = inc_order if isinstance(inc_order, list) else cur.get("section_order")
    counts = {
        "over_added": added,
        "over_changed": changed,
        "order_changed": isinstance(inc_order, list)
        and inc_order != cur.get("section_order"),
        "sections_added": sec_added,
    }
    return over, order, sections, counts


def _merge_users(cur, incoming, overwrite):
    """Union users by casefold key; incoming wins on conflict (or replace all
    when overwrite). Returns (merged, counts)."""
    from zimi import users as _users

    inc = {
        _users._key(v.get("name", k)): v
        for k, v in incoming.items()
        if isinstance(v, dict)
    }
    if overwrite:
        return inc, {"added": len(inc), "replaced": 0}
    merged = dict(cur)
    added = replaced = 0
    for k, v in inc.items():
        if k in merged:
            if merged[k] != v:
                replaced += 1
            merged[k] = v
        else:
            merged[k] = v
            added += 1
    return merged, {"added": added, "replaced": replaced}


def _compute_backup(data, overwrite):
    """Diff an incoming bundle against current server state WITHOUT persisting.

    Returns (plan, preview, error). ``plan`` is a list of (label, thunk) pairs
    the apply pass runs in order; ``preview`` is the diff summary the client
    shows before the admin confirms. Server-only keys are considered only for a
    ``server``-scope bundle, so a device bundle can never carry server changes.
    """
    if not isinstance(data, dict):
        return None, None, "invalid backup"
    schema = data.get("schema")
    if schema is not None and schema != _BACKUP_SCHEMA:
        return None, None, "not a Zimi backup"
    scope = _bundle_scope(data)
    plan = []
    preview: dict = {"scope": scope}

    coll = data.get("collections")
    if coll is not None:
        if not isinstance(coll, dict):
            return None, None, "invalid collections"
        fav = coll.get("favorites", [])
        cols = coll.get("collections", {})
        if not isinstance(fav, list) or not isinstance(cols, dict):
            return None, None, "invalid collections"
        merged, counts = _merge_collections(_srv._load_collections(), coll, overwrite)
        preview["collections"] = counts
        plan.append(("collections", lambda m=merged: _persist_collections(m)))

    layout = data.get("library_layout")
    if layout is not None:
        if not isinstance(layout, dict):
            return None, None, "invalid library_layout"
        over, order, sections, counts = _merge_layout(
            _srv._load_library_layout(), layout, overwrite
        )
        err = _validate_library_layout(over, order, sections)
        if err:
            return None, None, err
        preview["layout"] = counts
        plan.append(
            (
                "library_layout",
                lambda o=over, r=order, s=sections: _apply_library_layout(o, r, s),
            )
        )

    lib = data.get("library")
    if isinstance(lib, list):
        installed = set(_srv.get_zim_files().keys())
        preview["missing_zims"] = sum(
            1 for z in lib if isinstance(z, dict) and z.get("name") not in installed
        )

    if scope == "server":
        err = _plan_server_scope(data, overwrite, plan, preview)
        if err:
            return None, None, err

    return plan, preview, None


def _persist_collections(merged):
    with _srv._collections_lock:
        _srv._save_collections(merged)


def _plan_server_scope(data, overwrite, plan, preview):
    """Extend the plan/preview with the admin-only server state. Returns an
    error string or None."""
    from zimi import library as _lib
    from zimi import p2p
    from zimi import users as _users

    users = data.get("users")
    if users is not None:
        if not isinstance(users, dict):
            return "invalid users"
        merged, counts = _merge_users(_users._load_users(), users, overwrite)
        preview["users"] = counts
        plan.append(("users", lambda m=merged: _users._save_users(m)))

    settings_changed = []

    pa = data.get("public_access")
    if isinstance(pa, dict):
        mode = pa.get("mode")
        allow = pa.get("allowlist", [])
        cur_mode, cur_allow, _ = _users._load_access()
        if mode != cur_mode or allow != cur_allow:
            settings_changed.append("public_access")
        plan.append(
            ("public_access", lambda m=mode, a=allow: _users.set_public_access(m, a))
        )

    sched = data.get("schedule")
    if isinstance(sched, dict):
        cur = _lib._load_download_schedule()
        keys = ("enabled", "start", "end", "upload_restrict", "upload_trickle_kb")
        if any(sched.get(k) != cur.get(k) for k in keys if k in sched):
            settings_changed.append("download_schedule")
        plan.append(("schedule", lambda s=sched: _restore_schedule(s)))

    bt = data.get("bt_prefs")
    if isinstance(bt, dict):
        if bt != p2p.all_prefs():
            settings_changed.append("sharing_prefs")
        plan.append(("bt_prefs", lambda b=bt: _restore_bt_prefs(b, overwrite)))

    intents = data.get("seed_intents")
    if isinstance(intents, dict):
        cur = _lib.seed_ledger_snapshot()
        preview["seed_intents"] = {
            "added": sum(1 for k, v in intents.items() if cur.get(k) != v)
        }
        plan.append(
            ("seed_intents", lambda i=intents: _lib.restore_seed_intents(i, overwrite))
        )

    # v3 server state — hot list, auto-update, history, per-user data.
    hot = data.get("hot_zims")
    if isinstance(hot, list):
        # Env-locked hot list (ZIMI_HOT_ZIMS) is authoritative — never clobber it.
        if "ZIMI_HOT_ZIMS" not in os.environ:
            if hot != _srv.get_hot_zims():
                settings_changed.append("hot_zims")
            plan.append(
                (
                    "hot_zims",
                    lambda h=[s for s in hot if isinstance(s, str)]: _srv.set_hot_zims(
                        h
                    ),
                )
            )

    au = data.get("auto_update")
    if isinstance(au, dict) and "enabled" in au and "frequency" in au:
        # Env-locked auto-update (ZIMI_AUTO_UPDATE) wins — skip the restore.
        if not getattr(_srv, "_auto_update_env_locked", False):
            cur_en, cur_fr = _lib._load_auto_update_config()
            if bool(au["enabled"]) != cur_en or au["frequency"] != cur_fr:
                settings_changed.append("auto_update")
            plan.append(("auto_update", lambda a=au: _restore_auto_update(a)))

    history = data.get("history")
    if isinstance(history, list):
        preview["history"] = {"events": len(history)}
        plan.append(("history", lambda h=history: _restore_history(h, overwrite)))

    ud = data.get("user_data")
    if isinstance(ud, dict):
        preview["user_data"] = {"users": len(ud)}
        plan.append(("user_data", lambda u=ud: _users.restore_user_data(u, overwrite)))

    if settings_changed:
        preview["settings"] = settings_changed
    return None


def _restore_auto_update(au):
    from zimi import library as _lib

    enabled, freq = bool(au.get("enabled")), au.get("frequency", "weekly")
    _lib._save_auto_update_config(enabled, freq)
    # Reflect into the live server namespace so /manage/status reads true without
    # a restart (the loop reads these via _srv — see library._auto_update_loop).
    _srv._auto_update_enabled = enabled
    _srv._auto_update_freq = freq


def _restore_history(entries, overwrite):
    """Restore server-side event history. Replace when overwrite; otherwise fill
    only when the current log is empty (a resurrected instance) so a normal merge
    into a running server never duplicates or reorders its real event stream."""
    if overwrite or not _srv._load_history():
        _srv._save_history(entries)


def _restore_schedule(sched):
    from zimi import library as _lib

    cur = _lib._load_download_schedule()
    _lib._save_download_schedule(
        sched.get("enabled", cur["enabled"]),
        sched.get("start", cur["start"]),
        sched.get("end", cur["end"]),
        sched.get("upload_restrict", cur["upload_restrict"]),
        sched.get("upload_trickle_kb", cur["upload_trickle_kb"]),
    )


def _restore_bt_prefs(bt, overwrite):
    from zimi import p2p

    p2p.replace_prefs(bt, overwrite=overwrite)
    p2p.apply_rate_limits()


def _apply_backup_bundle(data, overwrite=False):
    """Apply a backup bundle (MERGE by default). Returns (result, error).

    Prefer the two-step route contract (preview then apply); this runs the whole
    plan in one shot for direct callers/tests. ``result`` carries the applied
    keys plus the preview summary."""
    plan, preview, err = _compute_backup(data, overwrite)
    if err or plan is None:
        return None, err
    applied = []
    for label, thunk in plan:
        thunk()
        applied.append(label)
    return {"status": "ok", "applied": applied, "preview": preview}, None


# ============================================================================
# The activity journal — what happened to this library, and who did it
#
# Every kind of change already left a trace SOMEWHERE: downloads and updates in
# history.json, creation runs in create_jobs.json, health checks and exports in
# a status dict that a restart forgets. None of them recorded WHO, which is the
# question an operator actually asks of a shared server — a ZIM updated by the
# auto-updater and the same ZIM updated by a person are the same row in the old
# history, and only one of them means someone made a decision.
#
# So: one line per thing that happened, stamped where it happens, carrying the
# actor with it. Downloads learn their actor at submission and carry it to the
# finish line (the stamp fires in a background thread minutes later, long after
# the request that asked for it is gone).
#
# The discipline is the create journal's: bounded, atomic, and soft — a journal
# that cannot be written costs a log line, never the operation. Nothing in here
# may raise into a caller's success path.
# ============================================================================

ACTIVITY_FILE = "activity.json"
# Deep enough to cover a busy week of a real library, shallow enough that the
# whole file is one small read and the view never needs paging.
ACTIVITY_RECORDS = 200
# The kinds of thing that happen to a library. A type outside this set is still
# recorded — the client renders it with the generic icon — but everything Zimi
# itself stamps is named here, and the filter is built from what is present.
ACTIVITY_TYPES = (
    "download",
    "update",
    "create",
    "export",
    "delete",
    "health",
    "restore",
    "import",
)
ACTIVITY_OUTCOMES = ("ok", "failed", "cancelled", "interrupted")
# Both are display fields; a runaway error string must not be able to grow the
# journal past the size that keeps it a cheap read.
ACTIVITY_SUBJECT_MAX = 160
ACTIVITY_DETAIL_MAX = 200
# The name a request gets when it is authenticated as the primary admin — the
# account with a password rather than a user record, so there is no username to
# borrow. Secondary admins and ordinary users keep their own names.
ACTIVITY_ADMIN = "admin"
# Work nobody asked for in the moment: the auto-updater, the download scheduler,
# resumes after a restart. `name` stays null — "server" is the whole identity.
ACTIVITY_SERVER_ACTOR = {"kind": "server", "name": None}
# Pre-1.9 history has no actor, and guessing one would be worse than saying so.
ACTIVITY_UNKNOWN_ACTOR = {"kind": "unknown", "name": None}
# How the pre-1.9 event names map into activity types when the old history is
# folded in (see _activity_seed).
_ACTIVITY_FROM_HISTORY = {
    "download": ("download", "ok"),
    "updated": ("update", "ok"),
    "download_failed": ("download", "failed"),
    "deleted": ("delete", "ok"),
}

_activity_lock = threading.Lock()
_activity = None  # list of records, oldest first; loaded once per process


def _activity_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, ACTIVITY_FILE)


def activity_actor(handler=None):
    """Who is responsible for what is about to happen.

    ``handler`` is the request that asked for it, or None for work the server
    started by itself. Every caller with a request passes it — these routes are
    admin-gated, so a request that got this far is *somebody*, and the only
    question is whether that somebody has a name of their own.
    """
    if handler is None:
        return dict(ACTIVITY_SERVER_ACTOR)
    name = None
    try:
        from zimi import users as _users

        name = _users.resolve_request_user(handler)
    except Exception as e:
        # An unreadable session store must not cost the operation its actor
        # line, let alone the operation.
        log.debug("Could not resolve the actor for an activity record: %s", e)
    return {"kind": "user", "name": name or ACTIVITY_ADMIN}


def _activity_clean_actor(actor):
    """A stored actor dict, whatever shape the caller handed us."""
    if not isinstance(actor, dict):
        return dict(ACTIVITY_SERVER_ACTOR)
    kind = actor.get("kind")
    if kind not in ("user", "server", "unknown"):
        kind = "server"
    name = actor.get("name")
    if kind != "user" or not isinstance(name, str) or not name.strip():
        return {"kind": kind, "name": None}
    return {"kind": "user", "name": name.strip()[:ACTIVITY_SUBJECT_MAX]}


def _activity_seed():
    """The journal a fresh install of 1.9 is born with: the old history.

    An upgrade must not look like data loss. Everything the pre-1.9 history
    recorded is an activity record missing exactly one field — who — so it
    converts cleanly, and the actor it converts to is ``unknown`` rather than a
    guess. Runs once: after this the file exists and the stamps take over.
    """
    seeded = []
    try:
        events = _srv._load_history()
    except Exception as e:
        log.debug("No history to seed the activity journal from: %s", e)
        return seeded
    # History is newest first and this journal is oldest first.
    for event in reversed(events if isinstance(events, list) else []):
        if not isinstance(event, dict):
            continue
        mapped = _ACTIVITY_FROM_HISTORY.get(str(event.get("event") or ""))
        if not mapped:
            continue
        event_type, outcome = mapped
        subject = (
            event.get("title")
            or event.get("name")
            or str(event.get("filename") or "").removesuffix(".zim")
        )
        seeded.append(
            _activity_record(
                event_type,
                subject,
                outcome=outcome,
                detail=str(event.get("error") or "")[:ACTIVITY_DETAIL_MAX],
                actor=dict(ACTIVITY_UNKNOWN_ACTOR),
                size_bytes=event.get("size_bytes"),
                ts=event.get("ts"),
            )
        )
    return seeded[-ACTIVITY_RECORDS:]


def _activity_load():
    """The journal, loaded once per process. Caller holds ``_activity_lock``."""
    global _activity
    if _activity is not None:
        return _activity
    records = None
    try:
        with open(_activity_path(), encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, list):
            records = [r for r in loaded if isinstance(r, dict)]
    except FileNotFoundError:
        pass  # fresh install, or the first boot after the upgrade
    except (OSError, ValueError) as e:
        # Corrupt or unreadable degrades to empty: the view is a nicety, and
        # nothing else in the server may fail because of it.
        log.warning("Cannot read the activity journal: %s", e)
        records = []
    fresh = records is None
    if fresh:
        records = _activity_seed()
    trimmed = len(records) > ACTIVITY_RECORDS
    if trimmed:
        # Trimmed on the way in as well as out — the bound is what the file is
        # allowed to be, not merely what this process appends to it.
        del records[: len(records) - ACTIVITY_RECORDS]
    _activity = records
    if (fresh and records) or trimmed:
        _activity_save()
    return records


def _activity_save():
    """Caller holds ``_activity_lock``. Never raises: a thing that happened
    still happened when the disk says no."""
    _srv._atomic_write_json(_activity_path(), _activity or [])


def _activity_record(
    event_type,
    subject,
    outcome="ok",
    detail="",
    actor=None,
    size_bytes=None,
    count=None,
    ts=None,
):
    """One journal record. Every field is already visible to the admin who is
    reading it — subjects are library names and titles, never server paths.

    ``detail`` is a locale-neutral FRAGMENT, not a sentence: a source URL, a
    ratio, an error the transport handed us. The verb around it ("Downloaded",
    "Update installed") is an i18n key on the client, because a sentence
    written here would be the one line of the UI that cannot be translated.
    ``bytes`` and ``count`` travel as numbers for the same reason — the client
    formats them in the reader's locale. What ``count`` counts is fixed per
    type: bookmarks for an export, restored sections for a restore.
    """
    record = {
        "ts": round(float(ts if ts is not None else time.time()), 3),
        "type": str(event_type or "")[:40],
        "actor": _activity_clean_actor(actor),
        "subject": str(subject or "")[:ACTIVITY_SUBJECT_MAX],
        "outcome": outcome if outcome in ACTIVITY_OUTCOMES else "ok",
        "detail": str(detail or "")[:ACTIVITY_DETAIL_MAX],
    }
    if isinstance(size_bytes, (int, float)) and size_bytes > 0:
        record["bytes"] = int(size_bytes)
    if isinstance(count, int) and count > 0:
        record["count"] = count
    return record


def record_activity(
    event_type,
    subject,
    outcome="ok",
    detail="",
    actor=None,
    size_bytes=None,
    count=None,
):
    """Append one line to the activity journal. Never raises.

    Called from request handlers, from download threads long after their
    request ended, and from the create watchdog — so it takes its own lock and
    holds no other.
    """
    try:
        record = _activity_record(
            event_type,
            subject,
            outcome=outcome,
            detail=detail,
            actor=actor,
            size_bytes=size_bytes,
            count=count,
        )
        with _activity_lock:
            records = _activity_load()
            records.append(record)
            if len(records) > ACTIVITY_RECORDS:
                del records[: len(records) - ACTIVITY_RECORDS]
            _activity_save()
        return record
    except Exception as e:
        log.warning("Could not journal a %s activity record: %s", event_type, e)
        return None


# Two operations answer their caller immediately and finish on a worker thread:
# the library health check and the bookmark export. Both report through a status
# dict the client polls, and neither should learn about this journal — one of
# them writes ZIMs for a living. So the route that started the work watches that
# status instead, and files the line when it settles.
ACTIVITY_WATCH_TICK = 1.0
# Long enough for a health check over a 600 GB library on a spinning NAS disk,
# short enough that a wedged worker does not leave a thread waiting forever.
ACTIVITY_WATCH_MAX = 6 * 3600


def _activity_after(state_fn, finish):
    """Watch a background job's status dict; call ``finish(state)`` once it
    leaves the running phase. Runs on its own daemon thread and never raises
    into it."""

    def _wait():
        deadline = time.time() + ACTIVITY_WATCH_MAX
        while time.time() < deadline:
            time.sleep(ACTIVITY_WATCH_TICK)
            try:
                state = state_fn() or {}
            except Exception as e:
                log.debug("Activity watch could not read a job's state: %s", e)
                return
            if state.get("phase") == "running":
                continue
            try:
                finish(state)
            except Exception as e:
                log.warning("Activity watch could not file its record: %s", e)
            return
        # Past the deadline the honest thing is silence: a record saying "ok"
        # would be a guess, and one saying "failed" would be a lie about work
        # that may still be running.
        log.info("Activity watch gave up waiting for a background job to settle")

    threading.Thread(target=_wait, daemon=True, name="zimi-activity-watch").start()


def _activity_health_finish(actor):
    """Journal a finished library health check under whoever asked for it."""

    def _finish(state):
        summary = state.get("summary") or {}
        total = summary.get("total") or 0
        healthy = summary.get("healthy") or 0
        record_activity(
            "health",
            "",  # the whole library — the client names it in the reader's language
            outcome="ok" if state.get("phase") == "done" else "failed",
            detail=f"{healthy}/{total}" if total else "",
            actor=actor,
        )

    return _finish


def _activity_export_finish(actor, total):
    """Journal a finished bookmark export. ``total`` is what was handed to the
    writer — the count the person chose, which is the count they'll recognize
    even if a source article turned out to be unreadable."""

    def _finish(state):
        files = [str(f) for f in (state.get("files") or []) if f]
        record_activity(
            "export",
            ", ".join(f.removesuffix(".zim") for f in files),
            outcome="ok" if state.get("phase") == "done" else "failed",
            detail=str(state.get("error") or ""),
            actor=actor,
            count=total,
        )

    return _finish


def _activity_actor_key(record):
    """The filter value for a record's actor: a username, or the kind."""
    actor = record.get("actor") or {}
    if actor.get("kind") == "user" and actor.get("name"):
        return actor["name"]
    return actor.get("kind") or "server"


def activity_payload(type_filter=None, actor_filter=None):
    """The activity view's data: records newest first, plus the vocabulary the
    filter is built from.

    The type and actor lists are always computed over the WHOLE journal, never
    over the filtered slice — a filter whose own options disappear the moment
    you use one is a filter you cannot get back out of.
    """
    with _activity_lock:
        records = list(_activity_load())
    types = sorted({str(r.get("type") or "") for r in records} - {""})
    actors = sorted({_activity_actor_key(r) for r in records})
    if type_filter:
        records = [r for r in records if r.get("type") == type_filter]
    if actor_filter:
        records = [r for r in records if _activity_actor_key(r) == actor_filter]
    records.reverse()  # newest first, the way it is read
    return {"records": records, "types": types, "actors": actors}


# ============================================================================
# ZIM creation jobs — the web face of `zimi create` / `zimi import`
#
# ONE job RUNS at a time, deliberately. The hardware floor for Zimi is a Pi
# that is also serving the library; a second concurrent crawl would not go
# twice as fast, it would make reading the library miserable while both crawl
# badly. What a second submission gets is a place in a short FIFO queue, not a
# refusal — "start it, I'll come back" is what people actually mean when they
# fill the form twice, and a queue says that honestly where a 409 made them
# babysit the tab.
#
# The engines (zimi.creator / crawler / video / importer) stay almost
# untouched: each already takes a per-line progress callback, and this module
# wires that into a bounded ring buffer the browser polls with a cursor.
# Cancellation is cooperative through that same callback — it raises out of
# the engine at the next line, which unwinds through ``atomic_zim_creator`` so
# no partial ZIM is ever left under a real name. Folder mode is the one engine
# with no callback, so it cannot be interrupted mid-run and the status says so
# rather than pretending.
#
# Three things the round-3 field test asked for, and where each lives:
#
#   "is it stable if I close the page?"  — the job runs in a server thread and
#       its state is server-side, so closing the tab changes nothing. What was
#       missing is what happens when the SERVER goes away mid-job: the journal
#       below records every job to disk, and a record still marked running at
#       the next boot becomes an honest "interrupted", not a ghost that polls
#       forever. The atomic writer has already removed its partial output.
#   "can I find in-progress ones?"       — ``/manage/create/status?history=1``
#       hands back the last CREATE_JOURNAL_RECORDS jobs, so a returning admin
#       finds what happened while they were gone.
#   "do multiple queue?"                 — yes; see CREATE_QUEUE_MAX.
#
# Alongside the human log lines, the poll carries STRUCTURED events (phase /
# node / count) on their own cursor. They are DERIVED here by reading the same
# lines the engines already emit — the engines do not learn a second output
# format they would then have to keep in step, and a line this adapter cannot
# read costs one event, never a crash.
# ============================================================================

# "folder" stays in the tuple although the web REFUSES it (Eric: "remove
# folder, I said that would be CLI only") — recognising the mode is what lets
# the refusal point at `zimi create <folder>` instead of shrugging "unknown
# creation mode" at someone who read about it in the docs.
CREATE_MODES = ("folder", "page", "site", "video", "import")
# Which engine captures a web page. Mirrors creator.CAPTURE_ENGINES, held here
# as a literal for the same reason CREATE_MAX_PAGE_URLS is: validating a
# request must not drag the writer stack into the request thread. The test
# below pins the two together. zimit is deliberately NOT offered over the web —
# it wants a docker daemon, and a web form is the wrong place to discover that.
CREATE_ENGINES = ("builtin", "rendered", "alive")
# The engines that can refuse a request before it is made — the ones that drive
# a browser. Mirrors creator.BLOCKING_ENGINES, held here for the same reason
# CREATE_ENGINES is, and pinned to it by the same test.
CREATE_BLOCKING_ENGINES = ("rendered", "alive")
# What ad blocking does when the form says nothing. Mirrors
# renderer.BLOCK_ADS_DEFAULT: the checkbox arrives checked, so a request with no
# opinion in it is one where the field never rendered at all.
CREATE_BLOCK_ADS = True
# The engines that sweep up the image sizes THIS screen did not ask for. Only
# the recording engine does: a rendered capture keeps one candidate per srcset
# and has no archive to put the others in, so offering the switch alongside it
# would be offering a switch over nothing. Mirrors the gate in
# renderer.RenderedSession._record_variants, pinned by a test.
CREATE_VARIANT_ENGINES = ("alive",)
# What the variant sweep does when the form says nothing. Mirrors
# renderer.VARIANT_SWEEP_DEFAULT — checked by default, so silence means the
# field never rendered rather than "the admin unticked it".
CREATE_CAPTURE_VARIANTS = True
# ── Stored capture defaults ──────────────────────────────────────────────────
# The two module constants above (CREATE_BLOCK_ADS / CREATE_CAPTURE_VARIANTS)
# are the FACTORY defaults — what the engines do on a machine nobody has
# configured. An admin may override either from Manage → Creator, and that
# choice persists in the data dir like every other manage-set preference (see
# _write_app_update_prefs for the pattern). Every reader of a default goes
# through _create_default so a stored choice wins everywhere at once: the
# validator applying it to a silent request, and the payload reporting it.


def _create_defaults_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, "create_defaults.json")


def _read_create_defaults():
    try:
        with open(_create_defaults_path(), "r", encoding="utf-8") as f:
            saved = json.load(f)
    except (OSError, ValueError):
        return {}
    return saved if isinstance(saved, dict) else {}


def _create_default(key, fallback):
    """The stored default for ``key``, or ``fallback`` when nobody ever set
    one. Only a real boolean in the file counts — a hand-edited string like
    "yes" falls back rather than being guessed at."""
    value = _read_create_defaults().get(key)
    return value if isinstance(value, bool) else fallback


def _write_create_defaults(**updates):
    """Merge into the defaults file — setting one switch must never drop the
    other's stored answer."""
    prefs = _read_create_defaults()
    prefs.update(updates)
    _srv._atomic_write_json(_create_defaults_path(), prefs)


# Ring-buffer depth for job output. A long crawl emits a line per page, so the
# buffer is a live tail, not a transcript — the browser polls faster than it
# fills and keeps everything it has already seen.
CREATE_LOG_LINES = 500
CREATE_MAX_SOURCE = 2048  # a path or URL longer than this is not a real one
# Mirrors creator.MAX_PAGE_URLS. Held here as a constant rather than imported at
# module scope so validating a request never drags in the writer stack; the
# test below pins the two together.
CREATE_MAX_PAGE_URLS = 20

# Which jobs can actually be interrupted. Cancellation is cooperative — it
# raises out of the engine's progress callback — so a mode belongs here exactly
# when its engine takes one. Every mode the web still runs qualifies (folder,
# the one engine with no progress callback, is CLI-only now), but the list and
# the `cancellable` field stay: the client's button should keep answering to
# the server's word rather than to an assumption a future mode could break.
CREATE_CANCELLABLE_MODES = ("page", "site", "video", "import")
# Which jobs can FINISH EARLY — stop fetching at the next page boundary and
# package everything captured so far, exactly what SIGINT does to a CLI crawl.
# Site capture alone: it is the one mode whose work is an open-ended frontier
# with something worth keeping at every prefix. A page list or a playlist is a
# finite order (cancel covers changing your mind), and an import has no
# fetching to stop.
CREATE_FINISHABLE_MODES = ("site",)
# The phases in which finishing early still means anything: the network pass.
# From `package`/`convert` on, the fetching is over and the button would stop
# nothing — the client hides it the moment the server stops saying so.
CREATE_FINISHABLE_PHASES = ("probe", "fetch", "assets")
CREATE_MAX_TITLE = 200
# Site crawls: what the form offers. Wider bounds live on the CLI.
CREATE_MAX_PAGES_CEILING = 5000
CREATE_MAX_DEPTH_CEILING = 10
CREATE_MAX_DELAY = 60.0  # seconds between page requests
# Video jobs: a playlist cap, same reasoning.
CREATE_VIDEO_LIMIT_CEILING = 500
# Size budgets. The ceiling is not a guess about disk, it is about the shape of
# a job a browser tab is willing to watch — past this, use the CLI.
CREATE_MAX_BYTES_CEILING = 64 * 1024**3
CREATE_MAX_SIZE_TEXT = 32  # "512MiB" is 6; nothing real is longer than this
_CREATE_LANGUAGE_RE = re.compile(r"^[a-z]{2,3}$")
# The video quality the web form may ask for, as named presets mapped to yt-dlp
# selectors. A preset name is the ONLY thing accepted over HTTP: yt-dlp's format
# argument is an expression language, and an arbitrary expression arriving from
# a browser is not a preference, it is an instruction to a downloader. The full
# selector stays on `zimi create --format`, where the person typing it is at a
# shell on the machine already.
CREATE_VIDEO_FORMATS = {
    "720p": None,  # the engine's own default
    "1080p": "best[height<=1080][ext=mp4]/best[height<=1080]/best",
    "480p": "best[height<=480][ext=mp4]/best[height<=480]/best",
    "best": "best",
}

# How many submissions may wait behind the running one. Five is a queue an
# admin can hold in their head; past that the honest answer is "come back
# later" (429) rather than a backlog nobody remembers filing.
CREATE_QUEUE_MAX = 5
# Structured events, bounded exactly like the log lines. A long crawl emits
# one per page twice over (fetched, then packaged), so this is a live tail too.
CREATE_EVENT_BUFFER = 2000
# A job that has not said anything for this long is not working, it is wedged —
# a host that accepted a connection and never answered, a subprocess that never
# wrote another line. Ten minutes is longer than any single legitimate step:
# every engine reports per page, per entry or per subprocess line, and the
# slowest of those is one HTTP fetch at DEFAULT_FETCH_TIMEOUT (30s).
CREATE_STALL_SECONDS = 600
CREATE_STALL_TICK = 15.0  # how often the watchdog looks
# The on-disk job journal: how a returning admin finds out what happened while
# they were away, and how a job that was running when the server died stops
# being a job that is running forever.
CREATE_JOURNAL_FILE = "create_jobs.json"
CREATE_JOURNAL_RECORDS = 20
# The phases a job moves through, in order. The client renders them; the
# adapter below decides when each begins by reading the engines' own lines.
# ``convert`` is the warc2zim subprocess: the phase where a recording (alive)
# or an archive somebody brought (import) becomes a ZIM. It sits beside
# ``package`` rather than replacing it because they are alternatives — a job
# does one or the other, never both — and the client folds them onto the same
# visible step, which is the right answer for a person watching: both of them
# are "it is writing the file now".
CREATE_PHASES = ("probe", "fetch", "assets", "package", "convert", "register", "done")
# Where a mode's work starts. The URL modes fetch first; import has nothing to
# fetch, it goes straight to writing a ZIM.
CREATE_START_PHASE = {
    "import": "package",
    "page": "fetch",
    "site": "fetch",
    "video": "fetch",
}

_create_lock = threading.Lock()
_create_job = None  # the one _CreateJob running (or the last one to finish)
_create_queue = []  # [(job, opts)] waiting their turn, FIFO


class _CreateCancelled(Exception):
    """Raised out of a job's progress callback when the admin cancels."""


class _CreateJob:
    """One creation run: its identity, its output tail, and its outcome."""

    def __init__(self, mode, source, title):
        # Short, random, and only ever compared for equality: the client uses it
        # to tell "my job" from "the job that started after mine finished", and
        # the journal uses it to update a record in place.
        self.id = os.urandom(6).hex()
        self.mode = mode
        self.source = source
        self.title = title
        # Whoever submitted it, for the activity journal. A job created outside
        # a request (the CLI, a test) belongs to the server.
        self.actor = dict(ACTIVITY_SERVER_ACTOR)
        self.lines = []  # tail, trimmed to CREATE_LOG_LINES
        self.emitted = 0  # total lines ever produced — the cursor space
        self.events = []  # tail, trimmed to CREATE_EVENT_BUFFER
        self.events_emitted = 0  # the events' own cursor space
        self.phase = CREATE_START_PHASE.get(mode, "fetch")
        self.queued_at = time.time()
        self.started = None  # set when it actually leaves the queue
        self.finished = None
        # Last sign of life, for the watchdog. A job that has never emitted a
        # line is measured from the moment it started, not from creation, or a
        # long wait in the queue would count against it.
        self.progressed = None
        self.done = False
        self.ok = False
        self.cancelled = False
        self.cancel_requested = False
        self.stalled = False
        self.error = ""
        self.result = None
        # Finish-early (site mode): the admin asked the crawl to stop fetching
        # and package what it has. `stop_flag` is the crawler's own stop flag,
        # attached by _create_run once the crawl exists; the boolean is set
        # first so a request that lands in the gap is honored when it does.
        self.finish_requested = False
        self.stop_flag = None
        # A transient caption ("starting a headless browser…") is on the run
        # pane and the next real progress event should take it down. Only ever
        # touched from the job's own thread, inside _create_derive.
        self.transient_detail = False
        # Set the moment the job is closed out, whoever closes it. The watchdog
        # waits on this rather than on a clock, so it wakes exactly once per
        # tick while the job runs and not at all after it ends — no thread
        # loitering behind a finished job with a sleep still to serve.
        self.settled = threading.Event()

    # -- output ------------------------------------------------------------
    def note(self, message):
        """Progress sink handed to the engines. Doubles as the cancellation
        checkpoint: a pending cancel raises here, at a line boundary.

        Takes a line of text, as every engine sends today, or a ready-made
        event dict for a caller that has something structured to say and no
        sentence to go with it. Engines only ever send text — the CLI's sink
        prints whatever it is handed, and a dict on a terminal is not progress.
        """
        if self.cancel_requested:
            raise _CreateCancelled()
        now = time.time()
        if isinstance(message, dict):
            with _create_lock:
                self.progressed = now
                self._push_events([dict(message)])
            return
        text = str(message).rstrip("\n")
        # Derived outside the lock: it parses a string and may import a module,
        # and the sink is called from the job thread on every line.
        events, phase = _create_derive(self, text)
        with _create_lock:
            self.progressed = now
            self.lines.append(text)
            self.emitted += 1
            if len(self.lines) > CREATE_LOG_LINES:
                del self.lines[: len(self.lines) - CREATE_LOG_LINES]
            self._push_events(events)
        if phase:
            # A phase change is rare (four or five in a whole job) and is
            # exactly what a returning admin wants to see, so it is worth a
            # journal write where a per-page line would not be.
            self.phase = phase
            _create_journal_put(self)

    def _push_events(self, events):
        """Stamp each event with its sequence number and file it. Caller holds
        ``_create_lock``."""
        for event in events:
            event["i"] = self.events_emitted
            self.events_emitted += 1
            self.events.append(event)
        if len(self.events) > CREATE_EVENT_BUFFER:
            del self.events[: len(self.events) - CREATE_EVENT_BUFFER]

    def tail(self, cursor):
        """Lines from ``cursor`` onward plus the new cursor. A cursor older
        than the buffer silently snaps forward — dropped lines are gone, and
        replaying nothing beats replaying the wrong window."""
        with _create_lock:
            first = self.emitted - len(self.lines)
            start = max(0, cursor - first)
            return self.lines[start:], self.emitted

    def event_tail(self, cursor):
        """The same contract as ``tail``, in the events' own cursor space."""
        with _create_lock:
            first = self.events_emitted - len(self.events)
            start = max(0, cursor - first)
            return list(self.events[start:]), self.events_emitted


# ── structured progress events ──────────────────────────────────────────────
#
# The engines speak in sentences meant for a human reading a log. The Create
# page wants a shape: which phase, which node, how many of how many. Rather
# than teach five engines a second output format — one more thing to keep in
# step, and one more way for a CLI sink to print a dict at somebody — this
# reads the lines that already exist and derives the shape from them.
#
# Three event kinds, all carrying an ``i`` sequence number stamped on the way
# into the buffer:
#
#   {"i", "t":"phase", "phase": <CREATE_PHASES>, "detail": <short>}
#   {"i", "t":"node",  "kind":"page|asset|entry", "id", "parent", "label",
#                      "state":"pending|active|done|failed"}
#   {"i", "t":"count", "what":"entries|bytes|assets", "n", "total"}
#
# ``count`` is scoped to the phase in force when it arrives: entries during
# ``fetch`` are pages pulled off the network, entries during ``package`` are
# pages written into the ZIM.
#
# ``parent`` is set on ASSET nodes and null on page nodes, and the difference
# is what the engine actually knows. The crawler fetches an asset because a
# named page referenced it, so that parentage is measured. It reports which
# page it captured but never which page linked to it, so page parentage would
# have to be invented — and a tree the engine did not measure is a prettier lie
# than a flat list. The client derives page parentage from the site's own
# address space and lets a server-supplied parent win, so if the crawler ever
# does report link provenance nothing downstream has to change.

_CREATE_RE_STEP = re.compile(r"^\[(\d+)/(\d+)\]\s+(.+)$")
_CREATE_RE_CRAWL_TAIL = re.compile(r"\s*\((\d+) queued(?:, (.+?) fetched)?\)$")
_CREATE_RE_PACKAGED = re.compile(r"^packaged (\d+)/(\d+)\s+(.+)$")
_CREATE_RE_PACKAGING_MANY = re.compile(r"^packaging (\d+) pages?\b")
_CREATE_RE_FETCHING = re.compile(r"^fetching (\S+)$")
_CREATE_RE_PACKAGING_ONE = re.compile(r"^packaging (\S+)$")
_CREATE_RE_SKIPPED = re.compile(r"^skipped (\S+):")
_CREATE_RE_ASSET = re.compile(r"^asset (done|failed) (\S+) for (\S+)$")
# The Fast engine's running carry total, emitted at most once a second while it
# fetches a page's images during the write pass. Turns the packaging phase from
# a blank pane into live counters (Eric: "this view is still empty and lame").
_CREATE_RE_CARRIED = re.compile(r"^carried (\d+) assets, (\d+) bytes$")
_CREATE_RE_TITLE = re.compile(r"^title: (.+)$")
# Both doors into warc2zim announce themselves the same way — the alive engine
# handing over its recording, and `zimi import` handing over an archive
# somebody else made.
_CREATE_RE_CONVERTING = re.compile(r"^converting\b")
# The renderer's one line between "job started" and its first page: Chromium
# can take many seconds to boot, and without this the run pane sat silent for
# all of them (Eric: "show something right now — I need to open the log thing
# to see what's happening").
_CREATE_RE_BROWSER = re.compile(r"^starting a headless browser")
_CREATE_LABEL_MAX = 80


def _create_short_label(target):
    """The bit of a URL or article path worth showing in a node: the path (and
    the query that paginates it), or the host when the path is just ``/``."""
    text = str(target).strip()
    if text.startswith(("http://", "https://")):
        parts = urllib.parse.urlsplit(text)
        path = parts.path or "/"
        if path == "/" and parts.netloc:
            text = parts.netloc
        else:
            text = path + (("?" + parts.query) if parts.query else "")
    return text[:_CREATE_LABEL_MAX]


def _create_parse_bytes(text):
    """The byte count back out of a size the engines formatted ("759.0 KB").
    ``crawler.parse_size`` already reads every spelling the CLI accepts, so it
    reads this one too — bar the bare "N bytes" form, unwrapped here so the
    two halves stay one dialect. None when it is not a size at all."""
    raw = str(text).strip()
    if raw.lower().endswith("bytes"):
        raw = raw[:-5].strip()
    try:
        from zimi.crawler import parse_size

        return parse_size(raw)
    except Exception:
        return None


def _create_node_event(kind, node_id, state, label=None, parent=None):
    return {
        "t": "node",
        "kind": kind,
        "id": str(node_id)[:CREATE_MAX_SOURCE],
        "parent": str(parent)[:CREATE_MAX_SOURCE] if parent else None,
        "label": _create_short_label(label if label is not None else node_id),
        "state": state,
    }


def _create_count_event(what, n, total=None):
    return {"t": "count", "what": what, "n": int(n), "total": total}


def _create_derive(job, text):
    """Events (and the phase they imply) from one line of engine output.

    Returns ``(events, phase_or_None)``. Never raises: a line this does not
    recognise is simply a line with no events behind it, which is the right
    outcome for engine output that is prose."""
    try:
        return _create_derive_line(job, text)
    except Exception:  # a log line must never be able to fail a job
        log.debug("could not derive create events from %r", text, exc_info=True)
        return [], None


def _create_derive_line(job, text):
    line = text.strip()
    events, phase = [], None

    def enter(name):
        nonlocal phase
        # The membership check is the contract, enforced: the client renders a
        # fixed set of phases, and a name outside it would be a phase that
        # silently draws nothing.
        assert name in CREATE_PHASES, name
        if job.phase != name and phase != name:
            phase = name
            job.transient_detail = False  # a fresh phase brings its own detail
            events.append({"t": "phase", "phase": name, "detail": job.mode})

    def settle():
        """Real progress after a transient caption: re-state the phase with its
        plain detail — the client blanks detail == mode — so "starting a
        headless browser…" comes down the moment actual work reports again."""
        if job.transient_detail:
            job.transient_detail = False
            if not any(e.get("t") == "phase" for e in events):
                events.append({"t": "phase", "phase": job.phase, "detail": job.mode})

    if _CREATE_RE_BROWSER.match(line):
        # Between a rendered/alive job starting and its first page there are
        # 5–15 silent seconds of Chromium booting. Re-announcing the CURRENT
        # phase with this line as its detail puts the sentence on the run pane
        # the moment it happens — same event vocabulary, no second channel —
        # and settle() above takes it back down at the next real progress.
        job.transient_detail = True
        events.append({"t": "phase", "phase": job.phase, "detail": line})
        return events, phase

    match = _CREATE_RE_PACKAGED.match(line)
    if match:  # site capture, one page written into the ZIM
        enter("package")
        settle()
        events.append(_create_node_event("entry", match.group(3), "done"))
        events.append(
            _create_count_event("entries", match.group(1), int(match.group(2)))
        )
        return events, phase

    match = _CREATE_RE_CARRIED.match(line)
    if match:  # the write pass reporting what it has pulled in so far
        settle()
        events.append(_create_count_event("assets", int(match.group(1))))
        events.append(_create_count_event("bytes", int(match.group(2))))
        return events, phase

    match = _CREATE_RE_ASSET.match(line)
    if match:  # one image, stylesheet or font, and the page that wanted it
        state, asset_id, page_id = match.groups()
        settle()
        events.append(
            _create_node_event(
                "asset",
                asset_id,
                state,
                label=asset_id.rsplit("/", 1)[-1],
                parent=page_id,
            )
        )
        return events, phase

    match = _CREATE_RE_PACKAGING_MANY.match(line)
    if match:  # site capture, the whole write pass announcing its size
        enter("package")
        settle()
        events.append(_create_count_event("entries", 0, int(match.group(1))))
        return events, phase

    match = _CREATE_RE_STEP.match(line)
    if match:
        done, total, rest = int(match.group(1)), int(match.group(2)), match.group(3)
        enter("fetch")
        settle()
        tail = _CREATE_RE_CRAWL_TAIL.search(rest)
        if tail:  # a site crawl: the remainder is a URL plus the running totals
            url = rest[: tail.start()].strip()
            events.append(_create_node_event("page", url, "done"))
            fetched = _create_parse_bytes(tail.group(2) or "")
            if fetched is not None:
                events.append(_create_count_event("bytes", fetched))
        else:  # a video playlist: the remainder is a title, not an address
            events.append(_create_node_event("entry", rest, "done"))
        events.append(_create_count_event("entries", done, total))
        return events, phase

    match = _CREATE_RE_FETCHING.match(line)
    if match:
        enter("fetch")
        settle()  # a page in flight means the browser is up
        events.append(_create_node_event("page", match.group(1), "active"))
        return events, phase

    match = _CREATE_RE_SKIPPED.match(line)
    if match:
        events.append(_create_node_event("page", match.group(1), "failed"))
        return events, phase

    match = _CREATE_RE_PACKAGING_ONE.match(line)
    if match:
        enter("package")
        target = match.group(1)
        if target.startswith(("http://", "https://")):
            # Multi-page capture writes one page at a time and says which.
            events.append(_create_node_event("page", target, "done"))
        return events, phase

    if _CREATE_RE_CONVERTING.match(line):
        enter("convert")
        return events, phase

    match = _CREATE_RE_TITLE.match(line)
    if match:
        # The engine has read what the thing it is making is called. Worth
        # having only when nobody typed a title — an admin's own title is a
        # decision, not a guess to be improved on. It goes straight onto the
        # job rather than out as an event: every status reply already carries
        # `title`, and the job's own thread is the only writer there is.
        if not job.title:
            job.title = match.group(1).strip()[:CREATE_MAX_TITLE]
        return events, phase

    # The engines' closing "done" line is deliberately NOT read as the done
    # phase: only the job knows whether it finished, was cancelled or was given
    # up on, so _create_finish is the single place that says so.
    return events, phase


def _create_emit(job, *events):
    """File events that did not come from a line — the totals a finished run
    knows and no sentence carried. Deliberately not ``job.note``: that is the
    cancellation checkpoint, and a job that has already succeeded must not be
    turned into a cancelled one by its own closing bookkeeping."""
    with _create_lock:
        job._push_events([dict(event) for event in events])


# ── the job journal ─────────────────────────────────────────────────────────
#
# Jobs live in memory, which is right for a live log and wrong for the only
# question an admin asks after a redeploy: what happened to the thing I
# started? The journal is a small JSON file of the last CREATE_JOURNAL_RECORDS
# jobs, rewritten at the few moments a job's state actually changes (queued,
# started, each phase, finished) — a handful of writes per job, not one per
# page.
#
# On the first read of a new process, any record still marked running or queued
# belongs to a server that is no longer here, and becomes "interrupted". That
# is not a guess: this process is holding the file, so nothing else is advancing
# those jobs. Their partial output is already gone — ``atomic_zim_creator``
# writes to ``<name>.zim.tmp`` and only renames on a clean exit, so a killed
# process leaves a tmp file and never a half-written ZIM under a real name.

_create_journal_lock = threading.Lock()
_create_journal = None  # list of records, loaded and reconciled once


def _create_journal_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, CREATE_JOURNAL_FILE)


def _create_job_state(job):
    """The one word for a job's state that the journal and the history view
    both use. Ordered by precedence: how it ended beats that it ended."""
    if not job.done:
        return "running" if job.started else "queued"
    if job.cancelled:
        return "cancelled"
    if job.stalled:
        return "stalled"
    return "ok" if job.ok else "failed"


def _create_job_record(job):
    """One journal record. Everything here is already visible to the admin who
    submitted the job — no server paths beyond the source they typed, and the
    result named the way the library names it."""
    return {
        "id": job.id,
        "mode": job.mode,
        "source": job.source[:CREATE_MAX_SOURCE],
        "title": job.title,
        "queued": round(job.queued_at, 3),
        "started": round(job.started, 3) if job.started else None,
        "finished": round(job.finished, 3) if job.finished else None,
        "phase": job.phase,
        "state": _create_job_state(job),
        "ok": bool(job.ok),
        "error": job.error,
        "result": (job.result or {}).get("name"),
        # What the run counted and whether it stopped short of its bounds.
        # Without these the journal answers "did my capture finish?" with a
        # bare ok — a crawl that died at its byte budget after 38 of a site's
        # pages read exactly like one that got everything (Eric's apple run:
        # diagnosing it meant re-deriving the budget math by hand).
        "counts": {
            k: v
            for k, v in (job.result or {}).items()
            if k in ("pages", "assets", "bytes", "files", "videos", "entries")
        }
        or None,
        "stopped": (job.result or {}).get("stopped"),
        "actor": _activity_clean_actor(getattr(job, "actor", None)),
    }


# A create job's own word for how it ended, in the activity journal's words. A
# stalled job failed — "gave up waiting" is the detail, not a fifth outcome.
_CREATE_ACTIVITY_OUTCOME = {
    "ok": "ok",
    "failed": "failed",
    "cancelled": "cancelled",
    "stalled": "failed",
    "interrupted": "interrupted",
}


def _create_activity(job):
    """File a settled creation run in the activity journal."""
    result = job.result or {}
    state = _create_job_state(job)
    record_activity(
        "create",
        result.get("title") or job.title or result.get("name") or job.source,
        outcome=_CREATE_ACTIVITY_OUTCOME.get(state, "failed"),
        # What it was made from is the one fact the subject cannot carry: two
        # ZIMs called "Docs" are told apart by the site they came from.
        detail=(job.error or job.source or job.mode),
        actor=getattr(job, "actor", None),
        size_bytes=result.get("bytes"),
    )


def _create_journal_load():
    """The journal, reconciled once per process. Caller must hold
    ``_create_journal_lock``."""
    global _create_journal
    if _create_journal is not None:
        return _create_journal
    records = []
    try:
        with open(_create_journal_path(), encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, list):
            records = [r for r in loaded if isinstance(r, dict)]
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as e:
        log.warning("Cannot read the create journal: %s", e)
    stale = False
    if len(records) > CREATE_JOURNAL_RECORDS:
        # Trimmed on the way IN as well as on the way out: the bound is what
        # this file is allowed to be, not merely what this process appends to
        # it, and a journal that arrived oversized (an older build, a hand
        # edit) must not be served or rewritten at that size.
        del records[: len(records) - CREATE_JOURNAL_RECORDS]
        stale = True
    for record in records:
        state = record.get("state")
        if state == "running":
            record["state"] = "interrupted"
            record["error"] = "interrupted: the server restarted during this job"
            stale = True
        elif state == "queued":
            record["state"] = "interrupted"
            record["error"] = "not started: the server restarted before this job began"
            stale = True
        else:
            continue
        # A job the server lost is still something that happened to this
        # library, and the activity view is where an operator looks to find out
        # why last night's ZIM never appeared. Recorded once: the reconcile
        # rewrites the state, so the next boot sees "interrupted" and no longer
        # matches here.
        record_activity(
            "create",
            record.get("title") or record.get("result") or record.get("source") or "",
            outcome="interrupted",
            detail=record.get("error") or "",
            actor=record.get("actor"),
        )
    _create_journal = records
    if stale:
        _create_journal_save()
    return records


def _create_journal_save():
    """Caller holds ``_create_journal_lock``. Never raises: a job that cannot
    be journalled is still a job that ran."""
    _srv._atomic_write_json(_create_journal_path(), _create_journal or [])


def _create_journal_put(job):
    """Record this job's current state, replacing its earlier record."""
    record = _create_job_record(job)
    with _create_journal_lock:
        records = _create_journal_load()
        for index, existing in enumerate(records):
            if existing.get("id") == job.id:
                records[index] = record
                break
        else:
            records.append(record)
        if len(records) > CREATE_JOURNAL_RECORDS:
            del records[: len(records) - CREATE_JOURNAL_RECORDS]
        _create_journal_save()


def _create_history():
    """The recent jobs, newest first — what a returning admin came back for."""
    with _create_journal_lock:
        return list(reversed(_create_journal_load()))


def _create_name_of(path):
    """The library name for a freshly written ZIM: its filename without the
    extension, which is exactly how the rest of the app addresses it."""
    base = os.path.basename(path or "")
    return base[:-4] if base.lower().endswith(".zim") else base


def _create_validate(data):
    """Validate a create request. Returns ``(mode, source, title, opts)`` or
    raises ValueError whose message is safe to send to the client — every one
    of them names something the admin typed, never anything internal."""
    mode = str(data.get("mode") or "").strip().lower()
    if mode not in CREATE_MODES:
        raise ValueError("unknown creation mode")
    source = str(data.get("source") or "").strip()
    if not source:
        raise ValueError("missing source")
    # Page mode takes a LIST — one address per line — so its ceiling is the cap
    # times a URL, not a single URL.
    ceiling = CREATE_MAX_SOURCE * (CREATE_MAX_PAGE_URLS if mode == "page" else 1)
    if len(source) > ceiling:
        raise ValueError("source is too long")
    title = str(data.get("title") or "").strip()[:CREATE_MAX_TITLE]
    page_urls = []

    if mode == "folder":
        # CLI-only, by decree (Eric, round 3: "remove folder, I said that
        # would be CLI only"). The engine (creator.create_folder_zim) is
        # untouched — someone at a shell already has the filesystem this mode
        # reads. What is gone is the web door, and the refusal names the one
        # that is still open.
        raise ValueError(
            "folder capture is CLI-only — run `zimi create <folder>` "
            "on the server itself"
        )
    elif mode == "import":
        # CLI-only, by the same decree that took folder capture off the web
        # (Eric: "remove archive as well only in cli"). The engine
        # (importer.convert_archive) is untouched — `zimi import <file>` on the
        # machine itself still runs it. What is gone is the web door that read a
        # path off the server's disk, and the refusal names the one still open.
        raise ValueError(
            "web archive import is CLI-only — run `zimi import <file>` "
            "on the server itself"
        )
    elif mode == "page":
        # One page or twenty, it is the same gesture: paste what you want kept.
        # The engine sends a single URL down the single-page path itself, so
        # nothing here has to decide which kind of capture this is.
        page_urls = _create_page_urls(source)
        source = page_urls[0] if len(page_urls) == 1 else "\n".join(page_urls)
    else:
        source = _normalize_url_scheme(source)
        parts = urllib.parse.urlsplit(source)
        if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
            raise ValueError("not an http(s) URL")

    # Options. Numbers clamp (an absurd one means the admin misjudged a bound,
    # and the nearest legal value is what they meant); anything that is not a
    # number at all raises, because there is no "nearest" size or language code
    # and quietly running with a different one is worse than a refusal.
    opts = {}
    if mode == "page":
        opts["urls"] = page_urls
    if mode in ("folder", "page", "site", "video"):
        opts["language"] = _create_language(data.get("language"))
    if mode in ("page", "site"):
        # The two modes that capture a web page get to choose HOW. Refused
        # rather than clamped, like every other named value: silently capturing
        # the other way is the one outcome nobody asked for.
        opts["engine"] = _create_engine(data.get("engine"))
        # Ad and tracker blocking, but only for an engine that can do it. A
        # form left open while the engine radio moved back to the fast one can
        # send this; DROPPING it there is right where the CLI's refusal is
        # right — nobody typed this, a stale checkbox did, and refusing a whole
        # capture over a field that describes nothing would be theatre.
        if _create_blocking_engine(opts["engine"]):
            opts["block_ads"] = _create_bool(
                data.get("block_ads"), _create_default("block_ads", CREATE_BLOCK_ADS)
            )
        # The responsive-variant sweep, on the one engine that does it, and
        # dropped elsewhere for exactly the reason block_ads is dropped: a
        # stale checkbox from a form whose engine radio has since moved is not
        # a request anybody made.
        if _create_variant_engine(opts["engine"]):
            opts["capture_variants"] = _create_bool(
                data.get("capture_variants"),
                _create_default("capture_variants", CREATE_CAPTURE_VARIANTS),
            )
    if mode == "site":
        opts["max_pages"] = _create_int(
            data.get("max_pages"), 1, CREATE_MAX_PAGES_CEILING
        )
        opts["max_depth"] = _create_int(
            data.get("max_depth"), 0, CREATE_MAX_DEPTH_CEILING
        )
        opts["max_bytes"] = _create_bytes(data.get("max_bytes"))
        opts["delay"] = _create_float(data.get("delay"), 0.0, CREATE_MAX_DELAY)
        opts["ignore_robots"] = bool(data.get("ignore_robots"))
    elif mode == "video":
        opts["audio_only"] = bool(data.get("audio_only"))
        opts["limit"] = _create_int(data.get("limit"), 1, CREATE_VIDEO_LIMIT_CEILING)
        opts["max_bytes"] = _create_bytes(data.get("max_bytes"))
        opts["fmt"] = _create_video_format(data.get("format"), opts["audio_only"])
    return mode, source, title, opts


def _normalize_url_scheme(text):
    """Prepend https:// when someone typed a bare host — cnn.com, example.org/x
    — the way people actually type an address (Eric: "allow entering sites
    without https://"). An explicit scheme, a scheme-relative //host, a host:port,
    or a first segment with no dot (a typo or a local name) is left exactly as
    given for the validator to judge."""
    t = text.strip()
    if "://" in t or t.startswith("//"):
        return t
    head = t.split("/", 1)[0]
    if ":" in head:  # host:port or an unknown scheme — don't second-guess it
        return t
    if "." in head and " " not in head:
        return "https://" + t
    return t


def _create_page_urls(source):
    """One address per line into the list the multi-page capture takes. Blank
    lines are skipped and duplicates collapse, because pasting a list is how
    people produce both. Every entry is checked here so the refusal names the
    line that is wrong rather than failing an hour later on page eleven."""
    urls = []
    for line in str(source).splitlines():
        text = _normalize_url_scheme(line.strip())
        if not text:
            continue
        # The whole-field ceiling is the cap times a URL, so it cannot catch a
        # single absurd line. Each address carries the single-source bound.
        if len(text) > CREATE_MAX_SOURCE:
            raise ValueError("one of those addresses is too long")
        parts = urllib.parse.urlsplit(text)
        if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
            raise ValueError(f"not an http(s) URL: {text[:120]}")
        if text not in urls:
            urls.append(text)
    if not urls:
        raise ValueError("missing source")
    if len(urls) > CREATE_MAX_PAGE_URLS:
        raise ValueError(
            f"that is {len(urls)} addresses; {CREATE_MAX_PAGE_URLS} is the most "
            "one capture takes. A bigger set is a site crawl."
        )
    return urls


def _create_int(value, low, high):
    """Clamp an optional numeric form field into range; None when absent or
    unparseable, which every engine reads as "use your own default"."""
    if value in (None, ""):
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return max(low, min(high, n))


def _create_float(value, low, high):
    """The fractional twin of ``_create_int`` — crawl delay is sub-second."""
    if value in (None, ""):
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n or n in (float("inf"), float("-inf")):  # NaN / inf are not delays
        return None
    return max(low, min(high, n))


def _create_bytes(value):
    """A size budget typed as ``500M`` or ``2G``, in bytes and under the web
    ceiling. None when absent. Raises ValueError — which the route turns into a
    400 naming the fix — when it is not a size at all, because a budget nobody
    can read is not a budget to guess at."""
    if value in (None, ""):
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) > CREATE_MAX_SIZE_TEXT:
        raise ValueError("that is not a byte size")
    # The crawler's parser is the one that already understands every form the
    # CLI accepts (512MiB, 2G, 1048576); the web form must not invent a second
    # dialect of the same field.
    from zimi.crawler import parse_size
    from zimi.creator import CreateError

    try:
        return min(CREATE_MAX_BYTES_CEILING, parse_size(text))
    except CreateError as e:
        raise ValueError(str(e))


def _create_language(value):
    """An ISO 639-3 content language for the ZIM's metadata and its full-text
    index. Free text, so it is checked rather than clamped."""
    if value in (None, ""):
        return None
    code = str(value).strip().lower()
    if not _CREATE_LANGUAGE_RE.match(code):
        raise ValueError("language must be a code like eng, fra or ara")
    return code


def _create_engine(value):
    """Which capture engine a web capture asked for. None when nobody said,
    which every caller reads as "the fast one" — the default lives in the
    engines, not in three copies of the word "builtin"."""
    if value in (None, ""):
        return None
    name = str(value).strip().lower()
    if name not in CREATE_ENGINES:
        raise ValueError("unknown capture engine")
    # Refused HERE rather than an hour into a job: both of these are separate
    # installs, and a form that accepts a choice this machine cannot honour is
    # a form that lies.
    if name == "rendered" and not _create_browser_ready():
        raise ValueError(
            "the rendered engine needs a browser this server does not have " "installed"
        )
    if name == "alive" and not _create_alive_ready():
        raise ValueError(
            "the alive engine needs both a browser and the warc2zim sidecar, "
            "and this server is missing at least one of them"
        )
    return name


def _create_blocking_engine(engine):
    """Whether the chosen engine can block anything. ``None`` is the fast
    engine — the default lives in the engines, and it does not block."""
    return str(engine or "").strip().lower() in CREATE_BLOCKING_ENGINES


def _create_variant_engine(engine):
    """Whether the chosen engine sweeps up responsive image variants, which is
    to say whether the switch means anything. ``None`` is the fast engine."""
    return str(engine or "").strip().lower() in CREATE_VARIANT_ENGINES


def _create_bool(value, default):
    """A checkbox that is CHECKED by default, read as a real bool.

    Every other bool on this form is off until someone turns it on, so absence
    and false are the same statement and ``bool(value)`` is the whole reader.
    This one is on until someone turns it OFF, which makes absence ambiguous —
    a client that omits the field means "I never drew this", and only an
    explicit ``false`` means "I unticked it"."""
    if value is None:
        return default
    if isinstance(value, str):
        # A form-encoded post has no JSON booleans; "false" from one of those
        # is a false, not a non-empty string.
        return value.strip().lower() not in ("", "0", "false", "no", "off")
    return bool(value)


def _create_video_format(value, audio_only):
    """A named quality preset from the form, as the engine's format selector.
    Audio-only owns the format entirely, so a preset alongside it is dropped
    rather than fought over."""
    if audio_only or value in (None, ""):
        return None
    key = str(value).strip()
    if key not in CREATE_VIDEO_FORMATS:
        raise ValueError("unknown video quality — pick one of the offered ones")
    return CREATE_VIDEO_FORMATS[key]


def _create_kwargs(opts, *names):
    """Only the options the admin actually set. Every engine defaults these
    itself, and passing None would override the default with nothing."""
    return {name: opts[name] for name in names if opts.get(name) is not None}


def _create_out_dir():
    """Web-created ZIMs land in <zim_dir>/created — the folder the library
    files as its Created section, which is where an admin who just watched a
    job finish goes looking. A ZIM dropped in the library root instead is
    filed under its language with everything else and reads as missing (found
    the hard way: Eric's first real capture "didn't show in the created
    list"). The CLI keeps the root default; --out keeps winning there."""
    return os.path.join(_srv.ZIM_DIR, "created")


def _create_run(job, opts):
    """Drive the engine for one job. Imports are deferred to here: the writer
    stack and yt-dlp are heavy, and a server that never creates a ZIM should
    never pay for them. (Neither folder nor archive import reaches here — the
    web refuses both at validation; `zimi create <folder>` and `zimi import
    <file>` are their only doors.)"""
    if job.mode == "page":
        # create_pages_zim hands a single URL to create_page_zim itself, so one
        # entry point covers both shapes — and it takes a progress callback,
        # which is what gives page mode a live log and a cancel at all.
        from zimi.creator import create_pages_zim

        return create_pages_zim(
            opts.get("urls") or [job.source],
            title=job.title or None,
            out_dir=_create_out_dir(),
            register=True,
            progress=job.note,
            **_create_kwargs(
                opts, "language", "engine", "block_ads", "capture_variants"
            ),
        )
    if job.mode == "site":
        from zimi.crawler import _StopFlag, create_site_zim

        # The finish-early control's handle on the crawl: the same stop flag
        # the CLI's SIGINT sets, owned by the job so the route can reach it.
        # Seeded from finish_requested so a request that raced job startup is
        # not lost in the gap.
        stop = _StopFlag()
        stop.hit = job.finish_requested
        job.stop_flag = stop
        return create_site_zim(
            job.source,
            title=job.title or None,
            out_dir=_create_out_dir(),
            register=True,
            progress=job.note,
            stop=stop,
            **_create_kwargs(
                opts,
                "max_pages",
                "max_depth",
                "max_bytes",
                "delay",
                "ignore_robots",
                "language",
                "engine",
                "block_ads",
                "capture_variants",
            ),
        )
    if job.mode == "video":
        from zimi.video import create_video_zim

        return create_video_zim(
            job.source,
            title=job.title or None,
            out_dir=_create_out_dir(),
            audio_only=opts.get("audio_only", False),
            register=True,
            progress=job.note,
            **_create_kwargs(opts, "limit", "max_bytes", "fmt", "language"),
        )
    # Only the three URL modes reach here; validation refuses everything else
    # (folder and archive import are CLI-only). A job that arrived with any
    # other mode is a bug in the caller, not an input to run.
    raise ValueError(f"no web engine for mode {job.mode!r}")


def _create_worker(job, opts):
    """Job thread body. Never raises — every outcome becomes job state."""
    from zimi.creator import CreateError

    outcome: dict = {}
    try:
        result = _create_run(job, opts)
        outcome = {
            "ok": True,
            "result": {
                "name": _create_name_of(result.get("path")),
                # What the admin asked this ZIM to be called, when they said.
                # The library lists ZIMs by title, so a done card that only
                # showed the filename would name it differently from where it
                # just landed.
                "title": job.title,
                "path": result.get("path"),
                "registered": bool(result.get("registered")),
            },
        }
        # What the run counted, when it counted anything: every engine returns a
        # different subset, and a done card that can say "40 pages, 118 assets"
        # should not have to read it back out of the log.
        for key in ("pages", "assets", "bytes", "files", "videos", "entries"):
            if isinstance(result.get(key), int):
                outcome["result"][key] = result[key]
        # The bound that ended a crawl early ("interrupted", "page cap (200)"),
        # when one did. The done card owes the admin that honesty — a ZIM that
        # says "40 pages" without saying "and I stopped there on purpose" reads
        # like a capture that thinks it got everything.
        if result.get("stopped"):
            outcome["result"]["stopped"] = str(result["stopped"])
        # What the finished ZIM is actually MADE of — on-disk size and the
        # per-kind split behind it. "382 assets" says nothing about whether that
        # is mostly pictures or mostly fonts, and a number with no shape is not
        # information (Eric, on the done card: "show a storage breakdown, total
        # size of the zim and its components"). Best effort by construction: a
        # breakdown that cannot be read never costs a finished capture.
        try:
            from zimi.zimwriter import zim_content_breakdown

            shape = zim_content_breakdown(result.get("path"))
            if shape:
                outcome["result"]["shape"] = shape
        except Exception:
            log.debug("content breakdown skipped", exc_info=True)
        # Totals only the finished run knows: no line carried them, so they are
        # filed straight rather than parsed back out of prose.
        totals = [
            _create_count_event(what, result[key])
            for what, key in (("entries", "pages"), ("assets", "assets"))
            if isinstance(result.get(key), int)
        ]
        if totals:
            _create_emit(job, *totals)
        if result.get("registered"):
            _create_emit(job, {"t": "phase", "phase": "register", "detail": job.mode})
        job.note("done")
    except _CreateCancelled:
        outcome = {
            "cancelled": True,
            "error": "cancelled — nothing was added to the library",
        }
    except CreateError as e:
        # The ONE place a caught message reaches the client verbatim, and it is
        # the point of the exception: CreateError carries the sentence that
        # names the fix ("capture it with zimit…", "yt-dlp is not installed…").
        # Every other exception below stays generic.
        outcome = {"error": str(e)}
    except Exception:
        log.exception("ZIM creation failed (%s)", job.mode)
        outcome = {"error": "creation failed — see the server log for details"}
    _create_finish(job, **outcome)


def _create_finish(job, **outcome):
    """Close a job ONCE and hand the slot to whatever is waiting.

    Both the worker thread and the watchdog can arrive here for the same job —
    a stalled job that later unwedges, say — so the first one wins and the
    second is a no-op. Otherwise a job could be finished twice and the queue
    advanced twice, running two creations at once on a machine chosen for
    being able to run one."""
    with _create_lock:
        if job.done:
            return False
        for key, value in outcome.items():
            setattr(job, key, value)
        if job.phase != "done":
            job.phase = "done"
        job.finished = time.time()
        # Journal BEFORE done becomes visible: a status poll learns "done"
        # from the flag, and history must already agree by then — otherwise
        # one reply can say done while its own history says running. The
        # journal write is a ~1KB file behind its own lock; paying it inside
        # this lock is what makes the two truths one truth.
        job.done = True
        _create_journal_put(job)
    _create_emit(job, {"t": "phase", "phase": "done", "detail": _create_job_state(job)})
    # The create journal serves the Create page; the activity journal serves the
    # operator asking what has been happening to this library. A settled job is
    # one line in each — but this one is written HERE, after the done event is
    # published and before waiters are released. Between the done FLAG going up
    # (under the lock, with the create journal) and the done EVENT reaching the
    # stream there must be nothing: a poll that sees done and then reads the
    # events expects the last one to be there, and a file write in that gap is
    # long enough to lose the race.
    _create_activity(job)
    job.settled.set()
    _create_start_next()
    return True


def _create_watch(job):
    """Watchdog thread. A job that has not reported for CREATE_STALL_SECONDS is
    not slow, it is stuck on something that will never answer, and the honest
    thing is to say so and free the slot rather than spin a progress bar until
    somebody restarts the server.

    It cannot KILL the worker — Python threads do not work that way, and the
    thread is blocked inside a socket read. So it does both things it can: ask
    for cancellation, which lands if the engine ever reaches another checkpoint,
    and close the job out. Whatever the wedged step was doing carries on in the
    background until it times out; it writes to a temp file under a name of its
    own, so nothing it does can corrupt what the library already has."""
    tick = min(CREATE_STALL_TICK, max(0.01, CREATE_STALL_SECONDS))
    while not job.settled.wait(tick):
        since = job.progressed or job.started or job.queued_at
        if time.time() - since < CREATE_STALL_SECONDS:
            continue
        job.cancel_requested = True
        # A cooperative cancel lands at the engine's next progress line, and a
        # wedged job by definition may never reach one. A browser is the one
        # thing that can be stopped from out here regardless: it is a child
        # process, and a signal does not need the job's thread to cooperate.
        _create_kill_browsers()
        minutes = int(CREATE_STALL_SECONDS // 60) or 1
        log.warning(
            "create job %s (%s) made no progress for %ss — abandoning it",
            job.id,
            job.mode,
            int(CREATE_STALL_SECONDS),
        )
        _create_finish(
            job,
            stalled=True,
            error=(
                f"no progress for {minutes} minutes — giving up on this job. "
                "Whatever it was waiting for never answered. Nothing has been "
                "added to the library."
            ),
        )
        return


def _create_launch(job, opts):
    """Start a claimed job: its worker thread and its watchdog."""
    job.started = time.time()
    job.progressed = job.started
    # The opening phase, so the event stream describes itself from event 0 and
    # a client that joined late is never guessing which phase the counts below
    # belong to.
    _create_emit(job, {"t": "phase", "phase": job.phase, "detail": job.mode})
    _create_journal_put(job)
    threading.Thread(
        target=_create_worker, args=(job, opts), daemon=True, name="zimi-create"
    ).start()
    threading.Thread(
        target=_create_watch, args=(job,), daemon=True, name="zimi-create-watch"
    ).start()


def _create_start_next():
    """Hand the slot to the head of the queue, if anything is waiting and the
    slot is actually free. The free check is not belt-and-braces: dropping a
    QUEUED job also finishes a job, and that must not start a second one on top
    of the one already running."""
    global _create_job
    with _create_lock:
        if _create_job is not None and not _create_job.done:
            return
        if not _create_queue:
            return
        job, opts = _create_queue.pop(0)
        _create_job = job
    _create_launch(job, opts)


def _create_start(data, actor=None):
    """Validate, then either claim the single job slot or take a place in the
    queue behind whatever holds it. Returns ``(payload, status)`` ready to
    send.

    ``actor`` is whoever submitted it — captured here because the job outlives
    its request by an hour, and the activity journal is written at the end.
    """
    try:
        mode, source, title, opts = _create_validate(data)
    except ValueError as e:
        return {"error": str(e)}, 400
    global _create_job
    job = _CreateJob(mode, source, title)
    if actor:
        job.actor = actor
    position = 0
    with _create_lock:
        running = _create_job if (_create_job and not _create_job.done) else None
        if running is not None:
            if len(_create_queue) >= CREATE_QUEUE_MAX:
                return (
                    {
                        "error": (
                            f"{CREATE_QUEUE_MAX} jobs are already waiting — "
                            "let some of them finish first"
                        ),
                        "queued": len(_create_queue),
                    },
                    429,
                )
            _create_queue.append((job, opts))
            position = len(_create_queue)
        else:
            _create_job = job
    if running is not None:
        _create_journal_put(job)
        return {
            "status": "queued",
            "id": job.id,
            "mode": mode,
            "position": position,
            # What it is waiting behind, so the reply explains itself without a
            # second round trip.
            "running": {"id": running.id, "mode": running.mode},
        }, 200
    _create_launch(job, opts)
    return {"status": "started", "id": job.id, "mode": mode}, 200


def _create_queue_view():
    """The waiting jobs, in the order they will run."""
    with _create_lock:
        waiting = list(_create_queue)
    return [
        {
            "id": job.id,
            "mode": job.mode,
            "source": job.source,
            "title": job.title,
            "position": position,
        }
        for position, (job, _opts) in enumerate(waiting, 1)
    ]


def _create_status(cursor, probe=False, events_cursor=0, history=False):
    """Poll payload. ``cursor`` is the client's line count so far and
    ``events_cursor`` its event count; the reply carries only what is new in
    each, plus the cursor to send next time."""
    job = _create_job
    payload: dict = {"offline": _is_offline_mode(), "queue": _create_queue_view()}
    if probe:
        # Only on the page's first poll: one cheap subprocess, not per-second.
        payload["import_ready"] = _create_import_ready()
        # Whether the rendered engine's browser is installed here. Same
        # contract as import_ready: asked once, on the page's first poll, and
        # answered from a cache after that.
        payload["browser_ready"] = _create_browser_ready()
        # And whether BOTH halves of the alive engine are here. Reported as its
        # own answer rather than left for the client to compute from the other
        # two: what the alive engine needs is the alive engine's business, and
        # a client that inferred it would have to be updated the day that
        # changes.
        payload["alive_ready"] = _create_alive_ready()
        # And whether yt-dlp is here. This one was missing, and its absence is
        # the whole reason the Create page offered a Video mode on an image
        # that had no yt-dlp in it — the Pillow bug's shape exactly: a
        # capability advertised by the client and absent from the server, with
        # nothing in between able to notice. The parity test in
        # tests/test_create_routes.py now fails if a mode is added without one.
        payload["video_ready"] = _create_video_ready()
        # The instance's stored capture defaults (Manage → Creator toggles),
        # so the form's checkboxes start where the admin set them instead of
        # at the factory state — the toggle would otherwise LOOK ignored.
        payload["capture_defaults"] = {
            "block_ads": _create_default("block_ads", CREATE_BLOCK_ADS),
            "capture_variants": _create_default(
                "capture_variants", CREATE_CAPTURE_VARIANTS
            ),
        }
        # None, not "", when no root is configured: the client reads it as a
        # yes/no about whether server-path capture exists on this instance at
        # all, and an empty string is a path that happens to be blank.
        payload["create_root"] = _create_root() or None
    if job is None:
        if history:
            payload["history"] = _create_history()
        payload.update(
            {
                "active": False,
                "done": False,
                "lines": [],
                "cursor": 0,
                "events": [],
                "event_cursor": 0,
            }
        )
        return payload
    # tail()/event_tail() take _create_lock themselves — call them OUTSIDE
    # the snapshot block below (the lock is not reentrant).
    lines, next_cursor = job.tail(max(0, cursor))
    events, next_events = job.event_tail(max(0, events_cursor))
    # Snapshot the scalar fields UNDER the finish lock, and read history only
    # after: _create_finish journals before it lets done become visible inside
    # the same critical section, so this ordering is what guarantees one reply
    # never says done while its own history still says running.
    with _create_lock:
        payload.update(
            {
                "id": job.id,
                "active": not job.done,
                "mode": job.mode,
                "source": job.source,
                "title": job.title,
                "phase": job.phase,
                "lines": lines,
                "cursor": next_cursor,
                "events": events,
                "event_cursor": next_events,
                "done": job.done,
                "ok": job.ok,
                "cancelled": job.cancelled,
                "stalled": job.stalled,
                "cancelling": job.cancel_requested and not job.done,
                "error": job.error,
                "result": job.result,
                # See CREATE_CANCELLABLE_MODES: a cancel button on a job with
                # no progress callback to interrupt would be a lie.
                "cancellable": job.mode in CREATE_CANCELLABLE_MODES,
                # The finish-early pair: whether the button means anything
                # right now, and whether it has already been pressed. Both
                # computed here so the client never has to know the rules.
                "finishable": _create_finishable(job),
                "finishing": job.finish_requested and not job.done,
                "elapsed": round(
                    (job.finished or time.time()) - (job.started or job.queued_at), 1
                ),
            }
        )
    if history:
        payload["history"] = _create_history()
    return payload


def _create_cancel(job_id=None):
    """Cancel the running job, or drop a queued one by id.

    Cancelling the running job is cooperative: it lands at the engine's next
    progress line, so the reply promises a request, not a stop. Dropping a
    queued job is immediate — it has not started, so there is nothing to
    unwind."""
    job_id = str(job_id or "").strip()
    if job_id:
        with _create_lock:
            for index, (job, _opts) in enumerate(_create_queue):
                if job.id == job_id:
                    del _create_queue[index]
                    break
            else:
                job = None
        if job is not None:
            _create_finish(
                job, cancelled=True, error="removed from the queue before it started"
            )
            return {"status": "dequeued", "id": job_id}, 200
        running = _create_job
        if running is None or running.done or running.id != job_id:
            return {"error": "no such creation job is waiting or running"}, 409
    job = _create_job
    if job is None or job.done:
        return {"error": "no creation job is running"}, 409
    job.cancel_requested = True
    return {
        "status": "cancelling",
        "id": job.id,
        "cancellable": job.mode in CREATE_CANCELLABLE_MODES,
    }, 200


def _create_finishable(job):
    """Whether "finish now" would still change anything: a site crawl that is
    in its network pass, not already being stopped some other way. From
    ``package``/``convert`` on the fetching is over and the offer would be
    theatre."""
    return (
        job.mode in CREATE_FINISHABLE_MODES
        and not job.done
        and not job.cancel_requested
        and job.phase in CREATE_FINISHABLE_PHASES
    )


def _create_finish_now():
    """Stop fetching and package what is captured — the web's SIGINT.

    Sets the crawl's own stop flag, so the loop ends at the next PAGE boundary
    and everything already captured proceeds to packaging/conversion exactly as
    a Ctrl-C'd CLI crawl does. The reply promises a request, not a stop, for
    the same reason cancel's does: the flag is read between pages, and the page
    in flight finishes first. Distinct from cancel in the one way that matters
    — cancel discards, this keeps."""
    job = _create_job
    if job is None or job.done:
        return {"error": "no creation job is running"}, 409
    if job.mode not in CREATE_FINISHABLE_MODES:
        return {"error": "only a site capture can be finished early"}, 409
    if job.cancel_requested:
        return {"error": "this job is already being cancelled"}, 409
    already = job.finish_requested
    job.finish_requested = True
    flag = job.stop_flag
    if flag is not None:
        flag.hit = True
    if not already:
        try:
            # Through note() so the sentence lands in the log AND the journal's
            # progress clock moves — this is progress, of the human kind.
            job.note(
                "finish requested — completing the page in flight, then "
                "packaging everything captured so far"
            )
        except _CreateCancelled:
            pass  # a cancel landed in the gap above; it wins
    return {"status": "finishing", "id": job.id}, 200


def _is_offline_mode():
    from zimi import p2p

    return bool(p2p.is_offline())


# ── the server-path root, now a reported fact only ──────────────────────────
#
# There is no web create mode that reads a path off the server's disk any more.
# Folder capture went to the CLI in round 3, and archive import followed it
# ("remove archive as well only in cli") — both are refused outright in
# ``_create_validate`` before anything touches the filesystem. So the gate,
# the containment check and the closed-by-default door that guarded that
# surface are all gone with the modes they guarded.
#
# ``ZIMI_CREATE_ROOT`` survives only as a fact the create page still reports
# (``create_root`` in the poll and the Creator payload): the server no longer
# acts on it, but the client reads it to describe the instance.

CREATE_ROOT_ENV = "ZIMI_CREATE_ROOT"


def _create_root():
    """The ``ZIMI_CREATE_ROOT`` directory, resolved, or "" when unset. Read at
    call time, like every other environment-backed setting, so a config file
    published into the environment at startup is picked up without a second
    resolution path. Nothing on the server acts on it any more — it is reported
    to the create page as a fact about the instance, nothing more."""
    raw = os.environ.get(CREATE_ROOT_ENV, "").strip()
    if not raw:
        return ""
    return os.path.realpath(os.path.expanduser(raw))


def _create_import_ready():
    """True when the warc2zim sidecar is already installed — the one thing
    that decides whether archive import can run on a machine with no
    internet."""
    try:
        from zimi.importer import sidecar_status

        return bool(sidecar_status().get("installed"))
    except Exception:
        log.exception("warc2zim sidecar probe failed")
        return False


def _create_browser_ready():
    """True when the rendered engine can actually run here — Playwright
    importable AND a Chromium that launches.

    Finding out costs a browser launch, so the renderer caches the answer for
    the life of the process and this is a dictionary lookup after the first
    call. It is asked on the Create page's first poll and when a request names
    the rendered engine; never per second, and never per page."""
    try:
        from zimi.renderer import browser_available

        return bool(browser_available())
    except Exception:
        log.exception("rendered-engine probe failed")
        return False


def _create_video_ready():
    """True when a video capture can run here — yt-dlp is a soft dependency.

    Its own probe, like the other three, because "can this machine do the thing
    the form is offering" is a question every mode has to be able to answer for
    itself. The day video needs a second half (ffmpeg, say), this is where that
    gets decided and no caller changes."""
    try:
        from zimi.video import video_available

        return bool(video_available())
    except Exception:
        log.exception("video-engine probe failed")
        return False


def _create_alive_ready():
    """True when the alive engine can run here — which needs BOTH halves, the
    browser to record with and the warc2zim sidecar to convert with.

    Deliberately its own probe rather than ``browser and import`` computed at
    the call site: the two halves are independent facts, the engine that owns
    them is the one that should decide what "ready" means, and the client is
    told each of the three separately so it can say which one is missing."""
    try:
        from zimi.alive import alive_available

        return bool(alive_available())
    except Exception:
        log.exception("alive-engine probe failed")
        return False


# ── the Creator inventory: what Zimi has made, by type ──────────────────────
#
# The provenance a Zimi-made ZIM carries (http.py's kind machinery) names the
# MODE it was captured with; the Creator pane groups those modes into the small
# set of types a person thinks in. Several modes share a type: the single-page
# and multi-page engines both stamp a page capture, and a bookmark export
# stamps "bookmarks" — so the type the breakdown counts by is not always the
# raw mode string. "edit" is here for the edit engine to fill; nothing stamps it
# yet, and a bucket that is always present but sometimes zero is a stabler
# contract than one that appears the day the first edit lands.

_CREATOR_TYPES = ("page", "site", "video", "import", "folder", "export", "edit")

_CREATOR_TYPE_BY_MODE = {
    "page": "page",
    "pages": "page",
    "site": "site",
    "video": "video",
    "import": "import",
    "folder": "folder",
    "bookmarks": "export",
    "edit": "edit",
    "edited": "edit",
}


def _creator_type(mode, kind=None, basename=""):
    """The Creator breakdown bucket for a made-here ZIM. The provenance
    ``mode`` decides it when present; a warc2zim ZIM (alive engine, or an
    import) carries no X-Zimi-History and so no mode, so we fall back to the
    scope token the creator wrote into the filename (``..._site``, ``-page``,
    ``-video``) and then to the recorded engine. Better an honest "Site" than
    a bare "Zimi" on a ZIM whose own name says what it is."""
    if mode:
        return _CREATOR_TYPE_BY_MODE.get(mode, mode)
    low = (basename or "").lower()
    for token, bucket in (
        ("video", "video"),
        ("site", "site"),
        ("page", "page"),
        ("folder", "folder"),
    ):
        if token in low:
            return bucket
    engine = (kind or {}).get("engine")
    if engine in ("alive", "rendered"):
        return "site"  # a recorded web capture with no history record
    return "other"


def _creator_inventory():
    """``(counts, rows)`` for every ZIM Zimi made, wherever it lives.

    One walk of the library. The per-file provenance memo in http.py answers
    each ZIM at most once per process, so after the cold pass this is a dict
    walk. ``counts`` partitions the made-here ZIMs across ``_CREATOR_TYPES``
    (every bucket present, zero when nothing of that type exists); ``rows``
    carries one entry per ZIM with the raw sortable fields and leaves the
    ordering to the client."""
    from zimi import http as _http

    counts = {t: 0 for t in _CREATOR_TYPES}
    rows = []
    for entry in _srv.list_zims():
        kind = _http._zim_kind_for(entry)
        if not kind:
            continue
        ctype = _creator_type(
            kind.get("mode"), kind=kind, basename=entry.get("file", "")
        )
        if ctype in counts:
            counts[ctype] += 1
        rows.append(
            {
                "name": entry.get("name", ""),
                "title": entry.get("title") or entry.get("name", ""),
                "type": ctype,
                "size_bytes": entry.get("size_bytes", 0),
                # The creation timestamp the provenance record carries, or None
                # for a Zimi ZIM old enough to predate the stamp — the client
                # sorts the dated ones and leaves the rest where they fall.
                "created_ts": kind.get("ts"),
                "path_basename": entry.get("file", ""),
            }
        )
    return counts, rows


def _creator_payload():
    """Everything the Manage view's Creator section shows, in one read.

    Gathered here rather than left scattered across the create page's own poll
    because these are SERVER facts — what this machine can capture with, where
    it is allowed to write, what it refuses by default, what is waiting — and
    an admin looking for them should not have to open the create form and infer
    them from which options are greyed.

    The two subprocess-backed probes are the reason this is its own endpoint
    and not a field on the status poll: they are cheap but they are not free,
    and the Manage view asks once when the section is opened."""
    sidecar = {"installed": False, "version": None}
    try:
        from zimi.importer import sidecar_status

        status = sidecar_status()
        sidecar = {
            "installed": bool(status.get("installed")),
            "version": status.get("version"),
        }
    except Exception:
        log.exception("sidecar status probe failed")
    return {
        "browser_ready": _create_browser_ready(),
        "alive_ready": _create_alive_ready(),
        "sidecar": sidecar,
        # None, not "", when no root is configured — the same shape the create
        # page's probe uses, so both readers treat "unset" the same way.
        "create_root": _create_root() or None,
        "block_ads_default": _create_default("block_ads", CREATE_BLOCK_ADS),
        "capture_variants_default": _create_default(
            "capture_variants", CREATE_CAPTURE_VARIANTS
        ),
        "queue": len(_create_queue_view()),
        "offline": _is_offline_mode(),
    }


def _creator_inventory_payload():
    """The Creator pane's made-here breakdown + sortable list, on its OWN
    endpoint. Gathering it is a provenance walk of the whole library — the
    slow, unbounded half of the pane — so it never rides the pane's own fast
    payload. ``counts`` is a fixed-shape dict over _CREATOR_TYPES; ``list`` is
    unsorted rows the client orders."""
    counts, rows = _creator_inventory()
    return {"created_counts": counts, "created_list": rows}


def _auto_update_view():
    """The ZIM auto-updater's state: whether it runs, how often, when it last
    ran and when it runs next.

    ``last_check`` is process memory — the updater stamps it at the top of each
    cycle and nothing persists it — so it is None after a restart, and the
    client must say "not since this server started" rather than "never".
    ``next_check`` is derived from it rather than stored, because the loop
    sleeps a fixed interval after each pass; None when there is nothing to
    derive it from, which is either disabled or not-yet-run."""
    freq = _srv._auto_update_freq
    last = _srv._auto_update_last_check
    interval = _srv._FREQ_SECONDS.get(freq)
    nxt = None
    if _srv._auto_update_enabled and last and interval:
        nxt = last + interval
    return {
        "enabled": _srv._auto_update_enabled,
        "frequency": freq,
        "locked": _srv._auto_update_env_locked,
        "last_check": last,
        "next_check": nxt,
    }


def _auto_update_coverage():
    """Which installed ZIMs the auto-updater can actually maintain, and why it
    passes over the rest.

    Not a preference and not an opt-out list — Zimi has neither. It is the
    updater's real reach, made visible: matching an installed file to a newer
    edition needs a dated filename (``…_YYYY-MM.zim``), so anything without one
    is invisible to it. That is most locally created ZIMs, and until now the
    only way to discover it was to notice a file never updating.

    Returns ``{"tracked": [names], "skipped": [{"name", "reason"}]}``, sorted,
    so the client can say the true sentence in the reader's language."""
    tracked, skipped = [], []
    for name, path in sorted(_srv.get_zim_files().items()):
        _base, date = _srv._extract_zim_date(os.path.basename(path))
        if date:
            tracked.append(name)
        else:
            # One reason today, named rather than implied, so a second reason
            # is a new value here and not a new shape at the call site.
            skipped.append({"name": name, "reason": "undated"})
    return {"tracked": tracked, "skipped": skipped}


def _create_kill_browsers():
    """Kill any headless browser a create job left running.

    Only reached when the watchdog gives up on a job: by then the job's thread
    is wedged somewhere that will not return, so the engine's own `finally`
    cannot be relied on to close its browser. Imported by NAME rather than
    directly, so a server whose jobs never render a page never loads the
    renderer at all."""
    module = sys.modules.get("zimi.renderer")
    if module is None:
        return
    try:
        module.shutdown_sessions()
    except Exception:
        log.exception("could not shut down a rendered capture's browser")


# ============================================================================
# Pre-flight probe — look before you leap
#
# The round-1 verdict on the Create page was "feels like a shot in the dark",
# and it was fair: the form asked for a server path you cannot see, a language
# code you have to know and a byte budget with no sense of scale, then ran for
# an hour on whatever it got. The probe runs the half of each job that only
# LOOKS — count a folder, fetch one page, list a playlist — and hands back what
# the real run would find, so the answer arrives before the commitment.
# (Folder probing left with folder mode itself — CLI-only now.)
#
# It writes nothing, downloads no media, and crawls no links. Every mode is
# bounded by both a count and a clock, because a preview that outlasts your
# patience has failed at being a preview.
#
# The reply is STRUCTURED, never prose: counts, byte totals and i18n KEYS for
# any warning. Server-authored English sentences in a preview would be the one
# corner of this app that cannot be translated.
# ============================================================================

CREATE_PROBE_TIMEOUT = 12.0
CREATE_PROBE_MAX_EXAMPLES = 6
CREATE_PROBE_VIDEO_LIMIT = 12

_HTML_LANG_RE = re.compile(
    r"<html[^>]*\blang\s*=\s*[\"']([a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]+)*)[\"']",
    re.IGNORECASE,
)
_META_LANG_RE = re.compile(
    r"<meta[^>]+http-equiv\s*=\s*[\"']content-language[\"'][^>]*"
    r"content\s*=\s*[\"']([a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]+)*)",
    re.IGNORECASE,
)


def _iso3_of(tag):
    """A BCP-47-ish tag from a document (``fr``, ``en-GB``, ``fra``) as the
    ISO 639-3 code the ZIM metadata and the full-text index both want. Returns
    None for anything not recognised — a wrong language is worse than none,
    because it silently stems the index against the wrong rules."""
    if not tag:
        return None
    primary = re.split(r"[-_]", str(tag).strip())[0].lower()
    if len(primary) == 3 and primary in _srv._ISO639_3_TO_1:
        return primary
    if len(primary) == 2:
        for three, two in _srv._ISO639_3_TO_1.items():
            if two == primary:
                return three
    return None


def _detect_html_language(text):
    """The document's own declaration of what language it is in. This is a
    read of `<html lang>`, not statistical detection: it is what the author
    said, it costs one regex, and it is right far more often than a guess over
    a few hundred words of boilerplate would be."""
    for pattern in (_HTML_LANG_RE, _META_LANG_RE):
        m = pattern.search(text or "")
        if m:
            code = _iso3_of(m.group(1))
            if code:
                return code
    return None


def _probe_url(source, *, want_robots=False, engine=None):
    """Fetch ONE page and report what the capture would be working with: where
    it really landed, what it is called, whether it is an application shell
    that would produce a ZIM full of loading spinners, and — for a crawl — what
    the site's robots.txt has to say about the seed.

    ONE plain HTTP fetch, whichever engine the job will use. Previewing a
    rendered capture by rendering it would cost a browser launch per keystroke
    settled, and the answers the preview gives — where the URL lands, what it
    is called, what language it declares — are the same either way. What the
    engine changes is the VERDICT: an application shell is a refusal for the
    fast engine and the entire point of the rendered and alive ones."""
    from zimi.creator import (
        _decode_page,
        _fetch_page,
        _page_title_from_html,
        looks_like_spa,
    )

    final_url, data, ctype, clang = _fetch_page(
        source, timeout=CREATE_PROBE_TIMEOUT, max_redirects=3
    )
    page = _decode_page(data, ctype)
    is_html = "html" in (ctype or "").lower()
    spa = bool(is_html and looks_like_spa(page))
    # Both browser engines answer the SPA question the same way, so they are
    # one flag rather than two comparisons that could drift apart.
    rendered = engine in ("rendered", "alive")
    # The document's own `<html lang>` first, the Content-Language header
    # second: the header is server configuration and is often a site-wide
    # default, while the attribute was written about this page.
    language = _detect_html_language(page) if is_html else None
    out = {
        "ok": is_html and (not spa or rendered),
        "final_url": final_url,
        "title": _page_title_from_html(page, "") if is_html else "",
        "content_type": (ctype or "").split(";")[0].strip(),
        "bytes": len(data),
        "spa": spa,
        "language": language or _iso3_of(clang),
        "warning_key": None,
    }
    if not is_html:
        out["warning_key"] = "create_warn_not_html"
    elif spa and rendered:
        # Not a warning: a page built in JavaScript is the case these engines
        # exist for. Said out loud anyway, because "this page has no
        # server-rendered text" is the reason the capture will take twenty
        # seconds instead of one — and the two engines promise different things
        # about it, so they say different sentences.
        out["note_key"] = (
            "create_note_spa_alive" if engine == "alive" else "create_note_spa_rendered"
        )
    elif spa:
        # The engine's own refusal, verbatim: it names zimit, which is the fix.
        from zimi.creator import SPA_REFUSAL

        out["warning_key"] = "create_warn_spa"
        out["detail"] = SPA_REFUSAL
    if want_robots and out["ok"]:
        out.update(_probe_robots(final_url))
    return out


def _probe_robots(final_url):
    """What the site asks crawlers to do. Reported, never enforced here — the
    crawl itself enforces it, and the override lives in Advanced."""
    from zimi.crawler import _origin_of, _robots_allows, load_robots

    try:
        robots = load_robots(_origin_of(final_url), timeout=CREATE_PROBE_TIMEOUT)
    except Exception:
        log.exception("robots probe failed")
        return {}
    allowed = _robots_allows(robots, final_url) if robots else True
    return {
        "robots_allowed": bool(allowed),
        "warning_key": None if allowed else "create_warn_robots",
    }


def _probe_video(source, limit):
    """List the playlist without downloading a frame of it."""
    from zimi.video import _flat_entries, _yt_dlp

    mod = _yt_dlp()
    if mod is None:
        from zimi.video import INSTALL_HINT

        return {
            "ok": False,
            "warning_key": "create_warn_no_ytdlp",
            "detail": INSTALL_HINT,
        }
    head, entries = _flat_entries(mod, source, limit or CREATE_PROBE_VIDEO_LIMIT)
    titles = [
        str(e.get("title") or "")
        for e in entries[:CREATE_PROBE_MAX_EXAMPLES]
        if isinstance(e, dict)
    ]
    return {
        "ok": bool(entries),
        "videos": len(entries),
        "playlist": str(head.get("title") or ""),
        "uploader": str(head.get("uploader") or head.get("channel") or ""),
        "examples": titles,
        "language": _iso3_of(head.get("language")),
        "warning_key": None if entries else "create_warn_empty_playlist",
    }


# The folder picker (`/manage/create/browse`, `_create_browse`) lived here
# until folder mode left the web. The route remains and refuses with the CLI
# pointer — see handle_manage_get — because a lister whose only customer was
# that form is a directory-disclosure surface with no purpose left on screen.


def _create_probe(data):
    """Validate the request exactly as a real run would, then look. Returns
    ``(payload, status)``."""
    # Imported here rather than at module scope: naming the exception is the
    # only reason this module needs the writer stack, and a server that never
    # previews a capture should not pay to import it.
    from zimi.creator import CreateError

    try:
        mode, source, _title, opts = _create_validate(data)
    except ValueError as e:
        return {"error": str(e)}, 400
    job = _create_job
    if job is not None and not job.done:
        # The probe competes with the job for the same disk and the same
        # network. One at a time here too.
        return {"error": "a ZIM is being created — wait for it to finish"}, 409
    try:
        if mode == "video":
            result = _probe_video(source, opts.get("limit"))
        elif mode == "page":
            # One fetch, not twenty: the preview answers "is this the kind of
            # thing that captures well?", and the first address answers it. The
            # count is what makes the rest of the list visible.
            urls = opts.get("urls") or [source]
            result = _probe_url(urls[0], engine=opts.get("engine"))
            result["urls"] = len(urls)
        else:
            result = _probe_url(
                source, want_robots=(mode == "site"), engine=opts.get("engine")
            )
    except CreateError as e:
        # Already a user-facing sentence, and the one that names the fix.
        return {"ok": False, "mode": mode, "detail": str(e)}, 200
    except Exception:
        log.exception("create probe failed (%s)", mode)
        return {
            "ok": False,
            "mode": mode,
            "warning_key": "create_warn_probe_failed",
        }, 200
    result["mode"] = mode
    result["source"] = source
    return result, 200


# ============================================================================
# Manage GET Routes
# ============================================================================


def _bt_still_downloading(raw):
    """True when a list_managed() row is an in-flight BT download rather than
    a seed: total known, not yet complete, and the engine hasn't flagged it a
    seeder. Shared by the /manage/seeding list (which hides such rows) and the
    stop_all seeding action (which must not cancel them — their payload lives
    in staging, where remove(delete_files=True) really deletes)."""
    completed = int(raw.get("completedLength", 0))
    total = int(raw.get("totalLength", 0))
    seeder = raw.get("seeder") in ("true", True)
    return (
        raw.get("status", "unknown") not in ("error", "complete")
        and not seeder
        and total > 0
        and completed < total
    )


def handle_manage_get(handler, parsed, params):
    """Handle all GET /manage/* requests. Called from ZimHandler.do_GET."""

    def param(key, default=None):
        return params.get(key, [default])[0]

    if not _srv.ZIMI_MANAGE:
        return handler._json(
            404,
            {"error": "Library management is disabled. Set ZIMI_MANAGE=1 to enable."},
        )
    # Public pre-auth endpoints (no Authorization header available)
    if parsed.path == "/manage/has-password":
        return handler._json(
            200,
            {
                "has_password": bool(_get_manage_password_hash()),
                "env_controlled": bool(os.environ.get("ZIMI_MANAGE_PASSWORD", "")),
            },
        )
    if parsed.path == "/manage/has-token":
        return handler._json(200, {"has_token": bool(_get_api_token())})
    if parsed.path == "/manage/thumb":
        # Thumbnails are public catalog data; <img> tags can't send Authorization headers
        url = param("url", "")
        if not url or not url.startswith("https://library.kiwix.org/"):
            return handler._json(400, {"error": "invalid thumbnail URL"})
        data, ct = _srv._fetch_thumb(url)
        if data is None:
            # Already-cached thumbnails still serve offline (no packets); only
            # a miss is a dead end there, and it is a 404, not an upstream
            # failure the client should retry.
            from zimi import p2p as _p2p

            if _p2p.is_offline():
                return handler._json(404, {"error": "thumbnail not available offline"})
            return handler._json(502, {"error": "failed to fetch thumbnail"})
        handler.send_response(200)
        handler.send_header("Content-Type", ct)
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header(
            "Cache-Control", "public, max-age=604800"
        )  # 7 days browser cache
        handler.end_headers()
        handler.wfile.write(data)
        return
    # The create surfaces gate themselves: a creator account (can_create) is
    # not an admin, so these two run BEFORE the admin challenge below.
    # Everything else on /manage/* stays admin-only exactly as before.
    if parsed.path == "/manage/create/status":
        denial = _creator_denial(handler)
        if denial:
            return handler._json(*denial)
        # Polled ~2s while a job runs. Everything here is in-memory except the
        # optional one-shot sidecar probe, so the poll stays cheap on a Pi.
        return handler._json(
            200,
            _create_status(
                _create_int(param("since"), 0, 2**31) or 0,
                probe=param("probe") == "1",
                events_cursor=_create_int(param("events_since"), 0, 2**31) or 0,
                # Asked for when the page opens, not every poll: it reads a
                # file, and what happened yesterday does not change per second.
                history=param("history") == "1",
            ),
        )
    if parsed.path == "/manage/create/browse":
        # The folder picker's feed, and folder mode left the web (CLI-only, by
        # decree) — so the lister that existed solely to make it discoverable
        # refuses cleanly rather than keeping a directory-disclosure surface
        # alive for a form that no longer exists. 410: it was here, it is gone,
        # and the refusal names the door that still opens.
        denial = _creator_denial(handler)
        if denial:
            return handler._json(*denial)
        return handler._json(
            410,
            {
                "error": (
                    "the folder picker is gone — folder capture is CLI-only "
                    "now. Run `zimi create <folder>` on the server itself."
                )
            },
        )
    challenge = _manage_auth_challenge(handler)
    if challenge:
        return handler._json(*challenge)

    if parsed.path == "/manage/status":
        zim_count = len(_srv.get_zim_files())
        total_gb = sum(z.get("size_gb", 0) for z in (_srv._zim_list_cache or []))
        linked_zims = len(set(_srv._domain_zim_map.values()))
        return handler._json(
            200,
            {
                "zim_count": zim_count,
                "total_size_gb": round(total_gb, 1),
                "manage_enabled": True,
                "linked_zims": linked_zims,
                "domain_count": len(_srv._domain_zim_map),
                "auto_update": _auto_update_view(),
            },
        )

    elif parsed.path == "/manage/auto-update":
        # The GET half of the same path the POST below writes. Everything the
        # auto-update section renders, including the coverage list, which is
        # the one part that walks the library and so is not on the status poll.
        payload = _auto_update_view()
        payload["coverage"] = _auto_update_coverage()
        return handler._json(200, payload)

    elif parsed.path == "/manage/creator":
        return handler._json(200, _creator_payload())

    elif parsed.path == "/manage/creator/inventory":
        return handler._json(200, _creator_inventory_payload())

    elif parsed.path == "/manage/stats":
        metrics = _srv._get_metrics()
        disk = _srv._get_disk_usage()
        # The same view /manage/status serves. It used to be a third hand-built
        # dict here that omitted `locked` and a second one there that omitted
        # `last_check`, so which facts a caller got depended on which endpoint
        # it happened to poll.
        auto_update = _auto_update_view()
        # The per-index walk opens every title index on disk — far too costly
        # for the callers that only want disk paths or partial-download info.
        # ?detail=1 is the opt-in for the one view that renders the index list.
        title_index = (
            _srv._get_title_index_stats()
            if param("detail") == "1"
            else _srv._get_title_index_status_brief()
        )
        with _srv._xzim_refs_lock:
            xzim_refs = sorted(
                [
                    {"from": k[0], "to": k[1], "count": v}
                    for k, v in _srv._xzim_refs.items()
                ],
                key=lambda x: x["count"],
                reverse=True,
            )
        linked_zims = len(set(_srv._domain_zim_map.values()))
        zim_count = len(_srv.get_zim_files())
        return handler._json(
            200,
            {
                "metrics": metrics,
                "disk": disk,
                "auto_update": auto_update,
                "title_index": title_index,
                "cross_zim_refs": xzim_refs,
                "linked_zims": linked_zims,
                "zim_count": zim_count,
                "domain_count": len(_srv._domain_zim_map),
            },
        )

    elif parsed.path == "/manage/usage":
        return handler._json(200, _srv._get_usage_stats())

    elif parsed.path == "/manage/download-schedule":
        from zimi import library as _lib

        return handler._json(200, _lib._download_schedule_status())

    elif parsed.path == "/manage/backup":
        # scope=device (default, everyone) or scope=server (admin-only: the full
        # server state incl. users.json with hashes). The manage gate above is
        # already admin-only, but the explicit check keeps the server-scope
        # contract self-evident and independently testable.
        scope = param("scope", "device")
        if scope == "server" and admin_kind(handler) is None:
            return handler._json(403, {"error": "full-server backup requires an admin"})
        return handler._json(200, _build_backup_bundle(scope=scope))

    elif parsed.path == "/manage/users":
        # Named user accounts (multi-user v1) — admin-only (gated above). Returns
        # the roster (no password hashes), the installed ZIM names (legacy field),
        # the richer picker options (title + language + count) the redesigned
        # allowlist picker needs, and the public-access policy so the whole Users
        # panel renders from a single fetch.
        from zimi import users as _users

        return handler._json(
            200,
            {
                "users": _users.list_users(),
                "zims": sorted(_srv.get_zim_files().keys()),
                # Rich per-ZIM options for the allowlist picker (used by both the
                # per-user Limited picker and the public-access Limited picker).
                "zim_options": _zim_picker_options(),
                # Anonymous-access policy (Open / Limited / Sign-in required).
                "public_access": _users.public_access_status(),
                # The PRIMARY admin (password-file account) is not stored in
                # users.json — surface it as a synthetic, non-deletable row so
                # the UI can show "the admin" alongside the named users.
                "primary_admin": {
                    "name": _get_manage_user() or "admin",
                    "role": "admin",
                    "primary": True,
                },
                # Which kind of admin is viewing — the client hides admin-only
                # controls (creating/managing other admins) for secondaries.
                "self_kind": admin_kind(handler),
            },
        )

    elif parsed.path == "/manage/public-access":
        # Anonymous-access policy on its own, with the picker options — a
        # lightweight refetch target after the admin changes it.
        from zimi import users as _users

        return handler._json(
            200,
            {
                "public_access": _users.public_access_status(),
                "zim_options": _zim_picker_options(),
            },
        )

    elif parsed.path == "/manage/catalog":
        query = param("q", "")
        lang = param("lang", "")
        try:
            count = min(int(param("count", "20")), 500)
        except (ValueError, TypeError):
            count = 20
        try:
            start = max(int(param("start", "0")), 0)
        except (ValueError, TypeError):
            start = 0
        total, items, err = _srv._fetch_kiwix_catalog(query, lang, count, start)
        if err:
            return handler._json(502, {"error": f"Kiwix catalog fetch failed: {err}"})
        # Optional client-side language filter — `ui_languages=en,fr` returns
        # only items whose normalized language code is in the set.
        ui_langs_raw = param("ui_languages", "")
        if ui_langs_raw:
            wanted = {x.strip().lower() for x in ui_langs_raw.split(",") if x.strip()}
            if wanted:
                items = [
                    it for it in items if str(it.get("language", "")).lower() in wanted
                ]
                total = len(items)
        # Optional bundle/subset hierarchy detection. Off by default because
        # the UI only needs it on the catalog drill-in page.
        if param("include_hierarchy", "") == "1":
            from zimi.catalog_hierarchy import bundle_relationships

            rels = bundle_relationships(items)
            for it in items:
                it["hierarchy"] = rels.get(it.get("name"), {})
        resp = {"total": total, "items": items}
        # Offline: last-good catalog served from disk — tell the client so
        # it can show a quiet "catalog from <date>" note.
        from zimi import library as _lib

        if _lib._catalog_stale_ts:
            resp["stale"] = True
            resp["fetched_at"] = _lib._catalog_stale_ts
        return handler._json(200, resp)

    elif parsed.path == "/manage/check-updates":
        updates = _srv._check_updates()
        return handler._json(200, {"updates": updates, "count": len(updates)})

    elif parsed.path == "/manage/updates":
        # Same shape as /manage/check-updates — stable name without "check-"
        # so callers reading last-known state aren't named for the side
        # effect. Triggers a catalog fetch; fast when cached.
        updates = _srv._check_updates()
        return handler._json(200, {"updates": updates, "count": len(updates)})

    elif parsed.path == "/manage/app-update":
        # The Zimi APP itself — not /manage/auto-update (ZIM-content refresh)
        # and not /manage/updates (per-ZIM update list). Passive read: serves
        # the cached answer, refreshing at most once a day. Never runs at
        # boot — the only trigger is an admin opening the Manage server pane.
        return handler._json(200, _app_update_payload())

    elif parsed.path == "/manage/downloads":
        return handler._json(200, {"downloads": _srv._get_downloads()})

    elif parsed.path == "/manage/activity":
        # Aggregated background-activity snapshot for the topbar status row.
        # Cheap to call — reads in-memory state only, no heavy I/O. Designed
        # for 5s polling. Returns small flat dict; client renders one line.
        idx = _srv._get_title_index_status_brief()
        downloads = _srv._get_downloads()
        # _get_downloads() shape: queued items have queued=True, in-flight
        # items have queued=False + done=False + paused=False. There is no
        # `status` key on a real download object. Active = actively
        # transferring; queued is a separate bucket.
        active = [
            d
            for d in downloads
            if not d.get("done") and not d.get("paused") and not d.get("queued")
        ]
        active_dl = len(active)
        queued_dl = sum(1 for d in downloads if d.get("queued"))
        # Name of the first in-flight download so the topbar badge tooltip can
        # read "1 downloading — <name>" instead of a bare count. Base filename
        # (sans .zim) — recognizable without a catalog lookup on a 5s poll.
        first_name = ""
        if active:
            fn = active[0].get("filename", "") or ""
            first_name = fn[:-4] if fn.endswith(".zim") else fn
        seeding_count = 0
        try:
            from zimi import p2p as _p2p

            if _p2p.is_torrent_enabled():
                # peek only — a 5s poll must never spawn (or retry) the sidecar
                backend = _p2p.peek_backend()
                if backend:
                    seeding_count = sum(
                        1
                        for raw in backend.list_managed()
                        if raw.get("state") in ("seeding", "complete")
                    )
        except Exception:
            pass

        # Other long-running jobs a user starts and then navigates away from:
        # bookmark→ZIM export and the library health check. Both keep their
        # phase/done/total in module memory, so this stays poll-cheap. Only
        # the brief shape is forwarded (health's full report can be large).
        def _op_brief(mod_state):
            return {
                "phase": mod_state.get("phase"),
                "done": mod_state.get("done", 0),
                "total": mod_state.get("total", 0),
            }

        export_op = {"phase": None, "done": 0, "total": 0}
        try:
            from zimi import zimwriter as _zw

            export_op = _op_brief(_zw.get_export_state())
        except Exception:
            pass
        health_op = {"phase": None, "done": 0, "total": 0}
        try:
            from zimi import health as _health

            health_op = _op_brief(_health.get_state())
        except Exception:
            pass
        return handler._json(
            200,
            {
                "indexing": {
                    "state": idx.get("state", "idle"),
                    "ready": idx.get("ready", 0),
                    "total": idx.get("total", 0),
                    "current": idx.get("building_now"),
                },
                "downloads": {
                    "active": active_dl,
                    "queued": queued_dl,
                    "name": first_name,
                },
                "seeding": {"torrents": seeding_count},
                "export": export_op,
                "health": health_op,
            },
        )

    elif parsed.path == "/manage/peers":
        try:
            from zimi import p2p_discovery as _disc

            # The share toggle governs BOTH directions: with it off, we
            # neither serve /dl nor surface peers to pull from — the user
            # asked for "internet sources only".
            if not _disc.is_share_enabled():
                return handler._json(
                    200,
                    {
                        "enabled": False,
                        "self": _disc._self_service_name or _disc._peer_instance_name(),
                        "peers": [],
                    },
                )
            return handler._json(
                200,
                {
                    "enabled": _disc.is_enabled(),
                    "self": _disc._self_service_name or _disc._peer_instance_name(),
                    "peers": _disc.get_peers(),
                },
            )
        except Exception:
            return handler._json(200, {"enabled": False, "self": "", "peers": []})

    elif parsed.path == "/manage/mirror":
        try:
            from zimi import p2p as _p2p

            return handler._json(200, _p2p.get_mirror_status())
        except Exception:
            return handler._json(
                200, {"enabled": False, "ratio_cap": 0.0, "upload_kb": 0}
            )

    elif parsed.path == "/manage/health":
        # Library health report — poll status of the on-demand check.
        from zimi import health as _health

        return handler._json(200, _health.get_state())

    elif parsed.path == "/manage/export-bookmarks":
        # Save-to-ZIM export — poll status of the on-demand export.
        from zimi import zimwriter as _zw

        return handler._json(200, _zw.get_export_state())

    elif parsed.path == "/manage/peers/list":
        try:
            from zimi import p2p_discovery as _disc

            if not _disc.is_share_enabled():
                return handler._json(403, {"error": "LAN sharing is turned off"})
            peer = param("peer", "")
            if not peer:
                return handler._json(400, {"error": "missing 'peer' param"})
            data = _disc.fetch_peer_list(peer)
            if data is None:
                return handler._json(404, {"error": "peer not reachable or unknown"})
            return handler._json(200, {"peer": peer, "list": data})
        except Exception:
            return handler._json(503, {"error": "peer fetch failed"})

    elif parsed.path == "/manage/history":
        return handler._json(200, {"history": _srv._load_history()})

    elif parsed.path == "/manage/activity-log":
        # The unified journal behind the Activity view. Named -log because
        # /manage/activity is the live "what is happening right now" poll that
        # feeds the topbar badge; this is "what has happened".
        return handler._json(200, activity_payload(param("type"), param("actor")))

    elif parsed.path == "/manage/cache-info":
        return handler._json(200, _cache_info_payload())

    elif parsed.path == "/manage/hot":
        # Pro: list of hot ZIMs + which env source controls them.
        env_locked = "ZIMI_HOT_ZIMS" in os.environ
        return handler._json(
            200,
            {
                "hot_zims": _srv.get_hot_zims(),
                "env_locked": env_locked,
            },
        )

    elif parsed.path == "/manage/seeding":
        # Surface what we're seeding right now: per-ZIM ratio, peers, speeds.
        # Empty list when BT is off or no torrents are loaded.
        from zimi import p2p

        if not p2p.is_torrent_enabled():
            return handler._json(
                200,
                {
                    "enabled": False,
                    "ratio_cap": p2p.get_seed_ratio_cap(),
                    "torrents": [],
                    "totals": {"uploaded": 0, "downloaded": 0, "ratio": 0.0},
                },
            )
        # peek only — a list view must not spawn (or retry) the sidecar
        backend = p2p.peek_backend()
        if not backend:
            return handler._json(
                200,
                {
                    "enabled": True,
                    "ratio_cap": p2p.get_seed_ratio_cap(),
                    "torrents": [],
                    "totals": {"uploaded": 0, "downloaded": 0, "ratio": 0.0},
                },
            )
        torrents = []
        total_up = 0
        total_down = 0
        # Mirror seeds carry no ratio cap; personal seeds stop at cap x size.
        # The cap is a single global (per-torrent goal = cap x that file's
        # size), computed client-side from ratio_cap + the file size we send.
        mirror_on = p2p.is_mirror_enabled()
        ratio_cap = p2p.get_seed_ratio_cap()
        from zimi import library as _lib

        ledger = _lib.seed_ledger_snapshot()
        # Drop finished/errored results (e.g. broken-ZIM torrents that can't
        # resolve) so they don't linger in the seeding panel. Best-effort.
        purge = getattr(backend, "purge_stopped", None)
        if callable(purge):
            try:
                purge()
            except Exception:
                pass
        try:
            for raw in backend.list_managed():
                files = raw.get("files", [])
                fpath = ""
                if files and isinstance(files, list) and files[0].get("path"):
                    fpath = files[0]["path"]
                fname = os.path.basename(fpath)
                # Skip anything that isn't a ZIM (stray .torrent noise).
                if not fname.endswith(".zim"):
                    continue
                completed = int(raw.get("completedLength", 0))
                uploaded = int(raw.get("uploadLength", 0))
                ratio = uploaded / max(completed, 1)
                state = raw.get("status", "unknown")
                # An in-flight BT download is the Downloads tab's job, not a
                # seed — list_managed() returns downloading torrents too, so
                # without this a BT download double-surfaces (one download
                # card AND one "seed" card for the same .zim under "All").
                # Only skip when we KNOW it's still downloading (shared
                # predicate with the stop_all action).
                total = int(raw.get("totalLength", 0))
                if _bt_still_downloading(raw):
                    continue
                # Honesty: a seed whose file vanished (or that errored) is
                # snagged, not seeding — surface it, don't hide it.
                snag = ""
                if state == "error":
                    snag = raw.get("errorMessage", "") or "error"
                elif fpath and not os.path.exists(fpath):
                    snag = "file missing"
                # Lifetime upload from the ledger (survives restarts) — at
                # least this session's count. file_size prefers the torrent's
                # total; completedLength is the seeding-file fallback.
                led = ledger.get(fname, {})
                cumulative = max(int(led.get("uploaded", 0) or 0), uploaded)
                file_size = total or completed
                is_mirror = mirror_on or led.get("origin") == "mirror"
                # Personal seeds have a byte goal (cap x size); mirror = none.
                cap_bytes = 0 if is_mirror else int(ratio_cap * file_size)
                torrents.append(
                    {
                        "id": raw.get("gid", ""),
                        "filename": fname,
                        "state": state,
                        "snag": snag,
                        "completed_bytes": completed,
                        "file_size_bytes": file_size,
                        "uploaded_bytes": uploaded,
                        "cumulative_uploaded_bytes": cumulative,
                        # Ledger intent time = when Zimi first decided to seed
                        # this file (download completion / mirror sync). 0 when
                        # the ledger has no entry — the client hides the age.
                        "added": int(led.get("added") or 0),
                        "cap_bytes": cap_bytes,
                        "mirror": is_mirror,
                        "ratio": round(ratio, 3),
                        "peers": int(raw.get("connections", 0)),
                        "down_speed": int(raw.get("downloadSpeed", 0)),
                        "up_speed": int(raw.get("uploadSpeed", 0)),
                        "info_hash": raw.get("infoHash", ""),
                    }
                )
                if not snag:
                    total_up += uploaded
                    total_down += completed
        except Exception as e:
            log.warning("seeding list failed: %s", e)
        return handler._json(
            200,
            {
                "enabled": p2p.is_seeding_enabled(),
                "ratio_cap": ratio_cap,
                "mirror": mirror_on,
                "disk_pressure": p2p.should_pause_for_disk_pressure(_srv.ZIM_DIR),
                "torrents": torrents,
                "totals": {
                    "uploaded": total_up,
                    "downloaded": total_down,
                    "ratio": round(total_up / max(total_down, 1), 3),
                },
            },
        )

    elif parsed.path == "/manage/bt-status":
        # Surface the BT engine state so the user can self-diagnose:
        # enabled? libtorrent importable on this install? session up?
        from zimi import p2p

        enabled = p2p.is_torrent_enabled()
        engine_importable = p2p._lt() is not None

        # Live state — peek only. A status view must never start the
        # engine (with BT on by default that would mean every settings
        # visit spins up a session).
        backend = p2p.peek_backend() if enabled else None
        engine_alive = backend is not None and backend.is_alive()

        if not enabled:
            status = "off"
        elif backend is not None:
            status = "ready"
        elif not engine_importable:
            status = "unavailable"
        else:
            # Importable, session just not started yet — it starts at
            # boot or on first download, so report ready-to-torrent.
            status = "ready"
        hint = None
        if not enabled:
            hint = "BT downloads disabled (ZIMI_BT=off). HTTP is used instead."
        elif status == "unavailable":
            import sys as _sys

            # Give the exact next step. Wheels exist for CPython 3.9–3.13; on
            # 3.14+ there's no wheel yet, so name that specifically instead of
            # sending the user to a pip command that will fail.
            if _sys.version_info >= (3, 14):
                fix = (
                    f"no libtorrent wheel exists for Python "
                    f"{_sys.version_info.major}.{_sys.version_info.minor} yet — "
                    "run Zimi on Python 3.13 or older (or use the Docker image) "
                    "to torrent."
                )
            else:
                fix = "run `pip install libtorrent` (or `pip install zimi[bt]`) to torrent."
            hint = (
                "libtorrent isn't importable on this install — downloads fall "
                "back to HTTP, which works fine. To share load with the Kiwix "
                "mirrors, " + fix
            )

        from zimi import p2p_nat

        return handler._json(
            200,
            {
                "status": status,
                "enabled": enabled,
                "backend": "libtorrent",
                "bt_port": p2p.get_bt_port(),
                "staging_dir": p2p.get_staging_dir(_srv.ZIMI_DATA_DIR),
                "engine_importable": engine_importable,
                "hint": hint,
                "upnp_enabled": p2p.is_upnp_enabled(),
                "upnp_env_locked": p2p.is_upnp_env_locked(),
                # True only when the session is actually up — "ready" alone
                # is optimistic (importable counts). The UI reads this key.
                "sidecar_running": engine_alive,
                "bt_port_env_locked": p2p.is_bt_port_env_locked(),
                # Cached: the probe runs at startup and on explicit recheck
                "nat": p2p_nat.last_status() or None,
            },
        )

    else:
        return handler._json(404, {"error": "not found"})


def _zim_picker_options():
    """``[{name, title, language, article_count}]`` for the allowlist pickers,
    sorted by title. Admin view = all installed ZIMs. Titles/languages come from
    the startup metadata cache; a ZIM not yet in that cache still appears (by
    name) so it is always selectable."""
    opts = []
    seen = set()
    for z in _srv._zim_list_cache or []:
        name = z.get("name")
        if not name:
            continue
        seen.add(name)
        opts.append(
            {
                "name": name,
                "title": z.get("title") or name,
                "language": z.get("language", ""),
                "article_count": z.get("article_count"),
            }
        )
    for name in sorted(_srv.get_zim_files().keys()):
        if name not in seen:
            opts.append(
                {"name": name, "title": name, "language": "", "article_count": None}
            )
    opts.sort(key=lambda o: (o["title"] or "").casefold())
    return opts


def _handle_public_access_post(handler, data):
    """Admin-only: set the anonymous-access policy. ``mode`` ∈ {open, limited,
    private}; ``allowlist`` applies only to ``limited``. Echoes the fresh status
    so the UI re-renders in one round trip. Auth already passed (gated in
    ``handle_manage_post``)."""
    from zimi import users as _users

    mode = data.get("mode", "")
    ok, err = _users.set_public_access(mode, data.get("allowlist"))
    if not ok:
        return handler._json(400, {"error": err or "operation failed"})
    return handler._json(
        200, {"status": "ok", "public_access": _users.public_access_status()}
    )


def _handle_users_post(handler, data):
    """Admin-only user CRUD (multi-user v1). action ∈ {create, delete,
    set-password, set-allowlist, set-role, set-can-create}. Errors are
    returned generically; on success the fresh roster (no hashes) is echoed so
    the UI re-renders in one
    round trip. Reaching here means the admin-auth challenge already passed.

    Hierarchy (see ``users`` module docstring): only the PRIMARY admin may
    manage admin-role accounts. A SECONDARY admin can CRUD regular users but
    cannot create/modify/delete any admin, and NO admin can mutate the primary
    account (it lives in the password file, not users.json)."""
    from zimi import users as _users

    action = data.get("action", "")
    name = data.get("name", "")
    kind = admin_kind(handler)  # 'primary' | 'secondary' (auth already passed)
    role = data.get("role")

    # The primary admin is a synthetic row — no CRUD action may target it.
    primary_name = _get_manage_user() or "admin"
    if name and name.strip().casefold() == primary_name.strip().casefold():
        return handler._json(403, {"error": "cannot modify the primary admin"})

    # Only the primary admin manages admin-role accounts. A secondary admin
    # cannot create an admin, nor touch an existing admin-role user.
    if kind != "primary":
        targets_admin_role = role == "admin"
        touches_existing_admin = bool(name) and _users.is_admin_user(name)
        if targets_admin_role or touches_existing_admin:
            return handler._json(
                403, {"error": "only the primary admin manages admins"}
            )

    if action == "create":
        ok, err = _users.create_user(
            name, data.get("password", ""), data.get("allowlist"), role=role
        )
    elif action == "delete":
        ok, err = _users.delete_user(name)
    elif action == "set-password":
        ok, err = _users.set_password(name, data.get("password", ""))
    elif action == "set-allowlist":
        ok, err = _users.set_allowlist(name, data.get("allowlist"))
    elif action == "set-role":
        ok, err = _users.set_role(name, role, data.get("allowlist"))
    elif action == "set-can-create":
        # Grant/revoke the per-user create permission (see users.set_can_create).
        # The hierarchy gate above already bars a secondary admin from touching
        # admin accounts; admins themselves are refused there (implicitly true).
        ok, err = _users.set_can_create(name, bool(data.get("can_create")))
    else:
        return handler._json(400, {"error": "unknown action"})
    if not ok:
        return handler._json(400, {"error": err or "operation failed"})
    return handler._json(200, {"status": "ok", "users": _users.list_users()})


# ============================================================================
# Manage POST Routes
# ============================================================================


# One-time download tickets: {token: (filename, expiry)}. Minted by an
# authorized admin, spent by the very next /dl/ navigation, dead in two
# minutes either way. In-memory on purpose — a restart invalidating tickets
# is correct behavior for a credential.
DL_TICKET_TTL_SEC = 120
_dl_tickets: dict = {}
_dl_ticket_lock = threading.Lock()


def spend_dl_ticket(token, fname):
    """True exactly once per ticket, and only for the file it was minted
    for. Wrong file, reuse, expiry — all read as no ticket at all."""
    if not token:
        return False
    now = time.time()
    with _dl_ticket_lock:
        entry = _dl_tickets.pop(token, None)
    return bool(entry and entry[1] >= now and entry[0] == fname)


def handle_manage_post(handler, parsed, data):
    """Handle all POST /manage/* requests. Called from ZimHandler.do_POST."""
    if not _srv.ZIMI_MANAGE:
        return handler._json(404, {"error": "Library management is disabled."})
    # Password management — browser only, not accessible via API
    if parsed.path == "/manage/set-password":
        # Env var controls password — UI changes would be silently overridden
        if os.environ.get("ZIMI_MANAGE_PASSWORD", ""):
            return handler._json(
                403,
                {
                    "error": "Password is controlled by ZIMI_MANAGE_PASSWORD environment variable"
                },
            )
        stored = _get_manage_password_hash()
        if stored:
            cur = data.get("current", "")
            if not cur or not _verify_password(cur, stored):
                return handler._json(401, {"error": "Current password is incorrect"})
        else:
            # Initial setup: there is no current password to verify, so the
            # public-lock is the only thing between a public client and a
            # full instance takeover. Gate it exactly like the rest of
            # manage — private clients set the first password, public clients
            # get 403 public_locked (must set it from the LAN).
            challenge = _manage_auth_challenge(handler)
            if challenge:
                return handler._json(*challenge)
        new_pw = data.get("password", "").strip()
        if not new_pw and _get_api_token():
            return handler._json(
                400, {"error": "Revoke the API token before removing the password"}
            )
        # OPTIONAL username stored alongside the hash. Absent field → None →
        # _set_manage_password preserves any existing username. When the env
        # var owns the username, the file copy is inert (env wins on read), so
        # we simply don't persist it.
        new_user = data.get("username")
        if new_user is not None and os.environ.get("ZIMI_MANAGE_USER", "").strip():
            new_user = None
        if not _set_manage_password(new_pw, username=new_user):
            # Generic on purpose: the OSError detail is already in the server
            # log, and error bodies never carry internal paths or str(e).
            return handler._json(
                500, {"error": "Could not save the password (storage is not writable)"}
            )
        # The setup key's life ends with the bootstrap it existed for.
        if new_pw:
            _clear_setup_key()
        return handler._json(
            200, {"status": "password set" if new_pw else "password cleared"}
        )

    # API token management — requires existing auth + password must be set
    if parsed.path == "/manage/generate-token":
        challenge = _manage_auth_challenge(handler)
        if challenge:
            return handler._json(*challenge)
        if not _get_manage_password_hash():
            return handler._json(
                400, {"error": "Set a password before generating an API token"}
            )
        token = _generate_api_token()
        if not token:
            # Same discipline as set-password above: log has the real reason.
            return handler._json(
                500, {"error": "Could not save the API token (storage is not writable)"}
            )
        return handler._json(200, {"token": token})
    if parsed.path == "/manage/revoke-token":
        challenge = _manage_auth_challenge(handler)
        if challenge:
            return handler._json(*challenge)
        _revoke_api_token()
        return handler._json(200, {"status": "token revoked"})
    if parsed.path == "/manage/dl-ticket":
        # A browser NAVIGATION to /dl/ carries none of Zimi's auth headers, so
        # right-click -> Download on a passworded instance used to land on an
        # HTML refusal Safari saved as name.zim.html. The authorized client
        # mints a one-time ticket here; the /dl/ URL spends it within 120s.
        challenge = _manage_auth_challenge(handler)
        if challenge:
            return handler._json(*challenge)
        fname = str(data.get("file") or "").strip()
        if not fname or "/" in fname or "\\" in fname or ".." in fname:
            return handler._json(400, {"error": "that is not a ZIM filename"})
        ticket = secrets.token_urlsafe(24)
        now = time.time()
        with _dl_ticket_lock:
            # Expired tickets leave with every mint; the dict stays tiny.
            for t in [t for t, (_, exp) in _dl_tickets.items() if exp < now]:
                _dl_tickets.pop(t, None)
            _dl_tickets[ticket] = (fname, now + DL_TICKET_TTL_SEC)
        return handler._json(200, {"ticket": ticket})

    # ZIM creation — a creator account (can_create) may drive these routes
    # without admin credentials, so they gate themselves ahead of the generic
    # admin challenge below. Every web mode captures the web, never the
    # server's disk: folder and archive import are both refused outright in
    # ``_create_validate`` (CLI-only), so there is no server-path mode left to
    # hold to the primary admin.
    if parsed.path in (
        "/manage/create",
        "/manage/create/cancel",
        "/manage/create/finish",
        "/manage/create/probe",
    ):
        denial = _creator_denial(handler)
        if denial:
            return handler._json(*denial)
        if parsed.path == "/manage/create/cancel":
            # With an id: that job, wherever it is — the running one or one
            # still waiting. Without: whatever is running.
            payload, status = _create_cancel(data.get("id"))
            return handler._json(status, payload)
        if parsed.path == "/manage/create/finish":
            # Cancel's keeping twin: stop FETCHING at the next page boundary
            # and package everything captured so far. Same auth as cancel.
            payload, status = _create_finish_now()
            return handler._json(status, payload)
        if parsed.path == "/manage/create":
            payload, status = _create_start(data, actor=activity_actor(handler))
        else:
            payload, status = _create_probe(data)
        return handler._json(status, payload)

    challenge = _manage_auth_challenge(handler)
    if challenge:
        return handler._json(*challenge)

    if parsed.path == "/manage/creator":
        # The write half of the Creator section: the two capture defaults the
        # Manage toggles set. Booleans only — a request that sends anything
        # else is a caller confused about the contract, and refusing is kinder
        # than storing junk a future job would silently obey. Admin-gated by
        # the challenge above, like every other manage settings write.
        updates = {}
        for key in ("block_ads", "capture_variants"):
            if key in data:
                value = data.get(key)
                if not isinstance(value, bool):
                    return handler._json(
                        400, {"error": f"'{key}' must be true or false"}
                    )
                updates[key] = value
        if not updates:
            return handler._json(400, {"error": "nothing to change"})
        _write_create_defaults(**updates)
        return handler._json(
            200,
            {
                "block_ads_default": _create_default("block_ads", CREATE_BLOCK_ADS),
                "capture_variants_default": _create_default(
                    "capture_variants", CREATE_CAPTURE_VARIANTS
                ),
            },
        )

    if parsed.path == "/manage/users":
        return _handle_users_post(handler, data)

    if parsed.path == "/manage/public-access":
        return _handle_public_access_post(handler, data)

    if parsed.path == "/manage/download":
        url = data.get("url", "")
        size_bytes = data.get("size_bytes")
        if not url:
            return handler._json(400, {"error": "missing 'url' in request body"})
        dl_id, err = _srv._start_download(
            url, size_bytes=size_bytes, actor=activity_actor(handler)
        )
        if err:
            return handler._json(400, {"error": err})
        return handler._json(200, {"status": "started", "id": dl_id})

    elif parsed.path == "/manage/download-batch":
        urls = data.get("urls")
        if not isinstance(urls, list):
            return handler._json(400, {"error": "missing 'urls' array in request body"})
        sizes = data.get("sizes") or []
        if not isinstance(sizes, list):
            sizes = []
        ids = []
        errors = []
        # One resolution for the whole batch — it is one click by one person.
        actor = activity_actor(handler)
        for i, url in enumerate(urls):
            if not isinstance(url, str) or not url:
                ids.append(None)
                errors.append("invalid url at index %d" % i)
                continue
            sz = (
                sizes[i]
                if i < len(sizes) and isinstance(sizes[i], (int, float))
                else None
            )
            dl_id, err = _srv._start_download(url, size_bytes=sz, actor=actor)
            ids.append(dl_id)
            errors.append(err)
        succeeded = sum(1 for x in ids if x is not None)
        return handler._json(200, {"ids": ids, "errors": errors, "started": succeeded})

    elif parsed.path == "/manage/download-from-peer":
        # Pull a ZIM straight from a discovered LAN peer over HTTP. The server
        # resolves peer→host:port from discovery state, so the client only
        # names the peer + file — it can't point us at an arbitrary URL.
        peer = data.get("peer")
        fname = data.get("file")
        if not isinstance(peer, str) or not peer:
            return handler._json(400, {"error": "missing 'peer'"})
        if not isinstance(fname, str) or not fname:
            return handler._json(400, {"error": "missing 'file'"})
        dl_id, err = _srv._start_peer_download(
            peer, fname, actor=activity_actor(handler)
        )
        if err:
            return handler._json(400, {"error": err})
        return handler._json(200, {"status": "started", "id": dl_id})

    elif parsed.path == "/manage/import":
        url = data.get("url", "")
        if not url:
            return handler._json(400, {"error": "missing 'url' in request body"})
        dl_id, err = _srv._start_import(url, actor=activity_actor(handler))
        if err:
            return handler._json(400, {"error": err})
        return handler._json(200, {"status": "started", "id": dl_id})

    elif parsed.path == "/manage/cancel":
        dl_id = data.get("id", "")
        from zimi.library import _cancel_download, _download_by_id, download_subject

        # Read the transfer's identity BEFORE cancelling it: a cancelled
        # download leaves the queue, and the journal line still has to name
        # what it was.
        cancelled = _download_by_id(dl_id)
        status, code = _cancel_download(dl_id)
        if status == "not_found":
            return handler._json(404, {"error": "Download not found"})
        if status == "already_done":
            return handler._json(400, {"error": "Download already finished"})
        if cancelled:
            record_activity(
                "update" if cancelled.get("is_update") else "download",
                download_subject(cancelled),
                outcome="cancelled",
                actor=activity_actor(handler),
            )
        return handler._json(code, {"status": status, "id": dl_id})

    elif parsed.path == "/manage/download-start-now":
        # Override the nightly window for one scheduled item — start it now
        # (or promote it to a normal queued item if every slot is busy).
        dl_id = data.get("id", "")
        from zimi.library import _start_scheduled_now

        status, code = _start_scheduled_now(dl_id)
        if status == "not_found":
            return handler._json(404, {"error": "Download not found"})
        return handler._json(code, {"status": status, "id": dl_id})

    elif parsed.path == "/manage/switch-direct":
        # Escape hatch for a slow BitTorrent swarm: abandon BT for this
        # download and pull it over HTTP instead.
        dl_id = data.get("id", "")
        from zimi.library import _switch_to_direct

        status, code = _switch_to_direct(dl_id)
        if status == "not_found":
            return handler._json(404, {"error": "Download not found"})
        if status == "already_done":
            return handler._json(400, {"error": "Download already finished"})
        if status == "not_bt":
            return handler._json(400, {"error": "Download is not using BitTorrent"})
        return handler._json(code, {"status": status, "id": dl_id})

    elif parsed.path == "/manage/clear-downloads":
        with _srv._download_lock:
            to_remove = [k for k, v in _srv._active_downloads.items() if v.get("done")]
            for k in to_remove:
                del _srv._active_downloads[k]
        return handler._json(200, {"status": "cleared", "removed": len(to_remove)})

    elif parsed.path == "/manage/refresh":
        # Re-scan ZIM directory and rebuild cache without full restart
        log.info("Library refresh triggered")
        with _srv._zim_lock:
            _srv.load_cache(force=True)
            count = len(_srv._zim_list_cache or [])
        _srv._search_cache_clear()
        _srv._suggest_cache_clear()
        _srv._clean_stale_title_indexes()
        return handler._json(200, {"status": "refreshed", "zim_count": count})

    elif parsed.path in ("/manage/pause", "/manage/resume"):
        dl_id = data.get("id", "")
        with _srv._download_lock:
            dl = _srv._active_downloads.get(dl_id)
            if not dl:
                return handler._json(404, {"error": "Download not found"})
            if dl.get("done"):
                return handler._json(400, {"error": "Download already finished"})
            dl["paused"] = parsed.path == "/manage/pause"
        return handler._json(
            200, {"status": "paused" if dl["paused"] else "resumed", "id": dl_id}
        )

    elif parsed.path == "/manage/cache-action":
        # Lightweight cache maintenance for the Server-settings UI.
        # action ∈ {clear-search, clear-suggest, rebuild-title, rebuild-qid}
        action = data.get("action", "")
        if action == "clear-search":
            _srv._search_cache_clear()
            return handler._json(200, {"status": "cleared", "target": "search"})
        if action == "clear-suggest":
            _srv._suggest_cache_clear()
            return handler._json(200, {"status": "cleared", "target": "suggest"})
        if action == "rebuild-title":
            # Heavy — run in background so the request returns immediately.
            import threading as _t

            _t.Thread(target=_srv._build_all_title_indexes, daemon=True).start()
            return handler._json(200, {"status": "started", "target": "title"})
        if action == "rebuild-qid":
            import threading as _t

            _t.Thread(target=_srv._build_all_qid_indexes, daemon=True).start()
            return handler._json(200, {"status": "started", "target": "qid"})
        return handler._json(400, {"error": "unknown action"})

    elif parsed.path == "/manage/health-check":
        # Kick off the library health report on a worker thread.
        from zimi import health as _health

        started, msg = _health.start_check()
        if started:
            _activity_after(
                _health.get_state,
                _activity_health_finish(activity_actor(handler)),
            )
        return handler._json(
            200, {"status": "started" if started else "running", "detail": msg}
        )

    elif parsed.path == "/manage/export-bookmarks":
        # Save bookmarks to standalone ZIM(s). The client POSTs its localStorage
        # bookmarks (client-side only — server has no copy) as either:
        #   {"bookmarks": [...]}                       → one ZIM (v1 / Export all)
        #   {"exports":  [{"name","title","bookmarks":[...]}, ...]}  → one ZIM each
        from zimi import zimwriter as _zw

        def _clean_bm(b):
            return {
                "zim": str(b.get("zim", "")),
                "path": str(b.get("path", "")),
                "title": str(b.get("title", "")),
                "section": str(b.get("section", "")),
            }

        def _safe_name(s):
            s = re.sub(r"[^a-zA-Z0-9._-]+", "_", str(s or "")).strip("_.")
            return s[:60] or None

        exports = data.get("exports")
        total = 0
        if isinstance(exports, list) and exports:
            payload = []
            for job in exports:
                if not isinstance(job, dict):
                    continue
                bms = [
                    _clean_bm(b)
                    for b in (job.get("bookmarks") or [])
                    if isinstance(b, dict)
                ]
                if not bms:
                    continue
                total += len(bms)
                # Section headers the index must render even when empty (an
                # exported empty folder is shown, never silently dropped).
                sections = [
                    str(s)[:120]
                    for s in (job.get("sections") or [])[:200]
                    if isinstance(s, str) and s.strip()
                ]
                payload.append(
                    {
                        "name": _safe_name(job.get("name")),
                        "title": str(job.get("title") or "")[:120] or None,
                        "sections": sections,
                        "bookmarks": bms,
                    }
                )
            if not payload:
                return handler._json(400, {"error": "No bookmarks to export"})
        else:
            bookmarks = data.get("bookmarks")
            if not isinstance(bookmarks, list) or not bookmarks:
                return handler._json(400, {"error": "No bookmarks to export"})
            payload = [_clean_bm(b) for b in bookmarks if isinstance(b, dict)]
            total = len(payload)

        if total > 2000:
            return handler._json(400, {"error": "Too many bookmarks (max 2000)"})
        started, msg = _zw.start_export(payload)
        if started:
            _activity_after(
                _zw.get_export_state,
                _activity_export_finish(activity_actor(handler), total),
            )
        return handler._json(
            200, {"status": "started" if started else "busy", "detail": msg}
        )

    elif parsed.path == "/manage/build-fts":
        zim_name = data.get("name", "")
        if not zim_name:
            return handler._json(400, {"error": "Missing 'name' parameter"})
        try:
            result = _srv._build_fts_for_index(zim_name)
            return handler._json(200, result)
        except FileNotFoundError as e:
            log.warning("FTS build: ZIM not found: %s", e)
            return handler._json(404, {"error": "ZIM not found"})
        except Exception as e:
            log.error("FTS build failed for %s: %s", zim_name, e)
            return handler._json(500, {"error": "FTS build failed"})

    elif parsed.path == "/manage/delete":
        filename = data.get("filename", "")
        if not filename or ".." in filename or "/" in filename:
            return handler._json(400, {"error": "Invalid filename"})
        if not filename.endswith(".zim"):
            return handler._json(400, {"error": "Only .zim files can be deleted"})
        # A ZIM in a SUBFOLDER (everything `zimi create` writes lands in
        # created/, and folders are categories now) is listed by its basename,
        # so joining it onto ZIM_DIR looked in the wrong directory: the delete
        # 404'd, the file survived, and the next scan brought it straight back
        # (Eric: "the ones I deleted kept coming back"). Resolve through the
        # library's own name→path map, which knows where each file actually is,
        # and keep the traversal guard by requiring the result to live under
        # ZIM_DIR.
        filepath = os.path.join(_srv.ZIM_DIR, filename)
        if not os.path.exists(filepath):
            root = os.path.realpath(_srv.ZIM_DIR)
            for candidate in (_srv.get_zim_files() or {}).values():
                if os.path.basename(candidate) != filename:
                    continue
                resolved = os.path.realpath(candidate)
                if resolved == root or not resolved.startswith(root + os.sep):
                    continue  # outside the library — not ours to delete
                filepath = resolved
                break
        if not os.path.exists(filepath):
            return handler._json(404, {"error": f"File not found: {filename}"})
        try:
            file_size = 0
            try:
                file_size = os.path.getsize(filepath)
            except OSError:
                pass
            # Cache ZIM info before deletion so history shows proper title/icon
            zim_info = {}
            try:
                for z in _srv._zim_list_cache or []:
                    if z.get("file") == filename:
                        zim_info = {
                            "title": z.get("title", ""),
                            "name": z.get("name", ""),
                            "has_icon": z.get("has_icon", False),
                        }
                        break
            except Exception as e:
                log.debug(
                    "Failed to cache ZIM metadata before deletion of %s: %s",
                    filename,
                    e,
                )
                pass
            os.remove(filepath)
            log.info(f"Deleted ZIM: {filename}")
            record_activity(
                "delete",
                zim_info.get("title") or zim_info.get("name") or filename,
                actor=activity_actor(handler),
                size_bytes=file_size,
            )
            _srv._append_history(
                {
                    "event": "deleted",
                    "ts": time.time(),
                    "filename": filename,
                    "size_bytes": file_size,
                    **zim_info,
                }
            )
            # Splice the file out of the live library instead of rebuilding it.
            # The old shape here — load_cache(force=True) under _zim_lock —
            # re-opened and re-scanned every archive while holding the lock
            # every libzim request needs, so pressing Delete froze search and
            # reading for the length of the rescan (#51). The full rescan
            # survives as the fallback for the cases the splice won't handle.
            unregistered = False
            try:
                unregistered = _srv.unregister_zim_file(filename)
            except Exception as e:
                log.warning(
                    "Incremental removal of %s failed (%s) — falling back to a "
                    "full library rescan",
                    filename,
                    e,
                )
            if not unregistered:
                with _srv._zim_lock:
                    _srv.load_cache(force=True)
            _srv._search_cache_clear()
            _srv._suggest_cache_clear()
            _srv._clean_stale_title_indexes()
            # The library just changed size — don't show the pre-delete free
            # space for the rest of the memo window. Imported here, not at
            # module scope: http.py imports this module.
            from zimi import http as _http

            _http._reset_disk_usage_cache()
            # Stop seeding the file we just deleted. Without this the engine
            # keeps advertising (and hash-check failing) the missing file
            # until the 12h maintenance pass or a restart. peek_backend()
            # no-ops when BT is off, so this is safe unconditionally; run it
            # off the response thread.
            try:
                from zimi import library as _lib

                threading.Thread(target=_lib.retire_stale_seeds, daemon=True).start()
            except Exception as e:
                log.debug("Post-delete seed retire skipped: %s", e)
            return handler._json(200, {"status": "deleted", "filename": filename})
        except OSError as e:
            log.error("Failed to delete %s: %s", filename, e)
            return handler._json(500, {"error": "Failed to delete file"})

    elif parsed.path == "/manage/cleanup-tmp":
        # Remove only genuinely orphaned partials. Defense in depth: even if a
        # stale client posts this, never delete an active, queued, or
        # resumable-with-progress .zim.tmp the user still wants.
        from zimi import library as _lib

        _protected, orphaned = _lib.classify_partials()
        removed = []
        for info in orphaned:
            fpath = os.path.join(_srv.ZIM_DIR, info["filename"])
            try:
                os.remove(fpath)
                removed.append(
                    {"filename": info["filename"], "size_bytes": info["size_bytes"]}
                )
                log.info("Cleaned up orphaned partial download: %s", info["filename"])
            except OSError:
                pass
        return handler._json(200, {"removed": removed})

    elif parsed.path == "/manage/update":
        # Trigger manual update: check for updates and start downloads
        updates = _srv._check_updates()
        started = []
        # Eric's case exactly: this is the same work the auto-updater does, and
        # the only difference worth recording is that a person asked for it.
        actor = activity_actor(handler)
        for upd in updates:
            url = upd.get("download_url")
            if url:
                dl_id, err = _srv._start_download(url, actor=actor)
                if not err:
                    started.append({"name": upd.get("name", "?"), "id": dl_id})
        return handler._json(
            200, {"status": "started", "count": len(started), "downloads": started}
        )

    elif parsed.path == "/manage/auto-update":
        if _srv._auto_update_env_locked:
            return handler._json(
                403, {"error": "Auto-update is controlled by ZIMI_AUTO_UPDATE env var"}
            )
        enabled = data.get("enabled", _srv._auto_update_enabled)
        freq = data.get("frequency", _srv._auto_update_freq)
        if freq not in _srv._FREQ_SECONDS:
            return handler._json(
                400,
                {
                    "error": f"Invalid frequency. Use: {', '.join(_srv._FREQ_SECONDS.keys())}"
                },
            )
        _srv._auto_update_freq = freq
        if enabled and not _srv._auto_update_enabled:
            _srv._auto_update_enabled = True
            if _srv._auto_update_thread and _srv._auto_update_thread.is_alive():
                log.info("Auto-update thread still running, reusing it")
            else:
                _srv._auto_update_thread = threading.Thread(
                    target=_srv._auto_update_loop,
                    kwargs={"initial_delay": 30},
                    daemon=True,
                )
                _srv._auto_update_thread.start()
            log.info("Auto-update enabled: %s (first check in 30s)", freq)
        elif not enabled and _srv._auto_update_enabled:
            _srv._auto_update_enabled = False
            log.info("Auto-update disabled")
        _srv._save_auto_update_config(_srv._auto_update_enabled, _srv._auto_update_freq)
        return handler._json(
            200,
            {"enabled": _srv._auto_update_enabled, "frequency": _srv._auto_update_freq},
        )

    elif parsed.path == "/manage/app-update-check":
        # "Check now" for the Zimi APP release check — bypasses the daily
        # cache but keeps a short flood guard (see check_app_update). Distinct
        # from /manage/auto-update directly above, which is ZIM content.
        return handler._json(200, _app_update_payload(force=True))

    elif parsed.path == "/manage/app-update-delay":
        # How long a release must have been public before this instance is
        # offered it. Same env-lock contract as the channel above.
        days, err = set_update_delay_days(data.get("delay_days"))
        if err == "env_locked":
            return handler._json(
                403,
                {
                    "error": "Update delay is controlled by the %s env var"
                    % APP_UPDATE_DELAY_ENV
                },
            )
        if err:
            return handler._json(
                400,
                {
                    "error": "Invalid delay. Use whole days, 0 to %d"
                    % APP_UPDATE_DELAY_MAX
                },
            )
        log.info("App update delay set to %d day(s)", days)
        # The delay is applied when the payload is built, so no re-check is
        # needed — the cached answer is still the right answer.
        return handler._json(200, _app_update_payload())

    elif parsed.path == "/manage/app-update-channel":
        # Latest vs beta for the APP release check. Same env-lock contract
        # as the other settings endpoints: ZIMI_UPDATE_CHANNEL wins and the
        # write is refused rather than silently ignored.
        channel, err = set_update_channel(data.get("channel"))
        if err == "env_locked":
            return handler._json(
                403,
                {
                    "error": "Update channel is controlled by the %s env var"
                    % APP_UPDATE_CHANNEL_ENV
                },
            )
        if err:
            return handler._json(
                400,
                {"error": "Invalid channel. Use: %s" % ", ".join(APP_UPDATE_CHANNELS)},
            )
        log.info("App update channel set to %s", channel)
        # Answer with the full payload so the pane repaints from one response;
        # the channel switch invalidates the cache, so this re-checks.
        return handler._json(200, _app_update_payload())

    elif parsed.path == "/manage/download-schedule":
        # Night-window queueing + the global download-speed cap. Same env-lock
        # contract as the other settings endpoints: ZIMI_DL_WINDOW locks the
        # window, ZIMI_BT_DOWN_KB (via bt_down_kb) locks the speed cap.
        from zimi import library as _lib
        from zimi import p2p

        sched = _lib._load_download_schedule()
        # Window fields + the upload restrictor (restrict seeding to the window
        # + its trickle cap). All ride the same config file, so one save covers
        # any subset the client sent; absent fields are preserved.
        window_keys = (
            "enabled",
            "start",
            "end",
            "upload_restrict",
            "upload_trickle_kb",
        )
        if any(k in data for k in window_keys):
            if sched.get("locked"):
                return handler._json(
                    403,
                    {
                        "error": "Download window is controlled by the ZIMI_DL_WINDOW env var"
                    },
                )
            enabled = bool(data.get("enabled", sched["enabled"]))
            start = data.get("start", sched["start"])
            end = data.get("end", sched["end"])
            if _lib._parse_hhmm(start) is None or _lib._parse_hhmm(end) is None:
                return handler._json(
                    400, {"error": "start/end must be 'HH:MM' (24-hour)"}
                )
            upload_restrict = (
                bool(data["upload_restrict"])
                if "upload_restrict" in data
                else sched["upload_restrict"]
            )
            upload_trickle_kb = sched["upload_trickle_kb"]
            if "upload_trickle_kb" in data:
                try:
                    upload_trickle_kb = max(1, int(data["upload_trickle_kb"]))
                except (ValueError, TypeError):
                    return handler._json(
                        400, {"error": "upload_trickle_kb must be a number"}
                    )
            if not _lib._save_download_schedule(
                enabled, start, end, upload_restrict, upload_trickle_kb
            ):
                return handler._json(
                    500, {"error": "could not save setting (config dir not writable)"}
                )
            # Whether the window just opened or scheduling was turned off,
            # release anything already waiting now — don't wait for a tick.
            threading.Thread(target=_lib._download_schedule_tick, daemon=True).start()
        # Global download-speed cap (KB/s, 0 = unlimited) — shared with the BT
        # download limit so one number governs every transport.
        if "download_kb" in data:
            if p2p.is_bt_down_env_locked():
                return handler._json(
                    403,
                    {
                        "error": "Download speed limit is controlled by the ZIMI_BT env var"
                    },
                )
            try:
                kb = max(0, int(data["download_kb"]))
            except (ValueError, TypeError):
                return handler._json(400, {"error": "download_kb must be a number"})
            if not p2p.set_pref("bt_down_kb", kb):
                return handler._json(
                    500, {"error": "could not save setting (config dir not writable)"}
                )
            p2p.apply_rate_limits()
        return handler._json(200, _lib._download_schedule_status())

    elif parsed.path == "/manage/seeding-action":
        # Pause / resume / stop one seed, or stop everything — the
        # sidecar shouldn't need a terminal to be told to quiet down.
        from zimi import p2p

        backend = p2p.peek_backend()
        if backend is None:
            return handler._json(400, {"error": "BitTorrent engine is not running"})
        from zimi import library as _lib_seeds

        action = data.get("action", "")
        if action == "stop_all":
            stopped = 0
            try:
                for raw in backend.list_managed():
                    files = raw.get("files", [])
                    fname = os.path.basename(files[0].get("path", "")) if files else ""
                    if not fname.endswith(".zim"):
                        continue
                    # Same in-flight guard as the /manage/seeding list:
                    # list_managed() returns downloading torrents too, and an
                    # active BT download lives in the staging dir — where
                    # remove(delete_files=True) really deletes payload. The
                    # seeds panel never showed those rows; the button that
                    # says "remove from seeding" must not cancel downloads.
                    if _bt_still_downloading(raw):
                        continue
                    try:
                        backend.remove(raw.get("gid", ""), delete_files=True)
                        stopped += 1
                        # A user stop is deliberate — don't resurrect it
                        # from the intent ledger at next startup.
                        _lib_seeds.unrecord_seed(fname)
                    except Exception:
                        pass
            except Exception:
                pass
            log.info("Seeding: stopped all (%d)", stopped)
            return handler._json(200, {"status": "ok", "stopped": stopped})
        tid = data.get("id", "")
        if not tid or action not in ("pause", "resume", "stop"):
            return handler._json(
                400, {"error": "provide id and action: pause/resume/stop/stop_all"}
            )
        try:
            if action == "pause":
                backend.pause(tid)
            elif action == "resume":
                backend.resume(tid)
            else:
                # Resolve the filename BEFORE removing, to drop its ledger
                # intent too — a user stop must not come back at startup.
                _stop_fname = ""
                try:
                    for _raw in backend.list_managed():
                        if _raw.get("gid", "") == tid:
                            _fs = _raw.get("files", [])
                            if _fs:
                                _stop_fname = os.path.basename(_fs[0].get("path", ""))
                            break
                except Exception:
                    pass
                backend.remove(tid, delete_files=True)
                if _stop_fname:
                    _lib_seeds.unrecord_seed(_stop_fname)
        except Exception:
            return handler._json(502, {"error": "engine refused the action"})
        return handler._json(200, {"status": "ok"})

    elif parsed.path == "/manage/nat-recheck":
        # The "retry" button every real BT client has: re-map UPnP and
        # re-test reachability. Slow (SSDP + external check, a few
        # seconds) but explicitly user-initiated.
        from zimi import p2p, p2p_nat

        if not p2p.is_torrent_enabled():
            return handler._json(400, {"error": "BitTorrent is turned off"})
        result = p2p_nat.probe(p2p.get_bt_port(), try_upnp=p2p.is_upnp_enabled())
        return handler._json(200, {"nat": result})

    elif parsed.path == "/manage/bt-settings":
        # Seed/mirror toggles. An env var locks its field — UI changes would
        # be silently overridden on next read (same contract as auto-update).
        from zimi import p2p

        changed = {}
        if "seed" in data:
            if p2p.is_seed_env_locked():
                return handler._json(
                    403, {"error": "Seeding is controlled by the ZIMI_BT env var"}
                )
            if not p2p.set_pref("seed", bool(data["seed"])):
                return handler._json(
                    500, {"error": "could not save setting (config dir not writable)"}
                )
            changed["seed"] = bool(data["seed"])
            # Settings govern LIVE seeds too: toggling seeding off stops the
            # running library seeds (files stay); on re-caps them.
            from zimi import library as _lib_seed

            threading.Thread(target=_lib_seed.apply_seed_policy, daemon=True).start()
        if "mirror" in data:
            if p2p.is_mirror_env_locked():
                return handler._json(
                    403,
                    {"error": "Mirror mode is controlled by the ZIMI_BT env var"},
                )
            if not p2p.set_pref("mirror", bool(data["mirror"])):
                return handler._json(
                    500, {"error": "could not save setting (config dir not writable)"}
                )
            changed["mirror"] = bool(data["mirror"])
            from zimi import library as _lib

            if changed["mirror"]:
                # Seed the installed library now, off the request thread
                # (hash checks + torrent fetches take a while).
                def _mirror_kickoff():
                    # Retag seeds that predate mirror mode to the mirror's
                    # uncapped ratio before syncing in the rest.
                    _lib.apply_seed_policy()
                    _lib.mirror_sync()
                    _lib.archive_catalog_torrents()

                threading.Thread(target=_mirror_kickoff, daemon=True).start()
            else:
                # Off = stop seeding, keep the archive (a toggle never
                # deletes a backup; Mirror on again re-seeds from disk).
                threading.Thread(target=_lib.stop_mirror_seeds, daemon=True).start()
        if "peer_share" in data:
            from zimi import p2p_discovery as _disc

            if _disc.is_share_env_locked():
                return handler._json(
                    403,
                    {"error": "LAN sharing is controlled by the ZIMI_NEARBY env var"},
                )
            if not p2p.set_pref("peer_share", bool(data["peer_share"])):
                return handler._json(
                    500, {"error": "could not save setting (config dir not writable)"}
                )
            changed["peer_share"] = bool(data["peer_share"])
        if "bt_port" in data:
            if p2p.is_bt_port_env_locked():
                return handler._json(
                    403, {"error": "The BT port is controlled by the ZIMI_BT env var"}
                )
            try:
                port = int(data["bt_port"])
                assert 1024 <= port <= 65535
            except (ValueError, TypeError, AssertionError):
                return handler._json(400, {"error": "Port must be 1024-65535"})
            if not p2p.set_pref("bt_port", port):
                return handler._json(
                    500, {"error": "could not save setting (config dir not writable)"}
                )
            changed["bt_port"] = port

            # Apply live: respawn the sidecar on the new port + re-map UPnP
            def _respawn():
                p2p.shutdown_backend()
                if p2p.get_backend(data_dir=_srv.ZIMI_DATA_DIR):
                    try:
                        from zimi import p2p_nat

                        p2p_nat.probe(port, try_upnp=p2p.is_upnp_enabled())
                    except Exception:
                        pass

            threading.Thread(target=_respawn, daemon=True).start()
        if "upnp" in data:
            if p2p.is_upnp_env_locked():
                return handler._json(
                    403, {"error": "UPnP is controlled by the ZIMI_BT env var"}
                )
            if not p2p.set_pref("upnp", bool(data["upnp"])):
                return handler._json(
                    500, {"error": "could not save setting (config dir not writable)"}
                )
            changed["upnp"] = bool(data["upnp"])
        if "torrent" in data:
            if p2p.is_torrent_env_locked():
                return handler._json(
                    403,
                    {"error": "BitTorrent is controlled by the ZIMI_BT env var"},
                )
            on = bool(data["torrent"])
            if not p2p.set_pref("torrent", on):
                return handler._json(
                    500, {"error": "could not save setting (config dir not writable)"}
                )
            changed["torrent"] = on
            if not on:
                # Switch off means OFF — stop the sidecar (and its seeds) now.
                try:
                    p2p.shutdown_backend()
                except Exception:
                    pass
            else:
                # Switch on means ON — bring the sidecar up now. Status
                # endpoints only peek, so without this nothing spawns it
                # until the next download and the UI dot stays grey.
                def _spawn_now():
                    try:
                        p2p.get_backend(data_dir=_srv.ZIMI_DATA_DIR)
                    except Exception:
                        pass

                threading.Thread(target=_spawn_now, daemon=True).start()
        if "peer_name" in data:
            from zimi import p2p_discovery as _disc2

            if _disc2.is_name_env_locked():
                return handler._json(
                    403,
                    {"error": "Peer name is controlled by the ZIMI_NEARBY env var"},
                )
            name = str(data["peer_name"]).strip()[:63]
            if not p2p.set_pref("peer_name", name):
                return handler._json(
                    500, {"error": "could not save setting (config dir not writable)"}
                )
            changed["peer_name"] = name
            # Apply live: re-register the mDNS advertisement with the new
            # name — no restart required.
            from zimi import p2p_discovery as _disc2

            threading.Thread(target=_disc2.restart_advertising, daemon=True).start()
        if "seed_ratio" in data:
            if p2p.is_seed_ratio_env_locked():
                return handler._json(
                    403,
                    {"error": "Seed ratio is controlled by the ZIMI_BT env var"},
                )
            try:
                ratio = max(0.0, min(10.0, float(data["seed_ratio"])))
            except (ValueError, TypeError):
                return handler._json(400, {"error": "seed_ratio must be a number"})
            if not p2p.set_pref("seed_ratio", ratio):
                return handler._json(
                    500, {"error": "could not save setting (config dir not writable)"}
                )
            changed["seed_ratio"] = ratio
            # Apply the new cap to every live library seed, not just future
            # adds — the ledger stops seeds already past the new ratio.
            from zimi import library as _lib_ratio

            threading.Thread(target=_lib_ratio.apply_seed_policy, daemon=True).start()
        # Global bandwidth caps (KB/s, 0 = unlimited). Applied live to the
        # running session so a new limit takes effect without a restart.
        for _field, _envlock in (
            ("bt_up_kb", p2p.is_bt_up_env_locked),
            ("bt_down_kb", p2p.is_bt_down_env_locked),
        ):
            if _field in data:
                if _envlock():
                    return handler._json(
                        403,
                        {
                            "error": "Bandwidth limits are controlled by the ZIMI_BT env var"
                        },
                    )
                try:
                    kb = max(0, int(data[_field]))
                except (ValueError, TypeError):
                    return handler._json(400, {"error": f"{_field} must be a number"})
                if not p2p.set_pref(_field, kb):
                    return handler._json(
                        500,
                        {"error": "could not save setting (config dir not writable)"},
                    )
                changed[_field] = kb
        if any(k in changed for k in ("bt_up_kb", "bt_down_kb")):
            p2p.apply_rate_limits()
        # Max concurrent downloads (governs HTTP + BT via library.py's queue).
        if "max_active_downloads" in data:
            if p2p.is_max_active_downloads_env_locked():
                return handler._json(
                    403,
                    {"error": "Max concurrent downloads is controlled by an env var"},
                )
            try:
                n = max(1, min(20, int(data["max_active_downloads"])))
            except (ValueError, TypeError):
                return handler._json(
                    400, {"error": "max_active_downloads must be a number"}
                )
            if not p2p.set_pref("max_active_downloads", n):
                return handler._json(
                    500, {"error": "could not save setting (config dir not writable)"}
                )
            changed["max_active_downloads"] = n
            # Raising the cap frees slots that nothing else would drain until a
            # download finishes — promote queued items now.
            from zimi import library as _lib_cc

            threading.Thread(target=_lib_cc.drain_download_queue, daemon=True).start()
        # Max connections — a real libtorrent session setting, applied live.
        if "bt_max_connections" in data:
            if p2p.is_bt_max_connections_env_locked():
                return handler._json(
                    403,
                    {"error": "Max connections is controlled by the ZIMI_BT env var"},
                )
            try:
                n = max(10, min(2000, int(data["bt_max_connections"])))
            except (ValueError, TypeError):
                return handler._json(
                    400, {"error": "bt_max_connections must be a number"}
                )
            if not p2p.set_pref("bt_max_connections", n):
                return handler._json(
                    500, {"error": "could not save setting (config dir not writable)"}
                )
            changed["bt_max_connections"] = n
            p2p.apply_session_limits()
        if not changed:
            return handler._json(
                400,
                {"error": "provide torrent/seed/mirror/peer_share/seed_ratio"},
            )
        log.info("BT settings updated via UI: %s", changed)
        return handler._json(200, p2p.get_mirror_status())

    elif parsed.path == "/manage/hot":
        # Pro hot-cache live update. Rejected when ZIMI_HOT_ZIMS env var is set
        # (env wins, UI changes would be silently ignored on next read).
        if "ZIMI_HOT_ZIMS" in os.environ:
            return handler._json(
                403,
                {
                    "error": "Hot ZIMs are controlled by ZIMI_HOT_ZIMS environment variable"
                },
            )
        names = data.get("hot_zims")
        if not isinstance(names, list):
            return handler._json(
                400, {"error": "missing 'hot_zims' array in request body"}
            )
        # Drop unknown ZIMs rather than 400 — UI can show warnings client-side.
        zim_files = _srv.get_zim_files()
        valid = [n for n in names if isinstance(n, str) and n in zim_files]
        try:
            _srv.set_hot_zims(valid)
        except (TypeError, ValueError) as e:
            log.warning("set_hot_zims rejected payload: %s", e)
            return handler._json(400, {"error": "invalid hot_zims payload"})
        return handler._json(200, {"hot_zims": valid, "saved": len(valid)})

    elif parsed.path == "/manage/library-layout":
        # Per-ZIM category overrides + home section order (#37). Merge-patch:
        # `overrides` is merged key-by-key (empty string clears an entry back to
        # the heuristic); `section_order` fully replaces when present. Either key
        # may be omitted so "Move to…" and "Reorder" send minimal payloads.
        overrides = data.get("overrides")
        order = data.get("section_order")
        sections = data.get("sections")
        if overrides is None and order is None and sections is None:
            return handler._json(400, {"error": "nothing to update"})
        err = _validate_library_layout(overrides, order, sections)
        if err:
            return handler._json(400, {"error": err})
        layout = _apply_library_layout(overrides, order, sections)
        return handler._json(
            200,
            {
                "status": "ok",
                "overrides": layout.get("overrides", {}),
                "section_order": layout.get("section_order", []),
                "sections": layout.get("sections", []),
            },
        )

    elif parsed.path == "/manage/backup":
        # Restore a backup bundle. Two-step so nothing lands before the admin
        # confirms: action="preview" (default) returns a diff summary and
        # applies NOTHING; action="apply" writes. MERGE by default; overwrite
        # replaces wholesale. A server-scope bundle is admin-only in BOTH
        # directions — a non-admin session can't preview OR apply one.
        if _bundle_scope(data) == "server" and admin_kind(handler) is None:
            return handler._json(403, {"error": "full-server backup requires an admin"})
        action = data.get("action", "preview")
        overwrite = bool(data.get("overwrite"))
        if action == "apply":
            result, err = _apply_backup_bundle(data, overwrite=overwrite)
            record_activity(
                "restore",
                "",  # the server's own state — named on the client
                outcome="failed" if err else "ok",
                detail=err or "",
                actor=activity_actor(handler),
                count=len((result or {}).get("applied") or []),
            )
            if err:
                return handler._json(400, {"error": err})
            return handler._json(200, result)
        # Preview (default): compute the diff, persist nothing.
        _plan, preview, err = _compute_backup(data, overwrite)
        if err:
            return handler._json(400, {"error": err})
        return handler._json(200, {"status": "preview", "preview": preview})

    else:
        return handler._json(404, {"error": "not found"})
