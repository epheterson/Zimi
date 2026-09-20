// The top bar on a map. Eric, 2026-09-18: "Maps should remove speaker icon
// and either remove or modify random bookmarks history to be for maps.
// Think about that whole top bar." A map has nothing to read aloud, no
// reading mode and no type size; its Random rolls a place on this map; its
// bookmarks already carry the place and now its history does too.
//
// Run: node tests/test_map_topbar.cjs   (exit 0 = pass)

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
function fn(name) { return extract(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n\\}'), name); }

// ── the page knows it is a map ───────────────────────────────────────────
const ctx = {
  zimsCache: [{ name: 'osm-hawaii', kind: 'map', main_path: 'index.html' }, { name: 'wikipedia_en_all', main_path: 'A/Main' }],
  readerOpen: true, _almanacOpen: false, _createOpen: false,
  currentArticle: { zim: 'osm-hawaii', path: 'index.html' },
  escJs: s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
};
vm.createContext(ctx);
vm.runInContext([fn('_isMapZim'), fn('_isMapPage'), fn('_histPosArg')].join('\n'), ctx);
ok('a map open in the reader is a map page', ctx._isMapPage() === true);
ctx.currentArticle = { zim: 'wikipedia_en_all', path: 'A/Main' };
ok('an article is not', ctx._isMapPage() === false);
ctx.currentArticle = { zim: 'osm-hawaii', path: 'index.html' }; ctx._createOpen = true;
ok('nor is a map behind the Create page', ctx._isMapPage() === false);
ctx._createOpen = false;

// ── what the bar hides on a map ──────────────────────────────────────────
const topbar = fn('updateTopbar');
ok('type size and read-aloud follow the reading-text rule', /_readingText = _readingArticle && !_isMapPage\(\)/.test(topbar) &&
  /fontBtn\.style\.display = \(_readingText/.test(topbar) && /ttsBtn\.style\.display = \(_readingText/.test(topbar));
ok('Reader View is never offered on a map', /_readerViewAvailable\(\) && !_createOpen && !_isMapPage\(\)/.test(fn('_syncReaderViewBtn')));
const menu = fn('_buildTopbarMenuHtml');
ok('the ⋯ menu drops Reader View and Read aloud on a map', /rvAvail = _readerViewAvailable\(\) && !_isMapPage\(\)/.test(menu) &&
  /_TTS_AVAILABLE && !_isMapPage\(\)/.test(menu));
ok('Open in browser stays', /_openInBrowser\(\)/.test(menu));
ok('the bookmarks panel and the map switcher stay in the bar', /bmPanelBtn\.style\.display = _readingArticle \?/.test(topbar) &&
  /showMapSrc = _readingArticle && currentArticle && _isMapZim/.test(topbar));

// ── the dice ─────────────────────────────────────────────────────────────
ok('the dice say "Random place" on a map', /t\(_isMapPage\(\) \? 'random_place' : 'random_article'\)/.test(topbar));
const dice = extract(/async function randomArticle\(event\) \{[\s\S]*?\n\}/, 'randomArticle');
ok('on a map the dice stay on this map', /randomScope = _isMapPage\(\) \? currentArticle\.zim : currentSource/.test(dice));
ok('a place opens where it is', /openArticle\(data\.zim, data\.path, data\.title, data\.pos \? \{pos: data\.pos\} : undefined\)/.test(dice));
for (const lang of fs.readdirSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n', lang), 'utf8'));
  if (!d.random_place) ok('random_place in ' + lang, false);
}

// ── history keeps the place ──────────────────────────────────────────────
ok('a visit to a place is recorded with the place', /function _histPushArticle\(zim, path, title, pos\)/.test(src) && /if \(pos\) entry\.pos = _normMapPos\(pos\);/.test(src));
ok('two places on one map are two visits', /h\[i\]\.path === path && \(h\[i\]\.pos \|\| ''\) === _normMapPos\(pos\)/.test(src));
ok('openArticle hands the place to history', /_histPushArticle\(zim, path, title \|\| _fallbackTitle\(zim, path\), opts && opts\.pos\)/.test(src));
ok('a history row reopens the place', ctx._histPosArg({ pos: 'map=14/21.3/-157.8' }) === ",{pos:'map=14/21.3/-157.8'}" && ctx._histPosArg({}) === '');
ok('both history row templates use it', (src.match(/_histPosArg\((item|child)\)/g) || []).length === 2);
ok('a hostile place is escaped for the inline handler', ctx._histPosArg({ pos: "x'y" }) === ",{pos:'x\\'y'}", ctx._histPosArg({ pos: "x'y" }));

// ── a place on the map already open: fly, do not reload ──────────────────
const open = extract(/function openArticle\(zim, path, title, opts\) \{[\s\S]*?\n\}/, 'openArticle');
ok('the fly path needs the same map, a place, and a live map', /opts && opts\.pos && currentArticle && currentArticle\.zim === zim &&\r?\n\s*currentArticle\.path === path && !_isModClick\(\) && _readerMap\(\)/.test(open));
ok('it records the visit, pushes the address, jumps, titles, and stops', /_histPushArticle\(zim, path, flyTitle, opts\.pos\);[\s\S]*history\.pushState\([\s\S]*_restoreMapPosition\(flyPos, 0\);[\s\S]*_setWindowTitle\(document\.title\);\r?\n\s*return;/.test(open));
ok('a map with no title given is called by its name', /if \(!_isMapZim\(zim\)\) return _titleFromPath\(path\);[\s\S]*_mapName\(z\) : _zimTitle\(zim\)/.test(fn('_fallbackTitle')) &&
  /title \|\| _fallbackTitle\(zim, path\), opts && opts\.pos/.test(open) && /readerTitle = title \|\| _fallbackTitle\(zim, path\)/.test(open));
ok('the ⋯ Random row says what it rolls', /tH\(_isMapPage\(\) \? 'random_place' : 'random'\)/.test(menu));

ok('Back to a place restores its title from history', /var was = _histFindPlace\(currentArticle && currentArticle\.zim, location\.hash\.slice\(1\)\)/.test(src) && /h\[i\]\.zim === zim && h\[i\]\.pos === pos\) return h\[i\]/.test(fn('_histFindPlace')));

vm.runInContext([extract(/var _MAP_HASH_RE = [^\n]*\n/, '_MAP_HASH_RE'), fn('mapPositionHash'), fn('parseMapHash'), fn('_normMapPos')].join('\n'), ctx);
ok('a position has one spelling however it arrived', ctx._normMapPos('map=14/21.3/-157.8') === 'map=14.00/21.30000/-157.80000' && ctx._normMapPos('map=14.00/21.30000/-157.80000') === 'map=14.00/21.30000/-157.80000' && ctx._normMapPos('') === '');
ok('history writes and reads that spelling', /entry\.pos = _normMapPos\(pos\)/.test(src) && /pos = _normMapPos\(pos\);\r?\n  var h = _histLoad\(\);/.test(src));

process.exit(failures ? 1 : 0);
