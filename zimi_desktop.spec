# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for Zimi Desktop.

Build:
    pyinstaller zimi_desktop.spec

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
    _ws_dll = os.path.join(SPECPATH, 'WinSparkle.dll')
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
    ['zimi_desktop.py'],
    pathex=[],
    binaries=libzim_bins + lt_bins + winsparkle_bins + pythonnet_bins,
    datas=[
        ('zimi/templates', 'zimi/templates'),
        ('zimi/assets', 'zimi/assets'),
        ('zimi/static', 'zimi/static'),
    ] + pythonnet_datas,
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
        # Windows auto-updater bridge (imported lazily in zimi_desktop).
        'zimi_winsparkle',
        *lt_hidden,
    ] + zeroconf_hiddenimports + windows_hiddenimports + (['gi'] if platform.system() == 'Linux' else []),
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
    icon='zimi/assets/icon.icns' if platform.system() == 'Darwin' else 'zimi/assets/icon.ico',
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
        icon='zimi/assets/icon.icns',
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
