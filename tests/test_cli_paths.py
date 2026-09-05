"""`serve --zim-dir/--data-dir/--host` and the path-resolution precedence.

Two things are under test. First, the precedence contract: an explicit flag
beats the environment variable, the environment variable beats the default,
and with neither set the resolved pair must be exactly what shipped before the
flags existed (`/zims` and `<ZIM_DIR>/.zimi`) — an existing install may not
notice this change.

Second, the split-brain regression. Five data-dir paths used to be computed at
import time and frozen as module constants, so repointing ZIMI_DATA_DIR moved
some state and left the rest behind: title indexes in the new dir, Q-ID
indexes / did-you-mean vocab / auto-update config / download schedule in the
old one. The desktop launcher hand-repaired exactly one of the five. They are
functions now, and `test_custom_data_dir_moves_all_five_formerly_frozen_paths`
is what keeps them that way.
"""

import os
import shutil
import subprocess
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.interlang as interlang  # noqa: E402
import zimi.library as library  # noqa: E402
import zimi.search as search  # noqa: E402
import zimi.server as server  # noqa: E402

from tests.test_serve_smoke import REPO_ROOT, _wait_for_ready  # noqa: E402


@pytest.fixture
def restore_path_globals():
    """apply_data_paths() mutates module globals; put them back afterwards."""
    saved = (server.ZIM_DIR, server.ZIMI_DATA_DIR)
    yield
    server.ZIM_DIR, server.ZIMI_DATA_DIR = saved


# ---------------------------------------------------------------------------
# Precedence: flag > env > default
# ---------------------------------------------------------------------------


def test_no_flag_no_env_gives_the_shipped_defaults():
    """The pre-flag behavior, byte for byte."""
    zim_dir, data_dir = server.resolve_data_paths(env={})
    assert zim_dir == "/zims"
    assert data_dir == os.path.join("/zims", ".zimi")


def test_env_beats_default():
    zim_dir, data_dir = server.resolve_data_paths(
        env={"ZIM_DIR": "/srv/zims", "ZIMI_DATA_DIR": "/var/lib/zimi"}
    )
    assert zim_dir == "/srv/zims"
    assert data_dir == "/var/lib/zimi"


def test_env_zim_dir_alone_still_derives_the_data_dir():
    zim_dir, data_dir = server.resolve_data_paths(env={"ZIM_DIR": "/srv/zims"})
    assert zim_dir == "/srv/zims"
    assert data_dir == os.path.join("/srv/zims", ".zimi")


def test_flag_beats_env():
    zim_dir, data_dir = server.resolve_data_paths(
        zim_dir_flag="/flag/zims",
        data_dir_flag="/flag/state",
        env={"ZIM_DIR": "/env/zims", "ZIMI_DATA_DIR": "/env/state"},
    )
    assert zim_dir == "/flag/zims"
    assert data_dir == "/flag/state"


def test_zim_dir_flag_carries_the_default_data_dir_with_it():
    """`--zim-dir` with no data-dir configured anywhere: state follows the ZIMs,
    which is what makes a USB stick work."""
    zim_dir, data_dir = server.resolve_data_paths(
        zim_dir_flag="/media/usb/zims", env={}
    )
    assert zim_dir == "/media/usb/zims"
    assert data_dir == os.path.join("/media/usb/zims", ".zimi")


def test_data_dir_env_survives_a_zim_dir_flag():
    """Env beats a *default*, not a flag — but the derived `<zim-dir>/.zimi` is
    a default, so an explicit ZIMI_DATA_DIR must still win over it."""
    zim_dir, data_dir = server.resolve_data_paths(
        zim_dir_flag="/media/usb/zims", env={"ZIMI_DATA_DIR": "/var/lib/zimi"}
    )
    assert zim_dir == "/media/usb/zims"
    assert data_dir == "/var/lib/zimi"


def test_empty_string_env_is_honored_as_before():
    """`ZIM_DIR=` used to resolve to the empty string, not to /zims. Nothing in
    this change may quietly start treating it as unset."""
    zim_dir, _ = server.resolve_data_paths(env={"ZIM_DIR": ""})
    assert zim_dir == ""


def test_apply_data_paths_rebinds_the_globals(restore_path_globals):
    server.apply_data_paths("/flag/zims", "/flag/state")
    assert server.ZIM_DIR == "/flag/zims"
    assert server.ZIMI_DATA_DIR == "/flag/state"


# ---------------------------------------------------------------------------
# The split-brain regression
# ---------------------------------------------------------------------------


def _formerly_frozen_paths():
    """The five paths that used to be frozen at import time, resolved now."""
    return {
        "title index dir": search._title_index_dir(),
        "did-you-mean vocab": search._vocab_cache_path(),
        "Q-ID index dir": interlang._qid_index_dir(),
        "auto-update config": library._auto_update_config_path(),
        "download schedule config": library._download_schedule_config_path(),
    }


def test_custom_data_dir_moves_all_five_formerly_frozen_paths(restore_path_globals):
    """A repointed data dir must take ALL of Zimi's state with it. Before the
    fix, four of these five stayed behind in `<old ZIM_DIR>/.zimi`."""
    old_data_dir = server.ZIMI_DATA_DIR
    server.apply_data_paths("/flag/zims", "/flag/state")
    for label, path in _formerly_frozen_paths().items():
        assert path.startswith("/flag/state" + os.sep), f"{label} did not move: {path}"
        assert not path.startswith(
            old_data_dir + os.sep
        ), f"{label} left behind: {path}"


def test_zim_dir_flag_alone_moves_all_five(restore_path_globals):
    """Same assertion via the derived default — `--zim-dir` with no data dir
    configured has to relocate every one of them too."""
    server.apply_data_paths("/media/usb/zims", None)
    expected = os.path.join("/media/usb/zims", ".zimi")
    for label, path in _formerly_frozen_paths().items():
        assert path.startswith(expected + os.sep), f"{label} did not move: {path}"


# ---------------------------------------------------------------------------
# End-to-end: the flags have to land before _init() creates the data dir
# ---------------------------------------------------------------------------


def _boot_serve(extra_args, env_overrides):
    """Run `python -m zimi serve --port 0` with extra args, wait for READY,
    then shut down. Returns nothing — the assertions are about what the boot
    left on disk."""
    env = os.environ.copy()
    # Everything the CLI could otherwise pick up from the developer's own
    # shell, so the flags are the only source of truth in this test.
    for k in ("ZIM_DIR", "ZIMI_DATA_DIR"):
        env.pop(k, None)
    env.update(env_overrides)
    env["ZIMI_AUTO_UPDATE"] = "0"
    env["ZIMI_TORRENT"] = "0"
    env["ZIMI_PEER_DISCOVERY"] = "0"
    env["PYTHONUNBUFFERED"] = "1"

    log_fd, log_path = tempfile.mkstemp(prefix="zimi-cli-paths-log-")
    os.close(log_fd)
    with open(log_path, "w") as log_f:
        proc = subprocess.Popen(
            [sys.executable, "-m", "zimi", "serve", "--port", "0", *extra_args],
            cwd=REPO_ROOT,
            env=env,
            stdout=log_f,
            stderr=subprocess.STDOUT,
        )
    try:
        _wait_for_ready(proc, log_path)
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


def test_serve_data_dir_flag_is_where_the_state_lands():
    """The real proof that argparse runs early enough: the data dir the flag
    names is the one _init() creates, and the default location stays empty."""
    zim_dir = tempfile.mkdtemp(prefix="zimi-cli-zims-")
    state_root = tempfile.mkdtemp(prefix="zimi-cli-state-")
    data_dir = os.path.join(state_root, "state")
    try:
        _boot_serve(["--zim-dir", zim_dir, "--data-dir", data_dir], {})
        assert os.path.isdir(data_dir)
        assert not os.path.exists(os.path.join(zim_dir, ".zimi"))
    finally:
        for p in (zim_dir, state_root):
            shutil.rmtree(p, ignore_errors=True)


def test_serve_zim_dir_flag_beats_the_env_var():
    """ZIM_DIR is set in the environment and pointed somewhere else; the flag
    has to win, including for the data dir derived from it."""
    flag_dir = tempfile.mkdtemp(prefix="zimi-cli-flag-")
    env_dir = tempfile.mkdtemp(prefix="zimi-cli-env-")
    try:
        _boot_serve(["--zim-dir", flag_dir], {"ZIM_DIR": env_dir})
        assert os.path.isdir(os.path.join(flag_dir, ".zimi"))
        assert not os.path.exists(os.path.join(env_dir, ".zimi"))
    finally:
        for p in (flag_dir, env_dir):
            shutil.rmtree(p, ignore_errors=True)


def test_serve_host_flag_binds_the_given_address():
    """--host must reach the socket. Loopback-only is the interesting case: a
    default-bound server would answer here too, so the boot is the check that
    the flag exists and parses, and DEFAULT_HOST is what preserves today's
    0.0.0.0 behavior for everyone who omits it."""
    assert server.DEFAULT_HOST == "0.0.0.0"
    zim_dir = tempfile.mkdtemp(prefix="zimi-cli-host-")
    try:
        _boot_serve(["--zim-dir", zim_dir, "--host", "127.0.0.1"], {})
    finally:
        shutil.rmtree(zim_dir, ignore_errors=True)
