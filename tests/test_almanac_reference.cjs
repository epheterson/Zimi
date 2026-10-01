// The Almanac's long-haul reference sheets (zimi/static/almanac-reference.js):
// every number they print, against published values.
//
//   1. Nautical Almanac pages: GHA and declination of the Sun, Moon, planets,
//      Aries and the navigational stars at six instants 1800-2050, against
//      the U.S. Naval Observatory's celestial navigation service
//      (aa.usno.navy.mil/api/celnav, API 4.0.1, fetched 2026-09-30), the
//      source behind the printed Nautical Almanac. Targets: Sun and stars
//      0.2', Moon and planets 0.5'. And the computed altitude Hc and azimuth
//      Zn the same service gives for each assumed position.
//   2. Far from now: the apparent places of the Sun, Moon and planets at TT
//      instants 1700-2400 against JPL Horizons (DE441, quantity 2, apparent
//      RA/Dec of date, fetched 2026-09-30), and GHA Aries (Greenwich apparent
//      sidereal time, Horizons quantity 7 at longitude 0) at UT instants.
//      Clock-time accuracy that far out is a matter of delta T, not of the
//      ephemeris; the sheet says so, and this checks the ephemeris itself.
//   3. Sight reduction: the Nautical Almanac's dip (1.76' sqrt h) and
//      refraction tables, and a whole sight worked forward and back.
//   4. A year for one place: sunrise, sunset, civil twilight, transit and
//      moonrise/moonset for New York and Sydney against USNO's
//      rise/set/transit service (aa.usno.navy.mil/api/rstt/oneday), and the
//      midnight Sun at Longyearbyen.
//   5. Calendars: the computus against the Almanac's own Easter for
//      1583-3999, known Easter, Orthodox Easter, Passover, Rosh Hashanah,
//      Chinese New Year and Nowruz dates, Sunday letters, the tabular
//      Islamic epoch, and the Persian year by the Sun.
//   6. The equation of time's extremes, and Sirius's heliacal rising at Cairo.
//
// Run: node tests/test_almanac_reference.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}

// The Almanac as the browser has it: app.js's Moon, then the Almanac's
// files in their load order, with just enough of a page for them to load.
function stubStorage() { return { getItem() { return null; }, setItem() {}, removeItem() {} }; }
const S = {
  console, Math, Date, Intl, Object, JSON, String, Number, Array, isNaN, isFinite, parseInt, parseFloat,
  setTimeout, clearTimeout, requestAnimationFrame() {}, cancelAnimationFrame() {},
  window: { addEventListener() {} }, localStorage: stubStorage(), sessionStorage: stubStorage(),
  document: { getElementById: () => null, querySelector: () => null, addEventListener() {}, documentElement: { classList: { add() {}, remove() {} } } },
  navigator: {}, location: { hash: '' }, Image: function () {}, addEventListener() {},
  matchMedia() { return { matches: false, addEventListener() {} }; }
};
vm.createContext(S);
vm.runInContext('var _currentLang = "en"; function t(k) { return k; } var _almanacOpen = false;', S);
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-orrery.js'), 'utf8'), S);
vm.runInContext(require('./moon_model.cjs')(), S);
for (const f of ['almanac.js', 'almanac-earth.js', 'almanac-navdata.js', 'almanac-reference.js']) {
  vm.runInContext(fs.readFileSync(path.join(STATIC, f), 'utf8'), S);
}

const DEG = 180 / Math.PI;
function d360(a, b) { return ((a - b + 540) % 360) - 180; }
const PLANETS = ['venus', 'mars', 'jupiter', 'saturn'];

// ── 1. Against USNO ──────────────────────────────────────────────────────────
// [instant, assumed lat, lon, [[object, GHA, Dec, Hc, Zn], ...]] (degrees).
const USNO = [["2026-09-30T12:00:00Z",41.0,-70.0,[["Sun",2.504566,-2.915654,14.78102,107.4019],["Moon",136.088682,24.451786,33.36873,274.8307],["Mars",65.382342,20.829449,69.45238,167.6208],["Jupiter",47.139252,15.535893,57.75127,135.4554],["Hamal",157.073208,23.590844,17.3298,286.5135],["Aldebaran",119.88238,16.564141,40.7801,255.4654],["Bellatrix",107.606316,6.375769,41.84012,234.4914],["Betelgeuse",100.093545,7.41366,47.06902,226.8872],["Procyon",74.075892,5.15784,53.97224,186.9126],["Alphard",47.028341,-8.772307,35.92155,151.5566],["Denebola",11.64895,14.423571,33.15741,100.0021],["Alkaid",342.10749,49.181346,30.97311,49.6284],["Eltanin",279.945227,51.489848,6.0949,18.2147],["Aries",189.25185,null,null,null]]],["2000-01-01T12:00:00Z",50.0,0.0,[["Sun",359.178715,-23.032432,16.96393,179.2098],["Moon",58.005197,-10.900545,10.9276,238.0135],["Venus",40.563871,-18.449021,12.75569,219.2336],["Mars",309.94028,-13.182489,13.12576,129.9561],["Hamal",248.66465,23.462008,5.19039,59.09],["Dubhe",114.527357,61.747286,33.26232,329.0009],["Alkaid",73.578937,49.310913,44.37309,298.9699],["Kochab",57.796252,74.152957,56.14743,335.4941],["Sabik",22.871978,-15.722826,21.25402,203.6679],["Eltanin",11.316284,51.48944,82.69398,286.1],["Nunki",356.651593,-26.296121,13.64587,176.9112],["Enif",314.417781,9.874935,35.07075,120.7092],["Aries",280.457072,null,null,null]]],["1850-07-04T06:00:00Z",20.0,-160.0,[["Sun",269.025618,22.928972,-8.56203,298.2984],["Venus",235.707409,18.53528,19.18844,283.3868],["Mars",220.470987,12.924047,31.86396,273.0961],["Jupiter",203.125619,6.142781,45.93089,257.7446],["Regulus",221.800774,12.697354,30.55456,273.254],["Gienah",189.86733,-16.711279,43.00953,220.7125],["Alioth",180.04082,56.778985,50.33391,342.8944],["Hadar",163.561675,-59.650737,10.29585,181.8282],["Rigil Kentaurus",154.514222,-60.206664,9.66902,177.2381],["Alphecca",139.803939,27.22553,70.16678,64.7973],["Shaula",111.026101,-36.987268,16.67378,141.02],["Kaus Australis",98.329706,-34.447312,10.03609,132.51],["Altair",76.019778,8.478805,8.50518,84.0177],["Aries",11.8947,null,null,null]]],["1800-06-01T18:00:00Z",-30.0,20.0,[["Moon",343.914108,4.705733,55.09219,353.1724],["Saturn",31.206263,19.511524,20.14668,308.5073],["Sirius",60.889388,-16.450497,15.84926,259.8626],["Pollux",46.70697,28.498787,3.57697,306.0237],["Miaplacidus",22.243872,-68.899565,44.20898,199.7336],["Denebola",345.253742,15.688991,44.03121,352.957],["Gacrux",334.927007,-55.998009,63.75511,173.5796],["Alkaid",315.048965,50.316478,6.69557,15.7367],["Arcturus",308.326889,20.22757,31.24557,35.1891],["Alphecca",288.405625,27.393626,14.33663,45.8999],["Sabik",265.231896,-15.467053,20.64824,96.4025],["Nunki",239.246861,-26.531796,4.5186,118.1499],["Aries",159.970652,null,null,null]]],["2050-12-31T21:00:00Z",60.0,10.0,[["Moon",271.51348,9.092372,13.61522,95.4123],["Mars",50.497937,2.045234,16.07991,244.85],["Jupiter",257.600715,10.404474,7.80565,82.696],["Alpheratz",52.724016,29.375377,38.6446,262.6006],["Menkar",9.242033,4.285428,32.37521,202.9],["Rigel",336.23061,-8.149764,20.97482,165.3845],["Elnath",333.09641,28.643096,56.61415,152.3719],["Sirius",313.629225,-16.793119,7.77133,145.0416],["Regulus",262.710151,11.712155,11.47547,86.4078],["Alioth",221.424125,55.678277,32.64593,31.5675],["Eltanin",146.046422,51.486181,23.14703,344.041],["Enif",88.814892,10.113963,4.39598,282.656],["Aries",55.486757,null,null,null]]],["2031-05-10T09:15:00Z",45.0,120.0,[["Sun",319.641811,17.613641,19.58145,275.652],["Venus",272.948234,26.123767,57.57652,245.6096],["Saturn",298.836441,20.342531,36.07946,263.0867],["Schedar",356.159408,56.706219,24.82966,327.1194],["Mirfak",315.0926,49.968884,41.18044,304.3269],["Capella",286.983661,46.025948,57.54505,288.9119],["Alnilam",282.284398,-1.187211,30.55496,231.3645],["Adhara",261.770929,-29.02182,13.36591,199.4725],["Alphard",224.449221,-8.80035,34.40372,161.2702],["Denebola",189.064209,14.394796,37.40251,108.7871],["Spica",165.013821,-11.326862,2.33429,108.5876],["Kochab",144.056899,74.027459,41.27403,21.3566],["Polaris",318.449489,89.391258,45.11878,359.1548],["Aries",6.734845,null,null,null]]]];
{
  const worst = {};
  for (const [iso, lat, lon, rows] of USNO) {
    const ms = Date.parse(iso);
    const nav = S._arNavAt(ms, { stars: true });
    for (const [obj, gha, dec, hc, zn] of rows) {
      const name = obj.toLowerCase();
      let mine, kind, key;
      if (name === 'aries') { mine = { gha: nav.aries }; kind = 'aries'; }
      else if (nav[name]) { mine = nav[name]; kind = PLANETS.indexOf(name) >= 0 ? 'planets' : name; key = name; }
      else {
        const st = nav.stars.find(s => s.name.toLowerCase() === name);
        if (!st) { check(false, 'star ' + obj + ' is in the catalogue'); continue; }
        mine = { gha: S._arNorm360(nav.aries + st.sha), dec: st.dec }; kind = 'stars'; key = 'star:' + st.name;
      }
      // Across the sky, not along the hour circle: GHA near the pole is cheap.
      const cosd = dec == null ? 1 : Math.cos(dec / DEG);
      const err = Math.max(Math.abs(d360(mine.gha, gha) * 60 * cosd), dec == null ? 0 : Math.abs(mine.dec - dec) * 60);
      if (!worst[kind] || err > worst[kind].err) worst[kind] = { err, at: iso.slice(0, 10) + ' ' + obj };
      if (hc != null && key) {
        const b = S._arBodyAt(key, ms);
        const r = S._arAltAz(lat, b.dec, b.gha + lon);
        const dz = Math.abs(d360(r.zn, zn)) * Math.cos(hc / DEG) * 60;
        const dh = Math.abs(r.hc - hc) * 60;
        if (!worst.hc || dh > worst.hc.err) worst.hc = { err: dh, at: iso.slice(0, 10) + ' ' + obj };
        if (!worst.zn || dz > worst.zn.err) worst.zn = { err: dz, at: iso.slice(0, 10) + ' ' + obj };
      }
    }
  }
  const limit = { sun: 0.2, stars: 0.2, aries: 0.2, moon: 0.5, planets: 0.5, hc: 0.5, zn: 0.5 };
  for (const k of Object.keys(limit)) {
    check(worst[k] && worst[k].err <= limit[k],
      'USNO ' + k + ' within ' + limit[k] + "' (worst " + (worst[k] ? worst[k].err.toFixed(3) + "', " + worst[k].at : 'none') + ')');
  }
}

// ── 2. Against JPL Horizons, 1700-2400 ──────────────────────────────────────
// Apparent RA/Dec (degrees) at TT instants, and GAST (hours) at UT instants.
const HORIZONS_TT = {
  times: ['1700-03-21T00:00:00Z', '2100-06-21T12:00:00Z', '2200-12-01T06:00:00Z', '2400-07-01T00:00:00Z'],
  sun: [[0.3616272, 0.1570146], [90.277853, 23.427926], [247.1120955, -21.7457634], [100.6820291, 23.0254884]],
  moon: [[4.248575, -0.1269107], [261.840421, -28.1477599], [176.0925432, -0.5992749], [200.2212476, -14.1480217]],
  venus: [[28.2945594, 11.6423185], [47.897818, 14.4963806], [298.0560302, -23.9726154], [136.6065048, 18.4606519]],
  mars: [[232.488553, -17.5013097], [129.8628141, 19.7314931], [270.2415518, -24.3363085], [19.725582, 5.9444019]],
  jupiter: [[299.002213, -21.008687], [192.9574947, -4.0869534], [3.8884342, 0.1180875], [318.4032825, -16.6877645]],
  saturn: [[340.1116836, -10.1330405], [199.3609661, -5.3856326], [339.5540322, -10.5787849], [270.661885, -22.197213]]
};
const HORIZONS_GAST_HOURS = [11.8988632329, 5.9851787298, 10.6651496847, 18.6325700492];
HORIZONS_TT.times.forEach((iso, i) => {
  const jde = Date.parse(iso) / 86400000 + 2440587.5;
  const nut = S._aeNutation((jde - 2451545) / 36525);
  const errs = [];
  for (const b of ['sun', 'moon'].concat(PLANETS)) {
    const p = b === 'sun' ? S._aeSun(jde) : b === 'moon' ? S._aeMoon(jde) : S._arPlanet(b, jde, nut);
    const [ra, dec] = HORIZONS_TT[b][i];
    const e = S._aeAngle(S._aeEqVec(p.ra, p.dec, 1), S._aeEqVec(ra / DEG, dec / DEG, 1)) * DEG * 60;
    errs.push(e);
    check(e < 0.2, iso.slice(0, 4) + ' ' + b + " within 0.2' of Horizons (" + e.toFixed(3) + "')");
  }
  const aries = S._arNavAt(Date.parse(iso), { noPlanets: true }).aries;
  const de = Math.abs(d360(aries, HORIZONS_GAST_HOURS[i] * 15)) * 60;
  check(de < 0.1, iso.slice(0, 4) + " GHA Aries within 0.1' of Horizons GAST (" + de.toFixed(3) + "')");
});

// ── 3. Sight reduction ──────────────────────────────────────────────────────
{
  // Nautical Almanac, altitude correction tables: dip for height of eye, and
  // the mean refraction (10 C, 1010 hPa) at apparent altitudes.
  check(Math.abs(S._arDip(10) - 5.6) < 0.05, "dip at 10 m is 5.6' (" + S._arDip(10).toFixed(2) + ')');
  check(Math.abs(S._arDip(2) - 2.5) < 0.05, "dip at 2 m is 2.5'");
  for (const [ha, r] of [[5, 9.9], [10, 5.3], [20, 2.65], [45, 1.0], [90, 0]]) {
    const got = S._arRefraction(ha);
    check(Math.abs(got - r) < 0.1, 'refraction at ' + ha + "° is " + r + "' (" + got.toFixed(2) + ')');
  }
  // A sight taken where the body really was: the intercept is what it was
  // built with, and the line of position passes through the true place.
  const truth = { lat: 41.5, lon: -70.25 };
  const ms = Date.parse('2026-09-30T14:20:00Z');
  const b = S._arBodyAt('sun', ms);
  const geo = S._arAltAz(truth.lat, b.dec, b.gha + truth.lon).hc;
  // Undo the corrections the reduction applies: an observer at the truth reads Hs.
  const s = { body: 'sun', limb: 'lower', ms, ie: 1.2, heightM: 3, lat: 41, lon: -70, hs: geo };
  for (let k = 0; k < 6; k++) {
    const atTruth = S._arReduceSight(Object.assign({}, s, truth));
    s.hs -= atTruth.intercept / 60;
  }
  const r = S._arReduceSight(s);
  // The truth lies on the line: its offset from the foot, across the azimuth, is ~0.
  const dx = (truth.lon - r.foot.lon) * Math.cos(truth.lat / DEG) * 60, dy = (truth.lat - r.foot.lat) * 60;
  const along = dx * Math.sin(r.zn / DEG) + dy * Math.cos(r.zn / DEG);
  check(Math.abs(along) < 0.2, "the true position lies on the line of position (" + along.toFixed(3) + ' nm off)');
  check(S._arNoonLatitude(60, 10, 'S') === 40 && S._arNoonLatitude(60, 10, 'N') === -20, 'noon sight latitude, both bearings');
}

// ── 4. A year for one place ─────────────────────────────────────────────────
function hm(ms, tz) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Math.round(ms / 60000) * 60000));
  return p;
}
function minutes(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }
function rowOf(Y, m, d) { return Y.rows.find(r => r.m === m && r.d === d); }
{
  // USNO rstt/oneday, local time (fetched 2026-09-30).
  const cases = [
    ['America/New_York', 40.7128, -74.006, 2026, 6, 21, { civilDawn: '04:52', rise: '05:25', noon: '12:58', set: '20:31', civilDusk: '21:04', moonrise: '12:50', moonset: '00:29' }],
    ['America/New_York', 40.7128, -74.006, 2026, 12, 21, { civilDawn: '06:46', rise: '07:17', noon: '11:54', set: '16:32', civilDusk: '17:03', moonrise: '14:00', moonset: '04:35' }],
    ['Australia/Sydney', -33.87, 151.21, 2026, 3, 3, { civilDawn: '06:19', rise: '06:44', noon: '13:07', set: '19:29', civilDusk: '19:55', moonrise: '19:21', moonset: '06:06' }]
  ];
  const years = {};
  for (const [tz, lat, lon, y, m, d, want] of cases) {
    const key = tz + y;
    const Y = years[key] || (years[key] = S._arYear(y, lat, lon, tz));
    check(Y.rows.length === 365, tz + ' ' + y + ': a row for every day');
    const r = rowOf(Y, m, d);
    for (const f of Object.keys(want)) {
      const got = r[f] == null ? 'none' : hm(r[f], tz);
      check(got !== 'none' && Math.abs(minutes(got) - minutes(want[f])) <= 1,
        tz + ' ' + y + '-' + m + '-' + d + ' ' + f + ' ' + got + ' (USNO ' + want[f] + ')');
    }
  }
  // Longyearbyen at midsummer: the Sun never sets, and the sheet says so.
  const L = S._arYear(2026, 78.22, 15.65, 'Arctic/Longyearbyen');
  const mid = rowOf(L, 6, 21);
  check(mid.polar === 'up' && mid.rise == null && mid.set == null, 'Longyearbyen 21 June: up all day');
  check(rowOf(L, 12, 21).polar === 'down', 'Longyearbyen 21 December: down all day');
  // The phases and seasons of 2026 (USNO: full Moon 3 Jan 10:03 UT; March
  // equinox 20 March 14:46 UT).
  const NY = years['America/New_York2026'];
  const full = NY.phases.find(p => p.q === 2);
  check(Math.abs(full.ms - Date.parse('2026-01-03T10:03:00Z')) < 2 * 60000, 'first full Moon of 2026 at 10:03 UT');
  check(Math.abs(NY.seasons[0] - Date.parse('2026-03-20T14:46:00Z')) < 2 * 60000, 'March equinox 2026 at 14:46 UT');
  // Eclipses seen from New York in 2026 (NASA: the 3 March total lunar sets
  // in totality; the 12 August total solar is a small partial at sunset).
  const ecl = NY.eclipses;
  check(ecl.length === 4, '2026 has four eclipses');
  check(ecl[0].here === null, '17 Feb annular: not seen from New York');
  check(ecl[1].here && ecl[1].here.kind === 'total', '3 Mar lunar: totality seen from New York');
  check(ecl[2].here && ecl[2].here.kind === 'partial' && ecl[2].here.mag < 0.4, '12 Aug solar: a small partial from New York');
}

// ── 5. Calendars ────────────────────────────────────────────────────────────
function ymd(jdn) { const g = S._jdnToGregorian(jdn); return g.year + '-' + String(g.month).padStart(2, '0') + '-' + String(g.day).padStart(2, '0'); }
{
  let disagree = 0;
  for (let y = 1583; y < 4000; y++) {
    const e = S._computeEaster(y);
    if (S._gregorianToJDN(y, e.month, e.day) !== S._arComputusGregorian(y).easter) disagree++;
  }
  check(disagree === 0, 'the computus agrees with the Almanac Easter for 1583-3999');
  // Known dates (Western/Orthodox Easter, Passover = 15 Nisan, Rosh Hashanah,
  // Chinese New Year from the Hong Kong Observatory, Nowruz from the Iranian
  // calendar, Ramadan/Eid from the tabular calendar).
  const KNOWN = {
    2024: { easter: '2024-03-31', orthodox: '2024-05-05', passover: '2024-04-23', roshHashanah: '2024-10-03', cny: '2024-02-10', nowruz: '2024-03-20' },
    2025: { easter: '2025-04-20', orthodox: '2025-04-20', passover: '2025-04-13', roshHashanah: '2025-09-23', cny: '2025-01-29', nowruz: '2025-03-21' },
    2026: { easter: '2026-04-05', orthodox: '2026-04-12', passover: '2026-04-02', roshHashanah: '2026-09-12', cny: '2026-02-17', nowruz: '2026-03-21' },
    2033: { easter: '2033-04-17', orthodox: '2033-04-24', passover: '2033-04-14', roshHashanah: '2033-09-24', cny: '2033-01-31', nowruz: '2033-03-20' }
  };
  for (const y of Object.keys(KNOWN)) {
    const h = S._arHolidays(+y);
    for (const k of Object.keys(KNOWN[y])) check(ymd(h[k]) === KNOWN[y][k], y + ' ' + k + ' ' + ymd(h[k]));
  }
  const h26 = S._arHolidays(2026);
  check(ymd(h26.ramadan[0]) === '2026-02-18' && ymd(h26.eidFitr[0]) === '2026-03-20' && ymd(h26.eidAdha[0]) === '2026-05-27',
    '2026 Ramadan, Eid al-Fitr, Eid al-Adha (tabular) 18 Feb, 20 Mar, 27 May');
  check(S._arHolidays(2030).ramadan.length === 2, '2030 has two Ramadans begin in it');
  for (const [y, l] of [[2024, 'GF'], [2025, 'E'], [2026, 'D'], [2000, 'BA'], [2100, 'C']]) {
    check(S._arComputusGregorian(y).letters === l, y + ' Sunday letter ' + l);
  }
  const c26 = S._arComputusGregorian(2026);
  check(c26.golden === 13 && c26.epact === 11, '2026 golden number 13, epact 11');
  check(S._hijriToJDN(1, 1, 1) === S._julianToJDN(622, 7, 16), '1 Muharram 1 AH = 16 July 622 (Julian)');
  // The Persian year by the Sun agrees with the arithmetic 1799-2222.
  let off = 0;
  for (let y = 1799; y <= 2222; y++) if (S._arNowruzJDN(y) !== S._persianToJDN(y - 621, 1, 1)) off++;
  check(off === 0, 'Nowruz by the Sun = the 33-year arithmetic, 1799-2222');
  // Round trips through every calendar, a day at a time across two years.
  let bad = 0;
  for (let j = S._gregorianToJDN(2025, 1, 1); j < S._gregorianToJDN(2027, 1, 1); j++) {
    for (const sys of S.AR_CAL_SYSTEMS) {
      const c = S._arCalFromJDN(sys, j);
      if (S._arCalToJDN(sys, c.year, c.month, c.day) !== j) bad++;
    }
  }
  check(bad === 0, 'every calendar round-trips every day of 2025-2026 (' + bad + ' misses)');
}

// ── 6. Sun time and the star calendar ───────────────────────────────────────
{
  // The equation of time's extremes (USNO, Astronomical Almanac): about
  // -14m 14s near 11 February and +16m 25s near 3 November.
  const feb = S._arEquationOfTime(Date.parse('2026-02-11T12:00:00Z')).eot;
  const nov = S._arEquationOfTime(Date.parse('2026-11-03T12:00:00Z')).eot;
  check(Math.abs(feb - -14.23) < 0.1, 'equation of time 11 Feb ' + feb.toFixed(2) + ' min');
  check(Math.abs(nov - 16.42) < 0.1, 'equation of time 3 Nov ' + nov.toFixed(2) + ' min');
  const st = S._arSunTimeYear(2026, -74.006, 'America/New_York');
  check(st.length === 365, 'a sundial correction for every day');
  // New York in standard time on 1 January: 4 min east of its meridian, EoT -3.7.
  check(Math.abs(st[0].correction - (-4.0 + 3.66)) < 0.2, 'New York 1 Jan correction ' + st[0].correction.toFixed(2) + ' min');
  // Sirius's heliacal rising at Cairo falls in the first days of August now
  // (it was 19 July in the age of the pharaohs: precession moved it).
  const cal = S._arStarCalendar(2026, 30.04, 31.24);
  const sirius = cal.find(s => s.name === 'Sirius');
  const day = new Date(sirius.rising);
  check(day.getUTCMonth() === 7 && day.getUTCDate() <= 8 || (day.getUTCMonth() === 6 && day.getUTCDate() >= 30),
    'Sirius first seen at dawn from Cairo ' + day.toISOString().slice(0, 10));
  check(cal.find(s => s.name === 'Acrux').none === 'never', 'Acrux never seen from Cairo');
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
