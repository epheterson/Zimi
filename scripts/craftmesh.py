"""Mesh plumbing for the spacecraft the 3D view shows (scripts/build_craft_models.py, scripts/build_craft_hd.py).

Reading a NASA 3D Resources glTF (Draco or plain buffers) into world-space parts with their normals and UVs,
welding and creased smooth normals (a hard edge stays hard, a cylinder reads round), octahedral normals, the
material's physical look (roughness, metalness) from its name and colour, and the "ZCR2" file both the stock craft
and the Almanac HD craft are written in.

ZCR2, little-endian (the viewer's _aeCraftParse reads it):
    "ZCR2", uint32 version 2, float32 metres per unit, float32 box lo xyz and hi xyz (units), float32 the pointing
    axis xyz, float32 a second axis across it, uint32 palette entries, uint32 vertices, uint32 triangles,
    uint32 flags (bit 0: per-vertex UVs, bit 1: textures named below), float32 turning axis x, y (the ISS's arrays
    turn about the truss: it is where their pivot is), uint32 turning class (255: none);
    per palette entry: float32 r, g, b (linear), uint8 roughness, metalness, flags (bit 0: double sided,
    bit 1: alpha cut-out), 0, int16 colour texture, int16 normal texture, int16 metal-rough texture, int16 0;
    if flags bit 1: uint16 count, then each texture's file name (uint8 length, bytes);
    per vertex: int16 x, y, z quantized to the box, int8 octahedral normal x, y, uint8 palette entry
    (then float32 u, v when flags bit 0); then uint16 (or uint32 past 65,535 vertices) indices, the triangles of each
    entry together.
"""

import io
import json
import struct

import numpy as np

FLAG_UV, FLAG_TEXTURES = 1, 2
MAT_DOUBLE_SIDED, MAT_CUTOUT, MAT_AMBER_BACK = 1, 2, 4  # the last: the side its normals do not face is the amber of a solar array's back
NO_TURN = 255
CREASE_DEG = 38.0


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


def split_glb(glb):
    (cl,) = struct.unpack("<I", glb[12:16])
    j = json.loads(glb[20 : 20 + cl])
    off = 20 + cl
    (bl,) = struct.unpack("<I", glb[off : off + 4])
    return j, glb[off + 8 : off + 8 + bl]


_COMP = {5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def _accessor(j, blob, i):
    a = j["accessors"][i]
    bv = j["bufferViews"][a["bufferView"]]
    dt = np.dtype(_COMP[a["componentType"]])
    nc = _NCOMP[a["type"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride") or dt.itemsize * nc
    if stride == dt.itemsize * nc:
        out = np.frombuffer(blob, dtype=dt, count=a["count"] * nc, offset=off).reshape(
            -1, nc
        )
    else:
        raw = np.frombuffer(blob, dtype=np.uint8, offset=off)
        out = np.stack(
            [
                np.frombuffer(
                    raw[k * stride : k * stride + dt.itemsize * nc].tobytes(), dtype=dt
                )
                for k in range(a["count"])
            ]
        )
    out = out.astype(np.float64) if a.get("normalized") or dt.kind == "f" else out
    return out


def read_parts(glb):
    """(json, blob, [dict(mat, pos, nrm|None, uv|None, faces)]) in the scene's frame, Draco or plain buffers."""
    j, blob = split_glb(glb)
    out = []

    def walk(i, m):
        n = j["nodes"][i]
        m = m @ _mat4(n)
        nm = np.linalg.inv(m[:3, :3]).T
        for p in j["meshes"][n["mesh"]]["primitives"] if "mesh" in n else []:
            ext = (p.get("extensions") or {}).get("KHR_draco_mesh_compression")
            if ext:
                import DracoPy

                bv = j["bufferViews"][ext["bufferView"]]
                o = bv.get("byteOffset", 0)
                d = DracoPy.decode(blob[o : o + bv["byteLength"]])
                pos = np.asarray(d.points, dtype=np.float64)
                nrm = (
                    np.asarray(d.normals, dtype=np.float64)
                    if getattr(d, "normals", None) is not None and len(d.normals)
                    else None
                )
                uv = (
                    np.asarray(d.tex_coord, dtype=np.float64)
                    if getattr(d, "tex_coord", None) is not None and len(d.tex_coord)
                    else None
                )
                faces = np.asarray(d.faces).reshape(-1, 3)
            else:
                at = p["attributes"]
                pos = _accessor(j, blob, at["POSITION"])
                nrm = _accessor(j, blob, at["NORMAL"]) if "NORMAL" in at else None
                uv = (
                    _accessor(j, blob, at["TEXCOORD_0"]) if "TEXCOORD_0" in at else None
                )
                faces = (
                    _accessor(j, blob, p["indices"]).reshape(-1, 3)
                    if "indices" in p
                    else np.arange(len(pos)).reshape(-1, 3)
                ).astype(np.int64)
            if pos.shape[0] == 0 or faces.shape[0] == 0:
                continue
            pos = (np.c_[pos, np.ones(len(pos))] @ m.T)[:, :3]
            if nrm is not None and len(nrm) == len(pos):
                nrm = nrm @ nm.T
                nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
            else:
                nrm = None
            if uv is not None and len(uv) != len(pos):
                uv = None
            out.append(
                dict(mat=p.get("material", 0), pos=pos, nrm=nrm, uv=uv, faces=faces)
            )
        for c in n.get("children", []):
            walk(c, m)

    for r in j["scenes"][j.get("scene", 0)]["nodes"]:
        walk(r, np.eye(4))
    return j, blob, out


def image_bytes(j, blob, index):
    bv = j["bufferViews"][j["images"][index]["bufferView"]]
    o = bv.get("byteOffset", 0)
    return blob[o : o + bv["byteLength"]]


def texture_image_index(j, tex):
    """The image a glTF textureInfo points at (the WebP source when the file has one)."""
    t = j["textures"][tex["index"]]
    return (t.get("extensions", {}).get("EXT_texture_webp") or {}).get(
        "source", t.get("source")
    )


def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def texture_mean(j, blob, tex):
    """A texture's mean colour in linear light (a printed logo never reaches the stock model), or white."""
    from PIL import Image

    try:
        im = (
            Image.open(io.BytesIO(image_bytes(j, blob, texture_image_index(j, tex))))
            .convert("RGB")
            .resize((32, 32))
        )
        return srgb_to_linear(
            np.asarray(im, dtype=np.float64).reshape(-1, 3).mean(0) / 255.0
        )
    except Exception:
        return np.ones(3)


# ── Materials ──
GOLD = (
    0.93,
    0.62,
    0.24,
)  # linear: gold foil (the sRGB 0.97, 0.80, 0.55 of MLI blankets)
SILVER = (0.78, 0.79, 0.82)
SOLAR_BLUE = (0.07, 0.1, 0.3)  # linear: dark blue cells, bright enough to read in sunlight


def look_of(name, rgb, src_rough=None, src_metal=0.0):
    """(rgb, roughness, metalness) for a material: foil, blanket, cell, aluminium, paint, by name first, then source."""
    n = name.lower()
    rgb = np.asarray(rgb, dtype=np.float64)
    if any(s in n for s in ("mirror", "mirr")) and "omni" not in n:
        return np.array(GOLD), 0.1, 1.0
    if "gold" in n and "edge" not in n:
        return np.array(GOLD), 0.3, 1.0
    if any(s in n for s in ("solar", "sacell", "cells", "shiny_panel")):
        return np.array(SOLAR_BLUE), 0.25, 0.2
    if (
        any(s in n for s in ("silver", "alum", "mylar", "omnimirror", "bafl_graphite"))
        and "black" not in n
    ):
        base = rgb if rgb.max() > 0.3 else np.array(SILVER)
        return np.clip(base * 1.05, 0, 1), 0.38, 0.55
    if "krinkle" in n or "kapton" in n or n.startswith("blk") or "black" in n:
        return np.clip(rgb, 0.0, 0.22), 0.42, 0.25
    if any(s in n for s in ("mli", "blanket")):
        return np.clip(rgb, 0, 1), 0.38, 0.55
    if any(s in n for s in ("white", "plastic_white")):
        return np.clip(rgb, 0.0, 0.92), 0.6, 0.0
    r = 0.55 if src_rough is None else float(np.clip(src_rough, 0.15, 0.9))
    return np.clip(rgb, 0, 1), r, float(src_metal)


# ── Geometry ──
def weld(v, f, nd=5):
    """Merge coincident vertices; drop collapsed triangles."""
    v, inv = np.unique(np.asarray(v).round(nd), axis=0, return_inverse=True)
    f = inv.reshape(-1)[f]
    return v, f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]


def face_normals(v, f):
    n = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    return n  # length 2x area: the weight


def creased(v, f, crease_deg=CREASE_DEG, chunk=40000, return_index=False):
    """Split vertices at creases and give each corner the smooth normal of the faces within crease_deg of its own.

    Returns (v2, f2, n2): vertices repeated per distinct normal, faces onto them, unit normals; with return_index, also
    the source vertex of each new one (to carry a per-vertex class along).
    """
    nf = face_normals(v, f)
    area = np.linalg.norm(nf, axis=1)
    un = nf / np.maximum(area[:, None], 1e-18)
    cos_c = np.cos(np.radians(crease_deg))
    nv, nt = len(v), len(f)
    corner_v = f.reshape(-1)
    corner_f = np.repeat(np.arange(nt), 3)
    order = np.argsort(corner_v, kind="stable")
    sv, sf = corner_v[order], corner_f[order]
    starts = np.searchsorted(sv, np.arange(nv + 1))
    deg = np.diff(starts)
    dmax = int(min(deg.max(), 24))
    cn = np.zeros((nt * 3, 3))
    for lo in range(0, nv, chunk):
        hi = min(lo + chunk, nv)
        pad = np.full((hi - lo, dmax), -1, dtype=np.int64)
        for k in range(dmax):
            ok = deg[lo:hi] > k
            pad[ok, k] = sf[starts[lo:hi][ok] + k]
        valid = pad >= 0
        fn = np.where(valid[..., None], un[np.maximum(pad, 0)], 0.0)
        w = np.where(valid, area[np.maximum(pad, 0)], 0.0)
        dots = np.einsum("vid,vjd->vij", fn, fn)
        mask = (dots >= cos_c) & valid[:, None, :] & valid[:, :, None]
        acc = np.einsum("vij,vj,vjd->vid", mask.astype(np.float64), w, fn)
        # write back per corner: the corner of face pad[v, i] at vertex lo+v
        vi, ii = np.nonzero(valid)
        fi = pad[vi, ii]
        verts = lo + vi
        for c in range(3):
            sel = f[fi, c] == verts
            cn[fi[sel] * 3 + c] = acc[vi[sel], ii[sel]]
    cn /= np.maximum(np.linalg.norm(cn, axis=1, keepdims=True), 1e-12)
    code = oct_encode(cn).astype(np.int64)
    key = corner_v * 65536 + (code[:, 0] + 128) * 256 + (code[:, 1] + 128)
    uniq, first, inv = np.unique(key, return_index=True, return_inverse=True)
    out = v[corner_v[first]], inv.reshape(-1, 3), oct_decode(code[first])
    return out + (corner_v[first],) if return_index else out


def oct_encode(n):
    """Unit vectors to int8 octahedral (x, y), ~0.7 degrees."""
    n = np.asarray(n, dtype=np.float64)
    a = n / np.maximum(np.abs(n).sum(1, keepdims=True), 1e-12)
    x, y = a[:, 0].copy(), a[:, 1].copy()
    neg = a[:, 2] < 0
    x[neg] = (1 - np.abs(a[neg, 1])) * np.where(a[neg, 0] >= 0, 1, -1)
    y[neg] = (1 - np.abs(a[neg, 0])) * np.where(a[neg, 1] >= 0, 1, -1)
    return np.clip(np.round(np.c_[x, y] * 127), -127, 127).astype(np.int8)


def oct_decode(e):
    e = np.asarray(e, dtype=np.float64) / 127.0
    z = 1 - np.abs(e[:, 0]) - np.abs(e[:, 1])
    x, y = e[:, 0].copy(), e[:, 1].copy()
    neg = z < 0
    x[neg] = (1 - np.abs(e[neg, 1])) * np.where(e[neg, 0] >= 0, 1, -1)
    y[neg] = (1 - np.abs(e[neg, 0])) * np.where(e[neg, 1] >= 0, 1, -1)
    n = np.c_[x, y, z]
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def pack(
    metres,
    lo,
    hi,
    aim,
    across,
    entries,
    v,
    n,
    cls,
    f,
    uv=None,
    textures=(),
    turn=(0.0, 0.0),
    turn_class=NO_TURN,
):
    """The ZCR2 bytes. entries: [(rgb, rough 0-1, metal 0-1, flags, tex, normal_tex, mr_tex)]; n: unit normals."""
    flags = (FLAG_UV if uv is not None else 0) | (FLAG_TEXTURES if textures else 0)
    head = b"ZCR2" + struct.pack(
        "<If6f3f3f4IffI",
        2,
        metres,
        *lo,
        *hi,
        *aim,
        *across,
        len(entries),
        len(v),
        len(f),
        flags,
        turn[0],
        turn[1],
        turn_class,
    )
    for rgb, rough, metal, fl, t0, t1, t2 in entries:
        head += struct.pack(
            "<3f4B4h",
            *np.clip(rgb, 0, 1),
            int(round(np.clip(rough, 0, 1) * 255)),
            int(round(np.clip(metal, 0, 1) * 255)),
            fl,
            0,
            t0,
            t1,
            t2,
            0,
        )
    if textures:
        head += struct.pack("<H", len(textures))
        for name in textures:
            b = name.encode()
            head += struct.pack("<B", len(b)) + b
    q = np.round(
        (np.asarray(v) - lo) / np.maximum(np.asarray(hi) - lo, 1e-9) * 65534 - 32767
    ).astype(np.int16)
    per = np.zeros(len(v), dtype=[("p", "<i2", 3), ("n", "i1", 2), ("c", "u1")])
    per["p"] = q
    per["n"] = oct_encode(n)
    per["c"] = cls
    body = _interleave(per, uv) if uv is not None else per.tobytes()
    idx = np.asarray(f).astype("<u2" if len(v) <= 65535 else "<u4")
    return head + body + idx.tobytes()


def _interleave(per, uv):
    out = np.zeros(
        len(per),
        dtype=[
            ("p", "<i2", 3),
            ("n", "i1", 2),
            ("c", "u1"),
            ("uv", "<f4", 2),
        ],
    )
    for k in ("p", "n", "c"):
        out[k] = per[k]
    out["uv"] = np.asarray(uv, dtype="<f4")
    return out.tobytes()
