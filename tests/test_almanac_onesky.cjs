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

// ── The day's clouds ──
const field = (lat, lon, t) => run('_osCloudField(_osDef({ lat: ' + lat + ', lon: ' + lon + ', tMs: ' + t + ' }))');
const a = field(40.71, -74, Date.parse('2026-09-11T14:00:00Z')), b = field(40.71, -74, Date.parse('2026-09-11T20:00:00Z'));
check(JSON.stringify(a) === JSON.stringify(b), 'the same place on the same (solar) day has the same clouds all day');
const next = field(40.71, -74, Date.parse('2026-09-12T14:00:00Z'));
check(next.seed !== a.seed, 'the next day has new ones');
check(field(51.5, -0.1, Date.parse('2026-09-11T14:00:00Z')).seed !== a.seed, 'and another place has its own');
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
