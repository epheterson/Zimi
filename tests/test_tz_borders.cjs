// Guards the real time zone asset the almanac sun map consumes
// (zimi/static/tz-borders.json, built by scripts/build-tz-borders.py) and the
// renderer's contract with it:
//
//   1. Size budget — the asset is lazy-fetched on first map draw and cached by
//      the service worker; it must stay a light touch (<= 250 KB, and in
//      practice ~100 KB raw / ~29 KB gzip).
//   2. Structure — {v: 2, source, lines, zones}. Every line is a flat,
//      even-length [lon, lat, ...] array of at least two points; every zone is
//      [offsetMinutes, [flat unclosed ring, ...]] with offsets on the
//      quarter-hour grid. The renderer indexes pairs blindly, so a ragged
//      array would skew every point after it.
//   3. Coordinates in range (lon -180..180, lat -90..90) — anything outside
//      projects off-canvas.
//   4. No segment spans > 180 deg of longitude — polylines are split at the
//      antimeridian in the build script, and zone rings (INCLUDING the closing
//      seam the client synthesizes) never cross it, so no stroke or fill ever
//      streaks across the whole map.
//   5. The data is REAL geometry, not the rejected nominal meridians: a
//      meaningful share of vertices sit off the 15-degree grid, and the point
//      count is far beyond what 24 straight lines need.
//   6. Containment semantics — the SHIPPED ray-cast resolves known cities to
//      their geographic zone (LA -> -8 even though its live DST offset is -7;
//      New Delhi -> +5:30; Urumqi -> +8, proving the one-zone China shape).
//   7. almanac.js actually consumes the asset; the nominal-meridian drawing
//      and the old offset-matched rectangular band are both gone.
//
// Run: node tests/test_tz_borders.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');

const ASSET = path.join(__dirname, '..', 'zimi', 'static', 'tz-borders.json');
const ALMANAC = path.join(__dirname, '..', 'zimi', 'static', 'almanac.js');
const MAX_BYTES = 250 * 1024;

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
check(doc.v === 2, 'version field v === 2');
check(typeof doc.source === 'string' && /Natural Earth/i.test(doc.source),
  'source attribution present');
check(Array.isArray(doc.lines) && doc.lines.length > 0, 'lines array present');
check(Array.isArray(doc.zones) && doc.zones.length > 100,
  `zones array present (${(doc.zones || []).length} zones)`);

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
check(outOfRange === 0, 'all line coordinates within lon -180..180, lat -90..90');

// 4. Antimeridian: no line segment spans more than 180 deg of longitude
check(wraps === 0, 'no line segment spans > 180 deg longitude (antimeridian split)');

// 5. Irregularity: real borders, not 24 clean meridians
check(pts > 2000, `line point count ${pts} > 2000 (real geometry, not 24 meridians)`);
check(offGrid / pts > 0.5,
  `${(100 * offGrid / pts).toFixed(0)}% of line vertices off the 15-deg grid (irregular borders)`);

// 2b. Zone structure: [offsetMinutes, [flat unclosed ring, ...]] — offsets on
// the quarter-hour grid, rings valid polygons whose closing seam (last point
// back to first, which the client synthesizes) also never crosses the
// antimeridian.
let zPts = 0, zBad = 0, zBadOff = 0, zOutOfRange = 0, zWraps = 0, zRings = 0;
const offsets = new Set();
for (const zone of doc.zones) {
  if (!Array.isArray(zone) || zone.length !== 2 ||
      !Number.isInteger(zone[0]) || !Array.isArray(zone[1]) || !zone[1].length) { zBad++; continue; }
  const [off, rings] = zone;
  if (off % 15 !== 0 || off < -720 || off > 840) zBadOff++;
  offsets.add(off);
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 6 || ring.length % 2 !== 0) { zBad++; continue; }
    zRings++;
    zPts += ring.length / 2;
    for (let j = 0; j < ring.length; j += 2) {
      const lon = ring[j], lat = ring[j + 1];
      if (typeof lon !== 'number' || typeof lat !== 'number' ||
          lon < -180 || lon > 180 || lat < -90 || lat > 90) zOutOfRange++;
      const prev = j >= 2 ? ring[j - 2] : ring[ring.length - 2]; // closing seam too
      if (Math.abs(lon - prev) > 180) zWraps++;
    }
  }
}
check(zBad === 0, 'every zone is [int offsetMinutes, rings of flat >= 3-point arrays]');
check(zBadOff === 0, 'all zone offsets on the quarter-hour grid within -12h..+14h');
check(zOutOfRange === 0, 'all zone coordinates within lon -180..180, lat -90..90');
check(zWraps === 0, 'no zone ring segment (incl. closing seam) spans > 180 deg longitude');
check(offsets.has(330) && offsets.has(345) && offsets.has(-570),
  'fractional zones survive (+5:30 India, +5:45 Nepal, -9:30 Marquesas)');

// 6. Containment — drive the SHIPPED ray cast and zone resolver (pulled out of
// almanac.js by source markers, same approach as the path-builder check below)
// against the real asset. LA proves the DST case: its August offset is -7, but
// the polygon containing it is the standard-time -8 shape — the whole reason
// the highlight is containment-based, not offset-matched.
const alm = fs.readFileSync(ALMANAC, 'utf8');
const vm = require('vm');
function extract(re, label) {
  const m = alm.match(re);
  if (!m) { console.error('  FAIL: could not extract ' + label); process.exit(1); }
  return m[0];
}
const zoneSrc =
  extract(/function _tzZoneContains\(rings, lon, lat\) \{[\s\S]*?\n\}/, '_tzZoneContains') + '\n' +
  extract(/function _tzZoneFor\(lat, lon\) \{[\s\S]*?\n\}/, '_tzZoneFor');
const zoneSandbox = {
  DEG_TO_RAD: Math.PI / 180,
  _tzZones: doc.zones, _tzZoneIdx: -2, _tzZoneKey: '',
  _tzZonePath: null, _tzZonePathKey: ''
};
vm.createContext(zoneSandbox);
vm.runInContext(zoneSrc, zoneSandbox);
function zoneOffsetAt(lat, lon) {
  const idx = vm.runInContext(`_tzZoneIdx = -2; _tzZoneFor(${lat}, ${lon})`, zoneSandbox);
  return idx < 0 ? null : doc.zones[idx][0];
}
check(zoneOffsetAt(34.05, -118.24) === -480,
  'Los Angeles (34.05,-118.24) -> UTC-8 zone (standard shape, not the DST -7 band)');
check(zoneOffsetAt(28.6, 77.2) === 330, 'New Delhi (28.6,77.2) -> UTC+5:30 zone');
check(zoneOffsetAt(43.8, 87.6) === 480,
  'Urumqi (43.8,87.6) -> UTC+8 zone (one-zone China shape reaches the far west)');
check(zoneOffsetAt(0, -150) === -600, 'mid-Pacific (0,-150) -> UTC-10 (ocean coverage, no fallback)');
check(zoneOffsetAt(-17, 179.9) === 720 && zoneOffsetAt(-17, -179.9) === 720,
  'both sides of the date line near Fiji -> UTC+12 (antimeridian parts)');

// 7. Renderer contract
check(alm.includes("fetch('/static/tz-borders.json?v=2')"), 'almanac.js lazy-fetches the v2 asset');
check(alm.includes('_tzBordersPathFor'), 'almanac.js builds the cached border Path2D');
check(alm.includes('_tzZonePathFor'), 'almanac.js builds the cached highlight Path2D');
check(alm.includes('_sunMapDrawZoneHighlight'), 'almanac.js draws the true-shape highlight');
check(!alm.includes('_sunMapDrawMeridians'), 'nominal meridian draw code removed');
check(!alm.includes('_sunMapDrawZoneBand'), 'offset-matched rectangular band code removed');

// 8. Drive the SHIPPED path builders against the real asset with a recording
// Path2D stub: every projected point must land inside the canvas, and every
// polyline/ring must start with its own moveTo (rings also closePath).
const recorded = { moves: 0, closes: 0, points: [] };
class Path2DStub {
  moveTo(x, y) { recorded.moves++; recorded.points.push([x, y]); }
  lineTo(x, y) { recorded.points.push([x, y]); }
  closePath() { recorded.closes++; }
}
const pathSrc =
  extract(/function _sunMapLonToX[^\n]*/, '_sunMapLonToX') + '\n' +
  extract(/function _sunMapLatToY[^\n]*/, '_sunMapLatToY') + '\n' +
  extract(/function _tzBordersPathFor\(W, H\) \{[\s\S]*?\n\}/, '_tzBordersPathFor') + '\n' +
  extract(/function _tzZonePathFor\(idx, W, H\) \{[\s\S]*?\n\}/, '_tzZonePathFor');
const sandbox = {
  Path2D: Path2DStub,
  _tzBorders: doc.lines, _tzBordersPath: null, _tzBordersPathKey: '',
  _tzZones: doc.zones, _tzZonePath: null, _tzZonePathKey: ''
};
vm.createContext(sandbox);
vm.runInContext(pathSrc + '\n_tzBordersPathFor(800, 400);', sandbox);
const W = 800, H = 400;
let offCanvas = recorded.points.filter(([x, y]) =>
  !(x >= 0 && x <= W && y >= 0 && y <= H)).length;
check(recorded.moves === doc.lines.length,
  `border path builder emits one moveTo per polyline (${recorded.moves})`);
check(recorded.points.length === pts,
  `border path builder projects every point (${recorded.points.length})`);
check(offCanvas === 0, 'all projected border points land inside the canvas');

// Same stub through the highlight builder for every zone.
recorded.moves = 0; recorded.closes = 0; recorded.points = [];
vm.runInContext(
  'for (var zi = 0; zi < _tzZones.length; zi++) { _tzZonePath = null; _tzZonePathKey = ""; _tzZonePathFor(zi, 800, 400); }',
  sandbox);
offCanvas = recorded.points.filter(([x, y]) =>
  !(x >= 0 && x <= W && y >= 0 && y <= H)).length;
check(recorded.moves === zRings && recorded.closes === zRings,
  `zone path builder emits one moveTo + closePath per ring (${recorded.moves})`);
check(recorded.points.length === zPts,
  `zone path builder projects every point (${recorded.points.length})`);
check(offCanvas === 0, 'all projected zone points land inside the canvas');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all tz-borders checks passed (' + doc.lines.length + ' lines, ' + pts +
  ' pts; ' + doc.zones.length + ' zones, ' + zPts + ' pts)');
