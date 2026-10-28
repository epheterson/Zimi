// Every localStorage key a game names for itself starts with its page id, so Reset progress (tilemenu.progressRe) finds it.
// Run: node tests/test_games_keys.cjs
const fs = require('fs'), path = require('path'), assert = require('assert');
const DIR = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const ids = new Set(fs.readdirSync(DIR).filter(f => /\.html$/.test(f)).map(f => f.replace(/\.html$/, '')));
// Keys that belong to the shelf or to a kit shared by games, not to one game.
const SHARED = new Set(['recent', 'snaps', 'sort', 'view', 'players', 'watchspeed', 'save', 'stats', 'settings', 'ghost']);
const bad = [];
for (const f of fs.readdirSync(DIR).filter(f => /\.js$/.test(f))) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  for (const m of src.matchAll(/['"]zimi\.games\.([a-z0-9]+)(?:\.[A-Za-z0-9._]*)?['"]/g)) {
    if (!ids.has(m[1]) && !SHARED.has(m[1])) bad.push(f + ': ' + m[0] + ' is not a page id');
  }
}
// No game reads an older dev-build key beside the shell's save: nothing shipped under it, and Reset progress does not list it.
for (const f of fs.readdirSync(DIR).filter(f => /\.js$/.test(f))) {
  if (/zimi\.games\.[a-z0-9]+\.game['"]/.test(fs.readFileSync(path.join(DIR, f), 'utf8'))) bad.push(f + ': reads an old .game save key');
}
assert.deepStrictEqual(bad, [], bad.join('\n'));
console.log('games keys ok');
