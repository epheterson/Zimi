"""Looking for an operator's npm install must not break the bundled behaviors: npm timing out or failing to start falls back."""

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import behaviors  # noqa: E402


def test_npm_that_times_out_or_will_not_start_falls_back_to_the_bundled_file(
    monkeypatch,
):
    monkeypatch.delenv(behaviors._ENV_VAR, raising=False)
    monkeypatch.setattr(behaviors, "_NODE_ROOTS", ())
    monkeypatch.setattr(behaviors.shutil, "which", lambda name: "/usr/bin/npm")
    monkeypatch.setattr(behaviors.os.path, "isfile", lambda p: p == behaviors._BUNDLED)
    for failure in (subprocess.TimeoutExpired("npm", 20), OSError("no such program")):

        def run(*a, **k):
            raise failure

        monkeypatch.setattr("zimi.subproc.run", run)
        assert behaviors.behaviors_path() == behaviors._BUNDLED
