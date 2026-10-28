/* ZimiGames: Sokoban, the page. The rules are sokoban-engine.js; the levels are data/sokoban-levels.js (Boxoban,
   Apache-2.0, see data/README-sokoban.txt). The board is one svg redrawn from the state; the art is ours. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiSokoban || !root.ZimiSokobanLevels) return;
  var S = root.ZimiSokoban, BK = root.BoardKit, D = root.ZimiSokobanLevels, Play = root.ArcadePlay, T = Play.T;
  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'sokoban', TILE = 40, WATCH_MS = 110, END_AFTER_MS = 600;
  var KEYS = { ArrowUp: 'u', ArrowDown: 'd', ArrowLeft: 'l', ArrowRight: 'r', w: 'u', s: 'd', a: 'l', d: 'r', W: 'u', S: 'd', A: 'l', D: 'r' };

  var state = BK.load(KEY, {});
  if (!state.best || typeof state.best !== 'object') state.best = {};
  var save = function () { BK.save(KEY, state); };

  var grades = D.grades, levels = D.levels;
  var cur = 0, st, ext, history, moves, pushes, facing = 'd', won = false, watching = 0, grade = grades[0].id, pending = 0, trail = [];

  var board = $('sk-board');
  function levelNumber(i) { var n = 0; for (var k = 0; k <= i; k++) if (levels[k].g === levels[i].g) n++; return n; }
  function levelRows(lv) { return lv.r.split('/'); }
  function label(i) {
    var lv = levels[i], n = 0;
    for (var k = 0; k <= i; k++) if (levels[k].g === lv.g) n++;
    return T('sokoban.levelName', { grade: gradeName(lv.g), n: n });
  }
  function gradeName(id) { return T('sokoban.grade.' + id); }
  var line = Play.status($('sk-msg'));
  function say(t) { line.say(t); }

  // ── drawing: one svg, our own tiles ──
  function tileSvg(r, c, k) {
    var x = c * TILE, y = r * TILE, out = '';
    if (st.wall[k]) {
      return '<rect x="' + x + '" y="' + y + '" width="40" height="40" rx="5" fill="var(--sk-wall-lo)"/>' +
        '<rect x="' + (x + 1.5) + '" y="' + (y + 1.5) + '" width="37" height="34" rx="4" fill="var(--sk-wall)"/>' +
        '<path d="M' + (x + 4) + ' ' + (y + 6) + 'H' + (x + 30) + '" stroke="var(--sk-wall-hi)" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M' + x + ' ' + (y + 19) + 'H' + (x + 40) + 'M' + (x + 20) + ' ' + (y + 19) + 'V' + (y + 36) + '" stroke="var(--sk-wall-lo)" stroke-width="1.6" opacity="0.7"/>';
    }
    if (!ext.floor[k]) return '';
    out += '<rect x="' + x + '" y="' + y + '" width="40" height="40" fill="var(--sk-floor' + ((r + c) % 2 ? '2' : '') + ')"/>';
    if (st.goal[k]) out += '<circle cx="' + (x + 20) + '" cy="' + (y + 20) + '" r="8" fill="none" stroke="var(--sk-goal)" stroke-width="3"/><circle cx="' + (x + 20) + '" cy="' + (y + 20) + '" r="2.5" fill="var(--sk-goal)"/>';
    return out;
  }
  function crateSvg(r, c, on) {
    var x = c * TILE, y = r * TILE, f = on ? 'var(--sk-crate-on)' : 'var(--sk-crate)', e = on ? 'var(--sk-crate-on-lo)' : 'var(--sk-crate-lo)';
    return '<rect x="' + (x + 4) + '" y="' + (y + 4) + '" width="32" height="32" rx="4" fill="' + f + '" stroke="' + e + '" stroke-width="2"/>' +
      (on ? '<path d="M' + (x + 12) + ' ' + (y + 21) + 'L' + (x + 18) + ' ' + (y + 27) + 'L' + (x + 29) + ' ' + (y + 13) + '" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>'
        : '<path d="M' + (x + 9) + ' ' + (y + 9) + 'L' + (x + 31) + ' ' + (y + 31) + 'M' + (x + 31) + ' ' + (y + 9) + 'L' + (x + 9) + ' ' + (y + 31) + '" stroke="' + e + '" stroke-width="2.6" opacity="0.7"/><path d="M' + (x + 7) + ' ' + (y + 7) + 'H' + (x + 28) + '" stroke="var(--sk-crate-hi)" stroke-width="2.4" stroke-linecap="round"/>');
  }
  function playerSvg(r, c) {
    var x = c * TILE + 20, y = r * TILE + 21, dx = facing === 'l' ? -1.6 : facing === 'r' ? 1.6 : 0, dy = facing === 'u' ? -1.6 : facing === 'd' ? 1.4 : 0;
    return '<ellipse cx="' + x + '" cy="' + (y + 13) + '" rx="11" ry="3" fill="#000" opacity="0.18"/>' +
      '<circle cx="' + x + '" cy="' + y + '" r="14" fill="var(--sk-me)" stroke="var(--sk-me-edge)" stroke-width="2"/>' +
      '<path d="M' + (x - 9) + ' ' + (y - 6) + 'A11 11 0 0 1 ' + (x + 2) + ' ' + (y - 11) + '" fill="none" stroke="var(--sk-me-hi)" stroke-width="3" stroke-linecap="round"/>' +
      '<circle cx="' + (x - 5 + dx) + '" cy="' + (y - 2 + dy) + '" r="3.8" fill="#fff"/><circle cx="' + (x + 5 + dx) + '" cy="' + (y - 2 + dy) + '" r="3.8" fill="#fff"/>' +
      '<circle cx="' + (x - 5 + dx * 1.6) + '" cy="' + (y - 2 + dy * 1.6) + '" r="1.7" fill="var(--sk-eye)"/><circle cx="' + (x + 5 + dx * 1.6) + '" cy="' + (y - 2 + dy * 1.6) + '" r="1.7" fill="var(--sk-eye)"/>';
  }
  function draw() {
    var cols = ext.c1 - ext.c0 + 1, rows = ext.r1 - ext.r0 + 1, parts = [];
    for (var r = ext.r0; r <= ext.r1; r++) for (var c = ext.c0; c <= ext.c1; c++) {
      var k = r * st.w + c;
      if (ext.show[k] || st.wall[k]) parts.push(tileSvg(r - ext.r0, c - ext.c0, k));
    }
    for (r = ext.r0; r <= ext.r1; r++) for (c = ext.c0; c <= ext.c1; c++) {
      k = r * st.w + c;
      if (st.box[k]) parts.push(crateSvg(r - ext.r0, c - ext.c0, st.goal[k]));
    }
    parts.push(playerSvg((st.player / st.w | 0) - ext.r0, st.player % st.w - ext.c0));
    board.innerHTML = '<svg viewBox="0 0 ' + cols * TILE + ' ' + rows * TILE + '" aria-hidden="true" preserveAspectRatio="xMidYMid meet">' + parts.join('') + '</svg>';
    var onGoal = 0, total = 0;
    for (var i = 0; i < st.box.length; i++) if (st.box[i]) { total++; if (st.goal[i]) onGoal++; }
    board.setAttribute('aria-label', T('sokoban.boardLabel', { level: label(cur), done: onGoal, total: total, moves: moves }));
    $('sk-moves').textContent = Play.num(moves); $('sk-pushes').textContent = Play.num(pushes);
    var best = state.best[levels[cur].id];
    $('sk-best').textContent = best ? Play.num(best) : '-';
    $('sk-undo').disabled = !history.length || !!watching;
  }

  // ── play ──
  function load(i) {
    stopWatching();
    cur = Math.max(0, Math.min(levels.length - 1, i)); won = false;
    st = S.parse(levelRows(levels[cur]).map(function (r) { return r.replace(/-/g, ' '); }));
    ext = S.extent(st); history = []; trail = []; moves = 0; pushes = 0; facing = 'd';
    $('sk-name').textContent = Play.num(levelNumber(cur));
    $('sk-name-l').textContent = gradeName(levels[cur].g);
    grade = levels[cur].g; pending = cur;
    state.level = levels[cur].id; save();
    say(T('sokoban.goal')); draw();
  }
  function step(d) {
    if (won) return;
    var next = S.move(st, d);
    facing = d;
    if (!next) { draw(); if (!watching) { ZimiShell.shake(board); line.reason(T('sokoban.blocked')); } return; }
    history.push({ st: st, moves: moves, pushes: pushes, facing: facing });
    st = next; moves++; trail.push(d); if (next.pushed) pushes++;
    draw();
    if (S.solved(st)) win();
  }
  function undo() {
    if (!history.length || watching) return;
    var h = history.pop();
    st = h.st; moves = h.moves; pushes = h.pushes; won = false; trail.pop(); say('');
    draw();
  }
  function win() {
    won = true;
    var id = levels[cur].id, prev = state.best[id], record = !prev || moves < prev;
    if (record) state.best[id] = moves;
    save(); draw();
    if (watching) { stopWatching(); say(T('sokoban.solutionDone', { n: moves })); return; }
    say(T('shell.end.win'));
    pending = Math.min(levels.length - 1, cur + 1);   // New game on the end sheet is the next level
    ZimiShell.endSheet({ result: 'win', newLabel: cur < levels.length - 1 ? T('shell.nextLevel') : undefined, after: END_AFTER_MS, stats: [[T('sokoban.moves'), Play.num(moves)], [T('sokoban.pushes'), Play.num(pushes)]] });
  }

  function stopWatching() { if (watching) { clearInterval(watching); watching = 0; } }
  function watch() {
    load(cur);
    var seq = levels[cur].m, i = 0;
    say(T('sokoban.solution', { n: seq.length }));
    watching = setInterval(function () {
      if (i >= seq.length) { stopWatching(); return; }
      step(seq[i++].toLowerCase());
    }, WATCH_MS);
    draw();
  }

  // ── input: keys, and the pad (which also takes a swipe on the board) ──
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet') || document.querySelector('.ar-sheet:not([hidden])')) return;
    var d = KEYS[e.key];
    if (d) { if (watching) stopWatching(); e.preventDefault(); step(d); return; }
    var k = e.key.toLowerCase();
    if (k === 'z' || k === 'u' || e.key === 'Backspace') { e.preventDefault(); undo(); } else if (k === 'r') load(cur);
  });

  // ── the touch pad (the one shared pad: a d-pad, no action keys) ──
  var DIR_OF = { up: 'u', down: 'd', left: 'l', right: 'r' };
  Play.pad(board, { dirs: ['left', 'right', 'up', 'down'], actions: [], on: function (name, down) { if (down) { stopWatching(); step(DIR_OF[name]); } } });

  // ── New game: pick a level (a grade, then a number); Start loads it. Restart and Show solution are in the Menu. ──
  function levelGrid() {
    var grid = document.createElement('div'), box = document.createElement('div');
    box.className = 'sk-pick';
    function fill() {
      box.textContent = '';
      var n = 0;
      levels.forEach(function (lv, i) {
        if (lv.g !== grade) return;
        n++;
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'sk-lv' + (state.best[lv.id] ? ' done' : '') + (i === pending ? ' now' : '');
        b.textContent = Play.num(n);
        b.setAttribute('aria-label', state.best[lv.id] ? T('sokoban.levelBest', { n: n, moves: state.best[lv.id] }) : T('sokoban.level', { n: n }));
        b.setAttribute('aria-pressed', String(i === pending));
        b.addEventListener('click', function () { pending = i; fill(); });
        box.appendChild(b);
      });
    }
    grid.appendChild(Play.optionRow(T('sokoban.difficulty'), grades.map(function (g) { return [g.id, gradeName(g.id)]; }), grade, function (v) {
      grade = v; pending = levels.findIndex(function (lv) { return lv.g === v && !state.best[lv.id]; }); if (pending < 0) pending = levels.findIndex(function (lv) { return lv.g === v; }); fill();
    }));
    grid.appendChild(box); fill();
    return grid;
  }
  $('sk-undo').addEventListener('click', undo);
  $('sk-restart').addEventListener('click', function () { load(cur); });
  $('sk-solution').addEventListener('click', watch);
  $('sk-new').addEventListener('click', function () { load(pending); });
  ZimiShell.game({
    inProgress: function () { return !won && moves > 0; },
    menu: function () { grade = levels[pending].g; return { options: [levelGrid()] }; },
    stats: function () {
      return grades.map(function (g) {
        var all = levels.filter(function (lv) { return lv.g === g.id; });
        return [gradeName(g.id), T('sokoban.finished', { done: all.filter(function (lv) { return state.best[lv.id]; }).length, total: all.length })];
      });
    }
  });

  // Leaving keeps the level and the moves made (the position is replayed from them, undo trail and all).
  var TRAIL_KEPT = 5000;
  function kept() { return moves ? { level: levels[cur].id, trail: trail.slice(-TRAIL_KEPT).join(''), won: won } : null; }
  function takeUp(d) {
    var i = d ? levels.findIndex(function (lv) { return lv.id === d.level; }) : -1;
    if (i < 0 || typeof d.trail !== 'string' || d.trail.length > TRAIL_KEPT) return false;
    load(i);
    for (var k = 0; k < d.trail.length; k++) {
      var dir = d.trail.charAt(k), next = S.move(st, dir);
      if (!next) { load(i); return false; }
      history.push({ st: st, moves: moves, pushes: pushes, facing: dir });
      st = next; moves++; trail.push(dir); facing = dir; if (next.pushed) pushes++;
    }
    draw();
    if (S.solved(st)) {
      won = true; say(T('shell.end.win')); pending = Math.min(levels.length - 1, cur + 1);
      ZimiShell.endSheet({ result: 'win', newLabel: cur < levels.length - 1 ? T('shell.nextLevel') : undefined, after: 0, stats: [[T('sokoban.moves'), Play.num(moves)], [T('sokoban.pushes'), Play.num(pushes)]] });
    }
    return true;
  }
  var start = 0;
  levels.forEach(function (lv, i) { if (lv.id === state.level) start = i; });
  load(start);
  ZimiShell.persist({ save: kept, load: takeUp });

  root.__sk = { load: load, step: step, state: function () { return st; }, levels: levels, won: function () { return won; }, undo: undo };
})(typeof globalThis !== 'undefined' ? globalThis : this);
