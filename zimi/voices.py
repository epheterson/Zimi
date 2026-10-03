"""Say: a word spoken by the server, as audio the page plays.

Eric, 2026-10-03: "It's worth getting dictionary right if it's the new app."
A browser's speechSynthesis is not media on an iPhone, so the ring switch
mutes it, and every device has its own voices or none. A WAV played by an
<audio> element is media: it plays on silent and sounds the same everywhere.

Four engines, each a separate program run as a child (never imported, so
GPL code stays beside MIT Zimi the way ffmpeg does), in this order:

1. Piper (piper-tts), when a voice for the language is installed. Natural
   speech, and Eric's first choice: "If it sounds clearer and is more
   accurate that might be better than letting the system do whatever."
2. Kokoro (kokoro-onnx, with misaki's own Chinese phonemes), for Chinese,
   where no Piper voice has a licence that allows it. Eric: "Add Kokoro for
   Chinese".
3. macOS ``say``, on a Mac.
4. espeak-ng, when installed. Robotic, and there with no download at all.

Piper and Kokoro run through voicehelper.py: ``python voicehelper.py`` where
they are installed in Zimi's Python (Docker, pip), or the ``zimi-voice``
executable the desktop apps carry beside Zimi.

An accent asks first for an engine with that region's voice, then for any
voice of the language. None that can say it: no audio, and the page uses the
device's own voice.

Piper voices (about 60 MB each) and the Kokoro model (about 120 MB) are a
download, one language at a time, chosen by someone in the Dictionary or in
Manage, under "Voices for Dictionary": Ask first, Automatically (a voice is
fetched when a word in its language is said), Never. ZIMI_OFFLINE forbids
it. Every voice is pinned per Zimi release in ``VOICES``, with its licence
and credit; nothing updates on its own.
"""

import collections
import hashlib
import importlib.util
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.parse
import urllib.request

from zimi import outbound, subproc

log = logging.getLogger("zimi")

PIPER, KOKORO, SAY, ESPEAK = "piper", "kokoro", "say", "espeak"
ENGINES = (PIPER, KOKORO, SAY, ESPEAK)
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


def _kokoro(voice):
    files = tuple(
        (name, KOKORO_BASE_URL + KOKORO_REVISION + "/" + name, size)
        for name, size in KOKORO_SIZES.items()
    )
    return Pin(
        KOKORO,
        KOKORO_ID,
        voice,
        KOKORO_REVISION,
        files,
        "Apache-2.0",
        "Kokoro-82M by hexgrad",
    )


# fmt: off
VOICES = {
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
    "zh": _kokoro("zf_xiaoxiao"),
}
# fmt: on

# Voices left out on purpose, so a later pin does not bring one back: a
# licence that forbids commercial use, or none stated. Arabic has no clean
# voice yet and keeps the basic one. Japanese on Kokoro would need misaki's
# MeCab dictionary, a download of its own, so it is not offered yet.
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

# A word or a short phrase, never a paragraph: what the Dictionary says.
TEXT_MAX = 64
SYNTH_TIMEOUT_S = 20  # Piper loads its model each time: about a second
# Kokoro loads its model and a Chinese dictionary each time: about 5 s on a
# laptop (measured 2026-10-03), so a slow NAS is given longer.
KOKORO_TIMEOUT_S = 60
SYNTH_WAIT_S = 30  # how long a request queues behind another synthesis
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
    KOKORO: ("kokoro_onnx", "misaki", "jieba", "pypinyin", "cn2an"),
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
_found = {}
_download = {}


def _reset_for_tests():
    with _lock:
        _found.clear()
        _download.clear()


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
    """How to run Piper, or None: ZIMI_PIPER, a ``piper`` on PATH, the desktop
    app's helper, or piper-tts in Zimi's own Python."""

    def find():
        named = os.environ.get(PIPER_CMD_ENV, "").strip()
        if named:
            return [named] if shutil.which(named) else None
        on_path = shutil.which("piper")
        if on_path:
            return [on_path]
        return _runner(PIPER)

    return _memo(PIPER, find)


def kokoro_command():
    """How to run Kokoro, or None: the desktop app's helper, or kokoro-onnx
    and misaki's Chinese in Zimi's own Python."""
    return _memo(KOKORO, lambda: _runner(KOKORO))


def runtime(engine):
    """The command for a downloaded voice's engine, or None."""
    return {PIPER: piper_command, KOKORO: kokoro_command}[engine]()


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


def _downloaded_voices(engine):
    """Installed voices of ``engine`` it can run: {primary: {region: tag}}.
    A Piper voice's region is in its id; Kokoro's is the language's home."""
    if not runtime(engine):
        return {}
    out = {}
    for tag, rec in installed().items():
        if rec["engine"] != engine:
            continue
        primary = _primary(tag)
        region = (
            _region_of(rec["id"]) if engine == PIPER else _HOME_REGION.get(primary, "")
        )
        out.setdefault(primary, {})[region] = tag
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


def choose(lang, accent=""):
    """``(engine, voice)`` to say ``lang`` with, or None. An accent's region
    asks first for an engine with that region's voice, then any voice of the
    language, Piper before ``say`` before espeak-ng."""
    primary = _primary(lang)
    region = (accent or (lang.split("-", 1)[1] if "-" in lang else "")).upper()
    tables = [(e, _voices(e).get(primary) or {}) for e in ENGINES]
    if region:
        for engine, by_region in tables:
            if region in by_region:
                return engine, by_region[region]
    for engine, by_region in tables:
        if by_region:
            return engine, by_region[_home_first(primary, by_region)[0]]
    return None


def can_say():
    """What the server can say: {primary: {"engine", "regions"}}, the engine
    a plain Say would use and every region some engine has a voice for."""
    out = {}
    for engine in ENGINES:
        for primary, by_region in _voices(engine).items():
            row = out.setdefault(primary, {"engine": engine, "regions": []})
            for r in by_region:
                if r and r not in row["regions"]:
                    row["regions"].append(r)
    for row in out.values():
        row["regions"].sort()
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


def _command(engine, voice, out):
    if engine == PIPER:
        rec = installed().get(voice)
        onnx = os.path.join(_piper_dir(), rec["id"] + ".onnx")
        return piper_command() + ["-m", onnx, "-f", out]
    if engine == KOKORO:
        rec = installed().get(voice)
        folder = _engine_dir(KOKORO)
        return kokoro_command() + [
            "--model", os.path.join(folder, KOKORO_MODEL),
            "--voices", os.path.join(folder, KOKORO_VOICES),
            "--voice", rec["voice"],
            "--lang", _primary(voice),
            "-f", out,
        ]  # fmt: skip
    if engine == SAY:
        return ["say", "-v", voice, "-f", "-", "-o", out] + list(SAY_FORMAT)
    return [shutil.which("espeak-ng") or "espeak-ng", "-v", voice, "-w", out, "--stdin"]


def _cache_key(rec):
    """A downloaded voice's audio folder name: its model id, and the voice
    within the model where there is one (Kokoro)."""
    return rec["id"] + ("-" + rec["voice"] if rec.get("voice") else "")


def _cache_voice(engine, voice):
    """The cache's name for a voice: a downloaded one by its model, so a
    newer voice for the same language never answers with the old one's audio."""
    if engine in DOWNLOADED:
        rec = installed().get(voice)
        return _cache_key(rec) if rec else voice
    return voice


def speak(text, lang, accent=""):
    """WAV bytes of ``text`` said in ``lang``, or None when no engine can
    say it (or every engine that could failed). Cached by engine, voice and
    text; one synthesis at a time."""
    text = clean_text(text)
    if text is None or not valid_lang(lang, accent):
        return None
    _maybe_fetch(lang, accent)
    picked = choose(lang, accent)
    if not picked:
        return None
    engine, voice = picked
    folder = _cache_dir(engine, _cache_voice(engine, voice))
    path = os.path.join(folder, hashlib.sha1(text.encode("utf-8")).hexdigest() + ".wav")
    got = _cached(path)
    if got is not None:
        return got
    if not _synth_lock.acquire(timeout=SYNTH_WAIT_S):
        return None
    try:
        got = _cached(path)  # another request may have said it while we waited
        if got is not None:
            return got
        os.makedirs(folder, exist_ok=True)
        tmp = path + ".part"
        try:
            wait = KOKORO_TIMEOUT_S if engine == KOKORO else SYNTH_TIMEOUT_S
            if not _run(_command(engine, voice, tmp), text, tmp, timeout=wait):
                return None
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    finally:
        _synth_lock.release()
    _trim_cache()
    return _cached(path)


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
    folder)."""
    out = {}
    for engine in DOWNLOADED:
        folder = _engine_dir(engine)
        for t, r in _read_manifest(engine).items():
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

    data = _read_manifest(engine)
    if rec is None:
        data.pop(tag, None)
    else:
        data[tag] = rec
    os.makedirs(_engine_dir(engine), exist_ok=True)
    return _srv._atomic_write_json(os.path.join(_engine_dir(engine), MANIFEST), data)


def _offer_tag(lang, accent=""):
    """The pinned voice for a language (its accent's, where there is one)."""
    primary = _primary(lang)
    region = (accent or "").upper()
    if region and primary + "-" + region in VOICES:
        return primary + "-" + region
    if primary in VOICES:
        return primary
    tags = [t for t in VOICES if _primary(t) == primary]
    return tags[0] if tags else None


def _bytes(tag):
    return sum(size for _name, _url, size in VOICES[tag].files)


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
    with _lock:
        if _download.get("tag"):
            return False, "busy"
        _download.clear()
        _download.update({"tag": tag, "done": 0, "total": _bytes(tag)})
    threading.Thread(
        target=_fetch_voice, args=(tag,), daemon=True, name="voice-fetch"
    ).start()
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


def _delete_voice_files(rec):
    """A downloaded voice's files and its audio. A file another installed
    voice still uses (one Kokoro model, many languages) stays."""
    engine = rec.get("engine", PIPER)
    shutil.rmtree(_cache_dir(engine, _cache_key(rec)), ignore_errors=True)
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
    _delete_voice_files(rec)
    log.info("Voices: %s (%s) removed", tag, rec["id"])
    return True


# ── what the pages see ────────────────────────────────────────────────────


def page_payload():
    """For the Dictionary, fetched once: what the server can say, and the
    clearer voices it could fetch for a language that has none yet."""
    mode, locked = POLICY.mode()
    have = installed()
    offers = {}
    for tag in VOICES:
        if tag not in have and can_download(tag):
            offers.setdefault(_primary(tag), {"tag": tag, "bytes": _bytes(tag)})
    return {
        "langs": can_say(),
        "offers": offers,
        "downloading": downloading(),
        "mode": mode,
        "locked": locked,
    }


def manage_payload():
    """For Manage: the setting, and every pinned voice with its licence and
    credit, whether its engine is here, and what speaks its language now
    (piper, kokoro, say or espeak, or none)."""
    have = installed()
    rows = []
    for tag, pin in VOICES.items():
        rec = have.get(tag)
        picked = choose(tag)
        rows.append(
            {
                "tag": tag,
                "voice": pin.id + ("/" + pin.voice if pin.voice else ""),
                "kind": pin.engine,
                "bytes": rec.get("bytes", _bytes(tag)) if rec else _bytes(tag),
                "license": pin.license,
                "credit": pin.credit,
                "credit_required": needs_credit(pin.license),
                "runnable": bool(runtime(pin.engine)),
                "installed": bool(rec),
                "newer": bool(rec) and not _is_current(tag, rec),
                "engine": picked[0] if picked else None,
            }
        )
    return {
        "setting": POLICY.setting(),
        "piper": bool(piper_command()),
        "kokoro": bool(kokoro_command()),
        "voices": rows,
        "downloading": downloading(),
    }
