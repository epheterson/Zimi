"""Server-side HTML accessibility rewriter for ZIM content.

ZIM articles vary wildly in their HTML quality. Wikipedia is mostly
fine; Stack Exchange and dev-docs sometimes ship malformed heading
structure or unlabeled images. This module fixes the most impactful
issues so screen-reader users get a navigable document.

The rewriter is opt-in. Users (or proxies) pass `?a11y=1` on the
content URL to enable it. Three transforms in order:

1. Fill in `<html lang>` from a passed-in language hint when missing
2. Add `alt=""` to images that lack any alt attribute (decorative by
   default per WCAG 1.1.1 — purely decorative images shouldn't speak,
   and authors who left alt off are almost never marking content)
3. Promote the first `<div class="title">` to an `<h1>` when no `<h1>`
   exists in the document. Screen-readers navigate by heading and
   getting a real `<h1>` per article is the single biggest win.

We use stdlib `html.parser` rather than BeautifulSoup so the rewriter
ships with no extra dependencies and has predictable behavior on
malformed input.
"""

from __future__ import annotations

import re

# Regex tradeoff: HTML is irregular, but we don't try to FULLY parse —
# we only do localized fixes. Each pattern is bounded enough that
# false positives degrade to "no change" rather than "broken document".

_IMG_TAG_RE = re.compile(r"<img\b([^>]*?)>", re.IGNORECASE)
_IMG_HAS_ALT_RE = re.compile(r"\balt\s*=", re.IGNORECASE)

_HTML_OPEN_RE = re.compile(r"<html\b([^>]*)>", re.IGNORECASE)
_HTML_HAS_LANG_RE = re.compile(r"\blang\s*=", re.IGNORECASE)

# We only promote a div→h1 if there's NO existing h1 in the document.
# Use a non-greedy class match because some divs have multiple classes.
_H1_PRESENT_RE = re.compile(r"<h1\b", re.IGNORECASE)
_TITLE_DIV_RE = re.compile(
    r'<div\b([^>]*?\bclass\s*=\s*["\'][^"\']*\btitle\b[^"\']*["\'][^>]*)>([\s\S]*?)</div>',
    re.IGNORECASE,
)


def rewrite_html(text: str, *, lang_hint: str = "") -> str:
    """Apply the three accessibility transforms to the HTML body.

    Pure: same input → same output. No I/O, no globals. Safe to test
    in isolation.

    Args:
        text: HTML source as a Python string.
        lang_hint: BCP-47 language code to fill into <html lang> if it
            has none. Pass "" to skip the transform.

    Returns:
        The transformed HTML. If a transform's preconditions aren't
        met (no images, no missing alt, etc.) the document passes
        through unchanged for that transform.
    """
    if not text:
        return text
    text = _add_lang_attribute(text, lang_hint) if lang_hint else text
    text = _add_missing_alt(text)
    text = _promote_first_title_to_h1(text)
    return text


def _add_lang_attribute(text: str, lang: str) -> str:
    match = _HTML_OPEN_RE.search(text)
    if not match:
        return text
    if _HTML_HAS_LANG_RE.search(match.group(1) or ""):
        return text  # already has lang
    new_attrs = (match.group(1) or "") + f' lang="{lang}"'
    return text[: match.start()] + f"<html{new_attrs}>" + text[match.end() :]


def _add_missing_alt(text: str) -> str:
    def _fix(m):
        attrs = m.group(1) or ""
        if _IMG_HAS_ALT_RE.search(attrs):
            return m.group(0)
        # Strip any trailing slash/whitespace before re-emitting the tag
        attrs = attrs.rstrip(" /")
        return f'<img{attrs} alt="">'

    return _IMG_TAG_RE.sub(_fix, text)


def _promote_first_title_to_h1(text: str) -> str:
    if _H1_PRESENT_RE.search(text):
        return text
    match = _TITLE_DIV_RE.search(text)
    if not match:
        return text
    inner = (match.group(2) or "").strip()
    if not inner:
        return text
    # Replace just this match (the first one) with an h1.
    start, end = match.span()
    return text[:start] + f"<h1>{inner}</h1>" + text[end:]
