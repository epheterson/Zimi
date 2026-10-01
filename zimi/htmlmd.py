"""A ZIM page as Markdown, split into its sections.

What an agent reads. /read and /chunks give a page's words as one run of
plain text, which is right for a snippet or an embedding and wrong for a
model that wants to know where the History section starts, which row of the
infobox said what, or what the formula was. This keeps the structure a page
has (headings, lists, tables, the infobox, code, math as TeX) and drops what
a reader never needed: navigation, edit links, footnote marks, navboxes,
images, and the references unless they are asked for.

One pass of the stdlib's html.parser builds a small tree; the renderer walks
it. Written for mwoffliner's Wikipedia pages first and plain enough for
everything else: devdocs, Gutenberg, Stack Exchange bodies, a Zimi capture.

    doc = to_markdown(html, title="Ant")
    doc.sections[0]          # the intro, before the first heading
    doc.text()               # the whole page
    doc.text(doc.find("Morphology"))   # one section with its subsections
"""

import re
from html.parser import HTMLParser

# Elements whose end tag can be left out: the start of one closes the open
# one, up to the element that holds them.
_VOID = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
}
_CLOSES = {
    "li": ("li", {"ul", "ol", "menu"}),
    "dt": ("dt dd", {"dl"}),
    "dd": ("dt dd", {"dl"}),
    "tr": ("tr td th", {"table", "tbody", "thead", "tfoot"}),
    "td": ("td th", {"tr", "table"}),
    "th": ("td th", {"tr", "table"}),
    "option": ("option", {"select"}),
}
_P_ENDERS = {
    "p",
    "div",
    "section",
    "article",
    "table",
    "ul",
    "ol",
    "dl",
    "pre",
    "blockquote",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "header",
    "footer",
    "aside",
    "nav",
    "details",
    "form",
}
# What never reaches the reader: not text, or chrome around the text.
_SKIP_TAGS = {
    "script",
    "style",
    "noscript",
    "template",
    "head",
    "nav",
    "button",
    "input",
    "select",
    "textarea",
    "svg",
    "iframe",
    "video",
    "audio",
    "object",
    "embed",
    "canvas",
    "map",
    "footer",
    "aside",
    "link",
    "meta",
}
_SKIP_CLASSES = {
    "mw-editsection",
    "mw-jump-link",
    "toc",
    "mw-toc",
    "toclimit-2",
    "toclimit-3",
    "navbox",
    "navbox-styles",
    "vertical-navbox",
    "sidebar",
    "metadata",
    "ambox",
    "ombox",
    "tmbox",
    "cmbox",
    "fmbox",
    "imbox",
    "catlinks",
    "printfooter",
    "noprint",
    "sistersitebox",
    "side-box",
    "portalbox",
    "portal",
    "shortdescription",
    "mw-empty-elt",
    "reference",
    "mw-ref",
    "mw-cite-backlink",
    "cite-bracket",
    "mw-indicators",
    "navigation-not-searchable",
    "authority-control",
    "Z3988",
    "noviewer",
    "mwe-math-mathml-a11y",
    "mw-references-wrap--hidden",
    "hidden",
}
# The references, dropped unless asked for.
_REF_CLASSES = {"references", "reflist", "mw-references-wrap", "refbegin"}
# Section names whose whole section is the references, in the languages the
# big wikis are written in. "See also" is kept: it is short and it is
# reading, not citation.
_REF_HEADING_RE = re.compile(
    r"^(?:references?|notes?|notes and references|references and notes|"
    r"footnotes|citations?|sources|bibliography|further reading|"
    r"external links|works cited|cited works|explanatory notes|"
    r"general(?: and cited)? (?:references|sources)|cited sources|"
    r"einzelnachweise|anmerkungen|literatur|weblinks|"
    r"références|notes et références|liens externes|bibliographie|"
    r"referencias|notas|enlaces externos|bibliografía|"
    r"note|riferimenti|collegamenti esterni|bibliografia|"
    r"примечания|литература|ссылки)$",
    re.I,
)
_BLOCK_TAGS = {
    "address",
    "article",
    "aside",
    "blockquote",
    "body",
    "caption",
    "center",
    "dd",
    "details",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "html",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
}
_HEADINGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
_CODE_TAGS = {"code", "kbd", "samp", "tt", "var"}
_TEX_WRAP_RE = re.compile(
    r"^\{\\(?:displaystyle|textstyle|scriptstyle)\s*(.*)\}$", re.S
)
_LANG_RE = re.compile(r"(?:^|\s)(?:language|lang|brush:?)-?([\w+#.-]+)")
_SPACE_BEFORE_PUNCT_RE = re.compile(r"[ \t]+([,.;:!?)\]])")
_SPACE_AFTER_OPEN_RE = re.compile(r"([(\[]) +")
_FENCE = "```"
# What read shows at once (about 2,500 tokens); past it, the intro and an
# outline. A section longer than PART_CHARS is cut into numbered parts.
PAGE_CHARS = 10000
PART_CHARS = 8000
# A table this long is cut: the rest is a note, not tokens.
TABLE_ROWS_MAX = 60
# rowspan/colspan beyond this are a malformed page, not a layout.
_SPAN_MAX = 20


class _Node:
    __slots__ = ("tag", "attrs", "children")

    def __init__(self, tag, attrs=None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children = []

    def classes(self):
        return set((self.attrs.get("class") or "").split())


class _TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node("#root")
        self.stack = [self.root]

    def _close_to(self, names, fence):
        """Close the nearest open element named in ``names``, unless an
        element in ``fence`` holds it first."""
        for i in range(len(self.stack) - 1, 0, -1):
            tag = self.stack[i].tag
            if tag in names:
                del self.stack[i:]
                return
            if tag in fence:
                return

    def handle_starttag(self, tag, attrs):
        if tag in _CLOSES:
            names, fence = _CLOSES[tag]
            self._close_to(set(names.split()), fence)
        if tag in _P_ENDERS:
            self._close_to({"p"}, {"td", "th", "li", "div", "section", "blockquote"})
        node = _Node(tag, {k: v or "" for k, v in attrs})
        self.stack[-1].children.append(node)
        if tag not in _VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in _VOID and self.stack[-1].tag == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if data:
            self.stack[-1].children.append(data)


def parse(html):
    builder = _TreeBuilder()
    builder.feed(html or "")
    builder.close()
    return builder.root


def _find(node, pred):
    """The first element under ``node`` (depth first) that ``pred`` takes."""
    for child in node.children:
        if isinstance(child, _Node):
            if pred(child):
                return child
            got = _find(child, pred)
            if got is not None:
                return got
    return None


def _content_root(root):
    """Where the page's own text is: mwoffliner's content div, a <main> or
    <article>, the body, in that order."""
    for pred in (
        lambda n: n.attrs.get("id") == "mw-content-text",
        lambda n: "mw-parser-output" in n.classes(),
        lambda n: n.tag == "main",
        lambda n: n.tag == "article",
        lambda n: n.tag == "body",
    ):
        got = _find(root, pred)
        if got is not None:
            return got
    return root


def _raw_text(node):
    """Every character under ``node``, whitespace kept (a <pre>'s body)."""
    out = []
    for child in node.children:
        if isinstance(child, str):
            out.append(child)
        elif child.tag == "br":
            out.append("\n")
        elif child.tag not in ("script", "style"):
            out.append(_raw_text(child))
    return "".join(out)


def _tex(node):
    """The TeX behind a math element, or ""."""
    math = node if node.tag == "math" else _find(node, lambda n: n.tag == "math")
    tex = ""
    if math is not None:
        tex = math.attrs.get("alttext", "")
        if not tex:
            ann = _find(
                math,
                lambda n: n.tag == "annotation"
                and "tex" in n.attrs.get("encoding", "").lower(),
            )
            tex = _raw_text(ann) if ann is not None else ""
    if not tex:
        img = node if node.tag == "img" else _find(node, lambda n: n.tag == "img")
        if img is not None:
            tex = img.attrs.get("alt", "")
    tex = tex.strip()
    m = _TEX_WRAP_RE.match(tex)
    return (m.group(1) if m else tex).strip()


def _is_math(node):
    cls = node.classes()
    return (
        node.tag == "math"
        or "mwe-math-element" in cls
        or (node.tag == "img" and any(c.startswith("mwe-math-fallback") for c in cls))
    )


def _math_display(node):
    """Display math (its own line) rather than math inside a sentence."""

    def shown(n):
        return n.attrs.get("display") == "block" or any(
            c.startswith("mwe-math") and c.endswith("display") for c in n.classes()
        )

    return shown(node) or _find(node, shown) is not None


class Section:
    __slots__ = ("index", "level", "heading", "blocks")

    def __init__(self, index, level, heading):
        self.index = index
        self.level = level
        self.heading = heading
        self.blocks = []

    def body(self):
        return "\n\n".join(self.blocks)


class Document:
    """A page's sections in order. Section 0 is the intro: what comes
    before the first heading, and has no heading of its own."""

    def __init__(self, title, sections):
        self.title = title
        self.sections = sections

    def find(self, key):
        """A section by its index, or by its heading: exact first, then the
        one heading that starts with ``key``, then the one containing it,
        ignoring case. None when nothing or more than one matches."""
        key = str(key).strip()
        if key.lower() in ("intro", "lead", "introduction"):
            return self.sections[0]
        if key.isdigit():
            i = int(key)
            return self.sections[i] if 0 <= i < len(self.sections) else None
        want = _norm(key)
        if not want:
            return None
        named = self.sections[1:]
        exact = [s for s in named if _norm(s.heading) == want]
        if exact:
            return exact[0]
        for test in (lambda h: h.startswith(want), lambda h: want in h):
            hits = [s for s in named if test(_norm(s.heading))]
            if hits:
                return hits[0] if len(hits) == 1 else None
        return None

    def span(self, section):
        """``section`` and the subsections under it."""
        out = [section]
        for s in self.sections[section.index + 1 :]:
            if section.index == 0 or s.level <= section.level:
                break
            out.append(s)
        return out

    def text(self, section=None):
        parts = []
        for s in self.span(section) if section is not None else self.sections:
            if s.index and s.heading:
                parts.append("#" * s.level + " " + s.heading)
            if s.blocks:
                parts.append(s.body())
        return "\n\n".join(parts).strip()

    def outline(self, within=None):
        """The headings as a numbered list a model can pick from."""
        sections = self.span(within)[1:] if within is not None else self.sections[1:]
        base = min((s.level for s in sections), default=2)
        lines = []
        for s in sections:
            size = sum(len(b) for x in self.span(s) for b in x.blocks)
            lines.append(
                "  " * (s.level - base) + f"{s.index}. {s.heading} ({_size(size)})"
            )
        return "\n".join(lines)


def _size(chars):
    return f"{chars:,} chars" if chars < 1000 else f"{chars / 1000:.1f}k chars"


def _norm(s):
    """A heading or an anchor ("In_culture") as one comparable form."""
    return re.sub(r"[\s_]+", " ", (s or "").strip().lower())


class _Renderer:
    def __init__(self, references):
        self.references = references
        self.sections = [Section(0, 1, "")]

    # ── deciding what is text ────────────────────────────────────────────
    def skip(self, node):
        if node.tag in _SKIP_TAGS:
            return True
        cls = node.classes()
        if cls & _SKIP_CLASSES:
            return True
        if not self.references and cls & _REF_CLASSES:
            return True
        if node.attrs.get("role") == "navigation":
            return True
        style = node.attrs.get("style", "").replace(" ", "").lower()
        return "display:none" in style

    # ── inline: one paragraph's text ──────────────────────────────────────
    def inline(self, node):
        out = []
        for child in node.children:
            if isinstance(child, str):
                out.append(re.sub(r"\s+", " ", child))
                continue
            if _is_math(child):
                tex = _tex(child)
                if tex:
                    fence = "$$" if _math_display(child) else "$"
                    out.append(f"{fence}{tex}{fence}")
                continue
            if self.skip(child):
                continue
            tag = child.tag
            if tag == "br":
                out.append("\n")
            elif tag == "img":
                continue
            elif tag in ("b", "strong"):
                out.append(_wrap(self.inline(child), "**"))
            elif tag in ("i", "em", "cite"):
                out.append(_wrap(self.inline(child), "*"))
            elif tag in _CODE_TAGS:
                code = re.sub(r"\s+", " ", _raw_text(child)).strip()
                if code:
                    tick = "``" if "`" in code else "`"
                    out.append(f"{tick}{code}{tick}")
            elif tag == "sup":
                text = self.inline(child).strip()
                if text:
                    out.append("^" + text)
            elif tag in _BLOCK_TAGS:
                out.append("\n" + self.inline(child) + "\n")
            else:
                out.append(self.inline(child))
        return "".join(out)

    def para(self, nodes_or_node):
        holder = nodes_or_node
        if isinstance(nodes_or_node, list):
            holder = _Node("#frag")
            holder.children = nodes_or_node
        return _tidy(self.inline(holder))

    # ── blocks ────────────────────────────────────────────────────────────
    def emit(self, text):
        if text and text.strip():
            self.sections[-1].blocks.append(text.strip("\n"))

    def blocks(self, node):
        pending = []

        def flush():
            if pending:
                self.emit(self.para(list(pending)))
                pending.clear()

        for child in node.children:
            if isinstance(child, _Node) and child.tag in _BLOCK_TAGS and not _is_math(child):
                flush()
                if not self.skip(child):
                    self.block(child)
            else:
                pending.append(child)
        flush()

    def block(self, node):
        tag = node.tag
        if tag in _HEADINGS:
            text = self.para(node)
            if text:
                self.sections.append(Section(len(self.sections), _HEADINGS[tag], text))
        elif tag in ("ul", "ol"):
            self.emit(self.list_(node, 0))
        elif tag == "dl":
            self.emit(self.dl(node))
        elif tag == "table":
            self.table(node)
        elif tag == "pre":
            self.emit(self.pre(node))
        elif tag == "blockquote":
            inner = _Renderer(self.references)
            inner.blocks(node)
            text = "\n\n".join(b for s in inner.sections for b in s.blocks)
            self.emit(
                "\n".join("> " + line if line else ">" for line in text.split("\n"))
            )
        elif tag == "figure":
            cap = _find(node, lambda n: n.tag == "figcaption")
            text = self.para(cap) if cap is not None else ""
            if text:
                self.emit(f"[Image: {text}]")
        elif tag == "hr":
            pass
        else:
            self.blocks(node)

    def pre(self, node):
        code = _raw_text(node).strip("\n")
        if not code.strip():
            return ""
        lang = node.attrs.get("data-language", "")
        if not lang:
            for probe in (node, _find(node, lambda n: n.tag == "code")):
                if probe is None:
                    continue
                m = _LANG_RE.search(probe.attrs.get("class", ""))
                if m:
                    lang = m.group(1)
                    break
        fence = _FENCE + ("`" if _FENCE in code else "")
        return f"{fence}{lang}\n{code}\n{fence}"

    def list_(self, node, depth):
        lines = []
        n = 0
        start = node.attrs.get("start", "1")
        first = int(start) if start.isdigit() else 1
        for li in node.children:
            if not isinstance(li, _Node) or li.tag != "li" or self.skip(li):
                continue
            nested = []
            own = []
            for c in li.children:
                if isinstance(c, _Node) and c.tag in ("ul", "ol") and not self.skip(c):
                    nested.append(c)
                elif isinstance(c, _Node) and self.skip(c) and not _is_math(c):
                    continue
                else:
                    own.append(c)
            text = self.para(own).replace("\n", " ")
            marker = f"{first + n}." if node.tag == "ol" else "-"
            n += 1
            if text:
                lines.append("  " * depth + f"{marker} {text}")
            for sub in nested:
                got = self.list_(sub, depth + 1)
                if got:
                    lines.append(got)
        return "\n".join(lines)

    def dl(self, node):
        lines = []
        for c in node.children:
            if not isinstance(c, _Node) or self.skip(c):
                continue
            text = self.para(c).replace("\n", " ")
            if not text:
                continue
            if c.tag == "dt":
                lines.append(f"**{text}**")
            elif c.tag == "dd":
                lines.append(f": {text}")
        return "\n".join(lines)

    # ── tables ────────────────────────────────────────────────────────────
    def _rows(self, table):
        rows = []

        def walk(n):
            for c in n.children:
                if not isinstance(c, _Node) or self.skip(c):
                    continue
                if c.tag == "tr":
                    rows.append(c)
                elif c.tag in ("thead", "tbody", "tfoot"):
                    walk(c)

        walk(table)
        return rows

    def _cells(self, tr):
        return [
            c
            for c in tr.children
            if isinstance(c, _Node) and c.tag in ("td", "th") and not self.skip(c)
        ]

    def table(self, node):
        cls = node.classes()
        caption = _find(node, lambda n: n.tag == "caption")
        title = self.para(caption) if caption is not None else ""
        if any("infobox" in c or c in ("taxobox", "biota") for c in cls):
            self.emit(self.infobox(node, title))
            return
        rows = self._rows(node)
        nested = _find(node, lambda n: n.tag == "table")
        if nested is not None or not rows:
            # A table used for layout: its cells are the page's blocks.
            for tr in rows or []:
                for cell in self._cells(tr):
                    self.blocks(cell)
            if not rows:
                self.blocks(node)
            return
        grid = self.grid(rows)
        width = max((len(r) for r, _ in grid), default=0)
        if width <= 1:
            text = "\n".join(r[0] for r, _ in grid if r and r[0])
            self.emit((f"**{title}**\n" if title else "") + text)
            return
        header, head_is_th = grid[0]
        body = grid[1:] if head_is_th or len(grid) > 1 else grid
        if not head_is_th and len(grid) > 1:
            header = grid[0][0]
        if not head_is_th and len(grid) == 1:
            header = [""] * width
        lines = []
        if title:
            lines.append(f"**{title}**")
        lines.append(_pipe_row(header, width))
        lines.append("|" + "---|" * width)
        cut = len(body) - TABLE_ROWS_MAX
        for row, _ in body[:TABLE_ROWS_MAX]:
            lines.append(_pipe_row(row, width))
        if cut > 0:
            lines.append(f"({cut} more rows)")
        self.emit("\n".join(lines))

    def grid(self, rows):
        """Each row's cell texts, with colspans and rowspans filled in so the
        columns line up. Returns [(cells, all_header)]."""
        out = []
        carry = {}  # column -> (rows left, text)
        for tr in rows:
            cells = self._cells(tr)
            row = []
            col = 0
            all_th = bool(cells)

            def take_carry():
                nonlocal col
                while col in carry:
                    left, text = carry[col]
                    row.append(text)
                    if left <= 1:
                        del carry[col]
                    else:
                        carry[col] = (left - 1, text)
                    col += 1

            for cell in cells:
                take_carry()
                text = _cell(self.para(cell))
                all_th = all_th and cell.tag == "th"
                span = _span(cell.attrs.get("colspan"))
                down = _span(cell.attrs.get("rowspan"))
                for k in range(span):
                    row.append(text)
                    if down > 1:
                        carry[col] = (down - 1, text)
                    col += 1
            take_carry()
            if any(row):
                out.append((row, all_th))
        return out

    def infobox(self, node, title):
        lines = [f"**{title}**"] if title else []
        for tr in self._rows(node):
            cells = [c for c in self._cells(tr)]
            texts = [_cell(self.para(c)) for c in cells]
            texts = [t for t in texts if t]
            if not texts:
                continue
            if len(texts) >= 2:
                key = texts[0].rstrip(":").strip()
                lines.append(f"{key}: {' | '.join(texts[1:])}")
            elif cells and cells[0].tag == "th":
                lines.append(f"**{texts[0]}**")
            else:
                lines.append(texts[0])
        return "\n".join(lines)


def _span(raw):
    try:
        return max(1, min(int(str(raw).strip() or 1), _SPAN_MAX))
    except ValueError:
        return 1


def _cell(text):
    """A cell's lines as one line: a list in a cell reads "a; b; c"."""
    return re.sub(r";\s*(?=[,.;:])", "", text.replace("\n", "; "))


def _pipe_row(cells, width):
    cells = list(cells) + [""] * (width - len(cells))
    return "| " + " | ".join(c.replace("|", "\\|") for c in cells[:width]) + " |"


def _wrap(text, mark):
    core = text.strip()
    if not core:
        return text
    lead = text[: len(text) - len(text.lstrip())]
    trail = text[len(text.rstrip()) :]
    return f"{lead}{mark}{core}{mark}{trail}"


def _tidy(text):
    lines = []
    for line in text.split("\n"):
        line = re.sub(r"[ \t]+", " ", line).strip()
        line = _SPACE_BEFORE_PUNCT_RE.sub(r"\1", line)
        line = _SPACE_AFTER_OPEN_RE.sub(r"\1", line)
        lines.append(line)
    return re.sub(r"\n{2,}", "\n", "\n".join(lines)).strip()


def to_markdown(html, title="", references=False):
    """``html`` as a Document. ``references`` keeps the reference lists and
    the sections that hold only them (References, Notes, External links...),
    which are half of a long Wikipedia article and rarely what a question
    needs."""
    root = _content_root(parse(html))
    r = _Renderer(references)
    r.blocks(root)
    sections = r.sections
    # The page's own title as its first heading says what the caller
    # already prints.
    if (
        len(sections) > 1
        and sections[1].level == 1
        and _norm(sections[1].heading) == _norm(title)
    ):
        sections[0].blocks.extend(sections[1].blocks)
        del sections[1]
    if not references:
        sections = _drop_reference_sections(sections)
    return _finish(title, sections)


def _drop_reference_sections(sections):
    out = []
    dropping = None
    for s in sections:
        if dropping is not None:
            if s.level > dropping:
                continue
            dropping = None
        if s.index and _REF_HEADING_RE.match(s.heading.strip()):
            dropping = s.level
            continue
        out.append(s)
    return out


def from_blocks(title, parts):
    """A Document from parts already split: [(level, heading, markdown)].
    The first part with no heading is the intro."""
    sections = [Section(0, 1, "")]
    for level, heading, text in parts:
        if heading:
            sections.append(Section(len(sections), level, heading))
        if text and text.strip():
            sections[-1].blocks.append(text.strip())
    return _finish(title, sections)


def _finish(title, sections):
    """Number the sections, splitting any too long to read at once into
    parts, so every word of a book with no headings is still reachable."""
    out = []
    for s in sections:
        groups = _groups(s.blocks)
        s.blocks = groups[0] if groups else []
        out.append(s)
        for k, blocks in enumerate(groups[1:], 2):
            part = Section(0, s.level + 1 if s.heading else 2, "")
            part.heading = f"{s.heading or 'Start'} (part {k} of {len(groups)})"
            part.blocks = blocks
            out.append(part)
    for i, s in enumerate(out):
        s.index = i
    return Document(title, out)


def _groups(blocks):
    """``blocks`` in runs of at most PART_CHARS, a block longer than that
    cut at its line breaks."""
    pieces = []
    for b in blocks:
        while len(b) > PART_CHARS:
            cut = b.rfind("\n", 0, PART_CHARS)
            if cut <= 0:
                cut = b.rfind(" ", 0, PART_CHARS)
            if cut <= 0:
                cut = PART_CHARS
            pieces.append(b[:cut].rstrip())
            b = b[cut:].lstrip("\n ")
        if b:
            pieces.append(b)
    groups, cur, size = [], [], 0
    for b in pieces:
        if cur and size + len(b) > PART_CHARS:
            groups.append(cur)
            cur, size = [], 0
        cur.append(b)
        size += len(b) + 2
    if cur:
        groups.append(cur)
    return groups


def view(doc, section=None, limit=None):
    """What an agent is shown: the page, or a section with its subsections,
    when it fits in ``limit`` chars; otherwise its own text, then a numbered
    outline of what is under it to ask for next."""
    limit = limit or PAGE_CHARS
    whole = doc.text(section)
    if len(whole) <= limit:
        return whole
    if section is None or section.index == 0:
        own = doc.sections[0].body()
        outline = doc.outline()
        where = "the intro"
        kind = "page"
    else:
        own = "#" * section.level + " " + section.heading
        if section.blocks:
            own += "\n\n" + section.body()
        outline = doc.outline(section)
        where = "its opening"
        kind = "section"
    note = (
        f"[Long {kind} ({_size(len(whole))}): showing {where}. "
        "Call read_section with a number or heading below.]"
    )
    return f"{own}\n\n{note}\n{outline}".strip()
