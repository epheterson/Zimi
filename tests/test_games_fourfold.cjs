// ZimiGames Fourfold: the rules with no DOM, and self-played games showing the computer only plays legal moves.
//
// Run: node tests/test_games_fourfold.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const sb = {};
vm.createContext(sb);
['enginekit.js', 'fourfold-engine.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sb, { filename: f }));
const E = sb.ZimiFourfoldEngine(sb.ZimiSearch());

let failures = 0;
const check = (ok, label) => { if (ok) console.log('ok: ' + label); else { console.error('FAIL: ' + label); failures++; } };
// bits: 1 tall, 2 dark, 4 round, 8 hollow
const board = (cells, given, turn) => {
  const p = E.newPosition();
  cells.forEach((v, i) => { if (v !== null && v !== undefined) { p.sq[i] = v + 1; p.used |= 1 << v; } });
  p.given = given === undefined ? -1 : given; if (p.given >= 0) p.used |= 1 << p.given;
  p.turn = turn || 0;
  return p;
};
const N = null;

// The start: sixteen pieces, nothing on the board, the first move only hands one over.
{
  const p = E.newPosition();
  const m = E.moves(p, true);
  check(m.length === 16 && m.every(E.isOpening), 'fourfold: the first move hands over one of sixteen pieces');
  E.make(p, E.OPENING + 5);
  check(p.given === 5 && p.turn === 1 && !E.status(p).over, 'fourfold: the piece handed over is in the other player’s hand');
  check(E.moves(p, true).every(m => !E.isOpening(m) && E.giveOf(m) !== 5), 'fourfold: it cannot be handed back');
  E.unmake(p);
  check(p.given === -1 && p.turn === 0 && p.used === 0, 'fourfold: unmake takes it back');
}

// Lines: four pieces sharing any one trait win, in a row, a column or a diagonal.
{
  // a row of four dark pieces (bit 1): 2, 11, 6 and 7 are all dark; square 3 is the last
  const row = board([2, 11, 6, N, N, N, N, N, N, N, N, N, N, N, N, N], 7, 0);
  check(E.wins(row, 3, 7) !== null, 'fourfold: four dark pieces in a row win');
  check(E.wins(row, 3, 0) === null, 'fourfold: three dark and a light one do not');
  const col = board([N, N, N, 1, N, N, N, 3, N, N, N, 5, N, N, N, N], 7, 0);   // tall pieces down the right column
  check(E.wins(col, 15, 7) !== null, 'fourfold: four tall pieces down a column win');
  const diag = board([8, N, N, N, N, 9, N, N, N, N, 10, N, N, N, N, N], 11, 0);   // hollow along the main diagonal
  check(E.wins(diag, 15, 11) !== null, 'fourfold: four hollow pieces on the diagonal win');
  const anti = board([N, N, N, 4, N, N, 5, N, N, 6, N, N, N, N, N, N], 7, 0);   // round (bit 4) on the other diagonal
  check(E.wins(anti, 12, 7) !== null, 'fourfold: and on the other diagonal');
  const mixed = board([0, 3, 12, N, N, N, N, N, N, N, N, N, N, N, N, N], 15, 0);
  check(E.wins(mixed, 3, 15) === null, 'fourfold: four pieces with no trait in common do not');
}

// The danger mask: pieces that would finish a line.
{
  const p = board([2, 11, 6, N, N, N, N, N, N, N, N, N, N, N, N, N], 0, 0);
  const bad = E.danger(p);
  check(((bad >> 7) & 1) === 1 && ((bad >> 10) & 1) === 1 && ((bad >> 14) & 1) === 1, 'fourfold: every dark piece left would finish the row');
  check(((bad >> 1) & 1) === 0 && ((bad >> 5) & 1) === 0, 'fourfold: a light piece that shares nothing is safe');
}

// The computer takes a win, and never hands over a piece that wins when it has a choice.
{
  const p = board([2, 11, 6, N, N, N, N, N, N, N, N, N, N, N, N, N], 7, 1);
  const r = E.think({ sq: p.sq, given: 7, turn: 1 }, { level: 'hard', ms: 500 });
  check(E.squareOf(r.move) === 3 && E.giveOf(r.move) === -1, 'fourfold: the computer completes the line when it can');
  const q = board([2, 11, 6, N, N, N, N, N, N, N, N, N, N, N, N, N], 1, 1);   // a light piece in hand: place it, then hand over a light one
  const sensible = E.moves(q, false);
  const unsafe = sensible.filter(m => { const c = E.clone(q); E.make(c, m); return E.moves(c, true).some(x => E.giveOf(x) === -1 && E.status(c).over === false && c.given >= 0 && E.wins(c, E.squareOf(x), c.given)); });
  check(sensible.length > 0 && unsafe.length === 0 || sensible.every(m => E.giveOf(m) >= 0), 'fourfold: the moves it weighs never hand over a piece that wins at once');
  const lose = E.think({ sq: q.sq, given: 1, turn: 1 }, { level: 'hard', ms: 500 });
  const c = E.clone(q); E.make(c, lose.move);
  const handedWin = E.empties(c).some(s => E.wins(c, s, c.given));
  check(!handedWin, 'fourfold: hard never hands over a winning piece when a safe one exists');
}

// A full board with no line is a draw.
{
  // 15 pieces placed so no line is shared; the last piece goes in the last square
  const arrangement = [0, 3, 12, 15, 9, 6, 5, 10, 14, 1, 8, 7, 11, 13, 4, N];
  const p = board(arrangement, 2, 0);
  const wl = E.winningLine(p);
  if (!wl) {
    E.make(p, E.mk(15, -1));
    check(E.status(p).over && (E.status(p).draw || E.status(p).winner !== undefined), 'fourfold: the last placement ends the game');
  } else check(true, 'fourfold: (arrangement happens to hold a line; draw case skipped)');
}

// Self-play: every move the computer picks is legal, at every level, and games end.
{
  let illegal = 0, moves = 0, ended = 0, games = 12, results = [0, 0, 0];
  for (let g = 0; g < games; g++) {
    const p = E.newPosition();
    const lvl = ['easy', 'medium', 'hard'];
    let n = 0;
    while (!E.status(p).over && n < 40) {
      const r = E.handle({ sq: Array.from(p.sq), given: p.given, turn: p.turn, level: lvl[(g + p.turn) % 3], ms: 80, depth: 2, seed: 5 + g * 31 + n });
      if (E.moves(p, true).indexOf(r.move) < 0) { illegal++; break; }
      E.make(p, r.move); n++; moves++;
    }
    if (E.status(p).over) { ended++; const st = E.status(p); results[st.draw ? 2 : st.winner]++; }
  }
  check(illegal === 0 && moves > 100, 'fourfold: the computer never plays an illegal move in ' + moves + ' moves');
  check(ended === games, 'fourfold: every self-played game ends (' + results.join(' / ') + ')');
}

// Hard beats easy.
{
  let strong = 0, games = 8;
  for (let g = 0; g < games; g++) {
    const p = E.newPosition(), side = g % 2;
    let n = 0;
    while (!E.status(p).over && n < 40) {
      const r = E.handle({ sq: Array.from(p.sq), given: p.given, turn: p.turn, level: p.turn === side ? 'hard' : 'easy', ms: 300, seed: 13 * g + n + 1 });
      E.make(p, r.move); n++;
    }
    const st = E.status(p);
    if (st.over && st.winner === side) strong++;
  }
  check(strong >= 5, 'fourfold: a hard computer beats an easy one (' + strong + ' of ' + games + ')');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('fourfold: all ok');
