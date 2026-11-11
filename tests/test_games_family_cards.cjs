// ZimiGames' family card games (Go Fish, Old Maid, Snap, Oh Hell, Cheat): the rules and the computer players as pure functions on
// plain states. No DOM: the game files run their page wiring only when a #zc-table exists.
//
// Run: node tests/test_games_family_cards.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0, passed = 0;
const check = (ok, label) => {
  if (ok) { passed++; console.log('ok: ' + label); } else { console.error('FAIL: ' + label); failures++; }
};

const sandbox = {
  console, Date, Math, setTimeout, clearTimeout, setInterval, clearInterval,
  document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, documentElement: { classList: { toggle() {} } }, hidden: false }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const FILES = ['text.js', 'cardbacks.js', 'courts.js', 'cards.js', 'handoff.js', 'cardtable.js', 'gofish.js', 'oldmaid.js', 'snap.js', 'ohhell.js', 'cheat.js'];
for (const f of FILES) {
  if (!fs.existsSync(path.join(dir, f))) { console.error('FAIL: missing ' + f); failures++; continue; }
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
}
// A renamed file, or one that stopped setting its global, must fail its section, not skip it.
for (const g of ['ZimiGoFish', 'ZimiOldMaid', 'ZimiSnap', 'ZimiOhHell', 'ZimiCheat']) check(!!sandbox[g], g + ' is defined');
const Z = sandbox.ZimiCards;
const L = 'A23456789TJQK', SU = 'CDHS';
const id = s => Z.make(L.indexOf(s[0]) + 1, SU.indexOf(s[1]));
const ids = s => s.trim() ? s.trim().split(/\s+/).map(id) : [];
const lcg = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const order = seed => Z.shuffled(lcg(seed));

// ── Go Fish ─────────────────────────────────────────────────────────────────
if (sandbox.ZimiGoFish) {
  const G = sandbox.ZimiGoFish;
  const everyCard = st => [].concat(...st.hands, st.stock, ...st.books.map(b => [].concat(...b.map(r => [0, 1, 2, 3].map(s => Z.make(r, s))))));
  const whole = st => { const a = everyCard(st).sort((x, y) => x - y); return a.length === 52 && a.every((c, i) => c === i); };
  // A state to set up by hand: hands as card lists, the rest empty.
  const make = (hands, stock, turn) => ({ players: hands.length, hands: hands.map(ids), stock: ids(stock || ''), books: hands.map(() => []), known: hands.map(() => []), turn: turn || 0, phase: 'play', last: null, result: null, moves: 0 });

  const two = G.newGame(order(1), 2, 0), three = G.newGame(order(2), 3, 0), four = G.newGame(order(3), 4, 1);
  check(G.dealSize(2) === 7 && G.dealSize(3) === 5 && G.dealSize(4) === 5, 'go fish: seven cards for two, five for three or four');
  check(two.hands[0].length >= 5 && two.stock.length <= 38, 'go fish: a two-player deal leaves about 38 in the stock');
  check(whole(two) && whole(three) && whole(four), 'go fish: a deal keeps all 52 cards');
  check(four.turn === 1, 'go fish: the first seat to ask is the one named');
  // A deal that makes a book at once lays it down.
  const lucky = G.newGame([...ids('7C 7D 7H 7S 2C 3C 4C'), ...ids('AC AD AH 5D 6D 8D 9D'), ...Z.shuffled(lcg(5)).filter(c => ![...ids('7C 7D 7H 7S 2C 3C 4C AC AD AH 5D 6D 8D 9D')].includes(c))], 2, 0);
  check(lucky.books[0].length === 1 && lucky.books[0][0] === 7 && lucky.hands[0].length === 3, 'go fish: four of a rank in the deal go down as a book');

  // Asking.
  const a = make(['7C 7D 2S', '7H 9C 9D', ''].slice(0, 2), '4H 5H 6H');
  check(G.canAsk(a, 0, 1, 7) && !G.canAsk(a, 0, 1, 9) && !G.canAsk(a, 0, 0, 7) && !G.canAsk(a, 1, 0, 7), 'go fish: you ask a rank you hold, of another player, on your turn');
  const got = G.ask(a, 0, 1, 7);
  check(got.hands[0].length === 4 && got.hands[1].length === 2 && got.turn === 0 && got.last.got === 1, 'go fish: you get the cards and ask again');
  const fish = G.ask(make(['7C 2S', '9C 9D'], '4H 5H 6H'), 0, 1, 7);
  check(fish.hands[0].length === 3 && fish.stock.length === 2 && fish.turn === 1 && fish.last.fished && !fish.last.lucky, 'go fish: nothing to give, so you fish and the turn passes');
  const luckyDraw = G.ask(make(['7C 2S', '9C 9D'], '4H 5H 7H'), 0, 1, 7);
  check(luckyDraw.turn === 0 && luckyDraw.last.lucky, 'go fish: drawing the rank you asked for lets you ask again');
  const empty = G.ask(make(['7C 2S', '9C 9D'], ''), 0, 1, 7);
  check(empty.turn === 1 && empty.last.empty && empty.hands[0].length === 2, 'go fish: with the stock empty a miss just passes the turn');
  // Books.
  const b = G.ask(make(['7C 7D 7H 2S 3S', '7S 9C 9D 9H KC'], '4H 5H 6H'), 0, 1, 7);
  check(b.books[0].length === 1 && b.books[0][0] === 7 && b.hands[0].length === 2 && b.last.books.length === 1 && b.turn === 0, 'go fish: the fourth card of a rank makes a book, laid down at once');
  const total = st => everyCard(st).length;
  check(total(b) === 10 + 3, 'go fish: laying a book keeps every card');
  // Asking someone who has been told you hold the rank: what the computer remembers.
  check(G.ask(make(['2C 7D 2S', '9C 9D'], '4H'), 0, 1, 2).known[0].includes(2), 'go fish: asking for a rank tells the table you hold it');
  // A hand that empties draws five.
  const refill = G.ask(make(['7C', '7H 9C'], '2D 3D 4D 5D 6D 8D 9H', 1), 1, 0, 7);
  check(refill.hands[0].length === 5 && refill.stock.length === 2 && refill.turn === 1 && refill.hands[1].length === 3, 'go fish: a hand left with no cards draws five from the stock at once');
  // The end.
  const end = G.ask(make(['7C 7D 7H', '7S'], ''), 0, 1, 7);
  check(end.phase === 'over' && end.result.winners.length === 1 && end.result.winners[0] === 0, 'go fish: when no one is left to ask, the game ends and the most books wins');
  const tie = (() => { const s = make(['2C', ''], ''); s.books = [[7, 8], [9, 10]]; s.stock = []; s.hands = [ids('2C 2D 2H 2S'), []]; return G.ask(make(['2C 2D 2H 2S', '5C'], ''), 0, 1, 2); })();
  check(tie.phase === 'over', 'go fish: a lone holder of the last cards ends it');

  // The computer.
  const asks = G.aiAsk(make(['7C 7D 2S 9H', '9C 4D 4S', '3C 3D'], '4H'), 0, lcg(1));
  check(asks && G.canAsk(make(['7C 7D 2S 9H', '9C 4D 4S', '3C 3D'], '4H'), 0, asks.target, asks.rank), 'go fish: the computer only asks what it may');
  const mem = make(['7C 7D 2S 9H', '9C 4D 4S', '3C 3D'], '4H'); mem.known[2] = [7];
  check(G.aiAsk(mem, 0, lcg(1)).target === 2 && G.aiAsk(mem, 0, lcg(1)).rank === 7, 'go fish: it asks the player it knows holds a rank it has');
  // Whole games: every move legal, nothing lost, every game ends.
  for (const players of [2, 3, 4]) {
    let ended = 0, legal = true, kept = true, maxMoves = 0;
    for (let g = 0; g < 40; g++) {
      let st = G.newGame(order(100 + g * 7 + players), players, g % players), rng = lcg(g + 1), n = 0;
      while (st.phase === 'play' && n < 2000) {
        const mv = G.aiAsk(st, st.turn, rng);
        if (!mv || !G.canAsk(st, st.turn, mv.target, mv.rank)) { legal = false; break; }
        st = G.ask(st, st.turn, mv.target, mv.rank); n++;
        if (!whole(st)) { kept = false; break; }
      }
      if (st.phase === 'over') ended++;
      maxMoves = Math.max(maxMoves, n);
    }
    check(legal, 'go fish: ' + players + ' computers only ever make legal asks');
    check(kept, 'go fish: ' + players + ' computers never lose or invent a card');
    check(ended === 40, 'go fish: all 40 games of ' + players + ' computers end (the longest took ' + maxMoves + ' asks)');
  }
  const fin = (() => { let st = G.newGame(order(9), 3, 0), rng = lcg(4); while (st.phase === 'play') { const mv = G.aiAsk(st, st.turn, rng); st = G.ask(st, st.turn, mv.target, mv.rank); } return st; })();
  check(fin.books.reduce((n, x) => n + x.length, 0) <= 13 && fin.result.most === Math.max(...fin.books.map(x => x.length)), 'go fish: the result names the most books');
}

// ── Old Maid ────────────────────────────────────────────────────────────────
if (sandbox.ZimiOldMaid) {
  const O = sandbox.ZimiOldMaid;
  const count = st => st.hands.reduce((n, h) => n + h.length, 0) + 2 * st.pairs.reduce((n, p) => n + p, 0);
  check(O.layPairs(ids('7C 7D 2S 9H 9C 9D')).pairs === 2 && O.layPairs(ids('7C 7D 2S 9H 9C 9D')).hand.length === 2, 'old maid: pairs by rank leave a hand, a third of a rank stays');
  check(O.layPairs(ids('QS QH QD')).hand.length === 1 && O.layPairs(ids('QS QH QD')).pairs === 1, 'old maid: three queens make one pair and one odd queen');
  for (const players of [2, 3, 4]) {
    const st = O.deal(order(40 + players), players, 0);
    check(count(st) === 51, 'old maid: ' + players + ' players, the deal keeps 51 cards (the queen of clubs is out)');
    const hold = st.hands.flat().filter(c => Z.rank(c) === 12).length + 2 * st.pairs.reduce((n, p) => n + p, 0) / 2;
    check(!st.hands.flat().includes(O.TAKEN_OUT), 'old maid: ' + players + ' players, the queen of clubs is out of the game');
  }
  const mk = (hands, turn) => ({ players: hands.length, hands: hands.map(ids), pairs: hands.map(() => 0), out: [], turn: turn || 0, phase: 'play', last: null, result: null, moves: 0 });
  const a = mk(['2C 5D', '5H 9S 9D']);
  check(O.source(a) === 1 && O.canTake(a, 0, 0) && O.canTake(a, 0, 2) && !O.canTake(a, 0, 3) && !O.canTake(a, 1, 0), 'old maid: you take from the next player, any one of their cards');
  const pair = O.take(a, 0, 0);
  check(pair.pairs[0] === 1 && pair.hands[0].length === 1 && pair.last.paired && pair.last.rank === 5 && pair.turn === 1, 'old maid: a match goes down with its partner and the turn passes');
  const miss = O.take(a, 0, 1);
  check(miss.pairs[0] === 0 && miss.hands[0].length === 3 && !miss.last.paired, 'old maid: a card with no match joins your hand');
  const safe = O.take(mk(['5D', '5H']), 0, 0);
  check(safe.phase === 'over' && safe.result.order.length === 2 && safe.result.loser === -1, 'old maid: everyone safe ends the game with no loser');
  const maid = O.take(mk(['2C 5D', '5H', 'QS 9D'], 0), 0, 0);
  check(maid.hands[1].length === 0 && maid.out.indexOf(1) >= 0 && maid.turn === 2 && maid.phase === 'play', 'old maid: a player whose last card is taken is safe and skipped');
  const end = O.take(mk(['QS 5D', '5H'], 1), 1, 1);
  check(end.phase === 'over' && end.result.loser === 0 && end.hands[0].length === 1, 'old maid: the last player holding a card loses');
  for (const players of [2, 3, 4]) {
    let ended = 0, legal = true, kept = true, loser = true;
    for (let g = 0; g < 40; g++) {
      let st = O.deal(order(300 + g * 5 + players), players, g % players), rng = lcg(g + 9), n = 0;
      while (st.phase === 'play' && n < 500) {
        const idx = O.aiTake(st, st.turn, rng);
        if (!O.canTake(st, st.turn, idx)) { legal = false; break; }
        st = O.take(st, st.turn, idx); n++;
        if (count(st) !== 51) { kept = false; break; }
      }
      if (st.phase === 'over') { ended++; if (st.result.loser >= 0 && !(st.hands[st.result.loser].length === 1 && Z.rank(st.hands[st.result.loser][0]) === 12)) loser = false; }
    }
    check(legal, 'old maid: ' + players + ' computers only ever take a card that is there');
    check(kept, 'old maid: ' + players + ' computers never lose or invent a card');
    check(ended === 40, 'old maid: all 40 games of ' + players + ' computers end');
    check(loser, 'old maid: the loser is always the one left with the odd queen');
  }
}

// ── Snap ────────────────────────────────────────────────────────────────────
if (sandbox.ZimiSnap) {
  const S = sandbox.ZimiSnap;
  const deck = seed => Z.shuffled(lcg(seed)).concat(Z.shuffled(lcg(seed + 1)).map(c => c + 52));
  const st0 = S.deal(deck(1), 0);
  check(st0.stacks[0].length === 52 && st0.stacks[1].length === 52 && new Set(st0.stacks[0].concat(st0.stacks[1])).size === 104, 'snap: two stacks of 52 from two decks');
  const f1 = S.flip(st0), f2 = S.flip(f1);
  check(f1.piles[0].length === 1 && f1.turn === 1 && f2.piles[1].length === 1 && f2.turn === 0, 'snap: the players turn their cards in turn, onto their own piles');
  const mk = (a, b, extra) => Object.assign({ stacks: [ids(extra && 's0' in extra ? extra.s0 : 'KS'), ids(extra && 's1' in extra ? extra.s1 : 'KH')], piles: [ids(a), ids(b)], won: [0, 0], turn: 0, phase: 'play', note: null, moves: 0, flips: 2 }, extra && extra.over || {});
  check(S.isMatch(mk('7C', '7D')) && !S.isMatch(mk('7C', '8D')) && !S.isMatch(mk('', '8D')) && S.isMatch(mk('2C 7S', '9D 7H')), 'snap: a match is the same rank on top of both piles, any suit');
  check(S.isMatch({ piles: [[0 + 52 * 1 + 4], [4]] }), 'snap: the second deck matches the first');
  const you = S.snap(mk('2D 7C', '5S 7D'), 0);
  check(you.won[0] === 4 && you.piles[0].length === 0 && you.piles[1].length === 0 && you.note.kind === 'snap' && you.note.n === 4, 'snap: a match takes both piles');
  const zimi = S.snap(mk('7C', '7D'), 1);
  check(zimi.won[1] === 2 && zimi.won[0] === 0, 'snap: whoever snaps gets the cards');
  const bad = S.snap(Object.assign(mk('7C', '8D'), { won: [5, 0] }), 0);
  check(bad.won[0] === 3 && bad.piles[0].length === 1 && bad.note.kind === 'false' && bad.note.n === 2, 'snap: a snap with no match costs two won cards and the piles stay');
  check(S.snap(mk('7C', '8D'), 0).won[0] === 0 && S.snap(mk('7C', '8D'), 0).note.n === 0, 'snap: a false snap with nothing won costs nothing');
  const last = S.flip(mk('7C', '8D', { s0: '', s1: '8H' }));
  check(S.cardsLeft(last) === 0 && last.phase === 'over' && last.piles[0].length === 1, 'snap: the last card with no match ends the game');
  const lastMatch = S.flip(mk('7C', '8D', { s0: '', s1: '7H' }));
  check(lastMatch.phase === 'play' && S.isMatch(lastMatch) && S.close(lastMatch).phase === 'over', 'snap: a last card that matches leaves a moment to snap it');
  check(S.winner({ won: [3, 3] }) === -1 && S.winner({ won: [4, 3] }) === 0 && S.winner({ won: [2, 3] }) === 1, 'snap: the most cards won wins');
  // Zimi: never quicker than a third of a second, inside its level's spread, missing about as often as the level says.
  for (const level of Object.keys(S.LEVELS)) {
    const L = S.LEVELS[level], rng = lcg(7);
    let min = 1e9, max = 0, miss = 0, n = 4000;
    for (let i = 0; i < n; i++) { const r = S.reaction(level, rng); if (r === null) miss++; else { min = Math.min(min, r); max = Math.max(max, r); } }
    check(min >= 350 && min >= L.from && max <= L.to, 'snap: ' + level + ' reacts in ' + min + ' to ' + max + ' ms, never inhuman');
    check(Math.abs(miss / n - L.miss) < 0.03, 'snap: ' + level + ' misses ' + Math.round(100 * miss / n) + ' percent of matches');
    check(L.to < L.flip, 'snap: ' + level + ' always answers before the next card');
  }
  check(S.LEVELS.easy.from > S.LEVELS.medium.from && S.LEVELS.medium.from > S.LEVELS.hard.from, 'snap: harder levels are quicker');
  // A whole game: two quick snappers, every card accounted for, the game ends.
  let st = S.deal(deck(11), 1), steps = 0, kept = true;
  while (st.phase === 'play' && steps < 400) {
    st = S.flip(st); steps++;
    if (S.isMatch(st)) st = S.snap(st, steps % 2);
    if (st.cardsLeft === 0) break;
    if (S.cardsLeft(st) === 0 && st.phase === 'play') st = S.close(st);
    const onTable = st.piles[0].length + st.piles[1].length + st.won[0] + st.won[1] + S.cardsLeft(st);
    if (onTable !== 104) { kept = false; break; }
  }
  check(st.phase === 'over' && kept, 'snap: a whole game ends with all 104 cards accounted for');
}

// ── Oh Hell ─────────────────────────────────────────────────────────────────
if (sandbox.ZimiOhHell) {
  const H = sandbox.ZimiOhHell;
  check(H.LADDERS.short.join() === '5,4,3,2,1,2,3,4,5' && H.LADDERS.full.join() === '7,6,5,4,3,2,1,2,3,4,5,6,7', 'oh hell: the hands go down to one card and back up');
  for (const players of [3, 4, 5]) {
    const st = H.newGame(order(70 + players), players, 'short', players - 1);
    check(st.hands.every(h => h.length === 5) && st.hands.length === players, 'oh hell: ' + players + ' players, five cards each in the first hand');
    check(new Set(st.hands.flat().concat([st.trumpCard])).size === players * 5 + 1 && st.trump === Z.suit(st.trumpCard), 'oh hell: ' + players + ' players, no card twice, and the turned card names trump');
    check(st.turn === 0 && st.phase === 'bid' && st.dealer === players - 1, 'oh hell: bidding starts left of the dealer');
  }
  // Bidding: the dealer may not make the bids add up to the number of tricks.
  let st = H.newGame(order(5), 3, 'short', 2);
  check(H.canBid(st, 0, 0) && H.canBid(st, 0, 5) && !H.canBid(st, 0, 6) && !H.canBid(st, 1, 1), 'oh hell: you bid 0 up to the cards in hand, in turn');
  st = H.placeBid(H.placeBid(st, 0, 2), 1, 1);
  check(st.phase === 'bid' && H.forbiddenBid(st, 2) === 2 && !H.canBid(st, 2, 2) && H.canBid(st, 2, 1) && H.canBid(st, 2, 3), 'oh hell: the dealer cannot bid what makes 5 tricks in all');
  check(H.forbiddenBid(H.placeBid(H.placeBid(H.newGame(order(5), 3, 'short', 2), 0, 5), 1, 4), 2) === -1, 'oh hell: when the others have already bid past the tricks nothing is forbidden');
  st = H.placeBid(st, 2, 3);
  check(st.phase === 'play' && st.turn === 0 && st.leader === 0, 'oh hell: when all have bid, play begins left of the dealer');
  // Playing and winning.
  const play = (hands, trump, lead) => ({ players: hands.length, sizes: [3], handNo: 0, hands: hands.map(ids), bids: hands.map(() => 1), tricks: hands.map(() => 0), trump: SU.indexOf(trump), trumpCard: 0, dealer: 2, turn: lead, leader: lead, trick: [], played: [], scores: hands.map(() => 0), phase: 'play', result: null, moves: 0 });
  const p = play(['7S 2C', '9S KH', 'AS 3D'], 'H', 0);
  check(H.legalPlays(p, 0).length === 2, 'oh hell: you may lead anything');
  const p1 = H.playCard(p, 0, id('7S'));
  check(H.legalPlays(p1, 1).join() === ids('9S').join() && H.isLegal(p1, 1, id('9S')) && !H.isLegal(p1, 1, id('KH')), 'oh hell: you must follow suit');
  check(H.legalPlays(H.playCard(p, 0, id('2C')), 1).length === 2, 'oh hell: with no card of the suit led you may play anything');
  const trick = (s, trump) => H.trickWinner(s.split(' ').map((c, i) => ({ seat: i, id: id(c) })), SU.indexOf(trump));
  check(trick('7S 9S AS', 'H') === 2 && trick('7S 9S AS', 'S') === 2 && trick('7S 9H 3C', 'H') === 1 && trick('7S 9H 3H', 'H') === 1 && trick('7S AH 3C', 'D') === 0, 'oh hell: the highest trump wins, else the highest card of the suit led');
  check(trick('7S AD 3C', 'D') === 1 && trick('2H KS AD', 'H') === 0, 'oh hell: a trump beats a higher card of the suit led');
  // Scoring.
  check(H.handPoints(2, 2) === 12 && H.handPoints(0, 0) === 10 && H.handPoints(2, 3) === 3 && H.handPoints(2, 0) === 0, 'oh hell: a point a trick, and ten more for taking exactly what you bid');
  check(H.winners([3, 9, 9]).join() === '1,2' && H.winners([4, 2, 1]).join() === '0', 'oh hell: the seats with the most points win');
  // Computer players: legal bids and plays, every card played once, tricks add up, the game ends.
  for (const players of [3, 4, 5]) for (const ladder of ['short', 'full']) {
    let games = 0, ok = true, exact = 0, made = 0, total = 0;
    for (let g = 0; g < 8; g++) {
      let s = H.newGame(order(500 + g * 11 + players), players, ladder, g % players), guard = 0;
      while (s.phase !== 'over' && guard++ < 4000) {
        if (s.phase === 'bid') {
          const b = H.aiBid(s, s.turn);
          if (!H.canBid(s, s.turn, b)) { ok = false; break; }
          s = H.placeBid(s, s.turn, b);
        } else if (s.phase === 'play') {
          if (s.trick.length === players) {
            s = H.resolveTrick(s);
            if (s.phase === 'handEnd' || s.phase === 'over') {
              const size = s.sizes[s.handNo];
              if (s.tricks.reduce((a, b) => a + b, 0) !== size) ok = false;
              s.result.made.forEach(m => { total++; if (m) made++; });
            }
            continue;
          }
          const c = H.aiPick(s, s.turn);
          if (!H.isLegal(s, s.turn, c)) { ok = false; break; }
          s = H.playCard(s, s.turn, c);
        } else if (s.phase === 'handEnd') s = H.nextHand(s, order(900 + guard));
      }
      if (s.phase === 'over') games++;
    }
    check(ok, 'oh hell: ' + players + ' computers, ' + ladder + ': every bid and play is legal and the tricks add up');
    check(games === 8, 'oh hell: ' + players + ' computers, ' + ladder + ': all 8 games end');
    check(made / total > 0.2, 'oh hell: ' + players + ' computers, ' + ladder + ': they make their bid ' + Math.round(100 * made / total) + ' percent of the time, more than chance');
  }
}

// ── Cheat ───────────────────────────────────────────────────────────────────
if (sandbox.ZimiCheat) {
  const C = sandbox.ZimiCheat;
  const total = st => st.hands.reduce((n, h) => n + h.length, 0) + st.pile.length;
  for (const players of [2, 3, 4]) {
    const st = C.deal(order(20 + players), players, 0);
    check(total(st) === 52 && st.hands.every(h => h.length >= Math.floor(52 / players)) && st.claim === 1 && st.phase === 'play', 'cheat: ' + players + ' players, all 52 cards are dealt and the first rank is the ace');
  }
  const mk = (hands, claim, turn, pile) => ({ players: hands.length, hands: hands.map(ids), pile: ids(pile || ''), claim: claim || 7, turn: turn || 0, phase: 'play', callers: [], last: null, turns: 0, winner: -1, moves: 0 });
  const a = mk(['7C 7D 2S 9H', '3C 4D', 'KS']);
  check(C.canPlay(a, 0, ids('7C')) && C.canPlay(a, 0, ids('7C 7D 2S 9H')) && !C.canPlay(a, 0, ids('7C 7C')) && !C.canPlay(a, 0, ids('3C')) && !C.canPlay(a, 1, ids('3C')) && !C.canPlay(a, 0, []), 'cheat: you play one to four cards from your hand, in turn');
  check(!C.canPlay(mk(['2C 3C 4C 5C 6C'], 7, 0), 0, ids('2C 3C 4C 5C 6C')), 'cheat: never more than four cards');
  const p = C.play(a, 0, ids('7C 2S'));
  check(p.phase === 'call' && p.pile.length === 2 && p.hands[0].length === 2 && p.callers.join() === '1,2' && p.last.count === 2 && p.last.rank === 7 && C.decider(p) === 1, 'cheat: a play goes face down on the pile and the others say, in order');
  check(!C.wasTrue(p.last) && C.wasTrue(C.play(a, 0, ids('7C 7D')).last), 'cheat: a play is true when every card is the rank said');
  // Nobody calls.
  const n1 = C.decide(p, 1, false), n2 = C.decide(n1, 2, false);
  check(n1.phase === 'call' && C.decider(n1) === 2 && n2.phase === 'play' && n2.turn === 1 && n2.claim === 8 && n2.pile.length === 2, 'cheat: with no call the pile stays, the turn and the rank move on');
  // A call that finds a lie.
  const c1 = C.decide(p, 1, true);
  check(c1.hands[0].length === 4 && c1.pile.length === 0 && c1.last.call.lying && c1.last.call.loser === 0 && c1.turn === 1 && c1.claim === 8, 'cheat: a call that finds a wrong card makes the player take the pile');
  // A call that finds the truth.
  const honest = C.play(a, 0, ids('7C 7D')), c2 = C.decide(honest, 2, false), c3 = C.decide(C.decide(honest, 1, false), 2, true);
  check(c3.hands[2].length === 3 && !c3.last.call.lying && c3.last.call.loser === 2 && c3.pile.length === 0, 'cheat: a call that finds only the rank said makes the caller take the pile');
  check(C.decide(p, 2, true) === p, 'cheat: only the player whose turn it is to say can say');
  // Winning: the last cards, and surviving the call.
  const w = mk(['7C', '3C 4D', 'KS']);
  const out = C.play(w, 0, ids('7C'));
  check(out.hands[0].length === 0 && out.phase === 'call', 'cheat: going out still lets the others call');
  const won = C.decide(C.decide(out, 1, false), 2, false);
  check(won.phase === 'over' && won.winner === 0, 'cheat: going out and not being called wins');
  const wonTrue = C.decide(out, 1, true);
  check(wonTrue.phase === 'over' && wonTrue.winner === 0 && wonTrue.hands[1].length === 3, 'cheat: going out honestly and being called wins, and the caller takes the pile');
  const caught = C.decide(C.play(mk(['9S', '3C 4D', 'KS']), 0, ids('9S')), 1, true);
  check(caught.phase === 'play' && caught.hands[0].length === 1 && caught.winner === -1, 'cheat: going out with a lie and being called takes the pile and plays on');
  check(C.play(mk(['7C 7D 7H 7S 2C', 'KS']), 0, ids('7C 7D 7H 7S')).last.count === 4, 'cheat: four of the rank is the most there is');
  // The ranks go round.
  let r = mk(['AC 2C 3C 4C 5C 6C 7C 8C 9C TC JC QC KC AD 2D', '2S 3S']), claims = [];
  r.claim = 12; r.turn = 0;
  r = C.decide(C.play(r, 0, ids('2C')), 1, false); claims.push(r.claim);
  r = C.decide(C.play(r, 1, ids('2S')), 0, false); claims.push(r.claim);
  check(claims.join() === '13,1', 'cheat: the rank after the king is the ace');
  // The computer.
  const ai = C.aiPlay(mk(['7C 7D 2S 9H', '3C 4D', 'KS']), 0, lcg(3));
  check(ai.filter(c => Z.rank(c) === 7).length === 2 && ai.length <= 3 && C.canPlay(mk(['7C 7D 2S 9H', '3C 4D', 'KS']), 0, ai), 'cheat: with the rank due in hand the computer plays it');
  const bluff = C.aiPlay(mk(['2C 3D 9S', '3C 4D', 'KS']), 0, lcg(3));
  check(bluff.length >= 1 && bluff.length <= 2 && bluff.every(c => Z.rank(c) !== 7), 'cheat: without the rank the computer bluffs with one or two cards');
  const sure = C.play(mk(['7C', '7D 7H 7S 2C', 'KS']), 0, ids('7C'));
  const sure2 = Object.assign({}, sure, { last: Object.assign({}, sure.last, { count: 2, ids: ids('7C 9D') }) });
  check(C.aiCall(sure2, 1, () => 0.99) === true, 'cheat: the computer always calls what cannot be true (it holds three of the rank, two are said)');
  const calm = C.aiCall(C.play(mk(['7C', '2C 3C 4C 5C 6C 8C', 'KS']), 0, ids('7C')), 1, () => 0.5);
  check(calm === false || calm === true, 'cheat: the computer decides');
  // Whole games.
  for (const players of [2, 3, 4]) {
    let ended = 0, legal = true, kept = true, calls = 0, lies = 0, plays = 0, caught = 0;
    for (let g = 0; g < 30; g++) {
      let s = C.deal(order(800 + g * 3 + players), players, g % players), rng = lcg(g + 31), guard = 0;
      while (s.phase !== 'over' && guard++ < 6000) {
        if (s.phase === 'play') {
          const ids2 = C.aiPlay(s, s.turn, rng);
          if (!C.canPlay(s, s.turn, ids2)) { legal = false; break; }
          s = C.play(s, s.turn, ids2); plays++; if (!C.wasTrue(s.last)) lies++;
        } else {
          const who = C.decider(s), call = C.aiCall(s, who, rng);
          if (call) { calls++; if (!C.wasTrue(s.last)) caught++; }
          s = C.decide(s, who, call);
        }
        if (total(s) !== 52) { kept = false; break; }
      }
      if (s.phase === 'over') ended++;
    }
    check(legal, 'cheat: ' + players + ' computers only play what they may');
    check(kept, 'cheat: ' + players + ' computers never lose or invent a card');
    check(ended === 30, 'cheat: all 30 games of ' + players + ' computers end');
    check(lies / plays > 0.1 && lies / plays < 0.9, 'cheat: ' + players + ' computers bluff ' + Math.round(100 * lies / plays) + ' percent of their plays, not never, not always');
    check(calls > 0 && caught / calls > 0.4, 'cheat: ' + players + ' computers call sensibly, ' + Math.round(100 * caught / Math.max(1, calls)) + ' percent of their calls find a lie');
  }
}

console.log('\n' + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
