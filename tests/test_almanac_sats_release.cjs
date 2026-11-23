// Leaving the Almanac while the satellite catalogue is still loading (almanac-sats.js): the load that was in flight
// must not start a worker or set the data afterwards.
//
// Run: node tests/test_almanac_sats_release.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-sats.js'), 'utf8');
let failures = 0;
function check(ok, what) { if (!ok) { failures++; console.log('FAIL: ' + what); } else console.log('ok: ' + what); }
function between(from, until) { const a = src.indexOf(from); const b = src.indexOf(until, a); return src.slice(a, b); }

const pieces = ['var _asGen = 0;',between('function _asSatLoad() {', '// The button\'s look'), between('function _asRelease() {', '// The GPU scene')].join('\n');

let workers = 0, release;
const gate = new Promise((r) => { release = r; });
const sb = {
  _as: { state: 'idle', on: true, worker: null, data: null, bar: null, sheetEl: null },
  _asSync() {}, _asBuildBar() {}, _asApplyFilters() {}, _asNeedPasses() {}, _asStandSkyOff() {}, _aeKick() {}, _ae: null,
  _aeLoadSgp4: () => gate.then(() => ({})),
  _aeFetch: () => gate, _aeJson: () => ({}),
  _asDecode: () => ({ n: 1 }), _asCapData: (d) => d,
  _asStartWorker: () => { workers++; sb._as.worker = { terminate() {} }; return Promise.resolve(); },
  AS_URL: 'x',
};
vm.createContext(sb);
vm.runInContext(pieces, sb);

(async () => {
  const p = vm.runInContext('_asSatLoad()', sb);
  vm.runInContext('_asRelease()', sb);
  release();
  await p;
  check(workers === 0, 'a release while loading starts no worker');
  check(sb._as.data === null, 'a release while loading leaves no data');
  check(sb._as.state === 'idle', 'the state stays idle');
  const q = vm.runInContext('_asSatLoad()', sb);
  await q;
  check(workers === 1 && sb._as.state === 'ready', 'a load after the release runs');
  process.exit(failures ? 1 : 0);
})();
