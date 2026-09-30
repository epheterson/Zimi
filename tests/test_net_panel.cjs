// "What Zimi fetches from the internet" in Server settings, and the "Check
// for updates" choice beside it (Eric, 2026-09-28: "i'm not positive how i
// feel about unexpected network calls from zimi").
//
// The section folds to one line of counts, which is the answer a phone needs;
// open, each row has its name, its state, what and where, and a link to its
// switch when this pane has one. Every word is a locale key that exists.
//
// Run: node tests/test_net_panel.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'en.json'), 'utf8'));
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

// tH renders the English string, so a missing key shows up as itself.
const used = new Set();
function tH(k, v) {
  used.add(k);
  let s = en[k] === undefined ? '<<' + k + '>>' : en[k];
  Object.keys(v || {}).forEach(n => { s = s.split('{' + n + '}').join(String(v[n])); });
  return s;
}
const escape = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let el = null;
let answer = null;
const ctx = {
  tH, t: tH, esc: escape, escAttr: escape,
  _msFetch: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  document: { getElementById: id => (id === 'ms-net' ? el : null) },
  _MS_SECTIONS: ['library', 'preferences', 'creator', 'server', 'users'],
};
vm.createContext(ctx);
vm.runInContext("var _APP_UPDATE_CHECK_ID = 'app-update-check';", ctx);
vm.runInContext(extract(/var _NET_ID = [\s\S]*?\nasync function _renderNetSection\(\) \{[\s\S]*?\n\}/, 'the network section'), ctx);

const rows = [
  { id: 'catalog', hosts: ['library.kiwix.org'], state: 'ask', control: 'offline' },
  { id: 'downloads', hosts: ['download.kiwix.org'], state: 'auto', control: 'auto_update' },
  { id: 'bittorrent', hosts: [], state: 'auto', control: 'sharing' },
  { id: 'portcheck', hosts: ['portcheck.transmissionbt.com'], state: 'ask', control: 'sharing' },
  { id: 'app_updates', hosts: ['api.github.com', 'raw.githubusercontent.com'], state: 'auto', control: 'update_check' },
  { id: 'satellites', hosts: ['celestrak.org'], state: 'ask', control: 'satellites' },
  { id: 'streetzim', hosts: ['archive.org'], state: 'ask', control: 'offline' },
  { id: 'sso', hosts: ['team<x>.cloudflareaccess.com'], state: 'unset', control: '' },
  { id: 'create', hosts: [], state: 'ask', control: '' },
  { id: 'nearby', hosts: [], state: 'lan', control: 'sharing' },
];

(async () => {
  el = { innerHTML: 'Loading…', querySelector: () => null };
  answer = { offline: false, rows };
  await ctx._renderNetSection();
  const h = el.innerHTML;
  ok('folded to one line of counts', /<details class="net-details"><summary>On its own: 3 · When asked: 5 · Off: 1<\/summary>/.test(h), h.slice(0, 120));
  ok('ten rows, one per destination', (h.match(/<li class="net-row">/g) || []).length === 10);
  ok('no row shows a raw key', !/<</.test(h), (h.match(/<<[^>]*>>/g) || []).join(' '));
  ok('each row says its state', /net-state-auto">On its own</.test(h) && /net-state-lan">This network</.test(h) && /net-state-unset">Not set up</.test(h));
  ok('hosts read left to right, escaped', /<code dir="ltr">library\.kiwix\.org<\/code>/.test(h) && /team&lt;x&gt;/.test(h) && !/team<x>/.test(h));
  ok('a row with a switch here links to it', /_netGo\('update_check'\)/.test(h) && /_netGo\('auto_update'\)/.test(h));
  // The satellite data's switch is the Almanac's Earth view (a hidden
  // Easter egg), not Settings, so its row has no link.
  ok('the satellite row has no switch here', !/_netGo\('satellites'\)/.test(h));
  const linkCount = (h.match(/class="net-go"/g) || []).length;
  ok('rows changed only by ZIMI_OFFLINE or by the person have no link', linkCount === 5, String(linkCount));

  el = { innerHTML: '', querySelector: () => null };
  answer = { offline: true, rows: rows.map(r => Object.assign({}, r, { state: r.id === 'nearby' ? 'lan' : 'off' })) };
  await ctx._renderNetSection();
  ok('offline says so in the folded line', /<summary>Offline \(ZIMI_OFFLINE\)/.test(el.innerHTML));
  ok('offline, no row offers a switch ZIMI_OFFLINE has taken', !/net-go/.test(el.innerHTML));

  el = { innerHTML: '', querySelector: () => null };
  answer = new Error('http 500');
  await ctx._renderNetSection();
  ok('a failed fetch says so', el.innerHTML.indexOf(en.net_unavailable) >= 0);

  // Open stays open across a repaint (after a setting changes).
  let reopened = false;
  el = { innerHTML: '', querySelector: sel => (sel === 'details[open]' ? {} : { set open(v) { reopened = v; } }) };
  answer = { offline: false, rows };
  await ctx._renderNetSection();
  ok('an open list stays open when it repaints', reopened === true);

  // Every state and row the server can send has its words.
  const states = ['auto', 'ask', 'off', 'unset', 'lan'];
  ok('every state has its words', states.every(s => en['net_state_' + s]));
  ok('every row has its name and when', rows.every(r => en['net_' + r.id] && en['net_' + r.id + '_when']));
  ok('every key the section used exists', [...used].every(k => k in en), [...used].filter(k => !(k in en)).join(' '));

  // The update-check choice: the same three labels the satellite setting uses.
  const checkFn = extract(/function _appUpdateCheckHtml\(d\) \{[\s\S]*?\n\}/, '_appUpdateCheckHtml');
  ok('Check for updates offers ask, auto and never with the shared labels', /alm_earth_sat_' \+ m/.test(checkFn) && /\['ask', 'auto', 'never'\]/.test(checkFn));
  ok('its words exist', ['app_update_check', 'app_update_check_hint', 'app_update_checks_off'].every(k => en[k]));
  const statusFn = extract(/function _appUpdateStatusHtml\(d, checking\) \{[\s\S]*?\n\}/, '_appUpdateStatusHtml');
  ok('Never hides Check now', /d\.check_mode === 'never' \? ''/.test(statusFn));

  // The port check: asked only when the sharing settings open with
  // BitTorrent on (once per opening) or on Recheck; a quiet failure.
  const natCtx = { posts: [], toasts: [], document: { querySelector: () => null, getElementById: () => null } };
  natCtx.manageFetch = (url) => { natCtx.posts.push(url); return Promise.resolve({ ok: false, json: () => Promise.resolve({}) }); };
  natCtx._showToast = (m) => natCtx.toasts.push(m);
  natCtx.t = tH;
  vm.createContext(natCtx);
  vm.runInContext(extract(/var _natCheckedThisOpening = false;[\s\S]*?\nasync function _natRecheck\(btn, quiet\) \{[\s\S]*?\n\}/, 'the port check'), natCtx);
  natCtx._natCheckOnOpen(false);
  ok('BitTorrent off: the opening asks nothing', natCtx.posts.length === 0);
  natCtx._natCheckOnOpen(true);
  natCtx._natCheckOnOpen(true);
  await new Promise(r => setTimeout(r, 10));
  ok('BitTorrent on: the opening asks once', natCtx.posts.filter(u => u === '/manage/nat-recheck').length === 1, natCtx.posts.join(' '));
  ok('the opening\'s own check fails quietly', natCtx.toasts.length === 0);
  vm.runInContext('_natCheckedThisOpening = false', natCtx);
  natCtx._natCheckOnOpen(true);
  await new Promise(r => setTimeout(r, 10));
  ok('a new opening asks again', natCtx.posts.filter(u => u === '/manage/nat-recheck').length === 2);
  const serverFn = extract(/function _msServerHtml\(\) \{[\s\S]*?\n\}/, '_msServerHtml');
  const mirrorFn = extract(/async function _renderMirrorSection\(\) \{[\s\S]*?\n\}/, '_renderMirrorSection');
  ok('the Server pane opening resets it', /_natCheckedThisOpening = false/.test(serverFn));
  ok('the sharing rows ask after they paint', /_natCheckOnOpen\(btOn\)/.test(mirrorFn));
  ok('the row says when', /open the sharing settings/.test(en.net_portcheck_when));

  // No em dashes in the new strings, in any language.
  const keys = Object.keys(en).filter(k => k.startsWith('net_') || k.startsWith('app_update_check'));
  const langs = fs.readdirSync(path.join(root, 'i18n')).filter(f => f.endsWith('.json'));
  const dashed = [];
  langs.forEach(f => {
    const d = JSON.parse(fs.readFileSync(path.join(root, 'i18n', f), 'utf8'));
    keys.forEach(k => { if (/[\u2014\u2013]/.test(d[k] || '')) dashed.push(f + ':' + k); });
  });
  ok('no dashes standing in for punctuation', dashed.length === 0, dashed.join(' '));
  process.exit(failures ? 1 : 0);
})();
