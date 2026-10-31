"""#121: Automatic Read aloud gives way to a faster voice when a slow one stalls.

A real <audio> reports paused=false from the moment play() is called, even while its
source is still loading, so a give-way timer that asked only "is it paused?" never
fired during a stall. The page here runs the shipped readaloud.js over a real media
element (Chromium and, where installed, WebKit) against a server that answers the
slow voice late and the fast voice at once.

Run: pytest tests/test_readaloud_gives_way_browser.py -v
"""

import io
import json
import os
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import pytest

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static")
SLOW_S = 8  # the slow voice's answer: far past the page's start wait below
START_WAIT_MS = 700


def _wav(seconds=1):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(8000)
        w.writeframes(b"\x80" * 8000 * seconds)
    return b.getvalue()


PAGE = """<!doctype html><meta charset=utf-8><body><script>
var SK = {TTS_SLOW: 'zimi_tts_slow', TTS_DEVICE_TIMES: 'zimi_tts_device_times'};
var _DEVICE_VOICE = 'device', _TTS_AVAILABLE = false, _ttsVoices = null, _ttsPaused = false, _ttsRun = 1;
var _ttsNow = {}, _ttsSpinTimer = 0, _ttsSpeaking = false;
function _getStorageJSON(k, fb) { try { var v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } }
function _setStorageJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function _voicePrefs() { return {voice: '', off: []}; }
function _langPrimary(t) { return String(t || '').split('-')[0]; }
function _normLang(c) { return c; }
function _voiceTimings(server) { return Object.assign({}, server || {}); }
function _ttsRate() { return 1; }
function authedFetch(u, o) { return fetch(u, o); }
function _ttsSetSpeaking() {}
function _ttsAlongAudio() {}
function _ttsAlongAt() {}
function _ttsBarSync() {}
function _ttsHold() {}
function _ttsAheadTick() {}
function _ttsSpeakDevice() { window.deviceTook = true; }
</script>
<script src="/readaloud.js"></script>
<script>
_TTS_START_WAIT_MS = %(wait)d;
window.deviceTook = false;
function startReading() {
  _ttsRun = 1;
  _ttsAudio = new Audio();
  _ttsSpeakServer(['One short title.', 'A second sentence to follow it.'], 'en', ['kokoro', 'piper'], 1);
}
</script>
"""


@pytest.fixture(scope="module")
def site():
    log = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/":
                body, kind = (PAGE % {"wait": START_WAIT_MS}).encode(), "text/html"
            elif u.path == "/readaloud.js":
                with open(os.path.join(STATIC, "readaloud.js"), "rb") as f:
                    body, kind = f.read(), "text/javascript"
            elif u.path == "/dictionary/speak":
                engine = parse_qs(u.query).get("engine", [""])[0]
                log.append((engine, time.monotonic()))
                if engine == "kokoro":
                    time.sleep(SLOW_S)
                body, kind = _wav(), "audio/wav"
            else:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except OSError:
                pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1], log
    httpd.shutdown()


@pytest.fixture(scope="module")
def pw():
    sync_playwright = pytest.importorskip("playwright.sync_api").sync_playwright  # a runner without a browser skips

    with sync_playwright() as p:
        yield p


@pytest.mark.parametrize("name", ["chromium", "webkit"])
def test_automatic_gives_way_to_the_faster_voice_while_the_slow_one_is_still_loading(pw, site, name):
    base, log = site
    try:
        browser = getattr(pw, name).launch(args=["--autoplay-policy=no-user-gesture-required"] if name == "chromium" else [])
    except Exception as e:  # the browser is not installed here
        pytest.skip("%s unavailable: %s" % (name, str(e).splitlines()[0]))
    try:
        pg = browser.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        del log[:]
        pg.goto(base + "/")
        pg.evaluate("startReading()")
        deadline = time.monotonic() + SLOW_S - 3  # well before the slow voice would have answered
        while time.monotonic() < deadline and not any(e == "piper" for e, _t in log):
            time.sleep(0.05)
        engines = [e for e, _t in log]
        assert not errors, errors
        assert "kokoro" in engines, "the slow voice was asked first: %s" % engines
        assert "piper" in engines, "Automatic never gave way while Natural was loading: %s" % engines
        assert pg.evaluate("window.deviceTook") is False
        pg.evaluate("_ttsStop && _ttsStop()")
    finally:
        browser.close()
