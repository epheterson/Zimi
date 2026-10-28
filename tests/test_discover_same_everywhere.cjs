// Discover is the same on every device all day, and a window left open
// across midnight draws the new day's (Eric, 2026-10-23: "I like leave tabs
// open and the discover content gets stale unless I reload the page.
// EVERYTHING should always be the same everywhere regardless of whether i
// reload the page").
//
// Run: node tests/test_discover_same_everywhere.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
function fn(name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('could not extract ' + name);
  return m[0];
}
let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

const loads = [];
const sandbox = { document: { getElementById: id => (sandbox.row && id === 'discover-row' ? {} : null) }, _loadDiscover: () => loads.push(1) };
vm.createContext(sandbox);
vm.runInContext(['_localDay', '_dayRandom', '_discoverDayCheck'].map(fn).join('\n') + '\nvar _discoverDay = "";', sandbox);

// ── the day's dice ────────────────────────────────────────────────────────
const roll = (seed, n) => { const d = sandbox._dayRandom(seed); return Array.from({ length: n }, d); };
check(JSON.stringify(roll('2026-10-23', 8)) === JSON.stringify(roll('2026-10-23', 8)), 'the same day rolls the same numbers on every device');
check(JSON.stringify(roll('2026-10-23', 8)) !== JSON.stringify(roll('2026-10-24', 8)), 'the next day rolls others');
check(roll('2026-10-23', 1000).every(x => x >= 0 && x < 1), 'every number is in [0, 1)');
const buckets = [0, 0, 0, 0];
roll('2026-10-23', 4000).forEach(x => buckets[Math.floor(x * 4)]++);
check(buckets.every(b => b > 850 && b < 1150), 'and they spread evenly: ' + buckets.join(' '));

// ── the shuffle uses them, never the browser's own ─────────────────────────
const load = fn('_loadDiscover');
check(/_dayRandom\(today\)/.test(load), 'Discover shuffles with the day\'s dice');
check(!/Math\.random/.test(load), '...and never with Math.random, which differed on every device');
check(/visualZims\.sort\(/.test(load), '...from the library in one order everywhere');

// ── the local date, and a new day ─────────────────────────────────────────
check(sandbox._localDay(new Date(2026, 9, 23, 23, 30)) === '2026-10-23', 'the date is the local one, late in the evening too');
check(sandbox._localDay(new Date(2026, 0, 5)) === '2026-01-05', 'month and day are two digits');

const today = sandbox._localDay(new Date());
sandbox._discoverDay = today; sandbox.row = true;
sandbox._discoverDayCheck();
check(loads.length === 0, 'the same day: nothing is drawn again');
sandbox._discoverDay = '2000-01-01';
sandbox.row = false;
sandbox._discoverDayCheck();
check(loads.length === 0, 'a new day with no Discover row on screen: nothing to draw');
sandbox.row = true;
sandbox._discoverDayCheck();
check(loads.length === 1, 'a new day with the row on screen: the new day\'s Discover');
check(/visibilitychange[^\n]*_discoverDayCheck/.test(src) && /_discoverAtMidnight\(\);\n/.test(src), '...checked at midnight and on coming back to the window');

if (failures) { console.error('\n' + failures + ' failed'); process.exit(1); }
console.log('\nall same-everywhere checks passed');
