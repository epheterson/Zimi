"""`zimi backup` / `zimi restore` — the headless CLI over the bundle logic.

The CLI exists for backup-before-upgrade, so every test here runs the real
`python -m zimi` subprocess against a temp data dir with NO server running.
The bundle semantics themselves (merge rules, scope gating, env locks) are
covered in test_backup.py; this file covers the CLI contract: round-trip
through a wiped data dir, the 0600 file mode (bundles carry password hashes),
and one-line exit-2 refusals for missing/malformed/foreign files.
"""

import json
import os
import stat
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402

from tests.test_serve_smoke import REPO_ROOT  # noqa: E402


def _run_cli(args, cwd=None):
    """Run `python -m zimi <args>` hermetically: the developer's own shell env
    must never leak a ZIM_DIR/data dir into the test."""
    env = os.environ.copy()
    for k in ("ZIM_DIR", "ZIMI_DATA_DIR", "ZIMI_CONFIG", "ZIMI_HOT_ZIMS"):
        env.pop(k, None)
    env["ZIMI_AUTO_UPDATE"] = "0"
    env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        [sys.executable, "-m", "zimi", *args],
        capture_output=True,
        text=True,
        cwd=cwd or REPO_ROOT,
        env=env,
        timeout=120,
    )


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    """A ZIM dir + data dir pair, with the in-process path globals pointed at
    them so tests can seed and verify state with the normal loaders while the
    subprocess operates on the same files via --zim-dir/--data-dir."""
    zim_dir = tmp_path / "zims"
    data_dir = tmp_path / "data"
    zim_dir.mkdir()
    data_dir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zim_dir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(data_dir))
    return zim_dir, data_dir


def _path_flags(zim_dir, data_dir):
    return ["--zim-dir", str(zim_dir), "--data-dir", str(data_dir)]


def _seed_state():
    """Users + access policy + collections — the state the round-trip asserts."""
    from zimi import users

    users._save_users({"alice": {"name": "alice", "pw": "SALT$HASH", "role": "user"}})
    users.set_public_access("limited", ["wikipedia_en"])
    server._save_collections(
        {
            "version": 1,
            "favorites": ["wikipedia_en"],
            "collections": {"surv": {"label": "Survival", "zims": ["a", "b"]}},
        }
    )


# ── Round trip: backup → wipe → restore ──


def test_backup_restore_round_trip_through_wiped_data_dir(dirs, tmp_path):
    zim_dir, data_dir = dirs
    _seed_state()
    out = tmp_path / "bundle.json"

    proc = _run_cli(["backup", str(out), *_path_flags(zim_dir, data_dir)])
    assert proc.returncode == 0, proc.stderr
    assert str(out) in proc.stdout
    # The hash warning is part of the contract, not decoration.
    assert "password hashes" in proc.stdout

    bundle = json.loads(out.read_text())
    assert bundle["schema"] == "zimi-backup"
    assert bundle["scope"] == "server"
    assert bundle["users"]["alice"]["pw"] == "SALT$HASH"

    # Wipe: simulate the fresh box the backup exists for. restore's headless
    # boot must recreate the data dir itself.
    import shutil

    shutil.rmtree(data_dir)

    proc = _run_cli(["restore", str(out), *_path_flags(zim_dir, data_dir)])
    assert proc.returncode == 0, proc.stderr
    assert "applied:" in proc.stdout

    from zimi import users

    assert users._load_users()["alice"]["pw"] == "SALT$HASH"
    mode, allow, ok = users._load_access()
    assert (mode, allow, ok) == ("limited", ["wikipedia_en"], True)
    coll = server._load_collections()
    assert coll["favorites"] == ["wikipedia_en"]
    assert coll["collections"]["surv"]["zims"] == ["a", "b"]


def test_restore_reports_env_locked_auto_update_as_skipped(dirs, tmp_path):
    """The subprocess runs with ZIMI_AUTO_UPDATE=0 (env-locked), so a bundle
    carrying auto_update must be applied without it — and say so."""
    zim_dir, data_dir = dirs
    _seed_state()
    out = tmp_path / "bundle.json"
    assert (
        _run_cli(["backup", str(out), *_path_flags(zim_dir, data_dir)]).returncode == 0
    )
    proc = _run_cli(["restore", str(out), *_path_flags(zim_dir, data_dir)])
    assert proc.returncode == 0, proc.stderr
    assert "skipped: auto_update" in proc.stdout


# ── File mode: 0600, because password hashes ──


def test_backup_file_mode_is_0600(dirs, tmp_path):
    zim_dir, data_dir = dirs
    _seed_state()
    out = tmp_path / "bundle.json"
    assert (
        _run_cli(["backup", str(out), *_path_flags(zim_dir, data_dir)]).returncode == 0
    )
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o600


def test_backup_tightens_a_preexisting_looser_file(dirs, tmp_path):
    """O_CREAT's mode only applies on create — overwriting an existing 0644
    file must still end at 0600, which is what the explicit chmod is for."""
    zim_dir, data_dir = dirs
    out = tmp_path / "bundle.json"
    out.write_text("{}")
    os.chmod(out, 0o644)
    assert (
        _run_cli(["backup", str(out), *_path_flags(zim_dir, data_dir)]).returncode == 0
    )
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o600


def test_backup_default_filename_lands_in_cwd(dirs, tmp_path):
    zim_dir, data_dir = dirs
    workdir = tmp_path / "cwd"
    workdir.mkdir()
    proc = _run_cli(["backup", *_path_flags(zim_dir, data_dir)], cwd=workdir)
    assert proc.returncode == 0, proc.stderr
    made = [p for p in os.listdir(workdir) if p.startswith("zimi-backup-")]
    assert len(made) == 1 and made[0].endswith(".json")


# ── Refusals: one line, exit 2, no traceback ──


def _assert_clean_refusal(proc):
    assert proc.returncode == 2
    assert "Traceback" not in proc.stderr
    # One-line error on stderr, prefixed like every other zimi CLI error.
    lines = [ln for ln in proc.stderr.splitlines() if ln.strip()]
    assert len(lines) == 1 and lines[0].startswith("zimi: ")


def test_restore_missing_file_refuses(dirs, tmp_path):
    zim_dir, data_dir = dirs
    proc = _run_cli(
        ["restore", str(tmp_path / "nope.json"), *_path_flags(zim_dir, data_dir)]
    )
    _assert_clean_refusal(proc)
    assert "not found" in proc.stderr


def test_restore_malformed_json_refuses(dirs, tmp_path):
    zim_dir, data_dir = dirs
    bad = tmp_path / "bad.json"
    bad.write_text("{this is not json")
    proc = _run_cli(["restore", str(bad), *_path_flags(zim_dir, data_dir)])
    _assert_clean_refusal(proc)
    assert "malformed JSON" in proc.stderr


def test_restore_foreign_schema_refuses(dirs, tmp_path):
    """Valid JSON that is not a Zimi bundle (e.g. someone points restore at
    zimi.json) must refuse outright — never half-apply."""
    zim_dir, data_dir = dirs
    for payload in ('{"schema": "something-else"}', '["not", "a", "dict"]'):
        foreign = tmp_path / "foreign.json"
        foreign.write_text(payload)
        proc = _run_cli(["restore", str(foreign), *_path_flags(zim_dir, data_dir)])
        _assert_clean_refusal(proc)
        assert "not a Zimi backup bundle" in proc.stderr
