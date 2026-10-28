// Arcade puzzle and arcade games: the rules, with no DOM. Stacker rotation, kicks and line
// clears; 2048 merges; Sudoku solver, uniqueness and grading; Five Letters scoring with
// repeated letters; Snake collisions; Bricks collisions.
//
// Run: node tests/test_games_play.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
function load(files) {
  const sandbox = {};
  vm.createContext(sandbox);
  ['util.js'].concat(files).forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f }));
  return sandbox;
}

let failures = 0, passes = 0;
const check = (ok, label) => {
  if (ok) { passes++; console.log('ok: ' + label); }
  else { console.error('FAIL: ' + label); failures++; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Stacker ─────────────────────────────────────────────────────────────────
{
  const S = load(['stacker.js']).StackerEngine;
  const cellsAt = (type, rot, x, y) => S.ROT[type][rot].map(p => [x + p[0], y + p[1]]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const put = (g, type, rot, x, y) => { g.cur = { type, rot, x, y }; };

  check(S.TYPES === 'IOTSZJL' && S.TYPES.length === 7, 'stacker: seven pieces');
  check('IOTSZJL'.split('').every(t => S.ROT[t].length === 4 && S.ROT[t].every(r => r.length === 4)), 'stacker: every piece is four cells in all four poses');

  // A T pointing up turned clockwise points right; four turns come home.
  check(same(cellsAt('T', 1, 0, 0), [[1, 0], [1, 1], [2, 1], [1, 2]]), 'stacker: T turned once clockwise points right');
  let g = S.createGame(1);
  put(g, 'L', 0, 3, 5);
  for (let i = 0; i < 4; i++) S.rotate(g, 1);
  check(g.cur.rot === 0 && g.cur.x === 3 && g.cur.y === 5, 'stacker: four clockwise turns in open space come home');
  S.rotate(g, -1);
  check(g.cur.rot === 3, 'stacker: counter-clockwise turn goes 0 to 3');

  // Wall kicks: a vertical I against the left wall turns flat by kicking right.
  g = S.createGame(2);
  put(g, 'I', 1, -2, 5); // vertical I in column 0 (cells at box column 2)
  check(S.ROT.I[1].every(p => p[0] === 2), 'stacker: I pose 1 is a vertical bar in box column 2');
  check(!S.collides(g.board, 'I', 1, -2, 5), 'stacker: that I sits in column 0 without collision');
  const turned = S.rotate(g, 1); // 1 -> 2 is flat: needs room
  check(turned && g.cur.rot === 2 && S.pieceCells(g.cur).every(p => p[0] >= 0 && p[0] < S.COLS), 'stacker: I kicks off the left wall when turned');
  g = S.createGame(3);
  put(g, 'I', 1, 7, 5);
  check(S.rotate(g, -1) && g.cur.rot === 0 && S.pieceCells(g.cur).every(p => p[0] < S.COLS), 'stacker: I kicks off the right wall when turned back');

  // The landing ghost: for every piece, every turn either way and every kick the table can ask for, the cells it marks are exactly
  // the cells a hard drop then locks (a ghost drawn anywhere else, or not at all, is what a player cannot trust).
  {
    const clone = (gm) => JSON.parse(JSON.stringify({ board: gm.board, cur: gm.cur }));
    const cellsOf = (b) => { const o = []; b.forEach((row, y) => row.forEach((v, x) => { if (v) o.push(x + ',' + y); })); return o.sort(); };
    let seen = {}, bad = 0, runs = 0;
    for (let seed = 1; seed <= 400; seed++) {
      for (const type of 'IOTSZJL') {
        for (let rot = 0; rot < 4; rot++) {
          for (const dir of [1, -1]) {
            const gm = S.createGame(seed);
            for (let r = 6; r < S.ROWS; r++) for (let c = 0; c < S.COLS; c++) if (((r * 7 + c * 13 + seed * 5) % 5) === 0) gm.board[r][c] = 1;   // a ragged stack, same every run
            const x = ((seed * 3) % 12) - 2, y = (seed % 9);
            if (S.collides(gm.board, type, rot, x, y)) continue;
            gm.cur = { type, rot, x, y };
            if (!S.rotate(gm, dir)) continue;   // a turn that fits nowhere changes nothing: nothing to land
            seen[type + (gm.cur.kick || 0)] = true;
            const marked = S.landing(gm).map(p => p.join(',')).sort();
            const before = cellsOf(gm.board);
            const dropped = clone(gm);
            const probe = S.createGame(1);
            probe.board = dropped.board; probe.cur = dropped.cur;
            S.hardDrop(probe);
            // hardDrop clears full rows: compare on a board with no row able to fill
            const locked = cellsOf(probe.board).filter(k => before.indexOf(k) < 0);
            runs++;
            const ok = !S.collides(gm.board, type, gm.cur.rot, ...[gm.cur.x, S.ghostY(gm)]) && S.collides(gm.board, type, gm.cur.rot, gm.cur.x, S.ghostY(gm) + 1);
            if (!ok || (probe.lines === 0 && JSON.stringify(locked) !== JSON.stringify(marked))) bad++;
          }
        }
      }
    }
    check(runs > 1000 && bad === 0, 'stacker: the landing ghost is exactly where a hard drop locks, after every turn and kick (' + runs + ' turns, ' + bad + ' wrong)');
    check([1, 2, 3, 4].every(k => 'IJLSTZ'.split('').some(t => seen[t + k])) && [1, 2, 3, 4].some(k => seen['I' + k]), 'stacker: the turns above reached wall kicks 1 to 4, not only the plain turn');
  }

  // A turn that fits nowhere is refused and changes nothing.
  g = S.createGame(4);
  put(g, 'I', 0, 3, 5);
  for (let x = 0; x < S.COLS; x++) { for (const y of [3, 4, 6, 7]) g.board[y][x] = 1; } // a flat I between full rows
  const before = JSON.stringify(g.cur);
  check(S.rotate(g, 1) === false && JSON.stringify(g.cur) === before, 'stacker: a turn with no room is refused and the piece stays');

  // A kick that moves the piece: an L against the floor turns upright by kicking up.
  g = S.createGame(5);
  put(g, 'L', 0, 3, 19); // flat L: cells in box rows 0 and 1, so it rests on the floor at y 19-20
  put(g, 'L', 0, 3, 20);
  check(S.collides(g.board, 'L', 0, 3, 20) === false, 'stacker: an L fits flat on the floor');
  check(S.rotate(g, 1) && g.cur.kick > 0 && g.cur.y < 20, 'stacker: turning on the floor kicks the piece up to fit');

  // Gravity, ghost, hard drop.
  g = S.createGame(6);
  put(g, 'O', 0, 4, 1);
  check(S.ghostY(g) === 20, 'stacker: the ghost of an O in an empty well rests on the floor');
  const sc0 = g.score;
  S.stepDown(g, true);
  check(g.score === sc0 + 1 && g.cur.y === 2, 'stacker: a soft drop is a point a row');
  const rows = S.ghostY(g) - g.cur.y;
  S.hardDrop(g);
  check(g.score === sc0 + 1 + 2 * rows, 'stacker: a hard drop is two points a row');
  check(g.board[21][4] === 2 && g.board[21][5] === 2 && g.board[20][4] === 2, 'stacker: the O locked into the bottom rows with its colour id');

  // Line clears: fill row 21 except a gap, drop an I into it.
  g = S.createGame(7);
  for (let x = 0; x < S.COLS; x++) if (x < 3 || x > 6) g.board[21][x] = 3;
  put(g, 'I', 0, 3, 19); // flat I, cells at row y+1
  g.queue.unshift('O');
  const res = S.hardDrop(g);
  check(res.cleared === 1 && g.lines === 1, 'stacker: one full row clears');
  check(g.board[21].every(v => v === 0), 'stacker: the cleared row is gone and the one above came down');
  check(g.score >= S.LINE_SCORE[1] * 1, 'stacker: a single scores 100 times the level');

  // Four at once. A vertical I into a well four rows deep.
  g = S.createGame(8);
  for (let y = 18; y < 22; y++) for (let x = 0; x < S.COLS - 1; x++) g.board[y][x] = 4;
  put(g, 'I', 1, 7, 17); // vertical bar at column 9
  g.queue.unshift('O');
  const four = S.hardDrop(g);
  check(four.cleared === 4 && g.lines === 4, 'stacker: an I clears four rows at once');
  check(g.score >= 800, 'stacker: four rows score 800 at level one, plus the drop');

  // Levels: ten rows a level.
  check(S.levelFor(0) === 1 && S.levelFor(9) === 1 && S.levelFor(10) === 2 && S.levelFor(95) === 10, 'stacker: a level every ten rows');
  check(S.gravityMs(1) > S.gravityMs(5) && S.gravityMs(15) >= 50, 'stacker: gravity gets faster, with a floor');

  // Hold: once per piece, swaps back.
  g = S.createGame(9);
  const first = g.cur.type, second = g.queue[0];
  check(S.holdPiece(g) && g.hold === first && g.cur.type === second, 'stacker: hold stores the piece and brings the next');
  check(S.holdPiece(g) === false, 'stacker: hold works once per piece');
  S.hardDrop(g);
  const cur2 = g.cur.type;
  check(S.holdPiece(g) && g.cur.type === first && g.hold === cur2, 'stacker: after a lock, hold swaps with the held piece');

  // The bag: every seven pieces are all seven.
  g = S.createGame(10);
  const seen = [g.cur.type].concat(g.queue.slice(0, 6));
  check(new Set(seen).size === 7, 'stacker: the first bag has all seven pieces');

  // Game over: blocked spawn.
  g = S.createGame(11);
  for (let y = 0; y < 6; y++) for (let x = 0; x < S.COLS - 1; x++) g.board[y][x] = 5; // a tall stack with a gap, so no row clears
  S.hardDrop(g);
  check(g.over, 'stacker: a stack to the top ends the game');
}

// ── 2048 ────────────────────────────────────────────────────────────────────
{
  const T = load(['2048.js']).Engine2048;
  // The other three rows hold a pattern that cannot move or merge; the one tile that spawns after a
  // move is taken out again, so the first row shows only the slide.
  const lock = vals => vals.concat([3, 5, 7, 9, 11, 13, 17, 19, 23, 29, 31, 37]);
  const slide = (vals, dir) => { const g = T.fromValues(lock(vals), 0, 1); const r = T.move(g, dir || 'left'); const v = T.values(g); if (r.spawned) v[r.spawned.at] = 0; return { g, r, v: v.slice(0, 4) }; };

  check(same(slide([2, 2, 0, 0]).v, [4, 0, 0, 0]), '2048: 2 2 . . merges to 4');
  check(same(slide([2, 2, 2, 2]).v, [4, 4, 0, 0]), '2048: 2 2 2 2 merges in pairs to 4 4');
  check(same(slide([2, 2, 2, 0]).v, [4, 2, 0, 0]), '2048: 2 2 2 . merges the nearer pair first');
  check(same(slide([4, 2, 2, 0]).v, [4, 4, 0, 0]), '2048: 4 2 2 . gives 4 4 and does not merge again');
  check(same(slide([2, 0, 0, 2]).v, [4, 0, 0, 0]), '2048: tiles slide across gaps to merge');
  check(same(slide([2, 4, 2, 4]).v, [2, 4, 2, 4]) && slide([2, 4, 2, 4]).r.moved === false, '2048: nothing to move means moved is false');
  check(same(slide([2, 2, 4, 8], 'right').v, [0, 4, 4, 8]), '2048: moving right merges toward the right wall');
  check(slide([2, 2, 0, 0]).r.gain === 4 && slide([2, 2, 4, 4]).r.gain === 12, '2048: the gain is the sum of the new tiles');

  let g = T.fromValues(lock([2, 2, 0, 0]), 10, 1);
  T.move(g, 'left');
  check(g.score === 14, '2048: the score adds the gain');
  // Spawn: exactly one new tile, a 2 or 4, in an empty cell.
  const nonzero = T.values(g).filter(Boolean).length;
  check(nonzero === 12 + 1 + 1, '2048: one tile spawns after a move');
  // Undo restores the board and score, once.
  const vals = T.values(T.fromValues(lock([2, 2, 0, 0]), 10, 1));
  check(T.undo(g) && same(T.values(g), vals) && g.score === 10, '2048: undo restores the board and score');
  check(T.undo(g) === false, '2048: only one move can be undone');
  // Columns.
  g = T.fromValues([2, 3, 5, 7, 2, 11, 13, 17, 4, 19, 23, 29, 4, 31, 37, 41], 0, 2);
  T.move(g, 'up');
  check(T.values(g)[0] === 4 && T.values(g)[4] === 8 && T.values(g)[8] !== 4, '2048: up merges down a column (2 2 4 4 gives 4 8)');
  // Win and game over.
  g = T.fromValues(lock([1024, 1024, 0, 0]), 0, 3);
  T.move(g, 'left');
  check(g.won === true, '2048: making 2048 sets won');
  g = T.fromValues([2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 8], 0, 4);
  check(g.over === true && T.canMove(g) === false, '2048: a full board with no equal neighbours is over');
  g = T.fromValues([2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 8, 8], 0, 4);
  check(g.over === false && T.canMove(g) === true, '2048: a full board with an equal pair is not over');
  // Tile identity: a move reports where each id went.
  g = T.fromValues(lock([0, 2, 0, 4]), 0, 5);
  const m = T.move(g, 'left');
  check(m.moves.length === 2 && m.moves.every(x => x.to === 0 || x.to === 1), '2048: a move reports each tile and where it went');
}

// ── Sudoku ──────────────────────────────────────────────────────────────────
{
  const D = load(['sudoku.js']).SudokuEngine;
  const rng = D.mulberry32(7);
  const full = D.randomSolution(rng);
  const validGrid = grid => {
    for (const u of D.UNITS) { const ds = u.map(i => grid[i]).sort().join(''); if (ds !== '123456789') return false; }
    return true;
  };
  check(full.length === 81 && validGrid(full), 'sudoku: a random solution is a valid grid');
  check(!D.conflicts(full).some(Boolean), 'sudoku: a valid grid has no conflicts');
  const broken = full.slice(); broken[1] = broken[0];
  check(D.conflicts(broken)[0] && D.conflicts(broken)[1], 'sudoku: a repeated digit marks both cells');

  // A known puzzle (a published, widely used example) solves to its known answer.
  const puzzle = '530070000600195000098000060800060003400803001700020006060000280000419005000080079'.split('').map(Number);
  const answer = '534678912672195348198342567859761423426853791713924856961537284287419635345286179';
  check(D.solve(puzzle).join('') === answer, 'sudoku: the solver finds the known solution');
  check(D.countSolutions(puzzle, 2) === 1, 'sudoku: that puzzle has exactly one solution');
  check(D.countSolutions(new Array(81).fill(0), 2) === 2, 'sudoku: an empty grid has more than one solution');
  const impossible = puzzle.slice(); impossible[2] = 5;
  check(D.solve(impossible) === null, 'sudoku: a contradictory grid has no solution');
  check(D.grade(puzzle).solved, 'sudoku: the grader solves the known easy puzzle by technique');
  check(D.grade(puzzle).rank === 1, 'sudoku: the known puzzle needs only naked singles');

  // Generation: each difficulty yields a unique puzzle, solved by the grader at its level.
  const wantRank = { easy: r => r === 1, medium: r => r === 2, hard: r => r >= 3 && r <= 4, expert: r => r >= 5 };
  for (const d of D.DIFFICULTIES) {
    for (const seed of [11, 12, 13]) {
      const p = D.generate(d, seed);
      const info = D.grade(p.puzzle);
      check(D.countSolutions(p.puzzle, 2) === 1, 'sudoku: ' + d + ' #' + seed + ' has exactly one solution');
      check(p.difficulty === d && wantRank[d](info.rank), 'sudoku: ' + d + ' #' + seed + ' grades as ' + d + ' (rank ' + info.rank + ')');
      check(D.solve(p.puzzle).join('') === p.solution.join('') && validGrid(p.solution), 'sudoku: ' + d + ' #' + seed + ' solves to its stated solution');
      check(p.puzzle.every((v, i) => !v || v === p.solution[i]), 'sudoku: ' + d + ' #' + seed + ' clues agree with the solution');
    }
  }
  const e1 = D.generate('easy', 5), x1 = D.generate('expert', 5);
  check(e1.puzzle.filter(Boolean).length > x1.puzzle.filter(Boolean).length, 'sudoku: easy has more clues than expert');
  check(same(D.generate('hard', 99).puzzle, D.generate('hard', 99).puzzle), 'sudoku: the same seed makes the same puzzle');
  check(D.grade(D.generate('hard', 21).puzzle).counts.locked + D.grade(D.generate('hard', 21).puzzle).counts.pair >= 1, 'sudoku: a hard puzzle uses at least one locked-candidate or pair step');
}

// ── Five Letters ────────────────────────────────────────────────────────────
{
  const sb = load(['fiveletters-words.js', 'fiveletters.js']);
  const F = sb.FiveLettersEngine;
  const score = (g, a) => F.scoreGuess(g, a).map(s => ({ correct: 'G', present: 'Y', absent: '.' })[s]).join('');
  check(score('crane', 'crane') === 'GGGGG', 'five: the answer scores all green');
  check(score('stone', 'crane') === '.' + '..' + 'GG', 'five: stone against crane: n and e are green, the rest grey');
  check(score('allee', 'apple') === 'GY..G', 'five: allee against apple: first a green, one yellow l (apple has one l), second l and first e grey, last e green');
  check(score('geese', 'eerie') === '.GY.G', 'five: geese against eerie: the second e green, the first e yellow, the last e green; each answer copy used once');
  check(score('llama', 'hello') === 'YY...', 'five: llama against hello: both l are yellow (hello has two), the rest grey');
  check(score('speed', 'abide') === '..Y.Y', 'five: speed against abide: one yellow e (abide has one e), a yellow d');
  check(score('mamma', 'mambo') === 'GGG..', 'five: mamma against mambo: the greens use up the m and a copies, the rest is grey');
  check(score('error', 'robot') === '.Y.G.', 'five: error against robot: one r in the answer, so one yellow r; the o is green');
  // Keyboard colours: the best result seen for a letter wins.
  const ks = F.keyStates(['llama', 'hello'], 'hello');
  check(ks.l === 'correct' && ks.h === 'correct' && ks.a === 'absent' && ks.m === 'absent', 'five: the keyboard shows the best result per letter');

  // Word lists.
  const words = F.makeWords(sb.FIVE_ALLOWED, sb.FIVE_ANSWERS);
  check(F.isWord(words, 'crane') && F.isWord(words, 'apple') && !F.isWord(words, 'zzzzz') && !F.isWord(words, 'cat'), 'five: allowed guesses accept words and reject others');
  check(words.answers.length >= 1000 && words.answers.every(w => /^[a-z]{5}$/.test(w)), 'five: the answers are five-letter lowercase words');
  check(words.answers.every(w => words.allowed[w]), 'five: every answer is an allowed guess');
  check(Object.keys(words.allowed).length > 8000, 'five: the allowed list is the full five-letter dictionary');
  const answersSorted = words.answers.slice().sort().join();
  check(words.answers.join() !== answersSorted, 'five: the answers are in a shuffled order, not alphabetical');
  // Daily word: a function of the local date only.
  const d1 = new Date(2026, 9, 24, 3), d2 = new Date(2026, 9, 24, 23), d3 = new Date(2026, 9, 25, 3);
  check(F.dailyAnswer(words, d1) === F.dailyAnswer(words, d2), 'five: the daily word is the same all day');
  check(F.dailyAnswer(words, d1) !== F.dailyAnswer(words, d3), 'five: the daily word changes at midnight');
  check(F.dayNumber(d3) === F.dayNumber(d1) + 1 && F.dayNumber(new Date(2026, 0, 1)) === 0, 'five: day numbers count from 1 January 2026');
  check(F.dateKey(d1) === '2026-10-24', 'five: the date key is local and zero padded');
  check(F.shareText('Five Letters', ['stone', 'crane'], 'crane', true) === 'Five Letters 2/6\n' + F.scoreGuess('stone', 'crane').map(s => ({ correct: '🟩', present: '🟨', absent: '⬛' })[s]).join('') + '\n🟩🟩🟩🟩🟩', 'five: the share text is one row of squares a guess');
}

// ── Snake ───────────────────────────────────────────────────────────────────
{
  const K = load(['snake.js']).SnakeEngine;
  let g = K.createGame(10, 10, false, 1);
  g.food = [0, 0];
  check(g.snake.length === 3 && g.snake[0][0] === 5 && g.snake[0][1] === 5 && g.dir === 'right', 'snake: starts three long in the middle heading right');
  check(K.step(g) === 'moved' && g.snake[0][0] === 6 && g.snake.length === 3, 'snake: a step moves the head and keeps the length');

  // Eating grows by one, scores, and puts new food elsewhere.
  g = K.createGame(10, 10, false, 2);
  g.food = [6, 5];
  check(K.step(g) === 'ate' && g.snake.length === 4 && g.score === 1, 'snake: eating grows and scores');
  check(g.food && !g.snake.some(s => s[0] === g.food[0] && s[1] === g.food[1]), 'snake: new food is not under the snake');

  // Walls kill when wrap is off.
  g = K.createGame(10, 10, false, 3); g.food = [0, 0];
  let r = 'moved';
  for (let i = 0; i < 20 && r !== 'dead'; i++) r = K.step(g);
  check(r === 'dead' && g.status === 'over', 'snake: hitting the wall ends the game');
  check(K.step(g) === 'dead', 'snake: a dead snake stays dead');

  // Wrap carries the snake through to the other side.
  g = K.createGame(10, 10, true, 4); g.food = [0, 9];
  for (let i = 0; i < 5; i++) K.step(g);
  check(g.status === 'playing' && g.snake[0][0] === 0 && g.snake[0][1] === 5, 'snake: with wrap, the right edge leads to the left');
  K.turn(g, 'up'); for (let i = 0; i < 6; i++) K.step(g);
  check(g.status === 'playing' && g.snake[0][1] === 9, 'snake: with wrap, the top edge leads to the bottom');

  // A reversal is ignored.
  g = K.createGame(10, 10, false, 5); g.food = [0, 0];
  check(K.turn(g, 'left') === false && K.turn(g, 'right') === false, 'snake: reversing or repeating is ignored');
  check(K.turn(g, 'up') && K.turn(g, 'left') && !K.turn(g, 'down'), 'snake: two quick turns queue, a third (and a reversal of the queue) does not');
  K.step(g); K.step(g);
  check(g.dir === 'left' && g.status === 'playing', 'snake: queued turns apply one a step, so a quick U-turn does not fold in on itself');

  // Self collision.
  g = K.createGame(10, 10, false, 6); g.food = [0, 0];
  g.snake = [[5, 5], [5, 6], [4, 6], [4, 5], [4, 4], [5, 4]]; g.dir = 'up'; // heading up into... (5,4) is the tail's cell? head (5,5) up -> (5,4) is the last cell
  check(K.step(g) === 'moved', 'snake: stepping into the cell the tail is leaving is safe');
  g = K.createGame(10, 10, false, 7); g.food = [0, 0];
  g.snake = [[5, 5], [5, 6], [4, 6], [4, 5], [4, 4], [5, 4], [6, 4]]; g.dir = 'up';
  check(K.step(g) === 'dead', 'snake: running into the body ends the game');
  // Growing: the tail does not leave, so eating into the tail cell is fatal.
  g = K.createGame(10, 10, false, 8);
  g.snake = [[5, 5], [5, 6], [4, 6], [4, 5], [4, 4], [5, 4]]; g.dir = 'up'; g.food = [5, 4];
  check(K.step(g) === 'dead', 'snake: eating onto the tail cell is a collision because the snake grows');
  // Speed rises with apples, with a floor.
  const slow = K.createGame(10, 10, false, 9), fast = K.createGame(10, 10, false, 9); fast.score = 15;
  check(K.stepMs(fast) < K.stepMs(slow) && K.stepMs({ score: 1000 }) >= 40, 'snake: it speeds up with apples, with a floor');
  // Food never lands on the snake over many placements.
  g = K.createGame(6, 6, false, 10);
  let clean = true;
  for (let i = 0; i < 200; i++) { K.placeFood(g); if (g.snake.some(s => s[0] === g.food[0] && s[1] === g.food[1])) clean = false; }
  check(clean, 'snake: food is always on a free cell');
}

// ── Bricks ──────────────────────────────────────────────────────────────────
{
  const B = load(['bricks.js']).BricksEngine;
  check(B.LEVELS.length >= 8 && B.LEVELS.every(l => l.every(row => row.length === B.BRICK_COLS && /^[.#123]+$/.test(row))), 'bricks: levels are data, ten columns wide, with valid characters');
  check(B.LEVELS.every((l, i) => B.createGame(i).bricks.some(k => !k.fixed)), 'bricks: every level has something to break');

  // Angle by hit position.
  const mid = B.paddleBounce(0, 300), right = B.paddleBounce(1, 300), left = B.paddleBounce(-1, 300);
  check(Math.abs(mid.vx) < 1e-9 && mid.vy < 0, 'bricks: the middle of the paddle sends the ball straight up');
  check(right.vx > 0 && left.vx < 0 && Math.abs(right.vx + left.vx) < 1e-9, 'bricks: the right edge sends it right, the left edge left, symmetrically');
  check(Math.abs(Math.hypot(right.vx, right.vy) - 300) < 1e-9 && Math.abs(Math.atan2(right.vx, -right.vy) - B.MAX_ANGLE) < 1e-9, 'bricks: speed is kept and the edge angle is the maximum');

  // Walls and ceiling.
  let g = B.createGame(0); g.bricks = []; g.bricks.push({ x: 0, y: 0, w: 1, h: 1, hp: 1, max: 1, fixed: true, row: 0 });
  g.status = 'playing'; g.ball = { x: 8, y: 200, vx: -200, vy: -100, stuck: false };
  B.step(g, 0.1);
  check(g.ball.vx > 0 && g.ball.x >= B.BALL_R, 'bricks: the ball bounces off the left wall');
  g.ball = { x: 150, y: 8, vx: 50, vy: -200, stuck: false };
  B.step(g, 0.1);
  check(g.ball.vy > 0, 'bricks: the ball bounces off the ceiling');

  // Paddle hit.
  g = B.createGame(0); g.bricks = [{ x: 0, y: 0, w: 1, h: 1, hp: 1, max: 1, fixed: true, row: 0 }];
  g.status = 'playing'; g.paddle.x = 160;
  g.ball = { x: 160 + 20, y: B.PADDLE_Y - 14, vx: 0, vy: 250, stuck: false };
  B.step(g, 0.1);
  check(g.ball.vy < 0 && g.ball.vx > 0, 'bricks: a hit right of centre goes up and to the right');
  g.ball = { x: 160 - 20, y: B.PADDLE_Y - 14, vx: 0, vy: 250, stuck: false };
  B.step(g, 0.1);
  check(g.ball.vy < 0 && g.ball.vx < 0, 'bricks: a hit left of centre goes up and to the left');

  // Brick: reflects, removes, scores.
  g = B.createGame(0); g.status = 'playing';
  const k = g.bricks[g.bricks.length - 1], n0 = g.bricks.length;
  g.ball = { x: k.x + k.w / 2, y: k.y + k.h + B.BALL_R + 2, vx: 0, vy: -250, stuck: false };
  B.step(g, 0.05);
  check(g.bricks.length === n0 - 1 && g.ball.vy > 0 && g.score === 10, 'bricks: hitting a brick from below removes it, scores 10 and sends the ball down');
  // Side hit reflects horizontally.
  g = B.createGame(0); g.status = 'playing';
  const k2 = { x: 100, y: 200, w: 28, h: 14, hp: 1, max: 1, fixed: false, row: 0 };
  g.bricks = [k2, { x: 0, y: 0, w: 1, h: 1, hp: 1, max: 1, fixed: false, row: 0 }];
  g.ball = { x: 100 - B.BALL_R - 2, y: 207, vx: 200, vy: 100, stuck: false };
  B.step(g, 0.05);
  check(g.bricks.length === 1 && g.ball.vx < 0, 'bricks: hitting a brick on its side reflects horizontally');
  // Multi-hit brick and an unbreakable block.
  g = B.createGame(0); g.status = 'playing';
  const tough = { x: 100, y: 200, w: 28, h: 14, hp: 2, max: 2, fixed: false, row: 0 }, stone = { x: 200, y: 200, w: 28, h: 14, hp: 1, max: 1, fixed: true, row: 0 }, spare = { x: 0, y: 0, w: 1, h: 1, hp: 1, max: 1, fixed: false, row: 0 };
  g.bricks = [tough, stone, spare];
  g.ball = { x: 114, y: 214 + B.BALL_R + 2, vx: 0, vy: -250, stuck: false };
  B.step(g, 0.05);
  check(tough.hp === 1 && g.bricks.includes(tough), 'bricks: a two-hit brick survives the first hit');
  g.ball = { x: 214, y: 214 + B.BALL_R + 2, vx: 0, vy: -250, stuck: false };
  B.step(g, 0.05);
  check(g.bricks.includes(stone) && g.ball.vy > 0, 'bricks: an unbreakable block bounces the ball and stays');
  // No tunnelling at speed.
  g = B.createGame(0); g.status = 'playing';
  g.bricks = [{ x: 100, y: 200, w: 28, h: 2, hp: 1, max: 1, fixed: false, row: 0 }, { x: 0, y: 0, w: 1, h: 1, hp: 1, max: 1, fixed: false, row: 0 }];
  g.ball = { x: 114, y: 260, vx: 0, vy: -420, stuck: false };
  B.step(g, 0.2);
  check(g.bricks.length === 1, 'bricks: a fast ball does not pass through a thin brick');
  // Losing the ball.
  g = B.createGame(0); g.status = 'playing'; g.paddle.x = 40; g.ball = { x: 280, y: B.H - 4, vx: 0, vy: 300, stuck: false };
  B.step(g, 0.1);
  check(g.lives === 2 && g.ball.stuck && g.status === 'ready', 'bricks: missing the ball costs a life and resets it to the paddle');
  g.lives = 1; g.status = 'playing'; g.ball = { x: 280, y: B.H - 4, vx: 0, vy: 300, stuck: false };
  B.step(g, 0.1);
  check(g.status === 'over' && g.lives === 0, 'bricks: losing the last ball ends the game');
  // Clearing the level.
  g = B.createGame(0); g.status = 'playing';
  const last = { x: 100, y: 100, w: 28, h: 14, hp: 1, max: 1, fixed: false, row: 0 };
  g.bricks = [last, { x: 200, y: 100, w: 28, h: 14, hp: 1, max: 1, fixed: true, row: 0 }];
  g.ball = { x: 114, y: 114 + B.BALL_R + 2, vx: 0, vy: -250, stuck: false };
  check(B.step(g, 0.05) === 'cleared', 'bricks: breaking the last breakable brick clears the level');
  // Launch and the paddle carrying the ball.
  g = B.createGame(0); B.movePaddle(g, 50);
  check(g.ball.stuck && g.ball.x === 50 && B.movePaddle(g, -100) === undefined && g.paddle.x === g.paddle.w / 2, 'bricks: a waiting ball rides the paddle, which stays on the field');
  check(B.launch(g) && !g.ball.stuck && g.ball.vy < 0 && g.status === 'playing', 'bricks: launching sends the ball up');
  check(B.levelSpeed(5, 0) > B.levelSpeed(0, 0) && B.levelSpeed(99, 999) <= 430, 'bricks: later levels are faster, with a cap');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
