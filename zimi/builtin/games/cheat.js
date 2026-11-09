/* ZimiGames: Cheat, two to four players: you (south) against the computer players. All 52 cards are dealt out. The ranks come round in
   order, ace to king and on again, one for each turn. On your turn you put one to four cards face down on the pile and say they are
   all of that rank, whether they are or not. After a play, anyone may call it. A call that finds a wrong card makes the player who
   played take the whole pile; a call that finds only the rank said makes the caller take it. The first to get rid of every card, and
   survive the call that follows, wins.

   State: players, hands[n], pile (face down, bottom first), claim (the rank to be said this turn, 1 to 13), turn, phase ('play' |
   'call' | 'over'), callers (the seats still to say, in order, while phase is 'call'), last (the latest play: seat, rank, count,
   ids, and once it was called, call { caller, lying, loser, n }), tells[n] ({ called, lied }: what each player has been caught doing, which the computer
   remembers), turns, winner, moves. Pure functions; the page wiring only runs
   in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;

  var MAX_PLAY = 4, RANKS = 13, TURN_CAP = 400, PLAYERS_KEY = 'cheat.players', DEFAULT_PLAYERS = 3;
  var rankOf = function (id) { return Z.rank(id); };
  var SUIT_ORDER = [0, 1, 3, 2];
  function sorted(ids) { return ids.slice().sort(function (a, b) { return rankOf(a) - rankOf(b) || SUIT_ORDER.indexOf(Z.suit(a)) - SUIT_ORDER.indexOf(Z.suit(b)); }); }
  var count = function (hand, rank) { return hand.filter(function (c) { return rankOf(c) === rank; }).length; };

  // ── Rules ───────────────────────────────────────────────────────────────
  function deal(order, players, first) {
    var hands = [], i;
    for (i = 0; i < players; i++) hands.push([]);
    order.forEach(function (c, k) { hands[k % players].push(c); });
    return { players: players, hands: hands.map(sorted), pile: [], claim: 1, turn: first || 0, phase: 'play', callers: [], last: null, tells: hands.map(function () { return { called: 0, lied: 0 }; }), turns: 0, winner: -1, moves: 0 };
  }
  function canPlay(st, seat, ids) {
    if (st.phase !== 'play' || st.turn !== seat || !ids.length || ids.length > MAX_PLAY) return false;
    return ids.every(function (c, i) { return st.hands[seat].indexOf(c) >= 0 && ids.indexOf(c) === i; });
  }
  // The cards go on the pile, said to be of the rank due; everyone else may now call.
  function play(st, seat, ids) {
    var s = Z.clone(st), k;
    ids.forEach(function (c) { s.hands[seat].splice(s.hands[seat].indexOf(c), 1); });
    s.pile = s.pile.concat(ids);
    s.last = { seat: seat, rank: s.claim, count: ids.length, ids: ids.slice(), call: null };
    s.callers = [];
    for (k = 1; k < s.players; k++) s.callers.push((seat + k) % s.players);
    s.phase = 'call'; s.moves++;
    return s;
  }
  var wasTrue = function (last) { return last.ids.every(function (c) { return rankOf(c) === last.rank; }); };
  // After a play nobody called, or a call settled: the next turn, the next rank, or the win.
  function advance(s) {
    var seat = s.last.seat;
    s.turns++;
    if (!s.hands[seat].length) { s.phase = 'over'; s.winner = seat; return s; }
    if (s.turns >= TURN_CAP) {
      var fewest = Math.min.apply(null, s.hands.map(function (h) { return h.length; })), at = s.hands.map(function (h, i) { return h.length === fewest ? i : -1; }).filter(function (i) { return i >= 0; });
      s.phase = 'over'; s.winner = at.length === 1 ? at[0] : -1;
      return s;
    }
    s.turn = (seat + 1) % s.players; s.claim = s.claim % RANKS + 1; s.phase = 'play'; s.callers = [];
    return s;
  }
  // `caller` says whether to call the play just made. The seats say in order; a call settles it, and all letting it go leaves it.
  function decide(st, caller, calls) {
    if (st.phase !== 'call' || st.callers[0] !== caller) return st;
    var s = Z.clone(st);
    if (!calls) { s.callers.shift(); s.moves++; return s.callers.length ? s : advance(s); }
    var lying = !wasTrue(s.last), loser = lying ? s.last.seat : caller, n = s.pile.length;
    s.hands[loser] = sorted(s.hands[loser].concat(s.pile)); s.pile = [];
    s.last.call = { caller: caller, lying: lying, loser: loser, n: n }; s.moves++;
    if (!s.tells) s.tells = s.hands.map(function () { return { called: 0, lied: 0 }; });
    s.tells[s.last.seat].called++; if (lying) s.tells[s.last.seat].lied++;
    return advance(s);
  }
  var decider = function (st) { return st.phase === 'call' ? st.callers[0] : -1; };

  // ── The computer players ────────────────────────────────────────────────
  // What to put down. With the rank due in hand it plays all of them, and now and then slips one more in; without, it bluffs one card
  // (or two), the ones whose turn to be said is furthest off, so the cards it will want soon stay.
  function aiPlay(st, seat, rng) {
    rng = rng || Math.random;
    var hand = st.hands[seat], r = st.claim, have = hand.filter(function (c) { return rankOf(c) === r; });
    var away = function (c) { return (rankOf(c) - r + RANKS) % RANKS; };
    var others = hand.filter(function (c) { return rankOf(c) !== r; }).sort(function (a, b) { return away(b) - away(a); });
    if (have.length) {
      var out = have.slice(0, MAX_PLAY);
      if (out.length < MAX_PLAY && others.length > 1 && rng() < 0.2) out.push(others[0]);
      return out;
    }
    var n = Math.min(others.length, rng() < 0.3 && others.length > 2 ? 2 : 1);
    return others.slice(0, n);
  }
  // Whether to call the play just made. Sure when the cards said cannot all be out there. Otherwise by how likely it is to be a lie (below),
  // and a player about to go out is called far more often, while a computer with few cards of its own is careful.
  var CALL_BOLDNESS = 0.9, GOING_OUT_CALL = 0.9, NEAR_OUT_CALL = 0.6, BIG_PILE = 10, BIG_PILE_DAMP = 0.8, SMALL_HAND = 3, SMALL_HAND_DAMP = 0.5, MIN_CALL = 0.04;
  // The chance that a hand of `drawn` cards from `unseen` cards, `wanted` of them of the rank, holds exactly k of it: C(wanted, k) * C(unseen - wanted, drawn - k) / C(unseen, drawn), by logarithms so nothing overflows.
  function hyper(unseen, wanted, drawn, k) {
    var logChoose = function (n, r) { var v = 0, j; r = Math.min(r, n - r); for (j = 0; j < r; j++) v += Math.log((n - j) / (j + 1)); return v; };
    if (drawn - k > unseen - wanted || k > wanted || drawn > unseen) return 0;
    return Math.exp(logChoose(wanted, k) + logChoose(unseen - wanted, drawn - k) - logChoose(unseen, drawn));
  }
  // How the computer reads a play: a player holding the rank puts it all down (now and then with one more), and one holding none says one
  // or two. So the claim of n is a lie when the player held none, and true when they held about n: weighed by how likely each was.
  var BLUFF_ONE = 0.7, BLUFF_TWO = 0.3, EXTRA = 0.2, TELL_WEIGHT = 0.5, TELL_AFTER = 3;
  function lieChance(st, seat) {
    var l = st.last, mine = count(st.hands[seat], l.rank), left = st.hands[l.seat].length, unseen = 52 - st.hands[seat].length, held = Math.min(left + l.count, unseen), wanted = MAX_PLAY - mine;
    var none = hyper(unseen, wanted, held, 0), exact = hyper(unseen, wanted, held, l.count), shy = l.count > 1 ? hyper(unseen, wanted, held, l.count - 1) : 0;
    var liar = none * (l.count === 1 ? BLUFF_ONE : l.count === 2 ? BLUFF_TWO : 0), truth = exact * (1 - EXTRA) + shy * EXTRA;
    var p = liar + truth > 0 ? liar / (liar + truth) : 0.5, tell = st.tells && st.tells[l.seat];
    if (tell && tell.called >= TELL_AFTER) p = (1 - TELL_WEIGHT) * p + TELL_WEIGHT * (tell.lied + 1) / (tell.called + 2);
    return p;
  }
  function aiCall(st, seat, rng) {
    rng = rng || Math.random;
    var l = st.last;
    if (count(st.hands[seat], l.rank) + l.count > MAX_PLAY) return true;
    var left = st.hands[l.seat].length, p = lieChance(st, seat) * CALL_BOLDNESS;
    if (left === 0) p = Math.max(p, GOING_OUT_CALL); else if (left <= 2) p = Math.max(p, NEAR_OUT_CALL);
    else p = Math.max(p, MIN_CALL);
    if (st.pile.length >= BIG_PILE) p *= BIG_PILE_DAMP;
    if (st.hands[seat].length <= SMALL_HAND) p *= SMALL_HAND_DAMP;
    return rng() < p;
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var SHOW_PILE = 3, PILE_FAN = 4, REVEAL_STEP = 0.5, BADGE_GAP = 6;
  function geo(m, st) { return T.geometry(m, T.rowsFor(m, st.hands[0].length)); }
  function pileSpot(g) { return { x: Math.round(g.cx - g.cw / 2), y: Math.round(g.cy - g.ch / 2) }; }
  function place(st, m, view) {
    var g = geo(m, st), p = pileSpot(g), slots = [], cards = [], picked = (view && view.picked) || [], r;
    slots.push({ id: 'pile', x: p.x, y: p.y, w: g.cw, h: g.ch, quiet: !st.pile.length, label: TX('cheat.pile', { cards: Z.plural(st.pile.length, 'card') }) });
    var hand = T.handCards(g, st.hands[0], function (id) { var on = picked.indexOf(id) >= 0; return { up: true, raise: on, mark: on }; }, function (a, b) { return rankOf(a) !== rankOf(b); });
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    for (r = 1; r < st.players; r++) cards = cards.concat(T.fan(g, T.SEAT_POS[st.players][r], st.hands[r], false));
    st.pile.forEach(function (id, k) { cards.push({ id: id, pile: 'pile', idx: k, x: p.x + Math.max(0, k - (st.pile.length - SHOW_PILE)) * PILE_FAN, y: p.y, up: false, hidden: k < st.pile.length - SHOW_PILE }); });
    // A call turns the cards over: what was said, and what it was.
    if (st.last && st.last.call) {
      var ids = st.last.ids, step = Math.min(g.cw * REVEAL_STEP, (g.W - 2 * g.pad - g.cw) / Math.max(1, ids.length - 1)), x0 = g.cx - (g.cw + (ids.length - 1) * step) / 2;
      ids.forEach(function (id, k) { cards.push({ id: id, pile: 'reveal', idx: k, x: Math.round(x0 + k * step), y: p.y, up: true, glow: rankOf(id) !== st.last.rank }); });
    }
    return { height: m.H, slots: slots, cards: cards };
  }

  var api = {
    MAX_PLAY: MAX_PLAY, TURN_CAP: TURN_CAP, deal: deal, canPlay: canPlay, play: play, decide: decide, decider: decider, wasTrue: wasTrue, aiPlay: aiPlay, aiCall: aiCall, count: count, geo: geo, place: place, pileSpot: pileSpot
  };
  root.ZimiCheat = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 900, DECIDE_MS = 700, SHOW_MS = 1500;
  function boot() {
    var t, board, session, view = { flash: '', picked: [] }, players = DEFAULT_PLAYERS, seats = {};
    var claimBadge = Z.h('div', { class: 'ch-claim', 'aria-live': 'polite' });
    Z.pageEls().table.appendChild(claimBadge);
    function buildSeats(n) {
      var cur = Seats.create({ id: 'cheat', seats: n, cpuNames: [0, 1, 2, 3].map(Seats.cpuName), onChange: function () { if (t) t.paint(); if (board) board.refresh(); } });
      Object.keys(cur).forEach(function (k) { seats[k] = cur[k]; });
    }
    buildSeats(players);
    var name = function (seat) { return seats.name(seat); };
    var label = function (r) { return Z.RANK_LABELS[r - 1]; };
    function repaint() { board.refresh(); t.paint(); }

    function said(st) {
      var l = st.last;
      if (!l) return '';
      var out = TX(l.seat === 0 ? 'cheat.plays.you' : 'cheat.plays', { name: name(l.seat), count: l.count, rank: label(l.rank) });
      if (!l.call) return out;
      var c = l.call, verdict = TX((c.lying ? 'cheat.lied' : 'cheat.truth') + (l.seat === 0 ? '.you' : ''), { name: name(l.seat) });
      return TX('cards.then', { first: TX(c.caller === 0 ? 'cheat.called.you' : 'cheat.called', { name: name(c.caller) }), then: TX(c.loser === 0 ? 'cheat.takes.you' : 'cheat.takes', { name: name(c.loser), cards: Z.plural(c.n, 'card'), verdict: verdict }) });
    }
    function paintClaim(st) {
      var m = board.metrics();
      if (!m) return;
      var g = geo(m, st), p = pileSpot(g);
      claimBadge.style.left = Math.round(p.x + g.cw / 2) + 'px'; claimBadge.style.top = Math.round(p.y + g.ch + BADGE_GAP) + 'px';
      claimBadge.textContent = st.phase === 'over' ? '' : TX('cheat.claim', { rank: label(st.phase === 'call' ? st.last.rank : st.claim) });
      claimBadge.hidden = st.phase === 'over';
    }
    function hud(st) {
      paintClaim(st);
      var chips = st.hands.map(function (h, seat) { return { name: name(seat), text: String(h.length), turn: st.phase === 'play' && st.turn === seat || st.phase === 'call' && st.callers[0] === seat }; });
      var out = { chips: chips, text: '' }, note = said(st);
      var lead = function (text) { return note ? TX('cards.then', { first: note, then: text }) : text; };
      if (st.phase === 'over') { out.text = TX('shell.end.over'); out.label = TX('shell.menu.new'); out.action = newGame; return out; }
      if (st.phase === 'call') {
        var who = st.callers[0];
        if (who === 0) {
          out.text = TX('cheat.callQ', { name: name(st.last.seat), count: st.last.count, rank: label(st.last.rank) });
          out.choices = [{ label: TX('cheat.call'), primary: true, onclick: function () { decideNow(true); } }, { label: TX('cheat.letGo'), onclick: function () { decideNow(false); } }];
        } else out.text = lead(TX('cards.thinking', { name: name(who) }));
        return out;
      }
      if (st.turn !== 0) { out.text = lead(TX('cards.thinking', { name: name(st.turn) })); return out; }
      var picked = view.picked, n = picked.length;
      out.text = lead(TX('cheat.yourTurn', { rank: label(st.claim) }));
      out.choices = [{ label: n ? TX('cheat.playN', { count: n, rank: label(st.claim) }) : TX('cheat.pickCards'), primary: n > 0, disabled: !n, onclick: playNow }];
      return out;
    }

    function drive() {
      var st = session.state;
      if (st.phase === 'over') { gameOver(); return; }
      if (st.phase === 'call') { if (st.callers[0] !== 0) session.later(aiDecide, st.last.seat === 0 ? DECIDE_MS * 2 : DECIDE_MS); return; }
      if (st.turn !== 0) session.later(aiTurn, st.last && st.last.call ? SHOW_MS : AI_MS);
    }
    function aiTurn() {
      var st = session.state;
      if (st.phase !== 'play' || st.turn === 0) return;
      session.follow(play(st, st.turn, aiPlay(st, st.turn)));
      view.picked = [];
      drive();
    }
    function aiDecide() {
      var st = session.state;
      if (st.phase !== 'call' || st.callers[0] === 0) return;
      var who = st.callers[0];
      session.follow(decide(st, who, aiCall(st, who)));
      repaint();
      drive();
    }
    function decideNow(calls) {
      var st = session.state;
      if (st.phase !== 'call' || st.callers[0] !== 0) return;
      session.commit(decide(st, 0, calls));
      drive();
    }
    function playNow() {
      var st = session.state, ids = view.picked.filter(function (c) { return st.hands[0].indexOf(c) >= 0; });
      if (!canPlay(st, 0, ids)) return;
      view.picked = [];
      session.commit(play(st, 0, ids));
      drive();
    }
    function gameOver() {
      var st = session.state, w = st.winner;
      var line = TX(w === 0 ? 'cheat.won.you' : w < 0 ? 'cheat.tied' : 'cheat.won', { name: w >= 0 ? name(w) : '' });
      if (w === 0) session.win(); else session.lose(w < 0 ? 'draw' : '', [line]);
    }
    function tap(pile) {
      var st = session.state;
      if (pile.charAt(0) !== 'h') return false;
      var id = parseInt(pile.slice(1), 10);
      if (isNaN(id) || st.phase === 'over') return false;
      if (st.phase !== 'play' || st.turn !== 0) { t.flash(TX('cards.wait.turn')); return false; }
      var at = view.picked.indexOf(id);
      if (at >= 0) view.picked.splice(at, 1);
      else if (view.picked.length >= MAX_PLAY) { t.flash(TX('cheat.fourOnly')); return false; }
      else view.picked.push(id);
      repaint();
      return true;
    }
    function newGame() {
      players = Z.store.get(PLAYERS_KEY, DEFAULT_PLAYERS);
      if (players !== 2 && players !== 3 && players !== 4) players = DEFAULT_PLAYERS;
      buildSeats(players);
      view.flash = ''; view.picked = [];
      session.reset(deal(Z.shuffled(Math.random), players, Math.floor(Math.random() * players)));
      repaint(); drive();
    }
    t = T.create({
      id: 'cheat', name: 'Cheat', view: view, geo: geo, place: place, hud: hud, newGame: newGame, tap: tap,
      slotTap: function () {},
      canPick: function () { return false; },
      stat: function (sec, st) { return Z.fmtTime(sec) + ' · ' + st.hands[0].length; },
      cascadeOrder: function (st) { return st.last ? st.last.ids.map(function (id) { return { id: id }; }) : []; },
      winLines: function (sec, st) { return [TX('cheat.won.you', { name: '' })]; },
      menuExtra: function () {
        return [T.choiceRow(TX('cards.seatsAtTable'), PLAYERS_KEY, [{ value: 2, label: '2' }, { value: 3, label: '3' }, { value: 4, label: '4' }], DEFAULT_PLAYERS, function () {}),
          Z.h('p', { class: 'zc-note', text: TX('ce.seatsNote') })];
      },
      rules: TX('cheat.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    newGame();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
