"""The 1.9.0 review findings deferred into 1.9.2, each re-verified first.

Every one of these was a note from a review, and each was checked against the
shipped code before it was fixed — which is how one note ("attributes in
capitals") turned out to be three bugs. What is here is what survived that.
"""

import os
import sys
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.server as server  # noqa: E402
from zimi import video, zimwriter  # noqa: E402

# ── wake_lazy reads markup, not the text inside scripts ─────────────────────


def test_a_lazy_tag_inside_a_script_string_is_text_and_stays_text():
    """sqlite.org's page builds markup from a JavaScript string. The tags in
    that string are text; waking them rewrites the site's own program."""
    page = (
        "<script>var t = '<img data-src=\"fromscript.jpg\">';</script>\n"
        '<img data-src="real.jpg" src="ph.gif">'
    )
    out = zimwriter.wake_lazy(page)
    assert 'data-src="fromscript.jpg"' in out, "the script body was rewritten"
    assert 'src="real.jpg"' in out, "the real image was not woken"


def test_a_lazy_tag_inside_a_comment_is_left_alone():
    page = '<!-- <img data-src="commented.jpg"> --><img data-src="real.jpg">'
    out = zimwriter.wake_lazy(page)
    assert '<!-- <img data-src="commented.jpg"> -->' in out
    assert 'src="real.jpg"' in out


# ── data-empty is an attribute, not a word that may appear in a value ──────


def test_a_class_token_named_data_empty_does_not_mark_a_placeholder():
    tag = '<source class="hero data-empty wide" srcset="real.jpg 1x">'
    assert zimwriter._placeholder_source(tag) is False
    assert zimwriter._placeholder_source('<source data-empty srcset="x.jpg">') is True
    assert (
        zimwriter._placeholder_source('<source data-empty="1" srcset="x.jpg">') is True
    )


# ── captions: the video's own language rides along ─────────────────────────


def test_auto_language_asks_for_the_original_track_too():
    """`["all"]` was a hundred requests and a 429; `["en.*"]` alone dropped a
    German video's German captions. `.*-orig` is YouTube's tag for the
    original-language track, one pattern for any language."""
    langs = video._subtitle_langs(video.LANGUAGE_AUTO)
    assert "en.*" in langs and ".*-orig" in langs
    assert "all" not in langs
    assert "de.*" in video._subtitle_langs("de")


# ── the breakdown's parts add up to its whole ───────────────────────────────


def test_breakdown_parts_sum_exactly_to_the_file_size(tmp_path):
    from zimi.zimwriter import atomic_zim_creator, make_asset_item

    out = str(tmp_path / "parts.zim")
    with atomic_zim_creator(out, "eng") as creator:
        creator.add_item(
            zimwriter.zim_static_item_class()("A/index", "t", b"<p>hi</p>" * 700)
        )
        creator.add_item(make_asset_item("I/a.png", "image/png", os.urandom(3333)))
        creator.add_item(make_asset_item("I/b.css", "text/css", b"a{b:c}" * 777))
        creator.set_mainpath("A/index")
    shape = zimwriter.zim_content_breakdown(out)
    total = sum(p["size_bytes"] for p in shape["breakdown"])
    assert total == shape["file_bytes"], f"parts {total} != file {shape['file_bytes']}"


# ── a request with no Range gets the whole item, not its first window ───────


@pytest.fixture
def media_server(tmp_path, monkeypatch):
    from tests.test_unregister_zim import _start_server
    from zimi.zimwriter import atomic_zim_creator, make_asset_item

    zdir = tmp_path / "zims"
    zdir.mkdir()
    payload = os.urandom(300_000)
    with atomic_zim_creator(str(zdir / "clip_en.zim"), "eng") as creator:
        creator.add_item(
            zimwriter.zim_static_item_class()(
                "A/index", "t", b"<video src=../I/clip.mp4>"
            )
        )
        creator.add_item(make_asset_item("I/clip.mp4", "video/mp4", payload))
        creator.set_mainpath("A/index")
    monkeypatch.setattr(server, "STREAM_WINDOW_BYTES", 65_536)
    srv, port = _start_server(str(zdir))
    try:
        yield f"http://127.0.0.1:{port}/w/clip_en/I/clip.mp4", payload
    finally:
        srv.shutdown()


def test_no_range_means_the_whole_file(media_server):
    """curl -O, wget, <a download>, a chat app fetching a link: none send a
    Range, and all of them took the old 206-of-the-first-window as the file.
    8 MB of a 30 MB video, saved without an error anywhere."""
    url, payload = media_server
    with urllib.request.urlopen(url, timeout=30) as r:
        body = r.read()
        assert r.status == 200
        assert r.headers.get("Content-Length") == str(len(payload))
    assert body == payload


def test_a_range_still_gets_one_window(media_server):
    """A player asks with a Range and range-requests onward; the window that
    bounds memory is unchanged for it."""
    url, payload = media_server
    req = urllib.request.Request(url, headers={"Range": "bytes=0-"})
    with urllib.request.urlopen(req, timeout=30) as r:
        assert r.status == 206
        body = r.read()
    assert len(body) == 65_536
    assert body == payload[:65_536]
