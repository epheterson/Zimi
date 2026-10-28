/* ZimiGames: Blast, a grid of bombers. Our own code and art, GPL-3.0. No network, no modules.
   Drop bombs, blow up the soft blocks, grab power-ups and be the last one standing. One or two people on one
   keyboard (W A S D and Space against the arrows and Enter) against computer bombers. First to two rounds.
   The rules are pure functions (no DOM) so node can test them; the page draws it all at 182 x 154 pixels. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var W = 13, H = 11, TILE = 14;
  var FUSE_S = 2.2, FLAME_S = 0.55, START_RANGE = 2, START_BOMBS = 1, START_SPEED = 3.4, SPEED_STEP = 0.55, MAX_SPEED = 6, MAX_RANGE = 8, MAX_BOMBS = 6;
  var SOFT_FILL = 0.72, POWERUP_CHANCE = 0.34, READY_S = 1.2, OVER_S = 2.2, ROUND_LIMIT_S = 150, WINS_NEEDED = 2;
  var SPAWNS = [[1, 1], [11, 9], [11, 1], [1, 9]];
  var UP = { dx: 0, dy: -1 }, LEFT = { dx: -1, dy: 0 }, DOWN = { dx: 0, dy: 1 }, RIGHT = { dx: 1, dy: 0 };
  var DIRS = [UP, LEFT, DOWN, RIGHT];
  var POWERUPS = ['range', 'bomb', 'speed'];
  var COLORS = ['#35b6a4', '#f08ac0', '#f5a524', '#8b5cf6'];

  var mulberry = root.ZimiUtil.mulberry32;
  function key(x, y) { return x + ',' + y; }

  // A map: the border and every tile with two even coordinates are stone; soft blocks fill most of the rest,
  // except the little L around each start so nobody is boxed in on the first move.
  function makeGrid(rng, count) {
    var grid = [], hidden = {}, x, y;
    for (y = 0; y < H; y++) { grid.push([]); for (x = 0; x < W; x++) grid[y].push(x === 0 || y === 0 || x === W - 1 || y === H - 1 || (x % 2 === 0 && y % 2 === 0) ? '#' : ' '); }
    var clear = {};
    SPAWNS.slice(0, Math.max(count, 2)).forEach(function (s) {
      [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]].forEach(function (d) { clear[key(s[0] + d[0], s[1] + d[1])] = true; });
    });
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      if (grid[y][x] !== ' ' || clear[key(x, y)]) continue;
      if (rng() < SOFT_FILL) { grid[y][x] = 'B'; if (rng() < POWERUP_CHANCE) hidden[key(x, y)] = POWERUPS[Math.floor(rng() * POWERUPS.length)]; }
    }
    return { grid: grid, hidden: hidden };
  }

  // kinds: one entry per bomber, 'person' or 'cpu' (up to four). Person 0 is player 1.
  function createState(kinds, seed, carry) {
    var rng = mulberry(seed === undefined ? Math.floor(Math.random() * 4294967296) : seed), g = makeGrid(rng, kinds.length);
    var st = { w: W, h: H, grid: g.grid, hidden: g.hidden, rng: rng, seed: seed, kinds: kinds.slice(), bombs: [], flames: [], items: [], time: 0, status: 'ready', statusT: READY_S, winner: -1, events: [], round: carry ? carry.round : 1, wins: carry ? carry.wins.slice() : kinds.map(function () { return 0; }), anim: 0 };
    st.players = kinds.map(function (k, i) {
      return { id: i, human: k === 'person', x: SPAWNS[i][0], y: SPAWNS[i][1], dx: 0, dy: 0, wantX: 0, wantY: 0, alive: true, maxBombs: START_BOMBS, range: START_RANGE, speed: START_SPEED, face: 'down', walk: 0, diedAt: -1, think: 0, color: COLORS[i] };
    });
    return st;
  }
  function event(st, name, data) { st.events.push({ name: name, data: data }); }

  function bombAt(st, x, y) { for (var i = 0; i < st.bombs.length; i++) if (st.bombs[i].x === x && st.bombs[i].y === y) return st.bombs[i]; return null; }
  function itemAt(st, x, y) { for (var i = 0; i < st.items.length; i++) if (st.items[i].x === x && st.items[i].y === y) return i; return -1; }
  function tileAt(st, x, y) { return x < 0 || y < 0 || x >= st.w || y >= st.h ? '#' : st.grid[y][x]; }
  // May this bomber step into the tile? Stone and blocks never; a bomb only for someone still standing on it.
  function walkable(st, x, y, p) {
    if (tileAt(st, x, y) !== ' ') return false;
    var b = bombAt(st, x, y);
    return !b || (p && b.pass[p.id] === true);
  }

  // The tiles a bomb's blast would cover, with the soft blocks, bombs and items it would hit. Stone stops it, and so does
  // the first soft block, bomb or item in each direction (that one is hit and the blast goes no further).
  function blastOf(st, b) {
    var cells = [{ x: b.x, y: b.y }], hits = [];
    DIRS.forEach(function (d) {
      for (var i = 1; i <= b.range; i++) {
        var x = b.x + d.dx * i, y = b.y + d.dy * i, t = tileAt(st, x, y);
        if (t === '#') break;
        cells.push({ x: x, y: y });
        if (t === 'B') { hits.push({ x: x, y: y, what: 'block' }); break; }
        if (bombAt(st, x, y)) { hits.push({ x: x, y: y, what: 'bomb' }); break; }
        if (itemAt(st, x, y) >= 0) { hits.push({ x: x, y: y, what: 'item' }); break; }
      }
    });
    return { cells: cells, hits: hits };
  }

  // Put a bomb down under a bomber (if they may). Everyone standing on it can step off it.
  function placeBomb(st, p) {
    var x = Math.round(p.x), y = Math.round(p.y);
    if (!p.alive || st.status !== 'playing' || bombAt(st, x, y)) return false;
    var mine = 0; st.bombs.forEach(function (b) { if (b.owner === p.id) mine++; });
    if (mine >= p.maxBombs) return false;
    var b = { x: x, y: y, owner: p.id, t: FUSE_S, range: p.range, pass: {} };
    st.players.forEach(function (q) { if (q.alive && Math.abs(q.x - x) < 0.9 && Math.abs(q.y - y) < 0.9) b.pass[q.id] = true; });
    st.bombs.push(b); event(st, 'place', p.id);
    return true;
  }

  // Set off a bomb now; whatever its blast touches goes too, bombs included (a chain reaction).
  function detonate(st, first) {
    var queue = [first], done = [];
    while (queue.length) {
      var b = queue.shift();
      if (done.indexOf(b) >= 0) continue;
      done.push(b);
      var r = blastOf(st, b);
      r.cells.forEach(function (c) { st.flames.push({ x: c.x, y: c.y, t: FLAME_S }); });
      r.hits.forEach(function (h) {
        if (h.what === 'block') {
          st.grid[h.y][h.x] = ' ';
          var k = key(h.x, h.y); if (st.hidden[k]) { st.items.push({ x: h.x, y: h.y, type: st.hidden[k], born: st.time }); delete st.hidden[k]; }
          event(st, 'block', { x: h.x, y: h.y });
        } else if (h.what === 'item') { st.items.splice(itemAt(st, h.x, h.y), 1); }
        else { var o = bombAt(st, h.x, h.y); if (o && done.indexOf(o) < 0) queue.push(o); }
      });
      // an item under the blast's centre is lost too; items revealed by this very blast are not
      var i = st.bombs.indexOf(b); if (i >= 0) st.bombs.splice(i, 1);
      event(st, 'boom', { x: b.x, y: b.y, range: b.range });
    }
    // the bombs that were just removed no longer block anyone; kill what stands in the fire
    st.players.forEach(function (p) { if (p.alive && flameAt(st, Math.round(p.x), Math.round(p.y))) kill(st, p); });
  }
  function flameAt(st, x, y) { for (var i = 0; i < st.flames.length; i++) if (st.flames[i].x === x && st.flames[i].y === y) return true; return false; }
  function kill(st, p) { if (!p.alive) return; p.alive = false; p.diedAt = st.time; p.dx = 0; p.dy = 0; event(st, 'die', p.id); }

  // When will fire reach each tile? A map of "x,y" to seconds (0 = burning now), counting chains.
  function dangerMap(st, extraBomb) {
    var bombs = st.bombs.concat(extraBomb ? [extraBomb] : []), eff = bombs.map(function (b) { return b.t; }), blasts = bombs.map(function (b) { return blastOf(st, b); }), n = bombs.length, changed = true, i, j, danger = {};
    // a blast that reaches another bomb sets it off at that moment, so a chain is as fast as its quickest link
    while (changed) {
      changed = false;
      for (i = 0; i < n; i++) blasts[i].cells.forEach(function (c) {
        for (j = 0; j < n; j++) if (j !== i && bombs[j].x === c.x && bombs[j].y === c.y && eff[i] < eff[j]) { eff[j] = eff[i]; changed = true; }
      });
    }
    for (i = 0; i < n; i++) blasts[i].cells.forEach(function (c) { var k = key(c.x, c.y); if (danger[k] === undefined || eff[i] < danger[k]) danger[k] = eff[i]; });
    st.flames.forEach(function (f) { danger[key(f.x, f.y)] = 0; });
    return danger;
  }

  // ── the computer's bomber ──
  // Breadth-first over tiles it may walk onto in time: it never steps where fire arrives before it does.
  var MARGIN_S = 0.25;
  function reach(st, p, danger, from) {
    var sx = Math.round(from ? from.x : p.x), sy = Math.round(from ? from.y : p.y), seen = {}, q = [{ x: sx, y: sy, d: 0, first: null }];
    seen[key(sx, sy)] = true;
    var out = [];
    while (q.length) {
      var cur = q.shift();
      out.push(cur);
      DIRS.forEach(function (dir) {
        var nx = cur.x + dir.dx, ny = cur.y + dir.dy, k = key(nx, ny);
        if (seen[k] || !walkable(st, nx, ny, p)) return;
        var arrive = (cur.d + 1) / p.speed, dg = danger[k];
        if (dg !== undefined && arrive > dg - MARGIN_S && arrive < dg + FLAME_S + 0.05) return;   // fire there when we would be
        seen[k] = true; q.push({ x: nx, y: ny, d: cur.d + 1, first: cur.first || dir });
      });
    }
    return out;
  }
  function isSafeTile(danger, x, y) { return danger[key(x, y)] === undefined; }

  // Which way (and whether to drop a bomb) for a computer bomber standing at a tile centre.
  function think(st, p) {
    var danger = dangerMap(st), here = key(Math.round(p.x), Math.round(p.y)), nodes = reach(st, p, danger), i, node;
    // 1. in danger: run to the nearest tile that is safe
    if (danger[here] !== undefined) {
      for (i = 1; i < nodes.length; i++) if (isSafeTile(danger, nodes[i].x, nodes[i].y)) return { dir: nodes[i].first, bomb: false };
      return { dir: nodes.length > 1 ? nodes[1].first : null, bomb: false };
    }
    // 2. a bomb here is worth it if it would hit a block or someone, and there is a way out of its blast
    var hyp = { x: Math.round(p.x), y: Math.round(p.y), t: FUSE_S, range: p.range, owner: p.id, pass: {} }, mine = 0;
    st.bombs.forEach(function (b) { if (b.owner === p.id) mine++; });
    if (mine < p.maxBombs && !bombAt(st, hyp.x, hyp.y)) {
      var r = blastOf(st, hyp), worth = r.hits.some(function (h) { return h.what === 'block'; }) || st.players.some(function (o) { return o.id !== p.id && o.alive && r.cells.some(function (c) { return c.x === Math.round(o.x) && c.y === Math.round(o.y); }); });
      if (worth) {
        var after = dangerMap(st, hyp), out = reach(st, p, after, p).filter(function (nd) { return isSafeTile(after, nd.x, nd.y) && nd.d / p.speed < FUSE_S - 0.3; });
        if (out.length && (st.rng() < 0.9)) return { dir: null, bomb: true };
      }
    }
    // 3. go for a power-up, else toward a place where a bomb would do something
    var goals = [];
    for (i = 1; i < nodes.length; i++) {
      node = nodes[i];
      if (!isSafeTile(danger, node.x, node.y)) continue;
      if (itemAt(st, node.x, node.y) >= 0) { goals.push({ node: node, score: 0 }); continue; }
      var near = false;
      DIRS.forEach(function (d) { for (var k = 1; k <= Math.min(2, p.range); k++) { var t = tileAt(st, node.x + d.dx * k, node.y + d.dy * k); if (t === '#') break; if (t === 'B') near = true; } });
      st.players.forEach(function (o) { if (o.id !== p.id && o.alive && Math.abs(Math.round(o.x) - node.x) + Math.abs(Math.round(o.y) - node.y) <= 2) near = true; });
      if (near) goals.push({ node: node, score: 1 });
    }
    goals.sort(function (a, b) { return a.score - b.score || a.node.d - b.node.d; });
    if (goals.length) return { dir: goals[0].node.first, bomb: false };
    // 4. nothing to do: wander on safe tiles
    var safe = nodes.filter(function (nd, ix) { return ix > 0 && isSafeTile(danger, nd.x, nd.y) && nd.d === 1; });
    return { dir: safe.length ? safe[Math.floor(st.rng() * safe.length)].first : null, bomb: false };
  }

  function stepBomber(st, p, dt) {
    root.GridWalk.advance(p, p.speed * dt, function (e) {
      var cx = Math.round(e.x), cy = Math.round(e.y), d;
      if (!p.human) {
        var t = think(st, p);
        if (t.bomb) { placeBomb(st, p); t = think(st, p); }   // with the bomb down, where to run
        d = t.dir;
        return d && walkable(st, cx + d.dx, cy + d.dy, p) ? d : null;
      }
      if ((p.wantX || p.wantY) && walkable(st, cx + p.wantX, cy + p.wantY, p)) return { dx: p.wantX, dy: p.wantY };
      return null;
    });
    if (p.dx || p.dy) { p.face = p.dx > 0 ? 'right' : p.dx < 0 ? 'left' : p.dy < 0 ? 'up' : 'down'; p.walk += dt * 9; }
  }

  // Input for a person: want = { dx, dy } (the direction held, or 0,0) and bomb = true on the tick they press the bomb key.
  function setInput(st, id, want, bomb) {
    var p = st.players[id]; if (!p) return;
    p.wantX = want ? want.dx : 0; p.wantY = want ? want.dy : 0;
    if (bomb) placeBomb(st, p);
  }

  function collect(st, p) {
    var i = itemAt(st, Math.round(p.x), Math.round(p.y));
    if (i < 0 || Math.abs(p.x - Math.round(p.x)) > 0.45 || Math.abs(p.y - Math.round(p.y)) > 0.45) return;
    var it = st.items.splice(i, 1)[0];
    if (it.type === 'range') p.range = Math.min(MAX_RANGE, p.range + 1);
    else if (it.type === 'bomb') p.maxBombs = Math.min(MAX_BOMBS, p.maxBombs + 1);
    else p.speed = Math.min(MAX_SPEED, p.speed + SPEED_STEP);
    event(st, 'item', { id: p.id, type: it.type });
  }

  // One tick of dt seconds.
  function step(st, dt) {
    st.anim += dt;
    if (st.status === 'ready') { st.statusT -= dt; if (st.statusT <= 0) st.status = 'playing'; return; }
    if (st.status === 'roundover') { st.statusT -= dt; return; }
    if (st.status !== 'playing') return;
    st.time += dt;
    // a bomb that someone has stepped away from becomes solid to them
    st.bombs.forEach(function (b) {
      Object.keys(b.pass).forEach(function (id) { var q = st.players[id]; if (!q || Math.abs(q.x - b.x) >= 1 || Math.abs(q.y - b.y) >= 1) delete b.pass[id]; });
    });
    st.players.forEach(function (p) { if (p.alive) { stepBomber(st, p, dt); collect(st, p); } });
    st.flames = st.flames.filter(function (f) { f.t -= dt; return f.t > 0; });
    st.bombs.slice().forEach(function (b) { b.t -= dt; });
    st.bombs.slice().forEach(function (b) { if (b.t <= 0 && st.bombs.indexOf(b) >= 0) detonate(st, b); });
    st.players.forEach(function (p) { if (p.alive && flameAt(st, Math.round(p.x), Math.round(p.y))) kill(st, p); });
    var alive = st.players.filter(function (p) { return p.alive; });
    if (alive.length <= 1 || st.time >= ROUND_LIMIT_S) {
      st.status = 'roundover'; st.statusT = OVER_S; st.winner = alive.length === 1 ? alive[0].id : -1;
      if (st.winner >= 0) st.wins[st.winner]++;
      event(st, 'round', st.winner);
    }
  }

  function matchWinner(st) { for (var i = 0; i < st.wins.length; i++) if (st.wins[i] >= WINS_NEEDED) return i; return -1; }

  var Engine = { W: W, H: H, TILE: TILE, FUSE_S: FUSE_S, FLAME_S: FLAME_S, WINS_NEEDED: WINS_NEEDED, UP: UP, LEFT: LEFT, DOWN: DOWN, RIGHT: RIGHT, DIRS: DIRS, COLORS: COLORS, POWERUPS: POWERUPS,
    createState: createState, step: step, placeBomb: placeBomb, detonate: detonate, blastOf: blastOf, dangerMap: dangerMap, think: think, setInput: setInput, walkable: walkable, bombAt: bombAt, flameAt: flameAt, itemAt: itemAt,
    matchWinner: matchWinner, makeGrid: makeGrid, mulberry: mulberry, START_SPEED: START_SPEED, START_RANGE: START_RANGE, MAX_RANGE: MAX_RANGE };
  root.BlastEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, Kit = root.PixelKit, $ = Play.$, Tx = Play.T;
  var PREF_KEY = 'zimi.games.blast.setup', SCORE_KEY = 'zimi.games.blast.wins', CHROME_PX = 190, MAX_SCALE = 4, READY_ARM_MS = 650, WIN_BUMP = 1.25, WIN_BUMP_MS = 260;
  Play.applyTheme();
  var W_PX = W * TILE, H_PX = H * TILE;
  var els = { cv: $('bl-screen'), msg: $('bl-msg'), pause: $('bl-pause'), newBtn: $('bl-new'), wins: $('bl-wins'), round: $('bl-round') };
  var setup = Play.load(PREF_KEY, { humans: 1, cpus: 2 }), st = null, mode = 'ready', ctx, reduced = Play.reducedMotion(), record = Play.load(SCORE_KEY, { won: 0, lost: 0 }), status = Play.status(els.msg), armed = null;
  var pad = Play.pad(els.cv, { dirs: ['left', 'right', 'up', 'down'], actions: [{ name: 'bomb', label: Tx('play.bomb') }], on: function (name, down) {
    if (name === 'bomb') { if (down) bombFor(0); return; }
    held.p1[name] = down; if (st) applyKeys();
  } });
  function kindsOf() { var k = [], i; for (i = 0; i < setup.humans; i++) k.push('person'); for (i = 0; i < setup.cpus; i++) k.push('cpu'); return k; }

  function layout() { ctx = Kit.fit(els.cv, W_PX, H_PX, CHROME_PX, MAX_SCALE).ctx; if (st) draw(); }
  // The rounds won are one stat per bomber ("You 1", "Computer 0", ...) with its colour dot, so a bare "0-0-0" never has to be decoded.
  // The row is built once per match and only its numbers change; the winner's number gives a small bump.
  function labelOf(i) { return st.kinds[i] === 'person' ? (setup.humans === 1 ? Tx('board.you') : Tx('blast.player', { n: i + 1 })) : Tx('blast.computer'); }
  function hud() {
    if (!st) return;
    els.round.textContent = Play.num(st.round);
    var key = st.kinds.join() + setup.humans;
    if (els.wins.dataset.key !== key) {
      els.wins.dataset.key = key; els.wins.textContent = '';
      st.kinds.forEach(function (k, i) {
        var box = document.createElement('div'), lab = document.createElement('small'), dot = document.createElement('i'), num = document.createElement('b');
        box.className = 'pl-stat'; dot.className = 'bl-dot'; dot.style.background = COLORS[i]; dot.setAttribute('aria-hidden', 'true');
        lab.appendChild(dot); lab.appendChild(document.createTextNode(labelOf(i))); box.appendChild(lab); box.appendChild(num); els.wins.appendChild(box);
      });
    }
    st.wins.forEach(function (w, i) {
      var num = els.wins.children[i].lastChild, text = Play.num(w);
      if (num.textContent !== text) {
        if (num.textContent && !reduced && num.animate) num.animate([{ scale: 1 }, { scale: WIN_BUMP }, { scale: 1 }], { duration: WIN_BUMP_MS, easing: 'ease-out' });
        num.textContent = text;
      }
    });
  }

  // ── art ──
  function rect(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); }
  var bots = {};
  function botSprite(color, frame) {
    var k = color + frame;
    if (!bots[k]) {
      var rows = ['...kkkk...', '..kccccck.', '.kccccccck', '.kcwkcwkck', '.kccccccck', '.kcccppcck', '..kcccckk.', '..kkkkkkk.', frame ? '..kk..k...' : '...k..kk..'];
      bots[k] = Kit.sprite(rows.map(function (r) { return (r + '..........').slice(0, 10); }), { k: '#1b1b1d', c: color, w: '#ffffff', p: '#ffffff' });
    }
    return bots[k];
  }
  function drawFloor() {
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var t = st.grid[y][x], px = x * TILE, py = y * TILE;
      if (t === '#') { rect(px, py, TILE, TILE, '#5c6370'); rect(px, py, TILE, 2, '#8a92a3'); rect(px, py + TILE - 2, TILE, 2, '#3c424d'); rect(px + 2, py + 4, 4, 2, '#767e8f'); rect(px + 8, py + 8, 4, 2, '#4a505c'); }
      else {
        rect(px, py, TILE, TILE, (x + y) % 2 ? '#3f8d58' : '#46965f');
        if (t === 'B') { rect(px, py, TILE, TILE, '#b8864f'); rect(px, py, TILE, 2, '#d9ab72'); rect(px, py + TILE - 2, TILE, 2, '#7c5530'); rect(px + 6, py + 2, 1, 10, '#8c6338'); rect(px + 1, py + 6, TILE - 2, 1, '#8c6338'); rect(px + 2, py + 3, 3, 2, '#cf9a60'); rect(px + 9, py + 8, 3, 2, '#cf9a60'); }
      }
    }
  }
  function drawItem(it) {
    var px = it.x * TILE, py = it.y * TILE + (reduced ? 0 : Math.round(Math.sin(st.anim * 5 + it.x) * 1));
    rect(px + 2, py + 2, TILE - 4, TILE - 4, '#fff3c4'); rect(px + 3, py + 3, TILE - 6, TILE - 6, '#1b1b1d');
    if (it.type === 'range') { rect(px + 6, py + 4, 2, 6, '#ff7a3d'); rect(px + 5, py + 6, 4, 4, '#ff7a3d'); rect(px + 6, py + 5, 2, 2, '#ffd23f'); }
    else if (it.type === 'bomb') { rect(px + 5, py + 6, 4, 4, '#cfd8ea'); rect(px + 6, py + 5, 2, 6, '#cfd8ea'); rect(px + 8, py + 4, 2, 1, '#ffd23f'); }
    else { rect(px + 4, py + 7, 6, 2, '#6be08a'); rect(px + 6, py + 5, 4, 2, '#6be08a'); rect(px + 9, py + 4, 1, 3, '#6be08a'); }
  }
  function drawBomb(b) {
    var px = b.x * TILE, py = b.y * TILE, pulse = reduced ? 0 : Math.floor(st.anim * (b.t < 0.8 ? 12 : 4)) % 2;
    rect(px + 3, py + 4, 8, 8, '#1b1b1d'); rect(px + 2, py + 5, 10, 6, '#1b1b1d'); rect(px + 4, py + 5, 2, 2, '#4a5470');
    if (pulse) { rect(px + 3, py + 4, 8, 1, '#7f1d1d'); }
    rect(px + 7, py + 2, 1, 3, '#b88a54'); rect(px + 8, py + 1, 2, 2, pulse ? '#ffe066' : '#ff7a3d');
  }
  function drawFlame(f) {
    var px = f.x * TILE, py = f.y * TILE, a = Math.min(1, f.t / FLAME_S);
    rect(px + 1, py + 1, TILE - 2, TILE - 2, '#ff7a3d'); rect(px + 3, py + 3, TILE - 6, TILE - 6, '#ffd23f'); if (a > 0.5) rect(px + 5, py + 5, TILE - 10, TILE - 10, '#fff7d6');
  }
  function drawBomber(p) {
    var px = Math.round(p.x * TILE) + 2, py = Math.round(p.y * TILE) + 3 + (p.walk && !reduced && Math.floor(p.walk) % 2 ? 0 : 0);
    if (!p.alive) {
      var t = st.time - p.diedAt; if (t > 0.9) return;
      var k = Math.min(1, t / 0.9);
      ctx.globalAlpha = 1 - k; ctx.drawImage(botSprite(p.color, 0), px, py - Math.round(k * 8)); ctx.globalAlpha = 1; return;
    }
    ctx.drawImage(botSprite(p.color, Math.floor(p.walk) % 2), px, py - 2);
    // a mark so two similar colours stay apart: a small number or a CPU dot above the head
    if (p.human) Kit.text(ctx, String(p.id + 1), px + 3, py - 7, '#ffffff', 1);
  }
  function draw() {
    if (!ctx || !st) return;
    drawFloor();
    st.items.forEach(drawItem);
    st.bombs.forEach(drawBomb);
    st.flames.forEach(drawFlame);
    st.players.forEach(drawBomber);
    if (st.status === 'ready') Kit.textCentered(ctx, Tx('blast.round', { n: st.round }), W_PX / 2, H_PX / 2 - 6, '#ffffff', 2);
    if (st.status === 'roundover') Kit.textCentered(ctx, st.winner < 0 ? Tx('shell.end.draw') : soloYou(st.winner) ? Tx('shell.end.win') : Tx('shell.end.wins', { name: nameOf(st.winner) }), W_PX / 2, H_PX / 2 - 6, '#ffffff', 2);
  }

  // ── flow ──
  var held = { p1: { up: false, down: false, left: false, right: false }, p2: { up: false, down: false, left: false, right: false } };
  var KEYMAP = {};   // key -> [player, action], set from the setup
  function dirOf(h) { return h.up ? UP : h.down ? DOWN : h.left ? LEFT : h.right ? RIGHT : null; }
  function applyKeys() {
    var one = setup.humans === 1;
    if (st.players[0] && st.players[0].human) setInput(st, 0, dirOf(held.p1) || (one ? dirOf(held.p2) : null), false);
    if (!one && st.players[1] && st.players[1].human) setInput(st, 1, dirOf(held.p2), false);
  }
  // Alone against the computer the one person wins as "you"; with two people it is Player 1 and Player 2.
  function soloYou(i) { return st.kinds[i] === 'person' && setup.humans === 1; }
  function nameOf(i) { return st.kinds[i] === 'person' ? Tx('blast.player', { n: i + 1 }) : Tx('blast.computer'); }
  function bombFor(id) { if (st && mode === 'playing' && st.players[id] && st.players[id].human) placeBomb(st, st.players[id]); }
  var keys = { map: {} };
  function buildKeys() {
    var one = setup.humans === 1;
    keys.map = { w: ['p1', 'up'], a: ['p1', 'left'], s: ['p1', 'down'], d: ['p1', 'right'], ' ': ['bomb', 0] };
    if (one) { keys.map.ArrowUp = ['p1', 'up']; keys.map.ArrowDown = ['p1', 'down']; keys.map.ArrowLeft = ['p1', 'left']; keys.map.ArrowRight = ['p1', 'right']; keys.map.Enter = ['bomb', 0]; }
    else { keys.map.ArrowUp = ['p2', 'up']; keys.map.ArrowDown = ['p2', 'down']; keys.map.ArrowLeft = ['p2', 'left']; keys.map.ArrowRight = ['p2', 'right']; keys.map.Enter = ['bomb', 1]; }
  }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.ar-sheet:not([hidden])')) return;
    if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') { e.preventDefault(); if (mode === 'playing' || mode === 'paused') toggle(); return; }
    if (mode !== 'playing') return;
    var k = keys.map[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!k) return;
    if (e.target && e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
    e.preventDefault();
    if (k[0] === 'bomb') { if (!e.repeat) bombFor(k[1]); } else { held[k[0]][k[1]] = true; applyKeys(); }
  });
  document.addEventListener('keyup', function (e) {
    var k = keys.map[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (k && k[0] !== 'bomb') { held[k[0]][k[1]] = false; applyKeys(); }
  });
  window.addEventListener('blur', function () { ['p1', 'p2'].forEach(function (p) { Object.keys(held[p]).forEach(function (a) { held[p][a] = false; }); }); if (st) applyKeys(); });
  var loop = Play.loop(function (dt) {
    step(st, dt);
    st.events.forEach(function (e) {
      if (e.name === 'item') status.reason(Tx('blast.took.' + e.data.type, { name: nameOf(e.data.id) }));
      else if (e.name === 'round') status.say('');
    });
    st.events.length = 0;
    if (st.status === 'roundover' && st.statusT <= 0 && mode === 'playing') nextRound();
  }, function () { draw(); hud(); }, 60);

  // Who plays is the one real choice: two rows (people, computers), in the New game pane.
  function setupRows() {
    var box = document.createElement('div');
    function paint() {
      box.textContent = '';
      function pick(field) { return function (v) { setup[field] = v; if (setup.humans + setup.cpus < 2) setup.cpus = 1; if (setup.humans + setup.cpus > 4) setup.cpus = 4 - setup.humans; Play.save(PREF_KEY, setup); paint(); }; }
      var cpuChoices = (setup.humans === 1 ? [1, 2, 3] : [0, 1, 2]).map(function (v) { return [v, Play.num(v)]; });
      box.appendChild(Play.optionRow(Tx('blast.people'), [[1, Play.num(1)], [2, Play.num(2)]], setup.humans, pick('humans')));
      box.appendChild(Play.optionRow(Tx('blast.computers'), cpuChoices, setup.cpus, pick('cpus')));
    }
    paint();
    return box;
  }
  function arm() {
    if (armed) armed.cancel();
    st = createState(kindsOf(), 11); buildKeys(); mode = 'ready'; layout(); hud();
    armed = Play.ready({ say: status.say, target: pad.stage, start: begin });
  }
  function begin() {
    if (armed) armed.cancel();
    buildKeys(); st = createState(kindsOf()); mode = 'playing'; status.say(''); Play.pauseLabel(els.pause, false); els.pause.disabled = false; layout(); hud(); loop.start();
  }
  function nextRound() {
    var mw = matchWinner(st);
    if (mw >= 0) { finish(mw); return; }
    st = createState(kindsOf(), undefined, { round: st.round + 1, wins: st.wins }); applyKeys();
  }
  function pause() { if (mode !== 'playing') return; mode = 'paused'; loop.stop(); Play.pauseLabel(els.pause, true); status.say(Tx('play.paused')); }
  function resume() { if (mode !== 'paused') return; mode = 'playing'; Play.pauseLabel(els.pause, false); status.say(''); loop.start(); }
  function toggle() { if (mode === 'playing') pause(); else resume(); }
  var lastEnd = null;
  function finish(mw) {
    mode = 'over'; loop.stop(); els.pause.disabled = true; Play.pauseLabel(els.pause, false);
    var human = st.kinds[mw] === 'person', solo = setup.humans === 1, opts;
    if (solo) { if (human) record.won++; else record.lost++; Play.save(SCORE_KEY, record); }
    hud(); draw();
    opts = { stats: [[Tx('blast.roundsWon'), Play.num(st.wins[mw])]] };
    if (solo) opts.result = human ? 'win' : 'lose'; else { opts.result = 'win'; opts.name = nameOf(mw); }
    lastEnd = opts;
    ZimiShell.endSheet(opts);
    setTimeout(function () { if (mode === 'over') armed = Play.ready({ say: status.say, target: pad.stage, start: begin }); }, READY_ARM_MS);
  }
  els.newBtn.addEventListener('click', begin);
  els.pause.addEventListener('click', toggle);
  pad.stage.addEventListener('pointerdown', function () { if (mode === 'paused') resume(); });
  Play.onHidden(pause);
  ZimiShell.game({
    inProgress: function () { return mode === 'playing' || mode === 'paused'; },
    stats: function () { return record.won + record.lost ? [[Tx('blast.won'), Play.num(record.won)], [Tx('blast.lost'), Play.num(record.lost)]] : []; },
    menu: function () { return { options: [setupRows()] }; }
  });

  window.addEventListener('resize', layout);
  buildKeys(); layout();
  // Leaving and coming back keeps the match: paused where it was, or at its end sheet.
  var restored = false;
  ZimiShell.persist({
    save: function () {
      if (mode === 'over' && lastEnd) return { end: lastEnd, kinds: st.kinds };
      return (mode === 'playing' || mode === 'paused') && st ? { st: st } : null;
    },
    load: function (d) {
      var kinds = d.end ? d.kinds : d.st && d.st.kinds;
      if (!kinds || !kinds.length) return false;
      setup.humans = kinds.filter(function (k) { return k === 'person'; }).length; setup.cpus = kinds.length - setup.humans;
      if (armed) armed.cancel();
      if (d.end) {
        st = createState(kinds, 11); buildKeys(); mode = 'over'; lastEnd = d.end; layout(); hud();
        ZimiShell.endSheet(d.end);
        setTimeout(function () { if (mode === 'over') armed = Play.ready({ say: status.say, target: pad.stage, start: begin }); }, READY_ARM_MS);
      } else {
        st = d.st; st.rng = mulberry(Math.floor(Math.random() * 4294967296)); buildKeys(); mode = 'paused';
        els.pause.disabled = false; Play.pauseLabel(els.pause, true); status.say(Tx('play.paused')); layout(); hud();
      }
      restored = true;
      return true;
    }
  });
  // It opens on the live board, ready: who plays has defaults (the last choice) and lives in the New game pane.
  if (!restored) arm();
  root.__blast = { get st() { return st; }, get mode() { return mode; } };
})(this);
