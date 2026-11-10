"""scripts/release_checks.py: the release day's checklist is one command that shows every red thing at once."""

import datetime
import importlib.util
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "release_checks", os.path.join(ROOT, "scripts", "release_checks.py")
)
rc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rc)


def test_the_fixtures_age_is_told_not_enforced():
    fetched = datetime.date(2026, 9, 30)
    assert rc.horizons(today=fetched + datetime.timedelta(days=10))[0] == rc.OK
    status, detail = rc.horizons(
        today=fetched + datetime.timedelta(days=rc.HORIZONS_WARN_DAYS + 1)
    )
    assert status == rc.WARN and "2026-09-30" in detail


def test_every_failing_check_is_reported_and_the_exit_status_says_so(
    monkeypatch, capsys
):
    monkeypatch.setattr(
        rc,
        "CHECKS",
        (
            ("one", lambda: (rc.FAIL, "      why one"), False),
            ("two", lambda: (rc.OK, ""), False),
            ("three", lambda: (rc.FAIL, "      why three"), False),
        ),
    )
    assert rc.main([]) == 1
    out = capsys.readouterr().out
    assert (
        "FAIL  one" in out
        and "ok    two" in out
        and "why three" in out
        and "FAILED: 2 of 3" in out
    )


def test_the_network_check_is_skipped_offline_and_a_warning_passes(monkeypatch, capsys):
    called = []
    monkeypatch.setattr(
        rc,
        "CHECKS",
        (
            ("net", lambda: called.append(1) or (rc.FAIL, ""), True),
            ("old", lambda: (rc.WARN, "      old"), False),
        ),
    )
    assert rc.main(["--no-network"]) == 0
    assert not called and "skip  net" in capsys.readouterr().out
