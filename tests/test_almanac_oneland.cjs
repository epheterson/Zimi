// The one land-cover grid (zimi/static/almanac-oneland.js, zimi/static/earth/landcover-v1.bin, scripts/build_landcover.py): what grows
// at real places, and that a damaged file is refused.
//
// Run: node tests/test_almanac_oneland.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const STATIC = path.join(__dirname, '..', 'zimi', 'static');
let failures = 0;
const check = (ok, label) => { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); };

const S = { Math, Promise, Uint8Array, DataView, ArrayBuffer, String, isFinite, fetch: () => Promise.reject(new Error('offline')) };
vm.createContext(S);
S._almAsset = (p) => p;   // app.js: a /static address with its version; here, as it is
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-oneland.js'), 'utf8'), S);
const bin = fs.readFileSync(path.join(STATIC, 'earth', 'landcover-v1.bin'));
S.__buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const run = (c) => vm.runInContext(c, S);

check(bin.length < 60000, 'the grid is small (' + bin.length + ' bytes)');
check(run('_osLandCover(40, -105)') === null, 'before it is loaded, no answer');
run('var __g = _olParse(__buf)');
check(run('!!__g && __g.w === 360 && __g.h === 180'), 'the shipped file reads as 360 by 180 one-degree cells');
const at = (lat, lon) => JSON.stringify(run('_olAt(__g, ' + lat + ', ' + lon + ')'));
const cls = (lat, lon) => run('_olAt(__g, ' + lat + ', ' + lon + ').cls');
check(cls(48.2, 8.2) === 'conifer', 'the Black Forest is conifer');
check(cls(38.5, -98) === 'grass' && cls(40, -105.3) === 'grass', 'Kansas and the High Plains are grass');
check(cls(25, 10) === 'desert', 'the Sahara is desert');
check(cls(72, -40) === 'snow' && cls(-80, 0) === 'snow', 'Greenland and Antarctica are snow');
check(cls(71.3, -156.8) === 'tundra' && cls(63.7, -68.5) === 'tundra' && cls(64.5, -50.5) === 'tundra' && cls(71.6, 128.9) === 'tundra' && cls(78.2, 15.6) === 'tundra', 'Utqiagvik, Iqaluit, the coast by Nuuk, Tiksi and the coast of Svalbard are tundra (past the tree line)');
check(cls(78.5, 17.0) === 'snow' && cls(62, 100) === 'conifer' && cls(55, 37) !== 'tundra', 'Svalbard\'s interior is snow, central Siberia and Moscow are not tundra');
check(cls(-3, -60) === 'broadleaf', 'the Amazon is broadleaf forest');
check(run('_olAt(__g, 40.7, -74.0).coast') === true && cls(40.7, -74.0) !== 'sea', 'New York is a land cell with a coast');
check(run('_olAt(__g, 38.5, -98).coast') === false, 'Kansas is nowhere near a coast');
check(cls(0, -140) === 'sea' && run('_olAt(__g, 0, -140).rgb') === null, 'the mid-Pacific is sea, with no tint');
const t = run('_olAt(__g, -3, -60).rgb');
check(t[1] > t[0] && t[1] > t[2], 'the Amazon\'s tint is green (' + t.map((x) => x.toFixed(2)).join(', ') + ')');
check(at(10, 190) === at(10, -170) && run('_olAt(__g, 200, 0)') !== undefined, 'longitude wraps and a latitude past the pole is clamped, not an error');
check(run('_olAt(__g, NaN, 0)') === null, 'a place that is not a number has no answer');

// A damaged file is refused (a half-fetched one must not become a wrong sky).
check(run('_olParse(__buf.slice(0, 200))') === null, 'a truncated file is refused');
S.__bad = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
new Uint8Array(S.__bad)[0] = 0x58;
check(run('_olParse(__bad)') === null, 'a file with another magic is refused');
check(run('_olParse(null)') === null && run('_olParse(new ArrayBuffer(4))') === null, 'nothing, or too little, is refused');

// Loading: a failed fetch gives false and may be tried again.
(async () => {
  const ok = await run('_osLandCoverLoad()');
  check(ok === false && run('_osLandCover(40, -105)') === null, 'a failed load is false and leaves no grid');
  S.fetch = () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(S.__buf) });
  let called = null;
  S.__cb = (v) => { called = v; };
  const ok2 = await run('_osLandCoverLoad(__cb)');
  check(ok2 === true && called === true && run('_osLandCover(48.2, 8.2).cls') === 'conifer', 'loaded, the accessor answers and the callback is told');
  if (failures) { console.error('\n' + failures + ' failure(s)'); process.exit(1); }
  console.log('\nall checks passed');
})();
