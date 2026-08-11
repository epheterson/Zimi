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

Both modes share the writer plumbing in ``zimwriter``: the lazy item
classes, ``atomic_zim_creator`` (tmp-then-replace — a partial ZIM never
appears under its final name), ``add_standard_metadata``, and
``_register_exports`` so a ZIM written into the library directory shows up
without a full rescan.
"""

import html as _html
import logging
import mimetypes
import os
import pathlib
import posixpath
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

import zimi.server as _srv
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
    atomic_zim_creator,
    make_asset_item,
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
DEFAULT_FETCH_TIMEOUT = 30.0
DEFAULT_MAX_REDIRECTS = 5
# An SPA shell has scripts and (nearly) no server-rendered text. The
# threshold is deliberately low: real articles clear it by an order of
# magnitude, and a false "SPA" verdict on a tiny page is a clear error
# message, not a broken ZIM.
SPA_MIN_TEXT_CHARS = 200

_MD_EXTS = {".md", ".markdown"}
_HTML_EXTS = {".html", ".htm"}
_JUNK_NAMES = {"thumbs.db", "desktop.ini", "__pycache__"}
_HTML_MIME = "text/html;charset=utf-8"

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
_A_TAG_RE = re.compile(r"<a\b[^>]*>", re.IGNORECASE)
_ABS_ATTR_RE = re.compile(
    r"""(\b(src|href|srcset)\s*=\s*)(["'])(.*?)\3""", re.IGNORECASE | re.DOTALL
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
    language="eng",
    creator_name="Zimi",
    register=False,
):
    """Package a folder of files into one ZIM. Returns a summary dict:
    ``{"path", "pages", "assets", "main", "registered"}``. Raises
    ``CreateError`` for anything the user must fix (missing folder, size
    caps, unwritable output)."""
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

    base_name = os.path.basename(folder.rstrip(os.sep)) or "folder"
    zim_title = title or base_name
    out = _finish_output(out_dir or _srv.ZIM_DIR, out_path, _slug(base_name, "folder"))

    static_cls = zim_static_item_class()
    file_cls = _zim_file_item_class()
    total_bytes = 0
    pages = []  # (zim_path, title) — front articles for the generated index
    assets = []  # zim_path
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
                    # Pass through untouched: relative links resolve because
                    # the whole folder ships at its original paths.
                    page_title = _page_title_from_html(
                        text, posixpath.splitext(stem)[0]
                    )
                    content = text.encode("utf-8")
                else:
                    content, page_title = _render_markdown_page(
                        text, posixpath.splitext(stem)[0]
                    )
                creator.add_item(
                    static_cls(zim_path, page_title, content, mimetype=_HTML_MIME)
                )
                pages.append((zim_path, page_title))
            else:
                creator.add_item(
                    file_cls(zim_path, stem, fs_path, _guess_mime(zim_path))
                )
                assets.append(zim_path)

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
        )

    registered = _try_register(out) if register else False
    return {
        "path": out,
        "pages": len(pages),
        "assets": len(assets),
        "main": main_path,
        "registered": registered,
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
        if len(data) > MAX_PAGE_FETCH_BYTES:
            raise CreateError(
                f"page is over the {_fmt_bytes(MAX_PAGE_FETCH_BYTES)} fetch cap"
            )
        return url, data, ctype
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
        prefix, attr, quote, val = m.group(1), m.group(2), m.group(3), m.group(4)
        if attr.lower() == "srcset":
            parts = []
            for cand in val.split(","):
                bits = cand.strip().split()
                if bits:
                    bits[0] = _strip_origin(bits[0], variants)
                parts.append(" ".join(bits))
            val = ", ".join(parts)
        else:
            val = _strip_origin(val, variants)
        return prefix + quote + val + quote

    return _ABS_ATTR_RE.sub(fix, page)


def _relativize_css(text, variants):
    def fix(m):
        quote, ref = m.group(1), m.group(2)
        return "url(" + quote + _strip_origin(ref, variants) + quote + ")"

    return _CSS_URL_RE.sub(fix, text)


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
            with urllib.request.urlopen(req, timeout=timeout) as resp:
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


def _replace_href(tag, new_ref):
    return _HREF_RE.sub(
        lambda m: "href=" + m.group(1) + new_ref + m.group(1), tag, count=1
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
        if not relm or "stylesheet" not in relm.group(2).lower():
            return tag
        hrefm = _HREF_RE.search(tag)
        if not hrefm:
            return tag
        resolved = _resolve_ref(page_path, hrefm.group(2))
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


def _externalize_links(page, base_url):
    """Make every off-page ``<a href>`` absolute against the final URL —
    a single-page ZIM has nowhere else to navigate, so links point back at
    the live web (the reader marks absolute URLs as external). Fragment,
    mailto:, javascript:, and data: links stay untouched."""

    def fix(m):
        tag = m.group(0)

        def fix_href(hm):
            val = hm.group(2).strip()
            if not val or val.startswith("#"):
                return hm.group(0)
            head = val.split("/", 1)[0]
            if ":" in head and not val.lower().startswith(("http:", "https:")):
                return hm.group(0)  # mailto:, javascript:, data:, tel:
            return (
                "href="
                + hm.group(1)
                + urllib.parse.urljoin(base_url, val)
                + hm.group(1)
            )

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


def create_page_zim(
    url,
    *,
    out_dir=None,
    out_path=None,
    title=None,
    description=None,
    language="eng",
    creator_name="Zimi",
    timeout=DEFAULT_FETCH_TIMEOUT,
    max_redirects=DEFAULT_MAX_REDIRECTS,
    register=False,
):
    """Fetch ONE page over HTTP(S) and package it with its same-origin
    assets. No crawling, no JavaScript. Returns the same summary dict shape
    as ``create_folder_zim`` (plus ``"url"``); raises ``CreateError`` with a
    user-facing message on refusal (offline mode, SPA shell, non-HTML,
    caps, network failure)."""
    from zimi.p2p import is_offline

    if is_offline():
        raise CreateError(
            "ZIMI_OFFLINE is set — refusing to fetch from the network. "
            "Page capture needs internet access; folder mode "
            "(zimi create <folder>) works fully offline."
        )
    scheme = urllib.parse.urlsplit(url).scheme.lower()
    if scheme not in ("http", "https"):
        raise CreateError(f"not an http(s) URL: {url}")

    final_url, data, ctype = _fetch_page(
        url, timeout=timeout, max_redirects=max_redirects
    )
    if ctype and "html" not in ctype.lower():
        raise CreateError(
            f"not an HTML page (Content-Type: {ctype.split(';')[0]}) — "
            "only web pages can be captured this way"
        )
    page = _decode_page(data, ctype)
    if looks_like_spa(page):
        raise CreateError(
            "this page is an empty application shell — its content is built "
            "by JavaScript in the browser, and Zimi does not run one. "
            "Capture it with a browser-based tool such as zimit "
            "(https://github.com/openzim/zimit), then add the resulting ZIM "
            "to your library."
        )

    parsed = urllib.parse.urlsplit(final_url)
    origin, variants = _origin_variants(final_url)
    page_path = parsed.path.lstrip("/")
    if not page_path or page_path.endswith("/"):
        page_path += "index.html"
    label = parsed.hostname or "page"

    zim_title = title or _page_title_from_html(page, parsed.netloc + parsed.path)
    base = _slug(f"{parsed.netloc} {parsed.path}", "page")
    out = _finish_output(out_dir or _srv.ZIM_DIR, out_path, base)

    static_cls = zim_static_item_class()
    with atomic_zim_creator(out, language) as creator:
        carrier = _AssetCarrier(
            creator.add_item,
            make_asset_item,
            _http_asset_reader(origin, variants, timeout),
        )
        page = _relativize_html(page, variants)
        page = _carry_stylesheets(carrier, label, page_path, page)
        page = _carry_inline_styles(carrier, label, page_path, page)
        page = carrier.rewrite_media(label, page_path, page)
        page = _externalize_links(page, final_url)
        page = _strip_scripts(page)
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
        )

    registered = _try_register(out) if register else False
    return {
        "path": out,
        "pages": 1,
        "assets": carrier.count,
        "main": "A/index",
        "registered": registered,
        "url": final_url,
    }


# ── CLI ─────────────────────────────────────────────────────────────────────


def cli_create(args):
    """`zimi create <folder-or-url>` — dispatch, then print a short honest
    summary. Exit 2 with a one-line message on any user-fixable failure,
    matching the backup/restore CLI convention."""
    src = args.source
    is_url = bool(re.match(r"^https?://", src, re.IGNORECASE))
    if is_url:
        from zimi import video as _video

        if _video.wants_url(src, args):
            _video.cli_create_video(args)
            return
    build = create_page_zim if is_url else create_folder_zim
    try:
        info = build(
            src,
            title=args.title,
            description=args.description,
            language=args.language,
            creator_name=args.creator,
            out_path=args.out,
            register=not args.out,
        )
    except CreateError as e:
        print(f"zimi: {e}", file=sys.stderr)
        sys.exit(2)
    print(f"ZIM written: {info['path']}")
    if is_url:
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
