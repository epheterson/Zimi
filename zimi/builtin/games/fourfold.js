/* ZimiGames: Fourfold, the page. The rules and the computer are in fourfold-engine.js, run in a Web Worker built from its own
   source (enginekit.js) with the main thread as the fallback. A turn: tap a square for the piece in hand, tap a piece in the
   tray to hand over, press Hand over. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiFourfoldEngine || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var E = root.ZimiFourfoldEngine(root.ZimiSearch()), brain = root.EngineKit.client(root.ZimiFourfoldEngine, 500);
  var SQ = E.SQ, PIECES = E.PIECES, SIDE = 4, HINT_MS = 1500;
  var TRAIT_WORDS = [['short', 'tall'], ['light', 'dark'], ['square', 'round'], ['solid', 'hollow']];

  function hintsOn() { return !root.ZimiShell || root.ZimiShell.settings.get('hints') !== 'off'; }
  function playerName(p) { return T('fourfold.player', { n: p + 1 }); }

  var G = WK.create({ id: 'fourfold', onNew: newGame, onUndo: undo, onHint: hint });
  var score = WK.scoreBar($('wk-score'), [{ color: 'var(--ff-dark-top)' }, { color: 'var(--ff-light-top)' }]);
  var board = $('ff-board'), tray = $('ff-tray'), giveBtn = $('ff-give'), handPc = $('ff-hand-pc'), handText = $('ff-hand-text');
  var cells = [], trayBtns = [], pos, played, lastMove = -1, pending = -1, choice = -1, tip = null, winLine = null;

  // ── the pieces ──
  function traitWord(t, v) { return T('fourfold.trait.' + t + '.' + v); }
  function pieceName(piece) {
    return T('fourfold.piece', { a: traitWord(0, E.trait(piece, 0)), b: traitWord(1, E.trait(piece, 1)), c: traitWord(2, E.trait(piece, 2)), d: traitWord(3, E.trait(piece, 3)) });
  }
  // A piece seen from the side: tall or short, dark or light, a round or a square footprint, a hollow top or a solid one.
  function pieceSvg(piece) {
    var tall = E.trait(piece, 0), dark = E.trait(piece, 1), round = E.trait(piece, 2), hollow = E.trait(piece, 3);
    var h = tall ? 30 : 16, top = 42 - h, cls = dark ? 'd' : 'l', body, face, hole = '';
    if (round) {
      body = '<path class="ff-side" d="M8 ' + top + 'V42a12 4.4 0 0 0 24 0V' + top + 'z"/>';
      face = '<ellipse class="ff-face" cx="20" cy="' + top + '" rx="12" ry="4.4"/>';
      if (hollow) hole = '<ellipse class="ff-hole" cx="20" cy="' + top + '" rx="6.6" ry="2.4"/>';
    } else {
      body = '<path class="ff-side" d="M8 ' + top + 'V42h24V' + top + 'z"/>';
      face = '<path class="ff-face" d="M8 ' + top + 'L13 ' + (top - 5) + 'H35L32 ' + top + 'z"/><path class="ff-edge" d="M32 ' + top + 'L35 ' + (top - 5) + 'V37L32 42z"/>';
      if (hollow) hole = '<path class="ff-hole" d="M16 ' + (top - 1.2) + 'L18.6 ' + (top - 3.8) + 'H29.4L26.8 ' + (top - 1.2) + 'z"/>';
    }
    return '<svg class="ff-pc ' + cls + '" viewBox="0 0 40 46" aria-hidden="true">' + body + face + hole + '</svg>';
  }

  // ── the drawing ──
  function buildBoard() {
    board.textContent = ''; tray.textContent = '';
    var s, p;
    for (s = 0; s < SQ; s++) {
      var c = document.createElement('button');
      c.type = 'button'; c.dataset.s = s;
      c.addEventListener('click', onSquare);
      board.appendChild(c); cells.push(c);
    }
    BK.gridNav(board, cells, SIDE);
    for (p = 0; p < PIECES; p++) {
      var b = document.createElement('button');
      b.type = 'button'; b.dataset.p = p; b.className = 'ff-slot';
      b.innerHTML = pieceSvg(p);
      b.addEventListener('click', onTray);
      tray.appendChild(b); trayBtns.push(b);
    }
  }
  function cellLabel(s) {
    var v = pos.sq[s] ? pos.sq[s] - 1 : (s === pending ? pos.given : -1);
    var what = v < 0 ? T('fourfold.empty') : pieceName(v);
    return T('fourfold.cell', { row: (s / SIDE | 0) + 1, col: (s % SIDE) + 1, what: what });
  }
  // The phase of the person at the screen: 'place' a piece, 'give' one over, or none.
  function phase() {
    if (G.over || G.thinking || !G.human(pos.turn)) return '';
    if (pos.given < 0) return 'give';
    return pending >= 0 ? 'give' : 'place';
  }
  function dangerMask() {
    if (pending < 0 && pos.given >= 0) return 0;
    if (pending >= 0) pos.sq[pending] = pos.given + 1;
    var m = E.danger(pos);
    if (pending >= 0) pos.sq[pending] = 0;
    return m;
  }

  function paint() {
    var ph = phase(), s, p, bad = hintsOn() && ph === 'give' ? dangerMask() : 0;
    for (s = 0; s < SQ; s++) {
      var c = cells[s], v = pos.sq[s] ? pos.sq[s] - 1 : (s === pending ? pos.given : -1), cls = '';
      if (s === pending) cls += 'pending ';
      if (lastMove >= 0 && !E.isOpening(lastMove) && s === E.squareOf(lastMove)) cls += 'last ';
      if (winLine && winLine.indexOf(s) >= 0) cls += 'win ';
      if (tip && tip.s === s) cls += 'tip ';
      if (ph === 'place' && !pos.sq[s] && hintsOn()) cls += 'open ';
      c.className = cls.trim();
      var sig = String(v);
      if (c.dataset.sig !== sig) { c.innerHTML = v < 0 ? '' : pieceSvg(v); c.dataset.sig = sig; }
      c.setAttribute('aria-label', cellLabel(s));
    }
    for (p = 0; p < PIECES; p++) {
      var b = trayBtns[p], gone = !!((pos.used >> p) & 1), tc = '';
      if (gone) tc += 'gone ';
      if (p === choice) tc += 'sel ';
      if (tip && tip.g === p) tc += 'tip ';
      if (bad && !gone && ((bad >> p) & 1)) tc += 'danger ';
      b.className = 'ff-slot ' + tc.trim();
      var off = gone || ph !== 'give';
      b.setAttribute('aria-disabled', String(off));
      b.setAttribute('aria-label', pieceName(p) + (gone ? '' : (tc.indexOf('danger') >= 0 ? ', ' + T('fourfold.wouldWin') : '')));
    }
    // the piece in hand, and who places it
    if (pos.given >= 0 && !G.over) {
      handPc.innerHTML = pieceSvg(pos.given);
      var placer = G.vsComputer() ? (G.human(pos.turn) ? '' : T('board.zimi')) : playerName(pos.turn);
      handText.textContent = placer ? T('fourfold.hand.other', { name: placer }) : T('fourfold.hand.you');
      handPc.parentNode.classList.remove('is-empty');
      handPc.parentNode.setAttribute('aria-label', pieceName(pos.given));
    } else {
      handPc.innerHTML = ''; handText.textContent = '';
      handPc.parentNode.classList.add('is-empty');
      handPc.parentNode.removeAttribute('aria-label');
    }
    giveBtn.disabled = !(ph === 'give' && choice >= 0);
    var names = G.names(playerName(0), playerName(1));
    score(names, null, G.over ? -1 : pos.turn);
    G.setUndo(played.length > 0 || pending >= 0); G.setHint(!G.over && !G.thinking && G.human(pos.turn));
  }

  // ── a game ──
  function request(extra) { return Object.assign({ sq: Array.from(pos.sq), given: pos.given, turn: pos.turn }, extra); }
  function finish(st) {
    var text, out = null, name;
    if (st.draw) { text = T('fourfold.why.full'); out = G.vsComputer() ? 'd' : null; }
    else {
      var line = E.winningLine(pos), shared = E.sharedTraits(pos, line)[0];
      winLine = line;
      text = T('fourfold.why.line', { trait: traitWord(shared[0], shared[1]) });
      out = G.vsComputer() ? (G.human(st.winner) ? 'w' : 'l') : null;
      name = G.names(playerName(0), playerName(1))[st.winner];
    }
    G.finish(text, out, name);
    paint();
  }
  function afterMove(note) {
    pending = -1; choice = -1; tip = null;
    var st = E.status(pos);
    if (st.over) { paint(); finish(st); return; }
    paint();
    var line = !G.vsComputer() ? T('board.toMove', { name: playerName(pos.turn) }) : G.human(pos.turn) ? T(pos.given < 0 ? 'fourfold.say.giveFirst' : 'fourfold.say.place') : T('shell.thinking');
    G.say(note ? UI.noted(note, line) : line, !G.human(pos.turn));
    if (!G.human(pos.turn)) computerTurn();
  }
  function play(m) {
    var who = G.vsComputer() ? (G.human(pos.turn) ? T('board.you') : T('board.zimi')) : playerName(pos.turn);
    played.push(m);
    E.make(pos, m); lastMove = m;
    afterMove(E.isOpening(m) ? T('fourfold.played.give', { name: who }) : T('fourfold.played', { name: who }));
  }
  function computerTurn() {
    var token = G.begin();
    paint();
    brain.ask(request({ level: G.settings.level }), function (r) {
      if (!G.done(token)) return;
      var all = E.moves(pos, true);
      play(r && all.indexOf(r.move) >= 0 ? r.move : all[0]);
    });
  }
  function hint() {
    var token = G.begin(); paint(); G.say(T('board.thinkingHint'), true);
    brain.ask(request({ level: 'hard', ms: HINT_MS }), function (r) {
      if (!G.done(token)) return;
      var ok = r && r.move >= 0 && E.legal(pos, r.move);
      tip = ok ? { s: E.isOpening(r.move) ? -1 : E.squareOf(r.move), g: E.giveOf(r.move) } : null;
      paint();
      G.say(!tip ? T('board.noHint') : tip.s >= 0 && tip.g >= 0 ? T('fourfold.hint.both') : tip.s >= 0 ? T('fourfold.hint.win') : T('fourfold.hint.give'));
    });
  }
  function undo() {
    if (pending >= 0) { pending = -1; choice = -1; paint(); G.say(T('fourfold.say.place')); return; }
    if (!played.length) return;
    G.cancel(); G.over = false; winLine = null;
    do { E.unmake(pos); played.pop(); } while (played.length && G.vsComputer() && !G.human(pos.turn));
    lastMove = played.length ? played[played.length - 1] : -1;
    afterMove();
  }
  function newGame() {
    lastMove = -1; pending = -1; choice = -1; tip = null; winLine = null;
    pos = E.newPosition(); played = [];
    afterMove();
  }

  // ── tapping ──
  function onSquare(e) {
    var s = +e.currentTarget.dataset.s, ph = phase();
    if (G.over || G.thinking || !G.human(pos.turn)) return;
    if (s === pending) { pending = -1; choice = -1; tip = null; paint(); G.say(T('fourfold.say.place')); return; }
    if (ph !== 'place') { G.refuse(e.currentTarget, T(ph === 'give' ? 'fourfold.why.giveFirst' : 'fourfold.why.wait')); return; }
    if (pos.sq[s]) { G.refuse(e.currentTarget, T('fourfold.why.taken')); return; }
    tip = null;
    // a placement that completes a line, or fills the board, needs no piece handed over: it is played at once
    if (E.wins(pos, s, pos.given) || E.empties(pos).length === 1) { play(E.mk(s, -1)); return; }
    pending = s; choice = -1;
    paint(); G.say(T('fourfold.say.give'));
  }
  function onTray(e) {
    var p = +e.currentTarget.dataset.p;
    if (phase() !== 'give' ) { if (!G.over && !G.thinking && G.human(pos.turn)) G.refuse(e.currentTarget, T('fourfold.why.placeFirst')); return; }
    if ((pos.used >> p) & 1) return;
    choice = choice === p ? -1 : p; tip = null;
    paint();
    G.say(choice >= 0 ? T('fourfold.say.confirm') : T('fourfold.say.give'));
  }
  function give() {
    if (phase() !== 'give' || choice < 0) return;
    play(pos.given < 0 ? E.OPENING + choice : E.mk(pending, choice));
  }
  giveBtn.addEventListener('click', give);

  if (root.ZimiShell) {
    root.ZimiShell.settings.on(function (k) { if (k === 'hints' || k === '*') paint(); });
    root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && played.length > 0; } });
  }
  buildBoard();
  G.newGame();
  G.persist({
    save: function () { return played.length ? { played: played.slice() } : null; },
    load: function (d) {
      pos = E.newPosition(); played = [];
      d.played.forEach(function (m) { E.make(pos, m); played.push(m); });
      lastMove = played.length ? played[played.length - 1] : -1; pending = -1; choice = -1; tip = null;
      winLine = G.over ? E.winningLine(pos) : null;
      paint();
    },
    resume: function () { afterMove(); }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__fourfold = { engine: E, pos: function () { return pos; }, play: play, usingWorker: function () { return brain.usingWorker(); } };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
