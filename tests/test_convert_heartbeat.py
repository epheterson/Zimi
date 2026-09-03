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
    assert 2 <= len(beats) <= 4, lines


def test_a_chatty_command_gets_no_heartbeat():
    lines = []
    importer._run_stream(
        [sys.executable, "-c", "import time\nfor i in range(4):\n print(i, flush=True); time.sleep(0.2)"],
        lines.append,
        heartbeat_s=0.5,
    )
    assert not [ln for ln in lines if "still converting" in ln], lines
    assert lines == ["0", "1", "2", "3"]
