"""Say: a word spoken by the server, as audio the page plays.

Eric, 2026-10-03: "It's worth getting dictionary right if it's the new app."
A browser's speechSynthesis is not media on an iPhone, so the ring switch
mutes it, and every device has its own voices or none. A WAV played by an
<audio> element is media: it plays on silent and sounds the same everywhere.

Three engines, each a separate program run as a child (never imported, so
GPL code stays beside MIT Zimi the way ffmpeg does), in this order:

1. Piper (piper-tts), when a voice for the language is installed. Natural
   speech, and Eric's first choice: "If it sounds clearer and is more
   accurate that might be better than letting the system do whatever."
2. macOS ``say``, on a Mac.
3. espeak-ng, when installed. Robotic, and there with no download at all.

An accent asks first for an engine with that region's voice, then for any
voice of the language. None that can say it: no audio, and the page uses the
device's own voice.

Piper voices are a download (about 60 MB each), one per language, chosen by
someone in the Dictionary or in Manage, under "Voices for Dictionary": Ask
first, Automatically (a voice is fetched when a word in its language is
said), Never. ZIMI_OFFLINE forbids it. The voices are pinned per Zimi
release in ``PIPER_VOICES``; nothing updates on its own.
"""

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

PIPER, SAY, ESPEAK = "piper", "say", "espeak"
ENGINES = (PIPER, SAY, ESPEAK)

# The pinned voices: rhasspy/piper-voices at one tag, one voice per
# language (accents where Piper has them), medium quality, each under a
# license that lets anyone download and use it (CC0, public domain, CC BY,
# CC BY-SA, Unlicense; non-commercial and unknown licenses are left out).
# tag -> (voice id, .onnx bytes, .onnx.json bytes, license). A newer pin is
# a one-line change here; Manage then offers "Newer voice", and nothing
# downloads on its own.
PIPER_REVISION = "v1.0.0"
PIPER_BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/"
PIPER_VOICES = {
    "ca": ("ca_ES-upc_ona-medium", 63201294, 4875, "CC BY-SA 3.0"),
    "cs": ("cs_CZ-jirka-medium", 63201294, 5025, "CC0"),
    "da": ("da_DK-talesyntese-medium", 63201294, 4878, "CC0"),
    "de": ("de_DE-thorsten-medium", 63201294, 4819, "CC0"),
    "en-US": ("en_US-ljspeech-medium", 63531379, 4972, "public domain"),
    "en-GB": ("en_GB-cori-medium", 63531379, 4966, "public domain"),
    "es-ES": ("es_ES-davefx-medium", 63201294, 4817, "CC0"),
    "es-MX": ("es_MX-ald-medium", 63201294, 4889, "Unlicense"),
    "fa": ("fa_IR-amir-medium", 63531379, 4958, "CC0"),
    "fi": ("fi_FI-harri-medium", 63201294, 4873, "CC0"),
    "fr": ("fr_FR-siwis-medium", 63201294, 4875, "CC BY 4.0"),
    "hu": ("hu_HU-anna-medium", 63201294, 5018, "CC0"),
    "lv": ("lv_LV-aivars-medium", 63511038, 7242, "CC0"),
    "nb": ("no_NO-talesyntese-medium", 63201294, 4880, "CC0"),
    "ne": ("ne_NP-chitwan-medium", 62950044, 5043, "CC0"),
    "nl": ("nl_NL-pim-medium", 63516050, 5037, "CC0"),
    "pl": ("pl_PL-gosia-medium", 63201294, 4814, "CC0"),
    "pt-BR": ("pt_BR-faber-medium", 63201294, 4855, "CC0"),
    "pt-PT": ("pt_PT-tugão-medium", 63201294, 5026, "CC0"),
    "ro": ("ro_RO-mihai-medium", 63201294, 4877, "CC0"),
    "ru": ("ru_RU-denis-medium", 63201294, 4823, "CC0"),
    "sk": ("sk_SK-lili-medium", 63201294, 4963, "CC0"),
    "sl": ("sl_SI-artur-medium", 63200492, 4970, "CC BY 4.0"),
    "sv": ("sv_SE-nst-medium", 63104526, 4157, "CC0"),
    "tr": ("tr_TR-fahrettin-medium", 63201294, 5022, "CC0"),
    "uk": ("uk_UA-ukrainian_tts-medium", 76735663, 2002, "CC0"),
    "vi": ("vi_VN-vais1000-medium", 63201294, 4860, "CC BY 4.0"),
}

# The setting: Ask first / Automatically / Never (outbound.py).
DOWNLOADS_ENV = "ZIMI_VOICE_DOWNLOADS"
PREFS_KEY = "voice_downloads"
POLICY = outbound.FetchPolicy(
    DOWNLOADS_ENV, PREFS_KEY, outbound.ASK, "Voices for Dictionary"
)

# A word or a short phrase, never a paragraph: what the Dictionary says.
TEXT_MAX = 64
SYNTH_TIMEOUT_S = 20  # Piper loads its model each time: about a second
SYNTH_WAIT_S = 30  # how long a request queues behind another synthesis
CACHE_MAX_BYTES = 64 * 1024 * 1024  # a word is ~40 KB: well over a thousand
FETCH_TIMEOUT_S = 30
FETCH_CHUNK = 256 * 1024
WAV_HEADER_BYTES = 44
SAY_FORMAT = ("--file-format=WAVE", "--data-format=LEI16@22050")
PIPER_CMD_ENV = "ZIMI_PIPER"  # a piper command to use instead of finding one

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


def _piper_dir():
    return _dir(PIPER)


def _cache_dir(engine, voice):
    return _dir("cache", engine + "-" + _UNSAFE_RE.sub("_", voice))


def _voice_url(voice_id, suffix):
    family = voice_id.split("_", 1)[0]
    locale, name, quality = voice_id.split("-", 2)
    path = "/".join((family, locale, name, quality, voice_id + suffix))
    return PIPER_BASE_URL + PIPER_REVISION + "/" + urllib.parse.quote(path)


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


def piper_command():
    """How to run Piper, or None: ZIMI_PIPER, a ``piper`` on PATH, or
    piper-tts in Zimi's own Python, run as ``python -m piper``."""

    def find():
        named = os.environ.get(PIPER_CMD_ENV, "").strip()
        if named:
            return [named] if shutil.which(named) else None
        on_path = shutil.which("piper")
        if on_path:
            return [on_path]
        try:
            if importlib.util.find_spec("piper") is not None:
                return [sys.executable, "-m", "piper"]
        except (ImportError, ValueError):
            pass
        return None

    return _memo("piper", find)


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


def _piper_voices():
    """Installed Piper voices Piper can run: {primary: {region: tag}}."""
    if not piper_command():
        return {}
    out = {}
    for tag, rec in installed().items():
        out.setdefault(_primary(tag), {})[_region_of(rec["id"])] = tag
    return out


def _voices(engine):
    return {PIPER: _piper_voices, SAY: _say_voices, ESPEAK: _espeak_voices}[engine]()


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
    if engine == SAY:
        return ["say", "-v", voice, "-f", "-", "-o", out] + list(SAY_FORMAT)
    return [shutil.which("espeak-ng") or "espeak-ng", "-v", voice, "-w", out, "--stdin"]


def _cache_voice(engine, voice):
    """The cache's name for a voice: a Piper voice by its id, so a newer
    voice for the same language never answers with the old one's audio."""
    if engine == PIPER:
        return installed().get(voice, {}).get("id", voice)
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
            if not _run(_command(engine, voice, tmp), text, tmp):
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


# ── Piper voices: installed, downloaded, removed ─────────────────────────


def installed():
    """{tag: {"id", "revision", "bytes"}} for the Piper voices on disk."""
    try:
        with open(os.path.join(_piper_dir(), MANIFEST), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return {
        t: r
        for t, r in (data if isinstance(data, dict) else {}).items()
        if isinstance(r, dict)
        and isinstance(r.get("id"), str)
        and os.path.isfile(os.path.join(_piper_dir(), r["id"] + ".onnx"))
    }


def _write_installed(data):
    from zimi import server as _srv

    os.makedirs(_piper_dir(), exist_ok=True)
    return _srv._atomic_write_json(os.path.join(_piper_dir(), MANIFEST), data)


def _offer_tag(lang, accent=""):
    """The pinned voice for a language (its accent's, where there is one)."""
    primary = _primary(lang)
    region = (accent or "").upper()
    if region and primary + "-" + region in PIPER_VOICES:
        return primary + "-" + region
    if primary in PIPER_VOICES:
        return primary
    tags = [t for t in PIPER_VOICES if _primary(t) == primary]
    return tags[0] if tags else None


def _bytes(tag):
    _vid, onnx, cfg, _lic = PIPER_VOICES[tag]
    return onnx + cfg


def can_download():
    """Whether a voice may be fetched now: Piper is here to use it, and the
    setting is not Never (ZIMI_OFFLINE is Never)."""
    return bool(piper_command()) and POLICY.mode()[0] != outbound.NEVER


def downloading():
    with _lock:
        return dict(_download)


def start_download(tag):
    """Fetch the pinned voice ``tag`` in the background. ``(ok, error)``:
    error is "unknown", "never" (the setting, or ZIMI_OFFLINE), "nopiper",
    "installed" or "busy" (one voice at a time)."""
    if tag not in PIPER_VOICES:
        return False, "unknown"
    if POLICY.mode()[0] == outbound.NEVER:
        return False, "never"
    if not piper_command():
        return False, "nopiper"
    rec = installed().get(tag)
    if (
        rec
        and rec["id"] == PIPER_VOICES[tag][0]
        and rec.get("revision") == PIPER_REVISION
    ):
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
    if tag and tag not in installed():
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
                _download["done"] = _download.get("done", 0) + len(chunk)
    if got != expect:
        raise ValueError("not the pinned voice's size")


def _fetch_voice(tag):
    vid, onnx_bytes, cfg_bytes, _lic = PIPER_VOICES[tag]
    folder = _piper_dir()
    parts = []
    try:
        os.makedirs(folder, exist_ok=True)
        for suffix, size in ((".onnx.json", cfg_bytes), (".onnx", onnx_bytes)):
            part = os.path.join(folder, vid + suffix + ".part")
            parts.append((part, os.path.join(folder, vid + suffix)))
            _fetch_file(_voice_url(vid, suffix), part, size)
        for part, final in parts:
            os.replace(part, final)
        old = installed().get(tag)
        data = installed()
        data[tag] = {
            "id": vid,
            "revision": PIPER_REVISION,
            "bytes": onnx_bytes + cfg_bytes,
        }
        _write_installed(data)
        if old and old["id"] != vid:
            _delete_voice_files(old["id"])
        log.info("Voices: %s (%s) installed", tag, vid)
        with _lock:
            _download.clear()
    except Exception as e:
        log.warning("Voices: could not fetch %s: %s", vid, e)
        with _lock:
            _download.clear()
            _download.update({"tag": None, "error": tag})
    finally:
        for part, _final in parts:
            if os.path.exists(part):
                os.remove(part)


def _delete_voice_files(vid):
    for suffix in (".onnx", ".onnx.json"):
        p = os.path.join(_piper_dir(), vid + suffix)
        if os.path.exists(p):
            os.remove(p)
    shutil.rmtree(_cache_dir(PIPER, vid), ignore_errors=True)


def remove(tag):
    """Take a Piper voice away, and its audio with it. The language falls
    back at once to the next engine. False when it was not installed."""
    data = installed()
    rec = data.pop(tag, None)
    if not rec:
        return False
    _write_installed(data)
    _delete_voice_files(rec["id"])
    log.info("Voices: %s (%s) removed", tag, rec["id"])
    return True


# ── what the pages see ────────────────────────────────────────────────────


def page_payload():
    """For the Dictionary, fetched once: what the server can say, and the
    clearer voices it could fetch for a language that has none yet."""
    mode, locked = POLICY.mode()
    have = installed()
    offers = {}
    if can_download():
        for tag in PIPER_VOICES:
            if tag not in have:
                offers.setdefault(_primary(tag), {"tag": tag, "bytes": _bytes(tag)})
    return {
        "langs": can_say(),
        "offers": offers,
        "downloading": downloading(),
        "mode": mode,
        "locked": locked,
    }


def manage_payload():
    """For Manage: the setting, and every pinned voice with what speaks its
    language now (piper, say or espeak, or none)."""
    have = installed()
    rows = []
    for tag, (vid, _onnx, _cfg, lic) in PIPER_VOICES.items():
        rec = have.get(tag)
        picked = choose(tag)
        rows.append(
            {
                "tag": tag,
                "voice": vid,
                "bytes": rec.get("bytes", _bytes(tag)) if rec else _bytes(tag),
                "license": lic,
                "installed": bool(rec),
                "newer": bool(rec)
                and (rec["id"] != vid or rec.get("revision") != PIPER_REVISION),
                "engine": picked[0] if picked else None,
            }
        )
    return {
        "setting": POLICY.setting(),
        "piper": bool(piper_command()),
        "revision": PIPER_REVISION,
        "voices": rows,
        "downloading": downloading(),
    }
