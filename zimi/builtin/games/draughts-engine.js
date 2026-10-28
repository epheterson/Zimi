/* ZimiGames: the International draughts engine (10 x 10). Our own code, GPL-3.0. No network, no modules.
   One self-contained function (a Worker is built from its source); it takes the shared searcher (enginekit.js).
   The rules: men step forward on a diagonal and capture forwards and backwards; kings fly (any distance on a
   diagonal, and any landing square beyond a captured piece); captures are compulsory, and the player must take
   the sequence that captures the most pieces (the majority rule); captured pieces stay on the board until the
   move is over, so no piece is jumped twice and none can be passed; a man that only passes the far row during a
   capture is not crowned. A draw: the same position three times, or twenty-five moves each of kings alone. */
function ZimiDraughtsEngine(S) {
  'use strict';

  var WHITE = 1, BLACK = -1, N = 10, SQUARES = 100;
  var MAN = 1, KING = 2;                       // a piece is colour * MAN or colour * KING
  var MATE = 30000;
  var QUIET_DRAW_PLIES = 50;                   // twenty-five moves each of king moves with no capture
  var MAN_VALUE = 100, KING_VALUE = 320;
  var LEVELS = { easy: { depth: 2, ms: 300, noise: 70 }, medium: { depth: 6, ms: 900, noise: 0 }, hard: { depth: 12, ms: 2500, noise: 0 } };
  var DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

  function isDark(s) { return ((((s / N) | 0) + (s % N)) & 1) === 1; }
  function rowOf(s) { return (s / N) | 0; }
  function colOf(s) { return s % N; }
  // The official numbers: 1 to 50 over the dark squares from the top left (Black's side) to the bottom right.
  function numberOf(s) { return (rowOf(s) * 5 + (colOf(s) >> 1)) + 1; }
  function squareOfNumber(n) { var r = ((n - 1) / 5) | 0, k = (n - 1) % 5; return r * N + 2 * k + (r & 1 ? 0 : 1); }

  function initial() {
    var sq = new Int8Array(SQUARES);
    for (var s = 0; s < SQUARES; s++) { if (!isDark(s)) continue; var r = rowOf(s); if (r < 4) sq[s] = BLACK * MAN; else if (r > 5) sq[s] = WHITE * MAN; }
    return sq;
  }
  function newPosition() { return { sq: initial(), turn: WHITE, undo: [], quiet: 0 }; }
  function clone(pos) { return { sq: Int8Array.from(pos.sq), turn: pos.turn, undo: [], quiet: pos.quiet }; }
  function key(pos) { return pos.turn + ':' + Array.prototype.join.call(pos.sq, ''); }
  // A compact position from a string of 100 characters (. w W b B), White to move unless told otherwise: for tests.
  function fromString(str, turn) {
    var pos = newPosition(), map = { '.': 0, w: MAN, W: KING, b: -MAN, B: -KING };
    for (var i = 0; i < SQUARES; i++) pos.sq[i] = map[str[i]] || 0;
    pos.turn = turn || WHITE;
    return pos;
  }

  function crownRow(color) { return color === WHITE ? 0 : N - 1; }
  function on(r, c) { return r >= 0 && r < N && c >= 0 && c < N; }

  // Every capture sequence of the piece on `from`, longest first lists are filtered by the caller.
  // A move: { from, to, path: [landing squares], caps: [captured squares], crown: bool }.
  function capturesFrom(sq, from, out) {
    var piece = sq[from], color = piece > 0 ? WHITE : BLACK, king = Math.abs(piece) === KING;
    var caps = [], path = [], taken = {};
    function visit(at) {
      var found = false, r = rowOf(at), c = colOf(at), d, dr, dc;
      for (d = 0; d < 4; d++) {
        dr = DIRS[d][0]; dc = DIRS[d][1];
        var rr = r + dr, cc = c + dc, over = -1;
        if (king) {
          while (on(rr, cc)) {
            var s0 = rr * N + cc;
            if (sq[s0] === 0 || s0 === from) { rr += dr; cc += dc; continue; }   // an empty square, or the square the king left
            over = s0; break;
          }
          if (over < 0 || taken[over] || sq[over] * color >= 0) continue;
          rr = rowOf(over) + dr; cc = colOf(over) + dc;
          var lands = [];
          while (on(rr, cc) && (sq[rr * N + cc] === 0 || rr * N + cc === from)) { lands.push(rr * N + cc); rr += dr; cc += dc; }
          if (!lands.length) continue;
          found = true; taken[over] = true; caps.push(over);
          for (var k = 0; k < lands.length; k++) { path.push(lands[k]); visit(lands[k]); path.pop(); }
          caps.pop(); delete taken[over];
        } else {
          over = rr * N + cc;
          if (!on(rr, cc) || taken[over] || sq[over] * color >= 0) continue;
          var lr = rr + dr, lc = cc + dc;
          if (!on(lr, lc)) continue;
          var land = lr * N + lc;
          if (sq[land] !== 0 && land !== from) continue;
          found = true; taken[over] = true; caps.push(over); path.push(land);
          visit(land);
          caps.pop(); path.pop(); delete taken[over];
        }
      }
      if (!found && caps.length) {
        out.push({ from: from, to: at, path: path.slice(), caps: caps.slice(), crown: !king && rowOf(at) === crownRow(color) });
      }
    }
    visit(from);
  }

  // The legal moves: captures are compulsory and the longest sequence must be taken.
  function moves(pos) {
    var sq = pos.sq, color = pos.turn, caps = [], s, best = 0, i;
    for (s = 0; s < SQUARES; s++) if (sq[s] * color > 0) capturesFrom(sq, s, caps);
    if (caps.length) {
      for (i = 0; i < caps.length; i++) if (caps[i].caps.length > best) best = caps[i].caps.length;
      return caps.filter(function (m) { return m.caps.length === best; });
    }
    var out = [];
    for (s = 0; s < SQUARES; s++) {
      var v = sq[s];
      if (v * color <= 0) continue;
      var r = rowOf(s), c = colOf(s);
      if (Math.abs(v) === MAN) {
        var rr = r - color;
        for (var dc = -1; dc <= 1; dc += 2) {
          var cc = c + dc;
          if (on(rr, cc) && sq[rr * N + cc] === 0) out.push({ from: s, to: rr * N + cc, path: [rr * N + cc], caps: [], crown: rr === crownRow(color) });
        }
      } else {
        for (var d = 0; d < 4; d++) {
          var r2 = r + DIRS[d][0], c2 = c + DIRS[d][1];
          while (on(r2, c2) && sq[r2 * N + c2] === 0) { out.push({ from: s, to: r2 * N + c2, path: [r2 * N + c2], caps: [], crown: false }); r2 += DIRS[d][0]; c2 += DIRS[d][1]; }
        }
      }
    }
    return out;
  }

  function make(pos, m) {
    var sq = pos.sq, piece = sq[m.from], capped = [], i;
    for (i = 0; i < m.caps.length; i++) { capped.push(sq[m.caps[i]]); sq[m.caps[i]] = 0; }
    sq[m.from] = 0;
    sq[m.to] = m.crown ? piece * KING : piece;
    pos.undo.push({ m: m, piece: piece, capped: capped, quiet: pos.quiet });
    pos.quiet = (m.caps.length || Math.abs(piece) === MAN) ? 0 : pos.quiet + 1;
    pos.turn = -pos.turn;
  }
  function unmake(pos) {
    var u = pos.undo.pop(), m = u.m, sq = pos.sq;
    sq[m.to] = 0; sq[m.from] = u.piece;
    for (var i = 0; i < m.caps.length; i++) sq[m.caps[i]] = u.capped[i];
    pos.quiet = u.quiet; pos.turn = -pos.turn;
  }
  function perft(pos, depth) {
    var ms = moves(pos);
    if (depth <= 1) return ms.length;
    var n = 0;
    for (var i = 0; i < ms.length; i++) { make(pos, ms[i]); n += perft(pos, depth - 1); unmake(pos); }
    return n;
  }

  function status(pos, keys) {
    var ms = moves(pos);
    if (!ms.length) return { over: true, result: 'win', winner: -pos.turn };
    if (keys) {
      var k = keys[keys.length - 1], n = 0;
      for (var i = 0; i < keys.length; i++) if (keys[i] === k) n++;
      if (n >= 3) return { over: true, result: 'repetition' };
    }
    if (pos.quiet >= QUIET_DRAW_PLIES) return { over: true, result: 'quiet' };
    return { over: false, mustCapture: ms[0].caps.length > 0 };
  }
  function notation(m) { return numberOf(m.from) + (m.caps.length ? 'x' : '-') + numberOf(m.to); }

  // ── evaluation ──
  function evaluate(pos) {
    var sq = pos.sq, score = 0;
    for (var s = 0; s < SQUARES; s++) {
      var v = sq[s];
      if (!v) continue;
      var color = v > 0 ? WHITE : BLACK, r = rowOf(s), c = colOf(s), x;
      if (Math.abs(v) === KING) x = KING_VALUE + (c >= 2 && c <= 7 && r >= 2 && r <= 7 ? 12 : 0);
      else {
        var adv = color === WHITE ? N - 1 - r : r;
        x = MAN_VALUE + adv * 4 + (c >= 3 && c <= 6 ? 3 : 0) + (adv === 0 ? 8 : 0);
      }
      score += color * x;
    }
    return pos.turn * score;
  }

  var adapter = {
    moves: moves, make: make, unmake: unmake, evaluate: evaluate,
    order: function (pos, m) { return m.caps.length * 100 + (m.crown ? 50 : 0); },
    terminal: function (pos) { return pos.quiet >= QUIET_DRAW_PLIES ? 0 : null; },
    extend: function (pos) { var ms = moves(pos); return ms.length > 0 && ms[0].caps.length > 0; },
    noMoves: function (pos, ply) { return -MATE + ply; }
  };
  // `source` is a position, or { sq: [100 numbers], turn, quiet } from the page (a plain object crosses into a Worker).
  function adopt(src) { var p = newPosition(); p.sq.set(src.sq); p.turn = src.turn; p.quiet = src.quiet || 0; return p; }
  function think(source, opts) {
    opts = opts || {};
    var pos = adopt(source), cfg = LEVELS[opts.level] || LEVELS.medium;
    var r = S.search(adapter, pos, { depth: opts.depth || cfg.depth, ms: opts.ms || cfg.ms, noise: opts.noise === undefined ? cfg.noise : opts.noise });
    return { move: r.move, score: r.score, depth: r.depth };
  }
  // The worker's door: the page sends the position, gets back the index of the chosen move in moves(pos).
  function handle(req) {
    var pos = adopt(req), r = think(pos, req), ms = moves(pos);
    var idx = -1;
    for (var i = 0; i < ms.length && r.move; i++) if (ms[i].from === r.move.from && ms[i].to === r.move.to && ms[i].caps.join() === r.move.caps.join() && ms[i].path.join() === r.move.path.join()) idx = i;
    return { index: idx, depth: r.depth };
  }

  return {
    WHITE: WHITE, BLACK: BLACK, MAN: MAN, KING: KING, N: N, SQUARES: SQUARES, LEVELS: LEVELS, QUIET_DRAW_PLIES: QUIET_DRAW_PLIES,
    newPosition: newPosition, clone: clone, key: key, fromString: fromString, isDark: isDark, rowOf: rowOf, colOf: colOf, numberOf: numberOf, squareOfNumber: squareOfNumber,
    moves: moves, make: make, unmake: unmake, perft: perft, status: status, notation: notation, evaluate: evaluate, think: think, handle: handle
  };
}
if (typeof globalThis !== 'undefined') globalThis.ZimiDraughtsEngine = ZimiDraughtsEngine;
