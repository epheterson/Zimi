// ΔT (TT−UT) and the Chinese calendar it feeds, 1900-1990: the century the
// Espenak-Meeus pieces were fitted to, and the century a prior revision got
// wrong.
//
// Until v1.9, _cnDeltaTdays stretched the Espenak-Meeus 1900-1920 quartic
// across 1900-1986. That quartic diverges fast outside its window: at 1985 it
// read ≈-6787 s where the observed value is ≈+54.3 s — ~113 minutes of error
// going straight into _cnChinaDay's midnight floor — with an 0.083-day jump at
// the 1986 seam. Sixteen Chinese lunar month starts in 1950-1985 landed one
// civil day late because of it, three of them Chinese New Year (1954, 1966,
// 1978). This test pins the fix to outside references so it cannot quietly
// regress:
//
//   1. ΔT at 1900-1990 marks vs OBSERVED values (not the fit's own output):
//      USNO historic ΔT table, https://maia.usno.navy.mil/ser7/historic_deltat.data
//      (TDT-UT1 at year.0), plus Espenak's table for 1985/1990,
//      https://eclipse.gsfc.nasa.gov/SEcat5/deltat.html. The Espenak-Meeus fits
//      track these within ~0.3 s; the old quartic missed 1930 by 28 s and 1980
//      by 5200 s, so a 1 s gate separates the two regimes with a wide margin.
//   2. ΔT steps year-over-year without seams. The pieces (NASA "Polynomial
//      Expressions for Delta T", https://eclipse.gsfc.nasa.gov/SEcat5/deltatpoly.html)
//      were constructed to join continuously; the old code jumped 0.083 days
//      between 1985 and 1986.
//   3. Chinese New Year for EVERY year 1920-1986 vs the civil calendar:
//      1920-1929 and the three changed years from the Hong Kong Observatory
//      conversion tables (https://www.hko.gov.hk/en/gts/time/calendar/text/files/T<year>e.txt),
//      1930-1986 cross-checked against the HKO-derived list at
//      https://www.travelchinaguide.com/essential/holidays/new-year/dates.htm
//      That list carries two transcription errors, arbitrated against HKO's
//      own tables: 1943 is Feb 5 ("1943/02/05  1st Lunar month", T1943e.txt),
//      not Feb 4; 1946 is Feb 2 ("1946/02/02  1st Lunar month", T1946e.txt),
//      not Feb 1. The HKO dates are what's encoded below.
//   4. All sixteen month starts the fix moved, each pinned to its HKO
//      conversion-table date — the non-CNY boundaries a CNY table alone
//      wouldn't guard.
//
// Pure-helper approach, matching tests/test_almanac_year_bounds.cjs: pull the
// functions straight out of the shipped source by name and eval them in a
// sandbox, so the test drives the shipped code rather than a copy.
//
// Run: node tests/test_almanac_deltat.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const almSrc = fs.readFileSync(path.join(STATIC, 'almanac.js'), 'utf8');

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
function extractVar(src, name) {
  const m = new RegExp('^var ' + name + ' =([^;]*);', 'm').exec(src);
  if (!m) throw new Error('var ' + name + ' not found');
  return 'var ' + name + ' =' + m[1] + ';';
}

const sandbox = { Math, Date, console };
vm.createContext(sandbox);
for (const name of ['_CN_SYN', '_CN_TZ', '_CN_NM11_SEED_PASSES',
  '_CN_NM11_MAX_STEPS', '_CN_SUI_CACHE_MAX', '_CN_TROPICAL_YEAR', '_CHINESE_MONTHS']) {
  vm.runInContext(extractVar(almSrc, name), sandbox);
}
vm.runInContext('var DEG_TO_RAD = Math.PI / 180; var _cnSuiCache = {}; var _cnSuiCacheCount = 0;', sandbox);
for (const name of [
  '_floorMod', '_gregorianToJDN', '_jdnToGregorian',
  '_cnDeltaTdays', '_cnNewMoonJDE', '_cnSolarLongitude', '_cnSolarTermJDE',
  '_cnChinaDay', '_cnNewMoonDay', '_cnMonthHasZhongqi', '_cnNm11',
  '_cnNm11FromSolstice', '_cnSolsticeTT', '_cnBuildSui', '_cnYearMonths',
  '_cnChineseNewYearJDN', '_jdnToChineseLunar'
]) {
  vm.runInContext(extractFn(almSrc, name), sandbox);
}
const S = sandbox;
const dtSec = (y) => S._cnDeltaTdays(S._gregorianToJDN(y, 6, 15)) * 86400;

// ── 1. ΔT vs observed values, 1900-1990 ──────────────────────────────────
// USNO historic_deltat.data (TDT-UT1, at year.0) for 1900-1980; Espenak's
// observed table for 1985/1990. _cnDeltaTdays keys off the integer Gregorian
// year, so its output IS the fit at year.0.
const DT_OBSERVED = {
  1900: -2.70, 1910: 10.38, 1920: 21.41, 1925: 23.63, 1930: 24.02,
  1935: 23.91, 1940: 24.35, 1945: 26.76, 1950: 29.15, 1955: 31.07,
  1960: 33.15, 1965: 35.74, 1970: 40.18, 1975: 45.48, 1980: 50.54,
  1985: 54.3, 1990: 56.9
};
const DT_TOL = 1.0;   // seconds; fit error is ~0.3 s, the old bug was 28-6800 s
let dtBad = null, dtWorst = 0;
for (const y of Object.keys(DT_OBSERVED)) {
  const err = Math.abs(dtSec(+y) - DT_OBSERVED[y]);
  if (err > dtWorst) dtWorst = err;
  if (!(err <= DT_TOL)) dtBad = dtBad || (y + ': computed ' + dtSec(+y).toFixed(2) + 's, observed ' + DT_OBSERVED[y] + 's');
}
check(dtBad === null, 'deltaT matches observed values 1900-1990 within ' + DT_TOL +
  's (worst error ' + dtWorst.toFixed(2) + 's; ' + dtBad + ')');

// ── 2. No seams: ΔT steps smoothly year over year, 1900-2149 ─────────────
// The Espenak-Meeus pieces join continuously at 1920/1941/1961/1986/2005/2050.
// The projected slope legitimately reaches ~2.7 s/yr by 2150 (the 32u²
// parabola steepening), so the gate is 3 s — still three orders of magnitude
// under the pre-fix code's 6841 s jump between 1985 and 1986.
let stepBad = null, stepWorst = 0;
for (let y = 1900; y < 2150; y++) {
  const step = Math.abs(dtSec(y + 1) - dtSec(y));
  if (step > stepWorst) stepWorst = step;
  if (!(step < 3.0)) stepBad = stepBad || (y + '->' + (y + 1) + ' steps ' + step.toFixed(2) + 's');
}
check(stepBad === null, 'deltaT has no seams 1900-2150 (worst annual step ' +
  stepWorst.toFixed(2) + 's; ' + stepBad + ')');

// ── 3. Chinese New Year, every year 1920-1986 ────────────────────────────
// The span the fix touches, in full. "M-D" per the HKO civil calendar.
const CNY = {
  1920: '2-20', 1921: '2-8', 1922: '1-28', 1923: '2-16', 1924: '2-5',
  1925: '1-24', 1926: '2-13', 1927: '2-2', 1928: '1-23', 1929: '2-10',
  1930: '1-30', 1931: '2-17', 1932: '2-6', 1933: '1-26', 1934: '2-14',
  1935: '2-4', 1936: '1-24', 1937: '2-11', 1938: '1-31', 1939: '2-19',
  1940: '2-8', 1941: '1-27', 1942: '2-15', 1943: '2-5', 1944: '1-25',
  1945: '2-13', 1946: '2-2', 1947: '1-22', 1948: '2-10', 1949: '1-29',
  1950: '2-17', 1951: '2-6', 1952: '1-27', 1953: '2-14', 1954: '2-3',
  1955: '1-24', 1956: '2-12', 1957: '1-31', 1958: '2-18', 1959: '2-8',
  1960: '1-28', 1961: '2-15', 1962: '2-5', 1963: '1-25', 1964: '2-13',
  1965: '2-2', 1966: '1-21', 1967: '2-9', 1968: '1-30', 1969: '2-17',
  1970: '2-6', 1971: '1-27', 1972: '2-15', 1973: '2-3', 1974: '1-23',
  1975: '2-11', 1976: '1-31', 1977: '2-18', 1978: '2-7', 1979: '1-28',
  1980: '2-16', 1981: '2-5', 1982: '1-25', 1983: '2-13', 1984: '2-2',
  1985: '2-20', 1986: '2-9'
};
let cnyBad = null, cnyChecked = 0;
for (const y of Object.keys(CNY)) {
  const g = S._jdnToGregorian(S._cnChineseNewYearJDN(+y));
  const got = g.month + '-' + g.day;
  cnyChecked++;
  if (g.year !== +y || got !== CNY[y]) cnyBad = cnyBad || (y + ': expected ' + CNY[y] + ', got ' + g.year + '-' + got);
}
check(cnyBad === null, 'Chinese New Year matches the civil calendar for all ' +
  cnyChecked + ' years 1920-1986 (' + cnyBad + ')');

// ── 4. The sixteen month starts the fix moved, pinned to HKO dates ────────
// Every one of these read one civil day LATE under the stretched quartic.
// [gregorian y-m-d of the true month start, lunar month number it begins]
const MOVED_BOUNDARIES = [
  ['1950-6-15', 5], ['1954-2-3', 1], ['1955-2-22', 2], ['1966-1-21', 1],
  ['1968-4-27', 4], ['1970-7-3', 6], ['1973-1-4', 12], ['1973-12-24', 12],
  ['1976-11-21', 10], ['1978-2-7', 1], ['1978-4-7', 3], ['1980-12-7', 11],
  ['1981-8-29', 8], ['1981-11-26', 11], ['1982-11-15', 10], ['1985-11-12', 10]
];
let mbBad = null;
for (const [date, monthNum] of MOVED_BOUNDARIES) {
  const [gy, gm, gd] = date.split('-').map(Number);
  const c = S._jdnToChineseLunar(S._gregorianToJDN(gy, gm, gd));
  if (!(c.day === 1 && c.monthNum === monthNum && !c.leap)) {
    mbBad = mbBad || (date + ': expected month ' + monthNum + ' day 1, got month ' +
      c.monthNum + (c.leap ? ' (leap)' : '') + ' day ' + c.day);
  }
}
check(mbBad === null, 'all 16 month starts the fix moved sit on their HKO dates (' + mbBad + ')');

console.log(failures ? '\n' + failures + ' failure(s)' : '\nall checks passed');
process.exit(failures ? 1 : 0);
