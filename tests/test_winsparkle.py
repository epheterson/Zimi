"""Tests for the WinSparkle auto-update bridge (zimi_winsparkle).

These run on every platform. The interesting off-Windows contract is that the
module is a clean no-op — no DLL, no exceptions — mirroring the mac Sparkle
soft-fail path. The appcast-validity and key-drift checks are platform-neutral.
"""

import os
import platform
import re
import sys
import xml.etree.ElementTree as ET

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESKTOP_DIR = os.path.join(REPO_ROOT, "desktop")
sys.path.insert(0, DESKTOP_DIR)

import zimi_winsparkle as ws  # noqa: E402

# ── Off-Windows no-op contract ──────────────────────────────────────────────


@pytest.mark.skipif(platform.system() == "Windows", reason="no-op path is off-Windows")
def test_find_dll_none_off_windows():
    assert ws._find_dll() is None


@pytest.mark.skipif(platform.system() == "Windows", reason="no-op path is off-Windows")
def test_init_updater_clean_noop_when_dll_absent():
    # Must return False without raising and without loading anything.
    assert ws.init_updater("1.8.0") is False
    assert ws._dll is None


def test_check_and_cleanup_safe_when_uninitialized():
    # No updater loaded → manual check is a no-op, cleanup never raises.
    assert ws.check_update_with_ui() is False
    ws.cleanup()  # should not raise


# ── Configuration invariants ────────────────────────────────────────────────


def test_eddsa_public_key_is_base64_ed25519():
    # 32-byte ed25519 key → 44 base64 chars ending in '='.
    key = ws.WINSPARKLE_EDDSA_PUBLIC_KEY
    assert re.fullmatch(r"[A-Za-z0-9+/]{43}=", key), key


def test_appcast_url_matches_mac_feed_pattern():
    url = ws.WINDOWS_APPCAST_URL
    assert url.startswith("https://raw.githubusercontent.com/epheterson/Zimi/main/")
    assert url.endswith("appcast-windows.xml")


# ── Appcast URL override (ZIMI_APPCAST_URL) ─────────────────────────────────


def test_resolve_appcast_url_defaults_to_production(monkeypatch):
    monkeypatch.delenv("ZIMI_APPCAST_URL", raising=False)
    assert ws._resolve_appcast_url() == ws.WINDOWS_APPCAST_URL


def test_resolve_appcast_url_honors_env_override(monkeypatch):
    monkeypatch.setenv("ZIMI_APPCAST_URL", "http://localhost:8000/appcast-test.xml")
    assert ws._resolve_appcast_url() == "http://localhost:8000/appcast-test.xml"


def test_resolve_appcast_url_explicit_arg_wins_over_env(monkeypatch):
    # An explicit caller argument beats the env override.
    monkeypatch.setenv("ZIMI_APPCAST_URL", "http://localhost:8000/appcast-test.xml")
    assert ws._resolve_appcast_url("https://example.com/x.xml") == (
        "https://example.com/x.xml"
    )


@pytest.mark.skipif(platform.system() == "Windows", reason="no-op path is off-Windows")
def test_init_updater_noop_even_with_env_override(monkeypatch):
    # The override changes the feed URL, never the off-Windows soft-fail contract.
    monkeypatch.setenv("ZIMI_APPCAST_URL", "http://localhost:8000/appcast-test.xml")
    assert ws.init_updater("1.8.0") is False
    assert ws._dll is None


def test_eddsa_key_matches_sparkle_spec_key():
    """WinSparkle reuses the macOS Sparkle keypair — guard against drift."""
    spec = open(os.path.join(DESKTOP_DIR, "zimi_desktop.spec")).read()
    m = re.search(r"'SUPublicEDKey':\s*'([^']+)'", spec)
    assert m, "SUPublicEDKey not found in zimi_desktop.spec"
    assert ws.WINSPARKLE_EDDSA_PUBLIC_KEY == m.group(1)


# ── Appcast XML validity ────────────────────────────────────────────────────

SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle"


@pytest.mark.parametrize(
    "name", ["appcast-windows.xml", "appcast-arm64.xml", "appcast-intel.xml"]
)
def test_appcast_well_formed(name):
    tree = ET.parse(os.path.join(REPO_ROOT, name))
    root = tree.getroot()
    assert root.tag == "rss"
    channel = root.find("channel")
    assert channel is not None
    assert channel.findtext("title") == "Zimi Updates"
    # Any item present must carry a sparkle:version and a signed enclosure.
    for item in channel.findall("item"):
        assert item.find(f"{{{SPARKLE_NS}}}version") is not None
        enc = item.find("enclosure")
        assert enc is not None
        assert enc.get(f"{{{SPARKLE_NS}}}edSignature")
        assert enc.get("url", "").startswith(
            "https://github.com/epheterson/Zimi/releases/"
        )
