// The debug log's flush when the page is left: a beacon the browser refuses is kept for the next flush, never retried in a loop.
//
// Run: node tests/test_debuglog_flush.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

function load(beacon) {
  const calls = { beacon: 0, fetch: 0 };
  const noop = () => {};
  const win = { addEventListener: noop, removeEventListener: noop, innerWidth: 390, innerHeight: 844, devicePixelRatio: 1 };
  const sandbox = {
    window: win, innerWidth: 390, innerHeight: 844,
    document: { addEventListener: noop, removeEventListener: noop, getElementById: () => null, visibilityState: 'visible' },
    location: { href: 'http://x/', pathname: '/', search: '', hash: '' },
    navigator: { userAgent: 'node', sendBeacon: () => { calls.beacon++; return beacon; } },
    history: { pushState: noop, replaceState: noop },
    console: { warn: noop, error: noop, log: noop },
    Blob: function () {}, JSON, Date, Math, String, Array, Object,
    fetch: () => { calls.fetch++; return Promise.resolve({ status: 200 }); },
    setInterval: () => 1, clearInterval: noop, setTimeout: noop, requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'debuglog.js'), 'utf8') + '\nthis._dbl = _dbl;', sandbox, { filename: 'debuglog.js' });
  return { dbl: sandbox._dbl, calls };
}

{
  const { dbl, calls } = load(false);
  dbl.start();
  dbl.rec('tap', { el: 'a' });
  let threw = null;
  try { dbl.flush(true); } catch (e) { threw = e; }
  ok('a refused beacon does not recurse', !threw, threw && String(threw.message));
  ok('a refused beacon is tried once', calls.beacon === 1, 'beacon calls: ' + calls.beacon);
  dbl.flush(false);
  ok('the refused batch goes out with the next flush', calls.fetch === 1, 'fetch calls: ' + calls.fetch);
}
{
  const { dbl, calls } = load(true);
  dbl.start();
  dbl.rec('tap', { el: 'a' });
  dbl.flush(true);
  ok('an accepted beacon is sent once and the queue is empty', calls.beacon === 1 && (dbl.flush(false), calls.fetch === 0), JSON.stringify(calls));
}

process.exit(failures ? 1 : 0);
