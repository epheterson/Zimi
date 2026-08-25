"""Reading one attribute out of one HTML tag.

Every capture and export path asks "what does this tag's src/href/rel say", and
each of them used to answer with its own regex. There were eight, in four
files, and six shared two defects that this module exists to keep fixed:

  * **Quotes were required.** ``<link rel=stylesheet href=/a.css>`` is legal
    HTML5 and ordinary in hand-written pages. To six of those eight it did not
    exist, so the capture came out with no stylesheet and nothing said so.
  * **``\\bsrc`` matches inside ``data-src``**, because ``-`` is not a word
    character. On a lazy-loading page — which is most news sites — the first
    match was the placeholder, not the image.

Both are silent: the ZIM builds, the job succeeds, and the loss shows up later
as a page that renders wrong on somebody's phone. That is the reason these are
pinned mechanically instead of being left to a capture test to notice.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.creator as creator  # noqa: E402
import zimi.renderer as renderer  # noqa: E402
import zimi.zimwriter as zimwriter  # noqa: E402
from zimi.zimwriter import attr_re  # noqa: E402

# ── the three legal shapes ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    "html,want",
    [
        ('<img src="/hero.png">', "/hero.png"),
        ("<img src='/hero.png'>", "/hero.png"),
        ("<img src=/hero.png>", "/hero.png"),  # bare: the one that was invisible
        ('<img src = "/hero.png">', "/hero.png"),  # spaces around =
        ('<img SRC="/hero.png">', "/hero.png"),  # case
        ('<img src="/a b.png">', "/a b.png"),  # a space survives inside quotes
        ('<img src="">', ""),  # empty is a value, not a miss
        ("<img src=/a.png alt=x>", "/a.png"),  # bare stops at whitespace
        ("<img src=/a.png>", "/a.png"),  # bare stops at >
    ],
)
def test_a_value_is_found_in_every_legal_spelling(html, want):
    m = attr_re("src").search(html)
    assert m is not None, f"no match in {html}"
    assert m.group("val") == want


def test_a_bare_value_does_not_run_past_the_tag():
    """The bare character class excludes `>`; without that, one malformed
    attribute swallows the rest of the document."""
    m = attr_re("src").search("<img src=><p>after</p>")
    assert m.group("val") == ""


# ── the attribute next door ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    "html,name,want",
    [
        # The real defect: data-src is the lazy placeholder, src is the image.
        ('<img data-src="/lazy.png" src="/real.png">', "src", "/real.png"),
        ('<img src="/real.png" data-src="/lazy.png">', "src", "/real.png"),
        ('<img data-srcset="/a 2x" srcset="/b.png">', "srcset", "/b.png"),
        # A namespaced attribute is a different attribute.
        ('<use xlink:href="#icon"/><a href="/next">', "href", "/next"),
        # And an underscore is a word character, so \b never caught this either.
        ('<img my_src="x" src="/ok.png">', "src", "/ok.png"),
    ],
)
def test_a_prefixed_attribute_is_a_different_attribute(html, name, want):
    assert attr_re(name).search(html).group("val") == want


def test_the_shipped_matchers_all_read_a_bare_attribute():
    """The specific regression: these are the objects the capture and export
    paths actually hold, so pinning attr_re alone would not prove they use it."""
    page = "<link rel=stylesheet href=/a.css>"
    assert zimwriter._REL_RE.search(page).group("val") == "stylesheet"
    assert zimwriter._HREF_RE.search(page).group("val") == "/a.css"
    assert renderer._REL_ATTR_RE.search(page).group("val") == "stylesheet"
    assert creator._LINK_HREF_RE.search(page).group("val") == "/a.css"

    media = "<img src=/hero.png srcset=/hero_2x.png>"
    assert zimwriter._SRC_RE.search(media).group("val") == "/hero.png"
    assert zimwriter._SRCSET_RE.search(media).group("val") == "/hero_2x.png"


# ── rewriting ───────────────────────────────────────────────────────────────


def test_a_rewrite_always_emits_quotes():
    """A value that arrived bare must not be written back bare: the reference
    we substitute is a ZIM path we chose, and it may contain characters an
    unquoted attribute cannot hold."""
    out = zimwriter._SRC_RE.sub(
        lambda m: f'{m.group("pre")}"H/img/a.png"', "<img src=/hero.png>"
    )
    assert out == '<img src="H/img/a.png">'
    # And the placeholder beside it is still untouched.
    lazy = '<img data-src="/lazy.png" src=/hero.png>'
    assert 'data-src="/lazy.png"' in zimwriter._SRC_RE.sub(
        lambda m: f'{m.group("pre")}"H/img/a.png"', lazy
    )


def test_a_value_carried_from_the_page_is_escaped_on_the_way_out():
    """Emitting `pre + '"' + value + '"'` is safe for a value we invented and
    wrong for one the page gave us: HTML lets a SINGLE-quoted attribute hold a
    double quote, so `<img src='a"b.png'>` came back out as `<img src="/a"b.png">`
    — markup broken, src truncated to `/a`. Silent, and shipped for a day."""
    variants = creator._origin_variants("https://ex.com/")[1]
    out = creator._relativize_html("<img src='https://ex.com/a\"b.png'>", variants)
    assert out.count('"') % 2 == 0, out
    assert "&quot;" in out
    assert '<img src="/a&quot;b.png">' == out


def test_escaping_does_not_double_an_entity_already_there():
    """Escaping the whole value would turn an existing `&amp;` into
    `&amp;amp;` — the same shape as the unescaping bug that cost a day. Only
    the quote is touched; `&` and `<` stay however the page wanted them."""
    assert zimwriter.attr_quote("x?q=1&amp;r=2") == "x?q=1&amp;r=2"
    assert zimwriter.attr_quote('a"b') == "a&quot;b"
    assert zimwriter.attr_quote("plain") == "plain"


def test_stripping_an_attribute_leaves_no_double_space():
    """The leading whitespace lives inside `pre` so that removing an attribute
    from an attribute list closes the gap behind it."""
    assert zimwriter._ANCHOR_HREF_RE.sub("", '<a class="x" href="/y">') == (
        '<a class="x">'
    )


def test_one_builder_serves_every_caller():
    """The point of the exercise. Two matchers for the same attribute would
    drift apart again, which is exactly how six of the eight ended up wrong."""
    assert attr_re("href") is attr_re("href")
    assert zimwriter._HREF_RE is creator._LINK_HREF_RE
    assert renderer._attr_re is attr_re
