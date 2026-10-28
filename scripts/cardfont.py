#!/usr/bin/env python3
"""Cuts the card index alphabet (A 2-10 J Q K, and 11 and 12 for the Spanish deck and Hanafuda's months) out of an openly licensed font.

The outlines are taken from the font file with fontTools, scaled so the cap height is 14 grid units (y down, x from 0 at the glyph's
ink), and written into cards.js as SVG paths: nothing is fetched, and no font file ships. The font's licence (SIL OFL 1.1) lets
the outlines travel with its copyright notice, which cards.js, the shelf footer and every About page carry. A two-digit rank is its
two digits side by side with DIGIT_GAP clear between the ink, condensed in width only (never in height) when it would not fit the
index column (MAX_W).

    python3 scripts/cardfont.py FONT.ttf [wght=700 wdth=75 ...] [--tnum] [--write]

Without --write the JS table is printed. With it, the block between the glyphs:begin/end markers in cards.js is replaced.
Needs fontTools (a dev tool only).
"""

import os
import re
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

CAP = 14.0  # grid units from baseline to cap line
MAX_W = 15.0  # the widest rank's ink: the index column (cards.js IDX_COLUMN) leaves room for 15 units at IDX_SCALE
DIGIT_GAP = 2.25  # clear paper between the digits of a two-digit rank (tests/test_games_pixels.cjs DIGIT_GAP)
SINGLES = "A23456789JQK"
CARDS_JS = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "zimi",
    "builtin",
    "games",
    "cards.js",
)


def load(path, axes=None):
    font = TTFont(path)
    if "fvar" in font:
        instancer.instantiateVariableFont(font, axes or {}, inplace=True)
    return font


def tnum_map(font):
    """The font's tabular-figure substitutions (glyph name to glyph name), or {}."""
    out = {}
    if "GSUB" not in font:
        return out
    gsub = font["GSUB"].table
    idx = {
        i
        for fr in gsub.FeatureList.FeatureRecord
        if fr.FeatureTag == "tnum"
        for i in fr.Feature.LookupListIndex
    }
    for i in idx:
        for st in gsub.LookupList.Lookup[i].SubTable:
            st = getattr(st, "ExtSubTable", st)
            out.update(getattr(st, "mapping", {}))
    return out


class Cutter:
    def __init__(self, font, tnum=False):
        self.gs, self.cmap = font.getGlyphSet(), font.getBestCmap()
        self.sub = tnum_map(font) if tnum else {}
        self.scale = CAP / self.ink("H")[3]

    def name(self, ch):
        n = self.cmap[ord(ch)]
        return self.sub.get(n, n)

    def ink(self, ch):
        pen = BoundsPen(self.gs)
        self.gs[self.name(ch)].draw(pen)
        return pen.bounds

    def outline(self, ch):
        """(path commands as a list of (cmd, points), ink width) in grid units, x from 0, y down from the cap line."""
        x0, _, x1, _ = self.ink(ch)
        rec = []
        s = self.scale
        pen = TransformPen(_Rec(rec, self.gs), (s, 0, 0, -s, -x0 * s, CAP))
        self.gs[self.name(ch)].draw(pen)
        return rec, (x1 - x0) * s


class _Rec:
    """Records a pen's calls; qCurveTo's implied on-curve points are expanded here so the path can be stretched and joined."""

    def __init__(self, out, gs):
        self.out, self.gs = out, gs

    def addComponent(self, name, transform):
        self.gs[name].draw(TransformPen(self, transform))

    def moveTo(self, p):
        self.out.append(("M", [p]))

    def lineTo(self, p):
        self.out.append(("L", [p]))

    def curveTo(self, *p):
        self.out.append(("C", list(p)))

    def qCurveTo(self, *p):
        pts = list(p)
        if pts[-1] is None:
            raise ValueError("closed all-off-curve contour")
        for i, c in enumerate(pts[:-1]):
            nxt = pts[i + 1]
            end = (
                nxt if i == len(pts) - 2 else ((c[0] + nxt[0]) / 2, (c[1] + nxt[1]) / 2)
            )
            self.out.append(("Q", [c, end]))

    def closePath(self):
        self.out.append(("Z", []))

    endPath = closePath


def fmt(v):
    s = ("%.2f" % v).rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def path_d(rec, dx=0.0, sx=1.0):
    parts = []
    for cmd, pts in rec:
        parts.append(
            cmd + " ".join("%s %s" % (fmt(x * sx + dx), fmt(y)) for x, y in pts)
        )
    return "".join(parts)


def glyph_table(cut):
    """label -> (d, width, condense): every rank the deck prints."""
    rows = {}
    for ch in SINGLES:
        rec, w = cut.outline(ch)
        rows[ch] = (path_d(rec), w, 1.0)
    one, w1 = cut.outline("1")
    rows["1"] = (path_d(one), w1, 1.0)
    for label in ("10", "11", "12"):
        a, wa = cut.outline(label[0])
        b, wb = cut.outline(label[1])
        k = min(1.0, (MAX_W - DIGIT_GAP) / (wa + wb))
        wa, wb = wa * k, wb * k
        rows[label] = (
            path_d(a, 0, k) + path_d(b, wa + DIGIT_GAP, k),
            wa + DIGIT_GAP + wb,
            k,
        )
    return rows


def js_table(rows):
    lines = [
        "    %s: { d: '%s', w: %s }" % ("'%s'" % k if k[0].isdigit() else k, d, fmt(w))
        for k, (d, w, _) in rows.items()
    ]
    return "  var GLYPHS = {\n" + ",\n".join(lines) + "\n  };"


def main(argv):
    path = next(a for a in argv if a.endswith(".ttf"))
    axes = {
        a.split("=")[0]: float(a.split("=")[1])
        for a in argv
        if re.match(r"^[A-Za-z]{4}=[\d.]+$", a)
    }
    rows = glyph_table(Cutter(load(path, axes), "--tnum" in argv))
    js = js_table(rows)
    if "--write" in argv:
        s = open(CARDS_JS, encoding="utf-8").read()
        s = re.sub(
            r"(// glyphs:begin[^\n]*\n).*?(  // glyphs:end)",
            lambda m: m.group(1) + js + "\n" + m.group(2),
            s,
            flags=re.S,
        )
        open(CARDS_JS, "w", encoding="utf-8", newline="\n").write(s)
    else:
        print(js)
    for k, (_, w, c) in rows.items():
        sys.stderr.write(
            "%s w=%.2f%s\n" % (k, w, "" if c == 1 else " condensed %.2f" % c)
        )


if __name__ == "__main__":
    main(sys.argv[1:])
