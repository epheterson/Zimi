// The apps take the library's order, and the Apps page shows what each is
// made of (#100).
//
// tripplehelix: "There's no reason why the sorting UI is below the apps and
// the title isn't clickable like everything else." Eric, 2026-09-28: "for the
// sort we can sort the apps by recently updated (i.e. contains zims that were
// recently updated, added, etc..)" and "maybe ... allow an Apps-only page".
//
// So one order governs the whole library: its control sits on the Apps
// heading, above the row, and the apps move with it. An app is as recent as
// the newest ZIM inside it, as big as its ZIMs together, and otherwise goes
// by its name. The Apps heading opens the Apps page: each app, its ZIMs
// under it, in the same order.
//
// Run: node tests/test_apps_order.cjs   (exit 0 = pass)

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
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DAY = 86400, NOW = 1790000000;
const NAMES = { tube: 'ZimiTube', cat_maps: 'Maps', exchange: 'ZimiExchange', reddot: 'Reddot', wiki: 'Zimipedia', books: 'Bookshelf', apps_section: 'Apps' };
const ctx = {
  zimsCache: [
    { name: 'ted_en_all', title: 'All TED videos', kind: 'video', main_path: 'i', first_seen: NOW - 90 * DAY, entries: 5000 },
    { name: 'blender', title: 'Blender Studio films', kind: 'video', main_path: 'i', first_seen: NOW - 80 * DAY, entries: 90000 },
    { name: 'gutenberg_en_all', title: 'Project Gutenberg', kind: 'books', main_path: 'i', first_seen: NOW - 60 * DAY, entries: 900000 },
    { name: 'askubuntu', title: 'Ask Ubuntu', kind: 'qa', main_path: 'i', first_seen: NOW - 30 * DAY, entries: 300000 },
    { name: 'osm-hawaii', title: 'Hawaii', kind: 'map', main_path: 'i', first_seen: NOW - 70 * DAY, entries: 10 },
    { name: 'wikipedia_en_all', title: 'Wikipedia', main_path: 'A/Main', first_seen: NOW - 5 * DAY, entries: 6000000 },
  ],
  esc, t: k => NAMES[k] || k, tH: k => esc(NAMES[k] || k), tPlural: (k, n) => k + ':' + n,
  // The server offers these five (named, so the orders below don't shift when
  // an app's default changes: Zimipedia is on by default from 1.12).
  _getLibraryView: () => 'list', _userSession: null, document: { body: { dataset: { zimiApps: 'maps,tube,exchange,reddot,books' } } },
  homeRecentFilter: null, homeLangFilter: new Set(),
  // A card grid, as its ZIMs' names in the order it was handed them.
  renderCardGrid: zims => '<grid ' + zims.map(z => z.name).join(',') + '>',
  _zimInfo: name => ctx.zimsCache.find(z => z.name === name) || null,
};
vm.createContext(ctx);
vm.runInContext([
  'var _MAPS_SVG = "", _TUBE_PLAY_SVG = "", _EXCHANGE_SVG = "", _REDDOT_SVG = "", _WIKI_SVG = "", _BOOKS_SVG = "";',
  extract(/function _newestPer\(list, key\) \{[\s\S]*?\n\}/, '_newestPer'),
  extract(/function _installedOfKind\(kind, key\) \{[\s\S]*?\n\}/, '_installedOfKind'),
  extract(/function _installedFor\(kind, app, key\) \{[\s\S]*?\n\}/, '_installedFor'),
  extract(/function _mapName\(z\) \{[\s\S]*?\n\}/, '_mapName'),
  extract(/function _mapSourceLabel\(z\) \{[\s\S]*?\n\}/, '_mapSourceLabel'),
  extract(/function _installedMaps\(\) \{[\s\S]*?\n\}/, '_installedMaps'),
  extract(/function _installedVideoZims\(\) \{[\s\S]*?\n\}/, '_installedVideoZims'),
  extract(/function _installedQaZims\(\) \{[\s\S]*?\n\}/, '_installedQaZims'),
  extract(/function _installedRedditZims\(\) \{[\s\S]*?\n\}/, '_installedRedditZims'),
  extract(/function _installedWikiZims\(\) \{[\s\S]*?\n\}/, '_installedWikiZims'),
  extract(/function _installedBookZims\(\) \{[\s\S]*?\n\}/, '_installedBookZims'),
  extract(/var APP_NAMES = [^\n]*\n/, 'APP_NAMES'),
  extract(/var APPS_OPT_IN = [^\n]*\n/, 'APPS_OPT_IN'),
  extract(/function _appOptIn\(app\) \{[^\n]*\n/, '_appOptIn'),
  extract(/var _userPrefs = [^\n]*\n/, '_userPrefs'),
  extract(/function _appsAllowedByServer\(app\) \{[\s\S]*?\n\}/, '_appsAllowedByServer'),
  extract(/function _appShown\(app\) \{[\s\S]*?\n\}/, '_appShown'),
  extract(/function _appsEnabled\(\) \{[\s\S]*?\n\}/, '_appsEnabled'),
  extract(/var _APP_CATEGORY = [^\n]*\n/, '_APP_CATEGORY'),
  extract(/function _appTileHtml\(app, title, icon, names, openFn\) \{[\s\S]*?\n\}/, '_appTileHtml'),
  extract(/function _mapsTileHtml\(\) \{[\s\S]*?\n\}/, '_mapsTileHtml'),
  extract(/function _tubeTileHtml\(\) \{[\s\S]*?\n\}/, '_tubeTileHtml'),
  extract(/function _exchangeTileHtml\(\) \{[\s\S]*?\n\}/, '_exchangeTileHtml'),
  extract(/function _reddotTileHtml\(\) \{[\s\S]*?\n\}/, '_reddotTileHtml'),
  extract(/function _wikiTileHtml\(\) \{[\s\S]*?\n\}/, '_wikiTileHtml'),
  extract(/function _booksTileHtml\(\) \{[\s\S]*?\n\}/, '_booksTileHtml'),
  extract(/function _appsRowHtml\(\) \{[\s\S]*?\n\}/, '_appsRowHtml'),
  extract(/function _appsPageHtml\(shown\) \{[\s\S]*?\n\}/, '_appsPageHtml'),
  extract(/function _cardsInOrder\(cards, compare\) \{[\s\S]*?\n\}/, '_cardsInOrder'),
].join('\n'), ctx);
require('./apps_order_parts.cjs')(src, ctx);

const order = sort => { ctx.localStorage.setItem('zimi_library_sort', sort); return vm.runInContext('_shownApps()', ctx).join(' '); };
const rowOrder = () => (vm.runInContext('_appsRowHtml()', ctx).match(/data-app="(\w+)"/g) || []).map(s => s.slice(10, -1)).join(' ');
const zim = name => ctx.zimsCache.find(z => z.name === name);

// ── the order ────────────────────────────────────────────────────────────
ok('alphabetical: the apps by their names, as the sources go by their titles', order('alpha') === 'books maps reddot exchange tube', order('alpha'));
ok('the row draws them in that order', rowOrder() === 'books maps reddot exchange tube', rowOrder());
ok('recently added: the app whose newest ZIM arrived last first, an empty app last', order('added') === 'exchange books maps tube reddot', order('added'));
ok('most articles: the app whose ZIMs hold the most, together', order('entries') === 'books exchange tube maps reddot', order('entries'));

// A TED build updated this morning: ZimiTube holds the newest change in the library.
zim('ted_en_all').updated_at = NOW - 3600;
ok('recently updated: an app with a just-updated ZIM rises to the front', order('updated') === 'tube exchange books maps reddot', order('updated'));
ok('and the row follows it', rowOrder() === 'tube exchange books maps reddot', rowOrder());
ok('an update does not make an app newly added', order('added') === 'exchange books maps tube reddot');
// A ZIM added today counts as a change for Recently updated too (Eric: "updated, added, etc.").
ctx.zimsCache.push({ name: 'nautilus_books', title: 'Water', kind: 'books', main_path: 'i', first_seen: NOW, entries: 7 });
ok('recently updated: an app with a ZIM added today is the newest change', order('updated').startsWith('books tube'), order('updated'));
// The cards count it the same way, so the Apps page (each app's ZIMs in the
// library's order) agrees with the apps: the ZIM added today leads them too.
const cardsUpdated = vm.runInContext('_sortLibrary(zimsCache)', ctx).map(z => z.name);
ok('recently updated: the ZIM added today leads the cards, as its app leads the apps', cardsUpdated.slice(0, 2).join() === 'nautilus_books,ted_en_all', cardsUpdated.join());
ok('and inside its app it comes before the app\'s older ZIM', /<grid nautilus_books,gutenberg_en_all>/.test(vm.runInContext('_appsPageHtml', ctx)(new Set(ctx.zimsCache.map(z => z.name)))));
ok('recently added puts it first too', order('added').startsWith('books '), order('added'));
ok('ties and empty apps keep the row\'s own order', order('added').endsWith('reddot') && vm.runInContext("_sortApps(['wiki', 'reddot'])", ctx).join(' ') === 'wiki reddot');
ok('an unknown order is alphabetical', order('nonsense') === 'books maps reddot exchange tube');
ok('ordering reads only the library list: no fetch, no disk', !/serverFetch|fetch\(/.test(extract(/function _appSortValue\(app, mode\) \{[\s\S]*?\n\}/, 'v') + extract(/function _sortApps\(apps\) \{[\s\S]*?\n\}/, 's')));

// ── the heading, above the row, opens the Apps page ─────────────────────
const row = vm.runInContext('_appsRowHtml()', ctx);
ok('the Apps heading is a clickable section heading like the categories\', a link for the keyboard too', /^<div class="cat-heading clickable" role="link" tabindex="0" onclick="openAppsPage\(\)">Apps<\/div><div class="stats-grid apps-grid">/.test(row), row.slice(0, 120));
ok('Enter or Space on a clickable section heading opens it', /document\.addEventListener\('keydown', function\(e\) \{\n\s*var h = e\.target;\n\s*if \(\(e\.key === 'Enter' \|\| e\.key === ' '\) && h && h\.classList && h\.classList\.contains\('cat-heading'\) && h\.classList\.contains\('clickable'\)\)/.test(src));
ok('the order and view controls ride the first section heading, which is now the Apps heading above the row', /function _placeViewToggle\(\) \{[\s\S]*?output\.querySelector\('\.cat-heading'\)/.test(src) && src.indexOf('h += _appsRowHtml();') < src.indexOf("const favNames = (collectionsCache && collectionsCache.favorites)"));
const saved = ctx.zimsCache;
ctx.zimsCache = [];
ok('an empty library: the name is only a name, there is no page behind it yet', /^<div class="cat-heading">Apps<\/div>/.test(vm.runInContext('_appsRowHtml()', ctx)));
ctx.zimsCache = saved;
ok('the Apps page is a scope of the library, restored from its address', /function openAppsPage\(\) \{\n\s*enterScope\('apps', t\('apps_section'\), _appsZimNames\(\), true\);/.test(src) && /if \(type === 'apps'\) return _appsZimNames\(\);/.test(src) && /\} else if \(homeScope && homeScope\.type === 'apps'\) \{\n\s*h \+= _appsPageHtml\(_homeShown\);/.test(src));
ok('its library is every ZIM inside an offered app, once', vm.runInContext('_appsZimNames()', ctx).sort().join(' ') === 'askubuntu blender gutenberg_en_all nautilus_books osm-hawaii ted_en_all');

// ── the Apps page ────────────────────────────────────────────────────────
ctx.localStorage.setItem('zimi_library_sort', 'alpha');
const all = new Set(ctx.zimsCache.map(z => z.name));
let pageHtml = vm.runInContext('_appsPageHtml', ctx)(all);
const sections = pageHtml.split('<div class="cat-heading').slice(1);
ok('one section per app, in the library\'s order', sections.length === 5 && />Bookshelf</.test(sections[0]) && />ZimiTube</.test(sections[4]));
ok('each app\'s ZIMs under its name, in the library\'s order', /<grid gutenberg_en_all,nautilus_books>/.test(sections[0]) && /<grid ted_en_all,blender>/.test(sections[4]));
ok('the app\'s name opens the app', /clickable" role="link" tabindex="0" onclick="_APP_OPEN\.books\(\)">Bookshelf</.test(sections[0]) && /_APP_OPEN = \{ maps: openMaps, tube: openTube, exchange: openExchange, reddot: openReddot, wiki: openWiki, books: openBooks \}/.test(src));
ok('an app with nothing inside shows its door to what it needs', /^">Reddot<\/div><div class="stats-grid apps-grid"><a class="stat-card app-tile app-empty reddot-tile"/.test(sections[2]));
ctx.localStorage.setItem('zimi_library_sort', 'entries');
pageHtml = vm.runInContext('_appsPageHtml', ctx)(all);
ok('a new order: the sections and the ZIMs in them move with it', /Bookshelf[\s\S]*<grid gutenberg_en_all,nautilus_books>[\s\S]*ZimiExchange[\s\S]*ZimiTube[\s\S]*<grid blender,ted_en_all>/.test(pageHtml));
ctx.homeRecentFilter = 'added';
pageHtml = vm.runInContext('_appsPageHtml', ctx)(new Set(['nautilus_books']));
ok('a filter narrows the page to the apps holding what it lets through', (pageHtml.match(/cat-heading/g) || []).length === 1 && /<grid nautilus_books>/.test(pageHtml));
ctx.homeRecentFilter = null;
ok('the page is rebuilt on a new order (its sections move), the home row slides in place',
  /if \(homeScope && homeScope\.type === 'apps'\) return false;/.test(src));

// ── the row slides into its new order in place ───────────────────────────
const card = (app, zim) => ({ dataset: app ? { app, zim: '' } : { zim } });
const tiles = ['maps', 'tube', 'exchange', 'reddot', 'books'].map(a => card(a));
ctx.localStorage.setItem('zimi_library_sort', 'alpha');
ok('the apps\' tiles are put in the apps\' order, the same cards moved',
  ctx._cardsInOrder(tiles, null).map(c => c.dataset.app).join(' ') === 'books maps reddot exchange tube' && ctx._cardsInOrder(tiles, null).every(c => tiles.includes(c)));
const alpha = vm.runInContext('_LIBRARY_SORTERS.alpha', ctx);
ok('a grid of sources still goes by its ZIMs', ctx._cardsInOrder([card('', 'wikipedia_en_all'), card('', 'askubuntu')], alpha).map(c => c.dataset.zim).join(' ') === 'askubuntu wikipedia_en_all');
ok('a card whose ZIM is gone asks for a rebuild', ctx._cardsInOrder([card('', 'gone'), card('', 'askubuntu')], alpha) === null);
ok('app tiles carry their app, so they can be moved rather than rebuilt', (row.match(/data-app="/g) || []).length === 5);

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
