/* ZimiGames: what the tableau solitaires after Klondike share (Yukon, Forty Thieves, Canfield, Scorpion, Beleaguered Castle,
   Eight Off): the rules of a game written as a few small facts (what builds on what, what may be picked up, what fills an
   empty column), the layout of a row of stock, waste, cells and foundations over fanned columns, and the page. A game is a
   file of those facts; the moves, the tap, the hint of why not, the stuck sheet and the win are written here once.
   Our own code, GPL-3.0. No network, no modules.

   State: piles { name: [{ id, up }] }, moves. Card ids past 51 are the second deck's copies (ZimiCards treats id % 52 as the face).

   A game's facts S:
     tableau, foundation   pile names; cells, stock, waste, reserve   optional pile names
     runOK(ids)            the cards from a tapped card down may move together
     builds(upper, lower)  lower may sit on upper in a column
     emptyOK(id)           a card may start an empty column (default: any)
     fits(id, topId, n)    a foundation (top card id or null, its size) takes the card (default: same suit, one up from the ace)
     canDrop(state, from, to)   false when a card may never go from that pile to that one (Calculation's waste piles take only the deck)
     limit(state, to, n)   most cards that may move to a column (default: no limit)
     draw(state)           the next state after a turn of the stock, or null
     settle(state)         what follows every move by itself (Canfield fills a gap from the reserve)
     winCount              cards in a finished foundation (default 13) */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, TX = root.ZimiCards.T;

  var SUIT_KEYS = ['clubs', 'diamonds', 'hearts', 'spades'];
  var DOWN_RATIO = 0.54, MAX_DOWN_RATIO = 1, DOWN_RATIO_STEP = 0.05, UP_STEP_SHARE = Z.FAN_UP_SHARE, MIN_STEP_SHARE = 0.12;
  var ROW_GAP_SHARE = 0.12, WASTE_FAN_SHARE = 0.3, AUTO_STEP_MS = 120, SHOWN_STACK = 2;

  var top = function (pile) { return pile[pile.length - 1]; };
  var card = function (id, up) { return { id: id, up: up }; };
  var ids = Z.idsOf;
  function suitName(id) { return TX('cards.suit.' + SUIT_KEYS[Z.suit(id)]); }

  // The ids of `decks` decks, shuffled by rng.
  function shuffledDecks(decks, rng) {
    var a = [], i, j, t;
    for (i = 0; i < decks * Z.DECK; i++) a.push(i);
    for (i = a.length - 1; i > 0; i--) { j = Math.floor(rng() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function blankState(names) {
    var piles = {};
    names.forEach(function (p) { piles[p] = []; });
    return { piles: piles, moves: 0 };
  }

  // ── Rules ───────────────────────────────────────────────────────────────
  function rules(S) {
    var cells = S.cells || [], winCount = S.winCount || Z.KING, emptyOK = S.emptyOK || function () { return true; };
    var fits = S.fits || Z.foundationAccepts;
    var kind = function (p) {
      return S.foundation.indexOf(p) >= 0 ? 'foundation' : S.tableau.indexOf(p) >= 0 ? 'tableau' : cells.indexOf(p) >= 0 ? 'cell' : p;
    };
    var isTableau = function (p) { return S.tableau.indexOf(p) >= 0; };
    var sources = S.tableau.concat(cells, S.waste ? [S.waste] : [], S.reserve ? [S.reserve] : []);

    function canPick(state, pile, idx) {
      var p = state.piles[pile], k = kind(pile);
      if (!p || idx < 0 || idx >= p.length || !p[idx].up || k === 'stock') return false;
      if (k === 'tableau') return S.runOK(ids(p.slice(idx)));
      if (k === 'foundation' && S.takeFoundation === false) return false;
      return idx === p.length - 1;
    }
    function legalMove(state, from, idx, to) {
      if (from === to || !canPick(state, from, idx) || (S.canDrop && !S.canDrop(state, from, to))) return false;
      var P = state.piles, moving = P[from].slice(idx), first = moving[0].id, dest = P[to], k = kind(to);
      if (k === 'foundation') return moving.length === 1 && fits(first, dest.length ? top(dest).id : null, dest.length, state, to);
      if (k === 'cell') return moving.length === 1 && !dest.length && kind(from) !== 'cell';
      if (k !== 'tableau') return false;
      if (S.limit && moving.length > S.limit(state, to)) return false;
      return dest.length ? S.builds(top(dest).id, first) : emptyOK(first, state, to);
    }
    function applyMove(state, from, idx, to) {
      var s = Z.clone(state), src = s.piles[from];
      s.piles[to] = s.piles[to].concat(src.splice(idx));
      if (src.length && !top(src).up) top(src).up = true;
      s.moves++;
      if (S.settle) S.settle(s, from, to);
      return s;
    }

    // Where a tap sends a card: a foundation (its own suit's pile first), a column with cards, an empty column (never to move a
    // column's own bottom card), then a free cell.
    function bestMove(state, from, idx) {
      if (!canPick(state, from, idx)) return null;
      var P = state.piles, first = P[from][idx].id, targets = [];
      if (kind(from) !== 'foundation') {
        targets = S.foundation.filter(function (f) { return P[f].length && Z.suit(top(P[f]).id) === Z.suit(first); })
          .concat(S.foundation.filter(function (f) { return !P[f].length; }));
      }
      targets = targets.concat(S.tableau.filter(function (t) { return P[t].length; }));
      if (!(isTableau(from) && idx === 0)) targets = targets.concat(S.tableau.filter(function (t) { return !P[t].length; }));
      if (P[from].length - idx === 1 && kind(from) !== 'cell') targets = targets.concat(cells);
      for (var i = 0; i < targets.length; i++) if (legalMove(state, from, idx, targets[i])) return targets[i];
      return null;
    }

    // Any move on the board: a card to a pile that takes it. A column's bottom card to an empty column only shuffles, and a card
    // taken back off a foundation is not a way forward.
    function boardMove(state) {
      var P = state.piles, to = S.foundation.concat(S.tableau, cells), i, j, k;
      for (i = 0; i < sources.length; i++) {
        for (j = 0; j < P[sources[i]].length; j++) for (k = 0; k < to.length; k++) {
          if (j === 0 && isTableau(sources[i]) && isTableau(to[k]) && !P[to[k]].length) continue;
          if (legalMove(state, sources[i], j, to[k])) return true;
        }
      }
      return false;
    }
    // With a stock, the cards it can still turn up are tried too (a pass that repeats itself ends the search).
    function hasMove(state) {
      var s = state, seen = {}, key;
      while (s) {
        if (boardMove(s)) return true;
        if (!S.draw) return false;
        key = ids(s.piles[S.stock]).join() + '|' + (S.waste ? ids(s.piles[S.waste]).join() : '');
        if (seen[key]) return false;
        seen[key] = true;
        s = S.draw(s);
      }
      return false;
    }
    var isWon = S.isWon || function (state) { return S.foundation.every(function (f) { return state.piles[f].length === winCount; }); };

    // Nothing face down and nothing left to turn: the rest is a formality.
    function canAutoFinish(state) {
      return (!S.stock || !state.piles[S.stock].length) && S.tableau.every(function (t) { return state.piles[t].every(function (c) { return c.up; }); });
    }
    function autoFinishStep(state) {
      var i, j, p;
      for (i = 0; i < sources.length; i++) {
        p = state.piles[sources[i]];
        if (!p.length) continue;
        for (j = 0; j < S.foundation.length; j++) if (legalMove(state, sources[i], p.length - 1, S.foundation[j])) return { from: sources[i], idx: p.length - 1, to: S.foundation[j] };
      }
      return null;
    }

    // The words for a card that would not go: a tap that had nowhere to send it (no `to`), or a drop on a pile that refused it.
    function why(state, pile, idx, to) {
      var P = state.piles, c = P[pile] && P[pile][idx];
      if (!c) return null;
      if (!c.up) return TX('sol.why.facedown');
      if (!canPick(state, pile, idx)) return TX(kind(pile) === 'tableau' && S.whyPick || 'sol.why.nowhere');
      if (to === undefined) return TX('sol.why.nowhere');
      var k = kind(to);
      if (k === 'foundation') {
        if (P[pile].length - idx > 1) return TX('sol.why.oneCard');
        return typeof S.whyFoundation === 'function' ? S.whyFoundation(state, to) : TX(S.whyFoundation || 'sol.why.foundation');
      }
      if (k === 'cell') return TX(P[to].length ? 'fc.why.cells' : 'fc.why.cell');
      if (k === 'tableau') {
        if (S.limit && P[pile].length - idx > S.limit(state, to)) return TX(S.whyLimit || 'sol.why.single');
        return TX(P[to].length ? S.whyBuild : S.whyEmpty);
      }
      return null;
    }

    return { S: S, TABLEAU: S.tableau, FOUNDATION: S.foundation, canPick: canPick, legalMove: legalMove, applyMove: applyMove, bestMove: bestMove,
      hasMove: hasMove, boardMove: boardMove, isWon: isWon, canAutoFinish: canAutoFinish, autoFinishStep: autoFinishStep, why: why, kind: kind };
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  // L.topRows rows of stock, waste, cells and foundations under the bar, then the columns. Each item of L.items:
  //   { pile, kind: stock|waste|foundation|cell|column|reserve, col, row, shown (a waste's fanned cards), mark (an empty foundation's letter) }
  // A column or a reserve fans down from its row (row === L.topRows is the columns' row).
  function layout(L) {
    var topRows = L.topRows || 1;
    return function place(state, m) {
      var P = state.piles, cw = m.cw, ch = m.ch, x = function (col) { return m.left + col * m.step; };
      var base = Z.solitaireRows(m), rowStep = Math.round(ch * (1 + ROW_GAP_SHARE)), extra = (topRows - 1) * rowStep;
      var y = function (row) { return row < topRows ? base.top + row * rowStep : base.cols + extra; };
      var room = base.room - extra, slots = [], cards = [], bottom = y(topRows) + ch;
      var columns = L.items.filter(function (it) { return it.kind === 'column' || it.kind === 'reserve'; });
      var weight = function (pile, down) {
        var w = 0;
        for (var i = 0; i < pile.length - 1; i++) w += pile[i].up ? 1 : down;
        return w;
      };
      var heaviest = function (down) { return Math.max.apply(null, columns.map(function (it) { return weight(P[it.pile], down); })); };
      var down = Z.openDown(heaviest, room, ch, ch * UP_STEP_SHARE, DOWN_RATIO, MAX_DOWN_RATIO, DOWN_RATIO_STEP);
      var step = Z.fanStep(heaviest(down), room, ch, ch * UP_STEP_SHARE, ch * MIN_STEP_SHARE);
      var fan = cw * WASTE_FAN_SHARE;
      var frames = [];

      L.items.forEach(function (it) {
        var p = P[it.pile], px = x(it.col), py = y(it.row || 0), n = p.length, tc = n ? top(p).id : null, label;
        if (it.kind === 'column' || it.kind === 'reserve') {
          var yy = py;
          p.forEach(function (c, i) {
            cards.push({ id: c.id, pile: it.pile, idx: i, x: px, y: yy, up: c.up });
            if (i < n - 1) yy += c.up ? step : step * down;
          });
          bottom = Math.max(bottom, yy + ch);
          frames.push({ it: it, x: px, y: py });
          return;
        }
        if (it.kind === 'waste') {
          var shown = Math.min(it.shown || 1, n);
          p.forEach(function (c, i) {
            var k = i - (n - shown), seen = k >= 0;
            cards.push({ id: c.id, pile: it.pile, idx: i, x: px + (seen ? k * fan : 0), y: py, up: true, hidden: !seen });
          });
          slots.push({ id: it.pile, x: px, y: py, w: cw + fan * ((it.shown || 1) - 1), h: ch, label: Z.describePile(TX(it.label || 'sol.waste'), ids(p), true) });
          return;
        }
        p.forEach(function (c, i) { cards.push({ id: c.id, pile: it.pile, idx: i, x: px, y: py, up: it.kind !== 'stock' && c.up !== false, hidden: it.kind === 'cell' ? false : i < n - SHOWN_STACK }); });
        if (it.kind === 'stock') {
          slots.push({ id: it.pile, x: px, y: py, w: cw, h: ch, mark: n ? '' : (it.mark || ''), label: Z.describePile(TX('sol.stock'), ids(p), false) + (n ? TX('sol.enterDraw') : '') });
        } else if (it.kind === 'cell') {
          slots.push({ id: it.pile, x: px, y: py, w: cw, h: ch, label: n ? TX('fc.cell', { n: it.n, card: Z.cardName(tc) }) : TX('fc.cellEmpty', { n: it.n }) });
        } else {
          slots.push({ id: it.pile, x: px, y: py, w: cw, h: ch, goal: true, mark: n ? '' : (typeof it.mark === 'function' ? it.mark(state) : it.mark || 'A'),
            label: it.label ? TX(it.label, { n: it.n, cards: Z.plural(n, 'card') }) : n ? TX('sol.foundation', { suit: suitName(tc), cards: Z.plural(n, 'card') }) : TX('sol.foundationEmpty') });
        }
      });
      var height = Math.max(bottom + m.pad, m.H);
      frames.forEach(function (f) {
        var it = f.it, p = P[it.pile];
        slots.push({ id: it.pile, x: f.x, y: f.y, w: cw, h: Math.max(ch, height - m.pad - f.y),
          label: Z.describePile(it.kind === 'reserve' ? TX('sol.reserve') : TX(it.label || 'sol.tableau', { n: it.n }), ids(p), p.length && top(p).up) });
      });
      return { height: height, slots: slots, cards: cards };
    };
  }

  // ── The page ────────────────────────────────────────────────────────────
  // o: { rules, id, title, cols, heightShare, place, deal (-> a state), draw (a turn of the stock), refuse (words), auto (finish by itself),
  //      almostWon, cascade (state -> [{ id }]), options (menu rows), onDealt }
  function page(o) {
    var R = o.rules, S = R.S, pg, session;
    function autoFinish() {
      if (!o.auto || !R.canAutoFinish(session.state) || !R.autoFinishStep(session.state)) return;
      session.later(function () {
        var cur = session.state, st = R.autoFinishStep(cur);
        if (!st) return;
        session.follow(R.applyMove(cur, st.from, st.idx, st.to));
        if (R.isWon(session.state)) session.win(); else autoFinish();
      }, AUTO_STEP_MS);
    }
    var cfg = {
      rules: R, id: o.id, place: o.place, cols: o.cols, heightShare: o.heightShare, why: R.why,
      newGame: function () { session.reset(o.deal()); if (o.onDealt) o.onDealt(session.state); },
      stuck: Z.stuckWhen(R, R.hasMove),
      after: autoFinish,
      statText: function (sec, st) { return Z.fmtTime(sec) + ' · ' + (o.score ? o.score(st) : st.moves); },
      cascadeOrder: o.cascade || function (st) {
        var order = [], r;
        for (r = Z.KING; r >= 1; r--) S.foundation.forEach(function (f) { if (st.piles[f][r - 1]) order.push({ id: st.piles[f][r - 1].id }); });
        return order;
      },
      winLines: function (sec, st) { return [Z.winTime(sec, st)]; },
      openMenu: function () { pg.menu(o.title, o.options ? o.options() : []); }
    };
    if (S.draw) {
      cfg.stock = S.draw; cfg.afterStock = false;
      cfg.refuse = function () { pg.note(TX(o.refuse || 'sol.why.stockEmpty')); };
    }
    pg = Z.solitairePage(cfg);
    session = pg.session;
    pg.start(null, o.almostWon);
    return pg;
  }

  // A state one move from a win: every foundation full but for the last king, which waits at the first column.
  function almostWon(R, blank) {
    var S = R.S, s = blank(), n = S.foundation.length, k, r, id;
    for (k = 0; k < n; k++) for (r = 1; r <= Z.KING; r++) {
      id = Math.floor(k / 4) * Z.DECK + Z.make(r, k % 4);
      if (k === n - 1 && r === Z.KING) s.piles[S.tableau[0]].push(card(id, true)); else s.piles[S.foundation[k]].push(card(id, true));
    }
    return s;
  }

  root.ZimiSolKit = { rules: rules, layout: layout, page: page, almostWon: almostWon, shuffledDecks: shuffledDecks, blankState: blankState, top: top, card: card, suitName: suitName };
})(typeof globalThis !== 'undefined' ? globalThis : window);
