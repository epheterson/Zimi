"""Where each optional feature comes from, on each way of installing Zimi.

One table, so a feature cannot quietly dead-end on one kind of install: voices
worked in Docker and the desktop app and offered nothing on ``pip install
zimi`` until someone asked how to download them (#113). Every feature has a
row for every kind; ``zimi doctor`` prints the row for this install with what
is ready now, and CI runs ``zimi doctor --check`` on a bare pip install and in
the image, which fails when something declared bundled is not there.
"""

import importlib.util
import shutil
from collections import namedtuple

DOCKER, DESKTOP, PIP = "docker", "desktop", "pip"
KINDS = (DOCKER, DESKTOP, PIP)

# How a feature arrives on a kind of install.
BUNDLED = "bundled"  # there from the start
SETS_UP = "sets_up"  # Zimi installs it the first time it is used
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
CAN_SET_UP = {"voices": _voices_can_set_up}


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
FEATURES = (
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
            DOCKER: Way(BUNDLED, ""),
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
            DOCKER: Way(BUNDLED, ""),
            DESKTOP: Way(
                ABSENT,
                "needs a browser engine the app does not carry; use pip or Docker",
            ),
            PIP: Way(
                COMMAND, "Settings > Creator shows the two commands for this Python"
            ),
        },
    ),
    Feature(
        "import",
        "Create: import WARC/WACZ (warc2zim)",
        _sidecar("importer"),
        {
            DOCKER: Way(SETS_UP, "the first import sets it up"),
            DESKTOP: Way(ABSENT, "needs Python 3.14 beside the app; use pip or Docker"),
            PIP: Way(
                SETS_UP,
                "the first import sets it up (needs Python 3.14 on PATH); zimi import --setup",
            ),
        },
    ),
    Feature(
        "alive",
        "Create: alive pages (JavaScript kept running)",
        _alive,
        {
            DOCKER: Way(SETS_UP, "the first alive capture sets up warc2zim"),
            DESKTOP: Way(
                ABSENT, "needs the browser engine and warc2zim; use pip or Docker"
            ),
            PIP: Way(
                COMMAND, "the rendered engine's commands, then the import sidecar"
            ),
        },
    ),
    Feature(
        "singlefile",
        "Create: SingleFile pages",
        _singlefile,
        {
            DOCKER: Way(BUNDLED, ""),
            DESKTOP: Way(
                ABSENT, "needs Node and the SingleFile CLI; use pip or Docker"
            ),
            PIP: Way(EXTERNAL, "npm install -g single-file-cli (Node 24+)"),
        },
    ),
    Feature(
        "video",
        "Create: video playlists (yt-dlp)",
        _module("yt_dlp"),
        {
            DOCKER: Way(BUNDLED, ""),
            DESKTOP: Way(ABSENT, "yt-dlp is not in the app; use pip or Docker"),
            PIP: Way(EXTERNAL, "pip install yt-dlp (and ffmpeg for YouTube)"),
        },
    ),
    Feature(
        "reddot",
        "Create: subreddits (ArcticZim)",
        _sidecar("reddot"),
        {
            DOCKER: Way(SETS_UP, "the first subreddit capture sets it up"),
            DESKTOP: Way(ABSENT, "needs a Python beside the app; use pip or Docker"),
            PIP: Way(
                SETS_UP,
                "the first subreddit capture sets it up; zimi create --setup-reddit",
            ),
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


def install_kind():
    """docker, desktop or pip, from the same facts the update instructions use."""
    from zimi.manage import detect_install_type

    t = detect_install_type()
    if t == "docker":
        return DOCKER
    if t in ("snap", "appimage") or t.startswith("desktop"):
        return DESKTOP
    return PIP


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
        if not ready and (way.how == BUNDLED or (way.how == SETS_UP and stuck(f)))
    ]


_HOW_TEXT = {
    BUNDLED: "included",
    SETS_UP: "sets itself up",
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
