/* ZimiGames: Shogi and Minishogi, the page. The rules and the searcher are in shogi-engine.js (run in a Web Worker built from
   its own source, with the main thread as the fallback, through enginekit.js). Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiShogiEngine || !root.BoardUI) return;
  var F = root.ZimiFairy, WK = root.WorldKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var BK = root.BoardKit;
  var COMPUTER_DELAY_MS = 250, FALLBACK_DEPTH = 2;
  var KANJI = { 1: '歩', 2: '香', 3: '桂', 4: '銀', 5: '金', 6: '角', 7: '飛', 8: '玉', 9: 'と', 10: '杏', 11: '圭', 12: '全', 14: '馬', 15: '龍' };
  var HAND_ORDER = [7, 6, 5, 4, 3, 2, 1];
  var PIECE_PATH = '20,2 33,9 37,42 3,42 7,9';
  // Show legal moves is the shell's Hints setting (Menu > Settings), not a New game option.
  function hintsOn() { return !root.ZimiShell || root.ZimiShell.settings.get('hints') !== 'off'; }

  var G = WK.create({
    id: 'shogi',
    options: [{ key: 'variant', legend: 'shogi.board', def: 'full', choices: [['full', 'shogi.board.full'], ['mini', 'shogi.board.mini']] }]
      .concat(WK.standardOptions({ base: WK.CLASSIC_LEVELS, levelDef: 'club', first: 'shogi.side.senteFirst', second: 'shogi.side.gote' }),
        [{ key: 'labels', legend: 'xiangqi.pieces', def: root.ZimiText && root.ZimiText.lang === 'zh' ? 'kanji' : 'icons', choices: [['kanji', 'shogi.pieces.kanji'], ['icons', 'xiangqi.pieces.icons']] }]),
    statKey: function (s) { return s.variant + '.' + s.level; },
    onNew: newGame, onUndo: undo
  });
  var E = null, brain = null, SIZE = 9, SENTE = 1, GOTE = -1, PROMOTED = 8;
  var els = { board: $('sg-board'), moves: $('sg-moves'), flip: $('sg-flip') };
  var cells = [], pos, keys, sans, played, sel = -1, selDrop = 0, targets = {}, lastMove = 0, manualFlip = false;

  function turnIdx() { return pos.turn === SENTE ? 0 : 1; }
  function flipped() { return manualFlip !== (G.vsComputer() && G.settings.side === 'second'); }
  // The level our own engine plays at: the one chosen, or its best when Strong or Master were chosen and Fairy-Stockfish is not there.
  function engineLevel() { return F.wants(G.settings.level) ? 'strong' : G.settings.level; }
  function fairyGame() { return G.settings.variant === 'mini' ? 'minishogi' : 'shogi'; }
  function colorName(c) { return T(c === SENTE ? 'shogi.side.sente' : 'shogi.side.gote'); }
  function bottomColor() { return flipped() ? GOTE : SENTE; }
  function sqAt(d) { return flipped() ? SIZE * SIZE - 1 - d : d; }

  // ── drawing ──
  function pieceSvg(t, color, upright) {
    var kanji = G.settings.labels === 'kanji', up = t > PROMOTED;   // Kanji, or the arrows each piece moves along
    var cls = 'sg-pc' + (upright || color === bottomColor() ? '' : ' g') + (kanji ? '' : ' icon') + (up ? ' up' : '');
    return '<svg class="' + cls + '" viewBox="0 0 40 44" aria-hidden="true"><polygon points="' + PIECE_PATH + '"/>' + (kanji ? '<text x="20" y="25">' + (t === 8 && color === GOTE ? '王' : KANJI[t]) + '</text>' : root.ZimiPieceIcons.shogiArrows(t)) + '</svg>';
  }

  function buildBoard() {
    els.board.textContent = '';
    cells = [];
    els.board.style.gridTemplateColumns = els.board.style.gridTemplateRows = 'repeat(' + SIZE + ', 1fr)';
    for (var d = 0; d < SIZE * SIZE; d++) {
      var c = document.createElement('button');
      c.type = 'button'; c.dataset.d = d;
      c.addEventListener('click', onSquare);
      els.board.appendChild(c); cells.push(c);
    }
    BK.gridNav(els.board, cells, SIZE);
    var files = '', ranks = '';
    for (var i = 0; i < SIZE; i++) { files += '<span></span>'; ranks += '<span></span>'; }
    $('sg-files').innerHTML = files; $('sg-ranks').innerHTML = ranks;
    $('sg-files').style.gridTemplateColumns = 'repeat(' + SIZE + ', 1fr)';
    $('sg-ranks').style.gridTemplateRows = 'repeat(' + SIZE + ', 1fr)';
  }
  function paintLabels() {
    var f = $('sg-files').children, r = $('sg-ranks').children;
    for (var i = 0; i < SIZE; i++) {
      f[i].textContent = flipped() ? i + 1 : SIZE - i;
      r[i].textContent = String.fromCharCode(97 + (flipped() ? SIZE - 1 - i : i));
    }
  }

  function isStar(r, c) { return SIZE === 9 && (r === 2 || r === 5) && (c === 2 || c === 5); }
  function paint() {
    var kingSq = E.inCheck(pos, pos.turn) ? pos.king[turnIdx()] : -1;
    var lastTo = lastMove ? E.to(lastMove) : -1, lastFrom = lastMove && !E.isDrop(lastMove) ? E.from(lastMove) : -1;
    for (var d = 0; d < SIZE * SIZE; d++) {
      var s = sqAt(d), c = cells[d], v = pos.sq[s], r = (d / SIZE) | 0, col = d % SIZE;
      var cls = 'sg-sq' + (col === SIZE - 1 ? ' ec' : '') + (r === SIZE - 1 ? ' er' : '') + (isStar(r, col) ? ' star-br' : '');
      if (s === lastTo || s === lastFrom) cls += ' last';
      if (s === sel) cls += ' sel';
      if (s === kingSq) cls += ' bad';
      if (hintsOn() && targets.hasOwnProperty(s)) cls += ' hint' + (v ? ' cap' : '');
      c.className = cls;
      var html = v ? pieceSvg(Math.abs(v), v > 0 ? SENTE : GOTE) : '';
      var sig = html + G.settings.labels + bottomColor();
      if (c.dataset.sig !== sig) { c.innerHTML = html; c.dataset.sig = sig; }
      var name = E.squareName(s), label = v ? T('chess.sq.piece', { sq: name, color: colorName(v > 0 ? SENTE : GOTE).toLowerCase(), piece: T('shogi.piece.' + Math.abs(v)) }) : T(targets.hasOwnProperty(s) ? 'chess.sq.target' : 'chess.sq.empty', { sq: name });
      c.setAttribute('aria-label', s === sel ? T('chess.sq.selected', { label: label }) : label);
    }
    paintLabels();
    paintHands();
    G.setUndo(played.length > 0);
    els.flip.setAttribute('aria-pressed', String(manualFlip));
  }

  function paintHands() {
    var bottom = bottomColor();
    [['top', -bottom], ['bottom', bottom]].forEach(function (h) {
      var box = $('sg-hand-' + h[0]), color = h[1], side = color === SENTE ? 0 : 1, canUse = !G.over && !G.thinking && pos.turn === color && G.human(turnIdx());
      box.classList.toggle('active', canUse);
      var sig = '', html = '';
      HAND_ORDER.forEach(function (t) {
        if (E.DROPPABLE.indexOf(t) < 0) return;
        var n = pos.hand[side][t], picked = canUse && selDrop === t && n > 0;
        sig += t + ':' + n + (picked ? '*' : '') + (canUse ? 'u' : '');
        html += '<button type="button" class="sg-h' + (picked ? ' sel' : '') + '" data-piece="' + t + '" data-c="' + color + '"' + (canUse && n ? '' : ' disabled') + ' aria-label="' + T('shogi.hand.piece', { side: colorName(color), piece: T('shogi.piece.' + t), n: n }) + '">' + pieceSvg(t, color) + '<b>' + n + '</b></button>';
      });
      sig += G.settings.labels + bottom;
      if (box.dataset.sig !== sig) {
        box.innerHTML = html; box.dataset.sig = sig;
        Array.prototype.forEach.call(box.querySelectorAll('.sg-h'), function (b) { b.addEventListener('click', onHand); });
      }
    });
  }

  function paintMoves() {
    var html = '';
    for (var i = 0; i < sans.length; i++) {
      if (i % 2 === 0) html += '<span class="sg-n">' + (i / 2 + 1) + '.</span>';
      html += '<span class="sg-m' + (i === sans.length - 1 ? ' now' : '') + '">' + sans[i] + '</span>';
    }
    els.moves.innerHTML = html;
    els.moves.scrollTop = els.moves.scrollHeight;
  }

  // ── turns ──
  var WHY = { repetition: 'shogi.why.repetition', long: 'shogi.why.long' };
  function finish(st) {
    sel = -1; selDrop = 0; targets = {};
    var msg, out, name;
    if (st.result === 'mate') {
      var wi = st.winner === SENTE ? 0 : 1;
      msg = T('chess.why.mate');
      out = G.vsComputer() ? (G.human(wi) ? 'w' : 'l') : null;
      name = colorName(st.winner);
    } else { msg = T(WHY[st.result]); out = 'd'; }
    G.finish(msg, out, name);
    paint();
  }

  function afterMove() {
    sel = -1; selDrop = 0; targets = {};
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
    brain.ask({ sfen: E.toSfen(pos), level: level, seen: seenCounts() }, function (r) {
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
      F.ask(fairyGame(), E, pos, played, G.settings.level, function (move, why) {
        if (!G.current(token)) return;
        if (move) { G.done(token); play(move); return; }
        if (why === 'unavailable') G.say(T('board.fairyNote', { thinking: T('shell.thinking') }), true);
        askLocal(token);
      });
    }, COMPUTER_DELAY_MS);
  }

  // ── input ──
  function targetsFor(match) {
    var out = {};
    E.legalMoves(pos).forEach(function (m) { if (match(m)) out[E.to(m)] = true; });
    return out;
  }
  function pick(s) { // a square was chosen as the destination
    var cands = E.legalMoves(pos).filter(function (m) {
      return E.to(m) === s && (selDrop ? E.isDrop(m) && E.from(m) === selDrop : !E.isDrop(m) && E.from(m) === sel);
    });
    if (cands.length > 1) { showPromo(cands); return; }
    play(cands[0]);
  }
  function onSquare(e) {
    if (G.over || G.thinking || !G.human(turnIdx())) return;
    var s = sqAt(+e.currentTarget.dataset.d), v = pos.sq[s];
    if ((sel >= 0 || selDrop) && targets.hasOwnProperty(s)) { pick(s); return; }
    selDrop = 0;
    if (v * pos.turn > 0 && s !== sel) {
      sel = s; targets = targetsFor(function (m) { return !E.isDrop(m) && E.from(m) === s; });
      if (!Object.keys(targets).length) { sel = -1; G.refuse(e.currentTarget, T('chess.cantMove')); }
      else G.say(!G.vsComputer() ? T('board.toMove', { name: colorName(pos.turn) }) : T('board.chooseWhere'));
    } else { sel = -1; targets = {}; }
    paint();
  }
  function onHand(e) {
    if (G.over || G.thinking || !G.human(turnIdx())) return;
    var t = +e.currentTarget.dataset.piece;
    sel = -1;
    if (selDrop === t) { selDrop = 0; targets = {}; } else {
      selDrop = t; targets = targetsFor(function (m) { return E.isDrop(m) && E.from(m) === t; });
      if (!Object.keys(targets).length) { selDrop = 0; G.refuse(e.currentTarget, T('shogi.cantDrop')); }
      else G.say(T('shogi.chooseDrop'));
    }
    paint();
  }

  var promoSheet = null;
  function showPromo(cands) {
    var t = Math.abs(pos.sq[E.from(cands[0])]), box = UI.h('div', { class: 'sg-promo-choices' }), color = pos.turn;
    [[true, 'shogi.promote', t + PROMOTED], [false, 'shogi.noPromote', t]].forEach(function (o) {
      var b = UI.h('button', { class: 'ar-btn sg-promo-btn', type: 'button' });
      b.innerHTML = pieceSvg(o[2], color, true) + '<span>' + T(o[1]) + '</span>';
      b.addEventListener('click', function () {
        var m = cands.filter(function (x) { return !!E.isPromo(x) === o[0]; })[0];
        promoSheet.close();
        if (m) play(m);
      });
      box.appendChild(b);
    });
    promoSheet = root.ZimiShell.sheet({ title: T('shogi.promoteQ'), body: [box] });
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

  // The engine for the board in force (full or mini), and the board built for it.
  function useVariant() {
    var variant = G.settings.variant;
    if (!E || E.SIZE !== (variant === 'mini' ? 5 : 9)) {
      if (brain) brain.drop();
      E = root.ZimiShogiEngine(root.ZimiSearch(), variant); SIZE = E.SIZE; SENTE = E.SENTE; GOTE = E.GOTE; PROMOTED = E.PROMOTED;
      brain = root.EngineKit.client(root.ZimiShogiEngine, 250, { args: [variant], depth: FALLBACK_DEPTH });
      buildBoard();
      $('sg-title').textContent = T(variant === 'mini' ? 'shogi.title.mini' : 'shogi.title');
      if (root.ZimiShell) root.ZimiShell.setTitle($('sg-title').textContent);
    }
  }
  function newGame() {
    sel = -1; selDrop = 0; targets = {}; lastMove = 0; manualFlip = false; F.cancel();
    useVariant();
    pos = E.startPosition(); keys = [E.key(pos)]; sans = []; played = [];
    cells.forEach(function (c) { delete c.dataset.sig; });
    paintMoves(); paint();
    afterMove();
  }

  // ── keys ──
  els.flip.addEventListener('click', function () { manualFlip = !manualFlip; paint(); });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input')) return;
    if (e.key.toLowerCase() === 'f') { manualFlip = !manualFlip; paint(); }
    else if (e.key === 'Escape' && (sel >= 0 || selDrop)) { sel = -1; selDrop = 0; targets = {}; paint(); }
  });

  if (root.ZimiShell) {
    root.ZimiShell.settings.on(function (k) { if (k === 'hints' || k === '*') paint(); });
    root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && played.length > 0; },
      help: function () { return { extra: [root.ZimiPieceIcons.key(T('shell.help.pieces'), (G.settings.variant === 'mini' ? [8, 7, 6, 5, 4, 1, 14, 15, 12, 9] : [8, 7, 6, 5, 4, 3, 2, 1, 15, 14, 12, 11, 10, 9]).map(function (t) { return { html: pieceSvg(t, SENTE, true), name: T('shogi.piece.' + t) }; }))] }; } });
  }
  G.newGame();
  // Leaving and coming back: the settings in force and the end are kept by WorldKit; the moves are played again from the start.
  G.persist({
    save: function () { return played.length ? { played: played.slice(), flip: manualFlip } : null; },
    load: function (d) {
      useVariant();
      pos = E.startPosition(); keys = [E.key(pos)]; sans = []; played = [];
      d.played.forEach(function (m) { sans.push(E.san(pos, m)); played.push(m); E.make(pos, m); keys.push(E.key(pos)); });
      lastMove = played[played.length - 1] || 0; manualFlip = !!d.flip; sel = -1; selDrop = 0; targets = {};
      cells.forEach(function (c) { delete c.dataset.sig; });
      paintMoves(); paint();
    },
    resume: function () { afterMove(); }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__sg = { finish: finish, engine: function () { return E; }, pos: function () { return pos; }, settings: G.settings, play: play, usingWorker: function () { return brain.usingWorker(); } };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
