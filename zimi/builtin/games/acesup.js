/* ZimiGames: Aces Up. Four columns, one card dealt on each. A card on top of a column goes out when the top of another column
   is a higher card of its suit, aces highest. A column that is empty takes any top card. When nothing more can go, deal four
   more. Win with only the four aces left on the table. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, K = root.ZimiSolKit;

  var TABLEAU = ['t0', 't1', 't2', 't3'];
  var COLS = 4, DEAL_CARDS = 4, OUT_COL = 3, ACE_HIGH = Z.KING + 1;
  var DECK = Z.DECK;

  var high = function (id) { return Z.rank(id) === 1 ? ACE_HIGH : Z.rank(id); };
  var tops = function (state) { return TABLEAU.map(function (t) { var p = state.piles[t]; return p.length ? p[p.length - 1].id : null; }); };
  // The card goes out when another column shows a higher card of its suit.
  function removable(state, id) {
    return tops(state).some(function (o) { return o !== null && o !== id && Z.suit(o) === Z.suit(id) && high(o) > high(id); });
  }

  function dealRow(state) {
    if (state.piles.stock.length < DEAL_CARDS) return null;
    var s = Z.clone(state);
    TABLEAU.forEach(function (t) { var c = s.piles.stock.pop(); c.up = true; s.piles[t].push(c); });
    s.moves++;
    return s;
  }

  var R = K.rules({
    tableau: TABLEAU, foundation: ['out'], stock: 'stock',
    runOK: function (list) { return list.length === 1; },
    builds: function () { return false; },
    takeFoundation: false,
    fits: function (id, topId, n, state) { return removable(state, id); },
    isWon: function (state) { return state.piles.out.length === DECK - TABLEAU.length; },
    whyFoundation: 'acesup.why.out', whyBuild: 'acesup.why.out', whyEmpty: 'acesup.why.out', whyPick: 'acesup.why.top',
    draw: dealRow
  });
  var blank = function () { return K.blankState(['stock', 'out'].concat(TABLEAU)); };

  function newState(order) {
    var s = blank(), dealt;
    order.forEach(function (id) { s.piles.stock.push(K.card(id, false)); });
    dealt = dealRow(s);
    dealt.moves = 0;
    return dealt;
  }

  var place = K.layout({
    topRows: 1,
    items: [{ pile: 'stock', kind: 'stock', col: 0, row: 0 }, { pile: 'out', kind: 'foundation', col: OUT_COL, row: 0, mark: '', label: 'acesup.out' }]
      .concat(TABLEAU.map(function (t, n) { return { pile: t, kind: 'column', col: n, row: 1, n: n + 1 }; }))
  });

  // One move from a win: the deuce of spades beside the ace of spades, every other card but the four aces already out.
  function almostWon() {
    var s = blank(), id, left = [Z.make(1, 0), Z.make(1, 1), Z.make(1, 2), Z.make(1, 3), Z.make(2, 3)];
    for (id = 0; id < DECK; id++) if (left.indexOf(id) < 0) s.piles.out.push(K.card(id, true));
    s.piles.t0.push(K.card(left[0], true));
    s.piles.t1.push(K.card(left[1], true));
    s.piles.t2.push(K.card(left[2], true), K.card(left[3], true));
    s.piles.t3.push(K.card(left[4], true));
    return s;
  }

  function cascade(st) { return st.piles.out.slice(-Z.KING).map(function (c) { return { id: c.id }; }); }

  var api = Object.assign(R, { newState: newState, blankState: blank, place: place, drawStock: dealRow, almostWon: almostWon, removable: removable, high: high });
  root.ZimiAcesUp = api;

  function boot() {
    K.page({ rules: R, id: 'acesup', title: 'Aces Up', cols: COLS, place: place, refuse: 'sol.why.stockEmpty', cascade: cascade,
      deal: function () { return newState(Z.shuffled(Z.random())); }, almostWon: almostWon });
  }
  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
