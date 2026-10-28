/* ZimiGames: Rocks. Our own code, GPL-3.0. No network, no fonts, no modules.
   Drift, turn, thrust and shoot in a wrapped-around space; rocks split; a saucer shoots back.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var SIZE = 400;                          // the field is a square, 400 x 400, edges wrap
  var TURN = 4.4, THRUST = 230, DRAG = 0.28, MAX_SPEED = 330; // rad/s, px/s^2, per second, px/s
  var SHIP_R = 9, FIRE_EVERY = 0.2, BULLET_SPEED = 440, BULLET_LIFE = 0.85, MAX_BULLETS = 4;
  var ROCK_R = { 3: 30, 2: 17, 1: 9 }, ROCK_POINTS = { 3: 20, 2: 50, 1: 100 }, ROCK_SPEED = { 3: 34, 2: 62, 1: 98 };
  var SAUCER = { big: { r: 15, speed: 80, points: 200 }, small: { r: 10, speed: 125, points: 1000 } };
  var SAUCER_BULLET_SPEED = 210, SAUCER_BULLET_LIFE = 1.7, SAUCER_FIRE_EVERY = 1.35;
  var START_LIVES = 3, EXTRA_LIFE_EVERY = 10000, RESPAWN_S = 1.6, INVULNERABLE_S = 2.6, CLEAR_RADIUS = 90, WAVE_PAUSE_S = 1.5;

  var mulberry = root.ZimiUtil.mulberry32;

  function wrap(v) { return ((v % SIZE) + SIZE) % SIZE; }
  // The distance between two points on a field whose edges wrap.
  function torusDist(ax, ay, bx, by) {
    var dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
    if (dx > SIZE / 2) dx = SIZE - dx;
    if (dy > SIZE / 2) dy = SIZE - dy;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function overlap(a, ra, b, rb) { return torusDist(a.x, a.y, b.x, b.y) < ra + rb; }

  function makeRock(rng, size, x, y, vx, vy) {
    var shape = [], n = 11;
    for (var i = 0; i < n; i++) shape.push(0.74 + rng() * 0.36);
    var ang = rng() * 6.283, sp = ROCK_SPEED[size] * (0.7 + rng() * 0.6);
    return { x: x, y: y, vx: vx === undefined ? Math.cos(ang) * sp : vx, vy: vy === undefined ? Math.sin(ang) * sp : vy, size: size, r: ROCK_R[size], shape: shape, rot: rng() * 6.283, spin: (rng() - 0.5) * 1.4 };
  }
  // A rock that is shot splits in two smaller ones that leave in different directions (size 1 just goes).
  function splitRock(rock, rng) {
    if (rock.size <= 1) return [];
    var out = [], base = Math.atan2(rock.vy, rock.vx);
    for (var k = 0; k < 2; k++) {
      var s = rock.size - 1, a = base + (k ? 1 : -1) * (0.5 + rng() * 0.7), sp = ROCK_SPEED[s] * (0.8 + rng() * 0.5);
      out.push(makeRock(rng, s, rock.x, rock.y, Math.cos(a) * sp + rock.vx * 0.3, Math.sin(a) * sp + rock.vy * 0.3));
    }
    return out;
  }

  function spawnWave(st) {
    var n = Math.min(9, 3 + st.wave), speedUp = 1 + 0.06 * Math.min(st.wave - 1, 8);
    st.rocks = [];
    for (var i = 0; i < n; i++) {
      var x, y, tries = 0;
      do { x = st.rng() * SIZE; y = st.rng() * SIZE; tries++; } while (torusDist(x, y, SIZE / 2, SIZE / 2) < 120 && tries < 50);
      var r = makeRock(st.rng, 3, x, y); r.vx *= speedUp; r.vy *= speedUp;
      st.rocks.push(r);
    }
    st.saucerIn = 11 + st.rng() * 8;
  }

  function createState(seed) {
    var st = { rng: mulberry(seed === undefined ? Math.floor(Math.random() * 4294967296) : seed), time: 0, score: 0, lives: START_LIVES, wave: 1, status: 'playing', events: [],
      ship: { x: SIZE / 2, y: SIZE / 2, a: 0, vx: 0, vy: 0, alive: true, inv: INVULNERABLE_S, cool: 0, respawn: 0, thrusting: false },
      bullets: [], rocks: [], saucer: null, saucerIn: 0, waveT: 0, nextLife: EXTRA_LIFE_EVERY };
    spawnWave(st);
    return st;
  }

  function event(st, name, data, at) { st.events.push({ name: name, data: data, x: at && at.x, y: at && at.y }); }
  function addScore(st, n) {
    st.score += n;
    while (st.score >= st.nextLife) { st.lives++; st.nextLife += EXTRA_LIFE_EVERY; event(st, 'extra'); }
  }

  function fire(st) {
    var s = st.ship, own = st.bullets.filter(function (b) { return b.own; }).length;
    if (!s.alive || s.cool > 0 || own >= MAX_BULLETS) return false;
    var dx = Math.sin(s.a), dy = -Math.cos(s.a);
    st.bullets.push({ x: wrap(s.x + dx * SHIP_R), y: wrap(s.y + dy * SHIP_R), vx: dx * BULLET_SPEED + s.vx * 0.5, vy: dy * BULLET_SPEED + s.vy * 0.5, life: BULLET_LIFE, own: true });
    s.cool = FIRE_EVERY; event(st, 'fire');
    return true;
  }

  function killShip(st) {
    var s = st.ship;
    s.alive = false; s.respawn = RESPAWN_S; s.thrusting = false; s.vx = s.vy = 0;
    st.lives--; event(st, 'ship', undefined, s);
  }

  function spawnSaucer(st) {
    var small = st.wave >= 2 && st.rng() < Math.min(0.75, 0.2 + 0.12 * st.wave), kind = small ? SAUCER.small : SAUCER.big, fromLeft = st.rng() < 0.5;
    st.saucer = { x: fromLeft ? -kind.r : SIZE + kind.r, y: 40 + st.rng() * (SIZE - 80), vx: (fromLeft ? 1 : -1) * kind.speed, vy: 0, small: small, r: kind.r, turnIn: 1 + st.rng(), fireIn: SAUCER_FIRE_EVERY };
    event(st, 'saucer');
  }
  function saucerShoot(st) {
    var sc = st.saucer, s = st.ship, a;
    if (sc.small && s.alive) {
      var err = (st.rng() - 0.5) * 2 * Math.max(0.06, 0.45 - 0.07 * st.wave);
      a = Math.atan2(s.y - sc.y, s.x - sc.x) + err;
    } else a = st.rng() * 6.283;
    st.bullets.push({ x: sc.x, y: sc.y, vx: Math.cos(a) * SAUCER_BULLET_SPEED, vy: Math.sin(a) * SAUCER_BULLET_SPEED, life: SAUCER_BULLET_LIFE, own: false });
  }

  // Advance by dt seconds. input: {left, right, thrust, fire} booleans.
  function step(st, dt, input) {
    if (st.status === 'over') return;
    input = input || {};
    st.time += dt;
    var s = st.ship, i, j;

    if (s.alive) {
      s.a += ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * TURN * dt;
      s.thrusting = !!input.thrust;
      if (s.thrusting) { s.vx += Math.sin(s.a) * THRUST * dt; s.vy -= Math.cos(s.a) * THRUST * dt; }
      var drag = Math.max(0, 1 - DRAG * dt); s.vx *= drag; s.vy *= drag;
      var sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
      if (sp > MAX_SPEED) { s.vx *= MAX_SPEED / sp; s.vy *= MAX_SPEED / sp; }
      s.x = wrap(s.x + s.vx * dt); s.y = wrap(s.y + s.vy * dt);
      s.cool = Math.max(0, s.cool - dt); s.inv = Math.max(0, s.inv - dt);
      if (input.fire) fire(st);
    } else if (st.lives > 0) {
      s.respawn -= dt;
      var clear = st.rocks.every(function (r) { return torusDist(r.x, r.y, SIZE / 2, SIZE / 2) > CLEAR_RADIUS; }) && !(st.saucer && torusDist(st.saucer.x, st.saucer.y, SIZE / 2, SIZE / 2) < CLEAR_RADIUS);
      if (s.respawn <= 0 && clear) { s.alive = true; s.x = s.y = SIZE / 2; s.a = 0; s.vx = s.vy = 0; s.inv = INVULNERABLE_S; s.cool = 0; }
    }

    for (i = 0; i < st.rocks.length; i++) { var r = st.rocks[i]; r.x = wrap(r.x + r.vx * dt); r.y = wrap(r.y + r.vy * dt); r.rot += r.spin * dt; }
    var keep = [];
    for (i = 0; i < st.bullets.length; i++) {
      var b = st.bullets[i]; b.life -= dt;
      if (b.life <= 0) continue;
      b.x = wrap(b.x + b.vx * dt); b.y = wrap(b.y + b.vy * dt); keep.push(b);
    }
    st.bullets = keep;

    // the saucer
    if (st.saucer) {
      var sc = st.saucer;
      sc.x += sc.vx * dt; sc.y = wrap(sc.y + sc.vy * dt);
      sc.turnIn -= dt; if (sc.turnIn <= 0) { sc.turnIn = 0.8 + st.rng(); sc.vy = (st.rng() - 0.5) * 140; }
      sc.fireIn -= dt; if (sc.fireIn <= 0) { sc.fireIn = SAUCER_FIRE_EVERY; saucerShoot(st); }
      if (sc.x < -40 || sc.x > SIZE + 40) st.saucer = null;
    } else if (st.rocks.length) {
      st.saucerIn -= dt;
      if (st.saucerIn <= 0) { spawnSaucer(st); st.saucerIn = 12 + st.rng() * 10; }
    }

    // shots at rocks and the saucer
    for (i = st.bullets.length - 1; i >= 0; i--) {
      var bl = st.bullets[i], gone = false;
      if (bl.own) {
        for (j = 0; j < st.rocks.length && !gone; j++) {
          if (overlap(bl, 1, st.rocks[j], st.rocks[j].r)) {
            var rk = st.rocks[j];
            st.rocks.splice(j, 1);
            Array.prototype.push.apply(st.rocks, splitRock(rk, st.rng));
            addScore(st, ROCK_POINTS[rk.size]); event(st, 'rock', rk.size, rk); gone = true;
          }
        }
        if (!gone && st.saucer && overlap(bl, 1, st.saucer, st.saucer.r + 2)) {
          addScore(st, st.saucer.small ? SAUCER.small.points : SAUCER.big.points); event(st, 'saucerdown', undefined, st.saucer); st.saucer = null; gone = true;
        }
      } else if (s.alive && s.inv <= 0 && overlap(bl, 1, s, SHIP_R)) { killShip(st); gone = true; }
      if (gone) st.bullets.splice(i, 1);
    }
    // the ship runs into a rock or the saucer
    if (s.alive && s.inv <= 0) {
      for (j = 0; j < st.rocks.length; j++) {
        if (overlap(s, SHIP_R - 1, st.rocks[j], st.rocks[j].r * 0.9)) {
          var hit = st.rocks[j]; st.rocks.splice(j, 1); Array.prototype.push.apply(st.rocks, splitRock(hit, st.rng)); addScore(st, ROCK_POINTS[hit.size]);
          killShip(st); break;
        }
      }
      if (s.alive && st.saucer && overlap(s, SHIP_R - 1, st.saucer, st.saucer.r)) { st.saucer = null; killShip(st); }
    }

    if (!s.alive && st.lives <= 0) { st.status = 'over'; event(st, 'over'); return; }
    if (!st.rocks.length && !st.saucer) {
      st.waveT += dt;
      if (st.waveT >= WAVE_PAUSE_S) { st.waveT = 0; st.wave++; spawnWave(st); event(st, 'wave', st.wave); }
    }
  }

  var Engine = { SIZE: SIZE, SHIP_R: SHIP_R, ROCK_R: ROCK_R, ROCK_POINTS: ROCK_POINTS, SAUCER: SAUCER, MAX_BULLETS: MAX_BULLETS, TURN: TURN, createState: createState, step: step, fire: fire, wrap: wrap, torusDist: torusDist, splitRock: splitRock, makeRock: makeRock, mulberry: mulberry, START_LIVES: START_LIVES, EXTRA_LIFE_EVERY: EXTRA_LIFE_EVERY };
  root.RocksEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var BEST_KEY = 'zimi.games.rocks.best', CHROME_PX = 190;
  Play.applyTheme();

  var els = { cv: $('rk-board'), score: $('rk-score'), best: $('rk-best'), lives: $('rk-lives'), wave: $('rk-wave'), msg: $('rk-msg'), pause: $('rk-pause'), newBtn: $('rk-new') };
  var st = createState(), ctx;
  var stars = (function () { var r = mulberry(77), a = []; for (var i = 0; i < 70; i++) a.push([r() * SIZE, r() * SIZE, 0.5 + r() * 1.1, 0.25 + r() * 0.5]); return a; })();

  var page = Play.arcadePage({
    els: els, bestKey: BEST_KEY, ready: { touch: 'rocks.readyTouch', keys: 'rocks.readyKeys' }, state: function () { return st; }, draw: draw,
    layout: function () { ctx = Play.fitCanvas(els.cv, SIZE, SIZE, CHROME_PX, 560).ctx; draw(); },
    keys: { ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right', ArrowUp: 'thrust', w: 'thrust', W: 'thrust', ' ': 'fire' },
    pad: { dirs: ['left', 'right'], actions: [{ name: 'thrust', label: T('play.thrust') }, { name: 'fire', label: T('play.fire') }] },
    newRun: function () { st = createState(); burst.clear(); },
    snapshot: function () { return Play.plain(st); },
    restore: function (saved) { st = Play.overlay(createState(), saved); st.events = []; burst.clear(); }
  });
  var status = page.status;

  // A rock, the saucer or the ship coming apart shows as spokes flying out for a moment.
  var BURST_REACH = { 3: 26, 2: 18, 1: 12, ship: 30, saucer: 24 }, burst = root.ArcadeBurst(Play.reducedMotion);
  function burstAt(e) {
    var key = e.name === 'rock' ? e.data : e.name === 'ship' ? 'ship' : 'saucer';
    burst.add(e.x, e.y, BURST_REACH[key] || 16, e.name === 'ship' ? '#3fc1e8' : '#e8e8ed', st.time);
  }
  page.run(function (dt) {
    step(st, dt, page.input());
    st.events.forEach(function (e) {
      if (e.name === 'rock' || e.name === 'ship' || e.name === 'saucerdown') burstAt(e);
      if (e.name === 'wave') status.reason(T('rocks.wave', { n: e.data }));
      else if (e.name === 'extra') status.reason(T('rocks.extra'));
      else if (e.name === 'over') page.finish();
    });
    st.events.length = 0;
  });

  function poly(cx, cy, rot, r, shape) {
    ctx.beginPath();
    for (var i = 0; i < shape.length; i++) {
      var a = rot + i / shape.length * 6.2832, rr = r * shape[i], x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }
  // Draw something at its place and, near an edge, again on the other side, so it never pops.
  function wrapped(x, y, r, fn) {
    var xs = [0], ys = [0];
    if (x < r) xs.push(SIZE); if (x > SIZE - r) xs.push(-SIZE);
    if (y < r) ys.push(SIZE); if (y > SIZE - r) ys.push(-SIZE);
    xs.forEach(function (ox) { ys.forEach(function (oy) { fn(x + ox, y + oy); }); });
  }

  function draw() {
    if (!ctx) return;
    ctx.fillStyle = '#0e0e10'; ctx.fillRect(0, 0, SIZE, SIZE);
    stars.forEach(function (s) { ctx.fillStyle = 'rgba(255,255,255,' + s[3] + ')'; ctx.fillRect(s[0], s[1], s[2], s[2]); });
    ctx.lineJoin = 'round'; ctx.lineWidth = 2;
    st.rocks.forEach(function (r) {
      wrapped(r.x, r.y, r.r, function (x, y) { poly(x, y, r.rot, r.r, r.shape); ctx.fillStyle = 'rgba(200,198,190,0.16)'; ctx.fill(); ctx.strokeStyle = '#c8c6be'; ctx.stroke(); });
    });
    if (st.saucer) {
      var sc = st.saucer;
      ctx.strokeStyle = '#ff9d5c'; ctx.fillStyle = 'rgba(255,157,92,0.25)';
      ctx.beginPath(); ctx.ellipse(sc.x, sc.y, sc.r, sc.r * 0.42, 0, 0, 7); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(sc.x, sc.y - sc.r * 0.15, sc.r * 0.48, Math.PI, 0); ctx.stroke();
    }
    st.bullets.forEach(function (b) { ctx.fillStyle = b.own ? '#ffffff' : '#ff6b6b'; ctx.beginPath(); ctx.arc(b.x, b.y, b.own ? 2 : 2.6, 0, 7); ctx.fill(); });
    burst.draw(ctx, st.time);
    var s = st.ship;
    if (!s.alive && st.lives > 0 && !Play.reducedMotion() && Math.floor(st.time * 3) % 2 === 0) { // waiting for room to come back: a faint ring at the middle
      ctx.strokeStyle = 'rgba(63,193,232,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.arc(SIZE / 2, SIZE / 2, SHIP_R + 6, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    }
    if (s.alive && (s.inv <= 0 || Math.floor(st.time * 9) % 2 === 0 || Play.reducedMotion())) {
      wrapped(s.x, s.y, SHIP_R + 4, function (x, y) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(s.a);
        if (s.thrusting) { ctx.fillStyle = '#ffb347'; ctx.beginPath(); ctx.moveTo(-4, 6); ctx.lineTo(0, 14 + Math.random() * 4); ctx.lineTo(4, 6); ctx.closePath(); ctx.fill(); }
        ctx.beginPath(); ctx.moveTo(0, -SHIP_R); ctx.lineTo(SHIP_R * 0.75, SHIP_R * 0.8); ctx.lineTo(0, SHIP_R * 0.35); ctx.lineTo(-SHIP_R * 0.75, SHIP_R * 0.8); ctx.closePath();
        ctx.fillStyle = 'rgba(63,193,232,0.3)'; ctx.fill(); ctx.strokeStyle = '#3fc1e8'; ctx.stroke();
        ctx.restore();
      });
    }
  }

  page.start();
  root.__rocks = { get st() { return st; }, get mode() { return page.mode; }, get pos() { return JSON.stringify([page.runId, st.score, st.lives, st.wave, st.ship, st.rocks, st.bullets, st.saucer]); } };
})(this);
