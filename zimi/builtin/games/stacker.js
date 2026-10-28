/* ZimiGames: Stacker. Our own code, GPL-3.0. No network, no fonts, no modules.
   Two halves in one file: the rules (pure functions, no DOM, so node can test them) and the
   page (runs only when there is a document). Seven pieces, a seven-piece bag, wall kicks,
   a ghost, hold, a next queue. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var COLS = 10, ROWS = 22, HIDDEN = 2; // the top two rows are above the well
  var TYPES = 'IOTSZJL';
  var QUEUE_MIN = 7;
  var LINE_SCORE = [0, 100, 300, 500, 800]; // times the level
  var LINES_PER_LEVEL = 10, MAX_LEVEL = 15;

  // Each piece in its spawn pose, drawn in a small box (4x4 for I, 2x2 for O, else 3x3).
  var SHAPE_ROWS = {
    I: ['....', 'XXXX', '....', '....'],
    O: ['XX', 'XX'],
    T: ['.X.', 'XXX', '...'],
    S: ['.XX', 'XX.', '...'],
    Z: ['XX.', '.XX', '...'],
    J: ['X..', 'XXX', '...'],
    L: ['..X', 'XXX', '...']
  };

  // The four poses of a piece, as [x, y] cells inside its box. A quarter turn clockwise
  // sends (x, y) to (n - 1 - y, x).
  function buildRotations() {
    var out = {};
    TYPES.split('').forEach(function (t) {
      var rows = SHAPE_ROWS[t], n = rows.length, cells = [];
      rows.forEach(function (row, y) { row.split('').forEach(function (ch, x) { if (ch === 'X') cells.push([x, y]); }); });
      var poses = [cells];
      for (var r = 1; r < 4; r++) {
        poses.push(poses[r - 1].map(function (c) { return [n - 1 - c[1], c[0]]; }));
      }
      out[t] = poses;
    });
    return out;
  }
  var ROT = buildRotations();

  // Wall kicks: the offsets tried, in order, when a turn does not fit where it is. Written
  // with y up, as the usual tables are; kickOffsets flips them for our y-down well.
  var KICKS_JLSTZ = {
    '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]], '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]], '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]
  };
  var KICKS_I = {
    '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]], '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]], '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]], '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]], '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]
  };
  function kickOffsets(type, from, to) {
    if (type === 'O') return [[0, 0]];
    var table = type === 'I' ? KICKS_I : KICKS_JLSTZ;
    return table[from + '>' + to].map(function (k) { return [k[0], -k[1]]; });
  }

  // A small seedable generator, so a test can replay a game.
  var mulberry32 = root.ZimiUtil.mulberry32;

  // The bag: all seven pieces in a shuffled order, then another bag. Never a long drought.
  function refill(g) {
    var bag = TYPES.split('');
    for (var i = bag.length - 1; i > 0; i--) {
      var j = Math.floor(g.rng() * (i + 1)), t = bag[i]; bag[i] = bag[j]; bag[j] = t;
    }
    g.queue = g.queue.concat(bag);
  }

  function emptyBoard() {
    var b = [];
    for (var r = 0; r < ROWS; r++) b.push(new Array(COLS).fill(0));
    return b;
  }

  function collides(board, type, rot, x, y) {
    var cells = ROT[type][rot];
    for (var i = 0; i < cells.length; i++) {
      var bx = x + cells[i][0], by = y + cells[i][1];
      if (bx < 0 || bx >= COLS || by >= ROWS) return true;
      if (by >= 0 && board[by][bx]) return true;
    }
    return false;
  }

  function spawn(g, type) {
    g.cur = { type: type, rot: 0, x: type === 'O' ? 4 : 3, y: 1 };
    if (collides(g.board, type, 0, g.cur.x, g.cur.y)) g.over = true;
  }
  function spawnNext(g) {
    if (g.queue.length < QUEUE_MIN) refill(g);
    spawn(g, g.queue.shift());
    if (g.queue.length < QUEUE_MIN) refill(g);
  }

  function createGame(seed) {
    var g = {
      board: emptyBoard(), queue: [], hold: null, canHold: true, over: false, cur: null,
      score: 0, lines: 0, level: 1,
      rng: mulberry32(seed === undefined ? Math.floor(Math.random() * 4294967296) : seed)
    };
    refill(g);
    spawnNext(g);
    return g;
  }

  function levelFor(lines) { return Math.min(MAX_LEVEL, 1 + Math.floor(lines / LINES_PER_LEVEL)); }
  // Milliseconds per row of gravity: a gentle start that gets quicker each level.
  function gravityMs(level) { return Math.max(50, Math.round(800 * Math.pow(0.82, level - 1))); }

  function tryMove(g, dx, dy) {
    var c = g.cur;
    if (g.over || collides(g.board, c.type, c.rot, c.x + dx, c.y + dy)) return false;
    c.x += dx; c.y += dy;
    return true;
  }
  function move(g, dx) { return tryMove(g, dx, 0); }

  // One row down by the player's hand (a point a row) or by gravity (no points).
  function stepDown(g, soft) {
    if (!tryMove(g, 0, 1)) return false;
    if (soft) g.score += 1;
    return true;
  }

  // Turn by dir (+1 clockwise, -1 counter-clockwise); true when it fitted, with the
  // kick that made it fit in g.cur.kick.
  function rotate(g, dir) {
    var c = g.cur, to = (c.rot + dir + 4) % 4, offs = kickOffsets(c.type, c.rot, to);
    if (g.over) return false;
    for (var i = 0; i < offs.length; i++) {
      if (!collides(g.board, c.type, to, c.x + offs[i][0], c.y + offs[i][1])) {
        c.x += offs[i][0]; c.y += offs[i][1]; c.rot = to; c.kick = i;
        return true;
      }
    }
    return false;
  }

  function grounded(g) { var c = g.cur; return collides(g.board, c.type, c.rot, c.x, c.y + 1); }
  function ghostY(g) {
    var c = g.cur, y = c.y;
    while (!collides(g.board, c.type, c.rot, c.x, y + 1)) y++;
    return y;
  }

  function pieceCells(c) {
    return ROT[c.type][c.rot].map(function (p) { return [c.x + p[0], c.y + p[1]]; });
  }
  // The cells a hard drop would lock: the piece as it is now (its pose, its place after any turn or kick) dropped to the floor.
  function landing(g) {
    var c = g.cur;
    return pieceCells({ type: c.type, rot: c.rot, x: c.x, y: ghostY(g) });
  }

  // Fix the piece in the well, clear full rows, score, bring the next piece.
  // Returns { cleared, lockedOut }.
  function lock(g) {
    var c = g.cur, id = TYPES.indexOf(c.type) + 1, above = 0;
    pieceCells(c).forEach(function (p) {
      if (p[1] < HIDDEN) above++;
      if (p[1] >= 0) g.board[p[1]][p[0]] = id;
    });
    var keep = g.board.filter(function (row) { return row.some(function (v) { return !v; }); });
    var cleared = ROWS - keep.length, lines = [];
    g.board.forEach(function (row, r) { if (row.every(Boolean)) lines.push(r - HIDDEN); });   // where they were, for the flash
    while (keep.length < ROWS) keep.unshift(new Array(COLS).fill(0));
    g.board = keep;
    if (cleared) {
      g.score += LINE_SCORE[cleared] * g.level;
      g.lines += cleared;
      g.level = levelFor(g.lines);
    }
    var lockedOut = above === ROT[c.type][c.rot].length;
    g.canHold = true;
    if (lockedOut) g.over = true;
    else spawnNext(g);
    return { cleared: cleared, lines: lines, lockedOut: lockedOut || g.over };
  }

  // Drop to the floor and lock; two points a row.
  function hardDrop(g) {
    var from = g.cur.y, to = ghostY(g);
    g.cur.y = to;
    g.score += 2 * (to - from);
    var res = lock(g);
    res.rows = to - from;
    return res;
  }

  // Swap the piece with the held one (or take the next if nothing is held), once per piece.
  function holdPiece(g) {
    if (g.over || !g.canHold) return false;
    var type = g.cur.type;
    if (g.hold) spawn(g, g.hold); else spawnNext(g);
    g.hold = type;
    g.canHold = false;
    return true;
  }

  function nextTypes(g, n) { return g.queue.slice(0, n); }

  var Engine = {
    COLS: COLS, ROWS: ROWS, HIDDEN: HIDDEN, TYPES: TYPES, ROT: ROT, LINE_SCORE: LINE_SCORE,
    createGame: createGame, collides: collides, move: move, stepDown: stepDown, rotate: rotate,
    grounded: grounded, ghostY: ghostY, landing: landing, pieceCells: pieceCells, lock: lock, hardDrop: hardDrop,
    holdPiece: holdPiece, nextTypes: nextTypes, gravityMs: gravityMs, levelFor: levelFor,
    kickOffsets: kickOffsets, emptyBoard: emptyBoard
  };
  root.StackerEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, Tx = Play.T;
  var LOCK_MS = 500, MAX_RESETS = 15;       // a grounded piece waits half a second, moves can extend it 15 times
  var DRAG_STEP = 0.9;                      // a finger moves the piece a column per 0.9 cells of travel
  var FLICK_V = 0.6, FLICK_CELLS = 2;       // a downward flick faster than this, longer than this, drops
  var HOLD_UP_CELLS = 2;                    // a swipe up this long holds
  var REPEAT_FIRST_MS = 190, REPEAT_MS = 55; // press and hold on the buttons
  var MAX_CELL = 32, SIDE_W = 96, GAP = 10, MIN_CELL = 12, CHROME_PX = 190, READY_ARM_MS = 650;
  // The well is a dark material in both themes, with a grid you can just see.
  var FIELD = '#0e0e10', FIELD_LINE = 'rgba(255, 255, 255, 0.07)';
  var BEST_KEY = 'zimi.games.stacker.best';
  var NEXT_SHOWN = 3, CLEAR_FLASH_MS = 260;
  var GHOST_TINT = 0.22, GHOST_LINE = 0.95;
  var GHOST_OVER_PIECE = '#ffffff';   // the landing's outline where the piece itself is on top of it
  Play.applyTheme();

  var els = {
    board: $('st-board'), hold: $('st-hold'), next: $('st-next'), score: $('st-score'), lines: $('st-lines'),
    level: $('st-level'), best: $('st-best'), msg: $('st-msg'), pause: $('st-pause'), newBtn: $('st-new'), wrap: $('st-wrap'), holdBox: $('st-holdbox')
  };
  var ctx = els.board.getContext('2d'), hctx = els.hold.getContext('2d'), nctx = els.next.getContext('2d');
  var g, flash = null, cs = 24, mode = 'ready', last = 0, gravAcc = 0, lockAcc = 0, resets = 0, best = Play.load(BEST_KEY, { score: 0 });
  var pal = {}, armed = null, status = Play.status(els.msg);

  function readPalette() {
    var s = getComputedStyle(document.documentElement);
    function v(n) { return s.getPropertyValue(n).trim(); }
    pal = { cell: FIELD, line: FIELD_LINE, ink: v('--ink'), accent: v('--accent'), types: TYPES.split('').map(function (t) { return v('--p-' + t.toLowerCase()); }) };
  }

  function layout() {
    var room = Play.room(CHROME_PX);
    var byWidth = Math.floor((room.w - SIDE_W - GAP) / COLS);
    var byHeight = Math.floor(room.h / (ROWS - HIDDEN));
    cs = Math.max(MIN_CELL, Math.min(MAX_CELL, byWidth, byHeight));
    sizeCanvas(els.board, COLS * cs, (ROWS - HIDDEN) * cs);
    var mini = Math.round(cs * 0.62);
    sizeCanvas(els.hold, 4 * mini + 8, 3 * mini + 8);
    sizeCanvas(els.next, 4 * mini + 8, NEXT_SHOWN * 3 * mini + 8);
    els.wrap.style.setProperty('--side', SIDE_W + 'px');
    draw();
  }
  function sizeCanvas(c, w, h) {
    var dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = w + 'px'; c.style.height = h + 'px';
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function block(c, x, y, size, color, ghost) {
    var pad = Math.max(1, size * 0.06);
    if (ghost) {
      // A tint and a bright outline: the piece's own colour at half strength vanished against the dark well.
      c.fillStyle = color; c.globalAlpha = GHOST_TINT; c.fillRect(x + pad, y + pad, size - 2 * pad, size - 2 * pad);
      c.strokeStyle = color; c.globalAlpha = GHOST_LINE; c.lineWidth = 2;
      c.strokeRect(x + pad + 1, y + pad + 1, size - 2 * pad - 2, size - 2 * pad - 2);
      c.globalAlpha = 1;
      return;
    }
    c.fillStyle = color;
    c.fillRect(x + pad, y + pad, size - 2 * pad, size - 2 * pad);
    c.fillStyle = 'rgba(255,255,255,0.28)';
    c.fillRect(x + pad, y + pad, size - 2 * pad, Math.max(2, size * 0.14));
    c.fillStyle = 'rgba(0,0,0,0.22)';
    c.fillRect(x + pad, y + size - pad - Math.max(2, size * 0.14), size - 2 * pad, Math.max(2, size * 0.14));
  }

  function draw() {
    if (!g) return;
    var W = COLS * cs, H = (ROWS - HIDDEN) * cs;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = pal.cell; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = pal.line; ctx.lineWidth = 1; ctx.beginPath();
    for (var x = 1; x < COLS; x++) { ctx.moveTo(x * cs + 0.5, 0); ctx.lineTo(x * cs + 0.5, H); }
    for (var y = 1; y < ROWS - HIDDEN; y++) { ctx.moveTo(0, y * cs + 0.5); ctx.lineTo(W, y * cs + 0.5); }
    ctx.stroke();
    for (var r = HIDDEN; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) if (g.board[r][c]) block(ctx, c * cs, (r - HIDDEN) * cs, cs, pal.types[g.board[r][c] - 1]);
    }
    if (!g.over) {
      var cur = g.cur, color = pal.types[TYPES.indexOf(cur.type)], held = {};
      pieceCells(cur).forEach(function (p) { held[p[0] + ',' + p[1]] = true; });
      // Where a hard drop lands: outlined under the piece, and on top of it where the two overlap (a tall piece a row or two
      // above its landing would otherwise hide it). Nothing when it is already there.
      var mark = grounded(g) ? [] : landing(g).filter(function (p) { return p[1] >= HIDDEN; });
      var outline = function (p, c) { block(ctx, p[0] * cs, (p[1] - HIDDEN) * cs, cs, c, true); };
      mark.forEach(function (p) { if (!held[p[0] + ',' + p[1]]) outline(p, color); });
      pieceCells(cur).forEach(function (p) { if (p[1] >= HIDDEN) block(ctx, p[0] * cs, (p[1] - HIDDEN) * cs, cs, color); });
      mark.forEach(function (p) { if (held[p[0] + ',' + p[1]]) outline(p, GHOST_OVER_PIECE); });
    }
    drawFlash(W);
    drawMini(hctx, els.hold, g.hold ? [g.hold] : [], g.canHold ? 1 : 0.4);
    drawMini(nctx, els.next, nextTypes(g, NEXT_SHOWN), 1);
  }

  // Rows that just cleared flash white where they were and fade; the stack has already come down.
  function drawFlash(W) {
    if (!flash) return;
    var k = (performance.now() - flash.t) / CLEAR_FLASH_MS;
    if (k >= 1) { flash = null; return; }
    ctx.fillStyle = 'rgba(255,255,255,' + (0.85 * (1 - k)).toFixed(3) + ')';
    flash.rows.forEach(function (r) { if (r >= 0) ctx.fillRect(0, r * cs, W, cs); });
  }

  function drawMini(c, canvas, types, alpha) {
    var mini = Math.round(cs * 0.62), w = parseFloat(canvas.style.width), h = parseFloat(canvas.style.height);
    c.fillStyle = FIELD; c.fillRect(0, 0, w, h);
    c.globalAlpha = alpha;
    types.forEach(function (t, i) {
      var cells = ROT[t][0], minX = 9, maxX = 0, minY = 9, maxY = 0;
      cells.forEach(function (p) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
      var ox = (w - (maxX - minX + 1) * mini) / 2 - minX * mini, oy = 4 + i * 3 * mini + (3 * mini - (maxY - minY + 1) * mini) / 2 - minY * mini;
      cells.forEach(function (p) { block(c, ox + p[0] * mini, oy + p[1] * mini, mini, pal.types[TYPES.indexOf(t)]); });
    });
    c.globalAlpha = 1;
  }

  function hud() {
    els.score.textContent = Play.num(g.score); els.lines.textContent = Play.num(g.lines); els.level.textContent = Play.num(g.level);
    els.best.textContent = Play.num(Math.max(best.score, g.score));
  }

  // ── the loop ──
  function frame(t) {
    if (mode !== 'playing') return;
    var dt = Math.min(100, t - last); last = t;
    if (grounded(g)) {
      lockAcc += dt;
      if (lockAcc >= LOCK_MS) afterLock(lock(g));
    } else {
      lockAcc = 0; gravAcc += dt;
      var ms = gravityMs(g.level);
      while (gravAcc >= ms && !grounded(g)) { gravAcc -= ms; stepDown(g, false); }
    }
    draw(); hud();
    if (mode === 'playing') requestAnimationFrame(frame);
  }
  function startLoop() { last = performance.now(); requestAnimationFrame(frame); }

  function newPiece() { gravAcc = 0; lockAcc = 0; resets = 0; }
  function afterLock(res) {
    newPiece();
    if (res.cleared && !Play.reducedMotion()) flash = { rows: res.lines, t: performance.now() };
    status.say(res.cleared ? Tx('stacker.clear.' + res.cleared) : '');
    if (g.over) return finish();
  }

  function touched() { // a move or turn while on the floor buys a little more time
    if (grounded(g) && resets < MAX_RESETS) { lockAcc = 0; resets++; }
  }
  function act(fn) {
    if (mode !== 'playing') return;
    var res = fn();
    if (res) { touched(); draw(); hud(); }
    return res;
  }
  var doLeft = function () { return act(function () { return move(g, -1); }); };
  var doRight = function () { return act(function () { return move(g, 1); }); };
  var doRotate = function (d) { return act(function () { return rotate(g, d); }); };
  var doDown = function () { return act(function () { var ok = stepDown(g, true); if (ok) { gravAcc = 0; lockAcc = 0; } return ok; }); };
  function doDrop() {
    if (mode !== 'playing') return;
    afterLock(hardDrop(g)); draw(); hud();
  }
  function doHold() { act(function () { var ok = holdPiece(g); if (ok) newPiece(); return ok; }); }

  // ── start, pause, game over ──
  function readyOpts() { return { say: status.say, target: pad.stage, start: begin }; }
  function arm() { if (armed) armed.cancel(); g = createGame(); newPiece(); mode = 'ready'; hud(); draw(); armed = Play.ready(readyOpts()); }
  function begin() {
    if (armed) armed.cancel();
    g = createGame(); newPiece(); mode = 'playing'; status.say(''); Play.pauseLabel(els.pause, false); els.pause.disabled = false; hud(); draw(); startLoop();
  }
  function pause() { if (mode !== 'playing') return; mode = 'paused'; stopRepeat(); Play.pauseLabel(els.pause, true); status.say(Tx('play.paused')); }
  function resume() { if (mode !== 'paused') return; mode = 'playing'; Play.pauseLabel(els.pause, false); status.say(''); startLoop(); }
  function toggle() { if (mode === 'playing') pause(); else resume(); }
  var lastEnd = null;
  function finish() {
    mode = 'over'; els.pause.disabled = true; Play.pauseLabel(els.pause, false); stopRepeat();
    if (g.score > best.score) { best.score = g.score; Play.save(BEST_KEY, best); }
    lastEnd = [[Tx('play.score'), Play.num(g.score)], [Tx('play.best'), Play.num(best.score)]];
    draw(); hud();
    ZimiShell.endSheet({ result: 'over', stats: lastEnd });
    setTimeout(function () { if (mode === 'over') armed = Play.ready(readyOpts()); }, READY_ARM_MS);
  }
  els.newBtn.addEventListener('click', begin);
  els.pause.addEventListener('click', toggle);
  Play.onHidden(pause);
  ZimiShell.game({
    inProgress: function () { return mode === 'playing' || mode === 'paused'; },
    stats: function () { return [[Tx('play.best'), Play.num(best.score)]]; }
  });

  // ── input ──
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    if (document.querySelector('.ar-sheet:not([hidden])')) return;
    if (mode !== 'playing') {
      if ((k === 'Escape' || k === 'p' || k === 'P') && mode === 'paused') { e.preventDefault(); resume(); }
      return;
    }
    var handled = true;
    if (k === 'ArrowLeft') doLeft();
    else if (k === 'ArrowRight') doRight();
    else if (k === 'ArrowDown') doDown();
    else if (k === 'ArrowUp' || k === 'x' || k === 'X') doRotate(1);
    else if (k === 'z' || k === 'Z') doRotate(-1);
    else if (k === ' ') { if (!e.repeat) doDrop(); }
    else if (k === 'c' || k === 'C' || k === 'Shift') doHold();
    else if (k === 'Escape' || k === 'p' || k === 'P') toggle();
    else handled = false;
    if (handled) e.preventDefault();
  });

  var dragX = 0, dragY = 0;
  Play.gesture(els.board, {
    down: function () { dragX = 0; dragY = 0; },
    drag: function (dx, dy) {
      var cx = Math.trunc(dx / (cs * DRAG_STEP)), cy = Math.trunc(dy / (cs * DRAG_STEP));
      while (dragX < cx) { doRight(); dragX++; }
      while (dragX > cx) { doLeft(); dragX--; }
      while (dragY < cy) { doDown(); dragY++; }
    },
    up: function (s) {
      if (s.tap) return doRotate(1);
      if (Math.abs(s.dy) > Math.abs(s.dx) * 1.5) {
        if (s.dy > cs * FLICK_CELLS && s.vy > FLICK_V) doDrop();
        else if (s.dy < -cs * HOLD_UP_CELLS) doHold();
      }
    }
  });

  // The pad: left, right and down repeat while held; Rotate and Drop act once. Hold is a tap on the Hold box.
  var REPEAT_ACT = { left: doLeft, right: doRight, down: doDown }, repeatTimer = 0;
  function stopRepeat() { clearTimeout(repeatTimer); repeatTimer = 0; }
  var pad = Play.pad(els.wrap, { dirs: ['left', 'down', 'right'], actions: [{ name: 'rotate', label: Tx('play.rotate') }, { name: 'drop', label: Tx('play.drop') }], swipe: false, on: function (name, down) {
    stopRepeat();
    if (!down) return;
    if (name === 'rotate') return doRotate(1);
    if (name === 'drop') return doDrop();
    var f = REPEAT_ACT[name], again = function () { f(); repeatTimer = setTimeout(again, REPEAT_MS); };
    f(); repeatTimer = setTimeout(again, REPEAT_FIRST_MS);
  } });
  els.holdBox.addEventListener('click', doHold);
  pad.stage.addEventListener('pointerdown', function () { if (mode === 'paused') resume(); });

  window.addEventListener('resize', layout);
  readPalette();
  if (matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { readPalette(); draw(); });
  layout(); arm();
  // Leaving and coming back keeps the game: paused where it was, or at its end sheet.
  ZimiShell.persist({
    save: function () {
      if (mode === 'over' && lastEnd) return { end: lastEnd };
      return mode === 'playing' || mode === 'paused' ? { g: g } : null;
    },
    load: function (d) {
      if (armed) armed.cancel();
      if (d.end) {
        mode = 'over'; lastEnd = d.end; hud(); draw();
        ZimiShell.endSheet({ result: 'over', stats: d.end });
        setTimeout(function () { if (mode === 'over') armed = Play.ready(readyOpts()); }, READY_ARM_MS);
        return true;
      }
      if (!d.g || !d.g.board) return false;
      g = d.g; g.rng = mulberry32(Math.floor(Math.random() * 4294967296)); newPiece(); mode = 'paused';
      els.pause.disabled = false; Play.pauseLabel(els.pause, true); status.say(Tx('play.paused')); hud(); draw();
      return true;
    }
  });
  // A read-only window onto the live game, for the browser tests.
  root.__stacker = { get g() { return g; }, get mode() { return mode; }, get cell() { return cs; }, draw: draw };
})(this);
