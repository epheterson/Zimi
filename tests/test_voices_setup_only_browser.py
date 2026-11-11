"""Settings > Voices, on a phone, for a voice whose files are here and whose engine is not.

The 1.16 Docker image no longer carries Piper and Kokoro. A data folder from the image before keeps the voices.
Natural then read as not downloaded and Get did nothing. Now its row says Set up with the engines' size, one tap
sets them up (no model file is fetched again), and the voice is simply there.

At 390x844. Run: pytest tests/test_voices_setup_only_browser.py -v
"""

import os
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(__file__))

from test_voices import _fake_build, bare, data  # noqa: E402,F401  (fixtures and helper)
from zimi import voices  # noqa: E402

VIEW = {"width": 390, "height": 844}
SHOTS = os.environ.get("ZIMI_SHOTS", "")  # a folder: keep the screenshots there
NATURAL = "#ms-voices-wrap .voice-engine[data-engine='kokoro']"
STATE_MS = 30_000


def _natural_on_disk():
    """Natural as the old image left it: each pinned file at its size (sparse, so no disk), and the record."""
    pin = voices.VOICES[voices.KOKORO_TAG]
    folder = voices._engine_dir(pin.engine)
    os.makedirs(folder, exist_ok=True)
    for name, _url, size in pin.files:
        with open(os.path.join(folder, name), "wb") as f:
            f.truncate(size)
    voices._set_installed(
        pin.engine,
        voices.KOKORO_TAG,
        {
            "id": pin.id,
            "revision": pin.revision,
            "bytes": voices._bytes(voices.KOKORO_TAG),
            "files": [n for n, _u, _s in pin.files],
            "voice": pin.voice,
        },
    )


@pytest.fixture
def served(bare, monkeypatch):
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    def refuse(*a, **k):
        raise AssertionError("a file that is already here was fetched again")

    monkeypatch.setattr(voices.urllib.request, "urlopen", refuse)
    _natural_on_disk()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"))


def test_natural_says_set_up_and_one_tap_brings_it_back(served, monkeypatch):
    from playwright.sync_api import sync_playwright

    from zimi import importer

    calls = []
    build = _fake_build(calls)
    release = threading.Event()

    def slow_build(*a, **k):
        release.wait(20)  # the page sees the setup while it runs
        return build(*a, **k)

    monkeypatch.setattr(importer, "build_venv", slow_build)
    setup_mb = "%d" % round(voices.setup_bytes(voices.KOKORO) / 1_000_000)

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = br.new_context(
                viewport=VIEW,
                device_scale_factor=2,
                has_touch=True,
                is_mobile=True,
                service_workers="block",
            )
            pg = ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(served + "/?manage=languages")
            pg.wait_for_function("() => window._voicesHere", timeout=20000)
            pg.wait_for_selector(NATURAL, timeout=STATE_MS)
            pg.eval_on_selector(
                "#ms-voices-wrap", "e => e.scrollIntoView({ block: 'start' })"
            )
            # Not "Get <the whole model>": the engines' size, worded as setting up.
            label = pg.inner_text(NATURAL + " button[data-primary]")
            assert "Set up" in label and setup_mb in label, label
            assert not pg.query_selector(
                NATURAL + " .voice-hear"
            ), "it cannot be heard until the engine is there"
            _shot(pg, "1-needs-setup")

            pg.tap(NATURAL + " button[data-primary]")
            pg.wait_for_selector(NATURAL + " .voice-dl", timeout=STATE_MS)
            assert pg.inner_text(
                NATURAL + " .voice-progress"
            ), "the setup shows on the page"
            _shot(pg, "2-setting-up")
            release.set()
            pg.wait_for_selector(NATURAL + " .voice-hear", timeout=STATE_MS)
            assert not pg.query_selector(
                NATURAL + " button[data-primary]"
            ), "no second Get once it is here"
            _shot(pg, "3-there-again")
            assert calls == [list(voices.ENGINE_REQUIREMENTS)]
            assert not errors, errors
        finally:
            release.set()
            br.close()


def test_a_failed_setup_shows_its_reason_and_a_retry(served, monkeypatch):
    from playwright.sync_api import sync_playwright

    from zimi import importer

    monkeypatch.setattr(importer, "build_venv", _fake_build([], ok=False))
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = br.new_context(
                viewport=VIEW,
                device_scale_factor=2,
                has_touch=True,
                is_mobile=True,
                service_workers="block",
            )
            pg = ctx.new_page()
            pg.goto(served + "/?manage=languages")
            pg.wait_for_function("() => window._voicesHere", timeout=20000)
            pg.wait_for_selector(NATURAL + " button[data-primary]", timeout=STATE_MS)
            pg.tap(NATURAL + " button[data-primary]")
            pg.wait_for_selector(".voice-problem", timeout=STATE_MS)
            assert "failed" in pg.inner_text(".voice-problem").lower()
            assert pg.inner_text(NATURAL + " button[data-primary]") == "Retry"
            _shot(pg, "4-failed")
        finally:
            br.close()
