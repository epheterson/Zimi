"""Two things the creation survey found in the Fast engine's media carry.

theverge.com's front page came to 83.8 MB for 140 images: every <img> had a
src AND a srcset, the carrier fetched the src and the picked srcset candidate
as two different files, and a browser only ever shows one of them. One slot,
one file.

react.dev's images are Next.js optimizer URLs, ``/_next/image?url=…&w=828``,
which are nothing but query string. The same-origin resolver dropped the
query, so the carrier asked for ``/_next/image`` and got nothing, and every
diagram on the Quick Start page was a broken image.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi.zimwriter import _AssetCarrier  # noqa: E402


def _carrier(remote_reader, page_url=None):
    added = []
    c = _AssetCarrier(
        added.append,
        lambda path, mime, data: (path, mime, data),
        lambda zim, resolved: None,  # nothing same-origin by path
        remote_reader=remote_reader,
        page_url=page_url,
    )
    return c, added


class TestOneFilePerSlot(unittest.TestCase):
    def test_src_and_srcset_carry_one_file_and_agree(self):
        c, added = _carrier(lambda url: (b"IMG", "image/jpeg"))
        html = (
            '<img src="https://m.example/a-1200.jpg" '
            'srcset="https://m.example/a-800.jpg 800w, https://m.example/a-1600.jpg 1600w" alt="a">'
        )
        out = c.rewrite_media("z", "A/index", html)
        self.assertEqual(len(added), 1, added)
        path, _mime, _data = added[0]
        # Both attributes point at the one carried file.
        self.assertEqual(out.count("../" + path), 2, out)
        self.assertNotIn("a-1200", out)
        self.assertNotIn("m.example", out)

    def test_a_tag_with_only_a_src_still_carries_it(self):
        c, added = _carrier(lambda url: (b"IMG", "image/png"))
        out = c.rewrite_media("z", "A/index", '<img src="https://m.example/only.png">')
        self.assertEqual(len(added), 1)
        self.assertIn("../_assets/_remote/", out)


class TestQueryStringsAreTheAddress(unittest.TestCase):
    def test_a_same_origin_reference_keeps_its_query_and_its_entities_are_unescaped(
        self,
    ):
        asked = []

        def remote(url):
            asked.append(url)
            return (b"PNG", "image/png")

        c, added = _carrier(remote, page_url="https://react.dev/learn")
        html = '<img src="/_next/image?url=%2Fimages%2Fuwu.png&amp;w=128&amp;q=75" alt="logo">'
        out = c.rewrite_media("z", "A/learn", html)
        self.assertEqual(
            asked, ["https://react.dev/_next/image?url=%2Fimages%2Fuwu.png&w=128&q=75"]
        )
        self.assertEqual(len(added), 1)
        self.assertIn("../_assets/_remote/", out)
        self.assertNotIn("_next/image?", out)

    def test_without_a_page_url_a_query_reference_is_left_alone(self):
        """The export path (bookmarks out of a ZIM) has no origin to resolve
        against and no network; it must not start inventing one."""
        asked = []
        c, added = _carrier(lambda url: asked.append(url) or None)
        html = '<img src="/img.php?id=3">'
        out = c.rewrite_media("z", "A/index", html)
        self.assertEqual(asked, [])
        self.assertEqual(out, html)



class TestInlineStyleBackgrounds(unittest.TestCase):
    """solar.lowtechmagazine.com sets every story's picture as
    ``<div class="featured-img" style="background-image: url('https://…png')">``.
    The fast engine carried <style> blocks and stylesheets and never looked at
    a style attribute, so the front page opened with a 350 px blank where each
    picture belonged (seen in the browser, 2026-09-03 UI pass)."""

    def test_a_background_in_a_style_attribute_is_carried(self):
        from zimi.creator import _carry_style_attrs

        asked = []

        def remote(url):
            asked.append(url)
            return (b"PNG", "image/png")

        c, added = _carrier(remote, page_url="https://solar.lowtechmagazine.com/")
        page = (
            '<div class="featured-img" style="background-image: url(\'https://solar.lowtechmagazine.com/2026/04/x/images/dithers/a.png\');"></div>'
            '<p style="color:red">plain</p>'
        )
        out = _carry_style_attrs(c, "lbl", "https://solar.lowtechmagazine.com/", page)
        self.assertEqual(len(added), 1, added)
        self.assertIn("url('../_assets/_remote/", out)
        self.assertNotIn("https://solar.lowtechmagazine.com/2026", out)
        self.assertIn('<p style="color:red">plain</p>', out)

class TestAPlaceholderSourceIsNotAPicture(unittest.TestCase):
    """apple.com's product tiles are ``<picture>`` elements whose first
    ``<source>`` is a one-pixel transparent GIF matching every width, put
    there for JavaScript to swap out. Without JavaScript the browser honours
    it and the tile is a blank grey box; the real picture sits in the
    ``<img src>`` behind it (Eric: "close but squished")."""

    def test_the_placeholder_source_is_dropped_and_the_real_picture_carried(self):
        c, added = _carrier(lambda url: (b"JPG", "image/jpeg"))
        page = (
            '<picture class="static" data-anim-lazy-image="">'
            '<source data-empty="" srcset="data:image/gif;base64,R0lGODlhAQABAHAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" media="(min-width:0px)" />'
            '<img src="https://www.apple.com/v/home/hero.jpg" alt="Students">'
            "</picture>"
        )
        out = c.rewrite_media("z", "A/index", page)
        self.assertNotIn("<source", out, out)
        self.assertEqual(len(added), 1)
        self.assertIn('src="../_assets/_remote/', out)

    def test_a_real_source_stays(self):
        c, added = _carrier(lambda url: (b"JPG", "image/jpeg"))
        page = (
            '<picture><source srcset="https://m.example/a-small.jpg 1x" media="(max-width:734px)">'
            '<img src="https://m.example/a-large.jpg"></picture>'
        )
        out = c.rewrite_media("z", "A/index", page)
        self.assertIn("<source", out)
        self.assertEqual(len(added), 2)


class TestImageSetIsOneFilePerSlot(unittest.TestCase):
    """cnn.com's cards set their picture as
    ``style="background-image: image-set(url(a.webp) 1x, url(b.webp) 2x, …)"``
    with six or seven variants each. Carrying every url() in a style attribute
    took all of them: 665 files for 100 cards, and a 34 MB capture became 60 MB
    (2026-09-03). An image-set is a srcset by another name; one candidate, at
    up to 2x, the way pick_srcset already chooses."""

    def test_an_image_set_in_a_style_attribute_carries_one_variant(self):
        from zimi.creator import _carry_style_attrs

        c, added = _carrier(lambda url: (b"WEBP", "image/webp"), page_url="https://www.cnn.com/")
        page = (
            '<div style="background-image: image-set(url(\'https://m.cnn.com/a-1x.webp\') 1x, '
            'url(\'https://m.cnn.com/a-2x.webp\') 2x, url(\'https://m.cnn.com/a-3x.webp\') 3x);"></div>'
        )
        out = _carry_style_attrs(c, "lbl", "https://www.cnn.com/", page)
        self.assertEqual(len(added), 1, added)
        self.assertNotIn("a-1x", out)
        self.assertNotIn("a-3x", out)
        self.assertIn("url(", out)
        self.assertNotIn("image-set(", out)

    def test_collapse_image_set_rewrites_css_text(self):
        from zimi.zimwriter import collapse_image_set

        css = ".x{background:image-set(url(a.png) 1x, url(b.png) 2x)} .y{background:url(c.png)}"
        out = collapse_image_set(css)
        self.assertEqual(out, ".x{background:url(b.png)} .y{background:url(c.png)}")
        # -webkit- prefixed and type() candidates are the same set.
        css2 = "a{background:-webkit-image-set(url(\"s.webp\") type(\"image/webp\") 1x, url(\"s@2x.webp\") 2x)}"
        self.assertEqual(collapse_image_set(css2), 'a{background:url("s@2x.webp")}')


if __name__ == "__main__":
    unittest.main()
