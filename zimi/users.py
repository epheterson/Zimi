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
import json
import logging
import math
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
                # How the account authenticates. Absent on every 1.8 record, so
                # a local password account keeps reporting "local" untouched.
                "auth": rec.get("auth") or "local",
                "all_access": allowlist is None,
                "allowlist": allowlist if isinstance(allowlist, list) else [],
                "can_create": _rec_can_create(rec),
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
# Create permission — a non-admin account that may make ZIMs from the web
# ============================================================================
#
# ``can_create`` is an ADDITIVE per-user key: absent on every pre-1.9 record
# (absent → False), written only when granted, removed again when revoked — so
# users.json stays at schema version 1 and a roster that never uses the feature
# is byte-for-byte identical to what 1.8 wrote. (Bumping the version would make
# ``_load_users`` blank the roster on older code; see the federated-accounts
# note below for why that rule is absolute.)
#
# Admins (any role=admin record) create implicitly — the flag exists so a plain
# or limited account can capture the web WITHOUT any manage powers. The scope
# is deliberately narrower than admin creation: manage.py grants such an
# account only the URL modes; folder/import (server-path reads) and the folder
# browser stay primary-admin-only.


def _rec_can_create(rec):
    """Whether a stored record may create ZIMs: admins implicitly, everyone
    else by the additive ``can_create`` flag."""
    if not isinstance(rec, dict):
        return False
    if _effective_role(rec) == "admin":
        return True
    return rec.get("can_create") is True


def user_can_create(name):
    """True if the named account may create ZIMs (see ``_rec_can_create``)."""
    return _rec_can_create(_load_users().get(_key(name)))


def set_can_create(name, value):
    """Grant or revoke the create permission. Returns (ok, error).

    Revoking REMOVES the key (never writes ``false``) so an ungranted record
    stays byte-identical to a 1.8 one. Admin-role accounts are refused: they
    create implicitly, and a stored flag on them would silently spring back to
    life on a later role change nobody intended to carry it through.
    """
    with _lock:
        users = _load_users()
        rec = users.get(_key(name))
        if not rec:
            return False, "user not found"
        if _effective_role(rec) == "admin":
            return False, "admins can always create"
        if value:
            rec["can_create"] = True
        else:
            rec.pop("can_create", None)
        _save_users(users)
    log.info("User can_create set: %s -> %s", name, bool(value))
    return True, None


# ============================================================================
# Federated accounts — created by an external identity provider (see sso.py)
# ============================================================================
#
# A federated record is an ordinary user record with two additions and one
# subtraction: ``auth`` names the mechanism, ``flags.sso`` carries the identity
# it belongs to, and ``pw`` is None — there is no password to verify because the
# proxy already authenticated the person. Everything downstream (allowlists,
# roles, sessions, per-user data, the manage hierarchy) treats it as the plain
# user record it is.
#
# Both fields are additive, so users.json stays at version 1 and a 1.8 record is
# byte-for-byte unchanged. That matters more than it looks: ``_load_users``
# returns {} on a version mismatch, so bumping the version would empty every
# existing install's user list.

_FEDERATED_FLAG = "sso"


def federated_identity(rec):
    """The stored identity of a federated record, or None for a local account."""
    if not isinstance(rec, dict):
        return None
    flags = rec.get("flags")
    ident = flags.get(_FEDERATED_FLAG) if isinstance(flags, dict) else None
    return ident if isinstance(ident, dict) else None


def _same_identity(stored, identity):
    """True when a stored identity and an incoming one are the same person.

    Same issuer, then either the same email (the value the account name was
    derived from) or the same subject (so a person who changes their email at
    the IdP keeps their account instead of colliding with it).
    """
    if not stored or stored.get("iss") != identity.get("iss"):
        return False
    stored_email = (stored.get("email") or "").casefold()
    email = (identity.get("email") or "").casefold()
    if stored_email and stored_email == email:
        return True
    sub = identity.get("sub") or ""
    return bool(sub) and stored.get("sub") == sub


def find_federated_user(identity):
    """The display name of the account owning ``identity``, or None.

    Looked up by identity rather than by name so an account's name is fixed at
    creation: a rename at the IdP can never move an existing account, and a
    local account can never be adopted by a claim that matches its name.
    """
    for rec in _load_users().values():
        if isinstance(rec, dict) and _same_identity(federated_identity(rec), identity):
            return rec.get("name")
    return None


def create_federated_user(name, role, identity):
    """Create a password-less account owned by ``identity``. Returns (ok, error)."""
    if not _valid_name(name):
        return False, "invalid name"
    if not isinstance(identity, dict) or not identity.get("email"):
        return False, "invalid identity"
    role, allow, err = _resolve_role_allowlist(role, None)
    if err:
        return False, err
    with _lock:
        users = _load_users()
        if _key(name) in users:
            return False, "user already exists"
        users[_key(name)] = {
            "name": name.strip(),
            "role": role,
            "pw": None,  # federated: authenticate() refuses this record outright
            "allowlist": allow,
            "auth": _FEDERATED_FLAG,
            "flags": {_FEDERATED_FLAG: dict(identity)},
            "created": int(time.time()),
            "last_login": int(time.time()),
        }
        _save_users(users)
    log.info("Federated user created: %s (role=%s)", name.strip(), role)
    return True, None


#: How coarse a federated account's ``last_login`` is allowed to be. Bounds the
#: write rate for an identity that arrives on every single request.
_LOGIN_STAMP_S = 300


def touch_federated_user(name, identity):
    """Refresh a federated record's stored identity and login stamp.

    Best-effort and rate-limited to one write per login stamp granularity: this
    runs on every request that carries a proxy identity, and a users.json write
    per request would be absurd.
    """
    with _lock:
        users = _load_users()
        rec = users.get(_key(name))
        if not rec:
            return
        stored = federated_identity(rec) or {}
        now = int(time.time())
        try:
            last = int(rec.get("last_login") or 0)
        except (TypeError, ValueError):
            last = 0  # hand-edited record: re-stamp it rather than fail the login
        changed = {k: v for k, v in identity.items() if stored.get(k) != v}
        if not changed and now - last < _LOGIN_STAMP_S:
            return
        flags = rec.get("flags")
        if not isinstance(flags, dict):
            flags = {}
            rec["flags"] = flags
        flags[_FEDERATED_FLAG] = dict(stored, **identity)
        rec["auth"] = _FEDERATED_FLAG
        rec["last_login"] = now
        _save_users(users)


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

#: 2 (1.12): the blob carries ``saved``, the one store for everything kept
#: (items, lists, memberships, positions, highlights and their tombstones), merged on every
#: write rather than replaced. bookmarks/folders stay readable for one release.
_USERDATA_VERSION = 2
#: Hard ceiling per blob, apart from the saved store (which has its own,
#: _SAVED_MAX_BYTES), so one account can't fill the disk. Comfortably above a
#: heavy bookmarks+history set. Measured as the file is written: UTF-8, compact.
_USERDATA_MAX_BYTES = 4 * 1024 * 1024

# ── Saved: the account's copy of the store (app.js's Saved is the twin) ──
# Every record carries ts (ms); the newer copy of a record wins, a tie keeps
# the kept one. A deletion leaves a tombstone in ``gone`` (i:item, l:list,
# m:membership, p:position, h:highlight) that removes any copy as old or older, so a delete
# on one device survives the next sync from another. Tombstones are forgotten
# after _SAVED_GONE_MS. Nothing from the client is trusted: every record is
# rebuilt from the fields it may have, and an item's key must be the one its
# own zim and path (and a place's position) make. What a person saved (items,
# lists, memberships, highlights) is never dropped to make room: the store has
# a byte budget, past it the oldest tombstones go, then the oldest places, and
# a store still over it is refused whole (the device says sync is paused).
_SAVED_LIKED = "liked"
#: The store's shape. 1: 1.12.0, where a like saved the thing too
#: (_saved_likes_from_v1). A thing liked and not saved is an item marked
#: likeOnly, in Liked and in nothing else. Whether an item is saved has its
#: own time, sv (_saved_sv_of), apart from ts (its fields): a like alone makes
#: no claim on it (sv 0), so a like never clears a save and an unsave never
#: clears a like.
_SAVED_VERSION = 2
_SAVED_KINDS = ("article", "book", "video", "question", "post", "place", "word")
_SAVED_APPS = ("books", "tube", "exchange", "reddot", "maps", "wiki", "dictionary")
_SAVED_COLLS = (
    ("items", "i:"),
    ("lists", "l:"),
    ("members", "m:"),
    ("positions", "p:"),
    ("highlights", "h:"),
)
#: The store as the file holds it (UTF-8 JSON, compact), at most. app.js's
#: Saved holds the same budget and trims the same way.
_SAVED_MAX_BYTES = 3 * 1024 * 1024
#: Where you were: the latest this many places per app (Zimipedia's articles
#: never push Bookshelf's books out of Continue).
_SAVED_POS_PER_APP = 300
#: Tombstones kept at most, the newest.
_SAVED_GONE_MAX = 10000
_SAVED_GONE_MS = 90 * 86400 * 1000
#: A time from a device this far past the server's clock is taken as the
#: server's clock plus this: a fast clock never outranks every later edit.
_SAVED_FUTURE_MS = 5 * 60 * 1000
_SAVED_TITLE_MAX = 500
_SAVED_NAME_MAX = 120
_SAVED_ZIM_MAX = 200
_SAVED_PATH_MAX = 2000
_SAVED_SMALL_KEYS = 16
_SAVED_SMALL_KEY_MAX = 32
_SAVED_SMALL_VAL_MAX = 1000
_SAVED_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_SAVED_GONE_RE = re.compile(r"^[ilmph]:.", re.S)
# A highlight's colours (the first the default), its quote, context and note.
_SAVED_HL_COLORS = ("yellow", "green", "blue", "pink")
_SAVED_HL_QUOTE_MAX = 600
_SAVED_HL_CONTEXT_MAX = 64
_SAVED_HL_NOTE_MAX = 2000
_SAVED_HL_PAGE_MAX = 1_000_000


def _saved_empty():
    return {
        "v": _SAVED_VERSION,
        "items": {},
        "lists": {},
        "members": {},
        "positions": {},
        "highlights": {},
        "gone": {},
        "legacy": False,
    }


def _saved_num(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v if math.isfinite(v) else None


def _saved_round(v):
    """Math.round, as the client rounds (half up, not half to even)."""
    return int(math.floor(v + 0.5))


def _saved_key(rec):
    zim, path = rec.get("zim"), rec.get("path")
    if not zim or not path:
        return ""
    k = zim + "\n" + path
    where = rec.get("where")
    pos = (
        where.get("pos")
        if rec.get("kind") == "place" and isinstance(where, dict)
        else None
    )
    return k + "\n" + pos if isinstance(pos, str) and pos else k


def _saved_small(o):
    """A few short scalar fields (a where, an app's meta), or None."""
    if not isinstance(o, dict):
        return None
    out = {}
    for f, v in o.items():
        if (
            len(out) >= _SAVED_SMALL_KEYS
            or not isinstance(f, str)
            or not f
            or len(f) > _SAVED_SMALL_KEY_MAX
        ):
            continue
        if isinstance(v, str):
            v = v[:_SAVED_SMALL_VAL_MAX]
        elif not isinstance(v, bool) and _saved_num(v) is None:
            continue
        out[f] = v
    return out or None


def _saved_thing(r, id_):
    """An item or a position, rebuilt from what it may carry; None if it is
    not one or its key is not its own."""
    if not isinstance(r, dict):
        return None
    zim, path, ts = r.get("zim"), r.get("path"), _saved_num(r.get("ts"))
    if not isinstance(zim, str) or not zim or len(zim) > _SAVED_ZIM_MAX:
        return None
    if (
        not isinstance(path, str)
        or not path
        or len(path) > _SAVED_PATH_MAX
        or ts is None
    ):
        return None
    title = r.get("title")
    out = {
        "kind": r.get("kind") if r.get("kind") in _SAVED_KINDS else "article",
        "zim": zim,
        "path": path,
        "title": title[:_SAVED_TITLE_MAX] if isinstance(title, str) else "",
        "ts": _saved_round(ts),
    }
    orig = r.get("origTitle")
    if isinstance(orig, str) and orig:
        out["origTitle"] = orig[:_SAVED_TITLE_MAX]
    if r.get("app") in _SAVED_APPS:
        out["app"] = r["app"]
    where, meta = _saved_small(r.get("where")), _saved_small(r.get("meta"))
    if where:
        out["where"] = where
    if meta:
        out["meta"] = meta
    return out if _saved_key(out) == id_ else None


def _saved_highlight(r, id_):
    """A highlight rebuilt from what it may carry (the page, the quote and
    its context, where it starts, its colour and note); None if it is not
    one."""
    if (
        not isinstance(r, dict)
        or not isinstance(id_, str)
        or not _SAVED_ID_RE.match(id_)
    ):
        return None
    ts, pos, n, added, pg = (
        _saved_num(r.get(f)) for f in ("ts", "pos", "n", "added", "pg")
    )
    zim, path, exact = r.get("zim"), r.get("path"), r.get("exact")
    if not isinstance(zim, str) or not zim or len(zim) > _SAVED_ZIM_MAX:
        return None
    if (
        not isinstance(path, str)
        or not path
        or len(path) > _SAVED_PATH_MAX
        or ts is None
    ):
        return None
    if not isinstance(exact, str) or not exact:
        return None

    def text(f, most):
        v = r.get(f)
        return v[:most] if isinstance(v, str) else ""

    out = {
        "zim": zim,
        "path": path,
        "kind": r.get("kind") if r.get("kind") in _SAVED_KINDS else "article",
        "title": text("title", _SAVED_TITLE_MAX),
        "exact": exact[:_SAVED_HL_QUOTE_MAX],
        "prefix": text("prefix", _SAVED_HL_CONTEXT_MAX),
        "suffix": text("suffix", _SAVED_HL_CONTEXT_MAX),
        "pos": 0 if pos is None else max(0, min(1, pos)),
        "color": (
            r.get("color")
            if r.get("color") in _SAVED_HL_COLORS
            else _SAVED_HL_COLORS[0]
        ),
        "added": _saved_round(ts if added is None else added),
        "ts": _saved_round(ts),
    }
    if r.get("app") in _SAVED_APPS:
        out["app"] = r["app"]
    end = r.get("end")
    if isinstance(end, str) and end and n is not None and n > 0:
        out["end"] = end[:_SAVED_HL_QUOTE_MAX]
        out["n"] = _saved_round(n)
    note = r.get("note")
    if isinstance(note, str) and note:
        out["note"] = note[:_SAVED_HL_NOTE_MAX]
    # In a PDF, the page of the document the highlight is on.
    if pg is not None and 1 <= pg <= _SAVED_HL_PAGE_MAX:
        out["pg"] = int(pg)
    return out


def _saved_order(r):
    if not isinstance(r, dict):
        return None
    o, ts = _saved_num(r.get("order")), _saved_num(r.get("ts"))
    return None if o is None or ts is None else {"order": o, "ts": _saved_round(ts)}


def _clean_saved(x):
    """The store as a client may send it, keeping only well-formed records."""
    s = _saved_empty()
    if not isinstance(x, dict):
        return s

    def each(src):
        return list(src.items()) if isinstance(src, dict) else []

    for id_, r in each(x.get("items")):
        it = _saved_thing(r, id_) if isinstance(id_, str) else None
        if it:
            added = _saved_num(r.get("added"))
            it["added"] = _saved_round(it["ts"] if added is None else added)
            if r.get("likeOnly") is True:
                it["likeOnly"] = True
            sv = _saved_num(r.get("sv"))
            s["items"][id_] = _saved_set_sv(
                it, _saved_sv_of(it) if sv is None else max(0, _saved_round(sv))
            )
    for id_, r in each(x.get("lists")):
        o = _saved_order(r)
        name = r.get("name") if isinstance(r, dict) else None
        if (
            not o
            or not isinstance(id_, str)
            or not _SAVED_ID_RE.match(id_)
            or id_ == _SAVED_LIKED
            or not isinstance(name, str)
            or not name.strip()
        ):
            continue
        s["lists"][id_] = {
            "name": name.strip()[:_SAVED_NAME_MAX],
            "order": o["order"],
            "ts": o["ts"],
        }
    for mk, r in each(x.get("members")):
        o = _saved_order(r)
        i = mk.find("\t") if isinstance(mk, str) else -1
        if (
            i < 1
            or not o
            or not _SAVED_ID_RE.match(mk[:i])
            or len(mk) - i - 1 > _SAVED_ZIM_MAX + _SAVED_PATH_MAX + 64
        ):
            continue
        s["members"][mk] = o
    for id_, r in each(x.get("positions")):
        p = _saved_thing(r, id_) if isinstance(id_, str) else None
        if p:
            s["positions"][id_] = p
    for id_, r in each(x.get("highlights")):
        h = _saved_highlight(r, id_)
        if h:
            s["highlights"][id_] = h
    for g, ts in each(x.get("gone")):
        if (
            _saved_num(ts) is not None
            and isinstance(g, str)
            and _SAVED_GONE_RE.match(g)
            and len(g) < _SAVED_ZIM_MAX + _SAVED_PATH_MAX + 128
        ):
            s["gone"][g] = _saved_round(ts)
    s["legacy"] = x.get("legacy") is True
    v = x.get("v")
    if v == 1 and not isinstance(v, bool):
        _saved_likes_from_v1(s)
    return s


def _saved_likes_from_v1(s):
    """1.12.0 saved whatever was liked. A thing in Liked and in no list of
    its own was most likely kept by the heart alone: it stays liked and
    leaves Bookmarks. Its time is left as it was, so every copy agrees."""
    liked, listed = set(), set()
    for mk in s["members"]:
        i = mk.find("\t")
        (liked if mk[:i] == _SAVED_LIKED else listed).add(mk[i + 1 :])
    for id_ in liked - listed:
        if id_ in s["items"]:
            s["items"][id_]["likeOnly"] = True


def _saved_sv_of(r):
    """When an item's saved state was last set: sv, or before sv was kept
    (1.12.0, and 1.12.1's first builds) ts, except a thing only liked and
    never touched since (added is ts): the heart made it, nothing chose."""
    if "sv" in r:
        return r["sv"]
    return 0 if r.get("likeOnly") and r["added"] == r["ts"] else r["ts"]


def _saved_set_sv(r, v):
    """sv is written only where it says more than _saved_sv_of would without it."""
    r.pop("sv", None)
    if v != _saved_sv_of(r):
        r["sv"] = v
    return r


def _saved_let_go(s, id_):
    """A thing only liked, its like gone: not kept. Its unsave stays as a
    tombstone dated when it was let go (none if it never was saved), so an
    older save elsewhere does not come back and a newer one stays saved."""
    sv = _saved_sv_of(s["items"].pop(id_))
    g = "i:" + id_
    if sv > 0 and not s["gone"].get(g, -1) >= sv:
        s["gone"][g] = sv


def _saved_merge_item(r, x, y, gone, g):
    """What the item is comes from the newer copy (``r``); whether it is saved
    from the newer of the copies' sv and its tombstone (a tie keeps ``x``'s, a
    tombstone as new wins). Not saved, it stays for its like, as likeOnly;
    _saved_normalize lets it go when there is none."""
    w = y if x is None else x if y is None else (y if _saved_sv_of(y) > _saved_sv_of(x) else x)
    sv, saved = _saved_sv_of(w), not w.get("likeOnly")
    if g in gone:
        if gone[g] >= sv:
            saved, sv = False, gone[g]
        else:
            del gone[g]
    out = dict(r)
    if saved:
        out.pop("likeOnly", None)
    else:
        out["likeOnly"] = True
    return _saved_set_sv(out, sv)


def _saved_cap(m, n, ts_of):
    """Past ``n`` records, the newest are kept (ties by key)."""
    if len(m) <= n:
        return
    for k in sorted(m, key=lambda k: (-ts_of(m[k]), k))[n:]:
        del m[k]


def _saved_rec_ts(r):
    return r["ts"]


def _saved_gone_ts(v):
    return v


def _saved_bytes(x):
    """The bytes x takes as the file holds it: UTF-8 JSON, compact."""
    return len(
        json.dumps(x, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8", "surrogatepass"
        )
    )


def _saved_fit(s, budget):
    """Past ``budget`` bytes the oldest tombstones go first, then the oldest
    places, until the store fits. Nothing a person saved is dropped here: a
    store still over is the caller's to refuse."""
    size = _saved_bytes(s)
    for name, ts_of in (("gone", _saved_gone_ts), ("positions", _saved_rec_ts)):
        m = s[name]
        for k in sorted(m, key=lambda k: (ts_of(m[k]), k)):
            if size <= budget:
                return
            # "key":value, and the comma beside it while another is left.
            size -= _saved_bytes(k) + 1 + _saved_bytes(m[k]) + (len(m) > 1)
            del m[k]


def _saved_normalize(s, now_ms, budget=None):
    """A membership needs its item and its list, and a list of its own a
    saved item; a thing only liked needs its like; tombstones age out; each
    app keeps its latest places; the store fits its byte budget
    (_saved_fit)."""
    liked = set()
    for mk in list(s["members"]):
        i = mk.find("\t")
        lid, id_ = mk[:i], mk[i + 1 :]
        it = s["items"].get(id_)
        if not it or (
            lid != _SAVED_LIKED and (lid not in s["lists"] or it.get("likeOnly"))
        ):
            del s["members"][mk]
        elif lid == _SAVED_LIKED:
            liked.add(id_)
    for id_ in [k for k, it in s["items"].items() if it.get("likeOnly")]:
        if id_ not in liked:
            _saved_let_go(s, id_)
    for g in [g for g, ts in s["gone"].items() if ts < now_ms - _SAVED_GONE_MS]:
        del s["gone"][g]
    _saved_cap(s["gone"], _SAVED_GONE_MAX, _saved_gone_ts)
    p, by_app = s["positions"], {}
    for k, r in p.items():
        by_app.setdefault(r.get("app", ""), []).append(k)
    for ks in by_app.values():
        for k in sorted(ks, key=lambda k: (-p[k]["ts"], k))[_SAVED_POS_PER_APP:]:
            del p[k]
    _saved_fit(s, _SAVED_MAX_BYTES if budget is None else budget)
    return s


def _saved_clamp(s, most):
    """No time in a cleaned store later than ``most`` (ms)."""
    for name, _pre in _SAVED_COLLS:
        for r in s[name].values():
            r["ts"] = min(r["ts"], most)
            if "added" in r:
                r["added"] = min(r["added"], most)
            if "sv" in r:
                r["sv"] = min(r["sv"], most)
    for g in s["gone"]:
        s["gone"][g] = min(s["gone"][g], most)
    return s


def _merge_saved(a, b, now_ms, budget=None):
    """Two cleaned stores as one: per record the newer wins (a tie keeps
    ``a``'s); a tombstone as new as a record or newer removes it, and a record
    saved again after its delete outlives the tombstone."""
    out = _saved_empty()
    out["legacy"] = bool(a.get("legacy") or b.get("legacy"))
    gone = {}
    for src in (a["gone"], b["gone"]):
        for g, ts in src.items():
            if not (g in gone and gone[g] >= ts):
                gone[g] = ts
    for name, pre in _SAVED_COLLS:
        A, B = a[name], b[name]
        for id_ in list(A) + list(B):
            if id_ in out[name]:
                continue
            x, y = A.get(id_), B.get(id_)
            r = y if x is None else x if y is None else (y if y["ts"] > x["ts"] else x)
            if name == "items":
                out[name][id_] = _saved_merge_item(r, x, y, gone, pre + id_)
                continue
            dead = gone.get(pre + id_)
            if dead is not None:
                if dead >= r["ts"]:
                    continue
                del gone[pre + id_]
            out[name][id_] = r
    out["gone"] = gone
    return _saved_normalize(out, now_ms, budget)


def _now_ms():
    return int(time.time() * 1000)


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
        "saved": _saved_empty(),
    }


class UserDataUnreadable(Exception):
    """A user's data file exists but could not be read. Nothing may be
    written over it: the next write would replace what it holds."""


def _read_user_data(name):
    """A user's stored blob; fresh-empty when there is none. Raises
    UserDataUnreadable when the file is there but cannot be read."""
    import json

    try:
        with open(_userdata_path(name), encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return _empty_user_data()
    except (ValueError, OSError) as e:
        log.warning("Could not read user data for %s: %s", name, e)
        raise UserDataUnreadable(name) from e
    return data if isinstance(data, dict) else _empty_user_data()


def load_user_data(name):
    """Return a user's stored data blob, or a fresh-empty one when none exists
    or it cannot be read (logged; only a read, so nothing is lost). Caller
    has already authorized the requester for ``name``."""
    if _safe_userdata_key(name) is None:
        return _empty_user_data()
    try:
        return _read_user_data(name)
    except UserDataUnreadable:
        return _empty_user_data()


def _user_data_doc(blob, now_ms, saved=None):
    """The blob as it is kept: known fields only, each of its type, and the
    saved store rebuilt record by record and normalized (``saved``: a store
    that already is)."""
    if saved is None:
        saved = _saved_normalize(_clean_saved(blob.get("saved")), now_ms)
    bookmarks = blob.get("bookmarks")
    folders = blob.get("folders")
    history = blob.get("history")
    prefs = blob.get("preferences")
    return {
        "version": _USERDATA_VERSION,
        "bookmarks": bookmarks if isinstance(bookmarks, list) else [],
        "folders": folders if isinstance(folders, list) else [],
        "history": history if isinstance(history, list) else [],
        "preferences": prefs if isinstance(prefs, dict) else {},
        "saved": saved,
        "updated": int(time.time()),
    }


def _write_user_data(name, doc):
    """Write a kept doc, the store and the rest each held to its budget as
    the file holds them. Returns (ok, error); a write that did not land is
    a failure, not an ok."""
    if _saved_bytes(doc["saved"]) > _SAVED_MAX_BYTES:
        return False, "saved too large"
    rest = {k: v for k, v in doc.items() if k != "saved"}
    if _saved_bytes(rest) > _USERDATA_MAX_BYTES:
        return False, "data too large"
    with _lock:
        os.makedirs(_userdata_dir(), exist_ok=True)
        if not _srv._atomic_write_json(_userdata_path(name), doc):
            return False, "write failed"
    return True, None


def save_user_data(name, blob):
    """Persist a user's data blob (bookmarks/history/preferences/saved),
    replacing what was kept. Returns (ok, error). Caller has already
    authorized the requester for ``name``."""
    if _safe_userdata_key(name) is None:
        return False, "invalid user"
    if not isinstance(blob, dict):
        return False, "invalid data"
    return _write_user_data(name, _user_data_doc(blob, _now_ms()))


def sync_user_data(name, patch, now_ms=None):
    """What POST /userdata does: each plain field given (bookmarks, folders,
    history, preferences) replaces the kept one, a field not given is left as
    it was, and ``saved`` is MERGED with the kept store, so two devices writing
    in turn lose nothing and a delete on either one holds. Load, merge and
    write happen under one lock. Returns (ok, error, doc as kept)."""
    if _safe_userdata_key(name) is None:
        return False, "invalid user", None
    if not isinstance(patch, dict):
        return False, "invalid data", None
    now_ms = _now_ms() if now_ms is None else now_ms
    with _lock:
        try:
            cur = _read_user_data(name)
        except UserDataUnreadable:
            # Merging into an empty blob and writing would wipe the file.
            return False, "read failed", None
        blob = dict(cur)
        for field in ("bookmarks", "folders", "history", "preferences"):
            if field in patch:
                blob[field] = patch[field]
        kept = _clean_saved(cur.get("saved"))
        if "saved" in patch:
            # A device whose clock runs ahead is held to the server's.
            sent = _saved_clamp(
                _clean_saved(patch.get("saved")), now_ms + _SAVED_FUTURE_MS
            )
            kept = _merge_saved(kept, sent, now_ms)
        else:
            kept = _saved_normalize(kept, now_ms)
        doc = _user_data_doc(blob, now_ms, saved=kept)
        ok, err = _write_user_data(name, doc)
    return ok, err, (doc if ok else None)


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
    existing blob first and writes each as it was backed up; otherwise each
    is merged the way a device's sync is (sync_user_data): the plain fields
    it carries replace the kept ones, and its saved store is merged with the
    kept one, so what was saved since the backup stays. Other users are
    untouched. Returns the number of user blobs written."""
    if not isinstance(blobs, dict):
        return 0
    if overwrite:
        for key in list(all_user_data().keys()):
            delete_user_data(key)
    written = 0
    for key, blob in blobs.items():
        # key is already casefold; _key is idempotent
        if overwrite:
            ok, err = save_user_data(key, blob)
        else:
            ok, err, _ = sync_user_data(key, blob)
        if ok:
            written += 1
        else:
            log.warning("Restore skipped user data for %s: %s", key, err)
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
    stored = rec.get("pw")
    if not isinstance(stored, str) or not stored:
        # A federated account has no password. Refuse explicitly rather than
        # hand ``None`` to the hash comparison and trust it to fail politely —
        # the whole point of a password-less record is that this path is closed.
        return None
    if _verify_pw(password, stored):
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

    Checks a trusted-proxy identity header first (SSO), then the Bearer token
    (API/XHR), then the session cookie (iframe /w/). Only USER session tokens
    resolve here — the admin password is not a session token, so admin requests
    return None and get the unrestricted view.

    SSO comes first because the proxy authenticated this request *now*: when a
    request carries both, the edge's verdict is the fresher one, and it is the
    only one an operator can revoke centrally. It resolves to an ordinary
    account name, so every caller downstream — the allowlist choke point, the
    manage hierarchy, /whoami, per-user data — is unchanged.
    """
    from zimi import sso as _sso

    sso_name, _ = _sso.resolve(handler)
    if sso_name:
        return sso_name
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
