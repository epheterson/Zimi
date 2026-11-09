"""Apollo 11 from lunar orbit to the instant before powered descent (a driver for checking the stages against the report)."""

import numpy as np

from mission_apollo11 import EVENTS
from mission_apollo11_lm import fit_doi
from mission_apollo11_moon import lunar_latlon, moon_elements
from mission_apollo11_orbit import run
from mission_apollo11_path import NMI

if __name__ == "__main__":
    out = run()
    fl = out["res"]["fl"]
    y = out["y_cut2"]
    t0 = EVENTS["loi2"] + 16.7
    t, Y = fl.run(y, t0, EVENTS["undock"], (), step=30.0)
    y_undock = Y[-1]
    e = moon_elements(fl, EVENTS["undock"], y_undock)
    print(
        "at undocking orbit %.1f x %.1f km incl %.2f; lat/lon/alt"
        % (e["ra"], e["rp"], e["inc"]),
        np.round(lunar_latlon(fl, EVENTS["undock"], y_undock), 2),
        "(report 1.11 N 116.21 E 62.9 nmi)",
    )
    kappa, rows, y_pdi = fit_doi(fl, y_undock)
    e = moon_elements(fl, EVENTS["pdi"], y_pdi)
    print("orbit at PDI %.1f x %.1f km incl %.2f" % (e["ra"], e["rp"], e["inc"]))
    import json
    import os

    from mission_physics import CACHE

    os.makedirs(CACHE, exist_ok=True)
    with open(os.path.join(CACHE, "apollo11_stage3.json"), "w") as fh:
        json.dump(dict(y_pdi=y_pdi.tolist(), y_undock=y_undock.tolist(), y_cut2=y.tolist(), kappa_doi=float(kappa),
                       tli_x=[float(v) for v in out["res"]["tli_x"]], mcc_dv=[float(v) for v in out["mcc_dv"]]), fh)
