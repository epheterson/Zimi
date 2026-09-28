// Saving in each app (1.12): ZimiTube, ZimiExchange, Reddot and Maps each
// show their own part of Saved, and add to a list with one picker.
//
// Runs the real parts: app.js's Saved store, apps.js's controls (Like, Save,
// Lists) and a thread's place, ZimiTube's rows, Maps' place names, against
// a sandboxed store. The browser half is tests/test_saved_apps_live.py.
//
// Run: node tests/test_saved_apps.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi');
const src = fs.readFileSync(path.join(root, 'static', 'app.js'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'static', 'apps.js'), 'utf8');
const tube = fs.readFileSync(path.join(root, 'static', 'tube.html'), 'utf8');
const exchange = fs.readFileSync(path.join(root, 'static', 'exchange.html'), 'utf8');
const reddot = fs.readFileSync(path.join(root, 'static', 'reddot.html'), 'utf8');
const books = fs.readFileSync(path.join(root, 'static', 'books.html'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');

let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}
function extract(text, re, label) {
  const m = text.match(re);
  if (!m) { ok('found ' + label, false); return ''; }
  return m[0];
}
function memoryStorage() {
  const s = {};
  return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; } };
}

// One page in the shell: the store is the shell's (window.parent.Saved), the
// page's controls are apps.js's.
function page(extra) {
  const bars = [{ innerHTML: '' }];
  const ctx = Object.assign({
    localStorage: memoryStorage(), SK: { SAVED: 'zimi_saved', BOOKMARKS: 'b', BM_FOLDERS: 'f', BOOK_PLACES: 'p' },
    Math, JSON, Object, Array, String, Number, isFinite, Infinity,
    // A clock a second on at every look, so "the latest first" has a latest.
    clock: 1790000000000,
    _savedChanged: () => {},
    STR: { sv: { save: 'Save', saved: 'Saved', like: 'Like', liked: 'Liked', lists: 'Lists', add_to_list: 'Add to a list', all: 'All', none: 'Nothing saved.' },
      watch_later: 'Watch later', continue: 'Continue watching' },
    document: { querySelectorAll: () => bars, documentElement: { scrollHeight: 4000 } },
    bars, scrolled: 0, clearTimeout: () => {}, setTimeout: () => 0,
  }, extra || {});
  ctx.Date = { now: () => (ctx.clock += 1000) };
  ctx.window = { addEventListener: () => {}, innerHeight: 800, get scrollY() { return ctx.scrolled; } };
  vm.createContext(ctx);
  vm.runInContext(extract(src, /var Saved = \(function \(\) \{[\s\S]*?\n\}\)\(\);/, 'Saved'), ctx);
  ctx.window.parent = { Saved: ctx.Saved };
  vm.runInContext([
    extract(shared, /function esc\(x\) \{[^\n]*\n/, 'esc'),
    extract(shared, /function J\(v\) \{[^\n]*\n/, 'J'),
    extract(shared, /function saved\(\) \{[\s\S]*?\nfunction savedListChips[\s\S]*?\n\}/, 'the saved controls'),
  ].join('\n'), ctx);
  return ctx;
}

// ── the controls on the thing open ────────────────────────────────────────
{
  const p = page();
  const q = { kind: 'question', app: 'exchange', zim: 'cooking', path: 'questions/567/onions', title: 'Onions', meta: { votes: 265 } };
  p.savedBar(null);
  ok('nothing open: no controls', p.bars[0].innerHTML === '');
  p.savedBar(q, { thread: true });
  const bar = p.bars[0].innerHTML;
  ok('Like, Save and Lists, none pressed', /data-sv="like" aria-pressed="false"/.test(bar) && /data-sv="save" aria-pressed="false"/.test(bar) && /<span>Save<\/span>/.test(bar) &&
    /data-sv="lists" aria-haspopup="menu" title="Add to a list"/.test(bar));
  p.savedDo({ getAttribute: () => 'save' });
  ok('Save keeps it, with what its row needs', p.Saved.has(q) && p.Saved.get(q).meta.votes === 265 && /class="svb on" data-sv="save" aria-pressed="true"/.test(p.bars[0].innerHTML) && /<span>Saved<\/span>/.test(p.bars[0].innerHTML));
  p.savedDo({ getAttribute: () => 'like' });
  ok('Like puts it in Liked', p.Saved.inList(q, p.Saved.LIKED) && /class="svb on" data-sv="like"/.test(p.bars[0].innerHTML) && /<span>Liked<\/span>/.test(p.bars[0].innerHTML));
  p.savedDo({ getAttribute: () => 'like' });
  ok('and out again, still kept', !p.Saved.inList(q, p.Saved.LIKED) && p.Saved.has(q));
  p.savedDo({ getAttribute: () => 'like' });
  p.savedDo({ getAttribute: () => 'save' });
  ok('letting it go takes it out of every list', !p.Saved.has(q) && p.Saved.itemsFor({ list: p.Saved.LIKED }).length === 0);
  const liked = page();
  liked.savedBar(q);
  liked.savedDo({ getAttribute: () => 'like' });
  ok('a like keeps a thing never saved, in Liked', liked.Saved.has(q) && liked.Saved.inList(q, liked.Saved.LIKED));
  const tubeBar = page();
  tubeBar.savedBar({ kind: 'video', app: 'tube', zim: 'ted', path: 'talks/1', title: 'A talk' }, { save: ['Watch later'] });
  ok('ZimiTube calls Save Watch later, pressed or not', /<span>Watch later<\/span>/.test(tubeBar.bars[0].innerHTML));
  tubeBar.savedDo({ getAttribute: () => 'save' });
  ok('...and pressed it still says so', /class="svb on" data-sv="save"[^>]*>[\s\S]*<span>Watch later<\/span>/.test(tubeBar.bars[0].innerHTML));
}

// ── where you are in a long thread ────────────────────────────────────────
{
  const p = page();
  const post = { kind: 'post', app: 'reddot', zim: 'reddit_kiwix', path: 'r/kiwix/abc12/', title: 'A post' };
  p.savedBar(post, { thread: true });
  p.scrolled = 1600;
  p.threadWrite();
  ok('a thread not kept keeps no place', !p.Saved.position(post));
  p.Saved.save(post);
  p.threadWrite();
  ok('a kept thread keeps where you are, as a share of the way down', p.Saved.position(post).where.f === 0.5, JSON.stringify(p.Saved.position(post)));
  p.scrolled = 10;
  p.threadWrite();
  ok('back at the top, the place is let go', !p.Saved.position(post));
  p.document.documentElement.scrollHeight = 1200;
  p.scrolled = 300;
  p.threadWrite();
  ok('a thread under two screens has no place worth keeping', !p.Saved.position(post));
  const video = page();
  video.Saved.save(post);
  video.savedBar(post);
  video.scrolled = 1600;
  video.threadWrite();
  ok('only a thread keeps its scroll (a video keeps its time instead)', !video.Saved.position(post));
}

// ── the lists as chips in an app's Saved view ─────────────────────────────
{
  const p = page();
  const a = { kind: 'question', app: 'exchange', zim: 'c', path: 'q/1', title: 'One' };
  const b = { kind: 'question', app: 'exchange', zim: 'c', path: 'q/2', title: 'Two' };
  const v = { kind: 'video', app: 'tube', zim: 't', path: 'v/1', title: 'Talk' };
  ok('no list holds anything of the app: no chips', p.savedListChips('exchange', '', 'openSaved') === '');
  p.Saved.save(a); p.Saved.save(b); p.Saved.save(v);
  p.Saved.addToList(a, p.Saved.LIKED);
  const trip = p.Saved.createList('Trip');
  p.Saved.addToList(v, trip);
  const chips = p.savedListChips('exchange', p.Saved.LIKED, 'openSaved');
  ok('All with every question, Liked with its one; a list holding only videos is not here',
    /All <span class="n">2<\/span>/.test(chips) && /class="chip tag on" aria-pressed="true" onclick="openSaved\(&quot;liked&quot;\)">Liked <span class="n">1<\/span>/.test(chips) && !/Trip/.test(chips), chips);
}

// ── ZimiTube's rows ───────────────────────────────────────────────────────
{
  const p = page({ _byKey: {} });
  vm.runInContext(extract(tube, /var CONTINUE_SHOWN = [\s\S]*?\nfunction savedRows\(\) \{[\s\S]*?\n\}/, 'ZimiTube rows'), p);
  const vid = (n, extra) => Object.assign({ zim: 'ted', page: 'talks/' + n, title: 'Talk ' + n, thumb: 'thumbs/' + n + '.jpg', duration: 600, speaker: 'S' + n, zim_title: 'TED' }, extra || {});
  ok('nothing kept, nothing watched: no rows', p.savedRows().length === 0);
  p.Saved.setPosition(p.videoRef(vid(1)), { t: 300, d: 600, k: 0, f: 0.5 });
  p.Saved.setPosition(p.videoRef(vid(2)), { t: 4, d: 600, k: 0, f: 0.01 });
  p.Saved.setPosition(p.videoRef(vid(3, { audio: true, tracks: 3 })), { t: 2, d: 900, k: 1, f: 0.34 });
  p.Saved.save(p.videoRef(vid(4)));
  p.Saved.addToList(p.videoRef(vid(5)), p.Saved.LIKED);
  const trip = p.Saved.createList('Trip');
  p.Saved.addToList(p.videoRef(vid(4)), trip);
  p.Saved.save({ kind: 'question', app: 'exchange', zim: 'c', path: 'q/1', title: 'Not a video' });
  const rows = p.savedRows();
  ok('Continue watching, Watch later, Liked, then each list with a video', rows.map((r) => r.title).join(' | ') === 'Continue watching | Watch later | Liked | Trip', rows.map((r) => r.title).join(' | '));
  ok('Continue watching: the latest first, past its first seconds or into a later track, with how far',
    rows[0].items.map((v) => v.page).join(',') === 'talks/3,talks/1' && rows[0].f.join(',') === '0.34,0.5');
  ok('Watch later is every video kept, the latest first', rows[1].items.map((v) => v.page).join(',') === 'talks/5,talks/4');
  ok('a card draws from what was kept when the feed does not have it', rows[1].items[1].thumb === 'thumbs/4.jpg' && rows[1].items[1].speaker === 'S4' && rows[1].items[1].zim_title === 'TED');
  p._byKey['ted\ntalks/4'] = vid(4, { title: 'Talk 4, as the feed has it' });
  ok('...and from the feed when it does', p.savedRows()[1].items[1].title === 'Talk 4, as the feed has it');
  ok('a video resumes where it was, an audiobook at its track', p.resumeOf(vid(1)).t === 300 && p.resumeOf(vid(3)).k === 1 && p.resumeOf(vid(2)) === null);
}

// ── Maps: a place's name ──────────────────────────────────────────────────
{
  const labels = [
    { properties: { name: 'Museum of Tiles' }, geometry: { type: 'Point', coordinates: [1, 1] }, sourceLayer: 'poi' },
    { properties: { name: 'Lisbon', 'name:fr': 'Lisbonne' }, geometry: { type: 'Point', coordinates: [5, 5] }, sourceLayer: 'place' },
    { properties: { name: 'Belem' }, geometry: { type: 'Point', coordinates: [9, 9] }, sourceLayer: 'place' },
    { properties: { name: 'Avenida' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, sourceLayer: 'transportation_name' },
  ];
  let features = labels;
  const map = { getCenter: () => ({ lng: 0, lat: 0 }), project: (c) => (Array.isArray(c) ? { x: c[0] * 10, y: c[1] * 10 } : { x: c.lng * 10, y: c.lat * 10 }), queryRenderedFeatures: () => features };
  const ctx = { Math, parseFloat, isFinite, String, _readerMap: () => map, _currentLang: 'en', history: [], _histLoad: () => ctx.history, _fallbackTitle: () => 'Testland' };
  vm.createContext(ctx);
  vm.runInContext([
    extract(src, /var _MAP_HASH_RE = [^\n]*\n/, '_MAP_HASH_RE'),
    extract(src, /function parseMapHash\(hash\) \{[\s\S]*?\n\}/, 'parseMapHash'),
    extract(src, /var _MAP_SAME_SPOT_DEG = [^\n]*\n/, '_MAP_SAME_SPOT_DEG'),
    extract(src, /function _mapNear\(a, b\) \{[\s\S]*?\n\}/, '_mapNear'),
    extract(src, /function _mapPlaceTitle\(zim, pos\) \{[\s\S]*?\n\}/, '_mapPlaceTitle'),
    extract(src, /var _MAP_PLACE_LAYER_RE = [^\n]*\n/, '_MAP_PLACE_LAYER_RE'),
    extract(src, /function _mapNearestLabel\(\) \{[\s\S]*?\n\}/, '_mapNearestLabel'),
  ].join('\n'), ctx);
  const here = 'map=14.00/38.72150/-9.14000';
  ok('the nearest town names the place, before a museum nearer the middle', ctx._mapPlaceTitle('maps_en_testland', here) === 'Lisbon');
  ctx._currentLang = 'fr';
  ok('in the reader\'s language when the map has it', ctx._mapPlaceTitle('maps_en_testland', here) === 'Lisbonne');
  ctx._currentLang = 'en';
  features = labels.filter((f) => f.sourceLayer !== 'place');
  ok('no town on screen: the nearest thing named', ctx._mapPlaceTitle('maps_en_testland', here) === 'Museum of Tiles');
  features = [];
  ok('nothing named: no name (the map\'s own is the caller\'s)', ctx._mapPlaceTitle('maps_en_testland', here) === '');
  ctx.history = [
    { type: 'article', zim: 'maps_en_testland', pos: here, title: 'Testland' },
    { type: 'article', zim: 'maps_en_testland', pos: 'map=15/38.72150/-9.14000', title: 'Rossio' },
  ];
  ok('the place a search flew to, while the map is still there (the map\'s own name is not a place)', ctx._mapPlaceTitle('maps_en_testland', here) === 'Rossio');
  ok('moved off it, it is not', ctx._mapPlaceTitle('maps_en_testland', 'map=14.00/38.80000/-9.14000') === '');
}

// ── the pages and the shell ───────────────────────────────────────────────
ok('every app page is handed the words for what is kept', /sv: _savedAppWords\(app\) \};/.test(src) && /function _savedAppWords\(app\) \{/.test(src));
ok('ZimiTube is handed Watch later and Continue watching', /'tube_watch_later', 'tube_continue'\]/.test(src));
ok('one list picker, the panel\'s own lists, for every app', /function savedPickLists\(ref, rect\) \{[\s\S]*?_bmListsSubmenuHtml\(key\)/.test(src) && /p\.savedPickLists\(item, /.test(shared) &&
  /savedPickLists\(place, at\)/.test(src) && /pickLists\(bookRef\(b\), el\)/.test(books) && !/savedPickLists|_bmListsSubmenuHtml/.test(tube + exchange + reddot + books));
ok('the controls sit in each app\'s own actions, a thread\'s under its title', /<span class="svbar"><\/span>\s*<button id="autoplay"/.test(tube) &&
  /id="q-who"><\/div>\s*<div class="actions top"><span class="svbar"><\/span><\/div>/.test(exchange) && /id="p-who"><\/div>\s*<div class="actions top"><span class="svbar"><\/span><\/div>/.test(reddot));
ok('the Saved tab in ZimiExchange and Reddot, from the store, no request', /function openSaved\(list\)/.test(exchange) && /function openSaved\(list\)/.test(reddot) &&
  !/fetch\(/.test(extract(exchange, /function renderSaved\(\) \{[\s\S]*?\n\}/, 'renderSaved')) && !/fetch\(/.test(extract(reddot, /function renderSaved\(\) \{[\s\S]*?\n\}/, 'renderSaved')));
ok('each page redraws what it shows of Saved when the store changes', [tube, exchange, reddot].every((p) => /window\.__saved = function\(\) \{\s*savedPaint\(\);/.test(p)));
ok('Places and maps is on every map page, and saves the view on screen', /aria-label="Places and maps" data-i18n-aria="map_places_and_maps"/.test(shell) &&
  /if \(role === 'save-place'\) \{ toggleBookmark\(\); _renderMapSourceDropdown\(dd\); return; \}/.test(src) &&
  /if \(ref\.kind === 'place'\) ref\.title = _mapPlaceTitle\(ref\.zim, ref\.where && ref\.where\.pos\) \|\| ref\.title;/.test(src));
ok('a tap in the page under the picker closes it', /window\._closeMenu = closeCtx;/.test(src) && /window\.addEventListener\('blur', function \(\) \{[\s\S]*?window\._closeMenu\(\);\s*\}, \{ once: true \}\);/.test(src));

const KEYS = ['saved_save', 'saved_like', 'saved_add_to_list', 'tube_watch_later', 'tube_continue', 'map_places', 'map_places_and_maps', 'map_place_save'];
const en = JSON.parse(fs.readFileSync(path.join(root, 'static', 'i18n', 'en.json'), 'utf8'));
for (const lang of fs.readdirSync(path.join(root, 'static', 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(root, 'static', 'i18n', lang), 'utf8'));
  const missing = KEYS.filter((k) => !d[k] || /\u2014/.test(d[k]) || (lang !== 'en.json' && d[k] === en[k]));
  ok(lang + ' says it in its own words', !missing.length, missing.join(', '));
}

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
