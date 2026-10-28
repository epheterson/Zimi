/* ZimiGames: the rules and the computer player for Go. Our own code, GPL-3.0. One factory,
   makeGoEngine(), with no outside names, so the page can both call it and print its source
   into a Worker made from a Blob. Pure functions only: testable in node, no document.
   Boards are Int8Array(n*n): 0 empty, 1 black, 2 white. Black plays first. */
function makeGoEngine() {
  'use strict';
  var BLACK = 1, WHITE = 2, KOMI = 6.5, AREA_KOMI = 7, PLAYOUT_CAP = 2;
  var NB = {}, STAMP = 0, SEEN = null, LIBSEEN = null, STACK = null, GROUP = null;

  function other(c) { return 3 - c; }
  function neighbors(n) {
    if (NB[n]) return NB[n];
    var out = [];
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      var l = [];
      if (r > 0) l.push((r - 1) * n + c);
      if (c > 0) l.push(r * n + c - 1);
      if (c < n - 1) l.push(r * n + c + 1);
      if (r < n - 1) l.push((r + 1) * n + c);
      out.push(l);
    }
    return (NB[n] = out);
  }
  function scratch(size) {
    if (!SEEN || SEEN.length < size) { SEEN = new Int32Array(size); LIBSEEN = new Int32Array(size); STACK = new Int32Array(size); GROUP = new Int32Array(size); STAMP = 0; }
  }

  // Flood the group at idx. Leaves its stones in GROUP[0..count) and returns {count, libs, lib}
  // where lib is one of its liberties (the only one when libs is 1).
  var gCount = 0, gLibs = 0, gLib = -1;
  // With maxLibs the flood stops once that many liberties are found (the group is then partial).
  function flood(b, n, idx, maxLibs) {
    maxLibs = maxLibs || 1e9;
    var nb = neighbors(n), color = b[idx], sp = 0, stamp = ++STAMP;
    gCount = 0; gLibs = 0; gLib = -1;
    STACK[sp++] = idx; SEEN[idx] = stamp;
    while (sp) {
      var i = STACK[--sp], list = nb[i];
      GROUP[gCount++] = i;
      for (var k = 0; k < list.length; k++) {
        var j = list[k], v = b[j];
        if (v === color) { if (SEEN[j] !== stamp) { SEEN[j] = stamp; STACK[sp++] = j; } }
        else if (v === 0 && LIBSEEN[j] !== stamp) { LIBSEEN[j] = stamp; gLibs++; gLib = j; if (gLibs >= maxLibs) return; }
      }
    }
  }

  // ── the rules ──────────────────────────────────────────────────────────
  function newGame(n) { return { n: n, board: new Int8Array(n * n), turn: BLACK, caps: [0, 0], ko: -1, passes: 0, last: -1, moves: 0 }; }

  // Play color at idx on board b in place. Returns the number of stones taken, or -1 when
  // the move is illegal (occupied, suicide). Sets play.ko to the point a ko forbids next.
  var play = { ko: -1, taken: [] };
  function place(b, n, idx, color) {
    if (b[idx]) return -1;
    var nb = neighbors(n), list = nb[idx], q = other(color), k, taken = 0;
    play.taken.length = 0; play.ko = -1;
    b[idx] = color;
    for (k = 0; k < list.length; k++) {
      var j = list[k];
      if (b[j] !== q) continue;
      flood(b, n, j, 1);
      if (gLibs === 0) { for (var s = 0; s < gCount; s++) { play.taken.push(GROUP[s]); b[GROUP[s]] = 0; } taken += gCount; }
    }
    flood(b, n, idx, 1);
    if (gLibs === 0) { b[idx] = 0; return -1; }
    if (taken === 1) { // a ko: a lone stone that took one stone and has only that point to breathe
      var own = 0, empty = 0;
      for (k = 0; k < list.length; k++) { if (b[list[k]] === color) own++; else if (!b[list[k]]) empty++; }
      if (!own && empty === 1) play.ko = play.taken[0];
    }
    return taken;
  }
  function legal(st, idx) {
    if (idx === st.ko) return false;
    scratch(st.n * st.n);
    var b = st.board.slice(0);
    return place(b, st.n, idx, st.turn) >= 0;
  }
  // The state after `idx` (or -1 for a pass), or null when it is illegal. Pure.
  function move(st, idx) {
    var n = st.n;
    if (idx < 0) return { n: n, board: st.board, turn: other(st.turn), caps: st.caps, ko: -1, passes: st.passes + 1, last: -1, moves: st.moves + 1, taken: [] };
    if (idx === st.ko) return null;
    scratch(n * n);
    var b = st.board.slice(0), t = place(b, n, idx, st.turn);
    if (t < 0) return null;
    var caps = st.caps.slice(0); caps[st.turn - 1] += t;
    return { n: n, board: b, turn: other(st.turn), caps: caps, ko: play.ko, passes: 0, last: idx, moves: st.moves + 1, taken: play.taken.slice(0) };
  }
  function legalMoves(st) {
    var out = [];
    for (var i = 0; i < st.board.length; i++) if (!st.board[i] && legal(st, i)) out.push(i);
    return out;
  }
  // The whole group at idx, as a list of points.
  function groupAt(b, n, idx) { scratch(n * n); flood(b, n, idx); return Array.prototype.slice.call(GROUP, 0, gCount); }

  // ── scoring ────────────────────────────────────────────────────────────
  // Territory scoring: dead stones come off the board and count as prisoners; empty regions
  // (dead stones' points included) bounded by one colour are that colour's territory.
  // dead: array of booleans per point (or null). Returns scores, territory owners, neutral points.
  function score(b, n, dead, caps) {
    var nb = neighbors(n), size = n * n, owner = new Int8Array(size), eff = b.slice(0), i, deadB = 0, deadW = 0;
    for (i = 0; i < size; i++) if (dead && dead[i] && b[i]) { if (b[i] === BLACK) deadB++; else deadW++; eff[i] = 0; }
    var seen = new Uint8Array(size);
    for (i = 0; i < size; i++) {
      if (eff[i] || seen[i]) continue;
      var stack = [i], region = [], touchB = false, touchW = false;
      seen[i] = 1;
      while (stack.length) {
        var p = stack.pop(); region.push(p);
        for (var k = 0; k < nb[p].length; k++) {
          var j = nb[p][k], v = eff[j];
          if (v === BLACK) touchB = true; else if (v === WHITE) touchW = true;
          else if (!seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
      var o = touchB && !touchW ? BLACK : touchW && !touchB ? WHITE : 0;
      if (o) region.forEach(function (p2) { owner[p2] = o; });
    }
    var tb = 0, tw = 0;
    for (i = 0; i < size; i++) { if (owner[i] === BLACK) tb++; else if (owner[i] === WHITE) tw++; }
    var c = caps || [0, 0];
    return { black: tb + c[0] + deadW, white: tw + c[1] + deadB + KOMI, territory: owner, terrB: tb, terrW: tw, prisB: c[0] + deadW, prisW: c[1] + deadB, komi: KOMI };
  }

  // ── the computer: Monte Carlo ───────────────────────────────────────────
  var rngState = 123456789;
  function fastRand() { rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5; return (rngState >>> 0) / 4294967296; }

  // A point is an eye of `color` when every neighbour is its own and the opponent does not hold
  // too many of its corners (two in the open, one at an edge).
  function isEye(b, n, idx, color) {
    var nb = neighbors(n)[idx], k;
    for (k = 0; k < nb.length; k++) if (b[nb[k]] !== color) return false;
    var r = (idx / n) | 0, c = idx % n, opp = 0, off = false, dr, dc;
    for (dr = -1; dr <= 1; dr += 2) for (dc = -1; dc <= 1; dc += 2) {
      var rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= n || cc < 0 || cc >= n) off = true;
      else if (b[rr * n + cc] === other(color)) opp++;
    }
    return off ? opp === 0 : opp <= 1;
  }

  // The urgent local move after `lastMove`: save our own group in atari, or take theirs. -1 if none.
  function urgent(b, n, lastMove, color) {
    if (lastMove < 0) return -1;
    var nb = neighbors(n), list = nb[lastMove], k, q = other(color), save = -1, take = -1;
    for (k = 0; k < list.length; k++) {
      var j = list[k], v = b[j];
      if (!v) continue;
      flood(b, n, j, 2);
      if (gLibs === 1) { if (v === color) { if (save < 0) save = gLib; } else if (take < 0) take = gLib; }
    }
    // Also the stone just played can leave a neighbouring group of ours short of liberties.
    return take >= 0 ? take : save;
  }

  // Random legal move for color: not an eye, not the first line most of the time. -1 passes.
  function randomMove(b, n, color, ko) {
    var size = n * n, start = (fastRand() * size) | 0, copy = null;
    for (var s = 0; s < size; s++) {
      var i = (start + s) % size;
      if (b[i] || i === ko) continue;
      var r = (i / n) | 0, c = i % n;
      if ((r === 0 || c === 0 || r === n - 1 || c === n - 1) && fastRand() < 0.75) continue;
      if (isEye(b, n, i, color)) continue;
      return i;
    }
    return -1;
  }

  // Play out to the end from b with `color` to move; returns black's area minus white's.
  function playout(b, n, color, ko, lastMove) {
    var passes = 0, last = lastMove, moves = 0, cap = n * n * PLAYOUT_CAP;
    while (passes < 2 && moves < cap) {
      var mv = -1, tries = 0;
      var u = urgent(b, n, last, color);
      if (u >= 0 && u !== ko && fastRand() < 0.85) mv = u;
      while (true) {
        if (mv < 0) mv = randomMove(b, n, color, ko);
        if (mv < 0) break;
        var t = place(b, n, mv, color);
        if (t >= 0) { ko = play.ko; last = mv; passes = 0; break; }
        mv = -1; tries++;
        if (tries > 6) break;
      }
      if (mv < 0) { passes++; ko = -1; last = -1; }
      color = other(color); moves++;
    }
    return areaDiff(b, n);
  }
  function areaDiff(b, n) {
    var nb = neighbors(n), size = n * n, black = 0, white = 0, seen = new Uint8Array(size), i;
    for (i = 0; i < size; i++) { if (b[i] === BLACK) black++; else if (b[i] === WHITE) white++; }
    for (i = 0; i < size; i++) {
      if (b[i] || seen[i]) continue;
      var stack = [i], cnt = 0, tB = false, tW = false;
      seen[i] = 1;
      while (stack.length) {
        var p = stack.pop(); cnt++;
        for (var k = 0; k < nb[p].length; k++) { var j = nb[p][k], v = b[j]; if (v === BLACK) tB = true; else if (v === WHITE) tW = true; else if (!seen[j]) { seen[j] = 1; stack.push(j); } }
      }
      if (tB && !tW) black += cnt; else if (tW && !tB) white += cnt;
    }
    return black - white;
  }

  // Small empty regions walled in by one colour alone: that colour's own territory, not worth a stone.
  function walledIn(b, n, color) {
    var nb = neighbors(n), size = n * n, out = new Uint8Array(size), seen = new Uint8Array(size), i;
    for (i = 0; i < size; i++) {
      if (b[i] || seen[i]) continue;
      var stack = [i], reg = [], mine = false, theirs = false;
      seen[i] = 1;
      while (stack.length) {
        var p = stack.pop(); reg.push(p);
        for (var k = 0; k < nb[p].length; k++) { var j = nb[p][k], v = b[j]; if (v === color) mine = true; else if (v) theirs = true; else if (!seen[j]) { seen[j] = 1; stack.push(j); } }
      }
      if (mine && !theirs && reg.length <= 14) reg.forEach(function (q) { out[q] = 1; });
    }
    return out;
  }

  // Groups in atari decide a lot and playouts are too noisy to see them: take the biggest
  // group that can be taken, else save the biggest of ours that can be saved. -1 if none.
  function tactical(st) {
    var n = st.n, b = st.board, color = st.turn, done = new Uint8Array(n * n), best = -1, bestScore = 0, i;
    scratch(n * n);
    for (i = 0; i < b.length; i++) {
      if (!b[i] || done[i]) continue;
      flood(b, n, i);
      var size = gCount, libs = gLibs, lib = gLib, own = b[i] === color, k;
      for (k = 0; k < size; k++) done[GROUP[k]] = 1;
      if (libs !== 1 || lib === st.ko) continue;
      var copy = b.slice(0), took = place(copy, n, lib, color);
      if (took < 0) continue;
      flood(copy, n, lib, 2);
      if (took === 0 && gLibs < 2) continue; // extending into another atari saves nothing
      var sc = size + (own ? 0 : 0.5);
      if (sc > bestScore) { bestScore = sc; best = lib; }
    }
    return best;
  }

  // The computer's move by flat Monte Carlo with a bandit over the candidates, for `ms`.
  // Returns {move, rate, playouts}; move -1 is a pass.
  function genMove(st, ms, level) {
    var n = st.n, size = n * n, color = st.turn, deadline = Date.now() + ms, b0 = st.board, cands = [], i;
    scratch(size);
    var tac = tactical(st), mine = st.moves > 14 ? walledIn(b0, n, color) : null;
    if (tac >= 0 && (level !== 'easy' ? true : fastRand() < 0.6)) return { move: tac, rate: 0.6, playouts: 0, tactical: true };
    for (i = 0; i < size; i++) {
      if (b0[i] || i === st.ko) continue;
      if (isEye(b0, n, i, color) || (mine && mine[i])) continue;
      var copy = b0.slice(0), took = place(copy, n, i, color);
      if (took < 0) continue;
      flood(copy, n, i, 2);
      if (took === 0 && gLibs === 1) continue; // a self-atari that takes nothing is never worth a look
      var pr = priorOf(b0, n, i, color, st);
      if (pr < 0) continue;
      cands.push({ idx: i, wins: 0, visits: 0, prior: pr });
    }
    var late = st.moves > size * 0.3 || st.passes > 0;
    if (late || !cands.length) cands.push({ idx: -1, wins: 0, visits: 0, prior: 0 });
    if (cands.length === 1) return { move: cands[0].idx, rate: 0.5, playouts: 0 };
    // a taken or saved group starts out looking good; the playouts then confirm or refute it
    cands.forEach(function (c) { if (c.prior >= 3) { c.visits = 6 + 3 * c.prior; c.wins = c.visits * 0.8; } else c.visits = 0; });
    var total = 0, komi = AREA_KOMI;
    while (Date.now() < deadline || total < cands.length * 2) {
      for (var batch = 0; batch < 8; batch++) {
        var best = null, bestV = -1, lnT = Math.log(total + 2);
        for (i = 0; i < cands.length; i++) {
          var c = cands[i], v = c.visits ? c.wins / c.visits + 0.55 * Math.sqrt(lnT / c.visits) : 10;
          if (v > bestV) { bestV = v; best = c; }
        }
        var b = b0.slice(0), ko = -1;
        if (best.idx >= 0) { place(b, n, best.idx, color); ko = play.ko; }
        var diff = playout(b, n, other(color), ko, best.idx);
        // black wins when its area minus white's exceeds the komi
        var win = color === WHITE ? (diff - komi < 0 ? 1 : 0) : (diff - komi > 0 ? 1 : 0);
        best.wins += win; best.visits++; total++;
      }
      if (total > 2000000) break;
    }
    cands.sort(function (x, y) { return y.visits - x.visits; });
    var pick = cands[0];
    if (level === 'easy') {
      var pool = cands.slice(0, 5).filter(function (c) { return c.visits > 1; });
      if (pool.length && fastRand() < 0.5) pick = pool[(fastRand() * pool.length) | 0];
    }
    if (pick.idx === -1 && cands.length > 1 && pick.visits < cands[1].visits * 1.2 && !st.passes) pick = cands[1];
    return { move: pick.idx, rate: pick.visits ? pick.wins / pick.visits : 0.5, playouts: total };
  }
  // How attractive a move looks before any playout: taking a group in atari or saving one scores
  // high, the edge and empty corners of the board low. -1 means not worth looking at.
  function priorOf(b, n, i, color, st) {
    var nb = neighbors(n)[i], p = 0, k, r = (i / n) | 0, c = i % n, line = Math.min(r, c, n - 1 - r, n - 1 - c), near = false;
    for (k = 0; k < nb.length; k++) {
      var v = b[nb[k]];
      if (!v) continue;
      near = true;
      flood(b, n, nb[k], 2);
      if (gLibs === 1) p = Math.max(p, v === other(color) ? 4 + Math.min(gCount, 6) * 0.5 : 3.2);
    }
    if (!near) {
      for (var dr = -2; dr <= 2 && !near; dr++) for (var dc = -2; dc <= 2; dc++) { var rr = r + dr, cc = c + dc; if (rr >= 0 && rr < n && cc >= 0 && cc < n && b[rr * n + cc]) { near = true; break; } }
    }
    if (!near && st.moves > 6) return -1;
    if (line === 0 && p < 3) return st.moves < 20 ? -1 : 0;
    if (st.moves < 6 && line >= 2 && line <= 3) p = Math.max(p, 0.5);
    return p;
  }

  // Which stones look dead at the end: play the position out many times and see who ends up owning each point.
  function estimateDead(st, ms) {
    var n = st.n, size = n * n, own = new Float32Array(size), runs = 0, deadline = Date.now() + ms, i;
    scratch(size);
    while (Date.now() < deadline || runs < 60) {
      var b = st.board.slice(0);
      playout(b, n, st.turn, -1, -1);
      var nb = neighbors(n), seen = new Uint8Array(size);
      for (i = 0; i < size; i++) {
        if (b[i]) { own[i] += b[i] === BLACK ? 1 : -1; continue; }
        if (seen[i]) continue;
        var stack = [i], reg = [], tB = false, tW = false;
        seen[i] = 1;
        while (stack.length) { var p = stack.pop(); reg.push(p); for (var k = 0; k < nb[p].length; k++) { var j = nb[p][k], v = b[j]; if (v === BLACK) tB = true; else if (v === WHITE) tW = true; else if (!seen[j]) { seen[j] = 1; stack.push(j); } } }
        var o = tB && !tW ? 1 : tW && !tB ? -1 : 0;
        reg.forEach(function (q) { own[q] += o; });
      }
      runs++;
      if (runs > 4000) break;
    }
    var dead = new Array(size).fill(false), done = new Uint8Array(size);
    for (i = 0; i < size; i++) {
      if (!st.board[i] || done[i]) continue;
      var grp = groupAt(st.board, n, i), sum = 0;
      grp.forEach(function (q) { done[q] = 1; sum += own[q] / runs; });
      var avg = sum / grp.length, color = st.board[i];
      if ((color === BLACK && avg < -0.35) || (color === WHITE && avg > 0.35)) grp.forEach(function (q) { dead[q] = true; });
    }
    return { dead: dead, runs: runs };
  }

  // The Worker's single entry: a request in, a reply out.
  function handle(d) {
    rngState = (d.seed || 123456789) | 0 || 1;
    var st = { n: d.n, board: Int8Array.from(d.board), turn: d.turn, caps: d.caps, ko: d.ko, passes: d.passes, last: d.last, moves: d.moves };
    if (d.cmd === 'move') return genMove(st, d.ms, d.level);
    if (d.cmd === 'dead') return estimateDead(st, d.ms);
    return null;
  }

  return { BLACK: BLACK, WHITE: WHITE, KOMI: KOMI, newGame: newGame, move: move, legal: legal, legalMoves: legalMoves, groupAt: groupAt, score: score, genMove: genMove, estimateDead: estimateDead, handle: handle, areaDiff: areaDiff, neighbors: neighbors, place: place, isEye: isEye };
}
if (typeof globalThis !== 'undefined') globalThis.makeGoEngine = makeGoEngine;
