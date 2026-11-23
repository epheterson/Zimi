"""Turning the view on a planet's ground turns every texture layer of it as one: no layer's axes come from the view's heading."""

import os

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static")


def test_ground_grain_axes_do_not_follow_the_view():
    src = open(os.path.join(STATIC, "almanac-standgl.js"), encoding="utf-8").read()
    ground = src[src.index("uniform float uGrass"):]
    assert "uHead" not in ground
    assert "vec2 rr = vec2(0.0, 1.0)" in ground


def test_no_view_heading_uniform_is_fed_to_the_ground():
    src = open(os.path.join(STATIC, "almanac-stand.js"), encoding="utf-8").read()
    assert "uHead" not in src
