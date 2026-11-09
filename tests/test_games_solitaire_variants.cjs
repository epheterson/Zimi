// The solitaire variants (Yukon, Forty Thieves, Canfield, Scorpion, Aces Up, Accordion, Calculation, Beleaguered Castle, Eight Off,
// Monte Carlo): the rules as pure functions on plain states. Deals, legal and illegal moves, scoring where there is one, win and
// stuck detection, and whole games played by a simple player, every move checked legal. No DOM: the game files run their page
// wiring only when a #zc-table exists.
//
// Run: node tests/test_games_solitaire_variants.cjs   (exit 0 = pass)

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
const FILES = ['text.js', 'cardbacks.js', 'courts.js', 'cards.js', 'solkit.js'];
const GAME_FILES = ['yukon.js', 'fortythieves.js', 'canfield.js', 'scorpion.js', 'acesup.js', 'accordion.js', 'calculation.js', 'beleaguered.js', 'eightoff.js', 'montecarlo.js'];
const loaded = [];
for (const f of FILES.concat(GAME_FILES)) {
  if (!fs.existsSync(path.join(dir, f))) continue;
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  loaded.push(f);
}
const Z = sandbox.ZimiCards;
const L = 'A23456789TJQK', SU = 'CDHS';
const id = (s, copy = 0) => copy * 52 + Z.make(L.indexOf(s[0]) + 1, SU.indexOf(s[1]));
const up = (s, copy = 0) => ({ id: id(s, copy), up: true });
const dn = (s, copy = 0) => ({ id: id(s, copy), up: false });
// A seeded generator, so a failure replays.
const lcg = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const order = (seed, decks = 1) => sandbox.ZimiSolKit.shuffledDecks(decks, lcg(seed));
const allIds = st => [].concat(...Object.keys(st.piles).map(p => st.piles[p].map(c => (typeof c === 'number' ? c : c.id))));
const dealtOnce = (st, decks = 1) => { const a = allIds(st); return a.length === 52 * decks && new Set(a).size === 52 * decks; };

// Plays a game to its end with a greedy player (foundations first, then any legal move that is not an undo of the last one),
// every move taken from the rules' own bestMove / legalMove. Returns { won, moves, illegal }.
function play(G, st, maxMoves = 800) {
  let moves = 0, illegal = 0;
  const seen = new Set();
  while (moves < maxMoves && !G.isWon(st)) {
    const key = JSON.stringify(st.piles);
    if (seen.has(key)) {
      // A position seen before: try a different first move by drawing, else stop.
      if (G.drawStock) { const d = G.drawStock(st); if (d && !seen.has(JSON.stringify(d.piles))) { st = d; moves++; continue; } }
      break;
    }
    seen.add(key);
    let next = null;
    const piles = Object.keys(st.piles);
    outer: for (const from of piles) {
      for (let idx = st.piles[from].length - 1; idx >= 0; idx--) {
        if (!G.canPick(st, from, idx)) continue;
        const to = G.bestMove(st, from, idx);
        if (to) {
          if (!G.legalMove(st, from, idx, to)) { illegal++; break outer; }
          const n = G.applyMove(st, from, idx, to);
          if (!seen.has(JSON.stringify(n.piles))) { next = n; break outer; }
        }
      }
    }
    if (!next && G.drawStock) next = G.drawStock(st);
    if (!next) break;
    st = next; moves++;
  }
  return { won: G.isWon(st), moves, illegal, st };
}

// ── Yukon ───────────────────────────────────────────────────────────────────
if (sandbox.ZimiYukon) {
  const Y = sandbox.ZimiYukon;
  const st = Y.newState(order(1));
  check(dealtOnce(st), 'Yukon deals all 52 cards once');
  check(Y.TABLEAU.map(t => st.piles[t].length).join() === '1,6,7,8,9,10,11', 'Yukon: columns of 1, 6, 7, 8, 9, 10 and 11 cards');
  check(Y.TABLEAU.every((t, n) => st.piles[t].filter(c => !c.up).length === n && st.piles[t].filter(c => c.up).length === (n ? 5 : 1)), 'Yukon: column n has n cards face down, then five face up (one on the first)');
  const s = Y.blankState();
  s.piles.t0 = [dn('2C'), up('9H'), up('4S'), up('8C')];
  s.piles.t1 = [up('TS')];
  s.piles.t2 = [];
  s.piles.t3 = [up('KD'), up('QC')];
  check(Y.canPick(s, 't0', 1) && Y.canPick(s, 't0', 2) && !Y.canPick(s, 't0', 0), 'Yukon: any face-up card can be picked up, with those on it; not a face-down one');
  check(Y.legalMove(s, 't0', 1, 't1') && !Y.legalMove(s, 't0', 2, 't1'), 'Yukon: a run moves onto a card one rank up in the other color, in order or not (9H with 4S and 8C onto the ten of spades)');
  const m = Y.applyMove(s, 't0', 1, 't1');
  check(m.piles.t1.length === 4 && m.piles.t0.length === 1 && m.piles.t0[0].up && m.moves === 1 && s.piles.t0.length === 4, 'Yukon: the whole run moves, the card under it turns over, the old state is left alone');
  check(!Y.legalMove(s, 't3', 1, 't2') && Y.legalMove(s, 't3', 0, 't2'), 'Yukon: only a king (with what lies on it) fills an empty column');
  check(Y.bestMove(s, 't3', 0) === null, 'Yukon: a tap does not shuffle a king from the bottom of one column to an empty one');
  const w = Y.almostWon();
  check(!Y.isWon(w) && Y.legalMove(w, 't0', 0, 'f3') && Y.isWon(Y.applyMove(w, 't0', 0, 'f3')), 'Yukon: the debug state is one card from a win');
  const a = Y.blankState(); a.piles.t0 = [up('AS')];
  check(Y.bestMove(a, 't0', 0) === 'f0' && Y.legalMove(a, 't0', 0, 'f2'), 'Yukon: an ace goes to a foundation');
  const bad = Y.blankState(); bad.piles.t0 = [up('2S')]; bad.piles.f0 = [up('AH')];
  check(!Y.legalMove(bad, 't0', 0, 'f0'), 'Yukon: a foundation takes its own suit only');
  let wins = 0, illegal = 0;
  for (let seed = 1; seed <= 30; seed++) { const r = play(Y, Y.newState(order(seed))); if (r.won) wins++; illegal += r.illegal; }
  check(illegal === 0, 'Yukon: 30 greedy games, every tap lands where the rules allow');
  check(wins >= 1, 'Yukon: the greedy player wins some deals (' + wins + ' of 30)');
  const stuck = Y.blankState(); stuck.piles.t0 = [up('5S')]; stuck.piles.t1 = [up('9H')];
  check(Y.hasMove(stuck) === false, 'Yukon: two unrelated cards and nothing else: no move');
  stuck.piles.t2 = [up('8S')];
  check(Y.hasMove(stuck) === true, 'Yukon: an eight of spades beside a nine of hearts is a move (8S onto 9H)');
}

// The debug state of every game is one legal move from a win, and the win is seen.
function oneMoveWins(G) {
  const st = G.almostWon();
  if (G.isWon(st)) return false;
  for (const from of Object.keys(st.piles)) for (let idx = 0; idx < st.piles[from].length; idx++) for (const to of Object.keys(st.piles)) {
    if (G.legalMove(st, from, idx, to) && G.isWon(G.applyMove(st, from, idx, to))) return true;
  }
  return false;
}
// Every card of the debug state is a different card.
const distinct = G => { const a = allIds(G.almostWon()); return new Set(a).size === a.length; };
// Greedy games: how many ran, how many tapped something illegal, how many were won.
function greedy(G, deal, games, maxMoves) {
  let illegal = 0, won = 0;
  for (let seed = 1; seed <= games; seed++) { const r = play(G, deal(seed), maxMoves); illegal += r.illegal; if (r.won) won++; }
  return { illegal, won };
}

// ── Forty Thieves ───────────────────────────────────────────────────────────
if (sandbox.ZimiFortyThieves) {
  const F = sandbox.ZimiFortyThieves;
  const st = F.newState(order(3, 2));
  check(dealtOnce(st, 2), 'Forty Thieves deals both decks, every card once');
  check(F.TABLEAU.length === 10 && F.TABLEAU.every(t => st.piles[t].length === 4 && st.piles[t].every(c => c.up)), 'Forty Thieves: ten columns of four, all face up');
  check(st.piles.stock.length === 64 && st.piles.waste.length === 0 && st.piles.stock.every(c => !c.up), 'Forty Thieves: sixty-four in the stock, face down');
  const s = F.blankState();
  s.piles.t0 = [up('8H'), up('7H'), up('6H')]; s.piles.t1 = [up('9H')]; s.piles.t2 = [up('9S')]; s.piles.t3 = [];
  check(F.canPick(s, 't0', 2) && !F.canPick(s, 't0', 1), 'Forty Thieves: only the bottom card of a column can be taken (one at a time)');
  s.piles.t0 = [up('5C'), up('8H')];
  check(F.legalMove(s, 't0', 1, 't1') && !F.legalMove(s, 't0', 1, 't2'), 'Forty Thieves: 8H builds on 9H (same suit) and not on 9S');
  check(F.legalMove(s, 't0', 1, 't3') && F.legalMove(s, 't1', 0, 't3'), 'Forty Thieves: any card fills an empty column');
  const f = F.blankState();
  f.piles.t0 = [up('AS')]; f.piles.f0 = [up('AS', 1)]; f.piles.t2 = [up('2S')];
  check(F.legalMove(f, 't0', 0, 'f1') && !F.legalMove(f, 't0', 0, 'f0') && F.legalMove(f, 't2', 0, 'f0'), 'Forty Thieves: a foundation takes an ace to start and its suit one up (a second ace needs another foundation)');
  const g = F.blankState(); g.piles.f0 = [up('AS'), up('2S')]; g.piles.t0 = [];
  check(!F.canPick(g, 'f0', 1) && F.hasMove(g) === false, 'Forty Thieves: a card cannot be taken back off a foundation');
  const d = F.newState(order(4, 2)), d1 = F.drawStock(d);
  check(d1.piles.waste.length === 1 && d1.piles.waste[0].up && d1.piles.stock.length === 63 && d.piles.stock.length === 64, 'Forty Thieves: the stock turns one card onto the waste');
  check(F.drawStock(F.blankState()) === null, 'Forty Thieves: one pass only, an empty stock cannot be turned');
  const w = F.blankState(); w.piles.waste = [up('3C')]; w.piles.t0 = [up('4C')];
  check(F.legalMove(w, 'waste', 0, 't0') && F.bestMove(w, 'waste', 0) === 't0', 'Forty Thieves: the waste card builds on a column');
  check(oneMoveWins(F) && distinct(F), 'Forty Thieves: the debug state is one move from a win');
  const r = greedy(F, seed => F.newState(order(seed, 2)), 20);
  check(r.illegal === 0, 'Forty Thieves: 20 greedy games, every tap lands where the rules allow (' + r.won + ' won)');
}

// ── Canfield ────────────────────────────────────────────────────────────────
if (sandbox.ZimiCanfield) {
  const C = sandbox.ZimiCanfield;
  const st = C.newState(order(5));
  check(dealtOnce(st), 'Canfield deals all 52 cards once');
  check(st.piles.r.length === 13 && st.piles.r.filter(c => c.up).length === 1 && st.piles.r[12].up, 'Canfield: a reserve of thirteen, only the top card face up');
  check(st.piles.f0.length === 1 && st.base === Z.rank(st.piles.f0[0].id), 'Canfield: the foundation card sets the rank the foundations start on');
  check(C.TABLEAU.every(t => st.piles[t].length === 1) && st.piles.stock.length === 34, 'Canfield: a card on each of four columns, thirty-four in the stock');
  check(C.below(1) === 13 && C.below(5) === 4 && C.above(13) === 1 && C.above(4) === 5, 'Canfield: ranks run round, below the ace is the king');
  const s = C.blankState(); s.base = 5;
  s.piles.t0 = [up('2H')]; s.piles.t1 = [up('AS')]; s.piles.t2 = [up('KD')]; s.piles.t3 = [up('5C'), up('4D'), up('3S')];
  check(C.legalMove(s, 't1', 0, 't0'), 'Canfield: an ace builds on a two of the other color');
  check(C.legalMove(s, 't2', 0, 't1'), 'Canfield: a king builds on an ace (round the corner), the other color');
  check(!C.legalMove(s, 't0', 0, 't2'), 'Canfield: a two does not build on a king');
  s.piles.t0 = [up('6H')];
  check(C.legalMove(s, 't3', 0, 't0') && !C.legalMove(s, 't3', 1, 't0'), 'Canfield: an in-order run moves as one (5C 4D 3S onto 6H); 4D alone does not build on 6H');
  s.piles.t0 = [up('5H')];
  check(C.legalMove(s, 't0', 0, 'f0') && !C.legalMove(s, 't1', 0, 'f0'), 'Canfield: a foundation starts on the base rank only');
  s.piles.f0 = [up('5H')]; s.piles.t0 = [up('6H')]; s.piles.t1 = [up('6S')];
  check(C.legalMove(s, 't0', 0, 'f0') && !C.legalMove(s, 't1', 0, 'f0'), 'Canfield: a foundation builds up by suit');
  s.piles.f0 = [up('QS'), up('KS')]; s.piles.t1 = [up('AS')]; s.base = 12;
  check(C.legalMove(s, 't1', 0, 'f0'), 'Canfield: a foundation goes on past the king to the ace');
  const gap = C.blankState(); gap.piles.r = [dn('3C'), up('7H')]; gap.piles.t0 = [up('9S')]; gap.piles.t1 = [up('4D')]; gap.piles.t2 = [up('5D')]; gap.piles.t3 = [up('QC')];
  const g2 = C.applyMove(gap, 't1', 0, 't0');
  check(g2.piles.t1.length === 1 && g2.piles.t1[0].id === id('7H') && g2.piles.r.length === 1 && g2.piles.r[0].up, 'Canfield: a gap in the columns fills itself from the reserve and the next reserve card turns up');
  const dr = C.newState(order(6)), d1 = C.drawStock(dr);
  check(d1.piles.waste.length === 3 && d1.piles.stock.length === 31 && d1.piles.waste.every(c => c.up), 'Canfield: the stock turns three at a time');
  let d2 = dr; for (let k = 0; k < 12; k++) d2 = C.drawStock(d2);
  check(d2.piles.stock.length === 0 && d2.piles.waste.length === 34, 'Canfield: twelve turns of three empty a stock of thirty-four');
  const d3 = C.drawStock(d2);
  check(d3.piles.stock.length === 34 && d3.piles.waste.length === 0 && d3.piles.stock.every(c => !c.up), 'Canfield: an empty stock is turned over again from the waste, as often as you like');
  check(oneMoveWins(C) && distinct(C), 'Canfield: the debug state is one move from a win');
  const r = greedy(C, seed => C.newState(order(seed)), 20);
  check(r.illegal === 0, 'Canfield: 20 greedy games, every tap lands where the rules allow (' + r.won + ' won)');
}

// ── Scorpion ────────────────────────────────────────────────────────────────
if (sandbox.ZimiScorpion) {
  const S = sandbox.ZimiScorpion;
  const st = S.newState(order(7));
  check(dealtOnce(st), 'Scorpion deals all 52 cards once');
  check(S.TABLEAU.every(t => st.piles[t].length === 7) && st.piles.stock.length === 3, 'Scorpion: seven columns of seven and three left over');
  check(S.TABLEAU.every((t, n) => st.piles[t].filter(c => !c.up).length === (n < 4 ? 3 : 0)), 'Scorpion: the first three cards of the first four columns are face down');
  const s = S.blankState();
  s.piles.t0 = [dn('2C'), up('9H'), up('4S'), up('8C')]; s.piles.t1 = [up('TH')]; s.piles.t2 = []; s.piles.t3 = [up('KD'), up('QC')];
  check(S.canPick(s, 't0', 1) && !S.canPick(s, 't0', 0), 'Scorpion: any face-up card can be taken, with those on it');
  check(S.legalMove(s, 't0', 1, 't1') && !S.legalMove(s, 't0', 2, 't1'), 'Scorpion: a run goes onto a card of the same suit one rank higher, in order or not (9H onto 10H)');
  s.piles.t1 = [up('TS')];
  check(!S.legalMove(s, 't0', 1, 't1'), 'Scorpion: not onto another suit');
  check(S.legalMove(s, 't3', 0, 't2') && !S.legalMove(s, 't3', 1, 't2'), 'Scorpion: only a king fills an empty column');
  const spare = S.drawStock(st);
  check(spare.piles.stock.length === 0 && [0, 1, 2].every(i => spare.piles['t' + i].length === 8 && spare.piles['t' + i][7].up) && spare.piles.t3.length === 7, 'Scorpion: the spare cards go one each onto the first three columns, face up');
  check(S.drawStock(spare) === null, 'Scorpion: the spare cards can be dealt once');
  const run = S.blankState();
  run.piles.t0 = [dn('5D')]; for (let r = 13; r >= 2; r--) run.piles.t0.push({ id: Z.make(r, 3), up: true });
  run.piles.t1 = [up('AS')];
  const done = S.applyMove(run, 't1', 0, 't0');
  check(done.piles.d0.length === 13 && done.piles.t0.length === 1 && done.piles.t0[0].up && done.piles.t1.length === 0, 'Scorpion: a king-to-ace run of one suit leaves the table and turns the card under it');
  check(oneMoveWins(S) && distinct(S), 'Scorpion: the debug state is one move from a win');
  const r = greedy(S, seed => S.newState(order(seed)), 20);
  check(r.illegal === 0, 'Scorpion: 20 greedy games, every tap lands where the rules allow');
}

// ── Aces Up ─────────────────────────────────────────────────────────────────
if (sandbox.ZimiAcesUp) {
  const A = sandbox.ZimiAcesUp;
  const st = A.newState(order(8));
  check(dealtOnce(st) && A.TABLEAU.every(t => st.piles[t].length === 1) && st.piles.stock.length === 48 && st.moves === 0, 'Aces Up deals four cards, one on each column, 48 in the stock');
  check(A.high(id('AS')) > A.high(id('KS')) && A.high(id('2S')) < A.high(id('3S')), 'Aces Up: the ace is the highest card');
  const s = A.blankState();
  s.piles.t0 = [up('5H')]; s.piles.t1 = [up('9H')]; s.piles.t2 = [up('KS')]; s.piles.t3 = [up('AS')];
  check(A.legalMove(s, 't0', 0, 'out') && !A.legalMove(s, 't1', 0, 'out'), 'Aces Up: a card goes out when another column shows a higher card of its suit (5H under 9H, not 9H)');
  check(A.legalMove(s, 't2', 0, 'out') && !A.legalMove(s, 't3', 0, 'out'), 'Aces Up: a king goes out under an ace; an ace never goes');
  s.piles.t1 = [up('9C')];
  check(!A.legalMove(s, 't0', 0, 'out'), 'Aces Up: a higher card of another suit does not count');
  const e = A.blankState(); e.piles.t0 = [up('3C'), up('5H')]; e.piles.t1 = [up('9H')]; e.piles.t2 = []; e.piles.t3 = [up('2D')];
  const m = A.applyMove(e, 't0', 1, 'out');
  check(m.piles.out.length === 1 && m.piles.t0.length === 1 && m.moves === 1 && e.piles.out.length === 0, 'Aces Up: the card leaves its column and goes to the discard');
  e.piles.t1 = [up('9S')];
  check(A.legalMove(e, 't0', 1, 't2') && A.bestMove(e, 't0', 1) === 't2' && !A.legalMove(e, 't0', 1, 't1'), 'Aces Up: a top card moves to an empty column, and onto no other column');
  check(!A.canPick(e, 't0', 0), 'Aces Up: only the top card of a column can be taken');
  const dl = A.drawStock(st);
  check(dl.piles.stock.length === 44 && A.TABLEAU.every(t => dl.piles[t].length === 2 && dl.piles[t][1].up), 'Aces Up: a deal puts four more cards on the columns, one on each');
  check(A.drawStock(A.blankState()) === null, 'Aces Up: no deal from an empty stock');
  const dead = A.blankState(); dead.piles.t0 = [up('5H')]; dead.piles.t1 = [up('9C')]; dead.piles.t2 = [up('KD')]; dead.piles.t3 = [up('AS')];
  check(A.hasMove(dead) === false, 'Aces Up: four tops that cannot go and no stock is no move');
  check(oneMoveWins(A) && distinct(A), 'Aces Up: the debug state is one move from a win');
  const r = greedy(A, seed => A.newState(order(seed)), 60);
  check(r.illegal === 0, 'Aces Up: 60 greedy games, every tap lands where the rules allow (' + r.won + ' won)');
}

// ── Accordion ───────────────────────────────────────────────────────────────
if (sandbox.ZimiAccordion) {
  const X = sandbox.ZimiAccordion;
  const st = X.newState(order(9));
  check(dealtOnce(st) && X.row(st).length === 52, 'Accordion lays out all 52 cards in a row');
  const row = (...cards) => { const s = X.blankState(); cards.forEach((c, n) => { s.piles['a' + n] = [up(c)]; }); return s; };
  // 5S three places right of 5H: the far move; KD beside it does not match.
  let s = row('5H', '9C', 'KD', '5S');
  check(X.targets(s, 'a3').join() === 'a0' && X.legalMove(s, 'a3', 0, 'a0') && !X.legalMove(s, 'a3', 0, 'a2'), 'Accordion: 5S goes three places left onto 5H by rank, not onto the king beside it');
  check(X.bestMove(s, 'a3', 0) === 'a0', 'Accordion: a tap moves a card that has one place to go');
  s = row('5H', '9C', '2D', '5S', '3S');
  check(X.targets(s, 'a4').join() === 'a3' && X.targets(s, 'a3').join() === 'a0', 'Accordion: 3S goes onto 5S beside it by suit; 5S goes three left onto 5H');
  const both = row('9H', '4C', '9D', '9S');   // 9S has 9D beside it and 9H three places left, both by rank
  check(X.targets(both, 'a3').sort().join() === 'a0,a2' && X.bestMove(both, 'a3', 0) === null, 'Accordion: with two places a tap does not choose (drag to choose)');
  check(X.why(both, 'a3', 0) !== null, 'Accordion: a tap with two choices says so');
  const m = X.applyMove(both, 'a3', 0, 'a2');
  check(m.piles.a2.length === 2 && m.piles.a2[1].id === id('9S') && m.piles.a3.length === 0 && X.row(m).join() === 'a0,a1,a2' && both.piles.a3.length === 1, 'Accordion: the pile goes on top of the other and the row closes up');
  // After the gap, places are counted along the row: a4 is now three places right of a1.
  const moved = row('9H', '4C', '9D', '9S', '2D', '4H');
  const after = X.applyMove(moved, 'a3', 0, 'a2');
  check(X.row(after).join() === 'a0,a1,a2,a4,a5' && X.targets(moved, 'a5').length === 0 && X.targets(after, 'a5').join() === 'a1', 'Accordion: places are counted along the piles left, not by name (4H is now three places right of 4C)');
  check(oneMoveWins(X) && distinct(X), 'Accordion: the debug state is one move from a win');
  const dead = row('2H', '9C', '5S');
  check(X.hasMove(dead) === false && X.isWon(dead) === false, 'Accordion: three piles with nothing matching is stuck, not won');
  const r = greedy(X, seed => X.newState(order(seed)), 60, 300);
  check(r.illegal === 0, 'Accordion: 60 greedy games, every tap lands where the rules allow (' + r.won + ' won)');
}

// ── Calculation ─────────────────────────────────────────────────────────────
if (sandbox.ZimiCalculation) {
  const K = sandbox.ZimiCalculation;
  const st = K.newState(order(10));
  check(dealtOnce(st) && st.piles.deck.length === 48, 'Calculation deals 52 cards once: four to the foundations, 48 in the deck');
  check(K.FOUNDATION.map(f => Z.rank(st.piles[f][0].id)).join() === '1,2,3,4', 'Calculation: the foundations start on an ace, a two, a three and a four');
  const seqs = [1, 2, 3, 4].map(step => { const out = [step]; for (let k = 1; k < 13; k++) out.push(K.nextRank(out[k - 1], step)); return out; });
  check(seqs.every(q => q[12] === 13 && new Set(q).size === 13), 'Calculation: each foundation counts through all thirteen ranks and ends on a king');
  check(seqs[1].join() === '2,4,6,8,10,12,1,3,5,7,9,11,13' && seqs[2].join() === '3,6,9,12,2,5,8,11,1,4,7,10,13', 'Calculation: by twos (2 4 6 8 10 Q A 3 5 7 9 J K) and by threes');
  const s = K.blankState();
  s.piles.f0 = [up('AS')]; s.piles.f1 = [up('2H')]; s.piles.f2 = [up('3C')]; s.piles.f3 = [up('4D')];
  s.piles.deck = [up('7D'), up('2C')]; s.piles.w0 = [up('4S')]; s.piles.w1 = [up('6C')];
  check(K.legalMove(s, 'deck', 1, 'f0') && !K.legalMove(s, 'deck', 1, 'f1'), 'Calculation: a two goes on the ace pile (counting by one) and not on the pile that wants a four');
  check(K.legalMove(s, 'w0', 0, 'f1') && K.legalMove(s, 'w1', 0, 'f2') && !K.legalMove(s, 'w1', 0, 'f1'), 'Calculation: a waste pile top goes to the foundation that wants it (4S on the twos, 6C on the threes)');
  check(K.legalMove(s, 'deck', 1, 'w2') && !K.legalMove(s, 'w0', 0, 'w1') && !K.legalMove(s, 'w0', 0, 'w2'), 'Calculation: the deck card goes onto any waste pile, but a waste pile card never moves to another');
  check(!K.canPick(s, 'f0', 0) && !K.legalMove(s, 'f0', 0, 'w0'), 'Calculation: nothing comes back off a foundation');
  check(!K.canPick(s, 'deck', 0) && K.canPick(s, 'deck', 1), 'Calculation: only the top card of the deck plays');
  check(K.needs(s, 'f3') === 8 && K.needs(s, 'f1') === 4, 'Calculation: what a pile wants next is known (the fours want an eight, the twos a four)');
  check(oneMoveWins(K) && distinct(K), 'Calculation: the debug state is one move from a win');
  const r = greedy(K, seed => K.newState(order(seed)), 30);
  check(r.illegal === 0, 'Calculation: 30 greedy games, every tap lands where the rules allow');
  const stuck = K.blankState(); stuck.piles.f0 = [up('AS')]; stuck.piles.f1 = [up('2H')]; stuck.piles.f2 = [up('3C')]; stuck.piles.f3 = [up('4D')];
  stuck.piles.w0 = [up('9S')]; stuck.piles.w1 = [up('JS')]; stuck.piles.w2 = [up('KS')]; stuck.piles.w3 = [up('TS')];
  check(K.hasMove(stuck) === false, 'Calculation: an empty deck and four waste tops nothing wants is no move');
}

// ── Beleaguered Castle ──────────────────────────────────────────────────────
if (sandbox.ZimiBeleaguered) {
  const B = sandbox.ZimiBeleaguered;
  const st = B.newState(order(11));
  check(dealtOnce(st), 'Beleaguered Castle deals all 52 cards once');
  check(B.FOUNDATION.every(f => st.piles[f].length === 1 && Z.rank(st.piles[f][0].id) === 1) && new Set(B.FOUNDATION.map(f => Z.suit(st.piles[f][0].id))).size === 4, 'Beleaguered Castle: the four aces start the four foundations');
  check(B.TABLEAU.length === 8 && B.TABLEAU.every(t => st.piles[t].length === 6 && st.piles[t].every(c => c.up && Z.rank(c.id) !== 1)), 'Beleaguered Castle: eight columns of six, all face up');
  const s = B.blankState();
  s.piles.t0 = [up('QC'), up('8D')]; s.piles.t1 = [up('9S')]; s.piles.t2 = [up('9D')]; s.piles.t3 = [];
  check(B.legalMove(s, 't0', 1, 't1') && B.legalMove(s, 't0', 1, 't2'), 'Beleaguered Castle: a card builds down on any suit (8D on 9S and on 9D)');
  check(!B.canPick(s, 't0', 0) && B.legalMove(s, 't0', 1, 't3'), 'Beleaguered Castle: one card at a time, and any card fills an empty column');
  check(!B.legalMove(s, 't1', 0, 't2'), 'Beleaguered Castle: a nine does not build on a nine');
  const f = B.blankState(); f.piles.f0 = [up('AH')]; f.piles.t0 = [up('2H')]; f.piles.t1 = [up('2S')];
  check(B.legalMove(f, 't0', 0, 'f0') && !B.legalMove(f, 't1', 0, 'f0'), 'Beleaguered Castle: a foundation builds up by suit');
  check(oneMoveWins(B) && distinct(B), 'Beleaguered Castle: the debug state is one move from a win');
  const r = greedy(B, seed => B.newState(order(seed)), 30);
  check(r.illegal === 0, 'Beleaguered Castle: 30 greedy games, every tap lands where the rules allow (' + r.won + ' won)');
}

// ── Eight Off ───────────────────────────────────────────────────────────────
if (sandbox.ZimiEightOff) {
  const E = sandbox.ZimiEightOff;
  const st = E.newState(order(12));
  check(dealtOnce(st), 'Eight Off deals all 52 cards once');
  check(E.TABLEAU.every(t => st.piles[t].length === 6) && ['c0', 'c1', 'c2', 'c3'].every(c => st.piles[c].length === 1) && ['c4', 'c5', 'c6', 'c7'].every(c => st.piles[c].length === 0), 'Eight Off: eight columns of six, four cards in the first four of eight free cells');
  const s = E.blankState();
  s.piles.t0 = [up('5C'), up('8H')]; s.piles.t1 = [up('9H')]; s.piles.t2 = [up('9S')]; s.piles.t3 = []; s.piles.c0 = [up('KD')];
  check(E.legalMove(s, 't0', 1, 't1') && !E.legalMove(s, 't0', 1, 't2'), 'Eight Off: build down in one suit (8H on 9H, not on 9S)');
  check(!E.canPick(s, 't0', 0), 'Eight Off: one card at a time');
  check(E.legalMove(s, 'c0', 0, 't3') && !E.legalMove(s, 't0', 1, 't3'), 'Eight Off: only a king fills an empty column');
  check(E.legalMove(s, 't0', 1, 'c1') && !E.legalMove(s, 't0', 1, 'c0') && !E.legalMove(s, 'c0', 0, 'c1'), 'Eight Off: a free cell holds one card, and a card cannot go from cell to cell');
  const f = E.blankState(); f.piles.c0 = [up('AS')]; f.piles.t0 = [up('2S')];
  check(E.legalMove(f, 'c0', 0, 'f0') && E.bestMove(f, 'c0', 0) === 'f0', 'Eight Off: a card in a cell goes to a foundation');
  check(oneMoveWins(E) && distinct(E), 'Eight Off: the debug state is one move from a win');
  const r = greedy(E, seed => E.newState(order(seed)), 30);
  check(r.illegal === 0, 'Eight Off: 30 greedy games, every tap lands where the rules allow (' + r.won + ' won)');
}

// ── Monte Carlo ─────────────────────────────────────────────────────────────
if (sandbox.ZimiMonteCarlo) {
  const M = sandbox.ZimiMonteCarlo;
  const st = M.newState(order(13));
  check(dealtOnce(st) && M.GRID.every(g => st.piles[g].length === 1 && st.piles[g][0].up) && st.piles.stock.length === 27, 'Monte Carlo: 25 cards face up in a grid of five by five, 27 in the stock');
  const s = M.blankState();
  s.piles.g0 = [up('7C')]; s.piles.g1 = [up('7D')]; s.piles.g6 = [up('7H')]; s.piles.g12 = [up('7S')]; s.piles.g2 = [up('8C')]; s.piles.g4 = [up('7S', 1)]; s.piles.g5 = [up('7C', 1)];
  check(M.legalMove(s, 'g0', 0, 'g1') && M.legalMove(s, 'g0', 0, 'g6'), 'Monte Carlo: a card goes with a card of its rank beside it, or on its corner');
  check(M.legalMove(s, 'g6', 0, 'g12') && M.legalMove(s, 'g1', 0, 'g6'), 'Monte Carlo: down the diagonal and down the column');
  check(!M.legalMove(s, 'g0', 0, 'g12') && !M.legalMove(s, 'g0', 0, 'g2') && !M.legalMove(s, 'g0', 0, 'g4'), 'Monte Carlo: not two places away, and not a different rank');
  check(!M.legalMove(s, 'g4', 0, 'g5'), 'Monte Carlo: the right edge does not wrap round to the left of the next row');
  check(M.bestMove(s, 'g12', 0) === 'g6' && M.bestMove(s, 'g2', 0) === null, 'Monte Carlo: a tap pairs a card with a touching match; a card with none has no pair');
  const m = M.applyMove(s, 'g0', 0, 'g1');
  check(m.piles.out.length === 2 && m.piles.g0.length === 0 && m.piles.g1.length === 0 && m.moves === 1 && s.piles.out.length === 0, 'Monte Carlo: a pair goes out together');
  const blank = M.blankState();
  blank.piles.g3 = [up('2C')]; blank.piles.g7 = [up('3C')]; blank.piles.g24 = [up('4C')]; blank.piles.stock = [dn('5C'), dn('6C')];
  const f = M.fill(blank);
  check(f.piles.g0[0].id === id('2C') && f.piles.g1[0].id === id('3C') && f.piles.g2[0].id === id('4C') && f.piles.g3[0].id === id('6C') && f.piles.g4[0].id === id('5C') && f.piles.g5.length === 0 && f.piles.stock.length === 0,
    'Monte Carlo: the cards slide up and left in order and the stock deals into the empty places');
  check(M.drawStock(M.newState(order(14))) === null && M.drawStock(M.blankState()) === null, 'Monte Carlo: with every place full, or the table empty, the stock does nothing');
  check(oneMoveWins(M) && distinct(M), 'Monte Carlo: the debug state is one move from a win');
  const dead = M.blankState(); dead.piles.g0 = [up('2C')]; dead.piles.g1 = [up('3C')];
  check(M.hasMove(dead) === false, 'Monte Carlo: two cards that do not pair and no stock is no move');
  const r = greedy(M, seed => M.newState(order(seed)), 60);
  check(r.illegal === 0, 'Monte Carlo: 60 greedy games, every tap lands where the rules allow (' + r.won + ' won)');
}

// ── The loaded files ────────────────────────────────────────────────────────
check(loaded.length === FILES.length + GAME_FILES.length, 'every variant file is loaded (' + loaded.length + ' of ' + (FILES.length + GAME_FILES.length) + ')');

console.log('\n' + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
