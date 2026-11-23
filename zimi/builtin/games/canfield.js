/* ZimiGames: Canfield. A reserve of thirteen cards (the top one face up), four columns of one card each, one foundation card
   whose rank starts all four foundations, and a stock turned three at a time onto the waste, as often as you like.
   Foundations build up by suit from that rank, round from king to ace. Columns build down in alternating colors, also round
   from ace to king, and an in-order run moves as one. A gap in the columns fills itself from the reserve. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, K = root.ZimiSolKit;

  var TABLEAU = ['t0', 't1', 't2', 't3'], FOUNDATION = ['f0', 'f1', 'f2', 'f3'];
  var COLS = 7, RESERVE_CARDS = 13, DRAW_COUNT = 3, SHOWN_WASTE = 3, GRID_COL = 3;
  var RANKS = Z.KING;

  // One rank down, round: below the ace is the king.
  var below = function (rank) { return (rank + RANKS - 2) % RANKS + 1; };
  var above = function (rank) { return rank % RANKS + 1; };
  var builds = function (upper, lower) { return Z.isRed(upper) !== Z.isRed(lower) && Z.rank(lower) === below(Z.rank(upper)); };

  function drawStock(state) {
    var s = Z.clone(state), P = s.piles, n, c;
    if (P.stock.length) {
      for (n = Math.min(DRAW_COUNT, P.stock.length); n > 0; n--) { c = P.stock.pop(); c.up = true; P.waste.push(c); }
    } else if (P.waste.length) {
      P.stock = P.waste.reverse().map(function (k) { return K.card(k.id, false); });
      P.waste = [];
    } else return null;
    s.moves++;
    return s;
  }
  // A gap in the columns fills itself from the reserve.
  function settle(s) {
    TABLEAU.forEach(function (t) {
      if (!s.piles[t].length && s.piles.r.length) { var c = s.piles.r.pop(); c.up = true; s.piles[t].push(c); if (s.piles.r.length) s.piles.r[s.piles.r.length - 1].up = true; }
    });
  }

  var R = K.rules({
    tableau: TABLEAU, foundation: FOUNDATION, stock: 'stock', waste: 'waste', reserve: 'r',
    runOK: function (list) { for (var i = 1; i < list.length; i++) if (!builds(list[i - 1], list[i])) return false; return true; },
    builds: builds,
    fits: function (id, topId, n, state) {
      return n === 0 ? Z.rank(id) === state.base : Z.suit(id) === Z.suit(topId) && Z.rank(id) === above(Z.rank(topId));
    },
    whyBuild: 'sol.why.wrap', whyEmpty: 'sol.why.nowhere', whyFoundation: 'sol.why.foundationBase',
    draw: drawStock, settle: settle
  });
  var blank = function () { var s = K.blankState(['stock', 'waste', 'r'].concat(TABLEAU, FOUNDATION)); s.base = 1; return s; };

  // The reserve first, then the foundation card (it sets the rank), a card on each column, and the rest is the stock.
  function newState(order) {
    var s = blank(), k = 0, j;
    for (j = 0; j < RESERVE_CARDS; j++) s.piles.r.push(K.card(order[k++], j === RESERVE_CARDS - 1));
    s.piles.f0.push(K.card(order[k], true)); s.base = Z.rank(order[k++]);
    TABLEAU.forEach(function (t) { s.piles[t].push(K.card(order[k++], true)); });
    while (k < order.length) s.piles.stock.push(K.card(order[k++], false));
    return s;
  }

  var place = K.layout({
    topRows: 1,
    items: [{ pile: 'stock', kind: 'stock', col: 0, row: 0, mark: '↻' }, { pile: 'waste', kind: 'waste', col: 1, row: 0, shown: SHOWN_WASTE },
      { pile: 'r', kind: 'reserve', col: 0, row: 1 }]
      .concat(FOUNDATION.map(function (f, n) { return { pile: f, kind: 'foundation', col: GRID_COL + n, row: 0, mark: function (st) { return Z.RANK_LABELS[st.base - 1]; } }; }))
      .concat(TABLEAU.map(function (t, n) { return { pile: t, kind: 'column', col: GRID_COL + n, row: 1, n: n + 1 }; }))
  });

  // One card from a win: every foundation full from the ace but the last king, which waits on a column.
  function almostWon() { return K.almostWon(R, blank); }

  var api = Object.assign(R, { newState: newState, blankState: blank, place: place, drawStock: drawStock, almostWon: almostWon, below: below, above: above });
  root.ZimiCanfield = api;

  function boot() {
    K.page({ rules: R, id: 'canfield', title: 'Canfield', cols: COLS, place: place, refuse: 'sol.why.stockEmpty',
      deal: function () { return newState(Z.shuffled(Z.random())); }, almostWon: almostWon });
  }
  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
