// The live sky's scripts in a bare vm, the way tests/test_almanac_live_sky.cjs
// loads them: the Almanac's own functions pulled out of app.js and almanac.js,
// the orrery and the sky on top, then the GPU sky's pure half and the facts.
// Timers and frames are counted, not run.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8').replace(/\r\n/g, '\n');
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

function makeSky() {
  const appSrc = read('app.js'), almSrc = read('almanac.js');
  const timers = [], frames = [];
  const els = {};
  const S = {
    Math, Date, Intl, Object, JSON, console, String, Number, Array, isNaN, isFinite, Float32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer, Promise,
    window: {}, performance: { now: () => 1000 },
    document: { hidden: false, documentElement: {}, getElementById: (id) => els[id] || null, querySelector: () => null },
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => {},
  };
  vm.createContext(S);
  vm.runInContext(
    'var _MOON_EQUATOR_TILT_DEG = 1.54242; var JD_UNIX_EPOCH = 2440587.5; var JD_J2000 = 2451545.0; var MS_PER_DAY = 86400000;' +
    'var JULIAN_CENTURY = 36525; var DEG_TO_RAD = Math.PI / 180; var _currentLang = "en";' +
    'function t(k, v) { return k + (v ? JSON.stringify(v) : ""); } function _tp(n) { return n; } function _almEsc(s) { return String(s); }' +
    'function _lterm(k, h) { return h; } function _tLookup(k, f) { return f; }', S);
  for (const fn of ['_moonEqCoords', '_moonLimbAngles', '_moonLimbAnglesOf', '_moonAxisOf', '_moonView', '_normDeg360', '_moonPhase'])
    vm.runInContext(extractFn(appSrc, fn), S);
  for (const fn of ['_dateToJD', '_jdToJulianCentury', '_solveKepler', '_moonPosition', '_moonDistance', '_eqOfTime', '_solarB', '_dayOfYear', '_solarDeclination', '_jdnToGregorian', '_cnDeltaTdays', '_computeSunTimes', '_almSunTimesAt', '_fmtMinutes', '_fmtDuration'])
    vm.runInContext(extractFn(almSrc, fn), S);
  // The place's zone is the clock's own here: UTC, so a clock time is the instant's hour.
  vm.runInContext('function _almDisplayTz() { return null; } function _tzUtcOffsetMin() { return 0; }', S);
  vm.runInContext('var _tzFmtCache = {};' + extractFn(almSrc, '_tzFmt'), S);
  vm.runInContext(require('./moon_model.cjs')(), S);
  vm.runInContext(read('almanac-orrery.js'), S);
  vm.runInContext(read('almanac-sky.js'), S);
  vm.runInContext(read('almanac-skygl.js'), S);
  vm.runInContext(read('zone-places.js'), S);
  vm.runInContext(read('almanac-skyfacts.js'), S);
  return { S, timers, frames, els, run: (code) => vm.runInContext(code, S) };
}

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}
function done() {
  if (failures) { console.error('\n' + failures + ' failure(s)'); process.exit(1); }
  console.log('\nall checks passed');
}

module.exports = { makeSky, read, extractFn, check, done, STATIC, failures: () => failures };
