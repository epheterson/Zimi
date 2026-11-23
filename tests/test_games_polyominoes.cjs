// ZimiGames Polyominoes: the rules with no DOM, and self-played games showing the computer only plays legal moves.
//
// Run: node tests/test_games_polyominoes.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const sb = {};
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(dir, 'polyominoes-engine.js'), 'utf8'), sb, { filename: 'polyominoes-engine.js' });
const E = sb.ZimiPolyominoesEngine({});

let failures = 0;
const check = (ok, label) => { if (ok) console.log('ok: ' + label); else { console.error('FAIL: ' + label); failures++; } };
const N = 14;
const sq = (r, c) => r * N + c;
const find = (list, piece, cells) => list.find(m => E.pieceOf(m) === piece && JSON.stringify(E.cellsOf(m).slice().sort((a, b) => a - b)) === JSON.stringify(cells.slice().sort((a, b) => a - b)));

// The pieces: 21 free shapes, 91 ways to lay them, 89 squares each.
{
  check(E.PIECES === 21 && E.SHAPES.length === 21, 'polyominoes: twenty-one pieces');
  check(E.SIZE.reduce((a, b) => a + b, 0) === 89 && E.TOTAL === 89, 'polyominoes: eighty-nine squares each');
  const counts = E.ORIENT.map(o => o.length);
  check(counts.join(',') === '1,2,2,4,2,8,4,1,4,8,2,8,8,8,4,4,4,4,1,8,4', 'polyominoes: each shape has its known number of ways to lie (' + counts.join(',') + ')');
  const sizes = [1, 1, 2, 5, 12];
  const bySize = [0, 0, 0, 0, 0, 0];
  E.SIZE.forEach(s => bySize[s]++);
  check(bySize.slice(1).join(',') === '1,1,2,5,12', 'polyominoes: one monomino, one domino, two trominoes, five tetrominoes, twelve pentominoes');
  // no two pieces are the same shape: every orientation of every piece is unique across pieces
  const all = new Set();
  let dup = false;
  E.ORIENT.forEach(os => os.forEach(o => { const k = JSON.stringify(o.cells); if (all.has(k)) dup = true; all.add(k); }));
  check(!dup, 'polyominoes: no shape is listed twice');
}

// The first move covers the player's starting square; the start squares are (5,5) and (10,10) of the 14 x 14 board.
{
  const p = E.newPosition();
  check(E.STARTS[0] === sq(4, 4) && E.STARTS[1] === sq(9, 9), 'polyominoes: the start squares');
  const list = E.moves(p);
  check(list.length > 100 && list.every(m => E.cellsOf(m).indexOf(sq(4, 4)) >= 0), 'polyominoes: every first move covers the starting square');
  check(find(list, 0, [sq(4, 4)]), 'polyominoes: the single square on the start is a first move');
  check(!find(list, 0, [sq(4, 5)]), 'polyominoes: and not beside it');
  check(E.problem(p, 0, [sq(0, 0)]) === 'start', 'polyominoes: elsewhere is refused: the start');
  check(E.problem(p, 0, [sq(-1, 0)]) === 'bounds' || E.problem(p, 0, [-1]) === 'bounds', 'polyominoes: off the board is refused');
}

// Later pieces touch your own at a corner and never along a side; the other player's may be touched anywhere.
{
  const p = E.newPosition();
  E.make(p, E.mk(0, 0, sq(4, 4)));                 // player 0: the single square on (4,4)
  E.make(p, E.mk(0, 0, sq(9, 9)));                 // player 1
  check(p.turn === 0 && E.squaresLeft(p, 0) === 88, 'polyominoes: a placed piece comes off the squares left');
  check(E.problem(p, 0, [sq(5, 5), sq(5, 6)]) === null, 'polyominoes: a piece may touch your own at a corner');
  check(E.problem(p, 0, [sq(4, 5), sq(4, 6)]) === 'edge', 'polyominoes: and not along a side');
  check(E.problem(p, 0, [sq(6, 6)]) === 'corner', 'polyominoes: and must touch one');
  check(E.problem(p, 0, [sq(4, 4)]) === 'overlap', 'polyominoes: it cannot overlap');
  // touching the other player's piece along a side is fine
  const q = E.newPosition();
  E.make(q, E.mk(0, 0, sq(4, 4))); E.make(q, E.mk(0, 0, sq(9, 9)));
  q.board[sq(5, 6)] = 2;
  check(E.problem(q, 0, [sq(5, 5), sq(6, 5)]) === null, 'polyominoes: touching the other player along a side is allowed');
  const list = E.moves(p);
  check(list.every(m => E.legal(p, m)) && list.length > 50, 'polyominoes: every generated move is legal (' + list.length + ')');
  // a brute force over every placement of every piece finds exactly the same moves
  let brute = 0;
  for (let piece = 1; piece < 21; piece++) for (let o = 0; o < E.ORIENT[piece].length; o++) for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const cells = E.placeCells(piece, o, r, c);
    if (cells && E.problem(p, 0, cells) === null) brute++;
  }
  check(brute === list.length, 'polyominoes: the generator finds every legal move a brute force does (' + brute + ')');
}

// Making and unmaking, passing, and the end.
{
  const p = E.newPosition();
  const before = E.key(p);
  const m = E.moves(p)[0];
  E.make(p, m);
  check(p.turn === 1 && (p.rem[0] >> E.pieceOf(m) & 1) === 0 && p.placed[0] === 1, 'polyominoes: making a move spends the piece and passes the turn');
  E.unmake(p);
  check(E.key(p) === before && p.rem[0] === (1 << 21) - 1, 'polyominoes: unmake restores the position');
  // two passes in a row end the game
  const q = E.newPosition();
  E.make(q, E.PASS); check(!E.status(q).over, 'polyominoes: one pass does not end it');
  E.make(q, E.PASS); check(E.status(q).over, 'polyominoes: two passes in a row do');
  check(E.status(q).winner === -1 && E.status(q).scores[0] === -89, 'polyominoes: an empty game is a draw at minus eighty-nine each');
  // scoring: placing every piece scores 15, and 5 more with the single square last
  const w = E.newPosition();
  w.rem[0] = 0; w.last[0] = 0; w.rem[1] = (1 << 21) - 1;
  check(E.scoreOf(w, 0) === 20, 'polyominoes: all pieces placed, the single square last: +20');
  w.last[0] = 5;
  check(E.scoreOf(w, 0) === 15, 'polyominoes: all pieces placed: +15');
}

// Self-play: at every level every move the computer picks is legal, and games end.
{
  let illegal = 0, moves = 0, ended = 0, games = 4, wins = [0, 0, 0];
  for (let g = 0; g < games; g++) {
    const p = E.newPosition();
    const lvl = [['easy', 'medium'], ['medium', 'hard'], ['hard', 'easy'], ['medium', 'medium']][g];
    let n = 0;
    while (!E.status(p).over && n < 120) {
      const r = E.handle({ board: Array.from(p.board), rem: p.rem.slice(), placed: p.placed.slice(), last: p.last.slice(), turn: p.turn, passes: p.passes, level: lvl[p.turn], seed: 3 + g * 17 + n });
      if (E.moves(p).indexOf(r.move) < 0) { illegal++; break; }
      E.make(p, r.move); n++; moves++;
    }
    const st = E.status(p);
    if (st.over) { ended++; wins[st.winner < 0 ? 2 : st.winner]++; }
  }
  check(illegal === 0 && moves > 80, 'polyominoes: the computer never plays an illegal move in ' + moves + ' moves');
  check(ended === games, 'polyominoes: every self-played game ends (' + wins.join(' / ') + ')');
}

// A harder computer beats an easy one.
{
  let strong = 0, games = 4;
  for (let g = 0; g < games; g++) {
    const p = E.newPosition(), side = g % 2;
    let n = 0;
    while (!E.status(p).over && n < 120) {
      const r = E.handle({ board: Array.from(p.board), rem: p.rem.slice(), placed: p.placed.slice(), last: p.last.slice(), turn: p.turn, passes: p.passes, level: p.turn === side ? 'hard' : 'easy', seed: 9 * g + n + 1 });
      E.make(p, r.move); n++;
    }
    const st = E.status(p);
    if (st.over && st.winner === side) strong++;
  }
  check(strong >= 3, 'polyominoes: a hard computer beats an easy one (' + strong + ' of ' + games + ')');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('polyominoes: all ok');
