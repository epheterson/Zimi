"""Fake Kiwix download mirrors for the download-engine tests.

Each fake download mirror is a real HTTPS server on loopback serving one fake
ZIM with Range support, so the engine's real network path runs: the https-only
rule, Range resumes, timeouts. A generated `.meta4` lists the mirrors with real
per-piece SHA-1s, the shape Kiwix serves.

Per mirror, a test can set:
  - `chunk_delay`: seconds slept between 16 KiB writes (a slow mirror),
  - `fail_status`: answer every request with this HTTP status,
  - `corrupt_piece`: index of one piece served with flipped bytes,
  - `fail_first`: answer this many requests with 503 first (a probe that
    fails on a mirror that then serves),
  - `drop_after`: cut each transfer off after this many bytes (a mirror that
    errors part-way),
and read `requests`: the Range header of every request it received.

The certificate is self-signed and made with the `openssl` command, so the
engine's real TLS path is used; a machine without `openssl` skips.
"""

import hashlib
import os
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

PIECE = 64 * 1024  # small pieces keep a many-piece file small
CHUNK = 16 * 1024


def fake_zim(n_pieces=8, last=PIECE // 2):
    """Deterministic bytes: n_pieces - 1 full pieces and a short last one."""
    size = (n_pieces - 1) * PIECE + last
    return bytes((i * 7 + i // 251) % 256 for i in range(size))


def make_cert(directory):
    """A self-signed cert for 127.0.0.1; returns (certfile, keyfile)."""
    if not shutil.which("openssl"):
        pytest.skip("openssl not available to make a test certificate")
    cert = os.path.join(directory, "cert.pem")
    key = os.path.join(directory, "key.pem")
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", key, "-out", cert, "-days", "2",
            "-subj", "/CN=127.0.0.1",
            "-addext", "subjectAltName=IP:127.0.0.1",
        ],
        check=True,
        capture_output=True,
    )
    return cert, key


class FakeMirror:
    """One download mirror serving `body` at `/zim/<filename>`."""

    def __init__(self, cert, key, filename, body, country):
        self.filename = filename
        self.body = body
        self.country = country
        self.chunk_delay = 0.0
        self.fail_status = None
        self.corrupt_piece = None
        self.fail_first = 0
        self.drop_after = None
        self.meta4 = None  # bytes served at <file>.meta4, set by the fixture
        self.requests = []
        mirror = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                if mirror.meta4 is not None and self.path.endswith(".meta4"):
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(mirror.meta4)))
                    self.end_headers()
                    self.wfile.write(mirror.meta4)
                    return
                mirror.requests.append(self.headers.get("Range"))
                if mirror.fail_status:
                    self.send_error(mirror.fail_status)
                    return
                if mirror.fail_first > 0:
                    mirror.fail_first -= 1
                    self.send_error(503)
                    return
                data = mirror.served_bytes()
                start, end = 0, len(data) - 1
                rng = self.headers.get("Range")
                if rng:
                    a, _, b = rng.split("=", 1)[1].partition("-")
                    start = int(a)
                    end = int(b) if b else end
                    if start >= len(data):
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{len(data)}")
                        self.end_headers()
                        return
                    self.send_response(206)
                    self.send_header(
                        "Content-Range", f"bytes {start}-{end}/{len(data)}"
                    )
                else:
                    self.send_response(200)
                self.send_header("Content-Length", str(end - start + 1))
                self.end_headers()
                try:
                    pos = start
                    stop = end
                    if mirror.drop_after is not None:
                        stop = min(end, start + mirror.drop_after - 1)
                    while pos <= stop:
                        chunk = data[pos : min(pos + CHUNK, stop + 1)]
                        self.wfile.write(chunk)
                        pos += len(chunk)
                        if mirror.chunk_delay:
                            time.sleep(mirror.chunk_delay)
                except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        self.server.socket = ctx.wrap_socket(self.server.socket, server_side=True)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def host(self):
        return f"127.0.0.1:{self.port}"

    @property
    def url(self):
        return f"https://{self.host}/zim/{self.filename}"

    def served_bytes(self):
        if self.corrupt_piece is None:
            return self.body
        data = bytearray(self.body)
        i = self.corrupt_piece * PIECE
        data[i : i + 16] = bytes(b ^ 0xFF for b in data[i : i + 16])
        return bytes(data)

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def make_meta4(filename, body, mirrors, piece=PIECE, with_pieces=True, with_size=True):
    """A Kiwix-shaped .meta4 listing `mirrors` in order, priority 1..n."""
    urls = "\n".join(
        f'    <url location="{m.country}" priority="{i}">{m.url}</url>'
        for i, m in enumerate(mirrors, 1)
    )
    pieces = ""
    if with_pieces:
        hashes = "\n".join(
            f"      <hash>{hashlib.sha1(body[i : i + piece]).hexdigest()}</hash>"
            for i in range(0, len(body), piece)
        )
        pieces = f'    <pieces length="{piece}" type="sha-1">\n{hashes}\n    </pieces>\n'
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<metalink xmlns="urn:ietf:params:xml:ns:metalink">\n'
        "  <publisher><name>Kiwix project</name><url>https://kiwix.org</url></publisher>\n"
        f'  <file name="{filename}">\n'
        + (f"    <size>{len(body)}</size>\n" if with_size else "")
        + f'    <hash type="sha-256">{hashlib.sha256(body).hexdigest()}</hash>\n'
        f"{pieces}{urls}\n"
        "  </file>\n"
        "</metalink>\n"
    ).encode()


class MirrorSet:
    """Several fake download mirrors for one ZIM, plus the .meta4 naming them.

    Like Kiwix, the .meta4 and the download's direct URL come from an
    `origin` that is not itself one of the listed download mirrors (Kiwix's
    is a redirector); it serves the file too, so it works as the fallback.
    """

    def __init__(self, cert, key, filename, body, countries):
        self.filename = filename
        self.body = body
        self.origin = FakeMirror(cert, key, filename, body, "")
        self.mirrors = [FakeMirror(cert, key, filename, body, c) for c in countries]
        self.set_meta4()

    def set_meta4(self, listed=None, **kw):
        """Serve a .meta4 listing `listed` (default: every download mirror)."""
        listed = self.mirrors if listed is None else listed
        self.origin.meta4 = make_meta4(self.filename, self.body, listed, **kw)

    @property
    def meta4_url(self):
        return self.origin.url + ".meta4"

    def close(self):
        for m in [self.origin, *self.mirrors]:
            m.close()


@pytest.fixture
def download_mirrors(monkeypatch, tmp_path):
    """Start fake download mirrors and point the download engine at them.

    Returns a factory: `download_mirrors(countries=("us", "nl", "fr"),
    body=fake_zim())` gives a MirrorSet. ZIM_DIR and the data dir are
    per-test; the engine trusts the fixture's certificate; the starting URL
    passes the Kiwix-host check; libzim validation and post-download
    finalising are stubbed because the payload is not a real ZIM.
    """
    import zimi.library as lib
    import zimi.server as srv

    certdir = tempfile.mkdtemp(dir=tmp_path)
    cert, key = make_cert(certdir)
    client = ssl.create_default_context(cafile=cert)
    monkeypatch.setattr(srv, "SSL_CTX", client, raising=False)

    zim_dir = tmp_path / "zims"
    data_dir = tmp_path / "data"
    zim_dir.mkdir()
    data_dir.mkdir()
    monkeypatch.setattr(srv, "ZIM_DIR", str(zim_dir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(data_dir))

    real_trusted = lib._is_trusted_kiwix_url
    monkeypatch.setattr(
        lib,
        "_is_trusted_kiwix_url",
        lambda url: real_trusted(url) or (url or "").startswith("https://127.0.0.1:"),
    )
    monkeypatch.setattr(srv, "open_archive", lambda path: object())
    monkeypatch.setattr(lib, "_post_download_finalize", lambda dl: None)
    monkeypatch.setattr(lib, "_seed_after_http_download", lambda dl: None)
    # BitTorrent goes first when an engine is available; these tests are
    # about the HTTP download mirrors, so no engine.
    from zimi import p2p

    monkeypatch.setattr(p2p, "get_backend", lambda *a, **k: None)

    before = set(lib._active_downloads)
    sets = []

    def factory(countries=("us", "nl", "fr"), body=None, filename="mirrortest_2026-01.zim"):
        ms = MirrorSet(cert, key, filename, body or fake_zim(), countries)
        sets.append(ms)
        return ms

    yield factory

    for dl_id in set(lib._active_downloads) - before:
        lib._active_downloads[dl_id]["cancelled"] = True
    deadline = time.time() + 5
    while time.time() < deadline and any(
        not lib._active_downloads[d].get("done")
        for d in set(lib._active_downloads) - before
    ):
        time.sleep(0.05)
    for dl_id in set(lib._active_downloads) - before:
        lib._active_downloads.pop(dl_id, None)
    for ms in sets:
        ms.close()


def wait_for(predicate, timeout=15.0, interval=0.05):
    """Poll until predicate() is truthy; returns its last value."""
    deadline = time.time() + timeout
    value = predicate()
    while not value and time.time() < deadline:
        time.sleep(interval)
        value = predicate()
    return value


def download_status(dl_id):
    """The /manage/downloads row for one download, as the API reports it."""
    import zimi.library as lib

    return next((r for r in lib._get_downloads() if r["id"] == dl_id), None)
