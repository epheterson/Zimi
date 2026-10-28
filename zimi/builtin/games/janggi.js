/* ZimiGames: Janggi, the page. The rules and the searcher are in janggi-engine.js (run in a Web Worker
   built from its own source, with the main thread as the fallback, through enginekit.js). Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiJanggiEngine || !root.BoardUI) return;
  var F = root.ZimiFairy, WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var E = root.ZimiJanggiEngine(root.ZimiSearch()), brain = root.EngineKit.client(root.ZimiJanggiEngine, 300);
  var CHO = E.CHO, HAN = E.HAN, COLS = E.COLS, ROWS = E.ROWS, N = COLS * ROWS, PASS = E.PASS;
  var HINT_MS = 1500;
  var HANJA = { 1: { c: '卒', h: '兵' }, 2: { c: '包', h: '包' }, 3: { c: '車', h: '車' }, 4: { c: '馬', h: '馬' }, 5: { c: '象', h: '象' }, 6: { c: '士', h: '士' }, 7: { c: '楚', h: '漢' } };
  function sideName(p) { return T(p === 0 ? 'janggi.side.cho' : 'janggi.side.han'); }
  var LEVEL_CHOICES = [['fairy', 'chess.level.fairy'], ['master', 'chess.level.master']];   // Strong and Master, when Fairy-Stockfish is there
  // Show legal moves is the shell's Hints setting (Menu > Settings), not a New game option.
  function hintsOn() { return !root.ZimiShell || root.ZimiShell.settings.get('hints') !== 'off'; }

  var G = WK.create({
    id: 'janggi',
    options: WK.standardOptions({ first: 'janggi.side.choFirst', second: 'janggi.side.han', levels: LEVEL_CHOICES }).concat([{ key: 'labels', legend: 'xiangqi.pieces', def: root.ZimiText && root.ZimiText.lang === 'zh' ? 'han' : 'icons', choices: [['han', 'xiangqi.pieces.han'], ['icons', 'xiangqi.pieces.icons']] }]),
    onNew: newGame, onUndo: undo, onHint: hint
  });
  var score = WK.scoreBar($('wk-score'), [{ color: 'var(--jg-cho)' }, { color: 'var(--jg-han)' }]);
  var els = { grid: $('jg-grid'), pass: $('jg-pass'), flip: $('jg-flip') };
  var cells = [], pos, keys, sans, played, sel = -1, targets = {}, lastMove = 0, manualFlip = false, tip = null;

  function turnIdx() { return pos.turn === CHO ? 0 : 1; }
  function flipped() { return manualFlip !== (G.vsComputer() && G.settings.side === 'second'); }
  function sqAt(d) { return flipped() ? N - 1 - d : d; }
  function nameOf(p) { return G.vsComputer() ? (G.human(p) ? T('board.you') : T('board.zimi')) : sideName(p); }

  // ── drawing ──
  function drawLines() {
    var h = '';
    function line(x1, y1, x2, y2) { h += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"/>'; }
    var i;
    for (i = 0; i < ROWS; i++) line(0.5, i + 0.5, COLS - 0.5, i + 0.5);
    for (i = 0; i < COLS; i++) line(i + 0.5, 0.5, i + 0.5, ROWS - 0.5);
    [0, 7].forEach(function (top) { line(3.5, top + 0.5, 5.5, top + 2.5); line(5.5, top + 0.5, 3.5, top + 2.5); });
    h += '<rect class="fat" x="0.5" y="0.5" width="8" height="9"/>';
    $('jg-lines').innerHTML = h;
  }
  function buildBoard() {
    els.grid.textContent = '';
    for (var d = 0; d < N; d++) {
      var c = document.createElement('button');
      c.type = 'button'; c.className = 'jg-pt'; c.dataset.d = d;
      c.addEventListener('click', onSquare);
      els.grid.appendChild(c); cells.push(c);
    }
    BK.gridNav(els.grid, cells, COLS, ROWS);
  }
  function pieceHtml(v) {
    var t = Math.abs(v), han = v < 0, chars = G.settings.labels === 'han';   // Characters, or pictures that need no language
    var cls = 'jg-pc ' + (han ? 'han' : 'cho') + (chars ? '' : ' icon') + (t === 7 ? ' k' : t === 1 ? ' p' : '');
    return '<span class="' + cls + '"><span>' + (chars ? HANJA[t][han ? 'h' : 'c'] : root.ZimiPieceIcons.figure(t)) + '</span></span>';
  }
  function fmtPoints(x) { return x % 1 ? x.toFixed(1) : String(x); }

  function paint() {
    var kingSq = E.inCheck(pos, pos.turn) ? pos.king[pos.turn === CHO ? 0 : 1] : -1;
    var open = !G.over && !G.thinking && G.human(turnIdx());
    for (var d = 0; d < N; d++) {
      var s = sqAt(d), c = cells[d], v = pos.sq[s], cls = 'jg-pt';
      if (lastMove && (s === E.from(lastMove) || s === E.to(lastMove))) cls += ' last';
      if (s === sel) cls += ' sel';
      if (s === kingSq) cls += ' bad';
      if (tip && (s === tip[0] || s === tip[1])) cls += ' tip';
      if (hintsOn() && targets.hasOwnProperty(s)) cls += ' hint' + (v ? ' cap' : '');
      c.className = cls;
      var html = v ? pieceHtml(v) : '';
      if (c.dataset.sig !== html) { c.innerHTML = html; c.dataset.sig = html; }
      var name = E.squareName(s), label = v ? T('chess.sq.piece', { sq: name, color: sideName(v > 0 ? 0 : 1), piece: T('janggi.piece.' + Math.abs(v)) }) : T(targets.hasOwnProperty(s) ? 'chess.sq.target' : 'chess.sq.empty', { sq: name });
      c.setAttribute('aria-label', s === sel ? T('chess.sq.selected', { label: label }) : label);
    }
    var pts = E.points(pos), names = G.names(sideName(0), sideName(1));
    score([names[0], names[1]], [fmtPoints(pts[0]), fmtPoints(pts[1]) + ' (+1.5)'], G.over ? -1 : turnIdx());
    els.pass.disabled = !open || E.inCheck(pos);
    els.flip.setAttribute('aria-pressed', String(flipped()));
    G.setUndo(played.length > 0); G.setHint(open);
  }

  // ── turns ──
  var WHY = { bikjang: 'janggi.why.bikjang', repetition: 'xiangqi.why.repetition', quiet: 'janggi.why.quiet' };
  function finish(st) {
    sel = -1; targets = {}; tip = null;
    var msg, out, name;
    if (st.result === 'mate') {
      var wi = st.winner === CHO ? 0 : 1;
      msg = T('chess.why.mate');
      out = G.vsComputer() ? (G.human(wi) ? 'w' : 'l') : null;
      name = sideName(wi);
    } else { msg = T(WHY[st.result]); out = G.vsComputer() ? 'd' : null; }
    G.finish(msg, out, name);
    paint();
  }

  function turnLine(st) {
    var p = turnIdx();
    if (st.mustPass) return G.human(p) ? T('janggi.mustPass') : T('janggi.passes', { name: sideName(p) });
    if (!G.vsComputer()) return T('board.toMove', { name: sideName(p) });
    return G.human(p) ? T('janggi.yourTurn', { side: sideName(p) }) : T('shell.thinking');
  }
  function afterMove(note) {
    sel = -1; targets = {}; tip = null;
    var st = E.status(pos, keys);
    if (st.over) { finish(st); return; }
    paint();
    var line = turnLine(st);
    G.say(note ? UI.noted(note, st.check ? T('chess.check', { line: line }) : line) : st.check ? T('chess.check', { line: line }) : line, !G.human(turnIdx()));
    if (!G.human(turnIdx())) computerTurn();
  }
  function play(m) {
    var who = nameOf(turnIdx()), text = E.san(pos, m);
    sans.push(text); played.push(m);
    var was = root.ZimiPieceIcons.snap(cells, sqAt, pos.sq);
    E.make(pos, m); keys.push(E.key(pos)); lastMove = m === PASS ? 0 : m;
    afterMove(m === PASS ? T('janggi.passed', { name: who }) : '');
    if (m !== PASS) root.ZimiPieceIcons.ghosts(was, cells, sqAt, pos.sq, E.from(m));
  }
  function seenCounts() { var seen = {}; keys.forEach(function (k) { seen[k] = (seen[k] || 0) + 1; }); return seen; }

  // The level our own engine plays at: the one chosen, or its best when Strong or Master were chosen and Fairy-Stockfish is not there.
  function jsLevel() { return F.wants(G.settings.level) ? 'hard' : G.settings.level; }
  function askLocal(token) {
    brain.ask({ cmd: 'move', fen: E.toFen(pos), level: jsLevel() }, function (r) {
      if (!G.done(token)) return;
      var legal = E.movesOrPass(pos), m = r && legal.indexOf(r.move) >= 0 ? r.move : legal[0];
      play(m);
    });
  }

  // Strong and Master: Fairy-Stockfish in its own Worker, started by the first move that needs it. If it cannot start, say so
  // once and play on with our own best level (jsLevel).
  function computerTurn() {
    var token = G.begin();
    paint();
    if (!F.wants(G.settings.level)) { askLocal(token); return; }
    F.ask('janggi', E, pos, played, G.settings.level, function (move, why) {
      if (!G.current(token)) return;
      if (move !== null) { G.done(token); play(move); return; }
      if (why === 'unavailable') G.say(T('board.fairyNote', { thinking: T('shell.thinking') }), true);
      askLocal(token);
    });
  }

  function hint() {
    var token = G.begin(); paint(); G.say(T('board.thinkingHint'), true);
    brain.ask({ cmd: 'move', fen: E.toFen(pos), level: 'hard', ms: HINT_MS }, function (r) {
      if (!G.done(token)) return;
      tip = r && r.move ? [E.from(r.move), E.to(r.move)] : null; paint();
      G.say(T(tip ? 'janggi.hint.move' : 'janggi.hint.pass'));
    });
  }

  // ── input ──
  function movesFrom(s) {
    var out = {};
    E.legalMoves(pos).forEach(function (m) { if (E.from(m) === s) out[E.to(m)] = true; });
    return out;
  }
  function onSquare(e) {
    if (G.over || G.thinking || !G.human(turnIdx())) return;
    var s = sqAt(+e.currentTarget.dataset.d), v = pos.sq[s];
    if (sel >= 0 && targets.hasOwnProperty(s)) { play(E.findMove(pos, sel, s)); return; }
    if (v * pos.turn > 0 && s !== sel) {
      sel = s; targets = movesFrom(s); tip = null;
      if (Object.keys(targets).length) G.say(G.vsComputer() ? T('board.chooseWhere') : T('board.toMove', { name: sideName(turnIdx()) }));
      else { sel = -1; G.refuse(e.currentTarget, T('chess.cantMove')); }
    } else { sel = -1; targets = {}; }
    paint();
  }
  function passNow() {
    if (G.over || G.thinking || !G.human(turnIdx()) || E.inCheck(pos)) return;
    play(PASS);
  }
  function undo() {
    if (!played.length) return;
    G.cancel(); G.over = false;
    do { E.unmake(pos); played.pop(); sans.pop(); keys.pop(); } while (played.length && G.vsComputer() && !G.human(turnIdx()));
    lastMove = played[played.length - 1] || 0;
    afterMove();
  }

  function newGame() {
    sel = -1; targets = {}; lastMove = 0; tip = null; manualFlip = false; F.cancel();
    pos = E.startPosition(); keys = [E.key(pos)]; sans = []; played = [];
    afterMove();
  }

  els.pass.addEventListener('click', passNow);
  els.flip.addEventListener('click', function () { manualFlip = !manualFlip; paint(); });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input')) return;
    var k = e.key.toLowerCase();
    if (k === 'f') { manualFlip = !manualFlip; paint(); } else if (k === 'p') passNow();
    else if (e.key === 'Escape' && sel >= 0) { sel = -1; targets = {}; paint(); }
  });

  if (root.ZimiShell) {
    root.ZimiShell.settings.on(function (k) { if (k === 'hints' || k === '*') paint(); });
    root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && played.length > 0; },
      help: function () { return { extra: [root.ZimiPieceIcons.key(T('shell.help.pieces'), [7, 6, 5, 4, 3, 2, 1].map(function (t) { return { html: pieceHtml(t), name: T('janggi.piece.' + t) }; }))] }; } });
  }
  drawLines(); buildBoard();
  G.newGame();
  G.persist({
    save: function () { return played.length ? { played: played.slice(), sans: sans.slice(), flip: manualFlip } : null; },
    load: function (d) {
      pos = E.startPosition(); keys = [E.key(pos)]; played = []; sans = d.sans.slice();
      d.played.forEach(function (m) { E.make(pos, m); played.push(m); keys.push(E.key(pos)); });
      lastMove = played[played.length - 1] || 0; sel = -1; targets = {}; tip = null; manualFlip = !!d.flip;
      paint();
    },
    resume: function () { afterMove(); }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__jg = { engine: E, pos: function () { return pos; }, play: play, usingWorker: function () { return brain.usingWorker(); },
      setFen: function (fen) { pos = E.parseFen(fen); keys = [E.key(pos)]; sans = []; played = []; lastMove = 0; G.over = false; afterMove(); }, seen: seenCounts };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
