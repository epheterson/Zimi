"""Document libraries: the listing Kiwix's nautiluszim leaves in a ZIM, and
the one Zimi writes in the same shape for a folder of documents.

nautiluszim (zimgit-*, maitre_lucas, youscribe, prunelle, diksha and more)
packs a collection of files with its own small browsing UI, which reads
``database.js``::

    var DATABASE = [
    {'_id': '00000', 'ti': 'Distillation For Home Water Treatment',
     'dsc': 'For people with a water quality problem ',
     'aut': 'Michigan State University', 'fp': ['Water (1).pdf']},
    ];

A Python literal, not JSON (single quotes), so it is read with
``ast.literal_eval``. ``fp`` lists the item's files under ``files/``: one
PDF, EPUB or HTML page for a document, one video, or a list of audio
tracks (youscribe_fr_audiobooks: 39 .ogg files for one La Fontaine). An
item is a document, a video or audio by its files' extensions.

Zimi's own folder ZIMs carry the same shape at ``zimi-database.js``, their
``fp`` from the ZIM's root (the folder's files keep their paths), with two
keys nautilus does not write: ``dt`` (a date) and ``cv`` (a cover picture's
path). Both are read by the same code; the caller holds the archive's lock.
"""

import ast
import logging
import posixpath
import re

log = logging.getLogger("zimi")

DATABASE_PATH = "database.js"
FILES_PREFIX = "files/"
# Zimi's listing: a name of its own, so a folder that happens to hold a
# nautilus export (with its database.js) keeps that file as it was.
ZIMI_DATABASE_PATH = "zimi-database.js"
# The largest listing read. youscribe's 530 audiobook tracks are ~100 KB.
MAX_DATABASE_BYTES = 16 * 1024 * 1024

# What opens in Zimi's reader: PDF.js, the EPUB reader, a page.
DOC_EXTS = frozenset((".pdf", ".epub", ".html", ".htm"))
VIDEO_EXTS = frozenset((".mp4", ".webm", ".ogv", ".m4v", ".mkv", ".mov"))
AUDIO_EXTS = frozenset(
    (".mp3", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".wav", ".flac")
)


def parse(text):
    """The items of a listing's text, a list of dicts ([] when it is not
    one). Tolerant of ``var DATABASE=[`` with or without spaces, and of
    the trailing ``;``."""
    if not text:
        return []
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end < start:
        return []
    try:
        got = ast.literal_eval(text[start : end + 1])
    except (ValueError, SyntaxError, MemoryError, RecursionError) as e:
        log.debug("document listing unreadable: %s", e)
        return []
    if not isinstance(got, list):
        return []
    return [i for i in got if isinstance(i, dict)]


def items(archive, path=DATABASE_PATH):
    """Every item of the listing at ``path`` in ``archive``, as written
    (``_id``, ``ti``, ``dsc``, ``aut``, ``fp``), or [] when there is none."""
    try:
        entry = archive.get_entry_by_path(path)
        if entry.is_redirect:
            entry = entry.get_redirect_entry()
        item = entry.get_item()
        if item.size > MAX_DATABASE_BYTES:
            log.warning("document listing %s is %d bytes: not read", path, item.size)
            return []
        text = bytes(item.content).decode("utf-8", "replace")
    except Exception:
        return []
    return parse(text)


def files_of(item, base=FILES_PREFIX):
    """The ZIM paths of an item's files, in order."""
    fps = item.get("fp") if isinstance(item, dict) else None
    if isinstance(fps, str):
        fps = [fps]
    if not isinstance(fps, list):
        return []
    return [base + fp.lstrip("/") for fp in fps if isinstance(fp, str) and fp.strip()]


def ext_kind(path):
    """ "document", "video", "audio" or "" for one file, by its extension."""
    ext = posixpath.splitext(path or "")[1].lower()
    if ext in DOC_EXTS:
        return "document"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    return ""


def media_of(item):
    """What an item is: "video" when any of its files is a video, "audio"
    when every one is audio (an audiobook's tracks), "document" when one is
    a PDF, EPUB or page, else "" (a spreadsheet, a Flash game)."""
    kinds = {ext_kind(p) for p in files_of(item, "")}
    if "video" in kinds:
        return "video"
    if kinds == {"audio"}:
        return "audio"
    if "document" in kinds:
        return "document"
    return ""


def title_from_name(path):
    """A document's title from its file name: "the_long-walk.pdf" is
    "the long-walk"."""
    stem = posixpath.splitext(posixpath.basename(path or ""))[0]
    return re.sub(r"[_\s]+", " ", stem).strip() or stem


def listing_text(rows):
    """``rows`` as a listing file, in nautilus's own shape: one Python
    literal per line, which ``parse`` reads back exactly."""
    lines = ["var DATABASE = ["]
    lines.extend(repr(dict(r)) + "," for r in rows)
    lines.append("];")
    return "\n".join(lines) + "\n"
