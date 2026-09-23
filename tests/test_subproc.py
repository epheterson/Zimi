"""Every way out of a streaming runner kills the child and collects it.

Found on the NAS, 2026-09-11: `zimi-preview` had accumulated 20 zombies in 21
hours of uptime — 12 chrome-headless, 7 python3, 1 wget — all parented to the
container's PID 1, which is `python3 -m zimi serve` and reaps nothing.

Both `_run_stream` (importer) and `_run_streaming` (crawler) reaped the child
only when the command finished normally. The cancel path is the one that
matters: the progress sink handed to these runners is the job's `note()`, which
is also the cancellation checkpoint and RAISES when a cancel is pending. So
cancelling a capture — an ordinary thing to do — skipped both the kill and the
reap, and warc2zim's Chrome tree kept reading from a saturated disk for a
capture whose result had already been thrown away.

The zombies were the visible part and the cheap part. The tests below are
written against the expensive part: after any exit, is the child actually dead?

Run: pytest tests/test_subproc.py -v
"""

import os
import subprocess
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from zimi import subproc  # noqa: E402

# A child that talks, then keeps running for far longer than any test waits. If
# a runner leaves it behind, the assertions see it alive rather than having to
# infer anything.
CHATTY_AND_LONG = [
    sys.executable,
    "-u",
    "-c",
    "import time\nprint('hello', flush=True)\ntime.sleep(120)\n",
]


def _alive(pid):
    """Whether a pid is a live process rather than gone or a zombie.

    A reaped child is gone; an unreaped one that exited is a zombie, and
    os.kill(pid, 0) still succeeds for it. So the state is read rather than
    probed — that difference IS the bug."""
    if sys.platform == "win32":  # pragma: no cover - posix is where this bit
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"],
                capture_output=True,
                text=True, encoding="utf-8", errors="replace",
                timeout=10,
            ).stdout
        except Exception:
            return False
        return str(pid) in out
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _wait_gone(pid, seconds=10.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if not _alive(pid):
            return True
        time.sleep(0.05)
    return not _alive(pid)


def test_stop_ends_a_running_child_and_collects_it():
    proc = subproc.popen(CHATTY_AND_LONG, stdout=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    pid = proc.pid
    assert proc.stdout.readline().strip() == "hello"
    assert subproc.stop(proc) is not None
    assert proc.poll() is not None, "the child was never collected"
    assert _wait_gone(pid), "the child is still running"


def test_stop_is_safe_on_a_child_that_already_finished():
    """The common case: this lives in a finally, and most of the time the
    command simply worked."""
    proc = subproc.popen([sys.executable, "-c", "pass"])
    proc.wait()
    assert subproc.stop(proc) == 0
    assert subproc.stop(proc) == 0, "twice is not an error either"


def test_stop_never_raises_over_a_broken_child():
    """It runs on the way out, often while another exception is travelling. A
    failure to kill must not replace the reason the caller was leaving."""

    class _Awkward:
        pid = -1
        stdout = stderr = stdin = None

        def poll(self):
            raise RuntimeError("no")

        def wait(self, timeout=None):
            raise RuntimeError("no")

    assert subproc.stop(_Awkward()) is None
    assert subproc.stop(None) is None


@pytest.mark.skipif(sys.platform == "win32", reason="posix process groups")
def test_the_child_gets_a_group_of_its_own():
    """Which is what makes it possible to reach Chrome's renderers rather than
    only the process Python is holding."""
    proc = subproc.popen(CHATTY_AND_LONG, stdout=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    try:
        proc.stdout.readline()
        assert os.getpgid(proc.pid) != os.getpgid(os.getpid())
        assert os.getpgid(proc.pid) == proc.pid
    finally:
        subproc.stop(proc)


@pytest.mark.skipif(sys.platform == "win32", reason="posix process groups")
def test_stopping_reaches_the_grandchildren():
    """The whole reason for the group. Chrome is a tree: terminating the one
    PID Python holds orphans the renderers, which keep the CPU and the disk
    busy for work already thrown away."""
    script = (
        "import subprocess, sys, time\n"
        "kid = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
        "print(kid.pid, flush=True)\n"
        "time.sleep(120)\n"
    )
    proc = subproc.popen(
        [sys.executable, "-u", "-c", script], stdout=subprocess.PIPE, text=True,
        encoding="utf-8", errors="replace"
    )
    grandchild = int(proc.stdout.readline().strip())
    assert _alive(grandchild)
    subproc.stop(proc)
    assert _wait_gone(grandchild), "the grandchild outlived the group"


def test_a_raising_sink_still_kills_the_converter():
    """The importer's designed cancellation path, end to end.

    `sink` is the job's note(), which raises when a cancel is pending. The reap
    used to sit outside the try/finally, so this exact path — the one taken
    every time somebody stops a capture — skipped it.
    """
    from zimi import importer

    seen = {}

    class _Cancelled(Exception):
        pass

    def sink(line):
        seen.setdefault("pid", None)
        raise _Cancelled()

    started = []
    real_popen = subproc.popen

    def watching_popen(cmd, **kwargs):
        proc = real_popen(cmd, **kwargs)
        started.append(proc)
        return proc

    subproc.popen = watching_popen
    try:
        with pytest.raises(_Cancelled):
            importer._run_stream(CHATTY_AND_LONG, sink)
    finally:
        subproc.popen = real_popen

    assert started, "the converter was never started"
    proc = started[0]
    assert proc.poll() is not None, "a cancelled conversion left an unreaped child"
    assert _wait_gone(proc.pid), "a cancelled conversion left the converter running"


def test_a_raising_note_still_kills_the_crawl():
    """The crawler's twin of the above. Its runner had three holes rather than
    one: an uncaught TimeoutExpired, a KeyboardInterrupt branch that terminated
    without waiting, and this — any exception out of note()."""
    from zimi import crawler

    class _Cancelled(Exception):
        pass

    def note(_line):
        raise _Cancelled()

    started = []
    real_popen = subproc.popen

    def watching_popen(cmd, **kwargs):
        proc = real_popen(cmd, **kwargs)
        started.append(proc)
        return proc

    subproc.popen = watching_popen
    try:
        with pytest.raises(_Cancelled):
            crawler._run_streaming(CHATTY_AND_LONG, note)
    finally:
        subproc.popen = real_popen

    assert started, "the crawl was never started"
    proc = started[0]
    assert proc.poll() is not None, "a cancelled crawl left an unreaped child"
    assert _wait_gone(proc.pid), "a cancelled crawl left the browser running"


def test_the_container_has_an_init_to_catch_what_the_code_misses():
    """A net, not the fix. PID 1 in the container is `python3 -m zimi serve`,
    which reaps nothing, so without this there is no backstop at all for a
    missed wait() anywhere in the process."""
    import glob
    import pathlib

    root = pathlib.Path(__file__).resolve().parent.parent
    files = sorted(glob.glob(str(root / "**" / "docker-compose*.yml"), recursive=True))
    assert files, "no compose files found"
    for path in files:
        text = pathlib.Path(path).read_text(encoding="utf-8")
        assert "init: true" in text, f"{os.path.basename(path)} has no init"
