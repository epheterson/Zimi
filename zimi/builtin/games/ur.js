/* ZimiGames: the Royal Game of Ur, the page. The rules and the computer (an expectimax over the dice) are in
   ur-engine.js. Our own code and our own drawn board, GPL-3.0. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiUrEngine || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var E = root.ZimiUrEngine();
  var CELL = 100, COLS = 8, ROWS = 3, W = COLS * CELL, H = ROWS * CELL, PIECE_R = 33, POOL_R = 12, POOL_STEP = 29;
  var ROLL_FLICKER_MS = 70, ROLL_MS = 650, COMPUTER_ROLL_DELAY_MS = 500, COMPUTER_MOVE_DELAY_MS = 700, PASS_DELAY_MS = 1200, AUTO_DELAY_MS = 600, HINT_LEVEL = 'hard';
  var CLS = ['b', 'r'];
  function sideName(p) { return UI.side(p === 0 ? 'blue' : 'red'); }
  var NS = 'http://www.w3.org/2000/svg';

  var G = WK.create({
    id: 'ur',
    options: WK.standardOptions({ first: 'ur.blueFirst', second: 'board.red' }),
    checks: [{ key: 'auto', label: 'ur.auto', def: true }],
    onNew: newGame, onHint: hint
  });
  var score = WK.scoreBar($('wk-score'), [{ color: 'var(--ur-blue)' }, { color: 'var(--ur-red)' }]);
  var host = $('ur-board'), diceHost = $('ur-dice'), rollBtn = $('ur-roll');
  var st, roll = null, moves = [], tip = null, last = null, phase = 'roll', rolling = false, svg, btns = [], pts = [], ptKey = [];

  function turnIdx() { return st.turn; }
  function isYou(p) { return G.vsComputer() && !G.watching && G.human(p); }
  function nameOf(p) { return G.vsComputer() ? (G.human(p) ? T('board.you') : T('board.zimi')) : sideName(p); }
  // A sentence about a mover: its "you" form when the mover is the person (verbs agree).
  function say(key, p, vars) { return T(key + (isYou(p) ? '.you' : ''), Object.assign({ name: nameOf(p) }, vars)); }
  function flipRows() { return G.vsComputer() && G.settings.side === 'second'; }
  // Where a path square of a player is drawn (the human's own lane is the near one).
  function place(p, k) {
    var c = E.cell(p, k);
    return { x: c.col * CELL + CELL / 2, y: (flipRows() && c.row !== 1 ? 2 - c.row : c.row) * CELL + CELL / 2 };
  }
  function poolPlace(p, which) {   // which: 4 = the waiting pieces, 5 = the pieces home
    var row = p === 0 ? 2 : 0;
    return { x: which * CELL + CELL / 2, y: (flipRows() ? 2 - row : row) * CELL + CELL / 2 };
  }
  function mkEl(tag, attrs) { var e = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; }

  // ── the board: drawn once, pieces and marks redrawn on each paint ──
  var STAR = 'M0 -34L9 -9L34 0L9 9L0 34L-9 9L-34 0L-9 -9Z';
  function squareList() {
    var list = [], seen = {};
    [0, 1].forEach(function (p) { for (var k = 1; k <= 14; k++) { var key = E.isShared(k) ? 's' + k : p + ':' + k; if (!seen[key]) { seen[key] = 1; list.push({ p: p, k: k, shared: E.isShared(k) }); } } });
    return list;
  }
  var SQUARES = squareList();
  function buildBoard() {
    host.textContent = '';
    svg = mkEl('svg', { viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true' });
    svg.appendChild(mkEl('rect', { x: 0, y: 0, width: W, height: H, rx: 14, fill: 'var(--ur-ground)' }));
    var g = mkEl('g'); svg.appendChild(g);
    SQUARES.forEach(function (q) {
      var c = place(q.p, q.k), r = mkEl('rect', { x: c.x - 46, y: c.y - 46, width: 92, height: 92, rx: 10, class: 'ur-sq' + (q.shared ? '' : q.p === 0 ? ' b' : ' r') });
      g.appendChild(r);
      if (E.isRosette(q.k)) {
        [0, 45].forEach(function (a) { g.appendChild(mkEl('path', { d: STAR, class: 'ur-star', transform: 'translate(' + c.x + ' ' + c.y + ') rotate(' + a + ') scale(0.82)' })); });
        g.appendChild(mkEl('circle', { cx: c.x, cy: c.y, r: 7, fill: 'var(--ur-sq)', stroke: 'rgba(0,0,0,0.3)' }));
      } else if (q.k === 1 || q.k === 13 || q.k === 5 || q.k === 12 || q.k === 6 || q.k === 7 || q.k === 9 || q.k === 10 || q.k === 11 || q.k === 2 || q.k === 3) {
        // a few simple cuts in the stone, so the squares are not all the same
        var seed = q.k % 3;
        if (seed === 0) g.appendChild(mkEl('path', { d: 'M' + (c.x - 14) + ' ' + c.y + 'h28M' + c.x + ' ' + (c.y - 14) + 'v28', class: 'ur-mark' }));
        else if (seed === 1) { g.appendChild(mkEl('circle', { cx: c.x - 12, cy: c.y, r: 5, class: 'ur-mark' })); g.appendChild(mkEl('circle', { cx: c.x + 12, cy: c.y, r: 5, class: 'ur-mark' })); }
        else g.appendChild(mkEl('path', { d: 'M' + (c.x - 14) + ' ' + (c.y + 10) + 'L' + c.x + ' ' + (c.y - 12) + 'L' + (c.x + 14) + ' ' + (c.y + 10) + 'Z', class: 'ur-mark' }));
      }
    });
    [0, 1].forEach(function (p) { [4, 5].forEach(function (w) {   // the two pools: waiting and home
      var c = poolPlace(p, w);
      g.appendChild(mkEl('rect', { x: c.x - 46, y: c.y - 46, width: 92, height: 92, rx: 10, fill: 'none', stroke: 'var(--ur-sq-edge)', 'stroke-dasharray': '6 6', 'stroke-width': 2, opacity: 0.6 }));
    }); });
    svg.appendChild(mkEl('g', { id: 'ur-top' }));
    host.appendChild(svg);
    // buttons: the 20 squares and the two waiting pools
    pts = []; ptKey = [];
    SQUARES.forEach(function (q) { var c = place(q.p, q.k); pts.push({ x: c.x, y: c.y, w: CELL - 4 }); ptKey.push({ type: 'sq', p: q.p, k: q.k, shared: q.shared }); });
    [0, 1].forEach(function (p) { var c = poolPlace(p, 4); pts.push({ x: c.x, y: c.y, w: CELL - 4 }); ptKey.push({ type: 'pool', p: p }); });
    btns = WK.overlay(host, W, H, pts, onPoint, 'ur-pt');
  }

  function pieceAt(p, k) { return st.pos[p].indexOf(k); }
  // The square a button stands for: who is on it now (a piece of the mover, or an enemy), for the label and the click.
  function paint() {
    var top = svg.querySelector('#ur-top'), p, i;
    top.textContent = '';
    function disc(x, y, cls, r) {
      var c = mkEl('circle', { cx: x, cy: y, r: r || PIECE_R, class: 'ur-pc ' + cls }); top.appendChild(c);
      top.appendChild(mkEl('circle', { cx: x, cy: y, r: (r || PIECE_R) * 0.6, class: 'ur-pc-ring' }));
    }
    function ring(x, y, cls) { top.appendChild(mkEl('rect', { x: x - 46, y: y - 46, width: 92, height: 92, rx: 10, class: 'ur-hl ' + cls })); }
    var targets = {}, sources = {};
    moves.forEach(function (m) { sources[m.from] = true; var c = m.off ? null : place(st.turn, m.to); if (c) targets[m.to] = true; });
    // marks first (below the pieces)
    if (last) { var lc = last.to === E.OFF ? poolPlace(last.p, 5) : place(last.p, last.to); ring(lc.x, lc.y, 'last'); }
    if (phase === 'move' && !G.over) {
      moves.forEach(function (m) {
        var s = m.from === 0 ? poolPlace(st.turn, 4) : place(st.turn, m.from), t = m.off ? poolPlace(st.turn, 5) : place(st.turn, m.to);
        ring(s.x, s.y, 'src'); ring(t.x, t.y, '');
      });
      if (tip) { var tm = tip, tt = tm.off ? poolPlace(st.turn, 5) : place(st.turn, tm.to); ring(tt.x, tt.y, 'tip'); }
    }
    for (p = 0; p < 2; p++) {
      var wait = E.waiting(st, p), home = E.home(st, p);
      for (i = 0; i < E.PIECES; i++) {   // the pools: seven slots each, filled in
        [[4, i < wait], [5, i < home]].forEach(function (spec) {
          var c = poolPlace(p, spec[0]), x = c.x + ((i % 3) - 1) * POOL_STEP, y = c.y + (Math.floor(i / 3) - 1) * POOL_STEP;
          top.appendChild(mkEl('circle', { cx: x, cy: y, r: POOL_R, class: spec[1] ? 'ur-pc ' + CLS[p] : 'ur-slot' }));
        });
      }
      for (i = 0; i < E.PIECES; i++) {
        var k = st.pos[p][i];
        if (k > 0 && k < E.OFF) { var c2 = place(p, k); disc(c2.x, c2.y, CLS[p]); }
      }
    }
    // labels on the buttons
    var canTap = phase === 'move' && !G.over && !G.thinking && G.human(st.turn);
    btns.forEach(function (b, j) {
      var key = ptKey[j], label, enabled = false;
      if (key.type === 'sq') {
        var who = pieceAt(0, key.k) >= 0 && (key.shared || key.p === 0) ? 0 : pieceAt(1, key.k) >= 0 && (key.shared || key.p === 1) ? 1 : -1;
        label = T(key.shared ? 'ur.sq.middle' : 'ur.sq', { side: sideName(key.p), k: key.k }) + (E.isRosette(key.k) ? ' ' + T('ur.rosette') : '') + ', ' + (who >= 0 ? T('ur.piece', { side: sideName(who) }) : T('go.pt.empty'));
        enabled = canTap && ((who === st.turn && sources[key.k]) || (targets[key.k] && (key.shared || key.p === st.turn)));
      } else {
        label = T('ur.waiting', { side: sideName(key.p), n: E.waiting(st, key.p) });
        enabled = canTap && key.p === st.turn && sources[0];
      }
      b.setAttribute('aria-label', label); b.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    });
    var names = G.names(sideName(0), sideName(1));
    score([T('ur.home', { name: names[0] }), T('ur.home', { name: names[1] })], [E.home(st, 0), E.home(st, 1)], G.over ? -1 : st.turn);
    rollBtn.disabled = !(phase === 'roll' && !G.over && !rolling && G.human(st.turn));
    G.setHint(canTap);
  }

  // ── the dice ──
  function showDice(faces, total, tumble) {
    var h = '';
    faces.forEach(function (up) { h += '<svg class="ur-die' + (up ? ' up' : '') + (tumble ? ' tumble' : '') + '" viewBox="0 0 48 48" aria-hidden="true"><polygon points="24,5 44,40 4,40"/>' + (up ? '<circle cx="24" cy="30" r="6"/>' : '') + '</svg>'; });
    diceHost.innerHTML = h + '<span class="ur-total">' + (total == null ? '' : total) + '</span>';
  }
  function throwFaces() {   // four dice, each marked or not with equal chance
    var faces = [], n = 0;
    for (var i = 0; i < 4; i++) { var up = Math.random() < 0.5; faces.push(up); if (up) n++; }
    return { faces: faces, n: n };
  }
  function animateRoll(done) {
    var final = throwFaces();
    if (BK.reducedMotion()) { showDice(final.faces, final.n, false); done(final.n); return; }
    rolling = true; paint();
    var timer = setInterval(function () { showDice(throwFaces().faces, null, true); }, ROLL_FLICKER_MS);
    setTimeout(function () { clearInterval(timer); rolling = false; showDice(final.faces, final.n, false); done(final.n); }, ROLL_MS);
  }

  // ── turns ──
  function startTurn() {
    roll = null; moves = []; tip = null; phase = 'roll';
    paint();
    if (G.over) return;
    var p = st.turn;
    if (G.human(p)) { G.say(T(G.vsComputer() ? 'ur.yourRoll' : 'ur.toRoll', { name: sideName(p) })); }
    else { G.say(T('ur.computerRolling'), true); var token = G.begin(); setTimeout(function () { if (G.done(token)) doRoll(); }, COMPUTER_ROLL_DELAY_MS); }
  }
  var started = false;   // a die was thrown: a fresh game is not kept
  function doRoll() {
    started = true;
    if (G.over || phase !== 'roll' || rolling) return;
    var token = G.begin(), p = st.turn;
    G.say(say('ur.rolling', p));
    animateRoll(function (n) {
      if (!G.done(token)) return;
      roll = n; moves = E.legalMoves(st, n); phase = 'move';
      if (!moves.length) {
        paint(); G.say(n ? say('ur.noMove', p, { n: n }) : say('ur.rolled', p, { n: n }));
        var t2 = G.begin(); setTimeout(function () { if (!G.done(t2)) return; st = E.pass(st); startTurn(); }, PASS_DELAY_MS);
        return;
      }
      paint();
      if (!G.human(p)) {
        G.say(say('ur.rolled', p, { n: n }), true);
        var t3 = G.begin(); setTimeout(function () { if (!G.done(t3)) return; var c = E.choose(st, n, G.settings.level); play(moves[c.index >= 0 ? c.index : 0]); }, COMPUTER_MOVE_DELAY_MS);
        return;
      }
      if (G.settings.auto && moves.length === 1) {
        G.say(T('ur.onlyOne', { n: n }), true);
        var t4 = G.begin(); setTimeout(function () { if (!G.done(t4)) return; play(moves[0]); }, AUTO_DELAY_MS);
        return;
      }
      G.say(say('ur.tap', p, { n: n }));
    });
  }
  function play(m) {
    var p = st.turn, parts = [m.off ? say('ur.movedHome', p) : say(m.from === 0 ? 'ur.movedNew' : 'ur.moved', p)];
    if (m.capture) parts.push(say('ur.captured', p));
    if (m.rosette) parts.push(say('ur.again', p));
    var note = parts.join(' ');
    st = E.apply(st, m); last = { p: p, to: m.to }; tip = null;
    if (st.winner >= 0) { phase = 'over'; moves = []; paint(); win(); return; }
    startTurn();
    G.say(UI.noted(note, G.human(st.turn) ? T(G.vsComputer() ? 'ur.yourRoll' : 'ur.toRoll', { name: sideName(st.turn) }) : T('ur.computerRolling')), !G.human(st.turn));
  }
  function win() {
    var w = st.winner;
    G.finish(T('ur.allHome'), G.vsComputer() ? (G.human(w) ? 'w' : 'l') : null, sideName(w));
  }

  function onPoint(i) {
    if (phase !== 'move' || G.over || G.thinking || !G.human(st.turn)) return;
    var key = ptKey[i], from = null, m;
    if (key.type === 'pool') { if (key.p !== st.turn) return; from = 0; }
    else {
      // a piece of the mover on this square, or a target square of one of the moves
      var mine = st.pos[st.turn].indexOf(key.k) >= 0 && (key.shared || key.p === st.turn);
      if (mine) from = key.k;
      else { m = moves.filter(function (x) { return x.to === key.k && x.to !== E.OFF && (key.shared || key.p === st.turn); })[0]; if (m) { play(m); return; } return; }
    }
    m = moves.filter(function (x) { return x.from === from; })[0];
    if (m) play(m);
    else G.refuse(btns[i], T('ur.cantMove', { n: roll }));
  }
  function hint() {
    if (phase !== 'move' || !moves.length) return;
    var c = E.choose(st, roll, HINT_LEVEL, function () { return 0.5; });
    tip = moves[c.index >= 0 ? c.index : 0]; paint();
    G.say(T('ur.hint'));
  }
  function newGame() {
    st = E.newState(); started = false; last = null; roll = null; moves = []; tip = null; rolling = false;
    buildBoard();
    showDice([false, false, false, false], null, false);
    startTurn();
  }

  rollBtn.addEventListener('click', doRoll);
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input')) return;
    var k = e.key.toLowerCase();
    if ((k === 'r' || (k === ' ' && e.target === document.body)) && !rollBtn.disabled) { e.preventDefault(); doRoll(); }
  });

  if (root.ZimiShell) root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && (st.pos[0].some(function (k) { return k > 0; }) || st.pos[1].some(function (k) { return k > 0; })); } });
  G.newGame();
  G.persist({
    save: function () { return started ? { st: st, last: last, roll: phase === 'move' ? roll : null, phase: phase === 'move' ? 'move' : 'roll' } : null; },
    load: function (d) {
      st = d.st; last = d.last; roll = d.roll; phase = d.phase; tip = null; rolling = false; started = true;
      moves = roll === null ? [] : E.legalMoves(st, roll);
      buildBoard(); showDice([false, false, false, false], null, false);
      if (roll !== null) showDice([0, 1, 2, 3].map(function (i) { return i < roll; }), roll, false);
      paint();
    },
    resume: function () {
      if (G.over) return;
      if (phase === 'roll') { startTurn(); return; }
      var p = st.turn;
      if (G.human(p)) { G.say(T('ur.tap', { name: nameOf(p), n: roll })); return; }
      G.say(T('ur.rolled', { name: nameOf(p), n: roll }), true);
      var t3 = G.begin(); setTimeout(function () { if (!G.done(t3)) return; var c = E.choose(st, roll, G.settings.level); play(moves[c.index >= 0 ? c.index : 0]); }, COMPUTER_MOVE_DELAY_MS);
    }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__ur = { engine: E, state: function () { return st; }, moves: function () { return moves; }, phase: function () { return phase; }, play: play };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
