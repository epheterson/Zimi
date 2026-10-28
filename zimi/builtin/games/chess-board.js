/* ZimiGames: the chess board's drawing, shared by Chess Puzzles and the Opening Trainer (Chess draws its own).
   One button per square, our own pieces (chess-pieces.js), the last move, a selection, legal-move dots, a cue
   square for hints, check, and edge coordinates. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined') return;
  var PC = root.ZimiChessPieces, BK = root.BoardKit;
  function T(id, vars) { return root.ZimiText ? root.ZimiText.T(id, vars) : id; }

  // create(el, E, onSquare): builds the 64 buttons in el. onSquare(square, event) is called with the engine's square index.
  function create(el, E, onSquare) {
    var cells = [], flipped = false, selNow = -1, shownLast = 0, dropped = false, WHITE = E.WHITE, BLACK = E.BLACK;
    function sqAt(d) { return flipped ? 63 - d : d; }
    el.textContent = '';
    for (var d = 0; d < 64; d++) {
      var c = document.createElement('button');
      c.type = 'button'; c.className = 'bg-sq'; c.dataset.d = d;
      c.addEventListener('click', function (e) { onSquare(sqAt(+e.currentTarget.dataset.d), e); });
      el.appendChild(c); cells.push(c);
    }
    BK.gridNav(el, cells, 8);
    BK.dragPieces(el, cells, { grab: function (i) { if (selNow !== sqAt(i)) onSquare(sqAt(i), null); }, drop: function (i) { dropped = true; onSquare(sqAt(i), null); } });

    // v: { flipped, last (a move), sel (square or -1), targets ({square: isCapture}), cue ({from, to}) }
    function paint(pos, v) {
      flipped = !!v.flipped; selNow = v.sel;
      var kingSq = E.inCheck(pos) ? pos.king[pos.turn === WHITE ? 0 : 1] : -1, targets = v.targets || {}, cue = v.cue, last = v.last;
      for (var d = 0; d < 64; d++) {
        var s = sqAt(d), c = cells[d], p = pos.sq[s], cls = 'bg-sq' + (((s >> 3) + (s & 7)) % 2 ? ' dk' : '');
        if (last && (s === E.from(last) || s === E.to(last))) cls += ' last';
        if (s === v.sel) cls += ' sel';
        if (s === kingSq) cls += ' bad';
        if (cue && s === cue.from) cls += ' cue';
        if (cue && cue.to >= 0 && s === cue.to) cls += ' cue-to';
        if (targets.hasOwnProperty(s)) cls += ' hint' + (p || targets[s] ? ' cap' : '');
        c.className = cls;
        var html = p ? PC.svg(Math.abs(p), p > 0) : '', edge = '';
        if ((d >> 3) === 7) edge += '<i class="cs-co f">' + 'abcdefgh'[s & 7] + '</i>';
        if ((d & 7) === 0) edge += '<i class="cs-co r">' + (8 - (s >> 3)) + '</i>';
        var sig = html + edge;
        if (c.dataset.sig !== sig) { c.innerHTML = sig; c.dataset.sig = sig; }
        var sq = E.squareName(s), label = p ? T('chess.sq.piece', { sq: sq, color: T(p > 0 ? 'board.white' : 'board.black').toLowerCase(), piece: T('chess.piece.' + Math.abs(p)).toLowerCase() }) : T(targets.hasOwnProperty(s) ? 'chess.sq.target' : 'chess.sq.empty', { sq: sq });
        c.setAttribute('aria-label', s === v.sel ? T('chess.sq.selected', { label: label }) : label);
      }
      // A new last move glides from the square it left, unless the piece was dragged there.
      if (last && last !== shownLast && !dropped) BK.slide(cells[sqAt(E.from(last))], cells[sqAt(E.to(last))]);
      shownLast = last || 0; dropped = false;
    }

    // The legal destinations of the piece on square s: {square: isCapture}.
    function movesFrom(pos, s) {
      var out = {};
      E.legalMoves(pos).forEach(function (m) { if (E.from(m) === s) out[E.to(m)] = !!(pos.sq[E.to(m)] || (E.flag(m) & 1)); });
      return out;
    }
    return { paint: paint, movesFrom: movesFrom, cells: cells };
  }

  // A promotion sheet's four buttons; pick(piece) is called with the chosen piece type.
  function promoButtons(E, box, pick) {
    [E.Q, E.R, E.B, E.N].forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ar-btn cs-promo-btn';
      b.setAttribute('aria-label', T('chess.piece.' + t));
      b.innerHTML = PC.svg(t, true) + '<span>' + T('chess.piece.' + t) + '</span>';
      b.addEventListener('click', function () { pick(t); });
      box.appendChild(b);
    });
  }
  function promoColour(box, whiteToMove) {
    var svgs = box.querySelectorAll('svg');
    for (var i = 0; i < svgs.length; i++) svgs[i].setAttribute('class', 'cs-pc ' + (whiteToMove ? 'w' : 'b'));
  }

  root.ZimiChessBoard = { create: create, promoButtons: promoButtons, promoColour: promoColour };
})(typeof globalThis !== 'undefined' ? globalThis : this);
