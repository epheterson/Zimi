/* ZimiGames: the Xiangqi engine. Our own code, GPL-3.0. No network, no modules, no dependencies.
   Rules (palace, river, flying general, cannon screens, blocked horses and elephants, no moves = loss)
   and a small alpha-beta searcher. One self-contained function so the page can hand its source to a
   Web Worker through a Blob; the same function runs on the main thread as the fallback and under node. */
function ZimiXiangqiEngine(S) {
  'use strict';

  var RED = 1, BLACK = -1;
  var P = 1, C = 2, R = 3, H = 4, E = 5, A = 6, G = 7;           // soldier, cannon, rook, horse, elephant, advisor, general
  var LETTERS = ' PCRHEAG', FEN_LETTERS = { P: P, C: C, R: R, H: H, N: H, E: E, B: E, A: A, K: G, G: G };
  var START_FEN = 'rheakaehr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RHEAKAEHR w';
  var COLS = 9, ROWS = 10, SQUARES = 90;
  var MATE = 30000, MAX_PLY = 64, CHECK_TIME_EVERY = 1023, QSEARCH_PLIES = 6;
  var NO_CAPTURE_DRAW_PLIES = 120;   // the sixty-move rule, in plies
  var VALUE = [0, 100, 450, 900, 400, 200, 200, 0];
  var SOLDIER_CROSSED = 100;         // a soldier over the river is worth about twice as much

  var ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]], DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var HORSE = [[-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0], [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1]]; // dr, df, leg dr, leg df
  var LEVELS = {
    beginner: { depth: 2, ms: 300, noise: 140 },
    casual: { depth: 3, ms: 700, noise: 40 },
    club: { depth: 5, ms: 1500, noise: 0 },
    strong: { depth: 8, ms: 3500, noise: 0 }
  };

  // A move is one integer: from * 128 + to (both < 90).
  function mk(from, to) { return from * 128 + to; }
  function from(m) { return m >> 7; }
  function to(m) { return m & 127; }
  function rowOf(s) { return (s / COLS) | 0; }
  function colOf(s) { return s % COLS; }
  function inPalace(color, r, f) { return f >= 3 && f <= 5 && (color === RED ? r >= 7 && r < ROWS : r >= 0 && r <= 2); }
  function ownSide(color, r) { return color === RED ? r >= 5 : r <= 4; }
  function squareName(s) { return String.fromCharCode(97 + colOf(s)) + (ROWS - 1 - rowOf(s)); }
  function squareFromName(n) { return (ROWS - 1 - +n[1]) * COLS + (n.charCodeAt(0) - 97); }

  function emptyPosition() { return { sq: new Int8Array(SQUARES), turn: RED, king: [-1, -1], undo: [], noCapture: 0 }; }
  function kingIdx(color) { return color === RED ? 0 : 1; }

  function parseFen(fen) {
    var parts = fen.trim().split(/\s+/), pos = emptyPosition(), r = 0, f = 0;
    for (var i = 0; i < parts[0].length; i++) {
      var ch = parts[0][i];
      if (ch === '/') { r++; f = 0; } else if (ch >= '1' && ch <= '9') f += +ch;
      else {
        var t = FEN_LETTERS[ch.toUpperCase()], color = ch === ch.toUpperCase() ? RED : BLACK;
        pos.sq[r * COLS + f] = color * t;
        if (t === G) pos.king[kingIdx(color)] = r * COLS + f;
        f++;
      }
    }
    pos.turn = parts[1] === 'b' ? BLACK : RED;
    return pos;
  }
  function toFen(pos) {
    var rows = [];
    for (var r = 0; r < ROWS; r++) {
      var row = '', gap = 0;
      for (var f = 0; f < COLS; f++) {
        var v = pos.sq[r * COLS + f];
        if (!v) { gap++; continue; }
        if (gap) { row += gap; gap = 0; }
        var ch = LETTERS[Math.abs(v)];
        row += v > 0 ? ch : ch.toLowerCase();
      }
      rows.push(row + (gap || ''));
    }
    return rows.join('/').replace(/G/g, 'K').replace(/g/g, 'k') + ' ' + (pos.turn === RED ? 'w' : 'b');   // the general is written K, as in every xiangqi FEN
  }
  function clone(pos) {
    var p = emptyPosition();
    p.sq.set(pos.sq); p.turn = pos.turn; p.king = pos.king.slice(); p.noCapture = pos.noCapture;
    return p;
  }
  function key(pos) { return toFen(pos); }

  // ── attacks ──
  // The first piece met walking from s in direction (dr, df), as a square index or -1.
  function firstPiece(sq, s, dr, df) {
    var r = rowOf(s) + dr, f = colOf(s) + df;
    while (r >= 0 && r < ROWS && f >= 0 && f < COLS) {
      if (sq[r * COLS + f]) return r * COLS + f;
      r += dr; f += df;
    }
    return -1;
  }

  // Is square s attacked by `by`? Covers the flying general (a general that sees the other down an open file).
  function attacked(pos, s, by) {
    var sq = pos.sq, r = rowOf(s), f = colOf(s), i, p, d;
    for (i = 0; i < 4; i++) {
      d = ORTH[i];
      p = firstPiece(sq, s, d[0], d[1]);
      if (p >= 0) {
        if (sq[p] === by * R) return true;
        if (sq[p] === by * G && d[1] === 0) return true;
        var p2 = firstPiece(sq, p, d[0], d[1]);
        if (p2 >= 0 && sq[p2] === by * C) return true;
      }
    }
    for (i = 0; i < 8; i++) {   // a horse at (r - dr, f - df) moving by (dr, df), its leg beside it
      var h = HORSE[i], hr = r - h[0], hf = f - h[1];
      if (hr < 0 || hr >= ROWS || hf < 0 || hf >= COLS || sq[hr * COLS + hf] !== by * H) continue;
      if (!sq[(hr + h[2]) * COLS + hf + h[3]]) return true;
    }
    var back = by === RED ? 1 : -1;   // a soldier attacks straight ahead, and sideways once across the river
    var sr = r + back;
    if (sr >= 0 && sr < ROWS && sq[sr * COLS + f] === by * P) return true;
    if (!ownSide(by, r)) {
      if (f > 0 && sq[r * COLS + f - 1] === by * P) return true;
      if (f < COLS - 1 && sq[r * COLS + f + 1] === by * P) return true;
    }
    return false;
  }
  function inCheck(pos, color) {
    color = color || pos.turn;
    return attacked(pos, pos.king[kingIdx(color)], -color);
  }

  // ── moves ──
  function pseudoMoves(pos, onlyCaptures) {
    var sq = pos.sq, turn = pos.turn, out = [], s, v, t, r, f, i, d, rr, ff, to_, tv;
    function add(from_, target) {
      var cv = sq[target];
      if (cv * turn > 0) return;
      if (onlyCaptures && !cv) return;
      out.push(mk(from_, target));
    }
    for (s = 0; s < SQUARES; s++) {
      v = sq[s];
      if (v * turn <= 0) continue;
      t = v * turn; r = rowOf(s); f = colOf(s);
      if (t === R) {
        for (i = 0; i < 4; i++) {
          d = ORTH[i]; rr = r + d[0]; ff = f + d[1];
          while (rr >= 0 && rr < ROWS && ff >= 0 && ff < COLS) {
            to_ = rr * COLS + ff; tv = sq[to_];
            if (tv * turn <= 0) add(s, to_);
            if (tv) break;
            rr += d[0]; ff += d[1];
          }
        }
      } else if (t === C) {
        for (i = 0; i < 4; i++) {
          d = ORTH[i]; rr = r + d[0]; ff = f + d[1];
          var screen = false;
          while (rr >= 0 && rr < ROWS && ff >= 0 && ff < COLS) {
            to_ = rr * COLS + ff; tv = sq[to_];
            if (!screen) {
              if (!tv) { if (!onlyCaptures) out.push(mk(s, to_)); } else screen = true;
            } else if (tv) {
              if (tv * turn < 0) out.push(mk(s, to_));
              break;
            }
            rr += d[0]; ff += d[1];
          }
        }
      } else if (t === H) {
        for (i = 0; i < 8; i++) {
          var h = HORSE[i]; rr = r + h[0]; ff = f + h[1];
          if (rr < 0 || rr >= ROWS || ff < 0 || ff >= COLS) continue;
          if (sq[(r + h[2]) * COLS + f + h[3]]) continue;
          add(s, rr * COLS + ff);
        }
      } else if (t === E) {
        for (i = 0; i < 4; i++) {
          d = DIAG[i]; rr = r + 2 * d[0]; ff = f + 2 * d[1];
          if (rr < 0 || rr >= ROWS || ff < 0 || ff >= COLS || !ownSide(turn, rr)) continue;
          if (sq[(r + d[0]) * COLS + f + d[1]]) continue;
          add(s, rr * COLS + ff);
        }
      } else if (t === A) {
        for (i = 0; i < 4; i++) {
          d = DIAG[i]; rr = r + d[0]; ff = f + d[1];
          if (inPalace(turn, rr, ff)) add(s, rr * COLS + ff);
        }
      } else if (t === G) {
        for (i = 0; i < 4; i++) {
          d = ORTH[i]; rr = r + d[0]; ff = f + d[1];
          if (inPalace(turn, rr, ff)) add(s, rr * COLS + ff);
        }
      } else { // soldier
        var fwd = turn === RED ? -1 : 1;
        rr = r + fwd;
        if (rr >= 0 && rr < ROWS) add(s, rr * COLS + f);
        if (!ownSide(turn, r)) {
          if (f > 0) add(s, r * COLS + f - 1);
          if (f < COLS - 1) add(s, r * COLS + f + 1);
        }
      }
    }
    return out;
  }

  function make(pos, m) {
    var a = from(m), b = to(m), v = pos.sq[a], cap = pos.sq[b];
    pos.undo.push({ m: m, cap: cap, noCapture: pos.noCapture });
    pos.sq[b] = v; pos.sq[a] = 0;
    if (Math.abs(v) === G) pos.king[kingIdx(v > 0 ? RED : BLACK)] = b;
    pos.noCapture = cap ? 0 : pos.noCapture + 1;
    pos.turn = -pos.turn;
  }
  function unmake(pos) {
    var u = pos.undo.pop(), a = from(u.m), b = to(u.m), v = pos.sq[b];
    pos.sq[a] = v; pos.sq[b] = u.cap;
    if (Math.abs(v) === G) pos.king[kingIdx(v > 0 ? RED : BLACK)] = a;
    pos.noCapture = u.noCapture;
    pos.turn = -pos.turn;
  }

  function legalMoves(pos) {
    var moves = pseudoMoves(pos), out = [], us = pos.turn;
    for (var i = 0; i < moves.length; i++) {
      make(pos, moves[i]);
      if (!attacked(pos, pos.king[kingIdx(us)], -us)) out.push(moves[i]);
      unmake(pos);
    }
    return out;
  }
  function findMove(pos, a, b) {
    var ms = legalMoves(pos);
    for (var i = 0; i < ms.length; i++) if (from(ms[i]) === a && to(ms[i]) === b) return ms[i];
    return 0;
  }
  function perft(pos, depth) {
    if (!depth) return 1;
    var ms = legalMoves(pos), n = 0;
    if (depth === 1) return ms.length;
    for (var i = 0; i < ms.length; i++) { make(pos, ms[i]); n += perft(pos, depth - 1); unmake(pos); }
    return n;
  }

  // The move as text: the piece, where from, where to ("C b2-e2", "R a0xa9").
  function san(pos, m) {
    var v = Math.abs(pos.sq[from(m)]);
    return LETTERS[v] + ' ' + squareName(from(m)) + (pos.sq[to(m)] ? 'x' : '-') + squareName(to(m));
  }

  // The state of the game for the side to move. Having no legal move is a loss in xiangqi.
  // `seen` counts earlier occurrences of positions (by key); a third occurrence is a draw.
  function status(pos, keys) {
    var ms = legalMoves(pos), check = inCheck(pos);
    if (!ms.length) return { over: true, result: 'mate', winner: -pos.turn, check: check };
    if (keys) {
      var k = keys[keys.length - 1], n = 0;
      for (var i = 0; i < keys.length; i++) if (keys[i] === k) n++;
      if (n >= 3) return { over: true, result: 'repetition', check: check };
    }
    if (pos.noCapture >= NO_CAPTURE_DRAW_PLIES) return { over: true, result: 'sixty', check: check };
    return { over: false, check: check };
  }

  // ── evaluation ──
  // Small tables, from Red's view with row 9 as Red's back rank: advancing soldiers and centralised horses and cannons.
  function pstValue(t, r, f, color) {
    var rr = color === RED ? r : ROWS - 1 - r;           // 9 = own back rank, 0 = enemy back rank
    var fc = 4 - Math.abs(f - 4);                        // 0 edge .. 4 centre
    if (t === P) return rr <= 4 ? SOLDIER_CROSSED + (4 - rr) * 8 + fc * 4 : 0;
    if (t === H) return fc * 6 + (rr <= 6 ? 10 : 0);
    if (t === C) return fc * 3 + (rr >= 2 && rr <= 8 ? 6 : 0);
    if (t === R) return (rr <= 6 ? 8 : 0) + (f === 4 ? 4 : 0);
    if (t === A || t === E) return (f === 4 ? 6 : 0);
    return 0;
  }
  function evaluate(pos) {
    var score = 0, soldiersLeft = 0;
    for (var s = 0; s < SQUARES; s++) {
      var v = pos.sq[s];
      if (!v) continue;
      var t = Math.abs(v), color = v > 0 ? RED : BLACK;
      score += color * (VALUE[t] + pstValue(t, rowOf(s), colOf(s), color));
      if (t === P) soldiersLeft++;
    }
    return pos.turn * score;
  }

  // ── search: the shared searcher (enginekit.js), fed this game's moves and order ──
  var adapter = {
    cfg: { space: 16384, checkEvery: CHECK_TIME_EVERY, qPlies: QSEARCH_PLIES, killers: [50000, 50000], history: 16384, repeat: 2, standAtLimit: true, checkLimit: MAX_PLY - 1 },
    moves: legalMoves, pseudo: pseudoMoves, make: make, unmake: unmake, evaluate: evaluate, key: key, inCheck: inCheck,
    exposed: function (pos, us) { return attacked(pos, pos.king[kingIdx(us)], -us); },
    rank: function (pos, m) { var cap = Math.abs(pos.sq[to(m)]); return cap ? 100000 + VALUE[cap] * 16 - VALUE[Math.abs(pos.sq[from(m)])] : 0; },
    quiet: function (pos, m) { return !pos.sq[to(m)]; },
    histIdx: function (m) { return (from(m) * 128 + to(m)) & 16383; },
    kingTaken: function (pos, m) { return Math.abs(pos.sq[to(m)]) === G; },
    draw: function (pos) { return pos.noCapture >= NO_CAPTURE_DRAW_PLIES; },
    noMoves: function (pos, ply) { return -MATE + ply; }
  };
  // Pick a move for the side to move. opts: { level, ms, depth, seen } -> { move, score, depth }.
  // `seen` maps position keys to how often they have occurred: a move that makes a third occurrence scores as a draw.
  function think(source, opts) {
    opts = opts || {};
    var pos = typeof source === 'string' ? parseFen(source) : clone(source), cfg = LEVELS[opts.level] || LEVELS.club;
    return (S || globalThis.ZimiSearch()).tactical(adapter, pos, { depth: opts.depth || cfg.depth, ms: opts.ms || cfg.ms, noise: opts.noise === undefined ? cfg.noise : opts.noise, seen: opts.seen });
  }
  function handle(req) { var r = think(req.fen, req); return { move: r.move, depth: r.depth }; }

  return {
    RED: RED, BLACK: BLACK, P: P, C: C, R: R, H: H, E: E, A: A, G: G, COLS: COLS, ROWS: ROWS, START_FEN: START_FEN, LEVELS: LEVELS,
    parseFen: parseFen, toFen: toFen, clone: clone, startPosition: function () { return parseFen(START_FEN); },
    mk: mk, from: from, to: to, rowOf: rowOf, colOf: colOf, squareName: squareName, squareFromName: squareFromName,
    legalMoves: legalMoves, make: make, unmake: unmake, findMove: findMove, inCheck: inCheck, perft: perft, attacked: attacked,
    san: san, key: key, status: status, evaluate: evaluate, think: think, handle: handle
  };
}
if (typeof globalThis !== 'undefined') globalThis.ZimiXiangqiEngine = ZimiXiangqiEngine;
