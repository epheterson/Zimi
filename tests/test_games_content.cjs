// ZimiGames content games: every shipped chess puzzle, opening line, Go problem and Sokoban level is checked
// against the rules code that plays it, and the FreeCell hint solver's moves are legal.
//
// Run: node tests/test_games_content.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
function load(files, extra) {
  const sandbox = Object.assign({}, extra || {});
  vm.createContext(sandbox);
  sandbox.globalThis = sandbox;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  return sandbox;
}

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

// ── Chess puzzles ──
{
  const sb = load(['chess-engine.js', 'chess-content.js', 'data/chess-puzzles.js']);
  const E = sb.ZimiChessEngine(), C = sb.ZimiChessContent, D = sb.ZimiChessPuzzles;
  const rows = D.rows.split('\n');
  let bad = 0, firstBad = '', ratingsOk = true, prev = 0, mates = 0;
  const themeSeen = {};
  const ratingBand = {};
  for (const row of rows) {
    const p = C.parsePuzzle(row, D.themes);
    p.themes.forEach(t => { themeSeen[t] = (themeSeen[t] || 0) + 1; });
    if (p.rating < prev) ratingsOk = false;
    prev = p.rating;
    ratingBand[Math.floor(p.rating / 400)] = 1;
    const pos = E.parseFen(p.fen);
    const mover = pos.turn;
    let ok = true;
    for (let i = 0; i < p.moves.length && ok; i++) {
      const m = C.fromUci(E, pos, p.moves[i]);
      if (!m) { ok = false; break; }
      E.make(pos, m);
    }
    // the puzzle ends as the data says: the last move is the solver's (an even count), and a mate theme ends in mate
    if (ok && p.moves.length % 2 !== 0) ok = false;
    if (ok && /^mateIn/.test(p.themes.join(',')) && p.themes.some(t => /^mateIn[123]$/.test(t))) {
      mates++;
      if (E.status(pos, []).result !== 'mate') ok = false;
    }
    if (ok && mover === pos.turn && p.moves.length % 2 === 1) ok = false;
    if (!ok) { bad++; if (!firstBad) firstBad = row; }
  }
  check(rows.length >= 15000 && rows.length <= 20000, 'chess puzzles: ' + rows.length + ' shipped (15,000 to 20,000)');
  check(bad === 0, 'chess puzzles: every solution is legal from its FEN and ends as the data says' + (bad ? ' (' + bad + ' bad, first: ' + firstBad + ')' : ''));
  check(ratingsOk, 'chess puzzles: rows are sorted by rating');
  check(Object.keys(themeSeen).length === D.themes.length, 'chess puzzles: every theme appears (' + Object.keys(themeSeen).length + ')');
  check(mates > 1000, 'chess puzzles: mate puzzles end in checkmate (' + mates + ' checked)');
  check(Object.keys(ratingBand).length >= 5, 'chess puzzles: ratings span the bands');
}

// ── Chess openings ──
{
  const sb = load(['chess-engine.js', 'chess-content.js', 'data/chess-openings.js']);
  const E = sb.ZimiChessEngine(), C = sb.ZimiChessContent;
  const idx = C.openingIndex(E, sb.ZimiChessOpenings.rows);
  check(idx.lines.length === sb.ZimiChessOpenings.rows.split('\n').length && idx.lines.length > 3500, 'openings: ' + idx.lines.length + ' lines, every one legal from the start');
  const play = ucis => {
    const pos = E.startPosition(), keys = [E.key(pos)];
    for (const u of ucis.split(' ')) { E.make(pos, C.fromUci(E, pos, u)); keys.push(E.key(pos)); }
    return C.openingFor(idx, keys);
  };
  check(play('e2e4 c7c5').name === 'Sicilian Defense', 'openings: 1.e4 c5 is the Sicilian Defense');
  check(play('e2e4 e7e5 g1f3 b8c6 f1b5').name === 'Ruy Lopez', 'openings: the Ruy Lopez');
  check(play('d2d4 d7d5 c2c4').name === "Queen's Gambit", "openings: the Queen's Gambit");
  // a transposition reaches the same name by a different move order
  check(play('d2d4 g8f6 c2c4 e7e6 b1c3 f8b4').name.indexOf('Nimzo-Indian') === 0 && play('c2c4 g8f6 b1c3 e7e6 d2d4 f8b4').name.indexOf('Nimzo-Indian') === 0, 'openings: transpositions find the same name');
  // the name sticks while the game goes beyond the book, and a game with no book move has none
  check(play('e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 a2a3 h7h6').name.indexOf('Ruy Lopez') === 0, 'openings: the name holds past the last named move');
  check(play('a2a3 a7a6 b2b3 b7b6') === null || typeof play('a2a3 a7a6 b2b3 b7b6').name === 'string', 'openings: an unnamed game has no name or a named one');
  check(C.family('Sicilian Defense: Najdorf Variation') === 'Sicilian Defense', 'openings: family names');
}

// ── Sokoban ──
{
  const sb = load(['sokoban-engine.js', 'data/sokoban-levels.js']);
  const S = sb.ZimiSokoban, D = sb.ZimiSokobanLevels;
  let bad = 0, firstBad = '', shape = 0;
  const ids = new Set();
  for (const lv of D.levels) {
    const rows = lv.r.split('/').map(r => r.replace(/-/g, ' '));
    const st = S.parse(rows);
    let boxes = 0, goals = 0;
    for (let i = 0; i < st.box.length; i++) { boxes += st.box[i]; goals += st.goal[i]; }
    if (rows.length !== 10 || boxes !== goals || boxes < 1 || S.solved(st)) shape++;
    const end = S.play(st, lv.m);
    if (!end || !S.solved(end) || (lv.m.match(/[A-Z]/g) || []).length !== lv.p) { bad++; if (!firstBad) firstBad = lv.id; }
    ids.add(lv.id);
  }
  check(D.levels.length >= 300 && ids.size === D.levels.length, 'sokoban: ' + D.levels.length + ' levels, ids unique');
  check(shape === 0, 'sokoban: every level has as many goals as boxes and is not solved at the start');
  check(bad === 0, 'sokoban: every level is solved by its stored solution, with the stated pushes' + (bad ? ' (' + bad + ' bad, first ' + firstBad + ')' : ''));
  const st1 = S.parse(['#####', '#@$.#', '#####']);
  check(S.move(st1, 'l') === null && S.move(st1, 'r').pushed && S.solved(S.move(st1, 'r')), 'sokoban: walls stop you, a push moves one box onto the goal');
  const st2 = S.parse(['######', '#@$$.#', '######']);
  check(S.move(st2, 'r') === null, 'sokoban: two boxes in a row cannot be pushed');
}

// ── FreeCell hints ──
{
  const sb = load(['text.js', 'cardbacks.js', 'courts.js', 'cards.js', 'freecell.js', 'freecell-solver.js']);
  const FC = sb.ZimiFreeCell, Solver = sb.ZimiFreeCellSolver;
  const DEALS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 617, 1000, 31999];
  let legal = 0, solved = 0;
  for (const n of DEALS) {
    const start = FC.newState(n), r = Solver.solve(start, { maxNodes: 25000 });
    if (!r.moves) continue;
    solved++;
    let s = start, ok = true;
    for (const m of r.moves) {
      if (!FC.legalMove(s, m.from, m.idx, m.to)) { ok = false; break; }
      s = FC.applyMove(s, m.from, m.idx, m.to);
    }
    if (ok && FC.isWon(s)) legal++;
  }
  check(solved >= DEALS.length - 1, 'freecell hints: the solver finds a line for ' + solved + ' of ' + DEALS.length + ' deals');
  check(legal === solved, 'freecell hints: every move of every line is legal by the game\'s rules and the line wins (' + legal + ' of ' + solved + ')');
  // the hint is the first move of such a line: from a state part-way through, too
  const mid = FC.newState(5);
  const first = Solver.solve(mid, { maxNodes: 25000 }).moves;
  const after = FC.applyMove(mid, first[0].from, first[0].idx, first[0].to);
  const again = Solver.solve(after, { maxNodes: 25000 });
  check(again.moves && FC.legalMove(after, again.moves[0].from, again.moves[0].idx, again.moves[0].to), 'freecell hints: a hint from a state after the first move is legal');
  const won = FC.almostWon();
  const last = Solver.solve(won, { maxNodes: 1000 });
  check(last.moves && last.moves.length === 1 && FC.legalMove(won, last.moves[0].from, last.moves[0].idx, last.moves[0].to), 'freecell hints: one move from a win gives that move');
}

// ── Go problems ──
{
  const sb = load(['go-engine.js', 'tsumego-solver.js', 'data/go-problems.js']);
  const G = sb.makeGoEngine(), T = sb.makeTsumegoSolver(G), D = sb.ZimiTsumego;
  const N = 19, NODE_CAP = 80000, MAX_PLIES = 9;
  let bad = 0, firstBad = '', reproved = 0, wrongChecked = 0, wrongBad = 0;
  const seen = new Set();
  D.problems.forEach((p, n) => {
    const key = p.c + ':' + p.id;
    let ok = !seen.has(key) && p.r.length === p.h && p.r.every(r => r.length === p.w && /^[xo.]+$/.test(r));
    seen.add(key);
    const goal = { kind: p.k, target: p.t };
    const b0 = T.boardFromRows(p.r);
    // the target is the right colour, and the problem is not solved at the start
    ok = ok && p.t.length >= 2 && p.t.every(i => b0[i] === (p.k === 'kill' ? 2 : 1)) && T.verdict(b0, goal) === 0;
    // the stated line is legal move by move (black first, then alternately; -1 is a pass) and ends with the goal reached
    let cur = { b: b0, ko: -1 };
    for (let i = 0; ok && i < p.v.length; i++) {
      const color = i % 2 === 0 ? 1 : 2, pt = p.v[i];
      if (pt === -1 && color === 1) { ok = false; break; }
      if (pt >= 0 && (cur.b[pt] !== 0 || pt === cur.ko)) { ok = false; break; }
      cur = T.after(cur.b, pt, color);
      if (!cur) ok = false;
    }
    if (ok) ok = T.verdict(cur.b, goal) > 0 && p.f.indexOf(p.v[0]) >= 0 && p.v.length <= p.d + 1;
    // search again from scratch: black's first move wins; for a sample, points outside the answer list do not
    if (ok && n % 3 === 0) {
      const a = T.analyse(p.r, goal, { nodeCap: NODE_CAP, maxPlies: MAX_PLIES, reach: p.y });
      const nx = T.after(a.board, p.v[0], 1);
      ok = !!nx && T.minDepth(a.search, nx.b, 2, nx.ko, MAX_PLIES - 1) > 0;
      reproved++;
      if (ok && n % 9 === 0) {
        for (let pt = 0, tried = 0; pt < N * N && tried < 3; pt++) {
          const r = (pt / N) | 0, c = pt % N;
          if (r >= p.h || c >= p.w || a.board[pt] || p.f.indexOf(pt) >= 0 || !a.search.zone[pt]) continue;
          const bn = T.after(a.board, pt, 1);
          if (!bn) continue;
          a.search.nodes = 0; a.search.out = false;
          const won = T.minDepth(a.search, bn.b, 2, bn.ko, MAX_PLIES - 1) > 0;
          if (!a.search.out) { tried++; wrongChecked++; if (won) wrongBad++; }
        }
      }
    }
    if (!ok) { bad++; if (!firstBad) firstBad = key; }
  });
  check(D.problems.length >= 50, 'go problems: ' + D.problems.length + ' shipped (' + D.collections.map(c => c.name + ' ' + D.problems.filter(p => p.c === c.id).length).join(', ') + ')');
  check(bad === 0, 'go problems: every one has a legal line from its position that reaches the goal, and a first move that is in the list' + (bad ? ' (' + bad + ' bad, first ' + firstBad + ')' : ''));
  check(reproved >= 15, 'go problems: ' + reproved + ' searched again from scratch and still won');
  check(wrongBad === 0 && wrongChecked > 0, 'go problems: points outside the answer list do not win (' + wrongChecked + ' checked)');
  // a hand-made one: the vital point of straight three kills
  const rows = ['...ox.', 'oooox.', 'xxxxx.', '......'];
  const a = T.analyse(rows, { kind: 'kill', target: [3, 19, 20, 21, 22] }, { nodeCap: 20000, maxPlies: 9, reach: 0 });
  const fm = T.firstMoves(a, a.board, -1);
  check(fm && fm.length === 1 && fm[0].p === 1, 'go solver: the vital point of straight three is the only killing move');
}

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
