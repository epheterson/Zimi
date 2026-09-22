# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for Zimi Desktop.

Build (from the repo root):
    pyinstaller --noconfirm desktop/zimi_desktop.spec

Output:
    dist/Zimi/          — one-dir bundle (all platforms)
    dist/Zimi.app/      — macOS app bundle (macOS only)
"""

import glob
import os
import platform
import sysconfig

from PyInstaller.utils.hooks import (
    collect_all,
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
)

block_cipher = None

# This spec lives in desktop/; the entry script and its winsparkle sibling live
# beside it, while the zimi package + data dirs (and CI-downloaded Sparkle
# framework / WinSparkle DLL) live at the repo root. Anchor every path to those
# two roots explicitly so the build is independent of the invocation CWD.
# SPECPATH is the absolute directory containing this spec file.
DESKTOP_DIR = SPECPATH
REPO_ROOT = os.path.dirname(SPECPATH)

# zeroconf (LAN peer discovery) loads submodules dynamically, so PyInstaller's
# static analysis misses them unless we collect the whole package.
zeroconf_hiddenimports = collect_submodules("zeroconf")

# ---------------------------------------------------------------------------
# Collect libzim native libraries
# ---------------------------------------------------------------------------
# libzim is a single Cython extension (libzim.cpython-3XX-{platform}.so/.pyd)
# plus a native C++ shared library (libzim.9.dylib / libzim-9.dll / libzim.so.9).
# The submodules (reader, search, suggestion) are .pyi stubs, NOT real modules.
# PyInstaller auto-detects the extension via `import libzim`, but the native
# shared library lives in a separate libzim/ directory and must be collected
# explicitly.

def collect_libzim_binaries():
    """Find libzim native shared libraries for the current platform."""
    binaries = []
    site_packages = sysconfig.get_path('purelib')

    # The libzim/ directory contains the native C++ library
    libzim_dir = os.path.join(site_packages, 'libzim')
    if not os.path.isdir(libzim_dir):
        # Try platlib (where compiled packages go)
        site_packages = sysconfig.get_path('platlib')
        libzim_dir = os.path.join(site_packages, 'libzim')

    if os.path.isdir(libzim_dir):
        if platform.system() == 'Darwin':
            for lib in glob.glob(os.path.join(libzim_dir, '*.dylib')):
                binaries.append((lib, '.'))
        elif platform.system() == 'Windows':
            for lib in glob.glob(os.path.join(libzim_dir, '*.dll')):
                binaries.append((lib, '.'))
        elif platform.system() == 'Linux':
            for lib in glob.glob(os.path.join(libzim_dir, '*.so*')):
                binaries.append((lib, '.'))

    return binaries

libzim_bins = collect_libzim_binaries()

# libtorrent (in-process BT engine): PyInstaller misses compiled-extension
# dylibs without an explicit collect. Soft dependency — if the build venv
# has no libtorrent wheel this collects nothing and the app runs HTTP-only.
lt_bins = collect_dynamic_libs('libtorrent')
lt_hidden = collect_submodules('libtorrent')

# WinSparkle (Windows auto-updater): the CI workflow downloads the release DLL
# (pinned + sha256-verified) to the repo root as WinSparkle.dll before building.
# Bundle it at the bundle root so zimi_winsparkle._find_dll() resolves it via
# sys._MEIPASS. Absent (e.g. local mac build) → collects nothing, app runs
# without auto-update, exactly like the Sparkle.framework soft path.
winsparkle_bins = []
if platform.system() == 'Windows':
    _ws_dll = os.path.join(REPO_ROOT, 'WinSparkle.dll')
    if os.path.isfile(_ws_dll):
        winsparkle_bins.append((_ws_dll, '.'))

# ---------------------------------------------------------------------------
# Windows: pythonnet + clr_loader (drives pywebview's WebView2 backend).
# ---------------------------------------------------------------------------
# pywebview's edgechromium/winforms backend reaches .NET through pythonnet,
# which loads Python.Runtime.dll (shipped inside the pythonnet package) via
# clr_loader's native netfx hosting shim (clr_loader/ffi/dlls/**/*.dll). None
# of that is a plain Python import, so PyInstaller's static analysis misses it
# unless we collect the whole packages. Missing pieces = a frozen app that
# crashes at launch trying to bring up the window. Windows-only; on mac/linux
# these packages aren't installed and this collects nothing.
# ---------------------------------------------------------------------------
# Linux: WebKitGTK's typelibs. pywebview's GTK backend asks GObject
# introspection for WebKit2 (4.1, else 4.0) and Soup; PyInstaller has hooks
# for Gtk but none for those, and its runtime hook points introspection at
# the bundle alone, so every Linux build shipped without the one namespace
# the window needs (issue #81: "Namespace WebKit2 not available", six
# distros). The typelibs are bundled here, both versions the build host
# has; the libraries themselves are NOT, on purpose: the typelib names the
# .so and the host's own WebKitGTK is loaded, whichever it has. Carrying a
# WebKit in the bundle would mean carrying its whole stack and its GPU
# quirks; the host's is the one that matches the host's drivers.
# ---------------------------------------------------------------------------
webkit_datas = []
webkit_hiddenimports = []
if platform.system() == 'Linux':
    from PyInstaller.utils.hooks.gi import GiModuleInfo
    for _mod, _ver in (('WebKit2', '4.1'), ('JavaScriptCore', '4.1'), ('Soup', '3.0'),
                       ('WebKit2', '4.0'), ('JavaScriptCore', '4.0'), ('Soup', '2.4')):
        try:
            _info = GiModuleInfo(_mod, _ver)
            if not _info.available:
                print('spec: no %s %s typelib on this host' % (_mod, _ver))
                continue
            _b, _d, _h = _info.collect_typelib_data()
            webkit_datas += _d
            # Only WebKit2 is imported by name (pywebview's gtk backend);
            # Soup and JavaScriptCore ride along as typelibs it resolves.
            if _mod == 'WebKit2':
                webkit_hiddenimports += [h for h in _h if 'JavaScriptCore' not in h]
            print('spec: bundling the %s %s typelib' % (_mod, _ver))
        except Exception as e:  # the host lacks that version: fine
            print('spec: no %s %s typelib on this host (%s)' % (_mod, _ver, e))

pythonnet_datas = []
pythonnet_bins = []
windows_hiddenimports = []
if platform.system() == 'Windows':
    for _pkg in ('pythonnet', 'clr_loader'):
        _d, _b, _h = collect_all(_pkg)
        pythonnet_datas += _d
        pythonnet_bins += _b
        windows_hiddenimports += _h
    # WebView2 interop DLLs live in webview/lib/ as data, not importable code.
    pythonnet_datas += collect_data_files('webview')
    windows_hiddenimports += [
        'clr',
        'clr_loader',
        'clr_loader.netfx',
        'pythonnet',
        'webview.platforms.edgechromium',
        'webview.platforms.winforms',
    ]

a = Analysis(
    [os.path.join(DESKTOP_DIR, 'zimi_desktop.py')],
    pathex=[REPO_ROOT, DESKTOP_DIR],
    binaries=libzim_bins + lt_bins + winsparkle_bins + pythonnet_bins,
    datas=[
        (os.path.join(REPO_ROOT, 'zimi/templates'), 'zimi/templates'),
        (os.path.join(REPO_ROOT, 'zimi/assets'), 'zimi/assets'),
        (os.path.join(REPO_ROOT, 'zimi/static'), 'zimi/static'),
    ] + pythonnet_datas + webkit_datas,
    hiddenimports=[
        'zimi',
        'zimi.server',
        'zimi.http',
        'zimi.search',
        'zimi.interlang',
        'zimi.library',
        'zimi.manage',
        'zimi.previews',
        'zimi.p2p',
        'zimi.p2p_discovery',
        'libzim',
        # Soft BT dependency: guarantees the extension is bundled when a
        # wheel is present. Absent → PyInstaller warns, does not fail.
        'libtorrent',
        'certifi',
        'fitz',
        'PIL',
        'webview',
        # The app and its Windows auto-updater bridge (imported lazily).
        'zimi.desktop',
        'zimi.winsparkle',
        *lt_hidden,
    ] + zeroconf_hiddenimports + windows_hiddenimports + webkit_hiddenimports + (['gi'] if platform.system() == 'Linux' else []),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'mcp',
        'zimi.mcp_server',
        'matplotlib',
        'numpy',
        'scipy',
        'pandas',
        'IPython',
        'jupyter',
        'tkinter',
        'pystray',
    ],
    noarchive=False,
    cipher=block_cipher,
)

# ---------------------------------------------------------------------------
# Linux: system libraries are the host's. PyInstaller bundles every shared
# library the build machine's Python happened to load: GLib, GTK, gnutls,
# and a hundred more, all Ubuntu 22.04's. The window then fails wherever
# the host's WebKitGTK and its dependencies link against newer ones:
#   24.04: libgudev-1.0.so.0: undefined symbol: g_once_init_enter_pointer
#   Fedora 41: libgnutls.so.30: version `GNUTLS_3_8_2' not found
# So the bundle's own library path holds only what a Linux desktop cannot
# be assumed to have: Python's extension modules, the libraries the wheels
# vendor (libzim, libtorrent, PyMuPDF, Pillow, PyGObject's _gi) and
# libgirepository. Every system library goes to _internal/fallback instead,
# and linux/AppRun puts on the library path only those the host lacks
# (a bare box without sqlite3, say, still runs the server and the browser
# mode). Where the host has a library, the host's is used, and matching the
# host's own WebKitGTK is the whole point.
# ---------------------------------------------------------------------------
if platform.system() == 'Linux':
    _kept, _fallback = [], []
    for _entry in a.binaries:
        _dest, _src, _kind = _entry[0], _entry[1], _entry[2]
        _base = os.path.basename(_dest)
        _ours = (
            _kind == 'EXTENSION'
            or '/site-packages/' in _src.replace(os.sep, '/')
            or _base.startswith('libpython')
            or _base.startswith('libgirepository')
        )
        if _dest.startswith('gio_modules'):
            continue
        if _ours:
            _kept.append(_entry)
        else:
            _fallback.append((os.path.join('fallback', _base), _src, _kind))
    a.binaries = _kept + _fallback
    print('spec: %d system libraries moved to fallback, for hosts that lack them: %s'
          % (len(_fallback), ' '.join(sorted(set(os.path.basename(e[0]) for e in _fallback)))))

pyz = PYZ(a.pure, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='Zimi',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    icon=(os.path.join(REPO_ROOT, 'zimi/assets/icon.icns') if platform.system() == 'Darwin'
          else os.path.join(REPO_ROOT, 'zimi/assets/icon.ico')),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='Zimi',
)

# macOS: wrap into .app bundle with Sparkle.framework for auto-updates
if platform.system() == 'Darwin':
    # Embed Sparkle.framework in the app bundle's Frameworks/ directory
    sparkle_framework = 'Sparkle.framework'

    app = BUNDLE(
        coll,
        name='Zimi.app',
        icon=os.path.join(REPO_ROOT, 'zimi/assets/icon.icns'),
        bundle_identifier='io.zosia.zimi',
        info_plist={
            'CFBundleShortVersionString': '1.4.0',
            'CFBundleVersion': '1.4.0',
            'LSUIElement': False,  # show in Dock (native window app)
            'NSLocalNetworkUsageDescription': 'Zimi runs a local server on this computer to display your offline library. It does not access other devices.',
            'NSAppTransportSecurity': {
                'NSAllowsArbitraryLoads': True,  # needed for localhost HTTP
            },
            # Default appcast (Intel); overridden at runtime for Apple Silicon
            'SUFeedURL': 'https://raw.githubusercontent.com/epheterson/Zimi/main/appcast-intel.xml',
            'SUPublicEDKey': 'YPy3VF5Yv4ajGgz3HKvkeBOqhTkZXZyoFYsLhLq9Cpc=',
        },
    )
    # NOTE: Sparkle.framework is copied into the .app by the CI workflow
    # AFTER PyInstaller finishes. Cannot do it here because BUNDLE() is
    # lazy — it builds the .app after spec evaluation completes, so any
    # files copied here would be overwritten.
