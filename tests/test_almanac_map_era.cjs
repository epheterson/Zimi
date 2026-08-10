// The sun/world map's civil-time layer must fade out in deep time.
//
// Time zones are a 19th-century invention. The map draws two kinds of thing:
// physics (coastlines, the terminator, the subsolar point) that is true at any
// date, and civil constructs (zone borders, the UTC label strip, the picked
// zone's highlight) that did not exist before railways forced clocks off local
// solar noon. Travelling the time machine to 1500 and still seeing a UTC+5:30
// band over Mughal India is a category error, so the civil layer rides an
// opacity ramp across the adoption era.
//
// What this test pins, and why each one is a real regression risk:
//
//   1. Deep time is FULLY clear. A ramp that bottoms out at 0.04 instead of 0
//      still paints a ghost grid over the 16th century — visible on a bright
//      screen, and the whole point of the feature is that it is gone.
//   2. The modern era is FULLY present. The failure mode of any era ramp is
//      quietly dimming the present, so today's opacity is pinned at exactly 1,
//      not "close to 1".
//   3. The ramp is MONOTONIC and CONTINUOUS across the whole travel range. A
//      non-monotonic curve means scrubbing forward through the 19th century
//      makes the borders fade IN then OUT again; a discontinuity means a
//      visible pop mid-scrub. Both are the kind of thing that looks like a
//      rendering bug rather than a design choice.
//   4. The endpoints meet the curve. Smoothstep is only kink-free if the
//      thresholds are exactly where the piecewise 0 and 1 hand over, so the
//      value AT each threshold is checked against the branch on the other side.
//   5. The Date-taking wrapper agrees with the numeric one, interpolates
//      WITHIN a year (a scrub through 1884 must move, not step once each
//      January 1), and treats a missing/broken date as fully modern — an
//      overlay that disappears because of a bad argument is worse than one
//      that never fades.
//
// Pure-helper approach, matching tests/test_almanac_tz_resolution.cjs: pull the
// constants and both functions straight out of almanac.js by source markers and
// eval them in a sandbox, so the test drives the shipped code rather than a
// copy of it.
//
// Run: node tests/test_almanac_map_era.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ALMANAC_JS = path.join(__dirname, '..', 'zimi', 'static', 'almanac.js');
const src = fs.readFileSync(ALMANAC_JS, 'utf8');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}

function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from almanac.js');
  return m[0];
}

const cDawn = extract(/var _MAP_TZ_ERA_DAWN_YEAR = \d+;/, '_MAP_TZ_ERA_DAWN_YEAR');
const cFull = extract(/var _MAP_TZ_ERA_FULL_YEAR = \d+;/, '_MAP_TZ_ERA_FULL_YEAR');
const fOpacity = extract(/function _mapTzEraOpacity\(year\)\s*\{[\s\S]*?\n\}/, '_mapTzEraOpacity');
const fOpacityAt = extract(/function _mapTzEraOpacityAt\(date\)\s*\{[\s\S]*?\n\}/, '_mapTzEraOpacityAt');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([cDawn, cFull, fOpacity, fOpacityAt].join('\n'), sandbox);
const opacity = sandbox._mapTzEraOpacity;
const opacityAt = sandbox._mapTzEraOpacityAt;
const DAWN = sandbox._MAP_TZ_ERA_DAWN_YEAR;
const FULL = sandbox._MAP_TZ_ERA_FULL_YEAR;

// --- the thresholds themselves ---------------------------------------------
// Not arbitrary: the ramp has to start no earlier than railway time (the
// Great Western Railway's 1840 switch to London time, the first standard clock
// anywhere) and finish by the era when hourly offsets were near-universal in
// law. If someone widens the ramp to, say, 1600-2000 to make the fade prettier,
// the map ends up half-drawing zone borders over the Thirty Years' War.
check(DAWN >= 1840 && DAWN <= 1883, 'ramp starts in the railway-time window (got ' + DAWN + ')');
check(FULL >= 1918 && FULL <= 1940, 'ramp completes in the standard-time-in-law window (got ' + FULL + ')');
check(DAWN < FULL, 'ramp runs forward in time');

// --- 1. deep time is fully clear -------------------------------------------
[-270000, -3000, 1, 800, 1500, 1750, 1799, DAWN - 1, DAWN].forEach(function (y) {
  check(opacity(y) === 0, 'year ' + y + ' -> exactly 0 (no ghost grid in deep time)');
});

// --- 2. the modern era is fully present ------------------------------------
[FULL, FULL + 1, 1970, 2026, 2100, 270000].forEach(function (y) {
  check(opacity(y) === 1, 'year ' + y + ' -> exactly 1 (present day undimmed)');
});

// --- 3. monotonic and continuous across the whole travel range -------------
// Sampled far outside the ramp on both sides so a rewrite that forgets to clamp
// (an unbounded smoothstep goes negative below the dawn year and past 1 above
// the full year) is caught, not just one that gets the middle wrong.
let prev = -Infinity;
let monotonic = true;
let inRange = true;
let biggestJump = 0;
let jumpAt = null;
for (let y = 1700; y <= 2100; y += 0.05) {
  const v = opacity(y);
  if (v < prev - 1e-12) { monotonic = false; }
  if (!(v >= 0 && v <= 1)) { inRange = false; }
  if (prev !== -Infinity && v - prev > biggestJump) { biggestJump = v - prev; jumpAt = y; }
  prev = v;
}
check(monotonic, 'opacity never decreases as the year advances');
check(inRange, 'opacity stays within [0,1] at every sampled year');
// A 0.05-year step on a smoothstep spanning ~90 years moves the value by at
// most ~1.5 * 0.05/90 ~= 0.00084. Anything an order of magnitude above that is
// a step function sneaking back in.
check(biggestJump < 0.005, 'no discontinuity in the ramp (largest step ' + biggestJump.toFixed(6) + ' near year ' + jumpAt + ')');

// The ramp must actually be a ramp: strictly increasing strictly inside it, so
// nobody can satisfy the checks above with a flat 0-then-1 cliff.
let strictlyRising = true;
for (let y = DAWN + 1; y < FULL - 1; y += 1) {
  if (!(opacity(y + 1) > opacity(y))) strictlyRising = false;
}
check(strictlyRising, 'opacity strictly increases at every year inside the ramp');

// --- 4. the endpoints meet the curve ---------------------------------------
// Smoothstep is 0 at t=0 and 1 at t=1, so the piecewise branches hand over with
// no jump. Checked just inside each threshold too: a fencepost error that made
// the ramp start a year early would show up as a nonzero value at DAWN.
check(opacity(DAWN) === 0, 'value at the dawn year is exactly 0');
check(opacity(FULL) === 1, 'value at the full year is exactly 1');
check(opacity(DAWN + 0.5) > 0 && opacity(DAWN + 0.5) < 0.01, 'ramp eases in gently just after the dawn year');
check(opacity(FULL - 0.5) < 1 && opacity(FULL - 0.5) > 0.99, 'ramp eases out gently just before the full year');
// Symmetric curve: the midpoint of a smoothstep is exactly half.
check(Math.abs(opacity((DAWN + FULL) / 2) - 0.5) < 1e-12, 'midpoint of the ramp is 0.5');

// --- 5. the Date-taking wrapper --------------------------------------------
function atYear(y, mo, d) {
  const dt = new Date(0);
  dt.setUTCFullYear(y, (mo || 1) - 1, d || 1);
  dt.setUTCHours(0, 0, 0, 0);
  return dt;
}

check(opacityAt(atYear(1500, 6, 15)) === 0, 'Date in 1500 -> 0');
check(opacityAt(atYear(2026, 8, 9)) === 1, 'Date in 2026 -> 1');
check(opacityAt(atYear(-3000, 1, 1)) === 0, 'BCE Date -> 0 (setUTCFullYear, not the 0-99 fold)');

// Within-year interpolation: December of a ramp year must be brighter than
// January of the same year, or a slow scrub through the 1880s visibly steps
// once a year instead of gliding.
const janMid = opacityAt(atYear(1884, 1, 1));
const decMid = opacityAt(atYear(1884, 12, 31));
check(decMid > janMid, 'opacity rises WITHIN a ramp year (Jan ' + janMid.toFixed(4) + ' -> Dec ' + decMid.toFixed(4) + ')');
// ...and that interpolation must land between the two integer-year values, not
// overshoot past the next year's.
check(janMid >= opacity(1884) - 1e-12 && decMid <= opacity(1885) + 1e-12,
      'within-year interpolation stays between the bounding integer years');

// Defensive inputs are "modern", never "invisible".
check(opacityAt(null) === 1, 'null date -> 1 (overlay never vanishes on a bad argument)');
check(opacityAt(undefined) === 1, 'undefined date -> 1');
check(opacityAt(new Date(NaN)) === 1, 'invalid Date -> 1');

console.log(failures ? '\n' + failures + ' failure(s)' : '\nall era-fade checks passed');
process.exit(failures ? 1 : 0);
