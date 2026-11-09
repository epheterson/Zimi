import math
import time

import numpy as np

from mission_landing import descend

R = 1737400.0
mu = 4902.800066
site = np.array([R, 0, 0.0])
up = np.array([1.0, 0, 0])
hdir = np.array([0, -1.0, 0])
w = np.array([0, 0, 2.6617e-6])
r0 = site + up * 2173 - hdir * 7400
v0 = hdir * 70 - up * 38.1
segs = [
    dict(
        t1=110.0,
        rf=site + up * 183 - hdir * 600,
        vf=hdir * 13 - up * 4.5,
        af=-hdir * 0.15,
    ),
    dict(t1=248.0, rf=site, vf=-up * 0.6, af=np.zeros(3)),
]
t0 = time.time()
t, y = descend(
    np.concatenate([r0, v0, [8000.0]]), 0.0, segs, mu, w, (4700, 45000), 304.0
)
print("seconds", time.time() - t0, len(t))
print(np.round(y[-1], 2))
