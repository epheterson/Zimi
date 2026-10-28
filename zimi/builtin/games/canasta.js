/* ZimiGames: Canasta, the classic two-handed game: you against the
   computer, two decks and four jokers (108 cards), 15 cards each. On your
   turn draw two cards from the stock, or take the whole discard pile; lay
   down melds (three or more cards of one rank); discard one card. Twos and
   jokers are wild: a meld needs at least two natural cards, never more than
   three wild cards and never more wild cards than natural ones. Seven cards
   of a rank make a canasta (500 if all natural, 300 with a wild); a canasta
   cannot take wild cards. Red threes are bonus cards (100 each, 800 for all
   four): you lay them at once and draw a card to replace each. Black threes
   can only be melded to go out. Your first meld must be worth a minimum (50
   points, or more once your score is up: 15 below zero, 90 from 1500, 120
   from 3000); card values: joker 50, two and ace 20, king down to eight 10,
   seven down to four 5, black three 5. The discard pile is frozen after a
   wild card is discarded (or before your side has melded): you may take it
   only with a natural pair from your hand that matches the top card; when it
   is not frozen you may take it with one card to add to a meld you already
   have. A wild card or black three on top stops the next player taking it.
   You may go out when you hold two canastas: for 100, or 200 if you laid
   every card in one turn. The hand ends when someone goes out or the stock
   runs dry. Each side scores melds plus bonuses minus the cards left in
   hand. First side to 5000 wins.

   State: stock, pile (top last), pileFrozen, hands[2], melds[2]
   ([{rank, cards}], rank 14 for aces, 3 for black threes), reds[2], melded[2]
   (has made its first meld), turn (0 you, 1 computer), step ('draw' | 'play'),
   turnPts, scores[2], handNo, phase ('play' | 'handEnd' | 'over'), result,
   last (what just happened, for the status line). Card ids: 0..51 and 52..103
   are two decks, 104..107 jokers. Pure functions; the page wiring at the
   bottom only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;

  var JOKER_BASE = 104, TOTAL = 108, DEAL = 15, DRAW = 2, GO_OUT_CANASTAS = 2, CANASTA_SIZE = 7, MAX_WILD = 3;
  var NAMES = [TX('cards.you'), root.ZimiText.ZIMI], TARGETS = [1500, 3000, 5000], DEFAULT_TARGET = 5000;
  var BONUS = { natural: 500, mixed: 300, red: 100, allReds: 800, out: 100, concealed: 100 };
  var rankKey = function (id) { if (id >= JOKER_BASE) return 0; var r = Z.rank(id); return r === 1 ? 14 : r; };
  var isJoker = function (id) { return id >= JOKER_BASE; };
  var isWild = function (id) { return isJoker(id) || Z.rank(id) === 2; };
  var isRedThree = function (id) { return !isJoker(id) && Z.rank(id) === 3 && Z.suit(id) % 4 >= 1 && Z.suit(id) <= 2; };
  var isBlackThree = function (id) { return !isJoker(id) && Z.rank(id) === 3 && !isRedThree(id); };
  function cardPts(id) {
    if (isJoker(id)) return 50;
    var r = Z.rank(id);
    return r === 2 || r === 1 ? 20 : r >= 8 ? 10 : r >= 4 ? 5 : r === 3 ? 5 : 0;
  }
  var sumPts = function (ids) { return ids.reduce(function (n, c) { return n + cardPts(c); }, 0); };
  var last = function (list) { return list[list.length - 1]; };
  // What the side to act did last, for the status line while the next one thinks.
  function note(s, side, text) { s.last = text; s.lastSide = side; }
  var rankName = function (r) { return TX('canasta.rank.' + r); };
  var rankOne = function (r) { return TX('canasta.rank1.' + r); };
  // Order in a hand: by rank, wild cards last.
  var handOrder = function (id) { return isWild(id) ? 100 + (isJoker(id) ? 1 : 0) : rankKey(id) * 4 + Z.suit(id) % 4; };
  var sortHand = function (ids) { return ids.slice().sort(function (a, b) { return handOrder(a) - handOrder(b) || a - b; }); };
  var requirement = function (score) { return score < 0 ? 15 : score < 1500 ? 50 : score < 3000 ? 90 : 120; };

  // ── Melds ───────────────────────────────────────────────────────────────
  var wildCount = function (cards) { return cards.filter(isWild).length; };
  var isCanasta = function (m) { return m.cards.length >= CANASTA_SIZE; };
  var isPure = function (m) { return wildCount(m.cards) === 0; };
  var canastaCount = function (melds) { return melds.filter(isCanasta).length; };
  // Whether these cards make a meld of one rank by themselves: {rank} or null.
  function newMeldRank(cards) {
    var nat = cards.filter(function (c) { return !isWild(c); }), w = cards.length - nat.length;
    if (cards.length < 3 || nat.length < 2 || w > MAX_WILD || w > nat.length) return null;
    var r = rankKey(nat[0]);
    if (r === 3 || !nat.every(function (c) { return rankKey(c) === r; })) return null;
    return r;
  }
  // Can `cards` join the meld `m` (same rank naturals, wilds that fit)?
  function canExtend(m, cards) {
    var all = m.cards.concat(cards), nat = all.filter(function (c) { return !isWild(c); });
    if (!cards.every(function (c) { return isWild(c) || rankKey(c) === m.rank; })) return false;
    var addW = wildCount(cards);
    if (addW && isCanasta(m)) return false;
    return wildCount(all) <= MAX_WILD && wildCount(all) <= nat.length;
  }
  // Turn a selection of cards into melds: {ok, error, melds: [{rank, cards, add}]}.
  function planMelds(melds, selection, goingOut, target) {
    var fail = function (e) { return { ok: false, error: e }; };
    if (!selection.length) return fail(TX('canasta.err.pick'));
    if (selection.some(isRedThree)) return fail(TX('canasta.err.reds'));
    var wilds = selection.filter(isWild), nat = selection.filter(function (c) { return !isWild(c); }), groups = {};
    nat.forEach(function (c) { (groups[rankKey(c)] = groups[rankKey(c)] || []).push(c); });
    var ranks = Object.keys(groups).map(Number);
    if (!ranks.length) {
      var tm = target && melds.filter(function (m) { return m.rank === target; })[0];
      if (!tm) return fail(TX('canasta.err.tapMeld'));
      if (!canExtend(tm, wilds)) return fail(isCanasta(tm) ? TX('canasta.err.canastaWild') : TX('canasta.err.tooWild', { rank: rankName(target) }));
      return { ok: true, melds: [{ rank: target, cards: wilds, add: true }] };
    }
    if (wilds.length && ranks.length > 1) return fail(TX('canasta.err.oneRank'));
    var plan = [];
    for (var i = 0; i < ranks.length; i++) {
      var r = ranks[i], cards = groups[r].concat(i === 0 ? wilds : []), existing = melds.filter(function (m) { return m.rank === r; })[0];
      if (r === 3) {
        if (!goingOut) return fail(TX('canasta.err.blackOut'));
        if (cards.length < 3) return fail(TX('canasta.err.blackThree'));
        plan.push({ rank: 3, cards: cards, add: !!existing });
      } else if (existing) {
        if (!canExtend(existing, cards)) return fail(isCanasta(existing) && wilds.length ? TX('canasta.err.canastaWild') : TX('canasta.err.tooWild', { rank: rankName(r) }));
        plan.push({ rank: r, cards: cards, add: true });
      } else if (newMeldRank(cards) !== r) {
        return fail(groups[r].length < 2 ? TX('canasta.err.needTwo', { rank: rankName(r) }) : TX('canasta.err.moreWild'));
      } else plan.push({ rank: r, cards: cards, add: false });
    }
    return { ok: true, melds: plan };
  }
  function addToMelds(melds, plan) {
    plan.forEach(function (p) {
      var m = melds.filter(function (x) { return x.rank === p.rank; })[0];
      if (m) m.cards = m.cards.concat(p.cards); else melds.push({ rank: p.rank, cards: p.cards.slice() });
    });
    melds.sort(function (a, b) { return b.rank - a.rank; });
  }

  // ── The deal ────────────────────────────────────────────────────────────
  function newHand(order, scores, handNo, target) {
    var s = {
      stock: order.slice(), pile: [], pileFrozen: false, hands: [[], []], melds: [[], []], reds: [[], []], melded: [false, false],
      turn: handNo % 2 === 0 ? 0 : 1, step: 'draw', turnPts: 0, scores: scores.slice(), handNo: handNo, phase: 'play', result: null, last: '', target: target || DEFAULT_TARGET, moves: 0, concealed: [true, true]
    }, side, k;
    for (k = 0; k < DEAL; k++) for (side = 0; side < 2; side++) s.hands[side].push(s.stock.pop());
    for (side = 0; side < 2; side++) layReds(s, side);
    s.pile.push(s.stock.pop());
    while (isWild(last(s.pile)) || isRedThree(last(s.pile))) { s.pileFrozen = true; s.pile.push(s.stock.pop()); }
    s.hands = s.hands.map(sortHand);
    return s;
  }
  // Red threes in a hand go face up at once and are replaced from the stock.
  function layReds(s, side, replace) {
    var again = true;
    while (again) {
      again = false;
      s.hands[side].slice().forEach(function (c) {
        if (isRedThree(c)) { s.hands[side].splice(s.hands[side].indexOf(c), 1); s.reds[side].push(c); if (replace !== false && s.stock.length) s.hands[side].push(s.stock.pop()); again = true; }
      });
    }
  }

  // ── A turn ──────────────────────────────────────────────────────────────
  function draw(st) {
    if (st.phase !== 'play' || st.step !== 'draw') return st;
    var s = Z.clone(st), side = s.turn, got = [];
    if (!s.stock.length) return endHand(s, -1, TX('canasta.why.stock'));
    for (var k = 0; k < DRAW && s.stock.length; k++) { var c = s.stock.pop(); s.hands[side].push(c); got.push(c); }
    layReds(s, side);
    s.hands[side] = sortHand(s.hands[side]);
    s.step = 'play'; s.turnPts = 0; s.moves++; note(s, side, TX('canasta.note.drew'));
    return s;
  }
  // Can this side take the pile now with `sel` from its hand? {ok, error, plan}
  function takePlan(st, side, sel) {
    var fail = function (e) { return { ok: false, error: e }; };
    if (st.phase !== 'play' || st.step !== 'draw' || st.turn !== side) return fail(TX('canasta.err.notDraw'));
    if (!st.pile.length) return fail(TX('canasta.err.pileEmpty'));
    var top = last(st.pile);
    if (isWild(top) || isBlackThree(top)) return fail(TX(isWild(top) ? 'canasta.err.wildTop' : 'canasta.err.blackTop'));
    if (!sel.every(function (c) { return st.hands[side].indexOf(c) >= 0; })) return fail(TX('canasta.err.notInHand'));
    var frozen = st.pileFrozen || !st.melded[side], r = rankKey(top), existing = st.melds[side].filter(function (m) { return m.rank === r; })[0];
    var natSel = sel.filter(function (c) { return !isWild(c); });
    if (natSel.some(function (c) { return rankKey(c) !== r; })) return fail(TX('canasta.err.match', { rank: rankOne(r) }));
    var cards = [top].concat(sel);
    if (frozen && natSel.length < 2) return fail(TX('canasta.err.frozen', { rank: rankName(r) }));
    if (existing) {
      if (!canExtend(existing, cards)) return fail(TX('canasta.err.noFit', { rank: rankName(r) }));
      return { ok: true, plan: [{ rank: r, cards: cards, add: true }] };
    }
    if (newMeldRank(cards) !== r) return fail(TX('canasta.err.twoNat', { rank: rankName(r) }));
    return { ok: true, plan: [{ rank: r, cards: cards, add: false }] };
  }
  function takePile(st, sel) {
    var side = st.turn, tp = takePlan(st, side, sel);
    if (!tp.ok) return st;
    var s = Z.clone(st), taken = s.pile.slice(), top = last(taken);
    s.pile = []; s.pileFrozen = false;
    s.hands[side] = s.hands[side].concat(taken.slice(0, -1));
    s.hands[side] = s.hands[side].filter(function (c) { return sel.indexOf(c) < 0; });
    layReds(s, side, false); // a red three that was under the first discard: laid, no replacement
    addToMelds(s.melds[side], tp.plan);
    s.turnPts = sumPts([top].concat(sel)); s.step = 'play'; s.moves++; s.concealed[side] = false;
    s.hands[side] = sortHand(s.hands[side]);
    note(s, side, TX('canasta.note.took', { cards: Z.plural(taken.length, 'card') }));
    return s;
  }
  var canGoOut = function (s, side) { return canastaCount(s.melds[side]) >= GO_OUT_CANASTAS; };
  // Why a meld action cannot be made now (or '').
  function meldProblem(st, selection, target) {
    var side = st.turn;
    if (st.phase !== 'play' || st.step !== 'play') return TX('canasta.err.drawFirst');
    if (!selection.every(function (c) { return st.hands[side].indexOf(c) >= 0; })) return TX('canasta.err.notInHand');
    var left = st.hands[side].length - selection.length;
    var probe = Z.clone(st);
    var plan = planMelds(st.melds[side], selection, left <= 1, target);
    if (!plan.ok) return plan.error;
    addToMelds(probe.melds[side], plan.melds);
    if (left <= 1 && !canGoOut(probe, side)) return TX(left === 0 ? 'canasta.err.needCanastas' : 'canasta.err.keepOne', { n: GO_OUT_CANASTAS });
    return '';
  }
  function meld(st, selection, target) {
    if (meldProblem(st, selection, target)) return st;
    var s = Z.clone(st), side = s.turn, left = s.hands[side].length - selection.length;
    var plan = planMelds(s.melds[side], selection, left <= 1, target);
    s.hands[side] = s.hands[side].filter(function (c) { return selection.indexOf(c) < 0; });
    addToMelds(s.melds[side], plan.melds);
    s.turnPts += sumPts(selection); s.moves++;
    s.hands[side] = sortHand(s.hands[side]);
    note(s, side, TX('canasta.note.melded', { ranks: plan.melds.map(function (p) { return rankName(p.rank); }).join(' ' + TX('crib.and') + ' ') }));
    if (!s.hands[side].length) return endHand(s, side, '');
    return s;
  }
  // Why this card cannot be discarded (or '').
  function discardProblem(st, id) {
    var side = st.turn;
    if (st.phase !== 'play' || st.step !== 'play') return TX('canasta.err.drawFirst');
    if (st.hands[side].indexOf(id) < 0) return TX('canasta.err.cardNotInHand');
    if (!st.melded[side] && st.melds[side].length && st.turnPts < requirement(st.scores[side]) && !(st.hands[side].length === 1 && canGoOut(st, side))) return TX('canasta.err.firstMeld', { n: requirement(st.scores[side]), have: st.turnPts });
    if (st.hands[side].length === 1 && !canGoOut(st, side)) return TX('canasta.err.needCanastas', { n: GO_OUT_CANASTAS });
    return '';
  }
  function discard(st, id) {
    if (discardProblem(st, id)) return st;
    var s = Z.clone(st), side = s.turn;
    s.hands[side].splice(s.hands[side].indexOf(id), 1);
    s.pile.push(id); s.moves++;
    if (isWild(id)) s.pileFrozen = true;
    if (s.melds[side].length) s.melded[side] = true;
    note(s, side, TX('canasta.note.discarded', { card: cardName(id) }));
    if (!s.hands[side].length) return endHand(s, side, '');
    s.turn = 1 - side; s.step = 'draw'; s.turnPts = 0;
    return s;
  }

  // ── Scoring ─────────────────────────────────────────────────────────────
  function sideScore(s, side, outSide) {
    var melds = s.melds[side], lines = [], pts = 0, cardsPts = 0;
    melds.forEach(function (m) { cardsPts += sumPts(m.cards); });
    var canasta = 0;
    melds.forEach(function (m) { if (isCanasta(m)) canasta += isPure(m) ? BONUS.natural : BONUS.mixed; });
    var reds = s.reds[side].length, redPts = reds === 4 ? BONUS.allReds : reds * BONUS.red;
    if (!melds.length) redPts = -redPts;
    var out = outSide === side ? (s.concealed[side] ? BONUS.out + BONUS.concealed : BONUS.out) : 0;
    var hand = sumPts(s.hands[side]);
    pts = cardsPts + canasta + redPts + out - hand;
    lines.push(TX('canasta.line.melded', { n: cardsPts }));
    if (canasta) lines.push(TX('canasta.line.canastas', { n: canasta }));
    if (reds) lines.push(TX('canasta.line.reds', { n: (redPts >= 0 ? '+' : '') + redPts }));
    if (out) lines.push(TX(s.concealed[side] ? 'canasta.line.outConcealed' : 'canasta.line.out', { n: out }));
    if (hand) lines.push(TX('canasta.line.hand', { n: hand }));
    return { points: pts, lines: lines, meld: cardsPts, canasta: canasta, red: redPts, out: out, hand: hand };
  }
  function endHand(s, outSide, why) {
    var r = [sideScore(s, 0, outSide), sideScore(s, 1, outSide)];
    s.result = { sides: r, outSide: outSide, why: why };
    s.scores = [s.scores[0] + r[0].points, s.scores[1] + r[1].points];
    s.phase = gameWinner(s.scores, s.target) >= 0 ? 'over' : 'handEnd';
    s.turn = outSide >= 0 ? outSide : s.turn;
    return s;
  }
  function gameWinner(scores, target) {
    var lim = target || DEFAULT_TARGET, hi = Math.max(scores[0], scores[1]);
    if (hi < lim) return -1;
    return scores[0] === scores[1] ? -1 : scores[0] > scores[1] ? 0 : 1;
  }
  function nextHand(st, order) { return newHand(order, st.scores, st.handNo + 1, st.target); }

  // ── The computer player ─────────────────────────────────────────────────
  function naturalsByRank(hand) {
    var g = {};
    hand.forEach(function (c) { if (!isWild(c) && !isRedThree(c)) (g[rankKey(c)] = g[rankKey(c)] || []).push(c); });
    return g;
  }
  // Which cards from the hand the computer would pair with the top of the pile, or null.
  function aiTake(st, side) {
    if (!st.pile.length) return null;
    var top = last(st.pile), r = rankKey(top), hand = st.hands[side];
    if (isWild(top) || isBlackThree(top)) return null;
    var nat = hand.filter(function (c) { return !isWild(c) && rankKey(c) === r; }), existing = st.melds[side].filter(function (m) { return m.rank === r; })[0];
    var tries = [];
    if (nat.length >= 2) tries.push(nat);
    if (existing && !(st.pileFrozen || !st.melded[side])) tries.push(nat.slice(0, 1).length ? nat.slice(0, 1) : []);
    for (var i = 0; i < tries.length; i++) {
      var tp = takePlan(st, side, tries[i]);
      if (!tp.ok) continue;
      var pts = sumPts([top].concat(tries[i]));
      if (!st.melded[side]) {
        // The first meld must reach the minimum, with what the pile adds to the hand.
        var all = hand.concat(st.pile.slice(0, -1)).filter(function (c) { return tries[i].indexOf(c) < 0; }), extra = 0, g = naturalsByRank(all);
        Object.keys(g).forEach(function (k) { if (g[k].length >= 3) extra += sumPts(g[k]); });
        if (pts + extra < requirement(st.scores[side])) continue;
      }
      var value = st.pile.length * 1.5 + pts / 5 + (existing ? 3 : 0);
      if (st.pile.length >= 3 || existing || value >= 6) return tries[i];
    }
    return null;
  }
  // The next meld the computer lays: {cards, target?} or null.
  function aiMeldStep(st, side) {
    var hand = st.hands[side], melds = st.melds[side], g = naturalsByRank(hand), wilds = hand.filter(isWild), groups = [], r;
    var ranks = Object.keys(g).map(Number).filter(function (x) { return x !== 3; }).sort(function (a, b) { return b - a; });
    ranks.forEach(function (rk) { if (g[rk].length >= 3 || melds.some(function (m) { return m.rank === rk; })) groups.push(g[rk].slice()); });
    // The first meld needs enough points: pairs with a wild card help to reach it.
    if (!st.melded[side]) {
      var req = requirement(st.scores[side]), have = st.turnPts + groups.reduce(function (n, p) { return n + sumPts(p); }, 0), spare = wilds.slice();
      ranks.filter(function (rk) { return g[rk].length === 2 && !melds.some(function (m) { return m.rank === rk; }); }).forEach(function (rk) {
        if (have < req && spare.length) { var p = g[rk].concat(spare.splice(0, 1)); groups.push(p); have += sumPts(p); }
      });
      if (have < req) return null;
    }
    for (var n = groups.length; n >= 1; n--) {
      var flat = [].concat.apply([], groups.slice(0, n));
      if (!meldProblem(st, flat)) return { cards: flat };
    }
    // Wild cards that finish a canasta already close.
    for (var k = 0; k < melds.length; k++) {
      var mm = melds[k], need = CANASTA_SIZE - mm.cards.length;
      if (isCanasta(mm) || wildCount(mm.cards) + need > MAX_WILD || need > wilds.length || mm.cards.length < 5) continue;
      var add = wilds.slice(0, need);
      if (!meldProblem(st, add, mm.rank)) return { cards: add, target: mm.rank };
    }
    return null;
  }
  function aiDiscard(st, side) {
    var hand = st.hands[side].filter(function (c) { return !isRedThree(c); }), opp = st.melds[1 - side], mine = st.melds[side], best = null, bs = 1e9;
    var groups = naturalsByRank(hand);
    // A black three stops the pile: a good thing to throw when the opponent has been taking it.
    var feeding = function (c) { return opp.some(function (m) { return m.rank === rankKey(c); }); };
    hand.forEach(function (c) {
      var score = 0, r = rankKey(c);
      if (isWild(c)) score += 200;
      else if (isBlackThree(c)) score -= 25;
      else {
        score += cardPts(c) * 0.4;
        if (feeding(c)) score += 40;
        if (mine.some(function (m) { return m.rank === r; })) score += 30;
        score += ((groups[r] || []).length - 1) * 12;
      }
      if (st.hands[side].length > 1 && st.hands[1 - side].length <= 4) score -= cardPts(c) * 0.8;
      if (score < bs) { bs = score; best = c; }
    });
    return best;
  }
  // One action for the side to move: returns the new state (draw or take, a meld, or the discard).
  function aiStep(st) {
    var side = st.turn;
    if (st.step === 'draw') {
      var sel = aiTake(st, side);
      return sel ? takePile(st, sel) : draw(st);
    }
    var m = aiMeldStep(st, side);
    if (m) { var next = meld(st, m.cards, m.target); if (next !== st) return next; }
    var c = aiDiscard(st, side);
    if (c !== null && discardProblem(st, c)) {
      var alts = st.hands[side].filter(function (x) { return !isRedThree(x) && !discardProblem(st, x); });
      c = alts.length ? alts[0] : null;
    }
    return c === null ? discardFallback(st) : discard(st, c);
  }
  // A state the rules leave stuck (no card can be thrown): the hand ends where it is.
  function discardFallback(st) { return endHand(Z.clone(st), -1, TX('canasta.why.nothing')); }

  // ── Layout ──────────────────────────────────────────────────────────────
  var BAR_H = 46, TAG_H = 22, CELL_SHARE = 1.5, PILE_GAP = 1.7, TAG_SHARE = 2.6;
  function perRow(m) { return Math.max(1, Math.floor((m.W - 2 * m.pad) / (m.cw * CELL_SHARE))); }
  function meldRows(m, n) { return Math.max(1, Math.ceil(n / perRow(m))); }
  // V is the side looking: its hand and melds sit at the bottom.
  function geo(m, st, V) {
    V = V || 0;
    var n = st.hands[V].length, g = T.geometry(m, T.rowsFor(m, n));
    var myRows = meldRows(m, st.melds[V].length), oppRows = meldRows(m, st.melds[1 - V].length);
    g.V = V;
    g.barY = g.yBot - BAR_H;   // yBot is the top of your hand (its extra rows included)
    g.statusY = g.barY - 4 - T.STATUS_H;
    g.myMeldY = g.statusY - 4 - myRows * (g.ch + TAG_H + 4);
    g.oppMeldY = g.northY + g.ch + 8;
    g.centreY = Math.round((g.oppMeldY + oppRows * (g.ch + TAG_H + 4) + g.myMeldY) / 2 - g.ch / 2);
    g.perRow = perRow(m);
    return g;
  }
  function meldSpot(g, side, k) {
    var row = Math.floor(k / g.perRow), col = k % g.perRow, cell = g.cw * CELL_SHARE, inRow = Math.min(g.perRow, 99);
    var x = g.pad + col * cell, y = (side === g.V ? g.myMeldY : g.oppMeldY) + row * (g.ch + TAG_H + 4);
    return { x: Math.round(x), y: Math.round(y) };
  }
  function repCard(m) { return m.cards.filter(function (c) { return !isWild(c); })[0] || m.cards[0]; }
  function place(st, m, view) {
    var V = (view && view.viewer) || 0, up = !(view && view.hideHand), g = geo(m, st, V), slots = [], cards = [], sel = !up ? [] : ((view && view.sel) || []).filter(function (c) { return st.hands[V].indexOf(c) >= 0; });
    slots.push({ id: 'table', x: g.pad, y: g.northY, w: g.W - 2 * g.pad, h: g.southY - g.northY + g.ch, quiet: true, label: TX('cards.slot.table') });
    var hand = T.handCards(g, st.hands[V], function (id) { return { up: up, raise: sel.indexOf(id) >= 0, glow: sel.indexOf(id) >= 0, label: up ? cardName(id) + (sel.indexOf(id) >= 0 ? TX('canasta.pickedSuffix') : '') : TX('cards.hidden') }; }, null);
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    if (st.hands[1 - V].length) cards = cards.concat(T.fan(g, 2, st.hands[1 - V], false));
    [0, 1].forEach(function (side) {
      st.melds[side].forEach(function (mm, k) {
        var sp = meldSpot(g, side, k);
        cards.push({ id: repCard(mm), pile: 'm' + side + '-' + mm.rank, idx: 0, x: sp.x, y: sp.y, up: true, glow: isCanasta(mm), mark: side === V && view && view.target === mm.rank });
        slots.push({ id: 'm' + side + '-' + mm.rank, x: sp.x, y: sp.y, w: g.cw, h: g.ch, quiet: true, label: TX(side === V ? 'canasta.meldAria.you' : 'canasta.meldAria', { rank: rankName(mm.rank), cards: Z.plural(mm.cards.length, 'card') }) });
      });
    });
    var gap = Math.round(g.cw * PILE_GAP), sx = Math.round(g.cx - g.cw - gap / 2), px = Math.round(g.cx + gap / 2);
    if (st.stock.length) cards.push({ id: last(st.stock), pile: 'stock', idx: 0, x: sx, y: g.centreY, up: false });
    if (st.pile.length) cards.push({ id: last(st.pile), pile: 'pile', idx: 0, x: px, y: g.centreY, up: true });
    slots.push({ id: 'stock', x: sx, y: g.centreY, w: g.cw, h: g.ch, label: TX('gin.stock', { cards: Z.plural(st.stock.length, 'card') }) });
    slots.push({ id: 'pile', x: px, y: g.centreY, w: g.cw, h: g.ch, label: TX('canasta.pileAria', { cards: Z.plural(st.pile.length, 'card') }) });
    return { height: m.H, slots: slots, cards: cards };
  }
  var cardName = function (id) { return isJoker(id) ? TX('canasta.joker') : Z.cardName(id); };
  var face = function (id, standalone) { return isJoker(id) ? Z.jokerMarkup(id % 2 === 0, standalone) : Z.faceMarkup(id, standalone); };

  var api = {
    TARGETS: TARGETS, NAMES: NAMES, requirement: requirement, cardPts: cardPts, isWild: isWild, isRedThree: isRedThree, isBlackThree: isBlackThree, rankKey: rankKey,
    newMeldRank: newMeldRank, canExtend: canExtend, planMelds: planMelds, takePlan: takePlan, newHand: newHand, draw: draw, takePile: takePile, meld: meld, meldProblem: meldProblem,
    discard: discard, discardProblem: discardProblem, sideScore: sideScore, canastaCount: canastaCount, isCanasta: isCanasta, isPure: isPure, aiStep: aiStep, aiTake: aiTake, aiMeldStep: aiMeldStep, aiDiscard: aiDiscard,
    gameWinner: gameWinner, nextHand: nextHand, geo: geo, place: place, face: face, sumPts: sumPts, JOKER_BASE: JOKER_BASE, TOTAL: TOTAL, GO_OUT_CANASTAS: GO_OUT_CANASTAS
  };
  root.ZimiCanasta = api;
  if (!(root.document && root.document.getElementById('zc-table'))) return;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 650, TARGET_KEY = 'canasta.target';
  function boot() {
    var d = root.document, t, board, session, view = { sel: [], target: null, flash: '' }, tags = [];
    // Seats are the Computer or a Person; two people share the screen behind a handoff.
    var seats = Seats.create({ id: 'canasta', seats: 2, onChange: function () { view.sel = []; view.target = null; repaint(); } });
    var nm = function (seat) { return seats.name(seat); };
    function syncView(st) { view.viewer = seats.view(); view.hideHand = seats.hotseat() && st.turn !== view.viewer; }
    function repaint() { if (board) board.refresh(); if (t) t.paint(); }
    var table = d.getElementById('zc-table'), bar = Z.h('div', { class: 'cn-bar', role: 'group', 'aria-label': TX('cards.actions') });
    table.appendChild(bar);
    var targetNow = function () { var v = Z.store.get(TARGET_KEY, DEFAULT_TARGET); return TARGETS.indexOf(v) >= 0 ? v : DEFAULT_TARGET; };
    var mySel = function (st) { return view.sel.filter(function (c) { return st.hands[seats.view()].indexOf(c) >= 0; }); };
    function meldTag(mm) {
      var w = wildCount(mm.cards);
      if (isCanasta(mm)) return TX(w ? 'canasta.tag.mixed' : 'canasta.tag.pure', { n: mm.cards.length });
      return TX(w ? 'canasta.tag.meldWild' : 'canasta.tag.meld', { n: mm.cards.length, w: w });
    }
    var tagSig = '';
    function layTags(st, m) {
      var g = geo(m, st, seats.view());
      var sig = JSON.stringify([seats.view(), st.melds.map(function (l) { return l.map(function (mm) { return [mm.rank, mm.cards.length, wildCount(mm.cards)]; }); }), st.stock.length, st.pile.length, st.pileFrozen, st.pile.length ? last(st.pile) : -1, g.W, g.myMeldY, g.centreY]);
      if (sig === tagSig) return;
      tagSig = sig;
      tags.forEach(function (e) { e.remove(); }); tags = [];
      var add = function (txt, x, y, w, cls) { if (!txt) return; var e = Z.h('div', { class: 'c2-tag ' + (cls || ''), style: 'left:' + Math.round(x) + 'px;top:' + Math.round(y) + 'px;width:' + Math.round(w) + 'px;height:' + (TAG_H - 1) + 'px' }, [Z.h('span', { text: txt })]); table.appendChild(e); tags.push(e); };
      [0, 1].forEach(function (side) {
        st.melds[side].forEach(function (mm, k) { var sp = meldSpot(g, side, k); add(meldTag(mm), sp.x, sp.y + g.ch + 1, g.cw * CELL_SHARE - 3, 'c2-meld' + (isCanasta(mm) ? ' c2-turn' : '')); });
      });
      var gap = Math.round(g.cw * PILE_GAP), sx = Math.round(g.cx - g.cw - gap / 2), px = Math.round(g.cx + gap / 2), w = Math.round(g.cw * TAG_SHARE), off = (w - g.cw) / 2;
      add(TX('canasta.tag.stock', { n: st.stock.length }), sx - off, g.centreY + g.ch + 2, w);
      var state = st.pile.length ? (st.pileFrozen ? 'frozen' : '') : '';
      if (st.pile.length && isBlackThree(last(st.pile))) state = 'stopped'; else if (st.pile.length && isWild(last(st.pile))) state = 'wild';
      add(TX(state ? 'canasta.tag.pile.' + state : 'canasta.tag.pile', { n: st.pile.length }), px - off, g.centreY + g.ch + 2, w, st.pileFrozen ? 'c2-out' : '');
    }
    // On a phone three chips share one row, so the red threes are the cards themselves, "2 x 3 of hearts", not words.
    var PHONE_W = 480;
    var redText = function (reds, m) { return reds.length ? ' \u00b7 ' + (m.W < PHONE_W ? reds.length + '\u00d7\u26653' : TX('canasta.reds', { n: reds.length })) : ''; };
    function describeSelection(st) {
      var sel = mySel(st);
      if (!sel.length) return '';
      return TX(view.target ? 'canasta.picked.adding' : 'canasta.picked', { cards: Z.plural(sel.length, 'card'), points: sumPts(sel), rank: view.target ? rankName(view.target) : '' });
    }
    function hud(st) {
      var m = board.metrics();
      layTags(st, m);
      var V = seats.view(), req = requirement(st.scores[V]), out = { text: '' };   // the first-meld progress is the status line's, not a chip's: a chip that long ran off a phone
      out.chips = st.scores.map(function (score, seat) {
        return { name: nm(seat), text: score + redText(st.reds[seat], m), turn: st.turn === seat && st.phase === 'play' };
      }).concat([{ name: TX('canasta.goal'), text: String(st.target) }]);
      if (st.phase === 'handEnd') { out.text = TX('cards.handEnd'); out.label = TX('cards.nextHand'); out.action = startNextHand; }
      else if (st.phase === 'over') { out.text = TX('shell.end.over'); out.label = TX('shell.menu.new'); out.action = newGame; }
      else if (st.turn !== V) out.text = seats.person(st.turn) ? TX('ce.next', { name: nm(st.turn) }) : st.lastSide === st.turn && st.last ? TX('canasta.did', { name: nm(st.turn), what: st.last }) : TX('cards.thinking', { name: nm(st.turn) });
      else if (st.step === 'draw') out.text = TX(seats.isYou(V) ? 'canasta.drawTurn.you' : 'canasta.drawTurn', { name: nm(V) });
      else {
        var sel = mySel(st), mp = sel.length ? meldProblem(st, sel, view.target) : '', info = describeSelection(st);
        out.text = sel.length ? (info + (mp && sel.length > 1 ? '. ' + mp : '')) : TX('canasta.pickHint') + (st.melds[V].length && !st.melded[V] ? ' ' + TX('canasta.firstMeldParen', { have: st.turnPts, n: req }) : (!st.melded[V] ? ' ' + TX('canasta.firstNeeds', { n: req }) : ''));
      }
      paintBar(st);
      return out;
    }
    var barSig = '';
    function paintBar(st) {
      var V = seats.view(), m = board.metrics(), g = geo(m, st, V), sel = mySel(st), draw = st.step === 'draw';
      var mine = st.phase === 'play' && st.turn === V;
      var tp = mine && draw ? takePlan(st, V, sel) : null, mp = mine && !draw && sel.length ? meldProblem(st, sel, view.target) : 'x', dp = mine && !draw && sel.length === 1 ? discardProblem(st, sel[0]) : 'x';
      var sig = JSON.stringify([mine, draw, sel.length > 0, !!(tp && tp.ok), !mp, !dp, Math.round(g.barY)]);
      if (sig === barSig) return; // rebuilt only when it changes, so a tap is never lost to a repaint
      barSig = sig;
      bar.textContent = '';
      bar.hidden = !mine;
      if (bar.hidden) return;
      bar.style.top = Math.round(g.barY) + 'px';
      var btn = function (label, enabled, fn, primary, aria) {
        var b = Z.h('button', { class: 'ar-btn cn-btn', type: 'button', text: label });
        if (primary) b.setAttribute('aria-pressed', 'true');
        if (aria) b.setAttribute('aria-label', aria);
        b.disabled = !enabled; b.addEventListener('click', fn); bar.appendChild(b);
      };
      if (draw) {
        btn(TX('canasta.draw2'), true, drawTurn, true);
        btn(TX('canasta.takePile'), !!(tp && tp.ok), takeSelected, false);
      } else {
        btn(TX('canasta.meld'), !mp, meldSelected, true);
        btn(TX('canasta.discard'), !dp, discardSelected, false);
      }
      btn(TX('canasta.clear'), sel.length > 0, clearSel);
    }
    function reveal(next) { session.follow(next); drive(); }
    function drive() {
      var st = session.state;
      if (st.phase === 'handEnd') { handOver(); return; }
      if (st.phase === 'over') { gameOver(); return; }
      if (seats.person(st.turn)) seats.ensure(st.turn, repaint); else session.later(aiTurn, AI_MS);
    }
    function aiTurn() {
      var st = session.state;
      if (st.phase !== 'play' || seats.person(st.turn)) return;
      var next = aiStep(st);
      if (next === st) next = discardFallback(st);
      session.follow(next); drive();
    }
    function drawTurn() { var st = session.state; if (st.turn !== seats.view() || st.step !== 'draw') return; view.sel = []; session.commit(draw(st)); afterMe(); }
    function takeSelected() {
      var st = session.state, sel = mySel(st), tp = takePlan(st, seats.view(), sel);
      if (!tp.ok) { t.flash(tp.error); return; }
      view.sel = []; session.commit(takePile(st, sel)); afterMe();
    }
    function meldSelected() {
      var st = session.state, sel = mySel(st), why = meldProblem(st, sel, view.target);
      if (why) { t.flash(why); return; }
      var target = view.target; view.sel = []; view.target = null; session.commit(meld(st, sel, target)); afterMe();
    }
    function discardSelected() {
      var st = session.state, sel = mySel(st);
      if (sel.length !== 1) { t.flash(TX('canasta.pickOne')); return; }
      var why = discardProblem(st, sel[0]);
      if (why) { t.flash(why); return; }
      view.sel = []; session.commit(discard(st, sel[0])); afterMe();
    }
    function clearSel() { view.sel = []; view.target = null; board.refresh(); t.paint(); }
    function afterMe() { board.refresh(); t.paint(); drive(); }
    function tap(pile) {
      var st = session.state, kind = pile.charAt(0);
      if (st.phase !== 'play') return false;
      var mine = st.turn === seats.view();
      if (pile === 'stock') { if (mine && st.step === 'draw') drawTurn(); else t.flash(mine ? TX('canasta.err.drawFirst') : TX('cards.wait.turn')); return true; }
      if (pile === 'pile') { if (mine && st.step === 'draw') takeSelected(); else if (mine) t.flash(TX('canasta.pickThenDiscard')); return true; }
      if (pile.slice(0, 3) === 'm' + seats.view() + '-') { var rk = parseInt(pile.slice(3), 10); view.target = view.target === rk ? null : rk; board.refresh(); t.paint(); return true; }
      if (kind !== 'h' || view.hideHand) return false;
      var id = parseInt(pile.slice(1), 10);
      if (isNaN(id)) return false;
      var at = view.sel.indexOf(id);
      if (at >= 0) view.sel.splice(at, 1); else view.sel.push(id);
      board.refresh(); t.paint();
      return true;
    }
    function resultLines(st) {
      var r = st.result, lines = [];
      if (r.why) lines.push(r.why + '.');
      lines.push(r.outSide < 0 ? TX('canasta.nobodyOut') : seats.isYou(r.outSide) ? TX('canasta.youOut') : TX('canasta.nameOut', { name: nm(r.outSide) }));
      [0, 1].forEach(function (side) { lines.push(TX('canasta.sideLine', { name: nm(side), pts: (r.sides[side].points >= 0 ? '+' : '') + r.sides[side].points, parts: r.sides[side].lines.join(', '), total: st.scores[side] })); });
      return lines;
    }
    // The hand's score as a table, a column for each side: only the lines that scored are there.
    function breakdownRows(st) {
      var sd = st.result.sides, both = function (f) { return [f(sd[0]), f(sd[1])]; }, rows = [];
      [['canasta.tbl.melds', function (x) { return x.meld; }, 1], ['canasta.tbl.canastas', function (x) { return x.canasta; }], ['canasta.tbl.bonuses', function (x) { return x.red + x.out; }],
        ['canasta.tbl.penalties', function (x) { return -x.hand; }]].forEach(function (d) {
        var v = both(d[1]); if (d[2] || v[0] || v[1]) rows.push({ cells: [TX(d[0])].concat(v) });
      });
      rows.push({ cells: [TX('cards.sum.hand')].concat(both(function (x) { return x.points; })), total: true });
      rows.push({ cells: [TX('cards.sum.total'), st.scores[0], st.scores[1]], total: true });
      return rows;
    }
    // The hand's summary: who won it and by how much, how it ended, each side's hand and running score.
    function handSummary(st) {
      var r = st.result, p = [r.sides[0].points, r.sides[1].points], lead = p[0] === p[1] ? -1 : p[0] > p[1] ? 0 : 1, top = Math.max(st.scores[0], st.scores[1]);
      return {
        headline: lead < 0 ? TX('canasta.sum.tied') : TX(seats.isYou(lead) ? 'canasta.sum.wonYou' : 'canasta.sum.won', { name: nm(lead), n: Math.abs(p[0] - p[1]) }),
        detail: (r.why ? [r.why + '.'] : []).concat(resultLines(st).slice(r.why ? 1 : 0, r.why ? 2 : 1)),
        table: { cols: ['', nm(0), nm(1)], rows: breakdownRows(st) }
      };
    }
    function handOver() {
      var st = session.state;
      T.summarySheet(Object.assign({ title: TX('cards.fact.hand', { n: st.handNo + 1 }), actions: [{ label: TX('cards.nextHand'), primary: true, onclick: startNextHand }] }, handSummary(st)));
    }
    function gameOver() {
      var st = session.state, w = gameWinner(st.scores, st.target), lines = resultLines(st), V = seats.view(), hot = seats.hotseat();
      if (w === V && !hot) session.win(st.scores[V]); else session.lose(hot ? { name: nm(w) } : '', lines.concat([TX('canasta.final', { a: st.scores[V], b: st.scores[1 - V] })]), hot ? undefined : st.scores[V]);
    }
    function startNextHand() {
      var st = session.state;
      if (st.phase !== 'handEnd') return;
      session.history = []; view.sel = [];
      session.follow(nextHand(st, T.shuffleOf(allIds(), Math.random)));
      deal();
    }
    function allIds() { var a = [], i; for (i = 0; i < TOTAL; i++) a.push(i); return a; }
    function newGame() {
      view.sel = []; view.flash = '';
      session.reset(newHand(T.shuffleOf(allIds(), Math.random), [0, 0], 0, targetNow()));
      deal();
    }
    // A fresh deal: nobody has seen it, so two people start at a handoff.
    function deal() { seats.begin(function () { repaint(); drive(); }, session.state.turn); }
    t = T.create({
      id: 'canasta', name: 'Canasta', seats: seats, view: view, geo: function (m, st) { return geo(m, st, seats.view()); }, place: function (st, m, v) { syncView(st); return place(st, m, v); }, hud: hud, newGame: newGame, tap: tap, cols: 8, heightShare: 0.085, face: face,
      canPick: function () { return false; },
      stat: function (sec, st) { return Z.fmtTime(sec) + ' · ' + st.scores[seats.view()]; },
      cascadeOrder: function (st) { return st.melds[seats.view()].map(function (mm) { return { id: repCard(mm) }; }); },
      winLines: function (sec, st) { return [TX('canasta.winAfter', { a: st.scores[seats.view()], b: st.scores[1 - seats.view()], hands: Z.plural(st.handNo + 1, 'hand') })]; },
      menuExtra: function () {
        return [T.choiceRow(TX('truco.playTo'), TARGET_KEY, TARGETS.map(function (n) { return { label: String(n), value: n }; }), DEFAULT_TARGET, function () { /* next game */ }), Z.h('p', { class: 'zc-note', text: TX('canasta.targetNote') })];
      },
      rules: TX('canasta.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board; api.drive = drive;
    if (root.ResizeObserver) new root.ResizeObserver(function () { t.paint(); }).observe(table);
    d.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey || d.querySelector('.ar-sheet')) return;
      var st = session.state, k = e.key.toLowerCase();
      if (!st || st.turn !== seats.view() || st.phase !== 'play' || seats.covering) return;
      if (k === 'd' && st.step === 'draw') { drawTurn(); e.preventDefault(); }
      else if (k === 't' && st.step === 'draw') { takeSelected(); e.preventDefault(); }
      else if (k === 'm' && st.step === 'play') { meldSelected(); e.preventDefault(); }
      else if ((k === 'x' || k === 'delete') && st.step === 'play') { discardSelected(); e.preventDefault(); }
      else if (k === 'escape') clearSel();
    });
    newGame();
  }
  boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
