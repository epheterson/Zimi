/* ZimiGames: the Polyominoes engine. Our own code, GPL-3.0. No network, no modules.
   One self-contained function (a Worker is built from its source). Two players share a 14 x 14 board. Each has the 21
   free polyominoes of one to five squares (every shape that can be made of up to five squares joined edge to edge). Take
   turns putting a piece on the board: the first piece covers your starting square; every later piece must touch one of your
   own pieces at a corner and never along an edge. Pieces may touch the other player's pieces anywhere. When neither
   player can move, the one with fewer squares left over wins (a player who places every piece scores 15 more, 5 more
   again if the last was the single square).
   A move is ((piece * 8 + orientation) * 196 + anchor), where anchor is the board square the shape's top left corner of
   its bounding box lands on, or PASS when a player has no placement. */
function ZimiPolyominoesEngine(S) {
  'use strict';

  var N = 14, SQ = 196, PIECES = 21, ORIENTS = 8, PASS = PIECES * ORIENTS * SQ, ALL = (1 << PIECES) - 1;
  var STARTS = [4 * N + 4, 9 * N + 9];
  var BONUS_ALL = 15, BONUS_MONO = 5, MONO = 0;
  var LEVELS = { easy: { skill: 0 }, medium: { skill: 1 }, hard: { skill: 2 } };
  var TOP_FOR_REPLY = 8, REPLY_WEIGHT = 0.7;
  // size 1 to 5; the index is the piece number. Cells are [row, col].
  var SHAPES = [
    [[0, 0]],
    [[0, 0], [0, 1]],
    [[0, 0], [0, 1], [0, 2]], [[0, 0], [1, 0], [1, 1]],
    [[0, 0], [0, 1], [0, 2], [0, 3]], [[0, 0], [1, 0], [2, 0], [2, 1]], [[0, 0], [0, 1], [0, 2], [1, 1]], [[0, 0], [0, 1], [1, 0], [1, 1]], [[0, 1], [0, 2], [1, 0], [1, 1]],
    [[0, 1], [0, 2], [1, 0], [1, 1], [2, 1]], [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]], [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1]], [[0, 1], [1, 1], [2, 1], [2, 0], [3, 0]],
    [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0]], [[0, 0], [0, 1], [0, 2], [1, 1], [2, 1]], [[0, 0], [0, 2], [1, 0], [1, 1], [1, 2]], [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]],
    [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]], [[0, 1], [1, 0], [1, 1], [1, 2], [2, 1]], [[0, 1], [1, 0], [1, 1], [2, 1], [3, 1]], [[0, 0], [0, 1], [1, 1], [2, 1], [2, 2]]
  ];
  var NAMES = 'ABCDEFGHIJKLMNOPQRSTU';   // a letter to name a piece by, for screen readers

  function normalize(cells) {
    var minR = Infinity, minC = Infinity;
    cells.forEach(function (c) { minR = Math.min(minR, c[0]); minC = Math.min(minC, c[1]); });
    return cells.map(function (c) { return [c[0] - minR, c[1] - minC]; }).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
  }
  function turnCells(cells) { return cells.map(function (c) { return [c[1], -c[0]]; }); }
  function flipCells(cells) { return cells.map(function (c) { return [c[0], -c[1]]; }); }
  // Every distinct way to lay a piece down: four turns of the shape and of its mirror image.
  var ORIENT = SHAPES.map(function (shape) {
    var seen = {}, out = [], cur = shape, f, t;
    for (f = 0; f < 2; f++) {
      for (t = 0; t < 4; t++) {
        var n = normalize(cur), k = JSON.stringify(n);
        if (!seen[k]) { seen[k] = 1; out.push({ cells: n, h: Math.max.apply(null, n.map(function (c) { return c[0]; })) + 1, w: Math.max.apply(null, n.map(function (c) { return c[1]; })) + 1 }); }
        cur = turnCells(cur);
      }
      cur = flipCells(shape);
    }
    return out;
  });
  var SIZE = SHAPES.map(function (s) { return s.length; });
  var TOTAL = SIZE.reduce(function (a, b) { return a + b; }, 0);   // 89 squares each

  function pieceOf(m) { return ((m / SQ) | 0) >> 3; }
  function orientOf(m) { return ((m / SQ) | 0) & 7; }
  function anchorOf(m) { return m % SQ; }
  function mk(piece, orient, anchor) { return (piece * ORIENTS + orient) * SQ + anchor; }
  function cellsOf(m) {
    var o = ORIENT[pieceOf(m)][orientOf(m)], a = anchorOf(m), ar = (a / N) | 0, ac = a % N;
    return o.cells.map(function (c) { return (ar + c[0]) * N + ac + c[1]; });
  }

  function newPosition() {
    return { board: new Int8Array(SQ), rem: [ALL, ALL], placed: [0, 0], last: [-1, -1], turn: 0, passes: 0, undo: [] };
  }
  function clone(p) { return { board: Int8Array.from(p.board), rem: p.rem.slice(), placed: p.placed.slice(), last: p.last.slice(), turn: p.turn, passes: p.passes, undo: [] }; }
  function key(p) { return p.turn + ':' + p.passes + ':' + Array.prototype.join.call(p.board, ''); }

  // Why a set of squares cannot be a player's next piece: null when it can; else
  // 'bounds', 'overlap', 'edge' (touches the player's own piece along a side), 'corner' (touches none at a corner), 'start'.
  function problem(p, who, cells) {
    var b = p.board, me = who + 1, touches = false, i, s, r, c, first = p.placed[who] === 0, onStart = false;
    for (i = 0; i < cells.length; i++) {
      s = cells[i];
      if (s < 0 || s >= SQ) return 'bounds';
      if (b[s]) return 'overlap';
    }
    for (i = 0; i < cells.length; i++) {
      s = cells[i]; r = (s / N) | 0; c = s % N;
      if (s === STARTS[who]) onStart = true;
      if ((r > 0 && b[s - N] === me) || (r < N - 1 && b[s + N] === me) || (c > 0 && b[s - 1] === me) || (c < N - 1 && b[s + 1] === me)) return 'edge';
      if ((r > 0 && c > 0 && b[s - N - 1] === me) || (r > 0 && c < N - 1 && b[s - N + 1] === me) || (r < N - 1 && c > 0 && b[s + N - 1] === me) || (r < N - 1 && c < N - 1 && b[s + N + 1] === me)) touches = true;
    }
    if (first) return onStart ? null : 'start';
    return touches ? null : 'corner';
  }
  // The squares for a shape at an anchor given as row and column, which may hang off the board (then 'bounds').
  function placeCells(piece, orient, ar, ac) {
    var o = ORIENT[piece][orient], out = [], i;
    if (ar < 0 || ac < 0 || ar + o.h > N || ac + o.w > N) return null;
    for (i = 0; i < o.cells.length; i++) out.push((ar + o.cells[i][0]) * N + ac + o.cells[i][1]);
    return out;
  }
  function legal(p, m) {
    if (m === PASS) return placements(p, p.turn).length === 0;
    var who = p.turn, piece = pieceOf(m);
    if (!((p.rem[who] >> piece) & 1)) return false;
    var a = anchorOf(m), cells = placeCells(piece, orientOf(m), (a / N) | 0, a % N);
    return !!cells && problem(p, who, cells) === null;
  }

  // The squares a piece of `who` could grow from: empty, touching one of theirs at a corner, never along a side.
  function corners(p, who) {
    var b = p.board, me = who + 1, out = [], s, r, c;
    if (p.placed[who] === 0) return [STARTS[who]];
    for (s = 0; s < SQ; s++) {
      if (b[s]) continue;
      r = (s / N) | 0; c = s % N;
      if ((r > 0 && b[s - N] === me) || (r < N - 1 && b[s + N] === me) || (c > 0 && b[s - 1] === me) || (c < N - 1 && b[s + 1] === me)) continue;
      if ((r > 0 && c > 0 && b[s - N - 1] === me) || (r > 0 && c < N - 1 && b[s - N + 1] === me) || (r < N - 1 && c > 0 && b[s + N - 1] === me) || (r < N - 1 && c < N - 1 && b[s + N + 1] === me)) out.push(s);
    }
    return out;
  }
  function cornerCount(p, who) { return p.placed[who] === 0 ? 1 : corners(p, who).length; }

  // Every placement of every piece `who` has left (the moves of `who` whoever is to move), without duplicates.
  function placements(p, who) {
    var out = [], seen = {}, cs = corners(p, who), rem = p.rem[who];
    for (var piece = 0; piece < PIECES; piece++) {
      if (!((rem >> piece) & 1)) continue;
      var orients = ORIENT[piece];
      for (var o = 0; o < orients.length; o++) {
        var cells = orients[o].cells;
        for (var ci = 0; ci < cs.length; ci++) {
          var cr = (cs[ci] / N) | 0, cc = cs[ci] % N;
          for (var k = 0; k < cells.length; k++) {
            var ar = cr - cells[k][0], ac = cc - cells[k][1], placed = placeCells(piece, o, ar, ac);
            if (!placed) continue;
            var m = mk(piece, o, ar * N + ac);
            if (seen[m]) continue;
            seen[m] = 1;
            if (problem(p, who, placed) === null) out.push(m);
          }
        }
      }
    }
    return out;
  }
  function moves(p) {
    if (p.passes >= 2) return [];
    var list = placements(p, p.turn);
    return list.length ? list : [PASS];
  }

  function make(p, m) {
    var who = p.turn, rec = { m: m, passes: p.passes, lastWas: p.last[who] };
    if (m === PASS) p.passes++;
    else {
      var cells = cellsOf(m), piece = pieceOf(m);
      cells.forEach(function (s) { p.board[s] = who + 1; });
      p.rem[who] &= ~(1 << piece); p.placed[who]++; p.last[who] = piece; p.passes = 0;
    }
    p.turn = 1 - who; p.undo.push(rec);
  }
  function unmake(p) {
    var rec = p.undo.pop(), who = 1 - p.turn, m = rec.m;
    if (m !== PASS) {
      cellsOf(m).forEach(function (s) { p.board[s] = 0; });
      p.rem[who] |= 1 << pieceOf(m); p.placed[who]--; p.last[who] = rec.lastWas;
    }
    p.passes = rec.passes; p.turn = who;
  }
  function squaresLeft(p, who) { var n = 0; for (var i = 0; i < PIECES; i++) if ((p.rem[who] >> i) & 1) n += SIZE[i]; return n; }
  function scoreOf(p, who) {
    var left = squaresLeft(p, who);
    return -left + (left === 0 ? BONUS_ALL + (p.last[who] === MONO ? BONUS_MONO : 0) : 0);
  }
  function status(p) {
    if (p.passes < 2) return { over: false };
    var a = scoreOf(p, 0), b = scoreOf(p, 1);
    return { over: true, scores: [a, b], winner: a === b ? -1 : a > b ? 0 : 1 };
  }

  // ── the computer ──
  // A move's worth for the player making it: bigger pieces now, more corners to grow from, the other player's corners taken,
  // and early on a push toward the middle where the room is.
  var MID = (N - 1) / 2;
  function worth(p, m, who) {
    var size = SIZE[pieceOf(m)], cells = cellsOf(m), mine0 = cornerCount(p, who), theirs0 = cornerCount(p, 1 - who), d = 0, i;
    make(p, m);
    var mine1 = cornerCount(p, who), theirs1 = cornerCount(p, 1 - who);
    unmake(p);
    for (i = 0; i < cells.length; i++) d += Math.abs(((cells[i] / N) | 0) - MID) + Math.abs((cells[i] % N) - MID);
    d /= cells.length;
    var early = Math.max(0, 8 - p.placed[who]) / 8;
    return size * 4 + (mine1 - mine0) * 2.5 + (theirs0 - theirs1) * 3.5 - d * early * 2 - (size === 1 ? 6 : 0);
  }
  function seeded(seed) { return function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; }
  function adopt(src) {
    var p = newPosition();
    p.board = Int8Array.from(src.board); p.rem = src.rem.slice(); p.placed = src.placed.slice(); p.last = (src.last || [-1, -1]).slice(); p.turn = src.turn; p.passes = src.passes || 0;
    return p;
  }
  function think(src, opts) {
    opts = opts || {};
    var p = adopt(src), who = p.turn, cfg = LEVELS[opts.level] || LEVELS.medium, rng = opts.seed ? seeded(opts.seed) : Math.random;
    var list = moves(p);
    if (list.length === 1) return { move: list[0], score: 0 };
    var scored = list.map(function (m) { return { m: m, s: worth(p, m, who) }; });
    if (cfg.skill === 0) {
      // easy: a random piece among the larger half, so it plays a sensible game of it
      scored.sort(function (a, b) { return SIZE[pieceOf(b.m)] - SIZE[pieceOf(a.m)]; });
      var pool = scored.slice(0, Math.max(1, Math.ceil(scored.length / 2)));
      return { move: pool[Math.floor(rng() * pool.length)].m, score: 0 };
    }
    scored.sort(function (a, b) { return b.s - a.s; });
    if (cfg.skill === 1) {
      var top = scored.slice(0, 4);
      return { move: top[Math.floor(rng() * rng() * top.length)].m, score: top[0].s };   // mostly the best, sometimes the next
    }
    // hard: weigh the best few by the best answer the other player has
    var best = scored[0].m, bestScore = -Infinity;
    scored.slice(0, TOP_FOR_REPLY).forEach(function (c) {
      make(p, c.m);
      var reply = moves(p), top = 0;
      if (p.passes < 2 && reply[0] !== PASS) {
        for (var i = 0; i < reply.length; i++) { var w = worth(p, reply[i], p.turn); if (w > top) top = w; }
      }
      unmake(p);
      var total = c.s - REPLY_WEIGHT * top;
      if (total > bestScore) { bestScore = total; best = c.m; }
    });
    return { move: best, score: bestScore };
  }
  function handle(req) { var r = think(req, req); return { move: r.move }; }

  return {
    N: N, SQ: SQ, PIECES: PIECES, PASS: PASS, ORIENTS: ORIENTS, STARTS: STARTS, TOTAL: TOTAL, SIZE: SIZE, SHAPES: SHAPES, ORIENT: ORIENT, NAMES: NAMES, LEVELS: LEVELS,
    BONUS_ALL: BONUS_ALL, BONUS_MONO: BONUS_MONO,
    newPosition: newPosition, clone: clone, key: key, adopt: adopt, pieceOf: pieceOf, orientOf: orientOf, anchorOf: anchorOf, mk: mk, cellsOf: cellsOf, placeCells: placeCells,
    problem: problem, legal: legal, corners: corners, placements: placements, moves: moves, make: make, unmake: unmake,
    squaresLeft: squaresLeft, scoreOf: scoreOf, status: status, think: think, handle: handle, worth: worth
  };
}
if (typeof globalThis !== 'undefined') globalThis.ZimiPolyominoesEngine = ZimiPolyominoesEngine;
