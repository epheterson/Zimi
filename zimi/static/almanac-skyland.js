// ── Almanac: the live sky's own ground ──
// Where the person stands is not always a beach. The card's foreground is the place's own land (almanac-oneland.js: the one one-degree
// grid Stand here reads too): a wood on the horizon where the map is dark green, rolling grass where it is olive, dunes where it is
// tan, white ground and snow-laden firs where it is white, low hummocks on the tundra; the sea, its boats, whales and palms only where
// the grid says there is a coast (almanac-sky.js _skyPaintSea). Lit by the sky as drawn (almanac-sky.js _skyGroundLight), so it goes
// dark at dusk with everything else. Seeded by the place: the same trees stand in the same bearings every visit.
// Loaded after the card's first picture (almanac-onesky.js _osLandKick); the card paints a plain horizon until then.

var SL_ALBEDO = {   // the ground's colour in full light, by class; the cell's own tint is mixed in
  plain: [0.30, 0.29, 0.24], broadleaf: [0.20, 0.30, 0.12], conifer: [0.13, 0.21, 0.14], grass: [0.36, 0.38, 0.18],
  desert: [0.66, 0.52, 0.34], snow: [0.88, 0.90, 0.95], tundra: [0.34, 0.31, 0.24]
};
var SL_TINT_MIX = 0.35, SL_TINT_GAIN = 1.8;   // how much of the cell's mean colour (a dark picture) is mixed in, brightened
var SL_TREE_ALBEDO = { broadleaf: [0.09, 0.19, 0.07], conifer: [0.06, 0.13, 0.09], grass: [0.12, 0.2, 0.08], snow: [0.07, 0.14, 0.1], tundra: [0.2, 0.2, 0.14] };
var SL_SNOW_CAP = [0.92, 0.94, 0.98];
// Trees on the horizon by class: how many stand round the whole circle, their height (share of the picture's height, far to near),
// the share that are firs where both kinds grow.
var SL_TREES = { broadleaf: { n: 150, h: [0.035, 0.11], fir: 0.15 }, conifer: { n: 170, h: [0.04, 0.13], fir: 1 }, grass: { n: 14, h: [0.04, 0.09], fir: 0 },
  snow: { n: 0, h: [0, 0], fir: 0 }, tundra: { n: 0, h: [0, 0], fir: 0 }, desert: { n: 0, h: [0, 0], fir: 0 } };
var SL_RIDGES = { desert: { n: 3, amp: [0.012, 0.028], period: [0.35, 0.8] }, grass: { n: 2, amp: [0.005, 0.014], period: [0.5, 1.1] }, tundra: { n: 2, amp: [0.004, 0.01], period: [0.15, 0.4] },
  snow: { n: 2, amp: [0.004, 0.012], period: [0.5, 1.1] }, broadleaf: { n: 1, amp: [0.004, 0.01], period: [0.6, 1.2] }, conifer: { n: 1, amp: [0.004, 0.012], period: [0.6, 1.2] }, plain: { n: 0, amp: [0, 0], period: [1, 1] } };
var SL_HAZE = 0.55;          // how far the farthest row sinks into the horizon's colour
var SL_NEAR_DARKEN = 0.7;    // the foot of the picture, against the horizon

function _slSeed(s) { return Math.imul(Math.round(s.lat * 10), 19349663) ^ Math.imul(Math.round(s.lon * 10), 83492791); }
function _slAlbedo(cls, tint) {
  var a = SL_ALBEDO[cls] || SL_ALBEDO.plain;
  return tint ? a.map(function (v, i) { return v * (1 - SL_TINT_MIX) + Math.min(1, tint[i] * SL_TINT_GAIN) * SL_TINT_MIX; }) : a;
}
// A fir: a spiky triangle from its apex, in tiers; `cap` snows its upper half.
function _slFir(ctx, x, y, h, col, cap) {
  var w = h * 0.3, tiers = 5, i, f;
  ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x, y - h);
  for (i = 1; i <= tiers; i++) { f = i / tiers; ctx.lineTo(x + w * f * (i % 2 ? 1 : 0.72), y - h + h * f * 0.96); }
  for (i = tiers; i >= 1; i--) { f = i / tiers; ctx.lineTo(x - w * f * (i % 2 ? 1 : 0.72), y - h + h * f * 0.96); }
  ctx.closePath(); ctx.fill();
  if (cap) {
    ctx.fillStyle = cap; ctx.beginPath(); ctx.moveTo(x, y - h);
    ctx.lineTo(x + w * 0.5, y - h * 0.6); ctx.lineTo(x - w * 0.5, y - h * 0.6); ctx.closePath(); ctx.fill();
  }
}
// A broadleaf: a trunk and a crown of three overlapping lobes.
function _slBroad(ctx, x, y, h, col, trunk) {
  ctx.fillStyle = trunk; ctx.fillRect(x - h * 0.03, y - h * 0.4, h * 0.06, h * 0.4);
  ctx.fillStyle = col;
  [[0, 0.62, 0.3], [-0.2, 0.52, 0.22], [0.2, 0.52, 0.22]].forEach(function (c) { ctx.beginPath(); ctx.arc(x + c[0] * h, y - c[1] * h, c[2] * h, 0, Math.PI * 2); ctx.fill(); });
}
// The ground's colour in the light of the hour. Snow takes the sky's own: white to blue-white by day, pink at a low Sun, never a tint of
// its own (and never green); the rest is its albedo in the light.
var SL_SNOW_SKY_MIX = 0.35;
function _slGroundColour(cls, albedo, lit, hor) {
  if (cls !== 'snow') return _skyLitColour(albedo, lit).map(function (v) { return v * 255; });
  var L = 255 * _skyLuma(lit.map(function (v) { return v * 255; })) * albedo[0], c = _skyMix([L, L, L], hor, SL_SNOW_SKY_MIX);
  c[1] = Math.min(c[1], Math.max(c[0], c[2]));
  return c;
}
// The land's ridges: layered rolling lines, far ones paler and nearer ones darker, each a run of strips down to the foot. A slope that faces
// the Sun is in its light and the one that turns from it in shade (two tones to a ridge, as strong as the Sun is high and low in the sky
// lets them be), by the bearing of the Sun; a view toward the Sun sees them all from the shaded side.
var SL_LIT_GAIN = 1.7, SL_LIT_LIFT = 25, SL_LIT_SKY_MIX = 0.35, SL_SHADE_GAIN = 0.35, SL_DIM_LUMA = 0.45;   // the lit slope's colour from the ground's and its mix with the sky's horizon; the shaded one; the ground luminance under which the overlays fade
var SL_RIDGE_SHADE = 0.5, SL_STRIP_PX = 3, SL_CREST_LAYERS = 5, SL_CREST_DEPTH = 1.6;   // the lit and shaded slopes' strongest overlay; strip width; layers of it down from the crest, and their depth in ridge heights
function _slRidges(ctx, s, cls, albedo, lit, hor) {
  var R = SL_RIDGES[cls] || SL_RIDGES.plain, W = s.W, H = s.H, yh = H * SKY_HORIZON_Y, dpr = s.dpr, rand = _osMulberry(_slSeed(s) + 7), e = s.eph;
  var sunAlt = e.sunGeoAlt, contrast = SL_RIDGE_SHADE * _skyClamp(1.1 - sunAlt / 60, 0.25, 1) * (sunAlt > -2 ? 1 : 0), ground = _slGroundColour(cls, albedo, lit, hor);
  for (var k = 0; k < R.n; k++) {
    var d = (k + 1) / (R.n + 1), amp = _skyLerp(R.amp[0], R.amp[1], rand()) * H, per = _skyLerp(R.period[0], R.period[1], rand()) * W, ph = rand() * 6.28;
    var base = yh + (H - yh) * 0.05 * d * 2, step = SL_STRIP_PX * dpr, xs = [], ys = [], x, i;
    var tone = _skyMix(ground.map(function (v) { return v * (1 - 0.15 * d); }), hor, SL_HAZE * (1 - d) * 0.8);
    for (x = 0; x <= W + step; x += step) { xs.push(x); ys.push(base - amp * (0.6 * Math.sin(x / per * 6.28 + ph) + 0.4 * Math.sin(x / per * 15 + ph * 2)) - amp); }
    ctx.fillStyle = _skyRgb(tone);
    ctx.beginPath(); ctx.moveTo(0, H);
    for (i = 0; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);
    ctx.lineTo(W + step, H); ctx.closePath(); ctx.fill();
    if (!contrast) continue;
    // A slope that faces the Sun is lit, the one that turns from it in shade, by the Sun's bearing: soft overlays down from the crest, each a
    // band under the crest line whose colour runs along it (a horizontal gradient of the facing), nested so they fade with depth.
    // The lit side is the ground's own colour brightened toward the sky's horizon (warm at sunset, never white), the shaded side its darker self;
    // both fainter where the ground is dim, so a dune at dusk has no bright dashes along its crest.
    var litRgb = 'rgba(' + _skyMix(ground.map(function (v) { return Math.min(255, v * SL_LIT_GAIN + SL_LIT_LIFT); }), hor, SL_LIT_SKY_MIX).map(Math.round).join(',') + ',';
    var shadeRgb = 'rgba(' + ground.map(function (v) { return Math.round(v * SL_SHADE_GAIN); }).join(',') + ',', dim = _skyClamp(_skyLuma(ground) / SL_DIM_LUMA, 0.2, 1);
    var face = [];
    for (i = 1; i < xs.length; i++) {
      var rise = (ys[i - 1] - ys[i]) / step, side = Math.sin((e.sun.az - _skyAzAt(s, xs[i])) * DEG_TO_RAD);
      face.push(Math.tanh(rise * 30 * side));
    }
    var smooth = face.map(function (v, n) { return ((face[n - 1] === undefined ? v : face[n - 1]) + v * 2 + (face[n + 1] === undefined ? v : face[n + 1])) / 4; });
    for (var j = 0; j < SL_CREST_LAYERS; j++) {
      var grad = ctx.createLinearGradient(0, 0, W + step, 0), depth = amp * SL_CREST_DEPTH * (1 - j / SL_CREST_LAYERS), w = (1 - j / SL_CREST_LAYERS) * 0.55;
      for (i = 0; i < smooth.length; i++) {
        var f = smooth[i], al = (Math.abs(f) * contrast * w * dim).toFixed(3);
        grad.addColorStop(Math.min(1, xs[i + 1] / (W + step)), (f > 0 ? litRgb : shadeRgb) + al + ')');
      }
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.moveTo(xs[0], ys[0]);
      for (i = 1; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);
      for (i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], ys[i] + depth);
      ctx.closePath(); ctx.fill();
    }
  }
}
function _slTrees(ctx, s, cls, lit, hor) {
  var T = SL_TREES[cls];
  if (!T || !T.n) return;
  var W = s.W, H = s.H, yh = H * SKY_HORIZON_Y, rand = _osMulberry(_slSeed(s)), list = [], i;
  var tree = SL_TREE_ALBEDO[cls] || SL_TREE_ALBEDO.broadleaf;
  for (i = 0; i < T.n; i++) list.push({ az: rand() * 360, d: rand(), fir: rand() < T.fir, k: 0.7 + 0.6 * rand() });
  list.sort(function (a, b) { return a.d - b.d; });
  for (i = 0; i < list.length; i++) {
    var t = list[i], x = _skyX(s, t.az);
    if (!_skyInView(s, x, 0.15 * H)) continue;
    var h = _skyLerp(T.h[0], T.h[1], Math.pow(t.d, 1.4)) * H * t.k, y = yh + (H - yh) * 0.02 + (H - yh) * 0.5 * Math.pow(t.d, 1.6);
    var haze = SL_HAZE * (1 - t.d), col = _skyRgb(_skyMix(_skyLitColour(tree, lit).map(function (v) { return v * 255; }), hor, haze));
    if (t.fir) _slFir(ctx, x, y, h, col, cls === 'snow' ? _skyRgb(_skyMix(_skyLitColour(SL_SNOW_CAP, lit).map(function (v) { return v * 255; }), hor, haze)) : null);
    else _slBroad(ctx, x, y, h, col, _skyRgb(_skyMix(_skyLitColour([0.12, 0.09, 0.06], lit).map(function (v) { return v * 255; }), hor, haze)));
  }
}
// The land of a class (almanac-sky.js _skyPaintGround): the ground, its ridges, then what grows on it.
function _skyPaintLand(ctx, s, cls) {
  var W = s.W, H = s.H, yh = H * SKY_HORIZON_Y, e = s.eph;
  var lit = s.lit = _skyGroundLight(s), hor = s.ground ? s.ground.hor : _skyTone(e.sunGeoAlt).hor;
  var albedo = _slAlbedo(cls, cls === 'snow' ? null : s.land && s.land.rgb), ground = _slGroundColour(cls, albedo, lit, hor);
  var g = ctx.createLinearGradient(0, yh, 0, H), foot = ground.map(function (v) { return v * SL_NEAR_DARKEN; });
  g.addColorStop(0, _skyRgb(_skyMix(ground, hor, SL_HAZE * 0.8)));
  g.addColorStop(0.35, _skyRgb(ground));
  g.addColorStop(1, _skyRgb(foot));
  ctx.fillStyle = g; ctx.fillRect(0, yh, W, H - yh);
  s.footLuma = _skyLuma(foot);   // what the compass letters at the foot are set against (almanac-sky.js _skyPaintCompassFoot)
  _slRidges(ctx, s, cls, albedo, lit, hor);
  _slTrees(ctx, s, cls, lit, hor);
}
