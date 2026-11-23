// Leaving a site (almanac-sites.js _asDispose) gives back every geometry and material hung on its group: the ground, rocks, shadow,
// tracks, tread marks, lamps and the drive's dotted line and pillar, not only the few it named.
//
// Run: node tests/test_almanac_sites_dispose.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-sites.js'), 'utf8');
const a = src.indexOf('function _asDispose(st) {');
const fn = src.slice(a, src.indexOf('\n}\n', a) + 2);

const freed = new Set();
const res = (n) => ({ n, dispose() { freed.add(n); } });
const mesh = (n) => ({ geometry: res(n + '.geo'), material: res(n + '.mat') });
const kids = ['ground', 'rocks', 'shadow', 'tracks', 'tread', 'lamp0', 'lamp1', 'autoLine', 'autoMark'].map(mesh);
const group = { traverse(f) { f(group); kids.forEach(f); } };
const sb = {
  _ae: { gl: { scene: { remove() {} } } },
  _asLaunchReset() {}, _asTrailStop() {},
  st: { group, groundGeo: res('groundGeo'), rockGeo: res('rockGeo'), models: {}, tracksMesh: kids[3] },
};
vm.createContext(sb);
vm.runInContext(fn + '\n_asDispose(st);', sb);
let failures = 0;
['ground', 'rocks', 'shadow', 'tracks', 'tread', 'lamp0', 'lamp1', 'autoLine', 'autoMark'].forEach((n) => {
  const ok = freed.has(n + '.geo') && freed.has(n + '.mat');
  if (!ok) { failures++; console.log('FAIL: ' + n + ' is freed'); } else console.log('ok: ' + n + ' is freed');
});
if (sb.st.group !== null) { failures++; console.log('FAIL: the group is dropped'); }
process.exit(failures ? 1 : 0);
