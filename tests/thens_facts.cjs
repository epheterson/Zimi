// What the Almanac's own ephemeris says of a place and an instant, for the there-and-thens: used to build thens-v1.json and to check it.
// The live sky's ephemeris (almanac-sky.js _skyEphemeris) in a bare vm, plus the topocentric Sun-Moon separation the eclipses need.
const { makeSky } = require('./sky_harness.cjs');
const { S } = makeSky();
const D = Math.PI / 180;
const SUN_SEMIDIAMETER_DEG = 0.2666;   // the Sun's mean angular radius (16 arcminutes)
const MOON_RADIUS_KM = 1737.4, EARTH_EQ_KM = 6378.14, FLATTENING_RATIO = 0.99664719;

function eph(ms, lat, lon) { return S._skyEphemeris(new Date(ms), lat, lon); }
function planet(e, name) { return e.planets.filter((p) => p.name === name)[0]; }
// The Sun and the Moon as one place sees them, parallax of the Moon included (Meeus 40): the angular distance between their
// centres, the Moon's and the Sun's radii, and whether the Sun is covered.
function eclipse(ms, lat, lon) {
  const d = new Date(ms), T = S._jdToJulianCentury(S._dateToJD(ms));
  const eq = S._moonEqCoords(d), sun = S._skySunRaDec(T), dist = S._moonDistance(d);
  const gm = ((280.46061837 + 360.98564736629 * (eq.JD - 2451545.0)) % 360) * D, la = lat * D;
  const u = Math.atan(FLATTENING_RATIO * Math.tan(la)), rs = FLATTENING_RATIO * Math.sin(u), rc = Math.cos(u);
  const sinPi = EARTH_EQ_KM / dist, H = gm + lon * D - eq.ra;
  const dRa = Math.atan2(-rc * sinPi * Math.sin(H), Math.cos(eq.dec) - rc * sinPi * Math.cos(H));
  const dec = Math.atan2((Math.sin(eq.dec) - rs * sinPi) * Math.cos(dRa), Math.cos(eq.dec) - rc * sinPi * Math.cos(H)), ra = eq.ra + dRa;
  const sep = Math.acos(Math.max(-1, Math.min(1, Math.sin(dec) * Math.sin(sun.dec) + Math.cos(dec) * Math.cos(sun.dec) * Math.cos(ra - sun.ra)))) / D;
  const moonR = Math.asin(MOON_RADIUS_KM / dist) / D;
  return { sep: sep, moonR: moonR, sunR: SUN_SEMIDIAMETER_DEG, total: sep < moonR - SUN_SEMIDIAMETER_DEG, annular: sep < SUN_SEMIDIAMETER_DEG - moonR };
}
// The instant within [from, to] (ms) the Sun is closest to the Moon's centre, stepping `step` ms.
function bestEclipse(lat, lon, from, to, step) {
  let best = null;
  for (let t = from; t <= to; t += step) { const e = eclipse(t, lat, lon); if (!best || e.sep < best.sep) best = Object.assign({ ms: t }, e); }
  return best;
}
// The instant within [from, to] the Sun's altitude crosses `alt` (degrees), rising or setting.
function sunCrossing(lat, lon, from, to, alt, rising) {
  let prev = eph(from, lat, lon).sun.alt;
  for (let t = from + 30000; t <= to; t += 30000) {
    const a = eph(t, lat, lon).sun.alt;
    if (rising ? prev < alt && a >= alt : prev > alt && a <= alt) return t;
    prev = a;
  }
  return null;
}
function angDist(az1, el1, az2, el2) {
  const a = el1 * D, b = el2 * D, dl = (az1 - az2) * D;
  return Math.acos(Math.max(-1, Math.min(1, Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(dl)))) / D;
}
module.exports = { S, eph, planet, eclipse, bestEclipse, sunCrossing, angDist, SUN_SEMIDIAMETER_DEG };
