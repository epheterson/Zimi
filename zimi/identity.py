"""Who is this request? One answer, asked in one place.

Zimi grew nine ways for a request to end up trusted, spread across four
modules, and no single function answered "who is this". A change to one
branch could not be reasoned about against the others, which is how the same
bootstrap bypass shipped twice in two days. This module is the one answer.

``identify(handler)`` returns an **Account**: a plain dict in the shape
``users.get_user`` returns, plus what the request path needs to know:

    name        the account name; ``admin`` for the password account,
                ``anonymous`` for nobody
    role        ``admin`` / ``user`` / ``limited`` / ``none``
    primary     True for the password account — the one no other admin can
                demote — and for the bootstrap and open doors that stand in
                for it while no password exists
    allow       ``None`` for the whole library, else the set of ZIM names
    can_create  whether this account may drive ZIM creation
    source      which credential answered, for the log and for /whoami

Precedence is exactly the order the existing checks resolve in, so that
``identify`` can be pinned equal to them before anything switches over:

    1. ``manage_open``: the operator turned authentication off
    2. a signed-in account (SSO, Bearer session, cookie session)
    3. a primary-admin session (cookie or Bearer)
    4. the API token
    5. the admin password, with the configured username when there is one
    6. the passwordless bootstrap: the host, the setup key, or ``lan_admin``
    7. nobody, which is an account too (``users.anonymous_account``)

This step is invisible: nothing calls ``identify`` yet except its tests,
which hold it equal to ``_primary_admin_authorized``,
``_secondary_admin_authorized``, ``request_allow`` and ``_creator_authorized``
across the whole matrix. The next step makes those four views over this.
"""

import hmac

from zimi import users as _users

PRIMARY_NAME = "admin"


def _account(name, role, *, primary=False, allow=None, can_create=False, source=""):
    return {
        "name": name,
        "role": role,
        "primary": primary,
        "allow": allow,
        "can_create": can_create,
        "source": source,
    }


def _primary(source):
    return _account(
        PRIMARY_NAME, "admin", primary=True, allow=None, can_create=True, source=source
    )


def _from_record(name, rec, source):
    role = _users._effective_role(rec)
    return _account(
        rec.get("name") or name,
        role,
        primary=False,
        allow=_users._allow_for_record(rec),
        can_create=_users._rec_can_create(rec),
        source=source,
    )


def _bearer(handler):
    auth = handler.headers.get("Authorization", "") or ""
    return auth[7:] if auth.startswith("Bearer ") else ""


def identify(handler):
    """The Account this request is acting as. Never raises; fails closed to
    anonymous, which is the least any request is."""
    from zimi import manage as _manage

    if _manage.manage_open():
        return _primary("open")

    name = _users.resolve_request_user(handler)
    if name:
        rec = _users.get_user(name)
        if rec:
            return _from_record(name, rec, "session")

    if _users.is_admin_session(
        _users._cookie_token(handler)
    ) or _users.is_admin_session(_users._bearer_token(handler)):
        return _primary("admin-session")

    candidate = _bearer(handler)
    stored_pw = _manage._get_manage_password_hash()
    if candidate:
        token = _manage._get_api_token()
        if token and hmac.compare_digest(candidate, token):
            return _primary("api-token")
        if stored_pw and _manage._verify_password(candidate, stored_pw):
            configured = _manage._get_manage_user()
            if configured:
                provided = handler.headers.get("X-Zimi-User", "") or ""
                if provided.strip().casefold() != configured.strip().casefold():
                    return _anonymous(handler)
            return _primary("password")

    if not stored_pw:
        is_local = getattr(handler, "_is_loopback_client", handler._is_private_client)
        if is_local():
            return _primary("host")
        if _manage._bootstrap_key_ok(handler):
            return _primary("setup-key")
        if _manage._lan_admin_allowed() and _manage._lan_client(handler):
            return _primary("lan-admin")

    return _anonymous(handler)


def _anonymous(handler):
    rec = _users.anonymous_account()
    return _account(
        rec["name"],
        rec["role"],
        primary=False,
        allow=_users._allow_for_record(rec),
        can_create=False,
        source="anonymous",
    )


def is_admin(account):
    """Any admin: the primary account or a record with role admin."""
    return bool(account.get("primary")) or account.get("role") == "admin"
