// One moon everywhere — derivation-equality gate.
//
// The hero disc (almanac.js), the sky-scene moon (almanac-sky.js) and the
// Today discover card (app.js) once each derived the disc's orientation their
// own way: the hero used -(chi - q) - 90, the Today card raw q, the sky scene
// +q — three different terminator angles for the same date. All three now
// rotate the same untilted sprite by the ONE canonical _moonScreenTiltDeg in
// app.js. This test guards that unification two ways:
//
//   1. Functional: _heroMoonTiltDeg (almanac.js) must return exactly what
//      _moonScreenTiltDeg (app.js) returns, across a grid of dates and
//      observer locations including polar and equatorial edge cases.
//   2. Source-level: the sky scene and the Today card must reach their tilt
//      through _moonScreenTiltDeg (and their waxing flag through
//      _moonIsWaxing) — a reintroduced local derivation fails the grep even
//      if it happens to agree numerically today.
//
// Pure-helper approach, matching tests/test_almanac_tz_resolution.cjs: pull
// the functions straight out of the shipped sources by marker and eval them
// in a sandbox, so the test drives the shipped code rather than a copy.
//
// Run: node tests/test_moon_derivation.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const appSrc = fs.readFileSync(path.join(STATIC, 'app.js'), 'utf8');
const almSrc = fs.readFileSync(path.join(STATIC, 'almanac.js'), 'utf8');
const skySrc = fs.readFileSync(path.join(STATIC, 'almanac-sky.js'), 'utf8');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}

// Extract a top-level `function NAME(...) {...}` by brace matching.
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces extracting ' + name);
}

const sandbox = { Math, Date, console };
vm.createContext(sandbox);
for (const name of ['_moonEqCoords', '_moonScreenTiltDeg', '_moonIsWaxing', '_moonPhase']) {
  vm.runInContext(extractFn(appSrc, name), sandbox);
}
vm.runInContext(extractFn(almSrc, '_heroMoonTiltDeg'), sandbox);

// ── 1. Functional equality: hero delegates to the canonical derivation ──
const dates = [];
for (let y = 1980; y <= 2080; y += 7) dates.push(Date.UTC(y, (y * 5) % 12, 1 + (y % 27), (y * 3) % 24, 30));
dates.push(Date.UTC(2026, 7, 6, 4, 0));       // a real "tonight"
const locs = [
  { lat: 37.77, lon: -122.42 },  // San Francisco
  { lat: -33.87, lon: 151.21 },  // Sydney (southern hemisphere flips the view)
  { lat: 0, lon: 0 },            // equator, prime meridian
  { lat: 78.22, lon: 15.63 },    // Svalbard (polar)
  { lat: -89.9, lon: 45 },       // near south pole
  { lat: 34, lon: -120 }         // the synthetic default _getLocation falls back to
];
let worst = 0, finite = true;
for (const t of dates) {
  for (const loc of locs) {
    const d = new Date(t);
    const hero = vm.runInContext('_heroMoonTiltDeg(new Date(' + t + '), ' + JSON.stringify(loc) + ')', sandbox);
    const canon = vm.runInContext('_moonScreenTiltDeg(new Date(' + t + '), ' + loc.lat + ', ' + loc.lon + ')', sandbox);
    if (!isFinite(hero) || !isFinite(canon)) finite = false;
    worst = Math.max(worst, Math.abs(hero - canon));
  }
}
check(finite, 'tilt is finite at every date/location including polar');
check(worst === 0, 'hero tilt === canonical tilt exactly (worst delta ' + worst + ' deg)');

// Waxing predicate agrees with the phase convention (phase < 0.5 = waxing).
const wax1 = vm.runInContext('_moonIsWaxing({ phase: 0.25 })', sandbox);
const wax2 = vm.runInContext('_moonIsWaxing({ phase: 0.75 })', sandbox);
check(wax1 === true && wax2 === false, '_moonIsWaxing follows the phase < 0.5 convention');

// ── 2. Source-level: every renderer reaches the canonical helpers ──
check(/_moonScreenTiltDeg\(now, lat, lon\)/.test(skySrc),
  'sky scene derives its tilt via _moonScreenTiltDeg');
check(!/parallactic/.test(extractFn(skySrc, '_drawSkyScene')),
  'sky draw no longer rotates by the parallactic angle');
check(/_moonIsWaxing\(m\)/.test(extractFn(skySrc, '_drawSkyScene')),
  'sky draw uses the shared waxing predicate');
check(/_moonScreenTiltDeg\(date, lat, lon\)/.test(extractFn(appSrc, '_quickMoonTilt')),
  'Today card tilt (_quickMoonTilt) delegates to _moonScreenTiltDeg');
check(/_moonIsWaxing\(m\)/.test(extractFn(appSrc, '_renderMoonHTML')),
  'hero/Today sprite HTML uses the shared waxing predicate');
check(/_moonScreenTiltDeg\(date, loc\.lat, loc\.lon\)/.test(extractFn(almSrc, '_heroMoonTiltDeg')),
  'hero tilt (_heroMoonTiltDeg) delegates to _moonScreenTiltDeg');
check(/_moonEqCoords\(date\)/.test(extractFn(almSrc, '_moonPosition')),
  '_moonPosition consumes the canonical _moonEqCoords elements');

// ── 3. Physical sanity of the canonical derivation ──
// Near full moon the illumination must be ~100 and near new ~0 (ties the
// sprite's lit fraction to the same _moonPhase all readouts use).
const full = vm.runInContext('_moonPhase(new Date(Date.UTC(2026, 0, 3, 10, 0)))', sandbox); // full moon Jan 3 2026
const nw = vm.runInContext('_moonPhase(new Date(Date.UTC(2026, 0, 18, 19, 0)))', sandbox);  // new moon Jan 18 2026
check(full.illumination > 97, 'known full moon reads > 97% (' + full.illumination + '%)');
check(nw.illumination < 3, 'known new moon reads < 3% (' + nw.illumination + '%)');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all moon derivation checks passed');
