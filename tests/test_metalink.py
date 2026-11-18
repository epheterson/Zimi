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


# ── the download mirrors and pieces a download draws on ────────────────────
#
# The mirror probe, the Change mirror menu and piece checks all start from what
# Kiwix's .meta4 says: which download mirrors serve the file, in which country,
# in Kiwix's own order, and the checksum of every piece.

from zimi.metalink import read_download  # noqa: E402

_SAMPLE_PATH = "zim/stack_exchange/ja.stackoverflow.com_mul_all_2026-02.zim"


def test_download_mirrors_come_in_kiwix_order_with_country_and_priority():
    mirrors = read_download(META4).mirrors
    assert [(m.url, m.country, m.priority) for m in mirrors] == [
        ("https://mirror.triplebit.org/download.kiwix.org/" + _SAMPLE_PATH, "us", 1),
        ("https://wi.mirror.driftle.ss/kiwix/" + _SAMPLE_PATH, "us", 2),
        ("https://ny.mirror.driftle.ss/kiwix/" + _SAMPLE_PATH, "us", 3),
        ("https://ftp.nluug.nl/pub/kiwix/" + _SAMPLE_PATH, "nl", 4),
        ("https://mirror.download.kiwix.org/" + _SAMPLE_PATH, "fr", 5),
        ("https://mirrors.dotsrc.org/kiwix/" + _SAMPLE_PATH, "dk", 6),
        (
            "https://mirror-sites-in.mblibrary.info/mirror-sites/download.kiwix.org/"
            + _SAMPLE_PATH,
            "aq",
            7,
        ),
    ]


def test_a_download_mirror_not_on_https_is_left_out():
    """Downloads only ever go over https, so a plain-http mirror is not one."""
    plain = "http://plain.example.org/" + _SAMPLE_PATH
    xml = META4.replace(
        "</file>", f'  <url location="de" priority="8">{plain}</url>\n  </file>'
    )
    urls = [m.url for m in read_download(xml).mirrors]
    assert plain not in urls
    assert len(urls) == 7


def test_the_publishers_own_url_is_not_a_download_mirror():
    """<publisher> carries a bare https://kiwix.org; it serves no file."""
    download = read_download(META4)
    assert download is not None, "the publisher's bare <url> broke the read"
    assert "https://kiwix.org" not in [m.url for m in download.mirrors]


def test_whitespace_around_a_mirror_url_is_not_part_of_it():
    url = "https://ftp.nluug.nl/pub/kiwix/" + _SAMPLE_PATH
    xml = META4.replace(f">{url}<", f">\n      {url}\n    <")
    assert url in [m.url for m in read_download(xml).mirrors]


def test_pieces_come_with_their_size_and_one_checksum_each():
    # 236,789,540 bytes in 4 MiB pieces is 57 pieces, the last one short.
    download = read_download(META4)
    assert download.piece_length == 4194304
    assert len(download.piece_hashes) == 57
    assert download.piece_hashes[0] == "27b8727b351571932cd68180f4a970b6b13194dd"
    # The whole-file sha-1 sits outside <pieces> and is not a piece.
    assert "a2d3d733081915a1e18e120fd9ad01fb8ec9f551" not in download.piece_hashes


def test_a_metalink_without_pieces_still_lists_its_download_mirrors():
    """Some files publish no piece checksums; the download goes ahead
    without piece checks rather than not at all."""
    start, end = META4.index("<pieces"), META4.index("</pieces>") + len("</pieces>")
    download = read_download(META4[:start] + META4[end:])
    assert download is not None and len(download.mirrors) == 7
    assert (download.piece_length, download.piece_hashes) == (None, [])


@pytest.mark.parametrize(
    "xml, why",
    [
        ("<html>503 Service Unavailable</html>", "an error page, not a metalink"),
        (None, "no body at all"),
    ],
)
def test_a_metalink_it_cannot_read_yields_nothing_rather_than_an_error(xml, why):
    """A broken .meta4 falls back to the direct URL; it must not kill the
    download thread."""
    assert read_download(xml) is None, why


# One odd <url> costs that mirror its place in Kiwix's order, never the
# whole list: the old ElementTree reader gave it priority 99 and kept it.

_NY = "https://ny.mirror.driftle.ss/kiwix/" + _SAMPLE_PATH


def _mirrors_of(xml):
    download = read_download(xml)
    assert download is not None, "one odd <url> lost every mirror"
    return download.mirrors


def test_a_mirror_without_a_priority_is_kept_with_priority_99():
    mirrors = _mirrors_of(META4.replace(' priority="3"', ""))
    assert len(mirrors) == 7
    assert (_NY, 99) in [(m.url, m.priority) for m in mirrors]


def test_a_mirror_with_a_priority_that_is_not_a_number_is_kept_with_priority_99():
    mirrors = _mirrors_of(META4.replace('priority="3"', 'priority="third"'))
    assert (_NY, 99) in [(m.url, m.priority) for m in mirrors]


def test_single_quoted_attributes_are_read_too():
    xml = META4.replace('<url location="nl" priority="4">', "<url location='nl' priority='4'>")
    nl = [m for m in _mirrors_of(xml) if "nluug" in m.url]
    assert [(m.country, m.priority) for m in nl] == [("nl", 4)]


def test_download_mirrors_follow_their_priority_not_their_place_in_the_file():
    lines = META4.splitlines(keepends=True)
    first = next(i for i, ln in enumerate(lines) if 'priority="1"' in ln)
    last = next(i for i, ln in enumerate(lines) if 'priority="7"' in ln)
    lines[first], lines[last] = lines[last], lines[first]
    priorities = [m.priority for m in _mirrors_of("".join(lines))]
    assert priorities == [1, 2, 3, 4, 5, 6, 7]


def test_a_mirror_without_a_priority_goes_after_those_with_one():
    mirrors = _mirrors_of(META4.replace(' priority="3"', ""))
    assert mirrors[-1].url == _NY


def test_an_escaped_ampersand_in_a_mirror_url_is_decoded():
    xml = META4.replace(f">{_NY}<", f">{_NY}?a=1&amp;b=2<")
    assert _NY + "?a=1&b=2" in [m.url for m in _mirrors_of(xml)]


def test_a_priority_of_digit_like_symbols_is_not_a_number():
    # "²".isdigit() is True, but it is no priority int() can read.
    mirrors = _mirrors_of(META4.replace('priority="3"', 'priority="²"'))
    assert (_NY, 99) in [(m.url, m.priority) for m in mirrors]


def test_the_kiwix_home_page_is_not_a_download_mirror_even_inside_file():
    xml = META4.replace("</file>", "  <url>https://kiwix.org/</url>\n  </file>")
    assert not [m for m in _mirrors_of(xml) if m.url.rstrip("/") == "https://kiwix.org"]
