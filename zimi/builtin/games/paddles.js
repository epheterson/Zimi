/* ZimiGames: Paddles. Our own code, GPL-3.0. No network, no fonts, no modules.
   Two-paddle tennis on a portrait court: you at the bottom, the computer (or a friend, on the same device) at the top.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var W = 360, H = 560, BALL_R = 7, PAD_W = 72, PAD_H = 10, PAD_MARGIN = 30, PAD_SPEED = 560;
  var SERVE_SPEED = 250, SPEED_PER_HIT = 14, MAX_SPEED = 620, MAX_ANGLE = 58 * Math.PI / 180, SERVE_DELAY_S = 0.9, WIN_SCORE = 7;
  var LEVELS = { easy: { speed: 150, error: 46, react: 0.55 }, medium: { speed: 235, error: 24, react: 0.3 }, hard: { speed: 340, error: 8, react: 0.12 } };
  var TOP_Y = PAD_MARGIN, BOTTOM_Y = H - PAD_MARGIN;

  var mulberry = root.ZimiUtil.mulberry32;

  // mode: 'cpu' (the top paddle is the computer) or 'two' (two people share the screen).
  function createState(mode, level, seed) {
    var st = { mode: mode === 'two' ? 'two' : 'cpu', level: LEVELS[level] ? level : 'medium', rng: mulberry(seed === undefined ? Math.floor(Math.random() * 4294967296) : seed),
      top: { x: W / 2, w: PAD_W }, bottom: { x: W / 2, w: PAD_W }, score: { top: 0, bottom: 0 }, status: 'serving', serveT: SERVE_DELAY_S, serveTo: 'top', winner: null, events: [], hits: 0,
      ball: { x: W / 2, y: H / 2, vx: 0, vy: 0, speed: SERVE_SPEED }, aim: 0, aimT: 0, aiming: false, time: 0 };
    st.serveTo = st.rng() < 0.5 ? 'top' : 'bottom';
    return st;
  }

  function event(st, name, data) { st.events.push({ name: name, data: data }); }

  function launchBall(st) {
    var b = st.ball, a = (st.rng() - 0.5) * 0.9, dir = st.serveTo === 'top' ? -1 : 1;
    b.x = W / 2; b.y = H / 2; b.speed = SERVE_SPEED; b.vx = Math.sin(a) * b.speed; b.vy = dir * Math.cos(a) * b.speed;
    st.hits = 0; st.status = 'playing'; st.aimT = 0;
  }

  function clampPaddle(p) { p.x = Math.max(p.w / 2, Math.min(W - p.w / 2, p.x)); }
  // Move a paddle for dt seconds towards a target x, or in a direction (-1, 0, 1).
  function movePaddle(p, ctl, dt) {
    if (!ctl) return;
    if (ctl.target !== undefined && ctl.target !== null) {
      var d = ctl.target - p.x, m = PAD_SPEED * dt;
      p.x += Math.abs(d) <= m ? d : Math.sign(d) * m;
    } else if (ctl.dir) p.x += ctl.dir * PAD_SPEED * dt;
    clampPaddle(p);
  }

  // The computer watches a ball coming at it, off by an error it re-rolls each time the ball turns towards it,
  // after a moment's delay that is shorter the closer the ball gets; a ball going away sends it back to the middle.
  function aiStep(st, dt) {
    var b = st.ball, lv = LEVELS[st.level], target = W / 2;
    if (b.vy < 0 && st.status === 'playing') {
      if (!st.aiming) { st.aiming = true; st.aimT = 0; st.aim = (st.rng() - 0.5) * 2 * lv.error; }
      st.aimT += dt;
      if (st.aimT < lv.react * (b.y / H)) return;
      target = b.x + st.aim;
    } else st.aiming = false;
    var d = target - st.top.x, m = lv.speed * dt;
    st.top.x += Math.abs(d) <= m ? d : Math.sign(d) * m;
    clampPaddle(st.top);
  }

  function score(st, who) {
    st.score[who]++;
    event(st, 'point', who);
    if (st.score[who] >= WIN_SCORE) { st.status = 'over'; st.winner = who; event(st, 'over', who); return; }
    st.status = 'serving'; st.serveT = SERVE_DELAY_S;
    st.serveTo = who === 'top' ? 'bottom' : 'top'; // the ball goes to the player who lost the point
    st.ball.vx = st.ball.vy = 0; st.ball.x = W / 2; st.ball.y = H / 2;
  }

  // The bounce off a paddle: the angle comes from where the ball lands, the speed grows with every hit.
  function paddleBounce(st, p, dirY) {
    var b = st.ball, off = Math.max(-1, Math.min(1, (b.x - p.x) / (p.w / 2 + BALL_R)));
    b.speed = Math.min(MAX_SPEED, b.speed + SPEED_PER_HIT); st.hits++;
    var a = off * MAX_ANGLE;
    b.vx = Math.sin(a) * b.speed; b.vy = dirY * Math.cos(a) * b.speed;
    event(st, 'hit', dirY < 0 ? 'bottom' : 'top');
  }

  // Advance by dt seconds. input: {bottom: {dir, target}, top: {dir, target}} (top is ignored against the computer).
  function step(st, dt, input) {
    if (st.status === 'over') return;
    input = input || {};
    st.time += dt;
    movePaddle(st.bottom, input.bottom, dt);
    if (st.mode === 'two') movePaddle(st.top, input.top, dt); else aiStep(st, dt);
    if (st.status === 'serving') { st.serveT -= dt; if (st.serveT <= 0) launchBall(st); return; }
    var b = st.ball, sub = Math.max(1, Math.ceil(b.speed * dt / (BALL_R * 0.8))), h = dt / sub;
    for (var i = 0; i < sub && st.status === 'playing'; i++) {
      var py = b.y; b.x += b.vx * h; b.y += b.vy * h;
      if (b.x < BALL_R) { b.x = BALL_R; b.vx = Math.abs(b.vx); event(st, 'wall'); }
      else if (b.x > W - BALL_R) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); event(st, 'wall'); }
      // the bottom paddle: the ball's lower edge crosses the paddle's face going down
      var faceB = BOTTOM_Y - PAD_H / 2, faceT = TOP_Y + PAD_H / 2;
      if (b.vy > 0 && py + BALL_R <= faceB + 0.001 && b.y + BALL_R >= faceB && Math.abs(b.x - st.bottom.x) <= st.bottom.w / 2 + BALL_R) { b.y = faceB - BALL_R; paddleBounce(st, st.bottom, -1); }
      else if (b.vy < 0 && py - BALL_R >= faceT - 0.001 && b.y - BALL_R <= faceT && Math.abs(b.x - st.top.x) <= st.top.w / 2 + BALL_R) { b.y = faceT + BALL_R; paddleBounce(st, st.top, 1); }
      else if (b.y > H + BALL_R) score(st, 'top');
      else if (b.y < -BALL_R) score(st, 'bottom');
    }
  }

  var Engine = { W: W, H: H, BALL_R: BALL_R, PAD_H: PAD_H, TOP_Y: TOP_Y, BOTTOM_Y: BOTTOM_Y, PAD_W: PAD_W, PAD_SPEED: PAD_SPEED, WIN_SCORE: WIN_SCORE, MAX_SPEED: MAX_SPEED, SERVE_SPEED: SERVE_SPEED, MAX_ANGLE: MAX_ANGLE, LEVELS: LEVELS, createState: createState, step: step, launchBall: launchBall, mulberry: mulberry };
  root.PaddlesEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  var SETTINGS_KEY = 'zimi.games.paddles.settings', STATS_KEY = 'zimi.games.paddles.stats', CHROME_PX = 190, READY_ARM_MS = 650;
  Play.applyTheme();

  var els = { cv: $('pd-board'), top: $('pd-top'), bot: $('pd-bot'), topName: $('pd-top-name'), botName: $('pd-bot-name'), goal: $('pd-goal'), msg: $('pd-msg'), pause: $('pd-pause'), newBtn: $('pd-new') };
  var settings = Play.load(SETTINGS_KEY, { mode: 'cpu', level: 'medium' }), stats = Play.load(STATS_KEY, { won: 0, played: 0 });
  var st = createState(settings.mode, settings.level), runId = 0, restored = false, mode = 'ready', ctx, status = Play.status(els.msg), armed = null;
  var keys = { bl: false, br: false, tl: false, tr: false }, pointers = {};
  // The felt of a hit or a point: the paddle that struck lights up, and the scorer's big digit brightens, for a moment.
  var HIT_FLASH_S = 0.14, POINT_FLASH_S = 0.7, flashed = { top: -9, bottom: -9 }, scored = { top: -9, bottom: -9 };

  function layout() { ctx = Play.fitCanvas(els.cv, W, H, CHROME_PX, W * 1.3).ctx; draw(); }
  function hud() {
    els.top.textContent = Play.num(st.score.top); els.bot.textContent = Play.num(st.score.bottom); els.goal.textContent = Play.num(WIN_SCORE);
    els.topName.textContent = T(st.mode === 'two' ? 'paddles.top' : 'paddles.computer'); els.botName.textContent = T(st.mode === 'two' ? 'paddles.bottom' : 'paddles.you');
  }

  function controls() {
    var bottom = { dir: (keys.br ? 1 : 0) - (keys.bl ? 1 : 0) }, top = { dir: (keys.tr ? 1 : 0) - (keys.tl ? 1 : 0) };
    Object.keys(pointers).forEach(function (id) { var p = pointers[id]; if (p.zone === 'top') top = { target: p.x }; else bottom = { target: p.x }; });
    return { bottom: bottom, top: top };
  }

  var loop = Play.loop(function (dt) {
    step(st, dt, controls());
    st.events.forEach(function (e) {
      if (e.name === 'hit') flashed[e.data] = st.time;
      if (e.name === 'point') { scored[e.data] = st.time; status.say(T(e.data === 'bottom' ? (st.mode === 'two' ? 'paddles.pointBottom' : 'paddles.pointYou') : (st.mode === 'two' ? 'paddles.pointTop' : 'paddles.pointComputer'))); }
      else if (e.name === 'hit' && st.hits === 1) status.say('');
      else if (e.name === 'over') finish();
    });
    st.events.length = 0;
  }, function () { draw(); hud(); }, 60);

  function digitInk(who) { return 'rgba(255,255,255,' + (st.time - scored[who] < POINT_FLASH_S && !Play.reducedMotion() ? 0.3 : 0.07) + ')'; }
  function pill(x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); ctx.fill(); }
  function draw() {
    if (!ctx) return;
    ctx.fillStyle = '#0e0e10'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 2; ctx.setLineDash([10, 10]); ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.strokeRect(1, 1, W - 2, H - 2);
    ctx.font = '700 84px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = digitInk('top'); ctx.fillText(st.score.top, W / 2, H / 2 - 54);
    ctx.fillStyle = digitInk('bottom'); ctx.fillText(st.score.bottom, W / 2, H / 2 + 120);
    ctx.fillStyle = st.time - flashed.top < HIT_FLASH_S ? '#ffffff' : '#f2a516'; pill(st.top.x - st.top.w / 2, TOP_Y - PAD_H / 2, st.top.w, PAD_H, 5);
    ctx.fillStyle = st.time - flashed.bottom < HIT_FLASH_S ? '#ffffff' : '#3fc1e8'; pill(st.bottom.x - st.bottom.w / 2, BOTTOM_Y - PAD_H / 2, st.bottom.w, PAD_H, 5);
    var b = st.ball;
    if (st.status === 'serving' && Math.floor(st.time * 6) % 2 === 0 && !Play.reducedMotion()) ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(b.x, b.y, BALL_R, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
  }

  function releaseAll() { keys.bl = keys.br = keys.tl = keys.tr = false; pointers = {}; }
  function save() { Play.save(SETTINGS_KEY, settings); }
  // Players and the computer's level: one choice, made in the New game pane.
  function options(rebuild) {
    var rows = [Play.optionRow(T('paddles.players'), [['cpu', T('paddles.vsComputer')], ['two', T('paddles.two')]], settings.mode, function (v) { settings.mode = v; save(); if (rebuild) rebuild(); })];
    if (settings.mode === 'cpu') rows.push(Play.optionRow(T('paddles.level'), [['easy', T('paddles.easy')], ['medium', T('paddles.medium')], ['hard', T('paddles.hard')]], settings.level, function (v) { settings.level = v; save(); }));
    return rows;
  }
  function arm() {
    if (armed) armed.cancel();
    armed = Play.ready({ say: status.say, target: els.cv, start: begin, touch: T('paddles.readyTouch'), keys: T('paddles.readyKeys') });
  }
  function begin() {
    if (armed) armed.cancel(); armed = null;
    st = createState(settings.mode, settings.level); runId = Play.runId(); mode = 'playing'; status.say(''); releaseAll(); flashed.top = flashed.bottom = scored.top = scored.bottom = -9;
    els.cv.style.visibility = ''; Play.pauseLabel(els.pause, false); els.pause.disabled = false; hud(); draw(); loop.start();
  }
  function pause() { if (mode !== 'playing') return; mode = 'paused'; loop.stop(); releaseAll(); Play.pauseLabel(els.pause, true); status.say(T('play.paused')); }
  function resume() { if (mode !== 'paused') return; mode = 'playing'; Play.pauseLabel(els.pause, false); status.say(''); loop.start(); }
  function toggle() { if (mode === 'playing') pause(); else resume(); }
  function finish() {
    mode = 'over'; loop.stop(); els.pause.disabled = true; Play.pauseLabel(els.pause, false); releaseAll(); hud(); draw();
    if (st.mode !== 'two') { stats.played++; if (st.winner === 'bottom') stats.won++; Play.save(STATS_KEY, stats); }
    showEnd();
  }
  function showEnd() {
    var two = st.mode === 'two', chips = [[T('paddles.score'), T('paddles.scoreLine', { a: Math.max(st.score.top, st.score.bottom), b: Math.min(st.score.top, st.score.bottom) })]];
    if (!two) chips.push([T('paddles.you'), T('paddles.record', { won: stats.won, played: stats.played })]);
    ZimiShell.endSheet(two ? { result: 'win', name: T(st.winner === 'top' ? 'paddles.top' : 'paddles.bottom'), stats: chips } : { result: st.winner === 'bottom' ? 'win' : 'lose', stats: chips });
    setTimeout(function () { if (mode === 'over') arm(); }, READY_ARM_MS);
  }
  els.newBtn.addEventListener('click', begin);
  els.pause.addEventListener('click', toggle);
  els.cv.addEventListener('pointerdown', function () { if (mode === 'paused') resume(); });
  Play.onHidden(pause);
  ZimiShell.game({
    inProgress: function () { return mode === 'playing' || mode === 'paused'; },
    stats: function () { return stats.played ? [[T('paddles.vsComputer'), T('paddles.record', { won: stats.won, played: stats.played })]] : []; },
    menu: function () { return { options: options() }; }
  });

  // Touch and mouse: the paddle follows the pointer along the court. In two-player play each half is one player's.
  function courtX(e) { var r = els.cv.getBoundingClientRect(); return (e.clientX - r.left) / r.width * W; }
  function zoneOf(e) { var r = els.cv.getBoundingClientRect(); return st.mode === 'two' && (e.clientY - r.top) < r.height / 2 ? 'top' : 'bottom'; }
  els.cv.addEventListener('pointerdown', function (e) {
    if (mode !== 'playing') return;
    e.preventDefault();
    try { els.cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no capture */ }
    pointers[e.pointerId] = { x: courtX(e), zone: zoneOf(e) };
  });
  els.cv.addEventListener('pointermove', function (e) { var p = pointers[e.pointerId]; if (p) p.x = courtX(e); });
  function lift(e) { delete pointers[e.pointerId]; }
  els.cv.addEventListener('pointerup', lift); els.cv.addEventListener('pointercancel', lift);
  els.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  var KEY = { ArrowLeft: 'bl', ArrowRight: 'br', a: 'tl', A: 'tl', d: 'tr', D: 'tr' };
  function mapKey(k) { // against the computer, A and D steer your paddle too
    var m = KEY[k]; if (!m) return null;
    return st.mode === 'cpu' && (m === 'tl' || m === 'tr') ? (m === 'tl' ? 'bl' : 'br') : m;
  }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.ar-sheet:not([hidden])')) return;
    var k = mapKey(e.key);
    if (k) { e.preventDefault(); keys[k] = true; }
    else if (e.key === 'p' || e.key === 'P' || e.key === 'Escape' || e.key === ' ') { e.preventDefault(); if (mode === 'playing' || mode === 'paused') toggle(); }
  });
  document.addEventListener('keyup', function (e) { var k = mapKey(e.key); if (k) keys[k] = false; });
  window.addEventListener('blur', releaseAll);

  window.addEventListener('resize', layout);
  layout(); hud();
  // A match in progress or over is kept; it comes back paused, or on its end sheet, without asking for players again.
  function snapshot() {
    if (mode === 'ready' || mode === 'setup' || !runId) return null;
    return { runId: runId, over: mode === 'over', st: Play.plain(st) };
  }
  function restore(d) {
    if (!d || !d.st) return false;
    st = Play.overlay(createState(d.st.mode, d.st.level), d.st); st.events = []; runId = d.runId; restored = true; flashed.top = flashed.bottom = scored.top = scored.bottom = -9;
    els.cv.style.visibility = ''; hud(); draw();
    if (d.over) { mode = 'over'; els.pause.disabled = true; setTimeout(showEnd, 0); return true; }
    mode = 'paused'; els.pause.disabled = false; Play.pauseLabel(els.pause, true); status.say(T('play.paused'));
    return true;
  }
  ZimiShell.persist({ save: snapshot, load: restore });
  // It opens on the live court, ready; players and level have their last choice and live in the New game pane.
  if (!restored) { draw(); arm(); }
  root.__paddles = { get st() { return st; }, get mode() { return mode; }, get pos() { return JSON.stringify([runId, st.mode, st.level, st.score, st.ball, st.top, st.bottom]); } };
})(this);
