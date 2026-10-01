// The Environment section of Server settings. It sat on "Loading…" for good
// (Eric, from his phone, 2026-09-19): the section looked its element up when
// called, which is while the pane's markup is still being built, found
// nothing, and dropped the answer when it arrived.
//
// Run: node tests/test_env_panel.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from app.js');
  return m[0];
}
let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

// A pane that does not exist when the section is called, and does by the
// time the fetch answers: the real order of events.
let el = null;
let resolveFetch;
const ctx = {
  _msFetch: () => new Promise(r => { resolveFetch = r; }),
  document: { getElementById: id => (id === 'ms-env' ? el : null) },
  tH: (k, v) => k + (v ? JSON.stringify(v) : ''),
  esc: s => String(s == null ? '' : s),
};
vm.createContext(ctx);
vm.runInContext(extract(/function _ltr\(html\) \{[^\n]*\n/, '_ltr') + extract(/async function _renderEnvSection\(\) \{[\s\S]*?\n\}/, '_renderEnvSection'), ctx);

(async () => {
  const p = ctx._renderEnvSection();          // called before the pane exists
  el = { innerHTML: 'Loading…' };             // the pane is inserted
  resolveFetch({ vars: [{ name: 'ZIM_DIR', value: '/zims', description: 'Where the ZIM files are', locks: 'ZIM folder', source: 'env', path: '' }] });
  await p;
  ok('folded by default: the names are the summary, a tap opens the rest',
    /^<details class="net-details env-details"><summary><span class="env-names" dir="ltr">ZIM_DIR<\/span><\/summary>/.test(el.innerHTML) && !/<details[^>]* open/.test(el.innerHTML));
  ok('a name and a value read left to right in a right-to-left page (/zims keeps its slash first in Hebrew)',
    /<code class="env-name"><bdi dir="ltr">ZIM_DIR<\/bdi><\/code>/.test(el.innerHTML) && /<code class="env-value"><bdi dir="ltr">\/zims<\/bdi><\/code>/.test(el.innerHTML));
  ok('so do the folder fields and the commands in Settings',
    (src.match(/id="ms-(zim|data)-dir" dir="ltr"/g) || []).length === 4 && (src.match(/class="app-update-cmd" dir="ltr"/g) || []).length === 2 &&
    /<code dir="ltr">ZIMI_PUBLIC_ACCESS=/.test(src) && /env_from_config', \{path: _ltr\(esc\(r\.path\)\)\}/.test(src));
  ok('the answer lands in the element that exists when it arrives', /ZIM_DIR/.test(el.innerHTML) && /\/zims/.test(el.innerHTML), el.innerHTML.slice(0, 80));

  el = null;
  const p2 = ctx._renderEnvSection();
  el = { innerHTML: 'Loading…' };
  resolveFetch({ vars: [] });
  await p2;
  ok('nothing overridden says so', /env_none/.test(el.innerHTML));

  el = null;
  ctx._msFetch = () => Promise.reject(new Error('http 500'));
  const p3 = ctx._renderEnvSection();
  el = { innerHTML: 'Loading…' };
  await p3;
  ok('a failed fetch says so, in the element that exists by then', /env_unavailable/.test(el.innerHTML));

  const fn = extract(/async function _renderEnvSection\(\) \{[\s\S]*?\n\}/, '_renderEnvSection');
  ok('the element is looked up after the fetch, never before', fn.indexOf("getElementById('ms-env')") > fn.indexOf('await _msFetch'));
  process.exit(failures ? 1 : 0);
})();
