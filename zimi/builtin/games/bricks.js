/* ZimiGames: Bricks (a paddle, a ball, a wall to knock down). Our own code, GPL-3.0.
   No network, no fonts, no modules. The rules (pure functions, no DOM, so node can test them)
   and the page (only when there is a document). The play field is 320 by 440 units; the page scales it. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var W = 320, H = 440;
  var PADDLE_W = 64, PADDLE_H = 10, PADDLE_Y = H - 38, BALL_R = 5;
  var BRICK_COLS = 10, BRICK_W = 28, BRICK_H = 14, BRICK_GAP = 2, BRICK_TOP = 52;
  var MAX_ANGLE = Math.PI / 3;       // off the vertical, at the paddle's very edge
  var MIN_VERTICAL = 0.28;           // a ball is never allowed to go nearly flat
  var SPEED_BASE = 250, SPEED_PER_LEVEL = 18, SPEED_PER_BRICK = 1.2, SPEED_MAX = 430;
  var LAUNCH_ANGLE = 0.5;            // radians off the vertical at the most
  var LIVES = 3, MAX_STEP = 3;       // no more than 3 units of travel between checks, so no tunnelling

  // Levels are data: ten characters a row. . is empty, 1 to 3 is a brick of that many hits,
  // # is a block that never breaks.
  var LEVELS = [
    ['1111111111', '1111111111', '1111111111', '1111111111'],
    ['1212121212', '2121212121', '1212121212', '2121212121'],
    ['....11....', '...1111...', '..111111..', '.11111111.', '1111111111'],
    ['2222222222', '1111111111', '2222222222', '1111111111', '#...#..#..'],
    ['....22....', '...2112...', '..211112..', '...2112...', '....22....'],
    ['3333333333', '2222222222', '1111111111', '..........', '#.#.#.#.#.'],
    ['1.2.3.3.2.', '1.2.3.3.2.', '.1.2.3.3.2', '.1.2.3.3.2', '1.2.3.3.2.'],
    ['3#3#3#3#3#', '2222222222', '3333333333', '1111111111']
  ];

  function buildBricks(rows) {
    var out = [], left = (W - BRICK_COLS * (BRICK_W + BRICK_GAP) + BRICK_GAP) / 2;
    rows.forEach(function (row, r) {
      row.split('').forEach(function (ch, c) {
        if (ch === '.') return;
        var fixed = ch === '#', hp = fixed ? 1 : Number(ch);
        out.push({ x: left + c * (BRICK_W + BRICK_GAP), y: BRICK_TOP + r * (BRICK_H + BRICK_GAP), w: BRICK_W, h: BRICK_H, hp: hp, max: hp, fixed: fixed, row: r });
      });
    });
    return out;
  }

  function levelSpeed(level, broken) { return Math.min(SPEED_MAX, SPEED_BASE + SPEED_PER_LEVEL * level + SPEED_PER_BRICK * broken); }

  function createGame(level, lives, score) {
    var li = ((level || 0) % LEVELS.length + LEVELS.length) % LEVELS.length;
    var g = {
      level: level || 0, bricks: buildBricks(LEVELS[li]), broken: 0,
      paddle: { x: W / 2, w: PADDLE_W }, ball: { x: W / 2, y: PADDLE_Y - PADDLE_H / 2 - BALL_R, vx: 0, vy: 0, stuck: true },
      lives: lives === undefined ? LIVES : lives, score: score || 0, status: 'ready', lastEvent: ''
    };
    g.speed = levelSpeed(g.level, 0);
    return g;
  }

  function movePaddle(g, x) {
    var half = g.paddle.w / 2;
    g.paddle.x = Math.max(half, Math.min(W - half, x));
    if (g.ball.stuck) g.ball.x = g.paddle.x;
  }

  // Send the ball up, a little off the vertical so it is never straight back down.
  function launch(g, side) {
    if (!g.ball.stuck || g.status === 'over') return false;
    var b = g.ball;
    if (side === undefined) { // toward the middle of the field, never dead straight
      var off = (W / 2 - g.paddle.x) / (W / 2);
      side = Math.abs(off) < 0.15 ? 0.3 : off;
    }
    var a = Math.max(-1, Math.min(1, side)) * LAUNCH_ANGLE;
    b.stuck = false; g.status = 'playing';
    b.vx = g.speed * Math.sin(a); b.vy = -g.speed * Math.cos(a);
    return true;
  }

  // Where on the paddle the ball hit, -1 (left edge) to 1 (right edge), is the angle it leaves at.
  function paddleBounce(t, speed) {
    var a = Math.max(-1, Math.min(1, t)) * MAX_ANGLE;
    return { vx: speed * Math.sin(a), vy: -speed * Math.cos(a) };
  }

  // Keep the ball at the level's speed, and never nearly flat.
  function fixVelocity(b, speed) {
    var m = Math.hypot(b.vx, b.vy) || 1;
    b.vx = b.vx / m * speed; b.vy = b.vy / m * speed;
    if (Math.abs(b.vy) < MIN_VERTICAL * speed) {
      var sign = b.vy < 0 ? -1 : 1, sx = b.vx < 0 ? -1 : 1;
      b.vy = sign * MIN_VERTICAL * speed;
      b.vx = sx * Math.sqrt(speed * speed - b.vy * b.vy);
    }
  }

  // Ball against one brick. Returns true when it hit; reflects the ball and pushes it clear.
  function hitBrick(b, k) {
    var cx = Math.max(k.x, Math.min(b.x, k.x + k.w)), cy = Math.max(k.y, Math.min(b.y, k.y + k.h));
    var dx = b.x - cx, dy = b.y - cy, d2 = dx * dx + dy * dy;
    if (d2 >= BALL_R * BALL_R) return false;
    var nx, ny;
    if (d2 === 0) { // the centre is inside: leave by the nearest face
      var l = b.x - k.x, r = k.x + k.w - b.x, t = b.y - k.y, bt = k.y + k.h - b.y, m = Math.min(l, r, t, bt);
      nx = m === l ? -1 : m === r ? 1 : 0; ny = m === t ? -1 : m === bt ? 1 : 0;
      if (nx && ny) ny = 0;
      b.x += nx * (m + BALL_R); b.y += ny * (m + BALL_R);
    } else {
      var d = Math.sqrt(d2); nx = dx / d; ny = dy / d;
      b.x = cx + nx * BALL_R; b.y = cy + ny * BALL_R;
    }
    var dot = b.vx * nx + b.vy * ny;
    if (dot < 0) { b.vx -= 2 * dot * nx; b.vy -= 2 * dot * ny; }
    return true;
  }

  function loseBall(g) {
    g.lives--;
    g.lastEvent = 'lost';
    var b = g.ball; b.stuck = true; b.vx = 0; b.vy = 0;
    if (g.lives <= 0) { g.status = 'over'; return; }
    g.status = 'ready';
    movePaddle(g, g.paddle.x);
    b.y = PADDLE_Y - PADDLE_H / 2 - BALL_R;
  }

  function breakable(g) { return g.bricks.some(function (k) { return !k.fixed; }); }

  function advanceBall(g, h) {
    var b = g.ball;
    b.x += b.vx * h; b.y += b.vy * h;
    if (b.x < BALL_R) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
    else if (b.x > W - BALL_R) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); }
    if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy); }
    if (b.y - BALL_R > H) return loseBall(g);
    var p = g.paddle, top = PADDLE_Y - PADDLE_H / 2;
    if (b.vy > 0 && b.y + BALL_R >= top && b.y - BALL_R <= top + PADDLE_H && Math.abs(b.x - p.x) <= p.w / 2 + BALL_R) {
      var v = paddleBounce((b.x - p.x) / (p.w / 2), g.speed);
      b.vx = v.vx; b.vy = v.vy; b.y = top - BALL_R;
      g.lastEvent = 'paddle';
      return;
    }
    for (var i = 0; i < g.bricks.length; i++) {
      var k = g.bricks[i];
      if (hitBrick(b, k)) {
        if (!k.fixed && --k.hp <= 0) {
          g.bricks.splice(i, 1); g.broken++; g.score += 10 * k.max;
          g.speed = levelSpeed(g.level, g.broken);
          g.lastEvent = 'break';
        } else { g.score += k.fixed ? 0 : 5; g.lastEvent = 'hit'; }
        fixVelocity(b, g.speed);
        if (!breakable(g)) g.status = 'cleared';
        return;
      }
    }
  }

  // Advance by dt seconds, in small steps. Returns the status afterwards.
  function step(g, dt) {
    var b = g.ball;
    if (b.stuck || g.status === 'over' || g.status === 'cleared') return g.status;
    var dist = Math.hypot(b.vx, b.vy) * dt, n = Math.max(1, Math.ceil(dist / MAX_STEP));
    for (var i = 0; i < n && !b.stuck && g.status === 'playing'; i++) advanceBall(g, dt / n);
    return g.status;
  }

  var Engine = {
    W: W, H: H, PADDLE_Y: PADDLE_Y, PADDLE_H: PADDLE_H, BALL_R: BALL_R, MAX_ANGLE: MAX_ANGLE, LEVELS: LEVELS, BRICK_COLS: BRICK_COLS,
    createGame: createGame, movePaddle: movePaddle, launch: launch, step: step, paddleBounce: paddleBounce,
    hitBrick: hitBrick, buildBricks: buildBricks, levelSpeed: levelSpeed
  };
  root.BricksEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var KEY_SPEED = 380;                 // paddle units a second on the keys
  var MAX_CSS_W = 480, CHROME_PX = 210, SIDE_PAD = 24, MAX_DT = 1 / 30, READY_ARM_MS = 650;
  var BREAK_MS = 220, HIT_MS = 130, LOST_MS = 380, LOST_LINE_MS = 1400;
  var BEST_KEY = 'zimi.games.bricks.best';
  Play.applyTheme();

  var els = { cv: $('br-board'), score: $('br-score'), lives: $('br-lives'), level: $('br-level'), best: $('br-best'), msg: $('br-msg'), pause: $('br-pause'), newBtn: $('br-new') };
  var ctx = els.cv.getContext('2d'), status = Play.status(els.msg);
  var fx = [], lostAt = -LOST_LINE_MS, told = '', seen = null, runId = 0, g, scale = 1, mode = 'ready', last = 0, keys = { left: false, right: false }, best = Play.load(BEST_KEY, { score: 0 }), pal = {}, armed = null;

  function readPalette() {
    var s = getComputedStyle(document.documentElement);
    function v(n) { return s.getPropertyValue(n).trim(); }
    pal = { bg: v('--cell'), line: v('--cell-line'), ink: v('--ink'), accent: v('--accent'), fixed: v('--ink3'), rows: ['--p-z', '--p-l', '--p-o', '--p-s', '--p-i', '--p-j', '--p-t'].map(v) };
  }
  function layout() {
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var cssW = Math.max(240, Math.min(vw - SIDE_PAD, MAX_CSS_W, (vh - CHROME_PX) * W / H));
    var dpr = window.devicePixelRatio || 1;
    scale = cssW / W;
    els.cv.width = Math.round(cssW * dpr); els.cv.height = Math.round(cssW * H / W * dpr);
    els.cv.style.width = cssW + 'px'; els.cv.style.height = (cssW * H / W) + 'px';
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    draw();
  }

  function rr(x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); ctx.fill(); }
  function draw() {
    if (!g) return;
    ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);
    g.bricks.forEach(function (k) {
      ctx.fillStyle = k.fixed ? pal.fixed : pal.rows[k.row % pal.rows.length];
      rr(k.x, k.y, k.w, k.h, 3);
      if (k.fixed) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(k.x + 3, k.y + 3, k.w - 6, 3); }
      else {
        ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(k.x + 2, k.y + 2, k.w - 4, 3);
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; // hits left: a pip for each beyond the first
        for (var i = 1; i < k.hp; i++) ctx.fillRect(k.x + 5 + (i - 1) * 6, k.y + k.h - 6, 4, 3);
      }
    });
    var p = g.paddle;
    ctx.fillStyle = pal.ink; rr(p.x - p.w / 2, PADDLE_Y - PADDLE_H / 2, p.w, PADDLE_H, 5);
    ctx.fillStyle = pal.accent; ctx.beginPath(); ctx.arc(g.ball.x, g.ball.y, BALL_R, 0, 7); ctx.fill();
    drawFx();
  }
  // What the ball just did: a brick that broke shrinks away in its own colour, one that only took a hit flashes, a ball
  // lost washes the field red for a moment.
  function drawFx() {
    var now = performance.now();
    fx = fx.filter(function (e) { return now - e.t < e.ms; });
    fx.forEach(function (e) {
      var k = (now - e.t) / e.ms;
      if (e.kind === 'lost') { ctx.fillStyle = 'rgba(192,57,43,' + (0.35 * (1 - k)).toFixed(3) + ')'; ctx.fillRect(0, 0, W, H); return; }
      if (e.kind === 'hit') { ctx.fillStyle = 'rgba(255,255,255,' + (0.8 * (1 - k)).toFixed(3) + ')'; rr(e.x, e.y, e.w, e.h, 3); return; }
      var s = 1 - 0.55 * k;
      ctx.globalAlpha = 1 - k; ctx.fillStyle = e.color; rr(e.x + e.w * (1 - s) / 2, e.y + e.h * (1 - s) / 2, e.w * s, e.h * s, 3); ctx.globalAlpha = 1;
    });
  }
  // Compare the bricks with how they stood a frame ago: gone (broke) or fewer hits left (hit).
  function noticeBricks() {
    var was = seen, now = new Map();
    g.bricks.forEach(function (k) { now.set(k, k.hp); });
    seen = now;
    if (!was || Play.reducedMotion()) return;
    var t = performance.now();
    was.forEach(function (hp, k) {
      var left = now.get(k);
      if (left === undefined) fx.push({ kind: 'break', x: k.x, y: k.y, w: k.w, h: k.h, color: k.fixed ? pal.fixed : pal.rows[k.row % pal.rows.length], t: t, ms: BREAK_MS });
      else if (left < hp) fx.push({ kind: 'hit', x: k.x, y: k.y, w: k.w, h: k.h, t: t, ms: HIT_MS });
    });
  }

  function hud() {
    els.score.textContent = Play.num(g.score); els.level.textContent = Play.num(g.level + 1); els.best.textContent = Play.num(Math.max(best.score, g.score));
    els.lives.textContent = Play.num(Math.max(0, g.lives));
    els.lives.setAttribute('aria-label', T('bricks.livesLeft', { n: Math.max(0, g.lives) }));
  }

  function frame(t) {
    if (mode !== 'playing') return;
    var dt = Math.min(MAX_DT, (t - last) / 1000); last = t;
    var dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    if (dir) movePaddle(g, g.paddle.x + dir * KEY_SPEED * dt);
    var lives = g.lives, st = step(g, dt);
    noticeBricks();
    if (g.lives < lives && !Play.reducedMotion()) { lostAt = performance.now(); fx.push({ kind: 'lost', t: lostAt, ms: LOST_MS }); ZimiShell.shake(els.cv); }
    else if (g.lives < lives) lostAt = performance.now();
    draw(); hud();
    if (st === 'cleared') return levelUp();
    if (st === 'over') return finish();
    tell(!g.ball.stuck ? '' : performance.now() - lostAt < LOST_LINE_MS ? T('bricks.livesLeft', { n: Math.max(0, g.lives) }) : T('bricks.launch'));
    requestAnimationFrame(frame);
  }
  function startLoop() { last = performance.now(); seen = null; requestAnimationFrame(frame); }
  // The status line is written when its words change, not every frame (a screen reader would hear it again each time).
  function tell(text) { if (text !== told) { told = text; status.say(text); } }

  // The ready line: the gesture is said once here. Armed again after a game, once the end sheet is up.
  function arm(touch, keysText, start) {
    if (armed) armed.cancel();
    armed = Play.ready({ say: status.say, target: els.cv, start: start || begin, touch: touch || T('bricks.readyTouch'), keys: keysText || T('bricks.readyKeys') });
  }
  function begin() {
    if (armed) armed.cancel();
    g = createGame(0); runId = Play.runId(); mode = 'playing'; told = ''; fx = []; status.say(''); Play.pauseLabel(els.pause, false); els.pause.disabled = false; hud(); draw(); startLoop();
  }
  function levelUp() {
    var next = createGame(g.level + 1, g.lives, g.score), n = g.level + 2;
    mode = 'between'; hud(); draw();
    status.say(T('bricks.cleared', { n: n - 1 }));
    g = next;
    setTimeout(function () { if (mode === 'between') arm(T('bricks.nextTouch', { n: n }), T('bricks.nextKeys', { n: n }), proceed); }, READY_ARM_MS);
  }
  function pause() { if (mode !== 'playing') return; mode = 'paused'; Play.pauseLabel(els.pause, true); status.say(T('play.paused')); }
  function resume() { if (mode !== 'paused') return; mode = 'playing'; told = ''; Play.pauseLabel(els.pause, false); status.say(''); startLoop(); }
  function toggle() { if (mode === 'playing') pause(); else resume(); }
  function proceed() { mode = 'playing'; told = ''; status.say(''); hud(); draw(); startLoop(); }
  function finish() {
    mode = 'over'; els.pause.disabled = true; Play.pauseLabel(els.pause, false);
    if (g.score > best.score) { best.score = g.score; Play.save(BEST_KEY, best); }
    hud(); showEnd();
  }
  function showEnd() {
    ZimiShell.endSheet({ result: 'over', stats: [[T('play.score'), Play.num(g.score)], [T('play.best'), Play.num(best.score)]] });
    setTimeout(function () { if (mode === 'over') arm(); }, READY_ARM_MS);
  }
  els.newBtn.addEventListener('click', begin);
  els.pause.addEventListener('click', toggle);
  els.cv.addEventListener('pointerdown', function () { if (mode === 'paused') resume(); });
  Play.onHidden(pause);
  ZimiShell.game({
    inProgress: function () { return mode === 'playing' || mode === 'paused' || mode === 'between'; },
    stats: function () { return best.score ? [[T('play.best'), Play.num(best.score)]] : []; }
  });

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.ar-sheet:not([hidden])')) return;
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = true;
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = true;
    else if (k === ' ' || k === 'ArrowUp') { if (mode === 'playing') launch(g, (keys.right ? 1 : 0) - (keys.left ? 1 : 0) || undefined); else if (mode === 'paused') resume(); }
    else if (k === 'Escape' || k === 'p' || k === 'P') { if (mode === 'playing' || mode === 'paused') toggle(); }
    else return;
    e.preventDefault();
  });
  document.addEventListener('keyup', function (e) {
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = false;
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = false;
  });

  function toField(clientX) { return (clientX - els.cv.getBoundingClientRect().left) / scale; }
  Play.gesture(els.cv, {
    down: function (x) { if (mode === 'playing') movePaddle(g, toField(x)); },
    drag: function (dx, dy, e) { if (mode === 'playing') movePaddle(g, toField(e.clientX)); },
    up: function (s) { if (s.tap && mode === 'playing') launch(g); }
  });

  readPalette();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { readPalette(); draw(); });
  window.addEventListener('resize', layout);
  window.addEventListener('blur', function () { keys.left = keys.right = false; });
  g = createGame(0); hud(); layout(); arm();
  // A run in progress or over is kept; it comes back paused (or on its end sheet).
  function snapshot() {
    if (mode === 'ready') return null;
    return { runId: runId, over: mode === 'over', g: Play.plain(g) };
  }
  function restore(d) {
    if (!d || !d.g) return false;
    if (armed) { armed.cancel(); armed = null; }
    g = Play.overlay(createGame(0), d.g); runId = d.runId; hud(); draw();
    if (d.over) { mode = 'over'; els.pause.disabled = true; setTimeout(showEnd, 0); return true; }
    mode = 'paused'; els.pause.disabled = false; Play.pauseLabel(els.pause, true); status.say(T('play.paused'));
    return true;
  }
  ZimiShell.persist({ save: snapshot, load: restore });
  // A read-only window onto the live game, for the browser tests.
  root.__bricks = { get g() { return g; }, get mode() { return mode; }, get pos() { return JSON.stringify([runId, g.level, g.score, g.lives, g.bricks.map(function (k) { return k.hp; }), g.ball, g.paddle]); } };
})(this);
