/* ZimiGames: Watch and learn, Checkers. One sentence for a move, from facts checked on the
   board: jumps taken, a king made, whether the moved man can be jumped back, whether the
   reply is forced and what it costs, and the engine's own search score when nothing else
   stands out. Our own code, GPL-3.0.

     ZimiExplain.checkers(E, board, player, move, { score }) -> { text, facts }

   E is CheckersEngine (checkers.js); move is { from, to, path, caps }. */
(function (root) {
  'use strict';
  var N = 8, CENTRE_COLS = [2, 3, 4, 5], CENTRE_ROWS = [3, 4];
  var EVEN = 20, BIG = 100;

  function coord(i) { return 'abcdefgh'[i % N] + (N - ((i / N) | 0)); }
  var T = function (key, vars) { return root.ZimiText ? root.ZimiText.T(key, vars) : key; };
  var pieces = function (n) { return T('explain.checkers.pieces', { n: n }); };
  var sideName = function (red) { return T(red ? 'explain.side.red' : 'explain.side.white'); };

  function checkersExplain(E, b, p, m, info) {
    info = info || {};
    var key = p === E.RED ? 'Red' : 'White', side = sideName(p === E.RED), other = E.other(p);
    var piece = b[m.from], isKing = E.isKing(piece), caps = m.caps.length;
    var jumpedKings = m.caps.filter(function (i) { return E.isKing(b[i]); }).length;
    var after = E.apply(b, m);
    var crowned = !isKing && E.isKing(after[m.to]);
    var from = coord(m.from), to = coord(m.to);
    var row = (m.to / N) | 0, col = m.to % N;

    // Replies: can the moved piece be jumped, and is a reply forced?
    var replies = E.moves(after, other);
    var forced = replies.length > 0 && replies[0].caps.length > 0;
    var exposed = replies.some(function (r) { return r.caps.length && r.caps.indexOf(m.to) >= 0; });
    // What a forced exchange costs: the opponent takes the reply that leaves us best off after our recapture.
    var exchange = null;
    if (forced) {
      replies.forEach(function (r) {
        var back = E.moves(E.apply(after, r), p), won = back.length && back[0].caps.length ? Math.max.apply(null, back.map(function (x) { return x.caps.length; })) : 0;
        var net = won - r.caps.length;
        if (!exchange || net < exchange.net) exchange = { lost: r.caps.length, won: won, net: net };
      });
    }
    var onEdge = col === 0 || col === N - 1;
    var advance = p === E.RED ? (m.from / N | 0) - row : row - (m.from / N | 0);
    var centre = CENTRE_COLS.indexOf(col) >= 0 && CENTRE_ROWS.indexOf(row) >= 0;
    var facts = { side: key, from: from, to: to, captures: caps, kingsTaken: jumpedKings, crowned: crowned, exposed: exposed, forced: forced, exchange: exchange, edge: onEdge, score: info.score };

    var text, v = { side: side, from: from, to: to };
    if (caps) {
      var end = T(crowned ? 'explain.checkers.endCrowned' : 'explain.checkers.end');
      text = caps === 1 ? T(jumpedKings ? 'explain.checkers.jumpKing' : 'explain.checkers.jumpMan', { side: side, from: from, to: to, end: end })
        : T('explain.checkers.jumpMany', { side: side, from: from, to: to, end: end, pieces: pieces(caps) });
      if (exchange && exchange.lost) text += ' ' + (exchange.won ? T('explain.checkers.replyThenJump', { side: side, lost: pieces(exchange.lost), won: pieces(exchange.won) }) : T('explain.checkers.replyJump', { lost: pieces(exchange.lost) }));
      else if (!exposed && !crowned) text += ' ' + T('explain.checkers.nothingBack');
    } else if (crowned) {
      text = T('explain.checkers.crowned', v);
    } else if (forced && exchange && exchange.net > 0) {
      text = T('explain.checkers.offer', { side: side, to: to, won: pieces(exchange.won), lost: pieces(exchange.lost) });
    } else if (forced && exchange && exchange.net === 0) {
      text = T('explain.checkers.trade', { side: side, from: from, to: to, pieces: pieces(exchange.lost) });
    } else if (forced) {
      text = T('explain.checkers.forced', v);
    } else if (onEdge) {
      text = T('explain.checkers.edge', v);
    } else if (centre && !exposed) {
      text = T('explain.checkers.centre', v);
    } else if (advance > 0 && !exposed && !isKing) {
      text = T('explain.checkers.advance', v);
    } else {
      text = T('explain.checkers.moves', v);
      var s = info.score;
      if (typeof s === 'number') {
        if (Math.abs(s) < EVEN) text += ' ' + T('explain.checkers.even');
        else text += ' ' + T(Math.abs(s) >= BIG ? 'explain.checkers.rateBig' : 'explain.checkers.rateSmall', { who: sideName(s > 0 ? p === E.RED : p !== E.RED) });
      }
    }
    return { text: text, facts: facts };
  }

  root.ZimiExplain = root.ZimiExplain || {};
  root.ZimiExplain.checkers = checkersExplain;
  if (typeof module !== 'undefined' && module.exports) module.exports = checkersExplain;
})(typeof globalThis !== 'undefined' ? globalThis : this);
