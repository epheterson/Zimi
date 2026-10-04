"""Arctic Shift answers a request it is too busy for with 422 (or 429, 5xx)
and the same request a moment later with the data. ArcticZim gave up on the
first one and the capture failed (r/Kiwix, discussion #105, 2026-10-04).
The launcher Zimi writes in front of ArcticZim asks again, longer each time.

Run: pytest tests/test_reddot_retry.py -v
"""

import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import reddot  # noqa: E402


class _Answer:
    def __init__(self, status):
        self.status_code = status


def _launcher(monkeypatch, answers):
    """The launcher's code loaded with a stand-in requests and ArcticZim."""
    calls, slept = [], []
    fake_requests = types.ModuleType("requests")

    class ConnectionError(Exception):
        pass

    class Timeout(Exception):
        pass

    fake_requests.ConnectionError, fake_requests.Timeout = ConnectionError, Timeout

    def get(*args, **kwargs):
        calls.append(kwargs.get("timeout"))
        a = answers.pop(0)
        if a == "reset":
            raise ConnectionError("reset")
        return _Answer(a)

    fake_requests.get = get
    retriever = types.ModuleType("arcticzim.retriever")
    retriever.requests = fake_requests
    pkg = types.ModuleType("arcticzim")
    pkg.__path__ = []
    pkg.retriever = retriever
    # The launcher patches the build on macOS at import: its modules, empty.
    zb = types.ModuleType("arcticzim.zimbuild")
    zb.__path__ = []
    builder = types.ModuleType("arcticzim.zimbuild.builder")
    zb.builder = builder
    pkg.zimbuild = zb
    monkeypatch.setitem(sys.modules, "requests", fake_requests)
    monkeypatch.setitem(sys.modules, "arcticzim", pkg)
    monkeypatch.setitem(sys.modules, "arcticzim.retriever", retriever)
    monkeypatch.setitem(sys.modules, "arcticzim.zimbuild", zb)
    monkeypatch.setitem(sys.modules, "arcticzim.zimbuild.builder", builder)
    import time

    monkeypatch.setattr(time, "sleep", lambda s: slept.append(s))
    ns = {"__name__": "zimi_arcticzim"}
    exec(compile(reddot._LAUNCHER_SRC, "zimi_arcticzim.py", "exec"), ns)
    ns["_patient_retrieve"]()
    return retriever.requests, calls, slept, fake_requests


def test_a_busy_answer_is_asked_again_until_the_data_comes(monkeypatch):
    req, calls, slept, _ = _launcher(monkeypatch, [422, 429, 200])
    assert req.get("https://arctic-shift.example/api").status_code == 200
    assert len(calls) == 3 and calls[0] == 60, "with a timeout"
    assert slept == [2, 4], "longer each time"


def test_a_lost_connection_is_asked_again_too(monkeypatch):
    req, calls, slept, _ = _launcher(monkeypatch, ["reset", 200])
    assert req.get("u").status_code == 200 and len(slept) == 1


def test_it_gives_up_after_its_tries_with_the_last_answer(monkeypatch):
    tries = 6
    req, calls, slept, _ = _launcher(monkeypatch, [422] * tries)
    assert req.get("u").status_code == 422
    assert len(calls) == tries and slept == [2, 4, 8, 16, 32]


def test_a_real_error_is_not_retried(monkeypatch):
    req, calls, slept, _ = _launcher(monkeypatch, [404])
    assert req.get("u").status_code == 404 and len(calls) == 1 and not slept
