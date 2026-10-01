// The counts on the search pills are the results shown, and the recent list
// is searches worth going back to (design review, 2026-10-01).
//
// "einstein" showed "2 results" over five source pills of (1) each, and the
// Wikiquote pill opened nothing: the server counted results per source
// before keeping one result per title. The pills now count the results on
// screen, so they add up to All. The recent list had "All sources" under
// every row, the filter rows above the searches, and searches that found
// nothing.
//
// Run: node tests/test_search_counts.cjs   (exit 0 = pass)

const vm = require('vm');
const src = require('./app_source.cjs')();

let failures = 0;
const check = (ok, label) => { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); };

function fn(name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error(name + ' not found');
  let d = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i + 1, j + 1);
  }
  throw new Error('unbalanced ' + name);
}

const box = {};
vm.createContext(box);
vm.runInContext(fn('searchResultCounts'), box);

// Three results on screen (one Albert Einstein kept of three sources').
const zims = [{ name: 'wikipedia_en', language: 'en' }, { name: 'wikiquote_en', language: 'en' },
  { name: 'wikipedia_de', language: 'de' }, { name: 'simple', language: 'en' }];
const items = [
  { zim: 'wikipedia_en', title: 'Albert Einstein' },
  { zim: 'wikipedia_en', title: 'Einstein family' },
  { zim: 'wikipedia_de', title: 'Einsteinturm' },
];
const c = vm.runInContext('searchResultCounts', box)(items, zims);
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
check(JSON.stringify(c.bySource) === '{"wikipedia_en":2,"wikipedia_de":1}', 'a pill per source with results shown, counting them');
check(!('wikiquote_en' in c.bySource), 'no pill for a source whose result is not shown');
check(sum(c.bySource) === items.length, 'the source pills add up to All');
check(sum(c.byLanguage) === items.length && c.byLanguage.en === 2 && c.byLanguage.de === 1, 'the language pills add up to All');

const render = fn('renderSearchResults');
check(/const counts = searchResultCounts\(items, zimsCache\);/.test(render) && /const totalCount = items\.length;/.test(render),
  'the results are counted as drawn, not by the server\'s per-source tally');

// The recent list.
const push = fn('_histPushSearch');
check(/if \(!resultCount\) return;/.test(push), 'a search that found nothing is not kept as recent');
const dd = fn('showHistoryDropdown');
check(/if \(entry\.resultCount === 0\) continue;/.test(dd), 'one kept before is not offered');
check(/sub = entry\.zim \? _zimTitle\(entry\.zim\) : '';/.test(dd) && !/all_sources/.test(dd), 'a search in every source names no scope');
check(dd.indexOf("suggestDropdown.innerHTML = recentHeader +") > 0 && /\}\)\.join\(''\) \+ pillsHtml;/.test(dd), 'the recents first, the filter rows under them');
check(/it\.sub \? '<div class="sg-source">'/.test(dd), 'no empty scope line under a row');

// Kept when the search is done, with what it found in the end.
const ds = src.slice(src.indexOf('async function doSearch('), src.indexOf('\nfunction mergeSearchResults('));
check(/gotFull = true;\s*renderSearchResults\(allResults, scope\);\s*_histPushSearch\(query, scope, \(allResults\.results \|\| \[\]\)\.length\);/.test(ds),
  'a search goes in the recent list with its full count');

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
