// ── Almanac: the ground and the sky seen from it ──
// The pictures of "Stand here" (almanac-stand.js): the sky of the body one stands on, its atmosphere computed on the
// GPU from that body's own air (Rayleigh and dust or haze coefficients, scale heights, the Sun's real distance), the
// stars and the Milky Way, the Sun and every body that is up, and the terrain (almanac-terrain.js) lit by all of it.
// Everything is in a local frame in metres: x east, y north, z up, the origin on the ground at the viewer's feet,
// which is why a camera 1.7 m above a planet does not lose its digits the way the orbit view's Earth radii would.
// Atmospheres follow Hillaire 2020's single scattering (almanac-skygl.js has the Earth's full model for the live sky);
// the bodies whose air is a thick haze (Venus, Titan) are lit as an overcast, the airless ones have no sky at all.

var AE_ST_PI = '3.14159265';
var AE_ST_SUN_DISC_GAIN = 6e4;     // the Sun's disc against the sky's glow: stays a distinct disc where thick dust dims and blues it (Mars at sunset)
var AE_ST_ROCK_FADE_M = [14, 90];  // stones thin out with distance into plain ground (a pixel of them at range is noise, not stone)
var AE_ST_STEPS_SKY = 9, AE_ST_STEPS_GROUND = 5, AE_ST_STEPS_SUN = 4;   // the air's march: nine steps cost half of fourteen on a phone and look the same
var AE_ST_GAMMA = '2.2';

// The air of each body that has some. ray: Rayleigh scattering per km at the surface (red, green, blue) and its scale
// height; mie: the dust or haze's extinction, single-scattering albedo and the forward lobe (g) per channel, its scale
// height; ozone: absorption (the Earth's blue twilight); top: where the model ends (km). ms: how much light scattered
// more than once is added to the single scattering (the sky is brighter than one bounce).
// diffuse: a haze too thick for rays: the sky is one colour (radiance relative to the Sun's), sun: how much of the Sun's
// light reaches the ground as direct light, frac: how much reaches it at all, vis: how far one sees (km).
var AE_ST_ATMO = {
  earth: { ray: [0.005802, 0.013558, 0.0331], hR: 8, mie: { ext: [0.008436, 0.008436, 0.008436], alb: [0.4737, 0.4737, 0.4737], g: [0.8, 0.8, 0.8], h: 1.2 }, ozone: [0.00065, 0.001881, 0.000085], top: 100, ms: 1.6 },
  // Mars: a thin gas (a hundredth of the Earth's Rayleigh) and a standing haze of iron-rich dust. Blue is absorbed
  // in the dust (butterscotch day) yet passes most freely along the Sun's own path and scatters furthest forward
  // (the blue glow round a low Sun, the Sun itself a blue-white disc at sunset).
  mars: { ray: [0.00009, 0.00021, 0.00051], hR: 11.1, mie: { ext: [AE_STAND_MARS_TAU / 11.1, AE_STAND_MARS_TAU / 11.1 * 0.88, AE_STAND_MARS_TAU / 11.1 * 0.714], alb: [0.99, 0.56, 0.28], g: [0.55, 0.62, 0.82], h: 11.1 }, ozone: [0, 0, 0], top: 90, ms: 1.2, gain: 1.8 },
  // Pluto's faint blue haze, in layers high up; the sky is black but for a glow round the Sun near the horizon.
  pluto: { ray: [0.0000004, 0.0000009, 0.0000022], hR: 50, mie: { ext: [0.00002, 0.00003, 0.000045], alb: [0.9, 0.95, 1], g: [0.7, 0.7, 0.7], h: 30 }, ozone: [0, 0, 0], top: 200, ms: 0.5 },
  venus: { diffuse: { sky: [0.86, 0.55, 0.26], frac: 0.04, direct: 0.05, vis: AE_STAND_HAZE_VIS_KM.venus } },
  titan: { diffuse: { sky: [0.78, 0.42, 0.12], frac: 0.1, direct: 0.04, vis: AE_STAND_HAZE_VIS_KM.titan, ghost: 0.04 } }
};
var AE_ST_NIGHT_FLOOR = 1.5e-6;     // the faintest light the eye is set to (relative to the Sun at the Earth being 1)
var AE_ST_GROUND_ALBEDO_REF = 0.3;  // the ground the exposure is set by
var AE_ST_EXPOSURE_TARGET = 0.5;    // 1 - exp(-L k) of the reference ground: about 0.65 on screen
var AE_ST_SCATTER_GAIN = 2.0;       // scattered light over what one bounce gives (the air's other bounces, the ground's glow)
var AE_ST_SKY_NIGHT_DISPLAY = 0;    // nothing added to the sky on the screen (the stars and the Milky Way are drawn apart)
var AE_ST_LUX_PER_UNIT = 1.3e5;     // the Sun at the Earth, lux
var AE_ST_LM_DARK = 7.6, AE_ST_LM_PER_DECADE = 1.5, AE_ST_LM_MAX = 7.9, AE_ST_LM_MIN = -4.5, AE_ST_DARK_LUM = 1.7e-4;   // almanac-skygl.js SG_LM_*

// The air in GLSL: the same numbers as uniforms, so one shader serves every body.
var AE_ST_GLSL_ATMO = [
  'uniform float uR, uRc, uH0, uTop, uAtmo;',                 // radius, ground sphere's radius, ground height (km), top, 1 when the body has rays
  'uniform vec3 uRay, uMieExt, uMieAlb, uMieG, uOzone, uSunDir, uSunE;',
  'uniform float uHR, uHM, uMs, uGainS;',
  'const float PI = ' + AE_ST_PI + ';',
  'float heightKm(vec3 p) { vec3 q = vec3(p.xy, p.z + uRc); return (dot(p, p) + 2.0 * p.z * uRc + uH0 * (uRc + uR)) / (length(q) + uR); }',
  'vec3 sigmaExt(float h) { h = max(h, 0.0); return uRay * exp(-h / uHR) + uMieExt * exp(-h / uHM) + uOzone * max(0.0, 1.0 - abs(h - 25.0) / 15.0); }',
  'float sphereFar(vec3 p, vec3 d, float Rs) { vec3 q = vec3(p.xy, p.z + uRc); float lq = length(q), c = (lq - Rs) * (lq + Rs), b = dot(q, d), D = b * b - c; return D < 0.0 ? -1.0 : -b + sqrt(D); }',
  'float sphereNear(vec3 p, vec3 d, float Rs) { vec3 q = vec3(p.xy, p.z + uRc); float lq = length(q), c = (lq - Rs) * (lq + Rs), b = dot(q, d), D = b * b - c; return D < 0.0 ? -1.0 : -b - sqrt(D); }',
  // The Sun's light at a point: nothing in the planet's shadow, else thinned by the air along the way up.
  'vec3 sunTrans(vec3 p) {',
  '  vec3 q = vec3(p.xy, p.z + uRc); float b = dot(q, uSunDir), lq = length(q), c = (lq - uRc) * (lq + uRc), D = b * b - c;',
  '  if (b < 0.0 && D > 0.0 && -b - sqrt(D) > 0.01) return vec3(0.0);',
  '  if (uAtmo < 0.5) return vec3(1.0);',
  '  float Lt = sphereFar(p, uSunDir, uR + uTop); vec3 od = vec3(0.0); float tp = 0.0;',
  '  for (int i = 0; i < ' + AE_ST_STEPS_SUN + '; i++) { float f = float(i + 1) / ' + AE_ST_STEPS_SUN + '.0, t = Lt * f * f, dt = t - tp; od += sigmaExt(heightKm(p + uSunDir * (tp + 0.5 * dt))) * dt; tp = t; }',
  '  return exp(-od);',
  '}',
  // Where the ray o + t d is inside the air (t0..t1), ending at the ground if it meets it; false if it never is.
  'bool airSpan(vec3 o, vec3 d, out float t0, out float t1) {',
  '  float far = sphereFar(o, d, uR + uTop);',
  '  if (far < 0.0) return false;',
  '  t0 = max(sphereNear(o, d, uR + uTop), 0.0); t1 = far;',
  '  float g = sphereNear(o, d, uRc);',
  '  if (g > t0 && g < t1) t1 = g;',
  '  return t1 > t0;',
  '}'
].join('\n');
// The light a ray collects along ray o + t d (t from 0 to tmax) and what is left of what was behind it.
function _aeStInscatterGlsl(name, steps) {
  return [
    'vec3 ' + name + '(vec3 o, vec3 d, float tmax, out vec3 T) {',
    '  T = vec3(1.0); vec3 col = vec3(0.0);',
    '  float cosS = dot(d, uSunDir), phR = 3.0 / (16.0 * PI) * (1.0 + cosS * cosS);',
    '  vec3 g = uMieG, phM = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * cosS, vec3(1.5)));',
    '  float tp = 0.0;',
    '  for (int i = 0; i < ' + steps + '; i++) {',
    '    float f = float(i + 1) / ' + steps + '.0, t = tmax * f * f, dt = t - tp;',
    '    vec3 p = o + d * (tp + 0.5 * dt); float h = max(heightKm(p), 0.0);',
    '    vec3 sR = uRay * exp(-h / uHR), sM = uMieExt * uMieAlb * exp(-h / uHM), ext = sigmaExt(h), stepT = exp(-ext * dt);',
    '    vec3 sun = sunTrans(p) * uSunE;',
    '    vec3 S = sun * (sR * phR + sM * phM) + sun * (sR + sM) * uMs * 0.0796;',
    '    col += T * S * (vec3(1.0) - stepT) / max(ext, vec3(1e-9)) * ' + AE_ST_SCATTER_GAIN.toFixed(2) + ' * uGainS;',
    '    T *= stepT; tp = t;',
    '  }',
    '  return col;',
    '}'
  ].join('\n');
}
var AE_ST_GLSL_TONE = 'vec3 tone(vec3 L, float k) { return pow(vec3(1.0) - exp(-L * k), vec3(1.0 / ' + AE_ST_GAMMA + ')); }';
var AE_ST_GLSL_NOISE = [
  'float hash31(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }',
  'float vnoise(vec3 p) {',
  '  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
  '  return mix(mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x), mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),',
  '             mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x), mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y), f.z) * 2.0 - 1.0;',
  '}'
].join('\n');

// ── The sky ──
// Drawn first, edge to edge. Looking down at the planet from above its air, the planet itself (the terrain) is drawn over
// this; what is seen here is the air and the black beyond.
var AE_ST_SKY_VERT = [
  'varying vec2 vNdc;',
  'void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.9999, 1.0); }'
].join('\n');
var AE_ST_SKY_FRAG = [
  'precision highp float;',
  AE_ST_GLSL_ATMO, AE_ST_GLSL_TONE,
  _aeStInscatterGlsl('inscatterSky', AE_ST_STEPS_SKY),
  'uniform vec3 uCam, uFwd, uRight, uUp; uniform vec2 uTan; uniform float uK;',
  'uniform float uDiffuse; uniform vec3 uDiffSky;',
  'uniform sampler2D uMilky; uniform float uMw; uniform mat3 uToGal;',      // the Milky Way: its panorama, its strength, local -> galactic
  'varying vec2 vNdc;',
  'void main() {',
  '  vec3 d = normalize(uFwd + uRight * vNdc.x * uTan.x + uUp * vNdc.y * uTan.y), L = vec3(0.0), T;',
  '  if (uDiffuse > 0.5) { L = uDiffSky * (0.7 + 0.3 * smoothstep(-0.1, 0.5, d.z)); }',
  '  else if (uAtmo > 0.5) {',
  '    if (uCam.z < 10.0 && sphereNear(uCam, d, uRc) > 0.0 && length(d.xy) > 1e-4) {',
  '      float rr = uRc / (uRc + max(uCam.z, 0.0)), sz = -sqrt(max(0.0, 1.0 - rr * rr)); d = vec3(normalize(d.xy) * sqrt(1.0 - sz * sz), sz);',
  '    }',
  '    float t0, t1; if (airSpan(uCam, d, t0, t1)) L = inscatterSky(uCam + d * t0, d, t1 - t0, T);',
  '  }',
  '  vec3 c = tone(L, uK);',
  '  if (uMw > 0.0) {',
  '    vec3 g = uToGal * d; float l = atan(g.y, g.x), b = asin(clamp(g.z, -1.0, 1.0));',
  '    c += texture2D(uMilky, vec2(0.5 - l / (2.0 * PI), 0.5 - b / PI)).rgb * uMw;',
  '  }',
  '  gl_FragColor = vec4(c, 1.0);',
  '}'
].join('\n');

// ── Stars ──
var AE_ST_STARS_VERT = [
  'attribute float aMag; attribute vec3 aColor;',
  'uniform mat3 uRot; uniform float uLim, uExtinct, uDpr, uStarScale;',
  'varying vec3 vCol; varying float vA;',
  'void main() {',
  '  vec3 l = uRot * position; float s = max(l.z, 0.0), X = 1.0 / (s + 0.025 * exp(-11.0 * s));',
  '  float m = aMag + uExtinct * X, d = uLim - m, f = clamp(d / 0.6, 0.0, 1.0);',
  '  float vis = d <= 0.0 ? 0.0 : f * f * (3.0 - 2.0 * f) * min(1.0, 0.12 * pow(10.0, 0.2 * d));',
  '  vCol = aColor; vA = vis;',
  '  gl_PointSize = max(1.0, (1.1 + 0.35 * clamp(d, 0.0, 6.0)) * uDpr * uStarScale);',
  '  gl_Position = vis <= 0.0 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * vec4(mat3(viewMatrix) * l * 10.0, 1.0);',   // a star too faint to show is clipped, not drawn and discarded
  '}'
].join('\n');
var AE_ST_STARS_FRAG = [
  'precision highp float; varying vec3 vCol; varying float vA;',
  'void main() { vec2 c = gl_PointCoord - 0.5; float a = vA * (1.0 - smoothstep(0.15, 0.5, length(c))); if (a < 0.003) discard; gl_FragColor = vec4(vCol, a); }'
].join('\n');

// ── The Sun and the other bodies that are up ──
// A quad on the sky round the body's direction, drawn as a lit disc (a phase if it is a sphere lit from the side) with the
// light thinned by the air along its line of sight; below a pixel in size it is a point of the star's kind, from its
// magnitude. The Sun adds its own glow.
var AE_ST_BODY_VERT = [
  'uniform vec3 uDir, uRight, uUp; uniform float uHalf;',
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = position.xy; vec3 l = normalize(uDir + (uRight * position.x + uUp * position.y) * uHalf);',
  '  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * l * 10.0, 1.0);',
  '}'
].join('\n');
var AE_ST_BODY_FRAG = [
  'precision highp float;', AE_ST_GLSL_TONE,
  'uniform vec3 uDir, uRight, uUp, uSunFrom, uTint, uTrans; uniform float uHalf, uRho, uPix, uE, uK, uEmit, uVis, uGlow, uSkyLit;',
  'uniform sampler2D uMap; uniform float uMapped, uGrey, uMapGain; uniform mat3 uBody;',                    // the body's own map, and local -> body-fixed
  'uniform sampler2D uRingMap; uniform float uRings, uRp; uniform vec3 uRingN, uCen; uniform vec2 uRing;',    // Saturn's rings: plane, centre and size (km)
  'varying vec2 vUv;',
  'const float PI = ' + AE_ST_PI + ';',
  // The colour of the disc at a point of it (n: the unit normal toward the sky).
  'vec3 discAlbedo(vec3 n) {',
  '  if (uMapped < 0.5) return uTint;',
  '  vec3 nb = uBody * n; vec2 uv = vec2(atan(nb.y, nb.x) / (2.0 * PI) + 0.5, asin(clamp(nb.z, -1.0, 1.0)) / PI + 0.5);',
  '  vec2 dx = dFdx(uv), dy = dFdy(uv); dx.x -= floor(dx.x + 0.5); dy.x -= floor(dy.x + 0.5);',
  '  vec3 m = textureGrad(uMap, uv, dx, dy).rgb; if (uGrey > 0.5) m = vec3(m.r);',
  '  return pow(m, vec3(' + AE_ST_GAMMA + ')) * uMapGain;',
  '}',
  'void main() {',
  '  vec2 o = vUv * uHalf; float a = length(o);',                    // radians from the body's centre
  '  vec3 col = vec3(0.0); float alpha = 0.0;',
  '  float edge = max(uPix * 0.75, 1e-7);',
  '  bool disc = uEmit > 0.5 || uRho > uPix * 1.2;',
  '  float R = uEmit > 0.5 ? max(uRho, uPix * 0.8) : uRho;',               // the Sun is at least a pixel, its light kept
  '  float cov = 0.0;',
  '  if (disc) {',
  '    cov = 1.0 - smoothstep(R - edge, R + edge, a);',
  '    if (cov > 0.0) {',
  '      vec2 q = o / R; float r2 = min(dot(q, q), 1.0);',
  '      vec3 n = uRight * q.x + uUp * q.y - uDir * sqrt(1.0 - r2);',
  '      if (uEmit > 0.5) {',
  '        float limb = 1.0 - 0.45 * (1.0 - sqrt(1.0 - r2)), kept = (uRho * uRho) / (R * R);',
  '        col = tone(uTrans * (' + AE_ST_SUN_DISC_GAIN.toExponential(2) + ' * uE * limb * kept), uK);',
  '      } else {',
  '        float lam = smoothstep(-0.02, 0.1, dot(n, uSunFrom)) * max(dot(n, uSunFrom), 0.0);',
  '        col = tone(discAlbedo(n) * uE * lam / PI * uTrans, uK);',
  '      }',
  '      alpha = cov;',
  '    }',
  '  } else {',
  '    float s = max(uPix * 1.4, uRho * 1.2); float g = exp(-pow(a / s, 2.0) * 1.6);',
  '    col = uTint * mix(vec3(1.0), uTrans / max(max(uTrans.r, uTrans.g), max(uTrans.b, 1e-6)), 0.7); alpha = g * uVis;',
  '  }',
  // Rings: the plane through the planet's centre, its profile by radius, lit by the Sun and dark in the planet's shadow,
  // behind the planet's disc where the planet is nearer along the ray.
  '  if (uRings > 0.5) {',
  '    vec3 d = normalize(uDir + (uRight * vUv.x + uUp * vUv.y) * uHalf); float dn = dot(d, uRingN);',
  '    if (abs(dn) > 1e-5) {',
  '      float t = dot(uCen, uRingN) / dn;',
  '      if (t > 0.0) {',
  '        vec3 P = d * t; float rr = length(P - uCen), u = (rr - uRing.x) / (uRing.y - uRing.x);',
  '        if (u > 0.0 && u < 1.0) {',
  '          vec4 rm = texture2D(uRingMap, vec2(u, 0.5));',
  '          float tb = dot(uCen, d), disc2 = tb * tb - dot(uCen, uCen) + uRp * uRp;',
  '          bool front = disc2 <= 0.0 || t < tb - sqrt(disc2);',
  '          if (front && rm.a > 0.0) {',
  '            vec3 L = uSunFrom; float b = dot(uCen - P, L), miss = length(uCen - P - L * b);',
  '            float shade = (b > 0.0 && miss < uRp) ? 0.08 : 1.0, side = step(0.0, dot(uRingN, L) * dot(uRingN, -d));',
  '            float lit = mix(0.35, 1.0, side) * max(abs(dot(uRingN, L)), 0.12);',
  '            vec3 rc = tone(rm.rgb * uE * lit * shade * 0.5 * uTrans, uK);',
  '            col = mix(col, rc, rm.a); alpha = max(alpha, rm.a);',
  '          }',
  '        }',
  '      }',
  '    }',
  '  }',
  '  if (uGlow > 0.0) {',
  '    float h = uRho * 1.0, s = a / max(h, 1e-6);',
  '    float glow = uGlow / (1.0 + s * s * 0.5) * uSkyLit;',
  '    col += uTint * mix(vec3(1.0), uTrans / max(max(uTrans.r, uTrans.g), max(uTrans.b, 1e-6)), 0.8) * glow; alpha = max(alpha, min(1.0, glow));',
  '  }',
  '  if (alpha <= 0.002) discard;',
  '  gl_FragColor = vec4(col, alpha);',
  '}'
].join('\n');

// ── The ground ──
// The small sky stretched over the screen: device pixels over the screen's size.
var AE_ST_BLIT_FRAG = [
  'precision highp float;',
  'uniform sampler2D tSky; uniform vec2 uRes;',
  'void main() { gl_FragColor = vec4(texture2D(tSky, gl_FragCoord.xy / uRes).rgb, 1.0); }'
].join('\n');
var AE_ST_GROUND_VERT = [
  'attribute vec3 aDir; attribute vec3 aNrm; attribute float aH; attribute float aSea; attribute float aShade;',
  'varying vec3 vP, vN, vDir; varying float vH, vSea, vShade;',
  'void main() {',
  '  vP = position; vN = aNrm; vDir = aDir; vH = aH; vSea = aSea; vShade = aShade;',
  '  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);',
  '}'
].join('\n');
var AE_ST_GROUND_FRAG = [
  'precision highp float;',
  AE_ST_GLSL_ATMO, AE_ST_GLSL_TONE, AE_ST_GLSL_NOISE,
  _aeStInscatterGlsl('inscatterGround', AE_ST_STEPS_GROUND),
  'uniform vec3 uCam; uniform float uK, uPixAng, uTime;',
  'uniform sampler2D uMap; uniform float uMapped, uGrey; uniform vec3 uBase, uGain;',
  'uniform vec3 uAmbient, uSkyHor, uSkyZen, uE2, uDir2;',
  'uniform float uLommel, uRough, uRock, uDiffuse, uVis, uDirect; uniform vec3 uDiffSky;',
  'varying vec3 vP, vN, vDir; varying float vH, vSea, vShade;',
  // Rock, fractal bumps and mottling at the scales a pixel can show, all fixed to the ground (the camera never moves on it).
  'float fine(vec3 p, float foot) {',
  '  float h = 0.0;',
  '  for (int i = 0; i < 7; i++) {',
  '    float s = 0.05 * pow(3.1, float(i)), w = 1.0 - smoothstep(0.25, 0.9, 2.2 * foot / s);',
  '    if (w > 0.0) h += vnoise(p / s + float(i) * 7.3) * 0.2 * s * w;',
  '  }',
  '  return h * uRough;',
  '}',
  // Stones in three sizes, each a rounded lump of its own shape that is darker or paler than the ground: returns the height
  // (metres) and the brightness they change the ground by.
  'vec2 rocks(vec3 p, float foot) {',
  '  if (uRock < 0.02) return vec2(0.0);',   // ground with next to no stones (the Earth's) skips the search
  '  float h = 0.0, shade = 0.0;',
  '  for (int k = 0; k < 3; k++) {',
  '    float s = k == 0 ? 0.13 : (k == 1 ? 0.5 : 1.9), w = 1.0 - smoothstep(0.3, 1.0, 2.5 * foot / s);',
  '    if (w <= 0.0) continue;',
  '    vec3 c = floor(p / s), f = fract(p / s); float best = 9.0, rr = 0.0, tone = 0.0;',
  '    for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) {',
  '      vec3 g = vec3(float(dx), float(dy), float(k)), id = c + g; float present = step(hash31(id + 3.1), uRock);',
  '      vec3 pos = g - vec3(0.0, 0.0, float(k)) + vec3(hash31(id), hash31(id + 1.7), 0.0) - f;',
  '      float lump = 0.75 + 0.5 * hash31(id + 5.3), rad = (0.16 + 0.22 * hash31(id + 9.2)) * present;',
  '      pos.x *= lump; float dd = length(pos.xy) / max(rad, 1e-4);',
  '      if (present > 0.5 && dd < best) { best = dd; rr = rad * s; tone = hash31(id + 13.7); }',
  '    }',
  '    if (best < 1.0) { float dome = 1.0 - best * best; h += rr * 0.9 * dome * w; shade += (tone - 0.5) * 0.9 * w * (1.0 - best * best); }',
  '  }',
  '  return vec2(h, shade);',
  '}',
  'void main() {',
  '  float dist = length(vP - uCam); vec3 V = (uCam - vP) / dist;',
  '  vec3 N = normalize(vN), upF = normalize(vec3(vP.xy, vP.z + uRc * 1000.0));',
  '  float foot = dist * uPixAng;',
  '  vec2 uv = vec2(atan(vDir.y, vDir.x) / (2.0 * PI) + 0.5, asin(clamp(vDir.z, -1.0, 1.0)) / PI + 0.5);',
  '  vec3 map = uBase;',
  '  if (uMapped > 0.5) { vec2 dx = dFdx(uv), dy = dFdy(uv); dx.x -= floor(dx.x + 0.5); dy.x -= floor(dy.x + 0.5); map = textureGrad(uMap, uv, dx, dy).rgb; if (uGrey > 0.5) map = vec3(map.r); }',
  '  vec3 alb = pow(map, vec3(' + AE_ST_GAMMA + ')) * uGain;',
  '  float mott = 0.0, wm = 1.0;',
  '  for (int i = 0; i < 4; i++) { float s = 0.4 * pow(4.0, float(i)); wm = 1.0 - smoothstep(0.3, 1.0, 3.0 * foot / s); if (wm > 0.0) mott += vnoise(vP / s + 31.0 * float(i)) * 0.18 * wm; }',
  '  alb *= (1.0 + mott);',
  '  vec2 rk = (vSea > 0.5 || dist > ' + AE_ST_ROCK_FADE_M[1].toFixed(1) + ') ? vec2(0.0) : rocks(vP, foot) * (1.0 - smoothstep(' + AE_ST_ROCK_FADE_M[0].toFixed(1) + ', ' + AE_ST_ROCK_FADE_M[1].toFixed(1) + ', dist)); float hb = vSea > 0.5 ? 0.0 : fine(vP, foot) + rk.x; alb *= clamp(1.0 + 0.5 * rk.y, 0.35, 1.8);',
  '  vec3 dpx = dFdx(vP), dpy = dFdy(vP); float hx = dFdx(hb), hy = dFdy(hb);',
  '  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx); float det = dot(dpx, r1);',
  '  vec3 gr = sign(det) * (hx * r1 + hy * r2) * smoothstep(0.03, 0.3, dot(N, V)), Nb = abs(det) * N + gr; if (dot(Nb, Nb) > 0.0) N = normalize(Nb);',
  '  vec3 L;',
  '  vec3 pk = vP * 0.001;',
  '  if (vSea > 0.5) {',
  '    vec3 Nw = normalize(N + 0.035 * vec3(vnoise(vec3(vP.xy * 0.9, uTime * 0.7)), vnoise(vec3(vP.xy * 0.9 + 17.0, uTime * 0.6)), 0.0));',
  '    vec3 R = reflect(-V, Nw); float F = 0.02 + 0.98 * pow(1.0 - max(dot(V, Nw), 0.0), 5.0);',
  '    vec3 sky = mix(uSkyHor, uSkyZen, pow(clamp(R.z, 0.0, 1.0), 0.5));',
  '    vec3 sT = sunTrans(pk) * uSunE * vShade;',
  '    vec3 deep = vec3(0.02, 0.06, 0.09) * (sT * max(dot(upF, uSunDir), 0.0) / PI * 0.4 + uAmbient);',
  '    L = mix(deep, sky, F) + sT * pow(max(dot(R, uSunDir), 0.0), 1400.0) * 10.0;',
  '  } else {',
  '    vec3 sT = sunTrans(pk) * uSunE * vShade;',
  '    float ndl = dot(N, uSunDir), mu0 = max(ndl, 0.0), mu = max(dot(N, V), 0.03);',
  '    float lam = uLommel > 0.5 ? 2.0 * mu0 / (mu0 + mu) : mu0;',
  '    float surge = uLommel > 0.5 ? 1.0 + 0.55 * exp(-acos(clamp(dot(uSunDir, V), -1.0, 1.0)) / 0.1) : 1.0;',
  '    L = alb * (sT * lam * surge / PI + uAmbient * (0.55 + 0.45 * dot(N, upF)) + uE2 * max(dot(N, uDir2), 0.0) / PI);',
  '  }',
  '  if (uDiffuse > 0.5) { float T = exp(-dist * 0.001 / uVis); L = L * T + uDiffSky * (1.0 - T); }',
  '  else if (uAtmo > 0.5) {',
  '    vec3 o = uCam * 0.001, d = -V, Tt, ins; float t0, t1;',
  '    if (airSpan(o, d, t0, t1)) { t1 = min(t1, dist * 0.001); if (t1 > t0) { ins = inscatterGround(o + d * t0, d, t1 - t0, Tt); L = L * Tt + ins; } }',
  '  }',
  '  gl_FragColor = vec4(tone(L, uK), 1.0);',
  '}'
].join('\n');

// ── CPU twins ──
// The same air in JS, for what the shaders do not hand back: how much a body's light is thinned on its way down
// (so the Sun is red at the horizon), the sky's light overhead (the exposure, how many stars show, the ambient on the
// ground). Optical depth of a ray from height h km (above the body's mean radius) at the sine of its elevation mu.
function _aeStSigma(a, h) {
  h = Math.max(h, 0);
  var m = a.mie, oz = Math.max(0, 1 - Math.abs(h - 25) / 15), out = [];
  for (var k = 0; k < 3; k++) out.push(a.ray[k] * Math.exp(-h / a.hR) + m.ext[k] * Math.exp(-h / m.h) + a.ozone[k] * oz);
  return out;
}
// The optical depth (per channel) of the ray from a point at height h km in the direction whose elevation sine is mu
// (from the local horizontal; negative points down), up to the top of the air; null if the planet is in the way.
function _aeStOdUp(a, R, h, mu) {
  var r = R + h, Rt = R + a.top, c = mu;   // c: cosine from the vertical = elevation sine
  if (c < 0 && r * r * (1 - c * c) < R * R) return null;
  var tTop = -r * c + Math.sqrt(Math.max(0, r * r * c * c + Rt * Rt - r * r)), od = [0, 0, 0], tp = 0, n = 10;
  for (var i = 0; i < n; i++) {
    var f = (i + 1) / n, t = tTop * f * f, dt = t - tp, tm = tp + dt / 2;
    var rr = Math.sqrt(r * r + 2 * r * tm * c + tm * tm), s = _aeStSigma(a, rr - R);
    for (var k = 0; k < 3; k++) od[k] += s[k] * dt;
    tp = t;
  }
  return od;
}
// The light a ray collects from the viewer (camKm above the ground at the foot, planet centre straight below at the ground sphere's
// radius R + h0): the GLSL inscatter in double precision, per unit of the Sun's irradiance. d and sunDir are unit vectors in the
// local frame (east, north, up); tmax of null runs to the top of the air.
function _aeStInscatter(a, R, h0, camKm, d, sunDir, tmax) {
  var Rc = R + h0, Rt = R + a.top, o = [0, 0, camKm];
  function dot(u, v) { return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; }
  function sunTrans(p) {
    var q = [p[0], p[1], p[2] + Rc], b = dot(q, sunDir), lq = Math.sqrt(dot(q, q)), c = (lq - Rc) * (lq + Rc), D = b * b - c;
    if (b < 0 && D > 0 && -b - Math.sqrt(D) > 0.01) return [0, 0, 0];
    var Dt = b * b - (lq - Rt) * (lq + Rt), Lt = -b + Math.sqrt(Math.max(0, Dt)), od = [0, 0, 0], tp = 0, n = 5;
    for (var i = 0; i < n; i++) {
      var f = (i + 1) / n, t = Lt * f * f, dt = t - tp, tm = tp + dt / 2;
      var pp = [q[0] + sunDir[0] * tm, q[1] + sunDir[1] * tm, q[2] + sunDir[2] * tm], s = _aeStSigma(a, Math.sqrt(dot(pp, pp)) - R);
      for (var k = 0; k < 3; k++) od[k] += s[k] * dt;
      tp = t;
    }
    return od.map(function (x) { return Math.exp(-x); });
  }
  var qo = [o[0], o[1], o[2] + Rc], bo = dot(qo, d), lo = Math.sqrt(dot(qo, qo));
  var Dtop = bo * bo - (lo - Rt) * (lo + Rt);
  if (Dtop < 0) return [0, 0, 0];
  var t0 = Math.max(0, -bo - Math.sqrt(Dtop)), t1 = -bo + Math.sqrt(Dtop), Dg = bo * bo - (lo - Rc) * (lo + Rc);
  if (Dg > 0) { var tg = -bo - Math.sqrt(Dg); if (tg > t0 && tg < t1) t1 = tg; }
  if (tmax != null) t1 = Math.min(t1, tmax);
  if (t1 <= t0) return [0, 0, 0];
  var span = t1 - t0, cosS = dot(d, sunDir), phR = 3 / (16 * Math.PI) * (1 + cosS * cosS), out = [0, 0, 0], T = [1, 1, 1], tp = 0, n = 14;
  for (var i = 0; i < n; i++) {
    var f = (i + 1) / n, t = span * f * f, dt = t - tp, tm = t0 + tp + dt / 2;
    var p = [o[0] + d[0] * tm, o[1] + d[1] * tm, o[2] + d[2] * tm], hh = Math.max(Math.sqrt(dot([p[0], p[1], p[2] + Rc], [p[0], p[1], p[2] + Rc])) - R, 0);
    var sg = _aeStSigma(a, hh), sun = sunTrans(p);
    for (var k = 0; k < 3; k++) {
      var g = a.mie.g[k], phM = (1 - g * g) / (4 * Math.PI * Math.pow(1 + g * g - 2 * g * cosS, 1.5));
      var sR = a.ray[k] * Math.exp(-hh / a.hR), sM = a.mie.ext[k] * a.mie.alb[k] * Math.exp(-hh / a.mie.h);
      var S = sun[k] * (sR * phR + sM * phM) + sun[k] * (sR + sM) * a.ms * 0.0796, step = Math.exp(-sg[k] * dt);
      out[k] += T[k] * S * (1 - step) / Math.max(sg[k], 1e-9) * AE_ST_SCATTER_GAIN * (a.gain || 1);
      T[k] *= step;
    }
    tp = t;
  }
  return out;
}
// The sky overhead for the Sun at elevation sine sunMu (the sun's bearing does not matter straight up).
function _aeStZenith(a, R, h, sunMu) {
  return _aeStInscatter(a, R, h, 0, [0, 0, 1], [Math.sqrt(1 - sunMu * sunMu), 0, sunMu], null);
}
