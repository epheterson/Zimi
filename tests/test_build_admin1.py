"""The region outlines' builder (scripts/build_admin1.py), its pure parts: a hole in a region stays (the even-odd rule
needs it to leave an enclave out), a rock off its coast does not.

Run: pytest tests/test_build_admin1.py -v
"""

import importlib.util
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    "build_admin1", os.path.join(ROOT, "scripts", "build_admin1.py")
)
build_admin1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_admin1)


def _square(x, y, size):
    return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]


def _feature(polygons):
    return {
        "properties": {"admin": "Italy", "iso_a2": "IT", "name": "Lazio"},
        "geometry": {"type": "MultiPolygon", "coordinates": polygons},
    }


def test_a_small_hole_is_kept_and_a_small_island_is_not():
    outline = _square(12.0, 41.0, 1.0)
    enclave = _square(
        12.40, 41.50, 0.05
    )  # smaller than an outer ring is kept at, larger than the rounding
    rock = _square(14.0, 41.0, 0.01)
    built = build_admin1.build([_feature([[outline, enclave], [rock]])])
    assert len(built["regions"][0][3]) == 2, built["regions"][0][3]


def test_only_a_hole_below_the_rounding_is_lost():
    assert build_admin1.keeps_ring(build_admin1.UNIT, True, False)
    assert not build_admin1.keeps_ring(build_admin1.UNIT / 2, True, False)
    assert not build_admin1.keeps_ring(build_admin1.MIN_RING_SPAN / 2, False, False)
    assert build_admin1.keeps_ring(build_admin1.MIN_RING_SPAN / 2, False, True)
