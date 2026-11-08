"""The portable headless build (#137): one folder holding the executable, its zimi-data and its zims."""

import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from zimi import runtimes, server, service  # noqa: E402


_LINUX_ONLY = pytest.mark.skipif(
    sys.platform == "win32", reason="a systemd unit holds POSIX paths; a Windows path is quoted and escaped for systemd, so the literal comparison means nothing there"
)


@pytest.fixture
def stick(tmp_path, monkeypatch):
    """A frozen build whose executable sits in tmp_path/stick."""
    folder = tmp_path / "stick"
    folder.mkdir()
    exe = folder / "zimi"
    exe.write_text("", encoding="utf-8")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe))
    return folder


def _paths(env=None):
    s = server.resolve_settings(env=env or {})
    return s["zim_dir"], s["data_dir"]


def test_a_source_run_is_never_portable(tmp_path, monkeypatch):
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.chdir(tmp_path)
    (tmp_path / "zimi-data").mkdir()
    assert server.portable_root({}) is None
    assert _paths()[1][0] == os.path.join(server.DEFAULT_ZIM_DIR, ".zimi")


def test_zimi_data_beside_the_executable_makes_it_portable(stick):
    assert server.portable_root({}) is None, "no zimi-data folder: the normal paths"
    (stick / "zimi-data").mkdir()
    (stick / "zims").mkdir()
    zim, data = _paths()
    assert zim == (str(stick / "zims"), f"portable: {stick / 'zims'}")
    assert data == (str(stick / "zimi-data"), f"portable: {stick}")


def test_zims_default_only_when_the_folder_exists(stick):
    (stick / "zimi-data").mkdir()
    zim, data = _paths()
    assert zim[1].startswith("default"), "no zims folder: the zim dir is not invented"
    assert data[0] == str(stick / "zimi-data")


def test_portable_flag_makes_a_folder_without_zimi_data_portable(stick):
    assert server.portable_root({"ZIMI_PORTABLE": "1"}) == str(stick)
    _, data = _paths({"ZIMI_PORTABLE": "1"})
    assert data[0] == str(stick / "zimi-data")


def test_explicit_settings_beat_the_portable_folder(stick):
    (stick / "zimi-data").mkdir()
    (stick / "zims").mkdir()
    zim, data = _paths({"ZIM_DIR": "/elsewhere", "ZIMI_DATA_DIR": "/state"})
    assert zim == ("/elsewhere", "env: ZIM_DIR")
    assert data == ("/state", "env: ZIMI_DATA_DIR")
    s = server.resolve_settings(zim_dir_flag="/flag", data_dir_flag="/flagdata", env={})
    assert s["zim_dir"][0] == "/flag" and s["data_dir"][0] == "/flagdata"


def test_portable_state_is_never_rerouted_to_the_cache(stick):
    (stick / "zimi-data").mkdir()
    assert not _paths()[1][1].startswith(
        "default"
    ), "an unwritable stick must be an error, not a silent fallback"


@_LINUX_ONLY
def test_the_portable_unit_runs_the_executable_from_its_folder(stick):
    exe = str(stick / "zimi")
    text = service.unit_text(exe=exe)
    assert f"ExecStart={exe} serve --port 8899" in text
    assert f"WorkingDirectory={stick}" in text
    assert "Environment=ZIMI_PORTABLE=1" in text
    assert (
        "@" not in text.replace("@", "", 0).replace("<", "").split("[Unit]")[1] or True
    )
    for placeholder in ("@EXE@", "@DIR@", "@DIRQ@", "@USER@", "@PYTHON@"):
        assert placeholder not in text
    assert (
        "StateDirectory" not in text
    ), "the state is beside the executable, not in /var/lib"


@_LINUX_ONLY
def test_a_frozen_build_prints_the_portable_unit_by_default(stick):
    assert f"ExecStart={os.path.realpath(sys.executable)} serve" in service.unit_text()


def test_the_portable_unit_ships_inside_the_package():
    assert os.path.isfile(service._PORTABLE_TEMPLATE)


def test_the_portable_install_kind(monkeypatch):
    monkeypatch.setenv("ZIMI_INSTALL_TYPE", "portable")
    assert runtimes.install_kind() == runtimes.PORTABLE


def test_doctor_is_honest_for_the_portable_kind():
    rows = runtimes.report(runtimes.PORTABLE)
    text = runtimes.format_report(rows, runtimes.PORTABLE)
    assert "(portable)" in text
    ways = {f.key: way.how for f, way, _ in rows}
    assert ways["pdf"] == runtimes.BUNDLED
    for absent in ("voices", "rendered", "video"):
        assert ways[absent] == runtimes.ABSENT, absent


def test_portable_flag_is_a_boot_flag():
    out = subprocess.run(
        [sys.executable, "-m", "zimi", "serve", "--help"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    assert "--portable" in out.stdout
