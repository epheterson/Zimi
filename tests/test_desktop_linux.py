"""The desktop app on Linux, and every launch flow.

Issue #81: the AppImage and the snap died on six distros with "Namespace
WebKit2 not available" (or a black window). The bundle never carried
WebKitGTK's typelib and could not see the host's; and when no backend is
there at all, the app must still run, in the browser.

Run: pytest tests/test_desktop_linux.py -v
"""

import os
import sys

import pytest

sys.path.insert(
    0,
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "desktop"
    ),
)

from zimi import desktop  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ── the app lives in the package: every launch flow reaches one module ────


def test_the_entry_script_is_the_package_module():
    import zimi_desktop  # the desktop/ shim

    assert zimi_desktop is desktop


def test_the_pip_flow_imports_the_package_and_names_the_extra():
    with open(os.path.join(REPO, "zimi", "server.py"), encoding="utf-8") as f:
        src = f.read()
    assert "from zimi.desktop import main as desktop_main" in src
    assert "zimi_desktop" not in src.replace("zimi.desktop", "")
    assert "pip install 'zimi[desktop]'" in src
    with open(os.path.join(REPO, "pyproject.toml"), encoding="utf-8") as f:
        assert 'desktop = ["pywebview>=4.0.0"]' in f.read()


def test_the_relaunch_carries_the_flags_and_knows_the_bundle():
    assert desktop._relaunch_command(["Zimi", "--browser"], frozen=True) == [
        sys.executable,
        "--run",
        "--browser",
    ]
    assert desktop._relaunch_command(["x", "--run"], frozen=False) == [
        sys.executable,
        "-m",
        "zimi.desktop",
        "--run",
    ]


# ── the environment a Linux launch wants ──────────────────────────────────


def test_webkit_escape_hatches_are_set_unless_the_person_set_them():
    env = {}
    changed = desktop._linux_environment(env, frozen=False)
    assert (
        env["WEBKIT_DISABLE_DMABUF_RENDERER"] == "1"
        and env["WEBKIT_DISABLE_COMPOSITING_MODE"] == "1"
    )
    assert set(changed) == {
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "WEBKIT_DISABLE_COMPOSITING_MODE",
    }
    env = {"WEBKIT_DISABLE_DMABUF_RENDERER": "0"}
    desktop._linux_environment(env, frozen=False)
    assert env["WEBKIT_DISABLE_DMABUF_RENDERER"] == "0", "a person's own choice stands"


def test_a_frozen_bundle_sees_the_hosts_typelibs_before_its_own():
    env = {"GI_TYPELIB_PATH": "/bundle/gi_typelibs"}
    desktop._linux_environment(
        env,
        frozen=True,
        typelib_dirs=("/usr/lib/x86_64-linux-gnu/girepository-1.0", "/nowhere"),
        isdir=lambda d: d != "/nowhere",
    )
    assert (
        env["GI_TYPELIB_PATH"]
        == "/usr/lib/x86_64-linux-gnu/girepository-1.0"
        + os.pathsep
        + "/bundle/gi_typelibs"
    ), "the host's typelibs first: they match the host's libraries"
    env = {"GI_TYPELIB_PATH": "/bundle/gi_typelibs"}
    desktop._linux_environment(env, frozen=False, isdir=lambda d: True)
    assert (
        env["GI_TYPELIB_PATH"] == "/bundle/gi_typelibs"
    ), "a dev launch already sees the system"


# ── without a backend the app runs in the browser ─────────────────────────


def test_browser_mode_is_a_flag_or_an_env():
    assert desktop._browser_mode_requested(["Zimi", "--browser"], {})
    assert desktop._browser_mode_requested(["Zimi"], {"ZIMI_DESKTOP_BROWSER": "1"})
    assert not desktop._browser_mode_requested(["Zimi"], {"ZIMI_DESKTOP_BROWSER": "0"})
    assert not desktop._browser_mode_requested(["Zimi", "--run"], {})


def test_no_backend_means_no_window_with_one_reason(monkeypatch):
    monkeypatch.setattr(desktop.platform, "system", lambda: "Linux")

    def no_backend(name):
        raise (
            ValueError("Namespace WebKit2 not available")
            if name.endswith("gtk")
            else ImportError("No module named 'qtpy'")
        )

    ok, why = desktop._native_window_available(import_module=no_backend)
    assert ok is False and "WebKitGTK or Qt" in why and "qtpy" in why and "WebKit2" in why, "every backend says why"
    ok, why = desktop._native_window_available(import_module=lambda name: None)
    assert (ok, why) == (True, "")


def test_other_platforms_always_have_a_window(monkeypatch):
    monkeypatch.setattr(desktop.platform, "system", lambda: "Darwin")
    assert desktop._native_window_available(
        import_module=lambda name: (_ for _ in ()).throw(ImportError())
    ) == (True, "")


def test_the_run_gate_falls_back_before_touching_pywebview(monkeypatch):
    monkeypatch.setattr(
        desktop, "_browser_mode_requested", lambda argv=None, env=None: False
    )
    monkeypatch.setattr(
        desktop,
        "_native_window_available",
        lambda import_module=None: (False, "no WebKitGTK"),
    )
    got = []
    monkeypatch.setattr(
        desktop, "_run_in_browser", lambda reason="": got.append(reason)
    )
    monkeypatch.setitem(sys.modules, "webview", None)  # importing it would now fail
    desktop._run()
    assert got == ["no WebKitGTK"]


def test_browser_mode_serves_and_opens_the_browser(monkeypatch, tmp_path):
    opened = []
    monkeypatch.setattr(
        desktop,
        "ConfigManager",
        lambda: type(
            "C",
            (),
            {"get": lambda self, k: {"zim_dir": str(tmp_path), "port": 0}.get(k)},
        )(),
    )
    monkeypatch.setattr(desktop, "_discover_portable_zim_dir", lambda config: None)
    ports = []

    def fake_serve(zim_dir, port, on_ready):
        ports.append(port)
        on_ready(43210)

    monkeypatch.setattr(desktop, "_serve", fake_serve)
    import webbrowser

    monkeypatch.setattr(webbrowser, "open", lambda url: opened.append(url) or True)
    desktop._run_in_browser("no WebKitGTK")
    assert ports == [0] and opened == ["http://127.0.0.1:43210"]


def test_a_taken_port_falls_back_to_any_free_one(monkeypatch, tmp_path):
    import errno

    monkeypatch.setattr(
        desktop,
        "ConfigManager",
        lambda: type(
            "C",
            (),
            {"get": lambda self, k: {"zim_dir": str(tmp_path), "port": 8899}.get(k)},
        )(),
    )
    monkeypatch.setattr(desktop, "_discover_portable_zim_dir", lambda config: None)
    ports = []

    def fake_serve(zim_dir, port, on_ready):
        ports.append(port)
        if port == 8899:
            raise OSError(errno.EADDRINUSE, "in use")

    monkeypatch.setattr(desktop, "_serve", fake_serve)
    desktop._run_in_browser()
    assert ports == [8899, 0]


# ── the bundle carries what the window asks for ───────────────────────────


def test_the_spec_bundles_webkits_typelibs_and_the_package_module():
    with open(
        os.path.join(REPO, "desktop", "zimi_desktop.spec"), encoding="utf-8"
    ) as f:
        spec = f.read()
    for name in (
        "('WebKit2', '4.1')",
        "('WebKit2', '4.0')",
        "('Soup', '3.0')",
        "('JavaScriptCore', '4.1')",
        "webkit_datas",
        "'zimi.desktop'",
        "'zimi.winsparkle'",
    ):
        assert name in spec, name
    assert "'zimi_winsparkle'" not in spec


def test_the_snap_has_a_display_and_a_webkit():
    with open(os.path.join(REPO, "snap", "snapcraft.yaml"), encoding="utf-8") as f:
        snap = f.read()
    assert "extensions: [gnome]" in snap
    for plug in ("desktop", "x11", "wayland", "opengl", "network-status"):
        assert plug in snap, plug


@pytest.mark.skipif(sys.platform != "linux", reason="the Linux launch")
def test_on_linux_the_environment_is_set_at_import():
    assert os.environ.get("WEBKIT_DISABLE_DMABUF_RENDERER") in ("0", "1")


def test_a_frozen_bundle_gives_webkits_helper_processes_the_hosts_library_path():
    env = {"LD_LIBRARY_PATH": "/bundle/_internal", "LD_LIBRARY_PATH_ORIG": "/opt/lib"}
    desktop._linux_environment(env, frozen=True, isdir=lambda d: False)
    assert env["LD_LIBRARY_PATH"] == "/opt/lib"
    env = {"LD_LIBRARY_PATH": "/bundle/_internal"}
    desktop._linux_environment(env, frozen=True, isdir=lambda d: False)
    assert "LD_LIBRARY_PATH" not in env
    env = {"LD_LIBRARY_PATH": "/mine"}
    desktop._linux_environment(env, frozen=False, isdir=lambda d: False)
    assert env["LD_LIBRARY_PATH"] == "/mine", "a dev launch is not a bundle"


def test_the_host_decides_which_webkit_abi_introspection_uses():
    assert desktop._host_webkit(loadable=lambda so: so.endswith("4.0.so.37")) == ("4.0", "2.4")
    assert desktop._host_webkit(loadable=lambda so: True) == ("4.1", "3.0"), "4.1 first when both are there"
    assert desktop._host_webkit(loadable=lambda so: False) is None
    asked = []
    assert desktop._pin_webkit_version(require_version=lambda n, v: asked.append((n, v)), host=("4.0", "2.4")) == ("4.0", "2.4")
    assert asked == [("WebKit2", "4.0"), ("Soup", "2.4")]
    assert desktop._pin_webkit_version(require_version=lambda n, v: None, host=None) is None


def test_a_frozen_bundle_uses_the_hosts_platform_first():
    env = {"GI_TYPELIB_PATH": "/bundle/gi_typelibs", "GDK_PIXBUF_MODULE_FILE": "/bundle/loaders.cache", "GSETTINGS_SCHEMA_DIR": "/bundle/schemas"}
    desktop._linux_environment(env, frozen=True, typelib_dirs=("/usr/lib64/girepository-1.0",), isdir=lambda d: True)
    assert env["GI_TYPELIB_PATH"] == "/usr/lib64/girepository-1.0" + os.pathsep + "/bundle/gi_typelibs", "host typelibs match host libraries"
    assert "GDK_PIXBUF_MODULE_FILE" not in env and "GSETTINGS_SCHEMA_DIR" not in env


def test_the_spec_leaves_the_gtk_platform_to_the_host_on_linux():
    with open(os.path.join(REPO, "desktop", "zimi_desktop.spec"), encoding="utf-8") as f:
        spec = f.read()
    assert "a.binaries = _kept + _fallback" in spec and "'/site-packages/' in _src" in spec and "gio_modules" in spec
    with open(os.path.join(REPO, "linux", "AppRun"), encoding="utf-8") as f:
        apprun = f.read()
    assert "_internal/fallback" in apprun and "ldconfig -p" in apprun and 'exec "$HERE/Zimi" "$@"' in apprun


def test_browser_mode_honours_the_command_lines_port_and_folder(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "argv", ["Zimi", "--browser", "--port", "0", "--zim-dir", str(tmp_path / "here")])
    monkeypatch.setattr(desktop, "ConfigManager", lambda: type("C", (), {"get": lambda self, k: {"zim_dir": "/saved", "port": 8899}.get(k)})())
    monkeypatch.setattr(desktop, "_discover_portable_zim_dir", lambda config: "/a/stick")
    seen = []
    monkeypatch.setattr(desktop, "_serve", lambda zim_dir, port, on_ready: seen.append((zim_dir, port)))
    desktop._run_in_browser()
    assert seen == [(str(tmp_path / "here"), 0)]
    assert desktop._cli_port_and_zim_dir(["--port", "7", "x", "--zim-dir"]) == (7, None)


def test_the_window_keeps_its_storage_and_the_page_survives_without_one():
    with open(os.path.join(REPO, "zimi", "desktop.py"), encoding="utf-8") as f:
        src = f.read()
    assert "private_mode=False" in src and "storage_path=storage" in src
    with open(os.path.join(REPO, "zimi", "static", "app.js"), encoding="utf-8") as f:
        js = f.read()
    assert js.index("_ensureStorage") < js.index("var _cfg = window.__ZIMI_CONFIG"), "the shim comes before the first read"
    assert "'localStorage', 'sessionStorage'" in js


def test_a_snap_keeps_the_environment_its_extension_built():
    """Inside a snap the GNOME extension has already pointed GTK, WebKitGTK
    and their data at the platform snap. Taking that apart, which is right
    for a bundle on a plain host, left the 1.10.0 snap unable to open a
    window and unable to fall back to a browser: it did nothing, silently."""
    snap = {
        "SNAP": "/snap/zimi/42",
        "SNAP_NAME": "zimi",
        "LD_LIBRARY_PATH": "/snap/gnome-42-2204/current/usr/lib/x86_64-linux-gnu",
        "GI_TYPELIB_PATH": "/snap/gnome-42-2204/current/usr/lib/x86_64-linux-gnu/girepository-1.0",
        "GDK_PIXBUF_MODULE_FILE": "/snap/zimi/42/usr/lib/loaders.cache",
        "GSETTINGS_SCHEMA_DIR": "/snap/zimi/42/usr/share/glib-2.0/schemas",
        "GIO_MODULE_DIR": "/snap/zimi/42/usr/lib/gio/modules",
    }
    before = dict(snap)
    changed = desktop._linux_environment(snap, frozen=True, isdir=lambda d: True)
    for key in ("LD_LIBRARY_PATH", "GI_TYPELIB_PATH", "GDK_PIXBUF_MODULE_FILE", "GSETTINGS_SCHEMA_DIR", "GIO_MODULE_DIR"):
        assert snap[key] == before[key], key
        assert key not in changed, key
    # The GPU hints are still wanted: a snap runs on the same machines. And
    # GLib's own network monitor, not the portal's, which refuses a snap.
    assert changed == {
        "WEBKIT_DISABLE_DMABUF_RENDERER": "1",
        "WEBKIT_DISABLE_COMPOSITING_MODE": "1",
        "GIO_USE_NETWORK_MONITOR": "base",
    }
    # Outside a snap the same environment is still taken apart.
    plain = dict(before)
    del plain["SNAP"], plain["SNAP_NAME"]
    desktop._linux_environment(plain, frozen=True, isdir=lambda d: True)
    assert "GDK_PIXBUF_MODULE_FILE" not in plain


def test_a_snap_looks_for_zims_in_the_persons_home(monkeypatch, tmp_path):
    """Inside a snap $HOME is ~/snap/zimi/<revision>; the default library went
    there (issue #81: "No ZIM files found in /home/asus/snap/zimi/22/Zimi"),
    and a 1.10.1 snap saved that into its config."""
    import importlib
    import json

    snap_home = tmp_path / "home" / "asus" / "snap" / "zimi" / "22"
    snap_home.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(snap_home))
    monkeypatch.setenv("SNAP_REAL_HOME", "/home/asus")
    mod = importlib.reload(desktop)
    try:
        assert mod._user_home() == "/home/asus"
        assert mod.ConfigManager.DEFAULTS["zim_dir"] == "/home/asus/Zimi"
        cfg_dir = tmp_path / "cfg"
        cfg_dir.mkdir()
        (cfg_dir / "config.json").write_text(json.dumps({"zim_dir": str(snap_home / "Zimi")}), encoding="utf-8")
        monkeypatch.setattr(mod, "_config_dir", lambda: str(cfg_dir))
        assert mod.ConfigManager().get("zim_dir") == "/home/asus/Zimi"
        (cfg_dir / "config.json").write_text(json.dumps({"zim_dir": "/media/usb/zims"}), encoding="utf-8")
        assert mod.ConfigManager().get("zim_dir") == "/media/usb/zims"
    finally:
        monkeypatch.delenv("SNAP_REAL_HOME")
        importlib.reload(desktop)
