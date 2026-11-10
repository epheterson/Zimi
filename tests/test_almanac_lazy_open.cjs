// What the 3D view does not fetch on opening (zimi/static/almanac-earth.js): the 4096 Moon map and the Sun's close-up script. Each is asked
// for by its trigger and not before, so the Earth opens at the old weight.
//
//   Moon  _aeMoonHiWanted: not with the Earth; when the Moon is the target (Go to, a flight there) or its disc is wide enough that the
//         1024 map's texel is bigger than a pixel.
//   Tracks _aeTracked: the probes' table (space-tracks-v1.json) is not fetched because Pluto's place is asked for in every frame; it is
//         fetched with the first thing that needs it (a planet, the Sun or a probe the view is on, a wide view, Go to, a mission).
//   Sun   _aeSunFxWanted: not when the Sun is wide but behind the camera (a phone's first frame); when the view is on the Sun or the Sun
//         is within the frame.
//
// Run: node tests/test_almanac_lazy_open.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-earth.js'), 'utf8');
function fn(name) {
  const a = src.indexOf('\nfunction ' + name + '(') + 1;
  if (a <= 0) throw new Error(name);
  let i = src.indexOf('{', a), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(a, i + 1); }
  throw new Error(name);
}
function line(re) { const m = re.exec(src); if (!m) throw new Error(String(re)); return m[0]; }

const loads = [], scripts = [];
const S0 = {
  Math, Number, Array, window: { devicePixelRatio: 3 },
  AE_TEX_MOON_HI: 'moon-4k', AE_THREE_RED_FORMAT: 1, AE_SUNFX_JS: '/static/almanac-sun.js',
  _aeLoadMap: (S, uni, url) => { loads.push(url); return Promise.resolve(true); },
  _aeSharedHiMoon: () => null, _aeKick: () => {},
  _aeRad: (x) => x * Math.PI / 180,
  _aeSub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  _aeLen: (a) => Math.hypot(a[0], a[1], a[2]),
  document: { head: { appendChild: (el) => scripts.push(el.src) }, createElement: () => ({ remove() {} }) },
  _ae: { target: 'earth', h: 844, w: 390, dirty: false, gl: null },
};
vm.createContext(S0);
vm.runInContext([
  line(/^var AE_MOON_RADIUS_KM = [^;]+;/m), line(/^var AE_EARTH_RADIUS_KM = [^;]+;/m), line(/^var AE_MOON_RADIUS_RE = [^;]+;/m),
  line(/^var AE_SUN_SHOW_R = [^;]+;/m), line(/^var AE_SUNFX_MIN_PX = [^;]+;/m), line(/^var AE_MOON_LO_MAP_W = [^;]+;/m),
  fn('_aeMoonDiscPx'), fn('_aeMoonHiWanted'), fn('_aeSunFxWanted'),
].join('\n'), S0);

// A camera at `cam` looking along `dir` (unit), the Moon and Sun placed as given; a vertical fov of the portrait phone's (what _aeSetCamera gives).
function scene(cam, dir, moon, sun, fov) {
  const f = { x: dir[0], y: dir[1], z: dir[2] };
  const S = {
    sunFxAsked: false, moonHiAsked: false, THREE: { Vector3: function () {} },
    camera: { position: { x: cam[0], y: cam[1], z: cam[2] }, fov, getWorldDirection: (v) => Object.assign(v, f) },
    moon: { matrixWorld: { elements: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, moon[0], moon[1], moon[2], 1] } },
    sun: { position: { x: sun[0], y: sun[1], z: sun[2] } },
    moonUni: { moonMapped: { value: 1 } },
  };
  return S;
}
const PORTRAIT_FOV = 2 * Math.atan(Math.tan(35 * Math.PI / 360) * 390 / 844) * 180 / Math.PI;   // the vertical fov at 390 x 844
const call = (name, S, ...a) => { loads.length = 0; scripts.length = 0; S0._ae.target = S.target || 'earth'; return vm.runInContext(name, S0)(S, ...a); };

// ── The Moon ──
{
  const far = scene([0, -6, 0], [0, 1, 0], [60, 0, 0], [3000, 0, 0], PORTRAIT_FOV);
  S0._ae.target = 'earth'; call('_aeMoonHiWanted', far);
  check(loads.length === 0 && !far.moonHiAsked, 'opening on the Earth, the Moon (60 radii away) does not ask for the 4096 map');
  const t = scene([0, -6, 0], [0, 1, 0], [60, 0, 0], [3000, 0, 0], PORTRAIT_FOV); t.target = 'moon';
  call('_aeMoonHiWanted', t);
  check(loads.join() === 'moon-4k', 'with the Moon the target (opened from Go to) it is asked for');
  const near = scene([59.5, 0, 0], [1, 0, 0], [60, 0, 0], [3000, 0, 0], PORTRAIT_FOV);   // 0.5 radii from the Moon
  call('_aeMoonHiWanted', near);
  check(loads.join() === 'moon-4k' && near.moonHiAsked, 'close enough that the disc outgrows the 1024 map, it is asked for');
  call('_aeMoonHiWanted', near);
  check(loads.length === 0, 'and only once');
  const nomap = scene([59.5, 0, 0], [1, 0, 0], [60, 0, 0], [3000, 0, 0], PORTRAIT_FOV); nomap.moonUni.moonMapped.value = 0;
  call('_aeMoonHiWanted', nomap);
  check(loads.length === 0, 'and not before the small map is in (the first stays the first)');
  const mid = scene([0, -6, 0], [0, 1, 0], [20, 0, 0], [3000, 0, 0], PORTRAIT_FOV);
  call('_aeMoonHiWanted', mid);
  check(loads.length === 0, 'the Moon at 20 radii is still a few dozen pixels: the small map');
}

// ── The Sun ──
{
  // The Earth's first frame on a phone: the Sun's disc is "wide" (39 px) but it is behind the camera or off to the side.
  const away = scene([0, -6, 0], [0, 1, 0], [60, 0, 0], [3000, 0, 0], PORTRAIT_FOV);
  call('_aeSunFxWanted', away, 0);
  check(scripts.length === 0 && !away.sunFxAsked, 'opening on the Earth with the Sun off the picture, the close-up script is not requested');
  const behind = scene([0, -6, 0], [-1, 0, 0], [60, 0, 0], [3000, 0, 0], PORTRAIT_FOV);
  call('_aeSunFxWanted', behind, 0);
  check(scripts.length === 0, 'nor with the Sun behind the camera');
  const toward = scene([0, -6, 0], [1, 0, 0], [60, 0, 0], [3000, 0, 0], PORTRAIT_FOV);
  call('_aeSunFxWanted', toward, 0);
  check(scripts.join() === '/static/almanac-sun.js', 'looking at the Sun it is requested');
  const tgt = scene([0, -6, 0], [0, 1, 0], [60, 0, 0], [3000, 0, 0], PORTRAIT_FOV); tgt.target = 'sun';
  call('_aeSunFxWanted', tgt, 0);
  check(scripts.join() === '/static/almanac-sun.js', 'with the Sun the target it is requested');
  const small = scene([0, -6, 0], [1, 0, 0], [60, 0, 0], [3000, 0, 0], 35);   // a wide fov: the disc is under the size that wants the close-up
  call('_aeSunFxWanted', small, 0);
  check(scripts.length === 0, 'in frame but a small disc: still not');
}

// ── The probes' table ──
{
  const T = { Math, Array, Object, tracksLoads: 0, AE_AST_WIDE_DIST: 60,
    _ae: { target: 'earth', dist: 40 }, _aeTracks: null,
    _aeIsPlanet: (k) => ['jupiter', 'pluto', 'io'].includes(k), _aeIsProbe: () => false, _aeTrackAt: () => [0, 0, 0] };
  T._aeTracksLoad = () => { T.tracksLoads++; };
  vm.createContext(T);
  vm.runInContext([fn('_aeTracksNeeded'), fn('_aeTracked')].join('\n'), T);
  const pluto = { track: 'planets', eph: 'Pluto' };
  const ask = (target, dist) => { T.tracksLoads = 0; T._ae.target = target; T._ae.dist = dist; const r = T._aeTracked(pluto, 2459000); return [T.tracksLoads, r]; };
  check(ask('earth', 40)[0] === 0 && ask('earth', 40)[1] === null, 'opening on the Earth, Pluto being asked for every frame does not fetch the table');
  check(ask('moon', 30)[0] === 0, 'nor on the Moon');
  check(ask('earth', 200)[0] === 1, 'a wide view (the belt in sight) does');
  check(ask('jupiter', 5)[0] === 1 && ask('sun', 20)[0] === 1, 'a planet or the Sun as the target does');
  T._aeIsProbe = (k) => k === 'voyager1';
  check(ask('voyager1', 1)[0] === 1, 'and so does a probe');
}
process.exit(failures ? 1 : 0);
