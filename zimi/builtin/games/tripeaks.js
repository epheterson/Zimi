/* ZimiGames: TriPeaks. Three peaks of cards, 28 in all. Play a free card
   onto the waste when it is one rank above or below the waste's top card;
   kings and aces wrap round. A card is free when the two cards that overlap
   it are gone, and it turns face up when it becomes free. Each card played
   in a row (a streak) is worth more than the last; turning the stock breaks
   the streak.

   State: piles { 'k<row>_<i>' (0 or 1 card each), stock, waste }, plus the
   streak, score, moves. Whether a tableau card is face up is not stored: it
   is up exactly when it is free. Rules are pure functions; the page wiring at
   the bottom only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, TX = root.ZimiCards.T;

  var SCORE = { perStreak: 5, peak: 30, stockLeft: 10 };
  var TABLEAU_CARDS = 28;
  // Each row's cards by horizontal position, in card widths from the left of
  // the bottom row. A card is overlapped by the row below's cards half a card
  // to either side of it.
  var ROW_X = [[1.5, 4.5, 7.5], [1, 2, 4, 5, 7, 8], [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]];
  var BOARD_WIDTH_CARDS = 10;
  var top = function (pile) { return pile[pile.length - 1]; };
  var pid = function (r, i) { return 'k' + r + '_' + i; };
  var rowOf = function (p) { return parseInt(p.slice(1), 10); };
  var idxOf = function (p) { return parseInt(p.split('_')[1], 10); };
  var TABLEAU = [];
  ROW_X.forEach(function (xs, r) { xs.forEach(function (x, i) { TABLEAU.push(pid(r, i)); }); });
  var isTableau = function (p) { return p.charAt(0) === 'k'; };

  // The piles that overlap a tableau card (none for the bottom row).
  var COVERS = {};
  TABLEAU.forEach(function (p) {
    var r = rowOf(p), x = ROW_X[r][idxOf(p)], out = [];
    if (r < 3) ROW_X[r + 1].forEach(function (cx, i) { if (Math.abs(cx - x) === 0.5) out.push(pid(r + 1, i)); });
    COVERS[p] = out;
  });
  var PEAK_TOPS = ['k0_0', 'k0_1', 'k0_2'];

  // ── Rules ───────────────────────────────────────────────────────────────
  function newState(order) {
    var piles = { stock: [], waste: [] }, k = 0;
    TABLEAU.forEach(function (p) { piles[p] = [order[k++]]; });
    piles.stock = order.slice(k);
    piles.waste.push(piles.stock.pop());
    return { piles: piles, streak: 0, score: 0, moves: 0 };
  }

  function isFree(state, pile) {
    var P = state.piles;
    return isTableau(pile) && P[pile].length > 0 && COVERS[pile].every(function (c) { return !P[c].length; });
  }
  // One rank up or down; a king and an ace are neighbours both ways.
  function fits(id, wasteTop) {
    if (wasteTop === undefined) return false;
    var d = Math.abs(Z.rank(id) - Z.rank(wasteTop));
    return d === 1 || d === Z.KING - 1;
  }
  function canPick(state, pile) { return isFree(state, pile); }
  function legalMove(state, from, idx, to) {
    return to === 'waste' && isFree(state, from) && fits(top(state.piles[from]), top(state.piles.waste));
  }
  function tableauLeft(state) { return TABLEAU.filter(function (p) { return state.piles[p].length; }).length; }
  function isWon(state) { return tableauLeft(state) === 0; }

  function applyMove(state, from, idx, to) {
    var s = Z.clone(state);
    s.piles.waste.push(s.piles[from].pop());
    s.streak++; s.moves++;
    s.score += SCORE.perStreak * s.streak;
    if (PEAK_TOPS.indexOf(from) >= 0) s.score += SCORE.peak;
    if (isWon(s)) s.score += SCORE.stockLeft * s.piles.stock.length;
    return s;
  }
  function drawStock(state) {
    if (!state.piles.stock.length) return null;
    var s = Z.clone(state);
    s.piles.waste.push(s.piles.stock.pop());
    s.streak = 0; s.moves++;
    return s;
  }
  function bestMove(state, from, idx) { return legalMove(state, from, idx, 'waste') ? 'waste' : null; }
  function peaksCleared(state) { return PEAK_TOPS.filter(function (p) { return !state.piles[p].length; }).length; }
  function isStuck(state) {
    return !isWon(state) && !state.piles.stock.length && !TABLEAU.some(function (p) { return legalMove(state, p, 0, 'waste'); });
  }

  // For the debug hook: one card left, and it fits.
  function almostWon() {
    var s = newState(Z.shuffled(function () { return 0.3; }));
    TABLEAU.forEach(function (p) { s.piles[p] = []; });
    s.piles.stock = [Z.make(2, 1), Z.make(9, 2)];
    s.piles.waste = [Z.make(Z.KING, 0)];
    s.piles.k3_4 = [Z.make(1, 3)];
    s.streak = 12;
    return s;
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var ROW_STEP_SHARE = 0.56, ROW_STEP_MAX = 0.85, HEIGHT_SHARE = 0.17, FIT_COLS = 7.6;

  function place(state, m) {
    var P = state.piles, cw = m.cw, ch = m.ch;
    var unit = (m.W - 2 * m.pad - cw) / (BOARD_WIDTH_CARDS - 1), x0 = Math.floor((m.W - (unit * (BOARD_WIDTH_CARDS - 1) + cw)) / 2);
    // Stock and waste are one row right under the bar; the peaks under it, their rows stepping down to fill the height:
    // the more of a covered card shows, the easier the peaks read.
    var rows = Z.solitaireRows(m), y2 = rows.top, y1 = rows.cols, slots = [], cards = [];
    var rowStep = Math.max(ch * ROW_STEP_SHARE, Math.min(ch * ROW_STEP_MAX, (rows.room - ch) / 3));
    var height = Math.max(m.H, y1 + rowStep * 3 + ch + m.pad);
    var sx = m.left, wx = m.left + m.step;   // the pile's row is left-aligned: the fact pill sits over its middle

    TABLEAU.forEach(function (p) {
      if (!P[p].length) return;
      var r = rowOf(p), i = idxOf(p), px = x0 + ROW_X[r][i] * unit, py = y1 + r * rowStep, free = isFree(state, p);
      cards.push({ id: P[p][0], pile: p, idx: 0, x: px, y: py, up: free });
      slots.push({ id: p, x: px, y: py, w: cw, h: ch, label: free ? TX('tri.row', { row: r + 1, card: Z.cardName(P[p][0]) }) : TX('tri.rowDown', { row: r + 1 }) });
    });
    P.stock.forEach(function (id, i) { cards.push({ id: id, pile: 'stock', idx: i, x: sx, y: y2, up: false, hidden: i < P.stock.length - 2 }); });
    P.waste.forEach(function (id, i) { cards.push({ id: id, pile: 'waste', idx: i, x: wx, y: y2, up: true, hidden: i < P.waste.length - 2 }); });
    slots.push({ id: 'stock', x: sx, y: y2, w: cw, h: ch, mark: P.stock.length ? '' : '∅', label: Z.describePile(TX('sol.stock'), P.stock, false) + (P.stock.length ? TX('pyr.enterTurn') : '') });
    slots.push({ id: 'waste', x: wx, y: y2, w: cw, h: ch, goal: true, label: Z.describePile(TX('sol.waste'), P.waste, true) });
    return { height: height, slots: slots, cards: cards };
  }

  var api = {
    TABLEAU: TABLEAU, COVERS: COVERS, ROW_X: ROW_X, PEAK_TOPS: PEAK_TOPS, SCORE: SCORE, TABLEAU_CARDS: TABLEAU_CARDS,
    newState: newState, isFree: isFree, fits: fits, canPick: canPick, legalMove: legalMove, applyMove: applyMove, drawStock: drawStock,
    bestMove: bestMove, tableauLeft: tableauLeft, peaksCleared: peaksCleared, isWon: isWon, isStuck: isStuck, almostWon: almostWon, place: place
  };
  root.ZimiTriPeaks = api;

  // ── The page ────────────────────────────────────────────────────────────
  function boot() {
    var page;
    page = Z.solitairePage({
      why: function (st, pile) { return TX(isFree(st, pile) ? 'sol.why.neighbor' : 'tri.why.covered'); },
      refuse: function () { page.note(TX('sol.why.stockEmpty')); },
      rules: api, id: 'tripeaks', fact: true, place: place, cols: FIT_COLS, heightShare: HEIGHT_SHARE, enterTaps: true, stock: drawStock,
      deal: function () { return newState(Z.shuffled(Math.random)); },
      score: function (st) { return st.score; },
      stuck: {
        is: isStuck, score: function (st) { return st.score; },
        title: function () { return TX('cards.noMoves'); }, note: function (st) { return TX('tri.left', { n: tableauLeft(st), score: st.score }); }
      },
      statText: function (sec, st) {
        page.el.sub.textContent = isStuck(st) ? TX('cards.noMoves') : st.streak > 1 ? TX('tri.streak', { n: st.streak }) : '';
        return Z.fmtTime(sec) + ' · ' + st.score;
      },
      cascadeOrder: function (st) { return st.piles.waste.slice().reverse().map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return [TX('tri.win', { score: st.score, stock: Z.plural(st.piles.stock.length, 'card'), each: SCORE.stockLeft }), Z.winTime(sec, st)]; },
      openMenu: function () { page.menu('TriPeaks', [Z.h('p', { class: 'zc-note', text: TX('tri.rules', { per: SCORE.perStreak, peak: SCORE.peak }) })]); }
    });
    page.start();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
