/* ZimiGames: Dots and Boxes (4 to 7 dots a side). Our own code, GPL-3.0.
   The rules and the computer (pure functions, testable in node), then the page. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  // A board of n by n dots has n*(n-1) horizontal lines (row-major, index r*(n-1)+c) then
  // (n-1)*n vertical lines (index H + r*n + c), and (n-1)*(n-1) boxes.
  var EXACT_EDGES = 17; // with this few lines left the hard computer solves the rest of the game

  function dims(n) { var h = n * (n - 1); return { n: n, H: h, E: 2 * h, B: (n - 1) * (n - 1) }; }
  function boxEdges(n, bx) {
    var m = n - 1, r = (bx / m) | 0, c = bx % m, H = n * m;
    return [r * m + c, (r + 1) * m + c, H + r * n + c, H + r * n + c + 1];
  }
  // The one or two boxes a line borders.
  function edgeBoxes(n, e) {
    var m = n - 1, H = n * m, out = [], r, c;
    if (e < H) { r = (e / m) | 0; c = e % m; if (r > 0) out.push((r - 1) * m + c); if (r < m) out.push(r * m + c); }
    else { var j = e - H; r = (j / n) | 0; c = j % n; if (c > 0) out.push(r * m + c - 1); if (c < m) out.push(r * m + c); }
    return out;
  }
  function newState(n) { var d = dims(n); return { n: n, edges: new Uint8Array(d.E), owner: new Int8Array(d.B), turn: 0, score: [0, 0] }; }
  function sides(s, bx) { var e = boxEdges(s.n, bx), k = 0; for (var i = 0; i < 4; i++) k += s.edges[e[i]]; return k; }

  // Draw line e for the side to move. Closing a box takes it and keeps the turn.
  function play(s, e) {
    var edges = s.edges.slice(0), owner = s.owner.slice(0), score = s.score.slice(0), taken = [], p = s.turn;
    edges[e] = 1;
    var t = { n: s.n, edges: edges, owner: owner, turn: p, score: score };
    edgeBoxes(s.n, e).forEach(function (bx) { if (sides(t, bx) === 4) { owner[bx] = p + 1; score[p]++; taken.push(bx); } });
    t.turn = taken.length ? p : 1 - p;
    return { state: t, taken: taken };
  }
  function legal(s) { var out = []; for (var i = 0; i < s.edges.length; i++) if (!s.edges[i]) out.push(i); return out; }
  function isOver(s) { return s.score[0] + s.score[1] === dims(s.n).B; }
  function winner(s) { return s.score[0] === s.score[1] ? -1 : s.score[0] > s.score[1] ? 0 : 1; }

  // ── the computer ─────────────────────────────────────────────────────────
  function takes(s) { // lines that close a box now
    var out = [];
    for (var i = 0; i < s.edges.length; i++) if (!s.edges[i] && edgeBoxes(s.n, i).some(function (bx) { return sides(s, bx) === 3; })) out.push(i);
    return out;
  }
  // A line is safe when it does not leave any box with three sides drawn.
  function isSafe(s, e) { return !edgeBoxes(s.n, e).some(function (bx) { return sides(s, bx) === 2; }); }
  // How many boxes the other side could take straight away after e (greedy takeover of chains).
  function handedOver(s, e) {
    var t = play(s, e).state, n = 0, c;
    if (t.turn === s.turn) return -1; // e closed a box: not a sacrifice
    while ((c = takes(t)).length) { var r = play(t, c[0]); n += r.taken.length; t = r.state; }
    return n;
  }
  function pick(a, rnd) { return a[(rnd() * a.length) | 0]; }

  // Exact value of the rest of the game for the side to move: its boxes minus the other's.
  function solve(s) {
    var rem = legal(s), k = rem.length, n = s.n, sd = new Int8Array(dims(n).B), memo = new Map(), i;
    for (i = 0; i < sd.length; i++) sd[i] = sides(s, i);
    var adj = rem.map(function (e) { return edgeBoxes(n, e); });
    function val(mask) {
      if (mask === (1 << k) - 1) return 0;
      var hit = memo.get(mask);
      if (hit !== undefined) return hit;
      var best = -Infinity;
      for (var j = 0; j < k; j++) {
        if (mask & (1 << j)) continue;
        var got = 0, bs = adj[j], q;
        for (q = 0; q < bs.length; q++) { sd[bs[q]]++; if (sd[bs[q]] === 4) got++; }
        var v = got ? got + val(mask | (1 << j)) : -val(mask | (1 << j));
        for (q = 0; q < bs.length; q++) sd[bs[q]]--;
        if (v > best) best = v;
      }
      memo.set(mask, best);
      return best;
    }
    return { rem: rem, adj: adj, sd: sd, val: val };
  }
  function exactMove(s, rnd) {
    var sv = solve(s), best = -Infinity, pool = [];
    for (var j = 0; j < sv.rem.length; j++) {
      var bs = sv.adj[j], got = 0, q;
      for (q = 0; q < bs.length; q++) { sv.sd[bs[q]]++; if (sv.sd[bs[q]] === 4) got++; }
      var rest = sv.val(1 << j);
      var v = got ? got + rest : -rest;
      for (q = 0; q < bs.length; q++) sv.sd[bs[q]]--;
      if (v > best) { best = v; pool = [sv.rem[j]]; } else if (v === best) pool.push(sv.rem[j]);
    }
    return pick(pool, rnd);
  }

  // The computer's line at a level.
  function chooseEdge(s, level, rng) {
    var rnd = rng || Math.random, all = legal(s);
    if (!all.length) return -1;
    var closers = takes(s);
    if (level === 'easy') {
      if (closers.length && rnd() < 0.75) return pick(closers, rnd);
      return pick(all, rnd);
    }
    if (level === 'hard' && all.length <= EXACT_EDGES) return exactMove(s, rnd);
    if (closers.length) return pick(closers, rnd);
    var safe = all.filter(function (e) { return isSafe(s, e); });
    if (safe.length) return pick(safe, rnd);
    var costs = all.map(function (e) { return handedOver(s, e); }), least = Math.min.apply(null, costs);
    var slack = level === 'medium' ? 1 : 0;
    return pick(all.filter(function (e, i) { return costs[i] <= least + slack; }), rnd);
  }

  root.DotsAndBoxesEngine = { dims: dims, boxEdges: boxEdges, edgeBoxes: edgeBoxes, newState: newState, play: play, legal: legal, isOver: isOver, winner: winner, takes: takes, chooseEdge: chooseEdge, sides: sides };

  // ── the page ─────────────────────────────────────────────────────────────
  if (typeof document === 'undefined' || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, CELL = 64, PAD = 26, TAP = 44;
  var COLORS = ['var(--db-a)', 'var(--db-b)'], GLYPHS = ['●', '◆'];   // a glyph with the colour: colour never carries meaning alone
  function sideName(p) { return T(p === 0 ? 'dotsandboxes.side.blue' : 'dotsandboxes.side.coral'); }
  var host = document.getElementById('wk-board'), g, btns = [], n = 5, d = dims(5), W = 0;
  var state, history = WK.History(), recent = [], recentBy = -1, hintEdge = -1;
  var score = WK.scoreBar(document.getElementById('wk-score'), [{ color: COLORS[0] }, { color: COLORS[1] }]);
  var G = WK.create({
    id: 'dotsandboxes',
    options: WK.standardOptions({ first: 'dotsandboxes.side.blueFirst', second: 'dotsandboxes.side.coral' }).concat([{ key: 'size', legend: 'dotsandboxes.dots', def: '5', choices: [['4', 'dotsandboxes.n4'], ['5', 'dotsandboxes.n5'], ['6', 'dotsandboxes.n6'], ['7', 'dotsandboxes.n7']] }]),
    statKey: function (s) { return s.level + s.size; },
    onNew: newGame, onUndo: undo, onHint: hint
  });

  function dot(r, c) { return { x: PAD + c * CELL, y: PAD + r * CELL }; }
  function edgeEnds(e) {
    var m = n - 1, a, b;
    if (e < d.H) { var r = (e / m) | 0, c = e % m; a = dot(r, c); b = dot(r, c + 1); }
    else { var j = e - d.H, r2 = (j / n) | 0, c2 = j % n; a = dot(r2, c2); b = dot(r2 + 1, c2); }
    return [a, b];
  }
  function edgeName(e) {
    var ends = edgeEnds(e), horizontal = e < d.H, r = Math.round((ends[0].y - PAD) / CELL) + 1, c = Math.round((ends[0].x - PAD) / CELL) + 1;
    return horizontal ? T('dotsandboxes.edge.h', { row: r, from: c }) : T('dotsandboxes.edge.v', { col: c, from: r });
  }

  function buildBoard() {
    n = +G.settings.size; d = dims(n); W = (n - 1) * CELL + 2 * PAD;
    var dots = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) { var p = dot(r, c); dots += '<circle cx="' + p.x + '" cy="' + p.y + '" r="5.5" class="db-dot"/>'; }
    host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + W + '" aria-hidden="true"><rect width="' + W + '" height="' + W + '" rx="14" class="db-paper"/><g id="db-boxes"></g><g id="db-lines"></g>' + dots + '</svg>';
    g = { boxes: host.querySelector('#db-boxes'), lines: host.querySelector('#db-lines') };
    var pts = [];
    for (var e = 0; e < d.E; e++) {
      var ends = edgeEnds(e), horiz = e < d.H;
      pts.push({ x: (ends[0].x + ends[1].x) / 2, y: (ends[0].y + ends[1].y) / 2, w: horiz ? CELL - 22 : TAP, h: horiz ? TAP : CELL - 22 });
    }
    btns = WK.overlay(host, W, W, pts, onEdge, 'db-edge');
  }

  function paint() {
    var s = state, lines = '', boxes = '', open = !G.over && !G.thinking && G.human(s.turn), e, bx;
    for (bx = 0; bx < d.B; bx++) {
      if (!s.owner[bx]) continue;
      var m = n - 1, r = (bx / m) | 0, c = bx % m, o = s.owner[bx] - 1, p = dot(r, c);
      boxes += '<rect x="' + (p.x + 5) + '" y="' + (p.y + 5) + '" width="' + (CELL - 10) + '" height="' + (CELL - 10) + '" rx="8" style="fill:' + COLORS[o] + '" class="db-box"/><text x="' + (p.x + CELL / 2) + '" y="' + (p.y + CELL / 2 + 8) + '" text-anchor="middle" font-size="22" class="db-glyph">' + GLYPHS[o] + '</text>';
    }
    for (e = 0; e < d.E; e++) {
      var ends = edgeEnds(e), a = ends[0], b = ends[1], base = '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '"';
      if (s.edges[e]) lines += base + ' class="db-line' + (recent.indexOf(e) >= 0 ? ' new' : '') + '"/>';
      else lines += base + ' class="db-slot' + (e === hintEdge ? ' hint' : '') + '"/>';
    }
    g.boxes.innerHTML = boxes; g.lines.innerHTML = lines;
    btns.forEach(function (bt, i) { bt.setAttribute('aria-label', s.edges[i] ? T('dotsandboxes.edge.drawn', { label: edgeName(i) }) : edgeName(i)); bt.setAttribute('aria-disabled', (!open || s.edges[i]) ? 'true' : 'false'); });
    score(G.names(sideName(0), sideName(1)), s.score, G.over ? -1 : s.turn);
    G.setUndo(history.size() > 0); G.setHint(open);
  }

  function turnText() {
    var p = state.turn;
    if (!G.vsComputer()) return T('dotsandboxes.toDraw', { name: sideName(p) });
    return G.human(p) ? T('board.yourTurn') : T('shell.thinking');
  }

  function onEdge(e) {
    if (G.over || G.thinking || !G.human(state.turn)) return;
    if (state.edges[e]) { G.refuse(btns[e], T('dotsandboxes.taken')); return; }
    move(e);
  }

  function move(e) {
    history.push({ state: state, recent: recent, by: recentBy });
    var mover = state.turn, r = play(state, e);
    recent = mover === recentBy ? recent.concat([e]) : [e]; recentBy = mover;
    state = r.state; hintEdge = -1;
    if (isOver(state)) { paint(); finish(); return; }
    paint();
    var again = state.turn === mover && r.taken.length;
    G.say(again ? T('dotsandboxes.tookAgain' + (G.vsComputer() && G.human(mover) ? '.you' : ''), { name: G.vsComputer() ? T('board.zimi') : sideName(mover), n: r.taken.length }) : turnText(), !G.human(state.turn));
    if (!G.human(state.turn)) G.later(function () { move(chooseEdge(state, G.settings.level)); }, again ? 460 : 560);
  }

  function finish() {
    var w = winner(state), s = state.score;
    if (w < 0) { G.finish(T('dotsandboxes.draw', { n: s[0] }), 'd'); return; }
    var top = Math.max(s[0], s[1]), low = Math.min(s[0], s[1]);
    G.finish(T('dotsandboxes.score', { top: top, low: low }), G.vsComputer() ? (G.human(w) ? 'w' : 'l') : null, sideName(w));
  }

  function hint() {
    hintEdge = chooseEdge(state, 'hard');
    paint(); G.say(T('dotsandboxes.hint'));
  }

  function undo() {
    if (!history.size()) return;
    G.cancel(); G.over = false; hintEdge = -1;
    var h;
    do { h = history.pop(); } while (history.size() && G.vsComputer() && !G.human(h.state.turn));
    state = h.state; recent = h.recent; recentBy = h.by;
    paint(); G.say(turnText());
    if (!G.human(state.turn)) G.later(function () { move(chooseEdge(state, G.settings.level)); });
  }

  function newGame() {
    if (+G.settings.size !== n || !g) buildBoard();
    history.clear(); recent = []; recentBy = -1; hintEdge = -1;
    state = newState(n);
    paint(); G.say(turnText(), !G.human(0));
    if (!G.human(0)) G.later(function () { move(chooseEdge(state, G.settings.level)); });
  }

  if (root.ZimiShell) root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && history.size() > 0; } });
  G.newGame();
  G.persist({
    save: function () { return history.size() ? { state: state, history: history.all(), recent: recent, by: recentBy } : null; },
    load: function (d) { buildBoard(); state = d.state; history.set(d.history); recent = d.recent; recentBy = d.by; hintEdge = -1; paint(); },
    resume: function () { G.say(turnText()); if (!G.human(state.turn)) G.later(function () { move(chooseEdge(state, G.settings.level)); }); }
  });
  if (new URLSearchParams(location.search).has('debug')) root.__db = { state: function () { return state; }, engine: root.DotsAndBoxesEngine };
})(typeof globalThis !== 'undefined' ? globalThis : this);
