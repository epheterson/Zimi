// ── Almanac: terrain ──
// The ground "Stand here" (almanac-stand.js) walks on. A body's large shape is real: a global height map shipped with
// Zimi (scripts/build_terrain.py: LOLA for the Moon, MOLA for Mars, Magellan for Venus, MESSENGER for Mercury, ETOPO
// 2022 for the Earth; 256 x 128, metres above the body's mean radius), sharpened near the viewer by the Almanac HD
// release's terrain tiles when they are installed. Below what those hold, the height is generated: craters on the
// bodies that have them, fractal hills everywhere, seeded by the place so the same spot is always the same ground.
// The bodies with no usable height map in the public domain (Titan, Pluto, the big moons) stand on their sphere with
// generated detail alone.
//
// This file is pure maths and data (tests/test_almanac_terrain.cjs runs it on its own): no DOM, no WebGL.

var AE_TERRAIN_URL = '/static/earth/terrain-';          // + <body>-v1.bin
var AE_TERRAIN_MAGIC = 'ZTRN', AE_TERRAIN_VERSION = 1, AE_TERRAIN_HEADER = 10;
var AE_TERRAIN_HD_TILE = 256, AE_TERRAIN_HD_OFFSET = 32768;   // build_terrain.py: red is the high byte of metres + 32768, green the low
var AE_TERRAIN_HD_LAYER = 'terrain/';
var AE_TERRAIN_OCTAVE = 2.1;                            // wavelengths of the generated detail fall by this much a step

// Every body one can stand on. km: the mean radius the height maps are measured from (and the stand scene's sphere);
// flat: the oblateness the orbit view draws (the Earth's position uses the geodetic frame); sea: heights below zero are
// water; terrain: a shipped height map exists; fbm: amplitude (m) at the longest wavelength lam[0] (km), shorter
// wavelengths shrink as (lam / lam[0])^H, ridge 0..1 folds the noise into ridges; relief: the amplitude follows how
// rough the real map is round the place; craters: the share of grid cells holding one, the biggest radius (km), and
// depth over radius.
var AE_STAND_BODIES = {
  earth: { km: 6371.0, flat: 0.00335281, terrain: true, sea: true, relief: true, fbm: { amp: 160, lam: [24, 0.002], H: 0.85, ridge: 0.45 } },
  moon: { km: 1737.4, terrain: true, fbm: { amp: 70, lam: [24, 0.002], H: 0.9, ridge: 0 }, craters: { density: 0.6, rMax: 14, depth: 0.17 } },
  mercury: { km: 2439.7, terrain: true, fbm: { amp: 110, lam: [24, 0.002], H: 0.9, ridge: 0 }, craters: { density: 0.6, rMax: 14, depth: 0.15 } },
  venus: { km: 6051.8, terrain: true, relief: true, fbm: { amp: 70, lam: [24, 0.002], H: 0.8, ridge: 0.6 } },
  mars: { km: 3396.2, flat: 0.00589, terrain: true, relief: true, fbm: { amp: 110, lam: [24, 0.002], H: 0.85, ridge: 0.2 }, craters: { density: 0.4, rMax: 10, depth: 0.12 } },
  io: { km: 1821.6, fbm: { amp: 260, lam: [24, 0.002], H: 0.9, ridge: 0.3 } },
  europa: { km: 1560.8, fbm: { amp: 25, lam: [24, 0.002], H: 0.7, ridge: 0.85 }, craters: { density: 0.06, rMax: 5, depth: 0.06 } },
  ganymede: { km: 2634.1, fbm: { amp: 120, lam: [24, 0.002], H: 0.85, ridge: 0.5 }, craters: { density: 0.4, rMax: 12, depth: 0.1 } },
  callisto: { km: 2410.3, fbm: { amp: 90, lam: [24, 0.002], H: 0.85, ridge: 0 }, craters: { density: 0.7, rMax: 12, depth: 0.12 } },
  titan: { km: 2574.7, fbm: { amp: 35, lam: [24, 0.002], H: 0.8, ridge: 0.2 } },
  pluto: { km: 1188.3, fbm: { amp: 170, lam: [24, 0.002], H: 0.85, ridge: 0.3 }, craters: { density: 0.25, rMax: 12, depth: 0.1 } }
};

// ── The shipped map ──
var _aeTerr = {};   // body -> { state: 'loading' | 'ready' | 'none', w, h, data (Int16Array, rows from the north), hd, promise }
function _aeTerrainParse(buf) {
  if (!buf || buf.byteLength < AE_TERRAIN_HEADER) return null;
  var b = new Uint8Array(buf, 0, 4), v = new DataView(buf);
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== AE_TERRAIN_MAGIC || v.getUint8(4) !== AE_TERRAIN_VERSION) return null;
  var w = v.getUint16(6, true), h = v.getUint16(8, true);
  if (buf.byteLength !== AE_TERRAIN_HEADER + 2 * w * h) return null;
  var data = new Int16Array(w * h);
  for (var i = 0; i < data.length; i++) data[i] = v.getInt16(AE_TERRAIN_HEADER + 2 * i, true);
  return { w: w, h: h, data: data };
}
function _aeTerrainSet(key, parsed) {
  var t = _aeTerr[key] || (_aeTerr[key] = {});
  if (parsed) { t.state = 'ready'; t.w = parsed.w; t.h = parsed.h; t.data = parsed.data; }
  else t.state = 'none';
  return t;
}
// The body's map, once: a promise of its record (state 'none' where the body has no map or it did not arrive).
function _aeTerrainLoad(key) {
  var t = _aeTerr[key];
  if (t && t.promise) return t.promise;
  t = _aeTerr[key] = t || {};
  if (!AE_STAND_BODIES[key] || !AE_STAND_BODIES[key].terrain || typeof fetch !== 'function') { _aeTerrainSet(key, null); return (t.promise = Promise.resolve(t)); }
  t.state = 'loading';
  t.promise = fetch(AE_TERRAIN_URL + key + '-v1.bin').then(function (r) { if (!r.ok) throw new Error('terrain'); return r.arrayBuffer(); })
    .then(function (buf) { _aeTerrainSet(key, _aeTerrainParse(buf)); return t; })
    .catch(function () { t.promise = null; _aeTerrainSet(key, null); return t; });   // asked for again next time
  return t.promise;
}

// Metres at a place from the shipped map: bilinear, longitude wrapping, the rows clamped at the poles.
function _aeTerrainCoarse(t, lat, lon) {
  var x = (lon + 180) / 360 * t.w - 0.5, y = (90 - lat) / 180 * t.h - 0.5;
  var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  var ya = Math.min(t.h - 1, Math.max(0, y0)), yb = Math.min(t.h - 1, Math.max(0, y0 + 1));
  var xa = ((x0 % t.w) + t.w) % t.w, xb = (xa + 1) % t.w, d = t.data;
  var top = d[ya * t.w + xa] * (1 - fx) + d[ya * t.w + xb] * fx, bot = d[yb * t.w + xa] * (1 - fx) + d[yb * t.w + xb] * fx;
  return top * (1 - fy) + bot * fy;
}

// ── The Almanac HD tiles ──
// terrain/<body>/<z>/<x>/<y>.webp at the layer's deepest level, the nine round a place, fetched when someone stands
// there. Heights are read from them where they are all in; elsewhere the shipped map holds.
function _aeTerrainHdCell(t, lat, lon) {
  var hd = t.hd;
  if (!hd || !hd.z && hd.z !== 0) return null;
  var n = Math.pow(2, hd.z), px = AE_TERRAIN_HD_TILE;
  var gx = (lon + 180) / 360 * 2 * n * px - 0.5, gy = (90 - lat) / 180 * n * px - 0.5;
  var x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0, cols = 2 * n * px, rows = n * px;
  function texel(ix, iy) {
    ix = ((ix % cols) + cols) % cols; iy = Math.min(rows - 1, Math.max(0, iy));
    var tile = hd.tiles[Math.floor(ix / px) + '/' + Math.floor(iy / px)];
    return tile ? tile[(iy % px) * px + (ix % px)] : null;
  }
  var a = texel(x0, y0), b = texel(x0 + 1, y0), c = texel(x0, y0 + 1), d = texel(x0 + 1, y0 + 1);
  if (a === null || b === null || c === null || d === null) return null;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
function _aeTerrainHdTile(url) {
  return fetch(url).then(function (r) { if (!r.ok) throw new Error('tile'); return r.blob(); })
    .then(function (blob) { return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); })
    .then(function (bmp) {
      var cv = document.createElement('canvas');
      cv.width = cv.height = AE_TERRAIN_HD_TILE;
      var g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      var px = g.getImageData(0, 0, AE_TERRAIN_HD_TILE, AE_TERRAIN_HD_TILE).data, out = new Float32Array(AE_TERRAIN_HD_TILE * AE_TERRAIN_HD_TILE);
      for (var i = 0; i < out.length; i++) out[i] = px[4 * i] * 256 + px[4 * i + 1] - AE_TERRAIN_HD_OFFSET;
      return out;
    });
}
// base: the HD ZIM's folder; z: the layer's deepest level. Resolves when the tiles that exist are in.
function _aeTerrainHdLoad(key, lat, lon, base, z) {
  var t = _aeTerr[key];
  if (!t || t.state !== 'ready' || typeof createImageBitmap !== 'function') return Promise.resolve(false);
  var n = Math.pow(2, z), tx = Math.floor((lon + 180) / 360 * 2 * n), ty = Math.floor((90 - lat) / 180 * n), jobs = [];
  var hd = t.hd = t.hd && t.hd.z === z ? t.hd : { z: z, tiles: {} };
  for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
    var x = ((tx + dx) % (2 * n) + 2 * n) % (2 * n), y = ty + dy, id = x + '/' + y;
    if (y < 0 || y >= n || hd.tiles[id]) continue;
    jobs.push(_aeTerrainHdTile(base + AE_TERRAIN_HD_LAYER + key + '/' + z + '/' + x + '/' + y + '.webp').then(function (arr) { hd.tiles[this] = arr; }.bind(id)).catch(function () {}));
  }
  return Promise.all(jobs).then(function () { return Object.keys(hd.tiles).length > 0; });
}

// ── Generated detail ──
// Integer hash to 0..1, and smooth value noise on the integer lattice (-1..1): the same numbers on every machine.
function _aeHash3(x, y, z, s) {
  var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1103515245) + Math.imul(s | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}
function _aeFade(t) { return t * t * (3 - 2 * t); }
function _aeNoise3(x, y, z, s) {
  var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = _aeFade(x - xi), fy = _aeFade(y - yi), fz = _aeFade(z - zi);
  function h(a, b, c) { return _aeHash3(xi + a, yi + b, zi + c, s) * 2 - 1; }
  var x00 = h(0, 0, 0) + (h(1, 0, 0) - h(0, 0, 0)) * fx, x10 = h(0, 1, 0) + (h(1, 1, 0) - h(0, 1, 0)) * fx;
  var x01 = h(0, 0, 1) + (h(1, 0, 1) - h(0, 0, 1)) * fx, x11 = h(0, 1, 1) + (h(1, 1, 1) - h(0, 1, 1)) * fx;
  var y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}
// Fractal hills at a point (u: unit vector, km: the radius): amplitude falls with wavelength, the wavelengths finer
// than lodKm are left out (a mesh that cannot show them).
function _aeFbmHeight(u, km, f, lodKm, amp) {
  var px = u[0] * km, py = u[1] * km, pz = u[2] * km, lam = f.lam[0], sum = 0, k = 0;
  while (lam >= f.lam[1] && lam >= lodKm) {
    var n = _aeNoise3(px / lam, py / lam, pz / lam, 11 + k);
    if (f.ridge) n = n * (1 - f.ridge) + f.ridge * (1 - 2 * Math.abs(n));
    sum += amp * Math.pow(lam / f.lam[0], f.H) * n;
    lam /= AE_TERRAIN_OCTAVE; k++;
  }
  return sum;
}
// Craters, one octave of sizes at a time: the octave's radius r gets a grid of cells 7 r on a side, each holding a crater
// with the body's probability, its centre in the middle of the cell, so only the point's own cell can reach it (a
// crater's rim ends 1.3 radii out, which is under a fifth of the cell). A bowl, a raised rim, a soft apron.
var AE_CRATER_CELL = 7, AE_CRATER_REACH = 1.3, AE_CRATER_RIM = 0.35, AE_CRATER_RIM_W = 0.22, AE_CRATER_MIN_KM = 0.004;
function _aeCraterHeight(u, km, c, lodKm) {
  var px = u[0] * km, py = u[1] * km, pz = u[2] * km, sum = 0;
  for (var k = 0, r = c.rMax; r >= AE_CRATER_MIN_KM && r * 2 >= lodKm; k++, r *= 0.5) {
    var cell = AE_CRATER_CELL * r, ix = Math.floor(px / cell), iy = Math.floor(py / cell), iz = Math.floor(pz / cell), s = 101 + k;
    if (_aeHash3(ix, iy, iz, s) > c.density) continue;
    var cx = (ix + 0.2 + 0.6 * _aeHash3(ix, iy, iz, s + 50)) * cell, cy = (iy + 0.2 + 0.6 * _aeHash3(ix, iy, iz, s + 51)) * cell, cz = (iz + 0.2 + 0.6 * _aeHash3(ix, iy, iz, s + 52)) * cell;
    var rr = r * (0.8 + 0.4 * _aeHash3(ix, iy, iz, s + 53)), x = Math.hypot(px - cx, py - cy, pz - cz) / rr;
    if (x > AE_CRATER_REACH) continue;
    var depth = rr * c.depth * (0.6 + 0.8 * _aeHash3(ix, iy, iz, s + 54)) * 1000;   // metres
    sum += (x < 1 ? -depth * (1 - x * x) : 0) + depth * AE_CRATER_RIM * Math.exp(-Math.pow((x - 1) / AE_CRATER_RIM_W, 2));
  }
  return sum;
}
// How rough the real map is round a place: its distance from the mean of the four cells a step away (metres).
var AE_TERRAIN_RELIEF_STEP_DEG = 1.4, AE_TERRAIN_RELIEF_SCALE = 500, AE_TERRAIN_RELIEF_MIN = 0.05, AE_TERRAIN_RELIEF_MAX = 3;
function _aeTerrainRelief(t, lat, lon) {
  var s = AE_TERRAIN_RELIEF_STEP_DEG, c = _aeTerrainCoarse(t, lat, lon);
  var m = (_aeTerrainCoarse(t, lat + s, lon) + _aeTerrainCoarse(t, lat - s, lon) + _aeTerrainCoarse(t, lat, lon + s) + _aeTerrainCoarse(t, lat, lon - s)) / 4;
  return Math.min(AE_TERRAIN_RELIEF_MAX, Math.max(AE_TERRAIN_RELIEF_MIN, Math.abs(c - m) / AE_TERRAIN_RELIEF_SCALE));
}
function _aeUnitVec(lat, lon) {
  var la = lat * Math.PI / 180, lo = lon * Math.PI / 180, c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}
// Metres above the body's mean radius at a place. lodKm: the finest wavelength the caller can show (0: all of it).
// Returns { h, sea }: sea is true where the real map is below the water line (the height is then 0).
function _aeTerrainHeight(key, lat, lon, lodKm) {
  var b = AE_STAND_BODIES[key], t = _aeTerr[key];
  if (!b) return { h: 0, sea: false };
  var base = 0, ready = !!t && t.state === 'ready';
  if (ready) {
    var hd = t.hd ? _aeTerrainHdCell(t, lat, lon) : null;
    base = hd === null ? _aeTerrainCoarse(t, lat, lon) : hd;
  }
  if (b.sea && ready && base < 0) return { h: 0, sea: true };
  var u = _aeUnitVec(lat, lon), amp = b.fbm.amp * (b.relief && ready ? _aeTerrainRelief(t, lat, lon) : 1);
  var h = base + _aeFbmHeight(u, b.km, b.fbm, lodKm || 0, amp) + (b.craters ? _aeCraterHeight(u, b.km, b.craters, lodKm || 0) : 0);
  if (b.sea && h < 0) h = 0;
  return { h: h, sea: false };
}
// What the models lane (and anything that stands something on the ground) asks: metres above the body's reference
// radius, 0 until the body's map is in (asking starts it loading).
function _aeStandHeight(key, lat, lon) {
  if (!AE_STAND_BODIES[key]) return 0;
  var t = _aeTerr[key];
  if (!t || t.state === 'loading' || !t.state) { _aeTerrainLoad(key); if (!t || t.state !== 'ready') return 0; }
  return _aeTerrainHeight(key, lat, lon, 0).h;
}

// ── The mesh ──
// A polar grid round the viewer: rings that grow geometrically from a few decimetres out to the horizon of the
// highest point the camera starts from, so the same mesh serves the view from orbit and from the ground (every ring
// is as fine as its distance asks). Built in slices (step(ms) -> done) so the flight to the place is never held up.
var AE_MESH_RINGS = 220, AE_MESH_AZ = 180, AE_MESH_S0_M = 0.45, AE_MESH_CAP_MARGIN = 1.06;
function _aeMeshCap(km, altKm) {
  var cap = Math.acos(km / (km + altKm)) * AE_MESH_CAP_MARGIN;
  return Math.min(cap, Math.PI * 0.95);
}
function _aeMeshBuilder(key, lat0, lon0, capRad) {
  var b = AE_STAND_BODIES[key], R = b.km * 1000, nr = AE_MESH_RINGS, na = AE_MESH_AZ, count = 1 + nr * na;
  var pos = new Float32Array(count * 3), dir = new Float32Array(count * 3), hgt = new Float32Array(count), sea = new Float32Array(count);
  var sMax = capRad * R, g = Math.pow(sMax / AE_MESH_S0_M, 1 / (nr - 1));
  var la0 = lat0 * Math.PI / 180, sl0 = Math.sin(la0), cl0 = Math.cos(la0);
  var h0 = _aeTerrainHeight(key, lat0, lon0, 0).h;
  var made = 0;
  function vertex(i, ring, j) {
    var theta = ring ? j / na * 2 * Math.PI : 0, s = ring ? AE_MESH_S0_M * Math.pow(g, ring - 1) : 0, sg = s / R;
    var lat, lon;
    if (!ring) { lat = lat0; lon = lon0; }
    else {
      var sinLat = sl0 * Math.cos(sg) + cl0 * Math.sin(sg) * Math.cos(theta);
      lat = Math.asin(Math.max(-1, Math.min(1, sinLat)));
      lon = lon0 * Math.PI / 180 + Math.atan2(Math.sin(theta) * Math.sin(sg) * cl0, Math.cos(sg) - sl0 * sinLat);
      lat = lat * 180 / Math.PI; lon = lon * 180 / Math.PI;
    }
    var th = _aeTerrainHeight(key, lat, lon, s * 0.0005);   // the wavelengths a ring's spacing (about 7% of s) can hold
    var rr = R + th.h, sin = Math.sin(sg);
    pos[3 * i] = rr * sin * Math.sin(theta);
    pos[3 * i + 1] = rr * sin * Math.cos(theta);
    pos[3 * i + 2] = rr * Math.cos(sg) - (R + h0);
    var u = _aeUnitVec(lat, ((lon + 540) % 360) - 180);
    dir[3 * i] = u[0]; dir[3 * i + 1] = u[1]; dir[3 * i + 2] = u[2];
    hgt[i] = th.h; sea[i] = th.sea ? 1 : 0;
  }
  return {
    count: count, pos: pos, dir: dir, hgt: hgt, sea: sea, h0: h0, nr: nr, na: na, sMax: sMax,
    step: function (ms) {
      var t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      if (!made) { vertex(0, 0, 0); made = 1; }
      while (made < count) {
        var ring = Math.floor((made - 1) / na) + 1, j = (made - 1) % na;
        vertex(made, ring, j); made++;
        if (j === na - 1 && ms && typeof performance !== 'undefined' && performance.now() - t0 > ms) break;
      }
      return made >= count;
    },
    finish: function () { return _aeMeshFinish(this); }
  };
}
// Triangles and smooth normals from the filled vertices.
function _aeMeshFinish(m) {
  var nr = m.nr, na = m.na, p = m.pos, nrm = new Float32Array(m.count * 3), idx = new Uint32Array(na * 3 + (nr - 1) * na * 6), k = 0;
  function at(ring, j) { return ring ? 1 + (ring - 1) * na + ((j % na) + na) % na : 0; }
  for (var j = 0; j < na; j++) idx[k++] = 0, idx[k++] = at(1, j + 1), idx[k++] = at(1, j);
  for (var r = 1; r < nr; r++) for (var q = 0; q < na; q++) {
    var a = at(r, q), b = at(r, q + 1), c = at(r + 1, q), d = at(r + 1, q + 1);
    idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = b; idx[k++] = d; idx[k++] = c;
  }
  for (var rg = 1; rg <= nr; rg++) for (var jj = 0; jj < na; jj++) {
    var i = at(rg, jj), e = at(rg, jj + 1), w = at(rg, jj - 1), inn = rg > 1 ? at(rg - 1, jj) : 0, out = rg < nr ? at(rg + 1, jj) : i;
    var ta = [p[3 * e] - p[3 * w], p[3 * e + 1] - p[3 * w + 1], p[3 * e + 2] - p[3 * w + 2]];
    var tb = [p[3 * out] - p[3 * inn], p[3 * out + 1] - p[3 * inn + 1], p[3 * out + 2] - p[3 * inn + 2]];
    var n = [ta[1] * tb[2] - ta[2] * tb[1], ta[2] * tb[0] - ta[0] * tb[2], ta[0] * tb[1] - ta[1] * tb[0]], l = Math.hypot(n[0], n[1], n[2]) || 1;
    nrm[3 * i] = n[0] / l; nrm[3 * i + 1] = n[1] / l; nrm[3 * i + 2] = n[2] / l;
  }
  var cx = 0, cy = 0, cz = 0;
  for (var s = 1; s <= na; s++) { cx += nrm[3 * s]; cy += nrm[3 * s + 1]; cz += nrm[3 * s + 2]; }
  var cl = Math.hypot(cx, cy, cz) || 1;
  nrm[0] = cx / cl; nrm[1] = cy / cl; nrm[2] = cz / cl;
  return { nrm: nrm, idx: idx };
}
