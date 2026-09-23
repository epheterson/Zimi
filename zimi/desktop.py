#!/usr/bin/env python3
"""
Zimi Desktop — Native desktop app for Zimi knowledge server.

Embeds the Zimi web UI in a native window via pywebview (WebKit on macOS,
Edge WebView2 on Windows). Config managed through JS-Python bridge.
"""

import json
import os
import platform
import socket
import subprocess
import sys
import threading

# ---------------------------------------------------------------------------
# Windows: force pythonnet onto the .NET Framework runtime BEFORE any import
# that triggers pywebview → pythonnet (must run before `import webview`).
#
# pywebview's Windows backend (edgechromium/winforms) hosts the WebView2
# control inside a System.Windows.Forms window and does
# `clr.AddReference('System.Windows.Forms')`. WinForms is a .NET Framework
# desktop assembly that lives in the GAC and always resolves under the netfx
# runtime — every Windows box ships .NET Framework 4.x. Under CoreCLR the base
# runtime has no desktop assemblies, so in a frozen app the reference resolves
# to a null-token AssemblyName and fails with:
#   Could not load file or assembly 'System.Windows.Forms, PublicKeyToken=null'
# which surfaces to the user as an unhandled-exception launch crash.
# ---------------------------------------------------------------------------
if platform.system() == "Windows":
    os.environ.setdefault("PYTHONNET_RUNTIME", "netfx")


# ---------------------------------------------------------------------------
# Linux: the native window is WebKitGTK, which the bundle does not carry.
#
# Issue #81 (six distros, every 1.8 to 1.9.6 build): "Namespace WebKit2 not
# available", or a black window. Two causes. PyInstaller has no hook for
# WebKit2, so the bundle never carried its typelib, and its runtime hook
# points GObject introspection at the bundle alone: the window could not
# come up on any machine (CI only ever smoke-tested the headless server).
# The spec now bundles the typelibs, and this block lets introspection see
# the host's own as well, so a distro's WebKitGTK is found whichever
# version it ships. The black window is WebKitGTK's DMA-BUF renderer under
# some drivers; the two escape hatches WebKit documents are set unless the
# person set them. And when no WebKitGTK or Qt is there at all, the app
# runs in the system browser (see _run_in_browser) rather than dying.
# ---------------------------------------------------------------------------
_HOST_TYPELIB_DIRS = (
    "/usr/lib/x86_64-linux-gnu/girepository-1.0",
    "/usr/lib/aarch64-linux-gnu/girepository-1.0",
    "/usr/lib64/girepository-1.0",
    "/usr/lib/girepository-1.0",
    "/usr/local/lib/girepository-1.0",
)


def _linux_environment(env, frozen, typelib_dirs=_HOST_TYPELIB_DIRS, isdir=os.path.isdir):
    """The environment a Linux launch wants. Returns what it changed."""
    changed = {}
    for key in ("WEBKIT_DISABLE_DMABUF_RENDERER", "WEBKIT_DISABLE_COMPOSITING_MODE"):
        if key not in env:
            env[key] = changed[key] = "1"
    # Inside a snap the GNOME extension has already wired GTK, WebKitGTK and
    # their data: LD_LIBRARY_PATH, GI_TYPELIB_PATH, the pixbuf loaders, the
    # schemas and the GIO modules all point into the platform snap. Every
    # line below would take that apart — clear the library path, delete the
    # three data vars, and put the base image's typelib dirs first, where
    # WebKit2 does not exist. The window then cannot open, the launch falls
    # back to the browser, and a confined snap has no browser to open: the
    # snap did nothing at all and said nothing either (issue #81, 1.10.0).
    # And inside a snap, WebKit asks the desktop portal whether the network
    # can be reached before it loads even 127.0.0.1; a confined snap is told
    # "This call is not available inside the sandbox", the load fails, and
    # WebKit shows that sentence on a black window (issue #81, 1.10.1, Xubuntu
    # and Mint). GLib's own monitor answers without the portal.
    if env.get("SNAP_NAME") and "GIO_USE_NETWORK_MONITOR" not in env:
        env["GIO_USE_NETWORK_MONITOR"] = changed["GIO_USE_NETWORK_MONITOR"] = "base"
    if frozen and not env.get("SNAP_NAME"):
        # The bundle carries no GLib, GTK or WebKit of its own on Linux (see
        # the spec): the host's are the ones that match the host's WebKitGTK
        # and drivers. So the host's typelibs come first (a fallback copy
        # rides in the bundle for a host without its gir packages), the
        # host's own pixbuf loaders and schemas are used rather than ones
        # compiled for the build machine, and WebKitGTK's helper processes,
        # which are host executables, are not handed the bundle's library
        # path: the black window was the host's WebKitWebProcess loading
        # the bundle's older GLib through an inherited LD_LIBRARY_PATH.
        if "LD_LIBRARY_PATH_ORIG" in env:
            env["LD_LIBRARY_PATH"] = changed["LD_LIBRARY_PATH"] = env["LD_LIBRARY_PATH_ORIG"]
        elif "LD_LIBRARY_PATH" in env:
            del env["LD_LIBRARY_PATH"]
            changed["LD_LIBRARY_PATH"] = ""
        for key in ("GDK_PIXBUF_MODULE_FILE", "GSETTINGS_SCHEMA_DIR", "GIO_MODULE_DIR"):
            if key in env:
                del env[key]
                changed[key] = ""
        bundled = [d for d in env.get("GI_TYPELIB_PATH", "").split(os.pathsep) if d]
        host = [d for d in typelib_dirs if isdir(d) and d not in bundled]
        if host or bundled:
            env["GI_TYPELIB_PATH"] = changed["GI_TYPELIB_PATH"] = os.pathsep.join(host + bundled)
    return changed


# WebKitGTK comes in two ABIs. pywebview asks introspection for 4.1 first
# and takes 4.0 only when the 4.1 typelib is absent, but the bundle carries
# both typelibs, so on a host with only the 4.0 library it would pick 4.1
# and fail loading the library. The library the host has decides.
_WEBKIT_ABIS = (("4.1", "3.0", "libwebkit2gtk-4.1.so.0"), ("4.0", "2.4", "libwebkit2gtk-4.0.so.37"))


def _host_webkit(loadable=None):
    """``(webkit_version, soup_version)`` of the WebKitGTK the host can
    load, or None."""
    if loadable is None:
        import ctypes

        def loadable(soname):
            try:
                ctypes.CDLL(soname)
                return True
            except OSError:
                return False

    for webkit, soup, soname in _WEBKIT_ABIS:
        if loadable(soname):
            return webkit, soup
    return None


_DETECT = object()


def _pin_webkit_version(require_version=None, host=_DETECT):
    """Tell introspection which WebKit2 and Soup to use before pywebview
    asks, so its own ask agrees with the host. Returns the pin, or None.
    ``host`` is the ABI pair to pin (None: the host has no WebKitGTK), or
    left alone to look."""
    pin = _host_webkit() if host is _DETECT else host
    if not pin:
        return None
    if require_version is None:
        try:
            import gi

            require_version = gi.require_version
        except Exception:
            return None
    try:
        require_version("WebKit2", pin[0])
        require_version("Soup", pin[1])
    except Exception:
        return None
    return pin


if platform.system() == "Linux":
    _linux_environment(os.environ, bool(getattr(sys, "frozen", False)))


def _browser_mode_requested(argv=None, env=None):
    """``--browser`` or ZIMI_DESKTOP_BROWSER=1: the system browser instead
    of a native window, on purpose."""
    argv = sys.argv if argv is None else argv
    env = os.environ if env is None else env
    return "--browser" in argv or str(env.get("ZIMI_DESKTOP_BROWSER", "")).strip().lower() in ("1", "true", "yes", "on")


def _native_window_available(import_module=None):
    """Whether pywebview has a backend here: ``(True, "")`` or ``(False,
    why)``. On Linux that is WebKitGTK through PyGObject, or Qt; elsewhere
    the platform always has one."""
    if platform.system() != "Linux":
        return True, ""
    import importlib
    import logging

    # pywebview logs a full traceback per backend it cannot load; one line
    # from us says the same thing.
    logging.getLogger("pywebview").setLevel(logging.CRITICAL)
    if import_module is None:
        _pin_webkit_version()
    load = import_module or importlib.import_module
    first = "qt" if os.environ.get("PYWEBVIEW_GUI", "").lower() == "qt" else "gtk"
    errors = []
    for name in (first, "gtk" if first == "qt" else "qt"):
        try:
            load("webview.platforms." + name)
            return True, ""
        except Exception as e:  # ImportError, ValueError from gi, anything a backend raises
            errors.append("%s: %s" % (name, (str(e).strip().splitlines() or ["?"])[-1]))
    return False, "no WebKitGTK or Qt for a native window (%s)" % "; ".join(errors)


# ---------------------------------------------------------------------------
# Windows, portable zip: files extracted from a downloaded zip carry the
# "mark of the web" (a Zone.Identifier stream), and the .NET Framework refuses
# to load an assembly that has one. pythonnet's Python.Runtime.dll is such an
# assembly, so the frozen app died on its first import with
#   Failed to resolve Python.Runtime.Loader.Initialize from ...\_internal\...
# (Spudlads on r/Kiwix, 1.9.5, Zimi-windows-x64.zip). The installer never had
# the problem: Inno Setup writes files without the mark. Strip the mark from
# every library we ship before .NET sees one. Deleting the stream is the same
# thing Explorer's "Unblock" does.
# ---------------------------------------------------------------------------
_MARK_OF_THE_WEB = ":Zone.Identifier"


def _unblock_bundled_libraries(root):
    """Remove the mark of the web from the .dll/.exe files under ``root``.

    Returns how many were unblocked. Never raises: a file that cannot be
    unblocked is left for the loader to complain about, as before."""
    if platform.system() != "Windows" or not root or not os.path.isdir(root):
        return 0
    count = 0
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if not name.lower().endswith((".dll", ".exe")):
                continue
            try:
                os.remove(os.path.join(dirpath, name) + _MARK_OF_THE_WEB)
                count += 1
            except OSError:
                pass  # no stream, or not ours to remove
    return count


# ZIMI_DESKTOP_KEEP_MARK=1 leaves the mark in place. Only CI sets it: the
# control run that proves a marked bundle really does fail to start, so the
# passing run after it means something.
if (
    platform.system() == "Windows"
    and getattr(sys, "frozen", False)
    and os.environ.get("ZIMI_DESKTOP_KEEP_MARK") != "1"
):
    # Said out loud, count included: a zero here next to the pythonnet crash
    # is the difference between "the fix ran and found nothing" and "the fix
    # never ran". The bundle has no console, but CI and a terminal launch do.
    _unblocked = _unblock_bundled_libraries(getattr(sys, "_MEIPASS", None))
    print(
        "mark of the web: cleared from %d libraries under %s"
        % (_unblocked, getattr(sys, "_MEIPASS", None)),
        file=sys.stderr,
        flush=True,
    )


# ---------------------------------------------------------------------------
# Icon path — resolve relative to this script (works in dev and PyInstaller)
# ---------------------------------------------------------------------------


def _icon_path():
    """Find the app icon, handling both dev and PyInstaller bundle paths."""
    if getattr(sys, "_MEIPASS", None):
        # PyInstaller bundle: assets are at _MEIPASS/zimi/assets/
        base = os.path.join(sys._MEIPASS, "zimi")
    else:
        # Dev mode: this module lives in the zimi/ package beside assets/
        base = os.path.dirname(os.path.abspath(__file__))
    png = os.path.join(base, "assets", "icon.png")
    return png if os.path.exists(png) else None


# ---------------------------------------------------------------------------
# ConfigManager — cross-platform persistent config
# ---------------------------------------------------------------------------


def _config_dir():
    """Platform-appropriate config directory."""
    system = platform.system()
    if system == "Darwin":
        return os.path.join(
            os.path.expanduser("~"), "Library", "Application Support", "Zimi"
        )
    elif system == "Windows":
        return os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "Zimi")
    else:  # Linux / other
        xdg = os.environ.get(
            "XDG_CONFIG_HOME", os.path.join(os.path.expanduser("~"), ".config")
        )
        return os.path.join(xdg, "zimi")


def _user_home():
    """The person's home folder. Inside a snap $HOME is the snap's own
    per-revision folder (~/snap/zimi/22), so the default library landed
    there, somewhere nobody puts ZIMs and that moves with every update
    (issue #81 logs: "No ZIM files found in /home/asus/snap/zimi/22/Zimi").
    snapd names the real one."""
    return os.environ.get("SNAP_REAL_HOME") or os.path.expanduser("~")


class ConfigManager:
    """Read/write config.json with sensible defaults."""

    DEFAULTS = {
        "zim_dir": os.path.join(_user_home(), "Zimi"),
        "data_dir": "",  # empty = use ZIM_DIR/.zimi (backward compat)
        "port": 8899,
        # Off: the server answers this machine only. On: other devices on the
        # same network (a phone on this PC's hotspot, issue #90) can open it.
        # ZIMI_HOST in the environment wins either way, as for `zimi serve`.
        "lan_access": False,
        "auto_open_browser": True,
        # Opt-out for the Sparkle/WinSparkle launch-time appcast check.
        # True by default so existing installs keep updating; no UI toggle
        # yet (that needs i18n across 10 locale files + design), so this is
        # config.json / env only for now.
        "auto_update_check": True,
        "window_width": 1200,
        "window_height": 800,
        "window_x": None,
        "window_y": None,
    }

    def __init__(self):
        self.dir = _config_dir()
        self.path = os.path.join(self.dir, "config.json")
        self._data = dict(self.DEFAULTS)
        self._load()

    def _load(self):
        if os.path.exists(self.path):
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    stored = json.load(f)
                self._data.update(stored)
            except (json.JSONDecodeError, OSError):
                pass  # corrupt file — use defaults
        # A snap that ran 1.10.1 saved the old default, the snap's own
        # per-revision home (see _user_home). Only that exact value moves; a
        # folder someone chose stays theirs.
        if os.environ.get("SNAP_REAL_HOME"):
            old_default = os.path.join(os.path.expanduser("~"), "Zimi")
            if self._data.get("zim_dir") == old_default:
                self._data["zim_dir"] = self.DEFAULTS["zim_dir"]

    def save(self):
        os.makedirs(self.dir, exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2)

    def get(self, key):
        return self._data.get(key, self.DEFAULTS.get(key))

    def set(self, key, value):
        self._data[key] = value

    @property
    def is_first_run(self):
        return not os.path.exists(self.path)


def _discover_portable_zim_dir(config):
    """Zero-config portable discovery for the desktop app, or None.

    Gated by the 1.9 compatibility contract: only a FIRST run (no config.json,
    so `zim_dir` is nothing but the hardcoded ~/Zimi fallback) with no explicit
    ZIM_DIR in the environment may be redirected to ZIMs found next to the app
    bundle / executable or in the launch folder. A folder the user ever chose
    in Settings — even one equal to the default — lives in config.json and
    therefore always wins.
    """
    if not config.is_first_run or "ZIM_DIR" in os.environ:
        return None
    # Imported here, not at module top: the zimi package is heavy, and every
    # non-first-run launch should skip it until ServerThread needs it.
    from zimi.server import discover_zim_dir

    return discover_zim_dir()


# ---------------------------------------------------------------------------
# ServerThread — runs Zimi HTTP server in background
# ---------------------------------------------------------------------------


LOOPBACK_HOST = "127.0.0.1"
ALL_INTERFACES_HOST = "0.0.0.0"


def _bind_host(config):
    """The address the embedded server listens on.

    ZIMI_HOST, when set, wins, exactly as it does for `zimi serve`. Otherwise
    the desktop default is this machine only; the "other devices on this
    network" setting opens it to every interface. The window itself always
    loads 127.0.0.1, which both answer on."""
    env = os.environ.get("ZIMI_HOST", "").strip()
    if env:
        return env
    return ALL_INTERFACES_HOST if config.get("lan_access") else LOOPBACK_HOST


def _find_open_port(start=8899, end=8910, host=LOOPBACK_HOST):
    """Find the first available port in range, on the address the server
    will bind."""
    for port in range(start, end + 1):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind((host, port))
                return port
        except OSError:
            continue
    return None


class ServerThread(threading.Thread):
    """Starts the Zimi server in a background thread."""

    def __init__(self, zim_dir, port, data_dir=None, host=LOOPBACK_HOST):
        super().__init__(daemon=True)
        self.zim_dir = zim_dir
        self.port = port
        self.host = host
        self.data_dir = data_dir or os.path.join(zim_dir, ".zimi")
        self.actual_port = port
        self.ready = threading.Event()
        self.error = None

    def run(self):
        try:
            # Set environment before importing zimi server components
            os.environ["ZIM_DIR"] = self.zim_dir
            os.environ["ZIMI_MANAGE"] = "1"

            # Try the configured port, fall back if in use
            port = _find_open_port(self.port, host=self.host)
            if port is None:
                self.error = f"No available port in range {self.port}-{self.port + 11}"
                self.ready.set()
                return
            self.actual_port = port

            # Import zimi here so env vars are set first
            import zimi

            zimi.ZIM_DIR = self.zim_dir
            zimi.ZIMI_DATA_DIR = self.data_dir
            os.makedirs(zimi.ZIMI_DATA_DIR, exist_ok=True)
            zimi.ZIMI_MANAGE = True
            zimi.load_cache()
            zimi._migrate_data_files()

            from http.server import ThreadingHTTPServer

            server = ThreadingHTTPServer((self.host, port), zimi.ZimHandler)
            self.ready.set()  # UI can load now — /list works from cache

            # BT sidecar, UPnP, LAN discovery, download resume, mirror
            # upkeep, 12h maintenance — same services the CLI runs. The
            # desktop app used to skip all of it (BT only worked via the
            # lazy download-time spawn; UPnP/resume/mirror never ran).
            zimi.start_background_services(port)

            # Restore suggest cache (instant, from JSON file)
            loaded = zimi._suggest_cache_restore()

            # Pre-warm archives and indexes in background (non-blocking)
            def _warm():
                zims = zimi.get_zim_files()
                for name in zims:
                    try:
                        zimi.get_archive(name)
                    except Exception:
                        pass
                zimi._build_all_title_indexes()
                # Warm suggest/FTS pools and title index connections
                for name in zims:
                    try:
                        zimi._get_suggest_archive(name)
                    except Exception:
                        pass
                    try:
                        zimi._get_fts_archive(name)
                    except Exception:
                        pass
                    conn = zimi._get_title_db(name)
                    if conn:
                        try:
                            for prefix in ("a", "m", "s"):
                                conn.execute(
                                    "SELECT title FROM titles WHERE title_lower >= ? LIMIT 1",
                                    (prefix,),
                                ).fetchone()
                        except Exception:
                            pass

            threading.Thread(target=_warm, daemon=True).start()

            server.serve_forever()
        except Exception as e:
            self.error = str(e)
            self.ready.set()


# ---------------------------------------------------------------------------
# DesktopAPI — JS bridge exposed via pywebview
# ---------------------------------------------------------------------------


class DesktopAPI:
    """Methods callable from JavaScript as window.pywebview.api.*"""

    def __init__(self, config, window_ref):
        self._config = config
        self._window_ref = window_ref  # filled in after window creation

    def choose_folder(self, initial=None):
        """Open native folder picker dialog. Returns path or None."""
        import webview

        result = webview.windows[0].create_file_dialog(
            webview.FOLDER_DIALOG, directory=initial or _user_home()
        )
        return result[0] if result else None

    def get_config(self):
        """Return current config for the settings UI."""
        return {
            "zim_dir": self._config.get("zim_dir"),
            "data_dir": self._config.get("data_dir"),
            "port": self._config.get("port"),
            "auto_open_browser": self._config.get("auto_open_browser"),
            "lan_access": bool(self._config.get("lan_access")),
            # ZIMI_HOST set: the environment decides, and the toggle is locked.
            "lan_access_env": bool(os.environ.get("ZIMI_HOST", "").strip()),
            "is_first_run": self._config.is_first_run,
        }

    def lan_addresses(self):
        """The IPv4 addresses another device on the network can open this
        server at, or [] while it answers this machine only. Asked only when
        the setting is on, so opening Settings never pays for the lookup."""
        host = _bind_host(self._config)
        if host == LOOPBACK_HOST or host.startswith("127.") or host in ("localhost", "::1"):
            return []
        if host not in (ALL_INTERFACES_HOST, "::"):
            return [host]  # ZIMI_HOST named one address: that is the one
        from zimi import p2p_discovery

        return p2p_discovery.local_ipv4s()

    def save_config(self, updates):
        """Save config updates. Returns True if restart is needed."""
        needs_restart = False
        if "lan_access" in updates:
            updates = dict(updates, lan_access=bool(updates["lan_access"]))
        for key in ("zim_dir", "data_dir", "port", "lan_access"):
            if key in updates and updates[key] != self._config.get(key):
                self._config.set(key, updates[key])
                needs_restart = True
        for key in ("auto_open_browser",):
            if key in updates:
                self._config.set(key, updates[key])
        self._config.save()
        return needs_restart

    def set_title(self, title):
        """Update window title from JS (e.g. when viewing an article)."""
        window = self._window_ref.get("window")
        if window:
            window.set_title(title if title else "Zimi")

    def open_external(self, url):
        """Open a URL in the system's default browser/app."""
        import webbrowser

        webbrowser.open(url)

    def download_file(self, url, suggested_name="download"):
        """Download a file from the embedded server to a user-chosen location.

        Opens a native save-file dialog, then downloads the URL to that path.
        Returns the saved path on success, or None if cancelled/failed.
        """
        import webview
        import urllib.request
        import urllib.error

        # Determine file type filter from extension
        ext = os.path.splitext(suggested_name)[1].lower()
        file_types = ("All files (*.*)",)
        if ext == ".pdf":
            file_types = ("PDF files (*.pdf)", "All files (*.*)")
        elif ext in (".epub", ".mobi"):
            file_types = ("eBook files (*.epub;*.mobi)", "All files (*.*)")
        elif ext in (".zip", ".tar", ".gz"):
            file_types = ("Archive files (*.zip;*.tar;*.gz)", "All files (*.*)")

        result = webview.windows[0].create_file_dialog(
            webview.SAVE_DIALOG,
            directory=os.path.join(_user_home(), "Downloads"),
            save_filename=suggested_name,
            file_types=file_types,
        )
        if not result:
            return None

        save_path = result if isinstance(result, str) else result[0]
        try:
            # URL is relative to our embedded server
            if url.startswith("/"):
                port = self._config.get("port") or 8899
                url = f"http://127.0.0.1:{port}{url}"
            urllib.request.urlretrieve(url, save_path)
            return save_path
        except Exception as e:
            return None

    def check_for_app_update(self):
        """Manually trigger an app-update check (Windows/WinSparkle).

        Parity with the macOS "Check for Updates…" menu item, callable from
        the web UI. No-op (returns False) off Windows or when the updater is
        absent.
        """
        if platform.system() != "Windows":
            return False
        try:
            from zimi import winsparkle as zimi_winsparkle

            return zimi_winsparkle.check_update_with_ui()
        except Exception:
            return False

    def restart(self):
        """Restart the app (caught by restart loop in wrapper)."""
        os._exit(42)


# ---------------------------------------------------------------------------
# macOS Dock icon — replace Python rocket with Zimi icon
# ---------------------------------------------------------------------------


def _set_macos_app_identity(window_ref=None):
    """Set Dock icon, process name, and native menu bar on macOS."""
    if platform.system() != "Darwin":
        return
    try:
        from Foundation import NSBundle, NSProcessInfo

        # Set process name shown when hovering Dock icon
        NSProcessInfo.processInfo().setProcessName_("Zimi")
        # Override bundle name so Dock and menu bar say "Zimi"
        bundle = NSBundle.mainBundle()
        info = bundle.localizedInfoDictionary() or bundle.infoDictionary()
        if info:
            info["CFBundleName"] = "Zimi"
            info["CFBundleDisplayName"] = "Zimi"
    except Exception:
        pass
    # Set Dock icon
    icon = _icon_path()
    if icon:
        try:
            from AppKit import NSApplication, NSImage

            app = NSApplication.sharedApplication()
            img = NSImage.alloc().initWithContentsOfFile_(icon)
            if img:
                app.setApplicationIconImage_(img)
        except Exception:
            pass
    # Add native menu bar items (Zimi > Settings...)
    if window_ref is not None:
        try:
            _setup_macos_menu(window_ref)
        except Exception:
            pass


def _env_offline():
    """ZIMI_OFFLINE=1 — the same air-gap switch the server honors (see
    zimi/p2p.py is_offline). Parsed locally, not imported from zimi: the
    updater gate must hold even in a frozen bundle where the embedded
    server package fails to import."""
    return os.environ.get("ZIMI_OFFLINE", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _auto_update_allowed(config=None):
    """May the platform auto-updater initialize AT ALL?

    False means Sparkle/WinSparkle is never loaded — no framework load, no
    background scheduler, no appcast fetch — not "check and discard the
    result". ZIMI_OFFLINE outranks the persisted ``auto_update_check``
    config key; the key defaults to True so existing installs keep their
    behavior. ``config`` is optional because the Sparkle init runs via
    AppHelper.callAfter with no arguments — env-only when absent, the
    config gate then lives at the call site."""
    if _env_offline():
        return False
    if config is not None and not config.get("auto_update_check"):
        return False
    return True


def _init_sparkle_updater():
    """Initialize Sparkle auto-updater on macOS. Must be called on the main thread."""
    # Checked before anything else (even the platform sniff): under
    # ZIMI_OFFLINE this function must be a pure no-op — no objc import,
    # no framework load.
    if not _auto_update_allowed():
        return
    if platform.system() != "Darwin":
        return
    try:
        import objc

        # Load Sparkle.framework from the app bundle's Frameworks/ directory
        bundle_path = None
        if getattr(sys, "_MEIPASS", None):
            # PyInstaller bundle: framework is in Contents/Frameworks/
            app_bundle_path = os.path.dirname(os.path.dirname(sys._MEIPASS))
            bundle_path = os.path.join(
                app_bundle_path, "Frameworks", "Sparkle.framework"
            )
        if not bundle_path or not os.path.exists(bundle_path):
            # Dev mode: framework in the repo root (one level up from zimi/)
            bundle_path = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                "Sparkle.framework",
            )
        if not os.path.exists(bundle_path):
            return

        sparkle_bundle = objc.loadBundle(
            "Sparkle", bundle_path=bundle_path, module_globals=globals()
        )

        # SPUStandardUpdaterController manages the full update lifecycle.
        # startingUpdater:False — configure first, start second. The old
        # code started the updater and THEN set the feed URL; that only
        # worked because both calls ran back-to-back on the main thread
        # (Sparkle can't fire a check until the runloop turns) and because
        # Sparkle resolves the feed lazily at check time. Passing False and
        # calling startUpdater() after configuration is the pattern Sparkle
        # documents for exactly this case, and it stops an arm64 build from
        # ever being registered against the Info.plist's intel feed.
        SPUStandardUpdaterController = objc.lookUpClass("SPUStandardUpdaterController")
        controller = SPUStandardUpdaterController.alloc().initWithStartingUpdater_updaterDelegate_userDriverDelegate_(
            False,  # startingUpdater: configure the feed before starting
            None,  # updaterDelegate
            None,  # userDriverDelegate
        )

        # Point at architecture-specific appcast so AS users get the AS DMG
        import platform as _plat
        from Foundation import NSURL

        arch = _plat.machine()  # "arm64" or "x86_64"
        arch_suffix = "arm64" if arch == "arm64" else "intel"
        feed_url = f"https://raw.githubusercontent.com/epheterson/Zimi/main/appcast-{arch_suffix}.xml"
        controller.updater().setFeedURL_(NSURL.URLWithString_(feed_url))
        controller.startUpdater()

        # Keep a strong reference to prevent garbage collection
        _init_sparkle_updater._controller = controller
    except Exception as e:
        # Sparkle is optional — app works fine without it
        print(f"Sparkle init failed: {e}")


def _setup_macos_menu(window_ref):
    """Add Settings... to the Zimi app menu (Cmd+,). Must dispatch to main thread."""
    import objc
    from AppKit import NSApplication, NSMenuItem
    from PyObjCTools import AppHelper

    def _add_menu():
        app = NSApplication.sharedApplication()
        main_menu = app.mainMenu()
        if not main_menu:
            return

        # Find the app menu (first item in the menu bar)
        app_menu_item = main_menu.itemAtIndex_(0)
        if not app_menu_item:
            return
        app_menu = app_menu_item.submenu()
        if not app_menu:
            return

        # Check if we already added Settings (avoid duplicates on re-show)
        for i in range(app_menu.numberOfItems()):
            if app_menu.itemAtIndex_(i).title() == "Settings\u2026":
                return

        # Create a helper class to handle the menu action
        MenuHelper = objc.lookUpClass("NSObject")

        class ZimiMenuDelegate(MenuHelper):
            def openSettings_(self, sender):
                # Must run evaluate_js off the main thread to avoid deadlock
                # (pywebview's evaluate_js dispatches to main thread internally)
                window = window_ref.get("window")
                if window:
                    threading.Thread(
                        target=window.evaluate_js,
                        args=("enterManage()",),
                        daemon=True,
                    ).start()

            def reloadPage_(self, sender):
                window = window_ref.get("window")
                if window:
                    threading.Thread(
                        target=window.evaluate_js,
                        args=("location.reload()",),
                        daemon=True,
                    ).start()

        delegate = ZimiMenuDelegate.alloc().init()
        # Keep a strong reference so it doesn't get garbage-collected
        window_ref["_menu_delegate"] = delegate

        # Insert "Settings..." with Cmd+, after the first separator (or at index 1)
        settings_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            "Settings\u2026", "openSettings:", ","
        )
        settings_item.setTarget_(delegate)

        # Insert after "About" item and a separator
        insert_idx = min(2, app_menu.numberOfItems())
        app_menu.insertItem_atIndex_(NSMenuItem.separatorItem(), insert_idx)
        app_menu.insertItem_atIndex_(settings_item, insert_idx + 1)

        # Add View menu with Reload (Cmd+R)
        from AppKit import NSMenu

        view_menu = NSMenu.alloc().initWithTitle_("View")
        reload_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            "Reload", "reloadPage:", "r"
        )
        reload_item.setTarget_(delegate)
        view_menu.addItem_(reload_item)
        view_menu_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            "View", None, ""
        )
        view_menu_item.setSubmenu_(view_menu)
        main_menu.addItem_(view_menu_item)

        # Add "Check for Updates..." if Sparkle is initialized
        controller = getattr(_init_sparkle_updater, "_controller", None)
        if controller:
            update_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                "Check for Updates\u2026", "checkForUpdates:", ""
            )
            update_item.setTarget_(controller)
            app_menu.insertItem_atIndex_(update_item, insert_idx + 2)

    # AppKit menu ops must run on the main thread
    AppHelper.callAfter(_add_menu)


# ---------------------------------------------------------------------------
# Loading splash — shown while server starts
# ---------------------------------------------------------------------------

LOADING_HTML = """\
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;background:#0a0a0b;display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,sans-serif">
<div style="text-align:center">
  <div style="font-size:36px;font-weight:700;background:linear-gradient(135deg,#f59e0b,#f97316,#ef4444);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:16px">Zimi</div>
  <div style="color:#6e6e7a;font-size:14px">Loading your library&hellip;</div>
  <div style="margin-top:24px">
    <div style="width:24px;height:24px;border:2px solid #27272b;border-top-color:#f59e0b;border-radius:50%;animation:s .7s linear infinite;margin:0 auto"></div>
  </div>
</div>
<style>@keyframes s{to{transform:rotate(360deg)}}</style>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# Window lifecycle — save geometry on close
# ---------------------------------------------------------------------------


def _save_window_geometry(window, config):
    """Save window size and position to config."""
    try:
        config.set("window_width", window.width)
        config.set("window_height", window.height)
        config.set("window_x", window.x)
        config.set("window_y", window.y)
        config.save()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# main — orchestrate startup
# ---------------------------------------------------------------------------


def _run():
    """Actual app entry point (called by wrapper or directly with --run)."""
    forced = _browser_mode_requested()
    ok, why = (True, "") if forced else _native_window_available()
    if forced or not ok:
        if os.environ.get("ZIMI_DESKTOP_SMOKE") == "app" and not forced:
            # The window smoke asked for a window; the browser is not one.
            print("SMOKE: FAIL no native window: %s" % why, flush=True)
            os._exit(1)
        _run_in_browser("" if forced else why)
        return
    import webview

    config = ConfigManager()
    zim_dir = config.get("zim_dir")
    discovered = _discover_portable_zim_dir(config)
    if discovered:
        zim_dir = discovered
        # In-memory only, never saved here: persisting would promote a
        # discovery into a "user choice" that then shadows the stick (or its
        # absence) on every later launch. The settings UI reads this value,
        # and saving from there is the moment it becomes a real choice.
        config.set("zim_dir", zim_dir)
    os.makedirs(zim_dir, exist_ok=True)

    # Set macOS Dock icon and process name before creating any windows
    _set_macos_app_identity()

    # Restore window geometry
    win_w = config.get("window_width") or 1200
    win_h = config.get("window_height") or 800
    win_x = config.get("window_x")
    win_y = config.get("window_y")

    # Window ref container — filled after creation so DesktopAPI can access it
    window_ref = {}
    api = DesktopAPI(config, window_ref)

    # Create window with loading splash first
    window = webview.create_window(
        "Zimi",
        html=LOADING_HTML,
        js_api=api,
        width=win_w,
        height=win_h,
        min_size=(800, 600),
        x=win_x,
        y=win_y,
        background_color="#0a0a0b",
    )
    window_ref["window"] = window

    # Save geometry when window closes
    window.events.closing += lambda: _save_window_geometry(window, config)

    def _on_webview_ready():
        """Called when the webview window is shown — start server and navigate."""
        # Initialize the platform auto-updater. macOS uses Sparkle.framework
        # (main-thread init so the menu setup can find the controller); Windows
        # uses WinSparkle.dll via ctypes. Both soft-fail to no-updater.
        # Gated up front: ZIMI_OFFLINE or auto_update_check=false means the
        # updater machinery is never even imported, so a disabled updater
        # produces zero network traffic and zero framework state.
        if _auto_update_allowed(config):
            if platform.system() == "Darwin":
                try:
                    from PyObjCTools import AppHelper

                    AppHelper.callAfter(_init_sparkle_updater)
                except Exception:
                    pass
            elif platform.system() == "Windows":
                try:
                    from zimi import winsparkle as zimi_winsparkle
                    from zimi.server import ZIMI_VERSION

                    zimi_winsparkle.init_updater(ZIMI_VERSION)
                except Exception:
                    pass

        # Add native macOS menu items now that the app menu bar exists
        _set_macos_app_identity(window_ref)

        data_dir = config.get("data_dir") or os.path.join(zim_dir, ".zimi")
        server = ServerThread(zim_dir, config.get("port"), data_dir=data_dir, host=_bind_host(config))
        server.start()
        server.ready.wait(timeout=60)

        if server.error:
            if os.environ.get("ZIMI_DESKTOP_SMOKE") == "app":
                # Otherwise the smoke sits in the GUI loop until the watcher
                # gives up, and a two-minute timeout says nothing about why.
                print("SMOKE: FAIL server did not start: %s" % server.error, flush=True)
                os._exit(1)
            window.load_html(
                f'<html><body style="font-family:system-ui;background:#0a0a0b;color:#e8e8ed;padding:40px">'
                f'<h2 style="color:#f59e0b">Failed to start server</h2>'
                f'<pre style="color:#6e6e7a;margin-top:16px">{server.error}</pre>'
                f"</body></html>"
            )
            return

        window.load_url(f"http://127.0.0.1:{server.actual_port}")

        # Wait for the page to load, then ensure desktop mode is activated.
        # pywebview's cocoa backend doesn't fire the 'loaded' event, so we
        # poll from Python until the page has the Zimi JS loaded.
        import time

        for _ in range(20):  # up to 10s
            time.sleep(0.5)
            try:
                ready = window.evaluate_js("typeof _desktopInit === 'function'")
                if ready:
                    window.evaluate_js("""
                        if (!IS_DESKTOP && window.pywebview && window.pywebview.api) {
                            _desktopInit();
                        }
                    """)
                    break
            except Exception:
                pass

        if os.environ.get("ZIMI_DESKTOP_SMOKE") == "app":
            _smoke_app_rendered(window)
            return

        # Sync document.title → native window title. The JS bridge
        # (pywebview.api.set_title) handles most updates, but we also poll
        # as a fallback since the bridge can be flaky in PyInstaller bundles.
        _title_poll_active[0] = True
        _last_title = "Zimi"
        while _title_poll_active[0]:
            time.sleep(1)
            try:
                doc_title = window.evaluate_js("document.title")
                if doc_title and doc_title != _last_title:
                    _last_title = doc_title
                    window.set_title(doc_title)
            except Exception:
                break  # window closed

    # Stop title polling when window closes
    _title_poll_active = [False]
    window.events.closing += lambda: _title_poll_active.__setitem__(0, False)

    # Start server in background after window is shown
    window.events.shown += _on_webview_ready

    # On Windows, force Edge WebView2 backend (avoids pythonnet/.NET issues)
    gui = "edgechromium" if platform.system() == "Windows" else None
    # Not private mode: pywebview's default keeps nothing between launches,
    # so the desktop app forgot its bookmarks, history and settings every
    # time it was closed, and on WebKitGTK a private window's localStorage
    # is null, which killed the page outright (issue #81). The window's
    # storage lives beside the app's other data.
    storage = os.path.join(config.get("data_dir") or os.path.join(zim_dir, ".zimi"), "webview")
    os.makedirs(storage, exist_ok=True)
    # ZIMI_DESKTOP_DEBUG=1: pywebview's debug mode (the inspector).
    webview.start(gui=gui, private_mode=False, storage_path=storage, debug=os.environ.get("ZIMI_DESKTOP_DEBUG") == "1")


def _serve_headless():
    """Run the HTTP server without a GUI window (for CI testing).

    Usage: Zimi --serve [--port PORT] [--zim-dir DIR]
    Prints 'READY <port>' to stdout when the server is listening.
    Port 0 picks a random available port.
    """
    port, zim_dir = _cli_port_and_zim_dir(sys.argv[1:])
    if port is None:
        port = 8899

    config = ConfigManager()
    if zim_dir is None:
        zim_dir = config.get("zim_dir")
        # Same portable discovery as the GUI path — a --zim-dir flag above
        # skipped this entirely, and the gate inside refuses unless this is a
        # true first run with no ZIM_DIR env.
        discovered = _discover_portable_zim_dir(config)
        if discovered:
            zim_dir = discovered

    _serve(zim_dir, port, lambda actual_port: print(f"READY {actual_port}", flush=True), _bind_host(config))


def _cli_port_and_zim_dir(args):
    """``--port N`` and ``--zim-dir DIR`` from a command line, each None
    when absent. Shared by the headless server and the browser mode."""
    port, zim_dir = None, None
    i = 0
    while i < len(args):
        if args[i] == "--port" and i + 1 < len(args):
            port = int(args[i + 1])
            i += 2
        elif args[i] == "--zim-dir" and i + 1 < len(args):
            zim_dir = args[i + 1]
            i += 2
        else:
            i += 1
    return port, zim_dir


def _run_in_browser(reason=""):
    """The app without a native window: the same server, opened in the
    system browser. What a Linux machine without WebKitGTK gets, and what
    ``--browser`` asks for anywhere. ``--port`` and ``--zim-dir`` on the
    command line win over the saved config, as they do for ``--serve``."""
    config = ConfigManager()
    cli_port, cli_zim_dir = _cli_port_and_zim_dir(sys.argv[1:])
    zim_dir = cli_zim_dir or config.get("zim_dir")
    if not cli_zim_dir:
        discovered = _discover_portable_zim_dir(config)
        if discovered:
            zim_dir = discovered
    port = cli_port if cli_port is not None else config.get("port")
    port = 8899 if port is None else int(port)

    def on_ready(actual_port):
        url = f"http://127.0.0.1:{actual_port}"
        print(f"READY {actual_port}", flush=True)
        if reason:
            print(f"Zimi: {reason}; opening {url} in your browser instead.", file=sys.stderr, flush=True)
        else:
            print(f"Zimi: {url}", file=sys.stderr, flush=True)
        import webbrowser

        try:
            opened = webbrowser.open(url)
        except Exception:
            opened = False
        if not opened:
            print(f"Zimi: could not open a browser here; visit {url}", file=sys.stderr, flush=True)

    host = _bind_host(config)
    try:
        _serve(zim_dir, port, on_ready, host)
    except OSError as e:
        import errno

        if port and e.errno in (errno.EADDRINUSE, errno.EACCES):
            # The usual port is taken (another Zimi, say): any free one.
            _serve(zim_dir, 0, on_ready, host)
        else:
            raise


def _serve(zim_dir, port, on_ready, host=LOOPBACK_HOST):
    """Run the HTTP server in this thread until interrupted; ``on_ready``
    gets the port once it listens."""
    os.environ["ZIM_DIR"] = zim_dir
    os.environ["ZIMI_MANAGE"] = "1"
    os.makedirs(zim_dir, exist_ok=True)

    data_dir = os.environ.get("ZIMI_DATA_DIR") or os.path.join(zim_dir, ".zimi")

    import zimi

    zimi.ZIM_DIR = zim_dir
    zimi.ZIMI_DATA_DIR = data_dir
    os.makedirs(zimi.ZIMI_DATA_DIR, exist_ok=True)
    zimi.ZIMI_MANAGE = True
    zimi.load_cache()
    zimi._migrate_data_files()

    # Pre-warm archives
    for name in zimi.get_zim_files():
        try:
            zimi.get_archive(name)
        except Exception:
            pass

    # Build title indexes in background
    threading.Thread(target=zimi._build_all_title_indexes, daemon=True).start()

    from http.server import ThreadingHTTPServer

    server = ThreadingHTTPServer((host, port), zimi.ZimHandler)
    actual_port = server.server_address[1]
    # Same background services as the GUI and the serve CLI — this path
    # is what CI smoke-tests, so it must exercise the real thing.
    zimi.start_background_services(actual_port)
    on_ready(actual_port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


# The window smoke below proves the native window and its .NET backend come
# up. This one proves the APP does: the embedded server answered, the real
# page loaded, and the home view rendered with its search box and content.
# Enabled by ZIMI_DESKTOP_SMOKE=app; the real launch path runs unchanged up to
# the point where a person would see the home screen.
#
# Contract: prints "SMOKE: app rendered ..." and exits 0, after holding the
# window open for ZIMI_DESKTOP_SMOKE_DWELL seconds (default 8) so a screenshot
# can be taken of it; prints "SMOKE: FAIL ..." and exits 1 otherwise.
# What the page can say about itself when the home view did not come: the
# script errors it caught, what it fetched and with what status, and where
# its init got to. Read once, on failure, so the smoke's report explains.
_SMOKE_DIAG_JS = """
(function () {
  // Each fact on its own, so one that cannot be read (a let still in its
  // temporal dead zone throws even at typeof) does not hide the others.
  var out = {};
  var take = function (k, f) { try { out[k] = f(); } catch (e) { out[k] = 'threw: ' + (e && e.message || e); } };
  take('errors', function () { return window.__zimiErrors || null; });
  take('resources', function () {
    return (performance.getEntriesByType('resource') || []).slice(0, 30).map(function (r) {
      return r.name.split('/').slice(3).join('/').slice(0, 60) + ':' + (r.responseStatus === undefined ? '?' : r.responseStatus);
    });
  });
  take('scripts', function () { return Array.prototype.map.call(document.scripts, function (s) { return (s.src || 'inline').split('/').slice(3).join('/').slice(0, 40); }); });
  take('init', function () { return typeof init; });
  take('zims', function () { return zimsCache === null ? 'null' : zimsCache.length; });
  take('desktop', function () { return IS_DESKTOP; });
  take('bridge', function () { return !!(window.pywebview && window.pywebview.api); });
  take('agent', function () { return navigator.userAgent.slice(0, 90); });
  return JSON.stringify(out);
})()
"""

_SMOKE_APP_RENDERED_JS = """
(function () {
  var box = document.querySelector('#q');
  var home = document.querySelector('.discover-section, .cat-heading, .empty, .stat-card');
  var text = (document.body && document.body.innerText) || '';
  return JSON.stringify({box: !!box, home: !!home, chars: text.length, title: document.title,
                         href: location.href, ready: document.readyState});
})()
"""


def _smoke_app_rendered(window):
    import json
    import time

    verdict = None
    last, last_error = {}, ""
    for _ in range(120):  # up to 60s
        time.sleep(0.5)
        try:
            raw = window.evaluate_js(_SMOKE_APP_RENDERED_JS)
            state = json.loads(raw) if raw else {}
        except Exception as e:
            last_error = repr(e)
            continue
        last = state
        if state.get("box") and state.get("home") and state.get("chars", 0) > 100:
            verdict = state
            break
    if not verdict:
        # Say what was seen, not just that it was not enough, and ask the
        # page what it knows.
        try:
            diag = window.evaluate_js(_SMOKE_DIAG_JS)
        except Exception as e:
            diag = "unavailable: %r" % (e,)
        print(
            "SMOKE: FAIL app did not render a home view within 60s; last state %s; last error %s; page says %s"
            % (json.dumps(last), last_error or "none", diag),
            flush=True,
        )
        os._exit(1)
    print(
        "SMOKE: app rendered (%d chars, title %r)" % (verdict["chars"], verdict["title"]),
        flush=True,
    )
    time.sleep(float(os.environ.get("ZIMI_DESKTOP_SMOKE_DWELL", "8")))
    try:
        window.destroy()
    except Exception:
        pass
    os._exit(0)


def _smoke_test_window():
    """Headed smoke test: open a REAL pywebview window, confirm it shows, tear
    it down, and exit. Enabled via ZIMI_DESKTOP_SMOKE=1 or --smoke.

    The headless --serve smoke only exercises the embedded HTTP server, so it
    can't catch failures in window creation itself — e.g. the pythonnet /
    System.Windows.Forms assembly-load crash that shipped in a Windows build.
    This path drives the same backend the app uses (EdgeChromium on Windows)
    so any runtime/assembly failure aborts the build.

    Contract: prints "SMOKE: window shown" and exits 0 on success; prints a
    "SMOKE: FAIL ..." line and exits nonzero on any exception or a 90s timeout.
    """
    import time

    import webview

    shown = threading.Event()

    def _watchdog():
        # A window that never shows (hang, missing WebView2, backend crash that
        # doesn't raise) must still fail the build rather than block forever.
        if not shown.wait(90):
            print("SMOKE: FAIL — window never shown within 90s", flush=True)
            os._exit(1)

    threading.Thread(target=_watchdog, daemon=True).start()

    window = webview.create_window(
        "Zimi Smoke",
        html="<!DOCTYPE html><html><body style='background:#0a0a0b'></body></html>",
        width=480,
        height=320,
    )

    def _on_shown():
        # Reaching here proves the native window + its .NET backend came up.
        print("SMOKE: window shown", flush=True)
        shown.set()

        # Tear the window down from a separate thread so this handler returns
        # and the GUI loop is idle before destroy() runs — destroying inline
        # from the shown callback can race the loop on some backends. Once the
        # window closes, webview.start() returns and we exit cleanly.
        def _teardown():
            time.sleep(0.3)
            try:
                window.destroy()
            except Exception:
                pass

        threading.Thread(target=_teardown, daemon=True).start()

    window.events.shown += _on_shown

    gui = "edgechromium" if platform.system() == "Windows" else None
    try:
        webview.start(gui=gui)
    except Exception as e:
        print(f"SMOKE: FAIL — webview.start raised: {e}", flush=True)
        os._exit(1)

    if not shown.is_set():
        print("SMOKE: FAIL — webview exited without showing a window", flush=True)
        os._exit(1)
    print("SMOKE: OK", flush=True)
    os._exit(0)


def main():
    """Wrapper that restarts the app when exit code is 42."""
    if os.environ.get("ZIMI_DESKTOP_SMOKE") == "1" or "--smoke" in sys.argv:
        _smoke_test_window()
        return
    if os.environ.get("ZIMI_DESKTOP_SMOKE") == "app":
        _run()  # in this process: the wrapper below would swallow the exit code
        return

    if "--serve" in sys.argv:
        _serve_headless()
        return

    if "--run" in sys.argv:
        _run()
        return

    while True:
        proc = subprocess.run(_relaunch_command())
        if proc.returncode != 42:
            break


def _relaunch_command(argv=None, frozen=None):
    """The child that runs the app: the bundle itself when frozen, this
    module otherwise. The flags a person gave (``--browser``) travel."""
    argv = sys.argv if argv is None else argv
    frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    head = [sys.executable] if frozen else [sys.executable, "-m", "zimi.desktop"]
    return head + ["--run"] + [a for a in argv[1:] if a != "--run"]


if __name__ == "__main__":
    main()
