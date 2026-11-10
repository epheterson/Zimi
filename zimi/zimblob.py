"""Where an uncompressed entry's bytes sit in its .zim file.

A video or audio entry lives in an uncompressed cluster (scrapers store
media uncompressed; compressing it again buys nothing), which means its
bytes are one contiguous run at a fixed offset in the file. python-libzim
offers no partial read: ``item.content`` maps the WHOLE blob, and on the
NAS that faulted in all 65 MB of a TED talk for every 1 MB range a player
asked for, under ``_zim_lock`` — the one lock every search and article
read waits on. A cold disk turned each of those into a stall for everyone.

Reading the run with ``os.pread`` instead needs neither libzim nor its
lock. This module finds the run from the ZIM's own index (the format is
documented at https://wiki.openzim.org/wiki/ZIM_file_format) and gives up,
returning None, at anything it does not recognise: a compressed cluster,
a size that disagrees with libzim's. A split book's chunks are read as the
one file they were cut from, so a run may cross a chunk boundary. The caller then falls
back to libzim, so a wrong guess costs speed, never correctness.
"""

import io
import os
import struct

_HEADER = struct.Struct("<IHH16sIIQQQQIIQ")
_MAGIC = 72173914
_DIRENT = struct.Struct("<HBcIII")
_U64 = struct.Struct("<Q")
_U32 = struct.Struct("<I")
_UNCOMPRESSED = (0, 1)
_EXTENDED = 0x10  # cluster info bit: blob offsets are 8 bytes, not 4
_NOT_AN_ITEM = 0xFFFD  # mimetype ids at or above this are redirects/links/deleted


# Opened for bytes everywhere: on Windows os.open reads text unless told.
_OPEN_FLAGS = os.O_RDONLY | getattr(os, "O_BINARY", 0)


def _pread(fd, size, offset):
    """``size`` bytes at ``offset``. Windows has no os.pread; each caller
    opens its own descriptor, so a seek and a read there are just as safe."""
    if hasattr(os, "pread"):
        return os.pread(fd, size, offset)
    os.lseek(fd, offset, os.SEEK_SET)
    chunks, left = [], size
    while left > 0:
        got = os.read(fd, left)
        if not got:
            break
        chunks.append(got)
        left -= len(got)
    return b"".join(chunks)


class _Book:
    """A ZIM's bytes by offset: its file, or a split book's chunks in order
    as the one file they were cut from (zimparts). A read may cross a chunk
    boundary."""

    def __init__(self, zim_path):
        from zimi import zimparts

        self._parts = []  # (start, size, fd)
        at = 0
        try:
            for path in zimparts.parts(zim_path):
                fd = os.open(path, _OPEN_FLAGS)
                n = os.fstat(fd).st_size
                self._parts.append((at, n, fd))
                at += n
        except OSError:
            self.close()
            raise

    def pread(self, size, offset):
        out = []
        for start, n, fd in self._parts:
            if size <= 0:
                break
            if offset >= start + n:
                continue
            take = min(size, start + n - offset)
            got = _pread(fd, take, offset - start)
            out.append(got)
            size -= len(got)
            offset += len(got)
            if len(got) < take:
                break
        return b"".join(out)

    def close(self):
        for _start, _n, fd in self._parts:
            os.close(fd)
        self._parts = []


def _book_read(book, size, offset):
    data = book.pread(size, offset)
    if len(data) != size:
        raise ValueError("short read")
    return data


#: Why an entry is not one uncompressed run (find's second answer).
COMPRESSED, UNREADABLE = "compressed", "unreadable"


def find(zim_path, entry_index, size):
    """``(offset, None)`` when entry ``entry_index``'s bytes are one
    uncompressed run of ``size`` bytes in the book at ``zim_path``; else
    ``(None, why)``: COMPRESSED when its cluster is, UNREADABLE for anything
    else this does not recognise."""
    from zimi import zimparts

    if entry_index is None or not zim_path or not (zimparts.is_whole(zim_path) or zimparts.is_split(zim_path)):
        return None, UNREADABLE
    try:
        book = _Book(zim_path)
    except OSError:
        return None, UNREADABLE
    try:
        (
            magic,
            _maj,
            _min,
            _uuid,
            entries,
            clusters,
            path_ptr,
            _title_ptr,
            cluster_ptr,
            _mime,
            _main,
            _layout,
            _csum,
        ) = _HEADER.unpack(_book_read(book, _HEADER.size, 0))
        if magic != _MAGIC or not 0 <= entry_index < entries:
            return None, UNREADABLE
        (dirent_at,) = _U64.unpack(_book_read(book, 8, path_ptr + 8 * entry_index))
        mime, _plen, _ns, _rev, cluster, blob = _DIRENT.unpack(
            _book_read(book, _DIRENT.size, dirent_at)
        )
        if mime >= _NOT_AN_ITEM or cluster >= clusters:
            return None, UNREADABLE
        (cluster_at,) = _U64.unpack(_book_read(book, 8, cluster_ptr + 8 * cluster))
        info = _book_read(book, 1, cluster_at)[0]
        if info & 0x0F not in _UNCOMPRESSED:
            return None, COMPRESSED
        width, unpack = (8, _U64.unpack) if info & _EXTENDED else (4, _U32.unpack)
        pair = _book_read(book, 2 * width, cluster_at + 1 + width * blob)
        start, end = unpack(pair[:width])[0], unpack(pair[width:])[0]
        if end - start != size:
            return None, UNREADABLE
        return cluster_at + 1 + start, None
    except (OSError, ValueError, struct.error):
        return None, UNREADABLE
    finally:
        book.close()


def locate(zim_path, entry_index, size):
    """The absolute offset of entry ``entry_index``'s bytes when they are
    one uncompressed run of ``size`` bytes in ``zim_path``; else None."""
    return find(zim_path, entry_index, size)[0]


def read(zim_path, offset, start, end):
    """Bytes ``start``..``end`` (inclusive) of a run located at ``offset``."""
    book = _Book(zim_path)
    try:
        return book.pread(end - start + 1, offset + start)
    finally:
        book.close()


class RunFile(io.RawIOBase):
    """A located run as a read-only, seekable file (for zipfile: an EPUB
    over the cap is read member by member, never loaded whole). Each read
    is a pread; nothing is held between them."""

    def __init__(self, zim_path, offset, size):
        super().__init__()
        self._path, self._offset, self._size, self._pos = zim_path, offset, size, 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self._pos

    def seek(self, pos, whence=io.SEEK_SET):
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self._size}[whence]
        self._pos = max(0, base + pos)
        return self._pos

    def readinto(self, b):
        n = min(len(b), self._size - self._pos)
        if n <= 0:
            return 0
        data = read(self._path, self._offset, self._pos, self._pos + n - 1)
        b[: len(data)] = data
        self._pos += len(data)
        return len(data)

    def __len__(self):
        return self._size
