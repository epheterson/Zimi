"""Build the spacecraft the 3D view shows close up, each a small mesh in zimi/static/earth/.

    python scripts/build_craft_models.py [--only iss,voyager] [--src DIR]

Every model is from NASA 3D Resources (github.com/nasa/NASA-3D-Resources; its README: "These assets are free and
without copyright"), each page's credit line recorded in CRAFT below and in zimi/static/earth/SOURCES.txt. --src is a
folder holding the downloaded files under their own names (else they are fetched). Build-time needs: numpy, DracoPy
(the files are Draco-compressed), fast-simplification and Pillow (a textured part takes its texture's mean colour, so a
logo printed on a texture never reaches the stock model; the Almanac HD craft keep their textures,
scripts/build_craft_hd.py).

Every craft is "ZCR2" (scripts/craftmesh.py has the layout): its materials as a palette of up to 12 (colour, roughness,
metalness: gold foil, silver blanket, solar cell, aluminium, paint), each palette entry's part simplified on its own
share of the triangles so panels keep their edges, then given smooth normals with creases (a cylinder reads round, a
box stays a box), scaled to metres from one known size, with the direction that points (the high-gain antenna's
boresight, Parker's heat shield, Webb's sunshield) found from the geometry and stored, so the view turns that axis
toward the Earth or the Sun. The ISS has five classes by material, its main arrays turning about the truss (see _iss).
"""

import argparse
import os
import urllib.parse
import urllib.request

import numpy as np

import craftmesh as cm

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH = os.path.join(ROOT, "zimi", "static", "earth")
REPO = "https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Models/"
ISS_URL = (
    "https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/model/international-space-station-(iss)-(b)/"
    "International%20Space%20Station%20(ISS)%20(B).glb"
)

# key: (file in the repo's 3D Models folder, the model page's Source credit, triangles, how its size is known, what points).
#   size: ("part", material substring, metres) the named part's widest extent across its pointing axis is that many
#         metres (a dish's diameter); ("span", metres) the whole model's widest extent.
#   aim:  ("part", material substring) the part's flattest axis, away from the craft's middle (a dish, a shield);
#         ("long",) the model's longest axis, toward the wider end (Cassini: the antenna on top of its stack).
CRAFT = {
    "voyager": (
        "Voyager Probe (A)/Voyager Probe (A).glb",
        "NASA/Christopher R. Meaney",
        10000,
        ("part", "VoyagerDish", 3.66),
        ("part", "VoyagerDish"),
    ),
    "pioneer": (
        "Pioneer 10/Pioneer 10.glb",
        "NASA/JPL/Eyes on the Solar System",
        7000,
        ("part", "dish_AO", 2.74),
        ("part", "dish_AO"),
    ),
    "juno": (
        "Juno (B)/Juno (B).glb",
        "NASA 3D Resources (no individual credit listed)",
        10000,
        ("span", 20.1),
        (
            "part",
            "JUNO-solar-face",
        ),  # its spin axis: the arrays' normal, toward the dish
    ),
    "parker": (
        "Parker Solar Probe/Parker Solar Probe.glb",
        "NASA/Matthew J. Garcia",
        8000,
        ("part", "black matte", 2.3),  # the heat shield's face
        ("part", "black matte"),
    ),
    "webb": (
        "James Webb Space Telescope (A)/James Webb Space Telescope (A).glb",
        "NASA/Christopher R. Meaney",
        14000,
        ("part", "shld_silv1", 21.2),  # the sunshield's long side
        ("part", "shld_silv1"),
    ),
    "galileo": (
        "Galileo/Galileo.glb",
        "NASA/JPL/Solar System Simulator",
        8000,
        ("part", "ribs:gold_mesh", 4.8),
        ("part", "ribs:gold_mesh"),
    ),
    "cassini": (
        "Cassini-Huygens (A)/Cassini-Huygens (A).glb",
        "NASA/JPL/Solar System Simulator",
        10000,
        ("part", "dish_AO", 4.0),  # the high-gain antenna's diameter
        ("part", "dish_AO"),
    ),
}
MAX_PALETTE = 12  # the viewer's AE_CRAFT_PAL
# Where a source colour misleads (Galileo's "bus:black" is blue in the file; Parker's heat shield is drawn black but
# its sunward face is white alumina), the real one (linear): craft key -> {material substring: rgb}.
RECOLOUR = {
    "galileo": {"bus:black": (0.01, 0.01, 0.012)},
    "parker": {"black matte": (0.7, 0.7, 0.66)},
}
# Parts that stay whole (their triangles are what the craft is known by: Webb's gold mirror segments): key -> material substrings.
KEEP_WHOLE = {"webb": ("mirror_blinn", "omnimirror")}
SIMPLIFY_PASSES = (4, 8, 12)  # fast_simplification's aggressiveness (its default is 7): gentler first keeps rims and edges
WELD_STEPS = 1e5  # vertices closer than the model's span over this are one


def material_looks(j, blob, recolour=None):
    """Per material: (rgb linear, roughness, metalness) by its name and colour, a texture folded into its mean."""
    out = []
    for m in j.get("materials", []):
        pbr = m.get("pbrMetallicRoughness", {})
        rgb = np.array(pbr.get("baseColorFactor", [1, 1, 1, 1])[:3], dtype=np.float64)
        if "baseColorTexture" in pbr:
            rgb = rgb * cm.texture_mean(j, blob, pbr["baseColorTexture"])
        name = m.get("name", "")
        for sub, real in (recolour or {}).items():
            if sub.lower() in name.lower():
                rgb = np.array(real, dtype=np.float64)
        out.append(
            cm.look_of(
                name, rgb, pbr.get("roughnessFactor"), pbr.get("metallicFactor", 0.0)
            )
        )
    return out


def palette(looks, weights):
    """Merge the materials into at most MAX_PALETTE entries: the nearest colours of the same finish first."""
    groups = [[i] for i in range(len(looks))]

    def mean(g):
        w = np.array([weights[i] + 1e-9 for i in g])
        return (np.array([looks[i][0] for i in g]) * w[:, None]).sum(0) / w.sum()

    def close(a, b):
        la, lb = looks[a[0]], looks[b[0]]
        return (
            abs(la[1] - lb[1]) < 0.12
            and abs(la[2] - lb[2]) < 0.25
            and np.linalg.norm(mean(a) - mean(b)) < 0.06
        )

    merged = True
    while merged:
        merged = False
        for x in range(len(groups)):
            for y in range(x + 1, len(groups)):
                if close(groups[x], groups[y]):
                    groups[x] += groups.pop(y)
                    merged = True
                    break
            if merged:
                break
    while len(groups) > MAX_PALETTE:
        best = min(
            ((x, y) for x in range(len(groups)) for y in range(x + 1, len(groups))),
            key=lambda p: np.linalg.norm(mean(groups[p[0]]) - mean(groups[p[1]])),
        )
        groups[best[0]] += groups.pop(best[1])
    entry_of = {}
    entries = []
    for k, g in enumerate(groups):
        for i in g:
            entry_of[i] = k
        heavy = max(g, key=lambda i: weights[i])
        entries.append((mean(g), looks[heavy][1], looks[heavy][2], 0, -1, -1, -1))
    return entry_of, entries


def _flattest(v):
    """The axis a point set is thinnest along (a dish's or a shield's normal), and the set's centroid."""
    c = v.mean(0)
    _, _, vt = np.linalg.svd(v - c, full_matrices=False)
    return vt[2], c


def aim_axis(rule, v_all, by_mat, names):
    mid = (v_all.min(0) + v_all.max(0)) / 2
    if rule[0] == "long":
        _, _, vt = np.linalg.svd(v_all - v_all.mean(0), full_matrices=False)
        a = vt[0]
        t = (v_all - mid) @ a
        across = lambda side: np.linalg.norm(
            (v_all[side] - mid) - np.outer(t[side], a), axis=1
        ).max()
        return a if across(t > 0) >= across(t < 0) else -a
    hit = [i for i in by_mat if rule[1].lower() in names[i].lower()]
    a, c = _flattest(np.vstack([by_mat[i] for i in hit]))
    # Away from the rest of the craft: a dish faces out from the bus behind it, a shield from what it shades.
    rest = np.vstack([v for i, v in by_mat.items() if i not in hit])
    return a if np.dot(c - rest.mean(0), a) >= 0 else -a


def clustered(v, f, want, steps=14):
    """Vertex clustering to about `want` triangles: points on a grid merged to their mean, the cell found by bisection.
    Coarser than the quadric but it has no boundary to keep, so a sheet of loose layers (Webb's sunshield) comes down."""
    lo, hi = v.min(0), v.max(0)
    a, b = np.ptp(v, 0).max() / 4000.0, np.ptp(v, 0).max() / 4.0
    best = (v, f)
    for _ in range(steps):
        cell = np.sqrt(a * b)
        key = np.floor((v - lo) / cell).astype(np.int64)
        _, inv = np.unique(key, axis=0, return_inverse=True)
        inv = inv.reshape(-1)
        n = inv.max() + 1
        sums = np.zeros((n, 3))
        np.add.at(sums, inv, v)
        v2 = sums / np.bincount(inv, minlength=n)[:, None]
        f2 = inv[f]
        f2 = f2[(f2[:, 0] != f2[:, 1]) & (f2[:, 1] != f2[:, 2]) & (f2[:, 0] != f2[:, 2])]
        if len(f2) > want:
            a = cell
        else:
            b = cell
            best = (v2, f2)
    return best


def simplified(v, f, want, nd):
    """A part welded and quadric-simplified to about `want` triangles: gently first (it keeps rims and edges), then
    harder for what that leaves above the budget (a sheet with a boundary, or a part of many loose pieces, does not
    collapse in one go), and clustered if it still will not."""
    import fast_simplification

    v, f = cm.weld(v, f, nd)
    for agg in SIMPLIFY_PASSES:
        if len(f) <= want * 1.1:
            break
        v, f = fast_simplification.simplify(
            v.astype(np.float32), f.astype(np.int32), target_reduction=1 - want / len(f), agg=agg
        )
    if len(f) > want * 1.5:
        v, f = clustered(np.asarray(v, dtype=np.float64), np.asarray(f), want)
    return np.asarray(v, dtype=np.float64), np.asarray(f, dtype=np.int64)


def craft(glb, tris, size, aim, recolour=None, keep=()):
    j, blob, ps = cm.read_parts(glb)
    names = [m.get("name", "") for m in j.get("materials", [])]
    looks = material_looks(j, blob, recolour)
    by_mat, faces_of = {}, {}
    for p in ps:
        vs, fs = by_mat.setdefault(p["mat"], []), faces_of.setdefault(p["mat"], [])
        fs.append(p["faces"] + sum(len(a) for a in vs))
        vs.append(p["pos"])
    by_mat = {k: np.vstack(v) for k, v in by_mat.items()}
    faces_of = {k: np.vstack(f) for k, f in faces_of.items()}
    v_all = np.vstack(list(by_mat.values()))
    a = aim_axis(aim, v_all, by_mat, names)
    a /= np.linalg.norm(a)
    # Across it, the craft's long dimension (a boom, a solar wing): the view holds it in the ecliptic.
    flat = v_all - np.outer((v_all - v_all.mean(0)) @ a, a)
    _, _, vt = np.linalg.svd(flat - flat.mean(0), full_matrices=False)
    across = vt[0] - np.dot(vt[0], a) * a
    across /= np.linalg.norm(across)
    if size[0] == "span":
        units = max(np.ptp(v_all, 0))
    else:
        pts = np.vstack(
            [v for i, v in by_mat.items() if size[1].lower() in names[i].lower()]
        )
        p = pts - np.outer(pts @ a, a)
        units = max(np.ptp(p @ across), np.ptp(p @ np.cross(a, across)))
    metres = size[-1] / units
    nd = max(3, int(round(np.log10(WELD_STEPS / max(np.ptp(v_all, 0))))))
    weights = {i: len(f) for i, f in faces_of.items()}
    entry_of, entries = palette(looks, [weights.get(i, 0) for i in range(len(looks))])
    whole = {i for i in by_mat if any(w.lower() in names[i].lower() for w in keep)}
    whole_tris = sum(weights[i] for i in whole)
    total = max(sum(weights.values()) - whole_tris, 1)
    pool = max(tris - whole_tris, tris // 4)
    verts, faces, norms, cls = [], [], [], []
    kept = []
    for k in range(len(entries)):
        mats = [i for i in by_mat if entry_of.get(i, 0) == k]
        if not mats:
            continue
        parts = []
        for group, whole_group in (([i for i in mats if i not in whole], False), ([i for i in mats if i in whole], True)):
            if not group:
                continue
            vs, fs = [], []
            for i in group:
                fs.append(faces_of[i] + sum(len(x) for x in vs))
                vs.append(by_mat[i])
            v, f = np.vstack(vs), np.vstack(fs)
            if whole_group:
                v, f = cm.weld(v, f, nd)
            else:
                v, f = simplified(v, f, max(48, int(pool * len(f) / total)), nd)
            parts.append(cm.creased(v, f))
        for v, f, n in parts:
            faces.append(f + sum(len(x) for x in verts))
            verts.append(v)
            norms.append(n)
            cls.append(np.full(len(v), len(kept), dtype=np.uint8))
        kept.append(entries[k])
    v, f, n, c = (
        np.vstack(verts),
        np.vstack(faces),
        np.vstack(norms),
        np.concatenate(cls),
    )
    lo, hi = v.min(0), v.max(0)
    print(
        "  %d triangles, %d vertices, %d palette entries, %.2f m across"
        % (len(f), len(v), len(kept), max(hi - lo) * metres)
    )
    return cm.pack(metres, lo, hi, a, across, kept, v, n, c, f)


# ── The ISS ──
# Its five classes by material (structure, truss, the main arrays that turn to the Sun, radiators, fixed arrays), each
# simplified on its own share; axes the station's own (LVLH: +x toward the Earth, +y forward, +z along the truss).
ISS_SPAN_M = 109.0
STRUCTURE, TRUSS, ARRAY, RADIATOR, ARRAY_FIXED = range(5)
ISS_CLASS_OF = {
    "lambert7SG.001": ARRAY,
    "lambert4SG.001": ARRAY_FIXED,
    "soyuz_blinn4SG.001": RADIATOR,
    "lambert3SG.001": TRUSS,
    "anisotropic1SG.001": TRUSS,
}
ISS_SHARE = {STRUCTURE: 0.5, TRUSS: 0.3, ARRAY: 0.08, RADIATOR: 0.06, ARRAY_FIXED: 0.06}
# (rgb linear, roughness, metalness): module shell, truss, cell side of the arrays, radiator panels, fixed arrays.
ISS_LOOK = [
    ((0.62, 0.61, 0.58), 0.5, 0.15),
    ((0.42, 0.42, 0.41), 0.4, 0.7),
    (cm.SOLAR_BLUE, 0.2, 0.4),
    ((0.8, 0.8, 0.82), 0.55, 0.0),
    (cm.SOLAR_BLUE, 0.2, 0.4),
]
ISS_STRAY_Y = (
    40.0  # seven small cylinders parked far off the station in the source file
)


def _iss(glb, tris=26000):
    j, _blob, ps = cm.read_parts(glb)
    by = {}
    for p in ps:
        if p["pos"][:, 1].min() > ISS_STRAY_Y:
            continue
        k = ISS_CLASS_OF.get(j["materials"][p["mat"]]["name"], STRUCTURE)
        vs, fs = by.setdefault(k, ([], []))
        fs.append(p["faces"] + sum(len(a) for a in vs))
        vs.append(p["pos"])
    span = max(np.ptp(np.vstack([x for k in by for x in by[k][0]]), 0))
    nd = max(3, int(round(np.log10(WELD_STEPS / span))))
    verts, faces, norms, cls = [], [], [], []
    for k in sorted(by):
        v, f = simplified(
            np.vstack(by[k][0]),
            np.vstack(by[k][1]),
            max(64, int(tris * ISS_SHARE[k])),
            nd,
        )
        v, f, n = cm.creased(v, f)
        faces.append(f + sum(len(a) for a in verts))
        verts.append(v)
        norms.append(n)
        cls.append(np.full(len(v), k, dtype=np.uint8))
    v, f, n, c = (
        np.vstack(verts),
        np.vstack(faces),
        np.vstack(norms),
        np.concatenate(cls),
    )
    lo, hi = v.min(0), v.max(0)
    arr = v[c == ARRAY]
    axis = (
        (arr[:, 0].min() + arr[:, 0].max()) / 2,
        (arr[:, 1].min() + arr[:, 1].max()) / 2,
    )
    metres = ISS_SPAN_M / (hi[2] - lo[2])
    entries = [
        (rgb, rough, metal, cm.MAT_DOUBLE_SIDED, -1, -1, -1)
        for rgb, rough, metal in ISS_LOOK
    ]
    print("  %d triangles, %d vertices" % (len(f), len(v)))
    return cm.pack(
        metres,
        lo,
        hi,
        (0, 0, 0),
        (0, 0, 0),
        entries,
        v,
        n,
        c,
        f,
        turn=axis,
        turn_class=ARRAY,
    )


_glb, _mat4 = (
    cm.split_glb,
    cm._mat4,
)  # the site models' builder (build_site_models.py) reads glTF through these


def _fetch(url, src, name):
    if src:
        with open(os.path.join(src, name), "rb") as fh:
            return fh.read()
    req = urllib.request.Request(url, headers={"User-Agent": "Zimi-build/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--only", help="comma-separated keys (iss and those in CRAFT); default all"
    )
    ap.add_argument(
        "--src", help="a folder with the downloaded files under their own names"
    )
    ap.add_argument(
        "--out", default=EARTH, help="where the files go (default: the static folder)"
    )
    a = ap.parse_args()
    keys = a.only.split(",") if a.only else ["iss", *CRAFT]
    for key in keys:
        print(key)
        if key == "iss":
            data = _iss(
                _fetch(ISS_URL, a.src, "International Space Station (ISS) (B).glb")
            )
            out = os.path.join(a.out, "iss-v1.bin")
        else:
            path, _credit, tris, size, aim = CRAFT[key]
            glb = _fetch(REPO + urllib.parse.quote(path), a.src, os.path.basename(path))
            data = craft(glb, tris, size, aim, RECOLOUR.get(key), KEEP_WHOLE.get(key, ()))
            out = os.path.join(a.out, "craft-%s-v1.bin" % key)
        with open(out, "wb") as fh:
            fh.write(data)
        print("  %s: %d bytes" % (os.path.relpath(out, ROOT), len(data)))


if __name__ == "__main__":
    main()
