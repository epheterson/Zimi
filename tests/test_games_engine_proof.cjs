// Chess, Shogi and Xiangqi engines: the proof that a refactor changes nothing.
//   1. perft (move-generation counts) from published positions;
//   2. the engine's chosen move and score at a fixed depth (no noise, no clock) from 20 positions per game,
//      compared with tests/fixtures/games_engine_fixed_depth.json, captured from the engines as they stood before the refactor.
//
// Run: node tests/test_games_engine_proof.cjs            (exit 0 = pass)
//      node tests/test_games_engine_proof.cjs --write    (recapture the fixtures: only on a tree whose play is known good)
//
// Perft sources: chess start, Kiwipete, positions 3-5: chessprogramming.org/Perft_Results.
// Shogi start 30 / 900 / 25470 / 719731 and Xiangqi start 44 / 1920 / 79666 / 3290240: the published counts
// (Shogi: apery/YaneuraOu perft; Xiangqi: Fairy-Stockfish and pikafish perft). The other rows are counts this code gave
// before the refactor, with no outside source, and they guard against drift only.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const FIXTURES = path.join(__dirname, 'fixtures', 'games_engine_fixed_depth.json');
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

const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
const GAMES = {
  chess: {
    files: ['enginekit.js', 'chess-engine.js'], make: s => s.ZimiChessEngine(s.ZimiSearch()), parse: 'parseFen', dump: 'toFen', depth: 4,
    perft: [
      ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281]],
      [KIWIPETE, [48, 2039, 97862]],
      ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
      ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
      ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]]
    ]
  },
  shogi: {
    files: ['enginekit.js', 'shogi-engine.js'], make: s => s.ZimiShogiEngine(s.ZimiSearch()), parse: 'parseSfen', dump: 'toSfen', depth: 3,
    perft: [
      [null, [30, 900, 25470, 719731]]
    ]
  },
  xiangqi: {
    files: ['enginekit.js', 'xiangqi-engine.js'], make: s => s.ZimiXiangqiEngine(s.ZimiSearch()), parse: 'parseFen', dump: 'toFen', depth: 3,
    perft: [
      [null, [44, 1920, 79666, 3290240]]
    ]
  }
};

// 20 positions per game: seeded random play from the start, 4 plies apart, so openings, middlegames and endings all show.
function positions(g, E) {
  const rnd = seeded(20261026), out = [];
  for (let n = 0; n < 20; n++) {
    const pos = E.startPosition(), stop = n * 4 + (n % 3);
    for (let ply = 0; ply < stop; ply++) {
      const ms = E.legalMoves(pos);
      if (!ms.length) break;
      E.make(pos, ms[Math.floor(rnd() * ms.length)]);
    }
    if (E.legalMoves(pos).length > 1) out.push(E[g.dump](pos));
  }
  return out;
}

const write = process.argv.includes('--write');
const fixtures = write ? {} : JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
for (const name of Object.keys(GAMES)) {
  const g = GAMES[name], E = g.make(load(g.files));
  for (const [fen, counts] of g.perft) {
    const start = fen === null ? E.startPosition() : E[g.parse](fen);
    // The deepest shogi/xiangqi counts are a few seconds each.
    counts.forEach((n, i) => check(E.perft(start, i + 1) === n, name + ': perft(' + (i + 1) + ') ' + (fen || 'start') + ' = ' + n));
  }
  const list = write ? positions(g, E) : fixtures[name].map(f => f.pos);
  const rows = list.map(p => {
    const r = E.think(p, { depth: g.depth, ms: 600000, noise: 0 });
    return { pos: p, depth: g.depth, move: r.move, score: r.score, reached: r.depth };
  });
  if (write) fixtures[name] = rows;
  else rows.forEach((r, i) => {
    const want = fixtures[name][i];
    check(r.move === want.move && r.score === want.score && r.reached === want.reached,
      name + ': fixed depth ' + g.depth + ' #' + i + ' move ' + want.move + ' score ' + want.score + (r.move === want.move && r.score === want.score ? '' : ' (got ' + r.move + ', ' + r.score + ')'));
  });
  if (write) console.log(name + ': captured ' + rows.length + ' positions');
}
if (write) fs.writeFileSync(FIXTURES, JSON.stringify(fixtures, null, 1) + '\n');
process.exit(failures ? 1 : 0);
