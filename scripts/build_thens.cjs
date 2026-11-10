#!/usr/bin/env node
// Writes zimi/static/earth/thens-v1.json: the curated there-and-thens (Almanac > Launches > There and then), each the place, the
// instant and the direction to face, worked out from the Almanac's own ephemeris and launch maths, so what the list shows is what the
// engine says. tests/test_almanac_thens.cjs checks every entry against the same facts.
//
//   node scripts/build_thens.cjs
//
// An entry: { id, family, title, place: {name, lat, lon, kind}, instant (ms, UTC), look: {az, el, spanDeg}, see, source: {name, url,
// licence}, refs: [url], launch?: tag, notes }. `see` names the sight; the words are looked up by it (then_see_<see>, or alm_launch_sight_*
// for a rocket). `backlog` lists what is wanted and what the engine needs to show it honestly.
const fs = require('fs');
const path = require('path');
const H = require('../tests/launch_harness.cjs');
const F = require('../tests/thens_facts.cjs');

const MIN = 60000, SPAN = 60;
const NASA = 'NASA, Espenak, eclipse predictions';
const place = (name, lat, lon) => ({ name, lat, lon, kind: 'place' });
const GCAT = { name: 'GCAT (McDowell)', url: 'https://planet4589.org/space/gcat', licence: 'CC BY 4.0' };

function launchMoment(spec) {
  const L = H.launch(spec.tag), f = H.ascent(L);
  const seen = H.S._lfObserve(f, L, L.ms, spec.place.lat, spec.place.lon);
  const m = H.S._lfThen(L, spec.place, seen);
  if (!m) throw new Error(spec.id + ': not seen from there');
  return Object.assign(m, { id: spec.id, family: spec.family, title: spec.title, launch: spec.tag, refs: spec.refs, notes: spec.notes, source: GCAT });
}
function batchMoment(spec) {
  const L = H.launch(spec.tag), f = H.ascent(L), dep = H.deploy(L, f);
  const w = H.S._lfBatchWindows(dep, spec.from, spec.to, spec.place.lat, spec.place.lon, 5, 10000).sort((a, b) => b.peakEl - a.peakEl)[0];
  const sats = H.S._lfSkyBatch(dep, w.peakMs, spec.place.lat, spec.place.lon).sort((a, b) => b.el - a.el);
  return { id: spec.id, family: spec.family, title: spec.title, place: Object.assign({ kind: 'place' }, spec.place), instant: w.peakMs, look: { az: sats[0].az, el: sats[0].el, spanDeg: SPAN }, see: 'train', source: GCAT, launch: spec.tag, refs: spec.refs, notes: spec.notes };
}
function eclipseMoment(spec) {
  const e = F.bestEclipse(spec.place.lat, spec.place.lon, spec.from, spec.to, 10000);
  if (!e.total) throw new Error(spec.id + ': not total');
  const s = F.eph(e.ms, spec.place.lat, spec.place.lon).sun;
  return { id: spec.id, family: spec.family, title: spec.title, place: Object.assign({ kind: 'place' }, spec.place), instant: e.ms, look: { az: s.az, el: s.alt, spanDeg: SPAN }, see: 'eclipse', source: { name: NASA, url: spec.url, licence: 'public domain' }, refs: [spec.url], notes: spec.notes };
}
function bodyMoment(spec) {
  const e = F.eph(spec.ms, spec.place.lat, spec.place.lon);
  const b = spec.body === 'moon' ? { az: e.moon.azimuth, alt: e.moon.altitude } : spec.body === 'sun' ? e.sun : F.planet(e, spec.body);
  return { id: spec.id, family: spec.family, title: spec.title, place: Object.assign({ kind: 'place' }, spec.place), instant: spec.ms, look: { az: b.az, el: b.alt, spanDeg: SPAN }, see: spec.see, source: spec.source, refs: spec.refs, notes: spec.notes };
}
function sunMoment(spec) {
  const t = F.sunCrossing(spec.place.lat, spec.place.lon, spec.from, spec.to, spec.alt, spec.rising);
  return bodyMoment(Object.assign({}, spec, { ms: t, body: 'sun' }));
}

const moments = [
  // Spaceflight
  launchMoment({ id: 'launch-starlink-4-31-la', family: 'spaceflight', title: 'Starlink 4-31 over Los Angeles', tag: '2022-141', place: place('Los Angeles', 34.05, -118.24),
    refs: ['https://www.nasaspaceflight.com/2022/10/starlink-4-31/', 'https://www.space.com/spacex-starlink-group-4-31-launch'],
    notes: 'A Falcon 9 from Vandenberg at 6:14 pm PDT with the Sun just below the horizon: its exhaust is lit. The launch is published; the sight is computed.' }),
  batchMoment({ id: 'starlink-train-2019-leiden', family: 'spaceflight', title: 'The first Starlink train, Leiden', tag: '2019-029', place: place('Leiden', 52.16, 4.49), from: Date.UTC(2019, 4, 24, 22, 0), to: Date.UTC(2019, 4, 25, 0, 0),
    refs: ['https://sattrackcam.blogspot.com/2019/05/wowowow-spectacular-view-of-spacex.html'],
    notes: 'Sixty satellites a day after launch. Marco Langbroek filmed the train near 22:55 UT on 24 May 2019 from Leiden; the reconstruction has it rising at 22:55.' }),
  launchMoment({ id: 'launch-falcon-heavy-2018', family: 'spaceflight', title: 'Falcon Heavy\'s first flight, Titusville', tag: '2018-017', place: place('Titusville', 28.61, -80.81),
    refs: ['https://en.wikipedia.org/wiki/Falcon_Heavy_test_flight'], notes: 'Lift-off at 3:45 pm EST from Kennedy; the ascent in daylight, seen from across the river. The ascent is a Falcon profile; the two side boosters are not drawn.' }),
  launchMoment({ id: 'launch-artemis-1-2022', family: 'spaceflight', title: 'Artemis I leaves in the night, Titusville', tag: '2022-156', place: place('Titusville', 28.61, -80.81),
    refs: ['https://en.wikipedia.org/wiki/Artemis_I'], notes: 'Lift-off at 1:47 am EST on 16 November 2022. The ascent is a typical profile for a rocket of its size, not the SLS\'s own.' }),
  // Sky events
  eclipseMoment({ id: 'eclipse-2017-madras', family: 'sky', title: 'Total eclipse, Madras, Oregon, 2017', place: place('Madras, Oregon', 44.63, -121.13), from: Date.UTC(2017, 7, 21, 17, 10), to: Date.UTC(2017, 7, 21, 17, 30),
    url: 'https://eclipse.gsfc.nasa.gov/SEgoogle/SEgoogle2001/SE2017Aug21Tgoogle.html', notes: 'Totality in the middle of the path, at 10:20 am PDT.' }),
  eclipseMoment({ id: 'eclipse-2024-kerrville', family: 'sky', title: 'Total eclipse, Kerrville, Texas, 2024', place: place('Kerrville, Texas', 30.05, -99.14), from: Date.UTC(2024, 3, 8, 18, 25), to: Date.UTC(2024, 3, 8, 18, 45),
    url: 'https://eclipse.gsfc.nasa.gov/SEgoogle/SEgoogle2001/SE2024Apr08Tgoogle.html', notes: 'Totality at 1:34 pm CDT, the Sun high in the south.' }),
  eclipseMoment({ id: 'eclipse-2024-cleveland', family: 'sky', title: 'Total eclipse, Cleveland, Ohio, 2024', place: place('Cleveland, Ohio', 41.5, -81.69), from: Date.UTC(2024, 3, 8, 19, 5), to: Date.UTC(2024, 3, 8, 19, 25),
    url: 'https://eclipse.gsfc.nasa.gov/SEgoogle/SEgoogle2001/SE2024Apr08Tgoogle.html', notes: 'Totality at 3:16 pm EDT.' }),
  eclipseMoment({ id: 'eclipse-2027-luxor', family: 'sky', title: 'Total eclipse, Luxor, 2027', place: place('Luxor', 25.7, 32.65), from: Date.UTC(2027, 7, 2, 9, 55), to: Date.UTC(2027, 7, 2, 10, 15),
    url: 'https://eclipse.gsfc.nasa.gov/SEgoogle/SEgoogle2001/SE2027Aug02Tgoogle.html', notes: 'The longest eclipse of the century, near its greatest, the Sun almost overhead. A future moment: the maths is the same.' }),
  bodyMoment({ id: 'great-conjunction-2020', family: 'sky', title: 'The Great Conjunction, Houston, 2020', place: place('Houston', 29.76, -95.37), ms: Date.UTC(2020, 11, 21, 23, 45), body: 'Jupiter', see: 'conjunction',
    source: { name: 'Almanac ephemeris', url: 'https://en.wikipedia.org/wiki/Great_Conjunction_of_2020', licence: '' }, refs: ['https://en.wikipedia.org/wiki/Great_Conjunction_of_2020'], notes: 'Jupiter and Saturn a tenth of a degree apart in the dusk, on the night of the solstice.' }),
  // History
  { id: 'titanic-1912', family: 'history', title: 'The moonless night of the Titanic, 1912', place: { name: 'North Atlantic', lat: 41.73, lon: -49.95, kind: 'sea' }, instant: Date.UTC(1912, 3, 15, 2, 38), look: { az: 270, el: 20, spanDeg: 90 }, see: 'dark',
    source: { name: 'Almanac ephemeris', url: 'https://en.wikipedia.org/wiki/Sinking_of_the_Titanic', licence: '' }, refs: ['https://en.wikipedia.org/wiki/Sinking_of_the_Titanic'],
    notes: 'Twenty to midnight by ship\'s time, 14 April 1912, at the collision: a clear, calm night with no Moon (a waning crescent, long set), facing the bow\'s way, west.' },
  // Art and places
  bodyMoment({ id: 'adams-moonrise-1941', family: 'places', title: 'Moonrise, Hernandez, New Mexico, 1941', place: place('Hernandez, New Mexico', 36.07, -106.15), ms: Date.UTC(1941, 10, 1, 23, 49, 20), body: 'moon', see: 'moonrise',
    source: { name: 'Almanac ephemeris', url: 'https://en.wikipedia.org/wiki/Moonrise,_Hernandez,_New_Mexico', licence: '' }, refs: ['https://en.wikipedia.org/wiki/Moonrise,_Hernandez,_New_Mexico'], notes: 'Ansel Adams\'s photograph, 4:49:20 pm MST on 1 November 1941, as astronomers dated it from the Moon\'s place: a waxing gibbous Moon due east, a few degrees up.' }),
  bodyMoment({ id: 'starry-night-1889', family: 'places', title: 'Venus before dawn, Saint-Rémy, 1889', place: place('Saint-Rémy-de-Provence', 43.79, 4.83), ms: Date.UTC(1889, 5, 16, 2, 50), body: 'Venus', see: 'venus',
    source: { name: 'Almanac ephemeris', url: 'https://en.wikipedia.org/wiki/The_Starry_Night', licence: '' }, refs: ['https://en.wikipedia.org/wiki/The_Starry_Night'], notes: 'Van Gogh painted The Starry Night in June 1889: the bright star over the hills is Venus, the morning star, rising in the east before dawn.' }),
  sunMoment({ id: 'stonehenge-solstice', family: 'places', title: 'Summer solstice sunrise, Stonehenge', place: place('Stonehenge', 51.1789, -1.8262), from: Date.UTC(2024, 5, 21, 3, 30), to: Date.UTC(2024, 5, 21, 4, 30), alt: 0.3, rising: true, see: 'sunrise',
    source: { name: 'Almanac ephemeris', url: 'https://www.english-heritage.org.uk/visit/places/stonehenge/history/solstice/', licence: '' }, refs: ['https://www.english-heritage.org.uk/visit/places/stonehenge/history/solstice/'], notes: 'The Sun rises over the Heel Stone, about 50 degrees from north.' }),
  sunMoment({ id: 'abu-simbel-february', family: 'places', title: 'Sunrise at Abu Simbel, 22 February', place: place('Abu Simbel', 22.337, 31.626), from: Date.UTC(2024, 1, 22, 4, 0), to: Date.UTC(2024, 1, 22, 5, 0), alt: 0.3, rising: true, see: 'sunrise',
    source: { name: 'Almanac ephemeris', url: 'https://en.wikipedia.org/wiki/Abu_Simbel_temples', licence: '' }, refs: ['https://en.wikipedia.org/wiki/Abu_Simbel_temples'], notes: 'Twice a year the first light runs down the temple to the statues in its heart: 22 February and 22 October.' }),
  sunMoment({ id: 'manhattanhenge', family: 'places', title: 'Manhattanhenge, New York', place: place('Midtown Manhattan', 40.7589, -73.9851), from: Date.UTC(2024, 6, 12, 0, 0), to: Date.UTC(2024, 6, 12, 1, 0), alt: 0.5, rising: false, see: 'sunset',
    source: { name: 'Almanac ephemeris', url: 'https://en.wikipedia.org/wiki/Manhattanhenge', licence: '' }, refs: ['https://en.wikipedia.org/wiki/Manhattanhenge'], notes: 'The setting Sun on the line of the street grid, 29 degrees north of west.' })
];

const backlog = [
  { id: 'apollo-8-earthrise', title: 'Earthrise from Apollo 8, 1968-12-24', lane: 'missions', needs: 'a spacecraft vantage: Apollo 8 in lunar orbit as a place to look from, the Moon\'s horizon and the Earth rising over it' },
  { id: 'pale-blue-dot', title: 'The Pale Blue Dot from Voyager 1, 1990-02-14', lane: 'missions', needs: 'a spacecraft vantage: Voyager 1 as a place to look from, with the Earth as a point from 6 billion km' },
  { id: 'new-horizons-pluto', title: 'The New Horizons flyby of Pluto, 2015-07-14', lane: 'missions', needs: 'a spacecraft vantage: New Horizons as a place to look from, with Pluto and Charon' },
  { id: 'falcon-heavy-twin-landing', title: 'The Falcon Heavy twin booster landing, 2018-02-06', lane: 'launches', needs: 'the two side boosters\' return paths (only one booster is modelled)' },
  { id: 'neowise-2020', title: 'Comet NEOWISE, July 2020', lane: 'sky', needs: 'the sky engine: comets (orbits, a coma and a tail)' },
  { id: 'hale-bopp-1997', title: 'Comet Hale-Bopp, spring 1997', lane: 'sky', needs: 'the sky engine: comets' },
  { id: 'halley-1986-2061', title: 'Halley\'s Comet, 1986 and 2061', lane: 'sky', needs: 'the sky engine: comets' },
  { id: 'leonids-1833-1966', title: 'The Leonid storms of 1833 and 1966', lane: 'sky', needs: 'the sky engine: a meteor storm at its published rate, from its radiant' },
  { id: 'shoemaker-levy-9-1994', title: 'Shoemaker-Levy 9 at Jupiter, July 1994', lane: 'sky', needs: 'the sky engine: a comet\'s fragments and their impacts on Jupiter' },
  { id: 'venus-transit-2012', title: 'The transit of Venus, 2012-06-05', lane: 'sky', needs: 'the sky engine: Venus drawn as a disc crossing the Sun' },
  { id: 'galileo-padua-1610', title: 'Galileo\'s nights with Jupiter\'s moons, Padua, January 1610', lane: 'sky', needs: 'the sky engine: the Galilean moons in the sky, with the instant\'s positions' },
  { id: 'tycho-supernova-1572', title: 'Tycho\'s supernova, November 1572', lane: 'sky', needs: 'the sky engine: a historical supernova in Cassiopeia as a new star' },
  { id: 'columbus-eclipse-1504', title: 'Columbus\'s lunar eclipse, Jamaica, 1504-02-29 (Julian)', lane: 'sky', needs: 'the sky engine: a lunar eclipse in the sky at that date (the Julian calendar, and the Earth\'s slowing before 1600)' }
];

// Places on other bodies: the ground view (almanac-stand.js) opens there. The place and the instant are the Almanac's own site data
// (sites-v1.json, landmarks-v1.json: NASA and ESA); the direction is the Earth's, read off the ground view's own frame at that instant
// (st.fr.objs, with the browser test tests/test_almanac_thens_browser.py holding the file to it).
const siteOf = (body, name) => {
  const sites = JSON.parse(fs.readFileSync(path.join(H.STATIC, 'earth', 'sites-v1.json'), 'utf8')).sites.filter((s) => s.body === body && s.name === name)[0];
  const lm = JSON.parse(fs.readFileSync(path.join(H.STATIC, 'earth', 'landmarks-v1.json'), 'utf8'))[body].filter((r) => r[0] === name)[0];
  return { ms: sites.ms, lat: lm[1], lon: lm[2] };
};
const apollo = siteOf('moon', 'Apollo 11'), huygens = siteOf('titan', 'Huygens');
moments.splice(4, 0,
  { id: 'apollo-11-tranquility', family: 'spaceflight', title: 'Tranquility Base at the landing', place: { name: 'The Moon, Tranquility Base', lat: apollo.lat, lon: apollo.lon, kind: 'site', body: 'moon' }, instant: apollo.ms + 40000,
    look: { az: 272.3, el: 59.2, spanDeg: SPAN }, see: 'earthsky', source: { name: 'NASA, Apollo 11 mission', url: 'https://www.nasa.gov/mission/apollo-11/', licence: 'public domain' }, refs: ['https://www.nasa.gov/mission/apollo-11/'],
    notes: 'The Eagle on the ground at 20:17:40 UTC on 20 July 1969, the Earth high in a black sky. The ground view has the lunar module and the Earth; the direction is the Earth\'s in that view.' },
  { id: 'huygens-titan', family: 'spaceflight', title: 'Huygens on Titan', place: { name: 'Titan, the Huygens site', lat: huygens.lat, lon: huygens.lon, kind: 'site', body: 'titan' }, instant: huygens.ms,
    look: { az: 117.3, el: 58.9, spanDeg: SPAN }, see: 'site', source: { name: 'ESA, Cassini-Huygens', url: 'https://www.esa.int/Science_Exploration/Space_Science/Cassini-Huygens', licence: '' }, refs: ['https://www.esa.int/Science_Exploration/Space_Science/Cassini-Huygens'],
    notes: 'The probe on the ground at 12:43 UTC on 14 January 2005, the first landing in the outer solar system. The ground view has the probe where it came to rest.' });

const out = { shape: 'id family title place{name,lat,lon,kind} instant(ms UTC) look{az,el,spanDeg} see source{name,url,licence} refs launch? notes', moments, backlog };
fs.writeFileSync(path.join(H.STATIC, 'earth', 'thens-v1.json'), JSON.stringify(out, null, 1) + '\n');
moments.forEach((m) => console.log(m.family.padEnd(12), m.id.padEnd(30), new Date(m.instant).toISOString(), 'az', m.look.az.toFixed(1), 'el', m.look.el.toFixed(1), m.see));
