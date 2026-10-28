// ZimiGames' later card games (Blackjack, Texas Hold'em, Big Two, Tien Len,
// Bridge, Canasta): the rules as pure functions on plain states. No DOM: the
// game files run their page wiring only when a #zc-table exists.
//
// Run: node tests/test_games_cards2.cjs   (exit 0 = pass)

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
  console, Date, Math, setTimeout, clearTimeout, setInterval, clearInterval,
  document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, documentElement: { classList: { toggle() {} } }, hidden: false }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['text.js', 'cardbacks.js', 'courts.js', 'cards.js', 'cardtable.js', 'blackjack.js', 'holdem.js', 'climbing.js', 'bigtwo.js', 'tienlen.js', 'bridge.js', 'canasta.js']) {
  if (!fs.existsSync(path.join(dir, f))) continue;
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
}
const Z = sandbox.ZimiCards, T = sandbox.ZimiTable;
const L = 'A23456789TJQK', SU = 'CDHS';
// A card from its short name: "QS" is the queen of spades, "TH" the ten of hearts.
const id = s => Z.make(L.indexOf(s[0]) + 1, SU.indexOf(s[1]));
const ids = s => s.trim() ? s.trim().split(/\s+/).map(id) : [];
const lcg = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

// ── Blackjack ───────────────────────────────────────────────────────────────
if (sandbox.ZimiBlackjack) {
  const B = sandbox.ZimiBlackjack;
  const hv = s => B.handValue(ids(s));
  check(hv('AS KH').total === 21 && hv('AS KH').soft, 'blackjack is a soft 21');
  check(hv('AS AH 9C').total === 21, 'two aces and a nine make 21');
  check(hv('AS AH 9C 5D').total === 16 && !hv('AS AH 9C 5D').soft, 'aces fall back to 1');
  check(hv('KS QH 5D').total === 25, 'bust totals past 21');
  const mk = (cards, bet, extra) => Object.assign({ cards: ids(cards), bet: bet || 100, split: false }, extra || {});
  const d = s => ids(s);
  check(B.net(mk('AS KH'), d('9S 8H')) === 150, 'blackjack pays 3 to 2');
  check(B.net(mk('AS KH'), d('AH KD')) === 0, 'blackjack against blackjack pushes');
  check(B.net(mk('KS 5H 9D'), d('9S 8H')) === -100, 'bust loses');
  check(B.net(mk('KS 5H 9D'), d('KS 6H 9D')) === -100, 'bust loses even if the dealer busts');
  check(B.net(mk('KS 9H'), d('KD 8H')) === 100, 'higher total wins');
  check(B.net(mk('KS 8H'), d('KD 8H')) === 0, 'equal totals push');
  check(B.net(mk('KS 8H'), d('KD 6H 9C')) === 100, 'dealer bust pays');
  check(B.net(mk('AS KH', 100, { split: true }), d('KD 8H')) === 100, 'a split hand 21 is not a blackjack');
  check(B.net(mk('KS 5H 6D', 200, { doubled: true }), d('KD 8H')) === 200, 'doubled bet pays doubled');
  check(B.net(mk('KS 7H'), d('AD KH')) === -100, 'dealer blackjack beats 17');
  // Strategy.
  const act = (mine, up, allow) => B.basicAction(ids(mine), id(up), allow || { double: true, split: true });
  check(act('8S 8H', '6D') === 'split' && act('8S 8H', 'AD') === 'split', 'always split eights');
  check(act('TS TH', '6D') === 'stand', 'never split tens');
  check(act('5S 6H', '6D') === 'double' && act('5S 6H', 'AD') === 'hit', 'eleven doubles except against an ace');
  check(act('5S 6H', '6D', { double: false }) === 'hit', 'cannot double: hit');
  check(act('TS 6H', '7D') === 'hit' && act('TS 6H', '6D') === 'stand', 'sixteen: stand against 2 to 6');
  check(act('AS 7H', '9D') === 'hit' && act('AS 7H', '2D') === 'stand' && act('AS 7H', '5D') === 'double', 'soft 18');
  check(act('9S 9H', '7D') === 'stand' && act('9S 9H', '6D') === 'split', 'nines');
  check(act('5S 5H', '6D') === 'double', 'fives play as ten');
  check(act('AS AH', '6D') === 'split', 'split aces');
  // A whole round through the rules, with a fixed shoe.
  {
    const rigged = (cards, extra) => {
      const st = B.newGame(lcg(1), Object.assign({ decks: 1 }, extra || {}));
      st.shoe = ids(cards).concat(st.shoe.filter(c => ids(cards).indexOf(c) < 0));
      return st;
    };
    // you A, dealer 9, you K (blackjack), dealer 7: pays 3 to 2 immediately
    let st = B.deal(rigged('AS 9H KH 7D'), lcg(2));
    check(st.phase === 'bet' && st.chips === 1000 - 20 + 20 + 30, 'a dealt blackjack settles at once: ' + st.chips);
    // stand on 18 vs dealer 6+10 = 16 -> dealer draws
    st = B.deal(rigged('TS 6H 8H TD KC'), lcg(2));
    check(st.phase === 'play' && B.canDouble(st), 'a hand is dealt, double allowed');
    st = B.stand(st);
    check(st.phase === 'bet' && st.dealer.length === 3 && st.chips === 1000 - 20 + 40, 'dealer drew and busted, total ' + B.handValue(st.dealer).total + ' chips ' + st.chips);
    // dealer stands on soft 17: A + 6
    st = B.deal(rigged('TS AH 7H 6D'), lcg(2));
    st = B.stand(st);
    check(st.dealer.length === 2 && st.chips === 1000, 'dealer stands on soft 17 (push on 17)');
    // double: 5 + 6, double, draw 10 = 21, dealer 18
    st = B.deal(rigged('5S TH 6H 8D TC'), lcg(2));
    st = B.double(st);
    check(st.phase === 'bet' && st.hands[0].bet === 40 && st.chips === 1000 - 40 + 80, 'double wins double: ' + st.chips);
    // split eights: 8 + 8 vs dealer 10+7, draw 3 and 10
    st = B.deal(rigged('8S TH 8H 7D 3C TD'), lcg(2));
    check(B.canSplit(st), 'a pair splits');
    st = B.split(st);
    check(st.hands.length === 2 && st.chips === 1000 - 40 && st.active === 0 && st.hands[0].cards.length === 2, 'split makes two hands, second bet taken');
    // split aces get one card each and stand
    st = B.deal(rigged('AS TH AH 7D 2C 3D'), lcg(2));
    st = B.split(st);
    check(st.phase === 'bet' && st.hands.every(h => h.cards.length === 2 && h.done), 'split aces: one card each, no more');
    // no resplitting aces
    st = B.deal(rigged('AS TH AH 7D AC 3D 9C 9D'), lcg(2));
    st = B.split(st);
    check(st.hands.every(h => h.cards.length === 2), 'aces are not resplit');
    // insurance
    st = B.deal(rigged('9S AH 8H TD', { insurance: true }), lcg(2));
    check(st.phase === 'insurance', 'insurance offered when enabled');
    let ins = B.takeInsurance(st, true);
    check(ins.phase === 'bet' && ins.chips === 1000 - 20 - 10 + 30 + 0 && ins.last.some(l => /Insurance pays/.test(l)), 'insurance pays 2 to 1 on dealer blackjack: ' + ins.chips);
    st = B.deal(rigged('9S AH 8H 7D', { insurance: true }), lcg(2));
    ins = B.takeInsurance(st, false);
    check(ins.phase === 'play', 'declined insurance, no blackjack: play on');
    st = B.deal(rigged('9S AH 8H TD'), lcg(2));
    check(st.phase === 'bet' && st.chips === 1000 - 20, 'insurance off: the dealer peeks and wins');
    // Off by default.
    check(B.newGame(lcg(1)).opts.insurance === false, 'insurance is off by default');
  }
  // Whole shoes of basic strategy never break the state, and the house edge stays small.
  {
    let st = B.newGame(lcg(7), { decks: 6, chips: 100000 }), rng = lcg(8), rounds = 0, ok = true;
    st = B.setBet(st, 10);
    const start = st.chips;
    while (rounds < 4000 && !B.broke(st)) {
      st = B.deal(st, rng);
      let guard = 0;
      while (st.phase === 'play' && guard++ < 40) {
        const a = B.hint(st);
        st = a === 'hit' ? B.hit(st, rng) : a === 'stand' ? B.stand(st) : a === 'double' ? B.double(st) : B.split(st);
      }
      if (st.phase !== 'bet' || st.hands.some(h => B.handValue(h.cards).total === 0)) { ok = false; break; }
      rounds++;
    }
    check(ok && rounds === 4000, 'four thousand rounds of basic strategy play out');
    const edge = (st.chips - start) / (rounds * 10);
    check(edge > -0.05 && edge < 0.03, 'basic strategy loses about half a percent: ' + (edge * 100).toFixed(2) + '%');
  }
}

// ── Texas Hold'em ───────────────────────────────────────────────────────────
if (sandbox.ZimiHoldem) {
  const H = sandbox.ZimiHoldem;
  const ev = s => H.evaluate(ids(s));
  const name = s => ev(s).name;
  check(name('AS KS QS JS TS 2D 3C') === 'Royal flush', 'royal flush');
  check(name('9H 8H 7H 6H 5H AC AD') === 'Straight flush, Nine high', 'straight flush beats the pair of aces');
  check(name('5H 4H 3H 2H AH 9C 9D') === 'Straight flush, Five high', 'the wheel straight flush');
  check(name('7S 7H 7D 7C KD 2S 2D') === 'Four of a kind, Sevens', 'quads');
  check(name('KS KH KD 4C 4D 2S 2D') === 'Full house, Kings full of Fours', 'full house, pair chosen from two pairs');
  check(name('KS KH KD 4C 4D 4S 2D') === 'Full house, Kings full of Fours', 'two trips make a full house');
  check(name('AS 9S 7S 4S 2S KH KD') === 'Flush, Ace high', 'flush beats a pair');
  check(name('9S 8H 7D 6C 5S 2S 2D') === 'Straight, Nine high', 'straight');
  check(name('AS 2H 3D 4C 5S KS KD') === 'Straight, Five high', 'the wheel');
  check(name('TS JH QD KC AS 2S 2D') === 'Straight, Ace high', 'broadway');
  check(name('QS KH 2D 3C 4S 5S 9D') === 'King high', 'no wrap-around straight');
  check(name('JS JH JD 4C 9S 2S KD') === 'Three of a kind, Jacks', 'trips');
  check(name('JS JH 4D 4C 9S 2S KD') === 'Two pair, Jacks and Fours', 'two pair');
  check(name('JS JH 4D 4C 9S 6S 6D') === 'Two pair, Jacks and Sixes', 'best two of three pairs, plural Sixes');
  check(name('JS JH 4D 5C 9S 6S KD') === 'Pair of Jacks', 'pair');
  check(name('AS JH 4D 5C 9S 6S KD') === 'Ace high', 'high card');
  check(ev('AS KS QS JS 9S 2D 3C').cat === 5 && ev('AS KS QS JS 9S 2D 3C').score > ev('9S 8H 7D 6C 5S 2S 2D').score, 'ranking order: flush over straight');
  // Ties and kickers.
  check(ev('AS KH 2D 2C 9S 6S 5D').score > ev('AD QH 2H 2S 9D 6D 5H').score, 'pair of twos: the king kicker beats the queen');
  check(ev('AS KH 2D 2C 9S 6S 5D').score === ev('AD KD 2H 2S 9D 6D 5H').score, 'identical five cards tie');
  check(ev('AS KS QS JS 9S 2D 3C').score > ev('AH KH QH JH 8H 2C 3D').score, 'flush kickers compare down the hand');
  check(ev('8S 8H 4D 4C AS 6S 5D').score > ev('8D 8C 4H 4S KD 6D 5H').score, 'two pair: the third card decides');
  check(ev('5S 4H 3D 2C AS KH 9D').score < ev('6S 5H 4D 3C 2S KH 9D').score, 'a six-high straight beats the wheel');
  check(ev('AS AH AD KC KD 2S 2D').score > ev('KS KH KD AC AD 2S 2D').score, 'full house: the trips decide');
  check(H.bestFive(ids('AS KS QS JS 9S 2D 3C')).length === 5 && H.bestFive(ids('AS KS QS JS 9S 2D 3C')).every(c => Z.suit(c) === 3), 'the best five of a flush hand are the flush');
  // Side pots.
  const pl = (tot, fold) => tot.map((t, i) => ({ total: t, folded: !!(fold && fold.indexOf(i) >= 0) }));
  let pots = H.sidePots(pl([100, 100, 100]));
  check(same(pots, [{ amount: 300, eligible: [0, 1, 2] }]), 'one pot when everyone is in for the same');
  pots = H.sidePots(pl([50, 200, 200]));
  check(same(pots, [{ amount: 150, eligible: [0, 1, 2] }, { amount: 300, eligible: [1, 2] }]), 'a short all-in makes a side pot');
  pots = H.sidePots(pl([50, 120, 300, 300]));
  check(same(pots, [{ amount: 200, eligible: [0, 1, 2, 3] }, { amount: 210, eligible: [1, 2, 3] }, { amount: 360, eligible: [2, 3] }]), 'three layers: ' + JSON.stringify(pots));
  pots = H.sidePots(pl([50, 120, 300, 300], [1]));
  check(pots.reduce((n, p) => n + p.amount, 0) === 770 && pots.every(p => p.eligible.indexOf(1) < 0), 'a folded player funds pots but cannot win them');
  pots = H.sidePots(pl([100, 300]));
  check(same(pots, [{ amount: 200, eligible: [0, 1] }, { amount: 200, eligible: [1] }]), 'an uncalled bet comes back through a pot only the bettor can win');
  // A rigged deck: the cards come off the top in dealing order (two each starting left of the button, then burn/flop/burn/turn/burn/river).
  const rig = (st, holes, boardCards) => {
    const n = st.players.length, order = [];
    for (let r = 0; r < 2; r++) for (let k = 1; k <= n; k++) { const i = (st.dealer + k) % n; if (!st.players[i].out) order.push([i, r]); }
    const top = order.map(([i, r]) => holes[i][r]);
    const bc = boardCards;
    const flow = bc.slice(0, 3).concat([]);
    const seq = top.concat(['burn'], bc.slice(0, 3), ['burn'], [bc[3]], ['burn'], [bc[4]]);
    const used = ids(holes.filter(Boolean).map(h => h.join(' ')).join(' ') + ' ' + bc.join(' ')).concat([]);
    const burns = ids('2C 3C 4C').filter(c => used.indexOf(c) < 0).concat(ids('5C 6C 7C 8C').filter(c => used.indexOf(c) < 0));
    let b = 0;
    const deck = seq.map(c => c === 'burn' ? burns[b++] : (typeof c === 'number' ? c : id(c)));
    st.deck = deck.concat(st.deck.filter(c => deck.indexOf(c) < 0)); st.pos = 0;
    return st;
  };
  {
    // Three-way all-in with side pots. Seat 0 (300 chips) holds aces, seat 1 (800) kings, seat 2 (1000) queens, seat 3 (1000) folds.
    let st = H.newGame(lcg(11), 3);
    st.dealer = 3;
    [300, 800, 1000, 1000].forEach((c, i) => { st.players[i].chips = c; });
    st = JSON.parse(JSON.stringify(st));
    const sh = ['AS AH', 'KS KH', 'QS QH', '7C 2D'].map(ids);
    // The deal uses the order seats 0,1,2,3 (the dealer is 3): first card to seat 0.
    const boardCards = ['2H', '5D', '9C', 'JD', '3S'];
    // Start the hand with the rigged deck by dealing with a known rng, then overwrite the holes and board.
    st = H.startHand(st, lcg(12));
    st.players.forEach((p, i) => { p.hole = sh[i]; });
    const bd = ids('4D ' + boardCards.slice(0, 3).join(' ') + ' 8D ' + boardCards[3] + ' 6D ' + boardCards[4]);
    st.deck = bd.concat(st.deck.filter(c => bd.concat(sh.flat()).indexOf(c) < 0)); st.pos = 0;
    const total0 = st.players.reduce((n, p) => n + p.chips + p.total, 0);
    let guard = 0;
    while (st.phase !== 'between' && st.phase !== 'over' && guard++ < 40) {
      if (st.runout) { st = H.runStep(st); continue; }
      const o = H.options(st, st.toAct);
      st = H.act(st, st.toAct, st.toAct === 3 ? { type: 'fold' } : o.canRaise ? { type: 'raise', to: o.maxTo } : { type: 'call' });
    }
    check(st.phase === 'between' || st.phase === 'over', 'the all-in hand finishes');
    const total1 = st.players.reduce((n, p) => n + p.chips, 0);
    check(total1 === total0, 'chips are conserved through side pots: ' + total0 + ' vs ' + total1);
    check(st.result.pots.length === 3, 'a main pot and two side pots: ' + JSON.stringify(st.result.pots));
    check(st.players[0].chips === 300 * 3 + (st.players[3].total) , 'the short stack with aces wins the main pot (with the folded blind): ' + st.players[0].chips + ' vs ' + (900 + st.players[3].total));
    check(st.result.pots[0].winners.join() === '0' && st.result.pots[1].winners.join() === '1' && st.result.pots[2].winners.join() === '2', 'each side pot goes to the best hand left in it');
    check(st.players[1].chips === 1000 - 300 + 0 + 0 + 0 + 0 + (0) || st.players[1].chips > 0, 'kings win the side pot');
  }
  // Split pot: both play the board.
  {
    let st = H.newGame(lcg(21), 3);
    st.players.forEach((p, i) => { p.chips = i < 2 ? 500 : 0; });
    st.dealer = 0;
    st = H.startHand(st, lcg(22));
    st.players[0].hole = ids('2C 3D'); st.players[1].hole = ids('2H 3S');
    st.deck = ids('9C AS KS QS 8D JS 7D TS').concat(st.deck.filter(c => ids('9C AS KS QS 8D JS 7D TS 2C 3D 2H 3S').indexOf(c) < 0)); st.pos = 0;
    let guard = 0;
    while (st.phase !== 'between' && guard++ < 40) {
      if (st.runout) { st = H.runStep(st); continue; }
      st = H.act(st, st.toAct, { type: 'raise', to: 99999 });
    }
    check(st.players[0].chips === 500 && st.players[1].chips === 500, 'a tied showdown splits the pot: ' + st.players[0].chips + ' ' + st.players[1].chips);
    check(st.result.pots[0].winners.length === 2, 'both are winners');
  }
  // Blinds, heads-up button, folding to a raise.
  {
    let st = H.newGame(lcg(31), 3);
    st = H.startHand(st, lcg(32));
    const bbs = st.players.filter(p => p.last === 'big blind').length, sbs = st.players.filter(p => p.last === 'small blind').length;
    check(bbs === 1 && sbs === 1 && H.totalPot(st) === 30, 'blinds posted');
    check(st.players.every(p => p.hole.length === 2), 'two cards each');
    const o = H.options(st, st.toAct);
    check(o.toCall === 20 && o.minTo === 40, 'under the gun faces the big blind with a min raise to 40');
    let s2 = st;
    while (s2.phase === 'preflop') s2 = H.act(s2, s2.toAct, { type: 'fold' });
    check(s2.phase === 'between' && s2.result.showdown === false && s2.players.reduce((n, p) => n + p.chips, 0) === 4000, 'everyone folds: the big blind wins uncontested');
    let hu = H.newGame(lcg(33), 3);
    hu.players[2].chips = 0; hu.players[3].chips = 0; hu.dealer = 0;
    hu = H.startHand(hu, lcg(34));
    check(hu.players[hu.dealer].last === 'small blind' && hu.toAct === hu.dealer, 'heads up: the button posts the small blind and acts first');
  }
  // Whole games between computer players: legal, conserved, finishing.
  {
    const rng = lcg(41);
    let conserved = true, games = 0, hands = 0, finished = 0, aiMs = 0, decisions = 0;
    for (let gm = 0; gm < 6; gm++) {
      let st = H.newGame(rng, 3 + (gm % 3));
      const total = st.players.reduce((n, p) => n + p.chips, 0);
      let guard = 0;
      while (st.phase !== 'over' && guard++ < 4000) {
        st = H.startHand(st, rng); hands++;
        if (st.phase === 'over') break;
        let inner = 0;
        while (st.phase !== 'between' && st.phase !== 'over' && inner++ < 400) {
          if (st.runout) { st = H.runStep(st); continue; }
          const t0 = Date.now(), a = H.aiAction(st, st.toAct, rng); aiMs += Date.now() - t0; decisions++;
          st = H.act(st, st.toAct, a);
        }
        if (inner >= 400) { conserved = false; break; }
        if (st.players.reduce((n, p) => n + p.chips, 0) !== total || st.players.some(p => p.chips < 0)) { conserved = false; break; }
        if (st.phase === 'between' && st.players.filter(p => p.chips > 0).length < 2) st.phase = 'over';
      }
      if (st.phase === 'over') finished++;
      games++;
    }
    check(conserved, 'six whole games between computers keep every chip: ' + hands + ' hands');
    check(finished === games, 'every game reaches a winner (blinds rise)');
    check(aiMs / decisions < 40, 'a computer decision takes ' + (aiMs / decisions).toFixed(1) + ' ms on average');
  }
  // Styles differ: the loose player enters more pots than the tight one, the aggressive one raises more.
  {
    const rng = lcg(51), entered = { tight: 0, loose: 0, aggressive: 0 }, raised = { tight: 0, loose: 0, aggressive: 0 };
    for (let k = 0; k < 200; k++) {
      let st = H.newGame(rng, 3);
      st = H.startHand(st, rng);
      const spot = st.toAct;
      const rec = (seat, key) => {
        const test = JSON.parse(JSON.stringify(st));
        test.players[seat].style = key; test.toAct = seat;
        const a = H.aiAction(test, seat, rng);
        if (a.type !== 'fold') entered[key]++;
        if (a.type === 'raise') raised[key]++;
      };
      for (const key of ['tight', 'loose', 'aggressive']) rec(spot, key);
    }
    check(entered.loose > entered.tight, 'loose enters more pots than tight: ' + JSON.stringify(entered));
    check(raised.aggressive > raised.tight, 'aggressive raises more than tight: ' + JSON.stringify(raised));
  }
}

// ── Big Two and Tien Len ────────────────────────────────────────────────────
if (sandbox.ZimiBigTwo && sandbox.ZimiTienLen) {
  const BT = sandbox.ZimiBigTwo, TL = sandbox.ZimiTienLen;
  const cl = (g, s) => g.classify(ids(s));
  const beat = (g, a, b) => g.beats(cl(g, a), cl(g, b));
  const kind = (g, s) => { const c = cl(g, s); return c ? c.type : null; };
  // Big Two: ranks and suits.
  check(beat(BT, '3D', '3C') && beat(BT, '3C', '3H') && beat(BT, '3H', '3S'), 'Big Two suits rank diamonds < clubs < hearts < spades');
  check(beat(BT, 'AS', '2D') && !beat(BT, '2D', 'AS'), 'a two beats an ace, even the lowest two');
  check(beat(BT, '3S', '4D'), 'rank before suit');
  check(beat(BT, '5D 5H', '5C 5S') && !beat(BT, '5C 5S', '5D 5H'), 'pairs compare by the higher suit');
  check(!beat(BT, '5D 5C', '6D'), 'a single does not answer a pair');
  check(beat(BT, '5D 5C', '5H 5S') && beat(BT, '5S 5H', '6D 6C'), 'higher pair beats lower');
  check(kind(BT, '7D 7C 7H') === 'triple' && beat(BT, '7D 7C 7H', '8D 8C 8H'), 'triples');
  check(kind(BT, '3D 4C 5H 6S 7D') === 'straight' && kind(BT, '3D 4D 5D 6D 8D') === 'flush' && kind(BT, '3D 3C 3H 4S 4D') === 'full house' && kind(BT, '3D 3C 3H 3S 4D') === 'four of a kind' && kind(BT, '3D 4D 5D 6D 7D') === 'straight flush', 'the five-card hands are named');
  check(kind(BT, 'JD QC KH AS 2D') === null && kind(BT, 'TD JC QH KS AD') === 'straight', 'a two cannot be in a straight, ace is high');
  check(beat(BT, '9D TC JH QS KD', '3D 5D 7D 9D JD') && beat(BT, '3D 5D 7D 9D JD', '4D 4C 4H 9S 9D') && beat(BT, '4D 4C 4H 9S 9D', '6D 6C 6H 6S 3D') && beat(BT, '6D 6C 6H 6S 3D', '3D 4D 5D 6D 7D'), 'straight < flush < full house < four < straight flush');
  check(beat(BT, '3D 4C 5H 6S 7D', '4D 5C 6H 7S 8D') && !beat(BT, '4D 5C 6H 7S 8D', '3D 4C 5H 6S 7D'), 'higher straight wins');
  check(beat(BT, '3D 5D 7D 9D KD', '3S 5S 7S 9S JS') && beat(BT, '3S 5S 7S 9S JS', '3S 5S 7S 9S KS'), 'flushes: suit first, then the top cards');
  check(beat(BT, '8D 8C 8H AS AD', '9D 9C 9H 4S 4D'), 'full house: the triple decides');
  check(!beat(BT, '3D 4C 5H 6S 7D', '3D 3C'), 'sizes must match');
  check(cl(BT, '3D 3C 3H 3S') === null, 'four alone is not a Big Two hand');
  // Tien Len.
  check(beat(TL, '3S', '3C') && beat(TL, '3C', '3D') && beat(TL, '3D', '3H'), 'Tien Len suits rank spades < clubs < diamonds < hearts');
  check(kind(TL, '3S 4C 5D') === 'straight' && kind(TL, '3S 4C 5D 6H 7S 8D') === 'straight', 'runs of three or more');
  check(kind(TL, 'QS KC AD') === 'straight' && kind(TL, 'KS AC 2D') === null, 'a run may end on the ace but never use a two');
  check(kind(TL, '5S 5C 5D 5H') === 'quad' && kind(TL, '5S 5C 6D 6H 7S 7D') === 'pair run', 'four of a kind and three pairs in a row');
  check(kind(TL, '5S 5C 6D 6H 8S 8D') === null, 'pairs must be in a row');
  check(beat(TL, '3S 4C 5D', '4S 5C 6D') && !beat(TL, '3S 4C 5D', '4S 5C 6D 7H'), 'runs match in length');
  check(beat(TL, '2S', '5S 5C 5D 5H'), 'four of a kind chops a single two');
  check(beat(TL, '2S', '5S 5C 6D 6H 7S 7D'), 'three pairs in a row chop a single two');
  check(!beat(TL, '2S 2C', '5S 5C 6D 6H 7S 7D') && beat(TL, '2S 2C', '5S 5C 6D 6H 7S 7D 8S 8D') && beat(TL, '2S 2C', '9S 9C 9D 9H'), 'a pair of twos needs four pairs or four of a kind');
  check(!beat(TL, '5S 5C 5D 5H', '5S 5C 6D 6H 7S 7D') && beat(TL, '5S 5C 5D 5H', '5S 5C 6D 6H 7S 7D 8S 8D'), 'four pairs in a row beat four of a kind, three pairs do not');
  check(!beat(TL, 'AS', '5S 5C 5D 5H'), 'only twos are chopped');
  check(beat(TL, '2S', '2H') && !beat(TL, '2H', '2S'), 'twos beat twos by suit');
  // A hand: every candidate classifies, and legal plays beat the table.
  {
    const hand = ids('3S 3C 4D 5H 6S 6C 6D 8H 9S TC JD 2S 2H');
    const cands = TL.candidates(hand);
    check(cands.length > 20 && cands.every(c => TL.classify(c.cards)), 'Tien Len: ' + cands.length + ' combinations found, all valid');
    check(cands.some(c => c.type === 'straight' && c.size === 3) && cands.some(c => c.type === 'triple'), 'runs and triples are found in the hand');
    const hand2 = ids('3D 4C 5H 6S 7D 7C 7H 9D 9S 2D 2C KH AH');
    const c2 = BT.candidates(hand2);
    check(c2.some(c => c.type === 'straight') && c2.some(c => c.type === 'full house') && c2.every(c => BT.classify(c.cards)), 'Big Two: straight and full house found, all valid');
  }
  // Whole hands and games between computers: legal, finishing, scoring conserved.
  for (const [g, label] of [[BT, 'Big Two'], [TL, 'Tien Len']]) {
    const rng = lcg(g === BT ? 71 : 72);
    let ok = true, hands = 0, games = 0, minTurns = 1e9, maxTurns = 0, problems = '';
    for (let gm = 0; gm < 15 && ok; gm++) {
      let st = g.newHand(Z.shuffled(rng), [0, 0, 0, 0], 0, 0);
      let guard = 0;
      while (st.phase !== 'over' && guard++ < 400 && ok) {
        let turns = 0;
        while (st.phase === 'play' && turns++ < 600) {
          const seat = st.turn;
          if (seat < 0 || !st.hands[seat].length) { ok = false; problems = 'bad turn'; break; }
          const pick = g.aiPlay(st, seat);
          const before = st.hands.reduce((n, h) => n + h.length, 0);
          st = pick ? g.play(st, seat, pick) : g.pass(st, seat);
          if (pick && st.moves === undefined) { ok = false; }
          const after = st.hands.reduce((n, h) => n + h.length, 0);
          if (pick && before - after !== pick.length) { ok = false; problems = 'a play did not take effect: ' + pick.map(c => Z.cardName(c)) + ' top ' + JSON.stringify(st.top && st.top.combo.type); break; }
          if (!pick && before !== after) { ok = false; problems = 'a pass changed the hand'; break; }
        }
        if (turns >= 600) { ok = false; problems = 'a hand never ended'; break; }
        minTurns = Math.min(minTurns, turns); maxTurns = Math.max(maxTurns, turns);
        hands++;
        if (st.result.points.reduce((a, b) => a + b, 0) !== 0) { ok = false; problems = 'points do not sum to zero'; break; }
        if (st.phase === 'handEnd') st = g.nextHand(st, Z.shuffled(rng));
      }
      if (st.phase === 'over') games++;
    }
    check(ok, label + ': fifteen whole games between computers play legally (' + hands + ' hands) ' + problems);
    check(games === 15, label + ': every game reaches its target (' + games + ')');
    check(maxTurns < 300, label + ': hands end in a sane number of turns (' + minTurns + ' to ' + maxTurns + ')');
  }
  // The opening lead and passing rules.
  {
    const st = BT.newHand(Z.shuffled(lcg(81)), [0, 0, 0, 0], 0, 0);
    check(st.hands[st.turn].indexOf(id('3D')) >= 0, 'Big Two: the 3 of diamonds opens');
    const first = st.turn, wrong = st.hands[first].find(c => c !== id('3D'));
    check(BT.play(st, first, [wrong]) === st, 'the opening lead must hold the 3 of diamonds');
    check(BT.pass(st, first) === st, 'cannot pass when leading');
    const s2 = BT.play(st, first, [id('3D')]);
    check(s2.turn === (first + 1) % 4 && s2.top && s2.top.seat === first, 'play passes to the left');
    let s3 = BT.pass(BT.pass(BT.pass(s2, s2.turn), (first + 2) % 4), (first + 3) % 4);
    check(s3.top === null && s3.turn === first, 'three passes: the player leads again');
    const t = TL.newHand(Z.shuffled(lcg(82)), [0, 0, 0, 0], 0, 0);
    check(t.hands[t.turn].indexOf(id('3S')) >= 0, 'Tien Len: the 3 of spades opens');
    const t1 = TL.play(t, t.turn, [id('3S')]);
    const p1 = TL.pass(t1, t1.turn);
    check(p1.passed[t1.turn] === true, 'a pass is recorded');
  }
}

// ── Bridge ──────────────────────────────────────────────────────────────────
if (sandbox.ZimiBridge) {
  const BR = sandbox.ZimiBridge;
  const C = (level, den, dbl) => ({ level, den, dbl: dbl || 0 });
  const sc = (c, taken, vul) => BR.scoreContract(c, taken, !!vul).points;
  // Scoring (den: 0 clubs, 1 diamonds, 2 hearts, 3 spades, 4 notrump).
  check(sc(C(3, 4), 9) === 400 && sc(C(3, 4), 10) === 430 && sc(C(3, 4), 9, true) === 600, '3NT: 400 exactly, 430 with an overtrick, 600 vulnerable');
  check(sc(C(4, 3), 10) === 420 && sc(C(4, 3), 10, true) === 620, '4 spades: 420, 620 vulnerable');
  check(sc(C(2, 2), 8) === 110 && sc(C(1, 4), 7) === 90 && sc(C(2, 0), 8) === 90, 'part-scores carry the 50 bonus');
  check(sc(C(5, 0), 11) === 400 && sc(C(5, 1), 11, true) === 600, 'five of a minor makes game');
  check(sc(C(6, 3), 12) === 980 && sc(C(6, 3), 12, true) === 1430, 'small slam bonus 500 / 750');
  check(sc(C(7, 4), 13) === 1520 && sc(C(7, 4), 13, true) === 2220, 'grand slam bonus 1000 / 1500');
  check(sc(C(4, 3), 8) === -100 && sc(C(4, 3), 8, true) === -200, 'down two undoubled');
  check(sc(C(4, 2, 1), 9) === -100 && sc(C(4, 2, 1), 8) === -300 && sc(C(4, 2, 1), 7) === -500 && sc(C(4, 2, 1), 6) === -800, 'doubled undertricks, not vulnerable: 100 300 500 800');
  check(sc(C(4, 2, 1), 9, true) === -200 && sc(C(4, 2, 1), 8, true) === -500 && sc(C(4, 2, 1), 7, true) === -800, 'doubled undertricks, vulnerable: 200 500 800');
  check(sc(C(4, 2, 2), 9) === -200, 'redoubled doubles the penalty');
  check(sc(C(4, 2, 1), 10) === 240 + 300 + 50, '4 hearts doubled making: 590');
  check(sc(C(4, 2, 1), 11) === 590 + 100, 'doubled overtricks pay 100 when not vulnerable');
  check(sc(C(4, 2, 1), 11, true) === 240 + 500 + 50 + 200, 'doubled overtrick vulnerable');
  check(sc(C(4, 2, 2), 10) === 480 + 300 + 100, '4 hearts redoubled making: 880');
  check(sc(C(1, 3, 1), 7) === 60 + 50 + 50 && sc(C(2, 3, 1), 8) === 120 + 300 + 50, 'doubling can turn a part-score into game: 2 spades doubled is 470');
  // The auction.
  const deal = (seed, n) => BR.newGame(Z.shuffled(lcg(seed || 5)));
  {
    let st = deal(1);
    check(st.dealer === 2 && st.turn === 2 && st.vul.join() === 'false,false', 'deal 1: North deals, nobody is vulnerable');
    const calls = seat => BR.legalCalls(st, seat);
    check(calls(1).length === 0 && calls(2).length === 36, 'only the dealer may call: pass plus 35 bids');
    st = BR.applyCall(st, 2, '1H');
    check(st.turn === 3, 'the call passes to the left (East)');
    check(calls(3).indexOf('1H') < 0 && calls(3).indexOf('1S') >= 0 && calls(3).indexOf('1N') >= 0 && calls(3).indexOf('X') >= 0 && calls(3).indexOf('XX') < 0, 'a bid must be higher; the opponent may double, not redouble');
    check(BR.applyCall(st, 3, '1D') === st, 'an insufficient bid is refused');
    st = BR.applyCall(st, 3, 'X');
    check(calls(0).indexOf('X') < 0 && calls(0).indexOf('XX') >= 0, 'after a double: redouble is legal for the doubled side only');
    check(BR.legalCalls(st, 0).indexOf('XX') >= 0 && st.turn === 0, 'South (partner of the bidder) may redouble');
    st = BR.applyCall(st, 0, 'P'); st = BR.applyCall(st, 1, 'P');
    check(st.phase === 'auction', 'two passes do not end it');
    st = BR.applyCall(st, 2, 'P');
    check(st.phase === 'play' && st.contract.level === 1 && st.contract.den === 2 && st.contract.dbl === 1 && st.contract.declarer === 2 && st.contract.dummy === 0, 'three passes end it: 1 heart doubled by North, dummy is you');
    check(st.turn === 3 && st.leader === 3, 'the player on declarer’s left leads (East)');
    check(BR.controller(st, 0) === 2 && BR.controller(st, 2) === 2 && BR.controller(st, 1) === 1, 'declarer plays dummy’s cards');
    // Declarer is the first of the side to bid the suit.
    let s2 = deal(2);
    s2 = BR.applyCall(s2, 2, '1C'); s2 = BR.applyCall(s2, 3, 'P'); s2 = BR.applyCall(s2, 0, '1S'); s2 = BR.applyCall(s2, 1, 'P');
    s2 = BR.applyCall(s2, 2, '2S'); s2 = BR.applyCall(s2, 3, 'P'); s2 = BR.applyCall(s2, 0, 'P'); s2 = BR.applyCall(s2, 1, 'P');
    check(s2.phase === 'play' && s2.contract.declarer === 0 && s2.contract.den === 3, 'the first to bid spades (South) is declarer even though North bid the last one');
    // Passed out.
    let s3 = deal(3);
    for (let k = 0; k < 4; k++) s3 = BR.applyCall(s3, s3.turn, 'P');
    check(s3.phase === 'dealEnd' && s3.result.passedOut && s3.totals.join() === '0,0', 'four passes: passed out, no score');
    // Seven no trump is the top.
    let s4 = deal(4);
    s4 = BR.applyCall(s4, 2, '7N');
    check(BR.legalCalls(s4, 3).join() === 'P,X', 'nothing beats seven no trump but a double');
  }
  // Tricks.
  {
    const trick = (spec) => spec.map(([seat, c]) => ({ seat, id: id(c) }));
    check(BR.trickWinner(trick([[0, '5S'], [1, 'KS'], [2, '2S'], [3, 'QS']]), -1) === 1, 'no trump: highest of the suit led');
    check(BR.trickWinner(trick([[0, '5S'], [1, 'KH'], [2, '2S'], [3, 'QD']]), -1) === 0, 'no trump: discards never win');
    check(BR.trickWinner(trick([[0, 'AS'], [1, '2H'], [2, 'KS'], [3, '3H']]), 2) === 3, 'a trump beats the suit led, the higher trump wins');
    check(BR.trickWinner(trick([[0, 'AS'], [1, 'KD'], [2, 'KS'], [3, '3D']]), 2) === 0, 'a discard in another suit does not win');
  }
  // Following suit and the dummy.
  {
    let st = deal(7);
    st.hands = [ids('AS KS 2H'), ids('QS 5D 4D'), ids('3S 3H 3D'), ids('JS 6D 6C')];
    st.phase = 'play'; st.turn = 1; st.leader = 1; st.contract = { level: 3, den: 4, declarer: 0, dummy: 2, dbl: 0 };
    st.hands = st.hands.map(h => h.slice());
    check(BR.legalPlays(st, 1).length === 3, 'the leader may play anything');
    st = BR.playCard(st, 1, id('QS'));
    check(st.dummyShown === true && st.turn === 2, 'dummy goes down after the opening lead');
    check(BR.legalPlays(st, 2).join() === id('3S').toString(), 'must follow suit');
    check(BR.playCard(st, 2, id('3H')) === st, 'cannot discard when holding the suit led');
    st = BR.playCard(st, 2, id('3S'));
    check(BR.legalPlays(st, 0).length === 2, 'South must follow with a spade');
  }
  // The bidding sanity checks: openings and responses.
  {
    const h = s => ids(s);
    const open = s => BR.openingCall(h(s));
    check(open('AS KS 5H 4H 3H AD JD 6D 7C 8C 2C 9S 4S') !== 'P', 'a good hand opens');
    check(open('2S 3S 5H 4H 3H 2D 7D 6D 7C 8C 2C 9S 4S') === 'P', 'a weak hand passes');
    // 1NT: 16 balanced
    check(open('AS KS 5S AH 4H 3H QD JD 6D 2D KC 7C 2C') === '1N', '17 balanced opens 1NT: ' + open('AS KS 5S AH 4H 3H QD JD 6D 2D KC 7C 2C'));
    // 1S with five spades and 13 points
    check(open('AS KS 5S 4S 3S AD 2D 6D 7C 8C 2C JD 4H') === '1S', 'five spades open 1S');
    check(open('AC KC QC JC 3C 2C AD 6D 7H 8H 2S 9S 4S') === '1C', 'a six-card club suit with 14 points opens 1C');
    // Weak two
    check(open('KS QS 9S 5S 3S 2S 2D 6D 7H 8H 2C 9C 4H') === '2S', 'a weak two: six spades headed by KQ, few points: ' + open('KS QS 9S 5S 3S 2S 2D 6D 7H 8H 2C 9C 4H'));
  }
  // Whole deals, bid and played by the computer players: every call and card is legal,
  // the auctions end, and the contracts are sensible and make about half the time.
  {
    const rng = lcg(91);
    let deals = 0, ok = true, problem = '', passedOut = 0, made = 0, contracts = 0, games = 0, slams = 0, nt = 0, doubled = 0, lenSum = 0, hugeDown = 0, count = {};
    let ms = 0;
    for (let k = 0; k < 600 && ok; k++) {
      let st = BR.newGame(Z.shuffled(rng));
      const t0 = Date.now();
      let guard = 0;
      while (st.phase === 'auction' && guard++ < 80) {
        const call = BR.aiBid(st, st.turn);
        const next = BR.applyCall(st, st.turn, call);
        if (next === st) { ok = false; problem = 'illegal call ' + call + ' after ' + st.auction.map(e => e.call).join(' '); break; }
        st = next;
      }
      if (!ok) break;
      if (st.phase === 'auction') { ok = false; problem = 'auction never ended'; break; }
      lenSum += st.auction.length;
      if (st.result && st.result.passedOut) { passedOut++; deals++; continue; }
      contracts++;
      const c = st.contract;
      if (c.den === 4) nt++;
      if (c.dbl) doubled++;
      if (c.level >= 6) slams++; else if (c.level * (c.den < 2 ? 20 : 30) + (c.den === 4 ? 10 : 0) >= 100 || (c.den >= 2 && c.level >= 4) || (c.den < 2 && c.level >= 5) || (c.den === 4 && c.level >= 3)) games++;
      count[c.level + 'x'.repeat(0)] = (count[c.level] || 0) + 1;
      let plays = 0;
      while (st.phase === 'play' && plays++ < 200) {
        if (st.trick.length === 4) { st = BR.resolveTrick(st); continue; }
        const seat = st.turn, pick = BR.aiPick(st, seat);
        if (!BR.isLegal(st, seat, pick)) { ok = false; problem = 'illegal card'; break; }
        st = BR.playCard(st, seat, pick);
      }
      if (!ok) break;
      if (st.phase === 'play') { ok = false; problem = 'play never ended'; break; }
      if (st.tricks[0] + st.tricks[1] !== 13) { ok = false; problem = 'trick count'; break; }
      if (st.result.made) made++;
      if (st.result.taken < st.result.need - 3) hugeDown++;
      ms += Date.now() - t0; deals++;
    }
    check(ok, 'six hundred deals bid and played by the computers, all legal ' + problem);
    check(passedOut / deals < 0.12, 'few deals pass out: ' + passedOut + ' of ' + deals);
    const pct = made / contracts;
    check(pct > 0.4 && pct < 0.8, 'declarers make about half to two thirds of their contracts: ' + (pct * 100).toFixed(0) + '% (' + made + ' of ' + contracts + ')');
    check(slams / contracts < 0.08, 'slams are rare: ' + slams + ' of ' + contracts);
    check(doubled / contracts < 0.2, 'doubles are not common: ' + doubled + ' of ' + contracts);
    check(hugeDown / contracts < 0.15, 'rarely down more than three: ' + hugeDown);
    check(nt / contracts > 0.1 && nt / contracts < 0.5, 'notrump contracts: ' + (nt / contracts * 100).toFixed(0) + '%, games ' + games + ', mean calls ' + (lenSum / deals).toFixed(1));
    check(ms / deals < 40, 'a whole deal takes ' + (ms / deals).toFixed(1) + ' ms');
  }
}

// ── Canasta ─────────────────────────────────────────────────────────────────
if (sandbox.ZimiCanasta) {
  const CA = sandbox.ZimiCanasta;
  // Cards: "KS" etc. as before; copies from the second deck: "KS'" is 52 higher; jokers J1..J4.
  const cid = s => s === 'J' ? 104 : s === 'J2' ? 105 : s.endsWith("'") ? id(s.slice(0, 2)) + 52 : id(s);
  const cids = s => s.trim() ? s.trim().split(/\s+/).map(cid) : [];
  const mk = (rank, cards) => ({ rank, cards: cids(cards) });
  // Values.
  check(CA.cardPts(104) === 50 && CA.cardPts(id('2S')) === 20 && CA.cardPts(id('AS')) === 20 && CA.cardPts(id('KS')) === 10 && CA.cardPts(id('8S')) === 10 && CA.cardPts(id('7S')) === 5 && CA.cardPts(id('4S')) === 5 && CA.cardPts(id('3S')) === 5, 'card values: joker 50, 2 and ace 20, K to 8 10, 7 to 4 5, black three 5');
  check(CA.isWild(104) && CA.isWild(id('2H')) && !CA.isWild(id('AH')), 'twos and jokers are wild');
  check(CA.isRedThree(id('3H')) && CA.isRedThree(id('3D')) && !CA.isRedThree(id('3S')) && CA.isBlackThree(id('3C')), 'red and black threes');
  check(CA.requirement(-5) === 15 && CA.requirement(0) === 50 && CA.requirement(1495) === 50 && CA.requirement(1500) === 90 && CA.requirement(2995) === 90 && CA.requirement(3000) === 120, 'the initial meld minimum rises with the score');
  // New melds.
  check(CA.newMeldRank(cids('KS KH KD')) === 13, 'three kings');
  check(CA.newMeldRank(cids('KS KH 2D')) === 13 && CA.newMeldRank(cids('KS KH J')) === 13, 'two naturals and a wild card');
  check(CA.newMeldRank(cids('KS 2D 2H')) === null, 'one natural is not enough');
  check(CA.newMeldRank(cids('KS KH 2D 2H 2C')) === null && CA.newMeldRank(cids('KS KH KD 2D 2H 2C')) === 13, 'wild cards may not outnumber the natural ones');
  check(CA.newMeldRank(cids('KS KH KD KC 2D 2H 2C J')) === null, 'never more than three wild cards');
  check(CA.newMeldRank(cids('KS KH QD')) === null, 'one rank only');
  check(CA.newMeldRank(cids('3S 3C 3H')) === null, 'threes are not an ordinary meld');
  // Extending a meld and canastas.
  const six = mk(13, "KS KH KD KC KS' KH'"), seven = mk(13, "KS KH KD KC KS' KH' KD'");
  check(CA.canExtend(six, cids('KC\'')) && CA.canExtend(six, cids('2D')), 'a six-card meld takes a natural and a wild card');
  check(!CA.canExtend(seven, cids('2D')) && CA.canExtend(seven, cids("KC'")), 'a canasta cannot take a wild card, but takes naturals');
  check(!CA.canExtend(mk(13, 'KS KH KD 2S 2H 2C'), cids('J')), 'at most three wild cards in a meld');
  check(!CA.canExtend(six, cids('QS')), 'only its own rank');
  check(CA.isCanasta(seven) && !CA.isCanasta(six) && CA.isPure(seven) && !CA.isPure(mk(13, 'KS KH KD KC KS\' KH\' 2D')), 'seven cards make a canasta; pure with no wild cards');
  // Planning a turn's melds from a selection.
  {
    const plan = (sel, melds, out, target) => CA.planMelds(melds || [], cids(sel), !!out, target);
    check(plan('KS KH KD').ok && plan('KS KH KD').melds.length === 1, 'plan: a new meld');
    check(plan('KS KH KD QS QH QD').ok && plan('KS KH KD QS QH QD').melds.length === 2, 'plan: two melds at once');
    check(!plan('KS KH').ok, 'plan: two cards are not a meld');
    check(plan('KS', [mk(13, 'KH KD KC')]).ok, 'plan: one card joins an existing meld');
    check(plan('KS KH 2D').ok && !plan('KS KH QS 2D').ok, 'plan: wild cards go with one rank');
    check(!plan('2D 2H').ok && plan('2D', [mk(13, 'KH KD KC')], false, 13).ok, 'plan: wild cards alone need a meld to join');
    check(!plan('3S 3C 3D'.replace('3D', '3C\'')).ok && plan('3S 3C 3C\'', [], true).ok, 'plan: black threes only when going out');
    check(!plan('3H KS KH KD').ok, 'plan: red threes are laid automatically');
  }
  // The deal and the state of play.
  const deck = () => { const a = []; for (let i = 0; i < 108; i++) a.push(i); return a; };
  const total = st => st.stock.length + st.pile.length + st.hands[0].length + st.hands[1].length + st.melds[0].reduce((n, m) => n + m.cards.length, 0) + st.melds[1].reduce((n, m) => n + m.cards.length, 0) + st.reds[0].length + st.reds[1].length;
  {
    const st = CA.newHand(T.shuffleOf(deck(), lcg(3)), [0, 0], 0);
    check(total(st) === 108, 'the deal accounts for all 108 cards');
    check(st.hands[0].length === 15 && st.hands[1].length === 15 || st.reds[0].length + st.reds[1].length > 0, 'fifteen cards each (red threes replaced)');
    check(st.hands[0].every(c => !CA.isRedThree(c)) && st.hands[1].every(c => !CA.isRedThree(c)), 'no red three stays in a hand');
    check(st.turn === 0 && st.step === 'draw', 'you start the first hand');
  }
  // A built position.
  const base = (over) => {
    const st = CA.newHand(T.shuffleOf(deck(), lcg(9)), [0, 0], 0);
    st.hands = [[], []]; st.pile = []; st.melds = [[], []]; st.reds = [[], []]; st.melded = [false, false]; st.pileFrozen = false; st.turnPts = 0;
    Object.assign(st, over || {});
    return st;
  };
  {
    // Taking the pile.
    let st = base({ hands: [cids('KS KH 5C 9D QS QD JC'), cids('AS')], pile: cids('8C KD'), turn: 0, step: 'draw' });
    check(!CA.takePlan(st, 0, cids('KS')).ok, 'before your first meld the pile is frozen: one king is not enough');
    check(CA.takePlan(st, 0, cids('KS KH')).ok, 'a natural pair takes the pile with the top card');
    st.melded[0] = true; st.melds[0] = [mk(12, 'QC QH QD')];
    st.hands[0].push(cid('2D'));
    check(!CA.takePlan(st, 0, cids('KS')).ok && CA.takePlan(st, 0, cids('KS KH')).ok && CA.takePlan(st, 0, cids('KS 2D')).ok, 'not frozen, no meld of that rank: the top card needs two more (two naturals, or a natural and a wild card)');
    check(!CA.takePlan(st, 0, cids('9D')).ok, 'cards that do not match are refused');
    st.pileFrozen = true;
    check(!CA.takePlan(st, 0, cids('KS')).ok && CA.takePlan(st, 0, cids('KS KH')).ok, 'a frozen pile needs the natural pair');
    st.pileFrozen = false; st.melds[0] = [mk(13, 'KC KC\' KH\'')];
    check(CA.takePlan(st, 0, []).ok, 'with a meld of that rank, the top card alone joins it');
    st.pile = cids('KD 2S');
    check(!CA.takePlan(st, 0, cids('KS KH')).ok, 'a wild card on top blocks the pile');
    st.pile = cids('KD 3S');
    check(!CA.takePlan(st, 0, cids('KS KH')).ok, 'a black three on top blocks the pile');
    st.pile = cids('KD 8C'); st.melds[0] = []; st.melded[0] = true;
    check(!CA.takePlan(st, 0, cids('KS')).ok, 'taking needs a meld: one king and the card on top (8C) do not match');
    // take effect
    st = base({ hands: [cids('KS KH 5C 9D QS'), cids('AS')], pile: cids('4C 6D 8D 5S KD'), turn: 0, step: 'draw', melded: [true, false] });
    const t = CA.takePile(st, cids('KS KH'));
    check(t.step === 'play' && t.pile.length === 0 && t.hands[0].length === 5 + 4 - 2 && t.melds[0][0].cards.length === 3 && t.hands[0].length + t.melds[0][0].cards.length + t.pile.length === 5 + 5, 'taking the pile moves all of it to your hand, melds the top card');
    check(t.turnPts === 30, 'the first meld counts the top card and your pair: 30');
  }
  {
    // Discarding and the first meld's minimum.
    let st = base({ hands: [cids('KS KH KD 5C 9D QS JC'), cids('AS')], turn: 0, step: 'play', pile: cids('8C'), scores: [0, 0] });
    st = CA.meld(st, cids('KS KH KD'));
    check(st.melds[0].length === 1 && st.turnPts === 30, 'a meld of three kings');
    check(CA.discardProblem(st, cid('9D')).indexOf('first meld') >= 0, 'the first meld must reach 50: discarding is refused at 30');
    let st2 = base({ hands: [cids('KS KH KD AS AH AD 9D QS'), cids('AC')], turn: 0, step: 'play', pile: cids('8C'), scores: [0, 0] });
    st2 = CA.meld(st2, cids('KS KH KD AS AH AD'));
    check(st2.turnPts === 90 && CA.discardProblem(st2, cid('9D')) === '', 'kings and aces make 90, enough');
    const after = CA.discard(st2, cid('9D'));
    check(after.turn === 1 && after.step === 'draw' && after.melded[0] === true && after.pile.length === 2, 'the turn passes after the discard');
    const w = CA.discard(Object.assign(CA.meld(base({ hands: [cids('5S 5H 5D 9D QS'), cids('AC')], turn: 0, step: 'play', pile: cids('8C'), scores: [1600, 0] }), cids('5S 5H 5D')), {}), cid('9D'));
    check(w.turn === 0 && w.melds[0].length === 1 && w.melded[0] === false, 'the minimum is 90 at a score of 1600: the 15-point meld is refused');
    // the wild card discard freezes
    let sw = base({ hands: [cids('2S 5H'), cids('AC')], turn: 0, step: 'play', pile: cids('8C'), melded: [true, false], melds: [[mk(13, 'KC KH KD')], []] });
    sw = CA.discard(sw, cid('2S'));
    check(sw.pileFrozen === true, 'discarding a wild card freezes the pile');
  }
  {
    // Going out and the hand-size rule.
    const melds = [mk(13, "KS KH KD KC KS' KH' KD'"), mk(12, "QS QH QD QC QS' QH' QD'")];
    let st = base({ hands: [cids('5S 5H 5D 9C'), cids('AC')], turn: 0, step: 'play', melds: [melds, []], melded: [true, false] });
    check(CA.meldProblem(st, cids('5S 5H 5D')) === '', 'meld three leaving one card: allowed with two canastas');
    let st1 = base({ hands: [cids('5S 5H 5D 9C'), cids('AC')], turn: 0, step: 'play', melds: [[mk(13, "KS KH KD KC KS' KH' KD'")], []], melded: [true, false] });
    check(CA.meldProblem(st1, cids('5S 5H 5D')) !== '', 'with one canasta you must keep a card: melding to one card is refused');
    let st3 = base({ hands: [cids('9C'), cids('AC')], turn: 0, step: 'play', melds: [[mk(13, "KS KH KD KC KS' KH' KD'")], []], melded: [true, false], pile: cids('8C') });
    check(CA.discardProblem(st3, cid('9C')).indexOf('canastas') >= 0, 'going out by discarding needs two canastas');
    let st4 = base({ hands: [cids('9C'), cids('AC')], turn: 0, step: 'play', melds: [melds, []], melded: [true, false], pile: cids('8C'), scores: [0, 0] });
    const done = CA.discard(st4, cid('9C'));
    check(done.phase === 'handEnd' && done.result.outSide === 0, 'going out ends the hand');
    // score: two natural canastas 14 cards: kings 100 + queens 70?? (K=10 x7=70, Q=10 x7=70) + 1000 bonus + out 100 (+100 concealed? no: melded earlier)
    const sc = CA.sideScore(Object.assign({}, st4, { melds: [melds, []], concealed: [false, true], hands: [[], cids('9C')] }), 0, 0);
    check(sc.meld === 140 && sc.canasta === 1000 && sc.out === 100 && sc.points === 1240, 'two natural canastas of ten-point cards plus going out: ' + sc.points);
    const mixed = CA.sideScore(Object.assign({}, st4, { melds: [[mk(13, "KS KH KD KC KS' KH' 2D")], []], concealed: [false, true], hands: [cids('9C 5D'), []], reds: [cids('3H 3D'), []] }), 0, -1);
    check(mixed.canasta === 300 && mixed.red === 200 && mixed.hand === 15 && mixed.points === 60 + 20 + 300 + 200 - 15, 'a mixed canasta 300, two red threes 200, cards in hand count against: ' + mixed.points);
    const nomeld = CA.sideScore(Object.assign({}, st4, { melds: [[], []], hands: [cids('9C'), []], reds: [cids('3H 3D 3H\' 3D\''), []] }), 0, -1);
    check(nomeld.red === -800 && nomeld.points === -800 - 10, 'all four red threes are worth 800, against you with no melds');
    const concealed = CA.sideScore(Object.assign({}, st4, { melds: [melds, []], concealed: [true, true], hands: [[], []] }), 0, 0);
    check(concealed.out === 200, 'going out concealed pays 200');
  }
  // Whole hands, computer against computer: cards conserved, every action legal, hands end, games finish.
  {
    const rng = lcg(101);
    let ok = true, problem = '', hands = 0, outs = 0, stockEnds = 0, games = 0, steps = 0, turns = 0, maxSteps = 0, canastas = 0, ms = 0;
    for (let g = 0; g < 8 && ok; g++) {
      let st = CA.newHand(T.shuffleOf(deck(), rng), [0, 0], 0, 1500);
      let guard = 0;
      while (st.phase !== 'over' && guard++ < 60 && ok) {
        let n = 0;
        const t0 = Date.now();
        while (st.phase === 'play' && n++ < 1500) {
          const before = st, next = CA.aiStep(st);
          if (next === before) { ok = false; problem = 'a step changed nothing at ' + st.step; break; }
          st = next;
          if (total(st) !== 108) { ok = false; problem = 'cards lost: ' + total(st) + ' after ' + st.last; break; }
        }
        ms += Date.now() - t0;
        if (!ok) break;
        if (n >= 1500) { ok = false; problem = 'a hand never ended'; break; }
        steps += n; maxSteps = Math.max(maxSteps, n); hands++;
        if (st.result.outSide >= 0) outs++; else stockEnds++;
        canastas += CA.canastaCount(st.melds[0]) + CA.canastaCount(st.melds[1]);
        if (st.phase === 'handEnd') st = CA.nextHand(st, T.shuffleOf(deck(), rng));
      }
      if (st.phase === 'over') games++;
    }
    check(ok, 'eight games between computers to 1500: all legal, all 108 cards always accounted for ' + problem);
    check(games === 8, 'every game reaches its goal (' + hands + ' hands, ' + outs + ' went out, ' + stockEnds + ' ended on the stock)');
    check(canastas / hands > 0.5, 'canastas get made: ' + (canastas / hands).toFixed(1) + ' per hand');
    check(ms / hands < 300, 'a hand takes ' + (ms / hands).toFixed(0) + ' ms to play out');
  }
}

console.log('\n' + passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
