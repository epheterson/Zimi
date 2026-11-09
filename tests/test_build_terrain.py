"""scripts/build_terrain.py: heights from a source raster to the shipped 256 x 128 map and the Almanac HD tiles.

Synthetic rasters stand in for the downloads (they are hundreds of MB to 2 GB): an uncompressed 16-bit strip file
(the planetary mosaics' layout, read straight off the disk), a raster whose left edge is longitude 0 (Mercury's, rolled
to -180..180), holes filled, the coarse file's header and size, and a tile's 16-bit heights surviving lossless WebP.
"""

import importlib.util
import os
import struct

import pytest

np = pytest.importorskip("numpy")
Image = pytest.importorskip("PIL.Image")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture()
def bt(monkeypatch):
    spec = importlib.util.spec_from_file_location(
        "build_terrain_under_test", os.path.join(ROOT, "scripts", "build_terrain.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "MASTER_W", 64)
    monkeypatch.setattr(mod, "MASTER_H", 32)
    monkeypatch.setattr(mod, "COARSE_W", 16)
    monkeypatch.setattr(mod, "COARSE_H", 8)
    return mod


def _source(tmp_path, raster):
    path = str(tmp_path / "src.tif")
    Image.fromarray(raster.astype(np.uint16)).save(
        path
    )  # uncompressed strips, one 16-bit sample a pixel
    return path


def _use(bt, monkeypatch, path, **spec):
    base = {
        "url": "x",
        "lon0": -180,
        "scale": 1.0,
        "offset": 0.0,
        "nodata": None,
        "shift": 0.0,
    }
    base.update(spec)
    monkeypatch.setitem(bt.SOURCES, "t", base)
    monkeypatch.setattr(bt, "source_path", lambda key, cache, update=False: path)


def test_a_strip_file_is_read_and_averaged_to_the_master(bt, monkeypatch, tmp_path):
    raster = np.tile(
        np.arange(256, dtype=np.uint16) * 10, (128, 1)
    )  # height rises eastward, 10 m a column
    _use(bt, monkeypatch, _source(tmp_path, raster))
    m = bt.master("t", str(tmp_path))
    assert m.shape == (32, 64)
    # Master column 0 averages source columns 0..3 (a 4:1 reduction): 15 m; the last, 2535 m.
    assert m[0, 0] == pytest.approx(15, abs=0.01) and m[-1, -1] == pytest.approx(
        2535, abs=0.01
    )
    assert (np.diff(m[0]) > 0).all()


def test_scale_offset_and_the_reference_shift_apply(bt, monkeypatch, tmp_path):
    raster = np.full((64, 128), 40000, dtype=np.uint16)
    _use(
        bt,
        monkeypatch,
        _source(tmp_path, raster),
        scale=0.5,
        offset=-10000.0,
        shift=300.0,
    )
    assert bt.master("t", str(tmp_path)).mean() == pytest.approx(
        40000 * 0.5 - 10000 + 300
    )


def test_a_picture_that_starts_at_longitude_0_is_turned_to_minus_180(
    bt, monkeypatch, tmp_path
):
    raster = np.zeros((64, 128), dtype=np.uint16)
    raster[:, :32] = 1000  # longitudes 0..90 east
    _use(bt, monkeypatch, _source(tmp_path, raster), lon0=0)
    m = bt.master("t", str(tmp_path))
    east = m[:, 32 + 0 : 32 + 16]  # master columns for longitude 0..90
    assert (east == 1000).all() and (m[:, :32] == 0).all()


def test_holes_are_filled_from_what_is_round_them(bt, monkeypatch, tmp_path):
    raster = np.full((64, 128), 500, dtype=np.uint16)
    raster[:8] = 0  # the polar rows have no data
    _use(bt, monkeypatch, _source(tmp_path, raster), nodata=0)
    m = bt.master("t", str(tmp_path))
    assert (
        np.isfinite(m).all()
        and m.min() == pytest.approx(500)
        and m.max() == pytest.approx(500)
    )


def test_the_shipped_map_has_its_header_and_size(bt):
    m = np.arange(32 * 64, dtype=np.float32).reshape(32, 64) - 1000
    data = bt.coarse_bytes(m)
    assert (
        data[:4] == b"ZTRN"
        and struct.unpack("<BBHH", data[4:10]) == (1, 0, 16, 8)
        and len(data) == 10 + 16 * 8 * 2
    )
    back = np.frombuffer(data, dtype="<i2", offset=10).reshape(8, 16)
    assert back[0, 0] == round(bt.block_mean(m, 16, 8)[0, 0])


def test_a_tile_keeps_its_heights_through_lossless_webp(bt, tmp_path):
    heights = np.linspace(-9000, 21000, 256 * 256).reshape(256, 256)
    path = str(tmp_path / "t.webp")
    bt._save_tile(heights, path)
    px = np.asarray(Image.open(path).convert("RGB")).astype(np.int32)
    got = px[..., 0] * 256 + px[..., 1] - bt.TILE_OFFSET
    assert np.abs(got - np.rint(heights)).max() == 0


def test_the_tile_pyramid_has_every_level(bt, monkeypatch, tmp_path):
    raster = np.tile(np.arange(256, dtype=np.uint16) * 10, (128, 1))
    _use(bt, monkeypatch, _source(tmp_path, raster))
    monkeypatch.setattr(
        bt, "TILE", 8
    )  # tiny tiles: level z holds 2^(z+1) x 2^z of them, 8 px each
    monkeypatch.setattr(bt, "MASTER_W", 8 * 2**3 * 2)
    monkeypatch.setattr(bt, "MASTER_H", 8 * 2**3)
    out = str(tmp_path / "out")
    assert bt.terrain_tiles("t", str(tmp_path), out, max_level=3) == 3
    for z in range(4):
        n = len(
            [
                f
                for _r, _d, fs in os.walk(os.path.join(out, "terrain", "t", str(z)))
                for f in fs
            ]
        )
        assert n == 2 ** (z + 1) * 2**z


def test_the_sources_are_pinned_and_public_domain_bodies_only():
    spec = importlib.util.spec_from_file_location(
        "bt_pins", os.path.join(ROOT, "scripts", "build_terrain.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert set(mod.PINS) == set(mod.SOURCES)
    assert set(mod.SOURCES) == {"earth", "moon", "mars", "venus", "mercury"}
    # Every body with a shipped map is one the view can stand on.
    src = open(
        os.path.join(ROOT, "zimi", "static", "almanac-earth.js"), encoding="utf-8"
    ).read()
    for k in mod.SOURCES:
        assert "'%s'" % k in src.split("var AE_STAND_KEYS = ")[1].split(";")[0]
        assert (
            os.path.getsize(
                os.path.join(ROOT, "zimi", "static", "earth", "terrain-%s-v1.bin" % k)
            )
            == 10 + 256 * 128 * 2
        )


def test_the_land_mask_survives_its_runs_and_the_shipped_file_is_whole():
    spec = importlib.util.spec_from_file_location("bl_under_test", os.path.join(ROOT, "scripts", "build_landmask.py"))
    bl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bl)
    rng = np.random.default_rng(3)
    mask = (rng.random((16, 40)) > 0.6).astype(np.uint8)
    mask[0, :] = 1   # a row that starts on land, and one that is all sea
    mask[1, :] = 0
    assert (bl.decode(bl.encode(mask)) == mask).all()
    shipped = open(os.path.join(ROOT, "zimi", "static", "earth", "land-v1.bin"), "rb").read()
    full = bl.decode(shipped)
    assert full.shape == (bl.HEIGHT, bl.WIDTH) and 0.28 < full.mean() < 0.38
    assert full[int((90 - 38.5) / 180 * bl.HEIGHT), int((180 - 98) / 360 * bl.WIDTH)] == 1   # Kansas
