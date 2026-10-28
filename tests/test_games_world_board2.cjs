// ZimiGames world board games, part two: Xiangqi, Shogi (and Minishogi), Chinese Checkers, Ludo, Dominoes.
// The rules with no DOM: perft counts, the special moves each game is known for, scoring, and a few
// self-played games to show the computer only ever makes legal moves.
//
// Run: node tests/test_games_world_board2.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
function load(file) {
  const sandbox = {};
  vm.createContext(sandbox);
  for (const f of ['enginekit.js', file]) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  return sandbox;
}
const seeded = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

// ── Xiangqi ──
{
  const X = load('xiangqi-engine.js'), E = X.ZimiXiangqiEngine(X.ZimiSearch());
  const at = (r, f) => r * 9 + f;
  const movesOf = (pos, r, f) => E.legalMoves(pos).filter(m => E.from(m) === at(r, f)).map(m => E.to(m));
  const sorted = list => list.slice().sort((a, b) => a - b);

  const start = E.startPosition();
  check(E.perft(start, 1) === 44, 'xiangqi: perft 1 from the start is 44');
  check(E.perft(start, 2) === 1920, 'xiangqi: perft 2 from the start is 1920');
  check(E.perft(start, 3) === 79666, 'xiangqi: perft 3 from the start is 79666');
  check(E.toFen(start).startsWith('rheakaehr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RHEAKAEHR w'), 'xiangqi: the start position round-trips through its FEN');

  // The flying general: a general may not step onto a file where it would face the other general.
  let pos = E.parseFen('3k5/9/9/9/9/9/9/9/9/4K4 w');
  check(JSON.stringify(sorted(movesOf(pos, 9, 4))) === JSON.stringify(sorted([at(8, 4), at(9, 5)])), 'xiangqi: a general cannot step to face the other down an open file');
  // A rook between the generals is pinned to the file.
  pos = E.parseFen('4k4/9/9/9/4R4/9/9/9/9/4K4 w');
  check(movesOf(pos, 4, 4).length > 0 && movesOf(pos, 4, 4).every(t => E.colOf(t) === 4), 'xiangqi: a piece shielding the generals cannot leave the file');
  check(!E.inCheck(pos, E.RED), 'xiangqi: a screened file gives no check');
  pos = E.parseFen('4k4/9/9/9/9/9/9/9/9/4K4 w');
  check(E.attacked(pos, at(9, 4), E.BLACK), 'xiangqi: facing generals attack each other');

  // Cannons jump exactly one screen to capture, and never move after jumping.
  pos = E.parseFen('3k5/9/9/9/9/9/9/1C2p2c1/9/4K4 w');
  const rowTargets = movesOf(pos, 7, 1).filter(t => E.rowOf(t) === 7);
  check(JSON.stringify(sorted(rowTargets)) === JSON.stringify(sorted([at(7, 0), at(7, 2), at(7, 3), at(7, 7)])), 'xiangqi: a cannon moves to empty points, and jumps one screen to capture');
  pos = E.parseFen('3k5/9/9/9/9/9/9/1C2p2c1/9/4K4 w');
  check(!movesOf(pos, 7, 1).includes(at(7, 4)), 'xiangqi: a cannon cannot capture the screen itself');

  // Horses are blocked on their leg, elephants on their eye and by the river.
  pos = E.parseFen('3k5/9/9/9/9/9/9/9/1P7/1H2K4 w');
  check(JSON.stringify(movesOf(pos, 9, 1)) === JSON.stringify([at(8, 3)]), 'xiangqi: a horse with a piece on its leg cannot jump that way');
  pos = E.parseFen('3k5/9/9/9/9/2E6/3p5/9/9/4K4 w');
  check(JSON.stringify(movesOf(pos, 5, 2)) === JSON.stringify([at(7, 0)]), 'xiangqi: an elephant is blocked on its eye and cannot cross the river');

  // Soldiers: forward only before the river, forward and sideways after it.
  pos = E.parseFen('3k5/9/9/9/4P4/9/9/9/9/4K4 w');
  check(movesOf(pos, 4, 4).length === 3, 'xiangqi: a soldier over the river moves forward and sideways');
  pos = E.parseFen('3k5/9/9/9/9/4P4/9/9/9/4K4 w');
  check(JSON.stringify(movesOf(pos, 5, 4)) === JSON.stringify([at(4, 4)]), 'xiangqi: a soldier on its own side moves forward only');

  // Having no legal move loses.
  pos = E.parseFen('3k4R/8R/9/9/9/9/9/9/9/5K3 b');
  const st = E.status(pos, [E.key(pos)]);
  check(st.over && st.result === 'mate' && st.winner === E.RED && st.check, 'xiangqi: checkmate ends the game for the side with no move');
  const k = E.key(start);
  check(E.status(start, [k, k, k]).result === 'repetition', 'xiangqi: the third occurrence of a position is a draw');

  // The computer only plays legal moves and finishes a short game of its own.
  pos = E.startPosition();
  let ok = true, plies = 0;
  for (; plies < 40; plies++) {
    const r = E.think(pos, { level: plies % 2 ? 'beginner' : 'casual', ms: 60, depth: 2 });
    if (!r.move) break;
    if (!E.legalMoves(pos).includes(r.move)) { ok = false; break; }
    E.make(pos, r.move);
  }
  check(ok && plies > 20, 'xiangqi: the computer plays legal moves for ' + plies + ' plies');
}

// ── Shogi ──
{
  const S = load('shogi-engine.js');
  const E = S.ZimiShogiEngine(S.ZimiSearch(), 'full'), M = S.ZimiShogiEngine(S.ZimiSearch(), 'mini');
  const dropsOf = (pos, t) => E.legalMoves(pos).filter(m => E.isDrop(m) && E.from(m) === t).map(m => E.to(m));
  const start = E.startPosition();
  check(E.perft(start, 1) === 30, 'shogi: perft 1 from the start is 30');
  check(E.perft(start, 2) === 900, 'shogi: perft 2 from the start is 900');
  check(E.perft(start, 3) === 25470, 'shogi: perft 3 from the start is 25470');
  const mini = M.startPosition();
  check(M.perft(mini, 1) === 14 && M.perft(mini, 2) === 181 && M.perft(mini, 3) === 2512, 'minishogi: perft 1, 2, 3 from the start are 14, 181, 2512');
  check(E.toSfen(start) === 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b -', 'shogi: the start position round-trips through its SFEN');

  // No pawn on a file that already holds one of your unpromoted pawns, none on the last rank.
  let pos = E.parseSfen('4k4/9/9/9/9/9/4P4/9/4K4 b P');
  let drops = dropsOf(pos, E.P);
  let expected = 0;
  for (let s = 0; s < 81; s++) if (!pos.sq[s] && E.colOf(s) !== 4 && E.rowOf(s) > 0) expected++;
  check(drops.length === expected && drops.every(s => E.colOf(s) !== 4 && E.rowOf(s) > 0), 'shogi: nifu, and no pawn drop on the last rank (' + drops.length + ' drops)');
  // A promoted pawn does not count against the drop.
  pos = E.parseSfen('4k4/9/9/9/9/9/4+P4/9/4K4 b P');
  check(dropsOf(pos, E.P).some(s => E.colOf(s) === 4), 'shogi: a promoted pawn on the file does not block a pawn drop');
  // Lances and knights are never dropped where they could not move.
  pos = E.parseSfen('4k4/9/9/9/9/9/9/9/4K4 b LN');
  check(dropsOf(pos, E.L).every(s => E.rowOf(s) > 0) && dropsOf(pos, E.N).every(s => E.rowOf(s) > 1), 'shogi: no lance on the last rank, no knight on the last two');
  check(dropsOf(pos, E.L).length === 71 && dropsOf(pos, E.N).length === 62, 'shogi: 71 lance drops and 62 knight drops on a board with two kings');

  // A pawn drop may give check, but not checkmate.
  pos = E.parseSfen('kn7/1n7/9/9/9/L8/9/9/8K b P');
  const corner = E.squareFromName('9b');
  check(!dropsOf(pos, E.P).includes(corner), 'shogi: uchifuzume, a pawn drop that mates is illegal');
  check(dropsOf(pos, E.P).includes(E.squareFromName('5e')), 'shogi: other pawn drops are still legal');
  pos = E.parseSfen('kn7/1n7/9/9/9/9/9/9/8K b P');
  check(dropsOf(pos, E.P).includes(corner), 'shogi: a pawn drop that gives check the king can answer is legal');
  pos = E.parseSfen('kn7/Pn7/9/9/9/L8/9/9/8K w');
  const mate = E.status(pos, [E.key(pos)]);
  check(mate.over && mate.result === 'mate' && mate.winner === E.SENTE, 'shogi: checkmate is found');

  // Promotion: optional in the zone, forced where a piece could never move again.
  pos = E.parseSfen('4k4/3P5/9/9/9/9/9/9/4K4 b');
  let ms = E.legalMoves(pos).filter(m => !E.isDrop(m) && E.from(m) === E.squareFromName('6b'));
  check(ms.length === 1 && E.isPromo(ms[0]), 'shogi: a pawn reaching the last rank must promote');
  pos = E.parseSfen('4k4/9/2N6/9/9/9/9/9/4K4 b');
  ms = E.legalMoves(pos).filter(m => !E.isDrop(m) && E.from(m) === E.squareFromName('7c'));
  check(ms.length === 2 && ms.every(m => E.isPromo(m)), 'shogi: a knight reaching the last two ranks must promote');
  pos = E.parseSfen('4k4/9/9/4S4/9/9/9/9/4K4 b');
  ms = E.legalMoves(pos).filter(m => E.to(m) === E.squareFromName('5c') && E.from(m) === E.squareFromName('5d'));
  check(ms.length === 2 && ms.some(E.isPromo) && ms.some(m => !E.isPromo(m)), 'shogi: a silver entering the zone may promote or not');
  pos = E.parseSfen('4k4/R8/9/9/9/9/9/9/4K4 b');
  ms = E.legalMoves(pos).filter(m => E.from(m) === E.squareFromName('9b') && E.to(m) === E.squareFromName('9f'));
  check(ms.length === 2, 'shogi: leaving the zone also allows promotion');
  pos = E.parseSfen('4k4/9/9/9/9/9/9/+r8/RK7 b');
  const take = E.legalMoves(pos).find(m => E.to(m) === E.squareFromName('9h') && E.from(m) === E.squareFromName('9i'));
  E.make(pos, take);
  check(pos.hand[0][E.R] === 1, 'shogi: a captured dragon goes to the hand as a plain rook');
  E.unmake(pos);
  check(pos.hand[0][E.R] === 0 && pos.sq[E.squareFromName('9h')] === -(E.R + E.PROMOTED), 'shogi: unmaking a capture restores the board and the hand');
  const keys = Array(4).fill(E.key(start));
  check(E.status(start, keys).result === 'repetition', 'shogi: the fourth occurrence of a position is a draw');

  // Self-play: the computer's moves are legal, drops and promotions included.
  for (const [eng, label] of [[E, 'shogi'], [M, 'minishogi']]) {
    let p = eng.startPosition(), ok = true, n = 0, drops = 0;
    for (; n < 60; n++) {
      const r = eng.think(p, { level: n % 2 ? 'beginner' : 'casual', ms: 80, depth: 2 });
      if (!r.move) { ok = eng.status(p, [eng.key(p)]).over; break; }   // no move is only right when the game is over
      if (!eng.legalMoves(p).includes(r.move)) { ok = false; break; }
      if (eng.isDrop(r.move)) drops++;
      eng.make(p, r.move);
    }
    // The two weak levels may mate each other early on the small board: what is fixed is that every move was legal
    // and the game either ran on or ended by the rules, never that it lasted ten plies.
    check(ok, label + ': the computer plays legal moves for ' + n + ' plies (' + drops + ' drops)');
  }
}

// ── Chinese Checkers ──
{
  const C = load('chinesecheckers.js').ChineseCheckersEngine;
  check(C.CELLS.length === 121, 'chinese checkers: the star has 121 holes');
  check(C.CAMPS.every(list => list.length === 10), 'chinese checkers: six camps of ten holes');
  check(C.CELLS.filter(c => c.camp < 0).length === 61, 'chinese checkers: 61 holes in the middle hexagon');
  const top = C.CAMPS[0].map(i => C.CELLS[i].y), bottom = C.CAMPS[3].map(i => C.CELLS[i].y);
  check(Math.max(...top) < 0 && Math.min(...bottom) > 0, 'chinese checkers: camp 0 is at the top and camp 3 at the bottom');
  check(C.APEX.every((a, camp) => C.CELLS[a].camp === camp), 'chinese checkers: every apex lies in its own camp');
  const s2 = C.newState(2);
  check(C.marblesOf(s2, 0).length === 10 && C.marblesOf(s2, 1).length === 10 && C.goalOf(s2, 0) === 3 && C.goalOf(s2, 1) === 0, 'chinese checkers: two players start in opposite camps, each heading for the other');
  check(JSON.stringify(Object.keys(C.SEATINGS).map(Number)) === '[2,3,4,6]' && C.SEATINGS[4].every(c => C.SEATINGS[4].includes(C.opposite(c))), 'chinese checkers: four players sit in opposite pairs');

  const empty = () => { const st = C.newState(2); st.owner.fill(0); return st; };
  const ix = (q, r) => C.indexOf(q, r);
  let st = empty();
  st.owner[ix(0, 0)] = 1; st.owner[ix(1, 0)] = 2; st.owner[ix(3, 0)] = 2;
  let moves = C.movesFrom(st, ix(0, 0));
  check(Object.keys(moves).length === 7, 'chinese checkers: five steps and a chain of two jumps (7 holes)');
  check(moves[ix(4, 0)] && moves[ix(4, 0)].length === 3 && moves[ix(4, 0)][1] === ix(2, 0), 'chinese checkers: the chain jumps (0,0) to (2,0) to (4,0)');
  st = empty();
  st.owner[ix(0, 0)] = 1; st.owner[ix(1, 0)] = 2; st.owner[ix(2, 0)] = 2;
  moves = C.movesFrom(st, ix(0, 0));
  check(Object.keys(moves).length === 5 && !moves[ix(2, 0)], 'chinese checkers: no jump over two marbles in a row, and none onto a taken hole');
  st = empty();
  st.owner[ix(0, 0)] = 1;
  check(Object.keys(C.movesFrom(st, ix(0, 0))).length === 6, 'chinese checkers: a lone marble has six steps');
  st = empty();
  st.owner[ix(0, 0)] = 1; st.owner[ix(1, 0)] = 1; st.owner[ix(2, 1)] = 2; st.owner[ix(0, 2)] = 2; st.owner[ix(-2, 2)] = 2;
  moves = C.movesFrom(st, ix(0, 0));
  check(Object.keys(moves).every(t => +t !== ix(1, 0)), 'chinese checkers: a marble never lands on a taken hole');

  // Winning: all ten marbles in the goal camp.
  st = C.newState(2);
  C.marblesOf(st, 0).forEach(i => st.owner[i] = 0);
  C.CAMPS[3].forEach(i => st.owner[i] = 1);
  check(C.hasWon(st, 0) && !C.hasWon(st, 1), 'chinese checkers: ten marbles in the opposite camp win');
  const first = C.newState(2), a = C.chooseMove(first, 0, 'medium', seeded(7)), all = C.allMoves(first, 0);
  check(a && all.some(m => m.from === a.from && m.to === a.to), 'chinese checkers: the computer chooses a legal move');
  // Self-play: every level finishes a two-player game, and the harder level is not worse than the easiest.
  function game(levels, seed) {
    const rng = seeded(seed), g = C.newState(levels.length);
    for (let t = 0; t < levels.length * C.MAX_ROUNDS; t++) {
      const seat = g.turn, mv = C.chooseMove(g, seat, levels[seat], rng);
      if (mv) {
        if (!C.movesFrom(g, mv.from)[mv.to]) return { bad: true };
        C.applyMove(g, seat, mv.from, mv.to);
        if (C.hasWon(g, seat)) return { winner: seat };
      }
      g.turn = (g.turn + 1) % levels.length;
    }
    return { winner: -1 };
  }
  let legalOnly = true, hardWins = 0;
  for (let i = 0; i < 4; i++) {
    const x = game(['hard', 'easy'], 11 + i), y = game(['easy', 'hard'], 21 + i);
    if (x.bad || y.bad) legalOnly = false;
    if (x.winner === 0) hardWins++;
    if (y.winner === 1) hardWins++;
  }
  check(legalOnly && hardWins >= 6, 'chinese checkers: hard beats easy ' + hardWins + ' of 8 games, with legal moves only');
  const six = game(['medium', 'medium', 'medium', 'medium', 'medium', 'medium'], 5);
  check(!six.bad && six.winner >= 0, 'chinese checkers: a six-player game of computers finishes');
}

// ── Ludo ──
{
  const L = load('ludo.js').LudoEngine;
  const key = rc => rc.join(',');
  check(L.RING.length === 52 && new Set(L.RING.map(key)).size === 52, 'ludo: a ring of 52 distinct squares');
  check(key(L.RING[0]) === '6,1' && key(L.RING[13]) === '1,8' && key(L.RING[26]) === '8,13' && key(L.RING[39]) === '13,6', 'ludo: the four entry squares sit in the four arms');
  const touches = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) === 1;   // corners of the cross meet diagonally
  check(L.RING.every((rc, i) => i === 0 || touches(rc, L.RING[i - 1])) && touches(L.RING[51], L.RING[0]), 'ludo: every square touches the next, and the ring closes');
  check([0, 13, 26, 39, 8, 21, 34, 47].every(a => L.isSafeSquare(a)) && [1, 5, 14, 20].every(a => !L.isSafeSquare(a)), 'ludo: the starts and the stars are safe, other squares are not');
  check(L.ringIndex(1, 0) === 13 && L.ringIndex(3, 50) === 37, 'ludo: each colour counts from its own entry square');

  let st = L.newState(4);
  check(L.legalMoves(st, 0, 5).length === 0 && L.legalMoves(st, 0, 6).length === 4 && L.legalMoves(st, 0, 6).every(m => m.exits && m.to === 0), 'ludo: only a six brings a token out of the yard');
  st.tokens[0][0] = 3;
  check(L.legalMoves(st, 0, 4).length === 1 && L.legalMoves(st, 0, 4)[0].to === 7, 'ludo: a token on the board moves by the roll');

  // Captures: a lone rival on an ordinary square goes home; a safe square protects.
  st = L.newState(4);
  st.tokens[0][0] = 3; st.tokens[1][0] = (5 - 13 + 52) % 52;      // Green stands on ring square 5
  let mv = L.legalMoves(st, 0, 2)[0];
  check(mv.to === 5 && mv.captures.length === 1 && mv.captures[0].seat === 1, 'ludo: landing on a lone rival captures it');
  L.applyMove(st, 0, mv);
  check(st.tokens[1][0] === -1 && st.tokens[0][0] === 5, 'ludo: the captured token returns to its yard');
  st = L.newState(4);
  st.tokens[0][0] = 5; st.tokens[1][0] = (8 - 13 + 52) % 52;       // Green stands on the star at square 8
  check(L.legalMoves(st, 0, 3)[0].captures.length === 0, 'ludo: a star square is safe');
  st = L.newState(4);
  st.tokens[0][0] = 10; st.tokens[1][0] = (13 - 13 + 52) % 52;     // Green on its own entry square
  check(L.legalMoves(st, 0, 3)[0].captures.length === 0, 'ludo: an entry square is safe');
  st = L.newState(4);
  st.tokens[0][0] = 3; st.tokens[1][0] = 44; st.tokens[1][1] = 44; // two Green tokens on square 5
  check(L.legalMoves(st, 0, 2)[0].captures.length === 0, 'ludo: two tokens of one colour on a square cannot be captured');
  st = L.newState(4);
  st.tokens[0][0] = 50; st.tokens[1][0] = 8;
  check(L.legalMoves(st, 0, 3)[0].captures.length === 0, 'ludo: a token in its home column cannot be captured');

  // Home: an exact roll is needed.
  st = L.newState(2);
  st.tokens[0][0] = 53;
  check(L.legalMoves(st, 0, 3).length === 1 && L.legalMoves(st, 0, 4).length === 0, 'ludo: the last step needs an exact roll');
  st.tokens[0][0] = 56;
  check(L.legalMoves(st, 0, 1).length === 0, 'ludo: a token that is home stays home');
  st.tokens[0] = [56, 56, 56, 55];
  L.applyMove(st, 0, L.legalMoves(st, 0, 1)[0]);
  check(st.winner === 0 && L.homeCount(st, 0) === 4, 'ludo: four tokens home wins');
  st = L.newState(4);
  st.tokens[0][0] = 20; st.tokens[1][0] = (17 - 13 + 52) % 52;
  check(L.threatened(st, 0, 20) && !L.threatened(st, 0, 8) && !L.threatened(st, 0, 30), 'ludo: a token within six squares ahead of a rival is threatened');
  const roll = L.rollDie(seeded(3));
  check(roll >= 1 && roll <= 6, 'ludo: the die gives 1 to 6');

  // The computer takes a capture when it has one, and plays only legal moves for a whole game.
  st = L.newState(4);
  st.tokens[0][0] = 3; st.tokens[0][1] = 20; st.tokens[1][0] = (5 - 13 + 52) % 52;
  const pick = L.chooseMove(st, 0, 2, 'hard', seeded(5));
  check(pick.captures.length === 1, 'ludo: the hard computer takes the capture');
  function game(count, levels, seed) {
    const rng = seeded(seed), g = L.newState(count);
    let sixes = 0;
    for (let t = 0; t < 20000; t++) {
      const seat = g.turn, die = L.rollDie(rng);
      sixes = die === 6 ? sixes + 1 : 0;
      const legal = L.legalMoves(g, seat, die);
      if (sixes < 3 && legal.length) {
        const mv = L.chooseMove(g, seat, die, levels[seat], rng);
        if (!legal.some(m => m.token === mv.token && m.to === mv.to)) return { bad: true };
        L.applyMove(g, seat, mv);
        if (g.winner >= 0) return { winner: g.winner };
      }
      if (die !== 6 || sixes >= 3 || !legal.length) { g.turn = (g.turn + 1) % count; sixes = 0; }
    }
    return { winner: -1 };
  }
  let fine = true, finished = 0;
  [[2, 'easy', 'medium'], [3, 'medium', 'hard'], [4, 'hard', 'easy']].forEach(([count, a, b], i) => {
    const r = game(count, Array.from({ length: count }, (_, s) => (s % 2 ? b : a)), 40 + i);
    if (r.bad) fine = false;
    if (r.winner >= 0) finished++;
  });
  check(fine && finished === 3, 'ludo: games of 2, 3 and 4 computers finish with legal moves only');
}

// ── Dominoes ──
{
  const D = load('dominoes.js').DominoEngine;
  const tiles = D.allTiles();
  check(tiles.length === 28 && new Set(tiles.map(t => t.join(','))).size === 28, 'dominoes: a double-six set is 28 distinct tiles');
  check(D.handPips([[6, 6], [0, 1]]) === 13 && D.isDouble([3, 3]) && !D.isDouble([3, 4]), 'dominoes: pips and doubles');
  let st = D.deal('draw', 2, seeded(1));
  check(st.hands.length === 2 && st.hands.every(h => h.length === 7) && st.boneyard.length === 14, 'dominoes: draw game, two players take seven each and 14 stay in the boneyard');
  st = D.deal('draw', 4, seeded(1));
  check(st.hands.every(h => h.length === 5) && st.boneyard.length === 8, 'dominoes: draw game, four players take five each');
  st = D.deal('block', 4, seeded(1));
  check(st.hands.every(h => h.length === 7) && st.boneyard.length === 0, 'dominoes: block game, four players take seven each and nothing is left over');
  const all = [].concat(...st.hands).map(t => t.join(','));
  check(new Set(all).size === 28, 'dominoes: a deal uses every tile once');

  // Legal plays and the shape of the chain.
  st = { mode: 'block', hands: [[[6, 6], [2, 3], [4, 5]], [[1, 1]]], boneyard: [], chain: [], ends: null, turn: 0, passes: 0, lacks: [{}, {}], last: null };
  check(D.legalPlays(st, 0).length === 3 && D.legalPlays(st, 0).every(p => p.end === 'C'), 'dominoes: any tile may open an empty table');
  check(D.bestLead([[2, 3], [6, 6], [4, 5]]) === 1 && D.bestLead([[2, 3], [1, 1], [4, 5]]) === 1 && D.bestLead([[0, 1], [3, 4]]) === 1, 'dominoes: lead with the biggest double, else the heaviest tile');
  D.play(st, 0, { tile: 0, end: 'C' });
  check(JSON.stringify(st.ends) === '[6,6]' && st.chain.length === 1, 'dominoes: the first tile sets both ends');
  st.hands[1] = [[6, 2], [1, 1], [5, 6]];
  let plays = D.legalPlays(st, 1);
  check(plays.length === 4 && plays.filter(p => p.tile === 0).length === 2, 'dominoes: a tile that fits both ends offers both');
  D.play(st, 1, { tile: 0, end: 'R' });
  check(JSON.stringify(st.ends) === '[6,2]' && st.chain[1].a === 6 && st.chain[1].b === 2, 'dominoes: a tile joins on its matching pips and shows the other pips at the end');
  D.play(st, 1, { tile: 1, end: 'L' });
  check(st.chain[0].a === 5 && st.chain[0].b === 6 && st.ends[0] === 5 && st.passes === 0, 'dominoes: playing on the left turns the tile to match');
  check(st.chain.every((c, i) => i === 0 || st.chain[i - 1].b === c.a), 'dominoes: neighbouring tiles always match');
  check(D.legalPlays(st, 0).length === 0 || D.legalPlays(st, 0).every(p => p.end !== 'C'), 'dominoes: after the opening no tile plays as an opener');

  // Drawing and passing.
  st = D.deal('draw', 2, seeded(2));
  const before = st.hands[0].length, yard = st.boneyard.length;
  const got = D.draw(st, 0);
  check(got && st.hands[0].length === before + 1 && st.boneyard.length === yard - 1, 'dominoes: drawing moves a tile from the boneyard to the hand');
  check(D.draw(D.deal('block', 2, seeded(2)), 0) === null && D.canDraw(D.deal('block', 2, seeded(2))) === false, 'dominoes: nobody draws in a block game');
  st = D.deal('block', 3, seeded(2)); st.chain = [{ a: 2, b: 5 }]; st.ends = [2, 5];
  D.pass(st, 0); D.pass(st, 1);
  check(!D.isBlocked(st) && st.lacks[0][2] && st.lacks[1][5], 'dominoes: a pass notes which numbers that player lacks');
  D.pass(st, 2);
  check(D.isBlocked(st), 'dominoes: when everyone passes in turn the game is blocked');

  // Scoring.
  st = { mode: 'draw', hands: [[], [[6, 6], [2, 1]], [[0, 3]]], boneyard: [], chain: [], ends: [1, 1], turn: 0, passes: 0, lacks: [{}, {}, {}], last: null };
  let r = D.scoreRound(st);
  check(r.winner === 0 && r.points === 18 && r.how === 'out', 'dominoes: going out scores the pips in all the other hands');
  st.hands = [[[6, 6]], [[2, 1], [0, 3]], [[5, 5]]];
  r = D.scoreRound(st);
  check(r.winner === 1 && r.how === 'blocked' && r.points === (12 + 6 + 10) - 2 * 6, 'dominoes: a blocked game goes to the lowest hand, which scores the difference');
  st.hands = [[[2, 4]], [[1, 5]], [[6, 6]]];
  check(D.scoreRound(st).winner === -1, 'dominoes: a tie for the lowest hand scores nothing');
  st = D.deal('draw', 2, seeded(9));
  st.hands[1] = [[6, 6], [1, 2]]; st.hands[0] = [[3, 3], [0, 1]];
  check(D.firstPlayer(st) === 1, 'dominoes: the holder of the highest double leads the first round');

  // Whole rounds played by the computers: legal plays only, every tile accounted for, and a result at the end.
  function round(mode, count, level, seed) {
    const rng = seeded(seed), g = D.deal(mode, count, rng);
    g.turn = D.firstPlayer(g);
    D.play(g, g.turn, { tile: D.bestLead(g.hands[g.turn]), end: 'C' });
    for (let t = 0; t < 400; t++) {
      if (!g.hands[g.turn].length) break;
      g.turn = (g.turn + 1) % count;
      const p = g.turn;
      let plays = D.legalPlays(g, p);
      while (!plays.length && D.canDraw(g)) { D.draw(g, p); plays = D.legalPlays(g, p); }
      if (plays.length) {
        const pl = D.choosePlay(g, p, level, rng);
        if (!plays.some(x => x.tile === pl.tile && x.end === pl.end)) return { bad: true };
        D.play(g, p, pl);
        if (!g.hands[p].length) break;
      } else {
        D.pass(g, p);
        if (D.isBlocked(g)) break;
      }
    }
    const total = g.chain.length + g.boneyard.length + g.hands.reduce((n, h) => n + h.length, 0);
    const linked = g.chain.every((c, i) => i === 0 || g.chain[i - 1].b === c.a);
    return { total: total, linked: linked, score: D.scoreRound(g) };
  }
  let sound = true, results = 0;
  ['draw', 'block'].forEach(mode => [2, 3, 4].forEach(count => ['easy', 'medium', 'hard'].forEach((level, k) => {
    const x = round(mode, count, level, 100 + count * 7 + k);
    if (x.bad || x.total !== 28 || !x.linked) sound = false; else results++;
  })));
  check(sound && results === 18, 'dominoes: 18 computer rounds (draw and block, 2 to 4 players, three levels) keep all 28 tiles and a matching chain');
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
