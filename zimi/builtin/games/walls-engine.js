/* ZimiGames: the Walls engine. Our own code, GPL-3.0. No network, no modules.
   One self-contained function (a Worker is built from its source); it takes the shared searcher (enginekit.js).
   A race across a 9 x 9 board. Each turn a player either steps a pawn one square or lays one of ten walls, two squares
   long, between squares. A wall may not cross or overlap another and may never shut a pawn off from its goal edge.
   A pawn next to the other jumps over it, or past it to either side when a wall or the edge stands behind. First pawn
   to the far edge wins. A move is a small integer: 0..80 a pawn to that square, 81..144 a flat wall (r * 8 + c),
   145..208 an upright wall. A wall is named by the junction at its middle: row r, column c (0..7), lying between squares
   (r, c), (r, c + 1) below and (r + 1, c), (r + 1, c + 1) above, whichever way it runs.
   Player 0 starts at the bottom (row 8) and runs to row 0; player 1 starts at the top. */
function ZimiWallsEngine(S) {
  'use strict';

  var N = 9, SQ = 81, J = 8, WALLS = 10, FLAT = 81, UPRIGHT = 145, MOVES = 209, MATE = 30000;
  var LEVELS = { easy: { depth: 1, ms: 300, noise: 70 }, medium: { depth: 2, ms: 1500, noise: 10 }, hard: { depth: 3, ms: 4000, noise: 0 } };
  var DIST_WEIGHT = 100, WALL_WEIGHT = 12, TEMPO = 15;
  var START = [76, 4], GOAL_ROW = [0, 8];

  function rowOf(s) { return (s / N) | 0; }
  function colOf(s) { return s % N; }
  function squareName(s) { return String.fromCharCode(97 + colOf(s)) + (N - rowOf(s)); }
  function isFlat(m) { return m >= FLAT && m < UPRIGHT; }
  function isWall(m) { return m >= FLAT; }
  function wallJunction(m) { return (m - (isFlat(m) ? FLAT : UPRIGHT)); }
  function flat(j) { return FLAT + j; }
  function upright(j) { return UPRIGHT + j; }

  function newPosition() {
    return { pawn: START.slice(), left: [WALLS, WALLS], turn: 0, win: -1,
      // below[s]: a wall between s and the square under it; beside[s]: a wall between s and the square to its right
      below: new Uint8Array(SQ), beside: new Uint8Array(SQ), flats: new Uint8Array(J * J), uprights: new Uint8Array(J * J), undo: [] };
  }
  function clone(p) {
    return { pawn: p.pawn.slice(), left: p.left.slice(), turn: p.turn, win: p.win, below: Uint8Array.from(p.below), beside: Uint8Array.from(p.beside),
      flats: Uint8Array.from(p.flats), uprights: Uint8Array.from(p.uprights), undo: [] };
  }
  function key(p) { return p.turn + ':' + p.pawn.join(',') + ':' + p.left.join(',') + ':' + Array.prototype.join.call(p.flats, '') + Array.prototype.join.call(p.uprights, ''); }

  // ── movement ──
  function canStep(p, s, dr, dc) {
    var r = rowOf(s) + dr, c = colOf(s) + dc;
    if (r < 0 || r >= N || c < 0 || c >= N) return false;
    if (dr === 1) return !p.below[s];
    if (dr === -1) return !p.below[s - N];
    if (dc === 1) return !p.beside[s];
    return !p.beside[s - 1];
  }
  var DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  // The squares the pawn of `who` can step or jump to.
  function steps(p, who) {
    var me = p.pawn[who], foe = p.pawn[1 - who], out = [];
    for (var i = 0; i < 4; i++) {
      var dr = DIRS[i][0], dc = DIRS[i][1];
      if (!canStep(p, me, dr, dc)) continue;
      var t = me + dr * N + dc;
      if (t !== foe) { out.push(t); continue; }
      if (canStep(p, foe, dr, dc)) { out.push(foe + dr * N + dc); continue; }
      // the square behind the other pawn is shut: to either side of it instead
      for (var k = 0; k < 4; k++) {
        if (DIRS[k][0] === dr && DIRS[k][1] === dc) continue;
        if (DIRS[k][0] === -dr && DIRS[k][1] === -dc) continue;
        if (canStep(p, foe, DIRS[k][0], DIRS[k][1])) out.push(foe + DIRS[k][0] * N + DIRS[k][1]);
      }
    }
    return out;
  }

  // The shortest walk to the goal edge (pawns ignored, as the rule about shutting a pawn in is), or -1 when there is none.
  // Optionally fills `trail` with the square each square was reached from, and trail.end with the goal square reached.
  function distance(p, who, trail) {
    var start = p.pawn[who], goal = GOAL_ROW[who], seen = new Int8Array(SQ), queue = new Int16Array(SQ), head = 0, tail = 0, dist = new Int8Array(SQ);
    queue[tail++] = start; seen[start] = 1;
    if (trail) trail[start] = -1;
    while (head < tail) {
      var s = queue[head++];
      if (rowOf(s) === goal) { if (trail) trail.end = s; return dist[s]; }
      for (var i = 0; i < 4; i++) {
        if (!canStep(p, s, DIRS[i][0], DIRS[i][1])) continue;
        var t = s + DIRS[i][0] * N + DIRS[i][1];
        if (seen[t]) continue;
        seen[t] = 1; dist[t] = dist[s] + 1; if (trail) trail[t] = s; queue[tail++] = t;
      }
    }
    return -1;
  }

  // ── walls ──
  function wallFits(p, m) {
    var j = wallJunction(m), r = (j / J) | 0, c = j % J;
    if (isFlat(m)) return !p.flats[j] && !p.uprights[j] && !(c > 0 && p.flats[j - 1]) && !(c < J - 1 && p.flats[j + 1]);
    return !p.uprights[j] && !p.flats[j] && !(r > 0 && p.uprights[j - J]) && !(r < J - 1 && p.uprights[j + J]);
  }
  function setWall(p, m, v) {
    var j = wallJunction(m), r = (j / J) | 0, c = j % J, s = r * N + c;
    if (isFlat(m)) { p.flats[j] = v; p.below[s] = v; p.below[s + 1] = v; }
    else { p.uprights[j] = v; p.beside[s] = v; p.beside[s + N] = v; }
  }
  // A wall that may be laid by the player to move: it fits, they have one left, and both pawns still have a way home.
  function wallLegal(p, m) {
    if (p.left[p.turn] < 1 || !wallFits(p, m)) return false;
    setWall(p, m, 1);
    var ok = distance(p, 0) >= 0 && distance(p, 1) >= 0;
    setWall(p, m, 0);
    return ok;
  }

  // ── moves ──
  function pawnMoves(p) { return steps(p, p.turn); }
  // `all`: every legal wall; otherwise only the walls that lengthen the other pawn's way (the ones worth a search).
  function moves(p, all) {
    if (p.win >= 0) return [];
    var out = pawnMoves(p), us = p.turn, them = 1 - us, m;
    if (p.left[us] < 1) return out;
    if (all) {
      for (m = FLAT; m < MOVES; m++) if (wallLegal(p, m)) out.push(m);
      return out;
    }
    var trail = new Int16Array(SQ), base = distance(p, them, trail), s = trail.end, tried = {};
    var also = [], t, from;
    // the walls that stand across the first steps of the other pawn's shortest way, and across the ways round them
    while (trail[s] >= 0) {
      from = trail[s]; t = s;
      var a = Math.min(from, t), horizontal = Math.abs(from - t) === 1, r = rowOf(a), c = colOf(a);
      if (horizontal) { // between squares side by side: an upright wall at junction (r - 1, c) or (r, c)
        if (r > 0) also.push(upright((r - 1) * J + c)); if (r < J) also.push(upright(r * J + c));
      } else {
        if (c > 0) also.push(flat(r * J + c - 1)); if (c < J) also.push(flat(r * J + c));
      }
      s = from;
    }
    also.forEach(function (w) {
      if (tried[w] || w < FLAT || w >= MOVES) return;
      tried[w] = 1;
      var j = wallJunction(w), jr = (j / J) | 0, jc = j % J;
      if (jr < 0 || jr >= J || jc < 0 || jc >= J) return;
      if (p.left[us] < 1 || !wallFits(p, w)) return;
      setWall(p, w, 1);
      var mine = distance(p, us), theirs = distance(p, them);
      setWall(p, w, 0);
      if (mine >= 0 && theirs > base) out.push(w);
    });
    return out;
  }

  function make(p, m) {
    var us = p.turn, rec = { m: m, was: -1, win: p.win };
    if (isWall(m)) { setWall(p, m, 1); p.left[us]--; }
    else { rec.was = p.pawn[us]; p.pawn[us] = m; if (rowOf(m) === GOAL_ROW[us]) p.win = us; }
    p.turn = 1 - us; p.undo.push(rec);
  }
  function unmake(p) {
    var rec = p.undo.pop(), us = 1 - p.turn;
    if (isWall(rec.m)) { setWall(p, rec.m, 0); p.left[us]++; } else p.pawn[us] = rec.was;
    p.win = rec.win; p.turn = us;
  }
  function status(p) { return p.win >= 0 ? { over: true, winner: p.win } : { over: false }; }

  // ── the computer ──
  function evaluate(p) {
    var us = p.turn, mine = distance(p, us), theirs = distance(p, 1 - us);
    if (mine < 0 || theirs < 0) return 0;
    return (theirs - mine) * DIST_WEIGHT + (p.left[us] - p.left[1 - us]) * WALL_WEIGHT + TEMPO;
  }
  var adapter = {
    moves: function (p) { return moves(p, false); },
    make: make, unmake: unmake, evaluate: evaluate,
    // a step toward home first, then the walls that cost the other the most
    order: function (p, m) { return isWall(m) ? 50 : 100 - distanceAfter(p, m); },
    terminal: function (p, ply) { return p.win >= 0 ? -(MATE - ply) : null; },   // the side to move has just lost
    noMoves: function (p, ply) { return -MATE + ply; }
  };
  function distanceAfter(p, m) {
    var us = p.turn, was = p.pawn[us], d;
    p.pawn[us] = m; d = distance(p, us); p.pawn[us] = was;
    return d;
  }
  // A request may carry a seed, so a test (or a replay) gets the same easy moves every time.
  function seeded(seed) { return function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; }
  function adopt(src) {
    var p = newPosition();
    p.pawn = src.pawn.slice(); p.left = src.left.slice(); p.turn = src.turn;
    (src.walls || []).forEach(function (w) { setWall(p, w, 1); });
    return p;
  }
  function think(src, opts) {
    opts = opts || {};
    var p = adopt(src), cfg = LEVELS[opts.level] || LEVELS.medium;
    var r = S.search(adapter, p, { depth: opts.depth || cfg.depth, ms: opts.ms || cfg.ms, noise: opts.noise === undefined ? cfg.noise : opts.noise, rng: opts.seed ? seeded(opts.seed) : undefined });
    return { move: r.move === null ? -1 : r.move, score: r.score, depth: r.depth };
  }
  function handle(req) { var r = think(req, req); return { move: r.move, depth: r.depth }; }
  function walls(p) {
    var out = [], m;
    for (m = FLAT; m < MOVES; m++) if (isFlat(m) ? p.flats[wallJunction(m)] : p.uprights[wallJunction(m)]) out.push(m);
    return out;
  }

  return {
    N: N, J: J, SQ: SQ, WALLS: WALLS, FLAT: FLAT, UPRIGHT: UPRIGHT, MOVES: MOVES, START: START, GOAL_ROW: GOAL_ROW, LEVELS: LEVELS,
    newPosition: newPosition, clone: clone, key: key, adopt: adopt, rowOf: rowOf, colOf: colOf, squareName: squareName,
    isFlat: isFlat, isWall: isWall, wallJunction: wallJunction, flat: flat, upright: upright,
    steps: steps, canStep: canStep, distance: distance, wallFits: wallFits, wallLegal: wallLegal, moves: moves, make: make, unmake: unmake,
    status: status, evaluate: evaluate, think: think, handle: handle, walls: walls
  };
}
if (typeof globalThis !== 'undefined') globalThis.ZimiWallsEngine = ZimiWallsEngine;
