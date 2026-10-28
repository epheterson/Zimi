/* ZimiGames: Hnefatafl (Copenhagen rules, 11 x 11), the page. The rules and the heuristic computer are in
   hnefatafl-engine.js, run in a Web Worker built from its own source (enginekit.js) with the main thread as the
   fallback. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiHnefataflEngine || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var E = root.ZimiHnefataflEngine(root.ZimiSearch()), brain = root.EngineKit.client(root.ZimiHnefataflEngine, 400);
  var ATT = E.ATT, KING = E.KING, SIZE = E.N, N = E.SQUARES, HINT_MS = 1500, TOOK_MS = 900;
  function sideName(p) { return T(p === 0 ? 'hnefatafl.side.att' : 'hnefatafl.side.def'); }
  // Show legal moves is the shell's Hints setting (Menu > Settings), not a New game option.
  function hintsOn() { return !root.ZimiShell || root.ZimiShell.settings.get('hints') !== 'off'; }
  var CROWN = '<svg class="hn-crown" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18l-1-11 6 5 4-8 4 8 6-5-1 11z"/></svg>';

  var G = WK.create({
    id: 'hnefatafl',
    options: WK.standardOptions({ first: 'hnefatafl.side.attFirst', second: 'hnefatafl.side.def' }),
    checks: [{ key: 'shield', label: 'hnefatafl.shield', def: false }],
    onNew: newGame, onUndo: undo, onHint: hint
  });
  var score = WK.scoreBar($('wk-score'), [{ color: 'var(--hn-att)' }, { color: 'var(--hn-def)', border: 'var(--hn-def-lo)' }]);
  var board = $('hn-board'), cells = [];
  var pos, keys, played, legal, sel = -1, targets = {}, lastMove = 0, tip = null, took = [], tookTimer = 0;

  function turnIdx() { return pos.turn === ATT ? 0 : 1; }
  function nameOf(p) { return G.vsComputer() ? (G.human(p) ? T('board.you') : T('board.zimi')) : sideName(p); }

  function buildBoard() {
    board.textContent = '';
    for (var s = 0; s < N; s++) {
      var c = document.createElement('button');
      c.type = 'button'; c.dataset.s = s;
      c.addEventListener('click', onSquare);
      board.appendChild(c); cells.push(c);
    }
    BK.gridNav(board, cells, SIZE);
  }
  function pieceHtml(v) { return v === KING ? '<span class="hn-pc k">' + CROWN + '</span>' : '<span class="hn-pc ' + (v === ATT ? 'a' : 'd') + '"></span>'; }
  function label(s, v) {
    var what = T(v === ATT ? 'hnefatafl.sq.attacker' : v === E.DEF ? 'hnefatafl.sq.defender' : v === KING ? 'hnefatafl.sq.king' : s === E.THRONE ? 'hnefatafl.sq.throne' : E.isCorner(s) ? 'hnefatafl.sq.corner' : 'hnefatafl.sq.empty');
    var text = T(targets.hasOwnProperty(s) ? 'hnefatafl.sq.target' : 'hnefatafl.sq', { sq: E.squareName(s), what: what });
    return s === sel ? T('chess.sq.selected', { label: text }) : text;
  }

  function paint() {
    var open = !G.over && !G.thinking && G.human(turnIdx());
    for (var s = 0; s < N; s++) {
      var c = cells[s], v = pos.sq[s], cls = 'hn-sq';
      if (E.isCorner(s)) cls += ' corner'; else if (s === E.THRONE) cls += ' throne';
      if (lastMove && (s === E.from(lastMove) || s === E.to(lastMove))) cls += ' last';
      if (s === sel) cls += ' sel';
      if (tip && (s === tip[0] || s === tip[1])) cls += ' tip';
      if (took.indexOf(s) >= 0) cls += ' took';
      if (hintsOn() && targets.hasOwnProperty(s)) cls += ' hint';
      c.className = cls;
      if (c.dataset.sig !== String(v)) { c.innerHTML = v ? pieceHtml(v) : ''; c.dataset.sig = String(v); }
      c.setAttribute('aria-label', label(s, v));
    }
    var att = 0, def = 0;
    for (var i = 0; i < N; i++) { if (pos.sq[i] === ATT) att++; else if (pos.sq[i]) def++; }
    var names = G.names(sideName(0), sideName(1));
    score(names, [att, T('hnefatafl.defCount', { n: def })], G.over ? -1 : turnIdx());
    G.setUndo(played.length > 0); G.setHint(open);
  }

  var WHY = { 'king taken': 'hnefatafl.why.kingTaken', corner: 'hnefatafl.why.corner', ringed: 'hnefatafl.why.ringed', repetition: 'xiangqi.why.repetition' };
  function finish(st) {
    sel = -1; targets = {}; tip = null;
    var msg, out, name, wi = st.winner === ATT ? 0 : 1;
    if (st.result === 'repetition') { msg = T(WHY.repetition); out = G.vsComputer() ? 'd' : null; }
    else {
      msg = st.result === 'blocked' ? T('hnefatafl.why.blocked', { side: sideName(1 - wi) }) : T(WHY[st.result]);
      out = G.vsComputer() ? (G.human(wi) ? 'w' : 'l') : null;
      name = sideName(wi);
    }
    G.finish(msg, out, name);
    paint();
  }
  function afterMove(note) {
    sel = -1; targets = {}; tip = null;
    var st = E.status(pos, keys), p = turnIdx();
    if (st.over) { paint(); finish(st); return; }
    legal = E.moves(pos);
    paint();
    var line = !G.vsComputer() ? T('board.toMove', { name: sideName(p) }) : G.human(p) ? T('makruk.yourTurn', { side: sideName(p).toLowerCase() }) : T('shell.thinking');
    if (st.kingThreat) line = T('hnefatafl.kingThreat', { line: line });
    G.say(note ? UI.noted(note, line) : line, !G.human(p));
    if (!G.human(p)) computerTurn();
  }
  function play(m) {
    var who = nameOf(turnIdx());
    played.push(m);
    E.make(pos, m); keys.push(E.key(pos)); lastMove = m;
    took = E.lastCaptures(pos);
    clearTimeout(tookTimer);
    if (took.length) tookTimer = setTimeout(function () { took = []; paint(); }, TOOK_MS);
    var n = took.length;
    afterMove(T(G.vsComputer() ? 'hnefatafl.played' : 'hnefatafl.playedTwo', { name: who, move: E.notation(pos, m), taking: n ? T('hnefatafl.taking', { n: n }) : '' }));
  }
  function request(extra) { return Object.assign({ sq: Array.from(pos.sq), turn: pos.turn, shield: pos.shield }, extra); }

  function computerTurn() {
    var token = G.begin();
    paint();
    brain.ask(request({ level: G.settings.level }), function (r) {
      if (!G.done(token)) return;
      play(r && legal.indexOf(r.move) >= 0 ? r.move : legal[0]);
    });
  }
  function hint() {
    var token = G.begin(); paint(); G.say(T('board.thinkingHint'), true);
    brain.ask(request({ level: 'hard', ms: HINT_MS }), function (r) {
      if (!G.done(token)) return;
      tip = r && r.move ? [E.from(r.move), E.to(r.move)] : null; paint();
      G.say(tip ? T('makruk.hint', { move: E.notation(pos, r.move) }) : T('board.noHint'));
    });
  }

  function onSquare(e) {
    if (G.over || G.thinking || !G.human(turnIdx())) return;
    var s = +e.currentTarget.dataset.s, v = pos.sq[s];
    if (sel >= 0 && targets.hasOwnProperty(s)) { play(E.mk(sel, s)); return; }
    var mine = v && (pos.turn === ATT ? v === ATT : v !== ATT);
    if (mine && s !== sel) {
      sel = s; targets = {}; tip = null;
      legal.forEach(function (m) { if (E.from(m) === s) targets[E.to(m)] = true; });
      if (Object.keys(targets).length) G.say(T('board.chooseWhere'));
      else { sel = -1; G.refuse(e.currentTarget, T('chess.cantMove')); }
    } else { sel = -1; targets = {}; }
    paint();
  }
  function undo() {
    if (!played.length) return;
    G.cancel(); G.over = false;
    do { E.unmake(pos); played.pop(); keys.pop(); } while (played.length && G.vsComputer() && !G.human(turnIdx()));
    lastMove = played[played.length - 1] || 0; took = [];
    afterMove();
  }
  function newGame() {
    sel = -1; targets = {}; lastMove = 0; tip = null; took = [];
    pos = E.newPosition({ shield: G.settings.shield }); keys = [E.key(pos)]; played = [];
    afterMove();
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input')) return;
    if (e.key === 'Escape' && sel >= 0) { sel = -1; targets = {}; paint(); }
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
      pos = E.newPosition({ shield: G.settings.shield }); keys = [E.key(pos)]; played = [];
      d.played.forEach(function (m) { E.make(pos, m); played.push(m); keys.push(E.key(pos)); });
      lastMove = played[played.length - 1] || 0; sel = -1; targets = {}; tip = null; took = [];
      paint();
    },
    resume: function () { afterMove(); }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__hn = { engine: E, pos: function () { return pos; }, play: play, usingWorker: function () { return brain.usingWorker(); },
      setPosition: function (str, turn) { pos = E.fromString(str, turn, { shield: G.settings.shield }); keys = [E.key(pos)]; played = []; lastMove = 0; G.over = false; afterMove(); } };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
