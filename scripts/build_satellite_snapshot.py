#!/usr/bin/env python3
"""Refresh the orbital elements that ship with Zimi, before a release.

    pip install sgp4          # Vallado's SGP4, the reference implementation
    python3 scripts/build_satellite_snapshot.py

Writes two committed files:

    zimi/assets/satellites-snapshot.json
        CelesTrak's current elements for the operational GPS constellation and
        the ISS: what the Almanac's Earth view draws on a machine that has
        never been online (zimi/satellites.py).

    tests/fixtures/satellites-reference.json
        Where SGP4 puts each of those satellites 0, 1, 30 and 90 days after its
        epoch, from the ``sgp4`` package. tests/test_almanac_earth.cjs checks
        the propagator the browser runs (satellite.js) against these, for the
        exact element set that ships.

tests/test_almanac_satellites.py fails when the snapshot is more than 180 days
old (past that the view stops drawing it), so a forgotten refresh shows up.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import satellites  # noqa: E402

REFERENCE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "tests",
    "fixtures",
    "satellites-reference.json",
)
REFERENCE_DAYS = (0, 1, 30, 90)
OMM_BOOKKEEPING = {
    "CLASSIFICATION_TYPE": "U",
    "ELEMENT_SET_NO": 999,
    "REV_AT_EPOCH": 0,
    "EPHEMERIS_TYPE": 0,
}
MINUTES_PER_DAY = 1440


def reference_positions(payload):
    """TEME positions (km) from Vallado's SGP4 for every shipped record."""
    from sgp4 import omm
    from sgp4.api import Satrec

    out = {}
    for rec in payload["gps"] + [payload["iss"]]:
        # The snapshot keeps only the fields propagation reads; sgp4's OMM
        # reader also wants the bookkeeping ones, which do not move anything.
        fields = dict(rec, EPOCH=rec["EPOCH"].rstrip("Z"))
        for key, blank in OMM_BOOKKEEPING.items():
            fields.setdefault(key, blank)
        sat = Satrec()
        omm.initialize(sat, fields)
        rows = []
        for days in REFERENCE_DAYS:
            err, pos, _vel = sat.sgp4_tsince(days * MINUTES_PER_DAY)
            if err:
                raise RuntimeError(
                    f"{rec['OBJECT_NAME']}: SGP4 error {err} at {days} d"
                )
            rows.append({"days": days, "km": [round(v, 6) for v in pos]})
        out[f"{rec['NORAD_CAT_ID']}@{rec['EPOCH']}"] = rows
    return out


def main():
    # --reference-only: recompute the reference for the snapshot already in
    # the tree, without asking CelesTrak again.
    if "--reference-only" in sys.argv[1:]:
        payload = satellites.read_snapshot()
    else:
        payload = satellites.fetch_live()
        satellites.write_snapshot(satellites.SNAPSHOT_PATH, payload)
    refs = reference_positions(payload)
    # One satellite a line, so a refresh reads as a diff of satellites.
    rows = [f"  {json.dumps(k)}: {json.dumps(v)}" for k, v in sorted(refs.items())]
    with open(REFERENCE_PATH, "w", encoding="utf-8") as f:
        f.write('{"source": "sgp4 (python), Vallado et al. 2006", "positions": {\n')
        f.write(",\n".join(rows))
        f.write("\n}}\n")
    print(
        f"{satellites.SNAPSHOT_PATH}: {len(payload['gps'])} GPS + ISS, fetched {payload['fetched']}"
    )
    print(f"{REFERENCE_PATH}: {len(refs)} satellites x {len(REFERENCE_DAYS)} instants")


if __name__ == "__main__":
    main()
