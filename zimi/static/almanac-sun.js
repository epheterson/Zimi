// ── The Sun close up: prominences, flares, a finer surface ──
// Loaded by almanac-earth.js the first time the Sun is wide on screen (_aeSunFxWanted); from the Earth it is a small
// disc the plain shaders draw. It swaps the Sun's two shaders (AE_SUN_FRAG, AE_SUN_GLOW_FRAG, where the markers
// "@sunfx-..." say what goes in) for fuller ones, and feeds them what stands on the Sun at the page's clock.
//
// Nothing here is live data: no one can say offline what the Sun is doing, so like the sunspots (_aeSunSpots) they are
// made up by the Sun's own rules, and the same instant always shows the same Sun (the view says so, alm_earth_sun_spots):
//   - Active-region loops: a group's leader and follower are joined by a bright arch standing off the limb, taller the
//     wider the pair (the loops of a real active region), and white-hot while a flare of that group lasts.
//   - Flares: a group's flares are born on days seeded by the group, each a fast rise and a slow fade (minutes to an
//     hour: at real time most moments show none, at a faster clock they flash), more of them for a bigger group.
//   - Prominences: cool Halpha filaments along the quiet Sun, 4 to 14 days a piece, carried round by the Sun's own
//     differential rotation (Snodgrass), standing 0.05 to 0.2 of the Sun's radius off the limb (the real ones reach
//     about 0.15, drawn a little taller to be seen).
//   - The surface: a second, finer granulation where the cells are wide enough on screen to show it, and the thin red
//     chromosphere at the limb.

var AE_SUNFX_PROMS = 8, AE_SUNFX_FLARES = 4, AE_SUNFX_ARCH_STEPS = 14;
var AE_SUNFX_STEP_MS = 60000;                  // the events again after this much shown time (a flare lasts minutes)
var AE_SUNFX_SLOT_DAYS = 6;                    // quiet prominences are born in slots this long
var AE_PROM_LIFE_DAYS = [4, 14];
var AE_PROM_GROW_DAYS = 1.5;
var AE_PROM_LAT_MAX_DEG = 65;                  // none near the poles
var AE_PROM_LEN_DEG = [8, 28];                 // a filament's length along the surface
var AE_PROM_TILT_DEG = 6;                      // the filament's slope against the parallels
var AE_PROM_SALT = 104729;
var AE_LOOP_MIN_R_DEG = 3.5;                   // a group needs a leader this large (radius, degrees) to be given a loop
var AE_LOOP_MAX = 3;
var AE_LOOP_BASE_HEIGHT = 0.03, AE_LOOP_HEIGHT_PER_DEG = 0.01, AE_LOOP_GLOW = 0.3;
var AE_FLARE_SALT = 17;
var AE_FLARE_MAX_PER_GROUP = 4;
var AE_FLARE_ACTIVE_MIN = 0.02;                // under this a flare is gone
var AE_FLARE_STRENGTH = [0.35, 1];
var AE_FLARE_LOOP_GAIN = 2.5;                  // how much a flare brightens its group's loop
var AE_SUNFX_FINE_SCALE = 2.7;                 // the finer granulation, in cells of the first

// The longitude (degrees from the node) of a feature born at bornMs on Carrington longitude carr, at ms, its latitude's
// own rotation carrying it (the sunspots' rule, _aeSunSpots).
function _aeSunFxLon(bornMs, carr, lat, ms) {
  var bornDays = (bornMs - Date.UTC(2000, 0, 1, 12)) / MS_PER_DAY;
  return AE_SUN_W0_DEG + AE_SUN_CARRINGTON_DEG_DAY * bornDays + carr + _aeSunRotation(lat) * (ms - bornMs) / MS_PER_DAY;
}
// A flare's brightness at dt minutes from its peak: quick rise, slow fade.
function _aeFlareProfile(dtMin) {
  if (dtMin < 0) { var u = dtMin / AE_FLARE_RISE_MIN; return Math.exp(-u * u); }
  return Math.exp(-dtMin / AE_FLARE_DECAY_MIN);
}
// What stands on the Sun at ms: { loops: [{a, b, h, glow, hot}], flares: [{p, k}], proms: [{a, b, h, amp}] }, the
// feet and places as unit vectors in the scene's equatorial frame, heights in solar radii.
function _aeSunEvents(ms) {
  var groups = _aeSunSpots(ms).filter(function (g) { return g.r > 0; });
  groups.sort(function (a, b) { return b.r - a.r; });
  var out = { loops: [], flares: [], proms: [] };
  groups.forEach(function (g, gi) {
    var peaks = _aeSeeded(Math.floor(g.born / 1000) + AE_FLARE_SALT), k = 0, n = Math.floor(peaks() * peaks() * AE_FLARE_MAX_PER_GROUP + g.r / 6);
    for (var i = 0; i < n; i++) {
      var peak = g.born + peaks() * g.life * MS_PER_DAY, strength = AE_FLARE_STRENGTH[0] + (AE_FLARE_STRENGTH[1] - AE_FLARE_STRENGTH[0]) * peaks();
      k += strength * _aeFlareProfile((ms - peak) / 60000);
    }
    // At the middle of the pair, between leader and follower.
    var midLat = (g.lat + g.followerLat) / 2, midLon = g.lon - g.sep / 2;
    if (k > AE_FLARE_ACTIVE_MIN) out.flares.push({ p: _aeSolarVec(midLat, midLon, 0), k: Math.min(1.5, k) });
    if (g.r >= AE_LOOP_MIN_R_DEG && out.loops.length < AE_LOOP_MAX) {
      out.loops.push({ a: _aeSolarVec(g.lat, g.lon, 0), b: _aeSolarVec(g.followerLat, g.lon - g.sep, 0),
        h: AE_LOOP_BASE_HEIGHT + AE_LOOP_HEIGHT_PER_DEG * g.sep, glow: AE_LOOP_GLOW + AE_FLARE_LOOP_GAIN * k * (k > AE_FLARE_ACTIVE_MIN ? 1 : 0), hot: k });
    }
  });
  out.flares.sort(function (a, b) { return b.k - a.k; });
  out.flares.length = Math.min(out.flares.length, AE_SUNFX_FLARES);
  var slot = Math.floor(ms / MS_PER_DAY / AE_SUNFX_SLOT_DAYS);
  for (var s = slot - Math.ceil(AE_PROM_LIFE_DAYS[1] / AE_SUNFX_SLOT_DAYS); s <= slot; s++) {
    var rnd = _aeSeeded(s * AE_PROM_SALT + 7), count = 1 + (rnd() < 0.5 ? 1 : 0) + (rnd() < 0.25 ? 1 : 0);
    for (var c = 0; c < count; c++) {
      var lat = (rnd() * 2 - 1) * AE_PROM_LAT_MAX_DEG, carr = rnd() * 360;
      var born = (s * AE_SUNFX_SLOT_DAYS + rnd() * AE_SUNFX_SLOT_DAYS) * MS_PER_DAY;
      var life = AE_PROM_LIFE_DAYS[0] + (AE_PROM_LIFE_DAYS[1] - AE_PROM_LIFE_DAYS[0]) * rnd();
      var len = AE_PROM_LEN_DEG[0] + (AE_PROM_LEN_DEG[1] - AE_PROM_LEN_DEG[0]) * rnd();
      var tilt = (rnd() - 0.5) * 2 * AE_PROM_TILT_DEG, h = AE_PROM_HEIGHT[0] + (AE_PROM_HEIGHT[1] - AE_PROM_HEIGHT[0]) * rnd();
      var age = (ms - born) / MS_PER_DAY;
      if (age < 0 || age > life) continue;
      var amp = Math.min(1, age / AE_PROM_GROW_DAYS) * (1 - Math.pow(age / life, 3));
      var lon = _aeSunFxLon(born, carr, lat, ms);
      out.proms.push({ a: _aeSolarVec(lat, lon, 0), b: _aeSolarVec(lat + tilt, lon - len, 0), h: h * Math.sqrt(amp), amp: amp });
    }
  }
  return out;
}

// What the shaders take, in the order they were declared: the prominence slots (a: x y z height; b: x y z brightness,
// positive a cool filament, negative a hot loop), then the flare slots (x y z strength).
function _aeSunFxPack(ev, promA, promB, flares) {
  promA.fill(0); promB.fill(0); flares.fill(0);
  var n = 0;
  ev.loops.forEach(function (l) {
    if (n >= AE_SUNFX_PROMS) return;
    promA.set([l.a[0], l.a[1], l.a[2], l.h], n * 4);
    promB.set([l.b[0], l.b[1], l.b[2], -l.glow], n * 4);
    n++;
  });
  ev.proms.sort(function (a, b) { return b.amp - a.amp; }).forEach(function (p) {
    if (n >= AE_SUNFX_PROMS) return;
    promA.set([p.a[0], p.a[1], p.a[2], p.h], n * 4);
    promB.set([p.b[0], p.b[1], p.b[2], p.amp], n * 4);
    n++;
  });
  ev.flares.forEach(function (f, i) { flares.set([f.p[0], f.p[1], f.p[2], f.k], i * 4); });
}

// The GLSL that goes in at each marker (almanac-earth.js AE_SUN_FRAG, AE_SUN_GLOW_FRAG).
var AE_SUNFX_GLSL = {
  surfaceUniforms: 'uniform vec4 uFlare[' + AE_SUNFX_FLARES + '];',
  // The nearest and second-nearest feature point as aeCells finds them, but over the 8 cells nearest the point, not 27:
  // for the second, finer octave, which every pixel of a close view pays for.
  functions: [
    'vec3 aeCells8(vec3 p) {',
    '  vec3 i = floor(p), f = p - i; float d1 = 8.0, d2 = 8.0, id = 0.0;',
    '  for (int x = 0; x < 2; x++) for (int y = 0; y < 2; y++) for (int z = 0; z < 2; z++) {',
    '    vec3 o = vec3(f.x < 0.5 ? float(x) - 1.0 : float(x), f.y < 0.5 ? float(y) - 1.0 : float(y), f.z < 0.5 ? float(z) - 1.0 : float(z));',
    '    vec3 h = aeHash3(i + o), q = o + h - f; float d = dot(q, q);',
    '    if (d < d1) { d2 = d1; d1 = d; id = h.x; } else if (d < d2) { d2 = d; }',
    '  }',
    '  return vec3(sqrt(d1), sqrt(d2), id);',
    '}'
  ].join('\n'),
  // A second octave where the cells are wider than a few pixels: nothing at a distance (no cost, no shimmer).
  cells: [
    '  float fine2 = clamp(1.6 - 0.9 * length(fwidth(q * ' + AE_SUNFX_FINE_SCALE.toFixed(1) + ')), 0.0, 1.0);',
    '  if (fine2 > 0.02) {',
    '    vec3 c2 = aeCells8(q * ' + AE_SUNFX_FINE_SCALE.toFixed(1) + ' + 13.0);',
    '    float cell2 = smoothstep(0.0, 0.25, c2.y - c2.x) * (1.2 - 0.9 * c2.x) * (0.8 + 0.4 * c2.z) - 0.6;',
    '    cell = mix(cell, 0.7 * cell + 0.6 * cell2, fine2);',
    '  }'
  ].join('\n'),
  surface: [
    '  float fl = 0.0;',
    '  for (int i = 0; i < ' + AE_SUNFX_FLARES + '; i++) {',
    '    vec4 f = uFlare[i];',
    '    if (f.w <= 0.0) continue;',
    '    float d = length(n - f.xyz), r0 = 0.035 + 0.05 * f.w;',
    '    fl += f.w * exp(-d * d / (r0 * r0));',
    '  }',
    '  e += vec3(1.0, 0.9, 0.78) * fl * 5.0;',
    '  e += vec3(0.95, 0.28, 0.2) * 0.35 * smoothstep(0.16, 0.0, mu);'
  ].join('\n'),
  glowUniforms: 'uniform vec4 uPromA[' + AE_SUNFX_PROMS + ']; uniform vec4 uPromB[' + AE_SUNFX_PROMS + '];',
  // Each arch is a run of points from one foot to the other, standing up by a half sine; a pixel's glow is how near its
  // line of sight passes them (the prominence is thin, so this is its brightness). Only near the limb is it asked.
  prominences: [
    '  vec3 cam = (cameraPosition - center) / radius;',
    '  float cool = 0.0, hot = 0.0;',
    '  if (r < 1.7) {',
    '    for (int i = 0; i < ' + AE_SUNFX_PROMS + '; i++) {',
    '      vec4 A = uPromA[i], B = uPromB[i];',
    '      if (A.w <= 0.0) continue;',
    '      float sig = 0.016 + 0.07 * A.w, sum = 0.0;',
    '      for (int k = 0; k <= ' + AE_SUNFX_ARCH_STEPS + '; k++) {',
    '        float t = float(k) / ' + AE_SUNFX_ARCH_STEPS + '.0;',
    '        vec3 p = normalize(mix(A.xyz, B.xyz, t)) * (1.0 + A.w * sin(3.14159265 * t)) - cam;',
    '        vec3 q = p - ray * dot(p, ray);',
    '        sum += exp(-dot(q, q) / (sig * sig)) * (0.8 + 0.2 * sin(uT * 2.2 + t * 11.0 + float(i) * 3.1));',
    '      }',
    '      if (B.w > 0.0) cool += sum * B.w; else hot += sum * -B.w;',
    '    }',
    '  }',
    '  col += vec3(1.0, 0.34, 0.28) * (1.0 - exp(-0.5 * cool)) + vec3(1.0, 0.85, 0.75) * (1.0 - exp(-0.35 * hot));'
  ].join('\n')
};

// A shader with each marker's line replaced; a marker not found leaves the shader as it was (the plain Sun draws).
function _aeSunFxPatch(frag, pieces) {
  var out = frag;
  for (var marker in pieces) {
    var at = '// @sunfx-' + marker;
    if (out.indexOf(at) < 0) return frag;
    out = out.replace(at, pieces[marker]);
  }
  return out;
}
function _aeSunFxInstall(S) {
  S.sunFx = { promA: new Float32Array(AE_SUNFX_PROMS * 4), promB: new Float32Array(AE_SUNFX_PROMS * 4), flares: new Float32Array(AE_SUNFX_FLARES * 4) };
  var G = AE_SUNFX_GLSL;
  var surface = _aeSunFxPatch(AE_SUN_FRAG, { uniforms: G.surfaceUniforms, functions: G.functions, cells: G.cells, surface: G.surface });
  var glow = _aeSunFxPatch(AE_SUN_GLOW_FRAG, { uniforms: G.glowUniforms, prominences: G.prominences });
  if (surface === AE_SUN_FRAG || glow === AE_SUN_GLOW_FRAG) return;   // the shaders changed under it: keep the plain Sun
  S.sunMat.uniforms.uFlare = { value: S.sunFx.flares };
  S.sunGlowMat.uniforms.uPromA = { value: S.sunFx.promA };
  S.sunGlowMat.uniforms.uPromB = { value: S.sunFx.promB };
  S.sunMat.fragmentShader = surface;
  S.sunGlowMat.fragmentShader = glow;
  S.sunMat.needsUpdate = S.sunGlowMat.needsUpdate = true;
  S.sunFx.on = true;
}
// Each frame (almanac-earth.js _aeUpdate): the first time, the shaders; then the events, again after a minute of
// shown time, so real time costs nothing and a fast clock shows them come and go.
function _aeSunFxTick(S, ms) {
  if (!S.sunFx) _aeSunFxInstall(S);
  var fx = S.sunFx;
  if (!fx.on || (fx.at != null && Math.abs(ms - fx.at) < AE_SUNFX_STEP_MS)) return;
  fx.at = ms;
  _aeSunFxPack(_aeSunEvents(ms), fx.promA, fx.promB, fx.flares);
}
