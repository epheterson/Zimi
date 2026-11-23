"""Add-ons: the parts of Zimi that are fetched once, into the data folder, instead of riding in the image.

"in 16 let's always stay under a gig and see how low we can go. Balance of everything we need
built in and offering more after setup for added functionality."

Built in: search, reading, the Almanac, Games, MCP, the library. Add-ons (each a few hundred MB that most
people never use): the browser for Create (Chromium and Playwright), SingleFile (Node and its CLI), video (yt-dlp
and ffmpeg), warc2zim (import and the alive engine) and the Dictionary's voices (which keep their own setting and
install, voices.py; this module only lists them).

One registry, ``ADDONS``. Each add-on is a few parts: a pinned archive (URL, sha256, size, per CPU), a pip
package, an npm package, or a function. Everything lands in ``<data>/addons/<key>/`` through a ``.partial``
folder renamed on success, so a half install is never taken for one; ``<key>/.zimi-addon.json`` says which
version of the recipe is there. ``activate()`` puts what is installed on PATH and sys.path (and tells Playwright
where its browser is), at startup and after each install, so nothing needs a restart. The features keep asking
their own questions (``shutil.which``, ``import yt_dlp``); an add-on answers them by being on the path.

Fetching is one Ask first / Automatically / Never setting (outbound.py, ``ZIMI_ADDONS``), Ask first by default;
ZIMI_OFFLINE is Never. Ask first: an admin presses Add. Automatically: a job that needs an add-on installs it
first (``ensure``). Never: nothing is fetched. An install is checked before it counts: archives against their
sha256, and the browser by launching it once, so a missing system library says so now, not in a capture an hour in.

Which kinds of install: Docker is slim and relies on this. A pip or Linux install can add them too when the host
does not have the tool already, on Linux, macOS and Windows (``supported()``: an OS and CPU the recipes pin). The frozen
desktop apps follow once their own runtimes can take wheels (runtimes.py says where each kind stands).

Sources and licences of what is fetched (never bundled): Chrome for Testing (Google, BSD-style licences, per build),
Node (MIT), uv (MIT/Apache-2.0), yt-dlp (Unlicense), single-file-cli (AGPL-3.0, an npm package run as its own
program), ffmpeg: johnvansickle's Linux static builds and eugeneware/ffmpeg-static b6.0 for macOS and Windows (GPL
builds, fetched at the person's tap and run as separate programs).
"""

import collections
import gzip
import hashlib
import importlib
import json
import logging
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import zipfile
from collections import namedtuple

from zimi import outbound, subproc
from zimi.safety import join_inside, loggable

log = logging.getLogger("zimi")

ENV = "ZIMI_ADDONS"
PREFS_KEY = "addons"
POLICY = outbound.FetchPolicy(ENV, PREFS_KEY, outbound.ASK, "Add-ons")
MARKER = ".zimi-addon.json"
PARTIAL = ".partial"
USER_AGENT = "Zimi-addons"
CHUNK = 256 * 1024
CONNECT_TIMEOUT_S = 30
#: A download larger than its pinned size by this factor is refused (the pin is the promise).
SIZE_SLACK = 1.05
MB = 1_000_000

# ── recipes ──────────────────────────────────────────────────────────────────

#: A pinned archive: ``files`` is {cpu: (url, sha256, bytes)}; ``dest`` is a folder inside the add-on; ``strip``
#: leading path parts are dropped as it is unpacked, and members under a ``skip`` prefix (manuals, headers) are not.
#: ``strip`` is an int or {target: int} (a Windows zip has a different top folder than a tarball); ``single``: the
#: archive is one gzipped file, written as ``dest/<single>``.
Archive = namedtuple("Archive", "dest strip files skip single", defaults=((), ""))
#: pip packages installed with ``--target`` into ``dest``.
Pip = namedtuple("Pip", "requirements dest size")
#: An npm package installed under ``dest``, with the Node an earlier Archive put in ``node``.
Npm = namedtuple("Npm", "package dest node size")
#: ``key``: the add-on. ``parts``: in install order. ``bins``/``pypath``: folders (inside the add-on) put on PATH
#: and sys.path. ``env``: {VAR: folder inside the add-on}. ``requires``: add-ons that must be there. ``host``:
#: whether the host already has the tool (no add-on needed). ``check``: proves an install works, or raises.
#: ``custom``: replaces the parts (warc2zim builds a venv that cannot move).
Addon = namedtuple(
    "Addon", "key version parts bins pypath env requires host check custom"
)


def cpu():
    """x64 or arm64, or None for a machine nothing is pinned for."""
    return {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(
        platform.machine().lower()
    )


def _os():
    """linux, mac or win; None on anything else."""
    if sys.platform.startswith("linux"):
        return "linux"
    if sys.platform == "darwin":
        return "mac"
    if sys.platform.startswith("win"):
        return "win"
    return None


#: The platforms the recipes pin an archive for: Linux's keys are the bare CPU, the others carry the OS.
TARGETS = ("x64", "arm64", "mac-x64", "mac-arm64", "win-x64")


def target():
    """The key a recipe's ``files`` are looked up by on this machine, or None for one nothing is pinned for."""
    c, o = cpu(), _os()
    if o == "linux":
        return c
    if o == "mac":
        return "mac-" + c if c else None
    if o == "win":
        return "win-x64" if c == "x64" else None
    return None


def exename(name):
    """A program's file name here (Windows adds .exe)."""
    return name + ".exe" if _os() == "win" else name


def _frozen():
    return bool(getattr(sys, "frozen", False))


def _abi():
    """cp312, cp313...: the tag a compiled wheel must carry to load into this Python."""
    return "cp%d%d" % sys.version_info[:2]


def supported():
    """Whether add-ons can be fetched on this machine: Linux, macOS or Windows on a CPU the recipes pin. A frozen
    desktop app has no pip: it unpacks pinned wheels (``_wheels``), for the Python versions it was built with."""
    if target() not in TARGETS:
        return False
    if _frozen():
        from zimi import addon_wheels

        return _abi() in addon_wheels.ABIS
    return True


PLAYWRIGHT = "1.64.1"
#: Chrome for Testing build Playwright PLAYWRIGHT expects as revision 1248 (its browsers.json).
CHROME = "156.0.8078.4"
CHROME_REVISION = "1248"
_CFT = "https://storage.googleapis.com/chrome-for-testing-public/" + CHROME + "/"
NODE = "24.19.0"
_NODE = "https://nodejs.org/dist/v" + NODE + "/node-v" + NODE + "-linux-"
_NODE_BASE = "https://nodejs.org/dist/v" + NODE + "/node-v" + NODE + "-"
SINGLEFILE = "single-file-cli@2.25.0"
FFMPEG = "6.0.1"
_FFMPEG = "https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-" + FFMPEG + "-"
_FFMPEG_STATIC = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-"
UV = "0.13.7"
_UV = "https://github.com/astral-sh/uv/releases/download/" + UV + "/uv-"

_BROWSER_DIR = os.path.join(
    "ms-playwright", "chromium_headless_shell-" + CHROME_REVISION
)

_ARCHIVES = {
    "chromium": Archive(
        _BROWSER_DIR,
        0,  # the zip's own top folder (chrome-headless-shell-linux64) is where Playwright looks
        {
            "x64": (
                _CFT + "linux64/chrome-headless-shell-linux64.zip",
                "c3e50596aef52c58f8fda3c6b3411c33d34c88b177b3ed1c2243359fd3b8ba20",
                125_797_539,
            ),
            "arm64": (
                _CFT + "linux-arm64/chrome-headless-shell-linux-arm64.zip",
                "81ab9d4d3c301dc5fdfb6c541b9e6632b16fc819a6a854460f40a76fe2b2c476",
                125_711_061,
            ),
            "mac-arm64": (
                _CFT + "mac-arm64/chrome-headless-shell-mac-arm64.zip",
                "94e4337b70cbc5638f0935fbc46b9f242bc7416f657e3fbe924baf348404b53d",
                103_778_487,
            ),
            "mac-x64": (
                _CFT + "mac-x64/chrome-headless-shell-mac-x64.zip",
                "8a9e4a32ba5b1a796f8b16d01896e355cf6662544d9743296394fd999d782331",
                109_130_614,
            ),
            "win-x64": (
                _CFT + "win64/chrome-headless-shell-win64.zip",
                "5af4c82cf4b351ec4bad4c71dcf938af14fccea8a0eb0d5c2a7b49ccc922698c",
                123_826_519,
            ),
        },
    ),
    "node": Archive(
        "node",
        1,
        {
            "x64": (
                _NODE + "x64.tar.xz",
                "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647",
                31_633_904,
            ),
            "arm64": (
                _NODE + "arm64.tar.xz",
                "01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc",
                30_553_480,
            ),
            "mac-arm64": (
                _NODE_BASE + "darwin-arm64.tar.xz",
                "3f1cf157479c1480352083105e13faf9d008ede98e7e157746b6df940d197b94",
                27_162_556,
            ),
            "mac-x64": (
                _NODE_BASE + "darwin-x64.tar.xz",
                "d35e95230f46f6f0751df497c56622c6735e05d5e1fb1630996a005b9d328fe4",
                28_797_364,
            ),
            "win-x64": (
                _NODE_BASE + "win-x64.zip",
                "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73",
                37_304_352,
            ),
        },
        ("include", "share"),
    ),
    "ffmpeg": Archive(
        "ffmpeg",
        1,
        {
            "x64": (
                _FFMPEG + "amd64-static.tar.xz",
                "28268bf402f1083833ea269331587f60a242848880073be8016501d864bd07a5",
                41_164_188,
            ),
            "arm64": (
                _FFMPEG + "arm64-static.tar.xz",
                "7dbd8e2f47bd83de591b9d6ea70e67d32d9aa97e7d47ae402b60c2fe3fd4d0ab",
                18_994_172,
            ),
            # macOS and Windows: eugeneware/ffmpeg-static b6.0, one gzipped static binary each (GPL; fetched, never bundled).
            "mac-arm64": (
                _FFMPEG_STATIC + "darwin-arm64.gz",
                "6be74d6f449889c2e87a75873894f8520cad56c08ac76f2a628d85b0519daaca",
                19_253_088,
            ),
            "mac-x64": (
                _FFMPEG_STATIC + "darwin-x64.gz",
                "a12354fce7eb62361473bbe10d53a1893695babd35869ec8e92e5dfea8d0440b",
                25_067_704,
            ),
            "win-x64": (
                _FFMPEG_STATIC + "win32-x64.gz",
                "450d66226c79405c724e821f291cab0911e934bfa9fa2231adcab587f3e07b50",
                28_894_894,
            ),
        },
        ("manpages", "model"),
        "ffmpeg",
    ),
    "uv": Archive(
        "uv",
        {"x64": 1, "arm64": 1, "mac-x64": 1, "mac-arm64": 1, "win-x64": 0},  # the Windows zip has no top folder
        {
            "x64": (
                _UV + "x86_64-unknown-linux-gnu.tar.gz",
                "c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83",
                16_671_812,
            ),
            "arm64": (
                _UV + "aarch64-unknown-linux-gnu.tar.gz",
                "71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc",
                15_896_996,
            ),
            "mac-arm64": (
                _UV + "aarch64-apple-darwin.tar.gz",
                "81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731",
                14_347_867,
            ),
            "mac-x64": (
                _UV + "x86_64-apple-darwin.tar.gz",
                "20c47e4c1f630b8abaff8c291fa9b9aa300fef92c4fbff95adf198b55287cda7",
                17_026_382,
            ),
            "win-x64": (
                _UV + "x86_64-pc-windows-msvc.zip",
                "0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021",
                15_236_317,
            ),
        },
    ),
}


def _on_path(name):
    return lambda: shutil.which(name) is not None


def _module_found(name):
    def found():
        try:
            return importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):
            return False

    return found


def _host_browser():
    from zimi import renderer

    known = renderer.browser_status_known()
    return bool(known and known[0])


def _check_browser(root):
    """Launch the browser once: a missing system library or a wrong revision fails here, with its words."""
    importlib.invalidate_caches()
    from zimi import renderer

    ok, reason = renderer.browser_status(refresh=True)
    if not ok:
        raise RuntimeError("the browser would not start (%s)" % reason)


def _check_singlefile(root):
    from zimi.singlefile import singlefile_version

    if not singlefile_version():
        raise RuntimeError("single-file did not answer --version")


def _check_video(root):
    importlib.invalidate_caches()
    importlib.import_module("yt_dlp")
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is not on the path")


def _custom_warc2zim(root, say):
    """The sidecar venv cannot move, so it is built where the importer looks for it, with uv (an archive part) and the
    Python 3.14 warc2zim needs, which uv fetches."""
    from zimi import importer

    uv = os.path.join(root, "uv", exename("uv"))
    venv = importer.sidecar_dir()
    exe = importer._venv_bin(venv, "warc2zim")
    # puremagic: the stand-in for libmagic a machine without it uses (importer.make_portable); a few KB elsewhere.
    if not importer.build_venv(
        venv, importer.WARC2ZIM_PYTHON, [importer.WARC2ZIM_REQUIREMENT, "puremagic"], exe, say, uv=uv
    ):
        raise RuntimeError("warc2zim did not install (the log has the tool's output)")
    importer.finish_sidecar(venv, say)


def _custom_reddit(root, say):
    """The Reddit maker's sidecar venv, built with the uv an archive part brought and a Python uv fetches itself."""
    from zimi import importer, reddot

    uv = os.path.join(root, "uv", exename("uv"))
    venv = reddot.sidecar_dir()
    exe = importer._venv_bin(venv, "arcticzim")
    requirements = [reddot.ARCTICZIM_REQUIREMENT, *reddot.ARCTICZIM_PINS]
    if not importer.build_venv(venv, REDDIT_PYTHON, [*requirements, "puremagic"], exe, say, run=importer._run_stream, uv=uv):
        raise RuntimeError("the Reddit maker did not install (the log has the tool's output)")
    importer.make_portable(venv, say)
    reddot._write_marker(venv)


def _reddit_ready():
    from zimi import reddot

    return bool(reddot.sidecar_status().get("installed"))


def _warc2zim_ready():
    from zimi import importer

    return bool(importer.sidecar_status().get("installed"))


#: The Python uv fetches for ArcticZim's venv.
REDDIT_PYTHON = "3.13"

ADDONS = (
    Addon(
        "browser",
        "1",
        (
            Pip(("playwright==" + PLAYWRIGHT,), "site", 48 * MB),
            _ARCHIVES["chromium"],
        ),
        (),
        ("site",),
        {"PLAYWRIGHT_BROWSERS_PATH": "ms-playwright"},
        (),
        _host_browser,
        _check_browser,
        None,
    ),
    Addon(
        "singlefile",
        "1",
        (_ARCHIVES["node"], Npm(SINGLEFILE, "singlefile", "node", 25 * MB)),
        ("node", "singlefile") if _os() == "win" else ("node/bin", "singlefile/bin"),
        (),
        {},
        ("browser",),
        _on_path("single-file"),
        _check_singlefile,
        None,
    ),
    Addon(
        "video",
        "1",
        (Pip(("yt-dlp>=2024.1.1",), "site", 20 * MB), _ARCHIVES["ffmpeg"]),
        ("ffmpeg",),
        ("site",),
        {},
        (),
        lambda: _module_found("yt_dlp")() and shutil.which("ffmpeg") is not None,
        _check_video,
        None,
    ),
    Addon(
        "warc2zim",
        "1",
        (_ARCHIVES["uv"],),
        (),
        (),
        {},
        (),
        _warc2zim_ready,
        None,
        _custom_warc2zim,
    ),
    Addon(
        "reddit",
        "1",
        (_ARCHIVES["uv"],),
        (),
        (),
        {},
        (),
        _reddit_ready,
        None,
        _custom_reddit,
    ),
)
BY_KEY = {a.key: a for a in ADDONS}
#: Not installed here: the Dictionary's voices keep their own setting, download and progress (voices.py).
DELEGATED = ("voices",)
#: What the warc2zim step fetches beyond its archive: Python 3.14 (uv) and the package, about.
WARC2ZIM_EXTRA = 130 * MB
#: The same for ArcticZim's Python and packages, about.
REDDIT_EXTRA = 160 * MB


def size_of(addon):
    """About how many bytes installing ``addon`` downloads, known offline."""
    c = target()
    total = 0
    for p in addon.parts:
        total += (
            p.files[c][2]
            if isinstance(p, Archive) and c in p.files
            else getattr(p, "size", 0)
        )
    return total + ((REDDIT_EXTRA if addon.key == "reddit" else WARC2ZIM_EXTRA) if addon.custom else 0)


# ── where, and what is there ─────────────────────────────────────────────────


def root():
    from zimi import server as _srv

    return os.path.join(_srv.ZIMI_DATA_DIR, "addons")


def folder(key):
    path = join_inside(root(), key)
    if path is None:
        raise ValueError("not an add-on")
    return path


def _marker(key):
    try:
        with open(os.path.join(folder(key), MARKER), encoding="utf-8") as f:
            rec = json.load(f)
        return rec if isinstance(rec, dict) else {}
    except (OSError, ValueError):
        return {}


def installed(key):
    """The add-on's own install is here and current (the recipe's version). A custom add-on is installed when its
    own thing answers."""
    a = BY_KEY[key]
    if a.custom:
        return a.host()
    return _marker(key).get("version") == a.version


def available(key):
    """Whether the add-on's tool can be used now: installed, or the host has it."""
    a = BY_KEY[key]
    if installed(key):
        return True
    try:
        return bool(a.host())
    except Exception:
        return False


# ── activation ───────────────────────────────────────────────────────────────

_activate_lock = threading.Lock()


def activate():
    """Put every installed add-on on PATH and sys.path, and set the variables it needs (never over one the operator
    set). Idempotent; run at startup and after each install."""
    with _activate_lock:
        for a in ADDONS:
            if a.custom or not installed(a.key):
                continue
            base = folder(a.key)
            path = os.environ.get("PATH", "").split(os.pathsep)
            # First, not last: the pinned Node (single-file-cli needs a new one) and ffmpeg beat an older one the
            # machine happens to have; the add-on is what Zimi tested against.
            for rel in reversed(a.bins):
                d = os.path.join(base, rel)
                if d in path:
                    path.remove(d)
                path.insert(0, d)
            os.environ["PATH"] = os.pathsep.join(p for p in path if p)
            for rel in a.pypath:
                d = os.path.join(base, rel)
                if d not in sys.path:
                    # First, not last: the add-on's pinned package (Playwright, whose browser revision is the one
                    # fetched beside it) must win over a different version the host's own site-packages may have.
                    sys.path.insert(0, d)
            for var, rel in a.env.items():
                os.environ.setdefault(var, os.path.join(base, rel))
        importlib.invalidate_caches()


# ── installing ───────────────────────────────────────────────────────────────

_lock = threading.Lock()
#: {"key", "step", "done", "total", "error", "cancel", "finished"} of the install under way or the last one.
_state = {}


class _Cancelled(Exception):
    pass


def _set(**kw):
    with _lock:
        _state.update(kw)


def _checkpoint():
    with _lock:
        if _state.get("cancel"):
            raise _Cancelled()


def _within(dest, name):
    target = os.path.realpath(os.path.join(dest, name))
    return target == os.path.realpath(dest) or target.startswith(
        os.path.realpath(dest) + os.sep
    )


def _strip(name, strip):
    parts = [p for p in name.split("/") if p]
    return "/".join(parts[strip:])


def _skipped(rel, skip):
    return any(rel == s or rel.startswith(s + "/") for s in skip)


# An unpacked file belongs to the user running Zimi: owner read and write, group read and
# execute where the archive made it so, nothing for others.
_EXEC_MODE = 0o750


def _file_mode(archive_mode):
    """The mode an archive file is written with: its owner and group bits only, never any for others."""
    return (archive_mode & 0o750) | 0o600


def _unpack(archive_path, dest, strip, skip=(), single=""):
    """Unpack a zip or tar into ``dest`` without letting a member leave it; modes and links kept. ``single``: the
    archive is one gzipped file, written as ``dest/<single>`` and made executable."""
    os.makedirs(dest, exist_ok=True)
    if single:
        out = os.path.join(dest, single)
        with gzip.open(archive_path, "rb") as src, open(out, "wb") as dst:
            shutil.copyfileobj(src, dst)
        os.chmod(out, _EXEC_MODE)
        return
    if zipfile.is_zipfile(archive_path):
        with zipfile.ZipFile(archive_path) as z:
            for info in z.infolist():
                rel = _strip(info.filename, strip)
                if not rel or _skipped(rel, skip):
                    continue
                if not _within(dest, rel):
                    raise ValueError("archive member outside the folder")
                out = os.path.join(dest, rel)
                if info.is_dir():
                    os.makedirs(out, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with z.open(info) as src, open(out, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                mode = (info.external_attr >> 16) & 0o777
                os.chmod(out, _file_mode(mode))
        return
    with tarfile.open(archive_path) as t:
        for m in t:
            rel = _strip(m.name, strip)
            if not rel or _skipped(rel, skip) or m.isdev() or m.isfifo():
                continue
            if not _within(dest, rel):
                raise ValueError("archive member outside the folder")
            out = os.path.join(dest, rel)
            if m.isdir():
                os.makedirs(out, exist_ok=True)
            elif m.issym():
                if os.path.isabs(m.linkname) or not _within(
                    dest, os.path.join(os.path.dirname(rel), m.linkname)
                ):
                    raise ValueError("archive link outside the folder")
                os.makedirs(os.path.dirname(out), exist_ok=True)
                os.symlink(m.linkname, out)
            elif m.isfile():
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with t.extractfile(m) as src, open(out, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                os.chmod(out, _file_mode(stat.S_IMODE(m.mode)))


def _fetch(url, sha256, size, to, base_done, total):
    """Stream ``url`` to ``to`` checking size and sha256, reporting progress (a Cancel stops it between chunks)."""
    from zimi import server as _srv

    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    h = hashlib.sha256()
    got = 0
    with (
        urllib.request.urlopen(
            req, timeout=CONNECT_TIMEOUT_S, context=_srv.SSL_CTX
        ) as resp,
        open(to, "wb") as f,
    ):
        while True:
            _checkpoint()
            chunk = resp.read(CHUNK)
            if not chunk:
                break
            got += len(chunk)
            if got > size * SIZE_SLACK:
                raise ValueError("download larger than pinned")
            h.update(chunk)
            f.write(chunk)
            _set(done=base_done + got, total=total)
    if h.hexdigest() != sha256:
        raise ValueError("checksum mismatch")
    return got


def _run(cmd, env=None):
    """A child whose last words are kept for the log; a Cancel stops its whole group."""
    p = subproc.popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    out = collections.deque(maxlen=20)
    try:
        for line in p.stdout:
            out.append(line)
            _checkpoint()
    except _Cancelled:
        subproc.terminate(p)
        raise
    finally:
        rc = subproc.stop(p)
    if rc != 0:
        log.warning("Add-ons: %s failed:\n%s", loggable(cmd[0]), loggable("".join(out)))
        raise RuntimeError("%s failed" % os.path.basename(cmd[0]))


def _requirement_name(requirement):
    """``playwright==1.64.1`` -> ``playwright``; ``yt-dlp>=2024.1.1`` -> ``yt-dlp``."""
    return re.split(r"[=<>!~ \[;]", requirement, 1)[0].strip().lower().replace("_", "-")


def _wheels(requirements):
    """[(url, sha256, bytes)] a frozen app unpacks in place of ``pip install requirements``: the pinned wheel of each
    package for this OS, CPU and Python, with what Playwright needs beside it. A package nothing is pinned for raises."""
    from zimi import addon_wheels as w

    t, abi, out = target(), _abi(), []
    for req in requirements:
        name = _requirement_name(req)
        if name == "playwright":
            out += [
                w.PLAYWRIGHT_WHEELS[t],
                w.GREENLET_WHEELS[(abi, t)],
                w.UNIVERSAL_WHEELS["pyee"],
                w.UNIVERSAL_WHEELS["typing_extensions"],
            ]
        elif name in w.UNIVERSAL_WHEELS:
            out.append(w.UNIVERSAL_WHEELS[name])
        else:
            raise RuntimeError("no pinned wheel for %s" % name)
    return out


def _install_wheels(part, work, total, done_before):
    """pip's job without pip: each pinned wheel checked and unpacked into the add-on's folder."""
    dest = os.path.join(work, part.dest)
    done = done_before
    for url, sha, size in _wheels(part.requirements):
        _set(step="wheel")
        tmp = os.path.join(work, ".download")
        _fetch(url, sha, size, tmp, done, total)
        try:
            _unpack(tmp, dest, 0)
        finally:
            os.unlink(tmp)
        done += size
    return part.size


def _node_files(work, part):
    """The Node an Npm part runs, and its npm, as this OS lays them out: ``(node, npm-cli.js, bin folder)``. Unix
    keeps them under bin/ and lib/; the Windows zip has node.exe and node_modules at its top."""
    base = os.path.join(work, part.node)
    if _os() == "win":
        return (
            os.path.join(base, "node.exe"),
            os.path.join(base, "node_modules", "npm", "bin", "npm-cli.js"),
            base,
        )
    return (
        os.path.join(base, "bin", "node"),
        os.path.join(base, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        os.path.join(base, "bin"),
    )


def _do_part(part, work, total, done_before):
    c = target()
    if isinstance(part, Archive):
        url, sha, size = part.files[c]
        _set(step=os.path.basename(part.dest))
        tmp = os.path.join(work, ".download")
        _fetch(url, sha, size, tmp, done_before, total)
        _set(step="unpack")
        strip = part.strip.get(c, 0) if isinstance(part.strip, dict) else part.strip
        try:
            _unpack(tmp, os.path.join(work, part.dest), strip, part.skip, exename(part.single) if part.single else "")
        finally:
            os.unlink(tmp)
        return size
    if isinstance(part, Pip) and _frozen():
        return _install_wheels(part, work, total, done_before)
    if isinstance(part, Pip):
        _set(step="pip")
        _run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--no-cache-dir",
                "--disable-pip-version-check",
                "--target",
                os.path.join(work, part.dest),
                *part.requirements,
            ]
        )
        return part.size
    if isinstance(part, Npm):
        _set(step="npm")
        node, npm_cli, node_bin = _node_files(work, part)
        env = dict(os.environ, PATH=node_bin + os.pathsep + os.environ.get("PATH", ""))
        _run(
            [
                node,
                npm_cli,
                "install",
                "-g",
                "--prefix",
                os.path.join(work, part.dest),
                "--no-fund",
                "--no-audit",
                part.package,
            ],
            env=env,
        )
        return part.size
    raise TypeError(part)


#: One install at a time on disk: a job's ensure() and the Add button each ran _install, and two of them on one key
#: shared one .partial folder (each removed the other's half-unpacked files).
_install_serial = threading.Lock()


def _install(key, say=None):
    """Install ``key`` (blocking). Raises on failure; leaves nothing half-installed."""
    with _install_serial:
        if available(key):
            return
        _install_one(key, say)


def _install_one(key, say):
    a = BY_KEY[key]
    base = root()
    work = os.path.join(base, key + PARTIAL)
    final = folder(key)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    total = size_of(a)
    try:
        done = 0
        for part in a.parts:
            done += _do_part(part, work, total, done)
        if a.custom:
            _set(step="build")
            a.custom(work, say or (lambda _l: None))
        shutil.rmtree(final, ignore_errors=True)
        os.makedirs(os.path.dirname(final), exist_ok=True)
        os.replace(work, final)
        with open(os.path.join(final, MARKER), "w", encoding="utf-8") as f:
            json.dump(
                {
                    "key": key,
                    "version": a.version,
                    "installed": int(time.time()),
                    "cpu": cpu(),
                },
                f,
            )
        activate()
        if a.check:
            _set(step="check")
            a.check(final)
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        if not a.custom:
            shutil.rmtree(final, ignore_errors=True)
        raise


def _worker(key):
    err = None
    try:
        for dep in BY_KEY[key].requires:
            if not available(dep):
                _install(dep)
        _install(key)
    except _Cancelled:
        err = "cancelled"
    except Exception as e:
        err = "%s: %s" % (type(e).__name__, e)
        log.warning("Add-ons: %s did not install: %s", loggable(key), loggable(err))
    _finish(key, err)


def _claim(key):
    """Take the one install slot for ``key`` (the state every row and bar reads); False when another install holds it."""
    with _lock:
        if _state.get("key") and not _state.get("finished"):
            return False
        _state.clear()
        _state.update(
            key=key,
            step="",
            done=0,
            total=size_of(BY_KEY[key]),
            error=None,
            cancel=False,
            finished=None,
        )
    return True


def _finish(key, err):
    """Close the slot ``_claim`` took: its error (or none) and the time it ended."""
    _set(
        error=err,
        finished=time.time(),
        step="",
        done=0 if err else _state.get("total", 0),
    )
    if not err:
        log.info("Add-ons: %s installed", loggable(key))


def install(key, actor=None):
    """Start installing ``key`` in the background. ``(ok, error)``: error is "unknown", "never" (the setting or
    ZIMI_OFFLINE), "unsupported", "installed", "busy" or "needs:<key>" never; a missing dependency is installed first.
    """
    if key not in BY_KEY:
        return False, "unknown"
    if POLICY.mode()[0] == outbound.NEVER:
        return False, "never"
    if not supported():
        return False, "unsupported"
    if available(key):
        return False, "installed"
    if not _claim(key):
        return False, "busy"
    log.info("Add-ons: installing %s", loggable(key))
    threading.Thread(
        target=_worker, args=(key,), name="addon-" + key, daemon=True
    ).start()
    return True, None


def cancel():
    _set(cancel=True)


def refusal(key, what):
    """Words for a job that needs ``key`` and cannot have it now: what is missing, then where to add it (or that it is
    coming). One place, so every refusal reads alike."""
    if not supported() or POLICY.mode()[0] == outbound.NEVER:
        return what + "."
    return what + "; add it in Settings > Server > Add-ons (" + key + ")."


def ensure(key, say=None):
    """For a job that needs ``key``: True when it is usable. Under Automatically a missing one is installed first,
    here and now, the job waiting (progress goes to ``say``); under Ask first or Never it is not, and the job says
    so. Reads nothing before the setting has said yes."""
    if available(key):
        return True
    if POLICY.mode()[0] != outbound.AUTO or not supported():
        return False
    say = say or (lambda _l: None)
    say("installing the %s add-on" % key)
    claimed = _claim(key)  # so Manage's row shows it coming, as it does for the Add button's install
    err = None
    try:
        for dep in BY_KEY[key].requires:
            if not available(dep):
                _install(dep, say)
        _install(key, say)
    except Exception as e:
        err = "cancelled" if isinstance(e, _Cancelled) else "%s: %s" % (type(e).__name__, e)
        say("the %s add-on did not install: %s" % (key, e))
    if claimed:
        _finish(key, err)
    return err is None


def _way(key):
    try:
        from zimi import runtimes

        return runtimes.addon_way(key)
    except Exception:
        return None


def status():
    """Everything the setup pane and Manage draw. Reads no network and launches nothing."""
    mode, locked = POLICY.mode()
    with _lock:
        st = dict(_state)
    sup = supported()
    rows = []
    for a in ADDONS:
        have = installed(a.key)
        row = {
            "key": a.key,
            "size": size_of(a) if sup else 0,
            # Not ready while its own install is still checking itself (the browser is launched once): the next
            # install, started the moment this one reads ready, would be refused as busy.
            "ready": available(a.key) and not (st.get("key") == a.key and not st.get("finished")),
            "own": have,
            "requires": list(a.requires),
        }
        # Where this install gets it when it cannot fetch it (runtimes.py): shown in place of a Get that would fail.
        way = _way(a.key)
        if way and not sup and way.note and way.how != "addon":  # an add-on Way on a machine with none pinned would say to go where it cannot be had
            row["note"] = way.note
        if way and way.how == "absent":
            row["absent"] = True
        if st.get("key") == a.key:
            row["progress"] = {
                "done": st.get("done", 0),
                "total": st.get("total", 0),
                "step": st.get("step", ""),
                "active": not st.get("finished"),
                "error": st.get("error"),
                "cancelling": bool(st.get("cancel")) and not st.get("finished"),
            }
        rows.append(row)
    return {
        "supported": sup,
        "mode": mode,
        "locked": locked,
        "env": ENV,
        "choices": list(outbound.MODES),
        "addons": rows,
        "delegated": list(DELEGATED),
    }


def _busy_key():
    with _lock:
        return _state.get("key") if not _state.get("finished") else None


def _custom_venv(key):
    """The venv a custom add-on built, and only its own."""
    from zimi import importer, reddot

    return reddot.sidecar_dir() if key == "reddit" else importer.own_sidecar_dir()


def remove(key):
    """Take an add-on away (its files). True when something went."""
    busy = _busy_key()
    # Not the one installing, nor one it is installing first or will need: its files are in use.
    if key not in BY_KEY or key == busy or (busy in BY_KEY and key in BY_KEY[busy].requires):
        return False
    a = BY_KEY[key]
    gone = os.path.isdir(folder(key))
    shutil.rmtree(folder(key), ignore_errors=True)
    if a.custom:
        venv = _custom_venv(key)
        gone = gone or os.path.isdir(venv)
        shutil.rmtree(venv, ignore_errors=True)
    return gone
