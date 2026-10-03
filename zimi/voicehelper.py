"""zimi-voice: the speech engines the Dictionary's Say runs, as a program of
their own.

Zimi never imports a speech engine. Piper and espeak-ng are GPL-3 (Kokoro's
phonemizer loads espeak-ng too), so they run here, in a separate process,
beside MIT Zimi the way ffmpeg does. voices.py starts this as a child with the
text on stdin and reads the WAV it writes.

    zimi-voice piper -m VOICE.onnx -f OUT.wav          (Piper's own arguments)
    zimi-voice kokoro --model M.onnx --voices V.bin --voice NAME --lang en-us -f OUT.wav

Run as ``python voicehelper.py ...`` where piper-tts and kokoro-onnx are
installed (Docker, pip), or as the ``zimi-voice`` executable the desktop
builds bundle beside Zimi. Self-contained on purpose: it imports nothing of
Zimi, so starting it never loads the server.
"""

import argparse
import re
import sys
import types
import wave

PCM_MAX = 32767
SAMPLE_BYTES = 2  # 16-bit mono, what every other engine writes
ENGLISH = {"en-us": False, "en-gb": True}  # Kokoro's English codes: British?
# A word as misaki's lexicon looks it up: punctuation around it is not part of it.
_WORD_RE = re.compile(r"[^\s,;:!?()\[\]\"“”]+")


def piper(argv):
    """Piper's own command line, unchanged."""
    from piper.__main__ import main

    sys.argv = ["piper"] + argv
    main()


def _english(text, british):
    """English as Kokoro was trained to read it: misaki's lexicon (its gold
    and silver dictionaries, stems, numbers), espeak-ng only for a word it
    does not have. Plain espeak-ng phonemes were what made English "a lil
    off" (Eric, 2026-10-03).

    Without misaki's spaCy tagger, 120 MB more for this helper: a dictionary
    says a word with no sentence around it to tag, and the lexicon's own
    reading of a lone word is the one a dictionary wants ("object" the
    noun). misaki.en imports spaCy for that tagger only, so a stand-in
    satisfies the import."""
    sys.modules.setdefault("spacy", types.ModuleType("spacy"))
    from misaki import en, espeak
    from misaki.token import MToken

    lexicon, fallback = en.Lexicon(british), espeak.EspeakFallback(british)
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


def _phonemes(text, lang):
    """Kokoro reads phonemes. misaki makes them for Chinese and English;
    every other language is espeak-ng's, inside kokoro-onnx (None here)."""
    if lang.split("-")[0] == "zh":
        from misaki import zh

        return zh.ZHG2P()(text)[0]
    if lang in ENGLISH:
        return _english(text, ENGLISH[lang])
    return None


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

    import numpy as np
    from kokoro_onnx import Kokoro

    engine = Kokoro(a.model, a.voices)
    phonemes = _phonemes(text, a.lang)
    if phonemes:
        samples, rate = engine.create(phonemes, voice=a.voice, is_phonemes=True)
    else:
        samples, rate = engine.create(text, voice=a.voice, lang=a.lang)
    pcm = (np.clip(samples, -1.0, 1.0) * PCM_MAX).astype("<i2").tobytes()
    with wave.open(a.out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(SAMPLE_BYTES)
        w.setframerate(rate)
        w.writeframes(pcm)


def selftest(argv):
    """What a build check runs without a voice or a model: both engines
    import, espeak-ng's library and data are where they are looked for, and
    Chinese and English become phonemes. Prints "zimi-voice ok"."""
    import os

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


COMMANDS = {"piper": piper, "kokoro": kokoro, "selftest": selftest}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] not in COMMANDS:
        sys.exit("usage: zimi-voice {%s} ..." % ",".join(COMMANDS))
    COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    main()
