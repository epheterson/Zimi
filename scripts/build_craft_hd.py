"""Build the Almanac HD craft: NASA's own full models, with their textures, for the 3D view's close-ups.

    python scripts/build_craft_hd.py [--only voyager,webb] [--src DIR] [--out DIR]

Each craft the stock build (scripts/build_craft_models.py) draws from a decimated, flat-coloured mesh is here the
original NASA 3D Resources glTF, its triangles untouched (up to MAX_TRIS: past that, simplified part by part), one mesh
to a material with that material's roughness and metalness, its textures re-encoded as WebP (at most TEXTURE_MAX
pixels a side). The model is brought into the stock model's frame (its units, its axes: the pointing and across axes
and the size the viewer already knows), by registering the two shapes on each other, so a craft turns the same way
whichever is drawn. Files, in --out (the folder the Almanac HD ZIM carries as hd/craft/, scripts/build_almanac_maxi.py):

    index.json            { "models": { <key>: { "file", "tris", "bytes", "credit" } } }
    <key>.zcr2            the model (scripts/craftmesh.py: ZCR2 with UVs and the texture names)
    <key>-<n>.webp        its textures

No Draco or meshopt in the browser: the vertices are quantized (16 bits a position, 8 a normal) and the ZIM compresses
the file, which is what those would buy. All models are NASA 3D Resources ("free and without copyright", the
collection's terms); each page's credit line is in CREDITS and zimi/static/earth/SOURCES.txt.
"""

import argparse
import io
import json
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_craft_models as bcm  # noqa: E402
import craftmesh as cm  # noqa: E402

ROOT = bcm.ROOT
EARTH = bcm.EARTH
MAX_TRIS = 260000
TEXTURE_MAX = 2048
WEBP_QUALITY = 88
REG_SAMPLES = 20000
REG_ITERS = 40
REG_TRIM = 0.85  # the closest share of points that count in a registration (the rest are what only one model has)

# key: (file in the repo's 3D Models folder, the page's Source credit, the stock file's source in bcm.CRAFT or None)
HD = {
    "voyager": (
        "Voyager Probe (B)/Voyager Probe (B).glb",
        "NASA/Christopher R. Meaney",
    ),
    "pioneer": ("Pioneer 10/Pioneer 10.glb", "NASA/JPL/Eyes on the Solar System"),
    "juno": ("Juno (A)/Juno (A).glb", "NASA/JPL-Caltech"),
    "parker": ("Parker Solar Probe/Parker Solar Probe.glb", "NASA/Matthew J. Garcia"),
    "webb": (
        "James Webb Space Telescope (A)/James Webb Space Telescope (A).glb",
        "NASA/Christopher R. Meaney",
    ),
    "galileo": ("Galileo/Galileo.glb", "NASA/JPL/Solar System Simulator"),
    "cassini": (
        "Cassini-Huygens (A)/Cassini-Huygens (A).glb",
        "NASA/JPL/Solar System Simulator",
    ),
}
# Colours the source gets wrong (linear), as the stock build corrects them: key -> {material substring: rgb}.
RECOLOUR = {
    "galileo": {"bus:black": (0.01, 0.01, 0.012)},
    "parker": {"black matte": (0.7, 0.7, 0.66)},
}


# ── Registration ──
def read_stock(path):
    """The stock ZCR2's vertices (its source's units) and header: (points, aim, across, metres)."""
    b = open(path, "rb").read()
    metres = struct.unpack_from("<f", b, 8)[0]
    lo = np.array(struct.unpack_from("<3f", b, 12))
    hi = np.array(struct.unpack_from("<3f", b, 24))
    aim = np.array(struct.unpack_from("<3f", b, 36))
    across = np.array(struct.unpack_from("<3f", b, 48))
    npal, nv, nt, flags = struct.unpack_from("<4I", b, 60)
    o = 88 + 24 * npal
    if flags & cm.FLAG_TEXTURES:
        raise ValueError("a stock model has no textures")
    stride = 9 + (8 if flags & cm.FLAG_UV else 0)
    raw = np.frombuffer(b, dtype=np.uint8, count=nv * stride, offset=o).reshape(
        nv, stride
    )
    q = np.ascontiguousarray(raw[:, :6]).view("<i2").reshape(nv, 3).astype(np.float64)
    return lo + (q + 32767) / 65534 * (hi - lo), aim, across, metres


def _umeyama(a, b):
    """The similarity (s, R, t) taking points a onto points b, least squares."""
    ma, mb = a.mean(0), b.mean(0)
    ac, bc = a - ma, b - mb
    u, d, vt = np.linalg.svd(bc.T @ ac / len(a))
    s = np.eye(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        s[2, 2] = -1
    r = u @ s @ vt
    scale = np.trace(np.diag(d) @ s) / ac.var(0).sum()
    return scale, r, mb - scale * r @ ma


def _chamfer(a, b, tree_b, tree_a, trim=REG_TRIM):
    da = np.sort(tree_b.query(a)[0])
    db = np.sort(tree_a.query(b)[0])
    ka, kb = max(1, int(len(da) * trim)), max(1, int(len(db) * trim))
    return da[:ka].mean() + db[:kb].mean()


def _rotations():
    """The 24 proper rotations of the cube (signed axis permutations)."""
    out = []
    for perm in ([0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]):
        for sg in np.ndindex(2, 2, 2):
            m = np.zeros((3, 3))
            for i, p in enumerate(perm):
                m[i, p] = 1 if sg[i] == 0 else -1
            if np.linalg.det(m) > 0:
                out.append(m)
    return out


def register(src, dst):
    """(scale, R, t) putting the point set src into the frame and units of dst: principal axes first (the best of the
    24 axis orientations by chamfer distance), then iterated closest points."""
    from scipy.spatial import cKDTree

    rng = np.random.default_rng(1)
    a = src[rng.choice(len(src), min(len(src), REG_SAMPLES), replace=False)]
    b = dst[rng.choice(len(dst), min(len(dst), REG_SAMPLES), replace=False)]
    ma, mb = a.mean(0), b.mean(0)
    _, va = np.linalg.eigh(np.cov((a - ma).T))
    _, vb = np.linalg.eigh(np.cov((b - mb).T))
    s0 = np.sqrt(b.var(0).sum() / a.var(0).sum())
    tree_a, tree_b = cKDTree(a), cKDTree(b)
    best = None
    for p in _rotations():
        r = vb @ p @ va.T
        x = s0 * (a - ma) @ r.T + mb
        c = _chamfer(x, b, tree_b, cKDTree(x))
        if best is None or c < best[0]:
            best = (c, r)
    s, r, t = s0, best[1], mb - s0 * best[1] @ ma
    for _ in range(REG_ITERS):
        x = s * a @ r.T + t
        d, i = tree_b.query(x)
        keep = d <= np.quantile(d, REG_TRIM)
        s, r, t = _umeyama(a[keep], b[i[keep]])
    err = _chamfer(s * a @ r.T + t, b, tree_b, cKDTree(s * a @ r.T + t))
    return s, r, t, err / (np.ptp(b, 0).max() or 1)


# ── Textures ──
def webp_bytes(data, linear=False):
    from PIL import Image

    im = Image.open(io.BytesIO(data))
    im.load()
    if max(im.size) > TEXTURE_MAX:
        k = TEXTURE_MAX / max(im.size)
        im = im.resize(
            (max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS
        )
    im = im.convert(
        "RGBA"
        if im.mode in ("RGBA", "LA", "P")
        and "transparency" in im.info
        or im.mode in ("RGBA", "LA")
        else "RGB"
    )
    out = io.BytesIO()
    im.save(out, "WEBP", quality=WEBP_QUALITY, method=6)
    return out.getvalue(), im.mode == "RGBA"


# ── The model ──
def build(key, glb, stock_path, recolour=None):
    j, blob, ps = cm.read_parts(glb)
    mats = j.get("materials") or [{}]
    stock_pts, _aim, _across, _metres = read_stock(stock_path)
    verts = np.vstack([p["pos"] for p in ps])
    s, r, t, err = register(verts, stock_pts)
    print("  registered: scale %.4f, residual %.3f of the span" % (s, err))
    textures, tex_name, files = [], {}, {}

    def texture(info, kind):
        if info is None:
            return -1
        img = cm.texture_image_index(j, info)
        if (img, kind) not in tex_name:
            data, _alpha = webp_bytes(cm.image_bytes(j, blob, img))
            name = "%s-%d.webp" % (key, len(textures))
            files[name] = data
            textures.append(name)
            tex_name[(img, kind)] = len(textures) - 1
        return tex_name[(img, kind)]

    used = sorted({p["mat"] for p in ps})
    entry_of = {m: k for k, m in enumerate(used)}
    entries = []
    for m in used:
        mat = mats[m] if m < len(mats) else {}
        pbr = mat.get("pbrMetallicRoughness", {})
        rgb = np.array(pbr.get("baseColorFactor", [1, 1, 1, 1])[:3], dtype=np.float64)
        name = mat.get("name", "")
        for sub, real in (recolour or {}).items():
            if sub.lower() in name.lower():
                rgb = np.array(real, dtype=np.float64)
        tex = texture(pbr.get("baseColorTexture"), "c")
        mr = texture(pbr.get("metallicRoughnessTexture"), "mr")
        _rgb, rough, metal = cm.look_of(
            name,
            rgb if tex < 0 else np.ones(3),
            pbr.get("roughnessFactor"),
            pbr.get("metallicFactor", 0.0),
        )
        entries.append(
            (
                _rgb if tex < 0 else rgb,
                rough,
                metal,
                cm.MAT_DOUBLE_SIDED
                | (cm.MAT_CUTOUT if mat.get("alphaMode") == "MASK" else 0),
                tex,
                -1,
                mr,
            )
        )
    total = sum(len(p["faces"]) for p in ps)
    scale_tris = min(1.0, MAX_TRIS / total)
    V, N, UV, C, F = [], [], [], [], []
    base = 0
    for m in used:
        mine = [p for p in ps if p["mat"] == m]
        pos = np.vstack([p["pos"] for p in mine])
        fs, off = [], 0
        for p in mine:
            fs.append(p["faces"] + off)
            off += len(p["pos"])
        f = np.vstack(fs)
        has_uv = all(p["uv"] is not None for p in mine)
        has_n = all(p["nrm"] is not None for p in mine)
        pos = s * pos @ r.T + t
        if scale_tris < 1.0 and not has_uv:
            v2, f2 = bcm.simplified(pos, f, max(40, int(len(f) * scale_tris)), 5)
            v2, f2, n2 = cm.creased(v2, f2)
            uv2 = None
        else:
            v2, f2, uv2 = (
                pos,
                f,
                (np.vstack([p["uv"] for p in mine]) if has_uv else None),
            )
            if has_n:
                n2 = np.vstack([p["nrm"] for p in mine]) @ r.T
            else:
                v2, f2, n2 = cm.creased(v2, f2)
                uv2 = None if uv2 is None else uv2
        V.append(v2)
        N.append(n2)
        UV.append(uv2 if uv2 is not None else np.zeros((len(v2), 2)))
        C.append(np.full(len(v2), entry_of[m], dtype=np.uint8))
        F.append(f2 + base)
        base += len(v2)
    v, n, uv, c, f = (
        np.vstack(V),
        np.vstack(N),
        np.vstack(UV),
        np.concatenate(C),
        np.vstack(F),
    )
    lo, hi = v.min(0), v.max(0)
    order = np.argsort(c[f[:, 0]], kind="stable")
    f = f[order]
    data = cm.pack(
        1.0, lo, hi, (0, 0, 1), (1, 0, 0), entries, v, n, c, f, uv=uv, textures=textures
    )
    print(
        "  %d triangles, %d vertices, %d materials, %d textures, %d KB"
        % (len(f), len(v), len(entries), len(textures), len(data) // 1024)
    )
    return data, files, len(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma-separated keys (default all)")
    ap.add_argument(
        "--src", help="a folder with the downloaded files under their own names"
    )
    ap.add_argument(
        "--stock",
        default=EARTH,
        help="where the stock models are (their frame is the target)",
    )
    ap.add_argument(
        "--out", required=True, help="the folder to write (hd/craft/ in the ZIM)"
    )
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    keys = a.only.split(",") if a.only else list(HD)
    index = {}
    idx_path = os.path.join(a.out, "index.json")
    if os.path.exists(idx_path):
        index = json.load(open(idx_path))["models"]
    for key in keys:
        print(key)
        path, credit = HD[key]
        glb = bcm._fetch(
            bcm.REPO + bcm.urllib.parse.quote(path), a.src, os.path.basename(path)
        )
        data, files, tris = build(
            key, glb, os.path.join(a.stock, "craft-%s-v1.bin" % key), RECOLOUR.get(key)
        )
        with open(os.path.join(a.out, key + ".zcr2"), "wb") as fh:
            fh.write(data)
        for name, blob in files.items():
            with open(os.path.join(a.out, name), "wb") as fh:
                fh.write(blob)
        index[key] = {
            "file": key + ".zcr2",
            "tris": tris,
            "bytes": len(data) + sum(len(b) for b in files.values()),
            "credit": credit,
        }
    with open(idx_path, "w") as fh:
        json.dump({"models": index}, fh, indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
