/* ZimiGames: Nine Men's Morris. Our own code, GPL-3.0. Place nine men, slide them along the
   lines, three in a line (a mill) takes a man, a side down to three may fly.
   The rules and the computer (pure functions, testable in node), then the page. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  // 24 points: three rings of eight (outer 0..7, middle 8..15, inner 16..23), each ring going
  // round from its top-left corner; the odd points of a ring are the middles of its sides.
  var WIN_SCORE = 10000, QUIET_LIMIT = 60, MEN = 9;
  var LEVELS = { easy: { depth: 2, noise: 14, ms: 300 }, medium: { depth: 4, noise: 0, ms: 600 }, hard: { depth: 9, noise: 0, ms: 1200 } };
  var TIMEUP = { timeup: true };
  var XY = (function () {
    var ring = [[[0, 0], [3, 0], [6, 0], [6, 3], [6, 6], [3, 6], [0, 6], [0, 3]], [[1, 1], [3, 1], [5, 1], [5, 3], [5, 5], [3, 5], [1, 5], [1, 3]], [[2, 2], [3, 2], [4, 2], [4, 3], [4, 4], [3, 4], [2, 4], [2, 3]]], out = [];
    ring.forEach(function (r) { r.forEach(function (p) { out.push(p); }); });
    return out;
  })();
  var ADJ = (function () {
    var a = [], i;
    for (i = 0; i < 24; i++) {
      var ringN = (i / 8) | 0, k = i % 8, list = [ringN * 8 + (k + 1) % 8, ringN * 8 + (k + 7) % 8];
      if (k % 2) { if (ringN > 0) list.push(i - 8); if (ringN < 2) list.push(i + 8); }
      a.push(list);
    }
    return a;
  })();
  var MILLS = (function () {
    var m = [], r, k;
    for (r = 0; r < 3; r++) for (k = 0; k < 8; k += 2) m.push([r * 8 + k, r * 8 + (k + 1) % 8, r * 8 + (k + 2) % 8]);
    for (k = 1; k < 8; k += 2) m.push([k, 8 + k, 16 + k]);
    return m;
  })();
  var MILLS_AT = (function () {
    var at = []; for (var i = 0; i < 24; i++) at.push([]);
    MILLS.forEach(function (m) { m.forEach(function (i) { at[i].push(m); }); });
    return at;
  })();

  function newState() { return { board: new Int8Array(24), hand: [MEN, MEN], turn: 0, quiet: 0, over: false, winner: -1 }; }
  function onBoard(s, p) { var n = 0; for (var i = 0; i < 24; i++) if (s.board[i] === p + 1) n++; return n; }
  // 'place' while men are in hand, 'fly' with three left, otherwise 'move'.
  function phase(s, p) { return s.hand[p] > 0 ? 'place' : onBoard(s, p) === 3 ? 'fly' : 'move'; }
  function inMill(b, i) {
    var v = b[i], ms = MILLS_AT[i];
    for (var k = 0; k < ms.length; k++) if (b[ms[k][0]] === v && b[ms[k][1]] === v && b[ms[k][2]] === v) return true;
    return false;
  }
  // Where the man on `from` may go.
  function targets(s, from) {
    var p = s.board[from] - 1, out = [], i;
    if (phase(s, p) === 'fly') { for (i = 0; i < 24; i++) if (!s.board[i]) out.push(i); return out; }
    ADJ[from].forEach(function (j) { if (!s.board[j]) out.push(j); });
    return out;
  }
  // The first half of a turn: a man placed or slid. `mill` says whether it made a line of three.
  function partial(s, from, to) {
    var p = s.turn, board = s.board.slice(0), hand = s.hand.slice(0);
    if (from < 0) hand[p]--; else board[from] = 0;
    board[to] = p + 1;
    var t = { board: board, hand: hand, turn: p, quiet: s.quiet, over: false, winner: -1 };
    return { state: t, mill: inMill(board, to) };
  }
  // The other side's men that may be taken: those outside a mill, or all of them if every one is in a mill.
  function removable(s) {
    var q = 2 - s.turn, free = [], all = [], i; // the other side's stone value is (1 - turn) + 1
    for (i = 0; i < 24; i++) if (s.board[i] === q) { all.push(i); if (!inMill(s.board, i)) free.push(i); }
    return free.length ? free : all;
  }
  function moves(s) {
    var out = [], p = s.turn, i, to;
    var ph = phase(s, p);
    function add(from, to2) {
      var pt = partial(s, from, to2);
      if (pt.mill) removable(pt.state).forEach(function (r) { out.push({ from: from, to: to2, rem: r }); });
      else out.push({ from: from, to: to2, rem: -1 });
    }
    if (ph === 'place') { for (to = 0; to < 24; to++) if (!s.board[to]) add(-1, to); return out; }
    for (i = 0; i < 24; i++) if (s.board[i] === p + 1) targets(s, i).forEach(function (j) { add(i, j); });
    return out;
  }
  // Whether the side to move has a legal move (cheaper than listing them).
  function canMove(s) {
    if (s.hand[s.turn] > 0 || phase(s, s.turn) === 'fly') return true;
    for (var i = 0; i < 24; i++) if (s.board[i] === s.turn + 1) for (var k = 0; k < ADJ[i].length; k++) if (!s.board[ADJ[i][k]]) return true;
    return false;
  }
  // Second half of a turn: take `rem` (or -1), hand over, and see whether the game is decided.
  function finish(pt, rem, moved) {
    var s = pt.state, p = s.turn, q = 1 - p, board = s.board;
    if (rem >= 0) { board = board.slice(0); board[rem] = 0; }
    var t = { board: board, hand: s.hand, turn: q, quiet: rem >= 0 || moved === 'place' ? 0 : s.quiet + 1, over: false, winner: -1 };
    if (onBoard(t, q) + t.hand[q] < 3) { t.over = true; t.winner = p; }
    else if (!t.hand[q] && !canMove(t)) { t.over = true; t.winner = p; }
    else if (t.quiet >= QUIET_LIMIT) { t.over = true; t.winner = -1; }
    return t;
  }
  function apply(s, mv) {
    var pt = partial(s, mv.from, mv.to);
    return finish(pt, mv.rem, mv.from < 0 ? 'place' : 'move');
  }
  function key(s) { return Array.prototype.join.call(s.board, '') + s.hand.join('') + s.turn; }

  // ── the computer ─────────────────────────────────────────────────────────
  function countMills(b, v) { var n = 0; MILLS.forEach(function (m) { if (b[m[0]] === v && b[m[1]] === v && b[m[2]] === v) n++; }); return n; }
  // Two in a line with the third point empty: a threat.
  function countOpenTwos(b, v) {
    var n = 0;
    MILLS.forEach(function (m) { var c = 0, e = 0; for (var k = 0; k < 3; k++) { if (b[m[k]] === v) c++; else if (!b[m[k]]) e++; } if (c === 2 && e === 1) n++; });
    return n;
  }
  function mobility(s, p) { var n = 0; for (var i = 0; i < 24; i++) if (s.board[i] === p + 1) n += targets(s, i).length; return n; }
  function evaluate(s, me) {
    var you = 1 - me, a = me + 1, b = you + 1, v;
    v = (onBoard(s, me) + s.hand[me] - onBoard(s, you) - s.hand[you]) * 26;
    v += (countMills(s.board, a) - countMills(s.board, b)) * 6;
    v += (countOpenTwos(s.board, a) - countOpenTwos(s.board, b)) * 7;
    if (!s.hand[0] && !s.hand[1]) v += (mobility(s, me) - mobility(s, you)) * 1.6;
    return v;
  }
  var deadline = 0;
  function search(s, depth, alpha, beta, me) {
    if (deadline && Date.now() > deadline) throw TIMEUP;
    if (s.over) return s.winner < 0 ? 0 : s.winner === me ? WIN_SCORE + depth : -WIN_SCORE - depth;
    if (depth <= 0) return evaluate(s, me);
    var ms = ordered(s), best, i, v;
    if (s.turn === me) {
      best = -Infinity;
      for (i = 0; i < ms.length; i++) { v = search(apply(s, ms[i]), depth - 1, alpha, beta, me); if (v > best) best = v; if (best > alpha) alpha = best; if (alpha >= beta) break; }
    } else {
      best = Infinity;
      for (i = 0; i < ms.length; i++) { v = search(apply(s, ms[i]), depth - 1, alpha, beta, me); if (v < best) best = v; if (best < beta) beta = best; if (alpha >= beta) break; }
    }
    return best;
  }
  // Moves that take a man first: better cut-offs.
  function ordered(s) { var ms = moves(s); ms.sort(function (x, y) { return (y.rem >= 0) - (x.rem >= 0); }); return ms; }

  // Deepen one ply at a time until the time is up; the last finished depth decides.
  function chooseMove(s, level, rng) {
    var cfg = LEVELS[level] || LEVELS.medium, rand = rng || Math.random, ms = ordered(s), me = s.turn;
    if (!ms.length) return null;
    var pick = ms[0], noise = cfg.noise || 1;
    var jitter = ms.map(function () { return (rand() - 0.5) * noise; });
    deadline = Date.now() + cfg.ms;
    try {
      for (var depth = 1; depth <= cfg.depth; depth++) {
        var best = -Infinity, bestMove = ms[0], scores = [];
        for (var i = 0; i < ms.length; i++) {
          var v = search(apply(s, ms[i]), depth - 1, -Infinity, Infinity, me) + jitter[i];
          scores.push(v);
          if (v > best) { best = v; bestMove = ms[i]; }
        }
        pick = bestMove;
        // best first on the next, deeper pass: far better cut-offs
        var order = ms.map(function (m, k) { return k; }).sort(function (x, y) { return scores[y] - scores[x]; });
        ms = order.map(function (k) { return ms[k]; }); jitter = order.map(function (k) { return jitter[k]; });
        if (best >= WIN_SCORE) break;
      }
    } catch (e) { if (e !== TIMEUP) throw e; }
    deadline = 0;
    return pick;
  }

  root.MorrisEngine = { ADJ: ADJ, MILLS: MILLS, XY: XY, LEVELS: LEVELS, newState: newState, phase: phase, onBoard: onBoard, inMill: inMill, targets: targets, partial: partial, removable: removable, finish: finish, moves: moves, apply: apply, key: key, chooseMove: chooseMove, evaluate: evaluate };

  // ── the page ─────────────────────────────────────────────────────────────
  if (typeof document === 'undefined' || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, UNIT = 62, PAD = 34, SIDE = 6 * UNIT, W = SIDE + 2 * PAD, H = W + 46;
  var REPEAT_DRAW = 3;
  function sideName(p) { return UI.side(p === 0 ? 'white' : 'black'); }
  var host = document.getElementById('wk-board'), stonesG, marksG, handG, btns = [];
  var state, history = WK.History(), sel = -1, pending = null, lastFrom = -1, lastTo = -1, lastTaken = -1, hintMove = null, seen = {};
  var score = WK.scoreBar(document.getElementById('wk-score'), [{ color: 'var(--disc-w)' }, { color: 'var(--disc-b)' }]);
  var G = WK.create({ id: 'morris', options: WK.standardOptions({ first: 'chess.side.white', second: 'board.black' }), onNew: newGame, onUndo: undo, onHint: hint });

  function pxy(i) { return { x: PAD + XY[i][0] * UNIT, y: PAD + XY[i][1] * UNIT }; }
  function pname(i) { return 'abcdefg'[XY[i][0]] + (7 - XY[i][1]); }

  function buildBoard() {
    var lines = '';
    for (var r = 0; r < 3; r++) {
      var a = pxy(r * 8), c = pxy(r * 8 + 4);
      lines += 'M' + a.x + ' ' + a.y + 'H' + c.x + 'V' + c.y + 'H' + a.x + 'Z';
    }
    for (var k = 1; k < 8; k += 2) { var p0 = pxy(k), p2 = pxy(16 + k); lines += 'M' + p0.x + ' ' + p0.y + 'L' + p2.x + ' ' + p2.y; }
    var dots = '';
    for (var i = 0; i < 24; i++) { var q = pxy(i); dots += '<circle cx="' + q.x + '" cy="' + q.y + '" r="5" class="mo-node"/>'; }
    host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' + WK.STONE_DEFS + '<rect width="' + W + '" height="' + (W) + '" rx="14" class="mo-wood"/><path d="' + lines + '" class="mo-lines"/>' + dots +
      '<g id="mo-marks"></g><g id="mo-stones"></g><g id="mo-hand"></g></svg>';
    stonesG = host.querySelector('#mo-stones'); marksG = host.querySelector('#mo-marks'); handG = host.querySelector('#mo-hand');
    var pts = [];
    for (var j = 0; j < 24; j++) { var z = pxy(j); pts.push({ x: z.x, y: z.y, w: 46 }); }
    btns = WK.overlay(host, W, H, pts, onPoint, 'mo-pt');
  }

  function humanNow() { return !G.over && !G.thinking && G.human(state.turn); }

  function paint() {
    var b = state.board, s = '', m = '', i, p, legalTargets = [], removing = pending && pending.removing;
    if (sel >= 0) legalTargets = targets(state, sel);
    for (i = 0; i < 24; i++) {
      if (!b[i]) continue;
      p = pxy(i);
      s += '<circle cx="' + p.x + '" cy="' + (p.y + 2) + '" r="17" class="mo-shadow"/><circle cx="' + p.x + '" cy="' + p.y + '" r="17" fill="url(#wk-stone-' + (b[i] === 1 ? 'w' : 'b') + ')"' + (i === sel ? ' class="mo-sel"' : '') + '/>';
    }
    if (lastTo >= 0) { p = pxy(lastTo); m += '<circle cx="' + p.x + '" cy="' + p.y + '" r="22" class="mo-last"/>'; }
    if (lastFrom >= 0) { p = pxy(lastFrom); m += '<circle cx="' + p.x + '" cy="' + p.y + '" r="9" class="mo-from"/>'; }
    if (lastTaken >= 0) { p = pxy(lastTaken); m += '<circle cx="' + p.x + '" cy="' + p.y + '" r="14" class="mo-taken"/>'; }
    if (sel >= 0) legalTargets.forEach(function (j) { var q = pxy(j); m += '<circle cx="' + q.x + '" cy="' + q.y + '" r="9" class="mo-target"/>'; });
    if (removing) pending.options.forEach(function (j) { var q = pxy(j); m += '<circle cx="' + q.x + '" cy="' + q.y + '" r="22" class="mo-remove"/>'; });
    if (hintMove) { [hintMove.from, hintMove.to].forEach(function (j, k) { if (j < 0) return; var q = pxy(j); m += '<circle cx="' + q.x + '" cy="' + q.y + '" r="' + (k ? 24 : 12) + '" class="mo-hint"/>'; }); }
    stonesG.innerHTML = s; marksG.innerHTML = m;
    // the men still to be placed, in a row under the board
    var h = '';
    for (var side = 0; side < 2; side++) for (var k2 = 0; k2 < state.hand[side]; k2++) {
      var hx = side ? W - PAD - 6 - k2 * 15 : PAD + 6 + k2 * 15;
      h += '<circle cx="' + hx + '" cy="' + (W + 22) + '" r="6.5" fill="url(#wk-stone-' + (side ? 'b' : 'w') + ')" class="mo-hand"/>';
    }
    handG.innerHTML = h;
    var open = humanNow();
    btns.forEach(function (bt, j) {
      var ok = false;
      if (open) {
        if (removing) ok = pending.options.indexOf(j) >= 0;
        else if (phase(state, state.turn) === 'place') ok = !b[j];
        else ok = b[j] === state.turn + 1 || (sel >= 0 && legalTargets.indexOf(j) >= 0);
      }
      bt.setAttribute('aria-disabled', ok ? 'false' : 'true');
      var text = T('go.pt', { pt: pname(j), what: T(b[j] === 1 ? 'morris.man.white' : b[j] === 2 ? 'morris.man.black' : 'go.pt.empty') });
      if (sel === j) text = T('chess.sq.selected', { label: text });
      if (removing && pending.options.indexOf(j) >= 0) text = T('morris.canTake', { label: text });
      bt.setAttribute('aria-label', text);
    });
    score(G.names(sideName(0), sideName(1)), [onBoard(state, 0) + state.hand[0], onBoard(state, 1) + state.hand[1]], G.over ? -1 : state.turn);
    G.setUndo(history.size() > 0); G.setHint(humanNow() && !removing);
  }

  function turnText() {
    var p = state.turn, nm = sideName(p), ph = phase(state, p), you = G.vsComputer() && G.human(p);
    if (G.vsComputer() && !you) return T('shell.thinking');
    var lead = G.vsComputer() ? T('board.yourTurn') : T('go.toPlay', { name: nm });
    if (pending && pending.removing) return T('morris.mill');
    if (ph === 'place') return T('morris.place', { lead: lead, n: state.hand[p] });
    if (ph === 'fly') return T('morris.fly', { lead: lead });
    return T('morris.slide', { lead: lead });
  }

  function onPoint(i) {
    if (!humanNow()) return;
    if (pending && pending.removing) {
      if (pending.options.indexOf(i) < 0) { G.refuse(btns[i], T('morris.pickMarked')); return; }
      commit(pending.pt, i, pending.kind); return;
    }
    var p = state.turn, ph = phase(state, p), b = state.board;
    if (ph === 'place') { if (b[i]) G.refuse(btns[i], T('gomoku.taken')); else step(-1, i); return; }
    if (b[i] === p + 1) { sel = sel === i ? -1 : i; hintMove = null; paint(); if (sel >= 0 && !targets(state, i).length) { sel = -1; paint(); G.refuse(btns[i], T('morris.cantMove')); return; } G.say(sel >= 0 ? T('morris.chooseWhere') : turnText()); return; }
    if (sel < 0) return;
    if (targets(state, sel).indexOf(i) >= 0) step(sel, i);
    else G.refuse(btns[i], T('morris.notThere'));
  }

  // A man placed or slid by a person: if it makes a mill, wait for the man to take.
  function step(from, to) {
    var pt = partial(state, from, to);
    sel = -1; hintMove = null;
    if (pt.mill) {
      history.push(snapshot());
      pending = { pt: pt, kind: from < 0 ? 'place' : 'move', removing: true, options: removable(pt.state), from: from, to: to };
      lastFrom = from; lastTo = to; lastTaken = -1;
      state = { board: pt.state.board, hand: pt.state.hand, turn: state.turn, quiet: state.quiet, over: false, winner: -1 };
      paint(); G.say(turnText());
      return;
    }
    history.push(snapshot());
    commit(pt, -1, from < 0 ? 'place' : 'move', from, to);
  }

  function snapshot() { return { state: state, from: lastFrom, to: lastTo, taken: lastTaken }; }

  function commit(pt, rem, kind, from, to) {
    if (pending) { from = pending.from; to = pending.to; pending = null; }
    var t = finish(pt, rem, kind);
    lastFrom = from; lastTo = to; lastTaken = rem; sel = -1; hintMove = null;
    state = t;
    afterTurn(rem >= 0);
  }

  function afterTurn(took) {
    var k = key(state); seen[k] = (seen[k] || 0) + 1;
    var who = state.turn === 1 ? 0 : 1; // the side that just moved
    var note = took ? T('morris.took', { name: G.vsComputer() ? (G.human(who) ? T('board.you') : T('board.zimi')) : sideName(who) }) : '';
    if (state.over) { paint(); finishGame(); return; }
    if (seen[k] >= REPEAT_DRAW) { paint(); G.finish(T('xiangqi.why.repetition'), 'd'); return; }
    paint(); G.say(note ? UI.noted(note, turnText()) : turnText(), !G.human(state.turn));
    if (!G.human(state.turn)) G.later(computerMove);
  }

  function computerMove() {
    var mv = chooseMove(state, G.settings.level);
    if (!mv) return;
    history.push(snapshot());
    var from = mv.from, to = mv.to;
    state = apply(state, mv);
    lastFrom = from; lastTo = to; lastTaken = mv.rem; sel = -1; hintMove = null; pending = null;
    afterTurn(mv.rem >= 0);
  }

  function finishGame() {
    var w = state.winner;
    if (w < 0) { G.finish(T('morris.why.sixty'), 'd'); return; }
    var two = onBoard(state, 1 - w) + state.hand[1 - w] < 3, you = G.vsComputer() && !G.human(w);
    var msg = T((two ? 'morris.why.two' : 'morris.why.blocked') + (you ? '.you' : ''), { side: G.vsComputer() ? T('board.zimi') : sideName(1 - w) });
    G.finish(msg, G.vsComputer() ? (G.human(w) ? 'w' : 'l') : null, sideName(w));
  }

  function hint() {
    hintMove = chooseMove(state, 'hard');
    paint(); G.say(T('morris.hint'));
  }

  function undo() {
    if (!history.size()) return;
    G.cancel(); G.over = false; pending = null; sel = -1; hintMove = null;
    var h;
    do { h = history.pop(); } while (history.size() && G.vsComputer() && !G.human(h.state.turn));
    state = h.state; lastFrom = h.from; lastTo = h.to; lastTaken = h.taken;
    paint(); G.say(turnText());
    if (!G.human(state.turn)) G.later(computerMove);
  }

  function newGame() {
    history.clear(); pending = null; sel = -1; lastFrom = lastTo = lastTaken = -1; hintMove = null; seen = {};
    state = newState();
    paint(); G.say(turnText(), !G.human(0));
    if (!G.human(0)) G.later(computerMove);
  }

  if (root.ZimiShell) root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && history.size() > 0; } });
  buildBoard();
  G.newGame();
  G.persist({
    save: function () { return history.size() ? { state: state, history: history.all(), sel: sel, pending: pending, lastFrom: lastFrom, lastTo: lastTo, lastTaken: lastTaken, seen: seen } : null; },
    load: function (d) { state = d.state; history.set(d.history); sel = d.sel; pending = d.pending; lastFrom = d.lastFrom; lastTo = d.lastTo; lastTaken = d.lastTaken; seen = d.seen; hintMove = null; paint(); },
    resume: function () { G.say(turnText()); if (!G.human(state.turn)) G.later(computerMove); }
  });
  if (new URLSearchParams(location.search).has('debug')) root.__mo = { state: function () { return state; }, engine: root.MorrisEngine, pending: function () { return pending; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
