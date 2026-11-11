// The capability level's memory budget (capability.js ZimiCap.gpuTrack / gpuFree): every map the 3D view uploads is counted when it is
// loaded, and a map that replaces another lets it go. Without ZimiCap the view loads as before.
// Run: node tests/test_almanac_cap_textures.cjs   (exit 0 = pass)
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
function world(withCap) {
  const tracked = [], freed = [], holds = [];
  const C = { Math, Promise, tracked, freed, holds, _ae: { dirty: false, ready: false }, _aeKick() {}, _aeWarmSliced() {},
    _aeLoadTexture: (THREE, url) => Promise.resolve({ image: url.indexOf('hi') >= 0 ? { width: 4096, height: 2048 } : { width: 1024, height: 512 }, dispose() {} }) };
  if (withCap) C.ZimiCap = { gpuTrack: (k, b) => { tracked.push([k, b]); return true; }, gpuFree: (k) => freed.push(k), hold: (ms) => holds.push(ms) };
  vm.createContext(C);
  vm.runInContext(fn('_aeLoadMap'), C);
  return C;
}
const S = () => ({ maps: {}, mapFailed: {}, aniso: 1, THREE: {} });

(async () => {
  const C = world(true), s = S(), uni = { value: null };
  const pending = C._aeLoadMap(s, uni, 'moon-1k');
  check(C.holds.length === 1, 'a map that starts loading holds the governor (its frames are not the device\'s pace)');
  await pending;
  check(C.holds.length === 2, 'and holds it again once the map is in');
  check(C.tracked.length === 1 && C.tracked[0][0] === 'map:moon-1k' && C.tracked[0][1] === 1024 * 512 * 4 * 1.34, 'a map uploaded is counted against the level\'s memory budget (w x h x 4 x 1.34 for its mips)');
  await C._aeLoadMap(s, uni, 'moon-hi');
  check(C.freed.join() === 'map:moon-1k' && C.tracked[1][0] === 'map:moon-hi' && C.tracked[1][1] === 4096 * 2048 * 4 * 1.34, 'the map that replaces it lets the first one go and is counted in its place');
  const N = world(false);
  check((await N._aeLoadMap(S(), { value: null }, 'plain')) === true, 'without ZimiCap the view loads as before');
  process.exit(failures ? 1 : 0);
})();
