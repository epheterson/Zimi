// The Almanac's tide predictions (zimi/static/almanac-tides.js) against NOAA's
// own published predictions, for the harmonic constants Zimi ships
// (zimi/assets/tides-snapshot.json.gz).
//
// Reference: NOAA CO-OPS Data API, product=predictions, interval=hilo,
// datum=MLLW, units=metric, time_zone=gmt, fetched 2026-10-01 from
//   https://api.tidesandcurrents.noaa.gov/api/prod/datagetter
// for 1-2 Oct 2026 and 10-11 Mar 2031 (a different year, so a different set
// of nodal factors). Times are UTC as YYMMDDHHMM, heights metres above MLLW.
// Nine harmonic stations across the Atlantic, Gulf, Pacific, Hawaii and
// Alaska coasts (mixed, semidiurnal and diurnal tides; Anchorage has the
// largest range in the US and NOAA predicts it with 114 constituents), and
// two subordinate stations (a ratio offset and an additive one in feet).
//
// Run: node tests/test_almanac_tides.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'zimi', 'static', 'almanac-tides.js'), 'utf8');
// In this context, not a fresh one: a contextified global makes every Math
// call inside the synthesis loop many times slower.
const S = vm.runInThisContext('(function () {\n' + src + '\nreturn { TideMath: TideMath };\n})')();
const TM = S.TideMath;
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'zimi', 'assets', 'tides-snapshot.json.gz'))));
const byId = {};
snap.stations.forEach(s => { byId[s.id] = s; });

const NOAA = {
  '9414290': [['2610010400', -0.08, 'L'], ['2610011124', 1.346, 'H'], ['2610011536', 0.948, 'L'], ['2610012158', 1.896, 'H'], ['2610020504', -0.057, 'L'], ['2610021247', 1.316, 'H'], ['2610021641', 1.049, 'L'], ['2610022258', 1.833, 'H'], ['3103100121', 0.16, 'L'], ['3103100800', 1.687, 'H'], ['3103101349', 0.202, 'L'], ['3103102015', 1.572, 'H'], ['3103110153', 0.256, 'L'], ['3103110830', 1.741, 'H'], ['3103111430', 0.117, 'L'], ['3103112103', 1.495, 'H']],
  '8518750': [['2610010344', 1.417, 'H'], ['2610010949', 0.12, 'L'], ['2610011602', 1.702, 'H'], ['2610012256', 0.189, 'L'], ['2610020451', 1.36, 'H'], ['2610021045', 0.205, 'L'], ['2610021709', 1.647, 'H'], ['3103100122', 1.499, 'H'], ['3103100752', -0.149, 'L'], ['3103101333', 1.453, 'H'], ['3103102010', -0.148, 'L'], ['3103110156', 1.533, 'H'], ['3103110833', -0.161, 'L'], ['3103111411', 1.426, 'H'], ['3103112046', -0.136, 'L']],
  '8443970': [['2610010046', -0.149, 'L'], ['2610010656', 2.952, 'H'], ['2610011258', 0.167, 'L'], ['2610011908', 3.338, 'H'], ['2610020139', -0.063, 'L'], ['2610020750', 2.837, 'H'], ['2610021352', 0.277, 'L'], ['2610022004', 3.25, 'H'], ['3103100434', 3.07, 'H'], ['3103101043', -0.125, 'L'], ['3103101654', 3.102, 'H'], ['3103102303', -0.114, 'L'], ['3103110512', 3.155, 'H'], ['3103111125', -0.189, 'L'], ['3103111735', 3.091, 'H'], ['3103112344', -0.115, 'L']],
  '9447130': [['2610010218', 3.355, 'H'], ['2610010928', -0.51, 'L'], ['2610011638', 3.294, 'H'], ['2610012154', 2.217, 'L'], ['2610020258', 3.219, 'H'], ['2610021021', -0.447, 'L'], ['2610021753', 3.222, 'H'], ['2610022304', 2.42, 'L'], ['3103100102', 3.18, 'H'], ['3103100710', 0.591, 'L'], ['3103101325', 3.534, 'H'], ['3103101941', 0.546, 'L'], ['3103110147', 3.225, 'H'], ['3103110747', 0.819, 'L'], ['3103111354', 3.563, 'H'], ['3103112019', 0.276, 'L']],
  '8724580': [['2610010455', 0.732, 'H'], ['2610011151', 0.07, 'L'], ['2610011841', 0.424, 'H'], ['2610012246', 0.293, 'L'], ['2610020546', 0.718, 'H'], ['2610021302', 0.102, 'L'], ['2610021958', 0.388, 'H'], ['2610022336', 0.316, 'L'], ['3103100325', 0.438, 'H'], ['3103100858', -0.019, 'L'], ['3103101530', 0.453, 'H'], ['3103102122', -0.105, 'L'], ['3103110407', 0.41, 'H'], ['3103110928', -0.005, 'L'], ['3103111603', 0.474, 'H'], ['3103112206', -0.123, 'L']],
  '1612340': [['2610010013', 0.187, 'L'], ['2610010357', 0.253, 'H'], ['2610010949', 0.034, 'L'], ['2610011755', 0.659, 'H'], ['2610020205', 0.178, 'L'], ['2610020455', 0.197, 'H'], ['2610021037', 0.064, 'L'], ['2610021911', 0.652, 'H'], ['3103100241', 0.431, 'H'], ['3103100842', -0.002, 'L'], ['3103101440', 0.432, 'H'], ['3103102055', -0.059, 'L'], ['3103110321', 0.464, 'H'], ['3103110931', 0.025, 'L'], ['3103111511', 0.38, 'H'], ['3103112122', -0.062, 'L']],
  '8771450': [['2610010302', 0.601, 'H'], ['2610011906', 0.029, 'L'], ['2610020451', 0.61, 'H'], ['2610022013', 0.03, 'L'], ['3103100416', 0.064, 'L'], ['3103101056', 0.308, 'H'], ['3103101639', 0.101, 'L'], ['3103102249', 0.268, 'H'], ['3103110453', 0.02, 'L'], ['3103111155', 0.318, 'H'], ['3103111714', 0.157, 'L'], ['3103112300', 0.273, 'H']],
  '9455920': [['2610010040', 1.235, 'L'], ['2610010606', 9.635, 'H'], ['2610011328', -0.04, 'L'], ['2610011903', 8.521, 'H'], ['2610020118', 1.737, 'L'], ['2610020648', 9.169, 'H'], ['2610021414', 0.297, 'L'], ['2610022000', 8.06, 'H'], ['3103100429', 9.423, 'H'], ['3103101117', -0.074, 'L'], ['3103101649', 9.465, 'H'], ['3103102339', -0.214, 'L'], ['3103110506', 9.419, 'H'], ['3103111151', 0.073, 'L'], ['3103111718', 9.56, 'H']],
  '8665530': [['2610010326', 1.647, 'H'], ['2610010938', 0.106, 'L'], ['2610011558', 1.965, 'H'], ['2610012234', 0.319, 'L'], ['2610020425', 1.59, 'H'], ['2610021035', 0.161, 'L'], ['2610021703', 1.924, 'H'], ['2610022339', 0.366, 'L'], ['3103100110', 1.664, 'H'], ['3103100724', -0.153, 'L'], ['3103101321', 1.622, 'H'], ['3103101935', -0.136, 'L'], ['3103110146', 1.702, 'H'], ['3103110808', -0.151, 'L'], ['3103111359', 1.598, 'H'], ['3103112014', -0.151, 'L']],
  '1610367': [['2610010002', 0.144, 'L'], ['2610010341', 0.195, 'H'], ['2610010938', 0.026, 'L'], ['2610011739', 0.507, 'H'], ['2610020154', 0.137, 'L'], ['2610020439', 0.152, 'H'], ['2610021026', 0.049, 'L'], ['2610021855', 0.502, 'H'], ['3103100225', 0.332, 'H'], ['3103100831', -0.002, 'L'], ['3103101424', 0.333, 'H'], ['3103102044', -0.045, 'L'], ['3103110305', 0.358, 'H'], ['3103110920', 0.019, 'L'], ['3103111455', 0.293, 'H'], ['3103112111', -0.048, 'L']],
  '8518989': [['2610010654', 0.114, 'L'], ['2610011153', 1.311, 'H'], ['2610011830', 0.073, 'L'], ['2610012350', 1.618, 'H'], ['2610020752', 0.145, 'L'], ['2610021301', 1.268, 'H'], ['2610021929', 0.121, 'L'], ['3103100407', 0.152, 'L'], ['3103100926', 1.717, 'H'], ['3103101630', 0.148, 'L'], ['3103102133', 1.601, 'H'], ['3103110445', 0.166, 'L'], ['3103110953', 1.76, 'H'], ['3103111716', 0.161, 'L'], ['3103112211', 1.59, 'H']],
};
// What "agrees with NOAA" means here. NOAA rounds to the minute and the
// millimetre; the rest is ours. Every turn must be within the outer bound,
// and the typical (mean absolute) error within the inner one.
const MAX_MIN = 10, MAX_M = 0.05, MEAN_MIN = 3, MEAN_M = 0.02;

function utc(s) {
  return Date.UTC(2000 + +s.slice(0, 2), +s.slice(2, 4) - 1, +s.slice(4, 6), +s.slice(6, 8), +s.slice(8, 10));
}

let failures = 0;
const check = (ok, label) => { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); };

for (const id of Object.keys(NOAA)) {
  const st = byId[id];
  if (!st) { check(false, id + ' is in the snapshot'); continue; }
  const p = TM.predictor(st, snap.constituents, st.ref ? byId[st.ref] : null);
  const dt = [], dh = [];
  for (const [ts, h, type] of NOAA[id]) {
    const t = utc(ts);
    const near = p.extremes(t - 3 * 3600e3, t + 3 * 3600e3).filter(e => e.high === (type === 'H'));
    if (!near.length) { check(false, `${id} ${ts}: a ${type} near NOAA's`); continue; }
    near.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t));
    dt.push(Math.abs(near[0].t - t) / 60000);
    dh.push(Math.abs(near[0].h - h));
  }
  const max = a => Math.max(...a), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const label = `${id} ${st.n}${st.ref ? ' (subordinate)' : ''}: ${dt.length} turns, ` +
    `time max ${max(dt).toFixed(1)} min mean ${mean(dt).toFixed(1)}, height max ${(max(dh) * 100).toFixed(1)} cm mean ${(mean(dh) * 100).toFixed(1)}`;
  check(dt.length === NOAA[id].length && max(dt) <= MAX_MIN && max(dh) <= MAX_M && mean(dt) <= MEAN_MIN && mean(dh) <= MEAN_M, label);
}

// Every additional constituent NOAA lists anywhere is rebuilt from its name
// (or skipped on purpose): an unknown one would silently drop a term.
const unknown = new Set();
snap.stations.forEach(s => Object.keys(s.x || {}).forEach(n => { if (!TM.compoundOf(n, s.x[n][2])) unknown.add(n); }));
check(unknown.size === 0, 'every additional constituent decodes' + (unknown.size ? ': ' + [...unknown].join(' ') : ''));

// A compound's arguments follow its name: 2MS6 = 2 M2 + S2.
const c = TM.compoundOf('2MS6', 87.9682084);
check(c && c[0].join() === '6,2,-2,0,0,0', '2MS6 is twice M2 plus S2');

// Stations far from any NOAA prediction still predict: every harmonic station
// gives a full day of finite water with at least one turn.
let bad = 0;
const day0 = Date.UTC(2026, 9, 1);
snap.stations.forEach(s => {
  const p = TM.predictor(s, snap.constituents, s.ref ? byId[s.ref] : null);
  const turns = p.extremes(day0, day0 + 86400e3);
  if (!turns.length || turns.some(e => !isFinite(e.h))) bad++;
});
check(bad === 0, `all ${snap.stations.length} stations predict a day (${bad} without)`);

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
