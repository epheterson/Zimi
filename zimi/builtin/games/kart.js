/* ZimiGames: ZimiKart, the rules. Tracks as data, kart physics with a drift that charges a mini-boost, our own five items,
   the drivers and their habits, laps and checkpoints, the camera's projection. No DOM: tested in node. Our own code, GPL-3.0.
   World units: a kart is about 11 long, a road about 50 wide, a lap about 2,400. y points down the screen. An angle of 0 faces +x
   and angles grow clockwise on screen; "right" of a heading is (-sin, cos). */
(function (root) {
  'use strict';
  var TAU = Math.PI * 2;

  // ── tuning ───────────────────────────────────────────────────────────────
  var STEP = 1 / 60, WORLD = 1024, DS = 6, VMAX = 72, ACCEL = 44, BRAKE = 120, COAST = 14, REVERSE_MAX = 16, ROUGH_V = 0.55, ROUGH_DRAG = 30;
  var TURN = 2.05, TURN_FALLOFF = 0.34, STEER_RATE = 6.5, GRIP = 16, SCRUB = 0.22;
  var DRIFT_TURN = 1.3, DRIFT_PULL = 0.55, DRIFT_GRIP = 7, DRIFT_MIN_V = VMAX * 0.45, DRIFT_SPEED = 1.06;
  var CHARGE = [0.6, 1.2, 2.0], MINI = [0.6, 1.1, 1.7], BOOST_CAP = 1.4, BOOST_PUSH = 140, ITEM_BOOST_S = 1.5, PAD_BOOST_S = 0.9;
  var SHOULDER = 14, WALL_W = 9, KART_R = 5.5, WALL_KEEP = 0.45, LOCATE_WIN = 20;
  var JUMP_REACH = 56, JUMP_MIN_V = 34, AIR_H = 16, RAMP_LEN = 36, GAP_LEN = 42, FALL_PENALTY_S = 1.2;
  var SPIN_S = 1.1, INVULN_S = 2, SHIELD_S = 9, MAGNET_S = 3.5, MAGNET_CAP = 1.18, MAGNET_PULL = 22, OIL_S = 28, OIL_R = 11, BOX_R = 11, BOX_AGAIN_S = 4;
  var SPARK_V = 128, SPARK_TURN = 3.6, SPARK_S = 5, SPARK_R = 8, ROLL_S = 0.7;
  var NCP = 8, COUNT_S = 3.2, FINISH_WAIT_S = 10, GHOST_DT = 0.1, A_LAT = 54, V_MIN = 34, AI_BRAKE = 70, LINE_GAIN = 900;
  var RB_RANGE = 320, RB_BEHIND = 0.06, RB_AHEAD = 0.04;
  var GP_POINTS = [15, 12, 10, 8, 6, 4, 2, 1];
  var DIFFICULTY = { easy: 0.92, normal: 0.98, hard: 1.03 };
  var ITEMS = ['boost', 'slick', 'spark', 'shield', 'magnet'];
  // What the draw favours: the leader's table and the last car's; every place between mixes the two.
  var DRAW_LEAD = { boost: 14, slick: 38, spark: 4, shield: 40, magnet: 0 };
  var DRAW_LAST = { boost: 28, slick: 0, spark: 30, shield: 4, magnet: 38 };

  var clamp = root.ZimiUtil.clamp;
  function angDiff(a, b) { var d = (a - b) % TAU; if (d > Math.PI) d -= TAU; else if (d <= -Math.PI) d += TAU; return d; }
  var mulberry = root.ZimiUtil.mulberry32;

  // ── the six tracks and the eight drivers ─────────────────────────────────
  // pts: the road's centre line, a closed spline through them. boxes: where item rows sit (fraction of the lap).
  // pads: speed pads (fraction). jump: the ramp and the gap after it (fraction). Everything else the page draws from theme.
  var TRACKS = [
    { id: 'tidewalk', name: 'Tidewalk', cup: 0, theme: 'beach', halfW: 30, note: 'A sandy loop with a long sea bend', boxes: [0.1, 0.4, 0.7], pads: [0.25, 0.84],
      pts: [[170, 790], [120, 560], [200, 330], [390, 200], [600, 150], [820, 220], [905, 430], [820, 610], [660, 670], [580, 790], [450, 880], [300, 880]] },
    { id: 'stacks', name: 'The Stacks', cup: 0, theme: 'library', halfW: 24, note: 'Tight aisles between the shelves', boxes: [0.08, 0.36, 0.64, 0.9], pads: [0.3, 0.88],
      pts: [[222, 214], [366, 190], [378, 390], [502, 410], [518, 210], [678, 194], [822, 254], [842, 422], [806, 550], [842, 694], [826, 826], [654, 830], [638, 614], [510, 598], [490, 826], [334, 830], [206, 798], [182, 614], [202, 422]] },
    { id: 'night', name: 'Night Market', cup: 0, theme: 'city', halfW: 28, note: 'Lantern streets, sharp corners', boxes: [0.12, 0.45, 0.78], pads: [0.08, 0.52],
      pts: [[150, 200], [480, 140], [800, 195], [905, 315], [715, 440], [905, 570], [820, 710], [930, 840], [620, 890], [505, 765], [380, 870], [160, 840], [110, 665], [335, 590], [135, 425]] },
    { id: 'frostpass', name: 'Frostpass', cup: 1, theme: 'snow', halfW: 27, note: 'Hairpins down a snowy mountain', boxes: [0.1, 0.38, 0.66, 0.9], pads: [0.12, 0.7],
      pts: [[130, 830], [205, 600], [130, 390], [250, 190], [470, 125], [575, 335], [715, 185], [885, 265], [925, 485], [765, 565], [905, 705], [825, 905], [600, 855], [480, 725], [345, 885]] },
    { id: 'redrock', name: 'Redrock Canyon', cup: 1, theme: 'desert', halfW: 30, note: 'Wide road and one big jump', boxes: [0.1, 0.5, 0.8], pads: [0.08, 0.65], jump: 0.14,
      pts: [[160, 860], [140, 620], [180, 340], [350, 170], [560, 130], [760, 190], [790, 390], [640, 505], [805, 645], [905, 805], [765, 925], [545, 905], [405, 785], [300, 905]] },
    { id: 'aurora', name: 'Aurora Ridge', cup: 1, theme: 'aurora', halfW: 32, note: 'Sweeping curves under green light', boxes: [0.14, 0.42, 0.7, 0.92], pads: [0.08, 0.35],
      pts: [[140, 510], [205, 265], [425, 165], [560, 305], [705, 145], [880, 245], [905, 525], [780, 705], [900, 885], [645, 925], [520, 765], [385, 905], [205, 835]] }
  ];
  var CUPS = [{ id: 'orange', name: 'Orange Cup', tracks: [0, 1, 2] }, { id: 'aurora', name: 'Aurora Cup', tracks: [3, 4, 5] }];

  // Small round critters. skill scales a driver's pace; drift is how often it drifts a corner; lane shifts its line sideways;
  // wobble is how often it slips; items: when it uses what it holds.
  var DRIVERS = [
    { id: 'pip', name: 'Pip', kind: 'mouse', body: '#cfc9bd', belly: '#f2e8d8', kart: '#f2a516', trim: '#7a4a05', skill: 0.95, drift: 0.5, lane: 0.1, wobble: 0.01, items: 'patient', note: 'Quick and neat' },
    { id: 'bram', name: 'Bram', kind: 'bear', body: '#8a5a36', belly: '#c79a6b', kart: '#3a63c9', trim: '#1b2f6b', skill: 0.95, drift: 0.3, lane: 0, wobble: 0.01, items: 'patient', note: 'Steady' },
    { id: 'juno', name: 'Juno', kind: 'hare', body: '#f1ecf6', belly: '#d9c9ec', kart: '#c94fa0', trim: '#6b1d52', skill: 0.98, drift: 0.9, lane: -0.3, wobble: 0.03, items: 'eager', note: 'Fast, takes risks' },
    { id: 'tilly', name: 'Tilly', kind: 'cat', body: '#4c5566', belly: '#9aa3b4', kart: '#1e9ec4', trim: '#0b4a60', skill: 0.96, drift: 0.6, lane: 0.2, wobble: 0.01, items: 'tactical', note: 'Waits for a target' },
    { id: 'moss', name: 'Moss', kind: 'frog', body: '#5db35b', belly: '#c4e8a8', kart: '#e3c321', trim: '#6e5d05', skill: 0.9, drift: 0.1, lane: 0, wobble: 0.06, items: 'eager', note: 'Wobbly, friendly' },
    { id: 'orla', name: 'Orla', kind: 'owl', body: '#8f6fb8', belly: '#dccdf0', kart: '#d1473f', trim: '#6a1b16', skill: 0.97, drift: 0.5, lane: 0.3, wobble: 0.005, items: 'patient', note: 'Cuts every corner' },
    { id: 'finn', name: 'Finn', kind: 'fox', body: '#e2672b', belly: '#fbe3c8', kart: '#e9eef7', trim: '#5b6578', skill: 0.96, drift: 0.7, lane: -0.1, wobble: 0.02, items: 'aggressive', note: 'Loves a slick' },
    { id: 'sorrel', name: 'Sorrel', kind: 'hog', body: '#b58b57', belly: '#f0d9b0', kart: '#3d9a4a', trim: '#1a4a22', skill: 0.91, drift: 0.2, lane: 0.05, wobble: 0.02, items: 'defensive', note: 'Slow, hard to hit' }
  ];

  // ── the track: a spline sampled evenly ──────────────────────────────────
  function spline(pts, per) {
    var out = [], n = pts.length, i, j;
    for (i = 0; i < n; i++) {
      var p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      for (j = 0; j < per; j++) {
        var t = j / per, t2 = t * t, t3 = t2 * t;
        out.push([0.5 * (2 * p1[0] + (p2[0] - p0[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (3 * p1[0] - p0[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * (2 * p1[1] + (p2[1] - p0[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (3 * p1[1] - p0[1] - 3 * p2[1] + p3[1]) * t3)]);
      }
    }
    return out;
  }
  function smooth(a, r, N) { // a moving average on a loop
    var out = new Float32Array(N), i, k;
    for (i = 0; i < N; i++) { var s = 0; for (k = -r; k <= r; k++) s += a[(i + k + N) % N]; out[i] = s / (2 * r + 1); }
    return out;
  }
  function track(id) { for (var i = 0; i < TRACKS.length; i++) if (TRACKS[i].id === id) return TRACKS[i]; return TRACKS[0]; }

  function buildTrack(def) {
    if (typeof def === 'string') def = track(def);
    var dense = spline(def.pts, 40), n = dense.length, i, cum = [0], total = 0;
    for (i = 0; i < n; i++) { var q = dense[(i + 1) % n]; total += Math.hypot(q[0] - dense[i][0], q[1] - dense[i][1]); cum.push(total); }
    var N = Math.round(total / DS), ds = total / N, x = new Float32Array(N), y = new Float32Array(N), j = 0;
    for (i = 0; i < N; i++) {
      var target = i * ds;
      while (cum[j + 1] < target) j++;
      var f = (target - cum[j]) / (cum[j + 1] - cum[j]), a = dense[j % n], b = dense[(j + 1) % n];
      x[i] = a[0] + (b[0] - a[0]) * f; y[i] = a[1] + (b[1] - a[1]) * f;
    }
    var tx = new Float32Array(N), ty = new Float32Array(N), th = new Float32Array(N), kr = new Float32Array(N);
    for (i = 0; i < N; i++) {
      var p = (i + N - 1) % N, nx = (i + 1) % N, dx = x[nx] - x[p], dy = y[nx] - y[p], len = Math.hypot(dx, dy);
      tx[i] = dx / len; ty[i] = dy / len; th[i] = Math.atan2(dy, dx);
    }
    for (i = 0; i < N; i++) kr[i] = angDiff(th[(i + 1) % N], th[(i + N - 1) % N]) / (2 * ds);
    var curv = smooth(kr, 4, N), wide = smooth(kr, 11, N), line = new Float32Array(N), cv = new Float32Array(N), lim = def.halfW * 0.5;
    for (i = 0; i < N; i++) {
      line[i] = clamp(wide[i] * LINE_GAIN, -lim, lim); // inside of the bend: positive is right
      cv[i] = clamp(Math.sqrt(A_LAT / Math.max(Math.abs(smooth1(kr, i, 7, N)), 1e-4)), V_MIN, 200);
    }
    for (var pass = 0; pass < 3; pass++) for (i = N - 1; i >= 0; i--) { var nv = cv[(i + 1) % N]; cv[i] = Math.min(cv[i], Math.sqrt(nv * nv + 2 * AI_BRAKE * ds)); }
    var L = total, T = { def: def, id: def.id, N: N, ds: ds, L: L, x: x, y: y, tx: tx, ty: ty, th: th, curv: curv, line: line, cornerV: cv, halfW: def.halfW, shoulder: SHOULDER, wallW: WALL_W,
      reach: def.halfW + SHOULDER, bbox: bounds(x, y, N), boxes: [], pads: [], gap: null, ramp: null, ncp: NCP };
    (def.boxes || []).forEach(function (fr) {
      var k = Math.round(fr * N) % N;
      [-0.55, 0, 0.55].forEach(function (o) { T.boxes.push({ x: x[k] - ty[k] * o * def.halfW, y: y[k] + tx[k] * o * def.halfW, s: k * ds, i: k }); });
    });
    (def.pads || []).forEach(function (fr) { var k = Math.round(fr * N) % N; T.pads.push({ i: k, s: k * ds, len: 30 }); });
    if (def.jump != null) {
      var g0 = def.jump * L;
      T.gap = { from: g0, to: g0 + GAP_LEN }; T.ramp = { from: g0 - RAMP_LEN, to: g0 };
      for (i = 0; i < N; i++) if (inJump(T, i * ds, 90)) { cv[i] = 200; line[i] = 0; }
    }
    return T;
  }
  function inJump(T, s, lead) { return !!T.gap && s >= T.ramp.from - lead && s <= T.gap.to + 12; }
  function smooth1(a, i, r, N) { var s = 0, k; for (k = -r; k <= r; k++) s += a[(i + k + N) % N]; return s / (2 * r + 1); }
  function bounds(x, y, N) {
    var b = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 }, i;
    for (i = 0; i < N; i++) { if (x[i] < b.x0) b.x0 = x[i]; if (x[i] > b.x1) b.x1 = x[i]; if (y[i] < b.y0) b.y0 = y[i]; if (y[i] > b.y1) b.y1 = y[i]; }
    return b;
  }
  function pointAt(T, s, off) { // the road at arclength s, off to the right of the centre line
    var f = ((s / T.ds) % T.N + T.N) % T.N, i = Math.floor(f), j = (i + 1) % T.N, u = f - i, o = off || 0;
    var cx = T.x[i] + (T.x[j] - T.x[i]) * u, cy = T.y[i] + (T.y[j] - T.y[i]) * u, ux = T.tx[i] + (T.tx[j] - T.tx[i]) * u, uy = T.ty[i] + (T.ty[j] - T.ty[i]) * u, ln = Math.hypot(ux, uy);
    ux /= ln; uy /= ln;
    return { x: cx - uy * o, y: cy + ux * o, a: Math.atan2(uy, ux), i: i };
  }
  // Where a point is on the road: the nearest sample (searched near `hint`, or everywhere), the arclength, and the side offset (right is positive).
  function locate(T, px, py, hint) {
    var N = T.N, best = 0, bd = 1e18, i, k, lo = 0, hi = N - 1, all = hint == null || hint < 0;
    if (!all) { lo = -LOCATE_WIN; hi = LOCATE_WIN; }
    for (k = lo; k <= hi; k++) {
      i = all ? k : (hint + k + N) % N;
      var dx = T.x[i] - px, dy = T.y[i] - py, d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = i; }
    }
    var out = null, od = 1e18, seg;
    for (seg = -1; seg <= 0; seg++) {
      var a = (best + seg + N) % N, b = (a + 1) % N, sx = T.x[b] - T.x[a], sy = T.y[b] - T.y[a], ll = sx * sx + sy * sy;
      var t = clamp(((px - T.x[a]) * sx + (py - T.y[a]) * sy) / ll, 0, 1), qx = T.x[a] + sx * t, qy = T.y[a] + sy * t, d = Math.hypot(px - qx, py - qy);
      if (d < od) { od = d; var l = Math.sqrt(ll); out = { i: best, s: ((a + t) * T.ds) % T.L, d: ((px - qx) * -sy + (py - qy) * sx) / l }; }
    }
    return out;
  }

  // ── the camera: Mode-7 projection ────────────────────────────────────────
  // A camera looks along `yaw` from (x, y), `h` above the ground, over a view w x hz px (hz = the horizon row, f = the focal length).
  function makeCamera(x, y, yaw, view) {
    return { x: x, y: y, yaw: yaw, fx: Math.cos(yaw), fy: Math.sin(yaw), rx: -Math.sin(yaw), ry: Math.cos(yaw), h: view.h, f: view.f, w: view.w, hz: view.hz };
  }
  // A ground point on screen: {sx, sy, z, scale} (scale = pixels per world unit there), or null when it is behind the camera.
  function project(cam, px, py) {
    var dx = px - cam.x, dy = py - cam.y, z = dx * cam.fx + dy * cam.fy;
    if (z < 2) return null;
    var xs = dx * cam.rx + dy * cam.ry, sc = cam.f / z;
    return { sx: cam.w / 2 + xs * sc, sy: cam.hz + cam.h * sc, z: z, scale: sc };
  }
  // The ground under a screen pixel (the floor's inverse of project), or null above the horizon.
  function groundAt(cam, sx, sy) {
    var dy = sy - cam.hz;
    if (dy <= 0) return null;
    var z = cam.h * cam.f / dy, xs = (sx - cam.w / 2) * z / cam.f;
    return { x: cam.x + cam.fx * z + cam.rx * xs, y: cam.y + cam.fy * z + cam.ry * xs, z: z };
  }

  // ── a kart ───────────────────────────────────────────────────────────────
  function driftLevel(charge) { return charge >= CHARGE[2] ? 3 : charge >= CHARGE[1] ? 2 : charge >= CHARGE[0] ? 1 : 0; }
  function turnRate(v) { return TURN * (1 - TURN_FALLOFF * clamp(Math.abs(v) / VMAX, 0, 1)) * Math.min(1, Math.abs(v) / 12); }

  function newKart(id, driver, human) {
    return { id: id, driver: driver, human: human, x: 0, y: 0, angle: 0, dir: 0, v: 0, steer: 0, drift: 0, charge: 0, boost: 0, air: 0, airT: 0, z: 0, spin: 0, spinA: 0, inv: 0, shield: 0, magnet: 0,
      item: null, roll: 0, itemWas: false, itemDelay: 0, s: 0, d: 0, idx: -1, total: 0, lap: 0, cp: 1, lapBase: 0, finished: null, place: 0, wall: 0, rough: false, fell: 0, speedScale: 1,
      lastCp: 0, lapStart: 0, laps: [], hop: 0, wrong: 0, bonk: 0, hits: 0, mood: 0 };
  }
  function placeKart(T, k, s, off) {
    var p = pointAt(T, s, off);
    k.x = p.x; k.y = p.y; k.angle = k.dir = p.a; k.v = 0; k.idx = -1;
    var l = locate(T, k.x, k.y, -1); k.idx = l.i; k.s = l.s; k.d = l.d;
    k.total = l.s > T.L / 2 ? l.s - T.L : l.s;
  }
  function respawn(T, k) { // back on the road at the last checkpoint passed
    var at = (k.lastCp || 0) - 6;
    placeKart(T, k, ((at % T.L) + T.L) % T.L, 0);
    k.total = k.lapBase + at; k.spin = 0; k.drift = 0; k.charge = 0; k.boost = 0; k.air = 0; k.z = 0; k.inv = INVULN_S; k.fell = 0; k.steer = 0;
  }

  // Release a drift: the mini-boost its charge bought (0 when it never charged). Returns the level.
  function endDrift(k) {
    var lv = driftLevel(k.charge);
    if (lv > 0) k.boost = Math.max(k.boost, MINI[lv - 1]);
    k.drift = 0; k.charge = 0;
    return lv;
  }

  // One step of one kart. inp: {steer -1..1, gas, brake, drift}. Returns the events it caused.
  function stepKart(T, k, inp, dt, ev) {
    var onRoad = true, steerIn = +inp.steer || 0;
    k.hop = Math.max(0, k.hop - dt * 4); k.bonk = Math.max(0, k.bonk - dt); k.inv = Math.max(0, k.inv - dt);
    if (k.spin > 0) { k.spin -= dt; k.spinA += dt * 11; inp = { steer: 0, gas: false, brake: false, drift: false }; steerIn = 0; if (k.drift) endDrift(k), k.boost = 0; k.v += (VMAX * 0.2 - k.v) * Math.min(1, dt * 3); } else k.spinA = 0;
    k.steer += clamp(steerIn - k.steer, -STEER_RATE * dt, STEER_RATE * dt);
    var air = k.air > 0;
    if (inp.drift && !k.drift && !air && k.spin <= 0 && k.v > DRIFT_MIN_V && Math.abs(steerIn) > 0.2) { k.drift = steerIn > 0 ? 1 : -1; k.charge = 0; k.hop = 1; if (ev) ev.push({ type: 'drift', kart: k }); }
    if (k.drift && (!inp.drift || k.v < DRIFT_MIN_V * 0.7 || air)) { var lv = endDrift(k); if (lv && ev) ev.push({ type: 'miniboost', kart: k, level: lv }); }
    // steering
    var rate = turnRate(k.v), sgn = k.v < -0.5 ? -1 : 1, eff;
    if (k.drift) { eff = k.drift * DRIFT_PULL + (1 - DRIFT_PULL) * k.steer; rate *= DRIFT_TURN; k.charge += dt * (0.75 + 0.25 * (k.steer * k.drift)); } else eff = k.steer;
    if (air) eff *= 0.4;
    k.angle += eff * rate * dt * sgn;
    var grip = k.drift ? DRIFT_GRIP : GRIP;
    k.dir += angDiff(k.angle, k.dir) * Math.min(1, grip * dt);
    // speed
    var cap = VMAX * k.speedScale, push = ACCEL;
    if (k.rough && !air) cap *= ROUGH_V;
    if (k.magnet > 0) cap *= MAGNET_CAP;
    if (k.drift) cap *= DRIFT_SPEED;
    if (k.boost > 0) { cap = VMAX * BOOST_CAP; push = BOOST_PUSH; k.boost -= dt; }
    if (inp.gas && k.spin <= 0) { if (k.v < cap) k.v = Math.min(cap, k.v + push * dt); else k.v += (cap - k.v) * Math.min(1, 3 * dt); }
    else if (k.v > 0) k.v = Math.max(0, k.v - (inp.brake ? BRAKE : COAST) * dt);
    if (inp.brake && !(k.spin > 0)) k.v = Math.max(-REVERSE_MAX, k.v - BRAKE * dt * (k.v > 0 ? 1 : 0.4));
    else if (!inp.gas && k.v < 0) k.v = Math.min(0, k.v + COAST * dt);
    if (k.v > cap + 1 && !inp.gas) k.v += (cap - k.v) * Math.min(1, 2 * dt);
    if (k.rough && !air && k.v > cap) k.v = Math.max(cap, k.v - ROUGH_DRAG * dt);
    if (!k.drift && !air) k.v -= k.v * SCRUB * Math.abs(k.steer) * (Math.abs(k.v) / VMAX) * dt;
    // move
    k.x += Math.cos(k.dir) * k.v * dt; k.y += Math.sin(k.dir) * k.v * dt;
    if (k.magnet > 0) k.magnet -= dt;
    // the road under the kart
    var l = locate(T, k.x, k.y, k.idx);
    k.idx = l.i; k.d = l.d;
    var sNew = l.s, ds = angWrap(sNew - k.s, T.L); k.s = sNew; k.total += ds;
    var reach = T.reach, side = Math.abs(l.d);
    k.rough = side > T.halfW;
    if (side > reach) { // the wall
      var u = l.d > 0 ? 1 : -1, c = pointAt(T, l.s, 0), nx = -Math.sin(c.a), ny = Math.cos(c.a), keep = reach - WALL_KEEP;
      k.x = c.x + nx * u * keep; k.y = c.y + ny * u * keep;
      var into = Math.cos(k.dir - c.a), tang = k.v >= 0 ? c.a : c.a + Math.PI, hit = Math.abs(k.v) * Math.abs(Math.sin(angDiff(k.dir, c.a)));
      k.dir += angDiff(tang, k.dir) * 0.55; k.angle += angDiff(tang, k.angle) * 0.55;
      if (hit > 8 || into < -0.3) { k.v *= 0.78; k.bonk = 0.3; if (ev && hit > 14) ev.push({ type: 'bonk', kart: k }); }
      if (k.drift) { endDrift(k); k.boost = 0; }
      k.wall++; k.d = u * keep;
    }
    // jump and gap
    if (T.gap) {
      if (!air && k.s >= T.gap.from - 3 && k.s < T.gap.from + 2 && k.v > JUMP_MIN_V) { k.air = k.airT = clamp(JUMP_REACH / k.v, 0.6, 1.5); if (ev) ev.push({ type: 'jump', kart: k }); }
      else if (!air && k.s >= T.gap.from + 2 && k.s < T.gap.to - 2 && Math.abs(k.d) < T.reach) { k.fell = 1; if (ev) ev.push({ type: 'fall', kart: k }); }
    }
    if (k.air > 0) { k.air -= dt; k.z = AIR_H * 4 * (k.air / k.airT) * (1 - k.air / k.airT) * 1; if (k.air <= 0) { k.air = 0; k.z = 0; if (ev) ev.push({ type: 'land', kart: k }); } }
    else k.z = 0;
    return onRoad;
  }
  function angWrap(d, L) { return d > L / 2 ? d - L : d < -L / 2 ? d + L : d; }

  // ── items ────────────────────────────────────────────────────────────────
  // The weights for the car in `rank` (1 = leading) of n: the leader's table at the front, the last car's at the back.
  function itemWeights(rank, n) {
    var t = n > 1 ? clamp((rank - 1) / (n - 1), 0, 1) : 0, out = {};
    ITEMS.forEach(function (it) { out[it] = DRAW_LEAD[it] + (DRAW_LAST[it] - DRAW_LEAD[it]) * t; });
    return out;
  }
  function drawItem(rank, n, rng) {
    var w = itemWeights(rank, n), tot = 0, r;
    ITEMS.forEach(function (it) { tot += w[it]; });
    r = rng() * tot;
    for (var i = 0; i < ITEMS.length; i++) { r -= w[ITEMS[i]]; if (r < 0) return ITEMS[i]; }
    return ITEMS[0];
  }
  // A hit: a shield eats it; a car that was just hit cannot be hit again at once; otherwise it spins out.
  function hitKart(race, k, kind) {
    if (k.shield > 0) { k.shield = 0; race.events.push({ type: 'blocked', kart: k, by: kind }); return 'blocked'; }
    if (k.inv > 0 || k.spin > 0 || k.air > 0) return 'ignored';
    k.spin = SPIN_S; k.inv = INVULN_S; k.v *= 0.3; k.hits++; if (k.drift) { endDrift(k); k.boost = 0; }
    race.events.push({ type: 'hit', kart: k, by: kind });
    return 'hit';
  }
  function useItem(race, k) {
    var it = k.item, T = race.T;
    if (!it || k.roll > 0) return null;
    k.item = null;
    if (it === 'boost') k.boost = Math.max(k.boost, ITEM_BOOST_S);
    else if (it === 'slick') race.oils.push({ x: k.x - Math.cos(k.dir) * 13, y: k.y - Math.sin(k.dir) * 13, t: OIL_S, owner: k.id });
    else if (it === 'shield') k.shield = SHIELD_S;
    else if (it === 'magnet') k.magnet = MAGNET_S;
    else if (it === 'spark') {
      var ahead = null, best = 1e18;
      race.karts.forEach(function (o) { var gap = o.total - k.total; if (o !== k && o.finished == null && gap > 0 && gap < best) { best = gap; ahead = o; } });
      race.orbs.push({ x: k.x + Math.cos(k.dir) * 9, y: k.y + Math.sin(k.dir) * 9, a: k.dir, owner: k.id, target: ahead ? ahead.id : -1, t: SPARK_S, idx: k.idx });
    }
    race.events.push({ type: 'use', kart: k, item: it });
    return it;
  }
  function stepOrb(race, o, dt) {
    var T = race.T, tgt = o.target >= 0 ? race.karts[o.target] : null, want;
    if (tgt) want = Math.atan2(tgt.y - o.y, tgt.x - o.x);
    else { var l = locate(T, o.x, o.y, o.idx), p = pointAt(T, l.s + 50, 0); o.idx = l.i; want = Math.atan2(p.y - o.y, p.x - o.x); }
    o.a += clamp(angDiff(want, o.a), -SPARK_TURN * dt, SPARK_TURN * dt);
    o.x += Math.cos(o.a) * SPARK_V * dt; o.y += Math.sin(o.a) * SPARK_V * dt; o.t -= dt;
    for (var i = 0; i < race.karts.length; i++) {
      var k = race.karts[i];
      if (k.id === o.owner && o.t > SPARK_S - 0.4) continue;
      if (Math.hypot(k.x - o.x, k.y - o.y) < SPARK_R && k.air <= 0) { hitKart(race, k, 'spark'); o.t = 0; return; }
    }
  }

  // ── the computer drivers ─────────────────────────────────────────────────
  // What a driver would press this step, from the road ahead, the item boxes and slicks near, and its own habits.
  function aiInput(race, k) {
    var T = race.T, p = k.driver, rng = race.rng, N = T.N, look = Math.round((26 + k.v * 0.62) / T.ds), j = (k.idx + look) % N;
    var off = T.line[j] * 1 + p.lane * T.halfW * 0.55;
    // the road ahead may have a slick or a slower kart on it: ask for a different lane
    var want = off, ahead = 52;
    race.oils.forEach(function (o) {
      var dx = o.x - k.x, dy = o.y - k.y, along = dx * Math.cos(k.dir) + dy * Math.sin(k.dir);
      if (along > 0 && along < ahead) { var side = -dx * Math.sin(k.dir) + dy * Math.cos(k.dir); if (Math.abs(side) < OIL_R + 7) want = k.d + (side > 0 ? -1 : 1) * (OIL_R + 12); }
    });
    race.karts.forEach(function (o) {
      if (o === k) return;
      var dx = o.x - k.x, dy = o.y - k.y, along = dx * Math.cos(k.dir) + dy * Math.sin(k.dir);
      if (along > 0 && along < 20) { var side = -dx * Math.sin(k.dir) + dy * Math.cos(k.dir); if (Math.abs(side) < 11) want = k.d + (side > 0 ? -1 : 1) * 14; }
    });
    if (!k.item && k.roll <= 0) { // a nearby box is worth a small detour
      for (var b = 0; b < T.boxes.length; b++) {
        var bx = T.boxes[b], bt = race.boxT[b];
        if (bt > 0) continue;
        var gap = angWrap(bx.s - k.s, T.L);
        if (gap > 10 && gap < 90) { var l = locate(T, bx.x, bx.y, bx.i); want = clamp(l.d, -T.halfW + 8, T.halfW - 8); break; }
      }
    }
    if (inJump(T, k.s, 90)) want = 0;
    want = clamp(want, -T.halfW + 7, T.halfW - 7);
    var q = pointAt(T, T.ds * j, want), target = Math.atan2(q.y - k.y, q.x - k.x);
    var err = angDiff(target, k.angle), steer = clamp(err * 2.4, -1, 1);
    if (rng() < p.wobble * 0.02) k.mood = 0.6 * (rng() < 0.5 ? -1 : 1);
    k.mood *= 0.97; steer = clamp(steer + k.mood, -1, 1);
    // speed
    var tv = T.cornerV[j] * p.skill * k.speedScale * (k.finished != null ? 0.8 : 1), ahead2 = T.cornerV[(k.idx + Math.round(40 / T.ds)) % N];
    tv = Math.min(tv, ahead2 * 1.08);
    if (k.boost > 0.15 && ahead2 > 48) tv = Math.max(tv, VMAX * BOOST_CAP * 0.95); // a driver rides its boost down a straight
    var inp = { steer: steer, gas: k.v < tv, brake: k.v > tv * 1.12, drift: false };
    // drifting a corner: start where the bend is and the driver likes it, hold it while it turns, let go on the straight
    var bend = 0, m;
    for (m = 4; m <= 20; m += 4) bend += T.curv[(k.idx + m) % N] * T.ds * 4;
    if (k.drift) {
      var ours = k.drift > 0 ? bend : -bend;
      inp.drift = ours > 0.5 && Math.abs(k.d) < T.halfW * 0.8;
      inp.steer = clamp((steer - DRIFT_PULL * k.drift) / (1 - DRIFT_PULL), -1, 1); // a drift already turns: ask only for the rest
    } else if (p.drift > 0 && Math.abs(bend) > 1.2 && T.cornerV[(k.idx + 10) % N] > 52 && k.v > DRIFT_MIN_V * 1.2 && Math.abs(k.d) < T.halfW * 0.5 && k.air <= 0 && rng() < p.drift * 0.15) {
      inp.drift = true; inp.steer = bend > 0 ? Math.max(0.5, steer) : Math.min(-0.5, steer);
    }
    // the rubber band: gentle, and only when a person is racing
    if (race.humansIn) {
      var hum = race.leadHuman(), gapH = hum ? hum.total - k.total : 0;
      var rb = clamp(gapH / RB_RANGE, -1, 1);
      k.speedScale = race.diff * (1 + (rb > 0 ? rb * RB_BEHIND : rb * RB_AHEAD));
    } else k.speedScale = race.diff;
    return inp;
  }
  // Whether a computer driver uses what it holds now.
  function aiUsesItem(race, k, rank) {
    var it = k.item, T = race.T, mode = k.driver.items;
    if (!it || k.roll > 0) return false;
    if (k.itemDelay > 0) return false;
    var straight = T.cornerV[(k.idx + 12) % T.N] > VMAX * 0.95, behindMe = 0, front = null, fgap = 1e9;
    race.karts.forEach(function (o) {
      if (o === k) return;
      var g = o.total - k.total;
      if (g > 0 && g < fgap) { fgap = g; front = o; }
      if (g < 0 && g > -90) behindMe++;
    });
    if (it === 'boost') return straight || mode === 'eager';
    if (it === 'slick') return behindMe > 0 || (mode === 'aggressive' && k.itemDelay <= 0);
    if (it === 'spark') return !!front && fgap < (mode === 'tactical' ? 160 : 400);
    if (it === 'shield') return mode === 'defensive' || mode === 'eager' || race.oils.length > 0 || rank > 1;
    if (it === 'magnet') return rank > 1;
    return true;
  }

  // ── the race ─────────────────────────────────────────────────────────────
  // opts: { driver: index (person 1), driver2, humans: 0..2, diff: 'easy'|'normal'|'hard', laps, seed, grid: driver order front to back,
  //         trial: alone with a ghost }
  function createRace(T, opts) {
    if (!T.N) T = buildTrack(T);
    var o = opts || {}, rng = mulberry(o.seed == null ? 1 : o.seed), humans = o.humans == null ? 1 : o.humans, laps = o.laps || 3;
    var chosen = [o.driver == null ? 0 : o.driver, o.driver2 == null ? 1 : o.driver2];
    if (humans > 1 && chosen[1] === chosen[0]) chosen[1] = (chosen[0] + 1) % DRIVERS.length;
    var order = o.grid ? o.grid.slice() : DRIVERS.map(function (_, i) { return i; });
    if (!o.grid) order = shuffle(order, rng);
    if (o.trial) order = [chosen[0]];
    // people take their grid places by the order given; the rest are computer drivers
    var karts = order.map(function (di, pos) {
      var hi = chosen.slice(0, humans).indexOf(di), k = newKart(pos, DRIVERS[di], hi >= 0 ? hi : -1);
      k.drvIndex = di; k.grid = pos;
      var row = Math.floor(pos / 2), col = pos % 2;
      placeKart(T, k, T.L - 10 - row * 15 - col * 6, (col ? 1 : -1) * T.halfW * 0.42);
      k.lastCp = 0; k.lapBase = 0; k.speedScale = DIFFICULTY[o.diff || 'normal'] || 0.95;
      return k;
    });
    var race = { T: T, karts: karts, rng: rng, laps: laps, t: 0, count: o.trial ? 2 : COUNT_S, go: false, oils: [], orbs: [], boxT: T.boxes.map(function () { return 0; }), events: [], humansIn: humans > 0 && !o.trial,
      diff: DIFFICULTY[o.diff || 'normal'] || 0.95, over: false, doneAt: null, order: null, trial: !!o.trial, humans: humans };
    race.leadHuman = function () { var best = null; karts.forEach(function (k) { if (k.human >= 0 && (!best || k.total > best.total)) best = k; }); return best; };
    race.ranked = function () { return rankKarts(race); };
    return race;
  }
  function shuffle(a, rng) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function rankKarts(race) {
    return race.karts.slice().sort(function (a, b) {
      if (a.finished != null && b.finished != null) return a.finished - b.finished;
      if (a.finished != null) return -1;
      if (b.finished != null) return 1;
      return b.total - a.total || a.grid - b.grid;
    });
  }

  // inputs: an array of per-person {steer, gas, brake, drift, item}. Returns the events since the last call.
  function step(race, inputs, dt) {
    var T = race.T, ev = race.events = [], i, k;
    race.t += dt;
    if (race.count > 0) {
      race.count -= dt;
      if (race.count <= 0) { race.go = true; ev.push({ type: 'go' }); }
      else { race.karts.forEach(function (c) { c.itemDelay = 1 + race.rng() * 2; }); return ev; }
    }
    var clock = race.t - COUNT_S + (race.trial ? COUNT_S - 2 : 0);
    var ranked = rankKarts(race);
    ranked.forEach(function (c, r) { c.place = r + 1; });
    for (i = 0; i < race.karts.length; i++) {
      k = race.karts[i];
      var inp, person = k.human >= 0 && k.finished == null;
      inp = person ? (inputs[k.human] || {}) : aiInput(race, k);
      stepKart(T, k, inp, dt, ev);
      if (k.fell) { respawn(T, k); k.fell = 0; k.inv = INVULN_S; }
      // surfaces: pads, oil
      for (var q = 0; q < T.pads.length; q++) { var pd = T.pads[q]; if (Math.abs(angWrap(k.s - pd.s, T.L)) < pd.len / 2 && Math.abs(k.d) < T.halfW && k.air <= 0 && k.boost < PAD_BOOST_S * 0.7) { k.boost = PAD_BOOST_S; ev.push({ type: 'pad', kart: k }); } }
      for (q = race.oils.length - 1; q >= 0; q--) {
        var oil = race.oils[q];
        if (k.air <= 0 && Math.hypot(k.x - oil.x, k.y - oil.y) < OIL_R && !(oil.owner === k.id && oil.t > OIL_S - 1.2)) { if (hitKart(race, k, 'slick') !== 'ignored') race.oils.splice(q, 1); }
      }
      // boxes
      if (k.roll > 0) { k.roll -= dt; if (k.roll <= 0) { k.roll = 0; k.item = k.pending; k.itemDelay = 0.4 + race.rng() * (k.driver.items === 'eager' ? 0.8 : 2.4); } }
      else if (!k.item) {
        for (q = 0; q < T.boxes.length; q++) {
          if (race.boxT[q] <= 0 && k.air <= 0 && Math.hypot(k.x - T.boxes[q].x, k.y - T.boxes[q].y) < BOX_R) {
            race.boxT[q] = BOX_AGAIN_S; k.pending = drawItem(k.place, race.karts.length, race.rng); k.roll = ROLL_S; ev.push({ type: 'box', kart: k }); break;
          }
        }
      }
      if (k.itemDelay > 0) k.itemDelay -= dt;
      var want = person ? !!inp.item : aiUsesItem(race, k, k.place);
      if (want && (person ? !k.itemWas : true)) useItem(race, k);
      k.itemWas = want;
      // laps and checkpoints, in order
      var nextAt = k.lapBase + k.cp * T.L / NCP;
      if (k.total >= nextAt && k.finished == null) {
        if (k.cp < NCP) { k.lastCp = k.lapBase + k.cp * T.L / NCP; k.lastCp = k.lastCp % T.L; k.cp++; }
        else {
          k.lap++; k.laps.push(clock - k.lapStart); k.lapStart = clock; k.lapBase += T.L; k.cp = 1; k.lastCp = 0;
          ev.push({ type: 'lap', kart: k, lap: k.lap });
          if (k.lap >= race.laps) { k.finished = clock; ev.push({ type: 'finish', kart: k }); }
        }
      }
      if (k.finished == null && k.v > 8 && Math.cos(k.dir - T.th[k.idx]) < -0.3) k.wrong += dt; else k.wrong = Math.max(0, k.wrong - dt);
    }
    // karts against karts
    for (i = 0; i < race.karts.length; i++) for (var m = i + 1; m < race.karts.length; m++) {
      var a = race.karts[i], b = race.karts[m];
      if (a.air > 0 || b.air > 0) continue;
      var dx = b.x - a.x, dy = b.y - a.y, dd = Math.hypot(dx, dy), need = KART_R * 2;
      if (dd < need && dd > 0.01) {
        var push = (need - dd) / 2, nx = dx / dd, ny = dy / dd;
        a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
        var rel = (b.v * Math.cos(b.dir) - a.v * Math.cos(a.dir)) * nx + (b.v * Math.sin(b.dir) - a.v * Math.sin(a.dir)) * ny;
        if (rel < 0) { a.v *= 0.985; b.v *= 0.985; }
      }
    }
    // things on the road
    race.oils = race.oils.filter(function (oil) { oil.t -= dt; return oil.t > 0; });
    race.orbs.forEach(function (orb) { stepOrb(race, orb, dt); });
    race.orbs = race.orbs.filter(function (orb) { return orb.t > 0; });
    for (i = 0; i < race.boxT.length; i++) if (race.boxT[i] > 0) race.boxT[i] -= dt;
    race.karts.forEach(function (c) { if (c.shield > 0) c.shield -= dt; });
    // the end: when every person is across the line, and the rest have had their chance
    var people = race.karts.filter(function (c) { return c.human >= 0; });
    var everyone = race.karts.every(function (c) { return c.finished != null; });
    if (!race.over && (people.length ? people.every(function (c) { return c.finished != null; }) : everyone)) {
      if (race.doneAt == null) race.doneAt = clock;
      if (everyone || clock - race.doneAt > FINISH_WAIT_S || race.trial) race.over = true;
    }
    if (race.over && !race.order) race.order = rankKarts(race);
    return ev;
  }
  function clockOf(race) { return Math.max(0, race.t - COUNT_S + (race.trial ? COUNT_S - 2 : 0)); }

  // Cup points: the order home (kart ids, first to last) adds to a table of totals by driver index.
  function addPoints(totals, order) {
    var out = totals.slice();
    order.forEach(function (di, i) { out[di] = (out[di] || 0) + (GP_POINTS[i] || 0); });
    return out;
  }
  function cupOrder(totals) { return totals.map(function (p, i) { return i; }).sort(function (a, b) { return totals[b] - totals[a] || a - b; }); }

  // ── ghosts: a flat list of x, y, angle at 10 Hz, kept small ──────────────
  function ghostNew() { return { dt: GHOST_DT, d: [], n: 0 }; }
  function ghostPush(rec, t, k) {
    while (rec.n * rec.dt <= t) { rec.d.push(Math.round(k.x * 8), Math.round(k.y * 8), Math.round(k.angle * 1000)); rec.n++; }
  }
  function ghostAt(rec, t) {
    if (!rec || rec.n < 2) return null;
    var f = t / rec.dt, i = Math.floor(f);
    if (i < 0 || i >= rec.n - 1) return null;
    var u = f - i, a = i * 3, b = a + 3, d = rec.d;
    return { x: (d[a] + (d[b] - d[a]) * u) / 8, y: (d[a + 1] + (d[b + 1] - d[a + 1]) * u) / 8, a: (d[a + 2] + angDiff(d[b + 2], d[a + 2]) * u) / 1000 };
  }

  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function fmtTime(sec) {
    if (sec == null) return '-';
    var ms = Math.round(sec * 1000), m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, t = Math.floor((ms % 1000) / 100);
    return m + ':' + (s < 10 ? '0' : '') + s + '.' + t;
  }

  root.KartEngine = {
    TRACKS: TRACKS, CUPS: CUPS, DRIVERS: DRIVERS, ITEMS: ITEMS, GP_POINTS: GP_POINTS, DIFFICULTY: DIFFICULTY, CHARGE: CHARGE, MINI: MINI,
    STEP: STEP, WORLD: WORLD, VMAX: VMAX, SHOULDER: SHOULDER, WALL_W: WALL_W, KART_R: KART_R, OIL_R: OIL_R, BOX_R: BOX_R, NCP: NCP, COUNT_S: COUNT_S, SHIELD_S: SHIELD_S, MAGNET_S: MAGNET_S, SPIN_S: SPIN_S, DRIFT_MIN_V: DRIFT_MIN_V, GHOST_DT: GHOST_DT, BOX_AGAIN_S: BOX_AGAIN_S,
    track: track, buildTrack: buildTrack, pointAt: pointAt, locate: locate, makeCamera: makeCamera, project: project, groundAt: groundAt,
    driftLevel: driftLevel, turnRate: turnRate, newKart: newKart, placeKart: placeKart, respawn: respawn, stepKart: stepKart, endDrift: endDrift,
    itemWeights: itemWeights, drawItem: drawItem, hitKart: hitKart, useItem: useItem, aiInput: aiInput, createRace: createRace, step: step, rankKarts: rankKarts, clockOf: clockOf,
    addPoints: addPoints, cupOrder: cupOrder, ghostNew: ghostNew, ghostPush: ghostPush, ghostAt: ghostAt, ordinal: ordinal, fmtTime: fmtTime,
    clamp: clamp, angDiff: angDiff, mulberry: mulberry, angWrap: angWrap
  };
})(this);
