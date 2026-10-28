// The patience games say why a card would not go, and FreeCell knows a dead position.
// The words come through ZimiText, so each case is checked against the English string it asks for.
//
// Run: node tests/test_games_solitaire_why.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0, passed = 0;
const check = (ok, label) => {
  if (ok) { passed++; console.log('ok: ' + label); } else { console.error('FAIL: ' + label); failures++; }
};

const sandbox = {
  console, Date, setTimeout, clearTimeout, setInterval, clearInterval,
  document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, documentElement: { classList: { toggle() {} } }, hidden: false }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['text.js', 'cardbacks.js', 'courts.js', 'cards.js', 'solitaire.js', 'freecell.js', 'spider.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
}
const Z = sandbox.ZimiCards, K = sandbox.ZimiSolitaire, F = sandbox.ZimiFreeCell, S = sandbox.ZimiSpider;
const en = key => sandbox.ZimiText.T(key);
const L = 'A23456789TJQK', SU = 'CDHS';
const id = s => Z.make(L.indexOf(s[0]) + 1, SU.indexOf(s[1]));

// ── Klondike ────────────────────────────────────────────────────────────────
{
  const s = K.blankState(1), up = c => ({ id: id(c), up: true }), down = c => ({ id: id(c), up: false });
  s.piles.t0 = [down('9S'), up('5H')]; s.piles.t1 = [up('KS')]; s.piles.t2 = [up('7C'), up('6D')];
  check(K.why(s, 't0', 0) === en('sol.why.facedown'), 'Klondike: a face-down card says it turns over when uncovered');
  check(K.why(s, 't0', 1) === en('sol.why.nowhere'), 'Klondike: a tap with nowhere to go says so');
  check(K.why(s, 't0', 1, 't1') === en('sol.why.build'), 'Klondike: a drop on a column says to build down in alternating colors');
  check(K.why(s, 't0', 1, 't3') === en('sol.why.king'), 'Klondike: a drop on an empty column says only a king');
  check(K.why(s, 't0', 1, 'f0') === en('sol.why.foundation'), 'Klondike: a drop on a foundation says it builds up by suit');
  check(K.why(s, 't2', 0, 'f0') === en('sol.why.oneCard'), 'Klondike: a run on a foundation says one card at a time');
  check(K.why(s, 't0', 1, 'waste') === null && K.why(s, 'nope', 0) === null, 'Klondike: nothing to say about the waste or a missing card');
}

// ── FreeCell ────────────────────────────────────────────────────────────────
{
  const s = F.newState(1);
  F.COLUMNS.concat(F.CELLS, F.FOUNDATION).forEach(p => { s.piles[p] = []; });
  s.piles.c0 = [id('9H'), id('4S'), id('8C')]; s.piles.c1 = [id('KH')];
  check(F.why(s, 'c0', 0) === en('fc.why.run'), 'FreeCell: a card with an unordered run under it says the cards are not in order');
  check(F.why(s, 'c0', 2, 'c1') === en('sol.why.build'), 'FreeCell: a drop on the wrong column says to build down in alternating colors');
  check(F.why(s, 'c0', 2, 'fd0') === en('sol.why.foundation'), 'FreeCell: a drop on a foundation says it builds up by suit');
  s.piles.fr0 = [id('2D')];
  check(F.why(s, 'c0', 2, 'fr0') === en('fc.why.cell'), 'FreeCell: a drop on a cell says a cell holds one card');
  check(F.hasMove(s), 'FreeCell: a position with a free cell has moves');
  // Four cells full of kings, eight single-card columns (fives and sevens: none stacks on another), no ace up: dead.
  const dead = F.newState(1);
  F.COLUMNS.concat(F.CELLS, F.FOUNDATION).forEach(p => { dead.piles[p] = []; });
  F.CELLS.forEach((c, i) => { dead.piles[c] = [id('K' + SU[i])]; });
  F.COLUMNS.forEach((c, i) => { dead.piles[c] = [id((i < 4 ? '5' : '7') + SU[i % 4])]; });
  check(!F.hasMove(dead), 'FreeCell: full cells, nothing that stacks and no ace is a dead position');
  dead.piles.c0 = [];
  check(F.hasMove(dead), 'FreeCell: an empty column brings moves back');
  const all = F.newState(1);
  check(F.hasMove(all), 'FreeCell: a fresh deal has moves');
}

// ── Spider ──────────────────────────────────────────────────────────────────
{
  const s = S.blankState(1), up = c => ({ id: id(c), up: true }), down = c => ({ id: id(c), up: false });
  s.piles.c0 = [down('9S'), up('5H'), up('4S')]; s.piles.c1 = [up('KS')];
  check(S.why(s, 'c0', 0) === en('sol.why.facedown'), 'Spider: a face-down card says it turns over when uncovered');
  check(S.why(s, 'c0', 1) === en('spider.why.run'), 'Spider: cards of two suits do not move together');
  check(S.why(s, 'c0', 2) === en('sol.why.nowhere'), 'Spider: a tap with nowhere to go says so');
  check(S.why(s, 'c0', 2, 'c1') === en('spider.why.rank'), 'Spider: a drop that does not fit says which rank it goes on');
}

console.log(passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
