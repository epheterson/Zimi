/* ZimiGames: the Janggi engine (Korean chess). Our own code, GPL-3.0. No network, no modules.
   One self-contained function so the page can hand its source to a Web Worker through a Blob; the same
   function runs on the main thread as the fallback and under node. It takes the shared searcher
   (enginekit.js: ZimiSearch()) as its argument.
   The rules: the palace with its diagonals, chariots and cannons that follow them, cannons that must
   jump exactly one piece (never a cannon) and never capture a cannon, elephants that step one point
   straight and two across, horses blocked on their leg, soldiers that never go back, a pass when a side
   has no move, and bikjang (the generals face each other with nothing between): a draw. */
function ZimiJanggiEngine(S) {
  'use strict';

  var CHO = 1, HAN = -1;                     // Cho (blue-green) is at the bottom and moves first; Han (red) is at the top
  var P = 1, C = 2, R = 3, H = 4, E = 5, A = 6, G = 7;   // soldier, cannon, chariot, horse, elephant, guard, general
  var LETTERS = ' PCRHEAK', FEN_LETTERS = { P: P, C: C, R: R, H: H, N: H, E: E, B: E, A: A, G: A, K: G };
  var START_FEN = 'rhea1aehr/4k4/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/4K4/RHEA1AEHR w';
  var COLS = 9, ROWS = 10, SQUARES = 90, PASS = 0;
  var MATE = 30000, INF = 32000;
  var QUIET_DRAW_PLIES = 100;                // no capture for fifty moves each: a draw
  // The old counting values, times thirty so the evaluation has room for small things.
  var VALUE = [0, 60, 210, 390, 150, 90, 90, 0], POINTS = [0, 2, 7, 13, 5, 3, 3, 0];
  var HAN_KOMI = 1.5;
  var LEVELS = { easy: { depth: 2, ms: 400, noise: 90 }, medium: { depth: 3, ms: 1200, noise: 12 }, hard: { depth: 5, ms: 3500, noise: 0 } };

  var ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]], DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var HORSE = [[-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0], [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1]];
  var ELEPHANT = [[3, 2], [3, -2], [-3, 2], [-3, -2], [2, 3], [2, -3], [-2, 3], [-2, -3]];

  function mk(a, b) { return a * 128 + b; }
  function from(m) { return m >> 7; }
  function to(m) { return m & 127; }
  function rowOf(s) { return (s / COLS) | 0; }
  function colOf(s) { return s % COLS; }
  function onBoard(r, f) { return r >= 0 && r < ROWS && f >= 0 && f < COLS; }
  function inPalace(color, r, f) { return f >= 3 && f <= 5 && (color === CHO ? r >= 7 && r < ROWS : r >= 0 && r <= 2); }
  // On one of the palace's diagonal lines: a corner or the middle (the 3 x 3 palace, even parity).
  function onPalaceLine(color, r, f) { return inPalace(color, r, f) && (((color === CHO ? r - 7 : r) + f - 3) & 1) === 0; }
  function palaceOf(r, f) { return f >= 3 && f <= 5 ? (r >= 7 ? CHO : r <= 2 ? HAN : 0) : 0; }
  function lineOwner(r, f) { var p = palaceOf(r, f); return p && onPalaceLine(p, r, f) ? p : 0; }
  function squareName(s) { return String.fromCharCode(97 + colOf(s)) + (ROWS - rowOf(s)); }
  function squareFromName(n) { return (ROWS - +n.slice(1)) * COLS + (n.charCodeAt(0) - 97); }
  function kingIdx(color) { return color === CHO ? 0 : 1; }

  function emptyPosition() { return { sq: new Int8Array(SQUARES), turn: CHO, king: [-1, -1], undo: [], noCapture: 0 }; }
  function parseFen(fen) {
    var parts = fen.trim().split(/\s+/), pos = emptyPosition(), r = 0, f = 0;
    for (var i = 0; i < parts[0].length; i++) {
      var ch = parts[0][i];
      if (ch === '/') { r++; f = 0; } else if (ch >= '1' && ch <= '9') f += +ch;
      else {
        var t = FEN_LETTERS[ch.toUpperCase()], color = ch === ch.toUpperCase() ? CHO : HAN;
        pos.sq[r * COLS + f] = color * t;
        if (t === G) pos.king[kingIdx(color)] = r * COLS + f;
        f++;
      }
    }
    pos.turn = parts[1] === 'b' ? HAN : CHO;
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
    return rows.join('/') + ' ' + (pos.turn === CHO ? 'w' : 'b');
  }
  function clone(pos) { var p = emptyPosition(); p.sq.set(pos.sq); p.turn = pos.turn; p.king = pos.king.slice(); p.noCapture = pos.noCapture; return p; }
  function key(pos) { return toFen(pos); }

  // ── the moves ──
  // Every pseudo-legal move of `color` (the general may be left in check) into `out`. With a target square it
  // stops and answers true as soon as a move lands there (used to ask whether a square is attacked).
  function gen(pos, color, out, target) {
    var sq = pos.sq, s, v, t, r, f, i, d, rr, ff, to_, tv;
    // Returns true when the search for `target` is over.
    function add(a, b) {
      var cv = sq[b];
      if (cv * color > 0) return false;
      if (target >= 0) return b === target;
      out.push(mk(a, b)); return false;
    }
    for (s = 0; s < SQUARES; s++) {
      v = sq[s];
      if (v * color <= 0) continue;
      t = v * color; r = rowOf(s); f = colOf(s);
      if (t === R) {
        for (i = 0; i < 4; i++) {
          d = ORTH[i]; rr = r + d[0]; ff = f + d[1];
          while (onBoard(rr, ff)) {
            to_ = rr * COLS + ff; tv = sq[to_];
            if (tv * color <= 0 && add(s, to_)) return true;
            if (tv) break;
            rr += d[0]; ff += d[1];
          }
        }
        var pc = lineOwner(r, f);
        if (pc) {
          for (i = 0; i < 4; i++) {
            d = DIAG[i]; rr = r + d[0]; ff = f + d[1];
            while (onPalaceLine(pc, rr, ff)) {
              to_ = rr * COLS + ff; tv = sq[to_];
              if (tv * color <= 0 && add(s, to_)) return true;
              if (tv) break;
              rr += d[0]; ff += d[1];
            }
          }
        }
      } else if (t === C) {
        for (i = 0; i < 4; i++) {
          d = ORTH[i]; rr = r + d[0]; ff = f + d[1];
          while (onBoard(rr, ff) && !sq[rr * COLS + ff]) { rr += d[0]; ff += d[1]; }
          if (!onBoard(rr, ff) || Math.abs(sq[rr * COLS + ff]) === C) continue;   // no screen, or the screen is a cannon
          rr += d[0]; ff += d[1];
          while (onBoard(rr, ff)) {
            to_ = rr * COLS + ff; tv = sq[to_];
            if (!tv) { if (add(s, to_)) return true; } else {
              if (tv * color < 0 && Math.abs(tv) !== C && add(s, to_)) return true;
              break;
            }
            rr += d[0]; ff += d[1];
          }
        }
        var cp = lineOwner(r, f);
        if (cp && !(r === (cp === CHO ? 8 : 1) && f === 4)) {   // a corner: over the middle to the far corner
          var mr = cp === CHO ? 8 : 1, dr = mr - r, df = 4 - f, scr = sq[mr * COLS + 4];
          if (scr && Math.abs(scr) !== C) {
            to_ = (mr + dr) * COLS + (4 + df); tv = sq[to_];
            if (tv * color <= 0 && Math.abs(tv) !== C && add(s, to_)) return true;
          }
        }
      } else if (t === H) {
        for (i = 0; i < 8; i++) {
          var h = HORSE[i]; rr = r + h[0]; ff = f + h[1];
          if (!onBoard(rr, ff) || sq[(r + h[2]) * COLS + f + h[3]]) continue;
          if (add(s, rr * COLS + ff)) return true;
        }
      } else if (t === E) {
        for (i = 0; i < 8; i++) {
          var e = ELEPHANT[i], sr = e[0] > 0 ? 1 : e[0] < 0 ? -1 : 0, sf = e[1] > 0 ? 1 : -1;
          rr = r + e[0]; ff = f + e[1];
          if (!onBoard(rr, ff)) continue;
          var l1r, l1f, l2r, l2f;
          if (Math.abs(e[0]) === 3) { l1r = r + sr; l1f = f; l2r = r + 2 * sr; l2f = f + sf; } else { l1r = r; l1f = f + sf; l2r = r + (e[0] > 0 ? 1 : -1); l2f = f + 2 * sf; }
          if (sq[l1r * COLS + l1f] || sq[l2r * COLS + l2f]) continue;
          if (add(s, rr * COLS + ff)) return true;
        }
      } else if (t === A || t === G) {
        var pa = color;
        for (i = 0; i < 4; i++) {
          d = ORTH[i]; rr = r + d[0]; ff = f + d[1];
          if (inPalace(pa, rr, ff) && add(s, rr * COLS + ff)) return true;
        }
        if (onPalaceLine(pa, r, f)) {
          for (i = 0; i < 4; i++) {
            d = DIAG[i]; rr = r + d[0]; ff = f + d[1];
            if (onPalaceLine(pa, rr, ff) && add(s, rr * COLS + ff)) return true;
          }
        }
      } else { // soldier
        var fwd = color === CHO ? -1 : 1;
        rr = r + fwd;
        if (onBoard(rr, f) && add(s, rr * COLS + f)) return true;
        if (f > 0 && add(s, r * COLS + f - 1)) return true;
        if (f < COLS - 1 && add(s, r * COLS + f + 1)) return true;
        var enemy = -color;
        if (onPalaceLine(enemy, r, f)) {
          for (i = 0; i < 2; i++) {
            ff = f + (i ? 1 : -1);
            if (onPalaceLine(enemy, rr, ff) && add(s, rr * COLS + ff)) return true;
          }
        }
      }
    }
    return false;
  }

  function attacked(pos, s, by) { return gen(pos, by, null, s); }
  function inCheck(pos, color) { color = color || pos.turn; return attacked(pos, pos.king[kingIdx(color)], -color); }

  function make(pos, m) {
    if (m === PASS) { pos.undo.push({ m: PASS, cap: 0, noCapture: pos.noCapture }); pos.noCapture++; pos.turn = -pos.turn; return; }
    var a = from(m), b = to(m), v = pos.sq[a], cap = pos.sq[b];
    pos.undo.push({ m: m, cap: cap, noCapture: pos.noCapture });
    pos.sq[b] = v; pos.sq[a] = 0;
    if (Math.abs(v) === G) pos.king[kingIdx(v > 0 ? CHO : HAN)] = b;
    pos.noCapture = cap ? 0 : pos.noCapture + 1;
    pos.turn = -pos.turn;
  }
  function unmake(pos) {
    var u = pos.undo.pop();
    pos.turn = -pos.turn; pos.noCapture = u.noCapture;
    if (u.m === PASS) return;
    var a = from(u.m), b = to(u.m), v = pos.sq[b];
    pos.sq[a] = v; pos.sq[b] = u.cap;
    if (Math.abs(v) === G) pos.king[kingIdx(v > 0 ? CHO : HAN)] = a;
  }

  // The legal moves (never the pass).
  function legalMoves(pos) {
    var ms = [], out = [], us = pos.turn;
    gen(pos, us, ms, -1);
    for (var i = 0; i < ms.length; i++) {
      make(pos, ms[i]);
      if (!attacked(pos, pos.king[kingIdx(us)], -us)) out.push(ms[i]);
      unmake(pos);
    }
    return out;
  }
  // What the searcher and the page offer: the legal moves, or the pass when a side that is not in check has none.
  function movesOrPass(pos) {
    var ms = legalMoves(pos);
    return ms.length || inCheck(pos) ? ms : [PASS];
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

  // The generals face each other on a file with nothing between them.
  function bikjang(pos) {
    var a = pos.king[0], b = pos.king[1];
    if (a < 0 || b < 0 || colOf(a) !== colOf(b)) return false;
    for (var s = Math.min(a, b) + COLS; s < Math.max(a, b); s += COLS) if (pos.sq[s]) return false;
    return true;
  }
  // The old count of what is left, Han with its 1.5 komi: [Cho, Han].
  function points(pos) {
    var cho = 0, han = HAN_KOMI;
    for (var s = 0; s < SQUARES; s++) { var v = pos.sq[s]; if (v > 0) cho += POINTS[v]; else if (v < 0) han += POINTS[-v]; }
    return [cho, han];
  }

  function san(pos, m) {
    if (m === PASS) return 'pass';
    return LETTERS[Math.abs(pos.sq[from(m)])] + ' ' + squareName(from(m)) + (pos.sq[to(m)] ? 'x' : '-') + squareName(to(m));
  }

  // The state for the side to move. keys: earlier positions, a third occurrence is a draw.
  function status(pos, keys) {
    var check = inCheck(pos);
    if (bikjang(pos)) return { over: true, result: 'bikjang', check: false };
    var ms = legalMoves(pos);
    if (!ms.length && check) return { over: true, result: 'mate', winner: -pos.turn, check: true };
    if (keys) {
      var k = keys[keys.length - 1], n = 0;
      for (var i = 0; i < keys.length; i++) if (keys[i] === k) n++;
      if (n >= 3) return { over: true, result: 'repetition', check: check };
    }
    if (pos.noCapture >= QUIET_DRAW_PLIES) return { over: true, result: 'quiet', check: check };
    return { over: false, check: check, mustPass: !ms.length };
  }

  // ── evaluation ──
  function evaluate(pos) {
    var score = 0, sq = pos.sq;
    for (var s = 0; s < SQUARES; s++) {
      var v = sq[s];
      if (!v) continue;
      var t = Math.abs(v), color = v > 0 ? CHO : HAN, r = rowOf(s), f = colOf(s), adv = color === CHO ? ROWS - 1 - r : r;   // rows travelled
      var x = VALUE[t];
      if (t === P) x += adv >= 5 ? 20 + (adv - 5) * 6 : 0;
      else if (t === R) x += 4 * (4 - Math.abs(f - 4)) / 4 + (adv >= 2 && adv <= 8 ? 6 : 0);
      else if (t === H || t === C) x += (4 - Math.abs(f - 4)) * 3 + (adv >= 3 && adv <= 8 ? 6 : 0);
      score += color * x;
    }
    return pos.turn * score;
  }

  // ── search, through the shared searcher ──
  var adapter = {
    moves: movesOrPass, make: make, unmake: unmake, evaluate: evaluate,
    order: function (pos, m) { return m === PASS ? -1 : Math.abs(pos.sq[to(m)]) * 100 - Math.abs(pos.sq[from(m)]); },
    terminal: function (pos) {
      if (bikjang(pos)) return 0;
      if (pos.noCapture >= QUIET_DRAW_PLIES) return 0;
      return null;
    },
    extend: function (pos) { return inCheck(pos); },
    noMoves: function (pos, ply) { return -MATE + ply; }
  };
  function think(source, opts) {
    opts = opts || {};
    var pos = typeof source === 'string' ? parseFen(source) : clone(source), cfg = LEVELS[opts.level] || LEVELS.medium;
    var r = S.search(adapter, pos, { depth: opts.depth || cfg.depth, ms: opts.ms || cfg.ms, noise: opts.noise === undefined ? cfg.noise : opts.noise });
    return { move: r.move === null ? 0 : r.move, score: r.score, depth: r.depth, pass: r.move === PASS };
  }
  // The worker's door: { cmd: 'move', fen, level, ms, depth } -> { move, depth }.
  function handle(req) { var r = think(req.fen, req); return { move: r.move, depth: r.depth, pass: r.pass }; }

  return {
    CHO: CHO, HAN: HAN, P: P, C: C, R: R, H: H, E: E, A: A, G: G, COLS: COLS, ROWS: ROWS, PASS: PASS, START_FEN: START_FEN, LEVELS: LEVELS, POINTS: POINTS,
    parseFen: parseFen, toFen: toFen, clone: clone, startPosition: function () { return parseFen(START_FEN); },
    mk: mk, from: from, to: to, rowOf: rowOf, colOf: colOf, squareName: squareName, squareFromName: squareFromName,
    legalMoves: legalMoves, movesOrPass: movesOrPass, make: make, unmake: unmake, findMove: findMove, inCheck: inCheck, perft: perft, attacked: attacked,
    bikjang: bikjang, points: points, san: san, key: key, status: status, evaluate: evaluate, think: think, handle: handle
  };
}
if (typeof globalThis !== 'undefined') globalThis.ZimiJanggiEngine = ZimiJanggiEngine;
