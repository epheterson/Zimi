"""The pure parts of the build scripts that need the network or the NAS to run whole (review findings on #141)."""

import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "scripts")
sys.path.insert(0, SCRIPTS)


def test_the_moon_fit_prints_the_orbit_the_3d_view_stores():
    import fit_moon_orbits as fit

    row = fit.orbit_row(
        {
            "name": "Io",
            "a_km": 421769.4,
            "lam0": 40.3611,
            "deg_per_day": 203.488958,
            "worst_deg": 0.34,
        }
    )
    assert row.startswith("  io: orbit: [421769, 40.361, 203.488958],")


def test_every_probe_has_reference_dates_and_only_names_a_real_track():
    import build_space_tracks as tracks

    assert set(tracks.PROBES) <= set(tracks.REF_PROBE_DATES), set(tracks.PROBES) - set(
        tracks.REF_PROBE_DATES
    )
    for key, dates in tracks.REF_PROBE_DATES.items():
        spec = tracks.PROBES[key]
        assert all(spec["start"] <= d <= spec["end"] for d in dates), (key, dates)
    assert "pioneer11" in tracks.track_names() and "jupiter" in tracks.track_names()
    done = subprocess.run(
        [
            sys.executable,
            os.path.join(SCRIPTS, "build_space_tracks.py"),
            "--only",
            "voyger1",
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert (
        done.returncode == 2 and "not a track" in done.stderr
    ), done.stderr  # before anything is fetched or written


def test_the_relief_smoothing_does_not_blend_one_pole_into_the_other(tmp_path):
    np = pytest.importorskip("numpy")
    pytest.importorskip("scipy")
    image = pytest.importorskip("PIL.Image")
    import build_almanac_hd as hd

    width = 64
    dem = np.zeros((width // 2, width), dtype=np.uint16)
    dem[-1, :] = 60000  # a ridge along the south pole's last row
    image.fromarray(dem).save(str(tmp_path / "dem.tif"))
    out = hd.normals_map(str(tmp_path / "dem.tif"), str(tmp_path / "n.png"), width)
    north = np.asarray(image.open(out))[0, 5]
    assert tuple(north) == (
        128,
        128,
        128,
    ), north  # level: the south pole's ridge is not near it


def test_a_new_elevation_map_does_not_meet_the_last_ones_normals():
    with open(os.path.join(SCRIPTS, "build_almanac_hd.py"), encoding="utf-8") as f:
        src = f.read()
    assert 'moon-normals-v2-%d-%s.png" % (width, source_sha[:12])' in src
    assert (
        'albedo = manifest["layers"].get("moon/albedo")' in src
        and "if a.inserts and albedo" in src
    )


def test_a_landmarks_query_is_cached_under_what_it_asks(monkeypatch, tmp_path):
    import build_landmarks as lm

    asked = []
    monkeypatch.setattr(lm, "_sparql", lambda q, cache, name: asked.append(name) or [])
    lm.qids_by_gazetteer_id(str(tmp_path), "moon", {"wd": "Q405"}, {"1", "2"})
    lm.qids_by_gazetteer_id(str(tmp_path), "moon", {"wd": "Q405"}, {"1", "3"})
    more = [n for n in asked if "qids-more" in n]
    assert len(more) == 2 and more[0] != more[1], asked  # other ids, another file: not the first run's answer
    assert "--refresh" in lm.__doc__
