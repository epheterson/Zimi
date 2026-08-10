"""App update check (/manage/app-update) — the Zimi APPLICATION's own
release check, distinct from the ZIM-content "Auto-update" feature.

Covers: version compare (tag formats, prereleases), install-type detection
under faked signals, cache TTL behavior, and the ZIMI_OFFLINE contract
(zero network calls, ever).
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

# ---------------------------------------------------------------------------
# Version parsing / comparison
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "tag,expected",
    [
        ("v1.9.0", ((1, 9, 0), "")),
        ("1.9.0", ((1, 9, 0), "")),
        ("1.9", ((1, 9, 0), "")),  # padded so 1.9 == 1.9.0
        ("V2.0", ((2, 0, 0), "")),
        ("1.9.0-beta1", ((1, 9, 0), "beta1")),
        ("1.2.3.4", ((1, 2, 3, 4), "")),
        ("", None),
        ("garbage", None),
        ("v", None),
    ],
)
def test_parse_app_version(tag, expected):
    assert manage._parse_app_version(tag) == expected


@pytest.mark.parametrize(
    "remote,current,newer",
    [
        ("1.9.0", "1.8.2", True),
        ("v1.9.0", "1.8.2", True),  # GitHub tag format
        ("1.8.2", "1.8.2", False),
        ("v1.8.2", "1.8.2", False),
        ("1.8.1", "1.8.2", False),  # never suggest a downgrade
        ("1.9", "1.9.0", False),  # same version, different spelling
        ("1.10.0", "1.9.9", True),  # numeric, not lexicographic
        ("2.0", "1.99.99", True),
        ("1.9.0-beta1", "1.8.2", True),  # prerelease still beats older final
        ("1.9.0-beta1", "1.9.0", False),  # prerelease never beats its final
        ("1.9.0", "1.9.0-beta1", True),  # final beats its own prerelease
        ("1.9.0-rc2", "1.9.0-rc1", False),  # pre-vs-pre: conservative "no"
        ("garbage", "1.8.2", False),  # junk tag can't look like an update
        ("1.9.0", "unknown", False),
    ],
)
def test_app_version_newer(remote, current, newer):
    assert manage._app_version_newer(remote, current) is newer


# ---------------------------------------------------------------------------
# Install-type detection under faked signals
# ---------------------------------------------------------------------------


@pytest.fixture
def clean_signals(monkeypatch):
    """Neutralize every real signal so each test fakes exactly one."""
    for var in ("ZIMI_INSTALL_TYPE", "SNAP", "SNAP_NAME", "APPIMAGE", "container"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(manage.os.path, "exists", lambda p: False)
    monkeypatch.setattr(manage.sys, "frozen", False, raising=False)
    monkeypatch.setattr(manage.sys, "_MEIPASS", None, raising=False)
    monkeypatch.setattr(manage.sys, "prefix", "/usr/local/python")
    monkeypatch.setattr(manage.sys, "executable", "/usr/local/python/bin/python3")
    yield monkeypatch


def test_detect_fallback_is_pip(clean_signals):
    assert manage.detect_install_type() == "pip"


def test_detect_docker_via_dockerenv(clean_signals):
    clean_signals.setattr(manage.os.path, "exists", lambda p: p == "/.dockerenv")
    assert manage.detect_install_type() == "docker"


def test_detect_docker_via_containerenv(clean_signals):
    clean_signals.setattr(manage.os.path, "exists", lambda p: p == "/run/.containerenv")
    assert manage.detect_install_type() == "docker"


def test_detect_docker_via_container_env_var(clean_signals):
    clean_signals.setenv("container", "podman")
    assert manage.detect_install_type() == "docker"


def test_detect_snap(clean_signals):
    clean_signals.setenv("SNAP", "/snap/zimi/42")
    clean_signals.setenv("SNAP_NAME", "zimi")
    assert manage.detect_install_type() == "snap"


def test_detect_appimage(clean_signals):
    clean_signals.setenv("APPIMAGE", "/home/u/Zimi.AppImage")
    assert manage.detect_install_type() == "appimage"


@pytest.mark.parametrize(
    "platform,expected",
    [
        ("darwin", "desktop-mac"),
        ("win32", "desktop-windows"),
        ("linux", "desktop"),
    ],
)
def test_detect_frozen_desktop(clean_signals, platform, expected):
    clean_signals.setattr(manage.sys, "frozen", True, raising=False)
    clean_signals.setattr(manage.sys, "platform", platform)
    assert manage.detect_install_type() == expected


def test_detect_container_outranks_frozen(clean_signals):
    # The outermost wrapper decides how you upgrade.
    clean_signals.setattr(manage.sys, "frozen", True, raising=False)
    clean_signals.setattr(manage.os.path, "exists", lambda p: p == "/.dockerenv")
    assert manage.detect_install_type() == "docker"


@pytest.mark.parametrize(
    "prefix",
    [
        "/opt/homebrew/Cellar/zimi/1.9.0/libexec",
        "/usr/local/Cellar/python@3.12/3.12.1",
        "/home/linuxbrew/.linuxbrew/Cellar/python@3.12/3.12.1",
    ],
)
def test_detect_homebrew_paths(clean_signals, prefix):
    clean_signals.setattr(manage.sys, "prefix", prefix)
    assert manage.detect_install_type() == "homebrew"


def test_detect_explicit_override_wins(clean_signals):
    clean_signals.setenv("ZIMI_INSTALL_TYPE", "Docker")
    clean_signals.setattr(manage.sys, "frozen", True, raising=False)
    assert manage.detect_install_type() == "docker"


# ---------------------------------------------------------------------------
# check_app_update: caching + offline suppression
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


@pytest.fixture
def update_env(monkeypatch, tmp_path):
    """Isolated data dir + a urlopen spy that must be explicitly armed."""
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    # Channel-free baseline: these tests pin the stable-channel behavior, so a
    # developer running with ZIMI_UPDATE_CHANNEL set must not change them.
    monkeypatch.delenv(manage.APP_UPDATE_CHANNEL_ENV, raising=False)
    calls = []

    def fake_urlopen(req, timeout=None, context=None):
        calls.append(req.full_url)
        return _FakeResponse({"tag_name": "v9.9.9", "html_url": "https://x/rel"})

    monkeypatch.setattr(manage.urllib.request, "urlopen", fake_urlopen)
    return calls


def _cache_path(tmp_path):
    return os.path.join(str(tmp_path), "app_update.json")


def test_stale_cache_triggers_one_fetch_and_persists(update_env, tmp_path):
    result = manage.check_app_update()
    assert update_env == [manage._APP_UPDATE_URL]
    assert result["latest"] == "9.9.9"  # "v" stripped for display
    on_disk = json.load(open(_cache_path(tmp_path)))
    assert on_disk["latest"] == "9.9.9"
    assert on_disk["url"] == "https://x/rel"


def test_fresh_cache_suppresses_network(update_env, tmp_path):
    manage.check_app_update()
    manage.check_app_update()
    manage.check_app_update()
    assert len(update_env) == 1  # daily TTL: one fetch serves them all


def test_force_bypasses_ttl_but_keeps_flood_guard(update_env):
    manage.check_app_update()
    manage.check_app_update(force=True)  # within 60s guard — no refetch
    assert len(update_env) == 1


def test_expired_cache_refetches(update_env, tmp_path, monkeypatch):
    manage.check_app_update()
    stale = json.load(open(_cache_path(tmp_path)))
    stale["checked_at"] = time.time() - manage._APP_UPDATE_TTL - 1
    with open(_cache_path(tmp_path), "w") as f:
        json.dump(stale, f)
    manage.check_app_update()
    assert len(update_env) == 2


def test_offline_never_touches_network(update_env, monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    result = manage.check_app_update()
    assert update_env == []
    assert result.get("offline") is True


def test_offline_outranks_force(update_env, monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    manage.check_app_update(force=True)
    assert update_env == []


def test_network_failure_is_silent_and_backed_off(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    calls = []

    def boom(req, timeout=None, context=None):
        calls.append(1)
        raise OSError("no route to host")

    monkeypatch.setattr(manage.urllib.request, "urlopen", boom)
    result = manage.check_app_update()  # must not raise
    assert result.get("error") is True
    manage.check_app_update()  # error TTL: no immediate re-probe
    assert len(calls) == 1


# ---------------------------------------------------------------------------
# Endpoint plumbing (same MagicMock-handler pattern as test_updates_endpoint)
# ---------------------------------------------------------------------------


@pytest.fixture
def endpoint_env(update_env, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_MANAGE", True)
    monkeypatch.setattr(manage, "_manage_auth_challenge", lambda h: None)
    return update_env


def _hit(path, method="GET"):
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
        manage.handle_manage_post(h, parsed, {})
    return captured["status"], captured["payload"]


def test_get_endpoint_payload_shape(endpoint_env):
    status, body = _hit("/manage/app-update")
    assert status == 200
    assert body["current"] == server.ZIMI_VERSION
    assert body["latest"] == "9.9.9"
    assert body["update_available"] is True
    assert body["install_type"]
    assert body["releases_url"] == "https://x/rel"
    assert body["offline"] is False


def test_get_endpoint_up_to_date(endpoint_env, monkeypatch, tmp_path):
    # Fake a cached answer equal to the running version: quiet, no update.
    monkeypatch.setattr(
        manage.urllib.request,
        "urlopen",
        lambda *a, **k: _FakeResponse({"tag_name": "v" + server.ZIMI_VERSION}),
    )
    status, body = _hit("/manage/app-update")
    assert status == 200
    assert body["update_available"] is False


def test_post_check_now_forces_within_guard_window(endpoint_env):
    _hit("/manage/app-update")
    status, body = _hit("/manage/app-update-check", method="POST")
    assert status == 200
    # Guard window: the forced check reuses the seconds-old answer.
    assert len(endpoint_env) == 1
    assert body["update_available"] is True


def test_get_endpoint_offline(endpoint_env, monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    status, body = _hit("/manage/app-update")
    assert status == 200
    assert body["offline"] is True
    assert endpoint_env == []
