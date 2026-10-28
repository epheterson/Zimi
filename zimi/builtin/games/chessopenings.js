/* ZimiGames: the Opening Trainer, the page. Pick an opening from the 3,800 named lines of lichess-org/chess-openings
   (CC0), then play your side of the line against the board: the book move is right, anything else is told what the
   line plays. The computer plays the other side's moves. No engine thinking, no network. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiChessEngine || !root.ZimiChessOpenings || !root.BoardUI) return;
  var E = root.ZimiChessEngine(), C = root.ZimiChessContent, BK = root.BoardKit, Board = root.ZimiChessBoard, UI = root.BoardUI, T = UI.t;
  var $ = function (id) { return document.getElementById(id); };
  var WHITE = E.WHITE, BLACK = E.BLACK;
  var KEY = 'chessopenings', REPLY_DELAY_MS = 450, MIN_PLIES = 4, DEFAULT_FAMILY = 'Italian Game';

  var index = C.openingIndex(E, root.ZimiChessOpenings.rows);
  var lines = index.lines.filter(function (l) { return l.moves.length >= MIN_PLIES; });
  var families = {};
  lines.forEach(function (l) { (families[C.family(l.name)] = families[C.family(l.name)] || []).push(l); });
  var familyNames = Object.keys(families).sort();
  Object.keys(families).forEach(function (f) { families[f].sort(function (a, b) { return a.moves.length - b.moves.length || (a.name < b.name ? -1 : 1); }); });

  var state = BK.load(KEY, {});
  if (!families[state.family]) state.family = families[DEFAULT_FAMILY] ? DEFAULT_FAMILY : familyNames[0];
  if (state.side !== 'black') state.side = 'white';
  if (!state.done || typeof state.done !== 'object') state.done = {};
  var save = function () { BK.save(KEY, state); };

  var els = { name: $('co-name'), status: $('co-status'), moves: $('co-moves'), stats: $('co-stats'), hint: $('co-hint'), next: $('co-next'), nu: $('co-new'), board: $('co-board') };
  var status = UI.status(els.status);
  var line, pos, step, sans, lastMove = 0, sel = -1, targets = {}, cue = null, userColor, busy = false, finished = false, mistakes = 0, hinted = false, hintLevel = 0, pending = null, timer = 0;
  var view = Board.create($('co-board'), E, onSquare);

  function lineKey(l) { return l.eco + '|' + l.name; }
  function paint() { view.paint(pos, { flipped: userColor === BLACK, last: lastMove, sel: sel, targets: targets, cue: cue }); }
  function say(t, busy) { status.turn(t, !!busy); }
  function later(fn, ms) { clearTimeout(timer); timer = setTimeout(fn, ms); }
  function paintMoves() {
    var html = '';
    for (var i = 0; i < sans.length; i++) {
      if (i % 2 === 0) html += '<span class="cs-n">' + (i / 2 + 1) + '.</span>';
      html += '<span class="cs-m' + (i === sans.length - 1 ? ' now' : '') + '">' + sans[i] + '</span> ';
    }
    els.moves.innerHTML = html || '<span class="cs-none">' + T('openings.noMoves') + '</span>';
    els.moves.scrollTop = els.moves.scrollHeight;
  }
  function paintStats() {
    var n = state.done[lineKey(line)] || 0, total = Object.keys(state.done).length;
    els.stats.textContent = total ? (n ? T('openings.playedLine', { n: n }) + ' ' : '') + T('openings.played', { n: total, of: lines.length }) : '';
  }

  function play(m) {
    sans.push(E.san(pos, m)); E.make(pos, m); lastMove = m; step++; sel = -1; targets = {}; cue = null;
    paintMoves(); paint();
  }
  function lineMove() { return C.fromUci(E, pos, line.moves[step]); }

  function start(l) {
    clearTimeout(timer);
    line = l; pos = E.startPosition(); step = 0; sans = []; lastMove = 0; sel = -1; targets = {}; cue = null;
    userColor = state.side === 'white' ? WHITE : BLACK; finished = false; mistakes = 0; hinted = false; hintLevel = 0; busy = false;
    els.name.textContent = line.eco + ' · ' + line.name;
    els.next.setAttribute('aria-pressed', 'false');
    paintMoves(); paintStats(); paint(); advance();
  }
  // Play the computer's moves until it is the player's turn or the line ends.
  function advance() {
    if (step >= line.moves.length) { complete(); return; }
    if (pos.turn === userColor) { busy = false; say(T(step === 0 ? 'openings.first' : 'openings.what')); return; }
    busy = true; say(T('openings.continues'), true);
    later(function () { play(lineMove()); advance(); }, step === 0 ? 150 : REPLY_DELAY_MS);
  }
  function complete() {
    finished = true; busy = false;
    var k = lineKey(line); state.done[k] = (state.done[k] || 0) + 1; save();
    els.next.setAttribute('aria-pressed', 'true');
    say(T(mistakes || hinted ? 'openings.complete' : 'openings.completeClean', { name: line.name }));
    paintStats();
    UI.end({ result: 'win', text: T(mistakes || hinted ? 'openings.complete' : 'openings.completeClean', { name: line.name }), newLabel: T('board.next'), onNew: nextLine });
  }

  function onSquare(s) {
    if (finished || busy || pos.turn !== userColor) return;
    var v = pos.sq[s];
    if (sel >= 0 && targets.hasOwnProperty(s)) {
      var cands = E.legalMoves(pos).filter(function (m) { return E.from(m) === sel && E.to(m) === s; });
      if (cands.length > 1) { pending = cands; askPromotion(cands); return; }
      attempt(cands[0]); return;
    }
    if (v * pos.turn > 0 && s !== sel) { sel = s; targets = view.movesFrom(pos, s); cue = null; } else { sel = -1; targets = {}; }
    paint();
  }
  function attempt(m) {
    if (m === lineMove()) { play(m); advance(); return; }
    // not the book move: say what the line plays, and name what this move is if it is another opening
    var book = E.san(pos, lineMove()), other = '';
    E.make(pos, m);
    var keys = [E.key(pos)], hit = index.byKey[keys[0]];
    E.unmake(pos);
    if (hit) other = T('openings.thatIs', { name: hit.name });
    mistakes++; sel = -1; targets = {};
    cue = { from: E.from(lineMove()), to: E.to(lineMove()) };
    paint();
    UI.refuse(status, els.board, T('openings.notThis', { move: book }) + (other ? ' ' + other : ''));
  }
  // The pawn reaches the far rank: a sheet of the four pieces it can become.
  var promoSheet = null;
  function askPromotion(cands) {
    pending = cands;
    var box = UI.h('div', { class: 'cs-promo-choices' });
    Board.promoButtons(E, box, function (t) {
      var m = pending && pending.filter(function (x) { return E.promo(x) === t; })[0];
      promoSheet.close();
      if (m) attempt(m);
    });
    Board.promoColour(box, pos.turn === WHITE);
    promoSheet = root.ZimiShell.sheet({ title: T('chess.promote'), body: [box], onClose: function () { pending = null; } });
  }

  function hint() {
    if (finished || busy) return;
    hinted = true; hintLevel++;
    var m = lineMove();
    cue = { from: E.from(m), to: hintLevel > 1 ? E.to(m) : -1 };
    sel = -1; targets = {}; say(T(hintLevel > 1 ? 'openings.hint2' : 'openings.hint1')); paint();
  }
  function nextLine() {
    var pool = families[state.family];
    var fresh = pool.filter(function (l) { return !state.done[lineKey(l)] && l !== line; });
    var from = fresh.length ? fresh : pool.filter(function (l) { return l !== line; });
    start(from.length ? from[Math.floor(Math.random() * from.length)] : pool[0]);
  }

  // ── Menu > New game: your side, then an opening and a line. Nothing applies until New game is pressed. ──
  var draft = null;
  function lineText(l, fam) { return T('openings.line', { name: l.name.replace(fam + ': ', '').replace(fam, T('openings.mainLine')), eco: l.eco, n: Math.ceil(l.moves.length / 2) }); }
  function menuOptions() {
    draft = { side: state.side, family: state.family, line: Math.max(0, families[state.family].indexOf(line)) };
    var side = UI.row(T('board.youPlay'), [['white', T('board.white')], ['black', T('board.black')]], draft.side, function (v) { draft.side = v; });
    var search = UI.field(T('openings.search'), UI.h('input', { type: 'search', placeholder: T('openings.searchHint'), autocomplete: 'off' }));
    var fam = UI.select(T('openings.opening'), [], draft.family, null), ln = UI.select(T('openings.lineLabel'), [], '0', null);
    function fillLines() {
      ln.node.textContent = '';
      (families[draft.family] || []).forEach(function (l, i) { ln.node.add(new Option(lineText(l, draft.family), i)); });
      ln.node.value = String(Math.min(draft.line, Math.max(0, ln.node.options.length - 1))); draft.line = +ln.node.value || 0;
    }
    function fillFamilies(filter) {
      var f = (filter || '').trim().toLowerCase();
      fam.node.textContent = '';
      familyNames.filter(function (n) { return !f || n.toLowerCase().indexOf(f) >= 0; }).forEach(function (n) { fam.node.add(new Option(T('openings.family', { name: n, n: families[n].length }), n)); });
      if (families[draft.family] && Array.prototype.some.call(fam.node.options, function (o) { return o.value === draft.family; })) fam.node.value = draft.family;
      else if (fam.node.options.length) { draft.family = fam.node.value; draft.line = 0; }
      fillLines();
    }
    search.node.addEventListener('input', function (e) { fillFamilies(e.target.value); });
    fam.node.addEventListener('change', function () { draft.family = fam.node.value; draft.line = 0; fillLines(); });
    ln.node.addEventListener('change', function () { draft.line = +ln.node.value; });
    fillFamilies('');
    return UI.options([side, search, fam, ln]);
  }
  els.nu.addEventListener('click', function () {
    var d = draft; draft = null;
    if (!d) { start(line); return; }
    state.side = d.side; state.family = d.family; save();
    var l = families[d.family] && families[d.family][d.line];
    start(l || families[state.family][0]);
  });
  els.hint.addEventListener('click', hint);
  $('co-restart').addEventListener('click', function () { start(line); });
  els.next.addEventListener('click', nextLine);
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input,select')) return;
    var k = e.key.toLowerCase();
    if (k === 'h') hint(); else if (k === 'n') nextLine(); else if (k === 'r') start(line);
    else if (e.key === 'Escape' && sel >= 0) { sel = -1; targets = {}; paint(); }
  });

  if (root.ZimiShell) root.ZimiShell.game({
    menu: menuOptions, hints: true,
    inProgress: function () { return !finished && step > 1; }
  });
  start(families[state.family][0]);
  // Leaving and coming back: the same line, played as far as it was (the position is played again from the start).
  UI.persist({
    save: function () { return line ? { key: lineKey(line), side: state.side, step: step, mistakes: mistakes, hinted: hinted, hintLevel: hintLevel, finished: finished } : null; },
    load: function (d) {
      var l = lines.filter(function (x) { return lineKey(x) === d.key; })[0];
      if (!l) return false;
      clearTimeout(timer);
      state.side = d.side; state.family = C.family(l.name);
      line = l; pos = E.startPosition(); sans = []; lastMove = 0; sel = -1; targets = {}; cue = null; pending = null;
      userColor = state.side === 'white' ? WHITE : BLACK;
      for (step = 0; step < d.step; step++) { var m = C.fromUci(E, pos, line.moves[step]); if (!m) return false; sans.push(E.san(pos, m)); E.make(pos, m); lastMove = m; }
      finished = d.finished; mistakes = d.mistakes; hinted = d.hinted; hintLevel = d.hintLevel; busy = false;
      els.name.textContent = line.eco + ' · ' + line.name;
      els.next.setAttribute('aria-pressed', String(finished));
      paintMoves(); paintStats(); paint();
    },
    resume: function () {
      if (finished) { say(T(mistakes || hinted ? 'openings.complete' : 'openings.completeClean', { name: line.name })); return; }
      advance();
    }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__co = { line: function () { return line; }, pos: function () { return pos; }, busy: function () { return busy; }, finished: function () { return finished; }, state: state, start: start, lines: lines, families: families, attemptUci: function (u) { var m = C.fromUci(E, pos, u); if (m) attempt(m); return !!m; } };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
