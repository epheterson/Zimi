/* ZimiGames: Walls, the page. The rules and the computer are in walls-engine.js, run in a Web Worker built from its own
   source (enginekit.js) with the main thread as the fallback. A person steps by tapping a square; lays a wall by pressing
   Wall, tapping the point where four squares meet (a second tap turns it) and pressing Place. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiWallsEngine || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var E = root.ZimiWallsEngine(root.ZimiSearch()), brain = root.EngineKit.client(root.ZimiWallsEngine, 500);
  var N = E.N, J = E.J, SQ = E.SQ, HINT_MS = 1800;

  function hintsOn() { return !root.ZimiShell || root.ZimiShell.settings.get('hints') !== 'off'; }
  function sideName(p) { return T(p === 0 ? 'board.white' : 'board.black'); }

  var G = WK.create({
    id: 'walls',
    options: WK.standardOptions({ first: 'walls.side.first', second: 'walls.side.second' }),
    onNew: newGame, onUndo: undo, onHint: hint
  });
  var score = WK.scoreBar($('wk-score'), [{ color: 'var(--wl-p0)', border: 'var(--wl-p0-lo)' }, { color: 'var(--wl-p1)' }]);
  var board = $('wl-board'), junc = $('wl-junc'), modeBtn = $('wl-wallmode'), turnBtn = $('wl-turn'), placeBtn = $('wl-place');
  var cells = [], points = [], wallEls = {}, pos, played, legal, targets = {}, lastMove = -1, tip = -1;
  var wallMode = false, preview = -1, lastFlat = true;

  function turnIdx() { return pos.turn; }
  function nameOf(p) { return G.vsComputer() ? (G.human(p) ? T('board.you') : T('board.zimi')) : sideName(p); }

  // ── the drawing ──
  function buildBoard() {
    board.textContent = ''; junc.textContent = '';
    var s, j;
    for (s = 0; s < SQ; s++) {
      var c = document.createElement('button');
      c.type = 'button'; c.dataset.s = s;
      if (E.rowOf(s) === 0) c.classList.add('goal0'); else if (E.rowOf(s) === N - 1) c.classList.add('goal1');
      c.addEventListener('click', onSquare);
      board.appendChild(c); cells.push(c);
    }
    BK.gridNav(board, cells, N);
    for (j = 0; j < J * J; j++) {
      var b = document.createElement('button');
      b.type = 'button'; b.dataset.j = j;
      b.style.setProperty('--r', (j / J) | 0); b.style.setProperty('--c', j % J);
      b.addEventListener('click', onPoint);
      junc.appendChild(b); points.push(b);
    }
    BK.gridNav(junc, points, J);
  }
  function wallEl(m) {
    var el = wallEls[m];
    if (!el) {
      var j = E.wallJunction(m);
      el = document.createElement('i');
      el.className = 'wl-wall ' + (E.isFlat(m) ? 'flat' : 'upright');
      el.style.setProperty('--r', (j / J) | 0); el.style.setProperty('--c', j % J);
      el.setAttribute('aria-hidden', 'true');
      board.appendChild(el); wallEls[m] = el;
    }
    return el;
  }
  function pawnHtml(p) { return '<span class="wl-pc p' + p + '"></span>'; }
  function squareLabel(s) {
    var what = T(pos.pawn[0] === s ? 'walls.sq.white' : pos.pawn[1] === s ? 'walls.sq.black' : 'walls.sq.empty');
    return T(targets.hasOwnProperty(s) ? 'walls.sq.target' : 'walls.sq', { sq: E.squareName(s), what: what });
  }
  function pointLabel(j) {
    var r = (j / J) | 0, c = j % J;
    return T('walls.point', { cols: String.fromCharCode(97 + c) + '–' + String.fromCharCode(98 + c), rows: (N - r - 1) + '–' + (N - r) });
  }

  function paint() {
    var open = !G.over && !G.thinking && G.human(turnIdx());
    var s, m;
    for (s = 0; s < SQ; s++) {
      var c = cells[s], cls = (c.classList.contains('goal0') ? 'goal0 ' : '') + (c.classList.contains('goal1') ? 'goal1 ' : '');
      if (pos.pawn[0] === s || pos.pawn[1] === s) cls += 'has ';
      if (hintsOn() && !wallMode && open && targets.hasOwnProperty(s)) cls += 'hint ';
      if (s === tip) cls += 'tip ';
      if (lastMove >= 0 && !E.isWall(lastMove) && s === lastMove) cls += 'last ';
      c.className = cls.trim();
      var sig = String(pos.pawn[0] === s ? 0 : pos.pawn[1] === s ? 1 : -1);
      if (c.dataset.sig !== sig) { c.innerHTML = sig === '-1' ? '' : pawnHtml(+sig); c.dataset.sig = sig; }
      c.setAttribute('aria-label', squareLabel(s));
    }
    // walls: shown for every wall on the board; the preview and the hint are walls not yet laid
    var laid = {};
    E.walls(pos).forEach(function (w) { laid[w] = 1; });
    Object.keys(wallEls).forEach(function (k) { if (!laid[k] && +k !== preview && +k !== tip) { wallEls[k].remove(); delete wallEls[k]; } });
    Object.keys(laid).forEach(function (k) { var el = wallEl(+k); el.classList.remove('prev', 'tip'); el.classList.toggle('last', +k === lastMove); });
    if (preview >= 0) { var pe = wallEl(preview); pe.classList.toggle('prev', !laid[preview]); }
    if (tip >= E.FLAT) { var te = wallEl(tip); te.classList.toggle('tip', !laid[tip]); }
    junc.hidden = !(wallMode && open);
    points.forEach(function (b, j) {
      var any = pos.left[turnIdx()] > 0 && (E.wallFits(pos, E.flat(j)) || E.wallFits(pos, E.upright(j)));
      b.classList.toggle('aim', preview >= 0 && E.wallJunction(preview) === j);
      b.setAttribute('aria-disabled', String(!any));
      b.setAttribute('aria-label', pointLabel(j));
    });
    modeBtn.setAttribute('aria-pressed', String(wallMode));
    modeBtn.disabled = !open || pos.left[turnIdx()] < 1;
    turnBtn.disabled = !(wallMode && preview >= 0);
    placeBtn.disabled = !(wallMode && preview >= 0);
    board.classList.toggle('is-walling', wallMode && open);
    var names = G.names(sideName(0), sideName(1));
    score(names, [T('walls.count', { n: pos.left[0] }), T('walls.count', { n: pos.left[1] })], G.over ? -1 : turnIdx());
    G.setUndo(played.length > 0); G.setHint(open);
  }

  // ── a game ──
  function request(extra) { return Object.assign({ pawn: pos.pawn.slice(), left: pos.left.slice(), turn: pos.turn, walls: E.walls(pos) }, extra); }
  function finish(st) {
    clearAim();
    var wi = st.winner, out = G.vsComputer() ? (G.human(wi) ? 'w' : 'l') : null;
    G.finish(T('walls.why.home', { side: sideName(wi) }), out, sideName(wi));
    paint();
  }
  function computeTargets() {
    targets = {};
    if (G.over) return;
    E.steps(pos, pos.turn).forEach(function (s) { targets[s] = true; });
  }
  function afterMove(note) {
    clearAim();
    var st = E.status(pos), p = turnIdx();
    if (st.over) { targets = {}; paint(); finish(st); return; }
    legal = E.moves(pos, true);
    computeTargets();
    paint();
    var line = !G.vsComputer() ? T('board.toMove', { name: sideName(p) }) : G.human(p) ? T('board.yourTurn') : T('shell.thinking');
    G.say(note ? UI.noted(note, line) : line, !G.human(p));
    if (!G.human(p)) computerTurn();
  }
  function play(m) {
    var who = nameOf(turnIdx());
    played.push(m);
    E.make(pos, m); lastMove = m; wallMode = false; tip = -1;
    afterMove(E.isWall(m) ? T('walls.played.wall', { name: who }) : T('walls.played.step', { name: who, sq: E.squareName(m) }));
  }
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
      tip = r && r.move >= 0 && legal.indexOf(r.move) >= 0 ? r.move : -1;
      paint();
      G.say(tip < 0 ? T('board.noHint') : E.isWall(tip) ? T('walls.hint.wall') : T('walls.hint.step', { sq: E.squareName(tip) }));
    });
  }
  function undo() {
    if (!played.length) return;
    G.cancel(); G.over = false;
    do { E.unmake(pos); played.pop(); } while (played.length && G.vsComputer() && !G.human(turnIdx()));
    lastMove = played.length ? played[played.length - 1] : -1; tip = -1; wallMode = false;
    afterMove();
  }
  function newGame() {
    lastMove = -1; tip = -1; wallMode = false;
    pos = E.newPosition(); played = [];
    afterMove();
  }

  // ── tapping ──
  function clearAim() { preview = -1; }
  function setMode(on) {
    if (on && (G.over || G.thinking || !G.human(turnIdx()) || pos.left[turnIdx()] < 1)) return;
    wallMode = on; preview = -1; tip = -1;
    paint();
    if (G.human(turnIdx()) && !G.over) G.say(on ? T('walls.chooseWall') : T('board.yourTurn'));
  }
  function onSquare(e) {
    if (G.over || G.thinking || !G.human(turnIdx())) return;
    if (wallMode) { setMode(false); return; }
    var s = +e.currentTarget.dataset.s;
    if (targets.hasOwnProperty(s)) { play(s); return; }
    G.refuse(e.currentTarget, pos.pawn[turnIdx()] === s ? T('walls.why.here') : T('walls.why.far'));
  }
  // The wall at a junction: the way it ran last, else the other; null when neither fits or either would shut a pawn in.
  function wallAt(j, flatFirst) {
    var a = E.flat(j), b = E.upright(j), order = flatFirst ? [a, b] : [b, a];
    return order.filter(function (m) { return E.wallLegal(pos, m); });
  }
  function onPoint(e) {
    if (G.over || G.thinking || !G.human(turnIdx())) return;
    var j = +e.currentTarget.dataset.j;
    if (preview >= 0 && E.wallJunction(preview) === j) { turnWall(); return; }
    var fits = wallAt(j, lastFlat);
    if (!fits.length) {
      var reason = pos.left[turnIdx()] < 1 ? 'walls.why.none' : (E.wallFits(pos, E.flat(j)) || E.wallFits(pos, E.upright(j))) ? 'walls.why.shut' : 'walls.why.taken';
      G.refuse(e.currentTarget, T(reason)); return;
    }
    preview = fits[0]; lastFlat = E.isFlat(preview);
    paint(); G.say(T('walls.confirm'));
  }
  function turnWall() {
    if (preview < 0) return;
    var j = E.wallJunction(preview), other = E.isFlat(preview) ? E.upright(j) : E.flat(j);
    if (!E.wallLegal(pos, other)) { G.refuse(turnBtn, T('walls.why.cannotTurn')); return; }
    preview = other; lastFlat = E.isFlat(preview);
    paint();
  }
  function place() {
    if (preview < 0 || !E.wallLegal(pos, preview)) return;
    play(preview);
  }
  modeBtn.addEventListener('click', function () { setMode(!wallMode); });
  turnBtn.addEventListener('click', turnWall);
  placeBtn.addEventListener('click', place);
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input')) return;
    var k = e.key.toLowerCase();
    if (k === 'w') setMode(!wallMode);
    else if (k === 'escape' && wallMode) setMode(false);
    else if ((k === 'r' || k === 't') && wallMode) turnWall();
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
      pos = E.newPosition(); played = [];
      d.played.forEach(function (m) { E.make(pos, m); played.push(m); });
      lastMove = played.length ? played[played.length - 1] : -1; tip = -1; wallMode = false; preview = -1;
      legal = E.moves(pos, true); computeTargets();
      paint();
    },
    resume: function () { afterMove(); }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__walls = { engine: E, pos: function () { return pos; }, play: play, usingWorker: function () { return brain.usingWorker(); } };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
