// Guards the real time zone boundary asset the almanac sun map strokes
// (zimi/static/tz-borders.json, built by scripts/build-tz-borders.py) and the
// renderer's contract with it:
//
//   1. Size budget — the asset is lazy-fetched on first map draw and cached by
//      the service worker; it must stay a light touch (<= 400 KB, and in
//      practice ~45 KB).
//   2. Structure — {v, source, lines} with every line a flat, even-length
//      [lon, lat, lon, lat, ...] array of at least two points. The renderer
//      indexes pairs blindly, so a ragged line would skew every point after it.
//   3. Coordinates in range (lon -180..180, lat -90..90) — anything outside
//      projects off-canvas.
//   4. No segment spans > 180 deg of longitude — the build script splits
//      polylines at the antimeridian precisely so the canvas stroke never
//      draws a horizontal streak across the whole map.
//   5. The data is REAL border geometry, not the rejected nominal meridians:
//      a meaningful share of vertices sit off the 15-degree grid, and the
//      point count is far beyond what 24 straight lines need.
//   6. almanac.js actually consumes the asset and the nominal-meridian
//      drawing code is gone.
//
// Run: node tests/test_tz_borders.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');

const ASSET = path.join(__dirname, '..', 'zimi', 'static', 'tz-borders.json');
const ALMANAC = path.join(__dirname, '..', 'zimi', 'static', 'almanac.js');
const MAX_BYTES = 400 * 1024;

let failures = 0;
function check(cond, label) {
  if (cond) console.log('  ok: ' + label);
  else { console.error('  FAIL: ' + label); failures++; }
}

// 1. Size budget
const stat = fs.statSync(ASSET);
check(stat.size <= MAX_BYTES, `size ${stat.size} bytes <= ${MAX_BYTES} budget`);

// 2. Structure
const doc = JSON.parse(fs.readFileSync(ASSET, 'utf8'));
check(doc.v === 1, 'version field v === 1');
check(typeof doc.source === 'string' && /Natural Earth/i.test(doc.source),
  'source attribution present');
check(Array.isArray(doc.lines) && doc.lines.length > 0, 'lines array present');

let pts = 0, ragged = 0, outOfRange = 0, wraps = 0, offGrid = 0;
for (const line of doc.lines) {
  if (!Array.isArray(line) || line.length < 4 || line.length % 2 !== 0) { ragged++; continue; }
  pts += line.length / 2;
  for (let j = 0; j < line.length; j += 2) {
    const lon = line[j], lat = line[j + 1];
    if (typeof lon !== 'number' || typeof lat !== 'number' ||
        lon < -180 || lon > 180 || lat < -90 || lat > 90) outOfRange++;
    if (Math.abs(lon / 15 - Math.round(lon / 15)) > 1e-9) offGrid++;
    if (j >= 2 && Math.abs(lon - line[j - 2]) > 180) wraps++;
  }
}
check(ragged === 0, 'every line is a flat even-length array of >= 2 points');
check(outOfRange === 0, 'all coordinates within lon -180..180, lat -90..90');

// 4. Antimeridian: no segment spans more than 180 deg of longitude
check(wraps === 0, 'no segment spans > 180 deg longitude (antimeridian split)');

// 5. Irregularity: real borders, not 24 clean meridians
check(pts > 2000, `point count ${pts} > 2000 (real geometry, not 24 meridians)`);
check(offGrid / pts > 0.5,
  `${(100 * offGrid / pts).toFixed(0)}% of vertices off the 15-deg grid (irregular borders)`);

// 6. Renderer contract
const alm = fs.readFileSync(ALMANAC, 'utf8');
check(alm.includes("fetch('/static/tz-borders.json?v=1')"), 'almanac.js lazy-fetches the asset');
check(alm.includes('_tzBordersPathFor'), 'almanac.js builds the cached Path2D');
check(!alm.includes('_sunMapDrawMeridians'), 'nominal meridian draw code removed');

// 7. Drive the SHIPPED path builder (pulled out of almanac.js by source
// markers, same approach as test_almanac_tz_resolution.cjs) against the real
// asset with a recording Path2D stub: every projected point must land inside
// the canvas, and every polyline must start with its own moveTo.
const vm = require('vm');
function extract(re, label) {
  const m = alm.match(re);
  if (!m) { console.error('  FAIL: could not extract ' + label); process.exit(1); }
  return m[0];
}
const src =
  extract(/function _sunMapLonToX[^\n]*/, '_sunMapLonToX') + '\n' +
  extract(/function _sunMapLatToY[^\n]*/, '_sunMapLatToY') + '\n' +
  extract(/function _tzBordersPathFor\(W, H\) \{[\s\S]*?\n\}/, '_tzBordersPathFor');
const recorded = { moves: 0, points: [] };
class Path2DStub {
  moveTo(x, y) { recorded.moves++; recorded.points.push([x, y]); }
  lineTo(x, y) { recorded.points.push([x, y]); }
}
const sandbox = {
  Path2D: Path2DStub,
  _tzBorders: doc.lines, _tzBordersPath: null, _tzBordersPathKey: ''
};
vm.createContext(sandbox);
vm.runInContext(src + '\n_tzBordersPathFor(800, 400);', sandbox);
const W = 800, H = 400;
const offCanvas = recorded.points.filter(([x, y]) =>
  !(x >= 0 && x <= W && y >= 0 && y <= H)).length;
check(recorded.moves === doc.lines.length,
  `path builder emits one moveTo per polyline (${recorded.moves})`);
check(recorded.points.length === pts,
  `path builder projects every point (${recorded.points.length})`);
check(offCanvas === 0, 'all projected points land inside the canvas');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all tz-borders checks passed (' + doc.lines.length + ' lines, ' + pts + ' points)');
