/* ZimiGames: Golf. Seven columns of five, all face up. Play the bottom
   card of a column onto the waste when it is one rank higher or lower; kings
   and aces do not wrap. The stock turns one card at a time onto the waste.
   Like the game it is named for, the score is what is left: fewer cards in
   the columns is better, and a clear is a win.

   State: piles { stock, waste, c0..c6 }, each a list of card ids (the last
   is the top), plus moves. Rules are pure functions; the page wiring at the
   bottom only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, TX = root.ZimiCards.T;

  var COLUMNS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  var COLS = 7, DEPTH = 5, TABLEAU_CARDS = COLS * DEPTH;
  var top = function (pile) { return pile[pile.length - 1]; };

  // ── Rules ───────────────────────────────────────────────────────────────
  function newState(order) {
    var piles = { stock: [], waste: [] }, k = 0;
    COLUMNS.forEach(function (c) { piles[c] = order.slice(k, k + DEPTH); k += DEPTH; });
    piles.stock = order.slice(k);
    piles.waste.push(piles.stock.pop());
    return { piles: piles, moves: 0 };
  }

  // One rank up or down from the waste's top card. No wrap: a king never goes
  // on an ace, nor the ace on a king.
  function fits(id, wasteTop) { return wasteTop !== undefined && Math.abs(Z.rank(id) - Z.rank(wasteTop)) === 1; }

  function canPick(state, pile, idx) {
    var p = state.piles[pile];
    return pile.charAt(0) === 'c' && idx === p.length - 1 && idx >= 0;
  }
  function legalMove(state, from, idx, to) {
    return to === 'waste' && canPick(state, from, idx) && fits(state.piles[from][idx], top(state.piles.waste));
  }
  function applyMove(state, from, idx, to) {
    var s = Z.clone(state);
    s.piles[to].push(s.piles[from].pop());
    s.moves++;
    return s;
  }
  function drawStock(state) {
    if (!state.piles.stock.length) return null;
    var s = Z.clone(state);
    s.piles.waste.push(s.piles.stock.pop());
    s.moves++;
    return s;
  }
  function bestMove(state, from, idx) { return legalMove(state, from, idx, 'waste') ? 'waste' : null; }

  function left(state) { return COLUMNS.reduce(function (n, c) { return n + state.piles[c].length; }, 0); }
  function isWon(state) { return left(state) === 0; }
  function playable(state) { return COLUMNS.some(function (c) { return state.piles[c].length && fits(top(state.piles[c]), top(state.piles.waste)); }); }
  // Nothing on the stock and nothing the waste will take: the round is over.
  function isStuck(state) { return !isWon(state) && !state.piles.stock.length && !playable(state); }

  // For the debug hook: one card left, and it fits.
  function almostWon() {
    var s = newState(Z.shuffled(function () { return 0.3; }));
    COLUMNS.forEach(function (c) { s.piles[c] = []; });
    s.piles.stock = [];
    s.piles.waste = [Z.make(6, 0)];
    s.piles.c3 = [Z.make(7, 1)];
    return s;
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var UP_STEP_SHARE = 0.3, MIN_STEP_SHARE = 0.16, HEIGHT_SHARE = 0.19;

  function place(state, m) {
    var P = state.piles, cw = m.cw, ch = m.ch, x = function (col) { return m.left + col * m.step; };
    // Stock and waste are one row right under the bar; the columns start under it and fan as far as the room allows.
    var rows = Z.solitaireRows(m), y2 = rows.top, y1 = rows.cols;
    var step = Z.fanStep(DEPTH - 1, rows.room, ch, ch * UP_STEP_SHARE, ch * MIN_STEP_SHARE);
    var slots = [], cards = [], height = Math.max(m.H, y1 + (DEPTH - 1) * step + ch + m.pad);

    COLUMNS.forEach(function (c, n) {
      P[c].forEach(function (id, i) { cards.push({ id: id, pile: c, idx: i, x: x(n), y: y1 + i * step, up: true }); });
    });
    P.stock.forEach(function (id, i) { cards.push({ id: id, pile: 'stock', idx: i, x: x(0), y: y2, up: false, hidden: i < P.stock.length - 2 }); });
    P.waste.forEach(function (id, i) { cards.push({ id: id, pile: 'waste', idx: i, x: x(1), y: y2, up: true, hidden: i < P.waste.length - 2 }); });

    COLUMNS.forEach(function (c, n) {
      slots.push({ id: c, x: x(n), y: y1, w: cw, h: Math.max(ch, DEPTH * step), label: Z.describePile(TX('fc.column', { n: n + 1 }), P[c], true) });
    });
    slots.push({ id: 'stock', x: x(0), y: y2, w: cw, h: ch, mark: P.stock.length ? '' : '∅', label: Z.describePile(TX('sol.stock'), P.stock, false) + (P.stock.length ? TX('pyr.enterTurn') : '') });
    slots.push({ id: 'waste', x: x(1), y: y2, w: cw, h: ch, goal: true, label: Z.describePile(TX('sol.waste'), P.waste, true) });
    return { height: height, slots: slots, cards: cards };
  }

  var api = {
    COLUMNS: COLUMNS, TABLEAU_CARDS: TABLEAU_CARDS,
    newState: newState, fits: fits, canPick: canPick, legalMove: legalMove, applyMove: applyMove, drawStock: drawStock,
    bestMove: bestMove, left: left, isWon: isWon, isStuck: isStuck, almostWon: almostWon, place: place
  };
  root.ZimiGolf = api;

  // ── The page ────────────────────────────────────────────────────────────
  function boot() {
    var page;
    page = Z.solitairePage({
      why: function (st, pile, idx) { return TX(canPick(st, pile, idx) ? 'sol.why.neighbor' : 'golf.why.buried'); },
      refuse: function () { page.note(TX('sol.why.stockEmpty')); },
      rules: api, id: 'golf', lowScore: true, fact: true, place: place, cols: COLS, heightShare: HEIGHT_SHARE, enterTaps: true, stock: drawStock,
      deal: function () { return newState(Z.shuffled(Math.random)); },
      score: function () { return 0; },
      stuck: {
        is: isStuck, score: left,
        title: function () { return TX('cards.noMoves'); }, note: function (st) { return TX('golf.left', { n: left(st) }); }
      },
      statText: function (sec, st) { page.el.sub.textContent = isStuck(st) ? TX('cards.noMoves') : ''; return Z.fmtTime(sec) + ' · ' + TX('golf.leftShort', { n: left(st) }); },
      cascadeOrder: function (st) { return st.piles.waste.slice().reverse().map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return [TX('golf.win', { time: Z.fmtTime(sec), moves: Z.plural(st.moves, 'move'), stock: st.piles.stock.length })]; },
      openMenu: function () { page.menu('Golf', [Z.h('p', { class: 'zc-note', text: TX('golf.rules') })]); }
    });
    page.start();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
