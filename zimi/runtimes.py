"""Where each optional feature comes from, on each way of installing Zimi.

One table, so a feature cannot quietly dead-end on one kind of install: voices
worked in Docker and the desktop app and offered nothing on ``pip install
zimi`` until someone asked how to download them (#113). Every feature has a
row for every kind; ``zimi doctor`` prints the row for this install with what
is ready now, and CI runs ``zimi doctor --check`` on a bare pip install and in
the image, which fails when something declared bundled is not there.
"""

import importlib.util
import os
import shutil
import sys
import tempfile
from collections import namedtuple

DOCKER, DESKTOP, PORTABLE, PIP = "docker", "desktop", "portable", "pip"
KINDS = (DOCKER, DESKTOP, PORTABLE, PIP)

# How a feature arrives on a kind of install.
BUNDLED = "bundled"  # there from the start
SETS_UP = "sets_up"  # Zimi installs it the first time it is used
ADDON = "addon"  # an add-on (addons.py): fetched once into the data folder, under Ask first / Automatically / Never
EXTRA = "extra"  # pip install "zimi[<extra>]"
COMMAND = "command"  # one named command installs it
EXTERNAL = "external"  # the operator installs a tool Zimi calls
ABSENT = "absent"  # not offered on this kind

Way = namedtuple("Way", "how note")


def _module(name):
    return lambda: importlib.util.find_spec(name) is not None


def _voices():
    from zimi import voices

    return bool(voices.runtime(voices.PIPER) or voices.runtime(voices.KOKORO))


def _voices_can_set_up():
    """Whether the first voice download could install the engines here: a
    Python install that can make a venv with pip in it (Debian's python3
    without python3-venv cannot), or uv to make one."""
    from zimi import voices

    return voices._can_set_up() and bool(shutil.which("uv") or _module("ensurepip")())


# For a feature that sets itself up: whether it could, on this install. Not
# ready is fine (it has not been used yet); unable is a dead end (#113).
def _addons_can_set_up():
    """Whether an add-on could be fetched here: Linux on a CPU the recipes are pinned for."""
    from zimi import addons

    return addons.supported()


CAN_SET_UP = {
    "voices": _voices_can_set_up,
    **{key: _addons_can_set_up for key in ("rendered", "import", "alive", "singlefile", "video", "reddot")},
}


def _bt():
    from zimi import p2p

    # libtorrent here, or a qBittorrent / Transmission chosen as the engine.
    return p2p._lt() is not None or p2p.engine_name() != "libtorrent"


def _sidecar(module):
    def ready():
        mod = importlib.import_module("zimi." + module)
        return bool(mod.sidecar_status().get("installed"))

    return ready


def _singlefile():
    from zimi.singlefile import singlefile_available

    return singlefile_available()


def _zimit():
    return shutil.which("docker") is not None


def _browser():
    # The package alone is not a browser: doctor launches Chromium once, as
    # the renderer does before a capture (a CLI, so the 2-3 s is fine).
    if not _module("playwright")():
        return False
    from zimi.renderer import browser_available

    return browser_available()


def _alive():
    return _browser() and _sidecar("importer")()


Feature = namedtuple("Feature", "key name ready ways")

# Every Way.note is what a person on that install reads: how to get it, or why
# it is not there.
_FEATURES = (
    Feature(
        "bittorrent",
        "BitTorrent downloads and seeding",
        _bt,
        {
            DOCKER: Way(BUNDLED, ""),
            DESKTOP: Way(BUNDLED, ""),
            PIP: Way(
                EXTRA,
                'pip install "zimi[bt]" (no wheel for Python 3.14 yet), or use a qBittorrent or Transmission you run',
            ),
        },
    ),
    Feature(
        "voices",
        "Dictionary voices (Piper, Kokoro)",
        _voices,
        {
            DOCKER: Way(ADDON, "the first voice download sets them up"),
            DESKTOP: Way(BUNDLED, "the app's voice helper"),
            PIP: Way(
                SETS_UP,
                'the first voice download sets them up; or pip install "zimi[voices]"',
            ),
        },
    ),
    Feature(
        "pdf",
        "PDF pages and text",
        _module("fitz"),
        {
            DOCKER: Way(BUNDLED, ""),
            DESKTOP: Way(BUNDLED, ""),
            PIP: Way(EXTRA, 'pip install "zimi[pdf]"'),
        },
    ),
    Feature(
        "mcp",
        "MCP server for AI agents",
        _module("mcp"),
        {
            DOCKER: Way(BUNDLED, ""),
            DESKTOP: Way(
                ABSENT, "run the MCP server from pip or Docker; the app is a reader"
            ),
            PIP: Way(EXTRA, 'pip install "zimi[mcp]", or the zimi-mcp package'),
        },
    ),
    Feature(
        "rendered",
        "Create: pages built by JavaScript",
        _browser,
        {
            DOCKER: Way(ADDON, "Settings > Server > Add-ons: Browser"),
            DESKTOP: Way(ADDON, "Settings > Server > Add-ons: Browser"),
            PIP: Way(ADDON, "Settings > Server > Add-ons: Browser"),
        },
    ),
    Feature(
        "import",
        "Create: import WARC/WACZ (warc2zim)",
        _sidecar("importer"),
        {
            DOCKER: Way(ADDON, "Settings > Server > Add-ons: Import"),
            DESKTOP: Way(ADDON, "Settings > Server > Add-ons: Import (it fetches its own Python 3.14)"),
            PIP: Way(ADDON, "Settings > Server > Add-ons: Import (it fetches its own Python 3.14)"),
        },
    ),
    Feature(
        "alive",
        "Create: alive pages (JavaScript kept running)",
        _alive,
        {
            DOCKER: Way(ADDON, "Settings > Server > Add-ons: Browser and Import"),
            DESKTOP: Way(ADDON, "Settings > Server > Add-ons: Browser and Import"),
            PIP: Way(ADDON, "Settings > Server > Add-ons: Browser and Import"),
        },
    ),
    Feature(
        "singlefile",
        "Create: SingleFile pages",
        _singlefile,
        {
            DOCKER: Way(ADDON, "Settings > Server > Add-ons: SingleFile"),
            DESKTOP: Way(ADDON, "Settings > Server > Add-ons: SingleFile"),
            PIP: Way(ADDON, "Settings > Server > Add-ons: SingleFile"),
        },
    ),
    Feature(
        "video",
        "Create: video playlists (yt-dlp)",
        _module("yt_dlp"),
        {
            DOCKER: Way(ADDON, "Settings > Server > Add-ons: Video"),
            DESKTOP: Way(ADDON, "Settings > Server > Add-ons: Video"),
            PIP: Way(ADDON, "Settings > Server > Add-ons: Video"),
        },
    ),
    Feature(
        "reddot",
        "Create: subreddits (ArcticZim)",
        _sidecar("reddot"),
        {
            DOCKER: Way(ADDON, "Settings > Server > Add-ons: Reddit"),
            DESKTOP: Way(ADDON, "Settings > Server > Add-ons: Reddit"),
            PIP: Way(ADDON, "Settings > Server > Add-ons: Reddit (or the first subreddit capture sets it up)"),
        },
    ),
    Feature(
        "zimit",
        "Create: whole-site crawls with zimit",
        _zimit,
        {
            DOCKER: Way(
                ABSENT,
                "zimit runs in its own container; Zimi's own crawler is built in",
            ),
            DESKTOP: Way(EXTERNAL, "Docker Desktop; Zimi runs the zimit image"),
            PIP: Way(EXTERNAL, "Docker; Zimi runs the zimit image"),
        },
    ),
)

# The portable headless Linux build (packaging/desktop/zimi_portable.spec): the server, libzim and PDF pages in one
# folder, no Python on the machine. What it leaves out is left out for size and because it needs a Python
# or a browser beside it; every row says where to get that.
_PORTABLE_WAYS = {
    "bittorrent": Way(
        EXTERNAL, "not in the portable build; a qBittorrent or Transmission you run works, or use Docker"
    ),
    "voices": Way(ABSENT, "not in the portable build; use Docker or pip"),
    "pdf": Way(BUNDLED, ""),
    "mcp": Way(ABSENT, "not in the portable build; use pip or Docker"),
    "rendered": Way(ADDON, "Settings > Server > Add-ons: Browser"),
    "import": Way(ADDON, "Settings > Server > Add-ons: Import (it fetches its own Python 3.14)"),
    "alive": Way(ADDON, "Settings > Server > Add-ons: Browser and Import"),
    "singlefile": Way(ADDON, "Settings > Server > Add-ons: SingleFile"),
    "video": Way(ADDON, "Settings > Server > Add-ons: Video"),
    "reddot": Way(ADDON, "Settings > Server > Add-ons: Reddit"),
    "zimit": Way(EXTERNAL, "Docker; Zimi runs the zimit image"),
}
FEATURES = tuple(f._replace(ways={**f.ways, PORTABLE: _PORTABLE_WAYS[f.key]}) for f in _FEATURES)


def install_kind():
    """docker, desktop, portable or pip, from the same facts the update instructions use."""
    from zimi.manage import detect_install_type

    t = detect_install_type()
    if t == "docker":
        return DOCKER
    if t == "portable":
        return PORTABLE
    if t in ("snap", "appimage") or t.startswith("desktop"):
        return DESKTOP
    return PIP


#: Which Create feature each add-on brings (addons.py key -> the row above), so its Way is what a person reads.
ADDON_FEATURES = {"browser": "rendered", "singlefile": "singlefile", "video": "video", "warc2zim": "import", "reddit": "reddot"}


def way_for(feature_key, kind=None):
    """How ``feature_key`` arrives on this kind of install (a Way), or None for a key the table does not have."""
    kind = kind or install_kind()
    for f in FEATURES:
        if f.key == feature_key:
            return f.ways[kind]
    return None


def addon_way(key, kind=None):
    """The Way of the feature an add-on brings; None when it has no row."""
    feature = ADDON_FEATURES.get(key)
    return way_for(feature, kind) if feature else None


# ── is the data folder kept? ──────────────────────────────────────────────
# A container whose data folder is not on a mount of its own loses settings, indexes and add-ons when it is replaced.
# someone who runs `docker run` without `-v ...:/config` should be told once.
_MOUNT_NOT_KEPT = ("/", "tmpfs", "overlay", "ramfs", "rootfs")  # the container's own layer is thrown away with it


def parse_mountinfo(text):
    """[(mount point, filesystem type)] from /proc/self/mountinfo: field 5 is the mount point (spaces escaped as
    \\040), the filesystem type follows the " - " separator."""
    out = []
    for line in str(text or "").splitlines():
        head, sep, tail = line.partition(" - ")
        fields = head.split()
        if not sep or len(fields) < 5 or not tail.split():
            continue
        point = fields[4].replace("\\040", " ")
        out.append((point, tail.split()[0]))
    return out


def data_dir_kept(data_dir, mounts):
    """Whether ``data_dir`` sits on a mount that outlives the container: the deepest mount holding it is neither the
    container's own root layer nor a tmpfs. ``mounts`` is parse_mountinfo's list."""
    path = os.path.realpath(data_dir).rstrip("/") + "/"
    best = ("/", "rootfs")
    for point, fstype in mounts:
        p = point.rstrip("/") + "/"
        if path.startswith(p) and len(p) >= len(best[0].rstrip("/") + "/"):
            best = (point, fstype)
    return best[0] != "/" and best[1] not in _MOUNT_NOT_KEPT


_config_kept = "unset"


def config_kept(data_dir=None):
    """True or False for a Docker install (is its data folder on a volume?); None where it does not apply (not
    Docker) or cannot be told. Read once: a mount does not change under a running container."""
    global _config_kept
    if _config_kept != "unset" and data_dir is None:
        return _config_kept
    result = None
    try:
        if install_kind() == DOCKER:
            if data_dir is None:
                from zimi import server

                data_dir = server.ZIMI_DATA_DIR
            with open("/proc/self/mountinfo", encoding="utf-8") as f:
                mounts = parse_mountinfo(f.read())
            result = data_dir_kept(data_dir, mounts) if mounts else None
    except Exception:
        result = None
    if data_dir is None or _config_kept == "unset":
        _config_kept = result
    return result


def _ready(feature):
    try:
        return bool(feature.ready())
    except Exception:
        return False


def report(kind=None):
    """[(feature, way, ready)] for one kind of install, in table order."""
    kind = kind or install_kind()
    return [(f, f.ways[kind], _ready(f)) for f in FEATURES]


def problems(rows):
    """The features declared bundled that are not ready, and those that set
    themselves up but could not here: the table is wrong about this install,
    or the install is broken."""

    def stuck(f):
        try:
            return not CAN_SET_UP.get(f.key, lambda: True)()
        except Exception:
            return True

    return [
        f.key
        for f, way, ready in rows
        if not ready and (way.how == BUNDLED or (way.how in (SETS_UP, ADDON) and stuck(f)))
    ]


_HOW_TEXT = {
    BUNDLED: "included",
    SETS_UP: "sets itself up",
    ADDON: "add-on",
    EXTRA: "optional extra",
    COMMAND: "one command",
    EXTERNAL: "separate tool",
    ABSENT: "not available",
}


def format_report(rows, kind):
    width = max(len(f.name) for f, _w, _r in rows)
    lines = [f"Zimi features on this install ({kind})", ""]
    for f, way, ready in rows:
        state = "ready" if ready else _HOW_TEXT[way.how]
        line = f"  {'*' if ready else '-'} {f.name.ljust(width)}  {state}"
        if not ready and way.note:
            line += f": {way.note}"
        lines.append(line)
    return "\n".join(lines)


# What the machine's python3 prints: whether it can import ssl, and the library path it was handed.
_OUTSIDE_PROBE = "import os, ssl; print(os.environ.get('LD_LIBRARY_PATH', ''))"


def _probe(python):
    """Run the probe with ``python`` the way the app starts any outside program; a problem as text, or None."""
    from zimi import subproc

    try:
        done = subproc.run([python, "-c", _OUTSIDE_PROBE], capture_output=True, text=True, timeout=30)
    except Exception as e:
        return f"could not run {python}: {e}"
    if done.returncode != 0:
        return f"{python} cannot import ssl: {(done.stderr or '').strip()[-200:]}"
    handed = [d for d in done.stdout.strip().split(os.pathsep) if d]
    if any(subproc._in_bundle(d) for d in handed):
        return f"{python} was handed the app's library path ({done.stdout.strip()})"
    return None


def _venv_python_problem(python):
    """The same probe through a venv python in the data folder, where voices keep theirs: beside the executable on a
    portable build, which is what #151's second spawn (``<venv>/bin/python -m pip``) was. Offline: the venv has no pip."""
    from zimi import server as _srv
    from zimi import subproc

    tools = os.path.join(_srv.ZIMI_DATA_DIR, "tools")
    venv = None
    try:
        os.makedirs(tools, exist_ok=True)
        venv = tempfile.mkdtemp(prefix="doctor-probe-", dir=tools)
        made = subproc.run([python, "-m", "venv", "--without-pip", venv], capture_output=True, text=True, timeout=120)
        if made.returncode != 0:
            return f"{python} cannot make a venv: {(made.stderr or '').strip()[-200:]}"
        bin_dir = "Scripts" if os.name == "nt" else "bin"
        return _probe(os.path.join(venv, bin_dir, "python" + (".exe" if os.name == "nt" else "")))
    except Exception as e:
        return f"{python} cannot make a venv in {tools}: {e}"
    finally:
        if venv:
            shutil.rmtree(venv, ignore_errors=True)


def outside_python_problem(python=None, venv=False):
    """Frozen only: why a program that is not part of this app (the machine's
    python3, which sets up voices) would not run properly from here, or None.
    The bootloader's library path must not reach it (#151: its older libssl
    broke pip on a Raspberry Pi). With ``venv``, a venv made in the data
    folder is probed too: that python is the one that runs pip."""
    if not getattr(sys, "frozen", False):
        return None
    python = python or shutil.which("python3")
    if not python:
        return None
    problem = _probe(python)
    if problem is None and venv:
        problem = _venv_python_problem(python)
    return problem


def cli_doctor(args):
    """`zimi doctor [--check]`. Exit 1 under --check when a bundled feature
    is missing."""
    kind = args.kind or install_kind()
    rows = report(kind)
    print(format_report(rows, kind))
    missing = problems(rows)
    if missing:
        print(f"\nnot ready, though this install should have them: {', '.join(missing)}")
        if args.check:
            raise SystemExit(1)
    outside = outside_python_problem(venv=args.check)
    if outside:
        print(f"\nthe machine's Python would not run properly from here: {outside}")
        if args.check:
            raise SystemExit(1)
