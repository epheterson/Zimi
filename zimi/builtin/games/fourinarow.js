/* ZimiGames: Four in a Row (7 by 6). Our own code, GPL-3.0. No network, no modules.
   The rules and the computer (pure functions, testable in node), then the page. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var COLS = 7, ROWS = 6, SIZE = 42, EMPTY = 0, WIN_SCORE = 100000;
  var DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
  var ORDER = [3, 2, 4, 1, 5, 0, 6]; // the middle first: better cut-offs, better play
  var LEVELS = { easy: { depth: 2, blunder: 0.3 }, medium: { depth: 5, blunder: 0 }, hard: { depth: 8, blunder: 0 } };

  function empty() { return new Int8Array(SIZE); }
  // The row a disc dropped in column c comes to rest on (row 0 is the top), or -1 when full.
  function dropRow(b, c) { for (var r = ROWS - 1; r >= 0; r--) if (b[r * COLS + c] === EMPTY) return r; return -1; }
  function legalCols(b) { var out = []; for (var i = 0; i < COLS; i++) if (b[i] === EMPTY) out.push(i); return out; }
  function drop(b, c, p) {
    var r = dropRow(b, c);
    if (r < 0) return null;
    var nb = b.slice(0); nb[r * COLS + c] = p;
    return nb;
  }
  // The line of four or more through idx, as its squares, or null.
  function lineThrough(b, idx) {
    var p = b[idx], r0 = (idx / COLS) | 0, c0 = idx % COLS;
    if (!p) return null;
    for (var d = 0; d < 4; d++) {
      var dr = DIRS[d][0], dc = DIRS[d][1], line = [idx], r = r0 + dr, c = c0 + dc;
      while (r >= 0 && r < ROWS && c >= 0 && c < COLS && b[r * COLS + c] === p) { line.push(r * COLS + c); r += dr; c += dc; }
      r = r0 - dr; c = c0 - dc;
      while (r >= 0 && r < ROWS && c >= 0 && c < COLS && b[r * COLS + c] === p) { line.push(r * COLS + c); r -= dr; c -= dc; }
      if (line.length >= 4) return line;
    }
    return null;
  }
  function isFull(b) { for (var i = 0; i < COLS; i++) if (b[i] === EMPTY) return false; return true; }

  // ── the computer ─────────────────────────────────────────────────────────
  // Every window of four squares: what each side has in it, and how many are open.
  var WINDOWS = (function () {
    var w = [];
    for (var r = 0; r < ROWS; r++) for (var c = 0; c < COLS; c++) for (var d = 0; d < 4; d++) {
      var er = r + 3 * DIRS[d][0], ec = c + 3 * DIRS[d][1];
      if (er < 0 || er >= ROWS || ec < 0 || ec >= COLS) continue;
      var sq = []; for (var k = 0; k < 4; k++) sq.push((r + k * DIRS[d][0]) * COLS + c + k * DIRS[d][1]);
      w.push(sq);
    }
    return w;
  })();
  function evaluate(b, me) {
    var you = 3 - me, s = 0, i;
    for (i = 0; i < WINDOWS.length; i++) {
      var w = WINDOWS[i], m = 0, y = 0;
      for (var k = 0; k < 4; k++) { var v = b[w[k]]; if (v === me) m++; else if (v === you) y++; }
      if (m && y) continue;
      if (m === 3) s += 6; else if (m === 2) s += 2; else if (y === 3) s -= 7; else if (y === 2) s -= 2;
    }
    for (var r = 0; r < ROWS; r++) { var v2 = b[r * COLS + 3]; if (v2 === me) s += 3; else if (v2 === you) s -= 3; }
    return s;
  }
  // Score for the side `p` to move, seen from p. `ply` makes quick wins worth more.
  function negamax(b, p, depth, alpha, beta) {
    var best = -Infinity, any = false;
    for (var i = 0; i < COLS; i++) {
      var c = ORDER[i], r = dropRow(b, c);
      if (r < 0) continue;
      any = true;
      var nb = b.slice(0); nb[r * COLS + c] = p;
      var s;
      if (lineThrough(nb, r * COLS + c)) s = WIN_SCORE + depth;
      else if (depth <= 1) s = evaluate(nb, p);
      else s = -negamax(nb, 3 - p, depth - 1, -beta, -alpha);
      if (s > best) best = s;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return any ? best : 0;
  }
  function scoreCols(b, p, depth) {
    var out = [];
    for (var i = 0; i < COLS; i++) {
      var c = ORDER[i], r = dropRow(b, c);
      if (r < 0) continue;
      var nb = b.slice(0); nb[r * COLS + c] = p;
      out.push({ col: c, score: lineThrough(nb, r * COLS + c) ? WIN_SCORE + depth : -negamax(nb, 3 - p, depth - 1, -Infinity, Infinity) });
    }
    return out;
  }
  // The computer's column at a level. A win or a block it sees at any level; easy now and then slips.
  function chooseCol(b, p, level, rng) {
    var cfg = LEVELS[level] || LEVELS.medium, rand = rng || Math.random, legal = legalCols(b);
    if (!legal.length) return -1;
    var i, nb, r;
    for (i = 0; i < legal.length; i++) { r = dropRow(b, legal[i]); nb = b.slice(0); nb[r * COLS + legal[i]] = p; if (lineThrough(nb, r * COLS + legal[i])) return legal[i]; }
    if (cfg.blunder && rand() < cfg.blunder) return legal[(rand() * legal.length) | 0];
    var scored = scoreCols(b, p, cfg.depth), best = -Infinity, pool = [];
    scored.forEach(function (x) { if (x.score > best) best = x.score; });
    scored.forEach(function (x) { if (x.score >= best - (cfg.blunder ? 4 : 0)) pool.push(x.col); });
    return pool[(rand() * pool.length) | 0];
  }

  root.FourInARowEngine = { COLS: COLS, ROWS: ROWS, LEVELS: LEVELS, empty: empty, dropRow: dropRow, drop: drop, legalCols: legalCols, lineThrough: lineThrough, isFull: isFull, chooseCol: chooseCol, evaluate: evaluate };

  // ── the page ─────────────────────────────────────────────────────────────
  if (typeof document === 'undefined' || !root.BoardUI) return;
  var WK = root.WorldKit, UI = root.BoardUI, T = UI.t, CELL = 60, PAD = 12, W = COLS * CELL + 2 * PAD, H = ROWS * CELL + 2 * PAD + 10;
  var COLORS = ['var(--fr-amber)', 'var(--fr-crimson)'];
  function sideName(p) { return T(p === 0 ? 'fourinarow.side.amber' : 'fourinarow.side.crimson'); }
  var host = document.getElementById('wk-board'), discsG, hintsG, btns = [];
  var state, history = WK.History(), last = -1, winLine = null, dropping = -1, hintCol = -1;
  var score = WK.scoreBar(document.getElementById('wk-score'), [{ color: COLORS[0] }, { color: COLORS[1] }]);

  var G = WK.create({
    id: 'fourinarow',
    options: WK.standardOptions({ first: 'fourinarow.side.amberFirst', second: 'fourinarow.side.crimson' }),
    onNew: newGame, onUndo: undo, onHint: hint
  });

  function cx(c) { return PAD + c * CELL + CELL / 2; }
  function cy(r) { return PAD + r * CELL + CELL / 2; }
  // The frame is one path with a hole cut for every cell, drawn over the discs.
  function framePath() {
    var d = 'M14 0H' + (W - 14) + 'a14 14 0 0 1 14 14V' + (H - 24) + 'a14 14 0 0 1 -14 14H14a14 14 0 0 1 -14 -14V14a14 14 0 0 1 14 -14z';
    for (var r = 0; r < ROWS; r++) for (var c = 0; c < COLS; c++) d += 'M' + (cx(c) - 25) + ' ' + cy(r) + 'a25 25 0 1 0 50 0a25 25 0 1 0 -50 0z';
    return d;
  }
  function buildBoard() {
    host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true"><g id="fr-hints"></g><g id="fr-discs"></g>' +
      '<path class="fr-frame" fill-rule="evenodd" d="' + framePath() + '"/><rect x="14" y="' + (H - 10) + '" width="' + (W - 28) + '" height="10" rx="3" class="fr-foot"/></svg>';
    discsG = host.querySelector('#fr-discs'); hintsG = host.querySelector('#fr-hints');
    var pts = [];
    for (var c = 0; c < COLS; c++) pts.push({ x: cx(c), y: H / 2, w: CELL, h: H });
    btns = WK.overlay(host, W, H, pts, playCol, 'fr-col');
  }

  function paint() {
    var b = state.board, html = '', i;
    for (i = 0; i < SIZE; i++) {
      if (!b[i]) continue;
      var r = (i / COLS) | 0, c = i % COLS, cls = 'fr-disc' + (i === dropping ? ' drop' : '') + (winLine && winLine.indexOf(i) >= 0 ? ' win' : '');
      var at = 'cx="' + cx(c) + '" cy="' + cy(r) + '"';
      html += '<g class="' + cls + '" style="--from:' + (-(r + 1) * CELL - 20) + 'px"><circle ' + at + ' r="26" style="fill:' + COLORS[b[i] - 1] + '"/><circle ' + at + ' r="17" class="fr-rim"/>' +
        (i === last ? '<circle ' + at + ' r="8" class="fr-last"/>' : '') + '</g>';
    }
    discsG.innerHTML = html;
    hintsG.innerHTML = hintCol >= 0 ? '<path class="fr-hintarrow" d="M' + (cx(hintCol) - 12) + ' 3l12 12 12 -12"/>' : '';
    var open = !G.over && !G.thinking && G.human(state.turn);
    btns.forEach(function (bt, c) {
      var full = state.board[c] !== EMPTY;
      bt.setAttribute('aria-label', full ? T('fourinarow.col.full', { c: c + 1 }) : T('fourinarow.col.free', { c: c + 1, n: dropRow(state.board, c) + 1 }));
      bt.setAttribute('aria-disabled', (!open || full) ? 'true' : 'false');
    });
    score(G.names(sideName(0), sideName(1)), null, G.over ? -1 : state.turn);
    G.setUndo(history.size() > 0); G.setHint(open);
  }

  function turnText() {
    var p = state.turn, nm = G.who(p, sideName(0), sideName(1));
    if (!G.vsComputer()) return T('go.toPlay', { name: nm });
    // German colours here are nouns and keep their capital.
    var side = document.documentElement.lang === 'de' ? sideName(p) : sideName(p).toLowerCase();
    return G.human(p) ? T('makruk.yourTurn', { side: side }) : T('shell.thinking');
  }

  // After the computer drops a disc the line says where, then whose turn it is.
  function cpuMoved(p, c) { return G.vsComputer() && !G.watching && !G.human(p) ? T('fourinarow.cpu', { c: c + 1 }) + ' ' : ''; }

  function playCol(c) {
    if (G.over || G.thinking || !G.human(state.turn)) return;
    if (!place(c)) { G.refuse(btns[c], T('fourinarow.full')); }
  }

  function place(c) {
    var r = dropRow(state.board, c);
    if (r < 0) return false;
    history.push({ board: state.board, turn: state.turn, last: last });
    var p = state.turn + 1, nb = drop(state.board, c, p), idx = r * COLS + c;
    state = { board: nb, turn: 1 - state.turn };
    last = idx; hintCol = -1; dropping = root.BoardKit.reducedMotion() ? -1 : idx;
    var line = lineThrough(nb, idx);
    if (line) {
      winLine = line; paint();
      var w = p - 1;
      G.finish(T('fourinarow.four'), G.vsComputer() ? (G.human(w) ? 'w' : 'l') : null, sideName(w));
      paint();   // the turn chip lets go once the game is over
      return true;
    }
    if (isFull(nb)) { paint(); G.finish(T('board.full'), 'd'); paint(); return true; }
    paint();
    G.say(cpuMoved(p - 1, c) + turnText(), !G.human(state.turn));
    if (!G.human(state.turn)) G.later(computerMove);
    return true;
  }

  function computerMove() {
    var c = chooseCol(state.board, state.turn + 1, G.settings.level);
    if (c >= 0) place(c);
  }

  function hint() {
    hintCol = chooseCol(state.board, state.turn + 1, 'hard');
    paint(); G.say(T('fourinarow.hint'));
  }

  function undo() {
    if (!history.size()) return;
    G.cancel(); G.over = false; winLine = null; dropping = -1; hintCol = -1;
    var h;
    do { h = history.pop(); } while (history.size() && G.vsComputer() && !G.human(h.turn));
    state = { board: h.board, turn: h.turn }; last = h.last;
    paint(); G.say(turnText(), false);
    if (!G.human(state.turn)) G.later(computerMove);
  }

  function newGame() {
    history.clear(); winLine = null; dropping = -1; hintCol = -1; last = -1;
    state = { board: empty(), turn: 0 };
    paint(); G.say(turnText(), !G.human(0));
    if (!G.human(0)) G.later(computerMove);
  }

  if (root.ZimiShell) root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && history.size() > 0; } });
  buildBoard();
  G.newGame();
  G.persist({
    save: function () { return history.size() ? { state: state, history: history.all(), last: last, winLine: winLine } : null; },
    load: function (d) { state = d.state; history.set(d.history); last = d.last; winLine = d.winLine; dropping = -1; hintCol = -1; paint(); },
    resume: function () { G.say(turnText(), !G.human(state.turn)); if (!G.human(state.turn)) G.later(computerMove); }
  });
  if (new URLSearchParams(location.search).has('debug')) root.__fr = { state: function () { return state; }, engine: root.FourInARowEngine };
})(typeof globalThis !== 'undefined' ? globalThis : this);
