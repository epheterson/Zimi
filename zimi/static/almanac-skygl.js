// ── Almanac: the physical sky ──
// The light of the real sky at a place and an instant, drawn in WebGL2: the
// air's own colour (Hillaire 2020's model, computed here on the GPU, nothing
// downloaded), the Milky Way as photographed (ESO / S. Brunier), the 9,096
// stars of the Bright Star Catalogue with their true colours, the zodiacal
// light and the airglow. almanac-sky.js owns the scene and the page's clock;
// this file turns one instant's numbers into pixels, and holds the pure
// astronomy the pixels need (star colour, the galactic frame, how bright the
// sky is and so how faint a star shows), each tested on its own in
// tests/test_almanac_sky_physical.cjs.
//
// The Canvas 2D sky in almanac-sky.js is the fallback: _sgInit() returns
// false where WebGL2 or floating-point targets are missing, and nothing here
// then runs. Loaded after almanac-sky.js's own file, before almanac.js.

// ══ Pure: what colour, which way, how bright ═════════════════════════════

var SG_EXTINCTION_MAG = 0.2;                             // magnitudes a star loses per airmass beyond the zenith's
var SG_STARS_URL = '/static/earth/stars-v1.bin';          // scripts/build_star_catalog.py documents the format
var SG_NAMES_URL = '/static/earth/stars-names-v1.json';   // the bright stars' designations, from scripts/build_star_catalog.py
var SG_MILKYWAY_URL = '/static/earth/milkyway-v1.webp';   // ESO / S. Brunier, galactic coordinates, stars removed
var SG_STARS_HEADER_BYTES = 4, SG_STARS_VERSION = 1, SG_STARS_BYTES_EACH = 6;
var SG_STARS_U16_STEPS = 65536, SG_STARS_U16_MAX = 65535;
var SG_STARS_MAG_OFFSET = 2, SG_STARS_MAG_SCALE = 25;
var SG_STARS_BV_SCALE = 50, SG_STARS_BV_NONE = -128;
var SG_STAR_BV_DEFAULT = 0.6;                             // where the catalogue has no B-V (the Sun's is 0.65)

// A star's temperature from its B-V colour index (Ballesteros 2012), kelvin.
var SG_TEMP_MIN = 1700, SG_TEMP_MAX = 25000;
function _sgBvToKelvin(bv) {
  var T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  return Math.max(SG_TEMP_MIN, Math.min(SG_TEMP_MAX, T));
}
// Linear sRGB of a blackbody, its brightest channel 1. The Planckian locus
// as Kim et al. (2002) fit it in CIE xy, then XYZ to sRGB.
function _sgKelvinToRGB(T) {
  var T2 = T * T, T3 = T2 * T, x, y;
  if (T <= 4000) x = -0.2661239e9 / T3 - 0.2343589e6 / T2 + 0.8776956e3 / T + 0.179910;
  else x = -3.0258469e9 / T3 + 2.1070379e6 / T2 + 0.2226347e3 / T + 0.240390;
  if (T <= 2222) y = -1.1063814 * x * x * x - 1.34811020 * x * x + 2.18555832 * x - 0.20219683;
  else if (T <= 4000) y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x * x * x - 5.87338670 * x * x + 3.75112997 * x - 0.37001483;
  var X = x / y, Z = (1 - x - y) / y;
  var r = 3.2406 * X - 1.5372 - 0.4986 * Z, g = -0.9689 * X + 1.8758 + 0.0415 * Z, b = 0.0557 * X - 0.2040 + 1.0570 * Z;
  r = Math.max(r, 0); g = Math.max(g, 0); b = Math.max(b, 0);
  var top = Math.max(r, g, b);
  return [r / top, g / top, b / top];
}
function _sgBvToRGB(bv) { return _sgKelvinToRGB(_sgBvToKelvin(bv)); }

// stars-v1.bin as typed arrays and J2000 unit vectors; null if the bytes are
// not this format. The catalogue is brightest first.
function _sgDecodeStars(buf) {
  if (!buf || buf.byteLength < SG_STARS_HEADER_BYTES) return null;
  var head = new Uint16Array(buf.slice(0, SG_STARS_HEADER_BYTES)), n = head[0];
  if (head[1] !== SG_STARS_VERSION || buf.byteLength !== SG_STARS_HEADER_BYTES + SG_STARS_BYTES_EACH * n) return null;
  var ra = new Uint16Array(buf, SG_STARS_HEADER_BYTES, n), dec = new Uint16Array(buf, SG_STARS_HEADER_BYTES + 2 * n, n);
  var mag = new Uint8Array(buf, SG_STARS_HEADER_BYTES + 4 * n, n), bv = new Int8Array(buf, SG_STARS_HEADER_BYTES + 5 * n, n);
  var out = { n: n, ra: new Float32Array(n), dec: new Float32Array(n), mag: new Float32Array(n), bv: new Float32Array(n), vec: new Float32Array(3 * n) };
  for (var i = 0; i < n; i++) {
    var a = ra[i] / SG_STARS_U16_STEPS * 2 * Math.PI, d = (dec[i] / SG_STARS_U16_MAX - 0.5) * Math.PI, c = Math.cos(d);
    out.ra[i] = a; out.dec[i] = d;
    out.mag[i] = mag[i] / SG_STARS_MAG_SCALE - SG_STARS_MAG_OFFSET;
    out.bv[i] = bv[i] === SG_STARS_BV_NONE ? SG_STAR_BV_DEFAULT : bv[i] / SG_STARS_BV_SCALE;
    out.vec[3 * i] = c * Math.cos(a); out.vec[3 * i + 1] = c * Math.sin(a); out.vec[3 * i + 2] = Math.sin(d);
  }
  return out;
}

// The galactic frame. Rows of the J2000 equatorial to galactic rotation (the
// Hipparcos catalogue's, ESA 1997 vol. 1 sec. 1.5.3): x to the centre, z to
// the north galactic pole.
var SG_EQ_TO_GAL = [-0.0548755604, -0.8734370902, -0.4838350155, 0.4941094279, -0.4448296300, 0.7469822445, -0.8676661490, -0.1980763734, 0.4559837762];
function _sgGalactic(v) {
  var m = SG_EQ_TO_GAL, x = m[0] * v[0] + m[1] * v[1] + m[2] * v[2], y = m[3] * v[0] + m[4] * v[1] + m[5] * v[2], z = m[6] * v[0] + m[7] * v[1] + m[8] * v[2];
  return { l: (Math.atan2(y, x) / DEG_TO_RAD + 360) % 360, b: Math.asin(Math.max(-1, Math.min(1, z))) / DEG_TO_RAD };
}
// Where a galactic longitude and latitude stand in the Milky Way panorama:
// the centre in the middle, longitude growing to the left (the sky as seen
// from inside), latitude down from +90 at the top. Texture coordinates 0..1.
function _sgGalUV(l, b) { return { u: 0.5 - (((l + 180) % 360 + 360) % 360 - 180) / 360, v: 0.5 - b / 180 }; }

// The rotation from J2000 equatorial vectors to the observer's (east, north,
// up): the instant's precession P (3x3 rows), local sidereal time (radians),
// latitude (degrees). Row-major, 9 numbers.
function _sgHorizonMatrix(P, lst, latDeg) {
  var sl = Math.sin(lst), cl = Math.cos(lst), sp = Math.sin(latDeg * DEG_TO_RAD), cp = Math.cos(latDeg * DEG_TO_RAD);
  var H = [-sl, cl, 0, -sp * cl, -sp * sl, cp, cp * cl, cp * sl, sp], out = [];
  for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) out.push(H[3 * i] * P[0][j] + H[3 * i + 1] * P[1][j] + H[3 * i + 2] * P[2][j]);
  return out;
}
function _sgTranspose(m) { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }
function _sgMul3(a, b) {
  var o = [];
  for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) o.push(a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j]);
  return o;
}

// How the air thins a star: its airmass-driven scintillation, as a relative
// amplitude of its brightness (Young 1967: sigma ~ airmass^1.5; a star at the
// zenith is steady to a few percent, one near the horizon boils).
var SG_SCINT_ZENITH = 0.04, SG_SCINT_MAX = 0.8;
function _sgScintillation(altDeg) {
  var X = _skyAirmass(Math.max(altDeg, 0));
  return Math.min(SG_SCINT_MAX, SG_SCINT_ZENITH * Math.pow(X, 1.5));
}

// ── How bright the sky is, and so what shows ──
// The zenith's luminance (cd/m2) by the Sun's geometric altitude on a clear
// day: noon blue, the golden hour, the three twilights, then the night sky's
// own light (airglow, zodiacal light, starlight: 22 mag per square arcsecond).
var SG_ZENITH_LUM = [[90, 6000], [30, 5200], [10, 3600], [5, 2400], [0, 600], [-1, 250], [-2, 110], [-3, 50], [-4, 20], [-5, 8], [-6, 3.5],
  [-8, 0.8], [-10, 0.15], [-12, 0.04], [-14, 0.01], [-16, 0.0035], [-18, 0.0008], [-20, 0.0003], [-24, 0.00017], [-90, 0.00017]];
var SG_DARK_SKY_LUM = 0.00017;                 // 22.0 mag/arcsec2
var SG_SQM_TO_LUM = 1.08e5;                    // cd/m2 = this * 10^(-0.4 * mag/arcsec2)
var SG_SQM_DARK = 22.0, SG_SQM_CITY = 17.5;    // the darkness dial's two ends
function _sgInterpLog(table, x) {
  for (var i = 1; i < table.length; i++) {
    if (x >= table[i][0] || i === table.length - 1) {
      var a = table[i - 1], b = table[i], f = Math.max(0, Math.min(1, (x - a[0]) / (b[0] - a[0])));
      return Math.exp(Math.log(a[1]) + (Math.log(b[1]) - Math.log(a[1])) * f);
    }
  }
}
// The same with the position logarithmic too: a table by luminance, whose rows are decades apart.
function _sgInterpLogLog(table, x) {
  for (var i = 1; i < table.length; i++) {
    if (x >= table[i][0] || i === table.length - 1) {
      var a = table[i - 1], b = table[i], f = Math.max(0, Math.min(1, (Math.log(x) - Math.log(a[0])) / (Math.log(b[0]) - Math.log(a[0]))));
      return Math.exp(Math.log(a[1]) + (Math.log(b[1]) - Math.log(a[1])) * f);
    }
  }
}
function _sgZenithLum(sunAlt) { return _sgInterpLog(SG_ZENITH_LUM, sunAlt); }
// The light a place adds to the dark sky: 0 (dial 0, a dark site) to a city's.
function _sgSkyglow(dial) {
  var d = Math.max(0, Math.min(1, dial || 0));
  return d === 0 ? 0 : SG_SQM_TO_LUM * Math.pow(10, -0.4 * (SG_SQM_DARK + (SG_SQM_CITY - SG_SQM_DARK) * d)) - SG_DARK_SKY_LUM * (1 - d);
}
// The Moon's own light on the sky (cd/m2): a full Moon high up about 5e-3.
var SG_MOON_SKY_FULL = 0.0035;
function _sgMoonSkyLum(moonAlt, illum, moonShare) {
  if (moonAlt <= 0) return 0;
  var k = Math.max(0, Math.min(1, illum / 100));
  return SG_MOON_SKY_FULL * k * k * Math.pow(Math.sin(Math.min(moonAlt, 90) * DEG_TO_RAD), 0.6) * (moonShare == null ? 1 : moonShare);
}
// The whole sky's luminance an eye is set to, and the faintest star it shows
// (naked-eye limiting magnitude: 7.6 under a dark sky, falling 1.5 magnitudes
// for every decade of sky brightness).
var SG_LM_DARK = 7.6, SG_LM_PER_DECADE = 1.5, SG_LM_MAX = 7.9, SG_LM_MIN = -4.5;
// sunShare is the part of the Sun's light that reaches the place (1, less in an eclipse).
var SG_SUN_SHARE_MIN = 0.003;      // the sky in totality: light scattered in from beyond the Moon's shadow
function _sgSunShare(obscuration) { return Math.max(SG_SUN_SHARE_MIN, 1 - Math.min(1, obscuration || 0)); }
function _sgSkyLum(sunAlt, moonAlt, moonIllum, dial, sunShare, moonShare) {
  return Math.max(_sgZenithLum(sunAlt) * (sunShare == null ? 1 : sunShare), SG_DARK_SKY_LUM) + _sgMoonSkyLum(moonAlt, moonIllum, moonShare) + _sgSkyglow(dial);
}
function _sgLimitMag(lum) {
  return Math.max(SG_LM_MIN, Math.min(SG_LM_MAX, SG_LM_DARK - SG_LM_PER_DECADE * Math.log10(lum / SG_DARK_SKY_LUM)));
}
// The exposure the display uses: the eye adapts, but not all the way (a dark
// night must stay dark). Display value = 1 - exp(-L * exposure). Rows of
// [adapting luminance, exposure].
var SG_EXPOSURE = [[6000, 2.4e-4], [600, 1.4e-3], [50, 4e-3], [3.5, 8e-3], [0.04, 0.12], [0.00017, 22]];
var SG_MOON_ADAPT = 0.15;                      // the Moon's share of what the eye adapts to
function _sgExposure(sunAlt, moonAlt, moonIllum, dial, sunShare, moonShare) {
  var L = Math.max(_sgZenithLum(sunAlt) * (sunShare == null ? 1 : sunShare), SG_DARK_SKY_LUM) + SG_MOON_ADAPT * _sgMoonSkyLum(moonAlt, moonIllum, moonShare) + _sgSkyglow(dial);
  return _sgInterpLogLog(SG_EXPOSURE, L);
}
// The part of the Moon's light that is left in a lunar eclipse: the umbra's
// share of the disc takes it all but a copper residue, the penumbra a third.
// ec is _skyEclipse's answer (null: no eclipse).
var SG_UMBRA_RESIDUE = 0.001, SG_PENUMBRA_DIM = 0.35;
function _sgMoonShare(ec) {
  if (!ec) return 1;
  var covered = Math.max(0, Math.min(1, ec.umbralMag)), pen = Math.max(0, Math.min(1, ec.penumbralMag));
  return Math.max(SG_UMBRA_RESIDUE, (1 - covered) * (1 - SG_PENUMBRA_DIM * pen));
}
// The Moon's illuminance at the top of the air (lux) from its phase angle and
// distance: V = -12.74 + 0.026|a| + 4e-9 a^4 (Allen), 0 mag = 2.54e-6 lux.
var SG_LUX_PER_MAG0 = 2.54e-6, SG_SUN_LUX = 1.3e5;
function _sgMoonLux(illumPct, distKm) {
  var a = Math.acos(Math.max(-1, Math.min(1, 2 * illumPct / 100 - 1))) / DEG_TO_RAD;
  var m = -12.74 + 0.026 * a + 4e-9 * Math.pow(a, 4) + 5 * Math.log10(distKm / 384400);
  return SG_LUX_PER_MAG0 * Math.pow(10, -0.4 * m);
}
// How visible a star of this magnitude is when the faintest showing is lm:
// nothing at the limit, a faint point just inside it, brighter by the ratio of
// the light (2.5x a magnitude is the eye's 1.6x), full by 4.5 magnitudes above
// the limit. The GPU's formula (SG_VS_STARS), here so the Canvas 2D sky and
// the tests share it.
var SG_STAR_FLOOR = 0.12, SG_STAR_FADE_MAG = 0.6, SG_STAR_PER_MAG = 0.2;   // brightness just inside the limit; the fade-in; log10 of the step per magnitude
function _sgStarVisibility(mag, lm) {
  var d = lm - mag;
  if (d <= 0) return 0;
  var f = Math.min(1, d / SG_STAR_FADE_MAG);
  return f * f * (3 - 2 * f) * Math.min(1, SG_STAR_FLOOR * Math.pow(10, SG_STAR_PER_MAG * d));
}

// ── The air ──
// Optical depth straight up through the air, red/green/blue (Rayleigh, Mie
// and ozone; Hillaire 2020's coefficients, per km): what the shaders integrate.
var SG_RAYLEIGH = [0.005802, 0.013558, 0.0331], SG_RAYLEIGH_H = 8;
var SG_MIE_SCATTER = 0.003996, SG_MIE_ABSORB = 0.00444, SG_MIE_H = 1.2;
var SG_OZONE = [0.00065, 0.001881, 0.000085], SG_OZONE_CENTRE = 25, SG_OZONE_HALF = 15;
function _sgZenithOpticalDepth() {
  var out = [];
  for (var k = 0; k < 3; k++) out.push(SG_RAYLEIGH[k] * SG_RAYLEIGH_H + (SG_MIE_SCATTER + SG_MIE_ABSORB) * SG_MIE_H + SG_OZONE[k] * SG_OZONE_HALF);
  return out;
}

// ══ The zodiacal light and the airglow ═══════════════════════════════════
// Brightness (S10 units: 1 = a tenth-magnitude star per square degree = 8.3e-7
// cd/m2) of the zodiacal light on the ecliptic by its elongation from the Sun
// (Leinert et al. 1998, rounded), and how fast it falls off the ecliptic.
var SG_ZODI_S10 = [[180, 190], [150, 140], [120, 160], [90, 230], [60, 500], [45, 900], [30, 2000], [15, 5000]];
var SG_S10_LUM = 8.3e-7;
var SG_ZODI_WIDTH = [10, 26];     // degrees of ecliptic latitude to 1/e of the ridge, near the Sun and far from it
function _sgZodiLum(elongDeg, eclLatDeg) {
  var e = Math.max(15, Math.min(180, elongDeg)), S = _sgInterpLog(SG_ZODI_S10, e) * SG_S10_LUM;
  var w = SG_ZODI_WIDTH[0] + (SG_ZODI_WIDTH[1] - SG_ZODI_WIDTH[0]) * Math.min(1, e / 90);
  return S * Math.exp(-Math.pow(eclLatDeg / w, 2) / 2);
}
// The airglow's night glow (cd/m2) over the sky's own: brighter toward the
// horizon (van Rhijn: a thin shell 90 km up), then thinned by the air.
var SG_AIRGLOW_LUM = 6e-5, SG_AIRGLOW_H = 90, SG_EARTH_R = 6371;
function _sgAirglow(altDeg) {
  var z = (90 - Math.max(altDeg, 0)) * DEG_TO_RAD, k = SG_EARTH_R / (SG_EARTH_R + SG_AIRGLOW_H);
  var vanRhijn = 1 / Math.sqrt(1 - k * k * Math.sin(z) * Math.sin(z));
  return SG_AIRGLOW_LUM * vanRhijn * Math.exp(-0.12 * (_skyAirmass(Math.max(altDeg, 0)) - 1));
}

// ══ The shaders ══════════════════════════════════════════════════════════
var SG_MW_GAMMA = '1.2', SG_MW_EXTINCTION = '0.28', SG_AIRGLOW_EXTINCTION = '0.12';   // the panorama's gamma lifts its faint outer disc; its extinction and the airglow's
var SG_GROUND_ALBEDO = 'vec3(0.085, 0.075, 0.065)';
var SG_SHADOW_SOFT = '0.025';      // half the width of the Earth's shadow edge, in the cosine of the Sun's zenith angle
var SG_TRANS_W = 256, SG_TRANS_H = 64, SG_MS_N = 32, SG_VIEW_W = 256, SG_VIEW_H = 128, SG_VIEW_STEPS = 128;
// The airmass at an altitude in degrees (Kasten and Young): the one formula, from the page's own constants.
var SG_GLSL_AIRMASS = 'float airmassDeg(float h) { h = max(h, 0.0); return 1.0 / (sin(radians(h)) + ' + SKY_AIRMASS_A + ' * pow(h + ' + SKY_AIRMASS_B + ', -' + SKY_AIRMASS_C + ')); }';
var SG_LUT_LOG_SCALE = '32.0', SG_LUT_OD_SCALE = '64.0';   // the tables hold the logarithm of the light and the optical depth, scaled to sit where a half float has digits
var SG_GLSL_HEAD = [
  '#version 300 es', 'precision highp float;', 'precision highp sampler2D;',
  'const float PI = 3.14159265359;',
  'const float Rg = 6360.0, Rt = 6460.0;',
  'const vec3 RAY_S = vec3(' + SG_RAYLEIGH.join(',') + ');',
  'const float MIE_S = ' + SG_MIE_SCATTER + ', MIE_E = ' + (SG_MIE_SCATTER + SG_MIE_ABSORB) + ';',
  'const vec3 OZONE = vec3(' + SG_OZONE.join(',') + ');',
  'vec3 sigmaT(float h) { return RAY_S * exp(-h / ' + SG_RAYLEIGH_H.toFixed(1) + ') + MIE_E * exp(-h / ' + SG_MIE_H.toFixed(1) + ') + OZONE * max(0.0, 1.0 - abs(h - ' + SG_OZONE_CENTRE.toFixed(1) + ') / ' + SG_OZONE_HALF.toFixed(1) + '); }',
  // The distance along a ray (origin o, unit d) to a sphere of radius R about the centre: the far hit from inside, the near one from
  // outside, -1 if it misses. (|o|-R)(|o|+R), not |o|^2-R^2: at these radii a float has no digits left for the difference.
  'float sphereFar(vec3 o, vec3 d, float R) {',
  '  float lo = length(o), c = (lo - R) * (lo + R), b = dot(o, d), D = b * b - c;',
  '  if (D < 0.0) return -1.0;',
  '  float sq = sqrt(D);',
  '  return b > 0.0 ? -c / (b + sq) : -b + sq;',
  '}',
  'float sphereNear(vec3 o, vec3 d, float R) {',
  '  float lo = length(o), c = (lo - R) * (lo + R), b = dot(o, d), D = b * b - c;',
  '  if (D < 0.0 || b >= 0.0) return -1.0;',
  '  return c / (-b + sqrt(D));',
  '}',
  'vec2 unitToTex(vec2 u, vec2 size) { return (u * (size - 1.0) + 0.5) / size; }',
  SG_GLSL_AIRMASS,
  // A table's value back to light: a half float cannot hold a twilight's 1e-8, its logarithm it can.
  'vec3 lutLight(vec3 t) { return exp(t * ' + SG_LUT_LOG_SCALE + '); }',
  'vec3 lutOut(vec3 L) { return log(max(L, vec3(1e-14))) / ' + SG_LUT_LOG_SCALE + '; }'
].join('\n');

var SG_GLSL_TRANS_LOOKUP = [
  'uniform sampler2D uTrans;',
  'vec2 transUV(float r, float mu) {',
  '  float H = sqrt(Rt * Rt - Rg * Rg), rho = sqrt(max(0.0, (r - Rg) * (r + Rg)));',
  '  float disc = (Rt - r) * (Rt + r) + r * r * mu * mu, d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));',
  '  float dmin = Rt - r, dmax = rho + H;',
  '  return unitToTex(vec2((d - dmin) / (dmax - dmin), rho / H), vec2(' + SG_TRANS_W + '.0, ' + SG_TRANS_H + '.0));',
  '}',
  'vec3 transmittanceTo(float r, float mu) { return exp(-textureLod(uTrans, transUV(r, mu), 0.0).rgb * ' + SG_LUT_OD_SCALE + '); }',
  // The Earth's shadow: 0 where the Sun is below the horizon seen from this height. Soft over about two degrees: the Sun's own disc is
  // half a degree, and the air bends the light along the shadow's edge by more.
  'float earthShadow(float r, float mu) { float muH = -sqrt(max(0.0, 1.0 - (Rg * Rg) / (r * r))); return smoothstep(-' + SG_SHADOW_SOFT + ', ' + SG_SHADOW_SOFT + ', mu - muH); }'
].join('\n');

var SG_FS_TRANS = SG_GLSL_HEAD + '\n' + [
  'out vec4 outColor;',
  'void main() {',
  '  vec2 uv = (gl_FragCoord.xy - 0.5) / (vec2(' + SG_TRANS_W + '.0, ' + SG_TRANS_H + '.0) - 1.0);',
  '  float H = sqrt(Rt * Rt - Rg * Rg), rho = H * uv.y, r = Rg + rho * rho / (Rg + sqrt(rho * rho + Rg * Rg));',
  '  float dmin = Rt - r, dmax = rho + H, d = dmin + uv.x * (dmax - dmin);',
  '  float mu = d == 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);',
  '  vec3 o = vec3(0.0, r, 0.0), dir = vec3(sqrt(1.0 - mu * mu), mu, 0.0);',
  '  float tmax = sphereFar(o, dir, Rt);',
  '  vec3 od = vec3(0.0);',
  '  for (int i = 0; i < 40; i++) {',
  '    float t0 = tmax * float(i) / 40.0, t1 = tmax * float(i + 1) / 40.0;',
  '    od += sigmaT(length(o + dir * 0.5 * (t0 + t1)) - Rg) * (t1 - t0);',
  '  }',
  '  outColor = vec4(od / ' + SG_LUT_OD_SCALE + ', 1.0);',
  '}'
].join('\n');

// The light scattered more than once, as a function of the Sun's height and
// the place's (Hillaire 2020 sec. 5.5): second order summed over a sphere of
// directions, then the geometric series of every order after it.
var SG_FS_MULTI = SG_GLSL_HEAD + '\n' + SG_GLSL_TRANS_LOOKUP + '\n' + [
  'out vec4 outColor;',
  'const float GROUND_ALBEDO = 0.3;',
  'void main() {',
  '  vec2 uv = (gl_FragCoord.xy - 0.5) / (' + SG_MS_N + '.0 - 1.0);',
  '  float muS = uv.x * 2.0 - 1.0, r = Rg + clamp(uv.y, 0.0, 1.0) * (Rt - Rg) + 0.01;',
  '  vec3 sunDir = vec3(sqrt(1.0 - muS * muS), muS, 0.0), o = vec3(0.0, r, 0.0);',
  '  vec3 L2 = vec3(0.0), Fms = vec3(0.0);',
  '  for (int i = 0; i < 64; i++) {',
  '    float z = 1.0 - (2.0 * float(i) + 1.0) / 64.0, phi = float(i) * 2.39996323, s = sqrt(1.0 - z * z);',
  '    vec3 d = vec3(s * cos(phi), z, s * sin(phi));',
  '    float tg = sphereNear(o, d, Rg), tmax = tg > 0.0 ? tg : sphereFar(o, d, Rt);',
  '    vec3 T = vec3(1.0);',
  '    for (int j = 0; j < 20; j++) {',
  '      float t0 = tmax * float(j) / 20.0, t1 = tmax * float(j + 1) / 20.0, dt = t1 - t0;',
  '      vec3 P = o + d * 0.5 * (t0 + t1); float rp = length(P), h = rp - Rg;',
  '      vec3 sT = sigmaT(h), sS = RAY_S * exp(-h / ' + SG_RAYLEIGH_H.toFixed(1) + ') + MIE_S * exp(-h / ' + SG_MIE_H.toFixed(1) + ');',
  '      vec3 stepT = exp(-sT * dt);',
  '      float muP = dot(P / rp, sunDir);',
  '      vec3 sunT = transmittanceTo(rp, muP) * earthShadow(rp, muP);',
  '      vec3 Sint = (sS - sS * stepT) / max(sT, vec3(1e-9));',
  '      L2 += T * Sint * sunT / (4.0 * PI);',
  '      Fms += T * Sint;',
  '      T *= stepT;',
  '    }',
  '    if (tg > 0.0) {',
  '      vec3 P = o + d * tg; float rp = length(P), muP = dot(P / rp, sunDir);',
  '      L2 += T * transmittanceTo(rp, muP) * earthShadow(rp, muP) * max(muP, 0.0) * GROUND_ALBEDO / PI;',
  '    }',
  '  }',
  '  L2 /= 64.0; Fms /= 64.0;',
  '  outColor = vec4(lutOut(L2 / (1.0 - Fms)), 1.0);',
  '}'
].join('\n');

// The sky seen from the ground, for one light (the Sun or the Moon): every
// direction above the horizon, by its height (non-linear, dense at the
// horizon) and its bearing from the light.
var SG_FS_SKYVIEW = SG_GLSL_HEAD + '\n' + SG_GLSL_TRANS_LOOKUP + '\n' + [
  'uniform sampler2D uMulti;',
  'uniform float uLightAlt;',          // the light's altitude, radians
  'uniform float uObsHeight;',         // the observer's height above the ground, km
  'out vec4 outColor;',
  'float phaseR(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }',
  'float phaseM(float c) { const float g = 0.8; float k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g); return k * (1.0 + c * c) / pow(1.0 + g * g - 2.0 * g * c, 1.5); }',
  'void main() {',
  '  vec2 uv = (gl_FragCoord.xy - 0.5) / (vec2(' + SG_VIEW_W + '.0, ' + SG_VIEW_H + '.0) - 1.0);',
  '  float e = uv.y * uv.y * PI * 0.5, phi = uv.x * PI;',
  '  vec3 d = vec3(cos(e) * cos(phi), sin(e), cos(e) * sin(phi));',
  '  vec3 sunDir = vec3(cos(uLightAlt), sin(uLightAlt), 0.0), o = vec3(0.0, Rg + uObsHeight, 0.0);',
  '  float tmax = sphereFar(o, d, Rt), cosS = dot(d, sunDir);',
  '  vec3 col = vec3(0.0), T = vec3(1.0);',
  '  float tPrev = 0.0;',
  '  for (int i = 0; i < ' + SG_VIEW_STEPS + '; i++) {',
  '    float f = float(i + 1) / ' + SG_VIEW_STEPS + '.0, t = tmax * f * f, dt = t - tPrev;',
  '    vec3 P = o + d * (tPrev + 0.5 * dt); float rp = length(P), h = rp - Rg;',
  '    vec3 sT = sigmaT(h), sR = RAY_S * exp(-h / ' + SG_RAYLEIGH_H.toFixed(1) + '), sM = vec3(MIE_S * exp(-h / ' + SG_MIE_H.toFixed(1) + '));',
  '    vec3 stepT = exp(-sT * dt);',
  '    float muP = dot(P / rp, sunDir);',
  '    vec3 sunT = transmittanceTo(rp, muP) * earthShadow(rp, muP);',
  '    vec2 msUV = unitToTex(vec2(muP * 0.5 + 0.5, clamp((rp - Rg) / (Rt - Rg), 0.0, 1.0)), vec2(' + SG_MS_N + '.0));',
  '    vec3 ms = lutLight(textureLod(uMulti, msUV, 0.0).rgb);',
  '    vec3 S = sunT * (sR * phaseR(cosS) + sM * phaseM(cosS)) + ms * (sR + sM);',
  '    vec3 Sint = (S - S * stepT) / max(sT, vec3(1e-9));',
  '    col += T * Sint; T *= stepT; tPrev = t;',
  '  }',
  '  outColor = vec4(lutOut(col), 1.0);',
  '}'
].join('\n');

var SG_VS_QUAD = [
  '#version 300 es',
  'void main() { vec2 p = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }'
].join('\n');

// What the view looks along at a pixel: the page's panorama (the sky's flat
// bearing-by-height map) or a stereographic lens about a chosen direction.
// almanac-sky.js _skyScreen is this, inverted; the two must agree.
var SG_GLSL_VIEW = [
  'uniform vec2 uRes;',                // device px
  'uniform int uMode;',                // 0 panorama, 1 lens
  'uniform vec4 uPano;',               // centre bearing, span (radians), horizon y, zenith y (device px)
  'uniform vec3 uFwd, uRight, uUp;',   // lens: the view's axes in (east, north, up)
  'uniform float uLensK;',             // lens: tan(fov/4) * 2 over half the width in px
  'vec3 enu(float alt, float az) { return vec3(cos(alt) * sin(az), cos(alt) * cos(az), sin(alt)); }',
  'vec3 pixelDir(vec2 px) {',
  '  if (uMode == 0) {',
  '    float az = uPano.x + (px.x / uRes.x - 0.5) * uPano.y;',
  '    float alt = (uPano.z - px.y) * (PI * 0.5) / (uPano.z - uPano.w);',
  '    return enu(alt, az);',
  '  }',
  '  vec2 p = vec2(px.x - uRes.x * 0.5, uRes.y * 0.5 - px.y);',
  '  float r = length(p) * uLensK, th = 2.0 * atan(r * 0.5);',
  '  vec2 q = r > 0.0 ? p / length(p) : vec2(0.0);',
  '  return normalize(uFwd * cos(th) + (uRight * q.x + uUp * q.y) * sin(th));',
  '}'
].join('\n');

var SG_FS_SKY = SG_GLSL_HEAD + '\n' + SG_GLSL_VIEW + '\n' + [
  'uniform sampler2D uSkyS, uSkyM, uMilky;',
  'uniform float uSunAz, uSunLux, uMoonAz, uMoonLux, uExposure;',
  'uniform vec3 uGlow;',                     // the place's own light, cd/m2
  'uniform mat3 uGal;',                      // (east, north, up) to galactic
  'uniform vec3 uEclPole, uSunVec;',         // the ecliptic's pole and the Sun, in (east, north, up)
  'uniform float uMwScale, uMwOn, uZodiScale, uAirglow, uSeed;',
  'uniform float uZodi[16];',                // S10 table: elongation (rad) and brightness, 8 rows
  'out vec4 outColor;',
  'float wrapPi(float a) { return a - 2.0 * PI * floor((a + PI) / (2.0 * PI)); }',
  'float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }',
  // The light of the sky at a height, by its bearing from the Sun and from the Moon.
  'vec3 lightRel(float phiS, float phiM, float alt) {',
  '  float v = sqrt(clamp(alt, 0.0, PI * 0.5) / (PI * 0.5));',
  '  vec3 L = vec3(0.0);',
  '  if (uSunLux > 0.0) L += lutLight(texture(uSkyS, unitToTex(vec2(phiS / PI, v), vec2(' + SG_VIEW_W + '.0, ' + SG_VIEW_H + '.0))).rgb) * uSunLux;',
  '  if (uMoonLux > 0.0) L += lutLight(texture(uSkyM, unitToTex(vec2(phiM / PI, v), vec2(' + SG_VIEW_W + '.0, ' + SG_VIEW_H + '.0))).rgb) * uMoonLux;',
  '  return L;',
  '}',
  'vec3 skyLight(float az, float alt) { return lightRel(abs(wrapPi(az - uSunAz)), abs(wrapPi(az - uMoonAz)), alt); }',
  // What lights the ground from above, the same at every bearing: the sky's light high up, around the Sun and away from it.
  'vec3 ambientSky() { const float e = 0.7; return (lightRel(0.0, 0.0, e) + lightRel(PI * 0.5, PI * 0.5, e) * 2.0 + lightRel(PI, PI, e)) * 0.25; }',
  // S10 (tenth-magnitude stars per square degree) of the zodiacal light, log-interpolated by elongation.
  'float zodiS10(float elong) {',
  '  for (int i = 1; i < 8; i++) {',
  '    if (elong <= uZodi[2 * i] || i == 7) {',
  '      float f = clamp((elong - uZodi[2 * i - 2]) / (uZodi[2 * i] - uZodi[2 * i - 2]), 0.0, 1.0);',
  '      return exp(mix(log(uZodi[2 * i - 1]), log(uZodi[2 * i + 1]), f));',
  '    }',
  '  }',
  '  return 0.0;',
  '}',
  'vec3 finish(vec3 L, vec2 px) {',
  '  float Y = dot(L, vec3(0.2126, 0.7152, 0.0722));',
  '  float scoto = 1.0 - smoothstep(0.003, 0.3, Y);',                        // the eye's blue shift in the dark
  '  L = mix(L, vec3(Y) * vec3(0.62, 0.82, 1.25), 0.5 * scoto);',
  '  vec3 c = 1.0 - exp(-L * uExposure);',
  '  c = pow(c, vec3(1.0 / 2.2));',
  '  c += (hash(px + uSeed) - 0.5) / 255.0;',
  '  return clamp(c, 0.0, 1.0);',
  '}',
  'void main() {',
  '  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);',
  '  vec3 d = pixelDir(px);',
  '  float alt = asin(clamp(d.z, -1.0, 1.0)), az = atan(d.x, d.y);',
  '  vec3 L;',
  '  if (alt >= 0.0) {',
  '    L = skyLight(az, alt);',
  '    float ext = exp(-' + SG_MW_EXTINCTION + ' * (airmassDeg(degrees(alt)) - 1.0)) * smoothstep(0.0, 0.02, alt);',
  '    vec3 g = uGal * d;',
  '    vec2 tc = vec2(0.5 - atan(g.y, g.x) / (2.0 * PI), 0.5 - asin(clamp(g.z, -1.0, 1.0)) / PI);',
  '    vec3 mw = pow(texture(uMilky, tc).rgb, vec3(' + SG_MW_GAMMA + '));',
  '    float grain = 0.75 + 0.5 * hash(floor(px * 0.5) + 7.0);',            // the stars too faint to be catalogued
  '    L += uMwOn * mw * (uMwScale * ext * mix(1.0, grain, clamp(dot(mw, vec3(1.0)) * 4.0, 0.0, 1.0)));',
  '    float elong = acos(clamp(dot(d, uSunVec), -1.0, 1.0)), beta = asin(clamp(dot(d, uEclPole), -1.0, 1.0));',
  '    float w = mix(radians(' + SG_ZODI_WIDTH[0] + '.0), radians(' + SG_ZODI_WIDTH[1] + '.0), min(1.0, elong / (PI * 0.5)));',
  '    L += vec3(1.0, 0.93, 0.8) * zodiS10(clamp(elong, radians(15.0), PI)) * ' + SG_S10_LUM.toExponential(2) + ' * exp(-0.5 * pow(beta / w, 2.0)) * uZodiScale * ext;',
  '    L += vec3(0.55, 1.0, 0.7) * uAirglow * (1.0 / sqrt(1.0 - pow(' + (SG_EARTH_R / (SG_EARTH_R + SG_AIRGLOW_H)).toFixed(5) + ' * cos(alt), 2.0))) * exp(-' + SG_AIRGLOW_EXTINCTION + ' * (airmassDeg(degrees(alt)) - 1.0));',
  '    L += uGlow * (1.0 + 2.0 * exp(-degrees(alt) / 14.0));',
  '  } else {',
  // The ground: what falls on it (the sky's light from above, the Sun's if it is up, the place's own glow) times what it gives back,
  // with a little of the horizon's local light at the horizon; darker the further down. Nothing in it depends on the bearing at the nadir.
  '    vec3 E = ambientSky() + vec3(uSunLux * max(uSunVec.z, 0.0) / PI) + uGlow;',
  '    vec3 h = ' + SG_GROUND_ALBEDO + ' * (E + 0.4 * skyLight(az, 0.05) * smoothstep(-0.5, -0.02, alt)) + vec3(' + (SG_DARK_SKY_LUM * 0.4).toExponential(2) + ');',
  '    L = h * (1.0 - 0.45 * smoothstep(0.0, 0.4, -alt));',
  '  }',
  '  outColor = vec4(finish(L, px), 1.0);',
  '}'
].join('\n');

// The stars: one instanced quad each, placed by the rotation to the
// observer's frame, sized and lit by magnitude against the sky's own light,
// reddened and thinned by the air they come through.
var SG_VS_STARS = SG_GLSL_HEAD + '\n' + SG_GLSL_VIEW + '\n' + [
  'in vec3 aVec; in vec4 aInfo; in vec3 aCol;',      // J2000 unit vector; magnitude, radius (CSS px), seed; colour
  'uniform mat3 uM;', 'uniform float uLm, uDpr, uScint, uSeed, uSat;', 'uniform vec3 uMoon;',   // the Moon's disc: centre and radius, device px
  'out vec2 vLocal; out vec4 vColor; out float vRad; out float vBloom;',
  'float hash(float n) { return fract(sin(n * 91.3458) * 47453.5453); }',
  'void main() {',
  '  vec3 h = uM * aVec;',
  '  float alt = asin(clamp(h.z, -1.0, 1.0)), az = atan(h.x, h.y);',
  '  vec2 px;',
  '  if (uMode == 0) {',
  '    float da = az - uPano.x; da = da - 2.0 * PI * floor((da + PI) / (2.0 * PI));',
  '    px = vec2((0.5 + da / uPano.y) * uRes.x, uPano.z - alt * (uPano.z - uPano.w) / (PI * 0.5));',
  '  } else {',
  '    float c = dot(h, uFwd); if (c < -0.98) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }',
  '    float th = acos(clamp(c, -1.0, 1.0)), r = 2.0 * tan(th * 0.5), s = sin(th);',
  '    vec2 q = s > 1e-6 ? vec2(dot(h, uRight), dot(h, uUp)) / s : vec2(0.0);',
  '    px = vec2(uRes.x * 0.5 + q.x * r / uLensK, uRes.y * 0.5 - q.y * r / uLensK);',
  '  }',
  '  float mag = aInfo.x, rCss = aInfo.y;',
  '  float X = airmassDeg(degrees(alt));',
  '  float d = uLm - (mag + ' + SG_EXTINCTION_MAG + ' * (X - 1.0));',
  '  float amp = min(' + SG_SCINT_MAX.toFixed(2) + ', ' + SG_SCINT_ZENITH.toFixed(2) + ' * pow(X, 1.5)) * uScint;',
  '  float vis = smoothstep(0.0, ' + SG_STAR_FADE_MAG.toFixed(2) + ', d) * min(1.0, ' + SG_STAR_FLOOR.toFixed(2) + ' * pow(10.0, ' + SG_STAR_PER_MAG.toFixed(2) + ' * d));',
  '  float rDev = max(' + '0.65' + ', rCss * uDpr);',
  '  float half_ = rDev * 5.0 + 1.5;',
  '  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;',
  '  if (alt < -0.004 || vis <= 0.0 || px.x < -half_ || px.x > uRes.x + half_ || px.y < -half_ || px.y > uRes.y + half_) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }',
  '  if (uMoon.z > 0.0 && distance(px, uMoon.xy) < uMoon.z) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }',
  '  vec2 p = px + corner * half_;',
  '  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);',
  '  float jitter = 1.0 + amp * (hash(aInfo.z + uSeed) * 2.0 - 1.0);',
  '  vec3 col = clamp(mix(vec3(1.0), aCol, uSat * smoothstep(0.25, 0.9, vis)), 0.0, 1.0);',
  // Near the horizon the colours scintillate apart too.
  '  col *= 1.0 + vec3(1.0, 0.0, -1.0) * amp * 0.5 * (hash(aInfo.z * 1.7 + uSeed) * 2.0 - 1.0);',
  '  vColor = vec4(col, vis * jitter);',
  '  vLocal = corner * half_; vRad = rDev; vBloom = mag < 0.5 ? 1.0 : 0.0;',
  '}'
].join('\n');
var SG_FS_STARS = SG_GLSL_HEAD + '\n' + [
  'in vec2 vLocal; in vec4 vColor; in float vRad; in float vBloom;',
  'out vec4 outColor;',
  'void main() {',
  '  float d = length(vLocal);',
  '  float core = 1.0 - smoothstep(vRad - 0.5, vRad + 0.5, d);',
  '  float halo = vBloom * 0.35 * exp(-pow(d / (2.4 * vRad), 2.0));',
  '  outColor = vec4(vColor.rgb * vColor.a * (core + halo), 1.0);',
  '}'
].join('\n');

// ══ The renderer ═════════════════════════════════════════════════════════
var _sg = null;          // null: not started (or given back); false: unusable here; else the renderer, ready once its programs have compiled and its tables are baked
var SG_OBSERVER_KM = 0.1;          // a float has half a metre's resolution at the planet's radius: the observer stands on a low rise
var SG_CONTEXT = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'default' };
var SG_POLL_MS = 30;               // how often the compile is asked whether it has finished
var SG_LIGHT_ALT_STEP = 0.05;      // degrees a light must move before its sky-view table is drawn again
var SG_MAX_LOSSES = 3;             // contexts lost in one page load before the GPU sky is given up
var _sgLosses = 0;
// An asset that failed is not asked for again until something says it may be (a resume, an open).
var _sgFailed = { stars: false, mw: false, names: false };
function _sgRetryLoads() { _sgFailed.stars = _sgFailed.mw = _sgFailed.names = false; }

function _sgShader(gl, type, src) {
  var sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return sh;
}
// Start a program compiling; it is finished (checked, its uniforms found) by _sgFinishProgram once the driver is done.
function _sgProgram(gl, vs, fs) {
  var p = gl.createProgram(), v = _sgShader(gl, gl.VERTEX_SHADER, vs), f = _sgShader(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  p.shaders = [v, f];
  return p;
}
function _sgFinishProgram(gl, p) {
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    var why = 'sky program: ' + gl.getProgramInfoLog(p) + ' ' + p.shaders.map(function (s) { return gl.getShaderInfoLog(s); }).join(' ');
    p.shaders.forEach(function (s) { gl.deleteShader(s); }); // a refused program is not left on the GPU
    gl.deleteProgram(p);
    throw new Error(why);
  }
  p.u = {};
  var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (var i = 0; i < n; i++) { var info = gl.getActiveUniform(p, i), nm = info.name.replace(/\[0\]$/, ''); p.u[nm] = gl.getUniformLocation(p, info.name); }
  for (var k = 0; k < p.shaders.length; k++) gl.deleteShader(p.shaders[k]);
  p.shaders = null;
}
function _sgTexture(gl, w, h, internal, format, type, data, filter) {
  var tx = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tx);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tx;
}
function _sgTarget(gl, w, h) {
  var tex = _sgTexture(gl, w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null);
  var fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('sky target');
  return { tex: tex, fb: fb, w: w, h: h };
}
function _sgBind(gl, unit, tex, loc) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, unit); }

// Start the renderer: the canvas, the programs compiling (the driver can do it
// off the main thread, KHR_parallel_shader_compile), the tables' targets.
// True once started, false where this browser cannot (no WebGL2, or no
// floating-point targets). Nothing is drawn until _sgReady(): the page paints
// the Canvas 2D sky meanwhile and is asked to paint again when the GPU is.
function _sgInit() {
  if (_sg !== null) return !!_sg;
  var sg = null;
  try {
    var canvas = document.createElement('canvas'), gl = canvas.getContext('webgl2', SG_CONTEXT);
    if (!gl || !(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))) return (_sg = false);
    sg = { canvas: canvas, gl: gl, W: 0, H: 0, ready: false, starCount: 0, mwReady: false, mwLoading: false, starsLoading: false,
      parallel: gl.getExtension('KHR_parallel_shader_compile'), sunKey: null, moonKey: null };
    // A phone takes the GPU back when the page is backgrounded: the next paint starts it again (or the 2D sky carries on).
    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); _sgLost(sg); });
    sg.pTrans = _sgProgram(gl, SG_VS_QUAD, SG_FS_TRANS);
    sg.pMulti = _sgProgram(gl, SG_VS_QUAD, SG_FS_MULTI);
    sg.pView = _sgProgram(gl, SG_VS_QUAD, SG_FS_SKYVIEW);
    sg.pSky = _sgProgram(gl, SG_VS_QUAD, SG_FS_SKY);
    sg.progs = [sg.pTrans, sg.pMulti, sg.pView, sg.pSky];
    sg.vao = gl.createVertexArray();
    sg.trans = _sgTarget(gl, SG_TRANS_W, SG_TRANS_H);
    sg.multi = _sgTarget(gl, SG_MS_N, SG_MS_N);
    sg.viewS = _sgTarget(gl, SG_VIEW_W, SG_VIEW_H);
    sg.viewM = _sgTarget(gl, SG_VIEW_W, SG_VIEW_H);
    sg.mwTex = _sgTexture(gl, 1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    _sg = sg;
    _sgPoll(sg);
    return true;
  } catch (e) {
    if (sg) _sgDispose(sg);
    return (_sg = false);
  }
}
// The page's sky starts the GPU when the person is not touching the screen, not in the paint that first asks: a
// context, four programs and their tables were a task of their own, right after the Almanac opened. The Canvas 2D
// sky draws until then (the same contract as while the programs compile). False until started.
var SG_START_MAX_WAIT_MS = 1500;
function _sgInitSoon() {
  if (_sg !== null) return !!_sg;
  if (typeof whenQuiet !== 'function') return _sgInit();
  whenQuiet(function () { if (_sg === null) _sgInit(); }, { key: 'sky-gl', priority: QUIET_PRI_PANELS, maxWaitMs: SG_START_MAX_WAIT_MS });
  return false;
}
// Until the programs have compiled: look again soon. Then link-check them and bake the two tables that never change.
function _sgPoll(sg) {
  if (_sg !== sg) return;
  var gl = sg.gl, i;
  if (sg.parallel) {
    for (i = 0; i < sg.progs.length; i++) {
      if (!gl.getProgramParameter(sg.progs[i], sg.parallel.COMPLETION_STATUS_KHR)) { sg.pollTimer = setTimeout(function () { _sgPoll(sg); }, SG_POLL_MS); return; }
    }
  }
  try {
    for (i = 0; i < sg.progs.length; i++) _sgFinishProgram(gl, sg.progs[i]);
    gl.bindVertexArray(sg.vao);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sg.trans.fb);
    gl.viewport(0, 0, SG_TRANS_W, SG_TRANS_H);
    gl.useProgram(sg.pTrans);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sg.multi.fb);
    gl.viewport(0, 0, SG_MS_N, SG_MS_N);
    gl.useProgram(sg.pMulti);
    _sgBind(gl, 0, sg.trans.tex, sg.pMulti.u.uTrans);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    sg.ready = true;
  } catch (e) {
    _sgDisable();
    return;
  }
  if (typeof _skyKickDirty === 'function') _skyKickDirty();
  _sgAnnounce(true);
}
function _sgReady() { return !!(_sg && _sg.ready); }
// What other views hear: the GPU sky came or went ('zimisky:gl', detail.ready).
function _sgAnnounce(ready) {
  if (typeof document !== 'undefined' && document.dispatchEvent && typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent('zimisky:gl', { detail: { ready: ready } }));
}
// Give the GPU back: its textures, buffers and programs, and the context itself.
function _sgDispose(sg) {
  sg = sg || _sg;
  if (!sg) return;
  clearTimeout(sg.pollTimer);
  try {
    var gl = sg.gl, t = [sg.trans, sg.multi, sg.viewS, sg.viewM], i;
    for (i = 0; i < t.length; i++) if (t[i]) { gl.deleteTexture(t[i].tex); gl.deleteFramebuffer(t[i].fb); }
    if (sg.mwTex) gl.deleteTexture(sg.mwTex);
    for (i = 0; i < (sg.buffers || []).length; i++) gl.deleteBuffer(sg.buffers[i]);
    if (sg.vao) gl.deleteVertexArray(sg.vao);
    if (sg.vaoStars) gl.deleteVertexArray(sg.vaoStars);
    var ps = (sg.progs || []).concat(sg.pStars ? [sg.pStars] : []);
    for (i = 0; i < ps.length; i++) gl.deleteProgram(ps[i]);
    var lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  } catch (e) { /* the context is gone already */ }
  sg.canvas.width = sg.canvas.height = 1;
  if (_sg === sg) _sg = null;
}
// The GPU sky is given up for this page load.
function _sgDisable() { _sgDispose(); _sg = false; _sgAnnounce(false); }
function _sgLost(sg) {
  if (_sg !== sg) return;
  _sgDispose(sg);
  _sgLosses++;
  if (_sgLosses >= SG_MAX_LOSSES) _sg = false;
  _sgAnnounce(false);
  if (typeof _skyKickDirty === 'function') _skyKickDirty();
}

// ── The data ──
// One decoder and one request for the star catalogue, whoever asks first (the
// sky, the 3D view): a promise of the decoded stars. A failure is remembered
// until _sgRetryLoads, so a missing file is not asked for on every frame.
var _sgStarsPromise = null, _sgNamesPromise = null;
function _sgLoadStars() {
  if (_sgStarsPromise) return _sgStarsPromise;
  if (_sgFailed.stars) return Promise.reject(new Error('stars'));
  _sgStarsPromise = fetch(SG_STARS_URL).then(function (r) { if (!r.ok) throw new Error('stars'); return r.arrayBuffer(); }).then(function (buf) {
    var stars = _sgDecodeStars(buf);
    if (!stars) throw new Error('stars');
    return stars;
  });
  _sgStarsPromise.catch(function () { _sgFailed.stars = true; _sgStarsPromise = null; });
  return _sgStarsPromise;
}
// The designations of the bright stars: { binIndex: [designation, constellation id] }.
function _sgLoadStarNames() {
  if (_sgNamesPromise) return _sgNamesPromise;
  if (_sgFailed.names) return Promise.reject(new Error('names'));
  _sgNamesPromise = fetch(SG_NAMES_URL).then(function (r) { if (!r.ok) throw new Error('names'); return r.json(); }).then(function (d) {
    var out = {};
    for (var i = 0; i < d.n.length; i++) out[d.n[i][0]] = [d.n[i][1], d.n[i][2]];
    return out;
  });
  _sgNamesPromise.catch(function () { _sgFailed.names = true; _sgNamesPromise = null; });
  return _sgNamesPromise;
}
// The decoded stars as the 3D view reads them: count and at(i, out) giving RA and Dec (radians), magnitude and B-V.
function _sgStarList(stars) {
  return { count: stars.n, at: function (i, out) { out.ra = stars.ra[i]; out.dec = stars.dec[i]; out.mag = stars.mag[i]; out.ci = stars.bv[i]; } };
}

// The stars and the Milky Way's picture, fetched once the GPU sky is ready
// (after the first paint); onReady asks for another paint when each lands.
function _sgLoadData(onReady) {
  var sg = _sg;
  if (!sg || !sg.ready) return;
  if (!sg.starCount && !sg.starsLoading && !_sgFailed.stars) {
    sg.starsLoading = true;
    _sgLoadStars().then(function (stars) {
      if (_sg !== sg) return;
      _sgUploadStars(sg, stars);
      onReady();
    }).catch(function () { _sgFailed.stars = true; }) // until _sgRetryLoads, not every paint
      .then(function () { sg.starsLoading = false; });
  }
  if (!sg.mwReady && !sg.mwLoading && !_sgFailed.mw) {
    sg.mwLoading = true;
    var img = new Image();
    var upload = function () {
      sg.mwLoading = false;
      if (_sg !== sg) return;
      var gl = sg.gl;
      gl.bindTexture(gl.TEXTURE_2D, sg.mwTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      sg.mwReady = true;
      onReady();
    };
    var failed = function () { sg.mwLoading = false; _sgFailed.mw = true; };
    img.src = SG_MILKYWAY_URL;
    // Decoded off the main thread first: the upload then copies pixels instead of decoding a webp in the task.
    if (img.decode) img.decode().then(upload, failed);
    else { img.onload = upload; img.onerror = failed; }
  }
}

// Per-star data into GPU buffers: the J2000 vector, magnitude, radius (CSS
// px, the 2D sky's _skyStarLook) and a seed; colour from B-V.
function _sgUploadStars(sg, stars) {
  var gl = sg.gl, n = stars.n, info = new Float32Array(4 * n), col = new Float32Array(3 * n);
  for (var i = 0; i < n; i++) {
    info[4 * i] = stars.mag[i]; info[4 * i + 1] = _skyStarLook(stars.mag[i]).r; info[4 * i + 2] = (i * 0.61803398875) % 1 * 1000; info[4 * i + 3] = 0;
    var c = _sgBvToRGB(stars.bv[i]);
    col[3 * i] = c[0]; col[3 * i + 1] = c[1]; col[3 * i + 2] = c[2];
  }
  sg.pStars = _sgProgram(gl, SG_VS_STARS, SG_FS_STARS);
  _sgFinishProgram(gl, sg.pStars);
  sg.vaoStars = gl.createVertexArray();
  gl.bindVertexArray(sg.vaoStars);
  sg.buffers = [];
  function attr(name, data, size) {
    var loc = gl.getAttribLocation(sg.pStars, name), b = gl.createBuffer();
    sg.buffers.push(b);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(loc, 1);
  }
  attr('aVec', stars.vec, 3); attr('aInfo', info, 4); attr('aCol', col, 3);
  sg.starCount = n;
  sg.stars = stars;
}

var SG_STAR_SATURATION = 1.2;    // a catalogue's blackbody colours are pale; the eye and a photograph both lean into them (and faint stars show none)

// The sky-view table of a light, drawn only when the light has moved enough to matter.
function _sgBakeLight(sg, which, altDeg) {
  var gl = sg.gl, key = Math.round(altDeg / SG_LIGHT_ALT_STEP), k = which + 'Key', t = which === 'sun' ? sg.viewS : sg.viewM;
  if (sg[k] === key) return;
  sg[k] = key;
  gl.useProgram(sg.pView);
  _sgBind(gl, 0, sg.trans.tex, sg.pView.u.uTrans);
  _sgBind(gl, 1, sg.multi.tex, sg.pView.u.uMulti);
  gl.uniform1f(sg.pView.u.uObsHeight, SG_OBSERVER_KM);
  gl.viewport(0, 0, SG_VIEW_W, SG_VIEW_H);
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
  gl.uniform1f(sg.pView.u.uLightAlt, key * SG_LIGHT_ALT_STEP * DEG_TO_RAD);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// One frame. p: { W, H, dpr, view, sunAltGeo, sunAz, moonAlt, moonAz, moonIllum,
// moonDist, horizon (the 9 numbers of _sgHorizonMatrix), eclPole, sunVec,
// dial, seed, scint, lm, sunShare, moonShare, moonDisc: {x, y, r} in device px
// or null }. Altitudes and bearings in degrees (the Sun's and the Moon's as
// apparent). Returns the canvas the frame is in; copy it before the next
// frame or the next task (it is not preserved).
function _sgDraw(p) {
  var sg = _sg, gl = sg.gl;
  if (sg.W !== p.W || sg.H !== p.H) { sg.canvas.width = sg.W = p.W; sg.canvas.height = sg.H = p.H; }
  gl.bindVertexArray(sg.vao);
  gl.disable(gl.BLEND);
  // The two lights' sky-views (skipped when the light is far below the horizon).
  var moonShare = p.moonShare == null ? 1 : p.moonShare;
  var sunLux = p.sunAltGeo > -26 ? SG_SUN_LUX * (p.sunShare == null ? 1 : p.sunShare) : 0;
  var moonLux = p.moonAlt > -12 && p.moonIllum > 0.5 ? _sgMoonLux(p.moonIllum, p.moonDist) * SG_MOON_GAIN * moonShare : 0;
  if (sunLux) _sgBakeLight(sg, 'sun', p.sunAltGeo);
  if (moonLux) _sgBakeLight(sg, 'moon', p.moonAlt);
  // The sky itself.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, p.W, p.H);
  gl.useProgram(sg.pSky);
  var u = sg.pSky.u;
  _sgBind(gl, 0, sg.viewS.tex, u.uSkyS); _sgBind(gl, 1, sg.viewM.tex, u.uSkyM); _sgBind(gl, 2, sg.mwTex, u.uMilky);
  _sgViewUniforms(gl, sg.pSky, p);
  gl.uniform1f(u.uSunAz, p.sunAz * DEG_TO_RAD); gl.uniform1f(u.uSunLux, sunLux);
  gl.uniform1f(u.uMoonAz, p.moonAz * DEG_TO_RAD); gl.uniform1f(u.uMoonLux, moonLux);
  // The eye has not time to adapt to an eclipse's dimming: it keeps most of the daylight's exposure (the square root of the share).
  gl.uniform1f(u.uExposure, _sgExposure(p.sunAltGeo, p.moonAlt, p.moonIllum, p.dial, p.sunShare == null ? 1 : Math.sqrt(p.sunShare), Math.sqrt(moonShare)));
  var glow = _sgSkyglow(p.dial);
  gl.uniform3f(u.uGlow, glow * 1.0, glow * 0.82, glow * 0.6);
  gl.uniformMatrix3fv(u.uGal, true, _sgMul3(SG_EQ_TO_GAL, _sgTranspose(p.horizon)));
  gl.uniform3fv(u.uEclPole, p.eclPole); gl.uniform3fv(u.uSunVec, p.sunVec);
  gl.uniform1f(u.uMwScale, SG_MW_LUM); gl.uniform1f(u.uMwOn, sg.mwReady ? 1 : 0);
  gl.uniform1f(u.uZodiScale, 1); gl.uniform1f(u.uAirglow, SG_AIRGLOW_LUM); gl.uniform1f(u.uSeed, p.seed || 0);
  var zt = [];
  for (var i = SG_ZODI_S10.length - 1; i >= 0; i--) zt.push(SG_ZODI_S10[i][0] * DEG_TO_RAD, SG_ZODI_S10[i][1]);
  gl.uniform1fv(u['uZodi'], zt);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  // The stars over it, added as light (but not through the Moon's disc: it is in front of them).
  if (sg.starCount) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(sg.vaoStars);
    gl.useProgram(sg.pStars);
    var us = sg.pStars.u, md = p.moonDisc;
    _sgViewUniforms(gl, sg.pStars, p);
    gl.uniformMatrix3fv(us.uM, true, p.horizon);
    gl.uniform1f(us.uLm, p.lm); gl.uniform1f(us.uDpr, p.dpr); gl.uniform1f(us.uScint, p.scint ? 1 : 0);
    gl.uniform1f(us.uSeed, p.seed || 0); gl.uniform1f(us.uSat, SG_STAR_SATURATION);
    gl.uniform3f(us.uMoon, md ? md.x : 0, md ? md.y : 0, md ? md.r : 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sg.starCount);
    gl.disable(gl.BLEND);
  }
  return sg.canvas;
}
var SG_MW_LUM = 0.008;          // cd/m2 at a pixel of the panorama's full brightness (the galactic bulge)
var SG_MOON_GAIN = 0.25;        // what the tables' Moon needs to give the sky the brightness a full Moon measures

function _sgViewUniforms(gl, prog, p) {
  var u = prog.u, v = p.view;
  gl.uniform2f(u.uRes, p.W, p.H);
  gl.uniform1i(u.uMode, v.mode);
  gl.uniform4f(u.uPano, v.centerAz * DEG_TO_RAD, v.spanDeg * DEG_TO_RAD, v.horizonY, v.zenithY);
  gl.uniform3fv(u.uFwd, v.fwd); gl.uniform3fv(u.uRight, v.right); gl.uniform3fv(u.uUp, v.up);
  gl.uniform1f(u.uLensK, v.lensK);
}
