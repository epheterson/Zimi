"""How many Chromiums the test suite runs at once, on this machine, whatever ``-n`` says.

Every browser test launches its own Chromium. On a 36-core machine ``-n auto`` ran 36 of them, plus the WebGL each draws
in software, and the 3D tests timed out from load alone (433 failures in one run, 70 of them real). The quick tier still
wants every core, so the cap is on browsers, not workers: ``BrowserType.launch`` waits for one of ZIMI_TEST_BROWSERS slots.

A slot is an exclusive ``flock`` on a file in the system temp folder, so it is shared by every pytest on the machine
(xdist workers, another terminal, another run) and the kernel gives it back when a process dies, however it dies. A process
holds at most one slot however many browsers it has open, so a test with two browsers never waits on itself.

The same wrapper puts WebGL on the GPU where there is one. The 3D tests ask for SwiftShader (software WebGL, what CI's
Linux runners have); on a Mac headless Chromium draws through Metal instead, so each one there swaps it for Metal. Three
3D files on a 36-core Mac, 2026-11-20: 3,349 s of CPU and a timing failure in software, 263 s and none on Metal.
ZIMI_TEST_GL=soft keeps SwiftShader (to reproduce what CI draws); a launch whose subject is software drawing itself
passes KEEP_SOFTWARE_GL among its arguments and keeps it.
"""

import os
import sys
import tempfile
import threading
import time

SLOTS_ENV = "ZIMI_TEST_BROWSERS"
# Picked on a 36-core Mac, 2026-11-20, when each browser drew WebGL in software (~4 cores each).
DEFAULT_SLOTS = 8
SLOT_WAIT_S = 0.2
GL_ENV = "ZIMI_TEST_GL"
SOFT_GL = "--use-angle=swiftshader"
# the 3D tests' WebGL flags; on a Mac gl_args() swaps them for Metal
WEBGL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
SOFT_ONLY = {SOFT_GL, "--enable-unsafe-swiftshader"}
KEEP_SOFTWARE_GL = "--zimi-keep-software-gl"  # never reaches Chromium
METAL_GL = ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]

_DIR = os.path.join(tempfile.gettempdir(), "zimi-chromium-slots")
_lock = threading.Lock()
_held = None  # the slot file's descriptor while this process has a browser open
_live = 0  # browsers open in this process


def slots():
    try:
        return max(1, int(os.environ.get(SLOTS_ENV, "")))
    except ValueError:
        return DEFAULT_SLOTS


def gl_args(args, platform=None):
    """A launch's arguments with software WebGL swapped for Metal on a Mac (unless ZIMI_TEST_GL=soft). Others untouched."""
    args = list(args or [])
    if KEEP_SOFTWARE_GL in args:
        return [a for a in args if a != KEEP_SOFTWARE_GL]
    if SOFT_GL not in args or (platform or sys.platform) != "darwin" or os.environ.get(GL_ENV) == "soft":
        return args
    kept = [a for a in args if a not in SOFT_ONLY]
    return kept + [a for a in METAL_GL if a not in kept]


def _acquire():
    import fcntl

    global _held
    os.makedirs(_DIR, exist_ok=True)
    n = slots()
    while True:
        for i in range(n):
            fd = os.open(os.path.join(_DIR, "slot-%d" % i), os.O_CREAT | os.O_RDWR, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(fd)
                continue
            _held = fd
            return
        time.sleep(SLOT_WAIT_S)


def _release():
    import fcntl

    global _held
    if _held is not None:
        fcntl.flock(_held, fcntl.LOCK_UN)
        os.close(_held)
        _held = None


def _opened():
    global _live
    with _lock:
        if _live == 0:
            _acquire()
        _live += 1


def _closed():
    global _live
    with _lock:
        _live = max(0, _live - 1)
        if _live == 0:
            _release()


def install():
    """Wrap Playwright's sync ``BrowserType.launch`` in this process (each xdist worker calls it). Once only."""
    if os.name != "posix":
        return
    try:
        from playwright.sync_api import BrowserType
    except Exception:
        return
    if getattr(BrowserType.launch, "_zimi_slot", False):
        return
    launch_unslotted = BrowserType.launch

    def launch(self, *args, **kwargs):
        kwargs["args"] = gl_args(kwargs.get("args"))
        _opened()
        try:
            browser = launch_unslotted(self, *args, **kwargs)
        except BaseException:
            _closed()
            raise
        done = []

        def gone(*_):
            if not done:
                done.append(True)
                _closed()

        browser.on("disconnected", gone)
        close = browser.close

        def close_and_free(*a, **kw):
            try:
                return close(*a, **kw)
            finally:
                gone()

        browser.close = close_and_free
        return browser

    launch._zimi_slot = True
    BrowserType.launch = launch
