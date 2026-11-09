/* ZimiGames: Accordion. All 52 cards lie in a row, face up. A pile may be moved onto the pile next to it on the left, or the
   one three places to the left, when their top cards match in suit or in rank. The gap closes up. Finish with one pile of 52.
   State: piles a0..a51 (a pile's cards, the last is the top; an emptied pile stays empty), moves. The row is the piles that
   still hold cards, in order, so a move is judged by place in the row, not by name. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, K = root.ZimiSolKit, TX = root.ZimiCards.T;

  var COLS = 8, PILES = Z.DECK, JUMP_NEAR = 1, JUMP_FAR = 3, STACK_SHOWN = 3, STACK_NUDGE = 2, ROW_GAP_SHARE = 0.08;
  var NAMES = [];
  for (var i = 0; i < PILES; i++) NAMES.push('a' + i);

  var top = K.top;
  var topId = function (state, name) { var p = state.piles[name]; return top(p).id; };
  // The piles that still hold cards, in order along the row.
  function row(state) { return NAMES.filter(function (n) { return state.piles[n].length; }); }
  var matches = function (a, b) { return Z.suit(a) === Z.suit(b) || Z.rank(a) === Z.rank(b); };

  // The piles a pile may move onto: the near and the far neighbor on its left, where the tops match.
  function targets(state, name) {
    var r = row(state), at = r.indexOf(name), out = [];
    if (at < 0) return out;
    [JUMP_NEAR, JUMP_FAR].forEach(function (back) {
      if (at - back >= 0 && matches(topId(state, name), topId(state, r[at - back]))) out.push(r[at - back]);
    });
    return out;
  }

  function canPick(state, pile, idx) { var p = state.piles[pile]; return !!p && idx === p.length - 1 && p.length > 0; }
  function legalMove(state, from, idx, to) { return from !== to && canPick(state, from, idx) && targets(state, from).indexOf(to) >= 0; }
  function applyMove(state, from, idx, to) {
    var s = Z.clone(state);
    s.piles[to] = s.piles[to].concat(s.piles[from]);
    s.piles[from] = [];
    s.moves++;
    return s;
  }
  // A tap moves a card that has one place to go; with two it asks to be dragged to the one wanted.
  function bestMove(state, from, idx) {
    if (!canPick(state, from, idx)) return null;
    var t = targets(state, from);
    return t.length === 1 ? t[0] : null;
  }
  function hasMove(state) { return row(state).some(function (n) { return targets(state, n).length > 0; }); }
  function isWon(state) { return row(state).length === 1; }
  function why(state, pile, idx, to) {
    if (!canPick(state, pile, idx)) return null;
    var t = targets(state, pile);
    if (to === undefined && t.length > 1) return TX('accordion.why.choose');
    return TX('accordion.why.match');
  }

  function blankState() { return K.blankState(NAMES); }
  function newState(order) {
    var s = blankState();
    order.forEach(function (id, n) { s.piles[NAMES[n]].push(K.card(id, true)); });
    return s;
  }

  // The row laid out in lines of COLS; a pile's cards are stacked with a nudge so its depth shows.
  function place(state, m) {
    var P = state.piles, rows = Z.solitaireRows(m), r = row(state), cards = [], slots = [], lineH = Math.round(m.ch * (1 + ROW_GAP_SHARE));
    var last = 0;
    r.forEach(function (name, n) {
      var px = m.left + (n % COLS) * m.step, py = rows.top + Math.floor(n / COLS) * lineH, p = P[name];
      p.forEach(function (c, k) {
        var seen = k - (p.length - STACK_SHOWN), nudge = seen > 0 ? seen * STACK_NUDGE : 0;
        cards.push({ id: c.id, pile: name, idx: k, x: px + nudge, y: py + nudge, up: true, hidden: seen < 0 });
      });
      slots.push({ id: name, x: px, y: py, w: m.cw, h: m.ch, label: Z.describePile(TX('accordion.pile', { n: n + 1 }), Z.idsOf(p), true) });
      last = py + m.ch;
    });
    return { height: Math.max(last + m.pad, m.H), slots: slots, cards: cards };
  }

  function cascade(st) {
    var name = row(st)[0];
    return st.piles[name].slice(-Z.KING).reverse().map(function (c) { return { id: c.id }; });
  }
  // One move from a win: the ace of diamonds in a pile beside a pile of the other 51 cards that ends in the king of diamonds.
  function almostWon() {
    var s = blankState(), last = Z.make(Z.KING, 1), single = Z.make(1, 1), id;
    for (id = 0; id < PILES; id++) if (id !== last && id !== single) s.piles.a0.push(K.card(id, true));
    s.piles.a0.push(K.card(last, true));
    s.piles.a1.push(K.card(single, true));
    return s;
  }

  var api = { NAMES: NAMES, row: row, targets: targets, newState: newState, blankState: blankState, canPick: canPick, legalMove: legalMove, applyMove: applyMove,
    bestMove: bestMove, hasMove: hasMove, isWon: isWon, why: why, place: place, almostWon: almostWon, S: { foundation: [] } };
  root.ZimiAccordion = api;

  function boot() {
    K.page({ rules: api, id: 'accordion', title: 'Accordion', cols: COLS, place: place, cascade: cascade,
      deal: function () { return newState(Z.shuffled(Z.random())); }, almostWon: almostWon });
  }
  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
