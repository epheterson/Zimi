"""A WARC/1.1 writer — the recording half of the alive engine.

Zimi's rendered engine keeps what a browser DREW. The alive engine keeps what
a browser was GIVEN, which is a different and larger thing: the document as
the server actually sent it, every script, every stylesheet, every image, and
every XHR the page fired while it was becoming itself. Handed to warc2zim,
that traffic becomes a ZIM whose JavaScript still runs — the replay machinery
Webrecorder wrote is embedded in the output, and it serves those bytes back to
the page from inside the ZIM.

So this module writes a web archive, and it writes it by hand. The format is
about two hundred lines of framing rules on top of HTTP messages nobody has to
parse, both ends of the pipe are known (Zimi records, warc2zim reads), and the
alternative was adding a dependency to a package that has exactly one. What
the format is, in full:

  A WARC file is a concatenation of RECORDS. One record is a version line
  (``WARC/1.1``), a block of ``Name: value`` headers, a blank line, then
  exactly ``Content-Length`` bytes of content block, then two CRLFs. Every
  line ending in the framing is CRLF; the content block is opaque bytes and is
  never touched. A ``.warc.gz`` gzips each record SEPARATELY and concatenates
  the members, which is what makes an archive seekable and — the property that
  matters here — what makes a truncated archive still readable up to the last
  record that finished.

  Three record types are written. ``warcinfo`` opens the file and says what
  made it. ``request`` carries the HTTP request message. ``response`` carries
  the HTTP response message: status line, headers, body, exactly as the wire
  had them. ``revisit`` stands in for a response whose payload was already
  stored under another URL, carrying the headers and no body.

The two digests every record gets are not decoration. ``WARC-Payload-Digest``
is what lets a reader know two responses carried identical bytes, and it is
the field a revisit record refers back by. ``WARC-Block-Digest`` covers the
whole block and is what a reader checks the archive's integrity with.

PARTIAL ARCHIVES ARE A FEATURE. A crawl interrupted at page forty of two
hundred has forty pages of real traffic on disk, and because each record is
its own gzip member and each is flushed as it is written, that file converts.
The writer never holds a record back waiting for a later one.
"""

import base64
import gzip
import hashlib
import io
import logging
import os
import re
import time
import uuid

log = logging.getLogger("zimi.warc")

WARC_VERSION = "WARC/1.1"
CRLF = b"\r\n"
# A record's content block is followed by exactly two CRLFs, and readers use
# that to find the next record's version line. It is part of the record, not
# whitespace between records.
RECORD_SEPARATOR = CRLF + CRLF

# The revisit profile for "I already stored these exact bytes elsewhere". The
# 1.1 URI; readers that predate it still recognise the 1.0 form, but nothing
# in this pipeline is that old.
REVISIT_PROFILE = "http://netpreserve.org/warc/1.1/revisit/identical-payload-digest"

# Content types, spelled the way the spec spells them — warcio matches on the
# ``msgtype`` parameter to decide whether a block is a request or a response,
# so the parameter is load-bearing rather than informative.
HTTP_REQUEST_TYPE = "application/http;msgtype=request"
HTTP_RESPONSE_TYPE = "application/http;msgtype=response"
WARC_FIELDS_TYPE = "application/warc-fields"

# Headers that describe how a body was framed ON THE WIRE and are lies the
# moment the body is stored decoded. Playwright hands back decompressed bodies
# with the original headers still attached, so a stored response claiming
# ``Content-Encoding: br`` over plain bytes would make every reader try to
# brotli-decode text and fail. Dropped, and Content-Length restated from what
# is actually here.
_UNSAFE_RESPONSE_HEADERS = frozenset(
    {
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
        "trailer",
        "upgrade",
        # HTTP/2 pseudo-headers. Playwright reports them on h2 responses and
        # they are not legal in an HTTP/1.1 message, which is what a WARC
        # response block is.
        ":status",
    }
)
_UNSAFE_REQUEST_HEADERS = frozenset(
    {
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
        ":method",
        ":path",
        ":scheme",
        ":authority",
    }
)

# A header value may not contain a line ending: one that did would end the
# header block early and turn the rest of the value into framing. Sanitised
# rather than refused — a hostile header must not be able to corrupt an
# archive, and it must not be able to abort a capture either.
_HEADER_JUNK_RE = re.compile(r"[\r\n\x00]+")
# Header NAMES are checked rather than cleaned: a name with a colon or a space
# in it is not a header, and there is nothing to salvage.
_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

# HTTP status text, for the handful of codes worth spelling. The reason phrase
# is decorative in HTTP/1.1 and entirely absent from HTTP/2, so the fallback is
# not a degradation — it is what the wire had.
_REASONS = {
    200: "OK",
    201: "Created",
    204: "No Content",
    206: "Partial Content",
    301: "Moved Permanently",
    302: "Found",
    303: "See Other",
    304: "Not Modified",
    307: "Temporary Redirect",
    308: "Permanent Redirect",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    410: "Gone",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
}


def warc_timestamp(when=None):
    """A WARC-Date: UTC, ISO 8601, second precision, ``Z``-suffixed.

    WARC/1.1 permits sub-second precision and warc2zim reads either; seconds
    are what every other tool in this pipeline writes, and matching them keeps
    a Zimi archive diffable against a browsertrix one."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(when))


def record_id():
    """A WARC-Record-ID. A URN by spec, and unique per record — readers use it
    to tie a response to the request that produced it."""
    return f"<urn:uuid:{uuid.uuid4()}>"


def digest(data):
    """``sha1:<base32>`` — the digest form WARC readers expect.

    Base32 and not hex: it is what the spec's examples use and what warcio
    writes, and a digest string that does not match the one a re-computing
    reader produces is a digest that reports every record as corrupt."""
    raw = hashlib.sha1(data).digest()
    return "sha1:" + base64.b32encode(raw).decode("ascii")


def _clean_value(value):
    return _HEADER_JUNK_RE.sub(" ", str(value)).strip()


def _http_headers(headers, drop):
    """One HTTP message's header lines, as bytes.

    ``headers`` is whatever the browser handed over — a dict, or pairs. Names
    that are not header names and values that would break the framing do not
    make it into the archive; everything else is passed through unchanged,
    because a response's headers are evidence and rewriting them is how a
    replay ends up serving something the site never sent."""
    pairs = headers.items() if hasattr(headers, "items") else headers
    out = bytearray()
    for name, value in pairs:
        name = str(name).strip()
        if not _HEADER_NAME_RE.match(name) or name.lower() in drop:
            continue
        line = f"{name}: {_clean_value(value)}"
        out += line.encode("utf-8", errors="replace") + CRLF
    return bytes(out)


def http_response_block(status, headers, body, *, reason=None):
    """An HTTP/1.1 response message: status line, headers, blank line, body.

    This is what a WARC response record CONTAINS, and getting it right is most
    of what makes an archive replayable — a reader reconstructs the response
    by parsing this, so a Content-Length that disagrees with the body or a
    stale Content-Encoding is a resource that arrives corrupt."""
    body = body or b""
    text = reason or _REASONS.get(int(status), "")
    line = f"HTTP/1.1 {int(status)}{(' ' + text) if text else ''}".encode("utf-8")
    head = _http_headers(headers or {}, _UNSAFE_RESPONSE_HEADERS)
    head += f"Content-Length: {len(body)}".encode("ascii") + CRLF
    return line + CRLF + head + CRLF + body


def http_request_block(method, url, headers):
    """An HTTP/1.1 request message, with an ABSOLUTE request target.

    The absolute form (``GET https://host/path HTTP/1.1``) is legal — it is
    what a request to a proxy looks like — and it is what every WARC-writing
    crawler emits, because a request record whose target is a bare path is a
    record you cannot resolve without also trusting a Host header that may not
    be there. The record's own WARC-Target-URI says the same thing; both being
    present is the convention, not redundancy."""
    line = f"{str(method or 'GET').upper()} {url} HTTP/1.1".encode("utf-8")
    head = _http_headers(headers or {}, _UNSAFE_REQUEST_HEADERS)
    return line + CRLF + head + CRLF


class WarcWriter:
    """One ``.warc.gz`` being written, record by record.

    Every record is gzipped on its own and appended, so the file on disk is a
    valid archive after each one — which is exactly what makes an interrupted
    capture worth converting. The writer holds a file handle, a byte counter
    and the payload-digest map that revisit records refer back through; it
    never holds a record.

    Not thread-safe on purpose, and it does not need to be: a capture session
    writes from the one thread that drives its browser, and adding a lock here
    would only hide the day something else starts writing."""

    def __init__(self, path, *, software=None, gzip_records=True):
        self.path = path
        self._gzip = gzip_records
        self._fh = open(path, "wb")
        self.records = 0
        self.bytes = 0
        # payload digest -> (url, WARC-Date) of the record that first carried
        # those bytes. What a revisit record points back at.
        self._payloads = {}
        # (url, payload digest) already written. The same response to the same
        # URL twice over is one record: a site crawl re-fetches a stylesheet on
        # every page, and storing forty copies of it would be forty copies.
        self._seen = set()
        self._write_warcinfo(software)

    # -- lifecycle ---------------------------------------------------------
    def close(self):
        if self._fh is not None:
            try:
                self._fh.close()
            finally:
                self._fh = None

    def discard(self):
        """Close and delete. For a capture that produced nothing worth
        converting — a refusal, a cancellation before the first page."""
        self.close()
        try:
            os.remove(self.path)
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()

    # -- the framing -------------------------------------------------------
    def _emit(self, headers, block):
        """One complete record onto the file. ``headers`` is a list of pairs
        in the order they should appear — WARC-Type first by convention, and
        the convention is worth keeping because it is what makes an archive
        readable with `zcat | head`."""
        if self._fh is None:
            raise ValueError("this WARC is closed")
        block = block or b""
        head = bytearray(WARC_VERSION.encode("ascii") + CRLF)
        for name, value in headers:
            if value in (None, ""):
                continue
            head += f"{name}: {_clean_value(value)}".encode("utf-8") + CRLF
        head += f"Content-Length: {len(block)}".encode("ascii") + CRLF
        raw = bytes(head) + CRLF + block + RECORD_SEPARATOR
        self._fh.write(self._compress(raw) if self._gzip else raw)
        # Flushed per record, not per file: the crash and the SIGINT are the
        # cases this format's per-record framing exists for, and a record
        # sitting in a userspace buffer when the process dies is a record that
        # was never written.
        self._fh.flush()
        self.records += 1
        self.bytes += len(raw)

    def _compress(self, raw):
        """One gzip MEMBER holding one record.

        ``mtime=0`` because a timestamp in the gzip header makes two identical
        archives differ byte for byte, and the record already carries the only
        date that means anything."""
        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
            gz.write(raw)
        return buf.getvalue()

    def _write_warcinfo(self, software):
        fields = [
            ("software", software or "Zimi"),
            ("format", "WARC File Format 1.1"),
            ("conformsTo", "https://iipc.github.io/warc-specifications/"),
        ]
        block = b"".join(
            f"{k}: {_clean_value(v)}".encode("utf-8") + CRLF for k, v in fields
        )
        self._emit(
            [
                ("WARC-Type", "warcinfo"),
                ("WARC-Record-ID", record_id()),
                ("WARC-Date", warc_timestamp()),
                ("WARC-Filename", os.path.basename(self.path)),
                ("Content-Type", WARC_FIELDS_TYPE),
            ],
            block,
        )

    # -- what a capture writes ---------------------------------------------
    def write_exchange(
        self,
        url,
        *,
        status,
        response_headers,
        body,
        method="GET",
        request_headers=None,
        reason=None,
        when=None,
    ):
        """One request/response pair. Returns what was stored:
        ``"response"``, ``"revisit"``, or ``None`` when this exact exchange was
        already in the archive.

        The request record goes first and the response names it in
        ``WARC-Concurrent-To``, which is the ordering every reader expects and
        the only way a reader can tell that two records are one exchange."""
        body = body or b""
        payload = digest(body)
        key = (url, payload)
        if key in self._seen:
            return None
        self._seen.add(key)
        stamp = warc_timestamp(when)

        req_id = record_id()
        self._emit(
            [
                ("WARC-Type", "request"),
                ("WARC-Record-ID", req_id),
                ("WARC-Target-URI", url),
                ("WARC-Date", stamp),
                ("Content-Type", HTTP_REQUEST_TYPE),
            ],
            http_request_block(method, url, request_headers),
        )

        seen_at = self._payloads.get(payload)
        # A revisit stands in for bytes already stored under a DIFFERENT URL.
        # An empty body is never worth a revisit — the record would be larger
        # than the thing it replaces, and every 204 and every redirect in a
        # crawl shares the same empty payload, which would chain them all back
        # to one arbitrary first one.
        if seen_at is not None and body:
            self._emit(
                [
                    ("WARC-Type", "revisit"),
                    ("WARC-Record-ID", record_id()),
                    ("WARC-Target-URI", url),
                    ("WARC-Date", stamp),
                    ("WARC-Profile", REVISIT_PROFILE),
                    ("WARC-Refers-To-Target-URI", seen_at[0]),
                    ("WARC-Refers-To-Date", seen_at[1]),
                    ("WARC-Payload-Digest", payload),
                    ("WARC-Concurrent-To", req_id),
                    ("Content-Type", HTTP_RESPONSE_TYPE),
                ],
                # Headers only, no payload: that is what makes it a revisit.
                http_response_block(status, response_headers, b"", reason=reason),
            )
            return "revisit"

        block = http_response_block(status, response_headers, body, reason=reason)
        self._emit(
            [
                ("WARC-Type", "response"),
                ("WARC-Record-ID", record_id()),
                ("WARC-Target-URI", url),
                ("WARC-Date", stamp),
                ("WARC-Payload-Digest", payload),
                ("WARC-Block-Digest", digest(block)),
                ("WARC-Concurrent-To", req_id),
                ("Content-Type", HTTP_RESPONSE_TYPE),
            ],
            block,
        )
        if body:
            self._payloads[payload] = (url, stamp)
        return "response"


# ── reading one back ────────────────────────────────────────────────────────
#
# Not for the engine — nothing in Zimi replays a WARC, warc2zim does that. This
# is what the tests parse with, and it lives here rather than in the tests
# because a writer verified only by its own author's assumptions is a writer
# verified by nothing. It is a strict reader: it enforces the framing rather
# than tolerating it, so a record this parses is a record that is actually
# shaped the way the spec says.


class WarcFormatError(Exception):
    """The archive does not obey the format."""


class WarcRecord:
    """One parsed record: its WARC headers, and its content block."""

    __slots__ = ("headers", "block")

    def __init__(self, headers, block):
        self.headers = headers
        self.block = block

    @property
    def type(self):
        return self.headers.get("WARC-Type", "")

    @property
    def url(self):
        return self.headers.get("WARC-Target-URI", "")

    def http_status(self):
        """The status code out of a response block, or None."""
        line = self.block.split(CRLF, 1)[0].decode("latin-1", errors="replace")
        parts = line.split(" ", 2)
        if len(parts) < 2 or not parts[0].startswith("HTTP/"):
            return None
        try:
            return int(parts[1])
        except ValueError:
            return None

    def http_headers(self):
        """``{lowercased name: value}`` from the block's HTTP header lines."""
        head = self.block.split(RECORD_SEPARATOR, 1)[0]
        out = {}
        for raw in head.split(CRLF)[1:]:
            name, sep, value = raw.decode("latin-1", errors="replace").partition(":")
            if sep:
                out[name.strip().lower()] = value.strip()
        return out

    def payload(self):
        """The HTTP body inside the block — what the server actually sent."""
        _head, sep, body = self.block.partition(RECORD_SEPARATOR)
        return body if sep else b""


def read_records(path):
    """Every record in a ``.warc`` or ``.warc.gz``, in order.

    Raises ``WarcFormatError`` on anything that is not the format: a missing
    version line, a header line without a colon, a Content-Length that does
    not match what follows, a record not terminated by its two CRLFs. A
    tolerant reader here would let a malformed writer pass its own tests."""
    with open(path, "rb") as fh:
        raw = fh.read()
    # By the magic number rather than by the filename: an archive is gzipped or
    # it is not, and the extension is a claim about that rather than the fact.
    data = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
    records = []
    pos = 0
    while pos < len(data):
        # Trailing newlines between members are not legal, but a stray one at
        # the very end of a file is the one thing worth forgiving — it costs
        # nothing and it is what a text editor leaves behind.
        if data[pos:].strip(b"\r\n") == b"":
            break
        end = data.find(RECORD_SEPARATOR, pos)
        if end < 0:
            raise WarcFormatError("a record's header block never ended")
        head = data[pos:end].split(CRLF)
        if not head or head[0].decode("latin-1", "replace") != WARC_VERSION:
            raise WarcFormatError(
                f"expected {WARC_VERSION} at byte {pos}, got "
                f"{head[0][:40] if head else b''!r}"
            )
        headers = {}
        for raw in head[1:]:
            name, sep, value = raw.decode("utf-8", errors="replace").partition(":")
            if not sep or not name.strip():
                raise WarcFormatError(f"not a WARC header line: {raw!r}")
            headers[name.strip()] = value.strip()
        try:
            length = int(headers["Content-Length"])
        except (KeyError, ValueError):
            raise WarcFormatError("a record has no usable Content-Length")
        start = end + len(RECORD_SEPARATOR)
        block = data[start : start + length]
        if len(block) != length:
            raise WarcFormatError(
                f"a record claims {length} bytes and the file holds {len(block)}"
            )
        tail = data[start + length : start + length + len(RECORD_SEPARATOR)]
        if tail != RECORD_SEPARATOR:
            raise WarcFormatError("a record is not terminated by CRLFCRLF")
        records.append(WarcRecord(headers, block))
        pos = start + length + len(RECORD_SEPARATOR)
    return records
