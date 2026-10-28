/* ZimiGames: the chess engine. Our own code, GPL-3.0. No network, no modules, no dependencies.
   Rules (legal moves, castling, en passant, promotion, mate, stalemate, draws) and a small
   alpha-beta searcher with piece-square tables.

   It is one self-contained function so the page can hand its source to a Web Worker through a
   Blob (no second file to fetch, which a ZIM reader may not serve for workers) and the same
   function runs on the main thread as the fallback and under node for the tests. */
function ZimiChessEngine(S) {
  'use strict';

  var WHITE = 1, BLACK = -1;
  var P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
  var VALUE = [0, 100, 320, 330, 500, 900, 0];
  var MATE = 30000;
  var CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;
  var FLAG_EP = 1, FLAG_CASTLE = 2, FLAG_DOUBLE = 4;
  var MOVE_SPACE = 262144;       // moves are < 2^18, so score * MOVE_SPACE + move sorts by score
  var QSEARCH_PLIES = 8, MAX_PLY = 64, CHECK_TIME_EVERY = 2047;
  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  var LETTERS = ' PNBRQK';

  // Squares are rank * 8 + file with rank 0 at the top (rank 8), so a1 is 56 and h8 is 7.
  var KNIGHT_STEPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  var KING_STEPS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  var ROOK_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]], BISHOP_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

  function stepTable(steps) {
    var t = [];
    for (var s = 0; s < 64; s++) {
      var r = s >> 3, f = s & 7, list = [];
      for (var i = 0; i < steps.length; i++) {
        var rr = r + steps[i][0], ff = f + steps[i][1];
        if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) list.push(rr * 8 + ff);
      }
      t.push(list);
    }
    return t;
  }
  function rayTable(dirs) {
    var t = [];
    for (var s = 0; s < 64; s++) {
      var rays = [];
      for (var d = 0; d < dirs.length; d++) {
        var r = (s >> 3) + dirs[d][0], f = (s & 7) + dirs[d][1], ray = [];
        while (r >= 0 && r < 8 && f >= 0 && f < 8) { ray.push(r * 8 + f); r += dirs[d][0]; f += dirs[d][1]; }
        rays.push(ray);
      }
      t.push(rays);
    }
    return t;
  }
  var KNIGHT = stepTable(KNIGHT_STEPS), KING = stepTable(KING_STEPS);
  var ROOK_RAYS = rayTable(ROOK_DIRS), BISHOP_RAYS = rayTable(BISHOP_DIRS);

  // Moving from or to one of these squares costs the castling rights in the mask.
  var CASTLE_KEEP = new Int8Array(64).fill(15);
  CASTLE_KEEP[60] = 15 & ~(CASTLE_WK | CASTLE_WQ); CASTLE_KEEP[63] = 15 & ~CASTLE_WK; CASTLE_KEEP[56] = 15 & ~CASTLE_WQ;
  CASTLE_KEEP[4] = 15 & ~(CASTLE_BK | CASTLE_BQ); CASTLE_KEEP[7] = 15 & ~CASTLE_BK; CASTLE_KEEP[0] = 15 & ~CASTLE_BQ;

  // A move is one integer: from, to, the piece promoted to (0 for none), and flags.
  function mk(from, to, promo, flag) { return from | (to << 6) | ((promo || 0) << 12) | ((flag || 0) << 15); }
  function from(m) { return m & 63; }
  function to(m) { return (m >> 6) & 63; }
  function promo(m) { return (m >> 12) & 7; }
  function flag(m) { return m >> 15; }

  // ── positions ──
  function emptyPosition() {
    return { sq: new Int8Array(64), turn: WHITE, castle: 0, ep: -1, half: 0, full: 1, king: [-1, -1], undo: [] };
  }
  function kingIdx(color) { return color === WHITE ? 0 : 1; }

  function parseFen(fen) {
    var parts = fen.trim().split(/\s+/), pos = emptyPosition(), r = 0, f = 0;
    for (var i = 0; i < parts[0].length; i++) {
      var ch = parts[0][i];
      if (ch === '/') { r++; f = 0; } else if (ch >= '1' && ch <= '8') f += +ch;
      else {
        var t = LETTERS.indexOf(ch.toUpperCase()), color = ch === ch.toUpperCase() ? WHITE : BLACK;
        pos.sq[r * 8 + f] = color * t;
        if (t === K) pos.king[kingIdx(color)] = r * 8 + f;
        f++;
      }
    }
    pos.turn = parts[1] === 'b' ? BLACK : WHITE;
    var c = parts[2] || '-';
    pos.castle = (c.indexOf('K') >= 0 ? CASTLE_WK : 0) | (c.indexOf('Q') >= 0 ? CASTLE_WQ : 0) | (c.indexOf('k') >= 0 ? CASTLE_BK : 0) | (c.indexOf('q') >= 0 ? CASTLE_BQ : 0);
    pos.ep = parts[3] && parts[3] !== '-' ? squareFromName(parts[3]) : -1;
    pos.half = +(parts[4] || 0); pos.full = +(parts[5] || 1);
    return pos;
  }
  function squareFromName(n) { return (8 - +n[1]) * 8 + (n.charCodeAt(0) - 97); }
  function squareName(s) { return String.fromCharCode(97 + (s & 7)) + (8 - (s >> 3)); }

  function toFen(pos) {
    var rows = [];
    for (var r = 0; r < 8; r++) {
      var row = '', gap = 0;
      for (var f = 0; f < 8; f++) {
        var v = pos.sq[r * 8 + f];
        if (!v) { gap++; continue; }
        if (gap) { row += gap; gap = 0; }
        var ch = LETTERS[Math.abs(v)];
        row += v > 0 ? ch : ch.toLowerCase();
      }
      rows.push(row + (gap || ''));
    }
    var c = (pos.castle & CASTLE_WK ? 'K' : '') + (pos.castle & CASTLE_WQ ? 'Q' : '') + (pos.castle & CASTLE_BK ? 'k' : '') + (pos.castle & CASTLE_BQ ? 'q' : '');
    return rows.join('/') + ' ' + (pos.turn === WHITE ? 'w' : 'b') + ' ' + (c || '-') + ' ' + (pos.ep >= 0 ? squareName(pos.ep) : '-') + ' ' + pos.half + ' ' + pos.full;
  }

  function clone(pos) {
    var p = emptyPosition();
    p.sq.set(pos.sq); p.turn = pos.turn; p.castle = pos.castle; p.ep = pos.ep; p.half = pos.half; p.full = pos.full; p.king = pos.king.slice();
    return p;
  }

  // ── attacks, moves ──
  function attacked(pos, s, by) {
    var sq = pos.sq, i, list, ray, v;
    // pawns: a pawn of colour `by` attacks diagonally forward, so look one rank back
    var pr = (s >> 3) + (by === WHITE ? 1 : -1), pf = s & 7;
    if (pr >= 0 && pr < 8) {
      if (pf > 0 && sq[pr * 8 + pf - 1] === by * P) return true;
      if (pf < 7 && sq[pr * 8 + pf + 1] === by * P) return true;
    }
    list = KNIGHT[s];
    for (i = 0; i < list.length; i++) if (sq[list[i]] === by * N) return true;
    list = KING[s];
    for (i = 0; i < list.length; i++) if (sq[list[i]] === by * K) return true;
    for (i = 0; i < 4; i++) {
      ray = ROOK_RAYS[s][i];
      for (var j = 0; j < ray.length; j++) {
        v = sq[ray[j]];
        if (v) { if (v === by * R || v === by * Q) return true; break; }
      }
    }
    for (i = 0; i < 4; i++) {
      ray = BISHOP_RAYS[s][i];
      for (var k = 0; k < ray.length; k++) {
        v = sq[ray[k]];
        if (v) { if (v === by * B || v === by * Q) return true; break; }
      }
    }
    return false;
  }
  function inCheck(pos, color) { color = color || pos.turn; return attacked(pos, pos.king[kingIdx(color)], -color); }

  var PROMOS = [Q, R, B, N];
  function addPawnMove(out, f, t, fl, last) {
    if (last) for (var i = 0; i < 4; i++) out.push(mk(f, t, PROMOS[i], fl));
    else out.push(mk(f, t, 0, fl));
  }

  // Pseudo-legal moves (the king may be left in check); `quiet` false means captures and promotions only.
  function generate(pos, capturesOnly) {
    var out = [], sq = pos.sq, us = pos.turn, s, i, list, ray, t, v;
    for (s = 0; s < 64; s++) {
      var p = sq[s] * us;
      if (p <= 0) continue;
      var r = s >> 3, f = s & 7;
      if (p === P) {
        var dir = us === WHITE ? -8 : 8, last = us === WHITE ? 1 : 6, start = us === WHITE ? 6 : 1;
        t = s + dir;
        if (!sq[t] && (!capturesOnly || r === last)) {
          addPawnMove(out, s, t, 0, r === last);
          if (!capturesOnly && r === start && !sq[t + dir]) out.push(mk(s, t + dir, 0, FLAG_DOUBLE));
        }
        for (var df = -1; df <= 1; df += 2) {
          if (f + df < 0 || f + df > 7) continue;
          t = s + dir + df;
          if (sq[t] * us < 0) addPawnMove(out, s, t, 0, r === last);
          else if (t === pos.ep && !sq[t]) out.push(mk(s, t, 0, FLAG_EP));
        }
      } else if (p === N || p === K) {
        list = p === N ? KNIGHT[s] : KING[s];
        for (i = 0; i < list.length; i++) {
          v = sq[list[i]] * us;
          if (v <= 0 && (!capturesOnly || v < 0)) out.push(mk(s, list[i]));
        }
      } else {
        var rays = [];
        if (p !== B) rays = rays.concat(ROOK_RAYS[s]);
        if (p !== R) rays = rays.concat(BISHOP_RAYS[s]);
        for (i = 0; i < rays.length; i++) {
          ray = rays[i];
          for (var j = 0; j < ray.length; j++) {
            v = sq[ray[j]] * us;
            if (v > 0) break;
            if (v < 0) { out.push(mk(s, ray[j])); break; }
            if (!capturesOnly) out.push(mk(s, ray[j]));
          }
        }
      }
    }
    if (!capturesOnly) castling(pos, out);
    return out;
  }

  function castling(pos, out) {
    var us = pos.turn, sq = pos.sq, k = us === WHITE ? 60 : 4, them = -us;
    if (sq[k] !== us * K || !(pos.castle & (us === WHITE ? CASTLE_WK | CASTLE_WQ : CASTLE_BK | CASTLE_BQ))) return;
    if (attacked(pos, k, them)) return;
    if ((pos.castle & (us === WHITE ? CASTLE_WK : CASTLE_BK)) && sq[k + 3] === us * R && !sq[k + 1] && !sq[k + 2] && !attacked(pos, k + 1, them) && !attacked(pos, k + 2, them)) out.push(mk(k, k + 2, 0, FLAG_CASTLE));
    if ((pos.castle & (us === WHITE ? CASTLE_WQ : CASTLE_BQ)) && sq[k - 4] === us * R && !sq[k - 1] && !sq[k - 2] && !sq[k - 3] && !attacked(pos, k - 1, them) && !attacked(pos, k - 2, them)) out.push(mk(k, k - 2, 0, FLAG_CASTLE));
  }

  function make(pos, m) {
    var f = from(m), t = to(m), pr = promo(m), fl = flag(m), sq = pos.sq, us = pos.turn, piece = sq[f], cap = sq[t];
    pos.undo.push(m, cap, pos.castle, pos.ep, pos.half);
    if (fl & FLAG_EP) { var cs = t + (us === WHITE ? 8 : -8); cap = sq[cs]; sq[cs] = 0; pos.undo[pos.undo.length - 4] = cap; }
    sq[t] = pr ? us * pr : piece; sq[f] = 0;
    if (fl & FLAG_CASTLE) {
      if (t > f) { sq[f + 1] = sq[f + 3]; sq[f + 3] = 0; } else { sq[f - 1] = sq[f - 4]; sq[f - 4] = 0; }
    }
    if (piece * us === K) pos.king[kingIdx(us)] = t;
    pos.castle &= CASTLE_KEEP[f] & CASTLE_KEEP[t];
    pos.ep = fl & FLAG_DOUBLE ? (f + t) >> 1 : -1;
    pos.half = (piece * us === P || cap) ? 0 : pos.half + 1;
    if (us === BLACK) pos.full++;
    pos.turn = -us;
  }

  function unmake(pos) {
    var u = pos.undo, half = u.pop(), ep = u.pop(), castle = u.pop(), cap = u.pop(), m = u.pop();
    var f = from(m), t = to(m), pr = promo(m), fl = flag(m), sq = pos.sq, us = -pos.turn;
    pos.turn = us; pos.half = half; pos.ep = ep; pos.castle = castle;
    if (us === BLACK) pos.full--;
    var piece = pr ? us * P : sq[t];
    sq[f] = piece;
    if (fl & FLAG_EP) { sq[t] = 0; sq[t + (us === WHITE ? 8 : -8)] = cap; } else sq[t] = cap;
    if (fl & FLAG_CASTLE) {
      if (t > f) { sq[f + 3] = sq[f + 1]; sq[f + 1] = 0; } else { sq[f - 4] = sq[f - 1]; sq[f - 1] = 0; }
    }
    if (piece * us === K) pos.king[kingIdx(us)] = f;
  }

  function legalMoves(pos) {
    var ps = generate(pos, false), out = [], us = pos.turn;
    for (var i = 0; i < ps.length; i++) {
      make(pos, ps[i]);
      if (!attacked(pos, pos.king[kingIdx(us)], -us)) out.push(ps[i]);
      unmake(pos);
    }
    return out;
  }

  function perft(pos, depth) {
    if (depth === 0) return 1;
    var ms = generate(pos, false), n = 0, us = pos.turn;
    for (var i = 0; i < ms.length; i++) {
      make(pos, ms[i]);
      if (!attacked(pos, pos.king[kingIdx(us)], -us)) n += depth === 1 ? 1 : perft(pos, depth - 1);
      unmake(pos);
    }
    return n;
  }

  function findMove(pos, f, t, pr) {
    var ms = legalMoves(pos);
    for (var i = 0; i < ms.length; i++) if (from(ms[i]) === f && to(ms[i]) === t && (promo(ms[i]) || 0) === (pr || 0)) return ms[i];
    return 0;
  }

  // ── notation ──
  function san(pos, m) {
    var f = from(m), t = to(m), pr = promo(m), fl = flag(m), piece = Math.abs(pos.sq[f]), s;
    if (fl & FLAG_CASTLE) s = t > f ? 'O-O' : 'O-O-O';
    else {
      var capture = pos.sq[t] !== 0 || (fl & FLAG_EP);
      if (piece === P) s = (capture ? squareName(f)[0] + 'x' : '') + squareName(t) + (pr ? '=' + LETTERS[pr] : '');
      else {
        var same = legalMoves(pos).filter(function (o) { return o !== m && to(o) === t && Math.abs(pos.sq[from(o)]) === piece; });
        var tag = '';
        if (same.length) {
          var sameFile = same.some(function (o) { return (from(o) & 7) === (f & 7); }), sameRank = same.some(function (o) { return (from(o) >> 3) === (f >> 3); });
          tag = !sameFile ? squareName(f)[0] : !sameRank ? squareName(f)[1] : squareName(f);
        }
        s = LETTERS[piece] + tag + (capture ? 'x' : '') + squareName(t);
      }
    }
    make(pos, m);
    var check = inCheck(pos), any = legalMoves(pos).length > 0;
    unmake(pos);
    return s + (check ? (any ? '+' : '#') : '');
  }

  // ── game state ──
  // A key for repetition: the pieces, the side to move, castling, and an en passant square only when it can be used.
  function key(pos) {
    var s = '';
    for (var i = 0; i < 64; i++) s += String.fromCharCode(80 + pos.sq[i]);
    var ep = -1;
    if (pos.ep >= 0) {
      var us = pos.turn, pawn = us * P, r = pos.ep >> 3, f = pos.ep & 7, row = r + (us === WHITE ? 1 : -1);
      if ((f > 0 && pos.sq[row * 8 + f - 1] === pawn) || (f < 7 && pos.sq[row * 8 + f + 1] === pawn)) ep = pos.ep;
    }
    return s + pos.turn + ':' + pos.castle + ':' + ep;
  }

  function insufficient(pos) {
    var minors = [], bishopsOn = [];
    for (var i = 0; i < 64; i++) {
      var v = Math.abs(pos.sq[i]);
      if (v === P || v === R || v === Q) return false;
      if (v === N || v === B) { minors.push(v); if (v === B) bishopsOn.push(((i >> 3) + (i & 7)) & 1); }
    }
    if (minors.length <= 1) return true;
    // only bishops, all on the same colour of square
    return minors.every(function (v) { return v === B; }) && bishopsOn.every(function (c) { return c === bishopsOn[0]; });
  }

  // The state of a game: { over, result: 'mate'|'stalemate'|'repetition'|'fifty'|'material'|null, winner: colour or 0 }.
  // `keys` are the keys of every position reached so far, the current one included.
  function status(pos, keys) {
    var ms = legalMoves(pos);
    if (!ms.length) return inCheck(pos) ? { over: true, result: 'mate', winner: -pos.turn, check: true } : { over: true, result: 'stalemate', winner: 0 };
    if (insufficient(pos)) return { over: true, result: 'material', winner: 0 };
    if (pos.half >= 100) return { over: true, result: 'fifty', winner: 0 };
    if (keys) {
      var k = key(pos), n = 0;
      for (var i = 0; i < keys.length; i++) if (keys[i] === k) n++;
      if (n >= 3) return { over: true, result: 'repetition', winner: 0 };
    }
    return { over: false, result: null, winner: 0, check: inCheck(pos) };
  }

  // ── the searcher ──
  var PST = {};
  PST[P] = [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0];
  PST[N] = [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50];
  PST[B] = [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20];
  PST[R] = [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0];
  PST[Q] = [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20];
  var KING_MID = [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20];
  var KING_END = [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50];
  var PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0], FULL_PHASE = 24, BISHOP_PAIR = 30, TEMPO = 10;

  // Score for the side to move, in centipawns.
  function evaluate(pos) {
    var sq = pos.sq, score = 0, phase = 0, bishops = [0, 0, 0], i;
    for (i = 0; i < 64; i++) {
      var v = sq[i];
      if (!v) continue;
      var color = v > 0 ? 1 : -1, t = v * color, idx = color === WHITE ? i : i ^ 56;
      phase += PHASE_WEIGHT[t];
      if (t === B) bishops[color + 1]++;
      if (t !== K) score += color * (VALUE[t] + PST[t][idx]);
    }
    if (phase > FULL_PHASE) phase = FULL_PHASE;
    var wk = pos.king[0], bk = pos.king[1] ^ 56;
    score += (KING_MID[wk] * phase + KING_END[wk] * (FULL_PHASE - phase)) / FULL_PHASE;
    score -= (KING_MID[bk] * phase + KING_END[bk] * (FULL_PHASE - phase)) / FULL_PHASE;
    if (bishops[2] >= 2) score += BISHOP_PAIR;
    if (bishops[0] >= 2) score -= BISHOP_PAIR;
    return (pos.turn === WHITE ? score : -score) + TEMPO;
  }

  // ── search: the shared searcher (enginekit.js), fed this game's moves and order ──
  var adapter = {
    cfg: { space: MOVE_SPACE, checkEvery: CHECK_TIME_EVERY, qPlies: QSEARCH_PLIES, killers: [80000, 79000], history: 8192, repeat: 2, drawAtLeaf: true, checkLimit: MAX_PLY },
    moves: legalMoves, pseudo: generate, make: make, unmake: unmake, evaluate: evaluate, key: key, inCheck: inCheck,
    exposed: function (pos, us) { return attacked(pos, pos.king[kingIdx(us)], -us); },
    rank: function (pos, m) {
      var victim = Math.abs(pos.sq[to(m)]);
      return victim || (flag(m) & FLAG_EP) ? 100000 + (victim || P) * 10 - Math.abs(pos.sq[from(m)]) : promo(m) ? 90000 + promo(m) : 0;
    },
    quiet: function (pos, m) { return !pos.sq[to(m)] && !(flag(m) & FLAG_EP) && !promo(m); },
    histIdx: function (m, us) { return (us === WHITE ? 0 : 4096) + from(m) * 64 + to(m); },
    draw: function (pos) { return pos.half >= 100; },
    noMoves: function (pos, ply) { return inCheck(pos, pos.turn) ? -MATE + ply : 0; }
  };

  // The levels: how deep, how long, and how much the score is blurred so the weaker ones blunder.
  var LEVELS = {
    beginner: { depth: 1, ms: 200, noise: 220 },
    casual: { depth: 2, ms: 400, noise: 70 },
    club: { depth: 6, ms: 900, noise: 0 },
    strong: { depth: 12, ms: 2800, noise: 0 }
  };

  // Pick a move for the side to move. opts: { level, ms, depth, seen } -> { move, score, depth }.
  // `seen` maps position keys to how often they have occurred, so a move that completes a threefold repetition scores as a draw.
  function think(source, opts) {
    opts = opts || {};
    var pos = typeof source === 'string' ? parseFen(source) : clone(source), cfg = LEVELS[opts.level] || LEVELS.club;
    return (S || globalThis.ZimiSearch()).tactical(adapter, pos, { depth: opts.depth || cfg.depth, ms: opts.ms || cfg.ms, noise: opts.noise === undefined ? cfg.noise : opts.noise, seen: opts.seen });
  }
  function handle(req) { var r = think(req.fen, req); return { move: r.move, depth: r.depth, score: r.score }; }

  // What `color` has lost: the piece types gone from the board (pawn..queen, biggest first) and their worth in pawns.
  var START_COUNT = { 1: 8, 2: 2, 3: 2, 4: 2, 5: 1 }, PAWNS = { 1: 1, 2: 3, 3: 3, 4: 5, 5: 9 };
  function takenFrom(pos, color) {
    var have = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, out = [], worth = 0, t, n;
    for (var s = 0; s < 64; s++) { var v = pos.sq[s]; if (v && v * color > 0 && have[Math.abs(v)] !== undefined) have[Math.abs(v)]++; }
    for (t = 5; t >= 1; t--) for (n = START_COUNT[t] - have[t]; n > 0; n--) { out.push(t); worth += PAWNS[t]; }
    return { list: out, worth: worth };
  }

  return {
    WHITE: WHITE, BLACK: BLACK, P: P, N: N, B: B, R: R, Q: Q, K: K, START_FEN: START_FEN, LEVELS: LEVELS,
    CASTLE_WK: CASTLE_WK, CASTLE_WQ: CASTLE_WQ, CASTLE_BK: CASTLE_BK, CASTLE_BQ: CASTLE_BQ,
    parseFen: parseFen, toFen: toFen, clone: clone, startPosition: function () { return parseFen(START_FEN); },
    mk: mk, from: from, to: to, promo: promo, flag: flag, squareName: squareName, squareFromName: squareFromName,
    legalMoves: legalMoves, pseudoMoves: function (pos) { return generate(pos, false); }, attacked: attacked, make: make, unmake: unmake, findMove: findMove, inCheck: inCheck, perft: perft,
    san: san, key: key, status: status, insufficient: insufficient, evaluate: evaluate, think: think, handle: handle, takenFrom: takenFrom
  };
}
if (typeof globalThis !== 'undefined') globalThis.ZimiChessEngine = ZimiChessEngine;
