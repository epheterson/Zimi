/* ZimiGames: Last Line. Our own code, GPL-3.0. No network, no fonts, no modules.
   Rows of drones sidestep and descend, shields wear away from both sides, a bonus ship crosses the top.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var W = 360, H = 440;
  var COLS = 9, ROWS = 5, GAP_X = 30, GAP_Y = 24, INV_W = 22, INV_H = 14, STEP_X = 6, DROP = 12, EDGE = 10;
  var ROW_POINTS = [30, 20, 20, 10, 10], BONUS_POINTS = [50, 100, 150, 300];
  var PLAYER_Y = H - 28, PLAYER_W = 26, PLAYER_H = 12, PLAYER_SPEED = 190, GROUND_Y = H - 52;
  var BULLET_SPEED = 440, MAX_OWN_BULLETS = 2, FIRE_EVERY = 0.32, MAX_ENEMY_BULLETS = 3, ENEMY_SPEED = 165;
  var SHIELD_COLS = 22, SHIELD_ROWS = 16, CELL = 3, SHIELD_Y = H - 100, SHIELD_XS = [19, 104, 190, 275];
  var START_LIVES = 3, INVULNERABLE_S = 1.6, SWEEP_PX = 2, BONUS_Y = 32, BONUS_SPEED = 72;

  var mulberry = root.ZimiUtil.mulberry32;

  // A shield is a grid of little blocks, rounded at the top with an arch cut out of the bottom.
  function makeShield(x) {
    var cells = [];
    for (var r = 0; r < SHIELD_ROWS; r++) {
      for (var c = 0; c < SHIELD_COLS; c++) {
        var on = 1;
        if (r < 4 && (c < 4 - r || c >= SHIELD_COLS - 4 + r)) on = 0;
        if (r >= 11 && c >= 7 && c <= 14) on = 0;
        cells.push(on);
      }
    }
    return { x: x, y: SHIELD_Y, cells: cells };
  }
  function shieldCount(s) { return s.cells.reduce(function (a, b) { return a + b; }, 0); }
  function cellAt(s, px, py) {
    var c = Math.floor((px - s.x) / CELL), r = Math.floor((py - s.y) / CELL);
    if (c < 0 || r < 0 || c >= SHIELD_COLS || r >= SHIELD_ROWS) return -1;
    return r * SHIELD_COLS + c;
  }
  // Is there shield at this point? Returns the shield and the cell, or null.
  function shieldAt(st, px, py) {
    for (var i = 0; i < st.shields.length; i++) {
      var k = cellAt(st.shields[i], px, py);
      if (k >= 0 && st.shields[i].cells[k]) return { shield: st.shields[i], cell: k };
    }
    return null;
  }
  // A shot bites a rough hole: certain in the middle, likely at the rim.
  function erode(st, hit) {
    var s = hit.shield, cx = hit.cell % SHIELD_COLS, cy = Math.floor(hit.cell / SHIELD_COLS), removed = 0;
    for (var dy = -2; dy <= 2; dy++) for (var dx = -3; dx <= 3; dx++) {
      var d = (dx * dx) / 9 + (dy * dy) / 4, c = cx + dx, r = cy + dy;
      if (d > 1 || c < 0 || r < 0 || c >= SHIELD_COLS || r >= SHIELD_ROWS) continue;
      if ((d < 0.5 || st.rng() < 0.65) && s.cells[r * SHIELD_COLS + c]) { s.cells[r * SHIELD_COLS + c] = 0; removed++; }
    }
    return removed;
  }
  // An invader walking through a shield wipes out whatever it overlaps.
  function trample(st, ix, iy) {
    st.shields.forEach(function (s) {
      for (var r = 0; r < SHIELD_ROWS; r++) for (var c = 0; c < SHIELD_COLS; c++) {
        var x = s.x + c * CELL + CELL / 2, y = s.y + r * CELL + CELL / 2;
        if (Math.abs(x - ix) < INV_W / 2 && Math.abs(y - iy) < INV_H / 2) s.cells[r * SHIELD_COLS + c] = 0;
      }
    });
  }

  function newFormation(st) {
    st.inv = [];
    for (var r = 0; r < ROWS; r++) for (var c = 0; c < COLS; c++) st.inv.push({ c: c, r: r, alive: true });
    st.total = st.inv.length; st.ox = 49; st.oy = 62 + Math.min(st.wave - 1, 5) * 10; st.dir = 1; st.tick = 0; st.frame = 0;
    st.enemyBullets = []; st.bullets = []; st.fireT = 1; st.bonus = null; st.bonusIn = 14 + st.rng() * 8;
    st.shields = SHIELD_XS.map(makeShield);
  }
  function invPos(st, v) { return { x: st.ox + v.c * GAP_X + INV_W / 2, y: st.oy + v.r * GAP_Y + INV_H / 2 }; }
  function aliveCount(st) { var n = 0; st.inv.forEach(function (v) { if (v.alive) n++; }); return n; }

  function createState(seed) {
    var st = { rng: mulberry(seed === undefined ? Math.floor(Math.random() * 4294967296) : seed), time: 0, score: 0, lives: START_LIVES, wave: 1, status: 'playing', events: [], px: W / 2, cool: 0, inv_t: 0, waveT: 0 };
    newFormation(st);
    return st;
  }

  // Seconds between formation steps: fewer drones, faster steps; later waves, faster still.
  function interval(st) {
    var base = Math.max(0.3, 0.62 - 0.04 * (st.wave - 1));
    return Math.max(0.035, base * aliveCount(st) / st.total + 0.02);
  }

  function event(st, name, data, at) { st.events.push({ name: name, data: data, x: at && at.x, y: at && at.y }); }

  function moveFormation(st) {
    var minX = 1e9, maxX = -1e9, maxY = -1e9;
    st.inv.forEach(function (v) { if (!v.alive) return; var p = invPos(st, v); minX = Math.min(minX, p.x - INV_W / 2); maxX = Math.max(maxX, p.x + INV_W / 2); maxY = Math.max(maxY, p.y + INV_H / 2); });
    var dx = st.dir * STEP_X;
    if ((st.dir > 0 && maxX + dx > W - EDGE) || (st.dir < 0 && minX + dx < EDGE)) { st.oy += DROP; st.dir = -st.dir; event(st, 'drop'); }
    else st.ox += dx;
    st.frame ^= 1; event(st, 'step');
    st.inv.forEach(function (v) { if (!v.alive) return; var p = invPos(st, v); trample(st, p.x, p.y); if (p.y + INV_H / 2 >= GROUND_Y) st.status = 'over'; });
    if (st.status === 'over') event(st, 'over');
  }

  function fire(st) {
    var own = st.bullets.length;
    if (st.status !== 'playing' || st.cool > 0 || own >= MAX_OWN_BULLETS) return false;
    st.bullets.push({ x: st.px, y: PLAYER_Y - PLAYER_H / 2 });
    st.cool = FIRE_EVERY; event(st, 'fire');
    return true;
  }

  function enemyFire(st) {
    if (st.enemyBullets.length >= MAX_ENEMY_BULLETS) return;
    var cols = {};
    st.inv.forEach(function (v) { if (v.alive && (!cols[v.c] || v.r > cols[v.c].r)) cols[v.c] = v; });
    var keys = Object.keys(cols);
    if (!keys.length) return;
    // now and then, shoot from above the player
    var pick = null;
    if (st.rng() < 0.4) { var best = 1e9; keys.forEach(function (c) { var p = invPos(st, cols[c]), d = Math.abs(p.x - st.px); if (d < best) { best = d; pick = cols[c]; } }); }
    if (!pick) pick = cols[keys[Math.floor(st.rng() * keys.length)]];
    var p2 = invPos(st, pick);
    st.enemyBullets.push({ x: p2.x, y: p2.y + INV_H / 2 });
  }

  function killPlayer(st) {
    st.lives--; st.enemyBullets = []; event(st, 'hit', undefined, { x: st.px, y: PLAYER_Y });
    if (st.lives <= 0) { st.status = 'over'; event(st, 'over'); } else { st.inv_t = INVULNERABLE_S; st.px = W / 2; }
  }

  // Move a bullet by dy, a couple of pixels at a time, so it cannot skip over a thin shield.
  // Returns the shield hit, if any.
  function sweep(st, b, dy) {
    var n = Math.max(1, Math.ceil(Math.abs(dy) / SWEEP_PX)), sy = dy / n;
    for (var i = 0; i < n; i++) {
      b.y += sy;
      var hit = shieldAt(st, b.x, b.y);
      if (hit) return hit;
    }
    return null;
  }

  // Advance by dt seconds. input: {left, right, fire}.
  function step(st, dt, input) {
    if (st.status === 'over') return;
    input = input || {};
    st.time += dt;
    st.cool = Math.max(0, st.cool - dt); st.inv_t = Math.max(0, st.inv_t - dt);
    st.px = Math.max(PLAYER_W / 2 + 2, Math.min(W - PLAYER_W / 2 - 2, st.px + ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * PLAYER_SPEED * dt));
    if (input.fire) fire(st);

    st.tick += dt;
    var iv = interval(st);
    while (st.tick >= iv && st.status === 'playing') { st.tick -= iv; moveFormation(st); iv = interval(st); }
    if (st.status === 'over') return;

    st.fireT -= dt;
    if (st.fireT <= 0) { st.fireT = (0.45 + st.rng() * 0.8) / (1 + 0.12 * st.wave); enemyFire(st); }

    // the bonus ship
    if (st.bonus) {
      st.bonus.x += st.bonus.dir * BONUS_SPEED * dt;
      if (st.bonus.x < -30 || st.bonus.x > W + 30) st.bonus = null;
    } else {
      st.bonusIn -= dt;
      if (st.bonusIn <= 0) { var left = st.rng() < 0.5; st.bonus = { x: left ? -20 : W + 20, dir: left ? 1 : -1 }; st.bonusIn = 18 + st.rng() * 12; event(st, 'bonus'); }
    }

    // our shots
    var keep = [], i, j;
    for (i = 0; i < st.bullets.length; i++) {
      var b = st.bullets[i], gone = false, hit = sweep(st, b, -BULLET_SPEED * dt);
      if (hit) { erode(st, hit); gone = true; }
      else if (b.y < 0) gone = true;
      if (!gone) {
        for (j = 0; j < st.inv.length; j++) {
          var v = st.inv[j]; if (!v.alive) continue;
          var p = invPos(st, v);
          if (Math.abs(b.x - p.x) <= INV_W / 2 + 1 && Math.abs(b.y - p.y) <= INV_H / 2 + 2) { v.alive = false; st.score += ROW_POINTS[v.r]; event(st, 'kill', v.r, p); gone = true; break; }
        }
      }
      if (!gone && st.bonus && Math.abs(b.x - st.bonus.x) < 16 && Math.abs(b.y - BONUS_Y) < 8) {
        var pts = BONUS_POINTS[Math.floor(st.rng() * BONUS_POINTS.length)]; st.score += pts; event(st, 'bonushit', pts, { x: st.bonus.x, y: BONUS_Y }); st.bonus = null; gone = true;
      }
      if (!gone) keep.push(b);
    }
    st.bullets = keep;

    // theirs
    keep = [];
    var cleared = false;
    for (i = 0; i < st.enemyBullets.length; i++) {
      var e = st.enemyBullets[i], dead = false, eh = sweep(st, e, ENEMY_SPEED * dt);
      if (eh) { erode(st, eh); dead = true; }
      else if (e.y > H) dead = true;
      else if (st.inv_t <= 0 && Math.abs(e.x - st.px) < PLAYER_W / 2 && Math.abs(e.y - PLAYER_Y) < PLAYER_H / 2 + 2) { killPlayer(st); dead = true; cleared = true; if (st.status === 'over') return; }
      if (!dead) keep.push(e);
    }
    st.enemyBullets = cleared ? [] : keep;

    if (!aliveCount(st)) {
      st.waveT += dt;
      if (st.waveT > 1.2) { st.waveT = 0; st.wave++; newFormation(st); event(st, 'wave', st.wave); }
    }
  }

  var Engine = { W: W, H: H, COLS: COLS, ROWS: ROWS, GAP_X: GAP_X, GAP_Y: GAP_Y, INV_W: INV_W, INV_H: INV_H, DROP: DROP, STEP_X: STEP_X, PLAYER_Y: PLAYER_Y, GROUND_Y: GROUND_Y, SHIELD_COLS: SHIELD_COLS, SHIELD_ROWS: SHIELD_ROWS, CELL: CELL, SHIELD_Y: SHIELD_Y,
    ROW_POINTS: ROW_POINTS, BONUS_POINTS: BONUS_POINTS, createState: createState, step: step, fire: fire, interval: interval, invPos: invPos, shieldCount: shieldCount, aliveCount: aliveCount, mulberry: mulberry, START_LIVES: START_LIVES };
  root.LastLineEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var BEST_KEY = 'zimi.games.lastline.best', CHROME_PX = 190;
  Play.applyTheme();

  var els = { cv: $('ll-board'), score: $('ll-score'), best: $('ll-best'), lives: $('ll-lives'), wave: $('ll-wave'), msg: $('ll-msg'), pause: $('ll-pause'), newBtn: $('ll-new') };
  var st = createState(), ctx;

  var page = Play.arcadePage({
    els: els, bestKey: BEST_KEY, ready: { touch: 'lastline.readyTouch', keys: 'lastline.readyKeys' }, state: function () { return st; }, draw: draw,
    layout: function () { ctx = Play.fitCanvas(els.cv, W, H, CHROME_PX, 560).ctx; draw(); },
    keys: { ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right', ' ': 'fire', ArrowUp: 'fire' },
    pad: { dirs: ['left', 'right'], actions: [{ name: 'fire', label: T('play.fire') }] },
    newRun: function () { st = createState(); burst.clear(); },
    snapshot: function () { return Play.plain(st); },
    restore: function (saved) { st = Play.overlay(createState(), saved); st.events = []; burst.clear(); }
  });
  var status = page.status;

  // A drone, the bonus ship or the cannon coming apart shows as spokes flying out for a moment.
  var burst = root.ArcadeBurst(Play.reducedMotion);
  page.run(function (dt) {
    step(st, dt, page.input());
    st.events.forEach(function (e) {
      if (e.name === 'kill') burst.add(e.x, e.y, 13, COLORS[e.data], st.time);
      else if (e.name === 'bonushit') burst.add(e.x, e.y, 22, '#ff6b6b', st.time);
      else if (e.name === 'hit') burst.add(e.x, e.y, 28, '#3fc1e8', st.time);
      if (e.name === 'wave') status.reason(T('lastline.wave', { n: e.data }));
      else if (e.name === 'bonushit') status.reason(T('lastline.bonus', { n: e.data }));
      else if (e.name === 'hit' && st.lives > 0) status.say(st.lives === 1 ? T('lastline.lastLife') : '');
      else if (e.name === 'over') page.finish();
    });
    st.events.length = 0;
  });

  var COLORS = ['#c88cff', '#3fc1e8', '#3fc1e8', '#62c470', '#62c470'];
  // Three kinds of drone, each with two poses that swap at every step.
  function drone(x, y, row, frame) {
    var kind = row === 0 ? 0 : row < 3 ? 1 : 2, hw = INV_W / 2, hh = INV_H / 2;
    ctx.fillStyle = COLORS[row]; ctx.strokeStyle = COLORS[row]; ctx.lineWidth = 2;
    ctx.beginPath();
    if (kind === 0) { // a diamond with side wings
      ctx.moveTo(x, y - hh); ctx.lineTo(x + hw * 0.55, y); ctx.lineTo(x, y + hh); ctx.lineTo(x - hw * 0.55, y); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x - hw, y + (frame ? -2 : 3)); ctx.lineTo(x - hw * 0.5, y); ctx.moveTo(x + hw, y + (frame ? -2 : 3)); ctx.lineTo(x + hw * 0.5, y); ctx.stroke();
    } else if (kind === 1) { // a dome with feelers
      ctx.arc(x, y + 2, hw * 0.75, Math.PI, 0); ctx.lineTo(x + hw * 0.75, y + hh * 0.6); ctx.lineTo(x - hw * 0.75, y + hh * 0.6); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x - 4, y - hh * 0.4); ctx.lineTo(x - 7, y - hh + (frame ? 0 : 2)); ctx.moveTo(x + 4, y - hh * 0.4); ctx.lineTo(x + 7, y - hh + (frame ? 0 : 2)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - hw * 0.6, y + hh * 0.6); ctx.lineTo(x - hw * 0.6 - (frame ? 2 : -2), y + hh); ctx.moveTo(x + hw * 0.6, y + hh * 0.6); ctx.lineTo(x + hw * 0.6 + (frame ? 2 : -2), y + hh); ctx.stroke();
    } else { // a wide crawler on four feet
      ctx.rect(x - hw, y - hh * 0.6, INV_W, hh * 1.2); ctx.fill();
      ctx.beginPath(); for (var k = 0; k < 4; k++) { var fx = x - hw + 3 + k * 5.3; ctx.moveTo(fx, y + hh * 0.5); ctx.lineTo(fx + ((k + frame) % 2 ? 2 : -2), y + hh); } ctx.stroke();
    }
    ctx.fillStyle = '#0e0e10'; ctx.beginPath(); ctx.arc(x - 3.5, y - 1, 1.8, 0, 7); ctx.arc(x + 3.5, y - 1, 1.8, 0, 7); ctx.fill();
  }

  function draw() {
    if (!ctx) return;
    ctx.fillStyle = '#0e0e10'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(98,196,112,0.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, PLAYER_Y + 14); ctx.lineTo(W, PLAYER_Y + 14); ctx.stroke();
    ctx.fillStyle = '#62c470';
    st.shields.forEach(function (s) {
      for (var r = 0; r < SHIELD_ROWS; r++) for (var c = 0; c < SHIELD_COLS; c++) if (s.cells[r * SHIELD_COLS + c]) ctx.fillRect(s.x + c * CELL, s.y + r * CELL, CELL, CELL);
    });
    burst.draw(ctx, st.time);
    st.inv.forEach(function (v) { if (v.alive) { var p = invPos(st, v); drone(p.x, p.y, v.r, st.frame); } });
    if (st.bonus) { // the bonus ship: a flat saucer with a dome
      ctx.fillStyle = '#ff6b6b'; ctx.beginPath(); ctx.ellipse(st.bonus.x, BONUS_Y, 15, 6, 0, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(st.bonus.x, BONUS_Y - 2, 7, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#0e0e10'; for (var k = -1; k <= 1; k++) ctx.fillRect(st.bonus.x + k * 8 - 1, BONUS_Y, 2, 2);
    }
    ctx.fillStyle = '#ffffff'; st.bullets.forEach(function (b) { ctx.fillRect(b.x - 1, b.y - 5, 2, 8); });
    ctx.strokeStyle = '#ff9d5c'; ctx.lineWidth = 2;
    st.enemyBullets.forEach(function (e) { ctx.beginPath(); ctx.moveTo(e.x - 2, e.y - 4); ctx.lineTo(e.x + 2, e.y); ctx.lineTo(e.x - 2, e.y + 4); ctx.stroke(); });
    if (st.status !== 'over' && (st.inv_t <= 0 || Math.floor(st.time * 9) % 2 === 0 || Play.reducedMotion())) {
      ctx.fillStyle = '#3fc1e8';
      ctx.fillRect(st.px - PLAYER_W / 2, PLAYER_Y - 2, PLAYER_W, PLAYER_H - 4);
      ctx.fillRect(st.px - PLAYER_W / 2 + 4, PLAYER_Y - 6, PLAYER_W - 8, 5);
      ctx.fillRect(st.px - 2, PLAYER_Y - 12, 4, 7);
    }
  }

  page.start();
  root.__lastline = { get st() { return st; }, get mode() { return page.mode; }, get pos() { return JSON.stringify([page.runId, st.score, st.lives, st.wave, st.px, st.inv, st.bullets, st.enemyBullets, st.shields.map(function (s) { return s.cells; })]); } };
})(this);
