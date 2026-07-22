"""Named user accounts + per-user ZIM allowlists (multi-user v1, v1.8).

The existing password account is the *admin* (see ``manage.py``); this module adds
N *named users* on top of it. A user account carries either all-access or an explicit
ZIM-name allowlist. When a USER is logged in, the read surface (/list, /search,
/suggest, /read, /w/, /random, /chunks, /almanac-links) is filtered to their
allowlist server-side. Anonymous visitors and the admin see everything — v1 does
NOT force login; a user LOGS IN to get their restricted view (e.g. a kid's device
stays logged in as the kid).

Identity never collides with admin: a user authenticates to a random *session
token* (delivered via the ``zimi_session`` cookie so header-less iframe ``/w/``
requests carry it, and returned for ``Authorization: Bearer`` use by API clients).
A session token never matches the admin password hash, so ``manage._check_manage_auth``
rejects users from ``/manage/*`` automatically.

Storage (both under ZIMI_DATA_DIR, atomic writes):
- ``users.json``   — {version, users: {casefold_name: {name, pw, allowlist, flags, created}}}
- ``sessions.json``— {version, sessions: {sha256(token): {user, created}}}

``allowlist`` semantics: a list restricts the account to those ZIM names; ``None``
(or absent) means an all-access user. ``flags`` is a per-user dict reserved as the
v2 seam (kid mode, history monitoring, forced login, schools) — unused in v1.
"""

import hashlib
import logging
import os
import re
import secrets
import threading
import time

import zimi.server as _srv

log = logging.getLogger("zimi")

_USERS_VERSION = 1
_SESSIONS_VERSION = 1

#: Reserved names that can't be a user (admin is the password account; the others
#: avoid confusing UI labels). Compared case-insensitively.
_RESERVED_NAMES = {"admin", "administrator", "root", "anonymous", "anon"}

#: Usernames: 1-32 chars, letters/digits/space/._- (kept permissive for kids'
#: names + school labels, but no control chars, slashes, or newlines).
_NAME_RE = re.compile(r"^[\w .\-]{1,32}$", re.UNICODE)

_SESSION_TOKEN_BYTES = 32  # secrets.token_urlsafe(32) → ~43 url-safe chars

# One lock guards both files' read-modify-write cycles. Writes are rare
# (admin CRUD, login/logout), so a single coarse lock is simplest and correct.
_lock = threading.RLock()


# ============================================================================
# Paths
# ============================================================================


def _users_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, "users.json")


def _sessions_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, "sessions.json")


# ============================================================================
# Password hashing — reuse the admin PBKDF2 path (identical security bar)
# ============================================================================


def _hash_pw(pw):
    from zimi import manage

    return manage._hash_pw(pw)


def _verify_pw(candidate, stored):
    from zimi import manage

    return manage._verify_password(candidate, stored)


# ============================================================================
# users.json load/save
# ============================================================================


def _load_users():
    """Return the users dict {casefold_name: record}. Missing/corrupt → {}.

    Legacy installs have no users.json → {} → request_allow() returns None
    (all-access) so nothing changes for single-password deployments.
    """
    try:
        import json

        with open(_users_path(), encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or data.get("version") != _USERS_VERSION:
            return {}
        users = data.get("users", {})
        return users if isinstance(users, dict) else {}
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _save_users(users):
    _srv._atomic_write_json(
        _users_path(), {"version": _USERS_VERSION, "users": users}, indent=2
    )


def _key(name):
    """Casefold lookup key for a display name."""
    return (name or "").strip().casefold()


# ============================================================================
# sessions.json — tokens stored HASHED at rest (never plaintext)
# ============================================================================


def _token_hash(token):
    return hashlib.sha256((token or "").encode()).hexdigest()


def _load_sessions():
    try:
        import json

        with open(_sessions_path(), encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or data.get("version") != _SESSIONS_VERSION:
            return {}
        s = data.get("sessions", {})
        return s if isinstance(s, dict) else {}
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _save_sessions(sessions):
    _srv._atomic_write_json(
        _sessions_path(), {"version": _SESSIONS_VERSION, "sessions": sessions}, indent=2
    )


# ============================================================================
# Validation
# ============================================================================


def _valid_name(name):
    if not isinstance(name, str):
        return False
    n = name.strip()
    if not _NAME_RE.match(n):
        return False
    if n.casefold() in _RESERVED_NAMES:
        return False
    return True


def _clean_allowlist(allowlist):
    """Normalize an allowlist input to a sorted list of str, or None for all-access.

    None/absent → all-access. A list → de-duplicated str names (unknown names are
    kept as-is; the filter simply never matches them, and the admin UI only offers
    installed ZIMs). Returns (value_or_None, error_or_None).
    """
    if allowlist is None:
        return None, None
    if not isinstance(allowlist, list):
        return None, "allowlist must be a list or null"
    out = []
    for item in allowlist:
        if not isinstance(item, str):
            return None, "allowlist entries must be strings"
        item = item.strip()
        if item and item not in out:
            out.append(item)
    return sorted(out), None


# ============================================================================
# CRUD
# ============================================================================


def get_user(name):
    """Return the stored record for a display/lookup name, or None."""
    return _load_users().get(_key(name))


def list_users():
    """Public listing (NO password hashes) sorted by display name."""
    users = _load_users()
    out = []
    for rec in users.values():
        allowlist = rec.get("allowlist")
        out.append(
            {
                "name": rec.get("name", ""),
                "all_access": allowlist is None,
                "allowlist": allowlist if isinstance(allowlist, list) else [],
                "flags": rec.get("flags", {}) or {},
                "created": rec.get("created", 0),
            }
        )
    out.sort(key=lambda u: u["name"].casefold())
    return out


def create_user(name, password, allowlist=None):
    """Create a user. Returns (ok: bool, error: str|None)."""
    if not _valid_name(name):
        return False, "invalid name"
    if not isinstance(password, str) or len(password) < 1:
        return False, "password required"
    allow, err = _clean_allowlist(allowlist)
    if err:
        return False, err
    with _lock:
        users = _load_users()
        if _key(name) in users:
            return False, "user already exists"
        users[_key(name)] = {
            "name": name.strip(),
            "pw": _hash_pw(password),
            "allowlist": allow,
            "flags": {},  # v2 seam — kid mode / history monitoring / forced login
            "created": int(time.time()),
        }
        _save_users(users)
    log.info("User created: %s (all_access=%s)", name.strip(), allow is None)
    return True, None


def delete_user(name):
    """Delete a user and drop all their live sessions. Returns (ok, error)."""
    with _lock:
        users = _load_users()
        if _key(name) not in users:
            return False, "user not found"
        del users[_key(name)]
        _save_users(users)
        _drop_user_sessions_locked(_key(name))
    log.info("User deleted: %s", name)
    return True, None


def set_password(name, password):
    if not isinstance(password, str) or len(password) < 1:
        return False, "password required"
    with _lock:
        users = _load_users()
        rec = users.get(_key(name))
        if not rec:
            return False, "user not found"
        rec["pw"] = _hash_pw(password)
        _save_users(users)
        # A password change invalidates existing sessions (re-login required).
        _drop_user_sessions_locked(_key(name))
    log.info("User password set: %s", name)
    return True, None


def set_allowlist(name, allowlist):
    allow, err = _clean_allowlist(allowlist)
    if err:
        return False, err
    with _lock:
        users = _load_users()
        rec = users.get(_key(name))
        if not rec:
            return False, "user not found"
        rec["allowlist"] = allow
        _save_users(users)
    log.info("User allowlist set: %s (all_access=%s)", name, allow is None)
    return True, None


# ============================================================================
# Authentication + sessions
# ============================================================================


def authenticate(name, password):
    """Verify username + password against a stored user. Returns the display
    name on success, else None. Generic failure (no enumeration signal) — the
    caller returns the same error whether the name or the password is wrong."""
    if not isinstance(name, str) or not isinstance(password, str):
        return None
    rec = _load_users().get(_key(name))
    if not rec:
        return None
    if _verify_pw(password, rec.get("pw", "")):
        return rec.get("name", name)
    return None


def create_session(name):
    """Mint a random session token for a user, persist it (hashed), return the
    plaintext token (shown once, delivered via cookie + login response)."""
    token = secrets.token_urlsafe(_SESSION_TOKEN_BYTES)
    with _lock:
        sessions = _load_sessions()
        sessions[_token_hash(token)] = {"user": _key(name), "created": int(time.time())}
        _save_sessions(sessions)
    return token


def resolve_session(token):
    """Return the display name for a valid session token, or None. Fails closed:
    an unknown token, or a token whose user was deleted, resolves to None (→
    anonymous view, never another user's access)."""
    if not token:
        return None
    sessions = _load_sessions()
    ent = sessions.get(_token_hash(token))
    if not ent:
        return None
    rec = _load_users().get(ent.get("user"))
    if not rec:
        return None
    return rec.get("name", ent.get("user"))


def drop_session(token):
    if not token:
        return
    with _lock:
        sessions = _load_sessions()
        if sessions.pop(_token_hash(token), None) is not None:
            _save_sessions(sessions)


def _drop_user_sessions_locked(key):
    """Remove every session for a casefold user key. Caller holds _lock."""
    sessions = _load_sessions()
    victims = [h for h, e in sessions.items() if e.get("user") == key]
    if victims:
        for h in victims:
            del sessions[h]
        _save_sessions(sessions)


# ============================================================================
# Request resolution — the identity + allowlist entry points used by http.py
# ============================================================================


def _cookie_token(handler):
    """Extract the zimi_session token from the request Cookie header, or ''."""
    raw = handler.headers.get("Cookie", "") if getattr(handler, "headers", None) else ""
    if not raw:
        return ""
    for part in raw.split(";"):
        k, _, v = part.strip().partition("=")
        if k == "zimi_session":
            return v.strip()
    return ""


def _bearer_token(handler):
    auth = (
        handler.headers.get("Authorization", "")
        if getattr(handler, "headers", None)
        else ""
    )
    if auth.startswith("Bearer "):
        return auth[7:]
    return ""


def resolve_request_user(handler):
    """Resolve the logged-in USER for a request, or None (admin/anonymous).

    Checks the Bearer token first (API/XHR), then the session cookie (iframe /w/).
    Only USER session tokens resolve here — the admin password is not a session
    token, so admin requests return None and get the unrestricted view.
    """
    name = resolve_session(_bearer_token(handler))
    if name:
        return name
    return resolve_session(_cookie_token(handler))


def request_allow(handler):
    """The request's ZIM allow set, or None for all-access.

    None  → admin / anonymous / all-access user → sees everything.
    set() → a logged-in user with an explicit allowlist → restricted.
    """
    name = resolve_request_user(handler)
    if not name:
        return None
    rec = get_user(name)
    if not rec:
        return None
    allowlist = rec.get("allowlist")
    if isinstance(allowlist, list):
        return set(allowlist)
    return None
