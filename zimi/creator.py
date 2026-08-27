"""Create ZIMs from your own content — `zimi create <folder>` and
`zimi create <url>`.

Folder mode packages a directory of HTML, Markdown, and PDF files (plus
whatever assets sit beside them) into one ZIM: the folder hierarchy becomes
the ZIM paths, so relative links between files keep working unmodified.
Markdown renders through a small internal converter (no new dependency);
HTML and everything else pass through as-is, PDFs included — the reader
already serves them. The main page is the folder's own ``index.html`` or
``README`` when present, else a generated content-tree index.

Page mode fetches ONE page over HTTP(S) and packages it with its same-origin
assets — images, stylesheets (and the fonts/images those pull), inline-style
backgrounds — by pointing the bookmark exporter's ``_AssetCarrier`` at HTTP
instead of at a source ZIM. No crawling, no JavaScript execution: a page
that is an empty script shell is refused with a pointer at browser-based
capture (zimit) instead of producing a ZIM full of loading spinners.

``render_captured_page`` is that per-page pipeline on its own — fetch-time
rewriting of assets, links, and scripts against one carrier — so the bounded
site crawl in ``zimi.crawler`` runs the identical steps per page and differs
only in how a link is resolved: to a sibling article when the crawl captured
the target, to the live web when it did not.

All modes share the writer plumbing in ``zimwriter``: the lazy item classes,
``atomic_zim_creator`` (tmp-then-replace — a partial ZIM never appears under
its final name), ``add_standard_metadata``, and ``_register_exports`` so a
ZIM written into the library directory shows up without a full rescan.
"""

import base64
import hashlib
import html as _html
import logging
import mimetypes
import os
import pathlib
import posixpath
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import zimi.server as _srv
from zimi.blocklist import blocked_phrase
from zimi.zimwriter import (
    _CSS_URL_RE,
    _HREF_RE,
    _REL_RE,
    _STYLESHEET_RE,
    _AssetCarrier,
    _output_path,
    _page_head,
    _plural,
    _register_exports,
    _resolve_ref,
    _slug,
    add_standard_metadata,
    attr_quote,
    attr_re,
    atomic_zim_creator,
    has_image_support,
    history_record,
    illustration_from_image,
    make_asset_item,
    media_tags,
    normalize_language,
    zim_name,
    zim_static_item_class,
)

log = logging.getLogger("zimi.creator")


class CreateError(Exception):
    """A user-facing creation failure — the message is printed verbatim."""


# ── size discipline (Pi-class hardware serves these libraries) ──────────────
# Raw files stream into the ZIM via FileProvider and never load into memory,
# so the per-file cap is about output sanity, not RAM. Text sources (HTML,
# Markdown) DO load — they get rendered/retitled — hence the far smaller cap.
MAX_SOURCE_FILE_BYTES = 1024**3  # 1 GiB per raw file
MAX_TOTAL_SOURCE_BYTES = 8 * 1024**3  # 8 GiB per ZIM
MAX_TEXT_SOURCE_BYTES = 16 * 1024**2  # 16 MiB per HTML/Markdown file
MAX_PAGE_FETCH_BYTES = 10 * 1024**2  # 10 MiB fetched page document
MAX_FAVICON_BYTES = 512 * 1024  # a site icon; anything larger is not one
DEFAULT_FETCH_TIMEOUT = 30.0
# Best icon first. apple-touch-icon is a large clean PNG where it exists,
# which downscales to 48px far better than a 16px .ico does. These are the
# blind-probe fallback — the icon a page actually DECLARES (below) is tried
# first, since a modern site versions its icon or serves it from a CDN and a
# bare /favicon.ico is often stale or a placeholder (Eric: CNN's Fast capture
# got "the wrong favicon").
_FAVICON_CANDIDATES = ("apple-touch-icon.png", "favicon.png", "favicon.ico")
# <link rel="…icon…" href="…"> parsing: the tag, then rel/href in any order,
# quoted or bare -- which the shared attr_re has handled since it became the
# one place that knows how an HTML attribute is spelled. These two were the
# only pair in the tree that got it right; keeping their hand-rolled version
# would leave two ways to read an attribute and invite the drift back.
_ICON_LINK_RE = re.compile(r"<link\b[^>]*>", re.IGNORECASE)
_LINK_REL_RE = _REL_RE
_LINK_HREF_RE = _HREF_RE
DEFAULT_MAX_REDIRECTS = 5
# An SPA shell has scripts and (nearly) no server-rendered text. The
# threshold is deliberately low: real articles clear it by an order of
# magnitude, and a false "SPA" verdict on a tiny page is a clear error
# message, not a broken ZIM.
SPA_MIN_TEXT_CHARS = 200
# One refusal message for both capture modes. A site crawl runs the check on
# its FIRST page and refuses the whole crawl there — spending an hour to
# produce two hundred loading spinners is the worst possible outcome.
SPA_REFUSAL = (
    "this page is an empty application shell — its content is built "
    "by JavaScript in the browser, and the fast engine does not run one. "
    "Capture it with the rendered engine instead (the Rendered toggle on the "
    "Create page, or --engine rendered), which drives a real browser and keeps "
    "what it draws. For a fully interactive archive, zimit "
    "(https://github.com/openzim/zimit) writes a ZIM you can add to your "
    "library."
)
# The language a capture asks for when it wants the DOCUMENT to decide. The
# fallback is only ever reached when nothing on the page says anything.
LANGUAGE_AUTO = "auto"
DEFAULT_LANGUAGE = "eng"
# How many URLs one multi-page capture may merge. The cap is about the artifact,
# not about the machine: past this the generated index stops being a page anyone
# reads and becomes a list nobody does. A bigger set is a site crawl.
MAX_PAGE_URLS = 20

_MD_EXTS = {".md", ".markdown"}
_HTML_EXTS = {".html", ".htm"}
_JUNK_NAMES = {"thumbs.db", "desktop.ini", "__pycache__"}
# A BARE mimetype, deliberately: libzim aggregates entry mimetypes verbatim
# into the Counter metadata, whose spec regex admits no ";" or "=" — a
# "text/html;charset=utf-8" entry makes every ZIM fail `zimcheck -M`. The
# charset lives where every other scraper puts it, in the document's own
# <meta charset> (see _normalize_charset).
_HTML_MIME = "text/html"

_TITLE_TAG_RE = re.compile(r"<title[^>]*>(.*?)</title\s*>", re.IGNORECASE | re.DOTALL)
_H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1\s*>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_RE = re.compile(r"<script\b[^>]*>.*?</script\s*>", re.IGNORECASE | re.DOTALL)
_SCRIPT_VOID_RE = re.compile(r"<script\b[^>]*/\s*>", re.IGNORECASE)
_NOSCRIPT_RE = re.compile(
    r"<noscript\b[^>]*>.*?</noscript\s*>", re.IGNORECASE | re.DOTALL
)
_STYLE_ELEM_RE = re.compile(
    r"(<style\b[^>]*>)(.*?)(</style\s*>)", re.IGNORECASE | re.DOTALL
)
_BASE_TAG_RE = re.compile(r"<base\b[^>]*/?>", re.IGNORECASE)
_CHARSET_META = "<meta charset='utf-8'>"
_META_CONTENT_TYPE_RE = re.compile(
    r"""<meta\b[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*>""", re.IGNORECASE
)
_META_CHARSET_RE = re.compile(r"""<meta\b[^>]*\bcharset\s*=[^>]*>""", re.IGNORECASE)
_HEAD_OPEN_RE = re.compile(r"<head\b[^>]*>", re.IGNORECASE)
_HTML_OPEN_RE = re.compile(r"<html\b[^>]*>", re.IGNORECASE)
_DOCTYPE_RE = re.compile(r"<!DOCTYPE\b[^>]*>", re.IGNORECASE)
_A_TAG_RE = re.compile(r"<a\b[^>]*>", re.IGNORECASE)
# Three attributes, one matcher. See zimwriter.attr_re for why this is not a
# hand-rolled regex any more: the quoted-only version could not see
# `<img src=/a.png>`, and `\bsrc` read `data-src` as `src`.
_ABS_ATTR_RE = attr_re("src", "href", "srcset")
_HTML_LANG_RE = re.compile(
    r"""<html\b[^>]*?\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))""", re.IGNORECASE
)
_META_LANG_RE = re.compile(
    r"""<meta\b[^>]*?\bhttp-equiv\s*=\s*["']?content-language["']?[^>]*>""",
    re.IGNORECASE,
)
# og:locale is the one non-standard tag worth reading: sites that declare
# nothing else very often declare this, and its values are unambiguous.
_OG_LOCALE_RE = re.compile(
    r"""<meta\b[^>]*?\bproperty\s*=\s*["']?og:locale["']?[^>]*>""", re.IGNORECASE
)
_META_CONTENT_RE = re.compile(
    r"""\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))""", re.IGNORECASE
)


# ── shared helpers ──────────────────────────────────────────────────────────


def _page_title_from_html(text, fallback):
    """<title>, else first <h1>, else the fallback (filename stem)."""
    for rx in (_TITLE_TAG_RE, _H1_RE):
        m = rx.search(text)
        if m:
            t = " ".join(_html.unescape(_TAG_RE.sub("", m.group(1))).split())
            if t:
                return t
    return fallback


def _guess_mime(name):
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def _fmt_bytes(n):
    for unit in ("bytes", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n} bytes"


def _finish_output(out_dir, out_path, base):
    """Resolve the output .zim path. Explicit ``out_path`` is taken literally
    (plus a .zim suffix if missing) and must not clobber; otherwise the file
    lands in ``out_dir`` under a non-clobbering auto name."""
    if out_path:
        if not out_path.endswith(".zim"):
            out_path += ".zim"
        out_path = os.path.abspath(out_path)
        if os.path.exists(out_path):
            raise CreateError(f"output already exists: {out_path}")
        parent = os.path.dirname(out_path)
        if not os.path.isdir(parent):
            raise CreateError(f"output directory does not exist: {parent}")
        return out_path
    os.makedirs(out_dir, exist_ok=True)
    return _output_path(out_dir, base)


def scratch_dir(out_dir=None, out_path=None):
    """A directory a capture can put its working files in, which is not the
    same question as where the finished ZIM goes.

    ``out_dir or _srv.ZIM_DIR`` was written at eight call sites and is wrong at
    every one of them the moment somebody passes ``out_path`` alone: the ZIM is
    destined for a directory nobody consulted, and the scratch files are aimed
    at a library folder that a CLI user may not have, may not be able to write,
    and did not ask to be involved. ``mkdtemp`` then raises FileNotFoundError
    from somewhere three frames down.

    So: whoever was named, then the finished file's own directory, then the
    library, then the machine's temp. A named directory that does not exist yet
    is CREATED — a configured-but-not-yet-made ZIM_DIR is an ordinary state on a
    fresh install, and falling past it to /tmp would scatter a user's working
    files somewhere they never pointed at.

    The temp fallback is genuinely last. /tmp is a RAM disk on more than one
    machine Zimi runs on, and a site recording is the last thing that should be
    held there — so reaching it is worth a warning, not a shrug. It stays in the
    list because a total function beats a FileNotFoundError three frames down."""
    named = os.path.dirname(os.path.abspath(out_path)) if out_path else None
    for candidate in (out_dir, named, _srv.ZIM_DIR):
        if not candidate:
            continue
        try:
            os.makedirs(candidate, exist_ok=True)
        except OSError:
            continue
        if os.path.isdir(candidate) and os.access(candidate, os.W_OK):
            return candidate
    fallback = tempfile.gettempdir()
    log.warning(
        "no writable working directory (tried out_dir, output's own folder, "
        "ZIM_DIR) — falling back to %s, which is a RAM disk on some systems",
        fallback,
    )
    return fallback


def _try_register(path):
    """Best-effort library registration — the ZIM is on disk either way, so a
    registration failure downgrades to a warning, never a failed create."""
    try:
        _register_exports([path])
        return True
    except Exception as e:
        log.warning(
            "could not register %s in the library: %s", os.path.basename(path), e
        )
        return False


# ── Markdown → HTML (internal, dependency-free) ─────────────────────────────
# Covers the common core: ATX headings, paragraphs, emphasis, inline code,
# fenced code blocks, links, images, ordered/unordered lists (nested by
# indentation), blockquotes, pipe tables, horizontal rules, and raw-HTML
# passthrough. Unknown constructs degrade to plain paragraph text.

_MD_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_MD_FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$")
_MD_HR_RE = re.compile(r"^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$")
_MD_UL_RE = re.compile(r"^(\s*)[-*+]\s+(.*)$")
_MD_OL_RE = re.compile(r"^(\s*)\d{1,9}[.)]\s+(.*)$")
_MD_QUOTE_RE = re.compile(r"^\s{0,3}>\s?")
_MD_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_MD_HTML_BLOCK_RE = re.compile(r"^\s{0,3}</?[a-zA-Z][^<>]*>?")
_MD_CODESPAN_RE = re.compile(r"(`+)(.+?)\1")
_MD_IMG_RE = re.compile(r"!\[([^\]]*)\]\(\s*(\S+?)(?:\s+\"[^\"]*\")?\s*\)")
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\(\s*(\S+?)(?:\s+\"[^\"]*\")?\s*\)")
_MD_BOLD_RE = re.compile(r"\*\*(.+?)\*\*|__(.+?)__")
_MD_ITALIC_RE = re.compile(
    r"(?<![*\w])\*([^*\n]+)\*(?![*\w])|(?<![_\w])_([^_\n]+)_(?![_\w])"
)


def _md_inline(text):
    """Inline markdown: code spans (protected first), images, links, bold,
    italic. Raw inline HTML passes through untouched."""
    codes = []

    def _stash(m):
        codes.append(_html.escape(m.group(2).strip()))
        return f"\x00{len(codes) - 1}\x00"

    text = _MD_CODESPAN_RE.sub(_stash, text)
    text = _MD_IMG_RE.sub(r'<img src="\2" alt="\1">', text)
    text = _MD_LINK_RE.sub(r'<a href="\2">\1</a>', text)
    text = _MD_BOLD_RE.sub(
        lambda m: f"<strong>{m.group(1) or m.group(2)}</strong>", text
    )
    text = _MD_ITALIC_RE.sub(lambda m: f"<em>{m.group(1) or m.group(2)}</em>", text)
    for i, code in enumerate(codes):
        text = text.replace(f"\x00{i}\x00", f"<code>{code}</code>")
    return text


def _md_is_block_start(line):
    return bool(
        _MD_HEADING_RE.match(line)
        or _MD_FENCE_RE.match(line)
        or _MD_HR_RE.match(line)
        or _MD_UL_RE.match(line)
        or _MD_OL_RE.match(line)
        or _MD_QUOTE_RE.match(line)
    )


def _md_split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _md_parse_list(lines, i, out):
    """Consume a run of list items (nested by indentation) starting at i.
    Nested lists are emitted as siblings of their parent <li> — technically
    loose HTML, rendered identically by every browser."""
    stack = []  # (indent, tag)
    while i < len(lines):
        m = _MD_UL_RE.match(lines[i]) or _MD_OL_RE.match(lines[i])
        if not m:
            # Indented continuation line of the previous item.
            if lines[i].strip() and lines[i][:1].isspace() and stack:
                out.append(_md_inline(lines[i].strip()))
                i += 1
                continue
            break
        tag = "ul" if _MD_UL_RE.match(lines[i]) else "ol"
        indent = len(m.group(1).replace("\t", "    "))
        while stack and indent < stack[-1][0]:
            out.append(f"</{stack.pop()[1]}>")
        if not stack or indent > stack[-1][0]:
            stack.append((indent, tag))
            out.append(f"<{tag}>")
        elif stack[-1][1] != tag:
            out.append(f"</{stack.pop()[1]}>")
            stack.append((indent, tag))
            out.append(f"<{tag}>")
        out.append(f"<li>{_md_inline(m.group(2))}</li>")
        i += 1
    while stack:
        out.append(f"</{stack.pop()[1]}>")
    return i


def _md_parse_table(lines, i, out):
    header = _md_split_row(lines[i])
    out.append("<table><thead><tr>")
    out.extend(f"<th>{_md_inline(c)}</th>" for c in header)
    out.append("</tr></thead><tbody>")
    i += 2  # skip the separator row
    while i < len(lines) and "|" in lines[i] and lines[i].strip():
        out.append("<tr>")
        out.extend(f"<td>{_md_inline(c)}</td>" for c in _md_split_row(lines[i]))
        out.append("</tr>")
        i += 1
    out.append("</tbody></table>")
    return i


def markdown_to_html(text):
    """Render Markdown to an HTML body. Returns ``(body_html, title)`` where
    title is the first H1's text, or None."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out = []
    title = None
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        fence = _MD_FENCE_RE.match(line)
        if fence:
            marker, lang = fence.group(1), fence.group(2)
            code = []
            i += 1
            while i < len(lines) and not (
                lines[i].strip().startswith(marker[0] * 3)
                and set(lines[i].strip()) <= {marker[0]}
            ):
                code.append(lines[i])
                i += 1
            i += 1  # closing fence (or EOF)
            cls = f' class="language-{lang}"' if lang else ""
            out.append(
                f"<pre><code{cls}>{_html.escape(chr(10).join(code))}</code></pre>"
            )
            continue
        m = _MD_HEADING_RE.match(line)
        if m:
            level = len(m.group(1))
            text_i = _md_inline(m.group(2))
            if level == 1 and title is None:
                title = " ".join(_TAG_RE.sub("", text_i).split())
            out.append(f"<h{level}>{text_i}</h{level}>")
            i += 1
            continue
        if _MD_HR_RE.match(line):
            out.append("<hr>")
            i += 1
            continue
        if _MD_QUOTE_RE.match(line):
            block = []
            while i < len(lines) and _MD_QUOTE_RE.match(lines[i]):
                block.append(_MD_QUOTE_RE.sub("", lines[i], count=1))
                i += 1
            inner, _t = markdown_to_html("\n".join(block))
            out.append(f"<blockquote>{inner}</blockquote>")
            continue
        if _MD_UL_RE.match(line) or _MD_OL_RE.match(line):
            i = _md_parse_list(lines, i, out)
            continue
        if (
            "|" in line
            and i + 1 < len(lines)
            and "|" in lines[i + 1]
            and _MD_TABLE_SEP_RE.match(lines[i + 1])
        ):
            i = _md_parse_table(lines, i, out)
            continue
        if _MD_HTML_BLOCK_RE.match(line):
            # Raw HTML block: pass through verbatim until a blank line.
            while i < len(lines) and lines[i].strip():
                out.append(lines[i])
                i += 1
            continue
        # Paragraph: gather until a blank line or the start of another block.
        para = [line.strip()]
        i += 1
        while i < len(lines) and lines[i].strip() and not _md_is_block_start(lines[i]):
            para.append(lines[i].strip())
            i += 1
        out.append(f"<p>{_md_inline(' '.join(para))}</p>")
    return "\n".join(out), title


def _render_markdown_page(text, fallback_title):
    body, title = markdown_to_html(text)
    title = title or fallback_title
    doc = (
        _page_head(_html.escape(title))
        + "<body><main>"
        + body
        + "</main></body></html>"
    )
    return doc.encode("utf-8"), title


# ── Tier 1: folder → ZIM ────────────────────────────────────────────────────

_file_item_cls = None


def _zim_file_item_class():
    """Streaming Item backed by libzim's FileProvider — raw files (PDFs,
    images, video) go from disk to ZIM without ever loading into memory."""
    global _file_item_cls
    if _file_item_cls is not None:
        return _file_item_cls
    from libzim.writer import FileProvider, Hint, Item

    class _FileItem(Item):
        def __init__(self, path, title, fs_path, mimetype):
            super().__init__()
            self._path = path
            self._title = title
            self._fs_path = fs_path
            self._mimetype = mimetype

        def get_path(self):
            return self._path

        def get_title(self):
            return self._title

        def get_mimetype(self):
            return self._mimetype

        def get_contentprovider(self):
            return FileProvider(pathlib.Path(self._fs_path))

        def get_hints(self):
            # PDFs are front articles — they're the content in a document
            # folder, and FRONT_ARTICLE puts them in the suggest index.
            return (
                {Hint.FRONT_ARTICLE: 1} if self._mimetype == "application/pdf" else {}
            )

    _file_item_cls = _FileItem
    return _FileItem


def _scan_folder(root):
    """Yield ``(fs_path, zim_path)`` for every packagable file under root,
    depth-first and sorted for a deterministic build. Hidden files/dirs,
    junk, and symlinks are skipped — a symlink could point outside the
    folder, and 'package this folder' must never read beyond it."""
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(
            d
            for d in dirnames
            if not d.startswith(".")
            and d.lower() not in _JUNK_NAMES
            and not os.path.islink(os.path.join(dirpath, d))
        )
        for name in sorted(filenames):
            if name.startswith(".") or name.lower() in _JUNK_NAMES:
                continue
            fs_path = os.path.join(dirpath, name)
            if os.path.islink(fs_path):
                continue
            zim_path = os.path.relpath(fs_path, root).replace(os.sep, "/")
            yield fs_path, zim_path


# Root-level entry-point candidates, best first. Extensionless README is
# treated as Markdown — that's what it almost always is.
_MAIN_CANDIDATES = (
    "index.html",
    "index.htm",
    "readme.md",
    "readme.markdown",
    "readme.html",
    "readme.htm",
    "readme",
)


def _pick_main(zim_paths):
    root_files = {p.lower(): p for p in zim_paths if "/" not in p}
    for cand in _MAIN_CANDIDATES:
        if cand in root_files:
            return root_files[cand]
    return None


# How many of a folder's HTML files are sniffed for a language declaration, and
# how much of each is read. Deliberately cheap: this runs before a Pi starts
# packaging, the answer is almost always in the first tag of the first file, and
# a folder with no declaration anywhere is simply English by default.
_FOLDER_LANG_SAMPLE_FILES = 20
_FOLDER_LANG_SAMPLE_BYTES = 4096


def folder_language(requested, files):
    """The language for a folder capture, as ``(code, how)``.

    Auto means: read the ``<html lang>`` of the first handful of HTML files and
    take the majority. "Trivially possible" is the whole bar — a folder of
    Markdown and PDFs declares nothing, and guessing at prose would be a worse
    answer than the honest default."""
    named = requested_language(requested)
    if named:
        return named, "requested"
    codes = []
    opened = 0
    for fs_path, zim_path in files:
        # The budget counts files OPENED, not answers found. Counting answers
        # would make a folder of ten thousand HTML files that declare nothing
        # open all ten thousand of them — on a Pi, before packaging even starts.
        if opened >= _FOLDER_LANG_SAMPLE_FILES:
            break
        if os.path.splitext(zim_path)[1].lower() not in _HTML_EXTS:
            continue
        opened += 1
        try:
            with open(fs_path, encoding="utf-8", errors="replace") as fh:
                head = fh.read(_FOLDER_LANG_SAMPLE_BYTES)
        except OSError:
            continue
        m = _HTML_LANG_RE.search(head)
        code = language_tag_to_iso3(_first_group(m)) if m else None
        if code:
            codes.append(code)
    if not codes:
        return DEFAULT_LANGUAGE, "fallback"
    return max(set(codes), key=lambda c: (codes.count(c), -codes.index(c))), "html-lang"


def _index_tree_html(title, pages, assets):
    """The generated main page: the content tree as nested lists, pages
    first (with their real titles), assets after."""
    tree = {}
    for zim_path, page_title in pages:
        tree.setdefault(posixpath.dirname(zim_path), []).append(
            (zim_path, page_title, True)
        )
    for zim_path in assets:
        tree.setdefault(posixpath.dirname(zim_path), []).append(
            (zim_path, posixpath.basename(zim_path), False)
        )
    body = [f"<h1>{_html.escape(title)}</h1>"]
    body.append(
        "<p style='color:#666'>"
        + _plural(len(pages), "page")
        + ", "
        + _plural(len(assets), "file")
        + " packaged by Zimi</p>"
    )
    for folder in sorted(tree):
        if folder:
            body.append(f"<h2 class='zimi-section'>{_html.escape(folder)}/</h2>")
        items = sorted(tree[folder], key=lambda e: (not e[2], e[1].lower()))
        body.append("<ol class='zimi-index'>")
        for zim_path, label, is_page in items:
            style = "" if is_page else " style='color:#999'"
            body.append(
                f"<li{style}><a href='{_html.escape(zim_path)}'>"
                f"{_html.escape(label)}</a></li>"
            )
        body.append("</ol>")
    return (
        _page_head(_html.escape(title)) + "<body>" + "".join(body) + "</body></html>"
    ).encode("utf-8")


def create_folder_zim(
    folder,
    *,
    out_dir=None,
    out_path=None,
    title=None,
    description=None,
    language=LANGUAGE_AUTO,
    creator_name="Zimi",
    register=False,
):
    """Package a folder of files into one ZIM. Returns a summary dict:
    ``{"path", "pages", "assets", "main", "registered", "language",
    "language_source"}``. Raises ``CreateError`` for anything the user must fix
    (missing folder, size caps, unwritable output)."""
    folder = os.path.abspath(folder)
    if not os.path.isdir(folder):
        raise CreateError(
            f"not a folder: {folder}"
            if os.path.exists(folder)
            else f"folder not found: {folder}"
        )
    files = list(_scan_folder(folder))
    if not files:
        raise CreateError(f"nothing to package — no files found in {folder}")

    language, language_source = folder_language(language, files)
    base_name = os.path.basename(folder.rstrip(os.sep)) or "folder"
    zim_title = title or base_name
    out = _finish_output(out_dir or _srv.ZIM_DIR, out_path, _slug(base_name, "folder"))

    static_cls = zim_static_item_class()
    file_cls = _zim_file_item_class()
    total_bytes = 0
    pages = []  # (zim_path, title) — front articles for the generated index
    assets = []  # zim_path
    mimetypes = set()  # evidence for the _pictures:/_videos: tags
    main_path = _pick_main(p for _f, p in files)

    with atomic_zim_creator(out, language) as creator:
        for fs_path, zim_path in files:
            size = os.path.getsize(fs_path)
            ext = os.path.splitext(zim_path)[1].lower()
            is_text = (
                ext in _MD_EXTS
                or ext in _HTML_EXTS
                or (zim_path == main_path and ext == "")
            )
            cap = MAX_TEXT_SOURCE_BYTES if is_text else MAX_SOURCE_FILE_BYTES
            if size > cap:
                raise CreateError(
                    f"{zim_path} is {_fmt_bytes(size)} — over the per-file cap "
                    f"({_fmt_bytes(cap)}); remove it or package it separately"
                )
            total_bytes += size
            if total_bytes > MAX_TOTAL_SOURCE_BYTES:
                raise CreateError(
                    f"folder exceeds the {_fmt_bytes(MAX_TOTAL_SOURCE_BYTES)} "
                    f"total cap at {zim_path} — split it into smaller ZIMs"
                )
            stem = posixpath.basename(zim_path)
            if is_text:
                try:
                    with open(fs_path, encoding="utf-8", errors="replace") as f:
                        text = f.read()
                except OSError as e:
                    raise CreateError(f"cannot read {zim_path}: {e.strerror or e}")
                if ext in _HTML_EXTS:
                    # Otherwise untouched — relative links resolve because the
                    # whole folder ships at its original paths. Only the
                    # charset declaration is rewritten, because the file was
                    # just read as UTF-8 and is stored as UTF-8, and the ZIM
                    # entry's bare text/html mimetype no longer says so.
                    page_title = _page_title_from_html(
                        text, posixpath.splitext(stem)[0]
                    )
                    content = _normalize_charset(text).encode("utf-8")
                else:
                    content, page_title = _render_markdown_page(
                        text, posixpath.splitext(stem)[0]
                    )
                creator.add_item(
                    static_cls(zim_path, page_title, content, mimetype=_HTML_MIME)
                )
                pages.append((zim_path, page_title))
            else:
                mime = _guess_mime(zim_path)
                creator.add_item(file_cls(zim_path, stem, fs_path, mime))
                assets.append(zim_path)
                mimetypes.add(mime)

        if main_path is None:
            taken = {p for _f, p in files}
            main_path = "index" if "index" not in taken else "zimi-index"
            creator.add_item(
                static_cls(
                    main_path, zim_title, _index_tree_html(zim_title, pages, assets)
                )
            )
        creator.set_mainpath(main_path)
        add_standard_metadata(
            creator,
            title=zim_title,
            description=description
            or f"{_plural(len(pages), 'page')} and "
            f"{_plural(len(assets), 'file')} packaged by Zimi",
            language=language,
            creator_name=creator_name,
            # The folder's NAME, never its path — see the privacy rule in
            # zimwriter's provenance block.
            source=base_name,
            # Repackaging the same folder next month is a new EDITION of this
            # ZIM, so the Name comes from the folder, never from the date.
            name=zim_name(base_name, language),
            tags=media_tags(mimetypes),
            history=history_record(
                "created",
                "folder",
                f'packaged the folder "{base_name}" — '
                f"{_plural(len(pages), 'page')} and "
                f"{_plural(len(assets), 'file')}",
                counts={
                    "pages": len(pages),
                    "assets": len(assets),
                    "bytes": total_bytes,
                },
            ),
        )

    registered = _try_register(out) if register else False
    return {
        "path": out,
        "pages": len(pages),
        "assets": len(assets),
        "main": main_path,
        "registered": registered,
        "language": language,
        "language_source": language_source,
    }


# ── Tier 2: single page → ZIM ───────────────────────────────────────────────


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _user_agent():
    # One honest UA for all of Zimi's outbound HTTP.
    from zimi.library import USER_AGENT

    return USER_AGENT


def _fetch_page(url, *, timeout, max_redirects):
    """Fetch one document, following at most ``max_redirects`` hops so the
    final URL is known (it becomes the base for asset resolution). Returns
    ``(final_url, data, content_type)``."""
    for _hop in range(max_redirects + 1):
        scheme = urllib.parse.urlsplit(url).scheme.lower()
        if scheme not in ("http", "https"):
            raise CreateError(f"unsupported URL scheme in redirect chain: {url}")
        req = urllib.request.Request(url, headers={"User-Agent": _user_agent()})
        opener = urllib.request.build_opener(_NoRedirect)
        try:
            resp = opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308):
                loc = e.headers.get("Location")
                if not loc:
                    raise CreateError(f"redirect without a Location header from {url}")
                url = urllib.parse.urljoin(url, loc)
                continue
            raise CreateError(f"HTTP {e.code} fetching {url}")
        except OSError as e:
            reason = getattr(e, "reason", None) or e
            raise CreateError(f"cannot fetch {url}: {reason}")
        with resp:
            data = resp.read(MAX_PAGE_FETCH_BYTES + 1)
            ctype = (resp.headers.get("Content-Type") or "").strip()
            clang = (resp.headers.get("Content-Language") or "").strip()
        if len(data) > MAX_PAGE_FETCH_BYTES:
            raise CreateError(
                f"page is over the {_fmt_bytes(MAX_PAGE_FETCH_BYTES)} fetch cap"
            )
        return url, data, ctype, clang
    raise CreateError(f"too many redirects (more than {max_redirects}) fetching {url}")


def _decode_page(data, ctype):
    m = re.search(r"charset=([\w.-]+)", ctype, re.IGNORECASE)
    charset = m.group(1) if m else "utf-8"
    try:
        return data.decode(charset, errors="replace")
    except LookupError:
        return data.decode("utf-8", errors="replace")


def _visible_text(page):
    """The page's server-rendered text content, tags and scripts stripped."""
    t = _SCRIPT_RE.sub(" ", page)
    t = _NOSCRIPT_RE.sub(" ", t)
    t = _STYLE_ELEM_RE.sub(" ", t)
    t = _TAG_RE.sub(" ", t)
    return " ".join(_html.unescape(t).split())


def looks_like_spa(page):
    """True when the document is an empty application shell: script tags
    present, near-zero server-rendered text. Packaging one of those would
    produce a ZIM of loading spinners."""
    if not re.search(r"<script\b", page, re.IGNORECASE):
        return False
    return len(_visible_text(page)) < SPA_MIN_TEXT_CHARS


# ── content language ────────────────────────────────────────────────────────
#
# What language a page is written in is a FACT ABOUT THE PAGE, not a preference
# the person capturing it should have to look up. Every URL capture reads it off
# the document at capture time, and the answer travels back in the result so the
# caller can say which way it went — a guess nobody can see is worse than no
# guess at all.


def _first_group(match):
    """The first non-empty capture of an alternation of quoted forms."""
    for value in match.groups():
        if value:
            return value
    return ""


def detect_page_language(page, content_language=None):
    """The language a fetched document declares, as ``(iso639_3, where)``.

    The three places a page can honestly state it, best evidence first: the
    ``<html lang>`` attribute (what browsers themselves obey), a
    ``content-language``/``og:locale`` meta, then the HTTP ``Content-Language``
    header. ``(None, "")`` when the page says nothing — silence is reported as
    silence and the caller decides, rather than being handed a guess wearing
    the same shape as a fact."""
    text = page or ""
    m = _HTML_LANG_RE.search(text)
    if m:
        code = language_tag_to_iso3(_first_group(m))
        if code:
            return code, "html-lang"
    for regex in (_META_LANG_RE, _OG_LOCALE_RE):
        for tag in regex.finditer(text):
            content = _META_CONTENT_RE.search(tag.group(0))
            if not content:
                continue
            code = language_tag_to_iso3(_first_group(content))
            if code:
                return code, "meta"
    code = language_tag_to_iso3(content_language)
    if code:
        return code, "http-header"
    return None, ""


def language_tag_to_iso3(raw):
    """One BCP-47-ish tag (``en``, ``en-US``, ``fr_FR``, ``eng``) as the ISO
    639-3 code a ZIM stores, or None when it is not resolvable.

    A two-letter tag must be in the reader's own ISO 639 table to be accepted —
    inventing a three-letter code from two letters we do not recognise is how a
    ZIM ends up lying about itself. A three-letter tag is taken at its word:
    639-3 has thousands of valid codes and a page that names one is better
    evidence than our thirty-odd-entry table."""
    tag = str(raw or "").strip().lower().replace("_", "-")
    primary = tag.split(",")[0].strip().split("-")[0].strip()
    if not primary.isalpha():
        return None
    if len(primary) == 2:
        return {v: k for k, v in _srv._ISO639_3_TO_1.items()}.get(primary)
    return primary if len(primary) == 3 else None


def requested_language(requested):
    """A language the caller named, validated, or None when they named none
    (or named ``auto``, which is naming none out loud).

    A bad code is a mistake the person can fix, so it surfaces as ``CreateError``
    like every other one — ``normalize_language`` raises ValueError, which would
    otherwise reach a CLI user as a traceback and a web user as a 500."""
    asked = str(requested or "").strip().lower()
    if not asked or asked == LANGUAGE_AUTO:
        return None
    try:
        return normalize_language(asked)
    except ValueError as e:
        raise CreateError(str(e))


def resolve_language(requested, page=None, content_language=None):
    """The language to stamp on a capture, as ``(code, how)``.

    A caller that named a code gets it (validated). ``auto`` — and saying
    nothing at all, which is the web form's default — hands the decision to the
    document, and English is only ever reached by falling through everything
    else."""
    named = requested_language(requested)
    if named:
        return named, "requested"
    code, where = detect_page_language(page or "", content_language)
    if code:
        return code, where
    return DEFAULT_LANGUAGE, "fallback"


def _origin_variants(final_url):
    p = urllib.parse.urlsplit(final_url)
    origin = f"{p.scheme}://{p.netloc}"
    return origin, (origin, f"//{p.netloc}")


def _strip_origin(ref, variants):
    for v in variants:
        if ref == v:
            return "/"
        if ref.startswith(v + "/"):
            return ref[len(v) :]
    return ref


def _relativize_html(page, variants):
    """Rewrite same-origin absolute (and protocol-relative) URLs in
    src/href/srcset attributes to root-relative form, so the shared
    ``_resolve_ref`` — which ignores anything with a scheme — resolves and
    carries them like any relative asset."""

    def fix(m):
        prefix, attr, val = m.group("pre"), m.group("attr"), m.group("val")
        if attr.lower() == "srcset":
            # Split by the spec, not by comma: an image URL may CONTAIN commas
            # (CNN's image API: ?q=h_720,w_1280,c_fill/f_webp). Splitting naively
            # here shredded one URL into three bogus candidates before the asset
            # carrier ever saw the tag, and a phone then picked the garbage and
            # showed a broken image (Eric, on-device).
            #
            # Reduced to ONE candidate here, which is the only place it can be
            # done once: everything downstream — the asset carrier, the size
            # estimate, the preview — reads the rewritten tag, so pruning here
            # prunes all of them and no other stage needs to know the rule.
            from zimi.zimwriter import _split_srcset, pick_srcset

            picked = pick_srcset(_split_srcset(val))
            if picked:
                url, descriptor = picked
                val = (_strip_origin(url, variants) + " " + descriptor).strip()
        else:
            val = _strip_origin(val, variants)
        # Always quoted on the way out; escaped because this value came
        # from the page and a single-quoted attribute may hold a ".
        return f'{prefix}"{attr_quote(val)}"'

    return _ABS_ATTR_RE.sub(fix, page)


def _relativize_css(text, variants):
    def fix(m):
        quote, ref = m.group(1), m.group(2)
        return "url(" + quote + _strip_origin(ref, variants) + quote + ")"

    return _CSS_URL_RE.sub(fix, text)


_RETRYABLE_HTTP = frozenset((429, 500, 502, 503, 504))


def _urlopen_retry(req, timeout, tries=3):
    """``urlopen`` with a short backoff on the transient failures a burst of
    same-host requests provokes: a CDN rate-limit (429/503) or a dropped
    connection. A page can reference hundreds of images on one media host, and
    firing them off back-to-back gets a slice of them throttled — which used to
    leave those images silently uncarried (Eric: a captured CNN's top images
    404'd). A real 404/403 is not retried; it will not get better. Raises the
    last error when every try fails."""
    import time

    last = None
    for i in range(tries):
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            last = e
            if e.code not in _RETRYABLE_HTTP:
                raise
        except OSError as e:
            last = e
        if i < tries - 1:
            time.sleep(0.4 * (i + 1))
    raise last if last is not None else OSError("fetch failed with no error")


def _http_asset_reader(origin, variants, timeout):
    """An ``_AssetCarrier`` asset reader pointed at HTTP: fetches
    ``origin/<resolved>``, same-origin by construction. Reads are capped at
    the carrier's per-asset limit so an oversized asset is dropped without
    ever being fully downloaded. CSS gets its same-origin absolute url()
    refs relativized before the carrier rewrites and recurses into them."""
    import zimi.zimwriter as _zw

    def read(_label, resolved):
        cap = _zw._MAX_ASSET_BYTES
        url = origin + "/" + resolved
        req = urllib.request.Request(url, headers={"User-Agent": _user_agent()})
        try:
            with _urlopen_retry(req, timeout) as resp:
                data = resp.read(cap + 1)
                mime = (
                    (resp.headers.get("Content-Type") or "application/octet-stream")
                    .split(";")[0]
                    .strip()
                )
        except OSError as e:
            log.debug("asset fetch failed %s: %s", url, e)
            return None
        if len(data) > cap:
            return None
        if "css" in mime or resolved.lower().endswith(".css"):
            data = _relativize_css(
                data.decode("utf-8", errors="replace"), variants
            ).encode("utf-8")
        return data, mime

    return read


# The Fast engine is same-origin for scripts and CSS on purpose, but a page's
# images almost always live on a sibling CDN host (media.cnn.com, i.imgur.com),
# so a same-origin-only image rule drops most of the modern web's pictures. This
# reader carries those — and ONLY media (image/video/audio), so an <img> that
# resolves to an HTML error page is not silently pulled in as a "picture".
_REMOTE_MEDIA_MIME_RE = re.compile(r"^(image|video|audio)/", re.IGNORECASE)


def _http_remote_reader(timeout):
    """An ``_AssetCarrier`` remote reader: fetch one absolute (cross-origin)
    media URL → (bytes, mime) | None. Best effort, media content-types only,
    capped at the per-asset limit so an oversized asset is dropped without ever
    being fully downloaded."""
    import zimi.zimwriter as _zw

    def read(url):
        cap = _zw._MAX_ASSET_BYTES
        req = urllib.request.Request(url, headers={"User-Agent": _user_agent()})
        try:
            with _urlopen_retry(req, timeout) as resp:
                mime = (
                    (resp.headers.get("Content-Type") or "")
                    .split(";")[0]
                    .strip()
                    .lower()
                )
                # A declared, non-media type is a redirect-to-login or an error
                # page — not the image the tag promised. Drop it before reading.
                if mime and not _REMOTE_MEDIA_MIME_RE.match(mime):
                    return None
                data = resp.read(cap + 1)
        except OSError as e:
            log.debug("remote asset fetch failed %s: %s", url, e)
            return None
        if not data or len(data) > cap:
            return None
        return data, mime or "application/octet-stream"

    return read


def _replace_href(tag, new_ref):
    return _HREF_RE.sub(lambda m: f'{m.group("pre")}"{new_ref}"', tag, count=1)


# Link relations that are advice to a live browser, never content. Offline a
# preload is a fetch of an address that does not exist in the archive; the
# rendered engine deletes these in _PREPARE_JS and the fast engine now agrees.
_RESOURCE_HINT_RELS = frozenset(
    {"preload", "modulepreload", "prefetch", "preconnect", "dns-prefetch"}
)


def _carry_stylesheets(carrier, label, page_path, page):
    """Carry each same-origin ``<link rel=stylesheet>`` into the ZIM and
    point the link at the carried copy. The carrier rewrites the CSS's own
    url() refs relative to its carried location, so fonts and background
    images resolve naturally. Cross-origin sheets are left alone — external
    refs, honestly absent offline."""

    def fix(m):
        tag = m.group(0)
        relm = _REL_RE.search(tag)
        if not relm:
            return tag
        rels = relm.group("val").lower().split()
        # A resource HINT is advice to a live browser about what to fetch
        # early. Offline it is not advice, it is a request for a file at an
        # address that does not exist here — CNN preloads four fonts by
        # root-relative path, so a captured page fired four 404s before it drew
        # a pixel and then rendered in fallback type. The fonts themselves are
        # carried, through the stylesheet that actually uses them; only the
        # hint pointed at the open web.
        #
        # Dropped rather than rewritten, because a preload that resolves is
        # still doing nothing useful in an archive: the stylesheet below asks
        # for the same file a moment later and gets it. The rendered engine
        # already deletes these in _PREPARE_JS for the same reason, so this
        # also stops the two engines disagreeing about what a capture contains.
        if _RESOURCE_HINT_RELS.intersection(rels):
            return ""
        if "stylesheet" not in rels:
            return tag
        hrefm = _HREF_RE.search(tag)
        if not hrefm:
            return tag
        resolved = _resolve_ref(page_path, hrefm.group("val"))
        if not resolved:
            return tag
        in_path = carrier._carry(label, resolved)
        if not in_path:
            return tag
        # The article lives at A/<name>; in-ZIM paths are one level up.
        return _replace_href(tag, "../" + in_path)

    return _STYLESHEET_RE.sub(fix, page)


def _carry_inline_styles(carrier, label, page_path, page):
    """Carry url() assets referenced from inline <style> blocks. Unlike a
    carried stylesheet, inline CSS lives inside the article itself, so refs
    rewrite relative to the article (``../<in-zim path>``)."""

    def fix_block(m):
        open_tag, css, close_tag = m.group(1), m.group(2), m.group(3)

        def fix_url(u):
            quote, ref = u.group(1), u.group(2)
            resolved = _resolve_ref(page_path, ref)
            if not resolved:
                return u.group(0)
            in_path = carrier._carry(label, resolved)
            if not in_path:
                return u.group(0)
            return "url(" + quote + "../" + in_path + quote + ")"

        return open_tag + _CSS_URL_RE.sub(fix_url, css) + close_tag

    return _STYLE_ELEM_RE.sub(fix_block, page)


def _externalize_links(page, base_url, resolve=None):
    """Resolve every ``<a href>`` against the page's final URL.

    ``resolve(absolute_url)`` gets first refusal and returns an in-ZIM
    reference when the capture holds that page — that is how a site crawl
    turns a link between two captured pages into internal navigation. Without
    it (single-page capture) every off-page link becomes absolute and points
    back at the live web, which the reader marks as external. Fragment,
    mailto:, javascript:, and data: links stay untouched either way."""

    def fix(m):
        tag = m.group(0)

        def fix_href(hm):
            val = hm.group("val").strip()
            if not val or val.startswith("#"):
                return hm.group(0)
            head = val.split("/", 1)[0]
            if ":" in head and not val.lower().startswith(("http:", "https:")):
                return hm.group(0)  # mailto:, javascript:, data:, tel:
            absolute = urllib.parse.urljoin(base_url, val)
            internal = resolve(absolute) if resolve else None
            return f'{hm.group("pre")}"{attr_quote(internal or absolute)}"'

        return _HREF_RE.sub(fix_href, tag, count=1)

    return _A_TAG_RE.sub(fix, page)


def _strip_scripts(page):
    """No JavaScript ships: scripts can't run against the live origin from
    inside a ZIM, and a dead <script src> is just a broken request. <base>
    goes too — it would re-absolutize every rewritten reference."""
    page = _SCRIPT_RE.sub("", page)
    page = _SCRIPT_VOID_RE.sub("", page)
    page = _NOSCRIPT_RE.sub("", page)
    return _BASE_TAG_RE.sub("", page)


def _normalize_charset(page):
    """Make the page's declared charset tell the truth. A capture is decoded
    from whatever the server claimed and re-encoded as UTF-8, so a surviving
    ``<meta charset=windows-1252>`` now describes bytes that no longer exist —
    and since ZIM entries carry a BARE ``text/html`` mimetype (the charset
    suffix is what makes libzim's Counter metadata violate the spec's regex),
    this tag is what a browser will actually believe. Every declaration is
    replaced with one canonical UTF-8 one."""
    page = _META_CONTENT_TYPE_RE.sub("", page)
    page = _META_CHARSET_RE.sub("", page)
    for anchor in (_HEAD_OPEN_RE, _HTML_OPEN_RE, _DOCTYPE_RE):
        m = anchor.search(page)
        if m:
            return page[: m.end()] + _CHARSET_META + page[m.end() :]
    return _CHARSET_META + page


# ── the shared per-page pipeline (single page AND every page of a crawl) ────


def _fetch_html(url, *, timeout, max_redirects):
    """Fetch one URL as an HTML document. Returns
    ``(final_url, page_text, byte_count, content_language)`` — the header rides
    along because it is the last resort of language detection and re-fetching
    the page to read one header would be absurd. Raises ``CreateError`` for a
    transport failure or for a response that is not HTML."""
    final_url, data, ctype, clang = _fetch_page(
        url, timeout=timeout, max_redirects=max_redirects
    )
    if ctype and "html" not in ctype.lower():
        raise CreateError(
            f"not an HTML page (Content-Type: {ctype.split(';')[0]}) — "
            "only web pages can be captured this way"
        )
    return final_url, _decode_page(data, ctype), len(data), clang


def _url_page_path(final_url):
    """The URL's path as an asset-resolution base: a directory URL (or a bare
    origin) resolves relative refs as if it were that directory's index."""
    path = urllib.parse.urlsplit(final_url).path.lstrip("/")
    if not path or path.endswith("/"):
        path += "index.html"
    return path


def http_asset_carrier(
    add_item,
    final_url,
    timeout,
    *,
    carried=None,
    budget=None,
    item_factory=None,
    on_progress=None,
):
    """An ``_AssetCarrier`` that pulls same-origin assets over HTTP.

    ``carried`` shares ONE dedupe map across the pages of a site crawl — a
    site's common stylesheet is fetched and stored once, and every page's
    ``<link>`` points at that single copy — while each page still gets a
    fresh carrier so the per-page asset caps stay per page, exactly as in
    single-page capture. ``budget`` is anything with ``spend(n) -> bool``;
    it is charged for each fetched asset and stops asset traffic for good
    once a crawl-wide byte budget is spent.

    ``item_factory`` is what a carried asset BECOMES before it reaches
    ``add_item``. Single-page capture makes a libzim Item and hands it to a
    live Creator; a crawl has no Creator yet when it fetches, so it makes a
    plain tuple and hands it to an ``AssetSpool`` (see
    ``spooling_asset_carrier``). Everything between the fetch and that last
    step is the same code either way, which is the point."""
    origin, variants = _origin_variants(final_url)
    fetch = _http_asset_reader(origin, variants, timeout)
    remote_fetch = _http_remote_reader(timeout)

    def read(label, resolved):
        if budget is not None and not budget.spend(0):
            return None
        got = fetch(label, resolved)
        if got and budget is not None and not budget.spend(len(got[0])):
            return None
        return got

    def remote_read(url):
        if budget is not None and not budget.spend(0):
            return None
        got = remote_fetch(url)
        if got and budget is not None and not budget.spend(len(got[0])):
            return None
        return got

    carrier = _AssetCarrier(
        add_item,
        item_factory or make_asset_item,
        read,
        remote_reader=remote_read,
        on_progress=on_progress,
    )
    if carried is not None:
        carrier._carried = carried
    return carrier


def _spooled_asset(path, mimetype, data):
    """The ``_AssetCarrier`` item factory for a crawl: no libzim, just the
    three facts an asset is."""
    return (path, mimetype, data)


class AssetSpool:
    """A crawl's carried assets, held on DISK between the two passes.

    A site capture fetches an asset the moment the page that referenced it is
    captured, so a page's progress can mean "fully downloaded" rather than
    "downloaded except for the part that happens later". But the ZIM cannot be
    written until the capture set is final, so the bytes have to wait
    somewhere — and that somewhere is one file per asset beside the page
    spool, never a dict of bytes: a site's assets run to eighty megabytes and
    the machines Zimi targets do not have that to spare on top of everything
    else a crawl is holding."""

    def __init__(self, directory):
        os.makedirs(directory, exist_ok=True)
        self._dir = directory
        self._entries = []  # (in-ZIM path, mimetype, spool file)

    def __len__(self):
        return len(self._entries)

    def add(self, carried):
        """The sink an ``_AssetCarrier`` adds to, taking what
        ``_spooled_asset`` made."""
        in_path, mimetype, data = carried
        path = os.path.join(self._dir, f"{len(self._entries):06d}.bin")
        with open(path, "wb") as fh:
            fh.write(data)
        self._entries.append((in_path, mimetype, path))

    def drain(self, add_item):
        """Hand every spooled asset to a Creator and return how many landed.

        One at a time, each deleted as it goes: the peak here is one asset,
        which is the same peak the fetch itself had."""
        written = 0
        for in_path, mimetype, path in self._entries:
            try:
                with open(path, "rb") as fh:
                    data = fh.read()
            except OSError as e:
                log.warning("spooled asset %s is unreadable: %s", in_path, e)
                continue
            try:
                add_item(make_asset_item(in_path, mimetype, data))
                written += 1
            except Exception as e:
                # The article that referenced this asset was rewritten to point
                # at it during the crawl, so a failure here leaves a dangling
                # in-ZIM reference rather than an honest external one. It is
                # logged loudly for that reason: nothing else will notice.
                log.warning("could not write carried asset %s: %s", in_path, e)
            try:
                os.remove(path)
            except OSError:
                pass
        self._entries = []
        return written


def spooling_asset_carrier(spool, final_url, timeout, *, carried=None, budget=None):
    """``http_asset_carrier``'s crawl-pass twin: identical fetching, identical
    rewriting, but what it carries lands in ``spool`` on disk instead of in a
    Creator that does not exist yet."""
    return http_asset_carrier(
        spool.add,
        final_url,
        timeout,
        carried=carried,
        budget=budget,
        item_factory=_spooled_asset,
    )


def _declared_icon_urls(page, final_url):
    """Absolute URLs of the icons the page's own ``<link rel="…icon…">`` tags
    point at, best first: apple-touch-icon, then a ``sizes``-qualified icon,
    then a plain one. Cross-origin is fine — an icon is one small file and worth
    the fetch, and it's how a CDN-hosted or versioned favicon is found at all."""
    apple, sized, plain = [], [], []
    for m in _ICON_LINK_RE.finditer(page):
        tag = m.group(0)
        relm = _LINK_REL_RE.search(tag)
        if not relm:
            continue
        rel = (relm.group("val") or "").lower()
        if "icon" not in rel:
            continue
        hrefm = _LINK_HREF_RE.search(tag)
        if not hrefm:
            continue
        href = (hrefm.group("val") or "").strip()
        if not href or href.lower().startswith("data:"):
            continue
        try:
            url = urllib.parse.urljoin(final_url, href)
        except ValueError:
            continue
        if not url.lower().startswith(("http://", "https://")):
            continue
        if "apple-touch-icon" in rel:
            apple.append(url)
        elif "sizes" in tag.lower():
            sized.append(url)
        else:
            plain.append(url)
    seen, ordered = set(), []
    for url in apple + sized + plain:
        if url not in seen:
            seen.add(url)
            ordered.append(url)
    return ordered


def _fetch_icon_png(url, timeout):
    """Fetch one icon URL, re-encoded as the spec's 48x48 PNG, or None. Best
    effort: an icon must never fail a capture. Needs Pillow to rescale."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _user_agent()})
        # Retried like any other asset: one transient hiccup on the icon used to
        # cost the ZIM its real favicon for good, silently falling back to the
        # generated identicon (Eric: an Apple capture that "looks pretty good but
        # no favicon").
        with _urlopen_retry(req, timeout) as resp:
            data = resp.read(MAX_FAVICON_BYTES + 1)
    except OSError as e:
        log.debug("favicon fetch failed %s: %s", url, e)
        return None
    if data and len(data) <= MAX_FAVICON_BYTES:
        return illustration_from_image(data)
    return None


def site_illustration(final_url, timeout, page=None):
    """The site's own icon, re-encoded as the 48x48 PNG the spec wants, or
    None to fall back to a generated one. Best effort on purpose: an icon is
    decoration and a capture must never fail because a favicon 404'd. Needs
    Pillow to rescale, so a machine without it is not asked to fetch at all.

    Prefers the icon the ``page`` actually declares over a blind /favicon.ico
    probe — that probe is what handed Eric CNN's wrong favicon."""
    if not has_image_support():
        return None
    if page:
        for url in _declared_icon_urls(page, final_url):
            png = _fetch_icon_png(url, timeout)
            if png:
                return png
    origin, _variants = _origin_variants(final_url)
    for candidate in _FAVICON_CANDIDATES:
        png = _fetch_icon_png(origin + "/" + candidate, timeout)
        if png:
            return png
    return None


def render_captured_page(carrier, page, *, final_url, resolve_link=None):
    """Turn one fetched page into the HTML that ships inside the ZIM: carry
    its stylesheets, inline-style backgrounds and media through ``carrier``,
    resolve its links, and drop the JavaScript that could never run offline.
    ``resolve_link`` is passed through to ``_externalize_links``."""
    _origin, variants = _origin_variants(final_url)
    page_path = _url_page_path(final_url)
    label = urllib.parse.urlsplit(final_url).hostname or "page"
    page = _relativize_html(page, variants)
    page = _carry_stylesheets(carrier, label, page_path, page)
    page = _carry_inline_styles(carrier, label, page_path, page)
    page = carrier.rewrite_media(label, page_path, page)
    page = _externalize_links(page, final_url, resolve_link)
    return _normalize_charset(_strip_scripts(page))


# ── capture engines ─────────────────────────────────────────────────────────
#
# Two ways to turn a URL into ZIM-ready HTML, behind one two-call interface:
#
#   fetch(url)                          -> (final_url, html, bytes, language)
#   render(target, html, final_url, …)  -> the HTML that ships in the ZIM
#
# ``builtin`` is what Zimi has always done: fetch the document the server sent,
# carry its same-origin assets, drop the JavaScript that could never run
# offline. ``rendered`` (zimi.renderer, soft dependency) drives a headless
# Chromium and keeps what the BROWSER ended up with — the lazy-loaded images,
# the cross-origin fonts, the pages that build themselves.
#
# The interface exists so the three capture shapes — one page, several pages,
# a bounded site crawl — each run either engine over the SAME frontier, robots
# policy, politeness interval, budgets and progress lines. An engine decides
# what a page is; it decides nothing about how a capture behaves.
#
# ``target`` is the ``(add_item, item_factory)`` pair an asset ends up in: a
# live Creator for the page modes, the crawl's on-disk AssetSpool when there is
# no Creator yet. Passed per call rather than held, because a single-page
# capture does not know its Creator until after it has fetched.

# ``alive`` (zimi.alive) is a third shape rather than a third engine of the
# same kind: it satisfies the same two calls, but its product is a WARC on
# disk that warc2zim turns into a ZIM, not items in a Creator. The callers that
# package a ZIM themselves therefore dispatch it away before they start; see
# ``create_page_zim`` and ``crawler.create_site_zim``.
CAPTURE_ENGINES = ("builtin", "rendered", "alive", "singlefile")
DEFAULT_ENGINE = "builtin"
# Every engine a person may ASK for, which is not the same set as the engines
# ``capture_engine`` can build. zimit is the difference: it is a real choice in
# the CLI and the web form, but it never becomes a capture object — it is
# orchestration, a docker run whose product is a finished ZIM.
#
# These were one tuple until zimit was promoted to the web form, and collapsing
# the two meanings broke three things at once: capture_engine("zimit") raised
# "unknown engine", the multi-URL path started accepting an engine that takes a
# single URL, and — the one a user would actually have met — asking for zimit
# silently ran the alive engine instead. Two names, because there are two ideas.
OFFERED_ENGINES = CAPTURE_ENGINES + ("zimit",)
# Engines that write their own output file instead of filling a Creator. Both
# are dispatched away before packaging starts — but to DIFFERENT places, so
# membership here answers "does this fill a Creator?" and nothing else. It is
# not a dispatch target; see ``create_page_zim``.
ARCHIVE_ENGINES = ("alive", "zimit")


def creator_target(creator):
    """Assets go straight into a live Creator."""
    return (creator.add_item, make_asset_item)


def spool_target(spool):
    """Assets go to disk, to be drained into a Creator that does not exist
    yet — see ``AssetSpool``."""
    return (spool.add, _spooled_asset)


class BuiltinCapture:
    """The fast engine: one HTTP fetch per page, no JavaScript.

    Holds only what is shared ACROSS pages — the asset dedupe map, the byte
    budget, the mimetypes that landed. Every page still gets its own carrier,
    so the per-page asset caps stay per page exactly as they always have."""

    name = "builtin"
    # An application shell has nothing in it for this engine to capture, and
    # saying so is better than writing a ZIM full of loading spinners.
    refuses_spa = True
    # No outside program makes this capture — it is urllib and this file. The
    # empty dict is the answer, not a missing one, and it is what leaves a
    # builtin ZIM's provenance naming no engine version.
    tools = {}

    def __init__(
        self,
        *,
        timeout=DEFAULT_FETCH_TIMEOUT,
        max_redirects=DEFAULT_MAX_REDIRECTS,
        budget=None,
        carried=None,
        note=None,
        work_dir=None,
        block_ads=None,
        capture_variants=None,
    ):
        # ``work_dir``, ``block_ads`` and ``capture_variants`` are accepted and
        # unused, the way every engine accepts the shared option set: one
        # construction call has to serve three engines. Both switches genuinely
        # mean nothing here — this engine fetches what a page's own markup names
        # and nothing else, so there is no third-party request to refuse and no
        # archive to sweep variants into — and the surfaces refuse the flags
        # rather than let anyone believe otherwise (see ``_block_ads_from_args``
        # and ``manage._create_validate``).
        self._timeout = timeout
        self._max_redirects = max_redirects
        self._budget = budget
        # This engine fetches a page's images during the WRITE, so the run pane
        # has nothing to show for minutes unless the carry reports itself.
        self._note = note or (lambda _m: None)
        self._last_note = [0.0]
        self.carried = {} if carried is None else carried
        self.mimetypes = set()
        self.count = 0

    def start(self):
        return self

    def fetch(self, url):
        return _fetch_html(
            url, timeout=self._timeout, max_redirects=self._max_redirects
        )

    def render(self, target, html, final_url, resolve_link=None):
        import time as _time

        sink, item_factory = target

        def _progress(count, total_bytes):
            # At most one line a second: this fires per asset, and a page can
            # carry four hundred of them.
            now = _time.monotonic()
            if now - self._last_note[0] < 1.0:
                return
            self._last_note[0] = now
            self._note(f"carried {count} assets, {total_bytes} bytes")

        carrier = http_asset_carrier(
            sink,
            final_url,
            self._timeout,
            carried=self.carried,
            budget=self._budget,
            item_factory=item_factory,
            on_progress=_progress,
        )
        out = render_captured_page(
            carrier, html, final_url=final_url, resolve_link=resolve_link
        )
        self.mimetypes |= carrier.mimetypes
        self.count += carrier.count
        return out

    def close(self):
        pass

    def __enter__(self):
        return self.start()

    def __exit__(self, *_exc):
        self.close()


# Engines that can refuse a request before it is made, which is to say the ones
# that drive a browser. The fast engine fetches only what a page's own markup
# references; there is no third-party sprawl there to block, and offering the
# option would be offering a switch that does nothing.
BLOCKING_ENGINES = ("rendered", "alive")


def engine_blocks_ads(engine):
    """Whether ad blocking means anything for the named engine."""
    return str(engine or DEFAULT_ENGINE).strip().lower() in BLOCKING_ENGINES


def report_blocked(capture, note):
    """Say what a capture refused, and hand back the provenance object.

    ``{"blocked": {…}}`` when anything was blocked and ``{}`` when nothing was.
    Spread-ready in both shapes, which is the point: every call site puts it
    into a result dict with ``**`` and into the creation record with
    ``blocked=…``, and neither has to ask whether blocking ran.

    An empty dict rather than a zero, deliberately. A ``blocked`` field that
    said nothing was refused would be indistinguishable in the stored record
    from a capture that ran with blocking switched off, and those are different
    facts about how a ZIM was made."""
    from zimi.blocklist import blocked_record, blocked_summary

    requests = int(getattr(capture, "blocked", 0) or 0)
    if requests <= 0:
        return {}
    domains = len(getattr(capture, "blocked_hosts", None) or ())
    note(blocked_summary(requests, domains))
    record = blocked_record(requests, domains, getattr(capture, "blocklist", None))
    return {"blocked": record} if record else {}


def capture_tools(capture):
    """The outside programs a capture ran, ``{name: version}``, for the
    provenance record.

    Read through ``getattr`` for the same reason ``report_blocked`` does: the
    call sites hold an engine, and an engine that names no outside tool simply
    has nothing to say. ``history_record`` drops an empty dict, so a builtin
    capture's record comes out exactly as it did before this existed — which is
    what makes the presence of a tool a fact rather than a default."""
    return dict(getattr(capture, "tools", None) or {})


def capture_engine(engine=DEFAULT_ENGINE, **kwargs):
    """The named engine, ready to start. Raises ``CreateError`` for a name
    nothing answers to — a typo must not silently capture the other way."""
    name = str(engine or DEFAULT_ENGINE).strip().lower()
    if name in ("", "builtin"):
        return BuiltinCapture(**kwargs)
    if name == "rendered":
        # Imported here and nowhere else: the rendered engine reaches for
        # Playwright, and a Zimi that never renders a page never pays for the
        # import.
        from zimi.renderer import RenderedCapture

        return RenderedCapture(
            work_dir=kwargs.get("work_dir"),
            budget=kwargs.get("budget"),
            carried=kwargs.get("carried"),
            note=kwargs.get("note"),
            block_ads=kwargs.get("block_ads"),
            capture_variants=kwargs.get("capture_variants"),
        )
    if name == "singlefile":
        # SingleFile hands back ONE self-contained document, so it satisfies
        # the engine contract without a resource map: there are no sibling
        # assets to carry and nothing to rewrite, because everything the page
        # needs is already inside it.
        from zimi.singlefile import SingleFileCapture

        return SingleFileCapture(
            note=kwargs.get("note"),
            block_ads=kwargs.get("block_ads"),
            work_dir=kwargs.get("work_dir"),
        )
    if name == "alive":
        from zimi.alive import AliveCapture

        return AliveCapture(
            work_dir=kwargs.get("work_dir"),
            budget=kwargs.get("budget"),
            carried=kwargs.get("carried"),
            note=kwargs.get("note"),
            block_ads=kwargs.get("block_ads"),
            capture_variants=kwargs.get("capture_variants"),
        )
    if name in OFFERED_ENGINES:
        # A real engine that simply does not live here. Worth its own sentence:
        # the alternative is telling somebody the name they read in our own
        # --help is unknown, and sending them to look for a typo there isn't.
        raise CreateError(
            f"the {name} engine does not build a capture engine — it writes its "
            "own ZIM and is dispatched before packaging starts. This is a "
            "routing mistake in Zimi, not a bad engine name."
        )
    raise CreateError(
        f"unknown capture engine: {engine} — the engines are "
        + ", ".join(OFFERED_ENGINES)
    )


def create_page_zim(
    url,
    *,
    out_dir=None,
    out_path=None,
    title=None,
    description=None,
    language=LANGUAGE_AUTO,
    creator_name="Zimi",
    timeout=DEFAULT_FETCH_TIMEOUT,
    max_redirects=DEFAULT_MAX_REDIRECTS,
    engine=DEFAULT_ENGINE,
    block_ads=None,
    capture_variants=None,
    register=False,
    progress=None,
):
    """Fetch ONE page over HTTP(S) and package it with its same-origin
    assets. No crawling, no JavaScript. Returns the same summary dict shape
    as ``create_folder_zim`` (plus ``"url"``, ``"language"`` and
    ``"language_source"``); raises ``CreateError`` with a user-facing message
    on refusal (offline mode, SPA shell, non-HTML, caps, network failure).

    ``progress`` is called at each phase boundary. It is not decoration: the
    web job's sink RAISES out of it to cancel, so a capture with no callback
    is a capture whose cancel button cannot work. The phases are the two that
    can actually take time — the fetch, and carrying the page's assets."""
    from zimi.p2p import is_offline

    note = progress or (lambda _message: None)

    # Two engines do not fill a Creator, so neither can come down this function
    # — everything below here packages a ZIM, and these two produce one of their
    # own. Each is sent on before any of that starts, and to its OWN entry
    # point: they are alike in not filling a Creator and alike in nothing else.
    # Routing both to the same place is precisely the bug that made asking for
    # zimit quietly hand back an alive capture.
    #
    # The checks skipped here (offline, scheme) are the first thing each of them
    # does itself.
    name = str(engine or "").strip().lower()
    if name == "zimit":
        from zimi.crawler import create_zimit_zim

        return create_zimit_zim(
            url,
            site=False,
            out_dir=out_dir,
            out_path=out_path,
            title=title,
            description=description,
            language=language,
            creator_name=creator_name,
            register=register,
            progress=progress,
        )
    if name == "alive":
        from zimi.alive import create_alive_page_zim

        return create_alive_page_zim(
            url,
            out_dir=out_dir,
            out_path=out_path,
            title=title,
            description=description,
            language=language,
            creator_name=creator_name,
            block_ads=block_ads,
            capture_variants=capture_variants,
            register=register,
            progress=progress,
        )
    if is_offline():
        raise CreateError(
            "ZIMI_OFFLINE is set — refusing to fetch from the network. "
            "Page capture needs internet access; folder mode "
            "(zimi create <folder>) works fully offline."
        )
    scheme = urllib.parse.urlsplit(url).scheme.lower()
    if scheme not in ("http", "https"):
        raise CreateError(f"not an http(s) URL: {url}")

    capture = capture_engine(
        engine,
        timeout=timeout,
        max_redirects=max_redirects,
        note=note,
        work_dir=scratch_dir(out_dir, out_path),
        block_ads=block_ads,
        capture_variants=capture_variants,
    )
    blocked = {}
    try:
        note(f"fetching {url}")
        final_url, page, _n, clang = capture.fetch(url)
        blocked = report_blocked(capture, note)
        if capture.refuses_spa and looks_like_spa(page):
            raise CreateError(SPA_REFUSAL)
        language, language_source = resolve_language(language, page, clang)

        parsed = urllib.parse.urlsplit(final_url)
        zim_title = title or _page_title_from_html(page, parsed.netloc + parsed.path)
        base = _slug(f"{parsed.netloc} {parsed.path}", "page")
        out = _finish_output(out_dir or _srv.ZIM_DIR, out_path, base)

        static_cls = zim_static_item_class()
        with atomic_zim_creator(out, language) as creator:
            raw_page = page  # the declared <link rel=icon> lives in the raw HTML
            # render() is where a page's images are DOWNLOADED, so the run is
            # still fetching here — announcing "packaging" before it put the
            # strip a step ahead of the truth and hung the asset counter under
            # the wrong heading (Eric: "growing on the package step not fetch
            # step? Fetch is all download steps"). The packaging line moves to
            # where the writing actually starts.
            page = capture.render(creator_target(creator), page, final_url)
            note(f"packaging {final_url}")
            creator.add_item(static_cls("A/index", zim_title, page.encode("utf-8")))
            creator.set_mainpath("A/index")
            add_standard_metadata(
                creator,
                title=zim_title,
                description=description
                or f"One page captured from {parsed.netloc} by Zimi",
                language=language,
                creator_name=creator_name,
                source=final_url,
                # The whole URL: two pages from one site are two ZIMs, and
                # recapturing either one is a new edition of that one.
                name=zim_name(final_url, language),
                tags=media_tags(capture.mimetypes),
                illustration=site_illustration(final_url, timeout, raw_page),
                history=history_record(
                    "created",
                    "page",
                    f"captured one page from {final_url}"
                    + blocked_phrase(blocked.get("blocked")),
                    tools=capture_tools(capture),
                    counts={"pages": 1, "assets": capture.count},
                    blocked=blocked.get("blocked"),
                ),
            )
    finally:
        # However this ended — written, refused, cancelled from the progress
        # sink — the browser goes with it. A rendered capture that leaves a
        # Chromium behind is a capture that leaks a couple of hundred megabytes
        # per attempt.
        capture.close()

    registered = _try_register(out) if register else False
    return {
        "path": out,
        "pages": 1,
        "assets": capture.count,
        "main": "A/index",
        "registered": registered,
        "url": final_url,
        "engine": capture.name,
        "language": language,
        "language_source": language_source,
        **blocked,
    }


# ── Tier 2b: several pages → one ZIM ────────────────────────────────────────


def _pages_index_html(title, entries, skipped):
    """The cover of a multi-page capture: what is inside, in the order it was
    asked for, each page named by its own title and labelled with where it came
    from. Pages that could not be captured are named too — a collection that
    quietly drops two of five URLs is a collection that lies about itself."""
    body = [f"<h1>{_html.escape(title)}</h1>"]
    body.append(
        "<p style='color:#666'>"
        + _plural(len(entries), "page")
        + " captured by Zimi</p>"
    )
    body.append("<ol class='zimi-index'>")
    for entry in entries:
        parsed = urllib.parse.urlsplit(entry["final_url"])
        where = _html.escape(parsed.netloc + parsed.path)
        body.append(
            f"<li><a href='{_html.escape(entry['name'])}'>"
            f"{_html.escape(entry['title'])}</a>"
            f"<br><span style='color:#999;font-size:.85em'>{where}</span></li>"
        )
    body.append("</ol>")
    if skipped:
        body.append("<h2 class='zimi-section'>Not captured</h2>")
        body.append("<ol class='zimi-index'>")
        for url, why in skipped:
            body.append(
                f"<li style='color:#999'>{_html.escape(url)} — {_html.escape(why)}</li>"
            )
        body.append("</ol>")
    return (
        _page_head(_html.escape(title)) + "<body>" + "".join(body) + "</body></html>"
    ).encode("utf-8")


def _pages_title(entries):
    """A title for a collection nobody named: the shared host when every page
    came from one, else the first host and a count."""
    hosts = []
    for entry in entries:
        host = urllib.parse.urlsplit(entry["final_url"]).netloc
        if host and host not in hosts:
            hosts.append(host)
    if len(hosts) == 1:
        return f"{_plural(len(entries), 'page')} from {hosts[0]}"
    return f"{_plural(len(entries), 'page')} from {hosts[0]} and elsewhere"


def _pages_scope(entries):
    """The IDENTITY of a multi-page capture: the SET of URLs it holds. Two
    captures of the same set are editions of one ZIM; add a URL and it is a
    different collection, which is exactly what a different Name means. The
    digest is over the sorted final URLs, so the order they were typed in does
    not fork the identity."""
    urls = sorted(entry["final_url"] for entry in entries)
    digest = hashlib.sha1("\n".join(urls).encode("utf-8")).hexdigest()[:10]
    host = urllib.parse.urlsplit(urls[0]).netloc or "pages"
    return f"{host} pages {digest}"


def create_pages_zim(
    urls,
    *,
    out_dir=None,
    out_path=None,
    title=None,
    description=None,
    language=LANGUAGE_AUTO,
    creator_name="Zimi",
    timeout=DEFAULT_FETCH_TIMEOUT,
    max_redirects=DEFAULT_MAX_REDIRECTS,
    engine=DEFAULT_ENGINE,
    block_ads=None,
    capture_variants=None,
    register=False,
    progress=None,
):
    """Capture SEVERAL pages into ONE ZIM with a generated index.

    Each page runs the identical per-page pipeline as a single capture; what is
    added is a shared asset dedupe map (one copy of a stylesheet two pages both
    pull), link resolution BETWEEN the captured pages (a link from one to
    another lands inside the ZIM), and the cover page that makes the result a
    collection rather than a heap.

    The two passes — fetch everything, then write everything — are what the
    ZIM's own identity needs: its language is a vote of the pages and its Name
    is a digest of the set, so neither is knowable until the last page is in.
    Both engines survive the gap because neither holds a page's assets in
    memory across it: the fast engine has not fetched them yet, and the
    rendered engine has them spooled on disk.

    A single URL is handed straight to ``create_page_zim`` — one page is one
    page, and wrapping it in an index nobody asked for would be a worse ZIM.

    The alive engine is REFUSED here for more than one URL, and the refusal is
    the honest answer rather than a missing feature: this shape's whole product
    is a generated cover page linking captured articles together, and an alive
    capture has no articles to link — warc2zim writes the ZIM and its entries
    are URLs, so there is nowhere for a Zimi-authored index to live and nothing
    for it to point at."""
    from zimi.p2p import is_offline

    note = progress or (lambda _m: None)
    wanted = []
    for raw in urls or ():
        text = str(raw or "").strip()
        if not text:
            continue
        if urllib.parse.urlsplit(text).scheme.lower() not in ("http", "https"):
            raise CreateError(f"not an http(s) URL: {text}")
        if text not in wanted:
            wanted.append(text)
    if not wanted:
        raise CreateError("no URLs to capture")
    if len(wanted) > MAX_PAGE_URLS:
        raise CreateError(
            f"that is {len(wanted)} URLs and the limit is {MAX_PAGE_URLS} — "
            "capture the rest separately, or crawl the site with --site"
        )
    if len(wanted) == 1:
        return create_page_zim(
            wanted[0],
            out_dir=out_dir,
            out_path=out_path,
            title=title,
            description=description,
            language=language,
            creator_name=creator_name,
            timeout=timeout,
            max_redirects=max_redirects,
            engine=engine,
            block_ads=block_ads,
            capture_variants=capture_variants,
            register=register,
            progress=progress,
        )
    # Correct for both members: an engine that writes its own ZIM has no
    # Creator for a second page to go into. Named rather than assumed — the
    # message said "the alive engine" to everyone, including the person who
    # asked for zimit.
    archive_engine = str(engine or "").strip().lower()
    if archive_engine in ARCHIVE_ENGINES:
        raise CreateError(
            f"the {archive_engine} engine captures one page or one site, not a "
            f"list of pages — give it a single URL, or crawl "
            f"{urllib.parse.urlsplit(wanted[0]).netloc} with --site"
        )
    if is_offline():
        raise CreateError(
            "ZIMI_OFFLINE is set — refusing to fetch from the network. "
            "Page capture needs internet access; folder mode "
            "(zimi create <folder>) works fully offline."
        )

    from zimi.crawler import normalize_url

    capture = capture_engine(
        engine,
        timeout=timeout,
        max_redirects=max_redirects,
        note=note,
        work_dir=scratch_dir(out_dir, out_path),
        block_ads=block_ads,
        capture_variants=capture_variants,
    )
    entries, skipped, taken, detected = [], [], {"index"}, []
    blocked = {}
    try:
        for url in wanted:
            note(f"fetching {url}")
            try:
                final_url, page, _n, clang = capture.fetch(url)
            except CreateError as e:
                note(f"  skipped {url}: {e}")
                skipped.append((url, str(e)))
                continue
            if capture.refuses_spa and looks_like_spa(page):
                note(f"  skipped {url}: it is an empty application shell")
                skipped.append((url, "an empty application shell — nothing to capture"))
                continue
            parsed = urllib.parse.urlsplit(final_url)
            base = _slug(f"{parsed.netloc} {parsed.path}", "page")
            name, n = base, 2
            while name in taken:
                name = f"{base}_{n}"
                n += 1
            taken.add(name)
            code, where = detect_page_language(page, clang)
            if code:
                detected.append((code, where))
            entries.append(
                {
                    "name": name,
                    "requested": url,
                    "final_url": final_url,
                    "page": page,
                    "title": _page_title_from_html(page, parsed.netloc + parsed.path),
                }
            )
        blocked = report_blocked(capture, note)
        if not entries:
            raise CreateError(
                "none of those pages could be captured — "
                + "; ".join(f"{url}: {why}" for url, why in skipped)
            )

        # One ZIM carries one Language. The pages voted; the most common answer
        # wins, and the first page breaks a tie because it is the one the person
        # typed first.
        named = requested_language(language)
        if named:
            language, language_source = named, "requested"
        elif detected:
            codes = [code for code, _where in detected]
            language = max(set(codes), key=lambda c: (codes.count(c), -codes.index(c)))
            language_source = next(w for c, w in detected if c == language)
        else:
            language, language_source = DEFAULT_LANGUAGE, "fallback"

        zim_title = title or _pages_title(entries)
        out = _finish_output(
            out_dir or _srv.ZIM_DIR, out_path, _slug(_pages_scope(entries), "pages")
        )
        # A link may name either what was typed or where that landed, so both
        # identities resolve into the ZIM.
        by_key = {}
        for entry in entries:
            by_key.setdefault(normalize_url(entry["final_url"]), entry["name"])
            by_key.setdefault(normalize_url(entry["requested"]), entry["name"])

        def resolve(absolute):
            target, sep, fragment = absolute.partition("#")
            name = by_key.get(normalize_url(target))
            if not name:
                return None
            return name + (sep + fragment if sep else "")

        static_cls = zim_static_item_class()
        with atomic_zim_creator(out, language) as creator:
            for entry in entries:
                note(f"packaging {entry['final_url']}")
                # Assets go through the engine's SHARED dedupe map — the same
                # reason the site crawl does it: common assets stored once,
                # per-page caps still per page.
                html = capture.render(
                    creator_target(creator),
                    entry["page"],
                    entry["final_url"],
                    resolve_link=resolve,
                )
                creator.add_item(
                    static_cls(
                        "A/" + entry["name"], entry["title"], html.encode("utf-8")
                    )
                )
                entry["page"] = None  # written; do not hold every page at once
            creator.add_item(
                static_cls(
                    "A/index", zim_title, _pages_index_html(zim_title, entries, skipped)
                )
            )
            creator.set_mainpath("A/index")
            asset_count = sum(1 for v in capture.carried.values() if v)
            add_standard_metadata(
                creator,
                title=zim_title,
                description=description
                or f"{_plural(len(entries), 'page')} captured from the web by Zimi",
                language=language,
                creator_name=creator_name,
                source=entries[0]["final_url"],
                name=zim_name(_pages_scope(entries), language),
                tags=media_tags(capture.mimetypes),
                illustration=site_illustration(
                    entries[0]["final_url"], timeout, entries[0].get("page")
                ),
                history=history_record(
                    "created",
                    "pages",
                    f"captured {_plural(len(entries), 'page')} from the web"
                    + (f", skipping {len(skipped)}" if skipped else "")
                    + blocked_phrase(blocked.get("blocked")),
                    tools=capture_tools(capture),
                    counts={"pages": len(entries), "assets": asset_count},
                    blocked=blocked.get("blocked"),
                ),
            )
    finally:
        capture.close()

    return {
        "path": out,
        "pages": len(entries),
        "assets": asset_count,
        "engine": capture.name,
        "main": "A/index",
        "registered": _try_register(out) if register else False,
        "url": entries[0]["final_url"],
        "urls": [entry["final_url"] for entry in entries],
        "skipped": [url for url, _why in skipped],
        "language": language,
        "language_source": language_source,
        **blocked,
    }


# ── pre-flight probes ───────────────────────────────────────────────────────
#
# A capture is a commitment: minutes of a Pi's attention, a file in the library,
# sometimes gigabytes. The probes exist so nobody has to make that commitment
# blind — they answer "what would this actually give me?" using a tiny, HARD-
# CAPPED fraction of the work the real run would do. Every one of them is
# bounded by construction rather than by good behaviour, because the machine
# under this is often a Raspberry Pi that is also serving the library.

_ASSET_REF_RE = re.compile(
    r"""<(?:img|source|link|script)\b[^>]*?\b(?:src|href)\s*=\s*"""
    r"""(?:"([^"]*)"|'([^']*)'|([^\s">]+))""",
    re.IGNORECASE,
)


# How long the preview will wait for a site's icon. Short on purpose: the icon
# is decoration and the preview is something a person is watching, so a slow
# favicon host costs the preview nothing rather than holding it up.
PROBE_ICON_TIMEOUT = 4.0


def probe_page(
    url, *, timeout=DEFAULT_FETCH_TIMEOUT, max_redirects=DEFAULT_MAX_REDIRECTS
):
    """Fetch ONE page and report what capturing it would produce. Exactly one
    HTTP request — the same one the real capture starts with — so the preview
    costs what looking at the page in a browser costs."""
    final_url, page, nbytes, clang = _fetch_html(
        url, timeout=timeout, max_redirects=max_redirects
    )
    parsed = urllib.parse.urlsplit(final_url)
    language, language_source = resolve_language(LANGUAGE_AUTO, page, clang)
    assets = page_asset_refs(page, final_url)
    return {
        "url": final_url,
        "title": _page_title_from_html(page, parsed.netloc + parsed.path),
        "language": language,
        "language_source": language_source,
        "spa": looks_like_spa(page),
        "bytes": nbytes,
        "assets": len(assets),
        "icon": _probe_icon_data_uri(final_url, timeout, page),
    }


def page_asset_refs(page, final_url):
    """Every distinct file this page references, without fetching one.

    The honest thing a preview can say before a capture starts. Shared by the
    CLI probe and the web one — they used to count separately and only one of
    them counted at all, which is how the Create page ended up promising a
    number the other half of the code had already learned was wrong.

    Cross-origin refs count. They used to be skipped because the engine could
    not carry them; it carries them now — a page's images mostly live on a
    sibling CDN — and counting only same-origin ones reported "24 assets" for a
    page that lands 400.

    A srcset counts ONCE, for the candidate the capture will keep: counting all
    of them was right when all of them were fetched and became an over-estimate
    the moment that stopped being true."""
    from zimi.zimwriter import _SRCSET_RE, _split_srcset, pick_srcset

    _origin, variants = _origin_variants(final_url)
    refs = set()
    for m in _ASSET_REF_RE.finditer(page):
        ref = _strip_origin(_first_group(m).strip(), variants)
        if ref and not ref.startswith(("#", "data:")):
            refs.add(ref)
    for m in _SRCSET_RE.finditer(page):
        picked = pick_srcset(_split_srcset(m.group("val")))
        if not picked:
            continue
        ref = _strip_origin(picked[0].strip(), variants)
        if ref and not ref.startswith(("#", "data:")):
            refs.add(ref)
    return refs


def _probe_icon_data_uri(final_url, timeout, page):
    """The site's icon as a ``data:`` URI, or None.

    So the Create page can show WHOSE page is being captured while it is being
    captured. A capture runs for a minute and a half and the screen carried
    nothing identifying for any of it — the site's own mark, up front, is the
    cheapest way to say "yes, the right thing is happening".

    A data URI rather than a URL on purpose. Zimi's UI never reaches the open
    internet; the server is already holding this page's HTML and is already
    the thing with a network connection, so it does the fetching and hands
    back bytes. The browser makes no request it would not otherwise make.

    Best effort in the same way ``site_illustration`` is: the icon is
    decoration, and a preview must never fail — or wait noticeably longer —
    because a favicon did not answer."""
    try:
        png = site_illustration(final_url, min(timeout, PROBE_ICON_TIMEOUT), page=page)
    except Exception as e:
        log.debug("probe could not fetch an icon for %s: %s", final_url, e)
        return None
    if not png:
        return None
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


# How far a folder preview looks and how much of it it is willing to read. Two
# levels is what a person can take in at a glance, and the entry cap is what
# keeps a preview of a 200,000-file volume from being a disk-thrashing scan.
PROBE_FOLDER_DEPTH = 2
PROBE_FOLDER_MAX_ENTRIES = 4000
_DOC_EXTS = {".pdf", ".epub", ".txt", ".rst"}
_MEDIA_EXTS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".bmp",
    ".ico",
    ".mp4",
    ".webm",
    ".mkv",
    ".mov",
    ".mp3",
    ".m4a",
    ".ogg",
    ".opus",
    ".wav",
}


def _file_kind(name):
    """Which column of a folder preview a file belongs in."""
    ext = os.path.splitext(name)[1].lower()
    if ext in _HTML_EXTS or ext in _MD_EXTS:
        return "pages"
    if ext in _DOC_EXTS:
        return "documents"
    if ext in _MEDIA_EXTS:
        return "media"
    return "other"


def _empty_counts():
    return {"pages": 0, "documents": 0, "media": 0, "other": 0}


def probe_folder(
    root, *, depth=PROBE_FOLDER_DEPTH, max_entries=PROBE_FOLDER_MAX_ENTRIES
):
    """What packaging this folder would sweep up, two levels down.

    Counts are per directory and NOT recursive past the depth shown — a preview
    that recursed a whole volume to be exact would be the expensive thing the
    preview exists to avoid. ``truncated`` says when the entry budget ran out,
    so a partial answer never reads as a complete one."""
    root = os.path.realpath(os.path.expanduser(root))
    if not os.path.isdir(root):
        raise CreateError(f"not a folder: {root}")
    budget = [max_entries]

    def scan(path, level):
        node = {"counts": _empty_counts(), "children": [], "deeper": False}
        try:
            with os.scandir(path) as it:
                for entry in it:
                    if budget[0] <= 0:
                        node["deeper"] = True
                        break
                    budget[0] -= 1
                    if entry.name.startswith(".") or entry.name.lower() in _JUNK_NAMES:
                        continue
                    if entry.is_symlink():
                        continue  # a capture never follows one; nor does its preview
                    if entry.is_dir(follow_symlinks=False):
                        if level < depth:
                            child = scan(entry.path, level + 1)
                            child["name"] = entry.name
                            node["children"].append(child)
                        else:
                            node["deeper"] = True
                    elif entry.is_file(follow_symlinks=False):
                        node["counts"][_file_kind(entry.name)] += 1
        except OSError as e:
            raise CreateError(f"cannot read that folder: {e.strerror or e}")
        node["children"].sort(key=lambda c: c["name"].lower())
        return node

    tree = scan(root, 0)
    tree["name"] = os.path.basename(root.rstrip(os.sep)) or root
    totals = _empty_counts()

    def add(node):
        for key, value in node["counts"].items():
            totals[key] += value
        for child in node["children"]:
            add(child)

    add(tree)
    return {
        "path": root,
        "tree": tree,
        "totals": totals,
        "truncated": budget[0] <= 0,
    }


# ── CLI ─────────────────────────────────────────────────────────────────────


def _note(message):
    """Progress for the CLI: one line, flushed, so a forty-minute crawl looks
    alive in a terminal and in a piped log alike."""
    print(message, flush=True)


def _crawl_flag_state(args):
    """Which capture-shaping flags the command line actually set. Every caller
    that refuses a flag reads this, so "was it given?" is decided in one place
    and a new flag becomes one row rather than three."""
    return {
        "--site": bool(getattr(args, "site", False)),
        "--engine": getattr(args, "engine", "builtin") != "builtin",
        "--max-pages": getattr(args, "max_pages", None) is not None,
        "--max-depth": getattr(args, "max_depth", None) is not None,
        "--max-bytes": getattr(args, "max_bytes", None) is not None,
        "--delay": getattr(args, "delay", None) is not None,
        "--ignore-robots": bool(getattr(args, "ignore_robots", False)),
        "--engine-arg": bool(getattr(args, "engine_arg", None)),
        # Either spelling — --block-ads or --no-block-ads — sets this away from
        # None, and both are "the user said something about blocking".
        "--block-ads": getattr(args, "block_ads", None) is not None,
    }


def _is_http_url(text):
    return bool(re.match(r"^https?://", str(text or ""), re.IGNORECASE))


def _build_pages_from_args(args, sources):
    """Several sources on one command line means ONE ZIM holding several
    captured pages. Every flag that shapes a crawl or a video job is refused
    here — none of them describes this shape, and silently ignoring a flag
    somebody typed is how a capture surprises them."""
    not_urls = [src for src in sources if not _is_http_url(src)]
    if not_urls:
        raise CreateError(
            "several sources means several web pages in one ZIM, so every one "
            f"of them must be a URL — {not_urls[0]} is not"
        )
    engine = getattr(args, "engine", DEFAULT_ENGINE)
    given = _crawl_flag_state(args)
    if engine in CAPTURE_ENGINES:
        # Which ENGINE captures a page is not a crawl flag — it is the one
        # choice that means the same thing for one page and for twenty. zimit
        # is the exception and stays refused: it takes a single URL. Blocking
        # travels with the engine for the same reason.
        given["--engine"] = False
        given["--block-ads"] = False
    named = [flag for flag, was_given in given.items() if was_given]
    if named:
        raise CreateError(
            f"{', '.join(named)} applies to capturing one source — "
            "give a single URL to use it"
        )
    return create_pages_zim(
        sources,
        title=args.title,
        description=args.description,
        language=args.language,
        creator_name=args.creator,
        out_path=args.out,
        engine=engine,
        block_ads=_block_ads_from_args(args, engine),
        register=not args.out,
        progress=_note,
    )


def _block_ads_from_args(args, engine):
    """The blocking answer for this run, or None for "nobody said".

    Refused rather than ignored when the engine cannot block: --block-ads
    against the fast engine describes something that will not happen, and a
    flag that is accepted and does nothing is how a person ends up believing
    their capture blocked the advertising when it carried all of it."""
    wanted = getattr(args, "block_ads", None)
    if wanted is not None and not engine_blocks_ads(engine):
        raise CreateError(
            "--block-ads and --no-block-ads apply to --engine rendered and "
            "--engine alive, which drive a browser. The fast engine fetches "
            "only what the page's own markup references, so there is no "
            "third-party traffic there to refuse."
        )
    return wanted


def _build_from_args(args, src, is_url):
    """Pick the capture and run it. Folder, single page, bounded site crawl,
    or the zimit container — the flags that only make sense for one of those
    are refused here rather than silently ignored."""
    engine = getattr(args, "engine", "builtin")
    site = bool(getattr(args, "site", False))
    crawl_flags = _crawl_flag_state(args)

    def refuse(flags, because):
        named = [flag for flag in flags if crawl_flags[flag]]
        if named:
            raise CreateError(f"{', '.join(named)} {because}")

    if not is_url:
        refuse(crawl_flags, f"only applies to a URL capture — {src} is a folder")
        return create_folder_zim(
            src,
            title=args.title,
            description=args.description,
            language=args.language,
            creator_name=args.creator,
            out_path=args.out,
            register=not args.out,
        )

    from zimi import crawler

    common: "dict[str, Any]" = dict(
        title=args.title,
        description=args.description,
        language=args.language,
        creator_name=args.creator,
        out_path=args.out,
        register=not args.out,
    )
    builtin_only = ("--max-depth", "--max-bytes", "--delay", "--ignore-robots")
    if engine == "zimit":
        # zimit has its own crawl controls, its own robots policy and its own
        # browser; Zimi's would be quietly dropped on the floor. --engine-arg
        # is how you reach them.
        refuse(
            builtin_only + ("--block-ads",),
            "belongs to Zimi's own crawler, not to zimit — pass zimit's "
            "equivalent with --engine-arg",
        )
        return crawler.create_zimit_zim(
            src,
            site=site,
            max_pages=getattr(args, "max_pages", None),
            engine_args=getattr(args, "engine_arg", None) or (),
            progress=_note,
            **common,
        )
    refuse(("--engine-arg",), "only applies to --engine zimit")
    # Refused HERE for both shapes: blocking is the engine's property, so the
    # check is about which ENGINE was named and never about --site.
    block_ads = _block_ads_from_args(args, engine)
    if not site:
        refuse(
            ("--max-pages",) + builtin_only,
            "needs --site — without it Zimi captures exactly one page",
        )
        return create_page_zim(
            src, engine=engine, block_ads=block_ads, progress=_note, **common
        )
    return crawler.create_site_zim(
        src,
        engine=engine,
        block_ads=block_ads,
        max_pages=_flag_or(args, "max_pages", crawler.DEFAULT_MAX_PAGES),
        max_depth=_flag_or(args, "max_depth", crawler.DEFAULT_MAX_DEPTH),
        max_bytes=(
            crawler.parse_size(args.max_bytes)
            if getattr(args, "max_bytes", None) is not None
            else crawler.DEFAULT_MAX_BYTES
        ),
        delay=_flag_or(args, "delay", crawler.DEFAULT_DELAY),
        ignore_robots=bool(getattr(args, "ignore_robots", False)),
        progress=_note,
        **common,
    )


def _flag_or(args, name, default):
    value = getattr(args, name, None)
    return default if value is None else value


def cli_create(args):
    """`zimi create <folder-or-url> [<url>…]` — dispatch, then print a short
    honest summary. Exit 2 with a one-line message on any user-fixable failure,
    matching the backup/restore CLI convention."""
    sources = list(args.source) if isinstance(args.source, list) else [args.source]
    src = sources[0]
    # ONE source restores the exact pre-multi-URL contract for everything
    # downstream — the video arm and the zimit arm both read args.source, and
    # handing either of them a one-element list instead of the string it has
    # always been would be a silent break nothing else would catch.
    if len(sources) == 1:
        args.source = src
    is_url = _is_http_url(src)
    if is_url and len(sources) == 1:
        from zimi import video as _video

        if _video.wants_url(src, args):
            if _video.forced_by_flags(args):
                # Explicit video intent (--format/--audio-only/--limit): the
                # video path succeeds or exits 2, no page-capture fallback.
                _video.cli_create_video(args)
                return
            # Auto-detected as a video because a yt-dlp extractor claimed the
            # URL — but many pages (a BBC news article, say) merely EMBED a
            # video, so the guess is often wrong. Try it; if no video comes out,
            # capture the PAGE instead of failing the whole command with a
            # yt-dlp error (Eric: `zimi create <bbc.com/news/…>`).
            try:
                info = _video.build_video(args)
            except Exception as e:
                log.info(
                    "video capture did not apply to %s (%s); capturing the page",
                    src,
                    e,
                )
                print("  no video here — capturing the page instead")
            else:
                _video.print_video_summary(info, args)
                return
    try:
        info = (
            _build_pages_from_args(args, sources)
            if len(sources) > 1
            else _build_from_args(args, src, is_url)
        )
    except CreateError as e:
        print(f"zimi: {e}", file=sys.stderr)
        sys.exit(2)
    print(f"ZIM written: {info['path']}")
    if info.get("engine") == "zimit":
        print(f"  captured by zimit: {info['url']}")
    elif info.get("urls") is not None:
        print(f"  captured: {_plural(info['pages'], 'page')} into one ZIM")
        for captured in info["urls"]:
            print(f"    {captured}")
        for missed in info.get("skipped") or ():
            print(f"    not captured: {missed}")
        print(f"  assets carried: {info['assets']}")
    elif is_url and info.get("bytes") is not None:
        print(f"  captured: {info['url']}")
        print(
            f"  {_plural(info['pages'], 'page')}, "
            f"{_plural(info['assets'], 'asset')}, "
            f"{_fmt_bytes(info['bytes'])} fetched"
        )
        if info.get("stopped"):
            print(
                f"  the crawl stopped at its {info['stopped']} — everything "
                "captured up to that point is in the ZIM"
            )
    elif is_url:
        print(f"  captured: {info['url']}")
        print(f"  assets carried: {info['assets']}")
    else:
        print(
            f"  {_plural(info['pages'], 'page')}, "
            f"{_plural(info['assets'], 'file')}; main page: {info['main']}"
        )
    if info["registered"]:
        print("  registered in the library — no rescan needed")
    elif not args.out:
        print(
            "  note: library registration failed; the file is in place and "
            "will appear on the next library scan"
        )
