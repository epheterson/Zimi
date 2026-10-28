/* ZimiGames: Mancala, two rule sets: Oware (abapa) and Kalah (6 pits, 4 seeds).
   Our own code, GPL-3.0. The rules and the computer (pure functions, testable in node),
   then the page. */
(function (root) {
  'use strict';

  var WIN_SCORE = 10000;
  var QUIET_LIMIT = 90; // Oware: this many moves without a capture and the game is called
  var LEVELS = { easy: { depth: 1, noise: 6 }, medium: { depth: 5, noise: 0 }, hard: { depth: 9, noise: 0 } };

  function sideOf(i) { return i < 6 ? 0 : 1; } // pits 0..5 are the first player's

  // ── Oware (abapa) ────────────────────────────────────────────────────────
  // Twelve pits, no stores. Pits 0..5 run left to right along the first player's row, 6..11
  // along the other's, so sowing is counterclockwise by adding one.
  var Oware = {
    id: 'oware', size: 12, stores: false, target: 25,
    newState: function () { var p = new Int8Array(12).fill(4); return { pits: p, score: [0, 0], turn: 0, quiet: 0, done: false }; },
    side: sideOf,
    seedsOn: function (s, side) { var t = 0, i; for (i = side * 6; i < side * 6 + 6; i++) t += s.pits[i]; return t; },
    // The pits the side to move may play. When the other side is empty the move has to feed it.
    moves: function (s) {
      var out = [], me = s.turn, i, opp = Oware.seedsOn(s, 1 - me);
      for (i = me * 6; i < me * 6 + 6; i++) if (s.pits[i]) out.push(i);
      if (opp) return out;
      return out.filter(function (p) { var t = Oware.sow(s, p, true); return t && Oware.seedsOn(t, 1 - me) > 0; });
    },
    // Sow pit p. `bare` skips the bookkeeping at the end (used to test the feeding rule).
    sow: function (s, p, bare) {
      var pits = s.pits.slice(0), me = s.turn, n = pits[p], path = [], i = p, k;
      pits[p] = 0;
      for (k = 0; k < n; k++) { i = (i + 1) % 12; if (i === p) i = (i + 1) % 12; pits[i]++; path.push(i); }
      var t = { pits: pits, score: s.score.slice(0), turn: 1 - me, quiet: s.quiet + 1, done: false };
      var res = { state: t, path: path, captured: [], swept: [], extra: false, grandSlam: false };
      if (bare) return t;
      // Capture: the last seed made an opponent pit two or three; so do the pits behind it.
      if (sideOf(i) !== me && (pits[i] === 2 || pits[i] === 3)) {
        var j = i, take = [];
        while (sideOf(j) !== me && (pits[j] === 2 || pits[j] === 3)) { take.push(j); j = (j + 11) % 12; }
        var all = Oware.seedsOn(t, 1 - me), sum = take.reduce(function (a, q) { return a + pits[q]; }, 0);
        if (sum === all) res.grandSlam = true; // a grand slam is played but takes nothing
        else take.forEach(function (q) { res.captured.push({ pit: q, n: pits[q] }); t.score[me] += pits[q]; pits[q] = 0; t.quiet = 0; });
      }
      Oware.settle(t, res);
      return res;
    },
    // The game ends at 25, when the side to move has no move, or when nothing has been taken for long.
    settle: function (t, res) {
      var done = t.score[0] >= 25 || t.score[1] >= 25;
      if (!done && (!Oware.moves(t).length || t.quiet >= QUIET_LIMIT)) {
        for (var i = 0; i < 12; i++) if (t.pits[i]) { res.swept.push({ pit: i, n: t.pits[i], to: sideOf(i) }); t.score[sideOf(i)] += t.pits[i]; t.pits[i] = 0; }
        done = true;
      }
      t.done = done;
    },
    evaluate: function (s, me) {
      return (s.score[me] - s.score[1 - me]) * 10 + (Oware.seedsOn(s, me) - Oware.seedsOn(s, 1 - me)) * 0.35 + (s.turn === me ? 0.5 : -0.5);
    }
  };

  // ── Kalah ────────────────────────────────────────────────────────────────
  // Fourteen slots: 0..5 the first player's pits, 6 their store, 7..12 the other's pits
  // (7 sits at the far right), 13 their store. Sowing adds one and skips the other's store.
  var Kalah = {
    id: 'kalah', size: 14, stores: true, target: 25,
    newState: function () { var p = new Int8Array(14).fill(4); p[6] = 0; p[13] = 0; return { pits: p, score: [0, 0], turn: 0, quiet: 0, done: false }; },
    side: function (i) { return i < 7 ? 0 : 1; },
    store: function (side) { return side ? 13 : 6; },
    seedsOn: function (s, side) { var t = 0, i; for (i = side * 7; i < side * 7 + 6; i++) t += s.pits[i]; return t; },
    moves: function (s) { var out = [], i; for (i = s.turn * 7; i < s.turn * 7 + 6; i++) if (s.pits[i]) out.push(i); return out; },
    sow: function (s, p) {
      var pits = s.pits.slice(0), me = s.turn, n = pits[p], path = [], i = p, k, skip = Kalah.store(1 - me), mine = Kalah.store(me);
      pits[p] = 0;
      for (k = 0; k < n; k++) { i = (i + 1) % 14; if (i === skip) i = (i + 1) % 14; pits[i]++; path.push(i); }
      var extra = i === mine, captured = [];
      if (!extra && Kalah.side(i) === me && i !== mine && pits[i] === 1 && pits[12 - i] > 0) {
        var opp = 12 - i;
        captured.push({ pit: opp, n: pits[opp] }, { pit: i, n: 1 });
        pits[mine] += pits[opp] + 1; pits[opp] = 0; pits[i] = 0;
      }
      var t = { pits: pits, score: [pits[6], pits[13]], turn: extra ? me : 1 - me, quiet: 0, done: false };
      var res = { state: t, path: path, captured: captured, swept: [], extra: extra, grandSlam: false };
      // A side with no seeds left ends the game: the other side keeps what is on its row.
      if (!Kalah.seedsOn(t, 0) || !Kalah.seedsOn(t, 1)) {
        for (var q = 0; q < 14; q++) if (q !== 6 && q !== 13 && pits[q]) { var o = Kalah.side(q); res.swept.push({ pit: q, n: pits[q], to: o }); pits[Kalah.store(o)] += pits[q]; pits[q] = 0; }
        t.score = [pits[6], pits[13]]; t.done = true;
      }
      return res;
    },
    evaluate: function (s, me) {
      return (s.score[me] - s.score[1 - me]) * 10 + (Kalah.seedsOn(s, me) - Kalah.seedsOn(s, 1 - me)) * 0.4 + (s.turn === me ? 1 : -1);
    }
  };

  var RULES = { oware: Oware, kalah: Kalah };
  // The result of a finished game: 0 or 1 won, -1 a draw.
  function result(s) {
    if (s.score[0] === s.score[1]) return -1;
    return s.score[0] > s.score[1] ? 0 : 1;
  }

  // ── the computer ─────────────────────────────────────────────────────────
  // Minimax with alpha-beta from `me`'s side; an extra turn keeps the same side moving.
  function search(R, s, depth, alpha, beta, me) {
    if (s.done) { var r = result(s); return r < 0 ? 0 : r === me ? WIN_SCORE + depth : -WIN_SCORE - depth; }
    if (depth <= 0) return R.evaluate(s, me);
    var ms = R.moves(s), best, i, v;
    if (s.turn === me) {
      best = -Infinity;
      for (i = 0; i < ms.length; i++) { v = search(R, R.sow(s, ms[i]).state, depth - 1, alpha, beta, me); if (v > best) best = v; if (best > alpha) alpha = best; if (alpha >= beta) break; }
    } else {
      best = Infinity;
      for (i = 0; i < ms.length; i++) { v = search(R, R.sow(s, ms[i]).state, depth - 1, alpha, beta, me); if (v < best) best = v; if (best < beta) beta = best; if (alpha >= beta) break; }
    }
    return best;
  }
  function chooseMove(rules, s, level, rng) {
    var R = RULES[rules], cfg = LEVELS[level] || LEVELS.medium, rand = rng || Math.random, ms = R.moves(s), me = s.turn;
    if (!ms.length) return -1;
    if (ms.length === 1) return ms[0];
    var best = -Infinity, pick = ms[0];
    for (var i = 0; i < ms.length; i++) {
      var v = search(R, R.sow(s, ms[i]).state, cfg.depth - 1, -Infinity, Infinity, me) + (cfg.noise ? (rand() - 0.5) * cfg.noise * 2 : 0);
      if (v > best) { best = v; pick = ms[i]; }
    }
    return pick;
  }

  root.MancalaEngine = { Oware: Oware, Kalah: Kalah, RULES: RULES, LEVELS: LEVELS, result: result, chooseMove: chooseMove };

  // ── the page ─────────────────────────────────────────────────────────────
  if (typeof document === 'undefined' || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, UNIT = 62, PAD = 14, PIT_R = 26, ROW_H = 84;
  var SEED_COLORS = ['#c8553d', '#2a8c82', '#e8d9b0', '#d99a2b', '#6c5ba7'];
  function sideName(p) { return T(p === 0 ? 'mancala.south' : 'mancala.north'); }
  var host = document.getElementById('wk-board'), svgPits, btns = [], R = Oware, cols = 6, W = 0, H = 0, posOf = [];
  var state, shown, history = WK.History(), lastPit = -1, flashed = [], animating = false, hintPit = -1, passInfo = '';
  var score = WK.scoreBar(document.getElementById('wk-score'), [{ color: '#c8553d' }, { color: '#2a8c82' }]);
  var G = WK.create({
    id: 'mancala',
    options: [{ key: 'rules', legend: 'mancala.game', def: 'oware', choices: [['oware', 'mancala.oware'], ['kalah', 'mancala.kalah']] }].concat(WK.standardOptions({ first: 'mancala.southFirst', second: 'mancala.north' })),
    statKey: function (s) { return s.rules + s.level; },
    onNew: newGame, onUndo: undo, onHint: hint
  });

  function layout() {
    R = RULES[G.settings.rules]; cols = R.stores ? 8 : 6;
    W = cols * UNIT + 2 * PAD; H = 2 * ROW_H + 2 * PAD;
    posOf = [];
    var left = R.stores ? 1 : 0, i, cx, cy;
    for (i = 0; i < R.size; i++) {
      var side = R.side(i), col;
      if (R.stores && (i === 6 || i === 13)) { posOf[i] = { x: PAD + (i === 13 ? 0 : 7) * UNIT + UNIT / 2, y: H / 2, store: true }; continue; }
      if (R.stores) col = side === 0 ? i + left : 6 - (i - 7) ; else col = side === 0 ? i : 11 - i;
      posOf[i] = { x: PAD + col * UNIT + UNIT / 2, y: side === 0 ? PAD + ROW_H * 1.5 : PAD + ROW_H * 0.5, store: false };
    }
  }
  // A ring round a pit (a round one) or round a store (a tall one).
  function ringFor(p, cls) {
    if (p.store) return '<rect x="' + (p.x - 28) + '" y="' + (PAD + 3) + '" width="56" height="' + (H - 2 * PAD - 6) + '" rx="28" class="' + cls + '"/>';
    return '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (PIT_R + 3) + '" class="' + cls + '"/>';
  }
  function seedXY(p, k) {
    var a = k * 2.399963, r = 4.4 * Math.sqrt(k + 0.6);
    return [p.x + r * Math.cos(a), p.y + r * Math.sin(a)];
  }

  function buildBoard() {
    layout();
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true"><rect width="' + W + '" height="' + H + '" rx="22" class="mc-wood"/>';
    for (var i = 0; i < R.size; i++) {
      var p = posOf[i];
      s += p.store ? '<rect x="' + (p.x - 25) + '" y="' + (PAD + 6) + '" width="50" height="' + (H - 2 * PAD - 12) + '" rx="25" class="mc-pit mc-store"/>' : '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + PIT_R + '" class="mc-pit"/>';
    }
    s += '<g id="mc-seeds"></g><g id="mc-marks"></g></svg>';
    host.innerHTML = s;
    svgPits = { seeds: host.querySelector('#mc-seeds'), marks: host.querySelector('#mc-marks') };
    var pts = [], idx = [];
    for (var j = 0; j < R.size; j++) { if (posOf[j].store) continue; pts.push({ x: posOf[j].x, y: posOf[j].y, w: UNIT - 4, h: ROW_H - 4 }); idx.push(j); }
    var raw = WK.overlay(host, W, H, pts, function (k) { onPit(idx[k]); }, 'mc-pit-btn');
    btns = []; raw.forEach(function (b, k) { btns[idx[k]] = b; });
  }

  function seedsHtml(i, n) {
    var p = posOf[i], out = '', shownN = Math.min(n, p.store ? 24 : 16), k;
    for (k = 0; k < shownN; k++) {
      var q = p.store ? [p.x + ((k % 3) - 1) * 12, p.y - 62 + ((k / 3) | 0) * 11] : seedXY(p, k);
      out += '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="5.2" fill="' + SEED_COLORS[(i + k) % SEED_COLORS.length] + '" class="mc-seed"/>';
    }
    var ly = p.store ? p.y + 84 : (R.side(i) === 0 ? p.y + PIT_R + 15 : p.y - PIT_R - 5);
    if (p.store) ly = p.y + 66;
    out += '<text x="' + p.x + '" y="' + ly + '" text-anchor="middle" class="mc-count' + (n === 0 ? ' z' : '') + '">' + n + '</text>';
    return out;
  }

  function paint() {
    var s = '', m = '', i, open = !G.over && !G.thinking && !animating && G.human(state.turn), legal = R.moves(state);
    for (i = 0; i < R.size; i++) s += seedsHtml(i, shown[i]);
    svgPits.seeds.innerHTML = s;
    legal.forEach(function (j) { if (open) { var o = posOf[j]; m += '<circle cx="' + o.x + '" cy="' + o.y + '" r="' + (PIT_R + 2) + '" class="mc-ok"/>'; } });
    if (lastPit >= 0) { var l = posOf[lastPit]; m += ringFor(l, 'mc-last'); }
    flashed.forEach(function (j) { var f = posOf[j]; if (!f.store) m += ringFor(f, 'mc-cap'); });
    if (hintPit >= 0) { var h = posOf[hintPit]; m += '<circle cx="' + h.x + '" cy="' + h.y + '" r="' + (PIT_R + 4) + '" class="mc-hint"/>'; }
    svgPits.marks.innerHTML = m;
    btns.forEach(function (bt, j) {
      if (!bt) return;
      var mine = legal.indexOf(j) >= 0 && open;
      bt.setAttribute('aria-label', T('mancala.pit', { side: sideName(R.side(j)), pit: j - R.side(j) * (R.stores ? 7 : 6) + 1, n: shown[j] }));
      bt.setAttribute('aria-disabled', mine ? 'false' : 'true');
      bt.classList.toggle('mc-legal', mine);
    });
    score(G.names(sideName(0), sideName(1)), state.score, G.over ? -1 : state.turn);
    G.setUndo(history.size() > 0 && !animating && !G.watching); G.setHint(open);
    G.turnTimer(open, timeUp, history.size());
  }

  function turnText() {
    var p = state.turn;
    if (!G.vsComputer()) return T('go.toPlay', { name: sideName(p) });
    return G.human(p) ? T('board.yourTurn') : T('shell.thinking');
  }

  function onPit(i) {
    if (G.over || G.thinking || animating || !G.human(state.turn)) return;
    if (R.side(i) !== state.turn || R.moves(state).indexOf(i) < 0) { G.refuse(btns[i], T(R.side(i) !== state.turn ? 'mancala.notYours' : 'mancala.emptyPit')); return; }
    move(i);
  }

  function describe(mover, res) {
    var you = G.vsComputer() && !G.watching && G.human(mover), who = G.vsComputer() ? (G.human(mover) ? T('board.you') : T('board.zimi')) : sideName(mover);
    var took = res.captured.reduce(function (a, c) { return a + c.n; }, 0);
    if (res.captured.length) return T('mancala.captured', { name: who, n: took });
    if (res.grandSlam) return T('mancala.grandSlam', { name: who });
    if (res.extra) return T(you ? 'mancala.again.you' : 'mancala.again', { name: who });
    return '';
  }

  // Sow with the seeds moving one at a time (or all at once for reduced motion), then apply.
  function move(p) {
    history.push({ state: state, last: lastPit });
    var mover = state.turn, res = R.sow(state, p), disp = state.pits.slice(0), step = 0, info = describe(mover, res);
    hintPit = -1; flashed = []; animating = true;
    function finishMove() {
      animating = false; state = res.state; shown = state.pits.slice(0); lastPit = res.path.length ? res.path[res.path.length - 1] : p;
      flashed = res.captured.map(function (c) { return c.pit; });
      if (res.swept.length) info = (info + ' ' + T('mancala.swept')).trim();
      paint();
      if (state.done) { endGame(info); return; }
      // A second turn is its own line (it already says who plays next); otherwise what happened, then whose turn, if both fit.
      G.say(!info ? turnText() : res.extra ? info : UI.noted(info, turnText()), !G.human(state.turn));
      if (!G.human(state.turn)) G.later(computerMove);
    }
    if (BK.reducedMotion()) { finishMove(); return; }
    disp[p] = 0; shown = disp; lastPit = p; paint();
    var delay = Math.min(170, Math.max(60, 2400 / Math.max(1, res.path.length)));
    (function tick() {
      if (step >= res.path.length) { setTimeout(finishMove, 120); return; }
      disp[res.path[step++]]++; shown = disp; lastPit = res.path[step - 1]; paint();
      setTimeout(tick, delay);
    })();
  }

  // The computer's move; in Watch and learn it is explained first and made when the driver says.
  function computerMove() {
    var p = chooseMove(G.settings.rules, state, G.settings.level);
    var ctl = G.watching;
    if (!ctl) { move(p); return; }
    var why = root.ZimiExplain.mancala(R, state, p);
    ctl.offer(why.text, function () { if (G.watching === ctl && !G.over) move(p); });
  }

  // The move timer ran out: a quick computer choice is played for the person.
  function timeUp() {
    if (G.over || animating || !G.human(state.turn)) return;
    G.say(T('board.timeUp'));
    move(chooseMove(G.settings.rules, state, 'easy'));
  }

  function endGame(info) {
    var w = result(state), s = state.score, msg;
    if (w < 0) msg = T('reversi.draw', { n: s[0] });
    else msg = T('reversi.score', { top: Math.max(s[0], s[1]), low: Math.min(s[0], s[1]) });
    G.finish((info ? info + ' ' : '') + msg, w < 0 ? 'd' : G.vsComputer() ? (G.human(w) ? 'w' : 'l') : null, w >= 0 ? sideName(w) : undefined);
  }

  function hint() {
    hintPit = chooseMove(G.settings.rules, state, 'hard');
    paint(); G.say(T('mancala.hint'));
  }

  function undo() {
    if (!history.size() || animating) return;
    G.cancel(); G.over = false; hintPit = -1; flashed = [];
    var h;
    do { h = history.pop(); } while (history.size() && G.vsComputer() && !G.human(h.state.turn));
    state = h.state; shown = state.pits.slice(0); lastPit = h.last;
    paint(); G.say(turnText());
    if (!G.human(state.turn)) G.later(computerMove);
  }

  function newGame() {
    animating = false;
    if (!svgPits || R.id !== G.settings.rules) buildBoard();
    history.clear(); lastPit = -1; flashed = []; hintPit = -1;
    state = R.newState(); shown = state.pits.slice(0);
    paint(); G.say(turnText(), !G.human(0));
    if (!G.human(0)) G.later(computerMove);
  }

  G.registerWatch({
    script: 'explain-mancala.js', unit: 'move', level: 'medium',
    intro: 'mancala.watch.intro',
    whoseTurn: function () { return state.turn; },
    busy: function () { return animating; },
    resume: function () { paint(); G.say(turnText()); }
  });
  if (root.ZimiShell) root.ZimiShell.game({
    moveTimer: true, hints: true,
    help: function () { return { turn: T('mancala.help.' + G.settings.rules + '.turn'), end: T('mancala.help.' + G.settings.rules + '.end') }; },
    inProgress: function () { return !G.over && history.size() > 0; }
  });

  G.newGame();
  G.persist({
    // mid-sow the move is not on the board yet: keep the position before it
    save: function () { var h = history.all(); if (animating) h = h.slice(0, -1); return h.length || (animating && history.size()) ? { state: animating ? history.last().state : state, history: h, last: animating ? history.last().last : lastPit } : null; },
    load: function (d) { animating = false; buildBoard(); state = d.state; shown = state.pits.slice(0); history.set(d.history); lastPit = d.last; flashed = []; hintPit = -1; paint(); },
    resume: function () { G.say(turnText(), !G.human(state.turn)); if (!G.human(state.turn)) G.later(computerMove); }
  });
  if (new URLSearchParams(location.search).has('debug')) root.__mc = { state: function () { return state; }, engine: root.MancalaEngine };
})(typeof globalThis !== 'undefined' ? globalThis : this);
