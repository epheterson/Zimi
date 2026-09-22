"""A magnet derived from a metalink matches the torrent Kiwix publishes.

The whole offline-catalog snapshot rests on this. If the derivation is wrong
it is wrong quietly: a well-formed 40-character infohash that matches no
swarm, shipped for every ZIM in the catalog, discovered only by somebody whose
download never starts.

So the anchor test is not a unit test at all. It is Kiwix's real `.meta4` and
its real `.torrent`, both fixtures, asserting that what we compute from the
first equals what is actually in the second.

Run: pytest tests/test_metalink.py -v
"""

import hashlib
import os
import pathlib
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from zimi.metalink import bencode, infohash_from_metalink, magnet_uri  # noqa: E402

FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures" / "catalog"
META4 = (FIXTURES / "sample.meta4").read_text(encoding="utf-8")
TORRENT = (FIXTURES / "sample.torrent").read_bytes()


def _bdecode(data, i=0):
    """Enough bencode reading to pull the info dict out of the fixture.

    Deliberately not shared with the writer in zimi.metalink: if both
    directions used one implementation, a bug in the bencoder would cancel
    itself out and the comparison below would pass while shipping a wrong
    infohash.
    """
    kind = data[i : i + 1]
    if kind == b"d":
        i += 1
        out = {}
        while data[i : i + 1] != b"e":
            key, i = _bdecode(data, i)
            value, i = _bdecode(data, i)
            out[key] = value
        return out, i + 1
    if kind == b"l":
        i += 1
        out = []
        while data[i : i + 1] != b"e":
            value, i = _bdecode(data, i)
            out.append(value)
        return out, i + 1
    if kind == b"i":
        end = data.index(b"e", i)
        return int(data[i + 1 : end]), end + 1
    colon = data.index(b":", i)
    length = int(data[i:colon])
    return data[colon + 1 : colon + 1 + length], colon + 1 + length


def _real_infohash() -> str:
    info = _bdecode(TORRENT)[0][b"info"]
    return hashlib.sha1(bencode(info)).hexdigest()  # noqa: S324


# ── the one that matters ───────────────────────────────────────────────────


def test_the_derived_infohash_is_the_one_in_kiwixs_torrent():
    assert infohash_from_metalink(META4) == _real_infohash()


def test_the_torrent_fixture_really_is_the_metalinks_torrent():
    """Guards the guard. If somebody replaces one fixture and not the other,
    the test above would compare two unrelated files and could pass or fail
    for reasons that have nothing to do with the code."""
    info = _bdecode(TORRENT)[0][b"info"]
    assert info[b"name"].decode() in META4
    assert str(info[b"length"]) in META4


# ── the trap ───────────────────────────────────────────────────────────────


def test_md5_is_hex_text_and_the_others_are_raw_bytes():
    """The detail that makes a first attempt fail.

    Kiwix's info dict stores md5sum as an ASCII hex string and sha1/sha256 as
    raw bytes. Reading all three the same way yields a plausible, wrong hash,
    and nothing about the result says so.
    """
    info = _bdecode(TORRENT)[0][b"info"]
    md5 = info[b"md5sum"]
    assert len(md5) == 32, "md5sum should be 32 hex CHARACTERS, not 16 bytes"
    assert set(md5) <= set(b"0123456789abcdefABCDEF"), "md5sum should be hex text"
    assert len(info[b"sha1"]) == 20, "sha1 should be 20 raw bytes"
    assert len(info[b"sha256"]) == 32, "sha256 should be 32 raw bytes"
    # And 32 raw bytes is not 64 hex characters, which is the confusion.
    assert info[b"sha256"] != info[b"sha256"].hex().encode()


def test_whole_file_hashes_are_not_confused_with_piece_hashes():
    """A sha1 appears twice in a metalink: once for the whole file and once
    per 4 MB piece, in the same <hash> element shape. Taking the first match
    in document order picks a piece hash, and the result is wrong."""
    info = _bdecode(TORRENT)[0][b"info"]
    first_piece = info[b"pieces"][:20]
    assert info[b"sha1"] != first_piece


# ── bencode ────────────────────────────────────────────────────────────────


def test_dict_keys_are_sorted():
    """Bencoding is canonical only with sorted keys, and an infohash over an
    unsorted dict is silently wrong."""
    assert bencode({b"b": 1, b"a": 2}) == b"d1:ai2e1:bi1ee"


@pytest.mark.parametrize(
    "value,expected",
    [
        (0, b"i0e"),
        (-1, b"i-1e"),
        (b"", b"0:"),
        (b"spam", b"4:spam"),
        ("unicode é", "unicode é".encode()[:0] + b"10:unicode \xc3\xa9"),
        ([], b"le"),
        ({}, b"de"),
        ([1, b"a"], b"li1e1:ae"),
    ],
)
def test_bencode_primitives(value, expected):
    assert bencode(value) == expected


# ── degrading ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "xml,why",
    [
        ("", "empty"),
        ("<metalink></metalink>", "no file"),
        ('<file name="a.zim"><size>1</size></file>', "no pieces"),
        ('<file name="a.zim"><pieces length="4"></pieces></file>', "no size"),
        (META4.replace('<hash type="md5">', '<hash type="unknown">'), "md5 missing"),
        (
            META4.replace("<size>236789540</size>", "<size>not-a-number</size>"),
            "bad size",
        ),
    ],
)
def test_a_metalink_it_cannot_read_yields_no_magnet_rather_than_an_error(xml, why):
    """One odd file in a catalog of thousands loses its magnet. It must not
    stop a build that is otherwise fine."""
    assert infohash_from_metalink(xml) is None, why


# ── the magnet itself ──────────────────────────────────────────────────────


def test_magnet_carries_the_infohash_and_a_name():
    uri = magnet_uri("ab0bf6a5be066e722ba849a30e3920c045c53deb", "a b.zim")
    assert uri.startswith(
        "magnet:?xt=urn:btih:ab0bf6a5be066e722ba849a30e3920c045c53deb"
    )
    assert "a%20b.zim" in uri, "the name must be percent-encoded"


def test_magnet_without_a_name_is_just_the_infohash():
    """No trackers by design: Kiwix's torrents carry their own, and a client
    resolving the infohash through the DHT finds them. It is what keeps the
    snapshot's magnet field 40-odd characters instead of several hundred."""
    uri = magnet_uri("ab0bf6a5be066e722ba849a30e3920c045c53deb")
    assert uri == "magnet:?xt=urn:btih:ab0bf6a5be066e722ba849a30e3920c045c53deb"
    assert "tr=" not in uri
