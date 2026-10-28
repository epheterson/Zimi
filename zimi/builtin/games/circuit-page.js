/* ZimiGames: Circuit, the page: drawing the track once, the cars, the touch pad, the sheets and the race loop.
   The rules are in circuit.js (CircuitEngine); nothing here changes how a car drives. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Engine = root.CircuitEngine, TRACKS = Engine.TRACKS, BARRIER = Engine.BARRIER, BBOX_MARGIN = Engine.BBOX_MARGIN;
  var wrap = Engine.wrap, clamp = Engine.clamp, mulberry = Engine.mulberry;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, L = Play.T;
  var STORE = 'zimi.games.circuit', VIEW_MIN = 430, SKID_MAX = 500, SKID_SLIDE = 0.4, MINI_MAX = 124, LEAD = 0.3, CAM_RATE = 9, RENDER_MAX_PX = 6e6, BRAKE_LIGHT = 0.3, READY_ARM_MS = 650, HINT_MS = 5000, CHROME_PX = 190, CHROME_SPLIT_PX = 130;
  var CAR_COLORS = ['#f2a516', '#e9eef7', '#d1473f', '#3a63c9', '#3d9a4a', '#8a55c9', '#1e9ec4'];
  var THEMES = {
    park: { ground: '#3f7d4a', ground2: '#386f43', asphalt: '#4a4f5a', kerbA: '#d14b3f', kerbB: '#f1f1ea' },
    city: { ground: '#6b6f78', ground2: '#62666f', asphalt: '#32353c', kerbA: '#e0a21a', kerbB: '#2a2c31' }
  };
  Play.applyTheme();
  var prefs = Play.load(STORE, {});
  prefs = { track: prefs.track || 'oval', laps: prefs.laps || 3, ai: prefs.ai == null ? 4 : prefs.ai, diff: prefs.diff || 'normal', players: prefs.players || 1, tilt: !!prefs.tilt, auto: !!prefs.auto, best: prefs.best || {} };
  function savePrefs() { Play.save(STORE, prefs); }

  var els = { cv: $('cr-board'), lap: $('cr-lap'), pos: $('cr-pos'), time: $('cr-time'), hud: $('cr-hud'), msg: $('cr-msg'), pause: $('cr-pause'), reset: $('cr-reset'), newBtn: $('cr-new') };
  var status = Play.status(els.msg), armed = null, setupSheet = null;
  var coarse = false;
  try { coarse = matchMedia('(pointer: coarse)').matches; } catch (e) { /* desktop */ }

  var ctx, cssW = 0, cssH = 0, pxs = 1;
  var g = { mode: 'setup', race: null, T: null, art: null, humans: [], split: false, heat: 0, heats: [], cams: [], skids: [], lastPos: [], rec: null, wrong: 0, note: '' };
  var held = {}, pad = { left: false, right: false, gas: false, brake: false }, padUI = null, tiltSteer = 0;

  // ── drawing the track once ───────────────────────────────────────────────
  function mkCanvas(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
  function roadPath(c, T, from, count) { // the whole loop, or `count` samples from `from`
    c.beginPath();
    var n = count || T.N, i;
    for (i = 0; i < n; i++) { var k = wrap(from + i, T.N); if (i === 0) c.moveTo(T.x[k], T.y[k]); else c.lineTo(T.x[k], T.y[k]); }
    if (!count) c.closePath();
  }
  function sideLine(c, T, off) { // a barrier line along one side, broken where the road meets itself
    var open = false, i;
    c.beginPath();
    for (i = 0; i <= T.N; i++) {
      var k = i % T.N;
      if (T.zone[k]) { open = false; continue; }
      var px = T.x[k] - T.ty[k] * off, py = T.y[k] + T.tx[k] * off;
      if (!open) { c.moveTo(px, py); open = true; } else c.lineTo(px, py);
    }
  }
  function nearRoad(T, grid, x, y, r) {
    var gx = Math.floor(x / 160), gy = Math.floor(y / 160), a, b, k, list;
    for (a = -2; a <= 2; a++) for (b = -2; b <= 2; b++) {
      list = grid[(gx + a) + ',' + (gy + b)];
      if (list) for (k = 0; k < list.length; k++) { if (Math.hypot(T.x[list[k]] - x, T.y[list[k]] - y) < r) return true; }
    }
    return false;
  }
  function scatter(c, T) { // trees beside a park course, blocks of buildings beside a city one; never on or near the road
    var grid = {}, i, rng = mulberry(11), clear = T.halfW + BARRIER + 24, bb = T.bbox, n, x, y;
    for (i = 0; i < T.N; i++) { var key = Math.floor(T.x[i] / 160) + ',' + Math.floor(T.y[i] / 160); (grid[key] = grid[key] || []).push(i); }
    if (T.theme === 'city') {
      for (n = 0; n < 900; n++) {
        x = bb.x0 + rng() * (bb.x1 - bb.x0); y = bb.y0 + rng() * (bb.y1 - bb.y0);
        var w = 70 + rng() * 80, h = 70 + rng() * 80, r = Math.max(w, h) * 0.72 + clear;
        if (nearRoad(T, grid, x, y, r)) continue;
        var tone = 90 + Math.floor(rng() * 60);
        c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(x - w / 2 + 8, y - h / 2 + 10, w, h);
        c.fillStyle = 'rgb(' + tone + ',' + (tone + 4) + ',' + (tone + 12) + ')'; c.fillRect(x - w / 2, y - h / 2, w, h);
        c.fillStyle = 'rgba(255,255,255,0.14)'; c.fillRect(x - w / 2 + 6, y - h / 2 + 6, w - 12, h - 12);
        c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 2; c.strokeRect(x - w / 2, y - h / 2, w, h);
      }
    } else {
      for (n = 0; n < 1100; n++) {
        x = bb.x0 + rng() * (bb.x1 - bb.x0); y = bb.y0 + rng() * (bb.y1 - bb.y0);
        var tr = 14 + rng() * 16;
        if (nearRoad(T, grid, x, y, clear + tr)) continue;
        c.fillStyle = 'rgba(0,0,0,0.22)'; c.beginPath(); c.arc(x + 6, y + 8, tr, 0, 7); c.fill();
        c.fillStyle = rng() < 0.5 ? '#2f6b3b' : '#2a6034'; c.beginPath(); c.arc(x, y, tr, 0, 7); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.09)'; c.beginPath(); c.arc(x - tr * 0.3, y - tr * 0.3, tr * 0.55, 0, 7); c.fill();
      }
    }
  }
  function drawArt(T) {
    var th = THEMES[T.theme] || THEMES.park, bb = T.bbox, W = bb.x1 - bb.x0, H = bb.y1 - bb.y0, i;
    var S = Math.min(1.25, Math.sqrt(RENDER_MAX_PX / (W * H)));
    var base = mkCanvas(W * S, H * S), c = base.getContext('2d');
    c.scale(S, S); c.translate(-bb.x0, -bb.y0);
    c.fillStyle = th.ground; c.fillRect(bb.x0, bb.y0, W, H);
    var rng = mulberry(5);
    c.fillStyle = th.ground2;
    for (i = 0; i < 380; i++) { c.beginPath(); c.arc(bb.x0 + rng() * W, bb.y0 + rng() * H, 30 + rng() * 80, 0, 7); c.fill(); }
    scatter(c, T);
    c.lineCap = 'butt'; c.lineJoin = 'round';
    [-1, 1].forEach(function (s) { // the barrier
      sideLine(c, T, s * (T.halfW + BARRIER)); c.strokeStyle = '#f1f1ea'; c.lineWidth = 7; c.stroke();
      sideLine(c, T, s * (T.halfW + BARRIER)); c.strokeStyle = '#c0392b'; c.lineWidth = 7; c.setLineDash([14, 14]); c.stroke(); c.setLineDash([]);
    });
    roadPath(c, T, 0); c.strokeStyle = th.kerbB; c.lineWidth = T.width + 18; c.stroke();
    roadPath(c, T, 0); c.strokeStyle = th.kerbA; c.lineWidth = T.width + 18; c.setLineDash([16, 16]); c.stroke(); c.setLineDash([]);
    roadPath(c, T, 0); c.strokeStyle = th.asphalt; c.lineWidth = T.width; c.stroke();
    roadPath(c, T, 0); c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 3; c.setLineDash([22, 26]); c.stroke(); c.setLineDash([]);
    // the start line: a chequered strip across the road at sample 0
    c.save(); c.translate(T.x[0], T.y[0]); c.rotate(Math.atan2(T.ty[0], T.tx[0]));
    var cell = 10, cols = Math.round(T.width / cell), k, r;
    for (r = 0; r < 2; r++) for (k = 0; k < cols; k++) { c.fillStyle = (r + k) % 2 ? '#f3f3ee' : '#1b1d22'; c.fillRect(-cell + r * cell, -T.width / 2 + k * cell, cell, cell); }
    c.restore();
    var art = { base: base, S: S, th: th, deck: null };
    if (T.bridge) { // the bridge deck is its own layer, drawn over the cars that pass under it
      var a = T.bridge[0], len = (T.bridge[1] - a + T.N) % T.N + 1, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ex = T.width + 40;
      for (i = 0; i < len; i++) { var q = wrap(a + i, T.N); x0 = Math.min(x0, T.x[q]); x1 = Math.max(x1, T.x[q]); y0 = Math.min(y0, T.y[q]); y1 = Math.max(y1, T.y[q]); }
      x0 -= ex; y0 -= ex; x1 += ex; y1 += ex;
      var dc = mkCanvas((x1 - x0) * S, (y1 - y0) * S), d = dc.getContext('2d');
      d.scale(S, S); d.translate(-x0, -y0); d.lineJoin = 'round';
      d.save(); d.translate(7, 9); roadPath(d, T, a, len); d.strokeStyle = 'rgba(0,0,0,0.3)'; d.lineWidth = T.width + 22; d.stroke(); d.restore();
      roadPath(d, T, a, len); d.strokeStyle = '#8b909c'; d.lineWidth = T.width + 22; d.stroke();
      roadPath(d, T, a, len); d.strokeStyle = th.asphalt; d.lineWidth = T.width; d.stroke();
      roadPath(d, T, a, len); d.strokeStyle = 'rgba(255,255,255,0.7)'; d.lineWidth = 3; d.setLineDash([22, 26]); d.stroke();
      art.deck = { cv: dc, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    var bw = W - 2 * BBOX_MARGIN, bh = H - 2 * BBOX_MARGIN, ms = Math.min(MINI_MAX / bw, (MINI_MAX * 0.72) / bh); // the minimap: the line alone
    var mini = mkCanvas(bw * ms + 12, bh * ms + 12), m = mini.getContext('2d');
    m.translate(6, 6); m.scale(ms, ms); m.translate(-(bb.x0 + BBOX_MARGIN), -(bb.y0 + BBOX_MARGIN));
    m.lineJoin = 'round'; roadPath(m, T, 0); m.strokeStyle = 'rgba(255,255,255,0.9)'; m.lineWidth = 5 / ms; m.stroke();
    art.mini = { cv: mini, s: ms, ox: bb.x0 + BBOX_MARGIN, oy: bb.y0 + BBOX_MARGIN };
    return art;
  }
  var artCache = {};
  function artFor(T) { return artCache[T.id] || (artCache[T.id] = drawArt(T)); }

  // ── cars and panes ───────────────────────────────────────────────────────
  function drawCar(c, x, y, h, color, o) {
    c.save(); c.translate(x, y); c.rotate(h);
    if (o.alpha) c.globalAlpha = o.alpha;
    c.fillStyle = 'rgba(0,0,0,0.28)'; c.fillRect(-11, -5, 26, 15);
    c.fillStyle = '#17191e'; c.fillRect(-9, -8.5, 6, 3); c.fillRect(-9, 5.5, 6, 3); c.fillRect(5, -8.5, 6, 3); c.fillRect(5, 5.5, 6, 3);
    c.fillStyle = color; c.beginPath(); c.roundRect(-12, -6, 25, 12, 4); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.28)'; c.fillRect(-12, -1, 25, 2);
    c.fillStyle = '#20252f'; c.beginPath(); c.roundRect(-2, -4.2, 7, 8.4, 2); c.fill();
    c.fillStyle = o.brake ? '#ff3b30' : 'rgba(150,20,20,0.85)'; c.fillRect(-12, -5.5, 2, 3); c.fillRect(-12, 2.5, 2, 3);
    c.fillStyle = 'rgba(255,248,200,0.95)'; c.fillRect(11, -5, 2, 3); c.fillRect(11, 2, 2, 3);
    if (o.ring) { c.strokeStyle = o.ring; c.lineWidth = 2; c.beginPath(); c.arc(0, 0, 17, 0, 7); c.stroke(); }
    c.restore();
  }
  function drawOne(c, focus) {
    drawCar(ctx, c.x, c.y, c.h, CAR_COLORS[c.color % CAR_COLORS.length], { brake: !!c.lastInp && c.lastInp.brake > BRAKE_LIGHT,
      ring: c.human ? (c === focus ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.35)') : null });
  }

  function paneRects() {
    if (g.humans.length < 2) return [{ x: 0, y: 0, w: cssW, h: cssH }];
    if (cssW >= cssH * 1.15) return [{ x: 0, y: 0, w: cssW / 2 - 2, h: cssH }, { x: cssW / 2 + 2, y: 0, w: cssW / 2 - 2, h: cssH }];
    return [{ x: 0, y: 0, w: cssW, h: cssH / 2 - 2 }, { x: 0, y: cssH / 2 + 2, w: cssW, h: cssH / 2 - 2 }];
  }

  function ghostPos() { // where your best lap was at this moment of the lap
    var p = g.humans[0], sv = prefs.best[g.T.id];
    if (!p || !sv || !sv.ghost || p.lapStart == null || p.finished || g.race.phase !== 'racing') return null;
    return Engine.ghostAt(sv.ghost, g.race.t - p.lapStart);
  }

  function bigText(rect, text, color) {
    ctx.save(); ctx.font = '800 64px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeText(text, rect.x + rect.w / 2, rect.y + rect.h * 0.4); ctx.fillStyle = color; ctx.fillText(text, rect.x + rect.w / 2, rect.y + rect.h * 0.4); ctx.restore();
  }

  function drawPane(rect, car, idx) {
    var T = g.T, art = g.art, bb = T.bbox, S = art.S, cam = g.cams[idx], r = g.race, cars = r.cars, i, c;
    var z = Math.min(rect.w, rect.h) / VIEW_MIN, hw = rect.w / 2 / z, hh = rect.h / 2 / z;
    ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
    ctx.fillStyle = art.th.ground; ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2); ctx.scale(z, z); ctx.translate(-cam.x, -cam.y);
    var sx = Math.max(0, (cam.x - hw - bb.x0) * S), sy = Math.max(0, (cam.y - hh - bb.y0) * S); // only the part of the ground in view
    var ex = Math.min(art.base.width, (cam.x + hw - bb.x0) * S), ey = Math.min(art.base.height, (cam.y + hh - bb.y0) * S);
    if (ex > sx && ey > sy) ctx.drawImage(art.base, sx, sy, ex - sx, ey - sy, bb.x0 + sx / S, bb.y0 + sy / S, (ex - sx) / S, (ey - sy) / S);
    ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(15,15,18,0.4)'; ctx.lineWidth = 3;
    ctx.beginPath(); g.skids.forEach(function (s) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }); ctx.stroke();
    var gp = idx === 0 ? ghostPos() : null;
    if (gp) drawCar(ctx, gp.x, gp.y, gp.h, '#ffffff', { alpha: 0.4 });
    for (i = 0; i < cars.length; i++) { c = cars[i]; if (!c.level) drawOne(c, car); }
    if (art.deck) ctx.drawImage(art.deck.cv, art.deck.x, art.deck.y, art.deck.w, art.deck.h);
    for (i = 0; i < cars.length; i++) { c = cars[i]; if (c.level) drawOne(c, car); }
    ctx.restore();
    var mini = art.mini, mw = mini.cv.width, mh = mini.cv.height, ms = Math.min(1, rect.w * 0.34 / mw), dw = mw * ms, dh = mh * ms, mx = rect.x + rect.w - dw - 8, my = rect.y + 8;
    ctx.fillStyle = 'rgba(14,14,16,0.6)'; ctx.beginPath(); ctx.roundRect(mx - 3, my - 3, dw + 6, dh + 6, 6); ctx.fill();
    ctx.drawImage(mini.cv, mx, my, dw, dh);
    cars.forEach(function (o) {
      var px = mx + (6 + (o.x - mini.ox) * mini.s) * ms, py = my + (6 + (o.y - mini.oy) * mini.s) * ms;
      ctx.beginPath(); ctx.arc(px, py, o === car ? 4 : 3, 0, 7); ctx.fillStyle = CAR_COLORS[o.color % CAR_COLORS.length]; ctx.fill();
      ctx.lineWidth = o === car ? 2 : 1; ctx.strokeStyle = o === car ? '#fff' : 'rgba(0,0,0,0.6)'; ctx.stroke();
    });
    if (g.split) { // two panes: each carries its own player's numbers
      ctx.font = '700 14px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(14,14,16,0.6)'; ctx.fillRect(rect.x + 6, rect.y + 6, 190, 24);
      ctx.fillStyle = '#fff';
      ctx.fillText(L('circuit.splitLine', { name: car.name, lap: Math.min(r.laps, Math.max(1, car.maxK + 1)), laps: r.laps, place: ordinal(Engine.standings(r).indexOf(car) + 1) }), rect.x + 12, rect.y + 23);
    }
    if (r.phase === 'countdown') bigText(rect, String(Math.ceil(-r.t)), '#fff');
    else if (r.phase === 'racing' && r.t < 0.9) bigText(rect, L('circuit.go').toUpperCase(), '#f2a516');
    if (car.finished) { ctx.font = '800 26px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#f2a516'; ctx.fillText(L('circuit.finishedBig'), rect.x + rect.w / 2, rect.y + rect.h * 0.28); }
  }

  function render() {
    if (!ctx) return;
    if (!g.race) { ctx.fillStyle = '#2f5a3a'; ctx.fillRect(0, 0, cssW, cssH); return; }
    ctx.fillStyle = '#0e0e10'; ctx.fillRect(0, 0, cssW, cssH);
    var rects = paneRects();
    g.humans.forEach(function (car, i) { drawPane(rects[i], car, i); });
    hud();
  }

  // ── cameras, skids, the numbers ──────────────────────────────────────────
  function followCams(dt, snap) {
    g.humans.forEach(function (car, i) {
      var cam = g.cams[i] || (g.cams[i] = { x: car.x, y: car.y }), k = snap ? 1 : Math.min(1, CAM_RATE * dt);
      cam.x += (car.x + car.vx * LEAD - cam.x) * k; cam.y += (car.y + car.vy * LEAD - cam.y) * k;
    });
  }
  function noteSkids() {
    g.race.cars.forEach(function (c, i) {
      var lp = g.lastPos[i];
      if (lp && c.slide > SKID_SLIDE) { g.skids.push([lp[0], lp[1], c.x, c.y]); if (g.skids.length > SKID_MAX) g.skids.shift(); }
      g.lastPos[i] = [c.x, c.y];
    });
  }
  function fmt(s) { // seconds as m:ss.cc
    if (s == null) return '-';
    var m = Math.floor(s / 60);
    s -= m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }
  var ordinal = Play.ordinal;
  function trackName(d) { return L('circuit.track.' + d.id + '.name'); }
  function trackNote(d) { return L('circuit.track.' + d.id + '.note'); }
  function hud() {
    var r = g.race, p = g.humans[0];
    if (!p) return;
    els.lap.textContent = Math.min(r.laps, Math.max(1, p.maxK + 1)) + '/' + r.laps;
    els.pos.textContent = (Engine.standings(r).indexOf(p) + 1) + '/' + r.cars.length;
    els.time.textContent = r.t < 0 ? '0:00.0' : fmt(r.t).slice(0, -1);
  }

  // ── the race ─────────────────────────────────────────────────────────────
  function inputFor(i, humans) {
    var maps = Engine.KEYMAPS;
    function dir(m) { return { l: m.left.some(function (k) { return held[k]; }), r: m.right.some(function (k) { return held[k]; }), g: m.gas.some(function (k) { return held[k]; }), b: m.brake.some(function (k) { return held[k]; }) }; }
    var d;
    if (humans > 1) d = dir(maps[i]);
    else { var a = dir(maps[0]), b = dir(maps[1]); d = { l: a.l || b.l || pad.left, r: a.r || b.r || pad.right, g: a.g || b.g || pad.gas || prefs.auto, b: a.b || b.b || pad.brake }; }
    var steer = (d.r ? 1 : 0) - (d.l ? 1 : 0);
    if (humans === 1 && prefs.tilt && Math.abs(tiltSteer) > 0.05) steer = tiltSteer;
    return { steer: steer, gas: d.g ? 1 : 0, brake: d.b ? 1 : 0 };
  }

  var loop = Play.loop(function (dt) {
    var r = g.race, hs = r.cars.filter(function (c) { return c.human; });
    hs.forEach(function (c, i) { c.input = inputFor(i, hs.length); });
    Engine.step(r, dt);
    noteSkids(); recordGhost(); followCams(dt, false);
    var p = hs[0];
    if (p && !p.auto && r.phase === 'racing') { // going the wrong way round
      var tg = Engine.pointAt(g.T, p.idx), along = p.vx * tg.tx + p.vy * tg.ty;
      g.wrong = along < -40 ? g.wrong + dt : 0;
      if (g.wrong > 0.8) status.say(L('circuit.wrongWay')); else if (els.msg.textContent === L('circuit.wrongWay')) status.say(g.note);
    }
    r.events.splice(0).forEach(onEvent);
  }, render, 60);

  function say(text, ms) {
    g.note = text; status.say(text);
    Play.later(function () { if (g.note === text) { g.note = ''; status.say(''); } }, ms || 2600);
  }
  function onEvent(e) {
    if (e.type === 'lap' && e.car.human) {
      var sv = prefs.best[g.T.id];
      if (e.car === g.humans[0] && g.rec && g.rec.ok && (!sv || e.time < sv.ms)) {
        prefs.best[g.T.id] = { ms: Math.round(e.time * 1000) / 1000, ghost: g.rec.g.slice() }; savePrefs();
        say(L('circuit.newBest', { time: fmt(e.time) }));
      } else say(L('circuit.lapTime', { time: fmt(e.time) }));
      if (e.car === g.humans[0]) g.rec = { g: [], ok: true, next: 0 };
    } else if (e.type === 'finish' && e.car.human) say(L('circuit.finished', { name: e.car.name }));
    else if (e.type === 'done' && g.mode === 'playing') finishRace();
  }

  // The first person's lap, a sample every 1/GHOST_HZ s, begun at each crossing of the line. The lap that includes the grid does not count.
  function recordGhost() {
    var p = g.humans[0], r = g.race;
    if (!p || p.lapStart == null || p.finished || r.phase !== 'racing') return;
    if (!g.rec) g.rec = { g: [], ok: false, next: 0 };
    var rec = g.rec, t = r.t - p.lapStart;
    while (rec.next / Engine.GHOST_HZ <= t) { Engine.ghostPush(rec.g, p.x, p.y, p.h); rec.next++; }
  }

  function startRace() {
    var T = Engine.track(prefs.track), heats = prefs.players === 2 && coarse;
    g.split = prefs.players === 2 && !heats;
    g.T = T; g.art = artFor(T); g.skids = []; g.lastPos = []; g.cams = []; g.note = ''; g.wrong = 0; g.rec = null;
    var names = heats ? [L('circuit.player', { n: g.heat + 1 })] : g.split ? [L('circuit.player', { n: 1 }), L('circuit.player', { n: 2 })] : [L('circuit.you')];
    g.race = Engine.createRace(T.id, { humans: g.split ? 2 : 1, ai: prefs.ai, laps: prefs.laps, difficulty: prefs.diff, names: names, seed: Math.floor(Math.random() * 1e6) });
    g.humans = g.race.cars.filter(function (c) { return c.human; });
    els.hud.hidden = g.split; status.say(''); say(L(coarse ? 'circuit.hintTouch' : 'circuit.hintKeys'), HINT_MS);
    followCams(0, true);
    g.mode = 'playing'; if (armed) { armed.cancel(); armed = null; }
    els.cv.style.visibility = ''; Play.pauseLabel(els.pause, false); els.pause.disabled = false; els.reset.disabled = false;
    layout(); render(); loop.start();
  }

  function pause() {
    if (g.mode !== 'playing') return;
    g.mode = 'paused'; loop.stop(); releaseAll(); Play.pauseLabel(els.pause, true); status.say(L('play.paused'));
  }
  function resume() { if (g.mode !== 'paused') return; g.mode = 'playing'; Play.pauseLabel(els.pause, false); status.say(g.note); loop.start(); }
  function toggle() { if (g.mode === 'playing') pause(); else resume(); }
  function releaseAll() { clearKeys(); pad.left = pad.right = pad.gas = pad.brake = false; if (padUI) padUI.release(); }

  // ── the setup sheet: the real choices (track, laps, rivals, players) ──
  function pref(label, key, choices, after) {
    return Play.optionRow(label, choices, prefs[key], function (v) { prefs[key] = v; savePrefs(); if (after) after(); });
  }
  function twoText() { return L(prefs.players === 2 ? (coarse ? 'circuit.twoPhone' : 'circuit.twoSplit') : 'circuit.oneNote'); }
  function goSetup() {
    g.mode = 'setup'; loop.stop(); g.heat = 0; g.heats = []; els.pause.disabled = true; els.reset.disabled = true; Play.pauseLabel(els.pause, false);
    if (armed) { armed.cancel(); armed = null; }
    if (setupSheet) return;
    var body = document.createElement('div'), pick = document.createElement('div');
    body.className = 'cr-setup';
    pick.className = 'pl-pick cr-tracks'; pick.setAttribute('role', 'radiogroup'); pick.setAttribute('aria-label', L('circuit.track'));
    TRACKS.forEach(function (d) {
      var lab = document.createElement('label'), inp = document.createElement('input'), sp = document.createElement('span'), nm = document.createElement('b'), sm = document.createElement('small'), em = document.createElement('em');
      lab.className = 'pl-opt'; inp.type = 'radio'; inp.name = 'cr-track'; inp.value = d.id; inp.checked = prefs.track === d.id;
      inp.addEventListener('change', function () { prefs.track = d.id; savePrefs(); });
      nm.textContent = trackName(d); sm.textContent = trackNote(d); sp.appendChild(nm); sp.appendChild(sm);
      var sv = prefs.best[d.id]; em.textContent = sv ? fmt(sv.ms) : '';
      lab.appendChild(inp); lab.appendChild(sp); lab.appendChild(em); pick.appendChild(lab);
    });
    body.appendChild(pick);
    var note = document.createElement('p'); note.className = 'cr-note'; note.textContent = twoText();
    body.appendChild(pref(L('circuit.laps'), 'laps', [[2, '2'], [3, '3'], [5, '5']]));
    body.appendChild(pref(L('circuit.rivals'), 'ai', [[3, '3'], [4, '4'], [5, '5']]));
    body.appendChild(pref(L('circuit.rivalsDrive'), 'diff', [['easy', L('circuit.easy')], ['normal', L('circuit.normal')], ['hard', L('circuit.hard')]]));
    body.appendChild(pref(L('circuit.players'), 'players', [[1, '1'], [2, '2']], function () { note.textContent = twoText(); }));
    body.appendChild(note);
    if (coarse && 'DeviceOrientationEvent' in root) body.appendChild(Play.optionRow(L('circuit.tilt'), [[false, L('shell.off')], [true, L('shell.on')]], prefs.tilt, function (v) { prefs.tilt = v; savePrefs(); if (v) askTilt(); }));
    if (coarse) body.appendChild(Play.optionRow(L('circuit.auto'), [[false, L('shell.off')], [true, L('shell.on')]], prefs.auto, function (v) { prefs.auto = v; savePrefs(); }));
    els.cv.style.visibility = 'hidden';
    setupSheet = ZimiShell.sheet({
      title: L('circuit.title'), text: L('circuit.startLine'), body: [body],
      actions: [{ label: L('shell.start'), primary: true, onclick: function () { g.heat = 0; g.heats = []; startRace(); } }],
      onClose: function () {
        setupSheet = null;
        if (g.mode !== 'setup') return;
        els.cv.style.visibility = ''; render();   // dismissed without Start: the page waits, ready
        armed = Play.ready({ say: status.say, target: padUI.stage, start: function () { g.heat = 0; g.heats = []; startRace(); }, touch: L('circuit.readyTouch'), keys: L('circuit.readyKeys') });
      }
    });
  }

  // The phone's two-player heats: the pass-the-phone sheet after the first, the result after the second. Also what a saved heat comes back to.
  function showHeat() {
    var again = function () { g.heat = 0; g.heats = []; startRace(); };
    function timeOf(x) { return x.time ? fmt(x.time) : L('circuit.dnf'); }
      if (g.heat === 0) {
        ZimiShell.sheet({ title: L('circuit.heat', { name: g.heats[0].name, place: ordinal(g.heats[0].pos) }), text: L('circuit.passPhone'), actions: [{ label: L('circuit.nextUp'), primary: true, onclick: function () { g.heat = 1; startRace(); } }] });
        return;
      }
      var a = g.heats[0], z = g.heats[1], tie = a.pos === z.pos && a.time === z.time;
      var win = a.pos !== z.pos ? (a.pos < z.pos ? a : z) : (a.time <= z.time ? a : z);
      ZimiShell.endSheet(tie ? { result: 'draw', onNew: again, stats: [[a.name, ordinal(a.pos)], [z.name, ordinal(z.pos)]] } : { result: 'win', name: win.name, onNew: again, stats: [[a.name, L('circuit.ordTime', { place: ordinal(a.pos), time: timeOf(a) })], [z.name, L('circuit.ordTime', { place: ordinal(z.pos), time: timeOf(z) })]] });
  }
  function placeText(pos, total) { return L('circuit.placeOf', { place: ordinal(pos), total: total }); }
  function finishRace() {
    g.mode = 'over'; loop.stop(); els.pause.disabled = true; els.reset.disabled = true; Play.pauseLabel(els.pause, false); releaseAll(); render();
    var r = g.race, st = Engine.standings(r), heats = prefs.players === 2 && coarse;
    var results = g.humans.map(function (c) { return { name: c.name, pos: st.indexOf(c) + 1, time: c.finishTime, best: c.best }; });
    var again = function () { g.heat = 0; g.heats = []; startRace(); };
    function timeOf(x) { return x.time ? fmt(x.time) : L('circuit.dnf'); }
    if (heats) { g.heats.push(results[0]); showHeat(); return; }
    var sv = prefs.best[g.T.id], note = sv ? L('circuit.recordNote', { time: fmt(sv.ms) }) : '';
    if (g.split) {
      var first = results[0].pos < results[1].pos ? results[0] : results[1];
      ZimiShell.endSheet({ result: 'win', name: first.name, text: note, onNew: again, stats: results.map(function (x) { return [x.name, ordinal(x.pos)]; }) });
      return;
    }
    var me = results[0], chips = [[L('circuit.place'), placeText(me.pos, r.cars.length)], [L('play.time'), timeOf(me)]];
    ZimiShell.endSheet({ result: me.pos === 1 ? 'win' : 'lose', title: me.pos === 1 ? undefined : placeText(me.pos, r.cars.length), text: note, stats: chips });
  }

  // ── input ────────────────────────────────────────────────────────────────
  padUI = Play.pad(els.cv, { dirs: ['left', 'right'], actions: [{ name: 'brake', label: L('play.brake') }, { name: 'gas', label: L('play.gas') }], on: function (name, down) { pad[name] = down; } });
  function keyName(e) { return e.key.length === 1 ? e.key.toLowerCase() : e.key; }
  var USED = { a: 1, d: 1, w: 1, s: 1, ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1 };
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = keyName(e);
    if (document.querySelector('.ar-sheet:not([hidden])')) return;
    if (USED[k]) { e.preventDefault(); held[k] = true; }
    else if (k === 'p' || k === 'Escape') { e.preventDefault(); if (g.mode === 'playing' || g.mode === 'paused') toggle(); }
    else if (k === 'r' && g.mode === 'playing') { e.preventDefault(); resetCar(); }
  });
  document.addEventListener('keyup', function (e) { held[keyName(e)] = false; });
  window.addEventListener('blur', function () { clearKeys(); });
  function clearKeys() { Object.keys(held).forEach(function (k) { held[k] = false; }); }
  function resetCar() { var c = g.humans[0]; if (c && !c.finished) Engine.respawn(g.T, c); }
  els.reset.addEventListener('click', resetCar);
  els.pause.addEventListener('click', toggle);
  els.newBtn.addEventListener('click', goSetup);
  els.cv.addEventListener('pointerdown', function () { if (g.mode === 'paused') resume(); });
  Play.onHidden(pause);

  // Tilt: the phone's roll steers. Off unless asked for; iOS asks first.
  function askTilt() {
    try {
      if (root.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission) DeviceOrientationEvent.requestPermission().catch(function () { prefs.tilt = false; savePrefs(); });
    } catch (e) { prefs.tilt = false; }
  }
  window.addEventListener('deviceorientation', function (e) {
    if (!prefs.tilt || e.gamma == null) return;
    var portrait = window.innerHeight >= window.innerWidth;
    tiltSteer = clamp(((portrait ? e.gamma : e.beta) || 0) / 24, -1, 1);
  });

  // ── layout ───────────────────────────────────────────────────────────────
  function layout() {
    var room = Play.room(g.split ? CHROME_SPLIT_PX : CHROME_PX);
    cssW = Math.floor(Math.min(room.w, 980));
    cssH = Math.floor(Math.max(240, Math.min(room.h, cssW * (cssW < 500 ? 1.35 : g.split && cssW < 700 ? 1.5 : 0.66))));
    pxs = Math.min(window.devicePixelRatio || 1, 2);
    els.cv.style.width = cssW + 'px'; els.cv.style.height = cssH + 'px';
    els.cv.width = Math.floor(cssW * pxs); els.cv.height = Math.floor(cssH * pxs);
    ctx = els.cv.getContext('2d'); ctx.setTransform(pxs, 0, 0, pxs, 0, 0);
    render();
  }
  window.addEventListener('resize', layout);
  layout();
  ZimiShell.game({
    inProgress: function () { return g.mode === 'playing' || g.mode === 'paused'; },
    stats: function () {
      return TRACKS.filter(function (d) { return prefs.best[d.id]; }).map(function (d) { return [L('circuit.trackBest', { track: trackName(d) }), fmt(prefs.best[d.id].ms)]; });
    }
  });
  // A race in progress or finished is kept (the track is rebuilt from its id, the cars and the clock laid back over);
  // it comes back paused, or on its results. Best laps and ghosts already live in prefs; a phone's two-player heats keep the heat and each result so far.
  function snapshot() {
    if (!g.race || g.mode === 'setup') return null;
    var r = Object.assign({}, g.race); delete r.track;
    return { track: g.T.id, split: g.split, heat: g.heat, heats: g.heats, over: g.mode === 'over', rec: g.rec, race: Play.plain(r) };
  }
  function restore(d) {
    if (!d || !d.race || !Engine.track(d.track)) return false;
    var T = Engine.track(d.track), n = d.race.cars.filter(function (c) { return c.human; }).length;
    g.T = T; g.art = artFor(T); g.split = !!d.split; g.heat = d.heat || 0; g.heats = d.heats || []; g.skids = []; g.lastPos = []; g.cams = []; g.note = ''; g.wrong = 0; g.rec = d.rec;
    g.race = Object.assign(Engine.createRace(T.id, { humans: n, ai: d.race.cars.length - n, laps: d.race.laps, difficulty: d.race.difficulty }), d.race);
    g.race.events = [];
    g.humans = g.race.cars.filter(function (c) { return c.human; });
    els.hud.hidden = g.split; els.cv.style.visibility = ''; followCams(0, true);
    if (setupSheet) setupSheet.close();
    if (armed) { armed.cancel(); armed = null; }
    layout(); render();
    if (d.over) { g.mode = 'over'; els.pause.disabled = true; els.reset.disabled = true; setTimeout(g.heats.length ? showHeat : finishRace, 0); return true; }
    g.mode = 'paused'; els.pause.disabled = false; els.reset.disabled = false; Play.pauseLabel(els.pause, true); status.say(L('play.paused'));
    return true;
  }
  ZimiShell.persist({ save: snapshot, load: restore });
  if (!g.race) goSetup();
  root.__circuit = { get g() { return g; }, prefs: prefs, held: held, pad: pad, get pos() { return JSON.stringify([g.T.id, g.heat, g.heats, g.race.t, g.race.laps, g.race.cars.map(function (c) { return [c.x, c.y, c.h, c.vx, c.vy, c.maxK, c.laps]; }), g.rec]); } };
})(this);
