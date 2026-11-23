/* ZimiGames: Monte Carlo. Twenty-five cards lie face up in five rows of five. Two cards of the same rank that touch, side to
   side or corner to corner, go out together. When you cannot, or will not, remove any more, tap the stock: the cards slide up
   and left to close the gaps and the stock fills the empty places at the end. Clear all 52 to win.
   State: piles g0..g24 (a place on the grid, 0 or 1 card), stock (the last card is dealt first), out, moves. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, K = root.ZimiSolKit, TX = root.ZimiCards.T;

  var SIDE = 5, CELLS = SIDE * SIDE, COLS = SIDE, HEIGHT_SHARE = 0.115;
  var GRID = [];
  for (var i = 0; i < CELLS; i++) GRID.push('g' + i);
  var at = function (name) { return parseInt(name.slice(1), 10); };

  var touching = function (a, b) { var i = at(a), j = at(b); return a !== b && Math.abs(Math.floor(i / SIDE) - Math.floor(j / SIDE)) <= 1 && Math.abs(i % SIDE - j % SIDE) <= 1; };
  var rankOf = function (state, name) { return Z.rank(state.piles[name][0].id); };
  var filled = function (state, name) { return state.piles[name].length > 0; };

  function canPick(state, pile, idx) { return GRID.indexOf(pile) >= 0 && idx === 0 && filled(state, pile); }
  function legalMove(state, from, idx, to) {
    return canPick(state, from, idx) && GRID.indexOf(to) >= 0 && filled(state, to) && touching(from, to) && rankOf(state, from) === rankOf(state, to);
  }
  function applyMove(state, from, idx, to) {
    var s = Z.clone(state);
    s.piles.out = s.piles.out.concat(s.piles[from], s.piles[to]);
    s.piles[from] = []; s.piles[to] = [];
    s.moves++;
    return s;
  }
  // The pairs for a card: every touching card of its rank.
  function partners(state, name) { return GRID.filter(function (g) { return legalMove(state, name, 0, g); }); }
  function bestMove(state, from, idx) { return canPick(state, from, idx) ? partners(state, from)[0] || null : null; }

  // Close the gaps (cards keep their order, up and to the left), then deal the stock into the empty places.
  function fill(state) {
    var s = Z.clone(state), cards = [];
    GRID.forEach(function (g) { if (s.piles[g].length) cards.push(s.piles[g][0]); s.piles[g] = []; });
    while (cards.length < CELLS && s.piles.stock.length) { var c = s.piles.stock.pop(); c.up = true; cards.push(c); }
    cards.forEach(function (c, n) { s.piles[GRID[n]] = [c]; });
    s.moves++;
    return s;
  }
  // The stock slides the cards up only when that changes something: a gap to close, or cards to deal.
  function draw(state) {
    var next = fill(state);
    return GRID.some(function (g) { return JSON.stringify(next.piles[g]) !== JSON.stringify(state.piles[g]); }) || next.piles.stock.length !== state.piles.stock.length ? next : null;
  }
  function pairs(state) { return GRID.some(function (g) { return filled(state, g) && partners(state, g).length; }); }
  function hasMove(state) { return pairs(state) || !!draw(state); }
  function isWon(state) { return !state.piles.stock.length && GRID.every(function (g) { return !filled(state, g); }); }
  function why(state, pile, idx, to) {
    if (!canPick(state, pile, idx)) return null;
    return TX(to === undefined || !filled(state, to) ? 'montecarlo.why.pair' : 'montecarlo.why.touch');
  }

  function blankState() { return K.blankState(['stock', 'out'].concat(GRID)); }
  function newState(order) {
    var s = blankState();
    order.forEach(function (id, n) { if (n < CELLS) s.piles[GRID[n]].push(K.card(id, true)); else s.piles.stock.unshift(K.card(id, false)); });
    return s;
  }

  function place(state, m) {
    var P = state.piles, rows = Z.solitaireRows(m), cards = [], slots = [], lineH = Math.round(m.ch * 1.08), x = function (c) { return m.left + c * m.step; };
    var y = function (r) { return rows.top + r * lineH; }, gridTop = y(1);
    P.stock.forEach(function (c, i) { cards.push({ id: c.id, pile: 'stock', idx: i, x: x(0), y: y(0), up: false, hidden: i < P.stock.length - 2 }); });
    slots.push({ id: 'stock', x: x(0), y: y(0), w: m.cw, h: m.ch, mark: P.stock.length ? '' : '↻', label: Z.describePile(TX('sol.stock'), Z.idsOf(P.stock), false) + TX('montecarlo.enter') });
    P.out.forEach(function (c, i) { cards.push({ id: c.id, pile: 'out', idx: i, x: x(SIDE - 1), y: y(0), up: true, hidden: i < P.out.length - 2 }); });
    slots.push({ id: 'out', x: x(SIDE - 1), y: y(0), w: m.cw, h: m.ch, goal: true, mark: '', label: TX('montecarlo.out', { cards: Z.plural(P.out.length, 'card') }) });
    GRID.forEach(function (g, n) {
      var px = x(n % SIDE), py = gridTop + Math.floor(n / SIDE) * lineH;
      P[g].forEach(function (c, i) { cards.push({ id: c.id, pile: g, idx: i, x: px, y: py, up: true }); });
      slots.push({ id: g, x: px, y: py, w: m.cw, h: m.ch, label: P[g].length ? Z.cardName(P[g][0].id) : TX('montecarlo.empty', { n: n + 1 }) });
    });
    return { height: Math.max(gridTop + SIDE * lineH + m.pad, m.H), slots: slots, cards: cards };
  }

  function cascade(st) { return st.piles.out.slice(-Z.KING).map(function (c) { return { id: c.id }; }); }
  // One move from a win: two kings touching, everything else already out.
  function almostWon() {
    var s = blankState(), id, a = Z.make(Z.KING, 0), b = Z.make(Z.KING, 1);
    for (id = 0; id < Z.DECK; id++) if (id !== a && id !== b) s.piles.out.push(K.card(id, true));
    s.piles.g0.push(K.card(a, true)); s.piles.g1.push(K.card(b, true));
    return s;
  }

  var api = { GRID: GRID, newState: newState, blankState: blankState, canPick: canPick, legalMove: legalMove, applyMove: applyMove, bestMove: bestMove,
    drawStock: draw, fill: fill, hasMove: hasMove, isWon: isWon, why: why, place: place, almostWon: almostWon, partners: partners, S: { foundation: [], draw: draw } };
  root.ZimiMonteCarlo = api;

  function boot() {
    K.page({ rules: api, id: 'montecarlo', title: 'Monte Carlo', cols: COLS, place: place, cascade: cascade, refuse: 'montecarlo.why.fill', heightShare: HEIGHT_SHARE,
      deal: function () { return newState(Z.shuffled(Z.random())); }, almostWon: almostWon });
  }
  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
