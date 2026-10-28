/* ZimiGames: the life-and-death solver behind Go Problems. Our own code, GPL-3.0. Pure functions over go-engine.js
   (its place() and neighbors() keep the rules: captures, suicide, simple ko), so node runs it to prove every shipped
   problem and the page runs it to judge a move.

   A problem is a corner of a 19x19 board. Black moves first and is the one who must succeed:
     kill: capture every stone of the white target group;
     live: make the black target group live (it holds two real eyes), before it is captured.
   The search is an iterative-deepening alpha-beta over a small zone around the target, with a transposition table.
   Black's win is a proof: captures are exact; "alive" is the real-eye rule (every neighbour of the eye is the chain's
   own, and not a false eye by its diagonals), which is the textbook test and conservative: a group that lives only by
   a shape it does not recognise is searched on until it is captured or gives up at the depth limit.
   Moves outside the zone count as passing, which is how tsumego are read. */
function makeTsumegoSolver(G) {
  'use strict';
  var N = 19, SIZE = N * N, BLACK = 1, WHITE = 2;
  var NB = G.neighbors(N);
  G.legal(G.newGame(N), 0);   // sizes the engine's scratch buffers for a 19x19 board before place() is called directly
  var DIAG = [];
  (function () {
    for (var i = 0; i < SIZE; i++) {
      var r = (i / N) | 0, c = i % N, list = [];
      [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(function (d) { var rr = r + d[0], cc = c + d[1]; if (rr >= 0 && rr < N && cc >= 0 && cc < N) list.push(rr * N + cc); });
      DIAG.push(list);
    }
  })();

  // rows: ['.xo', ...] with x black, o white, . empty (also labelled letters). Returns the starting board.
  function boardFromRows(rows) {
    var b = new Int8Array(SIZE);
    for (var r = 0; r < rows.length && r < N; r++) for (var c = 0; c < rows[r].length && c < N; c++) {
      var ch = rows[r][c];
      b[r * N + c] = ch === 'x' || ch === 'b' ? BLACK : ch === 'o' || ch === 'w' ? WHITE : 0;
    }
    return b;
  }

  // Stones of one colour grouped into clusters: two stones are one cluster when they are within `radius` points of each other (two by default).
  function clusters(b, color, radius) {
    radius = radius || 2;
    var seen = new Uint8Array(SIZE), out = [];
    for (var i = 0; i < SIZE; i++) {
      if (b[i] !== color || seen[i]) continue;
      var q = [i], stones = [];
      seen[i] = 1;
      for (var h = 0; h < q.length; h++) {
        var p = q[h], r = (p / N) | 0, c = p % N;
        stones.push(p);
        for (var dr = -radius; dr <= radius; dr++) for (var dc = -radius; dc <= radius; dc++) {
          var rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= N || cc >= N) continue;
          var n = rr * N + cc;
          if (b[n] === color && !seen[n]) { seen[n] = 1; q.push(n); }
        }
      }
      out.push(stones);
    }
    return out;
  }

  // ── the goal tests ──
  var MARK = new Int32Array(SIZE), STAMP = 0, COUNTED = new Int32Array(SIZE), CSTAMP = 0;
  function chainOf(b, start, color, mark, stamp) {
    var q = [start], chain = [];
    mark[start] = stamp;
    for (var h = 0; h < q.length; h++) {
      var p = q[h]; chain.push(p);
      var l = NB[p];
      for (var k = 0; k < l.length; k++) if (b[l[k]] === color && mark[l[k]] !== stamp) { mark[l[k]] = stamp; q.push(l[k]); }
    }
    return chain;
  }
  // The empty region holding point e, if the chain (marked with stamp) walls all of it in and it is at most `cap` points; else null.
  function enclosedRegion(b, e, mark, stamp, cap) {
    var q = [e], seen = {}, h, k;
    seen[e] = 1;
    for (h = 0; h < q.length; h++) {
      var l = NB[q[h]];
      for (k = 0; k < l.length; k++) {
        var v = b[l[k]];
        if (v === 0) { if (!seen[l[k]]) { seen[l[k]] = 1; q.push(l[k]); if (q.length > cap) return null; } }
        else if (mark[l[k]] !== stamp) return null;
      }
    }
    return q;
  }
  function isLine(region) {
    var rs = {}, cs = {};
    region.forEach(function (p) { rs[(p / N) | 0] = 1; cs[p % N] = 1; });
    return Object.keys(rs).length === 1 || Object.keys(cs).length === 1;
  }
  function falseEye(b, e, enemy) {
    var d = DIAG[e], bad = d.length < 4 ? 1 : 0;
    for (var j = 0; j < d.length; j++) if (b[d[j]] === enemy) bad++;
    return bad >= 2;
  }
  // How many eyes the enclosed region gives: one point or two points make one real eye; a straight line or a T of four or
  // more makes two (living shapes); anything else is left to the search.
  function regionEyes(b, region, enemy) {
    var n = region.length, i;
    if (n <= 2) { for (i = 0; i < n; i++) if (falseEye(b, region[i], enemy)) return 0; return 1; }
    if (n >= 4 && isLine(region) && n <= 6) return 2;
    if (n === 4) {
      for (i = 0; i < n; i++) {
        var c = 0, l = NB[region[i]];
        for (var k = 0; k < l.length; k++) if (b[l[k]] === 0) c++;
        if (c === 3) return 2;
      }
    }
    return 0;
  }
  // Does a chain of `color` holding a target stone own two real eyes (or a living eye shape)?
  function hasTwoEyes(b, target, color) {
    var enemy = 3 - color, mark = MARK, first = STAMP;
    for (var t = 0; t < target.length; t++) {
      if (b[target[t]] !== color || mark[target[t]] > first) continue;   // gone, or already in a chain looked at
      var stamp = ++STAMP;
      var chain = chainOf(b, target[t], color, mark, stamp), eyes = 0, cstamp = ++CSTAMP;
      for (var i = 0; i < chain.length; i++) {
        var l = NB[chain[i]];
        for (var k = 0; k < l.length; k++) {
          var e = l[k];
          if (b[e] !== 0 || COUNTED[e] === cstamp) continue;
          var region = enclosedRegion(b, e, mark, stamp, 6);
          if (!region) { COUNTED[e] = cstamp; continue; }
          for (var j = 0; j < region.length; j++) COUNTED[region[j]] = cstamp;
          eyes += regionEyes(b, region, enemy);
          if (eyes >= 2) return true;
        }
      }
    }
    return false;
  }
  // Statically dead: every liberty of the target group lies in a small enclosed space of at most two empty points in all
  // (two such points cannot make two eyes), and the stones around that space belong to chains with room to breathe, so
  // they cannot be taken from inside. This ends a proof where the rest is only the tidy capture of a dead group.
  var DEAD_SPACE = 2, DEAD_WALL_LIBS = 3;
  function chainLibs(b, p, color, cap) {
    var seen = {}, q = [p], libs = {}, n = 0;
    seen[p] = 1;
    for (var h = 0; h < q.length; h++) {
      var l = NB[q[h]];
      for (var k = 0; k < l.length; k++) {
        var v = b[l[k]], x = l[k];
        if (v === color && !seen[x]) { seen[x] = 1; q.push(x); }
        else if (v === 0 && !libs[x]) { libs[x] = 1; if (++n >= cap) return n; }
      }
    }
    return n;
  }
  function deadStatic(b, target, color) {
    var enemy = 3 - color, stamp = ++STAMP, mark = MARK, space = [], inSpace = {}, i, k;
    var first = STAMP - 1, chainsSeen = 0;
    for (var t = 0; t < target.length; t++) {
      if (b[target[t]] !== color || mark[target[t]] > first) continue;
      var chain = chainOf(b, target[t], color, mark, stamp);
      chainsSeen++;
      for (i = 0; i < chain.length; i++) {
        var l = NB[chain[i]];
        for (k = 0; k < l.length; k++) if (b[l[k]] === 0 && !inSpace[l[k]]) {
          inSpace[l[k]] = 1; space.push(l[k]);
          if (space.length > DEAD_SPACE) return false;
        }
      }
    }
    if (!chainsSeen) return false;
    // the space may reach further empty points: any empty neighbour of the space must already be in it
    for (i = 0; i < space.length; i++) {
      var sn = NB[space[i]];
      for (k = 0; k < sn.length; k++) {
        var v = b[sn[k]];
        if (v === 0 && !inSpace[sn[k]]) return false;
        if (v === color && mark[sn[k]] !== stamp) return false;          // another chain of the same colour: not simple
        if (v === enemy && chainLibs(b, sn[k], enemy, DEAD_WALL_LIBS) < DEAD_WALL_LIBS) return false;
      }
    }
    // the chain's own neighbours that are the enemy's must be safe as well
    return true;
  }
  function allGone(b, target, color) {
    for (var i = 0; i < target.length; i++) if (b[target[i]] === color) return false;
    return true;
  }
  // +1 black has done it, -1 black has failed, 0 still open
  function verdict(b, goal) {
    if (goal.kind === 'kill') {
      if (allGone(b, goal.target, WHITE)) return 1;
      if (hasTwoEyes(b, goal.target, WHITE)) return -1;
      if (deadStatic(b, goal.target, WHITE)) return 1;
    } else {
      if (hasTwoEyes(b, goal.target, BLACK)) return 1;
      if (allGone(b, goal.target, BLACK)) return -1;
      if (deadStatic(b, goal.target, BLACK)) return -1;
    }
    return 0;
  }

  // ── the search ──
  // The points the search plays on. reach 0 is the eye space: the empty points joined to the target group's liberties
  // (inside the diagram, at most INNER_CAP of them), where nearly all life and death is decided; reach 1 or 2 adds every
  // point within that many steps of a target stone.
  var INNER_CAP = 16;
  function zoneFor(b, goal, rows, cols, reach) {
    var zone = new Uint8Array(SIZE), t, h;
    if (reach === 0) {
      var q = [], seen = new Uint8Array(SIZE);
      goal.target.forEach(function (p) { var l = NB[p]; for (var k = 0; k < l.length; k++) if (!b[l[k]] && !seen[l[k]]) { seen[l[k]] = 1; q.push(l[k]); } });
      for (h = 0; h < q.length && h < INNER_CAP; h++) {
        zone[q[h]] = 1;
        var nl = NB[q[h]];
        for (var j = 0; j < nl.length; j++) {
          var n = nl[j], r = (n / N) | 0, c = n % N;
          if (!b[n] && !seen[n] && r < rows && c < cols) { seen[n] = 1; q.push(n); }
        }
      }
      return zone;
    }
    for (t = 0; t < goal.target.length; t++) {
      var tr = (goal.target[t] / N) | 0, tc = goal.target[t] % N;
      for (var dr = -reach; dr <= reach; dr++) for (var dc = -reach; dc <= reach; dc++) {
        var rr = tr + dr, cc = tc + dc;
        if (rr >= 0 && cc >= 0 && rr < rows && cc < cols && rr < N && cc < N) zone[rr * N + cc] = 1;
      }
    }
    return zone;
  }
  function Search(b0, goal, rows, cols, nodeCap, reach) {
    this.goal = goal; this.zone = zoneFor(b0, goal, rows, cols, reach === undefined ? 1 : reach); this.cells = [];
    for (var i = 0; i < SIZE; i++) if (this.zone[i]) this.cells.push(i);
    this.tt = new Map(); this.nodes = 0; this.cap = nodeCap || 150000; this.out = false;
    this.keyBuf = new Uint8Array(this.cells.length + 2);
  }
  Search.prototype.key = function (b, turn, ko) {
    var kb = this.keyBuf, cells = this.cells;
    for (var i = 0; i < cells.length; i++) kb[i] = b[cells[i]];
    kb[cells.length] = turn; kb[cells.length + 1] = ko < 0 ? 255 : ko & 255;
    return String.fromCharCode.apply(null, kb);
  };
  // Candidate points for `turn`, best first (legality is found when a move is played): points next to stones, enemy stones first.
  Search.prototype.moves = function (b, turn, ko, pass) {
    var out = [], cells = this.cells, enemy = 3 - turn;
    for (var i = 0; i < cells.length; i++) {
      var p = cells[i];
      if (b[p] || p === ko || G.isEye(b, N, p, turn)) continue;
      var score = 0, l = NB[p];
      for (var k = 0; k < l.length; k++) { var v = b[l[k]]; if (v === enemy) score += 3; else if (v === turn) score += 2; else score += 1; }
      out.push({ p: p, score: score });
    }
    out.sort(function (a, c) { return c.score - a.score; });
    if (pass) out.push({ p: -1, score: -1 });
    return out;
  };
  // The position after `color` plays p (a copy), its simple-ko point, or null when the move is illegal. p < 0 is a pass.
  function after(b, p, color) {
    if (p < 0) return { b: b, ko: -1 };
    var nb = b.slice(0), taken = G.place(nb, N, p, color);
    return taken < 0 ? null : { b: nb, ko: taken === 1 ? koAfter(nb, p, color) : -1 };
  }
  // Can black reach the goal from this position within d plies? turn is who moves.
  Search.prototype.win = function (b, turn, ko, d) {
    var v = verdict(b, this.goal);
    if (v) return v > 0;
    if (d <= 0) return false;
    if (++this.nodes > this.cap) { this.out = true; return false; }
    var key = this.key(b, turn, ko), e = this.tt.get(key);
    if (e) { if (e.w <= d) return true; if (e.l >= d) return false; } else { e = { w: 99, l: -1 }; this.tt.set(key, e); }
    var res, ms = this.moves(b, turn, ko, turn === WHITE && this.goal.kind === 'kill'), i, nx, any = false;
    if (turn === BLACK) {
      res = false;
      for (i = 0; i < ms.length && !res; i++) {
        nx = after(b, ms[i].p, BLACK);
        if (!nx) continue;
        if (this.win(nx.b, WHITE, nx.ko, d - 1)) res = true;
        if (this.out) return false;
      }
    } else {
      res = true;
      for (i = 0; i < ms.length && res; i++) {
        nx = after(b, ms[i].p, WHITE);
        if (!nx) continue;
        any = true;
        if (!this.win(nx.b, BLACK, nx.ko, d - 1)) res = false;
        if (this.out) return false;
      }
      if (res && !any) res = this.win(b, BLACK, -1, d - 1);
    }
    if (res) { if (d < e.w) e.w = d; } else if (d > e.l) e.l = d;
    return res;
  };
  // The point a simple ko forbids after `color` played p and took exactly one stone: the captured point, when p now has one liberty.
  function koAfter(b, p, color) {
    var l = NB[p], empty = -1, own = 0, n = 0;
    for (var k = 0; k < l.length; k++) { if (b[l[k]] === 0) { n++; empty = l[k]; } else if (b[l[k]] === color) own++; }
    return !own && n === 1 ? empty : -1;
  }

  // Iterative deepening: the fewest plies (odd) in which black wins with `turn` to move, or 0 when not within maxPlies.
  function minDepth(search, b, turn, ko, maxPlies) {
    for (var d = turn === BLACK ? 1 : 2; d <= maxPlies; d += 2) {
      if (search.win(b, turn, ko, d)) return d;
      if (search.out) return 0;
    }
    return 0;
  }

  // Everything the page and the build need about one problem.
  function analyse(rows, goal, opts) {
    opts = opts || {};
    var b = boardFromRows(rows), cols = 0;
    rows.forEach(function (r) { if (r.length > cols) cols = r.length; });
    var s = new Search(b, goal, rows.length, cols, opts.nodeCap, opts.reach), maxPlies = opts.maxPlies || 9;
    return { board: b, search: s, maxPlies: maxPlies };
  }

  // Black's winning first moves with the plies each needs, for a position with black to move. null when over budget.
  function firstMoves(a, b, ko) {
    var s = a.search, wins = [], ms = s.moves(b, BLACK, ko, false);
    for (var i = 0; i < ms.length; i++) {
      var nx = after(b, ms[i].p, BLACK);
      if (!nx) continue;
      var d = minDepth(s, nx.b, WHITE, nx.ko, a.maxPlies - 1);
      if (s.out) return null;
      if (d) wins.push({ p: ms[i].p, d: d + 1 });
    }
    return wins;
  }
  // White's most stubborn reply (the one black needs the most plies to beat), or -1 to pass; null when over budget or no reply loses.
  function stubbornReply(a, b, ko, left) {
    var s = a.search, ms = s.moves(b, WHITE, ko, s.goal.kind === 'kill'), best = null, bestD = -1;
    for (var i = 0; i < ms.length; i++) {
      var nx = after(b, ms[i].p, WHITE);
      if (!nx) continue;
      var d = minDepth(s, nx.b, BLACK, nx.ko, left - 1);
      if (s.out) return null;
      if (d && d > bestD) { bestD = d; best = ms[i].p; }
    }
    return best === null ? null : { p: best, d: bestD };
  }

  return { N: N, BLACK: BLACK, WHITE: WHITE, boardFromRows: boardFromRows, clusters: clusters, verdict: verdict, after: after, analyse: analyse, firstMoves: firstMoves, stubbornReply: stubbornReply, minDepth: minDepth, koAfter: koAfter };
}
if (typeof globalThis !== 'undefined') globalThis.makeTsumegoSolver = makeTsumegoSolver;
