// Klondike, Spider and FreeCell say they are stuck the same way: one helper (ZimiCards.stuckWhen) wraps each game's own
// "is any move left". Klondike looks through the stock for one, Spider counts a deal, and none of them calls a position
// stuck while a move exists.
//
// Run: node tests/test_games_stuck.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
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
const Z = sandbox.ZimiCards, K = sandbox.ZimiSolitaire, F = sandbox.ZimiFreeCell, SP = sandbox.ZimiSpider;
const L = 'A23456789TJQK', S = 'CDHS';
const id = (s) => Z.make(L.indexOf(s[0]) + 1, S.indexOf(s[1]));
const up = (s) => ({ id: id(s), up: true }), down = (s) => ({ id: id(s), up: false });

// The one helper: stuck means not won and no move, with the same words for every game.
for (const [name, rules] of [['Klondike', K], ['Spider', SP], ['FreeCell', F]]) {
  const st = Z.stuckWhen(rules, rules.hasMove);
  check(typeof rules.hasMove === 'function' && typeof st.is === 'function', name + ' asks the shared stuck helper with its own hasMove');
  check(st.title() === 'No moves left' && /Undo a few moves/.test(st.note()), name + ' says the same words (' + st.title() + ' / ' + st.note() + ')');
}
check(/ZimiCards\.stuckWhen|Z\.stuckWhen/.test(fs.readFileSync(path.join(dir, 'freecell.js'), 'utf8')) && !/fc\.stuck/.test(fs.readFileSync(path.join(dir, 'freecell.js'), 'utf8')), 'FreeCell uses the helper, not its own copy');

// ── Klondike ────────────────────────────────────────────────────────────────
// Nothing fits anywhere and the stock is empty: stuck.
const dead = K.blankState(1);
dead.piles.t0 = [up('9C')]; dead.piles.t1 = [up('9S')]; dead.piles.t2 = [up('6D')];
check(!K.hasMove(dead), 'Klondike: nothing fits and no stock or waste: no move');
const stuckK = Z.stuckWhen(K, K.hasMove);
check(stuckK.is(dead) && !stuckK.is(K.almostWon(1)), 'Klondike: stuck on a dead board, not on a board one move from won');

// A move on the tableau: not stuck.
const tab = K.blankState(1);
tab.piles.t0 = [up('9C')]; tab.piles.t1 = [up('8H')];
check(K.hasMove(tab), 'Klondike: an eight of hearts goes on the nine of clubs');

// The stock holds the way out: a card to turn up fits. The 8H is one draw away.
const viaStock = K.blankState(1);
viaStock.piles.t0 = [up('9C')]; viaStock.piles.stock = [down('8H'), down('KS')];   // the last card is turned first: KS, then 8H
check(K.hasMove(viaStock), 'Klondike: not stuck while a turn of the stock brings a playable card');

// A card in the waste that fits.
const waste = K.blankState(1);
waste.piles.t0 = [up('9C')]; waste.piles.waste = [up('8H')];
check(K.hasMove(waste), 'Klondike: the waste card that fits is a move');

// Stock and waste hold cards but none ever fits, however many times it is turned: stuck, and it ends (a repeated pass stops the search).
const loop = K.blankState(3);
loop.piles.t0 = [up('9C')]; loop.piles.t1 = [up('9S')];
loop.piles.stock = [down('2D'), down('4D'), down('QH'), down('JC'), down('3D'), down('2S'), down('3S')];
loop.piles.waste = [up('5H'), up('6S')];
check(!K.hasMove(loop), 'Klondike: a stock that never helps, turned round and round, is stuck');
check(stuckK.is(loop), 'Klondike: and the sheet is offered');

// Taking a card back off a foundation is not a way forward.
const back = K.blankState(1);
back.piles.f0 = [up('AC')]; back.piles.t0 = [up('2C')];
check(K.hasMove(back), 'Klondike: the two of clubs goes up on its ace');
const backOnly = K.blankState(1);
backOnly.piles.f0 = [up('AC'), up('2C')]; backOnly.piles.t0 = [up('3H')];   // the 2C could go on the 3H, but that is not progress
check(!K.hasMove(backOnly), 'Klondike: a card that can only come back down off a foundation does not count');

// ── Spider ──────────────────────────────────────────────────────────────────
const spStuck = SP.blankState(1);
['2S', '4S', '6S', '8S', 'TS', 'QS', '2S', '4S', '6S', '8S'].forEach((c, i) => { spStuck.piles['c' + i] = [up(c)]; });   // every column full, no card one below another
check(!SP.hasMove(spStuck), 'Spider: nothing goes on anything, the stock is empty: no move');
const stuckS = Z.stuckWhen(SP, SP.hasMove);
check(stuckS.is(spStuck), 'Spider: stuck, with every deal done');

const spMove = SP.blankState(1);
spMove.piles.c0 = [up('5S')]; spMove.piles.c1 = [up('6S')];
check(SP.hasMove(spMove), 'Spider: the five goes on the six');

const spDeal = SP.blankState(1);
for (let i = 0; i < 10; i++) spDeal.piles['c' + i] = [up(['5S', '9S', 'KS', '3S', '8S', 'QS', '2S', 'TS', '7S', 'JS'][i])];
spDeal.piles.stock = Array.from({ length: 10 }, () => down('4S'));
check(SP.canDeal(spDeal) && SP.hasMove(spDeal) && !stuckS.is(spDeal), 'Spider: a deal left is a move');
const spHole = Z.clone(spDeal); spHole.piles.c9 = [];   // a deal is refused while a column is empty; but a card may go into the hole
check(!SP.canDeal(spHole) && SP.hasMove(spHole), 'Spider: an empty column refuses a deal but takes a run, so it is a move');

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('stuck: all passed');
