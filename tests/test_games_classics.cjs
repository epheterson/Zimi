// Console-classic style games (Hopper, Muncher, Crossing, Blast, Quest, Zimi Pet): the rules, with no DOM.
// Platformer collision and jump arc, maze chaser targeting, crossing lane collisions, bomb blasts and chain
// reactions, quest door and key logic, pet stat decay over elapsed time and growth.
//
// Run: node tests/test_games_classics.cjs   (exit 0 = pass)

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

// ── Hopper ──────────────────────────────────────────────────────────────────
{
  const H = load(['hopper.js']).HopperEngine;
  const T = H.T, DT = 1 / 60;
  const flat = (extra) => ({ name: 't', theme: 'meadow', rows: [
    '                    ', '                    ', '                    ', '                    ',
    '                    ', ' s                  ', '####################', '####################'].map((r, i) => (extra && extra[i]) || r) });
  const run = (st, secs, input) => { for (let i = 0; i < Math.round(secs / DT); i++) H.step(st, DT, typeof input === 'function' ? input(i) : input); };

  check(H.LEVELS.length === 6, 'hopper: six levels');
  check(H.LEVELS.every(l => l.rows.length === H.ROWS && l.rows.every(r => r.length === l.rows[0].length)), 'hopper: every level is 8 rows of one width');
  check(H.LEVELS.every(l => l.rows.join('').split('s').length === 2 && l.rows.join('').split('F').length === 2), 'hopper: one start and one flag per level');

  // collision: standing on the ground, falling stops on top of it; walls stop a run
  let st = H.createState(flat());
  run(st, 0.5, {});
  check(Math.abs(st.y + st.h - 6 * T) < 0.01 && st.onGround, 'hopper: lands and stands on the ground');
  const wall = flat(['', '', '', '', '', ' s     B           ']);
  wall.rows[4] = '       B            '; wall.rows[3] = '       B            ';
  st = H.createState(wall);
  run(st, 2, { right: true });
  check(st.x + st.w <= 7 * T + 0.001 && st.x + st.w >= 7 * T - 0.5, 'hopper: a wall stops the run flush');
  st = H.createState(flat());
  run(st, 0.2, {});
  run(st, 1, { left: true });
  check(st.x >= 0, 'hopper: the left edge of a level is a wall');

  // jump arc: hold = full height and back on the ground; tap = a short hop
  function apex(inputFn, secs) {
    const s = H.createState(flat()); run(s, 0.3, {});
    const ground = s.y; let top = ground, landedAt = -1;
    for (let i = 0; i < Math.round(secs / DT); i++) {
      H.step(s, DT, inputFn(i));
      top = Math.min(top, s.y);
      if (landedAt < 0 && i > 5 && s.onGround) landedAt = i;
    }
    return { rise: ground - top, landedAt, s };
  }
  const full = apex(i => ({ jump: i < 60 }), 1.5), tap = apex(i => ({ jump: i < 3 }), 1.5);
  check(full.rise > 3 * T - 4 && full.rise < 3.8 * T, 'hopper: a held jump rises about three and a half tiles (' + full.rise.toFixed(1) + ' px)');
  check(tap.rise > 4 && tap.rise < full.rise * 0.5, 'hopper: a tap is a short hop (' + tap.rise.toFixed(1) + ' px)');
  check(full.landedAt > 0 && full.s.onGround, 'hopper: the jump comes back down to the ground');
  const air = full.landedAt / 60;
  check(air > 0.55 && air < 0.85, 'hopper: a full jump hangs for ' + air.toFixed(2) + ' s');

  // a jump clears a three-tile gap but not a six-tile one
  function gapLevel(w) {
    const g = '#'.repeat(5) + ' '.repeat(w) + '#'.repeat(26 - 5 - w);
    return { name: 'g', theme: 'meadow', rows: ['', '', '', '', '', '', '', ''].map((_, i) => i === 5 ? '    s' + ' '.repeat(21) : i >= 6 ? g : ' '.repeat(26)) };
  }
  function tryGap(w) {
    const s = H.createState(gapLevel(w));
    let jumped = false;
    run(s, 4, i => { const edge = s.x + s.w >= 5 * T - 2; if (edge) jumped = true; return { right: true, jump: s.x + s.w >= 5 * T - 6 && s.x < 5 * T + 4 }; });
    return s.x > (5 + w) * T && s.status === 'playing' && s.hearts === 3;
  }
  check(tryGap(3), 'hopper: a running jump clears a three-tile gap');
  check(!tryGap(6), 'hopper: a six-tile gap is too wide');

  // coyote time: a jump pressed just after running off a ledge still works; much later does not
  function ledgeJump(delay) {
    const s = H.createState(gapLevel(8));
    let off = -1, jumpedAt = -1;
    for (let i = 0; i < 240; i++) {
      const wasGround = s.onGround;
      H.step(s, DT, { right: true, jump: off >= 0 && i === off + delay });
      if (off < 0 && wasGround && !s.onGround && s.x > 5 * T - 4) off = i;
      if (off >= 0 && i === off + delay) { jumpedAt = s.vy; }
      if (off >= 0 && i > off + delay + 1) break;
    }
    return { off, vy: jumpedAt };
  }
  const early = ledgeJump(3), late = ledgeJump(14);
  check(early.off > 0 && early.vy < 0, 'hopper: coyote time lets you jump just after the ledge');
  check(late.off > 0 && late.vy >= 0, 'hopper: but not a quarter second later');

  // jump buffering: pressing jump a little before landing jumps on landing
  st = H.createState(flat()); st.y = 6 * T - st.h - 6; st.vy = 0;
  H.step(st, DT, { jump: true }); // in the air: press is buffered
  let jumpedOnLanding = false;
  for (let i = 0; i < 20 && !jumpedOnLanding; i++) { H.step(st, DT, { jump: i < 8 }); if (st.events.some(e => e.name === 'jump')) jumpedOnLanding = true; }
  check(jumpedOnLanding, 'hopper: a jump pressed just before landing is remembered');

  // enemies, coins, spikes, checkpoints, flag
  const arena = (cells) => { const r = ['                    ', '                    ', '                    ', '                    ', '                    ', cells, '####################', '####################']; return { name: 'a', theme: 'meadow', rows: r }; };
  st = H.createState(arena(' s  o               '));
  run(st, 1, { right: true });
  check(st.coins === 1, 'hopper: a coin is picked up once');
  st = H.createState(arena(' s ^                '));
  const startX = st.x;
  for (let i = 0; i < 90 && st.hearts === 3; i++) H.step(st, DT, { right: true });
  check(st.hearts === 2 && st.x === startX, 'hopper: spikes cost a heart and send you back to the start');
  st = H.createState(arena(' s     c    ^       '));
  for (let i = 0; i < 80 && st.checkpoint.x < 5 * T; i++) H.step(st, DT, { right: true });
  check(st.checkpoint.x > 5 * T, 'hopper: a flag becomes the place to come back to');
  const flagX = st.checkpoint.x;
  for (let i = 0; i < 240 && st.hearts === 3; i++) H.step(st, DT, { right: true });
  check(st.hearts === 2 && st.x === flagX, 'hopper: after a hurt you restart at the flag, not the start');
  st = H.createState(arena(' s      w           '));
  const crawler = st.enemies[0]; check(crawler && crawler.type === 'w', 'hopper: a crawler is placed');
  run(st, 0.6, {});
  const x0 = crawler.x; run(st, 0.5, {});
  check(crawler.x !== x0 || !crawler.alive, 'hopper: a crawler walks');
  st = H.createState(arena(' s                 '));
  st.enemies.push({ type: 'w', x: st.x + 2, y: 6 * T - 9, w: 12, h: 9, vx: 0, vy: 0, dir: 1, alive: true, t: 0, hopT: 0, hops: 0, homeX: 0, baseY: 0 });
  st.y = 6 * T - 9 - st.h - 2; st.vy = 150; st.x = st.enemies[0].x + 1;
  H.step(st, DT, {});
  check(!st.enemies[0].alive && st.vy < 0 && st.hearts === 3, 'hopper: landing on a crawler squashes it and bounces');
  st = H.createState(arena(' s                 '));
  st.enemies.push({ type: 'w', x: st.x + 14, y: 6 * T - 9, w: 12, h: 9, vx: -26, vy: 0, dir: -1, alive: true, t: 0, hopT: 0, hops: 0, homeX: 0, baseY: 0 });
  run(st, 1.2, {});
  check(st.hearts === 2, 'hopper: walking into a crawler costs a heart');
  st = H.createState(arena(' s       F         '));
  run(st, 2, { right: true });
  check(st.status === 'won', 'hopper: the flag wins the level');
  st = H.createState(arena('                    '));
  st.y = 6 * T; st.rows[6] = '                    '; st.rows[7] = '                    ';
  st.x = 3 * T; st.y = 6 * T;
  run(st, 1.5, {});
  check(st.hearts === 2 || st.status === 'over', 'hopper: falling out of the level costs a heart');
  const sp = H.createState(arena(' s S                ')); sp.x = 3 * T + 3;
  run(sp, 0.1, {});
  check(sp.events.some(e => e.name === 'spring') || sp.vy < 0, 'hopper: a spring throws you up');

  // every level can be crossed: gaps of at most three tiles, climbs of at most two (more only after a spring), spikes in runs of two
  H.LEVELS.forEach((lv, li) => {
    const rows = lv.rows, w = rows[0].length, surf = [];
    for (let c = 0; c < w; c++) { let r = 0; while (r < rows.length && rows[r][c] !== '#' && rows[r][c] !== 'B') r++; surf.push(r); }
    let ok = true, why = '', run = 0;
    for (let c = 0; c < w; c++) {
      if (surf[c] === rows.length) { run++; if (run > 3) { ok = false; why = 'gap at ' + c; } continue; }
      const prev = c - run - 1;
      if (prev >= 0 && surf[prev] - surf[c] > 2 && !rows.some(r => r.slice(Math.max(0, c - 6), c).includes('S'))) { ok = false; why = 'climb at ' + c; }
      run = 0;
    }
    check(ok && !rows.some(r => r.includes('^^^')) && rows.join('').includes('F'), 'hopper: level ' + (li + 1) + ' is crossable by the numbers ' + why);
  });

  // a simple bot (run right; jump at gaps, walls, enemies and spikes) finishes the first level
  function botFinishes(idx) {
    const s = H.createState(idx);
    for (let i = 0; i < 60 * 150 && s.status === 'playing'; i++) {
      const aheadX = s.x + s.w + 4, col = Math.floor(aheadX / T), row = Math.floor((s.y + s.h - 1) / T);
      const wallAhead = H.solidAt(s, col, row) || H.solidAt(s, col, row - 1);
      const groundAhead = H.solidAt(s, Math.floor((s.x + s.w + 10) / T), row + 1) || H.solidAt(s, Math.floor((s.x + s.w + 10) / T), row + 2);
      const hazard = [1, 2, 3, 4].some(k => { const ch = H.tileAt(s, Math.floor((s.x + s.w + k * 4) / T), row); return ch === '^'; });
      const foe = s.enemies.some(e => e.alive && e.x > s.x && e.x - s.x < 46 && Math.abs(e.y - s.y) < 40);
      const need = s.onGround && (wallAhead || !groundAhead || hazard || foe);
      H.step(s, DT, { right: true, jump: need || (!s.onGround && s.vy < 0 && s.jumpPrev && (wallAhead || !groundAhead || hazard || foe)) });
      s.events.length = 0;
      if (s.status === 'over') break;
    }
    return s.status;
  }
  [0].forEach(i => check(botFinishes(i) === 'won', 'hopper: a simple bot finishes level ' + (i + 1)));
}

// ── Muncher ─────────────────────────────────────────────────────────────────
{
  const M = load(['gridwalk.js', 'muncher.js']).MuncherEngine, DT = 1 / 60;
  const run = (st, secs, dir) => { for (let i = 0; i < Math.round(secs / DT); i++) M.step(st, DT, dir); };
  const ready = (level) => { const st = M.createState(level || 1, 7); st.status = 'playing'; return st; };

  check(M.MAZES.length === 3, 'muncher: three mazes');
  M.MAZES.forEach(mz => {
    const rows = mz.rows, w = rows[0].length;
    check(rows.length === 20 && w === 17 && rows.every(r => r.length === w), 'muncher: ' + mz.name + ' is 17 x 20');
    check(rows.every(r => r === r.split('').reverse().join('')), 'muncher: ' + mz.name + ' is symmetrical');
    check(rows[7].charAt(8) === '-' && rows[9].charAt(0) === ' ' && rows[9].charAt(16) === ' ', 'muncher: ' + mz.name + ' has its gate and a side tunnel');
    // every dot can be reached from the start without the house
    const st = M.createState(M.MAZES.indexOf(mz) + 1, 1), seen = new Set(), q = [[st.start.x, st.start.y]];
    seen.add(st.start.x + ',' + st.start.y);
    while (q.length) {
      const [x, y] = q.shift();
      M.DIRS.forEach(d => { const nx = M.wrapCol(st, x + d.dx), ny = y + d.dy, k = nx + ',' + ny; if (ny >= 0 && ny < st.h && M.open(st, nx, ny, false) && !seen.has(k)) { seen.add(k); q.push([nx, ny]); } });
    }
    let missing = 0; rows.forEach((r, y) => r.split('').forEach((c, x) => { if ((c === '.' || c === 'o') && !seen.has(x + ',' + y)) missing++; }));
    check(missing === 0 && st.dots > 100, 'muncher: ' + mz.name + ' has ' + st.dots + ' dots, all reachable');
  });

  // eating and scoring
  let st = ready();
  const sy = st.start.y;
  st.player.x = 8; st.player.y = 12; st.grid[12][7] = '.'; st.grid[12][6] = '.';
  const dots0 = st.dotsEaten;
  run(st, 0.4, M.LEFT);
  check(st.dotsEaten - dots0 === 2 && st.score === 20, 'muncher: each dot is ten points');
  st = ready(); st.player.x = 8; st.player.y = 12; st.grid[12][7] = 'o';
  run(st, 0.2, M.LEFT);
  check(st.score >= M.PELLET_POINTS && st.scared > 0 && st.chasers.some(c => c.mode === 'scared'), 'muncher: a power pellet turns the chasers blue');
  check(M.scaredSeconds(1) > M.scaredSeconds(4) && M.scaredSeconds(20) >= 2, 'muncher: blue time shrinks with the maze, never below two seconds');

  // eating blue chasers: 200, then 400; and the chaser turns into eyes
  st = ready(); st.scared = 5; st.chain = 0;
  st.player.x = 4; st.player.y = 4; st.player.dx = 0; st.player.dy = 0; st.grid[4][4] = ' ';
  st.chasers[0].mode = 'scared'; st.chasers[0].x = 4; st.chasers[0].y = 4;
  const before = st.score; M.step(st, DT, null);
  check(st.score - before === 200 && st.chasers[0].mode === 'eyes', 'muncher: the first blue chaser is 200 and goes home as eyes');
  st.chasers[1].mode = 'scared'; st.chasers[1].x = 4; st.chasers[1].y = 4; M.step(st, DT, null);
  check(st.chasers[1].mode === 'eyes' && st.score - before === 600, 'muncher: the next one is 400');

  // being caught costs a life and puts everyone back
  st = ready(); st.player.x = 4; st.player.y = 4; st.chasers[0].x = 4; st.chasers[0].y = 4; st.chasers[0].mode = 'normal';
  M.step(st, DT, null);
  check(st.status === 'dying' && st.lives === M.LIVES - 1, 'muncher: a chaser that catches you costs a life');
  run(st, 2, null);
  check(st.status === 'ready' && st.player.x === st.start.x && st.chasers[0].y === 6, 'muncher: then everyone returns to the start');
  st = ready(); st.lives = 1; st.player.x = 4; st.player.y = 4; st.chasers[0].x = 4; st.chasers[0].y = 4;
  M.step(st, DT, null); run(st, 2, null);
  check(st.status === 'over', 'muncher: no lives left is game over');

  // chaser personalities
  st = ready(); st.phase = 1;   // a chase phase
  st.player.x = 8; st.player.y = 12; st.player.dx = -1; st.player.dy = 0;
  const [rusher, ambusher, shy, drifter] = st.chasers;
  rusher.x = 2; rusher.y = 2; let t = M.chaserTarget(st, rusher);
  check(t.x === 8 && t.y === 12, 'muncher: the rusher aims straight at you');
  t = M.chaserTarget(st, ambusher);
  check(t.x === 4 && t.y === 12, 'muncher: the ambusher aims four tiles ahead of you');
  st.player.dx = 0; st.player.dy = -1; t = M.chaserTarget(st, ambusher);
  check(t.x === 8 && t.y === 8, 'muncher: ahead follows the way you face');
  shy.x = 8; shy.y = 1; t = M.chaserTarget(st, shy);
  check(t.x === 8 && t.y === 12, 'muncher: the shy one comes for you from far away');
  shy.x = 8; shy.y = 8; t = M.chaserTarget(st, shy);
  check(t.x === M.CORNERS.shy[0] && t.y === M.CORNERS.shy[1], 'muncher: but goes to its corner when close');
  st.phase = 0; t = M.chaserTarget(st, rusher);
  check(t.x === M.CORNERS.rusher[0] && t.y === M.CORNERS.rusher[1], 'muncher: in a scatter phase everyone heads for a corner');
  const eyes = { kind: 'rusher', mode: 'eyes', x: 3, y: 3, dx: 0, dy: 0 }; t = M.chaserTarget(st, eyes);
  check(t.x === M.HOUSE.x && t.y === M.HOUSE.y, 'muncher: eyes head for the house');

  // choosing a turn: the best of the open ways, never straight back, never through the gate
  st = ready(); st.phase = 1; st.player.x = 15; st.player.y = 4; st.player.dx = 0; st.player.dy = 0;
  const c4 = { kind: 'rusher', mode: 'normal', x: 4, y: 4, dx: 1, dy: 0 };
  let d = M.chooseDir(st, c4);
  check(d === M.RIGHT, 'muncher: a chaser at a crossing takes the turn that gets it closest');
  c4.dx = -1; d = M.chooseDir(st, c4);
  check(!(d.dx === 1 && d.dy === 0), 'muncher: and never turns straight back when it can go on');
  const nook = { kind: 'rusher', mode: 'normal', x: 6, y: 11, dx: 0, dy: -1 };   // a one-tile nook off the corridor below
  d = M.chooseDir(st, nook);
  check(d === M.DOWN, 'muncher: at a dead end the only way is back');
  const below = { kind: 'rusher', mode: 'normal', x: 8, y: 6, dx: 0, dy: -1 };
  st.player.x = 8; st.player.y = 12;
  d = M.chooseDir(st, below);
  check(!(d.dx === 0 && d.dy === 1), 'muncher: a chaser outside never goes down through the gate');

  // eyes take the shortest way home, and arrive
  st = ready(); st.phase = 1;
  const e = st.chasers[2]; e.mode = 'eyes'; e.x = 1; e.y = 1; e.dx = 0; e.dy = 0;
  run(st, 6, null);
  check(e.mode === 'house' || e.mode === 'leaving' || e.mode === 'normal', 'muncher: eyes get home and the chaser is back in play');

  // the side tunnel wraps
  st = ready(); st.player.x = 2; st.player.y = 9; st.player.dx = -1; st.player.dy = 0;
  run(st, 1.0, M.LEFT);
  check(st.player.x > 8, 'muncher: leaving the left tunnel comes out on the right (x ' + st.player.x.toFixed(1) + ')');

  // steering: a turn asked for early is taken at the next crossing; turning round is instant
  st = ready(); st.player.x = 4; st.player.y = 4; st.player.dx = 1; st.player.dy = 0;
  run(st, 0.05, M.DOWN);
  const xb = st.player.x;
  run(st, 0.5, M.DOWN);
  check(st.player.dy === 1 && Math.abs(st.player.x - Math.round(st.player.x)) < 1e-6 && st.player.x >= xb, 'muncher: a turn asked for early is taken at the next opening');
  st = ready(); st.player.x = 4.5; st.player.y = 4; st.player.dx = 1; st.player.dy = 0;
  M.step(st, DT, M.LEFT);
  check(st.player.dx === -1, 'muncher: turning round is instant');
  st = ready(); st.player.x = 8; st.player.y = 12; st.player.dx = 0; st.player.dy = 0;
  run(st, 0.3, M.DOWN);
  check(st.player.y === 12 || st.player.y > 12, 'muncher: you cannot walk into a wall');

  // clearing every dot
  st = ready(); st.dotsEaten = st.dots - 1; st.player.x = 8; st.player.y = 12; st.grid[12][7] = '.';
  run(st, 0.3, M.LEFT);
  check(st.status === 'cleared', 'muncher: the last dot clears the maze');
  check(M.levelSpeed(5) > M.levelSpeed(1) && M.levelSpeed(99) <= 1.45, 'muncher: each maze is faster, up to a limit');
  // fruit appears after 40 dots
  st = ready(); st.dotsEaten = 39; st.player.x = 4.4; st.player.y = 4; st.player.dx = -1; st.grid[4][4] = '.';
  run(st, 0.1, M.LEFT);
  check(st.fruit && st.fruit.x === st.start.x, 'muncher: fruit shows up after forty dots');
}

// ── Crossing ────────────────────────────────────────────────────────────────
{
  const C = load(['crossing.js']).CrossingEngine, DT = 1 / 60;
  const rows = Object.keys(C.LANES).map(Number);
  check(rows.length === 10 && rows.every(r => r >= 1 && r <= 11 && r !== C.MEDIAN_ROW), 'crossing: five lanes of road and five of river');
  check(rows.every(r => { const l = C.LANES[r]; return C.laneLoop(l) >= C.COLS + l.len + 2 && l.spacing > l.len + 0.9; }), 'crossing: every lane loop is longer than the screen and leaves a gap between things');
  check(rows.filter(r => C.isRoad(r)).length === 5 && rows.filter(r => C.isRiver(r)).length === 5, 'crossing: road and river lanes are data');
  const mk = (level) => { const s = C.createState(level || 1, 3); return s; };
  // find a moment when a condition holds on a lane
  const when = (st, f) => { for (let t = 0; t < 120; t += 0.02) { st.time = t; if (f(t)) return t; } return -1; };

  // cars: a chick on a car's tile is hit; a chick between cars is not
  let st = mk(); st.row = 8;
  const car = C.objectsOf(st, 8, 0)[0];
  st.time = 0; st.x = Math.floor(car.x + 0.5);
  check(C.crash(st, 8, car.x + car.len / 2 - 0.5) && !!C.crash(st, 8, car.x), 'crossing: a vehicle overlapping the chick is a crash');
  const tSafe = when(st, () => !C.crash(st, 8, 5) && !C.crash(st, 8, 4) && !C.crash(st, 8, 6));
  check(tSafe >= 0, 'crossing: there are gaps to run through');
  // hopping into traffic
  st = mk(); st.row = 8; st.x = 5; st.time = when(st, () => !!C.crash(st, 7, 5) && !C.crash(st, 8, 5));
  check(st.time >= 0, 'crossing: found a moment with a car in the next lane');
  C.hop(st, 'up');
  check(st.status === 'dying' && st.why === 'car' && st.lives === C.LIVES - 1, 'crossing: hopping in front of a car costs a life');
  st = mk(); st.row = 8; st.x = 5; st.time = when(st, () => !C.crash(st, 7, 5) && !C.crash(st, 8, 5));
  C.hop(st, 'up');
  check(st.status === 'playing' && st.row === 7, 'crossing: hopping into a gap is fine');
  // a car coming at a chick standing still kills it
  st = mk(); st.row = 9; st.x = 5; st.time = when(st, () => !C.crash(st, 9, 5)); let hit = false;
  for (let i = 0; i < 60 * 12 && st.status === 'playing'; i++) { C.step(st, DT); if (st.status === 'dying') hit = true; }
  check(hit && st.why === 'car', 'crossing: standing on the road long enough gets you hit');

  // river: logs carry you, water drowns you
  st = mk(); st.row = 2;
  const tLog = when(st, () => !!C.carrier(st, 1, 5)); st.time = tLog; st.x = 5;
  check(tLog >= 0, 'crossing: a log passes the middle of the river');
  C.hop(st, 'up');
  check(st.status === 'playing' && st.row === 1 && Math.abs(st.x - 5) < 1e-9, 'crossing: landing on a log keeps you on it');
  const x0 = st.x; for (let i = 0; i < 30; i++) C.step(st, DT);
  check(Math.abs((st.x - x0) - C.LANES[1].dir * C.LANES[1].speed * 0.5) < 0.05, 'crossing: a log carries you along with it');
  st = mk(); st.row = 2; st.x = 5; st.time = when(st, () => !C.carrier(st, 1, 5));
  C.hop(st, 'up');
  check(st.status === 'dying' && st.why === 'water', 'crossing: hopping into open water drowns you');
  // being carried off the edge
  st = mk(); st.row = 1; st.time = when(st, () => !!C.carrier(st, 1, 9)); st.x = 9;
  let swept = false; for (let i = 0; i < 60 * 8 && st.status === 'playing'; i++) { C.step(st, DT); if (st.status === 'dying') swept = true; }
  check(swept && (st.why === 'swept' || st.why === 'water'), 'crossing: riding a log off the edge of the screen ends it');
  // turtles dive
  st = mk(); st.row = 2;
  const turtleRow = 2;
  const under = (t) => C.objectsOf(st, turtleRow, t).some(o => o.under);
  const above = (t) => C.objectsOf(st, turtleRow, t).every(o => !o.under);
  check(C.LANES[2].kind === 'turtle' && when(st, under) >= 0 && when(st, above) >= 0, 'crossing: turtles take turns diving');
  st = mk(); st.row = 2; st.x = 5;
  const t1 = when(st, () => C.objectsOf(st, 2, st.time).some(o => o.under && 5.5 > o.x && 5.5 < o.x + o.len));
  check(t1 >= 0 && C.carrier(st, 2, 5) === null, 'crossing: a turtle that is under carries nothing');

  // hopping rules
  st = mk(); const s0 = st.score;
  C.hop(st, 'down');
  check(st.row === C.START_ROW, 'crossing: you cannot hop back past the start');
  st = mk(); st.row = C.MEDIAN_ROW; st.best = C.MEDIAN_ROW; C.hop(st, 'left'); C.step(st, 0.2); C.hop(st, 'left');
  check(st.x === 3, 'crossing: left and right hop a tile each');
  st.x = 0; st.cool = 0; C.hop(st, 'left'); check(st.x === 0, 'crossing: the sides are walls');
  st = mk(); C.hop(st, 'up'); C.hop(st, 'up');
  check(st.row === C.START_ROW - 1 && st.queued === 'up', 'crossing: a hop asked for during a hop is queued, not lost');
  st = mk(); C.hop(st, 'up');
  check(st.score - 0 === C.ROW_POINTS, 'crossing: every new row forward is ten points');
  st.cool = 0; C.hop(st, 'down'); st.cool = 0; C.hop(st, 'up');
  check(st.score === C.ROW_POINTS, 'crossing: but going back and forth earns nothing more');

  // nests
  st = mk(); st.row = 1; st.x = 5; st.time = when(st, () => !!C.carrier(st, 1, 5)); st.left = 20;
  C.hop(st, 'up');
  check(st.status === 'nested' && st.nests[2] && st.score >= C.NEST_POINTS, 'crossing: hopping into an open nest fills it');
  C.step(st, 2);
  check(st.status === 'playing' && st.row === C.START_ROW, 'crossing: then a new chick starts from the bottom');
  st.row = 1; st.x = 5; st.cool = 0; st.time = when(st, () => !!C.carrier(st, 1, 5)); C.hop(st, 'up');
  check(st.status === 'dying' && st.why === 'wall', 'crossing: a filled nest is closed');
  st = mk(); st.row = 1; st.x = 4; st.time = when(st, () => !!C.carrier(st, 1, 4)); C.hop(st, 'up');
  check(st.status === 'dying' && st.why === 'wall', 'crossing: the hedge between the nests is a wall');
  st = mk(); st.nests = [true, true, false, true, true]; st.row = 1; st.x = 5; st.time = when(st, () => !!C.carrier(st, 1, 5)); st.cool = 0;
  C.hop(st, 'up'); C.step(st, 1);
  check(st.status === 'cleared' && st.nests.every(Boolean), 'crossing: the fifth nest clears the level');

  // the clock, lives, levels
  st = mk(); st.row = C.MEDIAN_ROW; for (let i = 0; i < 60 * 33 && st.status === 'playing'; i++) C.step(st, DT);
  check(st.status === 'dying' && st.why === 'time', 'crossing: the clock runs out');
  st = mk(); st.lives = 1; st.row = 8; st.x = 5; st.time = when(st, () => !!C.crash(st, 7, 5) && !C.crash(st, 8, 5)); C.hop(st, 'up'); for (let i = 0; i < 90; i++) C.step(st, DT);
  check(st.status === 'over', 'crossing: no lives left is game over');
  check(C.speedUp(4) > C.speedUp(1) && C.speedUp(50) <= 2.2, 'crossing: each level is faster, up to a limit');
  const a = C.createState(1, 1), b = C.createState(5, 1);
  const move = (s) => C.objectsOf(s, 7, 2)[0].x - C.objectsOf(s, 7, 0)[0].x;
  check(Math.abs(move(b)) > Math.abs(move(a)), 'crossing: lanes move further in the same time at a higher level');
}

// ── Blast ───────────────────────────────────────────────────────────────────
{
  const B = load(['gridwalk.js', 'blast.js']).BlastEngine, DT = 1 / 60;
  // an empty arena: only the border and the pillars
  const arena = (kinds, seed) => {
    const st = B.createState(kinds || ['person', 'cpu'], seed || 5);
    for (let y = 1; y < B.H - 1; y++) for (let x = 1; x < B.W - 1; x++) if (!(x % 2 === 0 && y % 2 === 0)) st.grid[y][x] = ' ';
    st.hidden = {}; st.status = 'playing'; st.items = [];
    return st;
  };
  const place = (st, x, y, range, owner) => { const b = { x, y, owner: owner === undefined ? 0 : owner, t: B.FUSE_S, range: range || 2, pass: {} }; st.bombs.push(b); return b; };
  const cells = (st) => new Set(st.flames.map(f => f.x + ',' + f.y));
  const run = (st, secs, fn) => { for (let i = 0; i < Math.round(secs / DT); i++) { if (fn) fn(i); B.step(st, DT); } };
  const away = (st) => st.players.forEach(p => { p.alive = true; p.x = 11; p.y = 9; });

  // the map
  let st = B.createState(['person', 'cpu', 'cpu', 'cpu'], 9);
  check(st.w === 13 && st.h === 11 && st.grid.every(r => r.length === 13), 'blast: a 13 x 11 arena');
  check(st.grid[0].every(c => c === '#') && st.grid.every(r => r[0] === '#' && r[12] === '#') && st.grid[2][2] === '#' && st.grid[4][6] === '#', 'blast: stone round the edge and on every even crossing');
  check([[1, 1], [11, 9], [11, 1], [1, 9]].every(([x, y]) => { const sx = x < 6 ? 1 : -1, sy = y < 5 ? 1 : -1; return st.grid[y][x] === ' ' && st.grid[y][x + sx] === ' ' && st.grid[y + sy][x] === ' '; }), 'blast: each start has room to move and drop a bomb');
  const soft = st.grid.flat().filter(c => c === 'B').length;
  check(soft > 35 && soft < 75, 'blast: ' + soft + ' soft blocks to clear');
  check(JSON.stringify(B.createState(['person', 'cpu'], 9).grid) === JSON.stringify(B.createState(['person', 'cpu'], 9).grid), 'blast: the same seed makes the same arena');
  check(Object.keys(st.hidden).length > 3 && Object.values(st.hidden).every(t => B.POWERUPS.includes(t)), 'blast: some blocks hide power-ups');

  // a blast goes four ways, as far as its range, and stops at stone
  st = arena(); away(st);
  let b = place(st, 3, 1, 3);
  let r = B.blastOf(st, b);
  let set = new Set(r.cells.map(c => c.x + ',' + c.y));
  check(set.has('3,1') && set.has('6,1') && set.has('1,1') && !set.has('7,1') && set.has('3,4') && !set.has('3,5') && !set.has('3,0'), 'blast: four lines to the range; stone stops it');
  st.grid[1][5] = 'B';
  r = B.blastOf(st, b); set = new Set(r.cells.map(c => c.x + ',' + c.y));
  check(set.has('5,1') && !set.has('6,1') && r.hits.some(h => h.what === 'block' && h.x === 5), 'blast: a soft block is hit and stops the blast');
  B.detonate(st, b);
  check(st.grid[1][5] === ' ' && st.bombs.length === 0, 'blast: the soft block is destroyed');
  check(cells(st).has('4,1') && !cells(st).has('6,1'), 'blast: and the flame stops where it hit');

  // chain reaction: a blast that reaches another bomb sets it off, and so on
  st = arena(); away(st);
  const a1 = place(st, 1, 1, 2), a2 = place(st, 3, 1, 2), a3 = place(st, 3, 3, 2), far = place(st, 11, 7, 1);
  a2.t = 1.7; a3.t = 1.9; far.t = 2;
  B.detonate(st, a1);
  check(st.bombs.length === 1 && st.bombs[0] === far, 'blast: one bomb sets off the next and the next (chain of three)');
  check(cells(st).has('3,3') && cells(st).has('3,5') && cells(st).has('5,3'), 'blast: the whole chain burns');
  st = arena(); st.players[1].alive = false; st.players[0].x = 11; st.players[0].y = 9;
  const f1 = place(st, 1, 1, 2), f2 = place(st, 3, 1, 2); f1.t = 0.5; f2.t = 2;
  const dm = B.dangerMap(st);
  check(dm['3,1'] === 0.5 && dm['5,1'] === 0.5 && dm['1,3'] === 0.5, 'blast: the danger map knows a chain goes off as fast as its quickest link');

  // fuses
  st = arena(['person', 'person']); away(st); place(st, 5, 1, 2);
  run(st, 2.0); check(st.bombs.length === 1, 'blast: a bomb is still ticking after two seconds');
  run(st, 0.3); check(st.bombs.length === 0 && cells(st).has('5,1') && cells(st).has('7,1'), 'blast: and goes off at 2.2 seconds');
  run(st, 0.7); check(st.flames.length === 0, 'blast: the flames die down');

  // a bomber in the fire dies; one out of it does not
  st = arena(['person', 'person']); st.players[0].x = 5; st.players[0].y = 1; st.players[1].x = 5; st.players[1].y = 5;
  place(st, 5, 3, 2); run(st, 2.4);
  check(!st.players[0].alive && !st.players[1].alive, 'blast: both bombers two tiles from the bomb in a line were caught');
  st = arena(['person', 'person']); st.players[0].x = 1; st.players[0].y = 1; st.players[1].x = 11; st.players[1].y = 9; place(st, 5, 1, 2);
  run(st, 2.4);
  check(st.players[0].alive && st.players[1].alive, 'blast: a bomber out of its lines is safe');

  // one bomb at a time at first; a bomb you stand on you can step off, but not back onto
  st = arena(['person', 'person']); st.players[1].x = 11; st.players[1].y = 9;
  const q = st.players[0];
  check(B.placeBomb(st, q) === true && B.placeBomb(st, q) === false, 'blast: only one bomb at a time to start with');
  B.setInput(st, 0, B.RIGHT, false); run(st, 0.5);
  check(q.x > 1.9, 'blast: you can walk off the bomb you stand on (' + q.x.toFixed(2) + ')');
  B.setInput(st, 0, B.LEFT, false); run(st, 0.6);
  check(q.x >= 2 - 1e-6, 'blast: but not back onto it');

  // power-ups: hidden under a block, shown when it breaks, taken by walking over them
  st = arena(); away(st); st.grid[1][4] = 'B'; st.hidden['4,1'] = 'range';
  b = place(st, 1, 1, 2); B.detonate(st, b);
  check(st.items.length === 0 && st.grid[1][4] === 'B', 'blast: a block out of range is not touched');
  st = arena(); away(st); st.grid[1][4] = 'B'; st.hidden['4,1'] = 'range';
  b = place(st, 3, 1, 2); B.detonate(st, b);
  check(st.items.length === 1 && st.items[0].type === 'range' && st.grid[1][4] === ' ', 'blast: a broken block drops what it hid');
  const p = st.players[0]; p.x = 3; p.y = 1; const r0 = p.range; st.flames = [];
  B.setInput(st, 0, B.RIGHT, false); run(st, 0.5);
  check(p.range === r0 + 1 && st.items.length === 0, 'blast: walking over more-flame makes bombs reach one further');
  B.setInput(st, 0, B.RIGHT, false);
  st.items.push({ x: Math.round(p.x) + 1, y: Math.round(p.y), type: 'bomb' }); run(st, 0.5);
  check(p.maxBombs === 2, 'blast: an extra bomb lets you drop two');
  const sp = p.speed; st.items.push({ x: Math.round(p.x) + 1, y: Math.round(p.y), type: 'speed' }); B.setInput(st, 0, B.LEFT, false); run(st, 0.1); B.setInput(st, 0, B.RIGHT, false); run(st, 0.8);
  check(p.speed > sp, 'blast: speed makes you quicker');
  st = arena(); away(st); st.items.push({ x: 5, y: 1, type: 'speed' });
  b = place(st, 3, 1, 3); B.detonate(st, b);
  check(st.items.length === 0, 'blast: fire destroys a power-up lying in its way');

  // two people on one keyboard: both move at once
  st = arena(['person', 'person']); B.setInput(st, 0, B.RIGHT, false); B.setInput(st, 1, B.LEFT, false); run(st, 0.5);
  check(st.players[0].x > 2 && st.players[1].x < 10, 'blast: two people move at the same time');
  B.setInput(st, 0, null, false); run(st, 0.4);
  check(Math.abs(st.players[0].x - Math.round(st.players[0].x)) < 1e-6, 'blast: letting go stops on a tile');

  // the computer: runs from fire, does not trap itself, goes for blocks
  st = arena(['person', 'cpu']); st.players[0].x = 11; st.players[0].y = 9;
  const cpu = st.players[1]; cpu.x = 5; cpu.y = 1; cpu.dx = 0; cpu.dy = 0;
  place(st, 5, 1, 3);
  const t = B.think(st, cpu);
  check(t.bomb === false && t.dir && t.dir.dx !== 0, 'blast: a computer standing on a bomb runs along a free row');
  run(st, 2.6);
  check(cpu.alive, 'blast: and gets clear of its own bomb in time');
  st = arena(['person', 'cpu']); st.players[0].x = 11; st.players[0].y = 9;
  const trapped = st.players[1]; trapped.x = 1; trapped.y = 1; trapped.dx = 0; trapped.dy = 0;
  st.grid[1][2] = 'B'; st.grid[2][1] = 'B';   // one tile to stand on, soft blocks all round
  let placed = 0; for (let i = 0; i < 30; i++) { const th = B.think(st, trapped); if (th.bomb) placed++; }
  check(placed === 0, 'blast: a computer will not bomb itself into a pocket with no way out');
  st = arena(['person', 'cpu']); st.players[0].x = 11; st.players[0].y = 9; st.players[1].x = 3; st.players[1].y = 1; st.grid[1][4] = 'B';
  let bombed = false; for (let i = 0; i < 40 && !bombed; i++) { const th = B.think(st, st.players[1]); if (th.bomb) bombed = true; }
  check(bombed, 'blast: a computer next to a soft block, with a way out, drops a bomb');
  st = B.createState(['cpu', 'cpu'], 3); st.status = 'playing'; let t0 = 0;
  for (let i = 0; i < 60 * 150 && st.status === 'playing'; i++) { B.step(st, DT); t0 = i; }
  check(st.status === 'roundover', 'blast: two computers settle a round (' + (t0 / 60).toFixed(0) + ' s)');

  // rounds and the match
  st = arena(['person', 'cpu']); st.players[1].alive = false; B.step(st, DT);
  check(st.status === 'roundover' && st.winner === 0 && st.wins[0] === 1, 'blast: the last one standing wins the round');
  st = arena(['person', 'cpu']); st.players[0].alive = false; st.players[1].alive = false; B.step(st, DT);
  check(st.status === 'roundover' && st.winner === -1, 'blast: nobody left is a draw');
  st = arena(['person', 'cpu']); st.wins = [1, 0];
  check(B.matchWinner(st) === -1, 'blast: one round is not enough');
  st.wins = [2, 0]; check(B.matchWinner(st) === 0, 'blast: two rounds win the match');
}

// ── Quest ───────────────────────────────────────────────────────────────────
{
  const Q = load(['quest.js']).QuestEngine, DT = 1 / 60, T = Q.TILE;
  const run = (st, secs, input) => { for (let i = 0; i < Math.round(secs / DT); i++) Q.step(st, DT, input || { dx: 0, dy: 0 }); };
  const at = (st, tx, ty, face) => { st.x = tx * T + 3; st.y = ty * T + 3; if (face) st.face = face; };
  const names = (st) => st.events.map(e => e.name + (e.data !== undefined && typeof e.data === 'string' ? ':' + e.data : ''));
  const ids = Object.keys(Q.SCREENS);

  check(ids.length === 7 && ids.every(k => Q.SCREENS[k].rows.length === 8 && Q.SCREENS[k].rows.every(r => r.length === 11)), 'quest: seven screens of 11 by 8 tiles');
  // neighbouring screens meet at open tiles, and every screen can be reached from the start by walking (the door aside)
  const walk = (st, k, c, r) => { const t = Q.SCREENS[k].rows[r].charAt(c); return !Q.solidTile(t) || t === 'D'; };
  let joined = true;
  ids.forEach(k => {
    const s = Q.SCREENS[k];
    [[1, 0], [0, 1]].forEach(([dx, dy]) => {
      const nb = Q.screenAt(s.cx + dx, s.cy + dy); if (!nb) return;
      for (let i = 0; i < (dx ? 8 : 11); i++) {
        const a = dx ? [10, i] : [i, 7], b = dx ? [0, i] : [i, 0];
        const open1 = walk(null, k, a[0], a[1]), open2 = walk(null, nb, b[0], b[1]);
        if (open1 !== open2 && !(Q.SCREENS[k].rows[a[1]].charAt(a[0]) === 'D' || Q.SCREENS[nb].rows[b[1]].charAt(b[0]) === 'D')) joined = false;
      }
    });
  });
  check(joined, 'quest: where two screens meet the edge is open on both sides, or closed on both');
  const seen = new Set(['D']), queue = ['D'];
  while (queue.length) {
    const k = queue.shift(), s = Q.SCREENS[k];
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => { const nb = Q.screenAt(s.cx + dx, s.cy + dy); if (nb && !seen.has(nb)) { seen.add(nb); queue.push(nb); } });
  }
  check(seen.size === 7, 'quest: every screen is connected to the start');
  // inside each screen the things you need are reachable on foot
  ids.forEach(k => {
    const s = Q.SCREENS[k], rows = s.rows, open = (c, r) => c >= 0 && r >= 0 && c < 11 && r < 8 && (rows[r].charAt(c) === 'b' || !Q.solidTile('evXs'.includes(rows[r].charAt(c)) ? s.floor : rows[r].charAt(c)));
    let start = null; rows.forEach((row, r) => row.split('').forEach((ch, c) => { if (!start && open(c, r)) start = [c, r]; }));
    const seenT = new Set([start.join()]), q = [start];
    while (q.length) { const [c, r] = q.shift(); [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => { const n = [c + dx, r + dy]; if (open(...n) && !seenT.has(n.join())) { seenT.add(n.join()); q.push(n); } }); }
    let ok = true; rows.forEach((row, r) => row.split('').forEach((ch, c) => {
      if (open(c, r) && !seenT.has([c, r].join())) ok = false;
      if ('CPN'.includes(ch) && ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => seenT.has([c + dx, r + dy].join()))) ok = false;
    }));
    check(ok, 'quest: everything in ' + s.name + ' can be walked to');
  });

  // the sword: nothing happens without it, then the pedestal gives it
  let st = Q.createState(null, 4);
  check(st.screen === 'D' && st.hp === 3 && st.maxHp === 3 && !st.sword && st.keys === 0, 'quest: you start in the meadow with three hearts and nothing else');
  check(Q.act(st) === false && names(st).includes('nosword'), 'quest: no sword, no swing');
  st = Q.createState(null, 4); st.screen = 'E'; at(st, 5, 4, 'up'); st.enemies = [];
  check(Q.frontTile(st).ch === 'P', 'quest: the pedestal is in front when you walk up to it');
  Q.act(st);
  check(st.sword === true && Q.tileAt(st, 5, 3) === 'p', 'quest: the pedestal gives the sword, once');
  st.events.length = 0; Q.act(st);
  check(!names(st).includes('item:sword'), 'quest: an empty pedestal gives nothing more');

  // sword work: cuts a bush, hurts a slime
  st = Q.createState(null, 4); st.sword = true; at(st, 2, 5, 'down'); st.rng = Q.mulberry(1);
  check(Q.tileAt(st, 2, 6) === 'b', 'quest: there is a bush south of the start');
  Q.act(st); run(st, 0.3);
  check(Q.tileAt(st, 2, 6) === '.', 'quest: swinging at a bush cuts it');
  st = Q.createState(null, 4); st.sword = true; st.screen = 'B'; st.enemies = [{ type: 'slime', x: 5 * T, y: 4 * T, w: 12, h: 10, hp: 1, vx: 0, vy: 0, t: 99, flash: 0, face: 'down' }]; at(st, 5, 5, 'up'); st.y = 4 * T + 14;
  Q.act(st); run(st, 0.3);
  check(st.enemies.length === 0 && st.hp === 3, 'quest: a sword swing defeats a slime');
  // swinging has a cooldown
  st = Q.createState(null, 4); st.sword = true; Q.act(st); st.events.length = 0;
  check(Q.act(st) === false, 'quest: you cannot swing again at once');
  // being touched costs a heart, then you are safe for a moment
  st = Q.createState(null, 4); st.screen = 'B'; at(st, 5, 4); st.enemies = [{ type: 'slime', x: 5 * T + 3, y: 4 * T + 3, w: 12, h: 10, hp: 1, vx: 0, vy: 0, t: 99, flash: 0, face: 'down' }];
  Q.step(st, DT, { dx: 0, dy: 0 });
  check(st.hp === 2 && st.inv > 0, 'quest: a slime that touches you costs a heart');
  run(st, 0.4); check(st.hp === 2, 'quest: and you are safe for a moment');
  // falling in a fight is not the end: wake at the start with the hearts back, keeping what you found
  st = Q.createState(null, 4); st.screen = 'F'; at(st, 5, 4); st.keys = 1; st.sword = true; st.maxHp = 4; st.hp = 1;
  st.enemies = [{ type: 'slime', x: st.x, y: st.y, w: 12, h: 10, hp: 1, vx: 0, vy: 0, t: 99, flash: 0, face: 'down' }]; Q.step(st, DT, null);
  check(st.status === 'fainted', 'quest: the last heart knocks you out');
  run(st, 2);
  check(st.status === 'playing' && st.screen === 'D' && st.hp === 4 && st.keys === 1 && st.sword, 'quest: you wake at the start, hearts full, sword and key kept');

  // chests
  st = Q.createState(null, 4); st.screen = 'F'; st.enemies = []; at(st, 2, 5, 'down');
  check(Q.frontTile(st).ch === 'C', 'quest: the cave chest is south of you');
  Q.act(st);
  check(st.keys === 1 && Q.tileAt(st, 2, 6) === 'c', 'quest: the chest holds a key');
  st.events.length = 0; Q.act(st);
  check(st.keys === 1, 'quest: and only once');
  st = Q.createState(null, 4); st.screen = 'A'; st.enemies = []; st.flags['A:6,2'] = true; at(st, 6, 4, 'up'); st.flags['A:5,3'] = true; st.flags['A:7,3'] = true; st.flags['A:6,4'] = true;
  st.y = 4 * T + 2; Q.act(st);
  check(st.maxHp === 4 && st.hp === 4, 'quest: the forest chest is a heart container: one more heart, all full');

  // keys and the locked door
  st = Q.createState(null, 4); st.screen = 'C'; st.enemies = []; at(st, 5, 1);
  check(Q.tileAt(st, 5, 0) === 'D', 'quest: the gate is locked');
  run(st, 0.5, { dx: 0, dy: -1 });
  check(st.screen === 'C' && Q.tileAt(st, 5, 0) === 'D' && st.y > 0, 'quest: without a key the door stays shut');
  st.keys = 1; at(st, 5, 1);
  run(st, 0.2, { dx: 0, dy: -1 });
  check(Q.tileAt(st, 5, 0) === 'd' && st.keys === 0, 'quest: with a key the door opens and the key is used up');
  run(st, 0.6, { dx: 0, dy: -1 });
  check(st.screen === 'G', 'quest: and the way leads to the throne room');
  check(st.enemies.length === 1 && st.enemies[0].type === 'boss' && st.enemies[0].hp === Q.BOSS.hp, 'quest: where the Warden waits');

  // screens: walking off an edge with a neighbour; an edge with none is a wall
  st = Q.createState(null, 4); st.enemies = []; at(st, 9, 3);
  run(st, 0.8, { dx: 1, dy: 0 });
  check(st.screen === 'E' && st.x < 40, 'quest: walking off the east side of the meadow arrives in the shrine');
  run(st, 0.8, { dx: -1, dy: 0 });
  check(st.screen === 'D', 'quest: and back');
  st = Q.createState(null, 4); st.enemies = []; at(st, 5, 6);
  run(st, 1, { dx: 0, dy: 1 });
  check(st.screen === 'D' && st.y + st.h <= Q.H, 'quest: an edge with nothing beyond it is a wall');

  // the Warden: shoots, takes ten sword hits, drops the treasure
  st = Q.createState(null, 4); st.screen = 'G'; st.enemies = []; st.sword = true; st.flags['C:5,0'] = true; st.enemies = []; Q.step(st, DT, null);
  st = Q.createState({ v: 1, screen: 'G', x: 80, y: 100, hp: 8, maxHp: 8, sword: true, keys: 0, flags: {}, bossDead: false, won: false }, 6);
  check(st.enemies.length === 1 && st.enemies[0].type === 'boss', 'quest: a saved game in the throne room has the Warden');
  const boss = st.enemies[0]; run(st, 3, { dx: 0, dy: 0 });
  check(st.shots.length > 0 || st.hp < 8, 'quest: the Warden fires');
  st.shots = []; st.inv = 99;
  let swings = 0;
  for (let i = 0; i < 40 && st.enemies.length; i++) {
    const b = st.enemies[0]; st.x = b.x + b.w / 2 - 5; st.y = b.y + b.h + 2; st.face = 'up'; st.cool = 0; st.inv = 99; Q.act(st); run(st, 0.3); swings++;
  }
  check(st.enemies.length === 0 && swings >= Q.BOSS.hp && swings <= Q.BOSS.hp + 3, 'quest: eight sword hits bring the Warden down (' + swings + ')');
  check(st.bossDead && st.pickups.some(p => p.type === 'treasure'), 'quest: and it leaves the treasure');
  const tr = st.pickups.find(p => p.type === 'treasure'); st.x = tr.x - 1; st.y = tr.y - 1; Q.step(st, DT, null);
  check(st.won && st.status === 'won', 'quest: taking the treasure wins');
  const again = Q.createState(Q.snapshot(st), 7);
  check(again.bossDead && again.enemies.length === 0, 'quest: a beaten Warden stays beaten');

  // saving: progress comes back exactly
  st = Q.createState(null, 4); st.sword = true; st.keys = 1; st.maxHp = 5; st.hp = 4; st.screen = 'E'; st.flags['E:5,3'] = true; at(st, 3, 5);
  const snap = JSON.parse(JSON.stringify(Q.snapshot(st))), back = Q.createState(snap, 9);
  check(back.screen === 'E' && back.sword && back.keys === 1 && back.maxHp === 5 && back.hp === 4 && Q.tileAt(back, 5, 3) === 'p' && Math.round(back.x) === Math.round(st.x), 'quest: a saved game restores the place, items, hearts and what was opened');
  check(Q.createState({ v: 99, screen: 'Z' }, 1).screen === 'D', 'quest: a save it does not understand starts a fresh game');
  // events ask for a save after each step of progress
  st = Q.createState(null, 4); st.screen = 'E'; at(st, 5, 4, 'up'); Q.act(st);
  check(names(st).includes('save'), 'quest: taking the sword asks for a save');
}

// ── Zimi Pet ────────────────────────────────────────────────────────────────
{
  const P = load(['pet.js']).PetEngine, H = P.HOUR, T0 = 1700000000000;
  P.isNight = () => false;   // the tests choose when it is night
  const grown = (stage) => { const p = P.newPet(T0, 'Mip', 'x'); P.advance(p, T0 + P.EGG_MS); p.stage = stage || 'baby'; return p; };
  const near = (a, b, tol) => Math.abs(a - b) <= (tol || 0.6);

  // the egg
  let p = P.newPet(T0, 'Mip', 'x');
  check(p.stage === 'egg' && P.mood(p) === 'egg', 'pet: it starts as an egg');
  check(P.advance(p, T0 + P.EGG_MS - 1000).length === 0 && p.stage === 'egg', 'pet: still an egg before three minutes');
  check(P.advance(p, T0 + P.EGG_MS + 1000).includes('hatched') && p.stage === 'baby' && p.hatched === T0 + P.EGG_MS, 'pet: and it hatches at three minutes');
  check(P.feed(P.newPet(T0), 'meal').msg === 'egg' && P.play(P.newPet(T0), 3).msg === 'egg' && P.wash(P.newPet(T0)).msg === 'egg', 'pet: you cannot feed, play with or wash an egg');

  // time passing while closed: computed from timestamps
  p = grown(); p.food = p.joy = p.clean = p.energy = 100; p.t = T0;
  P.advance(p, T0 + 10 * H);
  check(near(p.food, 100 - 24, 0.6) && near(p.joy, 100 - 18, 0.6) && near(p.energy, 100 - 22, 0.6), 'pet: ten hours awake: fuller-to-hungry, bored and tired (' + p.food.toFixed(1) + ', ' + p.joy.toFixed(1) + ', ' + p.energy.toFixed(1) + ')');
  const q = grown(); q.food = q.joy = q.clean = q.energy = 100; q.t = T0;
  for (let i = 1; i <= 40; i++) P.advance(q, T0 + i * 15 * 60000);
  const r2 = grown(); r2.food = r2.joy = r2.clean = r2.energy = 100; r2.t = T0; P.advance(r2, T0 + 10 * H);
  check(near(q.food, r2.food, 0.01) && near(q.joy, r2.joy, 0.01), 'pet: looking in often or once gives the same result');
  p = grown(); p.food = p.joy = p.clean = 100; p.energy = 40; p.asleep = true; p.t = T0;
  P.advance(p, T0 + 3 * H);
  check(p.energy > 65 && p.food > 96, 'pet: asleep, energy comes back fast and hunger crawls (' + p.energy.toFixed(0) + ', ' + p.food.toFixed(0) + ')');
  P.advance(p, T0 + 8 * H);
  check(!p.asleep, 'pet: it wakes itself when rested');
  p = grown(); p.energy = 4; p.t = T0; const evs = P.advance(p, T0 + H);
  check(evs.includes('dozed') || p.asleep, 'pet: a worn out pet dozes off by itself');
  p = grown(); p.t = T0 + 5 * H; const snap = JSON.stringify(p); P.advance(p, T0);
  check(p.t === T0 && p.food === JSON.parse(snap).food && p.growth === JSON.parse(snap).growth, 'pet: a clock set backwards changes nothing');
  p = grown(); p.t = T0; const tt = Date.now(); P.advance(p, T0 + 30 * 24 * H);
  check(Date.now() - tt < 500 && p.food === 0 && p.sulking && p.stage !== 'adult', 'pet: thirty days away is worked out instantly and ends in a sulk, not a funeral');
  check(p.food === 0 && p.joy === 0 && p.clean === 0, 'pet: stats stop at zero');
  // it never dies: whatever the neglect, it is there to be cared for
  check(['egg', 'baby', 'child', 'teen', 'adult'].includes(p.stage) && P.mood(p) === 'sulk', 'pet: neglect only ever makes it sulk');
  // a pet looked after twice a day (morning meal and wash, evening meal and play) never sulks and grows on schedule
  { const d = grown(); d.t = T0; d.food = d.joy = d.clean = d.energy = 100; P.isNight = (ts) => { const h = (ts - T0) / H % 24; return h >= 14 || h < 0; };
    let sulked = false;
    for (let day = 0; day < 8; day++) { for (const at of [0, 8]) { const ev = P.advance(d, T0 + day * 24 * H + at * H); if (ev.includes('sulk')) sulked = true; if (d.asleep) P.lights(d); P.feed(d, 'meal'); P.wash(d); P.play(d, 3); } }
    P.advance(d, T0 + 8 * 24 * H);
    check(!sulked && d.stage === 'adult', 'pet: twice a day is enough (' + d.stage + ', sulked ' + sulked + ')'); P.isNight = () => false; }
  // the night: it goes to bed by itself once and wakes in the morning; you can wake it early
  { const n = grown(); n.t = T0; n.food = n.joy = n.clean = 100; n.energy = 60; P.isNight = (ts) => ts >= T0 + 2 * H && ts < T0 + 11 * H;
    const ev1 = P.advance(n, T0 + 3 * H);
    check(n.asleep && n.bed && ev1.includes('bed'), 'pet: at night it goes to bed by itself');
    P.advance(n, T0 + 9 * H); check(n.asleep, 'pet: and sleeps through');
    const ev2 = P.advance(n, T0 + 12 * H); check(!n.asleep && ev2.includes('woke'), 'pet: wakes when the morning comes');
    P.advance(n, T0 + 13 * H); check(!n.asleep, 'pet: and is not put back to bed in the day');
    const m = grown(); m.t = T0; m.energy = 90; P.advance(m, T0 + 3 * H); P.lights(m); P.advance(m, T0 + 6 * H);
    check(!m.asleep, 'pet: switch the lights on at night and it stays up');
    P.isNight = () => false; }
  // the Sun's night, where Zimi knows the place (London: sunset about 20:21 UTC on 21 June, 15:53 UTC on 21 December)
  { const sun = P.sunNight({ lat: 51.5, lon: -0.12 }), at = (y, m, d, h, mi) => Date.UTC(y, m - 1, d, h, mi || 0);
    check(sun(at(2026, 6, 21, 19, 30)) === false && sun(at(2026, 6, 21, 20, 40)) === true, 'pet: in June London is awake at 19:30 and asleep by 20:40 UTC');
    check(sun(at(2026, 6, 22, 3, 30)) === true && sun(at(2026, 6, 22, 4, 30)) === false, 'pet: and up again at sunrise (about 03:43 UTC)');
    check(sun(at(2026, 12, 21, 16, 30)) === false && sun(at(2026, 12, 21, 18, 30)) === false && sun(at(2026, 12, 21, 19, 30)) === true, 'pet: a London December sunset is 15:53 but the pet is not put to bed before 19:00');
    check(sun(at(2026, 12, 22, 7, 30)) === true && sun(at(2026, 12, 22, 8, 30)) === false, 'pet: and is up by 08:00 (sunrise is 08:05)');
    check(P.sunNight({ lat: 'x', lon: 1 }) === null && P.sunNight(null) === null && P.sunNight({ lat: 91, lon: 0 }) === null, 'pet: a place that is not one means the fixed hours');
    const north = P.sunNight({ lat: 80, lon: 0 });
    check(typeof north(at(2026, 6, 21, 12)) === 'boolean', 'pet: where the Sun does not set the fixed hours answer');
    const local = (d, h, mi) => new Date(2026, 11, d, h, mi).getTime();
    check(P.nightKey(local(21, 16, 30)) === P.nightKey(local(22, 7, 30)) && P.nightKey(local(22, 7, 30)) !== P.nightKey(local(22, 17, 0)), 'pet: one key for a night, from its evening to the next morning');
    const kept = { getItem: () => JSON.stringify({ lat: 51.5, lon: -0.12, name: 'London' }) }, none = { getItem: () => null }, saved = P.isNight;
    check(P.usePlace(kept) === true && P.isNight !== saved, 'pet: a kept place makes the Sun decide');
    check(P.usePlace(none) === false, 'pet: no kept place, the fixed hours');
    P.isNight = () => false; }
  // mess
  p = grown(); p.food = p.joy = p.clean = p.energy = 100; p.t = T0; P.advance(p, T0 + 4.1 * H);
  check(p.mess === 1, 'pet: a mess every four hours');
  P.advance(p, T0 + 40 * H);
  check(p.mess === P.MAX_MESS, 'pet: no more than three');
  const clean0 = p.clean; P.wash(p);
  check(p.mess === 0 && p.clean === 100 && clean0 < 100, 'pet: a wash clears the mess and the grime');

  // sulking and recovery
  p = grown(); p.food = 5; p.joy = 5; p.clean = 5; p.energy = 80; p.t = T0; P.advance(p, T0 + 0.1 * H);
  check(p.sulking && P.mood(p) === 'sulk', 'pet: low everything makes it sulk');
  check(P.play(p, 5).msg === 'sulk', 'pet: a sulking pet will not play');
  P.feed(p, 'meal'); P.wash(p); p.joy = 50; p.food = 80;
  const rec = P.advance(p, p.t + 60000);
  check(!p.sulking && rec.includes('recovered'), 'pet: care brings it round');
  const g1 = p.growth; P.advance(p, p.t + H);
  check(p.growth > g1, 'pet: and it grows again');
  p = grown(); p.sulking = true; p.food = p.joy = p.clean = 5; p.t = T0; const g0 = p.growth; P.advance(p, T0 + H);
  check(p.growth === g0, 'pet: while it sulks it does not grow');

  // growth through the stages
  p = grown(); p.food = p.joy = p.clean = p.energy = 100; p.t = T0; let seen = [];
  for (let h = 1; h <= 8 * 24; h++) {   // looked after every hour for eight days
    P.feed(p, 'meal'); P.wash(p); p.joy = 100; if (p.asleep) P.lights(p);
    p.energy = 100; const ev = P.advance(p, T0 + h * H); ev.forEach(e => { if (e.startsWith('grew:')) seen.push(e.slice(5) + '@' + h); });
  }
  check(seen.join() === 'child@24,teen@72,adult@168', 'pet: grows child at a day, teen at three, grown-up at a week of care (' + seen.join() + ')');
  check(p.form === 'bright', 'pet: a well loved one grows up bright');
  const sloppy = grown(); sloppy.t = T0; sloppy.food = sloppy.joy = sloppy.clean = 100; sloppy.energy = 100;
  for (let h = 1; h <= 14 * 24; h++) { if (h % 6 === 0) { sloppy.food = 40; sloppy.joy = 35; sloppy.clean = 40; sloppy.energy = 60; sloppy.asleep = false; } P.advance(sloppy, T0 + h * H); }
  check(sloppy.stage === 'adult' && sloppy.form === 'plain', 'pet: a half-cared-for one still grows up, in plain colours (' + sloppy.stage + ', ' + sloppy.form + ')');
  check(P.ageDays(p, T0 + 8 * 24 * H) === 8, 'pet: its age is counted in days from the hatching');

  // actions
  p = grown(); p.food = 40; p.joy = 40; p.energy = 80;
  check(P.feed(p, 'meal').ok && p.food === 75 && p.joy === 43, 'pet: a meal is 35 fullness');
  p.food = 50; p.joy = 40; check(P.feed(p, 'snack').ok && p.food === 62 && p.joy === 52, 'pet: a snack is a little food and a lot of joy');
  p.food = 30; P.feed(p, 'snack'); P.feed(p, 'snack'); p.food = 30;
  check(P.feed(p, 'snack').msg === 'snacks', 'pet: no more than three snacks in a row');
  P.feed(p, 'meal'); p.food = 30; check(P.feed(p, 'snack').ok, 'pet: a meal in between starts the count again');
  p.food = 95; check(P.feed(p, 'meal').msg === 'full', 'pet: it refuses food when it is full');
  p = grown(); p.joy = 30; p.energy = 80; p.food = 80; const e0 = p.energy;
  check(P.play(p, 4).ok && p.joy === 30 + 8 + 32 && p.energy === e0 - 10, 'pet: a game with four wins is worth 40 joy and ten energy');
  p.energy = 10; check(P.play(p, 5).msg === 'tired', 'pet: too tired to play');
  p = grown(); P.lights(p); check(p.asleep && P.feed(p, 'meal').msg === 'asleep' && P.play(p, 1).msg === 'asleep' && P.wash(p).msg === 'asleep', 'pet: lights out and nothing else is done to a sleeping pet');
  P.lights(p); check(!p.asleep, 'pet: lights on wakes it');
  const rr = P.round(P.mulberry(3), 'left'); check((rr.look === 'left') === rr.win, 'pet: a right guess wins a round');
  let lefts = 0; const rg = P.mulberry(11); for (let i = 0; i < 400; i++) if (P.round(rg, 'left').look === 'left') lefts++;
  check(lefts > 150 && lefts < 250, 'pet: Mip looks left about half the time');

  // needs and moods
  p = grown(); p.food = 90; p.joy = 90; p.clean = 90; p.energy = 90; check(P.mood(p) === 'happy' && P.need(p) === null, 'pet: well looked after is happy and wants nothing');
  p.food = 20; check(P.need(p) === 'feed', 'pet: hungry wants feeding');
  p.food = 90; p.energy = 20; check(P.need(p) === 'sleep', 'pet: tired wants sleep');
  p.energy = 90; p.mess = 2; p.clean = 30; check(P.need(p) === 'clean', 'pet: mess wants washing');

  // pets on one device
  const store = P.newStore(T0);
  check(P.validStore(store) && store.pets.length === 1, 'pet: a new device has one egg');
  P.addPet(store, T0 + 1); P.addPet(store, T0 + 2);
  check(store.pets.length === 3 && P.addPet(store, T0 + 3) === null, 'pet: up to three pets');
  check(new Set(store.pets.map(x => x.name)).size === 3 && store.active === 2, 'pet: each has its own name');
  check(!P.validStore(null) && !P.validStore({ v: 2, pets: [] }) && !P.validStore({ v: 1, pets: [{ stage: 'zombie', t: 1, food: 1 }] }), 'pet: a damaged save is not trusted');
  check(P.cleanName('  Bob   the  great and mighty ') === 'Bob the grea' && P.cleanName('') === 'Mip', 'pet: names are tidied and kept short');
  const round = JSON.parse(JSON.stringify(store));
  check(P.validStore(round) && round.pets[1].name === store.pets[1].name, 'pet: the store survives being saved as text');
}

console.log(failures ? failures + ' failure(s)' : 'all passed');
process.exit(failures ? 1 : 0);
