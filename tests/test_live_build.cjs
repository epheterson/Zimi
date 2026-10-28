// An open window updates itself to a new build (Eric, 2026-10-23: "Maybe
// you can even handle like site deployments" and "the pwa relaunch dance
// gets annoying"): when it reloads, when it waits, and that it never loops.
//
// Run: node tests/test_live_build.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
function fn(name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('could not extract ' + name);
  return m[0];
}
let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};
const tick = () => new Promise(r => setImmediate(r));

function page(opts) {
  const session = {}, listeners = {}, reloads = [];
  const sb = {
    Promise, JSON, Array, setTimeout: () => 0,
    _BUILD: 'zimi-v1-old', _buildWaiting: '', _UPDATE_TRIED_KEY: 'zimi_update_tried', _UPDATE_RESUME_KEY: 'zimi_update_resume',
    _BUILD_SW_WAIT_MS: 15000,
    sessionStorage: { getItem: k => (k in session ? session[k] : null), setItem: (k, v) => { session[k] = String(v); }, removeItem: k => { delete session[k]; } },
    navigator: {}, // no worker: the reload need not wait for one
    location: { href: 'http://zimi/', reload: () => reloads.push(1) },
    document: {
      hidden: !!opts.hidden, activeElement: null,
      querySelectorAll: () => [],
      addEventListener: (type, f) => { (listeners[type] = listeners[type] || []).push(f); },
      removeEventListener: (type, f) => { listeners[type] = (listeners[type] || []).filter(g => g !== f); },
      getElementById: () => null,
    },
    mode: opts.mode || 'home', readerOpen: !!opts.readerOpen, _almanacOpen: false, _createOpen: false, _ttsSpeaking: !!opts.speaking,
  };
  vm.createContext(sb);
  vm.runInContext(['_buildHeard', '_buildWorker', '_buildReload', '_buildSafe', '_buildQuiet', '_updateResumeKeep'].map(fn).join('\n'), sb);
  return { sb, session, listeners, reloads, hide() { sb.document.hidden = true; (listeners.visibilitychange || []).forEach(f => f()); } };
}

(async () => {
  let p = page({});
  p.sb._buildHeard('zimi-v1-old');
  await tick();
  check(p.reloads.length === 0, 'the build it was opened with: nothing to do');

  p.sb._buildHeard('zimi-v1-new');
  await tick(); await tick();
  check(p.reloads.length === 1, 'a new build, on the home page with nothing in hand: it reloads');
  check(p.session.zimi_update_tried === 'zimi-v1-new', '...and remembers the build it reloaded for');

  p = page({});
  p.session.zimi_update_tried = 'zimi-v1-new';
  p.sb._buildHeard('zimi-v1-new');
  await tick(); await tick();
  check(p.reloads.length === 0, 'reloaded once and still on the old page: never again for that build, no loop');
  p.sb._buildHeard('zimi-v1-newer');
  await tick(); await tick();
  check(p.reloads.length === 1, '...a later build is tried again');

  p = page({ readerOpen: true, mode: 'reader' });
  p.sb._buildHeard('zimi-v1-new');
  await tick(); await tick();
  check(p.reloads.length === 0, 'an article open on screen: it waits');
  p.hide();
  check(p.reloads.length === 0, '...and hiding the window with it open does not reload it (a game or article is never lost to an update)');
  p.sb.readerOpen = false; p.sb.document.hidden = false;
  p.hide();
  check(p.reloads.length === 1, '...it reloads on the first hide after the reader is closed');

  p = page({ speaking: true });
  p.sb._buildHeard('zimi-v1-new');
  await tick(); await tick();
  check(p.reloads.length === 0, 'reading aloud on the home page: it waits too');

  p = page({ hidden: true, readerOpen: true, mode: 'reader' });
  p.sb._buildHeard('zimi-v1-new');
  await tick(); await tick();
  check(p.reloads.length === 0, 'a hidden window with an article or game open waits, it does not reload under the player');
  p = page({ hidden: true });
  p.sb._buildHeard('zimi-v1-new');
  await tick(); await tick();
  check(p.reloads.length === 1, 'a hidden window with nothing open reloads at once');

  p = page({});
  p.sb.document.activeElement = { tagName: 'INPUT', value: 'water purif' };
  check(p.sb._buildQuiet() === false, 'a search being typed is something in hand');
  p.sb.document.activeElement = { tagName: 'INPUT', value: '' };
  check(p.sb._buildQuiet() === true, '...an empty, focused box is not');

  check(/addEventListener\('tick'[\s\S]{0,300}_buildHeard\(d\.build\)/.test(src), 'every tick of /events is read for the build');
  check(/__ZIMI_CONFIG\.build/.test(src), 'the page knows the build it is');

  if (failures) { console.error('\n' + failures + ' failed'); process.exit(1); }
  console.log('\nall live build checks passed');
})();
