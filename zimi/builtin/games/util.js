/* ZimiGames: the small things every game would otherwise write for itself. Our own code, GPL-3.0. No modules, no DOM at load.

     ZimiUtil.mulberry32(seed)        a function that returns the next number in [0, 1); one seed is one sequence.
                                     A deal is a promise: never change its arithmetic.
     ZimiUtil.counted(seed, skip)     the same sequence, but it knows its seed and how many it has given (rng.seed, rng.draws),
                                     so a game that holds one can be put back where it was: counted(seed, draws)
     ZimiUtil.snapshot(game)          the game's state as plain JSON (its `rng` becomes { seed, draws })
     ZimiUtil.restore(saved)          a game from a snapshot, its `rng` the same sequence at the same place
     ZimiUtil.clamp(v, lo, hi)        v held between lo and hi
     ZimiUtil.DAY_MS                  86400000
     ZimiUtil.dayKey(date, sep)       the player's calendar day as YYYYMMDD (the server's day key), or YYYY-MM-DD with sep '-'; today by default
     ZimiUtil.DIR_KEYS                the arrow keys and WASD as 'left' | 'right' | 'up' | 'down'; copy it to add a game's own keys
     ZimiUtil.sweep(s, /pattern/g)    s with the pattern's matches removed until none is left (markup out of text)
     ZimiUtil.el(tag, cls, text)      a new element with a class and some text (a page only: it needs a document)
     ZimiUtil.gridRove(board, cells, cols, rows)  one tab stop for a grid of buttons; the arrow keys move between them (display order)
     ZimiUtil.gridAria(board, cells, cols)  the board as an ARIA grid: role=grid, each run of cols cells in a role=row wrapper that takes
                                     no space (display:contents), each cell a gridcell. Call it once the cells are in the board, in order.

   Loaded before the engines (a page's script tag, a test's file list). */
(function (root) {
  'use strict';

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function counted(seed, skip) {
    var next = mulberry32(seed), n = 0;
    function rng() { n++; return next(); }
    rng.seed = seed >>> 0;
    Object.defineProperty(rng, 'draws', { get: function () { return n; } });
    for (var i = 0; i < (skip || 0); i++) rng();
    return rng;
  }

  function snapshot(game) {
    var out = {};
    Object.keys(game).forEach(function (k) { if (k !== 'rng') out[k] = game[k]; });
    out.rng = { seed: game.rng.seed, draws: game.rng.draws };
    return JSON.parse(JSON.stringify(out));
  }

  function restore(saved) {
    var game = JSON.parse(JSON.stringify(saved));
    if (!game.rng || typeof game.rng.seed !== 'number' || typeof game.rng.draws !== 'number') throw new Error('no generator to put back');
    game.rng = counted(game.rng.seed, game.rng.draws);
    return game;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  var DAY_MS = 86400000;
  function dayKey(date, sep) {
    var d = date || new Date(), s = sep || '';
    return d.getFullYear() + s + String(d.getMonth() + 1).padStart(2, '0') + s + String(d.getDate()).padStart(2, '0');
  }

  var DIR_KEYS = Object.freeze({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', a: 'left', d: 'right', w: 'up', s: 'down' });

  function el(tag, cls, text) {
    var e = root.document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // s with every match of the /g pattern removed, again until none is left: one pass over "<scr<script>ipt>"
  // leaves a tag behind. For taking markup out of a page's text.
  function sweep(s, pattern) {
    s = String(s);
    var before;
    do { before = s; s = s.replace(pattern, ''); } while (s !== before);
    return s;
  }

  // The one grid pattern (docs/design/games.md, Accessibility): a grid needs rows, and the boards lay their cells out with CSS grid or
  // absolute positions, so a row is a wrapper with display:contents. The cells keep their parent's layout and their own labels.
  function gridAria(board, cells, cols) {
    board.setAttribute('role', 'grid');
    board.setAttribute('aria-colcount', String(cols));
    board.setAttribute('aria-rowcount', String(Math.ceil(cells.length / cols)));
    for (var i = 0; i < cells.length; i += cols) {
      var first = cells[i], row = first.parentNode;
      if (!row || row.getAttribute('role') !== 'row') {
        row = first.ownerDocument.createElement('div');
        row.setAttribute('role', 'row');
        row.style.display = 'contents';
        first.parentNode.insertBefore(row, first);
      }
      // Each cell says its own column, so a hidden cell (Mini Crossword's blocks) leaves the others where they stand.
      for (var j = i; j < Math.min(i + cols, cells.length); j++) { row.appendChild(cells[j]); cells[j].setAttribute('role', 'gridcell'); cells[j].setAttribute('aria-colindex', String(j - i + 1)); }
    }
  }

  // One tab stop for a grid of buttons, arrow keys inside it (display order). cols is the width, rows the height (default: as many
  // as the cells fill). A board that deals new cells calls it again: the board keeps one listener and the newest cells.
  var ROVE_ARROWS = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
  function gridRove(board, cells, cols, rows) {
    var g = { cells: cells, cols: cols, rows: rows || Math.ceil(cells.length / cols), cur: 0 }, first = !board._zimiRove;
    board._zimiRove = g;
    cells.forEach(function (c, i) {
      c.tabIndex = i ? -1 : 0;
      c.addEventListener('focus', function () { if (board._zimiRove !== g) return; g.cells[g.cur].tabIndex = -1; g.cur = i; c.tabIndex = 0; });
    });
    if (!first) return;
    board.addEventListener('keydown', function (e) {
      var s = board._zimiRove, d = ROVE_ARROWS[e.key];
      if (!d || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      // Past cells that cannot be pressed (a square already fired at) to the next one that can, if any.
      var r = Math.floor(s.cur / s.cols), c = s.cur % s.cols, next;
      do {
        r += d[0]; c += d[1];
        if (r < 0 || c < 0 || r >= s.rows || c >= s.cols) return;
        next = s.cells[r * s.cols + c];
      } while (!next || next.disabled);   // a short last row has no cell under every column
      next.focus();
    });
  }
  // After a board disables cells, keep its one tab stop on a cell that can be pressed, or Tab can no longer reach the grid.
  function gridRoveSync(board) {
    var g = board._zimiRove;
    if (!g || !g.cells[g.cur] || !g.cells[g.cur].disabled) return;
    for (var k = 1; k < g.cells.length; k++) {
      var i = (g.cur + k) % g.cells.length;
      if (!g.cells[i].disabled) { g.cells[g.cur].tabIndex = -1; g.cur = i; g.cells[i].tabIndex = 0; return; }
    }
  }


  root.ZimiUtil = { gridRove: gridRove, gridRoveSync: gridRoveSync, gridAria: gridAria, sweep: sweep, mulberry32: mulberry32, counted: counted, snapshot: snapshot, restore: restore, clamp: clamp, DAY_MS: DAY_MS, dayKey: dayKey, DIR_KEYS: DIR_KEYS, el: el };
})(this);
