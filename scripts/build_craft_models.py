"""Build the spacecraft the 3D view shows close up, each a small mesh in zimi/static/earth/.

    python scripts/build_craft_models.py [--only iss,voyager] [--src DIR]

Every model is from NASA 3D Resources (github.com/nasa/NASA-3D-Resources; its README: "These assets are free and
without copyright"), each page's credit line recorded in CRAFT below and in zimi/static/earth/SOURCES.txt. --src is a
folder holding the downloaded files under their own names (else they are fetched). Build-time needs: numpy, DracoPy
(the files are Draco-compressed), fast-simplification and Pillow (a textured part takes its texture's mean colour, so a
logo printed on a texture never reaches the model).

The ISS keeps its own format (iss-v1.bin, "ZISS": five shading classes chosen by material, the main arrays turning
about the truss; see _iss below). Every other craft is "ZCRF": its materials' colours as a small palette, each part
simplified on its own share of the triangles so panels keep their edges, scaled to metres from one known size, with
the direction that points (the high-gain antenna's boresight, Parker's heat shield, Webb's sunshield) found from the
geometry and stored, so the view turns that axis toward the Earth or the Sun.

ZCRF, little-endian: 4 bytes "ZCRF", uint32 version 1, float32 metres per unit, float32 the box (min xyz, max xyz,
in units), float32 the pointing axis (xyz, unit), float32 a second axis across it (xyz, unit: the craft's long
dimension, held in the ecliptic), uint32 palette entries, per entry float32 r, g, b, specular strength, sharpness,
uint32 vertices, uint32 triangles, then per vertex int16 x, y, z quantized to the box, uint8 palette entry, uint8 pad,
then uint16 (or uint32 past 65,535 vertices) indices, the triangles of each entry together.
"""

import argparse
import io
import json
import os
import struct
import urllib.parse
import urllib.request

import numpy as np

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
        12000,
        ("part", "VoyagerDish", 3.66),
        ("part", "VoyagerDish"),
    ),
    "pioneer": (
        "Pioneer 10/Pioneer 10.glb",
        "NASA/JPL/Eyes on the Solar System",
        12000,
        ("part", "dish_AO", 2.74),
        ("part", "dish_AO"),
    ),
    "juno": (
        "Juno (B)/Juno (B).glb",
        "NASA 3D Resources (no individual credit listed)",
        12000,
        ("span", 20.1),
        ("part", "JUNO-solar-face"),  # its spin axis: the arrays' normal, toward the dish
    ),
    "parker": (
        "Parker Solar Probe/Parker Solar Probe.glb",
        "NASA/Matthew J. Garcia",
        12000,
        ("part", "black matte", 2.3),  # the heat shield's face
        ("part", "black matte"),
    ),
    "webb": (
        "James Webb Space Telescope (B)/James Webb Space Telescope (B).glb",
        "NASA/Christopher R. Meaney",
        14000,
        ("span", 21.2),
        ("part", "JWST-FoilLayer1"),
    ),
    "galileo": (
        "Galileo/Galileo.glb",
        "NASA/JPL/Solar System Simulator",
        10000,
        ("part", "ribs:gold_mesh", 4.8),
        ("part", "ribs:gold_mesh"),
    ),
    "cassini": (
        "Cassini-Huygens (B)/Cassini-Huygens (B).glb",
        "NASA/JPL/Solar System Simulator",
        12000,
        ("span", 6.8),
        ("long",),
    ),
}
MAX_PALETTE = 8
# Where a source colour misleads (Galileo's "bus:black" is blue in the file; Parker's heat shield is drawn black but
# its sunward face is white alumina), the real one: craft key -> {material substring: rgb}.
RECOLOUR = {
    "galileo": {"bus:black": (0.09, 0.09, 0.1)},
    "parker": {"black matte": (0.9, 0.9, 0.88)},
}
SHINY = ("gold", "silver", "foil", "solar", "mirror", "bronze", "krinkle")
LOOK_SHINY, LOOK_MATTE = (1.1, 60.0), (0.2, 16.0)


def _mat4(n):
    if "matrix" in n:
        return np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
    x, y, z, w = n.get("rotation", [0, 0, 0, 1])
    r = np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )
    m = np.eye(4)
    m[:3, :3] = r * np.array(n.get("scale", [1, 1, 1]))
    m[:3, 3] = n.get("translation", [0, 0, 0])
    return m


def _glb(glb):
    (cl,) = struct.unpack("<I", glb[12:16])
    j = json.loads(glb[20 : 20 + cl])
    off = 20 + cl
    (bl,) = struct.unpack("<I", glb[off : off + 4])
    return j, glb[off + 8 : off + 8 + bl]


def parts(glb):
    """[(material index, vertices in the scene's frame, triangles)] for every Draco primitive."""
    import DracoPy

    j, blob = _glb(glb)
    out = []

    def walk(i, m):
        n = j["nodes"][i]
        m = m @ _mat4(n)
        for p in j["meshes"][n["mesh"]]["primitives"] if "mesh" in n else []:
            bv = j["bufferViews"][
                p["extensions"]["KHR_draco_mesh_compression"]["bufferView"]
            ]
            o = bv.get("byteOffset", 0)
            d = DracoPy.decode(blob[o : o + bv["byteLength"]])
            v = np.asarray(d.points, dtype=np.float64)
            v = (np.c_[v, np.ones(len(v))] @ m.T)[:, :3]
            out.append((p.get("material", 0), v, np.asarray(d.faces).reshape(-1, 3)))
        for c in n.get("children", []):
            walk(c, m)

    for r in j["scenes"][0]["nodes"]:
        walk(r, np.eye(4))
    return j, blob, out


def _texture_mean(j, blob, tex):
    """A texture's mean colour (linear-ish 0..1), or white when it cannot be read."""
    from PIL import Image

    t = j["textures"][tex["index"]]
    src = (t.get("extensions", {}).get("EXT_texture_webp") or {}).get(
        "source", t.get("source")
    )
    try:
        bv = j["bufferViews"][j["images"][src]["bufferView"]]
        o = bv.get("byteOffset", 0)
        im = (
            Image.open(io.BytesIO(blob[o : o + bv["byteLength"]]))
            .convert("RGB")
            .resize((32, 32))
        )
        return np.asarray(im, dtype=np.float64).reshape(-1, 3).mean(0) / 255.0
    except Exception:
        return np.ones(3)


def material_looks(j, blob, recolour=None):
    """Per material: (rgb, specular strength, sharpness), the texture (if any) folded into its colour."""
    out = []
    for m in j.get("materials", []):
        pbr = m.get("pbrMetallicRoughness", {})
        rgb = np.array(pbr.get("baseColorFactor", [1, 1, 1, 1])[:3], dtype=np.float64)
        if "baseColorTexture" in pbr:
            rgb = rgb * _texture_mean(j, blob, pbr["baseColorTexture"])
        name = m.get("name", "").lower()
        for sub, real in (recolour or {}).items():
            if sub.lower() in name:
                rgb = np.array(real, dtype=np.float64)
        look = (
            LOOK_SHINY
            if any(s in name for s in SHINY) or pbr.get("metallicFactor", 0) > 0.5
            else LOOK_MATTE
        )
        out.append((rgb, look[0], look[1]))
    return out


def palette(looks, weights):
    """Merge the materials into at most MAX_PALETTE entries: the nearest colours of the same finish first."""
    groups = [[i] for i in range(len(looks))]

    def mean(g):
        w = np.array([weights[i] + 1e-9 for i in g])
        return (np.array([looks[i][0] for i in g]) * w[:, None]).sum(0) / w.sum()

    def close(a, b):
        return (
            looks[a[0]][1] == looks[b[0]][1]
            and np.linalg.norm(mean(a) - mean(b)) < 0.08
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
        entries.append((mean(g), looks[g[0]][1], looks[g[0]][2]))
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


def craft(glb, tris, size, aim, recolour=None):
    import fast_simplification

    j, blob, ps = parts(glb)
    names = [m.get("name", "") for m in j.get("materials", [])]
    looks = material_looks(j, blob, recolour)
    by_mat, faces_of = {}, {}
    for mi, v, f in ps:
        vs, fs = by_mat.setdefault(mi, []), faces_of.setdefault(mi, [])
        fs.append(f + sum(len(a) for a in vs))
        vs.append(v)
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
    weights = {i: len(f) for i, f in faces_of.items()}
    entry_of, entries = palette(looks, [weights.get(i, 0) for i in range(len(looks))])
    total = sum(weights.values())
    verts, faces, cls = [], [], []
    for k in range(len(entries)):
        mats = [i for i in by_mat if entry_of.get(i, 0) == k]
        if not mats:
            continue
        vs, fs = [], []
        for i in mats:
            fs.append(faces_of[i] + sum(len(x) for x in vs))
            vs.append(by_mat[i])
        v = np.vstack(vs).astype(np.float32)
        f = np.vstack(fs).astype(np.int32)
        v, inv = np.unique(v.round(5), axis=0, return_inverse=True)
        f = inv.reshape(-1)[f]
        f = f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]
        want = max(48, int(tris * len(f) / max(total, 1)))
        if len(f) > want:
            v, f = fast_simplification.simplify(
                v, f, target_reduction=1 - want / len(f)
            )
        faces.append(f + sum(len(x) for x in verts))
        verts.append(v)
        cls.append(np.full(len(v), k, dtype=np.uint8))
    v = np.vstack(verts).astype(np.float64)
    f = np.vstack(faces)
    c = np.concatenate(cls)
    lo, hi = v.min(0), v.max(0)
    q = np.round((v - lo) / np.maximum(hi - lo, 1e-9) * 65534 - 32767).astype(np.int16)
    head = b"ZCRF" + struct.pack(
        "<If6f3f3fI", 1, metres, *lo, *hi, *a, *across, len(entries)
    )
    for rgb, spec, sharp in entries:
        head += struct.pack("<5f", *np.clip(rgb, 0, 1), spec, sharp)
    head += struct.pack("<II", len(v), len(f))
    per = np.zeros(len(v), dtype=[("p", "<i2", 3), ("c", "u1"), ("pad", "u1")])
    per["p"] = q
    per["c"] = c
    idx = f.astype("<u2" if len(v) <= 65535 else "<u4")
    print(
        "  %d triangles, %d palette entries, %.2f m across"
        % (len(f), len(entries), max(hi - lo) * metres)
    )
    return head + per.tobytes() + idx.tobytes()


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
ISS_STRAY_Y = (
    40.0  # seven small cylinders parked far off the station in the source file
)


def _iss(glb, tris=36000):
    import fast_simplification

    j, _blob, ps = parts(glb)
    by = {}
    for mi, v, f in ps:
        if v[:, 1].min() > ISS_STRAY_Y:
            continue
        k = ISS_CLASS_OF.get(j["materials"][mi]["name"], STRUCTURE)
        vs, fs = by.setdefault(k, ([], []))
        fs.append(f + sum(len(a) for a in vs))
        vs.append(v)
    verts, faces, cls = [], [], []
    for k in sorted(by):
        v = np.vstack(by[k][0]).astype(np.float32)
        f = np.vstack(by[k][1]).astype(np.int32)
        v, inv = np.unique(v.round(4), axis=0, return_inverse=True)
        f = inv.reshape(-1)[f]
        f = f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]
        want = max(64, int(tris * ISS_SHARE[k]))
        if len(f) > want:
            v, f = fast_simplification.simplify(
                v, f, target_reduction=1 - want / len(f)
            )
        faces.append(f + sum(len(a) for a in verts))
        verts.append(v)
        cls.append(np.full(len(v), k, dtype=np.uint8))
    v = np.vstack(verts).astype(np.float64)
    f = np.vstack(faces)
    c = np.concatenate(cls)
    lo, hi = v.min(0), v.max(0)
    q = np.round((v - lo) / (hi - lo) * 65534 - 32767).astype(np.int16)
    arr = v[c == ARRAY]
    axis = (
        (arr[:, 0].min() + arr[:, 0].max()) / 2,
        (arr[:, 1].min() + arr[:, 1].max()) / 2,
    )
    metres = ISS_SPAN_M / (hi[2] - lo[2])
    head = b"ZISS" + struct.pack(
        "<If6f2fII", 1, metres, *lo, *hi, *axis, len(v), len(f)
    )
    per = np.zeros(len(v), dtype=[("p", "<i2", 3), ("c", "u1"), ("pad", "u1")])
    per["p"] = q
    per["c"] = c
    idx = f.astype("<u2" if len(v) <= 65535 else "<u4")
    return head + per.tobytes() + idx.tobytes()


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
    a = ap.parse_args()
    keys = a.only.split(",") if a.only else ["iss", *CRAFT]
    for key in keys:
        print(key)
        if key == "iss":
            data = _iss(_fetch(ISS_URL, a.src, "ISS_B.glb"))
            out = os.path.join(EARTH, "iss-v1.bin")
        else:
            path, _credit, tris, size, aim = CRAFT[key]
            glb = _fetch(REPO + urllib.parse.quote(path), a.src, os.path.basename(path))
            data = craft(glb, tris, size, aim, RECOLOUR.get(key))
            out = os.path.join(EARTH, "craft-%s-v1.bin" % key)
        with open(out, "wb") as fh:
            fh.write(data)
        print("  %s: %d bytes" % (os.path.relpath(out, ROOT), len(data)))


if __name__ == "__main__":
    main()
