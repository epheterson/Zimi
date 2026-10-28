/* ZimiGames: Hex (7, 9 or 11 a side; 11 is the classic board). Our own code, GPL-3.0.
   Red links the upper right and lower left edges, Blue the upper left and lower right (the board stands on its long diagonal). The rules and the computer (pure
   functions, testable in node), then the page. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var RED = 1, BLUE = 2, INF = 999;
  var LEVELS = { easy: { top: 6 }, medium: { top: 1 }, hard: { depth: 3, width: 7 } };
  var NB_CACHE = {};

  // A cell's neighbours on the rhombus: left, right, the two above, the two below.
  function neighbors(n) {
    if (NB_CACHE[n]) return NB_CACHE[n];
    var out = [];
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      var list = [], d = [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, -1], [1, 0]];
      d.forEach(function (x) { var rr = r + x[0], cc = c + x[1]; if (rr >= 0 && rr < n && cc >= 0 && cc < n) list.push(rr * n + cc); });
      out.push(list);
    }
    return (NB_CACHE[n] = out);
  }
  function empty(n) { return new Int8Array(n * n); }
  function isTarget(n, p, i) { return p === RED ? i >= n * (n - 1) : i % n === n - 1; }

  // The winner's chain as a list of cells (from their first side to their last), or null.
  function winningChain(b, n, p) {
    var nb = neighbors(n), prev = new Int16Array(n * n).fill(-2), queue = [], k, i;
    for (k = 0; k < n; k++) { i = p === RED ? k : k * n; if (b[i] === p) { prev[i] = -1; queue.push(i); } }
    for (var h = 0; h < queue.length; h++) {
      i = queue[h];
      if (isTarget(n, p, i)) { var chain = []; while (i >= 0) { chain.push(i); i = prev[i]; } return chain.reverse(); }
      for (var j = 0; j < nb[i].length; j++) { var x = nb[i][j]; if (b[x] === p && prev[x] === -2) { prev[x] = i; queue.push(x); } }
    }
    return null;
  }
  function winner(b, n) { return winningChain(b, n, RED) ? RED : winningChain(b, n, BLUE) ? BLUE : 0; }

  // ── the computer ─────────────────────────────────────────────────────────
  // The fewest empty cells p still has to fill to link its sides (own stones are free,
  // the other colour blocks): a 0-1 shortest path, level by level.
  function dist(b, n, p) {
    var nb = neighbors(n), d = new Int16Array(n * n).fill(INF), cur = [], next = [], q = 3 - p, k, i, c;
    for (k = 0; k < n; k++) {
      i = p === RED ? k : k * n;
      if (b[i] === q) continue;
      c = b[i] === p ? 0 : 1;
      if (c < d[i]) { d[i] = c; (c ? next : cur).push(i); }
    }
    for (var level = 0; cur.length || next.length; level++) {
      while (cur.length) {
        i = cur.pop();
        if (d[i] !== level) continue;
        if (isTarget(n, p, i)) return level;
        for (var j = 0; j < nb[i].length; j++) {
          var x = nb[i][j];
          if (b[x] === q) continue;
          c = b[x] === p ? 0 : 1;
          if (level + c < d[x]) { d[x] = level + c; (c ? next : cur).push(x); }
        }
      }
      cur = next; next = [];
    }
    return INF;
  }
  // How good the position is for p: the other side's distance minus ours, a little for the middle.
  function evaluate(b, n, p) {
    var mine = dist(b, n, p), theirs = dist(b, n, 3 - p);
    if (!mine) return 10000;
    if (!theirs) return -10000;
    return (theirs - mine) * 10;
  }
  function centreBonus(n, i) {
    var r = (i / n) | 0, c = i % n, m = (n - 1) / 2;
    return -(Math.abs(r - m) + Math.abs(c - m)) * 0.15;
  }
  // Empty cells with their one-move value for p, best first.
  function ranked(b, n, p) {
    var out = [];
    for (var i = 0; i < b.length; i++) {
      if (b[i]) continue;
      b[i] = p; var s = evaluate(b, n, p) + centreBonus(n, i); b[i] = 0;
      out.push({ idx: i, s: s });
    }
    out.sort(function (x, y) { return y.s - x.s; });
    return out;
  }
  function negamax(b, n, p, depth, alpha, beta, width) {
    var cs = ranked(b, n, p).slice(0, width), best = -Infinity;
    for (var i = 0; i < cs.length; i++) {
      var idx = cs[i].idx, s;
      b[idx] = p;
      if (!dist(b, n, p)) s = 10000 + depth;
      else if (depth <= 1) s = evaluate(b, n, p);
      else s = -negamax(b, n, 3 - p, depth - 1, -beta, -alpha, width);
      b[idx] = 0;
      if (s > best) best = s;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }
  // The computer's cell at a level.
  function chooseMove(b0, n, p, level, rng) {
    var b = b0.slice(0), cfg = LEVELS[level] || LEVELS.medium, rand = rng || Math.random, mid = (n >> 1) * n + (n >> 1), i, any = false;
    for (i = 0; i < b.length; i++) if (b[i]) { any = true; break; }
    if (!any) {
      if (level === 'easy') return mid + ((rand() * 3) | 0) - 1 + n * (((rand() * 3) | 0) - 1);
      return mid;
    }
    var r = ranked(b, n, p);
    if (!r.length) return -1;
    if (cfg.depth) {
      var cand = r.slice(0, cfg.width + 1), bestS = -Infinity, bestI = cand[0].idx;
      for (i = 0; i < cand.length; i++) {
        b[cand[i].idx] = p;
        var s = !dist(b, n, p) ? 10000 : -negamax(b, n, 3 - p, cfg.depth - 1, -Infinity, Infinity, cfg.width);
        b[cand[i].idx] = 0;
        s += centreBonus(n, cand[i].idx);
        if (s > bestS) { bestS = s; bestI = cand[i].idx; }
      }
      return bestI;
    }
    var pool = r.slice(0, cfg.top);
    return pool[(rand() * pool.length) | 0].idx;
  }
  // Whether the second player should take over the opening move (a middling move is worth taking).
  function worthSwapping(n, idx) {
    var r = (idx / n) | 0, c = idx % n, m = (n - 1) / 2, edge = Math.min(r, c, n - 1 - r, n - 1 - c);
    return edge >= 1 && Math.abs(r - m) + Math.abs(c - m) <= n * 0.55 && !(r + c <= 1 || r + c >= 2 * n - 3);
  }
  // A fair first move for the computer when the second player may swap: near an edge, not in the middle.
  function fairOpening(n, rand) {
    var pick = [[1, 2], [2, 1], [n - 3, n - 2], [n - 2, n - 3], [1, 3], [3, 1]][((rand || Math.random)() * 6) | 0];
    return pick[0] * n + pick[1];
  }

  root.HexEngine = { RED: RED, BLUE: BLUE, LEVELS: LEVELS, neighbors: neighbors, empty: empty, winner: winner, winningChain: winningChain, dist: dist, evaluate: evaluate, chooseMove: chooseMove, worthSwapping: worthSwapping, fairOpening: fairOpening };

  // ── the page ─────────────────────────────────────────────────────────────
  if (typeof document === 'undefined' || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, R = 20, SQ3 = Math.sqrt(3), PAD = 14;
  function sideName(c) { return UI.side(c === 0 ? 'red' : 'blue'); }
  var host = document.getElementById('wk-board'), cellsG, marksG, btns = [], n = 11, W = 0, Hh = 0;
  var state, history = WK.History(), last = -1, chain = null, hintIdx = -1, swapped = false, swapDone = false, moves = 0;
  var score = WK.scoreBar(document.getElementById('wk-score'), [{ color: 'var(--hx-red)' }, { color: 'var(--hx-blue)' }]);
  var swapBtn = document.getElementById('hx-swap');
  var G = WK.create({
    id: 'hex',
    options: WK.standardOptions({ first: 'hex.side.red', second: 'hex.side.blue' }).concat([{ key: 'size', legend: 'go.board', def: root.matchMedia && root.matchMedia('(max-width: 519px)').matches ? '9' : '11', choices: [['7', 'hex.board.7'], ['9', 'hex.board.9'], ['11', 'hex.board.11']] }]),
    checks: [{ key: 'swap', label: 'hex.swap', def: false }],
    statKey: function (s) { return s.level + s.size + (s.swap ? 's' : ''); },
    onNew: newGame, onUndo: undo, onHint: hint
  });

  // Who plays colour c (0 red, 1 blue) now: the sides swap when the swap rule is used.
  function isHuman(c) { return !G.vsComputer() || ((G.settings.side === 'second' ? 1 : 0) ^ (swapped ? 1 : 0)) === c; }
  function nameOf(c) {
    if (!G.vsComputer()) return sideName(c);
    return isHuman(c) ? T('board.you') : T('board.zimi');
  }

  // The rhombus stands on its long diagonal so the board is tall, like the phone: cell (0,0) is the top corner and (n-1,n-1) the
  // bottom one, row 0 runs down the upper right, column 0 down the upper left. The lattice is the usual one turned 60 degrees, so
  // the cells keep their shape and the neighbours keep their indices.
  function cx(r, c) { return PAD + R * SQ3 / 2 * (c - r + n); }
  function cy(r, c) { return PAD + R * (1 + 1.5 * (r + c)); }
  function vert(r, c, k) { var a = (60 * k + 30) * Math.PI / 180; return [cx(r, c) + R * Math.cos(a), cy(r, c) + R * Math.sin(a)]; }
  function pts(list) { return list.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '); }
  function hexPoly(r, c, shrink) {
    var out = [];
    for (var k = 0; k < 6; k++) { var a = (60 * k + 30) * Math.PI / 180, rr = R - (shrink || 0); out.push([cx(r, c) + rr * Math.cos(a), cy(r, c) + rr * Math.sin(a)]); }
    return pts(out);
  }
  // Red owns the upper-right and lower-left edges (rows 0 and n-1), Blue the upper-left and lower-right (columns 0 and n-1).
  function sidePaths() {
    var ur = [], ll = [], ul = [], lr = [], i;
    for (i = 0; i < n; i++) {
      ur.push(vert(0, i, 4), vert(0, i, 5), vert(0, i, 0)); ll.push(vert(n - 1, i, 3), vert(n - 1, i, 2), vert(n - 1, i, 1));
      ul.push(vert(i, 0, 4), vert(i, 0, 3), vert(i, 0, 2)); lr.push(vert(i, n - 1, 5), vert(i, n - 1, 0), vert(i, n - 1, 1));
    }
    return [[ur, 'r'], [ll, 'r'], [ul, 'b'], [lr, 'b']].map(function (e) { return '<polyline points="' + pts(e[0]) + '" class="hx-side ' + e[1] + '"/>'; }).join('');
  }
  function centre(i) { var r = (i / n) | 0, c = i % n; return [cx(r, c), cy(r, c)]; }
  function coord(i) { return 'ABCDEFGHIJK'[i % n] + (((i / n) | 0) + 1); }

  function buildBoard() {
    n = +G.settings.size;
    W = 2 * PAD + R * SQ3 * n; Hh = 2 * PAD + R * (2 + 3 * (n - 1));
    host.innerHTML = '<svg viewBox="0 0 ' + W.toFixed(0) + ' ' + Hh.toFixed(0) + '" aria-hidden="true"><g id="hx-cells"></g>' + sidePaths() + '<g id="hx-marks"></g></svg>';
    cellsG = host.querySelector('#hx-cells'); marksG = host.querySelector('#hx-marks');
    var p = [];
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) p.push({ x: cx(r, c), y: cy(r, c), w: R * SQ3, h: R * 1.75 });
    btns = WK.overlay(host, W, Hh, p, onCell, 'hx-pt');
    host.style.setProperty('--ratio', (W / Hh).toFixed(3));
  }

  function paint() {
    var b = state.board, s = '', m = '', i, open = !G.over && !G.thinking && isHuman(state.turn) && !swapAsk();
    for (i = 0; i < n * n; i++) {
      var r = (i / n) | 0, c = i % n;
      s += '<polygon points="' + hexPoly(r, c, 0.8) + '" class="hx-cell' + (b[i] ? ' s' + b[i] : '') + '"/>';
    }
    if (chain) {
      m += '<polyline points="' + pts(chain.map(centre)) + '" class="hx-path"/>';
      chain.forEach(function (j) { var p = centre(j); m += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="6.5" class="hx-win"/>'; });
    }
    if (last >= 0 && !(chain && chain.indexOf(last) >= 0)) { var q = centre(last); m += '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="8" class="hx-last"/>'; }
    else if (last >= 0) { var q2 = centre(last); m += '<circle cx="' + q2[0].toFixed(1) + '" cy="' + q2[1].toFixed(1) + '" r="10" class="hx-last-ring"/>'; }
    if (hintIdx >= 0) m += '<polygon points="' + hexPoly((hintIdx / n) | 0, hintIdx % n, 3) + '" class="hx-hint"/>';
    cellsG.innerHTML = s; marksG.innerHTML = m;
    btns.forEach(function (bt, j) { bt.setAttribute('aria-label', T('go.pt', { pt: coord(j), what: T(b[j] === 1 ? 'hex.cell.red' : b[j] === 2 ? 'hex.cell.blue' : 'go.pt.empty') })); bt.setAttribute('aria-disabled', (!open || b[j]) ? 'true' : 'false'); });
    var names = [nameOf(0), nameOf(1)];
    score(names, null, G.over ? -1 : state.turn);
    swapBtn.hidden = !(swapAsk() && isHuman(state.turn) && !G.over);
    G.setUndo(history.size() > 0); G.setHint(open);
  }
  // The second player may still take over the first move.
  function swapAsk() { return G.settings.swap && moves === 1 && !swapDone && !G.over; }

  function turnText() {
    var c = state.turn;
    if (swapAsk() && isHuman(c)) return T('hex.swapAsk', { side: sideName(c).toLowerCase() });
    if (!G.vsComputer()) return T('go.toPlay', { name: sideName(c) });
    return isHuman(c) ? T('hex.yourTurn', { side: sideName(c).toLowerCase() }) : T('shell.thinking');
  }

  function onCell(i) {
    if (G.over || G.thinking || !isHuman(state.turn)) return;
    if (state.board[i]) { G.refuse(btns[i], T('hex.taken')); return; }
    place(i);
  }

  function snapshot() { return { board: state.board, turn: state.turn, last: last, swapped: swapped, swapDone: swapDone, moves: moves }; }

  function place(i) {
    history.push(snapshot());
    var nb = state.board.slice(0), c = state.turn;
    nb[i] = c + 1; state = { board: nb, turn: 1 - c }; last = i; hintIdx = -1; moves++;
    var ch = winningChain(nb, n, c + 1);
    if (ch) {
      chain = ch; paint();
      G.finish(T('hex.chain'), G.vsComputer() ? (isHuman(c) ? 'w' : 'l') : null, sideName(c));
      return;
    }
    afterMove();
  }

  function afterMove() {
    paint(); G.say(turnText(), !isHuman(state.turn));
    if (isHuman(state.turn)) return;
    G.later(function () {
      if (swapAsk() && G.vsComputer() && worthSwapping(n, last)) { doSwap(); return; }
      place(chooseMove(state.board, n, state.turn + 1, G.settings.level));
    });
  }

  // Swap: the colours change hands, the stone stays; the other player is now to move.
  function doSwap() {
    history.push(snapshot());
    swapped = !swapped; swapDone = true; paint();
    G.say(G.vsComputer() ? T(isHuman(0) ? 'hex.swapped.red' : 'hex.swapped.blue') : T('hex.swapped', { line: turnText() }));
    if (!isHuman(state.turn)) G.later(function () { place(chooseMove(state.board, n, state.turn + 1, G.settings.level)); });
  }
  swapBtn.addEventListener('click', function () { if (swapAsk() && isHuman(state.turn) && !G.thinking) doSwap(); });

  function hint() {
    hintIdx = chooseMove(state.board, n, state.turn + 1, 'hard');
    paint(); G.say(T('hex.hint'));
  }

  function undo() {
    if (!history.size()) return;
    G.cancel(); G.over = false; chain = null; hintIdx = -1;
    var h;
    do {
      h = history.pop(); swapped = h.swapped; swapDone = h.swapDone; state = { board: h.board, turn: h.turn };
    } while (history.size() && G.vsComputer() && !isHuman(h.turn));
    last = h.last; moves = h.moves;
    paint(); G.say(turnText());
    if (!isHuman(state.turn)) afterMoveAgain();
  }
  function afterMoveAgain() { G.later(function () { place(chooseMove(state.board, n, state.turn + 1, G.settings.level)); }); }

  function newGame() {
    if (+G.settings.size !== n || !cellsG) buildBoard();
    history.clear(); chain = null; hintIdx = -1; last = -1; swapped = false; swapDone = false; moves = 0;
    state = { board: empty(n), turn: 0 };
    paint(); G.say(turnText(), !isHuman(0));
    if (!isHuman(0)) G.later(function () { place(G.settings.swap ? fairOpening(n) : chooseMove(state.board, n, 1, G.settings.level)); });
  }

  if (root.ZimiShell) root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && history.size() > 0; } });
  G.newGame();
  G.persist({
    save: function () { return history.size() ? { state: state, history: history.all(), last: last, chain: chain, swapped: swapped, swapDone: swapDone, moves: moves } : null; },
    load: function (d) { state = d.state; history.set(d.history); last = d.last; chain = d.chain; swapped = d.swapped; swapDone = d.swapDone; moves = d.moves; hintIdx = -1; paint(); },
    resume: function () { G.say(turnText()); if (!isHuman(state.turn)) afterMoveAgain(); }
  });
  if (new URLSearchParams(location.search).has('debug')) root.__hx = { state: function () { return state; }, engine: root.HexEngine, n: function () { return n; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
