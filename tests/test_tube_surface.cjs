// Zimi Tube, the surface: a tile first among the sources whenever a video
// ZIM is installed; /#tube opens the page Zimi owns in the reader; the top
// bar's box drives the page's search; a card opening a video becomes a real
// page with history. Eric, 2026-09-19: "Bubble up my TED YouTubes and maybe
// some others whose structures we know."
//
// Run: node tests/test_tube_surface.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const page = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'tube.html'), 'utf8');
const shared = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'apps.js'), 'utf8');
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
const escf = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ctx = {
  zimsCache: [
    { name: 'ted_en_technology', title: 'TED Talks – Technology', kind: 'video', main_path: 'index' },
    { name: 'osm-hawaii', title: 'Hawaii', kind: 'map', main_path: 'index.html' },
    { name: 'wikipedia_en_all', title: 'Wikipedia', main_path: 'A/Main' },
  ],
  esc: escf, t: k => ({ tube: 'ZimiTube', cat_maps: 'Maps', app_empty_maps: 'No map yet.', app_empty_tube: 'No videos yet.', app_empty_exchange: 'No Q&A site yet.', exchange: 'ZimiExchange', reddot: 'Reddot', app_empty_reddot: 'No subreddits yet.', apps_section: 'Apps' })[k] || k, tH: k => k === 'apps_section' ? 'Apps' : k, _getLibraryView: () => 'list',
  _userSession: null, document: { body: { dataset: {} } },
};
vm.createContext(ctx);
vm.runInContext([
  extract(/var _MAPS_PIN_SVG = [^\n]*\n/, '_MAPS_PIN_SVG'), extract(/var _TUBE_PLAY_SVG = [^\n]*\n/, '_TUBE_PLAY_SVG'),
  extract(/function _newestPer\(list, key\) \{[\s\S]*?\n\}/, '_newestPer'),
  extract(/function _installedOfKind\(kind, key\) \{[\s\S]*?\n\}/, '_installedOfKind'),
  extract(/function _mapName\(z\) \{[\s\S]*?\n\}/, '_mapName'),
  extract(/function _mapSourceLabel\(z\) \{[\s\S]*?\n\}/, '_mapSourceLabel'),
  extract(/function _installedMaps\(\) \{[\s\S]*?\n\}/, '_installedMaps'),
  extract(/function _installedVideoZims\(\) \{[\s\S]*?\n\}/, '_installedVideoZims'),
  extract(/var _userPrefs = [^\n]*\n/, '_userPrefs'),
  extract(/function _appsAllowedByServer\(\) \{[\s\S]*?\n\}/, '_appsAllowedByServer'),
  extract(/function _appsEnabled\(\) \{[\s\S]*?\n\}/, '_appsEnabled'),
  extract(/var _APP_CATEGORY = [^\n]*\n/, '_APP_CATEGORY'),
  extract(/function _appTileHtml\(app, title, icon, names, openFn\) \{[\s\S]*?\n\}/, '_appTileHtml'),
  extract(/function _mapsTileHtml\(\) \{[\s\S]*?\n\}/, '_mapsTileHtml'),
  extract(/var _EXCHANGE_SVG = [^\n]*\n/, '_EXCHANGE_SVG'),
  extract(/function _installedQaZims\(\) \{[\s\S]*?\n\}/, '_installedQaZims'),
  extract(/function _exchangeTileHtml\(\) \{[\s\S]*?\n\}/, '_exchangeTileHtml'),
  extract(/var _REDDOT_SVG = [^\n]*\n/, '_REDDOT_SVG'),
  extract(/var _createRememberMode = [^\n]*\n/, '_createRememberMode'),
  extract(/function _installedRedditZims\(\) \{[\s\S]*?\n\}/, '_installedRedditZims'),
  extract(/function _reddotTileHtml\(\) \{[\s\S]*?\n\}/, '_reddotTileHtml'),
  extract(/function _tubeTileHtml\(\) \{[\s\S]*?\n\}/, '_tubeTileHtml'),
  extract(/function _appsRowHtml\(\) \{[\s\S]*?\n\}/, '_appsRowHtml'),
].join('\n'), ctx);

// ── the apps row ─────────────────────────────────────────────────────────
const row = ctx._appsRowHtml();
ok('one row holds the apps, each a tile like a source', /class="stats-grid apps-grid">/.test(row) && /maps-tile/.test(row) && /tube-tile/.test(row));
ok('the ZimiTube tile names the video ZIMs', /<span class="zt">ZimiTube<\/span>/.test(row) && /TED Talks – Technology/.test(row) && /href="#tube"/.test(row));
ctx.zimsCache = ctx.zimsCache.filter(z => z.kind !== 'video');
ok('no video ZIM: the tile stays, empty, and opens the Video category', /app-empty tube-tile/.test(ctx._appsRowHtml()) && /No videos yet/.test(ctx._appsRowHtml()) && /_openCategory\(_APP_CATEGORY\.tube\)/.test(ctx._appsRowHtml()));
ctx.zimsCache = [];
ok('a fresh install still has the apps row, every tile a door', (ctx._appsRowHtml().match(/app-empty/g) || []).length === 4);
ok('the row can be turned off for everyone (the server stamps the shell) or for a signed-in person (their account), never per browser', /dataset\.zimiApps === '0'/.test(src) && /_appsAllowedByServer\(\) && \(!_userSession \|\| _userPrefs\.apps !== false\)/.test(src) && /if \(!_appsEnabled\(\)\) return '';/.test(src) && /fetch\('\/me\/prefs'/.test(src) && !/zimi_hide_apps/.test(src));
ok('the server switch sits in Server settings and reads its state from the server', /_msFetch\('\/manage\/apps'\)/.test(src) && /_setAppsForServer\(this\.checked\)/.test(src));
ctx.document.body.dataset.zimiApps = '0';
ok('the server can turn the row off for everyone', ctx._appsRowHtml() === '');
delete ctx.document.body.dataset.zimiApps; ctx._userSession = { name: 'eric' }; ctx._userPrefs.apps = false;
ok('a signed-in person can turn it off for their account', ctx._appsRowHtml() === '');
ctx._userPrefs.apps = true;
ok('and back on', ctx._appsRowHtml() !== '');
ctx._userSession = null;
ok('the categories behind the doors', /_APP_CATEGORY = \{ maps: 'maps', tube: 'ted', exchange: 'stack_exchange' \}/.test(src));
ok('the home page draws the row before favorites', /h \+= _appsRowHtml\(\);/.test(src));

// ── opening it ───────────────────────────────────────────────────────────
const open = extract(/function openTube\(replaceState, play\) \{[\s\S]*?\n\}/, 'openTube');
ok('ZimiTube is the page Zimi owns, in the reader, with its own history entry', /openReader\(_TUBE_PAGE \+ '#' \+ _tubeStrings\(play\)\)/.test(open) && /history\.pushState\(st, '', _tubeUrl\(play\)\)/.test(open) && /_tubeOpen = true;/.test(open));
ok('a playing video has an address: /#tube?play=<zim>/<page>, replaced, never pushed', /d\.zimi === 'tube-play' && _tubeOpen[\s\S]*history\.replaceState\(\{ mode: 'reader', tube: true, play: d\.play \}, '', _tubeUrl\(d\.play\)\)/.test(src) && /tell\(\{ zimi: 'tube-play', play: v\.zim \+ '\/' \+ v\.page, title: v\.title \}\)/.test(page));
ok('opened at that address, the page plays it', /if \(STR\.play\) \{ var want = STR\.play;/.test(page) && /tubeQ\.get\('play'\)/.test(src));
ok('messages from the page are checked for origin and shape', /e\.origin !== location\.origin/.test(src) && /_APP_CATEGORY_KEYS\.indexOf\(d\.category\) >= 0/.test(src));
ok('the empty page is a door to the catalog', /goCatalog\(\)/.test(page) && /category: 'ted'/.test(page));
ok('the page is a static asset the server versions', /var _TUBE_PAGE = '\/static\/tube\.html\?v=1';/.test(src));
ok('/#tube on a cold load opens it, with the address\'s video', /location\.hash === '#tube' \|\| location\.hash\.indexOf\('#tube\?'\) === 0/.test(src));
ok('Back and Forward return to it, video included', /s\.mode === 'reader' && s\.tube\) \{\n\s*openTube\(true, s\.play \|\| ''\);/.test(src));

// ── the box and the chrome ───────────────────────────────────────────────
ok('typing on Tube filters the feed inside the page', /if \(_isTubePage\(\)\) \{\n\s*\/\/ Tube[^\n]*\n\s*hideSuggest\(\);\n\s*suggestTimer = setTimeout\(function\(\) \{ _tubeSearch\(val\); \}, 150\);/.test(src));
ok('the hand-off calls the page\'s own function', /win\.tubeSearch\(val\)/.test(extract(/function _tubeSearch\(val\) \{[\s\S]*?\n\}/, '_tubeSearch')));
ok('no reading controls on Tube, in the bar or the ⋯', /_readingText = _readingArticle && !_isMapPage\(\) && !_isTubePage\(\)/.test(src) && /_TTS_AVAILABLE && !_isMapPage\(\) && !_isTubePage\(\)/.test(src));
ok('the breadcrumb is ZimiTube and the box says what it is for', /bcIcon\.title = t\('tube'\)/.test(src) && /return t\('tube_search_placeholder'\)/.test(src) && (src.match(/q\.placeholder = _appPlaceholder\(\)/g) || []).length === 2);

// ── a card becomes a page ────────────────────────────────────────────────
ok('a ZIM page opened from an app gets history and an address, and the app closes', /if \(_tubeOpen \|\| _exchangeOpen \|\| _reddotOpen\) \{[\s\S]*?_tubeOpen = false;[\s\S]*?_exchangeOpen = false;[\s\S]*?_reddotOpen = false;[\s\S]*?history\.pushState\(\{ mode: 'reader', zim: _navZim, path: _navPath \}, '', _articleDeepLinkPath\(_navZim, _navPath\)\);/.test(src));
ok('closing the reader or opening any article leaves Tube', /function closeReader\(\) \{\n\s*if \(!readerOpen\) return;\n\s*_tubeOpen = false;/.test(src) && /function openArticle\(zim, path, title, opts\) \{\n\s*_tubeOpen = false;/.test(src));

// ── the page ─────────────────────────────────────────────────────────────
ok('the page asks /tube once and pages what it shows', /fetch\(url\)/.test(page) && /'\/tube\?limit=5000&offset=0'/.test(page) && /function tubeMore\(\)/.test(page));
ok('a card is a real link to the page, and a click plays in ZimiTube\'s own player', /href="' \+ esc\(zpath\(v\.zim, v\.page\)\) \+ '"/.test(page) && /onclick="return play\(event, ' \+ i \+ '\)"/.test(page));
ok('the player reads the media behind the page and rolls into the next', /fetch\('\/tube\/play\?zim='/.test(page) && /addEventListener\('ended'[\s\S]*play\(null, i \+ 1\)/.test(page) && /STR\.up_next/.test(page));
ok('shelves per source, chips, sorts, ZIM icons', /class="shelf"/.test(page) && /class="chip/.test(page) && /sort_longest/.test(page) && /zimIcon\(v\.zim, cls\)/.test(page));
ok('browsing is the shelves alone; the grid is for a chip, a query or another order', /shelves\.hidden = !browsing;/.test(page) && /list\.hidden = browsing;/.test(page) && !/<select/.test(page));
ok('the default order is called Top', /_sort = 'top'/.test(page) && /sort_top/.test(page) && !/sort_mixed/.test(page));
ok('the original page stays one tap away', /STR\.open_page/.test(page));
ok('the page exposes its search to the top bar', /window\.tubeSearch = tubeSearch/.test(page));
ok('strings arrive in the hash, escaped on the way in', /<!--@apps\.js@-->/.test(page) && /JSON\.parse\(decodeURIComponent\(location\.hash\.slice\(1\)/.test(shared) && /function esc\(x\)/.test(shared));
ok('the page takes the shared sheet, which holds both themes', /<!--@apps\.css@-->/.test(page) && !/prefers-color-scheme/.test(page));
for (const lang of fs.readdirSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n', lang), 'utf8'));
  for (const k of ['tube', 'tube_search_placeholder', 'tube_videos', 'tube_sources', 'tube_more', 'tube_none', 'tube_empty', 'tube_up_next', 'tube_autoplay', 'tube_open_page', 'tube_sort_top', 'tube_no_media']) if (!d[k]) ok(k + ' in ' + lang, false);
  if (d.tube !== 'ZimiTube') ok('it is called ZimiTube in ' + lang, false);
}

process.exit(failures ? 1 : 0);
