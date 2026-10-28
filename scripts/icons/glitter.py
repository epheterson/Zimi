"""The Sun's glitter on a wind-ruffled sea, from Cox and Munk (1954).

A wave facet sends the Sun into the eye when its normal bisects the view ray
and the Sun; facet slopes are Gaussian with variance sigma^2 = 0.003 + 0.00512 W
(W the wind in m/s). The glitter's radiance is proportional to the slope density
over 4 cos^4(tilt) cos(view zenith): bright and long under a low Sun, thin at the sides."""
import math, random
def vec(alt, az):
    a, z = math.radians(alt), math.radians(az)
    return (math.cos(a) * math.sin(z), math.cos(a) * math.cos(z), math.sin(a))
def radiance(dep, dphi, sun_alt, wind=5.0):
    """Relative glitter radiance looking `dep` degrees below the horizon, `dphi` degrees to the side of the Sun."""
    s2 = .003 + .00512 * wind
    v = vec(-dep, dphi)                      # view ray, Sun at azimuth 0
    s = vec(sun_alt, 0)
    n = tuple(si - vi for si, vi in zip(s, v)); L = math.sqrt(sum(c * c for c in n)); n = tuple(c / L for c in n)
    cb = n[2]
    if cb <= 0: return 0.
    tan2 = (1 - cb * cb) / (cb * cb)
    p = math.exp(-tan2 / s2) / (math.pi * s2)
    cos_view = math.sin(math.radians(dep))   # cos of the view ray's zenith angle
    return p / (4 * cb ** 4 * max(cos_view, 1e-3))
def field(sun_alt, wind=5.0, dmax=60, pmax=30, step=.25):
    pts = []
    d = step
    while d <= dmax:
        p = -pmax
        while p <= pmax:
            pts.append((d, p, radiance(d, p, sun_alt, wind))); p += step
        d += step
    return pts
def glints(sun_alt, n=70, seed=7, wind=5.0):
    """n glints drawn where the sea actually sparkles (rejection sampling on the radiance)."""
    f = field(sun_alt, wind, step=.5)
    top = max(r for _, _, r in f)
    rnd = random.Random(seed); out = []
    while len(out) < n:
        d = rnd.uniform(.15, 40); p = rnd.uniform(-20, 20)
        r = radiance(d, p, sun_alt, wind) / top
        if rnd.random() < r ** .6: out.append((d, p, r))
    return out, f, top
if __name__ == '__main__':
    g, f, top = glints(6.0)
    half = [(d, p) for d, p, r in f if r > top / 2]
    tenth = [(d, p) for d, p, r in f if r > top / 10]
    for name, s in (('half-max', half), ('tenth-max', tenth)):
        print(name, 'depression %.1f..%.1f deg, side %.1f..%.1f deg' % (min(x[0] for x in s), max(x[0] for x in s), min(x[1] for x in s), max(x[1] for x in s)))
    pk = max(f, key=lambda x: x[2]); print('peak at depression %.2f side %.2f' % pk[:2])
    for dd in (0.5, 2, 6, 12, 20, 30): print(dd, 'width at tenth:', max([abs(p) for d, p, r in f if abs(d-dd) < .3 and r > top/10] or [0]))

def disc(sun_alt, radius, rings=3, per=8):
    """Points over the Sun's disc as drawn (alt, side offset in degrees)."""
    pts = [(sun_alt, 0.)]
    for i in range(1, rings + 1):
        r = radius * i / rings
        for k in range(per * i):
            a = 2 * math.pi * k / (per * i)
            pts.append((sun_alt + r * math.sin(a), r * math.cos(a)))
    return pts
def radiance_ext(dep, dphi, sun_alt, radius, wind=5.0, pts=None):
    """The same glitter for a Sun of the drawn angular radius: the mean over its disc
    (the part above the horizon; the sea cannot reflect what is below it)."""
    pts = pts or disc(sun_alt, radius)
    up = [(a, o) for a, o in pts if a > 0]
    return sum(radiance(dep, dphi - o, a, wind) for a, o in up) / len(pts)
def glints_ext(sun_alt, radius, n=90, seed=7, wind=5.0, dmax=40, pmax=26):
    pts = disc(sun_alt, radius)
    grid = [(d, p, radiance_ext(d, p, sun_alt, radius, wind, pts)) for d in [x * .5 + .25 for x in range(int(dmax * 2))] for p in [x * .5 - pmax for x in range(int(pmax * 4) + 1)]]
    top = max(r for *_, r in grid)
    rnd = random.Random(seed); out = []
    while len(out) < n:
        d = rnd.uniform(.12, dmax); p = rnd.uniform(-pmax, pmax)
        r = radiance_ext(d, p, sun_alt, radius, wind, pts) / top
        if rnd.random() < r ** .7: out.append((d, p, r))
    return out, grid, top
