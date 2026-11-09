/* ZimiGames: Oh Hell, three or four players: you (south) against the computer players. Each hand deals the same number of cards to
   everyone (five down to one and back up, or seven down to one and back up) and turns one more card for trump. Everyone bids how many
   tricks they will take, the dealer last, and the dealer may not bid what makes the bids add up to the number of tricks, so someone
   always misses. You must follow the suit led if you can; the highest trump wins the trick, else the highest card of the suit led.
   A hand scores one point for each trick taken, and ten more for taking exactly as many as you bid. The most points after the last hand wins.

   State: players, sizes (cards per hand, hand by hand), handNo, hands[n], bids[n] (null until bid), tricks[n], trump, trumpCard, dealer,
   turn, leader, trick [{seat, id}], played (ids of finished tricks), scores[n], phase ('bid' | 'play' | 'handEnd' | 'over'), result.
   Seats run clockwise from you. Pure functions; the page wiring only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;

  var LADDERS = { short: [5, 4, 3, 2, 1, 2, 3, 4, 5], full: [7, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 7] };
  var EXACT_BONUS = 10, LADDER_KEY = 'ohhell.length', DEFAULT_LADDER = 'short', PLAYERS_KEY = 'ohhell.players', DEFAULT_PLAYERS = 3;
  var high = T.rankHigh;

  // ── Rules ───────────────────────────────────────────────────────────────
  // `order` is a shuffled 52. Cards go round the table, then one more is turned for trump.
  function dealHand(order, players, sizes, handNo, scores, dealer) {
    var size = sizes[handNo], hands = [], s, tc = order[players * size];
    for (s = 0; s < players; s++) hands.push(T.sortHand(order.slice(s * size, (s + 1) * size), high));
    return {
      players: players, sizes: sizes, handNo: handNo, hands: hands, bids: hands.map(function () { return null; }), tricks: hands.map(function () { return 0; }),
      trump: Z.suit(tc), trumpCard: tc, dealer: dealer, turn: (dealer + 1) % players, leader: (dealer + 1) % players, trick: [], played: [],
      scores: scores.slice(), phase: 'bid', result: null, moves: 0
    };
  }
  function startGame(order, players, ladder, dealer) {
    var sizes = LADDERS[ladder] || LADDERS[DEFAULT_LADDER];
    return dealHand(order, players, sizes, 0, new Array(players).fill(0), dealer === undefined ? players - 1 : dealer);
  }
  function nextHand(st, order) { return dealHand(order, st.players, st.sizes, st.handNo + 1, st.scores, (st.dealer + 1) % st.players); }

  var size = function (st) { return st.sizes[st.handNo]; };
  var bidTotal = function (st) { return st.bids.reduce(function (n, b) { return n + (b === null ? 0 : b); }, 0); };
  // The bid the dealer may not make (the one that makes the bids add up to the tricks), else -1.
  function forbiddenBid(st, seat) {
    if (seat !== st.dealer) return -1;
    var f = size(st) - bidTotal(st);
    return f >= 0 && f <= size(st) ? f : -1;
  }
  function canBid(st, seat, n) { return st.phase === 'bid' && st.turn === seat && n >= 0 && n <= size(st) && n !== forbiddenBid(st, seat); }
  function placeBid(st, seat, n) {
    var s = Z.clone(st);
    s.bids[seat] = n; s.moves++;
    if (s.bids.every(function (b) { return b !== null; })) { s.phase = 'play'; s.turn = s.leader = (s.dealer + 1) % s.players; } else s.turn = (seat + 1) % s.players;
    return s;
  }

  function legalPlays(st, seat) {
    var hand = st.hands[seat];
    if (!st.trick.length) return hand.slice();
    var lead = Z.suit(st.trick[0].id), follow = hand.filter(function (c) { return Z.suit(c) === lead; });
    return follow.length ? follow : hand.slice();
  }
  function whyNot(st) { return TX('cards.follow', { suit: TX('cards.suit.' + Z.SUITS[Z.suit(st.trick[0].id)]) }); }
  function isLegal(st, seat, id) { return st.phase === 'play' && st.trick.length < st.players && st.turn === seat && legalPlays(st, seat).indexOf(id) >= 0; }
  function playCard(st, seat, id) {
    var s = Z.clone(st);
    s.hands[seat].splice(s.hands[seat].indexOf(id), 1);
    s.trick.push({ seat: seat, id: id }); s.moves++;
    if (s.trick.length < s.players) s.turn = (seat + 1) % s.players;
    return s;
  }
  // Does `a` beat `b` in a trick led in `lead`, with `trump`?
  function beats(a, b, lead, trump) {
    var sa = Z.suit(a), sb = Z.suit(b);
    if (sa === sb) return high(a) > high(b);
    return sa === trump || (sb !== trump && sa === lead && sb !== lead);
  }
  function trickWinner(trick, trump) {
    var lead = Z.suit(trick[0].id), best = trick[0];
    trick.forEach(function (t) { if (beats(t.id, best.id, lead, trump)) best = t; });
    return best.seat;
  }
  function resolveTrick(st) {
    var s = Z.clone(st), w = trickWinner(s.trick, s.trump);
    s.tricks[w]++;
    s.played = s.played.concat(s.trick.map(function (t) { return t.id; }));
    s.trick = []; s.leader = s.turn = w;
    if (s.played.length === s.players * size(s)) endHand(s);
    return s;
  }
  // A trick taken is a point; taking exactly what you bid is ten more.
  function handPoints(bid, took) { return took + (bid === took ? EXACT_BONUS : 0); }
  function endHand(s) {
    var pts = s.tricks.map(function (took, seat) { return handPoints(s.bids[seat], took); });
    s.result = { points: pts, made: s.tricks.map(function (took, seat) { return took === s.bids[seat]; }) };
    s.scores = s.scores.map(function (v, seat) { return v + pts[seat]; });
    s.phase = s.handNo + 1 >= s.sizes.length ? 'over' : 'handEnd';
  }
  // The seats with the most points: one, or the seats that tie.
  function winners(scores) {
    var most = Math.max.apply(null, scores);
    return scores.map(function (v, i) { return v === most ? i : -1; }).filter(function (i) { return i >= 0; });
  }

  // ── The computer players ────────────────────────────────────────────────
  // About how many tricks a hand takes: high trumps, aces, long trump holdings, and a hand with no trump counts for little.
  var TRUMP_VALUE = { 14: 0.95, 13: 0.8, 12: 0.6, 11: 0.45, 10: 0.35 }, SIDE_VALUE = { 14: 0.7, 13: 0.3 };
  function estimate(hand, trump, players) {
    var est = 0, trumps = hand.filter(function (c) { return Z.suit(c) === trump; }).length;
    hand.forEach(function (c) {
      var r = high(c);
      if (Z.suit(c) === trump) est += TRUMP_VALUE[r] !== undefined ? TRUMP_VALUE[r] : 0.18 + 0.02 * r / 14;
      else est += (SIDE_VALUE[r] || 0) * (players <= 3 ? 1 : 0.9);
    });
    return est + Math.max(0, trumps - 3) * 0.15;
  }
  function aiBid(st, seat) {
    var n = size(st), want = Math.max(0, Math.min(n, Math.round(estimate(st.hands[seat], st.trump, st.players)))), bad = forbiddenBid(st, seat);
    if (want !== bad) return want;
    // The dealer's forbidden bid: whichever neighbour is nearer the estimate.
    var e = estimate(st.hands[seat], st.trump, st.players), up = want + 1 <= n ? want + 1 : -1, down = want - 1 >= 0 ? want - 1 : -1;
    if (up < 0) return down;
    if (down < 0) return up;
    return e >= want ? up : down;
  }
  var strength = function (c, trump) { return (Z.suit(c) === trump ? 100 : 0) + high(c); };
  function aiPick(st, seat) {
    var legal = legalPlays(st, seat), trump = st.trump, trick = st.trick;
    if (legal.length === 1) return legal[0];
    var need = st.bids[seat] - st.tricks[seat], left = st.hands[seat].length;
    var lowest = T.minBy(legal, function (c) { return strength(c, trump); }), highest = T.maxBy(legal, function (c) { return strength(c, trump); });
    var hunting = need > 0;   // a missed bid still scores a point for each trick, so it hunts too when it cannot make it
    if (!trick.length) {
      if (hunting) return highest;
      var offs = legal.filter(function (c) { return Z.suit(c) !== trump; });
      return T.minBy(offs.length ? offs : legal, function (c) { return high(c); });
    }
    var lead = Z.suit(trick[0].id), winning = trick.reduce(function (b, t) { return beats(t.id, b.id, lead, trump) ? t : b; }, trick[0]);
    var winners = legal.filter(function (c) { return beats(c, winning.id, lead, trump); });
    if (hunting || need > left) return winners.length ? T.minBy(winners, function (c) { return strength(c, trump); }) : lowest;
    // Done with tricks: slip under the winner with the biggest card that does not win it, else give up the smallest winner.
    var under = legal.filter(function (c) { return winners.indexOf(c) < 0; });
    return under.length ? T.maxBy(under, function (c) { return strength(c, trump); }) : T.minBy(winners, function (c) { return strength(c, trump); });
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  function geo(m, st) { return T.geometry(m, T.rowsFor(m, st.hands[0].length)); }
  function place(st, m, view) {
    var g = geo(m, st), slots = T.feltSlots(g), cards = [], L = T.looking(view), V = L.V, up = L.up, rel = function (seat) { return (seat - V + st.players) % st.players; };
    var full = st.trick.length === st.players, myTurn = st.phase === 'play' && st.turn === V && !full, sweep = view && full ? view.sweep : null;
    var hand = T.handCards(g, st.hands[V], function (id) { return { up: up, dim: up && myTurn && !isLegal(st, V, id) }; }, function (a, b) { return Z.suit(a) !== Z.suit(b); });
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    for (var r = 1; r < st.players; r++) cards = cards.concat(T.fan(g, T.SEAT_POS[st.players][r], st.hands[(V + r) % st.players], false));
    return { height: m.H, slots: slots, cards: cards.concat(T.trickCards(g, st.trick, sweep, function (seat) { return T.SEAT_POS[st.players][rel(seat)]; }, view && view.win)) };
  }

  var api = {
    LADDERS: LADDERS, EXACT_BONUS: EXACT_BONUS, dealHand: dealHand, newGame: startGame, nextHand: nextHand, forbiddenBid: forbiddenBid, canBid: canBid, placeBid: placeBid,
    legalPlays: legalPlays, isLegal: isLegal, playCard: playCard, trickWinner: trickWinner, resolveTrick: resolveTrick, handPoints: handPoints, winners: winners,
    estimate: estimate, aiBid: aiBid, aiPick: aiPick, geo: geo, place: place
  };
  root.ZimiOhHell = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 560, HOLD_MS = 1000, SWEEP_MS = 380;
  // The seats at the table are made once, so a change to three or four applies when the page is next opened: a kept game keeps its own.
  function tableSize() {
    var kept = root.ZimiShell && root.ZimiShell.saved ? root.ZimiShell.saved() : null;
    if (kept && kept.id === 'ohhell' && kept.state && (kept.state.players === 3 || kept.state.players === 4)) return kept.state.players;
    var n = Z.store.get(PLAYERS_KEY, DEFAULT_PLAYERS);
    return n === 4 ? 4 : DEFAULT_PLAYERS;
  }
  function boot() {
    var t, board, session, view = { sweep: null, flash: '' }, tg, seats, mine, SEATS = tableSize();
    var ladderName = function () { var v = Z.store.get(LADDER_KEY, DEFAULT_LADDER); return LADDERS[v] ? v : DEFAULT_LADDER; };
    var nm = function (seat) { return seats.name(seat); };
    function bidText(b) { return b === null || b === undefined ? '' : String(b); }

    function handSheet(st) {
      var V = seats.view(), r = st.result, me = r.points[V];
      var rows = tg.order().map(function (seat) {
        return { name: nm(seat), delta: r.points[seat], total: st.scores[seat], note: TX('ohhell.note', { bid: st.bids[seat], took: st.tricks[seat] }), lead: seat === V };
      });
      var head = TX(r.made[V] ? 'ohhell.made' : 'ohhell.missed', { points: Z.plural(me, 'point') });
      T.summarySheet({ title: TX('cards.fact.hand', { n: st.handNo + 1 }), headline: head, rows: rows, actions: [{ label: TX('cards.nextHand'), primary: true, onclick: tg.startNextHand }] });
    }
    function finalLines(st) { return [TX('ohhell.final', { list: tg.order().map(function (seat) { return nm(seat) + ' ' + st.scores[seat]; }).join(' · ') })]; }
    function hud(st) {
      var full = st.trick.length === st.players, V = seats.view();
      var chips = tg.order().map(function (seat) {
        var text = st.phase === 'bid' ? bidText(st.bids[seat]) : st.tricks[seat] + '/' + bidText(st.bids[seat]);
        return { name: nm(seat), text: text, dealer: seat === st.dealer, turn: (st.phase === 'bid' || st.phase === 'play') && st.turn === seat && !full };
      });
      var out = { chips: chips, fact: TX('ohhell.fact', { n: st.handNo + 1, total: st.sizes.length }), text: '', trump: st.trump };
      if (st.phase === 'bid') {
        if (seats.person(st.turn) && st.turn === V) {
          var bad = forbiddenBid(st, V);
          out.text = TX(seats.hotseat() ? 'ohhell.yourBid.name' : 'ohhell.yourBid', { name: nm(V) }) + (bad >= 0 ? ' ' + TX('ohhell.notBid', { n: bad }) : '');
          out.choices = [];
          for (var n = 0; n <= st.sizes[st.handNo]; n++) out.choices.push(bidChoice(n, n === bad));
          out.lines = [{ text: TX('ohhell.estimate', { n: Math.round(estimate(st.hands[V], st.trump, st.players)) }) }];
        } else out.text = TX('cards.bidding', { name: nm(st.turn) });
      } else if (st.phase === 'handEnd') { out.text = TX('cards.handEnd'); out.label = TX('cards.nextHand'); out.action = tg.startNextHand; }
      else if (st.phase === 'over') { out.text = TX('shell.end.over'); out.label = TX('shell.menu.new'); out.action = newGame; }
      else if (full) out.text = tg.trickText(trickWinner(st.trick, st.trump));
      else out.text = tg.turnText(st.turn);
      return out;
    }
    function bidChoice(n, banned) { return { label: String(n), disabled: banned, onclick: function () { bid(n); } }; }

    function drive() {
      var st = session.state;
      if (st.phase === 'bid') { if (seats.person(st.turn)) seats.ensure(st.turn, tg.repaint); else session.later(aiBidTurn, AI_MS); return; }
      tg.turn(st);
    }
    function aiBidTurn() {
      var st = session.state;
      if (st.phase !== 'bid' || seats.person(st.turn)) return;
      session.follow(placeBid(st, st.turn, aiBid(st, st.turn)));
      drive();
    }
    function bid(n) {
      var st = session.state;
      if (!canBid(st, st.turn, n) || st.turn !== seats.view()) return;
      session.commit(placeBid(st, st.turn, n));
      drive();
    }
    function gameOver() {
      var st = session.state, top = winners(st.scores), V = seats.view(), hot = seats.hotseat(), lines = finalLines(st);
      if (hot) session.lose({ name: nm(top[0]) }, lines);
      else if (top.length > 1 && top.indexOf(V) >= 0) session.lose('draw', lines, st.scores[V]);
      else if (top[0] === V) session.win(st.scores[V]); else session.lose('', lines, st.scores[V]);
    }
    function deal() { tg.restart(startGame(Z.shuffled(Math.random), SEATS, ladderName(), Math.floor(Math.random() * SEATS))); }
    // A new game at a different table size starts the page over, since the seats are made once.
    function newGame() {
      var want = Z.store.get(PLAYERS_KEY, DEFAULT_PLAYERS);
      if ((want === 3 || want === 4) && want !== SEATS && root.ZimiShell && root.ZimiShell.forget) { root.ZimiShell.forget(); root.location.reload(); return; }
      deal();
    }

    tg = T.trickGame({
      id: 'ohhell', n: SEATS, view: view, ms: { ai: AI_MS, hold: HOLD_MS, sweep: SWEEP_MS }, drive: drive, handEnd: 'handEnd',
      seatOpts: { cpuNames: Array.apply(null, Array(SEATS)).map(function (x, i) { return Seats.cpuName(i); }) },
      winner: function (st) { return trickWinner(st.trick, st.trump); }, resolve: resolveTrick, nextHand: nextHand, handOver: function () { handSheet(session.state); }, gameOver: gameOver,
      legal: isLegal, why: whyNot, play: playCard, aiPlay: aiPick
    });
    seats = tg.seats; mine = tg.mine;
    t = tg.create({
      name: 'Oh Hell', geo: geo, place: place, hud: hud, newGame: newGame, heightShare: 0.13,
      stat: function (sec, st) { return Z.fmtTime(sec) + ' · ' + st.scores[seats.view()]; },
      cascadeOrder: function (st) { return st.played.map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return finalLines(st); },
      menuExtra: function () {
        return [T.choiceRow(TX('cards.seatsAtTable'), PLAYERS_KEY, [{ value: 3, label: '3' }, { value: 4, label: '4' }], DEFAULT_PLAYERS, function () {}),
          T.choiceRow(TX('ohhell.length'), LADDER_KEY, [{ value: 'short', label: TX('ohhell.short') }, { value: 'full', label: TX('ohhell.full') }], DEFAULT_LADDER, function () {}),
          Z.h('p', { class: 'zc-note', text: TX('ce.seatsNote') })];
      },
      rules: TX('ohhell.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    deal();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
