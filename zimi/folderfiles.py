"""What a folder of files becomes, decided once for the CLI, the web picker
and the build: each file's family, the sidecars that describe it, and the
walk that stays inside the folder it was given.

No writer stack here, nothing but ``os``: the Create page's tree listing and
its preview import this from a request thread, and a listing must not pay for
libzim.

Families:

- ``page``: HTML, Markdown and plain text, each an article
- ``document``: PDF and EPUB, listed for the Bookshelf
- ``image``: pictures, gathered on a gallery page when the folder is not a site
- ``video`` / ``audio``: played in ZimiTube
- ``asset``: anything else a page may use (a stylesheet, a font), carried as is
- ``unsupported``: left out, with a reason (``REASONS``)

Sidecars, plain ``Key: value`` lines (keys in any case) or a JSON object:

- ``zimi.txt`` / ``zimi.json`` at the folder's root describes the ZIM:
  Title, Description, Language, Creator, Publisher, Tags, Icon
- ``<name>.txt`` / ``<name>.json`` beside a file (``talk.mp4`` takes
  ``talk.txt`` or ``talk.mp4.txt``) describes that file: Title, Author, Date,
  Description, Cover

A text file is a sidecar only when it says at least one of those keys, so a
``notes.txt`` of prose beside ``notes.pdf`` stays a page.
"""

import json
import os
import posixpath

from zimi import nautilus as _nautilus

PAGE_EXTS = _nautilus.PAGE_EXTS | {".xhtml"}
MARKDOWN_EXTS = frozenset((".md", ".markdown"))
TEXT_EXTS = frozenset((".txt",))
DOCUMENT_EXTS = _nautilus.BOOK_EXTS
IMAGE_EXTS = frozenset(
    (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp")
)
VIDEO_EXTS = _nautilus.VIDEO_EXTS
AUDIO_EXTS = _nautilus.AUDIO_EXTS

# Containers whose codec varies or that some browsers refuse outright: Safari
# and every iPhone play neither Matroska nor Ogg Theora, and a .mov plays
# where the codec inside it is H.264. Packaged anyway (Zimi does not
# transcode); the picker and the log say so.
PLAYS_SOMETIMES = frozenset((".mkv", ".ogv", ".mov"))

# Left out, and why. The key is the reason's code; the CLI prints the text,
# the web page translates the code (create_folder_why_<code>).
REASONS = {
    "zim": "already a ZIM; add it to the library instead",
    "archive": "a compressed archive; unpack it first",
    "office": "an office document; save it as PDF first",
    "video_format": "a video format browsers cannot play; convert it to MP4 first",
    "partial": "an unfinished download or build",
    "program": "a program, not content",
}
_UNSUPPORTED = {
    ".zim": "zim",
    ".zip": "archive",
    ".tar": "archive",
    ".gz": "archive",
    ".tgz": "archive",
    ".bz2": "archive",
    ".xz": "archive",
    ".7z": "archive",
    ".rar": "archive",
    ".iso": "archive",
    ".dmg": "archive",
    ".doc": "office",
    ".docx": "office",
    ".odt": "office",
    ".ppt": "office",
    ".pptx": "office",
    ".odp": "office",
    ".xls": "office",
    ".xlsx": "office",
    ".ods": "office",
    ".pages": "office",
    ".key": "office",
    ".numbers": "office",
    ".avi": "video_format",
    ".wmv": "video_format",
    ".flv": "video_format",
    ".mpg": "video_format",
    ".mpeg": "video_format",
    ".3gp": "video_format",
    ".rm": "video_format",
    ".asf": "video_format",
    ".tmp": "partial",
    ".part": "partial",
    ".crdownload": "partial",
    ".exe": "program",
    ".dll": "program",
    ".msi": "program",
    ".so": "program",
    ".dylib": "program",
    ".app": "program",
}

# Never content: the operating system's droppings.
JUNK_NAMES = frozenset(
    ("thumbs.db", "desktop.ini", "__pycache__", "$recycle.bin", "@eadir", "#recycle")
)

FOLDER_SIDECARS = ("zimi.txt", "zimi.json")
FOLDER_KEYS = (
    "title",
    "description",
    "language",
    "creator",
    "publisher",
    "tags",
    "icon",
)
ITEM_KEYS = ("title", "author", "date", "description", "cover")
SIDECAR_EXTS = (".txt", ".json")
# A sidecar is a few lines. Anything bigger is a document, not a description.
MAX_SIDECAR_BYTES = 64 * 1024

# The tree listing's page size: one folder level, this many rows at a time.
LIST_PAGE = 200
# How many entries of one directory are read at all. A folder with a million
# files is listed as its first this-many, sorted, and says it stopped.
LIST_READ_CAP = 20000
# What a web selection may name, and how deep a path may be.
MAX_ONLY = 2000
MAX_DEPTH = 64


class OutsideRoot(ValueError):
    """A path that is not a plain path inside the root. The message is safe
    to send to a client: it never names anything on disk."""


def skip_name(name):
    """Hidden files and folders, and the system's own junk, are never
    content and never listed."""
    return not name or name.startswith(".") or name.lower() in JUNK_NAMES


def family(name):
    """``(family, reason)`` for one file name; reason is a REASONS code for
    ``unsupported`` and None otherwise."""
    lower = name.lower()
    ext = posixpath.splitext(lower)[1]
    if lower.endswith(".zim.tmp"):
        return "unsupported", "partial"
    if ext in PAGE_EXTS or ext in MARKDOWN_EXTS or ext in TEXT_EXTS:
        return "page", None
    if ext in DOCUMENT_EXTS:
        return "document", None
    if ext in IMAGE_EXTS:
        return "image", None
    if ext in VIDEO_EXTS:
        return "video", None
    if ext in AUDIO_EXTS:
        return "audio", None
    if ext in _UNSUPPORTED:
        return "unsupported", _UNSUPPORTED[ext]
    return "asset", None


def plays_everywhere(name):
    """False for a video container some browsers will not play."""
    return posixpath.splitext(name.lower())[1] not in PLAYS_SOMETIMES


# ── sidecars ────────────────────────────────────────────────────────────────


def parse_sidecar(text, keys, as_json=False):
    """The recognised keys of one sidecar, lower-cased, values stripped
    strings (Tags may be a list in JSON). {} when it says none of them, which
    is what makes a text file a page rather than a description."""
    out = {}
    if as_json:
        try:
            data = json.loads(text)
        except ValueError:
            return {}
        if not isinstance(data, dict):
            return {}
        for k, v in data.items():
            key = str(k).strip().lower()
            if key not in keys or v is None:
                continue
            if isinstance(v, list):
                v = ", ".join(str(x).strip() for x in v if str(x).strip())
            v = str(v).strip()
            if v:
                out[key] = v
        return out
    for line in text.splitlines():
        if ":" not in line:
            continue
        k, _sep, v = line.partition(":")
        key = k.strip().lower()
        v = v.strip()
        if key in keys and v and key not in out:
            out[key] = v
    return out


def read_sidecar(fs_path, keys):
    """``parse_sidecar`` of a file on disk, or {} when it is missing, a
    symlink, too big or unreadable."""
    try:
        if os.path.islink(fs_path) or not os.path.isfile(fs_path):
            return {}
        if os.path.getsize(fs_path) > MAX_SIDECAR_BYTES:
            return {}
        with open(fs_path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return {}
    return parse_sidecar(text, keys, as_json=fs_path.lower().endswith(".json"))


def sidecar_candidates(rel):
    """Where a file's sidecar may sit, best first: ``talk.mp4.txt`` names
    exactly one file, ``talk.txt`` is the shorter habit."""
    stem = posixpath.splitext(rel)[0]
    out = [rel + ext for ext in SIDECAR_EXTS]
    if posixpath.splitext(rel)[1].lower() not in SIDECAR_EXTS:
        out += [stem + ext for ext in SIDECAR_EXTS]
    return out


def tags_of(value):
    """Tags from "a, b; c" (or a JSON list already joined)."""
    parts = str(value or "").replace(";", ",").split(",")
    return [p.strip() for p in parts if p.strip()]


# ── containment ─────────────────────────────────────────────────────────────


def _parts(rel):
    """The components of a relative path from a client, or OutsideRoot. Only
    plain names: no absolute paths, no drive letters, no backslashes, no
    ``..`` or ``.`` steps, no hidden components, nothing with a NUL."""
    rel = "" if rel is None else str(rel)
    if rel in ("", ".", "/"):
        return []
    if (
        "\x00" in rel
        or "\\" in rel
        or rel.startswith("/")
        or (len(rel) > 1 and rel[1] == ":")
    ):
        raise OutsideRoot("not a path inside the folder")
    parts = [p for p in rel.split("/") if p != ""]
    if len(parts) > MAX_DEPTH:
        raise OutsideRoot("that path is too deep")
    for p in parts:
        if p in (".", "..") or skip_name(p):
            raise OutsideRoot("not a path inside the folder")
    return parts


def _under(path, folder):
    return path.startswith(folder.rstrip(os.sep) + os.sep)


def _inside_any(real, exclude, real_root):
    """Whether ``real`` is in an excluded folder that is itself inside the
    root. A root that lives inside Zimi's data folder (a test, an odd
    config) is not thereby hidden from itself."""
    return any(_under(ex, real_root) and (real == ex or _under(real, ex)) for ex in exclude)


def resolve(root, rel, exclude=()):
    """``(fs_path, rel)`` for a relative path under ``root``, with ``rel``
    normalised to "a/b" form. Refuses anything that is not plainly inside:
    the parts are checked, and then the real path must be the joined path
    itself, so a symlink anywhere along the way (inside or out) is refused
    rather than followed. ``exclude`` is real paths (Zimi's own data folder)
    treated as not there at all. Raises OutsideRoot, or FileNotFoundError
    when the path is plain but not there."""
    real_root = os.path.realpath(root)
    parts = _parts(rel)
    joined = os.path.join(real_root, *parts) if parts else real_root
    if not os.path.lexists(joined):
        raise FileNotFoundError(rel)
    real = os.path.realpath(joined)
    if real != joined or os.path.commonpath([real_root, real]) != real_root:
        raise OutsideRoot("not a path inside the folder")
    if _inside_any(real, exclude, real_root):
        raise OutsideRoot("not a path inside the folder")
    return real, "/".join(parts)


# ── one level, for the picker ───────────────────────────────────────────────


def list_level(root, rel="", offset=0, limit=LIST_PAGE, exclude=()):
    """One directory of the tree: folders first, then files, by name.
    Never recursive. ``exclude`` is real paths that are never shown (Zimi's
    own data folder when it lives inside the root). Each entry:
    ``{name, kind: dir|file, size?, family?, reason?, plays?, sidecar?}``;
    a text file that describes its neighbour is marked ``sidecar`` with the
    neighbour's name, because it is folded into that file, not packaged."""
    excluded = real_paths(exclude)
    fs_dir, rel = resolve(root, rel, excluded)
    if not os.path.isdir(fs_dir):
        raise OutsideRoot("not a folder")
    rows = []
    truncated = False
    with os.scandir(fs_dir) as it:
        for entry in it:
            if len(rows) >= LIST_READ_CAP:
                truncated = True
                break
            if skip_name(entry.name):
                continue
            try:
                if entry.is_symlink():
                    continue  # a capture never follows one, so neither does the picker
                if entry.is_dir(follow_symlinks=False):
                    if os.path.join(fs_dir, entry.name) in excluded:
                        continue
                    rows.append({"name": entry.name, "kind": "dir"})
                elif entry.is_file(follow_symlinks=False):
                    rows.append(
                        {
                            "name": entry.name,
                            "kind": "file",
                            "size": entry.stat(follow_symlinks=False).st_size,
                        }
                    )
            except OSError:
                continue
    rows.sort(key=lambda r: (r["kind"] != "dir", r["name"].lower(), r["name"]))
    total = len(rows)
    offset = max(0, int(offset or 0))
    page = rows[offset : offset + max(1, int(limit))]
    names = {r["name"] for r in rows if r["kind"] == "file"}
    sidecar_of = _sidecars_in(fs_dir, names, at_root=(rel == ""))
    for r in page:
        if r["kind"] != "file":
            continue
        if r["name"] in sidecar_of:
            r["family"] = "sidecar"
            r["sidecar"] = sidecar_of[r["name"]]
            continue
        fam, reason = family(r["name"])
        r["family"] = fam
        if reason:
            r["reason"] = reason
        if fam == "video" and not plays_everywhere(r["name"]):
            r["plays"] = "some"
    return {
        "path": rel,
        "entries": page,
        "offset": offset,
        "total": total,
        "more": max(0, total - offset - len(page)),
        "truncated": truncated,
    }


def _sidecars_in(fs_dir, names, at_root=False):
    """``{sidecar name: what it describes}`` for one directory's files:
    "" for the folder's own zimi.txt at the root, else the neighbour's name.
    Reads only text files that sit beside a file of their stem."""
    out = {}
    if at_root:
        for n in FOLDER_SIDECARS:
            if n in names and read_sidecar(os.path.join(fs_dir, n), FOLDER_KEYS):
                out[n] = ""
    for n in names:
        if n in out or posixpath.splitext(n)[1].lower() in SIDECAR_EXTS:
            continue
        for cand in sidecar_candidates(n):
            if (
                cand in names
                and cand not in out
                and read_sidecar(os.path.join(fs_dir, cand), ITEM_KEYS)
            ):
                out[cand] = n
                break
    return out


# ── the selection a build reads ─────────────────────────────────────────────


def real_paths(paths):
    """Real paths of the ones that exist, for ``exclude``."""
    return frozenset(os.path.realpath(p) for p in paths or () if p)


def normalize_only(root, only, exclude=()):
    """A selection as clean relative paths under ``root``: each resolved
    (OutsideRoot for any escape, FileNotFoundError for a missing one), and
    any path already covered by a selected folder dropped."""
    if not only:
        return []
    if len(only) > MAX_ONLY:
        raise OutsideRoot(f"choose at most {MAX_ONLY} items, or a folder holding them")
    picked = []
    for rel in only:
        _fs, clean = resolve(root, rel, exclude)
        if clean:
            picked.append(clean)
        else:
            return []  # the root itself: everything
    picked = sorted(set(picked))
    out = []
    for p in picked:
        if not any(p.startswith(q + "/") for q in out):
            out.append(p)
    return out


def walk(root, only=None, exclude=()):
    """``(fs_path, rel)`` for every regular file a build would consider,
    depth first and sorted. With ``only``, just those files and folders,
    walked where they are: two files picked in a big share never walk the
    share. Symlinks, hidden and junk names are skipped at every level."""
    real_root = os.path.realpath(root)
    if not only:
        yield from _walk_dir(real_root, "", exclude)
        return
    for rel in only:
        fs_path = os.path.join(real_root, *rel.split("/"))
        if os.path.islink(fs_path):
            continue
        if os.path.isdir(fs_path):
            yield from _walk_dir(fs_path, rel, exclude)
        elif os.path.isfile(fs_path):
            yield fs_path, rel


def _walk_dir(fs_dir, prefix, exclude=()):
    for dirpath, dirnames, filenames in os.walk(fs_dir, followlinks=False):
        dirnames[:] = sorted(
            d
            for d in dirnames
            if not skip_name(d)
            and not os.path.islink(os.path.join(dirpath, d))
            and os.path.join(dirpath, d) not in exclude
        )
        for name in sorted(filenames):
            if skip_name(name):
                continue
            fs_path = os.path.join(dirpath, name)
            if os.path.islink(fs_path):
                continue
            rel = os.path.relpath(fs_path, fs_dir).replace(os.sep, "/")
            yield fs_path, (prefix + "/" + rel if prefix else rel)


def plan(root, only=None, files=None, exclude=()):
    """What a build of this selection holds, without writing anything:
    ``{items: [(fs, rel, family)], sidecars: {rel: dict}, folder: dict,
    folder_sidecar: rel|None, unsupported: [(rel, reason)], covers: [(fs, rel)]}``.

    ``files`` is the walk, when the caller has one already (a bounded preview
    passes a truncated one). Sidecars beside a picked file are found by name
    whether or not they were picked themselves, and so is a cover a sidecar
    names, which is carried even when nobody ticked it."""
    real_root = os.path.realpath(root)
    files = list(walk(real_root, only, exclude)) if files is None else list(files)
    present = {rel: fs for fs, rel in files}
    folder = {}
    folder_sidecar = None
    for n in FOLDER_SIDECARS:
        meta = read_sidecar(os.path.join(real_root, n), FOLDER_KEYS)
        if meta:
            folder, folder_sidecar = meta, n
            break
    consumed = {folder_sidecar} if folder_sidecar else set()
    # A file picked on its own was not walked with its neighbours, so its
    # sidecar is looked for on disk; everything else by name in the walk.
    lone = set(only or ())
    sidecars = {}
    for _fs, rel in files:
        if rel in consumed:
            continue
        for cand in sidecar_candidates(rel):
            if cand in present:
                meta = read_sidecar(present[cand], ITEM_KEYS)
            elif rel in lone:
                meta = read_sidecar(os.path.join(real_root, *cand.split("/")), ITEM_KEYS)
            else:
                continue
            if meta:
                sidecars[rel] = meta
                consumed.add(cand)
                sidecars.pop(cand, None)
                break
    items, unsupported = [], []
    for fs, rel in files:
        if rel in consumed:
            continue
        fam, reason = family(rel)
        if fam == "unsupported":
            unsupported.append((rel, reason))
            continue
        items.append((fs, rel, fam))
    have = {rel for _fs, rel, _f in items}
    covers = []
    wanted = [
        (rel, meta.get("cover")) for rel, meta in sidecars.items() if meta.get("cover")
    ]
    if folder.get("icon"):
        wanted.append(("", folder["icon"]))
    for owner, name in wanted:
        cover = cover_path(owner, name)
        if not cover or cover in have:
            continue
        try:
            fs, cover = resolve(real_root, cover, exclude)
        except (OutsideRoot, FileNotFoundError):
            continue
        if os.path.isfile(fs) and family(cover)[0] == "image":
            covers.append((fs, cover))
            have.add(cover)
    return {
        "items": items,
        "sidecars": sidecars,
        "folder": folder,
        "folder_sidecar": folder_sidecar,
        "unsupported": unsupported,
        "covers": covers,
    }


def cover_path(owner_rel, name):
    """A cover or icon a sidecar names, as a path from the root: relative to
    the file it describes (or the root for the folder's own). None for
    anything that leaves the folder."""
    name = str(name or "").strip().replace("\\", "/")
    if not name or name.startswith("/"):
        return None
    joined = posixpath.normpath(posixpath.join(posixpath.dirname(owner_rel), name))
    if joined.startswith("..") or joined == ".":
        return None
    return joined
