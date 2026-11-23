"""The 3D view's loading line names no body: it said "Loading the Earth" and then opened on the Sun."""

import glob
import json
import os

DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static", "i18n", "almanac")
BODIES = ("earth", "terre", "erde", "tierra", "terra", "земл", "地球", "אדמה", "الأرض", "पृथ्वी", "tierra")


def test_the_loading_line_names_no_body_in_any_language():
    files = glob.glob(os.path.join(DIR, "*.json"))
    assert len(files) == 10
    for f in files:
        line = json.load(open(f, encoding="utf-8"))["alm_earth_loading"].lower()
        assert not any(b in line for b in BODIES), (f, line)
