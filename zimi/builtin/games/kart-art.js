/* ZimiGames: ZimiKart, the pictures. The eight critters and their karts, the item cube and the five items, the floor texture
   a track is drawn onto once, the sky behind it, the scenery beside it, the minimap. All drawn here with canvas paths: no files,
   no network. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var E = root.KartEngine, TAU = Math.PI * 2;
  var TEX = 1280, TEX_SCALE = TEX / E.WORLD, PANO_W = 2048, PANO_H = 150;

  // ── the six looks ────────────────────────────────────────────────────────
  var THEMES = {
    beach:   { sky: ['#6cc8ee', '#e4f5fb'], haze: '#e4f5fb', ground: '#ecd79d', speck: '#dcc183', shoulder: '#f6e8b8', road: '#6b737f', road2: '#626a76', line: '#f4f1e6', kerbA: '#e9573f', kerbB: '#fbfaf5', wallA: '#1f86c0', wallB: '#e8f4fa' },
    library: { sky: ['#2a1c3a', '#6b4a52'], haze: '#6b4a52', ground: '#7a2f3a', speck: '#6a2630', shoulder: '#b88a58', road: '#4a5f80', road2: '#43567a', line: '#ecdca8', kerbA: '#d9a441', kerbB: '#5a3a22', wallA: '#5a3a22', wallB: '#9b6c3c' },
    city:    { sky: ['#070b24', '#4a2f78'], haze: '#4a2f78', ground: '#161a2d', speck: '#212848', shoulder: '#2c3252', road: '#2e3139', road2: '#2a2d35', line: '#f4d35e', kerbA: '#f0a020', kerbB: '#262a35', wallA: '#5a3c8a', wallB: '#ea4f93' },
    snow:    { sky: ['#86aed6', '#eaf2f9'], haze: '#eaf2f9', ground: '#f0f4f9', speck: '#d9e4ef', shoulder: '#d3e3f1', road: '#6f7b89', road2: '#667280', line: '#f4f7fa', kerbA: '#d1473f', kerbB: '#ffffff', wallA: '#9db8d0', wallB: '#ffffff' },
    desert:  { sky: ['#f19a54', '#fbe3b8'], haze: '#fbe3b8', ground: '#d9955a', speck: '#c98349', shoulder: '#ebb783', road: '#8a6a58', road2: '#816150', line: '#f6e3b0', kerbA: '#e0a83a', kerbB: '#7a3b1d', wallA: '#a4502c', wallB: '#cb6e3e' },
    aurora:  { sky: ['#040820', '#17405e'], haze: '#17405e', ground: '#0b0e2e', speck: '#1b2260', shoulder: '#263078', road: '#5646a6', road2: '#4f40a0', line: '#c8f7ea', kerbA: '#38e0b0', kerbB: '#b6ffe6', wallA: '#1e9c8a', wallB: '#46f0c0' }
  };

  function glow(c, x, y, r, rgb) { var g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, 'rgba(' + rgb + ',0.55)'); g.addColorStop(1, 'rgba(' + rgb + ',0)'); c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  function el(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function strokePath(c, T, width, color, dash, off) {
    c.beginPath();
    for (var i = 0; i < T.N; i++) { var x = T.x[i] - T.ty[i] * (off || 0), y = T.y[i] + T.tx[i] * (off || 0); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); }
    c.closePath(); c.lineWidth = width; c.strokeStyle = color; c.lineJoin = 'round'; c.setLineDash(dash || []); c.stroke();
  }
  function strip(c, T, s0, s1, o0, o1, fill) { // a piece of road between two arclengths and two side offsets
    var a = Math.floor(s0 / T.ds), b = Math.ceil(s1 / T.ds), i;
    c.beginPath();
    for (i = a; i <= b; i++) { var p = E.pointAt(T, i * T.ds, o0); if (i === a) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y); }
    for (i = b; i >= a; i--) { var q = E.pointAt(T, i * T.ds, o1); c.lineTo(q.x, q.y); }
    c.closePath(); c.fillStyle = fill; c.fill();
  }

  // The ground the Mode-7 floor reads: one canvas for the whole track, read back as 32-bit pixels.
  function buildTexture(T, theme) {
    var th = THEMES[theme], cv = el(TEX, TEX), c = cv.getContext('2d'), rng = E.mulberry(7 + T.N), i, k;
    c.scale(TEX_SCALE, TEX_SCALE);
    c.fillStyle = th.ground; c.fillRect(0, 0, E.WORLD, E.WORLD);
    for (i = 0; i < 5200; i++) { c.fillStyle = th.speck; var sz = 1.2 + rng() * 3.2; c.fillRect(rng() * E.WORLD, rng() * E.WORLD, sz, sz * (0.5 + rng())); }
    decorGround(c, T, theme, rng);
    var half = T.halfW, reach = T.reach, wall = T.wallW;
    strokePath(c, T, 2 * (reach + wall), th.wallA);
    strokePath(c, T, 2 * (reach + wall), th.wallB, [8, 8]);
    strokePath(c, T, 2 * reach, th.shoulder);
    strokePath(c, T, 2 * (half + 4), th.kerbA);
    strokePath(c, T, 2 * (half + 4), th.kerbB, [10, 10]);
    strokePath(c, T, 2 * half, th.road);
    for (i = 0; i < T.N; i += 9) strip(c, T, i * T.ds, (i + 4) * T.ds, -half, half, th.road2);
    strokePath(c, T, 2.4, th.line, [13, 15]);
    // the start line
    for (k = 0; k < 12; k++) for (i = 0; i < 2; i++) { var p0 = E.pointAt(T, i * 4, -half + k * half / 6), p1 = E.pointAt(T, i * 4 + 4, -half + (k + 1) * half / 6); c.fillStyle = (k + i) % 2 ? '#111' : '#f5f5f5'; strip(c, T, i * 4 - 4, i * 4, -half + k * half / 6, -half + (k + 1) * half / 6, c.fillStyle); }
    // speed pads: orange chevrons
    T.pads.forEach(function (pd) {
      strip(c, T, pd.s - pd.len / 2, pd.s + pd.len / 2, -half * 0.75, half * 0.75, 'rgba(255,150,30,0.14)');
      for (k = 0; k < 3; k++) {
        var s = pd.s - 10 + k * 9, a = E.pointAt(T, s - 3, -half * 0.55), b = E.pointAt(T, s + 3, 0), d = E.pointAt(T, s - 3, half * 0.55);
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.lineTo(d.x, d.y); c.lineWidth = 3.2; c.strokeStyle = '#ff9a1f'; c.lineJoin = 'miter'; c.stroke();
      }
    });
    if (T.gap) {
      strip(c, T, T.gap.from, T.gap.to, -reach, reach, '#1b0f0a');
      for (k = 0; k < 5; k++) strip(c, T, T.gap.from + 3 + k * 8, T.gap.from + 4 + k * 8, -reach, reach, 'rgba(255,120,40,0.18)');
      strip(c, T, T.gap.from - 3, T.gap.from, -reach, reach, '#f6e3b0');
      for (k = 0; k < 8; k++) strip(c, T, T.ramp.from + k * 4.5, T.ramp.from + k * 4.5 + 2.4, -half, half, k % 2 ? '#e0a83a' : '#2a1d14');
    }
    var d = c.getImageData(0, 0, TEX, TEX);
    return { size: TEX, scale: TEX_SCALE, data: new Uint32Array(d.data.buffer), edge: new Uint32Array(d.data.buffer)[0], canvas: cv };
  }

  // Ground details that sit under the road (so it draws over them).
  function decorGround(c, T, theme, rng) {
    var i, n, x, y, r;
    function far(px, py, m) { for (var j = 0; j < T.N; j += 3) if (Math.hypot(T.x[j] - px, T.y[j] - py) < T.reach + T.wallW + m) return false; return true; }
    if (theme === 'beach') for (i = 0; i < 90 && n !== 6; i++) { x = rng() * 1024; y = rng() * 1024; r = 30 + rng() * 40; if (far(x, y, r)) { c.fillStyle = '#2f9ad6'; c.beginPath(); c.ellipse(x, y, r, r * 0.65, rng() * 3, 0, TAU); c.fill(); c.fillStyle = '#6cc6ee'; c.beginPath(); c.ellipse(x, y, r * 0.7, r * 0.42, 0, 0, TAU); c.fill(); n = (n || 0) + 1; } }
    if (theme === 'library') for (i = 0; i < 40; i++) { x = rng() * 1024; y = rng() * 1024; if (far(x, y, 30)) { c.fillStyle = 'rgba(217,164,65,0.35)'; c.fillRect(x - 24, y - 16, 48, 32); c.strokeStyle = 'rgba(217,164,65,0.6)'; c.lineWidth = 2; c.strokeRect(x - 24, y - 16, 48, 32); } }
    if (theme === 'city') for (i = 0; i < 70; i++) { x = rng() * 1024; y = rng() * 1024; if (far(x, y, 12)) { c.fillStyle = rng() < 0.5 ? 'rgba(234,79,147,0.4)' : 'rgba(80,200,255,0.35)'; c.fillRect(x, y, 6 + rng() * 14, 2); } }
    if (theme === 'snow') for (i = 0; i < 60; i++) { x = rng() * 1024; y = rng() * 1024; r = 10 + rng() * 26; if (far(x, y, r)) { c.fillStyle = 'rgba(255,255,255,0.8)'; c.beginPath(); c.ellipse(x, y, r, r * 0.5, 0, 0, TAU); c.fill(); } }
    if (theme === 'desert') for (i = 0; i < 50; i++) { x = rng() * 1024; y = rng() * 1024; r = 20 + rng() * 40; if (far(x, y, r)) { c.fillStyle = 'rgba(160,80,40,0.35)'; c.beginPath(); c.ellipse(x, y, r, r * 0.4, 0.5, 0, TAU); c.fill(); } }
    if (theme === 'aurora') { for (i = 0; i < 260; i++) { c.fillStyle = rng() < 0.5 ? 'rgba(200,255,240,0.8)' : 'rgba(255,255,255,0.6)'; c.fillRect(rng() * 1024, rng() * 1024, 1.6, 1.6); }
      for (i = 0; i < 24; i++) { x = rng() * 1024; y = rng() * 1024; r = 20 + rng() * 40; if (far(x, y, r)) { c.fillStyle = 'rgba(56,224,176,0.16)'; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); } } }
  }

  // The sky behind: a strip that wraps all the way round, drawn once.
  function buildPanorama(theme) {
    var th = THEMES[theme], cv = el(PANO_W, PANO_H), c = cv.getContext('2d'), rng = E.mulberry(31), i, x, g;
    function wrap(fn) { fn(0); fn(-PANO_W); fn(PANO_W); }
    if (theme === 'beach') {
      c.fillStyle = '#58b6e6'; c.fillRect(0, PANO_H - 34, PANO_W, 34); c.fillStyle = 'rgba(255,255,255,0.35)'; for (i = 0; i < 70; i++) c.fillRect(rng() * PANO_W, PANO_H - 32 + rng() * 30, 14 + rng() * 22, 2);
      for (i = 0; i < 5; i++) { x = rng() * PANO_W; var w = 90 + rng() * 120; wrap(function (o) { c.fillStyle = '#3b9a6b'; c.beginPath(); c.moveTo(x + o, PANO_H - 34); c.quadraticCurveTo(x + o + w / 2, PANO_H - 34 - 40 - rng() * 20, x + o + w, PANO_H - 34); c.fill(); }); }
      for (i = 0; i < 12; i++) { x = rng() * PANO_W; wrap(function (o) { c.fillStyle = 'rgba(255,255,255,0.8)'; c.beginPath(); c.ellipse(x + o, 30 + rng() * 30, 40, 11, 0, 0, TAU); c.fill(); }); }
    } else if (theme === 'library') {
      for (i = 0; i < 26; i++) { x = i * (PANO_W / 26); wrap(function (o) { c.fillStyle = '#1d1226'; c.fillRect(x + o + 6, 18, 56, PANO_H - 18); c.fillStyle = '#e9c978'; c.beginPath(); c.moveTo(x + o + 14, PANO_H - 12); c.lineTo(x + o + 14, 56); c.arc(x + o + 34, 56, 20, Math.PI, 0); c.lineTo(x + o + 54, PANO_H - 12); c.fill(); c.fillStyle = '#1d1226'; c.fillRect(x + o + 33, 36, 2, PANO_H - 48); }); }
      c.fillStyle = '#3a2418'; c.fillRect(0, PANO_H - 22, PANO_W, 22);
    } else if (theme === 'city') {
      for (i = 0; i < 70; i++) { x = rng() * PANO_W; var bw = 22 + rng() * 40, bh = 30 + rng() * 90; wrap(function (o) { c.fillStyle = i % 3 ? '#0e1230' : '#181c44'; c.fillRect(x + o, PANO_H - bh, bw, bh); for (var wy = PANO_H - bh + 6; wy < PANO_H - 6; wy += 9) for (var wx = x + o + 4; wx < x + o + bw - 5; wx += 8) if (rng() < 0.45) { c.fillStyle = rng() < 0.7 ? '#ffd86b' : '#8fd8ff'; c.fillRect(wx, wy, 3, 4); } }); }
    } else if (theme === 'snow') {
      for (i = 0; i < 14; i++) { x = i * PANO_W / 14 + rng() * 60; var mw = 140 + rng() * 120, mh = 70 + rng() * 60; wrap(function (o) { c.fillStyle = '#7f9fc0'; c.beginPath(); c.moveTo(x + o, PANO_H); c.lineTo(x + o + mw / 2, PANO_H - mh); c.lineTo(x + o + mw, PANO_H); c.fill(); c.fillStyle = '#ffffff'; c.beginPath(); c.moveTo(x + o + mw / 2 - mw * 0.14, PANO_H - mh * 0.72); c.lineTo(x + o + mw / 2, PANO_H - mh); c.lineTo(x + o + mw / 2 + mw * 0.14, PANO_H - mh * 0.72); c.lineTo(x + o + mw / 2, PANO_H - mh * 0.8); c.fill(); }); }
    } else if (theme === 'desert') {
      c.fillStyle = '#ffd98a'; c.beginPath(); c.arc(PANO_W * 0.3, PANO_H - 50, 30, 0, TAU); c.fill();
      for (i = 0; i < 11; i++) { x = i * PANO_W / 11 + rng() * 40; var mh2 = 40 + rng() * 60, mw2 = 90 + rng() * 80; wrap(function (o) { c.fillStyle = i % 2 ? '#b8603a' : '#9c4a2c'; c.beginPath(); c.moveTo(x + o, PANO_H); c.lineTo(x + o + 10, PANO_H - mh2); c.lineTo(x + o + mw2 - 10, PANO_H - mh2); c.lineTo(x + o + mw2, PANO_H); c.fill(); }); }
    } else {
      for (i = 0; i < 260; i++) { c.fillStyle = 'rgba(255,255,255,' + (0.3 + rng() * 0.6) + ')'; c.fillRect(rng() * PANO_W, rng() * (PANO_H - 20), 1.4, 1.4); }
      var cols = ['rgba(56,224,176,0.5)', 'rgba(70,200,255,0.4)', 'rgba(150,110,255,0.4)'];
      for (i = 0; i < 12; i++) { x = i * PANO_W / 12 + rng() * 60; var col = cols[i % 3]; wrap(function (o) { g = c.createLinearGradient(0, 4, 0, PANO_H - 20); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, col); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.beginPath(); c.moveTo(x + o, PANO_H - 20); c.bezierCurveTo(x + o + 30, 40, x + o + 70, 90, x + o + 150, 8); c.lineTo(x + o + 190, 14); c.bezierCurveTo(x + o + 110, 100, x + o + 60, 60, x + o + 44, PANO_H - 20); c.fill(); }); }
      for (i = 0; i < 16; i++) { x = i * PANO_W / 16; wrap(function (o) { c.fillStyle = '#0a1230'; c.beginPath(); c.moveTo(x + o, PANO_H); c.lineTo(x + o + 60, PANO_H - 24 - (i % 3) * 14); c.lineTo(x + o + 128, PANO_H); c.fill(); }); }
    }
    return { canvas: cv, w: PANO_W, h: PANO_H, theme: th };
  }

  // ── scenery beside the road ──────────────────────────────────────────────
  var SCENERY = {
    beach: ['palm', 'palm', 'umbrella', 'rock'], library: ['lamp', 'books', 'globe'], city: ['tower', 'tower', 'lantern'], snow: ['pine', 'pine', 'pine', 'iceblock'],
    desert: ['cactus', 'cactus', 'pillar', 'rock'], aurora: ['crystal', 'crystal', 'orb']
  };
  function makeScenery(T, theme) {
    var rng = E.mulberry(99 + T.N), out = [], i, side, off, p, lib = theme === 'library', step = lib ? 3 : 7, kinds = SCENERY[theme];
    function clear(x, y, m) { for (var j = 0; j < T.N; j += 2) if (Math.hypot(T.x[j] - x, T.y[j] - y) < T.reach + T.wallW + m) return false; return true; }
    for (i = 0; i < T.N; i += step) {
      for (side = -1; side <= 1; side += 2) {
        if (!lib && rng() < 0.45) continue;
        off = side * (T.reach + T.wallW + (lib ? 9 : 9 + rng() * 26));
        p = E.pointAt(T, i * T.ds, off);
        if (!clear(p.x, p.y, lib ? 4 : 6)) continue;
        out.push({ x: p.x, y: p.y, t: lib ? (i % 9 === 0 ? 'lamp' : i % 6 === 0 ? 'globe' : 'shelf') : kinds[Math.floor(rng() * kinds.length)], v: Math.floor(rng() * 8), z: 0.8 + rng() * 0.5 });
      }
    }
    for (i = 0; i < 110 && !lib; i++) { var x = 30 + rng() * 964, y = 30 + rng() * 964; if (clear(x, y, 12)) out.push({ x: x, y: y, t: kinds[Math.floor(rng() * kinds.length)], v: Math.floor(rng() * 8), z: 0.8 + rng() * 0.6 }); }
    if (lib) for (i = 0; i < 70; i++) { var lx = 30 + rng() * 964, ly = 30 + rng() * 964; if (clear(lx, ly, 14)) out.push({ x: lx, y: ly, t: 'shelf', v: Math.floor(rng() * 8), z: 1 }); }
    return out;
  }
  var SPINES = ['#c0392b', '#2e6fb5', '#d9a441', '#3d8a52', '#7a4aa0', '#e9e1cf', '#d1633a', '#2c8c96'];
  // Each draws with its feet at (0, 0), y up is negative, in world units; the caller scales.
  var DRAW = {
    palm: function (c, v) { c.strokeStyle = '#8a5a30'; c.lineWidth = 1.7; c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(2.5, -11, 1 + (v % 3) - 1, -21); c.stroke(); c.fillStyle = '#2f9a52'; for (var i = 0; i < 6; i++) { var a = i / 6 * TAU; c.beginPath(); c.ellipse(1 + Math.cos(a) * 5, -21 + Math.sin(a) * 2.4, 5.5, 1.5, a * 0.5, 0, TAU); c.fill(); } },
    umbrella: function (c, v) { c.strokeStyle = '#f5f5f0'; c.lineWidth = 0.8; c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -13); c.stroke(); c.fillStyle = v % 2 ? '#e9573f' : '#2e86c1'; c.beginPath(); c.arc(0, -13, 8, Math.PI, 0); c.fill(); c.fillStyle = 'rgba(255,255,255,0.8)'; c.beginPath(); c.moveTo(0, -13); c.arc(0, -13, 8, Math.PI * 1.35, Math.PI * 1.65); c.fill(); },
    rock: function (c, v) { c.fillStyle = '#8c8f99'; c.beginPath(); c.ellipse(0, -3, 6.5, 4.2, 0, 0, TAU); c.fill(); c.fillStyle = 'rgba(255,255,255,0.25)'; c.beginPath(); c.ellipse(-1.6, -4.4, 3, 1.6, 0, 0, TAU); c.fill(); },
    shelf: function (c, v) { c.fillStyle = '#3d2616'; c.fillRect(-9.5, -27, 19, 27); for (var r = 0; r < 4; r++) { var y = -25.5 + r * 6.4; c.fillStyle = '#5b3a22'; c.fillRect(-8.5, y + 5.2, 17, 1.2); for (var b = 0; b < 8; b++) { c.fillStyle = SPINES[(v + b * 3 + r) % 8]; c.fillRect(-8.4 + b * 2.1, y + 0.4 + (b + r) % 2, 1.8, 4.8 - (b + r) % 2); } } },
    lamp: function (c) { glow(c, 0, -19, 12, '255,214,120'); c.strokeStyle = '#6b5030'; c.lineWidth = 1.2; c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -17); c.stroke(); c.fillStyle = '#2f7a4a'; c.beginPath(); c.arc(0, -17, 5, Math.PI, 0); c.fill(); c.fillStyle = '#ffe9a8'; c.fillRect(-3.5, -17, 7, 1.6); },
    books: function (c, v) { for (var i = 0; i < 4; i++) { c.fillStyle = SPINES[(v + i) % 8]; c.fillRect(-6 + (i % 2), -3 * (i + 1), 12 - i, 3); } },
    globe: function (c) { c.fillStyle = '#6b5030'; c.fillRect(-0.7, -7, 1.4, 7); c.fillStyle = '#2e86c1'; c.beginPath(); c.arc(0, -12, 6, 0, TAU); c.fill(); c.fillStyle = '#3d9a4a'; c.beginPath(); c.ellipse(-1.5, -13, 2.6, 3.2, 0.3, 0, TAU); c.ellipse(2.4, -10.5, 1.8, 2, 0, 0, TAU); c.fill(); },
    tower: function (c, v) { var h = 34 + (v % 4) * 12, w = 17 + (v % 3) * 3; c.fillStyle = v % 2 ? '#1a1f45' : '#232a5a'; c.fillRect(-w / 2, -h, w, h); for (var y = -h + 5; y < -4; y += 6) for (var x = -w / 2 + 3; x < w / 2 - 3; x += 5) { c.fillStyle = (x * 7 + y * 3 + v) % 5 < 3 ? '#ffd86b' : '#27305e'; c.fillRect(x, y, 2.6, 3.2); } c.fillStyle = v % 2 ? '#ea4f93' : '#50c8ff'; c.fillRect(-w / 2, -h, w, 1.8); },
    lantern: function (c, v) { glow(c, 0, -17, 11, '240,160,32'); c.strokeStyle = '#444b60'; c.lineWidth = 1; c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -15); c.stroke(); c.fillStyle = '#ffb347'; c.beginPath(); c.ellipse(0, -17, 3.4, 4.4, 0, 0, TAU); c.fill(); },
    pine: function (c, v) { c.fillStyle = '#5b3d26'; c.fillRect(-1, -4, 2, 4); for (var i = 0; i < 3; i++) { var y = -3 - i * 7.5, w = 9 - i * 2; c.fillStyle = '#2f6b4a'; c.beginPath(); c.moveTo(-w, y); c.lineTo(0, y - 11); c.lineTo(w, y); c.fill(); c.fillStyle = '#fafcff'; c.beginPath(); c.moveTo(-w * 0.55, y - 5); c.lineTo(0, y - 11); c.lineTo(w * 0.55, y - 5); c.lineTo(w * 0.2, y - 6.4); c.lineTo(0, y - 4.4); c.lineTo(-w * 0.2, y - 6.4); c.fill(); } },
    iceblock: function (c) { c.fillStyle = 'rgba(190,225,255,0.9)'; c.beginPath(); c.moveTo(-6, 0); c.lineTo(-4, -11); c.lineTo(3, -13); c.lineTo(7, 0); c.fill(); c.fillStyle = 'rgba(255,255,255,0.7)'; c.beginPath(); c.moveTo(-3, -2); c.lineTo(-2, -9); c.lineTo(0, -9); c.lineTo(-1, -2); c.fill(); },
    cactus: function (c, v) { c.fillStyle = '#3f8a4a'; c.beginPath(); c.roundRect(-2.2, -20, 4.4, 20, 2.2); c.fill(); c.beginPath(); c.roundRect(-8, -14, 3.4, 8, 1.7); c.roundRect(-8, -14, 7, 3, 1.5); c.roundRect(4.6, -17, 3.4, 9, 1.7); c.roundRect(1, -17, 7, 3, 1.5); c.fill(); },
    pillar: function (c, v) { var h = 28 + (v % 3) * 9; c.fillStyle = '#b8603a'; c.beginPath(); c.moveTo(-8, 0); c.lineTo(-6, -h); c.lineTo(6.5, -h - 2); c.lineTo(9, 0); c.fill(); c.fillStyle = '#9c4a2c'; c.fillRect(-7, -h * 0.55, 15, 2); c.fillStyle = '#d98a58'; c.fillRect(-7, -h * 0.3, 15, 1.4); },
    crystal: function (c, v) { var h = 20 + (v % 4) * 5; glow(c, 0, -h / 2, Math.min(19, h * 0.75), '70,240,192'); c.fillStyle = '#3fe0b8'; c.beginPath(); c.moveTo(-4, 0); c.lineTo(-2.6, -h * 0.7); c.lineTo(0, -h); c.lineTo(3, -h * 0.65); c.lineTo(4.4, 0); c.fill(); c.fillStyle = 'rgba(255,255,255,0.55)'; c.beginPath(); c.moveTo(-1, -2); c.lineTo(0, -h * 0.9); c.lineTo(1.2, -2); c.fill(); },
    orb: function (c, v) { glow(c, 0, -10, 12, '150,110,255'); c.fillStyle = '#a98cff'; c.beginPath(); c.arc(0, -10, 3.6, 0, TAU); c.fill(); c.fillStyle = '#e8ddff'; c.beginPath(); c.arc(-1, -11, 1.3, 0, TAU); c.fill(); c.strokeStyle = '#6a52b8'; c.lineWidth = 0.8; c.beginPath(); c.moveTo(0, -6); c.lineTo(0, 0); c.stroke(); }
  };

  // Scenery is drawn once per kind into a small canvas, then stamped: a night tower is hundreds of window rectangles.
  var SPRITE_PX = 3.4, SPRITE_W = 44, SPRITE_UP = 78, SPRITE_DOWN = 4, spriteCache = {};
  function sprite(type, v) {
    var key = type + v, hit = spriteCache[key];
    if (hit) return hit;
    var w = Math.ceil(SPRITE_W * SPRITE_PX), h = Math.ceil((SPRITE_UP + SPRITE_DOWN) * SPRITE_PX), cv = el(w, h), c = cv.getContext('2d');
    c.translate(w / 2, SPRITE_UP * SPRITE_PX); c.scale(SPRITE_PX, SPRITE_PX);
    DRAW[type](c, v);
    return (spriteCache[key] = { cv: cv, ox: w / 2 / SPRITE_PX, oy: SPRITE_UP, w: w / SPRITE_PX, h: h / SPRITE_PX });
  }

  // ── the critters and their karts ─────────────────────────────────────────
  function disc(c, x, y, r, f) { c.fillStyle = f; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  function oval(c, x, y, rx, ry, f, rot) { c.fillStyle = f; c.beginPath(); c.ellipse(x, y, rx, ry, rot || 0, 0, TAU); c.fill(); }
  // The head and its ears, centred at (0, 0), radius 4.6. face: show the face; side: -1/1 faces left or right (0 = front or back).
  function critterHead(c, d, face, side) {
    var b = d.body, bl = d.belly, k = d.kind, r = 4.6;
    var back = !face && !side;
    if (k === 'mouse') { disc(c, -3.6, -3.4, 2.9, b); disc(c, 3.6, -3.4, 2.9, b); if (!back) { disc(c, -3.6, -3.4, 1.7, '#f0b4b4'); disc(c, 3.6, -3.4, 1.7, '#f0b4b4'); } }
    else if (k === 'bear') { disc(c, -3.5, -3.6, 1.9, b); disc(c, 3.5, -3.6, 1.9, b); }
    else if (k === 'hare') { oval(c, -1.9, -8, 1.5, 4.6, b, -0.12); oval(c, 1.9, -8, 1.5, 4.6, b, 0.12); if (!back) { oval(c, -1.9, -8, 0.7, 3.4, '#e7a9c8', -0.12); oval(c, 1.9, -8, 0.7, 3.4, '#e7a9c8', 0.12); } }
    else if (k === 'cat') { c.fillStyle = b; c.beginPath(); c.moveTo(-4.4, -1.5); c.lineTo(-3.6, -6.6); c.lineTo(-0.6, -3.6); c.fill(); c.beginPath(); c.moveTo(4.4, -1.5); c.lineTo(3.6, -6.6); c.lineTo(0.6, -3.6); c.fill(); }
    else if (k === 'fox') { c.fillStyle = b; c.beginPath(); c.moveTo(-4.6, -1.2); c.lineTo(-3.4, -7.2); c.lineTo(-0.4, -3.4); c.fill(); c.beginPath(); c.moveTo(4.6, -1.2); c.lineTo(3.4, -7.2); c.lineTo(0.4, -3.4); c.fill(); c.fillStyle = '#2b1a14'; c.beginPath(); c.moveTo(-3.4, -7.2); c.lineTo(-3.9, -5); c.lineTo(-2.4, -5.4); c.fill(); c.beginPath(); c.moveTo(3.4, -7.2); c.lineTo(3.9, -5); c.lineTo(2.4, -5.4); c.fill(); }
    else if (k === 'owl') { c.fillStyle = b; c.beginPath(); c.moveTo(-4.4, -2); c.lineTo(-4.6, -6.4); c.lineTo(-1.6, -3.8); c.fill(); c.beginPath(); c.moveTo(4.4, -2); c.lineTo(4.6, -6.4); c.lineTo(1.6, -3.8); c.fill(); }
    else if (k === 'hog') { c.fillStyle = '#5a3f22'; for (var i = -3; i <= 3; i++) { c.beginPath(); c.moveTo(i * 1.3 - 1.4, -1.6); c.lineTo(i * 1.3, -6.6 + Math.abs(i) * 0.5); c.lineTo(i * 1.3 + 1.4, -1.6); c.fill(); } }
    disc(c, 0, 0, r, b);
    if (k === 'frog') { disc(c, -2.7, -3.6, 2, b); disc(c, 2.7, -3.6, 2, b); if (!back) { disc(c, -2.7, -3.8, 1.2, '#fff'); disc(c, 2.7, -3.8, 1.2, '#fff'); disc(c, -2.7, -3.8, 0.6, '#111'); disc(c, 2.7, -3.8, 0.6, '#111'); } }
    if (back) { return; }
    if (k === 'fox') { c.fillStyle = bl; c.beginPath(); c.moveTo(-4.4, 0.4); c.lineTo(0, 4.2); c.lineTo(4.4, 0.4); c.lineTo(0, 1.2); c.fill(); }
    else if (k === 'bear' || k === 'mouse' || k === 'hare' || k === 'cat' || k === 'hog') oval(c, 0, 1.6, 2.6, 2.0, bl);
    else if (k === 'frog') oval(c, 0, 1.4, 3.2, 1.8, bl);
    else if (k === 'owl') { disc(c, -2, -0.6, 2.2, bl); disc(c, 2, -0.6, 2.2, bl); }
    var ex = side ? side * 1.2 : 0;
    if (k !== 'frog') { disc(c, -1.9 + ex, -0.6, k === 'owl' ? 1.1 : 0.85, '#161616'); disc(c, 1.9 + ex, -0.6, k === 'owl' ? 1.1 : 0.85, '#161616'); }
    disc(c, ex, 1.5, 0.9, k === 'fox' || k === 'cat' ? '#222' : '#c0605a');
    if (k === 'owl') { c.fillStyle = '#f2a516'; c.beginPath(); c.moveTo(-0.9 + ex, 0.8); c.lineTo(0.9 + ex, 0.8); c.lineTo(ex, 2.8); c.fill(); }
  }

  // A kart seen from `view`: 'back', 'side' or 'front'. Drawn with its ground contact at (0, 0), 1 unit = 1 world unit.
  function kartSprite(c, d, view, o) {
    var lean = o.lean || 0, k = d.kart, tr = d.trim;
    c.save();
    c.rotate(lean * 0.09);
    if (view === 'side') {
      c.scale(o.flip || 1, 1);
      disc(c, -4.6, -2.4, 2.5, '#16181d'); disc(c, 4.8, -2.4, 2.5, '#16181d'); disc(c, -4.6, -2.4, 1, '#8a93a3'); disc(c, 4.8, -2.4, 1, '#8a93a3');
      c.fillStyle = k; c.beginPath(); c.roundRect(-7.2, -7.6, 14.4, 5, 2); c.fill();
      c.fillStyle = tr; c.fillRect(-7, -4.4, 14, 1.2);
      oval(c, -2, -9.4, 3, 2.4, d.body); // back
      c.save(); c.translate(1.4, -12.8); c.scale(0.92, 0.92); critterHead(c, d, false, 1); c.restore();
      c.restore(); return;
    }
    var w = 5.1;
    disc(c, -w, -2.4, 2.4, '#16181d'); disc(c, w, -2.4, 2.4, '#16181d');
    c.fillStyle = '#16181d'; c.fillRect(-w - 1.3, -4.8, 2.6, 4.8); c.fillRect(w - 1.3, -4.8, 2.6, 4.8);
    c.fillStyle = k; c.beginPath(); c.roundRect(-5, -8.2, 10, 6.2, 2.2); c.fill();
    c.fillStyle = tr; c.fillRect(-5, -4, 10, 1.3);
    if (view === 'back') { c.fillStyle = '#2a2d36'; c.fillRect(-3.4, -3.4, 1.4, 2); c.fillRect(2, -3.4, 1.4, 2); oval(c, 0, -9.4, 3.6, 3, d.body); if (d.kind === 'fox') { oval(c, 5, -9, 2.2, 3.6, d.body, 0.5); disc(c, 6, -11, 1.2, '#fff'); } }
    else { c.fillStyle = tr; c.fillRect(-4, -8.4, 8, 1.1); oval(c, 0, -9.4, 3.4, 2.4, d.belly); }
    c.save(); c.translate(0, -12.6 - (o.bob || 0)); critterHead(c, d, view === 'front', 0); c.restore();
    // a band in the kart's colour so every driver is told apart at a glance
    c.fillStyle = k; c.beginPath(); c.arc(0, -12.6 - (o.bob || 0), 4.9, Math.PI * 1.08, Math.PI * 1.92); c.lineTo(0, -12.6 - (o.bob || 0)); c.fill();
    c.restore();
  }

  // ── the five items and the cube ──────────────────────────────────────────
  var ITEM_ICON = {
    boost: function (c, r) { c.fillStyle = '#ff9a1f'; c.beginPath(); c.moveTo(-r * 0.7, r * 0.6); c.lineTo(0, -r * 0.1); c.lineTo(r * 0.7, r * 0.6); c.lineTo(r * 0.7, r * 0.2); c.lineTo(0, -r * 0.5); c.lineTo(-r * 0.7, r * 0.2); c.fill(); c.beginPath(); c.moveTo(-r * 0.7, -r * 0.1); c.lineTo(0, -r * 0.8); c.lineTo(r * 0.7, -r * 0.1); c.lineTo(r * 0.7, -r * 0.5); c.lineTo(0, -r * 1.1); c.lineTo(-r * 0.7, -r * 0.5); c.fill(); },
    slick: function (c, r) { c.fillStyle = '#1a1c24'; c.beginPath(); c.ellipse(0, r * 0.15, r * 0.95, r * 0.6, 0, 0, TAU); c.fill(); c.beginPath(); c.arc(r * 0.3, -r * 0.35, r * 0.34, 0, TAU); c.fill(); c.fillStyle = 'rgba(160,190,255,0.7)'; c.beginPath(); c.ellipse(-r * 0.3, 0, r * 0.3, r * 0.12, -0.3, 0, TAU); c.fill(); },
    spark: function (c, r) { var g = c.createRadialGradient(0, 0, 0, 0, 0, r); g.addColorStop(0, '#fff'); g.addColorStop(0.45, '#7fe8ff'); g.addColorStop(1, 'rgba(60,160,255,0)'); c.fillStyle = g; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill(); c.strokeStyle = '#d8f6ff'; c.lineWidth = Math.max(1, r * 0.12); for (var i = 0; i < 4; i++) { var a = i * Math.PI / 4; c.beginPath(); c.moveTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5); c.lineTo(Math.cos(a) * r * 1.0, Math.sin(a) * r * 1.0); c.moveTo(-Math.cos(a) * r * 0.5, -Math.sin(a) * r * 0.5); c.lineTo(-Math.cos(a) * r * 1.0, -Math.sin(a) * r * 1.0); c.stroke(); } },
    shield: function (c, r) { c.fillStyle = 'rgba(80,220,200,0.35)'; c.beginPath(); c.arc(0, 0, r * 0.95, 0, TAU); c.fill(); c.strokeStyle = '#3fe0c8'; c.lineWidth = Math.max(1.4, r * 0.16); c.beginPath(); c.arc(0, 0, r * 0.82, 0, TAU); c.stroke(); c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = Math.max(1, r * 0.1); c.beginPath(); c.arc(0, 0, r * 0.6, Math.PI * 1.05, Math.PI * 1.45); c.stroke(); },
    magnet: function (c, r) { c.lineWidth = r * 0.42; c.lineCap = 'butt'; c.strokeStyle = '#d1473f'; c.beginPath(); c.arc(0, -r * 0.05, r * 0.6, Math.PI, Math.PI * 1.5, false); c.moveTo(-r * 0.6, -r * 0.05); c.lineTo(-r * 0.6, r * 0.5); c.moveTo(0, -r * 0.65); c.stroke(); c.beginPath(); c.arc(0, -r * 0.05, r * 0.6, Math.PI * 1.5, TAU, false); c.moveTo(r * 0.6, -r * 0.05); c.lineTo(r * 0.6, r * 0.5); c.stroke(); c.fillStyle = '#e9eef7'; c.fillRect(-r * 0.81, r * 0.42, r * 0.42, r * 0.38); c.fillRect(r * 0.39, r * 0.42, r * 0.42, r * 0.38); }
  };
  function itemIcon(c, name, x, y, r) { c.save(); c.translate(x, y); (ITEM_ICON[name] || ITEM_ICON.boost)(c, r); c.restore(); }
  // The Zimi-orange cube: a glow, three faces, a sparkle that slides across the front.
  function itemCube(c, x, y, s, t) {
    var h = 4.0 * s, w = h, glow = c.createRadialGradient(x, y - h * 1.1, 0, x, y - h * 1.1, h * 3);
    glow.addColorStop(0, 'rgba(255,170,40,0.55)'); glow.addColorStop(1, 'rgba(255,140,20,0)');
    c.fillStyle = glow; c.beginPath(); c.arc(x, y - h * 1.1, h * 3, 0, TAU); c.fill();
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.beginPath(); c.ellipse(x, y + h * 0.1, h * 1.3, h * 0.4, 0, 0, TAU); c.fill();
    function face(pts, fill) { c.fillStyle = fill; c.beginPath(); c.moveTo(pts[0], pts[1]); for (var i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]); c.closePath(); c.fill(); }
    var T = [x, y - 2.2 * h], R = [x + w, y - 1.7 * h], C = [x, y - 1.2 * h], L = [x - w, y - 1.7 * h], BL = [x - w, y - 0.5 * h], BC = [x, y], BR = [x + w, y - 0.5 * h];
    face([L[0], L[1], C[0], C[1], BC[0], BC[1], BL[0], BL[1]], '#f2830a');
    face([R[0], R[1], C[0], C[1], BC[0], BC[1], BR[0], BR[1]], '#c85f00');
    face([T[0], T[1], R[0], R[1], C[0], C[1], L[0], L[1]], '#ffc860');
    c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = Math.max(1, h * 0.12); c.lineJoin = 'round';
    c.beginPath(); c.moveTo(T[0], T[1]); c.lineTo(R[0], R[1]); c.lineTo(BR[0], BR[1]); c.lineTo(BC[0], BC[1]); c.lineTo(BL[0], BL[1]); c.lineTo(L[0], L[1]); c.closePath(); c.moveTo(L[0], L[1]); c.lineTo(C[0], C[1]); c.lineTo(R[0], R[1]); c.moveTo(C[0], C[1]); c.lineTo(BC[0], BC[1]); c.stroke();
    // a sparkle that comes and goes on the left face
    var k = 0.5 + 0.5 * Math.sin(t * 3), sx = x - w * 0.5, sy = y - h * 0.95, r = h * 0.38 * k;
    if (r > 0.5) { c.fillStyle = '#fff'; c.beginPath(); c.moveTo(sx, sy - r); c.lineTo(sx + r * 0.3, sy - r * 0.3); c.lineTo(sx + r, sy); c.lineTo(sx + r * 0.3, sy + r * 0.3); c.lineTo(sx, sy + r); c.lineTo(sx - r * 0.3, sy + r * 0.3); c.lineTo(sx - r, sy); c.lineTo(sx - r * 0.3, sy - r * 0.3); c.fill(); }
  }

  // The minimap's road, drawn once at `size` px square.
  function buildMini(T, size) {
    var cv = el(size, size), c = cv.getContext('2d'), b = T.bbox, pad = 10, sc = (size - pad * 2) / Math.max(b.x1 - b.x0, b.y1 - b.y0), i;
    var ox = pad + ((size - pad * 2) - (b.x1 - b.x0) * sc) / 2, oy = pad + ((size - pad * 2) - (b.y1 - b.y0) * sc) / 2;
    function pt(i) { return [ox + (T.x[i] - b.x0) * sc, oy + (T.y[i] - b.y0) * sc]; }
    function path() { c.beginPath(); for (i = 0; i < T.N; i++) { var p = pt(i); if (i === 0) c.moveTo(p[0], p[1]); else c.lineTo(p[0], p[1]); } c.closePath(); c.lineJoin = 'round'; }
    path(); c.lineWidth = Math.max(5, size * 0.07); c.strokeStyle = 'rgba(0,0,0,0.65)'; c.stroke();
    path(); c.lineWidth = Math.max(3, size * 0.04); c.strokeStyle = 'rgba(255,255,255,0.85)'; c.stroke();
    var s0 = pt(0), s1 = pt(2); c.fillStyle = '#ff9a1f'; c.beginPath(); c.arc(s0[0], s0[1], Math.max(2.5, size * 0.035), 0, TAU); c.fill();
    return { canvas: cv, map: function (x, y) { return [ox + (x - b.x0) * sc, oy + (y - b.y0) * sc]; } };
  }

  root.KartArt = { THEMES: THEMES, buildTexture: buildTexture, buildPanorama: buildPanorama, makeScenery: makeScenery, DRAW: DRAW, sprite: sprite, kartSprite: kartSprite, critterHead: critterHead, itemIcon: itemIcon, itemCube: itemCube, buildMini: buildMini, TEX: TEX, el: el, disc: disc, oval: oval };
})(this);
