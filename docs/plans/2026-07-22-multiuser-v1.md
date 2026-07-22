# Multi-user v1 (v1.8)

## Goal
Admin (existing password account) + N named users in `users.json`. Per-user ZIM
allowlists filter the read surface when a USER is logged in. Anonymous + admin see
everything (unchanged). Zero migration for existing single-password installs.

## Identity model (no collisions)
- **Admin**: `Authorization: Bearer <admin-password>` (or API token). Recognized by
  existing `manage._check_manage_auth`. Never filtered (`current_allow()==None`).
- **User**: logs in → server mints a random session token, stored server-side
  (hashed) mapped to the account, delivered via HttpOnly cookie `zimi_session`
  (so header-less iframe `/w/` requests carry it) AND returned for Bearer use
  (API/CLI). A session token never matches the admin password hash → users are
  auto-rejected from `/manage/*`.
- **Anonymous**: no creds → `current_allow()==None` → sees everything (v1 does not
  force login).

## Choke point (single helper, no scatter)
- `server._request_ctx` thread-local holds the request's allow set (ThreadingHTTPServer
  = one thread/request). Set at top of `do_GET`/`do_POST`, cleared in `finally`.
- `get_zim_files()` and `list_zims()` filter their result by `current_allow()`.
  Every dict-based path (search_all, read_article, chunk_article, resolve_almanac_qids)
  flows through `get_zim_files()` → filtered for free.
- `zim_allowed(name)` gates the two spots that bypass `get_zim_files`:
  `/w/` (`_serve_zim_content`, pooled archives) and the direct `_zim_list_cache`
  enumerations in `/random` and `/search`'s lang filter.

## Files
- NEW `zimi/users.py` — users.json CRUD, PBKDF2 (reuse manage), session store, resolve.
- `server.py` — thread-local allow ctx + filter in get_zim_files/list_zims + zim_allowed.
- `http.py` — set/clear ctx in do_GET/do_POST; `/login` `/logout` `/whoami`; `/w/`,
  `/random`, `/search` gates; cookie helper.
- `manage.py` — `/manage/users` GET (list) + POST (create/delete/set-password/set-allowlist), admin-gated.
- `static/app.js` + `templates/index.html` + `static/app.css` — Users admin section, sign-in/out UI.
- `static/i18n/*.json` ×10 — new keys, parity maintained.
- NEW `tests/test_users.py` — full matrix.

## Security invariants
1. User token never sees MORE than allowlist (fail-open == anonymous, which is fine).
2. User session tokens never pass admin `/manage/*` auth.
3. Username enumeration blocked: generic 401 on login.
4. User passwords use the same PBKDF2 path as admin.

## v2 seam (NOT in v1)
`flags: {}` per user in users.json — kid mode, history monitoring, forced login,
schools. No monitoring of any kind in v1.
