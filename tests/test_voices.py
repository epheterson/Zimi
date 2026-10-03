"""The Dictionary's Say, spoken by the server (zimi/voices.py).

Pinned here:
  - Kokoro first, then Piper, then macOS ``say``, then espeak-ng, unless
    Manage chose another for the language; an accent asks first for an
    engine with that region's voice; no engine, no audio (404); a word asked
    of one engine is said by it or not at all.
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
  - Every pinned voice carries its licence and credit; non-commercial and
    unstated licences stay out; Chinese is Kokoro, then ``say``, then
    espeak-ng; removing Kokoro clears its model and audio; the desktop
    helper is found beside a frozen Zimi; Zimi never imports an engine.

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
    """A pinned voice on disk, as a download would leave it."""
    pin = voices.VOICES[tag]
    folder = voices._engine_dir(pin.engine)
    os.makedirs(folder, exist_ok=True)
    names = [name for name, _url, _size in pin.files]
    for name in names:
        open(os.path.join(folder, name), "wb").close()
    voices._set_installed(
        pin.engine,
        tag,
        {
            "id": pin.id,
            "revision": pin.revision,
            "bytes": 1,
            "files": names,
            "voice": pin.voice,
        },
    )


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
    monkeypatch.setattr(voices, "kokoro_command", lambda: None)
    monkeypatch.setattr(voices, "_say_voices", lambda: {})
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {})
    return data


def engines(monkeypatch, piper=None, say=None, espeak=None, kokoro=None):
    monkeypatch.setattr(voices, "_choices", {})  # none made, none read from disk
    monkeypatch.setattr(voices, "_piper_voices", lambda: piper or {})
    monkeypatch.setattr(voices, "_kokoro_voices", lambda: kokoro or {})
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
        "en": {"engine": "piper", "engines": ["piper", "say"], "regions": ["GB", "US"]},
        "fr": {"engine": "say", "engines": ["say"], "regions": ["FR"]},
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
    assert row["state"] == "ask" and row["hosts"] == ["huggingface.co", "github.com"]
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
    assert voices.start_download(["fr"]) == (False, "unknown")
    assert voices.remove({"fr": 1}) is False


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
    voices.speak("Wasser", "de")
    assert fetched == ["de"]
    # Kokoro's languages fetch the one Kokoro download, where it can run.
    voices.speak("water", "en", "GB")
    assert fetched == ["de"], "no Kokoro runner here"
    monkeypatch.setattr(voices, "kokoro_command", lambda: ["kokoro-runner"])
    voices._download.clear()  # the stand-in thread never finished German
    voices.speak("water", "en", "GB")
    assert fetched == ["de", "kokoro"]


def test_a_download_lands_only_at_the_pinned_size(piper, monkeypatch):
    monkeypatch.setitem(
        voices.VOICES,
        "fr",
        voices._piper("fr_FR-siwis-medium", 10, 4, "CC BY 4.0", "SIWIS"),
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


def test_a_cancelled_download_leaves_nothing_and_no_error(piper, monkeypatch):
    """Cancel stops the fetch at its next chunk: no voice, no partial file,
    no failure to report, and the language can be fetched again."""
    monkeypatch.setitem(
        voices.VOICES,
        "fr",
        voices._piper("fr_FR-siwis-medium", 10, 4, "CC BY 4.0", "SIWIS"),
    )
    assert voices.cancel_download() is False, "nothing to cancel"

    class Resp:
        """Hands out one byte at a time; cancelled after the first."""

        def __init__(self):
            self.n = 0

        def read(self, _k):
            self.n += 1
            if self.n == 2:
                assert voices.cancel_download() is True
                assert voices.downloading() == {}, "cancelled is already gone"
            return b"0"

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(voices.urllib.request, "urlopen", lambda req, timeout: Resp())
    voices._download.update({"tag": "fr", "done": 0, "total": 14})
    voices._fetch_voice("fr")
    assert "fr" not in voices.installed()
    assert voices.downloading() == {}
    assert voices._download == {}, "free for the next download"
    assert not [f for f in os.listdir(voices._piper_dir()) if f.endswith(".part")]


def test_download_right_after_cancel_waits_for_the_old_one(piper, monkeypatch):
    """The cancelled fetch notices at its next chunk; a Download tapped in
    between waits for it instead of being refused as busy."""
    import time

    def fetch(tag):
        while True:
            time.sleep(0.05)
            with voices._lock:
                if voices._download.get("cancel"):
                    voices._download.clear()
                    return

    monkeypatch.setattr(voices, "_fetch_voice", fetch)
    assert voices.start_download("fr") == (True, None)
    assert voices.cancel_download()
    assert voices.start_download("fr") == (True, None)
    assert voices.downloading()["tag"] == "fr"
    assert voices.cancel_download()
    voices._fetcher.join(5)


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
    monkeypatch.setitem(
        voices.VOICES, "fr", voices._piper("fr_FR-tom-medium", 1, 1, "CC0", "Tom")
    )
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
    for tag, pin in voices.VOICES.items():
        assert pin.engine in voices.DOWNLOADED, tag
        assert pin.files and all(
            url.startswith("https://") and url.endswith(name) is not None and size > 0
            for name, url, size in pin.files
        ), tag
        if pin.engine == voices.PIPER:
            assert (
                voices._primary(tag) == voices._primary(pin.id.split("-")[0])
                or tag == "nb"
            ), tag
            assert pin.id.endswith("-medium") and pin.voice is None, tag
            onnx = [s for n, _u, s in pin.files if n.endswith(".onnx")]
            assert onnx and onnx[0] > 1e6, tag
            assert pin.files[1][1].startswith(
                voices.PIPER_BASE_URL + pin.revision + "/"
            ), tag
            assert pin.files[1][1] == voices._voice_url(pin.id, ".onnx", pin.revision)


# ── licences ──────────────────────────────────────────────────────────────


def test_every_voice_carries_its_licence_and_credit(piper):
    """Eric: "Can we sort the licensing to cover all platforms and languages
    in some way??" Every pinned voice says its licence and whom to credit,
    and Manage shows the credit where the licence asks for it."""
    for tag, pin in voices.VOICES.items():
        assert pin.license and pin.credit, tag
        assert "NC" not in pin.license and "unknown" not in pin.license.lower(), tag
    rows = {r["tag"]: r for r in voices.manage_payload()["voices"]}
    assert set(rows) == set(voices.VOICES)
    for tag, row in rows.items():
        assert row["license"] == voices.VOICES[tag].license
        assert row["credit"] == voices.VOICES[tag].credit
        assert row["credit_required"] == voices.needs_credit(row["license"])
    # The two voices Eric added, and Kokoro.
    assert voices.VOICES["it"].id == "it_IT-paola-medium"
    assert voices.VOICES["it"].license == "CC0" and not rows["it"]["credit_required"]
    assert voices.VOICES["hi"].id == "hi_IN-rohan-medium"
    assert rows["hi"]["credit_required"] and "IIT Madras" in rows["hi"]["credit"]
    kokoro = voices.VOICES[voices.KOKORO_TAG]
    assert kokoro.engine == voices.KOKORO and "hexgrad" in kokoro.credit
    assert kokoro.license == "Apache-2.0" and rows["kokoro"]["credit_required"]
    assert rows["fr"]["credit_required"] and rows["ca"]["credit_required"]
    assert not rows["de"]["credit_required"] and not rows["en-US"]["credit_required"]


def test_excluded_voices_stay_out():
    """Non-commercial and unstated licences never become a pin."""
    ids = {pin.id for pin in voices.VOICES.values()}
    for vid in (
        "hi_IN-pratham-medium",
        "hi_IN-priyamvada-medium",
        "zh_CN-huayan-medium",
    ):
        assert vid in voices.EXCLUDED and vid not in ids
    assert not any("huayan" in i or "pratham" in i or "priyamvada" in i for i in ids)
    assert "ar" not in voices.VOICES, "Arabic keeps the basic voice"


def test_zimi_never_imports_a_speech_engine():
    """The GPL engines (and Kokoro, whose phonemizer loads espeak-ng) run as
    a separate program; voicehelper.py imports nothing of Zimi, so starting
    it never loads the server, and Zimi never imports it."""
    import ast

    engines = {"piper", "kokoro_onnx", "misaki", "espeakng_loader", "phonemizer"}

    def imported(path):
        tree = ast.parse(open(path, encoding="utf-8").read())
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names |= {a.name.split(".")[0] for a in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module:
                names.add(node.module.split(".")[0])
        return names

    zimi_dir = os.path.join(REPO, "zimi")
    for name in os.listdir(zimi_dir):
        if name.endswith(".py") and name != voices.HELPER_SCRIPT:
            got = imported(os.path.join(zimi_dir, name))
            assert not got & engines, name
            assert "voicehelper" not in got, name
    assert "zimi" not in imported(os.path.join(zimi_dir, voices.HELPER_SCRIPT))


# ── Kokoro: one download, eight languages ─────────────────────────────────


def test_chinese_is_kokoro_then_say_then_espeak(monkeypatch):
    kokoro = {"zh": {"CN": "zh"}}
    say = {"zh": {"CN": "Tingting"}}
    espeak = {"zh": {"CN": "cmn"}}
    engines(monkeypatch, kokoro=kokoro, say=say, espeak=espeak)
    assert voices.choose("zh") == ("kokoro", "zh")
    assert voices.choose("zh-CN") == ("kokoro", "zh")
    engines(monkeypatch, say=say, espeak=espeak)
    assert voices.choose("zh") == ("say", "Tingting")
    engines(monkeypatch, espeak=espeak)
    assert voices.choose("zh") == ("espeak", "cmn")


def test_kokoro_speaks_through_its_runner_and_remove_clears_it(piper, monkeypatch):
    runner = fake_piper(piper)  # writes a WAV at -f, whatever else it is given
    monkeypatch.setattr(voices, "kokoro_command", lambda: [runner, "kokoro"])
    seen = []
    real = voices._run
    monkeypatch.setattr(
        voices,
        "_run",
        lambda cmd, text, out, **k: seen.append(cmd) or real(cmd, text, out, **k),
    )
    assert voices.choose("zh") is None
    install("kokoro")
    assert voices.choose("zh") == ("kokoro", "zh")
    said = {}
    for text, lang, speaker, code in (
        ("水", "zh", "zf_xiaobei", "zh"),
        ("water", "en", "af_heart", "en-us"),
        ("eau", "fr", "ff_siwis", "fr-fr"),
        ("água", "pt", "pf_dora", "pt-br"),
    ):
        body = voices.speak(text, lang)
        assert body and body[:4] == b"RIFF", lang
        cmd = seen[-1]
        assert cmd[:2] == [runner, "kokoro"]
        assert cmd[cmd.index("--voice") + 1] == speaker, lang
        assert cmd[cmd.index("--lang") + 1] == code, "espeak-ng's code, or misaki's"
        assert cmd[cmd.index("--model") + 1].endswith(voices.KOKORO_MODEL)
        assert text not in cmd, "the text goes on stdin"
        said[lang] = voices._cache_dir("kokoro", "kokoro-v1.0.int8-" + speaker)
        assert os.listdir(said[lang]), "cached per speaker"
    voices.speak("water", "en", "GB")
    assert seen[-1][seen[-1].index("--voice") + 1] == "bf_emma", "the UK accent"
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"zh": {"CN": "cmn"}})
    assert voices.remove("kokoro") is True
    assert not any(os.path.exists(c) for c in said.values()), "its audio went with it"
    folder = voices._engine_dir(voices.KOKORO)
    assert not os.path.exists(os.path.join(folder, voices.KOKORO_MODEL))
    assert not os.path.exists(os.path.join(folder, voices.KOKORO_VOICES))
    assert voices.choose("zh") == ("espeak", "cmn")
    assert voices.remove("kokoro") is False


def test_kokoro_is_offered_only_where_it_can_run(piper, monkeypatch):
    assert "zh" not in voices.page_payload()["offers"]
    assert voices.start_download("kokoro") == (False, "noengine")
    row = {r["tag"]: r for r in voices.manage_payload()["voices"]}["kokoro"]
    assert row["kind"] == "kokoro" and not row["runnable"]
    # Where Kokoro cannot run, Piper's voice is the offer for English.
    assert voices.page_payload()["offers"]["en"]["tag"] == "en-US"
    monkeypatch.setattr(voices, "kokoro_command", lambda: ["kokoro-runner"])
    offer = voices.page_payload()["offers"]["zh"]
    assert offer == {"tag": "kokoro", "bytes": 92361271 + 28214398}


def test_kokoro_comes_before_an_installed_piper_voice(piper, monkeypatch):
    """Kokoro beats Piper for its languages; Piper's English on disk still
    speaks while Kokoro is not here (Eric's ljspeech)."""
    runner = fake_piper(piper)
    install("en-US")
    assert voices.choose("en") == ("piper", "en-US"), "Piper, with no Kokoro"
    assert voices.speak("water", "en")
    monkeypatch.setattr(voices, "kokoro_command", lambda: [runner, "kokoro"])
    install("kokoro")
    assert voices.choose("en") == ("kokoro", "en-US")
    assert voices.choose("en", "GB") == ("kokoro", "en-GB")
    assert voices.choose("en", "US") == ("kokoro", "en-US")
    assert voices.choose("de") is None, "not one of Kokoro's"
    assert voices.can_say()["en"]["engines"] == ["kokoro", "piper"]


def test_kokoro_is_one_row_in_manage(piper, monkeypatch):
    monkeypatch.setattr(voices, "kokoro_command", lambda: ["kokoro-runner"])
    rows = voices.manage_payload()["voices"]
    kokoro = [r for r in rows if r["kind"] == "kokoro"]
    assert len(kokoro) == 1 and kokoro[0]["tag"] == "kokoro"
    assert kokoro[0]["langs"] == ["en-US", "en-GB", "es", "fr", "it", "pt-BR", "hi", "zh"]
    assert kokoro[0]["bytes"] == 92361271 + 28214398 and kokoro[0]["runnable"]
    assert kokoro[0]["license"] == "Apache-2.0" and kokoro[0]["credit_required"]
    # Piper's voices for the same languages stay on offer beside it.
    tags = {r["tag"] for r in rows}
    assert {"en-US", "en-GB", "es-ES", "fr", "it", "pt-BR", "hi"} <= tags
    assert "zh" not in tags and "en" not in tags


def test_the_dictionary_offers_the_one_kokoro_download(piper, monkeypatch):
    """Every Kokoro language's line offers the same single download, never a
    Piper voice; other languages keep Piper's."""
    monkeypatch.setattr(voices, "kokoro_command", lambda: ["kokoro-runner"])
    offers = voices.page_payload()["offers"]
    for lang in ("en", "es", "fr", "it", "pt", "hi", "zh"):
        assert offers[lang] == {"tag": "kokoro", "bytes": 92361271 + 28214398}, lang
    assert offers["de"]["tag"] == "de"
    # A language a downloaded voice already says is offered nothing more.
    install("en-US")
    assert "en" not in voices.page_payload()["offers"]
    install("kokoro")
    offers = voices.page_payload()["offers"]
    assert not {"en", "es", "fr", "zh"} & set(offers) and offers["de"]["tag"] == "de"


def test_kokoro_downloaded_or_removed_is_a_new_address(piper, monkeypatch):
    monkeypatch.setattr(voices, "kokoro_command", lambda: ["kokoro-runner"])
    before = voices.page_payload()["stamp"]
    install("kokoro")
    during = voices.page_payload()["stamp"]
    assert during != before and "kokoro" in during
    voices.remove("kokoro")
    assert voices.page_payload()["stamp"] == before


def test_kokoro_installed_for_chinese_alone_is_the_one_download(piper, monkeypatch):
    """Before Kokoro said eight languages its record was Chinese's: the same
    model on disk is the one download now, and Remove takes it all."""
    monkeypatch.setattr(voices, "kokoro_command", lambda: ["kokoro-runner"])
    install("kokoro")
    folder = voices._engine_dir(voices.KOKORO)
    rec = voices._read_manifest(voices.KOKORO)["kokoro"]
    with open(os.path.join(folder, voices.MANIFEST), "w") as f:
        json.dump({"zh": dict(rec, voice="zf_xiaoxiao")}, f)
    have = voices.installed()
    assert list(have) == ["kokoro"] and have["kokoro"]["voice"] is None
    row = {r["tag"]: r for r in voices.manage_payload()["voices"]}["kokoro"]
    assert row["installed"] and not row["newer"]
    assert voices.choose("en") == ("kokoro", "en-US")
    assert voices.remove("kokoro") is True and voices.installed() == {}


# ── which voice says a language: chosen in Manage ─────────────────────────


@pytest.fixture
def three(piper, monkeypatch):
    """English said by Kokoro, Piper and espeak-ng, all here."""
    monkeypatch.setattr(voices, "kokoro_command", lambda: [fake_piper(piper), "kokoro"])
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"en": {"US": "en-us"}})
    install("kokoro")
    install("en-US")
    return piper


def test_with_no_choice_the_best_here_says_it(three):
    assert voices.choices() == {}
    assert voices.choose("en") == ("kokoro", "en-US")
    picks = {c["lang"]: c for c in voices.manage_payload()["langs"]}
    assert picks["en"] == {
        "lang": "en",
        "engines": ["kokoro", "piper", "espeak"],
        "engine": "kokoro",
        "chosen": None,
        "pinned": True,
        "piper": None,
        "remove": "en-US",
    }
    assert picks["zh"]["engines"] == ["kokoro"], "one engine: a select of one"


def test_a_choice_overrides_the_order_and_is_saved(three):
    assert voices.set_choice("en", "piper") is True
    assert voices.choose("en") == ("piper", "en-US")
    assert voices.can_say()["en"]["engine"] == "piper"
    voices._reset_for_tests()  # read back from the prefs file
    assert voices.choices() == {"en": "piper"}
    assert voices.choose("en") == ("piper", "en-US")
    assert voices.choose("en", "GB") == ("kokoro", "en-GB"), "the accent's own voice"
    assert voices.set_choice("en", "espeak") and voices.choose("en") == ("espeak", "en-us")
    # The best again, or none: no choice is kept.
    assert voices.set_choice("en", "kokoro") and voices.choices() == {}
    assert voices.set_choice("en", "say") is False, "no say here"
    assert voices.set_choice("de", "piper") is False
    assert voices.set_choice("../x", None) is False


def test_a_chosen_voice_removed_falls_back_to_the_best(three):
    voices.set_choice("en", "piper")
    voices.remove("en-US")
    assert voices.choose("en") == ("kokoro", "en-US")
    assert voices.can_say()["en"]["engine"] == "kokoro"
    picks = {c["lang"]: c for c in voices.manage_payload()["langs"]}
    assert picks["en"]["chosen"] is None and picks["en"]["engine"] == "kokoro"


def test_a_choice_is_a_new_address(three):
    before = voices.page_payload()["stamp"]
    voices.set_choice("en", "piper")
    after = voices.page_payload()["stamp"]
    assert after != before and "en=piper" in after
    voices.set_choice("en", None)
    assert voices.page_payload()["stamp"] == before


def test_a_word_asked_of_one_engine_is_said_by_it_or_not_at_all(three, monkeypatch):
    seen = []
    real = voices._run
    monkeypatch.setattr(
        voices,
        "_run",
        lambda cmd, text, out, **k: seen.append(cmd) or real(cmd, text, out, **k),
    )
    assert voices.speak("water", "en", engine="piper")
    assert "kokoro" not in seen[-1]
    assert voices.choose("en", engine="espeak") == ("espeak", "en-us")
    assert voices.speak("water", "en", engine="say") is None
    assert voices.speak("water", "en", engine="nonsense") is None
    assert voices.speak("water", "en")
    assert seen[-1][1] == "kokoro", "the default, as before"


def test_the_desktop_helper_is_found_beside_zimi(tmp_path, monkeypatch):
    """A frozen build runs Piper and Kokoro through zimi-voice beside its own
    executable; elsewhere voicehelper.py runs in Zimi's Python."""
    for name in ("Zimi", voices.HELPER_NAME):
        p = tmp_path / name
        p.write_text("")
        p.chmod(0o755)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "Zimi"))
    monkeypatch.delenv(voices.PIPER_CMD_ENV, raising=False)
    monkeypatch.setattr(voices.shutil, "which", lambda name: None)
    voices._reset_for_tests()
    helper = str(tmp_path / voices.HELPER_NAME)
    assert voices.helper_command() == [helper]
    assert voices.piper_command() == [helper, "piper"]
    assert voices.kokoro_command() == [helper, "kokoro"]
    os.remove(helper)
    voices._reset_for_tests()
    assert voices.piper_command() is None and voices.kokoro_command() is None
    monkeypatch.setattr(sys, "frozen", False)
    monkeypatch.setattr(voices, "_has_modules", lambda *names: True)
    voices._reset_for_tests()
    script = os.path.join(os.path.dirname(voices.__file__), voices.HELPER_SCRIPT)
    assert voices.kokoro_command() == [sys.executable, script, "kokoro"]
    voices._reset_for_tests()


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


def test_cancel_over_http_answers_the_list(served):
    """POST /manage/voices/cancel: the download in flight is gone from the
    answer at once, and with nothing in flight it is harmless."""

    def post():
        req = urllib.request.Request(
            served + "/manage/voices/cancel",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        r = urllib.request.urlopen(req)
        return r.status, json.loads(r.read())

    code, got = post()
    assert code == 200 and got["downloading"] == {} and got["voices"]
    voices._download.update({"tag": "fr", "done": 1, "total": 10})
    code, got = post()
    assert code == 200 and got["downloading"] == {}
    assert voices._download.get("cancel") is True
    voices._reset_for_tests()


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
        and got["langs"]["en"]["engines"] == ["piper"]
        and got["mode"] == "ask"
        and "fr" in got["offers"]
    )
    # One engine asked for: that one, or 404; a name that is no engine, 400.
    assert _get(served + "/dictionary/speak?text=water&lang=en&engine=piper")[0] == 200
    assert _get(served + "/dictionary/speak?text=water&lang=en&engine=espeak")[0] == 404
    assert _get(served + "/dictionary/speak?text=water&lang=en&engine=rm")[0] == 400


def test_a_choice_over_http(served, monkeypatch):
    install("en-US")
    monkeypatch.setattr(voices, "_espeak_voices", lambda: {"en": {"US": "en-us"}})

    def post(body):
        req = urllib.request.Request(
            served + "/manage/voices/choose",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            r = urllib.request.urlopen(req)
            return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, None

    code, got = post({"lang": "en", "engine": "espeak"})
    picks = {c["lang"]: c for c in got["langs"]}
    assert code == 200 and picks["en"]["engine"] == "espeak"
    assert post({"lang": "en", "engine": "say"})[0] == 409
    assert post({"lang": "en", "engine": None})[0] == 200 and voices.choices() == {}


def test_a_voice_downloaded_is_a_new_address_for_every_word(piper):
    """Eric, 2026-10-03: English downloaded "but it's still robotic": the
    phone kept the word's audio from the basic voice at the same address.
    The page puts the voices on disk in every word's address."""
    before = voices.page_payload()["stamp"]
    install("fr")
    after = voices.page_payload()["stamp"]
    assert before != after and "fr" in after
