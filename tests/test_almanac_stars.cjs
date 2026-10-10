// The 3D Earth view's star sky (zimi/static/almanac-earth.js _aeDecodeStars,
// _aeStarField; the data is zimi/static/earth/stars-v1.bin, packed by
// scripts/build_star_catalog.py from the Yale Bright Star Catalogue).
//
//   1. The decoder puts Sirius, Polaris, Vega and Betelgeuse where the
//      catalogue (SIMBAD, J2000) does, within 0.1 degree; refuses a file that
//      is not this format; reads a star with no B-V as a neutral one.
//   2. The frame: ecliptic longitude and latitude of Regulus, Spica, Antares
//      and Aldebaran, Orion's belt, the Big Dipper and the Southern Cross, from
//      the decoded positions and the J2000 obliquity, against published values.
//   3. The Sun and the Moon against those stars: the Sun at Regulus in late
//      August, the Moon beside Spica on 2025-04-13 and past Regulus in May.
//   4. Faint stars read as dust: size and alpha fall with magnitude, the
//      brightest stay dominant, and no size is below one CSS pixel.
//   5. The 2D Almanac never asks for the catalogue: only the 3D view's loader
//      names the file.
//
// Run: node tests/test_almanac_stars.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8').replace(/\r\n/g, '\n');
let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}

const S = { Math, Date, Intl, Object, JSON, console, String, Number, Array, isNaN, Float32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer,
  window: {}, document: { getElementById: () => null } };
vm.createContext(S);
vm.runInContext('var JD_UNIX_EPOCH = 2440587.5; var JD_J2000 = 2451545.0; var MS_PER_DAY = 86400000;' +
  'var JULIAN_CENTURY = 36525; var DEG_TO_RAD = Math.PI / 180; function t(k) { return k; }', S);
const almSrc = read('almanac.js');
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('function ' + name + ' not found');
}
for (const fn of ['_dateToJD', '_jdnToGregorian', '_cnDeltaTdays']) vm.runInContext(extractFn(almSrc, fn), S);
vm.runInContext(read('almanac-orrery.js'), S);
vm.runInContext(require('./moon_model.cjs')(), S);
vm.runInContext(read('almanac-earth.js'), S);

const DEG = 180 / Math.PI;
const file = fs.readFileSync(path.join(STATIC, 'earth', 'stars-v1.bin'));
const buf = file.buffer.slice(file.byteOffset, file.byteOffset + file.length);
const cat = S._aeDecodeStars(buf);
const star = {};
const dirOf = (i) => { cat.at(i, star); return S._aeEqVec(star.ra, star.dec, 1); };
const sepDeg = (a, b) => S._aeAngle(a, b) * DEG;
const radec = (hours, dec) => S._aeEqVec(hours * 15 / DEG, dec / DEG, 1);   // decimal hours, degrees
// The star nearest a place.
function nearest(v) {
  let best = -1, bestSep = 1e9;
  for (let i = 0; i < cat.count; i++) { const s = sepDeg(dirOf(i), v); if (s < bestSep) { bestSep = s; best = i; } }
  cat.at(best, star);
  return { sep: bestSep, mag: star.mag, ci: star.ci, i: best };
}

// ── 1. The decoder ───────────────────────────────────────────────────────
check(cat && cat.count === 9096, 'the catalogue holds 9,096 stars (' + (cat && cat.count) + ')');
for (const [name, hours, dec, mag] of [
  ['Sirius', 6 + 45 / 60 + 8.917 / 3600, -(16 + 42 / 60 + 58.02 / 3600), -1.46],
  ['Polaris', 2 + 31 / 60 + 49.09 / 3600, 89 + 15 / 60 + 50.8 / 3600, 1.98],
  ['Vega', 18 + 36 / 60 + 56.34 / 3600, 38 + 47 / 60 + 1.29 / 3600, 0.03],
  ['Betelgeuse', 5 + 55 / 60 + 10.31 / 3600, 7 + 24 / 60 + 25.4 / 3600, 0.42],
]) {
  const n = nearest(radec(hours, dec));
  check(n.sep < 0.1 && Math.abs(n.mag - mag) < 0.1, name + ' decodes within 0.1 degree (' + n.sep.toFixed(4) + ') at magnitude ' + n.mag.toFixed(2));
}
check(S._aeDecodeStars(buf.slice(0, buf.byteLength - 1)) === null, 'a truncated file is refused');
check(S._aeDecodeStars(new ArrayBuffer(2)) === null && S._aeDecodeStars(null) === null, 'a stub or nothing is refused');
{
  const wrong = new Uint8Array(buf.slice(0)); wrong[2] = 9;
  check(S._aeDecodeStars(wrong.buffer) === null, 'another format version is refused');
}
{
  let none = 0, ok = true;
  for (let i = 0; i < cat.count; i++) {
    cat.at(i, star);
    if (star.ci === S.AE_STAR_COLOR_DEFAULT) none++;
    if (!(star.ci > -1 && star.ci < 3)) ok = false;
  }
  check(ok && none > 0 && none < 500, 'every colour index is plausible; the few with none read as neutral (' + none + ')');
}

// ── 2. The frame, against published ecliptic coordinates (J2000) ─────────
const EPS = 23.4392911 / DEG;
function ecliptic(v) {
  const y = v[1] * Math.cos(EPS) + v[2] * Math.sin(EPS), z = -v[1] * Math.sin(EPS) + v[2] * Math.cos(EPS);
  return { lon: (Math.atan2(y, v[0]) * DEG + 360) % 360, lat: Math.asin(z) * DEG };
}
function placed(name, hours, dec, lon, lat, tol, lonTol) {
  const n = nearest(radec(hours, dec));
  cat.at(n.i, star);
  const e = ecliptic(S._aeEqVec(star.ra, star.dec, 1));
  check(n.sep < 0.05 && Math.abs(e.lon - lon) < (lonTol || tol) && Math.abs(e.lat - lat) < tol,
    name + ' sits at ecliptic ' + e.lon.toFixed(2) + ', ' + e.lat.toFixed(2) + ' (published ' + lon + ', ' + lat + ')');
}
placed('Regulus', 10.13953, 11.96721, 149.83, 0.46, 0.1);
placed('Spica', 13.41988, -11.16132, 203.84, -2.05, 0.1);
placed('Antares', 16.49013, -26.43200, 249.76, -4.57, 0.1);
placed('Aldebaran', 4.59868, 16.50930, 69.79, -5.47, 0.1);
placed('Pollux', 7.75526, 28.02620, 113.22, 6.68, 0.1);
placed('Dubhe (Big Dipper)', 11.06213, 61.75100, 135.2, 49.7, 0.5, 0.5);
placed('Acrux (Southern Cross)', 12.44330, -63.09909, 222.2, -52.4, 0.5);
{
  // Orion's belt: Mintaka, Alnilam, Alnitak in a row, 2.7 degrees end to end;
  // the Cross's long arm (Gacrux to Acrux) is 6 degrees; the Dipper 25.7
  // from Dubhe to Alkaid.
  const a = dirOf(nearest(radec(5.53, -0.30)).i), b = dirOf(nearest(radec(5.60356, -1.20192)).i), c = dirOf(nearest(radec(5.679, -1.943)).i);
  check(Math.abs(sepDeg(a, c) - 2.7) < 0.2 && Math.abs(sepDeg(a, b) + sepDeg(b, c) - sepDeg(a, c)) < 0.05, 'the belt is three stars in a line, 2.7 degrees long');
  const gacrux = dirOf(nearest(radec(12.51943, -57.11321)).i), acrux = dirOf(nearest(radec(12.44330, -63.09909)).i);
  check(Math.abs(sepDeg(gacrux, acrux) - 6.0) < 0.2, 'the Southern Cross is 6 degrees from Gacrux to Acrux');
  const dubhe = dirOf(nearest(radec(11.06213, 61.751)).i), alkaid = dirOf(nearest(radec(13.79234, 49.31326)).i);
  check(Math.abs(sepDeg(dubhe, alkaid) - 25.7) < 0.5, 'the Big Dipper spans 25.7 degrees, bowl to handle');
}

// ── 3. The Sun and the Moon against the stars ────────────────────────────
const regulus = dirOf(nearest(radec(10.13953, 11.96721)).i), spica = dirOf(nearest(radec(13.41988, -11.16132)).i);
{
  // The Sun passes Regulus around 22 August (ecliptic longitude 149.83 plus
  // the 0.35 degrees of precession since J2000).
  const sun = S._aeSceneAt(Date.UTC(2025, 7, 22, 12)).sun;
  check(sepDeg(sun, regulus) < 1.5, 'on 22 August the Sun is at Regulus (' + sepDeg(sun, regulus).toFixed(2) + ' degrees)');
  const orion = dirOf(nearest(radec(5.92, 7.41)).i);
  check(sepDeg(S._aeSceneAt(Date.UTC(2025, 11, 21, 12)).sun, orion) > 100, 'at the December solstice the Sun is far from Orion');
}
function closest(fromMs, toMs, target) {
  let best = { sep: 1e9, ms: 0 };
  for (let ms = fromMs; ms <= toMs; ms += 600000) {
    const sep = sepDeg(S._aeNorm(S._aeSceneAt(ms).moon), target);
    if (sep < best.sep) best = { sep, ms };
  }
  return best;
}
{
  // The full Moon of 13 April 2025 (00:22 UT) stood beside Spica.
  const near = closest(Date.UTC(2025, 3, 11), Date.UTC(2025, 3, 15), spica);
  console.log('   Moon nearest Spica: ' + near.sep.toFixed(2) + ' degrees at ' + new Date(near.ms).toISOString());
  check(near.sep < 5 && Math.abs(near.ms - Date.UTC(2025, 3, 13)) < 1.5 * 86400000,
    'the Moon passes Spica ' + near.sep.toFixed(1) + ' degrees away, with the April full Moon');
  const regPass = closest(Date.UTC(2025, 4, 1), Date.UTC(2025, 4, 31), regulus);
  console.log('   Moon nearest Regulus: ' + regPass.sep.toFixed(2) + ' degrees at ' + new Date(regPass.ms).toISOString());
  check(regPass.sep < 8, 'and passes Regulus ' + regPass.sep.toFixed(1) + ' degrees away in May 2025');
}

// ── 4. The look ──────────────────────────────────────────────────────────
{
  const size = (m) => Math.max(S.AE_STAR_SIZE_MIN, S.AE_STAR_SIZE0 - S.AE_STAR_SIZE_PER_MAG * m);
  const alpha = (m) => Math.min(1, Math.max(S.AE_STAR_ALPHA_MIN, S.AE_STAR_ALPHA0 - S.AE_STAR_ALPHA_PER_MAG * m));
  check(size(6.5) <= 1.0 && size(5) <= 1.5, 'stars of magnitude 5 to 6.5 are about a pixel across (' + size(5).toFixed(2) + ', ' + size(6.5).toFixed(2) + ')');
  check(alpha(6.5) <= 0.3 && alpha(5) < 0.5 && alpha(-1.46) === 1, 'faint stars are a dim dust; Sirius is full strength');
  check(size(-1.46) > 3 * size(6) && alpha(1) > 3 * alpha(6), 'the bright stars dominate in size and in light');
  let monotone = true;
  for (let m = -1.5; m < 7; m += 0.1) if (size(m + 0.1) > size(m) || alpha(m + 0.1) > alpha(m)) monotone = false;
  check(monotone, 'brighter is never smaller or dimmer');
}

// ── 5. Only the 3D view asks ─────────────────────────────────────────────
{
  const dirs = fs.readdirSync(STATIC).filter((f) => /\.(js|html|css)$/.test(f));
  const named = dirs.concat(['../templates/index.html']).filter((f) => /stars-v1/.test(read(f)));
  check(named.length === 1 && named[0] === 'almanac-earth.js', 'only almanac-earth.js names the catalogue (' + named.join(', ') + ')');
  const src = read('almanac-earth.js');
  const callers = src.split('\n').filter((l) => /_aeLoadStars\(/.test(l) && !/^function/.test(l));
  check(callers.length === 1 && /function _aeLoadMaps\(S\) \{\n  _aeLoadStars\(S\);/.test(src),
    'and only the 3D view\'s map loader calls its loader');
  check(!/stars-v1/.test(read('sw.js')), 'and the service worker does not precache it');
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
