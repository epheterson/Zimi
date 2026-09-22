"""The atomic writer waits out Windows's "file in use" refusal.

Windows refuses to replace a file another thread has open for reading, where
POSIX swaps the inode underneath. The create-jobs journal is read and written
by different threads, and the 1.9.6 release build lost its Windows leg to that
overlap: one PermissionError, one warning, one test waiting 30s for a state
that was never written. A reader holds the file for microseconds; a short
retry is the fix, and a real lock still ends in the warning.

Run: pytest tests/test_atomic_write_retry.py -v
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import zimi.server as srv  # noqa: E402


def test_a_transient_refusal_is_waited_out(tmp_path, monkeypatch):
    target = tmp_path / "journal.json"
    real = os.replace
    refusals = {"left": 3}

    def flaky(src, dst):
        if refusals["left"]:
            refusals["left"] -= 1
            raise PermissionError(5, "Access is denied")
        real(src, dst)

    monkeypatch.setattr(os, "replace", flaky)
    monkeypatch.setattr(srv, "_REPLACE_RETRY_SLEEP_S", 0)
    srv._atomic_write_json(str(target), {"ok": True})
    assert json.loads(target.read_text(encoding="utf-8")) == {"ok": True}
    assert refusals["left"] == 0
    assert not [n for n in os.listdir(tmp_path) if n.endswith(".tmp")], "temp file left behind"


def test_a_real_lock_still_ends_in_the_warning(tmp_path, monkeypatch, caplog):
    import logging

    target = tmp_path / "journal.json"

    def locked(src, dst):
        raise PermissionError(5, "Access is denied")

    monkeypatch.setattr(os, "replace", locked)
    monkeypatch.setattr(srv, "_REPLACE_RETRY_SLEEP_S", 0)
    with caplog.at_level(logging.WARNING, logger=srv.log.name):
        srv._atomic_write_json(str(target), {"ok": True})
    assert not target.exists()
    assert any("Atomic write failed" in r.getMessage() for r in caplog.records)
    assert not [n for n in os.listdir(tmp_path) if n.endswith(".tmp")], "temp file left behind"


def test_other_errors_are_not_retried(tmp_path, monkeypatch, caplog):
    """Only the Windows sharing refusal is transient. Anything else is a
    real error and one attempt is the honest number."""
    import logging

    calls = {"n": 0}

    def broken(src, dst):
        calls["n"] += 1
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(os, "replace", broken)
    with caplog.at_level(logging.WARNING, logger=srv.log.name):
        srv._atomic_write_json(str(tmp_path / "x.json"), {})
    assert calls["n"] == 1
