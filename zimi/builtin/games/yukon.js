/* ZimiGames: Yukon. Seven columns: the first has one card, each next one a face-down card more, and five face up on every
   column but the first. Build down in alternating colors, and move any face-up card with all the cards on it, in order or not.
   Only a king fills an empty column. Four foundations build up by suit from the ace. No stock: every card is on the table.
   The rules are the small facts below; ZimiSolKit writes the moves, the layout and the page. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, K = root.ZimiSolKit;

  var TABLEAU = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'], FOUNDATION = ['f0', 'f1', 'f2', 'f3'];
  var COLS = 7, UP_DEALT = 5, FOUNDATION_COL = 3;

  var R = K.rules({
    tableau: TABLEAU, foundation: FOUNDATION,
    runOK: function () { return true; },
    builds: Z.stacksOn,
    emptyOK: function (id) { return Z.rank(id) === Z.KING; },
    whyBuild: 'sol.why.build', whyEmpty: 'sol.why.king'
  });
  var blank = function () { return K.blankState(TABLEAU.concat(FOUNDATION)); };

  // Column n gets n cards face down, then five face up (the first column just one).
  function newState(order) {
    var s = blank(), k = 0;
    TABLEAU.forEach(function (t, n) {
      var j;
      for (j = 0; j < n; j++) s.piles[t].push(K.card(order[k++], false));
      for (j = 0; j < (n ? UP_DEALT : 1); j++) s.piles[t].push(K.card(order[k++], true));
    });
    return s;
  }

  var place = K.layout({
    topRows: 1,
    items: FOUNDATION.map(function (f, n) { return { pile: f, kind: 'foundation', col: FOUNDATION_COL + n, row: 0 }; })
      .concat(TABLEAU.map(function (t, n) { return { pile: t, kind: 'column', col: n, row: 1, n: n + 1 }; }))
  });

  var api = Object.assign(R, { newState: newState, blankState: blank, place: place, almostWon: function () { return K.almostWon(R, blank); } });
  root.ZimiYukon = api;

  function boot() {
    K.page({ rules: R, id: 'yukon', title: 'Yukon', cols: COLS, place: place, auto: true, deal: function () { return newState(Z.shuffled(Z.random())); }, almostWon: api.almostWon });
  }
  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
