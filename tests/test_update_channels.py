"""Update channels for the Zimi APPLICATION check: stable vs latest.

Stable is what every install had before channels existed and must stay
byte-identical in behavior — GitHub's /releases/latest, final releases only.
Latest is the opt-in that also surfaces betas and release candidates, which
means it needs a different endpoint (releases/latest hides pre-releases), a
different comparison (rc1 → rc2 is a real update there and nowhere else), and
its own cache lane so switching channel can never serve the other one's
answer.

ZIMI_OFFLINE outranks all of it: no channel, no force, no preference makes
an air-gapped instance talk to GitHub.
"""

import json
import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402

# ---------------------------------------------------------------------------
# Channel names
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("stable", "stable"),
        ("latest", "latest"),
        ("  Latest  ", "latest"),  # trimmed + case-folded
        ("STABLE", "stable"),
        ("beta", "latest"),  # the word the plan doc used
        ("pre-release", "latest"),
        ("edge", "latest"),
        ("release", "stable"),
        ("", None),
        ("nightly", None),  # a stream we do not publish
        (None, None),
    ],
)
def test_normalize_update_channel(raw, expected):
    assert manage.normalize_update_channel(raw) == expected


# ---------------------------------------------------------------------------
# Preference resolution: env > saved file > default
# ---------------------------------------------------------------------------


@pytest.fixture
def channel_env(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv(manage.APP_UPDATE_CHANNEL_ENV, raising=False)
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    return monkeypatch


def test_default_channel_is_stable(channel_env):
    assert manage.get_update_channel() == "stable"
    assert manage.is_update_channel_env_locked() is False


def test_saved_preference_survives(channel_env, tmp_path):
    channel, err = manage.set_update_channel("latest")
    assert (channel, err) == ("latest", None)
    assert manage.get_update_channel() == "latest"
    saved = json.load(open(os.path.join(str(tmp_path), "app_update_channel.json")))
    assert saved == {"channel": "latest"}


def test_env_beats_saved_preference(channel_env):
    manage.set_update_channel("latest")
    channel_env.setenv(manage.APP_UPDATE_CHANNEL_ENV, "stable")
    assert manage.get_update_channel() == "stable"
    assert manage.is_update_channel_env_locked() is True


def test_env_lock_refuses_writes(channel_env):
    channel_env.setenv(manage.APP_UPDATE_CHANNEL_ENV, "latest")
    assert manage.set_update_channel("stable") == (None, "env_locked")
    assert manage.get_update_channel() == "latest"


def test_junk_env_falls_back_and_does_not_lock(channel_env):
    channel_env.setenv(manage.APP_UPDATE_CHANNEL_ENV, "nightly")
    assert manage.get_update_channel() == "stable"
    assert manage.is_update_channel_env_locked() is False
    # Not locked → the admin can still set one from the UI.
    assert manage.set_update_channel("latest")[0] == "latest"


def test_junk_preference_is_rejected(channel_env):
    assert manage.set_update_channel("nightly") == (None, "invalid_channel")
    assert manage.get_update_channel() == "stable"


def test_corrupt_preference_file_falls_back(channel_env, tmp_path):
    with open(os.path.join(str(tmp_path), "app_update_channel.json"), "w") as f:
        f.write("{not json")
    assert manage.get_update_channel() == "stable"


# ---------------------------------------------------------------------------
# Pre-release ordering — only the latest channel opts into it
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "remote,current,stable_says,latest_says",
    [
        ("1.9.0-rc2", "1.9.0-rc1", False, True),  # the point of the channel
        ("1.9.0-beta2", "1.9.0-beta1", False, True),
        ("1.9.0-rc1", "1.9.0-beta3", False, True),  # rc outranks beta
        ("1.9.0-beta3", "1.9.0-rc1", False, False),  # never a downgrade
        ("1.9.0-beta1", "1.9.0", False, False),  # a pre never beats its final
        ("1.9.0", "1.9.0-rc1", True, True),  # the final always wins
        ("1.9.0-beta1", "1.8.2", True, True),  # higher numbers beat everything
        ("1.9.0-rc1", "1.9.0-rc1", False, False),  # same build, no nag
    ],
)
def test_prerelease_ordering_is_channel_scoped(
    remote, current, stable_says, latest_says
):
    assert manage._app_version_newer(remote, current) is stable_says
    assert (
        manage._app_version_newer(remote, current, allow_prerelease=True) is latest_says
    )


# ---------------------------------------------------------------------------
# Release picking from a /releases list
# ---------------------------------------------------------------------------


def test_pick_newest_release_ignores_publish_order_and_drafts():
    # GitHub returns newest-published first. A stable patch cut after a beta
    # must not hide the beta from the channel that exists to show it.
    feed = [
        {"tag_name": "v1.8.3", "prerelease": False},
        {"tag_name": "v1.9.0-beta2", "prerelease": True, "draft": True},  # unpublished
        {"tag_name": "v1.9.0-beta1", "prerelease": True},
        {"tag_name": "not-a-version", "prerelease": False},
    ]
    picked = manage._pick_newest_release(feed)
    assert picked is not None
    assert picked["tag_name"] == "v1.9.0-beta1"


@pytest.mark.parametrize("feed", [[], [{"tag_name": "junk"}], {"message": "Not Found"}])
def test_pick_newest_release_gives_up_cleanly(feed):
    assert manage._pick_newest_release(feed) is None


# ---------------------------------------------------------------------------
# check_app_update against each channel
# ---------------------------------------------------------------------------

_STABLE_RELEASE = {"tag_name": "v1.8.3", "html_url": "https://x/1.8.3"}
_LATEST_FEED = [
    {"tag_name": "v1.8.3", "html_url": "https://x/1.8.3", "prerelease": False},
    {
        "tag_name": "v1.9.0-beta1",
        "html_url": "https://x/1.9.0-beta1",
        "prerelease": True,
    },
]


class _FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def fake_github(channel_env):
    """Serve the right fixture per URL and record every request."""
    calls = []

    def fake_urlopen(req, timeout=None, context=None):
        calls.append(req.full_url)
        if req.full_url == manage._APP_UPDATE_URL:
            return _FakeResponse(_STABLE_RELEASE)
        return _FakeResponse(_LATEST_FEED)

    channel_env.setattr(manage.urllib.request, "urlopen", fake_urlopen)
    return calls


def test_stable_channel_uses_releases_latest(fake_github):
    entry = manage.check_app_update()
    assert fake_github == [manage._APP_UPDATE_URL]
    assert entry["latest"] == "1.8.3"
    assert entry["channel"] == "stable"
    assert entry["prerelease"] is False


def test_latest_channel_lists_and_takes_the_prerelease(fake_github):
    manage.set_update_channel("latest")
    entry = manage.check_app_update()
    assert fake_github == [manage._APP_UPDATE_LIST_URL]
    assert entry["latest"] == "1.9.0-beta1"
    assert entry["channel"] == "latest"
    assert entry["prerelease"] is True


def test_switching_channel_invalidates_the_cached_answer(fake_github):
    manage.check_app_update()
    manage.check_app_update()  # fresh cache, same channel: no second call
    assert len(fake_github) == 1
    manage.set_update_channel("latest")
    entry = manage.check_app_update()
    # The stable answer is seconds old but belongs to the other channel.
    assert fake_github[-1] == manage._APP_UPDATE_LIST_URL
    assert entry["latest"] == "1.9.0-beta1"


def test_explicit_channel_argument_overrides_the_preference(fake_github):
    entry = manage.check_app_update(channel="latest")
    assert entry["channel"] == "latest"
    assert manage.get_update_channel() == "stable"  # unchanged on disk


def test_empty_latest_feed_is_an_error_not_a_crash(channel_env):
    channel_env.setattr(
        manage.urllib.request,
        "urlopen",
        lambda *a, **k: _FakeResponse([]),
    )
    manage.set_update_channel("latest")
    entry = manage.check_app_update()
    assert entry.get("error") is True
    assert not entry.get("latest")


@pytest.mark.parametrize("channel", ["stable", "latest"])
def test_offline_kills_every_channel(fake_github, channel_env, channel):
    manage.set_update_channel(channel)
    channel_env.setenv("ZIMI_OFFLINE", "1")
    assert manage.check_app_update().get("offline") is True
    assert manage.check_app_update(force=True, channel="latest").get("offline") is True
    assert fake_github == []


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@pytest.fixture
def endpoint_env(fake_github, channel_env):
    channel_env.setattr(server, "ZIMI_MANAGE", True)
    channel_env.setattr(manage, "_manage_auth_challenge", lambda h: None)
    return fake_github


def _hit(path, method="GET", data=None):
    h = MagicMock()
    captured = {}

    def _json(status, payload):
        captured["status"] = status
        captured["payload"] = payload

    h._json = _json
    parsed = MagicMock()
    parsed.path = path
    if method == "GET":
        manage.handle_manage_get(h, parsed, {})
    else:
        manage.handle_manage_post(h, parsed, data or {})
    return captured["status"], captured["payload"]


def test_get_payload_carries_channel_state(endpoint_env):
    status, body = _hit("/manage/app-update")
    assert status == 200
    assert body["channel"] == "stable"
    assert body["channels"] == ["stable", "latest"]
    assert body["channel_locked"] is False
    assert body["channel_env"] == "ZIMI_UPDATE_CHANNEL"
    assert body["prerelease"] is False


def test_post_switches_channel_and_returns_the_new_state(endpoint_env):
    _hit("/manage/app-update")
    status, body = _hit(
        "/manage/app-update-channel", method="POST", data={"channel": "latest"}
    )
    assert status == 200
    assert body["channel"] == "latest"
    assert body["latest"] == "1.9.0-beta1"
    assert body["prerelease"] is True
    assert manage.get_update_channel() == "latest"


@pytest.mark.parametrize("bad", [{"channel": "nightly"}, {}, {"channel": ""}])
def test_post_rejects_unknown_channels(endpoint_env, bad):
    status, body = _hit("/manage/app-update-channel", method="POST", data=bad)
    assert status == 400
    assert "error" in body
    assert manage.get_update_channel() == "stable"


def test_post_refuses_when_env_locked(endpoint_env, channel_env):
    channel_env.setenv(manage.APP_UPDATE_CHANNEL_ENV, "stable")
    status, body = _hit(
        "/manage/app-update-channel", method="POST", data={"channel": "latest"}
    )
    assert status == 403
    assert manage.APP_UPDATE_CHANNEL_ENV in body["error"]
    assert manage.get_update_channel() == "stable"


def test_locked_env_is_reported_to_the_ui(endpoint_env, channel_env):
    channel_env.setenv(manage.APP_UPDATE_CHANNEL_ENV, "beta")  # alias for latest
    status, body = _hit("/manage/app-update")
    assert status == 200
    assert body["channel"] == "latest"
    assert body["channel_locked"] is True
