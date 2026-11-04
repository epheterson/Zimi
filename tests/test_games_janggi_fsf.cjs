// Janggi against Fairy-Stockfish itself (the real WebAssembly build the Strong and Master levels use, run under node):
//   1. at every position of random games from each of the four arrangements, our move generator and Fairy-Stockfish list
//      the same moves (bikjang, the pass and the palace included);
//   2. whole games, our engine against Fairy-Stockfish: every move it answers is one of our legal moves, through
//      ZimiFairy's own FEN, history and move text.
//
// Run: node tests/test_games_janggi_fsf.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0;
const check = (ok, label) => { if (ok) console.log('ok: ' + label); else { console.error('FAIL: ' + label); failures++; } };
const seeded = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

async function startFairy() {
  const lines = [], sb = { console, setTimeout, clearTimeout, WebAssembly, URL, TextDecoder, TextEncoder, performance: { now: () => Date.now() } };
  sb.self = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(dir, 'engines', 'fairy', 'fairy.js'), 'utf8'), sb);
  const bytes = fs.readFileSync(path.join(dir, 'engines', 'fairy', 'fairy.wasm'));
  const m = await sb.FairyStockfish({
    print: l => lines.push(l), printErr: () => {},
    instantiateWasm: (imports, done) => { WebAssembly.instantiate(bytes, imports).then(r => done(r.instance, r.module)); return {}; }
  });
  m._zimi_init();
  const send = l => m.ccall('zimi_command', null, ['string'], [l]);
  send('uci'); send('setoption name UCI_Variant value janggi'); send('setoption name Use NNUE value false');
  return { lines, send };
}

(async () => {
  const sb = {};
  vm.createContext(sb);
  for (const f of ['enginekit.js', 'janggi-engine.js', 'engines/fairy.js']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sb, { filename: f });
  const E = sb.ZimiJanggiEngine(sb.ZimiSearch()), F = sb.ZimiFairy;
  const fsf = await startFairy();
  const isPass = t => t.length >= 4 && t.slice(0, t.length / 2) === t.slice(t.length / 2);
  const theirMoves = fen => {
    fsf.lines.length = 0; fsf.send('position fen ' + fen); fsf.send('go perft 1');
    return fsf.lines.filter(l => /^[a-i]\d+[a-i]\d+: \d+/.test(l)).map(l => l.split(':')[0]).sort();
  };

  // 1. the same moves everywhere
  {
    const rnd = seeded(41);
    let positions = 0, bad = 0, bikjangs = 0;
    for (let g = 0; g < 12; g++) {
      const A = E.ARRANGEMENTS, pos = E.startPosition(A[Math.floor(rnd() * 4)], A[Math.floor(rnd() * 4)]);
      for (let ply = 0; ply < 140; ply++) {
        const mine = E.legalMoves(pos).map(m => F.uci('janggi', E, pos, m)).sort(), fen = F.fen('janggi', E, pos);
        const theirs = theirMoves(fen).filter(t => !isPass(t));
        positions++; if (E.bikjang(pos)) bikjangs++;
        if (JSON.stringify(mine) !== JSON.stringify(theirs)) { bad++; console.error('DIFF ' + fen + ' only ours ' + mine.filter(x => !theirs.includes(x)) + ' only theirs ' + theirs.filter(x => !mine.includes(x))); break; }
        const ms = E.movesOrPass(pos);
        if (!ms.length) break;
        E.make(pos, ms[Math.floor(rnd() * ms.length)]);
        if (E.status(pos).over) break;
      }
    }
    check(bad === 0 && positions > 500, 'janggi: our moves are Fairy-Stockfish\'s at ' + positions + ' positions of random games from every arrangement (' + bikjangs + ' in bikjang)');
  }

  // 2. whole games against the engine
  {
    // Both sides think against a clock, so a loaded machine can end a game early: each game must reach 70 plies or a real end.
    let ok = true, plies = 0, short = 0, why = '';
    for (const [cho, han] of [['inside', 'outside'], ['left', 'right']]) {
      const pos = E.startPosition(cho, han), played = [];
      for (let ply = 0; ply < 70 && ok; ply++) {
        if (E.status(pos).over) break;
        let m;
        if (pos.turn === E.HAN) {
          const h = F.history('janggi', E, pos, played);
          fsf.lines.length = 0; fsf.send('ucinewgame'); fsf.send('position fen ' + h.fen + (h.moves.length ? ' moves ' + h.moves.join(' ') : '')); fsf.send('go movetime 60');
          const best = fsf.lines.filter(l => l.indexOf('bestmove ') === 0).map(l => l.split(/\s+/)[1])[0];
          m = F.pick('janggi', E, pos, best);
          if (m === null) { ok = false; why = 'Fairy-Stockfish answered ' + best + ' at ' + E.toFen(pos); }
        } else m = E.think(pos, { level: 'medium', ms: 150, depth: 2, noise: 0 }).move;
        if (!ok) break;
        if (!(E.movesOrPass(pos).includes(m) || (m === E.PASS && !E.inCheck(pos)))) { ok = false; why = 'illegal ' + m; break; }   // the page lets a side pass whenever it is not in check
        played.push(m); E.make(pos, m); plies++;
      }
      if (played.length < 70 && !E.status(pos).over) short++;
    }
    if (!ok) console.error(why);
    check(ok && short === 0 && plies > 20, 'janggi: ' + plies + ' plies against Fairy-Stockfish, every answer one of our legal moves');
  }

  console.log(failures ? failures + ' failed' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
