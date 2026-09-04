"""Export to ZIM — write bookmarked articles into standalone .zim files.

Each bookmark becomes one HTML article. v2 carries the source article's real
IMAGES and STYLING into the export so the result RESEMBLES the original — not
the bare text dump v1 produced. Images (and one level of the CSS ``url()``
assets they pull) are copied into the ZIM and the references rewritten; the
article's stylesheets are inlined into its head. An auto-generated index page
(the ZIM main entry) links every entry, grouped into sections when the caller
supplies them (a folder's subfolders become sections within its ZIM).

Multiple "jobs" (one per selected top-level folder) each produce their OWN
``.zim`` — see ``build_export_jobs`` / ``start_export``.

Threading model: the libzim *writer* (``libzim.writer.Creator``) writes a NEW
file and is independent of the read-side ``Archive`` pool — safe on a worker
thread. Source READS (article HTML and asset bytes) still touch libzim
``Archive`` objects, which are NOT thread-safe, so every read goes through the
``_srv._zim_lock``-guarded path.
"""

import colorsys
import contextlib
import datetime
import hashlib
import html as _html
import io
import json
import logging
import os
import pathlib
import posixpath
import re
import struct
import threading
import time
import urllib.parse
import zlib

import zimi.server as _srv

log = logging.getLogger("zimi.zimwriter")

# Strip these whole elements (with content) from embedded article bodies — they
# either don't work standalone or are a security/nuisance risk in the export.
# Stylesheets are handled separately (inlined) BEFORE this runs.
_STRIP_TAGS_RE = re.compile(
    r"<(script|style|link|meta|noscript)\b[^>]*>.*?</\1\s*>",
    re.IGNORECASE | re.DOTALL,
)
_STRIP_VOID_RE = re.compile(r"<(link|meta)\b[^>]*/?>", re.IGNORECASE)
_BODY_RE = re.compile(r"<body[^>]*>(.*)</body>", re.IGNORECASE | re.DOTALL)

# ── reading one HTML attribute ──────────────────────────────────────────────
#
# Every capture and export path needs "what does this tag's src/href/rel say",
# and every one of them used to write its own regex for it. There were eight,
# in four files, and six shared two bugs:
#
#   * They required quotes. `<link rel=stylesheet href=/a.css>` is legal HTML5
#     and common in hand-written pages, and to those six it was invisible — so
#     the page came out with no stylesheet and nothing said so.
#   * `\bsrc` matches inside `data-src`, because `-` is not a word character.
#     A lazy-loading `<img data-src=... src=...>` — which is most images on
#     most news sites — handed back the placeholder instead of the real image.
#
# One builder, so a fix lands once. The value is a single `val` group across
# all three legal shapes, which is what lets a caller stop caring which one it
# got. The conditional `(?(q)...)` is doing that work: a closing quote is
# required only if an opening one was found.
#
# This is deliberately not an HTML parser. It reads one attribute out of one
# tag that a caller has already isolated, which is the whole job.
#
# A BARE value may not begin with an entity quote. That is never really a bare
# value — it is the inside of a serialized fragment a page parked in a data-*
# attribute, where the delimiters are entities rather than characters:
#
#     data-source-html="<a href=&quot;https://www.cnn.com/&quot;>CNN</a>"
#
# Without this the inner href matched with `&quot;…&quot;` swallowed into the
# value, and every rewriter here re-emits values in REAL double quotes — so it
# came back out as href="&quot;https://www.cnn.com/&quot;", whose quotes close
# data-source-html early. The remainder of the tag then lands on the page as
# visible text. cnn.com's homepage did that in a shipped capture.
#
# Refusing the match leaves the fragment untouched, which is what we want: it
# is markup for JavaScript to inject later, no rewrite makes it more offline
# than it already is, and a fragment we cannot rewrite safely is one to leave
# exactly as the site wrote it.
_ENTITY_QUOTE = r"&quot;|&#0*34;|&apos;|&#0*39;"
_ATTR_VALUE = (
    r"""(?P<q>["'])?(?P<val>(?(q).*?|(?!"""
    + _ENTITY_QUOTE
    + r""")[^\s"'=<>`]*))(?(q)(?P=q))"""
)
_ATTR_RE_CACHE = {}


def attr_quote(value):
    """One attribute value, ready to sit inside double quotes.

    Every rewrite here emits ``pre + '"' + value + '"'``, which is correct for
    a value we invented (a ZIM path) and WRONG for one carried over from the
    page. HTML lets a single-quoted attribute hold a double quote, so

        <img src='https://ex.com/a"b.png'>

    came back out as ``<img src="/a"b.png">`` — markup broken and the src
    truncated to ``/a``. Rare in the wild and completely silent when it lands.

    Escaping only the quote, not the whole value: ``&`` and ``<`` are already
    however the source page wanted them, and re-escaping an existing ``&amp;``
    would double it into ``&amp;amp;`` — the same class of bug as the one that
    cost a day when carry() was not unescaping."""
    return str(value).replace('"', "&quot;")


def attr_re(*names):
    """Compiled matcher for an HTML attribute, quoted or bare.

    Groups: ``pre`` (leading space, the name, the ``=``), ``attr`` (which name
    matched, for a multi-name call), ``q`` (the quote or None) and ``val``.

    Rewrite with ``m.group("pre") + '"' + new + '"'`` — always emit quotes. A
    value that arrived bare may not survive being written back bare, and a
    quoted attribute is correct either way."""
    rx = _ATTR_RE_CACHE.get(names)
    if rx is None:
        # The lookbehind sits AFTER the optional whitespace, so it inspects the
        # character immediately before the name — `-` in `data-src`, `:` in
        # `xlink:href`. \b cannot do this: it is satisfied by that same hyphen.
        alternation = "|".join(names)
        rx = re.compile(
            rf"""(?P<pre>\s*(?<![-\w:])(?P<attr>{alternation})\s*=\s*){_ATTR_VALUE}""",
            re.IGNORECASE | re.DOTALL,
        )
        _ATTR_RE_CACHE[names] = rx
    return rx


# ── raw text is not markup ──────────────────────────────────────────────────
#
# <script> and <style> hold TEXT. The HTML spec calls them raw text elements:
# a browser stops parsing tags at the opening tag and resumes at the closing
# one, so `<img src='...'>` inside a script is a string, not an image.
#
# Scanning those bodies anyway is how sqlite.org killed a whole site crawl on
# its first page. The homepage builds its sponsor logos in JavaScript, by
# concatenation:
#
#     h += "'><img src='images/foreignlogos/";
#     h += sponsors[i].src + "'";
#
# The page therefore literally contains the characters `<img src='images/…`,
# our matcher saw the opening quote, and — with DOTALL on, because real
# attributes do wrap across lines — ran to the next quote three lines later.
# The "URL" it produced had a newline in it, urlopen refused it, and the
# resulting exception ended a fifteen-page crawl after one page.
#
# Same family as the cnn.com fragment above, one level out: that was markup
# hiding inside an attribute, this is markup hiding inside a script. In both
# cases the answer is to leave alone the bytes that were never ours to rewrite.
#
# The mask blanks the BODIES to spaces and keeps the tags. Same length is the
# whole design: a match found on the mask has the same offsets and the same
# text as the original everywhere outside a blanked body, so callers can match
# on the mask and splice into the real thing.
_RAW_TEXT_RE = re.compile(
    r"(?is)(?P<open><(?P<tag>script|style)\b[^>]*>)(?P<body>.*?)(?P<close></(?P=tag)\s*>)"
)
_COMMENT_RE = re.compile(r"(?s)(?P<open><!--)(?P<body>.*?)(?P<close>-->)")


# The filler is NOT a space. cnn.com's page carries a 2.5 MB inline stylesheet;
# masked to spaces it handed every attribute scanner a run of 2.5 million
# spaces, and a pattern with a leading \s* walks such a run quadratically —
# the style-attribute carry never returned and the server stopped answering
# (prod, 2026-09-03). A tilde is not whitespace, not a quote, not a bracket
# and not a word character, so no scanner has any reason to step into it.
MASK_FILLER = "~"


def _blank_body(m):
    return m.group("open") + MASK_FILLER * len(m.group("body")) + m.group("close")


def mask_raw_text(html):
    """``html`` with script/style bodies and comment bodies blanked to spaces.

    Byte-for-byte identical everywhere else, and exactly as long, so offsets
    and group text taken from the mask are valid against the original."""
    return _COMMENT_RE.sub(_blank_body, _RAW_TEXT_RE.sub(_blank_body, html))


def sub_markup(rx, repl, html):
    """``rx.sub(repl, html)`` restricted to the parts that are really markup.

    Matching happens on the mask and splicing on the original, which is safe
    precisely because the two are the same length and agree everywhere the
    mask did not blank."""
    mask = mask_raw_text(html)
    out, last = [], 0
    for m in rx.finditer(mask):
        out.append(html[last : m.start()])
        out.append(repl(m) if callable(repl) else repl)
        last = m.end()
    out.append(html[last:])
    return "".join(out)


# Asset carrying. `src` on media tags + `href` on stylesheet links; `url()` in
# CSS. Kept deliberately simple/bounded — a bookmark ZIM is not a full mirror.
_STYLESHEET_RE = re.compile(r"<link\b[^>]*>", re.IGNORECASE)
_HREF_RE = attr_re("href")
_REL_RE = attr_re("rel")
# The <link rel> values that name a file a reader still needs offline. Both
# capture engines carry exactly these — the fast engine once carried only the
# stylesheet, and Eric's cnn.com capture came out with the right logo on its
# library tile (the ZIM illustration is fetched separately) and no favicon on
# the page, because its two icon links still pointed at a root-relative
# address that resolves against Zimi's own origin and 404s.
CARRIED_LINK_RELS = frozenset({"stylesheet", "icon", "apple-touch-icon", "mask-icon"})


_INTEGRITY_RE = re.compile(r"""\s+(?:integrity|crossorigin)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)""", re.IGNORECASE)


def drop_integrity(tag):
    """``tag`` without its ``integrity`` and ``crossorigin`` attributes.

    A subresource-integrity hash is for the file the page shipped with. A
    carried stylesheet has had its url() refs rewritten, so its bytes no
    longer match, and a browser that finds the hash refuses the whole sheet:
    docs.docker.com opened naked with its stylesheet sitting in the ZIM."""
    return _INTEGRITY_RE.sub("", tag)


def carried_link_rels(tag):
    """The ``rel`` tokens of a ``<link>`` tag, lower-cased; empty if it has none."""
    m = _REL_RE.search(tag)
    return m.group("val").lower().split() if m else []


# An advertisement is served live, by JavaScript, into a slot the markup
# reserves for it. Offline the slot is always empty — no engine carries the
# ad — and a reserved box keeps whatever size and colour the site gave it.
# cnn.com's header slot is 50px of #0c0c0c directly under Zimi's own topbar,
# which reads as a second, blank header. The slot is hidden. The match is a
# class-token PREFIX (start of the attribute, or after a space), never a
# substring: "thread-slot" contains the letters and is not an advertisement.
# bbc.com names its slot in camel case through styled-components
# ("AdSlot-styles__AdSlotContainerStyled-sc-…"), and that spelling cannot be
# part of an ordinary word, so it is matched anywhere in the attribute.
#
# The reader's own settle rule (app.js _settleCapturedChrome) hides ad boxes
# that are `:empty`, and CNN's band is not: it is four nested wrappers around
# one empty div, and only the innermost matched. Stamping the rule into the
# capture also means a ZIM read outside Zimi gets it.
AD_SLOT_STYLE_ID = "zimi-ad-slots"
_AD_SLOT_STYLE = (
    f'<style id="{AD_SLOT_STYLE_ID}">'
    '[class^="ad-slot"],[class*=" ad-slot"],[class*="AdSlot"],[class*="adSlot"],'
    '.adsbygoogle,[id^="div-gpt-ad"]'
    "{display:none!important}</style>"
)
_HEAD_OPEN_RE = re.compile(r"<head\b[^>]*>", re.IGNORECASE)


def collapse_ad_slots(html):
    """``html`` with the ad-slot hiding rule in its ``<head>``, added once.

    A page without a ``<head>`` gets the rule prepended; a page that already
    carries it is returned unchanged, so re-rendering is idempotent."""
    if AD_SLOT_STYLE_ID in html:
        return html
    m = _HEAD_OPEN_RE.search(html)
    if m:
        return html[: m.end()] + _AD_SLOT_STYLE + html[m.end() :]
    return _AD_SLOT_STYLE + html


_MEDIA_TAG_RE = re.compile(r"<(img|source)\b[^>]*>", re.IGNORECASE)
_SRC_RE = attr_re("src")
_SRCSET_RE = attr_re("srcset")
_LOADING_RE = attr_re("loading")


def _placeholder_source(tag):
    """True for a ``<source>`` whose srcset holds nothing but data: URIs, or
    that a site marked ``data-empty``: a stand-in for a script to replace."""
    if _DATA_EMPTY_RE.search(tag):
        return True
    m = _SRCSET_RE.search(tag)
    if not m:
        return False
    candidates = [url for url, _d in _split_srcset(m.group("val"))]
    return bool(candidates) and all(u.lower().startswith("data:") for u in candidates)


_DATA_EMPTY_RE = re.compile(r"\sdata-empty(?:\s|=|>|/)", re.IGNORECASE)


def _load_eagerly(tag):
    """Drop ``loading="lazy"`` from a media tag.

    Lazy loading is a bandwidth optimisation for the live web: don't fetch a
    picture until the reader is nearly looking at it. Offline the bytes are
    already on disk, so deferring buys nothing — and it costs correctness,
    because "nearly looking at it" is decided from the layout.

    cnn.com's homepage is the proof. Captured, 72 of its 117 images never
    decoded no matter how far the page was scrolled. All 72 were lazy, and 59
    of them had a zero-sized box: the page is a JavaScript application, its
    rails and carousels collapse to nothing when that JavaScript never runs,
    and an image inside a zero-height container never enters the viewport. It
    is not slow to arrive, it is never requested at all. Every one of those
    files was sitting in the ZIM, correctly referenced, unread.

    Eager is the only honest setting for an archive: the reader has already
    paid for these bytes."""
    return _LOADING_RE.sub(
        lambda m: "" if m.group("val").strip().lower() == "lazy" else m.group(0),
        tag,
    )


_CSS_URL_RE = re.compile(r"""url\(\s*(['"]?)([^'")]+)\1\s*\)""", re.IGNORECASE)

# Link rewriting. The scheme list is explicit rather than a general
# `^scheme:` match because ZIM article paths look exactly like URI schemes —
# "Category:Water" and "Help:Contents" are entries, not protocols.
_NON_PATH_SCHEME_RE = re.compile(
    r"^(mailto|tel|sms|javascript|data|about|blob|file|geo|ftp|irc|magnet|xmpp):",
    re.IGNORECASE,
)
_ANCHOR_RE = re.compile(r"<a\b([^>]*)>(.*?)</a\s*>", re.IGNORECASE | re.DOTALL)
# Same matchers; the names say which job they are doing at the call site. The
# leading whitespace lives inside `pre`, so stripping one of these out of an
# attribute list does not leave a double space behind.
_ANCHOR_HREF_RE = attr_re("href")
_ANCHOR_TITLE_RE = attr_re("title")

# Bounds so a runaway article/ZIM can't be produced (a bookmark ZIM is small).
_MAX_ASSET_BYTES = 5 * 1024 * 1024  # per single asset
_MAX_TOTAL_ASSET_BYTES = 80 * 1024 * 1024  # per whole ZIM
_MAX_ASSETS = 1200  # per whole ZIM
# What a media reference must never turn out to be. A page is content, not an
# asset: carrying one stores a whole article under an image's name, and a
# capture that did it thirty-four times filed 130 MB of articles as pictures.
_NOT_AN_ASSET = frozenset(
    {"text/html", "application/xhtml+xml", "text/xml", "application/xml"}
)

# Export state for the poll endpoint. `file`/`files` surface the written ZIMs.
_export_lock = threading.Lock()
_export_state = {
    "phase": None,  # None | "running" | "done" | "error"
    "done": 0,
    "total": 0,
    "file": None,  # last output filename (back-compat with the v1 client)
    "files": [],  # every output filename (v2, one per folder)
    "count": 0,  # articles written
    "error": None,
}


def _set_export_state(**kw):
    _export_state.update(kw)


def get_export_state():
    """Copied snapshot for the status poll endpoint (never the live dict)."""
    snap = dict(_export_state)
    snap["files"] = list(snap.get("files") or [])
    return snap


def _slug(text, fallback):
    """A short, filesystem/URL-safe slug for an in-ZIM article path."""
    s = re.sub(r"[^a-zA-Z0-9]+", "_", (text or "")).strip("_")
    return (s or fallback)[:60]


def _read_source_article(zim, path):
    """Fetch a source article's HTML under the libzim read lock. Returns the
    decoded HTML string, or None if the ZIM/entry is missing or unreadable."""
    try:
        with _srv._zim_lock:
            archive = _srv.get_archive(zim)
            if archive is None:
                return None
            try:
                entry = archive.get_entry_by_path(path)
            except KeyError:
                return None
            if entry.is_redirect:
                entry = entry.get_redirect_entry()
            item = entry.get_item()
            return bytes(item.content).decode("utf-8", errors="replace")
    except Exception as e:  # missing entry, decode failure, corrupt ZIM
        log.debug("bookmark export: read failed for %s/%s: %s", zim, path, e)
        return None


def _read_source_item(zim, path):
    """Fetch a source entry's RAW bytes + mimetype (images, fonts, CSS) under
    the read lock. Returns (bytes, mimetype) or None."""
    try:
        with _srv._zim_lock:
            archive = _srv.get_archive(zim)
            if archive is None:
                return None
            try:
                entry = archive.get_entry_by_path(path)
            except KeyError:
                return None
            if entry.is_redirect:
                entry = entry.get_redirect_entry()
            item = entry.get_item()
            try:
                mime = item.mimetype
            except Exception:
                mime = "application/octet-stream"
            return bytes(item.content), mime
    except Exception as e:
        log.debug("bookmark export: asset read failed for %s/%s: %s", zim, path, e)
        return None


def _resolve_ref(base_path, ref):
    """Resolve an in-article reference (img src, css url, link href) to a ZIM
    entry path, or None for external / data / anchor-only refs we don't carry."""
    if not ref:
        return None
    ref = ref.split("#", 1)[0].split("?", 1)[0].strip()
    if not ref or ref.startswith("//") or "://" in ref:
        return None
    if _NON_PATH_SCHEME_RE.match(ref):
        return None
    if ref.startswith("/"):
        return ref.lstrip("/")
    base_dir = posixpath.dirname(base_path)
    return posixpath.normpath(posixpath.join(base_dir, ref)).lstrip("/")


# Extensions worth keeping on a hashed remote-asset name when the URL path
# carries none — so the file reads as what it is and links look sane. The mime
# is authoritative; this is only a display nicety.
_EXT_FOR_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
}


def _split_srcset(value):
    """Split a srcset into (url, descriptor) pairs the way the HTML spec does.

    Candidates are comma-separated, but a URL may itself CONTAIN commas — CNN's
    image API puts them in the query (``?q=h_720,w_1280,c_fill/f_webp``). Naive
    ``value.split(",")`` shredded one such URL into three bogus candidates, and
    a phone (whose <source> matched where a desktop's did not) then picked the
    garbage and showed a broken image. So: skip separators, take a run of
    non-whitespace as the URL, then everything up to the next comma is its
    descriptor.
    """
    out = []
    i, n = 0, len(value)
    while i < n:
        while i < n and (value[i].isspace() or value[i] == ","):
            i += 1
        if i >= n:
            break
        start = i
        while i < n and not value[i].isspace():
            i += 1
        url = value[start:i]
        # A URL may end with commas, which are separators, not part of it.
        stripped = url.rstrip(",")
        if stripped != url:
            out.append((stripped, ""))
            continue
        while i < n and value[i].isspace():
            i += 1
        d_start = i
        while i < n and value[i] != ",":
            i += 1
        out.append((url, value[d_start:i].strip()))
        i += 1
    return out


# One image per slot, at up to twice the display density.
#
# A srcset offers the same picture at four or five widths so a live browser can
# pick per device. An archive is not choosing — it is storing — and storing all
# of them means four copies of every picture for the one a reader will be
# served. CNN's front page cost 835 images and 62 MB that way. Above 2x there
# is also nothing to see: no display Zimi is read on resolves it.
VARIANT_MAX_DPR = 2
# The width to aim at, in device pixels: a comfortable reading column at 2x.
VARIANT_TARGET_WIDTH = 1600


def pick_srcset(candidates, target_width=VARIANT_TARGET_WIDTH, max_dpr=VARIANT_MAX_DPR):
    """The single ``(url, descriptor)`` worth keeping, or None.

    Width descriptors win on the smallest candidate that still covers the
    target, so a picture is never upscaled on the page it came from. Density
    descriptors win on the largest at or under the cap. A candidate with no
    descriptor is a 1x candidate, which is what the spec says it is."""
    widths, densities = [], []
    for url, descriptor in candidates:
        text = (descriptor or "").strip().lower()
        try:
            if text.endswith("w"):
                widths.append((float(text[:-1]), url, descriptor))
                continue
            if text.endswith("x"):
                densities.append((float(text[:-1]), url, descriptor))
                continue
        except ValueError:
            pass
        densities.append((1.0, url, descriptor))
    if widths:
        widths.sort()
        for width, url, descriptor in widths:
            if width >= target_width:
                return url, descriptor
        return widths[-1][1], widths[-1][2]
    if not densities:
        return None
    densities.sort()
    affordable = [c for c in densities if c[0] <= max_dpr]
    chosen = affordable[-1] if affordable else densities[0]
    return chosen[1], chosen[2]


_IMAGE_SET_OPEN_RE = re.compile(r"(?:-webkit-)?image-set\(", re.IGNORECASE)
_IMAGE_SET_CANDIDATE_RE = re.compile(
    r"""url\(\s*(['"]?)(?P<url>[^'")]+)\1\s*\)(?P<rest>[^,]*)""", re.IGNORECASE
)


_VARIANT_PROP_RE = re.compile(
    r"""(?P<name>--[\w-]+?)(?P<dev>-(?:desktop|tablet|mobile))?(?:-url)?(?P<dens>-\dx)?\s*:\s*url\(\s*(?P<q>['"]?)(?P<url>[^'")]+)(?P=q)\s*\)""",
    re.IGNORECASE,
)
# The candidate a phone at 2x would be served, then the next best. Desktop is
# last: the variant policy stores one picture at up to 1600 device pixels.
_VARIANT_ORDER = ("mobile-2x", "tablet-2x", "desktop-2x", "mobile", "tablet", "desktop", "mobile-3x", "tablet-3x", "desktop-3x", "-2x", "", "-3x")


def collapse_variant_props(css):
    """Custom properties that are one picture at several sizes — cnn.com's
    ``--image-desktop-url``, ``-2x``, ``-3x``, tablet, mobile, nine per <img>
    — collapsed to one file: every property in the group is pointed at the
    mobile 2x candidate (the variant policy's 1600 device pixels), or the
    next best. A property with no siblings is left alone."""
    groups = {}
    for m in _VARIANT_PROP_RE.finditer(css):
        key = (m.group("name") or "").lower()
        tag = ((m.group("dev") or "").lstrip("-") + (m.group("dens") or "")).lower()
        groups.setdefault(key, []).append((tag, m.group("url")))
    picks = {}
    for key, cands in groups.items():
        if len(cands) < 2:
            continue
        by_tag = {t: u for t, u in cands}
        chosen = next((by_tag[t] for t in _VARIANT_ORDER if t in by_tag), cands[0][1])
        picks[key] = chosen

    def repl(m):
        key = (m.group("name") or "").lower()
        if key not in picks:
            return m.group(0)
        q = m.group("q")
        head = m.group(0)[: m.group(0).lower().index("url(")]
        return head + "url(" + q + picks[key] + q + ")"

    return _VARIANT_PROP_RE.sub(repl, css) if picks else css


def collapse_image_set(css):
    """Every ``image-set(...)`` in ``css`` reduced to one ``url(...)``.

    An image-set is a srcset by another name: the same picture at several
    densities for a live browser to choose from. An archive stores, it does
    not choose, and storing every candidate meant six or seven files per card
    on cnn.com (665 for 100 cards; a 34 MB capture became 60 MB). The pick is
    pick_srcset's: the largest at or under 2x."""
    out, pos = [], 0
    while True:
        m = _IMAGE_SET_OPEN_RE.search(css, pos)
        if not m:
            out.append(css[pos:])
            break
        out.append(css[pos : m.start()])
        depth, i = 1, m.end()
        while i < len(css) and depth:
            depth += {"(": 1, ")": -1}.get(css[i], 0)
            i += 1
        inner = css[m.end() : i - 1]
        candidates = []
        for c in _IMAGE_SET_CANDIDATE_RE.finditer(inner):
            rest = c.group("rest")
            descriptor = re.sub(r"type\([^)]*\)", "", rest).strip()
            candidates.append((c.group("url").strip(), descriptor))
        picked = pick_srcset(candidates) if candidates else None
        if picked:
            url = picked[0]
            quote = '"' if '"' in inner[: inner.find(url)] else ("'" if "'" in inner[: inner.find(url)] else "")
            out.append("url(" + quote + url + quote + ")")
        else:
            out.append(css[m.start() : i])
        pos = i
    return "".join(out)


def _remote_asset_name(url, mime):
    """A stable, collision-resistant in-ZIM filename for a cross-origin asset:
    the URL hashed, with a sensible extension (from the URL path, else the
    mime). Hashing the whole URL keeps two CDN images with the same basename
    from clobbering each other."""
    h = hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
    path = urllib.parse.urlsplit(url).path
    ext = posixpath.splitext(path)[1].lower()
    if not ext or len(ext) > 6:
        ext = _EXT_FOR_MIME.get((mime or "").split(";")[0].strip().lower(), "")
    return h + ext


class _AssetCarrier:
    """Copies referenced assets from source ZIMs into the export, deduped and
    bounded. `add_item` is the Creator's, injected so the class stays testable.
    Rewrites references to the carried in-ZIM path (relative to an ``A/<slug>``
    article, i.e. ``../<path>``)."""

    def __init__(
        self,
        add_item,
        item_factory,
        asset_reader,
        remote_reader=None,
        on_progress=None,
        page_url=None,
    ):
        self._add = add_item
        self._make = item_factory  # (path, mimetype, bytes) -> libzim Item
        self._read = asset_reader
        # The page's own absolute URL, when the carrier is fetching over HTTP.
        # A same-origin reference that carries a query string is an address
        # only the server can interpret — react.dev's images are all
        # ``/_next/image?url=…&w=828`` — so it is fetched whole, through the
        # remote reader, rather than as the path the resolver would leave.
        # None on the export path, where a query means nothing.
        self._page_url = page_url
        # Optional (absolute_url) -> (bytes, mime) | None. When present, a media
        # ref that isn't same-origin (a CDN-hosted <img>) is fetched through it
        # instead of dropped. None on the bookmark-export path, whose reader
        # only knows local ZIMs — so that path's behavior is unchanged.
        self._remote = remote_reader
        # Called (count, total_bytes) after each asset lands, so a long carry
        # can report itself. The Fast engine fetches a page's images DURING the
        # packaging step, and with nothing reporting it the run pane sat blank
        # for minutes (Eric: "this view is still empty and lame").
        self._on_progress = on_progress
        self._carried = {}  # resolved source path -> in-ZIM path (or None if skipped)
        self.total_bytes = 0
        self.count = 0
        # What actually went in, so the Tags metadata can claim `_pictures:` /
        # `_videos:` from evidence instead of from a guess.
        self.mimetypes = set()

    def _carry(self, zim, resolved, depth=0):
        """Ensure `resolved` (a path in `zim`) is in the export; return its
        in-ZIM path or None. Recurses one level into CSS ``url()`` refs."""
        key = zim + "\n" + resolved
        if key in self._carried:
            return self._carried[key]
        if self.count >= _MAX_ASSETS or self.total_bytes >= _MAX_TOTAL_ASSET_BYTES:
            self._carried[key] = None
            return None
        got = self._read(zim, resolved)
        if not got:
            self._carried[key] = None
            return None
        data, mime = got
        if not data or len(data) > _MAX_ASSET_BYTES:
            self._carried[key] = None
            return None
        # Same rule as _carry_remote: a media reference is not allowed to be a
        # page. Same-origin is the commoner way in — a news site's own markup
        # points <source>/<link> refs at its own articles — and a guard on only
        # one of the two carriers is a guard on neither.
        if (mime or "").split(";")[0].strip().lower() in _NOT_AN_ASSET:
            log.debug("not carrying %s: it answered with %s", resolved, mime)
            self._carried[key] = None
            return None
        # Namespace per source ZIM so two ZIMs' "I/x.png" can't collide.
        in_path = "_assets/" + _slug(zim, "z") + "/" + resolved
        # CSS may itself pull fonts/images — carry those one level deep first.
        if depth == 0 and (
            "css" in (mime or "").lower() or resolved.lower().endswith(".css")
        ):
            data = self._rewrite_css(zim, resolved, data)
        self._carried[key] = in_path
        self.total_bytes += len(data)
        self.count += 1
        try:
            self._add(self._make(in_path, mime or "application/octet-stream", data))
        except Exception as e:
            log.debug("asset add failed %s: %s", in_path, e)
            self._carried[key] = None
            return None
        self.mimetypes.add(mime or "application/octet-stream")
        self._note_progress()
        return in_path

    def _note_progress(self):
        if not self._on_progress:
            return
        try:
            self._on_progress(self.count, self.total_bytes)
        except Exception as e:  # progress must never break a capture
            log.debug("asset progress hook failed: %s", e)

    def _carry_remote(self, url, depth=0):
        """Carry a cross-origin media URL (a CDN-hosted <img>/<source>) and
        return its in-ZIM path, or None. Same budget and caps as a same-origin
        asset; a no-op when no ``remote_reader`` was supplied (export path)."""
        if not self._remote:
            return None
        key = "\x00remote\n" + url
        if key in self._carried:
            return self._carried[key]
        if self.count >= _MAX_ASSETS or self.total_bytes >= _MAX_TOTAL_ASSET_BYTES:
            self._carried[key] = None
            return None
        got = self._remote(url)
        if not got:
            self._carried[key] = None
            return None
        data, mime = got
        if not data or len(data) > _MAX_ASSET_BYTES:
            self._carried[key] = None
            return None
        # A media reference that answers with a WEB PAGE is not a media asset.
        # CNN's markup points some <source>/<link> refs at article URLs, and
        # storing what came back put thirty-four four-megabyte articles in a
        # single-page capture — a hundred and thirty megabytes of pages nobody
        # asked for, filed as images.
        if (mime or "").split(";")[0].strip().lower() in _NOT_AN_ASSET:
            log.debug("not carrying %s: it answered with %s", url, mime)
            self._carried[key] = None
            return None
        in_path = "_assets/_remote/" + _remote_asset_name(url, mime)
        # A stylesheet pulls fonts and pictures of its own; carried one level
        # deep, like a same-origin sheet. cheatography.com's only real
        # stylesheet lives on its CDN and the page opened naked without it.
        is_css = "css" in (mime or "").lower() or urllib.parse.urlsplit(url).path.lower().endswith(".css")
        if depth == 0 and is_css:
            data = self._rewrite_remote_css(url, data)
        self._carried[key] = in_path
        self.total_bytes += len(data)
        self.count += 1
        try:
            self._add(self._make(in_path, mime or "application/octet-stream", data))
        except Exception as e:
            log.debug("remote asset add failed %s: %s", in_path, e)
            self._carried[key] = None
            return None
        self.mimetypes.add(mime or "application/octet-stream")
        self._note_progress()
        return in_path

    def _rewrite_remote_css(self, css_url, data):
        """The url() refs of a cross-origin stylesheet, resolved against the
        sheet's own address, carried, and written as siblings: every remote
        asset lands in _assets/_remote, the sheet included."""
        try:
            text = collapse_image_set(data.decode("utf-8", errors="replace"))
        except Exception:
            return data

        def repl(m):
            quote, ref = m.group(1), m.group(2).strip()
            if not ref or ref.lower().startswith(("data:", "#", "about:")):
                return m.group(0)
            absolute = urllib.parse.urljoin(css_url, _html.unescape(ref))
            if not absolute.lower().startswith(("http://", "https://")):
                return m.group(0)
            in_path = self._carry_remote(absolute, depth=1)
            if not in_path:
                return m.group(0)
            return "url(" + quote + posixpath.basename(in_path) + quote + ")"

        return _CSS_URL_RE.sub(repl, text).encode("utf-8")

    def carried_path(self, zim, resolved):
        """Where an already-carried source entry lives in the export, or None.
        Lets the link rewriter point an ``<a href>`` at a file the export
        genuinely has (an image it linked to full-size) instead of the web."""
        return self._carried.get(zim + "\n" + resolved)

    def _rewrite_css(self, zim, css_path, data):
        try:
            text = collapse_image_set(data.decode("utf-8", errors="replace"))
        except Exception:
            return data

        def repl(m):
            quote, ref = m.group(1), m.group(2)
            resolved = _resolve_ref(css_path, ref)
            if not resolved:
                return m.group(0)
            in_path = self._carry(zim, resolved, depth=1)
            if not in_path:
                return m.group(0)
            # CSS lives at _assets/<zim>/<css_path>; asset at _assets/<zim>/<res>.
            rel = posixpath.relpath(
                in_path,
                posixpath.dirname("_assets/" + _slug(zim, "z") + "/" + css_path),
            )
            return "url(" + quote + rel + quote + ")"

        return _CSS_URL_RE.sub(repl, text).encode("utf-8")

    def rewrite_media(self, zim, article_path, html):
        """Carry <img>/<source> src (+ srcset) and return rewritten HTML."""

        def in_zim_ref(resolved_in_path):
            # From an A/<slug> article, an in-ZIM path P is reached via ../P.
            return "../" + resolved_in_path

        def carry_ref(ref):
            # A cross-origin media ref (a CDN-hosted image) — absolute, or
            # protocol-relative to another host. Same-origin protocol-relative
            # refs were already rewritten to /path before we got here, so a //
            # that survives points at a different host. Caught BEFORE
            # _resolve_ref, which would mis-read //host/x as same-origin /host/x
            # and 404 it. Only carried when this carrier has a remote reader
            # (the create path) — a no-op on the export path.
            # An attribute value is HTML-encoded, so a tracking query arrives as
            # ?a=1&amp;b=2 — unescape before it becomes an address of any kind,
            # or the &amp; goes on the wire and the server 404s (Wikipedia's
            # sister-project logos carry exactly this; so do react.dev's).
            r = _html.unescape(ref.strip())
            low = r.lower()
            if low.startswith("http://") or low.startswith("https://"):
                return self._carry_remote(r)
            if r.startswith("//"):
                return self._carry_remote("https:" + r)
            # Same-origin with a query string: the query IS the address (a
            # Next.js image is ``/_next/image?url=…&w=828``, nothing else), so
            # it is fetched whole through the remote reader when the page's
            # URL is known. _resolve_ref would drop the query and ask for a
            # path that answers nothing.
            if "?" in r.split("#", 1)[0] and self._page_url:
                return self._carry_remote(urllib.parse.urljoin(self._page_url, r))
            # Same-origin: resolve against the article and carry from source.
            resolved = _resolve_ref(article_path, r)
            if resolved:
                return self._carry(zim, resolved)
            return None

        def fix_tag(tagm):
            tag = tagm.group(0)
            # A <source> whose only candidate is a data: placeholder is not a
            # picture, it is a promise that a script would swap one in.
            # apple.com puts a one-pixel GIF source matching every width in
            # front of each product tile; offline the browser honours it and
            # the tile is a blank box over the real <img> behind it. Gone, so
            # the <img> shows.
            if tag.lower().startswith("<source") and _placeholder_source(tag):
                return ""
            # One slot, one file. Every browser that reads srcset is served the
            # picked candidate, never the src — so the src is rewritten to that
            # same file instead of carried as a second one. theverge.com's
            # front page was 83.8 MB for 140 images that way: a src and a
            # picked candidate per slot, two files where one is ever shown.
            picked_in_path = [None]

            def fix_srcset(m):
                # One candidate, chosen before anything is fetched. This is the
                # stage that actually downloads, so the rule has to hold here or
                # it does not hold at all.
                picked = pick_srcset(_split_srcset(m.group("val")))
                if not picked:
                    return m.group(0)
                url, descriptor = picked
                in_path = carry_ref(url)
                picked_in_path[0] = in_path
                ref = in_zim_ref(in_path) if in_path else url
                value = (ref + " " + descriptor).strip()
                return f'{m.group("pre")}"{attr_quote(value)}"'

            # Always written back quoted, whatever shape it arrived in: a
            # rewritten ref is a ZIM path we chose, and quoting it is correct
            # regardless of what the source page did.
            def fix_src(m):
                in_path = picked_in_path[0] or carry_ref(m.group("val"))
                if not in_path:
                    return m.group(0)
                return f'{m.group("pre")}"{in_zim_ref(in_path)}"'

            tag = _SRCSET_RE.sub(fix_srcset, tag)
            tag = _SRC_RE.sub(fix_src, tag)
            return _load_eagerly(tag)

        return sub_markup(_MEDIA_TAG_RE, fix_tag, html)

    def collect_styles(self, zim, article_path, html):
        """Read the article's stylesheets and return their CSS text to inline
        into the export article head (url() refs already rewritten)."""
        css_chunks = []
        for linkm in _STYLESHEET_RE.finditer(mask_raw_text(html)):
            tag = linkm.group(0)
            relm = _REL_RE.search(tag)
            if not relm or "stylesheet" not in relm.group("val").lower():
                continue
            hrefm = _HREF_RE.search(tag)
            if not hrefm:
                continue
            resolved = _resolve_ref(article_path, hrefm.group("val"))
            if not resolved:
                continue
            got = self._read(zim, resolved)
            if not got:
                continue
            data, _mime = got
            if not data or len(data) > _MAX_ASSET_BYTES:
                continue
            css_chunks.append(
                self._rewrite_css(zim, resolved, data).decode("utf-8", errors="replace")
            )
        return "\n".join(css_chunks)


def _source_url(zim, path):
    """The live-web URL a source article came from, or None when the source
    ZIM's origin is unknown. Injectable at ``build_bookmarks_zim(url_for=…)``
    so the export can be exercised without an installed library."""
    try:
        return _srv.canonical_url(zim, path)
    except Exception as e:  # a missing library must never fail an export
        log.debug("no canonical URL for %s/%s: %s", zim, path, e)
        return None


def _strip_namespace(path):
    """A ZIM path without its legacy ``A/`` namespace prefix. Old ZIMs store
    articles at ``A/Title`` and new ones at ``Title``; a link may be written
    either way, so both shapes have to match the same bookmark."""
    return path[2:] if path.startswith("A/") else path


def _bookmark_fields(bk, index):
    """``(zim, path, title, section)`` for one bookmark, with the title
    fallbacks applied. One chokepoint, because the link map and the write loop
    must agree exactly on the title — it decides the article's export path."""
    zim = (bk.get("zim") or "").strip()
    path = (bk.get("path") or "").strip()
    title = (bk.get("title") or "").strip() or path or f"Bookmark {index + 1}"
    return zim, path, title, (bk.get("section") or "").strip()


def _export_article_path(index, title):
    """Where bookmark ``index`` lives inside the export. Deterministic, so
    every article's destination is known before the first one is written."""
    return f"A/{index}_{_slug(title, str(index))}"


# How an article links back to the index, which lives at the root while every
# article lives one level down under A/ (see _export_article_path). A bare
# "index" resolves to A/index, which nothing writes — so both back-links in
# every exported article led nowhere. Defined beside the path that decides the
# depth, so the two cannot drift apart again.
_EXPORT_INDEX_HREF = "../index"


def _export_link_map(bookmarks):
    """``{(source zim, source path): in-export article path}`` covering every
    bookmark, keyed on the path as given AND on its namespace-stripped form."""
    mapping = {}
    for i, bk in enumerate(bookmarks):
        zim, path, title, _section = _bookmark_fields(bk, i)
        if not (zim and path):
            continue
        art = _export_article_path(i, title)
        mapping.setdefault((zim, path), art)
        mapping.setdefault((zim, _strip_namespace(path)), art)
    return mapping


def _unlinked_anchor(attrs, text, zim):
    """An anchor stripped of its href — the last-resort case. The text stays
    (losing a sentence's wording to a dead link would be the worse trade) and a
    title says where the article actually lives."""
    attrs = _ANCHOR_TITLE_RE.sub("", _ANCHOR_HREF_RE.sub("", attrs))
    note = f"Not in this export — this article is in the {zim} ZIM"
    return f'<a{attrs} title="{_html.escape(note, quote=True)}">{text}</a>'


def _rewrite_links(
    html, zim, article_path, export_path, link_map, url_for, carried=None
):
    """Rewrite an article's ``<a href>`` links so NONE of them dangles.

    A bookmark export carries a handful of articles out of a ZIM that holds
    millions, so most of a page's links point at articles that did not come
    along. Left alone they are broken paths: ``zimcheck -U`` fails on them and
    any reader 404s. Three cases, in order:

    1. **The target IS in this export** — another bookmarked article, or a file
       the asset carrier already pulled in (the full-size image behind a
       thumbnail). The link stays internal, repointed at the export's own copy
       with its fragment preserved.
    2. **The target is not, but its source ZIM has a known domain** — the link
       becomes that article's canonical LIVE WEB URL. It is then an honest
       external link: valid to ``zimcheck``, and it reaches the real article in
       any reader. Inside Zimi it is better than that — cross-ZIM resolution
       maps the URL straight back into the installed source ZIM, so the link
       lands on the local copy and never touches the network.
    3. **Neither** (a source ZIM whose origin Zimi never learned) — the anchor
       is unwrapped: text kept, href dropped, a title naming the ZIM that has
       the article. No URL can be invented honestly, so none is.

    Links that were already external, plus ``mailto:``/``tel:``/``data:`` and
    same-page ``#anchor`` refs, are left exactly as they were.
    """
    here = posixpath.dirname(export_path)

    def fix(m):
        attrs, text = m.group(1), m.group(2)
        hrefm = _ANCHOR_HREF_RE.search(attrs)
        if not hrefm:
            return m.group(0)
        href = hrefm.group("val")
        target = _resolve_ref(article_path, href)
        if not target:
            return m.group(0)
        fragment = "#" + href.split("#", 1)[1] if "#" in href else ""
        in_export = (
            link_map.get((zim, target))
            or link_map.get((zim, _strip_namespace(target)))
            or (carried(zim, target) if carried else None)
        )
        if in_export:
            new_href = posixpath.relpath(in_export, here) + fragment
        else:
            url = url_for(zim, target) if url_for else None
            if not url:
                return _unlinked_anchor(attrs, text, zim)
            new_href = url + fragment
        rewritten = (
            attrs[: hrefm.start()]
            + f' href="{_html.escape(new_href, quote=True)}"'
            + attrs[hrefm.end() :]
        )
        return f"<a{rewritten}>{text}</a>"

    return sub_markup(_ANCHOR_RE, fix, html)


def _extract_body(raw_html):
    """Return the inner <body> HTML of a source article, scripts/styles/links
    stripped. Falls back to the whole (stripped) document when there is no
    recognizable body wrapper (fragments, zimgit docs, etc.)."""
    stripped = _STRIP_TAGS_RE.sub("", raw_html)
    stripped = _STRIP_VOID_RE.sub("", stripped)
    m = _BODY_RE.search(stripped)
    return m.group(1) if m else stripped


_PAGE_CSS = (
    "body{font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',"
    "Roboto,Helvetica,Arial,sans-serif;max-width:44rem;margin:0 auto;"
    "padding:1.5rem;color:#111}"
    "header.zimi-src{font-size:.85rem;color:#666;border-bottom:1px solid #ddd;"
    "padding-bottom:.5rem;margin-bottom:1rem}"
    "header.zimi-src a{color:#06c}"
    "footer.zimi-nav{margin-top:2rem;padding-top:.75rem;border-top:1px solid #ddd;"
    "font-size:.85rem}"
    "ol.zimi-index{padding-left:1.25rem}ol.zimi-index li{margin:.35rem 0}"
    "h2.zimi-section{margin:1.5rem 0 .5rem;font-size:1.1rem;color:#333}"
    "img{max-width:100%;height:auto}"
)


def _page_head(title, extra_css=""):
    """Opening markup through </head>. `title` must already be escaped. The
    carried article CSS is inlined after the base page CSS so it wins."""
    css = _PAGE_CSS + (("\n" + extra_css) if extra_css else "")
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{title}</title><style>{css}</style></head>"
    )


def _article_html(title, source_zim, source_path, body, extra_css="", source_url=None):
    """Wrap a source body as a standalone export article. When the source
    article's canonical URL is known, the provenance line links to it — the
    same round trip the body's links take (live web elsewhere, back into the
    installed source ZIM inside Zimi)."""
    src = _html.escape(source_zim)
    spath = _html.escape(source_path)
    if source_url:
        spath = f'<a href="{_html.escape(source_url, quote=True)}">{spath}</a>'
    return (
        _page_head(_html.escape(title), extra_css)
        + "<body><header class='zimi-src'>From <strong>"
        + src
        + "</strong>"
        f" · <code>{spath}</code> · "
        f"<a href='{_EXPORT_INDEX_HREF}'>&#8592; Bookmarks index</a></header>"
        f"<main>{body}</main>"
        f"<footer class='zimi-nav'><a href='{_EXPORT_INDEX_HREF}'>"
        "&#8592; Back to index</a>"
        "</footer></body></html>"
    ).encode("utf-8")


def _plural(n, singular, plural=None):
    """Grammatically correct English count phrase: "1 article", "3 articles"."""
    return f"{n} {singular if n == 1 else (plural or singular + 's')}"


def _index_html(entries, date_str, heading, sections=None):
    """Build the main-entry index. `entries` is a list of
    (path, title, source_zim, section). Grouped under section headers when any
    entry carries a non-empty section. ``sections`` (optional, ordered) names
    section headers that must render even when they hold no entries — an
    exported empty folder shows up honestly instead of vanishing."""
    sections = [s.strip() for s in (sections or []) if (s or "").strip()]
    has_sections = bool(sections) or any((e[3] or "").strip() for e in entries)
    body = ""
    if not has_sections:
        items = "".join(
            f"<li><a href='{_html.escape(p)}'>{_html.escape(tt)}</a>"
            f" <span style='color:#999'>· {_html.escape(z)}</span></li>"
            for (p, tt, z, _s) in entries
        )
        body = (
            f"<ol class='zimi-index'>{items or '<li><em>No bookmarks.</em></li>'}</ol>"
        )
    else:
        # Stable section order: the caller-provided list first, then first
        # appearance among the entries; unfiled ("") last.
        order = list(sections)
        for _p, _t, _z, s in entries:
            s = (s or "").strip()
            if s not in order:
                order.append(s)
        order = [s for s in order if s != ""] + ([""] if "" in order else [])
        for sec in order:
            group = [e for e in entries if (e[3] or "").strip() == sec]
            if not group and sec not in sections:
                continue
            label = sec if sec else "General"
            items = "".join(
                f"<li><a href='{_html.escape(p)}'>{_html.escape(tt)}</a>"
                f" <span style='color:#999'>· {_html.escape(z)}</span></li>"
                for (p, tt, z, _s) in group
            )
            if not items:
                # An explicitly exported folder that held nothing — say so
                # rather than dropping the header the user asked for.
                items = "<li><em>No bookmarks in this folder.</em></li>"
            body += f"<h2 class='zimi-section'>{_html.escape(label)}</h2><ol class='zimi-index'>{items}</ol>"
    return (
        _page_head(_html.escape(heading)) + "<body>"
        f"<h1>{_html.escape(heading)}</h1><p style='color:#666'>Exported {date_str} · "
        f"{_plural(len(entries), 'article')}</p>{body}</body></html>"
    ).encode("utf-8")


# What a finished ZIM is made of, in the buckets a person thinks in. Ordered
# most-substantial first; anything unrecognised lands in "other".
_CONTENT_BUCKETS = (
    ("images", ("image/",)),
    # Video and audio are named separately: "media" made a person ask what was
    # in it (Eric: "What's media?"), and the answer is worth a word.
    ("video", ("video/",)),
    ("audio", ("audio/",)),
    ("pages", ("text/html", "application/xhtml")),
    ("fonts", ("font/", "application/font", "application/vnd.ms-font")),
    ("styles", ("text/css",)),
    ("scripts", ("javascript", "ecmascript")),
    # A capture can carry whole documents (a linked PDF, an EPUB) and plain
    # data files (JSON an app reads, an XML feed, a .txt). Both used to vanish
    # into "Other", which told nobody anything.
    ("documents", ("application/pdf", "application/epub")),
    ("data", ("application/json", "xml", "text/plain", "text/csv")),
)


def _content_bucket(mimetype):
    m = (mimetype or "").lower()
    for key, prefixes in _CONTENT_BUCKETS:
        if any(p in m if "/" not in p else m.startswith(p) for p in prefixes):
            return key
    return "other"


# Reading a ZIM's shape when the ZIM is enormous.
#
# A freshly captured page has a few hundred entries and is walked whole. English
# Wikipedia has millions, and walking it means millions of item lookups — every
# one a seek somewhere in ninety gigabytes. Nobody is going to hold a panel open
# for that, and on the spinning disks these libraries actually live on it is far
# worse than the entry count suggests.
#
# But the bar is a question about PROPORTION — "what is this made of" — and
# proportion is exactly what a sample answers. So a large ZIM is sampled.
#
# In RUNS rather than at random, and that is the important part. Entries near
# each other in id order are near each other on disk, so a hundred consecutive
# entries cost about one seek and a short read, while a hundred scattered ones
# cost a hundred seeks. Spreading a few dozen runs evenly across the id space
# keeps the sample representative of the whole file while paying for a few dozen
# seeks instead of thousands.
SHAPE_EXACT_MAX = 20_000  # at or below this, no sampling: walk it all
SHAPE_SAMPLE_ENTRIES = 6_000  # entries examined when sampling
SHAPE_SAMPLE_RUNS = 60  # spread across this many places in the file


def _sample_runs(entry_count, sample, runs):
    """The blocks to examine, as ``(start, stop)`` pairs in increasing order.

    Runs rather than individual ids because the RUN is the unit that matters
    twice over: it is one seek on disk, and it is one short hold of the libzim
    lock for a caller reading inside a live server. Everything downstream
    iterates runs for that reason."""
    runs = max(1, min(runs, sample, entry_count))
    per_run = max(1, sample // runs)
    stride = entry_count / float(runs)
    seen_to = -1
    for r in range(runs):
        start = int(r * stride)
        if start <= seen_to:
            start = seen_to + 1
        if start >= entry_count:
            return
        stop = min(start + per_run, entry_count)
        yield start, stop
        seen_to = stop - 1
        if seen_to >= entry_count - 1:
            return


def _whole_runs(entry_count, per_run=SHAPE_SAMPLE_ENTRIES // SHAPE_SAMPLE_RUNS):
    """Every entry, in runs of the same size, so an exact walk releases the
    lock as often as a sampled one does."""
    for start in range(0, entry_count, max(1, per_run)):
        yield start, min(start + max(1, per_run), entry_count)


def _split_runs(runs, size):
    """Chop runs down to at most ``size`` entries each.

    The sampler's own runs are sized for SEEKS; a caller holding a lock needs
    them sized for TIME. Splitting keeps the seek pattern identical — the pieces
    are still consecutive — while giving the lock back that much more often."""
    size = max(1, int(size))
    for start, stop in runs:
        for piece in range(start, stop, size):
            yield piece, min(piece + size, stop)


def _sample_ids(entry_count, sample, runs):
    """The sampled ids, flattened. The runs above are the real primitive; this
    is what a reader (and a test) wants when the question is coverage rather
    than seeks."""
    for start, stop in _sample_runs(entry_count, sample, runs):
        for i in range(start, stop):
            yield i


def zim_content_breakdown(
    path, exact_max=SHAPE_EXACT_MAX, guard=None, run_entries=None
):
    """What a ZIM is actually made of: total file size on disk, entry count,
    and per-bucket byte totals and counts.

    Answers the question a capture leaves open — "382 assets" says nothing about
    whether that is mostly pictures or mostly fonts, and a number with no shape
    is not information. Eric asked for the same bar on every ZIM in the library,
    not just the ones made here, which is what the sampling above is for.

    A sampled answer says so: `sampled` is True and the per-bucket figures are
    scaled estimates. Estimates presented as measurements is the failure mode
    this whole release has been about, so the flag is not optional decoration —
    the panel prints it.

    ``guard`` is a callable returning a context manager, entered around each RUN
    of entries and left between them, and ``run_entries`` is how many entries a
    run holds it for. A caller inside a live server passes both: the libzim lock
    and a run short enough that a reader who arrives mid-file waits for a couple
    of dozen entries rather than for the file. Callers with the file to
    themselves — a capture that has just written it — pass neither.

    The run size is the caller's because only the caller knows the disk. Twenty-
    five entries is nothing on an SSD and most of a second on the spinning disk
    a 220 GB library lives on, and this function cannot tell which it is on.

    Best effort throughout: a ZIM that will not open returns None rather than
    failing whatever is reporting."""
    try:
        from libzim.reader import Archive
    except ImportError:
        return None
    try:
        archive = Archive(path)
    except Exception as e:
        log.debug("could not open %s for a content breakdown: %s", path, e)
        return None
    try:
        entry_count = int(archive.entry_count)
    except Exception:
        return None
    sampled = entry_count > max(0, exact_max)
    runs = (
        _sample_runs(entry_count, SHAPE_SAMPLE_ENTRIES, SHAPE_SAMPLE_RUNS)
        if sampled
        else _whole_runs(entry_count)
    )
    if run_entries:
        runs = _split_runs(runs, int(run_entries))
    sizes, counts = {}, {}
    entries = 0
    examined = 0
    try:
        for start, stop in runs:
            with guard() if guard else contextlib.nullcontext():
                for i in range(start, stop):
                    examined += 1
                    try:
                        entry = archive._get_entry_by_id(i)
                        if entry.is_redirect:
                            continue
                        item = entry.get_item()
                    except Exception:
                        continue
                    bucket = _content_bucket(item.mimetype)
                    sizes[bucket] = sizes.get(bucket, 0) + int(item.size or 0)
                    counts[bucket] = counts.get(bucket, 0) + 1
                    entries += 1
    except Exception as e:
        log.debug("content breakdown of %s stopped early: %s", path, e)
    # Scale a sample up to the whole file. Redirects are deliberately in the
    # denominator: they are entries that were looked at and contributed nothing,
    # so counting them keeps the ratio honest about how much of the file the
    # sample stood for.
    scale = (float(entry_count) / examined) if (sampled and examined) else 1.0
    if sampled:
        sizes = {k: int(v * scale) for k, v in sizes.items()}
        counts = {k: int(round(v * scale)) for k, v in counts.items()}
        entries = int(round(entries * scale))
    try:
        total = os.path.getsize(path)
    except OSError:
        total = 0
    order = [k for k, _p in _CONTENT_BUCKETS] + ["other"]
    shape = {
        "file_bytes": total,
        "entries": entries,
        "breakdown": [
            {"key": k, "size_bytes": sizes[k], "count": counts[k]}
            for k in order
            if sizes.get(k)
        ],
    }
    if sampled:
        shape["sampled"] = True
        shape["sampled_entries"] = examined
        shape["total_entries"] = entry_count
    return shape


def _output_path(zim_dir, base):
    """A non-clobbering output path: <base>.zim, then <base>-2.zim, …"""
    candidate = os.path.join(zim_dir, base + ".zim")
    n = 2
    while os.path.exists(candidate):
        candidate = os.path.join(zim_dir, f"{base}-{n}.zim")
        n += 1
    return candidate


# Writer plumbing shared with zimi.creator (folder/page → ZIM). libzim.writer
# is imported lazily so this module still imports where the writer is absent
# (the read-only install case) — the class pair is built once and cached.
_static_item_cls = None


def zim_static_item_class():
    """The one Item class every Zimi-written ZIM entry uses: full content in
    memory, mimetype and FRONT_ARTICLE hint per entry."""
    global _static_item_cls
    if _static_item_cls is not None:
        return _static_item_cls
    from libzim.writer import Blob, ContentProvider, Hint, Item

    class _Provider(ContentProvider):
        def __init__(self, content):
            super().__init__()
            self._content = content
            self._fed = False

        def get_size(self):
            return len(self._content)

        def feed(self):
            if self._fed:
                return Blob(b"")
            self._fed = True
            return Blob(self._content)

    class _StaticItem(Item):
        def __init__(self, path, title, content, mimetype=_HTML_MIME, front=True):
            super().__init__()
            self._path = path
            self._title = title
            self._content = content
            self._mimetype = mimetype
            self._front = front

        def get_path(self):
            return self._path

        def get_title(self):
            return self._title

        def get_mimetype(self):
            return self._mimetype

        def get_contentprovider(self):
            return _Provider(self._content)

        def get_hints(self):
            # libzim types hint values as int, not bool — a True here is a
            # type error against the base Item even though it runs fine.
            return {Hint.FRONT_ARTICLE: 1} if self._front else {}

    _static_item_cls = _StaticItem
    return _StaticItem


def make_asset_item(path, mimetype, data):
    """A non-front entry (image, CSS, font) — the shape _AssetCarrier feeds."""
    cls = zim_static_item_class()
    return cls(path, path.rsplit("/", 1)[-1], data, mimetype=mimetype, front=False)


@contextlib.contextmanager
def atomic_zim_creator(out_path, language="eng"):
    """Yield a libzim Creator writing to ``<out_path>.tmp``; rename over
    ``out_path`` only on clean exit, remove the tmp on any error. A partially
    written ZIM must never appear under its final name — libzim#1106 upstream
    is exactly the bug where half-written files got picked up as valid."""
    from libzim.writer import Creator

    tmp_path = out_path + ".tmp"
    try:
        # Creator takes a Path; tmp_path stays a str for os.replace below.
        with Creator(pathlib.Path(tmp_path)).config_indexing(True, language) as creator:
            yield creator
        os.replace(tmp_path, out_path)
    except Exception:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        raise


# ── provenance ──────────────────────────────────────────────────────────────
#
# Every ZIM Zimi writes carries its own paper trail IN METADATA, so the record
# travels with the file to any reader, any peer, any sneakernet copy:
#
#   Scraper         the formal openZIM field readers display: "Zimi <version>",
#                   plus the engine that did the work when one ran
#                   ("Zimi 1.9.0-dev + yt-dlp 2026.07.04").
#   Source          the standard field, kept to its openZIM meaning — a URL.
#                   Written only when the source actually IS one.
#   X-Zimi-Source   the uniform field: URL, folder name, archive name, playlist
#                   — whatever the content came from, written whenever known.
#   X-Zimi-History  a JSON array of records. Creation writes the first one;
#                   every later edit appends, so a ZIM's whole life is legible
#                   from the file alone.
#
# PRIVACY (hard rule): none of this may carry a full local path, a hostname, a
# username, or an environment value. ZIMs get shared; the paper trail must
# never leak the machine that made them. `source_label` reduces anything that
# is not a URL to its basename, and every source value goes through it.

SCRAPER_METADATA_KEY = "Scraper"
SOURCE_METADATA_KEY = "X-Zimi-Source"
HISTORY_METADATA_KEY = "X-Zimi-History"

# ── openZIM conformance ─────────────────────────────────────────────────────
#
# The spec's own enforcement tables are the authority, not prose: zim-tools'
# reservedMetadataInfoTable (src/metadata_constraints.cpp, what `zimcheck -M`
# actually applies) and python-scraperlib's zimscraperlib/zim/metadata.py.
# What they require of every ZIM:
#
#   Name                  MANDATORY. The identifier that stays STABLE across
#                         editions of the same source — how a library knows
#                         today's capture is a newer copy of last month's
#                         rather than a second unrelated file. So it is
#                         derived from the SOURCE, never from the date or a
#                         title the user may retype.
#   Title                 MANDATORY, 1–30 characters.
#   Language              MANDATORY, ISO 639-3, ^\w{3}(,\w{3})*$.
#   Creator, Publisher    MANDATORY, non-empty.
#   Date                  MANDATORY, exactly YYYY-MM-DD.
#   Description           MANDATORY, 1–80 characters.
#   Illustration_48x48@1  MANDATORY, a real 48x48 PNG.
#   LongDescription       optional, ≤4000, and never SHORTER than Description.
#   Tags/Flavour/Source/License/Relation/Scraper: optional.
#   Counter               written by libzim itself — a scraper must not.
#
# Titles and descriptions are shortened HERE and only here: the ZIM's own
# index page keeps the full heading, so the cap costs a metadata field its
# tail rather than costing the content its name.

# Bare, with no charset suffix: libzim folds entry mimetypes verbatim into the
# Counter metadata, whose spec regex admits neither ";" nor "=", so a
# "text/html;charset=utf-8" entry makes the whole ZIM fail `zimcheck -M`. Every
# page Zimi generates declares its own <meta charset>, which is where the rest
# of the ZIM world puts it too.
_HTML_MIME = "text/html"

MAX_TITLE_LENGTH = 30
MAX_DESCRIPTION_LENGTH = 80
MAX_LONG_DESCRIPTION_LENGTH = 4000
ILLUSTRATION_SIZE = 48

# Tags use the spec's semicolon convention. Only the two that a reader really
# consumes are written by default: `_category:` groups a ZIM in a library, and
# `_ftindex:yes` is true of every ZIM Zimi writes because `atomic_zim_creator`
# always turns on full-text indexing. The `_pictures:`/`_videos:`/`_details:`
# trio describes flavour VARIANTS of one source (Kiwix's maxi/nopic/mini), so
# it is written only where an engine actually knows the answer.
DEFAULT_TAGS = ("_category:other", "_ftindex:yes")

_LANGUAGE_RE = re.compile(r"^[a-z]{3}(,[a-z]{3})*$")

# Bounded so a heavily edited ZIM cannot grow an unbounded metadata entry. The
# overflow is collapsed into one honest marker record, never dropped silently.
MAX_HISTORY_RECORDS = 100
TRUNCATED_OP = "truncated"


def _is_url(value):
    return str(value or "").lower().startswith(("http://", "https://"))


def source_label(value):
    """A SHAREABLE source label: URLs verbatim, anything else reduced to its
    last path segment. This is the privacy chokepoint — a caller that hands
    over a full local path still only ever gets its basename into the file."""
    text = str(value or "").strip()
    if not text or _is_url(text):
        return text
    return text.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]


def fit_text(text, limit):
    """``text`` collapsed to one line and shortened to ``limit`` characters,
    cut on a word boundary with an ellipsis whenever anything was dropped. The
    spec's length caps are hard, so something has to give; a visible ellipsis
    is the honest way to say "there was more"."""
    text = " ".join(str(text or "").split())
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rstrip()
    space = cut.rfind(" ")
    if space >= limit // 2:
        cut = cut[:space].rstrip()
    return cut + "…"


def normalize_language(value):
    """A spec-legal ``Language``: lowercase ISO 639-3, comma-joined, no spaces.
    Two-letter codes are widely typed and just as widely wrong here, so the
    well-known ones are translated (reusing the table the reader already
    keeps) rather than written out of spec. Raises ValueError on anything that
    cannot be resolved — a bad language code is a fixable mistake, and a ZIM
    that lies about its language is not."""
    two_to_three = {v: k for k, v in _srv._ISO639_3_TO_1.items()}
    codes = []
    for part in str(value or "").lower().replace(";", ",").split(","):
        code = re.sub(r"[^a-z]", "", part)
        if not code:
            continue
        code = two_to_three.get(code, code) if len(code) == 2 else code
        if len(code) != 3:
            raise ValueError(
                f"not an ISO 639-3 language code: {part.strip()!r} "
                "(the ZIM spec wants three letters, e.g. eng, fra, spa)"
            )
        if code not in codes:
            codes.append(code)
    joined = ",".join(codes) or "eng"
    if not _LANGUAGE_RE.match(joined):
        raise ValueError(f"not an ISO 639-3 language code: {value!r}")
    return joined


def zim_name(scope, language="eng"):
    """The ``Name`` metadata: ``zimi_<language>_<scope>``, following the
    ``creator_lang_scope`` convention Kiwix libraries key on. ``scope`` must
    identify the SOURCE — a URL, a hostname, a folder name — so that
    recapturing it next month produces the same Name and a library treats the
    result as a new edition rather than an unrelated file.

    A URL keeps host, path AND query, because ``/blog/post.html`` on two
    different sites (or two playlists on one host) must never collapse into
    one identity. Anything else goes through ``source_label``, so a caller
    that hands over a local path still cannot put one in the file."""
    text = str(scope or "").strip()
    if _is_url(text):
        parts = urllib.parse.urlsplit(text)
        text = " ".join(p for p in (parts.netloc, parts.path, parts.query) if p)
    else:
        text = source_label(text)
    lang = normalize_language(language).split(",")[0]
    return f"zimi_{lang}_{_slug(text, 'zim')}"


def tags_string(extra=()):
    """The ``Tags`` value: the defaults every Zimi ZIM can honestly claim,
    plus whatever the engine knows, deduped and semicolon-joined."""
    tags = []
    for tag in list(DEFAULT_TAGS) + list(extra or ()):
        tag = str(tag).strip()
        if tag and tag not in tags:
            tags.append(tag)
    return ";".join(tags)


def media_tags(mimetypes):
    """``_pictures:``/``_videos:`` for a set of mimetypes actually written into
    the ZIM. Only claims what was seen — an engine that does not track its
    mimetypes passes nothing and the tags are simply absent."""
    kinds = {str(m).split("/", 1)[0].lower() for m in mimetypes if m}
    return [
        f"_pictures:{'yes' if 'image' in kinds else 'no'}",
        f"_videos:{'yes' if 'video' in kinds else 'no'}",
    ]


def _png(rows, width, height):
    """A minimal 8-bit RGB PNG. Written by hand because the illustration is
    MANDATORY metadata and Zimi must produce one on a machine with no image
    library at all — zlib and struct are always there."""
    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    def chunk(tag, data):
        body = tag + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def default_illustration(seed, size=ILLUSTRATION_SIZE):
    """A 48x48 identicon PNG derived from ``seed`` (the ZIM's Name): a
    mirrored 5x5 block pattern in a colour picked from the seed's hash. The
    same source always yields the same icon, and two different ZIMs almost
    never collide — which is the whole job of a shelf icon."""
    digest = hashlib.sha256(str(seed).encode("utf-8")).digest()
    hue = digest[0] / 255.0
    r, g, b = colorsys.hsv_to_rgb(hue, 0.62, 0.96)
    fg = (int(r * 255), int(g * 255), int(b * 255))
    bg = (20, 20, 22)  # the app's own surface tone, so tiles sit on the shelf
    cells, margin = 5, 4
    step = (size - 2 * margin) // cells
    on = set()
    for col in range(3):  # left half plus the middle column, then mirrored
        for row in range(cells):
            if digest[1 + col * cells + row] & 1:
                on.add((col, row))
                on.add((cells - 1 - col, row))
    rows = []
    for y in range(size):
        row = bytearray()
        cell_y = (y - margin) // step if margin <= y < margin + cells * step else -1
        for x in range(size):
            cell_x = (x - margin) // step if margin <= x < margin + cells * step else -1
            paint = fg if (cell_x, cell_y) in on else bg
            row += bytes(paint)
        rows.append(row)
    return _png(rows, size, size)


def has_image_support():
    """Whether Pillow is importable. It is a soft dependency — the only way to
    rescale an arbitrary favicon into the 48x48 the spec demands — so callers
    check before spending network on an icon they could not use anyway."""
    try:
        import PIL.Image  # noqa: F401
    except ImportError:
        return False
    return True


def illustration_from_image(data, size=ILLUSTRATION_SIZE):
    """``data`` (a favicon, any format) re-encoded as a ``size``x``size`` PNG,
    or None. Needs Pillow, which Zimi does not depend on — without it there is
    no honest way to rescale an arbitrary image, so the caller falls back to a
    generated icon rather than shipping a wrong-sized one."""
    if not data:
        return None
    try:
        from PIL import Image
    except ImportError:
        return None
    # Pillow moved the filter constants under Image.Resampling in 9.1 and kept
    # the old aliases; Zimi does not pin Pillow, so ask for whichever is there.
    resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
    try:
        with Image.open(io.BytesIO(data)) as img:
            square = img.convert("RGBA").resize((size, size), resample)
            flat = Image.new("RGBA", (size, size), (20, 20, 22, 255))
            flat.alpha_composite(square)
            buf = io.BytesIO()
            flat.convert("RGB").save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:  # a favicon is decoration; never fail a build for it
        log.debug("favicon could not be used as an illustration: %s", e)
        return None


def scraper_string(tool=None, version=None):
    """The formal Scraper value: Zimi, plus the engine that did the work when
    one did ("Zimi 1.9.0-dev + yt-dlp 2026.07.04")."""
    base = f"Zimi {_srv.ZIMI_VERSION}"
    if not tool:
        return base
    return f"{base} + {tool} {version}" if version else f"{base} + {tool}"


def history_record(op, mode, detail, *, tools=None, counts=None, blocked=None, ts=None):
    """One provenance record. ``op`` is what happened ("created"), ``mode`` how
    ("folder", "page", "site", "video", "import", "bookmarks"), ``detail`` one
    human sentence. ``tools`` names the outside engine and version when one ran;
    ``counts`` carries whichever of pages/assets/videos/bytes are known;
    ``blocked`` is what a capture REFUSED, when it refused anything — see
    ``zimi.blocklist.blocked_record`` for its shape. Keys with nothing to say
    are left out rather than written empty.

    ``blocked`` is a nested object rather than two more ``counts`` entries
    because it is not only counts: it names the published list and the snapshot
    date they came from, and those belong beside the numbers they explain
    rather than scattered across a flat map of integers. Readers of this schema
    tolerate fields they do not know, which is what makes adding one safe."""
    record = {
        "ts": int(ts if ts is not None else time.time()),
        "zimi": _srv.ZIMI_VERSION,
        "op": op,
        "mode": mode,
        "detail": str(detail),
    }
    named_tools = {k: str(v) for k, v in (tools or {}).items() if v}
    if named_tools:
        record["tools"] = named_tools
    known_counts = {k: int(v) for k, v in (counts or {}).items() if v is not None}
    if known_counts:
        record["counts"] = known_counts
    if blocked:
        record["blocked"] = dict(blocked)
    return record


def parse_history(raw):
    """The records in an ``X-Zimi-History`` value — ``[]`` for anything that
    isn't a JSON array of objects. A ZIM made elsewhere, or one with a mangled
    entry, reads as "no history", never as an error."""
    if isinstance(raw, (bytes, bytearray, memoryview)):
        raw = bytes(raw).decode("utf-8", "replace")
    try:
        records = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(records, list):
        return []
    return [r for r in records if isinstance(r, dict)]


def append_history(records, record, limit=MAX_HISTORY_RECORDS):
    """``records`` plus ``record``, bounded. Overflow collapses into a single
    leading marker naming how many records it stands for — the history shrinks
    visibly instead of losing its beginning in silence."""
    out = list(records) + [record]
    if len(out) <= limit:
        return out
    dropped = 0
    if out and out[0].get("op") == TRUNCATED_OP:
        dropped = int((out[0].get("counts") or {}).get("records") or 0)
        out = out[1:]
    keep = out[-(limit - 1) :] if limit > 1 else []
    dropped += len(out) - len(keep)
    marker = history_record(
        TRUNCATED_OP,
        "history",
        f"{_plural(dropped, 'earlier record')} collapsed to keep this history bounded",
        counts={"records": dropped},
    )
    return [marker] + keep


def add_standard_metadata(
    creator,
    *,
    title,
    description,
    language="eng",
    creator_name="Zimi",
    source=None,
    date_str=None,
    scraper=None,
    history=None,
    name=None,
    tags=(),
    illustration=None,
    flavour=None,
    long_description=None,
    license=None,
    relation=None,
):
    """The full openZIM metadata block — every mandatory key, conforming — plus
    the Zimi provenance block. One chokepoint, so no engine can forget a key.

    ``name`` is the stable cross-edition identifier (see ``zim_name``); it
    falls back to one derived from the title, but an engine that knows its
    source should always pass its own. ``title`` and ``description`` are
    shortened to the spec's caps here; when the description does not fit, the
    full text is kept as ``LongDescription`` rather than lost. ``tags`` are
    extras folded in beside the defaults. ``illustration`` is PNG bytes for
    the mandatory 48x48 icon — omit it and a generated identicon is used.
    ``license`` and ``relation`` are written only when the caller actually
    knows them; nothing here invents a licence claim.

    ``source`` is where the content came from. A URL is written to BOTH the
    standard ``Source`` field (whose openZIM meaning is a URL) and
    ``X-Zimi-Source``; anything else is reduced to its basename and written to
    ``X-Zimi-Source`` alone, so the standard field keeps its meaning while the
    Zimi field stays uniform across every creation mode. ``scraper`` defaults
    to ``scraper_string()``; an engine that did the work passes an enriched
    one. ``history`` is one record from ``history_record`` (or a list of them),
    written as the ``X-Zimi-History`` array that later edits append to."""
    language = normalize_language(language)
    short_title = fit_text(title, MAX_TITLE_LENGTH)
    full_description = " ".join(str(description or "").split())
    short_description = fit_text(full_description, MAX_DESCRIPTION_LENGTH)
    long_text = fit_text(
        long_description or full_description, MAX_LONG_DESCRIPTION_LENGTH
    )

    creator.add_metadata("Name", name or zim_name(title, language))
    creator.add_metadata("Title", short_title)
    creator.add_metadata("Language", language)
    creator.add_metadata("Description", short_description)
    # The spec forbids a LongDescription shorter than the Description, so it
    # ships only when it genuinely says more than the short one already did.
    if len(long_text) > len(short_description):
        creator.add_metadata("LongDescription", long_text)
    creator.add_metadata("Creator", creator_name)
    creator.add_metadata("Publisher", "Zimi")
    creator.add_metadata("Date", date_str or datetime.date.today().isoformat())
    creator.add_metadata("Tags", tags_string(tags))
    if flavour:
        creator.add_metadata("Flavour", str(flavour))
    if license:
        creator.add_metadata("License", str(license))
    if relation:
        creator.add_metadata("Relation", str(relation))
    creator.add_illustration(
        ILLUSTRATION_SIZE,
        illustration or default_illustration(name or zim_name(title, language)),
    )
    creator.add_metadata(SCRAPER_METADATA_KEY, scraper or scraper_string())
    if _is_url(source):
        creator.add_metadata("Source", str(source))
    label = source_label(source)
    if label:
        creator.add_metadata(SOURCE_METADATA_KEY, label)
    if history:
        records = [history] if isinstance(history, dict) else list(history)
        creator.add_metadata(
            HISTORY_METADATA_KEY, json.dumps(records, separators=(",", ":"))
        )


def build_bookmarks_zim(
    bookmarks,
    zim_dir,
    reader=_read_source_article,
    asset_reader=_read_source_item,
    url_for=_source_url,
    progress=None,
    name=None,
    title=None,
    sections=None,
):
    """Write ONE ZIM containing an article per bookmark plus an index page.

    ``bookmarks`` is a list of ``{"zim","path","title"[,"section"]}`` dicts.
    ``reader(zim, path)`` fetches source HTML; ``asset_reader(zim, path)``
    fetches raw asset bytes; ``url_for(zim, path)`` gives a source article's
    canonical web URL (all three injectable for tests). Every ``<a href>`` in
    the carried bodies is rewritten so none of them dangles — see
    ``_rewrite_links`` for the three cases. ``progress(done, total)``
    is called per article. ``name`` sets the output basename (default
    ``zimi-bookmarks_<date>``); ``title`` sets the ZIM Title metadata.
    ``sections`` (optional, ordered) lists section headers the index must show
    even when empty — exported empty folders are never silently dropped.
    Returns the output file path. Raises ValueError when ``bookmarks`` is empty.
    """
    if not bookmarks:
        raise ValueError("no bookmarks to export")

    _Article = zim_static_item_class()

    date_str = datetime.date.today().isoformat()
    base = name or f"zimi-bookmarks_{date_str}"
    heading = title or f"Zimi Bookmarks · {date_str}"
    out_path = _output_path(zim_dir, base)
    total = len(bookmarks)
    entries = []  # (path, title, source_zim, section) for the index
    # Every article's destination, known up front: a link may point forward to
    # a bookmark this loop has not written yet.
    link_map = _export_link_map(bookmarks)

    with atomic_zim_creator(out_path) as creator:
        creator.set_mainpath("index")
        carrier = _AssetCarrier(creator.add_item, make_asset_item, asset_reader)
        for i, bk in enumerate(bookmarks):
            if progress:
                progress(i, total)
            zim, path, title_i, section = _bookmark_fields(bk, i)
            art_path = _export_article_path(i, title_i)
            raw = reader(zim, path) if (zim and path) else None
            extra_css = ""
            if raw is None:
                body = (
                    "<p><em>The source article could not be read "
                    "(the ZIM may have been removed).</em></p>"
                )
            else:
                # Carry styling + images BEFORE stripping the raw document.
                try:
                    extra_css = carrier.collect_styles(zim, path, raw)
                    raw = carrier.rewrite_media(zim, path, raw)
                except Exception as e:  # never let one bad article kill the export
                    log.debug("asset carry failed for %s/%s: %s", zim, path, e)
                raw = _rewrite_links(
                    raw,
                    zim,
                    path,
                    art_path,
                    link_map,
                    url_for,
                    carried=carrier.carried_path,
                )
                body = _extract_body(raw)
            creator.add_item(
                _Article(
                    art_path,
                    title_i,
                    _article_html(
                        title_i,
                        zim,
                        path,
                        body,
                        extra_css,
                        source_url=(
                            url_for(zim, path) if (url_for and zim and path) else None
                        ),
                    ),
                )
            )
            entries.append((art_path, title_i, zim, section))
        if progress:
            # Every article is in. What remains is the Creator's close
            # (full-text index build + cluster compression), the longest
            # single phase for a large export, so report N/N now instead
            # of freezing the client's counter at N-1/N while it runs.
            progress(total, total)
        creator.add_item(
            _Article(
                "index",
                heading,
                _index_html(entries, date_str, heading, sections=sections),
            )
        )
        add_standard_metadata(
            creator,
            title=heading,
            description=f"{_plural(len(entries), 'bookmarked article')} exported by Zimi",
            date_str=date_str,
            # The Name must survive re-exporting the same selection tomorrow,
            # so it drops the date the filename carries.
            name=zim_name(
                re.sub(r"^zimi[-_]|[_-]?\d{4}-\d{2}-\d{2}$", "", base) or "bookmarks"
            ),
            tags=media_tags(carrier.mimetypes),
            history=history_record(
                "created",
                "bookmarks",
                f"exported {_plural(len(entries), 'bookmarked article')} "
                "from the library",
                counts={"pages": len(entries)},
            ),
        )
    if progress:
        progress(total, total)
    return out_path


def build_export_jobs(jobs, zim_dir, progress=None, **kw):
    """Build one ZIM per job. ``jobs`` is a list of
    ``{"name","title","bookmarks":[...]}``. Progress is aggregated across all
    jobs' articles. Returns the list of written file paths."""
    grand_total = sum(len(j.get("bookmarks") or []) for j in jobs) or 1
    done_before = [0]
    out_paths = []

    def _agg(done, total, base=done_before):
        if progress:
            progress(min(base[0] + done, grand_total), grand_total)

    for job in jobs:
        bms = job.get("bookmarks") or []
        if not bms:
            continue
        out = build_bookmarks_zim(
            bms,
            zim_dir,
            progress=_agg,
            name=job.get("name"),
            title=job.get("title"),
            sections=job.get("sections"),
            **kw,
        )
        out_paths.append(out)
        done_before[0] += len(bms)
    if progress:
        progress(grand_total, grand_total)
    return out_paths


def _register_exports(out_paths):
    """Make the just-written export ZIMs visible in the library.

    The old shape here — ``load_cache(force=True)`` under ``_zim_lock`` — re-
    opened and re-scanned EVERY archive in the library while holding the lock
    that every libzim request needs. Exporting three bookmarks off a 53-ZIM
    library on a NAS mount therefore froze every reader for as long as the
    rescan took. ``register_zim_file`` extracts each new ZIM's metadata off the
    lock and holds it only for the splice; the full rescan survives as the
    fallback for a file that cannot be read incrementally.
    """
    needs_rescan = False
    for path in out_paths:
        try:
            if not _srv.register_zim_file(path):
                needs_rescan = True
        except Exception as e:
            log.warning(
                "Incremental registration of %s failed (%s) — falling back to a "
                "full library rescan",
                os.path.basename(path),
                e,
            )
            needs_rescan = True
    if needs_rescan:
        with _srv._zim_lock:
            _srv.load_cache(force=True)
    # Cached result sets predate the new ZIM and would hide it until their TTL.
    _srv._search_cache_clear()
    _srv._suggest_cache_clear()


def start_export(payload):
    """Kick off a bookmark export on a daemon worker thread.

    ``payload`` is either a flat list of bookmark dicts (v1 — one ZIM) or a
    list of job dicts ``{"name","title","bookmarks":[...]}`` (v2 — one ZIM
    each). Returns ``(started, message)``; ``started`` is False when one is
    already running or there is nothing to export."""
    jobs = _normalize_jobs(payload)
    if not jobs:
        return False, "no bookmarks"
    if not _export_lock.acquire(blocking=False):
        return False, "an export is already running"
    total = sum(len(j["bookmarks"]) for j in jobs)
    _set_export_state(
        phase="running", done=0, total=total, file=None, files=[], count=0, error=None
    )

    def _run():
        try:

            def _prog(done, total):
                _set_export_state(done=done, total=total)

            # Exports land on the Created shelf beside web creations — both
            # are made-here artifacts, and an export filed under Other while
            # a capture filed under Created read as two rules where the
            # person sees one act (Eric: "fix that").
            _made_here = os.path.join(_srv.ZIM_DIR, "created")
            os.makedirs(_made_here, exist_ok=True)
            out_paths = build_export_jobs(jobs, _made_here, progress=_prog)
            _register_exports(out_paths)
            names = [os.path.basename(p) for p in out_paths]
            _set_export_state(
                phase="done",
                file=(names[-1] if names else None),
                files=names,
                count=total,
            )
        except Exception as e:
            log.error("bookmark export failed: %s", e)
            _set_export_state(phase="error", error="export failed")
        finally:
            _export_lock.release()

    threading.Thread(target=_run, daemon=True, name="bookmark-export").start()
    return True, "started"


def _normalize_jobs(payload):
    """Accept a flat bookmark list OR a list of job dicts; return clean jobs."""
    if not isinstance(payload, list) or not payload:
        return []
    # A job dict has a "bookmarks" list; a bookmark dict has "zim"/"path".
    if isinstance(payload[0], dict) and "bookmarks" in payload[0]:
        jobs = []
        for j in payload:
            if not isinstance(j, dict):
                continue
            bms = [b for b in (j.get("bookmarks") or []) if isinstance(b, dict)]
            if bms:
                jobs.append(
                    {
                        "name": j.get("name") or None,
                        "title": j.get("title") or None,
                        "sections": [
                            s for s in (j.get("sections") or []) if isinstance(s, str)
                        ],
                        "bookmarks": bms,
                    }
                )
        return jobs
    return [
        {
            "name": None,
            "title": None,
            "bookmarks": [b for b in payload if isinstance(b, dict)],
        }
    ]
