// Arcade's second set of card games (Spider, Hearts, Pyramid, Golf, TriPeaks):
// the rules as pure functions on plain states. Legal moves, scoring, win
// detection, Hearts' passing, the moon and its computer players (played
// through whole games, every play checked legal). No DOM: the game files run
// their page wiring only when a #zc-table exists.
//
// Run: node tests/test_games_more_cards.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0, passed = 0;
const check = (ok, label) => {
  if (ok) { passed++; console.log('ok: ' + label); } else { console.error('FAIL: ' + label); failures++; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const sandbox = {
  console, Date, setTimeout, clearTimeout, setInterval, clearInterval,
  document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, documentElement: { classList: { toggle() {} } }, hidden: false }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['text.js', 'cardbacks.js', 'courts.js', 'cards.js', 'golf.js', 'pyramid.js', 'tripeaks.js', 'spider.js', 'cardtable.js', 'hearts.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
}
const Z = sandbox.ZimiCards, G = sandbox.ZimiGolf, P = sandbox.ZimiPyramid, T = sandbox.ZimiTriPeaks, S = sandbox.ZimiSpider, H = sandbox.ZimiHearts;
const L = 'A23456789TJQK', SU = 'CDHS';
const id = (s, copy = 0) => copy * 52 + Z.make(L.indexOf(s[0]) + 1, SU.indexOf(s[1]));
// A seeded generator, so a failure replays.
const lcg = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const order = seed => Z.shuffled(lcg(seed));

// ── Shared module changes ───────────────────────────────────────────────────
check(Z.suit(52 + 13 * 3) === 3 && Z.rank(52 + 12) === 13 && Z.isRed(52 + 13) && Z.cardName(52 + 12) === 'king of clubs', 'ids past 51 are second-deck copies of the same faces');
check(!/NaN|undefined/.test(Z.faceMarkup(104 + id('QH'), false)), 'a copy of a card draws as its face');

// ── Golf ────────────────────────────────────────────────────────────────────
{
  const st = G.newState(order(1));
  const all = [].concat(...G.COLUMNS.map(c => st.piles[c]), st.piles.stock, st.piles.waste);
  check(G.COLUMNS.every(c => st.piles[c].length === 5), 'Golf deals seven columns of five');
  check(st.piles.waste.length === 1 && st.piles.stock.length === 16 && new Set(all).size === 52, 'Golf turns one card to the waste, 16 stay in the stock, all 52 once');
  check(G.fits(id('7H'), id('8S')) && G.fits(id('7H'), id('6S')) && !G.fits(id('7H'), id('7S')) && !G.fits(id('7H'), id('9S')), 'Golf: one rank up or down, not the same, not two');
  check(!G.fits(id('KH'), id('AS')) && !G.fits(id('AH'), id('KS')), 'Golf: no wrap from king to ace or back');
  check(G.fits(id('KH'), id('QS')) && G.fits(id('2H'), id('AS')), 'Golf: a queen takes a king, an ace takes a deuce');
  const s = G.newState(order(2));
  s.piles.waste = [id('5S')]; s.piles.c0 = [id('2C'), id('6H')]; s.piles.c1 = [id('KC'), id('9D')];
  check(G.canPick(s, 'c0', 1) && !G.canPick(s, 'c0', 0), 'Golf: only a column\'s bottom card can be taken');
  check(G.legalMove(s, 'c0', 1, 'waste') && !G.legalMove(s, 'c1', 1, 'waste'), 'Golf: 6 onto 5 is legal, 9 onto 5 is not');
  check(G.bestMove(s, 'c0', 1) === 'waste' && G.bestMove(s, 'c1', 1) === null, 'Golf: a tap goes to the waste or nowhere');
  const m = G.applyMove(s, 'c0', 1, 'waste');
  check(m.piles.c0.length === 1 && G.canPick(m, 'c0', 0) && m.piles.waste.slice(-1)[0] === id('6H') && m.moves === 1 && s.piles.c0.length === 2, 'Golf: a move puts the card on the waste, exposes the next, leaves the old state alone');
  const d = G.drawStock(m);
  check(d.piles.waste.length === 3 && d.piles.stock.length === m.piles.stock.length - 1, 'Golf: the stock turns one card onto the waste');
  check(G.drawStock(Object.assign(Z.clone(m), { piles: Object.assign(Z.clone(m.piles), { stock: [] }) })) === null, 'Golf: an empty stock cannot be turned');
  const w = G.almostWon();
  check(!G.isWon(w) && G.left(w) === 1 && G.legalMove(w, 'c3', 0, 'waste'), 'Golf: the debug state is one legal card from a win');
  check(G.isWon(G.applyMove(w, 'c3', 0, 'waste')) && G.left(G.applyMove(w, 'c3', 0, 'waste')) === 0, 'Golf: clearing the columns wins');
  const stuck = G.newState(order(3));
  G.COLUMNS.forEach(c => { stuck.piles[c] = [id('9C')]; }); stuck.piles.stock = []; stuck.piles.waste = [id('3H')];
  check(G.isStuck(stuck) && !G.isStuck(Object.assign(Z.clone(stuck), { piles: Object.assign(Z.clone(stuck.piles), { stock: [id('2C')] }) })), 'Golf: stuck when nothing fits and the stock is empty');
}

// ── Pyramid ─────────────────────────────────────────────────────────────────
{
  const st = P.newState(order(4));
  check(P.PYRAMID.length === 28 && P.PYRAMID.every(p => st.piles[p].length === 1) && st.piles.stock.length === 24 && st.piles.waste.length === 0, 'Pyramid: 28 in the pyramid, 24 in the stock');
  check(P.PYRAMID.filter(p => P.isFree(st, p)).join() === ['p6_0', 'p6_1', 'p6_2', 'p6_3', 'p6_4', 'p6_5', 'p6_6'].join(), 'Pyramid: only the bottom row is free at the start');
  const s = Z.clone(st);
  P.PYRAMID.forEach(p => { s.piles[p] = []; });
  s.piles.p5_0 = [id('6H')]; s.piles.p6_0 = [id('7S')]; s.piles.p6_1 = [id('KD')]; s.piles.p6_2 = [id('5C')];
  s.piles.waste = [id('8D')];
  check(!P.isFree(s, 'p5_0'), 'Pyramid: a card is not free while a card below overlaps it');
  s.piles.p6_0 = []; s.piles.p6_1 = [];
  check(P.isFree(s, 'p5_0'), 'Pyramid: it frees once both overlapping cards are gone');
  s.piles.p6_1 = [id('KD')];
  check(!P.isFree(s, 'p5_0'), 'Pyramid: one overlapping card is enough to hold it');
  s.piles.p6_0 = [id('7S')];
  check(P.isPair(s, 'p6_0', 'p6_0') === false, 'Pyramid: a card does not pair with itself');
  s.piles.p6_0 = [id('7S')]; s.piles.p6_1 = [id('6D')];
  check(P.isPair(s, 'p6_0', 'p6_1') && P.legalMove(s, 'p6_0', 0, 'p6_1'), 'Pyramid: 7 and 6 make 13');
  check(!P.isPair(s, 'p6_0', 'p6_2') && !P.legalMove(s, 'p6_0', 0, 'p6_2'), 'Pyramid: 7 and 5 do not');
  check(!P.isPair(s, 'p6_1', 'waste'), 'Pyramid: the waste pairs by value (6 and 8 do not make 13)');
  s.piles.waste = [id('7D')];
  check(P.isPair(s, 'p6_1', 'waste') && P.legalMove(s, 'p6_1', 0, 'waste'), 'Pyramid: the top of the waste pairs with a free card (6 and 7)');
  s.piles.p6_2 = [id('KH')];
  check(P.isKing(s, 'p6_2') && P.legalMove(s, 'p6_2', 0, 'out') && !P.legalMove(s, 'p6_0', 0, 'out'), 'Pyramid: a free king goes alone, nothing else does');
  s.piles.p6_3 = [id('QC')]; s.piles.p6_4 = [id('AS')];
  check(P.isPair(s, 'p6_3', 'p6_4') && P.isPair(s, 'p6_4', 'p6_3'), 'Pyramid: queen (12) and ace (1) make 13');
  const t = P.takeAway(s, ['p6_3', 'p6_4']);
  check(t.piles.out.length === 2 && t.piles.p6_3.length === 0 && t.piles.p6_4.length === 0 && t.score === 2 * P.SCORE.card && t.moves === 1, 'Pyramid: a pair goes to the out pile and scores');
  check(P.takeAway(s, ['p6_2']).score === P.SCORE.card, 'Pyramid: a king scores once');
  // Stock and waste.
  const d = P.newState(order(5));
  const d1 = P.drawStock(d);
  check(d1.piles.waste.length === 1 && d1.piles.stock.length === 23, 'Pyramid: the stock turns one card at a time');
  let r = d;
  while (r.piles.stock.length) r = P.drawStock(r);
  check(P.canDraw(r) && r.piles.stock.length === 0, 'Pyramid: with the stock empty the waste can go round again');
  const r1 = P.drawStock(r);
  check(r1.piles.stock.length === 24 && r1.piles.waste.length === 0 && r1.redeals === 1, 'Pyramid: a redeal moves the waste back to the stock');
  let r2 = r1; while (r2.piles.stock.length) r2 = P.drawStock(r2);
  r2 = P.drawStock(r2); while (r2.piles.stock.length) r2 = P.drawStock(r2);
  check(r2.redeals === P.MAX_REDEALS && P.drawStock(r2) === null, 'Pyramid: two redeals, then no more');
  const w = P.almostWon();
  check(!P.isWon(w) && P.pyramidLeft(w) === 2 && P.findMove(w) !== null, 'Pyramid: the debug state has a pair left to take');
  check(!P.legalMove(w, 'p6_2', 0, 'p6_4'), 'Pyramid: 7 and king is not a pair');
}
{
  // The debug state: 7 and king left in the pyramid, a 6 on the waste: 7 + 6 clears the 7, the king goes alone.
  const w = P.almostWon();
  const a = P.applyMove(w, 'p6_2', 0, 'waste');
  check(P.pyramidLeft(a) === 1 && !P.isWon(a), 'Pyramid: a pair from the waste leaves the king');
  const b = P.applyMove(a, 'p6_4', 0, 'out');
  check(P.isWon(b) && b.score === 3 * P.SCORE.card + P.SCORE.clear + P.SCORE.redealLeft * P.MAX_REDEALS, 'Pyramid: clearing wins with the clear bonus and a bonus for each redeal unused');
  const stuck = P.newState(order(6));
  P.PYRAMID.forEach(p => { stuck.piles[p] = []; }); stuck.piles.p6_0 = [id('2C')]; stuck.piles.p6_1 = [id('3C')];
  stuck.piles.stock = []; stuck.piles.waste = []; stuck.redeals = P.MAX_REDEALS;
  check(P.isStuck(stuck) && P.findMove(stuck) === null, 'Pyramid: stuck with no pair, no king and nothing to turn');
  // A whole game of random legal play keeps every card exactly once.
  let ok = true;
  for (let seed = 1; seed <= 40; seed++) {
    let s = P.newState(order(seed)), rng = lcg(seed), guard = 0;
    while (!P.isWon(s) && guard++ < 400) {
      const mv = P.findMove(s);
      if (mv && rng() < 0.9) s = P.applyMove(s, mv.from, 0, mv.to);
      else { const d2 = P.drawStock(s); if (!d2) { if (!mv) break; continue; } s = d2; }
      const cards = [].concat(...Object.keys(s.piles).map(k => s.piles[k]));
      if (cards.length !== 52 || new Set(cards).size !== 52) { ok = false; break; }
    }
  }
  check(ok, 'Pyramid: 40 random games never lose or duplicate a card');
}

// ── TriPeaks ────────────────────────────────────────────────────────────────
{
  const st = T.newState(order(7));
  check(T.TABLEAU.length === 28 && T.ROW_X.map(r => r.length).join() === '3,6,9,10', 'TriPeaks: rows of 3, 6, 9 and 10 make 28');
  check(st.piles.stock.length === 23 && st.piles.waste.length === 1, 'TriPeaks: 23 in the stock after one is turned');
  const all = [].concat(...Object.keys(st.piles).map(k => st.piles[k]));
  check(all.length === 52 && new Set(all).size === 52, 'TriPeaks: all 52 dealt once');
  check(same(T.COVERS.k0_0, ['k1_0', 'k1_1']) && same(T.COVERS.k1_1, ['k2_1', 'k2_2']) && same(T.COVERS.k2_2, ['k3_2', 'k3_3']) && T.COVERS.k3_4.length === 0, 'TriPeaks: each card is overlapped by the two below it, the bottom row by none');
  check(T.COVERS.k1_1.every(c => T.COVERS.k1_2.indexOf(c) < 0) && same(T.COVERS.k1_2, ['k2_3', 'k2_4']), 'TriPeaks: the three peaks are separate above the bottom row');
  const bottom = T.TABLEAU.filter(p => T.isFree(st, p));
  check(bottom.length === 10 && bottom.every(p => p.indexOf('k3_') === 0), 'TriPeaks: the ten bottom cards are free at the start');
  check(T.fits(id('KH'), id('AS')) && T.fits(id('AH'), id('KS')) && T.fits(id('7H'), id('6S')) && T.fits(id('7H'), id('8S')) && !T.fits(id('7H'), id('7S')) && !T.fits(id('QH'), id('AS')), 'TriPeaks: neighbours either way, with king and ace wrapping');
  const s = Z.clone(st);
  T.TABLEAU.forEach(p => { s.piles[p] = []; });
  s.piles.k3_0 = [id('5H')]; s.piles.k3_1 = [id('6C')]; s.piles.k2_0 = [id('9D')]; s.piles.k3_5 = [id('KS')];
  s.piles.waste = [id('4D')]; s.piles.stock = [id('2S'), id('AS')];
  check(T.isFree(s, 'k3_0') && !T.isFree(s, 'k2_0'), 'TriPeaks: a card with something on it is not free');
  check(T.legalMove(s, 'k3_0', 0, 'waste') && !T.legalMove(s, 'k3_1', 0, 'waste') && !T.legalMove(s, 'k2_0', 0, 'waste'), 'TriPeaks: 5 on 4 is legal; 6 is not; a covered card is not');
  const a = T.applyMove(s, 'k3_0', 0, 'waste');
  check(a.streak === 1 && a.score === T.SCORE.perStreak && a.piles.waste.slice(-1)[0] === id('5H'), 'TriPeaks: the first card of a streak scores its base');
  const b = T.applyMove(a, 'k3_1', 0, 'waste');
  check(b.streak === 2 && b.score === T.SCORE.perStreak * 3, 'TriPeaks: the second card of a streak scores twice the base (1 + 2 times the base in all)');
  check(!T.isFree(a, 'k2_0') && T.isFree(b, 'k2_0'), 'TriPeaks: a card frees when both overlapping cards are gone');
  const dr = T.drawStock(b);
  check(dr.streak === 0 && dr.score === b.score && dr.piles.stock.length === 1, 'TriPeaks: turning the stock breaks the streak and costs nothing');
  check(T.drawStock(Object.assign(Z.clone(s), { piles: Object.assign(Z.clone(s.piles), { stock: [] }) })) === null, 'TriPeaks: no card to turn from an empty stock');
  // Peak and win bonuses.
  const w = T.almostWon();
  check(T.legalMove(w, 'k3_4', 0, 'waste') && !T.isWon(w), 'TriPeaks: the debug state is one wrapping card from a win (ace on king)');
  const won = T.applyMove(w, 'k3_4', 0, 'waste');
  check(T.isWon(won) && won.score === T.SCORE.perStreak * 13 + T.SCORE.stockLeft * 2, 'TriPeaks: the last card scores its streak (13th) and each unused stock card pays');
  const peak = Z.clone(st);
  T.TABLEAU.forEach(p => { peak.piles[p] = []; });
  peak.piles.k0_1 = [id('5S')]; peak.piles.k3_9 = [id('2C')]; peak.piles.waste = [id('4S')]; peak.piles.stock = [];
  const pk = T.applyMove(peak, 'k0_1', 0, 'waste');
  check(pk.score === T.SCORE.perStreak + T.SCORE.peak && T.peaksCleared(pk) === 3, 'TriPeaks: taking a peak\'s top card adds the peak bonus and counts the peak cleared');
  const stuck = Z.clone(peak); stuck.piles.waste = [id('9C')]; stuck.piles.k3_9 = [id('2C')]; stuck.piles.k0_1 = [];
  check(T.isStuck(stuck) && !T.isStuck(Object.assign(Z.clone(stuck), { piles: Object.assign(Z.clone(stuck.piles), { waste: [id('3C')] }) })), 'TriPeaks: stuck when nothing fits and the stock is empty');
  let ok = true;
  for (let seed = 1; seed <= 40; seed++) {
    let s2 = T.newState(order(seed)), rng = lcg(seed), guard = 0;
    while (!T.isWon(s2) && guard++ < 200) {
      const mv = T.TABLEAU.filter(p => T.legalMove(s2, p, 0, 'waste'))[0];
      if (mv) s2 = T.applyMove(s2, mv, 0, 'waste'); else { const d2 = T.drawStock(s2); if (!d2) break; s2 = d2; }
      const cards = [].concat(...Object.keys(s2.piles).map(k => s2.piles[k]));
      if (cards.length !== 52 || new Set(cards).size !== 52) { ok = false; break; }
    }
  }
  check(ok, 'TriPeaks: 40 random games never lose or duplicate a card');
}

// ── Spider ──────────────────────────────────────────────────────────────────
{
  [1, 2, 4].forEach(n => {
    const d = S.deck(n), suits = {};
    d.forEach(c => { const k = Z.suit(c); suits[k] = (suits[k] || 0) + 1; });
    check(d.length === 104 && new Set(d).size === 104, 'Spider (' + n + ' suit' + (n > 1 ? 's' : '') + '): 104 distinct cards');
    check(Object.keys(suits).length === n && Object.keys(suits).every(k => suits[k] === 104 / n), 'Spider (' + n + '): ' + n + ' suit(s), evenly');
  });
  const st = S.newState(S.shuffledDeck(2, lcg(8)), 2);
  check(S.COLUMNS.map(c => st.piles[c].length).join() === '6,6,6,6,5,5,5,5,5,5' && st.piles.stock.length === 50, 'Spider deals 6,6,6,6,5,5,5,5,5,5 and keeps 50');
  check(S.COLUMNS.every(c => st.piles[c].every((k, i) => k.up === (i === st.piles[c].length - 1))), 'Spider: only the last card of each column is face up');
  check(st.score === S.SCORE.start && S.canDeal(st), 'Spider starts at 500 and may deal');
  // Rules on a built board.
  const s = S.blankState(4), up = (c) => ({ id: c, up: true }), dn = (c) => ({ id: c, up: false });
  s.piles.c0 = [dn(id('3D')), up(id('7S')), up(id('6S')), up(id('5S'))];
  s.piles.c1 = [up(id('8H'))];
  s.piles.c2 = [up(id('8S'))];
  s.piles.c3 = [up(id('6H')), up(id('5D'))];
  s.piles.c4 = [];
  check(S.canPick(s, 'c0', 1) && S.canPick(s, 'c0', 3) && !S.canPick(s, 'c0', 0) && !S.canPick(s, 'c3', 0), 'Spider: a run must be face up and all one suit to be picked');
  check(S.isSuitRun([id('7S'), id('6S'), id('5S')]) && !S.isSuitRun([id('7S'), id('6H')]) && !S.isSuitRun([id('7S'), id('5S')]), 'Spider: a suit run is one suit, one rank apart');
  check(S.legalMove(s, 'c0', 1, 'c1') && S.legalMove(s, 'c0', 1, 'c2'), 'Spider: a run goes on the next rank up in any suit');
  check(!S.legalMove(s, 'c3', 1, 'c0') && S.legalMove(s, 'c0', 3, 'c3') === false && !S.legalMove(s, 'c0', 1, 'c0'), 'Spider: not onto the wrong rank or onto itself');
  check(S.legalMove(s, 'c0', 1, 'c4') && S.legalMove(s, 'c3', 1, 'c4'), 'Spider: anything goes into an empty column');
  const m = S.applyMove(s, 'c0', 1, 'c1');
  check(m.piles.c1.length === 4 && m.piles.c0.length === 1 && m.piles.c0[0].up === true && m.score === S.SCORE.start - 1 && m.moves === 1, 'Spider: a move carries the run, turns over the card beneath, costs a point');
  check(S.bestMove(s, 'c0', 1) === 'c2' || S.bestMove(s, 'c0', 1) === 'c1', 'Spider: a tap picks a column that takes the run');
  check(S.bestMove(s, 'c3', 1) === null && S.bestMove(s, 'c0', 0) === null, 'Spider: a tap with nowhere to go does nothing');
  // Prefer same suit.
  const pref = S.blankState(4);
  pref.piles.c0 = [up(id('8H'))]; pref.piles.c1 = [up(id('8S'))]; pref.piles.c2 = [up(id('7S'))];
  check(S.bestMove(pref, 'c2', 0) === 'c1', 'Spider: a tap prefers the column of the same suit');
  // Dealing.
  const dealt = S.dealRow(st);
  check(dealt.piles.stock.length === 40 && S.COLUMNS.every((c, i) => dealt.piles[c].length === st.piles[c].length + 1 && dealt.piles[c].slice(-1)[0].up) && dealt.score === st.score - 1, 'Spider: a deal puts one face-up card on each column');
  const hole = Z.clone(st); hole.piles.c3 = [];
  check(!S.canDeal(hole) && S.dealRow(hole) === null, 'Spider: no deal while a column is empty');
  const none = Z.clone(st); none.piles.stock = [];
  check(!S.canDeal(none), 'Spider: no deal from an empty stock');
  // A run leaves.
  const run = S.blankState(1);
  const spade = (r, k = 0) => k * 52 + Z.make(r, 3);
  run.piles.c0 = [dn(spade(9, 1)), up(spade(13))]; for (let r = 12; r >= 2; r--) run.piles.c0.push(up(spade(r)));
  run.piles.c1 = [up(spade(1))];
  check(S.canPick(run, 'c1', 0) && S.legalMove(run, 'c1', 0, 'c0'), 'Spider: an ace goes on a 2');
  const done = S.applyMove(run, 'c1', 0, 'c0');
  check(done.piles.d0.length === 13 && done.piles.c0.length === 1 && done.piles.c0[0].up === true && S.runsDone(done) === 1, 'Spider: a finished K to A run leaves the column and the card under it turns up');
  check(done.score === S.SCORE.start - 1 + S.SCORE.run && done.piles.d0[0] % 13 === 12 && done.piles.d0[12] % 13 === 0, 'Spider: a run scores 100 and sits king first');
  // A run that is not one suit does not leave.
  const mixed = Z.clone(run); mixed.piles.c0[5] = up(id('8H', 0));
  check(S.applyMove(mixed, 'c1', 0, 'c0').piles.d0.length === 0, 'Spider: a mixed-suit sequence stays on the table');
  // A deal can finish a run too.
  const byDeal = S.blankState(1);
  S.COLUMNS.forEach(c => { byDeal.piles[c] = [up(spade(5, 2))]; });
  byDeal.piles.c0 = [up(spade(13))]; for (let r = 12; r >= 2; r--) byDeal.piles.c0.push(up(spade(r)));
  byDeal.piles.stock = []; for (let i = 0; i < 10; i++) byDeal.piles.stock.push(dn(i === 9 ? spade(1, 6) : spade(5, 3)));
  // the stock pops from the end, so column c0 receives the last element.
  const bd = S.dealRow(byDeal);
  check(S.runsDone(bd) === 1 && bd.piles.c0.length === 0, 'Spider: a dealt ace can complete a run');
  // Win.
  const w = S.almostWon();
  check(S.runsDone(w) === 7 && !S.isWon(w), 'Spider: the debug state has seven runs done');
  const final = S.applyMove(w, 'c1', 0, 'c0');
  check(S.isWon(final) && S.runsDone(final) === 8, 'Spider: eight runs wins');
  // Random play keeps all 104 cards.
  let ok = true;
  for (let seed = 1; seed <= 20; seed++) {
    let s2 = S.newState(S.shuffledDeck([1, 2, 4][seed % 3], lcg(seed)), [1, 2, 4][seed % 3]), rng = lcg(seed * 7);
    for (let step = 0; step < 300 && !S.isWon(s2); step++) {
      const options = [];
      S.COLUMNS.forEach(a => s2.piles[a].forEach((k, i) => { if (S.canPick(s2, a, i)) S.COLUMNS.forEach(b => { if (S.legalMove(s2, a, i, b)) options.push([a, i, b]); }); }));
      if (options.length) { const o = options[Math.floor(rng() * options.length)]; s2 = S.applyMove(s2, o[0], o[1], o[2]); }
      else { const d2 = S.dealRow(s2); if (!d2) break; s2 = d2; }
      const cards = [].concat(...S.COLUMNS.map(c => s2.piles[c].map(k => k.id)), s2.piles.stock.map(k => k.id), ...S.DONE.map(d => s2.piles[d]));
      if (cards.length !== 104 || new Set(cards).size !== 104) { ok = false; break; }
    }
  }
  check(ok, 'Spider: 20 random games never lose or duplicate a card');
}

// ── Hearts ──────────────────────────────────────────────────────────────────
{
  const st = H.newGame(order(9));
  check(st.hands.every(h => h.length === 13) && new Set([].concat(...st.hands)).size === 52, 'Hearts deals 13 to each of four, all 52 once');
  check(st.phase === 'pass' && st.passDir === 0 && st.scores.join() === '0,0,0,0', 'Hearts: hand 1 passes left; scores start at 0');
  check([0, 1, 2, 3, 4].map(n => H.dealHand(order(n), n, [0, 0, 0, 0]).phase).join() === 'pass,pass,pass,play,pass', 'Hearts: pass left, right, across, then hold, then round again');
  const mine = H.sortHand(st.hands[0]);
  check(same(mine, st.hands[0]) && st.hands[0].every((c, i, a) => i === 0 || Z.suit(a[i - 1]) !== Z.suit(c) || (a[i - 1] % 13 + 12) % 13 <= (c % 13 + 12) % 13), 'Hearts: a hand is sorted by suit, ace high');
  check(H.points(id('QS')) === 13 && H.points(id('AH')) === 1 && H.points(id('2H')) === 1 && H.points(id('KS')) === 0 && H.points(id('QC')) === 0, 'Hearts: each heart is 1 point, the queen of spades 13');
  let total = 0; for (let c = 0; c < 52; c++) total += H.points(c);
  check(total === 26, 'Hearts: 26 points in the deck');

  // Passing.
  const picks = [0, 1, 2, 3].map(s => H.choosePass(st.hands[s]));
  check(picks.every((p, s) => p.length === 3 && new Set(p).size === 3 && p.every(c => st.hands[s].indexOf(c) >= 0)), 'Hearts: each computer player picks three of its own cards to pass');
  [0, 1, 2].forEach(dir => {
    const base = H.dealHand(order(20 + dir), dir, [0, 0, 0, 0]), pk = [0, 1, 2, 3].map(s => base.hands[s].slice(0, 3));
    const after = H.applyPass(base, pk), to = [1, 3, 2][dir];
    check(after.hands.every(h => h.length === 13) && new Set([].concat(...after.hands)).size === 52, 'Hearts pass ' + H.PASS_NAMES[dir] + ': everyone still holds 13, all 52 once');
    check([0, 1, 2, 3].every(s => pk[s].every(c => after.hands[(s + to) % 4].indexOf(c) >= 0)), 'Hearts pass ' + H.PASS_NAMES[dir] + ': each seat\'s three go to the seat ' + (dir === 0 ? 'on its left (next to play)' : dir === 1 ? 'on its right' : 'across'));
    check(same(after.received.slice().sort(), pk[(4 - to) % 4].slice().sort()) && after.phase === 'play', 'Hearts pass ' + H.PASS_NAMES[dir] + ': you are told which cards you received');
    check(after.hands[after.turn].indexOf(H.TWO_CLUBS) >= 0 && after.turn === after.leader, 'Hearts pass ' + H.PASS_NAMES[dir] + ': the holder of the 2 of clubs leads');
  });
  const pass0 = H.dealHand(order(30), 0, [0, 0, 0, 0]);
  const give = [0, 1, 2, 3].map(s => pass0.hands[s].slice(0, 3));
  check(H.applyPass(pass0, give).hands[1].filter(c => give[0].indexOf(c) >= 0).length === 3, 'Hearts: passing left puts your three in the west hand (the next seat clockwise)');

  // The computer's pass is sensible: the queen of spades goes, with few spades to cover her.
  const hand = [id('QS'), id('2S'), id('3S'), id('2C'), id('4C'), id('6C'), id('3D'), id('5D'), id('8D'), id('9D'), id('JD'), id('4H'), id('7H')];
  const pass = H.choosePass(hand);
  check(pass.indexOf(id('QS')) >= 0, 'Hearts AI: passes the queen of spades when it has few spades');
  const covered = [id('QS'), id('2S'), id('3S'), id('4S'), id('6S'), id('8S'), id('2C'), id('3C'), id('4C'), id('6C'), id('3D'), id('5D'), id('8D')];
  check(H.choosePass(covered).indexOf(id('QS')) < 0 || H.choosePass(covered).length === 3, 'Hearts AI: keeps the queen when it is well covered, or at least passes three');
  const hot = [id('AH'), id('KH'), id('QH'), id('2C'), id('3C'), id('4C'), id('5C'), id('3D'), id('5D'), id('6D'), id('8D'), id('2S'), id('4S')];
  check(['AH', 'KH', 'QH'].every(c => H.choosePass(hot).indexOf(id(c)) >= 0), 'Hearts AI: passes the high hearts');

  // Rules of play.
  const mk = (hands, extra) => Object.assign(H.dealHand(order(40), 3, [0, 0, 0, 0]), { hands: hands.map(h => h.slice()), phase: 'play', tricksPlayed: 1, broken: false, trick: [], taken: [[], [], [], []], received: [] }, extra);
  const hh = [[id('3C'), id('KD'), id('2H'), id('QS')], [id('4C'), id('5D')], [id('9S'), id('JH')], [id('2D'), id('AH')]];
  let g = mk(hh, { turn: 0, leader: 0 });
  check(same(H.legalPlays(g, 0).sort(), [id('3C'), id('KD'), id('QS')].sort()), 'Hearts: you cannot lead a heart until hearts are broken');
  g.broken = true;
  check(H.legalPlays(g, 0).length === 4, 'Hearts: once broken, hearts may lead');
  check(H.legalPlays(mk([[id('2H'), id('AH')], [], [], []], { turn: 0 }), 0).length === 2, 'Hearts: a hand of only hearts may lead one');
  g = mk(hh, { turn: 1, leader: 0, trick: [{ seat: 0, id: id('3C') }] });
  check(same(H.legalPlays(g, 1), [id('4C')]), 'Hearts: you must follow suit');
  g = mk(hh, { turn: 2, leader: 0, trick: [{ seat: 0, id: id('3C') }, { seat: 1, id: id('4C') }] });
  check(H.legalPlays(g, 2).length === 2, 'Hearts: void in the suit led, any card may be played');
  const first = mk(hh, { turn: 0, tricksPlayed: 0 });
  first.hands[0] = [id('2C'), id('KD')]; first.turn = first.leader = 0;
  check(same(H.legalPlays(first, 0), [id('2C')]), 'Hearts: the first trick leads with the 2 of clubs');
  const fv = mk(hh, { turn: 2, tricksPlayed: 0, leader: 0, trick: [{ seat: 0, id: id('2C') }, { seat: 1, id: id('4C') }] });
  check(same(H.legalPlays(fv, 2), [id('9S')]), 'Hearts: no points on the first trick when you are void in clubs (unless you hold nothing else)');
  fv.hands[2] = [id('JH'), id('QS')];
  check(H.legalPlays(fv, 2).length === 2, 'Hearts: a hand of only point cards may play them on the first trick');
  check(H.whyNot(g, 1, id('5D')) === 'You must follow clubs' && /Hearts/.test(H.whyNot(mk(hh, { turn: 0 }), 0, id('2H'))), 'Hearts: a refusal says why');
  check(H.isLegal(g, 2, id('9S')) && !H.isLegal(g, 0, id('3C')), 'Hearts: only the seat to act can play');

  // A trick.
  let t = mk([[id('3C')], [id('KC')], [id('QS')], [id('2H')]], { turn: 0, leader: 0, tricksPlayed: 5 });
  t = H.playCard(t, 0, id('3C')); t = H.playCard(t, 1, id('KC')); t = H.playCard(t, 2, id('QS')); t = H.playCard(t, 3, id('2H'));
  check(t.trick.length === 4 && t.broken && t.hands.every(h => h.length === 0), 'Hearts: four plays make a trick, and a heart breaks hearts');
  check(H.trickWinner(t.trick) === 1 && H.trickPoints(t.trick) === 14, 'Hearts: the highest card of the suit led wins; the trick holds 14 points');
  check(H.trickWinner([{ seat: 0, id: id('AC') }, { seat: 1, id: id('KC') }, { seat: 2, id: id('2C') }, { seat: 3, id: id('AH') }]) === 0, 'Hearts: the ace is high, and off-suit cards never win');
  check(H.trickWinner([{ seat: 2, id: id('3D') }, { seat: 3, id: id('9H') }, { seat: 0, id: id('4D') }, { seat: 1, id: id('2S') }]) === 0, 'Hearts: a heart on a diamond lead does not win');
  const r = H.resolveTrick(t);
  check(r.taken[1].length === 4 && r.leader === 1 && r.turn === 1 && r.trick.length === 0 && r.tricksPlayed === 6, 'Hearts: the winner takes the trick and leads');

  // Ending a hand and the moon.
  const lastTrick = (winnerSeat, ids) => {
    const base = mk([[], [], [], []], { tricksPlayed: 12, taken: [[], [], [], []], scores: [10, 20, 30, 40] });
    base.trick = ids.map((c, i) => ({ seat: (winnerSeat + i) % 4, id: c }));
    return base;
  };
  const e = H.resolveTrick(lastTrick(2, [id('KC'), id('2C'), id('3C'), id('4C')]));
  check(e.phase === 'handEnd' && e.scores.join() === '10,20,30,40', 'Hearts: the 13th trick ends the hand; no points means no change');
  const hand1 = lastTrick(2, [id('KC'), id('2C'), id('3C'), id('4C')]);
  hand1.taken = [[id('QS'), id('AH')], [id('2H')], [], [id('3H')]];
  const e1 = H.resolveTrick(hand1);
  check(e1.handPoints.join() === '14,1,0,1' && e1.scores.join() === '24,21,30,41', 'Hearts: a hand\'s points are added to the totals');
  const moon = lastTrick(0, [id('KC'), id('2C'), id('3C'), id('4C')]);
  const allPoints = []; for (let c = 0; c < 52; c++) if (H.points(c)) allPoints.push(c);
  moon.taken = [[], allPoints, [], []]; moon.scores = [10, 20, 30, 40];
  const em = H.resolveTrick(moon);
  check(em.moon === 1 && em.handPoints.join() === '26,0,26,26' && em.scores.join() === '36,20,56,66', 'Hearts: shooting the moon scores 0 for the shooter and 26 for everyone else');
  const mine1 = lastTrick(0, [id('KC'), id('2C'), id('3C'), id('4C')]); mine1.taken = [allPoints, [], [], []];
  check(H.resolveTrick(mine1).handPoints.join() === '0,26,26,26', 'Hearts: you can shoot the moon too');
  const almost = lastTrick(1, [id('KC'), id('2C'), id('3C'), id('4C')]); almost.taken = [[], [id('QS')], [], []]; almost.scores = [10, 95, 30, 40];
  const over = H.resolveTrick(almost);
  check(over.phase === 'over' && H.winners(over.scores).join() === '0' && H.humanWon(over), 'Hearts: at 100 the game is over and the lowest score wins');
  check(H.winners([5, 5, 9, 20]).join() === '0,1' && !H.humanWon(Object.assign({}, over, { scores: [50, 12, 40, 100] })), 'Hearts: a tie shares the win; you lose if someone is lower');
  const dw = H.almostWon();
  check(H.legalPlays(dw, 0).length === 1 && dw.hands.every(h => h.length === 1) && dw.tricksPlayed === 12, 'Hearts: the debug state is the last trick of a game you lead');

  // The computer players follow the rules and the heuristics, through whole games.
  const ai = (hands, extra, seat) => H.aiPick(mk(hands, extra), seat);
  check(ai([[id('2D'), id('9D'), id('5C')], [id('4D'), id('JD'), id('QD'), id('8D')], [], []], { turn: 1, leader: 0, trick: [{ seat: 0, id: id('9D') }] }, 1) === id('8D'), 'Hearts AI: ducks under the trick with its highest card that stays under');
  check(ai([[], [id('QD'), id('KD')], [], []], { turn: 1, leader: 0, trick: [{ seat: 0, id: id('9D') }] }, 1) === id('QD'), 'Hearts AI: forced to go over, it goes over low');
  check(ai([[], [id('KS'), id('QS'), id('2S')], [], []], { turn: 1, leader: 0, trick: [{ seat: 0, id: id('5S') }] }, 1) === id('2S'), 'Hearts AI: ducks the low spade rather than risk the queen');
  check(ai([[], [id('KS'), id('QS')], [], []], { turn: 1, leader: 0, trick: [{ seat: 0, id: id('5S') }] }, 1) === id('KS'), 'Hearts AI: holding K and Q over a low spade, takes with the king, never the queen');
  check(ai([[], [id('QS'), id('3S'), id('9H')], [], [id('KS')]], { turn: 1, leader: 3, trick: [{ seat: 3, id: id('KS') }] }, 1) === id('QS'), 'Hearts AI: drops the queen on a trick the king is winning (it ducks under the king)');
  check(ai([[], [id('3D'), id('QS'), id('9H')], [], []], { turn: 1, leader: 0, trick: [{ seat: 0, id: id('5C') }] }, 1) === id('QS'), 'Hearts AI: void in the suit led, dumps the queen of spades');
  check(ai([[], [id('3D'), id('9H'), id('AH')], [], []], { turn: 1, leader: 0, trick: [{ seat: 0, id: id('5C') }] }, 1) === id('AH'), 'Hearts AI: void, with no queen, dumps its highest heart');
  check(ai([[], [id('3D'), id('KD'), id('2S')], [], []], { turn: 1, leader: 0, trick: [{ seat: 0, id: id('5C') }] }, 1) === id('KD'), 'Hearts AI: void with no hearts, dumps its highest card');
  check(ai([[id('9C'), id('3C'), id('KC'), id('4H')], [], [], []], { turn: 0, leader: 0 }, 0) === id('3C'), 'Hearts AI: leads its lowest card, away from hearts');
  check(ai([[id('AS'), id('4D'), id('6H')], [], [], []], { turn: 0, leader: 0 }, 0) === id('4D'), 'Hearts AI: does not lead the ace of spades while the queen is out');
  check(ai([[], [id('3C'), id('5C')], [], []], { turn: 1, leader: 0, trick: [{ seat: 0, id: id('9C') }, { seat: 3, id: id('QC') }], tricksPlayed: 4 }, 1) === id('5C'), 'Hearts AI: ducks as high as it can: with only low cards under, its highest low card');
  const lastSeat = ai([[], [], [], [id('KC'), id('9C')]], { turn: 3, leader: 0, trick: [{ seat: 0, id: id('3C') }, { seat: 1, id: id('4C') }, { seat: 2, id: id('5C') }] }, 3);
  check(lastSeat === id('KC'), 'Hearts AI: last to play on a clean trick it cannot duck, it spends its highest card');
  const lastPts = ai([[], [], [], [id('KC'), id('9C')]], { turn: 3, leader: 0, trick: [{ seat: 0, id: id('3C') }, { seat: 1, id: id('4H') }, { seat: 2, id: id('5C') }] }, 3);
  check(lastPts === id('9C'), 'Hearts AI: last to play on a trick with points it cannot duck, it takes with its lowest');

  // Whole games: computer players in all four seats, every play legal, to 100.
  let allLegal = true, ended = 0, moons = 0, hands = 0, sumsRight = true;
  for (let seed = 1; seed <= 30; seed++) {
    let s = H.newGame(order(seed * 3)), rng = lcg(seed), guard = 0;
    while (s.phase !== 'over' && guard++ < 20) {
      if (s.phase === 'pass') s = H.applyPass(s, [0, 1, 2, 3].map(x => H.choosePass(s.hands[x])));
      let plays = 0;
      while (s.phase === 'play' && plays++ < 80) {
        if (s.trick.length === 4) { s = H.resolveTrick(s); continue; }
        const c = H.aiPick(s, s.turn);
        if (!H.isLegal(s, s.turn, c)) { allLegal = false; break; }
        s = H.playCard(s, s.turn, c);
      }
      if (!allLegal) break;
      hands++;
      if (s.moon >= 0) moons++;
      const handSum = s.handPoints.reduce((a, b) => a + b, 0);
      if (handSum !== 26 && handSum !== 78) sumsRight = false;
      if (s.phase === 'handEnd') s = H.nextHand(s, order(seed * 100 + s.handNo));
    }
    if (s.phase === 'over') ended++;
    if (!allLegal) break;
  }
  check(allLegal, 'Hearts: every card the computer players play, in 30 whole games, is legal');
  check(ended === 30, 'Hearts: 30 of 30 games run to 100 and end (' + hands + ' hands, ' + moons + ' moons)');
  check(sumsRight, 'Hearts: every hand deals out 26 points (78 on a moon)');
}

// ── Layout stays on the table ───────────────────────────────────────────────
{
  const metrics = (W, Hh) => {
    const pad = Math.max(6, Math.min(16, Math.round(W * 0.02))), gap = Math.max(4, Math.round(W * 0.014));
    return { W, H: Hh, pad, gap, left: pad, cw: 40, ch: 56, step: 44, cols: 7 };
  };
  const m = metrics(390, 790), g = H.geometry(Object.assign(m, { cw: 48, ch: 67 }));
  check(g.yTop < g.statusY && g.statusY < g.yBot && g.yBot < g.southY && g.westX + 48 < g.cx - 24, 'Hearts layout: scores, the middle, the status line and your hand stack in order, the sides clear of the middle');
  const place = H.place(H.newGame(order(50)), Object.assign(m, { cw: 48, ch: 67 }), { chosen: [], sweep: null });
  check(place.cards.length === 52 && place.cards.every(c => isFinite(c.x) && isFinite(c.y)) && new Set(place.cards.map(c => c.id)).size === 52, 'Hearts layout: all 52 cards are placed at real positions');
  const mine = place.cards.filter(c => c.pile[0] === 'h');
  check(mine.length === 13 && Math.min(...mine.map(c => c.x)) >= 0 && Math.max(...mine.map(c => c.x)) + 48 <= 390, 'Hearts layout: your 13 cards fit inside a 390 px table');
}

console.log(failures ? failures + ' failure(s), ' + passed + ' passed' : 'all passed (' + passed + ')');
process.exit(failures ? 1 : 0);
