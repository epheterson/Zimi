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
a split archive, a size that disagrees with libzim's. The caller then falls
back to libzim, so a wrong guess costs speed, never correctness.
"""

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


def _read(fd, size, offset):
    data = _pread(fd, size, offset)
    if len(data) != size:
        raise ValueError("short read")
    return data


def locate(zim_path, entry_index, size):
    """The absolute file offset of entry ``entry_index``'s bytes when they
    are one uncompressed run of ``size`` bytes in ``zim_path``; else None."""
    if entry_index is None or not zim_path or not zim_path.endswith(".zim"):
        return None
    try:
        fd = os.open(zim_path, _OPEN_FLAGS)
    except OSError:
        return None
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
        ) = _HEADER.unpack(_read(fd, _HEADER.size, 0))
        if magic != _MAGIC or not 0 <= entry_index < entries:
            return None
        (dirent_at,) = _U64.unpack(_read(fd, 8, path_ptr + 8 * entry_index))
        mime, _plen, _ns, _rev, cluster, blob = _DIRENT.unpack(
            _read(fd, _DIRENT.size, dirent_at)
        )
        if mime >= _NOT_AN_ITEM or cluster >= clusters:
            return None
        (cluster_at,) = _U64.unpack(_read(fd, 8, cluster_ptr + 8 * cluster))
        info = _read(fd, 1, cluster_at)[0]
        if info & 0x0F not in _UNCOMPRESSED:
            return None
        width, unpack = (8, _U64.unpack) if info & _EXTENDED else (4, _U32.unpack)
        pair = _read(fd, 2 * width, cluster_at + 1 + width * blob)
        start, end = unpack(pair[:width])[0], unpack(pair[width:])[0]
        if end - start != size:
            return None
        return cluster_at + 1 + start
    except (OSError, ValueError, struct.error):
        return None
    finally:
        os.close(fd)


def read(zim_path, offset, start, end):
    """Bytes ``start``..``end`` (inclusive) of a run located at ``offset``."""
    fd = os.open(zim_path, _OPEN_FLAGS)
    try:
        return _pread(fd, end - start + 1, offset + start)
    finally:
        os.close(fd)
