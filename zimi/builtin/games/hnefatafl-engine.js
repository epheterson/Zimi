/* ZimiGames: the Hnefatafl engine (Copenhagen rules, 11 x 11). Our own code, GPL-3.0. No network, no modules.
   One self-contained function (a Worker is built from its source); it takes the shared searcher (enginekit.js).
   The rules: pieces slide like rooks; only the king may stop on the throne or a corner (others may pass the
   empty throne); a piece is captured when it is sandwiched between two enemies on a line (the corners, and the
   throne, count as enemies: the throne always for attackers, for defenders only when it is empty); the king is armed;
   the king is taken by four attackers (three and the empty throne beside it; never on the edge); the king wins
   on a corner. A side with no move loses, and attackers who ring in every defender win. The shieldwall capture is
   an option, off by default; there is no edge-fort rule. A heuristic computer plays either side. */
function ZimiHnefataflEngine(S) {
  'use strict';

  var ATT = 1, DEF = 2, KING = 3, N = 11, SQUARES = 121, THRONE = 60;
  var CORNERS = [0, 10, 110, 120];
  var MATE = 30000;
  var LEVELS = { easy: { depth: 1, ms: 400, noise: 60 }, medium: { depth: 2, ms: 1200, noise: 8 }, hard: { depth: 3, ms: 3500, noise: 0 } };
  var DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  var ATT_VALUE = 100, DEF_VALUE = 230;

  function rowOf(s) { return (s / N) | 0; }
  function colOf(s) { return s % N; }
  function isCorner(s) { return s === 0 || s === 10 || s === 110 || s === 120; }
  function step(s, dr, dc) { var r = rowOf(s) + dr, c = colOf(s) + dc; return r < 0 || r >= N || c < 0 || c >= N ? -1 : r * N + c; }
  function isEdge(s) { var r = rowOf(s), c = colOf(s); return r === 0 || r === N - 1 || c === 0 || c === N - 1; }
  function squareName(s) { return String.fromCharCode(97 + colOf(s)) + (N - rowOf(s)); }
  function mk(a, b) { return a * 128 + b; }
  function from(m) { return m >> 7; }
  function to(m) { return m & 127; }
  function owns(piece, side) { return side === ATT ? piece === ATT : (piece === DEF || piece === KING); }
  function enemyOf(side) { return side === ATT ? DEF : ATT; }

  function initial() {
    var sq = new Int8Array(SQUARES), i;
    function put(r, c, v) { sq[r * N + c] = v; }
    for (i = 3; i <= 7; i++) { put(0, i, ATT); put(10, i, ATT); put(i, 0, ATT); put(i, 10, ATT); }
    put(1, 5, ATT); put(9, 5, ATT); put(5, 1, ATT); put(5, 9, ATT);
    [[3, 5], [4, 4], [4, 5], [4, 6], [5, 3], [5, 4], [5, 6], [5, 7], [6, 4], [6, 5], [6, 6], [7, 5]].forEach(function (p) { put(p[0], p[1], DEF); });
    put(5, 5, KING);
    return sq;
  }
  function newPosition(rules) { return { sq: initial(), turn: ATT, win: 0, shield: !!(rules && rules.shield), undo: [] }; }
  function clone(pos) { return { sq: Int8Array.from(pos.sq), turn: pos.turn, win: pos.win, shield: pos.shield, undo: [] }; }
  function adopt(src) { var p = newPosition({ shield: src.shield }); p.sq.set(src.sq); p.turn = src.turn; p.win = src.win || 0; return p; }
  function key(pos) { return pos.turn + ':' + Array.prototype.join.call(pos.sq, ''); }
  function fromString(str, turn, rules) {
    var pos = newPosition(rules), map = { '.': 0, a: ATT, d: DEF, k: KING };
    for (var i = 0; i < SQUARES; i++) pos.sq[i] = map[str[i]] || 0;
    pos.turn = turn || ATT;
    return pos;
  }

  function moves(pos) {
    var sq = pos.sq, side = pos.turn, out = [];
    for (var s = 0; s < SQUARES; s++) {
      var piece = sq[s];
      if (!owns(piece, side)) continue;
      for (var d = 0; d < 4; d++) {
        var t = step(s, DIRS[d][0], DIRS[d][1]);
        while (t >= 0 && sq[t] === 0) {
          if (piece === KING || (t !== THRONE && !isCorner(t))) out.push(mk(s, t));   // the empty throne may be passed, not stopped on
          t = step(t, DIRS[d][0], DIRS[d][1]);
        }
      }
    }
    return out;
  }

  // Does square b hold or count as an enemy of `victim` for a capture by `side`?
  function hostile(sq, b, side) {
    if (b < 0) return false;
    if (owns(sq[b], side)) return true;
    if (isCorner(b)) return true;
    if (b === THRONE) return side === DEF || sq[THRONE] === 0;   // for attackers capturing a defender the throne is hostile only when empty
    return false;
  }
  function kingTaken(sq, k) {
    if (isEdge(k)) return false;
    for (var d = 0; d < 4; d++) {
      var n = step(k, DIRS[d][0], DIRS[d][1]);
      if (sq[n] === ATT) continue;
      if (n === THRONE && sq[THRONE] === 0) continue;
      return false;
    }
    return true;
  }
  // The four edges: the square at index i along the edge, and which way is inward.
  var EDGES = [
    { cell: function (i) { return i; }, inR: 1, inC: 0 },
    { cell: function (i) { return (N - 1) * N + i; }, inR: -1, inC: 0 },
    { cell: function (i) { return i * N; }, inR: 0, inC: 1 },
    { cell: function (i) { return i * N + N - 1; }, inR: 0, inC: -1 }
  ];
  // The shieldwall: a row of two or more enemy pieces along an edge, bracketed at both ends by our pieces (or a
  // corner), each with one of ours straight inward of it. The move must be one of the pieces that close it.
  function shieldwall(sq, t, side) {
    var caps = [], enemy = enemyOf(side);
    EDGES.forEach(function (e) {
      var i = 0;
      while (i < N) {
        if (sq[e.cell(i)] !== enemy) { i++; continue; }
        var j = i;
        while (j + 1 < N && sq[e.cell(j + 1)] === enemy) j++;
        if (j > i) {
          var left = i > 0 ? e.cell(i - 1) : -1, right = j < N - 1 ? e.cell(j + 1) : -1;
          var ok = hostile(sq, left, side) && hostile(sq, right, side), involved = t === left || t === right;
          for (var k = i; k <= j && ok; k++) {
            var inward = step(e.cell(k), e.inR, e.inC);
            if (!owns(sq[inward], side)) ok = false;
            if (inward === t) involved = true;
          }
          if (ok && involved) for (var q = i; q <= j; q++) caps.push(e.cell(q));
        }
        i = j + 1;
      }
    });
    return caps;
  }

  function make(pos, m) {
    var a = from(m), b = to(m), sq = pos.sq, piece = sq[a], side = pos.turn, caps = [], kingLost = false, d;
    sq[a] = 0; sq[b] = piece;
    for (d = 0; d < 4; d++) {
      var n = step(b, DIRS[d][0], DIRS[d][1]);
      if (n < 0) continue;
      var victim = sq[n];
      if (victim === 0 || owns(victim, side)) continue;
      if (victim === KING) { if (side === ATT && kingTaken(sq, n)) kingLost = true; continue; }
      if (hostile(sq, step(n, DIRS[d][0], DIRS[d][1]), side)) caps.push(n);
    }
    if (pos.shield) shieldwall(sq, b, side).forEach(function (s) { if (caps.indexOf(s) < 0) caps.push(s); });
    var capPieces = caps.map(function (s) { var v = sq[s]; sq[s] = 0; return v; });
    var winBefore = pos.win;
    if (kingLost) pos.win = ATT;
    else if (piece === KING && isCorner(b)) pos.win = DEF;
    pos.undo.push({ a: a, b: b, piece: piece, caps: caps, capPieces: capPieces, win: winBefore });
    pos.turn = enemyOf(side);
  }
  function unmake(pos) {
    var u = pos.undo.pop(), sq = pos.sq;
    sq[u.a] = u.piece; sq[u.b] = 0;
    for (var i = 0; i < u.caps.length; i++) sq[u.caps[i]] = u.capPieces[i];
    pos.win = u.win; pos.turn = owns(u.piece, ATT) ? ATT : DEF;
  }
  function lastCaptures(pos) { var u = pos.undo[pos.undo.length - 1]; return u ? u.caps.slice() : []; }
  function kingSquare(pos) { for (var s = 0; s < SQUARES; s++) if (pos.sq[s] === KING) return s; return -1; }

  // Attackers win by ringing in every defender: no defender or king can reach an edge square.
  function encircled(pos) {
    var sq = pos.sq, seen = new Uint8Array(SQUARES), stack = [], s;
    for (s = 0; s < SQUARES; s++) if (isEdge(s) && sq[s] !== ATT) { seen[s] = 1; stack.push(s); }
    while (stack.length) {
      s = stack.pop();
      for (var d = 0; d < 4; d++) {
        var n = step(s, DIRS[d][0], DIRS[d][1]);
        if (n >= 0 && !seen[n] && sq[n] !== ATT) { seen[n] = 1; stack.push(n); }
      }
    }
    var any = false;
    for (s = 0; s < SQUARES; s++) if ((sq[s] === DEF || sq[s] === KING)) { any = true; if (seen[s]) return false; }
    return any;
  }

  function status(pos, keys) {
    if (pos.win) return { over: true, result: pos.win === ATT ? 'king taken' : 'corner', winner: pos.win };
    if (!moves(pos).length) return { over: true, result: 'blocked', winner: enemyOf(pos.turn) };
    if (encircled(pos)) return { over: true, result: 'ringed', winner: ATT };
    if (keys) {
      var k = keys[keys.length - 1], n = 0;
      for (var i = 0; i < keys.length; i++) if (keys[i] === k) n++;
      if (n >= 3) return { over: true, result: 'repetition', winner: 0 };
    }
    return { over: false, kingThreat: kingLines(pos.sq).corners > 0 };
  }
  function notation(pos, m) { return squareName(from(m)) + '-' + squareName(to(m)); }

  // ── evaluation ──
  // The king's open lines to a corner right now, and the edge squares it could reach from which a corner is open.
  function kingLines(sq) {
    var k = -1, s;
    for (s = 0; s < SQUARES; s++) if (sq[s] === KING) { k = s; break; }
    if (k < 0) return { corners: 0, threats: 0, forks: 0, mobility: 0, dist: 0, king: -1 };
    var corners = 0, threats = 0, mobility = 0, forks = 0;
    function openToCorner(t) {   // t on an edge: is the way along that edge to a corner clear?
      var open = 0;
      for (var d = 0; d < 4; d++) {
        var u = step(t, DIRS[d][0], DIRS[d][1]);
        while (u >= 0 && sq[u] === 0 && !isCorner(u)) u = step(u, DIRS[d][0], DIRS[d][1]);
        if (u >= 0 && isCorner(u) && (rowOf(u) === rowOf(t) || colOf(u) === colOf(t))) open++;
      }
      return open;
    }
    for (var d = 0; d < 4; d++) {
      var t = step(k, DIRS[d][0], DIRS[d][1]);
      while (t >= 0 && sq[t] === 0) { mobility++; if (isEdge(t)) { var o = openToCorner(t); threats += o; if (o >= 2) forks++; } t = step(t, DIRS[d][0], DIRS[d][1]); }
      if (t >= 0 && isCorner(t)) corners++;
    }
    if (isEdge(k)) corners += openToCorner(k);
    var dist = 99;
    CORNERS.forEach(function (c) { dist = Math.min(dist, Math.abs(rowOf(c) - rowOf(k)) + Math.abs(colOf(c) - colOf(k))); });
    return { corners: corners, threats: threats, forks: forks, mobility: mobility, dist: dist, king: k };
  }
  // From the attackers' side of the table.
  function evaluate(pos) {
    var sq = pos.sq, att = 0, def = 0, score = 0, s;
    for (s = 0; s < SQUARES; s++) { if (sq[s] === ATT) att++; else if (sq[s] === DEF) def++; }
    score = att * ATT_VALUE - def * DEF_VALUE;
    var kl = kingLines(sq);
    if (kl.corners >= 2) score -= 6000;                 // two open lines: they cannot both be shut
    else if (kl.corners === 1) score -= pos.turn === DEF ? 6000 : 400;
    score -= kl.threats * (pos.turn === DEF ? 100 : 70);
    // a square the king can reach with a corner open both ways cannot be answered after he gets there
    if (kl.forks >= 2) score -= 5000; else if (kl.forks === 1) score -= pos.turn === DEF ? 5000 : 700;
    score -= kl.mobility * 3;
    score += Math.min(kl.dist, 10) * 6;
    // attackers guarding the corners and pressing the king
    CORNERS.forEach(function (c) {
      var r = rowOf(c), cc = colOf(c), ir = r === 0 ? 1 : -1, ic = cc === 0 ? 1 : -1;
      if (sq[c + ic] === ATT) score += 22;
      if (sq[c + ir * N] === ATT) score += 22;
      if (sq[c + ir * N + ic] === ATT) score += 10;
    });
    if (kl.king >= 0) for (var d = 0; d < 4; d++) { var n = step(kl.king, DIRS[d][0], DIRS[d][1]); if (n >= 0 && sq[n] === ATT) score += 14; }
    return pos.turn === ATT ? score : -score;
  }

  var adapter = {
    moves: moves, make: make, unmake: unmake, evaluate: evaluate,
    order: function (pos, m) {
      var sq = pos.sq, a = from(m), b = to(m), v = 0;
      if (sq[a] === KING) v += isEdge(b) ? 300 : 20;
      if (isEdge(b) && isCorner(b)) v += 5000;
      return v;
    },
    // An open line from the king to a corner with the attackers to move: look one ply further to see whether it can be shut.
    extend: function (pos) { return pos.turn === ATT && kingLines(pos.sq).corners > 0; },
    terminal: function (pos, ply) {
      if (!pos.win) return null;
      return pos.win === pos.turn ? MATE - ply : -MATE + ply;   // the side to move has just lost when the other one won
    },
    noMoves: function (pos, ply) { return -MATE + ply; }
  };
  function think(source, opts) {
    opts = opts || {};
    var pos = adopt(source), cfg = LEVELS[opts.level] || LEVELS.medium;
    var r = S.search(adapter, pos, { depth: opts.depth || cfg.depth, ms: opts.ms || cfg.ms, noise: opts.noise === undefined ? cfg.noise : opts.noise });
    return { move: r.move === null ? 0 : r.move, score: r.score, depth: r.depth };
  }
  function handle(req) { var r = think(req, req); return { move: r.move, depth: r.depth }; }

  return {
    ATT: ATT, DEF: DEF, KING: KING, N: N, SQUARES: SQUARES, THRONE: THRONE, CORNERS: CORNERS, LEVELS: LEVELS,
    newPosition: newPosition, clone: clone, adopt: adopt, key: key, fromString: fromString, mk: mk, from: from, to: to, rowOf: rowOf, colOf: colOf,
    isCorner: isCorner, squareName: squareName, moves: moves, make: make, unmake: unmake, lastCaptures: lastCaptures, kingSquare: kingSquare, encircled: encircled,
    status: status, notation: notation, kingLines: kingLines, evaluate: evaluate, think: think, handle: handle
  };
}
if (typeof globalThis !== 'undefined') globalThis.ZimiHnefataflEngine = ZimiHnefataflEngine;
