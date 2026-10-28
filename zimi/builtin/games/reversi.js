/* ZimiGames: Reversi. Our own code, GPL-3.0. No network, no fonts, no modules.
   Two halves: the rules and the computer player (pure functions, testable in node),
   then the page (runs only when there is a document). */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var EMPTY = 0, BLACK = 1, WHITE = 2, N = 8, SIZE = 64;
  var DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  var WIN_SCORE = 100000;
  var EXACT_EMPTIES = 9; // with this few empty squares the computer plays the game out to the end

  // Corners are gold, the squares beside them are poison, edges are good.
  var WEIGHTS = [
    120, -25, 10, 5, 5, 10, -25, 120,
    -25, -45, -2, -2, -2, -2, -45, -25,
    10, -2, 3, 1, 1, 3, -2, 10,
    5, -2, 1, 0, 0, 1, -2, 5,
    5, -2, 1, 0, 0, 1, -2, 5,
    10, -2, 3, 1, 1, 3, -2, 10,
    -25, -45, -2, -2, -2, -2, -45, -25,
    120, -25, 10, 5, 5, 10, -25, 120
  ];
  var LEVELS = { easy: { depth: 1, noise: 40 }, medium: { depth: 3, noise: 0 }, hard: { depth: 5, noise: 0 } };

  function other(p) { return p === BLACK ? WHITE : BLACK; }

  function initial() {
    var b = new Int8Array(SIZE);
    b[27] = WHITE; b[36] = WHITE; b[28] = BLACK; b[35] = BLACK;
    return b;
  }

  // The discs p would flip by playing idx ([] when the move is illegal).
  function flipsFor(b, p, idx) {
    if (b[idx] !== EMPTY) return [];
    var r0 = (idx / N) | 0, c0 = idx % N, out = [], q = other(p);
    for (var d = 0; d < 8; d++) {
      var dr = DIRS[d][0], dc = DIRS[d][1], r = r0 + dr, c = c0 + dc, run = [];
      while (r >= 0 && r < N && c >= 0 && c < N && b[r * N + c] === q) { run.push(r * N + c); r += dr; c += dc; }
      if (run.length && r >= 0 && r < N && c >= 0 && c < N && b[r * N + c] === p) out = out.concat(run);
    }
    return out;
  }

  function legalMoves(b, p) {
    var out = [];
    for (var i = 0; i < SIZE; i++) {
      if (b[i] !== EMPTY) continue;
      var f = flipsFor(b, p, i);
      if (f.length) out.push({ idx: i, flips: f });
    }
    return out;
  }

  // Whether p could play idx, without building the list of flips (the search asks this a lot).
  function canPlay(b, p, idx) {
    if (b[idx] !== EMPTY) return false;
    var r0 = (idx / N) | 0, c0 = idx % N, q = other(p);
    for (var d = 0; d < 8; d++) {
      var dr = DIRS[d][0], dc = DIRS[d][1], r = r0 + dr, c = c0 + dc, n = 0;
      while (r >= 0 && r < N && c >= 0 && c < N && b[r * N + c] === q) { n++; r += dr; c += dc; }
      if (n && r >= 0 && r < N && c >= 0 && c < N && b[r * N + c] === p) return true;
    }
    return false;
  }
  function countMoves(b, p) { var n = 0; for (var i = 0; i < SIZE; i++) if (canPlay(b, p, i)) n++; return n; }
  function hasMove(b, p) {
    for (var i = 0; i < SIZE; i++) if (canPlay(b, p, i)) return true;
    return false;
  }

  function play(b, p, idx, flips) {
    var nb = b.slice(0);
    nb[idx] = p;
    for (var i = 0; i < flips.length; i++) nb[flips[i]] = p;
    return nb;
  }

  function count(b) {
    var k = { black: 0, white: 0, empty: 0 };
    for (var i = 0; i < SIZE; i++) { if (b[i] === BLACK) k.black++; else if (b[i] === WHITE) k.white++; else k.empty++; }
    return k;
  }

  function isOver(b) { return !hasMove(b, BLACK) && !hasMove(b, WHITE); }

  // Who is to move after p has played: the opponent, or p again after a pass, or nobody.
  function nextTurn(b, p) {
    if (hasMove(b, other(p))) return other(p);
    if (hasMove(b, p)) return p;
    return 0;
  }

  // ── the computer ─────────────────────────────────────────────────────────
  function evaluate(b, me) {
    var you = other(me), pos = 0, discs = 0, i;
    for (i = 0; i < SIZE; i++) {
      if (b[i] === me) { pos += WEIGHTS[i]; discs++; } else if (b[i] === you) { pos -= WEIGHTS[i]; discs--; }
    }
    var mine = countMoves(b, me), theirs = countMoves(b, you);
    var mobility = mine + theirs ? 100 * (mine - theirs) / (mine + theirs) : 0;
    return pos + 0.6 * mobility + discs * 0.5;
  }

  function discDiff(b, me) { var k = count(b); return me === BLACK ? k.black - k.white : k.white - k.black; }

  // Moves ordered by their square's weight, so the alpha-beta cut-offs come early.
  function ordered(b, p) {
    var m = legalMoves(b, p);
    m.sort(function (x, y) { return WEIGHTS[y.idx] - WEIGHTS[x.idx]; });
    return m;
  }

  // Negamax from `p`'s side: the score is for p. `me` stays the side the leaf eval is read for.
  function search(b, p, depth, alpha, beta, exact) {
    var moves = ordered(b, p);
    if (!moves.length) {
      var opp = ordered(b, other(p));
      if (!opp.length) { var d = discDiff(b, p); return d === 0 ? 0 : (d > 0 ? WIN_SCORE : -WIN_SCORE) + d; }
      return -search(b, other(p), depth, -beta, -alpha, exact);
    }
    if (depth <= 0 && !exact) return evaluate(b, p);
    var best = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var s = -search(play(b, p, moves[i].idx, moves[i].flips), other(p), depth - 1, -beta, -alpha, exact);
      if (s > best) best = s;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  // The computer's move at a level: { idx, flips } or null when it must pass.
  function chooseMove(b, p, level, rng) {
    var moves = ordered(b, p);
    if (!moves.length) return null;
    if (moves.length === 1) return moves[0];
    var cfg = LEVELS[level] || LEVELS.medium, rand = rng || Math.random;
    var empties = count(b).empty, exact = level === 'hard' && empties <= EXACT_EMPTIES;
    var depth = exact ? empties : cfg.depth, best = null, bestScore = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var nb = play(b, p, moves[i].idx, moves[i].flips);
      var s = depth <= 1 && !exact ? -evaluate(nb, other(p)) : -search(nb, other(p), depth - 1, -Infinity, Infinity, exact);
      if (cfg.noise && !exact) s += (rand() - 0.5) * 2 * cfg.noise;
      if (s > bestScore) { bestScore = s; best = moves[i]; }
    }
    return best;
  }

  var Engine = {
    EMPTY: EMPTY, BLACK: BLACK, WHITE: WHITE, N: N, LEVELS: LEVELS,
    other: other, initial: initial, flipsFor: flipsFor, legalMoves: legalMoves, hasMove: hasMove, play: play,
    count: count, isOver: isOver, nextTurn: nextTurn, chooseMove: chooseMove, evaluate: evaluate
  };
  root.ReversiEngine = Engine;

  // ── the page ─────────────────────────────────────────────────────────────
  if (typeof document === 'undefined' || !root.BoardUI) return;
  var BK = root.BoardKit, WK = root.WorldKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var COMPUTER_DELAY_MS = 450, HINT_DELAY_MS = 40;
  var G = WK.create({
    id: 'reversi',
    options: WK.standardOptions({ first: 'reversi.black.first', second: 'board.white' }),
    onNew: newGame, onUndo: undo, onHint: hint
  });
  var score = WK.scoreBar($('wk-score'), [{ color: 'var(--disc-b)' }, { color: 'var(--disc-w)' }]);
  var board = $('rv-board'), cells = [], state, history = [], lastMove = -1, flipped = [], cueAt = -1, note = '', glide = null;

  function idxOf(p) { return p === BLACK ? 0 : 1; }
  function sideName(p) { return UI.side(p === BLACK ? 'black' : 'white'); }
  function humanNow() { return !G.over && !G.thinking && G.human(idxOf(state.turn)); }
  // Show legal moves is the shell's Hints setting (Menu > Settings), not a New game option.
  function hintsOn() { return !root.ZimiShell || root.ZimiShell.settings.get('hints') !== 'off'; }
  function nameOf(p) { return G.vsComputer() && !G.watching ? (G.human(idxOf(p)) ? T('board.you') : T('board.zimi')) : sideName(p); }

  function buildBoard() {
    board.textContent = '';
    for (var i = 0; i < SIZE; i++) {
      var c = document.createElement('button');
      c.type = 'button'; c.className = 'bg-sq'; c.dataset.i = i;
      c.addEventListener('click', onSquare);
      board.appendChild(c); cells.push(c);
    }
    BK.gridNav(board, cells, N);
  }

  function coord(i) { return 'abcdefgh'[i % N] + (N - ((i / N) | 0)); }

  function paint() {
    var b = state.board, legal = {}, moves = G.over ? [] : legalMoves(b, state.turn), i;
    if (hintsOn() && humanNow()) moves.forEach(function (m) { legal[m.idx] = 1; });
    for (i = 0; i < SIZE; i++) {
      var c = cells[i], v = b[i], disc = c.firstChild;
      if (v && !disc) { disc = document.createElement('span'); c.appendChild(disc); }
      if (!v && disc) { c.removeChild(disc); disc = null; }
      if (disc) disc.className = 'rv-disc ' + (v === BLACK ? 'b' : 'w') + (flipped.indexOf(i) >= 0 ? ' flip' : '');
      c.className = 'bg-sq' + ((i + ((i / N) | 0)) % 2 ? ' dk' : '') + (i === cueAt ? ' hint cap' : legal[i] ? ' hint' : '') + (i === lastMove ? ' last' : '');
      c.setAttribute('aria-label', T('reversi.sq', { sq: coord(i), what: T(v === BLACK ? 'reversi.black' : v === WHITE ? 'reversi.white' : legal[i] ? 'reversi.legal' : 'go.pt.empty') }));
    }
    var k = count(b);
    score(G.names(sideName(BLACK), sideName(WHITE)), [k.black, k.white], G.over ? -1 : idxOf(state.turn));
    G.setUndo(history.length > 0 && !G.watching);
    G.setHint(humanNow() && !G.watching);
  }

  function turnText(next) {
    if (G.vsComputer() && !G.watching) return G.human(idxOf(next)) ? T('board.yourTurn') : T('shell.thinking');
    return T('board.toMove', { name: sideName(next) });
  }

  function finish() {
    var k = count(state.board);
    if (k.black === k.white) { G.finish(T('reversi.draw', { n: k.black }), 'd'); return; }
    var w = k.black > k.white ? BLACK : WHITE, top = Math.max(k.black, k.white), low = Math.min(k.black, k.white);
    G.finish(T('reversi.score', { top: top, low: low }), G.vsComputer() ? (G.human(idxOf(w)) ? 'w' : 'l') : null, sideName(w));
  }

  function afterMove() {
    var p = state.turn, next = nextTurn(state.board, p);
    if (!next) { paint(); finish(); return; }
    var passed = next === p ? other(p) : 0;
    state.turn = next;
    paint();
    var line = turnText(next);
    if (passed) line = T('reversi.passes', { name: nameOf(passed), n: G.vsComputer() && !G.watching && G.human(idxOf(passed)) ? 2 : 1, line: line });
    if (note && !passed && G.human(idxOf(next))) line = UI.noted(note, line);
    note = '';
    G.say(line, !G.human(idxOf(next)) && !G.watching);
    if (root.ZimiShell && !G.watching) root.ZimiShell.turn(G.human(idxOf(next)), timeUp, history.length);
    if (!G.human(idxOf(next))) scheduleComputer();
  }

  function commit(idx, flips) {
    history.push({ board: state.board, turn: state.turn, last: lastMove });
    var p = state.turn;
    state = { board: play(state.board, p, idx, flips), turn: p };
    lastMove = idx; flipped = BK.reducedMotion() ? [] : flips; cueAt = -1;
    note = G.vsComputer() && !G.watching && !G.human(idxOf(p)) ? T('reversi.cpu', { sq: coord(idx) }) : '';
    afterMove();
  }

  function scheduleComputer() {
    paint();
    G.later(function () {
      var m = chooseMove(state.board, state.turn, G.settings.level);
      if (!m) return;
      var ctl = G.watching;
      if (!ctl) { commit(m.idx, m.flips); return; }
      var why = root.ZimiExplain.reversi(Engine, state.board, state.turn, m);
      ctl.offer(why.text, function () { if (G.watching === ctl && !G.over) commit(m.idx, m.flips); });
    }, COMPUTER_DELAY_MS);
  }

  // The move timer ran out: a quick computer choice is played for the person.
  function timeUp() {
    if (G.over || G.thinking || !G.human(idxOf(state.turn))) return;
    var m = chooseMove(state.board, state.turn, 'easy');
    if (!m) return;
    G.say(T('board.timeUp'));
    commit(m.idx, m.flips);
  }

  function onSquare(e) {
    if (!humanNow()) return;
    var i = +e.currentTarget.dataset.i, f = flipsFor(state.board, state.turn, i);
    if (!f.length) { G.refuse(cells[i], T(state.board[i] ? 'reversi.taken' : 'reversi.noFlip')); return; }
    commit(i, f);
  }

  // Hint: the engine's best square, ringed.
  function hint() {
    if (!humanNow() || G.watching) return;
    var token = G.begin(); paint(); G.say(T('board.thinkingHint'), true);
    setTimeout(function () {
      if (!G.done(token)) return;
      var m = chooseMove(state.board, state.turn, 'hard');
      cueAt = m ? m.idx : -1; paint(); G.say(T(m ? 'reversi.hint' : 'board.yourTurn'));
    }, HINT_DELAY_MS);
  }

  function undo() {
    if (!history.length || G.watching) return;
    G.cancel(); G.over = false; flipped = []; cueAt = -1; note = '';
    var h;
    do { h = history.pop(); } while (history.length && G.vsComputer() && !G.human(idxOf(h.turn)));
    state = { board: h.board, turn: h.turn }; lastMove = h.last;
    paint(); G.say(turnText(state.turn));
    if (!G.human(idxOf(state.turn))) scheduleComputer();
  }

  function newGame() {
    history = []; lastMove = -1; flipped = [];
    state = { board: initial(), turn: BLACK };
    paint();
    G.say(turnText(BLACK), !G.human(0) && !G.watching);
    if (root.ZimiShell && !G.watching) root.ZimiShell.turn(G.human(0), timeUp, 0);
    if (!G.human(0)) scheduleComputer();
  }

  if (root.ZimiShell) {
    root.ZimiShell.settings.on(function (k) { if (k === 'hints' || k === '*') paint(); });
    root.ZimiShell.game({ moveTimer: true, hints: true, inProgress: function () { return !G.over && history.length > 0; } });
  }
  G.registerWatch({
    script: 'explain-reversi.js', unit: 'move', level: 'medium', intro: 'reversi.watch.intro',
    whoseTurn: function () { return idxOf(state.turn); },
    resume: function () { paint(); G.say(turnText(state.turn)); if (root.ZimiShell) root.ZimiShell.turn(true, timeUp, history.length); }
  });

  buildBoard();
  G.newGame();
  G.persist({
    save: function () { return history.length ? { state: state, history: history.slice(-40), lastMove: lastMove } : null; },
    load: function (d) { state = d.state; history = d.history; lastMove = d.lastMove; flipped = []; paint(); },
    resume: function () {
      G.say(turnText(state.turn), !G.human(idxOf(state.turn)));
      if (root.ZimiShell) root.ZimiShell.turn(G.human(idxOf(state.turn)), timeUp, history.length);
      if (!G.human(idxOf(state.turn))) scheduleComputer();
    }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__rv = { G: G, state: function () { return state; }, engine: Engine, settings: G.settings };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
