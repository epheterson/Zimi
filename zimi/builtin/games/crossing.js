/* ZimiGames: Crossing, hop a chick over roads and rivers. Our own code and art, GPL-3.0. No network, no modules.
   Five lanes of traffic, a safe strip, five lanes of river (logs and diving turtles), then five nests to fill.
   Every lane is a row of data below; each level runs them faster. The rules are pure functions (no DOM) so
   node can test them; the page draws it all at 176 x 208 pixels. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var COLS = 11, ROWS = 13, TILE = 16;
  var START_ROW = 12, MEDIAN_ROW = 6, GOAL_ROW = 0;
  var NESTS = [1, 3, 5, 7, 9];
  // One row of data per lane. kind: what drifts by; len: its length in tiles; spacing: tiles from the start of one
  // to the start of the next; count: how many make the lane's loop (a loop is count * spacing tiles); speed: tiles
  // per second at level 1; dir: +1 right, -1 left; turtles dive for a moment every few seconds.
  var LANES = {
    1: { type: 'river', kind: 'log', len: 4, spacing: 9, count: 2, speed: 1.6, dir: 1 },
    2: { type: 'river', kind: 'turtle', len: 3, spacing: 6, count: 3, speed: 1.4, dir: -1 },
    3: { type: 'river', kind: 'log', len: 5, spacing: 9, count: 2, speed: 2.0, dir: 1 },
    4: { type: 'river', kind: 'log', len: 3, spacing: 6, count: 3, speed: 1.1, dir: 1 },
    5: { type: 'river', kind: 'turtle', len: 2, spacing: 5, count: 4, speed: 1.8, dir: -1 },
    7: { type: 'road', kind: 'car', len: 1, spacing: 4.5, count: 4, speed: 2.0, dir: -1 },
    8: { type: 'road', kind: 'truck', len: 2, spacing: 7, count: 3, speed: 1.2, dir: 1 },
    9: { type: 'road', kind: 'car', len: 1, spacing: 5, count: 4, speed: 1.6, dir: -1 },
    10: { type: 'road', kind: 'bus', len: 3, spacing: 9, count: 2, speed: 1.0, dir: 1 },
    11: { type: 'road', kind: 'car', len: 1, spacing: 4, count: 5, speed: 2.4, dir: -1 }
  };
  var LEVEL_SPEEDUP = 0.12, MAX_SPEEDUP = 2.2;
  var TURTLE_CYCLE = 6, TURTLE_DIVE = 1.6, TURTLE_WARN = 0.8;   // seconds: a turtle is under for the last TURTLE_DIVE of every cycle
  var HOP_COOLDOWN = 0.11, LIVES = 3, TIME_LIMIT = 32, DEATH_S = 0.9, NEST_S = 0.7, CLEAR_S = 1.6;
  var HIT_MARGIN = 0.18;   // the chick is a little narrower than its tile for crashes and for staying on a log
  var ROW_POINTS = 10, NEST_POINTS = 50, TIME_POINTS = 2, CLEAR_POINTS = 100, EXTRA_LIFE = 5000;

  var mulberry = root.ZimiUtil.mulberry32;
  function speedUp(level) { return Math.min(MAX_SPEEDUP, 1 + LEVEL_SPEEDUP * (level - 1)); }
  function laneLoop(lane) { return lane.count * lane.spacing; }
  function laneAt(row) { return LANES[row] || null; }
  function isRiver(row) { return !!LANES[row] && LANES[row].type === 'river'; }
  function isRoad(row) { return !!LANES[row] && LANES[row].type === 'road'; }

  // Everything drifting in a lane at time t: [{x, len, kind, under}] where x is the left edge in tiles (may be off the screen
  // on either side, the loop is longer than the lane). Pure: the same t always gives the same picture.
  function objectsOf(st, row, t) {
    var lane = LANES[row];
    if (!lane) return [];
    var loop = laneLoop(lane), out = [], k = lane.shift || (row * 1.7) % lane.spacing, move = lane.dir * lane.speed * speedUp(st.level) * (t === undefined ? st.time : t);
    var tt = t === undefined ? st.time : t;
    for (var i = 0; i < lane.count; i++) {
      var x = (((k + i * lane.spacing + move) % loop) + loop) % loop;
      if (x > COLS + 1) x -= loop;   // the loop wraps: what is past the right edge comes back in from the left
      var o = { x: x, len: lane.len, kind: lane.kind, under: false };
      if (lane.kind === 'turtle') {
        var phase = ((tt + i * 1.3 + row) % TURTLE_CYCLE + TURTLE_CYCLE) % TURTLE_CYCLE;
        o.under = phase >= TURTLE_CYCLE - TURTLE_DIVE; o.warn = !o.under && phase >= TURTLE_CYCLE - TURTLE_DIVE - TURTLE_WARN;
      }
      out.push(o);
    }
    return out;
  }
  // The thing a chick standing at x on this river row is riding, or null (then it drowns).
  function carrier(st, row, x) {
    var objs = objectsOf(st, row), c = x + 0.5;
    for (var i = 0; i < objs.length; i++) if (!objs[i].under && c > objs[i].x + 0.05 && c < objs[i].x + objs[i].len - 0.05) return objs[i];
    return null;
  }
  // A vehicle on this road row overlapping a chick at x, or null.
  function crash(st, row, x) {
    var objs = objectsOf(st, row), l = x + HIT_MARGIN, r = x + 1 - HIT_MARGIN;
    for (var i = 0; i < objs.length; i++) if (r > objs[i].x && l < objs[i].x + objs[i].len) return objs[i];
    return null;
  }

  function createState(level, seed, carry) {
    var st = { level: level || 1, seed: seed, rng: mulberry(seed === undefined ? Math.floor(Math.random() * 4294967296) : seed), time: 0,
      score: carry ? carry.score : 0, lives: carry ? carry.lives : LIVES, nextLife: carry ? carry.nextLife : EXTRA_LIFE, nests: [false, false, false, false, false],
      x: 5, row: START_ROW, best: START_ROW, left: TIME_LIMIT, status: 'playing', statusT: 0, cool: 0, queued: null, face: 'up', hopT: 1, why: '', events: [], anim: 0 };
    return st;
  }
  function event(st, name, data) { st.events.push({ name: name, data: data }); }
  function addScore(st, n) { st.score += n; while (st.score >= st.nextLife) { st.lives++; st.nextLife += EXTRA_LIFE; event(st, 'life'); } }

  function die(st, why) {
    if (st.status !== 'playing') return;
    st.lives--; st.status = 'dying'; st.statusT = DEATH_S; st.why = why; event(st, 'die', why);
  }
  function respawn(st) {
    st.x = 5; st.row = START_ROW; st.best = START_ROW; st.left = TIME_LIMIT; st.status = 'playing'; st.queued = null; st.face = 'up'; st.cool = 0;
  }

  // Hop one tile: 'up', 'down', 'left' or 'right'. Returns true when it moved (or died trying).
  function hop(st, dir) {
    if (st.status !== 'playing') return false;
    if (st.cool > 0) { st.queued = dir; return false; }
    var dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0, dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
    var nx = st.x + dx, nrow = st.row + dy;
    if (nrow > START_ROW) return false;
    if (nx < 0 || nx > COLS - 1) { if (dx) return false; }
    st.face = dir; st.cool = HOP_COOLDOWN; st.hopT = 0; event(st, 'hop');
    if (dy) {
      st.row = nrow;
      if (!isRiver(nrow)) st.x = Math.round(st.x);   // off the water the chick lands on a tile
      if (nrow < st.best) { st.best = nrow; addScore(st, ROW_POINTS); }
    } else st.x = nx;
    st.x = Math.max(0, Math.min(COLS - 1, st.x));
    // arriving
    if (st.row === GOAL_ROW) {
      var n = -1;
      NESTS.forEach(function (c, i) { if (Math.abs(st.x - c) <= 0.5) n = i; });
      if (n < 0 || st.nests[n]) { die(st, 'wall'); return true; }
      st.nests[n] = true; st.status = 'nested'; st.statusT = NEST_S; st.x = NESTS[n];
      addScore(st, NEST_POINTS + Math.floor(st.left) * TIME_POINTS); event(st, 'nest', n);
      return true;
    }
    if (isRoad(st.row) && crash(st, st.row, st.x)) die(st, 'car');
    else if (isRiver(st.row) && !carrier(st, st.row, st.x)) die(st, 'water');
    return true;
  }

  // One tick of dt seconds.
  function step(st, dt) {
    st.anim += dt; st.time += dt; st.hopT = Math.min(1, st.hopT + dt / 0.12);
    if (st.status === 'dying') { st.statusT -= dt; if (st.statusT <= 0) { if (st.lives <= 0) { st.status = 'over'; event(st, 'over'); } else respawn(st); } return; }
    if (st.status === 'nested') {
      st.statusT -= dt;
      if (st.statusT <= 0) {
        if (st.nests.every(Boolean)) { st.status = 'cleared'; st.statusT = CLEAR_S; addScore(st, CLEAR_POINTS * st.level); event(st, 'clear'); }
        else respawn(st);
      }
      return;
    }
    if (st.status === 'cleared') { st.statusT -= dt; return; }
    if (st.status !== 'playing') return;
    st.cool = Math.max(0, st.cool - dt);
    if (st.cool === 0 && st.queued) { var q = st.queued; st.queued = null; hop(st, q); if (st.status !== 'playing') return; }
    st.left -= dt;
    if (st.left <= 0) { st.left = 0; die(st, 'time'); return; }
    // what the chick stands on moves it, or does it in
    if (isRiver(st.row)) {
      var c = carrier(st, st.row, st.x);
      if (!c) { die(st, 'water'); return; }
      st.x += LANES[st.row].dir * LANES[st.row].speed * speedUp(st.level) * dt;
      if (st.x < -0.45 || st.x > COLS - 0.55) { die(st, 'swept'); return; }
      if (!carrier(st, st.row, st.x)) { die(st, 'water'); return; }
    } else if (isRoad(st.row) && crash(st, st.row, st.x)) die(st, 'car');
  }

  var Engine = { COLS: COLS, ROWS: ROWS, TILE: TILE, LANES: LANES, NESTS: NESTS, START_ROW: START_ROW, MEDIAN_ROW: MEDIAN_ROW, GOAL_ROW: GOAL_ROW, LIVES: LIVES, TIME_LIMIT: TIME_LIMIT, TURTLE_CYCLE: TURTLE_CYCLE, TURTLE_DIVE: TURTLE_DIVE,
    createState: createState, step: step, hop: hop, objectsOf: objectsOf, carrier: carrier, crash: crash, isRiver: isRiver, isRoad: isRoad, speedUp: speedUp, laneLoop: laneLoop, NEST_POINTS: NEST_POINTS, ROW_POINTS: ROW_POINTS, respawn: respawn };
  root.CrossingEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, Kit = root.PixelKit, $ = Play.$, Tx = Play.T;
  var BEST_KEY = 'zimi.games.crossing.best', CHROME_PX = 190, MAX_SCALE = 3, SWIPE_PX = 18;
  Play.applyTheme();
  var W_PX = COLS * TILE, H_PX = ROWS * TILE;
  var els = { cv: $('cr-screen'), score: $('cr-score'), best: $('cr-best'), lives: $('cr-lives'), level: $('cr-level'), msg: $('cr-msg'), pause: $('cr-pause'), newBtn: $('cr-new') };
  var st = createState(1), ctx, reduced = Play.reducedMotion();

  // Leaving and coming back keeps the game: paused where it was, or at its end sheet.
  var page = Play.arcadePage({
    els: els, bestKey: BEST_KEY, ready: { touch: 'crossing.readyTouch', keys: 'crossing.readyKeys' }, state: function () { return st; }, draw: draw, alwaysBest: true, endSaved: true, resumeOnStage: true,
    layout: function () { ctx = Kit.fit(els.cv, W_PX, H_PX, CHROME_PX, MAX_SCALE).ctx; draw(); },
    pad: { dirs: ['left', 'right', 'up', 'down'], on: function (name, down) { if (down && page.mode === 'playing') hop(st, name); }, swipe: false },
    idle: function () { st = createState(1); },
    newRun: function () { st = createState(1); },
    snapshot: function () { return st; },
    restore: function (saved) {
      if (!saved.nests) return false;
      st = saved; st.rng = mulberry(Math.floor(Math.random() * 4294967296));
    }
  });
  var status = page.status;

  // ── art ──
  var PAL = { k: '#3a2a10', y: '#ffd84a', Y: '#fff0a0', o: '#f08a24', w: '#ffffff', e: '#1b1b1d' };
  var CHICK = ['....kkkk....', '...kyyyyk...', '..kyYYyyyk..', '..kyYyyyyk..', '.kyyyyyyyyk.', '.kyeyyyyeyk.', '.kyyyooyyyk.', '.kyyyyyyyyk.', '..kyyyyyyk..', '..kyyyyyyk..', '...kkkkkk...', '...ko..ok...'];
  var chick = null;
  function buildArt() { chick = Kit.sprite(CHICK, PAL); }
  function rect(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); }
  var ROAD_COLORS = { car: ['#e5484d', '#3b82f6', '#f5a524', '#34c3d6', '#8b5cf6'], truck: ['#6b7280'], bus: ['#f5c518'] };
  function drawVehicle(o, row, i) {
    var x = Math.round(o.x * TILE), w = o.len * TILE, y = row * TILE, col = ROAD_COLORS[o.kind][(row + i) % ROAD_COLORS[o.kind].length], dir = LANES[row].dir;
    rect(x + 1, y + 3, w - 2, 10, col); rect(x + 1, y + 3, w - 2, 1, 'rgba(255,255,255,0.35)');
    rect(x + 2, y + 13, 3, 2, '#1b1b1d'); rect(x + w - 5, y + 13, 3, 2, '#1b1b1d');
    // windows near the front
    var wx = dir > 0 ? x + w - 7 : x + 3;
    if (o.kind === 'car') rect(x + (dir > 0 ? w - 7 : 3), y + 5, 4, 4, '#cfe8ff');
    else { rect(wx, y + 5, 4, 4, '#cfe8ff'); if (o.kind === 'bus') for (var k = 3; k < w - 8; k += 6) rect(x + (dir > 0 ? k : k + 6), y + 5, 4, 4, '#cfe8ff'); }
    rect(dir > 0 ? x + w - 2 : x + 1, y + 10, 1, 2, '#fff7b0');
  }
  function drawLog(o, row) {
    var x = Math.round(o.x * TILE), w = o.len * TILE, y = row * TILE;
    rect(x, y + 2, w, 12, '#8a5a35'); rect(x, y + 2, w, 2, '#a8743f'); rect(x, y + 12, w, 2, '#6b4325');
    rect(x, y + 4, 2, 8, '#d8b48a'); rect(x + w - 2, y + 4, 2, 8, '#d8b48a');
    for (var k = 8; k < w - 8; k += 11) { rect(x + k, y + 6, 4, 1, '#6b4325'); rect(x + k + 3, y + 9, 3, 1, '#6b4325'); }
  }
  function drawTurtles(o, row) {
    for (var i = 0; i < o.len; i++) {
      var x = Math.round(o.x * TILE) + i * TILE, y = row * TILE;
      if (o.under) { rect(x + 3, y + 8, 10, 3, 'rgba(255,255,255,0.35)'); rect(x + 5, y + 9, 6, 1, 'rgba(255,255,255,0.55)'); continue; }
      var flash = o.warn && Math.floor(st.anim * 8) % 2 === 0 && !reduced, shell = flash ? '#8fbf6a' : '#2f9e6a';
      rect(x + 2, y + 3, 12, 10, shell); rect(x + 3, y + 2, 10, 12, shell); rect(x + 5, y + 4, 6, 6, flash ? '#b7d98e' : '#58c78d');
      rect(x + 7, y + 5, 2, 4, shell); rect(x + 12, y + 6, 3, 3, '#7ccc9a'); rect(x + 14, y + 7, 1, 1, '#1b1b1d');
      rect(x + 3, y + 12, 2, 2, '#7ccc9a'); rect(x + 11, y + 12, 2, 2, '#7ccc9a');
    }
  }
  function drawBoard() {
    var r;
    rect(0, 0, W_PX, H_PX, '#1b3a2a');
    // the goal strip: hedge with five nests
    rect(0, 0, W_PX, TILE, '#2e7d4f');
    for (var c = 0; c < COLS; c++) { rect(c * TILE + 1, 3, 3, 3, '#4caf72'); rect(c * TILE + 9, 9, 3, 3, '#1f6a3f'); }
    NESTS.forEach(function (nc, i) { rect(nc * TILE, 0, TILE, TILE, '#6a4a2a'); rect(nc * TILE + 2, 2, TILE - 4, TILE - 4, '#2c1d10'); rect(nc * TILE + 1, TILE - 3, TILE - 2, 2, '#b88a54'); });
    for (r = 1; r <= 5; r++) { rect(0, r * TILE, W_PX, TILE, r % 2 ? '#1e66b0' : '#1b5da3'); for (var k = 0; k < 5; k++) rect(((k * 37 + r * 19 + Math.floor(st.anim * (reduced ? 0 : 6) * (r % 2 ? 1 : -1))) % W_PX + W_PX) % W_PX, r * TILE + 4 + (k % 3) * 4, 5, 1, 'rgba(255,255,255,0.2)'); }
    rect(0, MEDIAN_ROW * TILE, W_PX, TILE, '#4f9d5b'); rect(0, MEDIAN_ROW * TILE, W_PX, 2, '#7ac488');
    for (r = 7; r <= 11; r++) { rect(0, r * TILE, W_PX, TILE, '#3a3f4b'); if (r < 11) for (var d = 0; d < COLS * 2; d++) rect(d * 9 + 2, (r + 1) * TILE - 1, 5, 1, '#9aa1b0'); }
    rect(0, START_ROW * TILE, W_PX, TILE, '#4f9d5b'); rect(0, START_ROW * TILE, W_PX, 2, '#7ac488');
    for (var f = 0; f < 6; f++) { rect(f * 31 + 6, START_ROW * TILE + 7, 1, 3, '#2f7a41'); rect(f * 31 + 5, START_ROW * TILE + 6, 3, 1, '#f0a0c0'); }
  }
  function drawChick(x, y, face, lift) {
    ctx.save();
    ctx.translate(Math.round(x * TILE + TILE / 2), Math.round(y * TILE + TILE / 2 - lift));
    if (face === 'left') ctx.scale(-1, 1);
    ctx.drawImage(chick, -6, -6);
    ctx.restore();
  }
  function draw() {
    if (!ctx) return;
    drawBoard();
    var row, i, objs;
    for (row = 1; row <= 11; row++) {
      objs = objectsOf(st, row);
      objs.forEach(function (o, j) {
        if (o.kind === 'log') drawLog(o, row); else if (o.kind === 'turtle') drawTurtles(o, row); else drawVehicle(o, row, j);
      });
    }
    for (i = 0; i < NESTS.length; i++) if (st.nests[i]) { ctx.save(); ctx.translate(NESTS[i] * TILE + TILE / 2, TILE / 2); ctx.drawImage(chick, -6, -6); ctx.restore(); }
    // the chick
    if (st.status === 'dying') {
      var cx = Math.round(st.x * TILE + TILE / 2), cy = st.row * TILE + TILE / 2;
      if (st.why === 'car') { rect(cx - 7, cy + 2, 14, 4, '#ffd84a'); rect(cx - 5, cy + 3, 10, 2, '#fff0a0'); rect(cx - 2, cy + 4, 4, 1, '#f08a24'); }
      else if (st.why === 'water' || st.why === 'swept') { var rr = 3 + Math.floor((1 - st.statusT / DEATH_S) * 8); rect(cx - rr, cy, rr * 2, 1, 'rgba(255,255,255,0.8)'); rect(cx - rr + 2, cy + 3, rr * 2 - 4, 1, 'rgba(255,255,255,0.5)'); rect(cx - 1, cy - 3, 2, 3, '#ffd84a'); }
      else drawChick(st.x, st.row, st.face, 0);
    } else if (st.status === 'playing' || st.status === 'cleared') {
      var lift = reduced ? 0 : Math.sin(Math.min(1, st.hopT) * Math.PI) * 4;
      drawChick(st.x, st.row, st.face, lift);
    }
    // the clock: a bar along the foot of the start strip
    var frac = Math.max(0, st.left / TIME_LIMIT);
    rect(0, H_PX - 3, W_PX, 3, '#1b3a2a'); rect(2, H_PX - 2, Math.round((W_PX - 4) * frac), 1, frac > 0.3 ? '#9be0ad' : '#ff7b72');
    if (st.status === 'cleared') Kit.textCentered(ctx, Tx('crossing.allHome'), W_PX / 2, 6 * TILE + 5, '#ffffff', 2);
  }

  // ── flow ──
  page.run(function (dt) {
    step(st, dt);
    st.events.forEach(function (e) {
      if (e.name === 'die') status.reason(Tx('crossing.die.' + e.data));
      else if (e.name === 'nest') status.reason(Tx('crossing.nest', { n: st.nests.filter(Boolean).length }));
      else if (e.name === 'life') status.reason(Tx('crossing.life'));
      else if (e.name === 'clear') status.reason(Tx('crossing.clear'));
      else if (e.name === 'over') page.finish();
    });
    st.events.length = 0;
    if (st.status === 'cleared' && st.statusT <= 0 && page.mode === 'playing') nextLevel();
  });

  function nextLevel() { st = createState(st.level + 1, undefined, { score: st.score, lives: st.lives, nextLife: st.nextLife }); status.reason(Tx('crossing.level', { n: st.level })); }

  var KEYDIR = Object.assign({ ' ': 'up' }, root.ZimiUtil.DIR_KEYS);
  Kit.keyboard(KEYDIR, function (a) { if (page.mode === 'playing') hop(st, a); }, function () { return !!document.querySelector('.ar-sheet:not([hidden])') || page.mode !== 'playing'; });
  // a swipe hops that way; a tap on the screen hops forward
  Play.gesture(els.cv, { up: function (g) {
    if (page.mode !== 'playing') return;
    var d = Play.swipeDir(g.dx, g.dy, SWIPE_PX);
    if (d) hop(st, d); else if (g.tap) hop(st, 'up');
  } });

  buildArt(); page.start();
  root.__crossing = { get st() { return st; }, get mode() { return page.mode; } };
})(this);
