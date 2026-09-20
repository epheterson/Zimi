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
  esc: escf, t: k => ({ tube: 'ZimiTube', cat_maps: 'Maps' })[k] || k, _getLibraryView: () => 'list',
};
vm.createContext(ctx);
vm.runInContext([
  extract(/var _MAPS_PIN_SVG = [^\n]*\n/, '_MAPS_PIN_SVG'), extract(/var _TUBE_PLAY_SVG = [^\n]*\n/, '_TUBE_PLAY_SVG'),
  extract(/function _installedMaps\(\) \{[\s\S]*?\n\}/, '_installedMaps'),
  extract(/function _installedVideoZims\(\) \{[\s\S]*?\n\}/, '_installedVideoZims'),
  extract(/function _mapsTileHtml\(\) \{[\s\S]*?\n\}/, '_mapsTileHtml'),
  extract(/function _tubeTileHtml\(\) \{[\s\S]*?\n\}/, '_tubeTileHtml'),
  extract(/function _appsRowHtml\(\) \{[\s\S]*?\n\}/, '_appsRowHtml'),
].join('\n'), ctx);

// ── the apps row ─────────────────────────────────────────────────────────
const row = ctx._appsRowHtml();
ok('one row holds the apps, each a tile like a source', /class="stats-grid apps-grid">/.test(row) && /maps-tile/.test(row) && /tube-tile/.test(row));
ok('the ZimiTube tile names the video ZIMs', /<span class="zt">ZimiTube<\/span>/.test(row) && /TED Talks – Technology/.test(row) && /href="#tube"/.test(row));
ctx.zimsCache = ctx.zimsCache.filter(z => z.kind !== 'video');
ok('no video ZIM, no Tube tile; Maps stays', !/tube-tile/.test(ctx._appsRowHtml()) && /maps-tile/.test(ctx._appsRowHtml()));
ctx.zimsCache = [];
ok('nothing installed, no row', ctx._appsRowHtml() === '');
ok('the home page draws the row before favorites', /h \+= _appsRowHtml\(\);/.test(src));

// ── opening it ───────────────────────────────────────────────────────────
const open = extract(/function openTube\(replaceState\) \{[\s\S]*?\n\}/, 'openTube');
ok('Tube is the page Zimi owns, in the reader, with its own history entry', /openReader\(_TUBE_PAGE \+ '#' \+ _tubeStrings\(\)\)/.test(open) && /history\.pushState\(st, '', '\/#tube'\)/.test(open) && /_tubeOpen = true;/.test(open));
ok('the page is a static asset the server versions', /var _TUBE_PAGE = '\/static\/tube\.html\?v=1';/.test(src));
ok('/#tube on a cold load opens it', /location\.hash === '#tube'[\s\S]*openTube\(true\);/.test(src));
ok('Back and Forward return to it', /s\.mode === 'reader' && s\.tube\) \{\n\s*openTube\(true\);/.test(src));

// ── the box and the chrome ───────────────────────────────────────────────
ok('typing on Tube filters the feed inside the page', /if \(_isTubePage\(\)\) \{\n\s*\/\/ Tube[^\n]*\n\s*hideSuggest\(\);\n\s*suggestTimer = setTimeout\(function\(\) \{ _tubeSearch\(val\); \}, 150\);/.test(src));
ok('the hand-off calls the page\'s own function', /win\.tubeSearch\(val\)/.test(extract(/function _tubeSearch\(val\) \{[\s\S]*?\n\}/, '_tubeSearch')));
ok('no reading controls on Tube, in the bar or the ⋯', /_readingText = _readingArticle && !_isMapPage\(\) && !_isTubePage\(\)/.test(src) && /_TTS_AVAILABLE && !_isMapPage\(\) && !_isTubePage\(\)/.test(src));
ok('the breadcrumb is ZimiTube and the box says what it is for', /bcIcon\.title = t\('tube'\)/.test(src) && (src.match(/q\.placeholder = t\('tube_search_placeholder'\)/g) || []).length === 2);

// ── a card becomes a page ────────────────────────────────────────────────
ok('a video opened from a card gets history and an address, and Tube closes', /if \(_tubeOpen\) \{[\s\S]*?_tubeOpen = false;[\s\S]*?history\.pushState\(\{ mode: 'reader', zim: _navZim, path: _navPath \}, '', _articleDeepLinkPath\(_navZim, _navPath\)\);/.test(src));
ok('closing the reader or opening any article leaves Tube', /function closeReader\(\) \{\n\s*if \(!readerOpen\) return;\n\s*_tubeOpen = false;/.test(src) && /function openArticle\(zim, path, title, opts\) \{\n\s*_tubeOpen = false;/.test(src));

// ── the page ─────────────────────────────────────────────────────────────
ok('the page asks /tube once and pages what it shows', /fetch\(url\)/.test(page) && /'\/tube\?limit=5000&offset=0'/.test(page) && /function tubeMore\(\)/.test(page));
ok('a card is a real link to the page, and a click plays in ZimiTube\'s own player', /href="' \+ esc\(zpath\(v\.zim, v\.page\)\) \+ '"/.test(page) && /onclick="return play\(event, ' \+ i \+ '\)"/.test(page));
ok('the player reads the media behind the page and rolls into the next', /fetch\('\/tube\/play\?zim='/.test(page) && /addEventListener\('ended'[\s\S]*play\(null, i \+ 1\)/.test(page) && /STR\.up_next/.test(page));
ok('shelves per source, chips, sorts, ZIM icons', /class="shelf"/.test(page) && /class="chip/.test(page) && /sort_longest/.test(page) && /zpath\(v\.zim, '-\/icon'\)/.test(page));
ok('the original page stays one tap away', /STR\.open_page/.test(page));
ok('the page exposes its search to the top bar', /window\.tubeSearch = tubeSearch/.test(page));
ok('strings arrive in the hash, escaped on the way in', /JSON\.parse\(decodeURIComponent\(location\.hash\.slice\(1\)/.test(page) && /function esc\(x\)/.test(page));
ok('the page holds in both themes', /prefers-color-scheme: dark/.test(page) && /color-scheme: light dark/.test(page));
for (const lang of fs.readdirSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n', lang), 'utf8'));
  for (const k of ['tube', 'tube_search_placeholder', 'tube_videos', 'tube_sources', 'tube_more', 'tube_none', 'tube_empty', 'tube_up_next', 'tube_autoplay', 'tube_open_page', 'tube_sort_mixed', 'tube_no_media']) if (!d[k]) ok(k + ' in ' + lang, false);
  if (d.tube !== 'ZimiTube') ok('it is called ZimiTube in ' + lang, false);
}

process.exit(failures ? 1 : 0);
