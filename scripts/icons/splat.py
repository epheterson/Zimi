"""Playful shapes for the black behind the Z: each a smooth closed curve that
covers the Z with room to spare and bleeds off the icon's top-left corner."""
import math
C = 17.5          # the Z's centre in the tab's 35-unit box

def smoothstep(a, b, x):
    t = max(0., min(1., (x - a) / (b - a))); return t * t * (3 - 2 * t)

def corner_weight(th):
    """1 where the edge points up or left (off the icon), fading to 0 by 40 degrees past."""
    d = math.degrees(th)            # screen angle, y down: up-left is -180..-90
    if -180 <= d <= -90: return 1.
    if d > -90: return 1 - smoothstep(-90, -50, d)
    return 1.

def catmull(pts):
    """A closed Catmull-Rom spline through pts, as cubic Beziers."""
    n = len(pts); out = f'M{pts[0][0]:.2f} {pts[0][1]:.2f}'
    for i in range(n):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        out += f'C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}'
    return out + 'Z'

def radial(r_of, n=72, far=30):
    pts = []
    for i in range(n):
        th = -math.pi + 2 * math.pi * i / n
        w = corner_weight(th)
        r = r_of(th) * (1 - w) + far * w
        pts.append((C + r * math.cos(th), C + r * math.sin(th)))
    return catmull(pts)

def bump(th, at, amp, width):
    d = (th - math.radians(at) + math.pi) % (2 * math.pi) - math.pi
    return amp * math.exp(-(d / math.radians(width)) ** 2)

def splat():
    r = lambda th: (14.6 + .6 * math.sin(5 * th + .7) + bump(th, 10, 3.6, 9) + bump(th, 47, 5.2, 8)
                    + bump(th, 90, 3.4, 9) + bump(th, -32, 2.6, 10) - bump(th, 29, 1.4, 8) - bump(th, 69, 1.3, 8))
    drops = [(47, 25.8, 2.1), (14, 23.6, 1.3)]
    return radial(r, 120) + ''.join(
        f'M{C + d*math.cos(math.radians(a)) + s:.2f} {C + d*math.sin(math.radians(a)):.2f}a{s} {s} 0 1 0 {-2*s} 0a{s} {s} 0 1 0 {2*s} 0Z' for a, d, s in drops)

def pebble():
    return radial(lambda th: 15.6 + 1.3 * math.sin(2 * th + 1.1) + .6 * math.sin(3 * th + .4), 48)

def bubbles():
    """Scalloped like a cloud or a stamp of soap bubbles."""
    return radial(lambda th: 14.6 + 1.6 * abs(math.sin(3.5 * (th + .3))) ** .7, 140)

def drips():
    """B's tab, with the paint still running off its bottom edge."""
    T, R = 35, 7.8
    d = f'M0 0H{T}V{T-R}A{R} {R} 0 0 1 {T-R} {T}'
    # drips hang from the bottom edge, right to left: (x, width, length)
    for x, w, L in ((22.5, 4.2, 6.5), (9.5, 5, 10.5)):
        h = w / 2
        d += (f'H{x + h + 1.6}C{x + h + .4} {T} {x + h} {T + .6} {x + h} {T + 1.8}'
              f'V{T + L - h}A{h} {h} 0 0 1 {x - h} {T + L - h}V{T + 1.8}C{x - h} {T + .6} {x - h - .4} {T} {x - h - 1.6} {T}')
    return d + 'H0Z'

SHAPES = {'splat': splat, 'drips': drips, 'pebble': pebble, 'bubbles': bubbles}
