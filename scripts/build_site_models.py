"""Build the models the Almanac's 3D view stands on the Moon and the planets: landers, rovers, flags and the Saturn V.

    python scripts/build_site_models.py [--only lm,lrv-body] [--src DIR]

Each is a small mesh in zimi/static/earth/ (craft-site-<name>-v1.bin, the ZCRF format of build_craft_models.py), built
in the frame the view places them in: metres, +z up, +y the way it faces (+x to its right), standing on z = 0 and
centred on its footprint. Two kinds:

* From NASA 3D Resources (github.com/nasa/NASA-3D-Resources, "free and without copyright"; each page's credit is in
  SOURCES below and in zimi/static/earth/SOURCES.txt): the Apollo Lunar Module (its descent stage, the part that stayed),
  Perseverance (the Curiosity-class rover on Mars; its wheels split off so they can turn), Ingenuity, the MER rover
  (Spirit and Opportunity) and InSight. --src is a folder of the downloaded files under their own names (else they are
  fetched). Build-time needs: numpy, DracoPy, fast-simplification, Pillow.
* Written here from the craft's published dimensions, for the ones NASA's library has no model of (the Lunar Roving
  Vehicle, Lunokhod, Chang'e and Yutu, Viking, Pathfinder and Sojourner, Phoenix, Huygens, Venera, Surveyor, the flags):
  boxes, cylinders and spheres at their real size, flat-shaded in the view like every other craft.

It also writes the "models" table of sites-v1.json: each model's size and, for a rover, where its wheels are.
"""

import argparse
import json
import math
import os
import struct
import sys
import urllib.parse
import urllib.request

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH = os.path.join(ROOT, "zimi", "static", "earth")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_craft_models as bcm  # noqa: E402

REPO = "https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Models/"
SITES = os.path.join(EARTH, "sites-v1.json")
MAX_PALETTE = 8

# key: (path in the repo's 3D Models folder, the model page's credit line).
NASA = {
    "lm": (
        "Apollo Lunar Module/Apollo Lunar Module.glb",
        "NASA 3D Resources (no individual credit listed)",
    ),
    "perseverance": (
        "Mars 2020 Perseverance Rover/Mars 2020 Perseverance Rover.glb",
        "NASA/JPL-Caltech",
    ),
    "ingenuity": (
        "Ingenuity Mars Helicopter/Ingenuity Mars Helicopter.glb",
        "NASA/JPL-Caltech",
    ),
    "mer": (
        "Mars Exploration Rover - Opportunity (MER-B)/Mars Exploration Rover - Opportunity (MER-B).glb",
        "NASA/JPL-Caltech",
    ),
    "insight": (
        "InSight Cruise Lander/InSight Cruise Lander (arm deployed).glb",
        "NASA/JPL-Caltech",
    ),
    # NASA publishes this one as a Blender file only: scripts/blend_to_glb.py makes the GLB (named in --src as curiosity.glb).
    "curiosity": ("Curiosity Rover (MSL)/curiosity.glb", "NASA/JPL-Caltech"),
    "saturn5": (
        "Saturn V/Saturn V.glb",
        "NASA 3D Resources (no individual credit listed)",
    ),
}


# ── Reading a GLB, Draco or plain, with each part's node path ──
def _accessor(j, blob, idx):
    a = j["accessors"][idx]
    bv = j["bufferViews"][a["bufferView"]]
    o = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    n = {"VEC3": 3, "SCALAR": 1}[a["type"]]
    dt = {5126: "<f4", 5123: "<u2", 5125: "<u4", 5121: "u1"}[a["componentType"]]
    return np.frombuffer(blob, dtype=dt, count=a["count"] * n, offset=o).reshape(-1, n)


def parts_named(glb):
    """[(material index, node path, vertices in the scene's frame, triangles)] for every primitive."""
    import DracoPy

    j, blob = bcm._glb(glb)
    out = []

    def walk(i, m, path):
        n = j["nodes"][i]
        m = m @ bcm._mat4(n)
        here = path + [n.get("name", "")]
        for p in j["meshes"][n["mesh"]]["primitives"] if "mesh" in n else []:
            if "extensions" in p and "KHR_draco_mesh_compression" in p["extensions"]:
                bv = j["bufferViews"][
                    p["extensions"]["KHR_draco_mesh_compression"]["bufferView"]
                ]
                o = bv.get("byteOffset", 0)
                d = DracoPy.decode(blob[o : o + bv["byteLength"]])
                v = np.asarray(d.points, dtype=np.float64)
                f = np.asarray(d.faces).reshape(-1, 3)
            else:
                v = _accessor(j, blob, p["attributes"]["POSITION"]).astype(np.float64)
                f = _accessor(j, blob, p["indices"]).reshape(-1, 3).astype(np.int64)
            v = (np.c_[v, np.ones(len(v))] @ m.T)[:, :3]
            out.append((p.get("material", 0), "/".join(here), v, f))
        for c in n.get("children", []):
            walk(c, m, here)

    for r in j["scenes"][0]["nodes"]:
        walk(r, np.eye(4), [])
    return j, blob, out


# ── Writing ZCRF in the view's frame ──
def write_zcrf(name, v, f, cls, entries, origin=None):
    """v: float vertices (metres, z up, y forward), f: triangles, cls: palette entry per vertex, entries: (rgb, spec,
    sharpness). `origin`: the point taken as (0, 0, 0): "auto" is the middle of the footprint on the lowest point (what
    a model standing on the ground wants); None leaves the coordinates as they are (a part of a rover, placed by the
    view where its body says)."""
    v = np.asarray(v, dtype=np.float64)
    if isinstance(origin, str):
        origin = np.array([(v[:, 0].min() + v[:, 0].max()) / 2, (v[:, 1].min() + v[:, 1].max()) / 2, v[:, 2].min()])
    if origin is not None:
        v = v - origin
    lo, hi = v.min(0), v.max(0)
    q = np.round((v - lo) / np.maximum(hi - lo, 1e-9) * 65534 - 32767).astype(np.int16)
    head = b"ZCRF" + struct.pack(
        "<If6f3f3fI", 1, 1.0, *lo, *hi, 0, 0, 1, 0, 1, 0, len(entries)
    )
    for rgb, spec, sharp in entries:
        head += struct.pack("<5f", *np.clip(rgb, 0, 1), spec, sharp)
    head += struct.pack("<II", len(v), len(f))
    per = np.zeros(len(v), dtype=[("p", "<i2", 3), ("c", "u1"), ("pad", "u1")])
    per["p"] = q
    per["c"] = cls
    idx = np.asarray(f).astype("<u2" if len(v) <= 65535 else "<u4")
    data = head + per.tobytes() + idx.tobytes()
    path = os.path.join(EARTH, "craft-site-%s-v1.bin" % name)
    with open(path, "wb") as fh:
        fh.write(data)
    print(
        "  %-22s %6d triangles %4.1f x %4.1f x %4.1f m  %5.1f KB"
        % (name, len(f), *(hi - lo), len(data) / 1024)
    )
    return {"size": [round(float(x), 3) for x in hi - lo]}


# ── NASA models ──
def _to_view(v, forward):
    """The GLB's y-up frame to the view's z-up; `forward` names the GLB axis the model faces."""
    x, y, z = v[:, 0], v[:, 1], v[:, 2]
    if forward == "+z":
        return np.c_[-x, z, y]
    if forward == "-z":
        return np.c_[x, -z, y]
    if forward == "+x":
        return np.c_[z, x, y]
    raise ValueError(forward)


def _clean(v, f):
    v, inv = np.unique(v.astype(np.float32).round(4), axis=0, return_inverse=True)
    f = inv.reshape(-1)[f]
    return v, f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]


def nasa_model(glb, tris, forward, keep=None, recolour=None, scale=1.0, min_diag=0.0):
    """A GLB as palette-coloured parts, each simplified on its own share of `tris` (by its surface area, so a part keeps
    its shape instead of being eaten with the rest of its colour). `keep(path, v)` filters parts; parts under
    `min_diag` metres across (screws, connectors) are dropped. Returns (vertices, faces, class per vertex, palette
    entries) in the view's frame."""
    j, blob, ps = parts_named(glb)
    ps = [p for p in ps if keep is None or keep(p[1], p[2])]
    return nasa_model_parts(j, blob, ps, tris, forward, recolour, scale, min_diag)


def nasa_model_parts(j, blob, ps, tris, forward, recolour=None, scale=1.0, min_diag=0.0):
    """nasa_model for parts already read and chosen."""
    import fast_simplification

    looks = bcm.material_looks(j, blob, recolour)
    weights = {}
    for mi, _p, _v, f in ps:
        weights[mi] = weights.get(mi, 0) + len(f)
    entry_of, entries = bcm.palette(looks, [weights.get(i, 0) for i in range(len(looks))])
    cooked = []
    for mi, _p, v, f in ps:
        v, f = _clean(_to_view(v, forward) * scale, f)
        if len(f) == 0 or np.linalg.norm(np.ptp(v, 0)) < min_diag:
            continue
        a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
        cooked.append((entry_of.get(mi, 0), v, f, float(np.linalg.norm(np.cross(b - a, c - a), axis=1).sum()) / 2))
    area = sum(c[3] for c in cooked) or 1.0
    verts, faces, cls = [], [], []
    for k, v, f, ar in cooked:
        want = max(12, int(tris * ar / area))
        if len(f) > want * 1.3:
            v, f = fast_simplification.simplify(v, f, target_reduction=1 - want / len(f))
        if len(f) == 0:
            continue
        faces.append(f + sum(len(x) for x in verts))
        verts.append(v)
        cls.append(np.full(len(v), k, dtype=np.uint8))
    return np.vstack(verts).astype(np.float64), np.vstack(faces), np.concatenate(cls), entries


def _components(f, n):
    """Connected component of every vertex (union-find over the triangles)."""
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b, c in f:
        for x, y in ((a, b), (b, c)):
            rx, ry = find(int(x)), find(int(y))
            if rx != ry:
                parent[rx] = ry
    return np.array([find(i) for i in range(n)])


def _perseverance(glb):
    """The rover's body with its suspension, and one wheel; the six wheels are one mesh in the file, cut apart by
    which wheel each triangle is joined to. The body keeps its place in the whole rover's frame (standing on z = 0)
    and the wheels are placed at their hubs, so they can turn and rise with the ground."""
    import fast_simplification

    is_wheel = lambda p, v: "Wheels_objs" in p
    j, blob, ps = parts_named(glb)
    whole = _to_view(np.vstack([v for _m, _p, v, _f in ps]), "+z")
    origin = np.array([(whole[:, 0].min() + whole[:, 0].max()) / 2, (whole[:, 1].min() + whole[:, 1].max()) / 2, whole[:, 2].min()])
    v, f, c, e = nasa_model(glb, 9000, "+z", keep=lambda p, v: not is_wheel(p, v), min_diag=0.04)
    out = {"perseverance-body": write_zcrf("perseverance-body", v, f, c, e, origin)}
    wv, wf = [], []
    for _m, p, vv, ff in ps:
        if is_wheel(p, vv):
            wf.append(ff + sum(len(x) for x in wv))
            wv.append(vv)
    vv, ff = np.vstack(wv), np.vstack(wf)
    comp = _components(ff, len(vv))
    big = [k for k in set(comp) if (comp == k).sum() > len(vv) / 20]
    cen = {k: vv[comp == k].mean(0) for k in big}
    # The wheel nearest the middle of the file's x (the middle wheels sit far out; any one is as good) as the mesh.
    k0 = big[0]
    sel = np.where(comp == k0)[0]
    remap = {int(i): n for n, i in enumerate(sel)}
    fw = np.array([[remap[int(a)] for a in t] for t in ff[comp[ff[:, 0]] == k0]])
    wv2, fw = _clean(_to_view(vv[sel] - cen[k0], "+z"), fw)
    wv2, fw = fast_simplification.simplify(wv2, fw, target_reduction=1 - min(1.0, 900 / len(fw)))
    wheel = write_zcrf("perseverance-wheel", wv2, fw, np.zeros(len(wv2), np.uint8), [((0.45, 0.45, 0.47), 0.5, 30)], None)
    wheel["radius"] = round(float((wv2[:, 2].max() - wv2[:, 2].min()) / 2), 3)
    hubs = [_to_view(c[None], "+z")[0] - origin for c in cen.values()]
    wheel["at"] = [[round(float(x), 3), round(float(y), 3), round(float(z), 3)] for x, y, z in sorted(hubs, key=lambda h: (-h[1], h[0]))]
    out["perseverance-wheel"] = wheel
    return out


def _curiosity(glb):
    """Curiosity: the body (without Blender's helper cubes) and one wheel, the six wheels at their hubs, as the
    Perseverance pair is built; the file's wheels are six separate meshes named wheel_NN_L/R."""
    import fast_simplification

    j, blob, ps = parts_named(glb)
    helper = lambda mi, p, v: j["materials"][mi]["name"] in ("pivot", "shadow2") or len(v) <= 8
    wheel = lambda p: "/wheel_" in p
    real = [(mi, p, v, f) for mi, p, v, f in ps if not helper(mi, p, v)]
    whole = _to_view(np.vstack([v for _m, _p, v, _f in real]), "+z")
    origin = np.array([(whole[:, 0].min() + whole[:, 0].max()) / 2, (whole[:, 1].min() + whole[:, 1].max()) / 2, whole[:, 2].min()])
    pick = lambda w: [(mi, p, v, f) for mi, p, v, f in real if wheel(p) == w]
    v, f, c, e = nasa_model_parts(j, blob, pick(False), 9000, "+z", min_diag=0.04)
    out = {"curiosity-body": write_zcrf("curiosity-body", v, f, c, e, origin)}
    ws = pick(True)
    hubs = [_to_view(vv.mean(0)[None], "+z")[0] - origin for _m, _p, vv, _f in ws]
    mi, p, vv, ff = ws[0]
    wv, fw = _clean(_to_view(vv - vv.mean(0), "+z"), ff)
    wv, fw = fast_simplification.simplify(wv, fw, target_reduction=1 - min(1.0, 900 / len(fw)))
    looks = bcm.material_looks(j, blob)
    rgb = looks[mi]
    wheel_meta = write_zcrf("curiosity-wheel", wv, fw, np.zeros(len(wv), np.uint8), [(rgb[0], rgb[1], rgb[2])], None)
    wheel_meta["radius"] = round(float((wv[:, 2].max() - wv[:, 2].min()) / 2), 3)
    wheel_meta["at"] = [[round(float(x), 3), round(float(y), 3), round(float(z), 3)] for x, y, z in sorted(hubs, key=lambda h: (-h[1], h[0]))]
    out["curiosity-wheel"] = wheel_meta
    return out


def build_nasa(key, src, only):
    meta = {}
    path, credit = NASA[key]
    glb = bcm._fetch(REPO + urllib.parse.quote(path), src, os.path.basename(path))
    if key == "lm":
        # The descent stage: what stayed. Its parts are those whose middle is under the ascent stage's floor.
        v, f, c, e = nasa_model(
            glb, 5200, "+z", keep=lambda p, v: v[:, 1].mean() < 2.05, scale=1.45
        )
        meta["lm"] = write_zcrf("lm", v, f, c, e, "auto")
    elif key == "perseverance":
        meta.update(_perseverance(glb))
    elif key == "curiosity":
        meta.update(_curiosity(glb))
    elif key == "ingenuity":
        v, f, c, e = nasa_model(glb, 3500, "+z")
        meta["ingenuity"] = write_zcrf("ingenuity", v, f, c, e, "auto")
    elif key == "mer":
        v, f, c, e = nasa_model(glb, 3800, "+z", scale=0.21)
        meta["mer"] = write_zcrf("mer", v, f, c, e, "auto")
    elif key == "insight":
        v, f, c, e = nasa_model(glb, 8000, "+z")
        meta["insight"] = write_zcrf("insight", v, f, c, e, "auto")
    elif key == "saturn5":
        v, f, c, e = nasa_model(glb, 6000, "+x", scale=110.6 / 13.0, min_diag=0.5)
        meta["saturn5"] = write_zcrf("saturn5", v, f, c, e, "auto")
    return meta


# ── Models written from dimensions ──
class Mesh:
    """Triangles by palette entry; every primitive is placed by a 4x4 matrix."""

    def __init__(self, palette):
        self.palette = palette
        self.v, self.f, self.c = [], [], []
        self.n = 0

    def add(self, verts, faces, color):
        verts = np.asarray(verts, dtype=np.float64)
        self.v.append(verts)
        self.f.append(np.asarray(faces, dtype=np.int64) + self.n)
        self.c.append(np.full(len(verts), color, dtype=np.uint8))
        self.n += len(verts)

    def box(self, c, size, color, rotz=0.0):
        sx, sy, sz = (s / 2 for s in size)
        v = np.array(
            [
                [x * sx, y * sy, z * sz]
                for z in (-1, 1)
                for y in (-1, 1)
                for x in (-1, 1)
            ]
        )
        f = [
            (0, 1, 3),
            (0, 3, 2),
            (4, 6, 7),
            (4, 7, 5),
            (0, 4, 5),
            (0, 5, 1),
            (2, 3, 7),
            (2, 7, 6),
            (0, 2, 6),
            (0, 6, 4),
            (1, 5, 7),
            (1, 7, 3),
        ]
        self.add(_rot_z(v, rotz) + np.asarray(c), f, color)

    def frustum(self, p0, p1, r0, r1, color, n=12, caps=True):
        """A cylinder or cone from p0 to p1 (radii r0, r1)."""
        p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
        axis = p1 - p0
        ln = np.linalg.norm(axis)
        a = axis / ln
        u = np.cross(a, [0, 0, 1.0] if abs(a[2]) < 0.99 else [1.0, 0, 0])
        u /= np.linalg.norm(u)
        w = np.cross(a, u)
        ang = np.linspace(0, 2 * np.pi, n, endpoint=False)
        ring = lambda p, r: np.array(
            [p + r * (math.cos(t) * u + math.sin(t) * w) for t in ang]
        )
        v = np.vstack([ring(p0, r0), ring(p1, r1), [p0], [p1]])
        f = []
        for i in range(n):
            j = (i + 1) % n
            f += [(i, j, n + j), (i, n + j, n + i)]
            if caps:
                f += [(2 * n, j, i), (2 * n + 1, n + i, n + j)]
        self.add(v, f, color)

    def cyl(self, c, r, h, color, n=12, axis="z"):
        c = np.asarray(c, float)
        d = {"z": [0, 0, h / 2], "x": [h / 2, 0, 0], "y": [0, h / 2, 0]}[axis]
        self.frustum(c - d, c + d, r, r, color, n)

    def sphere(self, c, r, color, nlat=6, nlon=10, scale=(1, 1, 1), zmin=-1.0):
        """An ellipsoid (r times scale), cut off below zmin (a fraction of its height) when only the top is wanted."""
        v, f = [], []
        lats = [
            la
            for la in np.linspace(-np.pi / 2, np.pi / 2, nlat + 1)
            if math.sin(la) >= zmin - 1e-9
        ]
        for la in lats:
            for lo in np.linspace(0, 2 * np.pi, nlon, endpoint=False):
                v.append(
                    [
                        r * scale[0] * math.cos(la) * math.cos(lo),
                        r * scale[1] * math.cos(la) * math.sin(lo),
                        r * scale[2] * math.sin(la),
                    ]
                )
        for i in range(len(lats) - 1):
            for j in range(nlon):
                a, b = i * nlon + j, i * nlon + (j + 1) % nlon
                f += [(a, b, b + nlon), (a, b + nlon, a + nlon)]
        self.add(np.array(v) + np.asarray(c), f, color)

    def quad(self, p, color):
        self.add(p, [(0, 1, 2), (0, 2, 3)], color)

    def tube(self, p0, p1, r, color, n=6):
        self.frustum(p0, p1, r, r, color, n, caps=False)

    def dish(self, c, r, normal, color, depth=0.15, n=14):
        """A shallow dish facing `normal` from c."""
        nrm = np.asarray(normal, float)
        nrm /= np.linalg.norm(nrm)
        self.frustum(
            np.asarray(c) - nrm * depth * r,
            np.asarray(c),
            r * 0.1,
            r,
            color,
            n,
            caps=False,
        )

    def write(self, name):
        v = np.vstack(self.v)
        return write_zcrf(
            name, v, np.vstack(self.f), np.concatenate(self.c), self.palette
        )


def _rot_z(v, a):
    c, s = math.cos(a), math.sin(a)
    return v @ np.array([[c, s, 0], [-s, c, 0], [0, 0, 1]])


ALU = ((0.55, 0.55, 0.56), 0.35, 30)
GOLD = ((0.62, 0.42, 0.08), 1.4, 70)
WHITE = ((0.8, 0.8, 0.78), 0.2, 16)
DARK = ((0.06, 0.06, 0.07), 0.25, 18)
PANEL = ((0.04, 0.07, 0.2), 1.0, 80)
GREY = ((0.32, 0.32, 0.33), 0.25, 20)
RED = ((0.55, 0.05, 0.08), 0.1, 10)
BLUE = ((0.06, 0.1, 0.4), 0.1, 10)
BLACK = ((0.02, 0.02, 0.025), 0.1, 10)


def m_flag():
    m = Mesh([ALU, RED, ((0.85, 0.85, 0.85), 0.05, 8), BLUE])
    m.tube((0, 0, 0), (0, 0, 2.2), 0.012, 0)
    m.tube((-0.05, 0, 2.1), (1.5, 0, 2.1), 0.01, 0)
    w, h, y = 1.52, 0.91, 0.03
    top, n = 2.08, 13
    for i in range(n):
        z1, z0 = top - h * i / n, top - h * (i + 1) / n
        m.quad([(0, y, z0), (w, y, z0), (w, y, z1), (0, y, z1)], 1 if i % 2 == 0 else 2)
    m.quad(
        [
            (0, y + 0.002, top - h * 7 / n),
            (w * 0.4, y + 0.002, top - h * 7 / n),
            (w * 0.4, y + 0.002, top),
            (0, y + 0.002, top),
        ],
        3,
    )
    return m.write("flag")


def m_flag_cn():
    m = Mesh([ALU, RED, ((0.9, 0.7, 0.05), 0.1, 10)])
    m.tube((0, 0, 0), (0, 0, 1.4), 0.012, 0)
    m.quad([(0, 0.02, 0.8), (1.2, 0.02, 0.8), (1.2, 0.02, 1.4), (0, 0.02, 1.4)], 1)
    m.quad(
        [
            (0.08, 0.022, 1.15),
            (0.25, 0.022, 1.15),
            (0.25, 0.022, 1.32),
            (0.08, 0.022, 1.32),
        ],
        2,
    )
    return m.write("flag-cn")


def _wheel(m, c, r, w, color, hub):
    m.cyl(c, r, w, color, n=16, axis="x")
    m.cyl(c, r * 0.35, w * 1.15, hub, n=8, axis="x")


def m_lrv_body():
    m = Mesh([ALU, GOLD, DARK, WHITE])
    m.box((0, 0, 0.62), (1.7, 3.0, 0.1), 0)  # the chassis floor
    for sx in (-1, 1):
        m.tube((sx * 0.85, -1.4, 0.62), (sx * 0.85, 1.4, 0.62), 0.04, 0)
        for sy in (-1.1, 1.1):
            m.tube(
                (sx * 0.85, sy, 0.62), (sx * 0.95, sy, 0.41), 0.035, 0
            )  # the wheel arms, to the hub height
            m.box((sx * 0.9, sy, 0.8), (0.28, 0.9, 0.04), 0)  # fenders
        m.box((sx * 0.38, -0.1, 0.75), (0.5, 0.5, 0.05), 3)  # a seat
        m.box((sx * 0.38, -0.34, 1.0), (0.5, 0.06, 0.5), 3)
    m.box((0, 1.15, 0.85), (1.3, 0.55, 0.38), 1)  # front: batteries under their blanket
    m.box((0, -1.2, 0.85), (1.2, 0.5, 0.34), 1)  # rear: electronics
    m.tube((0, 0.5, 0.62), (0, 0.5, 1.15), 0.03, 0)  # the control post
    m.box((0, 0.5, 1.17), (0.28, 0.1, 0.08), 2)
    m.tube((0, 1.3, 1.0), (0, 1.3, 1.55), 0.02, 0)  # the dish's mast
    m.dish((0, 1.3, 1.55), 0.41, (0, 0.5, 0.85), 3, depth=0.3)
    m.tube((0.55, 1.5, 1.0), (0.55, 1.5, 1.35), 0.015, 0)  # a whip
    return m.write("lrv-body")


def m_lrv_wheel():
    m = Mesh([GREY, ALU])
    m.cyl((0, 0, 0), 0.41, 0.23, 0, n=20, axis="x")
    m.cyl((0, 0, 0), 0.12, 0.3, 1, n=8, axis="x")
    return m.write("lrv-wheel")


def m_lunokhod_body():
    m = Mesh([ALU, GOLD, WHITE, DARK])
    # The bathtub: wide at the top, narrow at the bottom; the lid open behind it, its solar panel facing the Sun.
    v = []
    for z, hx, hy in ((0.45, 0.6, 1.1), (1.0, 0.95, 1.5)):
        v += [(-hx, -hy, z), (hx, -hy, z), (hx, hy, z), (-hx, hy, z)]
    f = [
        (0, 1, 5),
        (0, 5, 4),
        (1, 2, 6),
        (1, 6, 5),
        (2, 3, 7),
        (2, 7, 6),
        (3, 0, 4),
        (3, 4, 7),
        (0, 2, 1),
        (0, 3, 2),
    ]
    m.add(v, f, 2)
    m.box((0, -0.2, 1.05), (1.9, 3.0, 0.08), 2)  # the rim
    lid = [
        (-0.95, -1.5, 1.07),
        (0.95, -1.5, 1.07),
        (0.95, -2.15, 2.1),
        (-0.95, -2.15, 2.1),
    ]
    m.quad(lid, 3)
    m.quad([(x, y, z + 0.01) for x, y, z in reversed(lid)], 0)
    m.box((0, 1.65, 1.2), (1.4, 0.5, 0.3), 1)  # the front, cameras on it
    for sx in (-0.4, 0.4):
        m.box((sx, 1.95, 1.3), (0.12, 0.12, 0.12), 3)
    m.tube((0.7, 0.3, 1.05), (0.7, 0.3, 1.9), 0.015, 0)  # the whip
    m.tube((-0.5, 0.9, 1.05), (-0.5, 0.9, 1.5), 0.03, 0)
    m.dish((-0.5, 0.9, 1.5), 0.3, (0.3, 0.3, 0.9), 0, depth=0.5)
    for sx in (-1, 1):  # the wheel frames
        m.tube((sx * 0.9, -1.5, 0.7), (sx * 1.1, -1.5, 0.255), 0.04, 0)
        m.tube((sx * 0.9, 1.5, 0.7), (sx * 1.1, 1.5, 0.255), 0.04, 0)
        m.tube((sx * 1.1, -1.5, 0.255), (sx * 1.1, 1.5, 0.255), 0.04, 0)
    return m.write("lunokhod-body")


def m_lunokhod_wheel():
    m = Mesh([GREY, ALU])
    m.cyl((0, 0, 0), 0.255, 0.2, 0, n=14, axis="x")
    m.cyl((0, 0, 0), 0.09, 0.26, 1, n=8, axis="x")
    return m.write("lunokhod-wheel")


def m_change_lander():
    """Chang'e 3 / 4 / 5 and the Tianwen-1 platform: a cabin on four splayed legs, a ramp, a dish and a panel."""
    m = Mesh([GOLD, ALU, PANEL, WHITE, DARK])
    m.box((0, 0, 1.45), (1.9, 1.9, 1.2), 0)
    for sx in (-1, 1):
        for sy in (-1, 1):
            m.tube((sx * 0.85, sy * 0.85, 1.0), (sx * 2.1, sy * 2.1, 0.12), 0.07, 1)
            m.tube((sx * 0.85, sy * 0.85, 1.9), (sx * 1.7, sy * 1.2, 0.9), 0.04, 1)
            m.cyl((sx * 2.1, sy * 2.1, 0.06), 0.28, 0.12, 1, n=10)
    m.box((0, 0, 2.1), (2.2, 1.2, 0.08), 2)  # the top panel
    m.quad(
        [(-0.4, 0.95, 1.1), (0.4, 0.95, 1.1), (0.4, 2.7, 0.0), (-0.4, 2.7, 0.0)], 3
    )  # the ramp
    m.tube((0.6, -0.6, 2.1), (0.6, -0.6, 2.7), 0.03, 1)
    m.dish((0.6, -0.6, 2.7), 0.35, (0, -0.3, 1), 3)
    m.box((-0.7, -0.96, 1.6), (0.5, 0.06, 0.4), 4)
    return m.write("change-lander")


def m_yutu():
    """Yutu and Yutu-2: 1.5 m, six wheels, a panel lid tilted to the Sun, a mast."""
    m = Mesh([ALU, GOLD, PANEL, GREY, DARK])
    m.box((0, 0, 0.55), (1.0, 1.4, 0.4), 1)
    lid = [
        (-0.7, -0.65, 0.78),
        (0.7, -0.65, 0.78),
        (0.7, 0.55, 1.15),
        (-0.7, 0.55, 1.15),
    ]
    m.quad(lid, 2)
    m.tube((0, 0.5, 0.75), (0, 0.5, 1.5), 0.02, 0)
    m.box((0, 0.5, 1.55), (0.22, 0.12, 0.1), 4)
    m.tube((0, 0.7, 0.45), (0, 1.15, 0.3), 0.03, 0)  # the arm
    for sx in (-1, 1):
        for sy in (-0.55, 0, 0.55):
            m.tube((sx * 0.5, sy, 0.6), (sx * 0.62, sy, 0.15), 0.025, 0)
            m.cyl((sx * 0.62, sy, 0.15), 0.15, 0.1, 3, n=10, axis="x")
    return m.write("yutu")


def m_zhurong():
    """Zhurong: 1.85 m tall, six wheels, four panels in a butterfly on top, a mast with the cameras."""
    m = Mesh([ALU, GOLD, PANEL, GREY, DARK])
    m.box((0, 0, 0.7), (0.9, 1.1, 0.4), 1)
    for sx in (-1, 1):
        for sy in (-1, 1):
            m.quad([(sx * 0.1, sy * 0.05, 1.0), (sx * 1.25, sy * 0.05, 1.45), (sx * 1.25, sy * 0.95, 1.45), (sx * 0.1, sy * 0.95, 1.0)], 2)
    m.tube((0, 0.3, 0.9), (0, 0.3, 1.85), 0.025, 0)
    m.box((0, 0.3, 1.9), (0.3, 0.1, 0.1), 4)
    for sx in (-1, 1):
        for sy in (-0.5, 0, 0.5):
            m.tube((sx * 0.45, sy, 0.7), (sx * 0.62, sy, 0.15), 0.03, 0)
            m.cyl((sx * 0.62, sy, 0.15), 0.15, 0.1, 3, n=10, axis="x")
    return m.write("zhurong")


def m_pad_slab():
    """The concrete of the pad, flat on the ground (it throws no shadow of its own)."""
    m = Mesh([((0.62, 0.62, 0.6), 0.1, 8)])
    m.box((10, 0, 0.15), (150, 120, 0.3), 0)
    return m.write("pad-slab")


def m_pad39a():
    """Launch Complex 39A as Apollo 11 left it: the pad, the mobile launcher with the Saturn V's place on it at the
    origin (its top is 5 m up), and the 122 m launch umbilical tower with its swing arms and the crane on top."""
    m = Mesh([((0.55, 0.55, 0.52), 0.1, 8), ((0.25, 0.25, 0.27), 0.2, 12), ((0.7, 0.7, 0.72), 0.2, 12), ((0.6, 0.12, 0.1), 0.2, 12), ((0.05, 0.05, 0.05), 0.1, 8)])
    m.box((0, 0, 2.6), (36, 36, 4.8), 1)  # the mobile launcher's deck
    for sx in (-1, 1):
        for sy in (-1, 1):
            m.box((sx * 14, sy * 14, 0.9), (4, 4, 1.4), 1)  # its pedestals
    m.box((0, 0, 5.05), (20, 20, 0.3), 4)  # the exhaust opening, black
    tx = 29.0
    for sx in (-1, 1):
        for sy in (-1, 1):
            m.tube((tx + sx * 5.5, sy * 5.5, 4.8), (tx + sx * 5.5, sy * 5.5, 122), 0.45, 2)
    for k in range(0, 14):
        z = 5 + k * 9
        m.box((tx, 0, z), (12.2, 12.2, 0.3), 2)
        if k < 13:
            m.tube((tx - 5.5, -5.5, z), (tx + 5.5, -5.5, z + 9), 0.15, 2, n=4)
            m.tube((tx + 5.5, 5.5, z), (tx - 5.5, 5.5, z + 9), 0.15, 2, n=4)
    for z in (22, 34, 46, 58, 70, 82, 94, 104, 112):  # the swing arms, out to the rocket
        m.tube((tx - 5.5, 0, z), (4.5, 0, z), 0.55, 2, n=4)
    m.box((tx, 0, 125), (16, 3, 3), 3)  # the crane
    m.tube((tx, 0, 122), (tx, 0, 134), 0.3, 3)
    return m.write("pad39a")


def m_viking():
    m = Mesh([GOLD, ALU, GREY, WHITE, DARK])
    m.cyl((0, 0, 0.95), 0.95, 0.45, 1, n=6)  # the hexagonal body
    for k in range(3):
        a = math.radians(90 + 120 * k)
        ca, sa = math.cos(a), math.sin(a)
        m.tube((0.7 * ca, 0.7 * sa, 0.9), (1.75 * ca, 1.75 * sa, 0.1), 0.05, 1)
        m.tube((0.45 * ca, 0.45 * sa, 1.1), (1.55 * ca, 1.55 * sa, 0.35), 0.03, 1)
        m.cyl((1.75 * ca, 1.75 * sa, 0.04), 0.3, 0.08, 1, n=10)
    for sx in (-1, 1):  # the two RTG wind screens
        m.frustum((sx * 0.55, 0.5, 1.35), (sx * 0.55, 0.9, 1.35), 0.28, 0.28, 3, n=10)
    m.tube((-0.45, -0.7, 1.15), (-0.45, -0.7, 2.2), 0.03, 1)  # the dish mast
    m.dish((-0.45, -0.7, 2.25), 0.37, (0.4, 0.4, 0.6), 3)
    m.tube((0.3, -0.6, 1.15), (0.3, -0.6, 2.0), 0.03, 1)
    m.box((0.3, -0.6, 2.05), (0.3, 0.14, 0.12), 4)  # the cameras
    m.tube((0.4, 0.3, 1.15), (1.6, 2.9, 1.2), 0.025, 2)  # the sampler boom
    m.tube((-0.7, 0.2, 1.15), (-1.8, 0.9, 1.9), 0.02, 2)  # the weather boom
    m.box((0, 0.6, 1.25), (0.6, 0.4, 0.15), 0)
    return m.write("viking")


def m_pathfinder():
    """The lander opened: a tetrahedron's four petals flat, the cells up."""
    m = Mesh([ALU, PANEL, WHITE, DARK])
    s = 1.2
    m.quad(
        [
            (-s, -s * 0.7, 0.3),
            (s, -s * 0.7, 0.3),
            (s, s * 0.9, 0.3),
            (-s, s * 0.9, 0.3),
        ],
        1,
    )
    for k in range(3):
        a = math.radians(90 + 120 * k)
        ca, sa = math.cos(a), math.sin(a)
        cx, cy = 0.55 * ca, 0.55 * sa
        pa, pb = (-sa, ca), (ca, sa)
        m.quad(
            [
                (cx + pa[0] * 0.9, cy + pa[1] * 0.9, 0.34),
                (cx - pa[0] * 0.9, cy - pa[1] * 0.9, 0.34),
                (cx - pa[0] * 0.5 + pb[0] * 1.5, cy - pa[1] * 0.5 + pb[1] * 1.5, 0.06),
                (cx + pa[0] * 0.5 + pb[0] * 1.5, cy + pa[1] * 0.5 + pb[1] * 1.5, 0.06),
            ],
            1,
        )
    m.box((0, 0, 0.65), (0.7, 0.7, 0.6), 2)
    m.tube((0.15, 0.15, 0.95), (0.15, 0.15, 1.7), 0.02, 0)  # the camera mast
    m.box((0.15, 0.15, 1.75), (0.28, 0.1, 0.12), 3)
    m.dish((-0.2, -0.1, 1.05), 0.28, (-0.4, -0.2, 1), 0)
    return m.write("pathfinder")


def m_sojourner():
    m = Mesh([ALU, PANEL, GOLD, GREY, DARK])
    m.box((0, 0, 0.19), (0.48, 0.65, 0.2), 2)
    m.quad(
        [
            (-0.24, -0.32, 0.3),
            (0.24, -0.32, 0.3),
            (0.24, 0.32, 0.3),
            (-0.24, 0.32, 0.3),
        ],
        1,
    )
    for sx in (-1, 1):
        for sy in (-0.28, 0, 0.28):
            m.tube((sx * 0.24, sy, 0.19), (sx * 0.27, sy, 0.065), 0.01, 0)
            m.cyl((sx * 0.27, sy, 0.065), 0.065, 0.06, 3, n=8, axis="x")
    m.tube((0, -0.25, 0.3), (0, -0.25, 0.5), 0.01, 0)
    return m.write("sojourner")


def m_phoenix():
    m = Mesh([ALU, PANEL, GOLD, GREY, WHITE])
    m.cyl((0, 0, 1.0), 0.75, 0.12, 0, n=8)  # the deck
    for k in range(3):
        a = math.radians(90 + 120 * k)
        ca, sa = math.cos(a), math.sin(a)
        m.tube((0.5 * ca, 0.5 * sa, 1.0), (1.35 * ca, 1.35 * sa, 0.08), 0.045, 3)
        m.cyl((1.35 * ca, 1.35 * sa, 0.03), 0.2, 0.06, 3, n=8)
    for sx in (-1, 1):  # the two circular arrays, open
        m.frustum((sx * 1.7, 0, 1.13), (sx * 1.7, 0, 1.15), 1.05, 1.05, 1, n=18)
        m.tube((sx * 0.7, 0, 1.08), (sx * 1.3, 0, 1.12), 0.03, 3)
    m.box((0, 0.2, 1.25), (0.7, 0.5, 0.3), 2)
    m.tube((-0.3, -0.4, 1.05), (-0.3, -0.4, 2.0), 0.025, 3)
    m.box((-0.3, -0.4, 2.05), (0.3, 0.1, 0.1), 3)
    m.tube((0.5, 0.45, 1.15), (1.2, 1.4, 1.0), 0.04, 3)  # the arm, out
    m.tube((1.2, 1.4, 1.0), (2.1, 2.05, 0.4), 0.035, 3)
    m.box((2.15, 2.1, 0.33), (0.15, 0.2, 0.1), 3)
    return m.write("phoenix")


def m_huygens():
    m = Mesh([GOLD, ALU, DARK, WHITE])
    m.sphere(
        (0, 0, 0.27), 0.65, 0, nlat=8, nlon=14, scale=(1, 1, 0.45), zmin=-0.2
    )  # the lens-shaped probe
    m.cyl((0, 0, 0.58), 0.45, 0.05, 1, n=14)
    m.tube((0.2, 0.1, 0.6), (0.2, 0.1, 1.05), 0.02, 1)
    m.dish((0.2, 0.1, 1.05), 0.2, (0, 0, 1), 3)
    m.box((-0.3, 0.2, 0.68), (0.3, 0.25, 0.15), 2)
    m.tube((-0.5, -0.1, 0.45), (-0.75, -0.2, 0.9), 0.015, 1)
    return m.write("huygens")


def m_venera():
    m = Mesh([ALU, GOLD, DARK, WHITE])
    m.frustum(
        (0, 0, 0.12), (0, 0, 0.3), 1.05, 0.9, 0, n=20
    )  # the ring that cushioned the landing
    m.sphere((0, 0, 0.55), 0.46, 1, nlat=8, nlon=14, zmin=-0.7)
    m.cyl((0, 0, 0.98), 0.32, 0.3, 0, n=12)
    m.frustum((0, 0, 1.13), (0, 0, 1.55), 0.32, 0.05, 3, n=12)  # the antenna cone
    for k in range(3):
        a = math.radians(30 + 120 * k)
        m.box((0.42 * math.cos(a), 0.42 * math.sin(a), 0.6), (0.12, 0.12, 0.12), 2)
    return m.write("venera")


def m_surveyor():
    m = Mesh([ALU, WHITE, PANEL, DARK, GOLD])
    m.tube((0, 0, 0.9), (0, 0, 2.5), 0.07, 0, n=8)
    for k in range(3):
        a = math.radians(90 + 120 * k)
        ca, sa = math.cos(a), math.sin(a)
        m.tube((0.1 * ca, 0.1 * sa, 1.0), (1.55 * ca, 1.55 * sa, 0.05), 0.04, 0)
        m.cyl((1.55 * ca, 1.55 * sa, 0.03), 0.22, 0.06, 0, n=8)
        m.tube((0.05 * ca, 0.05 * sa, 1.9), (1.0 * ca, 1.0 * sa, 0.45), 0.02, 0)
    m.cyl((0, 0, 2.95), 0.5, 0.06, 2, n=6)
    m.tube((0, 0, 2.5), (0, 0, 2.95), 0.05, 0)
    m.box((0.3, 0.2, 1.25), (0.5, 0.3, 0.4), 4)
    m.box((-0.3, -0.1, 1.3), (0.4, 0.3, 0.45), 1)
    m.box((0, 0.2, 2.35), (0.16, 0.16, 0.16), 3)  # the camera
    return m.write("surveyor")


PROCEDURAL = {
    "flag": m_flag,
    "flag-cn": m_flag_cn,
    "lrv-body": m_lrv_body,
    "lrv-wheel": m_lrv_wheel,
    "lunokhod-body": m_lunokhod_body,
    "lunokhod-wheel": m_lunokhod_wheel,
    "change-lander": m_change_lander,
    "yutu": m_yutu,
    "pad39a": m_pad39a,
    "pad-slab": m_pad_slab,
    "zhurong": m_zhurong,
    "viking": m_viking,
    "pathfinder": m_pathfinder,
    "sojourner": m_sojourner,
    "phoenix": m_phoenix,
    "huygens": m_huygens,
    "venera": m_venera,
    "surveyor": m_surveyor,
}
# Where each rover's wheels are, in its body's frame (the two procedural rovers; Perseverance's come from its file).
WHEEL_AT = {
    "lrv-body": (
        [(sx * 0.915, sy, 0.41) for sy in (1.15, -1.15) for sx in (-1, 1)],
        0.41,
    ),
    "lunokhod-body": (
        [(sx * 1.1, sy, 0.255) for sy in (-1.5, -0.5, 0.5, 1.5) for sx in (-1, 1)],
        0.255,
    ),
}


def dump_compact(data):
    """The sites file with one model, rover or site to a line: short enough to read and to review."""
    out = ["{"]
    keys = list(data)
    for n, k in enumerate(keys):
        v = data[k]
        tail = "," if n < len(keys) - 1 else ""
        if isinstance(v, dict):
            rows = ["  %s: %s" % (json.dumps(a), json.dumps(b, separators=(",", ":"))) for a, b in v.items()]
            out.append("%s: {\n%s\n }%s" % (json.dumps(k), ",\n".join(rows), tail))
        elif isinstance(v, list):
            rows = ["  " + json.dumps(r, separators=(",", ":"), ensure_ascii=False) for r in v]
            out.append("%s: [\n%s\n ]%s" % (json.dumps(k), ",\n".join(rows), tail))
        else:
            out.append("%s: %s%s" % (json.dumps(k), json.dumps(v), tail))
    out.append("}")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--src", default="")
    a = ap.parse_args()
    want = set(filter(None, a.only.split(",")))
    meta = {}
    for key in NASA:
        if not want or key in want or any(w.startswith(key) for w in want):
            print(key)
            meta.update(build_nasa(key, a.src, want))
    for key, fn in PROCEDURAL.items():
        if not want or key in want:
            print(key)
            meta[key] = fn()
    for key, (at, r) in WHEEL_AT.items():
        if key in meta:
            meta[key]["wheels"] = {"at": [list(c) for c in at], "radius": r}
    if os.path.exists(SITES):
        with open(SITES) as fh:
            data = json.load(fh)
    else:
        data = {"version": 1, "models": {}, "sites": []}
    data["models"].update(meta)
    with open(SITES, "w") as fh:
        fh.write(dump_compact(data))


if __name__ == "__main__":
    main()
