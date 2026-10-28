/* ZimiGames: the Makruk engine (Thai chess). Our own code, GPL-3.0. No network, no modules.
   One self-contained function (a Worker is built from its source); it takes the shared searcher (enginekit.js).
   The pieces: Khun (king), Met (a step on a diagonal), Khon (a step on a diagonal or straight ahead), Ma (horse),
   Rua (rook) and Bia (the pawn: one step, takes on the diagonal, becomes a Met on the sixth rank). Check and
   checkmate as in chess, a stalemate is a draw. The counting rules are simplified to a move limit: sixty-four
   moves (each side) without a capture or a Bia move is a draw. */
function ZimiMakrukEngine(S) {
  'use strict';

  var WHITE = 1, BLACK = -1;                 // White is at the bottom and moves first
  var BIA = 1, MA = 2, KHON = 3, MET = 4, RUA = 5, KHUN = 6;
  var LETTERS = ' PNSMRK', FEN_LETTERS = { P: BIA, N: MA, S: KHON, B: KHON, M: MET, Q: MET, R: RUA, K: KHUN };
  var START_FEN = 'rnsmksnr/8/pppppppp/8/8/PPPPPPPP/8/RNSKMSNR w';
  var SIZE = 8, SQUARES = 64, MATE = 30000, INF = 32000;
  var MOVE_LIMIT_PLIES = 128;                // sixty-four moves each, without a capture or a Bia move
  var VALUE = [0, 100, 300, 260, 200, 520, 0];
  var LEVELS = { easy: { depth: 2, ms: 300, noise: 110 }, medium: { depth: 4, ms: 1000, noise: 10 }, hard: { depth: 7, ms: 3000, noise: 0 } };
  var ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]], DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];

  // A move is from * 64 + to, plus 4096 when a Bia becomes a Met.
  var PROMO = 4096;
  function mk(a, b, promo) { return a * 64 + b + (promo ? PROMO : 0); }
  function from(m) { return (m & 4095) >> 6; }
  function to(m) { return m & 63; }
  function isPromo(m) { return m >= PROMO; }
  function rowOf(s) { return s >> 3; }
  function colOf(s) { return s & 7; }
  function onBoard(r, f) { return r >= 0 && r < SIZE && f >= 0 && f < SIZE; }
  function squareName(s) { return String.fromCharCode(97 + colOf(s)) + (SIZE - rowOf(s)); }
  function squareFromName(n) { return (SIZE - +n[1]) * SIZE + (n.charCodeAt(0) - 97); }
  function kingIdx(color) { return color === WHITE ? 0 : 1; }
  // A Bia promotes on the sixth rank: row 2 for White, row 5 for Black.
  function promoRow(color) { return color === WHITE ? 2 : 5; }

  function emptyPosition() { return { sq: new Int8Array(SQUARES), turn: WHITE, king: [-1, -1], undo: [], quiet: 0 }; }
  function parseFen(fen) {
    var parts = fen.trim().split(/\s+/), pos = emptyPosition(), r = 0, f = 0;
    for (var i = 0; i < parts[0].length; i++) {
      var ch = parts[0][i];
      if (ch === '/') { r++; f = 0; } else if (ch >= '1' && ch <= '8') f += +ch;
      else {
        var t = FEN_LETTERS[ch.toUpperCase()], color = ch === ch.toUpperCase() ? WHITE : BLACK;
        pos.sq[r * SIZE + f] = color * t;
        if (t === KHUN) pos.king[kingIdx(color)] = r * SIZE + f;
        f++;
      }
    }
    pos.turn = parts[1] === 'b' ? BLACK : WHITE;
    return pos;
  }
  function toFen(pos) {
    var rows = [];
    for (var r = 0; r < SIZE; r++) {
      var row = '', gap = 0;
      for (var f = 0; f < SIZE; f++) {
        var v = pos.sq[r * SIZE + f];
        if (!v) { gap++; continue; }
        if (gap) { row += gap; gap = 0; }
        var ch = LETTERS[Math.abs(v)];
        row += v > 0 ? ch : ch.toLowerCase();
      }
      rows.push(row + (gap || ''));
    }
    return rows.join('/') + ' ' + (pos.turn === WHITE ? 'w' : 'b');
  }
  function clone(pos) { var p = emptyPosition(); p.sq.set(pos.sq); p.turn = pos.turn; p.king = pos.king.slice(); p.quiet = pos.quiet; return p; }
  function key(pos) { return toFen(pos); }

  // Pseudo-legal moves of `color` (the Khun may be left in check) into `out`.
  function gen(pos, color, out) {
    var sq = pos.sq, s, v, t, r, f, i, d, rr, ff, b, tv;
    function add(a, c, promo) { if (sq[c] * color <= 0) out.push(mk(a, c, promo)); }
    for (s = 0; s < SQUARES; s++) {
      v = sq[s];
      if (v * color <= 0) continue;
      t = v * color; r = rowOf(s); f = colOf(s);
      if (t === RUA) {
        for (i = 0; i < 4; i++) {
          d = ORTH[i]; rr = r + d[0]; ff = f + d[1];
          while (onBoard(rr, ff)) {
            b = rr * SIZE + ff; tv = sq[b];
            if (tv * color <= 0) add(s, b);
            if (tv) break;
            rr += d[0]; ff += d[1];
          }
        }
      } else if (t === MA) {
        for (i = 0; i < 8; i++) { rr = r + KNIGHT[i][0]; ff = f + KNIGHT[i][1]; if (onBoard(rr, ff)) add(s, rr * SIZE + ff); }
      } else if (t === KHUN) {
        for (i = 0; i < 8; i++) { d = i < 4 ? ORTH[i] : DIAG[i - 4]; rr = r + d[0]; ff = f + d[1]; if (onBoard(rr, ff)) add(s, rr * SIZE + ff); }
      } else if (t === MET) {
        for (i = 0; i < 4; i++) { rr = r + DIAG[i][0]; ff = f + DIAG[i][1]; if (onBoard(rr, ff)) add(s, rr * SIZE + ff); }
      } else if (t === KHON) {
        for (i = 0; i < 4; i++) { rr = r + DIAG[i][0]; ff = f + DIAG[i][1]; if (onBoard(rr, ff)) add(s, rr * SIZE + ff); }
        rr = r - color;
        if (onBoard(rr, f)) add(s, rr * SIZE + f);
      } else { // Bia
        rr = r - color;
        if (!onBoard(rr, f)) continue;
        var promo = rr === promoRow(color);
        if (!sq[rr * SIZE + f]) out.push(mk(s, rr * SIZE + f, promo));
        for (i = -1; i <= 1; i += 2) {
          ff = f + i;
          if (ff >= 0 && ff < SIZE && sq[rr * SIZE + ff] * color < 0) out.push(mk(s, rr * SIZE + ff, promo));
        }
      }
    }
  }
  // A Bia attacks only diagonally, so asking whether a square is attacked must not count its straight step.
  function attacked(pos, s, by) {
    var sq = pos.sq, r = rowOf(s), f = colOf(s), i, d, rr, ff, v;
    for (i = 0; i < 4; i++) {   // Rua along the files and ranks, and the Khun's neighbours
      d = ORTH[i]; rr = r + d[0]; ff = f + d[1];
      var first = true;
      while (onBoard(rr, ff)) {
        v = sq[rr * SIZE + ff];
        if (v) { if (v === by * RUA || (first && v === by * KHUN)) return true; break; }
        first = false; rr += d[0]; ff += d[1];
      }
    }
    for (i = 0; i < 4; i++) {
      d = DIAG[i]; rr = r + d[0]; ff = f + d[1];
      if (!onBoard(rr, ff)) continue;
      v = sq[rr * SIZE + ff];
      if (v === by * KHUN || v === by * MET || v === by * KHON) return true;
      if (v === by * BIA && rr === r + by) return true;   // a Bia takes one step towards the far side, so it stands one step behind its target
    }
    // a Khon also covers the square straight ahead of it (one step towards the far side)
    rr = r + by; if (onBoard(rr, f) && sq[rr * SIZE + f] === by * KHON) return true;
    for (i = 0; i < 8; i++) { rr = r + KNIGHT[i][0]; ff = f + KNIGHT[i][1]; if (onBoard(rr, ff) && sq[rr * SIZE + ff] === by * MA) return true; }
    return false;
  }
  function inCheck(pos, color) { color = color || pos.turn; return attacked(pos, pos.king[kingIdx(color)], -color); }

  function make(pos, m) {
    var a = from(m), b = to(m), v = pos.sq[a], cap = pos.sq[b];
    pos.undo.push({ m: m, cap: cap, quiet: pos.quiet });
    pos.sq[b] = isPromo(m) ? (v > 0 ? MET : -MET) : v; pos.sq[a] = 0;
    if (Math.abs(v) === KHUN) pos.king[kingIdx(v > 0 ? WHITE : BLACK)] = b;
    pos.quiet = cap || Math.abs(v) === BIA ? 0 : pos.quiet + 1;
    pos.turn = -pos.turn;
  }
  function unmake(pos) {
    var u = pos.undo.pop(), a = from(u.m), b = to(u.m), v = pos.sq[b];
    pos.sq[a] = isPromo(u.m) ? (v > 0 ? BIA : -BIA) : v; pos.sq[b] = u.cap;
    if (Math.abs(v) === KHUN) pos.king[kingIdx(v > 0 ? WHITE : BLACK)] = a;
    pos.quiet = u.quiet;
    pos.turn = -pos.turn;
  }
  function legalMoves(pos) {
    var ms = [], out = [], us = pos.turn;
    gen(pos, us, ms);
    for (var i = 0; i < ms.length; i++) {
      make(pos, ms[i]);
      if (!attacked(pos, pos.king[kingIdx(us)], -us)) out.push(ms[i]);
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

  function san(pos, m) {
    return LETTERS[Math.abs(pos.sq[from(m)])] + ' ' + squareName(from(m)) + (pos.sq[to(m)] ? 'x' : '-') + squareName(to(m)) + (isPromo(m) ? '=M' : '');
  }

  function status(pos, keys) {
    var check = inCheck(pos), ms = legalMoves(pos);
    if (!ms.length) return check ? { over: true, result: 'mate', winner: -pos.turn, check: true } : { over: true, result: 'stalemate', check: false };
    if (keys) {
      var k = keys[keys.length - 1], n = 0;
      for (var i = 0; i < keys.length; i++) if (keys[i] === k) n++;
      if (n >= 3) return { over: true, result: 'repetition', check: check };
    }
    if (pos.quiet >= MOVE_LIMIT_PLIES) return { over: true, result: 'limit', check: check };
    return { over: false, check: check };
  }

  // ── evaluation ──
  function mopUp(pos, strong) {
    var ek = pos.king[kingIdx(-strong)], sk = pos.king[kingIdx(strong)];
    var edge = Math.min(rowOf(ek), 7 - rowOf(ek), colOf(ek), 7 - colOf(ek)), gap = Math.max(Math.abs(rowOf(ek) - rowOf(sk)), Math.abs(colOf(ek) - colOf(sk)));
    return (3 - edge) * 25 + (7 - gap) * 12;
  }
  function evaluate(pos) {
    var score = 0, sq = pos.sq, bare = [0, 0], pawns = [0, 0];
    for (var s = 0; s < SQUARES; s++) {
      var v = sq[s];
      if (!v) continue;
      var t = Math.abs(v), color = v > 0 ? WHITE : BLACK, r = rowOf(s), f = colOf(s), adv = color === WHITE ? SIZE - 1 - r : r;
      var centre = 3 - Math.max(Math.abs(f - 3.5) - 0.5, Math.abs(r - 3.5) - 0.5);
      var x = VALUE[t];
      if (t === BIA) x += adv * 7 + (adv >= 4 ? 14 : 0);
      else if (t === MA) x += centre * 9;
      else if (t === KHON || t === MET) x += centre * 4;
      else if (t === RUA) x += (adv >= 4 ? 6 : 0);
      if (t === BIA) pawns[color === WHITE ? 0 : 1]++; else if (t !== KHUN) bare[color === WHITE ? 0 : 1] += VALUE[t];
      score += color * x;
    }
    // A side left with a bare Khun is hunted: drive it to the edge and bring the other Khun close.
    if (!bare[1] && !pawns[1] && bare[0]) score += mopUp(pos, WHITE);
    else if (!bare[0] && !pawns[0] && bare[1]) score -= mopUp(pos, BLACK);
    return pos.turn * score;
  }

  var adapter = {
    moves: legalMoves, make: make, unmake: unmake, evaluate: evaluate,
    order: function (pos, m) {
      var cap = Math.abs(pos.sq[to(m)]);
      return (cap ? 1000 + VALUE[cap] * 10 - VALUE[Math.abs(pos.sq[from(m)])] / 10 : 0) + (isPromo(m) ? 800 : 0);
    },
    terminal: function (pos) { return pos.quiet >= MOVE_LIMIT_PLIES ? 0 : null; },
    extend: function (pos) { return inCheck(pos); },
    noMoves: function (pos, ply) { return inCheck(pos) ? -MATE + ply : 0; }
  };
  function think(source, opts) {
    opts = opts || {};
    var pos = typeof source === 'string' ? parseFen(source) : clone(source), cfg = LEVELS[opts.level] || LEVELS.medium;
    var r = S.search(adapter, pos, { depth: opts.depth || cfg.depth, ms: opts.ms || cfg.ms, noise: opts.noise === undefined ? cfg.noise : opts.noise });
    return { move: r.move === null ? 0 : r.move, score: r.score, depth: r.depth };
  }
  function handle(req) { var r = think(req.fen, req); return { move: r.move, depth: r.depth }; }

  return {
    WHITE: WHITE, BLACK: BLACK, BIA: BIA, MA: MA, KHON: KHON, MET: MET, RUA: RUA, KHUN: KHUN, SIZE: SIZE, START_FEN: START_FEN, LEVELS: LEVELS, MOVE_LIMIT_PLIES: MOVE_LIMIT_PLIES,
    parseFen: parseFen, toFen: toFen, clone: clone, startPosition: function () { return parseFen(START_FEN); },
    mk: mk, from: from, to: to, isPromo: isPromo, rowOf: rowOf, colOf: colOf, squareName: squareName, squareFromName: squareFromName,
    pseudo: function (pos, color) { var out = []; gen(pos, color, out); return out; }, legalMoves: legalMoves, make: make, unmake: unmake, findMove: findMove, inCheck: inCheck, perft: perft, attacked: attacked,
    san: san, key: key, status: status, evaluate: evaluate, think: think, handle: handle
  };
}
if (typeof globalThis !== 'undefined') globalThis.ZimiMakrukEngine = ZimiMakrukEngine;
