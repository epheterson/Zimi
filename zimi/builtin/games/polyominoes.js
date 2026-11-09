/* ZimiGames: Polyominoes, the page. The rules and the computer are in polyominoes-engine.js, run in a Web Worker built from
   its own source (enginekit.js) with the main thread as the fallback. A turn: tap a piece in the tray, move its ghost on the
   board by touching or dragging (a finger lifts it two squares so it can be seen), turn or flip it, and press Place (or
   tap the ghost). A ghost that is not quite right snaps to the nearest square that is. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiPolyominoesEngine || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var E = root.ZimiPolyominoesEngine(), brain = root.EngineKit.client(root.ZimiPolyominoesEngine, 600, { depth: 1 });
  var N = E.N, SQ = E.SQ, PIECES = E.PIECES, PASS = E.PASS, HINT_MS = 1500;
  var TOUCH_LIFT = 2, SNAP_RANGE = 2, DRAG_PX = 6, PASS_DELAY_MS = 1100, THUMB_CELL = 8;

  function hintsOn() { return !root.ZimiShell || root.ZimiShell.settings.get('hints') !== 'off'; }
  function sideName(p) { return T(p === 0 ? 'board.blue' : 'board.red'); }

  var G = WK.create({ id: 'polyominoes', options: WK.standardOptions({ first: 'poly.side.first', second: 'poly.side.second' }), onNew: newGame, onUndo: undo, onHint: hint });
  var score = WK.scoreBar($('wk-score'), [{ color: 'var(--po-0)' }, { color: 'var(--po-1)' }]);
  var board = $('po-board'), tray = $('po-tray'), rotateBtn = $('po-rotate'), flipBtn = $('po-flip'), placeBtn = $('po-place');
  var cells = [], thumbs = [], pos, played, legalMoves = [], playable = {}, lastCells = {}, corners = {};
  var sel = -1, orient = 0, ar = 0, ac = 0, ghost = [], ghostReason = null, focusAt = null, tip = false, passTimer = 0;

  function turnIdx() { return pos.turn; }
  function myIdx() { return G.vsComputer() ? (G.human(0) ? 0 : 1) : turnIdx(); }
  function active() { return !G.over && !G.thinking && G.human(turnIdx()) && !passTimer; }

  // ── the drawing ──
  function thumbSvg(piece) {
    var o = E.ORIENT[piece][0], s = THUMB_CELL, w = o.w * s, h = o.h * s;
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" aria-hidden="true">' +
      o.cells.map(function (c) { return '<rect x="' + c[1] * s + '" y="' + c[0] * s + '" width="' + s + '" height="' + s + '" rx="1"/>'; }).join('') + '</svg>';
  }
  function buildBoard() {
    board.textContent = ''; tray.textContent = '';
    var s, p;
    for (s = 0; s < SQ; s++) {
      var c = document.createElement('button');
      c.type = 'button'; c.dataset.s = s;
      c.addEventListener('click', onCell);
      board.appendChild(c); cells.push(c);
    }
    BK.gridNav(board, cells, N);
    for (p = 0; p < PIECES; p++) {
      var b = document.createElement('button');
      b.type = 'button'; b.dataset.p = p; b.className = 'po-slot';
      b.innerHTML = thumbSvg(p);
      b.addEventListener('click', onTray);
      tray.appendChild(b); thumbs.push(b);
    }
    board.addEventListener('pointerdown', onDown);
    board.addEventListener('pointermove', onMove);
    board.addEventListener('pointerup', onUp);
    board.addEventListener('pointercancel', onCancel);
  }
  function cellLabel(s, v) {
    var what = v === 0 ? T('poly.empty') : sideName(v - 1);
    return T('poly.cell', { row: ((s / N) | 0) + 1, col: (s % N) + 1, what: what });
  }
  function paintCells() {
    var gset = {}, i, s, mine = myIdx();
    ghost.forEach(function (g) { gset[g] = true; });
    var show = hintsOn() && active();
    for (s = 0; s < SQ; s++) {
      var v = pos.board[s], cls = v ? 'p' + (v - 1) : '';
      if (lastCells[s]) cls += ' last';
      if (!v && (s === E.STARTS[0] && pos.placed[0] === 0 || s === E.STARTS[1] && pos.placed[1] === 0)) cls += ' start s' + (s === E.STARTS[0] ? 0 : 1);
      if (show && !v && corners[s] && sel < 0) cls += ' corner';
      if (gset[s]) cls += ghostReason ? ' ghost bad' : ' ghost ok';
      if (cells[s].className !== cls) cells[s].className = cls;
      var sig = v + (gset[s] ? 'g' : '');
      if (cells[s].dataset.sig !== sig) { cells[s].dataset.sig = sig; cells[s].setAttribute('aria-label', cellLabel(s, v)); }
    }
  }
  function paintTray() {
    var who = myIdx(), rem = pos.rem[who], p;
    tray.classList.toggle('is-off', !active());
    for (p = 0; p < PIECES; p++) {
      var have = (rem >> p) & 1, cls = 'po-slot';
      if (!have) cls += ' gone';
      else if (active() && !playable[p]) cls += ' stuck';
      if (p === sel) cls += ' sel';
      thumbs[p].className = cls;
      thumbs[p].setAttribute('aria-disabled', String(!have || !active() || !playable[p]));
      thumbs[p].setAttribute('aria-label', T('poly.piece', { name: E.NAMES[p], n: E.SIZE[p] }) + (have ? '' : ', ' + T('poly.placed')));
    }
  }
  function paint() {
    paintCells(); paintTray();
    var open = active(), ready = open && sel >= 0;
    rotateBtn.disabled = !ready; flipBtn.disabled = !ready;
    placeBtn.disabled = !(ready && ghost.length && !ghostReason);
    var names = G.names(sideName(0), sideName(1));
    score(names, [E.squaresLeft(pos, 0), E.squaresLeft(pos, 1)], G.over ? -1 : turnIdx());
    G.setUndo(played.length > 0); G.setHint(open);
  }

  // ── a game ──
  function request(extra) {
    return Object.assign({ board: Array.from(pos.board), rem: pos.rem.slice(), placed: pos.placed.slice(), last: pos.last.slice(), turn: pos.turn, passes: pos.passes }, extra);
  }
  function resetGhost() { sel = -1; ghost = []; ghostReason = null; tip = false; }
  function finish(st) {
    resetGhost();
    var names = G.names(sideName(0), sideName(1)), a = E.squaresLeft(pos, 0), b = E.squaresLeft(pos, 1);
    var text = T('poly.why.score', { a: names[0], na: a, b: names[1], nb: b }), out = null, name;
    if (st.winner >= 0) { out = G.vsComputer() ? (G.human(st.winner) ? 'w' : 'l') : null; name = names[st.winner]; }
    else out = G.vsComputer() ? 'd' : null;
    G.finish(text, out, name);
    paint();
  }
  function refresh() {
    legalMoves = E.moves(pos); playable = {}; corners = {};
    legalMoves.forEach(function (m) { if (m !== PASS) playable[E.pieceOf(m)] = true; });
    E.corners(pos, pos.turn).forEach(function (s) { corners[s] = true; });
  }
  function afterMove(note) {
    resetGhost(); clearTimeout(passTimer); passTimer = 0;
    var st = E.status(pos), p = turnIdx();
    if (st.over) { legalMoves = []; playable = {}; corners = {}; paint(); finish(st); return; }
    refresh();
    var mustPass = legalMoves.length === 1 && legalMoves[0] === PASS;
    paint();
    var line = !G.vsComputer() ? T('board.toMove', { name: sideName(p) }) : G.human(p) ? T('board.yourTurn') : T('shell.thinking');
    if (mustPass) {
      G.say(G.vsComputer() && !G.human(p) ? T('poly.pass.zimi') : T('poly.pass.you'), false);
      passTimer = setTimeout(function () { passTimer = 0; play(PASS); }, PASS_DELAY_MS);
      paint();
      return;
    }
    if (G.human(p) && pos.placed[p] === 0) line = T('poly.say.start');
    G.say(note ? UI.noted(note, line) : line, !G.human(p));
    if (!G.human(p)) computerTurn();
  }
  function play(m) {
    var who = G.vsComputer() ? (G.human(turnIdx()) ? T('board.you') : T('board.zimi')) : sideName(turnIdx());
    played.push(m);
    E.make(pos, m);
    if (m !== PASS) { lastCells = {}; E.cellsOf(m).forEach(function (s) { lastCells[s] = true; }); }   // a pass leaves the last piece shown
    afterMove(m === PASS ? T('poly.passed', { name: who }) : T('poly.played', { name: who }));
  }
  function computerTurn() {
    var token = G.begin();
    paint();
    brain.ask(request({ level: G.settings.level }), function (r) {
      if (!G.done(token)) return;
      play(r && legalMoves.indexOf(r.move) >= 0 ? r.move : legalMoves[0]);
    });
  }
  function hint() {
    var token = G.begin(); paint(); G.say(T('board.thinkingHint'), true);
    brain.ask(request({ level: 'hard', ms: HINT_MS }), function (r) {
      if (!G.done(token)) return;
      if (!r || r.move === PASS || legalMoves.indexOf(r.move) < 0) { paint(); G.say(T('board.noHint')); return; }
      sel = E.pieceOf(r.move); orient = E.orientOf(r.move); ar = (E.anchorOf(r.move) / N) | 0; ac = E.anchorOf(r.move) % N; tip = true;
      setGhost();
      paint(); G.say(T('poly.hint'));
    });
  }
  function undo() {
    if (!played.length) return;
    G.cancel(); G.over = false; clearTimeout(passTimer); passTimer = 0;
    do { E.unmake(pos); played.pop(); } while (played.length && G.vsComputer() && !G.human(turnIdx()));
    lastCells = {};
    var back = played.length ? played[played.length - 1] : -1;
    if (back >= 0 && back !== PASS) E.cellsOf(back).forEach(function (s) { lastCells[s] = true; });
    afterMove();
  }
  function newGame() {
    lastCells = {}; focusAt = null; resetGhost(); clearTimeout(passTimer); passTimer = 0;
    pos = E.newPosition(); played = [];
    afterMove();
  }

  // ── the ghost ──
  function size() { return E.ORIENT[sel][orient]; }
  function clampAnchor() {
    var o = size();
    ar = Math.max(0, Math.min(N - o.h, ar)); ac = Math.max(0, Math.min(N - o.w, ac));
  }
  // Put the ghost where ar, ac say, and find out whether it may go there.
  function setGhost() {
    if (sel < 0) { ghost = []; ghostReason = null; return; }
    clampAnchor();
    ghost = E.placeCells(sel, orient, ar, ac) || [];
    ghostReason = ghost.length ? E.problem(pos, turnIdx(), ghost) : 'bounds';
  }
  function centerOffset() { var o = size(); return [Math.round((o.h - 1) / 2), Math.round((o.w - 1) / 2)]; }
  function aimAt(r, c, lift) {
    var off = centerOffset();
    ar = r - off[0] - (lift || 0); ac = c - off[1];
    clampAnchor();
  }
  // The legal placement of the selected piece (any way up) nearest the anchor, within `range` squares when given.
  function nearest(range, sameWay) {
    var best = null, bd = Infinity;
    legalMoves.forEach(function (m) {
      if (m === PASS || E.pieceOf(m) !== sel || (sameWay && E.orientOf(m) !== orient)) return;
      var a = E.anchorOf(m), dr = ((a / N) | 0) - ar, dc = (a % N) - ac, d = Math.max(Math.abs(dr), Math.abs(dc)) * 10 + Math.abs(dr) + Math.abs(dc) + (E.orientOf(m) === orient ? 0 : 1);
      if (range && Math.max(Math.abs(dr), Math.abs(dc)) > range) return;
      if (d < bd) { bd = d; best = m; }
    });
    return best;
  }
  function choose(piece) {
    sel = piece; orient = 0; tip = false;
    // start on a legal spot near the middle of the action, so the first thing seen is a piece that can be placed
    var around = focusAt || (pos.placed[turnIdx()] === 0 ? E.STARTS[turnIdx()] : (N >> 1) * N + (N >> 1));
    ar = (around / N) | 0; ac = around % N;
    var m = nearest(0, false);
    if (m !== null) { orient = E.orientOf(m); ar = (E.anchorOf(m) / N) | 0; ac = E.anchorOf(m) % N; }
    setGhost();
  }
  function reasonText(r) { return T('poly.why.' + r); }
  function sayGhost() {
    if (sel < 0) return;
    G.say(ghostReason ? reasonText(ghostReason) : T('poly.say.ready'));
  }

  // ── tapping and dragging ──
  var drag = null;
  function pointerCell(e) {
    var rect = board.getBoundingClientRect(), cs = rect.width / N;
    return [Math.max(0, Math.min(N - 1, Math.floor((e.clientY - rect.top) / cs))), Math.max(0, Math.min(N - 1, Math.floor((e.clientX - rect.left) / cs)))];
  }
  function onDown(e) {
    if (sel < 0 || !active() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    var rc = pointerCell(e), lift = e.pointerType === 'mouse' ? 0 : TOUCH_LIFT, onGhost = ghost.indexOf(rc[0] * N + rc[1]) >= 0;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, lift: lift, onGhost: onGhost && !ghostReason };
    try { board.setPointerCapture(e.pointerId); } catch (x) { /* a pointer that cannot be captured still drags */ }
    if (!drag.onGhost) { aimAt(rc[0], rc[1], lift); tip = false; setGhost(); paintCells(); }
    e.preventDefault();
  }
  function onMove(e) {
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < DRAG_PX) return;
    drag.moved = true; drag.onGhost = false;
    var rc = pointerCell(e);
    aimAt(rc[0], rc[1], drag.lift); tip = false; setGhost(); paintCells();
  }
  function onUp(e) {
    if (!drag || drag.id !== e.pointerId) return;
    var d = drag; drag = null;
    if (d.onGhost && !d.moved) { place(); return; }   // a tap on the ghost places it
    settle();
  }
  function onCancel() { drag = null; }
  // Let go: a ghost that is not quite right snaps to the nearest square where the piece can go.
  function settle() {
    if (ghostReason) {
      var m = nearest(SNAP_RANGE, true) || nearest(SNAP_RANGE, false);
      if (m !== null) { orient = E.orientOf(m); ar = (E.anchorOf(m) / N) | 0; ac = E.anchorOf(m) % N; setGhost(); }
    }
    focusAt = ar * N + ac;
    paint(); sayGhost();
  }
  function onCell(e) {
    // a keyboard press (detail 0) or a click the pointer handlers did not see; pointer taps are handled on pointerdown/up
    if (e.detail !== 0 || sel < 0 || !active()) return;
    var s = +e.currentTarget.dataset.s;
    if (ghost.indexOf(s) >= 0 && !ghostReason) { place(); return; }
    aimAt((s / N) | 0, s % N, 0); setGhost(); settle();
  }
  function onTray(e) {
    var p = +e.currentTarget.dataset.p;
    if (!active() || !((pos.rem[myIdx()] >> p) & 1)) return;
    if (!playable[p]) { G.refuse(e.currentTarget, T('poly.why.nowhere')); return; }
    if (p === sel) { resetGhost(); paint(); G.say(T('board.yourTurn')); return; }
    choose(p); paint(); sayGhost();
  }
  function transform(fn) {
    if (sel < 0) return;
    var before = size(), c0 = [ar + (before.h - 1) / 2, ac + (before.w - 1) / 2];
    var cellsNow = before.cells.map(fn), minR = Math.min.apply(null, cellsNow.map(function (c) { return c[0]; })), minC = Math.min.apply(null, cellsNow.map(function (c) { return c[1]; }));
    var key = JSON.stringify(cellsNow.map(function (c) { return [c[0] - minR, c[1] - minC]; }).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }));
    for (var i = 0; i < E.ORIENT[sel].length; i++) {
      if (JSON.stringify(E.ORIENT[sel][i].cells) === key) {
        orient = i;
        var after = size();
        ar = Math.round(c0[0] - (after.h - 1) / 2); ac = Math.round(c0[1] - (after.w - 1) / 2);
        break;
      }
    }
    tip = false; setGhost(); settle();
  }
  function rotate() { transform(function (c) { return [c[1], -c[0]]; }); }
  function flip() { transform(function (c) { return [c[0], -c[1]]; }); }
  function place() {
    if (sel < 0 || !ghost.length || ghostReason || !active()) return;
    var m = E.mk(sel, orient, ar * N + ac);
    if (legalMoves.indexOf(m) < 0) return;
    play(m);
  }
  rotateBtn.addEventListener('click', rotate);
  flipBtn.addEventListener('click', flip);
  placeBtn.addEventListener('click', place);
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input')) return;
    var k = e.key.toLowerCase();
    if (k === 'r') rotate(); else if (k === 'f') flip();
    else if (k === 'escape' && sel >= 0) { resetGhost(); paint(); }
  });

  if (root.ZimiShell) {
    root.ZimiShell.settings.on(function (k) { if (k === 'hints' || k === '*') paint(); });
    root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && played.length > 0; } });
  }
  buildBoard();
  G.newGame();
  G.persist({
    save: function () { return played.length ? { played: played.slice() } : null; },
    load: function (d) {
      pos = E.newPosition(); played = []; lastCells = {};
      d.played.forEach(function (m) { E.make(pos, m); played.push(m); });
      var back = played.length ? played[played.length - 1] : -1;
      if (back >= 0 && back !== PASS) E.cellsOf(back).forEach(function (s) { lastCells[s] = true; });
      resetGhost(); refresh();
      paint();
    },
    resume: function () { afterMove(); }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__poly = { engine: E, pos: function () { return pos; }, play: play, moves: function () { return legalMoves; }, usingWorker: function () { return brain.usingWorker(); }, choose: function (p) { choose(p); paint(); }, ghost: function () { return ghost.slice(); }, reason: function () { return ghostReason; } };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
