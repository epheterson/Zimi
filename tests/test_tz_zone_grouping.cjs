// A time zone is its OFFSET, not one polygon part.
//
// zimi/static/tz-borders.json stores 117 entries over only 40 distinct offsets:
// the build dissolved Natural Earth by offset and then emitted one entry per
// polygon PART, so a single civil zone is spread across several entries —
// India's +5:30 is three (mainland, Lakshadweep, the Andamans), +6 is seven.
//
// The sun map used to resolve a pick to the ONE entry containing it and light
// only that entry, which meant clicking Delhi lit the Indian mainland and left
// Port Blair and Kavaratti — same country, same clock, own dots on the map —
// sitting outside the lit shape. This test guards the fix and the two data
// facts the fix leans on.
//
// What is asserted:
//
//   1. Grouping — _tzGroupByOffset partitions all 117 entries into exactly 40
//      offset groups, losing and duplicating nothing.
//   2. Multi-part lighting — a pick inside ONE India polygon builds a highlight
//      covering all three +5:30 entries, and the other two India dots land
//      inside it. Same for a multi-part zone on the other side of the world.
//   3. Fill rule — the shipped highlight fills NONZERO, and the data justifies
//      it: same-offset entries genuinely OVERLAP (the Antarctic wedges), which
//      even-odd would punch into holes, while every enclave hole ring winds
//      AGAINST its outer ring, which is what makes nonzero still cut holes.
//   4. City dots — every _MAP_CITIES dot resolves through the shipped scan into
//      a real polygon (no dot adrift in a geometry gap), and the offset it
//      resolves to matches its true IANA zone's standard offset, except for a
//      commented list of places where the SHIPPED ASSET is politically stale
//      or Antarctica's nominal wedges deliberately disagree with the station
//      clock.
//
// Same vm-extraction approach as tests/test_tz_borders.cjs: the shipped
// functions are pulled out of almanac.js by source markers and run against the
// real asset, so this drives production code, not a copy.
//
// Run: node tests/test_tz_zone_grouping.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ASSET = path.join(__dirname, '..', 'zimi', 'static', 'tz-borders.json');
const ALMANAC = path.join(__dirname, '..', 'zimi', 'static', 'almanac.js');

const doc = JSON.parse(fs.readFileSync(ASSET, 'utf8'));
const alm = fs.readFileSync(ALMANAC, 'utf8');

let failures = 0;
function check(cond, label) {
  if (cond) console.log('  ok: ' + label);
  else { console.error('  FAIL: ' + label); failures++; }
}
function extract(re, label) {
  const m = alm.match(re);
  if (!m) { console.error('  FAIL: could not extract ' + label); process.exit(1); }
  return m[0];
}
const fmtOff = (o) => o === null ? '(none)' : 'UTC' + (o < 0 ? '-' : '+') +
  Math.floor(Math.abs(o) / 60) +
  (Math.abs(o) % 60 ? ':' + String(Math.abs(o) % 60).padStart(2, '0') : '');

// ── the shipped code under test ────────────────────────────────────────────
class Path2DStub {
  constructor() { this.subpaths = []; this.cur = null; }
  moveTo(x, y) { this.cur = [[x, y]]; this.subpaths.push(this.cur); }
  lineTo(x, y) { this.cur.push([x, y]); }
  closePath() { }
}
const sandbox = {
  Path2D: Path2DStub,
  DEG_TO_RAD: Math.PI / 180,
  _tzZones: doc.zones, _tzZonesByOffset: null,
  _tzZoneOff: null, _tzZoneKey: '',
  _tzZonePath: null, _tzZonePathKey: ''
};
vm.createContext(sandbox);
vm.runInContext(
  extract(/function _sunMapLonToX[^\n]*/, '_sunMapLonToX') + '\n' +
  extract(/function _sunMapLatToY[^\n]*/, '_sunMapLatToY') + '\n' +
  extract(/function _tzZoneContains\(rings, lon, lat\) \{[\s\S]*?\n\}/, '_tzZoneContains') + '\n' +
  extract(/function _tzGroupByOffset\(zones\) \{[\s\S]*?\n\}/, '_tzGroupByOffset') + '\n' +
  extract(/function _tzZoneOffsetFor\(lat, lon\) \{[\s\S]*?\n\}/, '_tzZoneOffsetFor') + '\n' +
  extract(/function _tzZonePathFor\(off, W, H\) \{[\s\S]*?\n\}/, '_tzZonePathFor') + '\n' +
  extract(/var _MAP_CITIES = \[[\s\S]*?\n\];/, '_MAP_CITIES') + '\n' +
  '_tzZonesByOffset = _tzGroupByOffset(_tzZones);',
  sandbox);

const byOffset = sandbox._tzZonesByOffset;
const cities = sandbox._MAP_CITIES;
const contains = sandbox._tzZoneContains;
function offsetAt(lat, lon) {
  return vm.runInContext(`_tzZoneKey = ''; _tzZoneOffsetFor(${lat}, ${lon})`, sandbox);
}
function pathFor(off, W, H) {
  return vm.runInContext(`_tzZonePath = null; _tzZonePathKey = ''; _tzZonePathFor(${off}, ${W}, ${H})`, sandbox);
}

// ── 1. Grouping is a partition ─────────────────────────────────────────────
const offKeys = Object.keys(byOffset);
const grouped = offKeys.reduce((n, k) => n + byOffset[k].length, 0);
check(offKeys.length === 40, `grouping yields 40 distinct offsets (${offKeys.length})`);
check(grouped === doc.zones.length && doc.zones.length === 117,
  `grouping totals ${grouped} entries across ${offKeys.length} offsets (asset has ${doc.zones.length})`);
const seenEntries = new Set();
let dupes = 0, misfiled = 0;
for (const k of offKeys) {
  for (const entry of byOffset[k]) {
    if (seenEntries.has(entry)) dupes++;
    seenEntries.add(entry);
    if (entry[0] !== Number(k)) misfiled++;
  }
}
check(dupes === 0 && misfiled === 0 && seenEntries.size === doc.zones.length,
  'every entry lands in exactly one group, under its own offset');
check(byOffset[330].length === 3 && byOffset[360].length === 7,
  `the split zones group: +5:30 has ${byOffset[330].length} entries, +6 has ${byOffset[360].length}`);

// ── 2. A pick in one part lights every part ────────────────────────────────
// Point-in-path over the recorded subpaths, nonzero winding — the rule the
// shipped highlight fills with.
function windingAt(path, px, py) {
  let w = 0;
  for (const sp of path.subpaths) {
    for (let i = 0, j = sp.length - 1; i < sp.length; j = i, i++) {
      const [xi, yi] = sp[i], [xj, yj] = sp[j];
      if (yi <= py) {
        if (yj > py && (xj - xi) * (py - yi) - (px - xi) * (yj - yi) > 0) w++;
      } else if (yj <= py && (xj - xi) * (py - yi) - (px - xi) * (yj - yi) < 0) w--;
    }
  }
  return w;
}
const W = 800, H = 400;
const proj = (lat, lon) => [
  vm.runInContext(`_sunMapLonToX(${lon}, ${W})`, sandbox),
  vm.runInContext(`_sunMapLatToY(${lat}, ${H})`, sandbox)
];
function litAt(path, lat, lon) {
  const [x, y] = proj(lat, lon);
  return windingAt(path, x, y) !== 0;
}

// India: the pick is Delhi, on the mainland entry. Kavaratti (Lakshadweep) and
// Port Blair (Andamans) are separate +5:30 entries with their own map dots —
// the exact "carved out" complaint.
const DELHI = [28.61, 77.21], KAVARATTI = [10.57, 72.64], PORT_BLAIR = [11.62, 92.73];
const indiaOff = offsetAt(DELHI[0], DELHI[1]);
check(indiaOff === 330, `Delhi resolves to ${fmtOff(indiaOff)}`);
const indiaPath = pathFor(indiaOff, W, H);
check(indiaPath.subpaths.length === byOffset[330].reduce((n, e) => n + e[1].length, 0),
  `+5:30 highlight path holds every ring of all 3 entries (${indiaPath.subpaths.length} subpaths)`);
check(litAt(indiaPath, DELHI[0], DELHI[1]), 'Delhi is inside the +5:30 highlight');
check(litAt(indiaPath, KAVARATTI[0], KAVARATTI[1]),
  'Kavaratti (Lakshadweep, a separate +5:30 entry) lights with it');
check(litAt(indiaPath, PORT_BLAIR[0], PORT_BLAIR[1]),
  'Port Blair (Andamans, a third +5:30 entry) lights with it');
// Each of the three entries contributes lit area, so this is a union, not one
// part that happens to cover the others.
let indiaPartsLit = 0;
for (const entry of byOffset[330]) {
  const ring = entry[1][0];
  // a vertex-adjacent interior probe: the ring centroid is inside for these
  // simple parts, and the whole-group path must light it.
  let cx = 0, cy = 0, n = ring.length / 2;
  for (let j = 0; j < ring.length; j += 2) { cx += ring[j]; cy += ring[j + 1]; }
  cx /= n; cy /= n;
  if (contains(entry[1], cx, cy) && litAt(indiaPath, cy, cx)) indiaPartsLit++;
}
check(indiaPartsLit === 3, `all 3 +5:30 parts contribute lit area (${indiaPartsLit})`);

// A multi-part zone on the other side of the world: +8 is China+SE Asia and an
// Antarctic wedge. Perth and Beijing are in the same entry; Casey Station is in
// the other. One pick must light both.
const plus8 = offsetAt(39.9, 116.4);
check(plus8 === 480, `Beijing resolves to ${fmtOff(plus8)}`);
const p8 = pathFor(plus8, W, H);
check(litAt(p8, 39.9, 116.4) && litAt(p8, -31.95, 115.86) && litAt(p8, 1.35, 103.82),
  'Beijing, Perth and Singapore all light on one +8 pick');
check(litAt(p8, -66.28, 110.53),
  'Casey Station (the other +8 entry, an Antarctic wedge) lights with them');

// Antarctica: a station pick lights every polygon at that offset worldwide,
// which is the honest reading — McMurdo keeps New Zealand time, so New Zealand
// lighting up IS the fact, not a bug.
const mcmurdoOff = offsetAt(-77.85, 166.67);
check(mcmurdoOff === 720, `McMurdo resolves to ${fmtOff(mcmurdoOff)}`);
const p12 = pathFor(mcmurdoOff, W, H);
check(litAt(p12, -77.85, 166.67) && litAt(p12, -36.85, 174.76) && litAt(p12, -17.77, 177.97),
  'McMurdo, Auckland and Suva all light on one +12 pick (McMurdo keeps NZ time)');

// Reverse guard: an unrelated zone must NOT light.
check(!litAt(indiaPath, 40.71, -74.01) && !litAt(p8, 51.51, -0.13),
  'unrelated places stay dark (New York off the +5:30 path, London off the +8 path)');

// ── 3. Fill rule ───────────────────────────────────────────────────────────
check(/c\.fill\(p\);/.test(alm) && !/c\.fill\(p, 'evenodd'\)/.test(alm),
  "highlight fills nonzero (c.fill(p)), not even-odd");

// 3a. Same-offset entries really do overlap — the reason even-odd is wrong.
function bbox(rings) {
  let b = [999, 999, -999, -999];
  for (const r of rings) for (let j = 0; j < r.length; j += 2) {
    b[0] = Math.min(b[0], r[j]); b[1] = Math.min(b[1], r[j + 1]);
    b[2] = Math.max(b[2], r[j]); b[3] = Math.max(b[3], r[j + 1]);
  }
  return b;
}
let overlapPairs = 0, overlapMinLat = 90;   // becomes the northernmost overlapping POINT
for (const k of offKeys) {
  const g = byOffset[k];
  for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) {
    const A = bbox(g[a][1]), B = bbox(g[b][1]);
    if (A[0] > B[2] || B[0] > A[2] || A[1] > B[3] || B[1] > A[3]) continue;
    const x0 = Math.max(A[0], B[0]), x1 = Math.min(A[2], B[2]);
    const y0 = Math.max(A[1], B[1]), y1 = Math.min(A[3], B[3]);
    let hit = false, topLat = -90;
    for (let i = 0; i <= 60; i++) for (let j = 0; j <= 60; j++) {
      const lon = x0 + (x1 - x0) * i / 60, lat = y0 + (y1 - y0) * j / 60;
      if (contains(g[a][1], lon, lat) && contains(g[b][1], lon, lat)) {
        hit = true;
        topLat = Math.max(topLat, lat);   // where the overlap actually IS
      }
    }
    if (hit) { overlapPairs++; overlapMinLat = Math.max(overlapMinLat === 90 ? -90 : overlapMinLat, topLat); }
  }
}
check(overlapPairs > 0,
  `same-offset entries overlap (${overlapPairs} pairs) — even-odd would punch these into holes`);
check(overlapMinLat < -60,
  `every overlap is Antarctic — northernmost overlapping POINT is at ${overlapMinLat.toFixed(1)} lat, ` +
  'so no populated place is at risk of being punched out');

// 3b. Enclave holes wind against their outer ring, which is what lets nonzero
// keep cutting them. If a regenerated asset ever normalised all rings to one
// winding direction, nonzero would fill the enclaves solid and this fails.
function signedArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1];
  return a / 2;
}
let holes = 0, badWinding = 0;
for (const zone of doc.zones) {
  const rings = zone[1];
  if (rings.length < 2) continue;
  const outer = rings[0];
  if (Math.abs(signedArea(outer)) < 1e-9) continue;   // degenerate first part
  for (let r = 1; r < rings.length; r++) {
    if (!contains([outer], rings[r][0], rings[r][1])) continue;  // separate part, not a hole
    holes++;
    if (Math.sign(signedArea(rings[r])) === Math.sign(signedArea(outer))) badWinding++;
  }
}
check(holes > 0, `asset contains ${holes} enclave hole rings`);
check(badWinding === 0, 'every hole ring winds against its outer ring (nonzero still cuts holes)');

// A hole stays a hole through the shipped path builder: entry 51 (+6,
// Bangladesh) carries an enclave, and its interior must NOT light.
const holeEntry = byOffset[360].find((e) => e[1].length > 1);
if (holeEntry) {
  const hole = holeEntry[1][1];
  let hx = 0, hy = 0, hn = hole.length / 2;
  for (let j = 0; j < hole.length; j += 2) { hx += hole[j]; hy += hole[j + 1]; }
  hx /= hn; hy /= hn;
  const p6 = pathFor(360, W, H);
  check(!litAt(p6, hy, hx),
    `the +6 enclave hole near (${hy.toFixed(1)}, ${hx.toFixed(1)}) stays unlit under nonzero`);
}

// ── 4. City dots ───────────────────────────────────────────────────────────
check(Array.isArray(cities) && cities.length >= 170, `_MAP_CITIES extracted (${cities.length} dots)`);

// Every dot must sit inside a real polygon — resolving only via the
// nearest-vertex sliver fallback would mean the dot is adrift in a geometry gap.
let adrift = [];
for (const c of cities) {
  if (!doc.zones.some((z) => contains(z[1], c.lon, c.lat))) adrift.push(c.name);
}
check(adrift.length === 0,
  `every city dot is CONTAINED by a polygon, none needs the sliver fallback` +
  (adrift.length ? ' (adrift: ' + adrift.join(', ') + ')' : ''));

// And every dot must light when its own zone is picked. This is the property
// Eric reported broken: a lit city outside a lit shape.
let unlit = [];
for (const c of cities) {
  const off = offsetAt(c.lat, c.lon);
  const p = pathFor(off, W, H);
  if (!litAt(p, c.lat, c.lon)) unlit.push(`${c.name} (${fmtOff(off)})`);
}
check(unlit.length === 0,
  'every city dot lands inside the highlight its own pick draws' +
  (unlit.length ? ' (outside: ' + unlit.join(' | ') + ')' : ''));

// The polygon a dot sits in should carry that place's true STANDARD offset.
// Standard = min(January, July): DST always moves a zone away from zero-side,
// north and south alike (New York -5/-4, Sydney +11/+10, Lord Howe +11/+10:30).
const JAN = new Date(Date.UTC(2026, 0, 15, 12));
const JUL = new Date(Date.UTC(2026, 6, 15, 12));
function tzOffsetMin(tz, d) {
  const o = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false };
  const f = (z) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: z }, o)).format(d);
  return Math.round((new Date(f(tz)) - new Date(f('UTC'))) / 60000);
}
const stdOffset = (tz) => Math.min(tzOffsetMin(tz, JAN), tzOffsetMin(tz, JUL));

// The exceptions, each with its reason. NONE of these is fixable in
// _MAP_CITIES — the dots' coordinates are right; the SHIPPED ASSET's polygons
// carry offsets that are either politically stale (Natural Earth's 10m Time
// Zones is a 2010s snapshot) or, in Antarctica, deliberately nominal. Fixing
// them means regenerating tz-borders.json, not editing the city list.
//
// [name prefix, true IANA zone, polygon offset, why]
const STALE_ASSET = [
  ['Moscow', 'Europe/Moscow', 240, 'asset predates Russia dropping permanent DST in 2014 (+4 -> +3)'],
  ['St. Petersburg', 'Europe/Moscow', 240, 'same 2014 Russian change'],
  ['Kaliningrad', 'Europe/Kaliningrad', 180, 'same 2014 Russian change (+3 -> +2)'],
  ['Irkutsk', 'Asia/Irkutsk', 540, 'same 2014 Russian change (+9 -> +8)'],
  ['Yakutsk', 'Asia/Yakutsk', 600, 'same 2014 Russian change (+10 -> +9)'],
  ['Vladivostok', 'Asia/Vladivostok', 660, 'same 2014 Russian change (+11 -> +10)'],
  ['Verkhoyansk', 'Asia/Vladivostok', 660, 'same 2014 Russian change'],
  ['Istanbul', 'Europe/Istanbul', 120, 'asset predates Turkey going permanent +3 in 2016'],
  ['Casablanca', 'Africa/Casablanca', 0, 'asset predates Morocco going permanent +1 in 2018'],
  ['Caracas', 'America/Caracas', -270, 'asset predates Venezuela returning to -4 in 2016'],
  ['Kingston, Norfolk', 'Pacific/Norfolk', 690, 'asset predates Norfolk Island moving to +11 in 2015'],
  ['Almaty', 'Asia/Almaty', 360, 'asset predates Kazakhstan unifying on +5 in 2024'],
  ['Ittoqqortoormiit', 'America/Scoresbysund', -60, 'asset predates Greenland moving Scoresbysund to -2 in 2024'],
  // Antarctica has no native time zones: Natural Earth fills it with nominal
  // hour-wide longitude wedges, while each station keeps its supply country's
  // clock. A wedge disagreeing with the station is CORRECT DATA on both sides.
  ['Vostok', 'Antarctica/Vostok', 360, 'Antarctic nominal wedge; Vostok keeps +5 (Russian resupply)'],
  ['Palmer', 'Antarctica/Palmer', -240, 'Antarctic nominal wedge; Palmer keeps -3 (Chilean resupply)'],
];
const exceptionFor = (name) => STALE_ASSET.find((e) => name.indexOf(e[0]) === 0);

let matched = 0, unexplained = [], staleConfirmed = 0, staleDrifted = [];
for (const c of cities) {
  const off = offsetAt(c.lat, c.lon);
  const ex = exceptionFor(c.name);
  if (!ex) {
    // No exception claimed: the polygon must agree with the shipped anchor
    // resolver's answer for this dot, which tests/test_almanac_tz_resolution.cjs
    // separately proves is the true zone.
    matched++;
    continue;
  }
  if (off === ex[2] && stdOffset(ex[1]) !== ex[2]) staleConfirmed++;
  else staleDrifted.push(`${c.name}: polygon ${fmtOff(off)}, expected exception ${fmtOff(ex[2])}, true ${fmtOff(stdOffset(ex[1]))}`);
}
check(staleDrifted.length === 0,
  `all ${staleConfirmed} documented asset/reality disagreements still read exactly as documented` +
  (staleDrifted.length ? ' (drifted: ' + staleDrifted.join(' | ') + ')' : ''));

// The unexceptional dots: polygon offset must equal the true zone's standard
// offset. The true zone comes from the shipped anchor resolver, which
// tests/test_almanac_tz_resolution.cjs gates against real IANA zones.
vm.runInContext(
  extract(/var _TZ_ANCHORS = \[[\s\S]*?\n\];/, '_TZ_ANCHORS') + '\n' +
  extract(/function _almTzForLocation\(lat, lon\)\s*\{[\s\S]*?\n\}/, '_almTzForLocation'),
  sandbox);
const tzFor = sandbox._almTzForLocation;
for (const c of cities) {
  if (exceptionFor(c.name)) continue;
  const off = offsetAt(c.lat, c.lon);
  const std = stdOffset(tzFor(c.lat, c.lon));
  if (off !== std) unexplained.push(`${c.name} (${c.lat},${c.lon}): polygon ${fmtOff(off)} vs zone standard ${fmtOff(std)}`);
}
check(unexplained.length === 0,
  `every unexcepted city dot sits in a polygon carrying its zone's standard offset (${cities.length - STALE_ASSET.length} dots)` +
  (unexplained.length ? '\n    ' + unexplained.join('\n    ') : ''));

// ── 5. Antarctica, factually ───────────────────────────────────────────────
// Reported because Eric asked directly: is Antarctica one zone or many here?
const antarcticOffsets = new Set();
let antarcticEntries = 0;
for (const z of doc.zones) {
  const b = bbox(z[1]);
  if (b[3] <= -60) { antarcticEntries++; antarcticOffsets.add(z[0]); }
}
check(antarcticOffsets.size > 1,
  `Antarctica is MANY zones in this asset: ${antarcticEntries} entries spanning ` +
  `${antarcticOffsets.size} offsets (nominal hour-wide longitude wedges, not civil zones)`);
const STATIONS = [
  ['McMurdo', -77.85, 166.67, 'Antarctica/McMurdo'],
  ['Troll', -72.01, 2.53, 'Antarctica/Troll'],
  ['Syowa', -69.00, 39.58, 'Antarctica/Syowa'],
  ['Mawson', -67.60, 62.87, 'Antarctica/Mawson'],
  ['Davis', -68.60, 78.20, 'Antarctica/Davis'],
  ['Vostok', -78.46, 106.84, 'Antarctica/Vostok'],
  ['Casey', -66.28, 110.53, 'Antarctica/Casey'],
  ['Dumont d', -66.66, 140.00, 'Antarctica/DumontDUrville'],
  ['Rothera', -67.57, -68.13, 'Antarctica/Rothera'],
  ['Palmer', -64.77, -64.05, 'Antarctica/Palmer'],
];
let wedgeAgrees = 0, wedgeDiffers = [];
for (const [name, lat, lon, tz] of STATIONS) {
  const off = offsetAt(lat, lon);
  const std = stdOffset(tz);
  if (off === std) wedgeAgrees++;
  else wedgeDiffers.push(`${name} station ${fmtOff(std)} in ${fmtOff(off)} wedge`);
  // whichever it is, the station dot must light with its wedge
  check(litAt(pathFor(off, W, H), lat, lon), `${name} Station lights inside its own pick`);
}
console.log(`  note: ${wedgeAgrees}/10 Antarctic stations keep the clock of the wedge they stand in; ` +
  `differing: ${wedgeDiffers.join(', ') || 'none'}`);

if (failures) { console.error('\n' + failures + ' failure(s)'); process.exit(1); }
console.log(`\nall zone-grouping checks passed (${doc.zones.length} entries -> ${offKeys.length} offsets, ` +
  `${cities.length} city dots, ${overlapPairs} same-offset overlaps, ${holes} enclave holes)`);
