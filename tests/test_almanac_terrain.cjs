// The ground Stand here walks on (zimi/static/almanac-terrain.js, the atmospheres of almanac-standgl.js): the shipped
// height maps say what they should (Olympus Mons high, Hellas low, the sea level at sea), the generated detail is the same
// every time and stays in bounds, the mesh round a viewer is whole, and the bodies one can stand on are the ones the
// 3D view offers.
//
// Run: node tests/test_almanac_terrain.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8');
const ctx = { console, Math, Float32Array, Int16Array, Uint32Array, Uint8Array, DataView, ArrayBuffer, performance: { now: () => Date.now() } };
vm.createContext(ctx);
vm.runInContext(read('almanac-terrain.js'), ctx);
vm.runInContext(read('almanac-terrainshade.js'), ctx);
const T = (code) => vm.runInContext(code, ctx);
ctx.__bin = (k) => { const b = fs.readFileSync(path.join(STATIC, 'earth', 'terrain-' + k + '-v1.bin')); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

const near = (a, b, eps) => Math.abs(a - b) <= eps;
let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}

// ── 1. The shipped maps ──
const bodies = ['earth', 'moon', 'mars', 'venus', 'mercury'];
bodies.forEach((k) => {
  const p = T('_aeTerrainParse(__bin("' + k + '"))');
  check(!!p && p.w === 256 && p.h === 128 && p.data.length === 256 * 128, k + ': a 256 x 128 map that parses');
  T('_aeTerrainSet("' + k + '", _aeTerrainParse(__bin("' + k + '")))');
});
check(T('_aeTerrainParse(new ArrayBuffer(10))') === null, 'a map of the wrong size is refused');
check(T('_aeTerrainParse(__bin("moon").slice(0, 5000))') === null, 'a truncated map is refused');
const coarse = (k, lat, lon) => T('_aeTerrainCoarse(_aeTerr.' + k + ', ' + lat + ', ' + lon + ')');
check(coarse('mars', 18.65, 226.2 - 360) > 15000, 'Mars: Olympus Mons is more than 15 km high (' + Math.round(coarse('mars', 18.65, 226.2 - 360)) + ' m)');
check(coarse('mars', -42.4, 70.5) < -5000, 'Mars: Hellas is more than 5 km deep (' + Math.round(coarse('mars', -42.4, 70.5)) + ' m)');
check(coarse('mars', 18.65, 226.2 - 360) - coarse('mars', -42.4, 70.5) > 20000, 'Mars: Olympus Mons stands more than 20 km over Hellas');
check(coarse('moon', -53, -169) < coarse('moon', 0, 0) - 3000, 'Moon: the South Pole-Aitken basin is far below the Mare Tranquillitatis side');
check(coarse('earth', 28, 87) > 1500, 'Earth: the Himalaya side of Tibet is high');
check(coarse('earth', 0, -150) < -3000, 'Earth: the mid Pacific is deep');
check(coarse('venus', 65.2, 3.3) > 7000, 'Venus: Maxwell Montes is high');
check(Math.abs(coarse('moon', 10, 179.9) - coarse('moon', 10, -179.9)) < 400, 'longitude wraps at the date line');

// ── 2. Heights with the generated detail ──
const h = (k, lat, lon, lod) => T('_aeTerrainHeight("' + k + '", ' + lat + ', ' + lon + ', ' + (lod || 0) + ')');
check(h('mars', 18.65, -133.8).h === h('mars', 18.65, -133.8).h, 'the same place is the same height every time');
check(h('mars', 18.65, -133.8).h > 14000, 'Mars: Olympus Mons is still high with its detail');
check(h('earth', 0, -150).sea === true && h('earth', 0, -150).h === 0, 'Earth: open ocean is sea at height 0');
check(h('earth', 28, 87).sea === false && h('earth', 28, 87).h > 1500, 'Earth: Tibet is land');
{
  // Craters: along a line over the Moon there are bowls (below the line's local level) and rims.
  const base = coarse('moon', 10, 20);
  let lo = 0, hi = 0;
  for (let i = 0; i < 4000; i++) { const d = h('moon', 10 + i * 0.0005, 20 + i * 0.0003).h - h('moon', 10 + i * 0.0005, 20 + i * 0.0003, 1e9).h; lo = Math.min(lo, d); hi = Math.max(hi, d); }
  check(lo < -30 && hi > 10, 'Moon: craters dig bowls (' + Math.round(lo) + ' m) and raise rims (' + Math.round(hi) + ' m) over a short walk');
  check(lo > -9000 && hi < 9000, 'the detail stays within what a crater does');
}
check(h('titan', 10, 10).h !== 0 && Math.abs(h('titan', 10, 10).h) < 400, 'Titan, with no map, has generated hills of a few hundred metres at most');
check(T('_aeStandHeight("moon", 0, 0)') === h('moon', 0, 0).h, '_aeStandHeight is the height with the detail');
check(T('_aeStandHeight("jupiter", 0, 0)') === 0, 'a body that cannot be stood on has no ground (0)');
{
  // A body whose map is not loaded answers 0 (and starts the load).
  ctx.fetch = () => new Promise(() => {});
  check(T('_aeStandHeight("mercury", 0, 0)') !== 0 || T('_aeTerr.mercury.state') === 'ready', 'a loaded map answers (here Mercury, from the test)');
  T('delete _aeTerr.pluto');
  check(T('_aeStandHeight("pluto", 5, 5)') !== undefined, 'a body with no map answers');
}

// ── 2b. Land and sea, and the HD tiles ──
{
  const lb = fs.readFileSync(path.join(STATIC, 'earth', 'land-v1.bin'));
  ctx.__land = T('_aeTerrainLandParse').call(null, lb.buffer.slice(lb.byteOffset, lb.byteOffset + lb.byteLength));
  check(!!ctx.__land && ctx.__land.w === 8192 && ctx.__land.h === 4096, 'the land mask parses (8192 x 4096)');
  check(T('_aeTerrainLandParse(new ArrayBuffer(12))') === null, 'a mask of the wrong bytes is refused');
  const at = (lat, lon) => T('_aeTerrainLandAt(__land, ' + lat + ', ' + lon + ')');
  check(at(38.5, -98) === 1 && at(0, -150) === 0 && at(-20, -30) === 0, 'Kansas is land; the Pacific and the South Atlantic are sea');
  check(at(37.77, -122.42) > 0.5 && at(37.77, -123.2) < 0.5, 'San Francisco is land and the sea off the Golden Gate (about 70 km west) is sea');
  check(at(51.5, -0.12) > 0.5 && at(52.5, 3.5) < 0.5, 'London is land; the North Sea off the Dutch coast is sea');
  check(at(-80, 0) === 1 && at(-34, 153) < 0.5, 'Antarctica is land; the Tasman Sea off Sydney (about 180 km out) is sea');
  let land = 0;
  for (let i = 0; i < 20000; i++) land += at(Math.asin(2 * ((i * 0.6180339887) % 1) - 1) * 180 / Math.PI, ((i * 0.7548776662) % 1) * 360 - 180) > 0.5 ? 1 : 0;
  check(land / 20000 > 0.27 && land / 20000 < 0.38, 'about a third of the globe is land (' + (land / 200).toFixed(1) + '%)');
  ctx.__prev = T('_aeTerr.earth.land');
  T('_aeTerr.earth.land = __land');
  check(h('earth', 0, -150).sea === true, 'Earth: with the mask, open ocean is sea');
  check(h('earth', 37.77, -122.42).sea === false && h('earth', 37.77, -122.42).h >= 3, 'Earth: San Francisco stands on land (the coarse map reads it below zero)');
  T('_aeTerr.earth.land = __prev');
}
{
  // HD tiles: a tile of known heights is read bilinearly, and a place without its tiles falls back to the shipped map.
  const px = 256, tile = new Float32Array(px * px);
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) tile[y * px + x] = x * 10;
  ctx.__tile = tile;
  T('_aeTerr.moon.hd = { z: 0, tiles: { "0/0": __tile } }');
  const cell = (lat, lon) => T('_aeTerrainHdCell(_aeTerr.moon, ' + lat + ', ' + lon + ')');
  check(near(cell(10, -170), 10 * ((-170 + 180) / 180 * px - 0.5), 1), 'an HD tile gives its heights (' + Math.round(cell(10, -170)) + ' m)');
  check(cell(10, 100) === null, 'a place whose tile is not in falls back (null)');
  T('_aeTerr.moon.hd = null');
}

// ── 3. The mesh ──
{
  const b = T('_aeMeshBuilder("moon", 20.19, 30.77, _aeMeshCap(1737.4, 400))');
  let done = false, slices = 0;
  while (!done && slices < 100000) { done = b.step(2); slices++; }
  const fin = b.finish();
  check(done && b.count === 1 + b.nr * b.na, 'the mesh fills in slices (' + slices + ') to ' + b.count + ' vertices');
  check(b.pos[0] === 0 && b.pos[1] === 0 && b.pos[2] === 0, 'the first vertex is the viewer\'s feet, the origin');
  let up = 0, unit = 0;
  for (let i = 0; i < b.count; i++) { const l = Math.hypot(fin.nrm[3 * i], fin.nrm[3 * i + 1], fin.nrm[3 * i + 2]); if (Math.abs(l - 1) < 1e-3) unit++; if (fin.nrm[3 * i + 2] > 0) up++; }
  check(unit === b.count, 'every normal is a unit vector');
  check(up > 0.9 * b.count, 'the normals point up, away from the planet (' + up + ' of ' + b.count + ')');
  // The sphere curves away: a vertex at height h and angle sigma from the feet sits at z = (R + h) cos(sigma) - (R + h0).
  const ring = 1 + 170 * b.na, R = 1737400, hh = b.hgt[ring], xy = Math.hypot(b.pos[3 * ring], b.pos[3 * ring + 1]);
  const sigma = Math.asin(xy / (R + hh)), want = (R + hh) * Math.cos(sigma) - (R + b.h0);
  check(Math.abs(b.pos[3 * ring + 2] - want) < 0.5, 'the ground curves away as the planet does (' + (-b.pos[3 * ring + 2]).toFixed(1) + ' m down at ' + Math.round(xy) + ' m out)');
  let maxIdx = 0;
  for (let i = 0; i < fin.idx.length; i++) maxIdx = Math.max(maxIdx, fin.idx[i]);
  check(maxIdx === b.count - 1 && fin.idx.length % 3 === 0, 'the triangles use every vertex and no more');
  let outward = 0;
  for (let i = 0; i < fin.idx.length; i += 3 * 97) {
    const a = fin.idx[i], c = fin.idx[i + 1], d = fin.idx[i + 2];
    const ux = b.pos[3 * c] - b.pos[3 * a], uy = b.pos[3 * c + 1] - b.pos[3 * a + 1], vx = b.pos[3 * d] - b.pos[3 * a], vy = b.pos[3 * d + 1] - b.pos[3 * a + 1];
    if (ux * vy - uy * vx > 0) outward++;
  }
  check(outward > 0.95 * Math.ceil(fin.idx.length / (3 * 97)), 'the triangles face up (counter-clockwise from above)');
  check(b.sMax > 500000, 'the rings reach the horizon from a high orbit (' + Math.round(b.sMax / 1000) + ' km)');
}

// ── 3b. Shadows the relief casts ──
{
  // A wall 50 m high across x = 200..260 on level ground.
  ctx.__at = (x) => (x > 200 && x < 260 ? 50 : 0);
  const grids = T('_aeShadeGrids')((x, y) => ctx.__at(x));
  let guard = 0;
  while (!grids.step(50) && guard++ < 100000) { /* in slices */ }
  ctx.__g = grids;
  const vis = (x, z, el, az) => T('_aeShadeVisible(__g, ' + x + ', 0, ' + z + ', [' + Math.sin(az) * Math.cos(el) + ', ' + Math.cos(az) * Math.cos(el) + ', ' + Math.sin(el) + '], 0.0047)');
  const deg = Math.PI / 180;
  check(vis(300, 0, 10 * deg, -Math.PI / 2) < 0.05, 'behind a wall with the Sun 10 degrees up on the wall\'s side: in its shadow');
  check(vis(300, 0, 10 * deg, Math.PI / 2) === 1, 'on the Sun\'s side of the wall: lit');
  check(vis(300, 0, 60 * deg, -Math.PI / 2) === 1, 'with the Sun 60 degrees up the wall throws no shadow that far');
  check(vis(300, 0, 2 * deg, -Math.PI / 2) < 0.05 && vis(1500, 0, 2 * deg, -Math.PI / 2) < 0.6, 'a low Sun: the shadow runs a kilometre and more (' + vis(300, 0, 2 * deg, -Math.PI / 2).toFixed(2) + ' ' + vis(1500, 0, 2 * deg, -Math.PI / 2).toFixed(2) + ')');
  check(vis(300, 0, 0.0, -Math.PI / 2) === 1, 'a Sun on the horizon casts none by this march (the planet\'s own shadow takes over)');
  const ends = [vis(300, 0, 15 * deg, -Math.PI / 2), vis(500, 0, 15 * deg, -Math.PI / 2), vis(900, 0, 15 * deg, -Math.PI / 2)];
  check(ends[0] < 0.05 && ends[2] === 1 && ends[1] > ends[0] - 1e-9, 'the shadow ends: dark at 300 m, lit by 900 m (' + ends.map((v) => v.toFixed(2)).join(' ') + ')');
  // The penumbra: right at the shadow's far edge the Sun is half covered.
  let edge = 1, any = false;
  for (let x = 260; x < 600; x += 1) { const v = vis(x, 0, 15 * deg, -Math.PI / 2); if (v > 0.02 && v < 0.98) { any = true; edge = v; break; } }
  check(any, 'there is a penumbra at the edge of the shadow (' + edge.toFixed(2) + ')');
  const pos = new Float32Array([300, 0, 0, 1000, 0, 0, -100, 0, 0]), shade = new Float32Array(3);
  const job = T('_aeShadeJob')(grids, pos, 3, [-Math.cos(10 * deg), 0, Math.sin(10 * deg)], 0.0047, shade);
  while (!job.step(1)) { /* slices */ }
  check(shade[0] < 0.05 && shade[1] > 0.9 && shade[2] === 1, 'a job shades each vertex: ' + Array.from(shade).map((v) => v.toFixed(2)).join(' '));
  // Real terrain: the shadow of the Moon's relief with the Sun low is there for some vertex and not for others.
  const lat = 20.19, lon = 30.77, h0 = T('_aeTerrainHeight("moon", ' + lat + ', ' + lon + ', 0).h');
  ctx.__h0 = h0;
  const g2 = T('_aeShadeGrids')((x, y, cell) => T('_aeTerrainLocal("moon", ' + lat + ', ' + lon + ', __h0, ' + x + ', ' + y + ', ' + cell / 1000 * 1.5 + ')'));
  let n = 0;
  while (!g2.step(200) && n++ < 1000) { /* slices */ }
  ctx.__g2 = g2;
  let dark = 0, lit = 0;
  for (let i = 0; i < 400; i++) {
    const a = i * 2.399963, r = 30 + (i * 37.1) % 5000, x = r * Math.cos(a), y = r * Math.sin(a);
    const z = T('_aeTerrainLocal("moon", ' + lat + ', ' + lon + ', __h0, ' + x + ', ' + y + ', 0)');
    const v = T('_aeShadeVisible(__g2, ' + x + ', ' + y + ', ' + z + ', [0.9961, 0, 0.0872], 0.0047)');   // the Sun 5 degrees up in the east
    if (v < 0.5) dark++; else lit++;
  }
  check(dark > 5 && lit > 100, 'the Moon at Taurus-Littrow with the Sun 5 degrees up: some of the ground is in shadow, most is not (' + dark + ' of 400)');
}

// ── 4. The bodies ──
{
  const earthSrc = read('almanac-earth.js');
  const listed = JSON.parse(earthSrc.match(/var AE_STAND_KEYS = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
  const have = T('Object.keys(AE_STAND_BODIES)');
  check(listed.slice().sort().join() === have.slice().sort().join(), 'the 3D view offers exactly the bodies the terrain knows (' + have.join(', ') + ')');
  const gl = fs.readFileSync(path.join(STATIC, 'almanac-standgl.js'), 'utf8');
  const g = { Math };
  vm.createContext(g);
  // The constants almanac-earth.js owns and the atmospheres are built from.
  vm.runInContext(['AE_STAND_MARS_TAU', 'AE_STAND_HAZE_VIS_KM'].map((n) => earthSrc.match(new RegExp('var ' + n + ' = [^;]*;'))[0]).join('\n'), g);
  vm.runInContext(gl.replace(/var AE_ST_SKY_FRAG[\s\S]*?\n\];/, '').replace(/var AE_ST_GROUND_FRAG[\s\S]*?\n\];/, '').replace(/var AE_ST_BODY_FRAG[\s\S]*?\n\];/, ''), g);
  const atmos = vm.runInContext('AE_ST_ATMO', g);
  Object.keys(atmos).forEach((k) => check(!!have.includes(k), 'an atmosphere is for a body one can stand on: ' + k));
  // Mars's air: a thin gas, dust that lets blue pass along the Sun's own path.
  const zen = vm.runInContext('(function(){ var a = AE_ST_ATMO.mars; a.ray; return _aeStZenith(a, 3396.2, 0, 0.9); })()', Object.assign(g, {}));
  check(zen[0] > zen[2], 'Mars: the sky overhead is redder than blue (butterscotch): ' + zen.map((x) => x.toExponential(2)).join(' '));
  const od = vm.runInContext('_aeStOdUp(AE_ST_ATMO.mars, 3396.2, 0, 0.02)', g);
  check(od[2] < od[0], 'Mars: along a low Sun\'s path blue is the colour least lost (' + od.map((x) => x.toFixed(2)).join(' ') + ')');
  const earthZen = vm.runInContext('_aeStZenith(AE_ST_ATMO.earth, 6371, 0, 0.9)', g);
  check(earthZen[2] > earthZen[0], 'Earth: the sky overhead is blue');
  const earthOd = vm.runInContext('_aeStOdUp(AE_ST_ATMO.earth, 6371, 0, 0.02)', g);
  check(earthOd[0] < earthOd[2], 'Earth: a low Sun loses blue first (red survives)');
  check(vm.runInContext('_aeStOdUp(AE_ST_ATMO.earth, 6371, 0, -0.3)', g) === null, 'the planet is in the way of a Sun below the horizon');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
