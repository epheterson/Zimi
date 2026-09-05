"""Read-only media, phase 3 of the zero-config portable plan.

Two behaviors under test. First, the automatic data-dir fallback: when the
DERIVED default `<zim_dir>/.zimi` cannot be written (read-only stick, DVD,
locked share), state reroutes to a stable per-library directory under the
platform user-cache location — stable so the indexes built on the first boot
are found again on the next one. An EXPLICITLY configured data dir never
reroutes: the user asked for that path, so an unwritable one is a one-line
error (exit 2 from the CLI), not a silent relocation.

Second, the last two write paths that used to raise a traceback on read-only
media: `_set_manage_password` and `_generate_api_token` now fail soft, and
their HTTP callers answer with a generic 500 JSON (the real OSError stays in
the server log).

All read-only directories here are chmod-based fixtures, restored in teardown
so pytest's tmp cleanup works.
"""

import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402
from zimi import manage  # noqa: E402

from tests.test_serve_smoke import REPO_ROOT  # noqa: E402

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def restore_path_globals():
    """The fallback machinery rebinds module globals; put every one back."""
    saved = (
        server.ZIM_DIR,
        server.ZIMI_DATA_DIR,
        server._data_dir_source,
        server._data_dir_fallback_from,
    )
    yield
    (
        server.ZIM_DIR,
        server.ZIMI_DATA_DIR,
        server._data_dir_source,
        server._data_dir_fallback_from,
    ) = saved


@pytest.fixture
def cache_home(tmp_path, monkeypatch):
    """Point every platform's cache-root anchor at a throwaway HOME so the
    fallback never touches the developer's real ~/Library/Caches or ~/.cache."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_CACHE_HOME", str(home / ".cache"))
    monkeypatch.setenv("LOCALAPPDATA", str(home / "AppData" / "Local"))
    return str(home)


@pytest.fixture
def ro_zim_dir(tmp_path):
    """A ZIM dir on 'read-only media': exists, listable, not writable."""
    d = tmp_path / "stick"
    d.mkdir()
    (d / "dummy.zim").write_bytes(b"")  # looks like a library, never opened
    os.chmod(d, 0o555)
    yield str(d)
    os.chmod(d, 0o755)


def _cache_env(home):
    """Subprocess environment matching the cache_home fixture, with the
    shell's own Zimi variables stripped so the flags are the only input."""
    env = os.environ.copy()
    for k in ("ZIM_DIR", "ZIMI_DATA_DIR", "ZIMI_CONFIG"):
        env.pop(k, None)
    env["HOME"] = home
    env["XDG_CACHE_HOME"] = os.path.join(home, ".cache")
    env["LOCALAPPDATA"] = os.path.join(home, "AppData", "Local")
    return env


# ---------------------------------------------------------------------------
# The fallback path scheme
# ---------------------------------------------------------------------------


def test_fallback_path_is_stable_per_library(cache_home):
    """Same library → same cache dir, boot after boot — that is what lets a
    read-only stick keep its indexes. Different library → different dir."""
    first = server.fallback_data_dir("/Volumes/STICK")
    second = server.fallback_data_dir("/Volumes/STICK")
    assert first == second
    assert first != server.fallback_data_dir("/Volumes/OTHER")
    # Readable prefix + hash tail, under the platform cache root.
    assert os.path.basename(first).startswith("STICK-")
    assert first.startswith(server._platform_cache_root() + os.sep)


def test_fallback_path_survives_a_hostile_folder_name(cache_home):
    """Spaces and separators sanitize to a filesystem-safe single component."""
    path = server.fallback_data_dir("/media/usb/My ZIMs (backup)")
    name = os.path.basename(path)
    assert os.sep not in name and " " not in name and "(" not in name


# ---------------------------------------------------------------------------
# Derived default: falls back
# ---------------------------------------------------------------------------


def test_derived_default_falls_back_to_the_stable_cache_dir(
    ro_zim_dir, cache_home, restore_path_globals
):
    server.apply_data_paths(ro_zim_dir, None)
    assert server.ZIMI_DATA_DIR == os.path.join(ro_zim_dir, ".zimi")
    server._ensure_writable_data_dir()
    expected = server.fallback_data_dir(ro_zim_dir)
    assert server.ZIMI_DATA_DIR == expected
    assert server._data_dir_fallback_from == os.path.join(ro_zim_dir, ".zimi")
    # A second boot of the same library lands in the SAME place.
    server.apply_data_paths(ro_zim_dir, None)
    server._ensure_writable_data_dir()
    assert server.ZIMI_DATA_DIR == expected


def test_fallback_is_idempotent_within_one_boot(
    ro_zim_dir, cache_home, restore_path_globals, caplog
):
    """main() probes early for the CLI, _init() probes again for library
    entry points — the reroute and its log line must happen exactly once."""
    server.apply_data_paths(ro_zim_dir, None)
    with caplog.at_level("WARNING", logger="zimi"):
        server._ensure_writable_data_dir()
        server._ensure_writable_data_dir()
    assert server.ZIMI_DATA_DIR == server.fallback_data_dir(ro_zim_dir)
    assert caplog.text.count("is not writable") == 1


def test_existing_readonly_state_is_bypassed_wholesale(
    tmp_path, cache_home, restore_path_globals, caplog
):
    """A stick that already carries `.zimi` but read-only: no two-layer
    overlay — the cache dir is used wholesale and the log says so."""
    stick = tmp_path / "stick2"
    state = stick / ".zimi"
    state.mkdir(parents=True)
    (state / "cache.json").write_text("{}")
    os.chmod(state, 0o555)
    os.chmod(stick, 0o555)
    try:
        server.apply_data_paths(str(stick), None)
        with caplog.at_level("WARNING", logger="zimi"):
            server._ensure_writable_data_dir()
        assert server.ZIMI_DATA_DIR == server.fallback_data_dir(str(stick))
        assert "read-only state beside the ZIMs" in caplog.text
    finally:
        os.chmod(stick, 0o755)
        os.chmod(state, 0o755)


def test_missing_zim_dir_keeps_the_shipped_fail_soft_boot(
    tmp_path, cache_home, restore_path_globals
):
    """No library → nothing to keep state for. The pre-1.9 behavior (data
    dir unwritable, writes fail soft) must not grow a surprise cache dir."""
    ghost = str(tmp_path / "does-not-exist")
    server.apply_data_paths(ghost, None)
    server._ensure_writable_data_dir()
    assert server.ZIMI_DATA_DIR == os.path.join(ghost, ".zimi")
    assert server._data_dir_fallback_from is None


def test_writable_derived_default_is_untouched(tmp_path, restore_path_globals):
    """The normal case must stay byte-for-byte the normal case."""
    zims = tmp_path / "zims"
    zims.mkdir()
    server.apply_data_paths(str(zims), None)
    server._ensure_writable_data_dir()
    assert server.ZIMI_DATA_DIR == str(zims / ".zimi")
    assert server._data_dir_fallback_from is None


# ---------------------------------------------------------------------------
# Explicit data dir: errors, never reroutes
# ---------------------------------------------------------------------------


def test_explicit_unwritable_data_dir_raises_not_falls_back(
    ro_zim_dir, tmp_path, cache_home, restore_path_globals
):
    zims = tmp_path / "zims"
    zims.mkdir()
    wanted = os.path.join(ro_zim_dir, "state")
    server.apply_data_paths(str(zims), wanted)
    with pytest.raises(server.DataDirError):
        server._ensure_writable_data_dir()
    # No silent relocation: the bound dir is still the one the user asked for.
    assert server.ZIMI_DATA_DIR == wanted
    assert server._data_dir_fallback_from is None


def test_explicit_writable_data_dir_beside_readonly_zims_still_wins(
    ro_zim_dir, tmp_path, restore_path_globals
):
    """The pre-existing zero-error mechanism (RO ZIM_DIR + writable
    ZIMI_DATA_DIR) is exactly what the fallback must never interfere with."""
    state = tmp_path / "state"
    server.apply_data_paths(ro_zim_dir, str(state))
    server._ensure_writable_data_dir()
    assert server.ZIMI_DATA_DIR == str(state)
    assert server._data_dir_fallback_from is None


# ---------------------------------------------------------------------------
# CLI surface: exit code and `zimi config` provenance
# ---------------------------------------------------------------------------


def _run_cli(args, env):
    return subprocess.run(
        [sys.executable, "-m", "zimi", *args],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_cli_explicit_unwritable_data_dir_exits_2(ro_zim_dir, tmp_path):
    """An explicit unwritable data dir is fatal for commands that would write
    (exit 2, one line) — but `zimi config` is the diagnostic you reach for to
    debug exactly that misconfiguration, so it prints the resolution with a
    warning underneath instead of refusing to print at all."""
    zims = tmp_path / "zims"
    zims.mkdir()
    args = ["--zim-dir", str(zims), "--data-dir", os.path.join(ro_zim_dir, "state")]
    env = _cache_env(str(tmp_path))

    # backup, not list: only serve/config/backup/restore carry the boot flags.
    proc = _run_cli(["backup", str(tmp_path / "out.json")] + args, env)
    assert proc.returncode == 2
    assert "not writable" in proc.stderr
    assert "Traceback" not in proc.stderr

    proc = _run_cli(["config"] + args, env)
    assert proc.returncode == 0
    assert "warning:" in proc.stdout and "not writable" in proc.stdout
    assert "Traceback" not in proc.stderr


def test_cli_config_reports_the_fallback_as_provenance(ro_zim_dir, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    proc = _run_cli(["config", "--zim-dir", ro_zim_dir], _cache_env(str(home)))
    assert proc.returncode == 0, proc.stderr
    data_dir_line = next(
        line for line in proc.stdout.splitlines() if line.startswith("data_dir")
    )
    assert f"(fallback: {os.path.join(ro_zim_dir, '.zimi')} not writable)" in (
        data_dir_line
    )
    # The value column is the cache dir actually in effect — computed in a
    # subprocess with the same redirected HOME, since fallback_data_dir
    # resolves the platform cache root from the environment at call time.
    expected = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; sys.path.insert(0, %r); import zimi.server as s; "
            "print(s.fallback_data_dir(%r))" % (REPO_ROOT, ro_zim_dir),
        ],
        env=_cache_env(str(home)),
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert expected in data_dir_line


# ---------------------------------------------------------------------------
# Fail-soft credential writes
# ---------------------------------------------------------------------------


@pytest.fixture
def ro_data_dir(tmp_path):
    """ZIMI_DATA_DIR pointed straight at an unwritable directory, restored
    afterwards — the state a read-only boot WITHOUT the fallback would hit."""
    d = tmp_path / "rodata"
    d.mkdir()
    os.chmod(d, 0o555)
    saved = server.ZIMI_DATA_DIR
    server.ZIMI_DATA_DIR = str(d)
    manage._env_pw_hash_cache = None
    yield str(d)
    server.ZIMI_DATA_DIR = saved
    os.chmod(d, 0o755)


def test_set_password_on_readonly_media_fails_soft(ro_data_dir):
    assert manage._set_manage_password("secret") is False
    assert os.listdir(ro_data_dir) == []  # no half-written tmp left behind


def test_set_password_still_reports_success_when_writable(
    tmp_path, restore_path_globals
):
    writable = tmp_path / "data"
    writable.mkdir()
    server.ZIMI_DATA_DIR = str(writable)
    assert manage._set_manage_password("secret") is True
    assert manage._set_manage_password("") is True  # clearing succeeds too


def test_generate_token_on_readonly_media_returns_none(ro_data_dir):
    assert manage._generate_api_token() is None
    assert os.listdir(ro_data_dir) == []


def test_set_password_http_route_returns_generic_500(ro_data_dir, monkeypatch):
    """End of the wire: the handler answers 500 with a fixed message — no
    OSError text, no filesystem path — and never raises."""
    from urllib.parse import urlparse

    for var in ("ZIMI_MANAGE_PASSWORD", "ZIMI_MANAGE_USER"):
        monkeypatch.delenv(var, raising=False)

    class _Handler:
        headers = {}
        status = body = None

        def _is_private_client(self):
            return True  # passwordless + private → authorized to set one

        def _json(self, status, body):
            self.status, self.body = status, body

    h = _Handler()
    manage.handle_manage_post(h, urlparse("/manage/set-password"), {"password": "pw"})
    assert h.status == 500
    assert h.body["error"] == "Could not save the password (storage is not writable)"
    assert ro_data_dir not in h.body["error"]


def test_generate_token_http_route_returns_generic_500(ro_data_dir, monkeypatch):
    from urllib.parse import urlparse

    # Password supplied via env (readable), so auth passes while disk refuses.
    monkeypatch.setenv("ZIMI_MANAGE_PASSWORD", "pw")
    manage._env_pw_hash_cache = None

    class _Handler:
        headers = {"Authorization": "Bearer pw"}
        status = body = None

        def _is_private_client(self):
            return True

        def _json(self, status, body):
            self.status, self.body = status, body

    h = _Handler()
    manage.handle_manage_post(h, urlparse("/manage/generate-token"), {})
    manage._env_pw_hash_cache = None
    assert h.status == 500
    assert h.body["error"] == "Could not save the API token (storage is not writable)"
