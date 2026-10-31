// The sky's physical half (zimi/static/almanac-skygl.js, almanac-skyfacts.js,
// and the view and scheduling in almanac-sky.js): what is true before a pixel
// is drawn.
//
//   1. Stars: colour from B-V (a blackbody), the 9,096 of stars-v1.bin decoded,
//      scintillation by airmass.
//   2. Frames: the galactic frame (the Milky Way panorama's coordinates) and the
//      rotation to the observer, against catalogue positions.
//   3. Light: how bright the sky is, so what shows: the limiting magnitude through
//      twilight, a full Moon, a city; the Moon's illuminance; the air's optical depth.
//   4. The zodiacal light and the airglow.
//   5. The view: the lens and the panorama, forward and back, agree.
//   6. On demand: a live tick that has not turned the sky a pixel draws nothing.
//   7. The Earth's shadow on the Moon, against NASA's eclipse circumstances.
//   8. Rising and setting, and the time by the Sun, against JPL Horizons.
//   9. The data files: 88 constellations, the Milky Way panorama, their credits.
//  10. The life on the horizon: an airliner's pace and lights, meteor rates, the sea's mirror.
//
// Horizons references: https://ssd.jpl.nasa.gov/api/horizons.api, fetched
// 2026-10-14, COMMAND 10 (Sun) and 301 (Moon), CENTER coord@399, geodetic
// -122.4194 E, 37.7749 N, 0 m, QUANTITIES 4 (airless topocentric elevation),
// STEP 1 min, the crossing of -0.833 deg found by linear interpolation:
//   sunrise 2026-10-14 14:17:20 UT, sunset 2026-10-15 01:33:20 UT,
//   moonrise 2026-10-14 18:34:02 UT, and the Sun at -18 deg 2026-10-15 03:00:29 UT.
// NASA eclipse circumstances (eclipse.gsfc.nasa.gov): umbral magnitude 1.1804 at
// 2025-03-14 06:58:36 UT, 1.3647 at 2025-09-07 18:11:47 UT, 1.1507 at 2026-03-03 11:33:46 UT.
//
// Run: node tests/test_almanac_sky_physical.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const { makeSky, read, check, done, STATIC } = require('./sky_harness.cjs');
const { S, run } = makeSky();
const R2D = 180 / Math.PI, D2R = Math.PI / 180;

// ── 1. Star colour, the catalogue, scintillation ──
const K = (bv) => run('_sgBvToKelvin(' + bv + ')');
check(Math.abs(K(0.65) - 5778) < 40, 'the Sun (B-V 0.65) is 5,780 K (' + K(0.65).toFixed(0) + ')');
check(K(0) > 9500 && K(0) < 10600, 'Sirius (B-V 0.00) is about 10,000 K (' + K(0).toFixed(0) + ')');
check(K(1.85) > 3000 && K(1.85) < 3800, 'Betelgeuse (B-V 1.85) is about 3,400 K (' + K(1.85).toFixed(0) + ')');
const rgb = (bv) => run('_sgBvToRGB(' + bv + ')');
check(rgb(-0.2)[2] > rgb(-0.2)[0] && rgb(0)[2] > rgb(0)[0], 'hot stars are bluer than red');
check(rgb(1.85)[0] > 2 * rgb(1.85)[2] && rgb(1.85)[0] === 1, 'a cool giant is more than twice as red as blue, red the brightest channel');
let monotone = true;
for (let bv = -0.3; bv < 2; bv += 0.1) if (rgb(bv + 0.1)[0] / rgb(bv + 0.1)[2] < rgb(bv)[0] / rgb(bv)[2]) monotone = false;
check(monotone, 'redder with every step of B-V from -0.3 to 2.0');
const sunRgb = rgb(0.65);
check(sunRgb[0] >= sunRgb[1] && sunRgb[1] >= sunRgb[2] && sunRgb[2] > 0.75, 'a Sun-like star is near white, a touch warm');

const bin = fs.readFileSync(path.join(STATIC, 'earth', 'stars-v1.bin'));
const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
S.__buf = buf;
const stars = run('_sgDecodeStars(__buf)');
check(stars && stars.n === 9096, 'stars-v1.bin decodes to 9,096 stars');
check(Math.abs(stars.mag[0] - -1.46) < 0.03 && Math.abs(stars.ra[0] * R2D - 101.287) < 0.05 && Math.abs(stars.dec[0] * R2D - -16.716) < 0.05,
  'the first is Sirius: magnitude -1.46, RA 101.29, Dec -16.72 (' + stars.mag[0].toFixed(2) + ')');
check(Math.abs(Math.hypot(stars.vec[0], stars.vec[1], stars.vec[2]) - 1) < 1e-6, 'its vector is a unit vector');
let ordered = true;
for (let i = 1; i < stars.n; i++) if (stars.mag[i] < stars.mag[i - 1] - 0.041) ordered = false;
check(ordered && stars.mag[stars.n - 1] > 7.5, 'brightest first, down to magnitude ' + stars.mag[stars.n - 1].toFixed(1));
const wrong = new Uint8Array(bin.length); wrong.set(bin); wrong[2] = 9;
S.__bad = wrong.buffer;
check(run('_sgDecodeStars(__bad)') === null && run('_sgDecodeStars(new ArrayBuffer(3))') === null, 'a file that is not this format is refused');
// The file marks a star with no B-V by its own byte; each such star reads
// as the neutral 0.6 (a float32, so compared as one).
const rawBv = new Int8Array(buf, run('SG_STARS_HEADER_BYTES') + 5 * stars.n, stars.n);
const BV_NONE = run('SG_STARS_BV_NONE');
let noBv = 0, neutral = 0;
for (let i = 0; i < stars.n; i++) if (rawBv[i] === BV_NONE) { noBv++; if (stars.bv[i] === Math.fround(0.6)) neutral++; }
check(noBv > 0 && neutral === noBv, 'a star with no B-V reads as the neutral 0.6 (' + neutral + ' of ' + noBv + ')');

const scint = (a) => run('_sgScintillation(' + a + ')');
check(scint(90) > 0.03 && scint(90) < 0.06, 'a star at the zenith is steady (' + scint(90).toFixed(3) + ')');
check(scint(60) < scint(30) && scint(30) < scint(10) && scint(10) < scint(3), 'and boils more toward the horizon');
check(scint(3) <= 0.8 && scint(1) <= 0.8, 'but never past its cap');

// ── 2. The galactic frame, the horizon matrix ──
const vec = (raDeg, decDeg) => [Math.cos(decDeg * D2R) * Math.cos(raDeg * D2R), Math.cos(decDeg * D2R) * Math.sin(raDeg * D2R), Math.sin(decDeg * D2R)];
const gal = (ra, dec) => { S.__v = vec(ra, dec); return run('_sgGalactic(__v)'); };
const gc = gal(266.405, -28.936), ngp = gal(192.859, 27.128), acrux = gal(186.65, -63.10), m31 = gal(10.685, 41.269);
check(Math.min(gc.l, 360 - gc.l) < 0.05 && Math.abs(gc.b) < 0.05, 'Sagittarius A* is at galactic l 0, b 0 (' + gc.l.toFixed(3) + ', ' + gc.b.toFixed(3) + ')');
check(ngp.b > 89.95, 'the north galactic pole is b +90');
check(Math.abs(acrux.l - 300.2) < 0.4 && Math.abs(acrux.b - -0.36) < 0.4, 'Acrux is on the plane in Crux, l 300.2 (' + acrux.l.toFixed(1) + ', ' + acrux.b.toFixed(1) + ')');
check(Math.abs(m31.l - 121.17) < 0.2 && Math.abs(m31.b - -21.57) < 0.2, 'Andromeda is l 121.2, b -21.6');
const uv = (l, b) => run('_sgGalUV(' + l + ', ' + b + ')');
check(Math.abs(uv(0, 0).u - 0.5) < 1e-9 && Math.abs(uv(0, 0).v - 0.5) < 1e-9, 'the galactic centre is the middle of the panorama');
check(Math.abs(uv(280.47, -32.89).u - 0.7208) < 0.002 && Math.abs(uv(280.47, -32.89).v - 0.6827) < 0.002, 'the Large Magellanic Cloud is right and below it, where the picture has it');
check(Math.abs(uv(121.17, -21.57).u - 0.1634) < 0.002, 'Andromeda is left of it');
check(uv(180, 90).v === 0 && uv(0, -90).v === 1, 'the pole is the top row');

// The rotation to the observer: Polaris stands at the latitude, due north.
const T = run('_jdToJulianCentury(_dateToJD(Date.UTC(2026, 9, 14, 4, 0, 0)))');
S.__T = T;
const P = run('_skyPrecession(__T)');
S.__P = P;
const lst = run('_skyLST(new Date(Date.UTC(2026, 9, 14, 4, 0, 0)), -122.4194)');
S.__lst = lst;
const M = run('_sgHorizonMatrix(__P, __lst, 37.7749)');
S.__M = M;
const polaris = run('_skyAltAzOf(__M, ' + JSON.stringify(vec(37.95, 89.264)) + ')');
check(Math.abs(polaris.alt - 37.77) < 1.0 && (polaris.az < 2 || polaris.az > 358), 'Polaris is 37.8 deg up and due north from San Francisco (' + polaris.alt.toFixed(2) + ', ' + polaris.az.toFixed(1) + ')');
const rows = [0, 1, 2].map((i) => M.slice(3 * i, 3 * i + 3));
check(Math.abs(Math.hypot(...rows[0]) - 1) < 1e-9 && Math.abs(rows[0][0] * rows[1][0] + rows[0][1] * rows[1][1] + rows[0][2] * rows[1][2]) < 1e-9, 'the rotation is orthonormal');
// Against the ephemeris the sky already holds to Horizons: the same Sirius.
const when = Date.UTC(2026, 1, 1, 8, 0, 0);
S.__T2 = run('_jdToJulianCentury(_dateToJD(' + when + '))');
S.__M2 = run('_sgHorizonMatrix(_skyPrecession(__T2), _skyLST(new Date(' + when + '), -122.4194), 37.7749)');
const eph = run('_skyEphemeris(new Date(' + when + '), 37.7749, -122.4194)');
const sirius = eph.stars.find((s) => s.idx === 41);
const sirB = run('_skyAltAzOf(__M2, ' + JSON.stringify(Array.from(stars.vec.slice(0, 3))) + ')');
check(sirius && Math.abs(sirius.alt - sirB.alt) < 0.3 && Math.abs(((sirius.az - sirB.az + 540) % 360) - 180) < 0.3,
  'the catalogue\'s Sirius and the sky\'s own agree to 0.3 deg (' + (sirius ? sirius.alt.toFixed(2) : '-') + ' vs ' + sirB.alt.toFixed(2) + ')');

// ── 3. How bright the sky is ──
const lum = (sun, moonAlt = -90, illum = 0, dial = 0) => run('_sgSkyLum(' + [sun, moonAlt, illum, dial] + ')');
const lm = (sun, moonAlt, illum, dial) => run('_sgLimitMag(' + lum(sun, moonAlt, illum, dial) + ')');
check(Math.abs(lm(-40) - 7.6) < 0.05, 'a dark site on a moonless night shows to magnitude 7.6 (' + lm(-40).toFixed(2) + ')');
check(lm(-6) > 0.5 && lm(-6) < 2.5, 'at the end of civil twilight only the brightest stars (' + lm(-6).toFixed(1) + ')');
check(lm(-12) > 3 && lm(-12) < 5, 'nautical twilight: the constellations (' + lm(-12).toFixed(1) + ')');
check(lm(-18) > 6.3 && lm(-18) < 7.5, 'astronomical twilight: nearly all (' + lm(-18).toFixed(1) + ')');
check(lm(20) < -3 && lm(20) > -4.6, 'by day only Venus can be seen (' + lm(20).toFixed(1) + ')');
let down = true;
for (let a = 30; a > -30; a -= 2) if (lm(a - 2) < lm(a)) down = false;
check(down, 'the faintest star only improves as the Sun sinks');
const moonLm = lm(-40, 60, 100, 0);
check(moonLm > 4.6 && moonLm < 6.3 && lm(-40) - moonLm > 1.4, 'a full Moon high up costs about two magnitudes (' + moonLm.toFixed(1) + ')');
check(lm(-40, 60, 5, 0) > moonLm + 1, 'a thin crescent costs far less');
check(lm(-40, -20, 100, 0) === lm(-40), 'a Moon below the horizon costs nothing');
check(lm(-40, -90, 0, 1) > 3.4 && lm(-40, -90, 0, 1) < 5.4 && lm(-40, -90, 0, 0.5) < lm(-40) && lm(-40, -90, 0, 0.5) > lm(-40, -90, 0, 1), 'a city dial 1 shows 4 to 5 magnitudes, half way between (' + lm(-40, -90, 0, 1).toFixed(1) + ')');

const vis = (m, l) => run('_sgStarVisibility(' + m + ', ' + l + ')');
check(vis(7.6, 7.6) === 0 && vis(8, 7.6) === 0, 'a star at the limit is not shown');
check(vis(7.2, 7.6) > 0.02 && vis(7.2, 7.6) < 0.25, 'one just inside it is a faint point');
check(vis(3, 7.6) > 0.99 && vis(-1, 7.6) === 1, 'bright stars are at full strength');
let up = true;
for (let m = 7.5; m > 2; m -= 0.25) if (vis(m - 0.25, 7.6) < vis(m, 7.6)) up = false;
check(up, 'each magnitude brighter is brighter');
check(Math.abs(vis(5.6, 7.6) / vis(6.6, 7.6) - 1.58) < 0.25, 'by about the eye\'s 1.6 times a magnitude');

const lux = (illum, d) => run('_sgMoonLux(' + illum + ', ' + d + ')');
check(lux(100, 384400) > 0.2 && lux(100, 384400) < 0.32, 'a full Moon lights the ground to a quarter of a lux (' + lux(100, 384400).toFixed(3) + ')');
check(lux(50, 384400) > 0.015 && lux(50, 384400) < 0.04, 'a quarter Moon to a thirtieth (' + lux(50, 384400).toFixed(3) + ')');
check(lux(100, 356400) > 1.15 * lux(100, 384400), 'a perigee full Moon is brighter');

const tau = run('_sgZenithOpticalDepth()');
check(tau[0] > 0.05 && tau[0] < 0.09 && tau[1] > 0.12 && tau[1] < 0.18 && tau[2] > 0.25 && tau[2] < 0.32, 'straight up the air is 0.07, 0.15, 0.28 deep in red, green, blue (' + tau.map((x) => x.toFixed(3)).join(', ') + ')');
const expo = (s, ma, il, d) => run('_sgExposure(' + [s, ma, il, d] + ')');
check(expo(-40, -90, 0, 0) > 10 * expo(0, -90, 0, 0) && expo(0, -90, 0, 0) > 3 * expo(40, -90, 0, 0), 'the eye adapts: far more gain at night than at noon');
const floorShown = 1 - Math.exp(-run('SG_DARK_SKY_LUM') * expo(-40, -90, 0, 0));
check(floorShown > 0.002 && floorShown < 0.01, 'but a dark night stays dark on the display (' + floorShown.toFixed(4) + ' linear)');
const skyShown = 1 - Math.exp(-run('_sgZenithLum(40)') * expo(40, -90, 0, 0));
check(skyShown > 0.4 && skyShown < 0.9, 'and a noon sky is not blown out (' + skyShown.toFixed(2) + ')');

// ── 4. Zodiacal light and airglow ──
const zl = (e, b) => run('_sgZodiLum(' + e + ', ' + b + ')');
check(zl(30, 0) > 3 * zl(90, 0) && zl(90, 0) > zl(150, 0), 'the zodiacal light is brightest near the Sun and fades away from it');
check(zl(30, 0) > 5 * zl(30, 30) && zl(180, 0) > 1e-5, 'and keeps to the ecliptic, with a faint gegenschein opposite the Sun');
check(zl(30, 0) < 5e-3 && zl(30, 0) > 5e-4, 'at the level of a hundredth of the twilight sky (' + zl(30, 0).toExponential(1) + ' cd/m2)');
const ag = (a) => run('_sgAirglow(' + a + ')');
check(ag(12) > 1.8 * ag(90) && ag(0.5) < ag(12), 'the airglow is thickest some 10 degrees up, thinned by the air at the horizon');

// ── 5. The view ──
function viewState(lens) {
  S.__s = { W: 1170, H: 900, dpr: 3, lat: 37.77, span: 240, center: 180, lens: null };
  if (lens) S.__s.lens = run('_skyMakeLens(' + JSON.stringify(lens) + ', 1170)');
  return S.__s;
}
const POINTS = [[180, 30], [215, 12], [140, 55], [250, 35], [262, 40], [300, 20], [30, 60], [180, 5], [240, 30], [255, 38], [270, 45], [245, 25], [10, 75], [90, 70], [200, 85]];
for (const [name, lens] of [['panorama', null], ['lens', { az: 250, alt: 35, fov: 70 }], ['wide lens', { az: 10, alt: 80, fov: 140 }]]) {
  viewState(lens);
  let worst = 0, n = 0;
  for (const [az, alt] of POINTS) {
    const p = run('_skyScreen(__s, ' + az + ', ' + alt + ')');
    if (!p.visible) continue;
    n++;
    const back = run('_skyDirAt(__s, ' + p.x + ', ' + p.y + ')');
    worst = Math.max(worst, Math.abs(((back.az - az + 540) % 360) - 180), Math.abs(back.alt - alt));
  }
  check(n >= 3 && worst < 1e-6, 'the ' + name + ' maps a direction to a pixel and back (' + n + ' points, worst ' + worst.toExponential(1) + ' deg)');
}
viewState({ az: 250, alt: 35, fov: 70 });
const centre = run('_skyScreen(__s, 250, 35)');
check(Math.abs(centre.x - 585) < 1e-6 && Math.abs(centre.y - 450) < 1e-6, 'the lens puts its direction at the centre of the canvas');
const edge = run('_skyScreen(__s, 250 + 35 / Math.cos(35 * Math.PI / 180) * 0.99, 35)');
check(edge.x > 1000 && edge.x < 1170, 'and half the field of view along the horizon lands near the right edge');
check(run('_skyScreen(__s, 70, -35).visible') === false, 'behind the view is not visible');

// The look-around adapter other views mount: its four calls, and the pinch's range.
check(['mount', 'setView', 'unmount', 'resize'].every((k) => run('typeof window.AlmanacSkyView.' + k) === 'function'), 'AlmanacSkyView has mount, setView, unmount and resize');
check(run('SKY_LENS_FOV[0]') <= 20 && run('SKY_LENS_FOV[1]') >= 120, 'and takes the lens\'s field of view, which holds the 20 to 120 degrees of a pinch');
check(run('AlmanacSkyView.mount(null, { lat: 1, lon: 1 })') === false, 'a host that is not there is refused, not thrown at');
check(['setTimeout', 'requestAnimationFrame'].every((f) => !new RegExp(f).test(read('almanac-sky.js').slice(read('almanac-sky.js').indexOf('var AlmanacSkyView'), read('almanac-sky.js').indexOf('var ZimiSky')))), 'and its code asks for no timer and no frame');

// ── 6. On demand ──
viewState(null);
S.__s.paintedTime = Date.UTC(2026, 9, 14);
const drift = (sec) => run('_skyDriftPx(__s, ' + (Date.UTC(2026, 9, 14) + sec * 1000) + ')');
check(drift(30) < 1 && drift(60) > 1 && drift(0) === 0, 'at three pixels a degree the sky takes ' + (1 / (drift(60))).toFixed(2) + ' minutes to turn a pixel; 30 s is not worth a frame (' + drift(30).toFixed(2) + ' px)');
viewState({ az: 180, alt: 30, fov: 20 });
S.__s.paintedTime = Date.UTC(2026, 9, 14);
check(run('_skyDriftPx(__s, ' + (Date.UTC(2026, 9, 14) + 30000) + ')') > 1, 'zoomed to 20 degrees a half minute does (' + run('_skyDriftPx(__s, ' + (Date.UTC(2026, 9, 14) + 30000) + ')').toFixed(2) + ' px)');
S.__s.paintedTime = null;
check(run('_skyDriftPx(__s, 5)') === Infinity, 'an unpainted sky always needs painting');

// ── 7. The Earth's shadow on the Moon ──
const ecl = (iso) => { S.__d = new Date(iso); return run('_skyEclipse(__d)'); };
for (const [iso, mag, label] of [['2025-03-14T06:58:36Z', 1.1804, 'March 2025'], ['2025-09-07T18:11:47Z', 1.3647, 'September 2025'], ['2026-03-03T11:33:46Z', 1.1507, 'March 2026']]) {
  const e = ecl(iso);
  check(e && Math.abs(e.umbralMag - mag) < 0.06, 'the ' + label + ' total lunar eclipse: umbral magnitude ' + (e ? e.umbralMag.toFixed(3) : 'none') + ' against NASA\'s ' + mag);
}
check(ecl('2025-04-13T00:22:00Z') === null && ecl('2026-10-26T04:12:00Z') === null, 'a full Moon with no eclipse is nowhere near the shadow');
const partial = ecl('2026-08-28T04:13:00Z');
check(partial && partial.umbralMag > 0.8 && partial.umbralMag < 1.0, 'August 2026 is a deep partial (' + (partial ? partial.umbralMag.toFixed(2) : 'none') + ', NASA 0.93)');
const before = ecl('2025-03-14T04:00:00Z'), mid = ecl('2025-03-14T06:58:36Z');
check(before.umbralMag < 0.01 && before.penumbralMag > 0 && mid.sep < 0.5, 'the Moon enters the penumbra hours before the umbra, and crosses the centre at greatest eclipse');

// The Sun's disc covered by the Moon's: the area of two overlapping circles, and the eclipse of 8 April 2024 in Dallas
// (NASA: partial from 17:23 UT, totality 18:40:50 to 18:44:39 UT, greatest at 18:42:45 UT).
const ov = (d, r1, r2) => run('_skyCircleOverlap(' + [d, r1, r2] + ')');
check(ov(0, 1, 1) === 1 && ov(3, 1, 1) === 0 && Math.abs(ov(0, 1, 0.5) - 0.25) < 1e-12 && ov(0, 1, 1.1) === 1, 'two circles: the same place is all, apart is none, a smaller one inside is its share of the area');
check(Math.abs(ov(1, 1, 1) - (2 * Math.acos(0.5) - 0.5 * Math.sqrt(3)) / Math.PI * 1) < 1e-9, 'and the lens between two unit circles one apart is 39% of one');
const obsc = (iso) => { S.__d = new Date(iso); S.__s = { eph: run('_skyEphemeris(__d, 32.7767, -96.797)'), now: S.__d }; return run('_skySolarObscuration(__s)'); };
const o1 = obsc('2024-04-08T17:15:00Z'), o2 = obsc('2024-04-08T18:00:00Z'), o3 = obsc('2024-04-08T18:30:00Z'), o4 = obsc('2024-04-08T18:42:45Z'), o5 = obsc('2024-04-08T19:30:00Z');
check(o1 === 0 && o2 > 0.2 && o3 > o2 && o4 > 0.85 && o5 < o3, 'over Dallas the Moon covers the Sun more and more until the middle of the eclipse and then less (' + [o1, o2, o3, o4, o5].map((x) => x.toFixed(2)).join(', ') + ')');
check(run('_sgSunShare(0)') === 1 && run('_sgSunShare(1)') === run('SG_SUN_SHARE_MIN') && run('_sgSunShare(0.5)') === 0.5, 'and its share of the Sun\'s light falls with it, to a few thousandths in totality');
check(run('_sgLimitMag(_sgSkyLum(60, -90, 0, 0, 0.003))') > 0 && run('_sgLimitMag(_sgSkyLum(60, -90, 0, 0, 1))') < -3, 'so in totality the planets and bright stars come out in a midday sky');

// ── Planet phases and sizes, against Horizons (QUANTITIES 9, 10, 13, 2026-10-14 00:00 UT, airless geocentre-ish) ──
// Illuminated fraction (%) and angular diameter (arcsec): Mercury 58.36, 6.90; Venus 4.36, 57.49; Mars 89.95, 5.96; Jupiter 99.35, 34.24; Saturn 99.99, 19.67.
{
  S.__d = new Date('2026-10-14T00:00:00Z');
  const pl = run('_skyEphemeris(__d, 37.7749, -122.4194)').planets;
  const by = (n) => pl.find((x) => x.name === n);
  for (const [n, illu, diam] of [['Mercury', 58.36, 6.90], ['Venus', 4.36, 57.49], ['Mars', 89.95, 5.96], ['Jupiter', 99.35, 34.24], ['Saturn', 99.99, 19.67]]) {
    const p = by(n);
    check(Math.abs(p.phase * 100 - illu) < 1.5 && Math.abs(p.semi * 2 * 3600 - diam) < 0.05 * diam + 0.2,
      n + ' is ' + (p.phase * 100).toFixed(1) + '% lit and ' + (p.semi * 7200).toFixed(1) + '" across (Horizons ' + illu + '%, ' + diam + '")');
  }
}

// Apparent magnitudes (Horizons QUANTITIES 9, APmag) against Mallama and Hilton's formulae, where the old lit-share rule was off by 2 to 4 for Mercury.
{
  const refs = [['2026-10-14', { Mercury: 0.046, Venus: -4.350, Mars: 1.032, Jupiter: -1.918 }], ['2026-06-15', { Mercury: 0.466, Venus: -3.999, Mars: 1.337, Jupiter: -1.841 }],
    ['2027-01-20', { Mercury: -1.036, Venus: -4.373, Mars: -0.638, Jupiter: -2.512 }], ['2026-03-03', { Mercury: 3.074, Venus: -3.900, Mars: 1.109, Jupiter: -2.424 }]];
  let worst = 0, worstWhat = '';
  for (const [day, mags] of refs) {
    S.__d = new Date(day + 'T00:00:00Z');
    const pl = run('_skyEphemeris(__d, 37.7749, -122.4194)').planets;
    for (const [n, ref] of Object.entries(mags)) {
      const d = Math.abs(pl.find((x) => x.name === n).mag - ref);
      if (d > worst) { worst = d; worstWhat = n + ' ' + day; }
    }
  }
  check(worst < 0.25, 'Mercury, Venus, Mars and Jupiter at four dates: magnitudes within 0.25 of Horizons (worst ' + worst.toFixed(2) + ', ' + worstWhat + ')');
}

// Totality over Dallas on 2024-04-08 (NASA: second contact about 18:40:50 UT, third about 18:44:38): the Moon, from the place (topocentric
// radius and parallax), covers the Sun entirely between them, and the sky goes to deep twilight.
{
  const at = (sec) => { S.__d = new Date(Date.UTC(2024, 3, 8, 18, 0, 0) + sec * 1000); S.__s = { eph: run('_skyEphemeris(__d, 32.7767, -96.797)'), now: S.__d }; return run('_skySolarObscuration(__s)'); };
  let first = null, last = null;
  for (let sec = 38 * 60; sec <= 47 * 60; sec += 5) if (at(sec) >= 0.9999) { if (first === null) first = sec; last = sec; }
  const secOf = (m, s) => m * 60 + s;
  check(first !== null && Math.abs(first - secOf(40, 50)) <= 60 && Math.abs(last - secOf(44, 38)) <= 60,
    'the Moon covers the Sun from 18:' + (first === null ? '-' : Math.floor(first / 60) + ':' + (first % 60)) + ' to 18:' + (last === null ? '-' : Math.floor(last / 60) + ':' + (last % 60)) + ': within a minute of NASA\'s contacts');
  check(at(secOf(42, 45)) === 1 && at(secOf(30, 0)) > 0.8 && at(secOf(30, 0)) < 0.87 && at(secOf(20, 0)) < at(secOf(30, 0)), 'whole at the middle, 84% at 18:30 (Horizons 0.843), growing before');
  const share = run('_sgSunShare(1)');
  const lmTot = run('_sgLimitMag(_sgSkyLum(60, -90, 0, 0, ' + share + '))');
  check(lmTot > -2 && lmTot < 3 && lmTot > run('_sgLimitMag(_sgSkyLum(60, -90, 0, 0, 1))') + 3,
    'and in totality the sky is a deep twilight, as at the end of civil twilight: Venus and Jupiter are out, stars to magnitude ' + lmTot.toFixed(1));
}
// A lunar eclipse takes the Moon's light too: the sky in totality is the darkest of the month (NASA: total 2026-03-03, 11:04 to 12:03 UT).
{
  S.__d = new Date('2026-03-03T11:34:00Z');
  const ec = run('_skyEclipse(__d)');
  const sh = run('_sgMoonShare(' + JSON.stringify({ umbralMag: ec.umbralMag, penumbralMag: ec.penumbralMag }) + ')');
  check(run('_sgMoonShare(null)') === 1 && sh <= run('SG_UMBRA_RESIDUE') * 1.0001, 'in totality only the umbra\'s copper residue of the Moon\'s light is left (' + sh + ')');
  const full = run('_sgLimitMag(_sgSkyLum(-40, 55, 100, 0, 1, 1))'), tot = run('_sgLimitMag(_sgSkyLum(-40, 55, 100, 0, 1, ' + sh + '))');
  check(tot > full + 1.5 && tot > 7, 'so the stars come back, from magnitude ' + full.toFixed(1) + ' to ' + tot.toFixed(1));
  check(run('_sgMoonShare({ umbralMag: 0.5, penumbralMag: 1.5 })') > 0.2 && run('_sgMoonShare({ umbralMag: 0.5, penumbralMag: 1.5 })') < 0.4 && run('_sgMoonShare({ umbralMag: -0.2, penumbralMag: 0.4 })') > 0.8,
    'a partial eclipse takes about half the light, the penumbra a little');
}
// A full Moon night at Dallas (2026-10-26): the stars the sky shows are hundreds, not forty.
{
  const lm = run('_sgLimitMag(_sgSkyLum(-40, 74, 99.8, 0, 1, 1))'), st = run('_sgDecodeStars(__buf)');
  let up = 0;
  for (let i = 0; i < st.n; i++) if (st.mag[i] < lm) up++;
  check(lm > 5 && lm < 6.2 && up > 1000, 'a full-Moon sky shows to magnitude ' + lm.toFixed(1) + ': ' + up + ' stars of the catalogue are brighter than that (half above the horizon)');
  const dark = 1 - Math.exp(-run('_sgMoonSkyLum(74, 99.8)') * run('_sgExposure(-40, 74, 99.8, 0, 1, 1)'));
  check(dark > 0.01 && dark < 0.06, 'and the display holds it as a dark bluish sky (' + dark.toFixed(3) + ' linear, ' + Math.round(255 * Math.pow(dark, 1 / 2.2)) + ' of 255), not a twilight');
}

// ── Constellation lines ──
{
  const al = (lm, mag, dark) => run('_skyLineAlpha(' + [lm, mag, dark === undefined ? 1 : dark] + ')');
  check(run('SKY_SETTING_DEFAULTS.lines') === 'off', 'a real sky has no lines: the default is none');
  check(al(7.6, 1) > al(5.4, 1) && al(5.4, 1) > al(4, 1) && al(4, 1) > 0 && al(2.9, 1) === 0, 'a figure fades with how many stars the sky shows: none over a sky with no stars (' + [7.6, 5.4, 4, 2.9].map((x) => al(x, 1).toFixed(3)).join(', ') + ')');
  check(al(7.6, 4.5) < 0.25 * al(7.6, 1.5) && al(7.6, 1.5) === al(7.6, 0.5) && al(7.6, 1, 0) === 0, 'and by its own brightest star: Orion shows first, Microscopium barely, nothing in daylight');
  S.__s0 = null;
  run('_skyState = { reveal: null, baseDirty: false, eph: null, canvas: null }; _skyKick = function () {}');
  check(run('_skyFiguresWanted(_skyState)') === false, 'no figures wanted until one is asked for');
  run("_skyRevealFigure('Ori')");
  check(run('_skyState.reveal') === 'Ori' && run('_skyFiguresWanted(_skyState)') === true && run('_skyState.baseDirty') === true, 'a tap on a bright star asks for its figure');
}

// ── A guessed place ──
{
  const chi = run("_skyZonePlace('America/Chicago')");
  check(chi && Math.abs(chi[0] - 41.88) < 0.1 && Math.abs(chi[1] + 87.63) < 0.1 && run("_skyZonePlace('Nowhere/Land')") === null, 'a time zone stands for its city (Chicago: 41.9 N, 87.6 W)');
  const f = run('_skyFactsAt(' + Date.parse('2026-10-14T08:00:00Z') + ', ' + chi[0] + ', ' + chi[1] + ')');
  check(Math.abs(f.sunrise - Date.parse('2026-10-14T12:01:55Z')) < 120000, 'and its sunrise is Chicago\'s (Horizons 12:01:55 UT, off ' + (Math.abs(f.sunrise - Date.parse('2026-10-14T12:01:55Z')) / 1000).toFixed(0) + ' s), not an Atlantic guess an hour early');
}
// A time zone outside the curated cities still stands for its own city, in its own hemisphere (zone.tab); one nobody knows stands for none.
{
  const z = (n) => run("_skyZonePlace('" + n + "')");
  const wh = z('Africa/Windhoek'), mn = z('America/Manaus'), sy = z('Australia/Sydney'), rk = z('Atlantic/Reykjavik');
  check(wh && wh[0] < -20 && wh[0] > -23 && Math.abs(wh[1] - 17.1) < 0.5, 'Windhoek is 22.6 S, 17.1 E, not 34 N (' + wh + ')');
  check(mn && mn[0] < 0 && mn[0] > -4 && Math.abs(mn[1] + 60) < 1, 'Manaus is 3.1 S, 60 W (' + mn + ')');
  check(sy && sy[0] < -33 && rk && rk[0] > 64 && rk[0] < 65, 'Sydney south, Reykjavik at 64 N');
  check(run("_skyZonePlace('Etc/UTC')") === null && run("_skyZonePlace('Mars/Olympus')") === null && run('_skyZonePlace(null)') === null, 'UTC and a zone nobody has: no place');
  check(run("_skyZonePlace('America/Buenos_Aires')")[0] < -30 && run("_skyZonePlace('Asia/Calcutta')") !== null, 'link names stand for the zone they link to');
  const keys = run("Object.keys(SKY_ZONE_GENERATED).length");
  check(keys > 450, 'the table has every zone.tab zone and its links (' + keys + ')');
  const rows = (known) => { S.__ms = Date.parse('2026-10-14T20:00:00Z'); S.__s = { lat: 34, lon: 0, nowTime: S.__ms, stored: false, known: known, moonData: { phase: { illumination: 20 } } }; S.__f = run('_skyFactsAt(__ms, 34, 0)'); return run('_skyFactRows(__s, __f)'); };
  // Four cards, two by two, under the Moon's eight (Eric, 2026-10-18); where north is, Look and the chart show.
  check(rows(false).length === 4 && rows(true).length === 4, 'four cards, guessed or known');
  check(!rows(true).some((r) => /alm_sky_f_(north|south)/.test(r[0])), 'no north card under the Moon');
}
// Guessed times round the way that does no harm, and add up (Sydney, 18:50 local, sunset 19:07).
{
  const now = Date.parse('2026-10-14T07:50:00Z'), f = run('_skyFactsAt(' + now + ', -33.87, 151.21)');
  const down = run('_skyRoundMs(' + f.sunset + ', true, -1)'), up = run('_skyRoundMs(' + f.sunset + ', true, 1)');
  check(down <= f.sunset && f.sunset - down < 15 * 60000 && up >= f.sunset && up - f.sunset < 15 * 60000, 'daylight left rounds down, never past the Sun');
  check(run('_skyRoundMs(' + f.sunset + ', false, -1)') === f.sunset, 'a known place is not rounded at all');
  const left = Math.floor((down - now) / 60000);
  check(run('_orrFmtSpan(' + (down - now) / 1000 + ')') === run('_skySpan(' + f.sunset + ', ' + now + ', true, -1)'), 'and the row says that span (' + left + ' min of ' + Math.round((f.sunset - now) / 60000) + ' real)');
  const soon = f.sunset - 3 * 60000, fs = run('_skyFactsAt(' + soon + ', -33.87, 151.21)');
  S.__s = { lat: -33.87, lon: 151.21, nowTime: soon, stored: false, known: true, moonData: { phase: { illumination: 20 } } }; S.__f = fs;
  check(run('_skyFactRows(__s, __f)')[0][1] === 'alm_sky_f_under_step', 'three minutes of light left, guessed: "under 15 min", not 0 sec');
  const darkUntil = Date.parse('2026-10-13T19:07:00Z');
  check(run('_skyRoundMs(' + (darkUntil + 7 * 60000) + ', true, 1)') >= darkUntil + 7 * 60000, 'dark until rounds up');
}
// ── Names on the look-around sky ──
{
  const plan = (bodies) => { S.__s = { dpr: 2, W: 780, H: 1688, bodies: bodies }; return run('_skyLabelPlan(__s, (t) => t.length * 14)'); };
  const body = (type, x, y, extra) => Object.assign({ type: type, x: x, y: y, r: 6, mag: 0 }, extra || {});
  let p = plan([body('sun', 100, 300), body('moon', 200, 500), body('planet', 150, 420, { name: 'Mars', mag: 1 }), body('star', 300, 600, { idx: 41, mag: -1.4 }), body('star', 50, 700, { idx: -1, mag: 1 }), body('star', 120, 900, { idx: 50, mag: 5 })]);
  const names = p.map((l) => l.text);
  check(names.some((n) => /alm_sun/.test(n)) && names.some((n) => /alm_moon/.test(n)) && names.includes('Mars') && names.includes('Sirius'), 'the Sun, the Moon, a planet and a bright named star are named (' + names.join(', ') + ')');
  check(!names.includes('Vega') && names.length === 4, 'a faint star and an unnamed one are not');
  check(p.every((l) => l.box.x0 >= 16 && l.box.x1 <= 780 - 16), 'every label stays inside the screen');
  p = plan([body('planet', 190, 400, { name: 'Venus', mag: -4 }), body('planet', 192, 405, { name: 'Jupiter', mag: -2 })]);
  check(p.length >= 1 && (p.length === 1 || !(p[0].box.x0 < p[1].box.x1 && p[0].box.x1 > p[1].box.x0 && p[0].box.y0 < p[1].box.y1 && p[0].box.y1 > p[1].box.y0)), 'two bodies close together do not have their names on top of each other');
  p = plan([body('planet', 192, 20, { name: 'Venus', mag: -4 }), body('planet', 385, 600, { name: 'Saturn', mag: 0.5 })]);
  check(p.length === 1 && /Saturn/.test(p[0].text) && p[0].box.x1 <= 780 - 16, 'under the readout there is none, and one near the right edge goes to the left of its dot');
}
// ── The rows: bearings, and a guess says so in the row ──
{
  const rowsOf = (stored) => {
    S.__ms = Date.parse('2026-10-14T20:00:00Z');
    S.__s = { lat: 37.7749, lon: -122.4194, nowTime: S.__ms, stored: stored, moonData: { phase: { illumination: 20 } } };
    S.__f = run('_skyFactsAt(__ms, 37.7749, -122.4194)');
    return run('_skyFactRows(__s, __f)');
  };
  const f = run('_skyFactsAt(' + Date.parse('2026-10-14T20:00:00Z') + ', 37.7749, -122.4194)');
  check(Math.abs(f.sunsetAz - 259.9) < 1.2 && f.sunriseAz > 80 && f.sunriseAz < 110, 'the Sun sets at bearing ' + f.sunsetAz.toFixed(1) + ' (Horizons 259.9) and rises in the east');
  const known = rowsOf(true), guessed = rowsOf(false);
  const moonRow = known.find((r) => r[3] === 'moon');
  check(known.every((r) => !r[2]) && /^tb_moon(rise|set)$/.test(moonRow[0]) && !/alm_sky_f_about/.test(moonRow[1]) && !known.some((r) => /alm_sky_f_about/.test(r.join(' '))), 'the cards carry no compass line, and the Moon card is two lines: MOONRISE or MOONSET, then the time: ' + JSON.stringify(moonRow));
  check(guessed.every((r) => /alm_sky_f_about/.test(r[1])), 'while the place is a guess the rows say so in themselves (about)');
}

// ── 8. Rising and setting, the time by the Sun ──
const ms = (iso) => Date.parse(iso);
const facts = (iso, lat, lon) => run('_skyFactsAt(' + ms(iso) + ', ' + lat + ', ' + lon + ')');
const sf = facts('2026-10-14T20:00:00Z', 37.7749, -122.4194);
const sfNight = facts('2026-10-14T08:00:00Z', 37.7749, -122.4194);
const secs = (a, iso) => Math.abs(a - ms(iso)) / 1000;
check(secs(sf.sunset, '2026-10-15T01:33:20Z') < 90, 'sunset in San Francisco within 90 s of Horizons (off ' + secs(sf.sunset, '2026-10-15T01:33:20Z').toFixed(0) + ' s)');
check(secs(sfNight.sunrise, '2026-10-14T14:17:20Z') < 90, 'sunrise within 90 s (off ' + secs(sfNight.sunrise, '2026-10-14T14:17:20Z').toFixed(0) + ' s)');
check(secs(sf.darkFrom, '2026-10-15T03:00:29Z') < 90, 'the end of astronomical twilight within 90 s (off ' + secs(sf.darkFrom, '2026-10-15T03:00:29Z').toFixed(0) + ' s)');
check(secs(sfNight.moonrise, '2026-10-14T18:34:02Z') < 150, 'moonrise within 150 s of Horizons (off ' + secs(sfNight.moonrise, '2026-10-14T18:34:02Z').toFixed(0) + ' s)');
check(sf.sunUp && !sf.fullyDark && sfNight.fullyDark && !sfNight.sunUp, 'daylight at noon, fully dark at 1 am');
check(sfNight.darkUntil > ms('2026-10-14T12:30:00Z') && sfNight.darkUntil < ms('2026-10-14T13:15:00Z'), 'dark until dawn\'s first light (about 5:50 am PDT)');
const tromso = facts('2026-06-21T10:00:00Z', 69.65, 18.96);
check(tromso.sunUp && tromso.sunset === null && tromso.darkFrom === null, 'in Tromso at midsummer the Sun stays up and the night never fully dark');
const sydney = facts('2026-10-14T00:00:00Z', -33.8688, 151.2093);
check(sydney.sunUp && sydney.sunset > ms('2026-10-14T08:00:00Z') && sydney.sunset < ms('2026-10-14T09:30:00Z'), 'Sydney\'s sunset is in the evening local time (UT+11)');
const sol = (iso, lon) => { S.__d = new Date(iso); return run('_skySolarMinutes(__d, ' + lon + ')'); };
check(Math.abs(sol('2026-10-01T12:00:00Z', 0) - (720 + 10.2)) < 0.6, 'at Greenwich on 1 October the Sun runs ten minutes ahead of the clock (' + (sol('2026-10-01T12:00:00Z', 0) - 720).toFixed(2) + ' min)');
check(Math.abs(sol('2026-10-01T12:00:00Z', 90) - sol('2026-10-01T12:00:00Z', 0) - 360) < 1e-6, 'and six hours ahead at 90 E');
const noon = run('_skySunAltAt(' + ms('2026-10-01T11:50:00Z') + ', 51.5, 0)'), later = run('_skySunAltAt(' + ms('2026-10-01T12:20:00Z') + ', 51.5, 0)'), earlier = run('_skySunAltAt(' + ms('2026-10-01T11:20:00Z') + ', 51.5, 0)');
check(noon > later && noon > earlier, 'and at that solar noon the Sun is at its highest');

// ── 10. The life on the horizon: judged against what a person on a beach would see ──
{
  const plane = (o) => Object.assign({ type: 'plane', theta: 180, dir: 1, b: 10, h: 10.7, L0: -50, L1: 50 }, o || {});
  const at = (a, p) => run('_skyPlaneAt(' + JSON.stringify(a) + ', ' + p + ')');
  const lights = (a, p) => run('_skyPlaneLights(' + JSON.stringify(a) + ', ' + JSON.stringify(at(a, p)) + ')');
  // An airliner's angular speed is its ground speed over its range: more than a degree a second as it passes close, a creep near the horizon.
  const speed = (a, p) => { const d = 0.001, q1 = at(a, p), q2 = at(a, p + d), km = Math.abs(a.L1 - a.L0) * d, rad = Math.hypot(((q2.az - q1.az + 540) % 360 - 180) * Math.cos(q1.alt * D2R), q2.alt - q1.alt) * D2R;
    return rad / (km / 0.25) * R2D; };   // degrees a second at 250 m/s
  const mid = plane(), mids = speed(mid, 0.5), edge = speed(mid, 0.02);
  check(mids > 0.9 && mids < 1.05, 'abeam at 10 km, 10.7 km up (range 14.6 km) it crosses ' + mids.toFixed(2) + ' deg a second: 250 m/s over that range');
  check(edge < mids / 4 && edge > 0.05, 'near the edge of sight it crawls (' + edge.toFixed(2) + ' deg a second)');
  check(Math.abs(at(mid, 0.5).alt - Math.atan2(10.7, 10) / D2R) < 1, 'its height at the nearest point is the angle of 10.7 km over 10 km (' + at(mid, 0.5).alt.toFixed(1) + ')');
  check(Math.abs(at(plane({ b: 5, L0: -49.7, L1: 49.7 }), 0).alt - 12) < 1, 'it is seen down to about 12 degrees, 50 km out (' + at(plane({ b: 5, L0: -49.7, L1: 49.7 }), 0).alt.toFixed(1) + ')');
  check(at(mid, 0.5).alt < at(plane({ b: 4 }), 0.5).alt, 'a track that passes nearer goes higher');
  // Wingtip lights: the side that faces the viewer, red from the plane's left. Heading west with the viewer to its north (on its right): green.
  const west = plane(), east = plane({ dir: -1 });
  check(lights(west, 0.5).green > 0.9 && lights(west, 0.5).red < 0.1, 'flying clockwise round the viewer (the viewer on its right) shows green');
  check(lights(east, 0.5).red > 0.9 && lights(east, 0.5).green < 0.1, 'flying the other way, red');
  check(lights(west, 0.99).tail > 0.9 && lights(west, 0.99).red < 0.05 && lights(west, 0.99).green < 0.05, 'going away it shows its steady white tail light only');
  check(lights(west, 0.0).tail < 0.1, 'coming toward the viewer it shows no tail light');
  const head = plane({ theta: 90, dir: 1, b: 0.001, L0: -40, L1: -39 }), hl = lights(head, 0);
  check(hl.red > 0.3 && hl.green > 0.3, 'dead ahead the two wingtip lights meet (' + hl.red.toFixed(2) + ', ' + hl.green.toFixed(2) + ')');
  check(Math.abs(run('_skyPulse(30, 1000, SKY_PLANE_STROBE_PULSES)') - 1) < 2 && run('_skyPulse(30, 1000, SKY_PLANE_STROBE_PULSES)') === true && run('_skyPulse(100, 1000, SKY_PLANE_STROBE_PULSES)') === false && run('_skyPulse(180, 1000, SKY_PLANE_STROBE_PULSES)') === true, 'the white strobe flashes twice a second');
  // Meteors at the rate this sky shows a patient eye, no speed-up.
  run('var _METEOR_SHOWERS = [{ key: "perseids", peak: [8, 12], zhr: 100 }, { key: "geminids", peak: [12, 14], zhr: 150 }, { key: "quadrantids", peak: [1, 3], zhr: 120 }];');
  const rate = (iso, lm, lat, lon) => { const ms = Date.parse(iso); S.__s = { nowTime: ms, lm: lm, lat: lat, lon: lon, eph: { lst: run('_skyLST(new Date(' + ms + '), ' + lon + ')') } }; return run('_skyMeteorRate(__s)'); };
  const quiet = rate('2026-03-10T09:00:00Z', 7.6, 37.77, -122.42), per = rate('2026-08-13T09:00:00Z', 7.6, 37.77, -122.42), perCity = rate('2026-08-13T09:00:00Z', 3.5, 37.77, -122.42);
  const eve = rate('2026-03-11T02:00:00Z', 7.6, 37.77, -122.42), dawn = rate('2026-03-10T13:00:00Z', 7.6, 37.77, -122.42);
check(quiet.perHour > 5 && quiet.perHour < 9 && !quiet.shower, 'a quiet dark night: the sporadic six or so an hour, no shower (' + quiet.perHour.toFixed(1) + ')');
check(dawn.perHour > 2.5 * eve.perHour && eve.perHour > 2 && dawn.perHour < 11, 'sporadics are three an hour at evening and about ten before dawn (' + eve.perHour.toFixed(1) + ', ' + dawn.perHour.toFixed(1) + ')');
  check(per.shower && per.shower.sh.key === 'perseids' && per.perHour > 20 && per.perHour < 60, 'the Perseids near their peak with the radiant up: a few dozen an hour (' + per.perHour.toFixed(1) + ')');
  check(perCity.perHour < per.perHour / 8 && perCity.perHour > 0, 'under a city sky (limiting magnitude 3.5) the same night shows an eighth or less (' + perCity.perHour.toFixed(1) + ')');
  check(!rate('2026-08-12T22:00:00Z', 7.6, -33.87, 151.21).shower || rate('2026-08-12T22:00:00Z', 7.6, -33.87, 151.21).perHour < per.perHour, 'a shower whose radiant is down adds nothing');
  const dec = rate('2026-12-14T11:00:00Z', 7.6, 37.77, -122.42);
  check(dec.shower && dec.shower.sh.key === 'geminids' && dec.perHour > 60, 'the Geminids from a northern place, up all night (' + dec.perHour.toFixed(0) + ')');
  check(run('_skyMeteorVisible(7.6)') === 1 && Math.abs(run('_skyMeteorVisible(4.5)') - Math.pow(2.5, -2)) < 1e-9, 'each magnitude lost thins them by the population index');
  // A shower's meteors fall away from its radiant.
  run('_skyRand = (function () { var i = 0, v = [0.5, 0.5, 0.5, 0.5]; return function () { return v[i++ % 4]; }; })();');
  S.__s = { center: 180, span: 240 };
  const m = run('_skyMeteor(__s, { radiant: { az: 180, alt: 20 } })');
  check(m.alt1 > m.alt0 && Math.abs(m.az1 - m.az0) < 1, 'overhead of a low radiant, a meteor streaks up and away from it (' + m.alt0.toFixed(0) + ' to ' + m.alt1.toFixed(0) + ')');
  const m2 = run('_skyMeteor(__s, { radiant: { az: 180, alt: 80 } })');
  check(m2.alt1 < m2.alt0, 'and from a high radiant, down and away');
  run('_skyRand = Math.random');
  // An airliner comes out of the haze at the horizon's edge and goes back into it; only the first, already flying, may be seen part-way along.
  run('_skyRand = (function () { var i = 0, v = [0.3, 0.6, 0.1, 0.9, 0.5, 0.2, 0.7, 0.4]; return function () { return v[i++ % 8]; }; })();');
  S.__s = { center: 180, span: 240 };
  const fresh = run('_skyPlane(__s, false)'), flying = run('_skyPlane(__s, true)');
  check(Math.abs(fresh.L0 + Math.sqrt(Math.pow(fresh.h / Math.tan(10 * D2R), 2) - fresh.b * fresh.b)) < 1e-6 && at(fresh, 0).alt < 11, 'a plane that comes later starts at the haze, ' + at(fresh, 0).alt.toFixed(1) + ' degrees up');
  check(flying.L0 > fresh.L0 && flying.L0 < 0 || at(flying, 0).alt > 11, 'the first one may already be flying');
  check(at(fresh, 0.999).alt < 11 && at(fresh, 0.5).alt > at(fresh, 0).alt, 'and leaves at the haze too');
  run('_skyRand = Math.random');
  // The palms stand clear of where the Sun sets and the Moon rises at the equinoxes (and the autumn evening at 38 N).
  check(run('SKY_PALMS.every(function (p) { return p[0] < 60 || p[0] > 285; })') === true, 'the palms stand at the edges of the picture, not under the setting Sun');
  // The sea mirrors the sky: a clear table, more at grazing sight.
  check(run('_skyTableAt(SKY_FRESNEL, 0)') > 0.8 && run('_skyTableAt(SKY_FRESNEL, 25)') < 0.15 && run('_skyTableAt(SKY_FRESNEL, 4)') > run('_skyTableAt(SKY_FRESNEL, 10)'), 'the sea mirrors nearly all of the sky at the horizon and little at the feet');
  // The boats show the lights the rules of the sea give them.
  check(run('SKY_BOATS.filter(function (b) { return b[3] === "sail"; })[0][1]') === 0, 'the sailing boat lies at anchor and does not drift');
  check(run('SKY_BOATS.every(function (b) { return b[1] < 90; })') === true, 'no boat swings faster than a ship at speed some kilometres out');
}

// ── 9. The data files ──
const lines = JSON.parse(fs.readFileSync(path.join(STATIC, 'earth', 'constellations-v1.json'), 'utf8'));
check(lines.v === 1 && lines.c.length === 88, 'the 88 IAU constellations');
check(lines.c.every((c) => c[5].length > 0 && c[5].every((run2) => run2.length % 2 === 0 && run2.length >= 4)), 'each has a figure of at least one line');
check(lines.c.every((c) => c[5].every((run2) => run2.every((x, i) => (i % 2 === 0 ? x >= 0 && x < 360 : Math.abs(x) <= 90)))), 'on the sphere');
const names = lines.c.map((c) => c[1]);
check(['Orion', 'Crux', 'Ursa Major', 'Cassiopeia', 'Scorpius', 'Sagittarius'].every((n) => names.includes(n)), 'including Orion, the Southern Cross and the Big Dipper\'s Ursa Major');
const crux = lines.c.find((c) => c[0] === 'Cru');
check(crux[5].flat().length >= 8 && crux[3] > 175 && crux[3] < 195 && crux[4] < -55 && crux[4] > -65, 'the Southern Cross stands at RA 187, Dec -60');
check(fs.statSync(path.join(STATIC, 'earth', 'constellations-v1.json')).size < 30000, 'in under 30 KB');
const mw = fs.statSync(path.join(STATIC, 'earth', 'milkyway-v1.webp')).size;
check(mw > 20000 && mw < 300000, 'the Milky Way panorama is ' + Math.round(mw / 1024) + ' KB, under 300');
const head = fs.readFileSync(path.join(STATIC, 'earth', 'milkyway-v1.webp')).subarray(0, 30);
check(head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP', 'and a WebP');
const sources = read('earth/SOURCES.txt');
check(/milkyway-v1\.webp/.test(sources) && /ESO/.test(sources) && /Brunier/.test(sources) && /CC BY 4\.0/.test(sources) && /eso0932a/.test(sources), 'the panorama is credited to ESO and S. Brunier under CC BY 4.0');
check(/constellations-v1\.json/.test(sources) && /d3-celestial/.test(sources) && /BSD/.test(sources) && /Stellarium/.test(sources), 'the constellation lines are credited, and Stellarium\'s data is said not to be used');

done();
