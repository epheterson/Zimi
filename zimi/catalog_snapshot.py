"""The catalog that ships inside Zimi, for a machine that has never been online.

Open Catalog on a fresh install with no network and, until this existed, you
got one line: "Failed to load library". Not the categories, not a hint of what
exists, and not even the ZIMs a peer on your own LAN was offering, because the
fetch failure replaced the whole view.

That is backwards for a project whose entire pitch is offline. So a snapshot of
the Kiwix catalog rides along in the package: every entry's name, title,
description, size, language and a BitTorrent magnet, plus a small picture. It
is what a bunker install browses, and what a LAN peer's offer is matched
against.

Two files, both under ``zimi/assets/`` (already shipped by ``assets/**`` in
pyproject.toml, so there is no packaging change):

    catalog-snapshot.json.gz   the entries, about 166 KB
    catalog-icons.tar          48px WebP, deduplicated by content, about 1.8 MB

The icons are a plain tar rather than a directory so the whole set is one file,
and uncompressed so members can be read by offset without inflating 1.8 MB to
reach one 1 KB picture. Their contents are already compressed.

This module only ever READS. The snapshot is replaced wholesale by the first
successful live fetch and never consulted again once a cache exists, so nothing
here writes, merges or expires anything.

Both files are optional: a source checkout before the build script has run will
not have them, and that has to degrade quietly rather than crash a server.
"""

import gzip
import io
import json
import logging
import os
import re
import tarfile
import threading

log = logging.getLogger(__name__)

__all__ = ["available", "entries", "built_at", "icon", "icon_names"]

_ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
SNAPSHOT_PATH = os.path.join(_ASSETS, "catalog-snapshot.json.gz")
ICONS_PATH = os.path.join(_ASSETS, "catalog-icons.tar")

# An icon is named by the hex digest of its contents, so a name that is not a
# digest cannot address a member. Checked before the tar is touched: the name
# arrives from a URL, and tarfile would happily resolve "../" for us.
_DIGEST_RE = re.compile(r"^[0-9a-f]{8,64}$")

_lock = threading.Lock()
_loaded = False
_entries: list[dict] = []
_built_at = ""
_icon_offsets: dict[str, tuple[int, int]] = {}


def _load() -> None:
    """Read both assets once. Never raises: a missing or broken snapshot means
    this machine browses no catalog offline, which is where it started."""
    global _loaded, _entries, _built_at
    with _lock:
        if _loaded:
            return
        _loaded = True
        try:
            with gzip.open(SNAPSHOT_PATH, "rt", encoding="utf-8") as f:
                payload = json.load(f)
            _entries = payload.get("entries") or []
            _built_at = payload.get("built_at") or ""
            log.info("Catalog snapshot: %d entries, built %s", len(_entries), _built_at)
        except (OSError, ValueError) as e:
            log.debug("no catalog snapshot: %s", e)
            _entries, _built_at = [], ""
        _load_icon_index()


def _load_icon_index() -> None:
    """Map each icon's name to where its bytes sit in the tar.

    The index is read once, at about 1,700 members, and holds offsets rather
    than contents: the point of the tar is that a page showing forty icons
    reads forty small ranges, not 1.8 MB.
    """
    try:
        with tarfile.open(ICONS_PATH, "r:") as tar:
            for member in tar:
                if member.isfile():
                    _icon_offsets[member.name] = (member.offset_data, member.size)
    except (OSError, tarfile.TarError) as e:
        log.debug("no catalog icons: %s", e)


def available() -> bool:
    """Whether there is a snapshot to browse."""
    _load()
    return bool(_entries)


def entries() -> list[dict]:
    """The snapshot's entries. Shared, not copied: callers must not mutate."""
    _load()
    return _entries


def built_at() -> str:
    """The date the snapshot was built, ``YYYY-MM-DD``, or empty.

    Shown to the person, because a catalog that may be months old should say
    so rather than present itself as current.
    """
    _load()
    return _built_at


def icon_names() -> set[str]:
    _load()
    return set(_icon_offsets)


def icon(name: str) -> bytes | None:
    """One icon's bytes, read by offset, or None.

    ``name`` comes from a URL. It is matched against a strict hex pattern
    before the tar is opened, so a traversal attempt is refused by shape
    rather than by trusting tarfile to resolve it safely.
    """
    if not name or not _DIGEST_RE.match(name):
        return None
    _load()
    found = _icon_offsets.get(name)
    if not found:
        return None
    offset, size = found
    try:
        with open(ICONS_PATH, "rb") as f:
            f.seek(offset)
            data = f.read(size)
        return data if len(data) == size else None
    except OSError:
        return None


def _reset_for_tests() -> None:
    """Drop the memo so a test can point the module at a generated snapshot."""
    global _loaded, _entries, _built_at
    with _lock:
        _loaded = False
        _entries = []
        _built_at = ""
        _icon_offsets.clear()


def write_snapshot(path: str, entries_: list[dict], built_at_: str) -> None:
    """Write a snapshot file. Used by the build script and by tests.

    Kept here, beside the reader, so the two cannot drift apart into a writer
    that produces something the reader cannot open.
    """
    payload = {"built_at": built_at_, "entries": entries_}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    # mtime=0 and an empty filename so rebuilding an unchanged catalog produces
    # identical bytes and git sees no change. Both go in the gzip header
    # otherwise, and the filename one is the subtle half: GzipFile takes it
    # from the file object, so the same catalog built in two directories would
    # differ at byte 10.
    with open(path, "wb") as f:
        with gzip.GzipFile(
            filename="", fileobj=f, mode="wb", compresslevel=9, mtime=0
        ) as gz:
            gz.write(raw)


def write_icons(path: str, icons: dict[str, bytes]) -> None:
    """Write the icon tar, sorted by name so the output is reproducible."""
    with tarfile.open(path, "w") as tar:
        for name in sorted(icons):
            data = icons[name]
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(data))
