"""The table of where each optional feature comes from (zimi/runtimes.py)."""

import re
import subprocess
import sys
from pathlib import Path

import pytest

from zimi import runtimes

ROOT = Path(__file__).resolve().parent.parent


def test_every_feature_says_how_it_arrives_on_every_kind_of_install():
    for f in runtimes.FEATURES:
        assert set(f.ways) == set(runtimes.KINDS), f.key
        for kind, way in f.ways.items():
            assert way.how in runtimes._HOW_TEXT, (f.key, kind)
            # A person who does not have it reads this line: it must say how
            # to get it, or why it is not there.
            if way.how != runtimes.BUNDLED:
                assert way.note.strip(), (f.key, kind)


def test_every_extra_the_table_names_exists_in_pyproject():
    extras = set(re.findall(r"^(\w+) = \[", (ROOT / "pyproject.toml").read_text(encoding="utf-8"), re.M))
    named = set()
    for f in runtimes.FEATURES:
        for way in f.ways.values():
            named.update(re.findall(r'zimi\[(\w+)\]', way.note))
    assert named, "the table names no extras at all"
    assert named <= extras, named - extras


def test_keys_are_unique():
    keys = [f.key for f in runtimes.FEATURES]
    assert len(keys) == len(set(keys))


def test_a_bundled_feature_that_is_missing_is_a_problem(monkeypatch):
    feats = (
        runtimes.Feature("a", "A", lambda: False, {k: runtimes.Way(runtimes.BUNDLED, "") for k in runtimes.KINDS}),
        runtimes.Feature("b", "B", lambda: False, {k: runtimes.Way(runtimes.EXTRA, 'pip install "zimi[pdf]"') for k in runtimes.KINDS}),
        runtimes.Feature("c", "C", lambda: 1 / 0, {k: runtimes.Way(runtimes.BUNDLED, "") for k in runtimes.KINDS}),
    )
    monkeypatch.setattr(runtimes, "FEATURES", feats)
    rows = runtimes.report(runtimes.PIP)
    # A probe that raises reads as not ready, never as a crash.
    assert runtimes.problems(rows) == ["a", "c"]
    text = runtimes.format_report(rows, runtimes.PIP)
    assert 'optional extra: pip install "zimi[pdf]"' in text


@pytest.mark.parametrize(
    "declared,kind",
    [("docker", "docker"), ("snap", "desktop"), ("appimage", "desktop"),
     ("desktop-mac", "desktop"), ("homebrew", "pip"), ("pip", "pip")],
)
def test_install_kind(monkeypatch, declared, kind):
    monkeypatch.setenv("ZIMI_INSTALL_TYPE", declared)
    assert runtimes.install_kind() == kind


def test_zimi_doctor_prints_the_table(tmp_path):
    out = subprocess.run(
        [sys.executable, "-m", "zimi", "doctor", "--kind", "pip",
         "--zim-dir", str(tmp_path), "--data-dir", str(tmp_path / "data")],
        capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr
    assert "Zimi features on this install (pip)" in out.stdout
    for f in runtimes.FEATURES:
        assert f.name in out.stdout


def test_a_feature_that_cannot_set_itself_up_is_a_problem(monkeypatch):
    """Not ready is fine for a feature that sets itself up on first use;
    unable to is the dead end #113 was (voices offered nothing on pip)."""
    feats = (runtimes.Feature("v", "V", lambda: False, {k: runtimes.Way(runtimes.SETS_UP, "") for k in runtimes.KINDS}),)
    monkeypatch.setattr(runtimes, "FEATURES", feats)
    monkeypatch.setattr(runtimes, "CAN_SET_UP", {"v": lambda: True})
    assert runtimes.problems(runtimes.report(runtimes.PIP)) == []
    monkeypatch.setattr(runtimes, "CAN_SET_UP", {"v": lambda: False})
    assert runtimes.problems(runtimes.report(runtimes.PIP)) == ["v"]


def test_a_chosen_client_engine_makes_bittorrent_ready(monkeypatch):
    from zimi import p2p

    monkeypatch.setattr(p2p, "_lt", lambda: None)
    monkeypatch.setattr(p2p, "engine_name", lambda: "libtorrent")
    assert runtimes._bt() is False
    monkeypatch.setattr(p2p, "engine_name", lambda: "qbittorrent")
    assert runtimes._bt() is True
