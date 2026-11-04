"""Build zimi/static/earth/iss-v1.bin: the International Space Station as a small mesh for the 3D view.

    python scripts/build_iss_model.py [--glb ISS_B.glb] [--tris 36000]

From NASA 3D Resources, "International Space Station (ISS) (B)" (credit NASA/Michael D. Carbajal; the collection's
README: "These assets are free and without copyright"):
https://science.nasa.gov/3d-resources/international-space-station-iss-b/ . The model carries no textures (so no
logo). Build-time needs: numpy, DracoPy (the file is Draco-compressed) and fast-simplification.

Each material becomes one of five classes the view shades (structure, truss, solar array that turns to the Sun,
radiator, fixed solar array), each simplified on its own to its share of --tris, so the panels keep their edges.
The model's axes are the station's own (LVLH): +y forward along the velocity (the US segment ahead, the Russian
behind), +x toward the Earth (the truss on the zenith side), +z to starboard along the truss.

Format, little-endian: 4 bytes "ZISS", uint32 version 1, float32 metres per unit, float32 the box (min xyz, max xyz,
in units), float32 the arrays' turning axis (a point x, y; the axis is +z), uint32 vertices, uint32 triangles, then
per vertex int16 x, y, z quantized to the box and uint8 class, uint8 pad, then uint16 (or uint32 past 65,535
vertices) indices, the triangles of each class together, ordered by class.
"""

import argparse
import json
import os
import struct
import urllib.request

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "zimi", "static", "earth", "iss-v1.bin")
URL = (
    "https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/model/international-space-station-(iss)-(b)/"
    "International%20Space%20Station%20(ISS)%20(B).glb"
)
# The model's span along the truss, arrays included, is the station's 109 m.
SPAN_M = 109.0
STRUCTURE, TRUSS, ARRAY, RADIATOR, ARRAY_FIXED = range(5)
CLASS_OF = {
    "lambert7SG.001": ARRAY,
    "lambert4SG.001": ARRAY_FIXED,
    "soyuz_blinn4SG.001": RADIATOR,
    "lambert3SG.001": TRUSS,
    "anisotropic1SG.001": TRUSS,
}
SHARE = {STRUCTURE: 0.5, TRUSS: 0.3, ARRAY: 0.08, RADIATOR: 0.06, ARRAY_FIXED: 0.06}
STRAY_Y = 40.0  # seven small cylinders parked far off the station in the source file


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


def parts(glb):
    import DracoPy

    (cl,) = struct.unpack("<I", glb[12:16])
    j = json.loads(glb[20 : 20 + cl])
    off = 20 + cl
    (bl,) = struct.unpack("<I", glb[off : off + 4])
    blob = glb[off + 8 : off + 8 + bl]
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
            out.append(
                (
                    j["materials"][p.get("material", 0)]["name"],
                    v,
                    np.asarray(d.faces).reshape(-1, 3),
                )
            )
        for c in n.get("children", []):
            walk(c, m)

    for r in j["scenes"][0]["nodes"]:
        walk(r, np.eye(4))
    return out


def build(glb, tris):
    import fast_simplification

    by = {}
    for mat, v, f in parts(glb):
        if v[:, 1].min() > STRAY_Y:
            continue
        k = CLASS_OF.get(mat, STRUCTURE)
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
        want = max(64, int(tris * SHARE[k]))
        if len(f) > want:
            v, f = fast_simplification.simplify(
                v, f, target_reduction=1 - want / len(f)
            )
        faces.append(f + sum(len(a) for a in verts))
        verts.append(v)
        cls.append(np.full(len(v), k, dtype=np.uint8))
        print("class %d: %d triangles" % (k, len(f)))
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
    metres = SPAN_M / (hi[2] - lo[2])
    head = b"ZISS" + struct.pack(
        "<If6f2fII", 1, metres, *lo, *hi, *axis, len(v), len(f)
    )
    per = np.zeros(len(v), dtype=[("p", "<i2", 3), ("c", "u1"), ("pad", "u1")])
    per["p"] = q
    per["c"] = c
    idx = f.astype("<u2" if len(v) <= 65535 else "<u4")
    return head + per.tobytes() + idx.tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--glb", help="the model, downloaded already (else fetched from NASA)"
    )
    ap.add_argument("--tris", type=int, default=36000)
    a = ap.parse_args()
    if a.glb:
        with open(a.glb, "rb") as fh:
            glb = fh.read()
    else:
        with urllib.request.urlopen(
            urllib.request.Request(URL, headers={"User-Agent": "Zimi-build/1.0"}),
            timeout=120,
        ) as r:
            glb = r.read()
    data = build(glb, a.tris)
    with open(OUT, "wb") as fh:
        fh.write(data)
    print("%s: %d bytes" % (OUT, len(data)))


if __name__ == "__main__":
    main()
