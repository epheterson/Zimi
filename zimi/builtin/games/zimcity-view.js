/* ZimCity: the map on screen. Our own code, GPL-3.0 (it drives micropolisJS, GPL-3.0; see zimcity/ENGINE.md).

   The whole city is kept on one canvas at 16 px a tile, redrawn tile by tile as the map changes; the screen shows
   part of it at the camera's scale, then the layer tint, the sprites (trains, planes, the monster) and the ghost of
   what the held tool would build. Nothing here changes the city. */

import { AnimationManager } from './zimcity/engine/animationManager.js';
import { TILE_INVALID } from './zimcity/engine/tileValues.js';

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

// A new city (or one loaded): a fresh world canvas and nothing painted yet.
View.prototype.setCity = function (city) {
  this.city = city;
  var map = city.map;
  this.world = document.createElement('canvas');
  this.world.width = map.width * TILE; this.world.height = map.height * TILE;
  this.wctx = this.world.getContext('2d');
  this.painted = new Int32Array(map.width * map.height).fill(NOT_PAINTED);
  this.values = new Array(map.width * map.height);
  this.anim = new AnimationManager(map);
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
  ctx.drawImage(img, (value % TILES_PER_ROW) * TILE, Math.floor(value / TILES_PER_ROW) * TILE, TILE, TILE, dx, dy, TILE, TILE);
}

// Bring the world canvas up to date: only the tiles whose picture changed are drawn again.
View.prototype._paintWorld = function () {
  var map = this.city.map, w = map.width, h = map.height, v = this.values;
  map.getTileValuesForPainting(0, 0, w, h, v);
  this.anim.getTiles(v, 0, 0, w, h, this.paused);
  for (var i = 0, n = v.length; i < n; i++) {
    if (v[i] === this.painted[i]) continue;
    drawTile(this.wctx, this.art.tiles, v[i], (i % w) * TILE, Math.floor(i / w) * TILE);
    this.painted[i] = v[i];
  }
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

function loaded(img) { return img.complete && img.naturalWidth > 0; }
View.prototype.draw = function (now) {
  if (!this.city || !this.w || !loaded(this.art.tiles) || !loaded(this.art.sprites)) return;
  this._paintWorld();
  var ctx = this.ctx, c = this.cam, map = this.city.map, k = this.dpr * c.s;
  ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  ctx.clearRect(0, 0, this.w, this.h);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(k, 0, 0, k, -c.x * k, -c.y * k);
  // Only the part of the city on screen is copied.
  var sx = Math.max(0, Math.floor(c.x)), sy = Math.max(0, Math.floor(c.y));
  var sw = Math.min(this.world.width, Math.ceil(c.x + this.w / c.s) + 1) - sx, sh = Math.min(this.world.height, Math.ceil(c.y + this.h / c.s) + 1) - sy;
  if (sw > 0 && sh > 0) ctx.drawImage(this.world, sx, sy, sw, sh, sx, sy, sw, sh);
  if (this.layer !== 'off' && LAYERS[this.layer]) {
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = LAYER_ALPHA;
    ctx.drawImage(this._layerImage(now), 0, 0, map.width * TILE, map.height * TILE);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
  }
  this._drawSprites(ctx);
  if (this.ghost) this._drawGhost(ctx);
  if (this.cursor) {   // the keyboard's tile: the focus ring's amber
    ctx.strokeStyle = getComputedStyle(this.canvas).getPropertyValue('--accent') || '#f59e0b';
    ctx.lineWidth = 2 / c.s;
    ctx.strokeRect(this.cursor.x * TILE, this.cursor.y * TILE, TILE, TILE);
  }
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
  g.tiles.forEach(function (t) { if (t[2] >= 0) drawTile(ctx, this.art.tiles, t[2], t[0] * TILE, t[1] * TILE); }, this);
  ctx.globalAlpha = 1;
  ctx.fillStyle = g.ok ? 'rgba(34, 160, 80, 0.32)' : 'rgba(205, 40, 30, 0.38)';
  g.tiles.forEach(function (t) { ctx.fillRect(t[0] * TILE, t[1] * TILE, TILE, TILE); });
  // A building's footprint gets one outline; a drawn stroke is its tiles alone.
  if (g.box) {
    var b = g.box;
    ctx.strokeStyle = g.ok ? '#1f9d55' : '#c62828'; ctx.lineWidth = 2 / this.cam.s;
    ctx.strokeRect(b[0] * TILE, b[1] * TILE, (b[2] - b[0] + 1) * TILE, (b[3] - b[1] + 1) * TILE);
  }
};
