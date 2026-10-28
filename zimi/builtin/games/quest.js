/* ZimiGames: Quest, a tiny top-down adventure. Our own code, maps and art, GPL-3.0. No network, no modules.
   Seven connected screens: find the sword, open the chests, get the key and the locked door, and face the Warden.
   Hearts, a sword that cuts bushes and slimes, and a save in this browser after every step of progress. Nobody dies
   for good: falling in a fight wakes you at the start with your hearts back and your finds kept.
   The rules are pure functions (no DOM) so node can test them; the page draws it all at 176 x 128 pixels. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var COLS = 11, ROWS = 8, TILE = 16, W = COLS * TILE, H = ROWS * TILE;
  var HERO_W = 10, HERO_H = 10, HERO_SPEED = 56, START_HEARTS = 3, MAX_HEARTS = 8;
  var SWING_S = 0.22, SWING_COOLDOWN_S = 0.32, REACH = 15, REACH_W = 14, INVULN_S = 1.0, KNOCK_PX = 14, FAINT_S = 1.5, DROP_CHANCE = 0.25;
  var SLIME = { hp: 1, speed: 20, w: 12, h: 10 }, BAT = { hp: 1, speed: 38, w: 12, h: 8 };
  var BOSS = { hp: 8, w: 28, h: 24, speed: 28, fast: 46, shotEvery: 2.3, shotFast: 1.5, shotSpeed: 58, spread: 0.38 };
  var START_SCREEN = 'D';
  var SOLID = { T: 1, R: 1, W: 1, b: 1, D: 1, N: 1, C: 1, c: 1, P: 1, p: 1, '#': 1 };

  // Screens: where they sit on the map (cx, cy), eleven by eight tiles. . grass  _ stone floor  T tree  R rock  W water
  // b bush (cut it with the sword)  # wall  C chest  P the sword's pedestal  N sign  D locked door  d open door
  // e slime  v bat  X the Warden  s where you start.
  var SCREENS = {
    A: { name: 'Forest', cx: 0, cy: 0, rows: [
      'TTTTTTTTTTT',
      'T.........T',
      'T..e..bbb.T',
      'T....bCb...',
      'T.....b.e..',
      'T..TT.bbb.T',
      'T.b.......T',
      'TTTTT.TTTTT'
    ], floor: '.', chests: { '6,3': 'container' }, signs: {} },
    B: { name: 'Lake', cx: 1, cy: 0, rows: [
      'RRRRRRRRRRR',
      'R.........R',
      'R.WWW.WWW.R',
      '...........',
      '...........',
      'R.WWW.WWW.R',
      'R....e....R',
      'RRRRR.RRRRR'
    ], floor: '.', chests: {}, signs: {} },
    C: { name: 'Gate', cx: 2, cy: 0, rows: [
      '#####D#####',
      '#_________#',
      '#_________#',
      '__________#',
      '__________#',
      '#____v____#',
      '#_________#',
      '#####_#####'
    ], floor: '_', chests: {}, signs: {} },
    D: { name: 'Meadow', cx: 0, cy: 1, rows: [
      'TTTTT.TTTTT',
      'T.........T',
      'T...N.....T',
      'T..........',
      'T.s........',
      'T.........T',
      'T.b.....b.T',
      'TTTTTTTTTTT'
    ], floor: '.', chests: {}, signs: { '4,2': 'The shrine is east. The forest is north, the lake beyond it, then the castle gate. Press the action button at signs, chests and the sword.' } },
    E: { name: 'Shrine', cx: 1, cy: 1, rows: [
      'TTTTT.TTTTT',
      'T.........T',
      'T...RRR...T',
      '....RPR....',
      '...........',
      'T.........T',
      'T.........T',
      'TTTTTTTTTTT'
    ], floor: '.', chests: {}, signs: {} },
    F: { name: 'Caves', cx: 2, cy: 1, rows: [
      '#####_#####',
      '#_________#',
      '#__v___v__#',
      '___________',
      '___________',
      '#_________#',
      '#_C_____e_#',
      '###########'
    ], floor: '_', chests: { '2,6': 'key' }, signs: {} },
    G: { name: 'Throne', cx: 2, cy: -1, rows: [
      '###########',
      '#_________#',
      '#_________#',
      '#____X____#',
      '#_________#',
      '#_________#',
      '#_________#',
      '#####d#####'
    ], floor: '_', chests: {}, signs: {} }
  };

  var HINTS = { E: 'The sword rests on the pedestal. Walk up to it and press the action button.', F: 'A chest in the corner of the cave holds the key.' };

  var mulberry = root.ZimiUtil.mulberry32;
  var clamp = root.ZimiUtil.clamp;
  function screenAt(cx, cy) { for (var k in SCREENS) if (SCREENS[k].cx === cx && SCREENS[k].cy === cy) return k; return null; }
  function flagKey(id, x, y) { return id + ':' + x + ',' + y; }

  // The tile at (tx, ty) on the current screen, with whatever has been opened, cut or taken applied.
  function tileAt(st, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return null;
    var ch = SCREENS[st.screen].rows[ty].charAt(tx), f = st.flags[flagKey(st.screen, tx, ty)];
    if (f) {
      if (ch === 'D') return 'd';
      if (ch === 'C') return 'c';
      if (ch === 'P') return 'p';
      if (ch === 'b') return '.';
    }
    if (ch === 'e' || ch === 'v' || ch === 'X' || ch === 's') return SCREENS[st.screen].floor;   // a spawn mark is just floor
    return ch;
  }
  function solidTile(ch) { return ch === null ? true : !!SOLID[ch]; }
  function boxHitsSolid(st, x, y, w, h) {
    var c0 = Math.floor(x / TILE), c1 = Math.floor((x + w - 0.001) / TILE), r0 = Math.floor(y / TILE), r1 = Math.floor((y + h - 0.001) / TILE), c, r;
    for (r = r0; r <= r1; r++) for (c = c0; c <= c1; c++) {
      var ch = tileAt(st, c, r);
      // the screen edge is open where the next screen is (the tile at the edge is walkable), a wall elsewhere
      if (ch === null) { if (!edgeOpen(st, c, r)) return true; continue; }
      if (solidTile(ch)) return true;
    }
    return false;
  }
  function edgeOpen(st, c, r) {
    var s = SCREENS[st.screen], nx = s.cx + (c < 0 ? -1 : c >= COLS ? 1 : 0), ny = s.cy + (r < 0 ? -1 : r >= ROWS ? 1 : 0);
    return !!screenAt(nx, ny);
  }

  function spawnEnemies(st) {
    var rows = SCREENS[st.screen].rows, out = [], id = 0;
    rows.forEach(function (line, r) {
      line.split('').forEach(function (ch, c) {
        if (ch === 'e') out.push({ id: id++, type: 'slime', x: c * TILE + 2, y: r * TILE + 3, w: SLIME.w, h: SLIME.h, hp: SLIME.hp, vx: 0, vy: 0, t: 0.5 + (c % 3) * 0.3, flash: 0, face: 'down' });
        else if (ch === 'v') out.push({ id: id++, type: 'bat', x: c * TILE + 2, y: r * TILE + 4, w: BAT.w, h: BAT.h, hp: BAT.hp, vx: 20, vy: 14, t: 0.4, flash: 0, face: 'down' });
        else if (ch === 'X' && !st.bossDead) out.push({ id: id++, type: 'boss', x: c * TILE - 6, y: r * TILE - 4, w: BOSS.w, h: BOSS.h, hp: BOSS.hp, vx: BOSS.speed, vy: 0, t: 1.5, flash: 0, face: 'down' });
      });
    });
    return out;
  }

  function newGame(seed) {
    var s = SCREENS[START_SCREEN], start = { x: 0, y: 0 };
    s.rows.forEach(function (line, r) { var c = line.indexOf('s'); if (c >= 0) start = { x: c * TILE + 3, y: r * TILE + 3 }; });
    return { v: 1, screen: START_SCREEN, x: start.x, y: start.y, hp: START_HEARTS, maxHp: START_HEARTS, sword: false, keys: 0, flags: {}, bossDead: false, won: false, start: start, seed: seed };
  }

  // save: an object from a previous game (see snapshot) or nothing for a new one.
  function createState(save, seed) {
    var g = save && save.v === 1 && SCREENS[save.screen] ? save : newGame(seed), st = {
      screen: g.screen, x: g.x, y: g.y, hp: g.hp, maxHp: g.maxHp, sword: !!g.sword, keys: g.keys | 0, flags: JSON.parse(JSON.stringify(g.flags || {})), bossDead: !!g.bossDead, won: !!g.won,
      start: newGame().start, rng: mulberry(seed === undefined ? Math.floor(Math.random() * 4294967296) : seed), face: 'down', swing: 0, cool: 0, inv: 0, knock: null, status: 'playing', statusT: 0,
      enemies: [], shots: [], pickups: [], events: [], hit: {}, anim: 0, w: HERO_W, h: HERO_H, moving: false, saved: 0 };
    st.hp = clamp(st.hp, 1, st.maxHp);
    st.enemies = spawnEnemies(st);
    return st;
  }
  // What goes in the save: enough to put you back exactly where you were.
  function snapshot(st) { return { v: 1, screen: st.screen, x: Math.round(st.x), y: Math.round(st.y), hp: st.hp, maxHp: st.maxHp, sword: st.sword, keys: st.keys, flags: st.flags, bossDead: st.bossDead, won: st.won }; }
  function event(st, name, data) { st.events.push({ name: name, data: data }); }

  function enterScreen(st, id, x, y) {
    st.screen = id; st.x = x; st.y = y; st.enemies = spawnEnemies(st); st.shots = []; st.pickups = st.pickups.filter(function (p) { return p.screen === id; });
    event(st, 'screen', id); event(st, 'save');
  }

  function giveHeart(st, n) { st.hp = Math.min(st.maxHp, st.hp + n); }
  function drop(st, x, y) {
    if (st.rng() < DROP_CHANCE) st.pickups.push({ type: 'heart', x: x, y: y, screen: st.screen });
  }

  // The tile just in front of the hero, for chests, signs and the sword.
  function frontTile(st) {
    var cx = st.x + st.w / 2, cy = st.y + st.h / 2, dx = st.face === 'left' ? -1 : st.face === 'right' ? 1 : 0, dy = st.face === 'up' ? -1 : st.face === 'down' ? 1 : 0;
    var tx = Math.floor((cx + dx * (st.w / 2 + 4)) / TILE), ty = Math.floor((cy + dy * (st.h / 2 + 4)) / TILE);
    return { x: tx, y: ty, ch: tileAt(st, tx, ty) };
  }

  // Press the action button: use what is in front of you (a chest, the pedestal, a sign), or swing the sword.
  function act(st) {
    if (st.status !== 'playing') return false;
    var f = frontTile(st), id = st.screen, key = flagKey(id, f.x, f.y), s = SCREENS[id];
    if (f.ch === 'P') { st.flags[key] = true; st.sword = true; event(st, 'item', 'sword'); event(st, 'save'); return true; }
    if (f.ch === 'C') {
      var what = s.chests[f.x + ',' + f.y]; st.flags[key] = true;
      if (what === 'key') { st.keys++; event(st, 'item', 'key'); }
      else if (what === 'container') { st.maxHp = Math.min(MAX_HEARTS, st.maxHp + 1); st.hp = st.maxHp; event(st, 'item', 'container'); }
      event(st, 'save'); return true;
    }
    if (f.ch === 'N') { event(st, 'sign', s.signs[f.x + ',' + f.y] || ''); return true; }
    if (!st.sword) { event(st, 'nosword'); return false; }
    if (st.cool > 0) return false;
    st.swing = SWING_S; st.cool = SWING_COOLDOWN_S; st.hit = {}; event(st, 'swing');
    return true;
  }

  // The rectangle the blade covers while swinging.
  function swordBox(st) {
    var cx = st.x + st.w / 2, cy = st.y + st.h / 2;
    if (st.face === 'up') return { x: cx - REACH_W / 2, y: st.y - REACH, w: REACH_W, h: REACH };
    if (st.face === 'down') return { x: cx - REACH_W / 2, y: st.y + st.h, w: REACH_W, h: REACH };
    if (st.face === 'left') return { x: st.x - REACH, y: cy - REACH_W / 2, w: REACH, h: REACH_W };
    return { x: st.x + st.w, y: cy - REACH_W / 2, w: REACH, h: REACH_W };
  }
  function overlap(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

  function hurtHero(st, from, dmg) {
    if (st.inv > 0 || st.status !== 'playing') return;
    st.hp -= dmg || 1; st.inv = INVULN_S; event(st, 'hurt');
    var dx = st.x + st.w / 2 - (from.x + from.w / 2), dy = st.y + st.h / 2 - (from.y + from.h / 2), d = Math.hypot(dx, dy) || 1;
    st.knock = { vx: dx / d * 120, vy: dy / d * 120, t: KNOCK_PX / 120 };
    if (st.hp <= 0) { st.hp = 0; st.status = 'fainted'; st.statusT = FAINT_S; event(st, 'faint'); }
  }

  function moveBox(st, b, dx, dy) {
    var nx = b.x + dx, ny = b.y + dy;
    if (dx && !boxHitsSolid(st, nx, b.y, b.w, b.h)) b.x = nx; else if (dx) return 'x';
    if (dy && !boxHitsSolid(st, b.x, ny, b.w, b.h)) b.y = ny; else if (dy) return 'y';
    return '';
  }
  // Walking into a locked door with a key opens it (and uses the key).
  function tryDoor(st, dx, dy) {
    var cx = st.x + st.w / 2, cy = st.y + st.h / 2, tx = Math.floor((cx + dx * (st.w / 2 + 2)) / TILE), ty = Math.floor((cy + dy * (st.h / 2 + 2)) / TILE);
    if (tileAt(st, tx, ty) === 'D') {
      if (st.keys > 0) { st.keys--; st.flags[flagKey(st.screen, tx, ty)] = true; event(st, 'door', 'open'); event(st, 'save'); }
      else event(st, 'door', 'locked');
    }
  }

  function stepEnemy(st, e, dt) {
    e.flash = Math.max(0, e.flash - dt); e.t -= dt;
    if (e.type === 'slime') {
      if (e.t <= 0) { var a = Math.floor(st.rng() * 5); e.vx = a === 0 ? -SLIME.speed : a === 1 ? SLIME.speed : 0; e.vy = a === 2 ? -SLIME.speed : a === 3 ? SLIME.speed : 0; e.t = 0.5 + st.rng() * 1.1; if (e.vx || e.vy) e.face = e.vx > 0 ? 'right' : e.vx < 0 ? 'left' : e.vy < 0 ? 'up' : 'down'; }
      if (moveBox(st, e, e.vx * dt, e.vy * dt)) { e.vx = -e.vx; e.vy = -e.vy; }
    } else if (e.type === 'bat') {
      if (e.t <= 0) { var ang = st.rng() * 6.283; e.vx = Math.cos(ang) * BAT.speed; e.vy = Math.sin(ang) * BAT.speed; e.t = 0.5 + st.rng() * 0.8; }
      var hit = moveBox(st, e, e.vx * dt, 0); if (hit) e.vx = -e.vx;
      hit = moveBox(st, e, 0, e.vy * dt); if (hit) e.vy = -e.vy;
      e.x = clamp(e.x, 0, W - e.w); e.y = clamp(e.y, 0, H - e.h);
    } else {
      var fast = e.hp <= BOSS.hp / 2;
      e.vx = (e.vx < 0 ? -1 : 1) * (fast ? BOSS.fast : BOSS.speed);
      if (moveBox(st, e, e.vx * dt, 0)) e.vx = -e.vx;
      if (e.t <= 0) {
        e.t = fast ? BOSS.shotFast : BOSS.shotEvery;
        var cx = e.x + e.w / 2, cy = e.y + e.h, base = Math.atan2(st.y + st.h / 2 - cy, st.x + st.w / 2 - cx);
        [-1, 0, 1].forEach(function (k) { var an = base + k * BOSS.spread; st.shots.push({ x: cx - 2, y: cy - 2, w: 5, h: 5, vx: Math.cos(an) * BOSS.shotSpeed, vy: Math.sin(an) * BOSS.shotSpeed }); });
        event(st, 'shoot');
      }
    }
  }

  // One tick of dt seconds. input: { dx, dy } the direction held (each -1, 0 or 1).
  function step(st, dt, input) {
    st.anim += dt;
    if (st.status === 'fainted') {
      st.statusT -= dt;
      if (st.statusT <= 0) { st.hp = st.maxHp; st.status = 'playing'; st.inv = INVULN_S; st.knock = null; st.pickups = []; enterScreen(st, START_SCREEN, st.start.x, st.start.y); event(st, 'woke'); }
      return;
    }
    if (st.status === 'won') return;
    st.inv = Math.max(0, st.inv - dt); st.cool = Math.max(0, st.cool - dt); st.swing = Math.max(0, st.swing - dt);
    // walking
    var dx = input ? input.dx : 0, dy = input ? input.dy : 0;
    st.moving = !!(dx || dy);
    if (dx || dy) st.face = dy < 0 ? 'up' : dy > 0 ? 'down' : dx < 0 ? 'left' : 'right';
    if (dx && dy) { dx *= 0.7071; dy *= 0.7071; }
    if (st.knock) {
      var k = st.knock; st.knock = k.t - dt > 0 ? { vx: k.vx, vy: k.vy, t: k.t - dt } : null;
      moveBox(st, st, k.vx * dt, 0); moveBox(st, st, 0, k.vy * dt);
    } else {
      var sp = HERO_SPEED * (st.swing > 0 ? 0.5 : 1);
      var bx = moveBox(st, st, dx * sp * dt, 0); if (bx && dx) tryDoor(st, Math.sign(dx), 0);
      var by = moveBox(st, st, 0, dy * sp * dt); if (by && dy) tryDoor(st, 0, Math.sign(dy));
    }
    // off the edge into the next screen
    var s = SCREENS[st.screen], nx = null;
    if (st.x + st.w / 2 < 0) nx = [s.cx - 1, s.cy, W - st.w - 2, st.y];
    else if (st.x + st.w / 2 > W) nx = [s.cx + 1, s.cy, 2, st.y];
    else if (st.y + st.h / 2 < 0) nx = [s.cx, s.cy - 1, st.x, H - st.h - 2];
    else if (st.y + st.h / 2 > H) nx = [s.cx, s.cy + 1, st.x, 2];
    if (nx) { var id = screenAt(nx[0], nx[1]); if (id) enterScreen(st, id, nx[2], nx[3]); else { st.x = clamp(st.x, 0, W - st.w); st.y = clamp(st.y, 0, H - st.h); } }

    // the sword
    if (st.swing > 0) {
      var sb = swordBox(st);
      var c0 = Math.floor(sb.x / TILE), c1 = Math.floor((sb.x + sb.w - 0.001) / TILE), r0 = Math.floor(sb.y / TILE), r1 = Math.floor((sb.y + sb.h - 0.001) / TILE), c, r;
      for (r = r0; r <= r1; r++) for (c = c0; c <= c1; c++) {
        if (tileAt(st, c, r) === 'b') { st.flags[flagKey(st.screen, c, r)] = true; drop(st, c * TILE + 4, r * TILE + 4); event(st, 'cut'); event(st, 'save'); }
      }
      st.enemies.forEach(function (e) {
        if (e.hp <= 0 || st.hit[e.id] || !overlap(sb, e)) return;
        st.hit[e.id] = true; e.hp--; e.flash = 0.25; event(st, 'hit', e.type);
        if (e.type !== 'boss') { var d = Math.hypot(e.x - st.x, e.y - st.y) || 1; moveBox(st, e, (e.x - st.x) / d * 6, (e.y - st.y) / d * 6); }
      });
    }
    // enemies and shots
    st.enemies.forEach(function (e) {
      if (e.hp <= 0) return;
      stepEnemy(st, e, dt);
      if (overlap(st, e) && e.hp > 0) hurtHero(st, e, 1);
    });
    st.shots = st.shots.filter(function (b) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < -6 || b.y < -6 || b.x > W + 6 || b.y > H + 6) return false;
      var ch = tileAt(st, Math.floor((b.x + 2) / TILE), Math.floor((b.y + 2) / TILE)); if (ch !== null && solidTile(ch)) return false;
      if (overlap(st, b)) { hurtHero(st, b, 1); return false; }
      return true;
    });
    var gone = st.enemies.filter(function (e) { return e.hp <= 0; });
    gone.forEach(function (e) {
      event(st, 'defeat', e.type);
      if (e.type === 'boss') { st.bossDead = true; st.pickups.push({ type: 'treasure', x: W / 2 - 4, y: H / 2 - 4, screen: st.screen }); st.shots = []; event(st, 'save'); }
      else drop(st, e.x + 2, e.y + 1);
    });
    st.enemies = st.enemies.filter(function (e) { return e.hp > 0; });
    // what is lying about
    st.pickups = st.pickups.filter(function (p) {
      if (p.screen !== st.screen) return false;
      if (!overlap(st, { x: p.x, y: p.y, w: 8, h: 8 })) return true;
      if (p.type === 'heart') { if (st.hp >= st.maxHp) return true; giveHeart(st, 1); event(st, 'item', 'heart'); }
      else if (p.type === 'treasure') { st.won = true; st.status = 'won'; event(st, 'item', 'treasure'); event(st, 'won'); event(st, 'save'); }
      return false;
    });
  }

  var Engine = { COLS: COLS, ROWS: ROWS, TILE: TILE, W: W, H: H, SCREENS: SCREENS, HINTS: HINTS, BOSS: BOSS, START_HEARTS: START_HEARTS, MAX_HEARTS: MAX_HEARTS, HERO_SPEED: HERO_SPEED, INVULN_S: INVULN_S,
    createState: createState, newGame: newGame, snapshot: snapshot, step: step, act: act, tileAt: tileAt, frontTile: frontTile, swordBox: swordBox, screenAt: screenAt, flagKey: flagKey, solidTile: solidTile, boxHitsSolid: boxHitsSolid, mulberry: mulberry };
  root.QuestEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, Kit = root.PixelKit, $ = Play.$, Tx = Play.T;
  var SAVE_KEY = 'zimi.games.quest', CHROME_PX = 190, MAX_SCALE = 4, READ_MS = 5000;
  Play.applyTheme();
  var els = { cv: $('qs-screen'), hearts: $('qs-hearts'), keys: $('qs-keys'), sword: $('qs-sword'), where: $('qs-where'), msg: $('qs-msg'), pause: $('qs-pause'), newBtn: $('qs-new') };
  var st = createState(null, 1), ctx, reduced = Play.reducedMotion(), scale = 2;
  var saved = Play.load(SAVE_KEY, null);
  var keys = Kit.keyboard(Object.assign({ ' ': 'act', Enter: 'act', z: 'act', x: 'act' }, root.ZimiUtil.DIR_KEYS), function (a) { if (a === 'act' && page.mode === 'playing') doAct(); }, function () { return !!document.querySelector('.ar-sheet:not([hidden])') || page.mode !== 'playing'; });
  var touch = { up: false, down: false, left: false, right: false, act: false };
  function held(a) { return keys.held[a] || touch[a]; }
  function input() { return { dx: (held('right') ? 1 : 0) - (held('left') ? 1 : 0), dy: (held('down') ? 1 : 0) - (held('up') ? 1 : 0) }; }
  function doAct() { act(st); drain(); }

  // With a saved quest the ready tap carries on from it; Menu > New game starts a fresh one.
  // Leaving and coming back keeps the exact spot: paused where it was, or at the end sheet. (The checkpoint save in drain
  // still lets a later visit carry on from the last place reached.)
  function hasSave() { return !!(saved && saved.v === 1); }
  var page = Play.arcadePage({
    els: els, ready: function () { return { start: function () { page.begin(hasSave()); }, touch: Tx(hasSave() ? 'quest.tapContinue' : 'play.tapStart'), keys: Tx(hasSave() ? 'quest.keyContinue' : 'play.pressKey') }; },
    state: function () { return st; }, draw: draw, hud: hud, result: 'win', endSaved: true, resumeOnStage: true,
    layout: layout, refresh: function () { layout(); hud(); },
    pad: { dirs: ['left', 'right', 'up', 'down'], actions: [{ name: 'act', label: Tx('play.act') }], on: function (name, down) {
      if (name === 'act') { if (down && page.mode === 'playing') doAct(); } else touch[name] = down;
    } },
    idle: function () { st = createState(hasSave() ? saved : null); },
    newRun: function (fromSave) { st = createState(fromSave ? saved : null); return fromSave ? Tx('quest.welcome') : ''; },
    release: function () { keys.clear(); Object.keys(touch).forEach(function (k) { touch[k] = false; }); },
    stats: function () { return [[Tx('quest.keys'), Play.num(st.keys)]]; },
    onFinish: function () { Play.save(SAVE_KEY, null); saved = null; },
    snapshot: function () { return st; },
    restore: function (s) {
      if (!s.screen) return false;
      st = s; st.rng = mulberry(Math.floor(Math.random() * 4294967296));
    }
  });
  var status = page.status;

  function layout() { var f = Kit.fit(els.cv, W, H, CHROME_PX, MAX_SCALE); ctx = f.ctx; scale = f.scale; draw(); }
  function hud() {
    els.hearts.textContent = Play.num(Math.max(0, st.hp));
    els.keys.textContent = Play.num(st.keys); els.sword.textContent = Tx(st.sword ? 'quest.yes' : 'quest.no'); els.where.textContent = Tx('quest.place.' + st.screen);
  }

  // ── art ──
  var HERO_PAL = { k: '#1b1b1d', s: '#f2c9a0', h: '#6b3f1d', b: '#3b6fd4', B: '#2a4fa0', w: '#ffffff', y: '#f5c518', n: '#7a4a22' };
  var HERO = {
    down: ['....kkkk....', '...khhhhk...', '..khhhhhhk..', '..kssssssk..', '..kskssksk..', '..kssssssk..', '...kbbbbk...', '..kbbyybbk..', '..ksbbbbsk..', '...kbbbbk...', '...kBkkBk...', '...knk.kn...'],
    up: ['....kkkk....', '...khhhhk...', '..khhhhhhk..', '..khhhhhhk..', '..khhhhhhk..', '..kssssssk..', '...kbbbbk...', '..kbbbbbbk..', '..ksbbbbsk..', '...kbbbbk...', '...kBkkBk...', '...knk.kn...'],
    right: ['....kkkk....', '...khhhhk...', '..khhhhhhk..', '..khhsssk...', '..khhsskk...', '..kssssk....', '...kbbbbk...', '..kbbbbbk...', '..ksbbbk....', '...kbbbbk...', '...kBkkBk...', '...kn..kn...']
  };
  var heroSprites = null;
  function buildArt() {
    heroSprites = { down: Kit.sprites(HERO.down, HERO_PAL), up: Kit.sprites(HERO.up, HERO_PAL), right: Kit.sprites(HERO.right, HERO_PAL) };
  }
  function rect(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); }
  var PALETTES = {
    A: { g: '#3d8f4f', g2: '#47a05a' }, B: { g: '#4a9a58', g2: '#52a863' }, D: { g: '#58a85a', g2: '#62b563' }, E: { g: '#5aa86a', g2: '#66b577' },
    C: { f: '#6e6a78', f2: '#78748a' }, F: { f: '#4a4560', f2: '#524c6a' }, G: { f: '#3a2f4a', f2: '#443858' }
  };
  function drawTile(ch, c, r, x, y) {
    var pal = PALETTES[st.screen], outdoor = !!pal.g, h = (c * 73856093 ^ r * 19349663) >>> 0;
    if (outdoor) { rect(x, y, TILE, TILE, (c + r) % 2 ? pal.g : pal.g2); if (h % 7 === 0) { rect(x + 4, y + 9, 1, 3, '#2f7a41'); rect(x + 3, y + 10, 3, 1, '#2f7a41'); } }
    else { rect(x, y, TILE, TILE, (c + r) % 2 ? pal.f : pal.f2); if (h % 9 === 0) rect(x + 6, y + 6, 3, 1, 'rgba(255,255,255,0.08)'); }
    if (ch === 'T') { rect(x + 1, y + 1, 14, 11, '#245c34'); rect(x + 3, y, 10, 3, '#2f7a41'); rect(x + 2, y + 5, 12, 5, '#2f7a41'); rect(x + 6, y + 11, 4, 5, '#6b4325'); rect(x + 4, y + 3, 3, 2, '#4caf72'); }
    else if (ch === 'R') { rect(x + 1, y + 3, 14, 12, '#767e8f'); rect(x + 3, y + 1, 10, 4, '#8a92a3'); rect(x + 1, y + 12, 14, 3, '#565d6b'); rect(x + 5, y + 5, 4, 2, '#a0a8b8'); }
    else if (ch === 'W') { rect(x, y, TILE, TILE, '#2b6cb0'); var ph = reduced ? 0 : Math.floor(st.anim * 2 + c) % 2; rect(x + 2 + ph * 4, y + 4, 5, 1, '#6fb3f2'); rect(x + 8 - ph * 3, y + 10, 5, 1, '#6fb3f2'); }
    else if (ch === 'b') { rect(x + 1, y + 4, 14, 10, '#2f8a4a'); rect(x + 3, y + 2, 10, 4, '#3aa35a'); rect(x + 4, y + 6, 3, 3, '#58c78d'); rect(x + 10, y + 8, 3, 3, '#58c78d'); }
    else if (ch === '#') { rect(x, y, TILE, TILE, pal.f ? '#2a2535' : '#2a2535'); rect(x, y, TILE, 2, '#4a4560'); rect(x + 2, y + 6, 5, 4, '#3a3450'); rect(x + 9, y + 10, 5, 4, '#3a3450'); }
    else if (ch === 'D') { rect(x, y, TILE, TILE, '#2a2535'); rect(x + 2, y + 2, 12, 14, '#6b4a2a'); rect(x + 2, y + 2, 12, 2, '#8a6238'); rect(x + 7, y + 8, 3, 3, '#ffd23f'); rect(x + 8, y + 10, 1, 3, '#ffd23f'); }
    else if (ch === 'd') { rect(x + 2, y + 2, 12, 14, '#0e0b14'); rect(x + 2, y + 2, 12, 1, '#6b4a2a'); rect(x + 1, y + 2, 1, 14, '#6b4a2a'); rect(x + 14, y + 2, 1, 14, '#6b4a2a'); }
    else if (ch === 'C' || ch === 'c') { rect(x + 1, y + 4, 14, 10, '#8a5a2a'); rect(x + 1, y + 4, 14, 3, ch === 'c' ? '#3a2410' : '#a8743f'); rect(x + 1, y + 11, 14, 3, '#6b4325'); if (ch === 'C') rect(x + 7, y + 7, 3, 4, '#ffd23f'); else rect(x + 3, y + 3, 10, 2, '#1b1008'); }
    else if (ch === 'P' || ch === 'p') { rect(x + 2, y + 9, 12, 6, '#9aa1b0'); rect(x + 3, y + 7, 10, 3, '#b9c0cf'); if (ch === 'P') { rect(x + 7, y, 2, 9, '#dfe6f4'); rect(x + 5, y + 6, 6, 2, '#ffd23f'); rect(x + 7, y + 1, 1, 6, '#ffffff'); } }
    else if (ch === 'N') { rect(x + 7, y + 8, 2, 7, '#6b4325'); rect(x + 2, y + 2, 12, 8, '#b88a54'); rect(x + 3, y + 3, 10, 1, '#6b4325'); rect(x + 3, y + 6, 8, 1, '#6b4325'); }
    else if (ch === '=') { rect(x, y, TILE, TILE, '#8a5a35'); }
  }
  function drawHeart(x, y) { rect(x, y + 1, 3, 3, '#e5484d'); rect(x + 4, y + 1, 3, 3, '#e5484d'); rect(x, y + 3, 7, 2, '#e5484d'); rect(x + 1, y + 5, 5, 1, '#e5484d'); rect(x + 2, y + 6, 3, 1, '#e5484d'); rect(x + 1, y + 1, 1, 1, '#ffb3b3'); }
  function drawEnemy(e) {
    var flash = e.flash > 0 && Math.floor(e.flash * 20) % 2 === 0;
    if (e.type === 'slime') {
      var sq = reduced ? 0 : Math.floor(st.anim * 4 + e.x) % 2, col = flash ? '#ffffff' : '#58c78d';
      rect(e.x + 1, e.y + 2 + sq, 10, 8 - sq, col); rect(e.x + 3, e.y + sq, 6, 3, col); rect(e.x, e.y + 5, 12, 5, col); rect(e.x + 3, e.y + 4 + sq, 2, 2, '#1b1b1d'); rect(e.x + 7, e.y + 4 + sq, 2, 2, '#1b1b1d'); rect(e.x + 3, e.y + 8, 6, 1, '#2f9e6a');
    } else if (e.type === 'bat') {
      var up = reduced ? 0 : Math.floor(st.anim * 9 + e.x) % 2, col2 = flash ? '#ffffff' : '#8b5cf6';
      rect(e.x + 4, e.y + 2, 4, 5, col2); rect(e.x + (up ? 0 : 1), e.y + (up ? 0 : 2), 4, 3, col2); rect(e.x + (up ? 8 : 7), e.y + (up ? 0 : 2), 4, 3, col2); rect(e.x + 5, e.y + 3, 1, 1, '#ffdd55'); rect(e.x + 6, e.y + 3, 1, 1, '#ffdd55');
    } else {
      var col3 = flash ? '#ffffff' : '#c0392b', hi = flash ? '#ffffff' : '#e8685a', pace = reduced ? 0 : Math.floor(st.anim * 5) % 2;
      rect(e.x + 2, e.y + 4, 24, 18, col3); rect(e.x + 5, e.y, 18, 6, col3); rect(e.x + 1, e.y + 10, 26, 8, col3);
      rect(e.x + 6, e.y + 1, 16, 2, hi); rect(e.x + 4, e.y + 5, 3, 2, hi);
      rect(e.x + 6, e.y + 9, 5, 5, '#fff3c4'); rect(e.x + 17, e.y + 9, 5, 5, '#fff3c4'); rect(e.x + 8, e.y + 11, 2, 3, '#1b1b1d'); rect(e.x + 19, e.y + 11, 2, 3, '#1b1b1d');
      rect(e.x + 8, e.y + 17, 12, 2, '#1b1b1d'); rect(e.x + 9, e.y + 17, 2, 2, '#fff3c4'); rect(e.x + 13, e.y + 17, 2, 2, '#fff3c4'); rect(e.x + 17, e.y + 17, 2, 2, '#fff3c4');
      rect(e.x + 1, e.y + 20 + pace, 5, 4 - pace, '#7a1f16'); rect(e.x + 22, e.y + 20 + (1 - pace), 5, 4 - (1 - pace), '#7a1f16');
      rect(e.x + 3, e.y - 3, 3, 5, '#e8e8ee'); rect(e.x + 22, e.y - 3, 3, 5, '#e8e8ee');
    }
  }
  function drawHero() {
    if (st.status === 'fainted') { var k = 1 - st.statusT / FAINT_S; ctx.globalAlpha = 1 - k * 0.6; }
    if (st.inv > 0 && st.status === 'playing' && !reduced && Math.floor(st.inv * 14) % 2 === 0) return;
    var dir = st.face === 'left' ? 'right' : st.face, pair = heroSprites[dir], spr = st.face === 'left' ? pair.l : pair.r;
    var bob = st.moving && !reduced && Math.floor(st.anim * 10) % 2 ? 1 : 0;
    ctx.drawImage(spr, Math.round(st.x + st.w / 2 - 6), Math.round(st.y + st.h - 12 - bob));
    ctx.globalAlpha = 1;
    if (st.swing > 0) {
      var b = swordBox(st), prog = 1 - st.swing / SWING_S;
      ctx.save();
      if (st.face === 'up' || st.face === 'down') { rect(b.x + 5, b.y + (st.face === 'up' ? 0 : 0), 4, b.h, '#dfe6f4'); rect(b.x + 6, b.y, 1, b.h, '#ffffff'); rect(b.x + 3, st.face === 'up' ? b.y + b.h - 3 : b.y, 8, 2, '#ffd23f'); }
      else { rect(b.x, b.y + 5, b.w, 4, '#dfe6f4'); rect(b.x, b.y + 6, b.w, 1, '#ffffff'); rect(st.face === 'left' ? b.x + b.w - 3 : b.x, b.y + 3, 2, 8, '#ffd23f'); }
      if (prog > 0.3 && !reduced) { rect(b.x + (b.w >> 1) - 1, b.y + (b.h >> 1) - 1, 3, 3, 'rgba(255,255,255,0.6)'); }
      ctx.restore();
    }
  }
  function draw() {
    if (!ctx || !heroSprites) return;
    var s = SCREENS[st.screen], r, c;
    for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) drawTile(tileAt(st, c, r), c, r, c * TILE, r * TILE);
    st.pickups.forEach(function (p) {
      if (p.type === 'heart') drawHeart(p.x + 1, p.y + 1 + (reduced ? 0 : Math.round(Math.sin(st.anim * 5) * 1)));
      else { rect(p.x, p.y + 2, 8, 6, '#ffd23f'); rect(p.x + 1, p.y, 6, 3, '#ffe27a'); rect(p.x + 3, p.y + 3, 2, 2, '#e5484d'); }
    });
    st.enemies.forEach(drawEnemy);
    st.shots.forEach(function (b) { rect(b.x, b.y, 5, 5, '#ff7a3d'); rect(b.x + 1, b.y + 1, 3, 3, '#ffe066'); });
    drawHero();
    if (st.status === 'won') Kit.textCentered(ctx, Tx('quest.doneBanner'), W / 2, 20, '#ffffff', 2);
    // the Warden's strength while it is here
    var boss = st.enemies.filter(function (e) { return e.type === 'boss'; })[0];
    if (boss) { rect(W / 2 - 24, H - 8, 48, 4, '#1b1b1d'); rect(W / 2 - 23, H - 7, Math.round(46 * boss.hp / BOSS.hp), 2, '#e5484d'); }
    if (s && st.status === 'fainted') Kit.textCentered(ctx, Tx('quest.koBanner'), W / 2, H / 2 - 6, '#ffffff', 2);
  }

  // ── flow ──
  var ITEM_LINE = { sword: 'quest.item.sword', key: 'quest.item.key', container: 'quest.item.container', treasure: 'quest.item.treasure' };
  function drain() {
    st.events.forEach(function (e) {
      if (e.name === 'item') { if (ITEM_LINE[e.data]) status.reason(Tx(ITEM_LINE[e.data]), READ_MS); }
      else if (e.name === 'sign') status.reason(Tx('quest.sign.' + st.screen), READ_MS);
      else if (e.name === 'nosword') status.reason(Tx('quest.nosword'));
      else if (e.name === 'door') status.reason(Tx(e.data === 'open' ? 'quest.door.open' : 'quest.door.locked'));
      else if (e.name === 'screen') { status.reason(HINTS[st.screen] && !st.flags['hint:' + st.screen] ? Tx('quest.hint.' + st.screen) : '', READ_MS); if (HINTS[st.screen]) st.flags['hint:' + st.screen] = true; }
      else if (e.name === 'faint') status.reason(Tx('quest.faint'), READ_MS);
      else if (e.name === 'woke') status.reason(Tx('quest.woke'), READ_MS);
      else if (e.name === 'defeat' && e.data === 'boss') status.reason(Tx('quest.boss'), READ_MS);
      else if (e.name === 'won') page.finish();
      else if (e.name === 'save') Play.save(SAVE_KEY, snapshot(st));
    });
    st.events.length = 0;
  }
  page.run(function (dt) { step(st, dt, input()); drain(); });

  buildArt(); page.start();
  root.__quest = { get st() { return st; }, get mode() { return page.mode; } };
})(this);
