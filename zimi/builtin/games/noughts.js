/* ZimiGames: Tic-Tac-Toe. Our own code, GPL-3.0. No network, no fonts, no modules.
   The rules and the computer (pure functions, no DOM, so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  var EASY_TAKES_WIN = 0.6, EASY_BLOCKS = 0.35; // the easy computer sees a win or a block only some of the time

  var mulberry = root.ZimiUtil.mulberry32;

  function emptyBoard() { return [null, null, null, null, null, null, null, null, null]; }
  // The winning line, [a, b, c], or null.
  function winLine(b) {
    for (var i = 0; i < LINES.length; i++) { var l = LINES[i]; if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[0]] === b[l[2]]) return l; }
    return null;
  }
  function winner(b) { var l = winLine(b); return l ? b[l[0]] : null; }
  function full(b) { return b.every(Boolean); }
  function moves(b) { var m = []; for (var i = 0; i < 9; i++) if (!b[i]) m.push(i); return m; }
  function other(p) { return p === 'X' ? 'O' : 'X'; }
  function play(b, i, p) { if (b[i] || winner(b)) return false; b[i] = p; return true; }

  // Minimax from the point of view of `me`, to move as `turn`: a win scores more the sooner it comes.
  function value(b, turn, me, depth, memo) {
    var w = winner(b);
    if (w) return w === me ? 10 - depth : depth - 10;
    if (full(b)) return 0;
    var key = b.join('-') + turn, seen = memo[key]; // the same position reached by another order of moves
    if (seen !== undefined) return seen;
    var best = turn === me ? -99 : 99;
    for (var i = 0; i < 9; i++) {
      if (b[i]) continue;
      b[i] = turn;
      var v = value(b, other(turn), me, depth + 1, memo);
      b[i] = null;
      if (turn === me ? v > best : v < best) best = v;
    }
    memo[key] = best;
    return best;
  }
  // Every best move for `me`.
  function perfectMoves(b, me) {
    var best = -99, out = [], memo = {};
    moves(b).forEach(function (i) {
      b[i] = me; var v = value(b, other(me), me, 1, memo); b[i] = null;
      if (v > best) { best = v; out = [i]; } else if (v === best) out.push(i);
    });
    return out;
  }
  // A move that wins at once for `p`, or -1.
  function winningMove(b, p) {
    var m = moves(b);
    for (var k = 0; k < m.length; k++) { b[m[k]] = p; var w = winner(b) === p; b[m[k]] = null; if (w) return m[k]; }
    return -1;
  }
  function pick(list, rng) { return list[Math.floor(rng() * list.length)]; }

  // The computer's move as `me`: 'hard' never loses; 'easy' mostly plays at random.
  function bestMove(b, me, level, rng) {
    rng = rng || Math.random;
    var open = moves(b);
    if (!open.length) return -1;
    if (level !== 'easy') return pick(perfectMoves(b, me), rng);
    var win = winningMove(b, me), block = winningMove(b, other(me));
    if (win >= 0 && rng() < EASY_TAKES_WIN) return win;
    if (block >= 0 && rng() < EASY_BLOCKS) return block;
    return pick(open, rng);
  }

  var Engine = { LINES: LINES, emptyBoard: emptyBoard, winLine: winLine, winner: winner, full: full, moves: moves, other: other, play: play, bestMove: bestMove, perfectMoves: perfectMoves, mulberry: mulberry };
  root.NoughtsEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var SETTINGS_KEY = 'zimi.games.noughts.settings', STATS_KEY = 'zimi.games.noughts.stats', CPU_DELAY_MS = 420, END_AFTER_MS = 900;
  Play.applyTheme();

  var els = { board: $('nc-board'), msg: $('nc-msg'), a: $('nc-a'), b: $('nc-b'), d: $('nc-d'), aName: $('nc-a-name'), bName: $('nc-b-name'), nu: $('nc-new') };
  var line = Play.status(els.msg);
  var settings = Play.load(SETTINGS_KEY, { opp: 'cpu', level: 'hard', mark: 'X' }), stats = Play.load(STATS_KEY, { a: 0, b: 0, d: 0 });
  if (settings.level === 'perfect') settings.level = 'hard';   // the level used to be called Perfect
  var board = emptyBoard(), turn = 'X', over = true, timer = null, cells = [], me = 'X', cpu = null;

  function build() {
    els.board.textContent = '';
    cells = [];
    for (var i = 0; i < 9; i++) {
      var c = document.createElement('button'); c.type = 'button'; c.className = 'nc-cell'; c.setAttribute('role', 'gridcell');
      (function (n) { c.addEventListener('click', function () { click(n); }); })(i);
      els.board.appendChild(c); cells.push(c);
    }
    els.board.addEventListener('keydown', function (e) {
      var i = cells.indexOf(document.activeElement); if (i < 0) return;
      var d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key]; if (!d) return;
      e.preventDefault();
      var k = i + d; if (k >= 0 && k < 9 && !(Math.abs(d) === 1 && Math.floor(k / 3) !== Math.floor(i / 3))) cells[k].focus();
    });
  }
  function paint() {
    var win = winLine(board);
    cells.forEach(function (c, i) {
      var m = board[i];
      if (m) c.dataset.m = m; else delete c.dataset.m;
      c.setAttribute('aria-label', T('noughts.cell', { row: Math.floor(i / 3) + 1, col: i % 3 + 1, mark: T(m ? 'noughts.mark.' + m : 'noughts.empty') }));
      c.setAttribute('aria-disabled', String(!!m || over || (cpu !== null && turn === cpu)));
      c.classList.toggle('nc-win', !!win && win.indexOf(i) >= 0);
    });
    els.a.textContent = Play.num(stats.a); els.b.textContent = Play.num(stats.b); els.d.textContent = Play.num(stats.d);
    els.aName.textContent = T(settings.opp === 'cpu' ? 'noughts.you' : 'noughts.mark.X'); els.bName.textContent = T(settings.opp === 'cpu' ? 'noughts.computer' : 'noughts.mark.O');
  }

  function say() {
    if (over) return;
    if (settings.opp === 'two') line.say(T('noughts.toPlay', { mark: T('noughts.mark.' + turn) }));
    else line.say(turn === cpu ? T('shell.thinking') : T('noughts.yourTurn'));
  }
  // replay: a finished game coming back from a save shows its end sheet again without counting twice.
  function end(replay) {
    var w = winner(board), result, opts = { after: replay ? 0 : END_AFTER_MS };
    over = true;
    if (w) {
      var mine = settings.opp === 'cpu' ? (w === me ? 'a' : 'b') : (w === 'X' ? 'a' : 'b');
      if (!replay) stats[mine]++;
      if (settings.opp === 'cpu') result = w === me ? 'win' : 'lose';
      else { result = 'win'; opts.name = T('noughts.mark.' + w); }
    } else { if (!replay) stats.d++; result = 'draw'; }
    opts.result = result;
    if (!replay) Play.save(STATS_KEY, stats);
    line.say(T(w ? (settings.opp === 'cpu' ? (w === me ? 'shell.end.win' : 'shell.end.lose') : 'shell.end.wins') : 'shell.end.draw', { name: opts.name })); paint();
    ZimiShell.endSheet(opts);
  }
  function move(i) {
    if (!play(board, i, turn)) return;
    if (winner(board) || full(board)) { paint(); return end(); }
    turn = other(turn); paint(); say();
    if (cpu && turn === cpu) timer = Play.later(function () { move(bestMove(board, cpu, settings.level, Math.random)); }, CPU_DELAY_MS);
  }
  function click(i) {
    if (over) return;
    if (cpu && turn === cpu) { ZimiShell.shake(els.board); line.reason(T('shell.thinking')); return; }
    if (board[i]) { ZimiShell.shake(cells[i]); line.reason(T('noughts.taken')); return; }
    move(i);
  }

  function save() { Play.save(SETTINGS_KEY, settings); }
  // Who plays is the real choice: the computer or a friend, then (against the computer) the level and the mark.
  function menuOptions() {
    var box = document.createElement('div');
    function fill() {
      box.textContent = '';
      box.appendChild(Play.optionRow(T('noughts.opponent'), [['cpu', T('noughts.computer')], ['two', T('noughts.friend')]], settings.opp, function (v) { settings.opp = v; save(); fill(); }));
      if (settings.opp === 'cpu') {
        box.appendChild(Play.optionRow(T('noughts.level'), [['easy', T('noughts.easy')], ['hard', T('noughts.hard')]], settings.level, function (v) { settings.level = v; save(); }));
        box.appendChild(Play.optionRow(T('noughts.youAre'), [['X', T('noughts.firstX')], ['O', T('noughts.secondO')]], settings.mark, function (v) { settings.mark = v; save(); }));
      }
    }
    fill();
    return [box];
  }
  function begin() {
    if (timer) timer.cancel();
    board = emptyBoard(); over = false; turn = 'X'; me = settings.mark; cpu = settings.opp === 'cpu' ? other(me) : null;
    paint(); say();
    if (cpu === 'X') timer = Play.later(function () { move(bestMove(board, cpu, settings.level, Math.random)); }, CPU_DELAY_MS);
  }
  els.nu.addEventListener('click', begin);
  ZimiShell.game({
    inProgress: function () { return !over && board.some(Boolean); },
    menu: function () { return { options: menuOptions() }; },
    stats: function () { return stats.a + stats.b + stats.d ? [[T('noughts.you'), Play.num(stats.a)], [T('noughts.draws'), Play.num(stats.d)], [T('noughts.computer'), Play.num(stats.b)]] : []; }
  });

  // Leaving keeps the board, whose turn it is and how it was set up; a finished game comes back to its end sheet.
  function kept() {
    if (!board.some(Boolean)) return null;
    return { board: board, turn: turn, over: over, opp: settings.opp, level: settings.level, me: me };
  }
  function takeUp(d) {
    if (!d || !Array.isArray(d.board) || d.board.length !== 9 || (d.opp !== 'cpu' && d.opp !== 'two')) return false;
    if (timer) timer.cancel();
    settings.opp = d.opp; settings.level = d.level === 'easy' ? 'easy' : 'hard'; settings.mark = d.me === 'O' ? 'O' : 'X'; save();
    board = d.board.map(function (m) { return m === 'X' || m === 'O' ? m : null; }); turn = d.turn === 'O' ? 'O' : 'X';
    me = settings.mark; cpu = settings.opp === 'cpu' ? other(me) : null; over = false;
    paint();
    if (winner(board) || full(board)) { end(true); return true; }
    say();
    if (cpu && turn === cpu) timer = Play.later(function () { move(bestMove(board, cpu, settings.level, Math.random)); }, CPU_DELAY_MS);
    return true;
  }
  build(); begin();
  ZimiShell.persist({ save: kept, load: takeUp });
  root.__noughts = { get board() { return board; }, get turn() { return turn; } };
})(this);
