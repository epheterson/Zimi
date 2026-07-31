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

Roles: every account carries a ``role`` ∈ {``admin``, ``user``,
``limited``}:
- ``admin``   — a SECONDARY admin. All-access read PLUS full manage powers via
  their own login (see ``manage.admin_kind`` — they authenticate to a session
  token that ``manage._check_manage_auth`` accepts). They can CRUD regular users
  but cannot touch the PRIMARY admin (the password-file account) or manage other
  admins — only the primary can. The primary admin is NOT stored here.
- ``user``    — full library, no manage. All-access read, session token never
  reaches ``/manage/*``.
- ``limited`` — an explicit allowlist restricts the read surface.
The role determines the allowlist shape: ``admin``/``user`` are all-access
(allowlist ``None``); ``limited`` carries a list. Legacy records without a role
are migrated in-memory on load: an allowlist present → ``limited``, else ``user``.
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

#: Account roles. ``admin`` = secondary admin (all-access + manage), ``user`` =
#: full library no manage, ``limited`` = explicit allowlist. See module docstring.
_ROLES = ("admin", "user", "limited")
_DEFAULT_ROLE = "user"

#: Reserved names that can't be a user (admin is the password account; the others
#: avoid confusing UI labels). Compared case-insensitively.
_RESERVED_NAMES = {"admin", "administrator", "root", "anonymous", "anon"}

#: Usernames: 1-32 chars, letters/digits/space/._- (kept permissive for kids'
#: names + school labels, but no control chars, slashes, or newlines).
_NAME_RE = re.compile(r"^[\w .\-]{1,32}$", re.UNICODE)

_SESSION_TOKEN_BYTES = 32  # secrets.token_urlsafe(32) → ~43 url-safe chars

#: sessions.json stores USER sessions keyed by casefold username. The PRIMARY
#: admin is the password account, not a users.json record, so its session rides
#: under a sentinel key that no real username can produce (names are
#: ``[\w .\-]{1,32}`` — a NUL byte is unrepresentable). This lets the admin reuse
#: the exact session machinery named users use (random token, hashed at rest, TTL
#: expiry, logout drop) so header-less transports — the /w/ reader iframe and the
#: plain-fetch data endpoints — can carry admin identity via the zimi_session
#: cookie. Recognised by ``manage._primary_admin_authorized``; never resolves as a
#: named user (see ``resolve_session``).
_ADMIN_SESSION_USER = "\x00admin"

#: Server-side session lifetime. The cookie carries a matching Max-Age, but that
#: is a hint the holder controls — this is the half that actually expires a
#: stolen token, and it bounds sessions.json instead of letting it grow one
#: entry per login forever.
SESSION_TTL_S = 30 * 24 * 3600

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
        if not isinstance(users, dict):
            return {}
        # Migrate legacy records (no role) in-memory: allowlist present →
        # limited, else user. Persisted the next time the record is written.
        for rec in users.values():
            if isinstance(rec, dict):
                rec["role"] = _effective_role(rec)
        return users
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _effective_role(rec):
    """The stored role, or the migrated default for a legacy record."""
    role = rec.get("role")
    if role in _ROLES:
        return role
    return "limited" if isinstance(rec.get("allowlist"), list) else _DEFAULT_ROLE


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


def _resolve_role_allowlist(role, allowlist):
    """Reconcile a role with an allowlist. Returns (role, allowlist, error).

    ``admin``/``user`` are always all-access (allowlist forced to ``None``);
    ``limited`` always carries a list (``None`` → ``[]``). A ``None`` role is
    inferred from the allowlist for backward-compatible callers.
    """
    if role is None:
        role = "limited" if isinstance(allowlist, list) else _DEFAULT_ROLE
    if role not in _ROLES:
        return None, None, "invalid role"
    if role == "limited":
        allow, err = _clean_allowlist(allowlist if allowlist is not None else [])
        if err:
            return None, None, err
        return role, allow, None
    return role, None, None  # admin / user → all-access


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
                "role": _effective_role(rec),
                "all_access": allowlist is None,
                "allowlist": allowlist if isinstance(allowlist, list) else [],
                "flags": rec.get("flags", {}) or {},
                "created": rec.get("created", 0),
                "last_login": rec.get("last_login", 0),
            }
        )
    out.sort(key=lambda u: u["name"].casefold())
    return out


def create_user(name, password, allowlist=None, role=None):
    """Create a user. Returns (ok: bool, error: str|None).

    ``role`` ∈ {``admin``, ``user``, ``limited``}; ``None`` infers it from the
    allowlist (backward-compatible). ``admin``/``user`` ignore the allowlist
    (all-access); ``limited`` uses it (``None`` → empty).
    """
    if not _valid_name(name):
        return False, "invalid name"
    if not isinstance(password, str) or len(password) < 1:
        return False, "password required"
    role, allow, err = _resolve_role_allowlist(role, allowlist)
    if err:
        return False, err
    with _lock:
        users = _load_users()
        if _key(name) in users:
            return False, "user already exists"
        users[_key(name)] = {
            "name": name.strip(),
            "role": role,
            "pw": _hash_pw(password),
            "allowlist": allow,
            "flags": {},  # v2 seam — kid mode / history monitoring / forced login
            "created": int(time.time()),
        }
        _save_users(users)
    log.info(
        "User created: %s (role=%s, all_access=%s)", name.strip(), role, allow is None
    )
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
    delete_user_data(name)  # their server-side bookmarks/history go with them
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
    """Set a user's allowlist and sync the role: a list → ``limited``, ``None``
    → ``user`` (all-access). Admins are all-access and reject allowlist edits."""
    allow, err = _clean_allowlist(allowlist)
    if err:
        return False, err
    with _lock:
        users = _load_users()
        rec = users.get(_key(name))
        if not rec:
            return False, "user not found"
        if _effective_role(rec) == "admin":
            return False, "admins are all-access"
        rec["allowlist"] = allow
        rec["role"] = "limited" if isinstance(allow, list) else "user"
        _save_users(users)
    log.info("User allowlist set: %s (all_access=%s)", name, allow is None)
    return True, None


def set_role(name, role, allowlist=None):
    """Change a user's role. ``admin``/``user`` become all-access; ``limited``
    keeps the given allowlist (or the existing one). Drops live sessions so the
    new scope takes effect on the next login. Returns (ok, error)."""
    with _lock:
        users = _load_users()
        rec = users.get(_key(name))
        if not rec:
            return False, "user not found"
        if role == "limited" and allowlist is None:
            allowlist = rec.get("allowlist") or []
        role, allow, err = _resolve_role_allowlist(role, allowlist)
        if err:
            return False, err
        rec["role"] = role
        rec["allowlist"] = allow
        _save_users(users)
        _drop_user_sessions_locked(_key(name))
    log.info("User role set: %s → %s", name, role)
    return True, None


def is_admin_user(name):
    """True if ``name`` is a stored SECONDARY-admin account (role=admin)."""
    rec = _load_users().get(_key(name))
    return bool(rec) and _effective_role(rec) == "admin"


# ============================================================================
# Per-user data — bookmarks / history / preferences stored SERVER-SIDE per user
# ============================================================================
#
# The tasteful bridge to the 1.9 full users-v2 migration: when a NAMED user is
# signed in, their "My data" (the browser-half a device otherwise keeps only in
# localStorage) round-trips through the server so it follows them across devices.
# One opaque JSON doc per user under ZIMI_DATA_DIR/userdata/<casefold-key>.json,
# atomic writes, deleted with the account. Anonymous / admin-without-a-named-user
# never reach here — their bookmarks stay in the browser (see http.py's gate).

_USERDATA_VERSION = 1
#: Hard ceiling per blob so one account can't fill the disk (server-side twin of
#: the client cap). Comfortably above a heavy bookmarks+history set.
_USERDATA_MAX_BYTES = 4 * 1024 * 1024


def _userdata_dir():
    return os.path.join(_srv.ZIMI_DATA_DIR, "userdata")


def _safe_userdata_key(name):
    """Casefold key for a user's data file, or None if it can't be a safe
    filename. Names are validated on creation, but this is the last gate before
    a path join, so it stays strict: no separators, no dot-only names."""
    key = _key(name)
    if (
        not key
        or key in (".", "..")
        or os.sep in key
        or (os.altsep and os.altsep in key)
    ):
        return None
    return key


def _userdata_path(name):
    return os.path.join(_userdata_dir(), _safe_userdata_key(name) + ".json")


def _empty_user_data():
    return {
        "version": _USERDATA_VERSION,
        "bookmarks": [],
        "folders": [],
        "history": [],
        "preferences": {},
    }


def load_user_data(name):
    """Return a user's stored data blob, or a fresh-empty one when none exists.
    Caller has already authorized the requester for ``name``."""
    if _safe_userdata_key(name) is None:
        return _empty_user_data()
    try:
        import json

        with open(_userdata_path(name), encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (FileNotFoundError, ValueError, OSError):
        pass
    return _empty_user_data()


def save_user_data(name, blob):
    """Persist a user's data blob (bookmarks/history/preferences). Returns
    (ok, error). Caller has already authorized the requester for ``name``."""
    import json

    if _safe_userdata_key(name) is None:
        return False, "invalid user"
    if not isinstance(blob, dict):
        return False, "invalid data"
    bookmarks = blob.get("bookmarks")
    folders = blob.get("folders")
    history = blob.get("history")
    prefs = blob.get("preferences")
    doc = {
        "version": _USERDATA_VERSION,
        "bookmarks": bookmarks if isinstance(bookmarks, list) else [],
        "folders": folders if isinstance(folders, list) else [],
        "history": history if isinstance(history, list) else [],
        "preferences": prefs if isinstance(prefs, dict) else {},
        "updated": int(time.time()),
    }
    if len(json.dumps(doc)) > _USERDATA_MAX_BYTES:
        return False, "data too large"
    with _lock:
        os.makedirs(_userdata_dir(), exist_ok=True)
        _srv._atomic_write_json(_userdata_path(name), doc, indent=2)
    return True, None


def delete_user_data(name):
    """Remove a user's stored data file (best-effort; a missing file is fine)."""
    if _safe_userdata_key(name) is None:
        return
    try:
        os.remove(_userdata_path(name))
    except FileNotFoundError:
        pass
    except OSError as e:
        log.warning("Could not delete user data for %s: %s", name, e)


def all_user_data():
    """Every per-user blob, keyed by casefold name — for the full-server backup.
    Keys are the on-disk filenames (already casefold), so restore round-trips."""
    import json

    out = {}
    d = _userdata_dir()
    if not os.path.isdir(d):
        return out
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for fn in names:
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, fn), encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                out[fn[: -len(".json")]] = data
        except (ValueError, OSError):
            pass
    return out


def restore_user_data(blobs, overwrite=False):
    """Restore per-user blobs from a full-server backup. ``blobs`` is keyed by
    casefold name (as ``all_user_data`` emits). ``overwrite`` clears every
    existing blob first; otherwise incoming wins per user, others untouched.
    Returns the number of user blobs written."""
    if not isinstance(blobs, dict):
        return 0
    if overwrite:
        for key in list(all_user_data().keys()):
            delete_user_data(key)
    written = 0
    for key, blob in blobs.items():
        ok, _ = save_user_data(key, blob)  # key is already casefold; _key is idempotent
        if ok:
            written += 1
    return written


# ============================================================================
# Public-access policy — what an ANONYMOUS (not logged-in) visitor may see
# ============================================================================
#
# Three modes, stored in ``access.json`` under ZIMI_DATA_DIR (kept out of
# users.json so the user schema stays stable and the policy can be swapped
# atomically on its own):
#
#   {"version": 1, "mode": "open"|"limited"|"private", "allowlist": [...]}
#
# - ``open``    — default, legacy behaviour: anonymous sees the whole library
#                 (``request_allow`` → None, the all-access sentinel).
# - ``limited`` — anonymous is filtered to ``allowlist`` using the EXACT same
#                 choke points as a limited USER (``current_allow`` thread-local
#                 → get_zim_files/list_zims/zim_allowed/search-cache key). No new
#                 filtering path, so no new leak surface.
# - ``private`` — anonymous gets nothing but the login screen; every read
#                 endpoint requires a session (enforced by the request gate in
#                 http.py). ``request_allow`` returns an EMPTY set as defence in
#                 depth so a gate bypass still yields an empty library.
#
# Env override ``ZIMI_PUBLIC_ACCESS`` (open|limited|private) wins over the file
# for docker/compose deployments. When it selects ``limited`` the allowlist
# still comes from access.json (env can't carry a list); an unconfigured
# allowlist there → empty set → anonymous sees nothing, which is safe.
#
# FAIL CLOSED: a file that is PRESENT but corrupt/unreadable, with no env
# override, resolves to ``private`` — never silently back to ``open`` (that
# would dump the whole library to the internet on a hand-edited or truncated
# config). A MISSING file is the legacy default → ``open`` (installs that never
# configured a policy must not suddenly lock out).

_ACCESS_VERSION = 1
_ACCESS_MODES = ("open", "limited", "private")
_DEFAULT_ACCESS_MODE = "open"


def _access_path():
    return os.path.join(_srv.ZIMI_DATA_DIR, "access.json")


def _env_access_mode():
    """The ZIMI_PUBLIC_ACCESS override, or None if unset/invalid."""
    raw = (os.environ.get("ZIMI_PUBLIC_ACCESS") or "").strip().lower()
    return raw if raw in _ACCESS_MODES else None


def _load_access():
    """Return ``(mode, allowlist, ok)``.

    ``ok`` is False ONLY when the file exists but could not be read/parsed as a
    valid policy — the fail-closed signal. A missing file is the legacy default
    (``open``, ok=True), NOT an error.
    """
    path = _access_path()
    if not os.path.exists(path):
        return _DEFAULT_ACCESS_MODE, [], True
    try:
        import json

        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return _DEFAULT_ACCESS_MODE, [], False
        mode = data.get("mode")
        if mode not in _ACCESS_MODES:
            return _DEFAULT_ACCESS_MODE, [], False
        raw = data.get("allowlist")
        allow = [a for a in raw if isinstance(a, str)] if isinstance(raw, list) else []
        return mode, allow, True
    except (ValueError, OSError):
        return _DEFAULT_ACCESS_MODE, [], False


def get_public_access():
    """The effective anonymous policy as ``(mode, allowlist)``.

    Env override wins over the file. With no override, an unreadable-but-present
    config fails closed to ``private``. See the section header for the full
    contract.
    """
    mode, allow, ok = _load_access()
    env = _env_access_mode()
    if env is not None:
        mode = env
    elif not ok:
        mode = "private"  # fail closed
    return mode, allow


def set_public_access(mode, allowlist=None):
    """Persist the anonymous-access policy. Returns (ok, error).

    ``limited`` stores the cleaned allowlist; ``open``/``private`` ignore it
    (stored empty). The env override, if set, still wins at read time — callers
    should surface that to the admin, but we still persist so a later env
    removal restores intent.
    """
    if mode not in _ACCESS_MODES:
        return False, "invalid mode"
    allow, err = _clean_allowlist(allowlist if allowlist is not None else [])
    if err:
        return False, err
    stored = allow if mode == "limited" else []
    with _lock:
        _srv._atomic_write_json(
            _access_path(),
            {"version": _ACCESS_VERSION, "mode": mode, "allowlist": stored},
            indent=2,
        )
    log.info("Public access set: mode=%s (allowlist=%d)", mode, len(stored))
    return True, None


def public_access_status():
    """Admin-facing view of the policy: the effective mode/allowlist plus
    whether the env override is forcing it (so the UI can show a read-only
    banner). The stored file mode is surfaced separately from the effective
    mode so the admin sees what they saved even when env overrides it."""
    file_mode, file_allow, _ = _load_access()
    env = _env_access_mode()
    eff_mode, eff_allow = get_public_access()
    return {
        "mode": eff_mode,
        "allowlist": eff_allow,
        "stored_mode": file_mode,
        "stored_allowlist": file_allow,
        "env_controlled": env is not None,
        "env_mode": env,
    }


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


def record_login(name):
    """Stamp the account's ``last_login`` (unix seconds) after a successful
    authentication. Best-effort and additive: a legacy record simply gains the
    field on its first login. A vanished record (deleted mid-request) is a no-op
    — login must never fail because this bookkeeping write lost a race."""
    with _lock:
        users = _load_users()
        rec = users.get(_key(name))
        if not rec:
            return
        rec["last_login"] = int(time.time())
        _save_users(users)


def _session_expired(ent, now=None):
    """True once a session entry is past SESSION_TTL_S. An entry with a missing
    or unparseable ``created`` is treated as expired — fail closed rather than
    grant an immortal token to a hand-edited or corrupt sessions.json."""
    try:
        created = int(ent.get("created", 0))
    except (TypeError, ValueError):
        return True
    if created <= 0:
        return True
    return (now if now is not None else int(time.time())) - created > SESSION_TTL_S


def _mint_session(user_key):
    """Mint a random session token for a stored user key, persist it (hashed),
    return the plaintext token. Shared by named-user and admin sessions."""
    token = secrets.token_urlsafe(_SESSION_TOKEN_BYTES)
    now = int(time.time())
    with _lock:
        sessions = _load_sessions()
        # Login is the natural sweep point — no timer thread, and the file can
        # only grow by one entry between two sweeps of the same account.
        for h in [h for h, e in sessions.items() if _session_expired(e, now)]:
            del sessions[h]
        sessions[_token_hash(token)] = {"user": user_key, "created": now}
        _save_sessions(sessions)
    return token


def create_session(name):
    """Mint a random session token for a user, persist it (hashed), return the
    plaintext token (shown once, delivered via cookie + login response)."""
    return _mint_session(_key(name))


def create_admin_session():
    """Mint a session token for the PRIMARY admin (the password account) so
    header-less transports carry admin identity via the zimi_session cookie: the
    /w/ reader iframe (a browser navigation that cannot send an Authorization
    header) and the plain-fetch data endpoints (/list, /search, …). Stored and
    expired exactly like a user session; recognised by
    ``manage._primary_admin_authorized`` via ``is_admin_session``."""
    return _mint_session(_ADMIN_SESSION_USER)


def is_admin_session(token):
    """True if the token is a live PRIMARY-admin session (see
    ``create_admin_session``). Fails closed: empty / unknown / expired → False.
    As unforgeable as the password Bearer — a random token, hashed at rest."""
    if not token:
        return False
    ent = _load_sessions().get(_token_hash(token))
    return (
        bool(ent)
        and not _session_expired(ent)
        and ent.get("user") == _ADMIN_SESSION_USER
    )


def resolve_session(token):
    """Return the display name for a valid session token, or None. Fails closed:
    an unknown token, or a token whose user was deleted, resolves to None (→
    anonymous view, never another user's access)."""
    if not token:
        return None
    sessions = _load_sessions()
    ent = sessions.get(_token_hash(token))
    if not ent or _session_expired(ent):
        return None
    # An admin session is not a named user — never let it resolve as one (it
    # would fail the users.json lookup anyway; this is defence in depth).
    if ent.get("user") == _ADMIN_SESSION_USER:
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


def drop_admin_sessions():
    """Invalidate every primary-admin session (see ``create_admin_session``).
    Called when the manage password changes or clears so an old admin cookie
    can't outlive a password rotation — matching the pre-cookie model where the
    admin's Bearer WAS the password and changing it locked out the old one
    immediately."""
    with _lock:
        _drop_user_sessions_locked(_ADMIN_SESSION_USER)


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


def _request_is_admin(handler):
    """True if the request is an authorized admin (primary or secondary) — the
    account that always sees the whole library regardless of the public-access
    policy. Fails CLOSED: any error resolving admin status → False (treat as a
    non-admin, i.e. restricted), never accidentally all-access."""
    try:
        from zimi import manage as _manage

        return _manage._check_manage_auth(handler) is None
    except Exception:
        return False


def request_allow(handler):
    """The request's ZIM allow set, or None for all-access.

    Resolution order:
    - A logged-in USER → their own allowlist (set) or None (all-access user).
    - Otherwise (anonymous OR admin) the public-access policy applies:
        * ``open``    → None (all-access) — the common default; no admin probe.
        * ``limited`` → admin gets None, anonymous gets set(public allowlist).
        * ``private`` → admin gets None, anonymous gets an EMPTY set (defence in
                        depth; the http.py request gate 401s them before any
                        read handler runs).
    """
    name = resolve_request_user(handler)
    if name:
        rec = get_user(name)
        if not rec:
            return None
        allowlist = rec.get("allowlist")
        return set(allowlist) if isinstance(allowlist, list) else None

    mode, allow = get_public_access()
    if mode == "open":
        return None  # fast path — no admin probe for the default deployment
    if _request_is_admin(handler):
        return None
    if mode == "limited":
        return set(allow)
    return set()  # private → empty library; gate returns 401 first
