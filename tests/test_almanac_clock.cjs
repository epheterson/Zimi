// The Almanac's one clock, its pure parts, executed from the shipped source: the slider's scale and stops, the rate's
// words, and the wall-clock arithmetic the date's parts are typed through (time zones, BC, the hour the clocks skip).
//
// Run: node tests/test_almanac_clock.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac.js'), 'utf8');
let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}
function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}
function extractVar(name) {
  const at = src.indexOf('var ' + name + ' =');
  if (at < 0) throw new Error('var ' + name + ' not found');
  return src.slice(at, src.indexOf(';\n', at) + 2);
}

const S = { Intl, Date, Math, Object, JSON, String, Number, console };
vm.createContext(S);
vm.runInContext('var _currentLang = "en";', S);
for (const v of ['_ALM_YEAR_MIN', '_ALM_YEAR_MAX', 'ALM_RATE_UNITS', 'ALM_RATE_SECS', 'ALM_RATE_STOPS', 'ALM_RATE_REAL', 'ALM_RATE_REAL_EPS',
  'ALM_CLOCK_MONTH_LEN', '_almRateUnitCache', '_almNumFmt1Cache', '_ALM_TZ_PARTS_OPTS', '_tzFmtCache']) vm.runInContext(extractVar(v), S);
for (const f of ['_tzFmt', '_almRateAt', '_almPosOfRate', '_almRateIsReal', '_almRateUnit', '_almRateText', '_almNumFmt1', '_almTzParts', '_almWallMs',
  '_almTzOffsetMs', '_almInstantFromTz', '_almDaysInMonth', '_almYearShown', '_almYearTyped', '_almDigits']) vm.runInContext(extractFn(f), S);
const run = (c) => vm.runInContext(c, S);
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ── The scale ─────────────────────────────────────────────────────────────
const stops = run('ALM_RATE_STOPS');
check(stops.length === 9 && stops[4] === 1 && run('ALM_RATE_REAL') === 4, 'nine stops, real time in the middle');
check(JSON.stringify(stops.slice(5)) === JSON.stringify([60, 3600, 86400, 31557600]) && stops[0] === -31557600, 'a minute, an hour, a day, a year a second, either way');
check(stops.every((r, i) => near(run('_almRateAt(' + i + ')'), r, Math.abs(r) * 1e-9)), 'every stop is its own rate');
check(near(run('_almRateAt(4.5)'), Math.sqrt(60), 1e-6), 'between two stops of one sign the scale is geometric (half way to a minute a second is its square root)');
let mono = true, prev = -Infinity;
for (let p = 0; p <= 8; p += 0.05) { const r = run('_almRateAt(' + p + ')'); if (r < prev) mono = false; prev = r; }
check(mono, 'the scale only rises, left to right');
let round = true;
for (let p = 0; p <= 8; p += 0.37) if (!near(run('_almPosOfRate(_almRateAt(' + p + '))'), p, 1e-6)) round = false;
check(round, 'a rate maps back to the place it came from');
check(run('_almPosOfRate(0)') === 4 && run('_almPosOfRate(1e12)') === 8 && run('_almPosOfRate(-1e12)') === 0, 'paused sits on the button; a flight faster than a year a second pins at the end');
check(run('_almRateIsReal(1)') && run('_almRateIsReal(1.09)') && !run('_almRateIsReal(1.2)') && !run('_almRateIsReal(0)'), 'close to a second a second is real time');

// ── The words ─────────────────────────────────────────────────────────────
check(run('_almRateText(3600)') === '1 h/s', 'an hour a second reads "1 h/s", got ' + run('_almRateText(3600)'));
check(run('_almRateText(-86400)') === '−1 d/s', 'backwards carries a minus, got ' + run('_almRateText(-86400)'));
check(run('_almRateText(4000)') === '1.1 h/s', 'tenths of a unit, got ' + run('_almRateText(4000)'));
check(run('_almRateText(31557600 * 20)') === '20 y/s', 'twenty years a second, got ' + run('_almRateText(31557600 * 20)'));
check(run('_almRateText(5)') === '5×', 'below a minute a second it is a multiple, got ' + run('_almRateText(5)'));
run('_currentLang = "de"; _almRateUnitCache = {}; _almNumFmt1Cache = null;');
check(/^1,1 /.test(run('_almRateText(4000)')), 'in German a decimal comma, got ' + run('_almRateText(4000)'));
run('_currentLang = "en"; _almRateUnitCache = {}; _almNumFmt1Cache = null;');

// ── Typing a year ─────────────────────────────────────────────────────────
check(run('_almYearTyped("2026")') === 2026, 'a year as typed');
check(run('_almYearTyped("-44")') === -43 && run('_almYearTyped("−44")') === -43, 'a minus means BC: -44 is 44 BC, astronomical -43');
check(run('_almYearTyped("-1")') === 0 && run('_almYearTyped("0")') === 0, '1 BC is year 0, and so is a typed 0');
check(run('_almYearTyped("99999999")') === 270000 && run('_almYearTyped("-99999999")') === -270000, 'a year past the range stops at the range');
check(run('_almYearTyped("")') === null, 'nothing typed is nothing');
check(run('_almYearShown(2026)') === '2026' && run('_almYearShown(-43)') === '−44' && run('_almYearShown(0)') === '−1', 'a year is shown the way it is typed');
check(run('_almDigits("٢٠٢٦")') === '2026' && run('_almDigits("۱۲")') === '12', 'Arabic-Indic digits are digits');
check(run('_almDaysInMonth(2024, 2)') === 29 && run('_almDaysInMonth(2100, 2)') === 28 && run('_almDaysInMonth(2000, 2)') === 29 && run('_almDaysInMonth(-4, 2)') === 29 && run('_almDaysInMonth(2026, 4)') === 30,
  'month lengths, leap years in the proleptic calendar');

// ── Wall-clock time in a zone ─────────────────────────────────────────────
const LA = 'America/Los_Angeles', TOKYO = 'Asia/Tokyo';
const wall = (ms, tz) => { const p = run('_almTzParts(new Date(' + ms + '), ' + JSON.stringify(tz) + ')'); return [p.y, p.mo, p.d, p.h, p.mi].join('-'); };
let r = run('_almInstantFromTz(2026, 11, 7, 16, 34, ' + JSON.stringify(TOKYO) + ')');
check(r.snapped === false && r.date.getTime() === Date.UTC(2026, 10, 7, 7, 34), 'Tokyo 16:34 is 07:34 UTC, wherever the browser is');
check(wall(r.date.getTime(), TOKYO) === '2026-11-7-16-34', 'and reads back as it was typed');
r = run('_almInstantFromTz(2026, 11, 6, 23, 34, ' + JSON.stringify(LA) + ')');
check(r.date.getTime() === Date.UTC(2026, 10, 7, 7, 34), 'Los Angeles 23:34 on the 6th (PST, UTC-8) is 07:34 UTC on the 7th');
// The hour the clocks skip: 2:30 on 8 March 2026 does not exist in Los Angeles.
r = run('_almInstantFromTz(2026, 3, 8, 2, 30, ' + JSON.stringify(LA) + ')');
check(r.snapped === true && wall(r.date.getTime(), LA) === '2026-3-8-3-30', 'the skipped 2:30 lands on 3:30 and says it was moved, got ' + wall(r.date.getTime(), LA));
r = run('_almInstantFromTz(2026, 3, 8, 1, 59, ' + JSON.stringify(LA) + ')');
check(r.snapped === false && wall(r.date.getTime(), LA) === '2026-3-8-1-59', 'the minute before it is itself');
r = run('_almInstantFromTz(2026, 3, 8, 3, 0, ' + JSON.stringify(LA) + ')');
check(r.snapped === false && wall(r.date.getTime(), LA) === '2026-3-8-3-0', 'and 3:00 is 3:00');
// The hour that happens twice: 1:30 on 1 November 2026 is the first of them (PDT).
r = run('_almInstantFromTz(2026, 11, 1, 1, 30, ' + JSON.stringify(LA) + ')');
check(r.snapped === false && r.date.getTime() === Date.UTC(2026, 10, 1, 8, 30), 'the repeated 1:30 is the first one (PDT, 08:30 UTC)');
// BC and far years round-trip, and a year below 100 stays itself.
for (const y of [-43, 0, 33, 99, 1582, 3000, 270000, -270000]) {
  r = run('_almInstantFromTz(' + y + ', 3, 15, 11, 34, "UTC")');
  check(r.snapped === false && wall(r.date.getTime(), 'UTC') === y + '-3-15-11-34', 'year ' + y + ' reads back as typed, got ' + wall(r.date.getTime(), 'UTC'));
}
r = run('_almInstantFromTz(-43, 3, 15, 11, 34, "Europe/Rome")');
check(wall(r.date.getTime(), 'Europe/Rome') === '-43-3-15-11-34', 'in 44 BC Rome the zone is local mean time, and the wall clock still reads back');

process.exit(failures ? 1 : 0);
