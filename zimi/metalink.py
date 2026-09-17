"""A BitTorrent magnet link, worked out from the metalink Kiwix already serves.

Every ZIM in the Kiwix catalog has a `.meta4` beside it, and the catalog
already points at one. A `.torrent` sits beside that, but fetching it is a
second request per ZIM, and there are 2,652 of them.

It turns out not to be needed. A torrent's infohash is the SHA-1 of its
bencoded `info` dictionary, and every value Kiwix puts in that dictionary is
also in the metalink: the file name, its length, the piece length, the piece
hashes, and the whole-file md5/sha1/sha256. Rebuild the dictionary from the
metalink, bencode it, hash it, and you have the infohash without ever asking
for the torrent.

Verified against Kiwix's own `.torrent` files on five ZIMs spanning 0.2 MB to
16 GB: exact match every time. The one detail that makes a first attempt fail
is that `md5sum` is stored as hex TEXT while `sha1` and `sha256` are stored as
raw BYTES, so a uniform reading of the metalink's hex produces a plausible,
wrong hash.

This runs at snapshot build time, never on a user's machine. Deriving magnets
on demand would mean one metalink fetch per catalog entry, which is exactly
the standing traffic the network discipline exists to prevent.
"""

import hashlib
import re

__all__ = ["infohash_from_metalink", "magnet_uri", "bencode"]

# The metalink is small, fixed-shape XML from one generator (MirrorBrain), and
# the five fields wanted are unambiguous. Regexes rather than an XML parse:
# this runs 2,652 times in a build script, and an XML namespace change would
# break a parser in a way these do not.
_NAME = re.compile(r'<file\s+name="([^"]+)"')
_SIZE = re.compile(r"<size>(\d+)</size>")
_PIECES = re.compile(r'<pieces\s+length="(\d+)"[^>]*>(.*?)</pieces>', re.S)
_HASH = re.compile(r'<hash\s+type="([^"]+)">([0-9a-fA-F]+)</hash>')
_PIECE_HASH = re.compile(r"<hash>([0-9a-fA-F]{40})</hash>")

# How each whole-file hash is stored in the info dict. Kiwix's torrents carry
# all three; md5sum as hex text, the other two as raw bytes. Getting this wrong
# yields a well-formed infohash that matches nothing.
_WHOLE_FILE_HASHES = (
    ("md5", b"md5sum", "hex"),
    ("sha-1", b"sha1", "raw"),
    ("sha-256", b"sha256", "raw"),
)


def bencode(value) -> bytes:
    """Bencode, enough of it for an info dict.

    Dict keys are sorted: bencoding is only canonical if they are, and an
    infohash computed over an unsorted dict is silently wrong.
    """
    if isinstance(value, dict):
        return (
            b"d"
            + b"".join(bencode(k) + bencode(v) for k, v in sorted(value.items()))
            + b"e"
        )
    if isinstance(value, list):
        return b"l" + b"".join(bencode(v) for v in value) + b"e"
    if isinstance(value, int):
        return b"i%de" % value
    if isinstance(value, str):
        value = value.encode("utf-8")
    return b"%d:%s" % (len(value), value)


def infohash_from_metalink(xml: str) -> str | None:
    """The BitTorrent infohash for the file this metalink describes.

    None when the metalink lacks anything needed. A missing infohash costs the
    entry its magnet and nothing else, so this never raises: one odd file in a
    catalog of thousands must not stop a build.
    """
    try:
        name = _NAME.search(xml)
        size = _SIZE.search(xml)
        pieces = _PIECES.search(xml)
        if not (name and size and pieces):
            return None

        piece_hashes = _PIECE_HASH.findall(pieces.group(2))
        if not piece_hashes:
            return None

        info = {
            b"name": name.group(1).encode("utf-8"),
            b"length": int(size.group(1)),
            b"piece length": int(pieces.group(1)),
            b"pieces": b"".join(bytes.fromhex(h) for h in piece_hashes),
        }

        # Whole-file hashes live OUTSIDE <pieces>, so the search is over the
        # text with that block removed; otherwise the first piece hash would be
        # read as the file's sha1.
        outside = xml[: pieces.start()] + xml[pieces.end() :]
        found = {kind.lower(): value for kind, value in _HASH.findall(outside)}
        for metalink_kind, info_key, encoding in _WHOLE_FILE_HASHES:
            digest = found.get(metalink_kind)
            if digest is None:
                return None
            info[info_key] = (
                digest.encode("ascii") if encoding == "hex" else bytes.fromhex(digest)
            )

        return hashlib.sha1(bencode(info)).hexdigest()  # noqa: S324 - BT spec
    except (ValueError, AttributeError):
        return None


def magnet_uri(infohash: str, display_name: str = "") -> str:
    """A magnet for an infohash.

    No trackers: Kiwix's torrents carry their own, and a client that resolves
    the infohash through the DHT finds them. Keeping the URI to the infohash
    and a name is what makes it 40-odd characters in the snapshot rather than
    several hundred.
    """
    uri = f"magnet:?xt=urn:btih:{infohash}"
    if display_name:
        from urllib.parse import quote

        uri += "&dn=" + quote(display_name)
    return uri
