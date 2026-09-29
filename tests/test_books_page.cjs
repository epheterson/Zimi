// Bookshelf: the page's own logic (covers, eras, years, shelves, where you
// are in each book) run from the page itself, the reader's part (a book
// opens in Reader View, keeps its place, steps by chapter) run from the
// shell, and the shell's surface (the tile, the address, the box, Back).
// Eric, 2026-09-25: "Book app with nice browsing interface by author and
// date or whatever and reading view of course."
//
// Run: node tests/test_books_page.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const page = fs.readFileSync(path.join(root, 'books.html'), 'utf8').replace(/\r\n/g, '\n');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const apps = fs.readFileSync(path.join(root, 'apps.js'), 'utf8').replace(/\r\n/g, '\n');
let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}
function extract(text, re, label) {
  const m = text.match(re);
  if (!m) throw new Error('could not extract ' + label);
  return m[0];
}
function memoryStorage() {
  const m = {};
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } };
}

// ── the page's pure parts ───────────────────────────────────────────────
const ctx = { localStorage: memoryStorage(), Intl, Date, Math, JSON, String, Number, Object,
  STR: { lang: 'en', bce: '{from} to {to} BCE', bce_ce: '{from} BCE to {to} CE', lcc: { P: 'Language and literature', PR: 'English literature', Q: 'Science' } } };
vm.createContext(ctx);
// The shell's Saved, as the page reaches it through apps.js's saved(), on a
// clock that moves a millisecond each time it is read (so "the latest first"
// is decided by the order things happen here, not by how fast they ran).
let clock = 1700000000000;
const shell = { localStorage: memoryStorage(), Math, JSON, Object, Array, String, Number, isFinite, Date: { now: () => ++clock },
  SK: { SAVED: 'zimi_saved', SAVED_POS: 'zimi_saved_pos', SAVED_LEGACY_ASKED: 'zimi_saved_legacy_asked', BOOKMARKS: 'zimi_bookmarks', BM_FOLDERS: 'zimi_bm_folders', BOOK_PLACES: 'zimi_book_places' } };
vm.createContext(shell);
vm.runInContext(extract(src, /function _getStorageJSON\(key, fallback, session\) \{[\s\S]*?\nfunction _setStorageJSON\(key, value\) \{[\s\S]*?\n\}/, 'the storage helpers') + '\n' +
  extract(src, /var Saved = \(function \(\) \{[\s\S]*?\n\}\)\(\);/, 'Saved'), shell);
ctx.saved = () => shell.Saved;
vm.runInContext([
  extract(page, /var COVER_HUES = [^\n]*\n/, 'COVER_HUES'),
  extract(page, /function hash\(s\) \{[^\n]*\n/, 'hash'),
  extract(page, /function coverHue\(title\) \{[^\n]*\n/, 'coverHue'),
  extract(page, /function ltr\(s\) \{[^\n]*\n/, 'ltr'),
  extract(page, /function eraLabel\(from\) \{[\s\S]*?\n\}/, 'eraLabel'),
  extract(page, /function yearsLabel\(born, died\) \{[\s\S]*?\n\}/, 'yearsLabel'),
  extract(page, /function shelfName\(code\) \{[\s\S]*?\n\}/, 'shelfName'),
  extract(page, /function langName\(code\) \{[\s\S]*?\n\}/, 'langName'),
  extract(page, /function bookRef\(b\) \{[\s\S]*?\n\}/, 'bookRef'),
  extract(page, /function card\(x\) \{[\s\S]*?\n\}/, 'card'),
  extract(page, /function places\(\) \{[\s\S]*?\n\}/, 'places'),
  extract(page, /function placeOf\(b\) \{[\s\S]*?\n\}/, 'placeOf'),
  extract(page, /function noteOpened\(b\) \{[\s\S]*?\n\}/, 'noteOpened'),
  extract(page, /function shelf\(\) \{[\s\S]*?\n\}/, 'shelf'),
  'var _known = {};',
].join('\n'), ctx);

const plain = s => s.replace(/[\u2066\u2069]/g, '');
ok('a hundred years is named by its span', plain(ctx.eraLabel(1800)) === '1800–1899' && plain(ctx.eraLabel(0)) === '0–99');
ok('before the common era in the shell\'s words', ctx.eraLabel(-100) === '100 to 1 BCE' && ctx.eraLabel(-700) === '700 to 601 BCE');
ok('a span of years stays left to right in a right-to-left line', /^\u2066.*\u2069$/.test(ctx.eraLabel(1900)) && /^\u2066.*\u2069$/.test(ctx.yearsLabel(1856, 1908)));
ok('a writer\'s years, and BCE ones', plain(ctx.yearsLabel(1856, 1908)) === '1856–1908' && ctx.yearsLabel(-71, -20) === '71 to 20 BCE' && ctx.yearsLabel(-63, 14) === '63 BCE to 14 CE' && ctx.yearsLabel(null, null) === '');
ok('a shelf by its subclass name, else its class\'s', ctx.shelfName('PR') === 'English literature' && ctx.shelfName('PQ') === 'Language and literature' && ctx.shelfName('QA') === 'Science' && ctx.shelfName('XX') === 'XX');
ok('a language by its name, in the shell\'s language', ctx.langName('la') === 'Latin' && ctx.langName('he') === 'Hebrew');
ok('a cover set in type keeps its colour wherever it is shown', ctx.coverHue('Aeneidos') === ctx.coverHue('Aeneidos') && ctx.COVER_HUES.indexOf(ctx.coverHue('Tales')) >= 0);

// Where you are: the reader writes f, the shelf remembers what it opened.
const S = shell.Saved;
S.setPosition({ kind: 'book', zim: 'gutenberg_he', path: 'Tales.5139', title: 'Tales' }, { f: 0.5, c: 700 });
ctx.noteOpened({ zim: 'gutenberg_la', path: 'Aeneidos.227', id: 227, title: 'Aeneidos', author: 'Virgil', cover: 'covers/227_cover_image.jpg' });
ok('a book opened but not yet read is not "in progress"', ctx.places().length === 1 && ctx.places()[0].path === 'Tales.5139');
// The reader, reading: the place moves, the card the shelf noted stays.
S.setPosition({ kind: 'book', app: 'books', zim: 'gutenberg_la', path: 'Aeneidos.227', title: 'Aeneidos (from the page)' }, { f: 0.34, c: 51234 });
const p = ctx.places();
ok('Continue reading: the books you are in, the latest first, with what the shelf needs', p.length === 2 && p[0].id === 227 && p[0].title === 'Aeneidos (from the page)' && p[0].author === 'Virgil' && p[0].cover === 'covers/227_cover_image.jpg' && p[0].zim === 'gutenberg_la' && p[1].path === 'Tales.5139' && p[1].id === 5139);
ok('a book\'s place, found by its ZIM and page', ctx.placeOf({ zim: 'gutenberg_la', path: 'Aeneidos.227' }).f === 0.34 && ctx.placeOf({ zim: 'x', path: 'y' }) === null);
// My shelf: kept in the same store, under the same key as the reader's bookmark.
ctx._known[227] = { zim: 'gutenberg_la', path: 'Aeneidos.227', id: 227, title: 'Aeneidos', author: 'Virgil', cover: '' };
const onShelf = (b) => S.has(ctx.bookRef(b));
ok('a book not on my shelf', !onShelf(ctx._known[227]) && ctx.shelf().length === 0);
S.save(ctx.bookRef(ctx._known[227]));  // what Add to my shelf (apps.js savedBar) saves
ok('Add to my shelf keeps it as a book of Bookshelf\'s', onShelf(ctx._known[227]) && ctx.shelf()[0].id === 227 && ctx.shelf()[0].author === 'Virgil' &&
  S.get('gutenberg_la\nAeneidos.227').kind === 'book' && S.get('gutenberg_la\nAeneidos.227').app === 'books');
ok('a book the reader bookmarked (no card) still has its number', ctx.card({ zim: 'g', path: 'Tales.5139', title: 'Tales' }).id === 5139);
S.remove(ctx.bookRef(ctx._known[227]));
ok('and taken off again', !onShelf(ctx._known[227]) && ctx.shelf().length === 0);
ok('outside the shell (no saved()), an empty shelf, not a broken one', (ctx.saved = () => null, ctx.places().length === 0 && ctx.shelf().length === 0));
ok('a book\'s page has the controls every app shares: Save in the shelf\'s words, Lists, no Like', /<span class="svbar"><\/span>/.test(page) &&
  /savedBar\(bookRef\(b\), \{ save: \[STR\.add_shelf, STR\.on_shelf\], like: false \}\);/.test(page) && /else if \(v\.v === 'book'\) savedPaint\(\);/.test(page) &&
  !/toggleShelf|keepHtml|listsFor/.test(page));
ctx.saved = () => shell.Saved;

// ── the page's surface ───────────────────────────────────────────────────
ok('every view the shell steers: a step back, the home, the dice, the box', /window\.__back = back;/.test(page) && /window\.__home = function\(\)/.test(page) && /window\.__random = function\(\)/.test(page) && /window\.booksSearch = booksSearch;/.test(page));
ok('at the shelf the shell leaves; inside it the arrow steps back', /window\.__top = function\(\) \{ return _stack\.length <= 1; \};/.test(page));
ok('a cover is a real link, and a modified click keeps it for a new tab', /'<a class="bk" href="' \+ esc\(zpath\(b\.zim, b\.path\)\)/.test(page) && /e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.button === 1/.test(page));
ok('a missing picture becomes a cover set in type', /onerror="noCover\(this\)"/.test(page) && /function noCover\(img\)/.test(page));
ok('Read opens the book in Zimi\'s reader, noted first for Continue reading', /noteOpened\(b\);\n\s*tell\(\{ zimi: 'open', zim: b\.zim, path: b\.path \}\);/.test(page));
ok('the page keeps nothing of its own: places and the shelf are the shell\'s Saved', /function saved\(\) \{ try \{ return \(window\.parent !== window && window\.parent\.Saved\) \|\| null; \}/.test(apps) && !/localStorage/.test(page) && !/zimi_book_places/.test(page));
ok('a change to what is kept redraws the page where it is', /e\.data\.zimi === 'saved'[\s\S]{0,200}window\.__saved\(\)/.test(apps) && /window\.__saved = function\(\) \{/.test(page) && /postMessage\(\{ zimi: 'saved' \}, location\.origin\)/.test(src));
ok('the empty page is a door to the Books category', /category: 'gutenberg'/.test(page));
ok('eras and subjects arrive without a reload once the records are read', /if \(!_home\.details && \(_home\.total \|\| \(_home\.sources \|\| \[\]\)\.length\)\) setTimeout\(refreshHome, /.test(page));
// A shelf of Wikisource or a document library alone is empty until its books
// are read: it says they are coming, and fills when the first arrive.
ok('an empty shelf still being read says the books are coming', /if \(!_home\.details && \(_home\.sources \|\| \[\]\)\.length\) \{ \$\('view'\)\.innerHTML = '<div class="empty">' \+ esc\(STR\.reading\)/.test(page) &&
  /\(d\.total && !was\.total\)\) && cur\(\)\.v === 'home'\) show\(\);/.test(page) && /'books_load_part', 'books_reading'\]/.test(src));
ok('a book of another family is opened by its "<zim>/<id>"', /onclick="readBook\(' \+ J\(b\.id\) \+ '\)"/.test(page) && /id: \/\^\\d\+\$\/\.test\(id\) \? Number\(id\) : id/.test(page));

// ── the reader: a book opens in Reader View, keeps its place, steps by chapter
const rctx = { document: { documentElement: { getAttribute: () => 'ltr' } } };
vm.createContext(rctx);
vm.runInContext([
  extract(src, /function _bookAuthorName\(creator\) \{[\s\S]*?\n\}/, '_bookAuthorName'),
].join('\n'), rctx);
ok('a record\'s "Surname, Given, years" prints as a cover does', rctx._bookAuthorName('Ewald, Carl, 1856-1908') === 'Carl Ewald' && rctx._bookAuthorName('Virgil, 71 BCE-20 BCE') === 'Virgil' && rctx._bookAuthorName('') === '');
ok('a Gutenberg page is known by its own record, an EPUB\'s chapters by theirs', /function _isBookDoc\(doc\) \{\n\s*try \{ return !!doc\.querySelector\('link\[rel="dcterms\.isFormatOf"\]\[href\*="gutenberg\.org"\],meta\[name="zimi-book"\]'\);/.test(src));
ok('an EPUB\'s address is a book\'s before it loads', /if \(m && \/\\\.epub\\\/\$\/i\.test\(m\[2\]\)\) return true;/.test(src));
ok('a book has no <main>: Reader View reads its body', /if \(!main && _isBookDoc\(doc\)\) main = doc\.body;/.test(src) && /return !!main && \(main !== doc\.body \|\| _isBookDoc\(doc\)\);/.test(src));
ok('a book keeps its contents list in Reader View', /_isBookDoc\(doc\) \? 'script,style,link,noscript' : _READER_VIEW_STRIP/.test(src));
ok('a book opens in Reader View, and the e-reader is set up before anything measures it', /var _wantReader = _readerViewOn \|\| _readerAuto\(\) \|\| _bookDoc;/.test(src) && /if \(_bookDoc && _readerViewOn\) \{\n\s*try \{ _bookOn = _bookAttach\(frame\);/.test(src));
ok('Zimi\'s header is held away for a book, known from its address before it loads', /var _bookLoading = _bookUrl\(url\);\n\s*_bookChrome\(_bookLoading\);/.test(src) && /if \(on !== _chromeHeld\) _chromeImmersive\(on\);/.test(src));
ok('no jump-to-top button and no capture passes on a book', /if \(!_frameIsOurOwnPage\(frame\) && !_bookDoc && !_wikiOn\) try \{/.test(src) && /if \(_frameIsOurOwnPage\(frame\) \|\| _bookDoc\) return;/.test(src));
ok('opening a book lays nothing out early: its text is counted, not measured', /return \(main === doc\.body \? main\.textContent :/.test(src) && /if \(!_isBookDoc\(doc\)\) _readerBindLightbox\(shell, doc\);/.test(src));
ok('pages are one chapter at a time, and a long run is cut again', /html\.zb-paged \.zb-sec:not\(\.zb-cur\)\{display:none\}/.test(src) && /var _BOOK_SECTION_CHARS = \d+;/.test(src));
ok('the place is a character of the book, kept with the share read, as a position in Saved', /Saved\.setPosition\(\{ kind: 'book', app: 'books', zim: zim, path: path,[\s\S]{0,400}\{ f: Math\.round\(f \* _BOOK_PLACE_SCALE\) \/ _BOOK_PLACE_SCALE, c: c \}\);/.test(src) && /var _BOOK_PLACE_SCALE = 1e5;/.test(src) && /var placed = Saved\.position\(\{ zim: zim, path: path \}\), place = \(placed \|\| \{\}\)\.where;/.test(src));
ok('a tap just after a swipe is the swipe\'s, by a named window', /Date\.now\(\) - swipedAt < _BOOK_SWIPE_TAP_MS\) return;/.test(src) && /var _BOOK_SWIPE_TAP_MS = \d+;/.test(src));
// A book that never loads (an error, the 15 s stall) gives Zimi's header back:
// it was held away before the load for a book header that never came.
ok('a book that fails to load gives Zimi\'s header back', /frame\.onerror = function\(\) \{[^}]*if \(_bookReading\) _bookChrome\(false\);/.test(src) &&
  /_readerTimeout = setTimeout\(function\(\) \{[\s\S]{0,300}if \(_bookReading\) _bookChrome\(false\);[\s\S]{0,80}\}, 15000\);/.test(src));
ok('a book view that fails says so, and the plain page stays', /try \{ _bookOn = _bookAttach\(frame\); \} catch \(e\) \{ console\.warn\('Book reader:', e\); _showToast\(t\('books_view_unavailable'\)\); \}/.test(src));
ok('a link to a place in the book wins over the remembered place', /if \(tgtSec\) \{[\s\S]{0,300}\} else if \(place && \(place\.c > 0 \|\| place\.f > 0\)\)/.test(src));
ok('a right-to-left book turns the other way', /if \(rel < _BOOK_EDGE\) \{ turn\(bookRtl \? 1 : -1\); return; \}/.test(src));
ok('chapters: the heading level with the most different headings', /hs\._n = Object\.keys\(distinct\)\.length;/.test(src));
ok('the chapter arrows point the way the interface reads', /\(uiRtl \? pv : nx\)\.firstChild\.style\.transform = 'scaleX\(-1\)';/.test(src));
ok('places are capped per app, the oldest dropped first (a Zimipedia article never pushes out a book)', /var POS_PER_APP = \d+;/.test(src) && /capPlaces\(s\.positions\);\n\s*commit\(false, true, 'pos'\);/.test(src));

// A layout that throws is taken back off the page, and the document is not
// marked done, so the next load of it tries again.
{
  const classes = new Set(['zimi', 'zb-book', 'zb-paged']);
  const removed = [];
  const doc = {
    documentElement: { classList: { remove: (...c) => c.forEach(x => classes.delete(x)) } },
    querySelectorAll: sel => (/#zb-style/.test(sel) && /\.zb-bar/.test(sel) && /\.zb-sheet/.test(sel)
      ? ['style', 'head', 'foot'].map(n => ({ remove: () => removed.push(n) })) : [])
  };
  const actx = { Array };
  vm.createContext(actx);
  vm.runInContext([
    extract(src, /function _bookAttach\(frame\) \{[\s\S]*?\n\}/, '_bookAttach'),
    extract(src, /function _bookUndo\(doc\) \{[\s\S]*?\n\}/, '_bookUndo'),
    'function _bookLay(frame) { if (frame.fail) throw new Error("no chapters"); return true; }',
  ].join('\n'), actx);
  let threw = false;
  try { actx._bookAttach({ contentDocument: doc, fail: true }); } catch (e) { threw = true; }
  ok('a book layout that throws is taken back off the page', threw && !classes.has('zb-book') && !classes.has('zb-paged') && classes.has('zimi') && removed.join() === 'style,head,foot');
  ok('and the document is not marked as a book', !doc.__zimiBook);
  ok('a layout that works marks it, once', actx._bookAttach({ contentDocument: doc }) === true && doc.__zimiBook === true && actx._bookAttach({ contentDocument: doc }) === false);
}

// ── the shell ───────────────────────────────────────────────────────────
ok('the tile is one line in the apps row, like the others', /function _booksTileHtml\(\) \{\n\s*return _appTileHtml\('books', t\('books'\), _BOOKS_SVG, _installedBookZims\(\)/.test(src) && /_APP_TILES = \{[^}\n]*\bbooks: _booksTileHtml \}/.test(src));
ok('an app like the others: switched per server and per account by its name', /var APP_NAMES = \[[^\]]*'books'\];/.test(src));
ok('it is the page Zimi owns, in the reader, at /#books', /_openHashApp\('books', replaceState, function\(\) \{ _booksOpen = true; return _BOOKS_PAGE \+ '#' \+ _booksStrings\(\); \}\)/.test(src) && /if \(location\.hash === '#books'\) \{ enterHome\(false\); openBooks\(true\); return; \}/.test(src));
ok('the shell hands the page its strings and the shelves\' names', /_appStrings\('books', \['books_shelf'/.test(src) && /lcc\[c\] = t\('books_lcc_' \+ c\);/.test(src));
ok('typing and Enter in the box search inside the page', /\(_isWikiPage\(\) \? _wikiSearch : _booksSearch\)\(val\)/.test(src) && /if \(_isBooksPage\(\)\) \{ _booksSearch\(q\.value\.trim\(\)\); return; \}/.test(src) && /_appFrameCall\('booksSearch', val\)/.test(src));
ok('the box says what it is for', /if \(_isBooksPage\(\)\) return t\('books_search_placeholder'\);/.test(src));
ok('an app page: no reading controls, and the arrow asks the page first', /function _isAppPage\(\) \{\n\s*return [^\n]*_isBooksPage\(\);/.test(src));
ok('Back from a book returns to Bookshelf', /s\.mode === 'reader' && s\.books\) \{\n\s*if \(!_appFrameRoute\(_booksOpen, ''\)\) openBooks\(true\);/.test(src) && /\|\| app\.books\);/.test(src));
ok('the catalog door is allowed', /_APP_CATEGORY_KEYS = \[[^\]]*'gutenberg'\]/.test(src) && /books: 'gutenberg' \}/.test(src));
ok('its background work has a name in Manage', /books: 'bg_books'/.test(src));

const need = ['books', 'books_view_unavailable', 'books_search_placeholder', 'books_prev_chapter', 'books_next_chapter', 'books_contents', 'books_settings',
  'books_line_spacing', 'books_margins', 'books_layout', 'books_mode_scroll', 'books_mode_pages', 'books_left_one', 'books_left_other',
  'books_left_none', 'books_position', 'app_empty_books', 'apps_count_books_one', 'apps_count_books_other', 'bg_books', 'books_bce', 'books_bce_ce'];
const pageKeys = (extract(src, /_appStrings\('books', \[[\s\S]*?\]/, 'keys').match(/'books_[a-z_]+'/g) || []).map(k => k.slice(1, -1));
const lcc = JSON.parse(extract(src, /var _BOOKS_LCC = \[[\s\S]*?\];/, 'lcc').replace(/^var _BOOKS_LCC = /, '').replace(/;$/, '').replace(/'/g, '"'));
for (const lang of fs.readdirSync(path.join(root, 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(root, 'i18n', lang), 'utf8'));
  const missing = need.concat(pageKeys).concat(lcc.map(c => 'books_lcc_' + c)).filter(k => !d[k]);
  if (missing.length) ok('every string in ' + lang, false, missing.join(', '));
  if (d.books !== 'Bookshelf') ok('it is called Bookshelf in ' + lang, false, d.books);
  if (!/\{from\}/.test(d.books_bce) || !/\{to\}/.test(d.books_bce) || !/\{from\}[\s\S]*\{to\}/.test(d.books_bce_ce) || !/\{name\}/.test(d.books_more_by)) ok('the placeholders survive in ' + lang, false);
  if (Object.keys(d).filter(k => /^books|_books/.test(k)).some(k => /\u2014/.test(d[k]))) ok('no em dash in ' + lang, false);
}
ok('the strings are in all ten languages', fs.readdirSync(path.join(root, 'i18n')).length === 10);

console.log(failures ? '\n' + failures + ' FAILED' : '\nall books-page checks passed');
const css = fs.readFileSync(path.join(root, 'apps.css'), 'utf8');
ok('a chosen small chip (a sort) reads as chosen: .chip.on comes after .chip.tag', css.indexOf('.chip.on {') > css.indexOf('.chip.tag {'));
process.exit(failures ? 1 : 0);
