// ── Almanac: shadows the relief casts ──
// Stand here (almanac-stand.js) lights the ground by its slope; this adds what slope cannot say: a crater's rim, a
// mountain, a ridge shading the ground behind it when the Sun is low. The height of the ground is sampled once on two
// square grids round the viewer (fine to a few kilometres, coarse to 150 km: almanac-terrain.js, with the body's curve),
// and each vertex of the ground's mesh then looks along the Sun's direction over them: how much of the Sun's disc a
// ridge leaves it (soft where the shadow is far from what casts it, as a real one is). The result is a number a vertex,
// 0 (in the shadow) to 1 (lit), drawn smooth across the triangles; redone, in slices, when the Sun has moved.
//
// Pure maths on arrays (tests/test_almanac_terrain.cjs): no DOM, no WebGL.

var AE_SHADE_LEVELS = [{ half: 6000, n: 192 }, { half: 150000, n: 192 }];   // metres either side of the viewer, cells a side
var AE_SHADE_START_M = 8, AE_SHADE_STEP = 0.12, AE_SHADE_STEP_MIN_M = 6, AE_SHADE_STEP_CELLS = 0.8;     // the march along the Sun: where it starts, the share of the distance a step is, its least
var AE_SHADE_BIAS_M = 0.5, AE_SHADE_BIAS_PER_M = 0.002;                        // a ray this far under the ground is let through (the grid is not the mesh)
var AE_SHADE_MIN_SUN_Z = 0.004;                                               // a Sun lower than this (the sine of its height) casts no shadow worth the march
var AE_SHADE_TAN_SUN = 0.0047;                                                // the tangent of the Sun's angular radius (at the Earth)

// The grids' heights, built in slices: { step(ms) -> done, levels }. height(x, y) is the ground's height over the viewer's
// foot, metres, at a local east/north place (the body's curve in it): `at` supplies it.
function _aeShadeGrids(at) {
  var levels = AE_SHADE_LEVELS.map(function (l) { return { half: l.half, n: l.n, cell: 2 * l.half / l.n, z: new Float32Array(l.n * l.n) }; });
  var li = 0, k = 0, zmax = -Infinity;
  return {
    levels: levels,
    zmax: function () { return zmax; },
    step: function (ms) {
      var t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      while (li < levels.length) {
        var L = levels[li], total = L.n * L.n;
        while (k < total) {
          var iy = Math.floor(k / L.n), ix = k % L.n, x = -L.half + (ix + 0.5) * L.cell, y = -L.half + (iy + 0.5) * L.cell, z = at(x, y, L.cell);
          L.z[k++] = z;
          if (z > zmax) zmax = z;
          if (ms && (k & 255) === 0 && typeof performance !== 'undefined' && performance.now() - t0 > ms) return false;
        }
        li++; k = 0;
      }
      return true;
    }
  };
}
// The ground's height at a local place from the grids (bilinear, the finest grid that holds it), or null outside them all.
var _aeShadeCellOut = 0;   // the cell of the grid that answered the last _aeShadeHeight
function _aeShadeHeight(levels, x, y) {
  for (var i = 0; i < levels.length; i++) {
    var L = levels[i], fx = (x + L.half) / L.cell - 0.5, fy = (y + L.half) / L.cell - 0.5;
    if (fx < 0 || fy < 0 || fx > L.n - 1 || fy > L.n - 1) continue;
    _aeShadeCellOut = L.cell;
    var x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0, x1 = Math.min(L.n - 1, x0 + 1), y1 = Math.min(L.n - 1, y0 + 1), z = L.z;
    return (z[y0 * L.n + x0] * (1 - ax) + z[y0 * L.n + x1] * ax) * (1 - ay) + (z[y1 * L.n + x0] * (1 - ax) + z[y1 * L.n + x1] * ax) * ay;
  }
  return null;
}
// How much of the Sun a place sees: 1 lit, 0 in a shadow. sun: unit vector toward the Sun in the local frame.
function _aeShadeVisible(grids, x, y, z, sun, tanSun) {
  var sz = sun[2];
  if (sz < AE_SHADE_MIN_SUN_Z) return 1;
  var vis = 1, t = AE_SHADE_START_M, reach = AE_SHADE_LEVELS[AE_SHADE_LEVELS.length - 1].half * 1.4, zmax = grids.zmax(), lv = grids.levels;
  while (t < reach) {
    var qx = x + sun[0] * t, qy = y + sun[1] * t, qz = z + sz * t;
    if (qz > zmax + 1) break;   // over the highest ground there is
    var g = _aeShadeHeight(lv, qx, qy);
    if (g === null) break;
    var clear = qz - g + AE_SHADE_BIAS_M + AE_SHADE_BIAS_PER_M * t;
    if (clear < 0) {
      var v = Math.max(0, Math.min(1, 0.5 + 0.5 * clear / (t * tanSun + 0.5)));   // the ridge covers the Sun's disc to this much
      if (v < vis) vis = v;
      if (vis <= 0) return 0;
    }
    t += Math.max(AE_SHADE_STEP_MIN_M, Math.min(t * AE_SHADE_STEP, _aeShadeCellOut * AE_SHADE_STEP_CELLS));   // never over a cell: a ridge one cell wide is not stepped across
  }
  return vis;
}
// A job: every vertex of a mesh (positions: x, y, z a vertex, metres) against the grids for one Sun, in slices.
function _aeShadeJob(grids, pos, count, sun, tanSun, shade) {
  var cursor = 0;
  return {
    shade: shade,
    step: function (ms) {
      var t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      while (cursor < count) {
        shade[cursor] = _aeShadeVisible(grids, pos[3 * cursor], pos[3 * cursor + 1], pos[3 * cursor + 2], sun, tanSun);
        cursor++;
        if (ms && (cursor & 63) === 0 && typeof performance !== 'undefined' && performance.now() - t0 > ms) return false;
      }
      return true;
    }
  };
}
