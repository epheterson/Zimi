"""Update delay: only offer a release once it has been public for N days.

The point is fleet hygiene — let someone else find the sharp edges first. It
composes with the channel rather than replacing it: a held release is still
KNOWN (the payload names it and says when it will be offered), it is just not
offered yet.

Two things this must never do: freeze a "too fresh" verdict in the cache past
the maturity date, and hide a release forever because GitHub omitted a
publish date.
"""

import json
import os
import sys
import time
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402

_DAY = 86400


# ---------------------------------------------------------------------------
# The setting: env > saved preference > 0
# ---------------------------------------------------------------------------


@pytest.fixture
def delay_env(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv(manage.APP_UPDATE_DELAY_ENV, raising=False)
    monkeypatch.delenv(manage.APP_UPDATE_CHANNEL_ENV, raising=False)
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    return monkeypatch


@pytest.mark.parametrize(
    "raw,expected",
    [
        (0, 0),
        (7, 7),
        ("3", 3),
        ("  14  ", 14),
        (manage.APP_UPDATE_DELAY_MAX, manage.APP_UPDATE_DELAY_MAX),
        (manage.APP_UPDATE_DELAY_MAX + 1, None),
        (-1, None),  # a negative delay is a time machine, not a setting
        (1.5, None),
        ("soon", None),
        ("", None),
        (None, None),
        (True, None),  # True is not "1 day"
    ],
)
def test_normalize_update_delay_days(raw, expected):
    assert manage.normalize_update_delay_days(raw) == expected


def test_default_delay_is_zero(delay_env):
    assert manage.get_update_delay_days() == 0
    assert manage.is_update_delay_env_locked() is False


def test_saved_delay_survives(delay_env, tmp_path):
    assert manage.set_update_delay_days(7) == (7, None)
    assert manage.get_update_delay_days() == 7
    saved = json.load(open(os.path.join(str(tmp_path), "app_update_channel.json")))
    assert saved["delay_days"] == 7


def test_channel_and_delay_share_a_file_without_clobbering(delay_env):
    manage.set_update_channel("beta")
    manage.set_update_delay_days(3)
    assert manage.get_update_channel() == "beta"
    assert manage.get_update_delay_days() == 3
    manage.set_update_channel("latest")
    assert manage.get_update_delay_days() == 3  # the delay survived the write


def test_env_beats_saved_delay_and_locks_it(delay_env):
    manage.set_update_delay_days(3)
    delay_env.setenv(manage.APP_UPDATE_DELAY_ENV, "14")
    assert manage.get_update_delay_days() == 14
    assert manage.is_update_delay_env_locked() is True
    assert manage.set_update_delay_days(1) == (None, "env_locked")


def test_junk_env_falls_back_and_does_not_lock(delay_env):
    delay_env.setenv(manage.APP_UPDATE_DELAY_ENV, "soonish")
    assert manage.get_update_delay_days() == 0
    assert manage.is_update_delay_env_locked() is False
    assert manage.set_update_delay_days(1)[0] == 1


def test_junk_delay_is_rejected(delay_env):
    assert manage.set_update_delay_days("later") == (None, "invalid_delay")
    assert manage.get_update_delay_days() == 0


# ---------------------------------------------------------------------------
# Maturity arithmetic
# ---------------------------------------------------------------------------


def test_hold_until_is_none_without_a_delay():
    assert manage._update_hold_until(time.time(), 0) is None


def test_hold_until_is_none_without_a_publish_date():
    # No stamp, no way to age it — offer it rather than hide it forever.
    assert manage._update_hold_until(None, 30) is None


def test_fresh_release_is_held_until_its_maturity_date():
    now = 1_800_000_000.0
    published = now - 1 * _DAY
    assert manage._update_hold_until(published, 3, now=now) == published + 3 * _DAY


def test_matured_release_is_not_held():
    now = 1_800_000_000.0
    assert manage._update_hold_until(now - 4 * _DAY, 3, now=now) is None


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("2026-08-01T12:00:00Z", 1785585600.0),
        ("2026-08-01T12:00:00+00:00", 1785585600.0),
        ("2026-08-01T14:00:00+02:00", 1785585600.0),  # same instant, other zone
        ("", None),
        ("whenever", None),
        (None, None),
        (12345, None),
    ],
)
def test_parse_release_timestamp(raw, expected):
    assert manage._parse_release_timestamp(raw) == expected


# ---------------------------------------------------------------------------
# End to end through the payload
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _release(published_ts, tag="v9.9.9"):
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(published_ts))
    return {"tag_name": tag, "html_url": "https://x/rel", "published_at": stamp}


@pytest.fixture
def fake_github(delay_env):
    """A newer release, published `age_days` ago. Tests set the age."""
    state = {"age_days": 0.0, "calls": []}

    def fake_urlopen(req, timeout=None, context=None):
        state["calls"].append(req.full_url)
        rel = _release(time.time() - state["age_days"] * _DAY)
        # The beta channel reads the /releases list; latest reads one release.
        return _FakeResponse(rel if req.full_url == manage._APP_UPDATE_URL else [rel])

    delay_env.setattr(manage.urllib.request, "urlopen", fake_urlopen)
    delay_env.setattr(server, "ZIMI_MANAGE", True)
    delay_env.setattr(manage, "_manage_auth_challenge", lambda h: None)
    return state


def _payload(force=False):
    return manage._app_update_payload(force=force)


def test_zero_delay_offers_a_release_published_seconds_ago(fake_github):
    body = _payload()
    assert body["latest"] == "9.9.9"
    assert body["update_available"] is True
    assert body["update_held"] is False
    assert body["held_until"] is None
    assert body["delay_days"] == 0


def test_delay_defers_a_fresh_release_but_still_names_it(fake_github):
    manage.set_update_delay_days(3)
    body = _payload()
    assert body["latest"] == "9.9.9"  # the UI can say "1.9.1 is out…"
    assert body["update_available"] is False
    assert body["update_held"] is True
    assert body["held_until"] > time.time()
    assert body["held_until"] <= time.time() + 3 * _DAY


def test_delay_lets_a_matured_release_through(fake_github):
    fake_github["age_days"] = 5
    manage.set_update_delay_days(3)
    body = _payload()
    assert body["update_available"] is True
    assert body["update_held"] is False


def test_the_cache_does_not_freeze_a_too_fresh_verdict(fake_github, tmp_path):
    """The held verdict is recomputed on every read. Age the CACHED release
    past the delay without re-fetching: the same cache entry must now offer
    the update."""
    manage.set_update_delay_days(3)
    assert _payload()["update_held"] is True
    assert len(fake_github["calls"]) == 1

    path = os.path.join(str(tmp_path), "app_update.json")
    entry = json.load(open(path))
    entry["published_ts"] -= 4 * _DAY
    with open(path, "w") as f:
        json.dump(entry, f)

    body = _payload()
    assert len(fake_github["calls"]) == 1  # still the cached answer
    assert body["update_available"] is True
    assert body["update_held"] is False


def test_a_release_without_a_publish_date_is_never_held(fake_github, delay_env):
    delay_env.setattr(
        manage.urllib.request,
        "urlopen",
        lambda *a, **k: _FakeResponse({"tag_name": "v9.9.9", "html_url": "https://x"}),
    )
    manage.set_update_delay_days(30)
    body = _payload()
    assert body["update_available"] is True
    assert body["update_held"] is False


def test_delay_composes_with_the_beta_channel(fake_github):
    manage.set_update_channel("beta")
    manage.set_update_delay_days(3)
    body = _payload()
    assert body["channel"] == "beta"
    assert body["update_held"] is True
    assert fake_github["calls"] == [manage._APP_UPDATE_LIST_URL]


def test_no_update_at_all_is_never_reported_as_held(fake_github, delay_env):
    delay_env.setattr(
        manage.urllib.request,
        "urlopen",
        lambda *a, **k: _FakeResponse(_release(time.time(), "v" + server.ZIMI_VERSION)),
    )
    manage.set_update_delay_days(7)
    body = _payload()
    assert body["update_available"] is False
    assert body["update_held"] is False  # nothing to hold


def test_offline_kills_the_delay_path_too(fake_github, delay_env):
    manage.set_update_delay_days(7)
    delay_env.setenv("ZIMI_OFFLINE", "1")
    body = _payload()
    assert body["offline"] is True
    assert body["update_available"] is False
    assert body["update_held"] is False
    assert fake_github["calls"] == []


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


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


def test_get_payload_carries_the_delay_state(fake_github):
    status, body = _hit("/manage/app-update")
    assert status == 200
    assert body["delay_days"] == 0
    assert body["delay_days_locked"] is False
    assert body["delay_env"] == "ZIMI_UPDATE_DELAY_DAYS"
    assert body["delay_choices"] == list(manage.APP_UPDATE_DELAY_CHOICES)


def test_post_sets_the_delay_and_returns_the_new_state(fake_github):
    status, body = _hit(
        "/manage/app-update-delay", method="POST", data={"delay_days": 3}
    )
    assert status == 200
    assert body["delay_days"] == 3
    assert body["update_held"] is True
    assert manage.get_update_delay_days() == 3


@pytest.mark.parametrize("bad", [{"delay_days": "soon"}, {}, {"delay_days": -1}])
def test_post_rejects_junk_delays(fake_github, bad):
    status, body = _hit("/manage/app-update-delay", method="POST", data=bad)
    assert status == 400
    assert "error" in body
    assert manage.get_update_delay_days() == 0


def test_post_refuses_when_env_locked(fake_github, delay_env):
    delay_env.setenv(manage.APP_UPDATE_DELAY_ENV, "7")
    status, body = _hit(
        "/manage/app-update-delay", method="POST", data={"delay_days": 1}
    )
    assert status == 403
    assert manage.APP_UPDATE_DELAY_ENV in body["error"]
    assert manage.get_update_delay_days() == 7
