#!/usr/bin/env python3
"""A <script> body is text, and text must not be parsed as markup.

sqlite.org's homepage builds its sponsor logos in JavaScript, by
concatenating strings that happen to contain HTML:

    h += "'><img src='images/foreignlogos/";
    h += sponsors[i].src + "'";

So the page literally contains the characters ``<img src='images/…``. The
asset carrier saw an <img> tag, saw an opening quote, and — with DOTALL on,
which real multi-line attributes require — read to the next quote three lines
away. The "URL" that came out had a newline in it. urlopen refused it with
http.client.InvalidURL, which is not an OSError and so was not caught, and a
fifteen-page site crawl died on its first page in 3.1 seconds.

Two independent defects, so two independent guards here:

  1. we should never have looked inside the script at all;
  2. no single unusable asset reference may ever end a job.

The fixture is the real fragment, byte for byte, from the live page on
2026-08-31 — a synthetic approximation would not have the specific quoting
that caused this.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi.crawler import extract_links  # noqa: E402
from zimi.zimwriter import (  # noqa: E402
    _MEDIA_TAG_RE,
    _SRC_RE,
    mask_raw_text,
    sub_markup,
)

# Verbatim from https://www.sqlite.org/ — the exact bytes that broke the crawl.
SQLITE_SCRIPT = """<div id='sponsors'></div>
<script>
  var sponsors = [ { "href":"https://example.com/", "src":"reportr.png", "wx":0 } ];
  var h = "";
  for(var i=0; i<sponsors.length; i++){
    h += "<span class='onesponsor'><a href='";
    h += sponsors[i].href;
    h += "'><img src='images/foreignlogos/";
    h += sponsors[i].src + "'";
    h += ">";
  }
  document.getElementById('sponsors').innerHTML = h;
</script>
<p>Real content.</p>
<img src="/real/picture.png" alt="a genuine one">
"""


class TestTheScriptBodyIsInvisible(unittest.TestCase):
    def test_the_old_matcher_really_did_produce_a_url_with_a_newline(self):
        """The bug, reproduced — so a regression cannot pass silently.

        Without masking, the src value spans three lines of JavaScript. This
        asserts the defect exists in an unmasked scan, which is what makes the
        masked assertions below meaningful rather than vacuous."""
        tag = _MEDIA_TAG_RE.search(SQLITE_SCRIPT)
        self.assertIsNotNone(tag, "the JS string does look like a tag")
        value = _SRC_RE.search(tag.group(0)).group("val")
        self.assertIn("\n", value)
        self.assertIn("sponsors[i].src", value)

    def test_masking_hides_the_script_body_and_nothing_else(self):
        masked = mask_raw_text(SQLITE_SCRIPT)
        # Same length, or every offset a caller computes is wrong.
        self.assertEqual(len(masked), len(SQLITE_SCRIPT))
        # The JavaScript is gone…
        self.assertNotIn("sponsors[i].src", masked)
        self.assertNotIn("foreignlogos", masked)
        # …the tags that delimited it stay, so the document still parses…
        self.assertIn("<script>", masked)
        self.assertIn("</script>", masked)
        # …and everything outside is untouched.
        self.assertIn('<img src="/real/picture.png"', masked)
        self.assertIn("<p>Real content.</p>", masked)

    def test_the_carrier_sees_only_the_real_image(self):
        seen = []

        def note(m):
            seen.append(_SRC_RE.search(m.group(0)).group("val"))
            return m.group(0)

        out = sub_markup(_MEDIA_TAG_RE, note, SQLITE_SCRIPT)
        self.assertEqual(seen, ["/real/picture.png"])
        # A pass that rewrites nothing must return the document unchanged —
        # the splice is byte-exact, not merely close.
        self.assertEqual(out, SQLITE_SCRIPT)

    def test_a_rewrite_lands_in_the_original_not_the_mask(self):
        """The splice writes into the real document, so the script survives."""

        def rewrite(m):
            return '<img src="ASSET">'

        out = sub_markup(_MEDIA_TAG_RE, rewrite, SQLITE_SCRIPT)
        self.assertIn('<img src="ASSET">', out)
        # The JavaScript came back exactly as the site wrote it.
        self.assertIn("h += \"'><img src='images/foreignlogos/\";", out)

    def test_links_written_by_javascript_are_not_crawled(self):
        links = extract_links(SQLITE_SCRIPT, "https://www.sqlite.org/")
        self.assertEqual(links, [], f"crawled a link out of a script: {links}")

    def test_a_real_anchor_beside_a_script_is_still_found(self):
        page = SQLITE_SCRIPT + '<a href="/docs.html">Docs</a>'
        self.assertEqual(
            extract_links(page, "https://www.sqlite.org/"),
            ["https://www.sqlite.org/docs.html"],
        )


class TestStyleAndComments(unittest.TestCase):
    def test_a_style_body_is_raw_text_too(self):
        page = "<style>/* <img src='x.png'> */</style><img src='y.png'>"
        seen = []
        sub_markup(_MEDIA_TAG_RE, lambda m: seen.append(m.group(0)) or "", page)
        self.assertEqual(seen, ["<img src='y.png'>"])

    def test_a_commented_out_tag_is_not_carried(self):
        page = "<!-- <img src='old.png'> --><img src='new.png'>"
        seen = []
        sub_markup(_MEDIA_TAG_RE, lambda m: seen.append(m.group(0)) or "", page)
        self.assertEqual(seen, ["<img src='new.png'>"])

    def test_an_unclosed_script_does_not_swallow_the_document(self):
        """A malformed page is common; losing the rest of it is not acceptable.

        With no closing tag the element does not match, so nothing is masked
        and the scan behaves exactly as it did before. That is the safe
        direction to fail in: we may look at too much, never at too little."""
        page = "<script>var a = 1;<img src='real.png'>"
        self.assertEqual(mask_raw_text(page), page)


class TestNothingIsLazyOffline(unittest.TestCase):
    """A captured page is not on a network; deferring a local read is loss.

    Measured on the real cnn.com capture: 117 images, 45 painted. All 72 that
    did not were loading="lazy", and 59 of those had a zero-sized box, because
    the page's rails collapse when its JavaScript never runs. Zero HTTP
    failures — the browser simply never asked. Scrolling cannot fix it: an
    image in a zero-height container never approaches the viewport.
    """

    def test_lazy_is_dropped(self):
        from zimi.zimwriter import _load_eagerly

        self.assertEqual(
            _load_eagerly("<img src='a.png' loading='lazy' alt='x'>"),
            "<img src='a.png' alt='x'>",
        )

    def test_every_spelling_of_lazy(self):
        from zimi.zimwriter import _load_eagerly

        for tag in (
            '<img loading="lazy" src="a.png">',
            "<img loading=lazy src='a.png'>",
            '<img LOADING="LAZY" src="a.png">',
            '<source loading=" lazy " srcset="a.png">',
        ):
            with self.subTest(tag=tag):
                self.assertNotIn("lazy", _load_eagerly(tag).lower())
                self.assertIn("a.png", _load_eagerly(tag))

    def test_eager_is_left_exactly_as_the_page_wrote_it(self):
        """Only lazy is a problem. An explicit eager is already what we want,
        and rewriting attributes we do not need to touch is how pages break."""
        from zimi.zimwriter import _load_eagerly

        for tag in ('<img src="a.png" loading="eager">', '<img src="a.png">'):
            with self.subTest(tag=tag):
                self.assertEqual(_load_eagerly(tag), tag)

    def test_a_lazy_attribute_on_a_data_prefixed_name_is_not_ours(self):
        from zimi.zimwriter import _load_eagerly

        tag = '<img src="a.png" data-loading="lazy">'
        self.assertEqual(_load_eagerly(tag), tag)


class TestNoAssetCanEndAJob(unittest.TestCase):
    def test_a_url_python_refuses_to_request_is_a_skipped_asset(self):
        """The second guard, independent of the first.

        Even with the script masked, some page somewhere will hand us a
        reference urllib cannot turn into a request. That must be one dropped
        image, not a dead job."""
        from zimi.creator import _http_remote_reader

        read = _http_remote_reader(timeout=1)
        for bad in (
            "https://e.org/a\nb.png",  # control character: InvalidURL
            "https://e.org/\x00.png",
            "wat://e.org/x.png",  # unknown scheme: ValueError
            "://////",
        ):
            with self.subTest(url=bad):
                self.assertIsNone(read(bad))


if __name__ == "__main__":
    unittest.main()


class TestTheMaskIsNotAWhitespaceDesert(unittest.TestCase):
    """cnn.com's page carries a 2.5 MB inline stylesheet. Masking it to
    spaces handed every attribute scanner a run of 2.5 million spaces, and a
    pattern with a leading ``\\s*`` walks such a run quadratically: the
    style-attribute carry never returned, the create job never finished, and
    the server stopped answering (prod, 2026-09-03, 18:02). The mask keeps
    its length and hides its markup, in a filler no pattern wants."""

    def test_a_masked_megabyte_scans_in_well_under_a_second(self):
        import time

        from zimi.zimwriter import attr_re

        page = "<div style='color:red'>" + "<style>" + "a{}" * 700_000 + "</style>" + '<p style="x:url(a.png)">t</p>'
        masked = mask_raw_text(page)
        self.assertEqual(len(masked), len(page))
        t = time.monotonic()
        hits = [m.group("val") for m in attr_re("style").finditer(masked)]
        self.assertLess(time.monotonic() - t, 1.0)
        self.assertEqual(hits, ["color:red", "x:url(a.png)"])
