"""Zero-config ZIM discovery and the one-level-deep scan (1.9 portable mode).

Two behaviors under test, both bounded by the compatibility contract in
docs/plans/2026-08-07-v19-plan.md:

1. Discovery is the FIFTH, lowest resolution layer. It probes the executable
   directory (frozen builds), the macOS .app container, and the cwd for
   `*.zim` files or a `zims/` child — and it may only ever replace the
   hardcoded fallback (`/zims`, desktop `~/Zimi`). A flag, an environment
   variable, a config file, or a desktop-configured folder always beats it.
   There is one explicit-beats-discovered test per discovery path.

2. The library scan covers ZIM_DIR plus exactly one level of subdirectories.
   Collision rule: root files scan first, larger file wins per short name,
   size ties keep the root copy. Deeper nesting stays out of scope.

Live boots in this file use port 8895 and nothing else.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402

from tests.conftest_zim import build_fixture_zim  # noqa: E402
from tests.test_serve_smoke import REPO_ROOT, _wait_for_ready  # noqa: E402

sys.path.insert(0, os.path.join(REPO_ROOT, "desktop"))

import zimi_desktop  # noqa: E402

LIVE_PORT = "8895"  # the only port live boots in this file may bind


@pytest.fixture
def tmp_tree():
    # realpath: cwd-based discovery reports getcwd(), which resolves the macOS
    # /var → /private/var symlink; the assertions must compare like with like.
    path = os.path.realpath(tempfile.mkdtemp(prefix="zimi-discovery-"))
    yield path
    shutil.rmtree(path, ignore_errors=True)


@pytest.fixture(scope="module")
def fixture_zim_path():
    """One tiny real ZIM per module; tests copy it wherever they need it."""
    d = tempfile.mkdtemp(prefix="zimi-discovery-fixture-")
    path = build_fixture_zim(os.path.join(d, "testzim_en_all_2026-01.zim"))
    yield path
    shutil.rmtree(d, ignore_errors=True)


def _touch_zim(dirpath, name, size=4):
    """A fake .zim file for scan/discovery tests that never open archives."""
    os.makedirs(dirpath, exist_ok=True)
    path = os.path.join(dirpath, name)
    with open(path, "wb") as f:
        f.write(b"Z" * size)
    return path


# ---------------------------------------------------------------------------
# discover_zim_dir: the probe itself
# ---------------------------------------------------------------------------


def test_discovers_zims_directly_in_a_candidate(tmp_tree):
    _touch_zim(tmp_tree, "a.zim")
    assert server.discover_zim_dir([tmp_tree]) == tmp_tree


def test_discovers_a_zims_subdir_inside_a_candidate(tmp_tree):
    sub = os.path.join(tmp_tree, server.DISCOVERY_ZIMS_SUBDIR)
    _touch_zim(sub, "a.zim")
    assert server.discover_zim_dir([tmp_tree]) == sub


def test_direct_zims_beat_the_zims_subdir_within_one_candidate(tmp_tree):
    """Both shapes at once: the candidate itself wins over its zims/ child."""
    _touch_zim(tmp_tree, "root.zim")
    _touch_zim(os.path.join(tmp_tree, server.DISCOVERY_ZIMS_SUBDIR), "child.zim")
    assert server.discover_zim_dir([tmp_tree]) == tmp_tree


def test_first_candidate_with_zims_wins(tmp_tree):
    first = os.path.join(tmp_tree, "first")
    second = os.path.join(tmp_tree, "second")
    _touch_zim(first, "a.zim")
    _touch_zim(second, "b.zim")
    assert server.discover_zim_dir([first, second]) == first
    # A zimless first candidate is skipped, not a dead end.
    empty = os.path.join(tmp_tree, "empty")
    os.makedirs(empty)
    assert server.discover_zim_dir([empty, second]) == second


def test_no_zims_anywhere_returns_none(tmp_tree):
    assert server.discover_zim_dir([tmp_tree]) is None
    assert server.discover_zim_dir([os.path.join(tmp_tree, "missing")]) is None


def test_candidates_are_cwd_only_for_a_source_checkout(monkeypatch, tmp_tree):
    """Unfrozen (pip/source) runs must not probe the Python interpreter's bin
    directory — only the cwd."""
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.delattr(sys, "_MEIPASS", raising=False)
    monkeypatch.chdir(tmp_tree)
    # getcwd() resolves symlinks (macOS /var → /private/var), so compare real paths.
    assert server.discovery_candidates() == [os.getcwd()]


def test_frozen_candidates_include_exe_dir_and_app_container(monkeypatch, tmp_tree):
    """A frozen macOS bundle probes, in order: the dir holding the binary,
    the folder the .app sits in, then the cwd."""
    exe = os.path.join(tmp_tree, "Stick", "Zimi.app", "Contents", "MacOS", "Zimi")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", exe)
    monkeypatch.chdir(tmp_tree)
    assert server.discovery_candidates() == [
        os.path.dirname(exe),
        os.path.join(tmp_tree, "Stick"),
        os.getcwd(),  # symlink-resolved form of tmp_tree on macOS
    ]


# ---------------------------------------------------------------------------
# Precedence: every explicit source beats a discovered directory
# ---------------------------------------------------------------------------


def test_discovered_fills_in_only_the_hardcoded_default():
    settings = server.resolve_settings(env={}, discovered_zim_dir="/media/stick")
    assert settings["zim_dir"] == ("/media/stick", "discovered: /media/stick")
    # State follows the discovered dir, which is what makes the stick work.
    assert settings["data_dir"][0] == os.path.join("/media/stick", ".zimi")


def test_env_zim_dir_beats_discovery():
    """THE compatibility test for the env layer (Docker sets ZIM_DIR)."""
    settings = server.resolve_settings(
        env={"ZIM_DIR": "/env/zims"}, discovered_zim_dir="/media/stick"
    )
    assert settings["zim_dir"] == ("/env/zims", "env: ZIM_DIR")


def test_zim_dir_flag_beats_discovery():
    settings = server.resolve_settings(
        zim_dir_flag="/flag/zims", env={}, discovered_zim_dir="/media/stick"
    )
    assert settings["zim_dir"] == ("/flag/zims", "flag: --zim-dir")


def test_config_file_zim_dir_beats_discovery():
    settings = server.resolve_settings(
        env={},
        config={"zim_dir": "/file/zims"},
        config_path="/etc/zimi.json",
        discovered_zim_dir="/media/stick",
    )
    assert settings["zim_dir"] == ("/file/zims", "config file: /etc/zimi.json")


def test_explicit_data_dir_survives_a_discovered_zim_dir():
    """The derived `<discovered>/.zimi` is a default; an explicit data dir
    from any layer must still win over it."""
    settings = server.resolve_settings(
        env={"ZIMI_DATA_DIR": "/var/lib/zimi"}, discovered_zim_dir="/media/stick"
    )
    assert settings["zim_dir"][0] == "/media/stick"
    assert settings["data_dir"] == ("/var/lib/zimi", "env: ZIMI_DATA_DIR")


def test_empty_string_env_still_beats_discovery():
    """`ZIM_DIR=` resolves to the empty string today; discovery must not
    turn "set to empty" into "unset"."""
    settings = server.resolve_settings(
        env={"ZIM_DIR": ""}, discovered_zim_dir="/media/stick"
    )
    assert settings["zim_dir"][0] == ""


def test_no_discovery_reproduces_the_shipped_defaults():
    settings = server.resolve_settings(env={}, discovered_zim_dir=None)
    assert settings["zim_dir"] == (server.DEFAULT_ZIM_DIR, "default")


# Desktop path: a configured folder (config.json exists) always wins, and an
# explicit ZIM_DIR env beats discovery even on a true first run.


class _FakeDesktopConfig:
    def __init__(self, first_run):
        self._first_run = first_run

    @property
    def is_first_run(self):
        return self._first_run


def test_desktop_configured_folder_beats_discovery(monkeypatch, tmp_tree):
    """config.json existing means the user (or a past run) chose a folder —
    discovery must refuse even with ZIMs sitting in the cwd."""
    _touch_zim(tmp_tree, "a.zim")
    monkeypatch.chdir(tmp_tree)
    monkeypatch.delenv("ZIM_DIR", raising=False)
    assert zimi_desktop._discover_portable_zim_dir(_FakeDesktopConfig(False)) is None


def test_desktop_env_zim_dir_beats_discovery(monkeypatch, tmp_tree):
    _touch_zim(tmp_tree, "a.zim")
    monkeypatch.chdir(tmp_tree)
    monkeypatch.setenv("ZIM_DIR", "/somewhere/else")
    assert zimi_desktop._discover_portable_zim_dir(_FakeDesktopConfig(True)) is None


def test_desktop_first_run_discovers_cwd_zims(monkeypatch, tmp_tree):
    _touch_zim(tmp_tree, "a.zim")
    monkeypatch.chdir(tmp_tree)
    monkeypatch.delenv("ZIM_DIR", raising=False)
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.delattr(sys, "_MEIPASS", raising=False)
    assert zimi_desktop._discover_portable_zim_dir(_FakeDesktopConfig(True)) == tmp_tree


# ---------------------------------------------------------------------------
# One-level-deep scan and its collision rule
# ---------------------------------------------------------------------------


@pytest.fixture
def scan_dir(monkeypatch, tmp_tree):
    monkeypatch.setattr(server, "ZIM_DIR", tmp_tree)
    return tmp_tree


def test_scan_includes_one_level_of_subdirectories(scan_dir):
    _touch_zim(scan_dir, "alpha_en_all_2026-01.zim")
    _touch_zim(os.path.join(scan_dir, "extra"), "bravo_en_all_2026-01.zim")
    zims = server._scan_zim_files()
    assert zims["alpha"] == os.path.join(scan_dir, "alpha_en_all_2026-01.zim")
    assert zims["bravo"] == os.path.join(scan_dir, "extra", "bravo_en_all_2026-01.zim")


def test_scan_ignores_two_levels_deep(scan_dir):
    _touch_zim(os.path.join(scan_dir, "a", "b"), "deep_en_all_2026-01.zim")
    assert server._scan_zim_files() == {}


def test_scan_skips_dot_directories(scan_dir):
    """`.zimi` (state) must never be scanned as content — glob's `*` does not
    match dotted names, and this pins that."""
    _touch_zim(os.path.join(scan_dir, ".zimi"), "state_en_all_2026-01.zim")
    assert server._scan_zim_files() == {}


def test_scan_collision_larger_file_wins_across_directories(scan_dir):
    """Same basename in root and a subfolder: one entry survives, and it is
    the larger file regardless of which directory holds it."""
    _touch_zim(scan_dir, "dup_en_all_2026-01.zim", size=4)
    _touch_zim(os.path.join(scan_dir, "sub"), "dup_en_all_2026-01.zim", size=64)
    zims = server._scan_zim_files()
    assert list(zims) == ["dup"]
    assert zims["dup"] == os.path.join(scan_dir, "sub", "dup_en_all_2026-01.zim")


def test_scan_collision_size_tie_keeps_the_root_copy(scan_dir):
    """The documented rule: an identical duplicate dropped into a subfolder
    can never displace the root file already being served."""
    _touch_zim(scan_dir, "dup_en_all_2026-01.zim", size=16)
    _touch_zim(os.path.join(scan_dir, "sub"), "dup_en_all_2026-01.zim", size=16)
    zims = server._scan_zim_files()
    assert zims["dup"] == os.path.join(scan_dir, "dup_en_all_2026-01.zim")


# ---------------------------------------------------------------------------
# Live boots (port 8895 only)
# ---------------------------------------------------------------------------


def _clean_env(overrides):
    env = os.environ.copy()
    for k in ("ZIM_DIR", "ZIMI_DATA_DIR", "ZIMI_HOST", "ZIMI_PORT", "ZIMI_CONFIG"):
        env.pop(k, None)
    env.update(overrides)
    env["ZIMI_AUTO_UPDATE"] = "0"
    env["ZIMI_TORRENT"] = "0"
    env["ZIMI_PEER_DISCOVERY"] = "0"
    env["PYTHONUNBUFFERED"] = "1"
    # `-m zimi` must resolve from any cwd, including the temp dirs below.
    env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
    return env


def _boot_and_list(cwd, env_overrides, argv=None):
    """Boot `python -m zimi serve --port 8895` from `cwd`, wait for READY,
    GET /list, shut down. Returns the parsed /list payload."""
    argv = argv or [sys.executable, "-m", "zimi", "serve", "--port", LIVE_PORT]
    log_fd, log_path = tempfile.mkstemp(prefix="zimi-discovery-log-")
    os.close(log_fd)
    with open(log_path, "w") as log_f:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=_clean_env(env_overrides),
            stdout=log_f,
            stderr=subprocess.STDOUT,
        )
    try:
        port = _wait_for_ready(proc, log_path)
        assert port == int(LIVE_PORT)
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/list", timeout=5) as resp:
            listing = json.loads(resp.read().decode())
        assert proc.poll() is None, "server exited during the check"
        return listing
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
        try:
            os.remove(log_path)
        except OSError:
            pass


def test_serve_from_a_folder_of_zims_with_no_configuration(tmp_tree, fixture_zim_path):
    """The headline feature: cd into a folder of ZIMs, `zimi serve`, done."""
    shutil.copy(fixture_zim_path, tmp_tree)
    listing = _boot_and_list(tmp_tree, {})
    names = {z["name"] for z in listing}
    assert "testzim" in names
    # And the state landed beside the ZIMs, so the folder stays portable.
    assert os.path.isdir(os.path.join(tmp_tree, ".zimi"))


def test_serve_env_zim_dir_beats_cwd_discovery(tmp_tree, fixture_zim_path):
    """ZIM_DIR pointed elsewhere wins: the cwd's ZIMs are NOT served and no
    state is written into the cwd."""
    cwd = os.path.join(tmp_tree, "cwd-with-zims")
    env_dir = os.path.join(tmp_tree, "env-zims")
    os.makedirs(cwd)
    os.makedirs(env_dir)
    shutil.copy(fixture_zim_path, cwd)
    listing = _boot_and_list(cwd, {"ZIM_DIR": env_dir})
    assert listing == []
    assert os.path.isdir(os.path.join(env_dir, ".zimi"))
    assert not os.path.exists(os.path.join(cwd, ".zimi"))


def test_serve_lists_zims_from_one_level_subdirectories(tmp_tree, fixture_zim_path):
    """An explicit ZIM_DIR whose ZIMs sit one folder down is served whole."""
    sub = os.path.join(tmp_tree, "wikipedia-stuff")
    os.makedirs(sub)
    shutil.copy(fixture_zim_path, sub)
    listing = _boot_and_list(REPO_ROOT, {"ZIM_DIR": tmp_tree})
    names = {z["name"] for z in listing}
    assert "testzim" in names


# ---------------------------------------------------------------------------
# `zimi config` provenance
# ---------------------------------------------------------------------------


def test_config_reports_discovered_provenance(tmp_tree):
    """`zimi config` run inside a folder of ZIMs names the discovery, e.g.
    `(discovered: /Volumes/STICK)`."""
    _touch_zim(tmp_tree, "a.zim")
    proc = subprocess.run(
        [sys.executable, "-m", "zimi", "config"],
        cwd=tmp_tree,
        env=_clean_env({}),
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert f"(discovered: {tmp_tree})" in proc.stdout
    # The derived data dir names the discovered dir but stays a default.
    assert os.path.join(tmp_tree, ".zimi") in proc.stdout


def test_config_discovery_loses_to_env(tmp_tree):
    _touch_zim(tmp_tree, "a.zim")
    proc = subprocess.run(
        [sys.executable, "-m", "zimi", "config"],
        cwd=tmp_tree,
        env=_clean_env({"ZIM_DIR": "/env/zims"}),
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert "(env: ZIM_DIR)" in proc.stdout
    assert "discovered" not in proc.stdout
