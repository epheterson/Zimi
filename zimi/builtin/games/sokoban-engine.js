/* ZimiGames: Sokoban's rules. Our own code, GPL-3.0. Pure functions (no document) so node runs them for the tests.
   A level is rows of text: # wall, space or - floor, . goal, $ box, * box on a goal, @ player, + player on a goal.
   A state is { w, h, wall, goal, box, player } with flat arrays; move() returns a new state or null. */
(function (root) {
  'use strict';
  var DIRS = { u: [-1, 0], d: [1, 0], l: [0, -1], r: [0, 1] };

  function parse(rows) {
    var h = rows.length, w = 0, i;
    rows.forEach(function (r) { if (r.length > w) w = r.length; });
    var st = { w: w, h: h, wall: new Uint8Array(w * h), goal: new Uint8Array(w * h), box: new Uint8Array(w * h), player: -1 };
    for (var r = 0; r < h; r++) for (var c = 0; c < w; c++) {
      var ch = rows[r][c] || '#', k = r * w + c;
      if (ch === '#') st.wall[k] = 1;
      if (ch === '.' || ch === '*' || ch === '+') st.goal[k] = 1;
      if (ch === '$' || ch === '*') st.box[k] = 1;
      if (ch === '@' || ch === '+') st.player = k;
    }
    i = st.player;
    if (i < 0) throw new Error('level has no player');
    return st;
  }
  function clone(st) { return { w: st.w, h: st.h, wall: st.wall, goal: st.goal, box: st.box.slice(), player: st.player }; }

  // One step in direction d ('u','d','l','r'): walk, or push one box. null when blocked. pushed says whether a box moved.
  function move(st, d) {
    var dir = DIRS[d.toLowerCase()];
    var r = (st.player / st.w | 0) + dir[0], c = st.player % st.w + dir[1];
    if (r < 0 || c < 0 || r >= st.h || c >= st.w) return null;
    var n = r * st.w + c;
    if (st.wall[n]) return null;
    var out = clone(st), pushed = false;
    if (st.box[n]) {
      var r2 = r + dir[0], c2 = c + dir[1];
      if (r2 < 0 || c2 < 0 || r2 >= st.h || c2 >= st.w) return null;
      var n2 = r2 * st.w + c2;
      if (st.wall[n2] || st.box[n2]) return null;
      out.box[n] = 0; out.box[n2] = 1; pushed = true;
    }
    out.player = n;
    out.pushed = pushed;
    return out;
  }
  function solved(st) {
    for (var i = 0; i < st.box.length; i++) if (st.box[i] && !st.goal[i]) return false;
    for (var j = 0; j < st.box.length; j++) if (st.goal[j] && !st.box[j]) return false;
    return true;
  }
  // Plays a move string ("uuRdL": lower case walks, upper case pushes) and returns the final state, or null if a move is blocked
  // or a lower-case move would push (or an upper-case one would not).
  function play(st, moves) {
    for (var i = 0; i < moves.length; i++) {
      var next = move(st, moves[i]);
      if (!next || next.pushed !== (moves[i] !== moves[i].toLowerCase())) return null;
      st = next;
    }
    return st;
  }

  // The floor the player can ever stand on, boxes ignored, and the walls that touch it: what is worth drawing.
  function extent(st) {
    var seen = new Uint8Array(st.w * st.h), q = [st.player], h, minR = 99, maxR = -1, minC = 99, maxC = -1;
    seen[st.player] = 1;
    for (h = 0; h < q.length; h++) {
      var p = q[h], r = p / st.w | 0, c = p % st.w;
      [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(function (d) {
        var nr = r + d[0], nc = c + d[1];
        if (nr < 0 || nc < 0 || nr >= st.h || nc >= st.w) return;
        var n = nr * st.w + nc;
        if (!seen[n] && !st.wall[n]) { seen[n] = 1; q.push(n); }
      });
    }
    var show = new Uint8Array(st.w * st.h);
    for (var i = 0; i < seen.length; i++) {
      if (!seen[i]) continue;
      var rr = i / st.w | 0, cc = i % st.w;
      for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
        var ar = rr + dr, ac = cc + dc;
        if (ar < 0 || ac < 0 || ar >= st.h || ac >= st.w) continue;
        show[ar * st.w + ac] = 1;
        if (ar < minR) minR = ar; if (ar > maxR) maxR = ar; if (ac < minC) minC = ac; if (ac > maxC) maxC = ac;
      }
    }
    return { floor: seen, show: show, r0: minR, r1: maxR, c0: minC, c1: maxC };
  }

  root.ZimiSokoban = { parse: parse, move: move, solved: solved, play: play, extent: extent };
})(typeof globalThis !== 'undefined' ? globalThis : this);
