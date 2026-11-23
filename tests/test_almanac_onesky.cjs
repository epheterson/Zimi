// One sky (zimi/static/almanac-onesky.js): the definition, the photometry the card and Stand here share, and the
// registry of what is in the sky. The pixels (card against ground, the objects) are tests/test_almanac_onesky_browser.py.
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

// The sky darkens steeply over the last seconds, not as a flat cut: a few stops in 30 s on the way in, and the deep twilight of totality.
const lmAt = (hms) => run('_osSkyState(_osDef({ lat: 30.0474, lon: -99.1403, tMs: Date.parse("2024-04-08T' + hms + 'Z") })).lm');
const lm0 = lmAt('18:31:00'), lm1 = lmAt('18:31:45'), lm2 = lmAt('18:32:15'), lmT = lmAt('18:34:50'), lmOut = lmAt('18:37:30');
check(lm0 < lm1 && lm1 < lm2 && lm2 - lm0 > 0.8, 'over the last minute the faintest star shown climbs steadily (' + [lm0, lm1, lm2].map((x) => x.toFixed(2)).join(', ') + ')');
check(lmT > 1.0 && lmT < 2.0, 'at totality the sky is a Sun -6.5 twilight: the faintest star about +1.4 (Venus at -3.9 and Jupiter at -2 show) (' + lmT.toFixed(2) + ')');
const twi = run('_sgLimitMag(_sgSkyLum(-6.5, -90, 0, 0, 1, 1))');
check(Math.abs(lmT - twi) < 0.05, 'the same as a real Sun at -6.5 (' + twi.toFixed(2) + '): one twilight path');
check(lmOut < lm2 - 0.5, 'and the sky brightens again as the shadow leaves (' + lmOut.toFixed(2) + ')');
const zen = run('_sgSkyLum(68, -90, 0, 0, _sgSkyShare(1, 68), 1)');
const twz = run('_sgZenithLum(-6.5)');
check(Math.abs(zen - twz) / twz < 0.01, 'the zenith at totality is the twilight zenith of a Sun at -6.5 (' + zen.toFixed(2) + ' against ' + twz.toFixed(2) + ' cd/m2)');
const ks = (o) => run('_sgAdaptShare(_sgSkyShare(' + o + ', 68), ' + o + ')');
check(Math.abs(ks(1) - run('_sgSkyShare(1, 68)')) < 1e-9 && ks(0.5) > run('_sgSkyShare(0.5, 68)'), 'the eye lags a partial eclipse and takes the twilight exposure in the last few per cent');

// ── The device's capability (ZimiCap), when it is there ──
{
  S.__dprCap = 1.5; S.__frames = [];
  run('var __q = 2; var ZimiCap = { get: function (k) { return k === "skyQuality" ? __q : 2; }, dprCap: function () { return __dprCap; }, frame: function (k, t) { __frames.push([k, t]); } };');
  S.window.devicePixelRatio = 3;
  run('__q = 2');
  check(run('_osDpr()') === 3, 'at level 2 the card draws at the device ratio, not the 3D view\'s cap');
  run('__q = 1');
  check(run('_osDpr()') === 3, 'and at level 1 (the 3D view caps at 1.5 here) the card is cheap: it keeps the device ratio');
  run('__q = 0');
  check(run('_osDpr()') === 1.5, 'only the lowest level takes the cap: min(devicePixelRatio, dprCap)');
  S.window.devicePixelRatio = 1;
  check(run('_osDpr()') === 1, 'and never raised');
  run('_osFrame(123)');
  check(S.__frames.length === 1 && S.__frames[0][0] === 'sky' && S.__frames[0][1] === 123, 'each drawn frame is handed to the governor as "sky"');
  run('ZimiCap = undefined');
}

// ── Where a view faces ──
check(run('_osDefaultHeading(40)') === 180 && run('_osDefaultHeading(-33)') === 0 && run('_osDefaultHeading(0)') === 180, 'a view faces south in the north and north in the south, from one function');

// ── No clouds are invented: every live sky is the clear one ──
{
  const fs = require('fs'), path = require('path'), dir = path.join(__dirname, '..', 'zimi', 'static');
  check(['_osCloudField', '_osCloudValues', '_osCloudAlphaAt', '_osMoonVeilAt', '_osSunVeilAt', '_osStandClouds'].every((f) => run('typeof ' + f) === 'undefined'), 'there is no cloud field, no veil and no cloud mode left to ask');
  check(!('clouds' in run('_osHandoffFrom(_osDef({}), null)')), 'and a hand-off does not ask for a kind of sky');
  const src = ['skygl', 'sky', 'stand', 'standgl', 'oneair', 'onesky'].map((f) => fs.readFileSync(path.join(dir, 'almanac-' + f + '.js'), 'utf8')).join('\n');
  check(!/cloudDeck|cloudHit|uCloud|osClouds|_osCloud|SG_CLOUD|OS_CLOUD/.test(src), 'and no shader or painter carries a cloud deck');
}

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
