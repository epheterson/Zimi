#!/usr/bin/env python3
"""
WinSparkle auto-update bridge (Windows only).

Mirrors the macOS Sparkle integration in ``zimi_desktop.py``. WinSparkle is a
C DLL (winsparkle.org) driven here through ``ctypes`` — no pip dependency, no
build step. The DLL is bundled next to the app by the PyInstaller spec on
Windows; everywhere else this module is an inert no-op.

Design contract (matches the mac side):
  * EdDSA (Ed25519) signatures, verified by WinSparkle against the SAME public
    key Sparkle uses (``WINSPARKLE_EDDSA_PUBLIC_KEY``). WinSparkle's signing and
    verification are wire-compatible with Sparkle's ``sign_update`` tool, so the
    release pipeline signs the Windows enclosure with the same private key.
  * Windows-specific appcast (``appcast-windows.xml``) on the same host/path
    pattern as the mac per-arch feeds, whose enclosure points at the Inno Setup
    installer attached to the GitHub release.
  * Automatic check-on-launch. pywebview's Edge WebView2 backend has no native
    menu bar, so — unlike the mac app's "Check for Updates…" menu item — the
    Windows app relies on WinSparkle's automatic check plus an explicit
    launch-time check. :func:`check_update_with_ui` is exposed so the web UI can
    offer a manual "Check for updates" button later.

Everything soft-fails: a missing/unloadable DLL logs once and the app runs with
no updater, exactly like the mac side when ``Sparkle.framework`` is absent.
"""

import ctypes
import os
import platform
import sys

# Same Ed25519 public key as the macOS Sparkle feed (see zimi_desktop.spec
# `SUPublicEDKey`). Reused verbatim because WinSparkle's EdDSA verification is
# compatible with Sparkle's — one keypair signs both platforms' enclosures.
WINSPARKLE_EDDSA_PUBLIC_KEY = "YPy3VF5Yv4ajGgz3HKvkeBOqhTkZXZyoFYsLhLq9Cpc="

# Windows appcast, same host/path convention as appcast-{arm64,intel}.xml.
WINDOWS_APPCAST_URL = (
    "https://raw.githubusercontent.com/epheterson/Zimi/main/appcast-windows.xml"
)

# WinSparkle stores its check state (last-check time, skipped versions) here.
_REGISTRY_PATH = b"Software\\Zimi\\WinSparkle"

# Bundled DLL basename (see zimi_desktop.spec win32 branch).
_DLL_NAME = "WinSparkle.dll"

# Module-level handle kept alive for the process lifetime. WinSparkle runs its
# own background thread + message loop; the DLL must not be GC'd/unloaded.
_dll = None
_logged = False


def _log_once(msg):
    """Emit an updater diagnostic at most once (parity with mac's print)."""
    global _logged
    if not _logged:
        _logged = True
        print(f"WinSparkle: {msg}")


def _find_dll():
    """Locate WinSparkle.dll. Returns a path, or None if unavailable.

    Only searches on Windows — on every other platform there is no ``WinDLL``
    and no ``.dll`` to load, so this returns None and the whole module no-ops.
    """
    if platform.system() != "Windows":
        return None
    candidates = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        # PyInstaller bundle: spec adds the DLL at bundle root.
        candidates.append(os.path.join(meipass, _DLL_NAME))
    # Dev mode / alongside the script or executable.
    candidates.append(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), _DLL_NAME)
    )
    candidates.append(
        os.path.join(os.path.dirname(os.path.abspath(sys.executable)), _DLL_NAME)
    )
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def _bind_signatures(dll):
    """Declare argtypes so ctypes marshals wchar_t*/char* args correctly."""
    dll.win_sparkle_set_appcast_url.argtypes = [ctypes.c_char_p]
    dll.win_sparkle_set_app_details.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_wchar_p,
        ctypes.c_wchar_p,
    ]
    dll.win_sparkle_set_eddsa_public_key.argtypes = [ctypes.c_char_p]
    dll.win_sparkle_set_eddsa_public_key.restype = ctypes.c_int
    dll.win_sparkle_set_registry_path.argtypes = [ctypes.c_char_p]
    dll.win_sparkle_set_automatic_check_for_updates.argtypes = [ctypes.c_int]
    # init / cleanup / check_* take no args and return void — ctypes defaults fine.


def init_updater(
    version, appcast_url=WINDOWS_APPCAST_URL, pubkey=WINSPARKLE_EDDSA_PUBLIC_KEY
):
    """Initialize WinSparkle and kick off a launch-time update check.

    Returns True if the updater started, False (clean no-op) otherwise — on a
    non-Windows host, a missing DLL, or any load/call error. Safe to call from a
    background thread: WinSparkle spawns its own thread and message loop.
    """
    global _dll
    dll_path = _find_dll()
    if not dll_path:
        _log_once("DLL not found — running without auto-update")
        return False
    try:
        dll = ctypes.WinDLL(dll_path)
        _bind_signatures(dll)

        dll.win_sparkle_set_app_details("Zimi", "Zimi", str(version))
        dll.win_sparkle_set_appcast_url(appcast_url.encode("utf-8"))
        dll.win_sparkle_set_registry_path(_REGISTRY_PATH)
        if dll.win_sparkle_set_eddsa_public_key(pubkey.encode("ascii")) != 1:
            # Key rejected — refuse to run an unverified updater.
            _log_once("EdDSA public key rejected — auto-update disabled")
            return False
        # Automatic check + explicit launch check ≈ Sparkle startingUpdater=True.
        dll.win_sparkle_set_automatic_check_for_updates(1)
        dll.win_sparkle_init()
        dll.win_sparkle_check_update_without_ui()

        _dll = dll  # keep alive
        return True
    except Exception as e:  # noqa: BLE001 — updater is best-effort, never fatal
        _log_once(f"init failed: {e}")
        return False


def check_update_with_ui():
    """Manual "Check for updates" — shows WinSparkle's UI. No-op if uninitialized."""
    if _dll is None:
        return False
    try:
        _dll.win_sparkle_check_update_with_ui()
        return True
    except Exception as e:  # noqa: BLE001
        _log_once(f"check failed: {e}")
        return False


def cleanup():
    """Shut down WinSparkle's thread. Safe to call when never initialized."""
    if _dll is None:
        return
    try:
        _dll.win_sparkle_cleanup()
    except Exception:  # noqa: BLE001
        pass
