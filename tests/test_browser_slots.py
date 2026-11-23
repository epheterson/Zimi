"""The suite's cap on Chromiums at once (tests/browser_slots.py): a slot is held while a process has a browser open, the
next process waits for it, two browsers in one process take one slot, and a process that dies gives its slot back."""

import os
import subprocess
import sys
import time

import pytest

import browser_slots

pytestmark = pytest.mark.skipif(os.name != "posix", reason="flock")

HERE = os.path.dirname(os.path.abspath(__file__))
HOLD = """
import sys, time
sys.path.insert(0, %r)
import browser_slots as b
b._DIR = sys.argv[1]
b._opened()
print("held", flush=True)
time.sleep(float(sys.argv[2]))
b._closed()
"""


def _hold(tmp_path, seconds):
    p = subprocess.Popen([sys.executable, "-c", HOLD % HERE, str(tmp_path), str(seconds)], stdout=subprocess.PIPE, text=True)
    assert p.stdout.readline().strip() == "held"
    return p


def test_the_next_process_waits_for_the_slot(tmp_path, monkeypatch):
    monkeypatch.setenv(browser_slots.SLOTS_ENV, "1")
    monkeypatch.setattr(browser_slots, "_DIR", str(tmp_path))
    first = _hold(tmp_path, 1.5)
    t0 = time.monotonic()
    browser_slots._opened()
    try:
        assert time.monotonic() - t0 >= 1.0, "a second browser started while the only slot was held"
    finally:
        browser_slots._closed()
        first.wait(10)


def test_two_browsers_in_one_process_take_one_slot(tmp_path, monkeypatch):
    monkeypatch.setenv(browser_slots.SLOTS_ENV, "1")
    monkeypatch.setattr(browser_slots, "_DIR", str(tmp_path))
    browser_slots._opened()
    browser_slots._opened()  # would wait forever if it asked for a second slot
    browser_slots._closed()
    assert browser_slots._held is not None, "the slot stays while a browser is still open"
    browser_slots._closed()
    assert browser_slots._held is None


def test_a_process_that_dies_gives_its_slot_back(tmp_path, monkeypatch):
    monkeypatch.setenv(browser_slots.SLOTS_ENV, "1")
    monkeypatch.setattr(browser_slots, "_DIR", str(tmp_path))
    holder = _hold(tmp_path, 60)
    holder.kill()
    holder.wait(10)
    t0 = time.monotonic()
    browser_slots._opened()
    browser_slots._closed()
    assert time.monotonic() - t0 < 5


SOFT = browser_slots.WEBGL_ARGS + ['--disable-accelerated-2d-canvas']


def test_a_mac_draws_the_3d_tests_on_metal(monkeypatch):
    monkeypatch.delenv(browser_slots.GL_ENV, raising=False)
    got = browser_slots.gl_args(SOFT, platform="darwin")
    assert "--use-angle=metal" in got and not set(got) & browser_slots.SOFT_ONLY
    assert got.count("--ignore-gpu-blocklist") == 1 and "--disable-accelerated-2d-canvas" in got


def test_software_webgl_stays_off_a_mac_or_when_asked(monkeypatch):
    monkeypatch.delenv(browser_slots.GL_ENV, raising=False)
    assert browser_slots.gl_args(SOFT, platform="linux") == SOFT
    monkeypatch.setenv(browser_slots.GL_ENV, "soft")
    assert browser_slots.gl_args(SOFT, platform="darwin") == SOFT


def test_a_launch_that_asks_for_no_webgl_backend_is_left_alone(monkeypatch):
    monkeypatch.delenv(browser_slots.GL_ENV, raising=False)
    assert browser_slots.gl_args(["--disable-gpu"], platform="darwin") == ["--disable-gpu"]
    assert browser_slots.gl_args(None, platform="darwin") == []
    assert browser_slots.gl_args(SOFT + [browser_slots.KEEP_SOFTWARE_GL], platform="darwin") == SOFT
