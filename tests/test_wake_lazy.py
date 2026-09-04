"""A lazy-loaded picture is still a picture once the script that loads it is gone.

cheatography.com's home page, captured with the fast engine and opened on a
phone (2026-09-03): every cheat-sheet card was a blank with a spinner where its
thumbnail belongs. The markup was

    <a class="lazy imagelink" data-original="//media.cheatography.com/…/x.400.jpg"
       style="background: url('images/ajax-loader.gif') 50% 40% no-repeat; …">

jQuery Lazy Load's contract: the real address sits in ``data-original`` and a
script paints it — as ``src`` on an image, as ``background-image`` on anything
else — when the element scrolls near. The fast engine drops that script, so
the spinner is what the reader gets, and the picture it already carried sits
in the ZIM unreferenced. lazysizes and the WordPress plugins spell the same
idea ``data-src`` / ``data-srcset`` (and ``data-bg`` for a background) and
hide the element behind a ``lazyload`` class until the swap.

``wake_lazy`` does the swap the script would have done, before the carrier
reads the tag, so the carried file is the one the browser asks for."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import zimi.zimwriter as zimwriter  # noqa: E402
from zimi.zimwriter import wake_lazy  # noqa: E402


def test_a_data_src_image_becomes_the_image():
    tag = '<img src="/spacer.gif" data-src="/real.jpg" alt="a" class="lazyload">'
    out = wake_lazy(tag)
    assert 'src="/real.jpg"' in out, out
    assert "spacer.gif" not in out, out
    assert "data-src" not in out, out
    # lazysizes hides `.lazyload` until it swaps the class; the swap is ours now.
    assert 'class="lazyloaded"' in out, out


def test_data_srcset_and_the_other_spellings_are_promoted_too():
    tag = '<img data-srcset="/a.jpg 1x, /b.jpg 2x" data-lazy-src="/a.jpg">'
    out = wake_lazy(tag)
    assert 'srcset="/a.jpg 1x, /b.jpg 2x"' in out, out
    assert 'src="/a.jpg"' in out, out
    assert "data-" not in out, out
    src = '<source data-srcset="/w.webp" type="image/webp">'
    assert 'srcset="/w.webp"' in wake_lazy(src)


def test_jquery_lazyload_on_a_link_paints_the_background():
    tag = (
        '<a class="lazy imagelink" data-original="//m.example/thumb.400.jpg?t=1"'
        " style=\"background: url('images/ajax-loader.gif') 50% 40% no-repeat; height: 250px;\""
        ' href="/x/"></a>'
    )
    out = wake_lazy(tag)
    assert "data-original" not in out, out
    # The spinner stays as the shorthand; the image property, later in the
    # declaration, wins over it — the same cascade the script relied on.
    assert "background-image:url('//m.example/thumb.400.jpg?t=1')" in out, out
    assert "height: 250px" in out, out


def test_a_background_attribute_without_a_style_gets_one():
    out = wake_lazy('<div data-bg="/hero.jpg" class="hero">')
    assert "style=\"background-image:url('/hero.jpg')\"" in out, out
    assert "data-bg" not in out, out


def test_a_placeholder_or_empty_lazy_value_changes_nothing():
    for tag in (
        '<img src="/real.jpg" data-src="">',
        '<img src="/real.jpg" data-src="data:image/gif;base64,R0lGOD">',
        '<img src="/real.jpg" alt="plain">',
        '<div class="card" data-id="7">',
    ):
        assert wake_lazy(tag) == tag, tag


def test_the_carrier_then_carries_the_woken_picture():
    """Order matters: the swap must happen before the carrier reads ``src``."""
    from zimi.creator import render_captured_page

    carried = []

    class _Carrier:
        def _carry(self, _label, url):
            carried.append(url)
            return "_assets/e.com/" + url.rsplit("/", 1)[-1]

        def rewrite_media(self, _zim, _path, html):
            for m in zimwriter.attr_re("src").finditer(html):
                carried.append(("src", m.group("val")))
            return html

    page = (
        "<html><head><title>t</title></head><body>"
        '<img src="/spacer.gif" data-src="/real.jpg">'
        "</body></html>"
    )
    render_captured_page(_Carrier(), page, final_url="https://e.com/a")
    assert ("src", "/real.jpg") in carried, carried
    assert ("src", "/spacer.gif") not in carried, carried


@pytest.mark.parametrize("n", [50_000])
def test_a_page_with_many_tags_wakes_in_linear_time(n):
    import time

    html = '<div><img src="/s.gif" data-src="/r.jpg"><p>x</p></div>' * n
    t0 = time.monotonic()
    out = wake_lazy(html)
    took = time.monotonic() - t0
    assert out.count('src="/r.jpg"') == n
    assert took < 5.0, took
