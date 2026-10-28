/* ZimiGames: Sudoku. Our own code, GPL-3.0. No network, no fonts, no modules.
   The rules (pure functions, no DOM, so node can test them): a solver, a technique grader, a
   generator whose puzzles have exactly one solution. Then the page (only when there is a document).

   Difficulty is the hardest technique a puzzle needs, found by a solver that always takes the
   easiest step available:
     easy   naked singles only
     medium needs hidden singles
     hard   needs locked candidates (pointing, claiming) or naked pairs
     expert needs an X-Wing, or more than these techniques give */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var N = 9, CELLS = 81, FULL = 0x3FE; // candidate sets are bit masks, bit d for digit d
  var TECHNIQUES = ['naked', 'hidden', 'locked', 'pair', 'xwing']; // rank 1 to 5; 6 is "needs a guess"
  var GUESS_RANK = 6;
  var DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'];
  var GIVENS_FLOOR = { easy: 36, medium: 30, hard: 26, expert: 0 }; // clues kept at least, so a level never feels bare
  var MAX_TRIES = 80;

  var mulberry32 = root.ZimiUtil.mulberry32;

  var UNITS = [], PEERS = [], UNITS_OF = [];
  (function build() {
    var r, c, i, u;
    for (r = 0; r < N; r++) { u = []; for (c = 0; c < N; c++) u.push(r * N + c); UNITS.push(u); }
    for (c = 0; c < N; c++) { u = []; for (r = 0; r < N; r++) u.push(r * N + c); UNITS.push(u); }
    for (var b = 0; b < N; b++) {
      u = [];
      for (i = 0; i < N; i++) u.push((Math.floor(b / 3) * 3 + Math.floor(i / 3)) * N + (b % 3) * 3 + (i % 3));
      UNITS.push(u);
    }
    for (i = 0; i < CELLS; i++) {
      UNITS_OF.push([Math.floor(i / N), N + (i % N), 2 * N + Math.floor(Math.floor(i / N) / 3) * 3 + Math.floor((i % N) / 3)]);
      var seen = {}, list = [];
      UNITS_OF[i].forEach(function (k) { UNITS[k].forEach(function (p) { if (p !== i && !seen[p]) { seen[p] = true; list.push(p); } }); });
      PEERS.push(list);
    }
  })();

  function bit(d) { return 1 << d; }
  function popcount(m) { var n = 0; while (m) { m &= m - 1; n++; } return n; }
  function digitsOf(m) { var out = []; for (var d = 1; d <= N; d++) if (m & bit(d)) out.push(d); return out; }
  function shuffle(a, rng) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // Cells whose digit repeats in a row, column or box.
  function conflicts(grid) {
    var bad = new Array(CELLS).fill(false);
    for (var i = 0; i < CELLS; i++) {
      if (!grid[i]) continue;
      for (var k = 0; k < PEERS[i].length; k++) if (grid[PEERS[i][k]] === grid[i]) { bad[i] = true; break; }
    }
    return bad;
  }

  // Backtracking search with the fewest-candidates cell first. Counts solutions up to `limit`
  // and keeps the first; with an rng the digits are tried in random order (for making grids).
  function search(grid, limit, rng) {
    var v = grid.slice(), rows = [], cols = [], boxes = [], count = 0, first = null, i;
    for (i = 0; i < N; i++) { rows.push(0); cols.push(0); boxes.push(0); }
    for (i = 0; i < CELLS; i++) {
      if (!v[i]) continue;
      var u = UNITS_OF[i], m = bit(v[i]);
      if ((rows[u[0]] | cols[u[1] - N] | boxes[u[2] - 2 * N]) & m) return { count: 0, first: null };
      rows[u[0]] |= m; cols[u[1] - N] |= m; boxes[u[2] - 2 * N] |= m;
    }
    function rec() {
      var best = -1, bestMask = 0, bestN = 10, k;
      for (k = 0; k < CELLS; k++) {
        if (v[k]) continue;
        var uu = UNITS_OF[k], mask = FULL & ~(rows[uu[0]] | cols[uu[1] - N] | boxes[uu[2] - 2 * N]), n = popcount(mask);
        if (n === 0) return;
        if (n < bestN) { best = k; bestMask = mask; bestN = n; if (n === 1) break; }
      }
      if (best < 0) { count++; if (!first) first = v.slice(); return; }
      var ds = digitsOf(bestMask), us = UNITS_OF[best];
      if (rng) shuffle(ds, rng);
      for (var j = 0; j < ds.length && count < limit; j++) {
        var b = bit(ds[j]);
        v[best] = ds[j]; rows[us[0]] |= b; cols[us[1] - N] |= b; boxes[us[2] - 2 * N] |= b;
        rec();
        v[best] = 0; rows[us[0]] &= ~b; cols[us[1] - N] &= ~b; boxes[us[2] - 2 * N] &= ~b;
      }
    }
    rec();
    return { count: count, first: first };
  }
  function solve(grid) { return search(grid, 1).first; }
  function countSolutions(grid, limit) { return search(grid, limit || 2).count; }

  // Solve the way a person does, easiest step first, and report what was needed.
  // Returns { solved, rank, counts, steps }; rank is 1..5 for the hardest technique used,
  // or 6 when it got stuck (a guess would be needed) or the grid is contradictory.
  function grade(grid) {
    var v = grid.slice(), cand = new Array(CELLS).fill(0), filled = 0, i;
    var counts = { naked: 0, hidden: 0, locked: 0, pair: 0, xwing: 0 }, rank = 0, steps = 0;
    for (i = 0; i < CELLS; i++) {
      if (v[i]) { filled++; continue; }
      var m = FULL;
      PEERS[i].forEach(function (p) { if (v[p]) m &= ~bit(v[p]); });
      cand[i] = m;
    }
    if (conflicts(v).some(Boolean)) return { solved: false, rank: GUESS_RANK, counts: counts, steps: 0 };

    function place(i, d) {
      v[i] = d; cand[i] = 0; filled++;
      PEERS[i].forEach(function (p) { cand[p] &= ~bit(d); });
    }
    function eliminate(cells, d, except) { // drop d from these cells' candidates; true if any changed
      var changed = false;
      cells.forEach(function (p) {
        if (except.indexOf(p) < 0 && !v[p] && (cand[p] & bit(d))) { cand[p] &= ~bit(d); changed = true; }
      });
      return changed;
    }
    function placed(unit, d) { return unit.some(function (p) { return v[p] === d; }); }
    function where(unit, d) { return unit.filter(function (p) { return !v[p] && (cand[p] & bit(d)); }); }

    function nakedSingle() {
      for (var k = 0; k < CELLS; k++) if (!v[k] && popcount(cand[k]) === 1) { place(k, digitsOf(cand[k])[0]); return true; }
      return false;
    }
    function hiddenSingle() {
      for (var u = 0; u < UNITS.length; u++) {
        for (var d = 1; d <= N; d++) {
          if (placed(UNITS[u], d)) continue;
          var w = where(UNITS[u], d);
          if (w.length === 1) { place(w[0], d); return true; }
        }
      }
      return false;
    }
    function lockedCandidates() {
      for (var u = 0; u < UNITS.length; u++) {
        for (var d = 1; d <= N; d++) {
          if (placed(UNITS[u], d)) continue;
          var w = where(UNITS[u], d);
          if (w.length < 2 || w.length > 3) continue;
          var sameRow = w.every(function (p) { return Math.floor(p / N) === Math.floor(w[0] / N); });
          var sameCol = w.every(function (p) { return p % N === w[0] % N; });
          var sameBox = w.every(function (p) { return UNITS_OF[p][2] === UNITS_OF[w[0]][2]; });
          if (u >= 2 * N) { // a box: a digit confined to one row or column leaves the rest of that line
            if (sameRow && eliminate(UNITS[UNITS_OF[w[0]][0]], d, w)) return true;
            if (sameCol && eliminate(UNITS[UNITS_OF[w[0]][1]], d, w)) return true;
          } else if (sameBox && eliminate(UNITS[UNITS_OF[w[0]][2]], d, w)) return true;
        }
      }
      return false;
    }
    function nakedPair() {
      for (var u = 0; u < UNITS.length; u++) {
        var twos = UNITS[u].filter(function (p) { return !v[p] && popcount(cand[p]) === 2; });
        for (var a = 0; a < twos.length; a++) {
          for (var b = a + 1; b < twos.length; b++) {
            if (cand[twos[a]] !== cand[twos[b]]) continue;
            var changed = false;
            digitsOf(cand[twos[a]]).forEach(function (d) { if (eliminate(UNITS[u], d, [twos[a], twos[b]])) changed = true; });
            if (changed) return true;
          }
        }
      }
      return false;
    }
    function xWing() {
      for (var d = 1; d <= N; d++) {
        for (var line = 0; line < 2; line++) { // rows (0) then columns (1)
          var offset = line * N, found = [];
          for (var a = 0; a < N; a++) {
            var w = where(UNITS[offset + a], d);
            if (w.length === 2) found.push({ idx: a, cross: w.map(function (p) { return line ? Math.floor(p / N) : p % N; }) });
          }
          for (var x = 0; x < found.length; x++) {
            for (var y = x + 1; y < found.length; y++) {
              if (found[x].cross[0] !== found[y].cross[0] || found[x].cross[1] !== found[y].cross[1]) continue;
              var changed = false, keep = [];
              found[x].cross.forEach(function (cr) {
                var unit = UNITS[(line ? 0 : N) + cr];
                unit.forEach(function (p) { if (UNITS_OF[p][line] === offset + found[x].idx || UNITS_OF[p][line] === offset + found[y].idx) keep.push(p); });
                if (eliminate(unit, d, keep)) changed = true;
              });
              if (changed) return true;
            }
          }
        }
      }
      return false;
    }

    var moves = [nakedSingle, hiddenSingle, lockedCandidates, nakedPair, xWing];
    while (filled < CELLS) {
      for (i = 0; i < CELLS; i++) if (!v[i] && !cand[i]) return { solved: false, rank: GUESS_RANK, counts: counts, steps: steps };
      var did = 0;
      for (var t = 0; t < moves.length && !did; t++) if (moves[t]()) did = t + 1;
      if (!did) return { solved: false, rank: GUESS_RANK, counts: counts, steps: steps };
      counts[TECHNIQUES[did - 1]]++; steps++; rank = Math.max(rank, did);
    }
    return { solved: true, rank: rank, counts: counts, steps: steps };
  }

  function difficultyOf(info) {
    if (info.rank <= 1) return 'easy';
    if (info.rank === 2) return 'medium';
    if (info.rank <= 4) return 'hard';
    return 'expert';
  }

  function randomSolution(rng) { return search(new Array(CELLS).fill(0), 1, rng).first; }

  // Take clues away in random order for as long as the puzzle stays within its difficulty
  // (and, for expert, has exactly one solution). Every puzzle returned is unique.
  function carve(solution, difficulty, rng) {
    var cap = { easy: 1, medium: 2, hard: 4, expert: GUESS_RANK }[difficulty];
    var puzzle = solution.slice(), givens = CELLS;
    var order = shuffle(Array.apply(null, { length: CELLS }).map(function (_, i) { return i; }), rng);
    for (var k = 0; k < order.length; k++) {
      if (givens <= GIVENS_FLOOR[difficulty]) break;
      var i = order[k], keep = puzzle[i];
      puzzle[i] = 0;
      var ok;
      if (cap < GUESS_RANK) { var gr = grade(puzzle); ok = gr.solved && gr.rank <= cap; } // logic alone solving it proves it unique
      else ok = countSolutions(puzzle, 2) === 1;
      if (ok) givens--; else puzzle[i] = keep;
    }
    return puzzle;
  }

  // A puzzle of the asked difficulty: { puzzle, solution, difficulty, info }. Tries again until
  // the grader agrees with the label; after MAX_TRIES it settles for the hardest it found.
  function generate(difficulty, seed) {
    var rng = mulberry32(seed === undefined ? Math.floor(Math.random() * 4294967296) : seed), bestTry = null;
    for (var t = 0; t < MAX_TRIES; t++) {
      var solution = randomSolution(rng), puzzle = carve(solution, difficulty, rng), info = grade(puzzle);
      var got = difficultyOf(info), cand = { puzzle: puzzle, solution: solution, difficulty: got, info: info, tries: t + 1 };
      if (got === difficulty) return cand;
      if (!bestTry || DIFFICULTIES.indexOf(got) > DIFFICULTIES.indexOf(bestTry.difficulty)) bestTry = cand;
    }
    return bestTry;
  }

  var Engine = {
    DIFFICULTIES: DIFFICULTIES, PEERS: PEERS, UNITS: UNITS, FULL: FULL,
    solve: solve, countSolutions: countSolutions, grade: grade, difficultyOf: difficultyOf,
    generate: generate, conflicts: conflicts, randomSolution: randomSolution, mulberry32: mulberry32
  };
  root.SudokuEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var BEST_KEY = 'zimi.games.sudoku.best', SETTINGS_KEY = 'zimi.games.sudoku.settings';
  var TICK_MS = 500, UNDO_MAX = 300, UNDO_KEPT = 100, MAX_BOARD = 504, SIDE_PAD = 24, CHROME_PX = 440, MAKE_DELAY_MS = 20, END_AFTER_MS = 600;
  var SET_MS = 120, WAVE_STEP_MS = 40, WAVE_END_AFTER_MS = 1100, UNIT_STEP_MS = 35, DONE_NOTE_MS = 2200, UNIT_WORD = ['row', 'column', 'box'];
  Play.applyTheme();

  var els = {
    board: $('su-board'), clock: $('su-clock'), msg: $('su-msg'), pencil: $('su-pencil'), undo: $('su-undo'),
    hint: $('su-hint'), pad: $('su-pad'), fresh: $('su-new')
  };
  var line = Play.status(els.msg);
  var settings = Play.load(SETTINGS_KEY, { diff: 'easy' }), best = Play.load(BEST_KEY, {});
  if (DIFFICULTIES.indexOf(settings.diff) < 0) settings.diff = 'easy';
  var s = null, cellEls = [], padEls = [], ticker = 0, lastTick = 0;
  function levelName(d) { return T('sudoku.level.' + d); }

  function emptyNotes() { return new Array(CELLS).fill(0); }

  function build() {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < CELLS; i++) {
      var d = document.createElement('div');
      d.className = 'su-c'; d.dataset.i = i; d.setAttribute('role', 'gridcell'); d.tabIndex = -1;
      var r = Math.floor(i / N), c = i % N;
      if (c % 3 === 2 && c < 8) d.classList.add('rb');
      if (r % 3 === 2 && r < 8) d.classList.add('bb');
      cellEls.push(d); frag.appendChild(d);
    }
    els.board.appendChild(frag);
    // The pad: 1 to 9 as a three by three; Erase sits with Hint and Pencil in the tools row, the same size.
    for (var k = 1; k <= N; k++) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ar-btn su-num'; b.dataset.d = k; b.innerHTML = '<span>' + Play.num(k) + '</span><small></small>';
      b.setAttribute('aria-label', T('sudoku.digit', { n: k }));
      els.pad.appendChild(b); padEls.push(b);
    }
    var e = document.createElement('button');
    e.type = 'button'; e.className = 'ar-btn su-erase'; e.id = 'su-erase'; e.textContent = T('sudoku.erase'); e.setAttribute('aria-label', T('sudoku.eraseCell'));
    e.addEventListener('click', erase); els.hint.parentNode.appendChild(e);
  }
  function layout() {
    var room = Play.room(CHROME_PX);
    var side = Math.max(270, Math.min(room.w + 24 - SIDE_PAD, MAX_BOARD, room.h));
    els.board.parentNode.style.setProperty('--side', Math.floor(side / N) * N + 'px');
  }

  function noteHtml(mask) {
    var h = '';
    for (var d = 1; d <= N; d++) h += '<i>' + (mask & bit(d) ? Play.num(d) : '') + '</i>';
    return h;
  }
  function cellLabel(i) {
    var val = s.grid[i], what = val ? T(s.puzzle[i] ? 'sudoku.clue' : 'sudoku.value', { n: val }) : s.notes[i] ? T('sudoku.notes', { list: digitsOf(s.notes[i]).join(' ') }) : T('sudoku.empty');
    return T('sudoku.cell', { row: Math.floor(i / N) + 1, col: i % N + 1, what: what });
  }
  function render() {
    var bad = conflicts(s.grid), sel = s.sel, selDigit = sel >= 0 ? s.grid[sel] : 0, selPeers = sel >= 0 ? PEERS[sel] : [];
    for (var i = 0; i < CELLS; i++) {
      var el = cellEls[i], val = s.grid[i], cls = 'su-c' + (el.classList.contains('rb') ? ' rb' : '') + (el.classList.contains('bb') ? ' bb' : '');
      if (s.puzzle[i]) cls += ' given';
      else if (val) cls += ' user';
      if (bad[i]) cls += ' bad';
      if (i === sel) cls += ' sel';
      else if (selDigit && val === selDigit) cls += ' same';
      else if (sel >= 0 && selPeers.indexOf(i) >= 0) cls += ' peer';
      el.className = cls;
      var key = val ? String(val) : 'n' + s.notes[i];
      if (el.dataset.k !== key) {
        el.dataset.k = key;
        if (val) el.textContent = Play.num(val); else el.innerHTML = s.notes[i] ? '<span class="su-notes">' + noteHtml(s.notes[i]) + '</span>' : '';
      }
      el.setAttribute('aria-label', cellLabel(i));
      el.tabIndex = i === (sel >= 0 ? sel : 0) ? 0 : -1;
    }
    var left = new Array(N + 1).fill(N);
    s.grid.forEach(function (d) { if (d) left[d]--; });
    padEls.forEach(function (b, k) {
      var l = left[k + 1];
      b.querySelector('small').textContent = l > 0 ? Play.num(l) : '';
      b.classList.toggle('done', l <= 0);
    });
    els.pencil.setAttribute('aria-pressed', String(s.pencil));
    els.undo.disabled = !s.hist.length;
  }

  function persist() {
    // the puzzle, notes, undo trail and clock are kept by the shell (ZimiShell.persist, below)
  }

  // ── the clock ──
  function elapsed() { return s.elapsed + (ticker ? performance.now() - lastTick : 0); }
  function paintClock() { els.clock.textContent = Play.fmtClock(elapsed()); }
  function startClock() { if (ticker || s.done) return; lastTick = performance.now(); ticker = setInterval(paintClock, TICK_MS); }
  function stopClock() { if (!ticker) return; s.elapsed += performance.now() - lastTick; clearInterval(ticker); ticker = 0; paintClock(); }

  // ── playing ──
  function snap() {
    s.hist.push({ grid: s.grid.slice(), notes: s.notes.slice() });
    if (s.hist.length > UNDO_MAX) s.hist.shift();
  }
  function selectCell(i) { s.sel = i; render(); }
  function moveSel(dr, dc) {
    var i = s.sel < 0 ? 0 : s.sel, r = Math.min(N - 1, Math.max(0, Math.floor(i / N) + dr)), c = Math.min(N - 1, Math.max(0, i % N + dc));
    selectCell(r * N + c); cellEls[r * N + c].focus();
  }
  function refuse(text) { ZimiShell.shake(els.board); line.reason(text); }
  function baseLine() { return s && s.pencil ? T('sudoku.pencilOn') : ''; }
  // Which row, column or box a repeated digit shares with the cell just filled (the first one found), or ''.
  function repeatedIn(i, d) {
    for (var u = 0; u < UNITS_OF[i].length; u++) {
      if (UNITS[UNITS_OF[i][u]].some(function (p) { return p !== i && s.grid[p] === d; })) return UNIT_WORD[u];
    }
    return '';
  }
  function unitDone(u, grid) {
    var seen = 0;
    return UNITS[u].every(function (p) { var v = grid[p]; if (!v || (seen & bit(v))) return false; seen |= bit(v); return true; });
  }
  function digitCount(grid, d) { return grid.filter(function (v) { return v === d; }).length; }
  // The small moments a placement can earn: a row, column or box that is now whole ripples, and a digit with all nine
  // down lights its key and says so. The conflict, if there is one, says where it is.
  function celebrate(i, d, before) {
    var said = false;
    UNITS_OF[i].forEach(function (u) {
      if (!unitDone(u, s.grid) || unitDone(u, before)) return;
      UNITS[u].forEach(function (p, k) { flash(cellEls[p], k * UNIT_STEP_MS); });
    });
    if (digitCount(s.grid, d) === N && digitCount(before, d) < N && !conflicts(s.grid)[i]) {
      var key = padEls[d - 1];
      if (!ZimiShell.reducedMotion()) { key.classList.remove('pop'); void key.offsetWidth; key.classList.add('pop'); }
      line.reason(T('sudoku.digitDone', { n: Play.num(d) }), DONE_NOTE_MS); said = true;
    }
    return said;
  }
  function flash(el, delay) {
    if (ZimiShell.reducedMotion()) return;
    el.style.animationDelay = delay + 'ms'; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    setTimeout(function () { el.classList.remove('flash'); el.style.animationDelay = ''; }, delay + 700);
  }
  function enter(d, forceNote) {
    if (s.done) return;
    if (s.sel < 0) { refuse(T('sudoku.pickCell')); return; }
    if (s.puzzle[s.sel]) { refuse(T('sudoku.clueFixed')); return; }
    var i = s.sel, note = s.pencil !== !!forceNote, before = s.grid.slice(), where = '';
    if (note) {
      if (s.grid[i]) { refuse(T('sudoku.noteOnNumber')); return; }
      snap(); s.notes[i] ^= bit(d);
    } else if (s.grid[i] === d) { erase(); return; }   // the same digit again takes it back
    else {
      snap(); s.grid[i] = d; s.notes[i] = 0;
      PEERS[i].forEach(function (p) { s.notes[p] &= ~bit(d); });
      where = repeatedIn(i, d);
    }
    afterChange();
    if (note) return;
    if (!ZimiShell.reducedMotion() && cellEls[i].animate) cellEls[i].animate([{ scale: 0.7 }, { scale: 1 }], { duration: SET_MS, easing: 'ease-out' });
    if (!celebrate(i, d, before) && where) line.reason(T('sudoku.repeat.' + where, { n: Play.num(d) }));
  }
  function erase() {
    if (s.done || s.sel < 0 || s.puzzle[s.sel] || (!s.grid[s.sel] && !s.notes[s.sel])) return;
    snap(); s.grid[s.sel] = 0; s.notes[s.sel] = 0; afterChange();
  }
  function undo() {
    var h = s.hist.pop();
    if (!h || s.done) return;
    s.grid = h.grid; s.notes = h.notes; afterChange(true);
  }
  // Hint: a cell that can only be one digit, or else the open cell with the fewest choices.
  function hint() {
    if (s.done) return;
    var bestI = -1, bestN = 99, bestMask = 0;
    for (var i = 0; i < CELLS; i++) {
      if (s.grid[i]) continue;
      var mask = FULL;
      PEERS[i].forEach(function (p) { if (s.grid[p]) mask &= ~bit(s.grid[p]); });
      var n = digitsOf(mask).length;
      if (n < bestN) { bestN = n; bestI = i; bestMask = mask; }
    }
    if (bestI < 0) return;
    s.sel = bestI; render(); cellEls[bestI].focus();
    var where = { row: Math.floor(bestI / N) + 1, col: bestI % N + 1 };
    line.say(bestN === 1 ? T('sudoku.hintOnly', { row: where.row, col: where.col, n: digitsOf(bestMask)[0] }) : T('sudoku.hintLook', where));
  }
  function afterChange(noCheck) {
    render(); persist();
    line.say(baseLine());
    if (!noCheck && s.grid.every(Boolean) && !conflicts(s.grid).some(Boolean)) win();
  }
  function win() {
    stopClock(); s.done = true;
    var ms = s.elapsed, record = !best[s.diff] || ms < best[s.diff];
    if (record) { best[s.diff] = ms; Play.save(BEST_KEY, best); }
    persist();
    var wave = !ZimiShell.reducedMotion();
    if (wave) cellEls.forEach(function (el, i) { flash(el, (Math.floor(i / N) + i % N) * WAVE_STEP_MS); });
    ZimiShell.endSheet({ result: 'win', after: wave ? WAVE_END_AFTER_MS : END_AFTER_MS, stats: [[T('play.time'), Play.fmtClock(ms)], [T('play.best'), Play.fmtClock(best[s.diff])]] });
  }

  // ── new games ──
  function newGame(diff) {
    stopClock();
    line.say(T('sudoku.making'));
    setTimeout(function () {
      var p = generate(diff);
      s = { puzzle: p.puzzle, solution: p.solution, grid: p.puzzle.slice(), notes: emptyNotes(), diff: p.difficulty, elapsed: 0, hist: [], sel: -1, pencil: false, done: false };
      line.say(levelName(s.diff));
      render(); persist(); paintClock(); startClock();
    }, MAKE_DELAY_MS);
  }
  // The level is the one real choice, so it sits in the New game pane; Start makes the puzzle.
  function menuOptions() {
    return [Play.optionRow(T('sudoku.level'), DIFFICULTIES.map(function (d) { return [d, levelName(d)]; }), settings.diff, function (v) { settings.diff = v; Play.save(SETTINGS_KEY, settings); })];
  }
  els.fresh.addEventListener('click', function () { newGame(settings.diff); });
  ZimiShell.game({
    hints: true,
    inProgress: function () { return !!s && !s.done && s.grid.some(function (v, i) { return v && !s.puzzle[i]; }); },
    menu: function () { return { options: menuOptions() }; },
    stats: function () { return DIFFICULTIES.filter(function (d) { return best[d]; }).map(function (d) { return [T('sudoku.bestRow', { level: levelName(d) }), Play.fmtClock(best[d])]; }); }
  });

  els.board.addEventListener('pointerdown', function (e) {
    var t = e.target.closest && e.target.closest('.su-c');
    if (t) { selectCell(Number(t.dataset.i)); t.focus(); }
  });
  els.pad.addEventListener('click', function (e) { var b = e.target.closest('.su-num:not(.su-erase)'); if (b) enter(Number(b.dataset.d)); });
  function togglePencil() { s.pencil = !s.pencil; render(); line.say(baseLine()); }
  els.pencil.addEventListener('click', togglePencil);
  els.undo.addEventListener('click', undo);
  els.hint.addEventListener('click', hint);
  Play.onHidden(function () { stopClock(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && s && !s.done && !document.querySelector('.ar-sheet:not([hidden])')) startClock(); });

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !s) return;
    if (document.querySelector('.ar-sheet:not([hidden])')) return;
    var k = e.key, handled = true;
    if (k === 'ArrowUp') moveSel(-1, 0); else if (k === 'ArrowDown') moveSel(1, 0);
    else if (k === 'ArrowLeft') moveSel(0, -1); else if (k === 'ArrowRight') moveSel(0, 1);
    else if (k >= '1' && k <= '9') enter(Number(k));
    else if (/^Digit[1-9]$/.test(e.code) && e.shiftKey) enter(Number(e.code.slice(5)), true); // Shift+digit: a note without switching
    else if (k === 'Backspace' || k === 'Delete' || k === '0') erase();
    else if (k === 'n' || k === 'N' || k === 'p' || k === 'P') togglePencil();
    else if (k === 'z' || k === 'Z' || k === 'u' || k === 'U') undo();
    else if (k === 'h' || k === 'H') hint();
    else handled = false;
    if (handled) e.preventDefault();
  });

  function restore() {
    var saved = ZimiShell.saved();
    if (!saved || !Array.isArray(saved.puzzle) || saved.puzzle.length !== CELLS || !Array.isArray(saved.grid) || saved.grid.length !== CELLS || !Array.isArray(saved.solution) || DIFFICULTIES.indexOf(saved.diff) < 0) return false;
    s = { puzzle: saved.puzzle, solution: saved.solution, grid: saved.grid, notes: Array.isArray(saved.notes) && saved.notes.length === CELLS ? saved.notes : emptyNotes(), diff: saved.diff, elapsed: saved.elapsed || 0, hist: Array.isArray(saved.hist) ? saved.hist.slice(-UNDO_KEPT) : [], sel: -1, pencil: false, done: !!saved.done };
    return true;
  }

  build();
  layout();
  window.addEventListener('resize', layout);
  if (restore()) {
    line.say(levelName(s.diff)); render(); paintClock();
    // A solved puzzle comes back to its end sheet, not to a fresh one.
    if (s.done) ZimiShell.endSheet({ result: 'win', after: 0, stats: [[T('play.time'), Play.fmtClock(s.elapsed)], [T('play.best'), Play.fmtClock(best[s.diff] || s.elapsed)]] });
    else startClock();
  } else newGame(settings.diff);
  ZimiShell.persist({ save: function () { return !s ? null : { puzzle: s.puzzle, solution: s.solution, grid: s.grid, notes: s.notes, diff: s.diff, elapsed: elapsed(), done: s.done, hist: s.hist.slice(-UNDO_KEPT) }; } });
  // A read-only window onto the live game, for the browser tests.
  root.__sudoku = { get s() { return s; } };
})(this);
