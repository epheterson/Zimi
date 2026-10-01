// NEW means something: only a ZIM that came after the library's first day.
//
// A 1.13 design review: on a fresh library every card and every Apps-page
// child said NEW. Everything arrived together; nothing was new.
//
// Run: node tests/test_new_badge.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
let failures = 0;
function ok(name, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || detail === undefined ? '' : '  ' + detail));
  if (!cond) failures++;
}
function extract(re, label) {
  const m = src.match(re);
  if (!m) { console.log('FAIL  could not find ' + label); process.exit(1); }
  return m[0];
}

const NOW = 1790000000;
const DAY = 86400;
const ctx = { Date: { now: () => NOW * 1000 }, zimsCache: [], opened: {} };
vm.createContext(ctx);
vm.runInContext('var _ZIM_BADGE_BACKSTOP_DAYS = 7; function _getZimOpenedMap() { return opened; }\n' +
  extract(/function _zimBadge\(z\) \{[\s\S]*?\nfunction _libraryFirstSeen\(\) \{[\s\S]*?\n\}/, '_zimBadge'), ctx);
const label = (z) => (ctx._zimBadge(z) || {}).label || '';

// A library set up two days ago: everything arrived within its first day.
ctx.zimsCache = [
  { name: 'a', first_seen: NOW - 2 * DAY - 600 },
  { name: 'b', first_seen: NOW - 2 * DAY },
  { name: 'c', first_seen: NOW - 2 * DAY + 3600 },
];
ok('a fresh library: no card says NEW', ctx.zimsCache.every((z) => label(z) === ''), ctx.zimsCache.map(label).join(','));

// Two days on, one more ZIM: that one is new.
ctx.zimsCache = ctx.zimsCache.concat([{ name: 'd', first_seen: NOW - 3600 }]);
ok('a ZIM added after the first day says NEW', label(ctx.zimsCache[3]) === 'new');
ok('...and the first day\'s still do not', ctx.zimsCache.slice(0, 3).every((z) => label(z) === ''));

// An update is always news, first day or not.
ok('an update of a first-day ZIM says Updated', label({ name: 'a', first_seen: NOW - 2 * DAY - 600, updated_at: NOW - 60 }) === 'updated');

// Opened since: no badge; past the backstop: no badge.
ctx.opened = { d: NOW };
ok('opened since it arrived: no badge', label(ctx.zimsCache[3]) === '');
ctx.opened = {};
ok('older than the backstop: no badge', label({ name: 'e', first_seen: NOW - 8 * DAY }) === '');

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
