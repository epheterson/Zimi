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

File-name and stat work, plus open_book, which the archive pools
(server.open_archive) and `zimi check` open books through.
"""

import glob
import os
import string

#: What zimsplit appends to the first chunk; libzim opens a split book here.
FIRST_SUFFIX = "aa"
ZIM_EXT = ".zim"
FIRST_EXT = ZIM_EXT + FIRST_SUFFIX
# zimsplit names chunks aa..zz: 26 x 26 at most.
_SUFFIXES = [a + b for a in string.ascii_lowercase for b in string.ascii_lowercase]


def is_split(path):
    """True for a split book's first chunk, ``name.zimaa``."""
    return str(path).endswith(FIRST_EXT)


def book_filename(path):
    """The file name the book goes by: ``name.zim`` for ``name.zimaa``, else
    the path's own base name."""
    base = os.path.basename(path)
    return base[: -len(FIRST_SUFFIX)] if is_split(base) else base


def parts(path):
    """Every file of the book at ``path``: the path alone for a whole ZIM; for
    a split book its chunks in order, up to the first one that is not there
    (where libzim stops reading, too)."""
    if not is_split(path):
        return [path]
    stem = path[: -len(FIRST_SUFFIX)]
    out = []
    for sfx in _SUFFIXES:
        p = stem + sfx
        if not os.path.isfile(p):
            break
        out.append(p)
    return out


def on_disk(path):
    """Every chunk file of the book at ``path`` that is there, gaps or not:
    what deleting the book removes. The path alone for a whole ZIM."""
    if not is_split(path):
        return [path]
    stem = path[: -len(FIRST_SUFFIX)]
    return [stem + sfx for sfx in _SUFFIXES if os.path.isfile(stem + sfx)]


def missing_part(path):
    """The file name of the first chunk missing before a later one that is
    there, for a split book with a gap; else None. A last chunk that is
    missing leaves no gap to see: libzim's size check catches that one."""
    if not is_split(path):
        return None
    stem = path[: -len(FIRST_SUFFIX)]
    have = len(parts(path))
    for sfx in _SUFFIXES[have + 1 :]:
        if os.path.isfile(stem + sfx):
            return os.path.basename(stem + _SUFFIXES[have])
    return None


class SplitBookError(RuntimeError):
    """A split book that cannot be read whole; the message says why."""


def first_chunk(path):
    """The ``.zimaa`` a later chunk (``name.zimab``...) belongs to; any other
    path as it is."""
    p = str(path)
    if (
        len(p) > len(FIRST_EXT)
        and p[-len(FIRST_EXT) :].startswith(ZIM_EXT)
        and p[-2:] in _SUFFIXES
    ):
        return p[: -len(FIRST_SUFFIX)] + FIRST_SUFFIX
    return p


def open_book(path):
    """A libzim Archive for the book at ``path``. A split book with a chunk
    gone raises SplitBookError naming the chunk, never an archive of the
    chunks before it. The caller holds whatever lock the archive needs."""
    from libzim.reader import Archive

    gap = missing_part(path)
    if gap:
        raise SplitBookError(f"missing chunk {gap}")
    try:
        return Archive(path)
    except RuntimeError as e:
        if is_split(path):
            # libzim checks the chunks' total against the header's size.
            raise SplitBookError(f"a chunk is missing or cut short ({e})") from e
        raise


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
    """Every book in ``folder``, sorted: ``*.zim`` files, plus split books'
    first chunks whose ``name.zim`` is not also there (a whole file of the
    same name is the same book, and wins)."""
    whole = glob.glob(os.path.join(folder, "*" + ZIM_EXT))
    have = set(whole)
    split = [
        p
        for p in glob.glob(os.path.join(folder, "*" + FIRST_EXT))
        if p[: -len(FIRST_SUFFIX)] not in have
    ]
    return sorted(whole + split)


def path_of(folder, filename):
    """The library path of the book called ``filename`` (``name.zim``) in
    ``folder``: the whole file when there is one, else a split book's first
    chunk, else None."""
    whole = os.path.join(folder, filename)
    if os.path.isfile(whole):
        return whole
    first = whole + FIRST_SUFFIX
    if filename.endswith(ZIM_EXT) and os.path.isfile(first):
        return first
    return None
