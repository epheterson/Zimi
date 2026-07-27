# Almanac Time Machine — skeuomorphic time-travel instrument

Replaces the almanac's velocity-drag scrubber + plain datetime-local destination
panel with one deliberately skeuomorphic instrument: a three-row time circuit
beside a side-mounted brass lever. The app's one playful object; dark,
amber-accented, tabular-figure, 4px-grid, our own hierarchy (not BTTF trade
dress).

## Checklist

- [x] Rest face: three rows — DISPLAYED (amber), DESTINATION (neutral, taps to
      open the chooser), NOW (dimmed, ticks). Destination mirrors displayed idle.
- [x] Motion face: collapse to one large moving readout with the lever thrown;
      stays collapsed after landing until tapped, then back to the three rows.
- [x] Lever: displacement → nonlinear directional speed (~2 min/sec near
      neutral to ~300 yr/sec at the stops), deadzone, spring-back + decel on
      release. Single travel rAF (reuses the `_skySetInstant` redraw contract;
      no new sky loop). Wheel/arrow/Page/Home stepping preserved.
- [x] Landing ("zap"): decel feel + transform-only shake + `navigator.vibrate`;
      `prefers-reduced-motion` skips shake + vibration and just lands.
- [x] Arbitrary years via chooser + typable calendar year: 0, 10000, −10000
      (BCE). `setFullYear` (not `new Date(year,…)`); clamp ±270000 yr (inside
      JS Date's ±273,785 yr limit).
- [x] Degradation contract: no NaN/garbage at any reachable epoch. `_dayOfYear`
      and the astro season/perihelion math use `setFullYear`; unparseable
      eclipse rows are skipped; `_almRepaintFocus` renders each panel
      resiliently with a quiet "beyond this calendar's range" note where math
      breaks; sky/orrery/deep-time keep working.
- [x] i18n: 13 new keys × 10 locales, parity preserved.
- [x] All existing focus-date entry points still land (`_almSelectDay` fixed for
      ancient years, deep-links, calendar, back-to-now).

## Verification

- `node --check zimi/static/almanac.js` clean.
- `python3 -m pytest tests/ -q` ≥ 1016 passed / 3 skipped (observed 1025/3).
- i18n key parity across all 10 files.
- Playwright against a local server: rest/motion/chooser faces render; lever
  drag advances time and fires the landing vibration; mode stays collapsed
  until tapped; NaN sweep clean at years 0 / 10000 / −10000 / 50 CE; no
  horizontal scroll at 375px width (rest and during shake); reduced-motion
  suppresses shake + vibration; lever hit area ≥44px.

## Notes

- The lever engine + template landed earlier in commit 2c1bfd4 (mislabeled by a
  concurrent cleanup pass); this commit adds the styling, strings, and
  arbitrary-epoch hardening that make the feature coherent.
