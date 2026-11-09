/* ZimiGames: Old Maid, two to four players: you (south) against the computer players. One queen is taken out, so one queen has
   no partner: the Old Maid. Everyone lays down their pairs (two cards of one rank). Then, in turn, you take one card, unseen,
   from the next player with cards; if it matches one of yours the pair goes down. A player with no cards is safe. The last
   one holding the Old Maid loses.

   State: players, hands[n], pairs[n] (pairs laid down), out (seats in the order they went safe), turn (who takes next), phase
   ('play' | 'over'), last (the latest take), result { loser, order }, moves. Pure functions; the page wiring only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, Seats = root.ZimiSeats, TX = root.ZimiCards.T;

  var PLAYERS_KEY = 'oldmaid.players', DEFAULT_PLAYERS = 2, QUEEN = 12, TAKEN_OUT = Z.make(QUEEN, 0);
  var rankOf = function (id) { return Z.rank(id); };
  var SUIT_ORDER = [0, 1, 3, 2];
  function sorted(ids) { return ids.slice().sort(function (a, b) { return rankOf(a) - rankOf(b) || SUIT_ORDER.indexOf(Z.suit(a)) - SUIT_ORDER.indexOf(Z.suit(b)); }); }

  // ── Rules ───────────────────────────────────────────────────────────────
  // Pairs by rank leave a hand; a rank held three times keeps one.
  function layPairs(hand) {
    var byRank = {}, kept = [], pairs = 0;
    sorted(hand).forEach(function (c) {
      var r = rankOf(c);
      if (byRank[r] !== undefined) { kept.splice(kept.indexOf(byRank[r]), 1); delete byRank[r]; pairs++; } else { byRank[r] = c; kept.push(c); }
    });
    return { hand: kept, pairs: pairs };
  }
  var holders = function (s) { return s.hands.filter(function (h) { return h.length; }).length; };
  // The next seat after `seat` that still holds cards, or -1.
  function nextHolder(st, seat) {
    for (var i = 1; i < st.players; i++) if (st.hands[(seat + i) % st.players].length) return (seat + i) % st.players;
    return -1;
  }
  // The seat `turn` takes from.
  var source = function (st) { return nextHolder(st, st.turn); };
  // A shuffled 52 (the queen of clubs is left out), dealt round the table, the first pairs laid down at once.
  function deal(order, players, first) {
    var cards = order.filter(function (c) { return c !== TAKEN_OUT; }), hands = [], pairs = [], s;
    for (s = 0; s < players; s++) hands.push([]);
    cards.forEach(function (c, i) { hands[i % players].push(c); });
    hands = hands.map(function (h, i) { var r = layPairs(h); pairs[i] = r.pairs; return r.hand; });
    var st = { players: players, hands: hands, pairs: pairs, out: [], turn: first || 0, phase: 'play', last: null, result: null, moves: 0 };
    settle(st);
    return st;
  }
  // Anyone left with no cards is safe; one holder left is the loser; the turn moves off a safe seat.
  function settle(s) {
    s.hands.forEach(function (h, seat) { if (!h.length && s.out.indexOf(seat) < 0) s.out.push(seat); });
    if (holders(s) <= 1) {
      var loser = s.hands.findIndex(function (h) { return h.length; });
      s.phase = 'over'; s.result = { loser: loser, order: s.out.slice() };
      return;
    }
    if (!s.hands[s.turn].length) s.turn = nextHolder(s, s.turn);
  }
  function canTake(st, seat, idx) {
    var from = source(st);
    return st.phase === 'play' && st.turn === seat && from >= 0 && idx >= 0 && idx < st.hands[from].length;
  }
  // `seat` takes the card at `idx` of the next holder's hand; a match goes down with its partner.
  function take(st, seat, idx) {
    var s = Z.clone(st), from = source(s), card = s.hands[from].splice(idx, 1)[0], last = { seat: seat, from: from, card: card, paired: false };
    var mate = s.hands[seat].filter(function (c) { return rankOf(c) === rankOf(card); })[0];
    if (mate !== undefined) { s.hands[seat].splice(s.hands[seat].indexOf(mate), 1); s.pairs[seat]++; last.paired = true; last.rank = rankOf(card); } else s.hands[seat] = sorted(s.hands[seat].concat([card]));
    s.last = last; s.moves++;
    // The next to take is the next holder after the taker (who may have just gone safe).
    s.turn = seat;
    settle(s);
    if (s.phase === 'play') s.turn = nextHolder(s, seat);
    return s;
  }
  // The computer takes a card at random: it cannot see them, and it shuffles its own hand so a take tells nothing.
  function aiTake(st, seat, rng) {
    var from = source(st);
    return from < 0 ? -1 : Math.floor((rng || Math.random)() * st.hands[from].length);
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  function geo(m, st) { return T.geometry(m, T.rowsFor(m, st.hands[0].length)); }
  function place(st, m, view) {
    var g = geo(m, st), slots = [], cards = [], V = (view && view.viewer) || 0, up = !(view && view.hideHand), r;
    var hand = T.handCards(g, st.hands[V], function () { return { up: up }; }, function (a, b) { return rankOf(a) !== rankOf(b); });
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    for (r = 1; r < st.players; r++) cards = cards.concat(T.fan(g, T.SEAT_POS[st.players][r], st.hands[(V + r) % st.players], false));
    return { height: m.H, slots: slots, cards: cards };
  }

  var api = {
    TAKEN_OUT: TAKEN_OUT, layPairs: layPairs, deal: deal, nextHolder: nextHolder, source: source, canTake: canTake, take: take, aiTake: aiTake, geo: geo, place: place
  };
  root.ZimiOldMaid = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 900;
  function boot() {
    var t, board, session, view = { flash: '', viewer: 0 }, players = DEFAULT_PLAYERS, seats = {};
    function buildSeats(n) {
      var cur = Seats.create({ id: 'oldmaid', seats: n, onChange: function () { if (t) t.paint(); if (board) board.refresh(); } });
      Object.keys(cur).forEach(function (k) { seats[k] = cur[k]; });
    }
    buildSeats(players);
    var name = function (seat) { return seats.name(seat); };
    function syncView(st) { view.viewer = seats.view(); view.hideHand = seats.hotseat() && st.turn !== view.viewer; }
    function repaint() { board.refresh(); t.paint(); }
    var rankWord = function (r) { return TX('cards.rank.' + r); };

    // What the last take was: you see the card when you took it or it was taken from you, and a pair says its rank.
    function said(st) {
      var l = st.last;
      if (!l) return '';
      var me = seats.view(), hot = seats.hotseat(), out;
      if (!hot && l.seat === me) out = TX('oldmaid.took.you', { card: Z.cardName(l.card), from: name(l.from) });
      else if (!hot && l.from === me) out = TX('oldmaid.took.ofYou', { name: name(l.seat), card: Z.cardName(l.card) });
      else out = TX('oldmaid.took', { name: name(l.seat), from: name(l.from) });
      return l.paired ? TX('cards.then', { first: out, then: TX('oldmaid.pair', { rank: rankWord(l.rank) }) }) : out;
    }
    function hud(st) {
      var chips = st.hands.map(function (h, seat) { return { name: name(seat), text: st.out.indexOf(seat) >= 0 ? TX('oldmaid.safe') : String(h.length), turn: st.phase === 'play' && st.turn === seat }; });
      var out = { chips: chips, text: '' }, note = said(st), lead = function (text) { return note ? TX('cards.then', { first: note, then: text }) : text; };
      if (st.phase === 'over') { out.text = TX('shell.end.over'); out.label = TX('shell.menu.new'); out.action = newGame; return out; }
      if (!seats.person(st.turn)) { out.text = lead(TX('cards.thinking', { name: name(st.turn) })); return out; }
      if (st.turn !== seats.view()) { out.text = lead(TX('cards.turn.name', { name: name(st.turn) })); return out; }
      out.text = lead(TX('oldmaid.take', { from: name(source(st)) }));
      return out;
    }

    function drive() {
      var st = session.state;
      if (st.phase === 'over') { gameOver(); return; }
      if (!seats.person(st.turn)) session.later(aiTurn, AI_MS); else seats.ensure(st.turn, repaint);
    }
    function aiTurn() {
      var st = session.state;
      if (st.phase !== 'play' || seats.person(st.turn)) return;
      session.follow(take(st, st.turn, aiTake(st, st.turn)));
      drive();
    }
    function gameOver() {
      var st = session.state, r = st.result, hot = seats.hotseat();
      var line = TX(seats.isYou(r.loser) ? 'oldmaid.stuck.you' : 'oldmaid.stuck', { name: name(r.loser), card: Z.cardName(st.hands[r.loser][0]) });
      if (hot) session.lose({ name: name(r.order[0]) }, [line], undefined);
      else if (seats.isYou(r.loser)) session.lose('', [line], undefined); else session.win();
    }
    function takeAt(pile, idx) {
      var st = session.state, me = seats.view();
      if (st.phase !== 'play') return false;
      if (st.turn !== me) { t.flash(TX('cards.wait.turn')); return false; }
      var pos = parseInt(pile.slice(1), 10), seat = -1, r;
      for (r = 1; r < st.players; r++) if (T.SEAT_POS[st.players][r] === pos) seat = (me + r) % st.players;
      if (seat !== source(st)) { t.flash(TX('oldmaid.fromThem', { from: name(source(st)) })); return false; }
      session.commit(take(st, me, Math.max(0, Math.min(st.hands[seat].length - 1, idx))));
      drive();
      return true;
    }
    function tap(pile, idx) {
      if (/^p\d$/.test(pile)) return takeAt(pile, idx);
      if (pile.charAt(0) === 'h') { t.flash(TX('oldmaid.notYours')); return false; }
      return false;
    }
    function newGame() {
      players = Z.store.get(PLAYERS_KEY, DEFAULT_PLAYERS);
      if (players !== 2 && players !== 3 && players !== 4) players = DEFAULT_PLAYERS;
      buildSeats(players);
      view.flash = '';
      session.reset(deal(Z.shuffled(Math.random), players, Math.floor(Math.random() * players)));
      seats.begin(function () { repaint(); drive(); }, session.state.turn);
    }
    t = T.create({
      id: 'oldmaid', name: 'Old Maid', seats: seats, view: view, geo: geo, place: function (st, m, v) { syncView(st); return place(st, m, v); }, hud: hud, newGame: newGame, tap: tap,
      canPick: function () { return false; },
      stat: function (sec, st) { return Z.fmtTime(sec) + ' · ' + st.pairs[seats.view()]; },
      cascadeOrder: function (st) { return st.hands[seats.view()].map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return [TX('oldmaid.stuck', { name: name(st.result.loser), card: Z.cardName(st.hands[st.result.loser][0]) })]; },
      menuExtra: function () {
        return [T.choiceRow(TX('cards.seatsAtTable'), PLAYERS_KEY, [{ value: 2, label: '2' }, { value: 3, label: '3' }, { value: 4, label: '4' }], DEFAULT_PLAYERS, function () {}),
          Z.h('p', { class: 'zc-note', text: TX('ce.seatsNote') })];
      },
      rules: TX('oldmaid.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    newGame();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
