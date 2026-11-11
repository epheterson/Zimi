// The satellite catalogue under the capability level (almanac-sats.js _asCapData, capability.js ZimiCap 'satMax'): the ISS and the GPS
// stay, then the largest by radar cross-section, in the file's order; the columns stay parallel; without ZimiCap (or room enough) the
// catalogue is untouched.
// Run: node tests/test_almanac_cap_sats.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-sats.js'), 'utf8');
function fn(name) {
  const a = src.indexOf('\nfunction ' + name + '(') + 1;
  if (a <= 0) throw new Error(name);
  let i = src.indexOf('{', a), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(a, i + 1); }
  throw new Error(name);
}
const line = (re) => re.exec(src)[0];
function load(cap) {
  const C = { Math, Array, Int32Array, Float32Array, Float64Array, Uint8Array };
  if (cap) C.ZimiCap = cap;
  vm.createContext(C);
  vm.runInContext([line(/^var AS_ISS_NORAD = 25544,[^;]+;/m), line(/^var AS_CAP_FIRST = [^;]+;/m), fn('_asCapData')].join('\n'), C);
  return C._asCapData;
}

// 12 satellites: the ISS late in the file with no radar size, two GPS small, and ten others of rising size (one without a size).
const names = ['A', 'B', 'C', 'GPS BIIR-2', 'D', 'E', 'ISS (ZARYA)', 'F', 'G', 'NAVSTAR 80', 'H', 'I'];
const rcs = [5, 1, 9, 0.5, 7, NaN, NaN, 3, 8, 0.4, 2, 6];
const n = names.length;
const d = {
  n, fetched: 1, source: 'x', stale: false, owners: ['', 'US'], ownerCount: { '': 1, US: 11 }, topOwners: ['US'], name: names.slice(),
  norad: Int32Array.from(names.map((_, i) => (names[i].startsWith('ISS') ? 25544 : 1000 + i))), epoch: new Float64Array(n), mm: new Float64Array(n).fill(15),
  ecc: new Float64Array(n), inc: new Float64Array(n), raan: new Float64Array(n), argp: new Float64Array(n), ma: new Float64Array(n), bstar: new Float64Array(n),
  launch: new Int32Array(n), rcs: Float32Array.from(rcs), alt: new Float32Array(n), group: new Uint8Array(n), orbit: new Uint8Array(n), owner: new Uint8Array(n),
};
for (let i = 0; i < n; i++) d.epoch[i] = i;

check(load(null)(d) === d, 'without ZimiCap the catalogue is untouched');
check(load({ get: () => 30000 })(d) === d, 'and with room for all of it');
const cut = load({ get: (k) => (k === 'satMax' ? 6 : 0) })(d);
check(cut.n === 6 && cut.name.length === 6 && cut.norad.length === 6 && cut.rcs.length === 6, 'a level of 6 keeps six, every column the same length');
check(cut.name.includes('ISS (ZARYA)') && cut.name.includes('GPS BIIR-2') && cut.name.includes('NAVSTAR 80'), 'the ISS and the GPS are kept though they are small or unsized');
const expect = ['C', 'GPS BIIR-2', 'D', 'ISS (ZARYA)', 'G', 'NAVSTAR 80'];
check(JSON.stringify(cut.name) === JSON.stringify(expect.slice().sort((a, b) => names.indexOf(a) - names.indexOf(b))), 'the rest are the largest by radar size (9, 7, 8), in the file\'s order: ' + cut.name.join(', '));
check(Array.from(cut.epoch).join() === cut.name.map((x) => names.indexOf(x)).join(), 'each column follows its satellite (epoch = original index)');
const tight = load({ get: () => 2 })(d);
check(tight.n === 2 && tight.name.join() === 'GPS BIIR-2,ISS (ZARYA)'.split(',').sort((a, b) => names.indexOf(a) - names.indexOf(b)).join(), 'a level of 2 keeps the ISS and a GPS before anything larger');
process.exit(failures ? 1 : 0);
