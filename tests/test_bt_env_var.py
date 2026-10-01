"""The BitTorrent card names the variable that set it.

A 1.13 design review: with ZIMI_TORRENT=0 the card said "Controlled by
ZIMI_BT", and said it twice. It names the variable that decided, as it is
set, once.

Run: pytest tests/test_bt_env_var.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import p2p  # noqa: E402

VARS = ("ZIMI_OFFLINE", "ZIMI_BT", "ZIMI_TORRENT")


@pytest.fixture
def env(monkeypatch, tmp_path):
    for v in VARS:
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setattr(p2p, "_read_pref", lambda key, default=None: default)
    return monkeypatch


@pytest.mark.parametrize(
    "set_, var, setting, enabled",
    [
        ({}, "", "", True),
        ({"ZIMI_TORRENT": "0"}, "ZIMI_TORRENT", "ZIMI_TORRENT=0", False),
        ({"ZIMI_BT": "off"}, "ZIMI_BT", "ZIMI_BT=off", False),
        # ZIMI_OFFLINE outranks the others, so it is the one named.
        (
            {"ZIMI_OFFLINE": "1", "ZIMI_TORRENT": "0"},
            "ZIMI_OFFLINE",
            "ZIMI_OFFLINE=1",
            False,
        ),
        # ZIMI_BT outranks the legacy ZIMI_TORRENT.
        ({"ZIMI_BT": "on", "ZIMI_TORRENT": "0"}, "ZIMI_BT", "ZIMI_BT=on", True),
        # A whole ZIMI_BT blob is named, not quoted.
        ({"ZIMI_BT": "off,port=6881,ratio=2,up=2048"}, "ZIMI_BT", "ZIMI_BT", False),
    ],
)
def test_the_variable_that_decided_is_the_one_named(env, set_, var, setting, enabled):
    for k, v in set_.items():
        env.setenv(k, v)
    assert p2p.is_torrent_enabled() is enabled
    assert p2p.is_torrent_env_locked() is bool(var)
    assert p2p.torrent_env_var() == var
    assert p2p.torrent_env_setting() == setting
    assert p2p.get_mirror_status()["torrent_env_var"] == var


def test_the_card_says_it_once():
    src = open(
        os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "zimi",
            "static",
            "app.js",
        ),
        encoding="utf-8",
    ).read()
    # Off, the reason line names it; the lock note under the title does not repeat it.
    assert (
        "_shareSwitch('torrent', btOn, m.torrent_env_locked, btOn ? (m.torrent_env_var || 'ZIMI_BT') : '',"
        in src
    )
    assert (
        "(locked && envVar ? '<div class=\"share-row-desc share-row-locknote\">'" in src
    )
    css = open(
        os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "zimi",
            "static",
            "app.css",
        ),
        encoding="utf-8",
    ).read()
    assert ".share-controls-off .switch input:checked + .switch-slider { background: var(--surface2)" in css
