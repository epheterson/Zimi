// Share says what happened. Inside Zimi the games run in a frame that may not be allowed the system's share sheet: the share
// is refused, and the result used to vanish without a word. Now a refused share copies the text and the button says "Copied";
// a person closing the share sheet (AbortError) is left alone, and a copy that fails says so.
//
// Run: node tests/test_games_share.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

function shell(nav, copyCommand) {
  const store = {};
  const doc = {
    readyState: 'complete', body: { appendChild() {} }, head: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, style: {}, select() {}, remove() {} }),
    documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], title: 'Five Letters - ZimiGames',
    execCommand: () => copyCommand
  };
  const timers = [];
  const sb = {
    console, document: doc, navigator: nav, location: { pathname: '/w/zimi_games/fiveletters.html', search: '', hash: '' }, addEventListener() {},
    matchMedia: () => ({ matches: true }), URL, Date, setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }
  };
  sb.window = sb;
  vm.createContext(sb);
  for (const f of ['util.js', 'text.js', 'shell.js']) vm.runInContext(read(f), sb, { filename: f });
  return sb.ZimiShell;
}
const tick = () => new Promise((r) => setImmediate(r));
const reject = (name) => () => Promise.reject(Object.assign(new Error(name), { name }));

(async () => {
  let wrote = null;
  let btn = { textContent: 'Copy result' };
  let S = shell({ share: reject('NotAllowedError'), clipboard: { writeText: (t) => { wrote = t; return Promise.resolve(); } } }, true);
  S.share('the result', btn); await tick(); await tick();
  check(wrote === 'the result' && btn.textContent === 'Copied', 'a refused share copies the text and the button says Copied (' + btn.textContent + ')');

  wrote = null; btn = { textContent: 'Copy result' };
  S = shell({ share: reject('AbortError'), clipboard: { writeText: (t) => { wrote = t; return Promise.resolve(); } } }, true);
  S.share('the result', btn); await tick(); await tick();
  check(wrote === null && btn.textContent === 'Copy result', 'closing the share sheet is not a failure: nothing is copied behind it');

  let shared = null; btn = { textContent: 'Copy result' };
  S = shell({ share: (o) => { shared = o.text; return Promise.resolve(); }, clipboard: { writeText: () => Promise.reject(new Error('no')) } }, true);
  S.share('the result', btn); await tick(); await tick();
  check(shared === 'the result' && btn.textContent === 'Copy result', 'a share that goes through is the system\'s to acknowledge');

  btn = { textContent: 'Copy result' };
  S = shell({ share: reject('NotAllowedError'), clipboard: { writeText: () => Promise.reject(new Error('blocked')) } }, true);
  S.share('the result', btn); await tick(); await tick();
  check(btn.textContent === 'Copied', 'with the clipboard blocked too, the old copy command still copies (' + btn.textContent + ')');

  btn = { textContent: 'Copy result' };
  S = shell({ share: reject('NotAllowedError'), clipboard: { writeText: () => Promise.reject(new Error('blocked')) } }, false);
  S.share('the result', btn); await tick(); await tick();
  check(btn.textContent === 'Could not copy', 'and when nothing can copy, the button says so (' + btn.textContent + ')');

  if (failures) { console.error(failures + ' failed'); process.exit(1); }
  console.log('share: all passed');
})();
