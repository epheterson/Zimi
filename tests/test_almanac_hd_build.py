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


def test_the_new_worlds_have_a_pinned_public_domain_source():
    for key in ("mercury", "io", "europa", "ganymede", "callisto", "titan", "pluto"):
        layer = "planets/" + key
        assert layer in hd.PINS and len(hd.PINS[layer]) == 64
        assert hd.LAYERS[layer]["file"].startswith(
            "https://planetarymaps.usgs.gov/mosaic/"
        )
