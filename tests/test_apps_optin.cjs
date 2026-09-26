// Zimipedia is a preview being redesigned: off unless the server names it
// (ZIMI_APPS=...,wiki, or a saved list naming it). The shell with no stamp
// is the default apps, which leave it out; the pickers do not list it and
// /#wiki goes home until it is offered. The server half is
// tests/test_apps_switch.py.
//
// Run: node tests/test_apps_optin.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}
function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from app.js');
  return m[0];
}

const calls = [];
const ctx = {
  document: { body: { dataset: {} } },
  location: { hash: '#wiki' },
  history: { replaceState: (st, title, url) => calls.push(['replace', url]) },
  mode: 'reader',
  enterHome: () => { calls.push(['home']); ctx.mode = 'home'; },
  _openHashApp: (app) => calls.push(['open', app]),
  _userSession: null,
};
vm.createContext(ctx);
vm.runInContext([
  extract(/var APP_NAMES = [^\n]*\n/, 'APP_NAMES'),
  extract(/var APPS_OPT_IN = [^\n]*\n/, 'APPS_OPT_IN'),
  extract(/function _appOptIn\(app\) \{[^\n]*\n/, '_appOptIn'),
  extract(/var APPS_DEFAULT = [^\n]*\n/, 'APPS_DEFAULT'),
  extract(/var _userPrefs = [^\n]*\n/, '_userPrefs'),
  extract(/function _appsAllowedByServer\(app\) \{[\s\S]*?\n\}/, '_appsAllowedByServer'),
  extract(/function _appShown\(app\) \{[\s\S]*?\n\}/, '_appShown'),
  extract(/function _serverOfferable\(shown\) \{[\s\S]*?\n\}/, '_serverOfferable'),
  extract(/function openWiki\(replaceState\) \{[\s\S]*?\n\}/, 'openWiki'),
].join('\n'), ctx);

// ── the shell's stamp ────────────────────────────────────────────────────
ok('no stamp: every app but Zimipedia', ctx.APP_NAMES.filter(ctx._appsAllowedByServer).join() === 'maps,tube,exchange,reddot,books');
ok('no stamp: the apps row is still on', ctx._appsAllowedByServer() === true);
ctx.document.body.dataset.zimiApps = 'maps,wiki';
ok('a stamp naming wiki offers it', ctx._appsAllowedByServer('wiki') && !ctx._appsAllowedByServer('tube'));
delete ctx.document.body.dataset.zimiApps;

// ── the pickers ──────────────────────────────────────────────────────────
ok('Server settings lists the default apps, not Zimipedia, when the server does not offer it',
  ctx._serverOfferable(['maps', 'tube']).join() === 'maps,tube,exchange,reddot,books');
ok('and lists Zimipedia while the server offers it', ctx._serverOfferable(['wiki']).indexOf('wiki') >= 0);
ok('the Server settings picker and its All button draw from that list, not every app',
  /el\.innerHTML = _appPicksHtml\(_serverOfferable\(shown\),/.test(src) &&
  /function _setAppsForServerAll\(on\) \{ _postServerApps\(on \? _serverOfferable\(_serverApps\) : \[\]\); \}/.test(src));
ok('the shell drops its stamp when the server is back to the default apps, not to every app',
  /if \(d\.shown\.join\(','\) === APPS_DEFAULT\.join\(','\)\) delete document\.body\.dataset\.zimiApps;/.test(src));
ok('an account\'s own picker lists only what the server offers',
  /_appPicksHtml\(APP_NAMES\.filter\(_appsAllowedByServer\), _appShown, '_setUserApp'\)/.test(src));
ctx._userSession = { name: 'eric' };
ok('a signed-in account with no preference does not see Zimipedia by default', !ctx._appShown('wiki') && ctx._appShown('books'));
ctx._userSession = null;

// ── /#wiki ───────────────────────────────────────────────────────────────
ctx.openWiki(true);
ok('/#wiki on a server that does not offer it goes home, at /',
  calls.some(c => c[0] === 'home') && calls.some(c => c[0] === 'replace' && c[1] === '/') && !calls.some(c => c[0] === 'open'), JSON.stringify(calls));
calls.length = 0;
ctx.document.body.dataset.zimiApps = 'wiki';
ctx.openWiki(true);
ok('offered, /#wiki opens Zimipedia', calls.length === 1 && calls[0][0] === 'open' && calls[0][1] === 'wiki', JSON.stringify(calls));

process.exit(failures ? 1 : 0);
