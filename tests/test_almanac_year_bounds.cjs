// Time travel to the ends of the almanac's year range must not hang the tab.
//
// The time machine lets a year be TYPED straight into the DESTINATION readout,
// so _ALM_YEAR_MIN (-270000) is one keystroke away, not a long scrub. Landing
// there redraws the calendar grid, and the grid renders the selected day in
// every calendar system — including the Chinese lunisolar one, whose month
// boundaries are real astronomy.
//
// That path used to lock the main thread forever. _cnDeltaTdays extrapolated
// the Espenak-Meeus 1900-1920 quartic to every year before 1986; its -w^4 term
// reached -1.2e13 DAYS at year -270000, which inverted the sign of
// d(_cnChinaDay)/dk. _cnNm11 finds a lunation by walking k while comparing
// _cnNewMoonDay(k) against the solstice day, so an inverted comparison meant
// the walk never met its exit condition. Measured live in Chromium: the tab
// was still unresponsive 30 minutes after the year was committed.
//
// The guards this locks in:
//   1. deltaT stays bounded across the whole travel range (root cause).
//   2. _cnNewMoonDay is strictly increasing in k there (the invariant the
//      searches rely on) .
//   3. Every calendar system converts at every bound in a BOUNDED number of
//      astronomical evaluations — the assertion that actually says "does not
//      hang". The counter throws past its cap, so a regression fails the test
//      instead of hanging it.
//   4. deltaT and known Chinese New Year dates stay pinned in the modern era.
//      (The 1920-1986 span later got the proper Espenak-Meeus pieces — see
//      tests/test_almanac_deltat.cjs for that fix's reference tables.)
//
// Pure-helper approach, matching tests/test_moon_derivation.cjs: pull the
// functions straight out of the shipped source by name and eval them in a
// sandbox, so the test drives the shipped code rather than a copy.
//
// Run: node tests/test_almanac_year_bounds.cjs   (exit 0 = pass)

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

// Extract a top-level `function NAME(...) {...}` by brace matching.
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

// Extract a top-level `var NAME = <literal>;` so the test tracks the shipped
// constants (year bounds, loop caps) instead of restating them.
function extractVar(src, name) {
  const m = new RegExp('^var ' + name + ' =([^;]*);', 'm').exec(src);
  if (!m) throw new Error('var ' + name + ' not found');
  return 'var ' + name + ' =' + m[1] + ';';
}

const sandbox = { Math, Date, console };
vm.createContext(sandbox);
for (const name of ['_ALM_YEAR_MIN', '_ALM_YEAR_MAX', '_CN_SYN', '_CN_TZ',
  '_CN_NM11_SEED_PASSES', '_CN_NM11_MAX_STEPS', '_CN_SUI_CACHE_MAX', '_CN_TROPICAL_YEAR', '_CAL_MAX_MONTHS', '_CAL_MAX_DAY',
  '_HEBREW_EPOCH', '_CHINESE_MONTHS']) {
  vm.runInContext(extractVar(almSrc, name), sandbox);
}
vm.runInContext('var DEG_TO_RAD = Math.PI / 180; var _cnSuiCache = {}; var _cnSuiCacheCount = 0;', sandbox);
for (const name of [
  '_floorMod', '_gregorianToJDN', '_jdnToGregorian', '_jdnToJulian',
  '_cnDeltaTdays', '_cnNewMoonJDE', '_cnSolarLongitude', '_cnSolarTermJDE',
  '_cnChinaDay', '_cnNewMoonDay', '_cnMonthHasZhongqi', '_cnNm11', '_cnNm11FromSolstice', '_cnSolsticeTT',
  '_cnBuildSui', '_cnYearMonths', '_cnChineseNewYearJDN', '_jdnToChineseLunar',
  '_hebrewDelay1', '_hebrewDelay2', '_hebrewNewYear', '_hebrewDaysInYear',
  '_hebrewMonthDays', '_hebrewLeapYear', '_hebrewMonthList',
  '_jdnToHijri', '_hijriToJDN', '_persianLeapYear', '_persianDaysInMonth',
  '_gregorianToPersian', '_persianToGregorian', '_persianToJDN',
  '_jdnToCalendar', '_calResultUsable'
]) {
  vm.runInContext(extractFn(almSrc, name), sandbox);
}
const S = sandbox;
const SYSTEMS = ['persian', 'gregorian', 'islamic', 'julian', 'buddhist', 'hebrew', 'chinese'];

// Years across the whole travel range: both bounds, one step inside each, the
// edge of the "precise" window, and the ordinary middle.
const PROBE_YEARS = [
  S._ALM_YEAR_MIN, S._ALM_YEAR_MIN + 1, -200000, -100000, -50000, -13001,
  -13000, -5000, -2000, -500, 0, 1, 1582, 1900, 1970, 2026, 2100, 2150,
  3000, 13000, 50000, 100000, 200000, S._ALM_YEAR_MAX - 1, S._ALM_YEAR_MAX
];

// ── 1. deltaT stays bounded — the root cause ─────────────────────────────
// The long-term Espenak-Meeus parabola tops out near 2800 days at the ends of
// the range. The old unbounded quartic reached 1.2e13 there.
const DELTA_T_MAX_DAYS = 5000;
let worstDT = 0, worstDTyear = null;
for (const y of PROBE_YEARS) {
  const dt = Math.abs(S._cnDeltaTdays(S._gregorianToJDN(y, 6, 15)));
  if (!(dt < DELTA_T_MAX_DAYS)) { worstDT = dt; worstDTyear = y; break; }
  if (dt > worstDT) { worstDT = dt; worstDTyear = y; }
}
check(worstDT < DELTA_T_MAX_DAYS,
  'deltaT bounded across the travel range (worst ' + worstDT.toExponential(3) +
  ' days at year ' + worstDTyear + ', cap ' + DELTA_T_MAX_DAYS + ')');

// ── 2. _cnNewMoonDay strictly increasing in k at the bounds ──────────────
// This is the invariant _cnNm11's two searches walk against. Break it and the
// searches walk away from their exit condition forever.
for (const y of [S._ALM_YEAR_MIN, -13000, -500, 2026, S._ALM_YEAR_MAX]) {
  const k0 = Math.round((S._gregorianToJDN(y, 1, 1) - 2451550.09766) / S._CN_SYN);
  let bad = 0;
  for (let k = k0; k < k0 + 1500; k++) {
    if (S._cnNewMoonDay(k + 1) <= S._cnNewMoonDay(k)) bad++;
  }
  check(bad === 0, 'year ' + y + ': _cnNewMoonDay strictly increasing over 1500 lunations (' + bad + ' inversions)');
}

// ── 3. Every system converts, finitely and in bounded work ───────────────
// The work cap is the real anti-hang assertion. A healthy conversion costs
// ~130 new-moon evaluations regardless of year; the pre-fix code blew past any
// cap because _cnNm11 never returned.
const WORK_CAP = 2000;
class WorkCapExceeded extends Error {}
const rawNewMoonJDE = S._cnNewMoonJDE;
const rawSolarLongitude = S._cnSolarLongitude;
let work = 0;
function counted(fn) {
  return function () {
    if (++work > WORK_CAP) throw new WorkCapExceeded('work cap ' + WORK_CAP + ' exceeded');
    return fn.apply(null, arguments);
  };
}
S._cnNewMoonJDE = counted(rawNewMoonJDE);
S._cnSolarLongitude = counted(rawSolarLongitude);

let worstWork = 0, worstWorkLabel = '', hung = null, nonFinite = null;
const unusable = [];
for (const y of PROBE_YEARS) {
  for (const month of [1, 3, 7, 12]) {
    const jdn = S._gregorianToJDN(y, month, 15);
    for (const sys of SYSTEMS) {
      // Cold cache: a real landing on a far year has nothing memoised.
      S._cnSuiCache = {}; S._cnSuiCacheCount = 0;
      work = 0;
      let cal;
      try {
        cal = S._jdnToCalendar(sys, jdn);
      } catch (e) {
        if (e instanceof WorkCapExceeded) { hung = hung || (sys + ' @ ' + y + '-' + month); continue; }
        throw e;
      }
      if (work > worstWork) { worstWork = work; worstWorkLabel = sys + ' @ ' + y + '-' + month; }
      if (!isFinite(cal.year) || !isFinite(cal.month) || !isFinite(cal.day)) {
        nonFinite = nonFinite || (sys + ' @ ' + y + '-' + month + ' -> ' + JSON.stringify(cal));
      }
      // Everything the cross-reference will actually print must be readable.
      // Deep time is allowed to defeat the lunisolar calendars — but then it
      // has to SAY so, not print a fabricated day number.
      if (!S._calResultUsable(cal)) unusable.push({ sys, year: y, month, cal });
    }
  }
}
check(hung === null, 'no calendar conversion exceeds the work cap (first offender: ' + hung + ')');
check(nonFinite === null, 'every conversion yields a finite date (first offender: ' + nonFinite + ')');
check(worstWork <= WORK_CAP,
  'worst conversion cost ' + worstWork + ' astronomical evaluations (' + worstWorkLabel + ')');

// Whatever the cross-reference cannot render truthfully, it must reject — and
// only the lunisolar calendars in deep time are allowed to be rejected. A
// Gregorian, Julian, Buddhist or Persian date is exact arithmetic at every year
// in range, so one of those failing is a real bug, not deep time.
const show = (u) => u.sys + ' @ ' + u.year + '-' + u.month + ' -> ' + JSON.stringify(u.cal);
const EXACT_SYSTEMS = ['gregorian', 'julian', 'buddhist', 'persian'];
const exactUnusable = unusable.filter(u => EXACT_SYSTEMS.indexOf(u.sys) >= 0);
check(exactUnusable.length === 0,
  'the exact-arithmetic calendars stay readable at every year (' + exactUnusable.slice(0, 3).map(show).join('; ') + ')');
// And inside the span the almanac claims precision for, everything is readable.
const PRECISE_SPAN = 13000;   // mirrors _ALM_PRECISE_SPAN
const preciseUnusable = unusable.filter(u => Math.abs(u.year - 2000) <= PRECISE_SPAN);
check(preciseUnusable.length === 0,
  'every calendar stays readable within the precise span (' + preciseUnusable.slice(0, 3).map(show).join('; ') + ')');
// Guard the guard: the filters above are only meaningful if deep time really
// does defeat a lunisolar calendar somewhere. If nothing is ever rejected, the
// two checks above pass vacuously.
check(unusable.length > 0, 'deep time does exercise the beyond-range path (' + unusable.length + ' rejected)');
console.log('   note: ' + unusable.length + ' deep-time conversion(s) correctly flagged unreadable, e.g. ' +
  (unusable.length ? show(unusable[0]) : 'none'));

// _calResultUsable is the gate the cross-reference renders through, so it must
// accept ordinary dates and reject fabricated ones.
check(S._calResultUsable({ year: 2026, month: 8, day: 7 }), '_calResultUsable accepts an ordinary date');
check(S._calResultUsable({ year: -3000, month: 13, day: 30 }), '_calResultUsable accepts a 13th (leap) month');
check(!S._calResultUsable({ year: -267303, month: 12, day: 93 }), '_calResultUsable rejects a fabricated day number');
check(!S._calResultUsable({ year: -270656, month: -26, day: -9 }), '_calResultUsable rejects negative month/day');
check(!S._calResultUsable({ year: NaN, month: 1, day: 1 }), '_calResultUsable rejects NaN');

S._cnNewMoonJDE = rawNewMoonJDE;
S._cnSolarLongitude = rawSolarLongitude;

// ── 4. A sui is never more than 13 lunations ─────────────────────────────
// _cnBuildSui pushes one entry per lunation; an out-of-range count would be an
// allocation bomb rather than a wrong answer.
let worstSui = 0;
for (const y of PROBE_YEARS) {
  S._cnSuiCache = {}; S._cnSuiCacheCount = 0;
  worstSui = Math.max(worstSui, S._cnBuildSui(S._cnNm11(y)).length);
}
check(worstSui >= 12 && worstSui <= 13, 'sui length stays 12-13 lunations (worst ' + worstSui + ')');

// ── 5. Persian round-trips across the whole range ────────────────────────
// The 33-year subcycle arithmetic pairs `%` remainders with `Math.floor`
// quotients. JS `%` truncates, so the two disagreed once the dividend went
// negative — the cross-reference row printed month -26 / day -9 at the far
// bound, and switching INTO the Persian system for any BCE date landed the
// grid ~404 years off.
let persianBad = null, persianChecked = 0;
for (let y = S._ALM_YEAR_MIN; y <= S._ALM_YEAR_MAX; y += 997) {
  for (const [m, d] of [[1, 15], [3, 21], [8, 7], [12, 31]]) {
    const p = S._gregorianToPersian(y, m, d);
    if (p.month < 1 || p.month > 12 || p.day < 1 || p.day > 31) {
      persianBad = persianBad || (y + '-' + m + '-' + d + ' -> ' + JSON.stringify(p));
      continue;
    }
    persianChecked++;
    const delta = S._persianToJDN(p.year, p.month, p.day) - S._gregorianToJDN(y, m, d);
    if (delta !== 0) persianBad = persianBad || (y + '-' + m + '-' + d + ' round-trip off by ' + delta + ' days');
  }
}
check(persianBad === null,
  'Persian converts and round-trips across the whole range (' + persianChecked + ' dates; ' + persianBad + ')');
// And the everyday answers are still the everyday answers.
const nowruz = S._gregorianToPersian(1979, 3, 21);
check(nowruz.year === 1358 && nowruz.month === 1 && nowruz.day === 1,
  'Nowruz 1979-03-21 is still 1/1/1358 (' + JSON.stringify(nowruz) + ')');

// ── 6. Nothing moved in the era people actually live in ──────────────────
// deltaT for 1900-2150 comes from the Espenak-Meeus piecewise fits, so real
// dates must be untouched. Chinese New Year per the HK Observatory civil
// calendar. (test_almanac_deltat.cjs covers 1920-1986 exhaustively.)
const CNY = {
  1900: '1900-1-31', 1949: '1949-1-29', 1997: '1997-2-7', 2020: '2020-1-25',
  2024: '2024-2-10', 2026: '2026-2-17', 2033: '2033-1-31', 2100: '2100-2-9'
};
S._cnSuiCache = {}; S._cnSuiCacheCount = 0;
let cnyBad = null;
for (const y of Object.keys(CNY)) {
  const g = S._jdnToGregorian(S._cnChineseNewYearJDN(+y));
  const got = g.year + '-' + g.month + '-' + g.day;
  if (got !== CNY[y]) cnyBad = cnyBad || (y + ': expected ' + CNY[y] + ', got ' + got);
}
check(cnyBad === null, 'Chinese New Year unchanged for 1900-2100 (' + cnyBad + ')');

// deltaT in the well-fitted era is sub-minute, as the Espenak-Meeus pieces say.
let dtEraBad = null;
for (let y = 1900; y <= 2150; y += 10) {
  const dt = S._cnDeltaTdays(S._gregorianToJDN(y, 6, 15)) * 86400;
  if (!(Math.abs(dt) < 7300)) dtEraBad = dtEraBad || (y + ' -> ' + dt.toFixed(1) + 's');
}
check(dtEraBad === null, 'deltaT stays within the fitted range for 1900-2150 (' + dtEraBad + ')');

// ── 7. Source-level: the searches carry a hard bound ─────────────────────
// A numerically-lucky year range would let an unbounded `while` pass every
// check above. The bound itself is the guarantee.
const nm11 = extractFn(almSrc, '_cnNm11FromSolstice');
check(!/while\s*\(/.test(nm11), '_cnNm11FromSolstice has no unbounded while loop');
check((nm11.match(/_CN_NM11_MAX_STEPS/g) || []).length === 2, '_cnNm11FromSolstice bounds both searches by _CN_NM11_MAX_STEPS');
check(!/else\s*\{\s*var w = y - 1900/.test(extractFn(almSrc, '_cnDeltaTdays')),
  '_cnDeltaTdays no longer extrapolates the 1900-1920 quartic to all earlier years');

console.log(failures ? '\n' + failures + ' failure(s)' : '\nall checks passed');
process.exit(failures ? 1 : 0);
