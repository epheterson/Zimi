"""Manage endpoints and authentication for Zimi.

Handles /manage/* routes: library status, downloads, catalog, settings,
history, stats, and admin authentication. Called from ZimHandler in http.py.
"""

import hashlib
import hmac
import logging
import os
import threading
import time

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
    successful legacy verification to transparently migrate the password file."""
    _set_manage_password(candidate)
    log.info("Migrated password from v1.5 SHA-256 to PBKDF2")


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
    string sets it. Clearing the password (pw falsy) clears username too."""
    pf = _password_file()
    tmp = pf + ".tmp"
    if not pw:
        content = ""  # cleared — no hash, no username
    else:
        if username is None:
            username = _file_username()  # preserve existing on a bare pw change
        content = _hash_pw(pw)
        if username and username.strip():
            content += "\n" + username.strip()
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, pf)
    log.info("Manage password %s", "set" if pw else "cleared")


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
    """Generate a new random API token, save to disk, return it. Uses atomic write."""
    import secrets

    token = secrets.token_urlsafe(32)
    tf = _api_token_file()
    tmp = tf + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(token)
    os.replace(tmp, tf)
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
        # Passwordless is fine on a home network, but a passwordless
        # instance exposed to the internet was letting anyone on Earth
        # manage the library. LAN/loopback clients stay open; public
        # clients must set a password first (from the LAN).
        if handler._is_private_client():
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
        return (403, {"error": "public_locked", "needs_password": False})
    return (401, {"error": "unauthorized", "needs_password": True})


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
# Manage GET Routes
# ============================================================================


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
                "auto_update": {
                    "enabled": _srv._auto_update_enabled,
                    "frequency": _srv._auto_update_freq,
                    "locked": _srv._auto_update_env_locked,
                },
            },
        )

    elif parsed.path == "/manage/stats":
        metrics = _srv._get_metrics()
        disk = _srv._get_disk_usage()
        auto_update = {
            "enabled": _srv._auto_update_enabled,
            "frequency": _srv._auto_update_freq,
            "last_check": _srv._auto_update_last_check,
        }
        title_index = _srv._get_title_index_stats()
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

    elif parsed.path == "/manage/users":
        # Named user accounts (multi-user v1) — admin-only (gated above). Returns
        # the roster (no password hashes) plus the installed ZIM names so the
        # admin UI can build the per-user allowlist multi-select.
        from zimi import users as _users

        return handler._json(
            200,
            {
                "users": _users.list_users(),
                "zims": sorted(_srv.get_zim_files().keys()),
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

    elif parsed.path == "/manage/downloads":
        return handler._json(200, {"downloads": _srv._get_downloads()})

    elif parsed.path == "/manage/activity":
        # Aggregated background-activity snapshot for the topbar status row.
        # Cheap to call — reads in-memory state only, no heavy I/O. Designed
        # for 5s polling. Returns small flat dict; client renders one line.
        idx = _srv._get_title_index_status_brief()
        downloads = _srv._get_downloads()
        # _get_downloads() shape: queued items have queued=True, in-flight
        # items have queued=False + done=False + paused=False (see
        # library.py:1209,1234). Earlier draft filtered on a `status` key
        # that doesn't exist on real download objects — the test stub had it
        # wrong. Active = actively transferring; queued is a separate bucket.
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
                # Only skip when we KNOW it's still downloading: total known,
                # not yet complete, and the engine hasn't flagged it a seeder.
                total = int(raw.get("totalLength", 0))
                seeder = raw.get("seeder") in ("true", True)
                if (
                    state not in ("error", "complete")
                    and not seeder
                    and total > 0
                    and completed < total
                ):
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
            hint = (
                "libtorrent isn't importable on this install — downloads "
                "fall back to HTTP. Install libtorrent to torrent and share "
                "load with the Kiwix mirrors."
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


def _handle_users_post(handler, data):
    """Admin-only user CRUD (multi-user v1). action ∈ {create, delete,
    set-password, set-allowlist, set-role}. Errors are returned generically; on
    success the fresh roster (no hashes) is echoed so the UI re-renders in one
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
    else:
        return handler._json(400, {"error": "unknown action"})
    if not ok:
        return handler._json(400, {"error": err or "operation failed"})
    return handler._json(200, {"status": "ok", "users": _users.list_users()})


# ============================================================================
# Manage POST Routes
# ============================================================================


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
        _set_manage_password(new_pw, username=new_user)
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
        return handler._json(200, {"token": token})
    if parsed.path == "/manage/revoke-token":
        challenge = _manage_auth_challenge(handler)
        if challenge:
            return handler._json(*challenge)
        _revoke_api_token()
        return handler._json(200, {"status": "token revoked"})
    challenge = _manage_auth_challenge(handler)
    if challenge:
        return handler._json(*challenge)

    if parsed.path == "/manage/users":
        return _handle_users_post(handler, data)

    if parsed.path == "/manage/download":
        url = data.get("url", "")
        size_bytes = data.get("size_bytes")
        if not url:
            return handler._json(400, {"error": "missing 'url' in request body"})
        dl_id, err = _srv._start_download(url, size_bytes=size_bytes)
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
            dl_id, err = _srv._start_download(url, size_bytes=sz)
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
        dl_id, err = _srv._start_peer_download(peer, fname)
        if err:
            return handler._json(400, {"error": err})
        return handler._json(200, {"status": "started", "id": dl_id})

    elif parsed.path == "/manage/import":
        url = data.get("url", "")
        if not url:
            return handler._json(400, {"error": "missing 'url' in request body"})
        dl_id, err = _srv._start_import(url)
        if err:
            return handler._json(400, {"error": err})
        return handler._json(200, {"status": "started", "id": dl_id})

    elif parsed.path == "/manage/cancel":
        dl_id = data.get("id", "")
        from zimi.library import _cancel_download

        status, code = _cancel_download(dl_id)
        if status == "not_found":
            return handler._json(404, {"error": "Download not found"})
        if status == "already_done":
            return handler._json(400, {"error": "Download already finished"})
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
        return handler._json(
            200, {"status": "started" if started else "running", "detail": msg}
        )

    elif parsed.path == "/manage/export-bookmarks":
        # Save bookmarks to a standalone ZIM. The client POSTs its localStorage
        # bookmark list (client-side only — server has no copy).
        from zimi import zimwriter as _zw

        bookmarks = data.get("bookmarks")
        if not isinstance(bookmarks, list) or not bookmarks:
            return handler._json(400, {"error": "No bookmarks to export"})
        if len(bookmarks) > 500:
            return handler._json(400, {"error": "Too many bookmarks (max 500)"})
        cleaned = [
            {
                "zim": str(b.get("zim", "")),
                "path": str(b.get("path", "")),
                "title": str(b.get("title", "")),
            }
            for b in bookmarks
            if isinstance(b, dict)
        ]
        started, msg = _zw.start_export(cleaned)
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
        filepath = os.path.join(_srv.ZIM_DIR, filename)
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
            _srv._append_history(
                {
                    "event": "deleted",
                    "ts": time.time(),
                    "filename": filename,
                    "size_bytes": file_size,
                    **zim_info,
                }
            )
            with _srv._zim_lock:
                _srv.load_cache(force=True)
            _srv._search_cache_clear()
            _srv._suggest_cache_clear()
            _srv._clean_stale_title_indexes()
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
        for upd in updates:
            url = upd.get("download_url")
            if url:
                dl_id, err = _srv._start_download(url)
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
                    if fname.endswith(".zim"):
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
        if overrides is None and order is None:
            return handler._json(400, {"error": "nothing to update"})
        if overrides is not None:
            if (
                not isinstance(overrides, dict)
                or len(overrides) > _srv._LAYOUT_MAX_OVERRIDES
            ):
                return handler._json(400, {"error": "invalid overrides"})
            for k, v in overrides.items():
                if (
                    not isinstance(k, str)
                    or not isinstance(v, str)
                    or len(k) > _srv._LAYOUT_STR_MAX
                    or len(v) > _srv._LAYOUT_STR_MAX
                ):
                    return handler._json(400, {"error": "invalid overrides"})
        if order is not None:
            if not isinstance(order, list) or len(order) > _srv._LAYOUT_MAX_ORDER:
                return handler._json(400, {"error": "invalid section_order"})
            for s in order:
                if (
                    not isinstance(s, str)
                    or len(s) > _srv._LAYOUT_STR_MAX
                    or not _srv._SECTION_KEY_RE.match(s)
                ):
                    return handler._json(400, {"error": "invalid section_order"})
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
            _srv._save_library_layout(layout)
        return handler._json(
            200,
            {
                "status": "ok",
                "overrides": layout.get("overrides", {}),
                "section_order": layout.get("section_order", []),
            },
        )

    else:
        return handler._json(404, {"error": "not found"})
