"""The apps row can be turned off for everyone (ZIMI_APPS, or the switch in
Server settings) or for one signed-in person (their account's preferences).
Never per browser. On by default. Eric, 2026-09-19: "If folks don't want
apps we might want some way to like limit them entirely and/or per user
probably on by default is okay" and "Not per browser only per user or server".

Run: pytest tests/test_apps_switch.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import zimi.manage as manage  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import http, users  # noqa: E402


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("ZIMI_APPS", raising=False)
    yield tmp_path


@pytest.mark.parametrize("value,expected", [("1", True), ("yes", True), ("0", False), ("false", False), ("OFF", False), (" no ", False)])
def test_the_env_var_has_the_last_word(data_dir, monkeypatch, value, expected):
    monkeypatch.setenv("ZIMI_APPS", value)
    assert srv.apps_enabled() is expected
    assert srv.set_apps_enabled(not expected) == (None, "env_locked")
    assert srv.apps_enabled() is expected


def test_on_by_default_and_the_server_switch_sticks(data_dir):
    assert srv.apps_enabled() is True
    assert srv.set_apps_enabled(False) == (False, None)
    assert srv.apps_enabled() is False
    assert manage._read_app_update_prefs()["apps"] is False
    assert srv.set_apps_enabled(True) == (True, None)
    assert srv.apps_enabled() is True


def test_the_shell_is_stamped_only_when_off():
    on = http._index_content(True)
    off = http._index_content(False)
    assert "data-zimi-apps" not in on
    assert off.count('<body data-zimi-apps="0">') == 1
    assert off.replace('<body data-zimi-apps="0">', "<body>", 1) == on
    some = http._index_content(frozenset(["reddot", "maps"]))
    assert some.count('<body data-zimi-apps="maps,reddot">') == 1
    assert http._index_content(frozenset(srv.APP_NAMES)) == on


@pytest.mark.parametrize(
    "value,shown",
    [
        ("maps,tube", {"maps", "tube"}),
        (" Reddot , maps ", {"maps", "reddot"}),
        ("maps,bogus", {"maps"}),
        ("all", set(srv.APP_NAMES)),
        ("none", set()),
        (["exchange"], {"exchange"}),
        (True, set(srv.APP_NAMES)),
        (False, set()),
    ],
)
def test_each_app_can_be_offered_or_not(data_dir, monkeypatch, value, shown):
    if isinstance(value, str):
        monkeypatch.setenv("ZIMI_APPS", value)
        assert srv.apps_shown() == frozenset(shown)
        assert srv.apps_enabled() is bool(shown)
        assert srv.set_apps_enabled(True) == (None, "env_locked")
    else:
        assert srv.set_apps_enabled(value) == (bool(shown), None)
        assert srv.apps_shown() == frozenset(shown)
        saved = manage._read_app_update_prefs()["apps"]
        assert saved is (True if shown == set(srv.APP_NAMES) else False) if isinstance(saved, bool) else saved == sorted(shown, key=srv.APP_NAMES.index)


def test_a_saved_list_is_in_the_apps_order(data_dir):
    assert srv.set_apps_enabled(["reddot", "maps"]) == (True, None)
    assert manage._read_app_update_prefs()["apps"] == ["maps", "reddot"]
    assert srv.apps_stamp(srv.apps_shown()) == "maps,reddot"
    assert srv.apps_stamp(frozenset()) == "0"
    assert srv.apps_stamp(True) is None


def test_an_account_keeps_only_what_the_server_offers(data_dir, monkeypatch):
    assert srv.user_apps_shown(None) == frozenset(srv.APP_NAMES)
    assert srv.user_apps_shown(["tube", "maps"]) == frozenset(["tube", "maps"])
    assert srv.user_apps_shown(False) == frozenset()
    monkeypatch.setenv("ZIMI_APPS", "maps")
    assert srv.user_apps_shown(["tube", "maps"]) == frozenset(["maps"])
    assert http._prefs_reply({"apps": ["tube"]}) == {"apps": False, "shown": []}
    assert http._prefs_reply({}) == {"apps": True, "shown": ["maps"]}


def test_a_users_preference_lives_with_their_account(data_dir, monkeypatch):
    monkeypatch.setattr(users, "_userdata_dir", lambda: str(data_dir / "users"))
    os.makedirs(str(data_dir / "users"), exist_ok=True)
    blob = users.load_user_data("eric")
    assert blob["preferences"] == {}
    blob["preferences"]["apps"] = False
    assert users.save_user_data("eric", blob) == (True, None)
    assert users.load_user_data("eric")["preferences"]["apps"] is False
    assert users.load_user_data("someone-else")["preferences"] == {}


def test_the_variable_is_tabled_for_the_environment_panel():
    from zimi import envinfo

    assert "ZIMI_APPS" in envinfo.VARS
