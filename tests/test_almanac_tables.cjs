// The Almanac's Tables and Calculations (zimi/static/almanac-tables.js): the
// sums each calculation shows, against known answers, and the time windows
// the tables are drawn over.
//
//   1. Distance and bearing: San Francisco to New York on the great circle
//      (about 4,130 km, setting off near 70°).
//   2. Units: exact factors (100 °F = 37.78 °C, 1 mi = 1.609344 km, the
//      round trip of every unit through every other).
//   3. Days: ISO week numbers, day of the year, years-months-days between.
//   4. Angles typed any common way.
//   5. The windows: a week, a month, a year and a range have the days they
//      should, and stepping moves them by their own length.
//   6. Sight reduction, sundial and the Sun and Moon on a day, worked by the
//      same functions the screens use, from the reference test's values.
//
// Run: node tests/test_almanac_tables.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}
function stubStorage() { return { getItem() { return null; }, setItem() {}, removeItem() {} }; }
const S = {
  console, Math, Date, Intl, Object, JSON, String, Number, Array, isNaN, isFinite, parseInt, parseFloat,
  setTimeout, clearTimeout, requestAnimationFrame() {}, cancelAnimationFrame() {},
  window: { addEventListener() {} }, localStorage: stubStorage(), sessionStorage: stubStorage(),
  document: { getElementById: () => null, querySelector: () => null, addEventListener() {}, documentElement: { classList: { add() {}, remove() {} }, dir: '' }, body: {} },
  navigator: { language: 'en-GB' }, location: { hash: '' }, Image: function () {}, addEventListener() {},
  matchMedia() { return { matches: false, addEventListener() {} }; }
};
vm.createContext(S);
vm.runInContext('var _currentLang = "en"; function t(k, v) { var s = k; if (v) for (var x in v) s += "|" + v[x]; return s; } function tPlural(b, n) { return n + " " + b; } var _almanacOpen = false;', S);
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-orrery.js'), 'utf8'), S);
vm.runInContext(require('./moon_model.cjs')(), S);
for (const f of ['almanac.js', 'almanac-earth.js', 'almanac-navdata.js', 'almanac-reference.js', 'almanac-tables.js']) {
  vm.runInContext(fs.readFileSync(path.join(STATIC, f), 'utf8'), S);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ── 1. Great circle ──
{
  const sf = S._tbMakePlace(37.7749, -122.4194, 'San Francisco', true);
  const ny = S._tbMakePlace(40.7128, -74.006, 'New York', true);
  const g = S._tbGreatCircle(sf, ny);
  check(near(g.km, 4130, 10), 'San Francisco to New York ' + g.km.toFixed(1) + ' km (about 4,130)');
  check(near(g.initial, 69.9, 1), 'setting off on ' + g.initial.toFixed(1) + '° (about 70°)');
  const back = S._tbGreatCircle(ny, sf);
  check(near(back.km, g.km, 1e-6), 'the same distance either way');
  const ldn = S._tbMakePlace(51.5074, -0.1278, 'London', true);
  check(near(S._tbGreatCircle(sf, ldn).km, 8616, 15), 'San Francisco to London about 8,616 km');
  // The calculation's own answer, in miles.
  const r = S.TB_CALC.distance.solve({ a: sf, b: ny, unit: 'mi' });
  check(near(r.km / 1.609344, 2566, 8), 'the screen says about 2,566 mi');
}

// ── 2. Units ──
{
  check(near(S._tbConvert('temperature', 100, 'f', 'c'), 37.7778, 1e-4), '100 °F = 37.78 °C');
  check(near(S._tbConvert('temperature', -40, 'c', 'f'), -40, 1e-9), '-40 °C = -40 °F');
  check(near(S._tbConvert('temperature', 0, 'c', 'k'), 273.15, 1e-9), '0 °C = 273.15 K');
  check(S._tbConvert('length', 1, 'mi', 'km') === 1.609344, '1 mi = 1.609344 km exactly');
  check(near(S._tbConvert('volume', 1, 'gal', 'l'), 3.785411784, 1e-12), '1 US gal = 3.785411784 L');
  check(near(S._tbConvert('pressure', 1, 'atm', 'hpa'), 1013.25, 1e-9), '1 atm = 1013.25 hPa');
  check(near(S._tbConvert('pressure', 1, 'psi', 'kpa'), 6.894757, 1e-6), '1 psi = 6.894757 kPa');
  check(near(S._tbConvert('speed', 10, 'kn', 'kmh'), 18.52, 1e-9), '10 kn = 18.52 km/h');
  let bad = 0;
  for (const kind of Object.keys(S.TB_UNITS)) {
    for (const a of S.TB_UNITS[kind]) for (const b of S.TB_UNITS[kind]) {
      const x = 12.345, y = S._tbConvert(kind, S._tbConvert(kind, x, a[0], b[0]), b[0], a[0]);
      if (!near(x, y, 1e-9)) bad++;
    }
  }
  check(bad === 0, 'every unit round-trips through every other of its kind');
  const r = S.TB_CALC.units.solve({ kind: 'temperature', v: 100, from: 'f', to: 'c' });
  check(/^37\.78 °C$/.test(r.big), 'the units screen answers ' + r.big);
}

// ── 3. Days ──
{
  const J = (y, m, d) => S._gregorianToJDN(y, m, d);
  const iso = (y, m, d) => S._tbIsoWeek(J(y, m, d));
  check(iso(2026, 1, 1).week === 1 && iso(2026, 1, 1).year === 2026, '1 Jan 2026 (a Thursday) is week 1');
  check(iso(2021, 1, 3).week === 53 && iso(2021, 1, 3).year === 2020, '3 Jan 2021 is week 53 of 2020');
  check(iso(2024, 12, 30).week === 1 && iso(2024, 12, 30).year === 2025, '30 Dec 2024 is week 1 of 2025');
  check(iso(2026, 10, 1).week === 40, '1 Oct 2026 is week 40');
  check(S._tbDayOfYear({ y: 2024, m: 12, d: 31 }) === 366, '31 Dec 2024 is day 366');
  const ymd = S._tbYmd({ y: 2026, m: 1, d: 31 }, { y: 2026, m: 3, d: 1 });
  check(ymd.y === 0 && ymd.m === 1 && ymd.d === 1, '31 Jan to 1 Mar is 1 month 1 day');
  const r = S.TB_CALC.days.solve({ a: Date.UTC(2026, 9, 1, 12), b: Date.UTC(2027, 0, 1, 12) });
  check(r.days === 92, '1 Oct 2026 to 1 Jan 2027 is 92 days (' + r.days + ')');
}

// ── 4. Angles ──
{
  const P = S._tkParseAngle;
  check(near(P('41 27.3'), 41.455, 1e-9), '"41 27.3" is 41.455°');
  check(near(P("41°27.3'N"), 41.455, 1e-9), '"41°27.3\'N" is 41.455°');
  check(near(P('70 15 W'), -70.25, 1e-9), '"70 15 W" is -70.25°');
  check(near(P('41 27 18'), 41.455, 1e-9), '"41 27 18" (seconds) is 41.455°');
  check(near(P('-33.5'), -33.5, 1e-9), '"-33.5" is -33.5°');
  check(isNaN(P('41 75')), 'minutes past 59 are refused');
  check(S._tkAngleText(41.455) === '41° 27.3′', 'shown as 41° 27.3′');
  const ll = S._tkParseLatLon('37.77, -122.42');
  check(ll && near(ll.lat, 37.77, 1e-9) && near(ll.lon, -122.42, 1e-9), 'a typed "lat, lon" is a place');
}

// ── 5. Windows ──
{
  const k = { y: 2026, m: 10, d: 1 };
  const span = (win, o) => S._tbSpan(Object.assign({ win, anchor: k, from: k, to: k }, o || {}));
  check(span('day').days === 1, 'a day is one row');
  const w = span('week');
  check(w.days === 7 && S._tbJdn(w.from) % 7 === 0, 'a week is seven days from a Monday (en-GB)');
  check(span('month').days === 31, 'October has 31 rows');
  check(span('year').days === 365, '2026 has 365 rows');
  const r = span('range', { from: { y: 2026, m: 12, d: 30 }, to: { y: 2027, m: 1, d: 2 } });
  check(r.days === 4 && r.years, 'a range across the year is four days, over two years');
  const st = { win: 'month', anchor: { y: 2026, m: 1, d: 31 } };
  S._tbStep(st, 1);
  check(st.anchor.m === 2 && st.anchor.d === 28, 'a month on from 31 January lands in February');
  const cap = S._tbCapDays(span('range', { from: { y: 2000, m: 1, d: 1 }, to: { y: 2010, m: 1, d: 1 } }), S.TB_MAX_DAYS);
  check(cap.capped && cap.days === S.TB_MAX_DAYS, 'a decade of days is cut to the first ' + S.TB_MAX_DAYS);
}

// ── 6. Sight reduction, sundial, a day's Sun and Moon ──
{
  // The reference test's sight: the Sun's lower limb from 41.5 N 70.25 W,
  // reduced from the assumed position 41 N 70 W. The screen's answer is the
  // reduction's, and the true position lies on its line.
  const truth = { lat: 41.5, lon: -70.25 }, ms = Date.parse('2026-09-30T14:20:00Z');
  const b = S._arBodyAt('sun', ms);
  const s = { body: 'sun', limb: 'lower', ms, ie: 1.2, heightM: 3, tempC: 10, hPa: 1010, unit: 'm', lat: 41, lon: -70,
    hs: S._arAltAz(truth.lat, b.dec, b.gha + truth.lon).hc };
  for (let i = 0; i < 6; i++) s.hs -= S._arReduceSight(Object.assign({}, s, truth)).intercept / 60;
  const r = S.TB_CALC.sight.solve(s), direct = S._arReduceSight(s);
  check(near(r.intercept, direct.intercept, 1e-9) && near(r.zn, direct.zn, 1e-9), 'the screen gives the reduction\'s intercept and azimuth');
  const DEG = 180 / Math.PI;
  const dx = (truth.lon - direct.foot.lon) * Math.cos(truth.lat / DEG) * 60, dy = (truth.lat - direct.foot.lat) * 60;
  check(Math.abs(dx * Math.sin(direct.zn / DEG) + dy * Math.cos(direct.zn / DEG)) < 0.2, 'the true position lies on the screen\'s line of position');
  check(/ref_(toward|away)/.test(r.big) && r.big.indexOf(String(Math.round(direct.zn))) >= 0, 'the answer names the intercept and the azimuth: ' + r.big);
  // The worked example the screen opens on is 1.5 nm toward.
  const ex = S._arSightDefaults({ lat: 37.8, lon: -122.47 }, Date.parse('2026-10-01T19:00:00Z'));
  check(near(S._arReduceSight(ex).intercept, 1.5, 0.05), 'the opening example is a 1.5 nm intercept');
  // Sundial, New York on 1 January: 4 min east of its meridian, EoT -3.7 min.
  const ny = S._tbMakePlace(40.7128, -74.006, 'New York', true);
  ny.tz = 'America/New_York';
  const sd = S._tbSundial(ny, { y: 2026, m: 1, d: 1 });
  check(near(sd.correction, -4.0 + 3.66, 0.2), 'New York 1 Jan sundial correction ' + sd.correction.toFixed(2) + ' min');
  check(near(sd.lonCorr - sd.eot, sd.correction, 0.05), 'the working adds up: longitude less the equation of time');
  // The Sun and Moon on a day: New York, 21 June 2026 (USNO: rise 05:25, set 20:31).
  const day = S._arSpan({ y: 2026, m: 6, d: 21 }, { y: 2026, m: 6, d: 21 }, 40.7128, -74.006, 'America/New_York').rows[0];
  const hm = (x) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Math.round(x / 60000) * 60000));
  check(hm(day.rise) === '05:25' && hm(day.set) === '20:31', 'one day for New York: sunrise ' + hm(day.rise) + ', sunset ' + hm(day.set));
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
