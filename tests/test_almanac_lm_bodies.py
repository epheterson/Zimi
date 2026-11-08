"""The 3D view's pin shows only at a body its landmarks file names places on: the list in almanac-earth.js is the file's."""

import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_the_pin_s_bodies_are_the_landmark_file_s():
    js = open(os.path.join(ROOT, "zimi", "static", "almanac-earth.js"), encoding="utf-8").read()
    listed = set(re.findall(r"(\w+): 1", re.search(r"var AE_LM_HAS = \{([^}]*)\}", js).group(1)))
    data = json.load(open(os.path.join(ROOT, "zimi", "static", "earth", "landmarks-v1.json"), encoding="utf-8"))
    bodies = {k for k, v in data.items() if isinstance(v, list) and v and isinstance(v[0], list)}
    assert listed == bodies, (sorted(listed ^ bodies))
