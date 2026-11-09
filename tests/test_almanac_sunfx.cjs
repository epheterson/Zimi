// The 3D Sun close up (zimi/static/almanac-sun.js): prominences, flares and a finer surface, made up by the Sun's own
// rules (like the sunspots) and the same instant always the same Sun.
//
//   1. Deterministic; a feature is carried round at its latitude's rate.
//   2. Loops stand over big groups: many at the peak, few at the 2019 minimum.
//   3. A flare is a quick rise and a slow fade; flares are at most the shader's slots.
//   4. Prominences stand 0.05 to 0.2 of the radius off the limb, none near a pole.
//   5. What the shader takes is packed in its slots as unit vectors; the patch puts every marker's piece in, and a
//      shader without the markers is left as it was.
//
// Run: node tests/test_almanac_sunfx.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}

const S = { Math, Date, Intl, Object, JSON, console, String, Number, Array, Float32Array, isNaN, window: {}, document: { getElementById: () => null } };
vm.createContext(S);
vm.runInContext(require("./sk.cjs")(), S);
vm.runInContext(
  'var JD_UNIX_EPOCH = 2440587.5; var JD_J2000 = 2451545.0; var MS_PER_DAY = 86400000;' +
  'var JULIAN_CENTURY = 36525; var DEG_TO_RAD = Math.PI / 180;' +
  'function t(k) { return k; } function _dateToJD(ms) { return JD_UNIX_EPOCH + ms / MS_PER_DAY; }', S);
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-orrery.js'), 'utf8'), S);
vm.runInContext(require('./moon_model.cjs')(), S);
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-ephem.js'), 'utf8'), S);
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-earth.js'), 'utf8'), S);
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-sun.js'), 'utf8'), S);

const at = (iso) => Date.parse(iso);
const ev = (iso) => vm.runInContext('_aeSunEvents(' + at(iso) + ')', S);
const get = (name) => vm.runInContext(name, S);
const norm = (v) => Math.hypot(v[0], v[1], v[2]);
const day = (y, d) => new Date(Date.UTC(y, 0, 1) + d * 864e5).toISOString();

// 1. Deterministic, and carried round.
check(JSON.stringify(ev('2025-03-01T00:00:00Z')) === JSON.stringify(ev('2025-03-01T00:00:00Z')), 'the same instant, the same Sun');
const p0 = ev('2025-03-01T00:00:00Z').proms, p1 = ev('2025-03-02T00:00:00Z').proms;
check(p0.length > 0 && p1.length > 0, 'prominences on a quiet day and the next: ' + p0.length + ', ' + p1.length);
const turn = (lat) => get('_aeSunFxLon(0, 0, ' + lat + ', 86400000)') - get('_aeSunFxLon(0, 0, ' + lat + ', 0)');
check(Math.abs(turn(0) - get('_aeSunRotation(0)')) < 1e-9 && turn(60) < turn(0), 'a feature turns at its latitude\'s rate, slower toward the pole');

// 2. Loops over big groups.
let loops25 = 0, loops19 = 0;
for (let d = 0; d < 360; d += 9) {
  loops25 += ev(day(2025, d)).loops.length;
  loops19 += ev(day(2019, d)).loops.length;
}
check(loops25 > 40 && loops19 < loops25 / 3, 'loops follow the cycle: ' + loops25 + ' at the peak, ' + loops19 + ' in 2019');
const l = ev('2025-03-01T00:00:00Z').loops;
check(l.every((x) => x.h >= get('AE_LOOP_BASE_HEIGHT') && x.h < 0.3 && norm(x.a) > 0.999 && norm(x.b) > 0.999), 'loops: feet on the Sun, heights in range');
check(l.length <= get('AE_LOOP_MAX'), 'at most ' + get('AE_LOOP_MAX') + ' loops');

// 3. Flares.
const prof = (m) => get('_aeFlareProfile(' + m + ')');
check(Math.abs(prof(0) - 1) < 1e-12 && prof(-12) < prof(-3) && prof(20) > prof(60), 'a flare peaks, rises and falls');
check(prof(-get('AE_FLARE_RISE_MIN')) < prof(get('AE_FLARE_DECAY_MIN')) + 1e-9, 'a rise is shorter than a decay');
let flares = 0, over = false;
for (let h = 0; h < 24 * 30; h += 3) {
  const f = ev(new Date(Date.UTC(2025, 2, 1) + h * 36e5).toISOString()).flares;
  flares += f.length;
  if (f.length > get('AE_SUNFX_FLARES') || f.some((x) => x.k <= get('AE_FLARE_ACTIVE_MIN'))) over = true;
}
check(flares > 0 && !over, 'a month at the peak holds flares, within the slots and above the floor: ' + flares);

// 4. Prominences.
let bad = 0, n = 0, maxLat = 0;
const P = get('_aeSolarFrame().P');
for (let d = 0; d < 400; d += 2) {
  for (const p of ev(day(2024, d)).proms) {
    n++;
    if (p.h > get('AE_PROM_HEIGHT')[1] + 1e-9 || p.h < 0 || p.amp < 0 || p.amp > 1) bad++;
    maxLat = Math.max(maxLat, Math.abs(Math.asin(p.a[0] * P[0] + p.a[1] * P[1] + p.a[2] * P[2])) * 180 / Math.PI);
  }
}
check(n > 100 && bad === 0, 'prominences within their heights: ' + n);
check(maxLat <= get('AE_PROM_LAT_MAX_DEG') + 1, 'none near a pole: ' + maxLat.toFixed(1) + ' deg');

// 5. What the shader takes, and the patch.
const slots = get('AE_SUNFX_PROMS');
S.A = new Float32Array(slots * 4); S.B = new Float32Array(slots * 4); S.F = new Float32Array(get('AE_SUNFX_FLARES') * 4);
vm.runInContext('_aeSunFxPack(_aeSunEvents(' + at('2025-03-01T00:00:00Z') + '), A, B, F)', S);
let used = 0;
for (let i = 0; i < slots; i++) {
  if (S.A[4 * i + 3] > 0) { used++; if (Math.abs(norm([S.A[4 * i], S.A[4 * i + 1], S.A[4 * i + 2]]) - 1) > 1e-5) used = -999; }
}
check(used > 0 && used <= slots, 'prominence slots filled with unit vectors: ' + used);
const plain = get('AE_SUN_FRAG'), glowPlain = get('AE_SUN_GLOW_FRAG');
for (const m of ['uniforms', 'functions', 'cells', 'surface']) check(plain.indexOf('// @sunfx-' + m) >= 0, 'the Sun shader has its ' + m + ' marker');
for (const m of ['uniforms', 'prominences']) check(glowPlain.indexOf('// @sunfx-' + m) >= 0, 'the glow shader has its ' + m + ' marker');
const full = get('_aeSunFxPatch(AE_SUN_FRAG, { uniforms: AE_SUNFX_GLSL.surfaceUniforms, functions: AE_SUNFX_GLSL.functions, cells: AE_SUNFX_GLSL.cells, surface: AE_SUNFX_GLSL.surface })');
check(full.indexOf('@sunfx') < 0 && full.indexOf('uFlare') > 0 && full.indexOf('fine2') > 0, 'the patched Sun shader has everything in');
check(get('_aeSunFxPatch("void main() {}", { uniforms: "x" })') === 'void main() {}', 'a shader without the markers is left alone');

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
