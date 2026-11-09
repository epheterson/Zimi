/* ZimiGames: Calculation. An ace, a deuce, a three and a four start four foundations; the first counts 1, 2, 3, the second 2, 4,
   6, the third 3, 6, 9, the fourth 4, 8, 12, each round the ranks from king to ace, and each ends on a king. The deck shows one card at a
   time: it goes to a foundation if it fits, else onto one of four waste piles, where only the top card plays. Whatever the suit. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, K = root.ZimiSolKit;

  var WASTE = ['w0', 'w1', 'w2', 'w3'], FOUNDATION = ['f0', 'f1', 'f2', 'f3'];
  var COLS = 5, DECK_COL = 4, RANKS = Z.KING;
  // The cards that start the foundations, in order: ace of spades, two of hearts, three of clubs, four of diamonds.
  var SEEDS = [Z.make(1, 3), Z.make(2, 2), Z.make(3, 0), Z.make(4, 1)];

  // The rank a foundation wants after this one: its step further, round from king to ace.
  var nextRank = function (rank, step) { return (rank + step - 1) % RANKS + 1; };
  var stepOf = function (pile) { return FOUNDATION.indexOf(pile) + 1; };
  var needs = function (state, pile) { var p = state.piles[pile]; return nextRank(Z.rank(p[p.length - 1].id), stepOf(pile)); };

  var R = K.rules({
    tableau: WASTE, foundation: FOUNDATION, waste: 'deck',
    runOK: function (list) { return list.length === 1; },
    builds: function () { return true; },
    canDrop: function (state, from, to) { return FOUNDATION.indexOf(to) >= 0 || from === 'deck'; },
    takeFoundation: false,
    fits: function (id, topId, n, state, to) { return Z.rank(id) === needs(state, to); },
    whyFoundation: function (state, to) { return Z.T('calc.why', { rank: Z.T('cards.rank.' + needs(state, to)) }); },
    whyBuild: 'calc.why.deck', whyEmpty: 'calc.why.deck', whyPick: 'calc.why.top'
  });
  var blank = function () { return K.blankState(['deck'].concat(WASTE, FOUNDATION)); };

  function newState(order) {
    var s = blank();
    FOUNDATION.forEach(function (f, n) { s.piles[f].push(K.card(SEEDS[n], true)); });
    order.filter(function (id) { return SEEDS.indexOf(id) < 0; }).forEach(function (id) { s.piles.deck.push(K.card(id, true)); });
    return s;
  }

  var place = K.layout({
    topRows: 1,
    items: [{ pile: 'deck', kind: 'waste', col: DECK_COL, row: 0, label: 'calc.deck' }]
      .concat(FOUNDATION.map(function (f, n) { return { pile: f, kind: 'foundation', col: n, row: 0, n: n + 1, label: 'calc.foundation' }; }))
      .concat(WASTE.map(function (w, n) { return { pile: w, kind: 'column', col: n, row: 1, n: n + 1, label: 'calc.waste' }; }))
  });

  // One move from a win: every foundation but the last king, which is the only card left on the deck.
  function almostWon() {
    var s = blank();
    FOUNDATION.forEach(function (f, n) {
      var rank = Z.rank(SEEDS[n]), i;
      s.piles[f].push(K.card(SEEDS[n], true));
      for (i = 1; i < RANKS; i++) { rank = nextRank(rank, n + 1); if (!(n === FOUNDATION.length - 1 && i === RANKS - 1)) s.piles[f].push(K.card(Z.make(rank, Z.suit(SEEDS[n])), true)); }
    });
    s.piles.deck.push(K.card(Z.make(RANKS, Z.suit(SEEDS[FOUNDATION.length - 1])), true));
    return s;
  }

  var api = Object.assign(R, { newState: newState, blankState: blank, place: place, almostWon: almostWon, nextRank: nextRank, needs: needs, SEEDS: SEEDS, WASTE: WASTE });
  root.ZimiCalculation = api;

  function boot() {
    K.page({ rules: R, id: 'calculation', title: 'Calculation', cols: COLS, place: place,
      deal: function () { return newState(Z.shuffled(Z.random())); }, almostWon: almostWon });
  }
  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
