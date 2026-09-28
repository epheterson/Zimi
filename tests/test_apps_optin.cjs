// Zimipedia was a preview, off unless the server named it, until its reader
// (1.12): it is on by default now, like every app. The shell with no stamp
// is every app; a server that leaves Zimipedia out (ZIMI_APPS, a saved list)
// stamps the shell without it, the pickers still list it, and /#wiki goes
// home. The opt-in mechanism stays for a preview to come, empty. The
// server half is tests/test_apps_switch.py.
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
  _wikiReaderLoad: () => {},
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
  extract(/function _setAppsStamp\(stamp\) \{[\s\S]*?\n\}/, '_setAppsStamp'),
  extract(/function _serverOfferable\(shown\) \{[\s\S]*?\n\}/, '_serverOfferable'),
  extract(/function openWiki\(replaceState\) \{[\s\S]*?\n\}/, 'openWiki'),
].join('\n'), ctx);

// ── the shell's stamp ────────────────────────────────────────────────────
ok('no preview app now: Zimipedia is not held back', ctx.APPS_OPT_IN.length === 0 && ctx.APPS_DEFAULT.join() === ctx.APP_NAMES.join());
ok('no stamp: every app, Zimipedia too', ctx.APP_NAMES.filter(ctx._appsAllowedByServer).join() === 'maps,tube,exchange,reddot,wiki,books');
ok('no stamp: the apps row is still on', ctx._appsAllowedByServer() === true);
ctx.document.body.dataset.zimiApps = 'maps,wiki';
ok('a stamp naming wiki offers it', ctx._appsAllowedByServer('wiki') && !ctx._appsAllowedByServer('tube'));
ctx.document.body.dataset.zimiApps = 'maps,books';
ok('a stamp without wiki does not', !ctx._appsAllowedByServer('wiki') && ctx._appsAllowedByServer('books'));
delete ctx.document.body.dataset.zimiApps;

// ── the pickers ──────────────────────────────────────────────────────────
ok('Server settings lists every app, Zimipedia too, whatever the server offers now',
  ctx._serverOfferable(['maps', 'tube']).join() === 'maps,tube,exchange,reddot,wiki,books');
ok('and lists Zimipedia while the server offers it', ctx._serverOfferable(['wiki']).indexOf('wiki') >= 0);
ok('the Server settings picker and its All button draw from that list, not every app',
  /el\.innerHTML = _appPicksHtml\(_serverOfferable\(shown\),/.test(src) &&
  /function _setAppsForServerAll\(on\) \{ _postServerApps\(on \? _serverOfferable\(_serverApps\) : \[\]\); \}/.test(src));
ok('the shell drops its stamp when the server is back to the default apps, not to every app',
  /_setAppsStamp\(d\.shown\.join\(','\) === APPS_DEFAULT\.join\(','\) \? null : d\.shown\.join\(','\) \|\| '0'\)/.test(src));
ctx._setAppsStamp('books');
ok('a stamp from the server is the shell\'s', ctx._appsAllowedByServer('books') && !ctx._appsAllowedByServer('maps'));
ctx._setAppsStamp(null);
ok('and none is the default apps', !('zimiApps' in ctx.document.body.dataset) && ctx._appsAllowedByServer('maps'));
ok('every boot takes the stamp from /whoami, so a shell kept by Back is corrected (#98)',
  /if \(j && 'apps' in j\) _setAppsStamp\(j\.apps\);/.test(src));
ok('an account\'s own picker lists only what the server offers',
  /_appPicksHtml\(APP_NAMES\.filter\(_appsAllowedByServer\), _appShown, '_setUserApp'\)/.test(src));
ctx._userSession = { name: 'eric' };
ok('a signed-in account with no preference sees Zimipedia by default', ctx._appShown('wiki') && ctx._appShown('books'));
ctx._userSession = null;

// ── /#wiki ───────────────────────────────────────────────────────────────
ctx.document.body.dataset.zimiApps = 'maps,books';
ctx.openWiki(true);
ok('/#wiki on a server that does not offer it goes home, at /',
  calls.some(c => c[0] === 'home') && calls.some(c => c[0] === 'replace' && c[1] === '/') && !calls.some(c => c[0] === 'open'), JSON.stringify(calls));
calls.length = 0;
ctx.document.body.dataset.zimiApps = 'wiki';
ctx.openWiki(true);
ok('offered, /#wiki opens Zimipedia', calls.length === 1 && calls[0][0] === 'open' && calls[0][1] === 'wiki', JSON.stringify(calls));

process.exit(failures ? 1 : 0);
