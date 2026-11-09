/* ZimiGames: Beleaguered Castle. The four aces start the foundations. The other 48 cards lie face up in eight columns of six.
   Build down on any card, whatever its suit, one card at a time, and any card may fill an empty column. Foundations build up by
   suit. Every card is in sight, so the whole game is thinking ahead. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, K = root.ZimiSolKit;

  var TABLEAU = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'], FOUNDATION = ['f0', 'f1', 'f2', 'f3'];
  var COLS = 8, COLUMN_CARDS = 6, FOUNDATION_COL = 2;

  var R = K.rules({
    tableau: TABLEAU, foundation: FOUNDATION,
    runOK: function (list) { return list.length === 1; },
    builds: function (upper, lower) { return Z.rank(lower) === Z.rank(upper) - 1; },
    whyBuild: 'sol.why.down', whyEmpty: 'sol.why.nowhere', whyPick: 'sol.why.single'
  });
  var blank = function () { return K.blankState(TABLEAU.concat(FOUNDATION)); };

  // The aces go to the foundations; the rest are dealt six to a column, in order.
  function newState(order) {
    var s = blank(), k = 0, aces = order.filter(function (id) { return Z.rank(id) === 1; }), rest = order.filter(function (id) { return Z.rank(id) !== 1; });
    aces.forEach(function (id, n) { s.piles[FOUNDATION[n]].push(K.card(id, true)); });
    TABLEAU.forEach(function (t) { for (var j = 0; j < COLUMN_CARDS; j++) s.piles[t].push(K.card(rest[k++], true)); });
    return s;
  }

  var place = K.layout({
    topRows: 1,
    items: FOUNDATION.map(function (f, n) { return { pile: f, kind: 'foundation', col: FOUNDATION_COL + n, row: 0 }; })
      .concat(TABLEAU.map(function (t, n) { return { pile: t, kind: 'column', col: n, row: 1, n: n + 1 }; }))
  });

  var api = Object.assign(R, { newState: newState, blankState: blank, place: place, almostWon: function () { return K.almostWon(R, blank); } });
  root.ZimiBeleaguered = api;

  function boot() {
    K.page({ rules: R, id: 'beleaguered', title: 'Beleaguered Castle', cols: COLS, place: place,
      deal: function () { return newState(Z.shuffled(Z.random())); }, almostWon: api.almostWon });
  }
  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
