/* ZimiGames: 2048 (slide the tiles, merge equal ones). Our own code, GPL-3.0.
   No network, no fonts, no modules. The rules (pure functions, no DOM, so node can test them)
   and the page (only when there is a document). */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var SIZE = 4, GOAL = 2048, FOUR_CHANCE = 0.1, START_TILES = 2;
  var DIR_NAMES = ['left', 'right', 'up', 'down'];

  var mulberry32 = root.ZimiUtil.mulberry32;

  // A tile is { id, v }: the id lets the page slide the same tile from cell to cell.
  function newTile(g, v) { return { id: g.nextId++, v: v }; }
  function snapshot(g) {
    return { cells: g.cells.map(function (t) { return t && { id: t.id, v: t.v }; }), score: g.score, won: g.won, nextId: g.nextId };
  }

  function emptyGame(seed) {
    return {
      size: SIZE, cells: new Array(SIZE * SIZE).fill(null), nextId: 1, score: 0, won: false, over: false, undo: null,
      rng: mulberry32(seed === undefined ? Math.floor(Math.random() * 4294967296) : seed)
    };
  }

  function addRandomTile(g) {
    var free = [];
    g.cells.forEach(function (t, i) { if (!t) free.push(i); });
    if (!free.length) return null;
    var at = free[Math.floor(g.rng() * free.length)], tile = newTile(g, g.rng() < FOUR_CHANCE ? 4 : 2);
    g.cells[at] = tile;
    return { id: tile.id, at: at, value: tile.v };
  }

  function createGame(seed) {
    var g = emptyGame(seed);
    for (var i = 0; i < START_TILES; i++) addRandomTile(g);
    return g;
  }

  // A board from a list of 16 values (0 for empty): for tests and for restoring a saved game.
  function fromValues(values, score, seed) {
    var g = emptyGame(seed);
    values.forEach(function (v, i) { if (v) g.cells[i] = newTile(g, v); });
    g.score = score || 0;
    g.won = values.some(function (v) { return v >= GOAL; });
    g.over = !canMove(g);
    return g;
  }
  function values(g) { return g.cells.map(function (t) { return t ? t.v : 0; }); }

  // The cell indexes of line i, front first: the cell tiles slide toward comes first.
  function line(dir, i, n) {
    var out = [];
    for (var k = 0; k < n; k++) {
      var j = (dir === 'right' || dir === 'down') ? n - 1 - k : k;
      out.push(dir === 'left' || dir === 'right' ? i * n + j : j * n + i);
    }
    return out;
  }

  function canMove(g) {
    var n = g.size;
    for (var i = 0; i < g.cells.length; i++) {
      if (!g.cells[i]) return true;
      var r = Math.floor(i / n), c = i % n, right = c + 1 < n ? g.cells[i + 1] : null, below = r + 1 < n ? g.cells[i + n] : null;
      if ((right && right.v === g.cells[i].v) || (below && below.v === g.cells[i].v)) return true;
    }
    return false;
  }

  // Slide everything toward dir. Equal neighbours merge once per move, the one nearer the
  // wall first. Returns { moved, gain, moves, merges, spawned }; nothing changes if nothing moved.
  function move(g, dir) {
    var n = g.size, before = snapshot(g), cells = new Array(g.cells.length).fill(null);
    var moves = [], merges = [], gain = 0, moved = false;
    for (var i = 0; i < n; i++) {
      var idx = line(dir, i, n), tiles = idx.map(function (p) { return { t: g.cells[p], from: p }; }).filter(function (e) { return e.t; });
      var slot = 0;
      for (var k = 0; k < tiles.length; k++) {
        var to = idx[slot], a = tiles[k], b = tiles[k + 1];
        if (b && a.t.v === b.t.v) {
          var merged = newTile(g, a.t.v * 2);
          cells[to] = merged; gain += merged.v;
          moves.push({ id: a.t.id, from: a.from, to: to }, { id: b.t.id, from: b.from, to: to });
          merges.push({ ids: [a.t.id, b.t.id], id: merged.id, to: to, value: merged.v });
          moved = true; k++;
        } else {
          cells[to] = a.t;
          if (a.from !== to) { moves.push({ id: a.t.id, from: a.from, to: to }); moved = true; }
        }
        slot++;
      }
    }
    if (!moved) return { moved: false, gain: 0, moves: [], merges: [], spawned: null };
    g.cells = cells; g.score += gain; g.undo = before;
    merges.forEach(function (m) { if (m.value >= GOAL) g.won = true; });
    var spawned = addRandomTile(g);
    g.over = !canMove(g);
    return { moved: true, gain: gain, moves: moves, merges: merges, spawned: spawned };
  }

  // Take back the last move, once. The random tile that came after it goes too.
  function undo(g) {
    if (!g.undo) return false;
    g.cells = g.undo.cells; g.score = g.undo.score; g.won = g.undo.won; g.nextId = g.undo.nextId;
    g.undo = null; g.over = false;
    return true;
  }

  var Engine = { SIZE: SIZE, GOAL: GOAL, DIR_NAMES: DIR_NAMES, createGame: createGame, fromValues: fromValues, values: values, move: move, undo: undo, canMove: canMove };
  root.Engine2048 = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var SWIPE_PX = 24, BUMP_SCALE = 1.18, SLIDE_MS = 110, MAX_BOARD = 560, SIDE_PAD = 24, END_AFTER_MS = 600;
  var BEST_KEY = 'zimi.games.2048.best';
  Play.applyTheme();

  var els = { page: $('tf-main'), board: $('tf-board'), stat: $('tf-stat'), msg: $('tf-msg'), undo: $('tf-undo'), fresh: $('tf-new') };
  var note = Play.status(els.msg);
  var g, els2 = {}, cell = 80, gap = 10, best = Play.load(BEST_KEY, { score: 0 }), asked = false;

  function layout() {
    var vw = document.documentElement.clientWidth, side = Math.min(vw - SIDE_PAD, MAX_BOARD);
    gap = Math.max(6, Math.round(side * 0.025));
    cell = Math.floor((side - gap * (SIZE + 1)) / SIZE);
    var px = cell * SIZE + gap * (SIZE + 1);
    els.board.style.width = px + 'px'; els.board.style.height = px + 'px';
    els.board.style.setProperty('--cell', cell + 'px'); els.board.style.setProperty('--gap', gap + 'px');
    Object.keys(els2).forEach(function (id) { place(els2[id]); });
    Array.prototype.forEach.call(els.board.querySelectorAll('.tf-slot'), place);
  }
  function place(el) {
    var i = Number(el.dataset.at);
    el.style.transform = 'translate(' + (gap + (i % SIZE) * (cell + gap)) + 'px,' + (gap + Math.floor(i / SIZE) * (cell + gap)) + 'px)';
  }
  function tileClass(v) { return 'tf-tile t' + (v >= 4096 ? 'big' : v); }
  function makeTile(id, v, at, cls) {
    var el = document.createElement('div');
    el.className = tileClass(v) + (cls ? ' ' + cls : ''); el.textContent = Play.num(v); el.dataset.at = at; el.setAttribute('role', 'gridcell');
    el.setAttribute('aria-label', Play.num(v));
    place(el); els.board.appendChild(el); els2[id] = el;
    return el;
  }
  function drop(id) { if (els2[id]) { els2[id].remove(); delete els2[id]; } }
  function makeSlots() {
    for (var i = 0; i < SIZE * SIZE; i++) {
      var s = document.createElement('div');
      s.className = 'tf-slot'; s.dataset.at = i; place(s); els.board.appendChild(s);
    }
  }
  function rebuild() {
    Object.keys(els2).forEach(drop);
    g.cells.forEach(function (t, i) { if (t) makeTile(t.id, t.v, i); });
  }

  function hud() {
    els.stat.textContent = Play.num(g.score) + ' \u00b7 ' + T('play.best') + ' ' + Play.num(Math.max(best.score, g.score));   // the bar's one stat
    els.undo.disabled = !g.undo;
  }
  function persist() {
    if (g.score > best.score) { best.score = g.score; Play.save(BEST_KEY, best); }
    // the board itself is kept by the shell (ZimiShell.persist, below)
  }

  function act(dir) {
    if (document.querySelector('.ar-sheet:not([hidden])')) return;
    var res = move(g, dir), instant = Play.reducedMotion();
    if (!res.moved) return;
    var gone = {};
    res.merges.forEach(function (m) { m.ids.forEach(function (id) { gone[id] = true; }); });
    res.moves.forEach(function (m) { var el = els2[m.id]; if (el) { el.dataset.at = m.to; place(el); } });
    function settle() {
      res.merges.forEach(function (m) { m.ids.forEach(drop); makeTile(m.id, m.value, m.to, 'pop'); });
      if (res.spawned) makeTile(res.spawned.id, res.spawned.value, res.spawned.at, 'new');
    }
    if (instant) settle(); else setTimeout(settle, SLIDE_MS);
    hud(); persist();
    if (res.gain) scored(res);
    note.say('');
    if (g.won && !asked) { asked = true; note.say(T('t2048.reached')); endSheet('win'); }
    else if (g.over) { note.say(g.won ? '' : T('t2048.over')); endSheet(g.won ? 'win' : 'lose'); }
  }
  // The points a move earned rise off the biggest tile it made, and the bar's score gives a small bump.
  function scored(res) {
    if (Play.reducedMotion()) return;
    var top = res.merges.reduce(function (a, m) { return m.value > a.value ? m : a; }), at = top.to;
    Play.float(els.board, '+' + Play.num(res.gain), gap + (at % SIZE) * (cell + gap) + cell / 2, gap + Math.floor(at / SIZE) * (cell + gap));
    if (els.stat.animate) els.stat.animate([{ scale: 1 }, { scale: BUMP_SCALE }, { scale: 1 }], { duration: SLIDE_MS * 2, easing: 'ease-out' });
  }

  // The end: 2048 reached is a win (Close keeps going on the same board), no moves left without it is a loss.
  function endSheet(result) { ZimiShell.endSheet({ result: result, after: END_AFTER_MS, stats: [[T('play.score'), Play.num(g.score)], [T('play.best'), Play.num(Math.max(best.score, g.score))]] }); }
  // A board with nothing played says how to play, once; the first move takes the line away.
  function startLine() { return g.score === 0 && !g.undo && values(g).filter(Boolean).length <= START_TILES ? T('t2048.swipe') : ''; }
  function fresh() { g = createGame(); asked = false; rebuild(); hud(); persist(); note.say(startLine()); }
  els.fresh.addEventListener('click', fresh);
  els.undo.addEventListener('click', function () { if (undo(g)) { rebuild(); hud(); persist(); note.say(''); } });
  ZimiShell.game({
    inProgress: function () { return !g.over && values(g).some(Boolean); },
    stats: function () { return [[T('play.best'), Play.num(best.score)]]; }
  });

  var KEYS = root.ZimiUtil.DIR_KEYS;
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.ar-sheet:not([hidden])')) return;
    var dir = KEYS[e.key];
    if (dir) { e.preventDefault(); act(dir); }
    else if ((e.key === 'z' || e.key === 'Z' || e.key === 'u') && !els.undo.disabled) els.undo.click();
  });
  // A swipe moves the tiles the moment it is long enough, not when the finger lifts, and from anywhere on the page.
  var swiped = false;
  Play.gesture(els.page, {
    down: function () { swiped = false; },
    drag: function (dx, dy) {
      var d = !swiped && Play.swipeDir(dx, dy, SWIPE_PX);
      if (d) { swiped = true; act(d); }
    }
  });

  var saved = ZimiShell.saved();
  g = saved && Array.isArray(saved.v) && saved.v.length === SIZE * SIZE && saved.v.every(function (v) { return v === 0 || (v >= 2 && (v & (v - 1)) === 0); }) ? fromValues(saved.v, saved.score) : createGame();
  asked = g.won; // already past the goal when restored
  window.addEventListener('resize', layout);
  makeSlots(); layout(); rebuild(); hud(); note.say(startLine());
  if (g.over) endSheet(g.won ? 'win' : 'lose');
  ZimiShell.persist({ save: function () { return { v: values(g), score: g.score, undo: g.undo }; } });
  // Undo survives leaving: the kept snapshot (cells, score, goal flag) goes back on the board.
  if (saved && saved.undo && Array.isArray(saved.undo.cells) && saved.undo.cells.length === SIZE * SIZE && saved.undo.cells.every(function (t) { return t === null || (t && t.v >= 2 && (t.v & (t.v - 1)) === 0); })) {
    g.undo = { cells: saved.undo.cells, score: saved.undo.score || 0, won: !!saved.undo.won, nextId: saved.undo.nextId || 1 };
    g.nextId = Math.max(g.nextId, g.undo.nextId + SIZE * SIZE); hud();
  }
  // A read-only window onto the live game, for the browser tests.
  root.__t2048 = { get g() { return g; } };
})(this);
