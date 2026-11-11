// ZimiGames Walls: the rules with no DOM, and self-played games showing the computer only plays legal moves.
//
// Run: node tests/test_games_walls.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const sb = {};
vm.createContext(sb);
['enginekit.js', 'walls-engine.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sb, { filename: f }));
const E = sb.ZimiWallsEngine(sb.ZimiSearch());

let failures = 0;
const check = (ok, label) => { if (ok) console.log('ok: ' + label); else { console.error('FAIL: ' + label); failures++; } };
const sq = (r, c) => r * 9 + c;
const sorted = a => a.slice().sort((x, y) => x - y);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The start: pawns at the middle of their edges, ten walls each, 4 pawn steps and 128 walls to lay.
{
  const p = E.newPosition();
  check(p.pawn[0] === sq(8, 4) && p.pawn[1] === sq(0, 4) && p.left[0] === 10 && p.left[1] === 10, 'walls: the start position');
  check(same(sorted(E.steps(p, 0)), sorted([sq(7, 4), sq(8, 3), sq(8, 5)])), 'walls: three steps from the edge');
  check(E.moves(p, true).filter(E.isWall).length === 128, 'walls: 128 walls can be laid at the start');
  check(E.distance(p, 0) === 8 && E.distance(p, 1) === 8, 'walls: eight steps to go');
  check(E.moves(p, false).every(m => E.isWall(m) ? E.wallLegal(p, m) : true), 'walls: the walls the computer weighs are all legal');
}

// Walls block steps, and may not cross or overlap.
{
  const p = E.newPosition();
  E.make(p, E.flat(7 * 8 + 3));            // between rows 7 and 8, columns 3 and 4
  check(!E.canStep(p, sq(8, 3), -1, 0) && !E.canStep(p, sq(8, 4), -1, 0), 'walls: a flat wall shuts both squares above it');
  check(E.canStep(p, sq(8, 5), -1, 0), 'walls: it is only two squares long');
  check(!E.wallFits(p, E.flat(7 * 8 + 3)) && !E.wallFits(p, E.flat(7 * 8 + 2)) && !E.wallFits(p, E.flat(7 * 8 + 4)), 'walls: flat walls may not overlap');
  check(!E.wallFits(p, E.upright(7 * 8 + 3)), 'walls: an upright wall may not cross a flat one');
  check(E.wallFits(p, E.upright(6 * 8 + 3)) && E.wallFits(p, E.flat(7 * 8 + 5)), 'walls: others still fit');
  E.unmake(p);
  check(E.canStep(p, sq(8, 4), -1, 0) && p.left[0] === 10 && p.turn === 0, 'walls: unmake takes the wall back');
}

// Jumps: straight over, and to the sides when something stands behind.
{
  const p = E.newPosition();
  p.pawn = [sq(4, 4), sq(3, 4)]; p.turn = 0;
  check(same(sorted(E.steps(p, 0)), sorted([sq(2, 4), sq(5, 4), sq(4, 3), sq(4, 5)])), 'walls: a pawn jumps straight over the other');
  E.make(p, E.flat(2 * 8 + 4)); E.unmake(p);
  const q = E.newPosition();
  q.pawn = [sq(4, 4), sq(3, 4)]; q.turn = 0;
  q.below[sq(2, 4)] = 1;                      // a wall behind the other pawn
  check(same(sorted(E.steps(q, 0)), sorted([sq(3, 3), sq(3, 5), sq(5, 4), sq(4, 3), sq(4, 5)])), 'walls: with a wall behind it the jump goes to either side');
  const edge = E.newPosition();
  edge.pawn = [sq(1, 4), sq(0, 4)]; edge.turn = 0;
  check(same(sorted(E.steps(edge, 0)), sorted([sq(0, 3), sq(0, 5), sq(2, 4), sq(1, 3), sq(1, 5)])), 'walls: with the edge behind it the jump goes to either side');
}

// A wall may never shut a pawn off from its goal.
{
  // four flat walls under the top row's columns 0..7 leave the way round through column 8
  const q = E.newPosition();
  [0, 2, 4, 6].forEach(c => { q.flats[c] = 1; q.below[c] = 1; q.below[c + 1] = 1; });
  q.turn = 0;
  check(E.distance(q, 1) > 0, 'walls: the pawn above four flat walls can still walk round');
  check(!E.wallLegal(q, E.upright(7)), 'walls: a wall that would shut a pawn in is refused');
  check(E.wallLegal(q, E.upright(3 * 8 + 7)), 'walls: a wall elsewhere is fine');
}

// A win: reach the far edge.
{
  const p = E.newPosition();
  p.pawn = [sq(1, 4), sq(7, 0)]; p.turn = 0;
  E.make(p, sq(0, 4));
  check(E.status(p).over && E.status(p).winner === 0, 'walls: reaching the far edge wins');
  E.unmake(p);
  check(!E.status(p).over, 'walls: and unmake takes it back');
  const r = E.newPosition();
  r.pawn = [sq(5, 4), sq(7, 2)]; r.turn = 1;
  E.make(r, sq(8, 2));
  check(E.status(r).over && E.status(r).winner === 1, 'walls: the second player wins at the bottom edge');
}

// The computer takes a win in one, and blocks a runner that is about to win when it can.
{
  const p = E.newPosition();
  p.pawn = [sq(5, 4), sq(7, 2)]; p.turn = 1;
  const r = E.think({ pawn: p.pawn, left: p.left, turn: 1, walls: [] }, { level: 'hard', ms: 500 });
  check(r.move === sq(8, 2), 'walls: the computer steps onto the goal when it can');
  const q = E.newPosition();
  q.pawn = [sq(1, 4), sq(2, 4)]; q.turn = 1;
  const b = E.think({ pawn: q.pawn, left: q.left, turn: 1, walls: [] }, { level: 'hard', ms: 1500 });
  check(E.isWall(b.move) || E.steps(q, 1).indexOf(b.move) >= 0, 'walls: it answers a runner one step from home with a legal move');
}

// Self-play: at every level, every move the computer picks is legal, and games end.
{
  let illegal = 0, moves = 0, wins = [0, 0], unfinished = 0;
  const levels = ['easy', 'medium', 'easy', 'medium'];
  for (let g = 0; g < 4; g++) {
    const p = E.newPosition();
    const lvl = [levels[g], levels[(g + 1) % 4]];
    let n = 0;
    while (!E.status(p).over && n < 160) {
      const all = E.moves(p, true);
      const req = { pawn: p.pawn.slice(), left: p.left.slice(), turn: p.turn, walls: E.walls(p), level: lvl[p.turn], ms: 150, depth: 2 };
      const r = E.handle(req);
      if (all.indexOf(r.move) < 0) { illegal++; break; }
      E.make(p, r.move); n++; moves++;
    }
    if (E.status(p).over) wins[E.status(p).winner]++; else unfinished++;
  }
  check(illegal === 0 && moves > 40, 'walls: the computer never plays an illegal move in ' + moves + ' moves');
  check(unfinished === 0, 'walls: every self-played game ends (' + wins.join(' to ') + ')');
}

// A harder computer beats an easy one more often than not.
{
  let strong = 0, games = 6;
  for (let g = 0; g < games; g++) {
    const p = E.newPosition(), side = g % 2;
    let n = 0;
    while (!E.status(p).over && n < 200) {
      const r = E.handle({ pawn: p.pawn.slice(), left: p.left.slice(), turn: p.turn, walls: E.walls(p), level: p.turn === side ? 'hard' : 'easy', ms: 600, seed: 11 * g + n + 1 });
      E.make(p, r.move); n++;
    }
    if (E.status(p).over && E.status(p).winner === side) strong++;
  }
  check(strong >= 4, 'walls: a hard computer beats an easy one (' + strong + ' of ' + games + ')');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('walls: all ok');
