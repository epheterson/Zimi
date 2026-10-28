// The shelf page draws each piece of card art once (a <symbol> in the sprite, <use>d by every tile): it is the games' first paint.
// Run: node tests/test_games_shelf_size.cjs
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'builtin', 'games', 'index.html'), 'utf8');
const MAX_BYTES = 1.6e6;
assert(html.length < MAX_BYTES, 'index.html is ' + html.length + ' bytes, over ' + MAX_BYTES);
const seen = new Map();
for (const m of html.matchAll(/<svg[^>]*>(?:(?!<svg)[\s\S])*?<\/svg>/g)) if (m[0].length > 2000) seen.set(m[0], (seen.get(m[0]) || 0) + 1);
const dup = [...seen].filter(([, n]) => n > 1);
assert.strictEqual(dup.length, 0, dup.length + ' inline svgs of 2 KB or more appear more than once');
console.log('games shelf size ok');
