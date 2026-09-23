"""READY <port> goes out as one write.

On the Intel Mac runner the config-file boot test saw
"READY 888323:07:20 Title indexes warmed": print() wrote the text and the
newline separately on an unbuffered stdout, a startup thread's log line
landed between them, and the line no longer read as READY.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import server  # noqa: E402


class _Recorder:
    def __init__(self):
        self.writes = []

    def write(self, s):
        self.writes.append(s)
        return len(s)

    def flush(self):
        pass


def test_ready_is_one_write(monkeypatch):
    rec = _Recorder()
    monkeypatch.setattr(sys, "stdout", rec)
    server.announce_ready(8883)
    assert rec.writes == ["READY 8883\n"]
