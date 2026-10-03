"""The Dictionary's Say, spoken by the server (zimi/voices.py).

Pinned here:
  - Piper first, then macOS ``say``, then espeak-ng; an accent asks first for
    an engine with that region's voice; no engine, no audio (404).
  - The text is a word or a short phrase, reaches the engine on stdin and
    never a shell or its arguments, and the child is always reaped.
  - Audio is cached per engine and voice, and the cache keeps under its cap,
    oldest first.
  - Voices for Dictionary is Ask first / Automatically / Never, like the
    other things Zimi fetches; Never and ZIMI_OFFLINE refuse a download and
    take the Dictionary's download line away.
  - Removing a Piper voice falls back to the next engine at once and clears
    that voice's audio.
  - /dictionary/speak answers a range, as Safari asks for one.

A fake Piper (a script that writes a known WAV) stands in for the real one;
no test here reaches the network.

Run: pytest tests/test_voices.py -v
"""

import io
import json
import os
import stat
import sys
import threading
import urllib.error
import urllib.request
import wave

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import zimi.server as server  # noqa: E402
from zimi import outbound, voices  # noqa: E402

RATE = 16000
FAKE_PIPER = """#!%s
import sys, wave
args = sys.argv[1:]
out = args[args.index("-f") + 1]
text = sys.stdin.read()
with open(out + ".said", "w") as f:
    f.write(text)
w = wave.open(out, "wb")
w.setnchannels(1); w.setsampwidth(2); w.setframerate(%d)
w.writeframes(b"\\x10\\x00" * (%d // 4))
w.close()
"""


def fake_piper(folder):
    """A ``piper`` that writes a quarter second of WAV at RATE, and leaves
    the text it was given beside it."""
    path = os.path.join(str(folder), "piper")
    with open(path, "w") as f:
        f.write(FAKE_PIPER % (sys.executable, RATE, RATE))
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    return path


def install(tag):
    """A pinned Piper voice on disk, as a download would leave it."""
    vid = voices.PIPER_VOICES[tag][0]
    os.makedirs(voices._piper_dir(), exist_ok=True)
    for suffix in (".onnx", ".onnx.json"):
        open(os.path.join(voices._piper_dir(), vid + suffix), "wb").close()
    data = voices.installed()
    data[tag] = {"id": vid, "revision": voices.PIPER_REVISION, "bytes": 1}
    voices._write_installed(data)


@pytest.fixture
def data(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"))
    for name in ("ZIMI_OFFLINE", voices.DOWNLOADS_ENV, voices.PIPER_CMD_ENV):
        monkeypatch.delenv(name, raising=False)
    voices._reset_for_tests()
    yield tmp_path
    voices._reset_for_tests()


@pytest.fixture
def piper(data, monkeypatch):
    """The fake Piper as Zimi's Piper; no ``say`` and no espeak-ng."""
    monkeypatch.setenv(voices.PIPER_CMD_ENV, fake_piper(data))
    monkeypatch.setattr(voices, "_say_voices", lambda: {})
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {})
    return data


def engines(monkeypatch, piper=None, say=None, espeak=None):
    monkeypatch.setattr(voices, "_piper_voices", lambda: piper or {})
    monkeypatch.setattr(voices, "_say_voices", lambda: say or {})
    monkeypatch.setattr(voices, "_espeak_voices", lambda: espeak or {})


# ── which engine ──────────────────────────────────────────────────────────


def test_piper_comes_first_then_say_then_espeak(monkeypatch):
    engines(
        monkeypatch,
        piper={"en": {"US": "en-US"}},
        say={"en": {"US": "Samantha"}, "fr": {"FR": "Thomas"}},
        espeak={"en": {"US": "en-us"}, "fr": {"FR": "fr-fr"}, "mt": {"": "mt"}},
    )
    assert voices.choose("en") == ("piper", "en-US")
    assert voices.choose("fr") == ("say", "Thomas")
    assert voices.choose("mt") == ("espeak", "mt")
    assert voices.choose("xx") is None


def test_an_accent_asks_first_for_its_own_region(monkeypatch):
    engines(
        monkeypatch,
        piper={"en": {"US": "en-US"}},
        say={"en": {"GB": "Daniel", "US": "Samantha"}},
    )
    assert voices.choose("en", "GB") == (
        "say",
        "Daniel",
    ), "the region's voice, from a later engine"
    assert voices.choose("en", "US") == ("piper", "en-US")
    # No engine has the region: the language's first engine says it.
    assert voices.choose("en", "AU") == ("piper", "en-US")


def test_a_language_without_an_accent_is_said_in_its_home_region(monkeypatch):
    engines(
        monkeypatch,
        say={
            "en": {"GB": "Daniel", "US": "Samantha"},
            "pt": {"PT": "Joana", "BR": "Luciana"},
        },
    )
    assert voices.choose("en") == ("say", "Samantha")
    assert voices.choose("pt") == ("say", "Luciana")


def test_the_page_names_one_language_by_one_code(monkeypatch):
    engines(monkeypatch, espeak={"nb": {"": "nb"}, "zh": {"CN": "cmn", "HK": "yue"}})
    assert voices.choose("no") == ("espeak", "nb")
    assert voices.choose("zh-CN") == ("espeak", "cmn")
    assert voices.choose("zh-HK") == ("espeak", "yue")


def test_what_the_server_can_say(monkeypatch):
    engines(
        monkeypatch,
        piper={"en": {"US": "en-US"}},
        say={"en": {"GB": "Daniel"}, "fr": {"FR": "Thomas"}},
    )
    assert voices.can_say() == {
        "en": {"engine": "piper", "regions": ["GB", "US"]},
        "fr": {"engine": "say", "regions": ["FR"]},
    }


def test_installed_voices_need_piper_to_count(data, monkeypatch):
    install("fr")
    monkeypatch.setenv(voices.PIPER_CMD_ENV, "/nowhere/piper")
    assert voices._piper_voices() == {}
    voices._reset_for_tests()
    monkeypatch.setenv(voices.PIPER_CMD_ENV, fake_piper(data))
    assert voices._piper_voices() == {"fr": {"FR": "fr"}}


# ── the text ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text, ok",
    [
        ("water", "water"),
        ("  ice   cream ", "ice cream"),
        ("x" * voices.TEXT_MAX, "x" * voices.TEXT_MAX),
        ("x" * (voices.TEXT_MAX + 1), None),
        ("", None),
        ("   ", None),
        ("bell\x07", None),
        ("a\x00b", None),
    ],
)
def test_text_is_a_word_or_a_short_phrase(text, ok):
    assert voices.clean_text(text) == ok


@pytest.mark.parametrize(
    "lang, accent, ok",
    [
        ("en", "", True),
        ("en-US", "GB", True),
        ("zh-HK", "", True),
        ("gem-pro", "", True),
        ("en;rm -rf", "", False),
        ("", "", False),
        ("en", "G B", False),
        ("e", "", False),
    ],
)
def test_the_language_and_accent_are_codes(lang, accent, ok):
    assert voices.valid_lang(lang, accent) is ok


def test_the_text_reaches_the_engine_on_stdin_never_a_shell(piper, monkeypatch):
    install("en-US")
    seen = []
    real = voices.subproc.popen

    def spy(cmd, **kw):
        seen.append((list(cmd), kw))
        return real(cmd, **kw)

    monkeypatch.setattr(voices.subproc, "popen", spy)
    word = "$(touch pwned); `id` | water"
    body = voices.speak(word, "en")
    assert body and body[:4] == b"RIFF"
    ((cmd, kw),) = seen
    assert not kw.get("shell"), "never through a shell"
    assert all(word not in a for a in cmd), "never in the arguments"
    assert kw.get("stdin") is not None
    folder = voices._cache_dir("piper", "en_US-ljspeech-medium")
    (said,) = [f for f in os.listdir(folder) if f.endswith(".said")]
    with open(os.path.join(folder, said)) as f:
        assert f.read() == word, "the engine read the word, as it is, from stdin"
    assert not os.path.exists(os.path.join(os.getcwd(), "pwned"))


def test_an_engine_that_hangs_is_stopped_and_reaped(piper, monkeypatch):
    install("en-US")
    hang = os.path.join(str(piper), "hang")
    with open(hang, "w") as f:
        f.write("#!/bin/sh\nsleep 30\n")
    os.chmod(hang, 0o755)
    monkeypatch.setattr(voices, "piper_command", lambda: [hang])
    stopped = []
    real_stop = voices.subproc.stop
    monkeypatch.setattr(
        voices.subproc,
        "stop",
        lambda p, **kw: stopped.append(p) or real_stop(p, grace=1),
    )
    assert (
        voices._run(
            voices._command("piper", "en-US", str(piper / "x.wav")),
            "water",
            str(piper / "x.wav"),
            timeout=1,
        )
        is False
    )
    assert stopped and stopped[0].returncode is not None, "reaped"


# ── the cache ─────────────────────────────────────────────────────────────


def test_a_word_said_twice_is_made_once(piper, monkeypatch):
    install("en-US")
    runs = []
    real = voices._run
    monkeypatch.setattr(voices, "_run", lambda *a, **k: runs.append(a) or real(*a, **k))
    first = voices.speak("water", "en")
    again = voices.speak("water", "en")
    assert first == again and len(runs) == 1
    w = wave.open(io.BytesIO(first))
    assert w.getframerate() == RATE and w.getnframes() == RATE // 4


def test_the_cache_keeps_under_its_cap_oldest_first(data):
    folder = voices._cache_dir("say", "Samantha")
    os.makedirs(folder)
    for i in range(5):
        p = os.path.join(folder, "%d.wav" % i)
        with open(p, "wb") as f:
            f.write(b"x" * 1000)
        os.utime(p, (1000 + i, 1000 + i))
    voices._trim_cache(limit=2500)
    assert sorted(os.listdir(folder)) == ["3.wav", "4.wav"]


# ── no engine ─────────────────────────────────────────────────────────────


def test_no_engine_no_audio(data, monkeypatch):
    engines(monkeypatch)
    assert voices.speak("water", "en") is None


# ── the setting and downloads ─────────────────────────────────────────────


def test_voices_are_ask_first_by_default_and_listed(data):
    assert voices.POLICY.mode() == ("ask", None)
    row = {r["id"]: r for r in outbound.inventory()["rows"]}["voices"]
    assert row["state"] == "ask" and row["hosts"] == ["huggingface.co"]
    assert outbound.SOURCES["voices"] == ("voices",)


def test_never_and_offline_refuse_a_download(piper, monkeypatch):
    fetched = []
    monkeypatch.setattr(voices, "_fetch_voice", lambda tag: fetched.append(tag))
    voices.POLICY.set("never")
    assert voices.start_download("fr") == (False, "never")
    voices.POLICY.set("ask")
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    assert voices.POLICY.mode() == ("never", "offline")
    assert voices.start_download("fr") == (False, "never")
    assert {r["id"]: r for r in outbound.inventory()["rows"]}["voices"][
        "state"
    ] == "off"
    assert fetched == []


def test_the_env_var_wins(piper, monkeypatch):
    monkeypatch.setenv(voices.DOWNLOADS_ENV, "never")
    assert voices.POLICY.mode() == ("never", "env")
    assert voices.POLICY.set("auto") == (None, "env")


def test_ask_first_downloads_only_when_asked(piper, monkeypatch):
    fetched = []
    monkeypatch.setattr(
        voices.threading,
        "Thread",
        lambda target, args, **k: type(
            "T", (), {"start": lambda s: fetched.append(args[0])}
        )(),
    )
    voices.speak("eau", "fr")
    assert fetched == [], "saying a word fetches nothing under Ask first"
    assert voices.start_download("fr") == (True, None)
    assert fetched == ["fr"]
    voices._reset_for_tests()
    assert voices.start_download("xx") == (False, "unknown")


def test_automatically_fetches_a_languages_voice_when_a_word_is_said(
    piper, monkeypatch
):
    fetched = []
    monkeypatch.setattr(
        voices.threading,
        "Thread",
        lambda target, args, **k: type(
            "T", (), {"start": lambda s: fetched.append(args[0])}
        )(),
    )
    voices.POLICY.set("auto")
    voices.speak("water", "en", "GB")
    assert fetched == ["en-GB"]


def test_a_download_lands_only_at_the_pinned_size(piper, monkeypatch):
    monkeypatch.setitem(
        voices.PIPER_VOICES, "fr", ("fr_FR-siwis-medium", 10, 4, "CC BY 4.0")
    )
    bodies = {".onnx": b"0123456789", ".onnx.json": b"{}{}"}

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_open(req, timeout):
        suffix = ".onnx.json" if req.full_url.endswith(".json") else ".onnx"
        assert req.full_url.startswith(
            voices.PIPER_BASE_URL + voices.PIPER_REVISION + "/fr/fr_FR/siwis/medium/"
        )
        return Resp(bodies[suffix])

    monkeypatch.setattr(voices.urllib.request, "urlopen", fake_open)
    voices._download.update({"tag": "fr", "done": 0, "total": 14})
    voices._fetch_voice("fr")
    assert voices.installed()["fr"]["id"] == "fr_FR-siwis-medium"
    assert voices.downloading() == {}
    # Wrong size: nothing installed, nothing left behind.
    voices.remove("fr")
    bodies[".onnx"] = b"short"
    voices._download.update({"tag": "fr", "done": 0, "total": 14})
    voices._fetch_voice("fr")
    assert "fr" not in voices.installed()
    assert voices.downloading() == {"tag": None, "error": "fr"}
    assert not [f for f in os.listdir(voices._piper_dir()) if f.endswith(".part")]


def test_removing_a_voice_falls_back_and_clears_its_audio(piper, monkeypatch):
    install("en-US")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"en": {"US": "en-us"}})
    assert voices.speak("water", "en")
    cache = voices._cache_dir("piper", "en_US-ljspeech-medium")
    assert os.listdir(cache)
    assert voices.choose("en") == ("piper", "en-US")
    assert voices.remove("en-US") is True
    assert not os.path.exists(cache), "its audio went with it"
    assert voices.choose("en") == ("espeak", "en-us"), "the next engine, at once"
    assert not os.path.exists(
        os.path.join(voices._piper_dir(), "en_US-ljspeech-medium.onnx")
    )
    assert voices.remove("en-US") is False


def test_a_newer_pin_is_shown_never_fetched(piper, monkeypatch):
    install("fr")
    monkeypatch.setitem(voices.PIPER_VOICES, "fr", ("fr_FR-tom-medium", 1, 1, "CC0"))
    row = {r["tag"]: r for r in voices.manage_payload()["voices"]}["fr"]
    assert row["installed"] and row["newer"]
    assert voices.choose("fr") == ("piper", "fr"), "the voice on disk still speaks"


def test_the_dictionary_line_follows_the_setting(piper, monkeypatch):
    """The page offers a clearer voice only where it could be fetched: Never
    and ZIMI_OFFLINE take every offer away, and so does a missing Piper."""
    assert "fr" in voices.page_payload()["offers"]
    install("fr")
    assert "fr" not in voices.page_payload()["offers"], "not for a voice already here"
    voices.POLICY.set("never")
    assert voices.page_payload()["offers"] == {}
    voices.POLICY.set("auto")
    assert voices.page_payload()["offers"]
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    assert voices.page_payload()["offers"] == {}
    monkeypatch.delenv("ZIMI_OFFLINE")
    voices._reset_for_tests()
    monkeypatch.setenv(voices.PIPER_CMD_ENV, "/nowhere/piper")
    assert voices.page_payload()["offers"] == {}


def test_pinned_voices_are_well_formed():
    for tag, (vid, onnx, cfg, lic) in voices.PIPER_VOICES.items():
        assert (
            voices._primary(tag) == voices._primary(vid.split("-")[0]) or tag == "nb"
        ), tag
        assert vid.endswith("-medium") and onnx > 1e6 and cfg > 0 and lic, tag
        assert voices._voice_url(vid, ".onnx").startswith(
            voices.PIPER_BASE_URL + voices.PIPER_REVISION + "/"
        )


# ── over HTTP ─────────────────────────────────────────────────────────────


@pytest.fixture
def served(piper, monkeypatch):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    monkeypatch.delenv("ZIMI_APPS", raising=False)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _get(url, headers=None):
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}))
        return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def test_speak_answers_a_wav_a_range_and_a_404(served):
    install("en-US")
    code, headers, body = _get(served + "/dictionary/speak?text=water&lang=en")
    assert (
        code == 200 and headers["Content-Type"] == "audio/wav" and body[:4] == b"RIFF"
    )
    assert headers["Accept-Ranges"] == "bytes"
    code, headers, part = _get(
        served + "/dictionary/speak?text=water&lang=en", {"Range": "bytes=0-1"}
    )
    assert (
        code == 206
        and part == b"RI"
        and headers["Content-Range"] == "bytes 0-1/%d" % len(body)
    )
    assert _get(served + "/dictionary/speak?text=eau&lang=fr")[0] == 404
    assert _get(served + "/dictionary/speak?text=&lang=en")[0] == 400
    assert _get(served + "/dictionary/speak?text=" + "x" * 200 + "&lang=en")[0] == 400
    code, _h, body = _get(served + "/dictionary/voices")
    got = json.loads(body)
    assert (
        got["langs"]["en"]["engine"] == "piper"
        and got["mode"] == "ask"
        and "fr" in got["offers"]
    )
