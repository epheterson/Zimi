"""The WARC/1.1 writer — `zimi/warc.py`.

Zimi writes web archives by hand. That is a defensible choice (the framing is
simple, the dependency budget is one package, and both ends of this pipe are
known) exactly as long as the output is really the format and not something
that happens to be close enough for the reader that was in front of us. So the
verification here is deliberately adversarial about the framing:

  * A strict grammar check that re-derives every record from the bytes on disk
    — the version line, every header line, the exact Content-Length, the
    terminating CRLFCRLF — and refuses anything that is not it. It runs over
    both the gzipped and the plain form, and over an archive that was cut off
    mid-flight.
  * The digest is checked against an independently computed one, because a
    digest nobody recomputes is a field, not a checksum.
  * The HTTP messages inside the records are parsed with the standard library
    rather than with this module's own reader, so a shared misunderstanding
    between writer and reader cannot pass.
  * And where warcio is installed — it is, next to warc2zim in the import
    sidecar — the archive is parsed by the SAME library warc2zim will parse it
    with. That is the only check that speaks to whether a conversion will work,
    and it skips rather than fails when the sidecar is not there.
"""

import gzip
import hashlib
import http.client
import io
import os
import re
import zlib
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from zimi.warc import (  # noqa: E402
    CRLF,
    RECORD_SEPARATOR,
    REVISIT_PROFILE,
    WARC_VERSION,
    WarcFormatError,
    WarcWriter,
    digest,
    http_request_block,
    http_response_block,
    read_records,
    warc_timestamp,
)

PAGE = b"<!DOCTYPE html><html><head><title>Hi</title></head><body>hi</body></html>"


def _writer(tmp_path, name="out.warc.gz", **kw):
    return WarcWriter(str(tmp_path / name), software="Zimi test", **kw)


def _simple(tmp_path, **kw):
    """One archive holding one page and one stylesheet."""
    w = _writer(tmp_path, **kw)
    w.write_exchange(
        "https://example.com/",
        status=200,
        response_headers={"Content-Type": "text/html; charset=utf-8"},
        body=PAGE,
        request_headers={"User-Agent": "Zimi", "Accept": "text/html"},
    )
    w.write_exchange(
        "https://example.com/s.css",
        status=200,
        response_headers={"Content-Type": "text/css"},
        body=b"body{color:red}",
    )
    w.close()
    return w.path


# ── the grammar, enforced from the bytes ────────────────────────────────────
#
# An independent parser. It does NOT use zimi.warc's own reader: the point is
# to check the writer against the spec rather than against its neighbour.

_HEADER_LINE = re.compile(rb"^[!#$%&'*+.^_`|~0-9A-Za-z-]+: [^\r\n]*$")


def _raw(path):
    if str(path).endswith(".gz"):
        with gzip.open(path, "rb") as fh:
            return fh.read()
    with open(path, "rb") as fh:
        return fh.read()


def _grammar_check(path):
    """Walk the whole file as the spec defines it and return the records.

    Every assertion here is a rule from the WARC/1.1 grammar. A writer that
    passes this is producing the format; one that does not is producing
    something a tolerant reader forgave."""
    data = _raw(path)
    records = []
    pos = 0
    while pos < len(data):
        end = data.find(RECORD_SEPARATOR, pos)
        assert end > 0, "a record's header block is unterminated"
        lines = data[pos:end].split(CRLF)
        assert lines[0] == WARC_VERSION.encode("ascii"), lines[0]
        headers = {}
        for line in lines[1:]:
            assert _HEADER_LINE.match(line), f"not a header line: {line!r}"
            name, _sep, value = line.decode("utf-8").partition(":")
            assert name not in headers, f"duplicate header {name}"
            headers[name] = value.strip()
        # The four every record must carry.
        for required in ("WARC-Type", "WARC-Date", "WARC-Record-ID", "Content-Length"):
            assert required in headers, f"{required} missing from {headers}"
        assert headers["WARC-Record-ID"].startswith("<urn:uuid:")
        assert headers["WARC-Record-ID"].endswith(">")
        assert re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$", headers["WARC-Date"])
        length = int(headers["Content-Length"])
        start = end + len(RECORD_SEPARATOR)
        block = data[start : start + length]
        assert len(block) == length, "Content-Length overruns the file"
        assert (
            data[start + length : start + length + len(RECORD_SEPARATOR)]
            == RECORD_SEPARATOR
        ), "a record is not terminated by CRLFCRLF"
        records.append((headers, block))
        pos = start + length + len(RECORD_SEPARATOR)
    assert pos == len(data), "trailing bytes after the last record"
    return records


def test_the_archive_obeys_the_warc_grammar(tmp_path):
    records = _grammar_check(_simple(tmp_path))
    assert [h["WARC-Type"] for h, _b in records] == [
        "warcinfo",
        "request",
        "response",
        "request",
        "response",
    ]


def test_the_uncompressed_form_obeys_it_too(tmp_path):
    path = _simple(tmp_path, name="out.warc", gzip_records=False)
    assert len(_grammar_check(path)) == 5


def test_every_record_is_its_own_gzip_member(tmp_path):
    """The property the whole partial-archive story rests on: members are
    concatenated, so the file is valid up to the last one that finished."""
    with open(_simple(tmp_path), "rb") as fh:
        raw = fh.read()
    assert raw.count(b"\x1f\x8b\x08") == 5  # one gzip magic per record
    # And the concatenation decompresses as one stream, which is what makes it
    # a legal .gz rather than five files in a trenchcoat.
    assert gzip.decompress(raw).count(WARC_VERSION.encode()) == 5


def test_the_warcinfo_says_what_made_the_file(tmp_path):
    headers, block = _grammar_check(_simple(tmp_path))[0]
    assert headers["Content-Type"] == "application/warc-fields"
    assert headers["WARC-Filename"] == "out.warc.gz"
    assert b"software: Zimi test" + CRLF in block
    assert b"format: WARC File Format 1.1" + CRLF in block


# ── the HTTP messages inside ────────────────────────────────────────────────


def _parse_response(block):
    """The block, through the standard library's own HTTP parser."""
    reply = http.client.HTTPResponse(_FakeSock(block))
    reply.begin()
    return reply


class _FakeSock:
    def __init__(self, data):
        self._data = data

    def makefile(self, *_a, **_kw):
        return io.BufferedReader(io.BytesIO(self._data))


def test_a_response_block_is_a_real_http_message(tmp_path):
    _headers, block = _grammar_check(_simple(tmp_path))[2]
    reply = _parse_response(block)
    assert reply.status == 200
    assert reply.getheader("Content-Type") == "text/html; charset=utf-8"
    assert reply.read() == PAGE


def test_content_length_describes_the_body_that_is_there(tmp_path):
    _headers, block = _grammar_check(_simple(tmp_path))[2]
    assert _parse_response(block).getheader("Content-Length") == str(len(PAGE))


def test_a_transport_header_that_stopped_being_true_is_dropped(tmp_path):
    """Playwright hands back DECODED bodies with the original headers on them.
    A stored response still claiming `Content-Encoding: br` over plain text is
    a resource every reader will try to brotli-decode and fail on."""
    w = _writer(tmp_path)
    w.write_exchange(
        "https://example.com/",
        status=200,
        response_headers={
            "Content-Type": "text/html",
            "Content-Encoding": "br",
            "Transfer-Encoding": "chunked",
            "Content-Length": "9999",
            ":status": "200",
        },
        body=PAGE,
    )
    w.close()
    _headers, block = _grammar_check(w.path)[2]
    reply = _parse_response(block)
    assert reply.getheader("Content-Encoding") is None
    assert reply.getheader("Transfer-Encoding") is None
    assert reply.getheader("Content-Length") == str(len(PAGE))
    assert reply.read() == PAGE


def test_a_header_cannot_smuggle_a_line_ending_into_the_framing(tmp_path):
    """A value with a CRLF in it would end the header block early and turn the
    rest of itself into records. Sanitised, not refused: a hostile header must
    not corrupt an archive and must not abort a capture either."""
    w = _writer(tmp_path)
    w.write_exchange(
        "https://example.com/",
        status=200,
        response_headers={
            "X-Bad": "one\r\nWARC-Type: response\r\nContent-Length: 0",
            "Content-Type": "text/html",
        },
        body=PAGE,
    )
    w.close()
    records = _grammar_check(w.path)  # would blow up on a smuggled record
    assert len(records) == 3
    assert _parse_response(records[2][1]).read() == PAGE


def test_a_name_that_is_not_a_header_name_never_lands(tmp_path):
    w = _writer(tmp_path)
    w.write_exchange(
        "https://example.com/",
        status=200,
        response_headers={"has space": "x", "also:colon": "y", "Fine": "z"},
        body=PAGE,
    )
    w.close()
    reply = _parse_response(_grammar_check(w.path)[2][1])
    assert reply.getheader("Fine") == "z"
    assert reply.getheader("has space") is None


def test_the_request_record_carries_an_absolute_target(tmp_path):
    _headers, block = _grammar_check(_simple(tmp_path))[1]
    assert block.split(CRLF, 1)[0] == b"GET https://example.com/ HTTP/1.1"
    assert b"User-Agent: Zimi" + CRLF in block


def test_a_response_names_the_request_it_answered(tmp_path):
    records = _grammar_check(_simple(tmp_path))
    assert records[2][0]["WARC-Concurrent-To"] == records[1][0]["WARC-Record-ID"]


def test_a_status_with_no_reason_phrase_is_still_a_status_line(tmp_path):
    """HTTP/2 has no reason phrase at all, so a writer that needed one would
    fail on most of the modern web."""
    w = _writer(tmp_path)
    w.write_exchange(
        "https://example.com/x", status=418, response_headers={}, body=b"x"
    )
    w.close()
    assert _parse_response(_grammar_check(w.path)[2][1]).status == 418


# ── digests ─────────────────────────────────────────────────────────────────


def test_the_payload_digest_is_the_payloads_digest(tmp_path):
    headers, _block = _grammar_check(_simple(tmp_path))[2]
    import base64

    expected = "sha1:" + base64.b32encode(hashlib.sha1(PAGE).digest()).decode()
    assert headers["WARC-Payload-Digest"] == expected


def test_the_block_digest_covers_the_whole_block(tmp_path):
    headers, block = _grammar_check(_simple(tmp_path))[2]
    assert headers["WARC-Block-Digest"] == digest(block)


# ── dedupe and revisits ─────────────────────────────────────────────────────


def test_the_same_response_to_the_same_url_is_stored_once(tmp_path):
    """A crawl re-fetches a site's stylesheet on every page. Forty copies of it
    would be forty copies of it."""
    w = _writer(tmp_path)
    for _n in range(3):
        result = w.write_exchange(
            "https://example.com/s.css",
            status=200,
            response_headers={"Content-Type": "text/css"},
            body=b"body{}",
        )
    assert result is None
    w.close()
    types = [h["WARC-Type"] for h, _b in _grammar_check(w.path)]
    assert types == ["warcinfo", "request", "response"]


def test_the_same_bytes_under_another_url_become_a_revisit(tmp_path):
    w = _writer(tmp_path)
    assert (
        w.write_exchange(
            "https://a.example/x.js", status=200, response_headers={}, body=b"same"
        )
        == "response"
    )
    assert (
        w.write_exchange(
            "https://b.example/x.js", status=200, response_headers={}, body=b"same"
        )
        == "revisit"
    )
    w.close()
    headers, block = _grammar_check(w.path)[4]
    assert headers["WARC-Type"] == "revisit"
    assert headers["WARC-Profile"] == REVISIT_PROFILE
    # The field warc2zim resolves the alias through.
    assert headers["WARC-Refers-To-Target-URI"] == "https://a.example/x.js"
    assert headers["WARC-Payload-Digest"] == digest(b"same")
    # Headers, and no payload — that is what makes it a revisit rather than a
    # second copy.
    assert _parse_response(block).read() == b""


def test_an_empty_body_is_never_worth_a_revisit(tmp_path):
    """Every 204 and every redirect in a crawl shares the empty payload. Left
    to chain, they would all point back at one arbitrary first one, and the
    record would be larger than the thing it replaced."""
    w = _writer(tmp_path)
    w.write_exchange(
        "https://example.com/a",
        status=302,
        response_headers={"Location": "/b"},
        body=b"",
    )
    w.write_exchange(
        "https://example.com/c",
        status=302,
        response_headers={"Location": "/d"},
        body=b"",
    )
    w.close()
    assert [h["WARC-Type"] for h, _b in _grammar_check(w.path)] == [
        "warcinfo",
        "request",
        "response",
        "request",
        "response",
    ]


def test_a_redirect_keeps_its_location(tmp_path):
    """warc2zim builds a ZIM redirect out of this header, so losing it loses
    every short URL on the site."""
    w = _writer(tmp_path)
    w.write_exchange(
        "https://example.com/old",
        status=301,
        response_headers={"Location": "https://example.com/new"},
        body=b"",
    )
    w.close()
    reply = _parse_response(_grammar_check(w.path)[2][1])
    assert reply.status == 301
    assert reply.getheader("Location") == "https://example.com/new"


# ── partial archives ────────────────────────────────────────────────────────


def _members(raw):
    """The gzip members that are WHOLE, decompressed, stopping at the first one
    that is torn. This is what "a partial archive still reads" means
    mechanically, and it is what warcio does with a file that was cut off."""
    out = []
    rest = raw
    while rest[:2] == b"\x1f\x8b":
        decompressor = zlib.decompressobj(zlib.MAX_WBITS | 16)
        try:
            chunk = decompressor.decompress(rest)
            decompressor.flush()
        except zlib.error:
            break
        if not decompressor.eof:
            break  # this member never finished — the cut is inside it
        out.append(chunk)
        rest = decompressor.unused_data
    return out


def test_an_archive_cut_off_mid_record_still_reads_up_to_the_cut(tmp_path):
    """The property the SIGINT story rests on: a crawl killed at page thirty
    has thirty pages on disk, and they convert."""
    with open(_simple(tmp_path), "rb") as fh:
        raw = fh.read()
    assert len(_members(raw)) == 5
    # Cut INSIDE the last record. The four before it must survive whole.
    whole = _members(raw[: len(raw) - 40])
    assert len(whole) == 4
    for record in whole:
        assert record.startswith(WARC_VERSION.encode())
        assert record.endswith(RECORD_SEPARATOR)


def test_a_record_is_on_disk_before_the_next_one_is_written(tmp_path):
    """Flushed per record, not per file. A record sitting in a buffer when the
    process is killed is a record that was never written."""
    w = _writer(tmp_path)
    w.write_exchange("https://example.com/", status=200, response_headers={}, body=PAGE)
    assert os.path.getsize(w.path) > 0
    written = os.path.getsize(w.path)
    w.write_exchange(
        "https://example.com/2", status=200, response_headers={}, body=PAGE
    )
    assert os.path.getsize(w.path) > written
    w.close()


def test_discarding_leaves_nothing_behind(tmp_path):
    w = _writer(tmp_path)
    w.write_exchange("https://example.com/", status=200, response_headers={}, body=PAGE)
    w.discard()
    assert not os.path.exists(w.path)


def test_writing_to_a_closed_archive_is_refused(tmp_path):
    w = _writer(tmp_path)
    w.close()
    with pytest.raises(ValueError):
        w.write_exchange(
            "https://example.com/", status=200, response_headers={}, body=b"x"
        )


# ── the module's own reader ─────────────────────────────────────────────────


def test_the_reader_round_trips_what_the_writer_wrote(tmp_path):
    records = read_records(_simple(tmp_path))
    responses = [r for r in records if r.type == "response"]
    assert [r.url for r in responses] == [
        "https://example.com/",
        "https://example.com/s.css",
    ]
    assert responses[0].http_status() == 200
    assert responses[0].payload() == PAGE
    assert responses[0].http_headers()["content-type"] == "text/html; charset=utf-8"


@pytest.mark.parametrize(
    "corrupt",
    [
        pytest.param(
            lambda raw: raw.replace(b"WARC/1.1", b"WARC/9.9", 1), id="version"
        ),
        pytest.param(
            lambda raw: raw.replace(b"WARC-Type: warcinfo", b"WARC-Type warcinfo", 1),
            id="header-without-colon",
        ),
        pytest.param(
            lambda raw: re.sub(
                rb"Content-Length: \d+", b"Content-Length: 99999", raw, count=1
            ),
            id="length-overruns",
        ),
        pytest.param(lambda raw: raw[:-2], id="unterminated"),
    ],
)
def test_the_reader_refuses_what_is_not_the_format(tmp_path, corrupt):
    """A tolerant reader here would let a malformed writer pass its own
    tests."""
    plain = _simple(tmp_path, name="p.warc", gzip_records=False)
    with open(plain, "rb") as fh:
        raw = fh.read()
    bad = tmp_path / "bad.warc"
    bad.write_bytes(corrupt(raw))
    with pytest.raises(WarcFormatError):
        read_records(str(bad))


# ── the pieces on their own ─────────────────────────────────────────────────


def test_a_timestamp_is_utc_to_the_second():
    assert re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$", warc_timestamp(0))
    assert warc_timestamp(0) == "1970-01-01T00:00:00Z"


def test_a_request_block_ends_with_a_blank_line():
    block = http_request_block("get", "https://e.com/", {"Accept": "*/*"})
    assert block.startswith(b"GET https://e.com/ HTTP/1.1" + CRLF)
    assert block.endswith(CRLF + CRLF)


def test_a_response_block_with_no_body_still_ends_its_headers():
    block = http_response_block(204, {}, None)
    assert block.endswith(CRLF + CRLF)
    assert b"Content-Length: 0" in block


# ── the parser warc2zim will actually use ───────────────────────────────────


def _sidecar_python():
    """The warc2zim sidecar's own interpreter, when the sidecar exists here.

    warcio is not a Zimi dependency and never will be — it lives in the sidecar
    venv beside warc2zim, which is exactly where the parsing that matters
    happens. So this check runs THERE, as a subprocess, rather than importing
    something this process is not entitled to."""
    try:
        from zimi.importer import _venv_bin, sidecar_status
    except Exception:
        return None
    status = sidecar_status()
    if not status.get("installed"):
        return None
    exe = _venv_bin(status["dir"], "python")
    return exe if os.path.exists(exe) else None


_WARCIO_PROBE = r"""
import json, sys
from warcio.archiveiterator import ArchiveIterator
out = []
with open(sys.argv[1], 'rb') as fh:
    for r in ArchiveIterator(fh):
        payload = r.content_stream().read() if r.rec_type in ('response', 'revisit') else b''
        out.append({
            'type': r.rec_type,
            'url': r.rec_headers.get_header('WARC-Target-URI'),
            'status': r.http_headers.get_statuscode() if r.http_headers else None,
            'digest': r.rec_headers.get_header('WARC-Payload-Digest'),
            'refers_to': r.rec_headers.get_header('WARC-Refers-To-Target-URI'),
            'body': payload.decode('utf-8', 'replace'),
        })
print(json.dumps(out))
"""


# Resolved ONCE, here, at import — not per call. Other suites in this repo
# monkeypatch ``zimi.server.ZIMI_DATA_DIR`` to point at their own tmp dirs, so a
# lookup made later in the run finds a sidecar venv that does not exist and the
# subprocess fails to launch. The skip decision and the interpreter it implies
# have to be the same decision.
_SIDECAR_PYTHON = _sidecar_python()


def _read_with_warcio(path):
    import json
    import subprocess

    done = subprocess.run(
        [_SIDECAR_PYTHON, "-c", _WARCIO_PROBE, str(path)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


_NO_SIDECAR = "the warc2zim sidecar is not installed here"


@pytest.mark.skipif(_SIDECAR_PYTHON is None, reason=_NO_SIDECAR)
def test_warcio_reads_the_archive_the_way_warc2zim_will(tmp_path):
    """The only check that speaks to whether a CONVERSION will work: warc2zim
    parses with warcio, so warcio's verdict is the one that matters."""
    seen = _read_with_warcio(_simple(tmp_path))
    assert [r["type"] for r in seen] == [
        "warcinfo",
        "request",
        "response",
        "request",
        "response",
    ]
    assert seen[2]["url"] == "https://example.com/"
    assert seen[2]["status"] == "200"
    assert seen[2]["body"].encode() == PAGE


@pytest.mark.skipif(_SIDECAR_PYTHON is None, reason=_NO_SIDECAR)
def test_warcio_agrees_with_the_digest_this_writer_computed(tmp_path):
    """warcio hands back the payload it parsed. A digest that disagrees with it
    would mark every record corrupt in every tool that checks."""
    for record in _read_with_warcio(_simple(tmp_path)):
        if record["type"] == "response":
            assert record["digest"] == digest(record["body"].encode())


@pytest.mark.skipif(_SIDECAR_PYTHON is None, reason=_NO_SIDECAR)
def test_warcio_resolves_a_revisit_back_to_where_the_bytes_came_from(tmp_path):
    """warc2zim turns a revisit into a ZIM alias by reading
    WARC-Refers-To-Target-URI. One it cannot resolve is a lost entry."""
    w = _writer(tmp_path, name="rev.warc.gz")
    w.write_exchange(
        "https://a.example/x.js", status=200, response_headers={}, body=b"same"
    )
    w.write_exchange(
        "https://b.example/x.js", status=200, response_headers={}, body=b"same"
    )
    w.close()
    revisits = [r for r in _read_with_warcio(w.path) if r["type"] == "revisit"]
    assert len(revisits) == 1
    assert revisits[0]["url"] == "https://b.example/x.js"
    assert revisits[0]["refers_to"] == "https://a.example/x.js"
    assert revisits[0]["body"] == ""
