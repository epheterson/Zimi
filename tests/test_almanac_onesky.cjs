// One sky (zimi/static/almanac-onesky.js): the definition, the photometry the card and Stand here share, the day's cloud field and the
// registry of what is in the sky. The pixels (card against ground, clouds, the objects) are tests/test_almanac_onesky_browser.py.
//
// Run: node tests/test_almanac_onesky.cjs   (exit 0 = pass)

const { makeSky, check, done } = require('./sky_harness.cjs');
const { S, run } = makeSky();
S.__nowMs = Date.parse('2026-09-11T23:45:00Z');

// ── The definition ──
const def = run('_osDef({ lat: 40.71, lon: -74, heading: -90, pitch: 120, tMs: __nowMs })');
check(def.body === 'earth' && def.heading === 270 && def.pitch === 90 && def.fov === 70 && def.heightM === 0, 'a definition names the Earth, wraps the heading, clamps the pitch, and defaults the rest');
check(run('_osDef({}).tMs') > 0 && run('_osDef({ lat: NaN }).lat') === 0, 'a definition with nothing in it is a place and an instant, not NaN');

// ── The photometry: the card's own numbers, once ──
const st = run('(function () { const d = _osDef({ lat: 40.71, lon: -74, tMs: __nowMs }); const a = _osSkyState(d), b = _osSkyState(d); return { same: a === b, sunGeoAlt: a.p.sunAltGeo, lm: a.lm, exposure: a.lv.exposure, sunLux: a.lv.sunLux, glow: a.lv.glow }; })()');
check(st.same, 'the state for one instant and place is worked out once');
check(st.sunGeoAlt > -8 && st.sunGeoAlt < 0 && st.sunLux > 0, 'New York at 23:45 UT in September: the Sun just set (' + st.sunGeoAlt.toFixed(1) + ' deg)');
const day = run('_osSkyState(_osDef({ lat: 40.71, lon: -74, tMs: Date.parse("2026-09-11T17:00:00Z") })).lv.exposure');
const night = run('_osSkyState(_osDef({ lat: 40.71, lon: -74, tMs: Date.parse("2026-09-12T05:00:00Z") })).lv.exposure');
check(night > 100 * day, 'the eye is set a hundred times more sensitive at night than by day (' + day.toExponential(1) + ' against ' + night.toExponential(1) + ')');

// ── An eclipse of the Sun ──
const ecl = (iso) => run('_osEclipse(_osDef({ lat: 30.0474, lon: -99.1403, tMs: Date.parse("' + iso + '") }))');
const tot = ecl('2024-04-08T18:34:50Z'), part = ecl('2024-04-08T17:45:00Z'), none = ecl('2024-04-08T14:00:00Z');
check(tot.obsc > 0.99 && tot.sunShare < 0.01 && tot.corona > 0.9, 'Kerrville at totality: the Moon covers the Sun (' + tot.obsc.toFixed(3) + '), the sky keeps ' + tot.sunShare.toFixed(3) + ' of its light, the corona is out');
check(part.obsc > 0.2 && part.obsc < 0.95 && part.corona === 0 && part.sunShare > 0.05, 'before it, a partial phase (' + part.obsc.toFixed(2) + ') has no corona');
check(none.obsc === 0 && none.sunShare === 1, 'hours before, none');
check(Math.abs(tot.sunSemiDeg - 0.2666) < 0.01 && tot.moonSemiDeg > 0.24 && tot.moonSemiDeg < 0.29, 'the discs are half a degree across (Sun ' + tot.sunSemiDeg + ', Moon ' + tot.moonSemiDeg.toFixed(3) + ' radius)');
const sep = Math.hypot((tot.sunAz - tot.moonAz) * Math.cos(tot.sunAlt * Math.PI / 180), tot.sunAlt - tot.moonAlt);
check(sep < 0.15, 'and the Moon is on the Sun (' + sep.toFixed(3) + ' deg)');

// ── Where a view faces, and the clouds a visit asks for ──
check(run('_osDefaultHeading(40)') === 180 && run('_osDefaultHeading(-33)') === 0 && run('_osDefaultHeading(0)') === 180, 'a view faces south in the north and north in the south, from one function');
check(run('_osHandoffFrom(_osDef({}), null).clouds') === 'auto' && run('_osHandoffFrom(_osDef({}), null, { clouds: "clear" }).clouds') === 'clear', 'a hand-off asks for the day\'s clouds unless it asks for a clear sky');
check(run('_osCloudValues(_osDef({ lat: 40, lon: -74, tMs: Date.now() }), 1, "clear").cloud[0]') === 0, 'a clear sky has no cover');

// ── The day's clouds ──
const field = (lat, lon, t) => run('_osCloudField(_osDef({ lat: ' + lat + ', lon: ' + lon + ', tMs: ' + t + ' }))');
const a = field(40.71, -74, Date.parse('2026-09-11T14:00:00Z')), b = field(40.71, -74, Date.parse('2026-09-11T20:00:00Z'));
check(JSON.stringify(a) === JSON.stringify(b), 'the same place on the same (solar) day has the same clouds all day');
const next = field(40.71, -74, Date.parse('2026-09-12T14:00:00Z'));
check(next.seed[0] !== a.seed[0], 'the next day has new ones');
check(field(51.5, -0.1, Date.parse('2026-09-11T14:00:00Z')).seed[0] !== a.seed[0], 'and another place has its own');
let n = 0, thin = 0, heavy = 0, sum = 0, fast = 0;
for (let d = 0; d < 2000; d++) {
  const f = field(40.71, -74, Date.parse('2026-01-01T12:00:00Z') + d * 86400000);
  n++; sum += f.coverage; if (f.coverage < 0.25) thin++; if (f.coverage > 0.75) heavy++;
  const speed = Math.hypot(f.wind[0], f.wind[1]);
  if (speed >= 4 && speed <= 16) fast++;
}
check(Math.abs(sum / n - 0.5) < 0.03 && Math.abs(thin / n - 0.25) < 0.04 && Math.abs(heavy / n - 0.25) < 0.04, 'cover is spread evenly from thin to heavy over 2,000 days (mean ' + (sum / n).toFixed(2) + ', thin ' + (thin / n).toFixed(2) + ', heavy ' + (heavy / n).toFixed(2) + ')');
check(fast === n, 'the wind is always between 4 and 16 m/s');
const cv = run('_osCloudValues(_osDef({ lat: 40.71, lon: -74, tMs: __nowMs }), 1)');
check(cv.cloud.length === 4 && cv.cloud[1] === 2500 && cv.wind.length === 3 && cv.wind[2] >= 0 && cv.wind[2] < 86400 && cv.sunE === 130000, 'the shaders take cover, base, thickness, offset, wind, the day\'s seconds and the Sun\'s lux');

// The field on the CPU (the Sun's veil): an integer hash, the same lattice on every machine; clear days veil nothing, heavy ones nearly everything.
const hashes = run('Array.from({ length: 2000 }, (_, i) => _osCloudHash(i - 1000, (i * 7) % 311 - 150))');
check(hashes.every((h) => h >= 0 && h <= 1) && new Set(hashes.map((h) => h.toFixed(6))).size > 1900, 'the lattice hash is in 0..1 and does not repeat');
check(run('_osCloudHash(3, -4)') === run('_osCloudHash(3, -4)') && run('_osCloudHash(3, -4)') !== run('_osCloudHash(-4, 3)'), 'and is the same for a point every time, and not symmetric');
const meanAlpha = (cover) => run('(function () { var v = { cloud: [' + cover + ', 2500, 700, 123], wind: [3, 4, 1000], sunE: 1 }, s = 0, n = 0; for (var az = 0; az < 360; az += 7) for (var alt = 15; alt < 90; alt += 5) { s += _osCloudAlphaAt(v, az, alt); n++; } return s / n; })()');
const a0 = meanAlpha(0), a5 = meanAlpha(0.5), a10 = meanAlpha(1);
check(a0 === 0 && a5 > 0.15 && a5 < 0.85 && a10 > 0.8 && a5 < a10, 'a clear day veils nothing (' + a0 + '), half cover about half (' + a5.toFixed(2) + '), a full one nearly all (' + a10.toFixed(2) + ')');
check(run('_osCloudAlphaAt({ cloud: [1, 2500, 700, 5], wind: [0, 0, 0], sunE: 1 }, 90, -5)') === 0, 'a Sun under the horizon is not behind a deck');

// ── The place's own night: the light-pollution dial's start ──
{
  const bin = require('fs').readFileSync(require('path').join(__dirname, '..', 'zimi', 'static', 'earth', 'nightlights-v1.bin'));
  S.__nl = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  run('_osNight = _osNightParse(__nl)');
  const dial = (la, lo) => run('_osNightDial(' + la + ', ' + lo + ')');
  check(bin.length < 12000 && run('!!_osNight && _osNight.w === 360 && _osNight.h === 180'), 'the night-lights grid is small (' + bin.length + ' bytes) and reads');
  check(dial(34.05, -118.25) > 0.7 && dial(1.35, 103.82) > 0.6 && dial(40.71, -74) > 0.8 && dial(35.7, 139.7) > 0.8, 'Los Angeles, Singapore, New York and Tokyo start at a bright dial (' + [dial(34.05, -118.25), dial(1.35, 103.82), dial(40.71, -74), dial(35.7, 139.7)].map((x) => x.toFixed(2)).join(', ') + ')');
  check(dial(30.05, -99.14) === 0 && dial(25, 10) === 0 && dial(0, -140) === 0 && dial(72, -40) === 0, 'a Texas hill country cell, the Sahara, the mid-Pacific and Greenland start at a dark site');
  check(run('_osNightParse(__nl.slice(0, 500))') === null && run('_osNightDial(NaN, 0)') === null, 'a truncated grid is refused and a place that is not a number has no dial');
  run('_osPlaceDial = 0.82; _skySettings = null;');
  check(run('_skySetting("dial")') === 0.82, 'the dial defaults to the place\'s own');
  run('_skyLoadSettings = function () { _skyChosen = { dial: 0.1 }; return { dial: 0.1, skin: "beach", lines: "off", size: "auto" }; }; _skySettings = null;');
  check(run('_skySetting("dial")') === 0.1, 'and the person\'s own choice wins');
}

// ── What is in the sky: one registry ──
run(`var __log = [], __seen = 0;
  var __offA = _osSkySource({ ask: function (la, lo, t) { __log.push('ask'); return Promise.resolve({ t: t }); }, at: function (a, t) { return [{ az: 10, el: 20, mag: 1, kind: 'sat', name: 'A' }]; } });
  var __offB = _osSkySource(function (body, la, lo, t) { return [{ az: 30, el: 40, mag: 2, kind: 'rocket', name: 'B' }]; });
  _osOnChange(function () { __seen++; });`);
check(run('_osObjects("mars", 0, 0, 0).length') === 0, 'another body has no satellites');
const first = run('_osObjects("earth", 40, -74, __nowMs).map(o => o.name)');
check(first.join() === 'B', 'a function source answers at once; a source with an ask has no answer yet (' + first.join() + ')');
run('_osObjects("earth", 40, -74, __nowMs)');
check(run('__log.length') === 1, 'it is asked once, never while its ask is pending');
(async () => {
  await new Promise((r) => setTimeout(r, 20));
  const both = run('_osObjects("earth", 40, -74, __nowMs).map(o => o.name)');
  check(both.join() === 'A,B', 'with its answer in, its objects come back with the others (' + both.join() + ')');
  check(run('__seen') >= 1, 'a window that asked to hear of answers is told');
  run('__offA(); __offB();');
  check(run('_osHasSources()') === false && run('_osObjects("earth", 40, -74, __nowMs).length') === 0, 'taken out, they are gone and cost nothing');
  // The hand-off the card gives Stand here.
  const h = run('_osHandoffFrom(_osDef({ lat: 1, lon: 2, tMs: 3, heading: 4, pitch: 5 }), function () {})');
  check(h.body === 'earth' && h.lat === 1 && h.lon === 2 && h.ms === 3 && h.heading === 4 && h.pitch === 5 && typeof h.back === 'function', 'the hand-off carries the place, the instant, the facing and the way back');
  done();
})();
