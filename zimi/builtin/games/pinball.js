/* ZimiGames: Pinball. Our own code, GPL-3.0. No network, no fonts, no modules.
   One table of our own: a plunger lane, an arc over the top, three pop bumpers, two slingshots, two banks of
   targets that start multiball, three rollover lanes that raise the multiplier, two flippers.
   The physics (pure functions, no DOM, so node can test them) and the page (only when there is a document).
   Units are table pixels (360 x 640) and seconds, y down. */
(function (root) {
  'use strict';

  // ── the table ────────────────────────────────────────────────────────────
  var W = 360, H = 640, BALL_R = 7;
  var GRAVITY = 900;               // px/s^2 along the table, a gentle tilt that still feels lively
  var SUBSTEPS = 4;                // physics steps per frame; at the speed cap a ball moves 5 px, less than its radius
  var MAX_SPEED = 1400;
  var CONTACT_LOSS = 0.9995;       // each touch of a wall costs a hair of speed
  var AIR = 0.05;                  // fraction of speed lost per second
  var REST_SPEED = 40;             // an impact slower than this does not bounce, so a ball can roll
  var FLIP_LEN = 60, FLIP_R = 5, FLIP_REST = 26 * Math.PI / 180, FLIP_UP = -32 * Math.PI / 180;
  var FLIP_SWING = 19, FLIP_DROP = 11; // rad/s up, rad/s back down
  var BUMPER_R = 20, BUMPER_KICK = 400, SLING_KICK = 170;
  var LANE_X = 332, LANE_FLOOR = 618, START_Y = LANE_FLOOR - BALL_R;
  var PLUNGE_MIN = 520, PLUNGE_MAX = 1330, CHARGE_S = 0.85;
  var SAVER_S = 7, STUCK_S = 2.5, START_LIVES = 3, MAX_MULT = 5;
  var POINTS = { bumper: 100, sling: 10, target: 250, lane: 500, bank: 2000, laneSet: 3000 };

  function seg(ax, ay, bx, by, e, kind, idx) { return { ax: ax, ay: ay, bx: bx, by: by, e: e, kind: kind || 'wall', idx: idx }; }

  function buildWalls() {
    var w = [], i, a0, a1, N = 30, cx = 180, cy = 180, rr = 166;
    for (i = 0; i < N; i++) { // the arc over the top, left end to right end
      a0 = Math.PI + Math.PI * i / N; a1 = Math.PI + Math.PI * (i + 1) / N;
      w.push(seg(cx + rr * Math.cos(a0), cy + rr * Math.sin(a0), cx + rr * Math.cos(a1), cy + rr * Math.sin(a1), 0.3));
    }
    w.push(seg(14, 180, 14, 500, 0.4));          // left wall
    w.push(seg(346, 180, 346, LANE_FLOOR, 0.3)); // right wall
    w.push(seg(318, 190, 318, LANE_FLOOR, 0.3)); // lane separator
    w.push(seg(318, LANE_FLOOR, 346, LANE_FLOOR, 0.1));
    w.push(seg(14, 500, 92, 568, 0.3));          // inlane guides
    w.push(seg(318, 500, 240, 568, 0.3));
    // slingshots: a kicking face and the two sides behind it
    w.push(seg(48, 440, 84, 505, 0.6, 'sling', 0), seg(48, 440, 48, 505, 0.4), seg(48, 505, 84, 505, 0.4));
    w.push(seg(284, 440, 248, 505, 0.6, 'sling', 1), seg(284, 440, 284, 505, 0.4), seg(284, 505, 248, 505, 0.4));
    // targets: three on each side wall, small angled plates facing the table
    for (i = 0; i < 3; i++) w.push(seg(15, 296 + i * 32, 33, 304 + i * 32, 0.4, 'target', i));
    for (i = 0; i < 3; i++) w.push(seg(317, 296 + i * 32, 299, 304 + i * 32, 0.4, 'target', 3 + i));
    // the gate at the top of the plunger lane: lets a ball up, never back down
    var g = seg(346, 170, 319, 190, 0.2, 'gate'); g.nx = -20 / 33.6; g.ny = -27 / 33.6;
    w.push(g);
    return w;
  }
  var WALLS = buildWalls();
  var BUMPERS = [{ x: 118, y: 250 }, { x: 214, y: 250 }, { x: 166, y: 320 }];
  var LANES = [{ x: 124, y: 76 }, { x: 166, y: 76 }, { x: 208, y: 76 }], LANE_R = 13;
  var PIVOTS = [{ x: 98, y: 574, side: 1 }, { x: 234, y: 574, side: -1 }];

  function createState() {
    var st = {
      balls: [], score: 0, mult: 1, lives: START_LIVES, status: 'ready', charge: 0, charging: false, saver: 0, time: 0,
      lanes: [0, 0, 0], laneIn: [0, 0, 0], targets: [0, 0, 0, 0, 0, 0], flash: [0, 0, 0], events: [], launched: false, message: '',
      flippers: PIVOTS.map(function (p) { return { px: p.x, py: p.y, side: p.side, angle: FLIP_REST, w: 0, on: false }; })
    };
    st.balls.push(newBall());
    return st;
  }
  function newBall() { return { x: LANE_X, y: START_Y, vx: 0, vy: 0, slow: 0 }; }
  function inLane(b) { return b.x > 320 && b.y > 160; }

  // ── collisions ───────────────────────────────────────────────────────────
  // Push the ball out of a capsule (a segment with a radius). Returns the contact or null.
  function contact(b, ax, ay, bx, by, rad) {
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    var t = l2 ? ((b.x - ax) * dx + (b.y - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    var cx = ax + t * dx, cy = ay + t * dy, nx = b.x - cx, ny = b.y - cy, r = BALL_R + (rad || 0), d2 = nx * nx + ny * ny;
    if (d2 >= r * r) return null;
    var d = Math.sqrt(d2);
    if (d < 1e-6) { nx = -dy; ny = dx; d = Math.sqrt(nx * nx + ny * ny) || 1; }
    nx /= d; ny /= d;
    b.x = cx + nx * r; b.y = cy + ny * r;
    return { nx: nx, ny: ny, t: t };
  }
  // Reflect the ball's velocity, relative to a surface moving at (sx, sy). Returns the speed it hit at.
  function bounce(b, nx, ny, e, sx, sy) {
    var rvx = b.vx - sx, rvy = b.vy - sy, vn = rvx * nx + rvy * ny;
    if (vn >= 0) return 0;
    var k = -vn < REST_SPEED ? 1 : 1 + e; // slow contacts are inelastic, so a ball can roll
    b.vx -= k * vn * nx; b.vy -= k * vn * ny;
    return -vn;
  }

  function event(st, name, data) { st.events.push({ name: name, data: data }); }

  function hitWall(st, b, w) {
    var c, hit;
    if (w.kind === 'gate') {
      // one way: only a ball on the table side, heading down, meets it
      var side = (b.x - w.ax) * w.nx + (b.y - w.ay) * w.ny;
      if (side < 0 || b.vx * w.nx + b.vy * w.ny >= 0) return;
    }
    c = contact(b, w.ax, w.ay, w.bx, w.by, 0);
    if (!c) return;
    if (w.kind === 'gate') { // keep the table-side normal
      c.nx = w.nx; c.ny = w.ny;
    }
    hit = bounce(b, c.nx, c.ny, w.e, 0, 0);
    if (!hit) return;
    b.vx *= CONTACT_LOSS; b.vy *= CONTACT_LOSS;
    if (w.kind === 'sling' && hit > 60) {
      b.vx += c.nx * SLING_KICK; b.vy += c.ny * SLING_KICK;
      st.score += POINTS.sling * st.mult; event(st, 'sling', w.idx);
    } else if (w.kind === 'target' && hit > 80 && !st.targets[w.idx]) {
      st.targets[w.idx] = 1; st.score += POINTS.target * st.mult; event(st, 'target', w.idx);
      var bank = w.idx < 3 ? [0, 1, 2] : [3, 4, 5];
      if (bank.every(function (i) { return st.targets[i]; })) {
        bank.forEach(function (i) { st.targets[i] = 0; });
        st.score += POINTS.bank * st.mult; event(st, 'multiball');
        for (var k = 0; k < 2 && st.balls.length < 4; k++) {
          st.balls.push({ x: 150 + k * 32, y: 120, vx: (k ? 1 : -1) * 90, vy: 120, slow: 0 });
        }
      }
    }
  }

  function hitBumper(st, b, i) {
    var p = BUMPERS[i], dx = b.x - p.x, dy = b.y - p.y, r = BALL_R + BUMPER_R, d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return;
    var d = Math.sqrt(d2) || 1, nx = dx / d, ny = dy / d;
    b.x = p.x + nx * r; b.y = p.y + ny * r;
    bounce(b, nx, ny, 0.5, 0, 0);
    var out = b.vx * nx + b.vy * ny;
    if (out < BUMPER_KICK) { b.vx += (BUMPER_KICK - out) * nx; b.vy += (BUMPER_KICK - out) * ny; }
    st.score += POINTS.bumper * st.mult; st.flash[i] = 0.14; event(st, 'bumper', i);
  }

  function hitFlipper(b, f) {
    var len = FLIP_LEN, dx = f.side * Math.cos(f.angle), dy = Math.sin(f.angle);
    var c = contact(b, f.px, f.py, f.px + dx * len, f.py + dy * len, FLIP_R);
    if (!c) return;
    // the surface moves with the flipper: speed grows along its length
    var s = f.w * c.t * len;
    bounce(b, c.nx, c.ny, 0.35, -f.side * Math.sin(f.angle) * s, Math.cos(f.angle) * s);
  }

  function moveFlipper(f, h) {
    var target = f.on ? FLIP_UP : FLIP_REST, rate = f.on ? FLIP_SWING : FLIP_DROP, a = f.angle, step = rate * h;
    var next = a < target ? Math.min(target, a + step) : Math.max(target, a - step);
    f.w = (next - a) / h; f.angle = next;
  }

  function substep(st, h) {
    st.flippers.forEach(function (f) { moveFlipper(f, h); });
    var i, j, b;
    for (i = 0; i < st.balls.length; i++) {
      b = st.balls[i];
      b.vy += GRAVITY * h;
      var air = 1 - AIR * h; b.vx *= air; b.vy *= air;
      var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (sp > MAX_SPEED) { b.vx *= MAX_SPEED / sp; b.vy *= MAX_SPEED / sp; }
      b.x += b.vx * h; b.y += b.vy * h;
      for (j = 0; j < WALLS.length; j++) hitWall(st, b, WALLS[j]);
      for (j = 0; j < BUMPERS.length; j++) hitBumper(st, b, j);
      for (j = 0; j < st.flippers.length; j++) hitFlipper(b, st.flippers[j]);
    }
    for (j = 0; j < LANES.length; j++) { // a lane lights once per visit, when a ball rolls in
      var inside = st.balls.some(function (q) { var dx = q.x - LANES[j].x, dy = q.y - LANES[j].y; return dx * dx + dy * dy < LANE_R * LANE_R; });
      if (inside && !st.laneIn[j] && !st.lanes[j]) {
        st.lanes[j] = 1; st.score += POINTS.lane * st.mult; event(st, 'lane', j);
        if (st.lanes.every(Boolean)) {
          st.lanes = [0, 0, 0]; st.mult = Math.min(MAX_MULT, st.mult + 1); st.score += POINTS.laneSet * st.mult; event(st, 'laneset', st.mult);
        }
      }
      st.laneIn[j] = inside;
    }
  }

  function launch(st) {
    var b = st.balls[0];
    if (st.status !== 'ready' || !b || st.charge < 0.04) { st.charge = 0; st.charging = false; return false; }
    b.vy = -(PLUNGE_MIN + (PLUNGE_MAX - PLUNGE_MIN) * st.charge);
    st.charge = 0; st.charging = false; st.status = 'play'; st.saver = SAVER_S; st.launched = true;
    event(st, 'launch');
    return true;
  }

  // Advance by dt seconds (one frame). Handles drains, the ball saver and the end of the game.
  function step(st, dt) {
    if (st.status === 'over') return;
    st.time += dt;
    if (st.charging) st.charge = Math.min(1, st.charge + dt / CHARGE_S);
    var h = dt / SUBSTEPS, k, i;
    for (k = 0; k < SUBSTEPS; k++) substep(st, h);
    for (i = 0; i < st.flash.length; i++) if (st.flash[i] > 0) st.flash[i] = Math.max(0, st.flash[i] - dt);
    if (st.status === 'play' && st.saver > 0) st.saver = Math.max(0, st.saver - dt);
    var b, alive = [];
    for (i = 0; i < st.balls.length; i++) {
      b = st.balls[i];
      if (b.y > H + 20) { event(st, 'drain'); continue; }
      var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      b.slow = sp < 14 && !inLane(b) ? b.slow + dt : 0;
      if (b.slow > STUCK_S) { b.vx += (b.x < 166 ? 1 : -1) * 140; b.vy -= 260; b.slow = 0; event(st, 'nudge'); }
      alive.push(b);
    }
    st.balls = alive;
    // a weak shot that falls back into the lane can be shot again
    if (st.status === 'play' && st.balls.length === 1 && inLane(st.balls[0]) && st.balls[0].y > LANE_FLOOR - 14 && Math.abs(st.balls[0].vy) < 30) st.status = 'ready';
    if (!st.balls.length) {
      if (st.status === 'play' && st.saver > 0) { st.balls.push(newBall()); st.status = 'ready'; st.saver = 0; event(st, 'saved'); }
      else {
        st.lives--;
        if (st.lives <= 0) { st.status = 'over'; event(st, 'over'); }
        else { st.balls.push(newBall()); st.status = 'ready'; st.saver = 0; event(st, 'next'); }
      }
    }
  }

  var Engine = {
    W: W, H: H, BALL_R: BALL_R, GRAVITY: GRAVITY, SUBSTEPS: SUBSTEPS, WALLS: WALLS, BUMPERS: BUMPERS, LANES: LANES, LANE_R: LANE_R, BUMPER_R: BUMPER_R, BUMPER_KICK: BUMPER_KICK,
    FLIP_LEN: FLIP_LEN, FLIP_R: FLIP_R, FLIP_REST: FLIP_REST, FLIP_UP: FLIP_UP, MAX_SPEED: MAX_SPEED, LANE_FLOOR: LANE_FLOOR, MAX_MULT: MAX_MULT, POINTS: POINTS,
    createState: createState, newBall: newBall, contact: contact, bounce: bounce, step: step, launch: launch, inLane: inLane
  };
  root.PinballEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var BEST_KEY = 'zimi.games.pinball.best', CHROME_PX = 200, MSG_S = 1.6;
  // What a hit feels like: a ring spreads off the bumper, the score rises from where it was made, a sling or target blinks, and (when
  // Sound is on, or the phone can buzz) a note and a tick. Lives are in ms of wall time; reduced motion keeps only the notes and the lamps.
  var RING_MS = 380, POP_MS = 760, POP_LIFT = BUMPER_R + 8, POP_RISE = 22, BLINK_MS = 160, HAPTIC = { bumper: 14, sling: 8, target: 10, lane: 8, multiball: [30, 40, 30], drain: [40, 40, 60] };
  var NOTE_HZ = { bumper: [523, 587, 659], sling: [330], target: [698], lane: [784], drain: [130] }, NOTE_MS = { bumper: 90, sling: 70, target: 100, lane: 120, drain: 320 };
  var SLING_MID = [{ x: 66, y: 472 }, { x: 266, y: 472 }], MULT_BUMP = 1.3, MULT_BUMP_MS = 260;
  Play.applyTheme();

  var els = { cv: $('pb-board'), score: $('pb-score'), best: $('pb-best'), balls: $('pb-balls'), mult: $('pb-mult'), msg: $('pb-msg'), pause: $('pb-pause'), newBtn: $('pb-new') };
  var st = createState(), ctx, reduce = Play.reducedMotion(), banner = '', bannerT = 0, fx = [];
  var keys = { left: false, right: false }, touches = {};

  var page = Play.arcadePage({
    sound: true, els: els, bestKey: BEST_KEY, ready: { touch: 'pinball.readyTouch', keys: 'pinball.readyKeys' }, state: function () { return st; }, draw: draw, hud: hud,
    layout: function () { ctx = Play.fitCanvas(els.cv, W, H, CHROME_PX, W * 1.15).ctx; draw(); },
    newRun: function () { st = createState(); banner = ''; bannerT = 0; fx = []; return T('pinball.launch'); },
    release: function () { keys.left = keys.right = false; touches = {}; st.charging = false; st.charge = 0; },
    snapshot: function () { return Play.plain(st); },
    restore: function (saved) { st = Play.overlay(createState(), saved); st.events = []; }
  });
  var status = page.status;

  function say(text) { banner = text; bannerT = MSG_S; status.say(text); }
  function hud() {
    els.score.textContent = Play.num(st.score); els.best.textContent = Play.num(Math.max(page.best.score, st.score));
    els.balls.textContent = Play.num(Math.max(0, st.lives)); els.mult.textContent = T('pinball.mult', { n: st.mult });
  }

  function flippers() {
    var l = keys.left, r = keys.right;
    Object.keys(touches).forEach(function (id) { if (touches[id] === 'l') l = true; else if (touches[id] === 'r') r = true; });
    st.flippers[0].on = l; st.flippers[1].on = r;
  }

  // Where on the table an event happened, for its ring and its figure.
  function spotOf(e) {
    if (e.name === 'bumper') return BUMPERS[e.data];
    if (e.name === 'sling') return SLING_MID[e.data];
    if (e.name === 'lane') return LANES[e.data];
    if (e.name === 'target') { var w = WALLS.filter(function (q) { return q.kind === 'target' && q.idx === e.data; })[0]; return { x: (w.ax + w.bx) / 2, y: (w.ay + w.by) / 2 }; }
    return null;
  }
  function felt(e) {
    var spot = spotOf(e), pts = POINTS[e.name];
    if (!spot) return;
    if (!reduce) { var now = performance.now(); fx.push({ k: 'ring', x: spot.x, y: spot.y, t: now, e: e.name }); if (pts >= 100) fx.push({ k: 'pop', x: spot.x, y: spot.y, t: now, text: '+' + Play.num(pts * st.mult) }); }
    if (HAPTIC[e.name]) Play.haptic(HAPTIC[e.name]);
    var hz = NOTE_HZ[e.name]; if (hz) Play.tone(hz[(e.data || 0) % hz.length], NOTE_MS[e.name]);
  }
  function handleEvents() {
    st.events.forEach(function (e) {
      if (e.name === 'bumper' || e.name === 'sling' || e.name === 'target' || e.name === 'lane') felt(e);
      else if (e.name === 'launch') status.say('');
      else if (e.name === 'multiball') { say(T('pinball.multiball')); Play.haptic(HAPTIC.multiball); if (!reduce) ZimiShell.shake(els.cv); [660, 784, 988].forEach(function (hz, i) { Play.later(function () { Play.tone(hz, NOTE_MS.lane); }, i * 90); }); }
      else if (e.name === 'laneset') { say(T('pinball.multiplier', { n: e.data })); if (!reduce && els.mult.animate) els.mult.animate([{ scale: 1 }, { scale: MULT_BUMP }, { scale: 1 }], { duration: MULT_BUMP_MS, easing: 'ease-out' }); }
      else if (e.name === 'drain') { Play.haptic(HAPTIC.drain); Play.tone(NOTE_HZ.drain[0], NOTE_MS.drain); }
      else if (e.name === 'saved') say(T('pinball.saved'));
      else if (e.name === 'next') say(T(st.lives === 1 ? 'pinball.lastBall' : 'pinball.nextBall'));
      else if (e.name === 'over') page.finish();
    });
    st.events.length = 0;
  }

  page.run(function (dt) { flippers(); step(st, dt); handleEvents(); if (bannerT > 0) { bannerT -= dt; if (bannerT <= 0) status.say(''); } });

  function pal() { return { felt: '#0e0e10', felt2: '#18181c', wall: '#a8a69e', amber: '#f2a516', amberDim: '#6b4a10', ink: '#e8e8ed', bump: '#e8576b', bump2: '#ffd0d6', cyan: '#3fc1e8', dim: '#3a3a40' }; }

  function draw() {
    if (!ctx) return;
    var c = pal(), i;
    var bg = ctx.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, c.felt2); bg.addColorStop(1, c.felt);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    // lane floor of the plunger
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(320, 190, 26, 430);
    // walls
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    WALLS.forEach(function (w) {
      if (w.kind === 'target') return;
      ctx.strokeStyle = w.kind === 'sling' ? c.amber : w.kind === 'gate' ? c.dim : c.wall;
      ctx.lineWidth = w.kind === 'sling' ? 5 : 4;
      ctx.beginPath(); ctx.moveTo(w.ax, w.ay); ctx.lineTo(w.bx, w.by); ctx.stroke();
    });
    // slingshot bodies
    ctx.fillStyle = 'rgba(242,165,22,0.22)';
    ctx.beginPath(); ctx.moveTo(48, 440); ctx.lineTo(84, 505); ctx.lineTo(48, 505); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(284, 440); ctx.lineTo(248, 505); ctx.lineTo(284, 505); ctx.closePath(); ctx.fill();
    // targets: lit ones are solid amber and carry a bar, so they differ by shape as well as colour
    WALLS.forEach(function (w) {
      if (w.kind !== 'target') return;
      var lit = st.targets[w.idx];
      ctx.strokeStyle = lit ? c.amber : c.cyan; ctx.lineWidth = lit ? 7 : 5;
      ctx.beginPath(); ctx.moveTo(w.ax, w.ay); ctx.lineTo(w.bx, w.by); ctx.stroke();
    });
    // lane lamps
    for (i = 0; i < LANES.length; i++) {
      ctx.beginPath(); ctx.arc(LANES[i].x, LANES[i].y, LANE_R - 3, 0, 7);
      ctx.fillStyle = st.lanes[i] ? c.amber : c.amberDim; ctx.fill();
      ctx.strokeStyle = c.wall; ctx.lineWidth = 2; ctx.stroke();
    }
    // bumpers
    for (i = 0; i < BUMPERS.length; i++) {
      var p = BUMPERS[i], lit = !reduce && st.flash[i] > 0;
      ctx.beginPath(); ctx.arc(p.x, p.y, BUMPER_R, 0, 7); ctx.fillStyle = lit ? c.bump2 : c.bump; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = c.ink; ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.y, BUMPER_R * 0.45, 0, 7); ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fill();
    }
    // flippers
    st.flippers.forEach(function (f) {
      var ex = f.px + f.side * Math.cos(f.angle) * FLIP_LEN, ey = f.py + Math.sin(f.angle) * FLIP_LEN;
      ctx.strokeStyle = c.ink; ctx.lineWidth = FLIP_R * 2 + 3; ctx.beginPath(); ctx.moveTo(f.px, f.py); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.strokeStyle = c.amber; ctx.lineWidth = FLIP_R * 2 - 1; ctx.beginPath(); ctx.moveTo(f.px, f.py); ctx.lineTo(ex, ey); ctx.stroke();
    });
    // the plunger spring and its charge
    var drop = st.charge * 14;
    ctx.strokeStyle = c.wall; ctx.lineWidth = 3; ctx.beginPath();
    for (i = 0; i < 6; i++) { var yy = LANE_FLOOR + 2 + i * (3.2 - st.charge * 1.2) + drop * 0.2; ctx.moveTo(324, yy); ctx.lineTo(340, yy + 1.5); }
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(349, 600 - 150, 6, 150);
    ctx.fillStyle = c.amber; ctx.fillRect(349, 600 - 150 * st.charge, 6, 150 * st.charge);
    // balls
    st.balls.forEach(function (b) {
      var g = ctx.createRadialGradient(b.x - 2, b.y - 2, 1, b.x, b.y, BALL_R);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#8a8a94');
      ctx.beginPath(); ctx.arc(b.x, b.y, BALL_R, 0, 7); ctx.fillStyle = g; ctx.fill();
    });
    drawFx(c);
    ctx.font = '600 13px system-ui, sans-serif'; ctx.textAlign = 'center';
    if (st.saver > 0) { ctx.fillStyle = c.amber; ctx.fillText(T('pinball.ballSave').toUpperCase(), 166, 396); }
    if (bannerT > 0 && banner) { ctx.fillStyle = c.ink; ctx.font = '700 22px system-ui, sans-serif'; ctx.fillText(banner.toUpperCase(), 166, 410); }
  }

  // The rings and figures of recent hits, drawn over the table; each leaves when its time is up.
  function drawFx(c) {
    if (!fx.length) return;
    var now = performance.now();
    fx = fx.filter(function (f) { return now - f.t < (f.k === 'pop' ? POP_MS : RING_MS); });
    fx.forEach(function (f) {
      var k = (now - f.t) / (f.k === 'pop' ? POP_MS : RING_MS);
      ctx.globalAlpha = 1 - k;
      if (f.k === 'ring') {
        ctx.strokeStyle = f.e === 'bumper' ? c.bump2 : c.amber; ctx.lineWidth = Math.max(1.5, 4 * (1 - k));
        ctx.beginPath(); ctx.arc(f.x, f.y, (f.e === 'bumper' ? BUMPER_R : 12) * (1 + 0.9 * k), 0, 7); ctx.stroke();
      } else {
        var y = f.y - POP_LIFT - POP_RISE * k;
        ctx.font = '700 15px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.lineJoin = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = c.felt; ctx.fillStyle = c.ink;
        ctx.strokeText(f.text, f.x, y); ctx.fillText(f.text, f.x, y);
      }
    });
    ctx.globalAlpha = 1;
  }

  var KEY = { ArrowLeft: 'left', z: 'left', Z: 'left', ShiftLeft: 'left', ArrowRight: 'right', '/': 'right', '.': 'right', ShiftRight: 'right', x: 'right', X: 'right' };
  function keyName(e) { return e.code === 'ShiftLeft' || e.code === 'ShiftRight' ? e.code : e.key; }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.ar-sheet:not([hidden])')) return;
    var k = KEY[keyName(e)];
    if (k) { e.preventDefault(); keys[k] = true; }
    else if (e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); if (page.mode === 'playing' && st.status === 'ready') st.charging = true; }
  });
  document.addEventListener('keyup', function (e) {
    var k = KEY[keyName(e)];
    if (k) keys[k] = false;
    else if ((e.key === ' ' || e.key === 'ArrowDown') && page.mode === 'playing') launch(st);
  });
  window.addEventListener('blur', function () { keys.left = keys.right = false; touches = {}; });

  // Touch and mouse: the left half of the table works the left flipper, the right half the right one.
  // The plunger lane works the plunger.
  function zoneAt(e) {
    var r = els.cv.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W;
    return x > 320 && st.status === 'ready' ? 'p' : x < W / 2 ? 'l' : 'r';
  }
  els.cv.addEventListener('pointerdown', function (e) {
    if (page.mode !== 'playing') return;
    e.preventDefault();
    try { els.cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no capture */ }
    var z = zoneAt(e);
    touches[e.pointerId] = z;
    if (z === 'p') st.charging = true;
  });
  function lift(e) {
    var z = touches[e.pointerId]; delete touches[e.pointerId];
    if (z === 'p' && page.mode === 'playing') launch(st);
  }
  els.cv.addEventListener('pointerup', lift);
  els.cv.addEventListener('pointercancel', lift);
  els.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  page.start();
  root.__pinball = { get st() { return st; }, get mode() { return page.mode; }, get pos() { return JSON.stringify([page.runId, st.score, st.lives, st.mult, st.balls, st.flippers, st.lanes, st.targets]); } };
})(this);
