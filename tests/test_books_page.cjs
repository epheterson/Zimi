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
vm.runInContext([
  extract(page, /var PLACES_KEY = [^\n]*\n/, 'PLACES_KEY'),
  extract(page, /var COVER_HUES = [^\n]*\n/, 'COVER_HUES'),
  extract(page, /function hash\(s\) \{[^\n]*\n/, 'hash'),
  extract(page, /function coverHue\(title\) \{[^\n]*\n/, 'coverHue'),
  extract(page, /function ltr\(s\) \{[^\n]*\n/, 'ltr'),
  extract(page, /function eraLabel\(from\) \{[\s\S]*?\n\}/, 'eraLabel'),
  extract(page, /function yearsLabel\(born, died\) \{[\s\S]*?\n\}/, 'yearsLabel'),
  extract(page, /function shelfName\(code\) \{[\s\S]*?\n\}/, 'shelfName'),
  extract(page, /function langName\(code\) \{[\s\S]*?\n\}/, 'langName'),
  extract(page, /function places\(\) \{[\s\S]*?\n\}/, 'places'),
  extract(page, /function placeOf\(b\) \{[\s\S]*?\n\}/, 'placeOf'),
  extract(page, /function noteOpened\(b\) \{[\s\S]*?\n\}/, 'noteOpened'),
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
ctx.noteOpened({ zim: 'gutenberg_la', path: 'Aeneidos.227', id: 227, title: 'Aeneidos', author: 'Virgil', cover: 'covers/227_cover_image.jpg' });
ok('a book opened but not yet read is not "in progress"', ctx.places().length === 0);
const led = JSON.parse(ctx.localStorage.getItem('zimi_book_places'));
led['gutenberg_la\nAeneidos.227'].f = 0.34;
led['gutenberg_he\nTales.5139'] = { f: 0.5, ts: 1, id: 5139 };
ctx.localStorage.setItem('zimi_book_places', JSON.stringify(led));
const p = ctx.places();
ok('Continue reading: the books you are in, the latest first, with what the shelf needs', p.length === 2 && p[0].id === 227 && p[0].title === 'Aeneidos' && p[0].zim === 'gutenberg_la' && p[1].path === 'Tales.5139');
ok('a book\'s place, found by its ZIM and page', ctx.placeOf({ zim: 'gutenberg_la', path: 'Aeneidos.227' }).f === 0.34 && ctx.placeOf({ zim: 'x', path: 'y' }) === null);
ctx.localStorage.setItem('zimi_book_places', '{not json');
ok('a broken record is no record, not a broken shelf', ctx.places().length === 0);

// ── the page's surface ───────────────────────────────────────────────────
ok('every view the shell steers: a step back, the home, the dice, the box', /window\.__back = back;/.test(page) && /window\.__home = function\(\)/.test(page) && /window\.__random = function\(\)/.test(page) && /window\.booksSearch = booksSearch;/.test(page));
ok('at the shelf the shell leaves; inside it the arrow steps back', /window\.__top = function\(\) \{ return _stack\.length <= 1; \};/.test(page));
ok('a cover is a real link, and a modified click keeps it for a new tab', /'<a class="bk" href="' \+ esc\(zpath\(b\.zim, b\.path\)\)/.test(page) && /e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.button === 1/.test(page));
ok('a missing picture becomes a cover set in type', /onerror="noCover\(this\)"/.test(page) && /function noCover\(img\)/.test(page));
ok('Read opens the book in Zimi\'s reader, noted first for Continue reading', /noteOpened\(b\);\n\s*tell\(\{ zimi: 'open', zim: b\.zim, path: b\.path \}\);/.test(page));
ok('the page and the reader keep places under one key', /var PLACES_KEY = 'zimi_book_places';/.test(page) && /BOOK_PLACES: 'zimi_book_places'/.test(src));
ok('the empty page is a door to the Books category', /category: 'gutenberg'/.test(page));
ok('eras and subjects arrive without a reload once the records are read', /if \(_home\.total && !_home\.details\) setTimeout\(refreshHome, /.test(page));

// ── the reader: a book opens in Reader View, keeps its place, steps by chapter
const rctx = { document: { documentElement: { getAttribute: () => 'ltr' } } };
vm.createContext(rctx);
vm.runInContext([
  extract(src, /function _bookAuthorName\(creator\) \{[\s\S]*?\n\}/, '_bookAuthorName'),
].join('\n'), rctx);
ok('a record\'s "Surname, Given, years" prints as a cover does', rctx._bookAuthorName('Ewald, Carl, 1856-1908') === 'Carl Ewald' && rctx._bookAuthorName('Virgil, 71 BCE-20 BCE') === 'Virgil' && rctx._bookAuthorName('') === '');
ok('a Gutenberg page is known by its own record', /function _isBookDoc\(doc\) \{\n\s*try \{ return !!doc\.querySelector\('link\[rel="dcterms\.isFormatOf"\]\[href\*="gutenberg\.org"\]'\);/.test(src));
ok('a book has no <main>: Reader View reads its body', /if \(!main && _isBookDoc\(doc\)\) main = doc\.body;/.test(src) && /return !!main && \(main !== doc\.body \|\| _isBookDoc\(doc\)\);/.test(src));
ok('a book keeps its contents list in Reader View', /_isBookDoc\(doc\) \? 'script,style,link,noscript' : _READER_VIEW_STRIP/.test(src));
ok('a book opens in Reader View, and the e-reader is set up before anything measures it', /var _wantReader = _readerViewOn \|\| _readerAuto\(\) \|\| _bookDoc;/.test(src) && /if \(_bookDoc && _readerViewOn\) \{\n\s*try \{ _bookOn = _bookAttach\(frame\);/.test(src));
ok('Zimi\'s header is held away for a book, known from its address before it loads', /var _bookLoading = _bookUrl\(url\);\n\s*_bookChrome\(_bookLoading\);/.test(src) && /if \(on !== _chromeHeld\) _chromeImmersive\(on\);/.test(src));
ok('no jump-to-top button and no capture passes on a book', /if \(!_frameIsOurOwnPage\(frame\) && !_bookDoc\) try \{/.test(src) && /if \(_frameIsOurOwnPage\(frame\) \|\| _bookDoc\) return;/.test(src));
ok('opening a book lays nothing out early: its text is counted, not measured', /return \(main === doc\.body \? main\.textContent :/.test(src) && /if \(!_isBookDoc\(doc\)\) _readerBindLightbox\(shell, doc\);/.test(src));
ok('pages are one chapter at a time, and a long run is cut again', /html\.zb-paged \.zb-sec:not\(\.zb-cur\)\{display:none\}/.test(src) && /var _BOOK_SECTION_CHARS = \d+;/.test(src));
ok('the place is a character of the book, kept with the share read', /all\[key\] = \{ f: Math\.round\(f \* 1e5\) \/ 1e5, c: c,/.test(src));
ok('a link to a place in the book wins over the remembered place', /if \(tgtSec\) \{[\s\S]{0,300}\} else if \(place && \(place\.c > 0 \|\| place\.f > 0\)\)/.test(src));
ok('a right-to-left book turns the other way', /if \(rel < _BOOK_EDGE\) \{ turn\(bookRtl \? 1 : -1\); return; \}/.test(src));
ok('chapters: the heading level with the most different headings', /hs\._n = Object\.keys\(distinct\)\.length;/.test(src));
ok('the chapter arrows point the way the interface reads', /\(uiRtl \? pv : nx\)\.firstChild\.style\.transform = 'scaleX\(-1\)';/.test(src));
ok('places are capped, the oldest dropped first', /var _BOOK_PLACES_MAX = \d+;/.test(src) && /keys\.slice\(0, keys\.length - _BOOK_PLACES_MAX\)/.test(src));

// ── the shell ───────────────────────────────────────────────────────────
ok('the tile is one line in the apps row, like the others', /function _booksTileHtml\(\) \{\n\s*return _appTileHtml\('books', t\('books'\), _BOOKS_SVG, _installedBookZims\(\)/.test(src) && /_appShown\('books'\) \? _booksTileHtml\(\) : ''/.test(src));
ok('an app like the others: switched per server and per account by its name', /var APP_NAMES = \[[^\]]*'books'\];/.test(src));
ok('it is the page Zimi owns, in the reader, at /#books', /_openHashApp\('books', replaceState, function\(\) \{ _booksOpen = true; return _BOOKS_PAGE \+ '#' \+ _booksStrings\(\); \}\)/.test(src) && /if \(location\.hash === '#books'\) \{ enterHome\(false\); openBooks\(true\); return; \}/.test(src));
ok('the shell hands the page its strings and the shelves\' names', /_appStrings\('books', \['books_shelf'/.test(src) && /lcc\[c\] = t\('books_lcc_' \+ c\);/.test(src));
ok('typing and Enter in the box search inside the page', /\(_isWikiPage\(\) \? _wikiSearch : _booksSearch\)\(val\)/.test(src) && /if \(_isBooksPage\(\)\) \{ _booksSearch\(q\.value\.trim\(\)\); return; \}/.test(src) && /_appFrameCall\('booksSearch', val\)/.test(src));
ok('the box says what it is for', /if \(_isBooksPage\(\)\) return t\('books_search_placeholder'\);/.test(src));
ok('an app page: no reading controls, and the arrow asks the page first', /function _isAppPage\(\) \{\n\s*return [^\n]*_isBooksPage\(\);/.test(src));
ok('Back from a book returns to Bookshelf', /s\.mode === 'reader' && s\.books\) \{\n\s*if \(!_appFrameRoute\(_booksOpen, ''\)\) openBooks\(true\);/.test(src) && /\|\| app\.books\);/.test(src));
ok('the catalog door is allowed', /_APP_CATEGORY_KEYS = \[[^\]]*'gutenberg'\]/.test(src) && /books: 'gutenberg' \}/.test(src));
ok('its background work has a name in Manage', /books: 'bg_books'/.test(src));

const need = ['books', 'books_search_placeholder', 'books_prev_chapter', 'books_next_chapter', 'books_contents', 'books_settings',
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
