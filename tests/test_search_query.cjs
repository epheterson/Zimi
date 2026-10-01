// The search grammar in the client (#94), against the cases the server's
// parser (zimi/query.py, tests/test_search_query.py) is held to, and the
// catalog filter built on it.
//
// tripplehelix: "More complex search queries. It would be nice to be able to
// do things like -ted to remove those results." Hundreds of TED ZIMs crowd
// the catalog; "-ted" has to take them out and leave "United States" in.
//
// Run: node tests/test_search_query.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = require('./app_source.cjs')();
function grab(name, kind) {
  const needle = kind === 'const' ? `const ${name} = ` : `function ${name}(`;
  const i = src.indexOf(needle);
  if (i < 0) throw new Error(name + ' not found');
  if (kind === 'const' && !/[{[]\s*$/.test(src.slice(i, src.indexOf('\n', i)))) {
    return src.slice(i, src.indexOf('\n', i) + 1); // one-line const
  }
  let j = src.indexOf(kind === 'const' ? '{' : ')', i);
  if (kind !== 'const') j = src.indexOf('{', j);
  for (let d = 0; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1) + (kind === 'const' ? ';' : '');
  }
  throw new Error('unbalanced ' + name);
}

const sandbox = { console, tH: (k) => k };
vm.createContext(sandbox);
for (const c of ['SEARCH_QUOTES', '_SEARCH_UNSPACED', '_searchUnaccent', '_searchFold', '_SEARCH_PARTS', 'SEARCH_FILTERS', '_reEscape', '_LANG3TO2', '_catalogLang', '_CATALOG_FILTER_TESTS', '_CATALOG_ENTITIES']) {
  vm.runInContext(grab(c, 'const').replace(/^const /, 'var '), sandbox);
}
for (const f of ['_searchTokens', 'parseSearchQuery', '_searchTermRe', 'searchQueryMatches', '_catalogText', 'catalogItemMatches']) {
  vm.runInContext(grab(f), sandbox);
}

let failures = 0;
const check = (ok, label) => { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); };
const show = (t) => (t.phrase ? '"' + t.text + '"' : t.text);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'search_query_cases.json'), 'utf8'));
for (const c of cases.parse) {
  const got = sandbox.parseSearchQuery(c.q, sandbox.SEARCH_FILTERS);
  const view = {
    groups: got.groups.map(g => g.map(show)),
    exclude: got.exclude.map(show),
    filters: got.filters.map(f => [f.key, f.value, f.negate]),
  };
  // plain is the server's alone (query.py): the client never asks it.
  const want = { groups: c.groups, exclude: c.exclude, filters: c.filters };
  check(same(view, want), 'parse ' + JSON.stringify(c.q) + (same(view, want) ? '' : ' got ' + JSON.stringify(view)));
}
for (const c of cases.match) {
  const got = sandbox.searchQueryMatches(sandbox.parseSearchQuery(c.q), c.text);
  check(got === c.match, 'match ' + JSON.stringify(c.q) + ' vs ' + JSON.stringify(c.text));
}
// #94: "-wiki doesn't seem to work". The same exclusion cases query.excluded
// is held to: MediaWiki goes, Sabdkosh ("Wiktionary in Fiji Hindi Language")
// stays because wik-tionary does not contain "wiki", -ted keeps United.
for (const c of cases.exclude) {
  const got = !sandbox.searchQueryMatches(sandbox.parseSearchQuery('-' + c.term), c.text);
  check(got === c.excluded, 'exclude -' + c.term + ' vs ' + JSON.stringify(c.text));
}
// lang: as the library means it (search._filter_sources, the same cases).
for (const c of cases.lang) {
  const got = sandbox._CATALOG_FILTER_TESTS.lang(c.value, { language: c.language });
  check(got === c.match, 'lang:' + c.value + ' vs ' + JSON.stringify(c.language));
}

// The catalog, as the issue asked.
const catalog = [
  { name: 'ted_en_science', title: 'TED Talks: Science', summary: 'Talks about science', language: 'en', category: 'ted' },
  { name: 'ted_fr_culture', title: 'TED Culture', summary: 'Conférences', language: 'fra', category: 'ted' },
  { name: 'wikipedia_en_history', title: 'Wikipedia History', summary: 'United States and world history', language: 'en', category: 'wikipedia' },
  { name: 'wikipedia_fr_all', title: 'Wikipédia', summary: 'Encyclopédie', language: 'fra', category: 'wikipedia' },
  { name: 'khanacademy_en_science', title: 'Khan Academy', summary: 'Science lessons', language: 'eng,spa', category: 'other' },
];
const find = (q) => catalog.filter(item => sandbox.catalogItemMatches(sandbox.parseSearchQuery(q, sandbox.SEARCH_FILTERS), item)).map(i => i.name);
check(same(find('science'), ['ted_en_science', 'khanacademy_en_science']), 'catalog: a word finds both');
check(same(find('science -ted'), ['khanacademy_en_science']), 'catalog: -ted removes the TED ZIMs');
check(same(find('history -ted'), ['wikipedia_en_history']), 'catalog: -ted keeps "United States"');
check(same(find('-ted'), ['wikipedia_en_history', 'wikipedia_fr_all', 'khanacademy_en_science']), 'catalog: only an exclusion lists everything else');
check(same(find('lang:fr'), ['ted_fr_culture', 'wikipedia_fr_all']), 'catalog: lang:fr finds the catalog\'s "fra"');
check(same(find('lang:fra'), ['ted_fr_culture', 'wikipedia_fr_all']), 'catalog: lang:fra too');
check(same(find('lang:es'), ['khanacademy_en_science']), 'catalog: lang: reads a language list');
check(same(find('wiki -lang:fr'), ['wikipedia_en_history']), 'catalog: -lang:fr');
check(same(find('in:ted'), ['ted_en_science', 'ted_fr_culture']), 'catalog: in:ted');
check(same(find('culture OR lessons'), ['ted_fr_culture', 'khanacademy_en_science']), 'catalog: OR');
check(same(find('"talks about"'), ['ted_en_science']), 'catalog: a phrase');
check(same(find('"science talks"'), []), 'catalog: a phrase is in order');
check(same(find('"science wikipedia"'), []), 'catalog: a phrase does not run across fields');

// The Wikis category as tripplehelix saw it (#94).
const wikis = [
  { name: 'mediawiki_en_all', title: 'MediaWiki', summary: 'The MediaWiki documentation', language: 'eng', category: 'wikipedia' },
  { name: 'wiktionary_hif_all', title: 'Sabdkosh', summary: 'Wiktionary in Fiji Hindi Language', language: 'hif', category: 'wiktionary' },
  { name: 'wikipedia_en_all', title: 'Wikipedia', summary: 'The free encyclopedia', language: 'eng', category: 'wikipedia' },
  { name: 'appropedia_en_all', title: 'Appropedia', summary: 'Sustainability', language: 'eng', category: 'other' },
];
const wikiLeft = wikis.filter(item => sandbox.catalogItemMatches(sandbox.parseSearchQuery('-wiki', sandbox.SEARCH_FILTERS), item)).map(i => i.name);
check(same(wikiLeft, ['wiktionary_hif_all', 'appropedia_en_all']), 'catalog: -wiki drops MediaWiki, keeps Sabdkosh (Wiktionary has no "wiki" in it) got ' + JSON.stringify(wikiLeft));

// The old filter was one substring of the whole query: the first two of
// these found nothing, the third found every TED ZIM.
check(find('science -ted').length === 1 && find('culture OR lessons').length === 2 && !find('-ted').some(n => n.startsWith('ted_')),
  'catalog: operators do what the old substring filter could not');

// A summary escaped twice reads, and is found, as its words.
check(sandbox._catalogText('d&apos;articles &amp; l&#39;informatique') === "d'articles & l'informatique",
  'catalog: a summary escaped twice reads as words');
// As Kiwix's feed has it: escaped twice, "&apos;" left after one decode.
const twice = { name: 'wikipedia_fr_computer', title: 'Informatique', summary: 'Une sélection d&apos;articles sur l&apos;informatique', language: 'fra' };
check(sandbox.catalogItemMatches(sandbox.parseSearchQuery('"d\'articles"', sandbox.SEARCH_FILTERS), twice),
  'catalog: a phrase with an apostrophe finds a summary escaped twice');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
