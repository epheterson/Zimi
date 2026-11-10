// ── Almanac: the live sky's air, in Stand here ──
// The card's sky is a physical model (almanac-skygl.js: Hillaire 2020's transmittance and multiple-scattering tables, a sky-view table
// for the Sun and one for the Moon, the zodiacal light, the airglow, the place's glow, and an eye that adapts). Standing on the Earth
// the ground view draws THAT sky: this file builds the same tables in the 3D view's own renderer from the same shader text, hands
// Stand here the same radiance function (SG_GLSL_RADIANCE) and the same exposure, so the two views cannot differ but in what
// the view geometry does to them. The Sun, the Moon and the exposure come from almanac-onesky.js _osSkyState, the card's own numbers.
//
// It is Stand here's air provider (_aeStandAir in almanac-stand.js): the Earth, from the ground up to OA_MAX_HEIGHT_KM (the tables
// are for an observer on a low rise, as the card's are); higher up, and on every other body, Stand here's own ray march draws.
// Stars, the Milky Way, the Sun's disc and the planets stay Stand here's.

var OA_MAX_HEIGHT_KM = 3;
var OA_VIEW_W = SG_VIEW_W, OA_VIEW_H = SG_VIEW_H;   // the sky-view tables' size: the card's
var OA_BODY = 'earth';

var _oa = null;   // { S, scene, camera, mesh, targets, mats, sunKey, moonKey, failed, uniforms }

// The sky as a function of a direction in Stand here's local frame (x east, y north, z up): the card's radiance, in Stand here's
// units (the Sun's irradiance at the Earth as 1), so that exposureK's tone matches.
var OA_GLSL = [
  'precision highp sampler2D;',
  SG_GLSL_LUT_UTIL,
  SG_GLSL_RADIANCE,
  'vec3 oaSky(vec3 d) {',
  '  float alt = max(asin(clamp(d.z, -1.0, 1.0)), 0.0), az = atan(d.x, d.y);',
  '  return skyScotopic(skyAbove(d, alt, az)) / ' + AE_ST_LUX_PER_UNIT.toExponential(3) + ';',
  '}'
].join('\n');

// The 3D view's three build exports no half-float or RGBA constants, no raw-shader material and no orthographic camera: the numbers are
// three's own (HalfFloatType, RGBAFormat), the material is a ShaderMaterial (three writes the version, the precision and the fragment
// output; the card's shader text is taken without its own), and any camera does for a pass that ignores it.
var OA_THREE_HALF_FLOAT = 1016, OA_THREE_RGBA = 1023;
function _oaTarget(T, w, h) {
  return new T.WebGLRenderTarget(w, h, { type: OA_THREE_HALF_FLOAT, format: OA_THREE_RGBA, minFilter: T.LinearFilter, magFilter: T.LinearFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
}
// A card shader as a ShaderMaterial's source: without its #version, its precision lines and its own output (gl_FragColor is three's).
function _oaSource(src) {
  return src.replace(/^#version 300 es\n/, '').replace(/precision highp (float|sampler2D);\n/g, '').replace('out vec4 outColor;\n', '').replace(/outColor/g, 'gl_FragColor');
}
function _oaMaterial(T, fs, uniforms) {
  return new T.ShaderMaterial({ vertexShader: _oaSource(SG_VS_QUAD), fragmentShader: _oaSource(fs), uniforms: uniforms, depthTest: false, depthWrite: false });
}
// One full-screen pass into a target (the quad's four corners come from gl_VertexID, as in the card).
function _oaRun(o, mat, target) {
  var r = o.S.renderer, prev = r.getRenderTarget();
  o.mesh.material = mat;
  r.setRenderTarget(target);
  r.render(o.scene, o.camera);
  r.setRenderTarget(prev);
}
// The tables that never change (transmittance, multiple scattering), once; the sky-view tables are drawn as the lights move.
function _oaBuild(S) {
  var T = S.THREE, geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(new Float32Array(12), 3));
  geo.setIndex([0, 1, 2, 2, 1, 3]);   // gl_VertexID is the index: the corners of the card's triangle strip
  var o = { S: S, scene: new T.Scene(), camera: new T.PerspectiveCamera(), failed: false, sunKey: null, moonKey: null };
  o.mesh = new T.Mesh(geo, null); o.mesh.frustumCulled = false; o.scene.add(o.mesh);
  o.trans = _oaTarget(T, SG_TRANS_W, SG_TRANS_H);
  o.multi = _oaTarget(T, SG_MS_N, SG_MS_N);
  o.viewS = _oaTarget(T, OA_VIEW_W, OA_VIEW_H);
  o.viewM = _oaTarget(T, OA_VIEW_W, OA_VIEW_H);
  o.viewE = _oaTarget(T, OA_VIEW_W, OA_VIEW_H);   // the totality ring's table: the Sun at the horizon, baked once
  var matTrans = _oaMaterial(T, SG_FS_TRANS, {});
  var matMulti = _oaMaterial(T, SG_FS_MULTI, { uTrans: { value: o.trans.texture } });
  o.matView = _oaMaterial(T, SG_FS_SKYVIEW, { uTrans: { value: o.trans.texture }, uMulti: { value: o.multi.texture }, uLightAlt: { value: 0 }, uObsHeight: { value: SG_OBSERVER_KM } });
  _oaRun(o, matTrans, o.trans);
  _oaRun(o, matMulti, o.multi);
  matTrans.dispose(); matMulti.dispose();
  o.uniforms = {
    uSkyS: o.viewS.texture, uSkyM: o.viewM.texture, uSkyE: o.viewE.texture, uEclGlow: 0, uSunAz: 0, uSunLux: 0, uMoonAz: 0, uMoonLux: 0, uGlow: [0, 0, 0], uEclPole: [0, 0, 1],
    uSunVec: [0, 0, 1], uZodiScale: 1, uAirglow: SG_AIRGLOW_LUM, uZodi: _sgZodiTable()
  };
  return o;
}
// A light's sky-view table, drawn again only when the light has moved SG_LIGHT_ALT_STEP degrees (the card's rule).
function _oaBake(o, which, altDeg) {
  var key = Math.round(altDeg / SG_LIGHT_ALT_STEP), k = which + 'Key';
  if (o[k] === key) return;
  o[k] = key;
  o.matView.uniforms.uLightAlt.value = key * SG_LIGHT_ALT_STEP * DEG_TO_RAD;
  _oaRun(o, o.matView, which === 'sun' ? o.viewS : which === 'moon' ? o.viewM : o.viewE);
}
// The light that falls on the ground and on a view's horizon and zenith, from the same tables the sky is drawn from: three numbers read
// back (once per change of the Sun's or the Moon's height, not per frame) from a 3 by 1 float target that the radiance function fills.
var OA_THREE_FLOAT = 1015;
var OA_PROBE_HORIZON_RAD = 0.05;   // the horizon sample's height over it
var OA_PROBE_FRAG = [
  'const float PI = 3.14159265359;',
  SG_GLSL_LUT_UTIL,
  SG_GLSL_RADIANCE,
  'void main() {',
  '  float i = floor(gl_FragCoord.x);',
  '  vec3 L;',
  '  if (i < 0.5) {',   // what lights the ground from above: the sky's light high up, the place's glow, the totality ring
  '    float v = sqrt(0.7 / (PI * 0.5));',
  '    L = ambientSky() + uGlow * (1.0 + 2.0 * exp(-degrees(0.7) / 14.0)) + uEclGlow * ' + SG_SUN_LUX.toFixed(1) + ' * lutLight(texture(uSkyE, unitToTex(vec2(0.5, v), vec2(' + SG_VIEW_W + '.0, ' + SG_VIEW_H + '.0))).rgb);',
  '  } else if (i < 1.5) {',   // the horizon: the four bearings round the Sun's
  '    L = vec3(0.0);',
  '    for (int k = 0; k < 4; k++) { float az = uSunAz + float(k) * PI * 0.5, ca = cos(' + OA_PROBE_HORIZON_RAD + '), sa = sin(' + OA_PROBE_HORIZON_RAD + '); L += skyAbove(vec3(sin(az) * ca, cos(az) * ca, sa), ' + OA_PROBE_HORIZON_RAD + ', az); }',
  '    L *= 0.25;',
  '  } else {',
  '    L = skyAbove(vec3(0.0, 0.0, 1.0), PI * 0.5 - 0.001, uSunAz + PI * 0.5);',
  '  }',
  '  gl_FragColor = vec4(L, 1.0);',
  '}'
].join('\n');
// The numbers the radiance function reads, written into a map of {name: {value}} from a state (the sky's own, and the probe's).
function _oaFill(u, S) {
  var p = S.p, lv = S.lv;
  u.uEclGlow.value = lv.eclGlow;
  u.uSunAz.value = p.sunAz * DEG_TO_RAD; u.uSunLux.value = lv.sunLux;
  u.uMoonAz.value = p.moonAz * DEG_TO_RAD; u.uMoonLux.value = lv.moonLux;
  u.uGlow.value = lv.glow; u.uEclPole.value = p.eclPole; u.uSunVec.value = p.sunVec;
}
// The tables for a state's Sun and Moon (drawn only when a light has moved).
function _oaBakeFor(o, S) {
  if (S.lv.sunLux) _oaBake(o, 'sun', S.p.sunAltGeo);
  if (S.lv.moonLux) _oaBake(o, 'moon', S.p.moonAlt);
  if (S.lv.eclGlow) _oaBake(o, 'ecl', 0);
}
function _oaProbe(o, S) {
  var T = o.S.THREE, r = o.S.renderer, names = Object.keys(o.uniforms);
  if (!o.probe) {
    o.probeU = {};
    names.forEach(function (k) { o.probeU[k] = { value: o.uniforms[k] }; });
    o.probe = { rt: new T.WebGLRenderTarget(3, 1, { type: OA_THREE_FLOAT, format: OA_THREE_RGBA, minFilter: T.NearestFilter, magFilter: T.NearestFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false }),
      mat: _oaMaterial(T, OA_PROBE_FRAG, o.probeU), buf: new Float32Array(12) };
  }
  _oaFill(o.probeU, S);
  _oaRun(o, o.probe.mat, o.probe.rt);
  r.readRenderTargetPixels(o.probe.rt, 0, 0, 3, 1, o.probe.buf);
  var b = o.probe.buf, k = 1 / AE_ST_LUX_PER_UNIT, out = { amb: [b[0] * k, b[1] * k, b[2] * k], horizon: [b[4] * k, b[5] * k, b[6] * k], zenith: [b[8] * k, b[9] * k, b[10] * k] };
  return out.amb.concat(out.horizon, out.zenith).every(isFinite) ? out : null;
}
function _oaDef(st, fr) { return _osDef({ body: OA_BODY, lat: st.lat, lon: st.lon, heightM: st.altKm * 1000, tMs: fr && fr.at != null ? fr.at : _aeDisplayMs() }); }

var _oaAir = {
  glsl: OA_GLSL,
  uniforms: null,
  wants: function (st) {
    if (st.key !== OA_BODY || !(st.altKm < OA_MAX_HEIGHT_KM) || typeof _ae === 'undefined' || !_ae || !_ae.gl) return false;
    if (!_oa) {
      try { _oa = _oaBuild(_ae.gl); } catch (e) { _oa = { failed: true, error: String(e && e.message || e).slice(0, 300) }; if (typeof console !== 'undefined') console.warn('oneair: the card\'s air could not be built here: ' + _oa.error); }
    }
    if (_oa.failed) return false;
    this.uniforms = _oa.uniforms;
    if (this.clouds && this.clouds.uniforms === OA_CLOUD_UNIFORMS) this.clouds.uniforms = Object.assign({}, _oa.uniforms, OA_CLOUD_UNIFORMS);
    return true;
  },
  // The Sun's and the Moon's tables for the instant, and the numbers the radiance function reads.
  update: function (st, fr, ph, u) {
    var S = _osSkyState(_oaDef(st, fr)), p = S.p, lv = S.lv, o = _oa;
    _oaBakeFor(o, S);
    _oaFill(u, S);
  },
  // What lights the ground and fills a view's horizon and zenith, in Stand here's units (the Sun's irradiance at the Earth as 1), the same
  // tables the sky is drawn from: { amb: [r, g, b], horizon: [r, g, b], zenith: [r, g, b] } (radiances: amb is what the ground takes from the
  // sky above it, horizon the mean of the four bearings a little over the horizon, zenith straight up). Valid at every Sun height, night
  // included; null where the air is not built (a body other than the Earth, a camera high up, a GPU without half floats) and for the first
  // picture of a visit if it is asked before the tables are drawn. Cheap: it is read back again only when a light has moved 0.05 degrees.
  ambient: function (st, fr) {
    var o = _oa;
    if (!o || o.failed || st.key !== OA_BODY || !(st.altKm < OA_MAX_HEIGHT_KM)) return null;
    var S = _osSkyState(_oaDef(st, fr)), lv = S.lv;
    _oaBakeFor(o, S);
    var sig = [o.sunKey, o.moonKey, Math.round(Math.log(lv.sunLux + 1) * 40), Math.round(Math.log(lv.moonLux + 1) * 40), Math.round(lv.eclGlow * 1000), Math.round(lv.glow[0] * 1e7)].join();
    if (sig !== o.ambSig) {
      o.ambSig = sig;
      try { o.amb = _oaProbe(o, S); } catch (e) { o.amb = null; }
    }
    return o.amb;
  },
  // An eclipse: the share of the Sun's light that reaches the place (the ground's light and the Sun's own), the faintest star the dimmed sky shows,
  // and the discs (almanac-onesky.js _osEclipse), for the ground view's Sun and Moon.
  sunShare: function (st, fr) { return _osSkyState(_oaDef(st, fr)).sunShare; },
  limitMag: function (st, fr) { return _osSkyState(_oaDef(st, fr)).lm; },
  eclipse: function (st, fr) { return _osEclipse(_oaDef(st, fr)); },
  // How much of the Moon (or the Sun) the day's deck hides, 0 clear to about 1 solid, from the same field the sky draws; 0 for a visit that
  // asked for a clear sky. The ground view dims its sprite by 1 minus this.
  moonVeil: function (st, fr) { return _osMoonVeilAt(_oaDef(st, fr), st.handoff && st.handoff.clouds); },
  sunVeil: function (st, fr) { return _osSunVeilAt(_oaDef(st, fr), st.handoff && st.handoff.clouds); },
  // The card's exposure, in Stand here's units (the same eye for the sky, the ground and everything on it).
  exposureK: function (st, fr) {
    var lv = _osSkyState(_oaDef(st, fr)).lv;
    return lv.exposure * AE_ST_LUX_PER_UNIT;
  }
};
// The day's clouds (almanac-skygl.js SG_GLSL_CLOUDS: the card's own): osClouds(d, o) is the deck seen along d from o (metres, the local
// frame), premultiplied, in the same units as oaSky; the ground view lays it over the sky. Its own pass, so the chunk carries the
// radiance functions the cloud's light reads (the sky's tables, the Sun) and its uniforms are the air's as well as its own.
var OA_CLOUD_GLSL = [
  'precision highp sampler2D;',
  SG_GLSL_LUT_UTIL,
  SG_GLSL_RADIANCE,
  SG_GLSL_CLOUD_FIELD,
  SG_GLSL_CLOUDS,
  'vec4 osClouds(vec3 d, vec3 o) { vec4 c = cloudDeck(d, o); return vec4(c.rgb / ' + AE_ST_LUX_PER_UNIT.toExponential(3) + ', c.a); }'
].join('\n');
var OA_CLOUD_UNIFORMS = { uCloud: [0, OS_CLOUD_BASE_M, OS_CLOUD_THICK_M, 0], uCloudWind: [0, 0, 0], uCloudOct: 4, uCloudSunE: 0, uSunAltDeg: 0, uMoonVec: [0, 0, -1] };
_oaAir.clouds = {
  glsl: OA_CLOUD_GLSL,
  uniforms: OA_CLOUD_UNIFORMS,   // joined by the air's own once the tables exist (wants)
  update: function (st, fr, ph, u) {
    _oaAir.update(st, fr, ph, u);
    var def = _oaDef(st, fr), S = _osSkyState(def), cv = _osCloudValues(def, S.p.sunShare, st.handoff && st.handoff.clouds);
    u.uCloud.value = cv.cloud; u.uCloudWind.value = cv.wind; u.uCloudOct.value = cv.oct; u.uCloudSunE.value = cv.sunE; u.uSunAltDeg.value = S.p.sunAltGeo; u.uMoonVec.value = S.lv.moonVec;
  }
};
_aeStandAir = _oaAir;

// The satellites, trains and launches in the card's sky and in this view's are one registry (almanac-onesky.js _osSkySource):
// the ground view draws what is in it for the Earth.
if (typeof _aeStandSkySource === 'function') _aeStandSkySource(function (body, lat, lon, ms) { return _osObjects(body, lat, lon, ms).filter(function (o) { return o.kind !== 'gps'; }); });
_osOnChange(function () {   // an answer came in or a source came or went: the ground view draws again
  var st = typeof _ae !== 'undefined' && _ae && _ae.stand;
  if (!st) return;
  st.skyDirty = true; st.dirty = true; _ae.dirty = true;
  if (typeof _aeKick === 'function') _aeKick();
});
