/* ZimiGames: Road Rush. Our own code, GPL-3.0. No network, no fonts, no modules.
   A road racer drawn the way arcades did it in the 1980s: the road is a list of short flat segments, each with a
   bend and a height, projected one by one into strips of screen from the near end to the horizon, and the cars and
   roadside things are scaled sprites standing on them. This file is the road, the traffic and the rules (pure, no
   DOM, so node can test it); roadrush-page.js draws it. Distances are world units, seconds, speeds units per second. */
(function (root) {
  'use strict';

  // ── the camera and the road ──────────────────────────────────────────────
  var SEG = 200;                         // length of one segment
  var ROAD_W = 2000;                     // half the road's width: x = -1 .. 1 across it is -ROAD_W .. ROAD_W
  var RUMBLE = 3;                        // segments to a stripe of kerb and of grass
  var LANES = 3;
  var FOV = 100, CAM_H = 1000, DRAW = 110;
  var CAM_DEPTH = 1 / Math.tan((FOV / 2) * Math.PI / 180);
  var PLAYER_Z = CAM_H * CAM_DEPTH;      // how far in front of the camera the car sits
  var STEP_HZ = 60;
  var MAX_SPEED = SEG * STEP_HZ;         // one segment per frame at 60 Hz: 12000 units/s
  var ACCEL = MAX_SPEED / 5, BRAKING = -MAX_SPEED, DECEL = -MAX_SPEED / 5, OFF_DECEL = -MAX_SPEED / 2, OFF_LIMIT = MAX_SPEED / 4;
  var CENTRIFUGAL = 0.3, STEER_RATE = 2;
  var PLAYER_W = 0.26;                   // the car's width, in road half-widths
  var KMH = 240;                         // what full speed reads as
  var CRASH_SPEED = MAX_SPEED * 0.12, CONE_SPEED = 0.4, BUMP_COOLDOWN_S = 0.6;
  var LOOK = 20;                         // how many segments ahead a traffic car looks before it steers round another

  var HILL = { NONE: 0, LOW: 20, MEDIUM: 40, HIGH: 60 };
  var CURVE = { NONE: 0, EASY: 2, MEDIUM: 4, HARD: 6 };

  // ── the stages: sections of [kind, enter, hold, leave, curve, hill] ───────
  // Each stage is a different light: day, dusk, night. `time` is the clock at the start, each checkpoint adds `bonus`.
  var S = 25, M = 50, L = 100;
  var STAGES = [
    { id: 'coast', name: 'Coast Road', theme: 'day', time: 50, density: 0.1, finishBonus: 25,
      checkpoints: [{ at: 0.34, bonus: 22 }, { at: 0.68, bonus: 22 }],
      sections: [['straight', S], ['road', M, M, M, CURVE.EASY, HILL.NONE], ['straight', M], ['road', M, L, M, -CURVE.MEDIUM, HILL.LOW], ['road', M, M, M, CURVE.MEDIUM, -HILL.LOW], ['straight', M],
        ['road', M, M, M, -CURVE.EASY, HILL.MEDIUM], ['road', M, M, M, CURVE.HARD, -HILL.MEDIUM], ['straight', L], ['road', M, M, M, -CURVE.HARD, HILL.LOW], ['road', M, L, M, CURVE.EASY, -HILL.LOW],
        ['road', S, S, S, CURVE.MEDIUM, HILL.MEDIUM], ['road', S, S, S, -CURVE.MEDIUM, -HILL.MEDIUM], ['straight', M], ['road', M, M, M, CURVE.MEDIUM, HILL.LOW], ['road', M, M, M, -CURVE.EASY, -HILL.LOW], ['straight', L],
        ['road', M, M, M, -CURVE.MEDIUM, HILL.NONE], ['road', M, M, M, CURVE.HARD, HILL.LOW], ['road', M, M, M, -CURVE.HARD, -HILL.LOW], ['straight', M]] },
    { id: 'dusk', name: 'Dusk Pass', theme: 'dusk', time: 48, density: 0.13, finishBonus: 25,
      checkpoints: [{ at: 0.33, bonus: 20 }, { at: 0.66, bonus: 20 }],
      sections: [['straight', S], ['road', M, M, M, -CURVE.EASY, HILL.MEDIUM], ['road', M, M, M, CURVE.MEDIUM, HILL.MEDIUM], ['road', M, M, M, -CURVE.MEDIUM, -HILL.HIGH], ['straight', M],
        ['road', S, S, S, CURVE.HARD, HILL.LOW], ['road', S, S, S, -CURVE.HARD, HILL.LOW], ['road', S, S, S, CURVE.HARD, -HILL.LOW], ['straight', M], ['road', M, L, M, CURVE.MEDIUM, HILL.HIGH], ['road', M, M, M, -CURVE.EASY, -HILL.MEDIUM],
        ['road', M, M, M, CURVE.HARD, -HILL.MEDIUM], ['straight', M], ['road', M, M, M, -CURVE.HARD, HILL.MEDIUM], ['road', M, M, M, CURVE.MEDIUM, -HILL.LOW], ['straight', L], ['road', M, M, M, -CURVE.MEDIUM, HILL.LOW],
        ['road', M, M, M, CURVE.EASY, -HILL.LOW], ['road', S, S, S, -CURVE.HARD, HILL.NONE], ['straight', M]] },
    { id: 'night', name: 'Night Run', theme: 'night', time: 46, density: 0.16, finishBonus: 25,
      checkpoints: [{ at: 0.32, bonus: 20 }, { at: 0.65, bonus: 20 }],
      sections: [['straight', S], ['road', M, M, M, CURVE.EASY, HILL.LOW], ['straight', M], ['road', M, M, M, -CURVE.MEDIUM, -HILL.LOW], ['road', S, S, S, CURVE.HARD, HILL.MEDIUM], ['road', S, S, S, -CURVE.HARD, HILL.MEDIUM],
        ['straight', L], ['road', M, L, M, CURVE.MEDIUM, -HILL.MEDIUM], ['road', M, M, M, -CURVE.MEDIUM, HILL.HIGH], ['road', M, M, M, CURVE.HARD, -HILL.HIGH], ['straight', M], ['road', M, M, M, -CURVE.EASY, HILL.LOW],
        ['road', S, S, S, CURVE.HARD, HILL.NONE], ['road', S, S, S, -CURVE.HARD, HILL.NONE], ['road', S, S, S, CURVE.HARD, HILL.NONE], ['straight', M], ['road', M, M, M, -CURVE.MEDIUM, -HILL.LOW], ['road', M, L, M, CURVE.MEDIUM, HILL.MEDIUM],
        ['straight', L], ['road', M, M, M, CURVE.EASY, -HILL.MEDIUM], ['straight', M]] }
  ];

  // ── small maths ──────────────────────────────────────────────────────────
  var clamp = root.ZimiUtil.clamp;
  function easeIn(a, b, p) { return a + (b - a) * Math.pow(p, 2); }
  function easeInOut(a, b, p) { return a + (b - a) * (-Math.cos(p * Math.PI) / 2 + 0.5); }
  function interpolate(a, b, p) { return a + (b - a) * p; }
  function percentRemaining(n, total) { return (n % total) / total; }
  var mulberry = root.ZimiUtil.mulberry32;

  // The projection: a world point to screen (x, y, and w, the road's half-width there), given the camera.
  function project(p, camX, camY, camZ, depth, width, height, roadW) {
    p.camera.x = (p.world.x || 0) - camX;
    p.camera.y = (p.world.y || 0) - camY;
    p.camera.z = (p.world.z || 0) - camZ;
    p.screen.scale = depth / p.camera.z;
    p.screen.x = Math.round(width / 2 + (p.screen.scale * p.camera.x * width / 2));
    p.screen.y = Math.round(height / 2 - (p.screen.scale * p.camera.y * height / 2));
    p.screen.w = Math.round(p.screen.scale * roadW * width / 2);
  }

  // Two things overlap when their spans (centre x, width w, in road half-widths) cross. `percent` scales how far.
  function overlap(x1, w1, x2, w2, percent) {
    var half = (percent || 1) / 2, min1 = x1 - w1 * half, max1 = x1 + w1 * half, min2 = x2 - w2 * half, max2 = x2 + w2 * half;
    return !(max1 < min2 || min1 > max2);
  }

  // ── building a stage ─────────────────────────────────────────────────────
  var SPRITE_W = { palm: 0.5, pine: 0.45, rock: 0.3, sign: 0.6, lamp: 0.16, cone: 0.1, house: 0.8, tower: 0.7, bush: 0.3, gate: 2.1, car: 0.26, van: 0.3, truck: 0.34 };
  var SCENERY = { day: ['palm', 'palm', 'bush', 'rock', 'house'], dusk: ['pine', 'pine', 'rock', 'bush', 'house'], night: ['lamp', 'tower', 'tower', 'bush', 'lamp'] };

  function buildRoad(stage, seed) {
    var segs = [], rng = mulberry(seed), lastY = function () { return segs.length ? segs[segs.length - 1].p2.world.y : 0; };
    function add(curve, y) {
      var n = segs.length;
      segs.push({ index: n, p1: { world: { y: lastY(), z: n * SEG }, camera: {}, screen: {} }, p2: { world: { y: y, z: (n + 1) * SEG }, camera: {}, screen: {} }, curve: curve, sprites: [], cars: [], shade: Math.floor(n / RUMBLE) % 2 });
    }
    function road(enter, hold, leave, curve, h) {
      var startY = lastY(), endY = startY + h * SEG, total = enter + hold + leave, n;
      for (n = 0; n < enter; n++) add(easeIn(0, curve, n / enter), easeInOut(startY, endY, (n + 1) / total));
      for (n = 0; n < hold; n++) add(curve, easeInOut(startY, endY, (enter + n + 1) / total));
      for (n = 0; n < leave; n++) add(easeInOut(curve, 0, n / leave), easeInOut(startY, endY, (enter + hold + n + 1) / total));
    }
    stage.sections.forEach(function (s) { if (s[0] === 'straight') road(s[1], s[1], s[1], 0, 0); else road(s[1], s[2], s[3], s[4], s[5]); });
    // the road comes back down to where it began so the last stretch is flat, then a flat run-out for the finish
    var drop = lastY() / SEG, k = 30;
    road(k, k, k, 0, -drop);
    road(10, 10, 10, 0, 0);
    var N = segs.length, i, side, kinds = SCENERY[stage.theme];
    // roadside things: a kind chosen at random every few segments, each side, never on the road
    for (i = 8; i < N - 12; i += 3 + Math.floor(rng() * 4)) for (side = -1; side <= 1; side += 2) {
      var kind = kinds[Math.floor(rng() * kinds.length)];
      if (rng() < 0.7) segs[i].sprites.push({ type: kind, offset: side * (1.35 + rng() * (kind === 'house' || kind === 'tower' ? 3.5 : 2.2)), w: SPRITE_W[kind], hue: Math.floor(rng() * 4) });
    }
    for (i = 40; i < N - 30; i += 60 + Math.floor(rng() * 40)) segs[i].sprites.push({ type: 'sign', offset: (rng() < 0.5 ? -1 : 1) * 1.45, w: SPRITE_W.sign, hue: Math.floor(rng() * 4) });
    // cones narrowing the road at a few places: little obstacles you can hit
    for (var c = 0; c < 6; c++) {
      var at = 90 + Math.floor(rng() * (N - 200)), lane = Math.floor(rng() * 3) - 1;
      for (var q = 0; q < 5; q++) segs[at + q * 2].sprites.push({ type: 'cone', offset: lane * 0.66 + (rng() - 0.5) * 0.1, w: SPRITE_W.cone, solid: true });
    }
    // checkpoints and the finish: a gate across the road
    var cps = stage.checkpoints.map(function (cp, n) {
      var idx = Math.floor(cp.at * N);
      segs[idx].sprites.push({ type: 'gate', offset: 0, w: SPRITE_W.gate, label: 'CHECKPOINT', gate: true });
      return { index: idx, bonus: cp.bonus, hit: false };
    });
    var finishIdx = N - 14;
    segs[finishIdx].sprites.push({ type: 'gate', offset: 0, w: SPRITE_W.gate, label: 'FINISH', gate: true });
    return { segments: segs, length: N * SEG, finish: finishIdx * SEG, checkpoints: cps, theme: stage.theme };
  }

  function findSegment(road, z) { return road.segments[Math.floor(z / SEG) % road.segments.length]; }

  // ── traffic ──────────────────────────────────────────────────────────────
  var CAR_TYPES = ['car', 'van', 'truck', 'car'];
  function makeTraffic(road, stage, lap, seed) {
    var rng = mulberry(seed + 99), cars = [], N = road.segments.length, n = Math.floor(N * stage.density * (1 + 0.15 * lap)), i, c;
    for (i = 0; i < n; i++) {
      var lane = Math.floor(rng() * LANES) - 1, type = CAR_TYPES[Math.floor(rng() * CAR_TYPES.length)], z = (60 + Math.floor(rng() * (N - 130))) * SEG;
      c = { offset: lane * (2 / LANES) + (rng() - 0.5) * 0.12, z: z, type: type, hue: Math.floor(rng() * 6), w: SPRITE_W[type],
        speed: MAX_SPEED / 4 + rng() * MAX_SPEED / 5 * (type === 'truck' ? 0.7 : type === 'van' ? 0.9 : 1.1), percent: 0 };
      // never put two cars on the same stretch of road in the same lane
      if (cars.some(function (o) { return Math.abs(o.z - c.z) < SEG * 12 && Math.abs(o.offset - c.offset) < 0.5; })) continue;
      cars.push(c);
      findSegment(road, c.z).cars.push(c);
    }
    return cars;
  }

  function updateTraffic(g, dt) {
    var road = g.road;
    g.cars.forEach(function (car) {
      if (car.z > road.length - SEG * 3) return; // past the finish: stays where it is
      var old = findSegment(road, car.z);
      car.offset += laneOffset(g, car, old) * dt * STEP_HZ;
      car.z += car.speed * dt;
      car.percent = percentRemaining(car.z, SEG);
      var nu = findSegment(road, car.z);
      if (old !== nu) { old.cars.splice(old.cars.indexOf(car), 1); nu.cars.push(car); }
    });
  }

  // A car looks LOOK segments ahead; a slower car in its way (or the player's) means a step to the freer side.
  function laneOffset(g, car, seg) {
    var dir, i, j, other, p = g.player, N = g.road.segments.length;
    for (i = 1; i < LOOK; i++) {
      var s = g.road.segments[(seg.index + i) % N];
      if (s === findSegment(g.road, p.pos + PLAYER_Z) && car.speed > p.speed && overlap(p.x, PLAYER_W, car.offset, car.w, 1.2)) {
        dir = p.x > 0.5 ? -1 : p.x < -0.5 ? 1 : (car.offset > p.x ? 1 : -1);
        return dir / i * (car.speed - p.speed) / MAX_SPEED * 0.12;
      }
      for (j = 0; j < s.cars.length; j++) {
        other = s.cars[j];
        if (car.speed > other.speed && overlap(car.offset, car.w, other.offset, other.w, 1.2)) {
          dir = other.offset > 0.5 ? -1 : other.offset < -0.5 ? 1 : (car.offset > other.offset ? 1 : -1);
          return dir / i * (car.speed - other.speed) / MAX_SPEED * 0.12;
        }
      }
    }
    if (car.offset < -0.9) return 0.02; // and back off the kerb
    if (car.offset > 0.9) return -0.02;
    return 0;
  }

  // ── a run ────────────────────────────────────────────────────────────────
  // g.player: x across the road (-1..1 on it), pos along it, speed. g.time counts down. A run is stage after stage.
  function startStage(g, n) {
    var stage = STAGES[n % STAGES.length], lap = Math.floor(n / STAGES.length);
    g.stageIndex = n; g.stage = stage; g.lap = lap;
    g.road = buildRoad(stage, g.seed + n * 17);
    g.cars = makeTraffic(g.road, stage, lap, g.seed + n * 17);
    g.player = { x: 0, pos: 0, speed: 0, steer: 0, crash: 0, hitCd: 0, lastCurve: 0 };
    g.time += n === 0 ? stage.time : stage.time * 0.4 + stage.finishBonus;
    g.events.push({ type: 'stage', n: n, name: stage.name });
  }
  function newGame(seed, startStageN) {
    var g = { seed: seed == null ? 1 : seed, time: 0, score: 0, distance: 0, status: 'racing', events: [], elapsed: 0, bonus: 0 };
    startStage(g, startStageN || 0);
    return g;
  }

  // input: steer -1..1, gas 0..1, brake 0..1
  function update(g, dt, input) {
    if (g.status !== 'racing') return;
    var p = g.player, road = g.road, seg = findSegment(road, p.pos + PLAYER_Z), speedPct = p.speed / MAX_SPEED, dx = dt * STEER_RATE * speedPct;
    g.time -= dt; g.elapsed += dt;
    updateTraffic(g, dt);
    var before = p.pos;
    p.pos = p.pos + p.speed * dt;
    p.steer = input.steer;
    p.x = p.x + dx * input.steer - dx * speedPct * seg.curve * CENTRIFUGAL;
    p.lastCurve = seg.curve;
    if (input.gas > 0) p.speed += ACCEL * input.gas * dt;
    else if (input.brake > 0) p.speed += BRAKING * input.brake * dt;
    else p.speed += DECEL * dt;
    if (input.gas > 0 && input.brake > 0) p.speed += BRAKING * input.brake * dt;
    if (p.x < -1 || p.x > 1) {
      if (p.speed > OFF_LIMIT) p.speed += OFF_DECEL * dt;
      for (var n = 0; n < seg.sprites.length; n++) { // roadside things and cones: hit one and the car all but stops
        var sp = seg.sprites[n], half = sp.w, hit = sp.solid ? overlap(p.x, PLAYER_W, sp.offset, sp.w, 1) : (!sp.gate && overlap(p.x, PLAYER_W, sp.offset + half / 2 * (sp.offset > 0 ? 1 : -1), half, 1));
        if (hit) { crash(g, sp); break; }
      }
    } else {
      for (var m = 0; m < seg.sprites.length; m++) if (seg.sprites[m].solid && !seg.sprites[m].hit && overlap(p.x, PLAYER_W, seg.sprites[m].offset, seg.sprites[m].w, 1)) { crash(g, seg.sprites[m]); break; }
    }
    for (var k = 0; k < seg.cars.length; k++) { // traffic: you can't pass through it
      var car = seg.cars[k];
      if (p.speed > car.speed && overlap(p.x, PLAYER_W, car.offset, car.w, 0.8)) {
        p.speed = car.speed * (car.speed / p.speed);
        p.pos = car.z - PLAYER_Z;
        if (p.hitCd <= 0) { g.events.push({ type: 'bump' }); p.hitCd = BUMP_COOLDOWN_S; }
        break;
      }
    }
    p.hitCd = Math.max(0, p.hitCd - dt); p.crash = Math.max(0, p.crash - dt);
    p.x = clamp(p.x, -3, 3);
    p.speed = clamp(p.speed, 0, MAX_SPEED);
    g.distance = p.pos;
    // checkpoints in order, then the finish
    for (var c = 0; c < road.checkpoints.length; c++) {
      var cp = road.checkpoints[c];
      if (!cp.hit && p.pos >= cp.index * SEG) {
        if (c > 0 && !road.checkpoints[c - 1].hit) break;
        cp.hit = true; g.time += cp.bonus; g.bonus += 1000; g.events.push({ type: 'checkpoint', n: c, bonus: cp.bonus });
      }
    }
    if (p.pos >= road.finish) {
      g.score += stageScore(g); g.bonus += 5000; g.events.push({ type: 'finish', stage: g.stage.name, next: STAGES[(g.stageIndex + 1) % STAGES.length].name });
      startStage(g, g.stageIndex + 1);
      return;
    }
    if (g.time <= 0) { g.time = 0; g.status = 'over'; g.events.push({ type: 'over' }); }
  }
  // A cone knocks the speed down to two fifths and is gone; a tree beside the road all but stops the car.
  function crash(g, sp) {
    var p = g.player;
    if (sp.hit || (p.crash > 0 && !sp.solid)) return;
    if (sp.solid) { sp.hit = true; p.speed = Math.min(p.speed, MAX_SPEED * CONE_SPEED); g.events.push({ type: 'cone' }); return; }
    p.speed = CRASH_SPEED; p.crash = BUMP_COOLDOWN_S; g.events.push({ type: 'crash', what: sp.type });
    if (p.x < -1 || p.x > 1) p.x = clamp(p.x, -1.05, 1.05);
  }
  function stageScore(g) { return Math.floor(g.road.length / 100); }
  function totalScore(g) { return g.score + Math.floor(g.player.pos / 100) + g.bonus; }

  var Engine = {
    SEG: SEG, ROAD_W: ROAD_W, RUMBLE: RUMBLE, LANES: LANES, FOV: FOV, CAM_H: CAM_H, DRAW: DRAW, CAM_DEPTH: CAM_DEPTH, PLAYER_Z: PLAYER_Z, MAX_SPEED: MAX_SPEED, KMH: KMH, PLAYER_W: PLAYER_W, OFF_LIMIT: OFF_LIMIT,
    ACCEL: ACCEL, CENTRIFUGAL: CENTRIFUGAL, STAGES: STAGES, SPRITE_W: SPRITE_W,
    project: project, overlap: overlap, buildRoad: buildRoad, findSegment: findSegment, percentRemaining: percentRemaining, interpolate: interpolate, makeTraffic: makeTraffic,
    newGame: newGame, update: update, startStage: startStage, totalScore: totalScore, mulberry: mulberry, clamp: clamp
  };
  root.RoadRushEngine = Engine;
})(this);
