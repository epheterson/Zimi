/* ZimiGames: the climbing games, Big Two and Tien Len. Four players, a
   whole deck dealt out, 13 cards each. The player with the lowest card
   (3 of diamonds in Big Two, 3 of spades in Tien Len) leads any combination
   that includes it; each player in turn must play the same kind of
   combination, higher, or pass. When everyone else has passed, the last
   player to play leads anything. Be first to empty your hand. Twos are the
   highest cards, threes the lowest.

   Big Two: suits rank diamonds, clubs, hearts, spades. Combinations: single,
   pair, three of a kind, and five-card hands (straight, flush, full house,
   four of a kind plus any card, straight flush, in that order; straights
   run 3 4 5 6 7 up to 10 J Q K A, no twos). The hand ends when someone goes
   out; the others pay one point a card they hold (double with 10 or more,
   triple with all 13).
   Tien Len (the southern Vietnamese game): suits rank spades, clubs,
   diamonds, hearts. Combinations: single, pair, triple, four of a kind,
   runs of three or more in a row (no twos), and runs of three or more pairs
   in a row. A pass drops you out of that trick. A twos can be chopped: four
   of a kind or three pairs in a row beats a single two; four of a kind or
   four pairs in a row beats a pair of twos. Play goes on until three are out;
   the order of finishing scores 4, 1, -1, -4.

   State: hands[4] (low to high), turn, top ({seat, combo} or null), table
   (ids of the last play), passed[4], order (seats out, in order), scores[4],
   handNo, leader, phase ('play' | 'handEnd' | 'over'), opening (the first
   lead must hold the lowest card), result. Pure functions; the page wiring
   at the bottom of each game's file only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;

  var SEATS = 4, HAND = 13, COMPASS = [TX('bridge.seat.south'), TX('cards.seat.west'), TX('cards.seat.north'), TX('cards.seat.east')];
  var TWO = 12, ACE = 11, MAX_STRAIGHT_TOP = 11, SUIT_WEIGHT = 4, CAP = 80, FLUSH_SUIT = 1e7;
  var rankC = function (id) { var r = Z.rank(id); return r === 1 ? ACE : r === 2 ? TWO : r - 3; };
  var rankWord = function (c) { return TX('climb.rank.' + c); };
  var plural = function (c) { return TX('climb.ranks.' + c); };

  var RULES = {
    bigtwo: {
      id: 'bigtwo', name: 'Big Two', suitRank: [1, 0, 2, 3], opening: { rank: 0, suit: 1 }, passOut: false, firstOut: true, target: 30,
      title: 'Big Two'
    },
    tienlen: {
      id: 'tienlen', name: 'Tien Len', suitRank: [1, 2, 3, 0], opening: { rank: 0, suit: 3 }, passOut: true, firstOut: false, target: 12,
      orderPoints: [4, 1, -1, -4], title: 'Tien Len'
    }
  };
  var strength = function (R, id) { return rankC(id) * SUIT_WEIGHT + R.suitRank[Z.suit(id)]; };
  var byStrength = function (R) { return function (a, b) { return strength(R, a) - strength(R, b); }; };
  var openingCard = function (R) { return Z.make(R.opening.rank === 0 ? 3 : 1, R.opening.suit); };

  // ── Combinations ────────────────────────────────────────────────────────
  var FIVE = ['straight', 'flush', 'full house', 'four of a kind', 'straight flush'];
  function groupsOf(cards) {
    var g = {};
    cards.forEach(function (c) { (g[rankC(c)] = g[rankC(c)] || []).push(c); });
    return g;
  }
  var runOf = function (ranks) { // sorted ascending, distinct
    for (var i = 1; i < ranks.length; i++) if (ranks[i] !== ranks[i - 1] + 1) return false;
    return ranks.length > 0 && ranks[ranks.length - 1] <= MAX_STRAIGHT_TOP;
  };
  // Name a set of cards as a combination for these rules, or null. combo: {type, size, key, cards, tier}
  function classify(R, cards) {
    var n = cards.length, cs = cards.slice().sort(byStrength(R)), g = groupsOf(cs), ranks = Object.keys(g).map(Number).sort(function (a, b) { return a - b; });
    var top = strength(R, cs[n - 1]), mk = function (type, key, extra) { return Object.assign({ type: type, size: n, key: key, cards: cs }, extra || {}); };
    if (!n) return null;
    if (ranks.length === 1) {
      if (n === 1) return mk('single', top);
      if (n === 2) return mk('pair', top);
      if (n === 3) return mk('triple', top);
      if (n === 4 && R.id === 'tienlen') return mk('quad', top);
      return null;
    }
    if (R.id === 'bigtwo') {
      if (n !== 5) return null;
      var flush = cs.every(function (c) { return Z.suit(c) === Z.suit(cs[0]); }), straight = ranks.length === 5 && runOf(ranks);
      if (straight && flush) return mk('straight flush', top, { tier: 4 });
      var counts = ranks.map(function (r) { return g[r].length; }).sort();
      if (counts.join() === '1,4') return mk('four of a kind', rankOfCount(g, 4), { tier: 3 });
      if (counts.join() === '2,3') return mk('full house', rankOfCount(g, 3), { tier: 2 });
      if (flush) return mk('flush', R.suitRank[Z.suit(cs[0])] * FLUSH_SUIT + cs.slice().reverse().reduce(function (v, c) { return v * 13 + rankC(c); }, 0), { tier: 1 });
      if (straight) return mk('straight', top, { tier: 0 });
      return null;
    }
    // Tien Len: a run of single cards, or a run of pairs.
    if (n >= 3 && ranks.length === n && runOf(ranks)) return mk('straight', top);
    if (n >= 6 && n % 2 === 0 && ranks.length === n / 2 && runOf(ranks) && ranks.every(function (r) { return g[r].length === 2; })) return mk('pair run', top, { len: n / 2 });
    return null;
  }
  function rankOfCount(g, k) { return Number(Object.keys(g).filter(function (r) { return g[r].length === k; })[0]); }
  var isTwo = function (combo) { return combo.cards.every(function (c) { return rankC(c) === TWO; }); };

  // Does `next` beat `prev` (the combination on the table)?
  function beats(R, prev, next) {
    if (!prev) return true;
    if (R.id === 'bigtwo') {
      if (prev.size !== next.size) return false;
      if (prev.size === 5) return next.tier !== prev.tier ? next.tier > prev.tier : next.key > prev.key;
      return next.type === prev.type && next.key > prev.key;
    }
    if (next.type === prev.type && next.size === prev.size) return next.key > prev.key;
    // Chops: what beats a two.
    if (prev.type === 'single' && isTwo(prev)) return next.type === 'quad' || (next.type === 'pair run' && next.len >= 3);
    if (prev.type === 'pair' && isTwo(prev)) return next.type === 'quad' || (next.type === 'pair run' && next.len >= 4);
    if (prev.type === 'quad') return next.type === 'pair run' && next.len >= 4;
    return false;
  }
  // Why a selection cannot be played now (or '').
  function whyNot(R, st, seat, ids) {
    if (!ids.length) return TX('climb.why.tap');
    var combo = classify(R, ids);
    if (!combo) return TX('climb.why.notHand');
    if (st.opening && ids.indexOf(openingCard(R)) < 0) return TX('climb.why.opening', { card: Z.cardName(openingCard(R)) });
    if (st.top && !beats(R, st.top.combo, combo)) return TX('climb.why.beat', { what: describe(R, st.top.combo) });
    return '';
  }
  function describe(R, c) {
    var hi = rankC(c.cards[c.cards.length - 1]), lo = rankC(c.cards[0]);
    switch (c.type) {
      case 'single': return TX('climb.d.single', { rank: rankWord(hi) });
      case 'pair': return TX('climb.d.pair', { ranks: plural(hi) });
      case 'triple': return TX('climb.d.triple', { ranks: plural(hi) });
      case 'quad': return TX('climb.d.quad', { ranks: plural(hi) });
      case 'pair run': return TX('climb.d.pairRun', { n: c.len, rank: rankWord(hi) });
      case 'straight': return TX('climb.d.straight', { n: c.size, rank: rankWord(hi) });
      case 'flush': return TX('climb.d.flush', { rank: rankWord(hi) });
      case 'full house': return TX('climb.d.fullHouse', { ranks: plural(Math.round(c.key)) });
      case 'four of a kind': return TX('climb.d.four', { ranks: plural(Math.round(c.key)) });
      default: return TX('climb.d.straightFlush', { rank: rankWord(hi) });
    }
  }

  // Every combination in a hand (capped per kind), lowest first.
  function candidates(R, hand) {
    var cs = hand.slice().sort(byStrength(R)), g = groupsOf(cs), out = [], ranks = Object.keys(g).map(Number).sort(function (a, b) { return a - b; });
    var add = function (cards) { var c = classify(R, cards); if (c) out.push(c); };
    function choose(list, k) { // all k-subsets, in order
      var res = [];
      (function rec(start, acc) { if (acc.length === k) { res.push(acc.slice()); return; } for (var i = start; i < list.length && res.length < CAP; i++) { acc.push(list[i]); rec(i + 1, acc); acc.pop(); } })(0, []);
      return res;
    }
    function product(lists) { // one pick from each list
      var res = [[]];
      lists.forEach(function (l) { var nx = []; res.forEach(function (p) { l.forEach(function (x) { if (nx.length < CAP) nx.push(p.concat(x)); }); }); res = nx; });
      return res;
    }
    cs.forEach(function (c) { add([c]); });
    ranks.forEach(function (r) {
      choose(g[r], 2).forEach(add); choose(g[r], 3).forEach(add);
      if (R.id === 'tienlen' && g[r].length === 4) add(g[r]);
    });
    if (R.id === 'tienlen') {
      for (var a = 0; a < ranks.length; a++) {
        var len = 1;
        while (a + len < ranks.length && ranks[a + len] === ranks[a] + len && ranks[a + len] <= MAX_STRAIGHT_TOP) len++;
        for (var l = 3; l <= len; l++) product(ranks.slice(a, a + l).map(function (r) { return g[r].map(function (c) { return [c]; }); })).forEach(function (p) { add(p.reduce(function (x, y) { return x.concat(y); }, [])); });
        var pl = 0;
        while (a + pl < ranks.length && ranks[a + pl] === ranks[a] + pl && ranks[a + pl] <= MAX_STRAIGHT_TOP && g[ranks[a + pl]].length >= 2) pl++;
        for (var q = 3; q <= pl; q++) product(ranks.slice(a, a + q).map(function (r) { return choose(g[r], 2); })).forEach(function (p) { add(p.reduce(function (x, y) { return x.concat(y); }, [])); });
      }
    } else {
      for (var s = 0; s < ranks.length; s++) {
        if (ranks[s + 4] === ranks[s] + 4 && ranks[s] + 4 <= MAX_STRAIGHT_TOP && ranks.slice(s, s + 5).every(function (r, k) { return r === ranks[s] + k; })) {
          product(ranks.slice(s, s + 5).map(function (r) { return g[r].map(function (c) { return [c]; }); })).forEach(function (p) { add(p.reduce(function (x, y) { return x.concat(y); }, [])); });
        }
      }
      [0, 1, 2, 3].forEach(function (su) { var sc = cs.filter(function (c) { return Z.suit(c) === su; }); if (sc.length >= 5) choose(sc, 5).forEach(add); });
      ranks.forEach(function (r3) {
        if (g[r3].length >= 3) ranks.forEach(function (r2) { if (r2 !== r3 && g[r2].length >= 2) choose(g[r3], 3).slice(0, 2).forEach(function (t) { choose(g[r2], 2).slice(0, 2).forEach(function (p) { add(t.concat(p)); }); }); });
        if (g[r3].length === 4) cs.forEach(function (c) { if (rankC(c) !== r3) add(g[r3].concat([c])); });
      });
    }
    return out;
  }
  function legalPlays(R, st, seat) {
    var all = candidates(R, st.hands[seat]);
    if (st.opening) { var oc = openingCard(R); all = all.filter(function (c) { return c.cards.indexOf(oc) >= 0; }); }
    return st.top ? all.filter(function (c) { return beats(R, st.top.combo, c); }) : all;
  }

  // ── The hand ────────────────────────────────────────────────────────────
  function dealHand(R, order, scores, handNo, leader) {
    var hands = [], s, firstSeat = -1;
    for (s = 0; s < SEATS; s++) {
      hands.push(order.slice(s * HAND, (s + 1) * HAND).sort(byStrength(R)));
      if (hands[s].indexOf(openingCard(R)) >= 0) firstSeat = s;
    }
    var opening = handNo === 0;
    return { hands: hands, turn: opening ? firstSeat : leader, top: null, table: [], tableSeat: -1, passed: [false, false, false, false], order: [], scores: scores.slice(), handNo: handNo, leader: opening ? firstSeat : leader, phase: 'play', opening: opening, result: null, moves: 0 };
  }
  var active = function (st, seat) { return st.hands[seat].length > 0; };
  function nextSeat(st, from, needFresh) {
    for (var k = 1; k <= SEATS; k++) { var s = (from + k) % SEATS; if (active(st, s) && !(needFresh && st.passed[s])) return s; }
    return -1;
  }
  function play(R, st, seat, ids) {
    var combo = classify(R, ids);
    if (st.phase !== 'play' || st.turn !== seat || !combo || !ids.every(function (c) { return st.hands[seat].indexOf(c) >= 0; }) || whyNot(R, st, seat, ids)) return st;
    var s = Z.clone(st);
    s.hands[seat] = s.hands[seat].filter(function (c) { return ids.indexOf(c) < 0; });
    s.top = { seat: seat, combo: combo }; s.table = combo.cards.slice(); s.tableSeat = seat; s.opening = false; s.moves++;
    if (!R.passOut) s.passed = [false, false, false, false];
    if (!s.hands[seat].length) {
      s.order.push(seat);
      var left = s.hands.filter(function (h) { return h.length; }).length;
      if (R.firstOut || left <= 1) return endHand(R, s);
    }
    return advance(R, s, seat);
  }
  function pass(R, st, seat) {
    if (st.phase !== 'play' || st.turn !== seat || !st.top) return st;
    var s = Z.clone(st);
    s.passed[seat] = true; s.moves++;
    return advance(R, s, seat);
  }
  // Next to act, or the trick is over and the last player to play leads again.
  function advance(R, s, from) {
    var owner = s.top.seat, others = [0, 1, 2, 3].filter(function (x) { return x !== owner && active(s, x); });
    if (others.every(function (x) { return s.passed[x]; })) {
      s.leader = active(s, owner) ? owner : nextSeat(s, owner, false);
      s.turn = s.leader; s.top = null; s.passed = [false, false, false, false];
      return s;
    }
    s.turn = nextSeat(s, from, true);
    if (s.turn < 0) { s.leader = s.turn = active(s, owner) ? owner : nextSeat(s, owner, false); s.top = null; s.passed = [false, false, false, false]; }
    return s;
  }
  function endHand(R, s) {
    var left = [0, 1, 2, 3].filter(function (x) { return s.hands[x].length; });
    left.sort(function (a, b) { return s.hands[a].length - s.hands[b].length; }).forEach(function (x) { s.order.push(x); });
    var pts = [0, 0, 0, 0], winner = s.order[0];
    if (R.firstOut) {
      [0, 1, 2, 3].forEach(function (x) {
        if (x === winner) return;
        var n = s.hands[x].length, pay = n >= HAND ? n * 3 : n >= 10 ? n * 2 : n;
        pts[x] -= pay; pts[winner] += pay;
      });
    } else s.order.forEach(function (x, k) { pts[x] = R.orderPoints[k]; });
    s.result = { points: pts, winner: winner, order: s.order.slice(), left: s.hands.map(function (h) { return h.length; }) };
    s.scores = s.scores.map(function (v, i) { return v + pts[i]; });
    s.leader = winner; s.top = null; s.phase = gameWinner(R, s.scores) >= 0 ? 'over' : 'handEnd';
    return s;
  }
  // The winner once someone reaches the target (highest total), else -1.
  function gameWinner(R, scores) {
    var best = Math.max.apply(null, scores);
    if (best < R.target) return -1;
    return scores.indexOf(best);
  }
  function nextHand(R, st, order) { return dealHand(R, order, st.scores, st.handNo + 1, st.leader); }

  // ── The computer players ────────────────────────────────────────────────
  var BOMB_COST = 9, HIGH_COST = 3, BREAK_COST = 1.6, EXTRA_CARD_GAIN = 1.2, PASS_ABOVE = 9, NEAR_OUT = 3;
  function cost(R, st, seat, c, following) {
    var g = groupsOf(st.hands[seat]), v = 0, bomb = false;
    c.cards.forEach(function (x) { v += strength(R, x) / SUIT_WEIGHT; });
    v /= c.size;
    var rk = rankC(c.cards[c.cards.length - 1]);
    if (c.size <= 3 && (c.type === 'single' || c.type === 'pair')) {
      c.cards.forEach(function (x) { if (g[rankC(x)].length > c.size) v += BREAK_COST; });
    }
    if (rk >= ACE && (c.type === 'single' || c.type === 'pair' || c.type === 'triple')) v += HIGH_COST;
    if (c.type === 'quad' || c.type === 'pair run' || (R.id === 'bigtwo' && c.tier >= 3)) bomb = true;
    if (bomb && c.type !== 'pair run' || (c.type === 'pair run' && c.len >= 4)) v += BOMB_COST;
    v -= (c.size - 1) * EXTRA_CARD_GAIN;
    return v;
  }
  function aiPlay(R, st, seat) {
    var legal = legalPlays(R, st, seat), hand = st.hands[seat];
    if (!legal.length) return null;
    var out = legal.find(function (c) { return c.size === hand.length; });
    if (out) return out.cards;
    var foes = [0, 1, 2, 3].filter(function (x) { return x !== seat && active(st, x); }), minFoe = Math.min.apply(null, foes.map(function (x) { return st.hands[x].length; }));
    var pool = legal;
    if (minFoe === 1 && st.top && st.top.combo.size === 1) { // someone has one card: do not let singles go cheap
      return legal.slice().sort(function (a, b) { return b.key - a.key; })[0].cards;
    }
    if (minFoe === 1 && !st.top) { var multi = legal.filter(function (c) { return c.size > 1; }); if (multi.length) pool = multi; }
    var scored = pool.map(function (c) { return { c: c, v: cost(R, st, seat, c, !!st.top) }; }).sort(function (a, b) { return a.v - b.v; });
    var pick = scored[0];
    if (st.top && pick.v > PASS_ABOVE && minFoe > NEAR_OUT && hand.length > 4) return null;
    if (st.top && R.passOut === false && pick.v > PASS_ABOVE + 2 && minFoe > NEAR_OUT) return null;
    return pick.c.cards;
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  // The person looking sits south (view.viewer); their hand is face down while it is not their turn.
  var viewerOf = function (view) { return (view && view.viewer) || 0; };
  var mySel = function (st, view) { return ((view && view.sel) || []).filter(function (id) { return st.hands[viewerOf(view)].indexOf(id) >= 0; }); };
  function geo(m, st, V) { return T.geometry(m, T.rowsFor(m, st.hands[V || 0].length)); }
  function place(st, m, view) {
    var V = viewerOf(view), up = !(view && view.hideHand), g = geo(m, st, V), slots = [], cards = [], sel = up ? mySel(st, view) : [];
    slots.push({ id: 'table', x: g.cx - 2 * g.cw, y: g.cy - g.ch / 2 - 4, w: 4 * g.cw, h: g.ch + 8, quiet: true, label: TX('cards.slot.table') });
    var hand = T.handCards(g, st.hands[V], function (id) { return { up: up, raise: sel.indexOf(id) >= 0, glow: sel.indexOf(id) >= 0, label: up ? Z.cardName(id) + (sel.indexOf(id) >= 0 ? TX('canasta.pickedSuffix') : '') : TX('cards.hidden') }; }, null);
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    [1, 2, 3].forEach(function (r) { var seat = (V + r) % SEATS; if (st.hands[seat].length) cards = cards.concat(T.fan(g, r, st.hands[seat], false)); });
    var n = st.table.length, avail = g.W - 2 * g.pad - g.cw, step = n > 1 ? Math.min(g.cw * 0.62, avail / (n - 1)) : 0, x0 = g.cx - (g.cw + (n - 1) * step) / 2;
    st.table.forEach(function (id, k) { cards.push({ id: id, pile: 'trick', idx: k, x: Math.round(x0 + k * step), y: Math.round(g.cy - g.ch / 2), up: true, dim: !st.top }); });
    return { height: m.H, slots: slots, cards: cards };
  }

  function api(R) {
    return {
      rules: R, classify: function (ids) { return classify(R, ids); }, beats: function (a, b) { return beats(R, a, b); }, candidates: function (hand) { return candidates(R, hand); },
      legalPlays: function (st, seat) { return legalPlays(R, st, seat); }, whyNot: function (st, seat, ids) { return whyNot(R, st, seat, ids); }, describe: function (c) { return describe(R, c); },
      newHand: function (order, scores, handNo, leader) { return dealHand(R, order, scores || [0, 0, 0, 0], handNo || 0, leader || 0); },
      play: function (st, seat, ids) { return play(R, st, seat, ids); }, pass: function (st, seat) { return pass(R, st, seat); },
      aiPlay: function (st, seat) { return aiPlay(R, st, seat); }, nextHand: function (st, order) { return nextHand(R, st, order); }, gameWinner: function (scores) { return gameWinner(R, scores); },
      strength: function (id) { return strength(R, id); }, openingCard: function () { return openingCard(R); }, geo: geo, place: place
    };
  }

  // ── The page, shared by both games ──────────────────────────────────────
  var AI_MS = 700, HOLD_MS = 900;
  function boot(game) {
    var R = game.rules, d = root.document, t, board, session, view = { sel: [], flash: '' };
    // Seats are the Computer or a Person; two or more people share the screen behind a handoff.
    var seats = Seats.create({ id: R.id, seats: SEATS, cpuNames: COMPASS, onChange: function () { view.sel = []; repaint(); } });
    var nm = function (seat) { return seats.name(seat); };
    function syncView(st) { view.viewer = seats.view(); view.hideHand = seats.hotseat() && st.turn !== view.viewer; }
    function repaint() { if (board) board.refresh(); if (t) t.paint(); }
    var describeTop = function (st) { return st.top ? describe(R, st.top.combo) : ''; };
    function counts(st) {
      return st.hands.map(function (h, seat) {
        var n = h.length, done = n === 0 && st.order.indexOf(seat) >= 0;
        return { name: nm(seat), text: done ? TX('climb.out.' + (st.order.indexOf(seat) + 1)) : (st.passed[seat] && R.passOut && st.top ? TX('climb.passed') : String(n)), turn: st.phase === 'play' && st.turn === seat };
      });
    }
    function hud(st) {
      var V = seats.view(), out = { chips: counts(st), fact: TX('climb.fact', { name: seats.hotseat() ? nm(V) : TX('cards.you'), n: st.scores[V], target: R.target }), text: '' };
      if (st.phase === 'handEnd' || st.phase === 'over') {
        if (st.phase === 'handEnd') { out.text = TX('cards.handEnd'); out.label = TX('cards.nextHand'); out.action = startNextHand; }
        else { var w = game.gameWinner(st.scores); out.text = seats.isYou(w) ? TX('climb.winYou') : TX('climb.winName', { name: nm(w) }); out.label = TX('shell.menu.new'); out.action = newGame; }
        return out;
      }
      var played = st.top ? TX('climb.played', { name: nm(st.top.seat), what: describeTop(st) }) + ' ' : '';
      if (seats.person(st.turn) && st.turn !== V) out.text = played + TX('ce.next', { name: nm(st.turn) });
      else if (st.turn === V) {
        var sel = mySel(st, view), why = sel.length ? game.whyNot(st, V, sel) : '', combo = sel.length ? game.classify(sel) : null, you = seats.isYou(V), who = nm(V);
        out.text = st.top ? played + TX(you ? 'cards.turn.you' : 'cards.turn.name', { name: who }) : TX(st.opening ? (you ? 'climb.lead.opening.you' : 'climb.lead.opening') : (you ? 'climb.lead.you' : 'climb.lead'), { name: who, card: Z.cardName(openingCard(R)) });
        out.choices = [
          { label: combo && !why ? TX('climb.playWhat', { what: game.describe(combo) }) : TX('climb.play'), disabled: !!why || !sel.length, onclick: playSelected },
          { label: TX('cards.pass'), disabled: !st.top, onclick: passTurn },
          { label: TX('cards.hint'), onclick: hint }
        ];
        if (sel.length && why) out.lines = [{ text: why }];
        else if (!sel.length && st.top && !game.legalPlays(st, V).length) out.lines = [{ text: TX('climb.nothingBeats') }];
      } else out.text = played + TX('cards.thinking', { name: nm(st.turn) });
      return out;
    }
    function drive() {
      var st = session.state;
      if (st.phase === 'handEnd') { handOver(); return; }
      if (st.phase === 'over') { gameOver(); return; }
      if (seats.person(st.turn)) { seats.ensure(st.turn, repaint); return; }
      session.later(aiTurn, seats.people().some(function (p) { return st.hands[p].length; }) ? AI_MS : 350);
    }
    function aiTurn() {
      var st = session.state;
      if (st.phase !== 'play' || seats.person(st.turn)) return;
      var pick = game.aiPlay(st, st.turn);
      session.follow(pick ? game.play(st, st.turn, pick) : game.pass(st, st.turn));
      drive();
    }
    function playSelected() {
      var st = session.state;
      var V = seats.view();
      if (st.turn !== V || game.whyNot(st, V, view.sel)) return;
      var ids = view.sel.slice(); view.sel = [];
      session.commit(game.play(st, V, ids)); drive();
    }
    function passTurn() {
      var st = session.state;
      if (st.turn !== seats.view() || !st.top) return;
      view.sel = []; session.commit(game.pass(st, st.turn)); drive();
    }
    function hint() {
      var st = session.state, V = seats.view(), legal = game.legalPlays(st, V);
      if (!legal.length) { t.flash(TX('climb.flashPass')); return; }
      var c = legal.slice().sort(function (a, b) { return cost(R, st, V, a, true) - cost(R, st, V, b, true); })[0];
      view.sel = c.cards.slice(); board.refresh(); t.paint();
    }
    function tap(pile) {
      var st = session.state, id = parseInt(pile.slice(1), 10);
      if (pile.charAt(0) !== 'h' || isNaN(id) || st.phase !== 'play' || view.hideHand) return false;
      var at = view.sel.indexOf(id);
      if (at >= 0) view.sel.splice(at, 1); else view.sel.push(id);
      board.refresh(); t.paint();
      return true;
    }
    function lineFor(st) { var r = st.result; return st.hands.map(function (h, i) { return nm(i) + ' ' + (r.points[i] > 0 ? '+' : '') + r.points[i] + ' (' + st.scores[i] + ')'; }).join(' · '); }
    function handOver() { var st = session.state; T.lineSheet(TX('cards.fact.hand', { n: st.handNo + 1 }), [lineFor(st), TX(R.firstOut ? 'climb.pay' : 'climb.order')], [{ label: TX('cards.nextHand'), primary: true, onclick: startNextHand }]); }
    function gameOver() {
      var st = session.state, w = game.gameWinner(st.scores), V = seats.view(), hot = seats.hotseat();
      if (w === V && !hot) session.win(st.scores[V]); else session.lose(hot ? { name: nm(w) } : '', [TX('climb.reached', { name: nm(w), target: R.target }), lineFor(st)], hot ? undefined : st.scores[V]);
    }
    function startNextHand() {
      var st = session.state;
      if (st.phase !== 'handEnd') return;
      session.history = []; view.sel = [];
      session.follow(game.nextHand(st, Z.shuffled(Math.random)));
      deal();
    }
    function newGame() {
      view.sel = []; view.flash = '';
      session.reset(game.newHand(Z.shuffled(Math.random), [0, 0, 0, 0], 0, 0));
      deal();
    }
    // A fresh deal: nobody has seen it, so a table of people starts at a handoff.
    function deal() { seats.begin(function () { repaint(); drive(); }, session.state.turn); }
    t = T.create({
      id: R.id, name: R.name, seats: seats, view: view, geo: function (m, st) { return geo(m, st, seats.view()); }, place: function (st, m, v) { syncView(st); return place(st, m, v); }, hud: hud, newGame: newGame, tap: tap, cols: 7, heightShare: 0.11,
      canPick: function () { return false; },
      stat: function (sec, st) { return TX('climb.stat', { n: st.scores[seats.view()], target: R.target }); },
      cascadeOrder: function (st) { return st.table.map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return [TX('climb.reachedYou', { target: R.target, scores: st.scores.join(', ') })]; },
      rules: game.rulesText
    });
    board = t.board; session = t.session;
    game.session = session; game.board = board;
    if (root.ResizeObserver) new root.ResizeObserver(function () { t.paint(); }).observe(d.getElementById('zc-table'));
    d.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey || d.querySelector('.ar-sheet')) return;
      var k = e.key.toLowerCase(), st = session.state;
      if (!st || st.turn !== seats.view() || st.phase !== 'play' || seats.covering) return;
      if (k === 'p') { playSelected(); e.preventDefault(); } else if (k === 's') { passTurn(); e.preventDefault(); } else if (k === 'h') { hint(); e.preventDefault(); } else if (k === 'escape') { view.sel = []; board.refresh(); t.paint(); }
    });
    newGame();
  }

  root.ZimiClimbing = { RULES: RULES, api: api, boot: boot, rankC: rankC, SEATS: SEATS };
})(typeof globalThis !== 'undefined' ? globalThis : window);
