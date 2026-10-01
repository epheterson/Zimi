// The Almanac's 1.12 surfaces as a person reads them: what the UX pass fixed
// in the orrery's ride and the 3D Earth, locked in against the shipped files.
//
//   1. One readout for a transit's progress: the slider says "122 / 259
//      days" in the reader's language; the missions row lists only rockets
//      the ride panel does not describe (none, for one flight), by their
//      translated names; the rocket carries no days label of its own.
//   2. Arrived, "a message home now takes" follows the planet as the orrery's
//      clock runs on, not the instant of arrival.
//   3. Reduced motion: the camera stays on the whole system during a ride.
//   4. An Earth view found unsupported (no WebGL) is no longer offered by the
//      orrery.
//   5. The GPS card's counter never runs backwards as the clock's rate
//      wanders round its orbit, and reads in a unit that keeps it short
//      ("5.0 ms", not "4,993,540 ns").
//   6. A place inside a right-to-left sentence keeps its order (bidi
//      isolate), and Next eclipse never lands on a day with no eclipse.
//
// The layout half (the card above the controls, a place's dot on the place,
// the orrery's tip letting the planets under it through) needs a browser:
// tests/test_almanac_ux.spec.mjs.
//
// Run: node tests/test_almanac_ux.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8');
const almSrc = read('almanac.js');
const DAY_MS = 86400000;

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }
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
function extractVar(src, name) {
  const m = new RegExp('^var ' + name + ' =([^;]*);', 'm').exec(src);
  if (!m) throw new Error('var ' + name + ' not found');
  return 'var ' + name + ' =' + m[1] + ';';
}

// A DOM of named elements that remember what was written to them.
const els = new Map();
function el(id) {
  if (!els.has(id)) {
    els.set(id, {
      id, textContent: '', innerHTML: '', hidden: false, disabled: false, style: {}, value: 0,
      classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    });
  }
  return els.get(id);
}
// A 2D context that accepts every call and records the text drawn.
const drawnText = [];
function fakeCtx() {
  const gradient = { addColorStop() {} };
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => gradient;
      if (prop === 'fillText') return (s) => drawnText.push(String(s));
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

// The reader's language: English strings from the shipped file, planet names
// through the Almanac's own lookup, so a raw English planet name shows up.
const EN = JSON.parse(read('i18n/en.json'));
const HE_PLANETS = { mars: 'מאדים', jupiter: 'צדק', earth: 'כדור הארץ' };
let reduce = false;
const S = {
  Math, Date, Intl, Object, JSON, console, String, Number, Array, isNaN, Proxy,
  performance: { now: () => 1000 },
  requestAnimationFrame: () => 0,
  window: { matchMedia: () => ({ get matches() { return reduce; } }) },
  document: { getElementById: el },
  EN, HE_PLANETS,
};
vm.createContext(S);
vm.runInContext(
  'var JD_UNIX_EPOCH = 2440587.5, JD_J2000 = 2451545.0, MS_PER_DAY = 86400000, JULIAN_CENTURY = 36525;' +
  'var DEG_TO_RAD = Math.PI / 180; var _almanacOpen = false; var _almFocus = null; var _currentLang = "en";' +
  'var _voyagerPositions = [];' +
  'function t(k, vars) { var s = EN[k] || k; if (vars) for (var v in vars) s = s.split("{" + v + "}").join(vars[v]); return s; }' +
  'function _tp(n) { return _currentLang === "he" ? (HE_PLANETS[n.toLowerCase()] || n) : n; }' +
  'function _almEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }' +
  'function _lterm(k, h) { return h; }' +
  'function _showVoyagerCard() {}', S);
for (const fn of ['_dateToJD', '_jdToJulianCentury', '_solveKepler', '_orrDeepRadius', '_voyagerDist',
                  '_parseHex', '_hexToRgba', '_lighten', '_darken', '_jdnToGregorian', '_cnDeltaTdays', '_computeEclipses']) {
  vm.runInContext(extractFn(almSrc, fn), S);
}
for (const v of ['_VOYAGERS', '_HELIO_TERMINATION_AU', '_HELIOPAUSE_AU', '_KUIPER_INNER_AU', '_ORBIT_VIS']) {
  vm.runInContext(extractVar(almSrc, v), S);
}
const auToVis = extractFn(almSrc, '_auToVis');
vm.runInContext(almSrc.slice(almSrc.indexOf('var _AU_VIS_X'), almSrc.indexOf(auToVis) + auToVis.length), S);
vm.runInContext(read('almanac-orrery.js'), S);
vm.runInContext(require('./moon_model.cjs')(), S);   // app.js's Moon model, which the shader is written from
vm.runInContext(read('almanac-earth.js'), S);
const run = (code) => vm.runInContext(code, S);

// ── 1. One readout for a transit's progress ─────────────────────────────
run('_orreryRockets = []; _orreryPlaying = true; _almFocus = null;');
run('_orreryLaunchRocket("Mars"); var rk = _orreryRockets[0]; rk.elapsed = 122.4 * MS_PER_DAY;');
run('_orreryUpdateTransitLabel(); _orreryUpdateMissions();');
const label = el('orrery-transit-label').textContent;
check(/^122 \/ 259 days$/.test(label), 'the transit slider reads "122 / 259 days", got "' + label + '"');
check(el('orrery-missions').style.display === 'none' && el('orrery-missions').innerHTML === '',
  'one flight: the missions row is empty (the ride panel describes it)');
const canvas = { width: 400, height: 400, clientWidth: 400, getContext: () => fakeCtx() };
S.__canvas = canvas;
run('_orreryCanvas = __canvas; _orreryDpr = 1; _drawOrrery(__canvas, 1)');
check(!drawnText.some((s) => /\d+d \/ \d+d/.test(s)), 'the rocket carries no days label (the slider has it)');

// A second, older flight still under way, and one orbiting: both listed,
// translated, without an em dash or an English "transit".
run('_currentLang = "he";');
run('_orreryRockets = []; _orreryLaunchRocket("Jupiter"); _orreryRockets[0].elapsed = 100 * MS_PER_DAY;');
run('_orreryAutoTransit = false; _orreryLaunchRocket("Mars"); _orreryRockets[1].elapsed = 10 * MS_PER_DAY;');
run('_orreryUpdateMissions();');
let missions = el('orrery-missions').innerHTML;
check(missions.indexOf('צדק') >= 0 && missions.indexOf('Jupiter') < 0, 'an earlier mission is listed by its translated name');
check(missions.indexOf('מאדים') < 0, 'the ride itself is not listed again');
check(missions.indexOf('—') < 0 && missions.indexOf('transit') < 0, 'no em dash and no English "transit"');
run('_orreryRockets[1].elapsed = _orreryRockets[1].duration; _orreryRockets[1].arrived = true; _orreryUpdateTransitLabel();');
check(el('orrery-transit-label').textContent.indexOf('צדק') === 0,
  'when the slider holds an older rocket than the ride, it names that rocket\'s planet');
run('_orreryRockets[0].elapsed = _orreryRockets[0].duration; _orreryRockets[0].arrived = true; _orreryUpdateMissions();');
missions = el('orrery-missions').innerHTML;
check(missions.indexOf('צדק') >= 0 && missions.indexOf(EN.alm_orbiting) >= 0, 'an arrived mission reads "<planet> · orbiting"');
run('_currentLang = "en";');

// ── 2. Arrived: the delay home follows the planet ───────────────────────
run('_orreryRockets = []; _orreryLaunchRocket("Mars"); rk = _orreryRockets[0];');
const after = run('rk.elapsed = rk.duration + 60 * MS_PER_DAY; rk.arrived = true; _orreryRideStatus(rk)');
const marsThen = run('_orreryDistanceFromEarthAU("Mars", rk._launchRealTime + rk.elapsed)');
const marsAtArrival = run('_orreryDistanceFromEarthAU("Mars", rk._launchRealTime + rk.duration)');
check(near(after.au, marsThen, 1e-9) && !near(after.au, marsAtArrival, 1e-3),
  '60 days after arrival the delay home is Mars\'s distance then (' + after.au.toFixed(3) + ' AU), not at arrival (' + marsAtArrival.toFixed(3) + ')');
check(after.frac === 1, 'the ride stays arrived (the twins\' clocks stop at arrival)');

// ── 3. Reduced motion: no follow, no zoom ───────────────────────────────
run('rk.elapsed = rk.duration / 2; rk.arrived = false;');
const moving = run('_orreryCamTarget(_orreryDeepFactor(), 0)');
reduce = true;
const still = run('_orreryCamTarget(_orreryDeepFactor(), 0)');
reduce = false;
check(moving.zoom > 1, 'normally the camera follows the ride in');
check(still.zoom === 1 && still.x === 0.5 && still.y === 0.5, 'with reduced motion it stays on the whole system');

// ── 4. An Earth view this browser cannot draw is not offered ────────────
check(run('_orreryEarthViewAvailable()') === true, 'the Earth view is offered while it may work');
run('openAlmanacEarth.unsupported = true;');
check(run('_orreryEarthViewAvailable()') === false, 'found unsupported, the glow and Earth\'s button go');
run('openAlmanacEarth.unsupported = false;');

// ── 5. The GPS counter ──────────────────────────────────────────────────
// A satellite whose radius swings enough that the net rate dips mid-count:
// elapsed time times the rate of the moment went down whenever it did.
const R0 = 26560, T0 = Date.UTC(2026, 8, 28, 12);
S.fakeLib = {
  sgp4(rec, minutes) {
    const r = R0 * (1 + 0.02 * Math.sin(minutes / 90));
    return { position: { x: r, y: 0, z: 0 }, velocity: { x: 0, y: Math.sqrt(398600.4418 / r), z: 0 } };
  },
};
run('_ae = { selected: { norad: 1, tapMs: ' + T0 + ' }, scene: null, ' +
    'sats: { lib: fakeLib, list: [{ omm: { NORAD_CAT_ID: 1, OBJECT_NAME: "GPS (PRN 1)" }, rec: {}, epochMs: ' + T0 + ', iss: false }] } };');
el('ae-card-body'); el('ae-card-count');
// The count as the card shows it, in seconds.
const UNIT_S = { ns: 1e-9, 'μs': 1e-6, ms: 1e-3, sec: 1 };
function shownSeconds() {
  const m = /([\d.,]+)\s*(ns|μs|ms|sec)$/.exec(el('ae-card-count').textContent);
  return m ? parseFloat(m[1].replace(/,/g, '')) * UNIT_S[m[2]] : NaN;
}
let prev = -1, monotonic = true;
for (let h = 0; h <= 24 * 20; h += 3) {
  run('_aeUpdateCard(' + (T0 + h * 3600000) + ')');
  const g = shownSeconds();
  if (!(g >= prev)) monotonic = false;
  prev = g;
}
check(monotonic, 'the count since the tap never runs backwards as the rate dips');
prev = run('_ae.selected.gainedS');
check(near(prev, 20 * 38.5e-6, 2e-6), 'twenty days gain about 20 x 38.5 us, got ' + (prev * 1e6).toFixed(1) + ' us');
const shown = el('ae-card-count').textContent;
check(/: 770 μs$|: 7\d\d μs$/.test(shown), 'the counter reads in microseconds, not a seven-figure ns count: "' + shown + '"');
check(run('_aeFmtGain(0.86e-9)') === '0.86 ns', 'a fresh count reads "0.86 ns"');
check(run('_aeFmtGain(5.0e-3)') === '5.0 ms', 'after a jump it reads "5.0 ms"');
run('_aeUpdateCard(' + (T0 - 3600000) + ')');
check(run('_ae.selected.gainedS') === 0, 'a clock taken back before the tap starts the count again');

// ── 6. A place in a right-to-left sentence; Next eclipse ────────────────
const place = run('_aeFmtLatLon({ lat: -31.3, lon: -48.5 })');
check(place[0] === '⁦' && place[place.length - 1] === '⁩', 'the place is a left-to-right isolate');
check(place.slice(1, -1).replace(/ /g, ' ') === '31.3° S, 48.5° W', 'and reads "31.3° S, 48.5° W" inside it');
const far = Date.UTC(2026, 5, 15) + (40000 - 2026) * 365.2425 * DAY_MS;
const next = run('_aeNextEclipse(' + far + ')');
check(next === null || !!run('_aeEclipseNow(_aeSceneAt(' + next.ms + '))'),
  'Next eclipse, 38 millennia out, lands on an eclipse or says there is none');
const near2026 = run('_aeNextEclipse(' + Date.UTC(2026, 8, 28) + ')');
check(near2026 && run('_aeEclipseNow(_aeSceneAt(' + near2026.ms + '))'), 'from today it lands on a real eclipse');

process.exit(failures ? 1 : 0);
