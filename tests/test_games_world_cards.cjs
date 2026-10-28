// ZimiGames' card games from around the world (Spades, Euchre, Gin Rummy,
// Cribbage, Crazy Eights, Durak, Scopa): the rules as pure functions on plain
// states. Legal plays, scoring, the computer players (played through whole
// hands and games, every play checked legal). No DOM: the game files run
// their page wiring only when a #zc-table exists.
//
// Run: node tests/test_games_world_cards.cjs   (exit 0 = pass)

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
for (const f of ['text.js', 'cardbacks.js', 'courts.js', 'cards.js', 'cardtable.js', 'scopa.js', 'cribbage.js', 'euchre.js', 'crazyeights.js', 'spades.js', 'gin.js', 'durak.js']) {
  if (!fs.existsSync(path.join(dir, f))) continue;
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
}
const Z = sandbox.ZimiCards, T = sandbox.ZimiTable;
const L = 'A23456789TJQK', SU = 'CDHS';
// A card from its short name: "QS" is the queen of spades, "TH" the ten of hearts.
const id = s => Z.make(L.indexOf(s[0]) + 1, SU.indexOf(s[1]));
const ids = s => s.split(' ').map(id);
// A seeded generator, so a failure replays.
const lcg = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const order = seed => Z.shuffled(lcg(seed));

// ── The shared table ────────────────────────────────────────────────────────
{
  const hand = T.sortHand(ids('AS 2H 5C KD 3S'), T.rankHigh);
  check(same(hand, ids('5C KD 3S AS 2H')), 'a hand sorts by alternating suit, ace high');
  check(T.rowsFor({ W: 390, pad: 8, cw: 49 }, 9) === 1 && T.rowsFor({ W: 390, pad: 8, cw: 49 }, 13) === 1 && T.rowsFor({ W: 390, pad: 8, cw: 49 }, 15) === 1 && T.rowsFor({ W: 390, pad: 8, cw: 49 }, 26) === 2, 'a hand is one fanned row to fifteen cards, and wraps only when a strip would be under 22 px');
{
  const g = T.geometry({ W: 390, H: 700, cw: 49, ch: 69, pad: 8 }, 1);
  const hand = T.handCards(g, ids('2C 3C 4C 5C 6C 7C 8C 9C TC JC QC KC AC'), () => ({}), null);
  const xs = hand.cards.map(c => c.x), rows = new Set(hand.cards.map(c => c.y)).size;
  check(hand.rows === 1 && rows === 1, 'a 13-card hand lays out in one fanned row');
  check(hand.cards.slice(0, 7).every((c, i, a) => i === 0 || c.x - a[i - 1].x >= 22), 'no card strip is narrower than 22 px');
  check(Math.max.apply(null, hand.cards.map(c => c.y)) === g.southY, 'the bottom row sits on the bottom of the table');
  const dimmed = T.handCards(g, ids('2C 3C 4C'), id => ({ dim: id === ids('2C')[0] }), null);
  check(dimmed.cards[0].y > dimmed.cards[1].y && dimmed.cards[1].y === dimmed.cards[2].y - 0 && dimmed.cards[1].y < g.southY, 'when some cards cannot be played, the ones you can play stand proud');
  const down = T.fan(g, 1, ids('2C 3C 4C 5C 6C 7C 8C'), false);
  check(down.length === 7 && new Set(down.map(c => c.x + ',' + c.y)).size === 1, 'an opponent hand of more than five collapses to one place');
  const few = T.fan(g, 1, ids('2C 3C 4C 5C'), false);
  check(new Set(few.map(c => c.y)).size === 4, 'five or fewer stay fanned');
}
  const sh = T.shuffleOf([1, 2, 3, 4, 5], lcg(3));
  check(sh.length === 5 && sh.slice().sort().join() === '1,2,3,4,5', 'shuffleOf keeps the cards');
}

// ── Spades ──────────────────────────────────────────────────────────────────
{
  const SP = sandbox.ZimiSpades;
  const t = (bids, tricks, bags = 0) => SP.scoreTeam(bids, tricks, bags);
  check(t([3, 4], [4, 4]).points === 71 && t([3, 4], [4, 4]).bags === 1, 'a made contract of 7 with 8 tricks: 70 + 1 bag');
  check(t([3, 4], [2, 4]).points === -70, 'a missed contract of 7 loses 70');
  check(t([0, 5], [0, 5]).points === 150, 'nil made (+100) with the partner making 5 (+50)');
  check(t([0, 5], [1, 5]).points === 50 - 100 + 1 && t([0, 5], [1, 5]).bags === 1, 'nil broken: -100, and the nil bidder’s trick is a bag');
  check(t([4, 3], [4, 3], 9).points === 70 && t([4, 3], [4, 3], 9).bags === 9, 'bags: no penalty without extras');
  check(t([4, 3], [5, 3], 9).points === 70 + 1 - 100 && t([4, 3], [5, 3], 9).bags === 0 && t([4, 3], [5, 3], 9).penalty === 100, 'the tenth bag costs 100 and the count wraps');
  check(t([0, 0], [0, 0]).points === 200 && t([0, 0], [0, 0]).made === null, 'both nil and both clean: +200, no contract');
  check(SP.gameWinner([500, 480]) === 0 && SP.gameWinner([510, 520]) === 1 && SP.gameWinner([300, -210]) === 0 && SP.gameWinner([400, 400]) === -1, 'game end: 500 wins, -200 loses, the higher team over 500 wins');

  // Trump and following suit.
  const win = (cards) => SP.trickWinner(cards.map(([seat, c]) => ({ seat, id: id(c) })));
  check(win([[0, '5H'], [1, 'KH'], [2, '2S'], [3, 'AH']]) === 2, 'the lowest spade beats the ace of the suit led');
  check(win([[0, '5H'], [1, 'KH'], [2, '2D'], [3, 'AH']]) === 3, 'a discard of another suit never wins');
  check(win([[0, '5S'], [1, 'KS'], [2, '2S'], [3, 'AH']]) === 1, 'the highest spade wins a spade trick');
  const st = (hands, extra) => Object.assign({ hands: hands.map(ids), bids: [3, 3, 3, 3], dealer: 3, turn: 0, leader: 0, trick: [], tricks: [0, 0, 0, 0], broken: false, played: [], scores: [0, 0], bags: [0, 0], handNo: 0, phase: 'play', result: null }, extra);
  const open = st(['AS KS 2H 3C', '4D', '5D', '6D']);
  check(same(SP.legalPlays(open, 0), ids('2H 3C')), 'spades cannot lead until broken');
  check(same(SP.legalPlays(st(['AS KS', '4D', '5D', '6D']), 0), ids('AS KS')), 'an all-spade hand may lead spades');
  check(same(SP.legalPlays(Object.assign(open, { broken: true }), 0), ids('AS KS 2H 3C')), 'once broken, spades may lead');
  const follow = st(['AH 2H 5S 3C', '4D', '5D', '6D'], { trick: [{ seat: 3, id: id('9H') }], turn: 0 });
  check(same(SP.legalPlays(follow, 0), ids('AH 2H')), 'you must follow suit');
  const voidH = st(['5S 3C', '4D', '5D', '6D'], { trick: [{ seat: 3, id: id('9H') }] });
  check(same(SP.legalPlays(voidH, 0), ids('5S 3C')), 'void in the suit: anything goes, spades included');
  check(SP.playCard(voidH, 0, id('5S')).broken === true, 'a spade played on another suit breaks spades');

  // Bidding turns into play.
  let s = SP.dealHand(order(5), 0, [0, 0], [0, 0], 3);
  check(s.phase === 'bid' && s.turn === 0 && s.hands.every(h => h.length === 13), 'a new hand: bidding starts left of the dealer');
  s = SP.placeBid(SP.placeBid(SP.placeBid(SP.placeBid(s, 0, 3), 1, 0), 2, 4), 3, 2);
  check(s.phase === 'play' && s.turn === 0 && same(s.bids, [3, 0, 4, 2]), 'after four bids the play starts, with Nil kept as 0');

  // The computer bids and plays whole hands and games: every play legal.
  let games = 0, hands = 0, bad = 0, nilMade = 0, nilBid = 0;
  for (let seed = 1; seed <= 12; seed++) {
    let g = SP.newGame(order(seed * 7), seed % 4), guard = 0;
    while (g.phase !== 'over' && guard++ < 40) {
      let steps = 0;
      while ((g.phase === 'bid' || g.phase === 'play') && steps++ < 200) {
        if (g.phase === 'bid') { g = SP.placeBid(g, g.turn, SP.aiBid(g, g.turn)); continue; }
        if (g.trick.length === 4) { g = SP.resolveTrick(g); continue; }
        const c = SP.aiPick(g, g.turn);
        if (!SP.isLegal(g, g.turn, c)) { bad++; break; }
        g = SP.playCard(g, g.turn, c);
      }
      if (g.phase === 'handEnd') { hands++; g.bids.forEach((b, i) => { if (b === 0) { nilBid++; if (g.tricks[i] === 0) nilMade++; } }); g = SP.nextHand(g, order(seed * 100 + guard)); } else if (g.phase === 'over') hands++;
    }
    if (g.phase === 'over') games++;
  }
  check(bad === 0, 'the computer never plays an illegal card (' + hands + ' hands)');
  check(games === 12, 'every simulated game reaches 500 or -200 (' + games + ' of 12)');
  check(SP.estimate(ids('AS KS QS JS 9S 5S AH KH AD AC KC QC 2D')) > 6 && SP.estimate(ids('2S 3S 4D 5D 6D 7D 8H 9H 3C 4C 5C 6C 7C')) < 1.5, 'the bid estimate tells a strong hand from a weak one');
}

// ── Gin Rummy ───────────────────────────────────────────────────────────────
{
  const G = sandbox.ZimiGin;
  const dw = s => G.deadwood(ids(s));
  check(dw('AS 2S 3S 4S 7H 7D 7C 9D 9C KH') === 9 + 9 + 10, 'a run of four and a set leave 28 deadwood');
  check(dw('AS 2S 3S 7H 7D 7C 4D 5D 6D 8C') === 8, 'three melds leave only the 8');
  check(dw('KS QS JS TS 9S 8S 7S 6S 5S 4S') === 0, 'ten of a suit in a row is gin');
  check(dw('QH KH AH 2H 3H 9C 9D 9S 5C 6D') === 31, 'ace is low: Q K A is not a run');
  const best = G.bestMelds(ids('5S 5H 5D 6S 7S 9C 4D 8H TC JC'));
  check(best.dw === 22 && best.melds.length === 2, 'the best partition: the run of spades and the clubs run (22 left), not the set of fives (25)');
  const overlap = G.bestMelds(ids('5S 5H 5D 6S 7S 2C 3C 4D KD QC'));
  check(overlap.dw === 39 && overlap.melds.length === 1 && overlap.melds[0].length === 3 && overlap.melds[0].every(c => Z.suit(c) === 3), 'a card that fits two melds goes where it saves most');
  const split = G.bestMelds(ids('5S 5H 5D 6S 7S 9C 9D 2C 3H KD'));
  check(split.dw === 43 && split.melds.length === 1, 'the run of 5S 6S 7S (18) beats the set of fives (15)');
  check(G.val(id('KD')) === 10 && G.val(id('AD')) === 1 && G.val(id('9C')) === 9, 'card values');

  // Layoffs.
  const run = ids('5H 6H 7H'), set3 = ids('9S 9H 9D');
  check(G.canExtend(run, id('4H')) && G.canExtend(run, id('8H')) && !G.canExtend(run, id('9H')) && !G.canExtend(run, id('4S')), 'a run grows at either end in its own suit');
  check(G.canExtend(set3, id('9C')) && !G.canExtend(set3, id('8C')) && !G.canExtend(ids('9S 9H 9D 9C'), id('9C')), 'a set of three takes the fourth of its rank only');
  const lo = G.layOff([run, set3], ids('4H 3H 9C KD 2S'));
  check(same(lo.laid.slice().sort((a, b) => a - b), ids('9C 4H 3H').sort((a, b) => a - b)) && same(lo.rest.slice().sort((a, b) => a - b), ids('KD 2S').sort((a, b) => a - b)), 'laying off chains: 4 then 3 on a run, the fourth 9 on the set');
  check(!(lo.melds[0].indexOf(id('3H')) < 0), 'the run really grew');

  // Showdowns.
  const knock = ids('AS 2S 3S 4H 5H 6H 7D 7C 7S 8C');
  const small = G.showdown(knock, ids('KS KH 2D 4C 5C 9D 9H JD QS 3D'));
  check(small.kDw === 8 && small.winner === 'knocker' && small.points === small.oDw - 8, 'a knock against more deadwood scores the difference');
  const under = G.showdown(ids('AS 2S 3S 4H 5H 6H 7D 7C 7S TC'), ids('AD 2D 3D 8H 8S 8D 9H 9S 9C 4C'));
  check(under.kDw === 10 && under.oDw === 4 && under.undercut && under.winner === 'other' && under.points === 10 - 4 + 25, 'less deadwood than the knocker is an undercut: the difference plus 25');
  const laidOn = G.showdown(ids('AS 2S 3S 4H 5H 6H 7D 7C 7S 8C'), ids('4S 8H 8S 8D QH KC JD 9C 3C TH'));
  check(laidOn.laid.length > 0 && laidOn.oDw < laidOn.oDwBefore, 'the defender lays off before counting');
  const gin = G.showdown(ids('AS 2S 3S 4S 5H 6H 7H 9D 9C 9S'), ids('4H 8H 8S KD QC 2D 3C TH JD 5C'));
  check(gin.gin && gin.kDw === 0 && gin.laid.length === 0 && gin.points === 25 + gin.oDw && gin.oDw === gin.oDwBefore, 'gin: 25 plus the deadwood, and no layoffs');

  // The hand: offers, draws, knocking, draws.
  const gs = G.dealHand(order(11), 0, [0, 0], [0, 0], 1);
  check(gs.hands[0].length === 10 && gs.hands[1].length === 10 && gs.stock.length === 31 && gs.discard.length === 1 && gs.turn === 0 && gs.phase === 'offer', 'a new hand: ten each, the upcard offered to the non-dealer');
  const p1 = G.passUp(gs), p2 = G.passUp(p1);
  check(p1.turn === 1 && p1.phase === 'offer' && p2.phase === 'draw' && p2.turn === 0 && p2.upLocked && !G.canDraw(p2, true) && G.canDraw(p2, false), 'both pass: the non-dealer draws from the stock');
  const taken = G.takeUp(gs);
  check(taken.phase === 'discard' && taken.hands[0].length === 11 && !G.canDiscard(taken, taken.drawn) && G.canDiscard(taken, taken.hands[0][0]), 'taking the upcard: you cannot discard it straight back');
  const dr = G.drawCard(p2, false), dd = G.discardCard(dr, dr.hands[0][0]);
  check(dr.hands[0].length === 11 && dd.hands[0].length === 10 && dd.phase === 'draw' && dd.turn === 1 && dd.discard.length === 2, 'draw then discard passes the turn');
  const low = Object.assign(G.dealHand(order(3), 0, [0, 0], [0, 0], 1), { phase: 'discard', turn: 0 });
  low.stock = low.stock.slice(0, 2);
  low.hands[0] = low.hands[0].concat(low.stock.pop());
  const drawn = G.discardCard(low, low.hands[0][0]);
  check(drawn.phase === 'show' && drawn.result.draw && drawn.scores[0] === 0 && drawn.scores[1] === 0, 'two cards left in the stock after a discard: the hand is a draw');

  // Knocking through the state, and the game's end.
  let ks = Object.assign(G.dealHand(order(1), 0, [0, 0], [0, 0], 1), { phase: 'discard', turn: 0 });
  ks.hands[0] = ids('AS 2S 3S 4H 5H 6H 7D 7C 7S 8C KD'); ks.hands[1] = ids('KS KH 2D 4C 5C 9D 9H JD QS 3D');
  check(G.canKnock(ks, id('KD')) && !G.canKnock(ks, id('7S')), 'you may knock only when what remains is 10 or less');
  const kn = G.knock(ks, id('KD'));
  check(kn.phase === 'show' && kn.result.scorer === 0 && kn.scores[0] === kn.result.points && kn.boxes[0] === 1, 'a winning knock scores for the knocker and counts a hand won');
  const near = Object.assign(G.dealHand(order(1), 0, [95, 40], [3, 1], 1), { phase: 'discard', turn: 0 });
  near.hands[0] = ks.hands[0]; near.hands[1] = ks.hands[1];
  const done = G.knock(near, id('KD'));
  check(done.final && done.final.winner === 0 && done.final.totals[0] === done.scores[0] + 4 * 25 + 100 && done.final.totals[1] === 40 + 25, 'past 100: 100 for the game and 25 for each hand won');

  // The computer, both sides, whole games: every move legal.
  let games = 0, hands = 0, bad = 0, knocks = 0, undercuts = 0, draws = 0;
  for (let seed = 1; seed <= 25; seed++) {
    let g = G.newGame(order(seed * 13), seed % 2), guard = 0;
    while (!(g.phase === 'show' && g.final) && guard++ < 60) {
      let steps = 0;
      while (g.phase !== 'show' && steps++ < 400) {
        const before = g.turn, hand = g.hands[before].length;
        g = G.aiStep(g);
        if (g.hands[0].length + g.hands[1].length < 19 || g.hands[0].length > 11 || g.hands[1].length > 11) { bad++; break; }
        if (g.phase === 'discard' && g.hands[g.turn].length !== 11) { bad++; break; }
      }
      if (steps >= 400) { bad++; break; }
      hands++; if (g.result.draw) draws++; else { knocks++; if (g.result.undercut) undercuts++; }
      if (!g.final) g = G.nextHand(g, order(seed * 1000 + guard));
    }
    if (g.final) games++;
  }
  check(bad === 0, 'the computer plays only legal moves (' + hands + ' hands, ' + knocks + ' knocks, ' + undercuts + ' undercuts, ' + draws + ' draws)');
  check(games === 25, 'every simulated game reaches 100 (' + games + ' of 25)');
}

// ── Euchre ──────────────────────────────────────────────────────────────────
{
  const E = sandbox.ZimiEuchre;
  const HEARTS = 2, DIAMONDS = 1, SPADES_ = 3, CLUBS = 0;
  check(E.DECK.length === 24 && E.DECK.every(c => Z.rank(c) === 1 || Z.rank(c) >= 9), 'the Euchre deck is 24 cards, 9 to ace');
  check(E.effSuit(id('JD'), HEARTS) === HEARTS && E.effSuit(id('JH'), HEARTS) === HEARTS && E.effSuit(id('JC'), HEARTS) === CLUBS, 'with hearts trump the jack of diamonds is a heart; the jack of clubs is not');
  const order5 = ['JH', 'JD', 'AH', 'KH', '9H', 'AS'].map(id);
  check(same(E.arrange(order5, HEARTS), ['JH', 'JD', 'AH', 'KH', '9H', 'AS'].map(id)), 'a hand sorts right bower, left bower, trump, then the rest');
  const w = (cards, trump) => E.trickWinner(cards.map(([seat, c]) => ({ seat, id: id(c) })), trump);
  check(w([[0, 'AD'], [1, 'JH'], [2, 'JD'], [3, 'KD']], HEARTS) === 1, 'right bower beats left bower and the ace');
  check(w([[0, 'AC'], [1, 'JD'], [2, '9H'], [3, 'KC']], HEARTS) === 1, 'left bower beats a low trump');
  check(w([[0, '9H'], [1, 'AC'], [2, 'TH'], [3, 'KC']], HEARTS) === 2, 'the higher trump wins');
  check(w([[0, '9C'], [1, 'AC'], [2, 'TC'], [3, 'KD']], HEARTS) === 1, 'no trump: the highest card of the suit led wins');
  check(w([[0, '9C'], [1, 'AD'], [2, 'TD'], [3, 'KD']], HEARTS) === 0, 'off-suit non-trump never wins');
  const mk = (hands, trump, trick) => ({ hands: hands.map(ids), trump, trick: (trick || []).map(([seat, c]) => ({ seat, id: id(c) })), phase: 'play', turn: 0, sitting: -1 });
  // Hearts trump, diamonds led: the jack of diamonds is a heart, so it need not follow.
  let s = mk(['JD 9D AS TC 9S', 'AC', 'AC', 'AC'], HEARTS, [[3, 'KD']]);
  check(same(E.legalPlays(s, 0), ids('9D')), 'the left bower is not a diamond: only 9D follows a diamond lead');
  s = mk(['JD 9D AS TC 9S', 'AC', 'AC', 'AC'], HEARTS, [[3, 'QH']]);
  check(same(E.legalPlays(s, 0), ids('JD')), 'a trump lead must be followed with the left bower');
  s = mk(['9D AS TC 9S AD', 'AC', 'AC', 'AC'], HEARTS, [[3, 'QH']]);
  check(E.legalPlays(s, 0).length === 5, 'void in trump: anything may be played');
  check(E.scoreHand(0, 3, false).points === 1 && E.scoreHand(0, 4, false).points === 1 && E.scoreHand(0, 5, false).points === 2, 'makers score 1 for 3 or 4 tricks and 2 for all five');
  check(E.scoreHand(0, 5, true).points === 4 && E.scoreHand(0, 4, true).points === 1, 'alone: 4 for all five, 1 for 3 or 4');
  const eu = E.scoreHand(0, 2, false);
  check(eu.team === 1 && eu.points === 2 && eu.euchred, 'a euchre gives the defenders 2');

  // The bidding rounds.
  let g = E.dealHand(order(11), 0, [0, 0], 3);
  check(g.phase === 'order1' && g.turn === 0 && g.hands.every(h => h.length === 5), 'a new hand: five cards each, the player left of the dealer calls first');
  let h = g; for (let i = 0; i < 4; i++) h = E.pass(h);
  check(h.phase === 'order2' && h.turnedDown === Z.suit(g.upcard) && h.turn === 0, 'four passes turn the card down for round two');
  for (let i = 0; i < 3; i++) h = E.pass(h);
  check(h.turn === 3 && !E.canPass(h) && E.pass(h).turn === 3, 'stick the dealer: the dealer cannot pass in round two');
  const up = E.orderUp(g, 1, false);
  check(up.phase === 'discard' && up.turn === 3 && up.hands[3].length === 6 && up.trump === Z.suit(g.upcard) && up.maker === 1, 'ordering up gives the dealer six cards to cut down from');
  const dn = E.discard(up, up.hands[3][5]);
  check(dn.phase === 'play' && dn.hands[3].length === 5 && dn.leader === 0, 'after the discard the player left of the dealer leads');
  const alone = E.orderUp(g, 0, true);
  check(alone.sitting === 2 && alone.alone, 'going alone sits the partner out');
  let a2 = E.discard(alone, alone.hands[3][5]);
  check(a2.trick.length === 0 && E.legalPlays(a2, 0).length === 5, 'the lone hand starts play');
  a2 = E.playCard(a2, 0, a2.hands[0][0]); a2 = E.playCard(a2, a2.turn, a2.hands[a2.turn][0]);
  check(a2.turn === 3, 'play skips the sitting-out partner (seat 2)');
  const named = E.nameTrump(h, 3, (Z.suit(g.upcard) + 1) % 4, false);
  check(named.phase === 'play' && named.trump !== null && E.nameTrump(h, 3, Z.suit(g.upcard), false).phase === 'order2', 'round two cannot name the suit turned down');

  // Whole games against themselves: every play legal, hands total 5 tricks.
  let games = 0, hands = 0, bad = 0, euchres = 0, lones = 0;
  for (let seed = 1; seed <= 25; seed++) {
    let st = E.newGame(order(seed * 13), seed % 4), guard = 0;
    while (st.phase !== 'over' && guard++ < 80) {
      let steps = 0;
      while (st.phase !== 'handEnd' && st.phase !== 'over' && steps++ < 200) {
        if (st.phase === 'order1' || st.phase === 'order2') {
          const c = st.phase === 'order1' ? E.aiOrder(st, st.turn) : E.aiName(st, st.turn);
          st = !c.call ? E.pass(st) : st.phase === 'order1' ? E.orderUp(st, st.turn, c.alone) : E.nameTrump(st, st.turn, c.suit, c.alone);
          if (c.call && c.alone) lones++;
          continue;
        }
        if (st.phase === 'discard') { st = E.discard(st, E.aiDiscard(st)); continue; }
        if (st.trick.length === (st.sitting >= 0 ? 3 : 4)) { st = E.resolveTrick(st); continue; }
        const c = E.aiPick(st, st.turn);
        if (!E.isLegal(st, st.turn, c)) { bad++; break; }
        st = E.playCard(st, st.turn, c);
      }
      if (bad) break;
      if (st.phase === 'handEnd') { hands++; if (st.result.euchred) euchres++; st = E.nextHand(st, order(seed * 1000 + guard)); } else if (st.phase === 'over') hands++;
    }
    if (st.phase === 'over') games++;
  }
  check(bad === 0, 'the computer never plays an illegal card (' + hands + ' hands)');
  check(games === 25, 'every simulated game reaches 10 (' + games + ' of 25)');
  check(euchres > 0 && euchres < hands, 'some hands are euchred and some are made (' + euchres + ' of ' + hands + '), ' + lones + ' alone calls');
  check(E.strength(ids('JH JD AH KH 9H'), HEARTS) > 8.5 && E.strength(ids('9C TD 9S 10S QD'), HEARTS) < 2, 'hand strength tells a monster from a dud');
}

// ── Crazy Eights ────────────────────────────────────────────────────────────
{
  const C = sandbox.ZimiCrazyEights;
  const mk = (hands, topCard, suit, extra) => Object.assign({ players: hands.length, hands: hands.map(ids), stock: ids('2C 3C 4C'), discard: [id(topCard)], suit: suit === undefined ? Z.suit(id(topCard)) : suit, turn: 0, dealer: 1, phase: 'play', scores: hands.map(() => 0), handNo: 0, result: null, passes: 0, recycles: 0 }, extra);
  let s = mk(['5H 9S 8D KC', '2D 3D'], '5C');
  check(same(C.legalPlays(s, 0), ids('5H 8D KC')), 'match the suit (KC), the rank (5H) or play an 8 (8D)');
  s = mk(['5H 9S KD', '2D 3D'], '5C');
  check(same(C.legalPlays(s, 0), ids('5H')), 'only the 5 matches a 5 of clubs here');
  s = mk(['5H 9S 8D', '2D 3D'], '5C');
  const afterEight = C.playCard(s, 0, id('8D'), 2);
  check(afterEight.suit === 2 && afterEight.turn === 1 && C.legalPlays(Object.assign({}, afterEight, { turn: 0, hands: [ids('KH 2S'), []] }), 0).length === 1, 'an 8 names the suit: now only hearts (or an 8) match');
  check(C.playCard(mk(['9S 4C', '2D 3D'], '5C'), 0, id('4C')).suit === 0, 'playing a club sets clubs');
  check(C.cardPoints(id('8S')) === 50 && C.cardPoints(id('KS')) === 10 && C.cardPoints(id('AS')) === 1 && C.cardPoints(id('7S')) === 7, 'hand points: 8 = 50, face = 10, ace = 1');
  const out = C.playCard(mk(['4C', '8H KD AS', '3S'], '5C'), 0, id('4C'));
  check(out.phase === 'handEnd' && out.result.winner === 0 && out.result.points === 50 + 10 + 1 + 3 && out.scores[0] === 64, 'going out scores what the others hold');
  const over = C.playCard(mk(['4C', '8H 8D'], '5C', undefined, { scores: [60, 0] }), 0, id('4C'));
  check(over.phase === 'over' && C.gameWinner(over.scores) === 0, 'reaching 100 ends the game');
  // Drawing and recycling.
  let d = C.draw(mk(['9S', '2D'], '5C'), 0);
  check(d.hands[0].length === 2 && d.stock.length === 2, 'drawing takes the top of the stock');
  let e = mk(['9S', '2D'], '5C', undefined, { stock: [], discard: ids('2C 3C 4C 5C') });
  check(C.canDraw(e), 'an empty stock can be refilled from the discards');
  e = C.draw(e, 0, lcg(4));
  check(e.discard.length === 1 && e.discard[0] === id('5C') && e.stock.length === 2 && e.hands[0].length === 2, 'the discards (all but the top) are reshuffled into the stock');
  const dead = mk(['9S', '2D'], '5C', undefined, { stock: [], discard: [id('5C')] });
  check(!C.canDraw(dead) && C.mustPass(dead, 0) && C.pass(dead, 0).turn === 1, 'nothing to play and nothing to draw: pass');
  const deal = C.dealHand(order(9), 4, 0, [0, 0, 0, 0], 3);
  check(deal.hands.every(x => x.length === 5) && deal.hands.length === 4 && deal.stock.length === 52 - 21 && Z.rank(deal.discard[0]) !== 8, 'four players get five each; the turned-up card is never an 8');
  check(C.dealHand(order(9), 2, 0, [0, 0], 1).hands[0].length === 7, 'two players get seven each');
  // Whole games for 2, 3 and 4 players.
  const sim = (players, seed) => {
    let st = C.newGame(order(seed), players), moves = 0, bad = 0;
    while (st.phase !== 'over' && moves++ < 5000) {
      if (st.phase === 'handEnd') { st = C.nextHand(st, order(seed + moves)); continue; }
      const seat = st.turn, mv = C.aiPlay(st, seat);
      if (mv) {
        if (!C.isLegal(st, seat, mv.id)) { bad++; break; }
        st = C.playCard(st, seat, mv.id, mv.suit);
      } else if (C.canDraw(st)) st = C.draw(st, seat, lcg(moves));
      else st = C.pass(st, seat);
      const total = st.stock.length + st.discard.length + st.hands.reduce((n, x) => n + x.length, 0);
      if (total !== 52) { bad++; break; }
    }
    return { over: st.phase === 'over', bad };
  };
  for (const players of [2, 3, 4]) {
    let ok = 0, bad = 0;
    for (let seed = 1; seed <= 15; seed++) { const r = sim(players, seed * 31); if (r.over) ok++; bad += r.bad; }
    check(bad === 0 && ok === 15, players + ' players: 15 games end, every play legal and all 52 cards kept (' + ok + ' ended)');
  }
  check(C.commonestSuit(ids('2H 3H 4H 5S 8C'), 0) === 2, 'the computer names the suit it holds most of');
}


// ── Cribbage ────────────────────────────────────────────────────────────────
{
  const C = sandbox.ZimiCribbage;
  const sc = (hand, starter, crib = false) => C.scoreHand(ids(hand), id(starter), crib);
  check(sc('5C 5D 5S JH', '5H').total === 29, 'the 29 hand: three fives, the jack of the starter\u2019s suit, the fourth five cut');
  const run3 = sc('2C 4D 5S KH', '3C');
  check(run3.items.filter(i => i.kind === 'run').length === 1 && run3.items.find(i => i.kind === 'run').pts === 4, 'a run of four scores 4');
  check(sc('7C 7D 8S 9H', 'KC').total === 12 && sc('7C 7D 8S 9H', 'KC').items.filter(i => i.kind === 'run').length === 2, 'a double run of three: 7-8 fifteens 4, pair 2, two runs 6 = 12');
  check(sc('AC 3C 5C 9C', '2D').items.some(i => i.kind === 'flush' && i.pts === 4), 'a four-card flush scores 4 in the hand');
  check(sc('AC 3C 5C 9C', '2C').items.some(i => i.kind === 'flush' && i.pts === 5), 'five of a suit with the starter scores 5');
  check(!sc('AC 3C 5C 9C', '2D', true).items.some(i => i.kind === 'flush'), 'the crib needs all five for a flush');
  check(sc('AC 3C 5C 9C', '2C', true).items.some(i => i.kind === 'flush' && i.pts === 5), 'a five-card flush counts in the crib');
  check(sc('JC 2D 6H 9S', 'KC').items.some(i => i.kind === 'nobs') && !sc('JC 2D 6H 9S', 'KD').items.some(i => i.kind === 'nobs'), 'nobs: the jack of the starter\u2019s suit only');
  check(sc('2C 4D 7S KH', 'QC').total === 0 && sc('2C 4D 7S KH', 'QC').items.length === 0, 'a nineteen hand scores nothing');
  check(sc('5C 5D 5S 5H', 'KS').total === 28, 'four fives with a king: 28');
  check(/^Fifteen for 2: /.test(C.itemText({ kind: 'fifteen', cards: ids('5H KS'), pts: 2 })) && /^Run of 3 for 3/.test(C.itemText({ kind: 'run', cards: ids('3H 4S 5D'), pts: 3 })), 'the breakdown reads line by line');

  const peg = s => C.pegScore(ids(s));
  check(peg('7C 8D').pts === 2 && peg('7C 8D').parts[0] === 'fifteen', 'a count of 15 scores 2');
  check(peg('KC QD 9H 2S').count === 31 && peg('KC QD 9H 2S').pts === 2, 'thirty-one scores 2');
  check(peg('4C 4D').pts === 2 && peg('4C 4D 4S').pts === 6 && peg('4C 4D 4S 4H').pts === 12, 'pairs 2, three of a kind 6, four of a kind 12');
  check(peg('3C 4D 5S').pts === 3 && peg('2C 5C 3D 4S').pts === 4, 'runs score their length, counting the latest cards');
  check(peg('KC 3C 5D 4S').pts === 3, 'a run counts in any order');
  check(peg('2C 9D 3S 4H').pts === 0, 'cards that are not consecutive are no run');
  check(peg('5C 6D 8S 7H 9C').pts === 5 && peg('6D 8S 7H').pts === 3, 'a run of five scores 5; of three, 3');

  // The state machine: pegging, go, last card.
  let s = C.deal(order(9), 0, [0, 0], [0, 0], 1);
  check(s.phase === 'discard' && s.hands.every(h => h.length === 6) && s.turn === 0, 'a hand: six each, the pone (you, with North dealing) plays first');
  s = C.discard(s, 0, s.hands[0].slice(0, 2));
  check(s.phase === 'discard' && s.crib.length === 2, 'one discard is not enough for the cut');
  s = C.discard(s, 1, C.aiDiscard(s.hands[1], true));
  check(s.phase === 'cut' && s.crib.length === 4 && s.hands.every(h => h.length === 4), 'both discard: the crib has four, each keeps four');
  const sh = hands => C.cutStarter(Object.assign(C.deal(order(1), 0, [0, 0], [0, 0], 1), { hands: hands.map(ids), phase: 'cut', crib: ids('2C 3C 4C 5C'), starter: id('9D') }));
  let p = sh(['KC 5H 2D JS', 'QC 6D 8S 9H']);
  check(p.phase === 'peg' && p.turn === 0 && p.count === 0, 'the cut over: pegging, the pone leads');
  p = C.playPeg(p, 0, id('KC'));
  check(p.count === 10 && p.turn === 1, 'a play adds to the count and passes the turn');
  p = C.playPeg(p, 1, id('QC'));
  check(p.count === 20 && p.turn === 0 && !p.roundOver && C.legalPeg(p, 0).length === 3, 'the count builds');
  p = C.playPeg(p, 0, id('5H'));
  check(p.count === 25 && p.turn === 1 && same(C.legalPeg(p, 1), [id('6D')]), 'at 25 North can only play the 6');
  p = C.playPeg(p, 1, id('6D'));
  check(p.count === 31 && p.roundOver === '31' && p.scores[1] === 2, 'reaching 31 scores 2 and ends the round');
  p = C.nextRound(p);
  check(p.count === 0 && p.seq.length === 0 && p.turn === 0, 'after 31 the player who did not play last leads');
  // A go with one side still able to play, then both stuck.
  let g = sh(['KC 9S 2H 3D', 'QC QD 8H 3S']);
  g = C.playPeg(C.playPeg(C.playPeg(g, 0, id('KC')), 1, id('QC')), 0, id('9S'));
  check(g.count === 29 && g.turn === 0 && g.goes[1] === true && /Zimi says go/.test(g.msg), 'Zimi cannot play: he says go and you carry on');
  g = C.playPeg(g, 0, id('2H'));
  check(g.roundOver === '31' && g.scores[0] === 2, 'you reach 31 (2 points, no extra go point)');
  let h = sh(['KC KD 9S 2H', 'QC QD 8H 3S']);
  h = C.playPeg(C.playPeg(C.playPeg(h, 0, id('KC')), 1, id('QC')), 0, id('KD'));
  check(h.count === 30 && h.roundOver === 'go' && h.scores[0] === 1 && /go/.test(h.msg), 'neither can play: the last to play scores 1 for the go');
  // His heels.
  const heels = C.cutStarter(Object.assign(C.deal(order(2), 0, [0, 0], [0, 0], 1), { hands: [ids('2C 3C 4C 5C'), ids('2D 3D 4D 5D')], starter: id('JH') }));
  check(heels.scores[1] === 2 && /heels/.test(heels.msg), 'a jack cut gives the dealer 2: his heels');
  // The show scores the pone first, and stops at 121.
  let sw = Object.assign(C.deal(order(3), 0, [0, 0], [0, 0], 1), { phase: 'show', kept: [ids('5C 5D 5S JH'), ids('2C 3D 8S KH')], crib: ids('2H 2S 7C 9D'), starter: id('5H'), scores: [100, 50], prev: [90, 40] });
  sw = C.enterShow(sw, 0);
  check(sw.showWho === 0 && sw.scores[0] === 121 && sw.phase === 'over' && sw.winner === 0, 'the pone counts first, and reaching 121 ends the game on the spot');
  let sw2 = Object.assign(C.deal(order(3), 0, [0, 0], [0, 0], 1), { phase: 'show', kept: [ids('2C 3D 8S KH'), ids('5C 5D 5S JH')], crib: ids('2H 2S 7C 9D'), starter: id('5H') });
  sw2 = C.enterShow(C.enterShow(sw2, 0), 1);
  check(sw2.showWho === 1 && sw2.scores[1] === 29 && sw2.prev[1] === 0, 'the dealer’s 29 pegs 29 with the back peg left behind');
  check(C.holePos(0, 0)[0] < C.holePos(1, 0)[0] && C.holePos(60, 0)[1] === C.holePos(1, 0)[1] && C.holePos(61, 0)[1] > C.holePos(60, 0)[1] && C.holePos(121, 1)[1] > 40, 'peg board positions: out along the top, back along the bottom, the finish at the end');
  check(/<svg/.test(C.boardSvg([10, 20], [5, 15])), 'the board draws');

  // The computer discards sensibly and plays whole games with every play legal.
  const kept = C.aiDiscard(ids('5C 5D 5S JH 2C KD'), true);
  check(kept.includes(id('2C')) && kept.includes(id('KD')), 'with a 29 in hand it throws the junk');
  let games = 0, bad = 0, hands = 0;
  for (let seed = 1; seed <= 4; seed++) {
    let st = C.newGame(order(seed * 13), seed % 2), guard = 0;
    while (st.phase !== 'over' && guard++ < 60) {
      st = C.discard(st, 0, C.aiDiscard(st.hands[0], st.dealer === 0));
      st = C.discard(st, 1, C.aiDiscard(st.hands[1], st.dealer === 1));
      st = C.cutStarter(st);
      let steps = 0;
      while (st.phase === 'peg' && steps++ < 100) {
        if (st.roundOver) { st = C.nextRound(st); continue; }
        const c = C.aiPeg(st, st.turn);
        if (!C.isLegalPeg(st, st.turn, c)) { bad++; break; }
        st = C.playPeg(st, st.turn, c);
      }
      if (st.phase === 'show') { st = C.enterShow(st, 0); if (st.phase !== 'over') st = C.enterShow(st, 1); if (st.phase !== 'over') st = C.enterShow(st, 2); }
      hands++;
      if (st.phase !== 'over') st = C.nextHand(st, order(seed * 1000 + guard));
    }
    if (st.phase === 'over' && st.scores[st.winner] === 121) games++;
  }
  check(bad === 0 && games === 4, 'four simulated games reach 121, every play legal (' + hands + ' hands, ' + bad + ' illegal)');
}

// ── Durak ───────────────────────────────────────────────────────────────────
{
  const D = sandbox.ZimiDurak;
  check(D.DECK.length === 36 && D.DECK.every(c => Z.rank(c) === 1 || Z.rank(c) >= 6), 'the deck is 36 cards, 6 to ace');
  // A hand-made state: hearts trump, 3 players.
  const mk = (hands, extra) => Object.assign({
    n: 3, hands: hands.map(ids), stock: ids('6H 7C 8C 9C 6C'), trump: 2, table: [], discard: [], attacker: 0, defender: 1, throwers: [0, 2], tIdx: 0, passes: 0,
    defCap: 6, bouts: 1, phase: 'attack', turn: 0, taken: false, out: [], durak: -1, last: null, moves: 0
  }, extra);
  const st0 = mk(['7S 7D 9C TS AH 8H', '6S 8S TD JH QH 6C', '7H 8D 9D KC AS KD']);
  check(D.beats(st0, id('8S'), id('7S')) && !D.beats(st0, id('6S'), id('7S')), 'a higher card of the same suit beats');
  check(!D.beats(st0, id('AD'), id('7S')), 'another plain suit never beats, however high');
  check(D.beats(st0, id('6H'), id('AS')) && D.beats(st0, id('6H'), id('7S')), 'any trump beats a plain card');
  check(D.beats(st0, id('8H'), id('7H')) && !D.beats(st0, id('7H'), id('8H')) && !D.beats(st0, id('AS'), id('6H')), 'a trump only falls to a higher trump');
  check(D.hi(id('AS')) === 14 && D.hi(id('6S')) === 6, 'ace is high');

  // Attack and defence legality.
  check(same(D.legalThrows(st0, 0).sort(), st0.hands[0].slice().sort()), 'the attacker leads any card');
  check(D.legalThrows(st0, 2).length === 0, 'only the attacker leads, and only on their turn');
  const a1 = D.attackCard(st0, id('7S'));
  check(a1.phase === 'defend' && a1.turn === 1 && a1.table.length === 1 && a1.hands[0].length === 5, 'an attack passes the turn to the defender');
  check(same(D.legalDefences(a1, 1).sort(), ids('8S JH QH 6C').filter(c => D.beats(a1, c, id('7S'))).sort()) && D.legalDefences(a1, 1).indexOf(id('6S')) < 0, 'the defender may beat with a higher spade or any trump');
  check(D.legalDefences(a1, 1).indexOf(id('TD')) < 0 && D.legalDefences(a1, 1).indexOf(id('6C')) < 0, 'a higher card of another plain suit does not beat');
  const dfd = D.defendCard(a1, id('8S'));
  check(dfd.table[0].d === id('8S') && dfd.phase === 'attack' && dfd.turn === 0, 'beaten: the attacker may add');
  // Throw-ins by rank: 7 and 8 are on the table.
  check(same(D.legalThrows(dfd, 0).sort(), ids('7D 8H').sort()), 'throw-ins match a rank on the table, attack or defence');
  const passed = D.pass(dfd);
  check(passed.turn === 2 && D.legalThrows(passed, 2).sort().join() === ids('7H 8D').sort().join(), 'the next player may throw in as well');
  const done = D.pass(D.pass(dfd));
  check(done.phase === 'clear' && done.taken === false, 'everyone passes: the bout ends beaten');

  // Taking, and the throw-in limit.
  const tk = D.take(a1);
  check(tk.phase === 'throw' && tk.turn === 0 && same(D.legalThrows(tk, 0).sort(), ids('7D').sort()), 'the defender takes: throwers may still add a matching rank');
  const capped = mk(['7S 7D 7C 7H 8S 9S', '6S 8D', '9D 9C'], { defCap: 2 });
  const c1 = D.attackCard(capped, id('7S'));
  const c2 = D.take(c1), c3 = D.attackCard(c2, id('7D'));
  check(c3.table.length === 2 && c3.phase === 'clear' && c3.taken === true, 'throw-ins stop at the cap (the defender held 2): the bout ends with a take');
  check(D.legalThrows(D.take(c1), 0).length >= 1 && D.legalThrows(c1, 0).length === 0, 'nobody adds while a card waits to be beaten');
  const firstBout = D.newGame(lcg(4), 2);
  check(firstBout.defCap === 5 && firstBout.bouts === 0, 'the first bout allows five attacks, though the defender holds six');
  check(D.newGame(lcg(5), 4).hands.every(h => h.length === 6) && D.newGame(lcg(5), 4).stock.length === 12, 'a four-player deal: six each, twelve in the stock');
  check((g6 => Z.suit(g6.stock[0]) === g6.trump && g6.stock.length === 24)(D.newGame(lcg(6), 2)), 'the trump is the suit of the bottom card');

  // Refill order and who attacks next.
  const rf = mk(['7S 8S', '6D 6S 9S TS 8H 9H', 'AS KS QS'], { table: [{ a: id('7D'), d: id('8D') }], phase: 'clear', taken: false, defCap: 6 });
  const rfIn = Object.assign({}, rf, { stock: ids('6C 7C 8C 9C TC JC QC KC') });
  const refill = D.finishBout(rfIn);
  check(refill.hands[0].length === 6 && refill.hands[2].length === 6 && refill.hands[1].length === 6, 'everyone draws up to six');
  check(refill.stock.length === 8 - 4 - 3 && refill.hands[0].includes(id('KC')) && refill.hands[2].includes(id('TC')) === false, 'the attacker draws first from the stock');
  check(refill.attacker === 1 && refill.phase === 'attack' && refill.discard.length === 2, 'a beaten bout: the defender attacks next and the cards are discarded');
  const takenBout = D.finishBout(Object.assign({}, rfIn, { taken: true, table: [{ a: id('7D'), d: null }] }));
  check(takenBout.hands[1].includes(id('7D')) && takenBout.attacker === 2, 'a taken bout: the defender holds the cards and the next player attacks');

  // The end: out of cards with an empty stock, the last holder is the durak.
  const fin = mk(['7S', '6D 6S', '8D'], { stock: [], table: [{ a: id('7S'), d: null }], phase: 'clear', taken: false });
  fin.hands[0] = []; fin.table = [{ a: id('7S'), d: id('8S') }];
  const over = D.finishBout(Object.assign({}, fin, { hands: [[], ids('6D 6S'), []] }));
  check(over.phase === 'over' && over.durak === 1 && same(over.out.sort(), [0, 2]), 'players out of cards leave; the last holder is the durak');
  const none = D.finishBout(Object.assign({}, fin, { hands: [[], [], []] }));
  check(none.phase === 'over' && none.durak === -1, 'everyone out together: nobody is the fool');

  // The computer, whole games, 2 to 4 players: every move legal, all 36 cards kept.
  [2, 3, 4].forEach(n => {
    let ended = 0, bad = 0, maxSteps = 0;
    for (let seed = 1; seed <= 15; seed++) {
      let g = D.newGame(lcg(seed * 31 + n), n), steps = 0;
      while (g.phase !== 'over' && steps++ < 3000) {
        const total = g.hands.reduce((k, h) => k + h.length, 0) + g.stock.length + g.discard.length + D.tableCards(g).length;
        if (total !== 36) { bad++; break; }
        if (g.phase === 'clear') { g = D.finishBout(g); continue; }
        const seat = g.turn, before = JSON.stringify(g.hands[seat]);
        const legal = g.phase === 'defend' ? D.legalDefences(g, seat) : D.legalThrows(g, seat);
        const nxt = D.aiStep(g);
        const played = g.hands[seat].filter(c => nxt.hands[seat].indexOf(c) < 0);
        if (played.some(c => legal.indexOf(c) < 0) || (g.phase === 'attack' && !g.table.length && played.length !== 1)) { bad++; break; }
        g = nxt;
      }
      if (g.phase === 'over') ended++;
      maxSteps = Math.max(maxSteps, steps);
    }
    check(bad === 0 && ended === 15, n + ' players: 15 games end, every play legal and all 36 cards kept (' + ended + ' ended, longest ' + maxSteps + ' steps)');
  });
}

// ── Scopa ───────────────────────────────────────────────────────────────────
{
  const S = sandbox.ZimiScopa;
  // Italian ids: suit * 10 + value - 1; suits coins 0, cups 1, swords 2, clubs 3.
  const it = (v, suit) => suit * 10 + v - 1;
  const opts = (table, card) => S.captureOptions(table, card).map(o => o.slice().sort((a, b) => a - b));
  check(S.value(it(10, 3)) === 10 && S.suitOf(it(7, 0)) === 0 && it(7, 0) === 6 && S.nameOf(it(8, 1)) === 'Jack of cups' && S.nameOf(it(9, 2)) === 'Knight of swords' && S.nameOf(it(10, 0)) === 'King of coins', 'the deck: coins, cups, swords, clubs; 8 is the Jack, 9 the Knight, 10 the King');
  check(same(opts([it(3, 1), it(4, 2)], it(3, 0)), [[it(3, 1)]]), 'a table card of equal value is taken, and only it');
  check(same(opts([it(3, 1), it(4, 2), it(7, 3)], it(7, 0)), [[it(7, 3)]]), 'equal value is forced even when a sum would also work (3 + 4 = 7)');
  const sums = opts([it(3, 1), it(4, 2), it(2, 3), it(5, 0)], it(7, 3)).map(o => o.map(c => S.value(c)).sort().join('+')).sort();
  check(same(sums, ['2+5', '3+4']), 'no equal card: every set adding to 7 (3+4 and 2+5)');
  check(S.captureOptions([it(3, 1), it(4, 2)], it(10, 0)).length === 0, 'nothing adds up: no capture, the card is placed');
  check(S.captureOptions([it(1, 1), it(2, 2), it(3, 3), it(4, 0)], it(10, 1)).some(o => o.length === 4), 'four small cards can make a ten');
  check(S.captureOptions([it(8, 1), it(2, 2)], it(10, 0)).length === 1, 'a Fante and a 2 take a Re');

  const base = (extra) => Object.assign({ deck: [], hands: [[], []], table: [], captured: [[], []], scope: [0, 0], dealer: 1, turn: 0, lastCapturer: -1, lastPlay: null, scores: [0, 0], handNo: 0, phase: 'play', result: null, moves: 0 }, extra);
  // Legality: a capture must be taken when one exists.
  const lg = base({ hands: [[it(7, 0), it(2, 1)], [it(1, 1)]], table: [it(3, 1), it(4, 2), it(9, 0)], deck: [1, 2, 3, 4, 5, 6] });
  check(S.isLegal(lg, 0, it(7, 0), [it(3, 1), it(4, 2)]) && !S.isLegal(lg, 0, it(7, 0), []) && !S.isLegal(lg, 0, it(7, 0), [it(9, 0)]), 'a card that can capture must capture, and only what adds up');
  check(S.isLegal(lg, 0, it(2, 1), []) && !S.isLegal(lg, 0, it(2, 1), [it(3, 1)]), 'a card that cannot capture is simply placed');
  check(!S.isLegal(lg, 1, it(1, 1), []), 'it is not North’s turn');

  // A scopa, and no scopa on the last play.
  let s = S.play(base({ hands: [[it(7, 0), it(2, 1)], [it(1, 1), it(5, 3)]], table: [it(3, 1), it(4, 2)], deck: [11, 12, 13, 14, 15, 16], lastCapturer: -1 }), 0, it(7, 0), [it(3, 1), it(4, 2)]);
  check(s.scope[0] === 1 && s.table.length === 0 && s.captured[0].length === 3 && s.lastCapturer === 0 && s.turn === 1, 'clearing the table is a scopa: 1 point, the turn passes');
  let last = S.play(base({ hands: [[it(7, 0)], []], table: [it(3, 1), it(4, 2)], deck: [], turn: 0 }), 0, it(7, 0), [it(3, 1), it(4, 2)]);
  check(last.scope[0] === 0 && last.phase === 'sweep', 'no scopa on the very last play');
  // Redealing from the deck, in order.
  let rd = S.play(base({ hands: [[it(7, 0)], []], table: [it(1, 1)], deck: [11, 12, 13, 14, 15, 16, 17, 18], dealer: 1, turn: 0 }), 0, it(7, 0), []);
  check(rd.hands[0].length === 3 && rd.hands[1].length === 3 && rd.deck.length === 2 && rd.turn === 0 && rd.phase === 'play', 'empty hands are dealt three each from the deck; the non-dealer plays first');
  // The last capturer takes the rest; the hand is scored.
  let fin = S.finishHand(Object.assign(S.play(base({ hands: [[it(2, 1)], []], table: [it(9, 3), it(1, 2)], deck: [], captured: [[it(7, 0)], [it(1, 0)]], lastCapturer: 1, turn: 0 }), 0, it(2, 1), []), {}));
  check(fin.captured[1].length === 1 + 3 && fin.table.length === 0 && fin.lastPlay.seat === 1 && fin.lastPlay.taken.length === 3, 'the last capturer takes what is left on the table');

  // Primiera and the scoring.
  const prim = ids2 => S.primiera(ids2);
  check(prim([it(7, 0), it(7, 1), it(7, 2), it(7, 3)]) === 84, 'four sevens: 84, the best primiera');
  check(prim([it(7, 0), it(6, 1), it(1, 2), it(5, 3)]) === 21 + 18 + 16 + 15, 'primiera counts the best card of each suit (7 21, 6 18, 1 16, 5 15)');
  check(prim([it(7, 0), it(7, 1), it(7, 2)]) === 0, 'a player without a card in every suit has no primiera');
  check(prim([it(10, 0), it(9, 1), it(8, 2), it(2, 3), it(4, 3)]) === 10 + 10 + 10 + 14, 'courts count 10, the best of a suit stands');
  const cap0 = [it(7, 0), it(1, 0), it(2, 0), it(3, 0), it(4, 0), it(5, 0), it(6, 0), it(7, 1), it(7, 2), it(7, 3), it(6, 1), it(6, 2), it(6, 3), it(5, 1), it(5, 2), it(5, 3), it(4, 1), it(4, 2), it(4, 3), it(3, 1), it(3, 2), it(3, 3), it(2, 1)];
  const cap1 = [];
  for (let c = 0; c < 40; c++) if (cap0.indexOf(c) < 0) cap1.push(c);
  const r = S.scoreHand([cap0, cap1], [2, 1]);
  check(r.points[0] === 4 + 2 && r.points[1] === 1 && r.cards[0] === 23, 'a sweep of cards, coins, settebello and primiera (4) plus 2 scope for you; 1 scope for North');
  check(S.scoreHand([cap0.slice(0, 17), cap1], [0, 0]).lines[0].endsWith('no point'), 'the cards point is not given for equal cards');
  check(S.gameWinner([11, 8]) === 0 && S.gameWinner([12, 12]) === -1 && S.gameWinner([9, 11]) === 1 && S.gameWinner([10, 10]) === -1, 'game to 11; a tie at or over 11 plays on');
  // The deal.
  const d = S.deal(order(4).filter(c => c < 40), 0, [0, 0], 1);
  check(d.hands.every(h => h.length === 3) && d.table.length === 4 && d.deck.length === 40 - 10 && new Set([].concat(d.hands[0], d.hands[1], d.table, d.deck)).size === 40, 'the deal: three each, four on the table, thirty in the deck, all forty distinct');
  let kings = 0;
  for (let seed = 1; seed <= 200; seed++) { const x = S.deal(order(seed).filter(c => c < 40), 0, [0, 0], 1); if (x.table.filter(c => S.value(c) === 10).length >= 3) kings++; }
  check(kings === 0, 'three kings on the table are dealt again');
  // The Italian deck is drawn: forty distinct faces, none NaN.
  const faces = new Set();
  for (let c = 0; c < 40; c++) { const f = S.face(c, false); faces.add(f); if (/NaN|undefined/.test(f) || !/<svg/.test(f)) faces.add('bad'); }
  check(faces.size === 40 && /xmlns/.test(S.face(0, true)), 'forty distinct faces drawn, the standalone one carries its own body');

  // The computer plays whole hands and games, every play legal.
  let games = 0, bad = 0, hands = 0;
  for (let seed = 1; seed <= 20; seed++) {
    let st = S.newGame(order(seed * 31).filter(c => c < 40), seed % 2), guard = 0;
    while (st.phase !== 'over' && guard++ < 60) {
      let steps = 0;
      while (st.phase === 'play' && steps++ < 60) {
        const mv = S.aiMove(st, st.turn);
        if (!S.isLegal(st, st.turn, mv.id, mv.set)) { bad++; break; }
        st = S.play(st, st.turn, mv.id, mv.set);
      }
      if (st.phase === 'sweep') st = S.finishHand(st);
      hands++;
      if (st.phase === 'handEnd') st = S.nextHand(st, order(seed * 1000 + guard).filter(c => c < 40));
    }
    if (st.phase === 'over' && S.gameWinner(st.scores) >= 0) games++;
  }
  check(bad === 0 && games === 20, 'twenty simulated games reach 11, every play legal (' + hands + ' hands, ' + bad + ' illegal)');
}

// ── END ─────────────────────────────────────────────────────────────────────
console.log('\n' + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
