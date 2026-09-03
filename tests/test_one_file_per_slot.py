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


if __name__ == "__main__":
    unittest.main()
