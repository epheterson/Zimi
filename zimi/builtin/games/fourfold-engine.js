/* ZimiGames: the Fourfold engine. Our own code, GPL-3.0. No network, no modules.
   One self-contained function (a Worker is built from its source); it takes the shared searcher (enginekit.js).
   Sixteen pieces, each with four traits (tall or short, dark or light, round or square, hollow or solid), on a 4 x 4
   board. A turn is two acts: place the piece the other player handed you, then hand them one of the pieces left. Whoever
   places a piece that completes a row, a column or a diagonal of four sharing a trait wins. A full board is a draw.
   A piece is 0..15 (bit 0 tall, bit 1 dark, bit 2 round, bit 3 hollow). A move is square * 17 + the piece handed over
   (16 when nothing is left to hand over, or the placement wins), and the very first move, which only hands over a piece,
   is 272 + the piece. Squares are numbered row by row from the top left. */
function ZimiFourfoldEngine(S) {
  'use strict';

  var SQ = 16, PIECES = 16, NONE = 16, OPENING = 272, MOVES_END = 289, MATE = 30000, DRAW = 2;
  var LEVELS = { easy: { depth: 1, ms: 300, noise: 45, careless: 0.3 }, medium: { depth: 2, ms: 1500, noise: 8, careless: 0 }, hard: { depth: 3, ms: 3500, noise: 0, careless: 0 } };
  var EXACT_EMPTIES = 6, EXACT_DEPTH = 12, PARITY = 40;
  var TRAITS = 4, TRAIT_MASK = 15;
  var LINES = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15], [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15], [0, 5, 10, 15], [3, 6, 9, 12]];
  var LINES_AT = (function () {
    var at = [], i;
    for (i = 0; i < SQ; i++) at.push([]);
    LINES.forEach(function (l) { l.forEach(function (s) { at[s].push(l); }); });
    return at;
  })();

  function newPosition() { return { sq: new Int8Array(SQ), given: -1, turn: 0, win: -1, used: 0, undo: [] }; }
  function clone(p) { return { sq: Int8Array.from(p.sq), given: p.given, turn: p.turn, win: p.win, used: p.used, undo: [] }; }
  function key(p) { return p.turn + ':' + p.given + ':' + Array.prototype.join.call(p.sq, ','); }
  function pieceAt(p, s) { return p.sq[s] - 1; }
  function trait(piece, t) { return (piece >> t) & 1; }
  function isOpening(m) { return m >= OPENING; }
  function squareOf(m) { return isOpening(m) ? -1 : (m / 17) | 0; }
  function giveOf(m) { var g = isOpening(m) ? m - OPENING : m % 17; return g === NONE ? -1 : g; }
  function mk(s, g) { return s * 17 + (g < 0 ? NONE : g); }

  // The line through `s` made of four pieces that share a trait, once `s` holds `piece`; its squares, else null.
  function wins(p, s, piece) {
    for (var i = 0; i < LINES_AT[s].length; i++) {
      var l = LINES_AT[s][i], and = piece, nor = ~piece & TRAIT_MASK, full = true;
      for (var k = 0; k < 4; k++) {
        if (l[k] === s) continue;
        var v = p.sq[l[k]];
        if (!v) { full = false; break; }
        and &= v - 1; nor &= ~(v - 1) & TRAIT_MASK;
      }
      if (full && (and || nor)) return l;
    }
    return null;
  }
  // Which pieces would complete a line for whoever places them: a bit mask over the 16 pieces.
  function danger(p) {
    var mask = 0;
    LINES.forEach(function (l) {
      var empty = -1, count = 0, and = TRAIT_MASK, nor = TRAIT_MASK, k;
      for (k = 0; k < 4; k++) {
        var v = p.sq[l[k]];
        if (!v) { empty = l[k]; continue; }
        count++; and &= v - 1; nor &= ~(v - 1) & TRAIT_MASK;
      }
      if (count !== 3) return;
      for (var piece = 0; piece < PIECES; piece++) {
        if ((p.used >> piece) & 1) continue;
        if ((piece & and) || (~piece & nor & TRAIT_MASK)) mask |= 1 << piece;
      }
    });
    return mask;
  }
  function unused(p) { var out = []; for (var i = 0; i < PIECES; i++) if (!((p.used >> i) & 1)) out.push(i); return out; }
  function empties(p) { var out = []; for (var i = 0; i < SQ; i++) if (!p.sq[i]) out.push(i); return out; }

  // `all`: every legal move; otherwise only the sensible ones: a winning placement when there is one, else each square with
  // the pieces that do not hand the other player a win (one piece, any, when every piece does).
  function moves(p, all) {
    if (p.win >= 0) return [];
    var out = [], i, g;
    if (p.given < 0) { for (g = 0; g < PIECES; g++) if (!((p.used >> g) & 1)) out.push(OPENING + g); return out; }
    var empty = empties(p), winning = [];
    empty.forEach(function (s) { if (wins(p, s, p.given)) winning.push(mk(s, -1)); });
    if (winning.length && !all) return winning;
    var left = unused(p);
    empty.forEach(function (s) {
      if (all && winning.indexOf(mk(s, -1)) >= 0) { out.push(mk(s, -1)); return; }
      if (empty.length === 1) { out.push(mk(s, -1)); return; }
      p.sq[s] = p.given + 1;
      var bad = danger(p), safe = [];
      for (i = 0; i < left.length; i++) if (!((bad >> left[i]) & 1)) safe.push(left[i]);
      p.sq[s] = 0;
      var gives = all ? left : safe.length ? safe : [left[0]];
      gives.forEach(function (gv) { out.push(mk(s, gv)); });
    });
    return out;
  }
  function legal(p, m) { return moves(p, true).indexOf(m) >= 0; }

  function make(p, m) {
    var rec = { m: m, given: p.given, win: p.win, used: p.used };
    if (isOpening(m)) { p.given = m - OPENING; p.used |= 1 << p.given; }
    else {
      var s = squareOf(m), g = giveOf(m);
      p.sq[s] = p.given + 1;
      if (wins(p, s, p.given)) { p.win = p.turn; p.given = -1; }
      else if (g < 0) { p.win = DRAW; p.given = -1; }   // nothing left to hand over: the board is full
      else { p.given = g; p.used |= 1 << g; }
    }
    p.turn = 1 - p.turn; p.undo.push(rec);
  }
  function unmake(p) {
    var rec = p.undo.pop(), m = rec.m;
    p.turn = 1 - p.turn;
    if (!isOpening(m)) p.sq[squareOf(m)] = 0;
    p.given = rec.given; p.win = rec.win; p.used = rec.used;
  }
  function status(p) {
    if (p.win < 0) return { over: false };
    return p.win === DRAW ? { over: true, draw: true } : { over: true, winner: p.win };
  }
  function winningLine(p) {
    for (var i = 0; i < LINES.length; i++) {
      var l = LINES[i], and = TRAIT_MASK, nor = TRAIT_MASK, full = true;
      for (var k = 0; k < 4; k++) { var v = p.sq[l[k]]; if (!v) { full = false; break; } and &= v - 1; nor &= ~(v - 1) & TRAIT_MASK; }
      if (full && (and || nor)) return l.slice();
    }
    return null;
  }
  // The traits the four pieces of a line share, as [trait index, 0 or 1] pairs.
  function sharedTraits(p, line) {
    var out = [], t;
    for (t = 0; t < TRAITS; t++) {
      var v = trait(p.sq[line[0]] - 1, t), same = true;
      for (var k = 1; k < 4; k++) if (trait(p.sq[line[k]] - 1, t) !== v) same = false;
      if (same) out.push([t, v]);
    }
    return out;
  }

  // ── the computer ──
  function evaluate(p) {
    // The side to move places the piece in hand, then hands one over. Count the pieces that are safe to hand over: with
    // an odd number the side to move takes the last of them, and the other side is the one who runs out.
    var bad = danger(p), safe = 0, left = unused(p);
    for (var i = 0; i < left.length; i++) if (!((bad >> left[i]) & 1)) safe++;
    return safe % 2 ? PARITY : -PARITY;
  }
  var adapter = {
    moves: function (p) { return moves(p, false); },
    make: make, unmake: unmake, evaluate: evaluate,
    terminal: function (p, ply) { return p.win < 0 ? null : p.win === DRAW ? 0 : -(MATE - ply); },   // the side to move has just lost
    noMoves: function () { return 0; }
  };
  function seeded(seed) { return function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; }
  function adopt(src) {
    var p = newPosition();
    for (var i = 0; i < SQ; i++) { p.sq[i] = src.sq[i]; if (src.sq[i]) p.used |= 1 << (src.sq[i] - 1); }
    p.given = src.given; p.turn = src.turn;
    if (p.given >= 0) p.used |= 1 << p.given;
    return p;
  }
  function think(src, opts) {
    opts = opts || {};
    var p = adopt(src), cfg = LEVELS[opts.level] || LEVELS.medium, rng = opts.seed ? seeded(opts.seed) : Math.random;
    if (cfg.careless && rng() < cfg.careless) {
      var any = moves(p, true);
      if (any.length) return { move: any[Math.floor(rng() * any.length)], score: 0, depth: 0 };
    }
    var left = empties(p).length;
    var depth = left <= EXACT_EMPTIES ? Math.max(cfg.depth, EXACT_DEPTH) : cfg.depth;
    var r = S.search(adapter, p, { depth: opts.depth || depth, ms: opts.ms || cfg.ms, noise: opts.noise === undefined ? cfg.noise : opts.noise, rng: rng });
    return { move: r.move === null ? -1 : r.move, score: r.score, depth: r.depth };
  }
  function handle(req) { var r = think(req, req); return { move: r.move, depth: r.depth }; }

  return {
    SQ: SQ, PIECES: PIECES, NONE: NONE, OPENING: OPENING, LINES: LINES, LEVELS: LEVELS, DRAW: DRAW,
    newPosition: newPosition, clone: clone, key: key, adopt: adopt, pieceAt: pieceAt, trait: trait, isOpening: isOpening, squareOf: squareOf, giveOf: giveOf, mk: mk,
    wins: wins, danger: danger, unused: unused, empties: empties, moves: moves, legal: legal, make: make, unmake: unmake, status: status,
    winningLine: winningLine, sharedTraits: sharedTraits, evaluate: evaluate, think: think, handle: handle
  };
}
if (typeof globalThis !== 'undefined') globalThis.ZimiFourfoldEngine = ZimiFourfoldEngine;
