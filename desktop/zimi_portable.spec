# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the portable headless Zimi (Linux x64 and arm64).

Build (from the repo root):
    pyinstaller --noconfirm desktop/zimi_portable.spec

Output:
    dist/zimi/          - one folder: the `zimi` executable and `_internal/`

The desktop app's freeze (zimi_desktop.spec) minus everything a window needs: no pywebview, no GTK or
WebKit typelibs, no libtorrent, no zimi-voice. libzim's native library is collected the same way.
"""

import glob
import os
import sysconfig

from PyInstaller.utils.hooks import collect_submodules

REPO_ROOT = os.path.dirname(SPECPATH)

# Everything in the package that is loaded by name at run time, less what only a window or an MCP client uses.
_LEFT_OUT = ('zimi.desktop', 'zimi.winsparkle', 'zimi.mcp_server')
zimi_modules = collect_submodules('zimi', filter=lambda name: name not in _LEFT_OUT)
zeroconf_modules = collect_submodules('zeroconf')  # loads submodules dynamically

# libzim's C++ library sits beside its extension in site-packages/libzim/ and is not found by import analysis.
libzim_bins = []
for _base in (sysconfig.get_path('purelib'), sysconfig.get_path('platlib')):
    _dir = os.path.join(_base, 'libzim')
    if os.path.isdir(_dir):
        libzim_bins = [(lib, '.') for lib in glob.glob(os.path.join(_dir, '*.so*'))]
        break
if not libzim_bins:
    raise SystemExit('zimi_portable.spec: no libzim shared library found; pip install -r desktop/requirements-portable.txt')

# Zimi's own ZIMs and what the server reads of the games' source (same list as the desktop spec).
_BUILTIN = os.path.join(REPO_ROOT, 'zimi/builtin')
builtin_datas = [(z, 'zimi/builtin') for z in sorted(glob.glob(os.path.join(_BUILTIN, '*.zim')) + glob.glob(os.path.join(_BUILTIN, '*.zim.source')))] + [
    (os.path.join(_BUILTIN, 'games/games.json'), 'zimi/builtin/games'),
    (os.path.join(_BUILTIN, 'games/thumbs'), 'zimi/builtin/games/thumbs'),
    (os.path.join(_BUILTIN, 'games/puzzles/icons'), 'zimi/builtin/games/puzzles/icons'),
]

a = Analysis(
    [os.path.join(SPECPATH, 'zimi_portable.py')],
    pathex=[REPO_ROOT],
    binaries=libzim_bins,
    datas=[
        (os.path.join(REPO_ROOT, 'zimi/templates'), 'zimi/templates'),
        (os.path.join(REPO_ROOT, 'zimi/assets'), 'zimi/assets'),
        (os.path.join(REPO_ROOT, 'zimi/static'), 'zimi/static'),
    ] + builtin_datas,
    hiddenimports=['libzim', 'certifi', 'fitz', 'PIL'] + zimi_modules + zeroconf_modules,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'webview', 'gi', 'libtorrent', 'mcp', 'matplotlib', 'numpy', 'scipy', 'pandas',
        'IPython', 'jupyter', 'tkinter', 'pystray',
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='zimi',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='zimi',
)
