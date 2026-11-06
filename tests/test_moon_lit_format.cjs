// The Moon's lit share reads the same everywhere: a whole percent. The hero
// card printed the one-decimal figure as JavaScript wrote it, so the same
// night read "24%" in one render and "23.9%" the next, while the sky's facts
// and the tables already said whole percents.
//
// Run: node tests/test_moon_lit_format.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log('FAIL ' + label); } else console.log('ok ' + label); };

const app = fs.readFileSync(path.join(STATIC, 'app.js'), 'utf8');
const m = app.match(/function _moonLitPct\([\s\S]*?\n\}/);
check(!!m, 'app.js has one formatter for the lit share');
if (m) {
  const ctx = vm.createContext({ fmtNum: (n) => String(n) });
  vm.runInContext(m[0], ctx);
  check(ctx._moonLitPct(23.9) === '24%' && ctx._moonLitPct(24) === '24%', 'a whole percent either side of a round figure');
  check(ctx._moonLitPct(0.2) === '0%' && ctx._moonLitPct(99.6) === '100%', 'new and full round as they read');
}
const raw = /illumination\s*\+\s*'%'/;
['almanac.js', 'almanac-sky.js'].forEach((f) =>
  check(!raw.test(fs.readFileSync(path.join(STATIC, f), 'utf8')), f + ' prints the lit share through the formatter'));

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('all passed');
