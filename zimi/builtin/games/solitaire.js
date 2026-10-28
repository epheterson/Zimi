/* ZimiGames: Klondike. The rules are pure functions on a plain state (so
   node can test them); the page wiring at the bottom only runs in a browser.

   State: piles { stock, waste, f0..f3, t0..t6 }, each a list of {id, up}
   (the last is the top), plus score, draw (1 or 3), passes, moves.

   Scoring is the classic Windows "standard" table:
     waste or tableau to a foundation +10      waste to tableau +5
     turning over a tableau card +5            foundation back to tableau -15
     recycling the waste into the stock: -100 in draw 1; in draw 3 the first
     three passes are free, then -20 each. The score never goes below 0.
     On a win: a time bonus of 700000 / seconds when the game took 30+ s. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, TX = root.ZimiCards.T;

  var TABLEAU = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'];
  var FOUNDATION = ['f0', 'f1', 'f2', 'f3'];
  var SCORE = { foundation: 10, wasteToTableau: 5, turnOver: 5, foundationToTableau: -15, recycleDraw1: -100, recycleDraw3: -20, freePassesDraw3: 3 };
  var BONUS_NUMERATOR = 700000, BONUS_AFTER_SECONDS = 30;
  var COLS = 7, SHOWN_WASTE = 3, DRAW_KEY = 'solitaire.draw';

  var isFoundation = function (p) { return p.charAt(0) === 'f'; };
  var isTableau = function (p) { return p.charAt(0) === 't'; };
  var top = function (pile) { return pile[pile.length - 1]; };
  var card = function (id, up) { return { id: id, up: up }; };

  // ── Rules ───────────────────────────────────────────────────────────────
  function blankState(drawN) {
    var piles = { stock: [], waste: [] };
    FOUNDATION.concat(TABLEAU).forEach(function (p) { piles[p] = []; });
    return { piles: piles, score: 0, draw: drawN === 3 ? 3 : 1, passes: 0, moves: 0 };
  }
  function newState(order, drawN) {
    var s = blankState(drawN), k = 0;
    TABLEAU.forEach(function (t, i) {
      for (var j = 0; j <= i; j++) s.piles[t].push(card(order[k++], j === i));
    });
    while (k < order.length) s.piles.stock.push(card(order[k++], false));
    return s;
  }

  function canPick(state, pile, idx) {
    var p = state.piles[pile];
    if (pile === 'stock' || idx < 0 || idx >= p.length) return false;
    if (!p[idx].up) return false;
    if (pile === 'waste' || isFoundation(pile)) return idx === p.length - 1;
    return Z.isRun(p.slice(idx).map(function (c) { return c.id; }));
  }

  function fitsFoundation(state, id, pile) {
    var p = state.piles[pile];
    return Z.foundationAccepts(id, p.length ? top(p).id : null, p.length);
  }
  function fitsTableau(state, id, pile) {
    var p = state.piles[pile];
    return p.length === 0 ? Z.rank(id) === Z.KING : Z.stacksOn(top(p).id, id);
  }

  function legalMove(state, from, idx, to) {
    if (from === to || !canPick(state, from, idx)) return false;
    var first = state.piles[from][idx].id, count = state.piles[from].length - idx;
    if (isFoundation(to)) return count === 1 && fitsFoundation(state, first, to);
    return isTableau(to) && fitsTableau(state, first, to);
  }

  function applyMove(state, from, idx, to) {
    var s = Z.clone(state), moving = s.piles[from].splice(idx);
    s.piles[to] = s.piles[to].concat(moving);
    if (isFoundation(to)) s.score += SCORE.foundation;
    else if (from === 'waste') s.score += SCORE.wasteToTableau;
    else if (isFoundation(from)) s.score += SCORE.foundationToTableau;
    if (isTableau(from)) {
      var t = top(s.piles[from]);
      if (t && !t.up) { t.up = true; s.score += SCORE.turnOver; }
    }
    s.score = Math.max(0, s.score);
    s.moves++;
    return s;
  }

  // Turn up to `draw` cards onto the waste; with the stock empty, turn the
  // waste back over into it (and pay for that).
  function drawStock(state) {
    var s = Z.clone(state), P = s.piles;
    if (P.stock.length) {
      for (var n = Math.min(s.draw, P.stock.length); n > 0; n--) { var c = P.stock.pop(); c.up = true; P.waste.push(c); }
    } else if (P.waste.length) {
      P.stock = P.waste.reverse().map(function (c) { return card(c.id, false); });
      P.waste = [];
      s.passes++;
      if (s.draw === 1) s.score += SCORE.recycleDraw1;
      else if (s.passes > SCORE.freePassesDraw3) s.score += SCORE.recycleDraw3;
      s.score = Math.max(0, s.score);
    } else return null;
    s.moves++;
    return s;
  }

  // Where a tap sends a card: a foundation first (its own suit's pile, else an
  // empty one), then a tableau pile that already has cards, then an empty one
  // (never to move a king that is already at the bottom of its column).
  function bestMove(state, from, idx) {
    if (!canPick(state, from, idx)) return null;
    var targets = [], P = state.piles, i;
    if (!isFoundation(from)) {
      var first = P[from][idx].id;
      var own = FOUNDATION.filter(function (f) { return P[f].length && Z.suit(top(P[f]).id) === Z.suit(first); });
      targets = targets.concat(own, FOUNDATION.filter(function (f) { return !P[f].length; }));
    }
    for (i = 0; i < TABLEAU.length; i++) if (P[TABLEAU[i]].length) targets.push(TABLEAU[i]);
    if (!(isTableau(from) && idx === 0)) for (i = 0; i < TABLEAU.length; i++) if (!P[TABLEAU[i]].length) targets.push(TABLEAU[i]);
    for (i = 0; i < targets.length; i++) if (legalMove(state, from, idx, targets[i])) return targets[i];
    return null;
  }

  function isWon(state) {
    return FOUNDATION.every(function (f) { return state.piles[f].length === Z.KING; });
  }
  // Nothing face down and nothing left to turn: the rest is a formality.
  function canAutoFinish(state) {
    return !state.piles.stock.length && TABLEAU.every(function (t) { return state.piles[t].every(function (c) { return c.up; }); });
  }
  function autoFinishStep(state) {
    var sources = ['waste'].concat(TABLEAU), i, j, p;
    for (i = 0; i < sources.length; i++) {
      p = state.piles[sources[i]];
      if (!p.length) continue;
      for (j = 0; j < FOUNDATION.length; j++) if (legalMove(state, sources[i], p.length - 1, FOUNDATION[j])) return { from: sources[i], idx: p.length - 1, to: FOUNDATION[j] };
    }
    return null;
  }
  function timeBonus(seconds) { return seconds >= BONUS_AFTER_SECONDS ? Math.round(BONUS_NUMERATOR / seconds) : 0; }

  // For the debug hook: one move from a win (the king of spades is the last card).
  function almostWon(drawN) {
    var s = blankState(drawN);
    for (var suit = 0; suit < 4; suit++) {
      for (var r = 1; r <= Z.KING; r++) {
        var id = Z.make(r, suit);
        if (suit === 3 && r === Z.KING) s.piles.t0.push(card(id, true)); else s.piles['f' + suit].push(card(id, true));
      }
    }
    return s;
  }

  // The words for a card that would not go: a tap that had nowhere to send it (no `to`), or a drop on a pile that refused it.
  function why(state, pile, idx, to) {
    var P = state.piles, card = P[pile] && P[pile][idx];
    if (!card) return null;
    if (!card.up) return TX('sol.why.facedown');
    if (!canPick(state, pile, idx)) return TX('sol.why.wasteTop');
    if (to === undefined) return TX('sol.why.nowhere');
    if (isFoundation(to)) return TX(P[pile].length - idx > 1 ? 'sol.why.oneCard' : 'sol.why.foundation');
    if (isTableau(to)) return TX(P[to].length ? 'sol.why.build' : 'sol.why.king');
    return null;
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  // Stock, waste and the foundations are one row right under the bar; the columns start under it and fan down through
  // all the height that is left (up to a card's height a step).
  var DOWN_RATIO = 0.54, MAX_DOWN_RATIO = DOWN_RATIO, DOWN_RATIO_STEP = 0.05, UP_STEP_SHARE = 0.28, MIN_STEP_SHARE = 0.12, WASTE_FAN_SHARE = 0.3;

  function place(state, m) {
    var P = state.piles, cw = m.cw, ch = m.ch, x = function (col) { return m.left + col * m.step; };
    var rows = Z.solitaireRows(m), y1 = rows.top, y2 = rows.cols, slots = [], cards = [];   // y1: the top row; y2: the columns
    var weight = function (pile, down) {
      var w = 0;
      for (var i = 0; i < pile.length - 1; i++) w += pile[i].up ? 1 : down;
      return w;
    };
    var heaviest = function (down) { return Math.max.apply(null, TABLEAU.map(function (t) { return weight(P[t], down); })); };
    var down = Z.openDown(heaviest, rows.room, ch, ch * UP_STEP_SHARE, DOWN_RATIO, MAX_DOWN_RATIO, DOWN_RATIO_STEP);
    var step = Z.fanStep(heaviest(down), rows.room, ch, ch * UP_STEP_SHARE, ch * MIN_STEP_SHARE);
    var bottom = y2 + ch;
    var ids = function (pile) { return pile.map(function (c) { return c.id; }); };
    var fan = cw * WASTE_FAN_SHARE;

    // stock: the top two cards drawn, the rest stacked unseen beneath
    P.stock.forEach(function (c, i) { cards.push({ id: c.id, pile: 'stock', idx: i, x: x(0), y: y1, up: false, hidden: i < P.stock.length - 2 }); });
    // waste: the last (up to) three cards fanned in draw 3, one in draw 1
    var shown = state.draw === 3 ? SHOWN_WASTE : 1;
    P.waste.forEach(function (c, i) {
      var k = i - (P.waste.length - Math.min(shown, P.waste.length)), seen = k >= 0;
      cards.push({ id: c.id, pile: 'waste', idx: i, x: x(1) + (seen ? k * fan : 0), y: y1, up: true, hidden: !seen });
    });
    FOUNDATION.forEach(function (f, n) {
      P[f].forEach(function (c, i) { cards.push({ id: c.id, pile: f, idx: i, x: x(3 + n), y: y1, up: true, hidden: i < P[f].length - 2 }); });
    });
    TABLEAU.forEach(function (t, n) {
      var yy = y2;
      P[t].forEach(function (c, i) {
        cards.push({ id: c.id, pile: t, idx: i, x: x(n), y: yy, up: c.up, hidden: false });
        if (i < P[t].length - 1) yy += c.up ? step : step * down;
      });
      bottom = Math.max(bottom, yy + ch);
    });
    var height = Math.max(bottom + m.pad, m.H);

    slots.push({ id: 'stock', x: x(0), y: y1, w: cw, h: ch, mark: P.stock.length ? '' : '↻', label: Z.describePile(TX('sol.stock'), ids(P.stock), false) + (P.stock.length ? TX('sol.enterDraw') : TX('sol.enterRecycle')) });
    slots.push({ id: 'waste', x: x(1), y: y1, w: cw + fan * (SHOWN_WASTE - 1), h: ch, label: Z.describePile(TX('sol.waste'), ids(P.waste), true) });
    FOUNDATION.forEach(function (f, n) {
      var t = P[f].length ? top(P[f]).id : null;
      slots.push({ id: f, x: x(3 + n), y: y1, w: cw, h: ch, goal: true, mark: t === null ? 'A' : '', label: (t === null ? TX('sol.foundationEmpty') : TX('sol.foundation', { suit: TX('cards.suit.' + ['clubs', 'diamonds', 'hearts', 'spades'][Z.suit(t)]), cards: Z.plural(P[f].length, 'card') })) });
    });
    TABLEAU.forEach(function (t, n) {
      slots.push({ id: t, x: x(n), y: y2, w: cw, h: Math.max(ch, height - m.pad - y2), label: Z.describePile(TX('sol.tableau', { n: n + 1 }), ids(P[t]), P[t].length && top(P[t]).up) });
    });
    return { height: height, slots: slots, cards: cards };
  }

  var api = {
    TABLEAU: TABLEAU, FOUNDATION: FOUNDATION, SCORE: SCORE,
    blankState: blankState, newState: newState, canPick: canPick, legalMove: legalMove, applyMove: applyMove, drawStock: drawStock,
    bestMove: bestMove, isWon: isWon, canAutoFinish: canAutoFinish, autoFinishStep: autoFinishStep,
    timeBonus: timeBonus, almostWon: almostWon, why: why, place: place
  };
  root.ZimiSolitaire = api;

  // ── The page ────────────────────────────────────────────────────────────
  var AUTO_STEP_MS = 120;
  function boot() {
    var page, session, drawN = Z.store.get(DRAW_KEY, 1) === 3 ? 3 : 1;

    // Watch and learn: the computer plays the hand by explain-solitaire.js's rules, one step at a time.
    var watch = null, watchWaiting = false, watchCtx = null, watchDraw = 0;
    function watchDrive() {
      var st = session.state, mine = watch;
      if (isWon(st)) { mine.finish(TX('sol.watchWon')); return; }
      var step = root.ZimiExplain.solitaire(api, Z, st, watchCtx);
      if (!step) { mine.finish(TX('sol.watchStuck')); return; }
      watchWaiting = true;
      mine.offer(step.text, function () { watchWaiting = false; if (watch !== mine) return; session.follow(step.next); watchDrive(); });
    }
    function autoFinish() {
      var step = autoFinishStep(session.state);
      if (!step) return;
      session.later(function () {
        var cur = session.state, st = autoFinishStep(cur);
        if (!st) return;
        session.follow(applyMove(cur, st.from, st.idx, st.to));
        if (isWon(session.state)) session.win(); else autoFinish();
      }, AUTO_STEP_MS);
    }
    function newGame() {
      session.reset(newState(Z.shuffled(Math.random), drawN));
      drawN = session.state.draw === 3 ? 3 : 1;   // a game taken up again keeps the draw it was dealt with
    }

    page = Z.solitairePage({
      rules: api, id: 'solitaire', saveOff: function () { return !!watch; }, blocked: function () { return !!watch; },
      place: place, cols: COLS, newGame: newGame, stock: drawStock, afterStock: false, why: why,
      refuse: function () { page.note(TX('sol.why.stockEmpty')); },
      drew: function (before, after) {
        if (after.passes === before.passes) return;
        var lost = before.score - after.score;
        page.note(lost > 0 ? TX('sol.recycledCost', { points: Z.plural(lost, 'point') }) : TX('sol.recycled'));
      },
      after: function (st) { if (canAutoFinish(st)) autoFinish(); },
      statText: function (sec, st) { return Z.fmtTime(sec) + ' · ' + st.score; },
      cascadeOrder: function (st) {
        var order = [], r;
        for (r = Z.KING; r >= 1; r--) FOUNDATION.forEach(function (f) { order.push({ id: st.piles[f][r - 1].id }); });
        return order;
      },
      winLines: function (sec, st) { return [TX('sol.winScore', { score: st.score, bonus: timeBonus(sec), total: st.score + timeBonus(sec) }), Z.winTime(sec, st)]; },
      openMenu: function () {
        var drawPick = Z.segmented([{ label: TX('sol.draw', { n: 1 }), value: 1 }, { label: TX('sol.draw', { n: 3 }), value: 3 }], drawN, function (v) {
          drawN = v; Z.store.set(DRAW_KEY, v);
          if (!session.state.moves) newGame();
        });
        page.menu('Solitaire', [Z.h('div', { class: 'zc-row' }, [Z.h('label', { text: TX('sol.cardsDrawn') }), drawPick]), Z.h('p', { class: 'zc-note', text: TX('sol.nextDeal') })]);
      }
    });
    session = page.session;
    if (root.ZimiShell) root.ZimiShell.game({
      watch: {
        script: 'explain-solitaire.js', unit: 'step',
        start: function (ctl) {
          watchDraw = drawN; drawN = 1; watch = ctl; watchCtx = {}; newGame();
          ctl.say(TX('sol.watchIntro'));
          watchDrive();
        },
        stop: function (kind) {
          var waiting = watchWaiting; watch = null; watchWaiting = false; drawN = watchDraw;
          if (kind === 'takeover') { if (!waiting) return; }
          else if (kind === 'stop') newGame();
        }
      }
    });
    page.start(null, function () { return almostWon(drawN); });
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
