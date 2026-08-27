#!/usr/bin/env python3
"""One image per slot, at up to twice the display density.

A srcset offers the same picture at four or five widths so a live browser can
choose per device. An archive is not choosing, it is storing, and storing every
candidate meant four copies of every picture for the one a reader gets: CNN's
front page came to 835 images and 62 MB that way.

Eric's rule: "2x is more than enough one image per slot is fine (at the right
res?)". Both halves matter — one per slot, and the RIGHT one, because dropping
to the smallest would save the same bytes by making the page look worse.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi.zimwriter import (  # noqa: E402
    VARIANT_MAX_DPR,
    VARIANT_TARGET_WIDTH,
    _split_srcset,
    pick_srcset,
)


def pick(value, **kw):
    chosen = pick_srcset(_split_srcset(value), **kw)
    return chosen[0] if chosen else None


class TestWidthDescriptors(unittest.TestCase):
    def test_the_smallest_candidate_that_covers_the_target_wins(self):
        """Smallest that still covers it: anything larger is bytes nobody sees,
        anything smaller is a picture upscaled on the page it came from."""
        got = pick(
            "a.jpg 400w, b.jpg 800w, c.jpg 1600w, d.jpg 3200w", target_width=1600
        )
        self.assertEqual(got, "c.jpg")

    def test_the_largest_wins_when_none_is_big_enough(self):
        got = pick("a.jpg 320w, b.jpg 640w", target_width=1600)
        self.assertEqual(got, "b.jpg")

    def test_a_thumbnail_slot_keeps_a_thumbnail(self):
        """The target is per SLOT, so a 100px avatar does not pull the
        full-bleed version of itself into the archive."""
        got = pick("s.jpg 100w, m.jpg 800w, l.jpg 2400w", target_width=200)
        self.assertEqual(got, "m.jpg")

    def test_one_candidate_is_that_candidate(self):
        self.assertEqual(pick("only.jpg 900w"), "only.jpg")


class TestDensityDescriptors(unittest.TestCase):
    def test_two_x_is_kept_and_three_x_is_not(self):
        got = pick("a.jpg, b.jpg 2x, c.jpg 3x")
        self.assertEqual(got, "b.jpg")

    def test_the_smallest_is_taken_when_everything_exceeds_the_cap(self):
        got = pick("big.jpg 3x, bigger.jpg 4x")
        self.assertEqual(got, "big.jpg")

    def test_a_bare_candidate_is_one_x(self):
        self.assertEqual(pick("plain.jpg"), "plain.jpg")

    def test_the_cap_is_two(self):
        self.assertEqual(VARIANT_MAX_DPR, 2)


class TestEdges(unittest.TestCase):
    def test_nothing_in_means_nothing_out(self):
        self.assertIsNone(pick(""))
        self.assertIsNone(pick_srcset([]))

    def test_a_url_containing_commas_survives(self):
        """CNN's image API puts commas in the query. Splitting on the bare
        comma shredded one URL into three bogus candidates and a phone then
        picked the garbage."""
        value = (
            "https://cdn.test/i.jpg?q=h_720,w_1280,c_fill/f_webp 1280w, "
            "https://cdn.test/i.jpg?q=h_1080,w_1920,c_fill/f_webp 1920w"
        )
        got = pick(value, target_width=1600)
        self.assertEqual(got, "https://cdn.test/i.jpg?q=h_1080,w_1920,c_fill/f_webp")

    def test_a_junk_descriptor_does_not_lose_the_candidate(self):
        """A malformed descriptor must not silently drop an image."""
        self.assertIsNotNone(pick("a.jpg banana"))

    def test_the_default_target_is_a_reading_column_at_2x(self):
        self.assertEqual(VARIANT_TARGET_WIDTH, 1600)


class TestTheRewriteKeepsOne(unittest.TestCase):
    """The rule is applied where the page is rewritten, so everything
    downstream — the asset carrier, the size estimate, the preview — inherits
    it without knowing about it."""

    def test_a_rewritten_srcset_holds_a_single_candidate(self):
        from zimi.creator import _relativize_html

        page = '<img src="/hero.jpg" srcset="/a.jpg 400w, /b.jpg 1600w, /c.jpg 3200w">'
        out = _relativize_html(page, ("https://example.test",))
        self.assertIn("/b.jpg", out)
        self.assertNotIn("/c.jpg", out)
        self.assertNotIn("/a.jpg", out)
        # The fallback src is untouched — it is not a candidate list.
        self.assertIn('src="/hero.jpg"', out)

    def test_the_estimate_counts_what_will_be_fetched(self):
        """Counting every candidate was right when every candidate was
        fetched, and became an over-estimate the moment that stopped."""
        from zimi.creator import page_asset_refs

        page = '<img srcset="/a.jpg 400w, /b.jpg 1600w, /c.jpg 3200w">'
        refs = page_asset_refs(page, "https://example.test/")
        self.assertEqual(len(refs), 1, f"counted {refs}")


if __name__ == "__main__":
    unittest.main()


class TestTheCarrierAppliesTheRule(unittest.TestCase):
    """The rewrite prunes the tag; the CARRIER is what downloads. The rule has
    to hold in both or it does not hold — a cross-origin srcset reaches the
    carrier with all its candidates intact."""

    def _carrier(self, fetched):
        from zimi.zimwriter import _AssetCarrier, make_asset_item

        def reader(url):
            fetched.append(url)
            return b"\x89PNG\r\n\x1a\n", "image/png"

        added = []
        return _AssetCarrier(added.append, make_asset_item, None, remote_reader=reader)

    def test_only_the_chosen_candidate_is_fetched(self):
        fetched = []
        carrier = self._carrier(fetched)
        html = (
            '<img srcset="https://cdn.test/a.png 400w, '
            'https://cdn.test/b.png 1600w, https://cdn.test/c.png 3200w">'
        )
        carrier.rewrite_media(None, "A/index", html)
        self.assertEqual(fetched, ["https://cdn.test/b.png"])


class TestAPageIsNotAnAsset(unittest.TestCase):
    """A media reference that answers with a web page is not a media asset.
    Storing what came back put thirty-four four-megabyte articles into a
    single-page capture, filed as images."""

    def test_html_is_refused(self):
        from zimi.zimwriter import _AssetCarrier, make_asset_item

        added = []

        def reader(url):
            return b"<html><body>a whole article</body></html>", "text/html"

        carrier = _AssetCarrier(added.append, make_asset_item, None, remote_reader=reader)
        self.assertIsNone(carrier._carry_remote("https://cdn.test/looks-like.png"))
        self.assertEqual(added, [])

    def test_same_origin_html_is_refused_too(self):
        """The commoner way in: a news site's own markup points <source>/<link>
        refs at its own articles, so they arrive through the same-origin
        carrier, not the remote one. A guard on only one of the two is a guard
        on neither."""
        from zimi.zimwriter import _AssetCarrier, make_asset_item

        added = []

        def read(zim, resolved):
            return b"<html><body>an article</body></html>", "text/html"

        carrier = _AssetCarrier(added.append, make_asset_item, read)
        self.assertIsNone(carrier._carry("z", "2026/07/18/politics/story"))
        self.assertEqual(added, [])

    def test_an_image_is_still_carried(self):
        from zimi.zimwriter import _AssetCarrier, make_asset_item

        added = []

        def reader(url):
            return b"\x89PNG\r\n\x1a\n", "image/png"

        carrier = _AssetCarrier(added.append, make_asset_item, None, remote_reader=reader)
        self.assertIsNotNone(carrier._carry_remote("https://cdn.test/real.png"))
        self.assertEqual(len(added), 1)
