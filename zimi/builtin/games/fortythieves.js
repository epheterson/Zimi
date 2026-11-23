/* ZimiGames: Forty Thieves. Two decks. Ten columns of four cards face up, and a stock of sixty-four. Build down in one suit,
   one card at a time, any card on an empty column. Eight foundations build up by suit from the ace. Turn the stock one card at
   a time onto the waste; there is one pass and no second. Put all 104 cards on the foundations to win. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, K = root.ZimiSolKit;

  var TABLEAU = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];
  var FOUNDATION = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'];
  var COLS = 10, DECKS = 2, COLUMN_CARDS = 4, FOUNDATION_COL = 2;

  var R = K.rules({
    tableau: TABLEAU, foundation: FOUNDATION, stock: 'stock', waste: 'waste',
    runOK: function (list) { return list.length === 1; },
    builds: function (upper, lower) { return Z.suit(upper) === Z.suit(lower) && Z.rank(lower) === Z.rank(upper) - 1; },
    takeFoundation: false,
    whyBuild: 'sol.why.suit', whyEmpty: 'sol.why.nowhere', whyPick: 'sol.why.single',
    draw: function (state) {
      var P = state.piles;
      if (!P.stock.length) return null;
      var s = Z.clone(state), c = s.piles.stock.pop();
      c.up = true; s.piles.waste.push(c); s.moves++;
      return s;
    }
  });
  var blank = function () { return K.blankState(['stock', 'waste'].concat(TABLEAU, FOUNDATION)); };

  function newState(order) {
    var s = blank(), k = 0;
    TABLEAU.forEach(function (t) { for (var j = 0; j < COLUMN_CARDS; j++) s.piles[t].push(K.card(order[k++], true)); });
    while (k < order.length) s.piles.stock.push(K.card(order[k++], false));
    return s;
  }

  var place = K.layout({
    topRows: 1,
    items: [{ pile: 'stock', kind: 'stock', col: 0, row: 0 }, { pile: 'waste', kind: 'waste', col: 1, row: 0 }]
      .concat(FOUNDATION.map(function (f, n) { return { pile: f, kind: 'foundation', col: FOUNDATION_COL + n, row: 0 }; }))
      .concat(TABLEAU.map(function (t, n) { return { pile: t, kind: 'column', col: n, row: 1, n: n + 1 }; }))
  });

  var api = Object.assign(R, { newState: newState, blankState: blank, place: place, drawStock: R.S.draw, almostWon: function () { return K.almostWon(R, blank); } });
  root.ZimiFortyThieves = api;

  function boot() {
    K.page({ rules: R, id: 'fortythieves', title: 'Forty Thieves', cols: COLS, place: place, refuse: 'sol.why.stockEmpty',
      deal: function () { return newState(K.shuffledDecks(DECKS, Z.random())); }, almostWon: api.almostWon });
  }
  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
