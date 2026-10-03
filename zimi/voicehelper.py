"""zimi-voice: the speech engines the Dictionary's Say runs, as a program of
their own.

Zimi never imports a speech engine. Piper and espeak-ng are GPL-3 (Kokoro's
phonemizer loads espeak-ng too), so they run here, in a separate process,
beside MIT Zimi the way ffmpeg does. voices.py starts this as a child and
reads the WAV it writes.

    zimi-voice piper -m VOICE.onnx -f OUT.wav          (Piper's own arguments)
    zimi-voice kokoro --model M.onnx --voices V.bin --voice NAME --lang en-us -f OUT.wav
    zimi-voice serve kokoro|piper                      (warm, one request a line)

The first two say the word on stdin and leave. ``serve`` loads its engine
once and stays: on a NAS a word took 7 to 13 s when every one started the
engine afresh. Each stdin line is a JSON request, each stdout line its
answer, {"ok": true} or {"ok": false, "error": "..."}:

    {"model": M.onnx, "voices": V.bin, "voice": NAME, "lang": "en-us",
     "text": "water", "out": OUT.wav}                         (Kokoro)
    {"model": VOICE.onnx, "text": "water", "out": OUT.wav}    (Piper)

A request with no "text" only loads what it names (the Dictionary's warm-up).
The end of stdin ends it.

Run as ``python voicehelper.py ...`` where piper-tts and kokoro-onnx are
installed (Docker, pip), or as the ``zimi-voice`` executable the desktop
builds bundle beside Zimi. Self-contained on purpose: it imports nothing of
Zimi, so starting it never loads the server.
"""

import os
import sys

# Run as a script, Python puts this file's folder first on the path: Zimi's
# package, whose http.py would stand in for the standard library's http the
# moment an engine's dependency imports it.
if sys.path and os.path.abspath(sys.path[0] or ".") == os.path.dirname(
    os.path.abspath(__file__)
):
    del sys.path[0]

import argparse  # noqa: E402
import collections  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import types  # noqa: E402
import wave  # noqa: E402

PCM_MAX = 32767
SAMPLE_BYTES = 2  # 16-bit mono, what every other engine writes
ENGLISH = {"en-us": False, "en-gb": True}  # Kokoro's English codes: British?
# A word as misaki's lexicon looks it up: punctuation around it is not part of it.
_WORD_RE = re.compile(r"[^\s,;:!?()\[\]\"“”]+")
# Piper voices a worker keeps loaded, the least recently said let go first:
# each is about 60 MB on disk and more in memory.
PIPER_LOADED_MAX = 3
# What a warm-up says and throws away: an engine's first inference is slow.
WARM_TEXT = "a"


def piper(argv):
    """Piper's own command line, unchanged."""
    from piper.__main__ import main

    sys.argv = ["piper"] + argv
    main()


def _english(british):
    """English as Kokoro was trained to read it: misaki's lexicon (its gold
    and silver dictionaries, stems, numbers), espeak-ng only for a word it
    does not have. Plain espeak-ng phonemes were what made English "a lil
    off" (Eric, 2026-10-03). Returns text -> phonemes.

    Without misaki's spaCy tagger, 120 MB more for this helper: a dictionary
    says a word with no sentence around it to tag, and the lexicon's own
    reading of a lone word is the one a dictionary wants ("object" the
    noun). misaki.en imports spaCy for that tagger only, so a stand-in
    satisfies the import."""
    sys.modules.setdefault("spacy", types.ModuleType("spacy"))
    from misaki import en, espeak
    from misaki.token import MToken

    lexicon, fallback = en.Lexicon(british), espeak.EspeakFallback(british)

    def say(text):
        out = []
        for word in _WORD_RE.findall(text):
            tk = MToken(
                text=word,
                tag=None,
                whitespace="",
                _=MToken.Underscore(is_head=True, num_flags="", prespace=False),
            )
            ps, _rating = lexicon(tk, en.TokenContext())
            if ps is None:
                ps, _rating = fallback(tk)
            if ps:
                out.append(ps)
        # Kokoro v1.0 reads a flap as T and a glottal stop as t (misaki's G2P).
        return " ".join(out).replace("ɾ", "T").replace("ʔ", "t")

    return say


def _chinese():
    from misaki import zh

    g2p = zh.ZHG2P()
    return lambda text: g2p(text)[0]


_G2P = {}  # a Kokoro code's text -> phonemes, made once (jieba's dictionary is slow)


def _g2p(lang):
    """Kokoro reads phonemes. misaki makes them for Chinese and English;
    every other language is espeak-ng's, inside kokoro-onnx (None here)."""
    key = "zh" if lang.split("-")[0] == "zh" else lang
    if key not in _G2P:
        if key == "zh":
            _G2P[key] = _chinese()
        elif key in ENGLISH:
            _G2P[key] = _english(ENGLISH[key])
        else:
            _G2P[key] = None
    return _G2P[key]


def _phonemes(text, lang):
    g2p = _g2p(lang)
    return g2p(text) if g2p else None


def _kokoro_samples(engine, text, voice, lang):
    phonemes = _phonemes(text, lang)
    if phonemes:
        return engine.create(phonemes, voice=voice, is_phonemes=True)
    return engine.create(text, voice=voice, lang=lang)


def _kokoro_wav(engine, text, voice, lang, out):
    import numpy as np

    samples, rate = _kokoro_samples(engine, text, voice, lang)
    pcm = (np.clip(samples, -1.0, 1.0) * PCM_MAX).astype("<i2").tobytes()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(SAMPLE_BYTES)
        w.setframerate(rate)
        w.writeframes(pcm)


def kokoro(argv):
    p = argparse.ArgumentParser(prog="zimi-voice kokoro")
    p.add_argument("--model", required=True)
    p.add_argument("--voices", required=True)
    p.add_argument("--voice", required=True)
    p.add_argument("--lang", required=True)
    p.add_argument("-f", dest="out", required=True)
    a = p.parse_args(argv)
    text = sys.stdin.read().strip()
    if not text:
        sys.exit("no text")

    from kokoro_onnx import Kokoro

    _kokoro_wav(Kokoro(a.model, a.voices), text, a.voice, a.lang, a.out)


class _KokoroServer:
    """One Kokoro, loaded on the first request; each language's phonemes
    made the first time it is asked for."""

    def __init__(self):
        self.engine, self.files = None, None

    def __call__(self, req):
        files = (req["model"], req["voices"])
        if self.files != files:  # the first request, or a newer model
            from kokoro_onnx import Kokoro

            self.engine, self.files = None, None  # the old one goes first
            self.engine, self.files = Kokoro(*files), files
        voice, lang = req["voice"], req["lang"]
        if "text" not in req:
            _kokoro_samples(self.engine, WARM_TEXT, voice, lang)
        else:
            _kokoro_wav(self.engine, req["text"], voice, lang, req["out"])


class _PiperServer:
    """Piper's voices, each loaded the first time it is asked for, the least
    recently said let go past PIPER_LOADED_MAX."""

    def __init__(self):
        self.loaded = collections.OrderedDict()

    def voice(self, model):
        if model in self.loaded:
            self.loaded.move_to_end(model)
        else:
            from piper import PiperVoice

            self.loaded[model] = PiperVoice.load(model)
            while len(self.loaded) > PIPER_LOADED_MAX:
                self.loaded.popitem(last=False)
        return self.loaded[model]

    def __call__(self, req):
        voice = self.voice(req["model"])
        if "text" not in req:
            for _chunk in voice.synthesize(WARM_TEXT):
                pass
        else:
            with wave.open(req["out"], "wb") as w:
                voice.synthesize_wav(req["text"], w)


SERVERS = {"kokoro": _KokoroServer, "piper": _PiperServer}


def serve(argv):
    """Answer requests until stdin ends, the engine loaded once (see the
    module's docstring). Anything an engine prints goes to stderr: stdout
    carries the answers alone."""
    if len(argv) != 1 or argv[0] not in SERVERS:
        sys.exit("usage: zimi-voice serve {%s}" % ",".join(SERVERS))
    answers = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    handle = SERVERS[argv[0]]()
    for line in sys.stdin.buffer:
        if not line.strip():
            continue
        try:
            handle(json.loads(line))
            reply = {"ok": True}
        except Exception as e:  # one word failing is not the worker failing
            reply = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
        answers.write(json.dumps(reply) + "\n")
        answers.flush()


def selftest(argv):
    """What a build check runs without a voice or a model: both engines
    import, espeak-ng's library and data are where they are looked for, and
    Chinese and English become phonemes. Prints "zimi-voice ok"."""
    import espeakng_loader
    import kokoro_onnx  # noqa: F401
    import onnxruntime  # noqa: F401
    import piper.voice  # noqa: F401

    for path in (espeakng_loader.get_library_path(), espeakng_loader.get_data_path()):
        if not os.path.exists(path):
            sys.exit("missing: " + path)
    if not _phonemes("水", "zh"):
        sys.exit("no phonemes for Chinese")
    if not _phonemes("water", "en-us"):
        sys.exit("no phonemes for English")
    print("zimi-voice ok")


COMMANDS = {"piper": piper, "kokoro": kokoro, "serve": serve, "selftest": selftest}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] not in COMMANDS:
        sys.exit("usage: zimi-voice {%s} ..." % ",".join(COMMANDS))
    COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    main()
