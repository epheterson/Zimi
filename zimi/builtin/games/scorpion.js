/* ZimiGames: Scorpion. Seven columns of seven cards, the first three of the first four columns face down, and three cards left
   over. Build down in one suit, and move any face-up card with every card on it, in order or not. Only a king fills an empty
   column. The three left over go one each onto the first three columns, whenever you like. A column that ends in king down to
   ace of one suit leaves the table; clear all four suits to win. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, K = root.ZimiSolKit;

  var TABLEAU = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'], DONE = ['d0', 'd1', 'd2', 'd3'];
  var COLS = 7, COLUMN_CARDS = 7, DOWN_COLUMNS = 4, DOWN_CARDS = 3, SPARE_CARDS = 3, DONE_COL = 3;
  var SUIT_COUNT = 4;

  var sameSuitDown = function (upper, lower) { return Z.suit(upper) === Z.suit(lower) && Z.rank(lower) === Z.rank(upper) - 1; };

  // A column that ends in a whole suit, king to ace, goes to a pile of its own.
  function sweep(s) {
    TABLEAU.forEach(function (t) {
      var p = s.piles[t], n = p.length, i;
      if (n < Z.KING || Z.rank(p[n - Z.KING].id) !== Z.KING) return;
      for (i = n - Z.KING; i < n; i++) if (!p[i].up || (i > n - Z.KING && !sameSuitDown(p[i - 1].id, p[i].id))) return;
      var run = p.splice(n - Z.KING), d = DONE.filter(function (x) { return !s.piles[x].length; })[0];
      s.piles[d] = run;
      if (p.length && !p[p.length - 1].up) p[p.length - 1].up = true;
    });
  }
  // The spare cards go face up, one on each of the first three columns.
  function dealSpare(state) {
    if (state.piles.stock.length < SPARE_CARDS) return null;
    var s = Z.clone(state);
    for (var i = 0; i < SPARE_CARDS; i++) { var c = s.piles.stock.pop(); c.up = true; s.piles[TABLEAU[i]].push(c); }
    s.moves++;
    sweep(s);
    return s;
  }

  var R = K.rules({
    tableau: TABLEAU, foundation: [], stock: 'stock',
    runOK: function () { return true; },
    builds: sameSuitDown,
    emptyOK: function (id) { return Z.rank(id) === Z.KING; },
    isWon: function (state) { return DONE.every(function (d) { return state.piles[d].length === Z.KING; }); },
    whyBuild: 'sol.why.suit', whyEmpty: 'sol.why.king',
    draw: dealSpare, settle: sweep
  });
  var blank = function () { return K.blankState(['stock'].concat(TABLEAU, DONE)); };

  function newState(order) {
    var s = blank(), k = 0;
    TABLEAU.forEach(function (t, n) {
      for (var j = 0; j < COLUMN_CARDS; j++) s.piles[t].push(K.card(order[k++], !(n < DOWN_COLUMNS && j < DOWN_CARDS)));
    });
    while (k < order.length) s.piles.stock.push(K.card(order[k++], false));
    return s;
  }

  var place = K.layout({
    topRows: 1,
    items: [{ pile: 'stock', kind: 'stock', col: 0, row: 0 }]
      .concat(DONE.map(function (d, n) { return { pile: d, kind: 'foundation', col: DONE_COL + n, row: 0, mark: 'K' }; }))
      .concat(TABLEAU.map(function (t, n) { return { pile: t, kind: 'column', col: n, row: 1, n: n + 1 }; }))
  });

  // One move from a win: three suits taken, the fourth's king to deuce in one column and the ace alone on another.
  function almostWon() {
    var s = blank(), suit, r;
    for (suit = 0; suit < SUIT_COUNT - 1; suit++) for (r = Z.KING; r >= 1; r--) s.piles[DONE[suit]].push(K.card(Z.make(r, suit), true));
    for (r = Z.KING; r >= 2; r--) s.piles.t0.push(K.card(Z.make(r, SUIT_COUNT - 1), true));
    s.piles.t1.push(K.card(Z.make(1, SUIT_COUNT - 1), true));
    return s;
  }

  function cascade(st) {
    var order = [], r;
    for (r = 0; r < Z.KING; r++) DONE.forEach(function (d) { if (st.piles[d][r]) order.push({ id: st.piles[d][r].id }); });
    return order;
  }

  var api = Object.assign(R, { newState: newState, blankState: blank, place: place, drawStock: dealSpare, sweep: sweep, almostWon: almostWon, DONE: DONE });
  root.ZimiScorpion = api;

  function boot() {
    K.page({ rules: R, id: 'scorpion', title: 'Scorpion', cols: COLS, place: place, refuse: 'sol.why.noSpare', cascade: cascade,
      deal: function () { return newState(Z.shuffled(Z.random())); }, almostWon: almostWon });
  }
  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
