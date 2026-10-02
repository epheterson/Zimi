"""Tests for the server-side accessibility HTML rewriter.

Each transform is tested in isolation, plus a few integration cases
that exercise multiple transforms at once."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.a11y as a11y  # noqa: E402

# ── Lang attribute transform ─────────────────────────────────────────


def test_lang_added_when_missing():
    html = "<!DOCTYPE html><html><head></head><body></body></html>"
    out = a11y.rewrite_html(html, lang_hint="en")
    assert '<html lang="en">' in out


def test_lang_preserved_when_present():
    html = '<html lang="fr"><body></body></html>'
    out = a11y.rewrite_html(html, lang_hint="en")
    assert '<html lang="fr">' in out
    assert 'lang="en"' not in out


def test_no_lang_added_when_no_hint():
    html = "<html><body></body></html>"
    out = a11y.rewrite_html(html, lang_hint="")
    assert "lang=" not in out


def test_lang_inserted_alongside_other_attrs():
    html = '<html dir="ltr"><body></body></html>'
    out = a11y.rewrite_html(html, lang_hint="en")
    assert "lang=" in out
    assert 'dir="ltr"' in out


# ── alt attribute transform ──────────────────────────────────────────


def test_alt_added_when_missing():
    html = '<body><img src="cat.jpg"></body>'
    out = a11y.rewrite_html(html)
    assert 'alt=""' in out


def test_alt_preserved_when_present():
    html = '<body><img src="cat.jpg" alt="A cat"></body>'
    out = a11y.rewrite_html(html)
    assert 'alt="A cat"' in out
    assert out.count("alt=") == 1


def test_alt_preserved_when_empty():
    html = '<body><img src="cat.jpg" alt=""></body>'
    out = a11y.rewrite_html(html)
    assert out.count("alt=") == 1


def test_alt_handles_self_closing_tag():
    html = '<body><img src="cat.jpg"/></body>'
    out = a11y.rewrite_html(html)
    assert "alt=" in out
    # And we don't double up the slash
    assert "/>" in out or 'alt="">' in out


def test_alt_added_to_multiple_images():
    html = '<img src="a.jpg"><img src="b.jpg" alt="b"><img src="c.jpg">'
    out = a11y.rewrite_html(html)
    assert out.count('alt=""') == 2  # a + c
    assert 'alt="b"' in out


def test_alt_case_insensitive_attr_check():
    html = '<img src="x.jpg" ALT="present">'
    out = a11y.rewrite_html(html)
    # Should NOT add a second alt; existing ALT counts.
    assert out.lower().count("alt=") == 1


def test_alt_no_op_when_no_images():
    html = "<body><p>Plain text</p></body>"
    out = a11y.rewrite_html(html)
    assert out == html


# ── the title as the heading ─────────────────────────────────────────
# Marked for screen readers, never rewritten: the page must look the same
# (the rewriter is always on).

H = 'role="heading" aria-level="1"'


def test_title_div_marked_as_heading_when_no_h1():
    html = '<body><div class="title">Article Heading</div><p>Body</p></body>'
    out = a11y.rewrite_html(html)
    assert '<div class="title" ' + H + '>Article Heading</div>' in out
    assert "<h1" not in out


def test_existing_h1_blocks_marking():
    html = '<body><h1>Real H1</h1><div class="title">Subtitle</div></body>'
    out = a11y.rewrite_html(html)
    assert '<div class="title">Subtitle</div>' in out
    assert "role=" not in out


def test_title_with_multiple_classes_marked():
    html = '<div class="article-header title big">Hello</div>'
    out = a11y.rewrite_html(html)
    assert '<div class="article-header title big" ' + H + '>Hello</div>' in out


def test_only_first_title_marked():
    html = '<div class="title">A</div><div class="title">B</div>'
    out = a11y.rewrite_html(html)
    assert out.count("role=") == 1
    assert '<div class="title">B</div>' in out


def test_empty_title_left_alone():
    html = '<div class="title"></div>'
    assert a11y.rewrite_html(html) == html


def test_nested_title_keeps_its_structure():
    """The old rewrite cut at the first </div> and broke a title holding
    a nested element; only the opening tag changes now."""
    html = '<div class="title"><div class="name">Ant</div> <span>(insect)</span></div><p>x</p>'
    out = a11y.rewrite_html(html)
    assert out == html.replace('<div class="title">', '<div class="title" ' + H + '>', 1)


def test_a_title_with_its_own_role_is_left_alone():
    html = '<div class="title" role="banner">X</div>'
    assert a11y.rewrite_html(html) == html


# ── Integration: all three transforms ────────────────────────────────


def test_all_transforms_run_together():
    html = (
        "<!DOCTYPE html><html><head></head><body>"
        '<div class="title">Hello World</div>'
        '<img src="x.jpg">'
        "</body></html>"
    )
    out = a11y.rewrite_html(html, lang_hint="es")
    assert '<html lang="es">' in out
    assert 'role="heading" aria-level="1">Hello World</div>' in out
    assert 'alt=""' in out


def test_empty_input_passes_through():
    assert a11y.rewrite_html("") == ""


def test_unicode_preserved():
    html = (
        '<body><div class="title">日本語タイトル</div><img src="x.jpg" alt="猫"></body>'
    )
    out = a11y.rewrite_html(html)
    assert "日本語タイトル" in out
    assert 'alt="猫"' in out


def test_rewriter_does_not_re_process():
    # Idempotency: running twice gives the same result as once.
    html = '<body><img src="x.jpg"><div class="title">T</div></body>'
    once = a11y.rewrite_html(html)
    twice = a11y.rewrite_html(once)
    assert once == twice


def test_malformed_html_does_not_crash():
    html = '<body><img src="<broken'
    # Should not raise
    out = a11y.rewrite_html(html)
    assert out is not None
