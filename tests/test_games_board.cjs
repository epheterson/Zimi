// Arcade board games: the rules, with no DOM. Reversi flips, checkers forced captures,
// chess move generation (perft), mahjong free tiles and solvable deals.
//
// Run: node tests/test_games_board.cjs   (exit 0 = pass)

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

// ── Reversi ──
{
  const R = load(['reversi.js']).ReversiEngine;
  const sq = (r, c) => r * 8 + c;
  const b = R.initial();
  const first = R.legalMoves(b, R.BLACK).map(m => m.idx).sort((a, c) => a - c);
  check(JSON.stringify(first) === JSON.stringify([19, 26, 37, 44]), 'reversi: black opens on d3, c4, f5 or e6');
  check(R.legalMoves(b, R.WHITE).length === 4, 'reversi: white also has four first moves');
  const m = R.legalMoves(b, R.BLACK).find(x => x.idx === 19);
  check(m.flips.length === 1 && m.flips[0] === 27, 'reversi: d3 flips exactly d4');
  const k = R.count(R.play(b, R.BLACK, 19, m.flips));
  check(k.black === 4 && k.white === 1, 'reversi: after d3 it is 4 to 1');
  check(R.flipsFor(b, R.BLACK, 0).length === 0, 'reversi: a corner that traps nothing is illegal');
  check(R.flipsFor(b, R.BLACK, 27).length === 0, 'reversi: an occupied square is illegal');

  const x = new Int8Array(64);
  x[sq(3, 4)] = R.WHITE; x[sq(3, 5)] = R.BLACK; // east
  x[sq(4, 3)] = R.WHITE; x[sq(5, 3)] = R.BLACK; // south
  x[sq(4, 4)] = R.WHITE; x[sq(5, 5)] = R.BLACK; // south-east
  const f = R.flipsFor(x, R.BLACK, sq(3, 3));
  check(f.length === 3 && [sq(3, 4), sq(4, 3), sq(4, 4)].every(i => f.includes(i)), 'reversi: one move flips along three lines');

  const edge = new Int8Array(64); // a line that runs off the board traps nothing
  edge[sq(0, 1)] = R.WHITE; edge[sq(0, 2)] = R.WHITE;
  check(R.flipsFor(edge, R.BLACK, sq(0, 3)).length === 0, 'reversi: a line that ends at the edge is not trapped');

  const pass = new Int8Array(64); // white has no move, black does: black plays again
  pass[0] = R.BLACK; pass[1] = R.WHITE; pass[2] = R.WHITE;
  check(!R.hasMove(pass, R.WHITE) && R.hasMove(pass, R.BLACK) && R.nextTurn(pass, R.BLACK) === R.BLACK, 'reversi: a side with no move passes');
  check(R.nextTurn(b, R.BLACK) === R.WHITE, 'reversi: turns alternate normally');
  const full = new Int8Array(64).fill(R.BLACK);
  check(R.isOver(full) && R.nextTurn(full, R.BLACK) === 0, 'reversi: no move for either side ends the game');

  const cb = new Int8Array(64);
  cb[1] = R.WHITE; cb[2] = R.BLACK; cb[sq(3, 3)] = R.WHITE; cb[sq(3, 4)] = R.BLACK;
  for (const lv of ['medium', 'hard']) check(R.chooseMove(cb, R.BLACK, lv).idx === 0, 'reversi: ' + lv + ' takes a corner on offer');

  for (const lv of ['easy', 'medium', 'hard']) {
    let bd = R.initial(), turn = R.BLACK, plies = 0, ok = true;
    const rng = seeded(7);
    const cap = lv === 'hard' ? 24 : 200; // hard thinks longest: a stretch of its play is enough here
    while (turn && plies < cap) {
      const mv = R.chooseMove(bd, turn, lv, rng);
      if (!mv || R.flipsFor(bd, turn, mv.idx).length === 0) { ok = false; break; }
      bd = R.play(bd, turn, mv.idx, mv.flips); plies++;
      turn = R.nextTurn(bd, turn);
    }
    check(ok && (lv === 'hard' || (turn === 0 && R.isOver(bd))), 'reversi: ' + lv + ' plays legally for ' + plies + ' moves' + (lv === 'hard' ? '' : ', to the end of the game'));
  }
}

// ── Checkers ──
{
  const C = load(['checkers.js']).CheckersEngine;
  const sq = (r, c) => r * 8 + c;
  const empty = () => new Int8Array(64);
  const init = C.initial();
  const k = C.count(init);
  check(k.red === 12 && k.white === 12, 'checkers: twelve a side');
  check(C.moves(init, C.RED).length === 7, 'checkers: red has seven opening moves');
  check(C.moves(init, C.WHITE).length === 7, 'checkers: white has seven opening moves');
  check(C.moves(init, C.RED).every(m => m.caps.length === 0), 'checkers: no captures at the start');

  // a capture is compulsory: with a jump on, the quiet moves are not offered
  let b = empty();
  b[sq(5, 2)] = 1; b[sq(4, 3)] = 3; b[sq(7, 6)] = 1;
  let ms = C.moves(b, C.RED);
  check(ms.length === 1 && ms[0].caps[0] === sq(4, 3) && ms[0].to === sq(3, 4), 'checkers: a capture is forced, the other piece may not step');

  // multi-jump runs to its end
  b = empty();
  b[sq(7, 0)] = 1; b[sq(6, 1)] = 3; b[sq(4, 3)] = 3; b[sq(2, 5)] = 3;
  ms = C.moves(b, C.RED);
  check(ms.length === 1 && ms[0].path.length === 3 && ms[0].caps.length === 3 && ms[0].to === sq(1, 6), 'checkers: a multi-jump runs to its end over three men');
  const after = C.apply(b, ms[0]);
  check(C.count(after).white === 0 && after[sq(1, 6)] === 1, 'checkers: all jumped pieces are removed');

  // a branching jump offers both sequences
  b = empty();
  b[sq(5, 4)] = 1; b[sq(4, 3)] = 3; b[sq(4, 5)] = 3;
  ms = C.moves(b, C.RED);
  check(ms.length === 2, 'checkers: two different jumps are both offered');

  // promotion, and a man crowned by a jump stops there
  b = empty();
  b[sq(1, 2)] = 1;
  const crown = C.moves(b, C.RED).find(m => m.to === sq(0, 1));
  check(C.apply(b, crown)[sq(0, 1)] === 2, 'checkers: a man reaching the far row becomes a king');
  b = empty();
  b[sq(2, 1)] = 1; b[sq(1, 2)] = 3; b[sq(1, 4)] = 3;
  ms = C.moves(b, C.RED);
  check(ms.length === 1 && ms[0].path.length === 1 && ms[0].to === sq(0, 3), 'checkers: a man crowned by a jump stops there, though a king could go on');

  // kings capture backwards; men do not
  b = empty();
  b[sq(3, 3)] = 2; b[sq(4, 4)] = 3;
  check(C.moves(b, C.RED).some(m => m.caps.length === 1 && m.to === sq(5, 5)), 'checkers: a king captures backwards');
  b = empty();
  b[sq(3, 3)] = 1; b[sq(4, 4)] = 3;
  check(C.moves(b, C.RED).every(m => m.caps.length === 0), 'checkers: a man cannot capture backwards');
  b = empty(); b[sq(4, 3)] = 3;
  check(C.moves(b, C.RED).length === 0, 'checkers: a side with no pieces has no moves');

  // the computer takes the forced capture and only ever plays legal moves
  b = empty();
  b[sq(5, 2)] = 1; b[sq(4, 3)] = 3; b[sq(0, 7)] = 3;
  for (const lv of ['easy', 'medium', 'hard']) {
    const mv = C.chooseMove(b, C.RED, lv);
    check(mv && mv.caps.length === 1, 'checkers: ' + lv + ' takes the forced capture');
  }
  for (const lv of ['easy', 'medium']) {
    let bd = C.initial(), turn = C.RED, plies = 0, ok = true;
    const rng = seeded(11);
    while (plies < 70) {
      const all = C.moves(bd, turn);
      if (!all.length) break;
      const mv = C.chooseMove(bd, turn, lv, rng);
      if (!mv || !all.some(m => m.from === mv.from && m.to === mv.to && m.caps.length === mv.caps.length)) { ok = false; break; }
      bd = C.apply(bd, mv); turn = C.other(turn); plies++;
    }
    check(ok, 'checkers: ' + lv + ' plays only legal moves for ' + plies + ' plies');
  }
}

// ── Chess ──
{
  const sandbox = load(['enginekit.js', 'chess-engine.js']);
  const C = sandbox.ZimiChessEngine(sandbox.ZimiSearch());
  const perft = (fen, d) => C.perft(C.parseFen(fen), d);
  const START = C.START_FEN;
  check(perft(START, 1) === 20 && perft(START, 2) === 400, 'chess: 20 and 400 moves from the start');
  check(perft(START, 3) === 8902, 'chess: perft(3) from the start = 8902');
  check(perft(START, 4) === 197281, 'chess: perft(4) from the start = 197281');
  const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  check(perft(KIWIPETE, 1) === 48 && perft(KIWIPETE, 2) === 2039, 'chess: Kiwipete (castling, pins, ep) perft 1-2 = 48, 2039');
  check(perft(KIWIPETE, 3) === 97862, 'chess: Kiwipete perft(3) = 97862');
  const POS3 = '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1';
  check(perft(POS3, 4) === 43238, 'chess: rook-and-pawn endgame (ep checks) perft(4) = 43238');
  const POS4 = 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1';
  check(perft(POS4, 3) === 9467, 'chess: promotions and checks position perft(3) = 9467');
  const POS5 = 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8';
  check(perft(POS5, 3) === 62379, 'chess: promotion-with-capture position perft(3) = 62379');

  // make and unmake restore everything
  const pos = C.parseFen(KIWIPETE), before = C.toFen(pos);
  C.legalMoves(pos).forEach(m => { C.make(pos, m); C.unmake(pos); });
  check(C.toFen(pos) === before, 'chess: make/unmake of every move restores the position');
  check(C.toFen(C.parseFen(START)) === START, 'chess: FEN round trip');

  // the rules of the end of a game
  const mate = C.parseFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
  const st = C.status(mate, null);
  check(st.over && st.result === 'mate' && st.winner === C.BLACK, 'chess: fool\'s mate is checkmate for black');
  const stale = C.status(C.parseFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'), null);
  check(stale.over && stale.result === 'stalemate', 'chess: stalemate is a draw, not a loss');
  check(C.status(C.parseFen('8/8/8/4k3/8/8/3K4/8 w - - 0 1'), null).result === 'material', 'chess: king against king is a draw');
  check(C.status(C.parseFen('8/8/8/4k3/8/8/3K1N2/8 w - - 0 1'), null).result === 'material', 'chess: king and knight against king is a draw');
  check(C.status(C.parseFen('8/8/8/4k3/8/8/3K1R2/8 w - - 0 1'), null).over === false, 'chess: king and rook against king is not');
  check(C.status(C.parseFen('8/8/8/4k3/8/8/3K1R2/8 w - - 100 80'), null).result === 'fifty', 'chess: fifty moves without a capture or pawn move is a draw');
  // threefold repetition by shuffling knights
  {
    const g = C.startPosition(), keys = [C.key(g)];
    for (let i = 0; i < 2; i++) {
      for (const [f, t] of [['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']]) {
        C.make(g, C.findMove(g, C.squareFromName(f), C.squareFromName(t), 0));
        keys.push(C.key(g));
      }
    }
    check(C.status(g, keys).result === 'repetition', 'chess: the start position a third time is a draw by repetition');
    check(C.status(g, keys.slice(0, 5)).over === false, 'chess: twice is not');
  }

  // castling, en passant, promotion by hand
  {
    const g = C.parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const names = C.legalMoves(g).map(m => C.san(g, m));
    check(names.includes('O-O') && names.includes('O-O-O'), 'chess: both castles are offered');
    const blocked = C.parseFen('r3k2r/8/8/8/8/5r2/8/R3K2R w KQkq - 0 1');
    check(!C.legalMoves(blocked).map(m => C.san(blocked, m)).includes('O-O'), 'chess: no castling through an attacked square');
    const checked = C.parseFen('r3k2r/8/8/8/8/4r3/8/R3K2R w KQkq - 0 1');
    check(!C.legalMoves(checked).map(m => C.san(checked, m)).some(s => s.startsWith('O-O')), 'chess: no castling out of check');
    const ep = C.parseFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
    const epMove = C.findMove(ep, C.squareFromName('e5'), C.squareFromName('d6'), 0);
    check(epMove && C.san(ep, epMove) === 'exd6', 'chess: en passant is legal on the right turn');
    C.make(ep, epMove);
    check(ep.sq[C.squareFromName('d5')] === 0, 'chess: en passant removes the captured pawn');
    const gone = C.parseFen('4k3/8/8/3pP3/8/8/8/4K3 w - - 0 2');
    check(!C.findMove(gone, C.squareFromName('e5'), C.squareFromName('d6'), 0), 'chess: en passant is gone a move later');
    const pr = C.parseFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    const promos = C.legalMoves(pr).filter(m => C.from(m) === C.squareFromName('a7'));
    check(promos.length === 4 && C.san(pr, promos[0]).startsWith('a8='), 'chess: a pawn on the seventh promotes four ways');
    check(C.san(C.parseFen('r3k3/8/8/8/8/8/8/R3K2R w KQq - 0 1'), C.findMove(C.parseFen('r3k3/8/8/8/8/8/8/R3K2R w KQq - 0 1'), 56, 0, 0)) === 'Rxa8+', 'chess: SAN marks a capture and check');
    const dis = C.parseFen('4k3/8/8/8/8/8/4K3/R6R w - - 0 1');
    const dn = C.legalMoves(dis).map(m => C.san(dis, m));
    check(dn.includes('Rad1') && dn.includes('Rhd1'), 'chess: SAN keeps two rooks apart');
  }

  // the searcher: finds mate in one, takes a hanging queen, never plays an illegal move
  {
    const m1 = C.parseFen('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
    const r = C.think(m1, { level: 'club', ms: 1500 });
    check(C.san(m1, r.move) === 'Ra8#', 'chess: finds back-rank mate in one');
    const hang = C.parseFen('4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1');
    check(C.san(hang, C.think(hang, { level: 'casual', noise: 0, ms: 800 }).move) === 'Rxd5', 'chess: takes the hanging queen');
    for (const lv of ['beginner', 'casual']) {
      const g = C.startPosition();
      let ok = true;
      for (let i = 0; i < 24 && ok; i++) {
        const all = C.legalMoves(g);
        if (!all.length) break;
        const t = C.think(g, { level: lv, ms: 80 });
        if (!all.includes(t.move)) ok = false; else C.make(g, t.move);
      }
      check(ok, 'chess: ' + lv + ' plays 24 legal plies');
    }
  }
  // the worker's way in: the engine rebuilt from its own source text behaves the same
  {
    const rebuilt = vm_run(sandbox.ZimiChessEngine.toString() + '; ZimiChessEngine()');
    check(rebuilt.perft(rebuilt.startPosition(), 3) === 8902, 'chess: the engine rebuilt from its source (as the worker does) still counts 8902');
  }
}

// ── Mahjong solitaire ──
{
  const M = load(['mahjong.js']).MahjongEngine;
  const counts = M.LAYOUTS.map(l => M.tilesOf(l).length);
  check(counts[0] === 144, 'mahjong: the turtle has 144 tiles (' + counts[0] + ')');
  check(counts.every(n => n % 2 === 0 && n <= 144), 'mahjong: every layout has an even number of tiles (' + counts.join(', ') + ')');
  check(M.LAYOUTS.length >= 3, 'mahjong: three layouts');
  M.LAYOUTS.forEach(l => {
    const tiles = M.tilesOf(l);
    let clash = false;
    tiles.forEach((a, i) => tiles.forEach((b, j) => { if (i < j && a.l === b.l && Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2) clash = true; }));
    check(!clash, 'mahjong: ' + l.id + ' has no overlapping tiles on a layer');
  });
  check(M.allPairs().length === 72, 'mahjong: 72 pairs make the 144 faces');
  check(M.matches(5, 5) && !M.matches(5, 6) && M.matches(34, 37) && M.matches(38, 41) && !M.matches(34, 38), 'mahjong: faces match alike, flowers with flowers, seasons with seasons');

  // the free-tile rule on a hand-made row: A B C side by side, D on top of B, E half a row off beside C
  const tiles = [{ l: 0, x: 0, y: 0 }, { l: 0, x: 2, y: 0 }, { l: 0, x: 4, y: 0 }, { l: 1, x: 2, y: 0 }, { l: 0, x: 6, y: 1 }];
  const an = M.analyze(tiles), alive = new Uint8Array(5).fill(1);
  const freeNow = () => M.freeList(an, alive).join(',');
  check(freeNow() === '0,3,4', 'mahjong: only the open end and the top tile are free');
  alive[3] = 0;
  check(freeNow() === '0,4', 'mahjong: with the top gone, the middle tile still has a neighbour on each side');
  alive[0] = 0;
  check(freeNow() === '1,4', 'mahjong: take an end and the middle tile frees up');
  alive[4] = 0;
  check(freeNow() === '1,2', 'mahjong: with the half-row neighbour gone its neighbour is free');
  alive.set([1, 1, 1, 0, 1]);
  check(!M.isFree(an, alive, 2), 'mahjong: a tile half a row off still blocks the side it touches');

  // every deal can be cleared: replay the dealt order, each step two free matching tiles
  const replay = (d, order, al) => {
    for (const [a, b] of order) {
      if (!M.isFree(d.an, al, a) || !M.isFree(d.an, al, b) || !M.matches(d.faces[a], d.faces[b])) return false;
      al[a] = al[b] = 0;
    }
    return al.every(v => v === 0);
  };
  M.LAYOUTS.forEach(l => {
    let ok = 0;
    const total = 25;
    for (let seed = 1; seed <= total; seed++) {
      const d = M.dealLayout(l, seeded(seed * 97));
      if (d && replay(d, d.order, new Uint8Array(d.an.n).fill(1))) ok++;
    }
    check(ok === total, 'mahjong: ' + l.id + ' deals clearable boards (' + ok + ' of ' + total + ' seeds replay to empty)');
  });
  {
    const d = M.dealLayout(M.LAYOUTS[0], seeded(5));
    const faces = {};
    d.faces.forEach(f => { faces[f] = (faces[f] || 0) + 1; });
    check(Object.keys(faces).length === 42 && Object.entries(faces).every(([k, n]) => (k < 34 ? n === 4 : n === 1)), 'mahjong: the full turtle holds the real 144 (34 faces x 4, 4 flowers, 4 seasons)');
  }
  // an independent check on a small board: a depth-first solver that never sees the dealt order
  {
    const small = M.dealLayout({ id: 't', name: 't', layers: [{ rows: [[0, 0, 6], [2, 0, 6]] }, { rows: [[0, 2, 4]] }] }, seeded(3));
    const al = new Uint8Array(small.an.n).fill(1), dead = new Set();
    const go = left => {
      if (!left) return true;
      const k = al.join('');
      if (dead.has(k)) return false;
      const free = M.freeList(small.an, al);
      for (let a = 0; a < free.length; a++) for (let b = a + 1; b < free.length; b++) {
        if (!M.matches(small.faces[free[a]], small.faces[free[b]])) continue;
        al[free[a]] = al[free[b]] = 0;
        if (go(left - 2)) return true;
        al[free[a]] = al[free[b]] = 1;
      }
      dead.add(k); return false;
    };
    check(go(small.an.n), 'mahjong: a small deal is solved by an independent search too');
  }
  // shuffling what is left keeps the faces and keeps the board clearable
  {
    const d = M.dealLayout(M.LAYOUTS[1], seeded(9)), al = new Uint8Array(d.an.n).fill(1);
    d.order.slice(0, 20).forEach(([a, b]) => { al[a] = al[b] = 0; });
    const rest = () => Array.from(d.faces).filter((f, i) => al[i]).sort((a, b) => a - b).join(',');
    const before = rest();
    const r = M.reshuffle(d.an, al, d.faces, seeded(21));
    check(r && before === rest(), 'mahjong: shuffling the rest keeps the same faces');
    check(replay(d, r.order, Uint8Array.from(al)), 'mahjong: and the shuffled rest can still be cleared');
    check(M.findPair(d.an, new Uint8Array(d.an.n).fill(1), d.faces) !== null, 'mahjong: a pair is found on a fresh board');
  }
}

function vm_run(code) { return vm.runInNewContext(code, {}); }

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
