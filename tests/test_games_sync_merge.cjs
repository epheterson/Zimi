// Two copies of one game key, both changed (a browser offline while another played): nothing a person did is lost
// (app.js _gamesMerge). Stats take the larger counts and every day played; a save the newer one, never two mixed;
// ZimCity's kept cities every city either kept, each whole, newest first, five at most.
// Run: node tests/test_games_sync_merge.cjs
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
const grab = (re, what) => { const m = src.match(re); if (!m) throw new Error('no ' + what); return m[0]; };
const ctx = vm.createContext({});
vm.runInContext(grab(/var _GAMES_KEPT_CITIES = \d+;/, 'kept cap') + '\n' + grab(/function _gamesJSON\(v\) \{[^\n]*\n/, '_gamesJSON') +
  grab(/function _gamesMerge\(k, mine, theirs\) \{[\s\S]*?\n\}\n/, '_gamesMerge'), ctx);
const M = ctx._gamesMerge, J = JSON.stringify, P = JSON.parse;

const a = { v: 1, g: { 'sudoku.html': { n: 5, w: 3 } }, days: { '2026-11-03': { 'sudoku.html': 'lose' } }, best: 2 };
const b = { v: 1, g: { 'sudoku.html': { n: 4, w: 4 }, 'chess.html': { n: 1, w: 0 } }, days: { '2026-11-03': { 'sudoku.html': 'win' }, '2026-11-04': { 'chess.html': 'lose' } }, best: 1 };
const s = P(M('zimi.games.stats', J(a), J(b)));
assert.deepStrictEqual(s.g, { 'sudoku.html': { n: 5, w: 4 }, 'chess.html': { n: 1, w: 0 } });
assert.deepStrictEqual(s.days, { '2026-11-03': { 'sudoku.html': 'win' }, '2026-11-04': { 'chess.html': 'lose' } });
assert.strictEqual(s.best, 2);
console.log('ok: stats keep every game and day, the larger counts and the better result');

const older = J({ v: 1, at: 100, data: 'old' }), newer = J({ v: 1, at: 200, data: 'new' });
assert.strictEqual(M('zimi.games.save.zimcity', older, newer), newer);
assert.strictEqual(M('zimi.games.save.zimcity', newer, older), newer);
console.log('ok: a save is the newer one, whole');

const kept = (ats) => J(ats.map((t) => ({ at: t, data: 'c' + t })));
const k = P(M('zimi.zimcity.kept', kept([5, 3, 1]), kept([6, 3, 2, 4])));
assert.deepStrictEqual(k.map((c) => c.at), [6, 5, 4, 3, 2]);
assert.ok(k.every((c) => c.data === 'c' + c.at));
console.log('ok: kept cities from both, each whole, newest first, five at most');

assert.strictEqual(M('zimi.games.sudoku.settings', 'mine', 'theirs'), 'mine');
assert.strictEqual(M('zimi.games.x', null, 'theirs'), 'theirs');
console.log('ok: anything else is this browser\'s change');
console.log('all passed');
