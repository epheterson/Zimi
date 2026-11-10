// The launch maths in a bare vm (almanac-launchflight.js on the constants almanac-earth.js defines), the shipped launch history, and
// helpers to turn a history row into the launch object the maths takes. Used by the there-and-then builder and its test.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const STATIC = path.join(ROOT, 'zimi', 'static');
const earthSrc = fs.readFileSync(path.join(STATIC, 'almanac-earth.js'), 'utf8');

function block(name) {
  const a = earthSrc.indexOf('var ' + name + ' = ');
  let i = earthSrc.indexOf('{', a), d = 0;
  for (; i < earthSrc.length; i++) {
    if (earthSrc[i] === '{') d++;
    else if (earthSrc[i] === '}' && --d === 0) return earthSrc.slice(a, i + 1) + ';';
  }
  throw new Error(name);
}
function line(n) { return new RegExp('^var ' + n + ' = [^;]+;', 'm').exec(earthSrc)[0]; }

const S = { Math, Date, Object, JSON, console, Number, Array, isNaN, Int32Array, Float64Array };
vm.createContext(S);
vm.runInContext(['AE_EARTH_RADIUS_KM', 'AE_GM_EARTH'].map(line).join('\n') + '\nvar MS_PER_DAY = 86400000;' + block('AE_SATS_REF') + block('AE_LAUNCH_REF'), S);
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-launchflight.js'), 'utf8'), S);
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'zimi', 'assets', 'launches-snapshot.json.gz'))));

function launch(tag) {
  const r = snap.l.filter((x) => x[15] === tag)[0];
  if (!r) throw new Error('no launch ' + tag);
  const pad = snap.pads[r[2]];
  return { tag, ms: r[0] * 60000, name: snap.veh[r[1]], mission: r[3], ok: !!r[4], perigeeKm: r[5], apogeeKm: r[6], incDeg: r[7], n: r[9], sepMin: r[11], odays: r[12], operi: r[13], oapo: r[14], lat: pad[3], lon: pad[4], siteName: pad[2], padName: pad[1] };
}
function ascent(L) { return S._lfAscent({ name: L.name, lat: L.lat, lon: L.lon, siteName: L.siteName, incDeg: L.incDeg, perigeeKm: L.perigeeKm, ok: L.ok }); }
// The height a batch is let go at (almanac-launches.js _alDeployKm).
function depKm(L) {
  const near = L.operi != null && L.oapo != null && L.odays != null && Math.abs(L.odays) <= 4;
  const km = near ? (L.operi + L.oapo) / 2 : L.perigeeKm != null && L.apogeeKm != null ? (L.perigeeKm + L.apogeeKm) / 2 : 300;
  return Math.max(200, Math.min(2000, km));
}
function deploy(L, f) { return S._lfDeploy({ mission: L.mission, inc: L.incDeg, n: Math.min(L.n, 130), depKm: depKm(L) }, f, L.ms, L.sepMin); }

module.exports = { S, snap, launch, ascent, deploy, STATIC, ROOT };
