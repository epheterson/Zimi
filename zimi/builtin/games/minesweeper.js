/* ZimiGames: Minesweeper. Our own code, GPL-3.0. No network, no fonts, no modules.
   Two halves in one file: the game rules (pure functions, no DOM, so node can test
   them) and the page (runs only when there is a document). */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var HIDDEN = 0, OPEN = 1, FLAG = 2, QUESTION = 3;
  var LEVELS = {
    beginner: { rows: 9, cols: 9, mines: 10 },
    intermediate: { rows: 16, cols: 16, mines: 40 },
    expert: { rows: 16, cols: 30, mines: 99 }
  };
  var MIN_SIDE = 5, MAX_ROWS = 24, MAX_COLS = 30;
  var NEIGHBOUR_BOX = 9; // a cell and its eight neighbours

  // A small seedable generator, so a test can replay a board.
  var mulberry32 = root.ZimiUtil.mulberry32;

  function buildNeighbours(rows, cols) {
    var nb = new Array(rows * cols);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var list = [];
        for (var dr = -1; dr <= 1; dr++) {
          for (var dc = -1; dc <= 1; dc++) {
            var rr = r + dr, cc = c + dc;
            if ((dr || dc) && rr >= 0 && rr < rows && cc >= 0 && cc < cols) list.push(rr * cols + cc);
          }
        }
        nb[r * cols + c] = list;
      }
    }
    return nb;
  }

  // Mines are laid on the first click, so the first click can be made safe.
  function createGame(rows, cols, mines, seed) {
    var size = rows * cols;
    return {
      rows: rows, cols: cols, size: size, mines: mines,
      state: new Uint8Array(size), mine: new Uint8Array(size), count: new Uint8Array(size),
      nb: buildNeighbours(rows, cols),
      rng: mulberry32(seed === undefined ? Math.floor(Math.random() * 4294967296) : seed),
      status: 'ready', placed: false, opened: 0, flags: 0, exploded: []
    };
  }

  function placeMines(g, safe) {
    // Keep the clicked cell and its neighbours clear so the first click opens an
    // area; if the board is too full for that, keep only the clicked cell clear.
    var wide = g.size - (1 + g.nb[safe].length) >= g.mines;
    var skip = {};
    skip[safe] = true;
    if (wide) g.nb[safe].forEach(function (n) { skip[n] = true; });
    var pool = [];
    for (var i = 0; i < g.size; i++) if (!skip[i]) pool.push(i);
    for (var k = 0; k < g.mines; k++) { // partial shuffle: the first `mines` slots are the picks
      var j = k + Math.floor(g.rng() * (pool.length - k));
      var t = pool[k]; pool[k] = pool[j]; pool[j] = t;
      g.mine[pool[k]] = 1;
    }
    for (var m = 0; m < g.size; m++) {
      var n = 0, list = g.nb[m];
      for (var q = 0; q < list.length; q++) n += g.mine[list[q]];
      g.count[m] = n;
    }
    g.placed = true;
  }

  function checkWin(g) {
    if (g.status !== 'playing' || g.opened !== g.size - g.mines) return false;
    g.status = 'won';
    for (var i = 0; i < g.size; i++) if (g.mine[i]) g.state[i] = FLAG;
    g.flags = g.mines;
    return true;
  }

  function lose(g, hit) {
    g.status = 'lost';
    g.exploded = hit;
    // Show every mine that was not flagged; wrong flags stay put so they can be crossed out.
    for (var i = 0; i < g.size; i++) if (g.mine[i] && g.state[i] !== FLAG) g.state[i] = OPEN;
  }

  // Open from a safe cell, spreading through zeros. A stack, not recursion:
  // a big empty Expert board must not overflow the call stack.
  function flood(g, start, out) {
    var stack = [start];
    while (stack.length) {
      var i = stack.pop();
      if (g.state[i] === OPEN || g.state[i] === FLAG) continue;
      g.state[i] = OPEN;
      g.opened++;
      out.push(i);
      if (g.count[i] === 0) {
        var list = g.nb[i];
        for (var k = 0; k < list.length; k++) {
          var s = g.state[list[k]];
          if (s !== OPEN && s !== FLAG) stack.push(list[k]);
        }
      }
    }
  }

  function playable(g) { return g.status === 'ready' || g.status === 'playing'; }

  // Returns { opened: [cells], hit: [mines that went off] }.
  function reveal(g, idx) {
    var out = [], res = { opened: out, hit: [] };
    if (!playable(g) || (g.state[idx] !== HIDDEN && g.state[idx] !== QUESTION)) return res;
    if (!g.placed) { placeMines(g, idx); g.status = 'playing'; }
    if (g.mine[idx]) { g.state[idx] = OPEN; out.push(idx); res.hit.push(idx); lose(g, res.hit); return res; }
    flood(g, idx, out);
    checkWin(g);
    return res;
  }

  function flagsAround(g, idx) {
    var n = 0, list = g.nb[idx];
    for (var k = 0; k < list.length; k++) if (g.state[list[k]] === FLAG) n++;
    return n;
  }

  // Chord: on an open number whose flags match it, open every other neighbour.
  // A wrong flag means a mine gets opened and the game is lost.
  function chord(g, idx) {
    var out = [], res = { opened: out, hit: [] };
    if (g.status !== 'playing' || g.state[idx] !== OPEN || g.count[idx] === 0 || flagsAround(g, idx) !== g.count[idx]) return res;
    var list = g.nb[idx];
    for (var k = 0; k < list.length; k++) {
      var n = list[k], s = g.state[n];
      if (s !== HIDDEN && s !== QUESTION) continue;
      if (g.mine[n]) { g.state[n] = OPEN; out.push(n); res.hit.push(n); }
      else flood(g, n, out);
    }
    if (res.hit.length) lose(g, res.hit);
    else checkWin(g);
    return res;
  }

  // none -> flag -> ? -> none (the ? step is skipped when marks are off). Returns the new state or -1.
  function cycleMark(g, idx, useQuestion) {
    if (!playable(g)) return -1;
    var s = g.state[idx];
    if (s === OPEN) return -1;
    if (s === HIDDEN) { g.state[idx] = FLAG; g.flags++; }
    else if (s === FLAG) { g.flags--; g.state[idx] = useQuestion ? QUESTION : HIDDEN; }
    else g.state[idx] = HIDDEN;
    return g.state[idx];
  }

  function validateCustom(rows, cols, mines) {
    function whole(v) { return typeof v === 'string' && v.trim() === '' ? NaN : Number(v); }
    var r = whole(rows), c = whole(cols), m = whole(mines);
    if (!Number.isInteger(r) || r < MIN_SIDE || r > MAX_ROWS) return { ok: false, field: 'rows', error: 'Rows: a whole number from ' + MIN_SIDE + ' to ' + MAX_ROWS };
    if (!Number.isInteger(c) || c < MIN_SIDE || c > MAX_COLS) return { ok: false, field: 'cols', error: 'Columns: a whole number from ' + MIN_SIDE + ' to ' + MAX_COLS };
    var most = r * c - NEIGHBOUR_BOX; // leaves room for the first click's opening
    if (!Number.isInteger(m) || m < 1 || m > most) return { ok: false, field: 'mines', error: 'Mines: a whole number from 1 to ' + most };
    return { ok: true, rows: r, cols: c, mines: m };
  }

  var Engine = {
    HIDDEN: HIDDEN, OPEN: OPEN, FLAG: FLAG, QUESTION: QUESTION, LEVELS: LEVELS,
    MIN_SIDE: MIN_SIDE, MAX_ROWS: MAX_ROWS, MAX_COLS: MAX_COLS,
    mulberry32: mulberry32, createGame: createGame, placeMines: placeMines, reveal: reveal,
    chord: chord, cycleMark: cycleMark, flagsAround: flagsAround, checkWin: checkWin,
    validateCustom: validateCustom
  };
  root.MinesweeperEngine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, T = Play.T;
  var LONG_PRESS_MS = 350, HAPTIC_MS = 15, MOVE_CANCEL_PX = 10, END_AFTER_MS = 700;
  var CELL_DESKTOP = 30, CELL_TOUCH_MIN = 32, CELL_TOUCH_MAX = 44, FRAME_PAD = 58, WIDE_VIEWPORT = 700;
  var RIPPLE_MS = 16, RIPPLE_MAX_MS = 420, HOLD_HINT_MS = 120, BOOM_AFTER_MS = 1100, FLAG_POP_MS = 150; // openings ripple out from the tap; a held cell sinks a little before it flags
  var TIMER_MAX = 999, TICK_MS = 200, LEVEL_IDS = ['beginner', 'intermediate', 'expert', 'custom'];
  var SETTINGS_KEY = 'zimi.games.minesweeper.settings', BEST_KEY = 'zimi.games.minesweeper.best';

  function $(id) { return document.getElementById(id); }
  function store(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' ? v : fallback; } catch (e) { return fallback; }
  }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode: play on without it */ } }
  function levelName(lv) { return T('mines.level.' + lv); }

  var settings = store(SETTINGS_KEY, {});
  if (LEVEL_IDS.indexOf(settings.level) < 0) settings.level = 'beginner';
  if (typeof settings.marks !== 'boolean') settings.marks = !matchMedia('(pointer: coarse)').matches;   // a thumb flags in two taps, not three
  if (!settings.custom || !validateCustom(settings.custom.rows, settings.custom.cols, settings.custom.mines).ok) settings.custom = { rows: 12, cols: 20, mines: 40 };
  var best = store(BEST_KEY, {});

  var params = new URLSearchParams(location.search);
  var fixedSeed = params.has('seed') ? Number(params.get('seed')) : undefined;
  if (params.get('theme') === 'light' || params.get('theme') === 'dark') document.documentElement.setAttribute('data-theme', params.get('theme'));
  if (params.get('level') && LEVEL_IDS.indexOf(params.get('level')) >= 0 && params.get('level') !== 'custom') settings.level = params.get('level');

  var game, cells = [], flagMode = false, cursor = -1, press = null, tickTimer = 0, startedAt = 0, finalMs = 0;
  var els = {
    board: $('ms-board'), win: $('ms-win'), face: $('ms-face'), mines: $('ms-mines'), time: $('ms-time'),
    msg: $('ms-msg'), flagBtn: $('ms-flagmode'), fresh: $('ms-new')
  };
  var line = Play.status(els.msg);

  // Our own artwork, all inline SVG.
  var SVG = {
    flag: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 17h12M10 17V5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10 3l-6 3.2L10 9.4z" fill="#b3261e"/></svg>',
    mine: '<svg viewBox="0 0 20 20" aria-hidden="true"><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 2v16M2 10h16M4.3 4.3l11.4 11.4M15.7 4.3L4.3 15.7"/></g><circle cx="10" cy="10" r="5.2" fill="currentColor"/><circle cx="8.2" cy="8.2" r="1.5" fill="#fff" fill-opacity="0.85"/></svg>',
    wrong: '<svg viewBox="0 0 20 20" aria-hidden="true"><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 2v16M2 10h16M4.3 4.3l11.4 11.4M15.7 4.3L4.3 15.7"/></g><circle cx="10" cy="10" r="5.2" fill="currentColor"/><path d="M3 3l14 14M17 3L3 17" stroke="#b3261e" stroke-width="2.4" stroke-linecap="round"/></svg>'
  };
  var FACE_BASE = '<defs><radialGradient id="msg" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#ffec6a"/><stop offset="1" stop-color="#f0b400"/></radialGradient></defs><circle cx="16" cy="16" r="13.5" fill="url(#msg)" stroke="#6b4e00" stroke-width="1.5"/>';
  var EYES = '<ellipse cx="11.5" cy="13" rx="1.7" ry="2.4" fill="#1b1b1b"/><ellipse cx="20.5" cy="13" rx="1.7" ry="2.4" fill="#1b1b1b"/>';
  var FACES = {
    smile: EYES + '<path d="M9.5 19.5q6.5 6 13 0" fill="none" stroke="#1b1b1b" stroke-width="1.8" stroke-linecap="round"/>',
    worried: '<ellipse cx="11.5" cy="12.5" rx="2.1" ry="2.9" fill="#fff" stroke="#1b1b1b" stroke-width="1.2"/><ellipse cx="20.5" cy="12.5" rx="2.1" ry="2.9" fill="#fff" stroke="#1b1b1b" stroke-width="1.2"/><circle cx="11.5" cy="13.2" r="1.1" fill="#1b1b1b"/><circle cx="20.5" cy="13.2" r="1.1" fill="#1b1b1b"/><ellipse cx="16" cy="22.5" rx="2.6" ry="3" fill="#1b1b1b"/>',
    win: '<path d="M5.5 11.5h21l-1.6 5.2q-.5 1.6-2.2 1.6h-3.2q-1.7 0-2.2-1.6l-.8-2.4h-1.8l-.8 2.4q-.5 1.6-2.2 1.6H9.3q-1.7 0-2.2-1.6z" fill="#1b1b1b"/><path d="M9.5 20q6.5 6.5 13 0" fill="none" stroke="#1b1b1b" stroke-width="1.8" stroke-linecap="round"/>',
    dead: '<g stroke="#1b1b1b" stroke-width="1.9" stroke-linecap="round"><path d="M8.7 10.2l5.6 5.6M14.3 10.2l-5.6 5.6M17.7 10.2l5.6 5.6M23.3 10.2l-5.6 5.6"/></g><path d="M10 23.5q6-5 12 0" fill="none" stroke="#1b1b1b" stroke-width="1.8" stroke-linecap="round"/>'
  };
  // The face is status only: a picture of how the game stands, not a control.
  function setFace(name) {
    if (els.face.dataset.face === name) return;
    els.face.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true">' + FACE_BASE + FACES[name] + '</svg>';
    els.face.dataset.face = name;
    els.face.setAttribute('aria-label', T('mines.face.' + name));
  }

  // The counters are plain figures in Zimi's mono.
  function setCount(el, value) { el.textContent = Play.num(value < 0 ? Math.max(value, -99) : Math.min(value, TIMER_MAX)); }

  // ── board ──
  function cellSize(cols) {
    var vw = document.documentElement.clientWidth;
    if (vw >= WIDE_VIEWPORT) return CELL_DESKTOP;
    return Math.max(CELL_TOUCH_MIN, Math.min(CELL_TOUCH_MAX, Math.floor((vw - FRAME_PAD) / cols)));
  }
  function layout() {
    els.win.style.setProperty('--cs', cellSize(game.cols) + 'px');
    els.board.style.gridTemplateColumns = 'repeat(' + game.cols + ', var(--cs))';
  }
  function buildBoard() {
    els.board.textContent = '';
    cells = [];
    var frag = document.createDocumentFragment();
    for (var i = 0; i < game.size; i++) {
      var d = document.createElement('div');
      d.className = 'ms-c';
      d.dataset.i = i;
      cells.push(d);
      frag.appendChild(d);
    }
    els.board.appendChild(frag);
    els.board.setAttribute('aria-label', T('mines.boardLabel', { rows: game.rows, cols: game.cols, mines: game.mines }));
  }
  function paint(i) {
    var g = game, s = g.state[i], d = cells[i], cls = 'ms-c', html = '', text = '';
    if (s === OPEN) {
      cls += ' open';
      if (g.mine[i]) { cls += g.exploded.indexOf(i) >= 0 ? ' boom' : ' mine'; html = SVG.mine; }
      else if (g.count[i]) { cls += ' n' + g.count[i]; text = g.count[i]; }
    } else if (s === FLAG) {
      var wrong = g.status === 'lost' && !g.mine[i];
      html = wrong ? SVG.wrong : SVG.flag;
      if (wrong) cls += ' wrong';
    } else if (s === QUESTION) { cls += ' q'; text = '?'; }
    if (i === cursor) cls += ' cursor';
    if (d.className !== cls) d.className = cls;
    var key = html || String(text);
    if (d.dataset.k !== key) { d.dataset.k = key; if (html) d.innerHTML = html; else d.textContent = text; }
  }
  function paintAll() { for (var i = 0; i < game.size; i++) paint(i); }

  function setPressed(idx, withNeighbours) {
    var on = {};
    if (idx >= 0) { on[idx] = true; if (withNeighbours) game.nb[idx].forEach(function (n) { on[n] = true; }); }
    for (var i = 0; i < game.size; i++) {
      var want = !!on[i] && (game.state[i] === HIDDEN || game.state[i] === QUESTION);
      if (cells[i].classList.contains('pressed') !== want) cells[i].classList.toggle('pressed', want);
    }
  }

  function updateCounter() { setCount(els.mines, game.mines - game.flags); }
  function elapsedMs() { return startedAt ? (finalMs || Date.now() - startedAt) : 0; }
  function tick() { setCount(els.time, Math.floor(elapsedMs() / 1000)); }
  function stopClock() { clearInterval(tickTimer); tickTimer = 0; }
  function finishClock() { finalMs = Date.now() - startedAt; stopClock(); tick(); }

  // What the status line rests on: the mode a player is in, else the one promise the first tap carries.
  function baseLine() { return flagMode ? T('mines.flagTitle') : game && !game.placed ? T('mines.firstSafe') : ''; }
  // Cells sweep in (or out) from one cell: the farther, the later, so an opening reads as spreading.
  function ripple(list, from, cls) {
    if (ZimiShell.reducedMotion()) return;
    list.forEach(function (i) {
      var d = Math.max(Math.abs(Math.floor(i / game.cols) - Math.floor(from / game.cols)), Math.abs(i % game.cols - from % game.cols)), c = cells[i];
      c.style.animationDelay = Math.min(RIPPLE_MAX_MS, d * RIPPLE_MS) + 'ms';
      c.classList.remove(cls); void c.offsetWidth; c.classList.add(cls);
    });
  }

  function fmtTime(ms) { return T('mines.seconds', { n: root.ZimiText ? root.ZimiText.number(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : (ms / 1000).toFixed(1) }); }
  function afterMove(res) {
    if (game.status === 'playing' && !startedAt) { startedAt = Date.now(); tickTimer = setInterval(tick, TICK_MS); }
    res.opened.forEach(paint);
    if (!res.hit.length) ripple(res.opened, res.opened[0], 'pop');
    if (game.status === 'playing') line.say(baseLine());
    if (game.status === 'lost') {
      finishClock(); paintAll(); setFace('dead'); line.say(T('mines.hit'));
      var boom = res.hit[0], mines = [];
      cells.forEach(function (c, i) { if (c.classList.contains('mine')) mines.push(i); });
      ripple(mines, boom, 'reveal'); ZimiShell.shake(els.win);
      ZimiShell.endSheet({ result: 'lose', after: ZimiShell.reducedMotion() ? END_AFTER_MS : BOOM_AFTER_MS, stats: [[T('play.time'), fmtTime(finalMs)]] });
    } else if (game.status === 'won') {
      finishClock(); paintAll(); setFace('win'); recordWin(res.opened[res.opened.length - 1]);
    } else setFace('smile');
    updateCounter();
  }
  function recordWin(last) {
    var lv = settings.level, flags = [];
    cells.forEach(function (c, i) { if (game.mine[i]) flags.push(i); });
    ripple(flags, last, 'planted');
    if (lv !== 'custom' && (!best[lv] || finalMs < best[lv])) { best[lv] = finalMs; save(BEST_KEY, best); }
    line.say(T('mines.cleared'));
    var stats = [[T('play.time'), fmtTime(finalMs)]];
    if (best[lv]) stats.push([T('play.best'), fmtTime(best[lv])]);
    ZimiShell.endSheet({ result: 'win', after: ZimiShell.reducedMotion() ? END_AFTER_MS : BOOM_AFTER_MS, stats: stats });
  }

  function doReveal(i) { if (i >= 0) afterMove(reveal(game, i)); }
  // A chord that cannot work says why: the flags around the number have to match it.
  function doChord(i) {
    if (i < 0) return;
    if (playable(game) && game.state[i] === OPEN && game.count[i] > 0) {
      var have = flagsAround(game, i), need = game.count[i];
      if (have !== need) {
        ZimiShell.shake(cells[i]);
        line.reason(have > need ? T('mines.tooMany') : T('mines.needs', { n: Play.num(need) }));
        return;
      }
    }
    afterMove(chord(game, i));
  }
  function doMark(i) {
    if (i < 0 || cycleMark(game, i, settings.marks) < 0) return;
    paint(i); updateCounter();
    if (game.state[i] === FLAG && !ZimiShell.reducedMotion() && cells[i].animate) cells[i].animate([{ scale: 1.45, opacity: 0.4 }, { scale: 1, opacity: 1 }], { duration: FLAG_POP_MS, easing: 'ease-out' });
  }
  function tap(i) { // touch: a tap on a number chords, on a closed cell it opens (or flags in flag mode)
    if (flagMode) doMark(i);
    else if (game.state[i] === OPEN) doChord(i);
    else doReveal(i);
  }

  function newGame() {
    var lv = settings.level === 'custom' ? settings.custom : LEVELS[settings.level];
    var resize = !game || game.rows !== lv.rows || game.cols !== lv.cols;
    stopClock(); startedAt = 0; finalMs = 0; cursor = -1; press = null;
    game = createGame(lv.rows, lv.cols, lv.mines, fixedSeed);
    if (resize) buildBoard();
    layout(); paintAll(); setPressed(-1);
    setFace('smile'); updateCounter(); tick();
    line.say(baseLine());
    els.board.scrollLeft = 0;
  }

  // ── pointer ──
  function idxOf(target) {
    var c = target && target.closest ? target.closest('.ms-c') : null;
    return c ? Number(c.dataset.i) : -1;
  }
  function endPress() {
    if (press && press.timer) { clearTimeout(press.timer); clearTimeout(press.hint); if (cells[press.idx]) cells[press.idx].classList.remove('holding'); }
    press = null;
    setPressed(-1);
    if (playable(game)) setFace('smile');
  }
  function haptic() { try { if (navigator.vibrate) navigator.vibrate(HAPTIC_MS); } catch (e) { /* no haptics here */ } }
  function paintCursorOff() { cells.forEach(function (c) { c.classList.remove('cursor'); }); }

  els.board.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  els.board.addEventListener('pointerdown', function (e) {
    var i = idxOf(e.target);
    if (i < 0 || !playable(game)) return;
    cursor = -1; paintCursorOff();
    if (e.pointerType === 'mouse') {
      if (e.button === 2) { // right button: flag, or with the left already down, chord
        if (press) { press.chord = true; setPressed(press.idx, true); } else doMark(i);
        return;
      }
      if (e.button !== 0 && e.button !== 1) return;
      if (e.button === 1) e.preventDefault();
      press = { idx: i, mouse: true, chord: e.button === 1 || (e.buttons & 2) !== 0 };
    } else {
      press = { idx: i, mouse: false, x: e.clientX, y: e.clientY, long: false };
      press.hint = setTimeout(function () { if (press && cells[press.idx]) cells[press.idx].classList.add('holding'); }, HOLD_HINT_MS);
      press.timer = setTimeout(function () {
        if (!press) return;
        cells[press.idx].classList.remove('holding');
        press.long = true; haptic(); doMark(press.idx); setPressed(-1); setFace('smile');
      }, LONG_PRESS_MS);
    }
    setPressed(i, press.chord);
    setFace('worried');
  });
  els.board.addEventListener('pointermove', function (e) {
    if (!press) return;
    if (press.mouse) {
      var i = idxOf(document.elementFromPoint(e.clientX, e.clientY));
      if (i !== press.idx) { press.idx = i; setPressed(i, press.chord); }
    } else if (Math.abs(e.clientX - press.x) > MOVE_CANCEL_PX || Math.abs(e.clientY - press.y) > MOVE_CANCEL_PX) endPress();
  });
  window.addEventListener('pointerup', function (e) {
    if (!press) return;
    var p = press;
    if (p.mouse && e.button === 2) return; // the right button letting go ends nothing
    endPress();
    if (p.mouse) { if (p.chord) doChord(p.idx); else doReveal(p.idx); }
    else if (!p.long) tap(p.idx);
  });
  window.addEventListener('pointercancel', function () { if (press) endPress(); }); // a scroll began

  // ── keyboard ──
  var ARROWS = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
  document.addEventListener('keydown', function (e) {
    if (e.target.closest && e.target.closest('input,select,textarea,button,.ar-sheet')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key, g = game, move = ARROWS[k];
    if (move) {
      e.preventDefault();
      if (cursor < 0) cursor = 0;
      else {
        var r = Math.min(g.rows - 1, Math.max(0, Math.floor(cursor / g.cols) + move[0]));
        var c = Math.min(g.cols - 1, Math.max(0, (cursor % g.cols) + move[1]));
        cursor = r * g.cols + c;
      }
      paintCursorOff(); cells[cursor].classList.add('cursor');
      cells[cursor].scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    if (cursor < 0) return;
    if (k === ' ' || k === 'Enter') { e.preventDefault(); if (g.state[cursor] === OPEN) doChord(cursor); else doReveal(cursor); }
    else if (k === 'f' || k === 'F') { e.preventDefault(); doMark(cursor); }
    else if (k === 'c' || k === 'C') { e.preventDefault(); doChord(cursor); }
  });

  // ── action row and the New game pane ──
  els.fresh.addEventListener('click', function () { applyCustom(); newGame(); });
  els.flagBtn.addEventListener('click', function () {
    flagMode = !flagMode;
    els.flagBtn.setAttribute('aria-pressed', String(flagMode));
    if (game.status === 'ready' || game.status === 'playing') line.say(baseLine());
  });
  els.flagBtn.insertAdjacentHTML('afterbegin', SVG.flag);

  // The level (and a custom board's size) and the question marks are choices about the game, so they sit in the New game
  // pane; Start clicks the hidden New game button, which reads them. A custom size outside the limits is brought inside.
  var draftCustom = null;
  function clampInt(v, lo, hi) { v = Math.round(Number(v)); return Math.min(hi, Math.max(lo, isNaN(v) ? lo : v)); }
  function applyCustom() {
    if (!draftCustom) return;
    var r = clampInt(draftCustom.rows, MIN_SIDE, MAX_ROWS), c = clampInt(draftCustom.cols, MIN_SIDE, MAX_COLS), m = clampInt(draftCustom.mines, 1, r * c - 9);
    settings.custom = { rows: r, cols: c, mines: m }; draftCustom = null; save(SETTINGS_KEY, settings);
  }
  function customRow() {
    var box = document.createElement('div'), d = draftCustom = Object.assign({}, settings.custom);
    box.className = 'ms-custom';
    [['rows', 'mines.rows', MIN_SIDE, MAX_ROWS], ['cols', 'mines.cols', MIN_SIDE, MAX_COLS], ['mines', 'mines.mines', 1, 999]].forEach(function (f) {
      var lab = document.createElement('label'), inp = document.createElement('input');
      lab.textContent = T(f[1]); inp.className = 'ms-num'; inp.type = 'number'; inp.inputMode = 'numeric'; inp.min = f[2]; inp.max = f[3]; inp.value = d[f[0]];
      inp.addEventListener('input', function () { d[f[0]] = inp.value; });
      lab.appendChild(inp); box.appendChild(lab);
    });
    return box;
  }
  function menuOptions() {
    var host = document.createElement('div');
    function fill() {
      host.textContent = '';
      host.appendChild(Play.optionRow(T('mines.level'), LEVEL_IDS.map(function (lv) { return [lv, levelName(lv)]; }), settings.level, function (v) { settings.level = v; save(SETTINGS_KEY, settings); fill(); }, 'pl-grid'));
      if (settings.level === 'custom') host.appendChild(customRow());
      host.appendChild(Play.optionRow(T('mines.marks'), [[false, T('shell.off')], [true, T('shell.on')]], settings.marks, function (v) { settings.marks = v; save(SETTINGS_KEY, settings); }));
    }
    fill();
    return [host];
  }
  ZimiShell.game({
    inProgress: function () { return !!game && game.status === 'playing'; },
    menu: function () { return { options: menuOptions() }; },
    stats: function () { return ['beginner', 'intermediate', 'expert'].filter(function (lv) { return best[lv]; }).map(function (lv) { return [T('mines.bestRow', { level: levelName(lv) }), fmtTime(best[lv])]; }); }
  });

  window.addEventListener('resize', function () { if (game) layout(); });
  newGame();

  // Leaving and coming back keeps the board: the mines, what is open or flagged, and the clock. A finished board
  // comes back to its end sheet. Nothing is kept before the first move (the mines are not laid yet).
  function kept() {
    if (!game || !game.placed) return null;
    return { level: settings.level, rows: game.rows, cols: game.cols, mines: game.mines, mine: Array.from(game.mine), count: Array.from(game.count), state: Array.from(game.state),
      status: game.status, opened: game.opened, flags: game.flags, exploded: game.exploded, ms: elapsedMs() };
  }
  function takeUp(d) {
    if (!d || !(d.rows >= MIN_SIDE) || !(d.cols >= MIN_SIDE) || d.mine.length !== d.rows * d.cols || d.state.length !== d.mine.length || d.count.length !== d.mine.length) return false;
    if (LEVEL_IDS.indexOf(d.level) >= 0) settings.level = d.level;
    stopClock();
    game = createGame(d.rows, d.cols, d.mines, fixedSeed);
    game.mine.set(d.mine); game.count.set(d.count); game.state.set(d.state);
    game.status = d.status; game.opened = d.opened; game.flags = d.flags; game.exploded = d.exploded || []; game.placed = true;
    cells = []; buildBoard(); layout(); paintAll(); setPressed(-1); cursor = -1; press = null;
    updateCounter(); line.say(baseLine());
    finalMs = 0; startedAt = 0;
    if (game.status === 'playing') { startedAt = Date.now() - (d.ms || 0); tickTimer = setInterval(tick, TICK_MS); setFace('smile'); }
    else {
      startedAt = Date.now() - (d.ms || 0); finalMs = d.ms || 0; setFace(game.status === 'won' ? 'win' : 'dead');
      ZimiShell.endSheet({ result: game.status === 'won' ? 'win' : 'lose', after: 0, stats: [[T('play.time'), fmtTime(finalMs)]] });
    }
    tick();
    return true;
  }
  ZimiShell.persist({ save: kept, load: takeUp });

  // Test hooks, only with ?debug: win or lose on demand, peek at the game.
  root.__ms = { game: function () { return game; }, engine: Engine, cells: function () { return cells; } };
  if (params.has('debug')) {
    root.__msWin = function () {
      if (!game.placed) afterMove(reveal(game, 0));
      for (var i = 0; i < game.size && game.status === 'playing'; i++) if (!game.mine[i]) afterMove(reveal(game, i));
    };
    root.__msLose = function () {
      if (!game.placed) afterMove(reveal(game, 0));
      for (var i = 0; i < game.size; i++) if (game.mine[i] && game.state[i] !== FLAG) { afterMove(reveal(game, i)); break; }
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
