"""The Z, straight from the font: SF Compact's default instance (wght 1000, Black), glyph "Z", outline in font units on a
2048 em, y up.  Never trace icon.png; this is the one source.  Prints the outline and checks it against ZG in build.py.

    python3 scripts/icons/zglyph.py        # needs fontTools; the font is /System/Library/Fonts/SFCompact.ttf (macOS)
"""
import os, re, sys
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen

FONT = '/System/Library/Fonts/SFCompact.ttf'

def glyph_points(char='Z'):
    font = TTFont(FONT); pen = RecordingPen()
    font.getGlyphSet()[font.getBestCmap()[ord(char)]].draw(pen)
    return [p[0] for op, p in pen.value if op in ('moveTo', 'lineTo')], font['head'].unitsPerEm

if __name__ == '__main__':
    pts, em = glyph_points()
    print('em', em, 'points', pts)
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build.py')).read()
    zg = [tuple(int(v) for v in m) for m in re.findall(r'\((\d+),(\d+)\)', re.search(r'^ZG = \[(.*?)\]$', src, re.M).group(1))]
    print('matches ZG in build.py' if zg == pts else 'DIFFERS from ZG in build.py'); sys.exit(0 if zg == pts else 1)
