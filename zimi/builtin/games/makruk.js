/* ZimiGames: Makruk (Thai chess), the page. The rules and the searcher are in makruk-engine.js, run in a
   Web Worker built from its own source (enginekit.js) with the main thread as the fallback. Our own code and
   drawn pieces, GPL-3.0. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiMakrukEngine || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var F = root.ZimiFairy, E = root.ZimiMakrukEngine(root.ZimiSearch()), brain = root.EngineKit.client(root.ZimiMakrukEngine, 300);
  var WHITE = E.WHITE, SIZE = E.SIZE, N = SIZE * SIZE, HINT_MS = 1500;
  function sideName(p) { return UI.side(p === 0 ? 'white' : 'black'); }
  var LEVEL_CHOICES = [['fairy', 'chess.level.fairy'], ['master', 'chess.level.master']];   // Strong and Master, when Fairy-Stockfish is there
  // Show legal moves is the shell's Hints setting (Menu > Settings), not a New game option.
  function hintsOn() { return !root.ZimiShell || root.ZimiShell.settings.get('hints') !== 'off'; }

  // ── the pieces, drawn on a 45 x 45 grid ──
  var BASE = '<rect class="body" x="10" y="37" width="25" height="4" rx="1.5"/>';
  var ART = {
    1: '<ellipse class="body" cx="22.5" cy="29" rx="10.5" ry="8"/><path class="line" d="M13.5 29h18M18 26l1 6M22.5 25.5v7M27 26l-1 6"/>',
    2: BASE + '<path class="body" d="M12 37C11 26 16 20 20 14L19 9l5 2c8 3 11 13 9 26z"/><circle cx="24.5" cy="17" r="1.3" class="eye"/><path class="line" d="M20 14c3 8 2 14-2 19"/>',
    3: BASE + '<path class="body" d="M22.5 8L31 21l2 16H12l2-16z"/><circle class="body" cx="22.5" cy="8" r="2.4"/><path class="line" d="M14 21h17M17 26l5.500 5 5.500-5"/>',
    4: BASE + '<path class="body" d="M22.5 14c4.5 6 8.5 12 9.5 23H13c1-11 5-17 9.5-23z"/><circle class="body" cx="22.5" cy="11" r="3.6"/><path class="line" d="M14.5 31h16"/>',
    5: BASE + '<path class="body" d="M12 37l2-16h-2.500V11H17v4h3.500v-4h4v4H28v-4h5.500v10H31l2 16z"/><path class="line" d="M14 21h17"/>',
    6: BASE + '<path class="body" d="M22.5 17c5.500 6 9.500 11 10.500 20H12c1-9 5-14 10.500-20z"/><path class="body" d="M16.500 15L18.500 6l4 4 4-4 2 9z"/><path class="line" d="M14 31h17"/>'
  };
  function pieceSvg(v) {
    var t = Math.abs(v);
    return '<svg class="mk-pc ' + (v > 0 ? 'w' : 'b') + '" viewBox="0 0 45 45" aria-hidden="true">' + ART[t] + '</svg>';
  }

  var G = WK.create({
    id: 'makruk',
    options: WK.standardOptions({ first: 'chess.side.white', second: 'board.black', levels: LEVEL_CHOICES }),
    onNew: newGame, onUndo: undo, onHint: hint
  });
  var score = WK.scoreBar($('wk-score'), [{ color: 'var(--mk-w)', border: 'var(--mk-w-line)' }, { color: 'var(--mk-b)', border: 'var(--mk-b-line)' }]);
  var board = $('mk-board'), flipBtn = $('mk-flip'), cells = [];
  var pos, keys, played, sel = -1, targets = {}, lastMove = 0, manualFlip = false, tip = null;

  function turnIdx() { return pos.turn === WHITE ? 0 : 1; }
  function flipped() { return manualFlip !== (G.vsComputer() && G.settings.side === 'second'); }
  function sqAt(d) { return flipped() ? N - 1 - d : d; }
  function nameOf(p) { return G.vsComputer() ? (G.human(p) ? T('board.you') : T('board.zimi')) : sideName(p); }
  function label(s) { return E.squareName(s); }

  function buildBoard() {
    board.textContent = '';
    for (var d = 0; d < N; d++) {
      var c = document.createElement('button');
      c.type = 'button'; c.dataset.d = d;
      c.addEventListener('click', onSquare);
      board.appendChild(c); cells.push(c);
    }
    BK.gridNav(board, cells, SIZE);
  }

  function paint() {
    var kingSq = E.inCheck(pos, pos.turn) ? pos.king[pos.turn === WHITE ? 0 : 1] : -1;
    var open = !G.over && !G.thinking && G.human(turnIdx());
    for (var d = 0; d < N; d++) {
      var s = sqAt(d), c = cells[d], v = pos.sq[s], r = d >> 3, f = d & 7, cls = 'bg-sq' + ((r + f) % 2 ? ' dk' : '');
      if (lastMove && (s === E.from(lastMove) || s === E.to(lastMove))) cls += ' last';
      if (s === sel) cls += ' sel';
      if (s === kingSq) cls += ' bad';
      if (tip && (s === tip[0] || s === tip[1])) cls += ' sel';
      if (hintsOn() && targets.hasOwnProperty(s)) cls += ' hint' + (v ? ' cap' : '');
      c.className = cls;
      var sig = (v || '') + '|' + (f === 0 ? 'r' : '') + (r === SIZE - 1 ? 'f' : '') + '|' + (flipped() ? 1 : 0);
      if (c.dataset.sig !== sig) {
        c.innerHTML = (v ? pieceSvg(v) : '') + (f === 0 ? '<span class="co r">' + label(s)[1] + '</span>' : '') + (r === SIZE - 1 ? '<span class="co f">' + label(s)[0] + '</span>' : '');
        c.dataset.sig = sig;
      }
      var name = label(s), text = v ? T('chess.sq.piece', { sq: name, color: sideName(v > 0 ? 0 : 1).toLowerCase(), piece: T('makruk.piece.' + Math.abs(v)) }) : T(targets.hasOwnProperty(s) ? 'chess.sq.target' : 'chess.sq.empty', { sq: name });
      c.setAttribute('aria-label', s === sel ? T('chess.sq.selected', { label: text }) : text);
    }
    var count = [0, 0];
    for (var s2 = 0; s2 < N; s2++) if (pos.sq[s2]) count[pos.sq[s2] > 0 ? 0 : 1]++;
    var names = G.names(sideName(0), sideName(1));
    score(names, count, G.over ? -1 : turnIdx());
    flipBtn.setAttribute('aria-pressed', String(flipped()));
    G.setUndo(played.length > 0); G.setHint(open);
  }

  var WHY = { stalemate: 'makruk.why.stalemate', repetition: 'xiangqi.why.repetition', limit: 'makruk.why.limit' };
  function finish(st) {
    sel = -1; targets = {}; tip = null;
    var msg, out, name;
    if (st.result === 'mate') {
      var wi = st.winner === WHITE ? 0 : 1;
      msg = T('chess.why.mate');
      out = G.vsComputer() ? (G.human(wi) ? 'w' : 'l') : null;
      name = sideName(wi);
    } else { msg = T(WHY[st.result]); out = G.vsComputer() ? 'd' : null; }
    G.finish(msg, out, name);
    paint();
  }
  function afterMove(note) {
    sel = -1; targets = {}; tip = null;
    var st = E.status(pos, keys), p = turnIdx();
    if (st.over) { finish(st); return; }
    paint();
    var line = !G.vsComputer() ? T('board.toMove', { name: sideName(p) }) : G.human(p) ? T('makruk.yourTurn', { side: sideName(p).toLowerCase() }) : T('shell.thinking');
    if (st.check) line = T('chess.check', { line: line });
    G.say(note ? UI.noted(note, line) : line, !G.human(p));
    if (!G.human(p)) computerTurn();
  }
  function play(m) {
    var who = nameOf(turnIdx()), text = E.san(pos, m);
    played.push(m);
    var was = root.ZimiPieceIcons.snap(cells, sqAt, pos.sq);
    E.make(pos, m); keys.push(E.key(pos)); lastMove = m;
    afterMove(T(G.vsComputer() ? 'makruk.played' : 'makruk.playedTwo', { name: who, move: text + (E.isPromo(m) ? T('makruk.promoted') : '') }));
    root.ZimiPieceIcons.ghosts(was, cells, sqAt, pos.sq, E.from(m));
  }

  // The level our own engine plays at: the one chosen, or its best when Strong or Master were chosen and Fairy-Stockfish is not there.
  function jsLevel() { return F.wants(G.settings.level) ? 'hard' : G.settings.level; }
  function askLocal(token) {
    brain.ask({ cmd: 'move', fen: E.toFen(pos), level: jsLevel() }, function (r) {
      if (!G.done(token)) return;
      var legal = E.legalMoves(pos);
      play(r && legal.indexOf(r.move) >= 0 ? r.move : legal[0]);
    });
  }

  // Strong and Master: Fairy-Stockfish in its own Worker, started by the first move that needs it. If it cannot start, say so
  // once and play on with our own best level (jsLevel).
  function computerTurn() {
    var token = G.begin();
    paint();
    if (!F.wants(G.settings.level)) { askLocal(token); return; }
    F.ask('makruk', E, pos, played, G.settings.level, function (move, why) {
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
      G.say(tip ? T('makruk.hint', { move: E.san(pos, r.move) }) : T('board.noHint'));
    });
  }

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
      if (Object.keys(targets).length) G.say(T('board.chooseWhere'));
      else { sel = -1; G.refuse(e.currentTarget, T('chess.cantMove')); }
    } else { sel = -1; targets = {}; }
    paint();
  }
  function undo() {
    if (!played.length) return;
    G.cancel(); G.over = false;
    do { E.unmake(pos); played.pop(); keys.pop(); } while (played.length && G.vsComputer() && !G.human(turnIdx()));
    lastMove = played[played.length - 1] || 0;
    afterMove();
  }
  function newGame() {
    sel = -1; targets = {}; lastMove = 0; tip = null; manualFlip = false; F.cancel();
    pos = E.startPosition(); keys = [E.key(pos)]; played = [];
    afterMove();
  }

  flipBtn.addEventListener('click', function () { manualFlip = !manualFlip; paint(); });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input')) return;
    if (e.key.toLowerCase() === 'f') { manualFlip = !manualFlip; paint(); }
    else if (e.key === 'Escape' && sel >= 0) { sel = -1; targets = {}; paint(); }
  });

  if (root.ZimiShell) {
    root.ZimiShell.settings.on(function (k) { if (k === 'hints' || k === '*') paint(); });
    root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && played.length > 0; },
      help: function () { return { extra: [root.ZimiPieceIcons.key(T('shell.help.pieces'), [6, 4, 5, 3, 2, 1].map(function (t) { return { html: pieceSvg(t), name: T('makruk.piece.' + t) }; }))] }; } });
  }
  buildBoard();
  G.newGame();
  G.persist({
    save: function () { return played.length ? { played: played.slice(), flip: manualFlip } : null; },
    load: function (d) {
      pos = E.startPosition(); keys = [E.key(pos)]; played = [];
      d.played.forEach(function (m) { E.make(pos, m); played.push(m); keys.push(E.key(pos)); });
      lastMove = played[played.length - 1] || 0; sel = -1; targets = {}; tip = null; manualFlip = !!d.flip;
      paint();
    },
    resume: function () { afterMove(); }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__mk = { engine: E, pos: function () { return pos; }, play: play, usingWorker: function () { return brain.usingWorker(); },
      setFen: function (fen) { pos = E.parseFen(fen); keys = [E.key(pos)]; played = []; lastMove = 0; G.over = false; afterMove(); } };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
