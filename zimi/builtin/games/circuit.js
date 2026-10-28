/* ZimiGames: Circuit. Our own code, GPL-3.0. No network, no fonts, no modules.
   A top-down racer on four hand-made tracks. Each track is a short list of corner points; the code rounds the
   corners (Chaikin), walks the line at an even step and derives everything else (tangents, curvature, a speed
   limit and a racing line for the computer cars, where the bridge is). The cars are one small tyre model:
   thrust along the nose, and the sideways slide is removed at no more than the tyres' grip, so a hard turn at
   speed drifts. The engine is pure (no DOM, so node can test it); the page follows only when there is a document.
   Units are world pixels and seconds, y down. */
(function (root) {
  'use strict';

  // ── the cars ─────────────────────────────────────────────────────────────
  var STEP = 16;                    // spacing of the samples along a track's centre line
  var CAR_R = 10.5;                 // collision circle
  var VMAX = 310, ACC = 190, BRAKE = 430, REVERSE_MAX = 70, DRAG = 0.05;
  var YAW_MAX = 3.5, YAW_SPEED = 330; // turn rate at a crawl, and the speed at which it has halved
  var GRIP = 400, GRIP_OFF = 210, BRAKE_GRIP_LOSS = 0.4, SCRUB = 0.18;
  var OFF_VMAX = 0.45, OFF_PULL = 2.2; // grass: the top speed it allows, and how hard it pulls you down to it
  var BBOX_MARGIN = 460;            // ground drawn beyond the road, so the edge of the world is never in view
  var BARRIER = 52;                 // how far past the road's edge the barrier stands
  var BUMP_E = 0.35;                // how lively two cars bounce
  var LOCATE_WINDOW = 8;            // samples searched either side of where the car was
  var STEER_IN = 7, STEER_OUT = 10; // how fast a keyboard's steering follows the key, and returns
  var COUNTDOWN_S = 3, FINISH_GRACE_S = 8, GRID_GAP = 1.9; // samples between grid rows

  var TRACKS = [
    { id: 'oval', name: 'Meridian Oval', note: 'Wide and fast: find the line and hold the throttle.', width: 150, startAt: 0.02, bridge: null, theme: 'park',
      pts: [[1100, 0], [1016, 215], [779, 396], [421, 515], [0, 560], [-421, 515], [-779, 396], [-1016, 215], [-1100, 0], [-1016, -215], [-779, -396], [-421, -515], [0, -560], [421, -515], [779, -396], [1016, -215]] },
    { id: 'switchback', name: 'Switchback', note: 'Sharp turns, a long straight and a wide curve at the end.', width: 120, startAt: 0.0, bridge: null, theme: 'park',
      pts: [[200, 200], [700, 120], [1100, 260], [1500, 140], [1850, 330], [1800, 650], [1450, 760], [1700, 980], [1400, 1180], [950, 1060], [600, 1200], [250, 1050], [380, 800], [150, 600], [420, 430]] },
    { id: 'crossover', name: 'Crossover', note: 'A figure eight: the road crosses itself on a bridge.', width: 130, startAt: 0.25, bridge: [0.43, 0.57], theme: 'park',
      pts: [[0, 0], [272, 260], [525, 450], [742, 520], [909, 450], [1014, 260], [1050, 0], [1014, -260], [909, -450], [742, -520], [525, -450], [272, -260], [0, 0], [-272, 260], [-525, 450], [-742, 520], [-909, 450], [-1014, 260], [-1050, 0], [-1014, -260], [-909, -450], [-742, -520], [-525, -450], [-272, -260]] },
    { id: 'city', name: 'Gridlock', note: 'Narrow streets and right angles; brake early.', width: 110, startAt: 0.02, bridge: null, theme: 'city',
      pts: [[100, 100], [900, 100], [900, 450], [1300, 450], [1300, 100], [1900, 100], [1900, 1000], [1400, 1000], [1400, 1300], [700, 1300], [700, 800], [400, 800], [400, 1300], [100, 1300]] }
  ];

  // ── building a track from its points ─────────────────────────────────────
  function chaikin(pts, rounds) {
    for (var r = 0; r < rounds; r++) {
      var out = [];
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i], q = pts[(i + 1) % pts.length];
        out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]], [0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
      }
      pts = out;
    }
    return pts;
  }

  // The closed polyline walked at an even spacing: N samples, each one `step` apart.
  function resample(pts, step) {
    var n = pts.length, cum = [0], i, L = 0;
    for (i = 0; i < n; i++) { var a = pts[i], b = pts[(i + 1) % n]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); cum.push(L); }
    var N = Math.max(16, Math.round(L / step)), s = L / N, out = [], j = 0;
    for (i = 0; i < N; i++) {
      var d = i * s;
      while (cum[j + 1] < d) j++;
      var p = pts[j], q = pts[(j + 1) % n], f = (d - cum[j]) / ((cum[j + 1] - cum[j]) || 1);
      out.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]);
    }
    return { pts: out, N: N, step: s, length: L };
  }

  function wrap(i, N) { return ((i % N) + N) % N; }
  function angDiff(a, b) { var d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
  var clamp = root.ZimiUtil.clamp;

  // The fastest a car can take a bend of radius R: not past its grip, and not past what its steering can turn.
  function cornerSpeed(R, skill) {
    var byGrip = Math.sqrt(GRIP * 0.82 * R);
    var byYaw = 0.5 * YAW_SPEED * (-1 + Math.sqrt(1 + 4 * YAW_MAX * 0.85 * R / YAW_SPEED));
    return Math.min(VMAX, byGrip, byYaw) * (skill || 1);
  }

  function buildTrack(def) {
    var rs = resample(chaikin(def.pts, 4), STEP), N = rs.N, step = rs.step, i, shift = Math.floor((def.startAt || 0) * N);
    var P = [];
    for (i = 0; i < N; i++) P.push(rs.pts[(i + shift) % N]);
    var x = new Float64Array(N), y = new Float64Array(N), tx = new Float64Array(N), ty = new Float64Array(N);
    for (i = 0; i < N; i++) { x[i] = P[i][0]; y[i] = P[i][1]; }
    for (i = 0; i < N; i++) {
      var a = wrap(i - 1, N), b = wrap(i + 1, N), dx = x[b] - x[a], dy = y[b] - y[a], d = Math.hypot(dx, dy) || 1;
      tx[i] = dx / d; ty[i] = dy / d;
    }
    // signed curvature (positive turns toward the +n side, n = (-ty, tx)), then the racing line and the speed limit
    var curv = new Float64Array(N), K = 3;
    for (i = 0; i < N; i++) {
      var h0 = Math.atan2(ty[wrap(i - K, N)], tx[wrap(i - K, N)]), h1 = Math.atan2(ty[wrap(i + K, N)], tx[wrap(i + K, N)]);
      curv[i] = angDiff(h1, h0) / (2 * K * step);
    }
    var halfW = def.width / 2, maxOff = halfW - 28, line = new Float64Array(N), vlim = new Float64Array(N);
    for (i = 0; i < N; i++) {
      var s = 0, c = 0, j;
      for (j = -3; j <= 12; j++) { s += curv[wrap(i + j, N)]; c++; }
      line[i] = clamp((s / c) * 260, -1, 1) * maxOff * 0.8;
      vlim[i] = cornerSpeed(1 / Math.max(Math.abs(curv[i]), 1e-5));
    }
    var BR = BRAKE * 0.6; // a computer car brakes gently enough to be sure of it: pass backwards, twice round
    for (var pass = 0; pass < 2; pass++) for (i = N - 1; i >= -N; i--) {
      var k = wrap(i, N), nx2 = vlim[wrap(i + 1, N)];
      vlim[k] = Math.min(vlim[k], Math.sqrt(nx2 * nx2 + 2 * BR * step));
    }
    var level = new Uint8Array(N), bridge = null;
    if (def.bridge) {
      var f0 = def.bridge[0], f1 = def.bridge[1], off0 = (def.startAt || 0);
      bridge = [wrap(Math.round((f0 - off0) * N), N), wrap(Math.round((f1 - off0) * N), N)];
      for (i = 0; i < N; i++) level[i] = inRange(i, bridge, N) ? 1 : 0;
    }
    // where the road meets another stretch of itself (the bridge's crossing): no barrier and no wall there
    var zone = new Uint8Array(N), lim = halfW * 2.6, near = Math.round(N / 10), j2;
    for (i = 0; i < N; i++) for (j2 = i + near; j2 < i + N - near; j2++) {
      var q = j2 % N;
      if (Math.abs(x[i] - x[q]) < lim && Math.abs(y[i] - y[q]) < lim && Math.hypot(x[i] - x[q], y[i] - y[q]) < lim) { zone[i] = 1; break; }
    }
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, M = BBOX_MARGIN;
    for (i = 0; i < N; i++) { x0 = Math.min(x0, x[i]); x1 = Math.max(x1, x[i]); y0 = Math.min(y0, y[i]); y1 = Math.max(y1, y[i]); }
    return { id: def.id, name: def.name, note: def.note, theme: def.theme, N: N, step: step, length: rs.length, width: def.width, halfW: halfW, x: x, y: y, tx: tx, ty: ty, curv: curv,
      line: line, vlim: vlim, level: level, bridge: bridge, zone: zone, bbox: { x0: x0 - M, y0: y0 - M, x1: x1 + M, y1: y1 + M } };
  }
  function inRange(i, r, N) { return r[0] <= r[1] ? i >= r[0] && i <= r[1] : i >= r[0] || i <= r[1]; }

  var built = {};
  function track(id) {
    if (!built[id]) for (var k = 0; k < TRACKS.length; k++) if (TRACKS[k].id === id) built[id] = buildTrack(TRACKS[k]);
    return built[id];
  }

  // Where a point on the line is, for any (fractional, unwrapped) sample index.
  function pointAt(T, idx) {
    var N = T.N, i = wrap(Math.floor(idx), N), f = idx - Math.floor(idx), j = (i + 1) % N;
    var tx = T.tx[i] + (T.tx[j] - T.tx[i]) * f, ty = T.ty[i] + (T.ty[j] - T.ty[i]) * f, d = Math.hypot(tx, ty) || 1;
    return { x: T.x[i] + (T.x[j] - T.x[i]) * f, y: T.y[i] + (T.y[j] - T.y[i]) * f, tx: tx / d, ty: ty / d };
  }

  // Which sample a car is nearest, searched only near where it was (so a bridge's two roads never get mixed up);
  // sets its index, how far it is along the road (prog, in samples, never wrapped), and its side offset (lat).
  function locate(T, car) {
    var N = T.N, base = Math.floor(car.idx), best = Infinity, bi = base, bt = 0, d;
    for (d = -LOCATE_WINDOW; d <= LOCATE_WINDOW; d++) {
      var i = wrap(base + d, N), j = (i + 1) % N, ax = T.x[i], ay = T.y[i], ex = T.x[j] - ax, ey = T.y[j] - ay;
      var t = clamp(((car.x - ax) * ex + (car.y - ay) * ey) / (ex * ex + ey * ey), 0, 1);
      var qx = ax + ex * t - car.x, qy = ay + ey * t - car.y, dd = qx * qx + qy * qy;
      if (dd < best) { best = dd; bi = i; bt = t; }
    }
    var idx = bi + bt, delta = idx - car.idx;
    if (delta > N / 2) delta -= N; else if (delta < -N / 2) delta += N;
    car.prog += delta;
    car.idx = wrap(Math.floor(idx), N) + (idx - Math.floor(idx));
    var p = pointAt(T, car.idx);
    car.lat = (car.x - p.x) * -p.ty + (car.y - p.y) * p.tx;
    car.off = Math.abs(car.lat) > T.halfW;
    car.level = T.level[wrap(Math.floor(car.idx), N)];
  }

  // ── a car ────────────────────────────────────────────────────────────────
  function spawn(T, prog, lat, opts) {
    var p = pointAt(T, prog), nx = -p.ty, ny = p.tx;
    var car = { x: p.x + nx * lat, y: p.y + ny * lat, h: Math.atan2(p.ty, p.tx), vx: 0, vy: 0, steer: 0, slide: 0, idx: wrap(prog, T.N), prog: prog, lat: lat, off: false, level: 0,
      color: 0, human: false, auto: false, name: '', maxK: -1, lapStart: null, laps: [], best: null, finished: false, finishTime: null, stuck: 0, input: { steer: 0, gas: 0, brake: 0 }, ai: null };
    for (var k in opts) car[k] = opts[k];
    locate(T, car);
    return car;
  }

  // One car for dt seconds. inp: steer -1..1 (left negative), gas 0..1, brake 0..1.
  function stepCar(T, car, inp, dt, smooth) {
    if (smooth) { // a key steers in ramps, a computer car steers exactly
      var rate = Math.abs(inp.steer) > Math.abs(car.steer) || inp.steer * car.steer < 0 ? STEER_IN : STEER_OUT;
      var dS = inp.steer - car.steer, maxS = rate * dt;
      car.steer = Math.abs(dS) <= maxS ? inp.steer : car.steer + Math.sign(dS) * maxS;
    } else car.steer = inp.steer;
    var hx = Math.cos(car.h), hy = Math.sin(car.h), f = car.vx * hx + car.vy * hy;
    var yaw = car.steer * YAW_MAX / (1 + Math.abs(f) / YAW_SPEED) * Math.min(1, Math.abs(f) / 40) * (f < -1 ? -1 : 1);
    car.h += yaw * dt;
    hx = Math.cos(car.h); hy = Math.sin(car.h);
    f = car.vx * hx + car.vy * hy;
    var l = -car.vx * hy + car.vy * hx, vmax = car.off ? VMAX * OFF_VMAX : VMAX;
    if (inp.gas > 0 && f < vmax) f += ACC * inp.gas * (1 - Math.max(f, 0) / vmax) * dt;
    if (inp.brake > 0) f = f > 0 ? Math.max(0, f - BRAKE * inp.brake * dt) : Math.max(-REVERSE_MAX, f - 90 * inp.brake * dt);
    f -= f * DRAG * dt;
    if (car.off && f > vmax) f -= (f - vmax) * OFF_PULL * dt;
    var grip = (car.off ? GRIP_OFF : GRIP) * (1 - (f > 0 ? BRAKE_GRIP_LOSS * inp.brake : 0)), dl = clamp(-l, -grip * dt, grip * dt);
    l += dl;
    if (Math.abs(l) > 12 && f > 0) f -= Math.abs(dl) * SCRUB;
    car.slide = clamp(Math.abs(l) / 90, 0, 1);
    car.vx = f * hx - l * hy; car.vy = f * hy + l * hx;
    car.x += car.vx * dt; car.y += car.vy * dt;
    locate(T, car);
    var over = Math.abs(car.lat) - (T.halfW + BARRIER);
    if (over > 0 && !T.zone[Math.floor(car.idx)]) { // the barrier: back onto the grass, outward speed mostly gone
      var p = pointAt(T, car.idx), sgn = car.lat > 0 ? 1 : -1, nx = -p.ty * sgn, ny = p.tx * sgn;
      car.x -= nx * over; car.y -= ny * over;
      var out = car.vx * nx + car.vy * ny;
      if (out > 0) { car.vx -= nx * out * 1.3; car.vy -= ny * out * 1.3; }
      car.vx *= 0.96; car.vy *= 0.96;
      locate(T, car);
    }
  }

  // Two cars that touch: pushed apart, and the speed along the line between them swapped, a little lost.
  function bump(a, b) {
    if (a.level !== b.level) return false;
    var dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy, r = CAR_R * 2;
    if (d2 >= r * r) return false;
    var d = Math.sqrt(d2) || 0.01, nx = dx / d, ny = dy / d, push = (r - d) / 2;
    a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
    var rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (rel < 0) {
      var j = -(1 + BUMP_E) * rel / 2;
      a.vx -= nx * j; a.vy -= ny * j; b.vx += nx * j; b.vy += ny * j;
    }
    return true;
  }

  // ── the computer drivers ─────────────────────────────────────────────────
  function aiInput(race, car) {
    var T = race.track, N = T.N, i = Math.floor(car.idx), f = car.vx * Math.cos(car.h) + car.vy * Math.sin(car.h), ai = car.ai;
    var ahead = (34 + Math.abs(f) * 0.26) / T.step, it = i + Math.round(ahead);
    // overtaking: a car just ahead in my path means the free side, held until I am by it
    var pass = null, k;
    for (k = 0; k < race.cars.length; k++) {
      var o = race.cars[k];
      if (o === car || o.level !== car.level) continue;
      var ds = (o.prog - car.prog) * T.step;
      if (ds > 0 && ds < 105 && Math.abs(o.lat - car.lat) < 30 && (!pass || ds < pass.ds)) pass = { ds: ds, o: o };
    }
    if (pass) ai.pass = { side: pass.o.lat > car.lat ? -1 : (pass.o.lat < car.lat ? 1 : (car.lat > 0 ? 1 : -1)), lat: pass.o.lat, t: 0.9 };
    else if (ai.pass) { ai.pass.t -= 1 / 60; if (ai.pass.t <= 0) ai.pass = null; }
    var target = T.line[wrap(it, N)] * 0.9 + ai.bias, maxOff = T.halfW - 20;
    if (ai.pass) target = clamp(ai.pass.lat + ai.pass.side * 36, -maxOff, maxOff);
    target = clamp(target, -maxOff, maxOff);
    var p = pointAt(T, it), ax = p.x - p.ty * target, ay = p.y + p.tx * target;
    var want = Math.atan2(ay - car.y, ax - car.x), steer = clamp(angDiff(want, car.h) * 2.4, -1, 1);
    // speed: the limit a little ahead of me, scaled by how well this driver drives and the field's rubber band
    var vt = T.vlim[wrap(i + Math.ceil(f * 0.22 / T.step), N)] * ai.skill * ai.band;
    if (car.off) vt = Math.min(vt, 120);
    if (pass && pass.ds < 40 && Math.abs(ai.pass.lat - car.lat) < 20) vt = Math.min(vt, pass.o.vx * Math.cos(car.h) + pass.o.vy * Math.sin(car.h) + 10); // no room: sit behind
    var gas = 0, brake = 0;
    if (f > vt * 1.04) brake = clamp((f - vt) / 45, 0, 1); else gas = clamp((vt - f) / 18 + 0.2, 0, 1);
    return { steer: steer, gas: gas, brake: brake };
  }

  // Put a car back on the line, facing the way round (after being stuck, or the R key).
  function respawn(T, car) {
    var p = pointAt(T, car.idx);
    car.x = p.x; car.y = p.y; car.h = Math.atan2(p.ty, p.tx); car.vx = car.vy = 0; car.steer = 0; car.stuck = 0;
    locate(T, car);
  }

  // ── a race ───────────────────────────────────────────────────────────────
  var DIFFICULTY = { easy: 0.84, normal: 0.9, hard: 0.96 };
  var NAMES = ['Ember', 'Quill', 'Sable', 'Juniper', 'Fennel', 'Tarn'];

  // humans: how many cars the people drive (1 or 2). Returns the race; cars[0..humans-1] are the people's.
  function createRace(trackId, opts) {
    var T = track(trackId), o = opts || {}, humans = o.humans || 1, aiN = o.ai == null ? 4 : o.ai, laps = o.laps || 3, rng = mulberry(o.seed == null ? 7 : o.seed);
    var base = DIFFICULTY[o.difficulty] || DIFFICULTY.normal, total = humans + aiN, cars = [], s, hs = Math.min(Math.floor(total / 2), total - humans), h = 0, a = 0;
    for (s = 0; s < total; s++) {
      var isHuman = s >= hs && s < hs + humans, lat = (s % 2 ? 1 : -1) * 0.28 * T.halfW, prog = -(s + 1) * GRID_GAP;
      if (isHuman) { cars.push(spawn(T, prog, lat, { human: true, color: h, name: o.names && o.names[h] || 'You', slot: s })); h++; }
      else {
        cars.push(spawn(T, prog, lat, { color: 2 + (a % 5), name: NAMES[a % NAMES.length], slot: s,
          ai: { skill: o.sim ? 0.95 : base + (rng() - 0.5) * 0.05, band: 1, bias: (rng() - 0.5) * 0.4 * T.halfW, pass: null } }));
        a++;
      }
    }
    // the people first, in the order they were asked for
    cars.sort(function (p, q) { return (q.human - p.human) || (p.slot - q.slot); });
    if (o.sim) cars.forEach(function (c, n) { if (c.human) { c.auto = true; c.ai = { skill: 0.95, band: 1, bias: 0, pass: null }; } });
    return { track: T, cars: cars, laps: laps, t: -COUNTDOWN_S, phase: 'countdown', events: [], doneAt: null, difficulty: o.difficulty || 'normal' };
  }

  var mulberry = root.ZimiUtil.mulberry32;

  // Lap and finish bookkeeping for one car after it moved from prog0 to car.prog at race time t.
  function lapCheck(race, car, prog0, dt) {
    var N = race.track.N, k = Math.floor(car.prog / N);
    if (k <= car.maxK) return;
    car.maxK = k;
    var cross = race.t - dt * (car.prog - k * N) / ((car.prog - prog0) || 1);
    if (k >= 1 && car.lapStart != null) {
      var lap = cross - car.lapStart;
      car.laps.push(lap);
      var rec = car.best == null || lap < car.best;
      if (rec) car.best = lap;
      race.events.push({ type: 'lap', car: car, n: k, time: lap, best: rec });
    }
    car.lapStart = cross;
    if (k >= race.laps && !car.finished) {
      car.finished = true; car.finishTime = cross; car.auto = true;
      if (!car.ai) car.ai = { skill: 0.9, band: 1, bias: 0, pass: null };
      race.events.push({ type: 'finish', car: car, time: cross });
    }
  }

  function step(race, dt) {
    var T = race.track, cars = race.cars, i, j;
    if (race.phase === 'countdown') {
      race.t += dt;
      if (race.t >= 0) { race.phase = 'racing'; race.events.push({ type: 'go' }); }
      return;
    }
    if (race.phase === 'done') return;
    race.t += dt;
    var lead = -Infinity, humanBest = -Infinity;
    for (i = 0; i < cars.length; i++) { lead = Math.max(lead, cars[i].prog); if (cars[i].human && !cars[i].finished) humanBest = Math.max(humanBest, cars[i].prog); }
    for (i = 0; i < cars.length; i++) {
      var c = cars[i], inp;
      if (c.ai && !c.human || c.auto) {
        // a gentle rubber band: a computer car well ahead of the people eases off, one well behind finds a little more
        if (humanBest > -Infinity && !c.human) c.ai.band = 1 - clamp((c.prog - humanBest) * T.step / 3200, -0.04, 0.05);
        inp = aiInput(race, c);
      } else inp = c.input;
      c.lastInp = inp;
      var p0 = c.prog;
      stepCar(T, c, inp, dt, !(c.ai && !c.human || c.auto));
      lapCheck(race, c, p0, dt);
      var spd = Math.hypot(c.vx, c.vy);
      c.stuck = (spd < 14 && race.t > 1 && !c.finished) ? c.stuck + dt : 0;
      if (c.stuck > (c.human ? 4 : 2)) respawn(T, c);
    }
    for (i = 0; i < cars.length; i++) for (j = i + 1; j < cars.length; j++) if (bump(cars[i], cars[j])) race.events.push({ type: 'bump', a: cars[i], b: cars[j] });
    var people = cars.filter(function (c) { return c.human; }), allHumansDone = people.every(function (c) { return c.finished; });
    if (allHumansDone) {
      if (race.doneAt == null) race.doneAt = race.t;
      if (race.t - race.doneAt > FINISH_GRACE_S || cars.every(function (c) { return c.finished; })) { race.phase = 'done'; race.events.push({ type: 'done' }); }
    }
  }

  // Finishers by time, then everyone else by how far round they are.
  function standings(race) {
    return race.cars.slice().sort(function (a, b) {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) return a.finishTime - b.finishTime;
      return b.prog - a.prog;
    });
  }

  // ── a ghost: a lap as a position every 1/GHOST_HZ s ──────────────────────
  var GHOST_HZ = 20;
  function ghostPush(g, x, y, h) { g.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(h * 100) / 100); }
  function ghostAt(g, t) {
    var n = g.length / 3, f = t * GHOST_HZ, i = Math.floor(f);
    if (f < 0 || n < 2 || i >= n - 1) return null;
    var u = f - i, a = i * 3, b = a + 3;
    return { x: g[a] + (g[b] - g[a]) * u, y: g[a + 1] + (g[b + 1] - g[a + 1]) * u, h: g[a + 2] + angDiff(g[b + 2], g[a + 2]) * u };
  }

  // ── keys ─────────────────────────────────────────────────────────────────
  // The two people's keys (letters lower case): one player may use either set; two players split them (WASD, arrows).
  var KEYMAPS = [
    { left: ['a'], right: ['d'], gas: ['w'], brake: ['s'] },
    { left: ['ArrowLeft'], right: ['ArrowRight'], gas: ['ArrowUp'], brake: ['ArrowDown'] }
  ];

  var Engine = {
    TRACKS: TRACKS, track: track, buildTrack: buildTrack, pointAt: pointAt, locate: locate, spawn: spawn, stepCar: stepCar, bump: bump, aiInput: aiInput, respawn: respawn,
    createRace: createRace, step: step, standings: standings, ghostPush: ghostPush, ghostAt: ghostAt, GHOST_HZ: GHOST_HZ, KEYMAPS: KEYMAPS, DIFFICULTY: DIFFICULTY,
    CAR_R: CAR_R, VMAX: VMAX, STEP: STEP, BARRIER: BARRIER, COUNTDOWN_S: COUNTDOWN_S, FINISH_GRACE_S: FINISH_GRACE_S, GRIP: GRIP, cornerSpeed: cornerSpeed,
    wrap: wrap, clamp: clamp, mulberry: mulberry, BBOX_MARGIN: BBOX_MARGIN
  };
  root.CircuitEngine = Engine;
})(this);
