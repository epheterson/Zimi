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

function _oaTarget(T, w, h) {
  return new T.WebGLRenderTarget(w, h, { type: T.HalfFloatType, format: T.RGBAFormat, minFilter: T.LinearFilter, magFilter: T.LinearFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
}
function _oaMaterial(T, fs, uniforms) {
  return new T.RawShaderMaterial({ vertexShader: SG_VS_QUAD, fragmentShader: fs, uniforms: uniforms, depthTest: false, depthWrite: false });
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
  var o = { S: S, scene: new T.Scene(), camera: new T.OrthographicCamera(-1, 1, 1, -1, 0, 1), failed: false, sunKey: null, moonKey: null };
  o.mesh = new T.Mesh(geo, null); o.mesh.frustumCulled = false; o.scene.add(o.mesh);
  o.trans = _oaTarget(T, SG_TRANS_W, SG_TRANS_H);
  o.multi = _oaTarget(T, SG_MS_N, SG_MS_N);
  o.viewS = _oaTarget(T, OA_VIEW_W, OA_VIEW_H);
  o.viewM = _oaTarget(T, OA_VIEW_W, OA_VIEW_H);
  var matTrans = _oaMaterial(T, SG_FS_TRANS, {});
  var matMulti = _oaMaterial(T, SG_FS_MULTI, { uTrans: { value: o.trans.texture } });
  o.matView = _oaMaterial(T, SG_FS_SKYVIEW, { uTrans: { value: o.trans.texture }, uMulti: { value: o.multi.texture }, uLightAlt: { value: 0 }, uObsHeight: { value: SG_OBSERVER_KM } });
  _oaRun(o, matTrans, o.trans);
  _oaRun(o, matMulti, o.multi);
  matTrans.dispose(); matMulti.dispose();
  o.uniforms = {
    uSkyS: o.viewS.texture, uSkyM: o.viewM.texture, uSunAz: 0, uSunLux: 0, uMoonAz: 0, uMoonLux: 0, uGlow: [0, 0, 0], uEclPole: [0, 0, 1],
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
  _oaRun(o, o.matView, which === 'sun' ? o.viewS : o.viewM);
}
function _oaDef(st, fr) { return _osDef({ body: OA_BODY, lat: st.lat, lon: st.lon, heightM: st.altKm * 1000, tMs: fr && fr.at != null ? fr.at : _aeDisplayMs() }); }

var _oaAir = {
  glsl: OA_GLSL,
  uniforms: null,
  wants: function (st) {
    if (st.key !== OA_BODY || !(st.altKm < OA_MAX_HEIGHT_KM) || typeof _ae === 'undefined' || !_ae || !_ae.gl) return false;
    if (!_oa) {
      try { _oa = _oaBuild(_ae.gl); } catch (e) { _oa = { failed: true }; }
    }
    if (_oa.failed) return false;
    this.uniforms = _oa.uniforms;
    if (this.clouds && this.clouds.uniforms === OA_CLOUD_UNIFORMS) this.clouds.uniforms = Object.assign({}, _oa.uniforms, OA_CLOUD_UNIFORMS);
    return true;
  },
  // The Sun's and the Moon's tables for the instant, and the numbers the radiance function reads.
  update: function (st, fr, ph, u) {
    var S = _osSkyState(_oaDef(st, fr)), p = S.p, lv = S.lv, o = _oa;
    if (lv.sunLux) _oaBake(o, 'sun', p.sunAltGeo);
    if (lv.moonLux) _oaBake(o, 'moon', p.moonAlt);
    u.uSunAz.value = p.sunAz * DEG_TO_RAD; u.uSunLux.value = lv.sunLux;
    u.uMoonAz.value = p.moonAz * DEG_TO_RAD; u.uMoonLux.value = lv.moonLux;
    u.uGlow.value = lv.glow; u.uEclPole.value = p.eclPole; u.uSunVec.value = p.sunVec;
  },
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
var OA_CLOUD_UNIFORMS = { uCloud: [0, OS_CLOUD_BASE_M, OS_CLOUD_THICK_M, 0], uCloudWind: [0, 0, 0], uCloudSunE: 0, uSunAltDeg: 0 };
_oaAir.clouds = {
  glsl: OA_CLOUD_GLSL,
  uniforms: OA_CLOUD_UNIFORMS,   // joined by the air's own once the tables exist (wants)
  update: function (st, fr, ph, u) {
    _oaAir.update(st, fr, ph, u);
    var def = _oaDef(st, fr), S = _osSkyState(def), cv = _osCloudValues(def, S.p.sunShare);
    u.uCloud.value = cv.cloud; u.uCloudWind.value = cv.wind; u.uCloudSunE.value = cv.sunE; u.uSunAltDeg.value = S.p.sunAltGeo;
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
