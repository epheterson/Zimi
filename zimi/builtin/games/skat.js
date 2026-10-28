/* ZimiGames: Skat, the German three-player trick game, with the 32-card
   French-suited deck (7 to ace; the international variant, drawn by the Zimi
   French deck). You (south) against West and East. Ten cards each and two
   face down in the skat. Bidding: the middle hand bids to the forehand, the
   winner then answers the rear hand; a bid is the value of the game you
   promise (18, 20, 22, 23, 24, 27, 30, ...). The bidder who wins is the
   declarer, who picks up the skat and puts two cards back (or plays from the
   hand without it, for a bigger score), then names the game: a suit (the
   four jacks and that suit are trump, clubs, spades, hearts, diamonds worth 12,
   11, 10, 9 a point of game), grand (only the jacks are trump, 24) or null
   (no trump and no trick wanted, 23, 35 from the hand). Card points: ace 11,
   ten 10, king 4, queen 3, jack 2, 120 in all; the declarer needs 61 (the
   skat counts for the declarer). A game is worth its base times (matadors
   "with" or "without" the top jacks in a row, plus 1 for the game, 1 for hand,
   1 for schneider (90 or more, or the declarer at 30 or less), 1 for schwarz
   (every trick, or none)). The declarer must reach the bid. A win scores 50
   plus the game value; a loss costs 50 plus twice the value and each defender
   scores 30. If all three pass, the hand is dealt again. A series of 6 or 12
   deals; the highest total wins.

   Card ids: ZimiCards French, suit 0 clubs, 1 diamonds, 2 hearts, 3 spades.
   State: hands[3], skat[2], skat0 (as dealt), orig[3] (hands as dealt),
   dealer, phase ('bid' | 'pick' | 'discard' | 'declare' | 'play' | 'handEnd' |
   'over' | 'passout'), turn, bid {stage, caller, listener, value, waiting},
   declarer, game {type, suit, hand}, trick, leader, won[3], tricks[3],
   scores[3], round, rounds, result, moves. Seats clockwise: 0 you, 1 West,
   2 East; the forehand sits left of the dealer. Pure functions; the page wiring
   at the bottom only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, TX = root.ZimiCards.T;

  var SEATS = 3, HAND = 10, NAMES = [TX('cards.you'), TX('cards.seat.west'), TX('cards.seat.east')], GLYPH = T.SUIT_GLYPH, SUIT_NAMES = ['clubs', 'diamonds', 'hearts', 'spades'];
  var BASE = { 0: 12, 3: 11, 2: 10, 1: 9 }, GRAND_BASE = 24, NULL_BASE = 23, NULL_HAND = 35, WIN_BONUS = 50, LOSS_BONUS = 50, DEFENDER_BONUS = 30, NEED = 61, SCHNEIDER_AT = 90, SCHNEIDER_DEF = 30;
  var BID_VALUES = [18, 20, 22, 23, 24, 27, 30, 33, 35, 36, 40, 44, 45, 46, 48, 50, 54, 55, 59, 60, 63, 66, 70, 72, 77, 80, 84, 88, 90, 96, 99, 100, 108, 110, 120, 121, 126, 130, 132, 135, 140, 143, 144, 150, 153, 156, 160, 162, 168, 170, 176, 180, 192, 198, 204, 210, 216, 240, 264];
  var RANKS = [7, 8, 9, 10, 11, 12, 13, 1], JACK = 11, TRUMP = 4;
  var JACKS = [0, 3, 2, 1]; // clubs, spades, hearts, diamonds: the order of the jacks, highest first
  var POINTS = { 1: 11, 10: 10, 13: 4, 12: 3, 11: 2, 9: 0, 8: 0, 7: 0 };
  var ORDER_SUIT = [7, 8, 9, 12, 13, 10, 1], ORDER_NULL = [7, 8, 9, 10, 11, 12, 13, 1]; // weakest first
  var rankOf = Z.rank, suitOf = Z.suit, pointsOf = function (id) { return POINTS[rankOf(id)]; };
  var DECK = (function () { var o = []; [0, 1, 2, 3].forEach(function (s) { RANKS.forEach(function (r) { o.push(Z.make(r, s)); }); }); return o; })();
  var other = function (a, b) { return [0, 1, 2].filter(function (s) { return s !== a && s !== b; }); };
  var sum = function (ids) { return ids.reduce(function (n, c) { return n + pointsOf(c); }, 0); };
  var gameWord = function (g) { return g.type === 'suit' ? TX('cards.suit.' + SUIT_NAMES[g.suit]) : TX('skat.game.' + g.type); };
  var handWord = function (g) { return g.hand ? TX('skat.wordHand', { word: gameWord(g) }) : gameWord(g); };

  // ── Cards in a game ─────────────────────────────────────────────────────
  // The suit a card follows: trump (4) for the jacks in suit and grand games and for the trump suit.
  function effSuit(id, g) {
    if (g.type !== 'null' && rankOf(id) === JACK) return TRUMP;
    if (g.type === 'suit' && suitOf(id) === g.suit) return TRUMP;
    return suitOf(id);
  }
  // Strength inside its suit (null: A K Q J 10 ...); trumps start at 100.
  function power(id, g) {
    if (g.type === 'null') return ORDER_NULL.indexOf(rankOf(id));
    if (rankOf(id) === JACK) return 100 + 10 - JACKS.indexOf(suitOf(id));
    return (effSuit(id, g) === TRUMP ? 50 : 0) + ORDER_SUIT.indexOf(rankOf(id));
  }
  // Hand order: trump first (jacks, then the trump suit), then the other suits, strongest first.
  var SUIT_ORDER = [0, 1, 3, 2];
  function arrange(ids, g) {
    var game = g || { type: 'suit', suit: -1 };
    var key = function (c) { var e = effSuit(c, game); return (e === TRUMP ? 0 : 1 + SUIT_ORDER.indexOf(e)) * 1000 - power(c, game); };
    return ids.slice().sort(function (a, b) { return key(a) - key(b); });
  }

  // ── Rules: the deal and the bidding ─────────────────────────────────────
  function dealHand(order, round, scores, dealer, rounds) {
    var cards = order.filter(function (c) { return DECK.indexOf(c) >= 0; }), hands = [];
    var fore = (dealer + 1) % SEATS;
    for (var k = 0; k < SEATS; k++) hands[(fore + k) % SEATS] = arrange(cards.slice(k * HAND, (k + 1) * HAND), null);
    var mid = (dealer + 2) % SEATS;
    return {
      hands: hands, skat: cards.slice(SEATS * HAND, SEATS * HAND + 2), skat0: cards.slice(SEATS * HAND, SEATS * HAND + 2), orig: hands.map(function (h) { return h.slice(); }),
      dealer: dealer, phase: 'bid', turn: mid, bid: { stage: 1, caller: mid, listener: fore, value: 0, waiting: 'caller' }, declarer: -1, game: null, trick: [], leader: fore, won: [[], [], []],
      tricks: [0, 0, 0], scores: scores.slice(), round: round, rounds: rounds, result: null, taken: false, moves: 0
    };
  }
  function newGame(order, rounds, dealer) { return dealHand(order, 0, [0, 0, 0], dealer === undefined ? 2 : dealer, rounds || 6); }
  function nextHand(st, order, replay) { return dealHand(order, replay ? st.round : st.round + 1, st.scores, (st.dealer + 1) % SEATS, st.rounds); }
  var nextBid = function (v) { for (var i = 0; i < BID_VALUES.length; i++) if (BID_VALUES[i] > v) return BID_VALUES[i]; return BID_VALUES[BID_VALUES.length - 1]; };

  // What `seat` may do in the bidding: 'bid' (call the next value), 'hold' (stay in at the value called) or 'pass'.
  function bidActions(st, seat) {
    if (st.phase !== 'bid' || st.turn !== seat) return [];
    return st.bid.waiting === 'caller' ? ['bid', 'pass'] : ['hold', 'pass'];
  }
  function endStage(s, winner) {
    var b = s.bid;
    if (b.stage === 1) {
      s.bid = { stage: 2, caller: s.dealer, listener: winner, value: b.value, waiting: 'caller' }; s.turn = s.dealer;
      return s;
    }
    s.declarer = winner; s.phase = 'pick'; s.turn = winner;
    return s;
  }
  function bidAct(st, seat, type) {
    if (bidActions(st, seat).indexOf(type) < 0) return st;
    var s = Z.clone(st), b = s.bid;
    s.moves++;
    if (type === 'bid') { b.value = nextBid(b.value); b.waiting = 'listener'; s.turn = b.listener; return s; }
    if (type === 'hold') { b.waiting = 'caller'; s.turn = b.caller; return s; }
    return endStage(s, b.waiting === 'caller' ? b.listener : b.caller);
  }
  var bidValue = function (st) { return Math.max(18, st.bid.value); };

  // ── The declarer's choices ──────────────────────────────────────────────
  function pickAct(st, seat, type) {
    if (st.phase !== 'pick' || st.declarer !== seat) return st;
    if (type === 'throw' && st.bid.value !== 0) return st;
    var s = Z.clone(st);
    s.moves++;
    if (type === 'throw') { s.phase = 'passout'; return s; }
    if (type === 'take') { s.hands[seat] = arrange(s.hands[seat].concat(s.skat), null); s.taken = true; s.phase = 'discard'; return s; }
    s.phase = 'declare'; // hand
    return s;
  }
  function discard(st, seat, ids) {
    if (st.phase !== 'discard' || st.declarer !== seat || ids.length !== 2 || ids[0] === ids[1] || !ids.every(function (c) { return st.hands[seat].indexOf(c) >= 0; })) return st;
    var s = Z.clone(st);
    s.hands[seat] = s.hands[seat].filter(function (c) { return ids.indexOf(c) < 0; });
    s.skat = ids.slice(); s.phase = 'declare'; s.moves++;
    return s;
  }
  function declare(st, seat, type, suit) {
    if (st.phase !== 'declare' || st.declarer !== seat) return st;
    if (['suit', 'grand', 'null'].indexOf(type) < 0 || (type === 'suit' && [0, 1, 2, 3].indexOf(suit) < 0)) return st;
    var s = Z.clone(st);
    s.game = { type: type, suit: type === 'suit' ? suit : -1, hand: !s.taken };
    s.hands = s.hands.map(function (h) { return arrange(h, s.game); });
    s.phase = 'play'; s.leader = s.turn = (s.dealer + 1) % SEATS; s.moves++;
    return s;
  }

  // ── Tricks ──────────────────────────────────────────────────────────────
  function legalPlays(st, seat) {
    var hand = st.hands[seat], g = st.game;
    if (!st.trick.length) return hand.slice();
    var lead = effSuit(st.trick[0].id, g), follow = hand.filter(function (c) { return effSuit(c, g) === lead; });
    return follow.length ? follow : hand.slice();
  }
  function isLegal(st, seat, id) { return st.phase === 'play' && st.trick.length < SEATS && st.turn === seat && legalPlays(st, seat).indexOf(id) >= 0; }
  function playCard(st, seat, id) {
    var s = Z.clone(st);
    s.hands[seat].splice(s.hands[seat].indexOf(id), 1);
    s.trick.push({ seat: seat, id: id }); s.moves++;
    if (s.trick.length < SEATS) s.turn = (seat + 1) % SEATS;
    return s;
  }
  function trickWinner(trick, g) {
    var lead = effSuit(trick[0].id, g), best = trick[0];
    trick.forEach(function (t) {
      var a = effSuit(t.id, g), b = effSuit(best.id, g);
      if (a === b ? power(t.id, g) > power(best.id, g) : a === TRUMP || (b !== TRUMP && a === lead)) best = t;
    });
    return best.seat;
  }

  // ── Scoring ─────────────────────────────────────────────────────────────
  // "With" or "without" n: the run of top trumps (the four jacks, then the trump suit) the declarer holds or lacks.
  function matadors(cards, g) {
    var seq = JACKS.map(function (s) { return Z.make(JACK, s); });
    if (g.type === 'suit') ORDER_SUIT.slice().reverse().forEach(function (r) { if (r !== JACK) seq.push(Z.make(r, g.suit)); });
    var has = function (c) { return cards.indexOf(c) >= 0; }, first = has(seq[0]), n = 0;
    while (n < seq.length && has(seq[n]) === first) n++;
    return { n: n, with: first };
  }
  function gameValue(g, cards, opts) {
    if (g.type === 'null') return g.hand ? NULL_HAND : NULL_BASE;
    var m = matadors(cards, g).n, base = g.type === 'grand' ? GRAND_BASE : BASE[g.suit];
    return base * (m + 1 + (g.hand ? 1 : 0) + (opts.schneider ? 1 : 0) + (opts.schwarz ? 1 : 0));
  }
  // The result of a played hand: { won, value, points, matadors, ... , delta[3] }.
  function scoreHand(st) {
    var g = st.game, d = st.declarer, bid = bidValue(st), delta = [0, 0, 0], r = { declarer: d, game: g, bid: bid };
    var all = st.orig[d].concat(st.skat0), took = st.tricks[d];
    if (g.type === 'null') {
      r.value = gameValue(g, all, {}); r.won = took === 0 && r.value >= bid; r.points = null;
    } else {
      var pts = sum(st.won[d]) + sum(st.skat);
      r.points = pts;
      r.schneider = pts >= SCHNEIDER_AT || pts <= SCHNEIDER_DEF; r.schwarz = took === 10 || took === 0;
      r.matadors = matadors(all, g);
      r.value = gameValue(g, all, r);
      r.won = pts >= NEED && r.value >= bid;
      if (!r.won && r.value < bid) { var base = g.type === 'grand' ? GRAND_BASE : BASE[g.suit]; r.value = base * Math.ceil(bid / base); r.overbid = pts >= NEED; }
    }
    if (r.won) delta[d] = WIN_BONUS + r.value;
    else { delta[d] = -(LOSS_BONUS + 2 * r.value); other(d, d).forEach(function (s) { delta[s] = DEFENDER_BONUS; }); }
    r.delta = delta;
    return r;
  }
  function resolveTrick(st) {
    var s = Z.clone(st), w = trickWinner(s.trick, s.game);
    s.won[w] = s.won[w].concat(s.trick.map(function (t) { return t.id; }));
    s.tricks[w]++;
    s.trick = []; s.leader = s.turn = w;
    if (!s.hands[0].length) {
      var r = scoreHand(s);
      s.result = r; s.scores = s.scores.map(function (v, i) { return v + r.delta[i]; });
      s.phase = s.round + 1 >= s.rounds ? 'over' : 'handEnd';
    }
    return s;
  }
  function gameWinner(scores) {
    var top = Math.max.apply(null, scores), leaders = scores.map(function (v, i) { return v === top ? i : -1; }).filter(function (i) { return i >= 0; });
    return leaders.length === 1 ? leaders[0] : -1;
  }

  // ── The computer players ────────────────────────────────────────────────
  var jacksIn = function (h) { return h.filter(function (c) { return rankOf(c) === JACK; }); };
  // What a hand can promise: { max bid, best game }.
  function estimate(hand) {
    var jacks = jacksIn(hand).length, aces = hand.filter(function (c) { return rankOf(c) === 1; }).length, best = { value: 0, game: null };
    [0, 3, 2, 1].forEach(function (s) {
      var g = { type: 'suit', suit: s }, tr = hand.filter(function (c) { return effSuit(c, g) === TRUMP; }).length, offAces = hand.filter(function (c) { return rankOf(c) === 1 && suitOf(c) !== s; }).length;
      var strong = tr >= 5 && (jacks >= 2 || tr >= 6) && jacks + offAces >= 2, ok = strong || (tr >= 7);
      var v = ok ? gameValue(g, hand, {}) : 0;
      if (v > best.value) best = { value: v, game: g };
    });
    if (jacks >= 3 && aces >= 2) { var gv = gameValue({ type: 'grand', suit: -1 }, hand, {}); if (gv > best.value) best = { value: gv, game: { type: 'grand', suit: -1 } }; }
    var cap = 0;
    BID_VALUES.forEach(function (v) { if (v <= best.value) cap = v; });
    return { max: cap, game: best.game };
  }
  function aiBid(st, seat) {
    var max = estimate(st.hands[seat]).max, acts = bidActions(st, seat), b = st.bid;
    if (acts.indexOf('bid') >= 0) return max >= nextBid(b.value) && max >= BID_VALUES[0] ? 'bid' : 'pass';
    return max >= b.value ? 'hold' : 'pass';
  }
  function aiPick(st, seat) {
    var est = estimate(st.hands[seat]);
    if (st.bid.value === 0 && est.max < BID_VALUES[0]) return 'throw';
    return 'take';
  }
  // Put back the two least useful cards: low-point cards of the weakest suits, never trump.
  function aiDiscard(st, seat) {
    var hand = st.hands[seat], est = estimate(hand), g = est.game || { type: 'suit', suit: -1 };
    var key = function (c) { return (effSuit(c, g) === TRUMP ? 1000 : 0) + pointsOf(c) * 4 + (rankOf(c) === 1 ? 50 : 0) - hand.filter(function (x) { return suitOf(x) === suitOf(c); }).length; };
    var pool = hand.slice().sort(function (a, b) { return key(a) - key(b); });
    return [pool[0], pool[1]];
  }
  function aiDeclare(st, seat) {
    var est = estimate(st.hands[seat]);
    if (est.game) return est.game;
    // A weak hand that must play: the longest suit.
    var best = 0, bs = -1;
    [0, 3, 2, 1].forEach(function (s) { var n = st.hands[seat].filter(function (c) { return effSuit(c, { type: 'suit', suit: s }) === TRUMP; }).length; if (n > bs) { bs = n; best = s; } });
    return { type: 'suit', suit: best };
  }
  function aiCard(st, seat) {
    var legal = legalPlays(st, seat), g = st.game, d = st.declarer, pw = function (c) { return power(c, g); };
    if (legal.length === 1) return legal[0];
    var low = T.minBy(legal, function (c) { return pointsOf(c) * 100 + pw(c); });
    if (g.type === 'null') return T.minBy(legal, pw); // no trick wanted by the declarer, and the defenders only need to stay clear of the lead
    var mine = seat === d, trumps = legal.filter(function (c) { return effSuit(c, g) === TRUMP; });
    if (!st.trick.length) {
      if (mine && trumps.length >= 3) return T.maxBy(trumps, pw);
      var aces = legal.filter(function (c) { return rankOf(c) === 1 && effSuit(c, g) !== TRUMP; });
      if (aces.length) return aces[0];
      var plain = legal.filter(function (c) { return effSuit(c, g) !== TRUMP; });
      if (!mine && plain.length) return T.minBy(plain, function (c) { return pointsOf(c) * 100 + pw(c); });
      return mine && trumps.length ? T.minBy(trumps, pw) : low;
    }
    var win = st.trick.reduce(function (b, t) { return trickWinner([b, t], g) === t.seat ? t : b; }, st.trick[0]);
    var beats = legal.filter(function (c) { return trickWinner(st.trick.concat([{ seat: seat, id: c }]), g) === seat; });
    var partner = !mine && win.seat !== d && win.seat !== seat;
    if (partner) return T.maxBy(legal, function (c) { return pointsOf(c) * 100 - pw(c); }); // feed the partner's trick
    if (beats.length) return T.minBy(beats, pw);
    return low;
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  // Where a seat sits on screen for the viewer (bottom, then clockwise).
  var posFrom = function (seat, V) { return T.posOf((seat - V + SEATS) % SEATS, SEATS); };
  function geo(m, st) { return T.geometry(m, T.rowsFor(m, Math.max(st.hands[0].length, HAND))); }
  // view: { sel: [ids] chosen to put back }
  function place(st, m, view) {
    var g = geo(m, st), slots = T.feltSlots(g), cards = [], full = st.trick.length === SEATS, sweep = view && full ? view.sweep : null, sel = (view && view.sel) || [];
    var L = T.looking(view), V = L.V, up = L.up, pos = function (seat) { return posFrom(seat, V); };
    var myTurn = st.phase === 'play' && st.turn === V && !full, picking = st.phase === 'discard' && st.declarer === V;
    var hand = T.handCards(g, st.hands[V], function (id) {
      var on = sel.indexOf(id) >= 0;
      return { up: up, dim: up && myTurn && !isLegal(st, V, id), mark: on, raise: on, glow: up && picking && st.skat.indexOf(id) >= 0 && !on && !view.touched, label: Z.cardName(id) + (on ? TX('skat.aria.putBack') : '') };
    }, function (a, b) { return effSuit(a, st.game || { type: 'suit', suit: -1 }) !== effSuit(b, st.game || { type: 'suit', suit: -1 }); });
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    [1, 2].forEach(function (k) { var seat = (V + k) % SEATS; cards = cards.concat(T.fan(g, pos(seat), st.hands[seat], false)); });
    if (st.phase === 'bid' || st.phase === 'pick' || st.phase === 'declare') st.skat.forEach(function (id, k) { cards.push({ id: id, pile: 'skat', idx: k, x: Math.round(g.cx - g.cw + k * g.cw * 1.1), y: Math.round(g.cy - g.ch / 2), up: false }); });
    return { height: m.H, slots: slots, cards: cards.concat(T.trickCards(g, st.trick, sweep, pos, view && view.win)) };
  }

  var api = {
    NAMES: NAMES, DECK: DECK, BID_VALUES: BID_VALUES, effSuit: effSuit, power: power, arrange: arrange, dealHand: dealHand, newGame: newGame, nextHand: nextHand, nextBid: nextBid,
    bidActions: bidActions, bidAct: bidAct, pickAct: pickAct, discard: discard, declare: declare, legalPlays: legalPlays, isLegal: isLegal, playCard: playCard, trickWinner: trickWinner,
    resolveTrick: resolveTrick, matadors: matadors, gameValue: gameValue, scoreHand: scoreHand, gameWinner: gameWinner, estimate: estimate, aiBid: aiBid, aiPick: aiPick,
    aiDiscard: aiDiscard, aiDeclare: aiDeclare, aiCard: aiCard, bidValue: bidValue, geo: geo, place: place, gameWord: gameWord
  };
  root.ZimiSkat = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 650, HOLD_MS = 1000, SWEEP_MS = 380, ROUNDS_KEY = 'skat.rounds', ROUND_CHOICES = [6, 12];
  function boot() {
    var t, board, session, view = { sweep: null, flash: '', sel: [], touched: false, note: '' }, tg, seats, who, mine;
    // Who is acting now: the declarer while picking, discarding and declaring, else the player to bid or play.
    var actor = function (st) { return st.phase === 'pick' || st.phase === 'discard' || st.phase === 'declare' ? st.declarer : st.turn; };
    function resultLines(st) {
      var r = st.result, g = r.game, lines = [], dn = who(r.declarer), word = handWord(g);
      if (g.type === 'null') lines.push(TX('skat.line.null' + (g.hand ? 'Hand' : ''), { name: dn }) + ' ' + TX(r.won ? 'skat.line.noTrick' : r.value < r.bid ? 'skat.line.tooMuch' : 'skat.line.tookTrick', { bid: r.bid }));
      else {
        lines.push(TX('skat.line.played', { name: dn, word: word, matadors: r.matadors ? ', ' + TX(r.matadors.with ? 'skat.with' : 'skat.without', { n: r.matadors.n }) : '', points: r.points, extra: (r.schneider ? ', ' + TX('skat.schneider') : '') + (r.schwarz ? ', ' + TX('skat.schwarz') : '') }));
        lines.push(TX(r.overbid ? 'skat.line.valueOver' : 'skat.line.value', { value: r.value, bid: r.bid }));
      }
      lines.push(r.won ? TX('skat.line.won', { name: dn, delta: (r.delta[r.declarer] > 0 ? '+' : '') + r.delta[r.declarer] }) : TX('skat.line.lost', { name: dn, delta: r.delta[r.declarer], bonus: DEFENDER_BONUS }));
      lines.push(TX('skat.line.totals', { list: tg.order().map(function (q) { return who(q) + ' ' + st.scores[q]; }).join(', ') }));
      return lines;
    }
    var bidText = function (st) { return st.bid.value ? ' ' + TX('skat.at', { n: st.bid.value }) : ''; };
    function hud(st) {
      var full = st.trick.length === SEATS;
      var chips = tg.order().map(function (seat) {
        var name = who(seat), text = String(st.scores[seat]);
        if (st.declarer === seat) text += ' ★';
        return { name: name, text: text, turn: st.turn === seat && !full && st.phase !== 'handEnd' && st.phase !== 'over' };
      });
      var out = { chips: chips, text: '', trump: st.game && st.game.type === 'suit' ? st.game.suit : undefined, fact: TX('skat.fact', { n: st.round + 1, of: st.rounds }) + (st.game && st.game.type !== 'suit' ? ' \u00b7 ' + handWord(st.game) : '') };
      var act = function (label, fn, extra) { return Object.assign({ label: label, onclick: fn }, extra || {}); };
      if (st.phase === 'bid') {
        var b = st.bid, me = mine(st.turn), mineNow = me;
        out.text = (view.note && !(mineNow && b.waiting !== 'caller') ? view.note + ' ' : '') + (mineNow ? (seats.hotseat() ? TX('skat.nameBid', { name: who(st.turn) }) + ' ' : '') + (b.waiting === 'caller' ? TX(seats.hotseat() ? 'skat.bidQ' : 'skat.yourBidQ', { n: nextBid(b.value) }) : TX('skat.hold', { name: who(b.caller), n: b.value })) : seats.person(st.turn) ? TX('euchre.deciding', { name: who(st.turn) }) : TX('cards.thinking', { name: who(st.turn) }));
        if (mineNow) out.choices = b.waiting === 'caller' ? [act(TX('skat.bid', { n: nextBid(b.value) }), function () { bid('bid'); }), act(TX('cards.pass'), function () { bid('pass'); })] : [act(TX('skat.holdBtn', { n: b.value }), function () { bid('hold'); }), act(TX('cards.pass'), function () { bid('pass'); })];
      } else if (st.phase === 'pick') {
        var dn = who(st.declarer);
        if (mine(st.declarer)) {
          out.text = TX(seats.isYou(st.declarer) ? 'skat.youPlay' : 'skat.plays', { name: who(st.declarer) }) + bidText(st) + '. ' + TX('skat.takeOrHand');
          out.choices = [act(TX('skat.take'), function () { pick('take'); }), act(TX('skat.playHand'), function () { pick('hand'); })].concat(st.bid.value === 0 ? [act(TX('skat.passHand'), function () { pick('throw'); })] : []);
        } else out.text = TX('skat.plays', { name: dn }) + bidText(st);
      } else if (st.phase === 'discard') {
        if (mine(st.declarer)) {
          out.text = TX('skat.tapTwo');
          out.choices = [act(TX('skat.putBack', { n: view.sel.length }), function () { putBack(); }, { disabled: view.sel.length !== 2 })];
        } else out.text = TX('skat.takesSkat', { name: who(st.declarer) });
      } else if (st.phase === 'declare') {
        if (mine(st.declarer)) {
          out.text = TX(st.taken ? 'skat.nameGame' : 'skat.nameGameHand');
          out.choices = [0, 3, 2, 1].map(function (s) { return act(GLYPH[s], function () { call('suit', s); }, { aria: TX('skat.suitAria', { suit: TX('cards.suit.' + SUIT_NAMES[s]), n: BASE[s] }), cls: s === 1 || s === 2 ? 'ct-red' : '' }); }).concat([act(TX('skat.game.grand'), function () { call('grand'); }), act(TX('skat.game.null'), function () { call('null'); })]);
        } else out.text = TX('skat.choosing', { name: who(st.declarer) });
      } else if (st.phase === 'handEnd') { out.text = TX('skat.dealOver'); out.label = TX('skat.nextDeal'); out.action = tg.startNextHand; }
      else if (st.phase === 'over') out.text = TX('skat.seriesOver');
      else if (st.phase === 'passout') out.text = TX('belote.redeal');
      else if (full) out.text = tg.trickText(trickWinner(st.trick, st.game));
      else out.text = tg.turnText(st.turn);
      return out;
    }

    function drive() {
      var st = session.state;
      if (st.phase === 'passout') { session.later(function () { view.note = ''; session.follow(nextHand(st, Z.shuffled(Math.random), true)); tg.deal(); }, 1100); return; }
      if (st.phase === 'bid') { if (seats.person(st.turn)) seats.ensure(st.turn, tg.repaint); else session.later(aiBidTurn, AI_MS); return; }
      if (st.phase === 'pick' || st.phase === 'discard' || st.phase === 'declare') { if (seats.person(st.declarer)) seats.ensure(st.declarer, tg.repaint); else session.later(aiDeclarerTurn, AI_MS); return; }
      tg.turn(st);
    }
    function aiBidTurn() {
      var st = session.state;
      if (st.phase !== 'bid' || seats.person(st.turn)) return;
      var seat = st.turn, a = aiBid(st, seat);
      view.note = TX(a === 'bid' ? 'skat.note.bids' : a === 'hold' ? 'skat.note.holds' : 'skat.note.passes', { name: who(seat), n: a === 'bid' ? nextBid(st.bid.value) : 0 }) + '.';
      session.follow(bidAct(st, seat, a));
      drive();
    }
    function aiDeclarerTurn() {
      var st = session.state, seat = st.declarer;
      if (seats.person(seat)) return;
      if (st.phase === 'pick') { var a = aiPick(st, seat); view.note = ''; session.follow(pickAct(st, seat, a)); if (a === 'throw') t.flash(TX('skat.throws', { name: who(seat) })); drive(); }
      else if (st.phase === 'discard') { session.follow(discard(st, seat, aiDiscard(st, seat))); drive(); }
      else if (st.phase === 'declare') {
        var g = aiDeclare(st, seat), ns = declare(st, seat, g.type, g.suit);
        session.follow(ns); t.flash(TX('skat.plays', { name: who(seat) }) + ' ' + handWord(ns.game)); drive();
      }
    }
    // The hand's summary: who won and by how much, how the game was played, and the running score.
    function handSummary(st) {
      var r = st.result, dn = who(r.declarer), lines = resultLines(st), top = Math.max.apply(null, st.scores), d = r.delta[r.declarer];
      return {
        headline: TX(r.won ? 'skat.sum.won' : 'skat.sum.lost', { name: dn, delta: Math.abs(d) }),
        detail: lines.slice(0, -2).concat(r.won ? [] : [TX('skat.sum.defend', { bonus: DEFENDER_BONUS })]),
        rows: tg.order().map(function (q) { return { name: who(q), delta: r.delta[q], total: st.scores[q], lead: st.scores[q] === top }; })
      };
    }
    function handOver() {
      var st = session.state, s = handSummary(st);
      T.summarySheet(Object.assign({ title: TX('skat.fact', { n: st.round + 1, of: st.rounds }), actions: [{ label: TX('skat.nextDeal'), primary: true, onclick: tg.startNextHand }] }, s));
    }
    function gameOver() {
      var st = session.state, w = gameWinner(st.scores), me = seats.view(), hot = seats.hotseat();
      var lines = resultLines(st).concat([w === me && !hot ? TX('skat.winYou', { n: st.scores[me] }) : w >= 0 ? TX('skat.winName', { name: who(w), n: st.scores[w] }) : TX('skat.tied')]);
      if (w === me && !hot) session.win(st.scores[me]); else session.lose(w < 0 ? 'draw' : hot ? { name: who(w) } : '', lines, hot ? undefined : st.scores[me]);
    }
    function bid(type) { var st = session.state; if (st.phase !== 'bid' || !mine(st.turn)) return; view.note = ''; session.commit(bidAct(st, st.turn, type)); drive(); }
    function pick(type) { var st = session.state; if (st.phase !== 'pick' || !mine(st.declarer)) return; view.sel = []; view.touched = false; session.commit(pickAct(st, st.declarer, type)); drive(); }
    function putBack() { var st = session.state; if (st.phase !== 'discard' || !mine(st.declarer) || view.sel.length !== 2) return; var ids = view.sel.slice(); view.sel = []; session.commit(discard(st, st.declarer, ids)); drive(); }
    function call(type, suit) { var st = session.state; if (st.phase !== 'declare' || !mine(st.declarer)) return; session.commit(declare(st, st.declarer, type, suit)); drive(); }
    // The two cards to put back are picked by tapping them.
    function tapSkat(st, id) {
      if (st.phase !== 'discard' || !mine(st.declarer)) return undefined;
      var at = view.sel.indexOf(id);
      view.touched = true;
      if (at >= 0) view.sel.splice(at, 1); else if (view.sel.length < 2) view.sel.push(id); else { t.flash(TX('skat.twoOnly')); return false; }
      board.refresh(); t.paint();
      return true;
    }
    function whyNot(st) { var lead = effSuit(st.trick[0].id, st.game); return lead === TRUMP ? TX('skat.followTrump') : TX('cards.follow', { suit: TX('cards.suit.' + SUIT_NAMES[lead]) }); }
    function newSeries() {
      var rounds = Z.store.get(ROUNDS_KEY, 6);
      tg.restart(newGame(Z.shuffled(Math.random), ROUND_CHOICES.indexOf(rounds) >= 0 ? rounds : 6, Math.floor(Math.random() * SEATS)));
    }

    tg = T.trickGame({
      id: 'skat', n: SEATS, view: view, ms: { ai: AI_MS, hold: HOLD_MS, sweep: SWEEP_MS }, drive: drive, handEnd: 'handEnd', actor: actor, control: function (st) { return st.turn; },
      seatOpts: { cpuNames: [0, 1, 2].map(root.ZimiSeats.cpuName) },   // three players, no partners: named computers from the shared list
      winner: function (st) { return trickWinner(st.trick, st.game); }, resolve: resolveTrick, nextHand: nextHand, handOver: handOver, gameOver: gameOver,
      legal: isLegal, why: whyNot, play: playCard, aiPlay: aiCard, pretap: tapSkat, clear: function () { view.note = ''; view.sel = []; view.touched = false; }
    });
    seats = tg.seats; mine = tg.mine; who = seats.name;
    t = tg.create({
      name: 'Skat', geo: geo, place: place, hud: hud, newGame: newSeries, heightShare: 0.13,
      stat: function (sec, st) { return Z.fmtTime(sec) + ' · ' + st.scores[seats.view()]; },
      cascadeOrder: function (st) { return st.won[seats.view()].slice(0, 24).map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return resultLines(st).concat([TX('skat.winYou', { n: st.scores[seats.view()] })]); },
      menuExtra: function () { return [T.choiceRow(TX('skat.deals'), ROUNDS_KEY, ROUND_CHOICES.map(function (n) { return { value: n, label: String(n) }; }), 6, function () {}), Z.h('p', { class: 'zc-note', text: TX('skat.lengthNote') })]; },
      rules: TX('skat.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    newSeries();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
