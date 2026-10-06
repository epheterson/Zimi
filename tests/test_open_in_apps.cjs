// A search result opens in the app made for its kind, by default (Eric,
// 2026-09-29, from his iPhone review of 1.12: a wiki's article in
// Zimipedia's reader, a book in Bookshelf's, a video in ZimiTube, a
// question in ZimiExchange, a post in Reddot). One routing function keyed by
// the ZIM's kind, each app's own way in, and one setting to turn it off
// (Settings > Reading, "Open articles in apps", kept with the account's
// preferences). The browser half is tests/test_wiki_reader.py.
//
// Run: node tests/test_open_in_apps.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
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

const store = {};
const calls = [];
const zims = {
  wikipedia: { name: 'wikipedia', kind: 'wiki', main_path: 'Main_Page' },
  gutenberg: { name: 'gutenberg', kind: 'books', main_path: 'Home' },
  ted: { name: 'ted', kind: 'video', main_path: 'index' },
  cooking: { name: 'cooking', kind: 'qa', main_path: 'questions' },
  askreddit: { name: 'askreddit', kind: 'reddit', main_path: 'index' },
  maps: { name: 'maps', kind: 'map', main_path: 'index.html' },
  plain: { name: 'plain', kind: '', main_path: 'A/Water' },
};
const shown = { wiki: true, books: true, tube: true, exchange: true, reddot: true, maps: true };
const ctx = {
  SK: { OPEN_IN_APPS: 'zimi_open_in_apps' },
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  },
  _zimInfo: n => zims[n] || null,
  _appShown: a => !!shown[a],
  openArticle: (z, p, t) => calls.push(['article', z, p, ctx._wikiFromApp]),
  openTube: (r, id) => calls.push(['tube', id]),
  openExchange: (r, id) => calls.push(['exchange', id]),
  openReddot: (r, id) => calls.push(['reddot', id]),
  _wikiFromApp: false,
};
vm.createContext(ctx);
vm.runInContext([
  extract(/function _openAppItem\(app, zim, path\) \{[\s\S]*?\n\}/, '_openAppItem'),
  extract(/var _RESULT_APP = [^\n]*\n/, '_RESULT_APP'),
  extract(/var _APP_ITEM_PATH = [^\n]*\n/, '_APP_ITEM_PATH'),
  extract(/function _openInApps\(\) \{[^\n]*\n/, '_openInApps'),
  extract(/function _setOpenInApps\(on\) \{[^\n]*\n/, '_setOpenInApps'),
  extract(/function _resultApp\(zim, path\) \{[\s\S]*?\n\}/, '_resultApp'),
  extract(/function _bookOfCover\(path\) \{[^\n]*\n/, '_bookOfCover'),
  extract(/function _openResult\(zim, path, title\) \{[\s\S]*?\n\}/, '_openResult'),
].join('\n'), ctx);

function open(zim, p) {
  calls.length = 0; ctx._wikiFromApp = false;
  ctx._openResult(zim, p, 'T');
  return JSON.stringify(calls[0]);
}

ok('on by default', ctx._openInApps() === true);
ok('a wiki\'s article opens in Zimipedia\'s reader', open('wikipedia', 'Albert_Einstein') === '["article","wikipedia","Albert_Einstein",true]');
ok('a book opens in Bookshelf\'s reader, its cover page as the book', open('gutenberg', 'Moby_Dick_cover.2701') === '["article","gutenberg","Moby_Dick.2701",false]' &&
  open('gutenberg', 'Moby_Dick.2701') === '["article","gutenberg","Moby_Dick.2701",false]');
ok('a video opens in ZimiTube', open('ted', 'talks/one') === '["tube","ted/talks/one"]');
ok('a question opens in ZimiExchange', open('cooking', 'questions/567/how-to-chop') === '["exchange","cooking/questions/567/how-to-chop"]');
ok('a post opens in Reddot', open('askreddit', 'r/AskReddit/abc123/title') === '["reddot","askreddit/r/AskReddit/abc123/title"]');
ok('a page of a Q&A site that is not a question (a tag list) is the ZIM\'s own', open('cooking', 'questions/tagged/onions') === '["article","cooking","questions/tagged/onions",false]');
ok('a subreddit\'s own pages are the ZIM\'s', open('askreddit', 'about') === '["article","askreddit","about",false]');
ok('a ZIM\'s front page is the ZIM\'s own', open('wikipedia', 'Main_Page') === '["article","wikipedia","Main_Page",false]' && open('ted', 'index') === '["article","ted","index",false]');
ok('a ZIM no app reads, and a map (already in Maps\' viewer), open as they did', open('plain', 'A/Water') === '["article","plain","A/Water",false]' && open('maps', 'index.html') === '["article","maps","index.html",false]');
shown.tube = false;
ok('an app not shown here leaves its ZIM\'s pages to the reader', open('ted', 'talks/one') === '["article","ted","talks/one",false]');
shown.tube = true;
ctx._setOpenInApps(false);
ok('off: kept for this person, and every result is the ZIM\'s own page', store.zimi_open_in_apps === '0' &&
  open('wikipedia', 'Albert_Einstein') === '["article","wikipedia","Albert_Einstein",false]' && open('ted', 'talks/one') === '["article","ted","talks/one",false]');
ctx._setOpenInApps(true);
ok('on again: the default, nothing stored', !('zimi_open_in_apps' in store) && ctx._openInApps());

// ── wiring ──
ok('search results and Discover cards take the route', /function _spaCardClick\(e, el\) \{\s*return _spaNav\(e, function \(\) \{\s*_openResult\(/.test(src));
ok('a suggestion takes it too (a place keeps its own way to the map)', /if \(s\.pos\) openArticle\(s\.zim, s\.path, s\.title, \{pos: s\.pos\}\); else _openResult\(s\.zim, s\.path, s\.title\);/.test(src));
ok('Settings > Apps has the switch, under the apps', /id: 'ms-open-in-apps', title: tH\('open_in_apps'\), desc: tH\('open_in_apps_hint'\)/.test(src));
ok('kept with the account\'s preferences (and in a backup)', /SK\.EXT_LINKS, SK\.OPEN_IN_APPS,\n\];/.test(src));
for (const lang of fs.readdirSync(path.join(root, 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(root, 'i18n', lang), 'utf8'));
  for (const k of ['open_in_apps', 'open_in_apps_hint']) {
    if (!d[k]) ok(k + ' in ' + lang, false);
    else if (/—/.test(d[k])) ok('no em dash in ' + k + ' (' + lang + ')', false);
  }
}
// Eric, 2026-10-05: with every app off, the switch is shown off and locked.
{
  const sb = { APP_SHOWN: {}, localStorage: { getItem: () => null }, SK: { OPEN_IN_APPS: 'x' } };
  sb._appShown = (a) => !!sb.APP_SHOWN[a];
  vm.createContext(sb);
  vm.runInContext(src.match(/var _OPEN_IN_APP_APPS = [^\n]*\n/)[0] + src.match(/function _openInAppsPossible\(\) \{[^\n]*\}\n/)[0], sb);
  ok('no app that opens a result: nothing to open in', vm.runInContext('_openInAppsPossible()', sb) === false);
  sb.APP_SHOWN.dictionary = true;
  ok('one such app on: it can open there', vm.runInContext('_openInAppsPossible()', sb) === true);
  ok('the row is drawn off and locked when none is', /on: _openInApps\(\) && _openInAppsPossible\(\), disabled: !_openInAppsPossible\(\)/.test(src));
  ok('an app turned on or off redraws the row', (src.match(/_syncOpenInAppsRow\(\);/g) || []).length >= 2);
}
process.exit(failures ? 1 : 0);
