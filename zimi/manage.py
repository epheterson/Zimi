"""Manage endpoints and authentication for Zimi.

Handles /manage/* routes: library status, downloads, catalog, settings,
history, stats, and admin authentication. Called from ZimHandler in http.py.
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import threading
import time
import traceback
from urllib.parse import urlparse

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

_env_pw_hash_cache = None  # cached hash for ZIMI_MANAGE_PASSWORD env var

def _get_manage_password_hash():
    """Get password hash from ZIMI_MANAGE_PASSWORD env var (only auth source)."""
    global _env_pw_hash_cache
    pw = os.environ.get("ZIMI_MANAGE_PASSWORD", "")
    if pw:
        if _env_pw_hash_cache is None:
            _env_pw_hash_cache = _hash_pw(pw)
        return _env_pw_hash_cache
    return ""

def _api_token_file():
    """API token file path inside ZIMI_DATA_DIR."""
    return os.path.join(_srv.ZIMI_DATA_DIR, "api_token")

def _get_api_token():
    """Get stored API token (plaintext, for constant-time comparison)."""
    env_token = os.environ.get("ZIMI_API_TOKEN", "")
    if env_token:
        return env_token
    try:
        with open(_api_token_file()) as f:
            return f.read().strip()
    except (FileNotFoundError, OSError):
        return ""

def _generate_api_token():
    """Generate a new random API token, save to disk, return it."""
    import secrets
    token = secrets.token_urlsafe(32)
    with open(_api_token_file(), "w") as f:
        f.write(token)
    log.info("API token generated")
    return token

def _revoke_api_token():
    """Delete the API token file."""
    try:
        os.remove(_api_token_file())
        log.info("API token revoked")
    except FileNotFoundError:
        pass

def _check_manage_auth(handler):
    """Check authorization for manage endpoints. Returns True if unauthorized.

    Auth model:
    - Browser (same-origin): password check via ZIMI_MANAGE_PASSWORD env var
    - API (everything else): ALWAYS requires a valid Bearer token

    Browser detection uses Sec-Fetch-Site header (set by all modern browsers,
    can't be spoofed by JavaScript — it's a "forbidden" header).
    """
    sec_fetch = handler.headers.get("Sec-Fetch-Site", "")
    is_browser = sec_fetch == "same-origin"

    if is_browser:
        stored_pw = _get_manage_password_hash()
        if not stored_pw:
            return None  # no password set, browser access is open
        auth = handler.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return True
        candidate = auth[7:]
        if "$" not in stored_pw:
            return True
        salt = stored_pw.split("$")[0]
        if hmac.compare_digest(_hash_pw(candidate, salt), stored_pw):
            return None
        return True
    else:
        # API request — always require a valid token
        stored_token = _get_api_token()
        if not stored_token:
            return True  # no token generated yet — API access denied
        auth = handler.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return True
        if hmac.compare_digest(auth[7:], stored_token):
            return None  # valid
        return True

# ============================================================================
# Manage GET Routes
# ============================================================================

def handle_manage_get(handler, parsed, params):
    """Handle all GET /manage/* requests. Called from ZimHandler.do_GET."""
    def param(key, default=None):
        return params.get(key, [default])[0]

    if not _srv.ZIMI_MANAGE:
        return handler._json(404, {"error": "Library management is disabled. Set ZIMI_MANAGE=1 to enable."})
    # Public pre-auth endpoint so UI can check token availability
    if parsed.path == "/manage/has-token":
        return handler._json(200, {"has_token": bool(_get_api_token())})
    if _check_manage_auth(handler):
        return handler._json(401, {"error": "unauthorized", "needs_password": True})

    if parsed.path == "/manage/status":
        zim_count = len(_srv.get_zim_files())
        total_gb = sum(z.get("size_gb", 0) for z in (_srv._zim_list_cache or []))
        linked_zims = len(set(_srv._domain_zim_map.values()))
        return handler._json(200, {
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
        })

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
                [{"from": k[0], "to": k[1], "count": v} for k, v in _srv._xzim_refs.items()],
                key=lambda x: x["count"], reverse=True
            )
        linked_zims = len(set(_srv._domain_zim_map.values()))
        zim_count = len(_srv.get_zim_files())
        return handler._json(200, {"metrics": metrics, "disk": disk, "auto_update": auto_update, "title_index": title_index, "cross_zim_refs": xzim_refs, "linked_zims": linked_zims, "zim_count": zim_count, "domain_count": len(_srv._domain_zim_map)})

    elif parsed.path == "/manage/usage":
        return handler._json(200, _srv._get_usage_stats())

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
        return handler._json(200, {"total": total, "items": items})

    elif parsed.path == "/manage/check-updates":
        updates = _srv._check_updates()
        return handler._json(200, {"updates": updates, "count": len(updates)})

    elif parsed.path == "/manage/downloads":
        return handler._json(200, {"downloads": _srv._get_downloads()})

    elif parsed.path == "/manage/history":
        return handler._json(200, {"history": _srv._load_history()})

    elif parsed.path == "/manage/thumb":
        url = param("url", "")
        if not url or not url.startswith("https://library.kiwix.org/"):
            return handler._json(400, {"error": "invalid thumbnail URL"})
        data, ct = _srv._fetch_thumb(url)
        if data is None:
            return handler._json(502, {"error": "failed to fetch thumbnail"})
        handler.send_response(200)
        handler.send_header("Content-Type", ct)
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header("Cache-Control", "public, max-age=604800")  # 7 days browser cache
        handler.end_headers()
        handler.wfile.write(data)
        return

    else:
        return handler._json(404, {"error": "not found"})

# ============================================================================
# Manage POST Routes
# ============================================================================

def handle_manage_post(handler, parsed, data):
    """Handle all POST /manage/* requests. Called from ZimHandler.do_POST."""
    if not _srv.ZIMI_MANAGE:
        return handler._json(404, {"error": "Library management is disabled."})
    # API token management — requires existing auth (password or token)
    if parsed.path == "/manage/generate-token":
        if _check_manage_auth(handler):
            return handler._json(401, {"error": "unauthorized", "needs_password": True})
        token = _generate_api_token()
        return handler._json(200, {"token": token})
    if parsed.path == "/manage/revoke-token":
        if _check_manage_auth(handler):
            return handler._json(401, {"error": "unauthorized", "needs_password": True})
        _revoke_api_token()
        return handler._json(200, {"status": "token revoked"})
    if _check_manage_auth(handler):
        return handler._json(401, {"error": "unauthorized", "needs_password": True})

    if parsed.path == "/manage/download":
        url = data.get("url", "")
        if not url:
            return handler._json(400, {"error": "missing 'url' in request body"})
        dl_id, err = _srv._start_download(url)
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
        with _srv._download_lock:
            dl = _srv._active_downloads.get(dl_id)
            if not dl:
                return handler._json(404, {"error": "Download not found"})
            if dl.get("done"):
                return handler._json(400, {"error": "Download already finished"})
            dl["cancelled"] = True
        return handler._json(200, {"status": "cancelling", "id": dl_id})

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
                for z in (_srv._zim_list_cache or []):
                    if z.get("file") == filename:
                        zim_info = {"title": z.get("title", ""), "name": z.get("name", ""), "has_icon": z.get("has_icon", False)}
                        break
            except Exception as e:
                log.debug("Failed to cache ZIM metadata before deletion of %s: %s", filename, e)
                pass
            os.remove(filepath)
            log.info(f"Deleted ZIM: {filename}")
            _srv._append_history({"event": "deleted", "ts": time.time(), "filename": filename,
                             "size_bytes": file_size, **zim_info})
            with _srv._zim_lock:
                _srv.load_cache(force=True)
            _srv._search_cache_clear()
            _srv._suggest_cache_clear()
            _srv._clean_stale_title_indexes()
            return handler._json(200, {"status": "deleted", "filename": filename})
        except OSError as e:
            log.error("Failed to delete %s: %s", filename, e)
            return handler._json(500, {"error": "Failed to delete file"})

    elif parsed.path == "/manage/cleanup-tmp":
        # Remove partial (.tmp) downloads
        removed = []
        for f in os.listdir(_srv.ZIM_DIR):
            if f.endswith(".zim.tmp"):
                try:
                    fpath = os.path.join(_srv.ZIM_DIR, f)
                    size = os.path.getsize(fpath)
                    os.remove(fpath)
                    removed.append({"filename": f, "size_bytes": size})
                    log.info("Cleaned up partial download: %s", f)
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
        return handler._json(200, {"status": "started", "count": len(started), "downloads": started})

    elif parsed.path == "/manage/auto-update":
        if _srv._auto_update_env_locked:
            return handler._json(403, {"error": "Auto-update is controlled by ZIMI_AUTO_UPDATE env var"})
        enabled = data.get("enabled", _srv._auto_update_enabled)
        freq = data.get("frequency", _srv._auto_update_freq)
        if freq not in _srv._FREQ_SECONDS:
            return handler._json(400, {"error": f"Invalid frequency. Use: {', '.join(_srv._FREQ_SECONDS.keys())}"})
        _srv._auto_update_freq = freq
        if enabled and not _srv._auto_update_enabled:
            _srv._auto_update_enabled = True
            if _srv._auto_update_thread and _srv._auto_update_thread.is_alive():
                log.info("Auto-update thread still running, reusing it")
            else:
                _srv._auto_update_thread = threading.Thread(
                    target=_srv._auto_update_loop, kwargs={"initial_delay": 30}, daemon=True)
                _srv._auto_update_thread.start()
            log.info("Auto-update enabled: %s (first check in 30s)", freq)
        elif not enabled and _srv._auto_update_enabled:
            _srv._auto_update_enabled = False
            log.info("Auto-update disabled")
        _srv._save_auto_update_config(_srv._auto_update_enabled, _srv._auto_update_freq)
        return handler._json(200, {"enabled": _srv._auto_update_enabled, "frequency": _srv._auto_update_freq})

    else:
        return handler._json(404, {"error": "not found"})

# ============================================================================
# Manage DELETE Routes
# ============================================================================

def handle_manage_delete(handler, parsed, params):
    """Handle all DELETE /manage/* requests. Called from ZimHandler.do_DELETE.

    Currently no DELETE /manage/* routes exist — all manage deletions use POST.
    This function is provided for future use and returns 404.
    """
    return handler._json(404, {"error": "not found"})
