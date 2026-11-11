"""Split ZIMs: one book stored as ``name.zimaa``, ``name.zimab``, ...

zim-tools' zimsplit cuts a ZIM into chunks (at cluster boundaries) so it fits
a FAT32 stick's 4 GB file cap, and names them by appending two letters, ``aa``
first. libzim reads such a book from the ``.zimaa`` path, chunks in order, as
one archive (https://github.com/openzim/libzim/blob/main/src/file_compound.cpp).

The library holds a split book at its ``.zimaa`` path, so libzim opens it as is
and every ``os.path.exists`` sees a real file. Everything that names or sizes a
book goes through here instead of the path itself: the book's file name is
``name.zim`` (so it gets the served name, date and edition a whole ``name.zim``
would), and its size, deletion and age cover every chunk.

The extension is matched in any case (``.ZIM``, ``.Zim``, ``.ZIMAA``: what a
FAT stick or a Windows copy leaves), and the book's file name always ends in
lower-case ``.zim``, so it is named as the lower-case file would be.

File-name and stat work, plus open_book, which the archive pools
(server.open_archive) and `zimi check` open books through.
"""

import os
import string

#: What zimsplit appends to the first chunk; libzim opens a split book here.
FIRST_SUFFIX = "aa"
ZIM_EXT = ".zim"
FIRST_EXT = ZIM_EXT + FIRST_SUFFIX
# zimsplit names chunks aa..zz: 26 x 26 at most.
_SUFFIXES = [a + b for a in string.ascii_lowercase for b in string.ascii_lowercase]


def is_split(path):
    """True for a split book's first chunk, ``name.zimaa`` (any case)."""
    return str(path).lower().endswith(FIRST_EXT)


def is_whole(path):
    """True for a whole ZIM, ``name.zim`` (any case)."""
    return str(path).lower().endswith(ZIM_EXT)


def book_filename(path):
    """The file name the book goes by: ``name.zim`` for ``name.zimaa`` or
    ``name.ZIM``, else the path's own base name."""
    base = os.path.basename(path)
    if is_split(base):
        return base[: -len(FIRST_EXT)] + ZIM_EXT
    if is_whole(base):
        return base[: -len(ZIM_EXT)] + ZIM_EXT
    return base


def _chunk_names(path):
    """Every name a chunk of the split book at ``path`` can have, in order,
    in the case its first chunk was written in."""
    stem, first = path[: -len(FIRST_SUFFIX)], path[-len(FIRST_SUFFIX) :]
    upper = first.isupper()
    return [stem + (s.upper() if upper else s) for s in _SUFFIXES]


def parts(path):
    """Every file of the book at ``path``: the path alone for a whole ZIM; for
    a split book its chunks in order, up to the first one that is not there
    (where libzim stops reading, too)."""
    if not is_split(path):
        return [path]
    out = []
    for p in _chunk_names(path):
        if not os.path.isfile(p):
            break
        out.append(p)
    return out


def on_disk(path):
    """Every chunk file of the book at ``path`` that is there, gaps or not:
    what deleting the book removes. The path alone for a whole ZIM."""
    if not is_split(path):
        return [path]
    return [p for p in _chunk_names(path) if os.path.isfile(p)]


def missing_part(path):
    """The file name of the first chunk missing before a later one that is
    there, for a split book with a gap; else None. A last chunk that is
    missing leaves no gap to see: libzim's size check catches that one."""
    if not is_split(path):
        return None
    names = _chunk_names(path)
    have = len(parts(path))
    if any(os.path.isfile(p) for p in names[have + 1 :]):
        return os.path.basename(names[have])
    return None


class SplitBookError(RuntimeError):
    """A split book that cannot be read whole; the message says why."""


def first_chunk(path):
    """The ``.zimaa`` a later chunk (``name.zimab``...) belongs to; any other
    path as it is."""
    p = str(path)
    tail = p[-len(FIRST_EXT) :]
    if (
        len(p) > len(FIRST_EXT)
        and tail[: len(ZIM_EXT)].lower() == ZIM_EXT
        and tail[-2:].lower() in _SUFFIXES
    ):
        return p[: -len(FIRST_SUFFIX)] + (
            FIRST_SUFFIX.upper() if tail[-2:].isupper() else FIRST_SUFFIX
        )
    return p


def open_book(path):
    """A libzim Archive for the book at ``path``. A split book with a chunk
    gone raises SplitBookError naming the chunk, never an archive of the
    chunks before it. The caller holds whatever lock the archive needs."""
    from libzim.reader import Archive

    gap = missing_part(path)
    if gap:
        raise SplitBookError(f"missing chunk {gap}")
    if not is_split(path):
        return Archive(path)
    # libzim reads a book as split only when it is named by a lower-case
    # .zimaa, and finds the later chunks by appending lower-case letters. A
    # filesystem that ignores case (macOS, Windows) finds NAME.ZIMAB that
    # way; one that does not (Linux) cannot, and the chunks need renaming.
    lower = path[: -len(FIRST_EXT)] + FIRST_EXT
    try:
        return Archive(lower)
    except RuntimeError as e:
        if lower != path:
            raise SplitBookError(
                "libzim reads split chunks by lower-case names: rename them to .zimaa, .zimab..."
            ) from e
        # libzim checks the chunks' total against the header's size.
        raise SplitBookError(f"a chunk is missing or cut short ({e})") from e


def size(path):
    """Bytes on disk across the whole book (raises OSError like getsize when
    the path is gone)."""
    if not is_split(path):
        return os.path.getsize(path)
    return sum(os.path.getsize(p) for p in parts(path) or [path])


def mtime(path):
    """The newest chunk's mtime: the book changed when any chunk did."""
    return max(os.stat(p).st_mtime for p in parts(path) or [path])


def in_folder(folder):
    """Every book in ``folder``, sorted: ``*.zim`` files in any case, plus
    split books' first chunks whose whole ``name.zim`` is not also there (a
    whole file of the same name is the same book, and wins). Dotted names
    are never books, as with the glob this replaced."""
    try:
        names = [n for n in os.listdir(folder) if not n.startswith(".")]
    except OSError:
        return []
    whole = {n[: -len(ZIM_EXT)].lower() for n in names if is_whole(n)}
    return sorted(
        os.path.join(folder, n)
        for n in names
        if (is_whole(n) or (is_split(n) and n[: -len(FIRST_EXT)].lower() not in whole))
        and os.path.isfile(os.path.join(folder, n))
    )


def path_of(folder, filename):
    """The library path of the book called ``filename`` (``name.zim``) in
    ``folder``: the whole file when there is one, else a split book's first
    chunk, else None. The extension's case on disk does not matter."""
    whole = os.path.join(folder, filename)
    if os.path.isfile(whole):
        return whole
    if not is_whole(filename):
        return None
    for p in in_folder(folder):
        if book_filename(p) == filename:
            return p
    return None
