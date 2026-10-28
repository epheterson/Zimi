/* ZimiGames: Hopper, a side-scrolling platformer. Our own code and art, GPL-3.0. No network, no modules.
   Run, jump (hold for height), stomp the crawlers, skip the spikes, grab the coins, reach the flag.
   Six short levels, each a few rows of tiles below. The rules are pure functions (no DOM) so node can test
   them; the page below them draws everything in code at 176 x 128 pixels and shows it at a whole multiple. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var T = 16, ROWS = 8, VIEW_W = 176, VIEW_H = 128;
  var GRAVITY = 1000, RUN = 96, ACCEL = 820, AIR_ACCEL = 560, FRICTION = 900, MAX_FALL = 420;
  var JUMP_V = -330, CUT_V = JUMP_V * 0.42, SPRING_V = -430, STOMP_V = -230, STOMP_HELD_V = -310;
  var COYOTE_S = 0.1, BUFFER_S = 0.12, INVULN_S = 1.6, START_HEARTS = 3, WIN_PAUSE_S = 0.9;
  var PW = 10, PH = 13;
  var WALK_SPEED = 26, HOP_V = -230, HOP_EVERY = 1.1, HOP_SPEED = 38, FLY_RANGE = 26, FLY_BOB = 7;

  // Tiles: # ground, B brick, o coin, ^ spikes, S spring, c checkpoint, F flag, s start,
  // w crawler, j hopper-slime, f flutterer. Every level is ROWS rows of one width.
  var LEVELS = [
    { name: 'Meadow', theme: 'meadow', rows: [
      '                                                                      ',
      '                                                                      ',
      '                                                                      ',
      '        ooo        oooo                             ooo               ',
      '        BBB    ooo                      ooo         BBB          B    ',
      '  s           w           BB  w  c              w         w ooooB  F  ',
      '####################  ##################   ###########################',
      '####################  ##################   ###########################'
    ] },
    { name: 'Caves', theme: 'cave', rows: [
      '                                                                              ',
      '                                                                              ',
      '                                                                              ',
      '           oooo             ooo           ooooo         ooo     oooo          ',
      '                            BBB                                               ',
      '  s         ^^           j       c         ^^  BB  w j        w  ^^   j   F   ',
      '##################  #################  #################  ####################',
      '##################  #################  #################  ####################'
    ] },
    { name: 'Bridges', theme: 'dusk', rows: [
      '                                                                                      ',
      '                                                                                      ',
      '                           f                         f                                ',
      '                   oo            ooo                   oo            owoo             ',
      '              ooo  BB  oowo  oo  BBB  oowo         oo  BB  oowo  oo  BBBB  ooo        ',
      '  s           BBB      BBBB  BB       BBBB    c    BB      BBBB  BB        BBB     F  ',
      '############                                #####                               ######',
      '############                                #####                               ######'
    ] },
    { name: 'Springs', theme: 'sky', rows: [
      '                                                                                ',
      '           oooo                  oooooo                    ooooo                ',
      '           BBBB                     BB                     BBBBB                ',
      '                                    BB          oo                  oooo        ',
      '                                    BB          BB                              ',
      '  s    w  S           w    j  c  S  BB    w   c          S   j    w  ^^    F    ',
      '###############  ##################################   ##########################',
      '###############  ##################################   ##########################'
    ] },
    { name: 'Night', theme: 'night', rows: [
      '                                                                                                ',
      '                                                                                                ',
      '                                                  f            ooofo                            ',
      '                         oo         oooo               oooo                         ooo         ',
      '                         BB                                                         BBB         ',
      '  s     w  w        j  j          ^^ w          c  w ^ j        ^^    w       w  j      w ^^ F  ',
      '##############  #############  ##########  ################  ############  #####################',
      '##############  #############  ##########  ################  ############  #####################'
    ] },
    { name: 'Castle', theme: 'castle', rows: [
      '                                                                                                                        ',
      '                                              ooooo                                                                     ',
      '                                              BBBBB                            f                                        ',
      '                  oo                                          oooof             oo          ooooo                       ',
      '                  BB                                                            BB                                      ',
      '  s     w ^          j w      c ^^  j       S w   j       w w  ^^         c j w          w  ^^   j         w  j ^^  F   ',
      '#############  ############  ##########  ############   #############  ##############  ##############  #################',
      '#############  ############  ##########  ############   #############  ##############  ##############  #################'
    ] }
  ];

  var clamp = root.ZimiUtil.clamp;
  function tileAt(st, col, row) {
    if (col < 0 || col >= st.cols) return '#';
    if (row < 0 || row >= ROWS) return ' ';
    return st.rows[row].charAt(col);
  }
  function isSolid(ch) { return ch === '#' || ch === 'B'; }
  function solidAt(st, col, row) { return isSolid(tileAt(st, col, row)); }
  function boxHitsSolid(st, x, y, w, h) {
    var c0 = Math.floor(x / T), c1 = Math.floor((x + w - 0.001) / T), r0 = Math.floor(y / T), r1 = Math.floor((y + h - 0.001) / T), c, r;
    for (r = r0; r <= r1; r++) for (c = c0; c <= c1; c++) if (solidAt(st, c, r)) return true;
    return false;
  }
  // Move a box along one axis and stop it at the first solid tile. Returns true when it hit one.
  function moveX(st, b, dx) {
    b.x += dx;
    if (!boxHitsSolid(st, b.x, b.y, b.w, b.h)) return false;
    b.x = dx > 0 ? Math.floor((b.x + b.w) / T) * T - b.w : (Math.floor(b.x / T) + 1) * T;
    return true;
  }
  function moveY(st, b, dy) {
    b.y += dy;
    if (!boxHitsSolid(st, b.x, b.y, b.w, b.h)) return false;
    b.y = dy > 0 ? Math.floor((b.y + b.h) / T) * T - b.h : (Math.floor(b.y / T) + 1) * T;
    return true;
  }

  function findTile(rows, ch) {
    for (var r = 0; r < rows.length; r++) { var c = rows[r].indexOf(ch); if (c >= 0) return { col: c, row: r }; }
    return null;
  }
  function findStart(rows) {
    return findTile(rows, 's') || { col: 1, row: 1 };
  }
  var ENEMY_H = { w: 9, j: 9, f: 8 };
  function spawnEnemies(rows) {
    var out = [];
    rows.forEach(function (line, r) {
      line.split('').forEach(function (ch, c) {
        if (!ENEMY_H[ch]) return;
        var e = { type: ch, x: c * T + 2, y: r * T + T - ENEMY_H[ch] - (ch === 'f' ? 4 : 0), w: 12, h: ENEMY_H[ch], vx: ch === 'w' ? -WALK_SPEED : 0, vy: 0, dir: -1, alive: true, t: c * 0.37, hopT: 0.4, hops: 0, homeX: c * T + 2 };
        e.baseY = e.y;
        out.push(e);
      });
    });
    return out;
  }
  function countCoins(rows) { return rows.join('').split('o').length - 1; }
  function checkpointAt(col, row) { return { x: col * T + (T - PW) / 2, y: row * T + T - PH }; }

  // level: an index into LEVELS or a { rows } of your own (the tests use that).
  function createState(level) {
    var lv = typeof level === 'number' ? LEVELS[level] : level, rows = lv.rows, s = findStart(rows), home = checkpointAt(s.col, s.row);
    var st = { rows: rows, cols: rows[0].length, index: typeof level === 'number' ? level : -1, theme: lv.theme, name: lv.name,
      x: home.x, y: home.y, w: PW, h: PH, vx: 0, vy: 0, onGround: false, jumping: false, jumpPrev: false,
      coyote: 0, buffer: 0, facing: 1, inv: 0, hearts: START_HEARTS, coins: 0, totalCoins: countCoins(rows), taken: {},
      checkpoint: home, flag: findTile(rows, 'F'), enemies: spawnEnemies(rows), status: 'playing', time: 0, winT: 0, events: [], camX: 0, anim: 0 };
    st.camX = clamp(st.x - VIEW_W / 2, 0, st.cols * T - VIEW_W);
    return st;
  }
  function event(st, name, data) { st.events.push({ name: name, data: data }); }

  function hurt(st, why) {
    if (st.inv > 0 || st.status !== 'playing') return;
    st.hearts--; event(st, 'hurt', why);
    if (st.hearts <= 0) { st.status = 'over'; event(st, 'over'); return; }
    st.x = st.checkpoint.x; st.y = st.checkpoint.y; st.vx = 0; st.vy = 0; st.inv = INVULN_S; st.coyote = 0; st.buffer = 0;
  }

  function stepEnemy(st, e, dt) {
    if (e.type === 'f') {
      e.t += dt; e.x = e.homeX + Math.sin(e.t * 1.3) * FLY_RANGE; e.y = e.baseY + Math.sin(e.t * 2.6) * FLY_BOB; e.dir = Math.cos(e.t * 1.3) >= 0 ? 1 : -1;
      return;
    }
    var b = { x: e.x, y: e.y, w: e.w, h: e.h }, grounded = false;
    e.vy = Math.min(MAX_FALL, e.vy + GRAVITY * dt);
    var hit = moveX(st, b, e.vx * dt);
    if (e.type === 'w') {
      // a crawler turns at a wall and at the edge of its ledge
      var ahead = e.vx > 0 ? b.x + b.w + 1 : b.x - 1;
      var ledge = !solidAt(st, Math.floor(ahead / T), Math.floor((b.y + b.h + 1) / T));
      if (hit || ledge) { e.vx = -e.vx; e.dir = e.vx > 0 ? 1 : -1; }
    } else if (hit) { e.vx = -e.vx; e.dir = -e.dir; }
    e.x = b.x;
    if (moveY(st, b, e.vy * dt)) { if (e.vy > 0) grounded = true; e.vy = 0; }
    e.y = b.y;
    if (e.type === 'j' && grounded) {
      e.vx = 0; e.hopT -= dt;
      if (e.hopT <= 0) { e.vy = HOP_V; e.vx = e.dir * HOP_SPEED; e.hopT = HOP_EVERY; e.hops++; if (e.hops % 3 === 0) e.dir = -e.dir; }
    }
  }

  // One tick of dt seconds. input: { left, right, jump } (true while held).
  function step(st, dt, input) {
    if (st.status === 'won') { st.winT += dt; return; }
    if (st.status !== 'playing') return;
    st.time += dt; st.anim += dt;
    st.inv = Math.max(0, st.inv - dt); st.coyote -= dt; st.buffer -= dt;
    if (input.jump && !st.jumpPrev) st.buffer = BUFFER_S;
    st.jumpPrev = !!input.jump;

    var dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (dir) st.facing = dir;
    var acc = st.onGround ? ACCEL : AIR_ACCEL;
    if (dir) st.vx += dir * acc * dt;
    else if (st.vx !== 0) { var f = FRICTION * dt; st.vx = Math.abs(st.vx) <= f ? 0 : st.vx - Math.sign(st.vx) * f; }
    st.vx = clamp(st.vx, -RUN, RUN);

    if (st.buffer > 0 && st.coyote > 0) { st.vy = JUMP_V; st.buffer = 0; st.coyote = 0; st.jumping = true; st.onGround = false; event(st, 'jump'); }
    // Let go of jump while rising and the climb is cut short: a tap is a hop, a hold is a full jump.
    if (!input.jump && st.jumping && st.vy < CUT_V) st.vy = CUT_V;
    if (st.vy >= 0) st.jumping = false;
    st.vy = Math.min(MAX_FALL, st.vy + GRAVITY * dt);

    var box = { x: st.x, y: st.y, w: st.w, h: st.h };
    if (moveX(st, box, st.vx * dt)) st.vx = 0;
    var hitY = moveY(st, box, st.vy * dt);
    st.onGround = false;
    if (hitY) { if (st.vy > 0) { st.onGround = true; st.coyote = COYOTE_S; st.jumping = false; } st.vy = 0; }
    st.x = box.x; st.y = box.y;

    // the tiles the body touches
    var c0 = Math.floor(st.x / T), c1 = Math.floor((st.x + st.w - 0.001) / T), r0 = Math.floor(st.y / T), r1 = Math.floor((st.y + st.h - 0.001) / T), c, r;
    for (r = r0; r <= r1; r++) for (c = c0; c <= c1; c++) {
      var ch = tileAt(st, c, r), key = c + ',' + r;
      if (ch === 'o' && !st.taken[key]) { st.taken[key] = true; st.coins++; event(st, 'coin'); }
      else if (ch === '^' && st.y + st.h > r * T + T * 0.5) hurt(st, 'spikes');
      else if (ch === 'c' && st.checkpoint.x !== checkpointAt(c, r).x) { st.checkpoint = checkpointAt(c, r); event(st, 'checkpoint'); }
      else if (ch === 'S' && st.vy >= 0 && st.y + st.h > r * T + T * 0.4) { st.vy = SPRING_V; st.jumping = false; st.onGround = false; event(st, 'spring'); }
    }
    // The goal flag is a pole as tall as the screen: you cannot jump over it.
    var fl = st.flag;
    if (fl && st.x + st.w > fl.col * T + 5 && st.x < fl.col * T + 11 && st.y < (fl.row + 1) * T) { st.status = 'won'; event(st, 'win'); return; }
    if (st.status === 'playing' && st.y > ROWS * T + 24) hurt(st, 'fell');

    // crawlers, slimes and flutterers
    st.enemies.forEach(function (e) {
      if (!e.alive || st.status !== 'playing') return;
      stepEnemy(st, e, dt);
      var ox = st.x < e.x + e.w - 1 && st.x + st.w > e.x + 1, oy = st.y < e.y + e.h && st.y + st.h > e.y;
      if (!ox || !oy) return;
      var from = st.y + st.h - Math.max(0, st.vy) * dt;
      if (st.vy > 0 && from <= e.y + 5) { e.alive = false; st.vy = input.jump ? STOMP_HELD_V : STOMP_V; st.jumping = !!input.jump; st.coyote = 0; event(st, 'stomp', e.type); }
      else hurt(st, 'enemy');
    });

    // the camera leads a little the way you face and eases there
    var target = clamp(st.x + st.w / 2 - VIEW_W / 2 + st.facing * 16, 0, st.cols * T - VIEW_W);
    st.camX += (target - st.camX) * Math.min(1, dt * 5);
  }

  var Engine = { T: T, ROWS: ROWS, VIEW_W: VIEW_W, VIEW_H: VIEW_H, LEVELS: LEVELS, createState: createState, step: step, tileAt: tileAt, solidAt: solidAt, moveX: moveX, moveY: moveY, isSolid: isSolid,
    GRAVITY: GRAVITY, RUN: RUN, JUMP_V: JUMP_V, COYOTE_S: COYOTE_S, BUFFER_S: BUFFER_S, PW: PW, PH: PH, START_HEARTS: START_HEARTS, WIN_PAUSE_S: WIN_PAUSE_S };
  root.HopperEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, Kit = root.PixelKit, $ = Play.$, Tx = Play.T;
  var SAVE_KEY = 'zimi.games.hopper', CHROME_PX = 190, MAX_SCALE = 4, READY_ARM_MS = 650;
  Play.applyTheme();

  var THEMES = {
    meadow: { sky: ['#6fbdf0', '#9ad6f6', '#c8ecfb'], far: '#92cf9d', near: '#6bb97a', grass: '#46ad4f', grassHi: '#7ad36a', dirt: '#8a5a35', dirt2: '#6f4528', brick: '#c46a3c', brick2: '#8f4524', stars: false },
    cave: { sky: ['#17132b', '#211a3d', '#2b2250'], far: '#2c2748', near: '#383160', grass: '#4f9a86', grassHi: '#7bd0b4', dirt: '#4b4159', dirt2: '#3a3246', brick: '#6a5a8a', brick2: '#4a3d66', stars: true },
    dusk: { sky: ['#8b5aa8', '#e8765f', '#f4b062'], far: '#a35a8a', near: '#7d4379', grass: '#c4722e', grassHi: '#f0a24c', dirt: '#6e3f44', dirt2: '#55313a', brick: '#d58a4a', brick2: '#98562c', stars: false },
    sky: { sky: ['#58aeee', '#86cdf5', '#d3efff'], far: '#e9f6ff', near: '#bde1f8', grass: '#6cc24a', grassHi: '#a4ea7c', dirt: '#9a7448', dirt2: '#7a5a38', brick: '#e0a14a', brick2: '#a8742a', stars: false },
    night: { sky: ['#080c28', '#121846', '#1d2760'], far: '#182050', near: '#222c66', grass: '#2e9a72', grassHi: '#58d0a0', dirt: '#3a3f6a', dirt2: '#2c3054', brick: '#5a62a6', brick2: '#3c4278', stars: true },
    castle: { sky: ['#241d2b', '#352a38', '#463544'], far: '#372c3c', near: '#463a4e', grass: '#9aa0ac', grassHi: '#c8ccd6', dirt: '#5d5c69', dirt2: '#4a4955', brick: '#7c7a8c', brick2: '#56546a', stars: false }
  };
  var CHAR_PAL = { k: '#1b2233', t: '#35b6a4', l: '#e9f7f1', w: '#ffffff', e: '#1b2233', n: '#f2829a' };
  var HOPPER = {
    stand: ['..kk....kk..', '.ktk....ktk.', '.ktk....ktk.', '.kttkkkkttk.', 'kttttttttttk', 'ktwekttwektk', 'kttttttttttk', 'kttttnnttttk', 'kttllllllttk', '.ktllllllltk', '.ktllllllltk', '.kttllllttk.', '.kkkkkkkkkk.', '..kk....kk..'],
    runA: ['..kk....kk..', '.ktk....ktk.', '.ktk....ktk.', '.kttkkkkttk.', 'kttttttttttk', 'ktwekttwektk', 'kttttttttttk', 'kttttnnttttk', 'kttllllllttk', '.ktllllllltk', '.ktllllllltk', '.kttllllttk.', '.kkkkkkkkkk.', 'kk........kk'],
    runB: ['..kk....kk..', '.ktk....ktk.', '.ktk....ktk.', '.kttkkkkttk.', 'kttttttttttk', 'ktwekttwektk', 'kttttttttttk', 'kttttnnttttk', 'kttllllllttk', '.ktllllllltk', '.ktllllllltk', '.kttllllttk.', '.kkkkkkkkkk.', '...kk..kk...'],
    jump: ['.kk......kk.', '.ktk....ktk.', '.ktk....ktk.', '.kttkkkkttk.', 'kttttttttttk', 'ktwekttwektk', 'kttttttttttk', 'kttttnnttttk', 'kttllllllttk', '.ktllllllltk', '.kttllllttk.', '.kkkkkkkkkk.', '.kk......kk.', '............']
  };
  var CRAWLER_PAL = { k: '#2a1a1f', r: '#d9534f', h: '#f28b82', y: '#f3d9a4', w: '#ffffff', e: '#2a1a1f' };
  var CRAWLER = [
    ['...kkkkkk...', '..krrrrrrk..', '.krrhhrrrrk.', 'krrhrrrrrrrk', 'krrrrrrrrrrk', 'kkkkkkkkkkkk', '.kywekkwyek.', '.kyyyyyyyyk.', '..kk....kk..'],
    ['...kkkkkk...', '..krrrrrrk..', '.krrhhrrrrk.', 'krrhrrrrrrrk', 'krrrrrrrrrrk', 'kkkkkkkkkkkk', '.kywekkwyek.', '.kyyyyyyyyk.', '.kk......kk.']
  ];
  var SLIME_PAL = { k: '#2b1a45', p: '#8a55c9', h: '#b896e8', w: '#ffffff', e: '#2b1a45' };
  var SLIME = [
    ['....kkkk....', '..kkppppkk..', '.kphhpppppk.', '.kpwepwepppk', 'kppppppppppk', 'kppppppppppk', 'kkkkkkkkkkkk'],
    ['............', '...kkkkkk...', '.kkppppppkk.', 'kphhpppppppk', 'kpwepwepppwk', 'kppppppppppk', 'kkkkkkkkkkkk']
  ];
  var FLUTTER_PAL = { k: '#23161f', m: '#e8a13a', h: '#ffd27a', b: '#4a2a3a', e: '#ffffff' };
  var FLUTTER = [
    ['kk........kk', 'kmk......kmk', 'kmmk.bb.kmmk', '.kmmkbebkmmk', '..kmmkbbkmk.', '...kkkbbkk..', '............', '............'],
    ['............', '............', '..kk.bb.kk..', '.kmmkbebkmmk', 'kmmmmkbbkmmk', 'kmhmk.bb.kmk', '.kkk......kk', '............']
  ];
  var sprites = null;
  function buildSprites() {
    sprites = { hop: {}, crawl: CRAWLER.map(function (r) { return Kit.sprites(r, CRAWLER_PAL); }), slime: SLIME.map(function (r) { return Kit.sprites(r, SLIME_PAL); }), fly: FLUTTER.map(function (r) { return Kit.sprites(r, FLUTTER_PAL); }) };
    Object.keys(HOPPER).forEach(function (k) { sprites.hop[k] = Kit.sprites(HOPPER[k], CHAR_PAL); });
  }

  var els = { cv: $('hp-screen'), coins: $('hp-coins'), hearts: $('hp-hearts'), level: $('hp-level'), time: $('hp-time'), msg: $('hp-msg'), pause: $('hp-pause'), newBtn: $('hp-new') };
  var save = Play.load(SAVE_KEY, { unlocked: 1, coins: {} }), st = null, mode = 'ready', levelIndex = 0, ctx, scale = 2, reduced = Play.reducedMotion(), armed = null;
  var status = Play.status(els.msg);
  var keys = Kit.keyboard({ ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right', ' ': 'jump', ArrowUp: 'jump', w: 'jump', z: 'jump', x: 'jump' }, null, function () { return !!document.querySelector('.ar-sheet:not([hidden])') || mode === 'ready' || mode === 'paused'; });
  var touch = { left: false, right: false, jump: false };
  var pad = Play.pad(els.cv, { dirs: ['left', 'right'], actions: [{ name: 'jump', label: Tx('play.jump') }], on: function (name, down) { touch[name] = down; } });

  function input() { return { left: keys.held.left || touch.left, right: keys.held.right || touch.right, jump: keys.held.jump || touch.jump }; }
  function layout() { var f = Kit.fit(els.cv, VIEW_W, VIEW_H, CHROME_PX, MAX_SCALE); ctx = f.ctx; scale = f.scale; if (st) draw(); }

  function hud() {
    if (!st) return;
    els.coins.textContent = Play.num(st.coins); els.hearts.textContent = Play.num(Math.max(0, st.hearts));
    els.level.textContent = Play.num(st.index + 1); els.time.textContent = window.ZimiText ? window.ZimiText.clock(st.time) : Play.fmtClock(st.time * 1000);
  }

  // ── drawing ──
  function hash(c, r) { return ((c * 73856093) ^ (r * 19349663)) >>> 0; }
  function drawBackdrop(th) {
    var bands = th.sky, bh = VIEW_H / bands.length, i;
    for (i = 0; i < bands.length; i++) { ctx.fillStyle = bands[i]; ctx.fillRect(0, Math.floor(i * bh), VIEW_W, Math.ceil(bh) + 1); }
    var cam = Math.floor(st.camX), x;
    if (th.stars) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      for (i = 0; i < 40; i++) { var sx = ((i * 47 + 13) % 260) - ((cam * 0.1) % 260); if (sx < 0) sx += 260; if (sx < VIEW_W) ctx.fillRect(Math.floor(sx), (i * 29) % 70, 1, 1); }
    }
    ctx.fillStyle = th.far;
    for (x = 0; x < VIEW_W; x++) { var hf = 26 + Math.round(Math.sin((x + cam * 0.25) * 0.035) * 9 + Math.sin((x + cam * 0.25) * 0.09) * 4); ctx.fillRect(x, VIEW_H - hf - 16, 1, hf); }
    ctx.fillStyle = th.near;
    for (x = 0; x < VIEW_W; x++) { var hn = 14 + Math.round(Math.sin((x + cam * 0.5) * 0.05 + 2) * 7 + Math.sin((x + cam * 0.5) * 0.13) * 3); ctx.fillRect(x, VIEW_H - hn - 16, 1, hn); }
  }
  function drawTile(ch, c, r, x, y, th) {
    if (ch === '#') {
      var open = !solidAt(st, c, r - 1);
      ctx.fillStyle = th.dirt; ctx.fillRect(x, y, T, T);
      ctx.fillStyle = th.dirt2;
      var h = hash(c, r); ctx.fillRect(x + (h % 12) + 1, y + ((h >> 4) % 10) + 5, 2, 2); ctx.fillRect(x + ((h >> 8) % 12) + 1, y + ((h >> 12) % 6) + 8, 2, 1);
      if (open) { ctx.fillStyle = th.grass; ctx.fillRect(x, y, T, 4); ctx.fillStyle = th.grassHi; ctx.fillRect(x, y, T, 1); ctx.fillStyle = th.grass; ctx.fillRect(x + (h % 5) * 3, y + 4, 2, 2); ctx.fillRect(x + 4 + (h % 4) * 3, y + 4, 2, 1); }
    } else if (ch === 'B') {
      ctx.fillStyle = th.brick2; ctx.fillRect(x, y, T, T);
      ctx.fillStyle = th.brick; ctx.fillRect(x, y, T - 1, 7); ctx.fillRect(x, y + 8, 7, 7); ctx.fillRect(x + 8, y + 8, 7, 7);
    } else if (ch === 'o') {
      var phase = reduced ? 0 : Math.floor(st.anim * 7 + c) % 4, w = [8, 6, 2, 6][phase], bob = reduced ? 0 : Math.round(Math.sin(st.anim * 4 + c) * 1);
      ctx.fillStyle = '#b8860b'; ctx.fillRect(x + 4 - w / 2, y + 4 + bob, w, 8);
      if (w > 2) { ctx.fillStyle = '#ffd23f'; ctx.fillRect(x + 4 - w / 2 + 1, y + 5 + bob, w - 2, 6); ctx.fillStyle = '#fff2a8'; ctx.fillRect(x + 4 - w / 2 + 1, y + 5 + bob, 1, 3); }
    } else if (ch === '^') {
      ctx.fillStyle = '#c9d1de';
      for (var k = 0; k < 4; k++) { ctx.fillRect(x + k * 4 + 1, y + 10, 2, 6); ctx.fillRect(x + k * 4, y + 13, 4, 3); ctx.fillRect(x + k * 4 + 1, y + 8, 2, 2); }
      ctx.fillStyle = '#7d8799'; for (k = 0; k < 4; k++) ctx.fillRect(x + k * 4 + 3, y + 12, 1, 4);
    } else if (ch === 'S') {
      ctx.fillStyle = '#d9534f'; ctx.fillRect(x + 2, y + 6, 12, 3); ctx.fillStyle = '#e8e8ee'; ctx.fillRect(x + 4, y + 9, 2, 4); ctx.fillRect(x + 10, y + 9, 2, 4); ctx.fillRect(x + 6, y + 10, 4, 1);
      ctx.fillStyle = '#4a4a58'; ctx.fillRect(x + 1, y + 13, 14, 3); ctx.fillStyle = '#f28b82'; ctx.fillRect(x + 3, y + 6, 6, 1);
    } else if (ch === 'c') {
      var on = st.checkpoint.x === checkpointAt(c, r).x;
      ctx.fillStyle = '#8a8f99'; ctx.fillRect(x + 7, y + 1, 2, 15);
      ctx.fillStyle = on ? '#ffa726' : '#aab0bd'; ctx.fillRect(x + 9, on ? y + 1 : y + 5, 6, 4); ctx.fillRect(x + 9, (on ? y + 1 : y + 5) + 1, 7, 2);
      ctx.fillStyle = '#6b707c'; ctx.fillRect(x + 5, y + 14, 6, 2);
    } else if (ch === 'F') {
      ctx.fillStyle = '#e9e9ef'; ctx.fillRect(x + 7, y - 70, 2, 86); ctx.fillStyle = '#ffd23f'; ctx.fillRect(x + 6, y - 73, 4, 4);
      var wave = reduced ? 0 : Math.round(Math.sin(st.anim * 5) * 1);
      ctx.fillStyle = '#35b6a4'; ctx.fillRect(x + 9, y - 69, 11, 4 + wave); ctx.fillRect(x + 9, y - 65, 8, 4 - wave); ctx.fillRect(x + 9, y - 61, 5, 2);
      ctx.fillStyle = '#6b707c'; ctx.fillRect(x + 4, y + 14, 8, 2);
    }
  }
  function drawEnemy(e, cam) {
    var fr = Math.floor(st.anim * 5) % 2, pair;
    if (e.type === 'w') pair = sprites.crawl[reduced ? 0 : fr];
    else if (e.type === 'j') pair = sprites.slime[e.vy < 0 || e.vx !== 0 ? 1 : 0];
    else pair = sprites.fly[reduced ? 0 : Math.floor(st.anim * 8) % 2];
    var spr = e.dir > 0 ? pair.r : pair.l;
    ctx.drawImage(spr, Math.round(e.x - cam), Math.round(e.y - (spr.height - e.h)));
  }
  function drawPlayer(cam) {
    if (st.inv > 0 && !reduced && Math.floor(st.inv * 12) % 2 === 0) return;
    var k = !st.onGround ? 'jump' : Math.abs(st.vx) > 8 ? (Math.floor(st.anim * 10) % 2 ? 'runA' : 'runB') : 'stand';
    var pair = sprites.hop[k], spr = st.facing > 0 ? pair.r : pair.l;
    ctx.drawImage(spr, Math.round(st.x + st.w / 2 - 6 - cam), Math.round(st.y + st.h - 14));
  }
  function draw() {
    if (!ctx || !st) return;
    var th = THEMES[st.theme] || THEMES.meadow;
    drawBackdrop(th);
    var cam = Math.round(st.camX), c0 = Math.floor(cam / T), c1 = Math.min(st.cols - 1, c0 + Math.ceil(VIEW_W / T) + 1), r, c;
    for (r = 0; r < ROWS; r++) for (c = Math.max(0, c0); c <= c1; c++) {
      var ch = st.rows[r].charAt(c);
      if (ch === ' ' || ch === 's' || ENEMY_H[ch]) continue;
      if (ch === 'o' && st.taken[c + ',' + r]) continue;
      drawTile(ch, c, r, c * T - cam, r * T, th);
    }
    st.enemies.forEach(function (e) { if (e.alive) drawEnemy(e, cam); });
    drawPlayer(cam);
    if (st.status === 'won') Kit.textCentered(ctx, Tx('hopper.clear'), VIEW_W / 2, 48, '#ffffff', 3);
  }

  // ── flow ──
  var loop = Play.loop(function (dt) {
    step(st, dt, input());
    st.events.forEach(function (e) {
      if (e.name === 'hurt') status.reason(Tx(e.data === 'fell' ? 'hopper.fell' : 'hopper.hurt'));
      else if (e.name === 'checkpoint') status.reason(Tx('hopper.flag'));
      else if (e.name === 'stomp') status.say('');
    });
    st.events.length = 0;
    if (st.status === 'over' && mode === 'playing') finishOver();
    else if (st.status === 'won' && st.winT >= WIN_PAUSE_S && mode === 'playing') finishWin();
  }, function () { draw(); hud(); }, 60);

  function clearHeld() { keys.clear(); touch.left = touch.right = touch.jump = false; pad.release(); }
  function arm() {
    if (armed) armed.cancel();
    st = createState(levelIndex); mode = 'ready'; hud(); draw();
    armed = Play.ready({ say: status.say, target: pad.stage, start: begin });
  }
  function begin() {
    if (armed) armed.cancel();
    st = createState(levelIndex); mode = 'playing'; status.say(''); clearHeld();
    Play.pauseLabel(els.pause, false); els.pause.disabled = false; layout(); hud(); draw(); loop.start();
  }
  function pause() { if (mode !== 'playing') return; mode = 'paused'; loop.stop(); clearHeld(); Play.pauseLabel(els.pause, true); status.say(Tx('play.paused')); }
  function resume() { if (mode !== 'paused') return; mode = 'playing'; Play.pauseLabel(els.pause, false); status.say(''); loop.start(); }
  function toggle() { if (mode === 'playing') pause(); else resume(); }
  function clock() { return window.ZimiText ? window.ZimiText.clock(st.time) : Play.fmtClock(st.time * 1000); }
  var lastEnd = null;
  function over(result, stats) {
    lastEnd = { result: result, stats: stats };
    mode = 'over'; loop.stop(); els.pause.disabled = true; Play.pauseLabel(els.pause, false); clearHeld(); hud(); draw();
    ZimiShell.endSheet({ result: result, stats: stats });
    setTimeout(function () { if (mode === 'over') { st = createState(levelIndex); Play.ready({ say: status.say, target: pad.stage, start: begin }); } }, READY_ARM_MS);
  }
  function finishOver() { over('over', [[Tx('play.level'), Play.num(levelIndex + 1)], [Tx('hopper.coins'), Play.num(st.coins)]]); }
  function finishWin() {
    var key = String(levelIndex), best = save.coins[key] || 0, more = levelIndex + 1 < LEVELS.length;
    if (st.coins > best) save.coins[key] = st.coins;
    if (more && save.unlocked < levelIndex + 2) save.unlocked = levelIndex + 2;
    Play.save(SAVE_KEY, save);
    var stats = [[Tx('hopper.coins'), Play.num(st.coins) + '/' + Play.num(st.totalCoins)], [Tx('play.time'), clock()]];
    levelIndex = more ? levelIndex + 1 : 0;   // New game then starts the next level (the first again after the last)
    over('win', stats);
  }
  els.newBtn.addEventListener('click', begin);
  els.pause.addEventListener('click', toggle);
  pad.stage.addEventListener('pointerdown', function () { if (mode === 'paused') resume(); });
  Play.onHidden(pause);
  ZimiShell.game({
    inProgress: function () { return mode === 'playing' || mode === 'paused'; },
    stats: function () {
      var rows = LEVELS.slice(0, save.unlocked).map(function (lv, i) { return [Tx('hopper.level.' + lv.theme), Play.num(save.coins[String(i)] || 0)]; });
      return rows;
    },
    // The level is a choice about the game: the levels reached, in the New game pane.
    menu: function () {
      var choices = LEVELS.slice(0, save.unlocked).map(function (lv, i) { return [i, Play.num(i + 1)]; });
      return { options: [Play.optionRow(Tx('play.level'), choices, levelIndex, function (v) { levelIndex = v; })] };
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.ar-sheet:not([hidden])')) return;
    if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') { e.preventDefault(); if (mode === 'playing' || mode === 'paused') toggle(); }
  });
  window.addEventListener('resize', layout);

  buildSprites();
  levelIndex = Math.min(save.unlocked, LEVELS.length) - 1;
  layout(); arm();
  // Leaving and coming back keeps the run: it returns paused where it was, or at its end sheet.
  ZimiShell.persist({
    save: function () {
      if (mode === 'over' && lastEnd) return { level: levelIndex, end: lastEnd };
      return mode === 'playing' || mode === 'paused' ? { level: levelIndex, st: st } : null;
    },
    load: function (d) {
      if (typeof d.level !== 'number' || d.level < 0 || d.level >= LEVELS.length) return false;
      levelIndex = d.level;
      if (armed) armed.cancel();
      if (d.end) {
        st = createState(levelIndex); mode = 'over'; lastEnd = d.end; hud(); draw();
        ZimiShell.endSheet({ result: d.end.result, stats: d.end.stats });
        setTimeout(function () { if (mode === 'over') armed = Play.ready({ say: status.say, target: pad.stage, start: begin }); }, READY_ARM_MS);
        return true;
      }
      if (!d.st || !d.st.rows) return false;
      st = d.st; mode = 'paused'; els.pause.disabled = false; Play.pauseLabel(els.pause, true); status.say(Tx('play.paused')); layout(); hud(); draw();
      return true;
    }
  });
  root.__hopper = { draw: draw, get st() { return st; }, get mode() { return mode; }, get scale() { return scale; }, input: input };
})(this);
