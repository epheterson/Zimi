/* ZimiGames: piece faces that need no language, for Xiangqi, Janggi and Shogi, and the fading of a captured piece. Their traditional faces are written
   in Chinese or Japanese characters; these are the same pieces drawn as figures, so a player who reads neither has
   nothing to decode. Xiangqi and Janggi borrow the chess set (chess-pieces.js, loaded first) and draw the cannon, which
   chess lacks. Shogi shows each piece as the arrows it moves along, promoted pieces in red. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  // Xiangqi and Janggi types 1 to 7 (soldier, cannon, chariot, horse, elephant, advisor, general) as chess pieces 1 to 6
  // (pawn, knight, bishop, rook, queen, king); the cannon (2) is drawn below.
  var CHESS_OF = { 1: 1, 3: 4, 4: 2, 5: 3, 6: 5, 7: 6 };
  var CANNON = '<path d="M9 38h27v-3.5H9z"/><circle cx="17" cy="29" r="6.5"/><path d="M14.5 25.5 29 8l6 5L21 32z"/><path d="M30.5 10.5l4.5 3.8" stroke="#ececec" stroke-width="1.5" fill="none"/><circle cx="17" cy="29" r="2.2" fill="#ececec" stroke="none"/>';

  // The figure for a Xiangqi or Janggi piece, in the colour of the side that owns it (currentColor).
  function figure(type) {
    var inner;
    if (type === 2) inner = CANNON;
    else {
      var svg = root.ZimiChessPieces.svg(CHESS_OF[type], false);
      inner = svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>')).replace(/#000/g, 'currentColor');
    }
    return '<svg class="pi-fig" viewBox="0 0 45 45" aria-hidden="true"><g fill="currentColor" stroke="currentColor" stroke-linejoin="round">' + inner + '</g></svg>';
  }

  // Shogi: each piece as its moves. A step is a short arrow, a slide a long one, [dx, dy] with up (forward) as -1.
  var GOLD = { s: [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [0, 1]] };
  var ORTHO = [[0, -1], [0, 1], [-1, 0], [1, 0]], DIAG = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  var MOVES = {
    1: { s: [[0, -1]] },
    2: { l: [[0, -1]] },
    3: { j: [[-1, -2], [1, -2]] },
    4: { s: [[-1, -1], [0, -1], [1, -1], [-1, 1], [1, 1]] },
    5: GOLD,
    6: { l: DIAG },
    7: { l: ORTHO },
    8: { s: ORTHO.concat(DIAG) },
    9: GOLD, 10: GOLD, 11: GOLD, 12: GOLD,
    14: { l: DIAG, s: ORTHO },
    15: { l: ORTHO, s: DIAG }
  };
  var CX = 20, CY = 26, STEP = 9.5;   // the middle of the piece's body and the distance of a one-square arrow

  function head(x, y, dx, dy, size) {
    var len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, px = -uy, py = ux;
    return '<path d="M' + (x + ux * size).toFixed(1) + ' ' + (y + uy * size).toFixed(1) + 'L' + (x - ux * size * 0.4 + px * size * 0.85).toFixed(1) + ' ' + (y - uy * size * 0.4 + py * size * 0.85).toFixed(1) + 'L' + (x - ux * size * 0.4 - px * size * 0.85).toFixed(1) + ' ' + (y - uy * size * 0.4 - py * size * 0.85).toFixed(1) + 'z"/>';
  }
  function arrows(type) {
    var m = MOVES[type], out = '<circle cx="' + CX + '" cy="' + CY + '" r="2.4"/>';
    (m.s || []).forEach(function (d) { out += head(CX + d[0] * STEP * 0.78, CY + d[1] * STEP * 0.78, d[0], d[1], 3.6); });
    (m.l || []).forEach(function (d) {
      var k = d[0] && d[1] ? 0.7 : 1, x1 = CX + d[0] * 5 * k, y1 = CY + d[1] * 5 * k, x2 = CX + d[0] * 11 * k, y2 = CY + d[1] * 11 * k;
      out += '<path d="M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + 'L' + x2.toFixed(1) + ' ' + y2.toFixed(1) + '" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>' + head(x2, y2, d[0], d[1], 4);
    });
    (m.j || []).forEach(function (d) { out += head(CX + d[0] * 7, CY + d[1] * 7, d[0] * 0.3, d[1], 3.8); });
    return out;
  }
  // The arrows of a Shogi piece, to sit inside the piece's pentagon (viewBox 0 0 40 44).
  function shogiArrows(type) { return '<g class="pi-arrows" fill="currentColor">' + arrows(type) + '</g>'; }

  // A captured piece does not just vanish: its picture fades out where it stood. snap() before the move, ghosts() after the
  // board is painted; sq is the position's signed squares (a side's pieces share a sign) and sqAt maps a cell to its square.
  var GHOST_MS = 360, GHOST_SCALE = 0.55;
  function snap(cells, sqAt, sq) {
    var html = {};
    cells.forEach(function (c, d) { var s = sqAt(d); if (sq[s]) html[s] = c.innerHTML; });
    return { html: html, occ: Array.prototype.slice.call(sq) };
  }
  function ghosts(was, cells, sqAt, sq, from) {
    var motion = root.BoardKit && root.BoardKit.reducedMotion && root.BoardKit.reducedMotion();
    if (motion) return;
    cells.forEach(function (c, d) {
      var s = sqAt(d), before = was.occ[s];
      if (!before || s === from || !(sq[s] === 0 || (sq[s] > 0) !== (before > 0))) return;
      var g = document.createElement('span');
      g.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;z-index:3';
      g.innerHTML = was.html[s];
      c.appendChild(g);
      var fade = g.animate([{ opacity: 0.95, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(' + GHOST_SCALE + ')' }], { duration: GHOST_MS, easing: 'ease-out' });
      fade.onfinish = function () { g.remove(); };
    });
  }

  // A piece key for How to play: a title, then each piece's figure beside its name. entries are [{ html, name }], the html being
  // what the board draws for that piece (so the key always matches the board), name the piece in the UI language.
  function key(title, entries) {
    var box = document.createElement('div'), grid = document.createElement('div');
    box.className = 'pi-keybox'; grid.className = 'pi-key';
    var h = document.createElement('div'); h.className = 'pi-keytitle'; h.textContent = title; box.appendChild(h);
    entries.forEach(function (e) {
      var row = document.createElement('div'), fig = document.createElement('span'), nm = document.createElement('span');
      row.className = 'pi-k'; fig.className = 'pi-kp'; nm.className = 'pi-kn';
      fig.innerHTML = e.html; nm.textContent = e.name;
      row.appendChild(fig); row.appendChild(nm); grid.appendChild(row);
    });
    box.appendChild(grid);
    return box;
  }

  root.ZimiPieceIcons = { figure: figure, shogiArrows: shogiArrows, snap: snap, ghosts: ghosts, key: key };
})(typeof globalThis !== 'undefined' ? globalThis : this);
