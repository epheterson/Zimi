"""The 1996 ``background=`` attribute is a picture reference too.

spacejam.com/1996 tiles its starfield with ``<body background="img/bg_stars.gif">``.
Both engines walked ``src``/``srcset``/``poster`` and never this, so the live
picture had stars and the packaged one was a black page — the first defect the
two pictures on the Create card caught, ten minutes after they existed.

Run: pytest tests/test_legacy_background.py -v
"""

import inspect
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import zimi.renderer as renderer  # noqa: E402
from zimi.zimwriter import _AssetCarrier  # noqa: E402

STARS = "https://www.spacejam.com/1996/img/bg_stars.gif"


class _Assets:
    """The rendered engine's carrier, reduced to the one question: is this URL
    something the browser fetched?"""

    def __init__(self, known):
        self.known = known
        self.asked = []

    def carry(self, url):
        self.asked.append(url)
        return "_assets/stars.gif" if url in self.known else None


def test_rendered_engine_rewrites_body_background_to_the_carried_file():
    html = (
        f'<body bgcolor="#000000" background="{STARS}" text="#ff0000"><p>hi</p></body>'
    )
    out = renderer._rewrite_asset_tags(_Assets({STARS}), html)
    assert 'background="../_assets/stars.gif"' in out
    assert 'bgcolor="#000000"' in out and 'text="#ff0000"' in out


def test_rendered_engine_reaches_table_cells_too():
    html = (
        f'<table background="{STARS}"><tr><td background="{STARS}">x</td></tr></table>'
    )
    out = renderer._rewrite_asset_tags(_Assets({STARS}), html)
    assert out.count('background="../_assets/stars.gif"') == 2


def test_a_background_the_browser_never_fetched_stays_as_written():
    html = '<body background="https://x.example/never.gif">'
    assert renderer._rewrite_asset_tags(_Assets(set()), html) == html


def test_the_page_script_absolutizes_background_before_the_walk():
    # carry() keys on the absolute URL the browser fetched; a relative
    # ``img/bg_stars.gif`` in the stored markup would match nothing, which is
    # exactly the bug. The in-page pass has to make it absolute like src.
    src = inspect.getsource(renderer)
    for tag in ("body", "table", "tr", "td", "th"):
        assert f"['{tag}', 'background']" in src, tag


def test_fast_engine_carries_a_body_background():
    added = []
    c = _AssetCarrier(
        added.append,
        lambda path, mime, data: (path, mime, data),
        lambda zim, resolved: None,
        remote_reader=lambda url: (b"GIF89a", "image/gif"),
        page_url="https://www.spacejam.com/1996/",
    )
    # A same-origin relative ref goes through the source reader, which this
    # carrier does not have; the absolute form takes the remote road, which is
    # the one a cross-origin picture takes on the create path.
    out = c.rewrite_media("z", "A/index", f'<body bgcolor="#000000" background="{STARS}">')
    assert len(added) == 1, added
    carried_path = added[0][0]
    # A remote picture lands under a content-addressed name, as every remote
    # asset does; what matters is that it landed and the tag points at it.
    assert carried_path.startswith("_assets/") and carried_path.endswith(".gif")
    assert f'background="../{carried_path}"' in out
    assert 'bgcolor="#000000"' in out
