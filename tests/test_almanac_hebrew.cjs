// The Hebrew calendar lands on the right days.
//
// Every Hebrew date the almanac showed was two to three days off: 22 Sep 2026
// read as 14 Tishrei (it is 11), Passover 5786 as 30 March (it is 2 April),
// and every Rosh Hashanah from 5780 to 5790 two days early. The conversion is
// Maimonides as Fourmilab gives it, whose Hebrew-to-JD step ends in
// `+ day + 1`; ours left that out and then floored a midnight (.5) Julian
// Date, which is the previous day's number. The reference dates below are the
// published ones.
//
// Run: node tests/test_almanac_hebrew.cjs   (exit 0 = pass)

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
function extractVar(src, name) {
  const m = new RegExp('^var ' + name + ' =([^;]*);', 'm').exec(src);
  if (!m) throw new Error('var ' + name + ' not found');
  return 'var ' + name + ' =' + m[1] + ';';
}

const S = { Math, console };
vm.createContext(S);
vm.runInContext(extractVar(almSrc, '_HEBREW_EPOCH'), S);
for (const name of ['_floorMod', '_gregorianToJDN', '_jdnToGregorian', '_hebrewDelay1', '_hebrewDelay2',
  '_hebrewNewYear', '_hebrewDaysInYear', '_hebrewMonthDays', '_hebrewLeapYear', '_hebrewMonthList',
  '_calFirstDayJDN']) {
  vm.runInContext(extractFn(almSrc, name), S);
}
// _jdnToCalendar dispatches to every calendar system; only its Hebrew branch
// runs here, so the other systems' helpers need not exist.
vm.runInContext(extractFn(almSrc, '_jdnToCalendar'), S);

function hebrewOf(y, m, d) {
  const r = S._jdnToCalendar('hebrew', S._gregorianToJDN(y, m, d));
  return { year: r.year, month: S._hebrewMonthList(r.year)[r.month - 1].name, day: r.day };
}
function same(a, b) { return a.year === b.year && a.month === b.month && a.day === b.day; }
function show(h) { return h.day + ' ' + h.month + ' ' + h.year; }

// Rosh Hashanah (1 Tishrei), published dates.
const ROSH_HASHANAH = {
  5780: [2019, 9, 30], 5781: [2020, 9, 19], 5782: [2021, 9, 7], 5783: [2022, 9, 26],
  5784: [2023, 9, 16], 5785: [2024, 10, 3], 5786: [2025, 9, 23], 5787: [2026, 9, 12],
  5788: [2027, 10, 2], 5789: [2028, 9, 21], 5790: [2029, 9, 10],
};
for (const [hy, g] of Object.entries(ROSH_HASHANAH)) {
  const h = hebrewOf(...g);
  check(same(h, { year: +hy, month: 'Tishrei', day: 1 }), `${g.join('-')} is 1 Tishrei ${hy} (got ${show(h)})`);
  check(S._calFirstDayJDN('hebrew', +hy, 1) === S._gregorianToJDN(...g), `the month grid starts ${hy} on ${g.join('-')}`);
}

const FIXED = [
  [[2026, 9, 21], { year: 5787, month: 'Tishrei', day: 10 }, 'Yom Kippur 5787'],
  [[2026, 9, 22], { year: 5787, month: 'Tishrei', day: 11 }, 'the day the bug was found'],
  [[2026, 4, 2], { year: 5786, month: 'Nisan', day: 15 }, 'Passover 5786'],
  [[2025, 12, 15], { year: 5786, month: 'Kislev', day: 25 }, 'Hanukkah 5786'],
  [[2024, 3, 24], { year: 5784, month: 'Adar II', day: 14 }, 'Purim 5784, a leap year'],
  [[2025, 3, 14], { year: 5785, month: 'Adar', day: 14 }, 'Purim 5785, a common year'],
];
for (const [g, want, label] of FIXED) {
  const h = hebrewOf(...g);
  check(same(h, want), `${label}: ${g.join('-')} is ${show(want)} (got ${show(h)})`);
}

// Every day of a decade converts to Hebrew and back to itself.
let roundTrips = 0, broken = null;
for (let jdn = S._gregorianToJDN(2020, 1, 1); jdn < S._gregorianToJDN(2030, 1, 1); jdn++) {
  const r = S._jdnToCalendar('hebrew', jdn);
  const back = S._calFirstDayJDN('hebrew', r.year, r.month) + r.day - 1;
  if (back !== jdn) { broken = broken || [jdn, r, back]; } else roundTrips++;
}
check(broken === null, 'every day of 2020-2029 converts to Hebrew and back' + (broken ? ' (first miss: ' + JSON.stringify(broken) + ')' : ''));

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all Hebrew calendar checks passed (' + roundTrips + ' round trips)');
