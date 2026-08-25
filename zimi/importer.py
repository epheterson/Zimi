"""WARC/WACZ → library ZIM — `zimi import <file.warc|.warc.gz|.wacz>`.

Conversion is done by openZIM's warc2zim, which can never be a direct Zimi
dependency: it pins ``requires-python >=3.14,<3.15`` plus a stack of exact
native-dep versions, and it is GPL-3 — the dependency boundary and the
license boundary are the same boundary. So warc2zim runs as a SIDECAR: a
dedicated venv under ``<data_dir>/tools/warc2zim/``, created on first use
with the best suitable interpreter on the machine and invoked strictly as a
subprocess.

Sidecar contract:

* Location: ``<data_dir>/tools/warc2zim/`` (a normal venv; its console
  script at ``bin/warc2zim`` — ``Scripts\\warc2zim.exe`` on Windows — is
  what Zimi runs). The venv is built in place and stamped with a marker
  file (``.zimi-sidecar.json``) only after ``pip install warc2zim``
  succeeds; a dir without the marker is a broken half-install and gets
  rebuilt. Venvs bake absolute paths into their scripts, so the build
  cannot use tmp-then-rename — the marker is the atomicity substitute.
* Interpreter: warc2zim requires Python >=3.14,<3.15. Zimi probes, in
  order, its own interpreter, ``python3.14``, and ``python3``, and takes
  the first whose version fits. None suitable → a clear error naming the
  requirement.
* Network: creating the venv runs ``pip install`` — a network operation.
  Under ``ZIMI_OFFLINE`` it is refused with a message pointing at the
  pre-seed path: run ``zimi import --setup`` once while the machine is
  connected (or install manually:
  ``python3.14 -m venv <data_dir>/tools/warc2zim`` then
  ``<venv>/bin/pip install warc2zim``, then run ``--setup`` to stamp it —
  or simply run one import). The conversion itself is fully local, so an
  air-gapped box with a pre-seeded sidecar imports archives forever.

The archive itself is deliberately uncapped — multi-GB WARCs are the
point. warc2zim's output streams through line by line, the finished ZIM is
staged next to its final path and ``os.replace``d into place (a partial
ZIM never appears under its final name), and the result registers into the
library through the same incremental path ``zimi create`` uses.
"""

import collections
import json
import os
import shutil
import subprocess
import sys
import tempfile

import zimi.server as _srv
from zimi.creator import CreateError, _finish_output, _try_register
from zimi.p2p import is_offline
from zimi.zimwriter import _slug, scraper_string

# warc2zim's own pin (see docs/plans/2026-08-10-zim-creation-landscape.md §5):
# a single Python minor version. Bump both bounds together when upstream moves.
WARC2ZIM_PY_MIN = (3, 14)
WARC2ZIM_PY_MAX_EXCL = (3, 15)
WARC2ZIM_REQUIREMENT = "warc2zim"
PY_REQUIREMENT_TEXT = "Python >=3.14,<3.15"

_SIDECAR_MARKER = ".zimi-sidecar.json"
ARCHIVE_EXTS = (".warc", ".warc.gz", ".wacz")
# warc2zim's flag for appending to the Scraper metadata it writes.
SCRAPER_SUFFIX_FLAG = "--scraper-suffix"

OFFLINE_PRESEED_MSG = (
    "ZIMI_OFFLINE is set — installing the warc2zim sidecar needs the network "
    "(pip install into {dir}). Pre-seed it while connected: run "
    "`zimi import --setup` once, or manually create the venv with "
    "`python3.14 -m venv {dir}` and `{dir}/bin/pip install warc2zim`. "
    "Conversion itself is fully local once the sidecar exists."
)


# ── subprocess seams (monkeypatched in tests — no real pip runs there) ──────


def _run_capture(cmd, timeout=60):
    """Run a short command, return ``(returncode, stripped stdout)``. Any
    launch failure reads as a nonzero exit — probes treat both the same."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return p.returncode, (p.stdout or "").strip()


def _run_stream(cmd, sink):
    """Run a command, streaming every combined-output line through ``sink``.
    No timeout — warc2zim over a multi-GB WARC legitimately runs for hours."""
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except OSError as e:
        sink(f"cannot run {cmd[0]}: {e}")
        return 1
    for line in proc.stdout or ():
        sink(line.rstrip("\n"))
    return proc.wait()


# ── sidecar venv management ─────────────────────────────────────────────────


def sidecar_dir():
    return os.path.join(_srv.ZIMI_DATA_DIR, "tools", "warc2zim")


def _venv_bin(venv, name):
    if os.name == "nt":
        return os.path.join(venv, "Scripts", name + ".exe")
    return os.path.join(venv, "bin", name)


def _marker_path(venv):
    return os.path.join(venv, _SIDECAR_MARKER)


def _read_marker(venv):
    try:
        with open(_marker_path(venv), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_marker(venv, **fields):
    with open(_marker_path(venv), "w", encoding="utf-8") as f:
        json.dump(fields, f, indent=2)


def _installed(venv):
    """Installed = console script present AND the post-install marker exists.
    A dir missing either is a broken half-install and gets rebuilt."""
    return os.path.exists(_venv_bin(venv, "warc2zim")) and os.path.exists(
        _marker_path(venv)
    )


def _python_candidates():
    cands = [sys.executable, "python3.14", "python3"]
    seen = set()
    out = []
    for c in cands:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _probe_python(cand):
    """``(major, minor)`` reported by the candidate interpreter, or None."""
    rc, out = _run_capture(
        [cand, "-c", "import sys; print('%d %d' % sys.version_info[:2])"]
    )
    if rc != 0:
        return None
    try:
        major, minor = (int(x) for x in out.split())
    except ValueError:
        return None
    return major, minor


def _find_python():
    """First interpreter satisfying warc2zim's pin; CreateError names the
    requirement (and what WAS found) when nothing fits."""
    found = []
    for cand in _python_candidates():
        ver = _probe_python(cand)
        if ver is None:
            continue
        if WARC2ZIM_PY_MIN <= ver < WARC2ZIM_PY_MAX_EXCL:
            return cand, ver
        found.append(f"{cand} is {ver[0]}.{ver[1]}")
    detail = f" (checked: {'; '.join(found)})" if found else ""
    raise CreateError(
        f"warc2zim requires {PY_REQUIREMENT_TEXT} and no suitable interpreter "
        f"was found{detail}. Install Python 3.14 and re-run."
    )


def _supports_flag(exe, flag):
    """Whether this warc2zim knows ``flag``. The sidecar is whatever pip had
    on the day it was built, so a stamp Zimi wants must never be the reason an
    import fails — an older warc2zim simply doesn't get asked for it."""
    rc, out = _run_capture([exe, "--help"])
    return rc == 0 and flag in out


def _tool_version(exe):
    rc, out = _run_capture([exe, "--version"])
    if rc != 0 or not out:
        return None
    return out.split()[-1]


def ensure_sidecar(sink=None):
    """Return the warc2zim console-script path, installing the sidecar venv
    on first use. Raises CreateError when offline (with the pre-seed story),
    when no suitable Python exists, or when the install fails."""
    say = sink or (lambda _line: None)
    venv = sidecar_dir()
    exe = _venv_bin(venv, "warc2zim")
    if _installed(venv):
        # An ALREADY-installed sidecar gets the patch check too, not just a
        # freshly built one. Hooking only the install path meant every machine
        # that had run an import before the fix kept the shredding
        # zimscraperlib forever — prod's sidecar lives in a persistent volume,
        # so it survived every deploy and every alive capture there came out
        # with its images pointing at fragments of a query string while the
        # same capture ran clean locally.
        #
        # Cheap and idempotent: reads one file, and returns "not needed" the
        # moment upstream ships the fix. Recorded in the marker either way, so
        # `zimi import --status` can say what this machine is actually running.
        state = _patch_srcset_comma_bug(venv, say)
        if state == "applied":
            marker = _read_marker(venv)
            marker["srcset_patch"] = state
            _write_marker(venv, **marker)
        return exe
    if is_offline():
        raise CreateError(OFFLINE_PRESEED_MSG.format(dir=venv))
    if os.path.isdir(venv):
        # No marker: a previous install died mid-flight. Rebuild from scratch —
        # a venv can't be repaired-in-place with any confidence.
        shutil.rmtree(venv)
    py, ver = _find_python()
    os.makedirs(os.path.dirname(venv), exist_ok=True)
    say(f"creating warc2zim sidecar (Python {ver[0]}.{ver[1]} via {py}) at {venv}")
    rc = _run_stream([py, "-m", "venv", venv], say)
    if rc == 0:
        rc = _run_stream(
            [
                _venv_bin(venv, "python"),
                "-m",
                "pip",
                "install",
                "--upgrade",
                WARC2ZIM_REQUIREMENT,
            ],
            say,
        )
    if rc != 0 or not os.path.exists(exe):
        shutil.rmtree(venv, ignore_errors=True)
        # Never "see the output above": by the time anyone reads this in a
        # journal or an activity row, the stream it pointed at is gone.
        raise CreateError(
            "warc2zim sidecar install failed (the job log has the tool's "
            "output). Nothing was left behind; re-run to try again."
        )
    version = _tool_version(exe)
    patched = _patch_srcset_comma_bug(venv, say)
    _write_marker(
        venv, warc2zim=version, python=f"{ver[0]}.{ver[1]}", srcset_patch=patched
    )
    say(f"warc2zim {version or '(unknown version)'} ready")
    return exe


# ── one upstream bug, held open until upstream closes it ────────────────────
#
# zimscraperlib's srcset rewriter splits the attribute on a bare comma:
#
#     value_list = attr_value.split(",")          # rewriting/html.py
#
# A srcset candidate URL may itself CONTAIN commas — every Cloudinary- or
# imgix-style image API puts them in the transform segment, and CNN's does:
# `?c=16x9&q=h_720,w_1280,c_fill/f_webp`. Split on the bare comma and one
# candidate becomes three: a URL truncated at the first comma, then `w_1280`,
# then `c_fill/f_webp`. All three are rewritten into the ZIM as image
# addresses, and the page renders with almost no pictures.
#
# Measured on a warc2zim 2.3.1 capture of cnn.com: 289 fragment candidates
# across 163 srcset attributes, 2 of 68 images rendering. It affects warc2zim,
# zimit and every openZIM scraper that rewrites HTML, so it is being reported
# upstream rather than only worked around — but the alive engine is unusable on
# a large slice of the web until that lands, and a shipped engine that produces
# archives with no pictures is not a thing to ship.
#
# So: a surgical, idempotent, self-removing patch. It matches the exact buggy
# body, refuses to touch anything else, and does nothing at all once the
# installed version no longer contains it. The marker records whether it
# applied, so an operator can tell what their sidecar is running.
_SRCSET_BUG = 'value_list = attr_value.split(",")'

_SRCSET_FIX = """value_list = _zimi_split_srcset(attr_value)"""

_SRCSET_HELPER = '''

def _zimi_split_srcset(value):
    """Split a srcset into candidate strings per the HTML spec.

    Patched in by Zimi. A candidate URL may contain commas, so splitting the
    attribute on one shreds it. The spec's rule is positional: skip leading
    whitespace and commas, take the run of non-whitespace as the URL, and
    everything to the next comma is the descriptor. Returns the candidates in
    the shape the caller already expects — "<url> <descriptor>" strings.
    """
    out = []
    i, n = 0, len(value)
    while i < n:
        while i < n and (value[i].isspace() or value[i] == ","):
            i += 1
        if i >= n:
            break
        start = i
        while i < n and not value[i].isspace():
            i += 1
        url = value[start:i]
        desc_start = i
        while i < n and value[i] != ",":
            i += 1
        descriptor = value[desc_start:i].strip()
        out.append(url + " " + descriptor if descriptor else url)
    return out
'''


def _patch_srcset_comma_bug(venv, say):
    """Fix zimscraperlib's srcset splitter in this venv. Returns what happened.

    Idempotent and self-removing: a version that no longer carries the bug is
    left untouched and reports "not needed", so the day upstream ships the fix
    this quietly stops doing anything."""
    import glob

    hits = glob.glob(
        os.path.join(
            venv, "lib", "*", "site-packages", "zimscraperlib", "rewriting", "html.py"
        )
    )
    if not hits:
        return "not found"
    path = hits[0]
    try:
        with open(path, encoding="utf-8") as f:
            source = f.read()
    except OSError:
        return "unreadable"
    if _SRCSET_BUG not in source:
        return "not needed"
    patched = source.replace(_SRCSET_BUG, _SRCSET_FIX, 1) + _SRCSET_HELPER
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(patched)
    except OSError as e:
        say(f"could not patch zimscraperlib's srcset splitter: {e}")
        return "failed"
    say("patched zimscraperlib's srcset splitter (upstream comma bug)")
    return "applied"


def sidecar_status():
    """``{"dir", "installed", "version", "python"}`` — version live from the
    tool when possible, else from the install marker."""
    venv = sidecar_dir()
    installed = _installed(venv)
    marker = _read_marker(venv) if installed else {}
    version = None
    if installed:
        version = _tool_version(_venv_bin(venv, "warc2zim")) or marker.get("warc2zim")
    return {
        "dir": venv,
        "installed": installed,
        "version": version,
        "python": marker.get("python"),
    }


# ── the import itself ───────────────────────────────────────────────────────


def _archive_stem(filename):
    low = filename.lower()
    for ext in (".warc.gz",) + ARCHIVE_EXTS:
        if low.endswith(ext):
            return filename[: -len(ext)]
    return os.path.splitext(filename)[0]


def convert_archive(
    archive,
    out,
    *,
    zim_name,
    title=None,
    description=None,
    main_url=None,
    language=None,
    tags=None,
    creator_name=None,
    source=None,
    sink=None,
):
    """Run the sidecar over one archive and land the ZIM at ``out``.

    The conversion, alone: no path derivation, no library registration, no
    argument validation beyond what warc2zim itself will do. ``zimi import``
    reaches this through ``import_archive`` and the alive engine reaches it
    directly, which is the whole reason it is its own function — the alive
    engine already knows its output path, its title and which URL is the main
    page, and none of that should have to be reverse-engineered from a
    filename.

    Every optional field is omitted from the command line when it is not
    given, so the flags ``zimi import`` sends are exactly the flags it has
    always sent. Raises CreateError on any failure."""
    say = sink or (lambda _line: None)
    exe = ensure_sidecar(sink=sink)
    # warc2zim writes into a staging dir BESIDE the final path (same
    # filesystem, so the finishing os.replace is atomic — a partial ZIM
    # never appears under its final name).
    staging = tempfile.mkdtemp(prefix=".zimi-import-", dir=os.path.dirname(out))
    cmd = [
        exe,
        archive,
        "--name",
        zim_name,
        "--output",
        staging,
        "--zim-file",
        os.path.basename(out),
    ]
    if title:
        cmd += ["--title", title]
    if description:
        cmd += ["--description", description]
    # Which URL the ZIM opens on. Without it warc2zim takes the first text/html
    # record it meets, which for a site crawl is the seed only by luck.
    if main_url:
        cmd += ["--url", main_url]
    if language:
        cmd += ["--lang", language]
    if tags:
        cmd += ["--tags", tags]
    if creator_name:
        cmd += ["--creator", creator_name]
    if source:
        cmd += ["--source", source]
    # warc2zim writes the ZIM, so Zimi has no Creator to add its own metadata
    # to. The Scraper string is the one field it can reach: warc2zim appends
    # this suffix to its own, so the ZIM still says which Zimi made it.
    if _supports_flag(exe, SCRAPER_SUFFIX_FLAG):
        cmd += [SCRAPER_SUFFIX_FLAG, scraper_string()]
    try:
        say(f"converting {os.path.basename(archive)} with warc2zim…")
        # Keep the last few output lines riding along with the failure. The
        # live log is a stream: by the time anyone reads a failed job's journal
        # record, "the output above" no longer exists anywhere. A prod
        # conversion failure was undiagnosable for exactly this reason (the
        # real error — a missing libmagic — lived only in the vanished stream).
        tail = collections.deque(maxlen=6)

        def _say_and_keep(line):
            tail.append(line)
            say(line)

        rc = _run_stream(cmd, _say_and_keep)
        if rc != 0:
            detail = "; ".join(t.strip() for t in tail if t.strip())[-400:]
            suffix = f": {detail}" if detail else " and printed nothing"
            raise CreateError(f"warc2zim failed (exit {rc}){suffix}")
        staged = os.path.join(staging, os.path.basename(out))
        if not os.path.exists(staged):
            raise CreateError("warc2zim reported success but produced no ZIM file")
        os.replace(staged, out)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return out


def import_archive(
    archive,
    *,
    name=None,
    title=None,
    description=None,
    out_dir=None,
    out_path=None,
    register=False,
    sink=None,
):
    """Convert one WARC/WARC.GZ/WACZ into a ZIM via the sidecar. Returns
    ``{"path", "name", "registered"}``; raises CreateError with a user-facing
    message on refusal. The archive size is deliberately uncapped.

    Provenance is thinner than in Zimi's own engines because warc2zim writes
    the ZIM: there is no Creator to add ``X-Zimi-History`` to. Zimi stamps what
    it can reach — its name and version, appended to warc2zim's Scraper."""
    archive = os.path.abspath(archive)
    if not os.path.isfile(archive):
        raise CreateError(f"archive not found: {archive}")
    if not archive.lower().endswith(ARCHIVE_EXTS):
        raise CreateError(
            "not a web archive — expected .warc, .warc.gz or .wacz, got "
            + os.path.basename(archive)
        )
    # Before the output path is resolved, which creates a directory: a machine
    # with no sidecar and no network refuses this import, and it must refuse it
    # without having made anything first. convert_archive asks again, and the
    # second ask is two stat calls.
    ensure_sidecar(sink=sink)
    stem = _archive_stem(os.path.basename(archive))
    zim_name = name or _slug(stem, "archive")
    out = _finish_output(out_dir or _srv.ZIM_DIR, out_path, zim_name)
    convert_archive(
        archive,
        out,
        zim_name=zim_name,
        title=title,
        description=description,
        sink=sink,
    )
    registered = _try_register(out) if register else False
    return {"path": out, "name": zim_name, "registered": registered}


# ── CLI ─────────────────────────────────────────────────────────────────────


def cli_import(args):
    """`zimi import` — convert an archive, or report/prepare the sidecar.
    Exit 2 with a one-line message on any user-fixable failure, matching the
    create/backup CLI convention."""
    if args.status:
        st = sidecar_status()
        if st["installed"]:
            ver = st["version"] or "unknown version"
            py = f", Python {st['python']}" if st["python"] else ""
            print(f"warc2zim sidecar: installed (warc2zim {ver}{py})")
            print(f"  venv: {st['dir']}")
        else:
            print("warc2zim sidecar: not installed")
            print(f"  would live at: {st['dir']}")
            print(
                "  it is created automatically on the first `zimi import "
                "<archive>` (network needed once);"
            )
            print(
                "  pre-seed offline machines with `zimi import --setup` "
                "while connected."
            )
        return
    try:
        if args.setup:
            ensure_sidecar(sink=print)
            st = sidecar_status()
            print(f"sidecar ready: warc2zim {st['version'] or '?'} at {st['dir']}")
            if not args.file:
                return
        if not args.file:
            print(
                "zimi: nothing to import — pass a .warc/.warc.gz/.wacz file "
                "(or use --status / --setup)",
                file=sys.stderr,
            )
            sys.exit(2)
        info = import_archive(
            args.file,
            name=args.name,
            title=args.title,
            description=args.description,
            out_path=args.out,
            register=not args.out,
            sink=print,
        )
    except CreateError as e:
        print(f"zimi: {e}", file=sys.stderr)
        sys.exit(2)
    print(f"ZIM written: {info['path']}")
    if info["registered"]:
        print("  registered in the library — no rescan needed")
    elif not args.out:
        print(
            "  note: library registration failed; the file is in place and "
            "will appear on the next library scan"
        )
