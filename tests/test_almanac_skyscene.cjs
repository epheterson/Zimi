// The beach scene's clouds and helicopter (zimi/static/almanac-skyscene.js):
// a cloud is lit by the Sun as that cloud sees it, so after sunset the high and
// the far ones toward the Sun keep its light and the rest go dark; the day's
// clouds are the same all day and new the next; the helicopter crosses low.
//
// Run: node tests/test_almanac_skyscene.cjs   (exit 0 = pass)

const { makeSky, read, check, done } = require('./sky_harness.cjs');
const { S, run } = makeSky();
const num = (code) => run(code);

// ── 1. The light on a cloud ──
const alt = (sun, sunAz, az, rho, h) => num('_skyCloudSunAlt(' + [sun, sunAz, az, rho, h].join(',') + ')');
check(alt(30, 180, 0, 20, 2) > 25, 'with the Sun well up every cloud sees it up');
check(alt(-6, 270, 270, 0, 9) < 0, 'overhead, 9 km up, with the Sun 6 degrees down: in the Earth\'s shadow');
check(alt(-2, 270, 270, 0, 9) > 0, 'but 2 degrees down it still lights a cloud 9 km up (the horizon has dipped 3 degrees from there)');
check(alt(-4, 270, 270, 400, 10) > 0, 'a cloud 400 km away toward the Sun, 10 km up, is lit at 4 degrees down');
check(alt(-4, 270, 90, 400, 10) < 0, 'and the same cloud on the far side of the sky is not');
check(alt(-4, 270, 270, 100, 1.5) < 0 && alt(-4, 270, 270, 100, 10) < 0.01 + alt(-4, 270, 270, 100, 1.5) + 5, 'a low cloud goes dark before a high one');
let higher = true;
for (let h = 1; h < 11; h++) if (alt(-5, 270, 270, 150, h + 1) < alt(-5, 270, 270, 150, h)) higher = false;
check(higher, 'the higher the cloud, the later the Sun leaves it');
let nearer = true;
for (let rho = 10; rho < 400; rho += 30) if (alt(-5, 270, 270, rho + 30, 8) < alt(-5, 270, 270, rho, 8)) nearer = false;
check(nearer, 'toward the Sun, the farther the cloud, the longer it is lit');

// ── 2. The day's clouds ──
const field = (ms, lat, lon) => JSON.stringify(run('_skyCloudField(' + [ms, lat, lon].join(',') + ')'));
const noon = Date.UTC(2026, 5, 21, 12), next = noon + 86400000;
check(field(noon, 40, -100) === field(noon + 3 * 3600000, 40, -100), 'the same clouds all day');
check(field(noon, 40, -100) !== field(next, 40, -100), 'new clouds the next day');
check(field(noon, 40, -100) !== field(noon, -33, 151), 'and at another place');
const f = run('_skyCloudField(' + noon + ', 40, -100)');
check(f.length > 0, 'a day has clouds (' + f.length + ')');
let ranges = true, ordered = true;
const L = run('SKY_CLOUD_LAYERS');
f.forEach((c, i) => {
  if (c.h < c.layer.h[0] || c.h > c.layer.h[1] || c.rho < c.layer.d[0] - 1e-9 || c.rho > c.layer.d[1] + 1e-9) ranges = false;
  if (i && c.rho > f[i - 1].rho) ordered = false;
});
check(ranges, 'each cloud is at a height and a distance its layer allows');
check(ordered, 'the farthest are drawn first, the near ones over them');
const heights = L.map((l) => l.h[1]);
check(heights[0] < 3 && heights[1] < 6 && heights[2] > 8, 'low, middle and high: below 3 km, below 6 km, above 8 km');

// ── 3. Painting ──
function fakeCtx() {
  const calls = { arcs: 0, grads: 0, stops: 0 };
  const grad = () => { calls.grads++; return { addColorStop: () => { calls.stops++; } }; };
  return { calls, save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, fill() {}, arc() { calls.arcs++; }, createRadialGradient: grad, set fillStyle(v) {}, set globalAlpha(v) {} };
}
function scene(sunGeoAlt, sunAz) {
  const sky = { W: 1200, H: 700, center: 180, span: 240, dpr: 2, scale: 1, lens: null, lat: 40, lon: -100, nowTime: noon, bodies: [],
    eph: { sun: { az: sunAz, alt: sunGeoAlt }, sunGeoAlt, moon: { azimuth: 30, altitude: -30 } }, moonData: { phase: { illumination: 50 } } };
  const ctx = fakeCtx();
  S.__s = sky; S.__ctx = ctx;
  run('_skyPaintClouds(__ctx, __s)');
  return { sky, ctx };
}
const dusk = scene(-3, 250), night = scene(-30, 250), day = scene(40, 200);
const clouds = (r) => r.sky.bodies.filter((b) => b.type === 'cloud');
check(clouds(dusk).length > 0 && dusk.ctx.calls.grads > 0, 'a dusk sky paints clouds (' + clouds(dusk).length + ' of them)');
check(clouds(dusk).some((b) => b.lit > 0.5), 'some are lit after sunset');
check(clouds(dusk).some((b) => b.lit < 0.5), 'and some are in shade');
check(clouds(night).every((b) => b.lit === 0), 'by deep night none is lit');
check(clouds(day).every((b) => b.lit > 0.99), 'by day every one is lit');
// The Sun's and the Moon's own places stay clear: put the Sun where a cloud stands and that cloud is not drawn.
const open = clouds(scene(-30, 250)).length;
const hidden = f.some((c) => {
  const at = run('_skyPlaneFromEN(' + (c.rho * Math.sin(c.az * Math.PI / 180)) + ', ' + (c.rho * Math.cos(c.az * Math.PI / 180)) + ', ' + c.h + ')');
  return at.alt > -2.5 && clouds(scene(at.alt, at.az)).length < open;
});
check(hidden, 'the Sun is never behind a cloud: a cloud where the Sun stands is left out');

// What a tap on a cloud says: its height, and whether the Sun still reaches it.
const lines = (r, b) => { S.__s = r.sky; S.__b = b; run('_skyState = __s'); return run('_skyCloudLines(__b)'); };
const litOne = clouds(dusk).find((b) => b.lit > 0.5), darkOne = clouds(dusk).find((b) => b.lit < 0.5);
check(lines(dusk, litOne).some((l) => l.indexOf('alm_sky_cloud_lit') === 0) && !lines(dusk, litOne).some((l) => l.indexOf('alm_sky_cloud_dark') === 0), 'a lit cloud after sunset says the Sun still reaches it');
check(lines(dusk, darkOne).some((l) => l.indexOf('alm_sky_cloud_dark') === 0), 'a dark one says the Earth\'s shadow has reached it');
check(lines(day, clouds(day)[0]).length === 2 && lines(day, clouds(day)[0])[1].indexOf('alm_sky_cloud_note') === 0, 'by day it says only what it is, and that it is drawn');

// ── 4. The helicopter ──
const kit = run('SKY_HELI');
S.__s = dusk.sky;
const heli = run('_skyHeli(__s, false)');
check(heli.type === 'heli' && !heli.contrail, 'a helicopter is its own kind of thing and leaves no trail');
check(heli.h >= kit.km[0] && heli.h <= kit.km[1] && heli.h < 2, 'it flies a few hundred metres up (' + heli.h.toFixed(2) + ' km)');
const plane = run('_skyPlane(__s, false)');
check(plane.type === 'plane' && plane.h > 8, 'an airliner is unchanged: a plane, 9 km and up');
const speed = (a) => (a.L1 - a.L0) / (a.dur / 1000);
check(speed(heli) < 0.1 && speed(plane) > 0.2, 'and slow: under 360 km/h against an airliner\'s 800');
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
