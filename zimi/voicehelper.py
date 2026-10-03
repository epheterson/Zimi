"""zimi-voice: the speech engines the Dictionary's Say runs, as a program of
their own.

Zimi never imports a speech engine. Piper and espeak-ng are GPL-3 (Kokoro's
phonemizer loads espeak-ng too), so they run here, in a separate process,
beside MIT Zimi the way ffmpeg does. voices.py starts this as a child with the
text on stdin and reads the WAV it writes.

    zimi-voice piper -m VOICE.onnx -f OUT.wav          (Piper's own arguments)
    zimi-voice kokoro --model M.onnx --voices V.bin --voice NAME --lang zh -f OUT.wav

Run as ``python voicehelper.py ...`` where piper-tts and kokoro-onnx are
installed (Docker, pip), or as the ``zimi-voice`` executable the desktop
builds bundle beside Zimi. Self-contained on purpose: it imports nothing of
Zimi, so starting it never loads the server.
"""

import argparse
import sys
import wave

PCM_MAX = 32767
SAMPLE_BYTES = 2  # 16-bit mono, what every other engine writes


def piper(argv):
    """Piper's own command line, unchanged."""
    from piper.__main__ import main

    sys.argv = ["piper"] + argv
    main()


def _phonemes(text, lang):
    """Kokoro reads phonemes; misaki makes them from Chinese natively, with no
    espeak-ng in the way."""
    if lang.split("-")[0] == "zh":
        from misaki import zh

        return zh.ZHG2P()(text)[0]
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
    Chinese becomes phonemes. Prints "zimi-voice ok"."""
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
    print("zimi-voice ok")


COMMANDS = {"piper": piper, "kokoro": kokoro, "selftest": selftest}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] not in COMMANDS:
        sys.exit("usage: zimi-voice {%s} ..." % ",".join(COMMANDS))
    COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    main()
