"""The picture a capture keeps of the live page.

A capture is a claim: this ZIM is that page. A week later the claim cannot be
checked, because the page has moved on — which is exactly the work the 09-03
survey did by hand, opening each capture beside a live site while it still
matched. The picture makes that comparison permanent, and turns "tell us about
a site that captured badly" from a report into a glance.

It is a courtesy, never a requirement: a capture that succeeded must not fail
because a picture of it could not be taken, and an engine with no browser (the
fast one, by design) simply produces a ZIM without one.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import zimwriter as zw  # noqa: E402


class _Creator:
    """Records what a capture would have written."""

    def __init__(self, fail_on=None):
        self.items = []
        self.metadata = {}
        self._fail_on = fail_on

    def add_item(self, item):
        if self._fail_on == "item":
            raise RuntimeError("no room")
        self.items.append(item)

    def add_metadata(self, key, value):
        if self._fail_on == "metadata":
            raise RuntimeError("no room")
        self.metadata[key] = value


def test_a_shot_becomes_an_entry_and_says_it_is_there():
    creator = _Creator()
    assert zw.add_capture_shot(creator, b"\xff\xd8jpegbytes") is True
    assert len(creator.items) == 1
    assert creator.metadata[zw.SHOT_METADATA_KEY] == zw.SHOT_ENTRY_PATH
    # An ordinary entry, so it travels with the file to any reader or peer.
    assert zw.SHOT_ENTRY_PATH.endswith(".jpg")


def test_no_browser_means_no_picture_and_no_complaint():
    """The fast engine has no browser on purpose. A ZIM without a picture is
    not defective; it just cannot offer the comparison."""
    creator = _Creator()
    for nothing in (None, b""):
        assert zw.add_capture_shot(creator, nothing) is False
    assert creator.items == []
    assert creator.metadata == {}


@pytest.mark.parametrize("fail_on", ["item", "metadata"])
def test_a_capture_is_never_lost_over_a_picture(fail_on):
    """If storing the shot raises, the capture still stands. The whole ZIM must
    not be thrown away because a courtesy failed."""
    creator = _Creator(fail_on=fail_on)
    assert zw.add_capture_shot(creator, b"\xff\xd8jpegbytes") is False


def test_the_picture_is_the_whole_page_and_still_bounded():
    """Full page, because a viewport-high crop of a long article cannot show
    that the body below the fold survived the capture — which is the only
    question the picture exists to answer.

    Full page has no ceiling of its own, so the size is bounded by degrading:
    whole page, whole page compressed harder, and only then the top of it.
    cnn.com's homepage is about 45,000 pixels tall."""
    import inspect

    from zimi import renderer

    assert renderer.SHOT_WIDTH == 1280
    assert 50 <= renderer.SHOT_QUALITY <= 85
    assert renderer.SHOT_QUALITY_DENSE < renderer.SHOT_QUALITY
    assert 200_000 <= renderer.SHOT_MAX_BYTES <= 3_000_000
    src = inspect.getsource(renderer._shoot)
    assert "full_page=True" in src, "a viewport crop is not what this is for"
    # Cropping is the last resort, not the first move.
    assert src.index("full_page=True") < src.index("clip=")


def test_the_packaged_shot_is_rendered_before_the_zim_exists():
    """The obvious way to photograph a finished ZIM is to open it, and it is
    the wrong way: entries stream straight into the file, so by the time one
    exists it is sealed and adding a picture means rewriting every byte.

    So it is served instead, from the bytes about to be written, over an
    origin laid out like the real one so relative references resolve the same
    way."""
    import inspect

    from zimi import renderer

    src = inspect.getsource(renderer.RenderedSession.shoot_packaged)
    assert "route" in src, "the packaged page is served, not read back"
    assert "fulfill" in src
    # A missing asset must 404 exactly as the reader would, so the picture
    # shows the gap instead of hiding it.
    assert "404" in src


def test_the_shot_reaches_the_panel_as_a_path_not_as_bytes():
    """A screenshot must never ride inside the JSON the library fetches for a
    card. /zim-info hands over the entry path and the panel loads it through
    /w/ like any other entry."""
    import inspect

    from zimi import http as zhttp

    src = inspect.getsource(zhttp._zim_info)
    assert "SHOT_METADATA_KEY" in src
    assert '"/w/' in src, "the panel is given a URL it can load"
    assert "b64" not in src and "base64" not in src
