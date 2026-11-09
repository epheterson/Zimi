"""The spacecraft models of the 3D view: the stock tier's files and budgets, and the mesh plumbing that builds them.

The stock craft ship in the app (zimi/static/earth/), so their size is a budget; the Almanac HD tier (full NASA models
with textures, scripts/build_craft_hd.py) is a ZIM's and has none. Run: pytest tests/test_craft_models.py -v
"""

import math
import os
import struct
import sys

import pytest

np = pytest.importorskip("numpy")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH = os.path.join(ROOT, "zimi", "static", "earth")
sys.path.append(os.path.join(ROOT, "scripts"))
import craftmesh as cm  # noqa: E402

STOCK = ["iss", "voyager", "pioneer", "juno", "parker", "webb", "galileo", "cassini"]
MAX_PALETTE = 12  # the viewer's AE_CRAFT_PAL
# What one stock model may be, and what all of them together may be (raw bytes; they travel gzipped).
MAX_TRIS = {"iss": 30000, "webb": 16000}
MAX_TRIS_DEFAULT = 12000
MAX_TOTAL_BYTES = 2_000_000
MAX_NORMAL_ERR_DEG = 1.5


def _path(key):
    return os.path.join(
        EARTH, "iss-v1.bin" if key == "iss" else "craft-%s-v1.bin" % key
    )


def _read(key):
    b = open(_path(key), "rb").read()
    assert b[:4] == b"ZCR2"
    npal, nv, nt, flags = struct.unpack_from("<4I", b, 60)
    return b, npal, nv, nt, flags


@pytest.mark.parametrize("key", STOCK)
def test_stock_model_is_zcr2_within_budget(key):
    b, npal, nv, nt, flags = _read(key)
    assert 1 <= npal <= MAX_PALETTE
    assert nt <= MAX_TRIS.get(key, MAX_TRIS_DEFAULT), "%s has %d triangles" % (key, nt)
    assert (
        not flags & cm.FLAG_TEXTURES
    ), "a stock model has no textures (they are the HD tier's)"
    stride = 9 + (8 if flags & cm.FLAG_UV else 0)
    o = 88 + 24 * npal
    isize = 2 if nv <= 65535 else 4
    assert len(b) == o + nv * stride + nt * 3 * isize
    # Every normal decodes to a unit vector and every class and index is in range.
    raw = np.frombuffer(b, dtype=np.uint8, count=nv * stride, offset=o).reshape(
        nv, stride
    )
    n = cm.oct_decode(np.ascontiguousarray(raw[:, 6:8]).view("i1"))
    assert np.allclose(np.linalg.norm(n, axis=1), 1.0, atol=1e-6)
    assert raw[:, 8].max() < npal
    idx = np.frombuffer(
        b, dtype="<u2" if isize == 2 else "<u4", count=nt * 3, offset=o + nv * stride
    )
    assert idx.max() < nv


@pytest.mark.parametrize("key", STOCK)
def test_stock_materials_are_physical(key):
    b, npal, *_ = _read(key)
    for i in range(npal):
        r, g, bl, rough, metal, flags, _z, tex, ntex, mr, _p = struct.unpack_from(
            "<3f4B4h", b, 88 + 24 * i
        )
        assert 0 <= min(r, g, bl) and max(r, g, bl) <= 1
        assert (
            rough >= 0.05 * 255
        ), "a perfectly smooth surface reflects nothing but a mirror"
        assert (tex, ntex, mr) == (-1, -1, -1)


def test_stock_total_stays_where_it_was():
    total = sum(os.path.getsize(_path(k)) for k in STOCK)
    assert total <= MAX_TOTAL_BYTES, "the stock craft are %d bytes" % total


def test_stock_axes_are_unit_and_across_the_aim():
    for key in STOCK[1:]:
        b = open(_path(key), "rb").read()
        aim = np.array(struct.unpack_from("<3f", b, 36))
        across = np.array(struct.unpack_from("<3f", b, 48))
        assert (
            abs(np.linalg.norm(aim) - 1) < 1e-4
            and abs(np.linalg.norm(across) - 1) < 1e-4
        )
        assert abs(aim @ across) < 1e-3, key


def test_iss_turns_its_arrays_about_the_truss():
    b = open(_path("iss"), "rb").read()
    turn_class = struct.unpack_from("<I", b, 84)[0]
    assert turn_class == 2  # the main arrays
    npal, nv = struct.unpack_from("<2I", b, 60)
    o = 88 + 24 * npal
    raw = np.frombuffer(b, dtype=np.uint8, count=nv * 9, offset=o).reshape(nv, 9)
    assert (raw[:, 8] == turn_class).any()


# ── The plumbing ──
def _cube():
    v = np.array(
        [[x, y, z] for x in (0, 1) for y in (0, 1) for z in (0, 1)], dtype=np.float64
    )
    f = []
    for a, b, c, d in (
        (0, 1, 3, 2),
        (4, 6, 7, 5),
        (0, 4, 5, 1),
        (2, 3, 7, 6),
        (0, 2, 6, 4),
        (1, 5, 7, 3),
    ):
        f += [[a, b, c], [a, c, d]]
    return v, np.array(f)


def test_creased_keeps_a_cube_hard_and_a_sphere_smooth():
    v, f = _cube()
    v2, f2, n2 = cm.creased(v, f)
    assert (
        len(v2) == 24
    )  # three faces meet at a corner at 90 degrees: three normals, not one
    assert np.allclose(np.abs(n2).max(1), 1.0, atol=0.02)
    # A sphere: the vertices stay shared, every normal points out from the centre.
    n_lat, n_lon = 12, 24
    pts, tris = [[0, 0, 1]], []
    for i in range(1, n_lat):
        th = math.pi * i / n_lat
        for j in range(n_lon):
            ph = 2 * math.pi * j / n_lon
            pts.append(
                [math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)]
            )
    pts.append([0, 0, -1])
    pts = np.array(pts)
    for j in range(n_lon):
        tris.append([0, 1 + j, 1 + (j + 1) % n_lon])
    for i in range(n_lat - 2):
        for j in range(n_lon):
            a, b = 1 + i * n_lon + j, 1 + i * n_lon + (j + 1) % n_lon
            c, d = a + n_lon, b + n_lon
            tris += [[a, c, b], [b, c, d]]
    last = len(pts) - 1
    for j in range(n_lon):
        tris.append(
            [
                last,
                1 + (n_lat - 2) * n_lon + (j + 1) % n_lon,
                1 + (n_lat - 2) * n_lon + j,
            ]
        )
    sv, sf, sn = cm.creased(pts, np.array(tris))
    assert len(sv) <= len(pts) * 1.2
    cosines = (
        sn * sv / np.maximum(np.linalg.norm(sv, axis=1, keepdims=True), 1e-9)
    ).sum(1)
    assert cosines.min() > math.cos(math.radians(8))


def test_octahedral_normals_round_trip_within_a_degree_and_a_half():
    rng = np.random.default_rng(3)
    n = rng.normal(size=(5000, 3))
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    back = cm.oct_decode(cm.oct_encode(n))
    err = np.degrees(np.arccos(np.clip((n * back).sum(1), -1, 1)))
    assert err.max() < MAX_NORMAL_ERR_DEG


def test_pack_round_trips_vertices_normals_uvs_and_textures():
    v, f = _cube()
    v2, f2, n2 = cm.creased(v, f)
    uv = np.c_[v2[:, 0], v2[:, 1]]
    entries = [((0.2, 0.3, 0.4), 0.5, 0.0, cm.MAT_DOUBLE_SIDED, 0, -1, 1)]
    data = cm.pack(
        2.0,
        v2.min(0),
        v2.max(0),
        (0, 0, 1),
        (1, 0, 0),
        entries,
        v2,
        n2,
        np.zeros(len(v2), np.uint8),
        f2,
        uv=uv,
        textures=["a.webp", "b.webp"],
    )
    assert data[:4] == b"ZCR2"
    npal, nv, nt, flags = struct.unpack_from("<4I", data, 60)
    assert (npal, nv, nt) == (1, 24, 12) and flags == cm.FLAG_UV | cm.FLAG_TEXTURES
    o = 88 + 24
    (count,) = struct.unpack_from("<H", data, o)
    assert count == 2
    names, o = [], o + 2
    for _ in range(count):
        n = data[o]
        names.append(data[o + 1 : o + 1 + n].decode())
        o += 1 + n
    assert names == ["a.webp", "b.webp"]
    assert len(data) == o + nv * 17 + nt * 6


MAX_ALL_MODELS_BYTES = 2_800_000  # probes, the station and the landing sites' models together (they were 2.1 MB)


def test_every_model_in_the_app_is_zcr2_and_the_total_is_bounded():
    paths = [os.path.join(EARTH, n) for n in os.listdir(EARTH) if (n.startswith("craft-") or n == "iss-v1.bin") and n.endswith(".bin")]
    assert len(paths) >= 40
    for p in paths:
        with open(p, "rb") as f:
            assert f.read(4) == b"ZCR2", os.path.basename(p)
    assert sum(os.path.getsize(p) for p in paths) <= MAX_ALL_MODELS_BYTES
