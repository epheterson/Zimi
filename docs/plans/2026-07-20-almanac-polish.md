# Almanac polish drop + v1.7.4 finalization

Date: 2026-07-20
Owner: Eric + Claude

## v1.7.4 (ship soon — tight security + polish)

Ready on branch `v1.7.4`:
- Security: `/dl/` no longer serves whole ZIMs to the public internet
- Moon: physically-shaded sprite (soft terminator, limb darkening, earthshine
  dark side) + device-resolution render
- New/Updated ZIM badges (#34), country-holiday colour (#33)
- P0 libzim segfault race + audit hotfixes; 660 tests green
- Clean "Zimi" almanac breadcrumb; in-place location refresh (no scroll jump)

Pulled OUT of 1.7.4 (reimagining): the Option A date/time editor panel. Lives
in git history at 56a9bde.

Gate: NAS deploy → merge → tag → publish, each on Eric's explicit go.

## Almanac polish drop (branch `almanac-polish`, off v1.7.4)

Eric's decisions (2026-07-20). Fix everything from the findings.

1. **Pinned date/time scrubber** — the control pins to the top (full or shrunk)
   as you scroll and stays usable, so you adjust time/date and watch every panel
   change from anywhere on the page. Replaces the rejected panel.
2. **Accurate Chinese calendar** — real astronomical new moons + solar-term
   leap-month intercalation; re-enable the selectable grid.
3. **Voyager trajectories move** in the orrery (real angular motion / plotted
   path) + add more trackable objects (New Horizons, Pioneers, JWST@L2, comets,
   dwarf planets).
4. **Unify sky-scene moon** with the hero (earthshine dark side, no black shadow).
5. **Holidays place on any calendar** — compute events by JDN, project onto the
   displayed grid; layer each system's native religious table.
6. **Remove star-chart ±12h slider** — fold into the global time-of-day control.
7. **High-res moon** — bundle a bigger public-domain lunar image; raise cap.
8. **Easier map selection** — loupe or click-cycle through overlapping cities.

### Order (rough)
Research in parallel (Chinese algorithm; solar-system ephemerides). Build the
pinned control first (Eric's priority). Then sky-moon unify + star-slider
removal (share the moon/time plumbing). Then holidays-by-JDN. Then Chinese
calendar. Then Voyager + objects. High-res moon + map selection alongside.

### Verification
- `node --check` all touched JS; full `pytest` stays green
- Playwright: pinned control usable while scrolled; Chinese grid matches a
  known reference year (incl. a leap year); holidays appear on a non-Gregorian
  grid; sky moon shows a dim dark side; Voyagers move on time-scrub
- i18n parity across 10 locales for any new keys
