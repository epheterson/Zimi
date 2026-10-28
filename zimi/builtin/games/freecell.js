/* ZimiGames: FreeCell. The numbered deals are the Microsoft ones (see
   ZimiCards.msDeal), so deal #617 here is deal #617 on the machine you
   remember. Rules are pure functions on a plain state; the page wiring at the
   bottom only runs in a browser.

   State: piles { c0..c7 columns, fr0..fr3 free cells (0 or 1 card),
   fd0..fd3 foundations }, each a list of card ids (the last is the top),
   plus the deal number and a move count. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, TX = root.ZimiCards.T;

  var COLUMNS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
  var CELLS = ['fr0', 'fr1', 'fr2', 'fr3'];
  var FOUNDATION = ['fd0', 'fd1', 'fd2', 'fd3'];
  var MAX_DEAL = 1000000, RANDOM_DEAL_MAX = 32000, UNWINNABLE_DEAL = 11982;
  var COLS = 8, AUTO_KEY = 'freecell.auto', AUTO_TOLD_KEY = 'freecell.autoTold', WINNABLE_KEY = 'freecell.winnable';
  var HINT_NODES = 25000, HINT_MS = 2500, HINT_SHOW_MS = 4500;   // the hint solver's limits, and how long its note stays up

  var kind = function (p) { return p.charAt(0) === 'c' ? 'column' : p.charAt(1) === 'r' ? 'cell' : 'foundation'; };
  var top = function (pile) { return pile[pile.length - 1]; };

  // ── Rules ───────────────────────────────────────────────────────────────
  function newState(dealNo) {
    var piles = {}, cards = Z.msDeal(dealNo);
    COLUMNS.concat(CELLS, FOUNDATION).forEach(function (p) { piles[p] = []; });
    cards.forEach(function (id, i) { piles[COLUMNS[i % COLS]].push(id); });
    return { piles: piles, deal: dealNo, moves: 0 };
  }

  // The classic limit: (free cells + 1) * 2^(empty columns), where a column
  // you are moving into does not count as one of the empties.
  function maxMovable(freeCells, emptyColumns, toEmptyColumn) {
    return (freeCells + 1) * Math.pow(2, emptyColumns - (toEmptyColumn ? 1 : 0));
  }
  function capacity(state, to) {
    var P = state.piles;
    var free = CELLS.filter(function (c) { return !P[c].length; }).length;
    var empty = COLUMNS.filter(function (c) { return !P[c].length; }).length;
    return maxMovable(free, empty, !P[to].length);
  }

  function canPick(state, pile, idx) {
    var p = state.piles[pile], k = kind(pile);
    if (idx < 0 || idx >= p.length) return false;
    if (k === 'foundation') return false;
    if (k === 'cell') return idx === 0;
    return Z.isRun(p.slice(idx));
  }

  function legalMove(state, from, idx, to) {
    if (from === to || !canPick(state, from, idx)) return false;
    var P = state.piles, moving = P[from].slice(idx), first = moving[0], k = kind(to);
    if (k === 'cell') return moving.length === 1 && !P[to].length;
    if (k === 'foundation') return moving.length === 1 && Z.foundationAccepts(first, P[to].length ? top(P[to]) : null, P[to].length);
    if (P[to].length && !Z.stacksOn(top(P[to]), first)) return false;
    return moving.length <= capacity(state, to);
  }

  function applyMove(state, from, idx, to) {
    var s = Z.clone(state);
    s.piles[to] = s.piles[to].concat(s.piles[from].splice(idx));
    s.moves++;
    return s;
  }

  // Where a tap sends a card: a foundation, then a column with cards on it,
  // then an empty column (not to move a column's own bottom card), then a
  // free cell (not from one).
  function bestMove(state, from, idx) {
    if (!canPick(state, from, idx)) return null;
    var P = state.piles, targets = [], single = P[from].length - idx === 1;
    if (single) targets = targets.concat(FOUNDATION);
    targets = targets.concat(COLUMNS.filter(function (c) { return P[c].length; }));
    if (!(kind(from) === 'column' && idx === 0)) targets = targets.concat(COLUMNS.filter(function (c) { return !P[c].length; }));
    if (single && kind(from) !== 'cell') targets = targets.concat(CELLS);
    for (var i = 0; i < targets.length; i++) if (legalMove(state, from, idx, targets[i])) return targets[i];
    return null;
  }

  // A card is safe to send up when nothing left in play could still want it
  // as a place to land: an ace or deuce, or both opposite-coloured suits are
  // already within one rank of it.
  function foundationRank(state, suit) {
    for (var i = 0; i < FOUNDATION.length; i++) {
      var p = state.piles[FOUNDATION[i]];
      if (p.length && Z.suit(top(p)) === suit) return p.length;
    }
    return 0;
  }
  function isSafe(state, id) {
    var r = Z.rank(id);
    if (r <= 2) return true;
    var opposite = Z.isRed(id) ? [0, 3] : [1, 2];
    return opposite.every(function (s) { return foundationRank(state, s) >= r - 1; });
  }
  function safeAutoMove(state) {
    var sources = CELLS.concat(COLUMNS), i, j, p;
    for (i = 0; i < sources.length; i++) {
      p = state.piles[sources[i]];
      if (!p.length || !isSafe(state, top(p))) continue;
      for (j = 0; j < FOUNDATION.length; j++) if (legalMove(state, sources[i], p.length - 1, FOUNDATION[j])) return { from: sources[i], idx: p.length - 1, to: FOUNDATION[j] };
    }
    return null;
  }

  function isWon(state) {
    return FOUNDATION.every(function (f) { return state.piles[f].length === Z.KING; });
  }
  // For the debug hook: one move from a win (the king of spades is the last card).
  function almostWon() {
    var s = newState(1);
    COLUMNS.concat(CELLS, FOUNDATION).forEach(function (p) { s.piles[p] = []; });
    for (var suit = 0; suit < 4; suit++) {
      for (var r = 1; r <= Z.KING; r++) {
        if (suit === 3 && r === Z.KING) s.piles.c0.push(Z.make(r, suit)); else s.piles['fd' + suit].push(Z.make(r, suit));
      }
    }
    return s;
  }

  // Any move at all: a position with none is lost, and says so.
  function hasMove(state) {
    var from = COLUMNS.concat(CELLS), to = COLUMNS.concat(CELLS, FOUNDATION), i, j, k, n;
    for (i = 0; i < from.length; i++) {
      n = state.piles[from[i]].length;
      for (j = 0; j < n; j++) for (k = 0; k < to.length; k++) if (legalMove(state, from[i], j, to[k])) return true;
    }
    return false;
  }
  // The words for a card that would not go: a tap that had nowhere to send it (no `to`), or a drop on a pile that refused it.
  function why(state, pile, idx, to) {
    var P = state.piles, n = P[pile].length - idx;
    if (!canPick(state, pile, idx)) return TX('fc.why.run');
    if (to === undefined) return TX(CELLS.every(function (c) { return P[c].length; }) ? 'fc.why.cells' : 'sol.why.nowhere');
    if (kind(to) === 'cell') return TX('fc.why.cell');
    if (kind(to) === 'foundation') return TX(n > 1 ? 'sol.why.oneCard' : 'sol.why.foundation');
    if (P[to].length && !Z.stacksOn(top(P[to]), P[pile][idx])) return TX('sol.why.build');
    return TX('fc.why.limit', { cards: Z.plural(capacity(state, to), 'card') });
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var UP_STEP_SHARE = 0.3, MIN_STEP_SHARE = 0.12;

  function place(state, m) {
    var P = state.piles, cw = m.cw, ch = m.ch, x = function (col) { return m.left + col * m.step; };
    // The free cells and foundations are one row right under the bar; the columns start under it and fan through the rest.
    var rows = Z.solitaireRows(m), y1 = rows.top, y2 = rows.cols, slots = [], cards = [];
    var step = Z.fanStep(Math.max.apply(null, COLUMNS.map(function (c) { return P[c].length - 1; })), rows.room, ch, ch * UP_STEP_SHARE, ch * MIN_STEP_SHARE);
    var bottom = y2 + ch;

    CELLS.forEach(function (c, n) {
      P[c].forEach(function (id, i) { cards.push({ id: id, pile: c, idx: i, x: x(n), y: y1, up: true }); });
    });
    FOUNDATION.forEach(function (f, n) {
      P[f].forEach(function (id, i) { cards.push({ id: id, pile: f, idx: i, x: x(COLS / 2 + n), y: y1, up: true, hidden: i < P[f].length - 2 }); });
    });
    COLUMNS.forEach(function (c, n) {
      P[c].forEach(function (id, i) { cards.push({ id: id, pile: c, idx: i, x: x(n), y: y2 + i * step, up: true }); });
      bottom = Math.max(bottom, y2 + Math.max(0, P[c].length - 1) * step + ch);
    });
    var height = Math.max(bottom + m.pad, m.H);

    CELLS.forEach(function (c, n) {
      slots.push({ id: c, x: x(n), y: y1, w: cw, h: ch, label: P[c].length ? TX('fc.cell', { n: n + 1, card: Z.cardName(P[c][0]) }) : TX('fc.cellEmpty', { n: n + 1 }) });
    });
    FOUNDATION.forEach(function (f, n) {
      var t = P[f].length ? top(P[f]) : null;
      slots.push({ id: f, x: x(COLS / 2 + n), y: y1, w: cw, h: ch, goal: true, mark: t === null ? 'A' : '', label: (t === null ? TX('sol.foundationEmpty') : TX('sol.foundation', { suit: TX('cards.suit.' + ['clubs', 'diamonds', 'hearts', 'spades'][Z.suit(t)]), cards: Z.plural(P[f].length, 'card') })) });
    });
    COLUMNS.forEach(function (c, n) {
      slots.push({ id: c, x: x(n), y: y2, w: cw, h: Math.max(ch, height - m.pad - y2), label: Z.describePile(TX('fc.column', { n: n + 1 }), P[c], true) });
    });
    return { height: height, slots: slots, cards: cards };
  }

  var api = {
    COLUMNS: COLUMNS, CELLS: CELLS, FOUNDATION: FOUNDATION,
    newState: newState, maxMovable: maxMovable, canPick: canPick, legalMove: legalMove, applyMove: applyMove,
    bestMove: bestMove, safeAutoMove: safeAutoMove, isWon: isWon, hasMove: hasMove, why: why, almostWon: almostWon, place: place
  };
  root.ZimiFreeCell = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AUTO_STEP_MS = 140;
  function boot() {
    var page, session, board, d = root.document, hintEl = d.getElementById('zc-hint'), autoOn = Z.store.get(AUTO_KEY, true) !== false;
    var params = new root.URLSearchParams(root.location.search);
    // Every one of the 32,000 classic deals but one can be won, so "winnable deals only" just never deals that one.
    var winnableOnly = Z.store.get(WINNABLE_KEY, true) !== false, hint = null, hintBusy = false;
    function randomDealNo() {
      var n;
      do { n = 1 + Math.floor(Math.random() * RANDOM_DEAL_MAX); } while (winnableOnly && n === UNWINNABLE_DEAL);
      return n;
    }
    var dealNo = Math.min(MAX_DEAL, Math.max(1, parseInt(params.get('deal'), 10) || 0)) || randomDealNo();

    function startDeal(n) {
      dealNo = n;
      hint = null; Z.toast();
      session.reset(newState(n));
      if (session.state.deal !== n) dealNo = session.state.deal;   // a game taken up again keeps its deal
    }
    function dealLabel() { return TX(dealNo === UNWINNABLE_DEAL ? 'fc.dealNoWin' : 'fc.deal', { n: dealNo }); }
    function randomDeal() { startDeal(randomDealNo()); }
    // ── Hint: the solver's first move, shown as a glow on the card and where it goes ──
    function note(text) { Z.toast(text, HINT_SHOW_MS); }
    function showHint() {
      if (hintBusy || session.won) return;
      var st = session.state;
      if (isWon(st)) return;
      hintBusy = true; hintEl.disabled = true; note(TX('fc.looking'));
      setTimeout(function () {
        var r = root.ZimiFreeCellSolver.solve(st, { maxNodes: HINT_NODES, maxMs: HINT_MS });
        hintBusy = false; hintEl.disabled = false;
        if (session.state !== st) return;                  // the player moved while it was thinking
        if (!r.moves || !r.moves.length) { note(TX('fc.noLine')); return; }
        hint = { state: st, move: r.moves[0] };
        board.render(st);
        note(TX('fc.hint'));
      }, 30);
    }
    // The layout with the hint laid over it: the card glows, and so does where it lands.
    function placeWithHint(state, m) {
      var out = place(state, m);
      if (!hint || hint.state !== state) return out;
      var h = hint.move, dest = state.piles[h.to];
      out.cards.forEach(function (c) {
        if (c.pile === h.from && c.idx === h.idx) c.glow = true;
        if (c.pile === h.to && c.idx === dest.length - 1) c.glow = true;
      });
      if (!dest.length) out.slots.forEach(function (s) { if (s.id === h.to) s.mark = '↓'; });
      return out;
    }
    function autoRun() {
      if (!autoOn) return;
      session.later(function () {
        var step = safeAutoMove(session.state);
        if (!step) return;
        session.follow(applyMove(session.state, step.from, step.idx, step.to));
        // The first card that goes up by itself says so, once: a card that leaves the columns unasked would otherwise be a surprise.
        if (!Z.store.get(AUTO_TOLD_KEY, false)) { Z.store.set(AUTO_TOLD_KEY, true); page.note(TX('fc.autoTold')); }
        if (isWon(session.state)) session.win(); else autoRun();
      }, AUTO_STEP_MS);
    }

    page = Z.solitairePage({
      rules: api, id: 'freecell', place: placeWithHint, cols: COLS, newGame: randomDeal, after: autoRun, why: why,
      stuck: { is: function (st) { return !isWon(st) && !hasMove(st); }, score: function () { return undefined; }, title: function () { return TX('cards.noMoves'); }, note: function () { return TX('fc.stuck'); } },
      statText: function (sec, st) { return Z.fmtTime(sec) + ' · ' + st.moves; },
      cascadeOrder: function (st) {
        var order = [], r;
        for (r = Z.KING; r >= 1; r--) FOUNDATION.forEach(function (f) { order.push({ id: st.piles[f][r - 1] }); });
        return order;
      },
      winLines: function (sec, st) { return [TX('fc.win', { n: st.deal, time: Z.fmtTime(sec), moves: Z.plural(st.moves, 'move') })]; },
      openMenu: function () {
        var input = Z.h('input', { class: 'zc-input', type: 'number', min: '1', max: String(MAX_DEAL), inputmode: 'numeric', 'aria-label': TX('fc.dealNumber'), value: String(dealNo) });
        var note = Z.h('p', { class: 'zc-note', text: TX('fc.classic') });
        var sheet;
        var play = function () {
          var n = parseInt(input.value, 10);
          if (!(n >= 1 && n <= MAX_DEAL)) { note.textContent = TX('fc.pick', { n: MAX_DEAL }); return; }
          sheet.close(); startDeal(n);
        };
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); play(); } });
        var winnablePick = Z.segmented([{ label: TX('shell.on'), value: true }, { label: TX('shell.off'), value: false }], winnableOnly, function (v) { winnableOnly = v; Z.store.set(WINNABLE_KEY, v); });
        var autoPick = Z.segmented([{ label: TX('shell.on'), value: true }, { label: TX('shell.off'), value: false }], autoOn, function (v) { autoOn = v; Z.store.set(AUTO_KEY, v); });
        sheet = page.menu('FreeCell', [
          Z.h('p', { class: 'zc-note', text: dealLabel() }),
          Z.h('div', { class: 'zc-row' }, [Z.h('label', { text: TX('fc.dealNumber') }), input, Z.h('button', { class: 'ar-btn', type: 'button', text: TX('fc.play'), onclick: play })]),
          note,
          Z.h('div', { class: 'zc-row' }, [Z.h('label', { text: TX('fc.auto') }), autoPick]),
          Z.h('div', { class: 'zc-row' }, [Z.h('label', { text: TX('fc.winnable') }), winnablePick])
        ], [{ label: TX('fc.restart'), onclick: function () { startDeal(dealNo); } }, { label: TX('fc.random'), onclick: randomDeal }, { label: TX('shell.close'), primary: true }]);
      }
    });
    session = page.session; board = page.board;

    hintEl.addEventListener('click', showHint);
    api.showHint = showHint;
    page.start(function () { startDeal(dealNo); });
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
