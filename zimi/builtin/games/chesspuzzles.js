/* ZimiGames: Chess Puzzles, the page. About 15,000 puzzles from the Lichess puzzle database (CC0), picked by
   rating and theme, with a personal puzzle rating kept on this device. The rules are chess-engine.js; the
   puzzle rows and the UCI helpers are chess-content.js. No network: the puzzles are one data file. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiChessEngine || !root.ZimiChessPuzzles || !root.BoardUI) return;
  var E = root.ZimiChessEngine(), C = root.ZimiChessContent, BK = root.BoardKit, D = root.ZimiChessPuzzles, UI = root.BoardUI, T = UI.t;
  var $ = function (id) { return document.getElementById(id); };
  var WHITE = E.WHITE, BLACK = E.BLACK;
  var KEY = 'chesspuzzles', START_RATING = 1200, K_FACTOR = 28, MIN_RATING = 400, WINDOW = 140, RECENT_CAP = 60;
  var OPPONENT_DELAY_MS = 450, SOLUTION_STEP_MS = 650;

  var LEVELS = ['near', '600-1000', '1000-1400', '1400-1800', '1800-2200', '2200-3200'];
  function themeLabel(t) { return root.ZimiText && root.ZimiText.has('puzzles.theme.' + t) ? T('puzzles.theme.' + t) : t; }
  var THEME_ORDER = ['mateIn1', 'mateIn2', 'mateIn3', 'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'backRankMate', 'smotheredMate', 'hangingPiece', 'trappedPiece', 'sacrifice', 'deflection', 'attraction', 'clearance', 'interference', 'xRayAttack', 'capturingDefender', 'exposedKing', 'promotion', 'defensiveMove', 'quietMove', 'zugzwang', 'endgame'];

  var rows = D.rows.split('\n');
  var ratings = rows.map(function (r) { return +r.split('|')[2]; });   // rows are sorted by rating
  var themeOf = rows.map(function (r) { return r.split('|')[3]; });

  var state = BK.load(KEY, {});
  if (typeof state.rating !== 'number') state.rating = START_RATING;
  ['streak', 'best', 'solved', 'failed'].forEach(function (k) { if (typeof state[k] !== 'number') state[k] = 0; });
  if (!Array.isArray(state.recent)) state.recent = [];
  if (!state.filter || typeof state.filter !== 'object') state.filter = { level: 'near', theme: '' };
  var save = function () { BK.save(KEY, state); };

  var els = { board: $('cp-board'), status: $('cp-status'), hud: $('cp-hud'), info: $('cp-info'), hint: $('cp-hint'), solution: $('cp-solution'), next: $('cp-next'), nu: $('cp-new') };
  var line = UI.status(els.status);
  var pos, puzzle, step, userColor, sel = -1, targets = {}, lastMove = 0, flipped = false;
  var hintLevel = 0, hinted = false, failed = false, done = false, rated = false, busy = false, pending = null, timer = 0, cue = null, isDaily = false;

  function colorName(c) { return UI.side(c === WHITE ? 'white' : 'black'); }
  function later(fn, ms) { clearTimeout(timer); timer = setTimeout(fn, ms); }

  // ── choosing a puzzle ──
  function levelRange(level) {
    if (level === 'near') return [Math.max(MIN_RATING, state.rating - WINDOW), state.rating + WINDOW];
    var p = level.split('-'); return [+p[0], +p[1]];
  }
  function matching(level, theme) {
    var r = levelRange(level), out = [], code = theme ? String.fromCharCode(97 + D.themes.indexOf(theme)) : '';
    for (var i = 0; i < rows.length; i++) {
      if (ratings[i] < r[0]) continue;
      if (ratings[i] > r[1]) break;
      if (!code || themeOf[i].indexOf(code) >= 0) out.push(i);
    }
    if (!out.length && level === 'near') {   // nothing in the window: widen it until something is
      for (var w = WINDOW * 2; !out.length && w < 4000; w *= 2) {
        for (var j = 0; j < rows.length; j++) if (Math.abs(ratings[j] - state.rating) <= w && (!code || themeOf[j].indexOf(code) >= 0)) out.push(j);
      }
    }
    return out;
  }
  function pick() {
    var pool = matching(state.filter.level, state.filter.theme);
    var fresh = pool.filter(function (i) { return state.recent.indexOf(i) < 0; });
    var from = fresh.length ? fresh : pool;
    return from[Math.floor(Math.random() * from.length)];
  }
  function today() { return root.ZimiUtil.dayKey(new Date(), '-'); }
  function dailyIndex(date) {
    var h = 0x811c9dc5;
    for (var i = 0; i < date.length; i++) { h ^= date.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0) % rows.length;
  }

  // ── drawing ──
  var view = root.ZimiChessBoard.create(els.board, E, onSquare);
  function paint() { view.paint(pos, { flipped: flipped, last: lastMove, sel: sel, targets: targets, cue: cue }); }
  function say(text, busy) { line.turn(text, !!busy); }
  // The rating and the puzzle's own; the streaks show once there is one.
  function stat(label, value) { return '<div class="pl-stat"><small>' + label + '</small><b>' + value + '</b></div>'; }
  function paintHud() {
    els.hud.innerHTML = stat(T('puzzles.rating'), state.rating) + (state.streak ? stat(T('puzzles.streak'), state.streak) : '') + (state.best ? stat(T('puzzles.best'), state.best) : '') + stat(T('puzzles.puzzle'), puzzle ? puzzle.rating : '-');
  }
  function setButtons() {
    els.hint.disabled = done || busy;
    els.solution.disabled = done || busy || !failed;
    els.next.setAttribute('aria-pressed', String(done));
  }

  // ── the rating: Elo against the puzzle's rating; a hint or a miss is a loss, a clean solve a win ──
  function expected(you, them) { return 1 / (1 + Math.pow(10, (them - you) / 400)); }
  function settle(won) {
    if (rated || isDaily && state.daily && state.daily.date === today() && state.daily.rated) { rated = true; return 0; }
    rated = true;
    var before = state.rating, delta = Math.round(K_FACTOR * ((won ? 1 : 0) - expected(before, puzzle.rating)));
    state.rating = Math.max(MIN_RATING, before + delta);
    if (won) { state.streak++; state.solved++; state.best = Math.max(state.best, state.streak); } else { state.streak = 0; state.failed++; }
    if (isDaily) state.daily = { date: today(), result: won ? 'solved' : 'failed', rated: true };
    save();
    return state.rating - before;
  }
  function deltaHtml(d) { return d ? ' <span class="cp-delta ' + (d > 0 ? 'up' : 'down') + '">' + (d > 0 ? '+' : '') + d + '</span>' : ''; }

  // ── a puzzle ──
  function startPuzzle(idx) {
    clearTimeout(timer);
    puzzle = C.parsePuzzle(rows[idx], D.themes); puzzle.idx = idx;
    state.recent.push(idx); if (state.recent.length > RECENT_CAP) state.recent.shift(); save();
    pos = E.parseFen(puzzle.fen); sel = -1; targets = {}; lastMove = 0; cue = null; pending = null;
    step = 0; hintLevel = 0; hinted = false; failed = false; done = false; rated = false; busy = true;
    userColor = -pos.turn; flipped = userColor === BLACK;
    els.board.classList.remove('solved', 'failed');
    els.info.textContent = '';
    paint(); paintHud(); setButtons();
    say(isDaily ? UI.noted(T('puzzles.daily'), T('puzzles.watch')) : T('puzzles.watch'), true);
    later(function () { opponentMove(function () { busy = false; setButtons(); say(T('puzzles.findBest', { color: colorName(userColor) })); }); }, OPPONENT_DELAY_MS);
  }
  function opponentMove(after) {
    var m = C.fromUci(E, pos, puzzle.moves[step]);
    if (!m) { say(T('puzzles.noLoad')); busy = false; done = true; setButtons(); return; }
    E.make(pos, m); lastMove = m; step++; paint();
    if (after) after();
  }

  function solved() {
    done = true; busy = false; sel = -1; targets = {}; cue = null;
    var d = settle(!failed && !hinted);
    els.board.classList.add('solved'); paint(); setButtons();
    say(T(failed || hinted ? 'puzzles.solved' : 'puzzles.solvedClean'));
    els.info.innerHTML = T('puzzles.info', { n: puzzle.rating }) + deltaHtml(d) + ' &middot; ' + puzzle.themes.map(themeLabel).join(', ');
    paintHud();
    UI.end({ result: 'win', text: failed || hinted ? T('puzzles.solved') : undefined, newLabel: T('board.next'), onNew: nextPuzzle,
      stats: [[T('puzzles.rating'), state.rating + (d ? ' (' + (d > 0 ? '+' : '') + d + ')' : '')]] });
  }
  function miss() {
    sel = -1; targets = {}; cue = null;
    if (!failed) {
      failed = true;
      var d = settle(false);
      els.board.classList.add('failed');
      els.info.innerHTML = T('puzzles.info', { n: puzzle.rating }) + deltaHtml(d);
      paintHud();
    }
    paint(); setButtons();
    UI.refuse(line, els.board, T('puzzles.notIt'));
  }

  function tryMove(m) {
    var expectedMove = C.fromUci(E, pos, puzzle.moves[step]);
    var mated = false;
    if (m !== expectedMove) { E.make(pos, m); mated = E.status(pos, []).result === 'mate'; E.unmake(pos); }
    if (m !== expectedMove && !mated) { miss(); return; }
    E.make(pos, m); lastMove = m; step++; sel = -1; targets = {}; cue = null; hintLevel = 0;
    if (mated || step >= puzzle.moves.length) { paint(); solved(); return; }
    busy = true; paint(); setButtons(); say(T('puzzles.good'));
    later(function () {
      opponentMove(function () {
        if (step >= puzzle.moves.length) { solved(); return; }
        busy = false; setButtons(); say(T('board.yourTurn'));
      });
    }, OPPONENT_DELAY_MS);
  }

  function onSquare(s) {
    if (done || busy || pos.turn !== userColor) return;
    var v = pos.sq[s];
    if (sel >= 0 && targets.hasOwnProperty(s)) {
      var cands = E.legalMoves(pos).filter(function (m) { return E.from(m) === sel && E.to(m) === s; });
      if (cands.length > 1) { askPromotion(cands); return; }
      tryMove(cands[0]); return;
    }
    if (v * pos.turn > 0 && s !== sel) { sel = s; targets = view.movesFrom(pos, s); cue = null; } else { sel = -1; targets = {}; }
    paint();
  }

  // ── hint, solution ──
  function hint() {
    if (done || busy) return;
    var m = C.fromUci(E, pos, puzzle.moves[step]);
    if (!m) return;
    hinted = true; hintLevel++;
    cue = { from: E.from(m), to: hintLevel > 1 ? E.to(m) : -1 };
    sel = -1; targets = {};
    say(T(hintLevel > 1 ? 'puzzles.hint2' : 'puzzles.hint1'));
    paint();
  }
  function showSolution() {
    if (done || busy) return;
    busy = true; setButtons(); sel = -1; targets = {}; cue = null;
    var go = function () {
      if (step >= puzzle.moves.length) { done = true; busy = false; paint(); setButtons(); say(T('puzzles.wasSolution')); return; }
      var m = C.fromUci(E, pos, puzzle.moves[step]);
      if (!m) { done = true; busy = false; setButtons(); return; }
      E.make(pos, m); lastMove = m; step++; paint();
      later(go, SOLUTION_STEP_MS);
    };
    say(T('puzzles.solution')); go();
  }

  // ── promotion: a sheet of the four pieces the pawn can become ──
  var promoSheet = null;
  function askPromotion(cands) {
    pending = cands;
    var box = UI.h('div', { class: 'cs-promo-choices' });
    root.ZimiChessBoard.promoButtons(E, box, function (t) {
      var m = pending && pending.filter(function (x) { return E.promo(x) === t; })[0];
      promoSheet.close();
      if (m) tryMove(m);
    });
    root.ZimiChessBoard.promoColour(box, pos.turn === WHITE);
    promoSheet = root.ZimiShell.sheet({ title: T('chess.promote'), body: [box], onClose: function () { pending = null; } });
  }

  // ── Menu > New game: the level, the theme, or today's puzzle. Nothing applies until New game is pressed. ──
  var draft = null;
  function levelLabel(l) { return l === 'near' ? T('puzzles.level.near', { n: state.rating }) : T('puzzles.level.' + l); }
  function menuOptions() {
    draft = { level: state.filter.level, theme: state.filter.theme, daily: false };
    var count = UI.h('p', { class: 'bu-quiet' });
    function tally() { var n = matching(draft.level, draft.theme).length; count.textContent = draft.daily ? '' : T('puzzles.count', { n: n }); }
    var daily = UI.toggle(T('puzzles.dailyRow'), false, function (v) { draft.daily = v; level.disable(v); theme.node.disabled = v; tally(); });
    var level = UI.row(T('puzzles.level'), LEVELS.map(function (l) { return [l, levelLabel(l)]; }), draft.level, function (v) { draft.level = v; tally(); });
    var theme = UI.select(T('puzzles.theme'), [['', T('puzzles.anyTheme')]].concat(THEME_ORDER.filter(function (t) { return D.themes.indexOf(t) >= 0; }).map(function (t) { return [t, themeLabel(t)]; })), draft.theme, function (v) { draft.theme = v; tally(); });
    tally();
    return UI.options([daily, level, theme, count]);
  }
  els.nu.addEventListener('click', function () {
    var d = draft; draft = null;
    if (d && d.daily) { isDaily = true; startPuzzle(dailyIndex(today())); return; }
    if (d) {
      if (!matching(d.level, d.theme).length) { say(T('puzzles.noMatch')); return; }
      state.filter = { level: d.level, theme: d.theme }; save();
    }
    isDaily = false; startPuzzle(pick());
  });
  function nextPuzzle() {
    if (!done && !failed && hinted) { state.streak = 0; save(); }   // skipping after a hint breaks the streak; skipping unseen does not
    isDaily = false; startPuzzle(pick());
  }
  els.next.addEventListener('click', nextPuzzle);
  els.hint.addEventListener('click', hint);
  els.solution.addEventListener('click', showSolution);
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input,select')) return;
    var k = e.key.toLowerCase();
    if (k === 'h') hint(); else if (k === 'n') nextPuzzle(); else if (e.key === 'Escape' && sel >= 0) { sel = -1; targets = {}; paint(); }
  });

  pos = E.startPosition();
  if (root.ZimiShell) root.ZimiShell.game({
    menu: menuOptions, hints: true,
    stats: function () { return state.solved + state.failed ? [T('puzzles.record', { won: state.solved, lost: state.failed })] : []; },
    inProgress: function () { return !done && step > 1; }
  });
  startPuzzle(pick());
  // Leaving and coming back: the same puzzle, played as far as it was (the position is played again from the puzzle's start).
  UI.persist({
    save: function () { return puzzle ? { idx: puzzle.idx, step: step, hinted: hinted, failed: failed, done: done, rated: rated, isDaily: isDaily, hintLevel: hintLevel, day: isDaily ? today() : '' } : null; },
    load: function (d) {
      if (d.isDaily && d.day !== today()) return false;
      clearTimeout(timer);
      puzzle = C.parsePuzzle(rows[d.idx], D.themes); puzzle.idx = d.idx; isDaily = d.isDaily;
      pos = E.parseFen(puzzle.fen); userColor = -pos.turn; lastMove = 0; cue = null; pending = null; sel = -1; targets = {};
      for (step = 0; step < d.step; step++) { var m = C.fromUci(E, pos, puzzle.moves[step]); if (!m) return false; E.make(pos, m); lastMove = m; }
      hintLevel = d.hintLevel; hinted = d.hinted; failed = d.failed; done = d.done; rated = d.rated; busy = false;
      flipped = userColor === BLACK;
      els.board.classList.remove('solved', 'failed');
      els.board.classList.toggle('failed', failed && !done); els.board.classList.toggle('solved', done);
      els.info.textContent = done || failed ? T('puzzles.info', { n: puzzle.rating }) : '';
      paint(); paintHud(); setButtons();
    },
    resume: function () {
      if (done) { say(T(failed || hinted ? 'puzzles.solved' : 'puzzles.solvedClean')); return; }
      if (pos.turn === userColor) { say(T(failed ? 'puzzles.notIt' : 'puzzles.findBest', { color: colorName(userColor) })); return; }
      busy = true; setButtons();
      later(function () { opponentMove(function () { busy = false; setButtons(); say(T('puzzles.findBest', { color: colorName(userColor) })); }); }, OPPONENT_DELAY_MS);
    }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__cp = { puzzle: function () { return puzzle; }, pos: function () { return pos; }, state: state, step: function () { return step; }, start: startPuzzle, tryUci: function (u) { var m = C.fromUci(E, pos, u); if (m) tryMove(m); return !!m; }, busy: function () { return busy; }, done: function () { return done; } };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
