// The satellites a scene can draw in its own sky (almanac-sats.js): the worker's `sky` command, which answers where every
// satellite that is up and lit over a place is at an instant, and _asSkyAt, which carries an answer to a later frame.
// The worker is run as the page runs it (its source in a vm with a global `self`), on the catalogue Zimi ships.
//
// Run: node tests/test_almanac_sats_sky.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const root = path.join(__dirname, '..', 'zimi');
const src = fs.readFileSync(path.join(root, 'static', 'almanac-sats.js'), 'utf8');
let failures = 0;
function check(ok, what) { if (!ok) { failures++; console.log('FAIL: ' + what); } else console.log('ok: ' + what); }

function between(from, until) { const a = src.indexOf(from); const b = src.indexOf(until, a); return src.slice(a, b); }
const workerSrc = between('function _asWorkerMain() {', '\n}\n') + '\n}';
const skyAtSrc = between('function _asSkyAt(', '\n}\n') + '\n}';

// The page's own pieces, from the reference table and the file's constants.
const earth = fs.readFileSync(path.join(root, 'static', 'almanac-earth.js'), 'utf8');
const ref = vm.runInNewContext('(' + earth.slice(earth.indexOf('var AE_SATS_REF = ') + 'var AE_SATS_REF = '.length, earth.indexOf('};', earth.indexOf('var AE_SATS_REF = ')) + 1) + ')');   // the repo's own constants table, evaluated in a bare context
const ORIGIN = Date.UTC(2000, 0, 1);

// The worker, started the way a page starts it.
const sb = {}; sb.self = sb; sb.console = console;
sb.importScripts = (u) => vm.runInContext(fs.readFileSync(path.join(root, 'static', 'earth', 'satellite-7.1.0.min.js'), 'utf8'), sb);
vm.createContext(sb);
vm.runInContext('(' + workerSrc + ')()', sb);
function ask(msg) { let out; sb.postMessage = (o) => { out = o; }; sb.self.postMessage = sb.postMessage; sb.self.onmessage({ data: msg }); return out; }

const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'assets', 'satellites-all-snapshot.json.gz'))));
const col = (n) => snap.cols.indexOf(n);
const rows = snap.sats, N = rows.length;
const m = (k) => rows.map((r) => r[col(k)]);
const MU = 398600.4418, RE = 6378.137;
const altKm = (mm, ecc) => Math.cbrt(MU / Math.pow(mm * 2 * Math.PI / 86400, 2)) * (1 - ecc) - RE;
const cand = [], area = [], altCol = [], inc = [];
rows.forEach((r, i) => {
  const mm = r[col('mm')], alt = altKm(mm, r[col('ecc')]), name = r[col('name')];
  if (mm < 11 || alt > ref.leoMaxKm || /^ISS \(/.test(name) && r[col('norad')] !== 25544) return;
  const a = r[col('norad')] === 25544 ? ref.areaM2.iss : r[col('rcs')] >= ref.minRcsM2 ? r[col('rcs')] : /^STARLINK/.test(name) ? ref.areaM2.starlink : 0;
  if (!a) return;
  cand.push(i); area.push(a); altCol.push(alt); inc.push(r[col('inc')]);
});
const bad = ask({
  cmd: 'init', id: 1, sunMag: ref.sunMag, albedo: ref.albedo, sgpUrl: 'x', n: N, radius: 6371, epoch0: ORIGIN,
  epoch: m('epoch'), norad: m('norad'), mm: m('mm'), ecc: m('ecc'), inc: m('inc'), raan: m('raan'), argp: m('argp'), ma: m('ma'), bstar: m('bstar')
});
check(bad.error === undefined && bad.bad < N * 0.05, 'the worker starts on the shipped catalogue (' + bad.bad + ' of ' + N + ' not propagated)');

// New York, the snapshot's own evening: some hours after sunset on the day it was read.
const fetched = Date.parse(snap.fetched);
const place = { lat: 40.71, lon: -74.0 };
const sky = (t, extra) => ask(Object.assign({ cmd: 'sky', id: 2, t: t, dt: 2000, minEl: 0, sunAlt: ref.passSunAlt, magLimit: ref.skyMag, max: 60, cand, area, altKm: altCol, inc }, place, extra || {}));

// Day: nothing (a satellite is not seen against a blue sky).
const noon = Date.UTC(2026, 10, 9, 17, 0, 0);
const day = sky(noon);
check(day.list.length === 0 && day.sunAlt > 10, 'in daylight there are none (the Sun is ' + day.sunAlt.toFixed(0) + ' degrees up)');

// Night: a list, brightest first, each up, lit, within the limit and moving.
let best = null;
for (let h = 0; h < 12 && !best; h++) {
  const t = Date.UTC(2026, 10, 9, 23, 0, 0) + h * 3600e3, r = sky(t);
  if (r.list.length > 3) best = { t, r };
}
check(!!best, 'some hour of the night has satellites over New York');
const L = best.r.list;
check(L.every((e) => e.el >= 0 && e.mag <= ref.skyMag && e.az >= 0 && e.az < 360), 'every one is above the horizon, within the magnitude limit, with an azimuth');
check(L.every((e, k) => k === 0 || L[k - 1].mag <= e.mag), 'brightest first');
check(L.some((e) => Math.abs(e.azRate) + Math.abs(e.elRate) > 0.05), 'they move (degrees a second)');
check(L.length <= 60, 'at most the cap');

// The same sky from the pass maths: a pass found by the worker shows up in the sky at its peak, at the same place.
const ps = ask({ cmd: 'passes', id: 3, lat: place.lat, lon: place.lon, t0: Date.UTC(2026, 10, 9, 22, 0, 0), hours: 14, step: 60, refine: 10, minEl: ref.passMinEl, sunAlt: ref.passSunAlt, magLimit: ref.passMag, cand, area, altKm: altCol, inc });
check(ps.list.length > 0, 'the pass maths finds passes in the same night (' + ps.list.length + ')');
const p = ps.list.slice().sort((u, v) => u.mag - v.mag)[0];
const at = sky(p.peak).list.find((e) => e.i === p.i);
check(!!at && Math.abs(at.el - p.el) < 0.5 && Math.abs(((at.az - p.azP + 540) % 360) - 180) < 0.5, 'the brightest pass is in the sky at its peak, where the pass says (el ' + (at ? at.el.toFixed(1) : '-') + ' vs ' + p.el.toFixed(1) + ')');

// The ISS is one of them when it is over: found from the catalogue's own list of passes.
const iss = rows.findIndex((r) => r[col('norad')] === 25544);
const issPass = ps.list.filter((q) => q.i === iss).sort((u, v) => u.mag - v.mag)[0];
if (issPass) check(!!sky(issPass.peak).list.find((e) => e.i === iss), 'the ISS is in the sky list at its pass');
else console.log('note: no ISS pass in that night');

// _asSkyAt carries an answer forward by its rates and drops what has set.
const skyAt = vm.runInNewContext('(' + skyAtSrc.replace(/^function _asSkyAt/, 'function') + ')');
const ans = { t: 1000, list: [{ az: 359, el: 10, azRate: 0.5, elRate: 0.2 }, { az: 100, el: 1, azRate: 0, elRate: -0.6 }] };
const later = skyAt(ans, 3000);
check(later.length === 1 && Math.abs(later[0].az - 0) < 1e-9 && Math.abs(later[0].el - 10.4) < 1e-9, '_asSkyAt moves by the rates, wraps the azimuth, and drops a satellite that has set');

// Cheap enough for the worker's pace: the first look at a place goes over every candidate, the ones after it skip what is far
// below the horizon (off the main thread either way); and the skipping changes nothing in the answer.
const T = best.t - 40 * 60e3, tt0 = process.hrtime.bigint(), first = sky(T);
const msFirst = Number(process.hrtime.bigint() - tt0) / 1e6, tt1 = process.hrtime.bigint();
let steady = first;
for (let k = 1; k <= 5; k++) steady = sky(T + k * 1000);
const msSteady = Number(process.hrtime.bigint() - tt1) / 5e6;
check(msSteady < msFirst && msSteady < 400, 'a sky for the place costs ' + msFirst.toFixed(0) + ' ms the first time and ' + msSteady.toFixed(0) + ' ms after (' + cand.length + ' candidates)');
sb.self.onmessage({ data: { cmd: 'init', id: 9, sunMag: ref.sunMag, albedo: ref.albedo, sgpUrl: 'x', n: N, radius: 6371, epoch0: ORIGIN, epoch: m('epoch'), norad: m('norad'), mm: m('mm'), ecc: m('ecc'), inc: m('inc'), raan: m('raan'), argp: m('argp'), ma: m('ma'), bstar: m('bstar') } });
const fresh = sky(T + 5000);
check(JSON.stringify(fresh.list.map((e) => e.i)) === JSON.stringify(steady.list.map((e) => e.i)), 'the same satellites with and without the skipping (' + fresh.list.length + ')');

process.exit(failures ? 1 : 0);
