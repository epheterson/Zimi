/* ZimiGames: Go Problems, the page. Life-and-death positions, each proved by our own solver (see data/README-go-problems.txt).
   Every problem shipped was proved by tsumego-solver.js: black has a move that kills (or lives) whatever white does,
   within the search limit. The page uses the same solver to judge your turns and to choose White's most stubborn
   answers, so any winning line counts, not only the one in a book. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.makeGoEngine || !root.makeTsumegoSolver || !root.ZimiTsumego || !root.BoardUI) return;
  var G = root.makeGoEngine(), S = root.makeTsumegoSolver(G), D = root.ZimiTsumego, BK = root.BoardKit, UI = root.BoardUI, T = UI.t;
  var $ = function (id) { return document.getElementById(id); };
  var N = 19, BLACK = 1, WHITE = 2, CELL = 40, MARGIN = 0.8, STONE_R = 0.47;
  var KEY = 'goproblems', NODE_CAP = 80000, MAX_PLIES = 9, REPLY_DELAY_MS = 350, SHOW_STEP_MS = 800;
  var GRADES = [['all', 'gp.all'], ['1', 'board.level.easy'], ['2', 'board.level.medium'], ['3', 'board.level.hard']];
  var HOSHI = [3, 9, 15];

  var state = BK.load(KEY, {});
  if (!state.solved || typeof state.solved !== 'object') state.solved = {};
  var save = function () { BK.save(KEY, state); };
  var problems = D.problems;
  var keyboard = false, P, b, ko, plies, last, history, over, thinking, cue, wrongAt, cursor, search, showTimer, shown, coll = null, gradeFilter = 'all';

  var boardEl = $('gp-board');
  var line = UI.status($('gp-msg'));
  function say(t, busy) { line.turn(t, !!busy); }
  function idx(r, c) { return r * N + c; }
  function pointName(p) { return 'abcdefghjklmnopqrst'[p % N] + (N - ((p / N) | 0)); }
  function problemNumber(p) { return p.id; }

  // ── drawing ──
  function geometry() {
    var cols = P.w, rows = P.h;
    var realRight = cols >= N, realBottom = rows >= N;
    return { cols: cols, rows: rows, realRight: realRight, realBottom: realBottom, W: (cols - 1 + 2 * MARGIN) * CELL, H: (rows - 1 + 2 * MARGIN) * CELL };
  }
  function xy(r, c) { return [(MARGIN + c) * CELL, (MARGIN + r) * CELL]; }
  function drawBoard() {
    var g = geometry(), parts = [], r, c, a, e;
    parts.push('<defs>' +
      '<radialGradient id="gp-b" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#5a5650"/><stop offset="0.55" stop-color="#1f1d1a"/><stop offset="1" stop-color="#0c0b0a"/></radialGradient>' +
      '<radialGradient id="gp-w" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#ffffff"/><stop offset="0.7" stop-color="#ebe7dc"/><stop offset="1" stop-color="#bdb7a6"/></radialGradient></defs>');
    parts.push('<rect width="' + g.W + '" height="' + g.H + '" fill="var(--gp-wood)"/>');
    // grain: a few soft bands
    for (r = 0; r < g.rows * 2; r++) parts.push('<rect x="0" y="' + (r * g.H / (g.rows * 2)) + '" width="' + g.W + '" height="' + (g.H / (g.rows * 2)) + '" fill="var(--gp-wood2)" opacity="' + (r % 3 === 0 ? 0.28 : 0.1) + '"/>');
    // lines: board edges (top, left, and the far sides when the problem reaches them) are drawn heavier; open sides run off the picture
    var x0 = xy(0, 0)[0], y0 = xy(0, 0)[1], x1 = xy(0, g.cols - 1)[0], y1 = xy(g.rows - 1, 0)[1];
    var xe = g.realRight ? x1 : g.W, ye = g.realBottom ? y1 : g.H;
    for (r = 0; r < g.rows; r++) parts.push('<line x1="' + x0 + '" y1="' + xy(r, 0)[1] + '" x2="' + xe + '" y2="' + xy(r, 0)[1] + '" stroke="var(--gp-line)" stroke-width="' + (r === 0 || (g.realBottom && r === g.rows - 1) ? 2.6 : 1.2) + '"/>');
    for (c = 0; c < g.cols; c++) parts.push('<line x1="' + xy(0, c)[0] + '" y1="' + y0 + '" x2="' + xy(0, c)[0] + '" y2="' + ye + '" stroke="var(--gp-line)" stroke-width="' + (c === 0 || (g.realRight && c === g.cols - 1) ? 2.6 : 1.2) + '"/>');
    HOSHI.forEach(function (hr) { HOSHI.forEach(function (hc) { if (hr < g.rows && hc < g.cols) parts.push('<circle cx="' + xy(hr, hc)[0] + '" cy="' + xy(hr, hc)[1] + '" r="3" fill="var(--gp-line)"/>'); }); });
    // the stones, the target mark, the last move, a hint, a wrong move
    for (r = 0; r < g.rows; r++) for (c = 0; c < g.cols; c++) {
      var p = idx(r, c), v = b[p];
      if (!v) continue;
      a = xy(r, c);
      parts.push('<circle cx="' + a[0] + '" cy="' + (a[1] + 1.6) + '" r="' + CELL * STONE_R + '" fill="#000" opacity="0.28"/>');
      parts.push('<circle cx="' + a[0] + '" cy="' + a[1] + '" r="' + CELL * STONE_R + '" fill="url(#gp-' + (v === BLACK ? 'b' : 'w') + ')"' + (v === WHITE ? ' stroke="var(--gp-white-edge)" stroke-width="0.8"' : '') + '/>');
      if (P.t.indexOf(p) >= 0) parts.push('<path d="M' + a[0] + ' ' + (a[1] - 8) + 'L' + (a[0] + 7.5) + ' ' + (a[1] + 5.5) + 'H' + (a[0] - 7.5) + 'Z" fill="none" stroke="' + (v === BLACK ? '#fff' : '#222') + '" stroke-width="2.4" stroke-linejoin="round"/>');
      if (p === last) parts.push('<circle cx="' + a[0] + '" cy="' + a[1] + '" r="' + CELL * 0.17 + '" fill="none" stroke="var(--gp-mark)" stroke-width="2.6"/>');
    }
    if (cue !== undefined && cue >= 0) { e = xy((cue / N) | 0, cue % N); parts.push('<circle cx="' + e[0] + '" cy="' + e[1] + '" r="' + CELL * 0.34 + '" fill="var(--gp-good)" opacity="0.55"/><circle cx="' + e[0] + '" cy="' + e[1] + '" r="' + CELL * 0.4 + '" fill="none" stroke="var(--gp-good)" stroke-width="3"/>'); }
    if (wrongAt >= 0) { e = xy((wrongAt / N) | 0, wrongAt % N); parts.push('<path d="M' + (e[0] - 10) + ' ' + (e[1] - 10) + 'L' + (e[0] + 10) + ' ' + (e[1] + 10) + 'M' + (e[0] + 10) + ' ' + (e[1] - 10) + 'L' + (e[0] - 10) + ' ' + (e[1] + 10) + '" stroke="var(--gp-mark)" stroke-width="5" stroke-linecap="round"/>'); }
    if (cursor >= 0 && keyboard && document.activeElement === boardEl) { e = xy((cursor / N) | 0, cursor % N); parts.push('<rect x="' + (e[0] - 17) + '" y="' + (e[1] - 17) + '" width="34" height="34" rx="6" fill="none" stroke="var(--accent)" stroke-width="3" stroke-dasharray="6 4"/>'); }
    boardEl.style.setProperty('--ar', g.W / g.H); boardEl.style.setProperty('--gw', Math.min(1, g.W / g.H));
    boardEl.innerHTML = '<svg viewBox="0 0 ' + g.W + ' ' + g.H + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' + parts.join('') + '</svg>';
    boardEl.classList.toggle('thinking', thinking);
    $('gp-undo').disabled = !history.length || thinking || !!showTimer;
  }

  // ── a problem ──
  function load(i) {
    clearInterval(showTimer); showTimer = 0;
    P = problems[Math.max(0, Math.min(problems.length - 1, i))];
    b = S.boardFromRows(P.r); ko = -1; plies = 0; last = -1; history = []; over = false; thinking = false; cue = -1; wrongAt = -1; shown = false;
    var goal = { kind: P.k, target: P.t };
    search = S.analyse(P.r, goal, { nodeCap: NODE_CAP, maxPlies: MAX_PLIES, reach: P.y });
    cursor = P.t.length ? P.t[0] : 0;
    $('gp-title').textContent = collName(P.c) + ' ' + problemNumber(P);
    $('gp-goal').textContent = T(P.k === 'kill' ? 'gp.goal.kill' : 'gp.goal.live');
    $('gp-next').setAttribute('aria-pressed', 'false');
    state.last = P.c + ':' + P.id; save();
    say(''); showStats(); drawBoard();
  }
  // A collection's name and note: the table's words when it has them, the data's own English otherwise.
  function collText(c, part) { var k = 'gp.coll.' + c.id + (part === 'note' ? '.note' : ''); return root.ZimiText && root.ZimiText.has(k) ? T(k) : c[part]; }
  function collName(id) { var c = D.collections.filter(function (x) { return x.id === id; })[0]; return c ? collText(c, 'name') : id; }
  // Records stay hidden until the first problem is solved.
  function showStats() {
    var n = Object.keys(state.solved).length;
    $('gp-stats').textContent = n ? T('gp.solvedCount', { n: n, of: problems.length }) : '';
  }
  function budget() { search.search.nodes = 0; search.search.out = false; }
  function goal() { return { kind: P.k, target: P.t }; }
  function solved() {
    over = true; thinking = false; cue = -1;
    state.solved[P.c + ':' + P.id] = true; save();
    $('gp-next').setAttribute('aria-pressed', 'true');
    say(T(P.k === 'kill' ? 'gp.solved.kill' : 'gp.solved.live'));
    showStats(); drawBoard();
    UI.end({ result: 'win', text: T(P.k === 'kill' ? 'gp.solved.kill' : 'gp.solved.live'), newLabel: T('board.next'), onNew: next });
  }

  function blackPlays(p) {
    if (over || thinking || showTimer) return;
    wrongAt = -1; cue = -1;
    if (b[p]) { drawBoard(); return; }
    var nx = p === ko ? null : S.after(b, p, BLACK);
    if (!nx) { drawBoard(); UI.refuse(line, boardEl, T('gp.illegal')); return; }
    var good;
    if (plies === 0) good = P.f.indexOf(p) >= 0;
    else {
      budget();
      good = S.minDepth(search.search, nx.b, WHITE, nx.ko, MAX_PLIES - plies - 1) > 0;
    }
    if (!good) { wrongAt = p; drawBoard(); UI.refuse(line, boardEl, T('gp.wrong')); setTimeout(function () { wrongAt = -1; drawBoard(); }, 900); return; }
    history.push({ b: b, ko: ko, plies: plies, last: last });
    b = nx.b; ko = nx.ko; plies++; last = p;
    if (S.verdict(b, goal()) > 0) { solved(); return; }
    say(T('gp.whiteAnswers'), true); thinking = true; drawBoard();
    setTimeout(whiteReplies, REPLY_DELAY_MS);
  }
  function whiteReplies() {
    budget();
    var r = S.stubbornReply(search, b, ko, MAX_PLIES - plies);
    thinking = false;
    if (!r) { solved(); return; }                    // White has nothing that keeps it going
    var nx = S.after(b, r.p, WHITE);
    b = nx.b; ko = nx.ko; plies++; last = r.p;
    if (S.verdict(b, goal()) > 0) { solved(); return; }
    say(r.p < 0 ? T('gp.whitePasses') : T('gp.whitePlays', { point: pointName(r.p) }));
    drawBoard();
  }

  function undo() {
    if (!history.length || thinking || showTimer) return;
    var h = history.pop();
    b = h.b; ko = h.ko; plies = h.plies; last = h.last; over = false; cue = -1; wrongAt = -1; say(''); drawBoard();
  }
  function hint() {
    if (over || thinking || showTimer) return;
    if (plies === 0) cue = P.v[0];
    else {
      budget();
      var fm = S.firstMoves(search, b, ko);
      if (!fm || !fm.length) { say(T('gp.noHint')); return; }
      fm.sort(function (x, y) { return x.d - y.d; });
      cue = fm[0].p;
    }
    say(T('gp.keyPoint')); drawBoard();
  }
  function showAnswer() {
    if (thinking) return;
    load(problems.indexOf(P));
    var i = 0;
    say(T('gp.answer'), true);
    showTimer = setInterval(function () {
      if (i >= P.v.length) { clearInterval(showTimer); showTimer = 0; over = true; say(T('gp.answerDone')); drawBoard(); return; }
      var color = i % 2 === 0 ? BLACK : WHITE, p = P.v[i++];
      var nx = S.after(b, p, color);
      if (nx) { b = nx.b; ko = nx.ko; last = p; }
      drawBoard();
    }, SHOW_STEP_MS);
    drawBoard();
  }
  function next() {
    var i = problems.indexOf(P), j = i + 1;
    while (j < problems.length && (coll && problems[j].c !== coll)) j++;
    load(j < problems.length ? j : 0);
  }

  // ── input: tap a point, arrow keys and Enter ──
  boardEl.addEventListener('click', function (e) {
    var svg = boardEl.querySelector('svg');
    if (!svg) return;
    var box = svg.getBoundingClientRect(), g = geometry(), scale = Math.min(box.width / g.W, box.height / g.H);
    var ox = box.left + (box.width - g.W * scale) / 2, oy = box.top + (box.height - g.H * scale) / 2;
    var c = Math.round((e.clientX - ox) / (CELL * scale) - MARGIN), r = Math.round((e.clientY - oy) / (CELL * scale) - MARGIN);
    if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) return;
    cursor = idx(r, c); keyboard = false; blackPlays(cursor);
  });
  boardEl.addEventListener('focus', drawBoard);
  boardEl.addEventListener('blur', drawBoard);
  boardEl.addEventListener('keydown', function (e) {
    var d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (d) {
      e.preventDefault(); keyboard = true;
      var r = Math.max(0, Math.min(P.h - 1, ((cursor / N) | 0) + d[0])), c = Math.max(0, Math.min(P.w - 1, cursor % N + d[1]));
      cursor = idx(r, c); say(b[cursor] ? T(b[cursor] === BLACK ? 'gp.point.black' : 'gp.point.white', { point: pointName(cursor) }) : T('gp.point', { point: pointName(cursor) })); drawBoard();
    } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); keyboard = true; blackPlays(cursor); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input,select')) return;
    var k = e.key.toLowerCase();
    if (k === 'z' || k === 'u') undo(); else if (k === 'h') hint(); else if (k === 'r') load(problems.indexOf(P)); else if (k === 'n') next();
  });

  // ── Menu > New game: a collection, a difficulty, a problem. Nothing applies until New game is pressed. ──
  var draft = null;
  function problemsOf(c, g) { return problems.map(function (p, i) { return { p: p, i: i }; }).filter(function (x) { return x.p.c === c && (g === 'all' || String(x.p.g) === g); }); }
  function menuOptions() {
    draft = { coll: P.c, grade: 'all', index: problems.indexOf(P) };
    var collections = D.collections.filter(function (c) { return problems.some(function (p) { return p.c === c.id; }); });
    var note = UI.h('p', { class: 'bu-quiet' }), pick;
    function fillProblems() {
      var list = problemsOf(draft.coll, draft.grade);
      pick.node.textContent = '';
      list.forEach(function (x) { pick.node.add(new Option(state.solved[x.p.c + ':' + x.p.id] ? T('gp.solvedOption', { id: x.p.id }) : String(x.p.id), x.i)); });
      var keep = list.some(function (x) { return x.i === draft.index; });
      if (keep) pick.node.value = draft.index; else if (list.length) draft.index = list[0].i;
      var info = collections.filter(function (c) { return c.id === draft.coll; })[0];
      note.textContent = info ? collText(info, 'note') : '';
    }
    var coll = UI.row(T('gp.collection'), collections.map(function (c) { return [c.id, collText(c, 'name')]; }), draft.coll, function (v) { draft.coll = v; fillProblems(); });
    var grade = UI.row(T('gp.difficulty'), GRADES.map(function (g) { return [g[0], T(g[1])]; }), draft.grade, function (v) { draft.grade = v; fillProblems(); });
    pick = UI.select(T('gp.problem'), [], '', function (v) { draft.index = +v; });
    fillProblems();
    return UI.options((collections.length > 1 ? [coll] : []).concat([grade, pick, note]));
  }
  $('gp-new').addEventListener('click', function () {
    var d = draft; draft = null;
    if (d) load(d.index); else next();
  });
  $('gp-undo').addEventListener('click', undo);
  $('gp-hint').addEventListener('click', hint);
  $('gp-reset').addEventListener('click', function () { load(problems.indexOf(P)); });
  $('gp-show').addEventListener('click', showAnswer);
  $('gp-next').addEventListener('click', next);

  if (root.ZimiShell) root.ZimiShell.game({
    menu: menuOptions, hints: true,
    inProgress: function () { return !over && plies > 0; }
  });
  var start = 0;
  problems.forEach(function (p, i) { if (p.c + ':' + p.id === state.last) start = i; });
  load(start);
  // Leaving and coming back: the same problem with the moves made so far (and White's answer, if it was on its way).
  UI.persist({
    save: function () { return history.length || over ? { i: problems.indexOf(P), b: b, ko: ko, plies: plies, last: last, history: history.slice(-40), over: over, thinking: thinking } : null; },
    load: function (d) {
      if (!problems[d.i]) return false;
      load(d.i);
      b = d.b; ko = d.ko; plies = d.plies; last = d.last; history = d.history; over = d.over; thinking = d.thinking; cue = -1; wrongAt = -1;
      $('gp-next').setAttribute('aria-pressed', String(over));
      if (over) say(T(P.k === 'kill' ? 'gp.solved.kill' : 'gp.solved.live'));
      showStats(); drawBoard();
    },
    resume: function () { if (thinking) { say(T('gp.whiteAnswers'), true); setTimeout(whiteReplies, REPLY_DELAY_MS); } }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__gp = { load: load, play: blackPlays, problem: function () { return P; }, over: function () { return over; }, thinking: function () { return thinking; }, problems: problems };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
