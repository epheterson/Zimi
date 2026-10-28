/* ZimiGames: Texas Hold'em. You against three to five computer players, no
   limit, play chips only. Everyone starts with 1000 chips. Each hand: two
   private cards each, a round of betting, three shared cards (the flop),
   betting, a fourth (the turn), betting, a fifth (the river), betting, then
   the showdown: the best five cards from your two and the five shared ones
   win. Blinds are forced bets that grow every eight hands. Going all in
   puts everything you have in; the others' extra bets go into a side pot
   you cannot win. Last player with chips wins.

   State: players [{name, style, chips, hole, bet (this round), total (this
   hand), folded, allIn, acted, locked, out, last}], board, deck, pos,
   dealer, toAct, currentBet, minRaise, phase ('preflop' | 'flop' | 'turn' |
   'river' | 'between' | 'over'), runout (everyone left is all in: deal on),
   handNo, blinds [small, big], result (set when a hand ends). Seat 0 is you.
   Pure functions; the page wiring at the bottom only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;

  var START_CHIPS = 1000, HANDS_PER_LEVEL = 8, SIM_COUNT = 160, CHIP_UNIT = 5;
  var BLIND_LEVELS = [[10, 20], [15, 30], [25, 50], [50, 100], [100, 200], [200, 400], [400, 800]];
  var catName = function (c) { return TX('holdem.cat.' + c); };
  var STYLES = {
    tight: { tight: 1, aggr: 0.35, bluff: 0.02, call: 1, label: TX('holdem.style.tight') },
    loose: { tight: -1, aggr: 0.2, bluff: 0.03, call: 0.8, label: TX('holdem.style.loose') },
    aggressive: { tight: -0.3, aggr: 1, bluff: 0.18, call: 0.9, label: TX('holdem.style.aggressive') },
    tightAggressive: { tight: 0.6, aggr: 0.8, bluff: 0.07, call: 1, label: TX('holdem.style.tightAggressive') },
    looseAggressive: { tight: -0.8, aggr: 0.8, bluff: 0.12, call: 0.85, label: TX('holdem.style.looseAggressive') }
  };
  // The computers take the shared names (seats.cpu.N), so a translated page has translated names.
  var OPPONENTS = ['tight', 'loose', 'aggressive', 'tightAggressive', 'looseAggressive'].map(function (style, i) { return [TX('seats.cpu.' + (i + 1)), style]; });
  var high = function (id) { return Z.rank(id) === 1 ? 14 : Z.rank(id); };
  var word = function (r) { return TX('holdem.rank.' + r); };
  var plural = function (r) { return TX('holdem.ranks.' + r); };

  // ── Hand ranking ────────────────────────────────────────────────────────
  // The highest card of the best straight in these ranks (a 14 also counts as 1), or 0.
  function straightHigh(has) {
    for (var top = 14; top >= 5; top--) {
      var ok = true, k;
      for (k = 0; k < 5; k++) { var r = top - k; if (!has[r === 1 ? 14 : r]) { ok = false; break; } }
      if (ok) return top;
    }
    return 0;
  }
  var BASE = 15;
  var pack = function (list) { return list.reduce(function (n, v) { return n * BASE + v; }, 0); };
  // Best five of up to seven cards. Returns {score, cat, ranks, name}: scores compare as numbers, ties are real ties.
  function evaluate(cards) {
    var cnt = [], suits = [[], [], [], []], i, r;
    for (i = 0; i <= 14; i++) cnt.push(0);
    cards.forEach(function (c) { cnt[high(c)]++; suits[Z.suit(c)].push(high(c)); });
    var has = cnt.map(function (n) { return n > 0; });
    var desc = function (list) { return list.slice().sort(function (a, b) { return b - a; }); };
    var groups = function (n) { var o = []; for (r = 14; r >= 2; r--) if (cnt[r] === n) o.push(r); return o; };
    var flushSuit = suits.findIndex(function (s) { return s.length >= 5; }), cat, ranks;
    if (flushSuit >= 0) {
      var fh = [], sh;
      suits[flushSuit].forEach(function (v) { fh[v] = true; });
      sh = straightHigh(fh);
      if (sh) return done(8, [sh]);
    }
    var quads = groups(4), trips = groups(3), pairs = groups(2), singles = groups(1);
    function rest(exclude, n) { var o = []; for (r = 14; r >= 2 && o.length < n; r--) if (cnt[r] > 0 && exclude.indexOf(r) < 0) o.push(r); return o; }
    if (quads.length) return done(7, [quads[0]].concat(rest([quads[0]], 1)));
    if (trips.length && (trips.length > 1 || pairs.length)) return done(6, [trips[0], trips.length > 1 ? trips[1] : pairs[0]]);
    if (flushSuit >= 0) return done(5, desc(suits[flushSuit]).slice(0, 5));
    var st = straightHigh(has);
    if (st) return done(4, [st]);
    if (trips.length) return done(3, [trips[0]].concat(rest([trips[0]], 2)));
    if (pairs.length > 1) return done(2, [pairs[0], pairs[1]].concat(rest([pairs[0], pairs[1]], 1)));
    if (pairs.length) return done(1, [pairs[0]].concat(rest([pairs[0]], 3)));
    return done(0, rest([], 5));
    function done(c, rk) {
      cat = c; ranks = rk;
      return { score: pack([cat].concat(ranks, [0, 0, 0, 0, 0]).slice(0, 6)), cat: cat, ranks: ranks, name: nameOf(cat, ranks) };
    }
  }
  function nameOf(cat, k) {
    switch (cat) {
      case 0: return TX('holdem.n.high', { a: word(k[0]) });
      case 1: return TX('holdem.n.pair', { a: plural(k[0]) });
      case 2: return TX('holdem.n.twoPair', { a: plural(k[0]), b: plural(k[1]) });
      case 3: return TX('holdem.n.three', { a: plural(k[0]) });
      case 4: return TX('holdem.n.straight', { a: word(k[0]) });
      case 5: return TX('holdem.n.flush', { a: word(k[0]) });
      case 6: return TX('holdem.n.full', { a: plural(k[0]), b: plural(k[1]) });
      case 7: return TX('holdem.n.four', { a: plural(k[0]) });
      default: return k[0] === 14 ? TX('holdem.n.royal') : TX('holdem.n.straightFlush', { a: word(k[0]) });
    }
  }
  // The five cards that make the hand, for showing at the showdown.
  function bestFive(cards) {
    if (cards.length <= 5) return cards.slice();
    var best = null, bs = -1, n = cards.length, a, b, c, d, e;
    for (a = 0; a < n; a++) for (b = a + 1; b < n; b++) for (c = b + 1; c < n; c++) for (d = c + 1; d < n; d++) for (e = d + 1; e < n; e++) {
      var five = [cards[a], cards[b], cards[c], cards[d], cards[e]], sc = evaluate(five).score;
      if (sc > bs) { bs = sc; best = five; }
    }
    return best;
  }

  // ── Pots ────────────────────────────────────────────────────────────────
  // players: [{total, folded}] -> pots [{amount, eligible: [seat]}], main pot first. A player
  // who is all in for less cannot win what others put in beyond that.
  function sidePots(players) {
    var live = players.map(function (p, i) { return { i: i, p: p }; }).filter(function (x) { return !x.p.folded && x.p.total > 0; });
    var levels = [], pots = [], prev = 0;
    live.forEach(function (x) { if (levels.indexOf(x.p.total) < 0) levels.push(x.p.total); });
    levels.sort(function (a, b) { return a - b; });
    var maxAll = players.reduce(function (m, p) { return Math.max(m, p.total); }, 0);
    if (levels.length && levels[levels.length - 1] < maxAll) levels.push(maxAll);
    levels.forEach(function (lv) {
      var amount = players.reduce(function (n, p) { return n + Math.min(p.total, lv) - Math.min(p.total, prev); }, 0);
      var eligible = live.filter(function (x) { return x.p.total >= lv; }).map(function (x) { return x.i; });
      if (amount > 0 && eligible.length) {
        var last = pots[pots.length - 1];
        if (last && last.eligible.join() === eligible.join()) last.amount += amount; else pots.push({ amount: amount, eligible: eligible });
      } else if (amount > 0 && pots.length) pots[pots.length - 1].amount += amount;
      prev = lv;
    });
    return pots;
  }
  var handDone = function (st) { return st.phase === 'between' || st.phase === 'over'; };
  var totalPot = function (st) { return st.players.reduce(function (n, p) { return n + p.total; }, 0); };

  // ── The hand ────────────────────────────────────────────────────────────
  function freshGame(rng, opponents) {
    var n = Math.max(3, Math.min(5, opponents || 3)), players = [{ name: TX('cards.you'), style: null }], i;
    for (i = 0; i < n; i++) players.push({ name: OPPONENTS[i][0], style: OPPONENTS[i][1] });
    players.forEach(function (p) { p.chips = START_CHIPS; p.hole = []; p.bet = 0; p.total = 0; p.folded = false; p.allIn = false; p.acted = false; p.locked = false; p.out = false; p.last = ''; });
    return { players: players, board: [], deck: [], pos: 0, dealer: Math.floor(rng() * players.length), toAct: -1, currentBet: 0, minRaise: 0, phase: 'between', runout: false, handNo: 0, blinds: BLIND_LEVELS[0], result: null, started: false };
  }
  var nextWhere = function (st, from, pred) {
    var n = st.players.length, k;
    for (k = 1; k <= n; k++) { var i = (from + k) % n; if (pred(st.players[i], i)) return i; }
    return -1;
  };
  var inHand = function (p) { return !p.folded && !p.out; };
  var canAct = function (p) { return inHand(p) && !p.allIn; };
  function post(p, amount) {
    var pay = Math.min(p.chips, amount);
    p.chips -= pay; p.bet += pay; p.total += pay;
    if (p.chips === 0) p.allIn = true;
    return pay;
  }

  function startHand(st, rng) {
    var s = Z.clone(st), n = s.players.length;
    s.players.forEach(function (p) {
      if (p.chips <= 0) p.out = true;
      p.hole = []; p.bet = 0; p.total = 0; p.folded = p.out; p.allIn = false; p.acted = false; p.locked = false; p.last = '';
    });
    var liveSeats = s.players.map(function (p, i) { return i; }).filter(function (i) { return !s.players[i].out; });
    if (liveSeats.length < 2) { s.phase = 'over'; return s; }
    s.started = true;
    s.handNo++; s.result = null; s.runout = false;
    s.blinds = BLIND_LEVELS[Math.min(BLIND_LEVELS.length - 1, Math.floor((s.handNo - 1) / HANDS_PER_LEVEL))];
    s.dealer = s.handNo === 1 && !s.players[s.dealer].out ? s.dealer : nextWhere(s, s.dealer, function (p) { return !p.out; });
    s.deck = Z.shuffled(rng); s.pos = 0; s.board = [];
    var headsUp = liveSeats.length === 2;
    var sb = headsUp ? s.dealer : nextWhere(s, s.dealer, function (p) { return !p.out; });
    var bb = nextWhere(s, sb, function (p) { return !p.out; });
    var k, seat;
    for (k = 0; k < 2; k++) for (seat = 1; seat <= n; seat++) { var i = (s.dealer + seat) % n; if (!s.players[i].out) s.players[i].hole.push(s.deck[s.pos++]); }
    post(s.players[sb], s.blinds[0]); post(s.players[bb], s.blinds[1]);
    s.players[sb].last = 'small blind'; s.players[bb].last = 'big blind';
    s.currentBet = s.blinds[1]; s.minRaise = s.blinds[1]; s.phase = 'preflop';
    return review(s, bb);
  }

  // What a player may do now: fold, check or call, raise (to an amount between min and max).
  function options(st, seat) {
    var p = st.players[seat];
    if (st.toAct !== seat || !canAct(p)) return null;
    var toCall = Math.min(p.chips, st.currentBet - p.bet), maxTo = p.chips + p.bet;
    var others = st.players.some(function (q, i) { return i !== seat && canAct(q); });
    var minTo = Math.min(maxTo, st.currentBet + st.minRaise);
    var canRaise = maxTo > st.currentBet && others && !p.locked;
    return { toCall: toCall, check: toCall === 0, canRaise: canRaise, minTo: minTo, maxTo: maxTo, pot: totalPot(st) };
  }
  // action: {type: 'fold' | 'call' | 'raise', to}
  function act(st, seat, action) {
    var o = options(st, seat);
    if (!o) return st;
    var s = Z.clone(st), p = s.players[seat];
    p.acted = true;
    if (action.type === 'fold' && o.toCall > 0) { p.folded = true; p.last = 'fold'; }
    else if (action.type === 'raise' && o.canRaise) {
      var to = Math.max(o.minTo, Math.min(o.maxTo, Math.round(action.to)));
      post(p, to - p.bet);
      var size = to - s.currentBet;
      if (size >= s.minRaise) {
        s.minRaise = size;
        s.players.forEach(function (q, i) { if (i !== seat) { q.acted = false; q.locked = false; } });
      } else s.players.forEach(function (q, i) { if (i !== seat && q.acted) q.locked = true; });
      s.currentBet = to;
      p.last = (p.allIn ? 'all in ' : 'raise to ') + to;
    } else {
      var pay = post(p, o.toCall);
      p.last = o.toCall === 0 ? 'check' : p.allIn ? 'all in ' + p.bet : 'call ' + pay;
    }
    return review(s, seat);
  }
  // After an action: who is next, or the street/hand ends.
  function review(s, from) {
    var live = s.players.filter(inHand);
    if (live.length === 1) return award(s, false);
    var actors = s.players.filter(canAct), matched = actors.every(function (p) { return p.bet >= s.currentBet; });
    var settled = actors.every(function (p) { return p.acted; }) && matched;
    if (actors.length === 0 || (actors.length === 1 && matched && actors[0].bet >= s.currentBet) || settled) return endStreet(s);
    s.toAct = nextWhere(s, from, function (p) { return canAct(p) && (!p.acted || p.bet < s.currentBet); });
    if (s.toAct < 0) return endStreet(s);
    return s;
  }
  // Deal the next street (or go to the showdown) and open the betting.
  function endStreet(s) {
    s.players.forEach(function (p) { p.bet = 0; p.acted = false; p.locked = false; if (p.last !== 'fold') p.last = p.allIn ? 'all in' : ''; });
    s.currentBet = 0; s.minRaise = s.blinds[1]; s.runout = false;
    if (s.phase === 'river') return award(s, true);
    s.pos++;
    var n = s.phase === 'preflop' ? 3 : 1, k;
    for (k = 0; k < n; k++) s.board.push(s.deck[s.pos++]);
    s.phase = s.phase === 'preflop' ? 'flop' : s.phase === 'flop' ? 'turn' : 'river';
    if (s.players.filter(canAct).length < 2) { s.runout = true; s.toAct = -1; return s; }
    s.toAct = nextWhere(s, s.dealer, canAct);
    return s;
  }
  // The next street of a run-out (everyone left is all in), one step at a time.
  function runStep(st) { return st.runout ? endStreet(Z.clone(st)) : st; }

  // Hand over: pots go to the best hands (ties split, odd chips to the first seat left of the button).
  function award(s, showdown) {
    var res = { pots: [], hands: {}, lines: [], showdown: showdown, winners: [] }, seat;
    s.runout = false; s.toAct = -1;
    var pots = showdown ? sidePots(s.players) : [{ amount: totalPot(s), eligible: [s.players.findIndex(inHand)] }];
    if (showdown) {
      s.players.forEach(function (p, i) {
        if (inHand(p)) { var all = p.hole.concat(s.board), ev = evaluate(all); res.hands[i] = { name: ev.name, score: ev.score, five: bestFive(all), cat: ev.cat }; }
      });
    }
    var n = s.players.length;
    pots.forEach(function (pot, k) {
      var best = Math.max.apply(null, pot.eligible.map(function (i) { return showdown ? res.hands[i].score : 0; }));
      var winners = pot.eligible.filter(function (i) { return !showdown || res.hands[i].score === best; });
      var share = Math.floor(pot.amount / winners.length), odd = pot.amount - share * winners.length;
      var order = winners.slice().sort(function (a, b) { return ((a - s.dealer + n) % n || n) - ((b - s.dealer + n) % n || n); });
      order.forEach(function (i, j) { s.players[i].chips += share + (j < odd ? 1 : 0); });
      res.pots.push({ amount: pot.amount, winners: winners, eligible: pot.eligible, name: k === 0 ? TX('holdem.mainPot') : pots.length > 2 ? TX('holdem.sidePotN', { n: k }) : TX('holdem.sidePot') });
      winners.forEach(function (i) { if (res.winners.indexOf(i) < 0) res.winners.push(i); });
    });
    s.result = res;
    s.players.forEach(function (p) { if (p.chips === 0) p.last = 'out'; });
    s.phase = gameState(s) ? 'over' : 'between';
    return s;
  }
  // 'won' / 'lost' once decided, else ''. st.people (set by the page) lists the seats people play,
  // seat 0 by default: lost when none of them has chips, won when one player holds every chip.
  function gameState(st) {
    if (!(st.people || [0]).some(function (h) { return st.players[h].chips > 0; })) return 'lost';
    return st.players.filter(function (p) { return p.chips > 0; }).length === 1 ? 'won' : '';
  }

  // ── The computer players ────────────────────────────────────────────────
  // Share of the pot won in `sims` random run-outs against the other live players' unknown hands.
  function equity(st, seat, rng, sims) {
    var p = st.players[seat], known = p.hole.concat(st.board), pool = [], i, wins = 0, others = st.players.filter(function (q, j) { return j !== seat && inHand(q); }).length;
    for (i = 0; i < 52; i++) if (known.indexOf(i) < 0) pool.push(i);
    var need = 5 - st.board.length, sim, k;
    for (sim = 0; sim < sims; sim++) {
      var take = others * 2 + need, a;
      for (k = 0; k < take; k++) { var j = k + Math.floor(rng() * (pool.length - k)); a = pool[k]; pool[k] = pool[j]; pool[j] = a; }
      var board = st.board.concat(pool.slice(others * 2, take)), mine = evaluate(p.hole.concat(board)).score, beaten = 0, tied = 0, o;
      for (o = 0; o < others; o++) { var th = evaluate([pool[o * 2], pool[o * 2 + 1]].concat(board)).score; if (th > mine) { beaten = -1; break; } if (th === mine) tied++; }
      if (beaten === 0) wins += 1 / (tied + 1);
    }
    return wins / sims;
  }
  var roundTo = function (v, unit) { return Math.round(v / unit) * unit; };
  function aiAction(st, seat, rng) {
    var p = st.players[seat], o = options(st, seat), style = STYLES[p.style] || STYLES.tight;
    var rivals = st.players.filter(function (q, i) { return i !== seat && inHand(q); }).length, fair = 1 / (rivals + 1);
    var eq = Math.max(0, Math.min(1, equity(st, seat, rng, SIM_COUNT) + (rng() - 0.5) * 0.05));
    var pot = o.pot, rel = eq / fair, potOdds = o.toCall / (pot + o.toCall), pre = st.phase === 'preflop';
    var callNeed = (potOdds + 0.02 + style.tight * 0.04) * (pre ? 0.7 : 1) * style.call;
    var raiseRel = 1.55 + style.tight * 0.18 - style.aggr * 0.25;
    var wantRaise = o.canRaise && rel >= raiseRel && rng() < 0.45 + 0.5 * style.aggr;
    var bluff = o.canRaise && rel < 1.05 && o.toCall <= pot * 0.35 && rng() < style.bluff;
    if (wantRaise || bluff) {
      var frac = bluff ? 0.55 : rel > 2.2 ? 0.9 + 0.3 * style.aggr : 0.5 + 0.3 * style.aggr;
      var to = roundTo(st.currentBet + Math.max(st.minRaise, (pot + o.toCall) * frac), CHIP_UNIT);
      to = Math.max(o.minTo, Math.min(o.maxTo, to));
      if (to >= (p.chips + p.bet) * 0.6 && rel > 1.3) to = o.maxTo;
      return { type: 'raise', to: to };
    }
    if (o.toCall === 0) return { type: 'call' };
    if (eq >= callNeed || o.toCall <= st.blinds[1] * 0.5 && rel > 0.8) return { type: 'call' };
    return { type: 'fold' };
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var TAG_H = 42, SEAT_GAP = 6, POT_H = 22, ME_H = 22;
  function geo(m) { return T.geometry(m, 1); }
  // Where the opponents' seats are: a row across the top, centres evenly spread.
  function seatBoxes(g, n) {
    var w = (g.W - 2 * g.pad) / n, out = [], k;
    for (k = 0; k < n; k++) out.push({ x: g.pad + k * w, w: w, y: g.northY });
    return out;
  }
  // The shared cards sit just under the opponents' seats, leaving the middle to the panel.
  var boardY = function (g) { return Math.round(g.northY + TAG_H + g.ch + POT_H + 14); };
  // The person looking sits at the bottom (view.viewer), the others follow clockwise across the top.
  // Their two cards are face down while it is not their turn to act, until a showdown shows them.
  var relSeat = function (seat, V, n) { return (seat - V + n) % n; };
  function place(st, m, view) {
    var g = geo(m), slots = [], cards = [], n = st.players.length, boxes = seatBoxes(g, n - 1), V = (view && view.viewer) || 0;
    var showAll = handDone(st) && st.result && st.result.showdown;
    var seatCards = function (p, x0, w, y, step, up, pile, marks) {
      var span = g.cw + (p.hole.length - 1) * step, x = x0 + (w - span) / 2;
      p.hole.forEach(function (id, k) { cards.push({ id: id, pile: pile, idx: k, x: Math.round(x + k * step), y: Math.round(y), up: up, mark: marks && marks.indexOf(id) >= 0, dim: p.folded && !up }); });
    };
    var fiveOf = function (i) { return showAll && st.result.hands[i] && st.result.winners.indexOf(i) >= 0 ? st.result.hands[i].five : null; };
    slots.push({ id: 'table', x: g.pad, y: g.northY, w: g.W - 2 * g.pad, h: g.southY - g.northY + g.ch, quiet: true, label: TX('cards.slot.table') });
    st.players.forEach(function (p, i) {
      if (!p.hole.length) return;
      var five = fiveOf(i);
      if (i === V) seatCards(p, g.pad, g.W - 2 * g.pad, g.southY, g.cw * 1.08, !(view && view.hideHand) || (!p.folded && showAll), 'h0', five);
      else { var box = boxes[relSeat(i, V, n) - 1]; seatCards(p, box.x, box.w, g.northY + TAG_H, Math.min(g.cw * 0.5, box.w * 0.28), !p.folded && showAll, 'p' + i, five); }
    });
    var bw = Math.min(g.cw + g.cw * 0.18, (g.W - 2 * g.pad) / 5.3), bx = g.W / 2 - (5 * bw - (bw - g.cw)) / 2, by = boardY(g);
    st.board.forEach(function (id, k) {
      var marked = st.result && st.result.showdown && st.result.winners.some(function (i) { return st.result.hands[i].five.indexOf(id) >= 0; });
      cards.push({ id: id, pile: 'b', idx: k, x: Math.round(bx + k * bw), y: by, up: true, mark: !!marked });
    });
    for (var k = st.board.length; k < 5; k++) slots.push({ id: 'b' + k, x: Math.round(bx + k * bw), y: by, w: g.cw, h: g.ch, quiet: true, label: TX('holdem.shared') });
    return { height: m.H, slots: slots, cards: cards };
  }

  var api = {
    START_CHIPS: START_CHIPS, STYLES: STYLES, OPPONENTS: OPPONENTS, BLIND_LEVELS: BLIND_LEVELS, evaluate: evaluate, bestFive: bestFive, sidePots: sidePots,
    newGame: freshGame, startHand: startHand, options: options, act: act, runStep: runStep, gameState: gameState, aiAction: aiAction, equity: equity,
    totalPot: totalPot, place: place, geo: geo, seatBoxes: seatBoxes, TAG_H: TAG_H, CPU_NAMES: [TX('seats.cpu.6')].concat(OPPONENTS.map(function (o) { return o[0]; }))
  };
  root.ZimiHoldem = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 700, QUICK_MS = 300, FINISH_MS = 1800, STREET_MS = 1000, OPP_KEY = 'holdem.opponents';
  function boot() {
    var d = root.document, t, board, session, view = { flash: '', sizing: false }, tags = [], rng = Math.random, raiseTo = null;
    function opponents() { var v = Z.store.get(OPP_KEY, 3); return v >= 3 && v <= 5 ? v : 3; }
    // Seats are the Computer or a Person (a computer keeps its own name and style). The count follows the
    // table size, so a new game builds a fresh ZimiSeats and the facade below hands out its methods.
    var seats = {};
    function buildSeats(n) {
      var cur = Seats.create({ id: 'holdem', seats: n, cpuNames: api.CPU_NAMES, onChange: function () { repaint(); } });
      Object.keys(cur).forEach(function (k) { seats[k] = cur[k]; });
    }
    buildSeats(opponents() + 1);
    var nm = function (seat) { return seats.name(seat); };
    function syncView(st) { if (st.toAct !== seats.view()) view.sizing = false; view.viewer = seats.view(); view.hideHand = seats.hotseat() && st.toAct !== view.viewer; }
    function repaint() { if (board) board.refresh(); if (t) t.paint(); }
    function chipsLeft(st) { return st.players[seats.view()].chips; }
    function yourHand(st) {
      var p = st.players[seats.view()];
      return p.hole.length && !p.folded && !view.hideHand ? evaluate(p.hole.concat(st.board)).name : '';
    }
    // The stored last action is a plain code; what it says on screen is decided here.
    function lastText(last) {
      var m = /^(raise to|all in|call) (\d+)$/.exec(last);
      if (m) return TX('holdem.last.' + m[1].replace(/ (\w)/, function (x, c) { return c.toUpperCase(); }), { n: m[2] });
      return { fold: TX('holdem.last.fold'), check: TX('holdem.last.check'), 'small blind': TX('holdem.smallBlind'), 'big blind': TX('holdem.bigBlind'), 'all in': TX('holdem.allIn'), out: TX('holdem.out') }[last] || last;
    }
    var tagSig = '';
    function layTags(st, m) {
      var g = geo(m), n = st.players.length, boxes = seatBoxes(g, n - 1), V = seats.view();
      var sig = JSON.stringify([V, st.players.map(function (p) { return [p.chips, p.bet, p.folded, p.out, p.last]; }), st.toAct, st.dealer, st.phase, st.board.length, totalPot(st), st.result && st.result.winners, g.W, g.northY, g.southY]);
      if (sig === tagSig) return;
      tagSig = sig;
      tags.forEach(function (e) { e.remove(); }); tags = [];
      st.players.forEach(function (p, i) {
        var box = i === V ? { x: g.pad, w: g.W - 2 * g.pad, y: g.southY - ME_H - 2 } : boxes[relSeat(i, V, n) - 1];
        var big = nm(i), w = Math.min(box.w - SEAT_GAP, i === V ? 260 : 150);
        var cls = 'c2-tag' + (i === V ? ' c2-me' : '') + (st.toAct === i && !handDone(st) ? ' c2-turn' : '') + (p.folded || p.out ? ' c2-out' : '') + (st.dealer === i && !p.out ? ' c2-dealer' : '');
        var line = p.out ? TX('holdem.out') : p.last && !handDone(st) || (p.last === 'fold') ? lastText(p.last) : (p.bet ? TX('holdem.bet', { n: p.bet }) : '');
        if (handDone(st) && st.result && st.result.hands[i]) line = st.result.winners.indexOf(i) >= 0 ? TX('holdem.catWins', { cat: catName(st.result.hands[i].cat) }) : catName(st.result.hands[i].cat);
        if (p.chips === 0 && handDone(st) && !(st.result && st.result.winners.indexOf(i) >= 0)) line = TX('holdem.out');
        var e = Z.h('div', { class: cls, style: 'left:' + Math.round(box.x + (box.w - w) / 2) + 'px;top:' + Math.round(box.y) + 'px;width:' + w + 'px;height:' + (i === V ? ME_H : TAG_H - 2) + 'px' }, [
          Z.h('b', { text: big + ' ' + p.chips }), Z.h('span', { text: line })]);
        d.getElementById('zc-table').appendChild(e); tags.push(e);
      });
      var potTag = Z.h('div', { class: 'c2-tag', style: 'left:' + Math.round(g.W / 2 - 100) + 'px;top:' + (boardY(g) - POT_H - 4) + 'px;width:200px;height:' + POT_H + 'px' }, [Z.h('span', { text: TX('holdem.pot', { n: totalPot(st), a: st.blinds[0], b: st.blinds[1] }) })]);
      d.getElementById('zc-table').appendChild(potTag); tags.push(potTag);
      // The pot is chips on the table, under the shared cards.
      var pile = Z.h('div', { class: 'ct-pile', style: 'top:' + Math.round(boardY(g) + g.ch + 18) + 'px' });
      if (totalPot(st) > 0) pile.appendChild(T.chipStack(totalPot(st)));
      d.getElementById('zc-table').appendChild(pile); tags.push(pile);
    }
    function hud(st) {
      var m = board.metrics(), out = { chips: [], text: '' };
      layTags(st, m);
      var V = seats.view(), hot = seats.hotseat(), mine = options(st, V), name = yourHand(st);
      out.fact = TX('holdem.fact', { chips: st.players[V].chips });
      if (handDone(st)) {
        var r = st.result, lines = [];
        if (r) {
          r.pots.forEach(function (pot) {
            lines.push({ text: TX(pot.winners.length > 1 ? 'holdem.potSplit' : 'holdem.potWins', { pot: pot.name, amount: pot.amount, who: pot.winners.map(function (i) { return r.showdown && r.hands[i] ? TX('holdem.withHand', { name: nm(i), hand: r.hands[i].name }) : nm(i); }).join(' ' + TX('crib.and') + ' ') }) });
          });
          if (r.showdown) st.players.forEach(function (p, i) { if (r.hands[i] && r.winners.indexOf(i) < 0) lines.push({ text: TX('holdem.loser', { name: nm(i), hand: r.hands[i].name }) }); });
        }
        out.lines = lines;
        if (st.phase === 'over') { out.text = overText(st); out.label = TX('shell.menu.new'); out.action = newGame; }
        else { out.text = st.started ? '' : TX('holdem.tapDeal'); if (st.started) out.fact = ''; out.choices = [{ label: st.started ? TX('cards.nextHand') : TX('holdem.deal'), primary: true, onclick: nextHand }]; }
        return out;
      }
      if (mine) {
        out.text = (hot ? TX('holdem.nameColon', { name: nm(V) }) + ' ' : '') + (name ? TX(hot ? 'holdem.youHave.hot' : 'holdem.youHave', { hand: name.toLocaleLowerCase() }) + ' ' : '') + (mine.check ? TX(hot ? 'holdem.turn.hot' : 'cards.turn.you') : TX('holdem.toCall', { n: mine.toCall }));
        out.choices = [{ label: TX('holdem.fold'), onclick: function () { play({ type: 'fold' }); }, disabled: mine.check, aria: TX('holdem.fold') }, { label: mine.check ? TX('holdem.check') : TX('holdem.call', { n: mine.toCall }), onclick: function () { play({ type: 'call' }); } }];
        if (mine.canRaise) {
          // Four buttons at most: Raise opens the sizes in the same place, and Back closes them.
          var sizes = [], seen = {}, base = st.currentBet, potNow = mine.pot + mine.toCall;
          [['min', mine.minTo], ['half', base + potNow / 2], ['pot', base + potNow]].forEach(function (x) {
            var to = Math.max(mine.minTo, Math.min(mine.maxTo, roundTo(x[1], CHIP_UNIT)));
            if (to < mine.maxTo && !seen[to]) { seen[to] = 1; sizes.push({ label: TX('holdem.size.' + x[0], { n: to }), to: to }); }
          });
          var raise = function (to) { return function () { view.sizing = false; play({ type: 'raise', to: to }); }; };
          if (view.sizing && sizes.length) {
            out.text = TX('holdem.sizePrompt');
            out.choices = sizes.map(function (sz) { return { label: sz.label, onclick: raise(sz.to) }; }).concat([{ label: TX('shell.back'), onclick: function () { view.sizing = false; t.paint(); } }]);
          } else {
            out.choices.push({ label: TX(st.currentBet ? 'holdem.raiseBtn' : 'holdem.betBtn'), disabled: !sizes.length, onclick: function () { view.sizing = true; t.paint(); } });
            out.choices.push({ label: TX('holdem.allInN', { n: mine.maxTo }), onclick: raise(mine.maxTo) });
          }
        }
      } else if (st.runout) out.text = TX('holdem.allInAll');
      else out.text = st.toAct >= 0 ? TX(seats.person(st.toAct) ? 'ce.next' : 'cards.thinking', { name: nm(st.toAct) }) : '';
      return out;
    }
    function overText(st) {
      var w = st.players.findIndex(function (p) { return p.chips > 0; });
      if (seats.hotseat()) return gameState(st) === 'won' ? TX('holdem.hasAll', { name: nm(w) }) : TX('holdem.nobody');
      return TX(gameState(st) === 'won' ? 'holdem.youAll' : 'holdem.youOut');
    }
    function drive() {
      var st = session.state;
      if (handDone(st)) { finish(st); return; }
      if (st.runout) { session.later(function () { session.follow(runStep(session.state)); drive(); }, STREET_MS); return; }
      if (st.toAct < 0) return;
      if (seats.person(st.toAct)) { seats.ensure(st.toAct, repaint); return; }
      session.later(aiMove, seats.people().every(function (p) { return st.players[p].folded || st.players[p].out; }) ? QUICK_MS : AI_MS);
    }
    function aiMove() {
      var st = session.state;
      if (st.toAct < 0 || seats.person(st.toAct) || handDone(st)) return;
      session.follow(act(st, st.toAct, aiAction(st, st.toAct, rng)));
      drive();
    }
    var ended = false;
    function finish(st) {
      var gs = gameState(st);
      if (!gs || ended) return;
      ended = true; session.later(function () { conclude(st, gs); }, FINISH_MS);
    }
    function conclude(st, gs) {
      var lines = [TX(gs === 'won' ? 'holdem.playedWon' : 'holdem.playedOut', { hands: Z.plural(st.handNo, 'hand') })];
      if (seats.hotseat()) { session.lose(gs === 'won' ? { name: nm(st.players.findIndex(function (p) { return p.chips > 0; })) } : 'over', [TX('holdem.handsPlayed', { hands: Z.plural(st.handNo, 'hand'), text: overText(st) })], undefined); return; }
      if (gs === 'won') session.win(chipsLeft(st)); else session.lose(TX('holdem.outOfChips'), lines, chipsLeft(st));
    }
    function play(action) { var st = session.state, V = seats.view(); view.sizing = false; if (st.toAct !== V) return; session.follow(act(st, V, action)); drive(); }
    function nextHand() {
      var st = session.state;
      if (st.phase !== 'between') return;
      session.commit(startHand(st, rng)); session.history = [];
      // A fresh deal: nobody has seen it, so a table of people starts at a handoff.
      seats.begin(function () { repaint(); drive(); }, session.state.toAct);
    }
    function newGame() {
      ended = false; view.flash = '';
      buildSeats(opponents() + 1);
      var fresh = freshGame(rng, opponents());
      fresh.people = seats.people();
      session.reset(fresh);
    }
    t = T.create({
      id: 'holdem', name: 'Texas Hold’em', seats: seats, view: view, geo: geo, place: function (st, m, v) { syncView(st); return place(st, m, v); }, hud: hud, newGame: newGame, cols: 7, heightShare: 0.1,
      stat: function (sec, st) { return TX('holdem.fact', { chips: chipsLeft(st) }); },
      cascadeOrder: function (st) { return st.board.concat(st.players[seats.view()].hole).map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return [TX('holdem.tookAll', { hands: Z.plural(st.handNo, 'hand') })]; },
      menuExtra: function () {
        var rows = [T.choiceRow(TX('cards.seatsAtTable'), OPP_KEY, [3, 4, 5].map(function (n) { return { label: String(n + 1), value: n }; }), 3, function () { /* next game */ }),
          Z.h('p', { class: 'zc-note', text: TX('holdem.nextGame') })];
        rows.push(Z.h('p', { class: 'zc-note', text: TX('holdem.computers', { list: OPPONENTS.map(function (o) { return TX('holdem.plays', { name: o[0], style: STYLES[o[1]].label }); }).join('; ') }) }));
        return rows;
      },
      rules: TX('holdem.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    if (root.ResizeObserver) new root.ResizeObserver(function () { t.paint(); }).observe(d.getElementById('zc-table'));
    newGame();
    // Keyboard: F fold, C check or call.
    d.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey || d.querySelector('.ar-sheet')) return;
      var st = session.state, k = e.key.toLowerCase();
      if (!st || st.toAct !== seats.view() || seats.covering) { if (st && st.phase === 'between' && k === 'enter' && d.activeElement === d.body) nextHand(); return; }
      if (k === 'f') { play({ type: 'fold' }); e.preventDefault(); } else if (k === 'c') { play({ type: 'call' }); e.preventDefault(); }
    });
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
