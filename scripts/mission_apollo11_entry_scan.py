import json
import os

import mission_apollo11_entry as ent
import mission_physics as mp
from mission_apollo11_path import geodetic_of

d = json.load(open(os.path.join(mp.CACHE, "apollo11_return.json")))
CASES = [[0, 3.14, 1.0], [60, 3.14, 1.0], [120, 3.14, 1.0], [60, 1.6, 1.0]]
for p in CASES:
    t, Y = ent.fly(d["y_entry"], p)
    i = ent.until_drogue(t, Y)
    lat, lon, alt = geodetic_of(t[i], Y[i, 0:3])
    print(
        p,
        "to drogue %.0f s" % (t[i] - ent.EVENTS["entry"]),
        "lat %.2f lon %.2f alt %.1f" % (lat, lon, alt),
        flush=True,
    )
print("want 541 s lat 13.30 lon -169.15")
