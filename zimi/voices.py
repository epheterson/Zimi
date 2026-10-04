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
they are installed in Zimi's Python (Docker, pip), or the ``zimi-voice``
executable the desktop apps carry beside Zimi. Each runs as a warm worker
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
SAY_FORMAT = ("--file-format=WAVE", "--data-format=LEI16@22050")
PIPER_CMD_ENV = "ZIMI_PIPER"  # a piper command to use instead of finding one
HELPER_NAME = "zimi-voice"  # the desktop builds' engines, beside Zimi
HELPER_SCRIPT = "voicehelper.py"  # the same, run by Zimi's Python
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
# espeak-ng's own codes for languages the page names by region.
_ESPEAK_REGIONS = {"cmn": ("zh", "CN"), "yue": ("zh", "HK")}
# The region a language is said in when no accent asks for another.
_HOME_REGION = {"en": "US", "pt": "BR", "zh": "CN", "nb": "NO", "sv": "SE", "da": "DK"}

_lock = threading.Lock()  # the engine discovery memo and the download state
_synth_lock = threading.Lock()  # one synthesis at a time
_synth_slots = threading.BoundedSemaphore(1 + SYNTH_QUEUE)  # said or waiting
_found = {}
_download = {}
_fetcher = None  # the thread fetching a voice, while one is
_choices = None  # CHOICES_KEY as last read or written: no file read per word


def _reset_for_tests():
    global _choices
    _stop_workers()
    with _lock:
        _found.clear()
        _download.clear()
        _failures.clear()
        _choices = None


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


def _runner(engine):
    """voicehelper.py's command for ``engine``: the bundled helper, or the
    script itself run by Zimi's Python where the engine is installed."""
    helper = helper_command()
    if helper:
        return helper + [engine]
    if _has_modules(*_ENGINE_MODULES[engine]):
        return [
            sys.executable,
            os.path.join(os.path.dirname(__file__), HELPER_SCRIPT),
            engine,
        ]
    return None


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


def clean_text(text):
    """The text as an engine gets it, or None: one line, no control
    characters, at most TEXT_MAX characters."""
    text = str(text or "")
    if _CONTROL_RE.search(text.replace("\t", " ").replace("\n", " ")):
        return None
    text = _SPACES_RE.sub(" ", text).strip()
    if not text or len(text) > TEXT_MAX:
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


def speak(text, lang, accent="", engine=None):
    """WAV bytes of ``text`` said in ``lang``, or None when no engine can
    say it. ``engine``: that engine or none. Raises Busy when one can but
    did not get to it, Failed when it tried and could not. Cached by engine,
    voice and text; one synthesis at a time, SYNTH_QUEUE more waiting."""
    if clean_text(text) is None or not valid_lang(lang, accent):
        return None
    if engine is not None and engine not in ENGINES:
        return None
    _maybe_fetch(lang, accent)
    where = _audio(text, lang, accent, engine)
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
        if not _synth_lock.acquire(timeout=SYNTH_WAIT_S):
            raise Busy("waited %ss" % SYNTH_WAIT_S)
        try:
            got = _cached(path)  # another request may have said it while we waited
            if got is not None:
                return got
            os.makedirs(folder, exist_ok=True)
            tmp = path + ".part"
            try:
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


def _audio(text, lang, accent="", engine=None):
    """(engine, voice, text, path): who says the word and where its audio
    is kept, or None when no engine here can say it."""
    text = clean_text(text)
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


def said(text, lang, accent="", engine=None):
    """None when no voice here says the word, else {"made": its audio is
    there, "failed": the engine could not say it last time}. Nothing is
    said or fetched: the page asks this after its audio failed. Missing,
    made (audio that would not play) or failed: the word is the device's.
    Neither: the voice was busy, and the next tap asks again."""
    where = _audio(text, lang, accent, engine)
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


def warm(langs):
    """Have the worker of the engine that says each language load it now,
    in the background, so the first word is not the slow one. Downloads
    nothing (no _maybe_fetch); a voice already loaded, or loading, is left
    alone. Returns the engines asked to load something."""
    started = []
    for lang in list(langs or [])[:WARM_LANGS_MAX]:
        if not isinstance(lang, str) or not valid_lang(lang):
            continue
        picked = choose(lang)
        if not picked or picked[0] not in DOWNLOADED:
            continue
        worker = _worker(picked[0])
        if worker is None:
            continue
        req = _request(*picked)
        key = _load_key(req)
        with _workers_lock:
            if key in worker.loaded or key in worker.warming:
                continue
            worker.warming.add(key)
        started.append(picked[0])
        threading.Thread(
            target=_warm_one, args=(worker, req, key), daemon=True, name="voice-warm"
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


def _warm_one(worker, req, key):
    timeout = KOKORO_TIMEOUT_S if worker.engine == KOKORO else SYNTH_TIMEOUT_S
    try:
        if worker.ask(req, timeout) == OK:
            worker.loaded.add(key)
    finally:
        with _workers_lock:
            worker.warming.discard(key)


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
    return _srv._atomic_write_json(os.path.join(_engine_dir(engine), MANIFEST), data)


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
    return any(runtime(e) for e in engines) and POLICY.mode()[0] != outbound.NEVER


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
    (nothing here could run it), "installed" or "busy" (one at a time)."""
    if not isinstance(tag, str) or tag not in VOICES:
        return False, "unknown"
    if POLICY.mode()[0] == outbound.NEVER:
        return False, "never"
    if not runtime(VOICES[tag].engine):
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
    if tag and tag not in installed() and runtime(VOICES[tag].engine):
        start_download(tag)


def _fetch_file(url, dest, expect):
    from zimi.library import USER_AGENT

    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    got = 0
    with (
        urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp,
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
        if tag in have or not can_download(tag):
            continue
        for lang in _pin_langs(tag):
            # A language a downloaded voice already says needs nothing more:
            # which one says it is Manage's choice, not the Dictionary's.
            if (langs.get(lang) or {}).get("engine") not in DOWNLOADED:
                offers.setdefault(lang, {"tag": tag, "bytes": _bytes(tag)})
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
        "bytes": rec.get("bytes", _bytes(pin)) if rec else _bytes(pin),
        "license": pin.license,
        "credit": pin.credit,
        "credit_required": needs_credit(pin.license),
        "runnable": bool(runtime(pin.engine)),
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
    """One language in the Dictionary's voices sheet: the engines here that
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
            offer = {"tag": want[0], "bytes": _bytes(want[0]), "newer": bool(stale)}
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
    """For the Dictionary's voices sheet: the setting, and every pinned
    voice with its licence and credit, whether its engine is here, and what
    speaks its language now (piper, kokoro, say or espeak, or none). Kokoro
    is one row, "langs" its languages. "langs": every language a pinned
    voice or an engine here says, one row each (_lang_row)."""
    have = installed()
    rows = [_manage_row(t, have.get(t)) for t in VOICES]
    chosen = choices()
    fetch_ok = bool(runtime(PIPER)) and POLICY.mode()[0] != outbound.NEVER
    primaries = {_primary(t) for t in VOICES if t != KOKORO_TAG}
    primaries |= _KOKORO_PRIMARIES | set(can_say())
    langs = [_lang_row(p, have, chosen, fetch_ok) for p in sorted(primaries)]
    return {
        "setting": POLICY.setting(),
        "piper": bool(piper_command()),
        "kokoro": bool(kokoro_command()),
        "voices": rows,
        "langs": langs,
        "downloading": downloading(),
    }
