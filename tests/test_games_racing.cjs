// ZimiGames racing: Circuit (top-down tracks, cars, laps, computer drivers, ghosts) and Road Rush (the pseudo-3D road).
// The rules with no DOM.
//
// Run: node tests/test_games_racing.cjs   (exit 0 = pass)

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
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ── Circuit ─────────────────────────────────────────────────────────────────
{
  const E = load(['playkit.js', 'circuit.js']).CircuitEngine;
  const DT = 1 / 60;
  check(E.TRACKS.length >= 4, 'circuit: at least four tracks');
  check(['oval', 'switchback', 'crossover', 'city'].every(id => E.TRACKS.some(t => t.id === id)), 'circuit: an oval, a twisty circuit, a figure eight and a city course');

  // geometry: closed, evenly stepped, never touching itself except on the bridge
  E.TRACKS.forEach(def => {
    const T = E.track(def.id), N = T.N;
    let worst = 0;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N; // includes the closing step from the last sample back to the first
      worst = Math.max(worst, Math.abs(Math.hypot(T.x[j] - T.x[i], T.y[j] - T.y[i]) - T.step));
    }
    check(worst < T.step * 0.12, def.id + ': closed, every step about ' + T.step.toFixed(1) + ' px (worst ' + worst.toFixed(2) + ')');
    check(near(Math.hypot(T.tx[0], T.ty[0]), 1, 1e-9) && near(Math.hypot(T.tx[N - 1], T.ty[N - 1]), 1, 1e-9), def.id + ': unit tangents, also across the closing sample');
    let total = 0; // the tangents turn through exactly one full turn round a simple loop, none for a figure eight
    for (let i = 0; i < N; i++) { const j = (i + 1) % N; let d = Math.atan2(T.ty[j], T.tx[j]) - Math.atan2(T.ty[i], T.tx[i]); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; total += d; }
    const turns = Math.round(total / (2 * Math.PI));
    check(def.bridge ? turns === 0 : Math.abs(turns) === 1, def.id + ': ' + (def.bridge ? 'a figure eight turns through nothing in all' : 'one full turn round') + ' (' + turns + ')');
    // two stretches of road more than a tenth of the lap apart that come within a road's width are a crossing
    const gap = Math.round(N / 10);
    let crossings = 0, onBridge = 0;
    for (let i = 0; i < N; i++) for (let j = i + gap; j < i + N - gap; j++) {
      const q = j % N;
      if (Math.hypot(T.x[i] - T.x[q], T.y[i] - T.y[q]) < T.width * 1.05) { crossings++; if (T.level[i] !== T.level[q]) onBridge++; }
    }
    if (def.bridge) check(crossings > 0 && onBridge === crossings, def.id + ': where the road meets itself one stretch is on the bridge and one is under it');
    else check(crossings === 0, def.id + ': the road never comes within a width of itself');
    const lv = T.level.reduce((a, b) => a + b, 0);
    check(def.bridge ? lv > 20 && lv < N / 3 : lv === 0, def.id + ': ' + lv + ' samples of bridge');
  });

  // a car placed at a spot sits on the road; its offset is where it was put
  {
    const T = E.track('switchback'), c = E.spawn(T, 40.5, 20);
    check(near(c.lat, 20, 0.5) && !c.off, 'locate: a car put 20 px off the line reads 20 px');
    const c2 = E.spawn(T, 40.5, -T.halfW - 10);
    check(c2.off && c2.lat < -T.halfW, 'locate: past the kerb is off the track');
  }

  // laps: counted once at the line, never by going backwards over it and forwards again, never by cutting across
  {
    const T = E.track('oval'), N = T.N;
    const race = E.createRace('oval', { ai: 0, humans: 1, laps: 3 });
    const car = race.cars[0];
    race.phase = 'racing'; race.t = 0; car.input = { steer: 0, gas: 0, brake: 0 };
    // walk the parked car along the road in small hops, stepping the race at each
    function walk(to) {
      const dir = to > car.prog ? 1 : -1;
      for (let guard = 0; Math.abs(to - car.prog) > 0.01 && guard < 1000; guard++) {
        const next = car.prog + dir * Math.min(5, Math.abs(to - car.prog)), p = E.pointAt(T, next);
        car.x = p.x; car.y = p.y; car.h = Math.atan2(p.ty, p.tx); car.vx = car.vy = 0; car.stuck = 0; car.auto = false;
        E.step(race, 0.05);
      }
    }
    walk(-3); walk(5);
    check(car.maxK === 0 && car.laps.length === 0 && car.lapStart != null, 'laps: the first crossing of the line starts the lap clock and counts no lap');
    walk(-5); walk(5);
    check(car.laps.length === 0, 'laps: back over the line and forwards again counts nothing');
    walk(N - 5); walk(N + 5);
    check(car.laps.length === 1 && car.maxK === 1, 'laps: a full circuit counts one lap');
    walk(N - 5); walk(N + 5);
    check(car.laps.length === 1, 'laps: back over the second crossing and forwards again counts nothing');
    check(near(car.laps[0], N / 5 * 0.05 + 0.2, 0.15), 'laps: the lap time is the time between the crossings');
    walk(2 * N + 5); walk(3 * N + 5);
    check(car.finished && car.laps.length === 3 && race.laps === 3, 'laps: finishing is counting the last lap');
    // a two-lap race run by the computer: two lap times adding up to the race from the first crossing
    const r2 = E.createRace('oval', { ai: 0, humans: 1, laps: 2, sim: true });
    let t = 0;
    while (r2.phase !== 'done' && t < 200) { E.step(r2, DT); t += DT; }
    const c2 = r2.cars[0];
    check(c2.finished && c2.laps.length === 2, 'laps: a two-lap race gives two lap times');
    const first = c2.finishTime - c2.laps[0] - c2.laps[1];
    check(first > 0 && first < 6 && c2.laps.every(l => l > 10 && l < 40), 'laps: the clock starts within seconds of the green light, and oval laps of ' + c2.laps.map(l => l.toFixed(1)).join(' and ') + ' s are sensible');
    // cutting across: teleport to the far side of the track; the search near the old place keeps the car's progress
    const rc = E.createRace('oval', { ai: 0, humans: 1, laps: 3 });
    const cc = rc.cars[0], progBefore = cc.prog;
    cc.x = -cc.x; cc.y = -cc.y; E.locate(T, cc);
    check(Math.abs(cc.prog - progBefore) < 20, 'laps: jumping to the far side of the track does not skip the laps in between');
  }

  // the cars: speeds, grass, drift, brakes
  {
    const T = E.track('oval');
    const sp = c => Math.hypot(c.vx, c.vy);
    const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
    // a plain steering rule that follows the line, so a long run stays on the road
    const follow = c => { const p = E.pointAt(T, c.idx + 5); return { steer: Math.max(-1, Math.min(1, angDiff(Math.atan2(p.y - c.y, p.x - c.x), c.h) * 2.5)), gas: 1, brake: 0 }; };
    const flat = E.spawn(T, 30, 0);
    for (let i = 0; i < 60 * 8; i++) E.stepCar(T, flat, follow(flat), DT, false);
    check(sp(flat) > E.VMAX * 0.8 && sp(flat) < E.VMAX * 1.001 && !flat.off, 'car: full throttle reaches near the top speed on the road (' + sp(flat).toFixed(0) + ')');
    // grass, on the city course's straight: the same start at speed, on the road and 20 px past the kerb
    const C = E.track('city');
    function coast(lat) {
      const c = E.spawn(C, 24, lat), p = E.pointAt(C, 24);
      c.vx = p.tx * 250; c.vy = p.ty * 250;
      for (let i = 0; i < 25; i++) E.stepCar(C, c, { steer: 0, gas: 1, brake: 0 }, DT, false);
      return c;
    }
    const onRoad = coast(0), onGrass = coast(C.halfW + 20);
    check(onGrass.off && !onRoad.off && sp(onGrass) < sp(onRoad) * 0.85, 'car: grass slows the car (' + sp(onGrass).toFixed(0) + ' against ' + sp(onRoad).toFixed(0) + ')');
    const braked = flat;
    for (let i = 0; i < 42; i++) E.stepCar(T, braked, { steer: 0, gas: 0, brake: 1 }, DT, false);
    check(sp(braked) < 30, 'car: braking stops it');
    // a hard turn at speed slides: the nose swings further than the car travels
    const slide = (() => {
      const c = E.spawn(T, 30, 0);
      let peak = 0;
      for (let i = 0; i < 90; i++) { E.stepCar(T, c, { steer: 0, gas: 1, brake: 0 }, DT, false); }
      for (let i = 0; i < 60; i++) { E.stepCar(T, c, { steer: 1, gas: 1, brake: 0 }, DT, false); peak = Math.max(peak, c.slide); }
      return peak;
    })();
    check(slide > 0.3, 'car: full lock at speed drifts (slide ' + slide.toFixed(2) + ')');
    const calm = (() => {
      const c = E.spawn(T, 30, 0);
      let peak = 0;
      for (let i = 0; i < 90; i++) E.stepCar(T, c, { steer: 0, gas: 0.3, brake: 0 }, DT, false);
      for (let i = 0; i < 40; i++) { E.stepCar(T, c, { steer: 0.3, gas: 0, brake: 0 }, DT, false); peak = Math.max(peak, c.slide); }
      return peak;
    })();
    check(calm < slide && calm < 0.2, 'car: a gentle turn at a modest speed grips');
    // the barrier keeps a car in
    const wall = (() => {
      const c = E.spawn(T, 30, 0);
      for (let i = 0; i < 600; i++) E.stepCar(T, c, { steer: 0.35, gas: 1, brake: 0 }, DT, false);
      return Math.abs(c.lat);
    })();
    check(wall <= T.halfW + E.BARRIER + 2, 'car: the barrier holds a car that will not turn (' + wall.toFixed(0) + ' px out)');
    // reverse is slow
    for (let i = 0; i < 240; i++) E.stepCar(T, braked, { steer: 0, gas: 0, brake: 1 }, DT, false);
    check(sp(braked) < 90, 'car: reverse is slow');
  }

  // bumps
  {
    const T = E.track('oval');
    const a = E.spawn(T, 30, -5), b = E.spawn(T, 30.1, 5);
    a.x = 100; a.y = 100; b.x = 108; b.y = 100; a.vx = 100; a.vy = 0; b.vx = 0; b.vy = 0; a.level = b.level = 0;
    const p0 = a.vx + b.vx;
    check(E.bump(a, b) === true, 'bump: touching cars bump');
    check(Math.hypot(b.x - a.x, b.y - a.y) >= E.CAR_R * 2 - 1e-6, 'bump: they are pushed apart to a car\'s width');
    check(near(a.vx + b.vx, p0, 1e-6) && b.vx > a.vx, 'bump: speed passes forward and the total is kept');
    const c = E.spawn(T, 30, 0), d = E.spawn(T, 30, 0);
    c.x = d.x = 0; c.y = d.y = 0; c.level = 0; d.level = 1;
    check(E.bump(c, d) === false, 'bump: a car on the bridge and one under it do not touch');
    const e = E.spawn(T, 30, 0), f = E.spawn(T, 30, 0);
    e.x = 0; e.y = 0; f.x = 40; f.y = 0; e.level = f.level = 0;
    check(E.bump(e, f) === false, 'bump: cars apart do not');
  }

  // the computer drivers stay on the road over a whole race, on every track, and the field stays sane
  E.TRACKS.forEach(def => {
    const T = E.track(def.id), race = E.createRace(def.id, { ai: 5, humans: 1, laps: 3, sim: true, seed: 3 });
    let worst = 0, t = 0, bumps = 0, offFrames = 0;
    while (race.phase !== 'done' && t < 300) {
      E.step(race, DT); t += DT;
      race.events.splice(0).forEach(e => { if (e.type === 'bump') bumps++; });
      if (race.t > 0) race.cars.forEach(c => { worst = Math.max(worst, Math.abs(c.lat)); if (c.off) offFrames++; });
    }
    check(race.phase === 'done' && race.cars.every(c => c.finished), def.id + ': every computer car finishes three laps (' + t.toFixed(0) + ' s)');
    check(worst < T.halfW + 6, def.id + ': they stay on the track (furthest ' + worst.toFixed(0) + ' of ' + T.halfW.toFixed(0) + ' px)');
    const lapTimes = race.cars.flatMap(c => c.laps);
    check(Math.max.apply(null, lapTimes) < Math.min.apply(null, lapTimes) * 1.35, def.id + ': lap times agree within a third (' + Math.min.apply(null, lapTimes).toFixed(1) + ' to ' + Math.max.apply(null, lapTimes).toFixed(1) + ' s)');
  });

  // computer cars pass slower ones instead of sitting behind or shoving through
  {
    const T = E.track('oval'), race = E.createRace('oval', { ai: 3, humans: 1, laps: 3, sim: true, seed: 5 });
    const [slow, fast] = race.cars.filter(c => c.ai).slice(0, 2);
    race.phase = 'racing'; race.t = 0;
    race.cars.forEach(c => { if (c !== slow && c !== fast) { c.x = 1e6; c.y = 1e6; } });
    const p = E.pointAt(T, 60), q = E.pointAt(T, 56);
    slow.x = p.x; slow.y = p.y; slow.h = Math.atan2(p.ty, p.tx); slow.idx = 60; E.locate(T, slow); slow.prog = 60; slow.ai.skill = 0.5;
    fast.x = q.x; fast.y = q.y; fast.h = slow.h; fast.idx = 56; E.locate(T, fast); fast.prog = 56; fast.ai.skill = 1;
    slow.vx = Math.cos(slow.h) * 120; slow.vy = Math.sin(slow.h) * 120; fast.vx = Math.cos(fast.h) * 120; fast.vy = Math.sin(fast.h) * 120;
    let passed = false, sideways = 0;
    for (let i = 0; i < 60 * 14 && !passed; i++) { E.step(race, DT); if (fast.prog > slow.prog + 2) passed = true; sideways = Math.max(sideways, Math.abs(fast.lat - slow.lat)); }
    check(passed, 'overtaking: the faster computer car gets past the slower one');
    check(sideways > 14, 'overtaking: by going round it (' + sideways.toFixed(0) + ' px to the side)');
  }

  // grid, standings, ghost
  {
    const race = E.createRace('city', { ai: 4, humans: 2, laps: 2 });
    check(race.cars.length === 6 && race.cars[0].human && race.cars[1].human && !race.cars[2].human, 'grid: two people first in the list, four rivals after');
    const progs = race.cars.map(c => c.prog).sort((a, b) => a - b);
    check(new Set(progs).size === 6 && progs.every(p => p < 0), 'grid: six rows, all behind the line');
    check(race.phase === 'countdown' && race.t < 0, 'grid: begins with a countdown');
    for (let i = 0; i < 60 * 2.9; i++) E.step(race, DT);
    check(race.phase === 'countdown' && race.cars.every(c => Math.hypot(c.vx, c.vy) === 0), 'grid: nobody moves during the countdown');
    for (let i = 0; i < 20; i++) E.step(race, DT);
    check(race.phase === 'racing', 'grid: then the race');
    const order = E.standings(race);
    check(order.length === 6 && order[0].prog >= order[5].prog, 'standings: the furthest round first');
    race.cars[3].finished = true; race.cars[3].finishTime = 50; race.cars[4].finished = true; race.cars[4].finishTime = 45;
    const o2 = E.standings(race);
    check(o2[0] === race.cars[4] && o2[1] === race.cars[3], 'standings: finishers by time before everyone still racing');
    const g = [];
    for (let i = 0; i <= 40; i++) E.ghostPush(g, i * 10, 0, i * 0.01);
    const at = E.ghostAt(g, 0.5 / E.GHOST_HZ);
    check(at && near(at.x, 5, 0.2) && near(at.h, 0.005, 0.01), 'ghost: a position between two samples is between them');
    check(E.ghostAt(g, 100) === null && E.ghostAt(g, -1) === null, 'ghost: nothing before the lap starts or after it ends');
  }
}

// ── Road Rush ───────────────────────────────────────────────────────────────
{
  const E = load(['roadrush.js']).RoadRushEngine;
  const DT = 1 / 60;
  const W = 400, H = 300;
  const pt = (x, y, z) => ({ world: { x, y, z }, camera: {}, screen: {} });
  const clear = g => { g.cars.length = 0; g.road.segments.forEach(s => { s.cars.length = 0; s.sprites = s.sprites.filter(p => p.gate); }); };

  // projection: the camera maths that makes the road
  {
    const camY = E.CAM_H, d = E.CAM_DEPTH;
    const a = pt(0, 0, 1000), b = pt(0, 0, 2000), l = pt(-1000, 0, 1000), r = pt(1000, 0, 1000);
    [a, b, l, r].forEach(p => E.project(p, 0, camY, 0, d, W, H, E.ROAD_W));
    check(a.screen.x === W / 2 && b.screen.x === W / 2, 'project: straight ahead is the middle of the screen at any distance');
    check(near(a.screen.scale, d / 1000, 1e-12) && near(b.screen.scale, d / 2000, 1e-12), 'project: scale is depth over distance');
    check(a.screen.y > b.screen.y && b.screen.y > H / 2, 'project: farther ground sits higher, toward the horizon, and never above it');
    check(near(l.screen.x - W / 2, W / 2 - r.screen.x, 1), 'project: left and right mirror each other');
    check(a.screen.w === Math.round(a.screen.scale * E.ROAD_W * W / 2) && a.screen.w > b.screen.w, 'project: the road narrows with distance');
    const eye = pt(0, camY, 5000); E.project(eye, 0, camY, 0, d, W, H, E.ROAD_W);
    check(eye.screen.y === H / 2, 'project: a point at the camera\'s height is on the horizon at any distance');
    const up = pt(0, camY + 500, 1000), dn = pt(0, camY - 500, 1000); E.project(up, 0, camY, 0, d, W, H, E.ROAD_W); E.project(dn, 0, camY, 0, d, W, H, E.ROAD_W);
    check(up.screen.y < H / 2 && dn.screen.y > H / 2 && near(H / 2 - up.screen.y, dn.screen.y - H / 2, 1), 'project: above the camera is above the horizon, and symmetric');
    const foot = pt(0, 0, E.PLAYER_Z); E.project(foot, 0, camY, 0, d, W, H, E.ROAD_W);
    check(foot.screen.y > H * 0.9 && foot.screen.y <= H, 'project: the ground under the car is at the foot of the screen (' + foot.screen.y + ' of ' + H + ')');
    check(near(E.CAM_DEPTH, 1 / Math.tan(Math.PI * E.FOV / 360), 1e-12) && near(E.PLAYER_Z, E.CAM_H * E.CAM_DEPTH, 1e-9), 'project: depth follows the field of view');
  }

  // the roads
  E.STAGES.forEach(stage => {
    const road = E.buildRoad(stage, 5), segs = road.segments, N = segs.length;
    let contiguous = true, smooth = true, jump = 0;
    for (let i = 0; i < N; i++) {
      const s = segs[i];
      if (s.index !== i || s.p1.world.z !== i * E.SEG || s.p2.world.z !== (i + 1) * E.SEG) contiguous = false;
      if (i + 1 < N && segs[i + 1].p1.world.y !== s.p2.world.y) smooth = false;
      jump = Math.max(jump, Math.abs(s.p2.world.y - s.p1.world.y));
    }
    check(contiguous && N > 1500, stage.id + ': ' + N + ' segments laid end to end');
    check(smooth, stage.id + ': each segment starts at the height the last one ended');
    check(segs[0].p1.world.y === 0 && Math.abs(segs[N - 1].p2.world.y) < 1, stage.id + ': starts and ends at ground level');
    check(jump < E.SEG * 0.9, stage.id + ': no hill steeper than nine in ten (' + jump.toFixed(0) + ' in ' + E.SEG + ')');
    const maxCurve = Math.max.apply(null, segs.map(s => Math.abs(s.curve)));
    check(maxCurve >= 4 && maxCurve <= 6.001 && segs.some(s => s.curve > 0) && segs.some(s => s.curve < 0), stage.id + ': bends to both sides, none past the hard setting');
    check(segs.slice(0, 20).every(s => s.curve === 0), stage.id + ': a straight start');
    const side = segs.flatMap(s => s.sprites).filter(p => !p.solid && !p.gate);
    check(side.length > 100 && side.every(p => Math.abs(p.offset) >= 1.3), stage.id + ': ' + side.length + ' roadside things, none on the road');
    check(segs.flatMap(s => s.sprites).filter(p => p.solid).every(p => Math.abs(p.offset) < 1), stage.id + ': cones are on the road');
    const cps = road.checkpoints;
    check(cps.length === 2 && cps[0].index < cps[1].index && cps[1].index < road.finish / E.SEG, stage.id + ': two checkpoints in order, then the finish');
    check(cps.every(c => segs[c.index].sprites.some(p => p.gate)), stage.id + ': each checkpoint has its gate');
    const cars = E.makeTraffic(road, stage, 0, 5);
    check(cars.length > 100 && cars.every(c => Math.abs(c.offset) < 1 && c.z > 50 * E.SEG && c.speed < E.MAX_SPEED * 0.6 && c.speed > 0), stage.id + ': ' + cars.length + ' cars, in their lanes and slower than you');
    let clash = 0;
    for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) if (Math.abs(cars[i].z - cars[j].z) < E.SEG * 12 && Math.abs(cars[i].offset - cars[j].offset) < 0.5) clash++;
    check(clash === 0, stage.id + ': no two cars start in each other\'s way');
    const again = E.buildRoad(stage, 5);
    check(JSON.stringify(again.segments.slice(0, 60).map(s => s.sprites)) === JSON.stringify(segs.slice(0, 60).map(s => s.sprites)), stage.id + ': the same seed builds the same road');
    check(E.percentRemaining(E.SEG * 3.25, E.SEG) === 0.25 && E.findSegment(road, E.SEG * 7.5).index === 7, stage.id + ': finding a segment by distance');
  });
  check(E.STAGES.map(s => s.theme).join() === 'day,dusk,night', 'stages: day, dusk and night');

  check(E.overlap(0, 0.3, 0.2, 0.3, 1) && !E.overlap(0, 0.3, 0.5, 0.3, 1) && E.overlap(0, 0.3, 0.2, 0.3, 1.2), 'overlap: spans that cross overlap, spans that do not do not');

  // the car
  {
    const g = E.newGame(7); clear(g); g.road.segments.forEach(s => { s.curve = 0; });
    for (let i = 0; i < 60 * 8; i++) E.update(g, DT, { steer: 0, gas: 1, brake: 0 });
    check(g.player.speed === E.MAX_SPEED, 'car: full throttle reaches the top speed (' + g.player.speed + ')');
    for (let i = 0; i < 60; i++) E.update(g, DT, { steer: 0, gas: 0, brake: 1 });
    check(g.player.speed < E.MAX_SPEED * 0.1, 'car: a second of braking all but stops it');
    const g2 = E.newGame(7); clear(g2); g2.player.speed = E.MAX_SPEED;
    for (let i = 0; i < 30; i++) E.update(g2, DT, { steer: 1, gas: 1, brake: 0 });
    check(g2.player.x > 0.2, 'car: steering right moves right (' + g2.player.x.toFixed(2) + ')');
    const g3 = E.newGame(7); clear(g3); g3.player.speed = E.MAX_SPEED;
    for (let i = 0; i < 40; i++) E.update(g3, DT, { steer: -1, gas: 1, brake: 0 });
    check(g3.player.x < -0.2, 'car: steering left moves left');
    const g4 = E.newGame(7); clear(g4);
    for (let i = 0; i < 30; i++) E.update(g4, DT, { steer: 1, gas: 0, brake: 0 });
    check(g4.player.x === 0, 'car: no steering at a standstill');
    const g5 = E.newGame(7); clear(g5);
    const bend = g5.road.segments.findIndex(s => s.curve > 3);
    g5.player.pos = bend * E.SEG - E.PLAYER_Z; g5.player.speed = E.MAX_SPEED;
    const x0 = g5.player.x; E.update(g5, DT, { steer: 0, gas: 1, brake: 0 });
    check(g5.player.x < x0, 'car: a bend to the right pushes the car left, to the outside');
    const g6 = E.newGame(7); clear(g6); g6.player.speed = E.MAX_SPEED;
    for (let i = 0; i < 300; i++) { g6.player.x = 1.6; E.update(g6, DT, { steer: 0, gas: 1, brake: 0 }); }
    check(g6.player.speed <= E.OFF_LIMIT * 1.2 && g6.player.speed >= E.OFF_LIMIT * 0.6, 'car: on the grass the top speed is a quarter of full (' + (g6.player.speed / E.MAX_SPEED).toFixed(2) + ')');
  }

  // collisions: traffic, roadside things, cones
  {
    const put = (g, car) => { g.cars.push(car); E.findSegment(g.road, car.z).cars.push(car); };
    const g = E.newGame(3); clear(g);
    const car = { offset: 0, z: 100 * E.SEG, type: 'car', w: E.SPRITE_W.car, speed: E.MAX_SPEED * 0.3, percent: 0 };
    put(g, car);
    g.player.pos = car.z - E.PLAYER_Z - E.SEG * 0.6; g.player.speed = E.MAX_SPEED * 0.9; g.player.x = 0;
    const events = [];
    for (let i = 0; i < 30; i++) { E.update(g, DT, { steer: 0, gas: 1, brake: 0 }); g.events.splice(0).forEach(e => events.push(e.type)); }
    check(events.includes('bump') && g.player.speed < E.MAX_SPEED * 0.45, 'collide: driving into a slower car drops you to about its speed (' + (g.player.speed / E.MAX_SPEED).toFixed(2) + ')');
    check(g.player.pos + E.PLAYER_Z <= car.z + 1, 'collide: and you do not pass through it');
    const g2 = E.newGame(3); clear(g2);
    put(g2, { offset: 0.66, z: 100 * E.SEG, type: 'car', w: E.SPRITE_W.car, speed: E.MAX_SPEED * 0.3, percent: 0 });
    g2.player.pos = 100 * E.SEG - E.PLAYER_Z - E.SEG * 0.6; g2.player.speed = E.MAX_SPEED * 0.9; g2.player.x = -0.5;
    for (let i = 0; i < 30; i++) E.update(g2, DT, { steer: 0, gas: 1, brake: 0 });
    check(g2.player.speed > E.MAX_SPEED * 0.8, 'collide: passing a car in the next lane costs nothing');
    const idx = 80;
    const g3 = E.newGame(3); clear(g3); g3.road.segments[idx].sprites.push({ type: 'palm', offset: 1.4, w: 0.5 });
    g3.player.pos = idx * E.SEG - E.PLAYER_Z; g3.player.speed = E.MAX_SPEED; g3.player.x = 1.35;
    E.update(g3, DT, { steer: 0, gas: 1, brake: 0 });
    check(g3.events.some(e => e.type === 'crash') && g3.player.speed < E.MAX_SPEED * 0.2, 'collide: hitting a tree beside the road all but stops the car');
    const g4 = E.newGame(3); clear(g4); g4.road.segments[idx].sprites.push({ type: 'cone', offset: 0, w: 0.1, solid: true });
    g4.player.pos = idx * E.SEG - E.PLAYER_Z; g4.player.speed = E.MAX_SPEED; g4.player.x = 0.02;
    E.update(g4, DT, { steer: 0, gas: 1, brake: 0 });
    check(g4.events.some(e => e.type === 'cone') && g4.player.speed < E.MAX_SPEED * 0.45, 'collide: a cone in your lane is a hit, and slows you to two fifths');
  }

  // traffic keeps moving and stays listed where it is
  {
    const g = E.newGame(11), z0 = g.cars.map(c => c.z);
    for (let i = 0; i < 120; i++) E.update(g, DT, { steer: 0, gas: 0, brake: 1 });
    check(g.cars.every((c, i) => c.z > z0[i]) && g.cars.every(c => Math.abs(c.offset) < 1.3), 'traffic: every car moves on and stays on the road');
    const on = new Set(); g.road.segments.forEach(s => s.cars.forEach(c => on.add(c)));
    check(on.size === g.cars.length && g.road.segments.every(s => s.cars.every(c => Math.floor(c.z / E.SEG) === s.index)), 'traffic: each car is listed on the segment it is on');
  }

  // checkpoints, the clock and the stages
  {
    const g = E.newGame(5); clear(g);
    const t0 = g.time, cps = g.road.checkpoints, ev = [];
    const go = pos => { g.player.pos = pos; g.player.speed = E.MAX_SPEED; E.update(g, DT, { steer: 0, gas: 1, brake: 0 }); g.events.splice(0).forEach(e => ev.push(e)); };
    go(cps[0].index * E.SEG - 1000);
    check(!cps[0].hit && !cps[1].hit, 'checkpoints: nothing before the first gate');
    go(cps[0].index * E.SEG + 10);
    check(cps[0].hit && !cps[1].hit && near(g.time, t0 - DT * 2 + cps[0].bonus, 1e-6), 'checkpoints: the first adds its time once (' + g.time.toFixed(1) + ' s)');
    go(cps[0].index * E.SEG + 20); go(cps[0].index * E.SEG + 30);
    check(ev.filter(e => e.type === 'checkpoint').length === 1, 'checkpoints: passing it again adds nothing');
    go(cps[1].index * E.SEG + 10);
    check(cps[1].hit && ev.filter(e => e.type === 'checkpoint').length === 2, 'checkpoints: then the second');
    const before = g.time, stageBefore = g.stageIndex;
    go(g.road.finish + 10);
    check(g.stageIndex === stageBefore + 1 && g.stage.theme === 'dusk' && g.player.pos === 0 && g.time > before, 'stages: the finish opens the dusk stage with time added');
    check(ev.some(e => e.type === 'finish') && E.totalScore(g) > 5000, 'stages: and scores it (' + E.totalScore(g) + ')');
    for (const want of ['night', 'day']) { clear(g); go(g.road.finish + 10); check(g.stage.theme === want, 'stages: then ' + want); }
    check(g.lap === 1, 'stages: the second time round is lap 1, with more cars');
    const g2 = E.newGame(5); g2.time = 0.05;
    for (let i = 0; i < 10; i++) E.update(g2, DT, { steer: 0, gas: 1, brake: 0 });
    check(g2.status === 'over' && g2.time === 0, 'clock: at zero the run is over');
    const pos = g2.player.pos; E.update(g2, DT, { steer: 0, gas: 1, brake: 0 });
    check(g2.player.pos === pos, 'clock: and nothing moves after');
  }

  // pacing: a perfect run at full speed takes under a minute; the clock and the checkpoint bonuses leave room for about a third more, not twice
  E.STAGES.forEach(stage => {
    const road = E.buildRoad(stage, 1), perfect = road.length / E.MAX_SPEED, budget = stage.time + stage.checkpoints.reduce((a, c) => a + c.bonus, 0);
    check(perfect > 45 && perfect < 62 && budget > perfect * 1.3 && budget < perfect * 2, stage.id + ': a perfect run is ' + perfect.toFixed(0) + ' s against ' + budget + ' s on the clock');
    const first = stage.time / (road.checkpoints[0].index * E.SEG / E.MAX_SPEED);
    check(first > 1.3 && first < 3.2, stage.id + ': the first checkpoint is reachable with room to spare (' + first.toFixed(1) + 'x)');
  });

  // a plain autopilot that weaves round traffic and cones, lifting for hard bends, reaches the first checkpoint on the opening clock
  {
    const g = E.newGame(9);
    let t = 0, dodge = null;
    while (!g.road.checkpoints[0].hit && g.status === 'racing' && t < 120) {
      const p = g.player, seg = E.findSegment(g.road, p.pos + E.PLAYER_Z), N = g.road.segments.length;
      let target = 0, speed = E.MAX_SPEED;
      if (dodge && dodge.car.z < p.pos + E.PLAYER_Z - 300) dodge = null;
      if (dodge) target = dodge.t;
      for (let i = 1; i < 16; i++) {
        const s = g.road.segments[(seg.index + i) % N];
        for (const c of s.cars) if (Math.abs(c.offset - p.x) < 0.35 && c.speed < p.speed) {
          if (!dodge || dodge.car !== c) dodge = { car: c, t: c.offset > 0.2 ? -0.62 : c.offset < -0.2 ? 0.62 : (p.x > 0 ? 0.62 : -0.62) };
          target = dodge.t; if (i < 3 && Math.abs(c.offset - p.x) < 0.25) speed = Math.min(speed, c.speed);
        }
      }
      for (let i = 1; i < 10; i++) for (const c of g.road.segments[(seg.index + i) % N].sprites) if (c.solid && !c.hit && Math.abs(c.offset - p.x) < 0.3) target = c.offset > 0 ? -0.6 : 0.6;
      const sp = p.speed / E.MAX_SPEED, hard = Math.max(Math.abs(seg.curve), Math.abs(g.road.segments[(seg.index + 12) % N].curve));
      if (hard > 3) speed = Math.min(speed, E.MAX_SPEED * (hard > 5 ? 0.7 : 0.9));
      const steer = Math.max(-1, Math.min(1, (target - p.x) * 4 + sp * seg.curve * E.CENTRIFUGAL));
      E.update(g, DT, { steer: steer, gas: p.speed < speed ? 1 : 0, brake: p.speed > speed * 1.05 ? 1 : 0 });
      g.events.splice(0); t += DT;
    }
    check(g.road.checkpoints[0].hit && g.status === 'racing', 'drive: an autopilot that weaves and lifts reaches the first checkpoint (' + t.toFixed(0) + ' s of ' + E.STAGES[0].time + ')');
    check(t > 20 && t < E.STAGES[0].time, 'drive: not faster than full speed allows, and inside the opening clock');
  }
}

if (failures) { console.error('\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\nall racing tests passed');
