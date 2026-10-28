// Dice, arcade and kids games: the rules, with no DOM. Yacht scoring, Liar's Dice bids, Fleet,
// Code Breaker feedback, Pinball / Rocks / Lander physics, Tic-Tac-Toe perfect play, and the rest.
//
// Run: node tests/test_games_play2.cjs   (exit 0 = pass)

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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Yacht ───────────────────────────────────────────────────────────────────
{
  const Y = load(['playkit.js', 'yacht.js']).YachtEngine;
  const s = (cat, d) => Y.score(cat, d);
  check(Y.CATS.length === 13, 'yacht: thirteen rows');
  check(s('ones', [1, 1, 2, 3, 1]) === 3 && s('twos', [2, 2, 2, 2, 2]) === 10 && s('threes', [3, 1, 3, 4, 5]) === 6, 'yacht: upper rows count their face');
  check(s('fours', [4, 4, 4, 1, 2]) === 12 && s('fives', [5, 1, 2, 3, 4]) === 5 && s('sixes', [6, 6, 1, 2, 3]) === 12, 'yacht: fours, fives, sixes');
  check(s('three', [3, 3, 3, 1, 2]) === 12 && s('three', [3, 3, 4, 1, 2]) === 0 && s('three', [6, 6, 6, 6, 6]) === 30, 'yacht: three of a kind sums every die, or nothing');
  check(s('four', [2, 2, 2, 2, 5]) === 13 && s('four', [2, 2, 2, 5, 5]) === 0 && s('four', [4, 4, 4, 4, 4]) === 20, 'yacht: four of a kind sums every die, or nothing');
  check(s('house', [2, 2, 3, 3, 3]) === 13 && s('house', [2, 2, 2, 2, 3]) === 0 && s('house', [4, 4, 4, 4, 4]) === 0 && s('house', [1, 2, 3, 3, 3]) === 0, 'yacht: full house is three and two, not five alike');
  check(s('little', [3, 1, 2, 5, 4]) === 30 && s('little', [2, 3, 4, 5, 6]) === 0 && s('little', [1, 2, 3, 4, 4]) === 0, 'yacht: little straight is 1 to 5');
  check(s('big', [6, 5, 4, 3, 2]) === 30 && s('big', [1, 2, 3, 4, 5]) === 0, 'yacht: big straight is 2 to 6');
  check(s('choice', [1, 2, 3, 4, 6]) === 16, 'yacht: choice is the sum');
  check(s('yacht', [5, 5, 5, 5, 5]) === 50 && s('yacht', [5, 5, 5, 5, 4]) === 0, 'yacht: five alike is 50');

  const card = { ones: 3, twos: 6, threes: 9, fours: 12, fives: 15, sixes: 18 };
  check(Y.upper(card) === 63 && Y.bonus(card) === 35 && Y.total(card) === 98, 'yacht: 63 in the top six earns 35');
  card.sixes = 12;
  check(Y.upper(card) === 57 && Y.bonus(card) === 0 && Y.total(card) === 57, 'yacht: 57 earns no bonus');

  // A whole game plays to the end with each row used once; held dice stay put.
  const g = Y.createGame(1, 5);
  let turns = 0;
  check(Y.choose(g, 'ones') === false, 'yacht: cannot score before rolling');
  while (!g.over && turns < 200) {
    Y.roll(g);
    const keep = g.dice.slice();
    if (turns === 0) { Y.toggleHold(g, 0); Y.roll(g); check(g.dice[0] === keep[0], 'yacht: a held die keeps its value'); }
    const open = Y.openCats(g.players[g.turn].card);
    Y.choose(g, Y.bestRow(g.dice, open));
    turns++;
  }
  check(g.over && turns === 26 && g.players.every(p => Object.keys(p.card).length === 13), 'yacht: two players finish in 26 turns, 13 rows each');
  const g2 = Y.createGame(0, 9); Y.roll(g2); Y.choose(g2, 'choice');
  g2.dice = [1, 1, 1, 1, 1]; g2.rollsLeft = 2;
  check(Y.choose(g2, 'choice') === false, 'yacht: a row is used once');
  const mask = Y.bestHold([6, 6, 6, 6, 2], Y.openCats({}));
  check(mask.slice(0, 4).every(Boolean) && !mask[4], 'yacht: the computer keeps four sixes and rerolls the odd die');
}

// ── Liar's Dice ─────────────────────────────────────────────────────────────
{
  const L = load(['playkit.js', 'liarsdice.js']).LiarsDiceEngine;
  const legal = (p, q, f, t) => L.isLegal(p, q, f, t);
  check(legal(null, 1, 1, 10) && legal(null, 3, 6, 10) && !legal(null, 0, 3, 10) && !legal(null, 11, 3, 10) && !legal(null, 2, 7, 10), 'liars dice: an opening bid is any quantity on the table and any face');
  check(legal({ q: 3, f: 4 }, 4, 2, 10) && legal({ q: 3, f: 4 }, 3, 5, 10) && !legal({ q: 3, f: 4 }, 3, 4, 10) && !legal({ q: 3, f: 4 }, 3, 3, 10) && !legal({ q: 3, f: 4 }, 2, 6, 10), 'liars dice: raise the quantity, or the face at the same quantity');
  check(legal({ q: 5, f: 3 }, 3, 1, 12) && !legal({ q: 5, f: 3 }, 2, 1, 12), 'liars dice: a bid on ones needs half the quantity, rounded up');
  check(legal({ q: 3, f: 1 }, 7, 2, 12) && !legal({ q: 3, f: 1 }, 6, 2, 12) && legal({ q: 3, f: 1 }, 4, 1, 12) && !legal({ q: 3, f: 1 }, 3, 1, 12), 'liars dice: off ones takes twice the quantity plus one; ones over ones just goes up');
  check(L.minQty({ q: 5, f: 3 }, 1, 12) === 3 && L.minQty({ q: 3, f: 1 }, 6, 12) === 7 && L.minQty({ q: 3, f: 1 }, 6, 6) === 0, 'liars dice: minQty agrees with the rules');
  check(L.legalBids({ q: 4, f: 6 }, 8).every(b => legal({ q: 4, f: 6 }, b.q, b.f, 8)) && L.legalBids({ q: 4, f: 6 }, 8).length > 0, 'liars dice: every listed raise is legal');
  check(L.countFace([1, 1, 3, 4, 3], 3) === 4 && L.countFace([1, 1, 3, 4, 3], 1) === 2 && L.countFace([2, 2, 5, 6, 1], 4) === 1, 'liars dice: ones are wild except when bid on');

  // A challenge: the bid stands when there are enough dice, and the challenger loses one; otherwise the bidder does.
  const mk = (a, b, bid) => { const g = L.createGame(2, 3); g.players[0].dice = a; g.players[1].dice = b; g.players[0].n = a.length; g.players[1].n = b.length; g.bid = bid; g.turn = 0; return g; };
  let g = mk([2, 2, 3, 1, 6], [2, 5, 5, 4, 1], { q: 5, f: 2, by: 1 });
  let r = L.act(g, { type: 'challenge' });
  check(r && r.actual === 5 && r.bidTrue && r.loser === 0 && g.players[0].n === 4 && g.players[1].n === 5 && g.turn === 0 && g.bid === null, 'liars dice: a true bid costs the challenger a die, and the loser opens');
  g = mk([2, 2, 3, 1, 6], [2, 5, 5, 4, 1], { q: 6, f: 2, by: 1 });
  r = L.act(g, { type: 'challenge' });
  check(r && r.actual === 5 && !r.bidTrue && r.loser === 1 && g.players[1].n === 4 && g.turn === 1, 'liars dice: a false bid costs the bidder a die');
  check(L.act(mk([1, 2], [3, 4], null), { type: 'challenge' }) === false, 'liars dice: no challenge with nothing bid');
  g = mk([2], [3], { q: 2, f: 5, by: 0 }); g.turn = 1;
  r = L.act(g, { type: 'challenge' });
  check(g.over && g.winner === 1 && g.players[0].n === 0, 'liars dice: the last player with dice wins');
  g = mk([2, 2], [3, 3], { q: 2, f: 4, by: 0 }); g.turn = 1;
  check(L.act(g, { type: 'bid', q: 2, f: 4 }) === false && L.act(g, { type: 'bid', q: 2, f: 5 }) === true && g.turn === 0 && g.bid.by === 1, 'liars dice: an illegal bid is refused, a legal one passes the turn');

  // Computers only ever make legal moves, and a table of them plays to a winner.
  let illegal = 0, finished = 0, bids = 0, calls = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const t = L.createGame(2 + (seed % 5), seed);
    let guard = 0;
    while (!t.over && guard++ < 2000) {
      const m = L.aiMove(t);
      if (m.type === 'bid') { bids++; if (!L.isLegal(t.bid, m.q, m.f, L.totalDice(t))) { illegal++; break; } }
      else { calls++; if (!t.bid) { illegal++; break; } }
      const res = L.act(t, m);
      if (!res) { illegal++; break; }
      if (m.type === 'challenge') L.nextRound(t);
    }
    if (t.over) finished++;
  }
  check(illegal === 0 && finished === 40, "liars dice: forty computer-only games, " + bids + ' bids and ' + calls + ' calls, none illegal, all finished');
  check(calls > 100 && bids > 300, 'liars dice: the computers both bid and call');
  const strong = L.chance([5, 5, 5, 5, 5], 10, 8, 5), weak = L.chance([2, 3, 4, 6, 6], 10, 8, 5);
  check(strong > weak && L.chance([5, 5, 5], 3, 4, 5) === 0 && L.chance([5, 5, 5], 3, 3, 5) === 1, 'liars dice: the odds the computer works from are sane');
}

// ── Fleet ───────────────────────────────────────────────────────────────────
{
  const F = load(['playkit.js', 'fleet.js']).FleetEngine;
  const b = F.createBoard();
  check(F.addShip(b, 'Carrier', 5, 0, 0, true) && b.ships[0].cells.length === 5, 'fleet: a ship is placed across');
  check(F.addShip(b, 'X', 3, 3, 0, true) === null && F.addShip(b, 'X', 3, 8, 3, true) === null && F.addShip(b, 'X', 3, 0, 9, false) === null && F.addShip(b, 'X', 3, -1, 2, true) === null, 'fleet: no overlap, nothing off the edge');
  check(F.addShip(b, 'Cruiser', 4, 2, 0, false) === null && F.addShip(b, 'Cruiser', 4, 5, 0, false) !== null, 'fleet: ships may not cross');

  // Firing: miss, hit, sunk, repeat, and the win.
  const t = F.createBoard(); F.addShip(t, 'Skiff', 2, 3, 3, true); F.addShip(t, 'Sloop', 3, 0, 9, true);
  check(F.fire(t, 0, 0).result === 'miss' && t.shots[0][0] === F.MISS, 'fleet: a shot in open water is a miss');
  check(F.fire(t, 0, 0) === null, 'fleet: the same square twice is refused');
  const h = F.fire(t, 3, 3);
  check(h.result === 'hit' && h.ship.name === 'Skiff' && !h.win && t.shots[3][3] === F.HIT, 'fleet: a hit');
  const sk = F.fire(t, 4, 3);
  check(sk.result === 'sunk' && sk.ship.name === 'Skiff' && !sk.win && t.shots[3][3] === F.SUNK && t.shots[3][4] === F.SUNK, 'fleet: the last hit sinks it and marks every square');
  F.fire(t, 0, 9); F.fire(t, 1, 9);
  const last = F.fire(t, 2, 9);
  check(last.result === 'sunk' && last.win, 'fleet: sinking the last ship wins');
  check(F.remainingLens(t).length === 0, 'fleet: nothing left afloat');

  // Random fleets are legal: five ships, right lengths, no overlap, inside the grid.
  let legalFleets = true;
  for (let s = 1; s <= 200; s++) {
    const rf = F.randomFleet(F.mulberry(s)), seen = new Set();
    legalFleets = legalFleets && rf.ships.length === 5 && rf.ships.map(x => x.len).sort().join() === '2,3,3,4,5';
    rf.ships.forEach(sh => sh.cells.forEach(c => { const k = c[0] + ',' + c[1]; if (seen.has(k) || c[0] < 0 || c[1] < 0 || c[0] > 9 || c[1] > 9) legalFleets = false; seen.add(k); }));
  }
  check(legalFleets, 'fleet: 200 random fleets are all legal');

  // The computer hunts: after a hit it fires next to it, and it clears random fleets in well under 100 shots.
  const sh = F.createBoard().shots; sh[4][4] = F.HIT;
  const pick = F.aiShot(sh, [5, 4, 3, 3, 2], F.mulberry(1));
  check(Math.abs(pick[0] - 4) + Math.abs(pick[1] - 4) === 1, 'fleet: the computer fires beside a standing hit');
  const sh2 = F.createBoard().shots; sh2[4][4] = F.HIT; sh2[4][5] = F.HIT;
  const pk2 = F.aiShot(sh2, [5, 4, 3, 3, 2], F.mulberry(2));
  check(pk2[1] === 4 && (pk2[0] === 3 || pk2[0] === 6), 'fleet: two hits in a row, it follows the line');
  let totalShots = 0, worst = 0, ok = true;
  for (let s = 1; s <= 60; s++) {
    const rng = F.mulberry(s * 7), board = F.randomFleet(rng); let n = 0, win = false;
    while (!win && n < 100) { const p = F.aiShot(board.shots, F.remainingLens(board), rng); if (!p) { ok = false; break; } win = F.fire(board, p[0], p[1]).win; n++; }
    ok = ok && win; totalShots += n; worst = Math.max(worst, n);
  }
  check(ok && totalShots / 60 < 65, 'fleet: the computer clears 60 random fleets, averaging ' + (totalShots / 60).toFixed(1) + ' shots (worst ' + worst + ')');
}

// ── Code Breaker ────────────────────────────────────────────────────────────
{
  const C = load(['playkit.js', 'codebreaker.js']).CodeBreakerEngine;
  const fb = (c, g) => { const r = C.feedback(c, g); return r.exact + '/' + r.colour; };
  check(fb([0, 1, 2, 3], [0, 1, 2, 3]) === '4/0', 'code breaker: all right');
  check(fb([0, 1, 2, 3], [3, 2, 1, 0]) === '0/4', 'code breaker: all right colours, all wrong places');
  check(fb([0, 1, 2, 3], [4, 4, 5, 5]) === '0/0', 'code breaker: nothing');
  check(fb([0, 0, 1, 1], [0, 1, 0, 1]) === '2/2', 'code breaker: pairs of repeats');
  check(fb([0, 0, 1, 2], [0, 3, 0, 0]) === '1/1', 'code breaker: a repeated guess colour only counts as often as the code has it');
  check(fb([0, 1, 2, 3], [0, 0, 0, 0]) === '1/0', 'code breaker: four of one colour against one in the code');
  check(fb([1, 1, 1, 2], [1, 2, 2, 2]) === '2/0', 'code breaker: exact matches are taken before colour matches');
  check(fb([2, 2, 3, 3], [3, 3, 2, 2]) === '0/4', 'code breaker: swapped pairs');
  check(fb([5, 0, 5, 1], [0, 5, 5, 5]) === '1/2', 'code breaker: a surplus guess peg is not counted twice');
  // symmetry: feedback of (a, b) equals feedback of (b, a)
  let sym = true;
  for (let i = 0; i < 300; i++) { const r = C.makeCode(Math.random, true), s = C.makeCode(Math.random, true); sym = sym && fb(r, s) === fb(s, r); }
  check(sym, 'code breaker: the score is the same either way round');
  let uniq = true, rng = () => Math.random();
  for (let i = 0; i < 200; i++) { const c = C.makeCode(rng, false); uniq = uniq && new Set(c).size === 4 && c.every(x => x >= 0 && x < 6); }
  check(uniq, 'code breaker: codes without repeats have four different colours');
  check(C.isValid([0, 1, 2, 3], false) && !C.isValid([0, 0, 2, 3], false) && C.isValid([0, 0, 2, 3], true) && !C.isValid([0, 1, 2], true) && !C.isValid([0, 1, 2, 6], true), 'code breaker: guess validity');
}

// ── Pinball ─────────────────────────────────────────────────────────────────
{
  const P = load(['playkit.js', 'pinball.js']).PinballEngine;
  const DT = 1 / 60;
  const run = (st, secs, each) => { for (let i = 0; i < Math.round(secs / DT); i++) { P.step(st, DT); if (each) each(st); } };

  // A ball dropped on a flat wall bounces back up, a little slower.
  const ball = { x: 100, y: 99, vx: 0, vy: 300 };
  const c = P.contact(ball, 0, 100, 200, 100, 0);
  const hit = c && P.bounce(ball, c.nx, c.ny, 0.45, 0, 0);
  check(c && c.ny === -1 && ball.y <= 93.0001 && hit === 300 && Math.abs(ball.vy + 135) < 1e-9, 'pinball: a ball dropped on a wall is pushed out and bounces up slower');
  const slow = { x: 100, y: 93.5, vx: 0, vy: 20 };
  P.contact(slow, 0, 100, 200, 100, 0); P.bounce(slow, 0, -1, 0.45, 0, 0);
  check(Math.abs(slow.vy) < 1e-9, 'pinball: a slow touch does not bounce, so a ball can roll');

  // Gravity pulls a ball down the left inlane guide toward the flipper.
  let st = P.createState(); st.balls = [{ x: 30, y: 480, vx: 0, vy: 0, slow: 0 }]; st.status = 'play'; st.saver = 0;
  run(st, 0.9);
  check(st.balls[0] && st.balls[0].x > 60 && st.balls[0].y > 530, 'pinball: a ball rolls down the inlane guide');

  // The left flipper: a ball on it at rest stays; raised, it throws the ball up the table.
  st = P.createState(); st.balls = [{ x: 133, y: 574, vx: 0, vy: 0, slow: 0 }]; st.status = 'play'; st.saver = 0;
  run(st, 0.35);
  const settled = st.balls[0];
  check(settled && settled.y > 560 && settled.y < 600 && Math.abs(settled.vy) < 200, 'pinball: a ball comes to rest on a resting flipper');
  st.balls[0].vx = 0; st.balls[0].vy = 0; st.balls[0].x = 138; st.balls[0].y = 580; st.flippers[0].on = true;
  let upBest = 0, topY = 999;
  run(st, 0.5, s => { const b = s.balls[0]; if (b) { upBest = Math.max(upBest, -b.vy); topY = Math.min(topY, b.y); } });
  check(upBest > 600, 'pinball: a raised flipper throws the ball upward (' + Math.round(upBest) + ' px/s)');
  check(topY < 300, 'pinball: a flipper shot climbs the table (reached y=' + Math.round(topY) + ')');

  // The right flipper mirrors it.
  st = P.createState(); st.balls = [{ x: 194, y: 580, vx: 0, vy: 0, slow: 0 }]; st.status = 'play'; st.saver = 0; st.flippers[1].on = true;
  upBest = 0; run(st, 0.5, s => { const b = s.balls[0]; if (b) upBest = Math.max(upBest, -b.vy); });
  check(upBest > 600, 'pinball: the right flipper works the same way');

  // A pop bumper kicks the ball away and scores.
  st = P.createState(); st.balls = [{ x: 118, y: 292, vx: 0, vy: -420, slow: 0 }]; st.status = 'play'; st.saver = 0;
  let bump = false, away = 0;
  run(st, 0.4, s => { if (!bump && s.score >= 100) { bump = true; const b = s.balls[0]; away = Math.sqrt(b.vx * b.vx + b.vy * b.vy); } });
  check(bump && away >= P.BUMPER_KICK - 5 && st.score >= 100, 'pinball: a bumper scores 100 and kicks the ball away (' + Math.round(away) + ' px/s)');

  // A ball falling out the bottom costs a ball; the saver gives one back for free.
  st = P.createState(); st.balls = [{ x: 166, y: 700, vx: 0, vy: 100, slow: 0 }]; st.status = 'play'; st.saver = 0;
  P.step(st, DT);
  check(st.lives === 2 && st.status === 'ready' && st.balls.length === 1 && P.inLane(st.balls[0]), 'pinball: a drained ball costs a life and a new one waits in the lane');
  st = P.createState(); st.balls = [{ x: 166, y: 700, vx: 0, vy: 100, slow: 0 }]; st.status = 'play'; st.saver = 3;
  P.step(st, DT);
  check(st.lives === 3 && st.status === 'ready', 'pinball: the ball saver returns the ball for free');
  st = P.createState(); st.lives = 1; st.balls = [{ x: 166, y: 700, vx: 0, vy: 100, slow: 0 }]; st.status = 'play'; st.saver = 0;
  P.step(st, DT);
  check(st.status === 'over' && st.events.some(e => e.name === 'over'), 'pinball: the last ball ends the game');

  // Nothing tunnels through a wall at top speed.
  st = P.createState(); st.balls = [{ x: 100, y: 300, vx: -P.MAX_SPEED, vy: 0, slow: 0 }]; st.status = 'play'; st.saver = 0;
  let minX = 999; run(st, 1, s => { if (s.balls[0]) minX = Math.min(minX, s.balls[0].x); });
  check(minX > 14, 'pinball: a ball at top speed does not pass the left wall (closest x=' + minX.toFixed(1) + ')');
  st = P.createState(); st.balls = [{ x: 330, y: 400, vx: P.MAX_SPEED, vy: 0, slow: 0 }]; st.status = 'play'; st.saver = 0;
  let maxX = 0; run(st, 1, s => { if (s.balls[0]) maxX = Math.max(maxX, s.balls[0].x); });
  check(maxX < 346, 'pinball: nor the right wall');

  // The plunger: a full shot climbs the lane, goes over the top and lands on the table; a feeble one falls back.
  st = P.createState(); st.charging = true; run(st, 1);
  check(st.charge === 1 && P.launch(st) && st.status === 'play', 'pinball: a full plunger launches');
  let inField = false, escaped = false;
  run(st, 4, s => { const b = s.balls[0]; if (b) { if (b.x < 316 && b.y < 330) inField = true; if (b.x < 0 || b.x > 360 || b.y < 0) escaped = true; } });
  check(inField && !escaped, 'pinball: the launch goes over the top onto the table and stays on it');
  st = P.createState(); st.charging = true; run(st, 0.25);
  P.launch(st);
  let reached = 999; run(st, 3, s => { const b = s.balls[0]; if (b) reached = Math.min(reached, b.y); });
  check(reached > 200 && st.status === 'ready' && st.balls.length === 1 && P.inLane(st.balls[0]), 'pinball: a weak shot falls back into the lane and can be shot again');
  st = P.createState(); st.charging = true; run(st, 0.55); P.launch(st);
  inField = false; run(st, 4, s => { const b = s.balls[0]; if (b && b.x < 316 && b.y < 330) inField = true; });
  check(inField, 'pinball: a half-strength shot still makes it onto the table');

  // Rollover lanes raise the multiplier; a full bank of targets starts multiball.
  st = P.createState(); st.status = 'play'; st.saver = 99;
  P.LANES.forEach(l => { st.balls = [{ x: l.x, y: l.y, vx: 0, vy: 0, slow: 0 }]; P.step(st, DT); });
  check(st.mult === 2 && st.lanes.every(v => v === 0) && st.score >= P.POINTS.lane * 3 + P.POINTS.laneSet, 'pinball: three lanes raise the multiplier');
  st = P.createState(); st.status = 'play'; st.saver = 99; st.targets = [1, 1, 0, 0, 0, 0];
  st.balls = [{ x: 30, y: 347, vx: -10, vy: 260, slow: 0 }];
  run(st, 0.3);
  check(st.balls.length === 3 && st.targets.slice(0, 3).every(v => v === 0), 'pinball: the third target of a bank starts multiball');
  // With several balls in play, losing one does not cost a life.
  st.balls[0].y = 700; P.step(st, DT);
  check(st.lives === 3 && st.balls.length === 2, 'pinball: a multiball loss does not cost a life');
  // Walls close the table: no gap anywhere except the drain.
  check(P.WALLS.length > 40, 'pinball: the table has its walls');
}

// ── Rocks ───────────────────────────────────────────────────────────────────
{
  const R = load(['playkit.js', 'rocks.js']).RocksEngine;
  const DT = 1 / 60;
  const calm = (seed) => { const st = R.createState(seed); st.rocks = []; st.saucerIn = 1e9; st.ship.inv = 0; return st; };
  const put = (st, o) => Object.assign({ x: 0, y: 0, vx: 0, vy: 0 }, o);

  check(R.wrap(-5) === R.SIZE - 5 && R.wrap(R.SIZE + 3) === 3 && R.wrap(200) === 200, 'rocks: the field wraps');
  check(Math.abs(R.torusDist(5, 5, R.SIZE - 5, R.SIZE - 5) - Math.sqrt(200)) < 1e-9, 'rocks: distance goes the short way round the edge');

  // A ship drifting off the right edge comes back on the left.
  let st = calm(1); st.ship.x = R.SIZE - 2; st.ship.vx = 100; st.ship.vy = 0;
  R.step(st, 0.1, {});
  check(st.ship.x < 20 && st.ship.x >= 0, 'rocks: a ship wraps through the edge');
  // Thrust points where the nose points; turning turns the nose.
  st = calm(2); R.step(st, 0.5, { thrust: true });
  check(st.ship.vy < -50 && Math.abs(st.ship.vx) < 1e-9, 'rocks: thrust goes the way the nose points (up at first)');
  st = calm(3); R.step(st, 0.25, { right: true });
  check(Math.abs(st.ship.a - R.TURN * 0.25) < 1e-9, 'rocks: turning right turns the nose clockwise');

  // Splitting: a big rock gives two medium ones, a medium two small, a small none.
  const rng = R.mulberry(5);
  const big = R.makeRock(rng, 3, 100, 100, 30, 0);
  const parts = R.splitRock(big, rng);
  check(parts.length === 2 && parts.every(p => p.size === 2 && p.x === 100 && p.y === 100), 'rocks: a big rock splits into two medium ones');
  check(R.splitRock(parts[0], rng).length === 2 && R.splitRock(parts[0], rng).every(p => p.size === 1) && R.splitRock(R.splitRock(parts[0], rng)[0], rng).length === 0, 'rocks: medium into two small, small into nothing');
  check(parts[0].vx !== parts[1].vx || parts[0].vy !== parts[1].vy, 'rocks: the pieces leave in different directions');

  // A bullet kills a rock: it splits, and the score is the rock\'s.
  st = calm(4); st.ship.x = 50; st.ship.y = 350; st.ship.a = Math.PI / 2; // nose points right
  st.rocks = [R.makeRock(R.mulberry(9), 3, 130, 350, 0, 0)];
  R.fire(st);
  check(st.bullets.length === 1 && st.bullets[0].vx > 400, 'rocks: the ship fires from its nose');
  for (let i = 0; i < 30 && st.score === 0; i++) R.step(st, DT, {});
  check(st.score === 20 && st.rocks.length === 2 && st.rocks.every(r => r.size === 2) && st.bullets.length === 0, 'rocks: a hit splits a big rock and scores 20');
  // At most four bullets of your own.
  st = calm(5); st.ship.a = 0;
  let fired = 0; for (let i = 0; i < 20; i++) { st.ship.cool = 0; if (R.fire(st)) fired++; }
  check(fired === R.MAX_BULLETS, 'rocks: four shots on the screen at a time');
  // Bullets expire.
  st = calm(6); R.fire(st); for (let i = 0; i < 80; i++) R.step(st, DT, {});
  check(st.bullets.length === 0, 'rocks: a bullet runs out');

  // A rock hitting the ship costs a life; a ship that has just arrived is safe; the ship comes back.
  st = calm(7); st.rocks = [put(st, { x: R.SIZE / 2, y: R.SIZE / 2, vx: 0, vy: 0, size: 3, r: 30, shape: [1, 1, 1, 1, 1, 1], rot: 0, spin: 0 })]; st.ship.inv = 0;
  R.step(st, DT, {});
  check(!st.ship.alive && st.lives === R.START_LIVES - 1, 'rocks: a rock hitting the ship costs a life');
  st = calm(8); st.rocks = [put(st, { x: R.SIZE / 2, y: R.SIZE / 2, size: 3, r: 30, shape: [1, 1, 1, 1, 1, 1], rot: 0, spin: 0 })]; st.ship.inv = 2;
  R.step(st, DT, {});
  check(st.ship.alive && st.lives === R.START_LIVES, 'rocks: a new ship cannot be hit for a moment');
  st = calm(9); st.ship.inv = 0; st.rocks = [put(st, { x: R.SIZE / 2 + 5, y: R.SIZE / 2, size: 1, r: 9, shape: [1, 1, 1, 1], rot: 0, spin: 0 })];
  R.step(st, DT, {}); st.rocks = [];
  for (let i = 0; i < 150; i++) R.step(st, DT, {});
  check(st.ship.alive && st.ship.inv > 0, 'rocks: the ship returns to the middle once it is clear');
  // The last ship lost ends the game.
  st = calm(10); st.lives = 1; st.ship.inv = 0; st.rocks = [put(st, { x: R.SIZE / 2, y: R.SIZE / 2, size: 1, r: 9, shape: [1, 1, 1, 1], rot: 0, spin: 0 })];
  R.step(st, DT, {});
  check(st.status === 'over' && st.events.some(e => e.name === 'over'), 'rocks: the last ship ends the game');

  // The saucer: shooting it scores, it shoots back, and clearing everything starts the next wave.
  st = calm(11); st.ship.x = 50; st.ship.y = 300; st.ship.a = Math.PI / 2; st.rocks = [put(st, { x: 380, y: 20, size: 1, r: 9, shape: [1, 1, 1, 1], rot: 0, spin: 0 })];
  st.saucer = { x: 140, y: 300, vx: 0, vy: 0, small: false, r: 15, turnIn: 9, fireIn: 9 };
  R.fire(st); for (let i = 0; i < 30 && st.saucer; i++) R.step(st, DT, {});
  check(!st.saucer && st.score === R.SAUCER.big.points, 'rocks: shooting the saucer scores 200');
  st = calm(12); st.ship.x = 50; st.ship.y = 50; st.rocks = [put(st, { x: 380, y: 380, size: 1, r: 9, shape: [1, 1, 1, 1], rot: 0, spin: 0 })];
  st.saucer = { x: 100, y: 300, vx: 0, vy: 0, small: true, r: 10, turnIn: 9, fireIn: 0.01 };
  R.step(st, 0.05, {});
  check(st.bullets.some(b => !b.own), 'rocks: the saucer shoots');
  st = calm(13); const w0 = st.wave;
  for (let i = 0; i < 120; i++) R.step(st, DT, {});
  check(st.wave === w0 + 1 && st.rocks.length === 3 + st.wave && st.rocks.every(r => r.size === 3), 'rocks: an empty sky brings the next, bigger wave');
  // A new ship every 10,000.
  st = calm(14); st.score = R.EXTRA_LIFE_EVERY - 20; st.rocks = [R.makeRock(R.mulberry(9), 3, 130, 350, 0, 0)]; st.ship.x = 50; st.ship.y = 350; st.ship.a = Math.PI / 2; R.fire(st);
  for (let i = 0; i < 30 && st.score < R.EXTRA_LIFE_EVERY; i++) R.step(st, DT, {});
  check(st.lives === R.START_LIVES + 1, 'rocks: 10,000 points earns a ship');
}

// ── Last Line ───────────────────────────────────────────────────────────────
{
  const L = load(['playkit.js', 'lastline.js']).LastLineEngine;
  const DT = 1 / 60;
  const quiet = (seed) => { const st = L.createState(seed); st.fireT = 1e9; st.bonusIn = 1e9; return st; };

  let st = quiet(1);
  check(st.inv.length === 45 && st.shields.length === 4 && L.shieldCount(st.shields[0]) > 200, 'last line: 45 drones, four shields');

  // The formation steps sideways, and at the edge drops a row and turns round.
  st = quiet(2); const ox0 = st.ox; st.tick = L.interval(st) + 0.001; L.step(st, DT, {});
  check(st.ox > ox0 && st.dir === 1, 'last line: the formation steps sideways');
  st = quiet(3); st.ox = 360 - 10 - 8 * L.GAP_X - L.INV_W - 2; const oy0 = st.oy; st.tick = L.interval(st) + 0.001; L.step(st, DT, {});
  check(st.oy === oy0 + L.DROP && st.dir === -1, 'last line: at the edge the formation drops a row and turns');

  // The fewer drones left, the faster they step.
  st = quiet(4); const full = L.interval(st);
  st.inv.forEach((v, i) => { if (i > 4) v.alive = false; });
  check(L.interval(st) < full / 4, 'last line: ' + L.aliveCount(st) + ' left step much faster than 45');

  // A shot kills the drone it meets and scores by row.
  st = quiet(5); st.px = L.invPos(st, st.inv[0]).x;
  const v0 = st.inv.find(v => v.c === 0 && v.r === 4); const p0 = L.invPos(st, v0);
  st.px = p0.x; st.shields = []; L.fire(st);
  for (let i = 0; i < 60 && v0.alive; i++) L.step(st, DT, {});
  check(!v0.alive && st.score === L.ROW_POINTS[4], 'last line: a shot kills the front drone and scores 10');
  check(L.fire(quiet(5)) && (() => { const s = quiet(5); L.fire(s); L.fire(s); return s.bullets.length === 1; })(), 'last line: a shot takes a moment to reload');

  // Shields wear away: a shot from below bites a hole and the shot is spent.
  st = quiet(6); st.inv.forEach(v => { v.alive = v.c === 8 && v.r === 0; });
  const sh = st.shields[1], before = L.shieldCount(sh);
  st.px = sh.x + 3 * 4 + 1; st.bullets.push({ x: st.px, y: L.SHIELD_Y + L.SHIELD_ROWS * L.CELL + 20 });
  for (let i = 0; i < 40 && st.bullets.length; i++) L.step(st, DT, {});
  const lost = before - L.shieldCount(sh);
  check(st.bullets.length === 0 && lost >= 8 && lost <= 35, 'last line: a shot from below erodes the shield (' + lost + ' blocks)');
  // And from above: an enemy bullet.
  st = quiet(7); st.inv.forEach(v => { v.alive = v.c === 8 && v.r === 0; });
  const sh2 = st.shields[2], b2 = L.shieldCount(sh2);
  st.enemyBullets.push({ x: sh2.x + 33, y: L.SHIELD_Y - 20 });
  for (let i = 0; i < 40 && st.enemyBullets.length; i++) L.step(st, DT, {});
  check(st.enemyBullets.length === 0 && b2 - L.shieldCount(sh2) >= 8, 'last line: an enemy bullet erodes it from above');
  // A second shot at the same spot goes deeper, so a shield is not invulnerable.
  const holes = L.shieldCount(sh2);
  for (let n = 0; n < 6; n++) { st.enemyBullets.push({ x: sh2.x + 33, y: L.SHIELD_Y - 20 }); for (let i = 0; i < 60 && st.enemyBullets.length; i++) L.step(st, DT, {}); }
  check(L.shieldCount(sh2) < holes - 20, 'last line: repeated hits keep wearing it down');

  // Being hit costs a life and gives a moment of safety; no lives ends the game.
  st = quiet(8); st.enemyBullets.push({ x: st.px, y: L.PLAYER_Y - 5 }); L.step(st, DT, {});
  check(st.lives === L.START_LIVES - 1 && st.inv_t > 1, 'last line: a hit costs a life');
  st = quiet(9); st.lives = 1; st.enemyBullets.push({ x: st.px, y: L.PLAYER_Y - 5 }); L.step(st, DT, {});
  check(st.status === 'over', 'last line: the last life ends the game');
  // Drones reaching the ground end the game.
  st = quiet(10); st.oy = L.GROUND_Y - 4 * L.GAP_Y - 10; st.tick = 10; L.step(st, DT, {});
  check(st.status === 'over', 'last line: reaching the ground ends the game');
  // The bonus ship scores one of the listed amounts.
  st = quiet(11); st.bonus = { x: 180, dir: 1 }; st.px = 180; st.shields = []; st.bullets.push({ x: 180, y: 60 });
  for (let i = 0; i < 20 && st.bonus; i++) L.step(st, DT, {});
  check(!st.bonus && L.BONUS_POINTS.indexOf(st.score) >= 0, 'last line: the bonus ship scores ' + st.score);
  // Clearing the field brings a faster wave and fresh shields.
  st = quiet(12); st.inv.forEach(v => { v.alive = false; }); st.shields[0].cells.fill(0);
  for (let i = 0; i < 100; i++) L.step(st, DT, {});
  check(st.wave === 2 && L.aliveCount(st) === 45 && L.shieldCount(st.shields[0]) > 200 && L.interval(st) < 0.62, 'last line: the next wave is bigger and faster, the shields are back');
}

// ── Lander ──────────────────────────────────────────────────────────────────
{
  const N = load(['playkit.js', 'lander.js']).LanderEngine;
  const t = N.makeTerrain(3, 1);
  check(t.ys.length === 51 && t.pads.length === 3 && t.pads.map(p => p.mult).join() === '1,2,4', 'lander: terrain with three pads paying 1, 2 and 4');
  check(t.pads.every(p => { for (let x = p.x0; x <= p.x1; x += 8) if (Math.abs(N.heightAt(t, x) - p.y) > 1e-9) return false; return p.x1 - p.x0 >= 24; }), 'lander: every pad is flat');
  check(t.pads[0].x1 - t.pads[0].x0 > t.pads[2].x1 - t.pads[2].x0 && N.makeTerrain(3, 5).pads[0].x1 - N.makeTerrain(3, 5).pads[0].x0 < t.pads[0].x1 - t.pads[0].x0, 'lander: the pad that pays most is narrowest, and pads shrink with level');
  const hs = [N.heightAt(t, 4), N.heightAt(t, 12)];
  check(Math.abs(N.heightAt(t, 4) - (t.ys[0] + t.ys[1]) / 2) < 1e-9 && hs.every(h => h >= 150 && h <= 272), 'lander: ground height is interpolated');

  const pad = t.pads[1], cx = (pad.x0 + pad.x1) / 2;
  const at = (o) => Object.assign({ x: cx, y: pad.y - 9, vx: 0, vy: 10, a: 0 }, o);
  check(N.checkLanding(at({}), t).ok, 'lander: slow, upright, on the pad is a landing');
  check(!N.checkLanding(at({ vy: 45 }), t).ok && N.checkLanding(at({ vy: 45 }), t).reason === 'too fast', 'lander: too fast down is a crash');
  check(!N.checkLanding(at({ vx: 30 }), t).ok && !N.checkLanding(at({ vx: -30 }), t).ok, 'lander: too much sideways speed is a crash');
  check(!N.checkLanding(at({ a: 0.4 }), t).ok && !N.checkLanding(at({ a: -0.4 }), t).ok && N.checkLanding(at({ a: 0.15 }), t).ok, 'lander: tilted past about 12 degrees is a crash');
  check(!N.checkLanding(at({ x: pad.x1 + 12 }), t).ok, 'lander: off the pad is a crash');
  check(!N.checkLanding(at({ x: pad.x1 + 4 }), t).ok, 'lander: one foot over the edge is a crash');
  check(N.checkLanding(at({ vy: 35, vx: 22 }), t).ok, 'lander: exactly at the limits still lands');

  // A whole descent: gravity pulls, a pad landing scores, the same lander too fast crashes.
  let st = N.createState(5, 1); const pd = st.terrain.pads[2];
  st.lander = { x: (pd.x0 + pd.x1) / 2, y: pd.y - 9 - 20, vx: 0, vy: 15, a: 0 };
  for (let i = 0; i < 600 && st.status === 'flying'; i++) N.step(st, 1 / 60, {});
  check(st.status === 'landed' && st.score >= 4 * 100 && st.lives === 3, 'lander: a gentle drop onto the x4 pad lands and scores ' + st.score);
  st = N.createState(5, 1); st.lander = { x: (pd.x0 + pd.x1) / 2, y: 60, vx: 0, vy: 0, a: 0 };
  for (let i = 0; i < 600 && st.status === 'flying'; i++) N.step(st, 1 / 60, {});
  check(st.status === 'crashed' && st.lives === 2, 'lander: free fall onto the pad crashes and costs a lander');
  // Thrust slows a fall and burns fuel; no fuel, no thrust.
  st = N.createState(6, 1); st.lander = { x: 200, y: 20, vx: 0, vy: 0, a: 0 };
  const f0 = st.fuel; N.step(st, 0.5, { thrust: true });
  check(st.lander.vy < 0 && st.fuel < f0 && Math.abs(f0 - st.fuel - N.BURN * 0.5) < 1e-9, 'lander: thrust pushes up and burns fuel');
  st = N.createState(6, 1); st.fuel = 0; st.lander = { x: 200, y: 20, vx: 0, vy: 0, a: 0 }; N.step(st, 0.5, { thrust: true });
  check(st.lander.vy > 0 && st.fuel === 0, 'lander: an empty tank gives no thrust');
  st = N.createState(7, 1); st.lander = { x: 200, y: 20, vx: 0, vy: 0, a: 0 }; N.step(st, 0.5, { right: true, thrust: true });
  check(st.lander.a > 0 && st.lander.vx > 0, 'lander: rotating right and thrusting pushes right');
  // A tilted touchdown crashes; the next lander starts the right place.
  st = N.createState(8, 1); st.lander = { x: (pd.x0 + pd.x1) / 2, y: pd.y - 30, vx: 0, vy: 10, a: 0.5 };
  for (let i = 0; i < 300 && st.status === 'flying'; i++) N.step(st, 1 / 60, {});
  const nx = N.next(st);
  check(st.status === 'crashed' && nx.level === 1 && nx.lives === 2 && nx.status === 'flying' && nx.fuel === N.FUEL_START, 'lander: after a crash the same ground again with a full tank');
  st = N.createState(9, 1); st.status = 'landed'; st.score = 500;
  const nl = N.next(st);
  check(nl.level === 2 && nl.score === 500 && nl.fuel < N.FUEL_START, 'lander: after a landing the next level, a little less fuel');
}

// ── Paddles ─────────────────────────────────────────────────────────────────
{
  const D = load(['playkit.js', 'paddles.js']).PaddlesEngine;
  const DT = 1 / 60;
  const live = (mode, level, seed) => { const st = D.createState(mode, level, seed); st.status = 'playing'; return st; };
  const ball = (st, x, y, vx, vy, speed) => { Object.assign(st.ball, { x, y, vx, vy, speed: speed || Math.hypot(vx, vy) }); };

  // A ball that meets the middle of the paddle goes straight back; one that meets the edge goes out at a wide angle.
  let st = live('two', 'medium', 1); st.bottom.x = 180;
  ball(st, 180, D.BOTTOM_Y - 40, 0, 300); for (let i = 0; i < 30 && st.ball.vy > 0; i++) D.step(st, DT, {});
  check(st.ball.vy < 0 && Math.abs(st.ball.vx) < 1, 'paddles: a ball on the middle goes straight back');
  st = live('two', 'medium', 1); st.bottom.x = 180;
  ball(st, 180 + 36, D.BOTTOM_Y - 40, 0, 300); for (let i = 0; i < 30 && st.ball.vy > 0; i++) D.step(st, DT, {});
  const edge = Math.atan2(Math.abs(st.ball.vx), -st.ball.vy);
  check(st.ball.vy < 0 && st.ball.vx > 0 && edge > 0.7 && edge <= D.MAX_ANGLE + 1e-6, 'paddles: a ball on the right edge leaves to the right at ' + Math.round(edge * 57.3) + ' degrees');
  st = live('two', 'medium', 1); st.bottom.x = 180;
  ball(st, 180 - 20, D.BOTTOM_Y - 40, 0, 300); for (let i = 0; i < 30 && st.ball.vy > 0; i++) D.step(st, DT, {});
  check(st.ball.vx < 0, 'paddles: left of centre goes left');
  // Every hit adds speed, up to a limit.
  st = live('two', 'medium', 2); st.bottom.x = 180; const s0 = D.SERVE_SPEED; ball(st, 180, D.BOTTOM_Y - 40, 0, s0);
  for (let i = 0; i < 30 && st.ball.vy > 0; i++) D.step(st, DT, {});
  check(st.ball.speed > s0 && Math.abs(Math.hypot(st.ball.vx, st.ball.vy) - st.ball.speed) < 1e-6, 'paddles: a hit speeds the ball up');
  st = live('two', 'medium', 2); st.bottom.x = 180; ball(st, 180, D.BOTTOM_Y - 40, 0, 600, D.MAX_SPEED);
  for (let i = 0; i < 30 && st.ball.vy > 0; i++) D.step(st, DT, {});
  check(st.ball.speed === D.MAX_SPEED, 'paddles: but never past the top speed');
  // Side walls.
  st = live('two', 'medium', 3); ball(st, 20, 250, -400, 0.01, 400); D.step(st, DT, {}); D.step(st, DT, {});
  check(st.ball.vx > 0 && st.ball.x >= 7, 'paddles: the side walls bounce the ball');
  // A fast ball does not pass through a paddle.
  st = live('two', 'medium', 4); st.bottom.x = 180; ball(st, 180, D.BOTTOM_Y - 60, 0, D.MAX_SPEED);
  let through = false; for (let i = 0; i < 60; i++) { D.step(st, DT, {}); if (st.ball.y > D.BOTTOM_Y + 12) through = true; }
  check(!through && st.score.top === 0, 'paddles: a fast ball is stopped by the paddle, not through it');
  // Missing scores for the other side, and the ball is served to the one who missed.
  st = live('two', 'medium', 5); st.bottom.x = 30; ball(st, 300, D.BOTTOM_Y - 40, 0, 300);
  for (let i = 0; i < 60 && st.status === 'playing'; i++) D.step(st, DT, {});
  check(st.score.top === 1 && st.status === 'serving' && st.serveTo === 'bottom', 'paddles: a miss gives the other side the point and the serve comes back to the one who missed');
  // First to 7.
  st = live('two', 'medium', 6); st.score.bottom = D.WIN_SCORE - 1; st.top.x = 30; ball(st, 300, D.TOP_Y + 40, 0, -300);
  for (let i = 0; i < 60 && st.status === 'playing'; i++) D.step(st, DT, {});
  check(st.status === 'over' && st.winner === 'bottom' && st.score.bottom === D.WIN_SCORE, 'paddles: the seventh point wins');
  // The serve starts after a pause, towards whoever it should.
  st = D.createState('two', 'easy', 7); st.serveTo = 'top'; for (let i = 0; i < 80; i++) D.step(st, DT, {});
  check(st.status === 'playing' && st.ball.vy < 0, 'paddles: the ball is served after a short pause');
  // Paddles move at a limited speed, by key or by finger, and stay inside the court.
  st = live('two', 'medium', 8); st.bottom.x = 180; D.step(st, 0.1, { bottom: { dir: 1 } });
  check(Math.abs(st.bottom.x - (180 + D.PAD_SPEED * 0.1)) < 1e-9, 'paddles: a key moves the paddle at its speed');
  D.step(st, 0.1, { bottom: { target: 0 } }); st.bottom.x = 180; D.step(st, 0.1, { bottom: { target: 0 } });
  check(Math.abs(st.bottom.x - (180 - D.PAD_SPEED * 0.1)) < 1e-9, 'paddles: following a finger is capped at the same speed');
  for (let i = 0; i < 100; i++) D.step(st, DT, { bottom: { dir: -1 } });
  check(st.bottom.x === D.PAD_W / 2, 'paddles: the paddle stops at the wall');

  // The computer: it follows a ball it can reach and returns it, but a wide shot beats the easy one.
  st = live('cpu', 'hard', 9); st.top.x = 100; ball(st, 260, 250, 0, -300); st.aiming = false;
  let returned = false; for (let i = 0; i < 150; i++) { D.step(st, DT, {}); if (st.ball.vy > 0 && st.hits > 0) { returned = true; break; } }
  check(returned && st.score.bottom === 0, 'paddles: the hard computer reaches a ball across the court and returns it');
  let easyBeaten = 0, hardBeaten = 0;
  for (let seed = 1; seed <= 12; seed++) {
    ['easy', 'hard'].forEach(level => {
      const s = live('cpu', level, seed); s.top.x = 40; ball(s, 330, 300, 120, -330);
      for (let i = 0; i < 200 && s.status === 'playing' && s.score.bottom === 0 && !(s.ball.vy > 0); i++) D.step(s, DT, {});
      if (s.score.bottom === 1) { if (level === 'easy') easyBeaten++; else hardBeaten++; }
    });
  }
  check(easyBeaten >= 8 && easyBeaten >= hardBeaten, 'paddles: a ball into the far corner beats the easy computer (' + easyBeaten + ' of 12) more than the hard one (' + hardBeaten + ' of 12)');
  const slow = live('cpu', 'easy', 10); slow.top.x = 100; ball(slow, 300, 300, 0, -300);
  let maxMove = 0, px = slow.top.x; for (let i = 0; i < 60; i++) { D.step(slow, DT, {}); maxMove = Math.max(maxMove, Math.abs(slow.top.x - px)); px = slow.top.x; }
  check(maxMove <= D.LEVELS.easy.speed * DT + 1e-9, 'paddles: the computer moves no faster than its level allows');
}

// ── Memory ──────────────────────────────────────────────────────────────────
{
  const M = load(['playkit.js', 'memory.js']).MemoryEngine;
  check(Object.keys(M.SETS).length >= 2 && Object.keys(M.SETS).every(k => M.SETS[k].pics.length >= 10 && M.SETS[k].pics.every(p => /^[A-Z][a-z]+$/.test(p[0]) && p[1].startsWith('<'))), 'memory: two picture sets, ten named pictures each');
  check(Object.keys(M.SETS).every(k => new Set(M.SETS[k].pics.map(p => p[0])).size === M.SETS[k].pics.length && new Set(M.SETS[k].pics.map(p => p[1])).size === M.SETS[k].pics.length), 'memory: every picture is different');
  let g = M.createGame(8, 3);
  const tally = {}; g.cards.forEach(c => { tally[c.id] = (tally[c.id] || 0) + 1; });
  check(g.cards.length === 16 && Object.values(tally).every(n => n === 2) && Object.keys(tally).length === 8, 'memory: sixteen cards, eight pairs');
  check(JSON.stringify(M.createGame(8, 3).cards) === JSON.stringify(g.cards) && JSON.stringify(M.createGame(8, 4).cards) !== JSON.stringify(g.cards), 'memory: the shuffle follows the seed');
  const find = (g, id, skip) => g.cards.findIndex((c, i) => c.id === id && i !== skip);
  const a = find(g, 0), b = find(g, 0, a), other = g.cards.findIndex(c => c.id === 1);
  check(M.flip(g, a) === 'first' && g.cards[a].up && g.moves === 0, 'memory: the first card turns up and costs nothing');
  check(M.flip(g, a) === 'ignored', 'memory: the same card twice is ignored');
  check(M.flip(g, b) === 'match' && g.cards[a].done && g.cards[b].done && g.moves === 1 && g.found === 1, 'memory: the second card matches, the pair stays up');
  check(M.flip(g, a) === 'ignored', 'memory: a matched card is out of play');
  check(M.flip(g, other) === 'first' && M.flip(g, find(g, 2)) === 'mismatch' && g.pending && g.moves === 2, 'memory: two different cards are a mismatch');
  check(M.flip(g, find(g, 3)) === 'ignored', 'memory: no third card while a mismatch is showing');
  check(M.resolve(g) && g.cards.filter(c => c.up && !c.done).length === 0 && !g.pending && M.resolve(g) === false, 'memory: the mismatch turns back down');
  // Play a whole game perfectly: eight pairs, eight moves, then it is over.
  g = M.createGame(8, 11);
  for (let id = 0; id < 8; id++) { const x = find(g, id); M.flip(g, x); M.flip(g, find(g, id, x)); }
  check(g.over && g.found === 8 && g.moves === 8 && M.flip(g, 0) === 'ignored', 'memory: a perfect game takes as many moves as pairs');
  // A game of trial and error still ends: take a card, try the others in turn until it matches.
  g = M.createGame(6, 5);
  for (let i = 0; i < g.cards.length; i++) {
    if (g.cards[i].done) continue;
    for (let k = i + 1; k < g.cards.length && !g.cards[i].done; k++) { if (g.cards[k].done) continue; M.flip(g, i); if (M.flip(g, k) === 'mismatch') M.resolve(g); }
  }
  check(g.over && g.moves >= 6, 'memory: trial and error finishes (' + g.moves + ' moves)');
}

// ── Echo ────────────────────────────────────────────────────────────────────
{
  const E = load(['playkit.js', 'echo.js']).EchoEngine;
  let g = E.createGame(5);
  check(g.seq.length === 1 && g.seq[0] >= 0 && g.seq[0] < 4, 'echo: a game starts with one pad');
  check(JSON.stringify(E.createGame(5).seq) === JSON.stringify(g.seq), 'echo: the sequence follows the seed');
  // Repeat it right, round after round: each round is one longer and ends in "done".
  let ok = true;
  for (let round = 1; round <= 12; round++) {
    ok = ok && g.seq.length === round;
    for (let i = 0; i < g.seq.length; i++) { const r = E.press(g, g.seq[i]); ok = ok && r === (i === g.seq.length - 1 ? 'done' : 'ok'); }
    ok = ok && g.done === round;
    E.extend(g);
  }
  check(ok && g.seq.length === 13, 'echo: twelve right rounds, one longer each time');
  g = E.createGame(7); E.extend(g); E.extend(g);
  check(E.press(g, g.seq[0]) === 'ok' && E.press(g, (g.seq[1] + 1) % 4) === 'wrong' && g.pos === 0, 'echo: a wrong pad is wrong, and you start the sequence again');
  check(E.press(g, (g.seq[0] + 1) % 4) === 'wrong', 'echo: wrong on the first pad too');
  // Longer sequences play faster, but never faster than a person can follow.
  const t1 = E.timing(1), t10 = E.timing(10), t40 = E.timing(40);
  check(t10.gap < t1.gap && t40.gap === 240 && t1.on < t1.gap && t40.on >= 100, 'echo: it speeds up with length, to a floor (' + t1.gap + ' to ' + t40.gap + ' ms)');
  check(E.FREQ.length === 4 && new Set(E.FREQ).size === 4 && E.FREQ.every((f, i, a) => i === 0 || f > a[i - 1]), 'echo: four different notes, rising');
  const counts = [0, 0, 0, 0]; g = E.createGame(9); for (let i = 0; i < 400; i++) E.extend(g); g.seq.forEach(p => counts[p]++);
  check(counts.every(n => n > 60), 'echo: every pad turns up in a long sequence');
}

// ── Tic-Tac-Toe ─────────────────────────────────────────────────────
{
  const N = load(['playkit.js', 'noughts.js']).NoughtsEngine;
  const b = (s) => s.split('').map(c => c === '.' ? null : c);
  check(N.winner(b('XXX......')) === 'X' && N.winner(b('O..O..O..')) === 'O' && N.winner(b('X...X...X')) === 'X' && N.winner(b('..O.O.O..')) === 'O' && N.winner(b('XOXXOOOXX')) === null, 'noughts: every kind of line wins, a full board with none is a draw');
  check(N.winLine(b('XO.XO.X..'))[2] === 6 && N.winLine(b('XOXOXOOXO')) === null, 'noughts: the winning line is reported');

  // It takes a win and blocks a loss.
  const mv = (s, me, level) => N.bestMove(b(s), me, level || 'perfect', N.mulberry(1));
  check(mv('XX.OO....', 'X') === 2 && mv('XX.OO....', 'O') === 5, 'noughts: perfect takes its own win before blocking');
  check(mv('XX.O.....', 'O') === 2, 'noughts: perfect blocks a loss');
  check(N.bestMove(N.emptyBoard(), 'X', 'perfect', N.mulberry(3)) >= 0 && N.bestMove(b('XOXOXOOXO'), 'X', 'perfect') === -1, 'noughts: no move on a full board');
  // A fork: O in the corners against X in the middle: X must take an edge, not a corner.
  check([1, 3, 5, 7].includes(mv('O...X...O', 'X')), 'noughts: perfect X takes an edge against opposite corners');

  // Perfect play never loses: against every possible sequence of moves by the other side, either mark.
  function everyGame(computer, level) {
    let lost = 0, games = 0;
    const rng = N.mulberry(computer === 'X' ? 11 : 22);
    (function walk(board, turn) {
      if (N.winner(board)) { games++; if (N.winner(board) !== computer) lost++; return; }
      if (N.full(board)) { games++; return; }
      if (turn === computer) { const nb = board.slice(); N.play(nb, N.bestMove(nb, computer, level, rng), turn); walk(nb, N.other(turn)); }
      else N.moves(board).forEach(i => { const nb = board.slice(); N.play(nb, i, turn); walk(nb, N.other(turn)); });
    })(N.emptyBoard(), 'X');
    return { lost, games };
  }
  const asO = everyGame('O', 'perfect'), asX = everyGame('X', 'perfect');
  check(asO.lost === 0 && asO.games > 100, 'noughts: perfect as noughts never loses, in any of ' + asO.games + ' games');
  check(asX.lost === 0 && asX.games > 50, 'noughts: perfect as crosses never loses, in any of ' + asX.games + ' games');
  // Perfect against perfect is a draw.
  let drawn = true;
  for (let seed = 1; seed <= 30; seed++) { const bd = N.emptyBoard(), r = N.mulberry(seed); let t = 'X'; while (!N.winner(bd) && !N.full(bd)) { N.play(bd, N.bestMove(bd, t, 'perfect', r), t); t = N.other(t); } drawn = drawn && !N.winner(bd); }
  check(drawn, 'noughts: perfect against perfect is always a draw');
  // Perfect does not always play the same game (several moves are equally good).
  const firsts = new Set(); for (let s = 1; s <= 40; s++) firsts.add(N.bestMove(N.emptyBoard(), 'X', 'perfect', N.mulberry(s)));
  check(firsts.size > 1, 'noughts: it varies among equally good moves');

  // The easy computer is legal and can be beaten; a perfect player beats it often.
  let illegal = 0, wins = 0, total = 200;
  for (let seed = 1; seed <= total; seed++) {
    const bd = N.emptyBoard(), r = N.mulberry(seed * 13); let t = 'X';
    while (!N.winner(bd) && !N.full(bd)) {
      const m = t === 'X' ? N.bestMove(bd, 'X', 'perfect', r) : N.bestMove(bd, 'O', 'easy', r);
      if (bd[m] !== null || m < 0) { illegal++; break; }
      N.play(bd, m, t); t = N.other(t);
    }
    if (N.winner(bd) === 'X') wins++;
  }
  check(illegal === 0 && wins > total * 0.5, 'noughts: the easy computer never cheats, and a perfect player beats it ' + wins + ' of ' + total);
  let easyWins = 0;
  for (let seed = 1; seed <= total; seed++) {
    const bd = N.emptyBoard(), r = N.mulberry(seed * 7); let t = 'X';
    while (!N.winner(bd) && !N.full(bd)) { const m = t === 'X' ? N.bestMove(bd, 'X', 'easy', r) : N.bestMove(bd, 'O', 'easy', r); N.play(bd, m, t); t = N.other(t); }
    if (N.winner(bd)) easyWins++;
  }
  check(easyWins > total * 0.5, 'noughts: easy against easy is usually decided, not drawn (' + easyWins + ' of ' + total + ')');
}

// END
if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
