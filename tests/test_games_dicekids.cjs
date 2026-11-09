// Dice and kids' games added in 1.16: Pig, Shut the Box, Ten Thousand, Color Trail, Who Is It. The rules and the computer, with no DOM.
//
// Run: node tests/test_games_dicekids.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
function load(files) {
  const sandbox = {};
  vm.createContext(sandbox);
  ['util.js'].concat(files).forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f }));
  return sandbox;
}

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

// ── Pig ─────────────────────────────────────────────────────────────────────
{
  const P = load(['pig.js']).PigEngine;
  const g = P.createGame(7);
  check(g.goal === 100 && g.scores.join() === '0,0' && g.turn === 0 && !g.over, 'pig: a new game is 0 to 0, first player to roll, goal 100');
  check(P.hold(g) === false, 'pig: nothing to hold before the first roll');

  // Every face comes up; a 1 loses the turn total and passes the turn; anything else adds to it.
  const seen = new Set();
  let busts = 0, adds = 0;
  for (let i = 0; i < 400; i++) {
    const h = P.createGame(1000 + i);
    h.scores = [0, 0];
    const before = h.turn, d = P.roll(h);
    seen.add(d);
    if (d === 1) { busts++; if (!(h.pot === 0 && h.turn === 1 - before && h.scores[before] === 0)) { check(false, 'pig: a 1 loses the total and passes the turn'); break; } }
    else { adds++; if (!(h.pot === d && h.turn === before)) { check(false, 'pig: a roll above 1 adds to the total and keeps the turn'); break; } }
  }
  check(seen.size === 6 && busts > 30 && adds > 250, 'pig: all six faces come up, a 1 about one time in six (' + busts + ' of 400)');

  const h = P.createGame(3);
  h.pot = 17;
  check(P.hold(h) && h.scores[0] === 17 && h.pot === 0 && h.turn === 1, 'pig: hold banks the total and passes the turn');
  const w = P.createGame(5);
  w.scores = [90, 0]; w.pot = 8;
  check(P.hold(w) && w.scores[0] === 98 && !w.over, 'pig: 98 is not yet a win');
  const x = P.createGame(5);
  x.scores = [95, 0]; x.pot = 4;
  let rolled = 0;
  while (!x.over && rolled < 200 && x.turn === 0) { P.roll(x); rolled++; if (x.turn === 1 && !x.over) { x.turn = 0; x.pot = 4; } }
  check(x.over && x.winner === 0 && x.scores[0] >= 100, 'pig: reaching the goal wins at once, without a hold');
  check(P.roll(x) === 0 && P.hold(x) === false, 'pig: a finished game takes no roll and no hold');

  // Put back where it was: the same dice come next.
  const a = P.createGame(99);
  P.roll(a); P.roll(a);
  const b = P.restore(P.snapshot(a));
  const seqA = [], seqB = [];
  for (let i = 0; i < 20; i++) { seqA.push(P.roll(a)); seqB.push(P.roll(b)); }
  check(seqA.join() === seqB.join(), 'pig: a saved game rolls the same dice as the one it was taken from');

  // The computer.
  const d = P.createGame(1);
  check(P.decide(d, 'hard') === 'roll' && P.decide(d, 'easy') === 'roll', 'pig: with nothing in the turn the computer rolls');
  d.pot = 19; check(P.decide(d, 'hard') === 'roll', 'pig: hard keeps going at 19');
  d.pot = 20; check(P.decide(d, 'hard') === 'hold', 'pig: hard holds at 20');
  d.pot = 8; check(P.decide(d, 'easy') === 'hold' && P.decide(d, 'hard') === 'roll', 'pig: easy holds at 8, hard does not');
  d.scores = [70, 30]; d.pot = 28; check(P.decide(d, 'hard') === 'hold', 'pig: hard holds at 28 on 70 when the goal is 30 away');
  d.scores = [80, 30]; d.pot = 15; check(P.decide(d, 'hard') === 'roll' && P.decide(d, 'easy') === 'hold', 'pig: hard keeps rolling 15 into a finish that is 20 away; easy holds');
  d.scores = [40, 80]; d.pot = 25; check(P.decide(d, 'hard') === 'roll', 'pig: hard takes the risk when the other side is about to win');

  function play(levels, seed) {
    const q = P.createGame(seed);
    let n = 0;
    while (!q.over && n++ < 5000) {
      const dec = P.decide(q, levels[q.turn]);
      if (dec === 'hold') P.hold(q); else P.roll(q);
    }
    return q;
  }
  let hardWins = 0, finished = 0, games = 1200;
  for (let i = 0; i < games; i++) {
    const hardFirst = i % 2 === 0, q = play(hardFirst ? ['hard', 'easy'] : ['easy', 'hard'], 5000 + i);
    if (q.over) { finished++; if (q.winner === (hardFirst ? 0 : 1)) hardWins++; }
  }
  check(finished === games, 'pig: every computer game ends');
  check(hardWins > games * 0.55, 'pig: hard beats easy more than half the time, first or second (' + hardWins + ' of ' + games + ')');
}

// ── Shut the Box ────────────────────────────────────────────────────────────
{
  const S = load(['shutthebox.js']).ShutTheBoxEngine;
  const nine = S.moves(S.FULL, 9).map(m => S.tilesOf(m).join('+')).sort();
  check(nine.join(' ') === '1+2+6 1+3+5 1+8 2+3+4 2+7 3+6 4+5 9', 'shut the box: the eight ways to make 9 from a full box (' + nine.join(' ') + ')');
  check(S.moves(S.FULL, 2).length === 1 && S.moves(S.FULL, 1).length === 1 && S.moves(S.FULL, 12).length > 3, 'shut the box: 2 and 1 can only be made one way');
  check(S.diceFor(S.FULL) === 2 && S.diceFor(S.maskOf([1, 2, 3, 4, 5, 6, 7])) === 2 && S.diceFor(S.maskOf([1, 2, 3, 4, 5, 6])) === 1, 'shut the box: one die once 7, 8 and 9 are shut');
  check(S.sumOf(S.FULL) === 45, 'shut the box: a full box is worth 45');

  const g = S.createGame(1, 5);
  check(S.shut(g, [1]) === false, 'shut the box: cannot shut before rolling');
  let tries = 0;
  while (!g.rolled && tries++ < 50) S.roll(g);   // a first roll that fits nothing cannot happen with a full box
  const t = S.total(g);
  check(g.rolled && g.dice.length === 2 && t >= 2 && t <= 12, 'shut the box: two dice are rolled while a high tile is open');
  const pick = S.tilesOf(S.moves(g.open, t)[0]);
  check(S.shut(g, pick.concat(pick[0])) === false, 'shut the box: a tile cannot be counted twice');
  check(S.shut(g, [pick[0] === 1 ? 2 : 1].filter(() => S.sumOf(S.maskOf([pick[0] === 1 ? 2 : 1])) !== t)) === false, 'shut the box: tiles that do not add up are refused');
  check(S.shut(g, pick) === true && g.open === (S.FULL & ~S.maskOf(pick)) && !g.rolled, 'shut the box: tiles that add up are shut');
  check(S.roll(g) === true || g.over, 'shut the box: the next roll is allowed');

  // A game always ends, a blocked roll records the tiles left, and the expected value is what the best play averages.
  function playSolo(level, seed) {
    const q = S.createGame(1, seed);
    let n = 0;
    while (!q.over && n++ < 200) { S.roll(q); if (q.rolled) S.shut(q, S.aiMove(q, level)); }
    return q;
  }
  let sumHard = 0, sumEasy = 0, shutHard = 0, runs = 3000, ended = 0;
  for (let i = 0; i < runs; i++) {
    const h = playSolo('hard', 100 + i), e = playSolo('easy', 100 + i);
    if (h.over && e.over) ended++;
    sumHard += h.results[0]; sumEasy += e.results[0]; if (h.results[0] === 0) shutHard++;
    if (h.results[0] !== S.sumOf(h.open)) { check(false, 'shut the box: the score is the tiles still open'); break; }
  }
  check(ended === runs, 'shut the box: every computer game ends');
  const avgHard = sumHard / runs, avgEasy = sumEasy / runs;
  check(avgHard < avgEasy - 3, 'shut the box: hard leaves fewer tiles open than easy (' + avgHard.toFixed(1) + ' against ' + avgEasy.toFixed(1) + ')');
  check(Math.abs(avgHard - S.EXPECTED[S.FULL]) < 1.2, 'shut the box: hard averages what the table says it should (' + avgHard.toFixed(1) + ' against ' + S.EXPECTED[S.FULL].toFixed(1) + ')');
  check(shutHard > runs * 0.01, 'shut the box: hard shuts the whole box now and then (' + shutHard + ' of ' + runs + ')');

  // Two players: each takes one turn from a full box; the lower total wins.
  const two = S.createGame(2, 8);
  let guard = 0;
  while (!two.over && guard++ < 400) { S.roll(two); if (two.rolled) S.shut(two, S.aiMove(two, 'hard')); }
  check(two.over && two.results[0] !== null && two.results[1] !== null, 'shut the box: two players each have a result when it ends');
  check(two.winner === (two.results[0] === two.results[1] ? -1 : two.results[0] < two.results[1] ? 0 : 1), 'shut the box: the lower total wins');
  const saved = S.createGame(1, 77); S.roll(saved);
  const back = S.restore(S.snapshot(saved));
  check(JSON.stringify(back.dice) === JSON.stringify(saved.dice) && back.open === saved.open && back.rng() === saved.rng(), 'shut the box: a saved game comes back with its dice and its generator');
}

// ── Ten Thousand ────────────────────────────────────────────────────────────
{
  const X = load(['tenthousand.js']).TenThousandEngine;
  const sc = (...v) => X.score(v);
  check(sc(1) === 100 && sc(5) === 50 && sc(1, 5) === 150 && sc(1, 1) === 200 && sc(5, 5) === 100, 'ten thousand: a lone 1 is 100 and a lone 5 is 50');
  check(sc(1, 1, 1) === 1000 && sc(2, 2, 2) === 200 && sc(3, 3, 3) === 300 && sc(4, 4, 4) === 400 && sc(5, 5, 5) === 500 && sc(6, 6, 6) === 600, 'ten thousand: three of a face');
  check(sc(1, 1, 1, 1) === 2000 && sc(6, 6, 6, 6) === 1200 && sc(2, 2, 2, 2, 2) === 800 && sc(4, 4, 4, 4, 4, 4) === 3200, 'ten thousand: each die more than three doubles the set');
  check(sc(1, 1, 1, 5) === 1050 && sc(5, 5, 5, 1) === 600 && sc(1, 1, 1, 1, 5) === 2050, 'ten thousand: extra 1s and 5s count on top');
  check(sc(1, 2, 3, 4, 5, 6) === 1500 && sc(2, 2, 3, 3, 4, 4) === 1500 && sc(1, 1, 5, 5, 6, 6) === 1500, 'ten thousand: a straight and three pairs are 1500');
  check(sc(2) === 0 && sc(1, 2) === 0 && sc(2, 2) === 0 && sc(3, 3, 3, 4) === 0 && sc() === 0, 'ten thousand: a selection with a die that does not score scores nothing');
  check(X.scores([2, 3, 4, 6, 6, 2]) === false && X.scores([2, 3, 4, 6, 6, 1]) === true && X.scores([4, 4, 4, 2, 3, 6]) === true && X.scores([2, 2, 3, 3, 4, 4]) === true, 'ten thousand: a roll scores if any die or set counts');
  check(X.selections([1, 5, 2]).length === 3 && X.selections([2, 3]).length === 0, 'ten thousand: the ways to set dice aside (1, 5 and both)');

  const t = X.oddsTable();
  const near = (a, b) => Math.abs(a - b) < 0.002;
  check(near(t[1].dead, 4 / 6) && near(t[2].dead, 16 / 36) && near(t[3].dead, 60 / 216) && near(t[6].dead, 1 / 46656 * 1080), 'ten thousand: the odds of a farkle are 67%, 44%, 28% and 2.3% for 1, 2, 3 and 6 dice');

  // A turn.
  const g = X.createGame(11, 10000);
  check(X.keep(g, [0], false) === false, 'ten thousand: nothing to set aside before the roll');
  let guard = 0;
  while (g.phase !== 'pick' && guard++ < 50) { if (g.turn !== 0) { g.turn = 0; } X.roll(g); }
  const sel = X.selections(g.dice).sort((a, b) => b.score - a.score)[0];
  check(g.phase === 'pick' && g.dice.every(v => v >= 1 && v <= 6), 'ten thousand: a scoring roll waits for the player to set dice aside');
  check(X.pickScore(g, sel.idx) === sel.score && X.pickScore(g, []) === 0, 'ten thousand: a pick is worth what its dice score');
  const nonScoring = g.dice.map((v, i) => i).filter(i => !X.selections(g.dice).some(s2 => s2.idx.length === 1 && s2.idx[0] === i) && X.selections(g.dice).every(s2 => s2.idx.indexOf(i) < 0));
  if (nonScoring.length) check(X.keep(g, sel.idx.concat(nonScoring[0]), true) === false && g.pot === 0, 'ten thousand: a die that does not score cannot be set aside');
  const turn0 = g.turn;
  check(X.keep(g, sel.idx, true) === true && g.scores[turn0] === sel.score && g.turn === 1 - turn0 && g.pot === 0, 'ten thousand: banking adds the pick to the score and passes the turn');

  // Keep rolling: dice set aside stay out; all six scored means roll all six again.
  const h = X.createGame(3, 10000);
  h.phase = 'pick'; h.dice = [1, 1, 1, 5, 5, 5]; h.locked = [false, false, false, false, false, false];
  check(X.keep(h, [0, 1, 2, 3, 4, 5], false) && h.pot === 1500 && h.phase === 'roll' && X.free(h).length === 0, 'ten thousand: six dice that all score are 1500 and every die is set aside');
  X.roll(h);
  check(h.farkle || (h.phase === 'pick' && X.free(h).length === 6), 'ten thousand: all six scored, so all six are rolled again (hot dice)');
  const k = X.createGame(4, 10000);
  k.phase = 'pick'; k.dice = [1, 2, 3, 3, 4, 6]; k.locked = [false, false, false, false, false, false];
  X.keep(k, [0], false);
  X.roll(k);
  check(k.farkle || (k.locked[0] === true && X.free(k).length === 5), 'ten thousand: a die set aside stays out of the next roll');

  // A farkle loses the turn's points.
  let farkles = 0, total = 400;
  for (let i = 0; i < total; i++) {
    const f = X.createGame(i * 7919 + 13, 10000);
    f.pot = 350; X.roll(f);
    if (f.farkle) { farkles++; if (!(f.pot === 0 && f.scores[0] === 0 && f.turn === 1)) { check(false, 'ten thousand: a farkle loses the turn and passes it'); break; } }
  }
  check(farkles > 2 && farkles < 25, 'ten thousand: six dice farkle now and then, not often (' + farkles + ' of ' + total + ')');

  // The last turn: when one side reaches the goal the other gets one more.
  const e = X.createGame(5, 1000);
  e.scores = [900, 700]; e.phase = 'pick'; e.dice = [1, 1, 1, 2, 3, 4]; e.locked = [false, false, false, false, false, false];
  X.keep(e, [0, 1, 2], true);
  check(!e.over && e.final === 0 && e.turn === 1 && e.scores[0] === 1900, 'ten thousand: reaching the goal gives the other side a last turn');
  e.phase = 'pick'; e.dice = [5, 2, 3, 3, 4, 6]; X.keep(e, [0], true);
  check(e.over && e.winner === 0, 'ten thousand: the first side to the goal wins if the last turn falls short');
  const e2 = X.createGame(5, 1000);
  e2.scores = [1000, 800]; e2.final = 0; e2.turn = 1; e2.phase = 'pick'; e2.dice = [1, 1, 1, 1, 2, 3]; e2.locked = [false, false, false, false, false, false];
  X.keep(e2, [0, 1, 2, 3], true);
  check(e2.over && e2.winner === 1 && e2.scores[1] === 2800, 'ten thousand: a bigger last turn wins');
  check(X.roll(e2) === false, 'ten thousand: a finished game takes no roll');

  // The computer.
  const a = X.createGame(21, 10000);
  a.phase = 'pick'; a.dice = [1, 2, 3, 4, 4, 6]; a.pot = 0;
  let p = X.plan(a, 'hard');
  check(p.idx.length === 1 && p.idx[0] === 0 && p.bank === false, 'ten thousand: hard sets aside the lone 1 and rolls five dice');
  a.pot = 650; a.dice = [5, 2, 3, 4, 4, 6]; a.locked = [false, false, true, true, true, true];
  p = X.plan(a, 'hard');
  check(p.bank === true, 'ten thousand: with one die left after the pick and 700 in hand, hard banks');
  a.pot = 0; a.locked = [false, false, false, false, false, false]; a.dice = [1, 1, 1, 4, 5, 6];
  p = X.plan(a, 'hard');
  check(p.idx.indexOf(0) >= 0 && p.idx.indexOf(1) >= 0 && p.idx.indexOf(2) >= 0, 'ten thousand: hard takes three 1s');
  a.scores = [9000, 9800]; a.pot = 0; a.final = 1; a.turn = 0; a.dice = [1, 4, 6, 4, 2, 3]; a.locked = [false, false, false, false, false, false];
  p = X.plan(a, 'hard');
  check(p.bank === false, 'ten thousand: on the last turn, behind, hard does not bank a losing total');

  function playMatch(levels, seed, goal) {
    const q = X.createGame(seed, goal);
    let n = 0;
    while (!q.over && n++ < 4000) {
      if (q.phase === 'roll') { X.roll(q); continue; }
      const pl = X.plan(q, levels[q.turn]);
      if (!X.keep(q, pl.idx, pl.bank)) throw new Error('the computer made a move that does not score');
    }
    return q;
  }
  let hardWins = 0, finished = 0, matches = 300;
  for (let i = 0; i < matches; i++) {
    const hardFirst = i % 2 === 0, q = playMatch(hardFirst ? ['hard', 'easy'] : ['easy', 'hard'], 7000 + i, 5000);
    if (q.over) { finished++; if (q.winner === (hardFirst ? 0 : 1)) hardWins++; }
  }
  check(finished === matches, 'ten thousand: every computer game ends');
  check(hardWins > matches * 0.55, 'ten thousand: hard beats easy over half the time, first or second (' + hardWins + ' of ' + matches + ')');
  const saved = X.createGame(42, 5000); X.roll(saved);
  const back = X.restore(X.snapshot(saved));
  check(JSON.stringify(back.dice) === JSON.stringify(saved.dice) && back.rng() === saved.rng(), 'ten thousand: a saved game comes back with its dice and its generator');
}

// END
if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
