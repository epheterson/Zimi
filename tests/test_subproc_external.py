"""A frozen app's children that are not part of it get the machine's environment (issue #151).

PyInstaller's bootloader points LD_LIBRARY_PATH at the bundle and keeps the user's own in
LD_LIBRARY_PATH_ORIG. The machine's python3 started with the bundle's path loads the bundle's older
libssl and cannot import ssl: "the ssl module in Python is not available" while setting up voices.

Run: pytest tests/test_subproc_external.py -v
"""

import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from zimi import subproc  # noqa: E402

BUNDLE = "/opt/zimi/_internal"


def _frozen(monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", BUNDLE, raising=False)
    monkeypatch.setattr(sys, "executable", "/opt/zimi/zimi")


def test_an_outside_program_gets_the_users_library_path(monkeypatch):
    _frozen(monkeypatch)
    env = {
        "LD_LIBRARY_PATH": BUNDLE,
        "LD_LIBRARY_PATH_ORIG": "/usr/local/lib",
        "PYTHONHOME": BUNDLE,
        "_PYI_ARCHIVE_FILE": "x",
        "PATH": "/usr/bin",
    }
    out = subproc.external_env(env)
    assert out["LD_LIBRARY_PATH"] == "/usr/local/lib"
    assert "LD_LIBRARY_PATH_ORIG" not in out and "PYTHONHOME" not in out
    assert "_PYI_ARCHIVE_FILE" not in out and out["PATH"] == "/usr/bin"
    assert env["LD_LIBRARY_PATH"] == BUNDLE, "the input is not changed"


def test_with_no_original_the_library_path_goes(monkeypatch):
    _frozen(monkeypatch)
    out = subproc.external_env({"LD_LIBRARY_PATH": BUNDLE, "DYLD_LIBRARY_PATH": BUNDLE})
    assert "LD_LIBRARY_PATH" not in out and "DYLD_LIBRARY_PATH" not in out


def test_a_source_install_is_untouched(monkeypatch):
    monkeypatch.delattr(sys, "frozen", raising=False)
    env = {"LD_LIBRARY_PATH": "/x", "LD_LIBRARY_PATH_ORIG": "/y"}
    assert subproc.external_env(env) == env


def test_popen_scrubs_for_outside_programs_only(monkeypatch):
    _frozen(monkeypatch)
    seen = []
    monkeypatch.setattr(subprocess, "Popen", lambda cmd, **kw: seen.append(kw))
    monkeypatch.setenv("LD_LIBRARY_PATH", BUNDLE)
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/usr/local/lib")
    subproc.popen(["/usr/bin/python3", "-c", "1"])
    assert seen[-1]["env"]["LD_LIBRARY_PATH"] == "/usr/local/lib"
    subproc.popen(
        ["/opt/zimi/zimi", "--child"]
    )  # the app itself keeps the bundle's environment
    assert "env" not in seen[-1]
    subproc.popen(["/usr/bin/uv"], env={"LD_LIBRARY_PATH": BUNDLE, "A": "1"})
    assert "LD_LIBRARY_PATH" not in seen[-1]["env"] and seen[-1]["env"]["A"] == "1"


def test_run_follows_the_same_rule(monkeypatch):
    _frozen(monkeypatch)
    seen = []
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: seen.append(kw))
    monkeypatch.setenv("LD_LIBRARY_PATH", BUNDLE)
    subproc.run(["/usr/bin/npm", "root"])
    assert "LD_LIBRARY_PATH" not in seen[0]["env"]


def test_doctor_probe_passes_with_the_fix_and_catches_a_leak(monkeypatch, tmp_path):
    """The probe `zimi doctor --check` runs in the frozen smoke test: a real python3 child."""
    from zimi import runtimes

    machine_python = sys.executable
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "zimi"))
    monkeypatch.setenv("LD_LIBRARY_PATH", str(tmp_path))
    assert runtimes.outside_python_problem(machine_python) is None
    monkeypatch.setattr(subproc, "run", subprocess.run)  # the old behaviour: the environment inherited as is
    assert "library path" in runtimes.outside_python_problem(machine_python)


def test_doctor_probe_is_silent_when_not_frozen(monkeypatch):
    from zimi import runtimes

    monkeypatch.delattr(sys, "frozen", raising=False)
    assert runtimes.outside_python_problem() is None


def test_inside_the_bundle_by_either_platforms_rules():
    import ntpath
    import posixpath

    assert subproc._under("/opt/zimi/_internal/lib/x", BUNDLE, posixpath)
    assert subproc._under("/opt/zimi/_internal", BUNDLE + "/", posixpath)
    assert not subproc._under("/opt/zimi/_internal2", BUNDLE, posixpath)
    win = "C:\\Program Files\\Zimi\\_internal"
    assert subproc._under("c:/program files/zimi/_internal/python314.dll", win, ntpath), "slashes and case are one spelling"
    assert subproc._under("C:\\Program Files\\Zimi\\_internal\\", win, ntpath)
    assert not subproc._under("C:\\Program Files\\Zimi\\_internal_x", win, ntpath)
    assert not subproc._under("D:\\Program Files\\Zimi\\_internal", win, ntpath)


def test_a_python_path_list_naming_the_bundle_is_dropped_whatever_its_spelling(monkeypatch):
    _frozen(monkeypatch)
    out = subproc.external_env({"PYTHONPATH": os.pathsep.join(["/somewhere/else", BUNDLE + "/lib-dynload"]), "PYTHONHOME": BUNDLE + "/"})
    assert "PYTHONPATH" not in out and "PYTHONHOME" not in out
    kept = subproc.external_env({"PYTHONPATH": "/somewhere/else", "PYTHONHOME": "/usr/lib/python3"})
    assert kept == {"PYTHONPATH": "/somewhere/else", "PYTHONHOME": "/usr/lib/python3"}


def test_a_bare_program_name_is_looked_up_on_the_childs_path_not_in_the_bundle(monkeypatch, tmp_path):
    """Started from the bundle's folder, "piper" must not be taken for the bundle's own file of that name: it is what PATH finds."""
    app, outside = tmp_path / "app", tmp_path / "bin"
    app.mkdir()
    outside.mkdir()
    for folder in (app, outside):
        exe = folder / "piper"
        exe.write_text("#!/bin/sh\n")
        exe.chmod(0o755)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(app), raising=False)
    monkeypatch.setattr(sys, "executable", str(app / "zimi"))
    seen = []
    monkeypatch.setattr(subprocess, "Popen", lambda cmd, **kw: seen.append(kw))
    monkeypatch.setenv("LD_LIBRARY_PATH", str(app))
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/usr/local/lib")
    monkeypatch.setenv("PATH", str(outside))
    monkeypatch.chdir(app)
    subproc.popen(["piper", "--help"])
    assert seen[-1]["env"]["LD_LIBRARY_PATH"] == "/usr/local/lib"
    assert subproc._resolved("piper") == str(outside / "piper")
    assert not subproc._in_bundle("piper")
