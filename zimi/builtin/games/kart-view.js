/* ZimiGames: ZimiKart, a view. One person's window onto the race: the sky, the Mode-7 floor (the track's texture read through a
   perspective, row by row), sprites sorted far to near, and the HUD. A page draws one view, or two for split screen.
   Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var E = root.KartEngine, A = root.KartArt, ordinal = function (n) { return root.ArcadePlay ? root.ArcadePlay.ordinal(n) : E.ordinal(n); }, TAU = Math.PI * 2;
  var CAM_DIST = 66, CAM_H = 21, ZMAX = 700, FOCAL_W = 0.85, FOCAL_H = 1.1, HORIZON = 0.38, PIX = 1.5, MAX_IW = 300, MIN_IW = 120, SPRITE_FAR = 560, SPRITE_NEAR = 18;
  var BACK_VIEW = 0.95, SIDE_VIEW = 2.2, FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  var CHARGE_COLORS = ['#7fd8ff', '#ffb02e', '#ff6fd0'];

  if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) { this.rect(x, y, w, h); };
  }

  // What a track needs once: its floor, sky, scenery and minimap.
  function prepare(T) {
    var theme = T.def.theme;
    return { T: T, theme: A.THEMES[theme], name: theme, tex: A.buildTexture(T, theme), pano: A.buildPanorama(theme), scenery: A.makeScenery(T, theme), mini: A.buildMini(T, 128) };
  }

  var bufs = [];
  function buffer(slot, iw, ih) {
    var b = bufs[slot];
    if (!b || b.iw !== iw || b.ih !== ih) {
      var cv = A.el(iw, ih), cx = cv.getContext('2d');
      b = bufs[slot] = { iw: iw, ih: ih, can: cv, ctx: cx, img: null, u32: null, rows: 0 };
    }
    return b;
  }
  function metrics(rect) {
    var iw = Math.max(MIN_IW, Math.min(MAX_IW, Math.round(rect.w / PIX))), rr = rect.w / iw, ih = Math.round(rect.h / rr);
    return { iw: iw, ih: ih, rr: rr, f: Math.min(iw * FOCAL_W, ih * FOCAL_H), hz: Math.round(ih * (rect.h > rect.w ? 0.3 : HORIZON)) };
  }

  // The camera sits behind the kart, looking where it points, a little late in the turns.
  function follow(cam, k, dt, snap) {
    var aim = k.angle + E.angDiff(k.dir, k.angle) * 0.5;
    if (snap) cam.yaw = aim; else cam.yaw += E.angDiff(aim, cam.yaw) * (1 - Math.exp(-7 * dt));
    cam.x = k.x - Math.cos(cam.yaw) * CAM_DIST; cam.y = k.y - Math.sin(cam.yaw) * CAM_DIST;
    cam.lift = k.z * 0.5;
  }

  function floor(buf, cam, tex, m) {
    var y0 = m.hz + Math.ceil(CAM_H * m.f / ZMAX), rows = m.ih - y0, iw = m.iw;
    if (rows < 1) return y0;
    if (!buf.img || buf.rows !== rows) { buf.img = buf.ctx.createImageData(iw, rows); buf.u32 = new Uint32Array(buf.img.data.buffer); buf.rows = rows; }
    var d = buf.u32, size = tex.size, data = tex.data, edge = tex.edge, sc = tex.scale, y, x, z, k, ux, uy, px, py, tx, ty, row, h = CAM_H + cam.lift;
    for (y = y0; y < m.ih; y++) {
      z = h * m.f / (y - m.hz); k = z / m.f * sc; ux = cam.rx * k; uy = cam.ry * k;
      px = (cam.x + cam.fx * z) * sc - ux * iw / 2; py = (cam.y + cam.fy * z) * sc - uy * iw / 2; row = (y - y0) * iw;
      for (x = 0; x < iw; x++) {
        tx = px | 0; ty = py | 0;
        d[row + x] = (tx >= 0 && tx < size && ty >= 0 && ty < size) ? data[ty * size + tx] : edge;
        px += ux; py += uy;
      }
    }
    buf.ctx.putImageData(buf.img, 0, 0);
    return y0;
  }

  function sky(c, rect, m, cam, assets) {
    var th = assets.theme, hz = rect.y + m.hz * m.rr, g = c.createLinearGradient(0, rect.y, 0, hz);
    g.addColorStop(0, th.sky[0]); g.addColorStop(1, th.sky[1]);
    c.fillStyle = g; c.fillRect(rect.x, rect.y, rect.w, hz - rect.y + 1);
    var p = assets.pano, sc = m.f * m.rr / (p.w / TAU), half = rect.w / 2 / sc, centre = ((cam.yaw / TAU) % 1 + 1) % 1 * p.w;
    var dh = p.h * sc, dy = hz - dh, start = centre - half, w = half * 2;
    start = ((start % p.w) + p.w) % p.w;
    var first = Math.min(w, p.w - start);
    c.imageSmoothingEnabled = true;
    c.drawImage(p.canvas, start, 0, first, p.h, rect.x, dy, first * sc, dh);
    if (first < w) c.drawImage(p.canvas, 0, 0, w - first, p.h, rect.x + first * sc, dy, (w - first) * sc, dh);
  }

  // ── sprites ──────────────────────────────────────────────────────────────
  function shadow(c, s, wide) { c.fillStyle = 'rgba(0,0,0,0.28)'; c.beginPath(); c.ellipse(0, 0, 6.4 * (wide || 1), 2.4 * (wide || 1), 0, 0, TAU); c.fill(); }
  function drawKart(c, k, p, camYaw, t, o) {
    var d = k.driver, rel = E.angDiff(k.angle + (k.spin > 0 ? k.spinA : 0), camYaw), a = Math.abs(rel), view = a < BACK_VIEW ? 'back' : a < SIDE_VIEW ? 'side' : 'front';
    c.save(); c.translate(p.sx, p.sy); c.scale(p.scale, p.scale);
    shadow(c, 1, 1);
    if (o.ghost) c.globalAlpha = 0.42;
    else if (k.inv > 0 && k.spin <= 0 && Math.floor(t * 14) % 2) c.globalAlpha = 0.55;
    c.translate(view === 'back' ? Math.sin(rel) * 3 : 0, -k.z - k.hop * 1.6);
    if (k.bonk > 0.15) c.translate((Math.floor(t * 40) % 2 ? 1 : -1) * 0.6, 0);
    if (k.boost > 0 && !o.ghost && !o.still) { // a flame out of the back
      c.fillStyle = '#ff9a1f'; var fl = 6 + (Math.floor(t * 30) % 3) * 2.2;
      c.beginPath(); c.moveTo(-2.2, -4); c.lineTo(0, -4 + (view === 'front' ? 0 : fl * 0.6)); c.lineTo(2.2, -4); c.fill();
    }
    A.kartSprite(c, d, view, { lean: k.drift ? k.drift * 1.6 : k.steer, flip: rel > 0 ? 1 : -1, bob: k.spin > 0 ? 0 : 0 });
    if (k.drift && !o.ghost) { // sparks off the back wheels, by how far the drift has charged
      var lv = E.driftLevel(k.charge), col = CHARGE_COLORS[Math.max(0, lv - 1)];
      for (var i = 0; i < 4; i++) { c.fillStyle = lv ? col : '#ddd'; var sx = (i % 2 ? 1 : -1) * (5 + (i >> 1) * 1.8) + k.drift * -1, sy = -1 - ((t * 30 + i * 7) % 6) * 0.6; c.fillRect(sx - 0.5, sy, 1.3, 1.3); }
    }
    if (k.shield > 0) { c.globalAlpha = 0.5 + (o.still ? 0 : 0.2 * Math.sin(t * 8)); c.fillStyle = 'rgba(80,220,200,0.28)'; c.strokeStyle = '#3fe0c8'; c.lineWidth = 1; c.beginPath(); c.arc(0, -8, 11.5, 0, TAU); c.fill(); c.stroke(); }
    if (k.magnet > 0) { c.strokeStyle = 'rgba(255,90,80,0.8)'; c.lineWidth = 0.9; for (var r = 0; r < 2; r++) { c.beginPath(); c.arc(0, -8, 9 + ((t * 14 + r * 5) % 10), -2.2, -0.9); c.stroke(); } }
    if (k.spin > 0) { c.globalAlpha = 1; A.disc(c, -6 + Math.sin(t * 20) * 2, -19, 1, '#ffe27a'); A.disc(c, 5, -20 + Math.cos(t * 20), 1, '#ffe27a'); }
    c.restore();
  }
  function drawOil(c, o, p) { c.save(); c.translate(p.sx, p.sy); c.scale(p.scale, p.scale); c.fillStyle = '#12141b'; c.beginPath(); c.ellipse(0, 0, 11, 3.8, 0, 0, TAU); c.fill(); c.fillStyle = 'rgba(150,180,255,0.35)'; c.beginPath(); c.ellipse(-3, -0.4, 4.2, 1.1, 0, 0, TAU); c.fill(); c.restore(); }
  function drawOrb(c, o, p, t) { c.save(); c.translate(p.sx, p.sy - 6 * p.scale); A.itemIcon(c, 'spark', 0, 0, 7 * p.scale); c.restore(); }

  function sceneryDraw(c, s, p) { if (!A.DRAW[s.t]) return; var sp = A.sprite(s.t, s.v), k = p.scale * s.z; c.drawImage(sp.cv, p.sx - sp.ox * k, p.sy - sp.oy * k, sp.w * k, sp.h * k); }

  // ── the view ─────────────────────────────────────────────────────────────
  // rect: where on the canvas (css px). cam: from follow(). k: whose window. opts: { slot, t, still, ghost: {x,y,a,driver}, small }
  function draw(c, rect, cam, k, race, assets, opts) {
    var m = metrics(rect), buf = buffer(opts.slot || 0, m.iw, m.ih), rr = m.rr, T = race.T, i;
    c.save(); c.beginPath(); c.rect(rect.x, rect.y, rect.w, rect.h); c.clip();
    var view = { w: m.iw, h: CAM_H + cam.lift, f: m.f, hz: m.hz }, cm = E.makeCamera(cam.x, cam.y, cam.yaw, view);
    cm.lift = cam.lift;
    sky(c, rect, m, cam, assets);
    var y0 = floor(buf, cm, assets.tex, m), hzCss = rect.y + m.hz * rr, th = assets.theme;
    c.fillStyle = th.haze; c.fillRect(rect.x, hzCss - 1, rect.w, (y0 - m.hz) * rr + 2);
    c.imageSmoothingEnabled = false;
    c.drawImage(buf.can, 0, 0, m.iw, buf.rows, rect.x, rect.y + y0 * rr, rect.w, buf.rows * rr);
    c.imageSmoothingEnabled = true;
    var fog = c.createLinearGradient(0, hzCss, 0, hzCss + (rect.h - m.hz * rr) * 0.5);
    fog.addColorStop(0, th.haze); fog.addColorStop(1, 'rgba(0,0,0,0)');
    c.save(); c.globalAlpha = 0.9; c.fillStyle = fog; c.fillRect(rect.x, hzCss, rect.w, (rect.h - m.hz * rr) * 0.5); c.restore();
    // everything standing on the ground, far to near
    var list = [], reduced = !!opts.still;
    function add(kind, obj, x, y) {
      var p = E.project(cm, x, y);
      if (!p || p.z > SPRITE_FAR || p.z < SPRITE_NEAR) return;
      if (Math.abs(p.sx - m.iw / 2) > m.iw * 0.75 + 40 * p.scale) return;
      list.push({ z: p.z, kind: kind, o: obj, p: { sx: rect.x + p.sx * rr, sy: rect.y + p.sy * rr, scale: p.scale * rr } });
    }
    assets.scenery.forEach(function (s) { add(0, s, s.x, s.y); });
    race.karts.forEach(function (o) { add(1, o, o.x, o.y); });
    T.boxes.forEach(function (b, j) { if (race.boxT[j] <= 0) add(2, b, b.x, b.y); });
    race.oils.forEach(function (o) { add(3, o, o.x, o.y); });
    race.orbs.forEach(function (o) { add(4, o, o.x, o.y); });
    if (opts.ghost) add(5, opts.ghost, opts.ghost.x, opts.ghost.y);
    list.sort(function (a, b) { return b.z - a.z; });
    var t = opts.t;
    for (i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.kind === 0) sceneryDraw(c, s.o, s.p);
      else if (s.kind === 1) drawKart(c, s.o, s.p, cam.yaw, t, { still: reduced });
      else if (s.kind === 2) A.itemCube(c, s.p.sx, s.p.sy - (reduced ? 6 : 6 + Math.sin(t * 3 + s.o.s) * 1.4) * s.p.scale, s.p.scale, reduced ? 0 : t);
      else if (s.kind === 3) drawOil(c, s.o, s.p);
      else if (s.kind === 4) drawOrb(c, s.o, s.p, t);
      else { var g = s.o; drawKart(c, { driver: g.driver, angle: g.a, spin: 0, spinA: 0, inv: 0, z: 0, hop: 0, bonk: 0, boost: 0, drift: 0, steer: 0, shield: 0, magnet: 0, charge: 0 }, s.p, cam.yaw, t, { ghost: true, still: true }); }
    }
    if (k.boost > 0 && !reduced) speedLines(c, rect, t);
    hud(c, rect, k, race, assets, opts);
    c.restore();
  }

  function speedLines(c, rect, t) {
    c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1.4; c.beginPath();
    for (var i = 0; i < 14; i++) {
      var a = (i * 2.399 + Math.floor(t * 18) * 0.7) % TAU, r0 = rect.h * (0.3 + ((i * 37) % 10) / 40), cx = rect.x + rect.w / 2, cy = rect.y + rect.h * 0.5;
      c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0 * 0.7); c.lineTo(cx + Math.cos(a) * (r0 + rect.h * 0.18), cy + Math.sin(a) * (r0 + rect.h * 0.18) * 0.7);
    }
    c.stroke();
  }

  // ── HUD ──────────────────────────────────────────────────────────────────
  // The HUD's words come from the page's table; a bare engine (the tests) has none and shows English.
  function tx(id, vars, plain) { return root.ZimiText ? root.ZimiText.T(id, vars) : plain; }
  function label(c, text, x, y, size, align, fill) {
    c.font = '800 ' + size + 'px ' + FONT; c.textAlign = align || 'left'; c.textBaseline = 'alphabetic';
    c.lineWidth = Math.max(3, size / 5); c.lineJoin = 'round'; c.strokeStyle = 'rgba(8,10,18,0.8)'; c.strokeText(text, x, y);
    c.fillStyle = fill || '#fff'; c.fillText(text, x, y);
  }
  var ROLL = ['boost', 'slick', 'spark', 'shield', 'magnet'];
  function hud(c, rect, k, race, assets, o) {
    var small = o.small, u = Math.max(0.7, Math.min(1.25, Math.min(rect.w / 390, rect.h / 300))), pad = 8 * u, x = rect.x + pad, y = rect.y + pad, clock = E.clockOf(race);
    // item slot
    var sz = 46 * u;
    c.fillStyle = 'rgba(10,14,24,0.55)'; c.beginPath(); c.roundRect(x, y, sz, sz, 10 * u); c.fill();
    c.strokeStyle = k.item ? '#ff9a1f' : 'rgba(255,255,255,0.35)'; c.lineWidth = 2; c.stroke();
    if (k.roll > 0) A.itemIcon(c, ROLL[Math.floor(o.t * 14) % 5], x + sz / 2, y + sz / 2, sz * 0.36);
    else if (k.item) A.itemIcon(c, k.item, x + sz / 2, y + sz / 2, sz * 0.36);
    // place (not when racing alone)
    if (race.karts.length > 1) {
      var place = k.place || 1, big = 30 * u;
      label(c, ordinal(place), x + sz + 8 * u, y + sz * 0.72, big, 'left');
      c.font = '800 ' + big + 'px ' + FONT; var wTxt = c.measureText(ordinal(place)).width;
      label(c, '/' + race.karts.length, x + sz + 8 * u + wTxt + 2, y + sz * 0.72, 13 * u, 'left', '#d6dcea');
    }
    // lap and clock
    var lap = Math.min(race.laps, k.lap + 1);
    label(c, tx('kart.lap', { n: lap + '/' + race.laps }, 'Lap ' + lap + '/' + race.laps), rect.x + rect.w / 2, y + 18 * u, 16 * u, 'center');
    label(c, E.fmtTime(clock), rect.x + rect.w / 2, y + 36 * u, 13 * u, 'center', '#d6dcea');
    // minimap
    var ms = (small ? 70 : 92) * u, mx = rect.x + rect.w - ms - pad, my = rect.y + pad;
    c.fillStyle = 'rgba(10,14,24,0.45)'; c.beginPath(); c.roundRect(mx, my, ms, ms, 10 * u); c.fill();
    c.drawImage(assets.mini.canvas, mx, my, ms, ms);
    var sc = ms / 128;
    race.karts.slice().sort(function (a, b) { return (a === k) - (b === k); }).forEach(function (q) {
      var pt = assets.mini.map(q.x, q.y), isMe = q === k, r = (isMe ? 4.6 : 3.2) * Math.max(0.8, sc * 1.1);
      c.fillStyle = q.driver.kart; c.beginPath(); c.arc(mx + pt[0] * sc, my + pt[1] * sc, r, 0, TAU); c.fill();
      if (isMe) { c.strokeStyle = '#fff'; c.lineWidth = 1.6; c.stroke(); }
    });
    // banners
    var cy = rect.y + rect.h * 0.3, msg = o.banner;
    if (race.count > 0) { var n = Math.ceil(race.count - 0.2); if (n >= 1) label(c, String(Math.min(3, n)), rect.x + rect.w / 2, cy + 20 * u, 78 * u, 'center', '#ffd27a'); else label(c, tx('kart.go', null, 'GO!'), rect.x + rect.w / 2, cy + 20 * u, 70 * u, 'center', '#7dff9a'); }
    else if (race.t - E.COUNT_S < 0.9 && !race.trial) label(c, tx('kart.go', null, 'GO!'), rect.x + rect.w / 2, cy + 20 * u, 70 * u, 'center', '#7dff9a');
    else if (k.finished != null) label(c, race.trial ? tx('kart.finishedTrial', null, 'Finished') : tx('kart.finished', { place: ordinal(k.place) }, 'Finished ' + E.ordinal(k.place)), rect.x + rect.w / 2, cy + 10 * u, 34 * u, 'center', '#ffd27a');
    else if (k.wrong > 1.2) label(c, tx('kart.wrongWay', null, 'Wrong way'), rect.x + rect.w / 2, cy + 10 * u, 30 * u, 'center', '#ff7a6a');
    else if (msg) label(c, msg, rect.x + rect.w / 2, cy + 10 * u, 28 * u, 'center', '#ffd27a');
    if (k.magnet > 0 || k.shield > 0) label(c, (k.shield > 0 ? tx('kart.hudShield', { n: Math.ceil(k.shield) }, 'Shield ' + Math.ceil(k.shield)) : tx('kart.hudMagnet', { n: Math.ceil(k.magnet) }, 'Magnet ' + Math.ceil(k.magnet))), x, y + sz + 18 * u, 12 * u, 'left', '#9ff0e0');
  }

  root.KartView = { prepare: prepare, follow: follow, draw: draw, drawKartPreview: function (c, d, x, y, s, view) { c.save(); c.translate(x, y); c.scale(s, s); A.kartSprite(c, d, view || 'back', { lean: 0 }); c.restore(); }, CAM_DIST: CAM_DIST };
})(this);
