"""The planets' places for the Almanac: VSOP87D (Bretagnon and Francou 1988, IMCCE), heliocentric longitude, latitude and radius
in the ecliptic and equinox of date, truncated for the view and written to zimi/static/almanac-vsop87.js.

    python3 scripts/build_vsop87.py --src DIR     # DIR holds VSOP87D.ear, .mer ... .nep, from https://ftp.imcce.fr/pub/ephem/planets/vsop87/
                                                  # (the authors' institute; byte for byte CDS VI/81's: SHA256 below)

Each series keeps its largest terms, the smallest kept set for which the truncated planet stays within TARGET_ARCSEC of the full
series (in longitude, latitude, and radius as an angle, r times the arc) at every date of a grid over YEARS. The Earth's series,
truncated the same way, is written into almanac-ephem.js itself (AE_VSOP_L, _B, _R: the Sun's place, which the page's other modules
and the tests read without this file).
"""

import argparse
import hashlib
import math
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "zimi", "static", "almanac-vsop87.js")
EPHEM = os.path.join(ROOT, "zimi", "static", "almanac-ephem.js")
PLANETS = [("Mercury", "mer"), ("Venus", "ven"), ("Mars", "mar"), ("Jupiter", "jup"), ("Saturn", "sat"), ("Uranus", "ura"), ("Neptune", "nep")]
TARGET_ARCSEC = 1.0
YEARS = (1500, 2500)   # the grid the truncation is held to (the Nautical Almanac tables' span); outside it the error grows slowly
ARCSEC = math.pi / 180 / 3600
SHA256 = {
    "ear": "8b160c859136d467f2be7fc29efa8a9652e95516dfbde00e4c739d7ddc90ca91",
    "mer": "f468481b5a05080a943ad4746ff7ea7e0ff6652b71a46d83c9c636cb69485e34",
    "ven": "cb2f3a738289ed45f69fec1845e480baf4b32d481eccc21b8629a2d0d10e8261",
    "mar": "b1184df9553d85ffcf904c16bd437ab668804fa98859f27fe2e7bf6cfa6bc07e",
    "jup": "3f3dfbc7d117ecad2b2dadf2fc626b260a3cd5efa98e7d4c6b26cd682fc48090",
    "sat": "2e49e19396f24c17298f0b667e7763ee5c28b60d549c89d72a17dfd5f8d46b05",
    "ura": "80eb3a778d53f450066d9b13f17e15b979e253437d22f33ec5a4604cdb2872a7",
    "nep": "3ff65a5cabc04c411f975888f77268b89e336ece0b75d198a3935090fdde3ae6",
}


def parse(path):
    """{var (0 L, 1 B, 2 R): [power 0.., each an array of (A, B, C)]}"""
    with open(path, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    if digest != SHA256[path.rsplit(".", 1)[1]]:
        raise SystemExit("%s: sha256 %s is not the pinned one" % (path, digest))
    out = {0: [], 1: [], 2: []}
    var = power = None
    with open(path) as fh:
        for line in fh:
            if "VSOP87" in line:
                var = int(line.split("VARIABLE")[1].split()[0]) - 1
                power = int(line.split("*T**")[1].split()[0])
                while len(out[var]) <= power:
                    out[var].append([])
                continue
            f = line.split()
            out[var][power].append((float(f[-3]), float(f[-2]), float(f[-1])))
    return {v: [np.array(s, float).reshape(-1, 3) for s in out[v]] for v in out}


def evaluate(series, tau):
    """series [power][(A, B, C)] at the millennia tau (array) -> values."""
    tot = np.zeros_like(tau)
    for p, s in enumerate(series):
        if len(s):
            tot += (s[:, 0][:, None] * np.cos(s[:, 1][:, None] + s[:, 2][:, None] * tau[None, :])).sum(0) * tau ** p
    return tot


def keep(series, thr, tau_max):
    """The terms whose amplitude, times tau_max to their power, reach thr."""
    return [s[s[:, 0] * tau_max ** p >= thr] if len(s) else s for p, s in enumerate(series)]


def truncate(full, tau, scale):
    """The largest threshold (fewest terms) that holds the series within TARGET_ARCSEC (scale: radians per unit of the variable)."""
    ref = evaluate(full, tau)
    tau_max = float(np.max(np.abs(tau)))
    lo, hi = 1e-14, 1.0
    for _ in range(60):
        mid = math.sqrt(lo * hi)
        err = np.max(np.abs(evaluate(keep(full, mid, tau_max), tau) - ref)) * scale
        if err <= TARGET_ARCSEC * ARCSEC:
            lo = mid
        else:
            hi = mid
    kept = keep(full, lo, tau_max)
    return kept, float(np.max(np.abs(evaluate(kept, tau) - ref)) * scale / ARCSEC)


def fmt(x, places):
    s = ("%." + str(places) + "f") % x
    s = s.rstrip("0").rstrip(".") if "." in s else s
    return s.replace("-0.", "-.").replace("0.", ".", 1) if s.startswith(("0.", "-0.")) else s


def series_js(kept):
    return "[\n" + ",\n".join("  [" + ",".join("[%s,%s,%s]" % (fmt(t[0], 11), fmt(t[1], 9), fmt(t[2], 7)) for t in s) + "]" for s in kept) + "\n]"


def write_earth(src, tau):
    """The Earth's L, B, R into almanac-ephem.js, between its AE_VSOP_L declaration and the end of AE_VSOP_R."""
    full = parse(os.path.join(src, "VSOP87D.ear"))
    with open(EPHEM) as fh:
        js = fh.read()
    start = js.index("var AE_VSOP_L = [")
    end = js.index("];", js.index("var AE_VSOP_R = [")) + 2
    parts, notes = [], []
    for v, scale in ((0, 1.0), (1, 1.0), (2, 1.0)):
        kept, err = truncate(full[v], tau, scale)
        parts.append("var AE_VSOP_%s = %s;" % ("LBR"[v], series_js(kept)))
        notes.append("Earth    %s %4d terms, max %.2f arcsec" % ("LBR"[v], sum(len(s) for s in kept), err))
    with open(EPHEM, "w") as fh:
        fh.write(js[:start] + "\n".join(parts) + js[end:])
    return notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    a = ap.parse_args()
    jd = np.arange((YEARS[0] - 2000) * 365.25, (YEARS[1] - 2000) * 365.25, 3.7)   # days from J2000
    tau = jd / 365250.0
    blocks, report = [], write_earth(a.src, tau)
    for name, ext in PLANETS:
        full = parse(os.path.join(a.src, "VSOP87D." + ext))
        r_mean = float(np.mean(evaluate(full[2], tau)))
        out = []
        for v, scale in ((0, 1.0), (1, 1.0), (2, 1.0 / r_mean)):
            kept, err = truncate(full[v], tau, scale)
            n = sum(len(s) for s in kept)
            report.append("%-8s %s %4d of %5d terms, max %.2f arcsec" % (name, "LBR"[v], n, sum(len(s) for s in full[v]), err))
            # A to 1e-11 (an amplitude's own rounding is under 0.002"), the phase to 1e-9 rad, the frequency to 1e-7 rad per millennium
            out.append("[" + ",".join("[" + ",".join("[%s,%s,%s]" % (fmt(t[0], 11), fmt(t[1], 9), fmt(t[2], 7)) for t in s) + "]" for s in kept) + "]")
        blocks.append("  %s: [%s]" % (name, ",\n    ".join(out)))
    with open(OUT, "w") as fh:
        fh.write(
            "// The planets Mercury to Neptune from VSOP87D (Bretagnon and Francou 1988, A&A 202, 309; IMCCE), heliocentric longitude, latitude\n"
            "// (radians) and radius (AU) in the ecliptic and equinox of date, each series [power of tau][term], a term [A, B, C] (almanac-ephem.js _aeVsopSum):\n"
            "// sum of A cos(B + C tau) times tau^power, tau in Julian millennia (TT) from J2000. Truncated by scripts/build_vsop87.py to the fewest\n"
            "// terms within %g arcsecond of the full series over %d-%d (the Nautical Almanac pages' span, almanac-reference.js, read them too). Loaded with the ephemeris (almanac-ephem.js _ephBodyJ2000), never on a\n"
            "// page's first paint. Generated: do not edit.\n"
            "var EPH_VSOP87D = {\n%s\n};\n" % (TARGET_ARCSEC, YEARS[0], YEARS[1], ",\n".join(blocks))
        )
    print("\n".join(report))
    print("wrote %s, %d bytes" % (OUT, os.path.getsize(OUT)))


if __name__ == "__main__":
    main()
