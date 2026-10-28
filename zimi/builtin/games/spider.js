/* ZimiGames: Spider. Two decks, 104 cards, one, two or four suits. Build
   columns downward, any suit on the next rank up; move a run only if it is
   all one suit. A king-to-ace run of one suit leaves the table. The stock
   deals a card on every column, and only when no column is empty. Clear all
   eight runs to win.

   State: piles { stock, c0..c9 (cards {id, up}), d0..d7 (finished runs, ids) },
   plus suits, score, moves. Card ids past 51 are the second deck's copies of
   the same faces (ZimiCards treats id % 52 as the face). Scoring is the
   classic: 500 to start, minus 1 per move, plus 100 per run taken off.
   Rules are pure functions; the page wiring at the bottom only runs in a
   browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, TX = root.ZimiCards.T;

  var COLUMNS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'];
  var DONE = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
  var COLS = 10, SETS = 8, DECK_CARDS = 104, DEAL_ROW = COLS, SUITS_KEY = 'spider.suits';
  var SCORE = { start: 500, move: -1, run: 100 };
  var SUIT_SETS = { 1: [3, 3, 3, 3, 3, 3, 3, 3], 2: [3, 2, 3, 2, 3, 2, 3, 2], 4: [0, 1, 2, 3, 0, 1, 2, 3] };
  var top = function (pile) { return pile[pile.length - 1]; };
  var card = function (id, up) { return { id: id, up: up }; };

  // ── Rules ───────────────────────────────────────────────────────────────
  // The 104 card ids for a number of suits: eight sets of A..K, set k a copy
  // numbered k, so every card has its own id and id % 52 is its face.
  function deck(suits) {
    var out = [], k, r, set = SUIT_SETS[suits] || SUIT_SETS[1];
    for (k = 0; k < SETS; k++) for (r = 1; r <= Z.KING; r++) out.push(k * Z.DECK + Z.make(r, set[k]));
    return out;
  }
  function shuffledDeck(suits, rng) {
    var a = deck(suits), i, j, t;
    for (i = a.length - 1; i > 0; i--) { j = Math.floor(rng() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function blankState(suits) {
    var piles = { stock: [] };
    COLUMNS.concat(DONE).forEach(function (p) { piles[p] = []; });
    return { piles: piles, suits: SUIT_SETS[suits] ? suits : 1, score: SCORE.start, moves: 0 };
  }
  // The first four columns get six cards, the rest five; the last of each is
  // face up. Fifty cards stay in the stock, five rows of ten.
  function newState(order, suits) {
    var s = blankState(suits), k = 0;
    COLUMNS.forEach(function (c, n) {
      var count = n < 4 ? 6 : 5;
      for (var j = 0; j < count; j++) s.piles[c].push(card(order[k++], j === count - 1));
    });
    while (k < order.length) s.piles.stock.push(card(order[k++], false));
    return s;
  }

  var isColumn = function (p) { return p.charAt(0) === 'c'; };
  var sameRun = function (upper, lower) { return Z.suit(upper) === Z.suit(lower) && Z.rank(lower) === Z.rank(upper) - 1; };
  // The cards from idx down are one suit, each a rank below the one above.
  function isSuitRun(ids) {
    for (var i = 1; i < ids.length; i++) if (!sameRun(ids[i - 1], ids[i])) return false;
    return true;
  }

  function canPick(state, pile, idx) {
    var p = state.piles[pile];
    if (!isColumn(pile) || idx < 0 || idx >= p.length || !p[idx].up) return false;
    return isSuitRun(Z.idsOf(p.slice(idx)));
  }
  function legalMove(state, from, idx, to) {
    if (from === to || !isColumn(to) || !canPick(state, from, idx)) return false;
    var dest = state.piles[to];
    return dest.length === 0 || Z.rank(top(dest).id) === Z.rank(state.piles[from][idx].id) + 1;
  }

  // Take a finished K..A run (the last thirteen cards of a column) off the table.
  function sweepRuns(state) {
    var s = state;
    COLUMNS.forEach(function (c) {
      var p = s.piles[c], n = p.length;
      if (n < Z.KING) return;
      var ids = Z.idsOf(p.slice(n - Z.KING));
      if (Z.rank(ids[0]) !== Z.KING || !p[n - Z.KING].up || !isSuitRun(ids)) return;
      if (s === state) s = Z.clone(state);
      var run = s.piles[c].splice(n - Z.KING);
      var d = DONE.filter(function (x) { return !s.piles[x].length; })[0];
      s.piles[d] = Z.idsOf(run);
      s.score += SCORE.run;
      var left = s.piles[c];
      if (left.length) left[left.length - 1].up = true;
    });
    return s;
  }
  function applyMove(state, from, idx, to) {
    var s = Z.clone(state), src = s.piles[from];
    s.piles[to] = s.piles[to].concat(src.splice(idx));
    if (src.length) top(src).up = true;
    s.moves++; s.score += SCORE.move;
    return sweepRuns(s);
  }

  // A deal puts one card on every column, and is refused while one is empty.
  function canDeal(state) {
    return state.piles.stock.length >= DEAL_ROW && COLUMNS.every(function (c) { return state.piles[c].length > 0; });
  }
  function dealRow(state) {
    if (!canDeal(state)) return null;
    var s = Z.clone(state);
    COLUMNS.forEach(function (c) { var k = s.piles.stock.pop(); k.up = true; s.piles[c].push(k); });
    s.moves++; s.score += SCORE.move;
    return sweepRuns(s);
  }
  function runsDone(state) { return DONE.filter(function (d) { return state.piles[d].length; }).length; }
  function isWon(state) { return runsDone(state) === SETS; }

  // Where a tap sends a run: onto a column that wants it, the same suit first.
  // Not onto another suit when that would pull a run apart. An empty column
  // only when the move turns a card over.
  function bestMove(state, from, idx) {
    if (!canPick(state, from, idx)) return null;
    var P = state.piles, first = P[from][idx].id, src = P[from], best = null, bestScore = 0;
    var breaksRun = idx > 0 && src[idx - 1].up && sameRun(src[idx - 1].id, first);
    COLUMNS.forEach(function (c) {
      if (c === from || !P[c].length || !legalMove(state, from, idx, c)) return;
      var same = Z.suit(top(P[c]).id) === Z.suit(first), score = same ? 2 : (breaksRun ? 0 : 1);
      if (score > bestScore) { best = c; bestScore = score; }
    });
    if (best) return best;
    var hole = COLUMNS.filter(function (c) { return !P[c].length; })[0];
    return hole && idx > 0 && !src[idx - 1].up ? hole : null;
  }

  // For the debug hook: all spades, seven runs taken, the eighth one move off.
  function almostWon() {
    var s = blankState(1), spade = function (r, k) { return k * Z.DECK + Z.make(r, 3); }, r, k;
    for (k = 0; k < SETS - 1; k++) { s.piles[DONE[k]] = []; for (r = Z.KING; r >= 1; r--) s.piles[DONE[k]].push(spade(r, k)); }
    for (r = Z.KING; r >= 2; r--) s.piles.c0.push(card(spade(r, 7), true));
    s.piles.c1.push(card(spade(1, 7), true));
    s.score = SCORE.start + (SETS - 1) * SCORE.run;
    return s;
  }

  // The words for a run that would not go: a tap that had nowhere to send it (no `to`), or a drop on a column that refused it.
  function why(state, pile, idx, to) {
    var card = state.piles[pile][idx];
    if (!card) return null;
    if (!card.up) return TX('sol.why.facedown');
    if (!canPick(state, pile, idx)) return TX('spider.why.run');
    return TX(to === undefined ? 'sol.why.nowhere' : 'spider.why.rank');
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  // A real deck: a face-down card shows a sliver (DOWN_RATIO of a face-up step, about 15% of the card), a face-up one
  // its rank, suit and a little pip (28%); a fan tightens only when the column would run off the screen.
  var DOWN_RATIO = 0.54, MAX_DOWN_RATIO = DOWN_RATIO, DOWN_RATIO_STEP = 0.05, UP_STEP_SHARE = 0.28, MIN_STEP_SHARE = 0.2;

  function place(state, m) {
    var P = state.piles, cw = m.cw, ch = m.ch, x = function (col) { return m.left + col * m.step; };
    // Stock and the finished runs are one row right under the bar; the columns start under it and fan through the rest.
    var rows = Z.solitaireRows(m), y1 = rows.top, y2 = rows.cols, slots = [], cards = [];
    var weight = function (pile, down) {
      var w = 0;
      for (var i = 0; i < pile.length - 1; i++) w += pile[i].up ? 1 : down;
      return w;
    };
    var heaviest = function (down) { return Math.max.apply(null, COLUMNS.map(function (c) { return weight(P[c], down); })); };
    var maxStep = ch * UP_STEP_SHARE, down = Z.openDown(heaviest, rows.room, ch, maxStep, DOWN_RATIO, MAX_DOWN_RATIO, DOWN_RATIO_STEP);
    var step = Z.fanStep(heaviest(down), rows.room, ch, maxStep, ch * MIN_STEP_SHARE);
    var bottom = y2 + ch;

    P.stock.forEach(function (c, i) { cards.push({ id: c.id, pile: 'stock', idx: i, x: x(0), y: y1, up: false, hidden: i < P.stock.length - 2 }); });
    DONE.forEach(function (d, n) {
      P[d].forEach(function (id, i) { cards.push({ id: id, pile: d, idx: i, x: x(2 + n), y: y1, up: true, hidden: i < P[d].length - 2 }); });
    });
    COLUMNS.forEach(function (c, n) {
      var yy = y2;
      P[c].forEach(function (k, i) {
        cards.push({ id: k.id, pile: c, idx: i, x: x(n), y: yy, up: k.up });
        if (i < P[c].length - 1) yy += k.up ? step : step * down;
      });
      bottom = Math.max(bottom, yy + ch);
    });
    var height = Math.max(bottom + m.pad, m.H);

    var dealsLeft = Math.floor(P.stock.length / DEAL_ROW);
    slots.push({ id: 'stock', x: x(0), y: y1, w: cw, h: ch, mark: P.stock.length ? '' : '∅',
      label: P.stock.length ? TX('spider.stock', { deals: TX('spider.deals', { n: dealsLeft }) }) : TX('spider.stockEmpty') });
    DONE.forEach(function (d, n) {
      slots.push({ id: d, x: x(2 + n), y: y1, w: cw, h: ch, goal: true, label: P[d].length ? TX('spider.run', { n: n + 1, suit: TX('cards.suit.' + ['clubs', 'diamonds', 'hearts', 'spades'][Z.suit(P[d][0])]) }) : TX('spider.runEmpty', { n: n + 1 }) });
    });
    COLUMNS.forEach(function (c, n) {
      slots.push({ id: c, x: x(n), y: y2, w: cw, h: Math.max(ch, height - m.pad - y2), label: Z.describePile(TX('fc.column', { n: n + 1 }), Z.idsOf(P[c]), P[c].length && top(P[c]).up) });
    });
    return { height: height, slots: slots, cards: cards };
  }

  var api = {
    COLUMNS: COLUMNS, DONE: DONE, SCORE: SCORE,
    deck: deck, shuffledDeck: shuffledDeck, blankState: blankState, newState: newState, isSuitRun: isSuitRun,
    canPick: canPick, legalMove: legalMove, applyMove: applyMove, sweepRuns: sweepRuns, canDeal: canDeal, dealRow: dealRow,
    runsDone: runsDone, isWon: isWon, bestMove: bestMove, why: why, almostWon: almostWon, place: place
  };
  root.ZimiSpider = api;

  // ── The page ────────────────────────────────────────────────────────────
  function boot() {
    var page, session, board;
    var suits = Z.store.get(SUITS_KEY, 1);
    if (!SUIT_SETS[suits]) suits = 1;

    function newGame() {
      session.stats = Z.createStats('spider' + suits);
      session.reset(newState(shuffledDeck(suits, Math.random), suits));
      if (session.state.suits !== suits) { suits = session.state.suits; session.stats = Z.createStats('spider' + suits); }   // a game taken up again keeps its suits
    }

    page = Z.solitairePage({
      rules: api, id: 'spider' + suits, saveId: 'spider', place: place, cols: COLS, newGame: newGame, stock: dealRow,
      score: function (st) { return st.score; },
      why: why,
      after: function (st) {
        var before = session.history[session.history.length - 1];
        if (before && runsDone(st) > runsDone(before)) page.note(TX('spider.runDone', { n: runsDone(st), total: SETS }));
      },
      refuse: function (st) {
        var text = TX(st.piles.stock.length ? 'spider.refuse' : 'spider.noDeals');
        board.say(text); page.note(text);
      },
      statText: function (sec, st) { return Z.fmtTime(sec) + ' · ' + st.score; },
      cascadeOrder: function (st) {
        var order = [], i;
        for (i = 0; i < Z.KING; i++) DONE.forEach(function (d) { if (st.piles[d][i] !== undefined) order.push({ id: st.piles[d][i] }); });
        return order;
      },
      winLines: function (sec, st) { return [TX('spider.win', { score: st.score, suits: TX('spider.suits', { n: st.suits }) }), Z.winTime(sec, st)]; },
      openMenu: function () {
        var pick = Z.segmented([{ label: TX('spider.suits', { n: 1 }), value: 1 }, { label: TX('spider.suits', { n: 2 }), value: 2 }, { label: TX('spider.suits', { n: 4 }), value: 4 }], suits, function (v) {
          suits = v; Z.store.set(SUITS_KEY, v);
          if (!session.state.moves) newGame();
        });
        page.menu('Spider', [Z.h('div', { class: 'zc-row' }, [Z.h('label', { text: TX('spider.suitsRow') }), pick]), Z.h('p', { class: 'zc-note', text: TX('spider.nextDeal') })]);
      }
    });
    session = page.session; board = page.board;
    page.start();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
