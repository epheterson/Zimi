/* ZimiGames: the Shogi engine (9x9 and Minishogi 5x5). Our own code, GPL-3.0. No network, no modules,
   no dependencies. Rules: drops, promotion (forced where a piece could never move again), no drop of a
   pawn on a file that holds your own unpromoted pawn, no drop that leaves a piece without a move, no
   pawn drop that gives checkmate, repetition (fourfold) as a draw. A small alpha-beta searcher.
   One self-contained function so the page can hand its source to a Web Worker through a Blob. */
function ZimiShogiEngine(Searcher, variant) {
  'use strict';

  var SENTE = 1, GOTE = -1;            // sente (black) moves first and starts at the bottom
  var P = 1, L = 2, N = 3, S = 4, G = 5, B = 6, R = 7, K = 8, PROMOTED = 8;
  var LETTERS = ' PLNSGBRK';
  var MATE = 30000, MAX_PLY = 64, CHECK_TIME_EVERY = 1023, QSEARCH_PLIES = 6;
  var MAX_PLIES = 500;                 // a game this long is called a draw
  var FOURFOLD = 4;
  var VALUE = [0, 90, 315, 405, 495, 540, 855, 990, 0, 540, 540, 540, 540, 0, 945, 1080];
  var HAND_BONUS = 15;                 // a piece in hand is a little more useful than on the board

  var NINE = { n: 9, zone: 3, startSfen: 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1', hand: [P, L, N, S, G, B, R] };
  var FIVE = { n: 5, zone: 1, startSfen: 'rbsgk/4p/5/P4/KGSBR b - 1', hand: [P, S, G, B, R] };
  var V = variant === 'mini' ? FIVE : NINE;
  var SIZE = V.n, SQUARES = SIZE * SIZE, ZONE = V.zone, START_SFEN = V.startSfen;
  var DROPPABLE = V.hand;

  var LEVELS = {
    beginner: { depth: 1, ms: 300, noise: 220 },
    casual: { depth: 2, ms: 700, noise: 70 },
    club: { depth: 6, ms: 1600, noise: 0 },
    strong: { depth: 8, ms: 3800, noise: 0 }
  };

  // ── movement: steps and rays as [dr, df] for sente (forward is row - 1); gote is the mirror ──
  var GOLD_STEPS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]];
  var ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]], DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var BASE_STEPS = [];
  BASE_STEPS[P] = [[-1, 0]];
  BASE_STEPS[N] = [[-2, -1], [-2, 1]];
  BASE_STEPS[S] = [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 1]];
  BASE_STEPS[G] = GOLD_STEPS;
  BASE_STEPS[K] = ORTH.concat(DIAG);
  BASE_STEPS[P + PROMOTED] = BASE_STEPS[L + PROMOTED] = BASE_STEPS[N + PROMOTED] = BASE_STEPS[S + PROMOTED] = GOLD_STEPS;
  BASE_STEPS[B + PROMOTED] = ORTH;
  BASE_STEPS[R + PROMOTED] = DIAG;
  var BASE_RAYS = [];
  BASE_RAYS[L] = [[-1, 0]];
  BASE_RAYS[B] = BASE_RAYS[B + PROMOTED] = DIAG;
  BASE_RAYS[R] = BASE_RAYS[R + PROMOTED] = ORTH;
  var MOVERS = [P, L, N, S, G, K, B, R, P + PROMOTED, L + PROMOTED, N + PROMOTED, S + PROMOTED, B + PROMOTED, R + PROMOTED];
  function oriented(list, color) { return (list || []).map(function (d) { return [d[0] * color, d[1]]; }); }
  var STEPS = { '1': [], '-1': [] }, RAYS = { '1': [], '-1': [] };
  [SENTE, GOTE].forEach(function (c) { MOVERS.forEach(function (t) { STEPS[c][t] = oriented(BASE_STEPS[t], c); RAYS[c][t] = oriented(BASE_RAYS[t], c); }); });

  // A move is one integer: from | to << 7 | promote << 14 | drop << 15. For a drop, `from` holds the piece type.
  function mk(from, to, promote, drop) { return from | (to << 7) | ((promote ? 1 : 0) << 14) | ((drop ? 1 : 0) << 15); }
  function from(m) { return m & 127; }
  function to(m) { return (m >> 7) & 127; }
  function isPromo(m) { return (m >> 14) & 1; }
  function isDrop(m) { return (m >> 15) & 1; }
  function rowOf(s) { return (s / SIZE) | 0; }
  function colOf(s) { return s % SIZE; }
  function inZone(color, r) { return color === SENTE ? r < ZONE : r >= SIZE - ZONE; }
  function sideIdx(color) { return color === SENTE ? 0 : 1; }
  function squareName(s) { return (SIZE - colOf(s)) + String.fromCharCode(97 + rowOf(s)); }
  function squareFromName(name) { return (name.charCodeAt(1) - 97) * SIZE + (SIZE - +name[0]); }

  function emptyPosition() {
    return { sq: new Int8Array(SQUARES), hand: [new Int8Array(8), new Int8Array(8)], turn: SENTE, king: [-1, -1], undo: [], ply: 0 };
  }

  function parseSfen(sfen) {
    var parts = sfen.trim().split(/\s+/), pos = emptyPosition(), r = 0, f = 0, promoted = false;
    for (var i = 0; i < parts[0].length; i++) {
      var ch = parts[0][i];
      if (ch === '/') { r++; f = 0; } else if (ch >= '0' && ch <= '9') f += +ch;
      else if (ch === '+') promoted = true;
      else {
        var t = LETTERS.indexOf(ch.toUpperCase()), color = ch === ch.toUpperCase() ? SENTE : GOTE;
        if (promoted) t += PROMOTED;
        promoted = false;
        pos.sq[r * SIZE + f] = color * t;
        if (t === K) pos.king[sideIdx(color)] = r * SIZE + f;
        f++;
      }
    }
    pos.turn = parts[1] === 'w' ? GOTE : SENTE;
    var h = parts[2] || '-', count = '';
    if (h !== '-') for (i = 0; i < h.length; i++) {
      ch = h[i];
      if (ch >= '0' && ch <= '9') { count += ch; continue; }
      pos.hand[ch === ch.toUpperCase() ? 0 : 1][LETTERS.indexOf(ch.toUpperCase())] += count ? +count : 1;
      count = '';
    }
    return pos;
  }
  function toSfen(pos) {
    var rows = [];
    for (var r = 0; r < SIZE; r++) {
      var row = '', gap = 0;
      for (var f = 0; f < SIZE; f++) {
        var v = pos.sq[r * SIZE + f];
        if (!v) { gap++; continue; }
        if (gap) { row += gap; gap = 0; }
        var ch = pieceLetter(Math.abs(v));
        row += v > 0 ? ch : ch.toLowerCase();
      }
      rows.push(row + (gap || ''));
    }
    var hand = '';
    [0, 1].forEach(function (side) {
      for (var t = R; t >= P; t--) {
        var c = pos.hand[side][t];
        if (!c) continue;
        hand += (c > 1 ? c : '') + (side === 0 ? LETTERS[t] : LETTERS[t].toLowerCase());
      }
    });
    return rows.join('/') + ' ' + (pos.turn === SENTE ? 'b' : 'w') + ' ' + (hand || '-');
  }
  function clone(pos) {
    var p = emptyPosition();
    p.sq.set(pos.sq); p.hand[0].set(pos.hand[0]); p.hand[1].set(pos.hand[1]);
    p.turn = pos.turn; p.king = pos.king.slice(); p.ply = pos.ply;
    return p;
  }
  function key(pos) { return toSfen(pos); }

  // ── attacks ──
  // Is square s attacked by `by`? Looks backwards from s along every way a piece of that colour could arrive.
  function attacked(pos, s, by) {
    var sq = pos.sq, r = rowOf(s), f = colOf(s);
    for (var k = 0; k < MOVERS.length; k++) {
      var t = MOVERS[k], want = by * t, steps = STEPS[by][t], rays = RAYS[by][t], i, d, rr, ff;
      for (i = 0; i < steps.length; i++) {
        d = steps[i]; rr = r - d[0]; ff = f - d[1];
        if (rr >= 0 && rr < SIZE && ff >= 0 && ff < SIZE && sq[rr * SIZE + ff] === want) return true;
      }
      for (i = 0; i < rays.length; i++) {
        d = rays[i]; rr = r - d[0]; ff = f - d[1];
        while (rr >= 0 && rr < SIZE && ff >= 0 && ff < SIZE) {
          var v = sq[rr * SIZE + ff];
          if (v) { if (v === want) return true; break; }
          rr -= d[0]; ff -= d[1];
        }
      }
    }
    return false;
  }
  function inCheck(pos, color) {
    color = color || pos.turn;
    return attacked(pos, pos.king[sideIdx(color)], -color);
  }

  // ── moves ──
  function deadRank(color, t, r) { // could a piece of this type dropped or moved to row r never move again?
    var last = color === SENTE ? 0 : SIZE - 1, second = color === SENTE ? 1 : SIZE - 2;
    if (t === P || t === L) return r === last;
    if (t === N) return r === last || r === second;
    return false;
  }
  function pseudoMoves(pos, onlyCaptures) {
    var sq = pos.sq, turn = pos.turn, out = [], s, v, t, r, f, i, d, rr, ff, target, tv;
    function add(a, b, t0) {
      var base = t0 <= K && t0 !== G && t0 !== K; // promotable: P L N S B R
      var canPromote = base && (inZone(turn, rowOf(a)) || inZone(turn, rowOf(b)));
      if (canPromote) out.push(mk(a, b, true, false));
      if (!(canPromote && deadRank(turn, t0, rowOf(b)))) out.push(mk(a, b, false, false));
    }
    for (s = 0; s < SQUARES; s++) {
      v = sq[s];
      if (v * turn <= 0) continue;
      t = v * turn; r = rowOf(s); f = colOf(s);
      var steps = STEPS[turn][t], rays = RAYS[turn][t];
      for (i = 0; i < steps.length; i++) {
        d = steps[i]; rr = r + d[0]; ff = f + d[1];
        if (rr < 0 || rr >= SIZE || ff < 0 || ff >= SIZE) continue;
        target = rr * SIZE + ff; tv = sq[target];
        if (tv * turn > 0 || (onlyCaptures && !tv)) continue;
        add(s, target, t);
      }
      for (i = 0; i < rays.length; i++) {
        d = rays[i]; rr = r + d[0]; ff = f + d[1];
        while (rr >= 0 && rr < SIZE && ff >= 0 && ff < SIZE) {
          target = rr * SIZE + ff; tv = sq[target];
          if (tv * turn > 0) break;
          if (tv || !onlyCaptures) add(s, target, t);
          if (tv) break;
          rr += d[0]; ff += d[1];
        }
      }
    }
    if (!onlyCaptures) {
      var hand = pos.hand[sideIdx(turn)];
      for (i = 0; i < DROPPABLE.length; i++) {
        t = DROPPABLE[i];
        if (!hand[t]) continue;
        var pawnFiles = null;
        if (t === P) {
          pawnFiles = {};
          for (s = 0; s < SQUARES; s++) if (sq[s] === turn * P) pawnFiles[colOf(s)] = true;
        }
        for (s = 0; s < SQUARES; s++) {
          if (sq[s] || deadRank(turn, t, rowOf(s)) || (pawnFiles && pawnFiles[colOf(s)])) continue;
          out.push(mk(t, s, false, true));
        }
      }
    }
    return out;
  }

  function make(pos, m) {
    var b = to(m), u = { m: m, cap: 0, prev: 0 }, side = sideIdx(pos.turn);
    if (isDrop(m)) {
      pos.sq[b] = pos.turn * from(m);
      pos.hand[side][from(m)]--;
    } else {
      var a = from(m), v = pos.sq[a];
      u.prev = v; u.cap = pos.sq[b];
      if (u.cap) { var base = Math.abs(u.cap) > PROMOTED ? Math.abs(u.cap) - PROMOTED : Math.abs(u.cap); pos.hand[side][base]++; }
      pos.sq[a] = 0;
      pos.sq[b] = isPromo(m) ? v + pos.turn * PROMOTED : v;
      if (Math.abs(v) === K) pos.king[side] = b;
    }
    pos.undo.push(u); pos.turn = -pos.turn; pos.ply++;
  }
  function unmake(pos) {
    var u = pos.undo.pop(), m = u.m, b = to(m);
    pos.turn = -pos.turn; pos.ply--;
    var side = sideIdx(pos.turn);
    if (isDrop(m)) {
      pos.sq[b] = 0;
      pos.hand[side][from(m)]++;
    } else {
      var a = from(m);
      pos.sq[a] = u.prev; pos.sq[b] = u.cap;
      if (u.cap) { var base = Math.abs(u.cap) > PROMOTED ? Math.abs(u.cap) - PROMOTED : Math.abs(u.cap); pos.hand[side][base]--; }
      if (Math.abs(u.prev) === K) pos.king[side] = a;
    }
  }

  function hasLegalMove(pos) { return legalMoves(pos, true).length > 0; }
  // Legal moves for the side to move. `quick` stops at the first one (to ask only "is there any?").
  function legalMoves(pos, quick) {
    var moves = pseudoMoves(pos, false), out = [], us = pos.turn;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      make(pos, m);
      var ok = !attacked(pos, pos.king[sideIdx(us)], -us);
      if (ok && isDrop(m) && from(m) === P && inCheck(pos, -us) && !hasLegalMove(pos)) ok = false; // no pawn-drop mate
      unmake(pos);
      if (ok) { out.push(m); if (quick) break; }
    }
    return out;
  }
  function findMove(pos, a, b, promote, drop) {
    var ms = legalMoves(pos);
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      if (to(m) !== b || !!isDrop(m) !== !!drop || from(m) !== a) continue;
      if (!drop && !!isPromo(m) !== !!promote) continue;
      return m;
    }
    return 0;
  }
  function perft(pos, depth) {
    if (!depth) return 1;
    var ms = legalMoves(pos), n = 0;
    if (depth === 1) return ms.length;
    for (var i = 0; i < ms.length; i++) { make(pos, ms[i]); n += perft(pos, depth - 1); unmake(pos); }
    return n;
  }

  function pieceLetter(t) { return (t > PROMOTED ? '+' : '') + LETTERS[t > PROMOTED ? t - PROMOTED : t]; }
  // The move as text: "P 7g-7f", "B 8h x2b+", "P*5e".
  function san(pos, m) {
    if (isDrop(m)) return LETTERS[from(m)] + '*' + squareName(to(m));
    var t = Math.abs(pos.sq[from(m)]);
    return pieceLetter(t) + ' ' + squareName(from(m)) + (pos.sq[to(m)] ? 'x' : '-') + squareName(to(m)) + (isPromo(m) ? '+' : '');
  }

  // The state for the side to move: checkmate (no legal move), repetition, or a game that has gone on too long.
  function status(pos, keys) {
    var check = inCheck(pos);
    if (!hasLegalMove(pos)) return { over: true, result: 'mate', winner: -pos.turn, check: check };
    if (keys) {
      var k = keys[keys.length - 1], n = 0;
      for (var i = 0; i < keys.length; i++) if (keys[i] === k) n++;
      if (n >= FOURFOLD) return { over: true, result: 'repetition', check: check };
    }
    if (pos.ply >= MAX_PLIES) return { over: true, result: 'long', check: check };
    return { over: false, check: check };
  }

  // ── evaluation ──
  function evaluate(pos) {
    var score = 0, s, v, t, color, r, kingRows = [0, 0];
    for (s = 0; s < SQUARES; s++) {
      v = pos.sq[s];
      if (!v) continue;
      t = Math.abs(v); color = v > 0 ? SENTE : GOTE; r = rowOf(s);
      var adv = color === SENTE ? SIZE - 1 - r : r;   // rows advanced from own back rank
      var bonus = 0;
      if (t === P) bonus = adv * 4;
      else if (t === S || t === G || t === N || t === L) bonus = adv * 2;
      else if (t === B || t === R || t === B + PROMOTED || t === R + PROMOTED) bonus = adv;
      score += color * (VALUE[t] + bonus);
      if (t === K) kingRows[sideIdx(color)] = s;
    }
    // defenders near the king
    for (var side = 0; side < 2; side++) {
      var ks = kingRows[side], kr = rowOf(ks), kf = colOf(ks), color2 = side === 0 ? SENTE : GOTE, guard = 0;
      for (var dr = -2; dr <= 2; dr++) for (var df = -2; df <= 2; df++) {
        var rr = kr + dr, ff = kf + df;
        if (rr < 0 || rr >= SIZE || ff < 0 || ff >= SIZE) continue;
        var w = pos.sq[rr * SIZE + ff] * color2;
        if (w === S || w === G || w === S + PROMOTED || w === P + PROMOTED) guard++;
      }
      score += color2 * Math.min(guard, 4) * 18;
    }
    for (side = 0; side < 2; side++) {
      var c3 = side === 0 ? SENTE : GOTE;
      for (var t2 = P; t2 <= R; t2++) score += c3 * pos.hand[side][t2] * (VALUE[t2] + HAND_BONUS);
    }
    return pos.turn * score;
  }

  // ── search: the shared searcher (enginekit.js), fed this game's moves and order ──
  var MOVE_BITS = 65536;   // moves are < 2^16
  var adapter = {
    cfg: { space: MOVE_BITS, checkEvery: CHECK_TIME_EVERY, qPlies: QSEARCH_PLIES, killers: [50000, 50000], history: MOVE_BITS, repeat: FOURFOLD - 1, standAtLimit: true, checkLimit: MAX_PLY - 1 },
    moves: legalMoves, pseudo: pseudoMoves, make: make, unmake: unmake, evaluate: evaluate, key: key, inCheck: inCheck,
    exposed: function (pos, us) { return attacked(pos, pos.king[sideIdx(us)], -us); },
    rank: function (pos, m) {
      var cap = isDrop(m) ? 0 : Math.abs(pos.sq[to(m)]);
      return cap ? 100000 + VALUE[cap] * 4 - (VALUE[Math.abs(pos.sq[from(m)])] >> 2) + (isPromo(m) ? 500 : 0) : isPromo(m) ? 90000 : 0;
    },
    quiet: function (pos, m) { return isDrop(m) || !pos.sq[to(m)]; },
    histIdx: function (m) { return m; },
    noMoves: function (pos, ply) { return -MATE + ply; }
  };
  // Pick a move for the side to move. opts: { level, ms, depth, seen } -> { move, score, depth }.
  function think(source, opts) {
    opts = opts || {};
    var pos = typeof source === 'string' ? parseSfen(source) : clone(source), cfg = LEVELS[opts.level] || LEVELS.club;
    return (Searcher || globalThis.ZimiSearch()).tactical(adapter, pos, { depth: opts.depth || cfg.depth, ms: opts.ms || cfg.ms, noise: opts.noise === undefined ? cfg.noise : opts.noise, seen: opts.seen });
  }
  function handle(req) { var r = think(req.sfen, req); return { move: r.move, depth: r.depth }; }

  return {
    SENTE: SENTE, GOTE: GOTE, P: P, L: L, N: N, S: S, G: G, B: B, R: R, K: K, PROMOTED: PROMOTED, SIZE: SIZE, ZONE: ZONE,
    START_SFEN: START_SFEN, LEVELS: LEVELS, DROPPABLE: DROPPABLE,
    parseSfen: parseSfen, toSfen: toSfen, clone: clone, startPosition: function () { return parseSfen(START_SFEN); },
    mk: mk, from: from, to: to, isPromo: isPromo, isDrop: isDrop, rowOf: rowOf, colOf: colOf, squareName: squareName, squareFromName: squareFromName,
    legalMoves: legalMoves, make: make, unmake: unmake, findMove: findMove, inCheck: inCheck, perft: perft, attacked: attacked,
    san: san, key: key, status: status, evaluate: evaluate, think: think, handle: handle, inZone: inZone, deadRank: deadRank
  };
}
if (typeof globalThis !== 'undefined') globalThis.ZimiShogiEngine = ZimiShogiEngine;
