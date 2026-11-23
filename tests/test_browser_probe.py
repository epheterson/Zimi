"""Whether a Chromium is here is found out off any asyncio loop, so the answer is the machine's, not the thread's.

Playwright's sync API refuses to start on a thread that runs an asyncio loop. The probe ran there, said "no-chromium",
and that was cached for the process: every later caller, a test module or the server, heard there was no browser. Found
on the Mac Studio, where whole browser test files skipped as "not usable here" depending on which module ran first.
"""

import asyncio
import threading

import zimi.renderer as renderer

# The real one: the quick tier swaps browser_status for "no browser" in every test outside the browser tier (conftest).
BROWSER_STATUS = renderer.browser_status


def _fresh(monkeypatch, seen):
    monkeypatch.setattr(renderer, "_available", None)

    def probe():
        try:
            asyncio.get_running_loop()
            seen.append("on a loop")
        except RuntimeError:
            seen.append(threading.current_thread().name)
        return True, "ok"

    monkeypatch.setattr(renderer, "_probe_browser", probe)


def test_a_caller_inside_a_running_loop_gets_the_probe_run_on_a_thread_of_its_own(monkeypatch):
    seen = []
    _fresh(monkeypatch, seen)

    async def ask():
        return BROWSER_STATUS(refresh=True)

    assert asyncio.run(ask()) == (True, "ok")
    assert seen == ["zimi-browser-probe"], seen


def test_a_plain_caller_probes_where_it_is(monkeypatch):
    seen = []
    _fresh(monkeypatch, seen)
    assert BROWSER_STATUS(refresh=True) == (True, "ok")
    assert seen == [threading.current_thread().name], seen
