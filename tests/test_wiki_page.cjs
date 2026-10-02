// Zimipedia: the page's own logic (pills, Today's front door, search
// merging) run from the page itself, and the shell's surface (the tile, the
// address, the box, Back). Eric, 2026-09-24: "a wiki app that like has pills
// for all the individual wikis but builds a unified one and has the today
// page suggesting articles or whatever and good scoped search and display
// views". Eric, 2026-09-27, on 1.11's Today: "just a homepage of mostly
// reused discover content?": it is a front door now (the day's article,
// where you were, your trails); the reading is Zimipedia's reader's.
//
// Run: node tests/test_wiki_page.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const page = fs.readFileSync(path.join(root, 'wiki.html'), 'utf8').replace(/\r\n/g, '\n');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const reader = fs.readFileSync(path.join(root, 'wiki-reader.js'), 'utf8').replace(/\r\n/g, '\n');
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

// ── the page's pure parts ───────────────────────────────────────────────
const ctx = {};
vm.createContext(ctx);
vm.runInContext([
  "var STR = { lang: 'en', front_as_of: 'As featured on {date}, when this copy was made', results_one: '{n} result', results_other: '{n} results', search_heading: '“{q}”' };",
  extract(page, /var TODAY_BATCH = [^\n]*\n/, 'TODAY_BATCH'),
  extract(page, /function dayStamp\(d\) \{[^\n]*\n/, 'dayStamp'),
  extract(page, /function pillLabels\(wikis\) \{[\s\S]*?\n\}/, 'pillLabels'),
  extract(page, /var RTL_LANGS = [^\n]*\n/, 'RTL_LANGS'),
  extract(page, /function dirOf\(code\) \{[^\n]*\n/, 'dirOf'),
  // One way to name a language in itself: the shell's, which the page asks for.
  extract(src, /function _langEndonym\(code, own, fallback\) \{[\s\S]*?\n\}/, '_langEndonym'),
  extract(page, /function inLanguage\(wikis, lang\) \{[^\n]*\n/, 'inLanguage'),
  extract(page, /function heroOf\(wikis\) \{[\s\S]*?\n\}/, 'heroOf'),
  extract(page, /function todayPlan\(wikis\) \{[\s\S]*?\n\}/, 'todayPlan'),
  extract(page, /function batches\(list, n\) \{[^\n]*\n/, 'batches'),
  extract(page, /function yearNum\(y\) \{[\s\S]*?\n\}/, 'yearNum'),
  extract(page, /function mergeOtd\(lists, max\) \{[\s\S]*?\n\}/, 'mergeOtd'),
  extract(page, /function asOf\(date, lang\) \{[\s\S]*?\n\}/, 'asOf'),
  extract(page, /function boldTitle\(title, text, sep\) \{[\s\S]*?\n\}/, 'boldTitle'),
  extract(page, /function continuedIn\(places, lang, by\) \{[\s\S]*?\n\}/, 'continuedIn'),
  extract(page, /function trailsIn\(kept, lang, by\) \{[\s\S]*?\n\}/, 'trailsIn'),
  extract(page, /function ago\(ts, now\) \{[\s\S]*?\n\}/, 'ago'),
  extract(page, /function plural\(n\) \{[\s\S]*?\n\}/, 'plural'),
  extract(page, /function heading\(q\) \{[^\n]*\n/, 'heading'),
  "function esc(x) { return String(x).replace(/</g, '&lt;'); }",
  extract(page, /function mergeResults\(first, second\) \{[\s\S]*?\n\}/, 'mergeResults'),
  extract(page, /function stripTags\(s\) \{[^\n]*\n/, 'stripTags'),
  extract(page, /function cleanBlurb\(s\) \{[\s\S]*?\n\}/, 'cleanBlurb'),
].join('\n'), ctx);

const W = (name, project, language, title) => ({ name, project, language, title: title || name, project_title: project ? project[0].toUpperCase() + project.slice(1) : '' });
const all = [
  W('wikipedia_ar', 'wikipedia', 'ar', 'ويكيبيديا'),
  W('wikipedia', 'wikipedia', 'en', 'Wikipedia'),
  W('wikipedia_en_100', 'wikipedia', 'en', 'Wikipedia 100'),
  W('wiktionary', 'wiktionary', 'en', 'Wiktionary'),
  W('wikiquote', 'wikiquote', 'en', 'Wikiquote'),
  W('wikivoyage_en_europe', 'wikivoyage', 'en', 'Wikivoyage - Europe'),
  W('wikem', '', 'en', 'WikEM'),
];

const labels = ctx.pillLabels(all);
ok('a pill names its project', labels.wikipedia_ar === 'Wikipedia' && labels.wiktionary === 'Wiktionary');
ok('two wikis of one project in one language are told apart by their titles', labels.wikipedia === 'Wikipedia' && labels.wikipedia_en_100 === 'Wikipedia 100');
ok('a wiki beyond Wikimedia is named by its title', labels.wikem === 'WikEM');

ok('the day is the browser\'s own date', ctx.dayStamp(new Date(2026, 8, 5)) === '20260905');

const en = ctx.inLanguage(all, 'en');
ok('Today is one language: its wikis only', en.length === 6 && en.every(w => w.language === 'en') && ctx.inLanguage(all, 'ar').length === 1);
en[0].entries = 6000000; en[1].entries = 100;
ok('the day\'s article: the biggest Wikipedia of the language', ctx.heroOf(en) === 'wikipedia');
ok('with no Wikipedia, another wiki gives it', ctx.heroOf([all[3], all[4]]) === 'wiktionary');
ok('a full build before a mini, however many more entries the mini has', ctx.heroOf([Object.assign({}, en[0], { flavour: 'mini' }), en[1]]) === 'wikipedia_en_100');
ok('with no wiki chosen: nothing asked at all', ctx.heroOf([]) === null);
let plan = ctx.todayPlan(en);
ok('Today: the day\'s article leads; every other wiki has a card', plan.hero === 'wikipedia' && plan.cards.length === en.length - 1 && !plan.cards.includes('wikipedia'));
ok('On this day asks every Wikipedia of the language, and every front page is read', plan.otd.join() === 'wikipedia,wikipedia_en_100' && plan.front.length === en.length);
ok('the same plan all day (no clock inside)', JSON.stringify(ctx.todayPlan(en)) === JSON.stringify(plan));
plan = ctx.todayPlan([all[3], all[4]]);
ok('with no Wikipedia: another wiki leads and no On this day is asked', plan.hero === 'wiktionary' && plan.otd.length === 0 && plan.cards.join() === 'wikiquote');
plan = ctx.todayPlan([]);
ok('with no wiki chosen: nothing planned', plan.hero === null && plan.otd.length === 0 && plan.cards.length === 0);
ok('a fact names its article in bold, in place when the sentence names it', ctx.boldTitle('Water', 'Water is wet.', ': ') === '<b>Water</b> is wet.' && ctx.boldTitle('Chênedollé', 'It merged in 2016.', ': ') === '<bdi><b>Chênedollé</b></bdi>: It merged in 2016.' && ctx.boldTitle('Air', 'Clean <air>', ' ') === 'Clean &lt;<b>air</b>>');
ok('a front page is dated in the interface\'s words', ctx.asOf('2026-07-06', 'en') === 'As featured on July 6, 2026, when this copy was made' && ctx.asOf('', 'en') === '');
ok('the wikis are asked for a few at a time', JSON.stringify(ctx.batches([1, 2, 3, 4, 5], ctx.TODAY_BATCH)) === '[[1,2,3,4],[5]]');
ok('years sort as numbers, whatever the language writes after them', ctx.yearNum('1066年') === 1066 && ctx.yearNum('44 BC') === -44 && ctx.yearNum('275') === 275);
const E = (y, p) => ({ event_year: y, path: p, title: p, event_text: p });
let merged = ctx.mergeOtd([{ zim: 'en', events: [E('1066', 'a'), E('1900', 'b'), E('2001', 'c')] }], 2);
ok('one Wikipedia keeps its own page\'s order', merged.map(x => x.e.path).join() === 'a,b');
merged = ctx.mergeOtd([{ zim: 'en', events: [E('1900', 'a'), E('1950', 'b'), E('1990', 'c')] }, { zim: 'en100', events: [E('1066', 'x'), E('1900', 'a')] }, { zim: 'enx', events: [] }], 4);
ok('two Wikipedias of a language: each is heard, an article once, then in the order of the years', merged.map(x => x.zim + x.e.path).join() === 'en100x,ena,enb,enc');
ok('none with events: nothing to show', ctx.mergeOtd([{ zim: 'x', events: [] }], 6).length === 0);
const by = {}; all.forEach(w => { by[w.name] = w; });
const places = [
  { zim: 'wikipedia', path: 'A', where: { s: 'x', f: 0.4 } },
  { zim: 'wikipedia_ar', path: 'B', where: { s: 'y', f: 0.2 } },
  { zim: 'gone', path: 'C', where: { f: 0.5 } },
  { zim: 'wikipedia', path: 'D', where: {} },
];
ok('Continue reading: the language shown, part read, its wikis only', ctx.continuedIn(places, 'en', by).map(p => p.path).join() === 'A');
const kept = [
  { ts: 3, items: [{ zim: 'wikipedia', path: 'A' }, { zim: 'wikipedia', path: 'B' }] },
  { ts: 2, items: [{ zim: 'wikipedia_ar', path: 'C' }, { zim: 'wikipedia_ar', path: 'D' }] },
  { ts: 1, items: [{ zim: 'wikipedia', path: 'E' }] },
];
ok('recent trails: those that started in the language shown, of two steps or more', ctx.trailsIn(kept, 'en', by).length === 1 && ctx.trailsIn(kept, 'ar', by)[0].ts === 2);
ok('how long ago, in the interface\'s words', ctx.ago(0, 2 * 3600 * 1000 + 5) === '2 hr. ago' && ctx.ago(0, 3 * 86400 * 1000) === '3 days ago');
ok('a language is named in itself', ctx._langEndonym('fr', '', 'French') === 'Français' && ctx._langEndonym('he', undefined, 'Hebrew') === 'עברית');
ok('a language the browser cannot name in itself takes the interface\'s name, capitalised', ctx._langEndonym('zz', '', 'zed') === 'Zed');
ok('the server\'s name comes first: Yiddish is named in itself even where the browser cannot', ctx._langEndonym('yi', 'ייִדיש', 'yiddish') === 'ייִדיש');
{
  // A browser that cannot name Yiddish in itself answers in English.
  const en = { Intl: { DisplayNames: function() { this.of = c => ({ yi: 'Yiddish' })[c] || c; } } };
  vm.createContext(en);
  vm.runInContext(extract(src, /function _langEndonym\(code, own, fallback\) \{[\s\S]*?\n\}/, '_langEndonym'), en);
  ok('a browser answering in English is not taken for the language\'s own name', en._langEndonym('yi', '', 'x') === 'X' && en._langEndonym('yi', 'ייִדיש') === 'ייִדיש');
}
ok('the page names languages with the shell\'s, given the server\'s name (/wiki/home)', /function endonym\(code, fallback\) \{\n\s*var own = \(_langs\.filter\(function\(l\) \{ return l\.code === code; \}\)\[0\] \|\| \{\}\)\.name;\n\s*try \{ return window\.parent\._langEndonym\(code, own, fallback\); \}/.test(page) && !/ENDONYMS|DisplayNames/.test(page));
ok('and so does Zimipedia\'s reader', /_langEndonym\(l\.lang, l\.name\)/.test(reader) && !/DisplayNames/.test(reader));
ok('the page is laid out in the direction of the language it shows', ctx.dirOf('he') === 'rtl' && ctx.dirOf('yi') === 'rtl' && ctx.dirOf('ar') === 'rtl' && ctx.dirOf('fr-CA') === 'ltr' && ctx.dirOf('en') === 'ltr');
ok('a count in the interface\'s plural forms', ctx.plural(1) === '1 result' && ctx.plural(3) === '3 results');
vm.runInContext("STR = { lang: 'ru', results_one: '{n} результат', results_few: '{n} результата', results_many: '{n} результатов', results_other: '{n} результата' };", ctx);
ok('Russian has three forms, and the page uses them', ctx.plural(1) === '1 результат' && ctx.plural(3) === '3 результата' && ctx.plural(5) === '5 результатов' && ctx.plural(21) === '21 результат');
vm.runInContext("STR = { lang: 'ar', results_zero: 'لا نتائج', results_one: 'نتيجة واحدة', results_two: 'نتيجتان', results_few: '{n} نتائج', results_many: '{n} نتيجة', results_other: '{n} نتيجة', search_heading: '«{q}»' };", ctx);
ok('Arabic has six, and the page uses them', ctx.plural(0) === 'لا نتائج' && ctx.plural(2) === 'نتيجتان' && ctx.plural(3) === '3 نتائج' && ctx.plural(11) === '11 نتيجة');
ok('a search is headed in the interface\'s own quotation marks', ctx.heading('ماء') === '«<bdi>ماء</bdi>»' && ctx.heading('<x>') === '«<bdi>&lt;x></bdi>»');

const mergedR = ctx.mergeResults([{ zim: 'a', path: '1' }, { zim: 'b', path: '1' }], [{ zim: 'b', path: '1' }, { zim: 'a', path: '2' }]);
ok('search: the quick title matches first, then the full text\'s, each article once', mergedR.map(r => r.zim + r.path).join() === 'a1,b1,a2');

ok('a lead loses its footnote marks and stray spaces', ctx.cleanBlurb('Antarctica ( / æ n ˈ t ɑːr k t ɪ k ə / ) [ note 1 ] is Earth\'s southernmost [1] continent .') === 'Antarctica (/ æ n ˈ t ɑːr k t ɪ k ə /) is Earth\'s southernmost continent.');
ok('a quote keeps one pair of quotation marks', ctx.cleanBlurb('“"Our research on ice cores." ”') === '“Our research on ice cores.”');

// ── the page's wiring ───────────────────────────────────────────────────
ok('the page takes the shared sheet and script, which hold both themes', /<!--@apps\.css@-->/.test(page) && /<!--@apps\.js@-->/.test(page) && !/prefers-color-scheme/.test(page));
ok('pills: all on until one is tapped, the first tap narrows, the last one off is all again', /function pill\(name\) \{\s*var i = _sel\.indexOf\(name\);\s*if \(i >= 0\) _sel\.splice\(i, 1\); else _sel\.push\(name\);\s*scopeChanged\(\);/.test(page) && /function scoped\(\) \{ return _sel\.length \? langWikis\(\)\.filter/.test(page));
ok('a change of pills redraws what is shown: the search again, or Today', /function scopeChanged\(\) \{\s*renderPills\(\);\s*if \(_q\) wikiSearch\(_q\); else renderToday\(\);/.test(page));
ok('search asks /search scoped to the chosen wikis, quick first, the full text when the quick answer is partial', /'\/search\?q=' \+ encodeURIComponent\(_q\) \+ '&zim=' \+ encodeURIComponent\(zims\)/.test(page) && /get\(base \+ '&fast=1'\)/.test(page) && /if \(!d1\.partial\) return;\s*get\(base\)/.test(page));
ok('results carry their wiki, and its language when the search reaches every language', /function srcLine\(zim\)/.test(page) && /_everyLanguage && w\.language/.test(page));
ok('two views, cards and a list, remembered in this browser (and read safely)', /var VIEW_KEY = 'zimi_wiki_view';/.test(page) && /try \{ localStorage\.setItem\(VIEW_KEY, v\); \} catch \(e\) \{\}/.test(page) && /try \{ _view = localStorage\.getItem\(VIEW_KEY\)/.test(page));
ok('a day\'s picks are kept for the day, so a return is instant and no pick changes', /var TODAY_KEY = 'zimi_wiki_today';/.test(page) && /kept\.day === _day/.test(page));
ok('Today is a front page: the day\'s article, where you were, and the day of every wiki of the language',
  /var PARTS = \['picks', 'otd', 'extras', 'front'\];/.test(page) && /otdHtml\(evs\)/.test(page) && /dykHtml\(fz,/.test(page) && /potdHtml\(pz,/.test(page) && /fromPick\(_got\.picks\[z\]\)/.test(page) && /frontItems\(plan\.front\)/.test(page) && /section\('continue', STR\.continue/.test(page));
ok('a part with nothing to show is left out, not left waiting', /if \(evs\.length\) fill\('otd', otdHtml\(evs\)\); else drop\('otd'\);/.test(page) && /else if \(fz === null\) drop\('dyk'\)/.test(page) && /else if \(pz === null\) drop\('potd'\)/.test(page));
ok('what a front page featured is dated as the copy\'s, never as today\'s', /asOf\(dates\.sort\(\)\[0\], STR\.lang\)/.test(page));
ok('where you were is Saved\'s, Zimipedia\'s own, and a change anywhere redraws it', /S\.continued\(\{ app: 'wiki' \}\)/.test(page) && /window\.__saved = function\(\) \{ if \(!_q\) drawYours\(\); \};/.test(page));
ok('a recent trail goes back in with the trail as it was', /window\.parent\._wikiTrailResume\(_trailsShown\[\+k\]\.items\)/.test(page) && /function keptTrails\(\) \{ try \{ return window\.parent\._wikiTrailsKept\(\) \|\| \[\]; \}/.test(page));
ok('the trails\' keys are the shell\'s (SK), written nowhere else', /WIKI_TRAIL: 'zimi_wiki_trail',\n\s*WIKI_TRAILS: 'zimi_wiki_trails',/.test(src) && src.split("'zimi_wiki_trail").length === 3 &&
  !/zimi_wiki_trail/.test(page) && !/zimi_wiki_trail/.test(reader) && /_getSessionJSON\(SK\.WIKI_TRAIL, \[\]\)/.test(reader));
ok('a mini is the server\'s word for it (its flavour), not the file name read again', /mini = info\.flavour === 'mini';/.test(reader) && !/_wikiIsMini|_mini\(\?:/.test(reader));
ok('only answers with something in them are kept in this browser', /if \(!keep\) return;/.test(page) && /if \(hasContent\(_got\[p\]\[n\]\)\) store\[p\]\[n\]/.test(page));
ok('a failed ask is asked again on the next view', /return _failed\[z\] \|\| !known\('picks', z\)/.test(page));
ok('the language is remembered in this browser, and the whole page follows it', /var LANG_KEY = 'zimi_wiki_lang';/.test(page) && /try \{ localStorage\.setItem\(LANG_KEY, code\); \} catch \(e\) \{\}/.test(page) && /_lang = code; _sel = \[\];/.test(page));
ok('the page asks for the language it wants; the server settles it', /'\/wiki\/home\?day=' \+ _day \+ '&lang=' \+ encodeURIComponent\(storedLang\(\) \|\| STR\.lang \|\| 'en'\)/.test(page) && /_lang = d\.lang \|\| '';/.test(page));
ok('search reaches the language chosen, and every language when asked', /\(_everyLanguage \? _wikis : scoped\(\)\)/.test(page) && /STR\.search_all_languages/.test(page));
ok('the page takes the direction of the language shown; the interface\'s own words keep the interface\'s', /document\.documentElement\.dir = dirOf\(code\);/.test(page) && /_lang = code; _sel = \[\];\s*applyDir\(\);/.test(page) && /<h2 class="serif"' \+ ui\(\) \+ '>/.test(page) && /<span class="kick"' \+ ui\(\) \+ '>'/.test(page) && /'<span class="more-l"' \+ ui\(\) \+ '>'/.test(page) && /uiEl\(document\.getElementById\('n'\)\)/.test(page));
ok('the way onward points the way its own words run', /\.chev:dir\(ltr\)::before \{ content: '\\203A'; \}/.test(page) && /\.chev:dir\(rtl\)::before \{ content: '\\2039'; \}/.test(page));
ok('a page left open past midnight moves to the new day', /document\.addEventListener\('visibilitychange'/.test(page) && /function checkDay\(\) \{\s*var d = dayStamp\(new Date\(\)\);\s*if \(d === _day\) return;/.test(page));
ok('the wikis failing to load is not "no wiki installed": it says so, with a retry', /if \(!r\.ok\) throw new Error/.test(page) && /\.catch\(function\(\) \{ showLoadFailed\(\); \}\)/.test(page) && /STR\.load_failed/.test(page));
ok('a failed search is not "nothing matches": it says so, with a retry', /if \(!d1\) \{ searchFailed\(\); return; \}/.test(page) && /STR\.search_failed/.test(page));
ok('a wiki\'s words carry its language', /lang="' \+ esc\(w\.language\) \+ '" dir="auto"/.test(page));
ok('an article opens in Zimi\'s reader, the app behind it; a modified click keeps the link', /closest\('a\[data-zim\]\[data-path\]'\)/.test(page) && /e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.button === 1/.test(page) && /tell\(\{ zimi: 'open', zim: a\.getAttribute\('data-zim'\), path: a\.getAttribute\('data-path'\) \}\)/.test(page));
ok('every card is a real link to the article', /function linkAttrs\(zim, path\) \{ return ' href="' \+ esc\(zpath\(zim, path\)\) \+ '" data-zim="'/.test(page));
ok('the header\'s arrow steps a search back to Today; at Today the shell leaves', /window\.__back = function\(\) \{ if \(_q\) \{ showToday\(\); return true; \} return false; \};/.test(page) && /window\.__top = function\(\) \{ return !_q; \};/.test(page));
ok('the dice land on an article of a chosen wiki', /window\.__random = function\(\) \{\s*var ws = scoped\(\);/.test(page));
ok('the empty page is a door to the Wikipedia category', /category: 'wikipedia'/.test(page));

// ── the shell ───────────────────────────────────────────────────────────
ok('the tile is one line in the apps row, like the others', /function _wikiTileHtml\(\) \{\n\s*return _appTileHtml\('wiki', t\('wiki'\), _WIKI_SVG, _installedWikiZims\(\)/.test(src) && /_APP_TILES = \{[^}\n]*\bwiki: _wikiTileHtml,/.test(src));
ok('an app like the others: switched per server and per account by its name', /var APP_NAMES = \['maps', 'tube', 'exchange', 'reddot', 'wiki', 'books'[^\]]*\];/.test(src));
ok('it is the page Zimi owns, in the reader, at /#wiki', /_openHashApp\('wiki', replaceState, function\(\) \{ _wikiOpen = true; return _WIKI_PAGE \+ '#' \+ _wikiStrings\(\); \}\)/.test(src) && /history\.pushState\(_stampFrom\(st\), '', '\/#' \+ app\)/.test(src) && /if \(location\.hash === '#wiki'\) \{ enterHome\(false\); openWiki\(true\); return; \}/.test(src));
ok('the shell hands the page its strings and the names of its languages', /_appStrings\('wiki', \['wiki_all'/.test(src) && /langs\[c\] = _langDisplayName\(c\) \|\| c;/.test(src));
ok('typing and Enter in the box search inside the page', /if \(_isWikiPage\(\) \|\| _isBooksPage\(\)\) \{\n\s*hideSuggest\(\);\n\s*suggestTimer = setTimeout\(function\(\) \{ \(_isWikiPage\(\) \? _wikiSearch : _booksSearch\)\(val\); \}, 250\);/.test(src) && /if \(_isWikiPage\(\)\) \{ _wikiSearch\(q\.value\.trim\(\)\); return; \}/.test(src) && /_appFrameCall\('wikiSearch', val\)/.test(src) && /win\[fn\]\(val\)/.test(src));
ok('the breadcrumb is Zimipedia and the box says what it is for', /var hashApp = _isWikiPage\(\) \? 'wiki' : /.test(src) && /bcIcon\.title = t\(hashApp\)/.test(src) && /if \(_isWikiPage\(\)\) return t\('wiki_search_placeholder'\);/.test(src));
ok('an app page: no reading controls, and the arrow asks the page first', /function _isAppPage\(\) \{\n\s*return [^\n]*_isWikiPage\(\)[^\n]*;/.test(src));
ok('Back from an article returns to Zimipedia', /s\.mode === 'reader' && s\.wiki\) \{\n\s*if \(!_appFrameRoute\(_wikiOpen, ''\)\) openWiki\(true\);/.test(src) && /\|\| app\.wiki \|\| app\.books[ )|]/.test(src));
ok('the icon in the breadcrumb goes to its front page', /_wikiOpen \? \['wiki', 'q', '\/#wiki'\]/.test(src));
ok('the catalog door is allowed', /_APP_CATEGORY_KEYS = \[[^\]]*'wikipedia'[^\]]*\]/.test(src) && /wiki: 'wikipedia'[,}]/.test(src));

// ── the shell's language menu on a wiki's article ─────────────────────────
// It needs the languages only: not the topic strip, the Simple level and the
// mini's full build that Zimipedia's reader shows (the whole wiki.article,
// under the library lock), and nothing at all when the chooser is hidden.
{
  const asked = [];
  const sh = {
    fetch: url => { asked.push(url); return Promise.resolve({ ok: true, json: () => ({ languages: [{ lang: 'he' }] }) }); },
    SK: { HIDE_LANG_CHOOSER: 'zimi_hide_lang_chooser' }, flags: {},
    _getStorageFlag: k => !!sh.flags[k],
    _splitPathFragment: p => ({ base: p.split('#')[0] }),
    _wikiUrl: () => true, _articleUrl: (z, p) => '/w/' + z + '/' + p,
    frameDoc: {}, _readerViewOn: false, _renderLangDropdown: () => {},
    currentArticle: { zim: 'wikipedia', path: 'Water' }, _articleLangKey: '', _articleLangData: null,
  };
  sh.document = { getElementById: id => (id === 'reader-frame' ? { contentDocument: sh.frameDoc } : null) };
  vm.createContext(sh);
  vm.runInContext([
    extract(src, /var _wikiInfoKept = [^\n]*\n/, '_wikiInfoKept'),
    extract(src, /var _WIKI_INFO_KEPT = [^\n]*\n/, '_WIKI_INFO_KEPT'),
    extract(src, /function _wikiInfo\(zim, path, langsOnly\) \{[\s\S]*?\n\}/, '_wikiInfo'),
    extract(src, /function _prefetchArticleLangs\(loaded\) \{[\s\S]*?\n\}/, '_prefetchArticleLangs'),
  ].join('\n'), sh);
  sh.flags[sh.SK.HIDE_LANG_CHOOSER] = true;
  vm.runInContext('_prefetchArticleLangs(true)', sh);
  ok('a hidden language chooser asks nothing about a wiki\'s article', asked.length === 0, asked.join());
  delete sh.flags[sh.SK.HIDE_LANG_CHOOSER];
  vm.runInContext('_prefetchArticleLangs(true)', sh);
  ok('the plain reader asks for the languages only', asked.length === 1 && /\/wiki\/article\?zim=wikipedia&path=Water&only=languages$/.test(asked[0]), asked.join());
  // Laid out by Zimipedia's reader, which asks for the whole answer: one ask, shared.
  asked.length = 0;
  vm.runInContext("currentArticle = { zim: 'wikipedia', path: 'Ice' }; frameDoc.__zimiWiki = true; _readerViewOn = true; _prefetchArticleLangs(true); _wikiInfo('wikipedia', 'Ice')", sh);
  ok('an article in Zimipedia\'s reader is asked about once, whole', asked.length === 1 && !/only=/.test(asked[0]), asked.join());
  vm.runInContext("_wikiInfo('wikipedia', 'Ice', true)", sh);
  ok('the whole answer, once kept, serves the language menu too', asked.length === 1, asked.join());
  ok('the route rides the content bucket, like /snippet', /_CONTENT_PATHS = frozenset\(\("\/snippet", "\/wiki\/article"\)\)/.test(fs.readFileSync(path.join(root, '..', 'http.py'), 'utf8')));
}

const TODAY_KEYS = ['wiki_on_this_day', 'wiki_featured', 'wiki_word', 'wiki_quote', 'wiki_place', 'wiki_book', 'wiki_text', 'wiki_course', 'wiki_news', 'wiki_species', 'wiki_did_you_know', 'wiki_picture', 'wiki_front', 'wiki_front_as_of'];
ok('the shell hands the page Today\'s words', TODAY_KEYS.every(k => src.indexOf("'" + k + "'") >= 0));
for (const lang of fs.readdirSync(path.join(root, 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(root, 'i18n', lang), 'utf8'));
  if (d.wiki !== 'Zimipedia') ok('it is called Zimipedia in ' + lang, false);
  for (const k of ['wiki_search_placeholder', 'wiki_today', 'wiki_empty', 'app_empty_wiki', 'apps_count_wiki_other', 'wiki_search_heading', 'wiki_article', 'wiki_load_failed', 'wiki_search_failed', 'wiki_results_one', 'wiki_results_other', 'wiki_languages', 'wiki_read_more', 'wiki_search_all_languages', 'wiki_search_one_language', 'wiki_continue', 'wiki_trails']) if (!d[k]) ok(k + ' in ' + lang, false);
  for (const k of TODAY_KEYS) if (!d[k]) ok(k + ' in ' + lang, false);
}
process.exit(failures ? 1 : 0);
