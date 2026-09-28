// What a search operator did, as a chip, and the "?" examples (#94).
//
// Eric, 2026-09-27, of the one-line syntax hint the operators first shipped
// with: "the search left a weird hint in catalog view and nothing in main
// search view it didn't read well probably wouldn't translate well the -Ted
// thing. Hints are nice but didn't like that as is". So each operator shows
// as a chip in plain words, in every language, and its × searches again
// without it; a "?" beside the box lists examples written per language.
//
// Run: node tests/test_search_chips.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi');
const src = require('./app_source.cjs')();
const I18N_DIR = path.join(root, 'static', 'i18n');
const LANGS = fs.readdirSync(I18N_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
const i18n = Object.fromEntries(LANGS.map(l => [l, JSON.parse(fs.readFileSync(path.join(I18N_DIR, l + '.json'), 'utf8'))]));

let failures = 0;
const check = (ok, label) => { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Pull a top-level declaration out of app.js by its first line: a one-line
// one ends there, a block one at its closing brace in column 0.
function grab(head) {
  const i = src.indexOf('\n' + head);
  if (i < 0) throw new Error('not found: ' + head);
  const line = src.slice(i + 1, src.indexOf('\n', i + 1));
  if (/;\s*(\/\/.*)?$/.test(line) && !/[{[(]\s*$/.test(line)) return line + '\n';
  const end = src.indexOf('\n}', i + 1);
  const close = src.slice(end + 1, src.indexOf('\n', end + 1));
  return src.slice(i + 1, end + 1 + close.length) + '\n';
}

const sandbox = {
  console, Intl,
  // app.js escapes through the DOM; the same five characters here.
  esc: s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  escAttr: s => sandbox.esc(s),
};
vm.createContext(sandbox);
const decls = [
  'let _i18n = ', 'let _i18nFallback = ', 'let _currentLang = ', 'function t(', 'function tH(',
  'var _langDisplayCache = ', 'var _langDisplayCacheLang = ', 'var _SPECIAL_LANG = ', 'var _LANG3_NAMES = ',
  'function _langDisplayName(', 'const _LANG3TO2 = ',
  'const SEARCH_QUOTES = ', 'const _SEARCH_UNSPACED = ', 'const SEARCH_FILTERS = ',
  'function _searchTokens(', 'function parseSearchQuery(', 'const _isOrToken = ', 'function _searchRebuild(',
  'function _searchTokenWords(', 'function searchQueryChips(', 'const _reEscape = ', 'function _searchSourceTitle(',
  'function _searchChipLabel(', 'const _CHIP_X_SVG = ', 'function _searchChipHtml(', 'function searchChipsHtml(',
  'const SEARCH_EXAMPLES = ', 'const CATALOG_EXAMPLES = ', 'function _searchHelpApplies(',
];
vm.runInContext(decls.map(grab).join('').replace(/^(const|let) /gm, 'var '), sandbox);
const S = sandbox;
function ui(lang) { S._i18n = i18n[lang]; S._i18nFallback = i18n.en; S._currentLang = lang; }
ui('en');

// ── one chip per operator, in the order typed ────────────────────────────
const kinds = q => S.searchQueryChips(q).map(c => c.kind);
check(same(kinds('water filter'), []) && same(kinds('e-mail x-ray'), []) && same(kinds(''), []),
  'a plain query, or a hyphenated word, has no chips');
check(S.searchChipsHtml('water filter', []) === '', 'no chips, no row');
const one = q => { const c = S.searchQueryChips(q); if (c.length !== 1) throw new Error(q + ': ' + JSON.stringify(c)); return c[0]; };
check(same(one('solar -ted').words, ['ted']) && one('solar -ted').kind === 'without', '-ted is a "without" chip');
check(same(one('"solar panel"').words, ['solar panel']) && one('"solar panel"').kind === 'exact', 'a phrase is an "exact" chip');
check(one('whale lang:fr').kind === 'lang' && one('whale lang:fr').value === 'fr', 'lang:fr is a language chip');
check(one('whale in:wikipedia').kind === 'source' && one('whale source:wikipedia').kind === 'source', 'in: and source: are a source chip');
check(one('cats OR dogs').kind === 'or' && same(one('cats OR dogs').words, ['cats', 'dogs']), 'OR is an "or" chip');
check(same(kinds('"a b" -c lang:fr in:x d OR e'), ['exact', 'without', 'lang', 'source', 'or']), 'chips come in the order typed');

// ── labels, in words ─────────────────────────────────────────────────────
const label = (q, pool) => S._searchChipLabel(one(q), pool || [], false);
const html = (q, pool) => S._searchChipLabel(one(q), pool || [], true);
check(label('solar -ted') === 'without ted', 'en: "without ted"');
check(label('"solar panel"') === 'exact: solar panel', 'en: "exact: solar panel"');
check(label('whale lang:fr') === 'French' && label('whale lang:fra') === 'French', 'en: lang:fr and lang:fra read "French"');
check(label('whale -lang:fr') === 'without French', 'en: -lang:fr reads "without French"');
check(label('cats OR dogs') === 'cats or dogs' && label('a OR b OR c') === 'a, b, or c', 'en: OR reads as a list');
check(label('-Ted') === 'without Ted', 'a word keeps the case it was typed in');
check(label('-"common law"') === 'without common law', 'a quoted exclusion reads without its quotes');
const pool = [
  { name: 'wikipedia_en_all_maxi', title: 'Wikipedia' },
  { name: 'wikipedia_fr_all_maxi', title: 'Wikipédia' },
  { name: 'ted_en_science', title: 'TED Talks: Science' },
  { name: 'ted_en_design', title: 'TED Talks: Design' },
  { name: 'lawtest_en', title: 'Law test' },
];
check(label('whale in:wikipedia', pool) === 'Wikipedia', 'in:wikipedia reads as the sources\' title');
check(label('talks in:ted', pool) === 'TED', 'in:ted reads "TED", as the titles write it');
check(label('whale in:lawtest', pool) === 'Law test', 'in: naming one source reads its title');
check(label('whale in:nowhere', pool) === 'nowhere', 'in: matching nothing reads what was typed');
check(label('talks -in:ted', pool) === 'without TED', '-in:ted reads "without TED"');
check(html('solar -ted') === 'without <bdi>ted</bdi>', 'the typed word is isolated for bidi');
check(!html('-<b>x</b>').includes('<b>') && html('-<b>x</b>').includes('&lt;b&gt;'), 'a typed word is escaped');

// Every language, from its own file: a label that reads in it.
const labels = {};
for (const lang of ['en', ...LANGS.filter(l => l !== 'en')]) {
  ui(lang);
  labels[lang] = {
    without: label('solar -ted'), exact: label('"solar panel"'), lang: label('whale lang:fr'),
    notLang: label('whale -lang:fr'), or: label('cats OR dogs'),
  };
  const l = labels[lang];
  check(l.without.includes('ted') && l.exact.includes('solar panel') && l.or.includes('cats') && l.or.includes('dogs'),
    lang + ': every label keeps the typed words');
  check(!/[{}]/.test(l.without + l.exact + l.notLang), lang + ': no template placeholder left over');
  const french = new Intl.DisplayNames([lang], { type: 'language' }).of('fr');
  check(l.lang.toLowerCase() === french.toLowerCase(), lang + ': lang:fr is French in ' + lang + ' ("' + l.lang + '")');
  if (lang !== 'en') {
    check(l.without !== labels.en.without && l.exact !== labels.en.exact && l.or !== labels.en.or,
      lang + ': the labels are translated, not English');
  }
}
check(labels.he.without === 'ללא ted' && labels.he.lang === 'צרפתית' && labels.he.or === 'cats או dogs', 'he: reads right to left in Hebrew');
check(labels.fr.lang === 'Français' && labels.fr.notLang === 'sans français', 'fr: a language alone is capitalised, inside a phrase not');
check(labels.hi.without === 'ted के बिना', 'hi: the template puts the word where Hindi does');
ui('en');

// ── the ×: the query again, without that operator ──────────────────────
const after = (q, kind, n) => S.searchQueryChips(q).filter(c => c.kind === kind)[n || 0].query;
check(after('science -Ted', 'without') === 'science', '× on -Ted');
check(after('law -"common law" england', 'without') === 'law england', '× on a quoted exclusion takes both quotes');
check(after('“solar  panel” England -ted', 'without') === '“solar  panel” England', '× leaves another phrase exactly as typed');
check(after('“solar  panel” England -ted', 'exact') === 'solar panel England -ted', '× on a phrase keeps its words, as words');
check(after('whale lang:fr in:wikipedia', 'lang') === 'whale in:wikipedia', '× on lang:');
check(after('whale lang:fr in:wikipedia', 'source') === 'whale lang:fr', '× on in:');
check(after('talks -in:ted', 'source') === 'talks', '× on -in:');
check(after('pet cats OR dogs OR birds food', 'or') === 'pet cats dogs birds food', '× on OR joins nothing any more');
check(after('"new york" OR boston', 'or') === '"new york" boston', '× on OR keeps a phrase in it');
check(after('"new york" OR boston', 'exact') === 'new york OR boston', '× on a phrase in an OR keeps the OR');
check(after('cats OR -dogs', 'without') === 'cats', 'no OR left hanging at the end');
check(after('-dogs OR birds', 'without') === 'birds', 'no OR left hanging at the start');
check(after('cats -dogs OR birds', 'without') === 'cats OR birds', 'an OR that joins something stays');
// An OR just before a filter joined nothing (cats AND dogs, in wiki). Left
// behind it would join them: cats OR dogs.
check(after('cats OR in:wiki dogs', 'source') === 'cats dogs', 'an OR that joined nothing goes with the filter');
check(after('solar -ted', 'without') === 'solar' && after('-ted', 'without') === '', 'the last operator leaves the words, or nothing');

// Taking one operator out changes nothing else about the query.
const view = p => JSON.stringify({ g: p.groups.map(g => g.map(t => [t.text, t.phrase])), x: p.exclude.map(t => [t.text, t.phrase]), f: p.filters.map(f => [f.key, f.value, f.negate]) });
for (const q of ['cats OR in:wiki dogs -ted "big cat" lang:fr', 'a OR -b OR c -"d e" -in:x', '“x y” OR z -lang:en in:w -q']) {
  const whole = S.parseSearchQuery(q);
  for (const chip of S.searchQueryChips(q)) {
    if (chip.kind === 'exact' || chip.kind === 'or') continue;
    const p = S.parseSearchQuery(chip.query);
    const want = JSON.parse(view(whole));
    if (chip.kind === 'without') want.x = want.x.filter((_, i) => whole.exclude[i].at !== chip.at);
    else want.f = want.f.filter((_, i) => whole.filters[i].at !== chip.at);
    check(view(p) === JSON.stringify(want), 'removing ' + chip.kind + ' from ' + JSON.stringify(q) + ' keeps the rest (' + chip.query + ')');
  }
}

// ── the chips row ────────────────────────────────────────────────────────
const row = S.searchChipsHtml('solar -ted lang:fr', pool);
check((row.match(/class="search-chip"/g) || []).length === 2 && (row.match(/class="search-chip-x"/g) || []).length === 2, 'each chip has its ×');
check(row.includes('data-q="solar lang:fr"') && row.includes('data-q="solar -ted"'), 'each × carries the query without its operator');
check(row.includes('aria-label="Remove: without ted"') && row.includes('aria-label="Remove: French"'), 'each × says what it removes');
check(S.searchChipsHtml('x -"a&quot;b"', []).includes('data-q="x"'), 'a query with quotes in it survives the attribute');
// An OR longer than the library search's budget: the chip lists every
// alternative and says which were not searched (the answer's unsearched).
const capped = S.searchChipsHtml('A OR b OR "c d"', [], ['b', 'c d']);
check(capped.includes('<bdi>A</bdi>, <bdi>b</bdi>, or <bdi>&quot;c d&quot;</bdi> not searched: <bdi>b</bdi> and <bdi>&quot;c d&quot;</bdi>'), 'an OR past the budget says what was not searched', capped);
check(!S.searchChipsHtml('A OR b', [], []).includes('not searched') && !S.searchChipsHtml('A OR b', []).includes('not searched'), 'an OR searched whole says nothing more');
for (const lang of LANGS) {
  ui(lang);
  const l = S.searchChipsHtml('a OR b', [], ['b']);
  check(/\{|\}/.test(l) === false && l.includes(i18n[lang].search_chip_not_searched.split('{words}')[0].replace(/[<>&"']/g, '')), lang + ': "not searched" in ' + lang);
}
ui('en');

// ── the "?" examples, written per language ───────────────────────────────
const KIND = { exact: 'exact', without: 'without', or: 'or', lang: 'lang', source: 'source' };
for (const lang of LANGS) {
  for (const key of [...S.SEARCH_EXAMPLES, ...S.CATALOG_EXAMPLES]) {
    const ex = i18n[lang][key];
    const want = KIND[key.split('_').pop()];
    const chips = ex ? S.searchQueryChips(ex) : [];
    check(!!ex && chips.length === 1 && chips[0].kind === want, lang + ': ' + key + ' (' + JSON.stringify(ex) + ') shows one "' + want + '" chip');
    check(!!ex && !/(^|[^a-z])ted([^a-z]|$)/i.test(ex), lang + ': ' + key + ' does not lean on "-ted"');
    if (want === 'lang') check(chips[0] && chips[0].value === lang, lang + ': ' + key + ' asks for ' + lang + ' itself');
    if (lang !== 'en') check(ex !== i18n.en[key], lang + ': ' + key + ' is written in ' + lang);
  }
  for (const key of ['search_tips', 'search_chip_without', 'search_chip_exact', 'remove']) {
    check(!!(i18n[lang][key] || '').trim(), lang + ': has ' + key);
  }
  check(i18n[lang].search_chip_without.includes('{word}') && i18n[lang].search_chip_exact.includes('{words}'), lang + ': the chip templates take the words');
  check(!('search_syntax_hint' in i18n[lang]), lang + ': the old one-line hint is gone');
}
check(!src.includes('search_syntax_hint') && !src.includes('_searchSyntaxHint'), 'app.js no longer draws the hint');
check(/id="search-help"[^>]*onclick="toggleSearchTips\(event\)"/.test(fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8')),
  'the "?" sits in the search box');

// ── where the "?" shows ──────────────────────────────────────────────────
const helpIn = s => { Object.assign(S, s); return S._searchHelpApplies(); };
check(helpIn({ mode: 'home', manageTab: 'installed', readerOpen: false, _almanacOpen: false, _createOpen: false }), 'on home');
check(helpIn({ mode: 'search' }) && helpIn({ mode: 'source' }), 'on a search and in a source');
check(helpIn({ mode: 'manage', manageTab: 'browse' }), 'in the catalog');
check(!helpIn({ mode: 'manage', manageTab: 'installed' }), 'not on the installed list, which filters its own way');
check(!helpIn({ mode: 'home', readerOpen: true }), 'not in an article, an app or a map');
check(!helpIn({ readerOpen: false, _almanacOpen: true }) && !helpIn({ _almanacOpen: false, _createOpen: true }), 'not in the Almanac or Create');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
