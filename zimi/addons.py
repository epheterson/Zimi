"""Add-ons: the parts of Zimi that are fetched once, into the data folder, instead of riding in the image.

Eric, 2026-11-08: "in 16 let's always stay under a gig and see how low we can go. Balance of everything we need
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
does not have the tool already. The desktop apps and macOS/Windows hosts get no add-ons (``supported()``): they bring
their own runtimes, or say what is needed (runtimes.py).
"""

import collections
import hashlib
import importlib
import json
import logging
import os
import platform
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
from zimi.safety import loggable

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
#: leading path parts are dropped as it is unpacked.
Archive = namedtuple("Archive", "dest strip files")
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


def supported():
    """Whether add-ons can be fetched on this machine: Linux on a CPU the recipes are pinned for, not a frozen
    desktop app (which carries its own runtimes)."""
    return (
        sys.platform.startswith("linux")
        and cpu() is not None
        and not getattr(sys, "frozen", False)
    )


PLAYWRIGHT = "1.64.1"
#: Chrome for Testing build Playwright PLAYWRIGHT expects as revision 1248 (its browsers.json).
CHROME = "156.0.8078.4"
CHROME_REVISION = "1248"
_CFT = "https://storage.googleapis.com/chrome-for-testing-public/" + CHROME + "/"
NODE = "24.19.0"
_NODE = "https://nodejs.org/dist/v" + NODE + "/node-v" + NODE + "-linux-"
SINGLEFILE = "single-file-cli@2.25.0"
FFMPEG = "6.0.1"
_FFMPEG = "https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-" + FFMPEG + "-"
UV = "0.13.7"
_UV = "https://github.com/astral-sh/uv/releases/download/" + UV + "/uv-"

_BROWSER_DIR = os.path.join(
    "ms-playwright", "chromium_headless_shell-" + CHROME_REVISION
)

_ARCHIVES = {
    "chromium": Archive(
        _BROWSER_DIR,
        1,
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
        },
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
        },
    ),
    "uv": Archive(
        "uv",
        1,
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

    uv = os.path.join(root, "uv", "uv")
    venv = importer.sidecar_dir()
    exe = importer._venv_bin(venv, "warc2zim")
    if not importer.build_venv(
        venv, importer.WARC2ZIM_PYTHON, [importer.WARC2ZIM_REQUIREMENT], exe, say, uv=uv
    ):
        raise RuntimeError("warc2zim did not install (the log has the tool's output)")
    importer.finish_sidecar(venv, say)


def _warc2zim_ready():
    from zimi import importer

    return bool(importer.sidecar_status().get("installed"))


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
        ("node/bin", "singlefile/bin"),
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
)
BY_KEY = {a.key: a for a in ADDONS}
#: Not installed here: the Dictionary's voices keep their own setting, download and progress (voices.py).
DELEGATED = ("voices",)
#: What the warc2zim step fetches beyond its archive: Python 3.14 (uv) and the package, about.
WARC2ZIM_EXTRA = 130 * MB


def size_of(addon):
    """About how many bytes installing ``addon`` downloads, known offline."""
    c = cpu()
    total = 0
    for p in addon.parts:
        total += (
            p.files[c][2]
            if isinstance(p, Archive) and c in p.files
            else getattr(p, "size", 0)
        )
    return total + (WARC2ZIM_EXTRA if addon.custom else 0)


# ── where, and what is there ─────────────────────────────────────────────────


def root():
    from zimi import server as _srv

    return os.path.join(_srv.ZIMI_DATA_DIR, "addons")


def folder(key):
    return os.path.join(root(), key)


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
            for rel in a.bins:
                d = os.path.join(base, rel)
                if d not in path:
                    path.append(d)
            os.environ["PATH"] = os.pathsep.join(p for p in path if p)
            for rel in a.pypath:
                d = os.path.join(base, rel)
                if d not in sys.path:
                    sys.path.append(d)
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


def _unpack(archive_path, dest, strip):
    """Unpack a zip or tar into ``dest`` without letting a member leave it; modes and links kept."""
    os.makedirs(dest, exist_ok=True)
    if zipfile.is_zipfile(archive_path):
        with zipfile.ZipFile(archive_path) as z:
            for info in z.infolist():
                rel = _strip(info.filename, strip)
                if not rel:
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
                os.chmod(out, mode or 0o644)
        return
    with tarfile.open(archive_path) as t:
        for m in t:
            rel = _strip(m.name, strip)
            if not rel or m.isdev() or m.isfifo():
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
                os.chmod(out, stat.S_IMODE(m.mode) or 0o644)


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


def _do_part(part, work, total, done_before):
    c = cpu()
    if isinstance(part, Archive):
        url, sha, size = part.files[c]
        _set(step=os.path.basename(part.dest))
        tmp = os.path.join(work, ".download")
        _fetch(url, sha, size, tmp, done_before, total)
        _set(step="unpack")
        try:
            _unpack(tmp, os.path.join(work, part.dest), part.strip)
        finally:
            os.unlink(tmp)
        return size
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
        node = os.path.join(work, part.node, "bin")
        env = dict(os.environ, PATH=node + os.pathsep + os.environ.get("PATH", ""))
        _run(
            [
                os.path.join(node, "node"),
                os.path.join(
                    work, part.node, "lib", "node_modules", "npm", "bin", "npm-cli.js"
                ),
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


def _install(key, say=None):
    """Install ``key`` (blocking). Raises on failure; leaves nothing half-installed."""
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
    with _lock:
        if _state.get("key") and not _state.get("finished"):
            return False, "busy"
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
    log.info("Add-ons: installing %s", loggable(key))
    threading.Thread(
        target=_worker, args=(key,), name="addon-" + key, daemon=True
    ).start()
    return True, None


def cancel():
    _set(cancel=True)


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
    try:
        for dep in BY_KEY[key].requires:
            if not available(dep):
                _install(dep, say)
        _install(key, say)
    except Exception as e:
        say("the %s add-on did not install: %s" % (key, e))
        return False
    return True


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
            "ready": available(a.key),
            "own": have,
            "requires": list(a.requires),
        }
        if st.get("key") == a.key:
            row["progress"] = {
                "done": st.get("done", 0),
                "total": st.get("total", 0),
                "step": st.get("step", ""),
                "active": not st.get("finished"),
                "error": st.get("error"),
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


def remove(key):
    """Take an add-on away (its files). True when something went."""
    if key not in BY_KEY or key == _busy_key():
        return False
    a = BY_KEY[key]
    gone = os.path.isdir(folder(key))
    shutil.rmtree(folder(key), ignore_errors=True)
    if a.custom:
        from zimi import importer

        shutil.rmtree(importer.sidecar_dir(), ignore_errors=True)
    return gone
