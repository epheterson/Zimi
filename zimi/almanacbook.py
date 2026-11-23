"""The Almanac's book of tables as a PDF, typeset without a browser.

The page sends the book it has drawn (almanac-tables.js _tbBookDoc: the HTML of every chapter as it stands, its page
rules, its MathML). This lays it out with PyMuPDF's own HTML engine (MuPDF's Story: already a requirement of Zimi, so
nothing is added) in Charis SIL, the serif MuPDF carries (it is Bitstream Charter's design, the face the browser's PDF
used), and draws what that engine does not: the equations (zimi/almanacmath.py), the small pictures (the Moon's phases,
the plotting sheet) as vectors, the running heads and feet, the contents' page numbers and dotted leaders, the links and
the outline. Every font is embedded as a subset.

``render(html, paper)`` -> the PDF's bytes.
"""

import html as _html
import io
import logging
import os
import re
import sys

import pymupdf

from zimi import almanacmath

log = logging.getLogger("zimi")

# ── The page ──
PAPER = {"A4": "a4", "Letter": "letter"}
MARGIN = (
    17 * 72 / 25.4,
    18 * 72 / 25.4,
)  # the browser book's @page margin: 17 mm at the sides, 18 at top and foot
HEAD_FOOT_PT = 8  # the running heads' and feet's size
HEAD_GAP = 4 * 72 / 25.4  # a head stands this far above the text block's top
HEAD_COLOUR = (0.2, 0.2, 0.2)
FIRST_FOOT_COLOUR = (0.4, 0.4, 0.4)
MATH_PT = 10  # the equations' size (.tb-eq-m math)
# Tables broken across pages are laid out again until each page's chunk keeps its own rows (its head said again).
SPLIT_PASSES = 10
MAX_PAGES = 600  # far past any book the Almanac makes (76 pages for everything)
LEADER_DOT = 0.9  # the contents' dotted leader: the dot's width and its gap, pt
LEADER_GAP = 2.2
LEADER_COLOUR = (0.47, 0.47, 0.47)

# The print palette the book's CSS sets (.alm-book): what its pictures' var() colours are on paper.
_PRINT_VARS = {
    "--text": "#000",
    "--text2": "#222",
    "--text3": "#333",
    "--border": "#000",
    "--tb-rule": "#999",
    "--surface": "#fff",
    "--surface2": "#fff",
    "--bg": "#fff",
    "--amber": "#000",
    "--amber-glow": "transparent",
    "--amber-border": "#000",
}

# The book's look, for MuPDF's engine: the values of the browser's print stylesheet (almanac-reference.css, the
# .alm-book rules), with its var() and calc() worked out (13pt is a line, 6.5pt half of one).
CSS_AT_FULL_SIZE = """
body { font-family: serif; font-size: 9.5pt; line-height: 13pt; color: #000; margin: 0; }
p { margin: 0; }
a { color: #000; text-decoration: none; }
ul { margin: 0; padding-left: 4.5mm; }
li { margin: 0; }
.zcont { margin-top: 0 !important; padding-top: 0 !important; border-top: 0 !important; }
.tb-vh, .tb-at, .tk-hint, .tk-step, .tk-swap, .tk-caret { display: none; }

/* The title page */
.tb-book-title { padding-top: 62mm; text-align: center; }
.tb-book-title .tb-book-kicker { margin: 0 0 6.5pt; font-size: 9pt; }
.tb-book-title .tb-book-name { width: 130mm; margin: 0 0 19.5pt; padding-bottom: 13pt; border-bottom: 1.2pt solid #000; font-size: 30pt; line-height: 36pt; }
.tb-book-title p { font-size: 10.5pt; line-height: 13pt; }
.tb-book-title .tb-book-place { margin-bottom: 6.5pt; font-size: 13pt; line-height: 19.5pt; }
.tb-book-title .tb-book-showing { margin-top: 13pt; font-style: italic; }
.tb-made { margin: 6.5pt 0 0; font-size: 8.5pt; font-style: italic; color: #333; }
.tb-book-title .tb-made { margin-top: 52pt; font-size: 8.5pt; font-style: italic; color: #333; }

/* The contents */
.tb-book-toc { margin: 0 28mm; padding-top: 26pt; }
.tb-book-toc h1 { margin: 26pt 0 19.5pt; font-size: 19pt; font-weight: normal; line-height: 26pt; }
.tb-toc-part { margin: 13pt 0 6.5pt; font-size: 10pt; font-weight: bold; }
.tb-toc-pn { font-weight: normal; font-size: 7.5pt; }
table.toc { width: 100%; border-collapse: collapse; }
table.toc td { padding: 0; text-align: left !important; font-size: 10pt; line-height: 16.25pt; vertical-align: baseline; }
table.toc td.n { width: 9.5mm; }
table.toc td.pg { width: 9mm; text-align: right; }
.tb-toc-sub { font-size: 8.5pt; font-style: italic; color: #333; }

/* A part's page */
.tb-book-part { padding-top: 62mm; text-align: center; }
.tb-part-n { display: block; margin-bottom: 6.5pt; font-size: 9pt; }
.tb-part-name { display: block; margin: 0 auto 26pt; padding-bottom: 13pt; border-bottom: 1.2pt solid #000; font-size: 30pt; line-height: 36pt; }
table.partlist { margin: 0 auto; border-collapse: collapse; }
table.partlist td { padding: 0; font-size: 10.5pt; line-height: 18.2pt; text-align: left; }
table.partlist td.n { width: 9mm; }

/* A chapter's head */
.tb-printhead { margin: 0 0 13pt; padding: 0 0 6.5pt; border-bottom: 0.8pt solid #000; }
.tb-printhead h2 { margin: 0; font-size: 19pt; font-weight: normal; line-height: 26pt; }
.tb-ch-n { color: #333; }
.tb-printhead p { font-size: 10pt; line-height: 13pt; }
.tb-sub { font-style: italic; }

/* Tables */
table.tb-table { border-collapse: collapse; font-size: 8.5pt; line-height: 10pt; border-top: 1pt solid #000; border-bottom: 1pt solid #000; }
table.tb-table th, table.tb-table td { white-space: nowrap; padding: 1.5pt 5pt; border-bottom: 0.3pt solid #999; text-align: right; }
table.tb-table thead th:first-child { text-align: left; }
table.tb-table thead th { white-space: nowrap; padding-top: 3pt; padding-bottom: 2.5pt; border-bottom: 0.7pt solid #000; font-size: 7.5pt; font-weight: bold; vertical-align: bottom; }
table.tb-table tbody th { font-weight: normal; text-align: left; }
table.tb-table tr.tb-six th, table.tb-table tr.tb-six td { border-bottom: 0.3pt solid #333; }
table.tb-table .tb-sep { border-left: 0.3pt solid #999; }
table.tb-table tr.tb-grp th { padding-top: 6.5pt; border-bottom: 0.7pt solid #000; font-size: 7.5pt; font-weight: bold; text-align: left; }
.tb-dim, .tb-lo, .tb-h { color: #333; }
.tb-feast { font-style: italic; }
table.tb-consts { width: 100%; }
table.tb-consts th, table.tb-consts td.tb-src, table.tb-wrap td, table.tb-wrap th, table.tb-steps th { white-space: normal; }
table.tb-table thead th[colspan] { text-align: center; }
table.tb-consts th { text-align: left; }
table.tb-consts td.tb-src { text-align: left; }
table.tb-steps th { text-align: left; }
table.tb-steps tr.tb-total th, table.tb-steps tr.tb-total td { border-top: 0.5pt solid #333; }
table.tb-steps tr.tb-total td { font-weight: bold; }
table.tb-eq-terms { font-size: 7pt; line-height: 8.5pt; }
table.tb-eq-terms th, table.tb-eq-terms td { padding-top: 0.5pt; padding-bottom: 0.5pt; }

table.ztwo .zgap { width: 8mm; border: 0; padding: 0; }
table.cols > tbody > tr > td { vertical-align: top; padding: 0; }
table.cols > tbody > tr > td.gap { width: 8mm; }
.tb-frame { margin: 0 0 6.5pt; }
.tb-note, .tb-lede { margin: 6.5pt 0 0; font-size: 8.5pt; line-height: 11pt; color: #222; }
.tb-lede { margin: 0 0 6.5pt; }
.tb-subh { margin: 13pt 0 6.5pt; font-size: 7.5pt; font-weight: bold; }
.tb-empty { padding: 13pt 0; border: 0.5pt solid #999; color: #222; text-align: center; }

/* How this is made, and the equations */
.tb-how { margin-top: 19.5pt; padding-top: 6.5pt; border-top: 0.7pt solid #000; font-size: 8.5pt; line-height: 11pt; }
.tb-sumh { margin: 0 0 6.5pt; font-size: 11pt; font-weight: bold; line-height: 15pt; }
.tb-eqs .tb-sumh { margin-top: 13pt; margin-bottom: 6.5pt; font-size: 10pt; }
.tb-how .tb-subh { margin: 6.5pt 0 2pt; }
.tb-how-k { font-style: italic; }
.zeq { margin: 0 0 3pt; padding: 5pt 0; text-align: center; line-height: 1pt; }
.zeq-l { margin: 3pt 0 0; font-size: 8pt; font-style: italic; line-height: 10pt; color: #222; }
table.zeq td { padding: 1pt 0; vertical-align: middle; }
table.zeq td.m { width: 82.5%; }
table.zeq td.tb-eq-l { width: 17.5%; padding-right: 4mm; font-size: 8pt; font-style: italic; line-height: 10pt; color: #222; }
.tb-eq-note { margin: 6.5pt 0; }

/* A calculation: the answer, its fields, the working */
.tk-answer { margin: 0 0 13pt; padding: 0 0 6.5pt; border-bottom: 0.5pt solid #000; }
.tk-big { font-size: 17pt; font-weight: bold; line-height: 19.5pt; }
.tk-sub { font-size: 10pt; font-style: italic; color: #222; }
.tk-group-h { margin: 13pt 0 2pt; font-size: 7.5pt; font-weight: bold; }
table.tk-rows { width: 100%; border-collapse: collapse; border-top: 0.7pt solid #000; border-bottom: 0.7pt solid #000; margin: 0; }
table.tk-rows td { padding: 1.5pt 0; font-size: 9.5pt; }
table.tk-rows tr + tr td { border-top: 0.3pt solid #999; }
table.tk-rows td.v { text-align: right; }
table.kv { border-collapse: collapse; margin: 0 0 6.5pt; }
table.kv td { padding: 1pt 6mm 1pt 0; vertical-align: baseline; }
table.kv td.k { font-size: 8pt; color: #333; }
table.kv td.v { font-size: 9.5pt; }
table.cal { width: 100%; border-collapse: collapse; border-top: 0.7pt solid #000; border-bottom: 0.7pt solid #000; margin: 6.5pt 0 0; }
table.cal td { padding: 1.5pt 0; font-size: 9.5pt; line-height: 10pt; }
table.cal tr + tr td { border-top: 0.3pt solid #999; }
table.cal td.d { text-align: right; }
.zplot { text-align: center; margin: 13pt 0; }
"""


# The browser's book is laid out a little wider than its page and printed at 87.5% to fit (its sizes read 16.6pt for
# a 19pt heading): the approved scale is that one. Every length of the sheet above is taken at it here, so the same
# sizes and the same pages come out.
BOOK_SCALE = 0.875
TITLE_RULE_W = 130 * 72 / 25.4 * BOOK_SCALE   # the title's rule: 130 mm in the browser's book, at its scale


def _scaled(css, k):
    return re.sub(r"(\d+(?:\.\d+)?)(pt|mm)\b", lambda m: "%.3g%s" % (float(m.group(1)) * k, m.group(2)), css)


CSS = _scaled(CSS_AT_FULL_SIZE, BOOK_SCALE)


MOON_PT, PLOT_PT = 8, 170   # a Moon's phase in a table, the plotting sheet (the browser book's sizes)

# An equation's name: its column (36 mm, then a 4 mm gap, at the book's scale), size and line.
EQ_LABEL_W = 36 * 72 / 25.4 * BOOK_SCALE
EQ_LABEL_GAP = 4 * 72 / 25.4 * BOOK_SCALE
EQ_LABEL_PT = 8 * BOOK_SCALE
EQ_LABEL_LH = 10 * BOOK_SCALE
EQ_PAD = 5 * BOOK_SCALE   # above and below each equation, as the browser's grid rows spaced them
EQ_LABEL_COLOUR = (0.13, 0.13, 0.13)


def _wrapped(text, font, size, width):
    """The words of ``text`` in lines no wider than ``width`` at ``size``."""
    lines, line = [], ""
    for word in text.split():
        trial = (line + " " + word).strip()
        if line and font.text_length(trial, size) > width:
            lines.append(line)
            line = word
        else:
            line = trial
    return lines + ([line] if line else [])


# Where a new page starts: before the contents, each part and chapter, and each chunk of a table that runs onto another
# page. The book is laid out piece by piece (a story each, each from a new page), never by CSS page breaks: MuPDF's
# engine asks for pages for ever when a break falls at the top of a page.
BREAK = "<!--zbreak-->"
_TAG = re.compile(r"<(/?)([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*?)(/?)>")
_VOID = {"br", "img", "hr", "meta", "link", "input", "col", "wbr", "source"}


def _pieces(body):
    """The body cut at each BREAK into whole documents: the elements open at a cut are closed there and opened again
    (marked .zcont, so a box's top margin and rule are not drawn twice) at the start of the next piece."""
    out, stack = [], []
    parts = body.split(BREAK)
    for n, part in enumerate(parts):
        stack_before = bool(stack)
        opener = "".join(re.sub(r'class="', 'class="zcont ', tag, count=1) if 'class="' in tag else tag[:-1] + ' class="zcont">' for _, tag in stack)
        for m in _TAG.finditer(part):
            name = m.group(2).lower()
            if m.group(1):
                for k in range(len(stack) - 1, -1, -1):
                    if stack[k][0] == name:
                        del stack[k:]
                        break
            elif not m.group(4) and name not in _VOID:
                stack.append((name, m.group(0)))
        closer = "".join("</%s>" % name for name, _ in reversed(stack))
        # A piece that goes on from the last (a table's next chunk) starts with a point of room: a collapsed-border table as
        # the very first thing of a story that runs onto a second page has MuPDF asking for pages for ever.
        piece = opener + ('<div style="height:1pt"></div>' if stack_before else "") + part + closer
        if re.sub(r"<[^<>]+>|\s", "", piece) or "<table" in piece or 'id="z' in piece:
            out.append(piece)
    return out


# ── Reading the page's book ──


def _end_of(src, start, tag):
    """The index just past the element whose start tag begins at ``start`` (nested same-name elements counted)."""
    pat = re.compile(r"<(/?)%s\b[^<>]*?(/?)>" % re.escape(tag), re.I)
    depth = 0
    for m in pat.finditer(src, start):
        if m.group(1):
            depth -= 1
        elif not m.group(2):
            depth += 1
        if depth == 0:
            return m.end()
    return len(src)


def _elements(src, cls, tag=None):
    """(start, end) of each element carrying class ``cls``, outermost first, in order."""
    out, pos = [], 0
    pat = re.compile(
        r'<(%s)\b[^>]*\bclass="(?:[^"]*\s)?%s(?:\s[^"]*)?"[^>]*>'
        % (tag or r"[a-z][a-z0-9]*", re.escape(cls)),
        re.I,
    )
    while True:
        m = pat.search(src, pos)
        if not m:
            return out
        end = _end_of(src, m.start(), m.group(1))
        out.append((m.start(), end))
        pos = end


def _replace_all(src, cls, fn, tag=None):
    """Each element of class ``cls`` replaced by fn(its markup), last first so the indices hold."""
    for start, end in reversed(_elements(src, cls, tag)):
        src = src[:start] + fn(src[start:end]) + src[end:]
    return src


def _inner(markup):
    """An element's content without its own start and end tags."""
    return markup[markup.index(">") + 1 : markup.rindex("<")]


def _text(markup):
    return _html.unescape(re.sub(r"<[^<>]+>", "", markup)).strip()


_NOT_WORDS = "−+⇅ "   # a stepper's minus and plus, a swap's arrows: controls, not values


def _control_value(ctl):
    """What a control shows, as words on paper: its numbers and units, and of a segmented choice only the one chosen
    (set a little apart, as the page sets the segment beside the number)."""
    parts = []
    for m in re.finditer(r'<span class="tk-(v|u)"[^>]*>(.{0,2000}?)</span>|<button\b([^<>]*)>(.{0,2000}?)</button>|>([^<>]+)<', ctl, re.S):
        if m.group(1) == "u" and parts:
            parts[-1] += "\u2009" + _text(m.group(2))
        elif m.group(1):
            parts.append(_text(m.group(2)))
        elif m.group(3) is not None:
            if 'role="radio"' not in m.group(3):
                parts.append(_text(m.group(4)).strip(_NOT_WORDS))
            elif 'aria-checked="true"' in m.group(3):
                parts.append("\u2002" + _text(m.group(4)))
        elif m.group(5).strip(_NOT_WORDS):
            parts.append(_text(m.group(5)))
    return " ".join(p for p in parts if p).replace(" \u2002", "\u2002").strip()


# Capitals spaced out, as the browser book's text-transform and letter-spacing set them: MuPDF's engine has neither, so the
# letters are capitalised here and a space of the right width put between them (TRACK: the class, and the space between
# letters as a share of an em: U+200A is about a tenth of one, U+2009 a fifth).
TRACK = {"tb-book-kicker": "\u2009", "tb-part-n": "\u2009", "tb-toc-pn": "\u200a", "tb-subh": "\u200a", "tk-group-h": "\u200a"}


def _tracked(text, gap):
    """Text (no tags inside) in spaced capitals; a word space stays a word space, widened."""
    out = []
    for word in _html.unescape(text).upper().split(" "):
        out.append(gap.join(word))
    return _html.escape((gap * 3).join(out), quote=False)


def _track_classes(b):
    for cls, gap in TRACK.items():
        b = re.sub(r'(<(\w+)\b[^>]*\bclass="(?:[^"]*\s)?%s(?:\s[^"]*)?"[^>]*>)([^<]*)' % cls, lambda m: m.group(1) + _tracked(m.group(3), gap), b)
    return b


def _tracked_th(b):
    """A group's row in a table (tr.tb-grp), in spaced capitals."""
    return re.sub(r'(<tr class="tb-grp">\s*<th\b[^>]*>(?:<span>)?)([^<]*)', lambda m: m.group(1) + _tracked(m.group(2), "\u200a"), b)


class Book:
    """The book read from the page: its chapters, its pictures and equations, and its page furniture."""

    def __init__(self, src, paper):
        self.paper = PAPER.get(paper, "a4")
        self.text_w = pymupdf.paper_rect(self.paper).width - 2 * MARGIN[0]
        self.lang = (re.search(r'<html[^<>]*\blang="([^"]*)"', src) or [None, "en"])[1]
        self.foot_left = self._page_rule(src, "bottom-left") or ""
        right = self._page_rule(src, "bottom-right") or ""
        self.foot_right = right  # 'Zimi 1.16.0 · ' (the page and the pages follow it)
        first = re.search(r'@page :first\s*\{.{0,2000}?@bottom-center\s*\{\s*content:\s*"([^"]*)"', src, re.S)
        self.foot_first = first.group(1) if first else ""   # the title page's one line at its foot ("Made with Zimi 1.16.0")
        self.titled = 'class="tb-book-title"' in src
        # The title's rule is narrower than the page and centred: MuPDF's blocks take no "margin: auto", so the margin
        # is worked out for this paper.
        self.css = CSS + ".tb-book-title .tb-book-name { margin-left: %.1fpt; }" % ((self.text_w - TITLE_RULE_W) / 2)   # one tile printed is its own page 1, head and foot as any other
        self.maths, self.svgs, self.labels, self.tables = {}, {}, {}, {}
        self.chapters = []  # (id, head-left, head-right)
        self.parts = []  # (id, title)
        start = src.find('id="alm-book"')
        if start < 0:
            raise ValueError("no book")
        start = src.rfind("<", 0, start)
        body = src[start : _end_of(src, start, "div")]
        self.body = self._shape(body)

    @staticmethod
    def _page_rule(src, box):
        """The text of one of the book's @page margin boxes, as the page wrote it ("Zimi 1.16.0 · " for the page number's)."""
        m = re.search(
            r"@%s\s*\{\s*content:\s*((?:\"[^\"]*\"\s*|counter\([^)]*\)\s*)+)"
            % box,
            src,
        )
        if not m:
            return None
        parts = re.findall(r'"([^"]*)"|counter\(([^()]*)\)', m.group(1))
        out = ""
        for lit, counter in parts:
            if counter:
                break
            out += lit
        return out

    # The markup, reshaped into what MuPDF's engine lays out well: grids and flex rows as tables, controls as text,
    # equations and pictures as places kept for them.
    def _shape(self, b):
        b = re.sub(r"<details\b([^>]*)>", r"<div\1>", b).replace("</details>", "</div>")
        b = re.sub(r"<summary\b[^>]*>|</summary>", "", b)
        b = re.sub(
            r'<button\b[^<>]*aria-checked="false"[^<>]*>.{0,2000}?</button>', "", b, flags=re.S
        )
        b = re.sub(r"<button\b([^>]*)>", r"<span\1>", b).replace("</button>", "</span>")
        b = re.sub(r'<span class="tb-vh">.{0,2000}?</span>', "", b, flags=re.S)
        b = re.sub(r'\sstyle="[^"]*"', "", b)
        b = re.sub(
            r'\s(aria-[a-z]+|role|tabindex|data-tk-[a-z]+|data-v|data-tb-go|title|scope)="[^"]*"',
            "",
            b,
        )
        b = self._chapters(b)
        b = re.sub(r"<svg\b.*?</svg>", self._svg, b, flags=re.S)   # first: the tables keep their cells' markup
        b = _tracked_th(_track_classes(b))
        b = _replace_all(b, "tb-book-toc", self._toc, "nav")
        b = _replace_all(b, "tb-part-list", self._part_list, "ol")
        b = _replace_all(b, "tb-eq", self._equation, "div")
        b = _replace_all(b, "tb-eq-frame", self._two_columns, "div")
        b = _replace_all(b, "tb-frame", lambda d: self._paged(d) or d, "div")
        b = _replace_all(b, "tk-rows", self._rows, "div")
        b = _replace_all(b, "tb-kv", self._kv, "dl")
        b = _replace_all(b, "tb-cal-list", self._cal_list, "div")
        b = re.sub(r"<math\b.*?</math>", self._math, b, flags=re.S)
        return b

    def _chapters(self, b):
        """Each part and chapter starts a page; their names are what the running heads and the outline say."""

        def part(m):
            pid = m.group(1)
            seg = b[m.start() : _end_of(b, m.start(), "section")]
            n = _text(
                (
                    re.search(
                        r'class="tb-part-n">(.*?)</span>\s*<span class="tb-part-name">',
                        seg,
                        re.S,
                    )
                    or [None, ""]
                )[1]
            )
            name = _text(
                (
                    re.search(r'class="tb-part-name">(.*?)</span>', seg, re.S)
                    or [None, ""]
                )[1]
            )
            self.parts.append((pid, (n + " · " + name).strip(" ·")))
            return BREAK + m.group(0)

        b = re.sub(r'<section class="tb-book-part" id="([^"]+)">', part, b)

        def chapter(m):
            tag = m.group(0)
            cid = re.search(r'\bid="([^"]+)"', tag)
            head = re.search(r'\bdata-head="([^"]*)"', tag)
            ch = re.search(r'\bdata-ch="([^"]*)"', tag)
            if cid:
                self.chapters.append(
                    (
                        cid.group(1),
                        _html.unescape(head.group(1)) if head else "",
                        _html.unescape(ch.group(1)) if ch else "",
                    )
                )
            return BREAK + tag

        b = re.sub(r'<section class="tb-book-page[^"]*"[^<>]*>', chapter, b)

        return b

    def _toc(self, nav):
        out = []
        for m in re.finditer(
            r'(<h1>.{0,2000}?</h1>)|<p class="tb-toc-part">(.{0,2000}?)</p>|<li>\s*<a href="#([^"]+)">(.{0,2000}?)</a>\s*</li>',
            nav,
            re.S,
        ):
            if m.group(1):
                out.append(m.group(1))
            elif m.group(2) is not None:
                part = re.sub(r"</?a\b[^>]*>", "", m.group(2))
                out.append('<p class="tb-toc-part">' + part.replace("</span>", "</span>&#160;&#160;", 1) + "</p>")
            else:
                target, inner = m.group(3), m.group(4)
                n = (
                    re.search(r'<span class="tb-toc-n">(.*?)</span>', inner, re.S)
                    or [None, ""]
                )[1]
                name = (
                    re.search(r'<span class="tb-toc-name">(.*?)</span>', inner, re.S)
                    or [None, ""]
                )[1]
                sub = re.search(r'<span class="tb-toc-sub">(.*?)</span>', inner, re.S)
                cell = '<span id="zn-%s">%s</span>' % (target, name) + (
                    '&#160;&#160;<span class="tb-toc-sub" id="zt-%s">%s</span>'
                    % (target, sub.group(1))
                    if sub
                    else ""
                )
                out.append(
                    '<tr><td class="n">%s</td><td id="zr-%s">%s</td><td class="pg" id="zp-%s">{pg:%s}</td></tr>'
                    % (n, target, cell, target, target)
                )
        # A part's entries one table, so its columns line up from entry to entry.
        html, rows = [], []
        for piece in out + [None]:
            if piece is not None and piece.startswith("<tr>"):
                rows.append(piece)
                continue
            if rows:
                html.append('<table class="toc">' + "".join(rows) + "</table>")
                rows = []
            if piece is not None:
                html.append(piece)
        return BREAK + '<nav class="tb-book-toc">' + "".join(html) + "</nav>"

    @staticmethod
    def _part_list(ol):
        rows = re.findall(
            r'<li>\s*<span class="tb-toc-n">(.{0,200}?)</span>(.{0,2000}?)</li>', ol, re.S
        )
        return (
            '<table class="partlist">'
            + "".join(
                '<tr><td class="n">%s</td><td>%s</td></tr>' % (n, t.strip())
                for n, t in rows
            )
            + "</table>"
        )

    def _equation(self, div):
        """An equation beside its name (the browser's two-column grid): MuPDF's tables size their columns by what is in
        them, so the equation's place is a block set in by the name's column, and the name is drawn in that column
        afterwards (_draw_labels), wrapped and centred on the equation as the grid did."""
        label = _text((re.search(r'<div class="tb-eq-l">(.{0,2000}?)</div>', div, re.S) or [None, ""])[1])
        mm = re.search(r"<math\b.*?</math>", div, re.S)
        if not mm:
            return ""
        box = almanacmath.layout(mm.group(0), MATH_PT * BOOK_SCALE)
        n = len(self.maths)
        self.maths[n] = box
        h = box.a + box.d + 2
        if "tb-eq-long" in div[: div.index(">")] or box.w > self.text_w - EQ_LABEL_W - EQ_LABEL_GAP:   # too wide beside its name: under it
            return '<p class="zeq-l">%s</p><div class="zeq">%s</div>' % (_html.escape(label), _math_place(n, box, self.text_w))
        lines = _wrapped(label, _charis(True), EQ_LABEL_PT, EQ_LABEL_W)
        self.labels[n] = lines
        h = max(h, len(lines) * EQ_LABEL_LH)
        pad = max(EQ_PAD, (len(lines) * EQ_LABEL_LH - (box.a + box.d + 2)) / 2)   # a name taller than its equation: room above and below
        return '<div class="zeq" style="margin-left:%.1fpt;padding:%.2fpt 0">%s</div>' % (EQ_LABEL_W + EQ_LABEL_GAP, pad, _math_place(n, box, self.text_w - EQ_LABEL_W - EQ_LABEL_GAP))

    def _two_columns(div_self, div):
        """A long table of terms in two columns side by side (the browser's CSS columns, balanced page by page): kept
        as rows and set out each pass (_paged_tables) once it is known how many fit on each page."""
        if "tb-eq-few" in div[: div.index(">")]:
            return _inner(div)
        return div_self._paged(div, two=True) or _inner(div)

    def _paged(self, markup, two=False):
        """A table whose head is said again on every page it runs onto (and, ``two``, set in two columns): recorded,
        and a marker left in its place."""
        m = re.search(r"(<table\b[^>]*>)\s*(<thead>.{0,20000}?</thead>)\s*<tbody>(.*?)</tbody>\s*</table>", markup, re.S)
        if not m:
            return None
        rows = re.findall(r"<tr\b.*?</tr>", m.group(3), re.S)
        if not rows:
            return None
        t = len(self.tables)
        self.tables[t] = {"open": m.group(1), "head": m.group(2), "rows": rows, "two": two, "pages": None}
        before = markup[: m.start()]
        after = markup[m.end():]
        return before + "{tbl:%d}" % t + after

    @staticmethod
    def _rows(div):
        rows = []
        for start, end in _elements(div, "tk-row", "div"):
            row = div[start:end]
            label = (
                re.search(r'<span class="tk-label">(.{0,2000}?)</span>', row, re.S)
                or [None, ""]
            )[1]
            ctl = (
                row[row.find('<span class="tk-ctl">') :]
                if '<span class="tk-ctl">' in row
                else ""
            )
            rows.append('<tr><td>%s</td><td class="v">%s</td></tr>' % (label, _control_value(ctl)))
        head = (
            re.search(r'<p class="tk-group-h">(.{0,2000}?)</p>', div, re.S) or [None, None]
        )[1]
        return (
            ('<p class="tk-group-h">%s</p>' % head if head else "")
            + '<table class="tk-rows">'
            + "".join(rows)
            + "</table>"
        )

    @staticmethod
    def _kv(dl):
        pairs = re.findall(r"<dt\b[^>]*>(.*?)</dt>\s*<dd\b[^>]*>(.*?)</dd>", dl, re.S)
        return (
            '<table class="kv">'
            + "".join(
                '<tr><td class="k">%s</td><td class="v">%s</td></tr>' % p for p in pairs
            )
            + "</table>"
        )

    @staticmethod
    def _cal_list(div):
        lines = re.findall(
            r'<span class="tb-cal-sys">(.{0,2000}?)</span>\s*<span class="tb-cal-date">(.{0,2000}?)</span>',
            div,
            re.S,
        )
        return (
            '<table class="cal">'
            + "".join('<tr><td>%s</td><td class="d">%s</td></tr>' % l for l in lines)
            + "</table>"
        )

    def archive(self):
        """The images the story draws: the pictures, and the blank that keeps an equation's place."""
        if getattr(self, "_archive", None) is None:
            arch = pymupdf.Archive()
            for n in self.maths:
                arch.add((_marker_png(n), "zm-%d.png" % n))
            for k in self.svgs:
                arch.add((_marker_png(SVG_MARK + k), "zs-%d.png" % k))
            self._archive = arch
        return self._archive

    def _svg(self, m):
        """A picture of the book's (a Moon's phase, the plotting sheet) as an image MuPDF draws in the flow, its classes'
        styles and the print palette written into it (MuPDF's SVG reads attributes, not stylesheets or var())."""
        svg = m.group(0)
        if re.search(r'class="tk-caret"', svg) or ('aria-hidden="true" width="14"' in svg and "cal-moon" not in svg):
            return ""   # a control's icon: not on paper
        if "<marker" in svg and "viewBox" not in svg:
            return ""
        vb = re.search(r'viewBox="([\d.\s-]+)"', svg)
        if "cal-moon" in svg:
            w = h = MOON_PT * BOOK_SCALE
        elif vb:
            _, _, vw, vh = (float(x) for x in vb.group(1).split())
            w, h = PLOT_PT * BOOK_SCALE, PLOT_PT * BOOK_SCALE * vh / vw
        else:
            return ""
        k = len(self.svgs)
        self.svgs[k] = (_svg_for_print(svg), w, h)
        # Its place in the flow is a marker image its size; the picture is drawn there afterwards as vectors (the
        # engine's own SVG images are rasters).
        img = '<img src="zs-%d.png" style="width:%.2fpt;height:%.2fpt">' % (k, w, h)
        return img if "cal-moon" in svg else '<div class="zplot">%s</div>' % img

    def _math(self, m):
        n = len(self.maths)
        box = almanacmath.layout(m.group(0), MATH_PT * BOOK_SCALE)
        self.maths[n] = box
        return '<div class="zeq">%s</div>' % _math_place(n, box, self.text_w)


SVG_MARK = 1 << 20   # a picture's marker counts from here, an equation's from 0


def _marker_png(n):
    """A one-pixel image whose colour is n + 1: where the engine drew it is where equation n goes (_find_markers)."""
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 1, 1), False)
    v = n + 1
    pix.set_pixel(0, 0, ((v >> 16) & 255, (v >> 8) & 255, v & 255))
    return pix.tobytes("png")


def _find_markers(doc, pos, take_out=True):
    """Each equation's place, read from where its marker image was drawn (the engine's own report of an inline image's
    box is off by its height), and the marker taken out of the page."""
    colour = {}
    for k, page in enumerate(doc):
        for info in page.get_image_info(xrefs=True):
            xref = info.get("xref")
            if not xref or info.get("width") != 1 or info.get("height") != 1:
                continue
            if xref not in colour:
                r, g, b = pymupdf.Pixmap(doc, xref).pixel(0, 0)[:3]
                colour[xref] = r << 16 | g << 8 | b
            n = colour[xref] - 1
            key = "zs-%d" % (n - SVG_MARK) if n >= SVG_MARK else "zm-%d" % n
            pos[key] = (k, pymupdf.Rect(info["bbox"]))
            if take_out:
                page.delete_image(xref)


_PLACE = re.compile(r'<img src="(z[ms]-\d+)\.png" style="width:([\d.]+)pt;height:([\d.]+)pt">')


def _squeezed(doc, body):
    """The equations and plots the engine drew smaller to fit what was left of a page (it shrinks an image rather than
    move it on): each is to start the next page instead (_pushed)."""
    found = {}
    _find_markers(doc, found, take_out=False)
    out = set()
    for m in _PLACE.finditer(body):
        key, at = m.group(1), found.get(m.group(1))
        moon = key.startswith("zs-") and "zplot" not in body[max(0, m.start() - 24): m.start()]   # a Moon in a table row
        if at and not moon and at[1].height < float(m.group(3)) - 0.5:
            out.add(key)
    return out


def _pushed(body, keys):
    """The body with a page break before each place in ``keys``: before its equation's name when that is set above it
    (p.zeq-l), else before the block holding it."""
    for key in keys:
        i = body.find('<img src="%s.png"' % key)
        if i < 0:
            continue
        j = body.rfind("<div ", 0, i)
        lab = body.rfind('<p class="zeq-l">', 0, j)
        if lab >= 0 and body[lab:j].endswith("</p>") and "<" not in body[lab + 17: j - 4]:
            j = lab
        head = body.rfind('<div class="tb-sumh">', 0, j)
        if head >= 0 and not re.sub(r"<[^<>]+>", "", body[body.index("</div>", head) + 6: j]).strip():
            j = head   # the first equation under its heading: the heading goes with it
        if body[:j].endswith(BREAK):
            continue
        body = body[:j] + BREAK + body[j:]
    return body


def _math_place(n, box, width):
    """The place an equation is kept in the flow: a blank image its size (atomic, so never split across pages), no wider
    than ``width`` (a wider equation is drawn smaller to fit)."""
    k = min(1.0, width / box.w) if box.w else 1.0
    return '<img src="zm-%d.png" style="width:%.2fpt;height:%.2fpt">' % (n, box.w * k, (box.a + box.d) * k + 2)


def _svg_for_print(svg):
    for var, val in _PRINT_VARS.items():
        svg = svg.replace("var(%s)" % var, val)
    style = re.search(r"<style>(.*?)</style>", svg, re.S)
    if style:
        rules = {}
        for sel, body in re.findall(r"\.([\w-]+)\s*\{([^}]*)\}", style.group(1)):
            rules[sel] = ";".join(x.strip() for x in body.split(";") if x.strip())
        svg = svg.replace(style.group(0), "")

        def inline(m):
            tag = m.group(0)
            cls = re.search(r'\bclass="([^"]*)"', tag)
            if not cls:
                return tag
            css = ";".join(rules[c] for c in cls.group(1).split() if c in rules)
            attrs = "".join(' %s="%s"' % tuple(x.split(":", 1)) for x in css.split(";") if ":" in x)
            return tag[:-1].rstrip("/") + attrs + ("/>" if tag.endswith("/>") else ">")

        svg = re.sub(r"<[a-z]+\b[^>]*\bclass=\"[^\"]*\"[^>]*>", inline, svg)
    if "xmlns=" not in svg[:300]:
        svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"', 1)
    return svg


# ── Laying it out ──


def _layout(book, body):
    """One pass: the pieces on pages; where each chapter, equation, picture and contents line landed (page index from 0)."""
    mediabox = pymupdf.paper_rect(book.paper)
    where = mediabox + (MARGIN[0], MARGIN[1], -MARGIN[0], -MARGIN[1])
    buf = io.BytesIO()
    writer = pymupdf.DocumentWriter(buf)
    pos = {}
    count = [0]

    def rectfn(rect_num, filled):
        count[0] += 1
        if count[0] > MAX_PAGES:   # something that fits no page would ask for pages for ever
            raise RuntimeError("the book does not fit its pages")
        return mediabox, where, None

    for piece in _pieces(body):
        first = count[0]

        def positionfn(p, first=first):
            if not p.id:
                return
            page = first + p.page_num - 1
            if p.open_close & 1:
                pos.setdefault(p.id, (page, pymupdf.Rect(p.rect)))
            if p.open_close & 2 and p.id in pos and pos[p.id][0] == page:
                pos[p.id] = (page, pos[p.id][1] | pymupdf.Rect(p.rect))

        html = '<html lang="%s"><body>%s</body></html>' % (_html.escape(book.lang), piece)
        pymupdf.Story(html=html, user_css=book.css, archive=book.archive()).write(writer, rectfn, positionfn=positionfn)
    writer.close()
    return pymupdf.open("pdf", buf.getvalue()), pos


def _fill_pages(body, pos):
    """The contents' page numbers: where each chapter landed (1 is the title page)."""
    return re.sub(
        r"\{pg:([^{}]+)\}",
        lambda m: str(pos[m.group(1)][0] + 1) if m.group(1) in pos else "",
        body,
    )


def _draw_svg(page, rect, svg):
    """An SVG drawn into ``rect`` as vectors: drawn first on a page of its own (its viewBox, which also clips it), then
    placed as a form. MuPDF's own SVG reader makes rasters of these, so the few shapes the book's pictures use are drawn
    here: rect, line, circle, path (M L H V A C Z), text."""
    try:
        pic = _svg_doc(svg)
        page.show_pdf_page(rect, pic, 0, keep_proportion=True)
    except Exception as e:   # a picture that will not draw leaves its place empty, never the book unmade
        log.debug("almanac book: picture not drawn: %s", e)


_ATTR = re.compile(r'([\w:-]+)="([^"]*)"')
_NUM = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def _colour(v):
    v = (v or "").strip().lower()
    if not v or v in ("none", "transparent", "currentcolor"):
        return None if v != "currentcolor" else (0, 0, 0)
    if v == "black":
        return (0, 0, 0)
    if v == "white":
        return (1, 1, 1)
    if v.startswith("#"):
        h = v[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) == 6:
            return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return (0, 0, 0)


def _arc_beziers(x0, y0, rx, ry, phi, large, sweep, x1, y1):
    """An SVG elliptical arc as cubic Bezier segments [(c1, c2, end)] (the SVG spec's centre parameterisation)."""
    import math

    if rx == 0 or ry == 0 or (x0 == x1 and y0 == y1):
        return [((x0, y0), (x1, y1), (x1, y1))]
    rx, ry = abs(rx), abs(ry)
    cp, sp = math.cos(math.radians(phi)), math.sin(math.radians(phi))
    dx, dy = (x0 - x1) / 2, (y0 - y1) / 2
    x1p, y1p = cp * dx + sp * dy, -sp * dx + cp * dy
    lam = (x1p / rx) ** 2 + (y1p / ry) ** 2
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    co = math.sqrt(max(0.0, num / den)) if den else 0.0
    if large == sweep:
        co = -co
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx
    cx, cy = cp * cxp - sp * cyp + (x0 + x1) / 2, sp * cxp + cp * cyp + (y0 + y1) / 2

    def ang(ux, uy, vx, vy):
        a = math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        return a

    t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and dt > 0:
        dt -= 2 * math.pi
    elif sweep and dt < 0:
        dt += 2 * math.pi
    n = max(1, int(math.ceil(abs(dt) / (math.pi / 2))))
    step, out = dt / n, []
    k = 4 / 3 * math.tan(step / 4)
    pt = lambda t: (cx + rx * math.cos(t) * cp - ry * math.sin(t) * sp, cy + rx * math.cos(t) * sp + ry * math.sin(t) * cp)
    der = lambda t: (-rx * math.sin(t) * cp - ry * math.cos(t) * sp, -rx * math.sin(t) * sp + ry * math.cos(t) * cp)
    t = t1
    for _ in range(n):
        p0, p3 = pt(t), pt(t + step)
        d0, d3 = der(t), der(t + step)
        out.append(((p0[0] + k * d0[0], p0[1] + k * d0[1]), (p3[0] - k * d3[0], p3[1] - k * d3[1]), p3))
        t += step
    return out


def _path(shape, d):
    toks = re.findall(r"[MLHVACZmlhvacz]|" + _NUM.pattern, d)
    i, cmd, x, y, start = 0, None, 0.0, 0.0, (0.0, 0.0)
    while i < len(toks):
        if toks[i].isalpha():
            cmd = toks[i]
            i += 1
            if cmd in "Zz":
                shape.draw_line((x, y), start)
                x, y = start
                continue
        rel = cmd.islower()
        c = cmd.upper()
        if c == "M":
            nx, ny = float(toks[i]), float(toks[i + 1])
            i += 2
            x, y = (x + nx, y + ny) if rel else (nx, ny)
            start = (x, y)
            cmd = "l" if rel else "L"
        elif c == "L":
            nx, ny = float(toks[i]), float(toks[i + 1])
            i += 2
            nx, ny = (x + nx, y + ny) if rel else (nx, ny)
            shape.draw_line((x, y), (nx, ny))
            x, y = nx, ny
        elif c in "HV":
            v = float(toks[i])
            i += 1
            nx, ny = ((x + v if rel else v), y) if c == "H" else (x, (y + v if rel else v))
            shape.draw_line((x, y), (nx, ny))
            x, y = nx, ny
        elif c == "C":
            v = [float(t) for t in toks[i:i + 6]]
            i += 6
            if rel:
                v = [v[j] + (x if j % 2 == 0 else y) for j in range(6)]
            shape.draw_bezier((x, y), (v[0], v[1]), (v[2], v[3]), (v[4], v[5]))
            x, y = v[4], v[5]
        elif c == "A":
            rx, ry, phi, large, sweep, nx, ny = (float(t) for t in toks[i:i + 7])
            i += 7
            if rel:
                nx, ny = x + nx, y + ny
            for c1, c2, end in _arc_beziers(x, y, rx, ry, phi, int(large), int(sweep), nx, ny):
                shape.draw_bezier((x, y), c1, c2, end)
                x, y = end
        else:
            i += 1


def _svg_doc(svg):
    vb = re.search(r'viewBox="([^"]+)"', svg)
    vx, vy, vw, vh = (float(v) for v in vb.group(1).split()) if vb else (0, 0, 24, 24)
    doc = pymupdf.open()
    page = doc.new_page(width=vw, height=vh)
    sans = pymupdf.Font("helv")
    for m in re.finditer(r"<(rect|line|circle|path|text)\b([^>]*)>(?:([^<]*)</text>)?", svg):
        tag, a = m.group(1), dict(_ATTR.findall(m.group(2)))
        num = lambda k, d=0.0: float(a.get(k, d) or d)
        fill = _colour(a.get("fill", "black" if tag != "line" else "none"))
        stroke = _colour(a.get("stroke", "none"))
        width = num("stroke-width", 1.0)
        dash = a.get("stroke-dasharray")
        if tag == "text":
            size = float((re.search(r"([\d.]+)px", a.get("font", "")) or [None, "10"])[1]) if a.get("font") else num("font-size", 10)
            text = _html.unescape(m.group(3) or "")
            x, y = num("x") - vx, num("y") - vy
            w = sans.text_length(text, size)
            if a.get("text-anchor") == "middle":
                x -= w / 2
            elif a.get("text-anchor") == "end":
                x -= w
            tw = pymupdf.TextWriter(page.rect, color=fill or (0, 0, 0))
            tw.append((x, y), text, font=sans, fontsize=size)
            tw.write_text(page)
            continue
        shape = page.new_shape()
        if tag == "rect":
            shape.draw_rect(pymupdf.Rect(num("x") - vx, num("y") - vy, num("x") - vx + num("width"), num("y") - vy + num("height")))
        elif tag == "line":
            shape.draw_line((num("x1") - vx, num("y1") - vy), (num("x2") - vx, num("y2") - vy))
        elif tag == "circle":
            shape.draw_circle((num("cx") - vx, num("cy") - vy), num("r"))
        elif tag == "path":
            _path(shape, a.get("d", ""))
        shape.finish(color=stroke, fill=fill, width=width if stroke else 0,
                     dashes="[%s] 0" % dash.replace(",", " ") if dash and stroke else None, closePath=False)
        shape.commit()
    return doc


def _furniture(doc, book, pos):
    """Running heads, feet, the contents' leaders, links and the outline."""
    total = doc.page_count
    starts = sorted((pos[c[0]][0], c) for c in book.chapters if c[0] in pos)
    part_pages = {pos[p[0]][0] for p in book.parts if p[0] in pos}
    head_of = {}
    for i, (page_no, ch) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else total
        for k in range(page_no, end):
            if k not in part_pages:
                head_of[k] = ch
    body_font = _charis(False)
    body_italic = _charis(True)
    for k, page in enumerate(doc):
        if k == 0 and book.titled:   # the title page: its one line at the foot, nothing else
            if book.foot_first:
                tw = pymupdf.TextWriter(page.rect, color=FIRST_FOOT_COLOUR)
                y = page.rect.height - MARGIN[1] + 10 * 72 / 25.4   # centred in the margin, as the browser set it
                tw.append(((page.rect.width - body_font.text_length(book.foot_first, HEAD_FOOT_PT)) / 2, y), book.foot_first, font=body_font, fontsize=HEAD_FOOT_PT)
                tw.write_text(page)
            continue
        w, h = page.rect.width, page.rect.height
        tw = pymupdf.TextWriter(page.rect, color=HEAD_COLOUR)
        ch = head_of.get(k)
        if ch:
            y = MARGIN[1] - HEAD_GAP
            tw.append((MARGIN[0], y), ch[1], font=body_italic, fontsize=HEAD_FOOT_PT)
            tw.append(
                (w - MARGIN[0] - body_italic.text_length(ch[2], HEAD_FOOT_PT), y),
                ch[2],
                font=body_italic,
                fontsize=HEAD_FOOT_PT,
            )
        foot_y = h - MARGIN[1] + 8 * 72 / 25.4
        tw.append(
            (MARGIN[0], foot_y), book.foot_left, font=body_font, fontsize=HEAD_FOOT_PT
        )
        right = "%s%d / %d" % (book.foot_right, k + 1, total)
        tw.append(
            (w - MARGIN[0] - body_font.text_length(right, HEAD_FOOT_PT), foot_y),
            right,
            font=body_font,
            fontsize=HEAD_FOOT_PT,
        )
        tw.write_text(page)
    # The contents: a dotted leader from each entry to its page number, and the line a link to its chapter.
    for cid, _, _ in book.chapters:
        row, num = pos.get("zr-" + cid), pos.get("zp-" + cid)
        end = pos.get("zt-" + cid) or pos.get("zn-" + cid)
        if not (row and num and end) or cid not in pos:
            continue
        page = doc[row[0]]
        x0, x1 = end[1].x1 + 4, num[1].x1 - _number_width(doc, row[0], num[1]) - 4
        y = end[1].y1 - 2.5
        shape = page.new_shape()
        x = x0
        while x + LEADER_DOT <= x1:
            shape.draw_circle((x + LEADER_DOT / 2, y), LEADER_DOT / 2.6)
            x += LEADER_DOT + LEADER_GAP
        shape.finish(color=None, fill=LEADER_COLOUR, width=0)
        shape.commit()
        page.insert_link(
            {
                "kind": pymupdf.LINK_GOTO,
                "from": row[1],
                "page": pos[cid][0],
                "to": pymupdf.Point(0, 0),
            }
        )
    # The outline: the contents, each part, and its chapters.
    toc = []
    first_toc = min((v[0] for k, v in pos.items() if k.startswith("zr-")), default=None)
    if first_toc is not None:
        toc.append([1, _contents_title(doc, first_toc), first_toc + 1])
    for pid, title in book.parts:
        if pid in pos:
            toc.append([1, title, pos[pid][0] + 1])
            part_no = re.search(r"tb-part-(\d+)", pid)
            for cid, head, ch in book.chapters:
                if (
                    part_no
                    and cid.startswith("tb-ch-%s-" % part_no.group(1))
                    and cid in pos
                ):
                    toc.append([2, ch, pos[cid][0] + 1])
    if not book.parts:
        for cid, head, ch in book.chapters:
            if cid in pos:
                toc.append([1, ch, pos[cid][0] + 1])
    if toc:
        doc.set_toc(toc)


def _number_width(doc, page_no, rect):
    words = [w for w in doc[page_no].get_text("words", clip=rect + (-1, -1, 1, 1))]
    return (rect.x1 - min(w[0] for w in words)) if words else 0


def _contents_title(doc, page_no):
    for b in doc[page_no].get_text("dict")["blocks"]:
        for line in b.get("lines", []):
            text = "".join(s["text"] for s in line["spans"]).strip()
            if text:
                return text
    return "Contents"


_charis_fonts = {}


def _charis(italic):
    """Charis SIL, the serif MuPDF carries (its HTML engine's own), for what is drawn beside the story."""
    if italic not in _charis_fonts:
        from pymupdf import mupdf

        data, size = mupdf.fz_lookup_builtin_font("Charis SIL", 0, 1 if italic else 0)
        _charis_fonts[italic] = pymupdf.Font(
            fontbuffer=mupdf.raw_to_python_bytes(data, size)
        )
    return _charis_fonts[italic]


def _row_id(t, i):
    return "zq-%d-%d" % (t, i)


def _with_id(row, rid):
    return row.replace("<tr", '<tr id="%s"' % rid, 1)


def _build_table(t, tb):
    """One recorded table set out: in chunks of the rows each page holds (the head over each, a new page before each
    after the first), or whole while that is not yet known."""
    rows = [_with_id(r, _row_id(t, i)) for i, r in enumerate(tb["rows"])]
    head, open_tag = tb["head"], tb["open"]
    pages = tb["pages"] or ([(len(rows) + 1) // 2] if tb["two"] else [len(rows)])
    if tb["two"]:
        # Two columns: each page's share of rows runs down the left column, then the right; a row of the table holds
        # one row of each, with a gap between.
        open_tag = open_tag.replace('class="', 'class="ztwo ', 1)
        head2 = re.sub(r"(<tr\b[^>]*>)(.*?)(</tr>)", lambda m: m.group(1) + m.group(2) + '<th class="zgap"></th>' + m.group(2) + m.group(3), head, flags=re.S)
        chunks, i = [], 0
        for n in pages:
            left, right = rows[i : i + n], rows[i + n : i + 2 * n]
            i += 2 * n
            lines = []
            for k in range(len(left)):
                l_cells = re.sub(r"^<tr\b[^>]*>|</tr>$", "", left[k].strip())
                r_cells = re.sub(r"^<tr\b[^>]*>|</tr>$", "", right[k].strip()) if k < len(right) else ""
                rid = re.search(r'id="([^"]+)"', left[k]).group(1)
                lines.append('<tr id="%s">%s<td class="zgap"></td>%s</tr>' % (rid, l_cells, r_cells))
            chunks.append(lines)
            if i >= len(rows):
                break
        if i < len(rows):   # (not yet laid out: what is left goes on as one more chunk)
            rest = rows[i:]
            half = (len(rest) + 1) // 2
            chunks.append([re.sub(r"</tr>\s*$", "", rest[k]) + '<td class="zgap"></td>' + (re.sub(r"^<tr\b[^>]*>", "", rest[half + k]) if half + k < len(rest) else "</tr>") for k in range(half)])
        out = []
        for n, lines in enumerate(chunks):
            out.append((BREAK if n else "") + open_tag + head2 + "<tbody>" + "".join(lines) + "</tbody></table>")
        return "".join(out)
    out, i = [], 0
    for n, count in enumerate(pages):
        chunk = rows[i : i + count]
        i += count
        if not chunk:
            continue
        out.append((BREAK if n else "") + open_tag + head + "<tbody>" + "".join(chunk) + "</tbody></table>")
    if i < len(rows):
        out.append((BREAK if out else "") + open_tag + head + "<tbody>" + "".join(rows[i:]) + "</tbody></table>")
    return "".join(out)


def _pages_of(t, tb, pos):
    """How many rows (pairs, in two columns) each chunk of the table keeps on its own page, from where they landed. A
    chunk that ran over (its repeated head took room) keeps what stayed; from there on nothing is assumed, and the rest
    runs on as one chunk to be measured in the next pass. So the passes only ever settle."""
    total = len(tb["rows"])
    step = 2 if tb["two"] else 1   # a pair takes two rows of the list
    known = tb["pages"] or []
    out, i, k = [], 0, 0
    while i < total:
        first = pos.get(_row_id(t, i))
        if first is None:
            break
        limit = known[k] if k < len(known) else None
        n = 0
        while i + n < total and (limit is None or n < limit):
            at = pos.get(_row_id(t, i + n))
            if at is None or at[0] != first[0]:
                break
            n += 1
        n = max(n, 1)
        out.append(n)
        i += n * step
        if limit is not None and n < limit:
            break   # it ran over: the rest is measured again
        k += 1
    return out or None


def _set_out(book):
    body = book.body
    return re.sub(r"\{tbl:(\d+)\}", lambda m: _build_table(int(m.group(1)), book.tables[int(m.group(1))]), body)


def render(src, paper="A4"):
    """The book the page sent, as the PDF's bytes."""
    book = Book(src, paper)
    pos, pushed, good = {}, set(), None
    for _ in range(SPLIT_PASSES):
        kept = {t: tb["pages"] for t, tb in book.tables.items()}
        body = _pushed(_fill_pages(_set_out(book), pos), pushed)
        try:
            doc, pos = _layout(book, body)
        except RuntimeError:
            for t, pages in kept.items():   # a split that will not lay out: back to the last one that did
                book.tables[t]["pages"] = pages
            break
        good = (doc, pos)
        changed = False
        for t, tb in book.tables.items():
            pages = _pages_of(t, tb, pos)
            if pages and len(pages) == 1 and tb["pages"] is None:
                continue   # on one page: whole, as it is (in two columns, balanced already)
            if pages and pages != tb["pages"]:
                tb["pages"] = pages
                changed = True
        more = _squeezed(doc, body) - pushed
        pushed |= more
        if not changed and not more:
            break
    else:
        good = None   # still moving after every pass: set out once more as it now stands
    if good is None:
        good = _layout(book, _pushed(_fill_pages(_set_out(book), pos), pushed))
    doc, pos = good
    for page in doc:
        page.wrap_contents()   # the story's own drawing state closed, so what is drawn over it is in page coordinates
    _find_markers(doc, pos)
    for k, (svg, w, h) in book.svgs.items():
        at = pos.get("zs-%d" % k)
        if at:
            _draw_svg(doc[at[0]], at[1], svg)
    for n, box in book.maths.items():
        at = pos.get("zm-%d" % n)
        if not at:
            continue
        page, rect = doc[at[0]], at[1]
        k = min(1.0, rect.width / box.w) if box.w else 1.0
        box.draw(page, rect.x0, rect.y0 + 1 + box.a * k, scale=k)
        lines = book.labels.get(n)
        if lines:   # its name, in the column the equation is set in from, centred on it
            font, lh = _charis(True), EQ_LABEL_LH
            top = (rect.y0 + rect.y1) / 2 - len(lines) * lh / 2
            tw = pymupdf.TextWriter(page.rect, color=EQ_LABEL_COLOUR)
            for i, line in enumerate(lines):
                tw.append((MARGIN[0], top + (i + 0.78) * lh), line, font=font, fontsize=EQ_LABEL_PT)
            tw.write_text(page)
    _furniture(doc, book, pos)
    try:
        doc.subset_fonts()   # only the letters used (an older PyMuPDF asks fontTools for it: the whole fonts then)
    except Exception as e:
        log.info("almanac book: fonts kept whole: %s", e)
    _fix_to_unicode(doc)
    return doc.tobytes(garbage=3, deflate=True)


_CMAP_DEST = re.compile(rb"<([0-9a-fA-F]{5,6})>")


# The maths font draws one glyph for several letters: its map names the sans-serif ones, which the equations do not
# use. Read back as the letters they are set as: upright and digits as plain letters, italics as maths italics.
_SAME_GLYPH = (
    (0x1D5A0, 0x1D5D3, ord("A") - 0x1D5A0, 0x1D5BA, ord("a") - 0x1D5BA),   # sans-serif A-Z, a-z
    (0x1D608, 0x1D63B, 0x1D434 - 0x1D608, None, None),                      # sans-serif italic: maths italic
    (0x1D7E2, 0x1D7EB, ord("0") - 0x1D7E2, None, None),                     # sans-serif digits
)


def _as_set(v):
    for lo, hi, shift, lower_at, lower_shift in _SAME_GLYPH:
        if lo <= v <= hi:
            return v + (lower_shift if lower_at is not None and v >= lower_at else shift)
    return v


def _utf16(m):
    v = _as_set(int(m.group(1), 16))
    if v < 0x10000:
        return b"<%04X>" % v
    v -= 0x10000
    return b"<%04X%04X>" % (0xD800 + (v >> 10), 0xDC00 + (v & 0x3FF))


def _fix_to_unicode(doc):
    """MuPDF writes a font's letters past U+FFFF (the maths italics) into its ToUnicode map as bare five-digit codes,
    which readers take for other letters: each written as the UTF-16 pair the map's format asks for, so a copied or
    searched equation is its own letters."""
    for xref in range(1, doc.xref_length()):
        try:
            if doc.xref_get_key(xref, "CMapName")[1] != "/Adobe-Identity-UCS" and b"Adobe-Identity-UCS" not in (doc.xref_stream(xref) or b"")[:400]:
                continue
            data = doc.xref_stream(xref)
        except Exception:
            continue
        fixed = _CMAP_DEST.sub(_utf16, data)
        if fixed != data:
            doc.update_stream(xref, fixed)


def _child_main(paper, src, out):
    """`python -m zimi.almanacbook <paper> <html file> <pdf file>`: one render, as almanacpdf starts it."""
    try:
        os.nice(10)   # the server's requests first
    except (AttributeError, OSError):
        pass
    with open(src, encoding="utf-8", errors="surrogatepass") as f:
        data = render(f.read(), paper)
    with open(out, "wb") as f:
        f.write(data)


if __name__ == "__main__":
    _child_main(*sys.argv[1:4])
