"""The Almanac's equations typeset without a browser: Presentation MathML (Temml's output) laid out and drawn into a PDF page.

The subset the Almanac's book uses (zimi/static/almanac-tables.js writes its TeX, Temml turns it into MathML): mrow, mi, mn,
mo, mtext, mspace, mpadded, mstyle, msup, msub, msubsup, mfrac, munder, mover, munderover, msqrt, mtable. Every glyph is
Noto Sans Math (SIL OFL 1.1, zimi/static/fonts, already embedded in the browser's PDFs), drawn as text and embedded as a
subset, never as outlines or pictures. The rules are TeX's in small: scripts at 71% then 50%, fractions on the maths axis,
operators spaced by their kind, fences stretched to what they enclose.

``layout(mathml, size)`` gives a ``Box`` (width, ascent, descent in points, and what to draw); ``Box.draw(page, x, y)``
puts it on a PyMuPDF page with its baseline at y.
"""

import html
import re
import threading
from xml.etree import ElementTree

import pymupdf

from zimi.almanacpdf import MATH_FONT

SCRIPT_SCALE = (1.0, 0.71, 0.5)  # TeX's text, script and scriptscript sizes
AXIS = 0.25  # the maths axis above the baseline, in em (where fraction bars and = sit)
RULE = 0.06  # a fraction bar's thickness, em
FRAC_GAP = (
    0.14,
    0.09,
)  # the gap from the bar to numerator and denominator: display, text (em)
SUP_UP = 0.41  # a superscript's baseline above the base's, em
SUB_DOWN = 0.2  # a subscript's below
SCRIPT_GAP = 0.05  # the least room between a script and its base's box, em
THIN, MEDIUM, THICK = 3 / 18, 4 / 18, 5 / 18  # TeX's spaces, em
LIMIT_GAP = 0.12  # under and over limits from their operator, em
LARGE_OP = 1.35  # a sum or product in display style, as a multiple of its glyph
STRETCH_SLACK = 1.12  # a fence is stretched once what it encloses is this much taller than the glyph
SQRT_GAP = 0.1  # the room above a root's content, em
TABLE_COL_GAP, TABLE_ROW_GAP = 0.8, 0.35  # an mtable's column and row spacing, em

# Spacing by kind (left, right), in em, as TeX's operator classes; a script level drops binary and relation space.
_REL = set("=<>≈≤≥≡≠∼≃≅∝→←↔⇒⇔∈∉⊂⊆:")
_BIN = set("+−-×·±∓÷∗∘⋅∖∩∪⊕⊗")
_PUNCT = set(",;")
_LARGE = set("∑∏∫∮⋃⋂")
_FENCES = set("()[]{}⌊⌋⌈⌉|‖⟨⟩")
_OPENERS = set("([{⌊⌈⟨")
_INVISIBLE = set("\u2061\u2062\u2063\u2064")   # function application, invisible times, separator, plus: no glyph, no width
_SPACE_NAMED = {
    "veryverythinmathspace": 1 / 18,
    "verythinmathspace": 2 / 18,
    "thinmathspace": THIN,
    "mediummathspace": MEDIUM,
    "thickmathspace": THICK,
    "verythickmathspace": 6 / 18,
    "veryverythickmathspace": 7 / 18,
}

# Mathematical italic for a single-letter identifier (MathML's default), and the holes the Unicode block leaves.
_ITALIC_HOLES = {"h": "ℎ"}
_GREEK_LOWER = "αβγδεζηθικλμνξοπρςστυφχψω"


def _italic(ch):
    if ch in _ITALIC_HOLES:
        return _ITALIC_HOLES[ch]
    o = ord(ch)
    if 0x41 <= o <= 0x5A:
        return chr(0x1D434 + o - 0x41)
    if 0x61 <= o <= 0x7A:
        return chr(0x1D44E + o - 0x61)
    if ch in _GREEK_LOWER:
        return chr(0x1D6FC + _GREEK_LOWER.index(ch))
    return ch


_font = None
_ink = {}
_lock = threading.Lock()


def font():
    global _font
    if _font is None:
        _font = pymupdf.Font(fontfile=MATH_FONT)
    return _font


def _ink_box(ch):
    """(ascent, descent) of a glyph's ink, in em: drawn once at a large size and read off its pixels."""
    with _lock:
        if ch in _ink:
            return _ink[ch]
        size, base = 100, 150
        doc = pymupdf.open()
        page = doc.new_page(width=300, height=300)
        tw = pymupdf.TextWriter(page.rect)
        tw.append((60, base), ch, font=font(), fontsize=size)
        tw.write_text(page)
        pix = page.get_pixmap(colorspace=pymupdf.csGRAY, alpha=False)
        w, h, s = pix.width, pix.height, pix.samples
        rows = [y for y in range(h) if min(s[y * w : (y + 1) * w]) < 128]
        if rows:
            box = ((base - rows[0]) / size, (rows[-1] + 1 - base) / size)
        else:
            box = (0.0, 0.0)
        doc.close()
        _ink[ch] = box
        return box


class Box:
    """A laid-out piece: width, ascent above and descent below its baseline (points); glyphs (x, dy, text, size,
    vertical scale) and rules (x, dy, w, h) relative to its left end and baseline, dy downward.
    """

    __slots__ = ("w", "a", "d", "glyphs", "rules", "italic")

    def __init__(self, w=0.0, a=0.0, d=0.0):
        self.w, self.a, self.d = w, a, d
        self.glyphs, self.rules = [], []
        self.italic = 0.0

    def place(self, other, x, dy):
        for g in other.glyphs:
            self.glyphs.append((g[0] + x, g[1] + dy) + g[2:])
        for r in other.rules:
            self.rules.append((r[0] + x, r[1] + dy, r[2], r[3]))

    def draw(self, page, x, y, color=(0, 0, 0), scale=1.0):
        """The box on ``page`` with its left end at x and its baseline at y (PDF points, y down), at ``scale`` (an
        equation too wide for its column is set smaller, whole, rather than cut)."""
        k = scale
        tw = pymupdf.TextWriter(page.rect, color=color)
        stretched = []
        for gx, gdy, text, size, sy in self.glyphs:
            if abs(sy - 1) > 1e-3:
                stretched.append((gx, gdy, text, size, sy))
            else:
                tw.append((x + gx * k, y + gdy * k), text, font=font(), fontsize=size * k)
        tw.write_text(page)
        for gx, gdy, text, size, sy in stretched:   # each upright stretch its own writer: a morph applies to all a writer holds
            at = pymupdf.Point(x + gx * k, y + gdy * k)
            one = pymupdf.TextWriter(page.rect, color=color)
            one.append(at, text, font=font(), fontsize=size * k)
            one.write_text(page, morph=(at, pymupdf.Matrix(1, 0, 0, sy, 0, 0)))
        shape = page.new_shape() if self.rules else None
        for rx, rdy, rw, rh in self.rules:
            shape.draw_rect(pymupdf.Rect(x + rx * k, y + rdy * k, x + (rx + rw) * k, y + (rdy + rh) * k))
        if shape:
            shape.finish(color=None, fill=color, width=0)
            shape.commit()


def _glyph_box(text, size, sy=1.0):
    f, b = font(), Box()
    b.w = f.text_length(text, size)
    a = d = 0.0
    for ch in text:
        ia, idd = _ink_box(ch)
        a, d = max(a, ia), max(d, idd)
    b.a, b.d = a * size * sy, d * size * sy
    b.glyphs.append((0.0, 0.0, text, size, sy))
    return b


def _hpack(boxes, gaps=None):
    out = Box()
    x = 0.0
    for i, b in enumerate(boxes):
        if gaps:
            x += gaps[i][0]
        out.place(b, x, 0.0)
        x += b.w
        if gaps:
            x += gaps[i][1]
        out.a, out.d = max(out.a, b.a), max(out.d, b.d)
    out.w = x
    return out


def _shift(b, dy):
    """The same box moved down by dy (its baseline stays where the caller puts it)."""
    out = Box(b.w, b.a - dy, b.d + dy)
    out.place(b, 0.0, dy)
    return out


def _em(value, size, default=0.0):
    if value is None:
        return default
    v = value.strip()
    if v in _SPACE_NAMED:
        return _SPACE_NAMED[v] * size
    m = re.fullmatch(r"(-?[\d.]+)\s*(em|ex|pt|px|mu)?", v)
    if not m:
        return default
    n, unit = float(m.group(1)), m.group(2) or "em"
    return (
        n * {"em": size, "ex": size * 0.5, "pt": 1.0, "px": 0.75, "mu": size / 18}[unit]
    )


def _local(tag):
    return tag.rsplit("}", 1)[-1]


class _Ctx:
    __slots__ = ("size", "level", "display")

    def __init__(self, size, level=0, display=True):
        self.size, self.level, self.display = size, level, display

    def script(self, display=False):
        lvl = min(self.level + 1, len(SCRIPT_SCALE) - 1)
        base = self.size / SCRIPT_SCALE[self.level]
        return _Ctx(base * SCRIPT_SCALE[lvl], lvl, display)

    def text(self):
        return _Ctx(self.size, self.level, False)


def _text_of(el):
    return html.unescape("".join(el.itertext())).strip()


def _token(el, ctx):
    tag, text = _local(el.tag), _text_of(el)
    if tag == "mi":
        variant = el.get("mathvariant")
        if variant != "normal" and len(text) == 1:
            text = _italic(text)
        b = _glyph_box(text, ctx.size)
        if len(text) == 1 and text != _text_of(el):
            b.italic = 0.06 * ctx.size  # a slanted letter leans into its superscript
        return b
    return _glyph_box(text or " ", ctx.size)


def _op_space(op, el, ctx):
    """(left, right) space round an operator, em → points: the attributes Temml wrote, else its kind's."""
    s = ctx.size
    small = ctx.level > 0
    if op in _REL:
        left = right = 0 if small else THICK
    elif op in _BIN:
        left = right = 0 if small else MEDIUM
    elif op in _PUNCT:
        left, right = 0, (0 if small else THIN)
    elif op in _LARGE:
        left, right = THIN * 0, THIN
    else:
        left = right = 0
    lx = _em(el.get("lspace"), s, left * s)
    rx = _em(el.get("rspace"), s, right * s)
    return lx, rx


def _mrow(children, ctx):
    """Children side by side, operators spaced, fences stretched to the tallest thing between them."""
    items = [c for c in children]
    laid = []
    for c in items:
        if _local(c.tag) == "mo":
            laid.append(
                None
            )  # an operator is laid once the row's height is known (a fence stretches to it)
        else:
            laid.append(_layout(c, ctx))
    inner_a = max([b.a for b in laid if b] or [AXIS * ctx.size + 0.3 * ctx.size])
    inner_d = max([b.d for b in laid if b] or [0.3 * ctx.size - AXIS * ctx.size])
    boxes, gaps = [], []
    for c, b in zip(items, laid):
        if b is None:
            op = _text_of(c)
            if op in _LARGE and ctx.display:
                b = _glyph_box(op, ctx.size * LARGE_OP)
                b = _shift(
                    b, (b.a - b.d) / 2 - AXIS * ctx.size
                )  # a large operator is centred on the axis
            elif c.get("stretchy") == "true" or (
                op in _FENCES and c.get("fence") == "true"
            ):
                b = _fence(op, ctx, inner_a, inner_d)
            elif op in _INVISIBLE:
                b = Box()
            else:
                b = _glyph_box(op, ctx.size)
            gaps.append(_op_space(op, c, ctx))
        else:
            gaps.append((0.0, 0.0))
        boxes.append(b)
    # A binary operator at the start of a row, or after a relation, another binary operator, punctuation or an opening
    # fence, is a sign: no space round it.
    for i, c in enumerate(items):
        if _local(c.tag) == "mo" and _text_of(c) in _BIN and c.get("lspace") is None:
            prev = items[i - 1] if i else None
            prev_op = _text_of(prev) if prev is not None and _local(prev.tag) == "mo" else None
            if c.get("form") == "prefix" or prev is None or (prev_op is not None and (prev_op in _REL or prev_op in _BIN or prev_op in _PUNCT or prev_op in _OPENERS)):
                gaps[i] = (0.0, 0.0)
    return _hpack(boxes, gaps)


def _fence(op, ctx, a, d):
    """A fence as tall as what it encloses, centred on the axis: the glyph stretched upright once it is too short."""
    b = _glyph_box(op, ctx.size)
    axis = AXIS * ctx.size
    half = max(a - axis, d + axis)
    want = 2 * half
    have = b.a + b.d
    if have <= 0 or want <= have * STRETCH_SLACK:
        return b
    sy = want / have
    out = _glyph_box(op, ctx.size, sy)
    # Scaled about its baseline, the glyph's centre moved: put it back on the axis.
    centre = (out.a - out.d) / 2
    return _shift(out, centre - axis)


def _scripts(base, sub, sup, ctx):
    s = ctx.size
    out = Box()
    out.place(base, 0.0, 0.0)
    x = base.w
    up = down = 0.0
    if sup is not None:
        up = max(SUP_UP * s, base.a - 0.5 * sup.a, sup.d + 0.25 * s)
    if sub is not None:
        down = max(
            SUB_DOWN * s,
            base.d + 0.15 * s if base.d > 0.05 * s else 0,
            sub.a - 0.8 * 0.5 * s,
        )
    if sup is not None and sub is not None:
        gap = (up - sup.d) - (sub.a - down)
        if gap < 4 * RULE * s:
            down += 4 * RULE * s - gap
    w = 0.0
    if sup is not None:
        out.place(sup, x + base.italic, -up)
        w = max(w, sup.w + base.italic)
        out.a = max(out.a, up + sup.a)
    if sub is not None:
        out.place(sub, x, down)
        w = max(w, sub.w)
        out.d = max(out.d, down + sub.d)
    out.a, out.d = max(out.a, base.a), max(out.d, base.d)
    out.w = x + w + 0.03 * s
    return out


def _frac(num, den, ctx, thickness):
    s = ctx.size
    axis, gap = AXIS * s, FRAC_GAP[0 if ctx.display else 1] * s
    w = max(num.w, den.w) + 0.2 * s
    out = Box(w)
    up = axis + thickness / 2 + gap + num.d
    down = -axis + thickness / 2 + gap + den.a
    out.place(num, (w - num.w) / 2, -up)
    out.place(den, (w - den.w) / 2, down)
    if thickness > 0:
        out.rules.append((0.08 * s, -axis - thickness / 2, w - 0.16 * s, thickness))
    out.a, out.d = up + num.a, down + den.d
    return out


def _limits(base, under, over, ctx):
    s = ctx.size
    w = max(base.w, under.w if under else 0, over.w if over else 0)
    out = Box(w, base.a, base.d)
    out.place(base, (w - base.w) / 2, 0.0)
    if over is not None:
        dy = base.a + LIMIT_GAP * s + over.d
        out.place(over, (w - over.w) / 2, -dy)
        out.a = dy + over.a
    if under is not None:
        dy = base.d + LIMIT_GAP * s + under.a
        out.place(under, (w - under.w) / 2, dy)
        out.d = dy + under.d
    return out


def _sqrt(inner, ctx):
    s = ctx.size
    rule = RULE * s
    want = inner.a + inner.d + SQRT_GAP * s + rule
    sign = _glyph_box("√", s)
    have = sign.a + sign.d
    sy = max(1.0, want / have) if have else 1.0
    sign = _glyph_box("√", s, sy)
    sign = _shift(
        sign, (sign.a - (inner.a + SQRT_GAP * s + rule))
    )  # its top meets the bar
    out = Box()
    out.place(sign, 0.0, 0.0)
    x = sign.w - 0.02 * s
    out.place(inner, x + 0.05 * s, 0.0)
    top = inner.a + SQRT_GAP * s
    out.rules.append((x, -top - rule, inner.w + 0.1 * s, rule))
    out.w = x + inner.w + 0.15 * s
    out.a, out.d = max(sign.a, top + rule), max(sign.d, inner.d)
    return out


def _table(el, ctx):
    s = ctx.size
    rows = []
    for tr in el:
        if _local(tr.tag) not in ("mtr", "mlabeledtr"):
            continue
        rows.append([_mrow(list(td), ctx) for td in tr if _local(td.tag) == "mtd"])
    if not rows:
        return Box()
    ncol = max(len(r) for r in rows)
    colw = [max((r[i].w for r in rows if i < len(r)), default=0) for i in range(ncol)]
    gap_c, gap_r = TABLE_COL_GAP * s, TABLE_ROW_GAP * s
    top = Box()   # rows from the top: each row's baseline at y (down)
    y = 0.0
    for r in rows:
        y += max(b.a for b in r)
        x = 0.0
        for i, b in enumerate(r):
            top.place(b, x + (colw[i] - b.w) / 2, y)
            x += colw[i] + gap_c
        y += max(b.d for b in r) + gap_r
    total = y - gap_r
    # The block's middle on the maths axis.
    out = Box(sum(colw) + gap_c * (ncol - 1), total / 2 + AXIS * s, total / 2 - AXIS * s)
    out.place(top, 0.0, -out.a)
    return out


def _layout(el, ctx):
    tag = _local(el.tag)
    kids = list(el)
    if tag in ("mi", "mn", "mtext", "ms"):
        return _token(el, ctx)
    if tag == "mo":
        return Box() if _text_of(el) in _INVISIBLE else _glyph_box(_text_of(el), ctx.size)
    if tag == "mspace":
        return Box(
            _em(el.get("width"), ctx.size),
            _em(el.get("height"), ctx.size),
            _em(el.get("depth"), ctx.size),
        )
    if tag == "mstyle":
        lvl = el.get("scriptlevel")
        disp = el.get("displaystyle")
        c = _Ctx(ctx.size, ctx.level, ctx.display if disp is None else disp == "true")
        if lvl is not None:
            try:
                target = max(
                    0,
                    min(
                        len(SCRIPT_SCALE) - 1,
                        ctx.level + int(lvl) if lvl[0] in "+-" else int(lvl),
                    ),
                )
                c = _Ctx(
                    ctx.size / SCRIPT_SCALE[ctx.level] * SCRIPT_SCALE[target],
                    target,
                    c.display,
                )
            except ValueError:
                pass
        return _mrow(kids, c)
    if tag in ("mrow", "mpadded", "math", "semantics", "mphantom"):
        b = _mrow(
            [k for k in kids if _local(k.tag) not in ("annotation", "annotation-xml")],
            ctx,
        )
        if tag == "mphantom":
            b.glyphs, b.rules = [], []
        return b
    if tag == "msup" and len(kids) == 2:
        return _scripts(
            _layout(kids[0], ctx), None, _layout(kids[1], ctx.script()), ctx
        )
    if tag == "msub" and len(kids) == 2:
        return _scripts(
            _layout(kids[0], ctx), _layout(kids[1], ctx.script()), None, ctx
        )
    if tag == "msubsup" and len(kids) == 3:
        sc = ctx.script()
        return _scripts(
            _layout(kids[0], ctx), _layout(kids[1], sc), _layout(kids[2], sc), ctx
        )
    if tag == "mfrac" and len(kids) == 2:
        inner = ctx.text() if ctx.display else ctx.script()
        th = el.get("linethickness")
        thickness = 0.0 if th in ("0", "0px", "0em") else RULE * ctx.size
        return _frac(_layout(kids[0], inner), _layout(kids[1], inner), ctx, thickness)
    if tag in ("munder", "mover", "munderover"):
        base_el = kids[0]
        base = _layout(base_el, ctx)
        if _local(base_el.tag) == "mo" and _text_of(base_el) in _LARGE and ctx.display:
            base = _glyph_box(_text_of(base_el), ctx.size * LARGE_OP)
            base = _shift(base, (base.a - base.d) / 2 - AXIS * ctx.size)
        movable = (
            ctx.display
            or el.get("movablelimits") == "false"
            or _local(base_el.tag) != "mo"
        )
        sc = ctx.script()
        under = (
            _layout(kids[1], sc)
            if tag in ("munder", "munderover") and len(kids) > 1
            else None
        )
        over = (
            _layout(kids[-1], sc)
            if tag in ("mover", "munderover") and len(kids) > 1
            else None
        )
        if tag == "mover" and _text_of(kids[-1]) in (
            "^",
            "ˆ",
            "~",
            "˜",
            "¯",
            "‾",
            "→",
            "⃗",
            "˙",
            "¨",
        ):
            over = _layout(kids[-1], ctx)  # an accent is at the base's own size
        if not movable:
            return _scripts(base, under, over, ctx)
        return _limits(base, under, over, ctx)
    if tag == "msqrt":
        return _sqrt(_mrow(kids, ctx), ctx)
    if tag == "mroot" and len(kids) == 2:
        return _sqrt(_layout(kids[0], ctx), ctx)
    if tag == "mtable":
        return _table(el, ctx)
    if tag in ("mtr", "mtd"):
        return _mrow(kids, ctx)
    return _mrow(kids, ctx)


_XMLNS = re.compile(r"\sxmlns(:\w+)?=\"[^\"]*\"")


def parse(mathml):
    """The MathML string (HTML-flavoured: entities, no namespace) as an element tree. It comes from the page asking for
    the PDF: anything that could declare entities (a DOCTYPE, an ENTITY) is refused before the parser sees it."""
    if "<!" in mathml or "<?" in mathml:
        raise ValueError("not MathML")
    text = _XMLNS.sub("", mathml)
    text = re.sub(r"&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)", "&amp;", text)
    text = re.sub(
        r"&(nbsp|thinsp|ensp|emsp|ThinSpace|MediumSpace|InvisibleTimes|ApplyFunction);",
        lambda m: html.unescape("&" + m.group(1) + ";"),
        text,
    )
    return ElementTree.fromstring(text)


def layout(mathml, size, display=True):
    """``mathml`` (one <math> element's markup) laid out at ``size`` points."""
    return _layout(parse(mathml), _Ctx(size, 0, display))
