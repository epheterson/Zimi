// The card air's render targets, probe and materials (almanac-oneair.js) are disposed and forgotten when the view's GL goes,
// so a reopened view builds them again instead of holding dead targets.
//
// Run: node tests/test_almanac_oneair_gone.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const air = fs.readFileSync(path.join(root, 'almanac-oneair.js'), 'utf8');
const earth = fs.readFileSync(path.join(root, 'almanac-earth.js'), 'utf8');
let failures = 0;
function check(ok, what) { if (!ok) { failures++; console.log('FAIL: ' + what); } else console.log('ok: ' + what); }

// The view's teardown calls the hook, and the hook is defined where the air lives.
const dispose = earth.slice(earth.indexOf('function _aeDisposeGl() {'), earth.indexOf('// Every geometry, material and map of a scene'));
check(/_oaGlGone/.test(dispose), 'the view\'s GL teardown calls the air\'s hook');

const a = air.indexOf('function _oaGlGone() {');
const hook = a < 0 ? '' : air.slice(a, air.indexOf('\n}\n', a) + 2);
const disposed = [];
const d = (n) => ({ dispose() { disposed.push(n); } });
const sb = { _oa: { trans: d('trans'), multi: d('multi'), viewS: d('viewS'), viewM: d('viewM'), viewE: d('viewE'), probe: { rt: d('rt'), mat: d('pmat') },
  matTrans: d('matTrans'), matMulti: d('matMulti'), matView: d('matView'), mesh: { geometry: d('geo') } }, _oaWarming: {}, _oaGen: 0 };
vm.createContext(sb);
vm.runInContext(hook + '\n_oaGlGone();', sb);
check(sb._oa === null, 'the air is forgotten');
check(disposed.length === 11, 'all eleven GPU objects are disposed (' + disposed.length + ')');
process.exit(failures ? 1 : 0);
