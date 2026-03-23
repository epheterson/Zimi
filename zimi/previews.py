"""Content preview extraction — thumbnails, blurbs, and metadata from ZIM articles."""

import html
import logging
import re
from urllib.parse import unquote

log = logging.getLogger("zimi")


def strip_html(text):
    """Remove HTML tags and decode entities, return plain text."""
    text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.DOTALL)
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


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
            if parts: parts.pop()
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
        r'<title[^>]*>([^<]+)</title>',
        r'<p\s+class=["\']title\s+lang-default["\'][^>]*>(.*?)</p>',
        r'<p\s+class=["\']title["\'][^>]*>(.*?)</p>',
        r'<h1[^>]*>(.*?)</h1>',
    ]:
        tm = re.search(pattern, html_str, re.IGNORECASE | re.DOTALL)
        if tm:
            clean_title = strip_html(html.unescape(tm.group(1).strip()))
            # Strip site suffixes like " | TED Talk", "— The World Factbook"
            clean_title = re.sub(r'\s*[\|–—]\s*(TED\s*Talk|TED|Wikipedia|The World Factbook).*$', '', clean_title)
            # Strip Factbook region prefixes like "Africa :: " or "Europe :: "
            clean_title = re.sub(r'^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*::\s*', '', clean_title)
            if len(clean_title) > 3 and clean_title != entry_title:
                return clean_title[:200]
    # No HTML title found — title-case the slug as last resort
    return entry_title.replace("-", " ").replace("_", " ").title()[:200]


def _is_real_quote(text):
    """Filter out non-quote text: credits, citations, references, metadata."""
    if re.match(r'^(Directed|Written|Produced|Edited|Narrated|Adapted|Translated|Music)\s+by\b', text, re.IGNORECASE):
        return False
    if re.match(r'^(In response to|Based on|See also|Main article)\b', text, re.IGNORECASE):
        return False
    if re.search(r'\bRetrieved\s+(on|from)\b|\bISBN\b|\bAssociated Press\b|^\d{4}\s+film\b', text, re.IGNORECASE):
        return False
    if re.match(r'^[\w\s,]+\(\s*\d{4}\s*\)', text):  # "Author Name (Year)" citation
        return False
    return len(text.split()) > 6


def _extract_wikiquote_attribution(block, inner_ul_pos, page_title):
    """Extract author attribution from a wikiquote nested <ul> block.

    Returns author name string or None.
    """
    author = None
    # Use page title as fallback only if it looks like a person name (has a space)
    if ' ' in page_title and re.match(r'^[A-Z][a-z]+ [A-Z]', page_title):
        author = page_title
    inner_block = block[inner_ul_pos:]
    attr_raw = strip_html(inner_block).strip()
    # Normalize double spaces around punctuation (strip_html replaces tags with spaces)
    attr_raw = re.sub(r'\s+([,;:.!?])', r'\1', attr_raw)
    attr_raw = re.sub(r'^[\u2014\u2013\-~]+\s*', '', attr_raw).strip().split('\n')[0].strip()
    if attr_raw and 3 < len(attr_raw) < 200:
        if not re.search(r'[\[\]{}]|https?:|www\.|^\d', attr_raw, re.IGNORECASE):
            # Detect source citations (not person names):
            # - Contains ":" mid-text (e.g. "StoptheWarNow: Third peace convoy")
            # - Looks like a title/headline (many capitalized words, >5 words)
            # - Contains news agency / publication markers
            _is_source = bool(
                re.search(r'\w:\s+\w', attr_raw)  # colon in middle
                or re.search(r'(?i)\b(Agency|News|Times|Post|Tribune|Journal|Gazette|Herald|Magazine|Review|Report|Press|Daily)\b', attr_raw)
                or (len(attr_raw.split()) > 6 and not re.match(r'^[A-Z][a-z]+(?:\s+[a-z]+)*\s+[A-Z][a-z]+$', attr_raw.split('(')[0].split(',')[0].strip()))
            )
            if not _is_source:
                # Extract name: everything before first comma or opening paren
                # e.g. "Henry Adams, Mont Saint Michel and Chartres (1904)" → "Henry Adams"
                name_part = re.split(r'[,(]', attr_raw)[0].strip()
                # Handle honorifics with commas: "Adams, Henry" or "King, Jr., Martin Luther"
                # If name_part is a single word and next part also looks like a name, rejoin
                if name_part and ',' in attr_raw:
                    parts = [p.strip() for p in attr_raw.split(',')]
                    # "Last, First" pattern: single capitalized word, then capitalized word(s)
                    if (len(parts) >= 2 and re.match(r'^[A-Z][a-z]+$', parts[0])
                            and re.match(r'^(Jr\.|Sr\.|[A-Z])', parts[1])):
                        # Check for Jr./Sr. suffix
                        if parts[1] in ('Jr.', 'Sr.', 'III', 'II', 'IV') and len(parts) >= 3:
                            name_part = parts[2].strip() + ' ' + parts[0] + ', ' + parts[1]
                        elif re.match(r'^[A-Z][a-z]', parts[1]):
                            # "Last, First ..." — but only if second part is short (a name, not a book title)
                            if len(parts[1].split()) <= 3:
                                name_part = parts[1] + ' ' + parts[0]
                # Validate: must start with uppercase letter, reasonable length
                if (name_part and 2 < len(name_part) < 60
                        and re.match(r'^[A-Z]', name_part)
                        and not re.match(r'^(p\.|ch\.|vol\.|see |ibid)', name_part, re.IGNORECASE)):
                    author = name_part
    return author


def _extract_preview_wikiquote(html_str, result, entry_title):
    """Extract a quote and attribution from a Wikiquote article.

    Populates result["blurb"] and result["attribution"] in place.
    """
    # Wikiquote structure: <ul><li>Quote text<ul><li>Attribution</li></ul></li></ul>
    # Strategy: find <ul> blocks that contain nested <ul> (quote + attribution).
    # Use a simple stack-based approach to find balanced top-level <ul> blocks.
    for ul_m in re.finditer(r'<ul>', html_str):
        start = ul_m.start()
        # Find the matching </ul> by counting nesting depth
        depth = 1
        pos = ul_m.end()
        while depth > 0 and pos < len(html_str) and pos < start + 5000:
            next_open = html_str.find('<ul', pos)
            next_close = html_str.find('</ul>', pos)
            if next_close < 0:
                break
            if next_open >= 0 and next_open < next_close:
                depth += 1
                pos = next_open + 3
            else:
                depth -= 1
                pos = next_close + 5
        if depth != 0:
            continue
        block = html_str[start:pos]
        # Must have a nested <ul> (attribution) to be a quote block
        if block.count('<ul') < 2:
            continue
        # Extract text before the first nested <ul> as the quote
        inner_ul_pos = block.find('<ul', 4)  # skip the outer <ul>
        if inner_ul_pos < 0:
            continue
        quote_html = block[4:inner_ul_pos]  # between outer <ul> and first nested <ul>
        # Strip the wrapping <li> tag
        quote_html = re.sub(r'^\s*<li[^>]*>', '', quote_html)
        text = strip_html(quote_html).strip()
        # Check for inline tilde attribution: "Quote text. ~ Author Name"
        tilde_match = re.search(r'\s*~\s*(.+)$', text)
        tilde_author = None
        if tilde_match:
            text = text[:tilde_match.start()].rstrip()
            tilde_author = tilde_match.group(1).strip()
        if 20 < len(text) < 400 and _is_real_quote(text):
            if text.startswith(("Category:", "See also", "External links", "Retrieved")):
                continue
            result["blurb"] = "\u201c" + text[:250] + "\u201d"
            # Attribution: tilde author takes priority (inline convention),
            # then try nested <ul> for author name, fall back to page title.
            if tilde_author and 2 < len(tilde_author) < 60 and re.match(r'^[A-Z]', tilde_author):
                result["attribution"] = tilde_author[:100]
                break
            page_title = result.get("title") or entry_title
            author = _extract_wikiquote_attribution(block, inner_ul_pos, page_title)
            if author:
                result["attribution"] = author[:100]
            break
    # Fallback: if <ul><li> parsing found nothing, try <dd> blocks or <li> after "Quotes" heading
    if not result.get("blurb"):
        # Try <dd> blocks (definition list format used on some wikiquote pages)
        for dd_m in re.finditer(r'<dd>(.*?)</dd>', html_str, re.DOTALL):
            dd_text = strip_html(dd_m.group(1)).strip()
            if 30 < len(dd_text) < 400 and _is_real_quote(dd_text):
                if not dd_text.startswith(("Category:", "See also", "External", "Retrieved", "Source")):
                    result["blurb"] = "\u201c" + dd_text[:250] + "\u201d"
                    _pg = result.get("title") or entry_title
                    if ' ' in _pg and re.match(r'^[A-Z][a-z]+ [A-Z]', _pg):
                        result["attribution"] = _pg
                    break
    if not result.get("blurb"):
        # Try text after a "Quotes" section heading
        quotes_section = re.search(r'<h[23][^>]*>(?:<[^>]*>)*\s*Quotes?\s*(?:<[^>]*>)*</h[23]>(.*?)(?:<h[23]|$)',
                                   html_str, re.DOTALL | re.IGNORECASE)
        if quotes_section:
            for li_m in re.finditer(r'<li>(.*?)</li>', quotes_section.group(1), re.DOTALL):
                li_text = strip_html(li_m.group(1)).strip()
                if 30 < len(li_text) < 400 and _is_real_quote(li_text):
                    if not li_text.startswith(("Category:", "See also", "External", "Retrieved")):
                        result["blurb"] = "\u201c" + li_text[:250] + "\u201d"
                        _pg = result.get("title") or entry_title
                        if ' ' in _pg and re.match(r'^[A-Z][a-z]+ [A-Z]', _pg):
                            result["attribution"] = _pg
                        break


def _extract_preview_ted(html_str, archive, zim_name, path, result):
    """Extract TED talk speaker name and photo.

    <p id="speaker"> has the last name; speaker_desc has the full name in prose.
    Strategy: get last name, then find "FirstName LastName" in speaker_desc.
    Populates result["speaker"] and result["thumbnail"] in place.
    """
    speaker = None
    last_name = None
    sp_m = re.search(r'<p\s+id=["\']speaker["\'][^>]*>(.*?)</p>', html_str, re.DOTALL | re.IGNORECASE)
    if sp_m:
        last_name = re.sub(r'\s+', ' ', strip_html(sp_m.group(1))).strip()
        if ' ' in last_name:
            # Already a full name (some playlist ZIMs have full names)
            speaker = last_name
    # Find full name in speaker_desc by locating the last name in context
    if not speaker and last_name:
        sp_desc = re.search(r'<p\s+id=["\']speaker_desc["\'][^>]*>(.*?)</p>', html_str, re.DOTALL | re.IGNORECASE)
        if sp_desc:
            desc_text = re.sub(r'\s+', ' ', strip_html(sp_desc.group(1))).strip()
            # Find last name in the desc and grab preceding word(s) as first name
            # e.g. "Biologist E.O. Wilson explored..." → find "Wilson", grab "E.O. Wilson"
            esc_last = re.escape(last_name)
            name_m = re.search(r'((?:(?:[A-Z][\w.\'\u2019-]*|el|de|van|von|al)\s+){0,3})' + esc_last + r'\b', desc_text)
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
    sp_img = re.search(r'<img\s+id=["\']speaker_img["\'][^>]*src=["\']([^"\']+)["\']', html_str, re.IGNORECASE)
    if not sp_img:
        sp_img = re.search(r'<img[^>]*id=["\']speaker_img["\'][^>]*src=["\']([^"\']+)["\']', html_str, re.IGNORECASE)
    if sp_img:
        src = sp_img.group(1)
        if not src.startswith("http") and not src.startswith("//") and not src.startswith("data:"):
            resolved = _resolve_img_path(archive, path, src)
            if resolved:
                result["thumbnail"] = f"/w/{zim_name}/{resolved}"


def _extract_preview_factbook(html_str, archive, zim_name, path, result):
    """Extract World Factbook country flag or locator map image.

    Tries flag images first (alt/src containing "flag"), then locator maps.
    Populates result["thumbnail"] in place.
    """
    # Look for flag images: <img> with alt/src containing "flag"
    for flag_m in re.finditer(r'<img\b([^>]*)>', html_str[:60000], re.IGNORECASE):
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
        if is_flag and not src.startswith("http") and not src.startswith("//") and not src.startswith("data:"):
            resolved = _resolve_img_path(archive, path, src)
            if resolved:
                result["thumbnail"] = f"/w/{zim_name}/{resolved}"
                return

    # Try locator map if no flag found
    for loc_m in re.finditer(r'<img\b([^>]*)>', html_str[:60000], re.IGNORECASE):
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
    for img_m in re.finditer(r'<img\b([^>]*)>', html_str, re.IGNORECASE):
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
        creator_m = re.search(r'<meta\s+content="([^"]+)"\s+name="dc\.creator"', gut_html[:8000], re.IGNORECASE)
        if not creator_m:
            creator_m = re.search(r'<meta\s+name="dc\.creator"\s+content="([^"]+)"', gut_html[:8000], re.IGNORECASE)
        if creator_m:
            author = creator_m.group(1).strip()
    if author:
        # Convert "Last, First, dates" → "First Last"
        if ',' in author:
            parts = author.split(',')
            last = parts[0].strip()
            first = parts[1].strip() if len(parts) > 1 else ''
            if first and not re.match(r'^\d', first):
                author = first + ' ' + last
            else:
                author = last
        if author.lower() != 'various':
            result["author"] = author[:100]
    # Cover image: look for .cover-art img (Gutenberg cover pages)
    if not result["thumbnail"]:
        cover_m = re.search(r'<img[^>]*class="[^"]*cover-art[^"]*"[^>]*src=["\']([^"\']+)["\']', gut_html, re.IGNORECASE)
        if not cover_m:
            cover_m = re.search(r'<img[^>]*src=["\']([^"\']*cover_image[^"\']*)["\']', gut_html, re.IGNORECASE)
        if cover_m:
            src = cover_m.group(1)
            if not src.startswith(("http", "//", "data:")):
                resolved = _resolve_img_path(archive, path, src)
                if resolved:
                    result["thumbnail"] = f"/w/{zim_name}/{resolved}"


def _extract_wiktionary_pos_and_def(section_html, result, pos_heading_levels):
    """Extract part of speech and definition from a wiktionary section.

    pos_heading_levels: regex character class for heading levels to search,
    e.g. '34' for <h3>/<h4> or '234' for <h2>/<h3>/<h4>.
    Populates result["part_of_speech"], result["blurb"], result["boring"] in place.
    """
    pos_pattern = r'<h[' + pos_heading_levels + r'][^>]*>(.*?)</h'
    for pos_m in re.finditer(pos_pattern, section_html, re.DOTALL | re.IGNORECASE):
        pos_text = strip_html(pos_m.group(1)).strip()
        if pos_text.lower() in ('noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition',
                                 'conjunction', 'interjection', 'determiner', 'particle', 'prefix', 'suffix'):
            result["part_of_speech"] = pos_text
            break
    # Definition from first <ol><li> — skip boring inflected forms
    _boring_def = re.compile(r'^(plural of |third-person |simple past |past participle |present participle |alternative |archaic |obsolete |misspelling |eye dialect |nonstandard )', re.IGNORECASE)
    for def_m in re.finditer(r'<ol[^>]*>\s*<li[^>]*>(.*?)</li>', section_html, re.DOTALL):
        def_text = strip_html(def_m.group(1)).strip()
        def_text = re.split(r'\n', def_text)[0].strip()
        if len(def_text) > 5 and not def_text.startswith(('Category:', 'See also')):
            if _boring_def.match(def_text):
                result["boring"] = True  # signal to retry
            else:
                result["blurb"] = def_text[:200]
            break


def _extract_preview_wiktionary(html_str, zim_name, result):
    """Extract definition and part of speech from a Wiktionary article (English only).

    Populates result["part_of_speech"], result["blurb"], result["boring"],
    and result["non_english"] in place.
    """
    # Only extract from the English section of the page
    eng_m = re.search(r'<h2[^>]*id=["\']English["\']', html_str[:30000], re.IGNORECASE)
    if eng_m:
        # Slice from English header to next <h2> (next language section) or end
        eng_start = eng_m.start()
        next_h2 = re.search(r'<h2[^>]*id=', html_str[eng_start + 50:30000], re.IGNORECASE)
        eng_end = (eng_start + 50 + next_h2.start()) if next_h2 else 30000
        eng_section = html_str[eng_start:eng_end]
        # Part of speech from <h3>/<h4>, definition from <ol><li>
        _extract_wiktionary_pos_and_def(eng_section, result, '34')
    else:
        # No <h2 id="English"> — could be Simple Wiktionary (monolingual, no language headers)
        # or a non-English entry. Check if page has any <ol><li> definitions.
        is_simple = "simple" in zim_name.lower()
        if is_simple:
            # Simple Wiktionary: treat entire page as English content
            eng_section = html_str[:30000]
            # Part of speech: Simple Wiktionary uses <h2> for POS (not nested under language)
            _extract_wiktionary_pos_and_def(eng_section, result, '234')
            if not result.get("part_of_speech"):
                # Try inline pattern: (noun), (verb), etc.
                pos_inline = re.search(r'\((\w+)\)', eng_section[:3000])
                if pos_inline and pos_inline.group(1).lower() in ('noun', 'verb', 'adjective', 'adverb'):
                    result["part_of_speech"] = pos_inline.group(1).capitalize()
        else:
            # Full Wiktionary, no English section — flag for the random endpoint to skip
            result["non_english"] = True


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
    _skip_blurb = re.compile(r'(Creative Commons|This work is licensed|free to copy and share|All rights reserved|Copyright \d|DMCA)', re.IGNORECASE)
    for pm in re.finditer(r'<p\b[^>]*>(.*?)</p>', html_str, re.DOTALL | re.IGNORECASE):
        text = strip_html(pm.group(1))
        if len(text) > 40 and not _skip_blurb.search(text):
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
            if src.startswith("http://") or src.startswith("https://") or src.startswith("//"):
                continue  # external URL, can't serve from ZIM
            if not src.lower().endswith(".svg"):
                resolved = _resolve_img_path(archive, path, src)
                if resolved:
                    return f"/w/{zim_name}/{resolved}"

    # Fall back to best content image using scoring heuristics
    best_img = None
    best_score = 0
    for m in re.finditer(r'<img\b([^>]*)>', html_str, re.IGNORECASE):
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
        if src_base in ("home_on.png", "home_off.png", "banner_ext2.png",
                         "photo_on.gif", "one-page-summary.png", "travel-facts.png"):
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
        ctx = html_str[ctx_start:m.start()].lower()
        if re.search(r'<(header|nav|footer)\b', ctx) and not re.search(r'</(header|nav|footer)>', ctx):
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
        log.debug("Failed to read entry for preview extract %s/%s: %s", zim_name, path, e)
        return result

    # -- Title: extract from <title> or og:title if entry.title is a slug --
    entry_title = entry.title or ""
    title = _extract_preview_title(html_str, entry_title)
    if title:
        result["title"] = title

    # -- Content-type-specific extraction --
    zim_lower = zim_name.lower()

    if "wikiquote" in zim_lower:
        _extract_preview_wikiquote(html_str, result, entry_title)

    if "ted" in zim_lower:
        _extract_preview_ted(html_str, archive, zim_name, path, result)

    if "theworldfactbook" in zim_lower and not result["thumbnail"]:
        _extract_preview_factbook(html_str, archive, zim_name, path, result)

    if "xkcd" in zim_lower and not result["blurb"]:
        _extract_preview_xkcd(html_str, result)

    if "gutenberg" in zim_lower:
        _extract_preview_gutenberg(html_str, archive, zim_name, path, entry, result)

    if "wiktionary" in zim_lower:
        _extract_preview_wiktionary(html_str, zim_name, result)

    # -- Generic blurb fallback --
    if not result["blurb"]:
        result["blurb"] = _extract_preview_blurb(html_str)

    # -- Generic thumbnail fallback --
    if not result["thumbnail"]:
        result["thumbnail"] = _extract_preview_thumbnail(html_str, archive, zim_name, path)

    return result
