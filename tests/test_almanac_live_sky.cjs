// The Almanac's live sky (zimi/static/almanac-sky.js): where it puts things,
// and how it keeps time.
//
//   1. Positions. The Sun, the Moon and the seven planets, as altitude and
//      azimuth for a place and an instant, against JPL Horizons within one
//      degree of arc. Reference values: JPL Horizons
//      (https://ssd.jpl.nasa.gov/horizons/, the API, DE441), fetched
//      2026-09-30 with EPHEM_TYPE=OBSERVER, CENTER=coord@399,
//      COORD_TYPE=GEODETIC, QUANTITIES=4 (apparent azimuth and elevation,
//      airless), TIME_TYPE=UT, ANG_FORMAT=DEG, for COMMAND = 10, 301, 199,
//      299, 499, 599, 699, 799, 899 at:
//        San Francisco (122.4194 W, 37.7749 N, 0 m), 2026-09-30 00:00 UT
//          (late afternoon) and 2026-10-01 06:00 UT (night, the Moon up);
//        Sydney (151.2093 E, 33.8688 S, 0 m), 2026-10-01 00:00 UT (morning).
//      The sky adds refraction near the horizon (Saemundsson), a few arcminutes
//      above 10 degrees, which the one-degree budget holds.
//   2. The Moon's lit limb faces the true Sun: the direction from the Moon to
//      the Sun in the observer's own sky (from Horizons' alt/az, by plain
//      spherical geometry) against the turn the sky draws the sprite by.
//   3. The orrery's flat solar system did not move when its orbit code was
//      shared with the sky's three-dimensional one.
//   4. The muon's numbers (Feynman Lectures, Vol. I, ch. 15-4: 2.2 us, 0.998c,
//      15 km) and the light clock's ticks (one tick at rest is gamma ticks
//      moving).
//   5. Twilight by the Sun's altitude, and the faintest star shown.
//   6. Taps: what a tap reaches, which wins, and what it does (the Sun and
//      the Moon open the 3D view on themselves; a planet is named).
//   7. One clock: live, a timer keeps the sky at now; scrubbed, no live
//      timer; motion reduced, no twinkle and no muons; and no frame loop
//      once nothing moves.
//
// Run: node tests/test_almanac_live_sky.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8');
const appSrc = read('app.js'), almSrc = read('almanac.js');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}
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

// Timers and frames are counted, not run: the clock tests read them.
const timers = [], frames = [], opened = [];
const tipEl = { hidden: true, innerHTML: '', style: {}, offsetWidth: 120, offsetHeight: 40, parentElement: { clientWidth: 390, clientHeight: 216 } };
const S = {
  Math, Date, Intl, Object, JSON, console, String, Number, Array, isNaN, isFinite,
  window: {}, performance: { now: () => 1000 },
  document: { hidden: false, documentElement: {}, getElementById: (id) => (id === 'almanac-sky-tip' ? tipEl : null) },
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
for (const fn of ['_dateToJD', '_jdToJulianCentury', '_solveKepler', '_moonPosition', '_moonDistance'])
  vm.runInContext(extractFn(almSrc, fn), S);
vm.runInContext(require('./moon_model.cjs')(), S);
vm.runInContext(read('almanac-orrery.js'), S);
vm.runInContext(read('almanac-sky.js'), S);

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
// Great-circle distance between two alt/az directions, degrees.
function sep(alt1, az1, alt2, az2) {
  const c = Math.sin(alt1 * D2R) * Math.sin(alt2 * D2R) + Math.cos(alt1 * D2R) * Math.cos(alt2 * D2R) * Math.cos((az1 - az2) * D2R);
  return Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
}

// ── 1. Positions against JPL Horizons ──
// [place, lon, lat, UT, { body: [azimuth, elevation] }]
const HORIZONS = [
  ['San Francisco', -122.4194, 37.7749, '2026-09-30T00:00:00Z', {
    Sun: [248.376482, 21.414923], Moon: [21.350605, -27.509286], Mercury: [224.435488, 27.274952],
    Venus: [213.603336, 23.739200], Mars: [306.984903, -10.453625], Jupiter: [290.982708, -1.371911],
    Saturn: [64.744619, -25.811828], Uranus: [2.920576, -31.095125], Neptune: [72.877732, -21.037102] }],
  ['San Francisco', -122.4194, 37.7749, '2026-10-01T06:00:00Z', {
    Sun: [314.372036, -45.950935], Moon: [69.894449, 17.062372], Mercury: [284.401709, -39.055432],
    Venus: [272.684212, -39.192759], Mars: [34.033903, -23.657360], Jupiter: [18.073736, -34.816966],
    Saturn: [130.468430, 42.541784], Uranus: [75.256266, 15.714299], Neptune: [142.069547, 45.312591] }],
  ['Sydney', 151.2093, -33.8688, '2026-10-01T00:00:00Z', {
    Sun: [44.200361, 50.699525], Moon: [287.305427, -22.952501], Mercury: [75.929910, 42.829654],
    Venus: [88.560854, 42.062674], Mars: [321.817940, 25.096427], Jupiter: [337.020572, 37.487841],
    Saturn: [228.729860, -47.167081], Uranus: [284.093646, -17.396740], Neptune: [216.137634, -50.081247] }],
];
const worst = {};
for (const [place, lon, lat, iso, ref] of HORIZONS) {
  const eph = vm.runInContext('_skyEphemeris(new Date(' + JSON.stringify(iso) + '), ' + lat + ', ' + lon + ')', S);
  const ours = { Sun: [eph.sun.az, eph.sun.alt], Moon: [eph.moon.azimuth, eph.moon.altitude] };
  for (const p of eph.planets) ours[p.name] = [p.az, p.alt];
  for (const body of Object.keys(ref)) {
    const d = sep(ours[body][1], ours[body][0], ref[body][1], ref[body][0]);
    worst[body] = Math.max(worst[body] || 0, d);
    check(d < 1, place + ' ' + iso.slice(0, 16) + ' ' + body + ' within 1 deg of Horizons (' + d.toFixed(3) + ' deg)');
  }
}
console.log('worst per body (deg): ' + Object.keys(worst).map((b) => b + ' ' + worst[b].toFixed(3)).join(', '));

// Twilight is counted on the Sun's geometric altitude; the drawn Sun is lifted
// by the air only near the horizon.
const civil = vm.runInContext('_skyEphemeris(new Date("2026-10-01T02:05:00Z"), 37.7749, -122.4194)', S);
check(civil.sunGeoAlt < -0.833 && civil.sunGeoAlt > -6, 'just after sunset in San Francisco is civil twilight (' + civil.sunGeoAlt.toFixed(2) + ' deg)');

// ── 2. The lit limb faces the Sun ──
// In the observer's frame (x north, y east, z up), the Sun's direction from
// the Moon on the sky, counterclockwise from the zenith's side: the turn
// _moonLimbAngles reports as rot, which _moonView's tilt draws.
function vec(az, alt) { return [Math.cos(alt * D2R) * Math.cos(az * D2R), Math.cos(alt * D2R) * Math.sin(az * D2R), Math.sin(alt * D2R)]; }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b, k) => [a[0] - k * b[0], a[1] - k * b[1], a[2] - k * b[2]];
for (const [place, lon, lat, iso, ref] of HORIZONS) {
  const m = vec(ref.Moon[0], ref.Moon[1]), s = vec(ref.Sun[0], ref.Sun[1]);
  const up0 = sub([0, 0, 1], m, m[2]), upLen = Math.sqrt(dot(up0, up0)), up = up0.map((x) => x / upLen);
  const left = cross(m, up), tan = sub(s, m, dot(s, m));
  const want = (Math.atan2(dot(tan, left), dot(tan, up)) * R2D + 360) % 360;
  const got = vm.runInContext('_moonLimbAngles(new Date(' + JSON.stringify(iso) + '), ' + lat + ', ' + lon + ').rot', S);
  const d = Math.abs(((got - want) % 360 + 540) % 360 - 180);
  check(d < 2, place + ' ' + iso.slice(0, 16) + ': the lit limb points at the Sun (' + d.toFixed(2) + ' deg off)');
  const view = vm.runInContext('_moonView(new Date(' + JSON.stringify(iso) + '), ' + lat + ', ' + lon + ')', S);
  check(/_moonView\(now, lat, lon\)/.test(extractFn(read('almanac-sky.js'), '_skyFrame')) && Number.isFinite(view.tilt),
    'the sky turns its Moon by the canonical _moonView');
}

// ── 3. The orrery's flat positions are as they were ──
function oldFlat(name, T) {
  const p = S._PLANETS[name];
  const a = p.a + p.da * T, e = Math.min(Math.max(p.e + p.de * T, 0), 0.99);
  const L = (p.L + p.dL * T) % 360, LP = (p.LP + p.dLP * T) % 360;
  const M = ((L - LP) % 360 + 360) % 360, E = S._solveKepler(M * D2R, e);
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  return [xp * Math.cos(LP * D2R) - yp * Math.sin(LP * D2R), xp * Math.sin(LP * D2R) + yp * Math.cos(LP * D2R)];
}
// Mercury to Mars exactly; Jupiter to Neptune now carry JPL's Table 2b terms
// (their pull on each other), which moved Uranus by most of a degree of its
// orbit toward where Horizons has it, and nothing by more.
let flatWorst = 0, outerWorst = 0;
for (const name of Object.keys(S._PLANETS)) {
  for (const T of [-3, -0.3, 0, 0.267, 1.5]) {
    const now = S._planetPosition(name, T), was = oldFlat(name, T);
    if (S._PLANETS[name].mf) {
      outerWorst = Math.max(outerWorst, Math.abs(((Math.atan2(now.y, now.x) - Math.atan2(was[1], was[0])) * R2D + 540) % 360 - 180));
    } else flatWorst = Math.max(flatWorst, Math.abs(now.x - was[0]), Math.abs(now.y - was[1]));
  }
}
check(flatWorst === 0, 'the orrery draws Mercury to Mars exactly where it did (worst ' + flatWorst + ' AU)');
check(outerWorst > 0.5 && outerWorst < 1.2, 'and the outer planets by at most a degree more truly (' + outerWorst.toFixed(2) + ' deg)');
// The 3D orbit lies on the flat one when seen from above, within the inclination's cosine.
const v3 = S._planetHelio3D('Venus', 0.267), v2 = S._planetPosition('Venus', 0.267);
check(Math.abs(Math.hypot(v3.x, v3.y, v3.z) - v2.r) < 1e-12, 'the 3D orbit keeps the flat one\'s distance from the Sun');

// ── 4. Muons and the light clock ──
const mu = vm.runInContext('_muonFacts()', S);
check(Math.abs(mu.gamma - 15.82) < 0.01, 'gamma at 0.998c is 15.82 (' + mu.gamma.toFixed(3) + ')');
check(Math.abs(mu.fall * 1e6 - 50.13) < 0.01, 'a 15 km fall at 0.998c takes 50.13 us by the ground\'s clock (' + (mu.fall * 1e6).toFixed(3) + ')');
check(Math.abs(mu.own * 1e6 - 3.17) < 0.01, 'and 3.17 us by the muon\'s (' + (mu.own * 1e6).toFixed(3) + ')');
check(Math.abs(mu.reach - 658) < 1, 'without the slow clock a muon goes 658 m in a lifetime (' + mu.reach.toFixed(1) + ')');
check(mu.survive > 0.2 && mu.survive < 0.3 && mu.surviveNaive < 1e-9, 'about a quarter arrive; without it, almost none (' + mu.survive.toFixed(3) + ', ' + mu.surviveNaive.toExponential(2) + ')');
const g = S._lorentzFactor(0.8);
const ticks = S._lcTicks(16001, g);
check(ticks.rest === 10 && ticks.moving === 6, 'light clock at 0.8c: 10 ticks at rest, 6 moving (gamma 5/3)');
check(S._lcBounce(0) === 0 && S._lcBounce(0.5) === 1 && S._lcBounce(0.25) === 0.5 && S._lcBounce(1.25) === 0.5,
  'one tick is the light\'s trip up and back');

// ── 4b. The Sun's face and the air it shines through ──
const ld = (mu) => S._sunLimb(mu);
check(ld(1).every((x) => Math.abs(x - 1) < 1e-4), 'limb darkening is 1 at the centre of the disc in every colour');
check(ld(0)[0] > ld(0)[1] && ld(0)[1] > ld(0)[2] && Math.abs(ld(0)[0] - 0.35) < 0.02 && Math.abs(ld(0)[2] - 0.15) < 0.02,
  'at the limb red keeps 35%, blue 15%: the edge is darker and warmer');
let mono = true;
for (let mu = 0; mu < 1; mu += 0.05) for (let k = 0; k < 3; k++) if (ld(mu + 0.05)[k] < ld(mu)[k]) mono = false;
check(mono, 'and it brightens all the way in');
const tint = (a) => vm.runInContext('_skySunTint(' + a + ')', S);
check(tint(60)[2] > 0.85 && tint(5)[1] < 0.75 && tint(0)[1] < 0.3 && tint(0)[2] < 0.03, 'the Sun is white high up, orange low, red on the horizon');
const flat = (a) => vm.runInContext('_skySunFlattening(' + a + ')', S);
// Touching the horizon (its centre 0.57 deg below it, truly) the Sun is about 27 arcminutes tall by 32 wide (Saemundsson's refraction, Meeus 16.4).
check(flat(30) > 0.995 && flat(-0.57) > 0.78 && flat(-0.57) < 0.86, 'and flattened by refraction only near the horizon (' + flat(-0.57).toFixed(3) + ' as it sets)');
check(/aeLimb\(mu\)/.test(read('almanac-earth.js')) && /SUN_LIMB_POLY/.test(read('almanac-earth.js')),
  'the 3D view\'s photosphere darkens its limb by the same polynomials');

// ── 5. Twilight and the faintest star ──
const phase = (a) => vm.runInContext('_skyPhaseKey(' + a + ')', S);
check(phase(10) === 'alm_sky_day' && phase(-0.5) === 'alm_sky_day' && phase(-3) === 'alm_sky_civil' &&
  phase(-9) === 'alm_sky_nautical' && phase(-15) === 'alm_sky_astro' && phase(-30) === 'alm_sky_night',
  'day, civil, nautical, astronomical twilight and night by the Sun\'s altitude');
const lm = [20, 0, -6, -12, -18, -40].map((a) => vm.runInContext('_skyLimitingMag(' + a + ')', S));
check(lm.every((x, i) => i === 0 || x >= lm[i - 1]) && lm[0] < -3 && lm[5] > 4.5, 'fainter stars come out as the Sun sinks (' + lm.map((x) => x.toFixed(1)).join(', ') + ')');

// ── 6. Taps ──
vm.runInContext('_skyState = { bodies: [' +
  '{ type: "sun", x: 100, y: 100, r: 9, alt: 30, az: 180 },' +
  '{ type: "planet", name: "Venus", x: 112, y: 100, r: 2, alt: 30, az: 182, mag: -4 },' +
  '{ type: "star", idx: 41, x: 300, y: 60, r: 2, alt: 40, az: 200, mag: -1.46 },' +
  '{ type: "planet", name: "Jupiter", x: 300, y: 70, r: 2, alt: 38, az: 200, mag: -2.5 },' +
  '{ type: "moon", x: 200, y: 150, r: 9, alt: 10, az: 150 },' +
  '{ type: "muon", x0: 50, y0: 10, x1: 52, y1: 170 }] }', S);
const hit = (x, y) => { const b = vm.runInContext('_skyHitTest(' + x + ', ' + y + ')', S); return b ? b.type + (b.name ? ':' + b.name : '') : null; };
check(hit(100, 100) === 'sun', 'a tap on the Sun is the Sun');
check(hit(113, 100) === 'planet:Venus', 'beside it, Venus is nearer and wins');
check(hit(300, 64) === 'planet:Jupiter', 'a planet wins over a star at the same reach');
check(hit(300, 40) === 'star', 'a star alone is a star');
check(hit(200, 172) === 'moon', 'the Moon reaches a fingertip beyond its edge');
check(hit(60, 90) === 'muon', 'a muon\'s streak can be tapped along its length');
check(hit(250, 200) === null, 'empty sky is nothing');
// What a tap does: the Sun and the Moon open the 3D view on themselves.
S.window.openAlmanacEarth = (opts) => opened.push(opts);
check(vm.runInContext('_skyAct({ type: "sun" })', S) === 'view' && opened[0].target === 'sun' && opened[0].from === 'sky',
  'the Sun opens the 3D view on the Sun, from the sky');
check(vm.runInContext('_skyAct({ type: "moon" })', S) === 'view' && opened[1].target === 'moon', 'the Moon opens it on the Moon');
S._orreryShowBody = () => {};
check(vm.runInContext('_skyAct({ type: "planet", name: "Jupiter", x: 300, y: 70, r: 2, alt: 38, az: 200, mag: -2.5 })', S) === 'tip' &&
  !tipEl.hidden && /alm_sky_find_orrery/.test(tipEl.innerHTML) && opened.length === 2,
  'a planet is named, with the way to it in the solar system');
vm.runInContext('_skyAct({ type: "muon", x0: 50, y0: 10, x1: 52, y1: 170 })', S);
check(/alm_sky_muon_head/.test(tipEl.innerHTML) && /alm_sky_muon_math/.test(tipEl.innerHTML), 'a muon tells why it reaches the ground');
S.window.openAlmanacEarth.unsupported = true;
check(vm.runInContext('_skyAct({ type: "sun", x: 100, y: 100, r: 9, alt: 30, az: 180 })', S) === 'tip' && opened.length === 2,
  'without WebGL the Sun is named instead');
delete S.window.openAlmanacEarth.unsupported;

// ── 7. One clock ──
vm.runInContext('var _almFocus = null; var _heroMoonAnim = null; var __reduce = false; function _almReduceMotion() { return __reduce; }' +
  'var __painted = 0; _skyPaint = function () { __painted++; };' +
  '_skyState = { inView: true, eph: { sunGeoAlt: -30 }, muons: [], actors: [], bodies: [], moonAnim: null, nowTime: Date.now() };', S);
const SPAWNERS = '_skySpawnBirds,_skySpawnMeteor,_skySpawnPlane';
const armed = () => { timers.length = 0; vm.runInContext('_skyArm()', S); return timers.map((x) => x.fn.name).sort().join(','); };
check(armed() === '_skyLiveTick,_skyMuonTick,' + SPAWNERS + ',_skyTwinkleTick', 'live at night: the clock\'s drift, the twinkle, the muons, the planes, birds and meteors');
vm.runInContext('_almFocus = new Date(0)', S);
check(armed() === '_skyMuonTick,' + SPAWNERS + ',_skyTwinkleTick', 'scrubbed: no live timer, the sky holds the focused instant');
vm.runInContext('_almFocus = null; _skyState.eph.sunGeoAlt = 20', S);
check(armed() === '_skyLiveTick,_skyMuonTick,' + SPAWNERS, 'by day no twinkle (no stars out)');
vm.runInContext('__reduce = true', S);
check(armed() === '_skyLiveTick', 'motion reduced: neither twinkle nor muons');
vm.runInContext('__reduce = false; _skyState.inView = false', S);
check(armed() === '', 'scrolled out of sight: nothing runs');
vm.runInContext('_skyState.inView = true; document.hidden = true', S);
check(armed() === '', 'tab hidden: nothing runs');
vm.runInContext('document.hidden = false', S);
// A live tick moves the sky to now; a scrubbed one never fires its update.
frames.length = 0;
vm.runInContext('_skyState.lat = 37.77; _skyState.lon = -122.42; _skyState.nowTime = 0; _skyLiveTick()', S);
check(Math.abs(vm.runInContext('_skyState.nowTime', S) - Date.now()) < 5000, 'a live tick brings the sky to now');
// The frame loop: one frame paints, and with nothing moving it does not ask for another.
frames.length = 0;
vm.runInContext('_almanacSkyRAF = null; _skyKick(); _skyKick();', S);
check(frames.length === 1, 'two asks while a frame is pending make one frame, never a second loop');
frames[0](2000);
check(frames.length === 1 && vm.runInContext('_almanacSkyRAF', S) === null, 'still: after painting, no frame loop');
vm.runInContext('_skyState.muons = [{ x: 0.5, lean: 0, start: 1990 }]; _skyKick()', S);
frames[1](2000);
check(frames.length === 3, 'a falling muon keeps the loop for its fall');
timers.length = 0;
frames[2](1990 + vm.runInContext('SKY_MUON_FALL_MS', S) + 100);
check(frames.length === 3 && timers.some((x) => x.fn.name === '_skyKick'), 'landed, its trace fades by a few timed paints, not a frame loop');
vm.runInContext('_almanacSkyRAF = null', S);
timers.length = 0;
vm.runInContext('_skyLoop(' + (1990 + vm.runInContext('SKY_MUON_FALL_MS + SKY_MUON_FADE_MS', S) + 1) + ')', S);
check(frames.length === 3 && timers.length === 0, 'and once it has faded nothing is left running');
// A plane crossing: the loop runs while it is on screen, painting at most
// every SKY_ACTOR_FRAME_MS (thirty a second, not sixty), and stops once it has gone.
frames.length = 0;
vm.runInContext('_almanacSkyRAF = null; __painted = 0; _skyState.muons = []; _skyState.baseDirty = false; _skyState.paintedAt = 0;' +
  '_skyState.actors = [{ type: "plane", start: 0, dur: 1000 }];', S);
const step = vm.runInContext('SKY_ACTOR_FRAME_MS', S);
// _skyPaint is the counter here; a real paint drops the plane once its time is up.
vm.runInContext('_skyPaint = function (ts) { __painted++; _skyState.actors = _skyState.actors.filter((a) => ts - a.start <= a.dur); };', S);
for (const ts of [100, 100 + step / 2, 100 + step + 1, 100 + step * 1.5 + 1, 100 + step * 2 + 2]) {
  vm.runInContext('_almanacSkyRAF = null; _skyLoop(' + ts + ')', S);
}
check(vm.runInContext('__painted', S) === 3 && frames.length === 5, 'a plane: a frame each vsync, a paint every other one (' + vm.runInContext('__painted', S) + ' of 5)');
frames.length = 0;
vm.runInContext('_almanacSkyRAF = null; _skyLoop(1200)', S);
check(frames.length === 0 && vm.runInContext('_skyState.actors.length', S) === 0, 'gone from the sky, the loop stops');
// The time machine's frames move the instant without a new loop.
frames.length = 0;
vm.runInContext('_almanacSkyRAF = null; _skyState.moonData = null; _skySetInstant(new Date("2026-10-01T06:00:00Z"))', S);
check(frames.length === 1 && vm.runInContext('_skyState.nowTime', S) === Date.parse('2026-10-01T06:00:00Z') &&
  vm.runInContext('!!_skyState.moonAnim', S), 'a scrub frame takes the new instant and glides the Moon there, one frame asked');

if (failures) { console.error('\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\nall live-sky checks passed');
