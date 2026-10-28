/* ZimiGames: Muncher, a maze game. Our own code, mazes and art, GPL-3.0. No network, no modules.
   Eat every dot while four chasers hunt you, each in its own way. A power pellet turns them blue for a
   few seconds and they can be eaten; fruit shows up twice a maze. Three mazes, each faster than the last.
   The rules are pure functions (no DOM) so node can test them; the page draws it all at 170 x 200 pixels. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var TILE = 10;
  // # wall, . dot, o power pellet, - the house gate, P where you start (and where fruit appears).
  // Each maze is symmetrical; the house sits in the middle (rows 8 and 9, columns 6 to 10).
  var MAZES = [
    { name: 'Orchard', rows: [
      '#################',
      '#o.....#.#.....o#',
      '#.##.#.#.#.#.##.#',
      '#.##.#.....#.##.#',
      '#...............#',
      '#.##.#.###.#.##.#',
      '#....#.....#....#',
      '####.###-###.####',
      '####.#     #.####',
      '    .#     #.    ',
      '####.#######.####',
      '####.#.###.#.####',
      '#.......P.......#',
      '#.##.##.#.##.##.#',
      '#o.#.........#.o#',
      '##.#.#.###.#.#.##',
      '#....#.....#....#',
      '#.#####.#.#####.#',
      '#...............#',
      '#################'
    ] },
    { name: 'Cellar', rows: [
      '#################',
      '#o.............o#',
      '#.###.##.##.###.#',
      '#...............#',
      '#.##.#.#.#.#.##.#',
      '#....#.#.#.#....#',
      '####.#.....#.####',
      '####.###-###.####',
      '####.#     #.####',
      '    .#     #.    ',
      '####.#######.####',
      '####.# ### #.####',
      '#.......P.......#',
      '#.##.###.###.##.#',
      '#o.#.........#.o#',
      '##.#.#.#.#.#.#.##',
      '#....#.#.#.#....#',
      '#.######.######.#',
      '#...............#',
      '#################'
    ] },
    { name: 'Gardens', rows: [
      '#################',
      '#...............#',
      '#.##.###.###.##.#',
      '#o#...........#o#',
      '#.#.##.#.#.##.#.#',
      '#.....##.##.....#',
      '###...........###',
      '####.###-###.####',
      '####.#     #.####',
      '    .#     #.    ',
      '####.#######.####',
      '####.#.###.#.####',
      '#......#P#......#',
      '#.####.#.#.####.#',
      '#.....o#.#o.....#',
      '#.##.###.###.##.#',
      '#.#....#.#....#.#',
      '#.#.##.....##.#.#',
      '#...............#',
      '#################'
    ] }
  ];
  var UP = { dx: 0, dy: -1 }, LEFT = { dx: -1, dy: 0 }, DOWN = { dx: 0, dy: 1 }, RIGHT = { dx: 1, dy: 0 };
  var DIRS = [UP, LEFT, DOWN, RIGHT];   // the order that breaks a tie between equally good turns
  var GATE = { x: 8, y: 7 }, OUTSIDE = { x: 8, y: 6 }, HOUSE = { x: 8, y: 8 };
  var KINDS = ['rusher', 'ambusher', 'shy', 'drifter'];
  var CORNERS = { rusher: [15, 0], ambusher: [1, 0], shy: [1, 19], drifter: [15, 19] };
  var PLAYER_SPEED = 6.2, CHASER_SPEED = 5.5, SCARED_SPEED = 3.2, EYES_SPEED = 12, HOUSE_SPEED = 2.2;
  var PHASES = [7, 20, 7, 20, 5, 20, 5, Infinity];   // scatter, chase, scatter, ... (seconds, before the level scales them)
  var DOT_POINTS = 10, PELLET_POINTS = 50, CHAIN = [200, 400, 800, 1600], EXTRA_LIFE = 10000;
  var FRUITS = [{ kind: 'berry', points: 100 }, { kind: 'lemon', points: 300 }, { kind: 'plum', points: 500 }];
  var FRUIT_AT = [40, 90], FRUIT_S = 9, RELEASE_S = [0, 1.5, 4.5, 8], READY_S = 1.4, DYING_S = 1.3, CLEAR_S = 1.8, LIVES = 3, CATCH_DIST = 0.62;
  var SHY_RADIUS = 8, DRIFT_CHANCE = 0.4, AHEAD = 4;

  var mulberry = root.ZimiUtil.mulberry32;

  function levelSpeed(level) { return Math.min(1.45, 1 + 0.06 * (level - 1)); }
  function scaredSeconds(level) { return Math.max(2, 7 - 0.8 * (level - 1)); }
  function phaseScale(level) { return Math.max(0.4, 1 - 0.08 * (level - 1)); }
  function mazeFor(level) { return MAZES[(level - 1) % MAZES.length]; }
  function fruitFor(level) { return FRUITS[Math.min(FRUITS.length - 1, Math.floor((level - 1) / 2) % FRUITS.length)]; }

  function wrapCol(st, c) { return ((c % st.w) + st.w) % st.w; }
  function cellAt(st, c, r) {
    if (r < 0 || r >= st.h) return '#';
    return st.grid[r][wrapCol(st, c)];
  }
  // Who may enter a tile: nobody walks through walls; only chasers leaving or going home use the gate.
  function open(st, c, r, gate) { var ch = cellAt(st, c, r); return ch !== '#' && (ch !== '-' || gate); }

  // Distances home from every tile (through the gate), so a chaser that was eaten takes the shortest way back.
  function homeMap(st) {
    var dist = [], r, c, q = [[HOUSE.x, HOUSE.y]];
    for (r = 0; r < st.h; r++) { dist.push([]); for (c = 0; c < st.w; c++) dist[r].push(-1); }
    dist[HOUSE.y][HOUSE.x] = 0;
    while (q.length) {
      var cur = q.shift();
      DIRS.forEach(function (d) {
        var nc = wrapCol(st, cur[0] + d.dx), nr = cur[1] + d.dy;
        if (nr >= 0 && nr < st.h && open(st, nc, nr, true) && dist[nr][nc] < 0) { dist[nr][nc] = dist[cur[1]][cur[0]] + 1; q.push([nc, nr]); }
      });
    }
    return dist;
  }

  function makeChasers() {
    return KINDS.map(function (k, i) {
      var out = i === 0;
      return { kind: k, x: out ? OUTSIDE.x : 7 + (i - 1), y: out ? OUTSIDE.y : HOUSE.y + 1, dx: out ? -1 : 0, dy: 0, mode: out ? 'normal' : 'house', releaseAt: RELEASE_S[i], bob: i };
    });
  }
  function resetActors(st) {
    var scale = 1 / Math.sqrt(st.level);
    st.player = { x: st.start.x, y: st.start.y, dx: 0, dy: 0, wantX: 0, wantY: 0, face: 'left', munch: 0 };
    st.chasers = makeChasers();
    st.chasers.forEach(function (c, i) { c.releaseAt = RELEASE_S[i] * scale; });
    st.since = 0; st.scared = 0; st.chain = 0; st.fruit = null;
  }

  function createState(level, seed, carry) {
    var maze = mazeFor(level), grid = maze.rows.map(function (r) { return r.split(''); }), dots = 0, start = null;
    grid.forEach(function (row, r) { row.forEach(function (ch, c) { if (ch === '.' || ch === 'o') dots++; else if (ch === 'P') { start = { x: c, y: r }; row[c] = ' '; } }); });
    var st = { level: level, mazeName: maze.name, grid: grid, w: grid[0].length, h: grid.length, start: start, dots: dots, dotsEaten: 0, score: carry ? carry.score : 0, lives: carry ? carry.lives : LIVES,
      nextLife: carry ? carry.nextLife : EXTRA_LIFE, rng: mulberry(seed === undefined ? Math.floor(Math.random() * 4294967296) : seed), time: 0, phase: 0, phaseT: 0, status: 'ready', statusT: READY_S,
      fruitsShown: 0, events: [], speed: levelSpeed(level), anim: 0 };
    st.home = homeMap(st);
    resetActors(st);
    return st;
  }
  function event(st, name, data) { st.events.push({ name: name, data: data }); }
  function addScore(st, n) { st.score += n; while (st.score >= st.nextLife) { st.lives++; st.nextLife += EXTRA_LIFE; event(st, 'life'); } }

  // ── where each chaser is headed ──
  function playerTile(st) { return { x: Math.round(st.player.x), y: Math.round(st.player.y) }; }
  function inScatter(st) { return st.phase % 2 === 0; }
  // The tile a chaser aims for. Rusher: you. Ambusher: four tiles ahead of you. Shy: you, unless it is
  // close, then its own corner. Drifter: you, but now and then it wanders (the wandering is in chooseDir).
  function chaserTarget(st, c) {
    var p = playerTile(st), corner = { x: CORNERS[c.kind][0], y: CORNERS[c.kind][1] };
    if (c.mode === 'eyes') return { x: HOUSE.x, y: HOUSE.y };
    if (inScatter(st)) return corner;
    if (c.kind === 'ambusher') return { x: p.x + st.player.dx * AHEAD, y: p.y + st.player.dy * AHEAD };
    if (c.kind === 'shy') return Math.hypot(c.x - p.x, c.y - p.y) > SHY_RADIUS ? p : corner;
    return p;
  }

  // At a tile centre: the way a chaser turns. Never straight back unless there is no other way.
  function chooseDir(st, c) {
    var cx = Math.round(c.x), cy = Math.round(c.y), gate = c.mode === 'eyes' || c.mode === 'leaving';
    var options = DIRS.filter(function (d) { return open(st, cx + d.dx, cy + d.dy, gate); });
    if (c.mode === 'eyes') {
      var best = null, bd = 1e9;
      options.forEach(function (d) { var v = st.home[cy + d.dy][wrapCol(st, cx + d.dx)]; if (v >= 0 && v < bd) { bd = v; best = d; } });
      return best;
    }
    var fwd = options.filter(function (d) { return !(d.dx === -c.dx && d.dy === -c.dy && (c.dx || c.dy)); });
    if (!fwd.length) fwd = options;
    if (!fwd.length) return null;
    // the gate is only for leaving and going home
    fwd = fwd.filter(function (d) { return cellAt(st, cx + d.dx, cy + d.dy) !== '-'; });
    if (!fwd.length) return options[0];
    if (c.mode === 'scared' || (c.kind === 'drifter' && !inScatter(st) && st.rng() < DRIFT_CHANCE)) return fwd[Math.floor(st.rng() * fwd.length)];
    var t = chaserTarget(st, c), pick = fwd[0], pd = 1e9;
    fwd.forEach(function (d) {
      var nx = cx + d.dx, ny = cy + d.dy, dd = (nx - t.x) * (nx - t.x) + (ny - t.y) * (ny - t.y);
      if (dd < pd) { pd = dd; pick = d; }
    });
    return pick;
  }

  // Move an actor `dist` tiles, deciding its direction at every tile centre (the shared grid walker).
  function advance(st, e, dist, choose) { root.GridWalk.advance(e, dist, choose, st.w); }

  function stepPlayer(st, dt) {
    var p = st.player;
    if ((p.dx || p.dy) && p.wantX === -p.dx && p.wantY === -p.dy && (p.wantX || p.wantY)) { p.dx = -p.dx; p.dy = -p.dy; }   // turning round is allowed anywhere
    advance(st, p, PLAYER_SPEED * st.speed * dt, function (e) {
      var cx = Math.round(e.x), cy = Math.round(e.y);
      if ((p.wantX || p.wantY) && open(st, cx + p.wantX, cy + p.wantY, false)) return { dx: p.wantX, dy: p.wantY };
      if ((e.dx || e.dy) && open(st, cx + e.dx, cy + e.dy, false)) return { dx: e.dx, dy: e.dy };
      return null;
    });
    if (p.dx || p.dy) { p.munch += dt * 9; p.face = p.dx > 0 ? 'right' : p.dx < 0 ? 'left' : p.dy < 0 ? 'up' : 'down'; }
    // eat what is under you
    var tx = Math.round(p.x), ty = Math.round(p.y), tc = wrapCol(st, tx), ch = cellAt(st, tx, ty);
    if (ch === '.' || ch === 'o') {
      st.grid[ty][tc] = ' '; st.dotsEaten++;
      if (ch === 'o') {
        addScore(st, PELLET_POINTS); st.scared = scaredSeconds(st.level); st.chain = 0; event(st, 'pellet');
        st.chasers.forEach(function (c) { if (c.mode === 'normal') { c.mode = 'scared'; c.dx = -c.dx; c.dy = -c.dy; } });
      } else { addScore(st, DOT_POINTS); event(st, 'dot'); }
      if (FRUIT_AT.indexOf(st.dotsEaten) >= 0) { st.fruit = { x: st.start.x, y: st.start.y, left: FRUIT_S, kind: fruitFor(st.level) }; st.fruitsShown++; }
    }
    if (st.fruit && Math.abs(p.x - st.fruit.x) < 0.6 && Math.abs(p.y - st.fruit.y) < 0.6) { addScore(st, st.fruit.kind.points); event(st, 'fruit', st.fruit.kind.points); st.fruit = null; }
    if (st.dotsEaten >= st.dots) { st.status = 'cleared'; st.statusT = CLEAR_S; event(st, 'clear'); }
  }

  function stepChaser(st, c, dt) {
    var sp = CHASER_SPEED * st.speed;
    if (c.mode === 'house') {
      c.bob += dt * 3; c.y = HOUSE.y + 0.5 + Math.sin(c.bob) * 0.35; c.dx = 0; c.dy = 0;
      if (st.since >= c.releaseAt) { c.mode = 'leaving'; c.y = HOUSE.y; c.x = Math.round(c.x); }
      return;
    }
    if (c.mode === 'leaving') {
      advance(st, c, HOUSE_SPEED * dt * 1.6, function (e) {
        var cx = Math.round(e.x), cy = Math.round(e.y);
        if (cy === OUTSIDE.y) { c.mode = st.scared > 0 ? 'scared' : 'normal'; return e.x < 8 ? RIGHT : LEFT; }
        if (cx < GATE.x) return RIGHT; if (cx > GATE.x) return LEFT;
        return UP;
      });
      return;
    }
    if (c.mode === 'eyes') {
      advance(st, c, EYES_SPEED * dt, function (e) { return chooseDir(st, c); });
      if (Math.round(c.x) === HOUSE.x && Math.round(c.y) === HOUSE.y) { c.mode = 'house'; c.y = HOUSE.y + 0.5; c.x = HOUSE.x; c.releaseAt = st.since + 0.8; c.bob = 0; }
      return;
    }
    if (c.mode === 'scared') sp = SCARED_SPEED * st.speed;
    advance(st, c, sp * dt, function (e) { return chooseDir(st, c); });
  }

  // One tick of dt seconds. dir: the way the player wants to go ({dx, dy}) or null to keep the last wish.
  function step(st, dt, dir) {
    st.anim += dt;
    if (dir) { st.player.wantX = dir.dx; st.player.wantY = dir.dy; }
    if (st.status === 'ready') { st.statusT -= dt; if (st.statusT <= 0) st.status = 'playing'; return; }
    if (st.status === 'dying') { st.statusT -= dt; if (st.statusT <= 0) { if (st.lives <= 0) { st.status = 'over'; event(st, 'over'); } else { resetActors(st); st.status = 'ready'; st.statusT = READY_S; } } return; }
    if (st.status !== 'playing') { if (st.status === 'cleared') st.statusT -= dt; return; }
    st.time += dt; st.since += dt;
    // scatter and chase take turns (not while the chasers are blue); a change of phase turns them round
    if (st.scared > 0) { st.scared -= dt; if (st.scared <= 0) { st.scared = 0; st.chasers.forEach(function (c) { if (c.mode === 'scared') c.mode = 'normal'; }); } }
    else {
      st.phaseT += dt;
      var len = PHASES[Math.min(st.phase, PHASES.length - 1)] * phaseScale(st.level);
      if (st.phaseT >= len) { st.phase++; st.phaseT = 0; st.chasers.forEach(function (c) { if (c.mode === 'normal') { c.dx = -c.dx; c.dy = -c.dy; } }); }
    }
    stepPlayer(st, dt);
    if (st.status !== 'playing') return;
    st.chasers.forEach(function (c) { stepChaser(st, c, dt); });
    if (st.fruit) { st.fruit.left -= dt; if (st.fruit.left <= 0) st.fruit = null; }
    // caught, or catching
    for (var i = 0; i < st.chasers.length; i++) {
      var c = st.chasers[i];
      if (c.mode === 'house' || c.mode === 'leaving' || c.mode === 'eyes') continue;
      var dx = Math.abs(c.x - st.player.x), dy = Math.abs(c.y - st.player.y);
      if (dx > st.w / 2) dx = st.w - dx;
      if (Math.hypot(dx, dy) >= CATCH_DIST) continue;
      if (c.mode === 'scared') { c.mode = 'eyes'; var pts = CHAIN[Math.min(st.chain, CHAIN.length - 1)]; st.chain++; addScore(st, pts); event(st, 'eat', pts); }
      else { st.lives--; st.status = 'dying'; st.statusT = DYING_S; event(st, 'die'); return; }
    }
  }

  var Engine = { TILE: TILE, MAZES: MAZES, KINDS: KINDS, DIRS: DIRS, UP: UP, LEFT: LEFT, DOWN: DOWN, RIGHT: RIGHT, createState: createState, step: step, chaserTarget: chaserTarget, chooseDir: chooseDir,
    open: open, cellAt: cellAt, playerTile: playerTile, levelSpeed: levelSpeed, scaredSeconds: scaredSeconds, mazeFor: mazeFor, advance: advance, wrapCol: wrapCol, LIVES: LIVES, PELLET_POINTS: PELLET_POINTS, DOT_POINTS: DOT_POINTS, CHAIN: CHAIN, READY_S: READY_S,
    CORNERS: CORNERS, HOUSE: HOUSE, GATE: GATE };
  root.MuncherEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, Kit = root.PixelKit, $ = Play.$, Tx = Play.T;
  var BEST_KEY = 'zimi.games.muncher.best', CHROME_PX = 190, MAX_SCALE = 3, SWIPE_PX = 16;
  Play.applyTheme();
  var W_PX = 17 * TILE, H_PX = 20 * TILE;
  var WALLS = { Orchard: ['#1c5a3e', '#58c78d'], Cellar: ['#4a3578', '#a78bfa'], Gardens: ['#1f4f8f', '#6db3f2'] };
  var CHASER_COLOR = { rusher: '#e5484d', ambusher: '#f08ac0', shy: '#f5a524', drifter: '#34c3d6' };
  var els = { cv: $('mn-screen'), score: $('mn-score'), best: $('mn-best'), lives: $('mn-lives'), level: $('mn-level'), msg: $('mn-msg'), pause: $('mn-pause'), newBtn: $('mn-new') };
  var st = createState(1), ctx, reduced = Play.reducedMotion(), want = null;
  var NAMED = { up: UP, left: LEFT, down: DOWN, right: RIGHT };
  var KEYDIR = root.ZimiUtil.DIR_KEYS;
  function steer(d) { want = d; }

  // Leaving and coming back keeps the game: paused where it was, or at its end sheet.
  var page = Play.arcadePage({
    els: els, bestKey: BEST_KEY, ready: { touch: 'muncher.readyTouch', keys: 'muncher.readyKeys' }, state: function () { return st; }, draw: draw, alwaysBest: true, endSaved: true, resumeOnStage: true,
    layout: function () { ctx = Kit.fit(els.cv, W_PX, H_PX, CHROME_PX, MAX_SCALE).ctx; draw(); },
    pad: { dirs: ['left', 'right', 'up', 'down'], on: function (name, down) { if (down) steer(NAMED[name]); }, swipe: false },
    idle: function () { st = createState(1); want = null; },
    newRun: function () { st = createState(1); want = null; },
    release: function () { want = null; },
    snapshot: function () { return st; },
    restore: function (saved) {
      if (!saved.grid) return false;
      st = saved; st.rng = mulberry(Math.floor(Math.random() * 4294967296)); want = null;
    }
  });
  var status = page.status;

  // ── drawing ──
  function rect(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h); }
  function drawWalls() {
    var pal = WALLS[st.mazeName] || WALLS.Orchard, r, c;
    for (r = 0; r < st.h; r++) for (c = 0; c < st.w; c++) {
      var ch = st.grid[r][c];
      if (ch === '-') { rect(c * TILE, r * TILE + 4, TILE, 2, '#f08ac0'); continue; }
      if (ch !== '#') continue;
      var x = c * TILE, y = r * TILE;
      var n = cellAt(st, c, r - 1) === '#', s = cellAt(st, c, r + 1) === '#', wv = c > 0 && st.grid[r][c - 1] === '#', e = c < st.w - 1 && st.grid[r][c + 1] === '#';
      rect(x, y, TILE, TILE, pal[0]);
      // a light edge where the wall meets a path
      if (!n) rect(x, y, TILE, 1, pal[1]); if (!s) rect(x, y + TILE - 1, TILE, 1, pal[1]);
      if (!wv) rect(x, y, 1, TILE, pal[1]); if (!e) rect(x + TILE - 1, y, 1, TILE, pal[1]);
      // keep the corners round
      if (!n && !wv) rect(x, y, 1, 1, '#0b1020'); if (!n && !e) rect(x + TILE - 1, y, 1, 1, '#0b1020');
      if (!s && !wv) rect(x, y + TILE - 1, 1, 1, '#0b1020'); if (!s && !e) rect(x + TILE - 1, y + TILE - 1, 1, 1, '#0b1020');
    }
  }
  function drawDots() {
    var blink = reduced || Math.floor(st.anim * 3) % 2 === 0;
    for (var r = 0; r < st.h; r++) for (var c = 0; c < st.w; c++) {
      var ch = st.grid[r][c], x = c * TILE, y = r * TILE;
      if (ch === '.') rect(x + 4, y + 4, 2, 2, '#ffe9b0');
      else if (ch === 'o' && blink) { rect(x + 2, y + 3, 6, 4, '#ffe9b0'); rect(x + 3, y + 2, 4, 6, '#ffe9b0'); }
    }
  }
  function drawFruit() {
    if (!st.fruit) return;
    var x = st.fruit.x * TILE, y = st.fruit.y * TILE, k = st.fruit.kind.kind;
    if (k === 'berry') { rect(x + 2, y + 4, 6, 5, '#e5484d'); rect(x + 3, y + 3, 4, 7, '#e5484d'); rect(x + 4, y + 1, 1, 3, '#58c78d'); rect(x + 5, y + 1, 2, 1, '#58c78d'); rect(x + 3, y + 4, 1, 1, '#ffb3b3'); }
    else if (k === 'lemon') { rect(x + 1, y + 3, 8, 5, '#f7d23e'); rect(x + 2, y + 2, 6, 7, '#f7d23e'); rect(x + 8, y + 4, 1, 3, '#f7d23e'); rect(x + 3, y + 3, 2, 1, '#fff3a6'); }
    else { rect(x + 2, y + 3, 6, 6, '#7c4dbd'); rect(x + 3, y + 2, 4, 8, '#7c4dbd'); rect(x + 4, y + 1, 2, 2, '#58c78d'); rect(x + 3, y + 4, 1, 2, '#b794f4'); }
  }
  var BODY_ROWS = [[2, 5], [1, 7], [0, 9], [0, 9], [0, 9], [0, 9], [1, 7], [2, 5]];   // [offset, width] per row: a soft round
  function drawMuncher() {
    var p = st.player, px = Math.round(p.x * TILE + 0.5), py = Math.round(p.y * TILE + 0.5), dying = st.status === 'dying';
    function at(ox) {
      var shrink = dying ? Math.min(1, 1 - st.statusT / DYING_S) : 0;
      if (shrink >= 0.95) return;
      var rows = dying ? BODY_ROWS.filter(function (_, i) { return i / BODY_ROWS.length >= shrink * 0.9; }) : BODY_ROWS, oy = py + 1 + (BODY_ROWS.length - rows.length);
      rows.forEach(function (rw, i) { rect(ox + rw[0], oy + i, rw[1], 1, '#f2a65a'); });
      if (dying) return;
      rect(ox + 1, py + 2, 1, 1, '#ffd4a1'); rect(ox + 2, py + 1, 2, 1, '#ffd4a1');
      var look = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[p.face], ex = ox + 2 + look[0], ey = py + 3 + look[1];
      rect(ox + 2, py + 3, 2, 3, '#ffffff'); rect(ox + 5, py + 3, 2, 3, '#ffffff');
      rect(ex + (look[0] > 0 ? 1 : 0), ey + (look[1] > 0 ? 1 : 0) + 1, 1, 2, '#1b2233'); rect(ex + 3 + (look[0] > 0 ? 1 : 0), ey + (look[1] > 0 ? 1 : 0) + 1, 1, 2, '#1b2233');
      var openM = Math.floor(p.munch) % 2 === 0 && (p.dx || p.dy) && !reduced;
      rect(ox + 3, py + 7, 3, openM ? 2 : 1, '#7a3e12');
      rect(ox + 1, py + 9, 2, 1, '#7a3e12'); rect(ox + 6, py + 9, 2, 1, '#7a3e12');
    }
    at(px - 4);
    if (px < 5) at(px - 4 + W_PX); if (px > W_PX - 5) at(px - 4 - W_PX);
  }
  // A chaser is a little beetle: antennae, a round shell, six legs that shuffle.
  var BEETLE = ['.x.....x.', '..x...x..', '..ccccc..', '.chhcccc.', 'cwwcccwwc', 'cwwcccwwc', '.ccccccc.'];
  var LEGS = ['x.x.x.x.x', '.x.x.x.x.'];
  var beetleCache = {};
  function beetle(col, hi, frame) {
    var key = col + hi + frame;
    if (!beetleCache[key]) beetleCache[key] = Kit.sprite(BEETLE.concat([LEGS[frame]]), { x: col, c: col, h: hi, w: '#ffffff' }, false);
    return beetleCache[key];
  }
  function drawChaser(c) {
    var x = Math.round(c.x * TILE + 0.5) - 4, y = Math.round(c.y * TILE + 0.5) - 4;
    function body(ox) {
      var px = Math.max(-1, Math.min(1, c.dx)), py = c.dy > 0 ? 1 : 0;
      if (c.mode === 'eyes') {
        rect(ox + 1, y + 4, 2, 2, '#ffffff'); rect(ox + 6, y + 4, 2, 2, '#ffffff');
        rect(ox + 1 + (px > 0 ? 1 : 0), y + 4 + py, 1, 1, '#1b2233'); rect(ox + 6 + (px > 0 ? 1 : 0), y + 4 + py, 1, 1, '#1b2233');
        return;
      }
      var scared = c.mode === 'scared', flash = scared && st.scared < 2 && Math.floor(st.anim * 5) % 2 === 0 && !reduced;
      var col = scared ? (flash ? '#f1f3f5' : '#3b5bdb') : CHASER_COLOR[c.kind], hi = scared ? (flash ? '#d0d4da' : '#748ffc') : '#ffffff';
      var frame = reduced ? 0 : Math.floor(st.anim * 8) % 2, spr = beetle(col, hi, frame);
      ctx.drawImage(spr, ox, y);
      if (scared) {
        // dizzy: the eye whites are covered, an X for each eye and a wavy mouth
        var ink = flash ? '#c0392b' : '#1b2233';
        rect(ox + 1, y + 4, 2, 2, col); rect(ox + 6, y + 4, 2, 2, col);
        rect(ox + 1, y + 4, 1, 1, ink); rect(ox + 2, y + 5, 1, 1, ink); rect(ox + 2, y + 4, 1, 1, ink); rect(ox + 1, y + 5, 1, 1, ink);
        rect(ox + 6, y + 4, 1, 1, ink); rect(ox + 7, y + 5, 1, 1, ink); rect(ox + 7, y + 4, 1, 1, ink); rect(ox + 6, y + 5, 1, 1, ink);
        rect(ox + 2, y + 6, 5, 1, '#ffffff');
      } else {
        rect(ox + 1 + (px > 0 ? 1 : 0), y + 4 + py, 1, 1, '#1b2233'); rect(ox + 6 + (px > 0 ? 1 : 0), y + 4 + py, 1, 1, '#1b2233');
      }
    }
    body(x);
    if (x < 0) body(x + W_PX); if (x > W_PX - 9) body(x - W_PX);
  }
  function draw() {
    if (!ctx) return;
    ctx.fillStyle = '#0e0e10'; ctx.fillRect(0, 0, W_PX, H_PX);
    drawWalls(); drawDots(); drawFruit();
    if (st.status !== 'dying' || st.statusT > 0.3) st.chasers.forEach(drawChaser);
    drawMuncher();
    if (st.status === 'ready') Kit.textCentered(ctx, Tx('muncher.ready'), W_PX / 2, 11 * TILE + 2, '#ffe14d', 2);
    if (st.status === 'cleared') Kit.textCentered(ctx, Tx('muncher.clear'), W_PX / 2, 11 * TILE + 2, '#ffe14d', 2);
  }

  // ── flow ──
  page.run(function (dt) {
    step(st, dt, want);
    st.events.forEach(function (e) {
      if (e.name === 'eat') status.reason(Play.num(e.data), 1200);
      else if (e.name === 'fruit') status.reason(Tx('muncher.fruit', { n: e.data }));
      else if (e.name === 'life') status.reason(Tx('muncher.life'));
      else if (e.name === 'pellet') status.say('');
      else if (e.name === 'over') page.finish();
    });
    st.events.length = 0;
    if (st.status === 'cleared' && st.statusT <= 0 && page.mode === 'playing') nextMaze();
  });

  function nextMaze() {
    var carry = { score: st.score, lives: st.lives, nextLife: st.nextLife }, lvl = st.level + 1;
    st = createState(lvl, undefined, carry); want = null; status.reason(Tx('muncher.maze', { n: lvl }));
  }

  Kit.keyboard(KEYDIR, function (a) { steer(NAMED[a]); }, function () { return !!document.querySelector('.ar-sheet:not([hidden])') || page.mode === 'ready' || page.mode === 'over'; });
  // swipe anywhere on the maze: each flick of 16 px or more steers, and the next flick starts from where the last ended
  (function () {
    var a = null;
    els.cv.addEventListener('pointerdown', function (e) { a = { x: e.clientX, y: e.clientY, id: e.pointerId }; try { els.cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } });
    els.cv.addEventListener('pointermove', function (e) {
      if (!a || e.pointerId !== a.id) return;
      var d = Play.swipeDir(e.clientX - a.x, e.clientY - a.y, SWIPE_PX);
      if (d) { steer(NAMED[d]); a.x = e.clientX; a.y = e.clientY; }
    });
    ['pointerup', 'pointercancel'].forEach(function (n) { els.cv.addEventListener(n, function () { a = null; }); });
  })();

  page.start();
  root.__muncher = { get st() { return st; }, get mode() { return page.mode; } };
})(this);
