"""Content preview extraction — thumbnails, blurbs, and metadata from ZIM articles."""

import html
import logging
import re
from urllib.parse import unquote

from zimi import wikilang as _wikilang

log = logging.getLogger("zimi")


def strip_html(text):
    """Remove HTML tags and decode entities, return plain text."""
    # A script or style the read cut off before its end runs to the end:
    # mwoffliner's Wikivoyage pages open with a config script longer than
    # /snippet's read, and its code came back as the page's snippet.
    text = re.sub(r"<script[^>]*>.*?(?:</script>|$)", "", text, flags=re.DOTALL)
    text = re.sub(r"<style[^>]*>.*?(?:</style>|$)", "", text, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    # A read of the start of a page can end inside a tag, which the pattern
    # above cannot close: '... 1879 <a rel="mw:WikiLink" href="Ulm" t'.
    text = re.sub(r"<[^>]*$", "", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


_BLOCK_TAG_RE = re.compile(
    r"</?(?:br|p|div|li|ul|ol|dl|dd|dt|table|tr|td|th|h[1-6]|section|blockquote)\b[^>]*>",
    re.IGNORECASE,
)


def inline_text(fragment):
    """A fragment of running text as it reads. Unlike strip_html, a link or
    a span inside a word leaves no space behind: Hebrew and Arabic glue a
    prefix to the word a link starts ("ל<a>קיסר</a>" is one word), and
    Chinese and Japanese put no spaces between words at all."""
    text = re.sub(r"<!--.*?-->", "", fragment, flags=re.DOTALL)
    text = re.sub(r"<(script|style)\b[^>]*>.*?(?:</\1>|$)", "", text, flags=re.DOTALL)
    text = _BLOCK_TAG_RE.sub(" ", text)
    text = re.sub(r"<[^>]*>?", "", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


_FOOTNOTE_RE = re.compile(r"<sup\b[^>]*>.*?</sup>", re.DOTALL | re.IGNORECASE)


def strip_html_inline(text):
    """inline_text for a card: footnote marks dropped, and no space left
    before a closing punctuation mark ("word [ 2 ] ." is "word.")."""
    text = inline_text(_FOOTNOTE_RE.sub("", text))
    text = re.sub(r"\[\s*\d+\s*\]", "", text)  # a footnote mark left as text
    return _SNIPPET_SPACE_BEFORE_PUNCT_RE.sub(
        lambda g: g.group(1) or g.group(2), text
    ).strip()


# Some ZIMs bake a single repeated <meta description> into every page — iFixit
# device pages carry a featured-guide blurb ("How to replace the SSD in your
# Lenovo Legion…") rather than the device's own description. When a page exposes
# its own summary block (iFixit's .banner-blurb / itemprop="description"), that
# wins over the meta tag.
_SNIPPET_OWN_SUMMARY_RES = [
    re.compile(
        r'<p[^>]*\bclass=["\'][^"\']*\bbanner-blurb\b[^"\']*["\'][^>]*>(.*?)</p>',
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(
        r'<[a-z]+[^>]*\bitemprop=["\']description["\'][^>]*>(.*?)</[a-z]+>',
        re.IGNORECASE | re.DOTALL,
    ),
]
_SNIPPET_META_DESC_RES = [
    re.compile(
        r'<meta\s+(?:name|property)=["\'](?:og:)?description["\']\s+'
        r'content=["\']([^"\']{20,})["\']',
        re.IGNORECASE,
    ),
    re.compile(
        r'<meta\s+content=["\']([^"\']{20,})["\']\s+'
        r'(?:name|property)=["\'](?:og:)?description["\']',
        re.IGNORECASE,
    ),
]
# Repeated-across-pages chrome stripped before the body-text fallback: whole
# nav/aside/header/footer elements, plus TOC / breadcrumb / related-guides
# containers keyed by class. Lazy match — approximate but cheap; the goal is
# to keep boilerplate prose out of the last-resort snippet.
_SNIPPET_BOILERPLATE_RE = re.compile(
    r"<(nav|aside|header|footer)\b[^>]*>.*?</\1>"
    r'|<[a-z]+[^>]*\bclass=["\'][^"\']*\b'
    r"(?:toc|breadcrumb|related-guides|featured-guides|navigation|"
    r'js-dynamic-toc-section)\b[^"\']*["\'][^>]*>.*?</[a-z]+>',
    re.IGNORECASE | re.DOTALL,
)


_SNIPPET_PARAGRAPH_RE = re.compile(r"<p\b[^>]*>(.*?)</p>", re.IGNORECASE | re.DOTALL)
# Citation markers only: a <sup> is also the 2 in E = mc2.
_SNIPPET_CITATION_RE = re.compile(
    r"<sup\b[^>]*\bclass=[\"'][^\"']*\breference\b[^>]*>.*?</sup>",
    re.IGNORECASE | re.DOTALL,
)
# Tags become spaces when stripped, which leaves "relativity ." behind.
_SNIPPET_SPACE_BEFORE_PUNCT_RE = re.compile(r"\s+([.,;:!?)\]。、，；：])|([(\[])\s+")
# Shorter than this is a caption, a byline or an empty <p></p>, not a lead.
_SNIPPET_MIN_PARAGRAPH = 60


def extract_snippet(text, zim_name=""):
    """Best short text snippet for the /snippet endpoint.

    Order of preference:
      1. The page's own summary block (iFixit device blurb / itemprop
         description) — beats a repeated boilerplate <meta description>.
      2. A <meta (og:)description> tag.
      3. <main>/<article> body prose, boilerplate chrome stripped.
      4. Full page text, boilerplate chrome stripped.

    ``text`` is the already-decoded HTML lead (the caller reads ~15 KB, enough
    for <head> meta + the opening content). Returns a plain-text string
    (possibly empty)."""
    # 1. Page's own summary block.
    for rx in _SNIPPET_OWN_SUMMARY_RES:
        m = rx.search(text)
        if m:
            s = strip_html(m.group(1))[:300].strip()
            if len(s) >= 20:
                return s
    # 2. Meta description (near the top of <head>).
    for rx in _SNIPPET_META_DESC_RES:
        m = rx.search(text[:8000])
        if m:
            s = strip_html(m.group(1))[:300].strip()
            if s:
                return s
    # 3/4. Body prose, with repeated chrome removed first.
    cleaned = _SNIPPET_BOILERPLATE_RE.sub(" ", text)
    # 3. The first real paragraph, citation markers out. An encyclopedia page
    # opens with hatnotes and an infobox table; its lead sentence is the
    # first <p> with some length to it.
    for m in _SNIPPET_PARAGRAPH_RE.finditer(cleaned):
        s = strip_html(_SNIPPET_CITATION_RE.sub("", m.group(1)))
        s = _SNIPPET_SPACE_BEFORE_PUNCT_RE.sub(lambda g: g.group(1) or g.group(2), s)
        if len(s) >= _SNIPPET_MIN_PARAGRAPH:
            return s[:300].strip()
    for tag in ("main", "article"):
        tag_m = re.search(r"<" + tag + r"[\s>]", cleaned, re.IGNORECASE)
        if tag_m:
            s = strip_html(cleaned[tag_m.start() :])[:300].strip()
            if s:
                return s
    return strip_html(cleaned)[:300].strip()


def _resolve_img_path(archive, path, src):
    """Resolve a relative image src to a ZIM entry path. Returns URL or None."""
    decoded = unquote(unquote(src))
    if decoded.startswith("/"):
        img_path = decoded.lstrip("/")
    else:
        base = "/".join(path.split("/")[:-1])
        img_path = (base + "/" + decoded) if base else decoded
    parts = []
    for seg in img_path.replace("\\", "/").split("/"):
        if seg == "..":
            if parts:
                parts.pop()
        elif seg and seg != ".":
            parts.append(seg)
    img_path = "/".join(parts)
    try:
        archive.get_entry_by_path(img_path)
        return img_path
    except KeyError:
        pass
    if img_path.startswith("A/"):
        try:
            bare = img_path[2:]
            archive.get_entry_by_path(bare)
            return bare
        except KeyError:
            pass
    return None


def _extract_preview_title(html_str, entry_title):
    """Extract a clean title from HTML when entry.title looks like a URL slug.

    Tries og:title, <title>, heading tags. Falls back to title-casing the slug.
    Returns the cleaned title string, or None if entry_title is already good.
    """
    if "-" not in entry_title or " " in entry_title:
        return None
    # Looks like a URL slug — try to extract a better title
    for pattern in [
        r'<meta\s+property=["\']og:title["\']\s+content=["\']([^"\']+)["\']',
        r'<meta\s+content=["\']([^"\']+)["\']\s+property=["\']og:title["\']',
        r"<title[^>]*>([^<]+)</title>",
        r'<p\s+class=["\']title\s+lang-default["\'][^>]*>(.*?)</p>',
        r'<p\s+class=["\']title["\'][^>]*>(.*?)</p>',
        r"<h1[^>]*>(.*?)</h1>",
    ]:
        tm = re.search(pattern, html_str, re.IGNORECASE | re.DOTALL)
        if tm:
            clean_title = strip_html(html.unescape(tm.group(1).strip()))
            # Strip site suffixes like " | TED Talk", "— The World Factbook"
            clean_title = re.sub(
                r"\s*[\|–—]\s*(TED\s*Talk|TED|Wikipedia|The World Factbook).*$",
                "",
                clean_title,
            )
            # Strip Factbook region prefixes like "Africa :: " or "Europe :: "
            clean_title = re.sub(
                r"^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*::\s*", "", clean_title
            )
            if len(clean_title) > 3 and clean_title != entry_title:
                return clean_title[:200]
    # No HTML title found — title-case the slug as last resort
    return entry_title.replace("-", " ").replace("_", " ").title()[:200]


def _is_real_quote(text):
    """Filter out non-quote text: credits, citations, references, metadata."""
    if re.match(
        r"^(Directed|Written|Produced|Edited|Narrated|Adapted|Translated|Music)\s+by\b",
        text,
        re.IGNORECASE,
    ):
        return False
    if re.match(
        r"^(In response to|Based on|See also|Main article)\b", text, re.IGNORECASE
    ):
        return False
    if re.search(
        r"\bRetrieved\s+(on|from)\b|\bISBN\b|\bAssociated Press\b|^\d{4}\s+film\b",
        text,
        re.IGNORECASE,
    ):
        return False
    if re.match(r"^[\w\s,]+\(\s*\d{4}\s*\)", text):  # "Author Name (Year)" citation
        return False
    # A note, not a quote: "(Original engl.: ...)", "[1]", or a source line
    # set off by a dash ("- Fonte: ...", "——2012年7月31日，...").
    if text[:1] in "([" or text[:1] in _QUOTE_DASHES:
        return False
    # A film's or a book's credits: "Regie: X Drehbuch: Y Genre: Drama".
    if len(_CREDIT_LABEL_RE.findall(text)) >= 2:
        return False
    if _CJK_RE.search(text) and " " not in text.strip():
        return len(text) >= 10  # Chinese and Japanese write no spaces
    return len(text.split()) > 6


_QUOTE_DASHES = "-–—―~"
_CREDIT_LABEL_RE = re.compile(r"(?:^|\s)[^\s:：]{2,20}\s?[:：]\s")
_CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]")
# The quotation marks a Wikiquote may wrap a quote in, opening -> closing:
# English and Hebrew straight quotes, German „…“, French and Arabic «…»,
# Chinese and Japanese 「…」.
_QUOTE_MARKS = {
    '"': '"',
    "\u201c": "\u201d",
    "\u201e": "\u201c",
    "\u00ab": "\u00bb",
    "\u300c": "\u300d",
    "\u300e": "\u300f",
    "\u2039": "\u203a",
    "\u201d": "\u201d",
}
# A quote followed by who said it: "... ~ Author", "...。—— 白居易 《忆江南》",
# '"..." – Brief über den Humanismus'.
_QUOTE_SOURCE_SPLIT_RE = re.compile(r"\s+~\s+|\s*(?:——|―)\s*|\s+(?:--|[–—-])\s+")


_QUOTE_LABEL_RE = re.compile(r"^[^\s:：\"“„«「]{1,12}\s?[:：]\s*(?=[\"“„«「])")
# An indented line that is a notice, not a quote: a disambiguation or
# maintenance banner set in a <div>, or a line wholly in italics.
_QUOTE_NOTICE_RE = re.compile(r"^\s*(?:<div\b|<i>(?:(?!</i>).)*</i>\s*$)", re.DOTALL)


def _unwrap_quote(text):
    """(the quote without the marks around it, what follows it) when the
    text opens with a quotation mark and closes it, else (text, "")."""
    close = _QUOTE_MARKS.get(text[:1])
    if not close:
        return text, ""
    # The closing mark is the first one that ends the quote: what follows it
    # is nothing, or a source set off by a dash. A later mark belongs to the
    # source ('"Der Mensch ..." – Brief über den "Humanismus"').
    ends = [i for i, c in enumerate(text) if c == close and i > 0]
    for end in ends:
        rest = text[end + 1 :].strip()
        if not rest or rest[:1] in _QUOTE_DASHES + "(（":
            return text[1:end].strip(), rest
    if not ends:
        return text, ""
    return text[1 : ends[-1]].strip(), text[ends[-1] + 1 :].strip()


def _starts_like_name(text):
    """Whether text opens the way a name does: a capital, or a letter of a
    script with no capitals (Hebrew, Arabic, Devanagari, Chinese)."""
    c = text[:1]
    return c.isalpha() and (c.isupper() or c.lower() == c.upper())


def _name_from_source(source):
    """Who a source line names first: "Fonte: Vincent Connare. cf. ..." is
    Vincent Connare, "白居易 《忆江南》" is 白居易. None when the line opens
    with something that is not a name (a title, a date)."""
    s = source.strip().lstrip(_QUOTE_DASHES).strip()
    s = re.sub(r"^[^\s:：]{1,12}\s?[:：]\s*", "", s)  # a label: "Fonte:", "出处："
    name = re.split(r"[,(，（《«\"“.;；]", s)[0].strip()
    return name if _plausible_name(name) and not re.search(r"\d", name) else None


def _plausible_name(name):
    """Whether a string could be a person's name: short, a few words, and
    opening like a name. A run of Chinese longer than a name is a sentence
    ("毛泽东在中共七届二中全会上的讲话")."""
    return (
        2 < len(name) <= (12 if _CJK_RE.search(name) else 60)
        and len(name.split()) <= 6
        and _starts_like_name(name)
    )


def _title_names_a_person(title):
    """Whether a Wikiquote page title reads as a person's name: two to four
    words, capitalized where the script has capitals ("Albert Einstein", not
    "artificial intelligence"), or a transliterated name ("弗里德里希·谢林")."""
    if "·" in title and not re.search(r"\d", title):
        return True
    words = title.split()
    if not 2 <= len(words) <= 4 or re.search(r"[\d()（）]", title):
        return False
    first = words[0]
    if first[:1].lower() == first[:1].upper():  # no capitals in this script
        return first[:1].isalpha() and len(words) <= 3
    # "Albert Einstein", "Frank-Walter Steinmeier", "Лев Толстой".
    given = first.split("-")
    return (
        all(g[:1].isupper() and g[1:].islower() for g in given)
        and words[-1][:1].isupper()
    )


def _extract_wikiquote_attribution(block, inner_ul_pos, page_title):
    """Extract author attribution from a wikiquote nested <ul> block.

    Returns author name string or None.
    """
    author = None
    # Use page title as fallback only if it looks like a person name
    if _title_names_a_person(page_title):
        author = page_title
    inner_block = block[inner_ul_pos:]
    attr_raw = strip_html(inner_block).strip()
    # Normalize double spaces around punctuation (strip_html replaces tags with spaces)
    attr_raw = re.sub(r"\s+([,;:.!?])", r"\1", attr_raw)
    attr_raw = (
        re.sub(r"^[\u2014\u2013\-~]+\s*", "", attr_raw).strip().split("\n")[0].strip()
    )
    if attr_raw and 3 < len(attr_raw) < 200:
        if not re.search(r"[\[\]{}]|https?:|www\.|^\d", attr_raw, re.IGNORECASE):
            # Detect source citations (not person names):
            # - Contains ":" mid-text (e.g. "StoptheWarNow: Third peace convoy")
            # - Looks like a title/headline (many capitalized words, >5 words)
            # - Contains news agency / publication markers
            _is_source = bool(
                re.search(r"\w:\s+\w", attr_raw)  # colon in middle
                or re.search(
                    r"(?i)\b(Agency|News|Times|Post|Tribune|Journal|Gazette|Herald|Magazine|Review|Report|Press|Daily)\b",
                    attr_raw,
                )
                or (
                    len(attr_raw.split()) > 6
                    and not re.match(
                        r"^[A-Z][a-z]+(?:\s+[a-z]+)*\s+[A-Z][a-z]+$",
                        attr_raw.split("(")[0].split(",")[0].strip(),
                    )
                )
            )
            if not _is_source:
                # Extract name: everything before first comma or opening paren
                # e.g. "Henry Adams, Mont Saint Michel and Chartres (1904)" → "Henry Adams"
                name_part = re.split(r"[,(]", attr_raw)[0].strip()
                # Handle honorifics with commas: "Adams, Henry" or "King, Jr., Martin Luther"
                # If name_part is a single word and next part also looks like a name, rejoin
                if name_part and "," in attr_raw:
                    parts = [p.strip() for p in attr_raw.split(",")]
                    # "Last, First" pattern: single capitalized word, then capitalized word(s)
                    if (
                        len(parts) >= 2
                        and re.match(r"^[A-Z][a-z]+$", parts[0])
                        and re.match(r"^(Jr\.|Sr\.|[A-Z])", parts[1])
                    ):
                        # Check for Jr./Sr. suffix
                        if (
                            parts[1] in ("Jr.", "Sr.", "III", "II", "IV")
                            and len(parts) >= 3
                        ):
                            name_part = (
                                parts[2].strip() + " " + parts[0] + ", " + parts[1]
                            )
                        elif re.match(r"^[A-Z][a-z]", parts[1]):
                            # "Last, First ..." — but only if second part is short (a name, not a book title)
                            if len(parts[1].split()) <= 3:
                                name_part = parts[1] + " " + parts[0]
                # Validate: must start like a name, reasonable length
                if _plausible_name(name_part) and not re.match(
                    r"^(p\.|ch\.|vol\.|see |ibid)", name_part, re.IGNORECASE
                ):
                    author = name_part
    return author


def _wikiquote_candidates(html_str):
    """Where a Wikiquote keeps its quotes, in the page's order, as
    (position, strong, quote html, attribution html, source html).

    Every edition lays them out its own way: English and Spanish put the
    quote in a list item and who said it in a list nested under it; German,
    Hebrew and Chinese put the quote alone in a list item, with the source
    after a dash; Portuguese puts the source in an indented line after the
    list; French wraps the quote in <div class="citation">; Arabic and Hindi
    set it in a paragraph between quotation marks. "Strong" candidates are
    shaped like a quote (quoted, attributed or classed as one); a bare list
    item or indented line is taken only when the page has nothing stronger."""
    out = []
    for m in re.finditer(r"<li\b[^>]*>", html_str, re.IGNORECASE):
        rest = html_str[m.end() : m.end() + _QUOTE_SCAN]
        stop = re.search(r"</li>|<(?:ul|ol|dl)\b", rest, re.IGNORECASE)
        own = rest[: stop.start()] if stop else rest
        nested = ""
        if stop and not stop.group(0).startswith("</"):
            nested = rest[stop.start() :]
            close = re.search(r"</(?:ul|ol|dl)>", nested, re.IGNORECASE)
            nested = nested[: close.end()] if close else nested
        source = ""
        after = re.match(
            r"\s*</li>\s*</ul>\s*<dl\b[^>]*>\s*<dd\b[^>]*>(.*?)</dd>",
            rest[stop.start() :] if stop else "",
            re.DOTALL | re.IGNORECASE,
        )
        if after and strip_html(after.group(1))[:1] in _QUOTE_DASHES:
            source = after.group(1)
        out.append((m.start(), bool(nested or source), own, nested, source))
    for m in re.finditer(
        r"<div\b[^>]*class=[\"'][^\"']*\bcitation\b[^\"']*[\"'][^>]*>(.*?)</div>",
        html_str,
        re.DOTALL | re.IGNORECASE,
    ):
        out.append((m.start(), True, m.group(1), "", ""))
    for m in re.finditer(r"<p\b[^>]*>(.*?)</p>", html_str, re.DOTALL | re.IGNORECASE):
        text = strip_html_inline(m.group(1))
        for opening, closing in _QUOTE_MARKS.items():
            q = re.search(
                re.escape(opening)
                + r"([^"
                + re.escape(closing)
                + r"]{20,400})"
                + re.escape(closing),
                text,
            )
            # Most of the paragraph: a pair of marks inside an introduction
            # is an abbreviation (Hebrew writes חב"ד with one) or a title.
            if q and len(q.group(0)) * 2 >= len(text):
                out.append((m.start(), True, opening + q.group(1) + closing, "", ""))
                break
    for m in re.finditer(r"<dd>(.*?)</dd>", html_str, re.DOTALL):
        if not _QUOTE_NOTICE_RE.match(m.group(1)):
            out.append((m.start(), False, m.group(1), "", ""))
    out.sort(key=lambda c: c[0])
    return [c for c in out if c[1]] + [c for c in out if not c[1]]


_QUOTE_SCAN = 5000  # how far into a list item to look for its end
_QUOTE_MAX = 250


def _extract_preview_wikiquote(html_str, result, entry_title, lang=""):
    """A quote and who said it, from a Wikiquote article in any language.

    Populates result["blurb"] (the quote between “ ”) and
    result["attribution"] in place. A quote in a script other than the
    wiki's own (the original of a translated quote on the Chinese Wikiquote)
    is passed over for one its readers can read."""
    page_title = result.get("title") or entry_title
    for _pos, _strong, own, nested, source in _wikiquote_candidates(html_str):
        # A label before a quote in marks: "תרגום: "..."" (a translation).
        text = _QUOTE_LABEL_RE.sub("", strip_html_inline(own), count=1)
        quote, tail = _unwrap_quote(text)
        tilde = None
        if quote == text:
            # "Quote. ~ Author" names its author whatever follows; a dash
            # sets off a source only on a line with nothing nested under it.
            parts = _QUOTE_SOURCE_SPLIT_RE.split(text, maxsplit=1)
            if len(parts) == 2 and len(parts[0]) >= len(parts[1]):
                if re.search(r"\s~\s", text):
                    quote, tilde = parts[0].strip(), parts[1].strip()
                elif not nested:
                    quote, tail = parts[0].strip(), parts[1].strip()
        if not 20 < len(quote) < 400 or not _is_real_quote(quote):
            continue
        if not _wikilang.in_own_script(quote, lang):
            continue
        if quote.startswith(("Category:", "See also", "External links", "Retrieved")):
            continue
        # The page's own introduction of its subject: "Name (born \u2013 died) ...".
        if page_title and quote.startswith(page_title):
            if quote[len(page_title) :].lstrip()[:1] in "(\uff08":
                continue
        result["blurb"] = "\u201c" + quote[:_QUOTE_MAX] + "\u201d"
        author = _wikiquote_author(page_title, tilde, tail, source, nested)
        if author:
            result["attribution"] = author[:100]
        return


def _wikiquote_author(page_title, tilde, tail, source, nested):
    """Who said a quote, from the likeliest place first. A name after a
    tilde is the author. A line under the quote names who said it (English,
    Spanish, Portuguese). What follows a dash on the quote's own line is
    mostly the work it is from ("\u2013 Brief \u00fcber den Humanismus"), so a page
    named for a person names the author before that line does; on a page
    about a thing, the line is all there is ("\u2014\u2014 \u767d\u5c45\u6613 \u300a\u5fc6\u6c5f\u5357\u300b").
    """
    if tilde:
        name = _name_from_source(tilde)
        if name:
            return name
    if source:
        name = _name_from_source(strip_html_inline(source))
        if name:
            return name
    if nested:
        return _extract_wikiquote_attribution(nested, 0, page_title)
    if _title_names_a_person(page_title):
        return page_title
    return _name_from_source(tail) if tail else None


def _extract_preview_ted(html_str, archive, zim_name, path, result):
    """Extract TED talk speaker name and photo.

    <p id="speaker"> has the last name; speaker_desc has the full name in prose.
    Strategy: get last name, then find "FirstName LastName" in speaker_desc.
    Populates result["speaker"] and result["thumbnail"] in place.
    """
    speaker = None
    last_name = None
    sp_m = re.search(
        r'<p\s+id=["\']speaker["\'][^>]*>(.*?)</p>', html_str, re.DOTALL | re.IGNORECASE
    )
    if sp_m:
        last_name = re.sub(r"\s+", " ", strip_html(sp_m.group(1))).strip()
        if " " in last_name:
            # Already a full name (some playlist ZIMs have full names)
            speaker = last_name
    # Find full name in speaker_desc by locating the last name in context
    if not speaker and last_name:
        sp_desc = re.search(
            r'<p\s+id=["\']speaker_desc["\'][^>]*>(.*?)</p>',
            html_str,
            re.DOTALL | re.IGNORECASE,
        )
        if sp_desc:
            desc_text = re.sub(r"\s+", " ", strip_html(sp_desc.group(1))).strip()
            # Find last name in the desc and grab preceding word(s) as first name
            # e.g. "Biologist E.O. Wilson explored..." → find "Wilson", grab "E.O. Wilson"
            esc_last = re.escape(last_name)
            name_m = re.search(
                r"((?:(?:[A-Z][\w.\'\u2019-]*|el|de|van|von|al)\s+){0,3})"
                + esc_last
                + r"\b",
                desc_text,
            )
            if name_m:
                prefix = name_m.group(1).strip()
                if prefix:
                    speaker = (prefix + " " + last_name).strip()
                else:
                    speaker = last_name
    if not speaker:
        speaker = last_name  # fallback to last name if desc search failed
    if speaker and len(speaker) > 1:
        result["speaker"] = speaker[:100]
    sp_img = re.search(
        r'<img\s+id=["\']speaker_img["\'][^>]*src=["\']([^"\']+)["\']',
        html_str,
        re.IGNORECASE,
    )
    if not sp_img:
        sp_img = re.search(
            r'<img[^>]*id=["\']speaker_img["\'][^>]*src=["\']([^"\']+)["\']',
            html_str,
            re.IGNORECASE,
        )
    if sp_img:
        src = sp_img.group(1)
        if (
            not src.startswith("http")
            and not src.startswith("//")
            and not src.startswith("data:")
        ):
            resolved = _resolve_img_path(archive, path, src)
            if resolved:
                result["thumbnail"] = f"/w/{zim_name}/{resolved}"


def _extract_preview_factbook(html_str, archive, zim_name, path, result):
    """Extract World Factbook country flag or locator map image.

    Tries flag images first (alt/src containing "flag"), then locator maps.
    Populates result["thumbnail"] in place.
    """
    # Look for flag images: <img> with alt/src containing "flag"
    for flag_m in re.finditer(r"<img\b([^>]*)>", html_str[:60000], re.IGNORECASE):
        attrs = flag_m.group(1)
        alt_m = re.search(r'alt=["\']([^"\']*)["\']', attrs, re.IGNORECASE)
        src_m = re.search(r'src=["\']([^"\']+)["\']', attrs, re.IGNORECASE)
        if not src_m:
            continue
        src = src_m.group(1)
        is_flag = False
        if alt_m and "flag" in alt_m.group(1).lower():
            is_flag = True
        if "flag" in src.lower():
            is_flag = True
        if (
            is_flag
            and not src.startswith("http")
            and not src.startswith("//")
            and not src.startswith("data:")
        ):
            resolved = _resolve_img_path(archive, path, src)
            if resolved:
                result["thumbnail"] = f"/w/{zim_name}/{resolved}"
                return

    # Try locator map if no flag found
    for loc_m in re.finditer(r"<img\b([^>]*)>", html_str[:60000], re.IGNORECASE):
        attrs = loc_m.group(1)
        src_m = re.search(r'src=["\']([^"\']+)["\']', attrs, re.IGNORECASE)
        if not src_m:
            continue
        src = src_m.group(1)
        if "locator-map" in src.lower() and not src.startswith(("http", "//", "data:")):
            resolved = _resolve_img_path(archive, path, src)
            if resolved:
                result["thumbnail"] = f"/w/{zim_name}/{resolved}"
                return


def _extract_preview_xkcd(html_str, result):
    """Extract xkcd comic alt-text (title attr) as blurb.

    Populates result["blurb"] in place.
    """
    for img_m in re.finditer(r"<img\b([^>]*)>", html_str, re.IGNORECASE):
        attrs = img_m.group(1)
        title_m = re.search(r'title=["\']([^"\']+)["\']', attrs)
        if title_m and len(title_m.group(1).strip()) > 20:
            text = html.unescape(title_m.group(1).strip())
            if "license" not in text.lower() and "creative commons" not in text.lower():
                result["blurb"] = text[:200]
                break


def _extract_preview_gutenberg(html_str, archive, zim_name, path, entry, result):
    """Extract Gutenberg author and cover image.

    Gutenberg cover pages have a ~90KB localization JSON in <head>, pushing actual
    content to byte 95K+. Use the full html_str (80K) but also try the tail end.
    Populates result["author"] and result["thumbnail"] in place.
    """
    # For cover pages, re-read with larger limit to get past the l10n blob
    gut_html = html_str
    if "_cover" in path and len(html_str) >= 79000:
        try:
            content = bytes(entry.get_item().content)
            gut_html = content.decode("utf-8", errors="replace")[:120000]
        except Exception as e:
            log.debug("Failed to re-read Gutenberg cover content for %s: %s", path, e)
            pass
    # Author: try data-author-name attribute first (modern ZIMs), then dc.creator meta
    author = None
    author_btn = re.search(r'data-author-name="([^"]+)"', gut_html, re.IGNORECASE)
    if author_btn:
        author = author_btn.group(1).strip()
    if not author:
        creator_m = re.search(
            r'<meta\s+content="([^"]+)"\s+name="dc\.creator"',
            gut_html[:8000],
            re.IGNORECASE,
        )
        if not creator_m:
            creator_m = re.search(
                r'<meta\s+name="dc\.creator"\s+content="([^"]+)"',
                gut_html[:8000],
                re.IGNORECASE,
            )
        if creator_m:
            author = creator_m.group(1).strip()
    if author:
        # Convert "Last, First, dates" → "First Last"
        if "," in author:
            parts = author.split(",")
            last = parts[0].strip()
            first = parts[1].strip() if len(parts) > 1 else ""
            if first and not re.match(r"^\d", first):
                author = first + " " + last
            else:
                author = last
        if author.lower() != "various":
            result["author"] = author[:100]
    # Cover image: look for .cover-art img (Gutenberg cover pages)
    if not result["thumbnail"]:
        cover_m = re.search(
            r'<img[^>]*class="[^"]*cover-art[^"]*"[^>]*src=["\']([^"\']+)["\']',
            gut_html,
            re.IGNORECASE,
        )
        if not cover_m:
            cover_m = re.search(
                r'<img[^>]*src=["\']([^"\']*cover_image[^"\']*)["\']',
                gut_html,
                re.IGNORECASE,
            )
        if cover_m:
            src = cover_m.group(1)
            if not src.startswith(("http", "//", "data:")):
                resolved = _resolve_img_path(archive, path, src)
                if resolved:
                    result["thumbnail"] = f"/w/{zim_name}/{resolved}"


_HEADING_RE = re.compile(r"<h([1-6])\b[^>]*>(.*?)</h\1>", re.DOTALL | re.IGNORECASE)
# What a definition carries after its sense and is not the sense: nested
# examples and quotations, and Russian's "◆" example lines.
_WIKT_DEF_TAIL_RE = re.compile(r"<(?:ul|ol|dl|table)\b|◆", re.IGNORECASE)
_WIKT_DEF_MAX = 200
# Where a sense can be: the first filled item of a numbered list, an indented
# line (German and Spanish number their senses in a definition list), or a
# paragraph (Hindi).
_WIKT_SENSE_OPENERS = (
    r"<ol\b[^>]*>\s*(?:<li\b[^>]*>\s*</li>\s*)*<li\b[^>]*>",
    r"<dd\b[^>]*>",
    r"<p\b[^>]*>",
)
# A sense numbered in the text rather than by a list: "[1]" on German
# Wiktionary, "१." in Hindi Wiktionary's dictionary transcriptions.
_WIKT_SENSE_NUMBER_RE = re.compile(r"^\s*(?:\[\s*1\s*\]|[1१]\s*[.)])\s*")
# A paragraph that opens on a bold label names what follows it and then the
# next thing: "<b>परिभाषा</b>: ... <b>उदाहरण</b>: ..." (definition, example).
_WIKT_LABEL_RE = re.compile(r"^\s*<b\b[^>]*>[^<]{1,20}</b>\s*[:：]", re.IGNORECASE)
_WIKT_SMALL_LABEL_RE = re.compile(
    r"^\s*(?:<span\b[^>]*>\s*)?<small\b.*?</small>\s*(?:</span>)?",
    re.DOTALL | re.IGNORECASE,
)
_ARABIC_MARKS_RE = re.compile(r"[ً-ٰٟ]")


def _wiktionary_headings(html_str):
    """[(start, end, level, text)] for every heading of a page."""
    return [
        (m.start(), m.end(), int(m.group(1)), strip_html_inline(m.group(2)))
        for m in _HEADING_RE.finditer(html_str)
    ]


def _is_language_heading(text, names):
    """Whether a heading names one of ``names``: "Français", "Haus (Deutsch)"."""
    t = re.sub(r"\s+", "", text)
    return any(t == n or t.endswith("(" + n + ")") for n in names)


def _wiktionary_section(html_str, facts):
    """The part of an entry written in the wiki's own language, as
    (html, headings within it), or None when the page has no such part (an
    English word on German Wiktionary). A wiki that writes one language only
    has no language headings, and its whole page is the part."""
    heads = _wiktionary_headings(html_str)
    if not facts or facts.get("monolingual"):
        return html_str, heads
    for i, (start, _end, level, text) in enumerate(heads):
        if _is_language_heading(text, facts["names"]):
            stop = next((h[0] for h in heads[i + 1 :] if h[2] <= level), len(html_str))
            inner = [
                (s - start, e - start, lv, t)
                for s, e, lv, t in heads[i + 1 :]
                if s < stop
            ]
            return html_str[start:stop], inner
    return None


def _first_definition(html_str):
    """The first sense a stretch of an entry defines, without its examples,
    trimmed to fit a card; "" when it defines none."""
    for opener in _WIKT_SENSE_OPENERS:
        bodies = []
        for m in re.finditer(opener, html_str, re.IGNORECASE):
            closing = re.search(r"</(?:li|dd|p)>", html_str[m.end() :])
            if closing:
                bodies.append(html_str[m.end() : m.end() + closing.start()])
        # German indents its hyphenation and pronunciation the way it
        # indents its senses; the senses are the lines numbered "[1]".
        numbered = [b for b in bodies if _WIKT_SENSE_NUMBER_RE.match(strip_html(b))]
        for body in numbered or bodies:
            text = _definition_text(body)
            if text:
                return text
    return ""


def _definition_text(body):
    """One list item, indented line or paragraph of an entry as a sense."""
    # A register label set small before the sense ("לשון המקרא", Biblical
    # Hebrew) runs into it once the tags are gone.
    body = _WIKT_SMALL_LABEL_RE.sub("", body, count=1)
    label = _WIKT_LABEL_RE.match(body)
    if label:
        body = body[label.end() :]
        nxt = re.search(r"<b\b", body, re.IGNORECASE)
        body = body[: nxt.start()] if nxt else body
    tail = _WIKT_DEF_TAIL_RE.search(body)
    if tail:
        body = body[: tail.start()]
    # A paragraph that lists its senses line by line: the first numbered
    # line is the sense ("घर संज्ञा पुं॰ [सं॰ गृह]<br><br>१. मनुष्यों के ...").
    lines = [strip_html_inline(part) for part in re.split(r"<br\b[^>]*>", body)]
    lines = [ln for ln in lines if ln]
    numbered = [ln for ln in lines if _WIKT_SENSE_NUMBER_RE.match(ln)]
    text = _WIKT_SENSE_NUMBER_RE.sub("", (numbered or lines or [""])[0]).strip()
    return text[:_WIKT_DEF_MAX] if len(text) > 1 else ""


def _wiktionary_pos(section, heads, facts):
    """(part of speech, is an inflected form, where its senses start). The
    start is None for an edition that heads its senses ("釋義", "Значение")
    when the part read holds no such heading: what comes first there is
    pronunciation or etymology, and is no definition."""
    pos_words = tuple(w.lower() for w in facts.get("pos", ()))
    forms = tuple(w.lower() for w in facts.get("forms", ()))
    senses = tuple(w.lower() for w in facts.get("senses", ()))
    for _s, e, _level, text in heads:
        t = text.lower()
        if forms and t.startswith(forms):
            return None, True, e
        if pos_words and t.startswith(pos_words):
            return text[:40], False, e
    start = next(
        (e for _s, e, _lv, t in heads if senses and t.lower().startswith(senses)),
        None if senses else 0,
    )
    # Hebrew states the part of speech in a table row ("חלק דיבר | שם־עצם").
    label = facts.get("pos_label")
    if label:
        m = re.search(
            re.escape(label) + r"\s*(?:</[^>]+>\s*)+<td\b[^>]*>(.*?)</td>",
            section,
            re.DOTALL,
        )
        if m and strip_html_inline(m.group(1)):
            return strip_html_inline(m.group(1))[:40], False, start
    # Russian and Hindi's dictionary pages say it in a sentence
    # ("Существительное, неодушевлённое, ..."): the first such word.
    plain = strip_html_inline(section[:8000])
    hits = sorted((plain.find(w), w) for w in facts.get("pos", ()) if w in plain)
    return (hits[0][1] if hits else None), False, start


def _extract_preview_wiktionary(html_str, zim_name, result, lang="", title=""):
    """Part of speech and first definition of a Wiktionary entry, read in the
    wiki's own language (zimi/wikilang.py has what each edition calls things).

    Populates result["part_of_speech"], result["blurb"], and the two flags
    the random endpoint uses to pass a pick over: result["boring"] (an
    inflected form) and result["other_language"] (the page defines a word of
    another language: it has no section in the wiki's own, or, in a language
    with a script of its own, its headword is written in another script)."""
    facts = _wikilang.wiktionary_facts(lang, zim_name) or {}
    found = _wiktionary_section(html_str, facts)
    if found is None or (title and not _wikilang.in_own_script(title, lang)):
        result["other_language"] = True
        return
    section, heads = found
    pos, is_form, start = _wiktionary_pos(section, heads, facts)
    if pos:
        result["part_of_speech"] = pos
    definition = "" if start is None else _first_definition(section[start:])
    if title and definition.startswith(title + " "):
        # A dictionary transcription restates the headword and its grammar
        # before the sense: "सालुर संज्ञा पुं॰ [सं॰] मेढ़क ।" is "मेढ़क ।".
        definition = re.sub(r"^.*?\]\s*", "", definition, count=1)
    form_defs = facts.get("form_defs")
    if is_form or (
        definition
        and form_defs
        and re.match(form_defs, _ARABIC_MARKS_RE.sub("", definition), re.IGNORECASE)
    ):
        result["boring"] = True
    elif definition:
        result["blurb"] = definition


def _extract_preview_blurb(html_str):
    """Extract a generic text blurb from og:description, meta description, or first <p>.

    Returns the blurb string or None.
    """
    for pattern in [
        r'<meta\s+property=["\']og:description["\']\s+content=["\']([^"\']+)["\']',
        r'<meta\s+content=["\']([^"\']+)["\']\s+property=["\']og:description["\']',
        r'<meta\s+name=["\']description["\']\s+content=["\']([^"\']+)["\']',
        r'<meta\s+content=["\']([^"\']+)["\']\s+name=["\']description["\']',
    ]:
        m = re.search(pattern, html_str, re.IGNORECASE)
        if m and len(m.group(1).strip()) > 20:
            return html.unescape(m.group(1).strip())[:200]
    # First substantial <p> text (skip tiny nav/footer paragraphs and boilerplate)
    _skip_blurb = re.compile(
        r"(Creative Commons|This work is licensed|free to copy and share|All rights reserved|Copyright \d|DMCA)",
        re.IGNORECASE,
    )
    for pm in re.finditer(r"<p\b[^>]*>(.*?)</p>", html_str, re.DOTALL | re.IGNORECASE):
        text = strip_html(pm.group(1))
        # Chinese and Japanese say in 12 characters what takes 40 in English:
        # "鄞州区是浙江省宁波市的一个市辖区。" is a whole lead sentence.
        if len(text) > (12 if _CJK_RE.search(text) else 40) and not _skip_blurb.search(
            text
        ):
            return text[:200]
    return None


def _extract_preview_thumbnail(html_str, archive, zim_name, path):
    """Extract a thumbnail from og:image, twitter:image, or best content image.

    Uses scoring heuristics for content images:
    - Penalize banners (aspect ratio > 4:1)
    - Prefer images with meaningful alt text (content images)
    - Images without explicit dimensions are likely content (generous default)
    - Skip images in header/nav/footer chrome

    Returns the thumbnail URL string or None.
    """
    for pattern in [
        r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']',
        r'<meta\s+content=["\']([^"\']+)["\']\s+property=["\']og:image["\']',
        r'<meta\s+name=["\']twitter:image["\']\s+content=["\']([^"\']+)["\']',
        r'<meta\s+content=["\']([^"\']+)["\']\s+name=["\']twitter:image["\']',
    ]:
        m = re.search(pattern, html_str, re.IGNORECASE)
        if m:
            src = m.group(1)
            if (
                src.startswith("http://")
                or src.startswith("https://")
                or src.startswith("//")
            ):
                continue  # external URL, can't serve from ZIM
            if not src.lower().endswith(".svg"):
                resolved = _resolve_img_path(archive, path, src)
                if resolved:
                    return f"/w/{zim_name}/{resolved}"

    # Fall back to best content image using scoring heuristics
    best_img = None
    best_score = 0
    for m in re.finditer(r"<img\b([^>]*)>", html_str, re.IGNORECASE):
        attrs = m.group(1)
        src_m = re.search(r'src=["\']([^"\']+)["\']', attrs)
        if not src_m:
            continue
        src = src_m.group(1)
        if src.startswith("data:") or src.startswith("http") or src.startswith("//"):
            continue
        if src.lower().endswith(".svg") or src.lower().endswith(".svg.png"):
            continue
        # Skip generic site chrome images (navigation icons, banners)
        src_base = src.rsplit("/", 1)[-1].lower()
        if src_base in (
            "home_on.png",
            "home_off.png",
            "banner_ext2.png",
            "photo_on.gif",
            "one-page-summary.png",
            "travel-facts.png",
        ):
            continue
        w_m = re.search(r'width=["\']?(\d+)', attrs)
        h_m = re.search(r'height=["\']?(\d+)', attrs)
        has_dims = bool(w_m or h_m)
        w = int(w_m.group(1)) if w_m else 400  # no attrs → assume large content
        h = int(h_m.group(1)) if h_m else 300
        if w < 50 or h < 50:
            continue
        # Skip images inside header/nav/footer
        ctx_start = max(0, m.start() - 300)
        ctx = html_str[ctx_start : m.start()].lower()
        if re.search(r"<(header|nav|footer)\b", ctx) and not re.search(
            r"</(header|nav|footer)>", ctx
        ):
            continue
        # Score: area + bonuses for content signals
        area = w * h
        ratio = max(w, h) / max(min(w, h), 1)
        score = area
        if ratio > 4:
            score *= 0.2  # heavy penalty for banners
        alt_m = re.search(r'alt=["\']([^"\']+)["\']', attrs)
        if alt_m and len(alt_m.group(1)) > 3:
            alt_lower = alt_m.group(1).lower()
            if alt_lower not in ("logo", "icon", "banner", "spacer"):
                score *= 1.5  # bonus for meaningful alt text
        if not has_dims:
            score *= 1.3  # content images often omit dimensions
        if score > best_score:
            resolved = _resolve_img_path(archive, path, src)
            if resolved:
                best_img = f"/w/{zim_name}/{resolved}"
                best_score = score

    return best_img


def _extract_preview(archive, zim_name, path):
    """Extract the best thumbnail image and a text blurb from an article.

    Uses Open Graph / Twitter meta tags first, falls back to largest content
    image and first substantial <p> text. This is the same approach used by
    iMessage, Slack, and Discord for link previews.

    Returns {"thumbnail": str|None, "blurb": str|None}.
    Must be called with _zim_lock held.
    """
    result = {"thumbnail": None, "blurb": None, "title": None}
    try:
        entry = archive.get_entry_by_path(path)
        if entry.is_redirect:
            entry = entry.get_redirect_entry()
        content = bytes(entry.get_item().content)
        html_str = content.decode("utf-8", errors="replace")[:80000]
    except Exception as e:
        log.debug(
            "Failed to read entry for preview extract %s/%s: %s", zim_name, path, e
        )
        return result

    # -- Title: extract from <title> or og:title if entry.title is a slug --
    entry_title = entry.title or ""
    title = _extract_preview_title(html_str, entry_title)
    if title:
        result["title"] = title

    # -- Content-type-specific extraction --
    zim_lower = zim_name.lower()

    if "wikiquote" in zim_lower:
        _extract_preview_wikiquote(
            html_str, result, entry_title, _wikilang.archive_language(archive)
        )

    if "ted" in zim_lower:
        _extract_preview_ted(html_str, archive, zim_name, path, result)

    if "theworldfactbook" in zim_lower and not result["thumbnail"]:
        _extract_preview_factbook(html_str, archive, zim_name, path, result)

    if "xkcd" in zim_lower and not result["blurb"]:
        _extract_preview_xkcd(html_str, result)

    if "gutenberg" in zim_lower:
        _extract_preview_gutenberg(html_str, archive, zim_name, path, entry, result)

    if "wiktionary" in zim_lower:
        _extract_preview_wiktionary(
            html_str,
            zim_name,
            result,
            _wikilang.archive_language(archive),
            entry_title,
        )

    # -- Generic blurb fallback --
    if not result["blurb"]:
        result["blurb"] = _extract_preview_blurb(html_str)

    # -- Generic thumbnail fallback --
    if not result["thumbnail"]:
        result["thumbnail"] = _extract_preview_thumbnail(
            html_str, archive, zim_name, path
        )

    return result
