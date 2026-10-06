"""Dictionary in a real browser, on a phone's width.

A word opens across the Wiktionaries, the reader's language first; it can
be heard (a recording where the ZIM has one, else this device's voice for
the word's language, and a plain word where the device has none, never
another language's voice); a translation is a tap to that word, with the
trail of how you got there and Zimi's arrow walking it back; Save keeps
the word, and the front lists it with the words you looked at.

The device's voices are a Mac's, given to the page (headless Chromium has
none): English and French, no Maltese; its reader reads English and French.
The server says nothing (no Piper, say or espeak-ng) except in the test of
the server's voice, where a fake Piper on PATH writes a known WAV.

Run: pytest tests/test_dictionary_live.py -v
"""

import os
import sys
import threading
import time
import urllib.parse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dictionary_fixture as fx  # noqa: E402
import test_voices as tv  # noqa: E402
import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
from zimi import dictionary as dic  # noqa: E402
from zimi import voices  # noqa: E402

SHOTS = os.environ.get("ZIMI_SHOTS", "")
VOICES = """(() => {
  const vs = [{name:'Bubbles', lang:'en-US', localService:true}, {name:'Samantha', lang:'en-US', localService:true, default:true},
    {name:'Daniel', lang:'en-GB', localService:true}, {name:'Thomas', lang:'fr-FR', localService:true}];
  window.__said = [];
  const s = { getVoices: () => vs, cancel: () => {}, addEventListener: () => {},
    speak: u => { window.__said.push([u.text, u.voice && u.voice.name, u.lang]); setTimeout(() => u.onend && u.onend(), 20); } };
  Object.defineProperty(window, 'speechSynthesis', { value: s, configurable: true });
  window.SpeechSynthesisUtterance = function(t) { this.text = t; };
  // A reader of English and French.
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'fr-FR'] });
})();"""
FRAME = "f => f.url.indexOf('dictionary.html') >= 0"


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("dict")
    zdir = tmp / "zims"
    zdir.mkdir()
    fx.build_library(str(zdir))
    mp = pytest.MonkeyPatch()
    mp.delenv("ZIMI_APPS", raising=False)
    mp.setattr(srv, "ZIM_DIR", str(zdir))
    mp.setattr(srv, "ZIMI_DATA_DIR", str(tmp / "data"))
    os.makedirs(str(tmp / "data"), exist_ok=True)
    # The server says nothing: the device's voices are the ones under test.
    mp.setenv(voices.PIPER_CMD_ENV, str(tmp / "no-piper"))
    mp.setattr(voices, "_say_voices", lambda: {})
    mp.setattr(voices, "_espeak_voices", lambda: {})
    for name in ("ZIMI_OFFLINE", voices.DOWNLOADS_ENV):
        mp.delenv(name, raising=False)
    voices._reset_for_tests()
    dic._reset_for_tests()
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


def _frame(pg):
    for _ in range(100):
        f = next((f for f in pg.frames if "dictionary.html" in f.url), None)
        if f:
            return f
        pg.wait_for_timeout(100)
    raise AssertionError("the Dictionary page never opened")


STATE = """() => ({ h1: (document.querySelector('.hw h1') || {}).textContent || null,
  loading: !!document.querySelector('.sk'), page: location.href.split('#')[0], shell: parent.location.href })"""


def _word(f, w):
    """The word on the page, drawn: first its heading (the page took the
    step), then its entries (the lookup answered). A timeout says which of
    the two never came, and what the page showed instead."""
    for cond, what in (
        (
            "w => { const h = document.querySelector('.hw h1'); return h && h.textContent === w; }",
            "the page never went to it",
        ),
        (
            "w => { const h = document.querySelector('.hw h1'); return h && h.textContent === w && !document.querySelector('.sk'); }",
            "the lookup never answered",
        ),
    ):
        try:
            f.wait_for_function(cond, arg=w, timeout=20000)
        except Exception as e:
            raise AssertionError(
                "%r: %s; the page: %r" % (w, what, f.evaluate(STATE))
            ) from e


def _still(pg):
    """Until the reader's frame holds its place for a few looks. Scrolling
    the page slides Zimi's header away (or back), and the whole frame with
    it, over 0.2s; a click in that slide pressed a link and let go over the
    line above it, so nothing opened (a slow runner, 2026-10-02)."""
    pg.evaluate("() => { window.__still = null; }")
    pg.wait_for_function(
        "() => { const v = document.getElementById('reader-frame').getBoundingClientRect();"
        " const w = window.__still || (window.__still = { y: null, n: 0 });"
        " w.n = v.top === w.y ? w.n + 1 : 0; w.y = v.top; return w.n >= 3; }",
        polling=150,
        timeout=10000,
    )


def _tap(f, sel):
    """Tap as a reader does: brought into view, then tapped once still."""
    f.eval_on_selector(sel, "e => e.scrollIntoView({ block: 'center' })")
    _still(f.page)
    f.click(sel)


def _shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, "dictionary-" + name + ".png"))


@pytest.mark.parametrize("scheme", ["dark", "light"])
def test_a_word_heard_followed_and_kept_at_390px(served, scheme):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            color_scheme=scheme,
            locale="en-US",
            is_mobile=True,
            has_touch=True,
        )
        ctx.add_init_script(VOICES)
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(served + "/?dictionary=water")
            f = _frame(pg)
            _word(f, "water")
            _shot(pg, "water-" + scheme)
            got = f.evaluate(
                """() => ({
              first: document.querySelector('.lang .lang-h h2').textContent,
              langs: Array.from(document.querySelectorAll('.lang')).map(s => s.tagName + ':' + s.querySelector('h2').textContent),
              audio: Array.from(document.querySelectorAll('[data-audio]')).map(b => b.getAttribute('data-audio')),
              wide: document.documentElement.scrollWidth - document.documentElement.clientWidth })"""
            )
            # English first (Zimi's language), then French, both the reader's.
            assert got["first"] == "English"
            assert got["langs"] == ["SECTION:English", "SECTION:French"]
            # Simple English's US recording is in its ZIM: the word is heard from it.
            assert got["audio"] == ["/w/wiktionary_en_simple/-/En-us-water.ogg"]
            assert got["wide"] <= 0
            # A translation is a tap away: French "eau".
            _tap(f, "a[data-w='eau#French']")
            _word(f, "eau")
            pg.wait_for_url("**/?dictionary=eau", timeout=5000)
            trail = f.evaluate(
                "() => Array.from(document.querySelectorAll('#trail button, #trail .now')).map(e => e.textContent)"
            )
            assert trail == ["water", "eau"]
            # Landed on the French word, open; it is said by the French voice.
            fr = f.evaluate(
                "() => { const i = Array.from(document.querySelectorAll('.lang')).findIndex(s => s.querySelector('h2').textContent === 'French'); const s = document.querySelectorAll('.lang')[i]; return { open: s.tagName === 'SECTION' || s.open, say: !!s.querySelector('[data-say]:not([hidden])') }; }"
            )
            assert fr == {"open": True, "say": True}
            _tap(f, "[data-say][data-code='fr']:not([hidden])")
            f.wait_for_function("() => window.__said.length > 0")
            said = f.evaluate("() => window.__said")
            assert said[-1] == ["eau", "Thomas", "fr-FR"]
            _shot(pg, "eau-" + scheme)
            # Zimi's arrow walks the trail back (its header back in view at the top).
            f.evaluate("() => window.scrollTo(0, 0)")
            pg.wait_for_function(
                "() => !document.body.classList.contains('chrome-away')"
            )
            _still(pg)
            pg.click("#back-btn")
            _word(f, "water")
            assert f.evaluate("() => document.getElementById('trail').hidden")
            # Save keeps the word as a word of Dictionary.
            _tap(f, ".svbar [data-sv='save']")
            kept = pg.evaluate(
                "() => Saved.itemsFor({ app: 'dictionary' }).map(x => [x.kind, x.title])"
            )
            assert kept == [["word", "water"]]
            # The front: the words looked at, and the one kept.
            pg.goto(served + "/#dictionary")
            f = _frame(pg)
            f.wait_for_selector(".cloud a[data-w='water']", timeout=20000)
            # The word of the day is said where it stands, beside its link
            # (drawn when the day's words answer, after the cloud).
            f.wait_for_selector(".wotd-box > .wotd-say [data-say]", state="attached", timeout=20000)
            assert f.evaluate(
                "() => { const b = document.querySelector('.wotd-box > .wotd-say [data-say]'); return !!b && !b.closest('a'); }"
            )
            heads = f.evaluate(
                "() => Array.from(document.querySelectorAll('.shelf-h h2')).map(h => h.textContent)"
            )
            assert heads[:3] == ["More words", "Recent", "Saved"]
            assert "Your dictionaries" in heads
            recent = f.evaluate(
                "() => Array.from(document.querySelectorAll('.shelf:not(.more-words)')[0].querySelectorAll('a')).map(a => a.textContent)"
            )
            assert set(recent) == {"water", "eau"}
            _shot(pg, "home-" + scheme)
            assert not errors, errors
        finally:
            br.close()


@pytest.mark.parametrize("scheme", ["dark", "light"])
def test_the_front_offers_more_words_than_one_at_390px(served, scheme):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            color_scheme=scheme,
            locale="en-US",
            is_mobile=True,
            has_touch=True,
        )
        ctx.add_init_script(VOICES)
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        try:
            pg.goto(served + "/#dictionary")
            f = _frame(pg)
            f.wait_for_selector(".more-words .cloud a", timeout=20000)
            got = f.evaluate(
                """() => ({ day: (document.querySelector('.wotd .w') || {}).textContent || '',
              more: Array.from(document.querySelectorAll('.more-words .cloud a')).map(a => [a.getAttribute('data-w'), (a.querySelector('.ml') || {}).textContent || '']),
              wide: document.documentElement.scrollWidth - document.documentElement.clientWidth })"""
            )
            # The word of the day, and at least six more besides it.
            assert got["day"] and len(got["more"]) >= 6, got
            assert got["day"] not in [w for w, _ in got["more"]]
            # A French word says it is French; Zimi speaks English.
            assert "French" in [lang for _, lang in got["more"]]
            assert got["wide"] <= 0
            pg.wait_for_function(
                "() => getComputedStyle(document.getElementById('reader-loading')).opacity === '0' || document.getElementById('reader-loading').offsetParent === null"
            )
            _shot(pg, "front-more-" + scheme)
            # Shuffle brings another handful, still words that open.
            f.click(".more-words .shelf-h .all")
            f.wait_for_function(
                "() => { const b = document.querySelector('.more-words .shelf-h .all'); return b && !b.disabled; }"
            )
            first = f.evaluate(
                "() => document.querySelector('.more-words .cloud a').getAttribute('data-w')"
            )
            _tap(f, ".more-words .cloud a")
            _word(f, first)
            assert not errors, errors
        finally:
            br.close()


def test_a_language_the_device_cannot_speak_says_so(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            locale="en-US",
            is_mobile=True,
            has_touch=True,
        )
        ctx.add_init_script(VOICES)
        pg = ctx.new_page()
        try:
            pg.goto(served + "/?dictionary=ilma")
            f = _frame(pg)
            _word(f, "ilma")
            pg.wait_for_timeout(1500)
            got = f.evaluate(
                """() => ({ say: Array.from(document.querySelectorAll('[data-say]')).filter(b => !b.hidden).length,
              note: (document.querySelector('[data-novoice]:not([hidden])') || {}).textContent || '',
              ipa: (document.querySelector('.ipa') || {}).textContent })"""
            )
            # No Maltese voice: no button that would read it in English, and a line that says why.
            assert got == {
                "say": 0,
                "note": "No Maltese voice on this device",
                "ipa": "/ˈɪl.ma/",
            }
            _shot(pg, "ilma")
        finally:
            br.close()


def test_typing_suggests_and_enter_opens(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_context(
            viewport={"width": 1280, "height": 900}, locale="en-US"
        ).new_page()
        try:
            pg.goto(served + "/#dictionary")
            f = _frame(pg)
            f.wait_for_selector(".dicts", timeout=20000)
            pg.fill("#q", "ea")
            f.wait_for_selector(".sug a[data-w='eau']", timeout=10000)
            pg.fill("#q", "eau")
            pg.press("#q", "Enter")
            _word(f, "eau")
            pg.wait_for_url("**/?dictionary=eau", timeout=5000)
            # Nobody has it: said, with the words that are near.
            pg.fill("#q", "watr")
            pg.press("#q", "Enter")
            f.wait_for_selector(".empty", timeout=10000)
            assert "No dictionary here has" in f.inner_text(".empty")
        finally:
            br.close()


def test_zimis_language_opens_the_translation_and_back_returns(served):
    """Eric, 2026-10-01: switching Zimi's language with a word open opens its
    translation. 2026-10-02: freeze to Spanish "worked for freeze but not
    going back". Zimi's arrow returns to the word the switch started from."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            locale="en-US",
            is_mobile=True,
            has_touch=True,
        )
        ctx.add_init_script(VOICES)
        pg = ctx.new_page()
        try:
            pg.goto(served + "/?dictionary=water")
            _word(_frame(pg), "water")
            pg.evaluate("() => setLanguage('fr')")
            pg.wait_for_url("**/?dictionary=eau", timeout=10000)
            _word(_frame(pg), "eau")
            pg.wait_for_function(
                "() => !document.body.classList.contains('chrome-away')"
            )
            _still(pg)
            pg.click("#back-btn")
            pg.wait_for_url("**/?dictionary=water", timeout=10000)
            _word(_frame(pg), "water")
        finally:
            br.close()


# Every <audio> the page starts, and what it was asked to play.
PLAYED = """(() => {
  window.__played = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() { window.__played.push(this.src); return play.call(this); };
})();"""
OFFER = "() => { const o = document.querySelector('[data-offer=\\'fr\\']:not([hidden])'); return o ? o.textContent : ''; }"


def test_say_is_the_servers_audio_and_the_download_line_follows_the_setting(
    served, tmp_path, monkeypatch
):
    """Eric's phone on silent: Say plays the server's WAV through <audio>,
    never speechSynthesis, when the server can say the language. Without a
    clearer voice for it the device speaks, and an admin is offered one,
    unless the setting is Never or Zimi is offline."""
    from playwright.sync_api import sync_playwright

    monkeypatch.delenv(voices.PIPER_CMD_ENV, raising=False)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ.get("PATH", ""))
    tv.fake_piper(tmp_path)
    voices._reset_for_tests()
    assert voices.piper_command() == [
        str(tmp_path / "piper")
    ], "the fake Piper, found on PATH"

    def fetched(tag):
        tv.install(tag)
        with voices._lock:
            voices._download.clear()

    monkeypatch.setattr(voices, "_fetch_voice", fetched)
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            locale="en-US",
            is_mobile=True,
            has_touch=True,
        )
        ctx.add_init_script(VOICES)
        ctx.add_init_script(PLAYED)
        pg = ctx.new_page()
        answers = []
        pg.on(
            "response",
            lambda r: "/dictionary/speak" in r.url
            and answers.append((r.status, r.headers.get("content-type"))),
        )
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        def open_eau():
            pg.goto(served + "/?dictionary=eau")
            f = _frame(pg)
            _word(f, "eau")
            f.wait_for_function(
                "() => document.querySelector('[data-say][data-code=\"fr\"]:not([hidden])')"
            )
            pg.wait_for_timeout(300)
            return f

        try:
            # No French voice on the server: the device says it, and an
            # admin (this machine, no password) is offered a clearer one.
            f = open_eau()
            f.wait_for_function("() => (%s)() !== ''" % OFFER)
            assert f.evaluate(OFFER) == "Clearer voice for French: Download (63 MB)"
            _shot(pg, "voice-offer")
            _tap(f, "[data-say][data-code='fr']:not([hidden])")
            f.wait_for_function("() => window.__said.length > 0")
            assert f.evaluate("() => window.__played") == []
            # Never, and offline: no line.
            voices.POLICY.set("never")
            f = open_eau()
            assert f.evaluate(OFFER) == ""
            voices.POLICY.set("ask")
            monkeypatch.setenv("ZIMI_OFFLINE", "1")
            f = open_eau()
            assert f.evaluate(OFFER) == ""
            monkeypatch.delenv("ZIMI_OFFLINE")
            # The tap downloads it; then Say is the server's audio.
            f = open_eau()
            f.wait_for_function("() => (%s)() !== ''" % OFFER)
            _tap(f, "[data-get='fr']")
            f.wait_for_function("() => (%s)() === ''" % OFFER, timeout=10000)
            assert "fr" in voices.installed()
            _shot(pg, "voice-installed")
            pg.reload()
            f = open_eau()
            f.evaluate("() => { window.__said = []; }")
            _tap(f, "[data-say][data-code='fr']:not([hidden])")
            f.wait_for_function("() => window.__played.length > 0")
            played = f.evaluate("() => window.__played")
            assert "/dictionary/speak?text=eau&lang=fr&v=" in played[-1], played
            pg.wait_for_timeout(500)
            assert (
                f.evaluate("() => window.__said") == []
            ), "speechSynthesis is not called"
            # Chromium asks for it by range, as Safari does.
            assert answers and answers[-1] in (
                (200, "audio/wav"),
                (206, "audio/wav"),
            ), answers
            # Removed: the device says it again, at once.
            assert voices.remove("fr")
            f = open_eau()
            f.evaluate("() => { window.__played = []; }")
            _tap(f, "[data-say][data-code='fr']:not([hidden])")
            f.wait_for_function("() => window.__said.length > 0")
            assert f.evaluate("() => window.__played") == []
            assert not errors, errors
        finally:
            br.close()
            voices.remove("fr")
            voices.POLICY.set("ask")
            voices._reset_for_tests()


SAY_FR = "[data-say][data-code='fr']:not([hidden])"
SAY_EN = "[data-say][data-code='en']:not([hidden])"
LINE_FR = "() => { const o = document.querySelector('[data-offer=\\'fr\\']'); return o && !o.hidden ? o.textContent : ''; }"



def _settle_downloads():
    """A stand-in download an earlier test left running still writes the
    shared download state; one that lands mid-test made the download line
    flake in a full run (never alone). Cancel it and wait it out."""
    voices.cancel_download()
    for _ in range(100):
        with voices._lock:
            if not voices._download.get("tag"):
                return
        time.sleep(0.1)

@pytest.fixture
def piper_here(served, tmp_path, monkeypatch):
    """A fake Piper on PATH, and a phone to open eau on."""
    from playwright.sync_api import sync_playwright

    monkeypatch.delenv(voices.PIPER_CMD_ENV, raising=False)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ.get("PATH", ""))
    tv.fake_piper(tmp_path)
    _settle_downloads()
    voices._reset_for_tests()
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(
            viewport={"width": 390, "height": 844},
            locale="en-US",
            is_mobile=True,
            has_touch=True,
        )
        ctx.add_init_script(VOICES)
        ctx.add_init_script(PLAYED)
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        def open_eau():
            pg.goto(served + "/?dictionary=eau")
            f = _frame(pg)
            _word(f, "eau")
            f.wait_for_function("s => document.querySelector(s)", arg=SAY_FR)
            pg.wait_for_timeout(300)
            return f

        try:
            yield open_eau, errors
        finally:
            br.close()
            for tag in list(voices.installed()):
                voices.remove(tag)
            voices.POLICY.set("ask")
            voices._reset_for_tests()


def test_say_shows_it_is_working_never_stacks_and_recovers(piper_here, monkeypatch):
    """A server voice's first word takes seconds (Kokoro, about five): the
    button says so from the tap, more taps add nothing, and audio that
    fails hands the word to the device, whose voice the next tap uses at
    once (inside the tap, where iOS lets speech start)."""
    open_eau, errors = piper_here
    tv.install("fr")
    tv.install("en-US")
    real = voices.speak

    def slow(*a, **k):
        time.sleep(1.5)
        return real(*a, **k)

    monkeypatch.setattr(voices, "speak", slow)
    f = open_eau()
    f.eval_on_selector(SAY_FR, "b => { b.click(); b.click(); b.click(); }")
    assert (
        f.eval_on_selector(
            SAY_FR, "b => b.classList.contains('busy') && b.getAttribute('aria-busy')"
        )
        == "true"
    )
    f.wait_for_function(
        "s => !document.querySelector(s).classList.contains('busy')",
        arg=SAY_FR,
        timeout=10000,
    )
    f.wait_for_function(
        "s => !document.querySelector(s).classList.contains('on')",
        arg=SAY_FR,
        timeout=10000,
    )
    assert len(f.evaluate("() => window.__played")) == 1, "three taps, one word"
    assert f.evaluate("() => window.__said") == []
    # Audio that is not audio (English, not yet heard, so not in the
    # browser's cache): the server says it made it, the device says it, and
    # the button is idle.
    monkeypatch.setattr(voices, "speak", lambda *a, **k: b"RIFF not a wave")
    monkeypatch.setattr(voices, "said", lambda *a, **k: {"made": True, "failed": False})
    f.evaluate("() => { window.__played = []; }")
    f.eval_on_selector(SAY_EN, "b => b.click()")
    f.wait_for_function("() => window.__said.length === 1", timeout=10000)
    assert f.evaluate("() => window.__said[0][1]") == "Samantha"
    f.wait_for_function(
        "s => document.querySelector(s).className === 'spk'", arg=SAY_EN
    )
    f.eval_on_selector(SAY_EN, "b => b.click()")
    f.wait_for_function("() => window.__said.length === 2")
    assert (
        len(f.evaluate("() => window.__played")) == 1
    ), "the next tap went straight to the device"
    assert not errors, errors


# The stand-in download: eight steps, quick, and waits with room for a busy
# CI runner (it timed out there at 10 s with half-second steps).
DL_STEP_S = 0.25
DL_WAIT_MS = 20000


def test_the_download_line_moves_cancels_fails_and_goes(piper_here, monkeypatch):
    """The line under the word: a bar that moves while the voice comes,
    Cancel, a failure said plainly with Retry, and gone when it is here,
    Say then the server's without a reload. A page opened mid-download
    picks the progress up. A viewer who is not an admin sees no line."""
    from zimi import users

    open_eau, errors = piper_here
    steps = {"fail": False}

    def fetch(tag):
        with voices._lock:
            total = voices._download["total"]
        for i in range(1, 9):
            time.sleep(DL_STEP_S)
            with voices._lock:
                if voices._download.get("cancel"):
                    voices._download.clear()
                    return
                voices._download["done"] = total * i // 10
        with voices._lock:
            voices._download.clear()
            if steps["fail"]:
                voices._download.update({"tag": None, "error": tag})
                return
        tv.install(tag)

    monkeypatch.setattr(voices, "_fetch_voice", fetch)
    f = open_eau()
    f.wait_for_function("() => (%s)() !== ''" % LINE_FR)
    # Cancel: back to the offer.
    f.eval_on_selector("[data-get='fr']", "b => b.click()")
    assert f.evaluate(LINE_FR).startswith("Downloading the voice for French")
    f.wait_for_function("() => /[1-9][0-9]*%%/.test((%s)())" % LINE_FR, timeout=DL_WAIT_MS)
    f.eval_on_selector("[data-offer='fr'] [data-cancel]", "b => b.click()")
    f.wait_for_function(
        "() => (%s)() === 'Clearer voice for French: Download (63 MB)'" % LINE_FR,
        timeout=DL_WAIT_MS,
    )
    # A failure: said, with Retry.
    steps["fail"] = True
    f.wait_for_function(
        "() => !document.querySelector('[data-offer=fr] [data-cancel]')", timeout=DL_WAIT_MS
    )
    f.eval_on_selector("[data-get='fr']", "b => b.click()")
    f.wait_for_function(
        '() => (%s)() === "Couldn\'t download the voice Retry"' % LINE_FR, timeout=DL_WAIT_MS
    )
    # Retry, and leave mid-way: the page opened again picks it up, moving.
    steps["fail"] = False
    f.eval_on_selector("[data-offer='fr'] [data-get='fr']", "b => b.click()")
    f.wait_for_function("() => /Cancel$/.test((%s)())" % LINE_FR, timeout=DL_WAIT_MS)
    f = open_eau()
    seen = f.evaluate(LINE_FR)
    assert seen.startswith("Downloading"), seen
    f.wait_for_function(
        "s => { const l = (%s)(); return l !== s && l !== ''; }" % LINE_FR,
        arg=seen,
        timeout=DL_WAIT_MS,
    )
    # Done: the line goes, and Say is the server's.
    f.wait_for_function("() => (%s)() === ''" % LINE_FR, timeout=DL_WAIT_MS)
    assert "fr" in voices.installed()
    f.eval_on_selector(SAY_FR, "b => b.click()")
    f.wait_for_function("() => window.__played.length > 0")
    assert f.evaluate("() => window.__said") == []
    # Not an admin: no line, and the device still says it.
    voices.remove("fr")
    monkeypatch.setattr(users, "_request_is_admin", lambda h: False)
    f = open_eau()
    assert f.evaluate(LINE_FR) == ""
    assert not errors, errors


CARET_FR = "[data-voices='fr']"
MENU_FR = "() => [...document.querySelectorAll(\"[data-voices='fr'] + .menu .menu-item\")].map(i => [i.querySelector('.vname').textContent, i.hasAttribute('data-default'), i.getAttribute('data-engine')])"


def test_say_has_a_menu_of_every_voice_that_can_say_the_word(piper_here, monkeypatch):
    """Eric, 2026-10-03: "A lil dropdown on the say button". Say plays the
    default voice; its caret opens a menu of every voice that can say the
    word, the default ticked, each a one-off listen by its own engine. One
    voice: no caret. Arrows, Escape (focus back on the caret) and a tap
    outside work as the shell's menus do."""
    open_eau, errors = piper_here
    f = open_eau()
    assert f.eval_on_selector(CARET_FR, "c => c.hidden"), "the device alone: no caret"
    tv.install("fr")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"fr": {"FR": "fr-fr"}})
    f = open_eau()
    f.wait_for_function("s => !document.querySelector(s).hidden", arg=CARET_FR)
    caret = f.eval_on_selector(
        CARET_FR,
        "c => [c.getAttribute('aria-haspopup'), c.getAttribute('aria-expanded')]",
    )
    assert caret == ["menu", "false"]
    _shot(f.page, "say-menu-closed-light")
    _tap(f, CARET_FR)
    assert f.evaluate(MENU_FR) == [
        ["Clear", True, "piper"],
        ["Basic", False, "espeak"],
        ["Device", False, "device"],
        ["Voices…", False, None],
    ]
    assert not f.query_selector(".menu-check"), "no tick: 'default' says it"
    assert f.eval_on_selector("[data-default] .vdef", "e => e.textContent") == "default"
    assert (
        f.eval_on_selector(CARET_FR + " + .menu", "m => m.getAttribute('role')")
        == "menu"
    )
    heights = f.eval_on_selector_all(
        ".menu-item", "is => is.map(i => i.getBoundingClientRect().height)"
    )
    assert min(heights) >= 44, heights
    assert (
        f.evaluate("() => document.activeElement.getAttribute('data-engine')")
        == "piper"
    ), "the ticked voice has focus"
    assert f.evaluate("() => document.documentElement.scrollWidth") <= 390
    _shot(f.page, "say-menu-open-light")
    f.page.emulate_media(color_scheme="dark")
    _shot(f.page, "say-menu-open-dark")
    f.page.emulate_media(color_scheme="light")
    # A voice playing: the item pulses as Say does.
    f.evaluate(
        "() => { HTMLMediaElement.prototype.play = function() { window.__played.push(this.src); return new Promise(() => {}); }; }"
    )
    f.click(".menu-item[data-engine='piper']")
    f.wait_for_selector(".menu-item.busy[data-engine='piper']")
    _shot(f.page, "say-menu-playing-light")
    f.page.emulate_media(color_scheme="dark")
    _shot(f.page, "say-menu-playing-dark")
    f.page.emulate_media(color_scheme="light")
    # A voice from the menu: its own engine's audio, the menu still open
    # (the next voice is a tap away) and the item, not Say, at work.
    f.click(".menu-item[data-engine='espeak']")
    f.wait_for_function("() => window.__played.length > 0")
    assert "&engine=espeak&" in f.evaluate("() => window.__played")[-1]
    assert (
        f.eval_on_selector(CARET_FR, "c => c.getAttribute('aria-expanded')") == "true"
    )
    f.click(".hw h1")
    # No espeak-ng here after all: the server says 404, and Basic leaves the
    # menu rather than another voice answering under its name.
    f.wait_for_function("() => !document.querySelector('.spk.busy')")
    _tap(f, CARET_FR)
    assert [e for _t, _c, e in f.evaluate(MENU_FR)] == ["piper", "device", None]
    # The device's own voice.
    f.evaluate("() => { window.__said = []; }")
    f.click(".menu-item[data-engine='device']")
    f.wait_for_function("() => window.__said.length > 0")
    assert f.evaluate("() => window.__said")[0][1] == "Thomas"
    # The last pick is Say's from now on (Settings > Voices remembers it).
    f.click(".hw h1")
    f.evaluate("() => { window.__said = []; }")
    _tap(f, SAY_FR)
    f.wait_for_function("() => window.__said.length > 0")
    # With no preference, Say plays the default, with no engine named.
    f.evaluate(
        "() => { localStorage.removeItem('zimi_voice_prefs'); window.__played = []; }"
    )
    _tap(f, SAY_FR)
    f.wait_for_function("() => window.__played.length > 0")
    assert "engine=" not in f.evaluate("() => window.__played")[-1]
    # Keys: Down opens on the ticked voice, Down moves, Escape closes and
    # gives focus back to the caret.
    f.focus(CARET_FR)
    f.page.keyboard.press("ArrowDown")
    assert (
        f.evaluate("() => document.activeElement.getAttribute('data-engine')")
        == "piper"
    )
    f.page.keyboard.press("ArrowDown")
    assert (
        f.evaluate("() => document.activeElement.getAttribute('data-engine')")
        == "device"
    )
    f.page.keyboard.press("ArrowDown")
    assert f.evaluate("() => document.activeElement.hasAttribute('data-sheet')")
    f.page.keyboard.press("ArrowDown")
    assert (
        f.evaluate("() => document.activeElement.getAttribute('data-engine')")
        == "piper"
    ), "round again"
    f.page.keyboard.press("Escape")
    assert f.evaluate("() => document.activeElement.matches(\"[data-voices='fr']\")")
    assert f.eval_on_selector(CARET_FR + " + .menu", "m => m.hidden")
    # A tap outside closes it.
    _tap(f, CARET_FR)
    f.click(".hw h1")
    assert f.eval_on_selector(CARET_FR + " + .menu", "m => m.hidden")
    # Right to left, the menu hangs from Say's other edge.
    f.evaluate("() => { document.documentElement.dir = 'rtl'; }")
    _tap(f, CARET_FR)
    edges = f.eval_on_selector(
        CARET_FR + " + .menu",
        "m => [m.getBoundingClientRect().right, m.parentNode.getBoundingClientRect().right]",
    )
    assert abs(edges[0] - edges[1]) < 1, edges
    f.click(".hw h1")
    f.evaluate("() => { document.documentElement.dir = 'ltr'; }")
    f.page.emulate_media(color_scheme="dark")
    _shot(f.page, "say-menu-closed-dark")
    assert not errors, errors


IDLE = "() => !document.querySelector('.spk.busy, .spk.on, .menu-item.busy, .menu-item.on')"


def test_a_busy_voice_stays_and_a_missing_one_goes(piper_here, monkeypatch):
    """Eric, 2026-10-03: "piper disappeared while i was using it on
    homophone". A voice the server is too busy for (503) stays in the menu,
    Say is idle again, nothing else answers under its name, and the next
    tap asks the server again. Only a voice the server cannot say the word
    in at all (404) leaves the menu."""
    open_eau, errors = piper_here
    tv.install("fr")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"fr": {"FR": "fr-fr"}})

    def busy(*a, **k):
        raise voices.Busy("queue full")

    monkeypatch.setattr(voices, "speak", busy)
    f = open_eau()
    f.wait_for_function("s => !document.querySelector(s).hidden", arg=CARET_FR)
    _tap(f, CARET_FR)
    for engine in ("piper", "piper", "espeak"):
        f.click(".menu-item[data-engine='%s']" % engine)
        f.wait_for_function(IDLE)
        f.wait_for_timeout(300)  # the page's question to the server, answered
    f.click(".hw h1")
    _tap(f, SAY_FR)
    f.wait_for_function(IDLE)
    f.wait_for_timeout(300)
    played = f.evaluate("() => window.__played")
    assert len(played) == 4, "every tap asked the server again: %r" % played
    assert f.evaluate("() => window.__said") == [], "no other voice under its name"
    _tap(f, CARET_FR)
    assert [e for _t, _c, e in f.evaluate(MENU_FR)] == [
        "piper",
        "espeak",
        "device",
        None,
    ]
    f.click(".hw h1")
    # The server has no Basic voice for it after all: 404, and Basic goes.
    monkeypatch.setattr(voices, "speak", lambda *a, **k: None)
    monkeypatch.setattr(
        voices,
        "said",
        lambda text, lang, accent="", engine=None, limit=None: (
            None if engine == "espeak" else {"made": False, "failed": False}
        ),
    )
    _tap(f, CARET_FR)
    f.click(".menu-item[data-engine='espeak']")
    f.wait_for_function(IDLE)
    f.wait_for_timeout(300)
    f.click(".hw h1")
    _tap(f, CARET_FR)
    assert [e for _t, _c, e in f.evaluate(MENU_FR)] == ["piper", "device", None]
    f.click(".hw h1")
    assert not errors, errors


def test_the_page_asks_the_server_to_load_its_voices(piper_here, monkeypatch):
    """The Dictionary opening asks the server to load the downloaded voices
    its languages use, once each, so the first tap is not the slow one. A
    language said only by a voice that loads nothing (espeak-ng) is not
    asked for."""
    open_eau, errors = piper_here
    tv.install("fr")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"en": {"US": "en-us"}})
    asked = []
    monkeypatch.setattr(voices, "warm", lambda langs: asked.append(list(langs)) or [])
    f = open_eau()
    f.wait_for_timeout(500)
    langs = [lang for call in asked for lang in call]
    assert "fr" in langs and not [x for x in langs if x.startswith("en")], asked
    assert len(langs) == len(set(langs)), "once each: %r" % asked
    assert not errors, errors


def _until(fn, what):
    for _ in range(80):
        if fn():
            return
        time.sleep(0.1)
    raise AssertionError(what)


VOICES_WRAP = "#ms-voices-wrap"
# Each engine's row: [name, its languages and version, on, locked on].
ENGINES = "() => [...document.querySelectorAll('#ms-voices-wrap .voice-engine')].map(r => [r.querySelector('.share-row-title').textContent, r.querySelector('.voice-meta').textContent, r.querySelector('input') ? r.querySelector('input').checked : null, r.querySelector('input') ? r.querySelector('input').disabled : null])"
PREFS = "() => JSON.parse(localStorage.zimi_voice_prefs || '{}')"
HEAR = VOICES_WRAP + " .voice-engine[data-engine='%s'] .voice-hear"
LIST = "#ms-lang-list"
FOLD = "#ms-lang-fold"
SHOW = "#ms-lang-filters"
ROW = LIST + " .lang-row[data-lang='%s']"
# The open checklist: [code, checked, locked] for each row, in order.
LANG_ROWS = "() => [...document.querySelectorAll('#ms-lang-list .lang-row')].map(r => [r.dataset.lang, r.getAttribute('aria-checked') === 'true', r.hasAttribute('aria-disabled')])"
YOURS = "() => JSON.parse(localStorage.zimi_pref_languages || '[]')"
GRID = VOICES_WRAP + " .vg"
# The voices grid: the column heads, and each row's cells by state.
GRID_HEADS = "() => [...document.querySelectorAll('#ms-voices-wrap .vg-head .vg-h')].map(h => h.textContent)"
GRID_CELLS = "() => Object.fromEntries([...document.querySelectorAll('#ms-voices-wrap .vg-row[data-lang]')].map(r => [r.dataset.lang, [...r.querySelectorAll('.vg-cell')].map(c => c.firstElementChild.dataset.s)]))"
CELL = GRID + " .vg-row[data-lang='%s'] .vg-cell:nth-child(%d) > *"


def _settings_voices(pg, served):
    pg.goto(served + "/?manage=preferences")
    pg.wait_for_function("() => window._voicesHere", timeout=20000)
    pg.eval_on_selector(VOICES_WRAP, "e => e.scrollIntoView({ block: 'center' })")


def _settings_languages(pg, served, open_list=True):
    """Settings > Languages, the checklist open."""
    pg.goto(served + "/?manage=preferences")
    pg.wait_for_function("() => window._voicesHere", timeout=20000)
    if open_list and pg.get_attribute(FOLD, "aria-expanded") != "true":
        pg.click(FOLD)
    pg.eval_on_selector("#ms-languages", "e => e.scrollIntoView({ block: 'start' })")


def _cell(pg, lang, flavor):
    """A cell of the grid, by its column's head."""
    col = pg.evaluate(GRID_HEADS).index(flavor) + 2
    return CELL % (lang, col)


def _shots(pg, name):
    """One look at a state: phone and desktop, light and dark."""
    if not SHOTS:
        return
    size = pg.viewport_size
    for w, h, tag in ((390, 844, "390"), (1280, 860, "desktop")):
        pg.set_viewport_size({"width": w, "height": h})
        for scheme in ("light", "dark"):
            pg.emulate_media(color_scheme=scheme)
            pg.wait_for_timeout(150)
            _shot(pg, "%s-%s-%s" % (name, tag, scheme))
    pg.set_viewport_size(size)
    pg.emulate_media(color_scheme="light")


def _engine(pg, name, force=False):
    pg.click(VOICES_WRAP + " .voice-engine:has-text('%s') .switch" % name, force=force)


def _slow_fetch(monkeypatch, steps):
    """A download that takes its time (60 steps of a quarter second) until
    steps["go"] is False, then lands; Cancel stops it."""

    def fetch(tag):
        with voices._lock:
            total = voices._download["total"]
        for i in range(1, 60):
            time.sleep(0.25)
            with voices._lock:
                if voices._download.get("cancel"):
                    voices._download.clear()
                    return
                voices._download["done"] = total * i // 60
            if not steps["go"]:
                break
        with voices._lock:
            voices._download.clear()
        tv.install(tag)

    monkeypatch.setattr(voices, "_fetch_voice", fetch)


LANG_BTN = "() => document.getElementById('lang-selector-btn').style.display"
# The ⋯ menu's rows, as a phone builds them: [Language offered, Manage offered].
MENU = "() => { const h = _buildTopbarMenuHtml(); return [h.includes('toggleLangDropdown'), h.includes('toggleManage') || h.includes('_openDownloadsView')]; }"
# The top bar's language menu: the languages it offers, by name.
OFFERED = "() => { _renderLangDropdown(); return [...document.querySelectorAll('#lang-dropdown .lang-dropdown-item > span:first-child')].map(s => s.textContent); }"


def test_show_languages_off_hides_the_pills_the_top_bar_and_the_list(
    piper_here, served
):
    """Eric, 2026-10-05: "let's move Show Languages to the top of Languages
    section, if off the language list and dropdown disappear (it means they
    don't want languages shown, lock in the currently-selected language and
    that's that)". The switch heads the section; off, the language pills
    over the library and catalog, the top bar's language button, the menu's
    Language and the checklist all go, and Zimi stays in English."""
    _open_eau, errors = piper_here
    pg = _open_eau().page
    _settings_languages(pg, served, open_list=False)
    first = pg.evaluate(
        "() => document.getElementById('ms-languages').nextElementSibling.querySelector('input').id"
    )
    assert first == "ms-lang-filters", "Show languages leads the section"
    row = "label.set-row:has(%s)" % SHOW
    assert pg.text_content(row + " .share-row-title") == "Show languages"
    assert pg.is_checked(SHOW) and pg.is_visible(FOLD)
    pills = "() => _renderLangPills({ en: 2, fr: 1 }, 'x')"
    assert "catalog-lang-row" in pg.evaluate(pills)
    assert pg.evaluate(LANG_BTN) != "none"
    assert pg.evaluate(MENU) == [True, True]
    assert not pg.query_selector("#ms-ui-lang"), "Zimi's language grid is gone"
    pg.click(FOLD)
    assert pg.is_visible(LIST + " .lang-row")
    pg.click(row)
    assert pg.evaluate("() => localStorage.zimi_hide_lang_chooser") == "1"
    assert pg.evaluate(pills) == ""
    assert pg.evaluate(LANG_BTN) == "none"
    assert pg.evaluate(MENU) == [False, True], "Settings is still a tap away"
    assert pg.is_hidden(FOLD) and pg.is_hidden(LIST) and pg.is_hidden("#ms-lang-hint")
    _shots(pg, "languages-off")
    # Drawn again, still off and still English.
    pg.goto(served + "/?manage=preferences")
    pg.wait_for_selector(SHOW, state="attached", timeout=20000)
    assert pg.is_hidden(FOLD) and pg.evaluate("() => _currentLang") == "en"
    assert pg.evaluate(LANG_BTN) == "none"
    pg.click(row)
    assert pg.evaluate("() => localStorage.zimi_hide_lang_chooser") is None
    assert "catalog-lang-row" in pg.evaluate(pills)
    assert pg.evaluate(LANG_BTN) != "none"
    assert pg.evaluate(MENU) == [True, True]
    assert pg.is_visible(FOLD)
    assert not errors, errors


def test_the_checklist_is_the_top_bar_menu_and_zimis_own_stays_checked(
    piper_here, served
):
    """ "show languages dropdown under show languages is a checklist of
    languages that can be enabled in the UI." Folded to one line; open, the
    ten interface languages, every one checked until one is not. Checked
    ones are the top bar's menu and your languages (the catalog, the apps,
    Discover); Zimi's own cannot be unchecked, and a language Zimi switches
    to is checked from then on."""
    _open_eau, errors = piper_here
    pg = _open_eau().page
    _settings_languages(pg, served, open_list=False)
    assert pg.get_attribute(FOLD, "aria-expanded") == "false"
    assert pg.is_hidden(LIST)
    assert pg.text_content("#ms-lang-summary") == "Every language"
    _shots(pg, "languages-folded")
    pg.click(FOLD)
    assert pg.evaluate("() => localStorage.zimi_lang_list_open") == "1"
    rows = pg.evaluate(LANG_ROWS)
    assert [c for c, _m, _l in rows] == [
        "en",
        "fr",
        "de",
        "es",
        "pt",
        "ru",
        "zh",
        "ar",
        "hi",
        "he",
    ]
    assert all(m for _c, m, _l in rows), "every one checked"
    assert [c for c, _m, locked in rows if locked] == ["en"]
    # In Zimi's language, the language's own name small after it.
    assert pg.text_content(ROW % "fr" + " .share-row-title") == "French"
    assert pg.text_content(ROW % "fr" + " .share-row-desc") == "Français"
    assert len(pg.evaluate(OFFERED)) == 10
    # Down to English and Español.
    for c in ("fr", "de", "pt", "ru", "zh", "ar", "hi", "he"):
        pg.click(ROW % c)
    assert pg.evaluate(YOURS) == ["en", "es"]
    assert pg.text_content("#ms-lang-summary") == "Languages: English, Español"
    assert pg.evaluate(OFFERED) == ["English", "Español"]
    # Zimi's own cannot be unchecked.
    pg.click(ROW % "en", force=True)
    assert pg.get_attribute(ROW % "en", "aria-checked") == "true"
    assert pg.evaluate(YOURS) == ["en", "es"]
    assert pg.evaluate("() => document.documentElement.scrollWidth") <= 390
    _shots(pg, "languages-open")
    got = pg.evaluate(
        """() => ({ catalog: [_zimMatchesLang({language: 'spa'}, null), _zimMatchesLang({language: 'fra'}, null)],
      rank: [_prefLangRank('en'), _prefLangRank('es'), _prefLangRank('fr')],
      apps: JSON.parse(decodeURIComponent(_appStrings('dictionary', []))).yours })"""
    )
    assert got["catalog"] == [True, False], got
    assert got["rank"] == [0, 1, 2], got
    assert got["apps"] == ["en", "es"], got
    # Zimi switched to Español: English stays offered, and English is now
    # one to uncheck. Switched to French (Zimipedia can): checked from then on.
    pg.evaluate("() => setLanguage('es')")
    pg.wait_for_function("() => _currentLang === 'es'")
    pg.wait_for_selector(ROW % "es" + "[aria-disabled]", timeout=20000)
    assert pg.evaluate(OFFERED) == ["English", "Español"]
    pg.evaluate("() => setLanguage('fr')")
    pg.wait_for_function("() => _currentLang === 'fr'")
    assert pg.evaluate(YOURS) == ["en", "es", "fr"]
    pg.evaluate("() => setLanguage('en')")
    pg.wait_for_function("() => _currentLang === 'en' && document.documentElement.lang === 'en'")
    # Two switches back to back redraw Settings twice; wait for the last one
    # (a slow CI runner saw the row before the redraw took it away).
    pg.wait_for_selector(ROW % "de", state="attached", timeout=20000)
    pg.wait_for_timeout(300)
    if pg.is_hidden(ROW % "de"):
        pg.click(FOLD)
    # Every one checked again: nothing stored, every language.
    pg.wait_for_selector(ROW % "de", timeout=20000)
    for c in ("de", "pt", "ru", "zh", "ar", "hi", "he"):
        pg.click(ROW % c)
    assert pg.evaluate("() => localStorage.zimi_pref_languages") is None
    assert pg.text_content("#ms-lang-summary") == "Every language"
    pg.click(FOLD)
    assert pg.evaluate("() => localStorage.zimi_lang_list_open") is None
    assert pg.is_hidden(LIST)
    assert not errors, errors


def test_the_voices_grid_shows_what_is_here_what_can_come_and_what_cannot(
    piper_here, served
):
    """Eric, 2026-10-05: "under Voices some sort of... languages list with
    like dots representing the coverage for each language across all four
    voice flavors". A row per language (Zimi's first, by its own name with
    Zimi's name for it), a column per flavor here; a cell is green where the
    flavor says it now, a download where it can come, green with ✕ for a
    Clear voice downloaded for that language, grey where none can."""
    open_eau, errors = piper_here
    tv.install("fr")
    pg = open_eau().page
    _settings_voices(pg, served)
    assert pg.evaluate(GRID_HEADS) == ["Clear", "Device"]
    cells = pg.evaluate(GRID_CELLS)
    assert cells["fr"] == ["rm", "on"], cells
    assert cells["en"] == ["get", "on"], cells
    assert cells["es"] == ["get", "none"], cells
    assert cells["zh"] == ["none", "none"], cells
    assert list(cells)[:10] == [
        "en",
        "fr",
        "de",
        "es",
        "pt",
        "ru",
        "zh",
        "ar",
        "hi",
        "he",
    ]
    assert pg.text_content(GRID + " .vg-row[data-lang='fr'] .vg-own") == "French"
    assert pg.text_content(GRID + " .vg-row[data-lang='fr'] .vg-zimi") == "Français"
    assert (
        pg.get_attribute(_cell(pg, "fr", "Clear"), "aria-label")
        == "French, Clear: downloaded, remove"
    )
    assert (
        pg.get_attribute(_cell(pg, "es", "Clear"), "aria-label")
        == "Spanish, Clear: download (63 MB)"
    )
    assert (
        pg.get_attribute(_cell(pg, "en", "Device"), "title") == "English, Device: ready"
    )
    assert (
        pg.get_attribute(_cell(pg, "zh", "Clear"), "aria-label")
        == "Chinese, Clear: not available"
    )
    # The rest of what a flavor says, folded under All languages.
    fold = GRID + " .vg-all"
    assert pg.text_content(fold + " .share-row-title").startswith("All languages (")
    assert pg.get_attribute(fold, "aria-expanded") == "false"
    assert "nl" not in cells
    pg.click(fold)
    assert pg.evaluate(GRID_CELLS)["nl"] == ["get", "none"]
    pg.click(fold)
    # Fewer Zimi languages, fewer rows.
    pg.evaluate("() => _setPrefLanguages(['en', 'fr'])")
    pg.evaluate("() => _paintVoices()")
    assert list(pg.evaluate(GRID_CELLS)) == ["en", "fr"]
    pg.evaluate("() => _setPrefLanguages([])")
    _settings_voices(pg, served)
    pg.eval_on_selector(GRID, "e => e.scrollIntoView({ block: 'start' })")
    assert pg.evaluate("() => document.documentElement.scrollWidth") <= 390
    _shots(pg, "voices-grid-clear-here")
    # Never (ZIMI_OFFLINE is Never too): nothing to download.
    voices.POLICY.set("never")
    _settings_voices(pg, served)
    assert not pg.query_selector(GRID + " .vg-get")
    assert pg.evaluate(GRID_CELLS)["es"] == ["none", "none"]
    assert not errors, errors


def test_a_cell_downloads_in_place_with_progress_and_cancel(
    piper_here, monkeypatch, served
):
    """A download cell downloads that voice where it is: a thin bar under
    its row and Cancel; done, the cell is green."""
    open_eau, errors = piper_here
    steps = {"go": True}
    _slow_fetch(monkeypatch, steps)
    pg = open_eau().page
    _settings_voices(pg, served)
    get = _cell(pg, "es", "Clear")
    pg.click(get)
    bar = GRID + " .vg-dl .voice-progress"
    pg.wait_for_selector(bar, timeout=5000)
    first = pg.text_content(bar)
    pg.wait_for_function(
        "([s, t]) => document.querySelector(s).textContent !== t",
        arg=[bar, first],
        timeout=5000,
    )
    assert pg.evaluate(GRID_CELLS)["es"][0] == "busy"
    assert pg.evaluate("() => document.documentElement.scrollWidth") <= 390
    pg.eval_on_selector(GRID + " .vg-dl", "e => e.scrollIntoView({ block: 'center' })")
    _shots(pg, "voices-grid-downloading")
    pg.click(GRID + " .vg-dl button:has-text('Cancel')")
    pg.wait_for_function("s => !document.querySelector(s)", arg=bar, timeout=5000)
    assert voices.downloading() == {} and "es-ES" not in voices.installed()
    steps["go"] = False
    pg.click(_cell(pg, "es", "Clear"))
    _until(lambda: "es-ES" in voices.installed(), "the voice never came")
    pg.wait_for_function(
        "() => (window.__vg = [...document.querySelectorAll(\"#ms-voices-wrap .vg-row[data-lang='es'] .vg-cell > *\")].map(c => c.dataset.s))[0] === 'rm'",
        timeout=5000,
    )
    assert not errors, errors


def test_x_then_remove_removes_a_clear_voice(piper_here, served):
    """A downloaded Clear voice's dot shows ✕ (a pointer's hover; a touch's
    first tap); ✕ asks once, then the voice goes."""
    open_eau, errors = piper_here
    tv.install("fr")
    pg = open_eau().page
    _settings_voices(pg, served)
    rm = _cell(pg, "fr", "Clear")
    x = rm + " .vg-x"
    assert pg.is_hidden(x)
    pg.click(rm)
    assert pg.is_visible(x), "a touch's first tap shows ✕"
    assert "fr" in voices.installed()
    pg.click(rm)
    pg.wait_for_selector(".pw-box[role='alertdialog'] h3", timeout=5000)
    assert pg.text_content(".pw-box[role='alertdialog'] h3") == "Remove the Clear voice for French?"
    pg.click("#ac-ok")
    _until(lambda: "fr" not in voices.installed(), "the voice was never removed")
    pg.wait_for_function(
        "() => document.querySelector(\"#ms-voices-wrap .vg-row[data-lang='fr'] .vg-cell > *\").dataset.s === 'get'",
        timeout=5000,
    )
    assert not errors, errors


def test_natural_is_one_download_for_its_languages(
    piper_here, monkeypatch, served, tmp_path
):
    """Natural (Kokoro) is one download for its languages: each of their
    cells offers it, with the Natural row's Get; one fills them all, and
    it is removed on its row or from any of its cells."""
    open_eau, errors = piper_here
    runner = tv.fake_piper(tmp_path)
    monkeypatch.setattr(voices, "kokoro_command", lambda: [runner, "kokoro"])
    steps = {"go": False}
    _slow_fetch(monkeypatch, steps)
    pg = open_eau().page
    _settings_voices(pg, served)
    natural = VOICES_WRAP + " .voice-engine[data-engine='kokoro']"
    mb = round(voices._bytes(voices.KOKORO_TAG) / 1e6)
    assert pg.text_content(natural + " .set-btn[data-primary]") == "Get (%d MB)" % mb
    assert not pg.query_selector(natural + " .switch"), "nothing to switch yet"
    assert pg.evaluate(GRID_HEADS)[0] == "Natural"
    _shots(pg, "voices-grid-nothing")
    cells = pg.evaluate(GRID_CELLS)
    for c in ("en", "es", "fr", "hi", "pt", "zh"):
        assert cells[c][0] == "get", (c, cells)
    assert cells["de"][0] == "none", cells
    pg.click(_cell(pg, "es", "Natural"))
    _until(lambda: voices.KOKORO_TAG in voices.installed(), "Natural never came")
    # Downloaded, each of its languages can take it away again, the question
    # naming them all (Eric, 2026-10-05: "allow also removing natural the
    # same way").
    pg.wait_for_function(
        "() => document.querySelector(\"#ms-voices-wrap .vg-row[data-lang='zh'] .vg-cell > *\").dataset.s === 'rm'",
        timeout=DL_WAIT_MS,
    )
    cells = pg.evaluate(GRID_CELLS)
    for c in ("en", "es", "fr", "hi", "pt", "zh"):
        assert cells[c][0] == "rm", (c, cells)
    tv.install("fr")
    _settings_voices(pg, served)
    pg.eval_on_selector(GRID, "e => e.scrollIntoView({ block: 'start' })")
    _shots(pg, "voices-grid-natural-and-clear")
    pg.eval_on_selector(natural, "e => e.scrollIntoView({ block: 'center' })")
    assert "7 languages" in pg.text_content(natural + " .voice-meta")
    rm = natural + " [data-confirm]"
    pg.click(rm)
    assert pg.text_content(rm) == "Remove?"
    pg.click(rm)
    _until(lambda: voices.KOKORO_TAG not in voices.installed(), "Natural stayed")
    assert not errors, errors


def test_a_reader_sees_the_voices_and_nothing_to_get_or_remove(
    piper_here, monkeypatch, served
):
    """Not an admin (Eric, 2026-10-03: "All users see all available only
    admins can add"): the grid's dots say what is here; no download, no ✕,
    no Natural Get or Remove, no downloads setting."""
    from zimi import users

    open_eau, errors = piper_here
    tv.install("fr")
    monkeypatch.setattr(users, "_request_is_admin", lambda h: False)
    pg = open_eau().page
    _settings_voices(pg, served)
    cells = pg.evaluate(GRID_CELLS)
    assert cells["fr"] == ["on", "on"] and cells["es"] == ["none", "none"], cells
    for sel in (
        GRID + " .vg-get",
        GRID + " .vg-rm",
        GRID + " button.set-btn",
        "#voices-mode",
        VOICES_WRAP + " [data-confirm]",
        VOICES_WRAP + " [data-primary]",
    ):
        assert not pg.query_selector(sel), sel
    pg.eval_on_selector(GRID, "e => e.scrollIntoView({ block: 'start' })")
    _shots(pg, "voices-grid-reader")
    assert not errors, errors


def test_a_count_of_languages_lists_them(piper_here, served):
    """ "When I hover over 118 languages why not show me what's in the
    list": an engine's count names its languages in its title, and a tap
    (a phone has no hover) shows them as a line under the row."""
    open_eau, errors = piper_here
    tv.install("fr")
    pg = open_eau().page
    _settings_voices(pg, served)
    count = VOICES_WRAP + " .voice-engine[data-engine='device'] .voice-count"
    assert pg.text_content(count) == "2 languages"
    assert pg.get_attribute(count, "title") == "English, Français"
    assert not pg.query_selector(VOICES_WRAP + " .voice-langs")
    pg.click(count)
    assert pg.get_attribute(count, "aria-expanded") == "true"
    line = VOICES_WRAP + " .voice-engine[data-engine='device'] .voice-langs"
    assert pg.text_content(line) == "English, Français"
    pg.click(count)
    assert not pg.query_selector(line)
    assert "built into the device" in pg.text_content(
        VOICES_WRAP + " .voice-engine[data-engine='device'] .voice-what"
    )
    assert not errors, errors


def test_system_and_device_are_one_on_the_servers_own_mac(
    piper_here, monkeypatch, served
):
    """Eric, 2026-10-05: "Wouldn't System on a Mac and Device be the same!?
    Why two?" On the server's own Mac (localhost, or the desktop app) the
    page's voices are System's: Device goes. System says what it is."""
    open_eau, errors = piper_here
    monkeypatch.setattr(voices, "_say_voices", lambda: {"en": {"US": "Samantha"}})
    pg = open_eau().page
    _settings_voices(pg, served)
    assert served.startswith("http://127.0.0.1")
    heads = pg.evaluate(GRID_HEADS)
    assert "System" in heads and "Device" not in heads, heads
    assert not pg.query_selector(VOICES_WRAP + " .voice-engine[data-engine='device']")
    assert "heard on every device" in pg.text_content(
        VOICES_WRAP + " .voice-engine[data-engine='say'] .voice-what"
    )
    # Elsewhere (another host), both, told apart.
    assert (
        pg.evaluate(
            "() => { const r = _LOCAL_HOST_RE; return r.test('knowledge.zosia.lan'); }"
        )
        is False
    )
    assert not errors, errors


def test_the_dictionarys_voices_opens_settings_voices(piper_here, served):
    """The Dictionary's doors to its voices (Say's Voices… and the front's
    speaker) lead to Settings > Voices; so does /?manage=preferences#voices."""
    open_eau, errors = piper_here
    tv.install("fr")
    f = open_eau()
    pg = f.page
    _tap(f, CARET_FR)
    f.click(".menu-item[data-sheet]")
    pg.wait_for_selector(GRID, timeout=20000)
    assert not pg.query_selector("#voices-sheet, .voices-panel")
    top = pg.eval_on_selector("#ms-voices", "e => e.getBoundingClientRect().top")
    assert -1 <= top < 844, top  # scrolled to: a fraction of a pixel either way
    f = open_eau()
    f.evaluate("() => window.__home()")
    f.wait_for_selector(".vdoor:not([hidden])", timeout=10000)
    f.click(".vdoor")
    pg.wait_for_selector(GRID, timeout=20000)
    pg.goto("about:blank")
    pg.goto(served + "/?manage=preferences#voices")
    pg.wait_for_selector(GRID, timeout=20000)
    pg.wait_for_function(
        "() => { const t = document.getElementById('ms-voices').getBoundingClientRect().top; return t >= 0 && t < 844; }",
        timeout=5000,
    )
    assert not errors, errors


def test_voices_are_rows_with_names_versions_and_hear(piper_here, monkeypatch, served):
    """Eric, 2026-10-03: "why do all have a nice name except Piper";
    "the playback is shit it takes a long time and has no indicator it's
    working and is one short word". Each engine here is a row with a
    friendly name, how many languages it says and its version, and a
    switch; an admin's downloads setting is one line under them. Hear asks the
    server for a sentence of the session's sample words in Zimi's
    language, shows it is working from the tap until the audio plays and
    playing until it ends; Piper with no English says French words."""
    open_eau, errors = piper_here
    tv.install("fr")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"fr": {"FR": "fr-fr"}})
    pg = open_eau().page
    _settings_voices(pg, served)
    rows = pg.evaluate(ENGINES)
    assert [r[0] for r in rows] == ["Clear", "Basic", "Device"], rows
    assert (
        rows[0][1].startswith("1 language · Piper") and voices.PIPER_REVISION in rows[0][1]
    ), rows
    assert rows[2][1] == "2 languages", rows
    assert not pg.query_selector(
        "#ms-voice-pref, #ms-voice-remember"
    ), "no preferred voice, no remember switch"
    assert pg.query_selector("#voices-mode"), "an admin's downloads setting"
    assert pg.evaluate("() => document.documentElement.scrollWidth") <= 390
    _shots(pg, "voices-rows")
    # Hear, held: the audio does not start until the test lets it.
    pg.evaluate(
        """() => { window.__played = []; window.__release = null;
      HTMLMediaElement.prototype.play = function() { var a = this; window.__played.push(a.src);
        return new Promise(r => { window.__release = () => { a.onplaying && a.onplaying(); r(); }; }); }; }"""
    )
    sample = "() => JSON.parse(sessionStorage.zimi_voice_sample || '{}')"
    pg.click(HEAR % "piper")
    pg.wait_for_selector(HEAR % "piper" + ".working")
    pg.wait_for_function("() => window.__release")
    heard = pg.evaluate("() => window.__played")[-1]
    assert (
        "/dictionary/speak?sample=1&text=" in heard
        and "&lang=fr&engine=piper" in heard
    ), heard
    words = pg.evaluate(sample)["fr"]
    assert words and all(w in urllib.parse.unquote(heard) for w in words), (
        words,
        heard,
    )
    _shot(pg, "voices-hear-working")
    pg.evaluate("() => window.__release()")
    pg.wait_for_selector(HEAR % "piper" + ".playing")
    _shot(pg, "voices-hear-playing")
    # A second tap stops it.
    pg.click(HEAR % "piper")
    assert pg.eval_on_selector(
        HEAR % "piper",
        "b => !b.classList.contains('playing') && !b.classList.contains('working')",
    )
    # Zimi's language: the sentence, the same words all session.
    pg.click(HEAR % "device")
    pg.wait_for_function("() => window.__said.length > 0")
    said = pg.evaluate("() => window.__said")[-1]
    en = pg.evaluate(sample)["en"]
    assert said[0].startswith("Some dictionary words are: ") and said[2] == "en", said
    assert all(w in said[0] for w in en), (en, said)
    pg.wait_for_function(
        "s => !document.querySelector(s).classList.contains('working')",
        arg=HEAR % "device",
    )
    pg.click(HEAR % "device")
    pg.wait_for_function("() => window.__said.length > 1")
    assert (
        pg.evaluate("() => window.__said")[-1][0] == said[0]
    ), "the same words all session"
    # The server's cap lets the sentence through, and only with sample=1.
    sentence = "Some dictionary words are: water, river, ocean, island, lighthouse."
    code = pg.evaluate(
        "u => fetch(u).then(r => r.status)",
        "/dictionary/speak?lang=fr&engine=espeak&text=" + urllib.parse.quote(sentence),
    )
    assert code == 400
    assert not errors, errors


def test_say_remembers_the_last_voice_used(piper_here, monkeypatch, served):
    """Eric, 2026-10-03: "Change this (Say's menu remembers your last pick)
    to remember last used. We could actually drop both preferred and
    remember toggle by just remembering". A voice picked in Say's menu is
    Say's from then on, always; an older {remember: false} is dropped."""
    open_eau, errors = piper_here
    tv.install("fr")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"fr": {"FR": "fr-fr"}})
    pg = open_eau().page
    pg.evaluate(
        "() => { localStorage.zimi_voice_prefs = JSON.stringify({ voice: 'piper', remember: false, off: [] }); }"
    )
    f = open_eau()
    assert f.evaluate(PREFS) == {"voice": "piper", "off": []}, "the old switch is gone"
    _tap(f, CARET_FR)
    f.click("[data-voices='fr'] + .menu .menu-item[data-engine='device']")
    assert f.evaluate(PREFS)["voice"] == "device"
    f.click(".hw h1")
    _tap(f, CARET_FR)
    assert [e for _n, d, e in f.evaluate(MENU_FR) if d] == ["device"]
    f.click(".hw h1")
    f.evaluate("() => { window.__said = []; }")
    _tap(f, SAY_FR)
    f.wait_for_function("() => window.__said.length > 0")
    assert f.evaluate("() => window.__said")[0][1] == "Thomas"
    # Again, and Say keeps the newer pick.
    _tap(f, CARET_FR)
    f.click("[data-voices='fr'] + .menu .menu-item[data-engine='espeak']")
    assert f.evaluate(PREFS)["voice"] == "espeak"
    # Carried by My data.
    assert '"voice":"espeak"' in f.page.evaluate(
        "() => _collectPreferences().zimi_voice_prefs"
    )
    assert not errors, errors


def test_an_engine_switched_off_is_never_asked_and_the_last_stays_on(
    piper_here, monkeypatch, served
):
    """Eric, 2026-10-03: "a voices with toggles maybe for the various ones".
    Piper off: Say's menu has no Piper and no word is asked of it, French's
    default (Piper's) falling to the next voice on, by name. The last voice
    on cannot be switched off."""
    open_eau, errors = piper_here
    tv.install("fr")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"fr": {"FR": "fr-fr"}})
    pg = open_eau().page
    pg.evaluate(
        "() => { localStorage.zimi_voice_prefs = JSON.stringify({ voice: 'piper' }); }"
    )
    _settings_voices(pg, served)
    _engine(pg, "Clear")
    assert pg.evaluate(PREFS) == {"voice": "", "off": ["piper"]}
    assert pg.eval_on_selector(
        HEAR % "piper", "b => b.disabled"
    ), "an engine off is not heard"
    _shots(pg, "voices-engine-off")
    f = open_eau()
    _tap(f, CARET_FR)
    assert [e for _n, _d, e in f.evaluate(MENU_FR)] == ["espeak", "device", None]
    f.click(".hw h1")
    f.evaluate("() => { window.__played = []; }")
    _tap(f, SAY_FR)
    f.wait_for_function("() => window.__played.length > 0", timeout=10000)
    f.wait_for_timeout(500)
    played = f.evaluate("() => window.__played")
    assert "&engine=espeak&" in played[0], played
    assert not [u for u in played if "engine=piper" in u or "engine=" not in u], played
    # Basic and Device off too: Clear, the last one on, stays on.
    _settings_voices(pg, served)
    _engine(pg, "Clear")
    _engine(pg, "Basic")
    _engine(pg, "Device")
    assert [[r[0], r[2], r[3]] for r in pg.evaluate(ENGINES)] == [
        ["Clear", True, True],
        ["Basic", False, False],
        ["Device", False, False],
    ]
    _engine(pg, "Clear", force=True)
    assert pg.evaluate(PREFS)["off"] == ["espeak", "device"]
    assert pg.eval_on_selector(VOICES_WRAP + " .voice-engine input", "i => i.checked")
    assert not errors, errors


def test_the_front_offers_more_words_even_when_the_day_brought_none(served):
    """Eric, 2026-10-04: "I still want more than one word on dictionary
    homepage". A day that answered with no other words (or failed) still
    gets a shelf, filled by chance."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        pg = ctx.new_page()
        pg.route("**/dictionary/today?*", lambda r: r.fulfill(status=200, content_type="application/json",
                                                              body='{"day": "x", "words": [], "more": []}'))
        try:
            pg.goto(served + "/#dictionary")
            f = _frame(pg)
            f.wait_for_selector(".more-words .cloud a[data-w]", timeout=20000)
            assert len(f.query_selector_all(".more-words .cloud a[data-w]")) >= 2
        finally:
            br.close()


def test_clear_is_offered_on_its_row_the_current_language_first(piper_here, monkeypatch, served):
    """Clear sits under Natural and offers the language Zimi is in, with a
    ▾ for the other checked ones and "All N languages" last (Eric,
    2026-10-06). Each engine says in one word how quick it is."""
    open_eau, errors = piper_here
    steps = {"go": False}
    _slow_fetch(monkeypatch, steps)
    pg = open_eau().page
    _settings_voices(pg, served)
    clear = VOICES_WRAP + " .voice-engine[data-engine='piper']"
    pg.wait_for_selector(clear)
    order = pg.eval_on_selector_all(VOICES_WRAP + " .voice-engine", "rs => rs.map(r => r.dataset.engine)")
    assert order.index("piper") == order.index("kokoro") + 1 if "kokoro" in order else order[0] == "piper", order
    assert pg.text_content(clear + " .voice-what") == "Slow"
    assert pg.text_content(clear + " .set-btn[data-primary]").startswith("Get (") and pg.text_content(clear + " .set-btn-sub") == "English"
    pg.eval_on_selector(VOICES_WRAP, "e => e.scrollIntoView({ block: 'start' })")
    _shots(pg, "voices-clear-get")
    pg.click(clear + " .voice-split-more")
    _shots(pg, "voices-clear-menu")
    rows = pg.eval_on_selector_all(clear + " .voice-pick-row", "bs => bs.map(b => b.textContent)")
    assert rows[-1].startswith("All ") and "languages" in rows[-1], rows
    pg.click(clear + " .set-btn[data-primary]")
    _until(lambda: voices.downloading().get("tag") == "en-US", "English never started")
    _until(lambda: "en-US" in voices.installed(), "English never came")
    time.sleep(1.5)
    assert [t for t in voices.installed() if voices.VOICES.get(t) and voices.VOICES[t].engine == voices.PIPER] == ["en-US"], "only English came"
    assert not errors, errors


def test_the_default_voice_shows_only_the_voices_on_here(piper_here, served):
    """One row of the voices on here plus Automatic; a pick is the default
    Zimi says things in (Eric, 2026-10-06)."""
    open_eau, errors = piper_here
    tv.install("fr")
    pg = open_eau().page
    _settings_voices(pg, served)
    seg = VOICES_WRAP + " .voice-default"
    pg.wait_for_selector(seg)
    pg.eval_on_selector(VOICES_WRAP, "e => e.scrollIntoView({ block: 'start' })")
    _shots(pg, "voices-default")
    names = pg.eval_on_selector_all(seg + " .app-theme-btn", "bs => bs.map(b => b.textContent)")
    assert names[0] == "Automatic" and "Clear" in names and "Natural" not in names, names
    pg.click(seg + " .app-theme-btn:has-text('Clear')")
    assert pg.evaluate("() => _voicePrefs().voice") == "piper"
    assert not errors, errors
