"""A long conversion says it is still going.

Survey finding O3, alive half: "converting the recording into a ZIM…" and then
86 s of nothing on cnn.com while warc2zim worked without printing. The
sidecar's silence is not ours to fix; ours is to keep the person told.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import importer  # noqa: E402


def test_a_silent_command_gets_a_heartbeat_line():
    lines = []
    code = importer._run_stream(
        [sys.executable, "-c", "import time; time.sleep(1.3); print('done')"],
        lines.append,
        heartbeat_s=0.4,
    )
    assert code == 0
    assert lines[-1] == "done"
    beats = [ln for ln in lines if "still converting" in ln]
    # At least two, so silence really is broken up. No tight ceiling: the
    # command takes longer on a loaded machine and earns more beats, and a
    # test that fails then is reporting the load, not the behaviour (the
    # same lesson as the chatty case below; this one failed at five while
    # the rest of the suite ran beside it).
    assert 2 <= len(beats) <= 12, lines


def test_a_chatty_command_gets_no_heartbeat():
    # 10x headroom between the gap and the heartbeat. It was 2.5x, which is a
    # margin an idle laptop clears and a loaded CI runner does not: the suite
    # failed here once on 2026-09-13 with a browser and a server alongside it,
    # and passed alone a second later. A timing test that fails on load is
    # reporting the load, not the behaviour.
    lines = []
    importer._run_stream(
        [
            sys.executable,
            "-c",
            "import time\nfor i in range(4):\n print(i, flush=True); time.sleep(0.1)",
        ],
        lines.append,
        heartbeat_s=1.0,
    )
    assert not [ln for ln in lines if "still converting" in ln], lines
    assert lines == ["0", "1", "2", "3"]
