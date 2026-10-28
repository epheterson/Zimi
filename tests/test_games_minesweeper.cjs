// Arcade Minesweeper: the rules, with no DOM. First click is safe, a flood opens
// the right region, chords open or explode correctly, a win is a win.
//
// Run: node tests/test_games_minesweeper.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'builtin', 'games', 'minesweeper.js'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'builtin', 'games', 'util.js'), 'utf8'), sandbox);
vm.runInContext(src, sandbox);
const E = sandbox.MinesweeperEngine;

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};
const mineCount = g => g.mine.reduce((a, b) => a + b, 0);

// A hand-made board: lay the mines yourself, then play.
function board(rows, cols, mineCells) {
  const g = E.createGame(rows, cols, mineCells.length, 1);
  mineCells.forEach(i => { g.mine[i] = 1; });
  for (let i = 0; i < g.size; i++) g.count[i] = g.nb[i].reduce((a, n) => a + g.mine[n], 0);
  g.placed = true; g.status = 'playing';
  return g;
}

// ── the sandbox loaded without a page ──
check(!!E && typeof E.createGame === 'function', 'engine loads with no document');

// ── first click is always safe and opens an area ──
{
  let bad = 0, notOpened = 0, wrongCount = 0, runs = 0;
  for (const lv of Object.values(E.LEVELS)) {
    for (let seed = 1; seed <= 300; seed++) {
      const g = E.createGame(lv.rows, lv.cols, lv.mines, seed);
      const first = (seed * 7919) % g.size;
      const res = E.reveal(g, first);
      runs++;
      if (g.mine[first] || g.status === 'lost') bad++;
      if (mineCount(g) !== lv.mines) wrongCount++;
      if (g.nb[first].some(n => g.mine[n])) bad++;       // neighbours clear too
      if (g.count[first] !== 0 || res.opened.length < 2) notOpened++;
    }
  }
  check(bad === 0, 'first click and its neighbours never hold a mine (' + runs + ' boards, all levels, corners included)');
  check(notOpened === 0, 'first click always opens an area');
  check(wrongCount === 0, 'every board holds exactly the asked mine count');
}
{
  // A board too full to spare the neighbours still spares the clicked cell.
  let bad = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const g = E.createGame(5, 5, 20, seed);          // 25 cells, 20 mines: only 5 safe
    const first = seed % 25;
    E.reveal(g, first);
    if (g.mine[first] || mineCount(g) !== 20) bad++;
  }
  check(bad === 0, 'a crowded board keeps the first cell safe');
}
{
  const a = E.createGame(16, 30, 99, 42), b = E.createGame(16, 30, 99, 42);
  E.reveal(a, 100); E.reveal(b, 100);
  check(Buffer.compare(Buffer.from(a.mine), Buffer.from(b.mine)) === 0, 'the same seed gives the same board');
}

// ── neighbour counts ──
{
  const g = board(3, 3, [0, 2, 6]);
  check(g.count[4] === 3, 'centre counts its three mine neighbours');
  check(g.count[1] === 2 && g.count[3] === 2 && g.count[7] === 1, 'edge counts are right');
}

// ── flood fill ──
{
  //  M . . .
  //  . . . .      the mine at 0 makes the 1s at 1,4,5; everything else is zero
  //  . . . .
  const g = board(3, 4, [0]);
  const res = E.reveal(g, 11);
  check(res.opened.length === 11 && !res.opened.includes(0), 'flood opens every cell but the mine');
  check(g.status === 'won', 'opening the last safe cell wins');
}
{
  // A wall of mines splits the board; the flood must stay on its side.
  const g = board(5, 5, [2, 7, 12, 17, 22]);
  const res = E.reveal(g, 0);
  const opened = new Set(res.opened);
  check([...opened].every(i => i % 5 <= 1), 'flood stops at the wall of numbers');
  check(opened.size === 10, 'flood opens the whole left side, numbers included');
  check(g.status === 'playing', 'game goes on after a partial flood');
}
{
  // Flags hold: a flagged cell inside the region stays shut.
  const g = board(3, 4, [0]);
  E.cycleMark(g, 7, false);
  E.reveal(g, 11);
  check(g.state[7] === E.FLAG, 'flood does not open a flagged cell');
  check(g.status === 'playing', 'the flagged safe cell keeps the game open');
}
{
  // Expert-sized empty board: iterative, no stack overflow.
  const g = E.createGame(24, 30, 1, 5);
  let ok = true;
  try { E.reveal(g, 0); } catch (e) { ok = false; }
  check(ok && g.opened >= 24 * 30 - 1 - 8, 'a near-empty big board floods without overflowing');
}

// ── marks ──
{
  const g = board(3, 3, [8]);
  check(E.cycleMark(g, 0, true) === E.FLAG && g.flags === 1, 'first mark is a flag');
  check(E.cycleMark(g, 0, true) === E.QUESTION && g.flags === 0, 'second is a ?, and the count gives the flag back');
  check(E.cycleMark(g, 0, true) === E.HIDDEN, 'third clears');
  E.cycleMark(g, 0, false);
  check(E.cycleMark(g, 0, false) === E.HIDDEN, 'with ? off a flag clears straight away');
  E.reveal(g, 0);
  check(E.cycleMark(g, 0, true) === -1, 'an open cell takes no mark');
  const h = board(3, 3, [8, 6]);
  E.cycleMark(h, 4, true);
  E.reveal(h, 4);
  check(h.state[4] === E.FLAG, 'a flagged cell cannot be opened');
  E.cycleMark(h, 4, true);
  E.reveal(h, 4);
  check(h.state[4] === E.OPEN, 'a ? cell can be opened');
}
{
  const g = E.createGame(9, 9, 10, 3);
  check(E.cycleMark(g, 5, true) === E.FLAG && g.status === 'ready', 'a flag may go down before the first click');
}

// ── chord ──
{
  // Row of three: mine at 0 and 2 of a 3x3, centre top is a 2.
  const g = board(3, 3, [0, 2]);
  E.reveal(g, 4);                                   // the centre: count 2
  E.cycleMark(g, 0, false); E.cycleMark(g, 2, false);
  const res = E.chord(g, 4);
  check(res.hit.length === 0 && g.state[1] === E.OPEN && g.state[3] === E.OPEN && g.state[8] === E.OPEN, 'chord with right flags opens the other neighbours');
  check(g.status === 'won', 'and that chord finished the board');
}
{
  const g = board(3, 3, [0, 2]);
  E.reveal(g, 4);
  E.cycleMark(g, 0, false);
  const res = E.chord(g, 4);
  check(res.opened.length === 0 && g.state[1] === E.HIDDEN, 'chord with too few flags does nothing');
}
{
  // Wrong flag: flag cell 1 (safe) and 0 (mine); mine at 2 gets opened.
  const g = board(3, 3, [0, 2]);
  E.reveal(g, 4);
  E.cycleMark(g, 0, false); E.cycleMark(g, 1, false);
  const res = E.chord(g, 4);
  check(g.status === 'lost' && res.hit.length === 1 && res.hit[0] === 2, 'chord on a wrong flag explodes the missed mine');
  check(g.exploded[0] === 2 && g.state[2] === E.OPEN, 'the exploded cell is recorded and shown');
  check(g.state[1] === E.FLAG && !g.mine[1], 'the wrong flag stays, ready to be crossed out');
}
{
  const g = board(3, 3, [0]);
  E.reveal(g, 4);
  check(E.chord(g, 4).opened.length === 0, 'chord on a number with no flags does nothing');
  const z = board(3, 3, [8]);
  E.reveal(z, 0);
  check(E.chord(z, 0).opened.length === 0, 'chord on a zero does nothing');
}

// ── loss and win ──
{
  const g = board(3, 3, [0, 8]);
  E.cycleMark(g, 5, false);                         // a wrong flag
  const res = E.reveal(g, 0);
  check(g.status === 'lost' && res.hit[0] === 0 && g.exploded.length === 1, 'opening a mine loses');
  check(g.state[8] === E.OPEN, 'a loss shows every other mine');
  check(g.state[5] === E.FLAG, 'a loss leaves wrong flags for crossing out');
  check(E.reveal(g, 1).opened.length === 0 && E.cycleMark(g, 1, true) === -1, 'a finished game takes no more moves');
}
{
  const g = board(3, 3, [0, 8]);
  for (let i = 0; i < 9; i++) if (!g.mine[i]) E.reveal(g, i);
  check(g.status === 'won', 'opening every safe cell wins');
  check(g.mine[0] && g.state[0] === E.FLAG && g.state[8] === E.FLAG && g.flags === 2, 'a win flags every mine');
}
{
  const g = board(3, 3, [0]);
  E.cycleMark(g, 0, false);
  for (let i = 1; i < 9; i++) E.reveal(g, i);
  check(g.status === 'won', 'flags alone do not win; opening the safe cells does');
  const h = board(3, 3, [0]);
  E.reveal(h, 8);
  check(h.status === 'playing' || h.status === 'won', 'a partial board is not lost');
}

// ── custom validation ──
{
  const ok = E.validateCustom('12', '20', '40');
  check(ok.ok && ok.rows === 12 && ok.cols === 20 && ok.mines === 40, 'valid custom board passes (strings, as typed)');
  check(E.validateCustom(9, 9, 10).ok, 'numbers pass too');
  check(!E.validateCustom('', '9', '10').ok, 'blank rows fail');
  check(!E.validateCustom('9.5', '9', '10').ok, 'a fraction fails');
  check(!E.validateCustom('abc', '9', '10').ok, 'text fails');
  check(!E.validateCustom('4', '9', '10').ok, 'too few rows fail');
  check(!E.validateCustom('25', '9', '10').ok, 'too many rows fail');
  check(!E.validateCustom('9', '31', '10').ok, 'too many columns fail');
  check(!E.validateCustom('9', '9', '0').ok, 'zero mines fail');
  check(!E.validateCustom('9', '9', '73').ok, 'more mines than leave room for the first click fail');
  check(E.validateCustom('9', '9', '72').ok, 'the most mines that still leave room pass');
  check(E.validateCustom('9', '9', '73').field === 'mines', 'the error names the field');
  let allFirstClicksSafe = true;
  for (let seed = 1; seed <= 100; seed++) {
    const g = E.createGame(9, 9, 72, seed);
    E.reveal(g, seed % 81);
    if (g.status === 'lost') allFirstClicksSafe = false;
  }
  check(allFirstClicksSafe, 'the fullest allowed board is still safe on the first click');
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
