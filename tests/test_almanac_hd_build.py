"""Almanac HD's build script cuts a world's mosaic into the tile pyramid the 3D view reads: from a small fixture, a
0-360 picture is rolled to -180..180, a greyscale one takes its colour from the small map, and the levels are the
ones the manifest says.

Run: pytest tests/test_almanac_hd_build.py -v
"""

import os
import sys

import pytest

sys.path.insert(
    0,
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"
    ),
)

import build_almanac_hd as hd  # noqa: E402

PIL = pytest.importorskip("PIL.Image")
np = pytest.importorskip("numpy")
from PIL import Image  # noqa: E402

DARK, LIGHT = 50, 200


def _fixture(tmp_path, name="world.tif"):
    """1024 x 512 grey: the western half of the 0-360 map (longitudes 0-180) light, the rest dark."""
    cache = tmp_path / "cache"
    (cache / "files").mkdir(parents=True)
    im = Image.new("L", (1024, 512), DARK)
    im.paste(LIGHT, (0, 0, 512, 512))
    im.save(cache / "files" / name)
    return str(cache)


def _build(monkeypatch, tmp_path, spec, layer="planets/testworld"):
    cache = _fixture(tmp_path)
    monkeypatch.setitem(
        hd.LAYERS, layer, dict(spec, file="https://example.invalid/world.tif", mode="L")
    )
    out = str(tmp_path / "stage")
    top = hd.build_layer(layer, cache, out, update=True, procs=1)
    return layer, out, top


def _mean(out, layer, z, x, y):
    with Image.open(hd.tile_path(out, layer, z, x, y)) as t:
        return float(np.asarray(t.convert("L")).mean())


def test_a_picture_that_runs_0_to_360_is_rolled_to_minus_180_to_180(
    monkeypatch, tmp_path
):
    layer, out, top = _build(monkeypatch, tmp_path, {"max": 1, "roll": True})
    assert top == 1
    # Longitudes 0-180 (the source's left, light) are the pyramid's right half.
    assert _mean(out, layer, 0, 0, 0) == pytest.approx(DARK, abs=3)
    assert _mean(out, layer, 0, 1, 0) == pytest.approx(LIGHT, abs=3)


def test_a_picture_already_minus_180_to_180_is_left_alone(monkeypatch, tmp_path):
    layer, out, _ = _build(monkeypatch, tmp_path, {"max": 1})
    assert _mean(out, layer, 0, 0, 0) == pytest.approx(LIGHT, abs=3)
    assert _mean(out, layer, 0, 1, 0) == pytest.approx(DARK, abs=3)


def test_every_level_down_to_the_max_is_cut_and_nothing_past_it(monkeypatch, tmp_path):
    layer, out, top = _build(monkeypatch, tmp_path, {"max": 2})
    for z in range(top + 1):
        for x in range(2 ** (z + 1)):
            for y in range(2**z):
                assert os.path.exists(hd.tile_path(out, layer, z, x, y)), (z, x, y)
    assert not os.path.exists(hd.tile_path(out, layer, top + 1, 0, 0))
    with Image.open(hd.tile_path(out, layer, top, 0, 0)) as t:
        assert t.size == (hd.TILE, hd.TILE)


def test_a_grey_picture_takes_its_colour_from_the_small_map_and_keeps_its_own_brightness(
    monkeypatch, tmp_path
):
    from PIL import Image as I

    tint = tmp_path / "small.png"
    I.new("RGB", (64, 32), (200, 100, 100)).save(tint)
    layer = "planets/testworld"
    cache = _fixture(tmp_path)
    monkeypatch.setitem(
        hd.LAYERS,
        layer,
        {"file": "https://example.invalid/world.tif", "mode": "L", "max": 0},
    )
    # The layer's tint is read from the view's earth folder: point it at the fixture.
    monkeypatch.setattr(hd, "EARTH_DIR", str(tmp_path))
    hd.LAYERS[layer]["tint"] = "small.png"
    out = str(tmp_path / "stage")
    hd.build_layer(layer, cache, out, update=True, procs=1)
    with Image.open(hd.tile_path(out, layer, 0, 1, 0)) as t:
        r, g, b = np.asarray(t.convert("RGB"), dtype=float).reshape(-1, 3).mean(axis=0)
    # Red leads, as in the small map; the brightness (the luma) is the picture's, DARK, not the small map's.
    assert r > g * 1.5 and g == pytest.approx(b, abs=3)
    assert 0.299 * r + 0.587 * g + 0.114 * b == pytest.approx(DARK, abs=6)


def test_a_mosaic_finer_than_the_deepest_level_is_reduced_once_and_cut_from_that(
    monkeypatch, tmp_path
):
    layer, out, _ = _build(monkeypatch, tmp_path, {"max": 0, "prescale": True})
    # The cache holds the reduced picture (the deepest level's width), and the tiles come from it.
    reduced = [
        f
        for f in os.listdir(tmp_path / "cache" / "files")
        if f.startswith("testworld-")
    ]
    assert len(reduced) == 1
    with Image.open(tmp_path / "cache" / "files" / reduced[0]) as r:
        assert r.size == (hd.TILE * 2, hd.TILE)
    assert _mean(out, layer, 0, 0, 0) == pytest.approx(LIGHT, abs=3)


def test_an_elevation_model_becomes_shaded_relief_grey_where_flat(tmp_path):
    tifffile = pytest.importorskip("tifffile")
    dem = np.zeros((64, 128), dtype=np.int16)
    dem[:, 60:68] = np.arange(8, dtype=np.int16) * 100  # a ramp facing east
    path = tmp_path / "dem.tif"
    tifffile.imwrite(str(path), dem)
    out = hd.shaded_map(str(path), str(tmp_path / "shade.png"), 128, 470000)
    with Image.open(out) as im:
        a = np.asarray(im, dtype=float)
    flat = a[10, 10]
    assert flat == pytest.approx(255 * hd.SHADE_BASE, abs=2)
    assert abs(a[32, 63] - flat) > 5  # the ramp reads as a slope, not as flat ground


def test_every_world_has_a_pinned_public_domain_source():
    for key in (
        "mercury",
        "venus",
        "mars",
        "io",
        "europa",
        "ganymede",
        "callisto",
        "titan",
        "pluto",
        "charon",
        "triton",
        "mimas",
        "enceladus",
        "tethys",
        "dione",
        "rhea",
        "iapetus",
        "vesta",
        "phobos",
        "ceres",
    ):
        layer = "planets/" + key
        assert layer in hd.PINS and len(hd.PINS[layer]) == 64
        assert hd.LAYERS[layer]["file"].startswith(
            "https://planetarymaps.usgs.gov/mosaic/"
        )
    assert hd.LAYERS["moon/albedo"]["file"].startswith(
        "https://planetarymaps.usgs.gov/mosaic/"
    )
    # Only the gas giants come from elsewhere, and are credited.
    elsewhere = {
        k for k, v in hd.LAYERS.items() if "solarsystemscope" in v.get("file", "")
    }
    assert elsewhere == {"planets/jupiter", "planets/saturn"}
def test_every_layer_belongs_to_the_core_or_to_one_part():
    for layer in hd.LAYERS:
        assert hd.part_of(layer + "/") in ("", *hd.PARTS), layer
    assert hd.part_of("moon/albedo/3/1/2.webp") == "moon"
    assert hd.part_of("planets/mars/5/0/0.webp") == "mars"
    assert hd.part_of("planets/marsX/0/0/0.webp") == ""
    assert hd.part_of("earth/day/0/0/0.webp") == ""


def test_a_native_map_is_cut_from_windows_of_the_memory_map(tmp_path):
    import numpy as np
    from PIL import Image

    pic = (np.arange(64 * 128).reshape(64, 128) % 251).astype(np.uint8)
    src = tmp_path / "w.png"
    Image.fromarray(pic).save(src)
    npy = hd.native_map(str(src), "L", str(tmp_path / "w.npy"))
    mapped = hd.FileMosaic(npy, "L")
    plain = hd.FileMosaic(str(src), "L")
    a = np.asarray(mapped.window(-180.0, 90.0, 90.0), dtype=float)
    b = np.asarray(plain.window(-180.0, 90.0, 90.0), dtype=float)
    assert a.shape == b.shape == (hd.TILE, hd.TILE)
    assert np.abs(a - b).mean() < 1.5


def test_a_flat_mosaic_gets_its_tone_back_and_keeps_its_detail(tmp_path):
    import numpy as np
    from PIL import Image

    rng = np.random.default_rng(1)
    pic = np.clip(128 + rng.normal(0, 12, (64, 128)), 0, 255).astype(np.uint8)
    src = tmp_path / "flat.png"
    Image.fromarray(pic).save(src)
    tone = {"lo": 100, "hi": 140, "dark": (60, 40, 30), "light": (210, 210, 205)}
    out = np.asarray(
        hd.FileMosaic(str(src), "L", finish={"tone": tone}).window(-180.0, 90.0, 90.0),
        dtype=float,
    )
    assert out.shape[2] == 3
    assert 50 < out[..., 0].mean() < 215 and out[..., 0].std() > 2


def test_unmapped_black_is_filled_from_the_mapped_colour_beside_it(tmp_path):
    import numpy as np
    from PIL import Image

    pic = np.zeros((64, 128, 3), np.uint8)
    pic[32:] = (90, 100, 80)
    src = tmp_path / "gap.png"
    Image.fromarray(pic).save(src)
    out = np.asarray(
        hd.FileMosaic(str(src), "RGB", finish={"fill": True}).whole(256), dtype=float
    )
    assert out[:40].min() > 20  # the unmapped top is no longer black
    assert abs(out[-1, 5, 1] - 100) < 4  # the mapped part is untouched
