"""Zimi's mark and the two Zimi-own ZIM icons, drawn from numbers.  The recipe is docs/design/icons.md.

The mark is icon.png's Z (SF Compact Black, outline in ZG) on a river pebble. ZimiGames' icon is one
physically consistent scene (camera and light derived in the games block below); the Almanac's is the
sky of one fixed day (astro.py, glitter.py, splat.py are its helpers).  Run from the repo root:

    python3 scripts/icons/build.py                 # the svgs, into --out DIR (default $ZIMI_ICONS_OUT or a temp dir)
    python3 scripts/icons/build.py --apply         # also rewrite games/mark.svg, games/icon.svg and the mark block in cards.js
    python3 scripts/icons/build.py --icons         # also rasterise both icon.png (Chrome and ImageMagick)
    python3 scripts/icons/build.py --check         # exit 1 if games/mark.svg or cards.js drifted from the generator
    python3 scripts/icons/build.py --review        # a board.html of every icon at 1024, 96, 48 and 32 to look at
"""
import math, os, re, datetime as dt
import astro
import sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(os.path.dirname(HERE))
def _arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default
OUT = _arg('--out', os.environ.get('ZIMI_ICONS_OUT') or os.path.join(tempfile.gettempdir(), 'zimi-icons')); os.makedirs(OUT, exist_ok=True)
GRAD = '<stop offset="0" stop-color="#f59e0b"/><stop offset=".5" stop-color="#f97316"/><stop offset="1" stop-color="#ef4444"/>'

# The Z in icon.png: SF Compact Black, glyph "Z" straight from /System/Library/Fonts/SFCompact.ttf
# (its default instance), font units on a 2048 em, y up. generate_icons.py rendered exactly this.
ZG = [(110,0),(1184,0),(1184,326),(611,326),(611,346),(1161,1103),(1161,1365),(115,1365),(115,1039),(660,1039),(660,1020),(110,262)]
EM = 2048
def zpath(box, ox=0, oy=0):
    """The Z as the app icon sets it: font size 0.72 of the box, glyph bounds centred."""
    s = box * .72 / EM
    x0, x1 = min(p[0] for p in ZG), max(p[0] for p in ZG); y1 = max(p[1] for p in ZG)
    cx, cy = (x0 + x1) / 2, y1 / 2
    return 'M' + 'L'.join(f'{ox + box/2 + (x-cx)*s:.3f} {oy + box/2 - (y-cy)*s:.3f}' for x, y in ZG) + 'Z'

T = 35                          # tab size, in the icon's 100 units
TR = T * .223                   # the app icon's corner ratio
TAB = f'M0 0H{T}V{T-TR:.3f}A{TR:.3f} {TR:.3f} 0 0 1 {T-TR:.3f} {T}H0Z'
EDGE = f'M{T} 0V{T-TR:.3f}A{TR:.3f} {TR:.3f} 0 0 1 {T-TR:.3f} {T}H0'
import splat
import math
PX, PY, PRX, PRY, PROT = 19.4, 18.2, 15.0, 12.6, -8     # the pebble: centre, radii, tilt
def pebble_points(cx=PX, cy=PY, rx=PRX, ry=PRY, rot=PROT, n=40):
    """A river pebble: an ellipse worn a little flatter underneath and fuller
    on one shoulder. Small low harmonics only, so it stays convex and smooth."""
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        k = 1 + .028 * math.cos(2 * t + .9) + .014 * math.sin(3 * t + .3) - .012 * math.cos(t - .6)
        x, y = rx * k * math.cos(t), ry * k * math.sin(t)
        y -= .6 * max(0, math.sin(t)) ** 3                  # the flatter underside it rests on
        r = math.radians(rot)
        pts.append((cx + x * math.cos(r) - y * math.sin(r), cy + x * math.sin(r) + y * math.cos(r)))
    return pts
def pebble_path(**kw):
    return splat.catmull(pebble_points(**kw))
# The mark's viewBox: 36 x 33 centred on the pebble's real ink (its bounds, sampled finely), so the pebble sits
# in the middle of the box at every size instead of a fraction of a unit off.
BOX_W, BOX_H = 36, 33
_ink = pebble_points(n=4000)
BOX = '%.3f %.3f %d %d' % ((min(p[0] for p in _ink) + max(p[0] for p in _ink)) / 2 - BOX_W / 2,
                           (min(p[1] for p in _ink) + max(p[1] for p in _ink)) / 2 - BOX_H / 2, BOX_W, BOX_H)
import splat
ZB = 31                                             # the Z's box: a little smaller than the tab's, for the pebble's margin
def tab(p):
    """The mark: our Z on a dark pebble, an island just off the corner."""
    return (f'<linearGradient id="{p}z" gradientUnits="userSpaceOnUse" x1="{PX-ZB/2}" y1="{PY-ZB/2}" x2="{PX+ZB/2}" y2="{PY+ZB/2}">{GRAD}</linearGradient>'
            f'<linearGradient id="{p}ps" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f1a17"/><stop offset=".55" stop-color="#0d0b0a"/><stop offset="1" stop-color="#070605"/></linearGradient>'
            f'<filter id="{p}pd" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="1.6" stdDeviation="1.6" flood-color="#000" flood-opacity=".45"/></filter>',
            f'<path d="{pebble_path()}" fill="url(#{p}ps)" filter="url(#{p}pd)"/>'
            f'<path d="{pebble_path()}" fill="none" stroke="#fff" stroke-opacity=".10" stroke-width=".6"/>'
            f'<path d="{zpath(ZB, PX-ZB/2, PY-ZB/2)}" fill="url(#{p}z)"/>')
def icon(p, defs, body):
    td, tb = tab(p)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><clipPath id="{p}c"><rect width="100" height="100" rx="22.4"/></clipPath>'
            f'<radialGradient id="{p}v" cx=".5" cy=".5" r=".72"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".42"/></radialGradient>'
            f'{td}{defs}</defs><g clip-path="url(#{p}c)">{body}<rect width="100" height="100" fill="url(#{p}v)"/>{tb}</g></svg>')
def save(n, s): open(os.path.join(OUT, n), 'w').write(s)

td, tb = tab('m')
save('mark.svg', f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{BOX}"><defs>{td}</defs>{tb}</svg>')
save('mark-mono.svg', f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{BOX}"><defs><mask id="mm"><rect width="40" height="40" fill="#fff"/><path d="{zpath(ZB, PX-ZB/2, PY-ZB/2)}" fill="#000"/></mask></defs><path d="{pebble_path()}" fill="#000" mask="url(#mm)"/></svg>')
# the app icon itself, drawn from the same numbers, to prove the Z matches icon.png
save('app-check.svg', f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="k" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="100">{GRAD}</linearGradient></defs><rect width="100" height="100" rx="22.3" fill="#0a0a0b"/><path d="{zpath(100)}" fill="url(#k)"/></svg>')

# ---- ZimiGames: one table, one camera, one light
#
# CAMERA (derivation).  World is millimetres on the felt: x right, y away from the viewer, z up, origin
# at the table's centre.  A pinhole camera sits CAM_DIST (700 mm) from the point it looks at, on the
# viewer's side, at 58 degrees elevation, looking along +y (no roll, no yaw): forward = (0, cos58, -sin58),
# right = (1,0,0), up = right x forward = (0, sin58, cos58).  A point p projects to
# (dot(p-CAM,right), -dot(p-CAM,up)) / dot(p-CAM,forward): real perspective (the far card is a little
# smaller than the near joystick).  The result is scaled and centred once so the group fills the tile.
#
# LIGHT (derivation).  One key light, from the left and behind the objects, 58 degrees above the felt:
# L (unit vector towards the light) = (cos58*hx, cos58*hy, sin58) with the horizontal bearing (hx,hy) =
# normalised (-0.82, +0.30): from the left and a little behind.  A point at height h casts its shadow on a
# plane at height z0 to p - (h-z0)/Lz * L, i.e. (h-z0) * (+0.59, -0.21) in xy: to the right and a little
# toward the viewer, longer for taller things (the ball's is the longest and falls on the box's top).
# Shading: I(n) = AMB + (1-AMB)*max(0, n.L)/Lz, so the felt-parallel top faces are at 1.0, faces turned
# away from the light sit at AMB with a little green bounce from the felt.  Specular: half vector L+V.
#
# DIE: opposite faces sum to 7; 1,2,3 meet counter-clockwise at a corner as on a Western die; the check
# is the triple product n(1) x n(2) . n(3) > 0, asserted below.
import math


def v_add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def v_sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def v_mul(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def v_dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def v_cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def v_norm(a):
    l = math.sqrt(v_dot(a, a))
    return (a[0] / l, a[1] / l, a[2] / l)


CAM_EL, CAM_DIST, CAM_AT = math.radians(58), 700.0, (0.0, -6.0, 0.0)
CAM = (CAM_AT[0], CAM_AT[1] - CAM_DIST * math.cos(CAM_EL), CAM_DIST * math.sin(CAM_EL))
FWD = v_norm(v_sub(CAM_AT, CAM))
RIGHT = (1.0, 0.0, 0.0)
UP = v_cross(RIGHT, FWD)
LIGHT_EL = math.radians(58)
_hx, _hy = -0.82 / math.hypot(.82, .30), 0.30 / math.hypot(.82, .30)
LIGHT = v_norm((math.cos(LIGHT_EL) * _hx, math.cos(LIGHT_EL) * _hy, math.sin(LIGHT_EL)))
SHADOW_PER_MM = (
    -LIGHT[0] / LIGHT[2],
    -LIGHT[1] / LIGHT[2],
)  # xy shift of a shadow per mm of height


def raw(p):
    d = v_sub(p, CAM)
    z = v_dot(d, FWD)
    return (v_dot(d, RIGHT) / z, -v_dot(d, UP) / z, z)


# --- the scene, in mm
CARD_C, CARD_YAW, CARD_W, CARD_H, CARD_T = (
    (26.0, 30.0),
    14.0,
    63.0,
    88.0,
    0.9,
)  # a playing card, lying flat
DIE_C, DIE_YAW, DIE_S = (-29.0, 0.0), -36.0, 27.0
BOX_C, BOX_YAW, BOX_SZ = (26.0, -53.0), -5.0, (68.0, 40.0, 13.0)
STICK_AT = (-15.0, 2.0)  # base of the stick, in the box's own frame
STICK_DIR = v_norm((0.0, -0.06, 1.0))  # standing up, a touch toward the viewer
SHAFT_LEN, SHAFT_R, BALL_R = 50.0, 3.2, 10.8
WASHER_R, WASHER_H, BOOT_R0, BOOT_R1, BOOT_H = 8.5, 1.4, 5.2, 3.7, 4.6


def rz(x, y, deg):
    a = math.radians(deg)
    return (x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a))


def place(p, c, yaw, z0=0.0):
    x, y = rz(p[0], p[1], yaw)
    return (x + c[0], y + c[1], p[2] + z0)


# --- fit the projected scene to the tile once
def _scene_points():
    pts = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            pts.append(
                place((sx * CARD_W / 2, sy * CARD_H / 2, CARD_T), CARD_C, CARD_YAW)
            )
            for sz in (0, 1):
                pts.append(
                    place((sx * DIE_S / 2, sy * DIE_S / 2, sz * DIE_S), DIE_C, DIE_YAW)
                )
                pts.append(
                    place(
                        (sx * BOX_SZ[0] / 2, sy * BOX_SZ[1] / 2, sz * BOX_SZ[2]),
                        BOX_C,
                        BOX_YAW,
                    )
                )
    return pts


_bp = [raw(p)[:2] for p in _scene_points()]
_base = place((STICK_AT[0], STICK_AT[1], 0), BOX_C, BOX_YAW, BOX_SZ[2])
_ball = v_add(_base, v_mul(STICK_DIR, SHAFT_LEN + BALL_R * 0.6))
_bz = raw(_ball)
_br = BALL_R / _bz[2]
_bp += [(_bz[0] - _br, _bz[1] - _br), (_bz[0] + _br, _bz[1] + _br)]
_x0, _x1 = min(p[0] for p in _bp), max(p[0] for p in _bp)
_y0, _y1 = min(p[1] for p in _bp), max(p[1] for p in _bp)
FIT_W, FIT_H, FIT_CX, FIT_CY = 84.0, 80.0, 49.5, 53.5
S = min(FIT_W / (_x1 - _x0), FIT_H / (_y1 - _y0))
OX, OY = FIT_CX - S * (_x0 + _x1) / 2, FIT_CY - S * (_y0 + _y1) / 2
S, OX, OY = 435.1864725658407, 41.08364235272583, 56.53810028576235  # the fit the card and die were approved at, frozen


def P(p):
    x, y, _ = raw(p)
    return (OX + S * x, OY + S * y)


def depth(p):
    return raw(p)[2]


# --- svg helpers
GDEFS = []
_gid = [0]


def gid():
    _gid[0] += 1
    return f"q{_gid[0]}"


def f2(v):
    return f"{v:.2f}"


def pd(pts):
    return "M" + "L".join(f"{f2(x)} {f2(y)}" for x, y in pts) + "Z"


def poly(pts, fill, extra=""):
    return f'<path d="{pd(pts)}" fill="{fill}" {extra}/>'


def hexrgb(h):
    return tuple(int(h[i : i + 2], 16) for i in (1, 3, 5))


def rgbhex(c):
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(v))) for v in c)


def mixc(a, b, t):
    return rgbhex(tuple(x * (1 - t) + y * t for x, y in zip(hexrgb(a), hexrgb(b))))


BOUNCE = "#2f7a52"  # the felt's light, thrown back into the shade
AMB = 0.50


def lit(n):
    return max(0.0, v_dot(n, LIGHT))


def tone(n):
    return AMB + (1 - AMB) * min(1.0, lit(n) / LIGHT[2])


def shade(base, I):
    return mixc(rgbhex(tuple(v * I for v in hexrgb(base))), BOUNCE, (1 - I) * 0.16)


def blur(sigma):
    i = gid()
    GDEFS.append(
        f'<filter id="{i}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="{sigma:.2f}"/></filter>'
    )
    return i


def lingrad(p0, p1, c0, c1):
    i = gid()
    GDEFS.append(
        f'<linearGradient id="{i}" gradientUnits="userSpaceOnUse" x1="{f2(p0[0])}" y1="{f2(p0[1])}" x2="{f2(p1[0])}" y2="{f2(p1[1])}"><stop offset="0" stop-color="{c0}"/><stop offset="1" stop-color="{c1}"/></linearGradient>'
    )
    return i


def hull(pts):
    pts = sorted(set(pts))

    def half(seq):
        h = []
        for p in seq:
            while (
                len(h) >= 2
                and (h[-1][0] - h[-2][0]) * (p[1] - h[-2][1])
                - (h[-1][1] - h[-2][1]) * (p[0] - h[-2][0])
                <= 0
            ):
                h.pop()
            h.append(p)
        return h[:-1]

    return half(pts) + half(pts[::-1])


def ring(
    c, R, a, b, n=28
):  # a circle of radius R about c, in the plane spanned by unit vectors a, b
    return [
        v_add(
            c,
            v_add(
                v_mul(a, R * math.cos(2 * math.pi * i / n)),
                v_mul(b, R * math.sin(2 * math.pi * i / n)),
            ),
        )
        for i in range(n)
    ]


EX, EY, EZ = (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)


def cast(p, z0=0.0):  # where p's shadow falls on the plane at height z0
    k = (p[2] - z0) / LIGHT[2]
    return (p[0] - k * LIGHT[0], p[1] - k * LIGHT[1], z0)


def shadow(world_pts, h, z0=0.0, clip=""):
    """A cast shadow: AO-sharp at the contact, softer with the height h of what casts it."""
    s = [P(cast(p, z0)) for p in world_pts]
    hl = hull(s)
    o = ""
    for sig, op in ((0.35 + 0.018 * h, 0.34), (0.8 + 0.05 * h, 0.22)):
        o += f'<path d="{pd(hl)}" fill="#02110a" opacity="{op}" filter="url(#{blur(sig)})"/>'
    return f"<g {clip}>{o}</g>"


# --- a rounded box: faces, bevels and corners, each toned by the one light; hidden ones are skipped
def rbox(c, size, yaw, base, r, z0=0.0):
    half = (size[0] / 2, size[1] / 2, size[2] / 2)
    W = lambda p: place((p[0], p[1], p[2] + half[2]), c, yaw, z0)
    N = lambda a, s: (lambda v: (*rz(v[0], v[1], yaw), v[2]))(
        tuple(s if i == a else 0.0 for i in range(3))
    )

    def vis(n, p):
        return v_dot(n, v_sub(CAM, p)) > 0

    def pt(vals):  # vals: axis -> value
        return tuple(vals[i] for i in range(3))

    def facept(a, s, sb, sc, b, cc):
        v = {a: s * half[a], b: sb * (half[b] - r), cc: sc * (half[cc] - r)}
        return pt(v)

    out, tops = [], None
    faces = [(a, s) for a in range(3) for s in (-1, 1)]
    for a, s in faces:
        b, cc = [i for i in range(3) if i != a]
        n = N(a, s)
        pts = [
            facept(a, s, sb, sc, b, cc)
            for sb, sc in ((-1, -1), (1, -1), (1, 1), (-1, 1))
        ]
        ctr = W(pt({a: s * half[a], b: 0, cc: 0}))
        if vis(n, ctr):
            col = shade(base, tone(n))
            out.append(
                poly(
                    [P(W(p)) for p in pts],
                    col,
                    f'stroke="{col}" stroke-width=".3" stroke-linejoin="round"',
                )
            )
    for ia in range(3):
        for ib in range(ia + 1, 3):
            cc = 3 - ia - ib
            for sa in (-1, 1):
                for sb in (-1, 1):
                    na, nb = N(ia, sa), N(ib, sb)
                    n = v_norm(v_add(na, nb))
                    A = [
                        pt(
                            {
                                ia: sa * half[ia],
                                ib: sb * (half[ib] - r),
                                cc: sc * (half[cc] - r),
                            }
                        )
                        for sc in (1, -1)
                    ]
                    B = [
                        pt(
                            {
                                ia: sa * (half[ia] - r),
                                ib: sb * half[ib],
                                cc: sc * (half[cc] - r),
                            }
                        )
                        for sc in (-1, 1)
                    ]
                    mid = W(
                        pt(
                            {
                                ia: sa * (half[ia] - r / 2),
                                ib: sb * (half[ib] - r / 2),
                                cc: 0,
                            }
                        )
                    )
                    if (
                        not vis(n, mid)
                        or (sa == -1 and ia == 2)
                        or (ib == 2 and sb == -1)
                        or (ia == 2 and sa == -1)
                    ):
                        continue
                    pa = P(W(pt({ia: sa * half[ia], ib: sb * (half[ib] - r), cc: 0})))
                    pb = P(W(pt({ia: sa * (half[ia] - r), ib: sb * half[ib], cc: 0})))
                    g = lingrad(pa, pb, shade(base, tone(na)), shade(base, tone(nb)))
                    out.append(
                        poly(
                            [P(W(p)) for p in A + B],
                            f"url(#{g})",
                            f'stroke="url(#{g})" stroke-width=".3" stroke-linejoin="round"',
                        )
                    )
    for sa in (-1, 1):
        for sb in (-1, 1):
            for sc in (-1, 1):
                v = (sa, sb, sc)
                ns = [N(i, v[i]) for i in range(3)]
                n = v_norm(v_add(v_add(ns[0], ns[1]), ns[2]))
                if sc == -1:
                    continue
                pts = []
                for i in range(3):
                    vals = {
                        j: (v[j] * half[j] if j == i else v[j] * (half[j] - r))
                        for j in range(3)
                    }
                    pts.append(pt(vals))
                if not vis(n, W(pt({j: v[j] * (half[j] - r / 2) for j in range(3)}))):
                    continue
                ts = sorted(tone(x) for x in ns); col = shade(base, (ts[0] + ts[1]) / 2)
                out.append(
                    poly(
                        [P(W(p)) for p in pts],
                        col,
                        f'stroke="{col}" stroke-width=".3" stroke-linejoin="round"',
                    )
                )
    return "".join(out), W, half


def contact(W, half):
    """Ambient occlusion where a box meets the felt: a tight, dark rim just beyond its footprint."""
    return shadow([W((sx*half[0]*1.06, sy*half[1]*1.06, -half[2])) for sx in (-1, 1) for sy in (-1, 1)], 0.0)

def top_outline(W, half):
    return [
        P(W((sx * half[0], sy * half[1], half[2])))
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))
    ]


# --- the card: lies flat, so its plane is the felt's plane and it casts only a hair of shadow
def card():
    def C(x, y, z=0.0):
        return place((x, y, z), (CARD_C[0], CARD_C[1], 0), CARD_YAW)

    w, h, rr = CARD_W / 2, CARD_H / 2, 4.2

    def rr_pts(z):
        pts = []
        for cx, cy, a0 in (
            (w - rr, h - rr, 0),
            (-w + rr, h - rr, 90),
            (-w + rr, -h + rr, 180),
            (w - rr, -h + rr, 270),
        ):
            for i in range(7):
                a = math.radians(a0 + 90 * i / 6)
                pts.append(C(cx + rr * math.cos(a), cy + rr * math.sin(a), z))
        return pts

    lo, hi = rr_pts(0.0), rr_pts(CARD_T)
    edge = shade("#fbf6ea", tone(v_norm((0, -1, 0))))
    o = shadow(lo, 0.0)  # contact shadow only
    o += poly(hull([P(p) for p in lo + hi]), mixc(edge, "#8a7f66", 0.45))
    topc = shade("#fbf6ea", tone(EZ))
    o += poly([P(p) for p in hi], topc)
    o += f'<path d="{pd([P(p) for p in hi])}" fill="none" stroke="#d9cfb4" stroke-width=".35"/>'
    cells = {
        0: (1, 2, 4, 5),
        1: tuple(range(7)),
        2: tuple(range(7)),
        3: (1, 2, 3, 4, 5),
        4: (2, 3, 4),
        5: (3,),
    }  # the pixel heart
    cell = 6.0
    d = ""
    for row, cols in cells.items():
        for col in cols:
            x0, y0 = (col - 3.5) * cell, (2.5 - row) * cell + 4.0
            d += pd(
                [
                    P(C(x0, y0, CARD_T + 0.01)),
                    P(C(x0 + cell, y0, CARD_T + 0.01)),
                    P(C(x0 + cell, y0 - cell, CARD_T + 0.01)),
                    P(C(x0, y0 - cell, CARD_T + 0.01)),
                ]
            )
    o += f'<path d="{d}" fill="#e11d2e"/>'
    return o


# --- the die
DIE_VALUE = {
    (0, 1): 1,
    (0, -1): 6,
    (2, -1): 2,
    (2, 1): 5,
    (1, 1): 3,
    (1, -1): 4,
}  # local face normal -> pips


def _unit(a, s):
    return tuple(s if i == a else 0.0 for i in range(3))


_n = {v: _unit(*k) for k, v in DIE_VALUE.items()}
assert all(
    v_add(_n[v], _n[7 - v]) == (0.0, 0.0, 0.0) for v in range(1, 7)
), "opposite faces must sum to 7"
assert (
    v_dot(v_cross(_n[1], _n[2]), _n[3]) > 0
), "die must be right-handed (1,2,3 counter-clockwise)"
PIPS = {
    1: [(0, 0)],
    2: [(-1, -1), (1, 1)],
    3: [(-1, -1), (0, 0), (1, 1)],
    4: [(-1, -1), (1, -1), (-1, 1), (1, 1)],
    5: [(-1, -1), (1, -1), (0, 0), (-1, 1), (1, 1)],
    6: [(-1, -1), (-1, 0), (-1, 1), (1, -1), (1, 0), (1, 1)],
}


def smooth_box(c, size, yaw, base, r, k=8):
    """A true rounded box: every face is tessellated through its flat middle and its rounded rim, each quad
    toned by its own surface normal under the one light, so edges and corners shade smoothly."""
    half = tuple(v / 2 for v in size); hi = tuple(h - r for h in half)
    W = lambda p: place((p[0], p[1], p[2] + half[2]), c, yaw)
    def stops(a):                                   # grid along one axis: rim arc, flat middle, rim arc
        rim = [hi[a] + r * i / k for i in range(1, k + 1)]
        return [-v for v in reversed(rim)] + [-hi[a], hi[a]] + rim
    def surf(s):                                    # box-surface point -> (rounded-box point, its normal)
        q = tuple(max(-hi[i], min(hi[i], s[i])) for i in range(3)); d = v_sub(s, q)
        n = v_norm(d); return v_add(q, v_mul(n, r)), n
    out = []
    for a in range(3):
        for sg in (-1, 1):
            b, cc = [i for i in range(3) if i != a]
            gb, gc = sorted(set(round(v, 6) for v in stops(b))), sorted(set(round(v, 6) for v in stops(cc)))
            def S3(u, w):
                p = [0.0] * 3; p[a] = sg * half[a]; p[b] = u; p[cc] = w; return surf(tuple(p))
            for i in range(len(gb) - 1):
                for j in range(len(gc) - 1):
                    cs = [S3(gb[i], gc[j]), S3(gb[i + 1], gc[j]), S3(gb[i + 1], gc[j + 1]), S3(gb[i], gc[j + 1])]
                    nrm = v_norm(v_add(v_add(cs[0][1], cs[1][1]), v_add(cs[2][1], cs[3][1])))
                    nw = (*rz(nrm[0], nrm[1], yaw), nrm[2])
                    mid = W(v_mul(v_add(v_add(cs[0][0], cs[2][0]), (0, 0, 0)), .5))
                    if v_dot(nw, v_sub(CAM, mid)) <= 0: continue
                    col = shade(base, tone(nw))
                    out.append(poly([P(W(p[0])) for p in cs], col, f'stroke="{col}" stroke-width=".12" stroke-linejoin="round"'))
    return ''.join(out), W, half


def die():
    body, W, half = smooth_box(DIE_C, (DIE_S,) * 3, DIE_YAW, "#fff4dc", 2.4)
    o = shadow(
        [
            W((sx * half[0], sy * half[1], sz * half[2]))
            for sx in (-1, 1)
            for sy in (-1, 1)
            for sz in (-1, 1)
        ],
        DIE_S,
    )
    o += contact(W, half) + body
    for (a, s), v in DIE_VALUE.items():
        n = (*rz(*_unit(a, s)[:2], DIE_YAW), _unit(a, s)[2])
        if v_dot(n, v_sub(CAM, W(v_mul(_unit(a, s), half[a])))) <= 0:
            continue
        b, cc = [i for i in range(3) if i != a]
        e1, e2 = _unit(b, 1), _unit(cc, 1)
        for u, w in PIPS[v]:
            c0 = v_add(
                v_mul(_unit(a, s), half[a]),
                v_add(v_mul(e1, u * DIE_S * 0.265), v_mul(e2, w * DIE_S * 0.265)),
            )
            pts = [P(W(p)) for p in ring(c0, DIE_S * 0.082, e1, e2, 32)]
            I = tone(n)
            o += poly(pts, shade("#17151a", min(1, I * 1.15)))
    return o


# --- the joystick
def cylinder(c, R, h, top, side, z_extra=0.0):
    """A short upright cylinder standing at world point c: its side lit from the left, its top toned for the light."""
    bot = ring(c, R, EX, EY, 30)
    tp = ring(v_add(c, (0, 0, h)), R, EX, EY, 30)
    sp = [P(p) for p in bot + tp]
    hl = hull(sp)
    xs = [p[0] for p in sp]
    g = lingrad((min(xs), 0), (max(xs), 0), shade(side, 0.88), shade(side, 0.5))
    return (
        poly(hl, f"url(#{g})")
        + poly([P(p) for p in tp], shade(top, 1.0))
        + f'<path d="{pd([P(p) for p in tp])}" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width=".3"/>'
    )


def joystick():
    body, W, half = rbox(BOX_C, BOX_SZ, BOX_YAW, "#464654", 3.0)
    ztop = BOX_SZ[2]
    o = shadow(
        [
            W((sx * half[0], sy * half[1], sz * half[2]))
            for sx in (-1, 1)
            for sy in (-1, 1)
            for sz in (-1, 1)
        ],
        BOX_SZ[2],
    )
    o_floor = o + contact(W, half)
    o = ''
    # highlight along the top-left bevel is carried by the bevel's own gradient; on the top face: parts
    cid = gid()
    GDEFS.append(
        f'<clipPath id="{cid}"><path d="{pd(top_outline(W, half))}"/></clipPath>'
    )
    base = place((STICK_AT[0], STICK_AT[1], 0), BOX_C, BOX_YAW, ztop)
    tip = v_add(base, v_mul(STICK_DIR, SHAFT_LEN))
    ball = v_add(base, v_mul(STICK_DIR, SHAFT_LEN + BALL_R * 0.55))
    # parts standing on the top face
    parts = []
    for loc, R, hgt, top, side in (
        ((10.0, -6.0), 5.6, 3.0, "#f0434f", "#b3121f"),
        ((23.0, 7.0), 5.6, 3.0, "#ffb84a", "#c47a06"),
        ((-8.0, -14.0), 0, 0, "", ""),
    ):
        if R:
            parts.append(
                (place((loc[0], loc[1], 0), BOX_C, BOX_YAW, ztop), R, hgt, top, side)
            )
    cl = f'clip-path="url(#{cid})"'
    sh_top = "".join(
        shadow(
            ring(v_add(c, (0, 0, hgt)), R, EX, EY, 14) + ring(c, R, EX, EY, 14),
            hgt,
            ztop,
            cl,
        )
        for c, R, hgt, _, _ in parts
    )
    collar_c = base
    sh_top += shadow(ring(v_add(collar_c, (0, 0, WASHER_H + BOOT_H)), BOOT_R0, EX, EY, 16) + ring(collar_c, WASHER_R, EX, EY, 16), WASHER_H + BOOT_H, ztop, cl)

    # the stick and ball shadow on the box's top face, clipped to it, then on the felt
    def stick_shadow(z0, clip):
        """One shadow for the whole stick: a chain of rings from foot to ball, each blurred by its height above the plane it falls on."""
        pa, pb_ = _perp(LIGHT)
        axis = [(v_add(base, v_mul(STICK_DIR, t)), SHAFT_R) for t in range(0, int(SHAFT_LEN) + 1, 5)] + [(ball, BALL_R)]
        rings = [([P(cast(p, z0)) for p in ring(c, R, pa, pb_, 18)], c[2] - z0) for c, R in axis]
        o2 = ""
        for (r0, h0), (r1, h1) in zip(rings, rings[1:]):
            h = (h0 + h1) / 2
            o2 += f'<path d="{pd(hull(r0 + r1))}" fill="#02110a" opacity=".42" filter="url(#{blur(0.3 + 0.03 * h)})"/>'
        return f"<g {clip}>{o2}</g>"

    o = o_floor + stick_shadow(0.0, "") + body + o
    o += sh_top + stick_shadow(ztop, cl)
    for c, R, hgt, top, side in parts:
        o += cylinder(c, R, hgt, top, side)
    # a flat rubber washer, then the boot cone the stick comes out of
    o += cylinder(collar_c, WASHER_R, WASHER_H, "#2e2e38", "#5a5a68")
    bz = v_add(collar_c, (0, 0, WASHER_H))
    bot, tp = ring(bz, BOOT_R0, EX, EY, 30), ring(v_add(bz, (0, 0, BOOT_H)), BOOT_R1, EX, EY, 30)
    bsp = [P(p) for p in bot + tp]; bxs = [p[0] for p in bsp]
    gbt = lingrad((min(bxs), 0), (max(bxs), 0), shade("#4a4a58", .95), shade("#4a4a58", .45))
    o += poly(hull(bsp), f"url(#{gbt})") + poly([P(p) for p in tp], "#0b0b0e")
    # shaft: one chrome cylinder along the stick's axis, from the boot's mouth to the ball's centre
    rim = v_add(base, v_mul(STICK_DIR, (WASHER_H + BOOT_H) / STICK_DIR[2]))
    sp = [P(p) for p in ring(rim, SHAFT_R, EX, EY, 24) + ring(ball, SHAFT_R, EX, EY, 24)]
    xs = [p[0] for p in sp]
    g = gid()
    GDEFS.append(f'<linearGradient id="{g}" gradientUnits="userSpaceOnUse" x1="{min(xs):.2f}" y1="0" x2="{max(xs):.2f}" y2="0"><stop offset="0" stop-color="#6c6c7a"/><stop offset=".2" stop-color="#d4d4de"/><stop offset=".34" stop-color="#ffffff"/><stop offset=".5" stop-color="#bcbcc9"/><stop offset=".8" stop-color="#7a7a88"/><stop offset="1" stop-color="#4a4a58"/></linearGradient>')
    o += poly(hull(sp), f"url(#{g})")
    # ball: a sphere, lit from the one light; highlight on the half vector
    pc = P(ball)
    rb = S * BALL_R / depth(ball)
    Vv = v_norm(v_sub(CAM, ball))
    Hh = v_norm(v_add(LIGHT, Vv))
    lr, lu = v_dot(LIGHT, RIGHT), v_dot(LIGHT, UP)
    hr, hu = v_dot(Hh, RIGHT), v_dot(Hh, UP)
    gi = gid()
    GDEFS.append(
        f'<radialGradient id="{gi}" cx=".5" cy=".5" r=".62" fx="{.5+.30*lr:.3f}" fy="{.5-.30*lu:.3f}"><stop offset="0" stop-color="#ffb26b"/><stop offset=".38" stop-color="#f97316"/><stop offset=".85" stop-color="#b8400d"/><stop offset="1" stop-color="#7d2a0a"/></radialGradient>'
    )
    o += f'<circle cx="{f2(pc[0])}" cy="{f2(pc[1])}" r="{f2(rb)}" fill="url(#{gi})"/>'
    # bounce of the green felt into the underside, then the specular
    gb = gid()
    GDEFS.append(
        f'<radialGradient id="{gb}" cx=".5" cy=".5" r=".5"><stop offset=".72" stop-color="#2f7a52" stop-opacity="0"/><stop offset="1" stop-color="#2f7a52" stop-opacity=".30"/></radialGradient>'
    )
    o += f'<clipPath id="{gb}c"><circle cx="{f2(pc[0])}" cy="{f2(pc[1])}" r="{f2(rb)}"/></clipPath>'
    GDEFS.append(
        f'<radialGradient id="{gb}u" cx="{.5-.45*hr:.3f}" cy="{.5+.45*hu:.3f}" r=".7"><stop offset=".6" stop-color="#2f7a52" stop-opacity="0"/><stop offset="1" stop-color="#2f7a52" stop-opacity=".28"/></radialGradient>'
    )
    o += f'<circle cx="{f2(pc[0])}" cy="{f2(pc[1])}" r="{f2(rb)}" fill="url(#{gb}u)"/>'
    sx_, sy_ = pc[0] + rb * hr, pc[1] - rb * hu
    o += f'<ellipse cx="{f2(sx_)}" cy="{f2(sy_)}" rx="{f2(rb*.2)}" ry="{f2(rb*.13)}" fill="#fff" opacity=".78" transform="rotate(-28 {f2(sx_)} {f2(sy_)})"/>'
    return o


def _perp(n):
    a = v_norm(v_cross(n, EZ if abs(n[2]) < 0.9 else EX))
    return a, v_norm(v_cross(n, a))


def heart():
    return ""  # the heart is now drawn on the card, in the card's own plane


CONTROLLER = joystick()  # joystick: box, buttons, stick, ball, and their shadows
art = card() + die() + CONTROLLER
save(
    "zimigames.svg",
    icon(
        "g",
        '<radialGradient id="ga" cx=".5" cy=".52" r=".75"><stop offset="0" stop-color="#23895a"/><stop offset=".6" stop-color="#0f4a30"/><stop offset="1" stop-color="#06261a"/></radialGradient>'
        + "".join(GDEFS),
        f'<rect width="100" height="100" fill="url(#ga)"/>{art}',
    ),
)

# The tab icon: felt with the pebble alone, large and centred. The full tile's die, card and stick are mush at 16 px.
_fd, _fb = tab('f')
save('favicon.svg', f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><clipPath id="fc"><rect width="100" height="100" rx="22.4"/></clipPath>'
     '<radialGradient id="fa" cx=".5" cy=".52" r=".75"><stop offset="0" stop-color="#23895a"/><stop offset=".6" stop-color="#0f4a30"/><stop offset="1" stop-color="#06261a"/></radialGradient>'
     f'{_fd}</defs><g clip-path="url(#fc)"><rect width="100" height="100" fill="url(#fa)"/>'
     f'<svg x="9" y="{50 - 82 * BOX_H / BOX_W / 2:.2f}" width="82" height="{82 * BOX_H / BOX_W:.2f}" viewBox="{BOX}" overflow="visible">{_fb}</svg></g></svg>')

# ---- Almanac: altitude through one real day, San Francisco
LA, LO = 37.77, -122.42
PDT = dt.timezone(dt.timedelta(hours=-7)); PST = dt.timezone(dt.timedelta(hours=-8))
DAY = dt.date(*map(int, os.environ.get('ALM_DAY', '2026-03-23').split('-')))       # a waxing crescent high in the evening sky, near the equinox
H, K = 60, .5                    # horizon y; units per degree of altitude
H0, H1 = 4, 24                   # the hours the icon spans, local clock
X = lambda h: (h - H0) * 100 / (H1 - H0)
Y = lambda alt: H - alt * K
def at(day, h, tz):
    return dt.datetime(day.year, day.month, day.day, tzinfo=tz) + dt.timedelta(hours=h)
def curve(fn, day, tz, step=.25):
    return [(X(h), Y(fn(at(day, h, tz), LA, LO)[0])) for h in [i * step for i in range(int(24 / step) + 1)]]
def d(pts): return 'M' + 'L'.join(f'{x:.2f} {y:.2f}' for x, y in pts)
def find_h(day, tz, alt, lo=12, hi=23):
    """The afternoon clock time the Sun stands at `alt`, by bisection."""
    for _ in range(40):
        m = (lo + hi) / 2
        if astro.sun(at(day, m, tz), LA, LO)[0] > alt: lo = m
        else: hi = m
    return m
NOW = find_h(DAY, PDT, 6) if os.environ.get('ALM_WHEN') != 'morning' else find_h(DAY, PDT, 6, lo=12, hi=4)        # the Sun six degrees up: golden hour
t = at(DAY, NOW, PDT)
s_alt, s_az = astro.sun(t, LA, LO)[:2]
m_alt, m_az, _, _, m_lit, m_age = astro.moon(t, LA, LO)

def bright_limb_angle():
    """Direction from the Moon to the Sun on the sky, in screen degrees (0 = right, 90 = up)."""
    def vec(alt, az):
        a, z = math.radians(alt), math.radians(az)
        return (math.cos(a) * math.sin(z), math.cos(a) * math.cos(z), math.sin(a))   # east, north, up
    m, s = vec(m_alt, m_az), vec(s_alt, s_az)
    up = (0, 0, 1)
    dot = lambda a, b: sum(i * j for i, j in zip(a, b))
    sub = lambda a, b: tuple(i - j for i, j in zip(a, b))
    mul = lambda a, k: tuple(i * k for i in a)
    cross = lambda a, b: (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
    tsun = sub(s, mul(m, dot(s, m)))                  # Sun direction in the Moon's tangent plane
    tup = sub(up, mul(m, dot(up, m)))                 # local up there
    right = cross(m, tup)                             # facing the Moon, to the right (E,N,U is right-handed)
    return math.degrees(math.atan2(dot(tsun, tup), dot(tsun, right)))

def moon_svg(cx, cy, r, lit, ang):
    """Lit fraction `lit`, bright limb toward screen angle `ang`."""
    k = 1 - 2 * lit                                    # terminator ellipse: +1 new, -1 full
    rx = abs(k) * r
    sweep = 0 if k > 0 else 1                          # crescent: terminator bows toward the lit limb
    p = f'M0 {-r}A{r} {r} 0 0 1 0 {r}A{rx:.3f} {r} 0 0 {sweep} 0 {-r}Z'   # lit on the right (+x)
    return (f'<g transform="translate({cx:.2f} {cy:.2f}) rotate({-ang:.2f})"><circle r="{r*2.4}" fill="url(#amg)"/>'
            f'<circle r="{r}" fill="#26315f"/><path d="{p}" fill="#fff6dc"/></g>')

CREAM, AMBER = '#ffe9c2', '#fbbf24'
today = curve(astro.sun, DAY, PDT)
summer = curve(astro.sun, dt.date(DAY.year, 6, 21), PDT)
winter = curve(astro.sun, dt.date(DAY.year, 12, 21), PST)
mooncurve = curve(astro.moon, DAY, PDT)
sx, sy = X(NOW), Y(s_alt); mx, my = X(NOW), Y(m_alt)

defs = (f'<linearGradient id="aa" x1="0" y1="0" x2="0" y2="{H}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0f1b4d"/><stop offset=".45" stop-color="#2a3f8f"/><stop offset=".78" stop-color="#c0607a"/><stop offset="1" stop-color="#f6a54a"/></linearGradient>'
        f'<linearGradient id="ak" x1="0" y1="{H}" x2="0" y2="100" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1d2a5c"/><stop offset=".35" stop-color="#101a40"/><stop offset="1" stop-color="#050a1f"/></linearGradient>'
        '<radialGradient id="as"><stop offset="0" stop-color="#fff3b0"/><stop offset=".45" stop-color="#fbbf24" stop-opacity=".8"/><stop offset="1" stop-color="#f59e0b" stop-opacity="0"/></radialGradient>'
        '<radialGradient id="amg"><stop offset=".4" stop-color="#fff6dc" stop-opacity=".22"/><stop offset="1" stop-color="#fff6dc" stop-opacity="0"/></radialGradient>'
        f'<linearGradient id="af" x1="0" y1="{H}" x2="0" y2="100" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{AMBER}" stop-opacity=".32"/><stop offset="1" stop-color="{AMBER}" stop-opacity="0"/></linearGradient>'
        f'<radialGradient id="ar" cx=".5" cy="0" r="1"><stop offset="0" stop-color="#ffcf55" stop-opacity=".95"/><stop offset="1" stop-color="#f59e0b" stop-opacity="0"/></radialGradient>'
        f'<radialGradient id="ag"><stop offset="0" stop-color="#fff1c4"/><stop offset=".6" stop-color="#ffd27a" stop-opacity=".9"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient>'
        f'<clipPath id="below"><rect y="{H}" width="100" height="{100-H}"/></clipPath><clipPath id="above"><rect width="100" height="{H}"/></clipPath>')

body = f'<rect width="100" height="100" fill="url(#aa)"/><rect y="{H}" width="100" height="{100-H}" fill="url(#ak)"/>'
# night: the Sun's path under the ground, filled down from the horizon
body += f'<path d="{d(today)}L100 {H}L0 {H}Z" fill="url(#af)" clip-path="url(#below)"/>'
for pts, w, o in ((summer, 1.1, .4), (winter, 1.1, .4)):
    body += f'<path d="{d(pts)}" fill="none" stroke="{CREAM}" stroke-width="{w}" stroke-linecap="round" opacity="{o}"/>'
body += f'<path d="{d(mooncurve)}" fill="none" stroke="#fff6dc" stroke-width=".9" stroke-dasharray="1.4 1.6" opacity=".55" clip-path="url(#above)"/>'
body += f'<path d="{d(today)}" fill="none" stroke="{CREAM}" stroke-width="2" stroke-linejoin="round" clip-path="url(#above)"/>'
body += f'<path d="{d(today)}" fill="none" stroke="{AMBER}" stroke-width="1.6" stroke-linejoin="round" clip-path="url(#below)"/>'
# the sea: swells that crowd together towards the horizon, and the Sun's glitter path on them
for i in range(9):
    y = H + 3 + 34 * (i / 8) ** 1.7
    a = .5 + 1.4 * (i / 8)                                  # nearer swells are taller
    w = 9 + 12 * (i / 8)                                    # and longer
    ph = i * 2.3
    pts = [(x, y + a * math.sin(2 * math.pi * x / w + ph)) for x in [j * 2 for j in range(51)]]
    body += f'<path d="{d(pts)}" fill="none" stroke="#9fb7ff" stroke-width="{.35 + .35 * i / 8:.2f}" opacity="{.14 + .1 * i / 8:.2f}"/>'
# the Sun's glitter: glints drawn where Cox and Munk's wave slopes send this Sun into the eye,
# computed for the Sun at the size it is drawn (glitter.py); thin streaks near the horizon,
# where the sea is seen edge on, rounder further down
import glitter
SUN_R = 5.6
gl, grid, top = glitter.glints_ext(s_alt, SUN_R / K, n=80)
# the brightest of it, a band right at the horizon: its half-maximum extent from the same field
band = [(dep, side) for dep, side, r in grid if r > top / 2]
bw = max(abs(p) for _, p in band) * K; bd = max(d for d, _ in band) * K
body += f'<ellipse cx="{sx:.2f}" cy="{H + bd / 2 + .15:.2f}" rx="{bw:.2f}" ry="{bd / 2 + .35:.2f}" fill="url(#ag)"/>'
for dep, side, r in sorted(gl, key=lambda g: g[2]):
    gw = .6 + 2.2 * r ** .5
    gh = min(.9, max(.16, gw * math.sin(math.radians(dep)) * 1.6))
    body += f'<ellipse cx="{sx + side * K:.2f}" cy="{H + dep * K:.2f}" rx="{gw / 2:.2f}" ry="{gh / 2:.2f}" fill="#ffd98a" opacity="{.3 + .65 * r ** .5:.2f}"/>'
# the hour ruler: the horizon read as a clock
for i in range(H0, H1 + 1):
    major = i % 6 == 0
    body += f'<rect x="{X(i)-.4:.2f}" y="{H+.6}" width=".8" height="{4.4 if major else 2.2}" fill="{CREAM}" opacity="{.85 if major else .45}"/>'
# now: one line through the Moon and the Sun, down to the clock
body += f'<path d="M{sx:.2f} {my+5:.2f}V{H}" stroke="{CREAM}" stroke-width=".7" stroke-dasharray="1.2 1.3" opacity=".75"/>'
body += f'<circle cx="{sx:.2f}" cy="{sy:.2f}" r="12" fill="url(#as)"/><circle cx="{sx:.2f}" cy="{sy:.2f}" r="5.6" fill="#ffd45e"/>'
body += moon_svg(mx, my, 5.2, m_lit, bright_limb_angle())
body += f'<path d="M0 {H}H100" stroke="{CREAM}" stroke-width="1.1" opacity=".9"/>'
save(os.environ.get('ALM_OUT', 'almanac.svg'), icon('a', defs, body))
print(f'now {NOW:.2f}h PDT  sun alt {s_alt:.1f} az {s_az:.0f}  moon alt {m_alt:.1f} az {m_az:.0f} lit {m_lit:.2f} age {m_age:.2f} limb {bright_limb_angle():.0f}deg')


# ---- Into the repo
GAMES = os.path.join(REPO, 'zimi', 'builtin', 'games')
def mark_data_js():
    """The numbers cards.js draws the mark and the card Z's from, as a JS block: the pebble mark's own defs and
    body (the same tab() the icons use), the Z centred on 0,0 for the cards, its height and gradient stops."""
    z_ctr = zpath(ZB, -ZB/2, -ZB/2)
    ys = [float(t.split()[1]) for t in z_ctr[1:-1].replace('L', ' L').split('L') if t.strip()]
    stops = ','.join(f"['{o}','{c}']" for o, c in re.findall(r'offset="([^"]+)" stop-color="([^"]+)"', GRAD))
    defs, body = tab('zm')
    return ('// zimi-mark:begin -- generated by scripts/icons/build.py from icon.png\'s Z and the pebble; do not edit by hand\n'
            f"  var ZMARK = {{ box: '{BOX}', defs: '{defs}', body: '{body}', zc: '{z_ctr}', zh: {max(ys) - min(ys):.3f}, stops: [{stops}] }};\n"
            '  // zimi-mark:end')
def apply_to_repo():
    cj = os.path.join(GAMES, 'cards.js'); src = open(cj).read()
    src = re.sub(r'// zimi-mark:begin.*?// zimi-mark:end', lambda m: mark_data_js(), src, flags=re.S)
    open(cj, 'w').write(src)
    for n, to in (('mark.svg', 'mark.svg'), ('zimigames.svg', 'icon.svg'), ('favicon.svg', 'favicon.svg')):       # the pebble, and the ZimiGames tile the shelf header shows
        open(os.path.join(GAMES, to), 'w').write(open(os.path.join(OUT, n)).read())
def rasterise(svg, png, px=96, big=768):
    """Chrome draws the svg on a transparent page at `big`; ImageMagick takes it down to `px` (RGBA)."""
    import subprocess
    chrome = os.environ.get('CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    tmp = tempfile.mkdtemp(); html = os.path.join(tmp, 'p.html'); shot = os.path.join(tmp, 's.png')
    open(html, 'w').write(f'<html><body style="margin:0;background:transparent"><img src="file://{svg}" width={big} height={big}></body></html>')
    subprocess.run([chrome, f'--user-data-dir={tmp}/prof', '--headless', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
                    f'--screenshot={shot}', f'--window-size={big},{big}', f'file://{html}'], check=True, capture_output=True, timeout=120)
    subprocess.run(['magick', shot, '-filter', 'Lanczos', '-resize', f'{px}x{px}', '-depth', '8', f'PNG32:{png}'], check=True)
def drift():
    """What in the repo no longer matches the generator (empty when clean)."""
    out = []
    for n, to in (('mark.svg', 'mark.svg'), ('zimigames.svg', 'icon.svg'), ('favicon.svg', 'favicon.svg')):
        if open(os.path.join(GAMES, to)).read() != open(os.path.join(OUT, n)).read(): out.append('games/' + to)
    cj = open(os.path.join(GAMES, 'cards.js')).read()
    if mark_data_js() not in cj: out.append('the mark block in games/cards.js')
    return out
def review():
    """One page of both icons at the sizes they are judged at."""
    import base64
    uri = lambda n: 'data:image/svg+xml;base64,' + base64.b64encode(open(os.path.join(OUT, n), 'rb').read()).decode()
    row = lambda n: ''.join(f'<figure><img src="{uri(n)}" width="{p}" height="{p}"><figcaption>{p}</figcaption></figure>' for p in (1024, 96, 48, 32))
    html = ('<!doctype html><meta charset="utf-8"><title>Zimi icons</title><style>body{margin:0;padding:16px;background:#f6f5f3;font:13px system-ui}'
            'section{display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap;margin-bottom:24px}img{max-width:100%;height:auto}figure{margin:0;text-align:center}</style>'
            f'<section>{row("zimigames.svg")}</section><section>{row("almanac.svg")}</section><section><img src="{uri("mark.svg")}" width="220"></section>')
    open(os.path.join(OUT, 'board.html'), 'w').write(html)
if '--apply' in sys.argv: apply_to_repo()
if '--check' in sys.argv:
    d = drift(); print('drifted: ' + ', '.join(d) if d else 'icons: clean'); sys.exit(1 if d else 0)
if '--review' in sys.argv: review(); print(os.path.join(OUT, 'board.html'))
if '--icons' in sys.argv:
    rasterise(os.path.join(OUT, 'zimigames.svg'), os.path.join(GAMES, 'icon.png'))
    rasterise(os.path.join(OUT, 'almanac.svg'), os.path.join(REPO, 'zimi', 'builtin', 'almanac', 'icon.png'))
