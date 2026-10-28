/* ZimiGames: the Royal Game of Ur engine (Irving Finkel's rules). Our own code, GPL-3.0. No network, no modules.
   One self-contained function (a Worker is built from its source); it takes the shared searcher only to keep the
   same shape as the other engines (the computer here is an expectimax over the dice, not alpha-beta).
   The rules: seven pieces each; four binary dice (a roll of 0 to 4, one in sixteen for 0 and 4, four in sixteen for 1 and
   3, six in sixteen for 2); each side's path is 14 squares (four of its own, eight shared in the middle, two of its own
   again), then off the board by an exact count; a piece landing on a shared square takes an enemy piece there (it goes
   back to the start); the central rosette is safe and cannot be taken; a piece may not land on a friend; landing on a
   rosette (the fourth, eighth and fourteenth squares) gives another throw; a side with no legal move passes. */
function ZimiUrEngine() {
  'use strict';

  var PIECES = 7, START = 0, OFF = 15, LAST = 14;
  var ROSETTES = [4, 8, 14], CENTRAL = 8, SHARED_FIRST = 5, SHARED_LAST = 12;
  var ROLL_WAYS = [1, 4, 6, 4, 1], ROLL_TOTAL = 16;
  var WIN = 1000;
  var LEVELS = { easy: { depth: 1, noise: 3 }, medium: { depth: 2, noise: 0.4 }, hard: { depth: 4, noise: 0 } };

  function newState() { return { pos: [new Array(PIECES).fill(0), new Array(PIECES).fill(0)], turn: 0, winner: -1 }; }
  function cloneState(st) { return { pos: [st.pos[0].slice(), st.pos[1].slice()], turn: st.turn, winner: st.winner }; }
  function isRosette(k) { return ROSETTES.indexOf(k) >= 0; }
  function isShared(k) { return k >= SHARED_FIRST && k <= SHARED_LAST; }
  function waiting(st, p) { return st.pos[p].filter(function (k) { return k === START; }).length; }
  function home(st, p) { return st.pos[p].filter(function (k) { return k === OFF; }).length; }
  // Where path square k of player p is drawn, on a board of three rows by eight columns; player 0 has row 2 (the near side), 1 has row 0.
  function cell(p, k) {
    var row = p === 0 ? 2 : 0;
    if (k >= 1 && k <= 4) return { row: row, col: 4 - k };
    if (k >= SHARED_FIRST && k <= SHARED_LAST) return { row: 1, col: k - SHARED_FIRST };
    if (k === 13) return { row: row, col: 7 };
    if (k === 14) return { row: row, col: 6 };
    return null;
  }

  // The legal moves for the side to move with this roll: { piece, from, to, capture, rosette, off }.
  // Waiting pieces are interchangeable, so only the first one is offered.
  function legalMoves(st, roll) {
    var p = st.turn, mine = st.pos[p], theirs = st.pos[1 - p], out = [], seenStart = false;
    if (!roll || st.winner >= 0) return out;
    for (var i = 0; i < PIECES; i++) {
      var k = mine[i];
      if (k === OFF) continue;
      if (k === START) { if (seenStart) continue; seenStart = true; }
      var t = k + roll;
      if (t > OFF) continue;
      if (t < OFF && mine.indexOf(t) >= 0) continue;
      var capture = false;
      if (isShared(t)) {
        var hit = theirs.indexOf(t) >= 0;
        if (hit && t === CENTRAL) continue;
        capture = hit;
      }
      out.push({ piece: i, from: k, to: t, capture: capture, rosette: t < OFF && isRosette(t), off: t === OFF });
    }
    return out;
  }
  function apply(st, m) {
    var n = cloneState(st), p = st.turn;
    n.pos[p][m.piece] = m.to;
    if (m.capture) { var j = n.pos[1 - p].indexOf(m.to); n.pos[1 - p][j] = START; }
    if (home(n, p) === PIECES) n.winner = p;
    else if (!m.rosette) n.turn = 1 - p;
    return n;
  }
  function pass(st) { var n = cloneState(st); n.turn = 1 - st.turn; return n; }

  // ── the computer: expectimax over the dice ──
  // From player 0's side of the table; the other side minimises.
  function danger(st, p) {
    // The chance, over one throw, that the enemy takes a piece of p in the shared lane, weighted by how far it has come.
    var total = 0, enemy = st.pos[1 - p];
    st.pos[p].forEach(function (k) {
      if (!isShared(k) || k === CENTRAL) return;
      var chance = 0;
      for (var r = 1; r <= 4; r++) if (enemy.indexOf(k - r) >= 0) chance += ROLL_WAYS[r] / ROLL_TOTAL;
      // an enemy piece still waiting reaches squares one to four, not the shared lane
      total += Math.min(1, chance) * (k + 2);
    });
    return total;
  }
  function evaluate(st) {
    if (st.winner >= 0) return st.winner === 0 ? WIN : -WIN;
    var score = 0, side = [0, 1];
    side.forEach(function (p) {
      var s = 0;
      st.pos[p].forEach(function (k) { s += k === OFF ? 18 : k; if (k === CENTRAL) s += 5; else if (isRosette(k)) s += 1.5; });
      score += (p === 0 ? 1 : -1) * s;
    });
    score += 0.8 * (danger(st, 1) - danger(st, 0));
    score += st.turn === 0 ? 0.6 : -0.6;
    return score;
  }
  function value(st, depth) {
    if (st.winner >= 0 || depth <= 0) return evaluate(st);
    var total = 0;
    for (var r = 0; r <= 4; r++) {
      var moves = legalMoves(st, r), v;
      if (!moves.length) v = value(pass(st), depth - 1);
      else {
        var best = st.turn === 0 ? -Infinity : Infinity;
        for (var i = 0; i < moves.length; i++) {
          var x = value(apply(st, moves[i]), depth - 1);
          if (st.turn === 0 ? x > best : x < best) best = x;
        }
        v = best;
      }
      total += v * ROLL_WAYS[r] / ROLL_TOTAL;
    }
    return total;
  }
  // The index in legalMoves(st, roll) of the move to play, and what each move is worth to the mover.
  function choose(st, roll, level, rnd) {
    var moves = legalMoves(st, roll), cfg = LEVELS[level] || LEVELS.medium, sign = st.turn === 0 ? 1 : -1;
    if (!moves.length) return { index: -1, values: [] };
    var values = moves.map(function (m) { return sign * value(apply(st, m), cfg.depth - 1); });
    var best = -1, top = -Infinity;
    values.forEach(function (v, i) {
      var j = v + ((rnd || Math.random)() - 0.5) * 2 * cfg.noise;
      if (j > top) { top = j; best = i; }
    });
    return { index: best, values: values };
  }
  function handle(req) { var r = choose({ pos: req.pos, turn: req.turn, winner: -1 }, req.roll, req.level); return { index: r.index, values: r.values }; }

  return {
    PIECES: PIECES, OFF: OFF, LAST: LAST, ROSETTES: ROSETTES, CENTRAL: CENTRAL, ROLL_WAYS: ROLL_WAYS, ROLL_TOTAL: ROLL_TOTAL, LEVELS: LEVELS,
    newState: newState, cloneState: cloneState, cell: cell, isRosette: isRosette, isShared: isShared, waiting: waiting, home: home,
    legalMoves: legalMoves, apply: apply, pass: pass, evaluate: evaluate, choose: choose, handle: handle
  };
}
if (typeof globalThis !== 'undefined') globalThis.ZimiUrEngine = ZimiUrEngine;
