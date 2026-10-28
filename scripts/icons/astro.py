"""Sun and Moon, low precision (Schlyter): good to about a tenth of a degree, plenty for an icon."""
import math, datetime as dt
R = math.radians; D = math.degrees
def rev(x): return x % 360
def dnum(t):  # days since 2000 Jan 0.0 UT
    return (t - dt.datetime(1999, 12, 31, 0, 0, tzinfo=dt.timezone.utc)).total_seconds() / 86400
def sun_ecl(d):
    w = 282.9404 + 4.70935e-5 * d; e = 0.016709 - 1.151e-9 * d; M = rev(356.0470 + 0.9856002585 * d)
    E = M + D(e * math.sin(R(M)) * (1 + e * math.cos(R(M))))
    xv = math.cos(R(E)) - e; yv = math.sqrt(1 - e * e) * math.sin(R(E))
    v = D(math.atan2(yv, xv)); r = math.hypot(xv, yv)
    return rev(v + w), 0.0, r, M, rev(w + M)
def moon_ecl(d):
    N = rev(125.1228 - 0.0529538083 * d); i = 5.1454; w = rev(318.0634 + 0.1643573223 * d)
    a = 60.2666; e = 0.054900; M = rev(115.3654 + 13.0649929509 * d)
    E = M + D(e * math.sin(R(M)) * (1 + e * math.cos(R(M))))
    for _ in range(5): E = E - (E - D(e * math.sin(R(E))) - M) / (1 - e * math.cos(R(E)))
    xv = a * (math.cos(R(E)) - e); yv = a * math.sqrt(1 - e * e) * math.sin(R(E))
    v = D(math.atan2(yv, xv)); r = math.hypot(xv, yv)
    xh = r * (math.cos(R(N)) * math.cos(R(v + w)) - math.sin(R(N)) * math.sin(R(v + w)) * math.cos(R(i)))
    yh = r * (math.sin(R(N)) * math.cos(R(v + w)) + math.cos(R(N)) * math.sin(R(v + w)) * math.cos(R(i)))
    zh = r * math.sin(R(v + w)) * math.sin(R(i))
    lon = D(math.atan2(yh, xh)); lat = D(math.atan2(zh, math.hypot(xh, yh)))
    _, _, _, Ms, Ls = sun_ecl(d); Lm = N + w + M; Dm = Lm - Ls; F = Lm - N
    lon += (-1.274 * math.sin(R(M - 2 * Dm)) + 0.658 * math.sin(R(2 * Dm)) - 0.186 * math.sin(R(Ms))
            - 0.059 * math.sin(R(2 * M - 2 * Dm)) - 0.057 * math.sin(R(M - 2 * Dm + Ms)) + 0.053 * math.sin(R(M + 2 * Dm))
            + 0.046 * math.sin(R(2 * Dm - Ms)) + 0.041 * math.sin(R(M - Ms)) - 0.035 * math.sin(R(Dm))
            - 0.031 * math.sin(R(M + Ms)) - 0.015 * math.sin(R(2 * F - 2 * Dm)) + 0.011 * math.sin(R(M - 4 * Dm)))
    lat += (-0.173 * math.sin(R(F - 2 * Dm)) - 0.055 * math.sin(R(M - F - 2 * Dm)) - 0.046 * math.sin(R(M + F - 2 * Dm))
            + 0.033 * math.sin(R(F + 2 * Dm)) + 0.017 * math.sin(R(2 * M + F)))
    r += -0.58 * math.cos(R(M - 2 * Dm)) - 0.46 * math.cos(R(2 * Dm))
    return rev(lon), lat, r
def eq(lon, lat, d):
    ecl = R(23.4393 - 3.563e-7 * d)
    x = math.cos(R(lon)) * math.cos(R(lat)); y = math.sin(R(lon)) * math.cos(R(lat)); z = math.sin(R(lat))
    ye = y * math.cos(ecl) - z * math.sin(ecl); ze = y * math.sin(ecl) + z * math.cos(ecl)
    return rev(D(math.atan2(ye, x))), D(math.atan2(ze, math.hypot(x, ye)))
def altaz(ra, dec, d, latd, lond):
    _, _, _, _, Ls = sun_ecl(d)
    ut = (d - math.floor(d)) * 24
    lst = rev(Ls + 180 + ut * 15 + lond)
    H = R(lst - ra)
    x = math.cos(H) * math.cos(R(dec)); y = math.sin(H) * math.cos(R(dec)); z = math.sin(R(dec))
    xh = x * math.sin(R(latd)) - z * math.cos(R(latd)); zh = x * math.cos(R(latd)) + z * math.sin(R(latd))
    az = rev(D(math.atan2(y, xh)) + 180); alt = D(math.asin(zh))
    return alt, az
def sun(t, la, lo):
    d = dnum(t); lon, lat, r, _, _ = sun_ecl(d); ra, dec = eq(lon, lat, d)
    return altaz(ra, dec, d, la, lo) + (ra, dec, lon)
def moon(t, la, lo):
    d = dnum(t); lon, lat, r = moon_ecl(d); ra, dec = eq(lon, lat, d)
    alt, az = altaz(ra, dec, d, la, lo)
    alt -= D(math.asin(1 / r)) * math.cos(R(alt))   # topocentric parallax
    slon = sun_ecl(d)[0]
    elong = D(math.acos(math.cos(R(lon - slon)) * math.cos(R(lat))))
    k = (1 - math.cos(R(elong))) / 2                   # illuminated fraction (geocentric approx)
    age = rev(lon - slon) / 360                        # 0 new, .5 full
    return alt, az, ra, dec, k, age
if __name__ == '__main__':
    PDT = dt.timezone(dt.timedelta(hours=-7)); PST = dt.timezone(dt.timedelta(hours=-8))
    la, lo = 37.77, -122.42
    for day in range(10, 31):
        t = dt.datetime(2026, 10 if day <= 31 else 11, day, 18, 0, tzinfo=PDT)
        print(t.date(), 'moon age %.2f lit %.2f' % moon(t, la, lo)[5:3:-1][::-1] if False else '', 'age %.3f lit %.2f alt %.1f az %.1f | sun alt %.1f az %.1f' % (moon(t,la,lo)[5], moon(t,la,lo)[4], moon(t,la,lo)[0], moon(t,la,lo)[1], sun(t,la,lo)[0], sun(t,la,lo)[1]))
