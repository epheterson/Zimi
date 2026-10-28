/* ZimiGames: Pyramid. Twenty-eight cards in seven rows. Take cards in pairs
   that add up to 13 (ace 1 ... queen 12), kings on their own. A pyramid card
   is free once the two cards that overlap it are gone; the top of the waste
   is free too. Turn the stock one card at a time; the waste may go round
   again twice.

   State: piles { 'p<row>_<col>' (0 or 1 card each), stock, waste, out },
   plus redeals used, score, moves. Rules are pure functions; the page wiring
   at the bottom only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, TX = root.ZimiCards.T;

  var ROWS = 7, TARGET = 13, MAX_REDEALS = 2;
  var SCORE = { card: 5, clear: 50, redealLeft: 25 };
  var COLS = 7;
  var top = function (pile) { return pile[pile.length - 1]; };
  var pid = function (r, c) { return 'p' + r + '_' + c; };
  var PYRAMID = [];
  (function () { for (var r = 0; r < ROWS; r++) for (var c = 0; c <= r; c++) PYRAMID.push(pid(r, c)); })();
  var isPyramid = function (p) { return p.charAt(0) === 'p'; };
  var rowOf = function (p) { return parseInt(p.slice(1), 10); };
  var colOf = function (p) { return parseInt(p.split('_')[1], 10); };
  var value = function (id) { return Z.rank(id); };

  // ── Rules ───────────────────────────────────────────────────────────────
  function newState(order) {
    var piles = { stock: [], waste: [], out: [] }, k = 0;
    PYRAMID.forEach(function (p) { piles[p] = [order[k++]]; });
    piles.stock = order.slice(k);
    return { piles: piles, redeals: 0, score: 0, moves: 0 };
  }

  // Free: a card nothing overlaps (the bottom row, or both cards below gone),
  // or the waste's top card.
  function isFree(state, pile) {
    var P = state.piles;
    if (pile === 'waste') return P.waste.length > 0;
    if (!isPyramid(pile) || !P[pile].length) return false;
    var r = rowOf(pile), c = colOf(pile);
    return r === ROWS - 1 || (!P[pid(r + 1, c)].length && !P[pid(r + 1, c + 1)].length);
  }
  function topId(state, pile) { return top(state.piles[pile]); }

  function canPick(state, pile) { return isFree(state, pile); }
  function isKing(state, pile) { return isFree(state, pile) && value(topId(state, pile)) === TARGET; }
  function isPair(state, a, b) {
    return a !== b && isFree(state, a) && isFree(state, b) && value(topId(state, a)) + value(topId(state, b)) === TARGET;
  }
  // A move is a pair; a king alone may be dropped on the out pile.
  function legalMove(state, from, idx, to) {
    if (to === 'out') return isKing(state, from);
    return isPair(state, from, to);
  }

  function pyramidLeft(state) { return PYRAMID.filter(function (p) { return state.piles[p].length; }).length; }
  function isWon(state) { return pyramidLeft(state) === 0; }

  // Take one or two free cards off the table.
  function takeAway(state, piles) {
    var s = Z.clone(state);
    piles.forEach(function (p) { s.piles.out.push(s.piles[p].pop()); s.score += SCORE.card; });
    s.moves++;
    if (isWon(s)) s.score += SCORE.clear + SCORE.redealLeft * (MAX_REDEALS - s.redeals);
    return s;
  }
  function applyMove(state, from, idx, to) { return takeAway(state, to === 'out' ? [from] : [from, to]); }

  function drawStock(state) {
    var P = state.piles;
    if (P.stock.length) {
      var s = Z.clone(state);
      s.piles.waste.push(s.piles.stock.pop());
      s.moves++;
      return s;
    }
    if (!P.waste.length || state.redeals >= MAX_REDEALS) return null;
    var r = Z.clone(state);
    r.piles.stock = r.piles.waste.reverse(); r.piles.waste = [];
    r.redeals++; r.moves++;
    return r;
  }
  function canDraw(state) { return !!drawStock(state); }

  function availableCards(state) { return PYRAMID.concat(['waste']).filter(function (p) { return isFree(state, p); }); }
  // A pair or a king the player can take right now, for hints and "stuck".
  function findMove(state) {
    var av = availableCards(state), i, j;
    for (i = 0; i < av.length; i++) {
      if (isKing(state, av[i])) return { from: av[i], to: 'out' };
      for (j = i + 1; j < av.length; j++) if (isPair(state, av[i], av[j])) return { from: av[i], to: av[j] };
    }
    return null;
  }
  // Out of play: no pair, no king, and no more of the stock to turn.
  function isStuck(state) { return !isWon(state) && !findMove(state) && !canDraw(state); }

  // For the debug hook: a pair away from a clear (queen and king left, plus a 6 and 7).
  function almostWon() {
    var s = newState(Z.shuffled(function () { return 0.3; }));
    PYRAMID.forEach(function (p) { s.piles[p] = []; });
    s.piles.stock = []; s.piles.waste = [Z.make(6, 0)];
    s.piles.p6_2 = [Z.make(7, 1)];
    s.piles.p6_4 = [Z.make(13, 2)];
    return s;
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var ROW_STEP_SHARE = 0.5, ROW_STEP_MAX = 0.6, HEIGHT_SHARE = 0.125;

  function place(state, m, view) {
    var P = state.piles, cw = m.cw, ch = m.ch, picked = view && view.picked;
    var x = function (col) { return m.left + col * m.step; };
    // Stock, waste and the taken pile are one row right under the bar; the pyramid under it, its rows stepping down to fill
    // the height: the more of a covered card shows, the easier the pyramid reads.
    var rows = Z.solitaireRows(m), y2 = rows.top, y1 = rows.cols, slots = [], cards = [];
    var rowStep = Math.max(ch * ROW_STEP_SHARE, Math.min(ch * ROW_STEP_MAX, (rows.room - ch) / (ROWS - 1)));
    var height = Math.max(m.H, y1 + rowStep * (ROWS - 1) + ch + m.pad);
    var at = function (p) { return { x: x(COLS / 2 - 0.5 - rowOf(p) / 2 + colOf(p)), y: y1 + rowOf(p) * rowStep }; };

    PYRAMID.forEach(function (p) {
      if (!P[p].length) return;
      var a = at(p);
      cards.push({ id: P[p][0], pile: p, idx: 0, x: a.x, y: a.y, up: true, mark: picked === p, dim: !isFree(state, p) });
      slots.push({ id: p, x: a.x, y: a.y, w: cw, h: ch, label: TX(isFree(state, p) ? 'pyr.card' : 'pyr.cardCovered', { row: rowOf(p) + 1, col: colOf(p) + 1, card: Z.cardName(P[p][0]) }) });
    });
    P.stock.forEach(function (id, i) { cards.push({ id: id, pile: 'stock', idx: i, x: x(0), y: y2, up: false, hidden: i < P.stock.length - 2 }); });
    P.waste.forEach(function (id, i) { cards.push({ id: id, pile: 'waste', idx: i, x: x(1), y: y2, up: true, hidden: i < P.waste.length - 2, mark: picked === 'waste' && i === P.waste.length - 1 }); });
    P.out.forEach(function (id, i) { cards.push({ id: id, pile: 'out', idx: i, x: x(COLS - 1), y: y2, up: true, hidden: i < P.out.length - 2 }); });

    slots.push({ id: 'stock', x: x(0), y: y2, w: cw, h: ch, mark: P.stock.length ? '' : (canDraw(state) ? '↻' : '∅'), label: Z.describePile(TX('sol.stock'), P.stock, false) + (P.stock.length ? TX('pyr.enterTurn') : canDraw(state) ? TX('pyr.enterAgain') : '') });
    slots.push({ id: 'waste', x: x(1), y: y2, w: cw, h: ch, label: Z.describePile(TX('sol.waste'), P.waste, true) });
    slots.push({ id: 'out', x: x(COLS - 1), y: y2, w: cw, h: ch, goal: true, label: TX('pyr.taken', { n: P.out.length }) });
    return { height: height, slots: slots, cards: cards };
  }

  var api = {
    PYRAMID: PYRAMID, SCORE: SCORE, MAX_REDEALS: MAX_REDEALS,
    newState: newState, isFree: isFree, canPick: canPick, isKing: isKing, isPair: isPair, legalMove: legalMove, applyMove: applyMove, takeAway: takeAway,
    drawStock: drawStock, canDraw: canDraw, findMove: findMove, isWon: isWon, isStuck: isStuck, pyramidLeft: pyramidLeft, almostWon: almostWon, place: place
  };
  root.ZimiPyramid = api;

  // ── The page ────────────────────────────────────────────────────────────
  function boot() {
    var page, session, board, view = { picked: null };

    function paintSub() { var st = session && session.state; if (!st) return; page.el.sub.textContent = isStuck(st) ? TX('cards.noMoves') : TX('pyr.redeals', { n: MAX_REDEALS - st.redeals }); }
    function select(pile) { view.picked = pile; board.refresh(); }
    function tap(pile) {
      var st = session.state;
      if (pile === 'stock') return page.draw();
      if (!isFree(st, pile)) { page.note(TX('pyr.why.covered')); return false; }
      if (isKing(st, pile)) return page.commit(takeAway(st, [pile]));
      if (view.picked === pile) { select(null); return true; }
      if (view.picked && isPair(st, view.picked, pile)) return page.commit(takeAway(st, [view.picked, pile]));
      if (view.picked) page.note(TX('pyr.why.pair'));
      select(pile);
      return true;
    }
    function newGame() { view.picked = null; session.reset(newState(Z.shuffled(Math.random))); paintSub(); }

    page = Z.solitairePage({
      refuse: function () { page.note(TX('pyr.why.noRedeals')); },
      rules: api, id: 'pyramid', fact: true, cols: COLS, heightShare: HEIGHT_SHARE, enterTaps: true, newGame: newGame, tap: tap, stock: drawStock,
      place: function (st, m) { return place(st, m, view); },
      settle: function () { view.picked = null; paintSub(); },
      score: function (st) { return st.score; },
      stuck: {
        is: isStuck, score: function (st) { return st.score; },
        title: function () { return TX('cards.noMoves'); }, note: function (st) { return TX('pyr.left', { n: pyramidLeft(st) }); }
      },
      statText: function (sec, st) { paintSub(); return Z.fmtTime(sec) + ' · ' + st.score; },
      cascadeOrder: function (st) { return st.piles.out.slice().reverse().map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return [TX('pyr.win', { score: st.score, bonus: SCORE.clear + SCORE.redealLeft * (MAX_REDEALS - st.redeals) }), Z.winTime(sec, st)]; },
      openMenu: function () { page.menu('Pyramid', [Z.h('p', { class: 'zc-note', text: TX('pyr.rules') })]); }
    });
    session = page.session; board = page.board;
    page.start();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
