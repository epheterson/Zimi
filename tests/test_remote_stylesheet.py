"""A stylesheet on a CDN is still the page's stylesheet.

cheatography.com's only real stylesheet is media.cheatography.com/styles/…css;
the carrier left cross-origin sheets alone by design ("external refs,
honestly absent offline"), and the captured page opened as a naked list of
links with a broken image box (survey UI pass, 2026-09-03). A page's look is
not decoration; it is carried like its pictures, one level of url() refs
deep, the way a same-origin sheet already is.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi.creator import _carry_stylesheets  # noqa: E402
from zimi.zimwriter import _AssetCarrier  # noqa: E402

CSS = b"body{background:url(../img/bg.png)} @font-face{src:url('fonts/a.woff2')} .x{background:url(data:image/png;base64,AAAA)}"


def _remote(url):
    url = url.split("?", 1)[0]
    if url.endswith(".css"):
        return (CSS, "text/css")
    if url.endswith(".png"):
        return (b"PNG", "image/png")
    if url.endswith(".woff2"):
        return (b"WOFF", "font/woff2")
    return None


class TestARemoteStylesheetIsCarried(unittest.TestCase):
    def setUp(self):
        self.added = []
        self.carrier = _AssetCarrier(
            self.added.append,
            lambda path, mime, data: (path, mime, data),
            lambda zim, resolved: None,
            remote_reader=_remote,
            page_url="https://cheatography.com/",
        )

    def test_the_link_points_into_the_zim_and_the_sheet_keeps_its_fonts(self):
        page = '<link href="https://media.cheatography.com/styles/styles.scss.css?v=27" rel="stylesheet">'
        out = _carry_stylesheets(self.carrier, "lbl", "https://cheatography.com/", page)
        self.assertNotIn("media.cheatography.com", out)
        self.assertIn('href="../_assets/_remote/', out)
        kinds = sorted(mime for _p, mime, _d in self.added)
        self.assertEqual(kinds, ["font/woff2", "image/png", "text/css"], self.added)
        css = next(d for p, m, d in self.added if m == "text/css").decode()
        # url() refs resolved against the sheet's own address, carried, and
        # written as siblings in _assets/_remote (which is where the sheet is).
        self.assertNotIn("../img/bg.png", css)
        self.assertNotIn("fonts/a.woff2", css)
        self.assertEqual(css.count("url("), 3)
        self.assertIn("url(data:image/png;base64,AAAA)", css, "a data URI is left exactly alone")
        for p, m, _d in self.added:
            if m != "text/css":
                self.assertIn("url(" + os.path.basename(p) + ")", css.replace("'", ""), css)

    def test_a_protocol_relative_sheet_is_carried_too(self):
        page = '<link rel="stylesheet" href="//cdnjs.cloudflare.com/x/github-gist.min.css">'
        out = _carry_stylesheets(self.carrier, "lbl", "https://cheatography.com/", page)
        self.assertIn('href="../_assets/_remote/', out)
        self.assertEqual(sorted(m for _p, m, _d in self.added), ["font/woff2", "image/png", "text/css"])

    def test_without_a_remote_reader_nothing_changes(self):
        c = _AssetCarrier(self.added.append, lambda p, m, d: (p, m, d), lambda z, r: None)
        page = '<link rel="stylesheet" href="https://cdn.example/a.css">'
        self.assertEqual(_carry_stylesheets(c, "lbl", "https://e.com/", page), page)


if __name__ == "__main__":
    unittest.main()
