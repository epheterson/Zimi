/* ZimiGames: Watch and learn, Go. One sentence per move from facts read off the board after
   the move is tried: stones captured, a group left with one liberty (atari), a group of its own
   rescued from atari, groups joined, the opening points, how far from the edge, and the
   computer's own playout win rate for the move. Our own code, GPL-3.0.

     ZimiExplain.go(E, st, move, { rate, playouts }) -> { text, facts }

   E is the Go engine (go-engine.js), st the state before the move, move a point index or -1 for a pass. */
(function (root) {
  'use strict';
  var BLACK = 1;
  var STAR = { 9: [20, 24, 56, 60, 40], 13: [42, 48, 120, 126, 84, 45, 81, 87, 123] };   // points as row * n + col
  var OPENING_MOVES = 8, SURE = 0.6, CLOSE = 0.45;
  var LINES = 5;

  var T = function (key, vars) { return root.ZimiText ? root.ZimiText.T(key, vars) : key; };
  var stones = function (n) { return T('explain.go.stones', { n: n }); };
  var sideName = function (c) { return T(c === BLACK ? 'explain.side.black' : 'explain.side.white'); };

  function goExplain(E, st, mv, info) {
    info = info || {};
    var n = st.n, color = st.turn, key = color === BLACK ? 'Black' : 'White', side = sideName(color), foe = sideName(3 - color), enemy = 3 - color;
    var facts = { side: key, pass: mv < 0, score: info.rate };
    if (mv < 0) {
      facts.pass = true;
      return { text: T('explain.go.pass', { side: side }), facts: facts };
    }
    var ns = E.move(st, mv);
    var nb = E.neighbors(n);
    function name(i) { return 'ABCDEFGHJKLMN'[i % n] + (n - ((i / n) | 0)); }
    function libs(board, i) {
      var group = E.groupAt(board, n, i), seen = {}, count = 0;
      group.forEach(function (g) { nb[g].forEach(function (q) { if (!board[q] && !seen[q]) { seen[q] = 1; count++; } }); });
      return { count: count, size: group.length, group: group };
    }
    var sq = name(mv), taken = ns.taken ? ns.taken.length : 0;
    // Enemy groups touching the move that are down to one liberty now.
    var atari = [], seenG = {};
    nb[mv].forEach(function (q) {
      if (ns.board[q] !== enemy) return;
      var l = libs(ns.board, q), key = Math.min.apply(null, l.group);
      if (!seenG[key] && l.count === 1) { seenG[key] = 1; atari.push(l.size); }
    });
    // Our own groups beside the move: were they in atari before, and are they now safe?
    var rescued = null, joined = {}, ownSeen = {};
    nb[mv].forEach(function (q) {
      if (st.board[q] !== color) return;
      var before = libs(st.board, q), key = Math.min.apply(null, before.group);
      if (ownSeen[key]) return;
      ownSeen[key] = 1; joined[key] = 1;
      if (before.count === 1) { var after = libs(ns.board, mv); rescued = { size: before.size, libs: after.count }; }
    });
    var groupsJoined = Object.keys(joined).length;
    var row = (mv / n) | 0, col = mv % n, edgeDist = Math.min(row, col, n - 1 - row, n - 1 - col);
    var star = (STAR[n] || []).indexOf(mv) >= 0;
    var near = 0;
    for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
      var r = row + dr, c = col + dc;
      if ((dr || dc) && r >= 0 && r < n && c >= 0 && c < n && st.board[r * n + c]) near++;
    }
    facts.captured = taken; facts.atari = atari.length; facts.rescued = !!rescued; facts.joined = groupsJoined; facts.edge = edgeDist + 1; facts.star = star; facts.near = near;

    var text, v = { side: side, sq: sq };
    if (taken) text = T('explain.go.captures', { side: side, sq: sq, stones: stones(taken) });
    else if (rescued) text = T('explain.go.rescues', { side: side, sq: sq, stones: stones(rescued.size), liberties: T('explain.go.liberties', { n: rescued.libs }) });
    else if (atari.length) text = atari[0] === 1 ? T('explain.go.atariStone', { side: side, sq: sq, foe: foe }) : T('explain.go.atariGroup', { side: side, sq: sq, foe: foe, n: atari[0] });
    else if (groupsJoined >= 2) text = T('explain.go.joins', { side: side, sq: sq, n: groupsJoined });
    else if (star && st.moves < OPENING_MOVES) text = T('explain.go.star', v);
    else if (edgeDist === 0) text = T('explain.go.edge', v);
    else if (near === 0) text = T('explain.go.open', { side: side, sq: sq, line: T('explain.go.line.' + Math.min(edgeDist, LINES - 1)) });
    else text = T(groupsJoined === 1 ? 'explain.go.nextExtend' : 'explain.go.next', v);
    var r2 = info.rate;
    if (typeof r2 === 'number' && info.playouts > 0 && st.moves >= OPENING_MOVES) {
      var pct = Math.round(r2 * 100);
      text += ' ' + (r2 >= SURE ? T('explain.go.favours', { side: side, pct: pct }) : r2 <= CLOSE ? T('explain.go.favoursFoe', { foe: foe, pct: 100 - pct }) : T('explain.go.close'));
    }
    return { text: text, facts: facts };
  }

  root.ZimiExplain = root.ZimiExplain || {};
  root.ZimiExplain.go = goExplain;
  if (typeof module !== 'undefined' && module.exports) module.exports = goExplain;
})(typeof globalThis !== 'undefined' ? globalThis : this);
