// A moon-phase mark on the month grid sits on the viewer's own day.
//
// The grid asked whether a principal phase fell between noon and noon UTC,
// so a full moon at 02:00 in Tokyo (17:00 UTC the day before) was marked on
// the day before. Of 2026's 50 principal phases, 12 were a day early in Los
// Angeles, 29 in London and 45 in Tokyo. The day a phase belongs to is the
// local calendar day of the almanac's place.
//
// _moonPhase is replaced here by a clock that reaches Full Moon at an exact
// instant, so the test is about which day the grid picks, not lunar theory.
//
// Run: node tests/test_almanac_phase_marks.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const almSrc = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac.js'), 'utf8');

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

const S = { Math, Date, Intl, Object, JSON, console };
vm.createContext(S);
vm.runInContext('var _tzFmtCache = {}; var _currentLang = "en";', S);
vm.runInContext(almSrc.slice(almSrc.indexOf('var _PRINCIPAL_PHASES'), almSrc.indexOf('];', almSrc.indexOf('var _PRINCIPAL_PHASES')) + 2), S);
for (const name of ['_gregorianToJDN', '_tzFmt', '_tzUtcOffsetMin', '_principalPhaseOnDay']) {
  vm.runInContext(extractFn(almSrc, name), S);
}

const SYNODIC_MS = 29.530588 * 86400000;
function moonClock(fullAtUtcMs) {
  // phase 0.5 exactly at fullAtUtcMs, advancing uniformly.
  S._moonPhase = (d) => ({ phase: ((((d.getTime() - fullAtUtcMs) / SYNODIC_MS + 0.5) % 1) + 1) % 1 });
}
function markedDay(tz, y, m, candidates) {
  for (const d of candidates) {
    const pp = S._principalPhaseOnDay(S._gregorianToJDN(y, m, d), tz);
    if (pp && pp.name === 'Full Moon') return d;
  }
  return null;
}

// Full moon at 2026-10-26 04:12 UTC (the real one is at 04:12 UTC).
moonClock(Date.UTC(2026, 9, 26, 4, 12));
const days = [24, 25, 26, 27, 28];
check(markedDay('UTC', 2026, 10, days) === 26, 'UTC: the 26th');
check(markedDay('Asia/Tokyo', 2026, 10, days) === 26, 'Tokyo (13:12 local on the 26th): the 26th');
check(markedDay('America/Los_Angeles', 2026, 10, days) === 25, 'Los Angeles (21:12 local on the 25th): the 25th');

// Full moon at 2026-03-03 11:38 UTC.
moonClock(Date.UTC(2026, 2, 3, 11, 38));
check(markedDay('Asia/Tokyo', 2026, 3, [1, 2, 3, 4, 5]) === 3, 'Tokyo (20:38 on the 3rd): the 3rd');
check(markedDay('Pacific/Kiritimati', 2026, 3, [1, 2, 3, 4, 5]) === 4, 'Kiritimati, UTC+14 (01:38 on the 4th): the 4th');
check(markedDay('Europe/London', 2026, 3, [1, 2, 3, 4, 5]) === 3, 'London: the 3rd');

// Exactly one day carries the mark, wherever you are.
for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Europe/London', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
  let marks = 0;
  for (let d = 1; d <= 6; d++) {
    const pp = S._principalPhaseOnDay(S._gregorianToJDN(2026, 3, d), tz);
    if (pp && pp.name === 'Full Moon') marks++;
  }
  check(marks === 1, tz + ': one full-moon mark, not ' + marks);
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all phase-mark checks passed');
