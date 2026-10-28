/* ZimiGames: Checkers (English draughts, 8 x 8). Our own code, GPL-3.0. No network, no modules.
   Two halves: the rules and the computer player (pure functions, testable in node),
   then the page (runs only when there is a document). */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  // Squares are row * 8 + col, row 0 at the top. Red starts at the bottom and moves up;
  // White starts at the top and moves down. Red moves first. Pieces: 1 red man, 2 red
  // king, 3 white man, 4 white king.
  var N = 8, SIZE = 64, RED = 1, WHITE = 2;
  var MAN_VALUE = 100, KING_VALUE = 165, WIN_SCORE = 100000;
  var QUIET_LIMIT = 80;         // plies of king moves with no capture before a draw (40 moves a side)
  var MAX_JUMP_EXTENSION = 6;   // plies a forced capture may run past the search horizon
  var LEVELS = {
    easy: { depth: 2, ms: 150, noise: 45 },
    medium: { depth: 6, ms: 400, noise: 0 },
    hard: { depth: 14, ms: 1100, noise: 0 }
  };

  function owner(v) { return v === 0 ? 0 : v <= 2 ? RED : WHITE; }
  function isKing(v) { return v === 2 || v === 4; }
  function other(p) { return p === RED ? WHITE : RED; }
  function isDark(i) { return (((i / N) | 0) + (i % N)) % 2 === 1; }

  function initial() {
    var b = new Int8Array(SIZE);
    for (var i = 0; i < SIZE; i++) {
      if (!isDark(i)) continue;
      var r = (i / N) | 0;
      if (r < 3) b[i] = 3; else if (r > 4) b[i] = 1;
    }
    return b;
  }

  function dirsFor(v) {
    if (isKing(v)) return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    return owner(v) === RED ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]];
  }
  function kingRow(p) { return p === RED ? 0 : N - 1; }

  // Every full capture sequence from `from` (a man that reaches the king row stops there).
  function jumpsFrom(b, from, out) {
    var v = b[from], p = owner(v), caps = [], path = [];
    function walk(at) {
      var dirs = dirsFor(v), found = false;
      for (var d = 0; d < dirs.length; d++) {
        var r = ((at / N) | 0) + dirs[d][0], c = (at % N) + dirs[d][1];
        var r2 = r + dirs[d][0], c2 = c + dirs[d][1];
        if (r2 < 0 || r2 >= N || c2 < 0 || c2 >= N) continue;
        var mid = r * N + c, land = r2 * N + c2;
        if (owner(b[mid]) !== other(p) || caps.indexOf(mid) >= 0) continue;
        if (b[land] !== 0 && land !== from) continue;
        found = true;
        caps.push(mid); path.push(land);
        var crowned = !isKing(v) && r2 === kingRow(p);
        if (crowned) out.push({ from: from, to: land, path: path.slice(), caps: caps.slice() });
        else walk(land);
        caps.pop(); path.pop();
      }
      if (!found && path.length) out.push({ from: from, to: at, path: path.slice(), caps: caps.slice() });
    }
    walk(from);
  }

  // The legal moves for p: captures are compulsory, so if any exist they are all there is.
  function moves(b, p) {
    var jumps = [], steps = [], i;
    for (i = 0; i < SIZE; i++) if (owner(b[i]) === p) jumpsFrom(b, i, jumps);
    if (jumps.length) return jumps;
    for (i = 0; i < SIZE; i++) {
      if (owner(b[i]) !== p) continue;
      var dirs = dirsFor(b[i]);
      for (var d = 0; d < dirs.length; d++) {
        var r = ((i / N) | 0) + dirs[d][0], c = (i % N) + dirs[d][1];
        if (r < 0 || r >= N || c < 0 || c >= N || b[r * N + c] !== 0) continue;
        steps.push({ from: i, to: r * N + c, path: [r * N + c], caps: [] });
      }
    }
    return steps;
  }

  function apply(b, m) {
    var nb = b.slice(0), v = nb[m.from], p = owner(v);
    nb[m.from] = 0;
    for (var i = 0; i < m.caps.length; i++) nb[m.caps[i]] = 0;
    if (!isKing(v) && ((m.to / N) | 0) === kingRow(p)) v = p === RED ? 2 : 4;
    nb[m.to] = v;
    return nb;
  }

  function count(b) {
    var k = { red: 0, white: 0, redKings: 0, whiteKings: 0 };
    for (var i = 0; i < SIZE; i++) {
      var v = b[i];
      if (!v) continue;
      if (owner(v) === RED) { k.red++; if (isKing(v)) k.redKings++; } else { k.white++; if (isKing(v)) k.whiteKings++; }
    }
    return k;
  }

  function key(b, p) { return p + ':' + Array.prototype.join.call(b, ''); }

  // ── the computer ─────────────────────────────────────────────────────────
  // Score from p's side: material, how far the men have come, a guarded back row, the centre.
  function evaluate(b, p) {
    var score = 0;
    for (var i = 0; i < SIZE; i++) {
      var v = b[i];
      if (!v) continue;
      var o = owner(v), r = (i / N) | 0, c = i % N, s;
      if (isKing(v)) {
        s = KING_VALUE + (3 - Math.abs(r - 3.5) - Math.abs(c - 3.5)) * 2;
      } else {
        var advance = o === RED ? N - 1 - r : r;
        s = MAN_VALUE + advance * 4 + (advance === 0 ? 10 : 0) + (c === 0 || c === N - 1 ? -2 : 0);
      }
      score += o === p ? s : -s;
    }
    return score;
  }

  function Timeout() {}

  function search(b, p, depth, alpha, beta, ply, ctx, ext) {
    if ((++ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) throw new Timeout();
    var ms = moves(b, p);
    if (!ms.length) return -WIN_SCORE + ply;
    if (depth <= 0) {
      if (!(ms[0].caps.length && ext < MAX_JUMP_EXTENSION)) return evaluate(b, p);
      depth = 1; ext++;
    }
    ms.sort(function (x, y) { return y.caps.length - x.caps.length; });
    var best = -Infinity;
    for (var i = 0; i < ms.length; i++) {
      var s = -search(apply(b, ms[i]), other(p), depth - 1, -beta, -alpha, ply + 1, ctx, ext);
      if (s > best) best = s;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  // The computer's move at a level (iterative deepening within the level's time).
  function chooseMove(b, p, level, rng, info) {
    var ms = moves(b, p);
    if (!ms.length) return null;
    if (ms.length === 1) return ms[0];
    var cfg = LEVELS[level] || LEVELS.medium, rand = rng || Math.random;
    var ctx = { nodes: 0, deadline: Date.now() + cfg.ms }, best = ms[0], scores = null;
    for (var depth = 1; depth <= cfg.depth; depth++) {
      var cur = [], bestIdx = 0, alpha = -Infinity;
      try {
        for (var i = 0; i < ms.length; i++) {
          var s = -search(apply(b, ms[i]), other(p), depth - 1, -Infinity, Infinity, 1, ctx, 0);
          cur.push(s);
          if (s > cur[bestIdx]) bestIdx = i;
          if (s > alpha) alpha = s;
        }
      } catch (e) { if (!(e instanceof Timeout)) throw e; break; }
      scores = cur; best = ms[bestIdx]; if (info) info.score = cur[bestIdx];
      // search the best move first next time
      ms.unshift(ms.splice(bestIdx, 1)[0]); scores.unshift(scores.splice(bestIdx, 1)[0]);
      if (Math.abs(scores[0]) > WIN_SCORE / 2) break;
    }
    if (cfg.noise && scores) {
      var top = -Infinity, pick = 0;
      for (var j = 0; j < scores.length; j++) {
        var n = scores[j] + (rand() - 0.5) * 2 * cfg.noise;
        if (n > top) { top = n; pick = j; }
      }
      best = ms[pick]; if (info) info.score = scores[pick];
    }
    return best;
  }

  var Engine = {
    N: N, RED: RED, WHITE: WHITE, QUIET_LIMIT: QUIET_LIMIT, LEVELS: LEVELS,
    owner: owner, isKing: isKing, other: other, isDark: isDark, initial: initial,
    moves: moves, apply: apply, count: count, key: key, evaluate: evaluate, chooseMove: chooseMove
  };
  root.CheckersEngine = Engine;

  // ── the page ─────────────────────────────────────────────────────────────
  if (typeof document === 'undefined' || !root.BoardUI) return;
  var BK = root.BoardKit, WK = root.WorldKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var COMPUTER_DELAY_MS = 450, HINT_DELAY_MS = 40;
  var CROWN = '<svg class="ck-crown" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18h16l1.5-10-5 4L12 5 7.5 12l-5-4z" fill="currentColor"/><rect x="4" y="19" width="16" height="2.4" rx="1" fill="currentColor"/></svg>';
  var G = WK.create({
    id: 'checkers',
    options: WK.standardOptions({ first: 'checkers.red.first', second: 'board.white' }),
    onNew: newGame, onUndo: undo, onHint: hint
  });
  var score = WK.scoreBar($('wk-score'), [{ color: 'var(--ck-red)' }, { color: 'var(--ck-white)' }]);
  var board = $('ck-board'), cells = [], game, history = [], sel = -1, prefix = [], legal = [], lastSquares = [], flip = false, seen = {}, note = '', cueTo = -1, glide = null;

  function idxOf(p) { return p === RED ? 0 : 1; }
  function sideName(p) { return T(p === RED ? 'board.red' : 'board.white'); }
  function nameOf(p) { return G.vsComputer() && !G.watching ? (G.human(idxOf(p)) ? T('board.you') : T('board.zimi')) : sideName(p); }
  function humanNow() { return !G.over && !G.thinking && G.human(idxOf(game.turn)); }
  // Show legal moves is the shell's Hints setting (Menu > Settings), not a New game option.
  function hintsOn() { return !root.ZimiShell || root.ZimiShell.settings.get('hints') !== 'off'; }
  function sqAt(d) { return flip ? SIZE - 1 - d : d; }
  function coord(i) { return 'abcdefgh'[i % N] + (N - ((i / N) | 0)); }

  function buildBoard() {
    board.textContent = '';
    cells = [];
    for (var d = 0; d < SIZE; d++) {
      var c = document.createElement('button');
      c.type = 'button'; c.className = 'bg-sq'; c.dataset.d = d;
      c.addEventListener('click', onSquare);
      board.appendChild(c); cells.push(c);
    }
    BK.gridNav(board, cells, N);
  }

  // The squares this click could go to next, given the path so far.
  function candidates() {
    if (sel < 0) return {};
    var out = {};
    legal.forEach(function (m) {
      if (m.from !== sel || prefix.some(function (q, k) { return m.path[k] !== q; })) return;
      out[m.path[prefix.length]] = m.caps.length > 0;
    });
    return out;
  }

  function paint() {
    var b = game.board, cand = candidates(), movable = {}, i, hints = hintsOn();
    if (humanNow()) legal.forEach(function (m) { movable[m.from] = 1; });
    for (var d = 0; d < SIZE; d++) {
      i = sqAt(d);
      var c = cells[d], v = b[i], piece = c.firstChild;
      var cls = 'bg-sq' + (isDark(i) ? ' dk' : '');
      if (lastSquares.indexOf(i) >= 0) cls += ' last';
      if (i === sel) cls += ' sel';
      if ((cand.hasOwnProperty(i) && hints) || i === cueTo) cls += ' hint' + (cand[i] ? ' cap' : '');
      c.className = cls;
      var want = v ? 'ck-pc ' + (owner(v) === RED ? 'r' : 'w') + (isKing(v) ? ' k' : '') + (movable[i] && hints && sel < 0 ? ' mv' : '') : '';
      if (want) {
        if (!piece) { piece = document.createElement('span'); c.appendChild(piece); }
        piece.className = want;
        piece.innerHTML = isKing(v) ? CROWN : '';
      } else if (piece) c.removeChild(piece);
      var what = v ? T(owner(v) === RED ? (isKing(v) ? 'checkers.redKing' : 'checkers.redMan') : (isKing(v) ? 'checkers.whiteKing' : 'checkers.whiteMan')) : T(cand.hasOwnProperty(i) ? 'checkers.moveHere' : 'go.pt.empty');
      c.setAttribute('aria-label', T('reversi.sq', { sq: coord(i), what: what }));
    }
    var k = count(b);
    score(G.names(sideName(RED), sideName(WHITE)), [k.red, k.white], G.over ? -1 : idxOf(game.turn));
    if (glide) { BK.slide(cells[sqAt(glide[0])], cells[sqAt(glide[1])]); glide = null; }
    G.setUndo(history.length > 0 && !G.watching);
    G.setHint(humanNow() && !G.watching);
  }

  function turnLine() {
    var p = game.turn, mustJump = legal.length && legal[0].caps.length;
    if (G.watching || !G.vsComputer()) return T(mustJump ? 'checkers.toMoveJump' : 'board.toMove', { name: sideName(p) });
    if (!G.human(idxOf(p))) return T('shell.thinking');
    return T(mustJump ? 'checkers.yourTurnJump' : 'board.yourTurn');
  }

  function finish(text, result, name) { // result: 'win' or 'loss' for the human, or 'draw'
    G.finish(text, result === 'win' ? 'w' : result === 'loss' ? 'l' : result === 'draw' ? 'd' : null, name);
  }

  function nextPly() {
    sel = -1; prefix = [];
    legal = moves(game.board, game.turn);
    var p = game.turn, k = key(game.board, p);
    seen[k] = (seen[k] || 0) + 1;
    if (!legal.length) {
      var winner = other(p), two = !G.vsComputer();
      paint();
      finish(T(two ? 'checkers.noMove' : G.human(idxOf(winner)) ? 'checkers.noMove.you' : 'checkers.noMove.computer', { name: sideName(p) }), two ? null : G.human(idxOf(winner)) ? 'win' : 'loss', sideName(winner));
      return;
    }
    if (seen[k] >= 3) { paint(); finish(T('xiangqi.why.repetition'), 'draw'); return; }
    if (game.quiet >= QUIET_LIMIT) { paint(); finish(T('checkers.why.quiet'), 'draw'); return; }
    paint();
    var line = turnLine();
    G.say(note && G.human(idxOf(p)) ? UI.noted(note, line) : line, !G.human(idxOf(p)) && !G.watching);
    note = '';
    if (root.ZimiShell && !G.watching) root.ZimiShell.turn(G.human(idxOf(p)), timeUp, history.length);
    if (!G.human(idxOf(p))) scheduleComputer();
  }

  function commit(m) {
    history.push({ board: game.board, turn: game.turn, quiet: game.quiet, last: lastSquares, seen: Object.assign({}, seen) });
    var moved = game.board[m.from], reset = m.caps.length > 0 || !isKing(moved);
    game = { board: apply(game.board, m), turn: other(game.turn), quiet: reset ? 0 : game.quiet + 1 };
    lastSquares = [m.from].concat(m.path.slice(-1));
    glide = [m.from, m.path[m.path.length - 1]]; cueTo = -1;
    var computer = G.vsComputer() && !G.watching && !G.human(idxOf(history[history.length - 1].turn));
    note = computer ? T(m.caps.length ? 'checkers.cpu.jumped' : 'checkers.cpu.moved', { from: coord(m.from), to: coord(m.path[m.path.length - 1]) }) : '';
    nextPly();
  }

  function scheduleComputer() {
    paint();
    G.later(function () {
      var info = {}, m = chooseMove(game.board, game.turn, G.settings.level, null, info);
      if (!m) return;
      var ctl = G.watching;
      if (!ctl) { commit(m); return; }
      var why = root.ZimiExplain.checkers(Engine, game.board, game.turn, m, { score: info.score });
      ctl.offer(why.text, function () { if (G.watching === ctl && !G.over) commit(m); });
    }, COMPUTER_DELAY_MS);
  }

  // The move timer ran out: a quick computer choice is played for the person.
  function timeUp() {
    if (G.over || G.thinking || !G.human(idxOf(game.turn))) return;
    var m = chooseMove(game.board, game.turn, 'easy');
    if (!m) return;
    sel = -1; prefix = [];
    G.say(T('board.timeUp'));
    commit(m);
  }

  function onSquare(e) {
    if (!humanNow()) return;
    var i = sqAt(+e.currentTarget.dataset.d), cand = candidates();
    if (sel >= 0 && cand.hasOwnProperty(i)) {
      prefix = prefix.concat(i);
      var full = legal.filter(function (m) { return m.from === sel && m.path.length === prefix.length && prefix.every(function (q, k) { return m.path[k] === q; }); });
      if (full.length) { commit(full[0]); return; }
      paint(); G.say(T('checkers.keepJumping'));
      return;
    }
    if (prefix.length) { paint(); return; } // mid-capture: only the next landing counts
    if (game.board[i] && owner(game.board[i]) === game.turn) {
      if (legal.some(function (m) { return m.from === i; })) { sel = sel === i ? -1 : i; cueTo = -1; paint(); G.say(sel < 0 ? turnLine() : T('checkers.chooseWhere')); }
      else G.refuse(cells[+e.currentTarget.dataset.d], T(legal[0].caps.length ? 'checkers.mustCapture' : 'checkers.cantMove'));
      return;
    }
    var had = sel >= 0;
    sel = -1; paint();
    if (had) G.refuse(e.currentTarget, T(legal[0].caps.length ? 'checkers.mustCapture' : 'checkers.no.way'));
    else G.say(turnLine());
  }

  // Hint: the piece to move and its first landing, chosen by the engine at its best.
  function hint() {
    if (!humanNow() || G.watching) return;
    var token = G.begin(); paint(); G.say(T('board.thinkingHint'), true);
    setTimeout(function () {
      if (!G.done(token)) return;
      var m = chooseMove(game.board, game.turn, 'hard');
      if (!m) { paint(); return; }
      sel = m.from; prefix = []; cueTo = m.path[0];
      paint(); G.say(T('checkers.hint', { from: coord(m.from), to: coord(m.path[0]) }));
    }, HINT_DELAY_MS);
  }

  function undo() {
    if (!history.length || G.watching) return;
    G.cancel(); G.over = false; note = ''; cueTo = -1;
    var h;
    do { h = history.pop(); } while (history.length && G.vsComputer() && !G.human(idxOf(h.turn)));
    game = { board: h.board, turn: h.turn, quiet: h.quiet }; lastSquares = h.last; seen = h.seen; seen[key(h.board, h.turn)]--; // nextPly counts it again
    nextPly();
  }

  function newGame() {
    history = []; lastSquares = []; seen = {};
    flip = G.vsComputer() && !G.watching && G.settings.side === 'second';
    buildBoard();
    game = { board: initial(), turn: RED, quiet: 0 };
    nextPly();
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input')) return;
    if (e.key === 'Escape' && sel >= 0 && !prefix.length) { sel = -1; paint(); }
  });

  if (root.ZimiShell) {
    root.ZimiShell.settings.on(function (k) { if (k === 'hints' || k === '*') paint(); });
    root.ZimiShell.game({ moveTimer: true, hints: true, inProgress: function () { return !G.over && history.length > 0; } });
  }
  G.registerWatch({
    script: 'explain-checkers.js', unit: 'move', level: 'medium', intro: 'checkers.watch.intro',
    whoseTurn: function () { return idxOf(game.turn); },
    resume: function () { flip = G.settings.side === 'second'; buildBoard(); seen[key(game.board, game.turn)]--; nextPly(); }
  });

  G.newGame();
  G.persist({
    save: function () { return history.length ? { game: game, history: history.slice(-40), lastSquares: lastSquares, seen: seen } : null; },
    load: function (d) {
      game = d.game; history = d.history; lastSquares = d.lastSquares; seen = d.seen;
      flip = G.vsComputer() && G.settings.side === 'second'; buildBoard();
      sel = -1; prefix = []; legal = moves(game.board, game.turn); paint();
    },
    resume: function () {
      G.say(turnLine(), !G.human(idxOf(game.turn)));
      if (root.ZimiShell) root.ZimiShell.turn(G.human(idxOf(game.turn)), timeUp, history.length);
      if (!G.human(idxOf(game.turn))) scheduleComputer();
    }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__ck = { G: G, game: function () { return game; }, engine: Engine, settings: G.settings };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
