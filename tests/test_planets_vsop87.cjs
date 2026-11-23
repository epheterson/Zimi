// Every planet where JPL Horizons has it, through the one function the 3D view, the orrery and the sky draw it with
// (almanac-ephem.js _ephBodyJ2000, VSOP87D from almanac-vsop87.js), at dates the missions fly: Apollo 11, the Voyagers'
// launch and flybys, Perseverance's landing, and now. Horizons: tests/data/planets-horizons.json (geometric, Sun-centred,
// J2000 ecliptic). Before VSOP87D the planets came from JPL's approximate elements: Mars 49,500 km off at its 2021 arrival.
const vm = require('vm'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const ctx = { console, Math, Date, window: {}, document: { getElementById() { return null; }, addEventListener() {}, createElement() { return {}; } }, navigator: {}, localStorage: { getItem() { return null; } } };
vm.createContext(ctx);
vm.runInContext('var SK = {};', ctx);
for (const f of ['almanac-orrery.js', 'almanac.js', 'almanac-vsop87.js', 'almanac-ephem.js']) {
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, 'zimi', 'static', f), 'utf8'), ctx, { filename: f }); } catch (e) { if (f !== 'almanac.js') throw e; }
}
const AU = 149597870.7, ARCSEC = Math.PI / 180 / 3600;
// VSOP87D truncated to 1" a series, against DE440 through Horizons: what the series and the truncation leave
const TOL_ARCSEC = 2.0, TOL_R = 2.0 * ARCSEC;
const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'data', 'planets-horizons.json'), 'utf8'));
let worst = {}, fails = [];
for (const [name, ut, jd, x, y, z] of truth.data) {
  const h = vm.runInContext(`_ephBodyJ2000(${JSON.stringify(name)}, ${jd})`, ctx).map(v => v * AU);
  const rt = Math.hypot(x, y, z), rh = Math.hypot(...h);
  const ang = Math.acos(Math.min(1, (h[0] * x + h[1] * y + h[2] * z) / (rt * rh))) / ARCSEC, dr = Math.abs(rh - rt) / rt;
  worst[name] = Math.max(worst[name] || 0, ang);
  if (ang > TOL_ARCSEC || dr > TOL_R) fails.push(`${name} ${ut}: ${ang.toFixed(2)}" off, ${(rh - rt).toFixed(0)} km in distance`);
}
for (const n in worst) console.log(`ok-ish: ${n} worst ${worst[n].toFixed(2)}"`);
if (!vm.runInContext("typeof EPH_VSOP87D !== 'undefined' && Object.keys(EPH_VSOP87D).length === 7", ctx)) fails.push('almanac-vsop87.js did not define the seven planets');
// The Almanac's first paint draws the sky before the coefficients come: the page's own files (no ephemeris) must place every planet (its
// private Keplerian fallback), never throw, and the same call must turn precise once the ephemeris is here.
const bare = { console, Math, Date, window: {}, document: { getElementById() { return null; }, addEventListener() {}, createElement() { return {}; } }, navigator: {}, localStorage: { getItem() { return null; } } };
vm.createContext(bare);
vm.runInContext('var SK = {};', bare);
for (const f of ['almanac-orrery.js', 'almanac.js']) {   // the first paint's files (almanac.js: Kepler's equation); not the ephemeris
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, 'zimi', 'static', f), 'utf8'), bare, { filename: f }); } catch (e) { if (f !== 'almanac.js') throw e; }
}
for (const n of ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']) {
  const p = vm.runInContext(`_planetHelio3D(${JSON.stringify(n)}, 0.2687)`, bare);
  if (!(isFinite(p.x) && isFinite(p.y) && isFinite(p.z) && Math.hypot(p.x, p.y, p.z) > 0.3)) fails.push(`without the coefficients ${n} has no place: ${JSON.stringify(p)}`);
}
const kepler = vm.runInContext("_planetHelio3D('Mars', 0.2112)", bare), precise = vm.runInContext("_planetHelio3D('Mars', 0.2112)", ctx);
const apartKm = Math.hypot(kepler.x - precise.x, kepler.y - precise.y, kepler.z - precise.z) * AU;
if (!(apartKm > 1000)) fails.push(`_planetHelio3D did not turn to VSOP87D once loaded (fallback and precise ${apartKm.toFixed(0)} km apart)`);
else console.log(`ok: _planetHelio3D falls back to the elements before the coefficients come, VSOP87D after (Mars ${apartKm.toFixed(0)} km apart)`);
if (fails.length) { console.error('FAIL\n' + fails.join('\n')); process.exit(1); }
console.log('all passed');
