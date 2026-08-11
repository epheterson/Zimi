"""`zimi import <archive>` — the warc2zim sidecar contract.

Everything subprocess-shaped is mocked at the module seams
(``_run_stream`` / ``_run_capture`` / ``_probe_python``): no real venvs,
no pip installs, no network. What IS real: path resolution, the marker
protocol, staging + atomic finish, non-clobber naming, and the CLI wiring
(one end-to-end ``--status`` subprocess, which never touches the network).
"""

import argparse
import json
import os
import subprocess
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

import zimi.importer as importer  # noqa: E402
import zimi.server as _srv  # noqa: E402


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    d = tmp_path / "data"
    d.mkdir()
    monkeypatch.setattr(_srv, "ZIMI_DATA_DIR", str(d))
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    return d


def _args(**kw):
    base = dict(
        file=None,
        name=None,
        title=None,
        description=None,
        out=None,
        status=False,
        setup=False,
    )
    base.update(kw)
    return argparse.Namespace(**base)


def _fake_sidecar(data_dir):
    """A pre-seeded sidecar: console script + install marker, no real venv."""
    venv = str(data_dir / "tools" / "warc2zim")
    exe = importer._venv_bin(venv, "warc2zim")
    os.makedirs(os.path.dirname(exe))
    with open(exe, "w") as f:
        f.write("#!/bin/sh\n")
    with open(os.path.join(venv, ".zimi-sidecar.json"), "w") as f:
        json.dump({"warc2zim": "2.3.1", "python": "3.14"}, f)
    return venv, exe


def _fake_convert_ok(payload=b"ZIM\x04fake"):
    """A _run_stream stand-in that behaves like a successful warc2zim run:
    writes the staged ZIM exactly where --output/--zim-file point."""

    def run(cmd, sink):
        outdir = cmd[cmd.index("--output") + 1]
        zim_file = cmd[cmd.index("--zim-file") + 1]
        with open(os.path.join(outdir, zim_file), "wb") as f:
            f.write(payload)
        sink("[INFO] converting")
        return 0

    return run


# ── sidecar status ──────────────────────────────────────────────────────────


def test_status_reports_absent_with_preseed_pointer(data_dir, capsys):
    st = importer.sidecar_status()
    assert st["installed"] is False and st["version"] is None
    importer.cli_import(_args(status=True))
    out = capsys.readouterr().out
    assert "not installed" in out
    assert str(data_dir) in out
    assert "--setup" in out  # the pre-seed story is spelled out


def test_status_reports_version_when_installed(data_dir, monkeypatch, capsys):
    _fake_sidecar(data_dir)
    monkeypatch.setattr(
        importer, "_run_capture", lambda cmd, timeout=60: (0, "warc2zim 2.3.1")
    )
    st = importer.sidecar_status()
    assert st["installed"] is True
    assert st["version"] == "2.3.1"
    assert st["python"] == "3.14"
    importer.cli_import(_args(status=True))
    out = capsys.readouterr().out
    assert "installed" in out and "2.3.1" in out


def test_status_falls_back_to_marker_version(data_dir, monkeypatch):
    _fake_sidecar(data_dir)
    monkeypatch.setattr(importer, "_run_capture", lambda cmd, timeout=60: (1, ""))
    assert importer.sidecar_status()["version"] == "2.3.1"


def test_partial_install_reads_as_not_installed(data_dir):
    venv = str(data_dir / "tools" / "warc2zim")
    exe = importer._venv_bin(venv, "warc2zim")
    os.makedirs(os.path.dirname(exe))
    open(exe, "w").close()  # script present, marker missing → half-install
    assert importer.sidecar_status()["installed"] is False


# ── venv management ─────────────────────────────────────────────────────────


def test_offline_refuses_venv_creation_with_preseed_story(data_dir, monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    with pytest.raises(importer.CreateError) as ei:
        importer.ensure_sidecar()
    msg = str(ei.value)
    assert "ZIMI_OFFLINE" in msg
    assert "zimi import --setup" in msg  # how to pre-seed
    assert "pip install warc2zim" in msg  # the manual path too


def test_no_suitable_python_names_the_requirement(data_dir, monkeypatch):
    monkeypatch.setattr(importer, "_probe_python", lambda cand: (3, 12))
    with pytest.raises(importer.CreateError, match=r">=3\.14,<3\.15"):
        importer.ensure_sidecar()


def test_venv_creation_sequence_and_marker(data_dir, monkeypatch):
    venv = importer.sidecar_dir()
    calls = []

    def fake_probe(cand):
        return (3, 14) if cand == "python3.14" else (3, 12)

    def fake_stream(cmd, sink):
        calls.append(list(cmd))
        if cmd[1:3] == ["-m", "venv"]:
            py = importer._venv_bin(venv, "python")
            os.makedirs(os.path.dirname(py), exist_ok=True)
            open(py, "w").close()
        elif "install" in cmd:
            open(importer._venv_bin(venv, "warc2zim"), "w").close()
        return 0

    monkeypatch.setattr(importer, "_probe_python", fake_probe)
    monkeypatch.setattr(importer, "_run_stream", fake_stream)
    monkeypatch.setattr(
        importer, "_run_capture", lambda cmd, timeout=60: (0, "warc2zim 2.3.1")
    )
    exe = importer.ensure_sidecar()
    assert exe == importer._venv_bin(venv, "warc2zim")
    # Contract: venv with the 3.14 interpreter, then pip install warc2zim
    # THROUGH the venv's own python.
    assert calls[0] == ["python3.14", "-m", "venv", venv]
    assert calls[1][0] == importer._venv_bin(venv, "python")
    assert calls[1][1:4] == ["-m", "pip", "install"]
    assert "warc2zim" in calls[1]
    with open(os.path.join(venv, ".zimi-sidecar.json")) as f:
        marker = json.load(f)
    assert marker == {"warc2zim": "2.3.1", "python": "3.14"}
    # Second call is a no-op: already installed.
    calls.clear()
    assert importer.ensure_sidecar() == exe
    assert calls == []


def test_install_failure_leaves_nothing_behind(data_dir, monkeypatch):
    venv = importer.sidecar_dir()

    def fake_stream(cmd, sink):
        if cmd[1:3] == ["-m", "venv"]:
            py = importer._venv_bin(venv, "python")
            os.makedirs(os.path.dirname(py), exist_ok=True)
            open(py, "w").close()
            return 0
        return 1  # pip fails

    monkeypatch.setattr(importer, "_probe_python", lambda cand: (3, 14))
    monkeypatch.setattr(importer, "_run_stream", fake_stream)
    with pytest.raises(importer.CreateError, match="install failed"):
        importer.ensure_sidecar()
    assert not os.path.exists(venv)


# ── the import itself ───────────────────────────────────────────────────────


def test_import_subprocess_contract(data_dir, tmp_path, monkeypatch):
    _venv, exe = _fake_sidecar(data_dir)
    archive = tmp_path / "My Crawl.wacz"
    archive.write_bytes(b"PK fake wacz")
    seen = {}

    def fake_stream(cmd, sink):
        seen["cmd"] = list(cmd)
        return _fake_convert_ok()(cmd, sink)

    registered = []
    monkeypatch.setattr(importer, "_run_stream", fake_stream)
    monkeypatch.setattr(
        importer, "_try_register", lambda p: registered.append(p) or True
    )
    info = importer.import_archive(
        str(archive),
        title="My Crawl",
        description="a crawl",
        out_dir=str(tmp_path / "zims"),
        register=True,
    )
    cmd = seen["cmd"]
    assert cmd[0] == exe and cmd[1] == str(archive)
    assert cmd[cmd.index("--name") + 1] == "My_Crawl"
    assert cmd[cmd.index("--title") + 1] == "My Crawl"
    assert cmd[cmd.index("--description") + 1] == "a crawl"
    assert info["path"] == str(tmp_path / "zims" / "My_Crawl.zim")
    with open(info["path"], "rb") as f:
        assert f.read() == b"ZIM\x04fake"
    assert info["registered"] is True and registered == [info["path"]]
    # Staging is gone; only the finished ZIM remains.
    assert sorted(os.listdir(tmp_path / "zims")) == ["My_Crawl.zim"]


def test_import_output_does_not_clobber(data_dir, tmp_path, monkeypatch):
    _fake_sidecar(data_dir)
    archive = tmp_path / "site.warc"
    archive.write_bytes(b"WARC/1.1")
    monkeypatch.setattr(importer, "_run_stream", _fake_convert_ok())
    first = importer.import_archive(str(archive), out_dir=str(tmp_path / "zims"))
    second = importer.import_archive(str(archive), out_dir=str(tmp_path / "zims"))
    assert first["path"].endswith("site.zim")
    assert second["path"].endswith("site-2.zim")


def test_offline_import_runs_with_preseeded_sidecar(data_dir, tmp_path, monkeypatch):
    # Once the sidecar exists, conversion is fully local — ZIMI_OFFLINE
    # must NOT block it.
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    _fake_sidecar(data_dir)
    archive = tmp_path / "site.warc.gz"
    archive.write_bytes(b"WARC fake")
    monkeypatch.setattr(importer, "_run_stream", _fake_convert_ok())
    info = importer.import_archive(str(archive), out_dir=str(tmp_path / "zims"))
    assert os.path.exists(info["path"])
    assert info["name"] == "site"  # .warc.gz stripped as one extension


def test_warc2zim_failure_cleans_staging(data_dir, tmp_path, monkeypatch):
    _fake_sidecar(data_dir)
    archive = tmp_path / "bad.warc"
    archive.write_bytes(b"WARC")
    monkeypatch.setattr(importer, "_run_stream", lambda cmd, sink: 1)
    with pytest.raises(importer.CreateError, match="exit 1"):
        importer.import_archive(str(archive), out_dir=str(tmp_path / "zims"))
    assert os.listdir(tmp_path / "zims") == []  # no ZIM, no staging leftovers


def test_rejects_non_archive_and_missing_file(data_dir, tmp_path):
    txt = tmp_path / "notes.txt"
    txt.write_text("not an archive")
    with pytest.raises(importer.CreateError, match=r"\.warc"):
        importer.import_archive(str(txt))
    with pytest.raises(importer.CreateError, match="not found"):
        importer.import_archive(str(tmp_path / "gone.wacz"))


# ── CLI ─────────────────────────────────────────────────────────────────────


def test_cli_no_file_exits_2(data_dir, capsys):
    with pytest.raises(SystemExit) as ei:
        importer.cli_import(_args())
    assert ei.value.code == 2
    assert "nothing to import" in capsys.readouterr().err


def test_cli_offline_import_exits_2_with_preseed(
    data_dir, tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    archive = tmp_path / "a.warc"
    archive.write_bytes(b"WARC")
    with pytest.raises(SystemExit) as ei:
        importer.cli_import(_args(file=str(archive)))
    assert ei.value.code == 2
    assert "zimi import --setup" in capsys.readouterr().err


def test_cli_status_subprocess(tmp_path):
    """Real `python -m zimi import --status` — wiring only, no network."""
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT
    env["ZIM_DIR"] = str(tmp_path / "zims")
    env["ZIMI_DATA_DIR"] = str(tmp_path / "data")
    env.pop("ZIMI_OFFLINE", None)
    r = subprocess.run(
        [sys.executable, "-m", "zimi", "import", "--status"],
        capture_output=True,
        text=True,
        env=env,
        cwd=REPO_ROOT,
        timeout=120,
    )
    assert r.returncode == 0, r.stderr
    assert "not installed" in r.stdout
    assert "--setup" in r.stdout
