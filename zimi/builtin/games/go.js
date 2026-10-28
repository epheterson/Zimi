/* ZimiGames: Go, 9 by 9 and 13 by 13. Our own code, GPL-3.0. The rules, scoring and the Monte
   Carlo computer live in go-engine.js (also run in a Worker made from a Blob, with the main
   thread as a fallback). This file is the page. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, Engine = root.makeGoEngine(), BLACK = 1, WHITE = 2;
  var VIEW = 420, PAD = 30;
  function sideName(p) { return UI.side(p === 0 ? 'black' : 'white'); }
  var SETTLE_MS = 400, THINK_MS = { easy: 350, medium: 1600, hard: 4200 }, FALLBACK_MS = 800, HINT_MS = 1800, DEAD_MS = 900;
  var HOSHI = { 9: [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]], 13: [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6], [3, 6], [6, 3], [6, 9], [9, 6]] };

  var host = document.getElementById('wk-board'), stonesG, marksG, btns = [], n = 9, cell = 45;
  var st, history = WK.History(), phase = 'play', dead = null, hintIdx = -1, lastMsg = '', shownBoard = null, settle = { at: 0 };
  var passBtn = document.getElementById('go-pass'), doneBtn = document.getElementById('go-done'), resumeBtn = document.getElementById('go-resume');
  var score = WK.scoreBar(document.getElementById('wk-score'), [{ color: 'var(--disc-b)' }, { color: 'var(--disc-w)' }]);
  var G = WK.create({
    id: 'go',
    options: WK.standardOptions({ first: 'go.side.blackFirst', second: 'board.white' }).concat([{ key: 'size', legend: 'go.board', def: '9', choices: [['9', 'go.board.9'], ['13', 'go.board.13']] }]),
    statKey: function (s) { return s.size + s.level; },
    onNew: newGame, onUndo: undo, onHint: hint
  });

  // ── the computer, in a Worker when the page allows one (EngineKit: a worker error or a silent worker falls back to this thread) ──
  var brain = root.EngineKit.client(root.makeGoEngine, FALLBACK_MS);
  // Ask the engine; the reply comes to cb (null if the engine could not answer).
  function ask(req, cb) {
    var body = { cmd: req.cmd, n: st.n, board: Array.prototype.slice.call(st.board), turn: st.turn, caps: st.caps, ko: st.ko, passes: st.passes, last: st.last, moves: st.moves, ms: req.ms, level: req.level, seed: (Date.now() & 0x7fffffff) | 1 };
    brain.ask(body, cb, req.ms);
  }
  function thinkMs() { return THINK_MS[G.settings.level] * (n === 13 ? 1.5 : 1); }

  // ── drawing ──
  function xy(i) { return { x: PAD + (i % n) * cell, y: PAD + ((i / n) | 0) * cell }; }
  function coord(i) { return 'ABCDEFGHJKLMN'[i % n] + (n - ((i / n) | 0)); }
  function buildBoard() {
    n = +G.settings.size; cell = (VIEW - 2 * PAD) / (n - 1);
    var g = '', k, stars = '';
    for (k = 0; k < n; k++) { var o = PAD + k * cell; g += 'M' + PAD + ' ' + o + 'H' + (VIEW - PAD) + 'M' + o + ' ' + PAD + 'V' + (VIEW - PAD); }
    HOSHI[n].forEach(function (p) { stars += '<circle cx="' + (PAD + p[1] * cell) + '" cy="' + (PAD + p[0] * cell) + '" r="3.6" class="go-star"/>'; });
    host.innerHTML = '<svg viewBox="0 0 ' + VIEW + ' ' + VIEW + '" aria-hidden="true">' + WK.STONE_DEFS + '<rect width="' + VIEW + '" height="' + VIEW + '" rx="8" class="go-wood"/><path d="' + g + '" class="go-grid"/>' + stars + '<g id="go-stones"></g><g id="go-marks"></g></svg>';
    stonesG = host.querySelector('#go-stones'); marksG = host.querySelector('#go-marks');
    var pts = [];
    for (var i = 0; i < n * n; i++) { var p = xy(i); pts.push({ x: p.x, y: p.y, w: cell }); }
    btns = WK.overlay(host, VIEW, VIEW, pts, onPoint, 'go-pt');
  }

  function liveScore() { return Engine.score(st.board, n, dead, st.caps); }

  // One stone: its shadow and its disc, with the cross that marks it dead at the end.
  function stone(p, r, colour, cls, dead) {
    return '<g' + (cls ? ' class="' + cls.trim() + '"' : '') + '><circle cx="' + p.x + '" cy="' + (p.y + 1.5) + '" r="' + r + '" class="go-shadow"/><circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="url(#wk-stone-' + (colour === BLACK ? 'b' : 'w') + ')"/>' +
      (dead ? '<path d="M' + (p.x - r * 0.45) + ' ' + (p.y - r * 0.45) + 'l' + (r * 0.9) + ' ' + (r * 0.9) + 'm0 ' + (-r * 0.9) + 'l' + (-r * 0.9) + ' ' + (r * 0.9) + '" class="go-x ' + (colour === BLACK ? 'on-b' : 'on-w') + '"/>' : '') + '</g>';
  }

  function paint() {
    var b = st.board, s = '', m = '', i, p, r = cell * 0.47, marking = phase === 'mark', sc = marking ? liveScore() : null;
    // What the last move changed (stones that arrived, stones taken) animates for a moment, through the repaints that follow it.
    var now = Date.now();
    if (!shownBoard || shownBoard.length !== b.length) { shownBoard = Array.prototype.slice.call(b); settle = { at: 0 }; }
    else if (shownBoard.some(function (v, k) { return v !== b[k]; })) {
      settle = { at: now, fresh: {}, gone: {} };
      shownBoard.forEach(function (v, k) { if (b[k] && !v) settle.fresh[k] = 1; else if (v && !b[k]) settle.gone[k] = v; });
      shownBoard = Array.prototype.slice.call(b);
    }
    var live = !marking && now - settle.at < SETTLE_MS;
    for (i = 0; i < n * n; i++) {
      p = xy(i);
      if (live && settle.gone[i] && !b[i]) s += stone(p, r, settle.gone[i], 'go-gone');   // a stone that has just been taken fades where it stood
      if (!b[i]) continue;
      var isDead = marking && dead[i];
      s += stone(p, r, b[i], (isDead ? 'go-dead' : '') + (live && settle.fresh[i] ? ' go-new' : ''), isDead);
    }
    if (marking) {
      for (i = 0; i < n * n; i++) {
        if (!sc.territory[i]) continue;
        p = xy(i);
        m += '<rect x="' + (p.x - cell * 0.17) + '" y="' + (p.y - cell * 0.17) + '" width="' + (cell * 0.34) + '" height="' + (cell * 0.34) + '" class="go-terr ' + (sc.territory[i] === BLACK ? 'b' : 'w') + '"/>';
      }
    } else {
      if (st.last >= 0) { p = xy(st.last); m += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (r * 0.34) + '" class="go-last ' + (b[st.last] === BLACK ? 'on-b' : 'on-w') + '"/>'; }
      if (st.ko >= 0 && !G.over) { p = xy(st.ko); m += '<rect x="' + (p.x - cell * 0.2) + '" y="' + (p.y - cell * 0.2) + '" width="' + (cell * 0.4) + '" height="' + (cell * 0.4) + '" class="go-ko"/>'; }
      if (hintIdx >= 0) { p = xy(hintIdx); m += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (r * 0.8) + '" class="go-hint"/>'; }
    }
    stonesG.innerHTML = s; marksG.innerHTML = m;
    var open = !G.over && !G.thinking && G.human(st.turn - 1);
    btns.forEach(function (bt, j) {
      var what = T(b[j] === BLACK ? 'go.pt.black' : b[j] === WHITE ? 'go.pt.white' : 'go.pt.empty');
      bt.setAttribute('aria-label', marking && b[j] ? T(dead[j] ? 'go.pt.dead' : 'go.pt.alive', { pt: coord(j), what: what }) : T('go.pt', { pt: coord(j), what: what }));
      bt.setAttribute('aria-disabled', (marking ? (!b[j] || G.over) : (!open || b[j])) ? 'true' : 'false');
    });
    var names = G.names(sideName(0), sideName(1));
    if (marking) score(names, [fmt(sc.black), fmt(sc.white)], -1);
    else score(names, [T('go.taken', { n: st.caps[0] }), T('go.taken', { n: st.caps[1] })], G.over ? -1 : st.turn - 1);
    passBtn.hidden = marking; doneBtn.hidden = !marking || G.over; resumeBtn.hidden = !marking || G.over;
    passBtn.disabled = !open;
    G.setUndo(history.size() > 0 && !G.watching); G.setHint(open && !marking);
    G.turnTimer(open && !marking, timeUp, st.moves);
  }
  function fmt(x) { return x % 1 ? x.toFixed(1) : String(x); }

  function turnText() {
    var p = st.turn - 1, nm = sideName(p);
    if (phase === 'mark') return T('go.markLine', { black: fmt(liveScore().black), white: fmt(liveScore().white), komi: Engine.KOMI });
    if (!G.vsComputer()) return T('go.toPlay', { name: nm });
    return G.human(p) ? T('makruk.yourTurn', { side: nm.toLowerCase() }) : T('shell.thinking');
  }
  function nameOf(p) { return G.vsComputer() ? (G.human(p) ? T('board.you') : T('board.zimi')) : sideName(p); }

  // ── playing ──
  function onPoint(i) {
    if (G.over) return;
    if (phase === 'mark') { toggleDead(i); return; }
    if (G.thinking || !G.human(st.turn - 1)) return;
    if (st.board[i]) { flash(i, T('gomoku.taken')); return; }
    var ns = Engine.move(st, i);
    if (!ns) { flash(i, T(i === st.ko ? 'go.refuse.ko' : 'go.refuse.suicide')); return; }
    commit(ns, nameOf(st.turn - 1));
  }
  function flash(i, msg) {
    var bt = btns[i]; bt.classList.add('bad'); setTimeout(function () { bt.classList.remove('bad'); }, 350);
    G.refuse(bt, msg);
  }
  function commit(ns, who) {
    history.push(st); hintIdx = -1;
    var took = ns.taken ? ns.taken.length : 0, passed = ns.passes > 0;
    st = ns;
    var note = passed ? T('go.passed', { name: who }) : took ? T('go.took', { name: who, n: took }) : '';
    if (st.passes >= 2) { paint(); enterMark(); return; }
    paint(); G.say(note ? UI.noted(note, turnText()) : turnText(), !G.human(st.turn - 1));
    if (!G.human(st.turn - 1)) computerTurn();
  }
  function computerTurn() {
    var token = G.begin();
    paint(); G.say(lastMsg = T('shell.thinking'), true);
    ask({ cmd: 'move', ms: thinkMs(), level: G.settings.level }, function (r) {
      if (!G.done(token)) return;
      var mv = r && typeof r.move === 'number' ? r.move : -1, ns = Engine.move(st, mv);
      if (!ns) { mv = -1; ns = Engine.move(st, -1); }
      var ctl = G.watching;
      if (!ctl) { commit(ns, T('board.zimi')); return; }
      var why = root.ZimiExplain.go(Engine, st, mv, r || {});
      ctl.offer(why.text, function () { if (G.watching === ctl && !G.over) commit(Engine.move(st, mv), T('board.zimi')); });
    });
  }
  // The move timer ran out: a quick computer choice is played for the person.
  function timeUp() {
    if (G.over || G.thinking || phase !== 'play' || !G.human(st.turn - 1)) return;
    var token = G.begin(); paint(); G.say(T('board.timeUp'), true);
    ask({ cmd: 'move', ms: 350, level: 'easy' }, function (r) {
      if (!G.done(token)) return;
      var mv = r && typeof r.move === 'number' ? r.move : -1, ns = Engine.move(st, mv) || Engine.move(st, -1);
      commit(ns, T('board.you'));
    });
  }
  function pass() {
    if (G.over || G.thinking || phase !== 'play' || !G.human(st.turn - 1)) return;
    commit(Engine.move(st, -1), nameOf(st.turn - 1));
  }
  passBtn.addEventListener('click', pass);

  function hint() {
    var token = G.begin(); paint(); G.say(T('board.thinkingHint'), true);
    ask({ cmd: 'move', ms: HINT_MS, level: 'hard' }, function (r) {
      if (!G.done(token)) return;
      hintIdx = r && r.move >= 0 ? r.move : -1; paint();
      G.say(T(hintIdx >= 0 ? 'go.hint.point' : 'go.hint.pass'));
    });
  }

  // ── the end: mark dead stones, then count ──
  function enterMark() {
    var token = G.begin();
    phase = 'mark'; dead = new Array(n * n).fill(false);
    paint(); G.say(T('go.bothPassed'), true);
    ask({ cmd: 'dead', ms: DEAD_MS }, function (r) {
      if (!G.done(token)) return;
      if (r && r.dead) dead = r.dead;
      paint(); G.say(turnText());
      var ctl = G.watching;
      if (ctl) {
        var sc = liveScore();
        ctl.offer(T('go.watch.markIntro', { black: fmt(sc.black), white: fmt(sc.white), komi: Engine.KOMI }), function () { if (G.watching === ctl) accept(); });
      }
    });
  }
  function toggleDead(i) {
    if (!st.board[i] || G.thinking) return;
    var grp = Engine.groupAt(st.board, n, i), to = !dead[i];
    grp.forEach(function (q) { dead[q] = to; });
    paint(); G.say(turnText());
  }
  function accept() {
    if (phase !== 'mark' || G.over) return;
    var sc = liveScore(), diff = sc.black - sc.white, w = diff > 0 ? 0 : 1;
    var msg = T('go.result', { margin: fmt(Math.abs(diff)), black: fmt(sc.black), blackPts: sc.terrB, blackPris: sc.prisB, white: fmt(sc.white), whitePts: sc.terrW, whitePris: sc.prisW, komi: sc.komi });
    G.finish(msg, G.vsComputer() ? (G.human(w) ? 'w' : 'l') : null, sideName(w), T('go.wonBy', { name: sideName(w), margin: fmt(Math.abs(diff)) }));
    paint();
  }
  doneBtn.addEventListener('click', accept);
  resumeBtn.addEventListener('click', function () {
    if (phase !== 'mark' || G.over) return;
    phase = 'play'; dead = null;
    st = { n: st.n, board: st.board, turn: st.turn, caps: st.caps, ko: st.ko, passes: 0, last: st.last, moves: st.moves, taken: [] };
    paint(); G.say(T('go.playOn', { line: turnText() }), !G.human(st.turn - 1));
    if (!G.human(st.turn - 1)) computerTurn();
  });

  function undo() {
    if (!history.size()) return;
    G.cancel(); G.over = false; phase = 'play'; dead = null; hintIdx = -1;
    var h;
    do { h = history.pop(); st = h; } while (history.size() && G.vsComputer() && !G.human(st.turn - 1));
    paint(); G.say(turnText());
    if (!G.human(st.turn - 1)) computerTurn();
  }

  function newGame() {
    if (+G.settings.size !== n || !stonesG) buildBoard();
    history.clear(); phase = 'play'; dead = null; hintIdx = -1; shownBoard = null;
    st = Engine.newGame(n);
    paint(); G.say(turnText(), !G.human(0));
    if (!G.human(0)) computerTurn();
  }

  G.registerWatch({
    script: 'explain-go.js', unit: 'move', level: 'medium',
    intro: 'go.watch.intro',
    whoseTurn: function () { return st.turn - 1; },
    resume: function () { paint(); G.say(turnText()); }
  });
  if (root.ZimiShell) root.ZimiShell.game({ moveTimer: true, hints: true, inProgress: function () { return !G.over && history.size() > 0; } });

  G.newGame();
  G.persist({
    save: function () { return history.size() ? { st: st, history: history.all(), phase: phase, dead: dead } : null; },
    load: function (d) { buildBoard(); shownBoard = null; st = d.st; history.set(d.history); phase = d.phase; dead = d.dead; hintIdx = -1; paint(); },
    resume: function () { G.say(turnText()); if (phase === 'play' && !G.human(st.turn - 1)) computerTurn(); }
  });
  if (new URLSearchParams(location.search).has('debug')) root.__go = { G: G, state: function () { return st; }, engine: Engine, phase: function () { return phase; }, dead: function () { return dead; }, ask: ask };
})(typeof globalThis !== 'undefined' ? globalThis : this);
