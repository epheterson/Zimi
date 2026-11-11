// The beach scene's helicopter (zimi/static/almanac-skyscene.js): it crosses low with its real lights. The clouds that were drawn here
// are the day's one field now (tests/test_almanac_onesky.cjs).
//
// Run: node tests/test_almanac_skyscene.cjs   (exit 0 = pass)

const { makeSky, read, check, done } = require('./sky_harness.cjs');
const { S, run } = makeSky();
const num = (code) => run(code);

// ── 1. The drawn clouds are gone: the one field is the sky's own ──
check(run('typeof _skyPaintClouds') === 'undefined' && run('typeof _skyCloudField') === 'undefined' && run('typeof _skyCloudLines') === 'undefined', 'no drawn clouds remain: the day\'s one field (almanac-onesky.js _osCloudField, drawn by the sky\'s shader) is the card\'s clouds');
check(run('typeof _osCloudField') === 'function' && read('almanac-skygl.js').indexOf('cloudDeck') > 0, 'and the field and its shader are the ones the ground view uses');

// ── 2. Painting (the helicopter's) ──
const noon = Date.UTC(2026, 5, 21, 17);
function fakeCtx() {
  const calls = { arcs: 0, grads: 0, stops: 0 };
  const grad = () => { calls.grads++; return { addColorStop: () => { calls.stops++; } }; };
  return { calls, save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, fill() {}, arc() { calls.arcs++; }, createRadialGradient: grad, set fillStyle(v) {}, set globalAlpha(v) {} };
}
function scene(sunGeoAlt, sunAz) {
  const sky = { W: 1200, H: 700, center: 180, span: 240, dpr: 2, scale: 1, lens: null, lat: 40, lon: -100, nowTime: noon, bodies: [],
    eph: { sun: { az: sunAz, alt: sunGeoAlt }, sunGeoAlt, moon: { azimuth: 30, altitude: -30 } }, moonData: { phase: { illumination: 50 } } };
  return { sky, ctx: fakeCtx() };
}
const dusk = scene(-3, 250);

// ── 3. The helicopter ──
const kit = run('SKY_HELI');
S.__s = dusk.sky;
const heli = run('_skyHeli(__s, false)');
check(heli.type === 'heli' && !heli.contrail, 'a helicopter is its own kind of thing and leaves no trail');
check(heli.h >= kit.km[0] && heli.h <= kit.km[1] && heli.h < 2, 'it flies a few hundred metres up (' + heli.h.toFixed(2) + ' km)');
const plane = run('_skyPlane(__s, false)');
check(plane.type === 'plane' && plane.h > 8, 'an airliner is unchanged: a plane, 9 km and up');
// A draw whose nearest approach is farther than it ever climbs above the haze has no crossing at all (zero length, no speed):
// the speed is judged over many draws, on those that cross.
const speed = (a) => (a.L1 - a.L0) / (a.dur / 1000);
const crossing = (spawn) => Array.from({ length: 60 }, () => run(spawn)).filter((a) => a.dur > 0).map(speed);
const heliKmS = crossing('_skyHeli(__s, false)'), planeKmS = crossing('_skyPlane(__s, false)');
check(heliKmS.length > 0 && planeKmS.length > 0 && heliKmS.every((v) => v < 0.1) && planeKmS.every((v) => v > 0.2), 'and slow: under 360 km/h against an airliner\'s 800 (' + heliKmS.length + ' and ' + planeKmS.length + ' crossings)');
check(run('SKY_HELI_BEACON_MS') < 1000 && run('SKY_HELI_STROBE_PULSES').length === 2, 'its beacon flashes about once a second and its strobe flashes twice');

function lights(sunGeoAlt, msIntoCrossing) {
  const sky = Object.assign({}, dusk.sky, { bodies: [], eph: { sun: { az: 250, alt: sunGeoAlt }, sunGeoAlt, moon: { azimuth: 30, altitude: -30 } } });
  const ctx = fakeCtx(); ctx.fillRect = () => { ctx.calls.rects = (ctx.calls.rects || 0) + 1; };
  S.__s = sky; S.__ctx = ctx; S.__a = Object.assign({}, heli, { start: 0, phase: 0, dur: 100000, b: 1, L0: -1.5, L1: 1.5 });
  run('_skyPaintHeli(__ctx, __s, __a, ' + msIntoCrossing + ')');
  return { arcs: ctx.calls.arcs, rects: ctx.calls.rects || 0, bodies: sky.bodies.length };
}
const BEAT = run('SKY_HELI_BEACON_MS');
const onBeat = lights(-20, BEAT * 55), offBeat = lights(-20, BEAT * 55 + BEAT / 2);
check(onBeat.arcs > 0 && onBeat.rects === 0, 'at night it is lights alone');
check(onBeat.arcs > offBeat.arcs, 'and they blink: the beacon is on at one moment (' + onBeat.arcs + ' discs) and off at another (' + offBeat.arcs + ')');
const byDay = lights(30, 50000);
check(byDay.rects > 0 && byDay.arcs === 0, 'by day it is a speck, with no lights');
check(onBeat.bodies === 1, 'and it can be tapped');

done();
