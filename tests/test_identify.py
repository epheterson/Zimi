"""identify() answers exactly what the four existing checks answer.

This is the invisible step: nothing calls ``identify`` yet. These tests hold
it equal to ``_primary_admin_authorized``, ``_secondary_admin_authorized``,
``request_allow`` and ``_creator_authorized`` across every way a request can
be trusted, so that when the four become views over ``identify`` nothing
changes for anyone — and so that the next bootstrap bypass has one function
to be found in rather than five.

Driven with a fake handler and the real decision functions, every credential
source stubbed at the same seam the production code reads it from.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402
from zimi import identity, manage, users  # noqa: E402


class _Headers(dict):
    def get(self, key, default=None):  # case-insensitive like HTTPMessage
        for k, v in self.items():
            if k.lower() == key.lower():
                return v
        return default


class _Handler:
    """Just enough of ZimHandler for the auth functions."""

    def __init__(self, headers=None, loopback=False, private=False, forwarded=False):
        self.headers = _Headers(headers or {})
        self._loopback = loopback
        self._private = private
        self._forwarded = forwarded
        self.client_address = ("127.0.0.1" if loopback else "203.0.113.9", 1)

    def _is_loopback_client(self):
        return self._loopback and not self._forwarded

    def _is_private_client(self):
        return self._private or self._loopback

    def _is_direct_private_client(self):
        return self._is_private_client() and not self._forwarded

    def _was_forwarded(self):
        return self._forwarded


@pytest.fixture
def world(tmp_path, monkeypatch):
    """A clean instance: no password, no token, no users, no key, no env."""
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    for var in (
        "ZIMI_MANAGE_OPEN",
        "ZIMI_LAN_ADMIN",
        "ZIMI_PUBLIC_ACCESS",
        "ZIMI_MANAGE_PASSWORD",
        "ZIMI_MANAGE_USER",
        "ZIMI_API_TOKEN",
    ):
        monkeypatch.delenv(var, raising=False)
    manage._env_pw_hash_cache = None
    # SSO is off in this world; resolve_request_user still consults it.
    from zimi import sso as _sso

    monkeypatch.setattr(_sso, "resolve", lambda h: (None, None))
    return tmp_path


def _agree(handler):
    """The four existing answers and identify's, side by side."""
    acct = identity.identify(handler)
    return {
        "primary": manage._primary_admin_authorized(handler),
        "secondary": manage._secondary_admin_authorized(handler),
        "allow": users.request_allow(handler),
        "creator": manage._creator_authorized(handler),
    }, acct


def _check(handler):
    old, acct = _agree(handler)
    assert bool(acct["primary"]) == bool(old["primary"]), (old, acct)
    assert (acct["role"] == "admin" and not acct["primary"]) == bool(
        old["secondary"]
    ), (old, acct)
    assert acct["allow"] == old["allow"], (old, acct)
    assert bool(acct["can_create"]) == bool(old["creator"]), (old, acct)
    return acct


# ── passwordless instance: the bootstrap window ────────────────────────────


def test_the_host_is_primary_while_no_password_exists(world):
    acct = _check(_Handler(loopback=True))
    assert acct["primary"] and acct["source"] == "host"


def test_a_lan_peer_is_nobody_while_no_password_exists(world):
    acct = _check(_Handler(private=True))
    assert acct["name"] == users.ANONYMOUS_NAME and acct["source"] == "anonymous"


def test_a_forwarded_request_is_never_the_host(world):
    acct = _check(_Handler(loopback=True, forwarded=True))
    assert not acct["primary"]


def test_the_setup_key_opens_the_door(world):
    key = manage.ensure_setup_key()
    acct = _check(_Handler(headers={"X-Zimi-Setup-Key": key}, private=True))
    assert acct["primary"] and acct["source"] == "setup-key"


def test_lan_admin_trusts_a_direct_private_peer_only(world, monkeypatch):
    monkeypatch.setenv("ZIMI_LAN_ADMIN", "1")
    assert _check(_Handler(private=True))["source"] == "lan-admin"
    assert _check(_Handler(private=True, forwarded=True))["source"] == "anonymous"


def test_manage_open_makes_everyone_primary(world, monkeypatch):
    monkeypatch.setenv("ZIMI_MANAGE_OPEN", "1")
    acct = _check(_Handler(headers={"X-Forwarded-For": "8.8.8.8"}))
    assert acct["primary"] and acct["source"] == "open"


# ── with a password ─────────────────────────────────────────────────────────


@pytest.fixture
def locked(world):
    assert manage._set_manage_password("hunter2")
    return world


def test_the_password_is_primary_and_the_host_no_longer_is(locked):
    assert _check(_Handler(loopback=True))["source"] == "anonymous"
    acct = _check(_Handler(headers={"Authorization": "Bearer hunter2"}))
    assert acct["primary"] and acct["source"] == "password"
    assert (
        _check(_Handler(headers={"Authorization": "Bearer wrong"}))["source"]
        == "anonymous"
    )


def test_a_configured_username_must_match(locked, monkeypatch):
    monkeypatch.setenv("ZIMI_MANAGE_USER", "eric")
    with_user = _Handler(
        headers={"Authorization": "Bearer hunter2", "X-Zimi-User": "Eric"}
    )
    assert _check(with_user)["primary"]
    without = _Handler(headers={"Authorization": "Bearer hunter2"})
    assert not _check(without)["primary"]


def test_the_api_token_is_primary(locked):
    token = manage._generate_api_token()
    acct = _check(_Handler(headers={"Authorization": f"Bearer {token}"}))
    assert acct["primary"] and acct["source"] == "api-token"


def test_a_primary_admin_session_is_primary(locked):
    token = users.create_admin_session()
    acct = _check(_Handler(headers={"Cookie": f"zimi_session={token}"}))
    assert acct["primary"] and acct["source"] == "admin-session"


# ── accounts ────────────────────────────────────────────────────────────────


def test_a_secondary_admin_is_admin_but_not_primary(locked):
    assert users.create_user("sam", "pw", role="admin")[0]
    token = users.create_session("sam")
    acct = _check(_Handler(headers={"Authorization": f"Bearer {token}"}))
    assert acct["role"] == "admin" and not acct["primary"] and acct["can_create"]


def test_a_limited_user_sees_their_allowlist(locked):
    assert users.create_user("kid", "pw", allowlist=["wikipedia_en"])[0]
    token = users.create_session("kid")
    acct = _check(_Handler(headers={"Authorization": f"Bearer {token}"}))
    assert acct["role"] == "limited" and acct["allow"] == {"wikipedia_en"}
    assert not acct["can_create"]


def test_can_create_is_an_additive_flag(locked):
    assert users.create_user("maker", "pw", role="user")[0]
    assert users.set_can_create("maker", True)[0]
    token = users.create_session("maker")
    assert _check(_Handler(headers={"Authorization": f"Bearer {token}"}))["can_create"]


# ── nobody, under each public-access policy ────────────────────────────────


@pytest.mark.parametrize("mode", ["open", "limited", "private"])
def test_anonymous_under_each_policy(locked, mode):
    assert users.set_public_access(mode, ["wikipedia_en"])[0]
    acct = _check(_Handler())
    assert acct["name"] == users.ANONYMOUS_NAME
    expected = {"open": None, "limited": {"wikipedia_en"}, "private": set()}[mode]
    assert acct["allow"] == expected


def test_an_admin_sees_everything_whatever_the_policy(locked):
    assert users.set_public_access("private")[0]
    acct = _check(_Handler(headers={"Authorization": "Bearer hunter2"}))
    assert acct["allow"] is None


def test_lan_admin_is_the_whole_answer_while_it_is_on(world, monkeypatch):
    """The old check's quirk, preserved on purpose: with lan_admin on, the LAN
    test decides, and neither the host nor a valid setup key is consulted.
    A forwarded client holding the key is refused. The door step decides
    whether that stays; this step changes nothing."""
    monkeypatch.setenv("ZIMI_LAN_ADMIN", "1")
    key = manage.ensure_setup_key()
    forwarded_with_key = _Handler(
        headers={"X-Zimi-Setup-Key": key}, private=True, forwarded=True
    )
    assert _check(forwarded_with_key)["source"] == "anonymous"
    assert _check(_Handler(loopback=True))["source"] == "lan-admin"
