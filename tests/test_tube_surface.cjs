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
  extract(/var _MAPS_SVG = [^\n]*\n/, '_MAPS_SVG'), extract(/var _TUBE_PLAY_SVG = [^\n]*\n/, '_TUBE_PLAY_SVG'),
  extract(/function _newestPer\(list, key\) \{[\s\S]*?\n\}/, '_newestPer'),
  extract(/function _installedOfKind\(kind, key\) \{[\s\S]*?\n\}/, '_installedOfKind'),
  extract(/function _mapName\(z\) \{[\s\S]*?\n\}/, '_mapName'),
  extract(/function _mapSourceLabel\(z\) \{[\s\S]*?\n\}/, '_mapSourceLabel'),
  extract(/function _installedMaps\(\) \{[\s\S]*?\n\}/, '_installedMaps'),
  extract(/function _installedVideoZims\(\) \{[\s\S]*?\n\}/, '_installedVideoZims'),
  extract(/var APP_NAMES = [^\n]*\n/, 'APP_NAMES'),
  extract(/var _userPrefs = [^\n]*\n/, '_userPrefs'),
  extract(/function _appsAllowedByServer\(app\) \{[\s\S]*?\n\}/, '_appsAllowedByServer'),
  extract(/function _appShown\(app\) \{[\s\S]*?\n\}/, '_appShown'),
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
ok('the row can be turned off for everyone (the server stamps the shell) or for a signed-in person (their account), never per browser', /dataset\.zimiApps/.test(src) && /function _appShown\(app\)/.test(src) && /APP_NAMES\.some\(_appShown\)/.test(src) && /if \(!_appsEnabled\(\)\) return '';/.test(src) && /fetch\('\/me\/prefs'/.test(src) && !/zimi_hide_apps/.test(src));
ok('the server switch sits in Server settings, one checkbox per app, and reads its state from the server', /_msFetch\('\/manage\/apps'\)/.test(src) && /_setAppForServer\(app, on\)/.test(src) && /body: JSON\.stringify\(\{ shown: shown \}\)/.test(src));
ctx.document.body.dataset.zimiApps = '0';
ok('the server can turn the row off for everyone', ctx._appsRowHtml() === '');
ctx.document.body.dataset.zimiApps = 'maps,reddot';
ok('or offer only some apps: the row carries just those', (ctx._appsRowHtml().match(/app-empty/g) || []).length === 2 && /maps-tile/.test(ctx._appsRowHtml()) && /reddot-tile/.test(ctx._appsRowHtml()) && !/tube-tile/.test(ctx._appsRowHtml()));
delete ctx.document.body.dataset.zimiApps; ctx._userSession = { name: 'eric' }; ctx._userPrefs.apps = false;
ok('a signed-in person can turn it off for their account', ctx._appsRowHtml() === '');
ctx._userPrefs.apps = true; ctx._userPrefs.shown = ['tube'];
ok('or keep only some apps', (ctx._appsRowHtml().match(/app-empty/g) || []).length === 1 && /tube-tile/.test(ctx._appsRowHtml()));
ctx.document.body.dataset.zimiApps = 'maps';
ok('an account keeps only what the server offers', ctx._appsRowHtml() === '');
delete ctx.document.body.dataset.zimiApps; ctx._userPrefs.shown = null;
ok('and back on', ctx._appsRowHtml() !== '');
ctx._userSession = null;
ok('the categories behind the doors', /_APP_CATEGORY = \{ maps: 'maps', tube: 'ted', exchange: 'stack_exchange' \}/.test(src));
ok('the home page draws the row before favorites', /h \+= _appsRowHtml\(\);/.test(src));

// ── opening it ───────────────────────────────────────────────────────────
const open = extract(/function openTube\(replaceState, play\) \{[\s\S]*?\n\}/, 'openTube');
ok('ZimiTube is the page Zimi owns, in the reader, with its own history entry', /openReader\(_TUBE_PAGE \+ '#' \+ _tubeStrings\(play\)\)/.test(open) && /history\.pushState\(st, '', _tubeUrl\(play\)\)/.test(open) && /_tubeOpen = true;/.test(open));
ok('a playing video has an address (/?tube=<zim>/<page>): a step from the shelves, the same step from one video to the next', /d\.zimi === 'tube-play' && _tubeOpen[\s\S]*_appStep\(\{ mode: 'reader', tube: true, play: d\.play \}, _tubeUrl\(d\.play\), 'play'\)/.test(src) && /tell\(\{ zimi: 'tube-play', play: v\.zim \+ '\/' \+ v\.page, title: v\.title \}\)/.test(page) && /return play \? '\/\?tube=' \+ encodeURIComponent\(play\) : '\/#tube';/.test(src));
ok('opened at that address, the page plays it', /if \(STR\.play\) \{ var want = STR\.play;/.test(page) && /tubeQ\.get\('play'\)/.test(src));
ok('messages from the page are checked for origin and shape', /e\.origin !== location\.origin/.test(src) && /_APP_CATEGORY_KEYS\.indexOf\(d\.category\) >= 0/.test(src));
ok('the empty page is a door to the catalog', /goCatalog\(\)/.test(page) && /category: 'ted'/.test(page));
ok('the page is a static asset the server versions', /var _TUBE_PAGE = '\/static\/tube\.html\?v=1';/.test(src));
ok('/#tube on a cold load opens it, with the address\'s video', /location\.hash === '#tube' \|\| location\.hash\.indexOf\('#tube\?'\) === 0/.test(src));
ok('Back and Forward steer the open page, video included, and reload it only when it is gone', /s\.mode === 'reader' && s\.tube\) \{\n\s*if \(!_appFrameRoute\(_tubeOpen, s\.play\)\) openTube\(true, s\.play \|\| ''\);/.test(src) && /window\.__route = function\(id\)/.test(page) && !/class="back"/.test(page) && !/l-back|backlabel/.test(page));
ok('the page says when it is at its top (the shelves, or the one-source list with nothing chosen), and the shell reads it', /window\.__top = function\(\) \{ return _now < 0 && !_q && !_zim; \};/.test(page) && /function tellTop\(\)/.test(shared) && /attributeFilter: \['hidden'\]/.test(shared) && /d\.zimi === 'top'[\s\S]*?_appTop = d\.top !== false;/.test(src));
ok('the dice stay in the app: the shell asks the page, ZimiTube plays a video from the whole feed', /if \(_isAppPage\(\)\) \{[\s\S]*?postMessage\(\{ zimi: 'random' \}/.test(src) && /e\.data\.zimi === 'random'[\s\S]*?window\.__random\(\)/.test(shared) && /window\.__random = function\(\) \{[\s\S]*?_all\[Math\.floor\(Math\.random\(\) \* _all\.length\)\]/.test(page));
ok('a menu with nothing in it is no menu: the ⋯ button goes when the open page folds no rows', /readerOpen && !_buildTopbarMenuHtml\(\) \? 'none' : ''/.test(src));
ok('the "cannot be played" line links the page by its path (a bare `page` was once referenced there and threw)', !/esc\(page\)/.test(page) && /noMedia = function\(missing\)[^\n]*esc\(zpath\(v\.zim, v\.page\)\)/.test(page));
ok("the two truths of a video that will not play: not in the ZIM, or not decodable here", /m\.missing\) \{ noMedia\(!!\(m && m\.missing\)\); return; \}/.test(page) && /missing \? STR\.missing : STR\.no_media/.test(page) && /'tube_missing'\]/.test(src) && /function _videoFileMissing\(v\)/.test(src) && /t\('video_not_playable'\)/.test(src));
const css = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.css'), 'utf8');
ok("the header's arrow shows on every app page: a video is a history step back, a list asks the page, the home leaves the app", /homeScope \|\| \(_isAppPage\(\) && !_appTop\);/.test(src) && /if \(_isAppPage\(\)\) \{[\s\S]*?if \(st && \(st\.play \|\| st\.q \|\| st\.p\)\) \{ if \(st\.entry\) _appEntryHome\(\); else history\.back\(\); return; \}[\s\S]*?postMessage\(\{ zimi: 'back-request' \}/.test(src) && /d\.zimi === 'at-home'[\s\S]*?if \(_isAppPage\(\)\) closeReader\(\);/.test(src) && /e\.data\.zimi === 'back-request'[\s\S]*?window\.__back\(\)[\s\S]*?tell\(\{ zimi: 'at-home' \}\)/.test(shared) && /window\.__back = function\(\) \{\s*if \(_now >= 0\) \{ closePlayer\(\); return true; \}/.test(page));
ok('a video, a question, a post is bookmarked and remembered as the app\'s, and opens back into it', /function _appItemOpened\(app, id, title\)/.test(src) && /_histPushArticle\(zim, path, title, null, app\)/.test(src) && /if \(app\) record\.app = app;/.test(src) && /_openAppItem\(row\.dataset\.app, row\.dataset\.zim, row\.dataset\.path\)/.test(src) && /var cur = currentArticle \|\| _appItem;/.test(src));
ok('the reader\'s bookmark buttons are for articles, not app pages', /body\.app-page #bm-panel-btn, body\.app-page\.app-noitem #library-btn, body\.map-page #bm-panel-btn, body\.map-page #library-btn \{ display: none !important; \}/.test(css));
ok('"Open the original page" is a step: the shell opens the article with the app behind it, and the arrow (or Back) returns to the video', /function openLink\(a, zim, page, label\)/.test(shared) && /tell\(\{ zimi: 'open', zim: zim, path: page \}\)/.test(shared) && /openLink\(document\.getElementById\('w-open'\), v\.zim, v\.page, STR\.open_page\)/.test(page) && /d\.zimi === 'open'[\s\S]*?openArticle\(d\.zim, d\.path\);\n\s*if \(fromApp\) \{ articleHistory\.push\(\{ app: true \}\); updateTopbar\(\); \}/.test(src) && /if \(prev\.app\) \{ history\.back\(\); return; \}/.test(src) && /if \(replaceState && play\) st\.entry = true;/.test(src) && /if \(st\.entry\) _appEntryHome\(\); else history\.back\(\);/.test(src) && /var toApp = app && app\.mode === 'reader' && \(app\.tube \|\| app\.exchange \|\| app\.reddot\);/.test(src) && /if \(readerOpen && articleHistory\.length > 0 && !toApp\) \{/.test(src));
ok('Theater and Picture in picture sit on the stage; PIP only where a native video plays', /function stageTools\(stage, pip\)/.test(page) && /\.stage-tools \{ position: absolute; top: 8px; inset-inline-end: 8px;/.test(page) && /stageTools\(stage, pipAvailable\(vid\)\);/.test(page) && /stageTools\(stage, false\);\s*ogvControls\(stage, p\);\s*p\.play\(\);/.test(page) && !/<button id="theater"/.test(page) && !/<button id="pip"/.test(page));
ok('an iPhone gets the decoder first for a WebM-only talk: it says it can play WebM and then cannot', /var apple = \/iPhone\|iPad\|iPod\/\.test\(ua\)[^\n]*Safari/.test(page) && /webmOnly = m\.media\.every/.test(page) && /if \(\(!playable \|\| \(apple && webmOnly\)\) && m\.ogv\) \{ playWithOgv\(v, m, stage, i\); return; \}/.test(page));

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
ok('leaving the player with a video playing docks it, and a tap brings it back', /function closePlayer\(silent\)/.test(page) && /dock-stage'\)\.appendChild\(v\)/.test(page) && /function undock\(\)/.test(page) && /function stopDock\(\)/.test(page) && /id="dock" hidden onclick="undock\(\)"/.test(page));
ok('theater mode is remembered and picture in picture appears only where the browser has it', /zimitube_theater/.test(page) && /player\.theater/.test(page) && /function pipAvailable\(v\)/.test(page) && /webkitSetPresentationMode/.test(page) && /requestPictureInPicture/.test(page));
ok('the page takes the shared sheet, which holds both themes', /<!--@apps\.css@-->/.test(page) && !/prefers-color-scheme/.test(page));
for (const lang of fs.readdirSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n', lang), 'utf8'));
  for (const k of ['tube', 'tube_search_placeholder', 'tube_videos', 'tube_sources', 'tube_more', 'tube_none', 'tube_empty', 'tube_up_next', 'tube_autoplay', 'tube_theater', 'tube_pip', 'tube_open_page', 'tube_sort_top', 'tube_no_media']) if (!d[k]) ok(k + ' in ' + lang, false);
  if (d.tube !== 'ZimiTube') ok('it is called ZimiTube in ' + lang, false);
}

process.exit(failures ? 1 : 0);
