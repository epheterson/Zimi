/* ZimCity's tiles at twice the size, in a flat modern style. Our own code, GPL-3.0.

   Every tile starts as the 1989 picture in Zimi's colours, doubled. Then the tiles a player sees most are drawn again,
   crisp, from what each original tile says about itself: which of its edges a road or a power line leaves by, where its
   water is, where its trees stand. So the shapes follow the engine's own tiles (a corner is still that corner), and a
   tile not redrawn yet keeps its recoloured picture. */

import { buildings } from './zimcity-art2.js';
import { RIVER, LASTRIVEDGE } from './zimcity/engine/tileValues.js';

// Deterministic choices (Park-Miller): the same seed always draws the same, so a tile or a block looks the same each time.
export function parkMiller(seed) { return function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; }

export var ART = 32;           // a tile in the atlas: twice the engine's 16
var SRC = 16, PER_ROW = 32;

// The style's colours, light and dark (the recolouring's own, so redrawn and recoloured tiles sit together).
var STYLE = {
  light: { ground: '#cdbf98', grain: '#c2b38b', water: '#5f93d2', ripple: '#7aa7dc', shore: '#b8a77d', asphalt: '#3b3d42', paint: '#e9e4d6',
           leaf: '#5aa261', leafDark: '#3f8148', leafLight: '#7dbb7f', trunk: '#7a6a4c', wire: '#4a4c52', pole: '#8d9096', car: ['#e4893d', '#d24a3f', '#f7f5ef', '#5f93d2'], res: '#3f9a52', com: '#3b6fc4', ind: '#b9891a',
           wall: '#a8a294', glass: '#9fc2e8', glassDark: '#5f86b8', pave: '#c9c6bd', shopRoof: '#8d9096', yard: '#bdb49a', metal: '#9a9ea6', metalDark: '#6c7078',
           brick: '#a65a3e', brickDark: '#7d3f2a', coal: '#2a2b2f', white: '#f7f5ef', pale: '#d9dbe0', grass: '#a9c08a', rail: '#6c7078', sleeper: '#8d6e57' },
  dark:  { ground: '#4d4738', grain: '#463f31', water: '#2c4f80', ripple: '#3a6298', shore: '#5a5240', asphalt: '#2a2b2f', paint: '#9a978e',
           leaf: '#3c7a44', leafDark: '#2a5c31', leafLight: '#4f9358', trunk: '#4e4433', wire: '#b8bac0', pole: '#6a6c71', car: ['#c97532', '#b83f36', '#d9d7d1', '#3f72b8'], res: '#5cb46d', com: '#6d93e0', ind: '#e0b043',
           wall: '#5c5850', glass: '#5f86b8', glassDark: '#3f5f8c', pave: '#4a4842', shopRoof: '#6a6c71', yard: '#57503f', metal: '#6c7078', metalDark: '#4a4d54',
           brick: '#7d3f2a', brickDark: '#5c2c1d', coal: '#151618', white: '#d9d7d1', pale: '#9a9ca1', grass: '#4f6a3c', rail: '#9a9ea6', sleeper: '#5c4a3a' }
};

function rgbAt(d, w, x, y) { var i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2]]; }
function same(c, r, g, b) { return c[0] === r && c[1] === g && c[2] === b; }
function isWater(c) { return same(c, 102, 102, 230) || same(c, 0, 0, 230); }
function isAsphalt(c) { return same(c, 63, 63, 63) || same(c, 255, 255, 255) || same(c, 191, 191, 191); }   // the surface, its centre line and a crossing's stripes
function isGreen(c) { return same(c, 0, 230, 0) || same(c, 0, 127, 0); }

// Which edges (N, E, S, W) a tile's feature leaves by, read on the original picture at each edge's middle, inside the
// tile (two pixels, so a one-pixel border line does not count).
function edges(d, w, ox, oy, test) {
  var a = SRC / 2 - 1, b = SRC / 2, z = SRC - 1;
  var probe = [[[a, 0], [b, 0]], [[z, a], [z, b]], [[a, z], [b, z]], [[0, a], [0, b]]];
  return probe.map(function (pp) { return pp.every(function (p) { return test(rgbAt(d, w, ox + p[0], oy + p[1])); }); });
}
// Each tile is drawn inside its own square, so a tree's canopy never spills into the tile beside it in the atlas.
function inside(ctx, x, y, fn) { ctx.save(); ctx.beginPath(); ctx.rect(x, y, ART, ART); ctx.clip(); fn(); ctx.restore(); }

function ground(ctx, x, y, s, seed) {
  ctx.fillStyle = s.ground; ctx.fillRect(x, y, ART, ART);
  ctx.fillStyle = s.grain;
  for (var k = 0; k < 5; k++) { var r = (seed * 9301 + k * 49297) % 233280; ctx.fillRect(x + (r % 29) + 1, y + ((r >> 5) % 29) + 1, 2, 2); }
}

// A road: asphalt from the middle to each edge it leaves by, a centre line, and a car or two when there is traffic.
function road(ctx, x, y, s, e, cars, step) {
  ground(ctx, x, y, s, x + y);
  var c = ART / 2, half = 10;
  ctx.fillStyle = s.asphalt;
  ctx.fillRect(x + c - half, y + c - half, half * 2, half * 2);
  if (e[0]) ctx.fillRect(x + c - half, y, half * 2, c);
  if (e[2]) ctx.fillRect(x + c - half, y + c, half * 2, c);
  if (e[3]) ctx.fillRect(x, y + c - half, c, half * 2);
  if (e[1]) ctx.fillRect(x + c, y + c - half, c, half * 2);
  ctx.fillStyle = s.paint;
  var n = e.filter(Boolean).length;
  if (n <= 2) {   // a straight or a bend carries a dashed centre line; a junction is left plain
    if (e[0]) ctx.fillRect(x + c - 1, y + 2, 2, c - 6);
    if (e[2]) ctx.fillRect(x + c - 1, y + c + 4, 2, c - 6);
    if (e[3]) ctx.fillRect(x + 2, y + c - 1, c - 6, 2);
    if (e[1]) ctx.fillRect(x + c + 4, y + c - 1, c - 6, 2);
  }
  var straight = (e[0] && e[2] && !e[1] && !e[3]) || (e[1] && e[3] && !e[0] && !e[2]);
  for (var k = 0; k < (straight ? cars : 0); k++) {   // cars on the straights; a junction or a bend stays clear
    var along = (step * 7 + k * 15) % 24 + 4, h = e[1] || e[3];
    ctx.fillStyle = s.car[(step + k) % s.car.length];
    if (h) ctx.fillRect(x + along - 3, y + c + (k ? -8 : 2), 7, 5); else ctx.fillRect(x + c + (k ? -8 : 2), y + along - 3, 5, 7);
  }
}

// A power line: thin poles at the middle and two wires to each edge it leaves by.
function wire(ctx, x, y, s, e, over) {
  if (!over) ground(ctx, x, y, s, x * 3 + y);
  var c = ART / 2;
  ctx.strokeStyle = s.wire; ctx.lineWidth = 1.5;
  ctx.beginPath();
  [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(function (v, i) {
    if (!e[i]) return;
    for (var o = -3; o <= 3; o += 6) {
      ctx.moveTo(x + c + (v[1] ? o : 0), y + c + (v[0] ? o : 0));
      ctx.lineTo(x + c + v[0] * c + (v[1] ? o : 0), y + c + v[1] * c + (v[0] ? o : 0));
    }
  });
  ctx.stroke();
  ctx.fillStyle = s.pole; ctx.fillRect(x + c - 3, y + c - 3, 6, 6);
}

// Water and shores: the original's water pixels, smoothed at twice the size so a shore is a curve, not a staircase.
// The mask is padded with its own edge pixels first, so the smoothing never draws a shore along a tile's border.
var PAD = 2;
function water(ctx, x, y, s, d, w, ox, oy, mask, mctx) {
  var n = SRC + PAD * 2, img = mctx.createImageData(n, n), md = img.data;
  for (var py = 0; py < n; py++) for (var px = 0; px < n; px++) {
    var sx = Math.max(0, Math.min(SRC - 1, px - PAD)), sy = Math.max(0, Math.min(SRC - 1, py - PAD)), i = (py * n + px) * 4;
    md[i] = md[i + 1] = md[i + 2] = 255; md[i + 3] = isWater(rgbAt(d, w, ox + sx, oy + sy)) ? 255 : 0;
  }
  mctx.clearRect(0, 0, n, n); mctx.putImageData(img, 0, 0);
  var big = mask.getContext('2d', { willReadFrequently: true }), N = n * 2;
  big.clearRect(0, 0, N, N); big.imageSmoothingEnabled = true; big.filter = 'blur(1.5px)';
  big.drawImage(mctx.canvas, 0, 0, n, n, 0, 0, N, N); big.filter = 'none';
  var b = big.getImageData(PAD * 2, PAD * 2, ART, ART).data;
  ground(ctx, x, y, s, x + 2 * y);
  var out = ctx.getImageData(x, y, ART, ART), o = out.data, wc = hex(s.water), sc = hex(s.shore), rc = hex(s.ripple);
  for (var j = 0; j < b.length; j += 4) {
    var a = b[j + 3], q = j / 4, rx = q % ART, ry = Math.floor(q / ART);
    var col = a > 150 ? ((rx + ry * 3) % 23 === 0 ? rc : wc) : a > 70 ? sc : null;
    if (col) { o[j] = col[0]; o[j + 1] = col[1]; o[j + 2] = col[2]; }
  }
  ctx.putImageData(out, x, y);
}

// Trees: where the original has greenery, a forest floor and round canopies of a few sizes, set a little off a grid
// (each tile its own, so a wood does not read as a pattern of dots).
function trees(ctx, x, y, s, d, w, ox, oy, t) {
  ground(ctx, x, y, s, x + y * 5);
  var rnd = parkMiller(t * 7919);
  var patches = [];
  for (var cy = 0; cy < SRC; cy += 4) {
    for (var cx = 0; cx < SRC; cx += 4) {
      var n = 0;
      for (var py = 0; py < 4; py++) for (var px = 0; px < 4; px++) if (isGreen(rgbAt(d, w, ox + cx + px, oy + cy + py))) n++;
      if (n >= 7) patches.push([cx, cy, n]);
    }
  }
  ctx.fillStyle = s.leafDark;   // the floor under the canopies, so a wood is one mass
  patches.forEach(function (p) { ctx.fillRect(x + p[0] * 2, y + p[1] * 2, 8, 8); });
  patches.forEach(function (p) {
    var tx = x + p[0] * 2 + 4 + (rnd() - 0.5) * 4, ty = y + p[1] * 2 + 4 + (rnd() - 0.5) * 4, r = (p[2] > 12 ? 5 : 4) + rnd() * 1.5;
    ctx.fillStyle = s.leaf; ctx.beginPath(); ctx.arc(tx, ty, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = s.leafLight; ctx.beginPath(); ctx.arc(tx - r * 0.35, ty - r * 0.35, r * 0.35, 0, Math.PI * 2); ctx.fill();
  });
}
// An empty zone: a 3 x 3 lot with a rounded line in the zone's colour, a soft tint, and the zone's own glyph (house,
// shop, factory) in the middle tile instead of a serif letter. k is the tile's place in the lot, 0 to 8.
var GLYPH = {
  res: 'M8 15l8-7 8 7v9H8zM14 24v-5h4v5',
  com: 'M7 13l2-5h14l2 5M8 13v11h16V13M8 13h16M13 24v-6h6v6',
  ind: 'M6 24V14l5 3v-3l5 3V9h4l1 15M6 24h20'
};
function lot(ctx, x, y, s, zone, k) {
  ground(ctx, x, y, s, x + y);
  var col = s[zone], gx = k % 3, gy = Math.floor(k / 3), inset = 3;
  var l = gx === 0 ? inset : 0, r = gx === 2 ? ART - inset : ART, t = gy === 0 ? inset : 0, b = gy === 2 ? ART - inset : ART;
  ctx.globalAlpha = 0.18; ctx.fillStyle = col; ctx.fillRect(x + l, y + t, r - l, b - t); ctx.globalAlpha = 1;
  ctx.strokeStyle = col; ctx.lineWidth = 2;
  ctx.beginPath();
  if (gy === 0) { ctx.moveTo(x + l, y + t); ctx.lineTo(x + r, y + t); }
  if (gy === 2) { ctx.moveTo(x + l, y + b); ctx.lineTo(x + r, y + b); }
  if (gx === 0) { ctx.moveTo(x + l, y + t); ctx.lineTo(x + l, y + b); }
  if (gx === 2) { ctx.moveTo(x + r, y + t); ctx.lineTo(x + r, y + b); }
  ctx.stroke();
  if (k === 4) { ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke(new Path2D(GLYPH[zone])); }
}
// Scale2x (EPX): each pixel becomes four, and a corner takes its neighbours' colour where two of them agree, so pixel art
// doubles with clean diagonals instead of staircases. Neighbours are read within the tile, so tiles never bleed.
function scale2x(src) {
  var w = src.width, h = src.height, d = src.getContext('2d').getImageData(0, 0, w, h).data;
  var out = new ImageData(w * 2, h * 2), o = out.data;
  function px(x, y) { return ((y * w) + x) * 4; }
  function eq(a, b) { return d[a] === d[b] && d[a + 1] === d[b + 1] && d[a + 2] === d[b + 2] && d[a + 3] === d[b + 3]; }
  function put(x, y, from) { var i = ((y * w * 2) + x) * 4; o[i] = d[from]; o[i + 1] = d[from + 1]; o[i + 2] = d[from + 2]; o[i + 3] = d[from + 3]; }
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var tx = x % SRC, ty = y % SRC;
      var P = px(x, y), A = ty ? px(x, y - 1) : P, D = ty < SRC - 1 ? px(x, y + 1) : P, C = tx ? px(x - 1, y) : P, B = tx < SRC - 1 ? px(x + 1, y) : P;
      put(x * 2, y * 2, eq(C, A) && !eq(C, D) && !eq(A, B) ? A : P);
      put(x * 2 + 1, y * 2, eq(A, B) && !eq(A, C) && !eq(B, D) ? B : P);
      put(x * 2, y * 2 + 1, eq(D, C) && !eq(D, B) && !eq(C, A) ? C : P);
      put(x * 2 + 1, y * 2 + 1, eq(B, D) && !eq(B, A) && !eq(D, C) ? D : P);
    }
  }
  return out;
}

// Rails: two steel lines on sleepers, along the same edges as the road of the same place in the order.
function rail(ctx, x, y, s, e) {
  var c = ART / 2;
  ctx.fillStyle = s.sleeper;
  [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(function (v, i) {
    if (!e[i]) return;
    for (var k = 2; k < c; k += 5) { if (v[0]) ctx.fillRect(x + c + v[0] * k - 1, y + c - 7, 3, 14); else ctx.fillRect(x + c - 7, y + c + v[1] * k - 1, 14, 3); }
  });
  ctx.fillRect(x + c - 7, y + c - 7, 14, 14);
  ctx.strokeStyle = s.rail; ctx.lineWidth = 2; ctx.beginPath();
  [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(function (v, i) {
    if (!e[i]) return;
    for (var o = -4; o <= 4; o += 8) { ctx.moveTo(x + c + (v[1] ? o : 0), y + c + (v[0] ? o : 0)); ctx.lineTo(x + c + v[0] * c + (v[1] ? o : 0), y + c + v[1] * c + (v[0] ? o : 0)); }
  });
  ctx.stroke();
}
var H = [false, true, false, true], V = [true, false, true, false];

function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

// The atlas: `recoloured` (the 16 px tiles in Zimi's colours) doubled, the redrawn tiles over it. `original` is the 1989
// picture, read for where each feature is.
export function atlas(original, recoloured, dark) {
  var s = STYLE[dark ? 'dark' : 'light'], c = document.createElement('canvas');
  c.width = c.height = PER_ROW * ART;
  var ctx = c.getContext('2d');
  ctx.putImageData(scale2x(recoloured), 0, 0);   // every tile, doubled with Scale2x so its edges stay crisp, then the redrawn ones over it
  var src = document.createElement('canvas');
  src.width = original.naturalWidth; src.height = original.naturalHeight;
  var sctx = src.getContext('2d', { willReadFrequently: true }); sctx.drawImage(original, 0, 0);
  var d = sctx.getImageData(0, 0, src.width, src.height).data, w = src.width;
  var small = document.createElement('canvas'); small.width = small.height = SRC + PAD * 2;
  var mctx = small.getContext('2d'), mask = document.createElement('canvas'); mask.width = mask.height = (SRC + PAD * 2) * 2;
  function at(t) { return [(t % PER_ROW) * ART, Math.floor(t / PER_ROW) * ART, (t % PER_ROW) * SRC, Math.floor(t / PER_ROW) * SRC]; }
  var p;
  p = at(0); ground(ctx, p[0], p[1], s, 1);
  for (var t = RIVER; t <= LASTRIVEDGE; t++) { p = at(t); water(ctx, p[0], p[1], s, d, w, p[2], p[3], mask, mctx); }
  for (t = 21; t <= 43; t++) { if (t === 38 || t === 39) continue; p = at(t); (function (p, t) { inside(ctx, p[0], p[1], function () { trees(ctx, p[0], p[1], s, d, w, p[2], p[3], t); }); })(p, t); }
  // roads: the plain shapes (66 to 76; a road under a power line keeps its picture) and their light (80 to 143) and heavy
  // (144 to 206) traffic frames; bridges keep theirs. Power lines over land (210 to 220) come in the same order as the
  // plain roads, so they take the same edges; the two that cross water keep their picture.
  var shape = {};
  for (t = 66; t <= 76; t++) { var q = at(t); shape[t] = edges(d, w, q[2], q[3], isAsphalt); }
  for (t = 66; t <= 206; t++) {
    var base = (t & 15) + 64;
    if (!shape[base] || t === 79 || t === 95 || t === 111 || t === 127 || t === 143 || t === 159 || t === 175 || t === 191) continue;
    p = at(t);
    road(ctx, p[0], p[1], s, shape[base], t >= 144 ? 2 : t >= 80 ? 1 : 0, (t >> 4) & 3);
  }
  for (t = 210; t <= 220; t++) { p = at(t); wire(ctx, p[0], p[1], s, shape[t - 144]); }
  // rails over land (226 to 236; the two over water keep their picture) in the plain roads' order, and the crossings: a road under a power line (77, 78), a rail
  // under one (221, 222), a rail across a road (237, 238); each the two drawings, the line on top
  for (t = 226; t <= 236; t++) { p = at(t); ground(ctx, p[0], p[1], s, t); rail(ctx, p[0], p[1], s, shape[t - 160]); }
  var both = function (t, under, over) { var q = at(t); under(q); over(q); };
  both(77, function (q) { road(ctx, q[0], q[1], s, H, 0, 0); }, function (q) { wire(ctx, q[0], q[1], s, V, true); });
  both(78, function (q) { road(ctx, q[0], q[1], s, V, 0, 0); }, function (q) { wire(ctx, q[0], q[1], s, H, true); });
  both(221, function (q) { ground(ctx, q[0], q[1], s, 221); rail(ctx, q[0], q[1], s, H); }, function (q) { wire(ctx, q[0], q[1], s, V, true); });
  both(222, function (q) { ground(ctx, q[0], q[1], s, 222); rail(ctx, q[0], q[1], s, V); }, function (q) { wire(ctx, q[0], q[1], s, H, true); });
  both(237, function (q) { road(ctx, q[0], q[1], s, V, 0, 0); }, function (q) { rail(ctx, q[0], q[1], s, H); });
  both(238, function (q) { road(ctx, q[0], q[1], s, H, 0, 0); }, function (q) { rail(ctx, q[0], q[1], s, V); });
  // bridges: the road over water, with a rail each side
  [[64, H], [65, V]].forEach(function (b) {
    var q = at(b[0]);
    ctx.fillStyle = s.water; ctx.fillRect(q[0], q[1], ART, ART);
    var horiz = b[1] === H;
    ctx.fillStyle = s.asphalt; if (horiz) ctx.fillRect(q[0], q[1] + 6, ART, 20); else ctx.fillRect(q[0] + 6, q[1], 20, ART);
    ctx.fillStyle = s.pole; if (horiz) { ctx.fillRect(q[0], q[1] + 4, ART, 2); ctx.fillRect(q[0], q[1] + 26, ART, 2); } else { ctx.fillRect(q[0] + 4, q[1], 2, ART); ctx.fillRect(q[0] + 26, q[1], 2, ART); }
  });
  buildings(ctx, at, s);
  // empty zones: residential 240 to 248, commercial 423 to 431, industrial 612 to 620 (the lot's tiles in reading order)
  [[240, 'res'], [423, 'com'], [612, 'ind']].forEach(function (z) {
    for (var k = 0; k < 9; k++) { var q = at(z[0] + k); inside(ctx, q[0], q[1], function () { lot(ctx, q[0], q[1], s, z[1], k); }); }
  });
  // a zone with no power flashes this in its middle: a round amber badge with a bolt, crossed
  var nb = at(827);
  inside(ctx, nb[0], nb[1], function () {
    ctx.clearRect(nb[0], nb[1], ART, ART);
    ctx.fillStyle = s.ind; ctx.beginPath(); ctx.arc(nb[0] + 16, nb[1] + 16, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = s.asphalt; ctx.fill(new Path2D('M' + (nb[0] + 17) + ' ' + (nb[1] + 7) + 'l-7 10h5l-2 8 7-10h-5z'));
    ctx.strokeStyle = s.asphalt; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(nb[0] + 8, nb[1] + 8); ctx.lineTo(nb[0] + 24, nb[1] + 24); ctx.stroke();
  });
  return c;
}
