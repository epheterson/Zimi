/* ZimiGames: Chess, the page. The rules and the searcher are in chess-engine.js (run in a Web Worker built from its own
   source, with the main thread as the fallback, through enginekit.js). Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiChessEngine || !root.ZimiChessPieces || !root.BoardUI) return;
  var F = root.ZimiFairy, WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var E = root.ZimiChessEngine(root.ZimiSearch()), brain = root.EngineKit.client(root.ZimiChessEngine, 250);
  var WHITE = E.WHITE, BLACK = E.BLACK;
  var COMPUTER_DELAY_MS = 400, HINT_MS = 700;
  // Show legal moves is the shell's Hints setting (Menu > Settings), not a New game option.
  function hintsOn() { return !root.ZimiShell || root.ZimiShell.settings.get('hints') !== 'off'; }

  // 'strong' is shown as Advanced and 'fairy' as Strong (WK.CLASSIC_LEVELS).
  var G = WK.create({
    id: 'chess',
    options: WK.standardOptions({ base: WK.CLASSIC_LEVELS, levelDef: 'club', first: 'chess.side.white', second: 'board.black' }),
    onNew: newGame, onUndo: undo, onHint: hint
  });
  var els = { board: $('cs-board'), moves: $('cs-moves'), opening: $('cs-opening'), flip: $('cs-flip'), capsTop: $('cs-caps-top'), capsBot: $('cs-caps-bot'), capsHtml: {} };
  var cells = [], pos, keys, sans, played, sel = -1, targets = {}, lastMove = 0, manualFlip = false, note = '', cue = null, glide = null, dragged = false;

  function turnIdx() { return pos.turn === WHITE ? 0 : 1; }
  function flipped() { return manualFlip !== (G.vsComputer() && G.settings.side === 'second'); }
  // The level our own engine plays at: the one chosen, or its best when Strong or Master were chosen and Fairy-Stockfish is not there.
  function engineLevel() { return F.wants(G.settings.level) ? 'strong' : G.settings.level; }
  function colorName(c) { return UI.side(c === WHITE ? 'white' : 'black'); }

  // ── drawing ──
  function pieceSvg(t, color) {
    return root.ZimiChessPieces.svg(t, color === WHITE);
  }

  function buildBoard() {
    els.board.textContent = '';
    cells = [];
    for (var d = 0; d < 64; d++) {
      var c = document.createElement('button');
      c.type = 'button'; c.className = 'bg-sq'; c.dataset.d = d;
      c.addEventListener('click', onSquare);
      els.board.appendChild(c); cells.push(c);
    }
    BK.gridNav(els.board, cells, 8);
    BK.dragPieces(els.board, cells, {
      grab: function (i) { if (sel !== sqAt(i)) onSquare({ currentTarget: cells[i] }); },
      drop: function (i) { if (targets.hasOwnProperty(sqAt(i))) { dragged = true; onSquare({ currentTarget: cells[i] }); } }
    });
  }
  function sqAt(d) { return flipped() ? 63 - d : d; }

  function paint() {
    var kingSq = E.inCheck(pos) ? pos.king[turnIdx()] : -1;
    for (var d = 0; d < 64; d++) {
      var s = sqAt(d), c = cells[d], v = pos.sq[s], cls = 'bg-sq' + (((s >> 3) + (s & 7)) % 2 ? ' dk' : '');
      if (lastMove && (s === E.from(lastMove) || s === E.to(lastMove))) cls += ' last';
      if (s === sel || (cue && s === cue.from)) cls += ' sel';
      if (s === kingSq) cls += ' bad';
      if ((hintsOn() && targets.hasOwnProperty(s)) || (cue && s === cue.to)) cls += ' hint' + (v || targets[s] ? ' cap' : '');
      c.className = cls;
      var html = v ? pieceSvg(Math.abs(v), v > 0 ? WHITE : BLACK) : '';
      var edge = '';
      if ((d >> 3) === 7) edge += '<i class="cs-co f">' + 'abcdefgh'[s & 7] + '</i>';
      if ((d & 7) === 0) edge += '<i class="cs-co r">' + (8 - (s >> 3)) + '</i>';
      var sig = html + edge;
      if (c.dataset.sig !== sig) { c.innerHTML = sig; c.dataset.sig = sig; }
      var name = E.squareName(s), label = v ? T('chess.sq.piece', { sq: name, color: colorName(v > 0 ? WHITE : BLACK).toLowerCase(), piece: T('chess.piece.' + Math.abs(v)) }) : T(targets.hasOwnProperty(s) ? 'chess.sq.target' : 'chess.sq.empty', { sq: name });
      c.setAttribute('aria-label', s === sel ? T('chess.sq.selected', { label: label }) : label);
    }
    paintCaps();
    if (glide) { BK.slide(cells[sqAt(glide[0])], cells[sqAt(glide[1])]); glide = null; }
    G.setUndo(played.length > 0);
    G.setHint(!G.over && !G.watching && G.human(turnIdx()));
    els.flip.setAttribute('aria-pressed', String(manualFlip));
  }

  // The strips over and under the board: whose side it is, what that side has taken (a pawn..queen icon each, biggest first)
  // and its lead in pawns.
  function paintCaps() {
    var bottom = (flipped() ? BLACK : WHITE), top = -bottom, lead = E.takenFrom(pos, top).worth - E.takenFrom(pos, bottom).worth;
    var names = G.names(colorName(WHITE), colorName(BLACK));
    [[els.capsBot, bottom, lead], [els.capsTop, top, -lead]].forEach(function (c) {
      var gone = E.takenFrom(pos, -c[1]), html = '<span class="bg-who">' + names[c[1] === WHITE ? 0 : 1] + '</span>', prev = 0;
      gone.list.forEach(function (t) { html += pieceSvg(t, -c[1]).replace('class="', 'class="' + (prev && prev !== t ? 'gap ' : '')); prev = t; });
      if (c[2] > 0) html += '<b>+' + c[2] + '</b>';
      if (els.capsHtml[c[0].id] !== html) { c[0].innerHTML = html; els.capsHtml[c[0].id] = html; }
    });
  }

  // The opening's name: the data (data/chess-openings.js, lichess-org/chess-openings, CC0) loads once a game has a move,
  // after the page is up, and its index is built in a later task so a move never waits on it.
  var openingIndex = null, openingRequested = false;
  function paintOpening() {
    if (!openingIndex) return;
    var o = root.ZimiChessContent.openingFor(openingIndex, keys);
    els.opening.textContent = o ? o.eco + ' \u00b7 ' + o.name : '';
  }
  function wantOpenings() {
    if (openingRequested || !sans.length || !root.ZimiChessContent) return;
    openingRequested = true;
    var s = document.createElement('script');
    s.src = 'data/chess-openings.js';
    s.onload = function () { setTimeout(function () { openingIndex = root.ZimiChessContent.openingIndex(E, root.ZimiChessOpenings.rows); paintOpening(); }, 0); };
    document.head.appendChild(s);
  }
  function paintMoves() {
    var html = '';
    for (var i = 0; i < sans.length; i++) {
      if (i % 2 === 0) html += '<span class="cs-n">' + (i / 2 + 1) + '.</span>';
      html += '<span class="cs-m' + (i === sans.length - 1 ? ' now' : '') + '">' + sans[i] + '</span> ';
    }
    els.moves.innerHTML = html;
    els.moves.scrollLeft = els.moves.scrollWidth; els.moves.scrollTop = els.moves.scrollHeight;
    els.opening.textContent = '';
    wantOpenings(); paintOpening();
  }

  // ── turns ──
  var WHY = { stalemate: 'chess.why.stalemate', repetition: 'chess.why.repetition', fifty: 'chess.why.fifty', material: 'chess.why.material' };
  function finish(st) {
    sel = -1; targets = {};
    var msg, out, name;
    if (st.result === 'mate') {
      var wi = st.winner === WHITE ? 0 : 1;
      msg = T('chess.why.mate');
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
    var human = G.human(turnIdx()), line = G.watching || !G.vsComputer() ? T('board.toMove', { name: colorName(pos.turn) }) : human ? T('board.yourTurn') : T('shell.thinking');
    if (st.check) line = T('chess.check', { line: line });
    if (note && human) line = UI.noted(note, line);
    note = '';
    G.say(line, !human && !G.watching);
    G.turnTimer(human, timeUp, played.length);
    if (!human) computerTurn();
  }

  // What the computer just did, in words, ahead of the next line.
  function computerNote(m, san) {
    if (pos.sq[E.to(m)] || (E.flag(m) & 1)) return T('chess.cpu.took', { sq: E.squareName(E.to(m)) });
    return T(E.flag(m) & 2 ? 'chess.cpu.castled' : 'chess.cpu.played', { move: san });
  }

  function play(m) {
    var san = E.san(pos, m);
    note = G.vsComputer() && !G.watching && !G.human(turnIdx()) ? computerNote(m, san) : '';
    sans.push(san); played.push(m);
    glide = dragged ? null : [E.from(m), E.to(m)]; dragged = false; cue = null;
    E.make(pos, m); keys.push(E.key(pos)); lastMove = m;
    afterMove();
  }

  function seenCounts() {
    var seen = {};
    keys.forEach(function (k) { seen[k] = (seen[k] || 0) + 1; });
    return seen;
  }

  // ── the computer: a worker if there is one, the main thread if there is not ──
  function answer(token, move, score) {
    if (!G.done(token)) return;
    if (!move) { afterMove(); return; }
    var watching = G.watching;
    if (!watching) { play(move); return; }
    // Watch and learn: say why, then play it when the driver says so.
    var why = root.ZimiExplain.chess(E, pos, move, { score: score, ply: played.length });
    watching.offer(why.text, function () { if (G.watching === watching && !G.over) play(move); });
  }
  function askLocal(token) {
    var level = engineLevel();
    brain.ask({ fen: E.toFen(pos), level: level, seen: seenCounts() }, function (r) { answer(token, r && r.move, r && r.score); }, E.LEVELS[level].ms);
  }

  // Strong and Master: Fairy-Stockfish in its own Worker, started by the first move that needs it. If it cannot start,
  // say so once and play on with our own best level (engineLevel).
  function computerTurn() {
    var token = G.begin();
    paint();
    setTimeout(function () {
      if (!G.current(token)) return;
      if (!F.wants(G.settings.level)) { askLocal(token); return; }
      F.ask('chess', E, pos, played, G.settings.level, function (move, why) {
        if (!G.current(token)) return;
        if (move) { answer(token, move); return; }
        if (why === 'unavailable') G.say(T('board.fairyNote', { thinking: T('shell.thinking') }), true);
        askLocal(token);
      });
    }, COMPUTER_DELAY_MS);
  }

  // ── input ──
  function movesFrom(s) {
    var out = {};
    E.legalMoves(pos).forEach(function (m) { if (E.from(m) === s) out[E.to(m)] = !!(pos.sq[E.to(m)] || (E.flag(m) & 1)); });
    return out;
  }
  function onSquare(e) {
    if (G.over || G.thinking || !G.human(turnIdx())) return;
    var s = sqAt(+e.currentTarget.dataset.d), v = pos.sq[s];
    if (sel >= 0 && targets.hasOwnProperty(s)) {
      var cands = E.legalMoves(pos).filter(function (m) { return E.from(m) === sel && E.to(m) === s; });
      if (cands.length > 1) { askPromotion(cands); return; }
      play(cands[0]); return;
    }
    if (v * pos.turn > 0 && s !== sel) {
      sel = s; cue = null; targets = movesFrom(s);
      if (!Object.keys(targets).length) { var stuck = sel; sel = -1; G.refuse(e.currentTarget, whyStuck(stuck)); }
      else G.say(!G.vsComputer() ? T('board.toMove', { name: colorName(pos.turn) }) : T('board.chooseWhere'));
    } else {
      if (sel >= 0) { G.refuse(e.currentTarget, whyNot(sel, s)); }
      sel = -1; targets = {};
    }
    paint();
  }

  function movesOf(from) { return E.pseudoMoves(pos).filter(function (m) { return E.from(m) === from; }); }
  // Why a piece has nowhere to go: it is tied to the king, or it is simply boxed in.
  function whyStuck(from) {
    return !movesOf(from).length ? T('chess.cantMove') : E.inCheck(pos) ? T('chess.no.inCheck') : T('chess.no.pinned');
  }
  // Why the selected piece cannot go to s: it would leave the king in check, or it does not move that way.
  function whyNot(from, to) {
    var piece = Math.abs(pos.sq[from]);
    var pseudo = movesOf(from).some(function (m) { return E.to(m) === to; });
    if (pseudo) return T(piece === E.K ? 'chess.no.kingCheck' : E.inCheck(pos) ? 'chess.no.inCheck' : 'chess.no.pinned');
    return T('chess.no.way', { piece: T('chess.piece.' + piece) });
  }

  // Hint: the engine's choice, the piece first, then where it goes.
  function hint() {
    if (G.over || G.thinking || !G.human(turnIdx())) return;
    if (cue && cue.to < 0) { cue.to = E.to(cue.move); G.say(T('chess.hint.move', { piece: T('chess.piece.' + Math.abs(pos.sq[cue.from])), sq: E.squareName(cue.to) })); paint(); return; }
    var token = G.begin(); G.say(T('board.thinkingHint'), true); paint();
    brain.ask({ fen: E.toFen(pos), level: 'club', seen: seenCounts() }, function (r) {
      if (!G.done(token)) return;
      if (!r || !r.move) { G.say(T('board.yourTurn')); paint(); return; }
      sel = -1; targets = {};
      cue = { move: r.move, from: E.from(r.move), to: -1 };
      G.say(T('chess.hint.piece', { piece: T('chess.piece.' + Math.abs(pos.sq[cue.from])), sq: E.squareName(cue.from) })); paint();
    }, HINT_MS);
  }

  // The pawn reaches the far rank: a sheet of the four pieces it can become, in the colour of whoever is promoting.
  var promoSheet = null;
  function askPromotion(cands) {
    var box = UI.h('div', { class: 'cs-promo-choices' });
    [E.Q, E.R, E.B, E.N].forEach(function (t) {
      if (!cands.some(function (x) { return E.promo(x) === t; })) return;
      var b = UI.h('button', { class: 'ar-btn cs-promo-btn', type: 'button', 'aria-label': T('chess.piece.' + t) });
      b.innerHTML = pieceSvg(t, pos.turn) + '<span>' + T('chess.piece.' + t) + '</span>';
      b.addEventListener('click', function () {
        var m = cands.filter(function (x) { return E.promo(x) === t; })[0];
        promoSheet.close();
        if (m) play(m);
      });
      box.appendChild(b);
    });
    promoSheet = root.ZimiShell.sheet({ title: T('chess.promote'), body: [box] });
  }

  // The move timer ran out: the computer's quickest choice is played for the person.
  function timeUp() {
    if (G.over || G.thinking || !G.human(turnIdx())) return;
    if (promoSheet) promoSheet.close();
    var r = E.think(pos, { level: 'beginner', ms: 80, depth: 1, seen: seenCounts() });
    if (!r.move) return;
    G.say(T('board.timeUp'));
    play(r.move);
  }

  function undo() {
    if (!played.length || G.thinking || G.watching) return;
    G.cancel(); G.over = false; cue = null; note = '';
    do {
      E.unmake(pos); played.pop(); sans.pop(); keys.pop();
    } while (played.length && G.vsComputer() && !G.human(turnIdx()));
    lastMove = played[played.length - 1] || 0;
    afterMove();
  }

  function newGame() {
    sel = -1; targets = {}; lastMove = 0; manualFlip = false; cue = null; note = ''; glide = null; F.cancel();
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

  if (root.ZimiShell) root.ZimiShell.settings.on(function (k) { if (k === 'hints' || k === '*') paint(); });
  if (root.ZimiShell) root.ZimiShell.game({ moveTimer: true, hints: true, inProgress: function () { return !G.over && played.length > 0; } });
  G.registerWatch({
    script: 'explain-chess.js', intro: 'chess.watch.intro', level: 'club',
    whoseTurn: turnIdx,
    resume: function () { manualFlip = false; afterMove(); }   // takeover: play on from here as the side to move
  });

  buildBoard();
  G.newGame();
  // Leaving and coming back: the settings in force and the end are kept by WorldKit; the moves are played again from the start.
  G.persist({
    save: function () { return played.length ? { played: played.slice(), flip: manualFlip } : null; },
    load: function (d) {
      pos = E.startPosition(); keys = [E.key(pos)]; sans = []; played = [];
      d.played.forEach(function (m) { sans.push(E.san(pos, m)); played.push(m); E.make(pos, m); keys.push(E.key(pos)); });
      lastMove = played[played.length - 1] || 0; manualFlip = !!d.flip; sel = -1; targets = {};
      paintMoves(); paint();
    },
    resume: function () { afterMove(); }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__cs = { engine: E, pos: function () { return pos; }, settings: G.settings, play: play,
      setFen: function (fen) { pos = E.parseFen(fen); keys = [E.key(pos)]; sans = []; played = []; lastMove = 0; G.over = false; afterMove(); }, usingWorker: function () { return brain.usingWorker(); }, noWorker: function () { brain.drop(); } };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
