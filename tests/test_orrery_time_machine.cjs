// The solar-system orrery must follow the almanac's time machine (#48).
//
// The orrery historically kept its own clock (Date.now() + _orreryTimeOffset,
// driven by its speed slider), so travelling the almanac to 2100 left the
// planets parked at today. The fix routes every consumer of the orrery's
// clock through ONE function, _orrerySimTime(), whose precedence rule is:
//
//   _almFocus set (scrubbing, or parked on any non-now instant)
//       -> the focus IS the clock (the time machine outranks the slider)
//   _almFocus null (almanac at now)
//       -> local clock: real now + the slider's accumulated offset, untouched
//
// What this locks in:
//   1. The precedence rule itself, executed from the shipped source.
//   2. Every clock consumer reads _orrerySimTime() — no second copy of
//      "Date.now() + _orreryTimeOffset" can drift back in (that inline
//      expression is exactly how the bug existed).
//   3. The animation loop suspends local time and mission clocks while the
//      focus is held (rockets must never interpolate across a scrub jump),
//      and rocket launches are refused then (their mission timer would be
//      frozen, welding a rocket to Earth).
//   4. The travel wiring exists on the almanac side: the visual tier ticks
//      the orrery, and the settle repaint syncs it exactly.
//
// Pure-helper approach, matching tests/test_almanac_tz_resolution.cjs: pull
// the functions out of the shipped source by name and eval them in a sandbox.
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

// ── 1. Precedence rule, executed ─────────────────────────────────────────
const sandbox = { _almFocus: null, _orreryTimeOffset: 0, Date };
vm.createContext(sandbox);
vm.runInContext(
  extractFn(orrSrc, '_orreryTravelFocus') + '\n' + extractFn(orrSrc, '_orrerySimTime'),
  sandbox
);

sandbox._almFocus = null;
sandbox._orreryTimeOffset = 0;
let t = vm.runInContext('_orrerySimTime()', sandbox);
check(Math.abs(t - Date.now()) < 2000, 'at now with zero offset, sim time is real now');

sandbox._orreryTimeOffset = 86400000 * 10; // slider wandered +10 days
t = vm.runInContext('_orrerySimTime()', sandbox);
check(Math.abs(t - (Date.now() + 86400000 * 10)) < 2000,
  'at now, the local offset (speed slider) owns the clock');

const focus2100 = new Date('2100-06-01T12:00:00Z');
sandbox._almFocus = focus2100;
t = vm.runInContext('_orrerySimTime()', sandbox);
check(t === focus2100.getTime(),
  'with a travel focus, the focus IS the clock — the local offset is ignored');

sandbox._almFocus = null;
t = vm.runInContext('_orrerySimTime()', sandbox);
check(Math.abs(t - (Date.now() + 86400000 * 10)) < 2000,
  'returning to now hands the untouched local clock back');

// ── 2. Single-clock discipline: no consumer bypasses _orrerySimTime ──────
// The inline pattern below is the exact shape of the original bug. The one
// legitimate `Date.now() + _orreryTimeOffset` computation lives INSIDE
// _orrerySimTime itself; nothing else may repeat it.
const inlineClock = /Date\.now\(\)\s*\+\s*_orreryTimeOffset/g;
const orrHits = (orrSrc.match(inlineClock) || []).length;
check(orrHits === 1, 'almanac-orrery.js computes the local clock exactly once (inside _orrerySimTime), found ' + orrHits);
check(!(almSrc.match(inlineClock) || []).length, 'almanac.js (Voyager card) reads _orrerySimTime, not its own clock copy');
check(extractFn(orrSrc, '_drawOrrery').includes('_orrerySimTime()'), '_drawOrrery renders _orrerySimTime()');
check(extractFn(almSrc, '_updateVoyagerCard').includes('_orrerySimTime()'), '_updateVoyagerCard reads _orrerySimTime()');

// ── 3. Suspension under a held focus ─────────────────────────────────────
const animate = extractFn(orrSrc, '_orreryAnimate');
check(/var _travelHeld = !!_orreryTravelFocus\(\)/.test(animate), '_orreryAnimate consults the travel focus');
check(/if \(!_travelHeld\) _orreryTimeOffset \+=/.test(animate), 'local time accumulation is gated off while the focus is held');
check(/if \(_travelHeld\) dt = 0/.test(animate), 'mission clocks freeze with the sim clock (suspend, never interpolate)');
const launch = extractFn(orrSrc, '_orreryLaunchRocket');
check(/if \(_orreryTravelFocus\(\)\) return/.test(launch), 'rocket launches are refused while the time machine owns the clock');
const upDate = extractFn(orrSrc, '_orreryUpdateDate');
check(/_orreryTravelFocus\(\)/.test(upDate), "the local 'Now' button yields to the time machine's RETURN while overridden");

// ── 4. Almanac-side wiring ────────────────────────────────────────────────
check(extractFn(almSrc, '_almTravelLive').includes('_orreryTravelTick'), '_almTravelLive ticks the orrery in the visual tier');
check(extractFn(almSrc, '_almRepaintFocus').includes('_orrerySyncToFocus'), '_almRepaintFocus settles the orrery exactly');
const tick = extractFn(orrSrc, '_orreryTravelTick');
check(/_almanacOrreryRAF/.test(tick) && /_orreryInView/.test(tick), 'travel tick defers to the running loop and skips offscreen paints');
check(/_almTravelThrottled\('orrery'/.test(tick), 'travel tick rides the shared travel throttle (canvas-tier cadence)');

process.exit(failures ? 1 : 0);
