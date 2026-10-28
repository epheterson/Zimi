/* ZimiGames: Carrom, the page. The physics, the rules of a turn and the computer's aim are in carrom-engine.js (the
   computer thinks in a Worker built from that source, with the main thread as the fallback). Our own code and our own
   drawn board, GPL-3.0. Touch: flick the striker. Mouse: drag back from the striker for the aim and the power. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.ZimiCarromEngine || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var E = root.ZimiCarromEngine(), brain = root.EngineKit.client(root.ZimiCarromEngine, 500);
  var B = E.B, MARGIN = 34, VIEW = B + 2 * MARGIN;
  var PULL_MAX = 190, MIN_POWER = 0.07, FLICK_MIN_SPEED = 260, FLICK_MIN_DIST = 16, FLICK_WINDOW_MS = 110, FLICK_GAIN = 1.0;
  var TOUCH_GRAB = 3.4, MOUSE_GRAB = 2.4, STRIP = 54, KEY_STEP = 10, KEY_ANGLE = Math.PI / 90, KEY_POWER = 0.05, DROP_MS = 320, AIM_SHOW_MS = 650, COMPUTER_DELAY_MS = 500, MAX_FRAME_MS = 50;
  function sideName(p) { return UI.side(p === 0 ? 'white' : 'black'); }
  function isYou(p) { return vsCpu() && !G.watching && G.human(p); }

  var G = WK.create({
    id: 'carrom',
    options: WK.standardOptions({ first: 'chess.side.white', second: 'board.black' }),
    onNew: newGame
  });
  var score = WK.scoreBar($('wk-score'), [{ color: 'var(--disc-w)' }, { color: 'var(--disc-b)' }]);
  var canvas = $('cr-canvas'), ctx = canvas.getContext('2d'), wrap = $('cr-wrap');
  var game, phase = 'idle', aim = { angle: 0, power: 0.55, show: false }, drag = null, falling = [], notesLine = '', raf = 0, lastTs = 0, acc = 0, dropped = [], px = 1;

  function me() { return game.turn; }
  function vsCpu() { return G.vsComputer(); }
  function humanTurn() { return phase === 'aim' && !G.over && G.human(me()); }
  // The human sits at the bottom: with the computer moving first the view is turned half way round.
  function viewFlipped() { return vsCpu() && G.settings.side === 'second'; }
  function nameOf(p) { return vsCpu() ? (G.human(p) ? T('board.you') : T('board.zimi')) : sideName(p); }
  // Angles are in board terms: the first side shoots up the board (towards smaller y), the second down it.
  function forwardAngle(p) { return p === 0 ? -Math.PI / 2 : Math.PI / 2; }

  // ── drawing ──
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }
  function fit() {
    var w = Math.max(1, wrap.clientWidth), dpr = Math.min(3, root.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(w * dpr); px = canvas.width / VIEW;
    draw();
  }
  function vx(x, y) { return viewFlipped() ? B - x : x; }
  function vy(x, y) { return viewFlipped() ? B - y : y; }
  function P(x, y) { return [(vx(x, y) + MARGIN) * px, (vy(x, y) + MARGIN) * px]; }
  function circle(x, y, r, fill, stroke, lw) {
    var c = P(x, y); ctx.beginPath(); ctx.arc(c[0], c[1], r * px, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.lineWidth = (lw || 1) * px; ctx.strokeStyle = stroke; ctx.stroke(); }
  }
  function line(x1, y1, x2, y2, stroke, lw, dash) {
    var a = P(x1, y1), b = P(x2, y2);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineWidth = lw * px; ctx.strokeStyle = stroke; ctx.setLineDash(dash ? dash.map(function (d) { return d * px; }) : []); ctx.stroke(); ctx.setLineDash([]);
  }
  function drawBoard() {
    var frame = css('--cr-frame'), wood = css('--cr-board'), ink = css('--cr-line'), pocket = css('--cr-pocket');
    ctx.fillStyle = frame; ctx.fillRect(0, 0, canvas.width, canvas.height);
    var g = ctx.createRadialGradient(VIEW / 2 * px, VIEW / 2 * px, 40 * px, VIEW / 2 * px, VIEW / 2 * px, VIEW * 0.75 * px);
    g.addColorStop(0, wood); g.addColorStop(1, 'rgba(0,0,0,0.0)');
    ctx.fillStyle = wood; ctx.fillRect(MARGIN * px, MARGIN * px, B * px, B * px);
    ctx.fillStyle = g; ctx.fillRect(MARGIN * px, MARGIN * px, B * px, B * px);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 2 * px; ctx.strokeRect(MARGIN * px, MARGIN * px, B * px, B * px);
    // the baselines with the little circles at their ends, and the arrows at the corners
    [0, 1].forEach(function (p) {
      var y = E.BASE_Y[p];
      line(E.BASE_X0 - 6, y - 17, E.BASE_X1 + 6, y - 17, ink, 1.6); line(E.BASE_X0 - 6, y + 17, E.BASE_X1 + 6, y + 17, ink, 1.6);
      circle(E.BASE_X0 - 6, y, 17, null, ink, 1.6); circle(E.BASE_X1 + 6, y, 17, null, ink, 1.6);
      circle(E.BASE_X0 - 6, y, 11, '#b5402f', null); circle(E.BASE_X1 + 6, y, 11, '#b5402f', null);
    });
    // the two side lines (nobody shoots from them in this game: they are part of the look of the board)
    line(E.BASE_Y[1], E.BASE_X0 - 6, E.BASE_Y[1], E.BASE_X1 + 6, ink, 1.2); line(E.BASE_Y[0], E.BASE_X0 - 6, E.BASE_Y[0], E.BASE_X1 + 6, ink, 1.2);
    // the centre: two rings and a star
    circle(E.CENTRE, E.CENTRE, 78, null, ink, 1.6); circle(E.CENTRE, E.CENTRE, 22, null, ink, 1.6);
    for (var i = 0; i < 8; i++) { var a = i * Math.PI / 4; line(E.CENTRE + Math.cos(a) * 24, E.CENTRE + Math.sin(a) * 24, E.CENTRE + Math.cos(a) * 76, E.CENTRE + Math.sin(a) * 76, ink, 0.9); }
    // arcs and arrows in the corners
    E.POCKETS.forEach(function (pk) {
      var sx = pk[0] < B / 2 ? 1 : -1, sy = pk[1] < B / 2 ? 1 : -1;
      line(pk[0] + sx * 52, pk[1] + sy * 52, pk[0] + sx * 135, pk[1] + sy * 135, ink, 1.4);
      circle(pk[0] + sx * 148, pk[1] + sy * 148, 12, null, ink, 1.4);
      circle(pk[0], pk[1], 31, pocket, 'rgba(0,0,0,0.5)', 2);
    });
  }
  var RINGS = { w: ['#f6f0dd', '#d9cfae', '#b9ae8a'], b: ['#3a332b', '#241f1a', '#5b5247'], q: ['#d65a46', '#b5402f', '#f0b2a4'], s: ['#ffe9a3', '#e0a93a', '#8a5d12'] };
  function drawCoin(b, scale, alpha) {
    var c = P(b.x, b.y), r = b.r * px * (scale || 1), p = RINGS[b.kind];
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.beginPath(); ctx.arc(c[0] + 1.5 * px, c[1] + 2 * px, r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fill();
    ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, Math.PI * 2); ctx.fillStyle = p[0]; ctx.fill(); ctx.lineWidth = 1.4 * px; ctx.strokeStyle = p[2]; ctx.stroke();
    ctx.beginPath(); ctx.arc(c[0], c[1], r * 0.66, 0, Math.PI * 2); ctx.lineWidth = 1.2 * px; ctx.strokeStyle = p[1]; ctx.stroke();
    ctx.beginPath(); ctx.arc(c[0], c[1], r * 0.34, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  function drawStriker(s) {
    var c = P(s.x, s.y), r = s.r * px;
    var g = ctx.createRadialGradient(c[0] - r * 0.3, c[1] - r * 0.3, r * 0.1, c[0], c[1], r);
    g.addColorStop(0, '#fff3c6'); g.addColorStop(1, '#e0a93a');
    ctx.beginPath(); ctx.arc(c[0] + 1.5 * px, c[1] + 2 * px, r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fill();
    ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = 2 * px; ctx.strokeStyle = '#8a5d12'; ctx.stroke();
    ctx.beginPath(); ctx.arc(c[0], c[1], r * 0.58, 0, Math.PI * 2); ctx.lineWidth = 1.4 * px; ctx.strokeStyle = 'rgba(138,93,18,0.7)'; ctx.stroke();
  }
  function drawAim() {
    if (!aim.show || !humanTurn() && phase !== 'cpuaim') return;
    var s = game.striker, len = 70 + aim.power * 260, tx = s.x + Math.cos(aim.angle) * len, ty = s.y + Math.sin(aim.angle) * len;
    line(s.x, s.y, tx, ty, 'rgba(255,255,255,0.9)', 3, [10, 8]);
    line(s.x, s.y, tx, ty, 'rgba(0,0,0,0.35)', 1, [10, 8]);
    // the power: an arc around the striker that fills as the power grows
    var c = P(s.x, s.y), r = (s.r + 9) * px;
    ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, Math.PI * 2); ctx.lineWidth = 4 * px; ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(c[0], c[1], r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * aim.power); ctx.lineWidth = 4 * px; ctx.strokeStyle = aim.power > 0.8 ? '#e53935' : '#ffb300'; ctx.stroke();
  }
  function drawTrail() {
    if (!drag || drag.kind !== 'flick' || drag.samples.length < 2) return;
    ctx.beginPath();
    drag.samples.forEach(function (s, i) { var c = P(s.x, s.y); if (i) ctx.lineTo(c[0], c[1]); else ctx.moveTo(c[0], c[1]); });
    ctx.lineWidth = 5 * px; ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.stroke();
  }
  function draw() {
    if (!game) return;
    drawBoard();
    game.bodies.forEach(function (b) { if (b.alive) drawCoin(b); });
    var now = performance.now();
    falling = falling.filter(function (f) { return now - f.t0 < DROP_MS; });
    falling.forEach(function (f) { var t = (now - f.t0) / DROP_MS; drawCoin(Object.assign({}, f.b, { x: f.b.x + (f.px - f.b.x) * t, y: f.b.y + (f.py - f.b.y) * t }), 1 - t * 0.7, 1 - t); });
    if (game.striker.alive && phase !== 'over') drawStriker(game.striker);
    drawAim(); drawTrail();
    if (falling.length && !raf) raf = requestAnimationFrame(frame);   // let the coins finish dropping
  }

  // ── the loop that runs a shot ──
  function frame(ts) {
    raf = 0;
    if (phase !== 'run') { draw(); return; }
    var dt = Math.min(MAX_FRAME_MS, ts - (lastTs || ts)); lastTs = ts; acc += dt / 1000;
    var guard = 0;
    while (acc >= E.DT && guard++ < 400) {
      acc -= E.DT;
      var d = E.step(game, E.DT);
      for (var i = 0; i < d.length; i++) {
        dropped.push(d[i]);
        var pk = nearestPocket(d[i]); falling.push({ b: Object.assign({}, d[i]), t0: ts, px: pk[0], py: pk[1] });
      }
      if (!E.moving(game)) break;
    }
    draw();
    if (!E.moving(game)) { settleShot(); return; }
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function nearestPocket(b) { var best = E.POCKETS[0], bd = Infinity; E.POCKETS.forEach(function (p) { var d = Math.hypot(p[0] - b.x, p[1] - b.y); if (d < bd) { bd = d; best = p; } }); return best; }
  function startRun() { phase = 'run'; dropped = []; acc = 0; lastTs = 0; if (!raf) raf = requestAnimationFrame(frame); }

  // ── shots and turns ──
  function fire(angle, power01OrSpeed, isSpeed) {
    if (phase !== 'aim' && phase !== 'cpuaim') return;
    shotsMade++;
    var speed = isSpeed ? power01OrSpeed : E.MAX_SPEED * Math.pow(power01OrSpeed, 1.15);
    aim.show = false; drag = null;
    E.shoot(game, angle, speed);
    G.say(T(isYou(me()) ? 'carrom.shoot.you' : 'carrom.shoot', { name: nameOf(me()) })); paint();
    startRun();
  }
  function settleShot() {
    var p = me(), who = nameOf(p), res = E.settle(game, dropped), parts = [];
    res.notes.forEach(function (n) {
      var m = n.match(/^(own|theirs) (\d+)$/);
      if (m) parts.push(m[1] === 'own' ? T('carrom.pocketed', { name: who, n: +m[2] }) : T('carrom.theirs', { n: +m[2] }));
      else parts.push(T('carrom.note.' + n.replace(/ /g, '_')));
    });
    notesLine = parts.length ? parts.join(' ') : T('carrom.nothing');
    if (res.over) { phase = 'over'; paint(); win(res.winner); return; }
    startTurn(res.again);
  }
  function win(w) {
    shotsMade++; snapTurn();
    G.finish(T('carrom.allIn', { side: sideName(w).toLowerCase() }), vsCpu() ? (G.human(w) ? 'w' : 'l') : null, sideName(w));
    draw();
  }
  // The position at the start of a turn (a shot in flight is not kept), for leaving and coming back.
  var turnSnap = null, shotsMade = 0;
  function snapTurn() { turnSnap = shotsMade ? JSON.parse(JSON.stringify(game)) : null; }
  function startTurn(again) {
    var p = me();
    phase = 'aim'; aim.show = false;
    var keepX = game.striker.x;
    E.placeStriker(game, again ? keepX : E.CENTRE, p);
    aim.angle = forwardAngle(p); aim.power = 0.55; aim.show = G.human(p);
    syncSliders(); paint();
    var turn = G.human(p) ? (vsCpu() ? T(again ? 'carrom.again' : root.matchMedia && root.matchMedia('(pointer: coarse)').matches ? 'carrom.yourShot.flick' : 'carrom.yourShot.pull') : T('carrom.toShoot', { name: sideName(p) })) : T(isYou(p) ? 'carrom.aiming.you' : 'carrom.aiming', { name: nameOf(p) });
    G.say(notesLine ? UI.noted(notesLine, turn) : turn, !G.human(p));
    notesLine = '';
    snapTurn();
    if (!G.human(p)) computerShot();
  }
  function computerShot() {
    var token = G.begin(), p = me();
    paint();
    brain.ask({ game: JSON.parse(JSON.stringify(game)), player: p, level: G.settings.level }, function (r) {
      if (!G.done(token)) return;
      var shot = r && isFinite(r.speed) ? r : E.chooseShot(game, p, G.settings.level);
      E.placeStriker(game, shot.x, p);
      phase = 'cpuaim'; aim.angle = shot.angle; aim.power = Math.min(1, Math.pow(shot.speed / E.MAX_SPEED, 1 / 1.15)); aim.show = true; draw();
      var t2 = G.begin();
      setTimeout(function () { if (!G.done(t2)) return; fire(shot.angle, shot.speed, true); }, AIM_SHOW_MS);
    });
  }
  function paint() {
    var w = E.remaining(game, 'w'), b = E.remaining(game, 'b'), names = G.names(sideName(0), sideName(1));
    var queen = T(E.queenOnBoard(game) ? 'carrom.queen.board' : game.queenBy >= 0 ? 'carrom.queen.by' : game.pendingQueen >= 0 ? 'carrom.queen.cover' : 'carrom.queen.taken', { side: game.queenBy >= 0 ? sideName(game.queenBy) : '' });
    score([T('carrom.left', { name: names[0], n: w }), T('carrom.left', { name: names[1], n: b })], null, G.over ? -1 : me());
    $('cr-shoot').disabled = !humanTurn();
    canvas.setAttribute('aria-label', T('carrom.aria', { a: sideName(0), wa: w, b: sideName(1), wb: b, queen: queen }));
    draw();
  }

  // ── pointer input ──
  function toBoard(e) {
    var r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * VIEW - MARGIN, y = (e.clientY - r.top) / r.height * VIEW - MARGIN;
    return viewFlipped() ? { x: B - x, y: B - y } : { x: x, y: y };
  }
  function nearStriker(pt, mult) { return Math.hypot(pt.x - game.striker.x, pt.y - game.striker.y) < game.striker.r * mult; }
  function onBaseline(pt) { return Math.abs(pt.y - E.BASE_Y[me()]) < STRIP && pt.x > E.BASE_X0 - 24 && pt.x < E.BASE_X1 + 24; }
  function placeAt(x) { E.placeStriker(game, x, me()); syncSliders(); draw(); }

  canvas.addEventListener('pointerdown', function (e) {
    if (!humanTurn()) return;
    var pt = toBoard(e), touch = e.pointerType === 'touch';
    canvas.focus({ preventScroll: true });
    if (nearStriker(pt, touch ? TOUCH_GRAB : MOUSE_GRAB)) {
      drag = touch ? { kind: 'flick', samples: [{ x: pt.x, y: pt.y, t: performance.now() }], id: e.pointerId } : { kind: 'pull', id: e.pointerId };
      if (!touch) { aim.show = true; updatePull(pt); }
    } else if (onBaseline(pt)) { drag = { kind: 'place', id: e.pointerId }; placeAt(pt.x); }
    else return;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* the pointer is gone already */ }
    e.preventDefault();
  });
  function updatePull(pt) {
    var dx = game.striker.x - pt.x, dy = game.striker.y - pt.y, len = Math.hypot(dx, dy);
    aim.angle = Math.atan2(dy, dx); aim.power = Math.min(1, len / PULL_MAX); aim.show = true; aim.pulling = len;
    syncSliders(); draw();
  }
  canvas.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var pt = toBoard(e);
    if (drag.kind === 'place') placeAt(pt.x);
    else if (drag.kind === 'pull') updatePull(pt);
    else { drag.samples.push({ x: pt.x, y: pt.y, t: performance.now() }); if (drag.samples.length > 40) drag.samples.shift(); draw(); }
  });
  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag; drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    if (cancelled) { aim.show = false; draw(); return; }
    if (d.kind === 'pull') {
      if (aim.power >= MIN_POWER && aim.pulling > 12) fire(aim.angle, aim.power); else { aim.show = G.human(me()); aim.power = 0.55; aim.angle = forwardAngle(me()); syncSliders(); draw(); }
    } else if (d.kind === 'flick') {
      var s = d.samples, last = s[s.length - 1], first = last, i;
      for (i = s.length - 1; i >= 0; i--) { if (last.t - s[i].t <= FLICK_WINDOW_MS) first = s[i]; else break; }
      var dt = Math.max(16, last.t - first.t), vxs = (last.x - first.x) / dt * 1000, vys = (last.y - first.y) / dt * 1000, speed = Math.hypot(vxs, vys), dist = Math.hypot(last.x - s[0].x, last.y - s[0].y);
      if (dist >= FLICK_MIN_DIST && speed >= FLICK_MIN_SPEED) fire(Math.atan2(vys, vxs), Math.min(E.MAX_SPEED, speed * FLICK_GAIN), true);
      else { aim.show = false; G.say(T('carrom.flickHint')); draw(); }
    }
  }
  canvas.addEventListener('pointerup', function (e) { endDrag(e, false); });
  canvas.addEventListener('pointercancel', function (e) { endDrag(e, true); });

  // ── keys and sliders ──
  var sPos = $('cr-pos'), sAng = $('cr-ang'), sPow = $('cr-pow');
  function relAngle() { return aim.angle - forwardAngle(me()); }
  function syncSliders() {
    if (!game) return;
    sPos.value = Math.round((game.striker.x - E.BASE_X0) / (E.BASE_X1 - E.BASE_X0) * 100);
    var deg = Math.round(relAngle() * 180 / Math.PI); sAng.value = Math.max(-80, Math.min(80, ((deg + 540) % 360) - 180)); sPow.value = Math.round(aim.power * 100);
  }
  function fromSliders() {
    if (!humanTurn()) return;
    E.placeStriker(game, E.BASE_X0 + (+sPos.value / 100) * (E.BASE_X1 - E.BASE_X0), me());
    aim.angle = forwardAngle(me()) + (+sAng.value) * Math.PI / 180; aim.power = +sPow.value / 100; aim.show = true; draw();
  }
  [sPos, sAng, sPow].forEach(function (el) { el.addEventListener('input', fromSliders); });
  $('cr-slide').addEventListener('click', function () { var open = $('cr-sliders').hidden; $('cr-sliders').hidden = !open; this.setAttribute('aria-expanded', String(open)); });
  $('cr-shoot').addEventListener('click', function () { if (humanTurn()) fire(aim.angle, aim.power); });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet') || (e.target.tagName === 'INPUT' && e.target.type !== 'range')) return;
    if (!humanTurn()) return;
    var k = e.key.toLowerCase(), step = e.shiftKey ? KEY_STEP * 3 : KEY_STEP, ok = true;
    var flip = viewFlipped() ? -1 : 1;
    if (e.key === 'ArrowLeft') placeAt(game.striker.x - step * flip);
    else if (e.key === 'ArrowRight') placeAt(game.striker.x + step * flip);
    else if (k === 'a') { aim.angle -= KEY_ANGLE * (e.shiftKey ? 4 : 1) * flip; aim.show = true; }
    else if (k === 'd') { aim.angle += KEY_ANGLE * (e.shiftKey ? 4 : 1) * flip; aim.show = true; }
    else if (k === 'w') { aim.power = Math.min(1, aim.power + KEY_POWER); aim.show = true; }
    else if (k === 's') { aim.power = Math.max(0.05, aim.power - KEY_POWER); aim.show = true; }
    else if (e.key === 'Enter' || (e.key === ' ' && e.target === canvas)) { fire(aim.angle, aim.power); }
    else ok = false;
    if (ok) { e.preventDefault(); syncSliders(); draw(); }
  });

  function newGame() {
    game = E.newGame(); shotsMade = 0; phase = 'idle'; falling = []; drag = null; notesLine = ''; dropped = [];
    fit();
    startTurn(false);
  }
  root.addEventListener('resize', fit);
  G.newGame();
  G.persist({
    save: function () { return turnSnap ? { game: turnSnap, phase: phase === 'over' ? 'over' : 'aim' } : null; },
    load: function (d) { game = d.game; shotsMade = 1; falling = []; drag = null; notesLine = ''; dropped = []; fit(); if (d.phase === 'over') { phase = 'over'; paint(); draw(); } else startTurn(false); },
    resume: function () {}
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__cr = { engine: E, game: function () { return game; }, phase: function () { return phase; }, fire: fire, aim: aim, usingWorker: function () { return brain.usingWorker(); }, toScreen: function (x, y) { var r = canvas.getBoundingClientRect(); return [r.left + (vx(x, y) + MARGIN) / VIEW * r.width, r.top + (vy(x, y) + MARGIN) / VIEW * r.height]; } };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
