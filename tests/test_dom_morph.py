"""Patching a panel in place instead of rebuilding it.

The Downloads tab polls every three seconds and used to assign innerHTML each
time. Every rebuild re-created every <img>, which the browser paints blank for
a frame, so the seed icons flashed on every poll (Eric, from his phone:
"flashes icons a lot"), and the sweeping progress bar restarted its animation
from zero. _morphInto keeps an element that is the same tag in the same place
and brings its attributes and text up to date.

This runs in a real browser because the thing being pinned is element
identity, which no string comparison can see.

Run: pytest tests/test_dom_morph.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

APP_JS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "static",
    "app.js",
)
_SRC = open(APP_JS, encoding="utf-8").read()


def _function(name):
    i = _SRC.index("function " + name + "(")
    depth = 0
    for k in range(_SRC.index("{", i), len(_SRC)):
        if _SRC[k] == "{":
            depth += 1
        elif _SRC[k] == "}":
            depth -= 1
            if depth == 0:
                return _SRC[i : k + 1]
    raise AssertionError("unbalanced " + name)


MORPH = "\n".join(_function(n) for n in ("_morphInto", "_morphChildren", "_morphAttrs"))


@pytest.fixture
def page():
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("playwright is not installed here")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        pg = browser.new_page()
        pg.set_content("<!doctype html><html><body><div id=host></div></body></html>")
        pg.add_script_tag(content=MORPH)
        yield pg
        browser.close()


def _morph(page, html):
    page.evaluate("(h) => _morphInto(document.getElementById('host'), h)", html)


def test_an_unchanged_image_is_the_same_element_after_a_patch(page):
    """The flicker. A re-created <img> repaints; the same element does not."""
    _morph(page, '<div class="row"><img src="data:," width="20"><span>one</span></div>')
    page.evaluate("window.img0 = document.querySelector('#host img')")
    _morph(page, '<div class="row"><img src="data:," width="20"><span>two</span></div>')
    assert page.evaluate("document.querySelector('#host img') === window.img0")
    assert page.evaluate("document.querySelector('#host span').textContent") == "two"


def test_attributes_are_added_changed_and_removed(page):
    _morph(page, '<div class="a" title="old" data-gone="1"></div>')
    page.evaluate("window.d0 = document.querySelector('#host div')")
    _morph(page, '<div class="a b" title="new"></div>')
    assert page.evaluate("document.querySelector('#host div') === window.d0")
    assert page.evaluate("window.d0.className") == "a b"
    assert page.evaluate("window.d0.getAttribute('title')") == "new"
    assert page.evaluate("window.d0.hasAttribute('data-gone')") is False


def test_a_progress_bar_width_updates_in_place(page):
    """style is an attribute like any other; the bar animates from 30 to 40
    instead of appearing at 40 in a fresh element."""
    _morph(page, '<div class="bar" style="width:30%"></div>')
    page.evaluate("window.b0 = document.querySelector('#host .bar')")
    _morph(page, '<div class="bar" style="width:40%"></div>')
    assert page.evaluate("document.querySelector('#host .bar') === window.b0")
    assert page.evaluate("window.b0.style.width") == "40%"


def test_disabled_follows_the_new_markup(page):
    """A property the attribute stops driving once the element exists."""
    _morph(page, "<button disabled>x</button>")
    _morph(page, "<button>x</button>")
    assert page.evaluate("document.querySelector('#host button').disabled") is False
    _morph(page, "<button disabled>x</button>")
    assert page.evaluate("document.querySelector('#host button').disabled") is True


def test_an_inline_handler_is_updated(page):
    _morph(page, "<button onclick=\"window.hit='a'\">x</button>")
    _morph(page, "<button onclick=\"window.hit='b'\">x</button>")
    page.click("#host button")
    assert page.evaluate("window.hit") == "b"


def test_a_different_tag_in_the_same_place_is_replaced(page):
    _morph(page, "<div>one</div><span>two</span>")
    _morph(page, "<p>one</p><span>two</span>")
    assert page.evaluate(
        "Array.from(document.getElementById('host').children).map(e => e.tagName)"
    ) == ["P", "SPAN"]


def test_extra_children_are_removed_and_missing_ones_added(page):
    _morph(page, "<i>1</i><i>2</i><i>3</i>")
    _morph(page, "<i>1</i>")
    assert page.evaluate("document.getElementById('host').childNodes.length") == 1
    _morph(page, "<i>1</i><i>2</i>")
    assert page.evaluate("document.getElementById('host').textContent") == "12"
    _morph(page, "")
    assert page.evaluate("document.getElementById('host').childNodes.length") == 0
