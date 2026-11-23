// The mission player's maths (zimi/static/almanac-missions.js), run from the shipped file without a browser: the Hermite
// curve through a path table, the timeline's phases and their widths, mission elapsed time. The data itself
// (static/earth/missions-v1.json) is checked in tests/test_almanac_missions.py against the flight reports and JPL Horizons.
//
// Run: node tests/test_almanac_missions.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-missions.js'), 'utf8');
const cut = src.indexOf('// ── Where a vehicle is, in the scene ──');
if (cut < 0) throw new Error('the pure section moved');
const ctx = { Math, Object, Array, String, JSON };
vm.createContext(ctx);
ctx._almAsset = (p) => p;   // app.js: a /static address with its version; here, as it is
const earthSrc = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-earth.js'), 'utf8');
const ref = earthSrc.match(/var AE_MISSION_REF = \{[\s\S]*?\n\};/);
if (!ref) throw new Error('the mission figures moved');
vm.runInContext('var AE_EARTH_RADIUS_KM = 6378.137; function _aeT(k) { return k; } function _aeClamp(v, a, b) { return Math.min(b, Math.max(a, v)); }\n' + ref[0] + '\n' + src.slice(0, cut), ctx);

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A path with a known answer: a circle of radius 7000 km at 7.5 km/s sampled every 60 s.
const w = 7.5 / 7000, rows = [];
for (let i = 0; i <= 20; i++) { const t = i * 60; rows.push([t, 7000 * Math.cos(w * t), 7000 * Math.sin(w * t), 0, -7.5 * Math.sin(w * t), 7.5 * Math.cos(w * t), 0]); }
let worst = 0;
for (let t = 0; t <= 1200; t += 7.3) {
  const r = ctx._amTable(rows, t);
  worst = Math.max(worst, Math.hypot(r.p[0] - 7000 * Math.cos(w * t), r.p[1] - 7000 * Math.sin(w * t)));
}
check(worst < 0.01, 'a Hermite curve through one minute rows follows a circular orbit to ' + worst.toFixed(4) + ' km');
const r0 = ctx._amTable(rows, 600);
check(near(Math.hypot(r0.v[0], r0.v[1]), 7.5, 1e-4), 'its velocity is the orbit\'s speed');
const out = ctx._amTable(rows, 1300);
check(isFinite(out.p[0]), 'asked past its end it still answers');

// The timeline.
const m = { end: 1000, start: 0, phases: [{ t: 0, w: 1 }, { t: 100, w: 2 }, { t: 400, w: 1 }] };
check(ctx._amPhaseAt(m, 0) === 0 && ctx._amPhaseAt(m, 99.9) === 0 && ctx._amPhaseAt(m, 100) === 1 && ctx._amPhaseAt(m, 999) === 2, 'the phase at a time is the last that began');
const wd = ctx._amWidths(m);
check(near(wd[0] + wd[1] + wd[2], 1, 1e-12) && near(wd[1], 0.5, 1e-12), 'the widths share the timeline by weight');
for (const t of [0, 50, 100, 250, 400, 700, 1000]) check(near(ctx._amTimeOf(m, ctx._amPosOf(m, t)), t, 1e-9), 'timeline position and time are inverses at ' + t);
check(near(ctx._amPosOf(m, 100), 0.25, 1e-12), 'a phase starts where the one before it ends');

// Elapsed time.
check(ctx._amMet(0) === 'T+0:00:00' && ctx._amMet(3723) === 'T+1:02:03' && ctx._amMet(-12) === 'T−0:00:12', 'elapsed time reads T+h:mm:ss, T− before zero');
check(ctx._amMet(102 * 3600 + 33 * 60 + 5) === 'T+102:33:05', 'and over a hundred hours still reads in hours');
check(ctx._amLabel({ k: 'x', en: 'Liftoff' }) === 'Liftoff', 'a label falls back on the data\'s English');

// The strip: NOW between two events, the line laid out by event.
const sm = { start: 0, end: 2000, phases: [{ t: 0 }], events: [{ t: 11 }, { t: 10 }, { t: 1000 }] };
check(ctx._amStripEvents(sm).map((e) => e.t).join() === '10,11,1000', 'the strip lists the events in the order they happen');
let at = ctx._amStripAt(sm, 10.5);
check(at.i === 0 && near(at.u, 0.5, 1e-12), 'NOW between two events is how far toward the next, in events');
at = ctx._amStripAt(sm, 505.5);
check(at.i === 1 && near(at.u, (505.5 - 11) / 989, 1e-12), 'a second apart and a thousand apart are one step each');
at = ctx._amStripAt(sm, 5);
check(at.i === -1 && at.u > 0 && at.u < 1, 'before the first event there is no event behind');
at = ctx._amStripAt(sm, 1500);
check(at.i === 2 && near(at.u, 0.5, 1e-12), 'after the last the line runs on to the end');
for (const t of [5, 10, 10.5, 11, 400, 1000, 1700, 2000]) { const a = ctx._amStripAt(sm, t); check(near(ctx._amStripTime(sm, a.i + a.u), t, 1e-9), 'the strip\'s position and time are inverses at ' + t); }
check(ctx._amStripStep(300) === 90 && ctx._amStripStep(1280) === 160 && near(ctx._amStripStep(500), 120, 1e-9), 'an event\'s step is a quarter of the window, between the stops');
check(JSON.stringify([ctx._amRelUnit(55), ctx._amRelUnit(360), ctx._amRelUnit(7200), ctx._amRelUnit(3 * 86400)]) === JSON.stringify([{ n: 55, unit: 'second' }, { n: 6, unit: 'minute' }, { n: 2, unit: 'hour' }, { n: 3, unit: 'day' }]), 'the time to an event reads in the unit that fits');
// Every mission, every event: the place of NOW only ever moves forward, and an event is reached exactly where the next stretch begins.
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'earth', 'missions-v1.json'), 'utf8')).missions;
for (const id of Object.keys(data)) {
  const mm = data[id], ev = ctx._amStripEvents(mm);
  let last = -Infinity, ok = true;
  for (let k = 0; k <= 400; k++) { const t = mm.start + (mm.end - mm.start) * k / 400, a = ctx._amStripAt(mm, t), f = a.i + a.u; if (f < last - 1e-9) ok = false; last = f; }
  check(ok, id + ': NOW only moves forward along the strip');
  check(ev.every((e, j) => { const a = ctx._amStripAt(mm, e.t); return a.i >= j && (a.i > j || near(a.u, 0, 1e-12)); }), id + ': each of its ' + ev.length + ' events is reached at a whole step');
}

// A coast's shot: close to the craft, looking back at where it came from for the first share of the phase, then ahead.
const cm = { end: 1000, start: 0, phases: [{ t: 0, cam: { d: 5 } }, { t: 100, cam: { body: 'earth', then: 'moon', coast: true, az: 6, el: 8, mix: 0 } }, { t: 600, cam: { body: 'moon', coast: true } }] };
const turnAt = 100 + 500 * ctx.AE_MISSION_REF.turnShare;
const shotAt = (pi, t) => ctx._amShotAt(cm, { phaseIdx: pi, t }, cm.phases[pi]);
check(shotAt(0, 50).d === 5, 'an ordinary phase\'s shot is its own');
check(shotAt(1, 100).body === 'earth' && shotAt(1, turnAt - 0.01).body === 'earth', 'a coast looks back at where it came from at first');
check(shotAt(1, turnAt).body === 'moon' && shotAt(1, 599).body === 'moon', 'then ahead at where it is going, from ' + (100 * ctx.AE_MISSION_REF.turnShare) + ' percent of the way');
check(shotAt(1, 300).d === ctx.AE_MISSION_REF.coastM && shotAt(2, 700).d === ctx.AE_MISSION_REF.coastM && shotAt(2, 700).body === 'moon', 'the craft is the same close size all the way, and a coast with one body keeps it');
check(ctx.AE_MISSION_REF.coastM >= 60 && ctx.AE_MISSION_REF.coastM <= 150 && ctx.AE_MISSION_REF.turnShare >= 0.25 && ctx.AE_MISSION_REF.turnShare <= 1 / 3, 'about a hundred metres, for the first quarter to third');
for (const id of Object.keys(data)) for (const p of data[id].phases) if (p.cam && p.cam.coast) check(p.cam.body && !p.cam.fit && !p.cam.overview, id + ': a coast shot names a body to look at (' + p.en + (p.cam.then ? ' then ' + p.cam.then : '') + ')');
check(['apollo11', 'perseverance'].every((id) => data[id].phases.some((p) => p.cam && p.cam.coast)) && data.apollo11.phases.filter((p) => p.cam && p.cam.then).length === 2, 'Apollo 11 turns on both its coasts, and Perseverance has its approach close');

// Entering a mission from outside: a time, an event or a phase.
const ap = data.apollo11, evT = (k) => ap.events.filter((e) => e.k === 'alm_ms_ev_' + k)[0].t;
check(ctx._amResolveAt(ap, 3600) === 3600 && ctx._amResolveAt(ap, 0) === 0, 'a time is itself');
check(near(ctx._amResolveAt(ap, 'liftoff_moon'), evT('liftoff_moon') - 2, 1e-9) && ctx._amResolveAt(ap, 'alm_ms_ev_liftoff_moon') === ctx._amResolveAt(ap, 'liftoff_moon'), 'a named event, with or without the interface prefix, a moment before it');
check(ctx._amResolveAt(ap, 'ascent') === ap.phases.filter((p) => p.k === 'alm_ms_ph_ascent')[0].t, 'a phase begins at its start');
check(ctx._amResolveAt(ap, 'nonsense') === null && ctx._amResolveAt(ap, NaN) === null && ctx._amResolveAt(ap, undefined) === null, 'what is not there is null');

process.exit(failures ? 1 : 0);
