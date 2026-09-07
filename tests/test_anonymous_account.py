"""Nobody is an account too.

The first step of 1.10's auth rework, and the invisible one: the anonymous
reader becomes a record in the same shape ``get_user`` returns, derived from
the public-access policy rather than stored. Nothing changes for anyone — and
these tests exist to prove exactly that, mode by mode, so the rest of the
rework can build on the shape without re-deciding what it means.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402
from zimi import users  # noqa: E402


@pytest.fixture
def policy(tmp_path, monkeypatch):
    """A writable data dir and no env override, so the file is the policy."""
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("ZIMI_PUBLIC_ACCESS", raising=False)

    def set_mode(mode, allowlist=None):
        ok, err = users.set_public_access(mode, allowlist)
        assert ok, err

    return set_mode


def test_open_is_a_user_with_the_whole_library(policy):
    policy("open")
    rec = users.anonymous_account()
    assert rec["name"] == users.ANONYMOUS_NAME
    assert rec["role"] == "user" and rec["allowlist"] is None
    assert rec["anonymous"] is True
    assert users._allow_for_record(rec) is None


def test_limited_is_a_limited_user_with_that_allowlist(policy):
    policy("limited", ["wikipedia_en", "gutenberg"])
    rec = users.anonymous_account()
    assert rec["role"] == "limited"
    assert sorted(rec["allowlist"]) == ["gutenberg", "wikipedia_en"]
    assert users._allow_for_record(rec) == {"wikipedia_en", "gutenberg"}


def test_private_is_a_role_that_reads_nothing(policy):
    policy("private")
    rec = users.anonymous_account()
    assert rec["role"] == users.ROLE_NONE
    assert users._allow_for_record(rec) == set()


def test_the_env_override_still_wins(policy, monkeypatch):
    policy("open")
    monkeypatch.setenv("ZIMI_PUBLIC_ACCESS", "private")
    assert users.anonymous_account()["role"] == users.ROLE_NONE


def test_nobody_can_register_the_anonymous_name():
    ok, err = users.create_user(users.ANONYMOUS_NAME, "pw")
    assert not ok and err


def test_a_signed_in_record_and_the_anonymous_one_share_one_rule():
    """The point of the shape: request_allow no longer needs a mode string,
    because a limited user and a limited public are the same kind of thing."""
    limited = {"role": "limited", "allowlist": ["a"]}
    full = {"role": "user", "allowlist": None}
    none = {"role": users.ROLE_NONE, "allowlist": []}
    assert users._allow_for_record(limited) == {"a"}
    assert users._allow_for_record(full) is None
    assert users._allow_for_record(none) == set()
