// Zimipedia: the page's own logic (pills, Today's plan, search merging) run
// from the page itself, and the shell's surface (the tile, the address, the
// box, Back). Eric, 2026-09-24: "a wiki app that like has pills for all the
// individual wikis but builds a unified one and has the today page
// suggesting articles or whatever and good scoped search and display views".
//
// Run: node tests/test_wiki_page.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const page = fs.readFileSync(path.join(root, 'wiki.html'), 'utf8').replace(/\r\n/g, '\n');
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

// ── the page's pure parts ───────────────────────────────────────────────
const ctx = {};
vm.createContext(ctx);
vm.runInContext([
  extract(page, /var FEATURED_SLOTS = [^\n]*\n/, 'FEATURED_SLOTS'),
  extract(page, /var DAY_ROLES = [^\n]*\n/, 'DAY_ROLES'),
  extract(page, /function dayStamp\(d\) \{[^\n]*\n/, 'dayStamp'),
  extract(page, /function pillLabels\(wikis\) \{[\s\S]*?\n\}/, 'pillLabels'),
  extract(page, /function byLanguage\(list, lang\) \{[\s\S]*?\n\}/, 'byLanguage'),
  extract(page, /function preferred\(list, lang\) \{[^\n]*\n/, 'preferred'),
  extract(page, /function todayPlan\(wikis, day, lang\) \{[\s\S]*?\n\}/, 'todayPlan'),
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
ok('a pill names its project, and its language rides as a badge', labels.wikipedia_ar === 'Wikipedia' && labels.wiktionary === 'Wiktionary');
ok('two wikis of one project in one language are told apart by their titles', labels.wikipedia === 'Wikipedia' && labels.wikipedia_en_100 === 'Wikipedia 100');
ok('a wiki beyond Wikimedia is named by its title', labels.wikem === 'WikEM');

ok('the day is the browser\'s own date', ctx.dayStamp(new Date(2026, 8, 5)) === '20260905');

let plan = ctx.todayPlan(all, '20260925', 'en');
ok('On this day asks every Wikipedia, the interface\'s language first', plan.otd.map(s => s.zim).join() === 'wikipedia,wikipedia_en_100,wikipedia_ar' && /\/wiki\/onthisday\?zim=wikipedia&date=0925$/.test(plan.otd[0].url));
ok('the pictures come from the wikis without a section of their own, a day seed on each', plan.featured.length === 6 && plan.featured.every(s => /&thumb=1&require_thumb=1&seed=20260925-\d$/.test(s.url)) && !plan.featured.some(s => /wiktionary|wikiquote|wikivoyage/.test(s.zim)));
ok('each slot has its own seed, so one wiki gives different pictures', new Set(plan.featured.map(s => s.url)).size === 6);
ok('a word, a quote and a place when Wiktionary, Wikiquote and Wikivoyage are here', plan.days.map(d => d.role + ':' + d.zim).join() === 'word:wiktionary,quote:wikiquote,place:wikivoyage_en_europe');
ok('the same plan all day (a day seed, no clock inside)', JSON.stringify(ctx.todayPlan(all, '20260925', 'en')) === JSON.stringify(plan));

plan = ctx.todayPlan(all.filter(w => w.project === 'wikipedia'), '20260925', 'ar');
ok('with only Wikipedias: pictures and On this day, no word, quote or place', plan.days.length === 0 && plan.featured.length === 6 && plan.otd[0].zim === 'wikipedia_ar');
plan = ctx.todayPlan([all[3]], '20260925', 'en');
ok('with only a Wiktionary: the word, nothing asked of a wiki that is not here', plan.otd.length === 0 && plan.featured.length === 0 && plan.days.length === 1 && plan.days[0].role === 'word');
plan = ctx.todayPlan([], '20260925', 'en');
ok('with no wiki chosen: nothing asked at all', plan.otd.length === 0 && plan.featured.length === 0 && plan.days.length === 0);

const merged = ctx.mergeResults([{ zim: 'a', path: '1' }, { zim: 'b', path: '1' }], [{ zim: 'b', path: '1' }, { zim: 'a', path: '2' }]);
ok('search: the quick title matches first, then the full text\'s, each article once', merged.map(r => r.zim + r.path).join() === 'a1,b1,a2');

ok('a lead loses its footnote marks and stray spaces', ctx.cleanBlurb('Antarctica ( / æ n ˈ t ɑːr k t ɪ k ə / ) [ note 1 ] is Earth\'s southernmost [1] continent .') === 'Antarctica (/ æ n ˈ t ɑːr k t ɪ k ə /) is Earth\'s southernmost continent.');
ok('a quote keeps one pair of quotation marks', ctx.cleanBlurb('“"Our research on ice cores." ”') === '“Our research on ice cores.”');

// ── the page's wiring ───────────────────────────────────────────────────
ok('the page takes the shared sheet and script, which hold both themes', /<!--@apps\.css@-->/.test(page) && /<!--@apps\.js@-->/.test(page) && !/prefers-color-scheme/.test(page));
ok('pills: all on until one is tapped, the first tap narrows, the last one off is all again', /function pill\(name\) \{\s*var i = _sel\.indexOf\(name\);\s*if \(i >= 0\) _sel\.splice\(i, 1\); else _sel\.push\(name\);\s*scopeChanged\(\);/.test(page) && /function scoped\(\) \{ return _sel\.length \? _wikis\.filter/.test(page));
ok('a change of pills redraws what is shown: the search again, or Today', /function scopeChanged\(\) \{\s*renderPills\(\);\s*if \(_q\) wikiSearch\(_q\); else renderToday\(\);/.test(page));
ok('search asks /search scoped to the chosen wikis, quick first, the full text when the quick answer is partial', /'\/search\?q=' \+ encodeURIComponent\(_q\) \+ '&zim=' \+ encodeURIComponent\(zims\)/.test(page) && /get\(base \+ '&fast=1'\)/.test(page) && /if \(!d1\.partial\) return;\s*get\(base\)/.test(page));
ok('results carry their wiki and its language', /function srcLine\(zim\)/.test(page) && /badge\(w\)/.test(page));
ok('two views, cards and a list, remembered in this browser (and read safely)', /var VIEW_KEY = 'zimi_wiki_view';/.test(page) && /try \{ localStorage\.setItem\(VIEW_KEY, v\); \} catch \(e\) \{\}/.test(page) && /try \{ _view = localStorage\.getItem\(VIEW_KEY\)/.test(page));
ok('a day\'s picks are kept for the day, so a return is instant and no pick changes', /var TODAY_KEY = 'zimi_wiki_today';/.test(page) && /kept\.day === _day/.test(page));
ok('an article opens in Zimi\'s reader, the app behind it; a modified click keeps the link', /closest\('a\[data-zim\]\[data-path\]'\)/.test(page) && /e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.button === 1/.test(page) && /tell\(\{ zimi: 'open', zim: a\.getAttribute\('data-zim'\), path: a\.getAttribute\('data-path'\) \}\)/.test(page));
ok('every card is a real link to the article', /' href="' \+ href \+ '" data-zim="'/.test(page));
ok('the header\'s arrow steps a search back to Today; at Today the shell leaves', /window\.__back = function\(\) \{ if \(_q\) \{ showToday\(\); return true; \} return false; \};/.test(page) && /window\.__top = function\(\) \{ return !_q; \};/.test(page));
ok('the dice land on an article of a chosen wiki', /window\.__random = function\(\) \{\s*var ws = scoped\(\);/.test(page));
ok('the empty page is a door to the Wikipedia category', /category: 'wikipedia'/.test(page));

// ── the shell ───────────────────────────────────────────────────────────
ok('the tile is one line in the apps row, like the others', /function _wikiTileHtml\(\) \{\n\s*return _appTileHtml\('wiki', t\('wiki'\), _WIKI_SVG, _installedWikiZims\(\)/.test(src) && /_appShown\('wiki'\) \? _wikiTileHtml\(\) : ''/.test(src));
ok('an app like the others: switched per server and per account by its name', /var APP_NAMES = \['maps', 'tube', 'exchange', 'reddot', 'wiki'\];/.test(src));
ok('it is the page Zimi owns, in the reader, at /#wiki', /openReader\(_WIKI_PAGE \+ '#' \+ _wikiStrings\(\)\)/.test(src) && /if \(location\.hash === '#wiki'\) \{ enterHome\(false\); openWiki\(true\); return; \}/.test(src));
ok('the shell hands the page its strings and the names of its languages', /_appStrings\('wiki', \['wiki_all'/.test(src) && /langs\[c\] = _langDisplayName\(c\) \|\| c;/.test(src));
ok('typing and Enter in the box search inside the page', /if \(_isWikiPage\(\)\) \{\n\s*hideSuggest\(\);\n\s*suggestTimer = setTimeout\(function\(\) \{ _wikiSearch\(val\); \}, 250\);/.test(src) && /if \(_isWikiPage\(\)\) \{ _wikiSearch\(q\.value\.trim\(\)\); return; \}/.test(src) && /win\.wikiSearch\(val\)/.test(src));
ok('the breadcrumb is Zimipedia and the box says what it is for', /bcIcon\.title = t\('wiki'\)/.test(src) && /if \(_isWikiPage\(\)\) return t\('wiki_search_placeholder'\);/.test(src));
ok('an app page: no reading controls, and the arrow asks the page first', /function _isAppPage\(\) \{\n\s*return [^\n]*_isWikiPage\(\);/.test(src));
ok('Back from an article returns to Zimipedia', /s\.mode === 'reader' && s\.wiki\) \{\n\s*if \(!_appFrameRoute\(_wikiOpen, ''\)\) openWiki\(true\);/.test(src) && /\|\| app\.wiki\);/.test(src));
ok('the icon in the breadcrumb goes to its front page', /_wikiOpen \? \['wiki', 'q', '\/#wiki'\]/.test(src));
ok('the catalog door is allowed', /_APP_CATEGORY_KEYS = \[[^\]]*'wikipedia'\]/.test(src) && /wiki: 'wikipedia' \}/.test(src));

for (const lang of fs.readdirSync(path.join(root, 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(root, 'i18n', lang), 'utf8'));
  if (d.wiki !== 'Zimipedia') ok('it is called Zimipedia in ' + lang, false);
  for (const k of ['wiki_search_placeholder', 'wiki_today', 'wiki_on_this_day', 'wiki_empty', 'app_empty_wiki', 'apps_count_wiki_other']) if (!d[k]) ok(k + ' in ' + lang, false);
}
process.exit(failures ? 1 : 0);
