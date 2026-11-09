"""Build the Almanac HD craft: NASA's own full models, with their textures, for the 3D view's close-ups.

    python scripts/build_craft_hd.py [--only voyager,webb] [--src DIR] [--out DIR]

Each craft the stock build (scripts/build_craft_models.py) draws from a decimated, flat-coloured mesh is here the
original NASA 3D Resources glTF, its triangles untouched (up to MAX_TRIS: past that, simplified part by part), one mesh
to a material with that material's roughness and metalness, its textures re-encoded as WebP (at most TEXTURE_MAX
pixels a side). It is the very file the stock model is made from (bcm.CRAFT), so its frame, its pointing and across
axes and its size are the stock model's, and a craft turns the same way whichever is drawn. Files, in --out (the folder the Almanac HD ZIM carries as hd/craft/, scripts/build_almanac_maxi.py):

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
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_craft_models as bcm  # noqa: E402
import craftmesh as cm  # noqa: E402

MAX_TRIS = 260000
TEXTURE_MAX = 2048
WEBP_QUALITY = 88


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
def build(key, glb, recolour=None):
    j, blob, ps = cm.read_parts(glb)
    mats = j.get("materials") or [{}]
    # Same file as the stock model: its frame, units, pointing and size are this model's own.
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
                n2 = np.vstack([p["nrm"] for p in mine])
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


def build_iss(glb):
    """The station at every triangle, in the stock model's five classes (the main arrays turn about the truss)."""
    j, _blob, ps = cm.read_parts(glb)
    by = {}
    for p in ps:
        if p["pos"][:, 1].min() > bcm.ISS_STRAY_Y:
            continue
        by.setdefault(bcm.ISS_CLASS_OF.get(j["materials"][p["mat"]]["name"], bcm.STRUCTURE), []).append(p)
    V, N, C, F, base = [], [], [], [], 0
    for k in sorted(by):
        pos = np.vstack([p["pos"] for p in by[k]])
        offs = np.cumsum([0] + [len(p["pos"]) for p in by[k]])[:-1]
        f = np.vstack([p["faces"] + o for p, o in zip(by[k], offs)])
        if all(p["nrm"] is not None for p in by[k]):
            n = np.vstack([p["nrm"] for p in by[k]])
        else:
            pos, f, n = cm.creased(pos, f)
        V.append(pos)
        N.append(n)
        C.append(np.full(len(pos), k, dtype=np.uint8))
        F.append(f + base)
        base += len(pos)
    v, n, c, f = np.vstack(V), np.vstack(N), np.concatenate(C), np.vstack(F)
    lo, hi = v.min(0), v.max(0)
    arr = v[c == bcm.ARRAY]
    axis = ((arr[:, 0].min() + arr[:, 0].max()) / 2, (arr[:, 1].min() + arr[:, 1].max()) / 2)
    entries = [(rgb, rough, metal, cm.MAT_DOUBLE_SIDED, -1, -1, -1) for rgb, rough, metal in bcm.ISS_LOOK]
    print("  %d triangles, %d vertices" % (len(f), len(v)))
    data = cm.pack(1.0, lo, hi, (0, 0, 0), (0, 0, 0), entries, v, n, c, f, turn=axis, turn_class=bcm.ARRAY)
    return data, {}, len(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma-separated keys (default all)")
    ap.add_argument(
        "--src", help="a folder with the downloaded files under their own names"
    )
    ap.add_argument(
        "--out", required=True, help="the folder to write (hd/craft/ in the ZIM)"
    )
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    keys = a.only.split(",") if a.only else ["iss", *bcm.CRAFT]
    index = {}
    idx_path = os.path.join(a.out, "index.json")
    if os.path.exists(idx_path):
        index = json.load(open(idx_path))["models"]
    for key in keys:
        print(key)
        if key == "iss":
            path, credit = "International Space Station (ISS) (B).glb", "NASA/Michael D. Carbajal"
            data, files, tris = build_iss(bcm._fetch(bcm.ISS_URL, a.src, path))
        else:
            path, credit = bcm.CRAFT[key][:2]
            glb = bcm._fetch(bcm.REPO + bcm.urllib.parse.quote(path), a.src, os.path.basename(path))
            data, files, tris = build(key, glb, bcm.RECOLOUR.get(key))
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
