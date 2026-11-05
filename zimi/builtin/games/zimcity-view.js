/* ZimCity: the map on screen. Our own code, GPL-3.0 (it drives micropolisJS, GPL-3.0; see zimcity/ENGINE.md).

   The whole city is kept on one canvas at 16 px a tile, redrawn tile by tile as the map changes; the screen shows
   part of it at the camera's scale, then the layer tint, the sprites (trains, planes, the monster) and the ghost of
   what the held tool would build. Nothing here changes the city. */

import { AnimationManager } from './zimcity/engine/animationManager.js';
import { TILE_INVALID } from './zimcity/engine/tileValues.js';
import { atlas, ART } from './zimcity-art.js';

export var TILE = 16;                        // the art's tile, in pixels
var TILES_PER_ROW = 32;                      // tiles.png is 32 x 32 tiles
var SPRITE_CELL = 48;                        // sprites.png: one 48 px cell per frame (columns) and kind (rows)
var NOT_PAINTED = -2;                        // never a tile value: forces the first paint
export var ZOOM_MAX = 3;                     // three times the art: the plan's two steps past 1:1
var MARGIN_TILES = 4;                        // how far past the edge of the city the camera may look
var LAYER_ALPHA = 0.55;
var GHOST_ALPHA = 0.85;

// What each layer tints, from which of the engine's block maps, and its range (the engine's own comments give them).
export var LAYERS = {
  traffic: { map: 'trafficDensityMap', max: 240, rgb: [229, 72, 43] },
  pollution: { map: 'pollutionDensityMap', max: 255, rgb: [120, 86, 40] },
  crime: { map: 'crimeRateMap', max: 250, rgb: [180, 32, 120] },
  land: { map: 'landValueMap', max: 250, rgb: [22, 140, 70] }
};

// The 1989 art in Zimi's colours: each of its flat colours is mapped to a quieter one (the antialiased greys stay),
// once for light and once for dark, and the plain ground's black speckle becomes a faint grain. The engine's tile
// numbers are untouched: only the picture of each tile changes.
var PALETTE = {
  //            1989 colour         light        dark
  ground:   [[204, 127, 102], '#cdbf98', '#4d4738'],
  shore:    [[153, 127, 76],  '#a8946a', '#3d3528'],
  trees:    [[0, 230, 0],     '#5aa261', '#3c7a44'],
  forest:   [[0, 127, 0],     '#2f6f3a', '#21502a'],
  water:    [[102, 102, 230], '#5f93d2', '#2c4f80'],
  deep:     [[0, 0, 230],     '#3f72b8', '#1f3d6a'],
  asphalt:  [[63, 63, 63],    '#3b3d42', '#2a2b2f'],
  concrete: [[127, 127, 127], '#8d9096', '#6a6c71'],
  pale:     [[191, 191, 191], '#c9cbcf', '#9a9ca1'],
  black:    [[0, 0, 0],       '#1d1e21', '#111214'],
  white:    [[255, 255, 255], '#f7f5ef', '#d9d7d1'],
  yellow:   [[255, 255, 0],   '#e3c04a', '#c9a73a'],
  red:      [[255, 0, 0],     '#d24a3f', '#b83f36'],
  orange:   [[255, 127, 0],   '#e4893d', '#c97532']
};
var GRAIN = ['#c4b58d', '#463f31'];   // the ground's speckle, light and dark
var GROUND_KEY = (204 << 16) | (127 << 8) | 102;
function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
export function recolour(img, dark) {
  var c = document.createElement('canvas'), k = dark ? 2 : 1, map = {};
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  var ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  var data = ctx.getImageData(0, 0, c.width, c.height), d = data.data;
  Object.keys(PALETTE).forEach(function (n) { var e = PALETTE[n], o = e[0]; map[(o[0] << 16) | (o[1] << 8) | o[2]] = hex(e[k]); });
  var grain = hex(GRAIN[k - 1]);
  for (var i = 0; i < d.length; i += 4) {
    var key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2], to = map[key];
    // tile 0 (the plain ground) is the top left 16 x 16: every speck on it becomes a faint grain
    var px = (i / 4) % c.width, py = Math.floor(i / 4 / c.width);
    if (px < TILE && py < TILE && key !== GROUND_KEY) to = grain;
    if (to) { d[i] = to[0]; d[i + 1] = to[1]; d[i + 2] = to[2]; }
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

export function View(canvas, art) {
  this.canvas = canvas;
  this.ctx = canvas.getContext('2d');
  this.art = art;                            // { tiles: Image, sprites: Image }
  this.city = null;
  this.cam = { x: 0, y: 0, s: 2 };           // x, y: the world pixel at the screen's top left; s: screen px per art px
  this.w = 0; this.h = 0;                    // the canvas in CSS pixels
  this.ghost = null;                         // { tiles: [[x, y, value]], ok }
  this.layer = 'off';
  this.paused = false;
  this.cursor = null;                        // the keyboard's tile, { x, y }
  this._layerCanvas = document.createElement('canvas');
  this._layerAt = 0;
}

// A new city (or one loaded): nothing painted yet.
View.prototype.setCity = function (city) {
  this.city = city;
  this.anim = new AnimationManager(city.map);
  this._cache = null;
  this._layerAt = 0;
};

// The canvas fills its box; the drawing surface follows the device's pixels.
View.prototype.resize = function () {
  var r = this.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
  this.canvas.width = Math.round(this.w * dpr); this.canvas.height = Math.round(this.h * dpr);
  this.dpr = dpr;
  this.clamp();
};

// The smallest scale shows the whole city on one screen; the largest is ZOOM_MAX.
View.prototype.minScale = function () {
  if (!this.city) return 1;
  return Math.min(this.w / (this.city.map.width * TILE), this.h / (this.city.map.height * TILE), 1);
};
View.prototype.clamp = function () {
  if (!this.city) return;
  var c = this.cam, map = this.city.map, m = MARGIN_TILES * TILE;
  c.s = Math.max(this.minScale(), Math.min(ZOOM_MAX, c.s));
  var vw = this.w / c.s, vh = this.h / c.s, ww = map.width * TILE, wh = map.height * TILE;
  // A city narrower than the screen is centred; otherwise the camera stays within a margin of its edges.
  c.x = vw >= ww ? (ww - vw) / 2 : Math.max(-m, Math.min(ww - vw + m, c.x));
  c.y = vh >= wh ? (wh - vh) / 2 : Math.max(-m, Math.min(wh - vh + m, c.y));
};
// The camera pulled wholly inside the city (a new city opens on its land, never on the margin past its edge).
View.prototype.keepInside = function () {
  var c = this.cam, map = this.city.map, vw = this.w / c.s, vh = this.h / c.s, ww = map.width * TILE, wh = map.height * TILE;
  if (vw < ww) c.x = Math.max(0, Math.min(ww - vw, c.x));
  if (vh < wh) c.y = Math.max(0, Math.min(wh - vh, c.y));
};
View.prototype.centreOn = function (tx, ty) {
  this.cam.x = (tx + 0.5) * TILE - this.w / this.cam.s / 2;
  this.cam.y = (ty + 0.5) * TILE - this.h / this.cam.s / 2;
  this.clamp();
};
View.prototype.panBy = function (dx, dy) { this.cam.x -= dx / this.cam.s; this.cam.y -= dy / this.cam.s; this.clamp(); };
// Zoom about a point on the screen, so the tile under the fingers stays under them.
View.prototype.zoomAt = function (sx, sy, s) {
  var c = this.cam, wx = c.x + sx / c.s, wy = c.y + sy / c.s;
  c.s = Math.max(this.minScale(), Math.min(ZOOM_MAX, s));
  c.x = wx - sx / c.s; c.y = wy - sy / c.s;
  this.clamp();
};
// The tile under a point on the screen (it may be off the map).
View.prototype.tileAt = function (sx, sy) {
  return { x: Math.floor((this.cam.x + sx / this.cam.s) / TILE), y: Math.floor((this.cam.y + sy / this.cam.s) / TILE) };
};

function drawTile(ctx, img, value, dx, dy) {
  if (value === TILE_INVALID || value < 0) { ctx.clearRect(dx, dy, TILE, TILE); return; }
  ctx.drawImage(img, (value % TILES_PER_ROW) * ART, Math.floor(value / TILES_PER_ROW) * ART, ART, ART, dx, dy, TILE, TILE);
}

// The city is never painted whole (at 32 px a tile it would be 3840 x 3200, about 50 MB, more than a phone's browser
// gives a tab). Only the tiles on screen and a margin around them are kept, on one canvas, at the detail the screen can
// show: 32 px a tile when a tile is 24 device pixels or more, 16 below that, 8 for the whole city at once. Moving within
// the margin repaints nothing; moving past it, or zooming to another detail, paints the new window once.
var MARGIN = 4;
function detail(px) { return px >= 24 ? ART : px >= 12 ? 16 : 8; }
View.prototype._atlasAt = function (r) {
  var full = this.tileArt();
  if (r === ART) return full;
  this._small = this._small || {};
  if (!this._small[r]) {
    var c = document.createElement('canvas'), ctx;
    c.width = c.height = TILES_PER_ROW * r; ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, 0, 0, c.width, c.height);
    this._small[r] = c;
  }
  return this._small[r];
};
View.prototype._window = function () {
  var c = this.cam, map = this.city.map, r = detail(TILE * c.s * (this.dpr || 1));
  var x0 = Math.max(0, Math.floor(c.x / TILE) - MARGIN), y0 = Math.max(0, Math.floor(c.y / TILE) - MARGIN);
  var x1 = Math.min(map.width, Math.ceil((c.x + this.w / c.s) / TILE) + MARGIN), y1 = Math.min(map.height, Math.ceil((c.y + this.h / c.s) / TILE) + MARGIN);
  var k = this._cache;
  if (k && k.r === r && x0 >= k.x0 && y0 >= k.y0 && x1 <= k.x1 && y1 <= k.y1) return k;
  // a new window, one margin wider again, so the next small pan stays inside it
  x0 = Math.max(0, x0 - MARGIN); y0 = Math.max(0, y0 - MARGIN); x1 = Math.min(map.width, x1 + MARGIN); y1 = Math.min(map.height, y1 + MARGIN);
  var canvas = k ? k.canvas : document.createElement('canvas');
  canvas.width = (x1 - x0) * r; canvas.height = (y1 - y0) * r;
  var ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  this._cache = { r: r, x0: x0, y0: y0, x1: x1, y1: y1, canvas: canvas, ctx: ctx, painted: new Int32Array((x1 - x0) * (y1 - y0)).fill(NOT_PAINTED), values: [] };
  this.anim = new AnimationManager(this.city.map);   // its frame history is kept per window
  return this._cache;
};
// Bring the window up to date: only the tiles whose picture changed are drawn again.
View.prototype._paintWorld = function () {
  var k = this._window(), map = this.city.map, w = k.x1 - k.x0, h = k.y1 - k.y0, v = k.values, r = k.r, art = this._atlasAt(r);
  map.getTileValuesForPainting(k.x0, k.y0, w, h, v);
  this.anim.getTiles(v, k.x0, k.y0, w, h, this.paused);
  for (var i = 0, n = w * h; i < n; i++) {
    if (v[i] === k.painted[i]) continue;
    var dx = (i % w) * r, dy = Math.floor(i / w) * r;
    if (v[i] === TILE_INVALID || v[i] < 0) k.ctx.clearRect(dx, dy, r, r);
    else k.ctx.drawImage(art, (v[i] % TILES_PER_ROW) * r, Math.floor(v[i] / TILES_PER_ROW) * r, r, r, dx, dy, r, r);
    k.painted[i] = v[i];
  }
  return k;
};
// What the city's pictures hold, in bytes (four a pixel): the window and the atlases. For the tests and for measuring.
View.prototype.bytes = function () {
  var n = 0, add = function (c) { if (c) n += c.width * c.height * 4; };
  if (this._cache) add(this._cache.canvas);
  add(this._art); Object.keys(this._small || {}).forEach(function (r) { add(this._small[r]); }, this);
  return n;
};

// The layer's tint: the block map drawn small, then stretched over the city with smoothing (refreshed twice a second).
var LAYER_REFRESH_MS = 500;
View.prototype._layerImage = function (now) {
  var spec = LAYERS[this.layer], bm = this.city.sim.blockMaps[spec.map];
  if (now - this._layerAt < LAYER_REFRESH_MS && this._layerKey === this.layer) return this._layerCanvas;
  this._layerAt = now; this._layerKey = this.layer;
  var lc = this._layerCanvas, lctx;
  lc.width = bm.width; lc.height = bm.height; lctx = lc.getContext('2d');
  var img = lctx.createImageData(bm.width, bm.height), d = img.data;
  for (var y = 0; y < bm.height; y++) {
    for (var x = 0; x < bm.width; x++) {
      var k = (y * bm.width + x) * 4, a = Math.max(0, Math.min(1, (bm.get(x, y) || 0) / spec.max));
      d[k] = spec.rgb[0]; d[k + 1] = spec.rgb[1]; d[k + 2] = spec.rgb[2]; d[k + 3] = Math.round(a * 255);
    }
  }
  lctx.putImageData(img, 0, 0);
  return lc;
};

// The tiles in the page's theme (Zimi's data-theme first, the device's preference otherwise); a change repaints the city.
function darkNow() {
  var t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'dark';
  try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
}
View.prototype.tileArt = function () {
  var dark = darkNow();
  if (!this._art || this._artDark !== dark) {
    this._art = atlas(this.art.tiles, recolour(this.art.tiles, dark), dark); this._artDark = dark;
    this._small = null; this._cache = null;   // repaint in the new theme
  }
  return this._art;
};
function loaded(img) { return img.complete && img.naturalWidth > 0; }
View.prototype.draw = function (now) {
  if (!this.city || !this.w || !loaded(this.art.tiles) || !loaded(this.art.sprites)) return;
  this.tileArt();   // before the world is painted, so a theme change repaints it in one frame
  var win = this._paintWorld();
  var ctx = this.ctx, c = this.cam, map = this.city.map, k = this.dpr * c.s;
  ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  ctx.clearRect(0, 0, this.w, this.h);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(k, 0, 0, k, -c.x * k, -c.y * k);
  ctx.drawImage(win.canvas, win.x0 * TILE, win.y0 * TILE, (win.x1 - win.x0) * TILE, (win.y1 - win.y0) * TILE);
  if (this.layer !== 'off' && LAYERS[this.layer]) {
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = LAYER_ALPHA;
    ctx.drawImage(this._layerImage(now), 0, 0, map.width * TILE, map.height * TILE);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
  }
  this._drawSprites(ctx);
  if (this.follower) this._drawFollower(ctx);
  if (this.ghost) this._drawGhost(ctx);
  if (this.cursor) {   // the keyboard's tile: the focus ring's amber
    ctx.strokeStyle = getComputedStyle(this.canvas).getPropertyValue('--accent') || '#f59e0b';
    ctx.lineWidth = 2 / c.s;
    ctx.strokeRect(this.cursor.x * TILE, this.cursor.y * TILE, TILE, TILE);
  }
};

// The citizen being followed: a figure on the road (a dot with a ring, amber when stuck in traffic) and the name over
// it, both a constant size on screen whatever the zoom.
View.prototype._drawFollower = function (ctx) {
  var f = this.follower, s = this.cam.s, x = (f.x + 0.5) * TILE, y = (f.y + 0.5) * TILE, css = getComputedStyle(this.canvas);
  var accent = css.getPropertyValue('--accent').trim() || '#c2410c';
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)'; ctx.beginPath(); ctx.ellipse(x + 1 / s, y + 5 / s, 6 / s, 2.5 / s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = f.slow ? '#e0a020' : accent; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5 / s;
  ctx.beginPath(); ctx.arc(x, y, 7 / s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.font = '600 ' + 12 / s + 'px ' + (css.getPropertyValue('--font').trim() || 'system-ui');
  var w = ctx.measureText(f.name).width, pad = 6 / s, top = y - 30 / s;
  ctx.fillStyle = 'rgba(20, 20, 24, 0.82)';
  ctx.beginPath(); ctx.roundRect(x - w / 2 - pad, top, w + pad * 2, 18 / s, 9 / s); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(f.name, x, top + 9 / s);
  ctx.restore();
};
View.prototype._drawSprites = function (ctx) {
  var list = this.city.sim.spriteManager.getSpriteList(), img = this.art.sprites;
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (!s.frame) continue;
    ctx.drawImage(img, (s.frame - 1) * SPRITE_CELL, (s.type - 1) * SPRITE_CELL, s.width, s.width, s.x + s.xOffset, s.y + s.yOffset, s.width, s.width);
  }
};

// The ghost: the tiles the held tool would lay, in their own art, washed green when the build will succeed (funds
// included) and red when it will not, with one outline around them all.
View.prototype._drawGhost = function (ctx) {
  var g = this.ghost;
  ctx.globalAlpha = GHOST_ALPHA;
  g.tiles.forEach(function (t) { if (t[2] >= 0) drawTile(ctx, this.tileArt(), t[2], t[0] * TILE, t[1] * TILE); }, this);
  ctx.globalAlpha = 1;
  ctx.fillStyle = g.ok ? 'rgba(34, 160, 80, 0.32)' : 'rgba(205, 40, 30, 0.38)';
  g.tiles.forEach(function (t) { ctx.fillRect(t[0] * TILE, t[1] * TILE, TILE, TILE); });
  // Each building's footprint gets its own outline, green where it will go and red where it will not.
  g.boxes.forEach(function (b) {
    if (!b[4]) { ctx.fillStyle = 'rgba(205, 40, 30, 0.38)'; ctx.fillRect(b[0] * TILE, b[1] * TILE, (b[2] - b[0] + 1) * TILE, (b[3] - b[1] + 1) * TILE); }
    ctx.strokeStyle = b[4] ? '#1f9d55' : '#c62828'; ctx.lineWidth = 2 / this.cam.s;
    ctx.strokeRect(b[0] * TILE, b[1] * TILE, (b[2] - b[0] + 1) * TILE, (b[3] - b[1] + 1) * TILE);
  }, this);
};
