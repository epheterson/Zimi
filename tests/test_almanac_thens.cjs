// The there-and-thens (zimi/static/earth/thens-v1.json): every entry is checked against the Almanac's own ephemeris and launch maths, one
// test per family, so the list says only what the engine shows.
//
//   Spaceflight  a launch's rocket is up and seen from its place at that instant, where the entry says; the first Starlink train rises
//                over Leiden within five minutes of when Langbroek filmed it (22:55 UT).
//   Sky          the eclipses are total there then (Sun and Moon centres closer than the difference of their radii), the Sun is where
//                the entry faces, the Great Conjunction is a tenth of a degree apart and above the horizon at dusk.
//   History      the Titanic's night: no Moon above the horizon, a dark sky.
//   Places       Adams's Moon is a waxing gibbous due east, a few degrees up; Venus is the morning star before dawn at Saint-Remy; the
//                solstice Sun rises on Stonehenge's axis (about 50 degrees), Abu Simbel's on both its dates (101 degrees), the setting Sun on
//                Manhattan's grid (299 degrees).
//   Shape        every entry has its fields, a source and references; every title is translated; the backlog says what it needs.
//
// Run: node tests/test_almanac_thens.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const H = require('./launch_harness.cjs');
const F = require('./thens_facts.cjs');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}
const data = JSON.parse(fs.readFileSync(path.join(H.STATIC, 'earth', 'thens-v1.json'), 'utf8'));
const by = Object.fromEntries(data.moments.map((m) => [m.id, m]));
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const FAMILIES = ['spaceflight', 'sky', 'history', 'places'];

// ── Shape ──
{
  check(data.moments.length >= 15 && new Set(data.moments.map((m) => m.id)).size === data.moments.length, data.moments.length + ' entries, ids unique');
  const bad = data.moments.filter((m) => !(FAMILIES.includes(m.family) && m.title && m.place && isFinite(m.place.lat) && isFinite(m.place.lon) && m.place.name && isFinite(m.instant) && m.look && isFinite(m.look.az) && isFinite(m.look.el) && m.look.spanDeg > 0 &&
    m.see && m.source && m.source.name && /^https:/.test(m.source.url) && m.refs.length > 0 && m.refs.every((r) => /^https:/.test(r)) && m.notes));
  check(bad.length === 0, 'every entry has family, title, place, instant, look, see, source, references and a note' + bad.map((m) => ' ' + m.id).join(''));
  check(FAMILIES.every((f) => data.moments.some((m) => m.family === f)), 'all four families are present');
  check(data.backlog.length >= 10 && data.backlog.every((b) => b.id && b.title && b.needs), data.backlog.length + ' backlog entries, each with what it needs');
  check(!data.backlog.some((b) => by[b.id]), 'nothing is both shipped and in the backlog');
  const names = JSON.stringify(data);
  check(!/campsite|home|my |private/i.test(names), 'no personal place');
  // Titles are translated (the keys are then_<id>).
  const langs = ['en', 'de', 'es', 'fr', 'pt', 'ru', 'zh', 'ar', 'he', 'hi'];
  const missing = [];
  langs.forEach((l) => {
    const d = JSON.parse(fs.readFileSync(path.join(H.STATIC, 'i18n', l + '.json'), 'utf8'));
    data.moments.forEach((m) => { if (!d['then_' + m.id.replace(/-/g, '_')]) missing.push(l + ':' + m.id); });
  });
  check(missing.length === 0, 'every title is in all ten languages' + missing.slice(0, 3).join(' '));
}

// ── Spaceflight ──
{
  const launches = data.moments.filter((m) => m.launch && m.see !== 'train');
  for (const m of launches) {
    const L = H.launch(m.launch), f = H.ascent(L), t = (m.instant - L.ms) / 1000;
    const r = H.S._lfSkyRocket(f, L, m.instant, m.place.lat, m.place.lon);
    check(t > 0 && t < f.stop && r && near(r.az, m.look.az, 2) && near(r.el, m.look.el, 2), m.id + ': the rocket is up at T+' + t + ' s where the entry faces (' + (r ? r.az.toFixed(0) + ' deg, ' + r.el.toFixed(0) + ' deg, ' + r.sight : 'not seen') + ')');
    const seen = H.S._lfObserve(f, L, L.ms, m.place.lat, m.place.lon);
    check(seen.seen && seen.sight === m.see, m.id + ': from there the best sight is ' + m.see + ' (' + seen.sight + ')');
  }
  check(by['launch-starlink-4-31-la'].see === 'jellyfish', 'the Los Angeles launch shows its lit exhaust');
  check(by['launch-falcon-heavy-2018'].see === 'day' && by['launch-artemis-1-2022'].see === 'flame', 'a day launch is a daylight point and a night launch a flame');
  const m = by['starlink-train-2019-leiden'], L = H.launch(m.launch), f = H.ascent(L), dep = H.deploy(L, f);
  const w = H.S._lfBatchWindows(dep, Date.UTC(2019, 4, 24, 21, 0), Date.UTC(2019, 4, 25, 1, 0), m.place.lat, m.place.lon, 5, 10000).filter((x) => x.peakEl > 30)[0];
  const langbroek = Date.UTC(2019, 4, 24, 22, 55);
  check(w && Math.abs(w.start - langbroek) <= 5 * 60000, 'the first Starlink train rises over Leiden at ' + (w ? new Date(w.start).toISOString().slice(11, 16) : '-') + ' UT; Langbroek filmed it near 22:55 UT (within five minutes)');
  const sats = H.S._lfSkyBatch(dep, m.instant, m.place.lat, m.place.lon);
  check(sats.length >= 40 && near(sats.sort((a, b) => b.el - a.el)[0].az, m.look.az, 1), 'sixty satellites a day after launch, ' + sats.length + ' above the horizon and lit at the entry\'s instant');
}

// ── Sky events ──
{
  for (const id of ['eclipse-2017-madras', 'eclipse-2024-kerrville', 'eclipse-2024-cleveland', 'eclipse-2027-luxor']) {
    const m = by[id], e = F.eclipse(m.instant, m.place.lat, m.place.lon), sun = F.eph(m.instant, m.place.lat, m.place.lon).sun;
    check(e.total && e.sep < 0.02 && near(m.look.az, sun.az, 0.01) && near(m.look.el, sun.alt, 0.01) && sun.alt > 20, id + ': total there then, the centres ' + (e.sep * 60).toFixed(1) + ' arcmin apart, the Sun ' + sun.alt.toFixed(0) + ' deg up where the entry faces');
  }
  const g = by['great-conjunction-2020'], e = F.eph(g.instant, g.place.lat, g.place.lon), j = F.planet(e, 'Jupiter'), s = F.planet(e, 'Saturn');
  const sep = F.angDist(j.az, j.alt, s.az, s.alt);
  check(sep < 0.15 && j.alt > 10 && e.sun.alt < -3 && e.sun.alt > -12 && near(g.look.az, j.az, 0.01), 'Great Conjunction: Jupiter and Saturn ' + (sep * 60).toFixed(1) + ' arcmin apart (published 6.1), ' + j.alt.toFixed(0) + ' deg up in the dusk');
}

// ── History ──
{
  const m = by['titanic-1912'], e = F.eph(m.instant, m.place.lat, m.place.lon), phase = F.S._moonPhase(new Date(m.instant));
  check(e.moon.altitude < -5 && e.sun.alt < -18 && phase.illumination < 15, 'Titanic: the Moon ' + e.moon.altitude.toFixed(0) + ' deg (below the horizon, ' + phase.illumination.toFixed(0) + '% lit), the Sun ' + e.sun.alt.toFixed(0) + ' deg: a dark sky');
}

// ── Art and places ──
{
  const a = by['adams-moonrise-1941'], e = F.eph(a.instant, a.place.lat, a.place.lon), phase = F.S._moonPhase(new Date(a.instant));
  check(e.moon.altitude > 3 && e.moon.altitude < 10 && near(e.moon.azimuth, 90, 5) && phase.illumination > 90 && phase.phase < 0.5 && e.sun.alt > 0 && e.sun.alt < 10 && near(a.look.az, e.moon.azimuth, 0.01),
    'Adams: the Moon ' + e.moon.altitude.toFixed(1) + ' deg up at azimuth ' + e.moon.azimuth.toFixed(0) + ', ' + phase.illumination.toFixed(0) + '% lit and waxing, the Sun ' + e.sun.alt.toFixed(1) + ' deg');
  const v = by['starry-night-1889'], ev = F.eph(v.instant, v.place.lat, v.place.lon), venus = F.planet(ev, 'Venus');
  check(venus.alt > 5 && venus.az > 60 && venus.az < 100 && venus.mag < -4 && ev.sun.alt < -6 && near(v.look.az, venus.az, 0.01), 'Saint-Remy: Venus ' + venus.alt.toFixed(0) + ' deg up in the east, magnitude ' + venus.mag.toFixed(1) + ', before dawn (Sun ' + ev.sun.alt.toFixed(0) + ')');
  const st = by['stonehenge-solstice'], es = F.eph(st.instant, st.place.lat, st.place.lon).sun;
  check(near(es.az, 49.9, 1) && es.alt > 0 && es.alt < 1, 'Stonehenge: the solstice Sun rises at azimuth ' + es.az.toFixed(1) + ' (the axis is about 49.9)');
  const ab = by['abu-simbel-february'], eb = F.eph(ab.instant, ab.place.lat, ab.place.lon).sun;
  const oct = F.sunCrossing(ab.place.lat, ab.place.lon, Date.UTC(2024, 9, 22, 3, 0), Date.UTC(2024, 9, 22, 4, 30), 0.3, true), eo = F.eph(oct, ab.place.lat, ab.place.lon).sun;
  check(near(eb.az, 101, 1.5) && near(eo.az, eb.az, 1), 'Abu Simbel: the Sun rises at ' + eb.az.toFixed(1) + ' on 22 February and ' + eo.az.toFixed(1) + ' on 22 October, the same line');
  const mh = by['manhattanhenge'], em = F.eph(mh.instant, mh.place.lat, mh.place.lon).sun;
  check(near(em.az, 299, 1) && em.alt > 0 && em.alt < 1, 'Manhattanhenge: the Sun sets at azimuth ' + em.az.toFixed(1) + ' on the grid\'s 299');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
