/* ZimiGames: Gomoku (15 by 15, five or more in a line wins: freestyle). Our own code, GPL-3.0.
   The rules and the computer (pure functions, testable in node), then the page. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var N = 15, SIZE = 225, WIN_SCORE = 1000000;
  var DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
  var LEVELS = { easy: { noise: 0.9, block: 0.6 }, medium: { noise: 0.15, block: 1 }, hard: { depth: 4, width: 8 } };

  function empty() { return new Int8Array(SIZE); }
  function inside(r, c) { return r >= 0 && r < N && c >= 0 && c < N; }
  // The line of five or more through idx (its squares), or null.
  function lineThrough(b, idx) {
    var p = b[idx], r0 = (idx / N) | 0, c0 = idx % N;
    if (!p) return null;
    for (var d = 0; d < 4; d++) {
      var dr = DIRS[d][0], dc = DIRS[d][1], line = [idx], r = r0 + dr, c = c0 + dc;
      while (inside(r, c) && b[r * N + c] === p) { line.push(r * N + c); r += dr; c += dc; }
      r = r0 - dr; c = c0 - dc;
      while (inside(r, c) && b[r * N + c] === p) { line.push(r * N + c); r -= dr; c -= dc; }
      if (line.length >= 5) return line;
    }
    return null;
  }
  function isFull(b) { for (var i = 0; i < SIZE; i++) if (!b[i]) return false; return true; }

  // ── the computer ─────────────────────────────────────────────────────────
  // Every window of five crossings in a line. A window with stones of one colour only is worth
  // more the more it holds; that one table scores a whole board and a single move alike.
  var WINDOWS = (function () {
    var w = [];
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) for (var d = 0; d < 4; d++) {
      var er = r + 4 * DIRS[d][0], ec = c + 4 * DIRS[d][1];
      if (!inside(er, ec)) continue;
      var sq = []; for (var k = 0; k < 5; k++) sq.push((r + k * DIRS[d][0]) * N + c + k * DIRS[d][1]);
      w.push(sq);
    }
    return w;
  })();
  var WINDOWS_AT = (function () {
    var at = []; for (var i = 0; i < SIZE; i++) at.push([]);
    WINDOWS.forEach(function (w) { w.forEach(function (i) { at[i].push(w); }); });
    return at;
  })();
  var T = [0, 1, 12, 150, 2500, 1000000];

  function windowSum(b, w, p) {
    var m = 0, y = 0;
    for (var k = 0; k < 5; k++) { var v = b[w[k]]; if (v === p) m++; else if (v) y++; }
    return y ? 0 : T[m];
  }
  // What p gains by playing idx (own windows) plus what it denies the other side.
  function moveScore(b, p, idx) {
    var q = 3 - p, a = 0, d = 0, ws = WINDOWS_AT[idx];
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i], m = 0, y = 0;
      for (var k = 0; k < 5; k++) { var v = b[w[k]]; if (v === p) m++; else if (v === q) y++; }
      if (!y) a += T[m + 1] - T[m];
      if (!m) d += T[y + 1] - T[y];
    }
    return a + d * 0.95;
  }
  function evaluate(b, me) {
    var s = 0, you = 3 - me;
    for (var i = 0; i < WINDOWS.length; i++) s += windowSum(b, WINDOWS[i], me) - windowSum(b, WINDOWS[i], you) * 1.05;
    return s;
  }
  // Empty crossings within two steps of a stone: the only places worth a look.
  function candidates(b) {
    var seen = new Uint8Array(SIZE), out = [], any = false;
    for (var i = 0; i < SIZE; i++) {
      if (!b[i]) continue;
      any = true;
      var r0 = (i / N) | 0, c0 = i % N;
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
        var r = r0 + dr, c = c0 + dc;
        if (inside(r, c) && !b[r * N + c] && !seen[r * N + c]) { seen[r * N + c] = 1; out.push(r * N + c); }
      }
    }
    return any ? out : [(N >> 1) * N + (N >> 1)];
  }
  function wins(b, p, idx) { b[idx] = p; var l = lineThrough(b, idx); b[idx] = 0; return !!l; }
  function ranked(b, p, limit) {
    var c = candidates(b).map(function (i) { return { idx: i, s: moveScore(b, p, i) }; });
    c.sort(function (x, y) { return y.s - x.s; });
    return limit ? c.slice(0, limit) : c;
  }
  function negamax(b, p, depth, alpha, beta, width) {
    var cs = ranked(b, p, width), best = -Infinity;
    if (!cs.length) return 0;
    for (var i = 0; i < cs.length; i++) {
      var idx = cs[i].idx, s;
      b[idx] = p;
      if (lineThrough(b, idx)) s = WIN_SCORE + depth;
      else if (depth <= 1) s = evaluate(b, p);
      else s = -negamax(b, 3 - p, depth - 1, -beta, -alpha, width);
      b[idx] = 0;
      if (s > best) best = s;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  // The computer's crossing at a level. Medium and hard always take a win and stop a four.
  function chooseMove(b, p, level, rng) {
    var cfg = LEVELS[level] || LEVELS.medium, rand = rng || Math.random, q = 3 - p, i;
    var cs = candidates(b);
    if (cs.length === 1 && !b[cs[0]] && cs[0] === (N >> 1) * N + (N >> 1)) return cs[0];
    for (i = 0; i < cs.length; i++) if (wins(b, p, cs[i])) return cs[i];
    if (cfg.block === undefined || rand() < cfg.block) for (i = 0; i < cs.length; i++) if (wins(b, q, cs[i])) return cs[i];
    var r = ranked(b, p, cfg.depth ? cfg.width : 0);
    if (!r.length) return -1;
    if (!cfg.depth) {
      var best = -Infinity, pick = r[0].idx;
      r.forEach(function (x) { var s = x.s * (1 + (rand() - 0.5) * 2 * cfg.noise); if (s > best) { best = s; pick = x.idx; } });
      return pick;
    }
    var bestIdx = r[0].idx, bestS = -Infinity;
    for (i = 0; i < r.length; i++) {
      b[r[i].idx] = p;
      var s = -negamax(b, q, cfg.depth - 1, -Infinity, Infinity, cfg.width);
      b[r[i].idx] = 0;
      if (s > bestS) { bestS = s; bestIdx = r[i].idx; }
    }
    return bestIdx;
  }

  root.GomokuEngine = { N: N, LEVELS: LEVELS, empty: empty, lineThrough: lineThrough, isFull: isFull, chooseMove: chooseMove, evaluate: evaluate, moveScore: moveScore };

  // ── the page ─────────────────────────────────────────────────────────────
  if (typeof document === 'undefined' || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, CELL = 32, PAD = 22, W = (N - 1) * CELL + 2 * PAD;
  function sideName(p) { return UI.side(p === 0 ? 'black' : 'white'); }
  var host = document.getElementById('wk-board'), stonesG, marksG, btns = [];
  var state, history = WK.History(), last = -1, winLine = null, hintIdx = -1;
  var score = WK.scoreBar(document.getElementById('wk-score'), [{ color: 'var(--disc-b)' }, { color: 'var(--disc-w)' }]);
  var G = WK.create({ id: 'gomoku', options: WK.standardOptions({ first: 'go.side.blackFirst', second: 'board.white' }), onNew: newGame, onUndo: undo, onHint: hint });

  function xy(i) { return { x: PAD + (i % N) * CELL, y: PAD + ((i / N) | 0) * CELL }; }
  function coord(i) { return 'ABCDEFGHJKLMNOP'[i % N] + (N - ((i / N) | 0)); }

  function buildBoard() {
    var g = '';
    for (var k = 0; k < N; k++) {
      var o = PAD + k * CELL;
      g += 'M' + PAD + ' ' + o + 'H' + (W - PAD) + 'M' + o + ' ' + PAD + 'V' + (W - PAD);
    }
    var stars = '';
    [3, 7, 11].forEach(function (r) { [3, 7, 11].forEach(function (c) { stars += '<circle cx="' + (PAD + c * CELL) + '" cy="' + (PAD + r * CELL) + '" r="3.6" class="gm-star"/>'; }); });
    host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + W + '" aria-hidden="true">' + WK.STONE_DEFS +
      '<rect width="' + W + '" height="' + W + '" rx="8" class="gm-wood"/><path d="' + g + '" class="gm-grid"/>' + stars + '<g id="gm-stones"></g><g id="gm-marks"></g></svg>';
    stonesG = host.querySelector('#gm-stones'); marksG = host.querySelector('#gm-marks');
    var pts = [];
    for (var i = 0; i < SIZE; i++) { var p = xy(i); pts.push({ x: p.x, y: p.y, w: CELL }); }
    btns = WK.overlay(host, W, W, pts, onPoint, 'gm-pt');
  }

  function paint() {
    var b = state.board, s = '', m = '', i, open = !G.over && !G.thinking && G.human(state.turn);
    for (i = 0; i < SIZE; i++) {
      if (!b[i]) continue;
      var p = xy(i);
      s += '<circle cx="' + p.x + '" cy="' + (p.y + 1.5) + '" r="14.5" class="gm-shadow"/><circle cx="' + p.x + '" cy="' + p.y + '" r="14.5" fill="url(#wk-stone-' + (b[i] === 1 ? 'b' : 'w') + ')"' + (i === last && !G.reduce ? ' class="gm-new"' : '') + '/>';
    }
    if (last >= 0) { var l = xy(last); m += '<circle cx="' + l.x + '" cy="' + l.y + '" r="4.5" class="gm-last"/>'; }
    if (winLine) winLine.forEach(function (i2) { var q = xy(i2); m += '<circle cx="' + q.x + '" cy="' + q.y + '" r="18" class="gm-win"/>'; });
    if (hintIdx >= 0) { var h = xy(hintIdx); m += '<circle cx="' + h.x + '" cy="' + h.y + '" r="12" class="gm-hint"/>'; }
    stonesG.innerHTML = s; marksG.innerHTML = m;
    btns.forEach(function (bt, j) {
      bt.setAttribute('aria-label', T('go.pt', { pt: coord(j), what: T(b[j] === 1 ? 'go.pt.black' : b[j] === 2 ? 'go.pt.white' : 'go.pt.empty') }));
      bt.setAttribute('aria-disabled', (!open || b[j]) ? 'true' : 'false');
    });
    score(G.names(sideName(0), sideName(1)), null, G.over ? -1 : state.turn);
    G.setUndo(history.size() > 0); G.setHint(open);
  }

  function turnText() {
    var p = state.turn;
    if (!G.vsComputer()) return T('go.toPlay', { name: sideName(p) });
    return G.human(p) ? T('makruk.yourTurn', { side: sideName(p).toLowerCase() }) : T('shell.thinking');
  }

  function onPoint(i) {
    if (G.over || G.thinking || !G.human(state.turn)) return;
    if (state.board[i]) { G.refuse(btns[i], T('gomoku.taken')); return; }
    place(i);
  }

  function place(i) {
    history.push({ board: state.board, turn: state.turn, last: last });
    var nb = state.board.slice(0), p = state.turn + 1;
    nb[i] = p; state = { board: nb, turn: 1 - state.turn }; last = i; hintIdx = -1;
    var line = lineThrough(nb, i);
    if (line) {
      winLine = line; paint();
      var w = p - 1;
      G.finish(T('gomoku.five'), G.vsComputer() ? (G.human(w) ? 'w' : 'l') : null, sideName(w));
      return;
    }
    if (isFull(nb)) { paint(); G.finish(T('board.full'), 'd'); return; }
    paint(); G.say(turnText(), !G.human(state.turn));
    if (!G.human(state.turn)) G.later(function () { place(chooseMove(state.board.slice(0), state.turn + 1, G.settings.level)); });
  }

  function hint() {
    hintIdx = chooseMove(state.board.slice(0), state.turn + 1, 'hard');
    paint(); G.say(T('go.hint.point', { line: turnText() }));
  }

  function undo() {
    if (!history.size()) return;
    G.cancel(); G.over = false; winLine = null; hintIdx = -1;
    var h;
    do { h = history.pop(); } while (history.size() && G.vsComputer() && !G.human(h.turn));
    state = { board: h.board, turn: h.turn }; last = h.last;
    paint(); G.say(turnText());
    if (!G.human(state.turn)) G.later(function () { place(chooseMove(state.board.slice(0), state.turn + 1, G.settings.level)); });
  }

  function newGame() {
    history.clear(); winLine = null; hintIdx = -1; last = -1; G.reduce = BK.reducedMotion();
    state = { board: empty(), turn: 0 };
    paint(); G.say(turnText(), !G.human(0));
    if (!G.human(0)) G.later(function () { place(chooseMove(state.board.slice(0), 1, G.settings.level)); });
  }

  if (root.ZimiShell) root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && history.size() > 0; } });
  buildBoard();
  G.newGame();
  G.persist({
    save: function () { return history.size() ? { state: state, history: history.all(), last: last, winLine: winLine } : null; },
    load: function (d) { state = d.state; history.set(d.history); last = d.last; winLine = d.winLine; hintIdx = -1; paint(); },
    resume: function () { G.say(turnText()); if (!G.human(state.turn)) G.later(function () { place(chooseMove(state.board.slice(0), state.turn + 1, G.settings.level)); }); }
  });
  if (new URLSearchParams(location.search).has('debug')) root.__gm = { state: function () { return state; }, engine: root.GomokuEngine };
})(typeof globalThis !== 'undefined' ? globalThis : this);
