// The installed map on the 3D Earth (almanac-maps.js) under the capability level (capability.js ZimiCap): which names are drawn
// (mapLabels none | major | all), how many tiles the GPU holds, how big their canvases are and how many are fetched at once (gpuMB),
// and the tiles counted against the memory budget. Without ZimiCap the module is what it was.
// Run: node tests/test_almanac_cap_maps.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-maps.js'), 'utf8');

function load(cap) {
  const ctx = { Math, Object, Array, JSON, Promise, Number, String, console, window: {}, document: {}, _ae: { w: 390, h: 844 }, setTimeout, clearTimeout };
  if (cap) ctx.ZimiCap = cap;
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.__maps = AlmanacMaps;', ctx);
  return ctx.__maps;
}
const level = (gpuMB, mapLabels, track) => ({ get: (k) => ({ gpuMB, mapLabels })[k], gpuTrack: track || (() => true), gpuFree() {}, on() {} });

const plain = load(null);
const b0 = plain._tileBudget();
check(b0.tiles === 28 && b0.px === 640 && b0.loads === 4 && plain._labelLevel() === 'all' && plain._labelClasses.all === undefined, 'without ZimiCap: 28 tiles of 640 px, 4 fetches, every name');

const low = load(level(96, 'none')), std = load(level(256, 'major')), high = load(level(768, 'all'));
check(JSON.stringify(low._tileBudget()) === '{"tiles":10,"px":384,"loads":2,"ring":1}', 'low (96 MB): 10 tiles of 384 px, 2 fetches at a time');
check(JSON.stringify(std._tileBudget()) === JSON.stringify(b0), 'standard (256 MB): the old numbers');
check(high._tileBudget().tiles === 40 && high._tileBudget().px === 768, 'full (768 MB): 40 tiles of 768 px');
check(low._labelLevel() === 'none' && low._labelClasses.none.length === 0, 'low draws roads only: no class of name');
check(std._labelLevel() === 'major' && ['country', 'state', 'city', 'island'].every((c) => std._labelClasses.major.includes(c)) && !std._labelClasses.major.includes('town') && !std._labelClasses.major.includes('suburb'), 'standard names the countries, states, cities and islands, not the towns and below');
check(high._labelClasses.all === undefined, 'full names every class');

// A tile that does not fit the memory budget is not painted; a tile let go is given back.
{
  const asked = [], freed = [];
  const M = load({ get: () => 96, gpuTrack: (k, b) => { asked.push([k, b]); return false; }, gpuFree: (k) => freed.push(k), on() {} });
  const t = { key: '5/10/12', z: 5, x: 10, y: 12, state: 'drawn', data: { roads: [], places: [] } };
  M._paint(t);
  check(asked.length === 1 && asked[0][0] === 'maps:5/10/12' && asked[0][1] === 384 * 384 * 4 * 1.34 && t.state === 'empty' && t.data === null, 'a tile over the budget is not painted: counted as maps:<key> at its canvas, left empty');
  M._free(t);
  check(freed.join() === 'maps:5/10/12', 'and a tile freed is given back');
}
process.exit(failures ? 1 : 0);
