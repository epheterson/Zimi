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


# ── h1 promotion transform ───────────────────────────────────────────


def test_div_title_promoted_to_h1_when_no_h1():
    html = '<body><div class="title">Article Heading</div><p>Body</p></body>'
    out = a11y.rewrite_html(html)
    assert "<h1>Article Heading</h1>" in out


def test_existing_h1_blocks_promotion():
    html = '<body><h1>Real H1</h1><div class="title">Subtitle</div></body>'
    out = a11y.rewrite_html(html)
    assert "<h1>Real H1</h1>" in out
    assert '<div class="title">Subtitle</div>' in out
    assert out.count("<h1") == 1


def test_div_title_with_multiple_classes_promoted():
    html = '<div class="article-header title big">Hello</div>'
    out = a11y.rewrite_html(html)
    assert "<h1>Hello</h1>" in out


def test_only_first_title_div_promoted():
    html = '<div class="title">A</div><div class="title">B</div>'
    out = a11y.rewrite_html(html)
    assert "<h1>A</h1>" in out
    assert '<div class="title">B</div>' in out


def test_empty_title_div_left_alone():
    html = '<div class="title"></div>'
    out = a11y.rewrite_html(html)
    # No <h1> created from empty content
    assert "<h1>" not in out


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
    assert "<h1>Hello World</h1>" in out
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
