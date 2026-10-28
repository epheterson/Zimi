/* ZimiGames: Xiangqi, the page. The rules and the searcher are in xiangqi-engine.js (run in a Web Worker built from its own
   source, with the main thread as the fallback, through enginekit.js). Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiXiangqiEngine || !root.BoardUI) return;
  var F = root.ZimiFairy, WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var E = root.ZimiXiangqiEngine(root.ZimiSearch()), brain = root.EngineKit.client(root.ZimiXiangqiEngine, 250);
  var RED = E.RED, BLACK = E.BLACK, COLS = E.COLS, ROWS = E.ROWS, N = COLS * ROWS;
  var COMPUTER_DELAY_MS = 250;
  var HAN = { 1: { r: '兵', b: '卒' }, 2: { r: '炮', b: '砲' }, 3: { r: '俥', b: '車' }, 4: { r: '傌', b: '馬' }, 5: { r: '相', b: '象' }, 6: { r: '仕', b: '士' }, 7: { r: '帥', b: '將' } };
  // Show legal moves is the shell's Hints setting (Menu > Settings), not a New game option.
  function hintsOn() { return !root.ZimiShell || root.ZimiShell.settings.get('hints') !== 'off'; }

  var G = WK.create({
    id: 'xiangqi',
    options: WK.standardOptions({ base: WK.CLASSIC_LEVELS, levelDef: 'club', first: 'xiangqi.side.red', second: 'board.black' }).concat([{ key: 'labels', legend: 'xiangqi.pieces', def: root.ZimiText && root.ZimiText.lang === 'zh' ? 'han' : 'icons', choices: [['han', 'xiangqi.pieces.han'], ['icons', 'xiangqi.pieces.icons']] }]),
    onNew: newGame, onUndo: undo
  });
  var els = { grid: $('xq-grid'), moves: $('xq-moves'), flip: $('xq-flip') };
  var cells = [], pos, keys, sans, played, sel = -1, targets = {}, lastMove = 0, manualFlip = false;

  function turnIdx() { return pos.turn === RED ? 0 : 1; }
  function flipped() { return manualFlip !== (G.vsComputer() && G.settings.side === 'second'); }
  function sqAt(d) { return flipped() ? N - 1 - d : d; }
  function colorName(c) { return UI.side(c === RED ? 'red' : 'black'); }
  // The level our own engine plays at: the one chosen, or its best when Strong or Master were chosen and Fairy-Stockfish is not there.
  function engineLevel() { return F.wants(G.settings.level) ? 'strong' : G.settings.level; }

  // ── drawing ──
  function drawLines() {
    var h = '', i;
    function line(x1, y1, x2, y2, cls) { h += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"' + (cls ? ' class="' + cls + '"' : '') + '/>'; }
    for (i = 0; i < ROWS; i++) line(0.5, i + 0.5, COLS - 0.5, i + 0.5);
    line(0.5, 0.5, 0.5, ROWS - 0.5); line(COLS - 0.5, 0.5, COLS - 0.5, ROWS - 0.5);
    for (i = 1; i < COLS - 1; i++) { line(i + 0.5, 0.5, i + 0.5, 4.5); line(i + 0.5, 5.5, i + 0.5, ROWS - 0.5); }
    [[0.5, 3.5], [7.5, 3.5]].forEach(function (p) { line(p[1], p[0], p[1] + 2, p[0] + 2); line(p[1] + 2, p[0], p[1], p[0] + 2); });
    // the little ticks that mark the soldiers' and cannons' points
    var marks = [[2, 1], [2, 7], [3, 0], [3, 2], [3, 4], [3, 6], [3, 8], [6, 0], [6, 2], [6, 4], [6, 6], [6, 8], [7, 1], [7, 7]];
    marks.forEach(function (m) {
      var x = m[1] + 0.5, y = m[0] + 0.5, a = 0.09, b = 0.22;
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (d) {
        if ((m[1] === 0 && d[0] < 0) || (m[1] === COLS - 1 && d[0] > 0)) return;
        line(x + d[0] * a, y + d[1] * a, x + d[0] * a, y + d[1] * b, 'mark'); line(x + d[0] * a, y + d[1] * a, x + d[0] * b, y + d[1] * a, 'mark');
      });
    });
    h += '<rect class="fat" x="0.5" y="0.5" width="8" height="9"/>';
    $('xq-lines').innerHTML = h;
  }

  function buildBoard() {
    els.grid.textContent = '';
    for (var d = 0; d < N; d++) {
      var c = document.createElement('button');
      c.type = 'button'; c.className = 'xq-pt'; c.dataset.d = d;
      c.addEventListener('click', onSquare);
      els.grid.appendChild(c); cells.push(c);
    }
    BK.gridNav(els.grid, cells, COLS, ROWS);
  }

  function pieceHtml(v) {
    var t = Math.abs(v), red = v > 0, han = G.settings.labels === 'han';   // Characters, or pictures that need no language
    return '<span class="xq-pc ' + (red ? 'r' : 'b') + (han ? '' : ' icon') + '"><span>' + (han ? HAN[t][red ? 'r' : 'b'] : root.ZimiPieceIcons.figure(t)) + '</span></span>';
  }
  // The river is named in the characters' own words only when the pieces are written in them.
  function paintRiver() {
    var han = G.settings.labels === 'han';
    $('xq-river-l').textContent = han ? '楚河' : T('xiangqi.river'); $('xq-river-r').textContent = han ? '漢界' : '';
  }

  function paint() {
    var kingSq = E.inCheck(pos, pos.turn) ? pos.king[turnIdx()] : -1;
    for (var d = 0; d < N; d++) {
      var s = sqAt(d), c = cells[d], v = pos.sq[s], cls = 'xq-pt';
      if (lastMove && (s === E.from(lastMove) || s === E.to(lastMove))) cls += ' last';
      if (s === sel) cls += ' sel';
      if (s === kingSq) cls += ' bad';
      if (hintsOn() && targets.hasOwnProperty(s)) cls += ' hint' + (v ? ' cap' : '');
      c.className = cls;
      var html = v ? pieceHtml(v) : '';
      if (c.dataset.sig !== html) { c.innerHTML = html; c.dataset.sig = html; }
      var name = E.squareName(s), label = v ? T('chess.sq.piece', { sq: name, color: colorName(v > 0 ? RED : BLACK).toLowerCase(), piece: T('xiangqi.piece.' + Math.abs(v)) }) : T(targets.hasOwnProperty(s) ? 'chess.sq.target' : 'chess.sq.empty', { sq: name });
      c.setAttribute('aria-label', s === sel ? T('chess.sq.selected', { label: label }) : label);
    }
    G.setUndo(played.length > 0);
    els.flip.setAttribute('aria-pressed', String(manualFlip));
  }

  function paintMoves() {
    var html = '';
    for (var i = 0; i < sans.length; i++) {
      if (i % 2 === 0) html += '<span class="xq-n">' + (i / 2 + 1) + '.</span>';
      html += '<span class="xq-m' + (i === sans.length - 1 ? ' now' : '') + '">' + sans[i] + '</span>';
    }
    els.moves.innerHTML = html;
    els.moves.scrollTop = els.moves.scrollHeight;
  }

  // ── turns ──
  var WHY = { repetition: 'xiangqi.why.repetition', sixty: 'xiangqi.why.sixty' };
  function finish(st) {
    sel = -1; targets = {};
    var msg, out, name;
    if (st.result === 'mate') {
      var wi = st.winner === RED ? 0 : 1;
      msg = T(st.check ? 'chess.why.mate' : 'xiangqi.why.stuck');
      out = G.vsComputer() ? (G.human(wi) ? 'w' : 'l') : null;
      name = colorName(st.winner);
    } else { msg = T(WHY[st.result]); out = 'd'; }
    G.finish(msg, out, name);
    paint();
  }

  function afterMove() {
    sel = -1; targets = {};
    var st = E.status(pos, keys);
    paintMoves();
    if (st.over) { finish(st); return; }
    paint();
    var human = G.human(turnIdx()), line = !G.vsComputer() ? T('board.toMove', { name: colorName(pos.turn) }) : human ? T('board.yourTurn') : T('shell.thinking');
    G.say(st.check ? T('chess.check', { line: line }) : line, !human);
    if (!human) computerTurn();
  }

  function play(m) {
    sans.push(E.san(pos, m)); played.push(m);
    var was = root.ZimiPieceIcons.snap(cells, sqAt, pos.sq);
    E.make(pos, m); keys.push(E.key(pos)); lastMove = m;
    afterMove();
    root.ZimiPieceIcons.ghosts(was, cells, sqAt, pos.sq, E.from(m));
  }

  function seenCounts() {
    var seen = {};
    keys.forEach(function (k) { seen[k] = (seen[k] || 0) + 1; });
    return seen;
  }

  // ── the computer: a worker if there is one, the main thread if there is not ──
  function askLocal(token) {
    var level = engineLevel();
    brain.ask({ fen: E.toFen(pos), level: level, seen: seenCounts() }, function (r) {
      if (!G.done(token)) return;
      if (r && r.move) play(r.move); else afterMove();
    }, E.LEVELS[level].ms);
  }

  // Strong and Master: Fairy-Stockfish in its own Worker, started by the first move that needs it. If it cannot start,
  // say so once and play on with our own best level (engineLevel).
  function computerTurn() {
    var token = G.begin();
    paint();
    setTimeout(function () {
      if (!G.current(token)) return;
      if (!F.wants(G.settings.level)) { askLocal(token); return; }
      F.ask('xiangqi', E, pos, played, G.settings.level, function (move, why) {
        if (!G.current(token)) return;
        if (move) { G.done(token); play(move); return; }
        if (why === 'unavailable') G.say(T('board.fairyNote', { thinking: T('shell.thinking') }), true);
        askLocal(token);
      });
    }, COMPUTER_DELAY_MS);
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
      sel = s; targets = movesFrom(s);
      if (!Object.keys(targets).length) { sel = -1; G.refuse(e.currentTarget, T('chess.cantMove')); }
      else G.say(!G.vsComputer() ? T('board.toMove', { name: colorName(pos.turn) }) : T('board.chooseWhere'));
    } else { sel = -1; targets = {}; }
    paint();
  }

  function undo() {
    if (!played.length || G.thinking) return;
    G.cancel(); G.over = false;
    do {
      E.unmake(pos); played.pop(); sans.pop(); keys.pop();
    } while (played.length && G.vsComputer() && !G.human(turnIdx()));
    lastMove = played[played.length - 1] || 0;
    afterMove();
  }

  function newGame() {
    paintRiver(); sel = -1; targets = {}; lastMove = 0; manualFlip = false; F.cancel();
    pos = E.startPosition(); keys = [E.key(pos)]; sans = []; played = [];
    paintMoves(); paint();
    afterMove();
  }

  // ── keys ──
  els.flip.addEventListener('click', function () { manualFlip = !manualFlip; paint(); });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input')) return;
    if (e.key.toLowerCase() === 'f') { manualFlip = !manualFlip; paint(); }
    else if (e.key === 'Escape' && sel >= 0) { sel = -1; targets = {}; paint(); }
  });

  if (root.ZimiShell) {
    root.ZimiShell.settings.on(function (k) { if (k === 'hints' || k === '*') paint(); });
    root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && played.length > 0; },
      help: function () { return { extra: [root.ZimiPieceIcons.key(T('shell.help.pieces'), [7, 6, 5, 4, 3, 2, 1].map(function (t) { return { html: pieceHtml(t), name: T('xiangqi.piece.' + t) }; }))] }; } });
  }

  drawLines(); buildBoard();
  G.newGame();
  // Leaving and coming back: the settings in force and the end are kept by WorldKit; the moves are played again from the start.
  G.persist({
    save: function () { return played.length ? { played: played.slice(), flip: manualFlip } : null; },
    load: function (d) {
      pos = E.startPosition(); keys = [E.key(pos)]; sans = []; played = [];
      d.played.forEach(function (m) { sans.push(E.san(pos, m)); played.push(m); E.make(pos, m); keys.push(E.key(pos)); });
      lastMove = played[played.length - 1] || 0; manualFlip = !!d.flip; sel = -1; targets = {};
      paintMoves(); paint(); paintRiver();
    },
    resume: function () { afterMove(); }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__xq = { finish: finish, engine: E, pos: function () { return pos; }, settings: G.settings, play: play,
      setFen: function (fen) { pos = E.parseFen(fen); keys = [E.key(pos)]; sans = []; played = []; lastMove = 0; G.over = false; afterMove(); }, usingWorker: function () { return brain.usingWorker(); }, noWorker: function () { brain.drop(); } };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
