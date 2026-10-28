// ZimiGames: Fairy-Stockfish behind Strong and Master (zimi/builtin/games/engines/fairy.js).
// The adapter's FEN and move text for Chess, Xiangqi, Shogi, Minishogi, Janggi and Makruk, checked against the
// real engine: the vendored WebAssembly runs here in node, and for every position its legal moves (go perft 1) must
// be exactly ours, converted. Then a bestmove must map back to one of our legal moves.
//
// Run: node tests/test_games_fairy.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
function load(files) {
  const sandbox = { console };
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  return sandbox;
}
let seed = 20261024;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

const sb = load(['enginekit.js', 'chess-engine.js', 'xiangqi-engine.js', 'shogi-engine.js', 'janggi-engine.js', 'makruk-engine.js', 'engines/fairy.js']);
const F = sb.ZimiFairy;
const engines = {
  chess: sb.ZimiChessEngine(),
  xiangqi: sb.ZimiXiangqiEngine(),
  shogi: sb.ZimiShogiEngine(sb.ZimiSearch()),
  minishogi: sb.ZimiShogiEngine(sb.ZimiSearch(), 'mini'),
  janggi: sb.ZimiJanggiEngine(sb.ZimiSearch()),
  makruk: sb.ZimiMakrukEngine()
};
const startOf = (name, E) => name === 'shogi' || name === 'minishogi' ? E.startPosition() : E.startPosition();
const movesOf = (E, pos) => (E.movesOrPass || E.legalMoves)(pos);

// ── the pure half, on fixed positions ──
{
  const E = engines.chess, pos = E.startPosition();
  check(F.fen('chess', E, pos) === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'chess: the start position is the standard FEN');
  check(F.uci('chess', E, pos, E.findMove(pos, E.squareFromName('e2'), E.squareFromName('e4'))) === 'e2e4', 'chess: e2e4');
  const castle = E.parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const texts = movesOf(E, castle).map(m => F.uci('chess', E, castle, m));
  check(texts.includes('e1g1') && texts.includes('e1c1'), 'chess: castling is the king moving two squares');
  const promo = E.parseFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  const ptexts = movesOf(E, promo).map(m => F.uci('chess', E, promo, m));
  check(['a7a8q', 'a7a8r', 'a7a8b', 'a7a8n'].every(t => ptexts.includes(t)), 'chess: promotions carry the piece letter');
}
{
  const E = engines.xiangqi, pos = E.startPosition();
  check(F.fen('xiangqi', E, pos) === 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1', 'xiangqi: horse N, elephant B, general K');
  const texts = movesOf(E, pos).map(m => F.uci('xiangqi', E, pos, m));
  check(texts.includes('b3e3') && texts.includes('a1a2') && texts.includes('b1c3'), 'xiangqi: ranks run 1 to 10 from red\'s side');
  check(texts.length === 44, 'xiangqi: 44 opening moves');
}
{
  const E = engines.janggi, pos = E.startPosition();
  const f = F.fen('janggi', E, pos);
  check(f === 'rnba1abnr/4k4/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/4K4/RNBA1ABNR w - - 0 1', 'janggi: FEN with N and B');
  const texts = movesOf(E, pos).map(m => F.uci('janggi', E, pos, m));
  check(texts.includes('a1a2') && texts.includes('b1c3'), 'janggi: ranks count from Cho\'s side');
  const han = E.parseFen('rnba1abnr/4k4/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/4K4/RNBA1ABNR b');
  check(movesOf(E, han).map(m => F.uci('janggi', E, han, m)).includes('e9e10'), 'janggi: ranks reach 10 (the Han general steps to e10)');
  const stuck = E.parseFen('3a1k3/4a4/9/9/9/9/9/9/9/4K4 w');
  check(F.uci('janggi', E, stuck, E.PASS) === 'e1e1', 'janggi: a pass is the general\'s square twice');
  check(F.pick('janggi', E, E.parseFen('4k4/9/9/9/9/9/9/9/9/4K4 w'), 'e1e1') === E.PASS, 'janggi: a pass text is the pass (the page lets a side pass when not in check)');
}
{
  const E = engines.shogi, pos = E.startPosition();
  check(F.fen('shogi', E, pos) === 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL[] w - - 0 1', 'shogi: start FEN, empty hands, sente is w');
  const texts = movesOf(E, pos).map(m => F.uci('shogi', E, pos, m));
  check(texts.includes('c3c4') && texts.includes('h2g2') && texts.length === 30, 'shogi: 30 opening moves, files a to i');
  const hand = E.parseSfen('4k4/9/9/9/9/9/9/9/4K4 b 2Pp');
  const dropText = movesOf(E, hand).map(m => F.uci('shogi', E, hand, m));
  check(F.fen('shogi', E, hand) === '4k4/9/9/9/9/9/9/9/4K4[PPp] w - - 0 1', 'shogi: hands go in brackets, capital for sente');
  check(dropText.includes('P@e5') && !dropText.some(t => t.startsWith('p@')), 'shogi: drops read P@e5');
  const prom = E.parseSfen('4k4/9/1P7/9/9/9/9/9/4K4 b -');
  const promText = movesOf(E, prom).map(m => F.uci('shogi', E, prom, m));
  check(promText.includes('g7g8+') || promText.includes('b7b8+'), 'shogi: a promotion ends in +');
}
{
  const E = engines.minishogi, pos = E.startPosition();
  check(F.fen('minishogi', E, pos) === 'rbsgk/4p/5/P4/KGSBR[] w - - 0 1', 'minishogi: start FEN');
}
{
  const E = engines.makruk, pos = E.startPosition();
  check(F.fen('makruk', E, pos) === 'rnsmksnr/8/pppppppp/8/8/PPPPPPPP/8/RNSKMSNR w - - 0 1', 'makruk: start FEN');
}

// ── the real engine in node ──
const wasmDir = path.join(dir, 'engines', 'fairy');
const Module = require(path.join(wasmDir, 'fairy.js'));

async function main() {
  const lines = [];
  const bytes = fs.readFileSync(path.join(wasmDir, 'fairy.wasm'));
  const M = await Module({ print: l => lines.push(l), printErr: () => {}, instantiateWasm: (imports, done) => { WebAssembly.instantiate(bytes, imports).then(r => done(r.instance, r.module)); return {}; } });
  M._zimi_init();
  const send = s => M.ccall('zimi_command', null, ['string'], [s]);
  send('uci'); send('setoption name Use NNUE value false'); send('setoption name Hash value 16');
  let variant = '';
  const setVariant = v => { if (v !== variant) { send('setoption name UCI_Variant value ' + v); variant = v; } };
  const run = (v, positionLine, go) => { setVariant(v); lines.length = 0; send(positionLine); send(go); return lines.slice(); };
  // Fairy-Stockfish lists the pass (the general's square twice) in janggi whenever the general is not in check; our
  // engine lists it only when a side has no other move, and the page offers it by the same rule as Fairy's.
  const isPassText = t => t.length > 3 && t.slice(0, t.length / 2) === t.slice(t.length / 2);
  const fairyMoves = (v, fen, moves, keepPass) => {
    const out = run(v, 'position fen ' + fen + (moves && moves.length ? ' moves ' + moves.join(' ') : ''), 'go perft 1');
    return out.filter(l => /^\S+: \d+$/.test(l)).map(l => l.split(':')[0]).filter(t => keepPass || !isPassText(t)).sort();
  };

  // Fairy-Stockfish still lists a pawn drop that gives checkmate in shogi and minishogi (it then has no reply); the rule
  // forbids it and our engine does too. That is the one place the two may differ: the extra drops must all be of that kind.
  const sameMoves = (v, fen, moves, ours, theirs) => {
    const extra = theirs.filter(t => !ours.includes(t)), missing = ours.filter(t => !theirs.includes(t));
    if (missing.length) return false;
    return extra.every(t => /^P@/.test(t) && v.includes('shogi') &&
      !run(v, 'position fen ' + fen + ' moves ' + (moves && moves.length ? moves.join(' ') + ' ' : '') + t, 'go perft 1').some(l => /^\S+: \d+$/.test(l)));
  };
  const NAMES = Object.keys(engines);
  const WALK_PLIES = 80, WALKS = 4;
  for (const name of NAMES) {
    const E = engines[name], variantName = F.GAMES[name].variant;
    let positions = 0, bad = 0, firstBad = null;
    for (let w = 0; w < WALKS; w++) {
      const pos = startOf(name, E), played = [];
      for (let ply = 0; ply < WALK_PLIES; ply++) {
        const ours = movesOf(E, pos).map(m => F.uci(name, E, pos, m)).sort();
        if (!ours.length || (E.bikjang && E.bikjang(pos))) break;   // no move, or a drawn bikjang: the game is over
        const keepPass = ours.some(isPassText);
        // the position written alone, and the same position reached by its moves from the start
        const alone = fairyMoves(variantName, F.fen(name, E, pos), null, keepPass);
        const h = F.history(name, E, pos, played);
        const reached = fairyMoves(variantName, h.fen, h.moves, keepPass);
        positions++;
        if (!sameMoves(variantName, F.fen(name, E, pos), null, ours, alone) || !sameMoves(variantName, h.fen, h.moves, ours, reached)) {
          bad++;
          if (!firstBad) firstBad = { fen: F.fen(name, E, pos), moves: h.moves.join(' '), ours: ours.join(' '), alone: alone.join(' '), reached: reached.join(' ') };
        }
        const choices = movesOf(E, pos), m = choices[Math.floor(rnd() * choices.length)];
        played.push(m); E.make(pos, m);
      }
    }
    check(bad === 0, name + ': our legal moves equal the engine\'s in all ' + positions + ' positions of ' + WALKS + ' random games' + (firstBad ? '\n  ' + JSON.stringify(firstBad) : ''));

    // a bestmove maps back to one of our legal moves, for the start and for a middlegame position
    const pos = startOf(name, E);
    for (let i = 0; i < 6; i++) { const ms = movesOf(E, pos); if (!ms.length) break; E.make(pos, ms[Math.floor(rnd() * ms.length)]); }
    const out = run(variantName, 'position fen ' + F.fen(name, E, pos), 'go movetime 150');
    const best = out.filter(l => l.startsWith('bestmove ')).map(l => l.split(/\s+/)[1])[0];
    const picked = F.pick(name, E, pos, best);
    check(best && picked !== null && picked !== undefined, name + ': bestmove ' + best + ' is one of our legal moves');
    if (picked) check(F.uci(name, E, pos, picked) === best, name + ': the move converts back to the text it came from');
  }

  // positions a random walk rarely reaches: promotions, promoted pieces, drops with hands on both sides, checks, pins
  const FIXED = {
    makruk: ['4k3/8/8/2P5/8/8/8/4K3 w', '4k3/8/8/8/6p1/8/8/4K3 b', 'rnsmksnr/8/8/pppppppp/PPPPPPPP/8/8/RNSKMSNR w'],
    chess: ['rnbqkbnr/pppp1ppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', '4k3/8/8/8/8/8/p7/R3K2R b KQ - 0 1', 'r3k2r/pp1b1ppp/8/8/8/8/PP1B1PPP/R3K2R w KQkq - 0 1'],
    shogi: ['4k4/9/9/9/9/9/9/+P+B+R6/4K4 b 2Pp', '4k4/9/9/9/9/9/PPPPPPPPp/9/4K4 b - 1', 'ln1gkg1nl/1r5s1/pppp1pppp/4p4/9/2P6/PP1PPPPPP/7R1/LNSGKGSNL w BSbs 1'],
    minishogi: ['4k/5/5/5/K4 b 2G', 'r3k/5/5/5/K3R w -'],
    xiangqi: ['3k5/9/9/9/9/9/9/9/9/4K4 w', '4k4/9/9/9/9/9/9/9/4K4/R3C4 w', 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/2P6/P3P1P1P/1C5C1/9/RNBAKABNR b'],
    janggi: ['3k5/9/9/9/9/9/9/9/9/4K4 w', '3a1k3/4a4/9/9/9/9/9/9/9/4K4 b', 'rnba1abnr/4k4/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/4K4/RNBA1ABNR w']
  };
  for (const name of Object.keys(FIXED)) {
    const E = engines[name], variantName = F.GAMES[name].variant;
    let bad = null;
    for (const text of FIXED[name]) {
      const pos = name.endsWith('shogi') ? E.parseSfen(text) : E.parseFen(text);
      const ours = movesOf(E, pos).map(m => F.uci(name, E, pos, m)).sort();
      const theirs = fairyMoves(variantName, F.fen(name, E, pos), null, ours.some(isPassText));
      if (!sameMoves(variantName, F.fen(name, E, pos), null, ours, theirs)) bad = bad || { text, ours: ours.join(' '), theirs: theirs.join(' ') };
    }
    check(!bad, name + ': our legal moves equal the engine\'s in ' + FIXED[name].length + ' hand-set positions' + (bad ? '\n  ' + JSON.stringify(bad) : ''));
  }

  // history lets the engine see repetition: one position, reached twice, is the same position to the engine as to us
  {
    const E = engines.chess, pos = E.startPosition(), played = [];
    ['g1f3', 'g8f6', 'f3g1', 'f6g8'].forEach(t => { const m = movesOf(E, pos).find(x => F.uci('chess', E, pos, x) === t); played.push(m); E.make(pos, m); });
    const undoBefore = pos.undo.length;
    const h = F.history('chess', E, pos, played);
    check(h.moves.join(' ') === 'g1f3 g8f6 f3g1 f6g8' && h.fen.startsWith('rnbqkbnr/pppppppp'), 'history: the start position and the four moves');
    check(E.toFen(pos).startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w'), 'history: the live position is left as it was');
    check(pos.undo.length === undoBefore, 'history: the take-back stack is as long as before');
  }
}

main().then(() => {
  if (failures) { console.error(failures + ' failed'); process.exit(1); }
  console.log('all passed');
}).catch(e => { console.error(e); process.exit(1); });
