"""The ``zimi-voice`` helper, built by zimi_desktop.spec beside Zimi.

Piper and Kokoro speak the Dictionary's words in the desktop apps. They are
GPL-3 programs (Piper, espeak-ng, phonemizer) and their companions, so they
are their own executable, ``zimi-voice`` (zimi/voicehelper.py), which Zimi
runs as a child and never imports: an aggregate, as ffmpeg is beside a
player. It shares the bundle's support folder with Zimi; its Python modules
are in its own archive, so none of them can reach Zimi's process.

Built only when the build's Python has the engines (pip install piper-tts
kokoro-onnx "misaki[zh]"); without them the app is built as before and
Say uses the system's voice. Each engine's licence comes with it: its
.dist-info (licence texts included) and zimi/assets/voices-NOTICE.txt.
"""

import importlib.util
import os

from PyInstaller.building.build_main import EXE, PYZ, Analysis
from PyInstaller.utils.hooks import collect_all, collect_data_files, copy_metadata

NAME = "zimi-voice"

# What voicehelper.py's imports leave out: data files and libraries found by
# path at run time (espeak-ng's, jieba's dictionary, Kokoro's vocabulary).
COLLECT_ALL = ("piper", "kokoro_onnx", "espeakng_loader", "onnxruntime")
DATA_ONLY = ("misaki", "jieba", "pypinyin", "cn2an", "phonemizer")
# Every distribution whose licence must travel with it.
DISTRIBUTIONS = (
    "piper-tts",
    "kokoro-onnx",
    "misaki",
    "espeakng-loader",
    "phonemizer",
    "onnxruntime",
    "jieba",
    "pypinyin",
    "cn2an",
    "numpy",
)
NEEDS = ("piper", "kokoro_onnx", "misaki", "jieba", "pypinyin", "cn2an")


def available():
    """Whether the build's Python has every engine the helper carries."""
    return all(importlib.util.find_spec(m) is not None for m in NEEDS)


def build(repo_root):
    """(Analysis, EXE) for zimi-voice, to go in Zimi's COLLECT."""
    datas, binaries, hidden = [], [], []
    for pkg in COLLECT_ALL:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hidden += h
    for pkg in DATA_ONLY:
        datas += collect_data_files(pkg)
    for dist in DISTRIBUTIONS:
        datas += copy_metadata(dist)
    datas.append((os.path.join(repo_root, "zimi", "assets", "voices-NOTICE.txt"), "."))
    a = Analysis(
        [os.path.join(repo_root, "zimi", "voicehelper.py")],
        pathex=[repo_root],
        binaries=binaries,
        datas=datas,
        hiddenimports=hidden + ["misaki.zh", "piper.voice", "piper.__main__"],
        excludes=[
            "zimi",
            "tkinter",
            "matplotlib",
            "IPython",
            "jupyter",
            "torch",
            "spacy",
            "pyopenjtalk",
        ],
        noarchive=False,
    )
    pyz = PYZ(a.pure)
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name=NAME,
        debug=False,
        strip=False,
        upx=False,
        console=True,
    )
    return a, exe
