"""The image's entrypoint: a fresh root-owned data folder, then drop to zimi.

The real root path is proven in a container; these tests pin
the decisions with the privileged calls replaced by recorders.
"""

import importlib.util
import os
import types

import pytest

# The entrypoint runs only in the Linux image; it needs pwd and grp.
pytest.importorskip("pwd")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load():
    spec = importlib.util.spec_from_file_location(
        "zimi_entrypoint", os.path.join(ROOT, "packaging", "docker", "entrypoint.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def ep():
    return _load()


@pytest.fixture
def root_run(ep, monkeypatch, tmp_path):
    """Run main() as if root: record chowns, the drop and the exec."""
    calls = types.SimpleNamespace(chown=[], dropped=False, exec=None)
    user = types.SimpleNamespace(
        pw_name="zimi", pw_uid=1000, pw_gid=1000, pw_dir="/home/zimi"
    )
    monkeypatch.setattr(ep.os, "geteuid", lambda: 0)
    monkeypatch.setattr(ep.pwd, "getpwnam", lambda name: user)
    monkeypatch.setattr(ep.os, "lchown", lambda p, u, g: calls.chown.append((p, u, g)))
    monkeypatch.setattr(
        ep, "drop_privileges", lambda u: setattr(calls, "dropped", True)
    )
    monkeypatch.setattr(ep.os, "execvp", lambda f, a: setattr(calls, "exec", (f, a)))
    return calls


def _as_owner(ep, monkeypatch, uid):
    """Make os.stat report `uid` as the owner of everything."""
    real = os.stat

    def fake(path, *a, **k):
        st = real(path, *a, **k)
        return types.SimpleNamespace(st_uid=uid, st_gid=uid, st_mode=st.st_mode)

    monkeypatch.setattr(ep.os, "stat", fake)


def test_data_dir_comes_from_the_flag_then_the_environment(ep):
    assert (
        ep.data_dir_from(["serve", "--data-dir", "/a"], {"ZIMI_DATA_DIR": "/b"}) == "/a"
    )
    assert ep.data_dir_from(["serve", "--data-dir=/a"], {}) == "/a"
    assert ep.data_dir_from(["serve"], {"ZIMI_DATA_DIR": "/b"}) == "/b"
    assert ep.data_dir_from(["serve"], {}) is None


def test_a_root_owned_data_folder_is_taken_then_privileges_drop(
    ep, root_run, monkeypatch, tmp_path
):
    data = tmp_path / "config"
    (data / "sub").mkdir(parents=True)
    (data / "sub" / "f.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(ep, "_writable_by", lambda uid, gid, p: False)
    _as_owner(ep, monkeypatch, 0)
    ep.main(["python3", "-m", "zimi", "serve"], {"ZIMI_DATA_DIR": str(data)})
    taken = {p for p, u, g in root_run.chown}
    assert taken == {str(data), str(data / "sub"), str(data / "sub" / "f.json")}
    assert all((u, g) == (1000, 1000) for _, u, g in root_run.chown)
    assert root_run.dropped
    assert root_run.exec == ("python3", ["python3", "-m", "zimi", "serve"])


def test_a_missing_data_folder_is_created_and_owned(ep, root_run, tmp_path):
    data = tmp_path / "new" / "config"
    ep.main(["python3"], {"ZIMI_DATA_DIR": str(data)})
    assert data.is_dir()
    assert root_run.chown == [(str(data), 1000, 1000)]
    assert root_run.dropped


def test_a_folder_zimi_can_already_write_is_left_alone(
    ep, root_run, monkeypatch, tmp_path
):
    monkeypatch.setattr(ep, "_writable_by", lambda uid, gid, p: True)
    ep.main(["python3"], {"ZIMI_DATA_DIR": str(tmp_path)})
    assert root_run.chown == []
    assert root_run.dropped


def test_someone_elses_folder_is_never_taken_and_the_error_says_how(
    ep, root_run, monkeypatch, tmp_path, capsys
):
    monkeypatch.setattr(ep, "_writable_by", lambda uid, gid, p: False)
    _as_owner(ep, monkeypatch, 1026)
    ep.main(["python3"], {"ZIMI_DATA_DIR": str(tmp_path)})
    assert root_run.chown == []
    err = capsys.readouterr().err
    assert "owned by uid 1026" in err and "--user 1026" in err
    assert root_run.dropped, "still drops: Zimi's own check then stops with its message"


def test_the_zim_and_extra_folders_are_never_touched(
    ep, root_run, monkeypatch, tmp_path
):
    zims, extra, data = tmp_path / "zims", tmp_path / "nomad", tmp_path / "config"
    for d in (zims, extra, data):
        d.mkdir()
        (d / "a.zim").write_text("x", encoding="utf-8")
    monkeypatch.setattr(ep, "_writable_by", lambda uid, gid, p: False)
    _as_owner(ep, monkeypatch, 0)
    env = {
        "ZIMI_DATA_DIR": str(data),
        "ZIM_DIR": str(zims),
        "ZIMI_EXTRA_ZIM_DIRS": str(extra),
    }
    ep.main(["python3"], env)
    assert root_run.chown
    assert all(p.startswith(str(data)) for p, _, _ in root_run.chown)


def test_a_symlink_inside_the_data_folder_is_not_followed(
    ep, root_run, monkeypatch, tmp_path
):
    data, outside = tmp_path / "config", tmp_path / "elsewhere"
    data.mkdir()
    outside.mkdir()
    (outside / "keep.txt").write_text("x", encoding="utf-8")
    os.symlink(outside, data / "link")
    monkeypatch.setattr(ep, "_writable_by", lambda uid, gid, p: False)
    _as_owner(ep, monkeypatch, 0)
    ep.main(["python3"], {"ZIMI_DATA_DIR": str(data)})
    taken = {p for p, _, _ in root_run.chown}
    assert str(data / "link") in taken
    assert not any(p.startswith(str(outside)) for p in taken)


def test_no_data_folder_means_nothing_is_chowned(ep, root_run):
    ep.main(["python3"], {})
    assert root_run.chown == []
    assert root_run.dropped


def test_started_as_a_non_root_user_attempts_nothing_and_names_the_problem(
    ep, monkeypatch, tmp_path, capsys
):
    if os.geteuid() == 0:
        pytest.skip("needs a non-root runner")
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o555)
    chowned, execed = [], []
    monkeypatch.setattr(ep.os, "lchown", lambda *a: chowned.append(a))
    monkeypatch.setattr(ep.os, "execvp", lambda f, a: execed.append((f, a)))
    try:
        ep.main(["python3"], {"ZIMI_DATA_DIR": str(locked / "config")})
    finally:
        locked.chmod(0o755)
    assert chowned == []
    assert execed, "the server still starts, and its own check reports"
    assert "not writable by uid" in capsys.readouterr().err


def test_a_writable_data_folder_as_non_root_is_silent(
    ep, monkeypatch, tmp_path, capsys
):
    if os.geteuid() == 0:
        pytest.skip("needs a non-root runner")
    monkeypatch.setattr(ep.os, "execvp", lambda f, a: None)
    ep.main(["python3"], {"ZIMI_DATA_DIR": str(tmp_path)})
    assert capsys.readouterr().err == ""


def test_an_empty_library_folder_is_taken_but_one_with_files_is_not(
    ep, root_run, monkeypatch, tmp_path
):
    empty, full, data = tmp_path / "empty", tmp_path / "full", tmp_path / "config"
    for d in (empty, full, data):
        d.mkdir()
    (full / "a.zim").write_text("x", encoding="utf-8")
    monkeypatch.setattr(ep, "_writable_by", lambda uid, gid, p: False)
    _as_owner(ep, monkeypatch, 0)
    ep.main(["python3"], {"ZIM_DIR": str(empty)})
    assert [p for p, _, _ in root_run.chown] == [str(empty)]
    root_run.chown.clear()
    ep.main(["python3", "serve", "--zim-dir", str(full)], {"ZIMI_DATA_DIR": str(data)})
    assert str(full) not in {p for p, _, _ in root_run.chown}
    assert str(data) in {p for p, _, _ in root_run.chown}


def test_a_library_folder_that_is_not_mounted_is_not_invented(ep, root_run, tmp_path):
    ep.main(["python3"], {"ZIM_DIR": str(tmp_path / "zims")})
    assert not (tmp_path / "zims").exists()
    assert root_run.chown == []


def test_the_dockerfile_uses_the_entrypoint_and_not_a_fixed_user():
    text = open(os.path.join(ROOT, "Dockerfile"), encoding="utf-8").read()
    lines = [ln.strip() for ln in text.splitlines() if not ln.lstrip().startswith("#")]
    assert "USER zimi" not in lines
    assert any(ln.startswith("ENTRYPOINT") and "zimi-entrypoint" in ln for ln in lines)
    assert any("packaging/docker/entrypoint.py" in ln for ln in lines)


# -- standing in for NOMAD's kiwix-serve container ---------------------------


NOMAD_KIWIX = [
    "--library",
    "/data/kiwix-library.xml",
    "--monitorLibrary",
    "--address=all",
]


def test_nomads_kiwix_flags_become_a_zimi_serve_of_that_folder(ep):
    argv, folder = ep.kiwix_serve_invocation(NOMAD_KIWIX, {})
    assert argv == [
        "python3",
        "-m",
        "zimi",
        "serve",
        "--port",
        "8080",
        "--host",
        "0.0.0.0",
    ]
    assert folder == "/data"


def test_the_port_is_kiwixs_unless_the_owner_says_otherwise(ep):
    assert ep.kiwix_serve_invocation(NOMAD_KIWIX, {"ZIMI_PORT": "9000"})[0][5] == "9000"
    both = NOMAD_KIWIX + ["--port", "7000"]
    assert ep.kiwix_serve_invocation(both, {"ZIMI_PORT": "9000"})[0][5] == "7000"
    assert ep.kiwix_serve_invocation(["--library=/x/l.xml", "--port=7001"], {})[0][5] == "7001"


@pytest.mark.parametrize("argv", [[], ["python3", "-m", "zimi", "serve"], ["zimi"]])
def test_an_ordinary_command_is_left_alone(ep, argv):
    assert ep.kiwix_serve_invocation(argv, {}) is None


def test_main_serves_the_library_folder_as_an_extra_one(ep, root_run, tmp_path):
    env = {"ZIMI_DATA_DIR": str(tmp_path / "config")}
    ep.main(NOMAD_KIWIX, env)
    assert root_run.exec[1][:5] == ["python3", "-m", "zimi", "serve", "--port"]
    assert env["ZIMI_EXTRA_ZIM_DIRS"] == "/data"


def test_a_folder_already_named_is_not_named_twice(ep, root_run):
    env = {"ZIMI_EXTRA_ZIM_DIRS": "/data"}
    ep.main(NOMAD_KIWIX, env)
    assert env["ZIMI_EXTRA_ZIM_DIRS"] == "/data"


def test_the_healthcheck_follows_the_port_the_owner_set():
    text = open(os.path.join(ROOT, "Dockerfile"), encoding="utf-8").read()
    assert "ZIMI_PORT" in text.split("HEALTHCHECK", 1)[1].split("CMD [", 1)[0]


def test_the_port_the_server_uses_is_written_for_the_healthcheck(ep, root_run, tmp_path, monkeypatch):
    # NOMAD's command names no port: Zimi takes kiwix-serve's 8080, and the
    # health check (its own process) must probe that, not 8899.
    monkeypatch.setattr(ep, "PORT_FILE", str(tmp_path / "port"))
    ep.main(NOMAD_KIWIX, {})
    assert open(ep.PORT_FILE).read() == "8080"
    ep.main(["python3", "-m", "zimi", "serve", "--port", "8899"], {})
    assert open(ep.PORT_FILE).read() == "8899"
    ep.main(["zimi"], {})
    assert not os.path.exists(ep.PORT_FILE)
    text = open(os.path.join(ROOT, "Dockerfile"), encoding="utf-8").read()
    assert "/tmp/zimi-port" in text.split("HEALTHCHECK", 1)[1].split("CMD [", 1)[0]
    assert ep.PORT_FILE != "/tmp/zimi-port" and _load().PORT_FILE == "/tmp/zimi-port"
