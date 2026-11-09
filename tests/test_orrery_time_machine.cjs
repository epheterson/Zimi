// The solar-system orrery has no clock of its own: it draws the Almanac's one clock (#48, and the time travel control).
//
// Once the orrery kept its own clock (Date.now() + _orreryTimeOffset, driven by its own speed slider), so travelling the
// Almanac to 2100 left the planets parked at today, and the page, the orrery and the 3D view showed three moments. Now
// every consumer reads ONE function, _orrerySimTime(), which is the page's moment (_almFocusInstant) plus the opening
// scenery spin (an offset that is zero the moment anyone sets the clock). The rate is the page's too (_almRate).
//
// What this locks in:
//   1. _orrerySimTime executed from the shipped source: the focus is the clock, scenery is only an offset on it, and
//      touching the clock removes the offset.
//   2. No second clock: nothing in the orrery or the page adds a local offset or keeps a speed of its own, and every
//      consumer reads _orrerySimTime().
//   3. A flight is timed on the clock (its elapsed time is the clock's distance from its launch), so a rewind un-flies it
//      and a pause holds it; a launch is no longer refused away from now, and it sets the clock's pace.
//   4. The wiring exists on the almanac side: the visual tier ticks the orrery, and the settle repaint syncs it exactly.
//
// Pure-helper approach, matching tests/test_almanac_tz_resolution.cjs: pull the functions out of the shipped source by
// name and eval them in a sandbox.
//
// Run: node tests/test_orrery_time_machine.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const orrSrc = fs.readFileSync(path.join(STATIC, 'almanac-orrery.js'), 'utf8');
const almSrc = fs.readFileSync(path.join(STATIC, 'almanac.js'), 'utf8');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}

// Extract a top-level `function NAME(...) {...}` by brace matching.
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

// ── 1. The clock, executed ───────────────────────────────────────────────
const sandbox = { _almFocus: null, _orreryScenery: true, _orrerySceneryMs: 0, _orreryAutoTransit: true, Date };
vm.createContext(sandbox);
vm.runInContext(
  'function _almFocusInstant() { return _almFocus || new Date(); }\n' +
  extractFn(orrSrc, '_orrerySimTime') + '\n' + extractFn(orrSrc, '_orreryClockTouched'),
  sandbox
);

let t = vm.runInContext('_orrerySimTime()', sandbox);
check(Math.abs(t - Date.now()) < 2000, 'at now with no scenery turned, sim time is real now');

sandbox._orrerySceneryMs = 86400000 * 10; // the opening spin has turned ten days
t = vm.runInContext('_orrerySimTime()', sandbox);
check(Math.abs(t - (Date.now() + 86400000 * 10)) < 2000, 'the opening spin is an offset on the page\'s moment');

const focus2100 = new Date('2100-06-01T12:00:00Z');
sandbox._almFocus = focus2100;
vm.runInContext('_orreryClockTouched()', sandbox);
t = vm.runInContext('_orrerySimTime()', sandbox);
check(t === focus2100.getTime(), 'with the clock set, the focus IS the clock: the scenery offset is gone');
check(sandbox._orreryScenery === false && sandbox._orreryAutoTransit === false, 'setting the clock ends the scenery and any auto-flown ride');

// ── 2. One clock: no consumer keeps its own ──────────────────────────────
for (const dead of ['_orreryTimeOffset', '_orrerySpeed', '_orreryClockChosen', '_orreryTravelFocus', '_orrerySliderInput', '_orreryUpdateDate']) {
  check(!orrSrc.includes(dead) && !almSrc.includes(dead), 'the orrery keeps no ' + dead + ' of its own');
}
check(!/Date\.now\(\)\s*\+/.test(extractFn(orrSrc, '_orrerySimTime')), 'sim time is not computed from real now');
check(extractFn(orrSrc, '_drawOrrery').includes('_orrerySimTime()'), '_drawOrrery renders _orrerySimTime()');
check(extractFn(almSrc, '_updateVoyagerCard').includes('_orrerySimTime()'), '_updateVoyagerCard reads _orrerySimTime()');

// ── 3. A flight is timed on the clock ────────────────────────────────────
const animate = extractFn(orrSrc, '_orreryAnimate');
check(/rk\.elapsed = _orreryRocketElapsed\(rk\)/.test(animate) && !/rk\.elapsed \+=/.test(animate),
  'a rocket\'s time in flight is the clock\'s distance from its launch, not a sum of its own frames');
check(/function _orreryRocketElapsed\(rk\) \{ return Math\.max\(0, _orrerySimTime\(\) - rk\._launchRealTime\); \}/.test(orrSrc),
  'a rewind past the launch holds the rocket at Earth, and a pause holds it where it is');
const launch = extractFn(orrSrc, '_orreryLaunchRocket');
check(!/_almFocus|Focus\(\)/.test(launch), 'a launch does not ask whether the clock is at now: it is not refused away from it');
check(/_almClockSetRate\(departSpeed\);\s*\n\s*_orreryAutoTransit = true;/.test(launch), 'a launch sets the clock\'s pace, then lets the flight keep it');
check(/_almRate = _transitEffectiveSpeed\(rk\)/.test(extractFn(orrSrc, '_orreryRideTick')), 'the flight sets the clock\'s pace each frame');

// ── 4. Almanac-side wiring ────────────────────────────────────────────────
check(extractFn(almSrc, '_almTravelLive').includes('_orreryTravelTick'), '_almTravelLive ticks the orrery in the visual tier');
check(extractFn(almSrc, '_almRepaintFocus').includes('_orrerySyncToFocus'), '_almRepaintFocus settles the orrery exactly');
check(extractFn(almSrc, '_almClockFrame').includes('_orreryRideTick'), 'the clock\'s loop asks a flight for its pace');
const tick = extractFn(orrSrc, '_orreryTravelTick');
check(/_almanacOrreryRAF/.test(tick) && /_orreryInView/.test(tick), 'travel tick defers to the running loop and skips offscreen paints');
check(/_almTravelThrottled\('orrery'/.test(tick), 'travel tick rides the shared travel throttle (canvas-tier cadence)');

process.exit(failures ? 1 : 0);
