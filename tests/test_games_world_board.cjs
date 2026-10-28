// ZimiGames world board games: the rules, with no DOM. Backgammon, Go, Oware and Kalah, Nine Men's
// Morris, Gomoku, Four in a Row, Dots and Boxes and Hex.
//
// Run: node tests/test_games_world_board.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
function load(files) {
  const sandbox = {};
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  return sandbox;
}
const seeded = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

// ── Backgammon ──
{
  const B = load(['backgammon.js']).BackgammonEngine;
  const blank = turn => {
    const s = B.newGame();
    s.pts.fill(0); s.bar = [0, 0]; s.off = [0, 0]; s.turn = turn || 0;
    return s;
  };
  const start = B.newGame();
  const count = (s, p) => { let n = s.bar[p] + s.off[p]; for (let i = 0; i < 24; i++) n += B.countAt(s, p, i); return n; };
  check(count(start, 0) === 15 && count(start, 1) === 15, 'backgammon: fifteen checkers a side at the start');
  check(B.pips(start, 0) === 167 && B.pips(start, 1) === 167, 'backgammon: both sides start at 167 pips');

  let s = start; s.dice = [3, 1]; s.rolled = true;
  const steps = B.legalSteps(s);
  check(steps.some(st => st.from === 8 && st.to === 5 && st.die === 3), 'backgammon: white can play 8 to 5 with a three');
  check(!steps.some(st => st.from === 24 && st.to === 21 && B.countAt(s, 1, B.idxOf(0, 21)) > 1), 'backgammon: no step lands on a point black holds');
  const opts = B.turnOptions(s);
  check(opts.length > 10 && opts.every(o => o.steps.length === 2), 'backgammon: an opening 3-1 has many plays, each using both dice');

  // hitting a blot sends it to the bar
  s = blank(0); s.pts[B.idxOf(0, 10)] = 1; s.pts[B.idxOf(0, 6)] = -1; s.pts[B.idxOf(0, 20)] = 1; s.dice = [4]; s.rolled = true;
  let t = B.applyStep(s, { from: 10, to: 6, die: 4 });
  check(t.hit && t.bar[1] === 1 && t.pts[B.idxOf(0, 6)] === 1, 'backgammon: landing on a lone checker hits it onto the bar');

  // entering from the bar: blocked by two, open on one, hits on a blot
  s = blank(0); s.bar[0] = 1; s.pts[B.idxOf(0, 21)] = -2; s.pts[B.idxOf(0, 22)] = -1; s.pts[B.idxOf(0, 10)] = 3; s.dice = [4, 3]; s.rolled = true;
  check(B.stepsFor(s, 0, 4).length === 0, 'backgammon: a bar checker cannot enter on a point held by two');
  const enter = B.stepsFor(s, 0, 3);
  check(enter.length === 1 && enter[0].from === B.BAR && enter[0].to === 22, 'backgammon: it enters with the three, onto a blot');
  check(B.legalSteps(s).every(st => st.from === B.BAR), 'backgammon: with a checker on the bar, only entering is legal');
  check(B.applyStep(s, enter[0]).hit, 'backgammon: entering onto a blot hits it');
  s.dice = [4, 4, 4, 4];
  check(B.legalSteps(s).length === 0, 'backgammon: no entry at all means no move');

  // bearing off: only when all are home; exact die, or a larger die from the highest point
  s = blank(0); s.pts[B.idxOf(0, 5)] = 2; s.pts[B.idxOf(0, 4)] = 2; s.pts[B.idxOf(0, 2)] = 1; s.off[0] = 10; s.dice = [6, 2]; s.rolled = true;
  check(B.allHome(s, 0), 'backgammon: all fifteen home allows bearing off');
  let off6 = B.stepsFor(s, 0, 6);
  check(off6.length === 1 && off6[0].from === 5 && off6[0].to === 0, 'backgammon: a six bears off from the highest point only');
  check(B.stepsFor(s, 0, 2).some(st => st.from === 2 && st.to === 0), 'backgammon: an exact two bears off the two point');
  s.pts[B.idxOf(0, 12)] = 1;
  check(!B.allHome(s, 0) && !B.stepsFor(s, 0, 6).some(st => st.to === 0), 'backgammon: a checker outside home forbids bearing off');

  // must use both dice if possible; and the larger die if only one can be played
  s = blank(0); s.pts[B.idxOf(0, 8)] = 1; s.pts[B.idxOf(0, 1)] = -2; s.dice = [6, 1]; s.rolled = true;
  const big = B.legalSteps(s);
  check(big.length === 1 && big[0].die === 6, 'backgammon: when only one die can be played and both could start, the six is forced');
  s = blank(0); s.pts[B.idxOf(0, 20)] = 1; s.pts[B.idxOf(0, 16)] = 1; s.dice = [4, 3]; s.rolled = true;
  check(B.turnOptions(s).every(o => o.steps.length === 2), 'backgammon: both dice are played whenever they can be');
  // the rules checked against a brute-force count over many positions from random play
  const rnd = seeded(17);
  const brute = (st) => { // longest run of single-die steps, ignoring the "play as many as possible" rule
    if (!st.dice.length) return 0;
    let best = 0;
    for (const d of new Set(st.dice)) for (const step of B.stepsFor(st, st.turn, d)) best = Math.max(best, 1 + brute(B.applyStep(st, step)));
    return best;
  };
  let rulesOk = true, positions = 0, larger = 0;
  let cur = B.newGame();
  for (let turn = 0; turn < 160 && rulesOk; turn++) {
    const a = 1 + ((rnd() * 6) | 0), b2 = 1 + ((rnd() * 6) | 0);
    cur.dice = a === b2 ? [a, a, a, a] : [Math.max(a, b2), Math.min(a, b2)]; cur.rolled = true;
    const need = brute(cur), options = B.turnOptions(cur);
    positions++;
    if (!options.every(o => o.steps.length === need)) rulesOk = false;
    if (need === 1 && a !== b2) {
      const playable = [a, b2].filter(d => B.stepsFor(cur, cur.turn, d).length);
      if (playable.length === 2) { larger++; if (!options.every(o => o.steps[0].die === Math.max(a, b2))) rulesOk = false; }
    }
    const plan = options.length ? options[(rnd() * options.length) | 0].steps : [];
    for (const st of plan) cur = B.applyStep(cur, st);
    if (B.winner(cur) >= 0) cur = B.newGame();
    cur = B.endTurn(cur);
  }
  check(rulesOk && positions > 100, 'backgammon: every play uses as many dice as possible, and the larger die when only one can be played (' + positions + ' positions, ' + larger + ' with a choice)');
  // winning and the gammon count
  s = blank(0); s.off[0] = 15; s.pts[B.idxOf(1, 3)] = -5;
  check(B.winner(s) === 0 && B.outcome(s, 0).kind === 'gammon' && B.outcome(s, 0).points === 2, 'backgammon: 15 off wins; the loser with none off loses a gammon');
  s.bar[1] = 1; s.cube.value = 2;
  check(B.outcome(s, 0).kind === 'backgammon' && B.outcome(s, 0).points === 6, 'backgammon: a checker on the bar makes it a backgammon, and the cube multiplies');
  // the computer plays something legal and uses both dice
  const rng = seeded(5);
  let ok = true;
  for (let i = 0; i < 30; i++) {
    s = B.newGame(); s.turn = i % 2; s.dice = [1 + ((rng() * 6) | 0), 1 + ((rng() * 6) | 0)]; s.rolled = true;
    const plan = B.chooseTurn(s, ['easy', 'medium', 'hard'][i % 3], rng);
    let cur = s;
    for (const st of plan) { if (!B.legalSteps(cur).some(l => l.from === st.from && l.to === st.to && l.die === st.die)) ok = false; cur = B.applyStep(cur, st); }
    if (!plan.length) ok = false;
  }
  check(ok, 'backgammon: the computer only plays legal steps');
}

// ── Go ──
{
  const sb = load(['go-engine.js']);
  const Go = sb.makeGoEngine();
  const pos = (rows, turn) => {
    const n = rows.length, st = Go.newGame(n);
    rows.forEach((r, i) => [...r].forEach((ch, j) => { st.board[i * n + j] = ch === 'X' ? 1 : ch === 'O' ? 2 : 0; }));
    st.turn = turn || 1;
    return st;
  };
  let st = pos(['OX...', '.....', '.....', '.....', '.....'], 1);
  let nx = Go.move(st, 5);
  check(nx && nx.board[0] === 0 && nx.caps[0] === 1, 'go: a corner stone with its last liberty taken is captured');
  st = pos(['OOX..', 'OXX..', 'XX...', '.....', '.....'], 1);
  nx = Go.move(Go.move(st, -1), -1);
  check(nx.passes === 2, 'go: two passes in a row are counted');
  check(Go.move(st, 0) === null, 'go: an occupied point is illegal');
  st = pos(['.XXX.', 'XOOO.', '.XXX.', '.....', '.....'], 1);
  nx = Go.move(st, 9);
  check(nx && nx.caps[0] === 3 && nx.board[6] === 0 && nx.board[7] === 0 && nx.board[8] === 0, 'go: a whole group is captured at once');
  // suicide is forbidden
  st = pos(['.X...', 'X....', '.....', '.....', '.....'], 2);
  check(Go.move(st, 0) === null, 'go: playing into a point with no liberties (suicide) is illegal');
  // ...unless the move captures
  st = pos(['.XO..', 'XO...', 'O....', '.....', '.....'], 2);
  nx = Go.move(st, 0);
  check(nx && nx.caps[1] === 2 && nx.board[0] === 2, 'go: a move that captures first is not suicide');
  // ko
  st = pos(['.XO..', 'XO.O.', '.XO..', '.....', '.....'], 1);
  nx = Go.move(st, 7);
  check(nx && nx.caps[0] === 1 && nx.ko === 6, 'go: taking the ko stone sets the ko point');
  check(Go.move(nx, 6) === null, 'go: the ko cannot be retaken at once');
  const away = Go.move(Go.move(nx, 24), 23);
  check(away && Go.move(away, 6) !== null, 'go: after a move elsewhere each way the ko may be retaken');
  // scoring: territory, prisoners, komi, dead stones
  const wall = ['.X.O.', '.X.O.', '.X.O.', '.X.O.', '.X.O.'];
  st = pos(wall, 1);
  let sc = Go.score(st.board, 5, null, [0, 0]);
  check(sc.black === 5 && sc.white === 5 + 6.5 && sc.terrB === 5 && sc.terrW === 5, 'go: territory counts, the middle file is neutral, white gets 6.5 komi');
  st = pos(['.XO.O', '.X..O', '.X.OO', '.X.O.', '.X.O.'], 1);
  const dead = new Array(25).fill(false); dead[2] = true;
  sc = Go.score(st.board, 5, dead, [1, 0]);
  check(sc.black === 5 + 1 + 1 && sc.prisB === 2, 'go: a dead white stone is a prisoner for black and its point is black territory');
  // the computer
  st = pos(['.........', '.........', '.........', '....X....', '...XO....', '....X....', '.........', '.........', '.........'], 1);
  const g = Go.genMove(st, 80, 'hard');
  check(g.move === 41, 'go: the computer takes a group left in atari');
  st = pos(['.........', '.........', '....O....', '...OX....', '....O....', '.........', '.........', '.........', '.........'], 1);
  check(Go.genMove(st, 80, 'hard').move === 32, 'go: the computer saves its own group in atari');
  st = Go.newGame(9);
  let legalAll = true;
  for (let i = 0; i < 12; i++) { const r = Go.genMove(st, 40, 'medium'); const m = Go.move(st, r.move); if (!m) { legalAll = false; break; } st = m; }
  check(legalAll, 'go: twelve computer moves in a row are all legal');
  const worker = Go.handle({ cmd: 'move', n: 9, board: Array.from(Go.newGame(9).board), turn: 1, caps: [0, 0], ko: -1, passes: 0, last: -1, moves: 0, ms: 40, level: 'easy', seed: 7, id: 1 });
  check(worker && typeof worker.move === 'number', 'go: the worker entry answers a move request');
}

// ── Oware and Kalah ──
{
  const M = load(['mancala.js']).MancalaEngine, O = M.Oware, K = M.Kalah;
  const oware = (pits, turn, score) => ({ pits: Int8Array.from(pits), score: score || [0, 0], turn: turn || 0, quiet: 0, done: false });
  let s = O.newState();
  let r = O.sow(s, 0);
  check(Array.from(r.state.pits).slice(0, 6).join() === '0,5,5,5,5,4' && r.state.turn === 1, 'oware: sowing pit 0 drops one seed in each of the next four pits');
  s = oware([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 2]);
  r = O.sow(s, 5);
  check(r.captured.length === 1 && r.state.score[0] === 2 && r.state.pits[6] === 0, 'oware: ending on an opponent pit that makes two takes it');
  s = oware([0, 0, 0, 0, 3, 0, 1, 2, 0, 0, 0, 9]);
  r = O.sow(s, 4);
  check(r.state.score[0] === 5 && r.captured.length === 2, 'oware: captures run back through the pits holding two or three');
  // grand slam: it would take every seed the opponent has, so nothing is taken
  s = oware([0, 0, 0, 0, 3, 0, 1, 1, 0, 0, 0, 0]);
  r = O.sow(s, 4);
  check(r.grandSlam && r.state.score[0] === 0 && r.state.pits[6] === 2 && r.state.pits[7] === 2, 'oware: a grand slam is played but captures nothing');
  // feeding rule: the other side has no seeds, so the move has to reach it
  s = oware([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0]);
  check(O.moves(s).join() === '5', 'oware: with the opponent empty, only a move that feeds it is legal');
  s = oware([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  check(O.moves(s).length === 0, 'oware: if no move can feed the opponent there is no legal move');
  // 25 wins
  s = oware([0, 0, 0, 0, 0, 1, 1, 0, 3, 0, 0, 0], 0, [24, 3]);
  r = O.sow(s, 5);
  check(r.state.done && M.result(r.state) === 0 && r.state.score[0] === 26, 'oware: reaching 25 ends the game');
  // sowing a pit of twelve or more skips the starting pit
  s = oware([0, 0, 0, 0, 0, 13, 0, 0, 0, 0, 0, 0]);
  r = O.sow(s, 5);
  check(r.state.pits[5] === 0 && r.path.indexOf(5) < 0, 'oware: a pit of twelve or more skips itself when sowing');

  // Kalah
  s = K.newState();
  r = K.sow(s, 2);
  check(r.extra && r.state.turn === 0 && r.state.pits[6] === 1, 'kalah: ending in your store gives another turn');
  r = K.sow(s, 0);
  check(!r.extra && r.state.turn === 1 && r.state.pits[4] === 5, 'kalah: an ordinary sow passes the turn');
  s = { pits: Int8Array.from([1, 0, 0, 0, 3, 0, 0, 2, 0, 0, 0, 5, 0, 0]), score: [0, 0], turn: 0, quiet: 0, done: false };
  r = K.sow(s, 0);
  check(r.captured.length === 2 && r.state.pits[6] === 6 && r.state.pits[11] === 0 && r.state.pits[1] === 0, 'kalah: ending in your own empty pit takes the pit opposite, and your seed');
  s = { pits: Int8Array.from([0, 1, 0, 0, 0, 9, 0, 1, 1, 1, 1, 1, 1, 0]), score: [0, 0], turn: 0, quiet: 0, done: false };
  r = K.sow(s, 5);
  check(r.state.pits[13] === 0 && r.path.indexOf(13) < 0 && r.state.pits[6] === 1, 'kalah: sowing skips the opponent store and drops one in your own');
  s = { pits: Int8Array.from([0, 0, 0, 0, 0, 1, 0, 3, 0, 0, 0, 0, 0, 4]), score: [0, 4], turn: 0, quiet: 0, done: false };
  r = K.sow(s, 5);
  check(r.state.done && r.state.score[0] === 1 && r.state.score[1] === 7, 'kalah: when one side runs out the other side keeps its seeds');
  // the computer never plays an illegal pit, in either game
  const rng = seeded(11);
  let ok = true;
  for (const rules of ['oware', 'kalah']) {
    let st = M.RULES[rules].newState(), n = 0;
    while (!st.done && n < 400) {
      const m = M.chooseMove(rules, st, ['easy', 'medium'][n % 2], rng);
      if (M.RULES[rules].moves(st).indexOf(m) < 0) { ok = false; break; }
      st = M.RULES[rules].sow(st, m).state; n++;
    }
    if (!st.done) ok = false;
  }
  check(ok, 'mancala: computer games in both rule sets are legal and finish');
}

// ── Nine Men's Morris ──
{
  const Mo = load(['morris.js']).MorrisEngine;
  const blank = (turn) => { const s = Mo.newState(); s.turn = turn || 0; return s; };
  check(Mo.MILLS.length === 16 && Mo.ADJ.every(a => a.length >= 2 && a.length <= 4), 'morris: 16 lines of three and every point has two to four neighbours');
  let s = blank(0);
  s.board[0] = 1; s.board[1] = 1; s.hand = [7, 9];
  s.board[10] = 2; s.board[12] = 2; s.hand[1] = 7;
  let p = Mo.partial(s, -1, 2);
  check(p.mill && p.state.hand[0] === 6, 'morris: placing the third man in a line makes a mill');
  const rem = Mo.removable(p.state);
  check(rem.length === 2 && rem.indexOf(10) >= 0, 'morris: a mill may take any man of the other side');
  s.board[11] = 2; s.board[9] = 2; s.hand[1] = 5;
  check(Mo.inMill(s.board, 11) && !Mo.inMill(s.board, 9), 'morris: three in a line count as a mill, and a man beside it is not in one');
  p = Mo.partial(s, -1, 2);
  const rem2 = Mo.removable(p.state);
  check(rem2.join() === '9', 'morris: men in a mill are safe while others can be taken');
  // all in mills: any may be taken
  const s2 = blank(0); s2.board[0] = 1; s2.board[1] = 1; s2.hand = [7, 6];
  s2.board[8] = 2; s2.board[9] = 2; s2.board[10] = 2; s2.hand[1] = 6;
  const p2 = Mo.partial(s2, -1, 2);
  check(Mo.removable(p2.state).length === 3, 'morris: when every man is in a mill, any may be taken');
  // sliding is along lines only; flying at three
  const m = blank(0); m.hand = [0, 0]; m.board[0] = 1; m.board[5] = 1; m.board[6] = 1; m.board[7] = 1; m.board[13] = 2; m.board[14] = 2; m.board[15] = 2; m.board[21] = 2;
  check(Mo.phase(m, 0) === 'move' && Mo.targets(m, 0).sort().join() === '1', 'morris: with four men a man only slides to a neighbouring empty point');
  const f = blank(0); f.hand = [0, 0]; f.board[0] = 1; f.board[1] = 1; f.board[8] = 1; f.board[13] = 2; f.board[14] = 2; f.board[15] = 2; f.board[21] = 2;
  check(Mo.phase(f, 0) === 'fly' && Mo.targets(f, 0).length === 24 - 7, 'morris: with three men left a side flies to any empty point');
  // reducing to two men wins
  const fin = blank(0); fin.hand = [0, 0]; fin.board[0] = 1; fin.board[1] = 1; fin.board[3] = 1; fin.board[4] = 1; fin.board[10] = 2; fin.board[12] = 2; fin.board[20] = 2;
  const take = Mo.moves(fin).find(x => x.from === 3 && x.to === 2 && x.rem >= 0);
  const after = take && Mo.apply(fin, take);
  check(after && after.over && after.winner === 0, 'morris: taking a man from a side with three leaves two, and ends the game');
  // a side with every man blocked loses
  const blk = blank(0); blk.hand = [0, 0];
  [0, 2, 4, 6].forEach(i => { blk.board[i] = 2; }); [1, 3, 5, 7, 9].forEach(i => { blk.board[i] = 1; });
  const blocked = Mo.finish({ state: blk, mill: false }, -1, 'move');
  check(blocked.over && blocked.winner === 0, 'morris: a side with no legal move loses');
  // computer legality
  const rng = seeded(3);
  let st = Mo.newState(), ok = true, n = 0;
  while (!st.over && n < 160) {
    const c = Mo.chooseMove(st, 'easy', rng);
    if (!Mo.moves(st).some(x => x.from === c.from && x.to === c.to && x.rem === c.rem)) { ok = false; break; }
    st = Mo.apply(st, c); n++;
  }
  check(ok, 'morris: the computer only plays legal moves, including its mills');
}

// ── Gomoku ──
{
  const Gm = load(['gomoku.js']).GomokuEngine, N = 15;
  const put = (b, list, p) => list.forEach(([r, c]) => { b[r * N + c] = p; });
  let b = Gm.empty();
  put(b, [[7, 3], [7, 4], [7, 5], [7, 6]], 1);
  check(!Gm.lineThrough(b, 7 * N + 4), 'gomoku: four in a row is not a win');
  b[7 * N + 7] = 1;
  check(Gm.lineThrough(b, 7 * N + 5).length === 5, 'gomoku: five in a row wins');
  b = Gm.empty(); put(b, [[2, 2], [3, 3], [4, 4], [5, 5], [6, 6]], 2);
  check(Gm.lineThrough(b, 4 * N + 4).length === 5, 'gomoku: a diagonal of five wins');
  b = Gm.empty(); put(b, [[2, 9], [3, 8], [4, 7], [5, 6], [6, 5]], 1);
  check(Gm.lineThrough(b, 2 * N + 9).length === 5, 'gomoku: the other diagonal wins too');
  b = Gm.empty(); put(b, [[1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4]], 1);
  check(Gm.lineThrough(b, 3 * N + 4).length === 6, 'gomoku: a column, and six in a row also counts (freestyle)');
  b = Gm.empty(); put(b, [[7, 3], [7, 4], [7, 5], [7, 6]], 1); put(b, [[7, 2]], 2);
  const win = Gm.chooseMove(b, 1, 'medium', seeded(1));
  check(win === 7 * N + 7, 'gomoku: the computer completes its own five');
  b = Gm.empty(); put(b, [[7, 3], [7, 4], [7, 5], [7, 6]], 1); put(b, [[7, 2]], 2); put(b, [[3, 3], [3, 4]], 2);
  check(Gm.chooseMove(b, 2, 'hard', seeded(1)) === 7 * N + 7, 'gomoku: the computer blocks an open four it cannot win through');
  check(Gm.chooseMove(Gm.empty(), 1, 'hard', seeded(1)) === 7 * N + 7, 'gomoku: the computer opens in the centre');
}

// ── Four in a Row ──
{
  const F = load(['fourinarow.js']).FourInARowEngine, C = 7;
  let b = F.empty();
  for (let i = 0; i < 3; i++) b = F.drop(b, 2, 1);
  check(F.dropRow(b, 2) === 2, 'four in a row: discs stack from the bottom');
  b = F.drop(b, 2, 1);
  check(F.lineThrough(b, F.dropRow(b, 2) * C + 2 + C), 'four in a row: four in a column wins');
  b = F.empty(); for (const c of [0, 1, 2]) b = F.drop(b, c, 2); b = F.drop(b, 3, 2);
  check(F.lineThrough(b, 5 * C + 3).length === 4, 'four in a row: four along the bottom wins');
  b = F.empty();
  b = F.drop(b, 0, 1); b = F.drop(b, 1, 2); b = F.drop(b, 1, 1); b = F.drop(b, 2, 2); b = F.drop(b, 2, 2); b = F.drop(b, 2, 1);
  b = F.drop(b, 3, 2); b = F.drop(b, 3, 2); b = F.drop(b, 3, 2); b = F.drop(b, 3, 1);
  check(F.lineThrough(b, 2 * C + 3).length === 4, 'four in a row: a rising diagonal wins');
  b = F.empty();
  for (let k = 0; k < 6; k++) b = F.drop(b, 0, 1 + (k % 2));
  check(F.drop(b, 0, 1) === null && F.legalCols(b).indexOf(0) < 0, 'four in a row: a full column takes no more discs');
  b = F.empty(); for (const c of [0, 1, 2]) b = F.drop(b, c, 1); b = F.drop(b, 6, 2);
  check(F.chooseCol(b, 1, 'easy', seeded(1)) === 3, 'four in a row: the computer takes a win it can see');
  check(F.chooseCol(b, 2, 'medium', seeded(1)) === 3, 'four in a row: and blocks the other side\'s three');
  const col = F.chooseCol(F.empty(), 1, 'hard', seeded(1));
  check(col === 3, 'four in a row: the hard computer opens in the middle column');
}

// ── Dots and Boxes ──
{
  const D = load(['dotsandboxes.js']).DotsAndBoxesEngine;
  const n = 3, H = n * (n - 1);
  let s = D.newState(n);
  check(D.dims(n).E === 12 && D.dims(n).B === 4, 'dots and boxes: 3 by 3 dots make 12 lines and 4 boxes');
  check(D.boxEdges(n, 0).join() === [0, 2, H, H + 1].join(), 'dots and boxes: a box is bounded by two horizontal and two vertical lines');
  check(D.edgeBoxes(n, 2).length === 2 && D.edgeBoxes(n, 0).length === 1, 'dots and boxes: a middle line borders two boxes, an outer one');
  let r = D.play(s, 0); s = r.state;
  check(s.turn === 1 && !r.taken.length, 'dots and boxes: an ordinary line passes the turn');
  s = D.play(s, 2).state; s = D.play(s, H).state;
  r = D.play(s, H + 1);
  check(r.taken.length === 1 && r.state.owner[0] === 2 && r.state.turn === 1 && r.state.score[1] === 1, 'dots and boxes: closing a box takes it and keeps the turn');
  // draw everything except the middle vertical line shared by boxes 0 and 1 (line index H+1 is between them)
  const all = []; for (let e = 0; e < D.dims(n).E; e++) if (e !== H + 1) all.push(e);
  let tmp = D.newState(n);
  for (const e of all) { tmp = Object.assign({}, tmp); tmp = D.play(tmp, e).state; }
  const last = D.play(tmp, H + 1);
  check(last.taken.length === 2, 'dots and boxes: one line can close two boxes at once');
  // the computer takes a box when one is there, at every level
  let v = D.newState(n);
  [0, 2, H].forEach(e => { v = D.play(v, e).state; });
  v.turn = 1;
  for (const level of ['easy', 'medium', 'hard']) check([H + 1].indexOf(D.chooseEdge(v, level, () => 0.1)) >= 0, 'dots and boxes: the ' + level + ' computer closes a box that is one line short');
  // medium avoids giving away a third side when it has a choice
  let w = D.newState(n);
  w = D.play(w, 0).state; w = D.play(w, 2).state;
  const pick = D.chooseEdge(w, 'medium', seeded(4));
  check(D.edgeBoxes(n, pick).every(bx => D.sides(w, bx) < 2), 'dots and boxes: the computer does not hand over a box when a safe line exists');
  // whole games finish and end with all boxes owned
  const rng = seeded(9);
  let g = D.newState(4), k = 0;
  while (!D.isOver(g) && k < 100) { g = D.play(g, D.chooseEdge(g, ['easy', 'medium', 'hard'][k % 3], rng)).state; k++; }
  check(D.isOver(g) && g.score[0] + g.score[1] === 9, 'dots and boxes: a whole game ends with every box taken');
}

// ── Hex ──
{
  const Hx = load(['hex.js']).HexEngine, n = 5;
  const put = (b, cells, p) => cells.forEach(([r, c]) => { b[r * n + c] = p; });
  let b = Hx.empty(n);
  put(b, [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]], 1);
  check(Hx.winner(b, n) === 1, 'hex: red links top to bottom');
  b = Hx.empty(n); put(b, [[2, 0], [2, 1], [2, 2], [2, 3], [2, 4]], 2);
  check(Hx.winner(b, n) === 2, 'hex: blue links left to right');
  b = Hx.empty(n); put(b, [[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]], 1);
  check(Hx.winner(b, n) === 1, 'hex: the short diagonal is a chain (each step is a neighbour)');
  b = Hx.empty(n); put(b, [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]], 1);
  check(Hx.winner(b, n) === 0, 'hex: the long diagonal is not a chain');
  b = Hx.empty(n); put(b, [[0, 1], [1, 1], [2, 1], [3, 1]], 1);
  check(Hx.winner(b, n) === 0, 'hex: one cell short is no win');
  const chain = (put(b, [[4, 0]], 1), Hx.winningChain(b, n, 1));
  check(chain && chain[0] < n && chain[chain.length - 1] >= n * (n - 1), 'hex: the winning chain runs from one side to the other');
  b = Hx.empty(n); put(b, [[2, 0], [2, 1], [2, 2], [2, 3]], 2); put(b, [[2, 4]], 1);
  check(Hx.winner(b, n) === 0 && Hx.dist(b, n, 2) >= 1, 'hex: a blocked row is not a win and still needs a cell');
  // the computer: legal, takes a winning cell, and plays full games
  b = Hx.empty(n); put(b, [[0, 2], [1, 2], [2, 2], [3, 2]], 1); put(b, [[0, 0], [1, 0]], 2);
  const mv = Hx.chooseMove(b, n, 1, 'medium', seeded(2));
  check(mv >= 0 && b[mv] === 0, 'hex: the computer plays an empty cell');
  const rng = seeded(21);
  let g = Hx.empty(n), p = 1, k = 0, ok = true;
  while (!Hx.winner(g, n) && k < n * n) {
    const c = Hx.chooseMove(g, n, p, ['easy', 'medium', 'hard'][k % 3], rng);
    if (c < 0 || g[c]) { ok = false; break; }
    g[c] = p; p = 3 - p; k++;
  }
  check(ok && Hx.winner(g, n) > 0, 'hex: a computer game always ends with a winner (no draws)');
  check(Hx.worthSwapping(11, 5 * 11 + 5) && !Hx.worthSwapping(11, 0), 'hex: the computer swaps a strong opening and leaves a weak corner');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all world board game tests passed');
