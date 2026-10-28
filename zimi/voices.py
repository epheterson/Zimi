"""Say: a word spoken by the server, as audio the page plays.

Eric, 2026-10-03: "It's worth getting dictionary right if it's the new app."
A browser's speechSynthesis is not media on an iPhone, so the ring switch
mutes it, and every device has its own voices or none. A WAV played by an
<audio> element is media: it plays on silent and sounds the same everywhere.

Four engines, each a separate program run as a child (never imported, so
GPL code stays beside MIT Zimi the way ffmpeg does), in this order:

1. Kokoro (kokoro-onnx, with misaki's phonemes for English and Chinese): one
   download, the "Natural voices", says English (US and UK), Spanish,
   French, Italian, Brazilian Portuguese, Hindi and Chinese. Eric, after
   Piper's English: "It does sound robotic still and a lil off."
2. Piper (piper-tts), one download per language. For Kokoro's languages it
   is a choice beside Kokoro: "Options couldn't hurt once it's built."
3. macOS ``say``, on a Mac.
4. espeak-ng, when installed. Robotic, and there with no download at all.

Piper and Kokoro run through voicehelper.py: ``python voicehelper.py`` where
they are installed in Zimi's Python (Docker, ``pip install zimi[voices]``),
the ``zimi-voice`` executable the desktop apps carry beside Zimi, or, on a
pip or uv install without them, a venv of their own under
``<data>/tools/voices`` that the first voice download sets up (the way
warc2zim and ArcticZim are installed). Each runs as a warm worker
(``serve``) that loads its model once and stops when idle; the Dictionary
asks it to load as the page opens (``warm``).

An accent asks first for an engine with that region's voice, then for any
voice of the language. None that can say it: no audio, and the page uses the
device's own voice.

Piper voices (about 60 MB each, one language) and the Kokoro model (about
120 MB, all its languages) are a download, chosen by someone in the
Dictionary or in Manage, under "Voices for Dictionary": Ask first, Automatically (a voice is
fetched when a word in its language is said), Never. ZIMI_OFFLINE forbids
it. Every voice is pinned per Zimi release in ``VOICES``, with its licence
and credit; nothing updates on its own.
"""

import atexit
import collections
import hashlib
import importlib.util
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

from zimi import outbound, subproc

log = logging.getLogger("zimi")

PIPER, KOKORO, SAY, ESPEAK = "piper", "kokoro", "say", "espeak"
ENGINES = (KOKORO, PIPER, SAY, ESPEAK)  # the order a language asks them in
DOWNLOADED = (PIPER, KOKORO)  # the engines whose voices are a download

# Every voice Zimi can fetch, pinned per release: one per language (accents
# where Piper has them), each under a licence that lets anyone download and
# use it, with the credit that licence asks for. A newer pin is a one-line
# change here; Manage then offers "Newer voice", and nothing downloads on its
# own. ``files`` is ((name, url, bytes), ...), sizes measured at the pin: a
# download that is not exactly that size is not installed.
Pin = collections.namedtuple("Pin", "engine id voice revision files license credit")

PIPER_REVISION = "v1.0.0"
PIPER_BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/"
# rohan came to rhasspy/piper-voices after v1.0.0: pinned to that commit.
PIPER_ROHAN_REVISION = "c10ece1aade47bb51c153c893d14e5bf8e5b7117"
NABU = "Nabu Casa voice datasets"
SPRAKBANKEN = "Språkbanken, National Library of Norway"

# Kokoro-82M (hexgrad, weights Apache-2.0) as kokoro-onnx publishes it: the
# int8 model and every voice in one file, one download whatever the voice.
KOKORO_REVISION = "model-files-v1.0"
KOKORO_BASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/"
KOKORO_ID = "kokoro-v1.0.int8"
KOKORO_MODEL, KOKORO_VOICES = "kokoro-v1.0.int8.onnx", "voices-v1.0.bin"
KOKORO_SIZES = {KOKORO_MODEL: 92361271, KOKORO_VOICES: 28214398}
KOKORO_TAG = "kokoro"  # the one download, in Manage and the Dictionary alike
# Kokoro's languages: the speaker for each, the best graded in hexgrad's
# VOICES.md for v1.0, and how its words become phonemes (misaki for English
# and Chinese in voicehelper.py, espeak-ng's code for the rest). Japanese
# would need misaki's MeCab dictionary, a download of its own: not yet.
KOKORO_LANGS = {
    "en-US": ("af_heart", "en-us"),  # A
    "en-GB": ("bf_emma", "en-gb"),  # B-
    "es": ("ef_dora", "es"),  # ungraded; the only Spanish woman
    "fr": ("ff_siwis", "fr-fr"),  # B-
    "it": ("if_sara", "it"),  # C, as im_nicola
    "pt-BR": ("pf_dora", "pt-br"),  # ungraded
    "hi": ("hf_alpha", "hi"),  # C, as the other three
    "zh": ("zf_xiaobei", "zh"),  # D, as all eight
}


def _voice_url(voice_id, suffix, revision=PIPER_REVISION):
    family = voice_id.split("_", 1)[0]
    locale, name, quality = voice_id.split("-", 2)
    path = "/".join((family, locale, name, quality, voice_id + suffix))
    return PIPER_BASE_URL + revision + "/" + urllib.parse.quote(path)


def _piper(vid, onnx, cfg, license, credit, revision=PIPER_REVISION):
    # The small config first: one that will not come is found out before 60 MB.
    files = tuple(
        (vid + suffix, _voice_url(vid, suffix, revision), size)
        for suffix, size in ((".onnx.json", cfg), (".onnx", onnx))
    )
    return Pin(PIPER, vid, None, revision, files, license, credit)


def _kokoro():
    files = tuple(
        (name, KOKORO_BASE_URL + KOKORO_REVISION + "/" + name, size)
        for name, size in KOKORO_SIZES.items()
    )
    return Pin(
        KOKORO,
        KOKORO_ID,
        None,  # every speaker is in the one voices file
        KOKORO_REVISION,
        files,
        "Apache-2.0",
        "Kokoro-82M by hexgrad",
    )


# fmt: off
VOICES = {
    KOKORO_TAG: _kokoro(),
    "ca": _piper("ca_ES-upc_ona-medium", 63201294, 4875, "CC BY-SA 3.0", "Festcat corpus, Universitat Politècnica de Catalunya"),
    "cs": _piper("cs_CZ-jirka-medium", 63201294, 5025, "CC0", NABU),
    "da": _piper("da_DK-talesyntese-medium", 63201294, 4878, "CC0", SPRAKBANKEN),
    "de": _piper("de_DE-thorsten-medium", 63201294, 4819, "CC0", "Thorsten Müller, Thorsten-Voice"),
    "en-US": _piper("en_US-ljspeech-medium", 63531379, 4972, "public domain", "LJ Speech, Keith Ito and LibriVox"),
    "en-GB": _piper("en_GB-cori-medium", 63531379, 4966, "public domain", "LibriVox"),
    "es-ES": _piper("es_ES-davefx-medium", 63201294, 4817, "CC0", NABU),
    "es-MX": _piper("es_MX-ald-medium", 63201294, 4889, "Unlicense", "Ald Mexican Spanish dataset, Rafael Pantoja"),
    "fa": _piper("fa_IR-amir-medium", 63531379, 4958, "CC0", "Datacula"),
    "fi": _piper("fi_FI-harri-medium", 63201294, 4873, "CC0", "Finnish single-speaker dataset, Bryan Park"),
    "fr": _piper("fr_FR-siwis-medium", 63201294, 4875, "CC BY 4.0", "SIWIS French speech corpus, University of Edinburgh"),
    "hi": _piper("hi_IN-rohan-medium", 62950044, 5041, "CC BY 4.0", "Indic TTS, IIT Madras", PIPER_ROHAN_REVISION),
    "hu": _piper("hu_HU-anna-medium", 63201294, 5018, "CC0", NABU),
    "it": _piper("it_IT-paola-medium", 63511038, 7099, "CC0", "Paola Persico, Voice-Dataset-Italian"),
    "lv": _piper("lv_LV-aivars-medium", 63511038, 7242, "CC0", "Raivis Dejus"),
    "nb": _piper("no_NO-talesyntese-medium", 63201294, 4880, "CC0", SPRAKBANKEN),
    "ne": _piper("ne_NP-chitwan-medium", 62950044, 5043, "CC0", NABU),
    "nl": _piper("nl_NL-pim-medium", 63516050, 5037, "CC0", NABU),
    "pl": _piper("pl_PL-gosia-medium", 63201294, 4814, "CC0", NABU),
    "pt-BR": _piper("pt_BR-faber-medium", 63201294, 4855, "CC0", NABU),
    "pt-PT": _piper("pt_PT-tugão-medium", 63201294, 5026, "CC0", NABU),
    "ro": _piper("ro_RO-mihai-medium", 63201294, 4877, "CC0", NABU),
    "ru": _piper("ru_RU-denis-medium", 63201294, 4823, "CC0", NABU),
    "sk": _piper("sk_SK-lili-medium", 63201294, 4963, "CC0", NABU),
    "sl": _piper("sl_SI-artur-medium", 63200492, 4970, "CC BY 4.0", "Artur studio TTS corpus, ppisljar"),
    "sv": _piper("sv_SE-nst-medium", 63104526, 4157, "CC0", "NST, " + SPRAKBANKEN),
    "tr": _piper("tr_TR-fahrettin-medium", 63201294, 5022, "CC0", NABU),
    "uk": _piper("uk_UA-ukrainian_tts-medium", 76735663, 2002, "CC0", NABU),
    "vi": _piper("vi_VN-vais1000-medium", 63201294, 4860, "CC BY 4.0", "VAIS-1000 corpus"),
}
# fmt: on

# Voices left out on purpose, so a later pin does not bring one back: a
# licence that forbids commercial use, or none stated. Arabic has no clean
# voice yet and keeps the basic one.
EXCLUDED = {
    "hi_IN-pratham-medium": "CC BY-NC-SA",
    "hi_IN-priyamvada-medium": "CC BY-NC-SA",
    "zh_CN-huayan-medium": "licence unknown",
    "zh_CN-huayan-x_low": "licence unknown",
}


def needs_credit(license):
    """Whether a licence asks for its credit to be shown (CC BY, Apache);
    CC0, public domain and the Unlicense do not."""
    return str(license).startswith(("CC BY", "Apache"))


# The setting: Ask first / Automatically / Never (outbound.py).
DOWNLOADS_ENV = "ZIMI_VOICE_DOWNLOADS"
PREFS_KEY = "voice_downloads"
POLICY = outbound.FetchPolicy(
    DOWNLOADS_ENV, PREFS_KEY, outbound.ASK, "Voices for Dictionary"
)
# Which engine says a language, where someone chose in Manage: {primary:
# engine}, beside the setting in the same prefs file. Eric: "Options couldn't
# hurt once it's built." No choice: the best here, in ENGINES order.
CHOICES_KEY = "voice_engines"

# A word or a short phrase, never a paragraph: what the Dictionary says.
TEXT_MAX = 64
# A sentence, for the few places that say one (Discover's quote of the day):
# asked for with kind=sentence, cached and fed on stdin as a word is.
SENTENCE_MAX = 300
# Settings' Hear: "Some dictionary words are: X, Y, Z." in Zimi's language,
# asked for with kind=sample (or sample=1). Still one line, still cached by text.
SAMPLE_MAX = 200
# What each kind of text may be at most, by the name a request gives it.
TEXT_LIMITS = {"word": TEXT_MAX, "sentence": SENTENCE_MAX, "sample": SAMPLE_MAX}
SYNTH_TIMEOUT_S = 20  # Piper, its model loaded with the first word
# Kokoro's first word loads its model and a language's dictionary: about 5 s
# on a laptop, 13 on Eric's NAS (2026-10-03), so it is given longer.
KOKORO_TIMEOUT_S = 60
SYNTH_WAIT_S = 30  # how long a request queues behind another synthesis
# Requests that may wait behind the one being said; one more is told to come
# back (503, Retry-After), never that there is no voice.
SYNTH_QUEUE = 4
RETRY_AFTER_S = 2
# A warm worker (voicehelper.py serve) gives its memory back after this long
# with nothing said; the next word starts it again.
WORKER_IDLE_S = 10 * 60
WORKER_IDLE_CHECK_S = 30
WORKER_STOP_GRACE_S = 2  # a worker told its requests are over leaves at once
WORKER_STDERR_LINES = 20  # what a worker that failed last said, for the log
WARM_LANGS_MAX = 8  # the languages one page may ask to warm
PRESAY_MAX = 3  # words a page asks to have said ahead of a tap
FAILURES_MAX = 256  # words an engine could not say, remembered for the page
# What became of a word asked of an engine: said; the engine could not say
# it; no answer this time (busy, too slow, the worker died); and, from a
# worker only, a helper with no serve mode (each word runs it afresh).
OK, FAILED, LOST, UNSERVED = "ok", "failed", "lost", "unserved"
CACHE_MAX_BYTES = 64 * 1024 * 1024  # a word is ~40 KB: well over a thousand
FETCH_TIMEOUT_S = 30
FETCH_CHUNK = 256 * 1024
WAV_HEADER_BYTES = 44
TIMINGS = "timings.json"  # how fast each engine is here (timings())
FIRST_CHARS_MAX = 120  # the page's first chunk (_TTS_FIRST_CHUNK_MAX): "first words"
RTF_MIN_AUDIO_S = 2.0  # shorter speech is mostly start-up, not speed
TIMING_WEIGHT = 0.3  # a read's sample in the moving average; a Test replaces it
TIMINGS_FLUSH_S = 15  # a reading's samples reach timings.json this long after the first
# One fixed sentence of about 150 characters per language: the speed sample a
# warmed engine says once so rtf exists before the first tap (_sample_speed).
SPEED_SAMPLES = {
    "en": "The kettle sat on the stove while the rain tapped softly at the window, and nobody in the quiet house felt any need to hurry.",
    "es": "El agua hervía despacio en la cocina mientras la lluvia golpeaba suavemente la ventana, y nadie en la casa tenía ninguna prisa por moverse.",
    "fr": "La bouilloire chantait doucement sur le poêle pendant que la pluie tapotait la fenêtre, et personne dans la maison ne semblait pressé.",
    "it": "L'acqua bolliva lentamente sul fuoco mentre la pioggia batteva piano contro la finestra, e nessuno in casa aveva fretta di muoversi.",
    "pt": "A chaleira cantava baixinho no fogão enquanto a chuva batia de leve na janela, e ninguém naquela casa tinha qualquer pressa de se mexer.",
    "hi": "चूल्हे पर रखी केतली धीरे धीरे उबल रही थी और खिड़की पर बारिश की हल्की बूँदें गिर रही थीं, घर में किसी को कोई जल्दी नहीं थी।",
    "zh": "水壶在炉子上慢慢地烧着，雨点轻轻敲打着窗户，安静的屋子里没有人觉得需要着急，大家都在等着天色慢慢变亮。",
}
TEST_DIR = "test"  # a Test's audio, said and deleted, never the cache
TEST_CHUNKS_MAX = 8  # a Test's reading: a paragraph, as the page chunks it
# The speeds a Test works out the pauses for: the page's presets and steps
# up to its fastest (_TTS_GAP_RATES). Any speed between reads the next one up.
TEST_RATES = (0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3)
SAY_FORMAT = ("--file-format=WAVE", "--data-format=LEI16@22050")
PIPER_CMD_ENV = "ZIMI_PIPER"  # a piper command to use instead of finding one
HELPER_NAME = "zimi-voice"  # the desktop builds' engines, beside Zimi
HELPER_SCRIPT = "voicehelper.py"  # the same, run by Zimi's Python
# The engines a pip or uv install sets up in a venv of its own, the first
# time a voice is downloaded: the Docker image's pins, and the voices extra's
# (pyproject.toml); a test holds the three together.
ENGINE_REQUIREMENTS = (
    "piper-tts>=1.8,<2",
    "kokoro-onnx>=0.6,<0.7",
    "misaki[zh]>=0.9.4,<0.10",
    "num2words>=0.5.14,<0.6",
)
PIPER_REQUIREMENTS = ENGINE_REQUIREMENTS[:1]
# Kokoro runs on Python 3.10 to 3.12 (misaki 0.9 stops before 3.13,
# kokoro-onnx 0.6 before 3.14), and onnxruntime, under both engines, comes
# late to a new Python (none for 3.14 on an Intel Mac, 2026-10-10). The venv
# takes the first such Python it finds (Zimi's own, python3.12 to
# python3.10); with none, uv makes it with UV_PYTHON (uv fetches that Python
# if it has none); without uv, it is Piper's alone, on Zimi's own Python.
KOKORO_PYTHONS = ((3, 10), (3, 13))
_PYTHON_NAMES = ("python3.12", "python3.11", "python3.10")
UV_PYTHON = "3.12"
# What setting the engines up downloads, on top of the voice: measured from
# pip's own download of ENGINE_REQUIREMENTS (macOS, Python 3.12, 2026-10-10),
# and uv's Python where uv brings one. The page adds it to the offer's size.
ENGINES_BYTES = 108 * 1024 * 1024
UV_PYTHON_BYTES = 20 * 1024 * 1024
ENGINES_MARKER = ".zimi-sidecar.json"
# What voicehelper.py needs in Zimi's Python to run an engine.
_ENGINE_MODULES = {
    PIPER: ("piper",),
    KOKORO: ("kokoro_onnx", "misaki", "jieba", "pypinyin", "cn2an", "num2words"),
}

VOICES_DIR = "voices"
MANIFEST = "installed.json"

_LANG_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
_REGION_RE = re.compile(r"^(?:[A-Za-z]{2}|[0-9]{3})$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_SPACES_RE = re.compile(r"\s+")
_UNSAFE_RE = re.compile(r"[^\w.-]+")
# "Samantha            en_US    # Hello!": a voice name may hold spaces.
_SAY_LINE_RE = re.compile(r"^(.+?)\s+([a-z]{2,3})_([A-Za-z0-9]+)\s+#")
# A voice made to amuse, not to pronounce, and macOS's older Eloquence set
# ("Eddy (English (US))"); the page's NOVELTY_VOICES, on the server.
_SAY_SKIP_RE = re.compile(
    r"^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|"
    r"Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Deranged|Hysterical|"
    r"Fred|Junior|Ralph|Kathy|Princess|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|"
    r"Sandy|Shelley)\b"
)
# One name for a language, as the page's speechTag gives it.
_ALIASES = {"no": "nb", "nn": "nb", "cmn": "zh", "yue": "zh", "iw": "he", "in": "id"}
# espeak-ng's constructed languages that a library can be written in (each
# has a Wikipedia). Its fictional ones (Klingon, Quenya, Sindarin, Pyash,
# Lang Belta) and its test voice (xextan-test) have nothing to read, and no
# browser can name them: they are left out.
_ESPEAK_CONSTRUCTED = {"eo", "ia", "ie", "io", "jbo", "lfn", "nov", "vo"}
# espeak-ng's own codes for languages the page names by region.
_ESPEAK_REGIONS = {"cmn": ("zh", "CN"), "yue": ("zh", "HK")}
# The region a language is said in when no accent asks for another.
_HOME_REGION = {"en": "US", "pt": "BR", "zh": "CN", "nb": "NO", "sv": "SE", "da": "DK"}

_lock = threading.Lock()  # the engine discovery memo and the download state
_synth_lock = threading.Lock()  # one synthesis at a time
_synth_slots = threading.BoundedSemaphore(1 + SYNTH_QUEUE)  # said or waiting
_synth_waiting = 0  # requests waiting for _synth_lock (under _lock)
_sampled = {}  # engine -> the fingerprint it was last given a speed sample under
_found = {}
_download = {}
_fetcher = None  # the thread fetching a voice, while one is
_choices = None  # CHOICES_KEY as last read or written: no file read per word
_timings = None  # {"fp", "engines"} as last read or written (timings())
_timings_lock = threading.Lock()
_timings_dirty = False  # samples in _timings not yet in timings.json
_timings_timer = None  # the pending flush, while one is


def _reset_for_tests():
    global _choices, _timings, _timings_dirty, _timings_timer
    _stop_workers()
    with _lock:
        _found.clear()
        _download.clear()
        _failures.clear()
        _sampled.clear()
        _choices = None
    with _timings_lock:
        _timings = None
        _timings_dirty = False
        if _timings_timer:
            _timings_timer.cancel()
        _timings_timer = None
    _testing.clear()


# ── where things are ──────────────────────────────────────────────────────


def _dir(*parts):
    from zimi import server as _srv

    return os.path.join(_srv.ZIMI_DATA_DIR, VOICES_DIR, *parts)


def _engine_dir(engine):
    return _dir(engine)


def _piper_dir():
    return _engine_dir(PIPER)


def _cache_dir(engine, voice):
    return _dir("cache", engine + "-" + _UNSAFE_RE.sub("_", voice))


def _primary(tag):
    p = str(tag or "").split("-", 1)[0].split("_", 1)[0].lower()
    return _ALIASES.get(p, p)


def _region_of(voice_id):
    """'fr_FR-siwis-medium' -> 'FR'."""
    locale = voice_id.split("-", 1)[0]
    return locale.split("_", 1)[1].upper() if "_" in locale else ""


# ── the engines ───────────────────────────────────────────────────────────


def _run(cmd, text, out, timeout=SYNTH_TIMEOUT_S):
    """Run one engine: the text on its stdin, never in a shell or argv, the
    child in a group of its own and always reaped. True when it wrote a WAV."""
    proc = None
    try:
        proc = subproc.popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        _, err = proc.communicate(input=text.encode("utf-8"), timeout=timeout)
        if proc.returncode != 0:
            log.warning(
                "Say: %s exited %s: %s",
                os.path.basename(cmd[0]),
                proc.returncode,
                (err or b"")[-300:].decode("utf-8", "replace").strip(),
            )
            return False
    except subprocess.TimeoutExpired:
        log.warning("Say: %s took over %ss", os.path.basename(cmd[0]), timeout)
        return False
    except OSError as e:
        log.warning("Say: could not run %s: %s", cmd[0], e)
        return False
    finally:
        subproc.stop(proc)
    return _is_wav(out)


def _is_wav(path):
    try:
        with open(path, "rb") as f:
            head = f.read(12)
        return (
            head[:4] == b"RIFF"
            and head[8:12] == b"WAVE"
            and os.path.getsize(path) > WAV_HEADER_BYTES
        )
    except OSError:
        return False


def _list_output(cmd):
    try:
        return subprocess.run(
            cmd, capture_output=True, timeout=SYNTH_TIMEOUT_S, check=False
        ).stdout.decode("utf-8", "replace")
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _memo(key, fn):
    with _lock:
        if key in _found:
            return _found[key]
    value = fn()
    with _lock:
        _found[key] = value
    return value


def _has_modules(*names):
    """Whether Zimi's own Python could run voicehelper.py with these: found,
    never imported (an engine stays out of Zimi's process)."""
    if getattr(sys, "frozen", False):
        return False  # sys.executable is Zimi itself, not a Python
    try:
        return all(importlib.util.find_spec(n) is not None for n in names)
    except (ImportError, ValueError):
        return False


def helper_command():
    """The desktop app's ``zimi-voice``, beside Zimi's own executable, or
    None: a frozen build carries Piper and Kokoro there, not in Zimi."""
    if not getattr(sys, "frozen", False):
        return None
    exe = os.path.join(
        os.path.dirname(os.path.abspath(sys.executable)),
        HELPER_NAME + (".exe" if os.name == "nt" else ""),
    )
    return [exe] if os.path.isfile(exe) and os.access(exe, os.X_OK) else None


def engines_dir():
    """The venv a pip or uv install keeps Piper and Kokoro in."""
    from zimi import server as _srv

    return os.path.join(_srv.ZIMI_DATA_DIR, "tools", "voices")


def _engines_marker():
    """What the engines venv's finished install recorded, or {}: read once,
    found again when an install finishes (_found is cleared)."""

    def find():
        try:
            with open(os.path.join(engines_dir(), ENGINES_MARKER), encoding="utf-8") as f:
                got = json.load(f)
            return got if isinstance(got, dict) else {}
        except (OSError, ValueError):
            return {}

    return _memo("marker", find)


def _engines_python(engine):
    """The engines venv's Python where it has ``engine``, or None."""
    from zimi.importer import _venv_bin

    py = _venv_bin(engines_dir(), "python")
    has = engine in _engines_marker().get("engines", ())
    return py if has and os.path.exists(py) else None


def _kokoro_python():
    """A Python Kokoro runs on, or None: Zimi's own, else a python3.1x on
    PATH. Read from names, never by running one: the Dictionary's first
    open asks."""
    lo, hi = KOKORO_PYTHONS
    if lo <= sys.version_info[:2] < hi:
        return sys.executable
    for name in _PYTHON_NAMES:
        found = shutil.which(name)
        if found:
            return found
    return None


Plan = collections.namedtuple("Plan", "python requirements engines uv bytes")


def _setup_plan():
    """How the engines venv would be built, and what it downloads."""

    def find():
        py = _kokoro_python()
        if py:
            return Plan(py, ENGINE_REQUIREMENTS, DOWNLOADED, None, ENGINES_BYTES)
        uv = shutil.which("uv")
        if uv:
            return Plan(UV_PYTHON, ENGINE_REQUIREMENTS, DOWNLOADED, uv, ENGINES_BYTES + UV_PYTHON_BYTES)
        return Plan(sys.executable, PIPER_REQUIREMENTS, (PIPER,), None, ENGINES_BYTES)

    return _memo("setup", find)


def setup_bytes(engine):
    """What a voice for ``engine`` downloads before itself: the engines,
    where they are not here yet; else 0."""
    return 0 if runtime(engine) else _setup_plan().bytes


def _can_set_up():
    """Whether Zimi can install the engines itself: a Python install can
    (a venv beside it); a desktop build carries them in zimi-voice or not
    at all, and an operator who named a Piper (ZIMI_PIPER) keeps their own."""
    return not getattr(sys, "frozen", False) and not os.environ.get(PIPER_CMD_ENV, "").strip()


def _runner(engine):
    """voicehelper.py's command for ``engine``: the bundled helper, or the
    script itself, run by Zimi's Python where the engine is installed there,
    else by the engines venv's."""
    helper = helper_command()
    if helper:
        return helper + [engine]
    script = os.path.join(os.path.dirname(__file__), HELPER_SCRIPT)
    if _has_modules(*_ENGINE_MODULES[engine]):
        return [sys.executable, script, engine]
    own = _engines_python(engine)
    return [own, script, engine] if own else None


def _usable(engine):
    """Whether a voice for ``engine`` could be used once downloaded: the
    engine is here, or the download can set it up first."""
    if runtime(engine):
        return True
    # Not here though the plan has it: a Piper-only venv from before a Python
    # Kokoro runs on was found is built again, with both.
    return _can_set_up() and engine in _setup_plan().engines


def _set_up_engines():
    """Install Piper and Kokoro into the engines venv. True when done; on
    failure nothing is left behind and the log has pip's last words."""
    from zimi.importer import _run_stream, _venv_bin, build_venv

    venv = engines_dir()
    plan = _setup_plan()
    python, requirements, engines = plan.python, plan.requirements, plan.engines
    tail = collections.deque(maxlen=20)

    def say(line):
        # Every line of pip's output is a checkpoint: a Cancel stops the
        # install there (the runner kills pip, build_venv removes the venv)
        # instead of after a minute and a half of installing.
        tail.append(line)
        with _lock:
            if _download.get("cancel"):
                raise _Cancelled()

    log.info("Voices: setting up %s with Python %s in %s", ", ".join(engines), python, venv)
    ok = build_venv(
        venv, python, requirements, _venv_bin(venv, "python"), say,
        run=_run_stream, uv=plan.uv,
    )
    if not ok:
        log.warning("Voices: could not set up the engines:\n%s", "\n".join(tail))
        return False
    from zimi import server as _srv

    # Atomic: a marker half written would read as no install, and the next
    # download would build the venv again.
    if not _srv._atomic_write_json(
        os.path.join(venv, ENGINES_MARKER),
        {"tool": "voices", "spec": list(requirements), "engines": list(engines)},
    ):
        return False
    with _lock:
        _found.clear()  # every engine and version is found again
    return True


def piper_command():
    """How to run Piper, or None: ZIMI_PIPER, Zimi's own helper (the desktop
    app's, or piper-tts in Zimi's own Python), else a ``piper`` on PATH. The
    helper first: only it keeps a voice loaded between words (pip puts a
    ``piper`` on PATH beside the module, and the NAS took 4 s a word
    starting that afresh)."""

    def find():
        named = os.environ.get(PIPER_CMD_ENV, "").strip()
        if named:
            return [named] if shutil.which(named) else None
        own = _runner(PIPER)
        if own:
            return own
        on_path = shutil.which("piper")
        return [on_path] if on_path else None

    return _memo(PIPER, find)


def kokoro_command():
    """How to run Kokoro, or None: the desktop app's helper, or kokoro-onnx
    and misaki's Chinese in Zimi's own Python."""
    return _memo(KOKORO, lambda: _runner(KOKORO))


def runtime(engine):
    """The command for a downloaded voice's engine, or None."""
    return {PIPER: piper_command, KOKORO: kokoro_command}[engine]()


# ── what each engine is, for Settings ─────────────────────────────────────

_VERSION_RE = re.compile(r"\d+(?:\.\d+)+")


def _package_versions():
    """{package: version} for piper-tts and kokoro-onnx where Zimi runs
    them: the desktop helper's ``versions`` command, else the packages'
    metadata in Zimi's own Python (read, never imported)."""
    helper = helper_command()
    if helper:
        try:
            got = json.loads(_list_output(helper + ["versions"]).strip() or "{}")
            return got if isinstance(got, dict) else {}
        except ValueError:
            return {}
    import glob
    from importlib import metadata

    # The engines venv's site-packages too, where the engines live there.
    paths = sys.path + glob.glob(os.path.join(engines_dir(), "lib*", "python*", "site-packages"))
    paths += glob.glob(os.path.join(engines_dir(), "Lib", "site-packages"))
    out = {}
    for name in ("piper-tts", "kokoro-onnx"):
        for dist in metadata.distributions(name=name, path=paths):
            out[name] = dist.version
            break
    return out


def versions():
    """{engine: "what it is and its version"} for each engine here, found
    once and kept: Piper's package and its voices' pinned revision,
    Kokoro's package and model, espeak-ng's own word for itself, and the
    macOS release ``say`` comes with. An engine not here is left out."""

    def find():
        pkgs = _package_versions() if (piper_command() or kokoro_command()) else {}
        out = {}
        if piper_command():
            pkg = pkgs.get("piper-tts")
            out[PIPER] = ("Piper %s" % pkg if pkg else "Piper") + ", voices " + PIPER_REVISION
        if kokoro_command():
            pkg = pkgs.get("kokoro-onnx")
            out[KOKORO] = "kokoro-onnx %s" % pkg if pkg else "kokoro-onnx"
        if _say_voices():
            import platform

            mac = platform.mac_ver()[0]
            out[SAY] = "macOS" + (" " + mac if mac else "")
        exe = shutil.which("espeak-ng")
        if exe:
            m = _VERSION_RE.search(_list_output([exe, "--version"]))
            out[ESPEAK] = "eSpeak NG" + (" " + m.group(0) if m else "")
        return out

    out = dict(_memo("versions", find))
    if KOKORO in out:
        # The model is a download: whichever is on disk now, else the pinned one.
        rec = installed().get(KOKORO_TAG)
        out[KOKORO] += ", " + (rec["id"] if rec else KOKORO_ID)
    return out


# ── how fast each engine is here ──────────────────────────────────────────
# Eric, 2026-10-19: "show time to first word and all that? Set expectations
# but also understand ourselves based on the hardware (maybe invalidate
# between releases and or hardware changes or changes to these components)".
# Per engine: ``first_s``, a first chunk said with its model loaded;
# ``cold_s``, the same while the model loads; ``rtf``, seconds of work per
# second of speech; ``cps``, characters said per second of speech. Every
# sentence read aloud adds a sample, a Test replaces them. Kept under a fingerprint of Zimi's version, the engines and their
# models, and the machine: any of those changes and they start over.


def _hardware():
    """What the machine is, found once: its kind, CPU model and count, and
    memory to the GB."""

    def find():
        import platform

        cpu = ""
        try:
            with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if line.startswith("model name"):
                        cpu = line.split(":", 1)[1].strip()
                        break
        except OSError:
            pass
        if not cpu and sys.platform == "darwin":
            cpu = _list_output(["sysctl", "-n", "machdep.cpu.brand_string"]).strip()
        try:
            mem = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        except (AttributeError, ValueError, OSError):
            mem = 0
        return {
            "machine": platform.machine(),
            "cpu": cpu or platform.processor(),
            "cpus": os.cpu_count() or 0,
            "mem_gb": round(mem / 2**30),
        }

    return _memo("hardware", find)


def _fingerprint():
    from zimi import server as _srv

    what = dict(_hardware(), zimi=_srv.ZIMI_VERSION, engines=versions())
    return hashlib.sha1(json.dumps(what, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def _forget_fingerprint():
    """The engines' versions changed (a voice installed or removed): the
    fingerprint is worked out again at the next sample."""
    with _lock:
        _found.pop("fingerprint", None)


def _timings_now():
    """The timings for this fingerprint (call under _timings_lock): read
    once, emptied when the fingerprint has changed."""
    global _timings
    fp = _memo("fingerprint", _fingerprint)
    if _timings is None:
        try:
            with open(_dir(TIMINGS), encoding="utf-8") as f:
                _timings = json.load(f)
        except (OSError, ValueError):
            _timings = {}
    if not isinstance(_timings, dict) or _timings.get("fp") != fp:
        _timings = {"fp": fp, "engines": {}}
    return _timings


def timings():
    """{engine: {"first_s", "cold_s", "rtf", "cps", "n"}} measured on this machine,
    as far as they are known."""
    with _timings_lock:
        got = json.loads(json.dumps(_timings_now()["engines"]))
    # An engine with no model to load (eSpeak) is never cold: after a rest it
    # starts as fast as ever, so its cold start is its warm one, not unknown.
    for engine, rec in got.items():
        if engine not in DOWNLOADED and "cold_s" not in rec and "first_s" in rec:
            rec["cold_s"] = rec["first_s"]
    return got


def _note_timing(engine, seconds, audio_s, chars, cold, weight=TIMING_WEIGHT):
    """One synthesis: ``seconds`` of work for ``audio_s`` of speech."""
    with _timings_lock:
        t = _timings_now()
        rec = t["engines"].setdefault(engine, {"n": 0})

        def mix(key, value):
            old = rec.get(key)
            rec[key] = round(value if old is None else old + weight * (value - old), 3)

        if chars <= FIRST_CHARS_MAX:
            mix("cold_s" if cold else "first_s", seconds)
        if not cold and audio_s >= RTF_MIN_AUDIO_S:
            mix("rtf", seconds / audio_s)
            mix("cps", chars / audio_s)
        rec["n"] += 1
        _save_timings_soon()


def _save_timings_soon():
    """Call under _timings_lock. A sentence's sample is in memory at once;
    the file is written once in a while by a timer, not by every sentence
    (that would be a disk write inside the synthesis lock)."""
    global _timings_dirty, _timings_timer
    _timings_dirty = True
    if _timings_timer is None:
        _timings_timer = threading.Timer(TIMINGS_FLUSH_S, _flush_timings)
        _timings_timer.daemon = True
        _timings_timer.start()


def _flush_timings():
    """Write the samples taken since the last write, if any. Also at exit."""
    global _timings_dirty, _timings_timer
    with _timings_lock:
        if _timings_timer is not None:
            _timings_timer.cancel()  # run from exit or a test: the one still armed has nothing left to do
        _timings_timer = None
        if not (_timings_dirty and isinstance(_timings, dict)):
            return
        _timings_dirty = False
        t = json.loads(json.dumps(_timings))
    _srv_write(t)  # outside the lock: a sample taken meanwhile waits for no disk


def _wav_seconds(path):
    """How long a WAV plays, from its byte rate; 0 when it cannot tell."""
    try:
        with open(path, "rb") as f:
            head = f.read(WAV_HEADER_BYTES)
        rate = int.from_bytes(head[28:32], "little")
        return max(0, os.path.getsize(path) - WAV_HEADER_BYTES) / rate if rate else 0
    except OSError:
        return 0


def _is_cold(engine, voice):
    """Whether saying something now waits for the engine's model to load:
    its warm worker is not running, or has not loaded this voice. An engine
    run afresh each time is never cold: every run is alike."""
    if engine not in DOWNLOADED or not _worker_command(engine):
        return False
    with _workers_lock:
        w = _workers.get(engine)
    if w is None or w.serves is False:
        return w is None
    return not w.alive() or _load_key(_request(engine, voice)) not in w.loaded


def _timed(engine, voice, text, out, weight=TIMING_WEIGHT):
    """_synthesize, timed and noted. Call under _synth_lock."""
    cold = _is_cold(engine, voice)
    start = time.monotonic()
    done = _synthesize(engine, voice, text, out)
    if done == OK:
        _note_timing(engine, time.monotonic() - start, _wav_seconds(out), len(text), cold, weight)
    return done


def _gaps(chunks, rate):
    """Seconds of silence a reading of ``chunks`` [(work_s, audio_s)] has at
    ``rate`` once it has started: the chunks are made one after another
    (one synthesis at a time) while the earlier ones play."""
    ready = gap = 0.0
    ends = None
    for work, audio in chunks:
        ready += work
        if ends is not None:
            gap += max(0.0, ready - ends)
            ends = max(ready, ends) + audio / rate
        else:
            ends = ready + audio / rate
    return gap


def _rate_key(rate):
    return "%g" % rate  # "1", "1.25": as the page writes its speeds


def _acquire_synth(timeout=SYNTH_WAIT_S):
    """Wait for _synth_lock as a request does; a speed sample starts only
    while nobody is in this queue. False when it was not got in time."""
    global _synth_waiting
    with _lock:
        _synth_waiting += 1
    try:
        return _synth_lock.acquire(timeout=timeout)
    finally:
        with _lock:
            _synth_waiting -= 1


def _test_engine(engine, lang, texts):
    """One engine, as a reading uses it: the first chunk with nothing
    loaded, again warm, then the rest back to back. Its timings."""
    picked = choose(lang, "", engine)
    if not picked or picked[0] != engine:
        return
    voice = picked[1]
    if not _acquire_synth():
        raise Busy("waited %ss" % SYNTH_WAIT_S)
    try:
        if engine in DOWNLOADED:
            _stop_workers([engine])  # after a rest: the model loads again
        os.makedirs(_dir(TEST_DIR), exist_ok=True)
        out = _dir(TEST_DIR, "%s.wav" % engine)
        said = []
        for text in [texts[0]] + list(texts):
            try:
                start = time.monotonic()
                done = _timed(engine, voice, text, out, weight=1.0)
                said.append((time.monotonic() - start, _wav_seconds(out)))
            finally:
                if os.path.exists(out):
                    os.remove(out)
            if done == FAILED:
                raise Failed(engine)
            if done != OK:
                raise Busy("%s did not answer" % engine)
    finally:
        _synth_lock.release()
    reading = said[1:]  # warm first chunk, then the rest
    work = sum(w for w, _a in reading[1:])
    audio = sum(a for _w, a in reading[1:])
    with _timings_lock:
        t = _timings_now()
        rec = t["engines"].setdefault(engine, {"n": 0})
        # The first chunk came after a rest, also for an engine with no
        # model to load (eSpeak): then a rest costs it nothing.
        rec["cold_s"] = round(said[0][0], 3)
        # The warm first chunk, as _note_timing would take it were it short
        # enough to count as first words: the Test's is whatever opened its
        # reading.
        rec["first_s"] = round(said[1][0], 3)
        if audio:
            rec["rtf"] = round(work / audio, 3)
            rec["cps"] = round(sum(len(x) for x in texts[1:]) / audio, 3)
        rec["gaps"] = {_rate_key(r): round(_gaps(reading, r), 1) for r in TEST_RATES}
        rec["tested"] = int(time.time())
        _srv_write(t)


def _srv_write(t):
    from zimi import server as _srv

    os.makedirs(_dir(), exist_ok=True)
    _srv._atomic_write_json(_dir(TIMINGS), t)


_testing = {}  # the Test in flight: {"engine", "done", "total", "started"}; {"error"} after one failed


def testing():
    with _lock:
        return dict(_testing)


def start_test(lang, chunks):
    """Test every engine here, one after another, in the background: what
    a reading does (_test_engine). ``chunks`` are a real paragraph in the
    page's language, cut as the page cuts an article (a short first chunk,
    then longer ones); an engine that does not say the language uses one it
    does, as only its speed is measured. False when the chunks will not do,
    None when a Test is already running."""
    if not isinstance(chunks, list) or not 2 <= len(chunks) <= TEST_CHUNKS_MAX:
        return False
    # Every chunk up to a sentence's length: the page's chunker keeps a first
    # sentence whole when it has no break to cut at, so it may pass
    # FIRST_CHARS_MAX (the reading Settings sends opened at 133 characters).
    texts = [clean_text(c, SENTENCE_MAX) for c in chunks]
    lang = lang if isinstance(lang, str) and valid_lang(lang) else "en"
    if not all(texts):
        return False
    said = can_say()
    todo = []
    for engine in reversed(ENGINES):  # quickest first: numbers come in soonest
        langs = [p for p, row in said.items() if engine in row["engines"]]
        if langs:
            todo.append((engine, _primary(lang) if _primary(lang) in langs else langs[0]))
    with _lock:
        if _testing.get("engine"):
            return None
        _testing.clear()
        _testing.update(engine=todo[0][0] if todo else "", done=0, total=len(todo), started=int(time.time()))

    def run():
        try:
            for i, (engine, l) in enumerate(todo):
                with _lock:
                    _testing.update(engine=engine, done=i)
                _test_engine(engine, l, texts)
            with _lock:
                _testing.clear()
        except Exception as e:  # anything (a full disk, say): never leave "Testing" on for good
            if isinstance(e, (Busy, Failed)):
                log.warning("Voices: the speed test stopped: %s", e)
            else:
                log.exception("Voices: the speed test failed")
            with _lock:
                _testing.clear()
                _testing["error"] = True

    threading.Thread(target=run, daemon=True, name="voice-test").start()
    return True


# ── the warm workers ──────────────────────────────────────────────────────
# Started afresh, an engine spends most of a word loading: its model, and
# Kokoro's dictionaries (7 to 13 s a word on Eric's NAS, 2026-10-03). So the
# helper runs as ``voicehelper.py serve ENGINE``: loaded once, one request a
# line, one worker per engine, in a process group of its own (subproc.py),
# stopped after WORKER_IDLE_S to give the memory back. Where it cannot run
# (a ``piper`` of the operator's own, an older zimi-voice), each word runs
# the engine as before.


class _Worker:
    """One engine's warm helper. ``ask`` sends a request and waits for its
    answer; a worker that dies is started again by the next request, one
    that hangs past the timeout is stopped."""

    def __init__(self, engine, cmd):
        self.engine, self.cmd = engine, cmd
        self.proc = None
        self.answers = None  # the reply lines of the current process
        self.lock = threading.Lock()  # one request at a time
        self.used = 0.0  # time.monotonic() of the last answer
        self.loaded = set()  # what the running process has loaded, by _load_key
        self.warming = set()  # what a warm-up is loading now
        self.serves = None  # None until it has answered once; False: it cannot
        self.stderr = collections.deque(maxlen=WORKER_STDERR_LINES)

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def _start(self):
        self.stop()
        self.proc = subproc.popen(
            self.cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.used = time.monotonic()
        self.answers = queue.Queue()
        for target, pipe in (
            (self._read, self.proc.stdout),
            (self._drain, self.proc.stderr),
        ):
            threading.Thread(
                target=target,
                args=(pipe, self.answers),
                daemon=True,
                name="voice-worker",
            ).start()
        _ensure_janitor()

    @staticmethod
    def _read(pipe, answers):
        try:
            for line in pipe:
                answers.put(line)
        except (OSError, ValueError):
            pass
        answers.put(None)  # it ended

    def _drain(self, pipe, _answers):
        try:
            for line in pipe:
                self.stderr.append(line.decode("utf-8", "replace").rstrip())
        except (OSError, ValueError):
            pass

    def ask(self, req, timeout):
        """OK, FAILED (it could not say this), LOST (busy, too slow, or it
        died: the next request starts it again), or UNSERVED: it never
        answered at all, this helper has no serve mode."""
        if not self.lock.acquire(timeout=timeout):
            return LOST
        try:
            deadline = time.monotonic() + timeout
            try:
                if not self.alive():
                    self._start()
                self.proc.stdin.write((json.dumps(req) + "\n").encode("utf-8"))
                self.proc.stdin.flush()
                line = self.answers.get(timeout=max(0.1, deadline - time.monotonic()))
            except (OSError, ValueError, queue.Empty):
                line = None
            if line is None:
                log.warning(
                    "Say: the %s worker %s: %s",
                    self.engine,
                    "stopped" if not self.alive() else "took over %ss" % timeout,
                    " | ".join(list(self.stderr)[-3:]),
                )
                self.stop()
                if self.serves is None:
                    self.serves = False
                    return UNSERVED
                return LOST
            self.serves = True
            self.used = time.monotonic()
            try:
                reply = json.loads(line)
            except ValueError:
                reply = {}
            if reply.get("ok") is not True:
                log.warning("Say: %s: %s", self.engine, reply.get("error", "no answer"))
                return FAILED
            return OK
        finally:
            self.lock.release()

    def stop(self):
        proc, self.proc = self.proc, None
        self.loaded = set()
        if proc is not None:
            try:
                proc.stdin.close()  # the end of its requests: it leaves
            except (OSError, ValueError):
                pass
            subproc.stop(proc, grace=WORKER_STOP_GRACE_S)


_workers = {}  # engine -> _Worker
_workers_lock = threading.Lock()
_janitor = None


def _worker_command(engine):
    """``voicehelper.py serve ENGINE`` where the engine runs through Zimi's
    own helper (not a ``piper`` the operator named), else None."""

    def find():
        helper = runtime(engine)
        if not helper or helper != _runner(engine):
            return None
        return helper[:-1] + ["serve", engine]

    return _memo("serve-" + engine, find)


def _worker(engine):
    """The engine's worker (started on its first request), or None where
    each word runs the engine afresh."""
    cmd = _worker_command(engine) if engine in DOWNLOADED else None
    if not cmd:
        return None
    with _workers_lock:
        w = _workers.get(engine)
        if w is None or w.cmd != cmd:
            if w is not None:
                w.stop()
            w = _workers[engine] = _Worker(engine, cmd)
    return None if w.serves is False else w


def _stop_workers(engines=DOWNLOADED):
    """Stop these engines' workers (a voice removed or replaced: the next
    word loads what is on disk now) and forget them."""
    with _workers_lock:
        gone = [_workers.pop(e) for e in engines if e in _workers]
    for w in gone:
        # A word in flight gets a moment; then it is stopped anyway, and
        # its request comes back LOST rather than holding up a removal.
        held = w.lock.acquire(timeout=WORKER_STOP_GRACE_S)
        try:
            w.stop()
        finally:
            if held:
                w.lock.release()


def _reap_idle(now=None):
    """Stop every worker nothing has asked of for WORKER_IDLE_S. One in the
    middle of a word is left to finish it. True while any is still up."""
    now = time.monotonic() if now is None else now
    with _workers_lock:
        workers = list(_workers.values())
    for w in workers:
        if (
            w.alive()
            and now - w.used >= WORKER_IDLE_S
            and w.lock.acquire(blocking=False)
        ):
            try:
                log.info("Say: the %s worker was idle, stopped", w.engine)
                w.stop()
            finally:
                w.lock.release()
    return any(w.alive() for w in workers)


def _janitor_loop():
    global _janitor
    while True:
        time.sleep(WORKER_IDLE_CHECK_S)
        if _reap_idle():
            continue
        with _workers_lock:  # one started since is seen here, or starts another
            if not any(w.alive() for w in _workers.values()):
                _janitor = None
                return


def _ensure_janitor():
    global _janitor
    with _workers_lock:
        if _janitor is None:
            _janitor = threading.Thread(
                target=_janitor_loop, daemon=True, name="voice-workers"
            )
            _janitor.start()


atexit.register(_stop_workers)
atexit.register(_flush_timings)


def _say_voices():
    """macOS ``say`` voices: {primary: {region: voice}}, the best per region."""

    def find():
        if sys.platform != "darwin" or not shutil.which("say"):
            return {}
        out = {}
        for line in _list_output(["say", "-v", "?"]).splitlines():
            m = _SAY_LINE_RE.match(line)
            if not m or _SAY_SKIP_RE.match(m.group(1)):
                continue
            name, region = m.group(1).strip(), m.group(3).upper()
            # "Ava (Premium)" over "Ava", a plain name over "Rocko (Italian)".
            better = "(Premium)" in name or "(Enhanced)" in name
            have = out.setdefault(_primary(m.group(2)), {})
            if region not in have or better:
                have[region] = name
        return out

    return _memo(SAY, find)


def _espeak_voices():
    """espeak-ng's languages: {primary: {region: code}}."""

    def find():
        exe = shutil.which("espeak-ng")
        if not exe:
            return {}
        out = {}
        for line in _list_output([exe, "--voices"]).splitlines()[1:]:
            cols = line.split()
            if len(cols) < 2:
                continue
            code = cols[1]
            if len(cols) > 4 and cols[4].startswith("art/") and code not in _ESPEAK_CONSTRUCTED:
                continue
            parts = code.split("-")
            if code in _ESPEAK_REGIONS:
                primary, region = _ESPEAK_REGIONS[code]
            else:
                primary = _primary(parts[0])
                region = (
                    parts[1].upper() if len(parts) > 1 and len(parts[1]) == 2 else ""
                )
            out.setdefault(primary, {}).setdefault(region, code)
        return out

    return _memo(ESPEAK, find)


def _kokoro_region(tag):
    """A Kokoro language's region: its tag's, else the language's home."""
    primary = _primary(tag)
    if "-" in tag:
        return tag.split("-", 1)[1]
    return _HOME_REGION.get(primary, primary.upper())


def _downloaded_voices(engine):
    """Installed voices of ``engine`` it can run: {primary: {region: tag}}.
    A Piper voice's region is in its id; Kokoro's model says every one of
    its languages, each by its KOKORO_LANGS tag."""
    if not runtime(engine):
        return {}
    have = installed()
    out = {}
    if engine == KOKORO:
        if KOKORO_TAG in have:
            for tag in KOKORO_LANGS:
                out.setdefault(_primary(tag), {})[_kokoro_region(tag)] = tag
        return out
    for tag, rec in have.items():
        if rec["engine"] == engine:
            out.setdefault(_primary(tag), {})[_region_of(rec["id"])] = tag
    return out


def _piper_voices():
    return _downloaded_voices(PIPER)


def _kokoro_voices():
    return _downloaded_voices(KOKORO)


def _voices(engine):
    return {
        PIPER: _piper_voices,
        KOKORO: _kokoro_voices,
        SAY: _say_voices,
        ESPEAK: _espeak_voices,
    }[engine]()


def _home_first(primary, regions):
    home = _HOME_REGION.get(primary, primary.upper())
    return sorted(regions, key=lambda r: (r != home, r == ""))


def choices():
    """{primary: engine}: the engine chosen in Manage for each language."""
    global _choices
    with _lock:
        if _choices is not None:
            return dict(_choices)
    from zimi import manage

    saved = manage._read_app_update_prefs().get(CHOICES_KEY)
    saved = {
        k: v
        for k, v in (saved if isinstance(saved, dict) else {}).items()
        if isinstance(k, str) and v in ENGINES
    }
    with _lock:
        _choices = saved
    return dict(saved)


def engines_for(lang):
    """The engines here that can say ``lang``, best first."""
    primary = _primary(lang)
    return [e for e in ENGINES if _voices(e).get(primary)]


def set_choice(lang, engine):
    """Have ``engine`` say ``lang`` from now on; None, or the engine that
    would say it anyway, goes back to the best here. False when ``engine``
    cannot say it here."""
    global _choices
    primary = _primary(lang)
    if not _LANG_RE.match(primary or ""):
        return False
    if engine is not None and engine not in engines_for(primary):
        return False
    from zimi import manage

    saved = choices()
    best = engines_for(primary)[:1]
    if engine is None or [engine] == best:
        saved.pop(primary, None)
    else:
        saved[primary] = engine
    manage._write_app_update_prefs(**{CHOICES_KEY: saved})
    with _lock:
        _choices = saved
    return True


def _engine_order(primary):
    """ENGINES, the chosen one for this language first. A chosen engine
    that can no longer say it (its voice removed) is simply passed over."""
    chosen = choices().get(primary)
    return ((chosen,) if chosen else ()) + tuple(e for e in ENGINES if e != chosen)


def choose(lang, accent="", engine=None):
    """``(engine, voice)`` to say ``lang`` with, or None. An accent's region
    asks first for an engine with that region's voice, then any voice of the
    language: the engine chosen in Manage, else Kokoro before Piper before
    ``say`` before espeak-ng. ``engine`` asks for that one alone (the
    Dictionary's Other voices)."""
    primary = _primary(lang)
    region = (accent or (lang.split("-", 1)[1] if "-" in lang else "")).upper()
    order = (engine,) if engine else _engine_order(primary)
    tables = [(e, _voices(e).get(primary) or {}) for e in order]
    if region:
        for engine, by_region in tables:
            if region in by_region:
                return engine, by_region[region]
    for engine, by_region in tables:
        if by_region:
            return engine, by_region[_home_first(primary, by_region)[0]]
    return None


def can_say():
    """What the server can say: {primary: {"engine", "engines", "regions"}},
    the engine a plain Say would use, every engine that can say it (best
    first), and every region some engine has a voice for."""
    out = {}
    for engine in ENGINES:
        for primary, by_region in _voices(engine).items():
            row = out.setdefault(
                primary, {"engine": engine, "engines": [], "regions": []}
            )
            row["engines"].append(engine)
            for r in by_region:
                if r and r not in row["regions"]:
                    row["regions"].append(r)
    chosen = choices()
    for primary, row in out.items():
        row["regions"].sort()
        if chosen.get(primary) and _voices(chosen[primary]).get(primary):
            row["engine"] = chosen[primary]
    return out


# ── saying a word ─────────────────────────────────────────────────────────


def clean_text(text, limit=TEXT_MAX):
    """The text as an engine gets it, or None: one line, no control
    characters, at most ``limit`` characters (TEXT_MAX, a word; see
    TEXT_LIMITS for a sentence and Settings' sample)."""
    text = str(text or "")
    if _CONTROL_RE.search(text.replace("\t", " ").replace("\n", " ")):
        return None
    text = _SPACES_RE.sub(" ", text).strip()
    if not text or len(text) > limit:
        return None
    return text


def valid_lang(lang, accent=""):
    return bool(_LANG_RE.match(lang or "")) and (
        not accent or bool(_REGION_RE.match(accent))
    )


def _request(engine, voice):
    """What a downloaded voice's engine is given besides the text: its
    files, and Kokoro's speaker and phoneme code (voicehelper.py)."""
    if engine == PIPER:
        rec = installed().get(voice)
        return {"model": os.path.join(_piper_dir(), rec["id"] + ".onnx")}
    speaker, code = KOKORO_LANGS[voice]
    folder = _engine_dir(KOKORO)
    return {
        "model": os.path.join(folder, KOKORO_MODEL),
        "voices": os.path.join(folder, KOKORO_VOICES),
        "voice": speaker,
        "lang": code,
    }


def _command(engine, voice, out):
    """One engine run that says one word, the text on its stdin."""
    if engine == PIPER:
        return piper_command() + ["-m", _request(engine, voice)["model"], "-f", out]
    if engine == KOKORO:
        req = _request(engine, voice)
        return kokoro_command() + [
            "--model", req["model"],
            "--voices", req["voices"],
            "--voice", req["voice"],
            "--lang", req["lang"],
            "-f", out,
        ]  # fmt: skip
    if engine == SAY:
        return ["say", "-v", voice, "-f", "-", "-o", out] + list(SAY_FORMAT)
    return [shutil.which("espeak-ng") or "espeak-ng", "-v", voice, "-w", out, "--stdin"]


def _cache_voice(engine, voice):
    """The cache's name for a voice: a downloaded one by its model, and
    Kokoro's by the speaker within it too, so a newer voice (or another
    speaker) for the same language never answers with the old one's audio."""
    if engine == KOKORO:
        rec = installed().get(KOKORO_TAG)
        return (rec["id"] if rec else KOKORO_ID) + "-" + KOKORO_LANGS[voice][0]
    if engine == PIPER:
        rec = installed().get(voice)
        return rec["id"] if rec else voice
    return voice


class Busy(Exception):
    """The voice is there but did not say the word this time: others were
    ahead of it, or it took too long. Not "no voice": the page keeps the
    voice and asks again (503, Retry-After)."""


class Failed(Exception):
    """The engine ran and could not say this word (500)."""


_failures = collections.OrderedDict()  # audio path -> True, the latest last


def speak(text, lang, accent="", engine=None, limit=TEXT_MAX, fetch=True):
    """WAV bytes of ``text`` said in ``lang``, or None when no engine can
    say it. ``engine``: that engine or none. Raises Busy when one can but
    did not get to it, Failed when it tried and could not. Cached by engine,
    voice and text; one synthesis at a time, SYNTH_QUEUE more waiting.
    ``fetch``: a voice not here may be fetched for next time (Automatically)."""
    if clean_text(text, limit) is None or not valid_lang(lang, accent):
        return None
    if engine is not None and engine not in ENGINES:
        return None
    if fetch:
        _maybe_fetch(lang, accent)
    where = _audio(text, lang, accent, engine, limit)
    if where is None:
        return None
    engine, voice, text, path = where
    folder = os.path.dirname(path)
    got = _cached(path)
    if got is not None:
        return got
    if not _synth_slots.acquire(blocking=False):
        raise Busy("queue full")
    try:
        if not _acquire_synth():
            raise Busy("waited %ss" % SYNTH_WAIT_S)
        try:
            got = _cached(path)  # another request may have said it while we waited
            if got is not None:
                return got
            os.makedirs(folder, exist_ok=True)
            tmp = path + ".part"
            try:
                # A sentence (Read aloud) is timed; a word is mostly start-up.
                if limit == SENTENCE_MAX:
                    done = _timed(engine, voice, text, tmp)
                else:
                    done = _synthesize(engine, voice, text, tmp)
                _note_failure(path, done == FAILED)
                if done == FAILED:
                    raise Failed(engine)
                if done != OK:
                    raise Busy("%s did not answer" % engine)
                os.replace(tmp, path)
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)
        finally:
            _synth_lock.release()
    finally:
        _synth_slots.release()
    _trim_cache()
    return _cached(path)


def _audio(text, lang, accent="", engine=None, limit=TEXT_MAX):
    """(engine, voice, text, path): who says the word and where its audio
    is kept, or None when no engine here can say it."""
    text = clean_text(text, limit)
    if text is None or not valid_lang(lang, accent):
        return None
    if engine is not None and engine not in ENGINES:
        return None
    picked = choose(lang, accent, engine)
    if not picked:
        return None
    engine, voice = picked
    folder = _cache_dir(engine, _cache_voice(engine, voice))
    name = hashlib.sha1(text.encode("utf-8")).hexdigest() + ".wav"
    return engine, voice, text, os.path.join(folder, name)


def say_ahead(text, lang):
    """Say a word now, in the background, so its first tap plays at once: in
    the voice a tap would get (no engine named, no accent), into the same
    cache. Never fetches a voice, and skips when a voice is busy reading (a
    reading that starts in that instant waits behind one word). No voice here
    for the language: left for the tap. True once made."""
    where = _audio(text, lang)
    if where is None:
        return False
    if _cached(where[3]) is not None:
        return True
    if _synth_lock.locked():
        return False
    try:
        return speak(text, lang, fetch=False) is not None
    except (Busy, Failed) as e:
        log.debug("Voices: %r not said ahead: %s", text, e)
        return False


def said(text, lang, accent="", engine=None, limit=TEXT_MAX):
    """None when no voice here says the word, else {"made": its audio is
    there, "failed": the engine could not say it last time}. Nothing is
    said or fetched: the page asks this after its audio failed. Missing,
    made (audio that would not play) or failed: the word is the device's.
    Neither: the voice was busy, and the next tap asks again."""
    where = _audio(text, lang, accent, engine, limit)
    if where is None:
        return None
    path = where[3]
    with _lock:
        failed = path in _failures
    return {"made": os.path.isfile(path), "failed": failed}


def _note_failure(path, failed):
    with _lock:
        _failures.pop(path, None)
        if failed:
            _failures[path] = True
            while len(_failures) > FAILURES_MAX:
                _failures.popitem(last=False)


def _synthesize(engine, voice, text, out):
    """Say ``text`` into ``out``: through the engine's warm worker where it
    has one, else one run of the engine. OK (a WAV is there), FAILED or
    LOST."""
    timeout = KOKORO_TIMEOUT_S if engine == KOKORO else SYNTH_TIMEOUT_S
    worker = _worker(engine)
    if worker is not None:
        loads = _request(engine, voice)
        done = worker.ask(dict(loads, text=text, out=out), timeout)
        if done == OK:
            worker.loaded.add(_load_key(loads))
            return OK if _is_wav(out) else FAILED
        if done != UNSERVED:
            return done
    return (
        OK if _run(_command(engine, voice, out), text, out, timeout=timeout) else FAILED
    )


def warm(langs, engine=None):
    """Have the worker of the engine that says each language (``engine``
    when given: the one Read aloud will read with) load it now,
    in the background, so the first word is not the slow one. Downloads
    nothing (no _maybe_fetch); a voice already loaded, or loading, is left
    alone. Returns the engines asked to load something."""
    started = []
    for lang in list(langs or [])[:WARM_LANGS_MAX]:
        if not isinstance(lang, str) or not valid_lang(lang):
            continue
        picked = choose(lang, engine=engine)
        if not picked or picked[0] not in DOWNLOADED:
            continue
        worker = _worker(picked[0])
        if worker is None:
            continue
        req = _request(*picked)
        key = _load_key(req)
        with _workers_lock:
            if key in worker.loaded:
                _sample_in_background(picked[0], lang)  # a lock that was busy at the last warm
                continue
            if key in worker.warming:
                continue
            worker.warming.add(key)
        started.append(picked[0])
        threading.Thread(
            target=_warm_one, args=(worker, req, key, lang), daemon=True, name="voice-warm"
        ).start()
    return started


def presay(words):
    """Say a page's words now, in the background, into the cache, so a tap
    plays at once: Kokoro takes about 8 s a word on a NAS even loaded (Eric,
    2026-10-03: "Natural sounds great but takes forever"). ``words``:
    [{"text", "lang", "engine"?}], the first PRESAY_MAX; nothing is
    downloaded, a word already said is a cache hit, and one that cannot be
    said now is skipped."""
    todo = []
    for w in list(words or [])[:PRESAY_MAX]:
        if not isinstance(w, dict):
            continue
        text, lang, engine = w.get("text"), w.get("lang"), w.get("engine") or None
        if not (isinstance(text, str) and isinstance(lang, str)):
            continue
        if clean_text(text) is None or not valid_lang(lang) or (engine is not None and engine not in ENGINES):
            continue
        todo.append((text, lang, engine))
    if todo:
        threading.Thread(target=_presay_all, args=(todo,), daemon=True, name="voice-presay").start()
    return len(todo)


def _presay_all(todo):
    for text, lang, engine in todo:
        try:
            speak(text, lang, "", engine=engine)
        except Exception:
            pass  # busy or failed now: the tap asks again


def _warm_one(worker, req, key, lang=None):
    timeout = KOKORO_TIMEOUT_S if worker.engine == KOKORO else SYNTH_TIMEOUT_S
    try:
        if worker.ask(req, timeout) == OK:
            worker.loaded.add(key)
    finally:
        with _workers_lock:
            worker.warming.discard(key)
    if lang and key in worker.loaded:
        _sample_speed(worker.engine, lang)


def _speed_sample(engine, lang):
    """(voice, sentence) for the engine's speed sample in ``lang``, or None:
    the language's own sentence, else English where the engine speaks it."""
    for tag in (lang, "en"):
        text = SPEED_SAMPLES.get(_primary(tag))
        picked = choose(tag, "", engine) if text else None
        if picked and picked[0] == engine:
            return picked[1], text
    return None


def _sample_speed(engine, lang):
    """Once per engine per fingerprint, when it has no rtf: say one fixed
    sentence, timed and noted as a reading's is, so Read aloud's first tap
    has the number. Never ahead of a request: skipped while one waits for
    the lock or the lock is busy (the next warm tries again); once tried,
    success or not, left alone until the fingerprint changes. Returns True
    when it said it."""
    with _timings_lock:
        t = _timings_now()
        fp = t["fp"]
        if "rtf" in t["engines"].get(engine, {}):
            return False
    with _lock:
        if _sampled.get(engine) == fp or _synth_waiting:
            return False
    picked = _speed_sample(engine, lang)
    if picked is None or not _synth_lock.acquire(blocking=False):
        return False
    try:
        with _lock:
            if _sampled.get(engine) == fp or _synth_waiting:
                return False
            _sampled[engine] = fp
        os.makedirs(_dir(TEST_DIR), exist_ok=True)
        out = _dir(TEST_DIR, "%s-speed.wav" % engine)
        try:
            return _timed(engine, picked[0], picked[1], out) == OK
        except Exception as e:  # a sample is a courtesy: it never raises
            log.debug("Voices: %s speed sample failed: %s", engine, e)
            return False
        finally:
            if os.path.exists(out):
                os.remove(out)
    finally:
        _synth_lock.release()


def _sample_in_background(engine, lang):
    threading.Thread(target=_sample_speed, args=(engine, lang), daemon=True, name="voice-sample").start()


def _load_key(req):
    """What a request makes a worker load: the same key, nothing new."""
    return json.dumps(req, sort_keys=True)


def _cached(path):
    try:
        with open(path, "rb") as f:
            body = f.read()
        os.utime(path)  # recently said: kept longest
        return body
    except OSError:
        return None


def _trim_cache(limit=None):
    """Oldest-said first, until the cache is under its cap."""
    limit = CACHE_MAX_BYTES if limit is None else limit
    files = []
    for root, _dirs, names in os.walk(_dir("cache")):
        for n in names:
            p = os.path.join(root, n)
            try:
                st = os.stat(p)
            except OSError:
                continue
            files.append((st.st_mtime, st.st_size, p))
    total = sum(f[1] for f in files)
    for _mtime, size, p in sorted(files):
        if total <= limit:
            break
        try:
            os.remove(p)
            total -= size
        except OSError:
            pass


# ── downloaded voices: installed, fetched, removed ───────────────────────


def _read_manifest(engine):
    try:
        with open(os.path.join(_engine_dir(engine), MANIFEST), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _rec_files(rec):
    """A record's files: as written, or a Piper voice's two by its id."""
    files = rec.get("files")
    if isinstance(files, list) and files and all(isinstance(f, str) for f in files):
        return files
    return [rec["id"] + ".onnx", rec["id"] + ".onnx.json"]


def installed():
    """{tag: {"engine", "id", "revision", "bytes", "files", "voice"}} for the
    downloaded voices on disk, every engine's (one manifest per engine's
    folder). Kokoro's model is one record, KOKORO_TAG, whatever its manifest
    named it (Chinese's, before it said every language)."""
    out = {}
    for engine in DOWNLOADED:
        folder = _engine_dir(engine)
        for t, r in _read_manifest(engine).items():
            if engine == KOKORO and isinstance(r, dict):
                t, r = KOKORO_TAG, dict(r, voice=None)
            if not (isinstance(r, dict) and isinstance(r.get("id"), str)):
                continue
            # The model itself must be here; a config alone says nothing.
            if not all(
                os.path.isfile(os.path.join(folder, f))
                for f in _rec_files(r)
                if not f.endswith(".json")
            ):
                continue
            out[t] = dict(r, engine=engine)
    return out


def _set_installed(engine, tag, rec):
    """Write one tag's record into its engine's manifest (None takes it out)."""
    from zimi import server as _srv

    # Kokoro's folder holds one model: its record replaces whatever was there.
    data = {} if engine == KOKORO else _read_manifest(engine)
    if rec is None:
        data.pop(tag, None)
    else:
        data[tag] = rec
    os.makedirs(_engine_dir(engine), exist_ok=True)
    done = _srv._atomic_write_json(os.path.join(_engine_dir(engine), MANIFEST), data)
    _forget_fingerprint()  # Kokoro's model is part of it
    return done


_KOKORO_PRIMARIES = {_primary(t) for t in KOKORO_LANGS}


def _pin_langs(tag):
    """The languages a pinned download says: Kokoro's every one."""
    return sorted(_KOKORO_PRIMARIES) if tag == KOKORO_TAG else [_primary(tag)]


def _offer_tag(lang, accent=""):
    """The pinned download for a language: Kokoro for its languages, else
    Piper's voice (its accent's, where there is one)."""
    primary = _primary(lang)
    if primary in _KOKORO_PRIMARIES:
        return KOKORO_TAG
    region = (accent or "").upper()
    if region and primary + "-" + region in VOICES:
        return primary + "-" + region
    if primary in VOICES:
        return primary
    tags = [t for t in VOICES if _primary(t) == primary]
    return tags[0] if tags else None


def _bytes(tag):
    """A pinned download's size; ``tag`` may be the Pin itself."""
    pin = tag if isinstance(tag, Pin) else VOICES[tag]
    return sum(size for _name, _url, size in pin.files)


def _is_current(tag, rec):
    pin = VOICES[tag]
    return (
        rec["id"] == pin.id
        and rec.get("revision") == pin.revision
        and rec.get("voice") == pin.voice
    )


def can_download(tag=None):
    """Whether a voice may be fetched now: its engine is here to use it (any
    engine, with no tag), and the setting is not Never (ZIMI_OFFLINE is
    Never)."""
    engines = [VOICES[tag].engine] if tag else DOWNLOADED
    return any(_usable(e) for e in engines) and POLICY.mode()[0] != outbound.NEVER


def downloading():
    """The download in flight ({"tag", "done", "total"}), or the language
    whose last one failed ({"error": tag}). One being cancelled is already
    gone as far as anyone looking is concerned."""
    with _lock:
        return {} if _download.get("cancel") else dict(_download)


class _Cancelled(Exception):
    pass


def cancel_download():
    """Stop the download in flight; its partial files go and the language
    is as it was. False when nothing was downloading."""
    with _lock:
        if not _download.get("tag"):
            return False
        _download["cancel"] = True
    return True


def start_download(tag):
    """Fetch the pinned voice ``tag`` in the background. ``(ok, error)``:
    error is "unknown", "never" (the setting, or ZIMI_OFFLINE), "noengine"
    (nothing here could run it, or set it up), "installed" or "busy" (one at
    a time). An engine not here yet is set up first, in the same download."""
    if not isinstance(tag, str) or tag not in VOICES:
        return False, "unknown"
    if POLICY.mode()[0] == outbound.NEVER:
        return False, "never"
    if not _usable(VOICES[tag].engine):
        return False, "noengine"
    rec = installed().get(tag)
    if rec and _is_current(tag, rec):
        return False, "installed"
    global _fetcher
    # A download just cancelled stops at its next chunk: Download again
    # right after Cancel waits for it rather than being refused.
    with _lock:
        stopping = _fetcher if _download.get("cancel") else None
    if stopping:
        stopping.join(FETCH_TIMEOUT_S)
    with _lock:
        if _download.get("tag"):
            return False, "busy"
        _download.clear()
        _download.update({"tag": tag, "done": 0, "total": _bytes(tag)})
        _fetcher = threading.Thread(
            target=_fetch_voice, args=(tag,), daemon=True, name="voice-fetch"
        )
        _fetcher.start()
    return True, None


def _maybe_fetch(lang, accent):
    """Automatically: a word said in a language with a pinned voice not yet
    here fetches it, for the next time; this time an engine already here
    says it."""
    if POLICY.mode()[0] != outbound.AUTO:
        return
    tag = _offer_tag(lang, accent)
    if tag and tag not in installed() and _usable(VOICES[tag].engine):
        start_download(tag)


def _fetch_file(url, dest, expect):
    from zimi import server as _srv
    from zimi.library import USER_AGENT

    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    got = 0
    # certifi's bundle: a frozen desktop build has no system certificates.
    with (
        urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S, context=_srv.SSL_CTX) as resp,
        open(dest, "wb") as f,
    ):
        while True:
            chunk = resp.read(FETCH_CHUNK)
            if not chunk:
                break
            got += len(chunk)
            if got > expect:
                raise ValueError("larger than the pinned voice")
            f.write(chunk)
            with _lock:
                if _download.get("cancel"):
                    raise _Cancelled()
                _download["done"] = _download.get("done", 0) + len(chunk)
    if got != expect:
        raise ValueError("not the pinned voice's size")


def _have_file(path, size):
    try:
        return os.path.getsize(path) == size
    except OSError:
        return False


def _fetch_voice(tag):
    pin = VOICES[tag]
    folder = _engine_dir(pin.engine)
    parts = []
    try:
        if not runtime(pin.engine):
            with _lock:
                _download["setup"] = True
            if not _set_up_engines():
                with _lock:
                    if _download.get("cancel"):  # stopped, not failed
                        raise _Cancelled()
                raise RuntimeError("the engines could not be installed")
            with _lock:
                if _download.get("cancel"):
                    raise _Cancelled()
                _download.pop("setup", None)
        os.makedirs(folder, exist_ok=True)
        for name, url, size in pin.files:
            final = os.path.join(folder, name)
            if _have_file(final, size):  # a model another language shares
                with _lock:
                    _download["done"] = _download.get("done", 0) + size
                continue
            part = final + ".part"
            parts.append((part, final))
            _fetch_file(url, part, size)
        for part, final in parts:
            os.replace(part, final)
        old = installed().get(tag)
        _set_installed(
            pin.engine,
            tag,
            {
                "id": pin.id,
                "revision": pin.revision,
                "bytes": _bytes(tag),
                "files": [name for name, _url, _size in pin.files],
                "voice": pin.voice,
            },
        )
        if old and not _is_current(tag, old):
            _stop_workers((pin.engine,))
            _delete_voice_files(old)
        log.info("Voices: %s (%s) installed", tag, pin.id)
        with _lock:
            _download.clear()
    except _Cancelled:
        log.info("Voices: %s cancelled", tag)
        with _lock:
            _download.clear()
    except Exception as e:
        log.warning("Voices: could not fetch %s: %s", pin.id, e)
        with _lock:
            _download.clear()
            _download.update({"tag": None, "error": tag})
    finally:
        for part, _final in parts:
            if os.path.exists(part):
                os.remove(part)


def _drop_audio(engine, rec):
    """A downloaded voice's said words: its folder, and every speaker's
    within the model (Kokoro)."""
    name = os.path.basename(_cache_dir(engine, rec["id"]))
    try:
        folders = os.listdir(_dir("cache"))
    except OSError:
        return
    for f in folders:
        if f == name or f.startswith(name + "-"):
            shutil.rmtree(_dir("cache", f), ignore_errors=True)


def _delete_voice_files(rec):
    """A downloaded voice's files and its audio. A file another installed
    voice still uses stays."""
    engine = rec.get("engine", PIPER)
    _drop_audio(engine, rec)
    still = {
        f for r in installed().values() if r["engine"] == engine for f in _rec_files(r)
    }
    for name in _rec_files(rec):
        p = os.path.join(_engine_dir(engine), name)
        if name not in still and os.path.exists(p):
            os.remove(p)


def remove(tag):
    """Take a downloaded voice away, and its audio with it. The language
    falls back at once to the next engine. False when it was not installed."""
    rec = installed().get(tag) if isinstance(tag, str) else None
    if not rec:
        return False
    _set_installed(rec["engine"], tag, None)
    _stop_workers((rec["engine"],))  # its memory back, and nothing stale
    _delete_voice_files(rec)
    log.info("Voices: %s (%s) removed", tag, rec["id"])
    return True


# ── what the pages see ────────────────────────────────────────────────────


def page_payload():
    """For the Dictionary, fetched once: what the server can say, and the
    clearer voices it could fetch for a language that has none yet."""
    mode, locked = POLICY.mode()
    have = installed()
    langs = can_say()
    offers = {}
    for tag, pin in VOICES.items():
        # can_download(tag), the setting read once rather than per voice.
        if tag in have or mode == outbound.NEVER or not _usable(pin.engine):
            continue
        for lang in _pin_langs(tag):
            # A language a downloaded voice already says needs nothing more:
            # which one says it is Manage's choice, not the Dictionary's.
            if (langs.get(lang) or {}).get("engine") not in DOWNLOADED:
                # The engines first where they are not here: one figure.
                offers.setdefault(lang, {"tag": tag, "bytes": _bytes(tag) + setup_bytes(pin.engine)})
    return {
        "langs": langs,
        # Which voices are here, in the address of every word's audio: a
        # voice downloaded or removed is a new address, never the browser's
        # copy of the word in the old voice (Eric, 2026-10-03: English
        # downloaded "but it's still robotic"). Kokoro's carries its
        # speakers, so a new speaker for a language is a new address too.
        "stamp": _stamp(have),
        "offers": offers,
        "downloading": downloading(),
        "mode": mode,
        "locked": locked,
        "timings": timings(),
        "testing": testing(),
    }


def _stamp(have):
    """The voices here and the choices made, as a word's audio address
    carries them: either changing is a new address."""
    parts = sorted(_stamp_part(t, r) for t, r in have.items())
    parts += sorted("%s=%s" % kv for kv in choices().items())
    return "-".join(parts) or "none"


def _stamp_part(tag, rec):
    part = "%s.%s" % (tag, rec["id"])
    if tag == KOKORO_TAG:
        speakers = ",".join(s for s, _code in KOKORO_LANGS.values())
        part += "." + hashlib.sha1(speakers.encode("utf-8")).hexdigest()[:8]
    return part


def _manage_row(tag, rec):
    pin = VOICES[tag]
    if tag == KOKORO_TAG:
        engine = KOKORO if rec and runtime(KOKORO) else None
    else:
        picked = choose(tag)
        engine = picked[0] if picked else None
    row = {
        "tag": tag,
        "voice": pin.id,
        "kind": pin.engine,
        "bytes": rec.get("bytes", _bytes(pin)) if rec else _bytes(pin) + setup_bytes(pin.engine),
        "license": pin.license,
        "credit": pin.credit,
        "credit_required": needs_credit(pin.license),
        "runnable": _usable(pin.engine),
        "installed": bool(rec),
        "newer": bool(rec) and not _is_current(tag, rec),
        "engine": engine,
    }
    if tag == KOKORO_TAG:
        row["langs"] = list(KOKORO_LANGS)
    return row


def _piper_tags(primary):
    """The pinned Piper voices for a language, its home region's first."""
    tags = [t for t in VOICES if t != KOKORO_TAG and _primary(t) == primary]
    home = primary + "-" + _HOME_REGION.get(primary, primary.upper())
    return sorted(tags, key=lambda t: t not in (primary, home))


def _lang_row(primary, have, chosen, fetch_ok):
    """One language in Settings > Languages: the engines here that
    say it (best first) and the one that does; the Piper voice it could
    fetch ("piper": tag, bytes, newer) and the one it could remove."""
    options = engines_for(primary)
    picked = choose(primary)
    tags = _piper_tags(primary)
    here = [t for t in tags if t in have]
    offer = None
    if fetch_ok:
        stale = [t for t in here if not _is_current(t, have[t])]
        want = stale or ([] if here else tags)
        if want:
            offer = {"tag": want[0], "bytes": _bytes(want[0]) + setup_bytes(PIPER), "newer": bool(stale)}
    return {
        "lang": primary,
        "engines": options,
        "engine": picked[0] if picked else None,
        "chosen": chosen.get(primary) if chosen.get(primary) in options else None,
        "pinned": bool(tags) or primary in _KOKORO_PRIMARIES,
        "piper": offer,
        "remove": here[0] if here else None,
    }


def manage_payload():
    """For Settings > Languages and Voices: the setting, and every pinned
    voice with its licence and credit, whether its engine is here, and what
    speaks its language now (piper, kokoro, say or espeak, or none). Kokoro
    is one row, "langs" its languages. "langs": every language a pinned
    voice or an engine here says, one row each (_lang_row)."""
    have = installed()
    rows = [_manage_row(t, have.get(t)) for t in VOICES]
    chosen = choices()
    fetch_ok = _usable(PIPER) and POLICY.mode()[0] != outbound.NEVER
    primaries = {_primary(t) for t in VOICES if t != KOKORO_TAG}
    primaries |= _KOKORO_PRIMARIES | set(can_say())
    langs = [_lang_row(p, have, chosen, fetch_ok) for p in sorted(primaries)]
    return {
        "setting": POLICY.setting(),
        "piper": bool(piper_command()),
        "kokoro": bool(kokoro_command()),
        "versions": versions(),
        "voices": rows,
        "langs": langs,
        "downloading": downloading(),
        "timings": timings(),
        "testing": testing(),
    }
