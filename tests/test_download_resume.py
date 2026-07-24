"""HTTP downloads resume from the partial via Range, and restart clean when the
remote file's size no longer matches the partial.

Field report: relaunching mid-download surfaced "Download failed / Retry" and a
"clean up" offer for a partial that was still wanted. Retry must resume from the
staged .zim.tmp using a Range request when the total still matches, and discard
the partial + restart from zero when it doesn't (a spliced file would be a
corrupt ZIM). These tests drive _download_from_url with a fake urlopen that
records the Range headers it receives.
"""

import os
import sys
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as lib  # noqa: E402
import zimi.server as server  # noqa: E402


class _FakeResp:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers
        self._body = body
        self._pos = 0

    def read(self, n=-1):
        if n is None or n < 0:
            chunk = self._body[self._pos :]
            self._pos = len(self._body)
            return chunk
        chunk = self._body[self._pos : self._pos + n]
        self._pos += len(chunk)
        return chunk

    def close(self):
        pass


_FULL = bytes(range(256)) * 4  # 1024-byte "complete file"


def _install_fake(monkeypatch, responder):
    """responder(range_header) -> _FakeResp. Records every Range header seen."""
    seen = []

    def fake_urlopen(req, *a, **k):
        rng = req.get_header("Range")
        seen.append(rng)
        return responder(rng)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return seen


def test_resume_sends_range_and_appends(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "SSL_CTX", None, raising=False)
    tmp_dest = str(tmp_path / "x_2026-01.zim.tmp")
    with open(tmp_dest, "wb") as f:
        f.write(_FULL[:400])  # 400 bytes already downloaded

    def responder(rng):
        assert rng == "bytes=400-", f"expected resume Range, got {rng!r}"
        return _FakeResp(
            206,
            {
                "Content-Range": f"bytes 400-{len(_FULL) - 1}/{len(_FULL)}",
                "Content-Length": str(len(_FULL) - 400),
            },
            _FULL[400:],
        )

    seen = _install_fake(monkeypatch, responder)
    dl = {"filename": "x_2026-01.zim", "size_bytes": len(_FULL)}

    ok, err = lib._download_from_url(dl, "https://download.kiwix.org/x.zim", tmp_dest)

    assert ok and err is None
    assert seen == ["bytes=400-"]  # exactly one request, with the resume Range
    assert os.path.getsize(tmp_dest) == len(_FULL)
    with open(tmp_dest, "rb") as f:
        assert f.read() == _FULL  # partial + remainder reassembled correctly


def test_size_mismatch_discards_partial_and_restarts_clean(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "SSL_CTX", None, raising=False)
    tmp_dest = str(tmp_path / "x_2026-01.zim.tmp")
    with open(tmp_dest, "wb") as f:
        f.write(b"\xaa" * 400)  # partial from an OLD build of a different size

    def responder(rng):
        if rng == "bytes=400-":
            # Mirror reports a DIFFERENT total than the partial expects (1024):
            # resuming would splice two files. Code must discard + restart.
            return _FakeResp(
                206,
                {
                    "Content-Range": "bytes 400-899/900",
                    "Content-Length": "500",
                },
                b"\xbb" * 500,
            )
        # Clean restart: no Range → full file from zero.
        assert rng is None
        return _FakeResp(200, {"Content-Length": str(len(_FULL))}, _FULL)

    seen = _install_fake(monkeypatch, responder)
    dl = {"filename": "x_2026-01.zim", "size_bytes": len(_FULL)}

    ok, err = lib._download_from_url(dl, "https://download.kiwix.org/x.zim", tmp_dest)

    assert ok and err is None
    # First a resume attempt (Range), then a clean restart (no Range).
    assert seen == ["bytes=400-", None]
    assert os.path.getsize(tmp_dest) == len(_FULL)
    with open(tmp_dest, "rb") as f:
        assert f.read() == _FULL  # the old 0xAA partial was NOT spliced in
