/* ZimiGames: Watch and learn, Reversi. One sentence for a move, from facts checked on the
   board: corners and edges, discs flipped, how many moves the opponent has before and after,
   passes forced, and the squares beside an empty corner. Our own code, GPL-3.0.

     ZimiExplain.reversi(E, board, player, move) -> { text, facts }

   E is ReversiEngine (reversi.js); move is { idx, flips }. */
(function (root) {
  'use strict';
  var N = 8, FEW_MOVES = 2;
  var CORNERS = [0, 7, 56, 63];
  // The three squares touching each corner: the two on its edge, and the diagonal one (the X square).
  var NEAR = { 0: [1, 8, 9], 7: [6, 15, 14], 56: [48, 57, 49], 63: [55, 62, 54] };

  function coord(i) { return 'abcdefgh'[i % N] + (N - ((i / N) | 0)); }
  var T = function (key, vars) { return root.ZimiText ? root.ZimiText.T(key, vars) : key; };
  var discs = function (n) { return T('explain.reversi.discs', { n: n }); };
  var sideName = function (black) { return T(black ? 'explain.side.black' : 'explain.side.white'); };

  function reversiExplain(E, b, p, m) {
    var key = p === E.BLACK ? 'Black' : 'White', side = sideName(p === E.BLACK), other = E.other(p), sq = coord(m.idx);
    var after = E.play(b, p, m.idx, m.flips);
    var before = E.legalMoves(b, other).length, theirs = E.legalMoves(after, other).length;
    var passes = theirs === 0 && E.legalMoves(after, p).length > 0;
    var over = theirs === 0 && E.legalMoves(after, p).length === 0;
    var row = (m.idx / N) | 0, col = m.idx % N, edge = row === 0 || row === N - 1 || col === 0 || col === N - 1;
    var corner = CORNERS.indexOf(m.idx) >= 0;
    // A square next to a corner that is still empty gives that corner away.
    var besideCorner = null;
    CORNERS.forEach(function (c) { if (b[c] === E.EMPTY && NEAR[c].indexOf(m.idx) >= 0) besideCorner = c; });
    var cornerOpen = besideCorner !== null && E.legalMoves(after, other).some(function (x) { return x.idx === besideCorner; });
    var k = E.count(after), mine = p === E.BLACK ? k.black : k.white;
    var facts = { side: key, square: sq, flips: m.flips.length, corner: corner, edge: edge, before: before, after: theirs, passes: passes, besideCorner: besideCorner !== null, cornerOpen: cornerOpen, over: over };

    var text, v = { side: side, sq: sq, discs: discs(m.flips.length), before: before, after: theirs };
    if (over) text = T('explain.reversi.over', v);
    else if (corner) text = T('explain.reversi.corner', v);
    else if (passes) text = T('explain.reversi.passes', { side: side, sq: sq, foe: sideName(p !== E.BLACK) });
    else if (theirs > 0 && theirs <= FEW_MOVES && theirs < before) text = T('explain.reversi.cuts', v);
    else if (cornerOpen) text = T('explain.reversi.cornerOpen', v);
    else if (besideCorner !== null) text = T('explain.reversi.besideCorner', v);
    else if (edge && theirs < before) text = T('explain.reversi.edgeTrims', v);
    else if (edge) text = T('explain.reversi.edge', v);
    else if (m.flips.length <= 2 && theirs < before) text = T('explain.reversi.flipsFew', v);
    else if (theirs < before) text = T('explain.reversi.flipsCut', v);
    else text = T('explain.reversi.plain', { side: side, sq: sq, discs: discs(m.flips.length), mine: mine, total: k.black + k.white });
    return { text: text, facts: facts };
  }

  root.ZimiExplain = root.ZimiExplain || {};
  root.ZimiExplain.reversi = reversiExplain;
  if (typeof module !== 'undefined' && module.exports) module.exports = reversiExplain;
})(typeof globalThis !== 'undefined' ? globalThis : this);
