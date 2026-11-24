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
import json
import os
import struct
import urllib.parse
import urllib.request

import numpy as np

import craftmesh as cm

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH = os.path.join(ROOT, "zimi", "static", "earth")
REPO = "https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Models/"
EYES = "https://eyes.nasa.gov/assets/static/models/"
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
        ("part", "JUNO-solar-face"),  # its spin axis: the arrays' normal, toward the dish
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
        "Cassini Assembly/Cassini Assembly.glb",
        "NASA 3D Resources (no individual credit listed)",
        10000,
        ("part", "white", 4.0),  # the high-gain antenna's diameter
        ("part", "white"),
    ),
    'lro': (
        'Lunar Reconnaissance Orbiter (B)/Lunar Reconnaissance Orbiter (B).glb',
        'NASA 3D Resources (no individual credit listed)',
        5000,
        ("span", 5.5),
        ("long",),
    ),
    'mgs': (
        'Mars Global Surveyor/Mars Global Surveyor.glb',
        'NASA 3D Resources (no individual credit listed)',
        5000,
        ("span", 10.5),
        ("long",),
    ),
    'odyssey': (
        'Mars Odyssey/Mars Odyssey.glb',
        'NASA 3D Resources (no individual credit listed)',
        6000,
        ("span", 8.2),
        ("long",),
    ),
    'mro': (
        'Mars Reconnaissance Orbiter (MRO) (A)/Mars Reconnaissance Orbiter (MRO) (A).glb',
        'NASA 3D Resources (no individual credit listed)',
        7000,
        ("span", 13.6),
        ("long",),
    ),
    'maven': (
        'Mars Atmosphere and Volatile EvolutioN (MAVEN) (A)/Mars Atmosphere and Volatile EvolutioN (MAVEN) (A).glb',
        'NASA 3D Resources (no individual credit listed)',
        6000,
        ("span", 13.5),
        ("long",),
    ),
    'messenger': (
        'MErcury Surface, Space ENvironment, GEochemistry, and Ranging (MESSENGER)/MErcury Surface, Space ENvironment, GEochemistry, and Ranging (MESSENGER).glb',
        'NASA 3D Resources (no individual credit listed)',
        6000,
        ("span", 7.0),
        ("long",),
    ),
    'magellan': (
        'Magellan/Magellan.glb',
        'NASA 3D Resources (no individual credit listed)',
        5000,
        ("span", 8.9),
        ("long",),
    ),
    'mir': (
        'Mir/Mir.glb',
        'NASA 3D Resources (no individual credit listed)',
        5800,
        ("span", 33.0),
        ("long",),
    ),
    'compton': (
        'Gamma Ray Observatory/Gamma Ray Observatory.glb',
        'NASA 3D Resources (no individual credit listed)',
        4200,
        ("span", 9.0),
        ("long",),
    ),
    'osirisrex': (
        'Origins, Spectral Interpretation, Resource Identification, and Security - Regolith Explorer (OSIRIS-REx)/OSIRIS-REx.glb',
        'NASA 3D Resources (no individual credit listed)',
        6000,
        ("span", 6.2),
        ("long",),
    ),
    'clipper': (
        'https://assets.science.nasa.gov/content/dam/science/missions/europa-clipper/3d/clipper_spacecraft.glb',
        'NASA/JPL-Caltech, Europa Clipper downloadable 3D model',
        9000,
        ("span", 30.5),
        ("long",),
    ),
    'newhorizons': (
        'https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/n/New_Horizons.glb',
        'NASA, New Horizons 3D model (science.nasa.gov/resource/new-horizons-3d-model)',
        6000,
        ("span", 2.9),
        ("long",),
    ),
    'psyche': (
        'sc_psyche/psyche.gltf',
        'NASA/JPL, Eyes on the Solar System (eyes.nasa.gov)',
        7000,
        ("span", 24.7),
        ("long",),
    ),
    'lucy': (
        'sc_lucy/lucy.gltf',
        'NASA/JPL, Eyes on the Solar System (eyes.nasa.gov)',
        7000,
        ("span", 15.6),
        ("long",),
    ),
    'lcross': (
        'sc_lcross/lcross.gltf',
        'NASA/JPL, Eyes on the Solar System (eyes.nasa.gov)',
        5000,
        ("span", 3.6),
        ("long",),
    ),
    'lunar-prospector': (
        'sc_lunar_prospector/lunar_prospector.gltf',
        'NASA/JPL, Eyes on the Solar System (eyes.nasa.gov)',
        5000,
        ("span", 6.7),
        ("long",),
    ),
    'explorer1': (
        'sc_explorer_1_v2/explorer_1.gltf',
        'NASA/JPL, Eyes on the Solar System (eyes.nasa.gov)',
        3500,
        ("span", 2.03),
        ("long",),
    ),
    'ladee': (
        'sc_ladee/ladee.gltf',
        'NASA/JPL, Eyes on the Solar System (eyes.nasa.gov)',
        5000,
        ("span", 2.0),
        ("long",),
    ),
    'hubble': (
        'Hubble Space Telescope (A)/Hubble Space Telescope (A).glb',
        'NASA 3D Resources (no individual credit listed)',
        7000,
        ("span", 13.3),
        ("long",),
    ),
    'chandra': (
        'Chandra X-ray Observatory/Chandra X-ray Observatory.glb',
        'NASA 3D Resources (no individual credit listed)',
        6000,
        ("span", 19.5),
        ("long",),
    ),
    'tess': (
        'Transiting Exoplanet Survey Satellite (TESS) (B)/Transiting Exoplanet Survey Satellite (TESS) (B).glb',
        'NASA 3D Resources (no individual credit listed)',
        5000,
        ("span", 7.4),
        ("long",),
    ),
    'fermi': (
        'Fermi Gamma-ray Large Area Space Telescope/Fermi Gamma-ray Large Area Space Telescope.glb',
        'NASA 3D Resources (no individual credit listed)',
        6000,
        ("span", 15.0),
        ("long",),
    ),
    'landsat1': (
        'Landsat 1, 2, and 3/Landsat 1, 2, and 3.glb',
        'NASA 3D Resources (no individual credit listed)',
        5000,
        ("span", 4.6),
        ("long",),
    ),
    'landsat8': (
        'Landsat 8/Landsat 8.glb',
        'NASA 3D Resources (no individual credit listed)',
        6000,
        ("span", 9.0),
        ("long",),
    ),
    'terra': (
        'Terra/Terra.glb',
        'NASA 3D Resources (no individual credit listed)',
        6000,
        ("span", 24.0),
        ("long",),
    ),
    'aqua': (
        'Aqua (A)/Aqua (A).glb',
        'NASA 3D Resources (no individual credit listed)',
        6000,
        ("span", 16.0),
        ("long",),
    ),
    'tdrs': (
        'Tracking and Data Relay Satellites (TDRS) (D)/Tracking and Data Relay Satellites (TDRS) (D).glb',
        'NASA 3D Resources (no individual credit listed)',
        6000,
        ("span", 13.0),
        ("long",),
    ),
    'goes': (
        'Geostationary Operational Environmental Satellites/Geostationary Operational Environmental Satellites.glb',
        'NASA 3D Resources (no individual credit listed)',
        5000,
        ("span", 6.1),
        ("long",),
    ),
    'spitzer': (
        'Spitzer Space Telescope/Spitzer Space Telescope.glb',
        'NASA 3D Resources (no individual credit listed)',
        6000,
        ("span", 4.5),
        ("long",),
    ),
    'kepler': (
        'Kepler (A)/Kepler (A).glb',
        'NASA 3D Resources (no individual credit listed)',
        5000,
        ("span", 5.0),
        ("long",),
    ),
}
# The craft the app ships close up (craft-<key>-v1.bin) and the HD pack upgrades; every other key in CRAFT is the Sent
# chooser's, drawn in the standard Almanac only as a picture (sent-thumbs-v1.webp) and carried whole in the HD pack.
STOCK = ("voyager", "pioneer", "juno", "parker", "webb", "galileo", "cassini", "kepler", "newhorizons",
         "clipper", "osirisrex", "psyche", "lucy", "hubble", "chandra")
MAX_PALETTE = 12  # the viewer's AE_CRAFT_PAL
# Where a source colour misleads (Galileo's "bus:black" is blue in the file; Parker's heat shield is drawn black but
# its sunward face is white alumina), the real one (linear): craft key -> {material substring: rgb}.
RECOLOUR = {
    "galileo": {"bus:black": (0.01, 0.01, 0.012)},
    "parker": {"black matte": (0.7, 0.7, 0.66)},
    # MRO's textures average to near black: its bus is gold foil over light grey structure
    "psyche": {"Psyche": ((0.04, 0.07, 0.2), 0.25, 0.2, cm.KIND_CELLS)},
    "mro": {"foil": (0.55, 0.38, 0.1), "default #2": (0.62, 0.62, 0.6), "parts": (0.4, 0.4, 0.42), "tower": (0.6, 0.6, 0.6), "cover": (0.6, 0.6, 0.58), "pole": (0.5, 0.5, 0.5), "rocket": (0.45, 0.45, 0.47), "lens": (0.1, 0.1, 0.12)},
    # aluminised Kapton with a doped-silicon coating: silver with a magenta cast
    "webb": {"shld_silv": (0.74, 0.66, 0.76), "shld_pink": (0.72, 0.42, 0.62)},
}
# A palette entry (by its place in the built file) that is the wrong material in the source: key -> {entry: (rgb linear, roughness, metalness, kind)}.
# Hubble's arrays are tan in the file; they are blue-black silicon cells.
PALETTE_FIX = {"hubble": {3: ((0.03, 0.045, 0.14), 0.25, 0.2, cm.KIND_CELLS)}}
# Parts that stay whole (their triangles are what the craft is known by: Webb's gold mirror segments): key -> material substrings.
KEEP_WHOLE = {"webb": ("mirror_blinn", "omnimirror"), "psyche": ("psyche", "array gold")}
# Materials simplified one primitive at a time, so layers kept apart in the file stay apart (Webb's five sunshield layers).
PER_PRIM = {"webb": ("shld_",)}
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
        full = None
        for sub, real in (recolour or {}).items():
            if sub.lower() in name.lower():
                if len(real) == 4:  # (rgb, roughness, metalness, kind): the material is this, whatever its name
                    full = (np.array(real[0], dtype=np.float64), real[1], real[2], real[3])
                else:
                    rgb = np.array(real, dtype=np.float64)
        if full:
            out.append(full)
            continue
        look = cm.look_of(name, rgb, pbr.get("roughnessFactor"), pbr.get("metallicFactor", 0.0))
        out.append(look + (cm.kind_of(name),))
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
        entries.append((mean(g), looks[heavy][1], looks[heavy][2], 0, -1, -1, -1, looks[heavy][3]))
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
    return dropped_specks(np.asarray(v, dtype=np.float64), np.asarray(f, dtype=np.int64))


SPECK_TRIS, SPECK_SPAN = 12, 0.004  # a loose piece under this many triangles and this share of the part's span is debris


def dropped_specks(v, f):
    """The part without its loose debris: pieces the decimation or clustering left floating (a few triangles, tiny)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    n = len(v)
    e = np.r_[f[:, [0, 1]], f[:, [1, 2]]]
    _, lab = connected_components(coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)), directed=False)
    ftri = np.bincount(lab[f[:, 0]], minlength=lab.max() + 1)
    span = np.ptp(v, 0).max()
    keep = np.ones(lab.max() + 1, dtype=bool)
    for c in np.nonzero(ftri < SPECK_TRIS)[0]:
        pts = v[lab == c]
        if len(pts) and np.ptp(pts, 0).max() < SPECK_SPAN * span:
            keep[c] = False
    return v, f[keep[lab[f[:, 0]]]]


def craft(glb, tris, size, aim, recolour=None, keep=(), per_prim=()):
    j, blob, ps = cm.read_parts(glb)
    names = [m.get("name", "") for m in j.get("materials", [])]
    looks = material_looks(j, blob, recolour)
    by_mat, faces_of, prims_of = {}, {}, {}
    for p in ps:
        prims_of.setdefault(p["mat"], []).append(p)
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
            layered = [i for i in group if any(w.lower() in names[i].lower() for w in per_prim)]
            for i in layered:  # each primitive on its own share: loose layers stay layers
                for p in prims_of[i]:
                    v, f = simplified(p["pos"], p["faces"], max(48, int(pool * len(p["faces"]) / total)), nd)
                    parts.append(cm.creased(v, f))
            group = [i for i in group if i not in layered]
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
ISS_CELL = (0.018, 0.028, 0.09)  # the cell side of an array: blue-black, the glint does the rest
ISS_LOOK = [
    ((0.78, 0.77, 0.74), 0.5, 0.05),
    ((0.62, 0.62, 0.6), 0.42, 0.3),
    (ISS_CELL, 0.2, 0.1),
    ((0.92, 0.92, 0.94), 0.55, 0.0),
    (ISS_CELL, 0.2, 0.1),
]
ISS_ARRAY_FLAGS = cm.MAT_DOUBLE_SIDED | cm.MAT_AMBER_BACK
ISS_KIND = [cm.KIND_QUILT, cm.KIND_METAL, cm.KIND_CELLS, cm.KIND_RADIATOR, cm.KIND_CELLS]  # a procedural surface per class
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


def gltf_to_glb(gltf_bytes, fetch):
    """A .gltf with its .bin and images beside it as one .glb (`fetch(uri)` returns a sibling file's bytes)."""
    j = json.loads(gltf_bytes)
    blob = bytearray()

    def add(data):
        while len(blob) % 4:
            blob.append(0)
        view = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)}
        blob.extend(data)
        j.setdefault("bufferViews", []).append(view)
        return len(j["bufferViews"]) - 1

    src = j["buffers"][0]
    base = fetch(src["uri"])
    blob.extend(base)  # the views keep their offsets; the images are appended after the .bin
    for im in j.get("images", []):
        if "uri" in im:
            data = fetch(im["uri"])
            im["bufferView"] = add(data)
            im["mimeType"] = "image/png" if im["uri"].lower().endswith(".png") else "image/jpeg"
            del im["uri"]
    while len(blob) % 4:
        blob.append(0)
    j["buffers"] = [{"byteLength": len(blob)}]
    js = json.dumps(j).encode()
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    return (
        struct.pack("<4sII", b"glTF", 2, total)
        + struct.pack("<I4s", len(js), b"JSON")
        + js
        + struct.pack("<I4s", len(blob), b"BIN\0")
        + bytes(blob)
    )


def _fetch(url, src, name):
    if src:
        with open(os.path.join(src, os.path.basename(name)), "rb") as fh:   # a glTF's uri is data: never a path
            return fh.read()
    req = urllib.request.Request(url, headers={"User-Agent": "Zimi-build/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def source_glb(path, src):
    """The model's .glb: a path under NASA-3D-Resources' "3D Models", a full URL, or an Eyes on the Solar System .gltf
    (its .bin and textures fetched beside it and packed into one .glb)."""
    if path.endswith(".gltf"):
        base = EYES + path.rsplit("/", 1)[0] + "/"
        fetch = lambda uri: _fetch(base + uri, src, uri)
        return gltf_to_glb(fetch(os.path.basename(path)), fetch)
    url = path if path.startswith("http") else REPO + urllib.parse.quote(path)
    return _fetch(url, src, os.path.basename(path))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--only", help="comma-separated keys (iss and those in CRAFT); default all"
    )
    ap.add_argument(
        "--src", help="a folder with the downloaded files under their own names"
    )
    ap.add_argument(
        "--out", default=EARTH, help="where the stock files go (default: the static folder)"
    )
    ap.add_argument("--hd", help="the Almanac HD craft folder (hd/craft/): where every craft that is not STOCK goes, with its index row")
    a = ap.parse_args()
    keys = a.only.split(",") if a.only else ["iss", *STOCK, *(k for k in CRAFT if k not in STOCK and a.hd)]
    for key in keys:
        print(key)
        if key == "iss":
            data = _iss(
                _fetch(ISS_URL, a.src, "International Space Station (ISS) (B).glb")
            )
            out = os.path.join(a.out, "iss-v1.bin")
        else:
            path, _credit, tris, size, aim = CRAFT[key]
            glb = source_glb(path, a.src)
            data = craft(glb, tris, size, aim, RECOLOUR.get(key), KEEP_WHOLE.get(key, ()), PER_PRIM.get(key, ()))
            for entry, look in PALETTE_FIX.get(key, {}).items():
                data = cm.set_look(data, entry, *look)
            if key not in STOCK:
                if not a.hd:
                    raise SystemExit("%s is not a stock model: give --hd (the HD craft folder)" % key)
                cm.hd_add(a.hd, key, data, _credit)
                print("  %s/%s.zcr2: %d bytes" % (a.hd, key, len(data)))
                continue
            out = os.path.join(a.out, "craft-%s-v1.bin" % key)
        with open(out, "wb") as fh:
            fh.write(data)
        print("  %s: %d bytes" % (os.path.relpath(out, ROOT), len(data)))


if __name__ == "__main__":
    main()
