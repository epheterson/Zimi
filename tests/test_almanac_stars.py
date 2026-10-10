"""The star catalogue behind the Almanac's 3D Earth view.

zimi/static/earth/stars-v1.bin is the Yale Bright Star Catalogue packed by
scripts/build_star_catalog.py. The rules under test:

  - the converter's format round-trips within its stated steps, and the line
    parser reads the catalogue's fixed columns;
  - the shipped asset is the size and count it should be, brightest first, and
    every star is a real position and a naked-eye-or-near magnitude;
  - well-known stars are where the catalogue puts them;
  - the asset has a credit line in static/earth/SOURCES.txt.

The decoding in the browser is tests/test_almanac_stars.cjs.

Run: pytest tests/test_almanac_stars.py -v
"""

import importlib.util
import os

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET = os.path.join(ROOT, "zimi", "static", "earth", "stars-v1.bin")
SOURCES = os.path.join(ROOT, "zimi", "static", "earth", "SOURCES.txt")

# BSC5 has 9,110 entries; 14 (novae, non-stellar objects) carry no position.
STAR_COUNT = 9096
MAX_BYTES = 100 * 1024
RA_STEP_H = 24.0 / 65536
DEC_STEP_DEG = 180.0 / 65535
MAG_STEP = 1 / 25
BV_STEP = 1 / 50


@pytest.fixture(scope="module")
def conv():
    spec = importlib.util.spec_from_file_location(
        "build_star_catalog", os.path.join(ROOT, "scripts", "build_star_catalog.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def stars(conv):
    with open(ASSET, "rb") as f:
        return conv.unpack(f.read())


def test_round_trip_within_the_stated_steps(conv):
    src = [
        (0.0, -90.0, -1.46, -0.03),
        (6.752477, -16.716116, -1.46, 0.0),
        (23.999, 90.0, 7.9, None),
        (12.5, 0.0, 3.21, 1.99),
    ]
    out = conv.unpack(conv.pack(src))
    assert len(out) == len(src)
    by_mag = sorted(src, key=lambda s: s[2])  # pack() writes brightest first
    for (ra, dec, mag, bv), (ra2, dec2, mag2, bv2) in zip(by_mag, out):
        assert abs(ra - ra2) <= RA_STEP_H
        assert abs(dec - dec2) <= DEC_STEP_DEG
        assert abs(mag - mag2) <= MAG_STEP / 2 + 1e-9
        if bv is None:
            assert bv2 is None
        else:
            assert abs(bv - bv2) <= BV_STEP / 2 + 1e-9


def test_header_and_length(conv):
    data = conv.pack([(1.0, 2.0, 3.0, 0.5), (4.0, 5.0, 6.0, None)])
    assert data[:4] == bytes([2, 0, conv.FORMAT_VERSION, 0])
    assert len(data) == 4 + 6 * 2


def test_parse_line_reads_the_fixed_columns(conv):
    # Sirius, HR 2491: the J2000 fields sit at 1-based columns 76-90, V at
    # 103-107, B-V at 110-114.
    line = list(" " * 197)
    line[75:90] = "064508.9-164258"
    line[102:107] = "-1.46"
    line[109:114] = "-0.05"
    line = "".join(line)
    ra, dec, vmag, bv = conv.parse_line(line)
    assert ra == pytest.approx(6 + 45 / 60 + 8.9 / 3600)
    assert dec == pytest.approx(-(16 + 42 / 60 + 58 / 3600))
    assert vmag == -1.46 and bv == -0.05


def test_parse_line_skips_entries_with_no_position(conv):
    assert conv.parse_line(" 92          BD-00 1234" + " " * 120) is None
    assert conv.parse_line("") is None


def test_asset_size_and_count(stars):
    size = os.path.getsize(ASSET)
    assert len(stars) == STAR_COUNT
    assert size == 4 + 6 * STAR_COUNT
    assert size < MAX_BYTES


def test_asset_is_brightest_first_and_in_range(stars):
    mags = [s[2] for s in stars]
    assert mags == sorted(mags)
    assert mags[0] < -1.4 and mags[-1] > 7.5
    assert all(0 <= s[0] < 24 and -90 <= s[1] <= 90 for s in stars)
    assert sum(1 for s in stars if s[2] <= 6.5) > 8000  # the naked-eye sky
    assert sum(1 for s in stars if s[3] is None) < 500


@pytest.mark.parametrize(
    "name,ra_h,dec,mag",
    [
        ("Sirius", 6.7525, -16.7161, -1.46),
        ("Polaris", 2.5303, 89.2641, 1.98),
        ("Vega", 18.6156, 38.7837, 0.03),
        ("Betelgeuse", 5.9195, 7.4071, 0.42),
    ],
)
def test_known_stars(stars, name, ra_h, dec, mag):
    hits = [
        s
        for s in stars
        if abs(s[0] - ra_h) < 0.01 and abs(s[1] - dec) < 0.02 and abs(s[2] - mag) < 0.1
    ]
    assert hits, name


def test_the_asset_is_credited():
    text = open(SOURCES).read()
    assert (
        "stars-v1.bin" in text
        and "Bright Star Catalogue" in text
        and "Public domain" in text
    )
