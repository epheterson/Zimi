/* ZimCity's buildings, drawn flat at twice the size. Our own code, GPL-3.0.

   A zone or a building is one picture over its 3 x 3 (or 4 x 4, or 6 x 6) tiles, cut into the tiles the engine names
   for it: they run in reading order from the centre tile minus the size minus one (buildingTool.js puts them so).
   Grown zones follow the engine's own numbering: homes are ((land value x 4) + density) x 9 + RZB, shops
   ((value x 5) + density) x 9 + CZB, industry ((value x 4) + density) x 9 + IZB. Every building is a box seen from above:
   a roof, a darker face to the south and a soft shadow to the east, so height reads at a glance. */

import * as TV from './zimcity/engine/tileValues.js';
import { ART, parkMiller as chance } from './zimcity-art.js';

function box(ctx, x, y, w, h, tall, roof, face) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.16)'; ctx.fillRect(x + w, y + tall * 0.6, Math.max(2, tall * 0.5), h);   // shadow to the east
  ctx.fillStyle = face; ctx.fillRect(x, y + h, w, tall);                                                       // the south face
  ctx.fillStyle = roof; ctx.fillRect(x, y, w, h);
}
function windows(ctx, x, y, w, h, col, step) {
  ctx.fillStyle = col;
  for (var wy = y + 3; wy < y + h - 2; wy += step) for (var wx = x + 3; wx < x + w - 3; wx += step) ctx.fillRect(wx, wy, step / 2, 2);
}
function lot(ctx, n, s) { ctx.fillStyle = s.ground; ctx.fillRect(0, 0, n, n); }
function tree(ctx, x, y, r, s) {
  ctx.fillStyle = s.leafDark; ctx.beginPath(); ctx.arc(x + 1, y + 1, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = s.leaf; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}
function house(ctx, x, y, w, h, roof, s) {
  box(ctx, x, y, w, h, 4, roof, s.wall);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)'; ctx.fillRect(x, y, w, h / 2);   // the lit slope of the roof
}

// One picture of size x size tiles, cut into the atlas from `base` on.
function block(atlasCtx, at, base, size, paint) {
  var c = document.createElement('canvas'), n = size * ART;
  c.width = c.height = n;
  var ctx = c.getContext('2d');
  paint(ctx, n);
  for (var k = 0; k < size * size; k++) {
    var p = at(base + k);
    atlasCtx.clearRect(p[0], p[1], ART, ART);
    atlasCtx.drawImage(c, (k % size) * ART, Math.floor(k / size) * ART, ART, ART, p[0], p[1], ART, ART);
  }
}

// Where the plant's chimneys let the smoke out: the tile (in the 4 x 4, reading order) and where in it the puff starts.
var SMOKE = [{ tile: 2, x: 16, y: 20 }, { tile: 3, x: 16, y: 20 }, { tile: 6, x: 16, y: 20 }, { tile: 7, x: 16, y: 20 }];

var ROOFS = ['#b4552e', '#c96f45', '#8d6e57', '#6f7a86'];   // homes, by land value: clay, terracotta, brown, slate

function homes(ctx, n, s, value, den, seed) {
  var r = chance(seed), roof = function () { return ROOFS[(value + Math.floor(r() * 2)) % ROOFS.length]; };
  lot(ctx, n, s);
  if (den === 0) {          // a few houses among gardens
    house(ctx, 10, 12, 26, 20, roof(), s); house(ctx, 56, 50, 28, 22, roof(), s); tree(ctx, 70, 20, 7, s); tree(ctx, 22, 70, 8, s);
  } else if (den === 1) {   // a street of houses
    for (var i = 0; i < 4; i++) house(ctx, 6 + (i % 2) * 46, 8 + Math.floor(i / 2) * 46, 36, 28, roof(), s);
  } else if (den === 2) {   // flats
    box(ctx, 8, 8, 80, 30, 8, roof(), s.wall); windows(ctx, 8, 38, 80, 8, s.glass, 8);
    box(ctx, 8, 54, 80, 26, 8, roof(), s.wall); windows(ctx, 8, 80, 80, 8, s.glass, 8);
  } else {                  // a tower
    box(ctx, 14, 6, 68, 62, 20, roof(), s.wall); windows(ctx, 14, 68, 68, 20, s.glass, 6);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)'; ctx.fillRect(14, 6, 34, 62);
  }
}
function shops(ctx, n, s, value, den, seed) {
  var r = chance(seed), glass = [s.glass, s.glassDark][value % 2];
  lot(ctx, n, s);
  ctx.fillStyle = s.pave; ctx.fillRect(0, 0, n, n);
  var tall = [4, 6, 12, 18, 26][den], blocks = den < 2 ? den + 1 : 1;
  for (var i = 0; i < blocks; i++) {
    var w = den < 2 ? 34 : 70, x = den < 2 ? 8 + i * 46 : 13, y = den < 2 ? 20 + (r() * 16 | 0) : 8, h = den < 2 ? 30 : 92 - tall - 10;
    box(ctx, x, y, w, h, tall, den >= 3 ? glass : s.shopRoof, s.wall);
    windows(ctx, x, y + h, w, tall, glass, den >= 3 ? 6 : 8);
    if (den >= 3) { ctx.fillStyle = 'rgba(255, 255, 255, 0.16)'; ctx.fillRect(x, y, w / 2, h); }
  }
}
function industry(ctx, n, s, value, den, seed) {
  var r = chance(seed);
  lot(ctx, n, s);
  ctx.fillStyle = s.yard; ctx.fillRect(4, 4, n - 8, n - 8);
  // a shed with a sawtooth roof, bigger with density, and chimneys from the third step
  var w = 40 + den * 12, h = 34 + den * 8;
  box(ctx, 8, 10, w, h, 6 + den * 2, s.metal, s.metalDark);
  ctx.fillStyle = s.metalDark;
  for (var x = 8; x < 8 + w - 6; x += 8) { ctx.beginPath(); ctx.moveTo(x, 10 + h); ctx.lineTo(x + 8, 10); ctx.lineTo(x + 8, 10 + h); ctx.fill(); }
  if (den >= 2) for (var k = 0; k < den - 1; k++) { box(ctx, 70 - k * 12, 58, 8, 8, 18, s.brick, s.brickDark); }
  if (value) { ctx.fillStyle = s.ind; ctx.fillRect(10 + (r() * 30 | 0), 74, 18, 10); ctx.fillRect(40, 76, 14, 8); }   // crates of a richer works
}

export function buildings(atlasCtx, at, s) {
  var t, k;
  // single houses in a young homes zone: tiles 249 to 260, each its own house
  for (t = TV.HOUSE; t <= TV.HHTHR; t++) {
    (function (t) {
      block(atlasCtx, at, t, 1, function (ctx, n) {
        lot(ctx, n, s); var r = chance(t * 31);
        house(ctx, 5, 6, 20, 15, ROOFS[t % ROOFS.length], s); tree(ctx, 25 + r() * 3, 24, 4, s);
      });
    })(t);
  }
  for (k = 0; k < 16; k++) block(atlasCtx, at, TV.RZB - 4 + k * 9, 3, (function (k) { return function (ctx, n) { homes(ctx, n, s, k >> 2, k & 3, k + 1); }; })(k));
  for (k = 0; k < 20; k++) block(atlasCtx, at, TV.CZB - 4 + k * 9, 3, (function (k) { return function (ctx, n) { shops(ctx, n, s, Math.floor(k / 5), k % 5, k + 7); }; })(k));
  for (k = 0; k < 8; k++) block(atlasCtx, at, TV.IZB - 4 + k * 9, 3, (function (k) { return function (ctx, n) { industry(ctx, n, s, k >> 2, k & 3, k + 13); }; })(k));
  block(atlasCtx, at, TV.HOSPITAL - 4, 3, function (ctx, n) {
    lot(ctx, n, s); box(ctx, 10, 10, 76, 64, 10, s.white, s.wall);
    ctx.fillStyle = '#d24a3f'; ctx.fillRect(42, 24, 12, 36); ctx.fillRect(30, 36, 36, 12);
  });
  block(atlasCtx, at, TV.CHURCH - 4, 3, function (ctx, n) {
    lot(ctx, n, s); box(ctx, 26, 30, 44, 50, 8, s.shopRoof, s.wall); box(ctx, 38, 8, 20, 22, 18, s.brick, s.brickDark);
    ctx.fillStyle = s.white; ctx.fillRect(46, 12, 4, 12); ctx.fillRect(42, 16, 12, 4);
  });
  block(atlasCtx, at, TV.COALBASE, 4, function (ctx, n) {
    lot(ctx, n, s); ctx.fillStyle = s.yard; ctx.fillRect(4, 4, n - 8, n - 8);
    box(ctx, 10, 46, 70, 60, 12, s.metal, s.metalDark);
    box(ctx, 72, 8, 14, 14, 30, s.brick, s.brickDark); box(ctx, 98, 8, 14, 14, 30, s.brick, s.brickDark);
    ctx.fillStyle = s.coal; ctx.beginPath(); ctx.ellipse(98, 92, 18, 12, 0, 0, Math.PI * 2); ctx.fill();
  });
  // The plant's four chimney tiles animate (four frames each, in the engine's own numbering) and the original frames are
  // the original's pixels: each is the plant's own tile with a puff of smoke rising over it instead.
  SMOKE.forEach(function (g, i) {
    for (var f = 0; f < 4; f++) {
      var from = at(TV.COALBASE + g.tile), to = at(TV.COALSMOKE1 + i * 4 + f);
      atlasCtx.clearRect(to[0], to[1], ART, ART);
      atlasCtx.drawImage(atlasCtx.canvas, from[0], from[1], ART, ART, to[0], to[1], ART, ART);
      atlasCtx.fillStyle = 'rgba(236, 236, 232, ' + (0.8 - f * 0.15).toFixed(2) + ')';
      atlasCtx.beginPath(); atlasCtx.arc(to[0] + g.x + f * 2, to[1] + g.y - f * 5, 5 + f * 1.5, 0, Math.PI * 2); atlasCtx.fill();
    }
  });
  block(atlasCtx, at, TV.NUCLEARBASE, 4, function (ctx, n) {
    lot(ctx, n, s); ctx.fillStyle = s.yard; ctx.fillRect(4, 4, n - 8, n - 8);
    ctx.fillStyle = s.white; ctx.beginPath(); ctx.arc(40, 42, 26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = s.pale; ctx.beginPath(); ctx.arc(40, 42, 16, 0, Math.PI * 2); ctx.fill();
    box(ctx, 70, 66, 42, 40, 12, s.metal, s.metalDark);
    ctx.fillStyle = s.ind; ctx.beginPath(); ctx.arc(91, 86, 8, 0, Math.PI * 2); ctx.fill();
  });
  block(atlasCtx, at, TV.FIRESTBASE, 3, function (ctx, n) {
    lot(ctx, n, s); ctx.fillStyle = s.pave; ctx.fillRect(0, 60, n, 36);
    box(ctx, 8, 10, 80, 46, 10, '#c0453b', '#8f2f28');
    ctx.fillStyle = s.white; for (var i = 0; i < 3; i++) ctx.fillRect(14 + i * 26, 58, 18, 8);
  });
  block(atlasCtx, at, TV.POLICESTBASE, 3, function (ctx, n) {
    lot(ctx, n, s); ctx.fillStyle = s.pave; ctx.fillRect(0, 62, n, 34);
    box(ctx, 8, 10, 80, 46, 10, '#3b6fc4', '#2b5293');
    ctx.fillStyle = s.white; ctx.beginPath();
    for (var i = 0; i < 10; i++) { var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? 6 : 13; ctx.lineTo(48 + Math.cos(a) * rr, 33 + Math.sin(a) * rr); }
    ctx.fill();
  });
  [TV.STADIUMBASE, TV.FULLSTADIUM - 4 - 1].forEach(function (base, full) {
    block(atlasCtx, at, base, 4, function (ctx, n) {
      lot(ctx, n, s); ctx.fillStyle = s.metal; ctx.beginPath(); ctx.ellipse(64, 64, 58, 50, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = s.metalDark; ctx.beginPath(); ctx.ellipse(64, 64, 46, 38, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4f9d58'; ctx.fillRect(32, 40, 64, 48);
      ctx.strokeStyle = s.white; ctx.lineWidth = 1.5; ctx.strokeRect(36, 44, 56, 40); ctx.beginPath(); ctx.moveTo(64, 44); ctx.lineTo(64, 84); ctx.stroke();
      if (full) { ctx.fillStyle = s.ind; for (var i = 0; i < 40; i++) ctx.fillRect(14 + (i * 37) % 100, 18 + (i * 53) % 92, 2, 2); }
    });
  });
  block(atlasCtx, at, TV.PORTBASE, 4, function (ctx, n) {
    lot(ctx, n, s); ctx.fillStyle = s.pave; ctx.fillRect(0, 0, n, n);
    ['#d24a3f', '#3b6fc4', '#e3c04a', '#4f9d58'].forEach(function (col, i) { box(ctx, 10 + (i % 2) * 22, 70 + Math.floor(i / 2) * 18, 18, 10, 4, col, 'rgba(0,0,0,0.3)'); });
    ctx.strokeStyle = s.ind; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(80, 110); ctx.lineTo(80, 30); ctx.lineTo(120, 30); ctx.stroke();
    box(ctx, 60, 10, 36, 24, 8, s.metal, s.metalDark);
  });
  // the modern layer's three (zimcity-modern.js), in the engine's spare 3 x 3 slots
  block(atlasCtx, at, 956, 3, function (ctx, n) {   // an AI data center: a long windowless hall, rooftop chillers in rows, one blue line of light
    lot(ctx, n, s); ctx.fillStyle = s.pave; ctx.fillRect(2, 2, n - 4, n - 4);
    box(ctx, 6, 8, 84, 66, 10, s.metalDark, s.coal);
    for (var r = 0; r < 2; r++) for (var k = 0; k < 5; k++) {
      var x = 11 + k * 16, y = 14 + r * 22;
      ctx.fillStyle = s.metal; ctx.fillRect(x, y, 13, 16);
      ctx.strokeStyle = s.coal; ctx.lineWidth = 1; ctx.strokeRect(x + 2.5, y + 2.5, 8, 5); ctx.strokeRect(x + 2.5, y + 9.5, 8, 5);
    }
    ctx.fillStyle = s.coal; ctx.fillRect(10, 60, 76, 6);
    ctx.fillStyle = '#5fb4ff'; ctx.fillRect(6, 76, 84, 2);
  });
  block(atlasCtx, at, 965, 3, function (ctx, n) {   // a solar farm: rows of panels on grass
    lot(ctx, n, s); ctx.fillStyle = s.grass; ctx.fillRect(2, 2, n - 4, n - 4);
    for (var r = 0; r < 5; r++) for (var k = 0; k < 3; k++) {
      ctx.fillStyle = '#2f4f86'; ctx.fillRect(8 + k * 28, 8 + r * 17, 24, 11);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)'; ctx.fillRect(8 + k * 28, 8 + r * 17, 24, 3);
    }
  });
  block(atlasCtx, at, 974, 3, function (ctx, n) {   // a wind farm: three turbines, seen from above with their shadows
    lot(ctx, n, s); ctx.fillStyle = s.grass; ctx.fillRect(2, 2, n - 4, n - 4);
    [[24, 26], [70, 40], [36, 72]].forEach(function (p, i) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(p[0] + 4, p[1] + 4); ctx.lineTo(p[0] + 22, p[1] + 14); ctx.stroke();
      ctx.strokeStyle = s.white; ctx.lineWidth = 2.5; ctx.beginPath();
      for (var b = 0; b < 3; b++) { var a = i * 0.7 + b * Math.PI * 2 / 3; ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + Math.cos(a) * 14, p[1] + Math.sin(a) * 14); }
      ctx.stroke();
      ctx.fillStyle = s.pale; ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.fill();
    });
  });
  block(atlasCtx, at, TV.AIRPORTBASE, 6, function (ctx, n) {
    lot(ctx, n, s); ctx.fillStyle = s.grass; ctx.fillRect(0, 0, n, n);
    ctx.fillStyle = s.asphalt; ctx.fillRect(8, 120, n - 16, 26);
    ctx.fillStyle = s.white; for (var x = 16; x < n - 16; x += 16) ctx.fillRect(x, 132, 8, 2);
    box(ctx, 20, 20, 90, 40, 10, s.metal, s.metalDark); windows(ctx, 20, 60, 90, 10, s.glass, 8);
    box(ctx, 140, 24, 16, 16, 30, s.white, s.wall); ctx.fillStyle = s.glass; ctx.fillRect(140, 24, 16, 8);
    ctx.fillStyle = s.asphalt; ctx.fillRect(40, 70, 16, 50);
  });
}
