"""The fast engine keeps the same two pictures as a rendered capture, when it can.

Eric, on the first cut that only photographed browser engines: "Skipping on
non browser flows kinda sucks but okay." The spec's own answer was that the
fast engine gets a second, cheap visit when a browser happens to be installed.
This is that visit, and the rules around it:

  * no browser, no pictures, no attempt, and never a failure;
  * with one, the live page is settled exactly as a rendered capture settles
    it, and the packaged page is served from the bytes just carried;
  * the carrier keeps those bytes only when a browser is there to use them.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import creator, zimwriter  # noqa: E402


class _StubSession:
    """Stands in for RenderedSession: records what it was asked, answers bytes."""

    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.live_urls = []
        self.packaged = []
        self.closed = False
        _StubSession.instances.append(self)

    def start(self):
        return self

    def shoot_live(self, url):
        self.live_urls.append(url)
        return b"\xff\xd8live"

    def shoot_packaged(self, html, by_path, mainpath="A/index"):
        self.packaged.append((html, dict(by_path), mainpath))
        return b"\xff\xd8packaged"

    def close(self):
        self.closed = True


@pytest.fixture(autouse=True)
def _reset():
    _StubSession.instances.clear()
    yield
    _StubSession.instances.clear()


def test_no_browser_means_no_pictures_and_no_attempt(monkeypatch):
    engine = creator.BuiltinCapture()
    monkeypatch.setattr(engine, "_can_take_pictures", lambda: False)
    monkeypatch.setattr("zimi.renderer.RenderedSession", _StubSession, raising=False)
    assert engine.shoot_pair("<html></html>", "https://e.com/") == (None, None)
    assert _StubSession.instances == [], "a session was started with no browser"
    assert engine.last_shot is None


def test_with_a_browser_both_pictures_come_from_one_session(monkeypatch):
    engine = creator.BuiltinCapture(work_dir="/tmp/x", note=lambda m: None)
    monkeypatch.setattr(engine, "_can_take_pictures", lambda: True)
    monkeypatch.setattr("zimi.renderer.RenderedSession", _StubSession)
    engine._last_by_path = {"_assets/a.css": ("text/css", b"a{}")}

    live, packaged = engine.shoot_pair("<html>page</html>", "https://e.com/p")
    assert live == b"\xff\xd8live" and packaged == b"\xff\xd8packaged"
    assert engine.last_shot == live
    (session,) = _StubSession.instances
    assert session.live_urls == ["https://e.com/p"]
    html, by_path, mainpath = session.packaged[0]
    assert html == "<html>page</html>" and mainpath == "A/index"
    assert by_path == {
        "_assets/a.css": ("text/css", b"a{}")
    }, "served from the carried bytes"
    assert engine._last_by_path == {}, "the bytes are let go once photographed"

    # One browser for the whole capture, closed with it.
    engine.shoot_pair("<html>again</html>", "https://e.com/q")
    assert len(_StubSession.instances) == 1
    engine.close()
    assert session.closed


def test_the_carrier_keeps_bytes_only_when_asked():
    added = []
    make = lambda path, mime, data: (path, mime, data)  # noqa: E731
    read = lambda _zim, _path: (b"css{}", "text/css")  # noqa: E731

    quiet = zimwriter._AssetCarrier(added.append, make, read)
    keeper = zimwriter._AssetCarrier(added.append, make, read, keep_bytes=True)
    assert quiet.by_path == {} and keeper.by_path == {}
    assert quiet.keep_bytes is False and keeper.keep_bytes is True


def test_one_shape_for_every_engine():
    """_capture_pictures asks whichever engine ran and gets one answer."""

    class Rendered:
        last_shot = b"\xff\xd8live"

        def shoot_packaged(self, html):
            return b"\xff\xd8packaged"

    class Fast:
        def shoot_pair(self, html, url):
            return b"\xff\xd8L", b"\xff\xd8P"

    class Nothing:
        pass

    assert creator._capture_pictures(Rendered(), "<p>", "u") == (
        b"\xff\xd8live",
        b"\xff\xd8packaged",
    )
    assert creator._capture_pictures(Fast(), "<p>", "u") == (b"\xff\xd8L", b"\xff\xd8P")
    assert creator._capture_pictures(Nothing(), "<p>", "u") == (None, None)


def test_the_fast_engine_never_fails_a_capture_over_a_picture(monkeypatch):
    class Explodes:
        def __init__(self, **kw):
            raise RuntimeError("no display")

    engine = creator.BuiltinCapture()
    monkeypatch.setattr(engine, "_can_take_pictures", lambda: True)
    monkeypatch.setattr("zimi.renderer.RenderedSession", Explodes)
    assert engine.shoot_pair("<html></html>", "https://e.com/") == (None, None)
    engine.close()  # nothing to close, nothing raised
