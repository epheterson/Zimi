/* ZimiGames: Eight Off. Eight columns of six cards and eight free cells, four of which start with a card in them. Build down in one
   suit, one card at a time; only a king fills an empty column. Four foundations build up by suit from the ace. Like FreeCell it
   is nearly always won with care. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, K = root.ZimiSolKit;

  var TABLEAU = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'], FOUNDATION = ['f0', 'f1', 'f2', 'f3'];
  var CELLS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
  var COLS = 8, COLUMN_CARDS = 6, START_CELLS = 4, FOUNDATION_COL = 2;

  var R = K.rules({
    tableau: TABLEAU, foundation: FOUNDATION, cells: CELLS,
    runOK: function (list) { return list.length === 1; },
    builds: function (upper, lower) { return Z.suit(upper) === Z.suit(lower) && Z.rank(lower) === Z.rank(upper) - 1; },
    emptyOK: function (id) { return Z.rank(id) === Z.KING; },
    whyBuild: 'sol.why.suit', whyEmpty: 'sol.why.king', whyPick: 'sol.why.single'
  });
  var blank = function () { return K.blankState(TABLEAU.concat(CELLS, FOUNDATION)); };

  // Four cards in the first four cells, then six to a column.
  function newState(order) {
    var s = blank(), k = 0, j;
    for (j = 0; j < START_CELLS; j++) s.piles[CELLS[j]].push(K.card(order[k++], true));
    TABLEAU.forEach(function (t) { for (j = 0; j < COLUMN_CARDS; j++) s.piles[t].push(K.card(order[k++], true)); });
    return s;
  }

  var place = K.layout({
    topRows: 2,
    items: FOUNDATION.map(function (f, n) { return { pile: f, kind: 'foundation', col: FOUNDATION_COL + n, row: 0 }; })
      .concat(CELLS.map(function (c, n) { return { pile: c, kind: 'cell', col: n, row: 1, n: n + 1 }; }))
      .concat(TABLEAU.map(function (t, n) { return { pile: t, kind: 'column', col: n, row: 2, n: n + 1 }; }))
  });

  var api = Object.assign(R, { newState: newState, blankState: blank, place: place, almostWon: function () { return K.almostWon(R, blank); } });
  root.ZimiEightOff = api;

  function boot() {
    K.page({ rules: R, id: 'eightoff', title: 'Eight Off', cols: COLS, place: place,
      deal: function () { return newState(Z.shuffled(Z.random())); }, almostWon: api.almostWon });
  }
  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
