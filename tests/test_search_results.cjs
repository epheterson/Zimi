// Search results: the words searched for marked in titles and snippets, and
// the one rule for grouping results by source (search revamp, 2026-09-30).
//
// Run: node tests/test_search_results.cjs   (exit 0 = pass)

const vm = require('vm');
const src = require('./app_source.cjs')();

let failures = 0;
const check = (ok, label) => { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); };

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
  console,
  esc: s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  activeSourceFilters: new Set(),
  _isMapZim: name => name.startsWith('map'),
};
vm.createContext(sandbox);
const decls = [
  'const SEARCH_QUOTES = ', 'const _SEARCH_UNSPACED = ', 'const SEARCH_FILTERS = ', 'function _searchTokens(',
  'function parseSearchQuery(', 'const _reEscape = ', 'const SEARCH_STOP_WORDS = ', 'function searchHitRe(',
  'function searchHitsHtml(', 'const RESULTS_PER_PAGE = ', 'const SEARCH_GROUP_MIN_SOURCES = ',
  'const SEARCH_GROUP_SIZE = ', 'function searchResultGroups(',
];
vm.runInContext(decls.map(grab).join('').replace(/^(const|let) /gm, 'var '), sandbox);
const S = sandbox;
const marked = (q, text) => S.searchHitsHtml(text, S.searchHitRe(q));

// ── marking ──────────────────────────────────────────────────────────────
check(marked('solar', 'Solar panel') === '<mark class="hit">Solar</mark> panel', 'a word is marked, its case kept');
check(marked('sun', 'Sunlight in a tsunami') === '<mark class="hit">Sun</mark>light in a tsunami',
  'from the start of a word: "sun" marks Sunlight, not tsunami');
check(marked('solar -panel', 'Solar panel') === '<mark class="hit">Solar</mark> panel', 'an excluded word is not marked');
check(marked('whale lang:fr in:wikipedia', 'Whale lang wikipedia') === '<mark class="hit">Whale</mark> lang wikipedia',
  'a filter\'s words are not marked');
check(marked('"solar panel"', 'A solar panel, a solar cell') === 'A <mark class="hit">solar panel</mark>, a solar cell',
  'a phrase is marked as the phrase, not its words apart');
check(marked('"solar panel" solar', 'solar panel solar') === '<mark class="hit">solar panel</mark> <mark class="hit">solar</mark>',
  'the phrase before a word inside it');
check(marked('cats OR dogs', 'Dogs and cats') === '<mark class="hit">Dogs</mark> and <mark class="hit">cats</mark>', 'both sides of an OR');
check(marked('history of the world', 'The history of the world') === 'The <mark class="hit">history</mark> of the <mark class="hit">world</mark>',
  'a common word alone is not marked');
check(marked('x', '<img src=x onerror=alert(1)>') === '&lt;img src=<mark class="hit">x</mark> onerror=alert(1)&gt;',
  'the text around and inside a mark is escaped');
check(marked('a.b', 'aXb a.b') === 'aXb <mark class="hit">a.b</mark>', 'a word is matched as typed, not as a pattern');
check(marked('שלום', 'שלום עולם') === '<mark class="hit">שלום</mark> עולם', 'a Hebrew word is marked');
check(marked('東京', '東京都の人口') === '<mark class="hit">東京</mark>都の人口', 'a word in a script without spaces, anywhere');
check(marked('-ted', 'TED talk') === 'TED talk' && S.searchHitRe('-ted') === null, 'nothing searched, nothing marked');
check(marked('', 'plain') === 'plain', 'no query, the text as it was');

// ── grouping: one rule ───────────────────────────────────────────────────
const res = (spec) => spec.flatMap(([zim, n]) => Array.from({ length: n }, (_, i) => ({ zim, path: zim + i })));
const interleave = (list) => list.sort((a, b) => a.path.slice(-1) - b.path.slice(-1));
check(S.searchResultGroups(res([['a', 10], ['b', 10]])) === null, 'two sources: ranked');
check(S.searchResultGroups(res([['a', 5], ['b', 5], ['c', 5]])) === null, 'three sources, one screen: ranked');
const g = S.searchResultGroups(interleave(res([['a', 10], ['b', 10], ['c', 10]])));
check(g && g.length === 3 && g.every(x => x.items.length === 10), 'three sources past a screen: grouped, every result kept');
check(g && g.map(x => x.zim).join() === 'a,b,c', 'sources in the order of their best result');
const gm = S.searchResultGroups(interleave(res([['mapx', 10], ['a', 10], ['b', 10]])));
check(gm && gm.map(x => x.zim).join() === 'a,b,mapx', "a map's places after the reading, even when it ranks first");
S.activeSourceFilters = new Set(['a']);
check(S.searchResultGroups(res([['a', 10], ['b', 10], ['c', 10]])) === null, 'narrowed by a source pill: ranked');

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
