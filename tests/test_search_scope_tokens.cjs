// @source and #category typed into the search box.
//
//     @wikipedia whale        the word whale, in Wikipedia
//     #medical aspirin        aspirin, across everything medical
//     @lit @react hooks       hooks, in two sets of docs
//
// Both were already reachable through UI chrome. Typing them is faster and
// survives being shared as a URL, which is the argument for the syntax.
//
// The rule that matters most is the one about tokens that match nothing: they
// stay in the query as ordinary words. Silently narrowing to zero sources
// would turn a typo into an empty result page with no explanation, and "@" is
// a character people type by accident.
//
// Run: node tests/test_search_scope_tokens.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');

function grab(name, kind) {
  const needle = kind === 'var' ? `var ${name} =` : `function ${name}(`;
  const i = src.indexOf(needle);
  if (i < 0) throw new Error(name + ' not found');
  if (kind === 'var') return src.slice(i, src.indexOf('\n', i));
  let d = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1);
  }
  throw new Error('unbalanced ' + name);
}

const sandbox = {
  BROWSE_CATEGORIES: [
    { key: 'wikipedia' }, { key: 'devdocs' }, { key: 'medical' },
    { key: 'stack_exchange' }, { key: 'other' },
  ],
};
vm.createContext(sandbox);
vm.runInContext(grab('_SCOPE_TOKEN_RE', 'var'), sandbox);
vm.runInContext(grab('_zimCategoryKey'), sandbox);
vm.runInContext(grab('parseSearchScope'), sandbox);

const ZIMS = [
  { name: 'wikipedia_en_all', title: 'Wikipedia', category: 'Wikipedia' },
  { name: 'wikipedia_fr_all', title: 'Wikipédia', category: 'Wikipedia' },
  { name: 'devdocs_en_lit', title: 'Lit Docs', category: 'Dev Docs' },
  { name: 'devdocs_en_react', title: 'React Docs', category: 'Dev Docs' },
  { name: 'wikimed_en', title: 'WikiMed', category: 'Medical' },
];
const KEYS = sandbox.BROWSE_CATEGORIES.map((c) => c.key);
const parse = (q) => sandbox.parseSearchScope(q, ZIMS, KEYS);

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

// ── @source ────────────────────────────────────────────────────────────────

let r = parse('@wikipedia_en_all whale');
check(r.terms === 'whale', 'the token leaves the search terms');
check(r.zimNames.join() === 'wikipedia_en_all', 'and narrows to that source');

r = parse('@lit hooks');
check(r.zimNames.join() === 'devdocs_en_lit', 'a partial name matches one source');
check(r.terms === 'hooks', 'and the rest is the query');

r = parse('@wikipedia whale');
check(r.zimNames.length === 2, 'a prefix shared by two sources matches both');

r = parse('@lit @react hooks');
check(r.zimNames.length === 2 && r.terms === 'hooks', 'two sources at once');

// Exactness beats breadth: a name that IS a source must not also drag in
// everything merely containing it.
r = parse('@devdocs_en_lit hooks');
check(r.zimNames.join() === 'devdocs_en_lit', 'an exact name wins over a substring');

// ── #category ──────────────────────────────────────────────────────────────

r = parse('#medical aspirin');
check(r.zimNames.join() === 'wikimed_en', 'a category matches its sources');
check(r.terms === 'aspirin', 'and leaves the terms');

r = parse('#devdocs hooks');
check(r.zimNames.length === 2, 'a category with two sources matches both');

// ── the important one ──────────────────────────────────────────────────────

r = parse('@nosuchzim whale');
check(r.zimNames.length === 0, 'an unmatched @ narrows nothing');
check(r.terms === '@nosuchzim whale',
      'and stays in the query as ordinary words rather than searching nothing');

r = parse('#nosuchcategory aspirin');
check(r.zimNames.length === 0 && r.terms === '#nosuchcategory aspirin',
      'the same for an unmatched category');

r = parse('email me @ work');
check(r.zimNames.length === 0 && r.terms === 'email me @ work',
      'a bare @ in ordinary prose is left alone');

r = parse('C# generics');
check(r.zimNames.length === 0 && r.terms === 'C# generics',
      'a # inside a word is not a category (C#, F#, and every hashtag mid-sentence)');

// ── shapes ─────────────────────────────────────────────────────────────────

r = parse('whale');
check(r.terms === 'whale' && r.zimNames.length === 0, 'a plain query is untouched');

r = parse('@lit');
check(r.zimNames.join() === 'devdocs_en_lit' && r.terms === '',
      'a token with no terms still resolves, so the caller can decide');

r = parse('@lit  @react   hooks');
check(r.terms === 'hooks', 'whitespace left behind is collapsed');

r = parse('@LIT hooks');
check(r.zimNames.join() === 'devdocs_en_lit', 'matching is case-insensitive');

check(parse('').zimNames.length === 0, 'an empty query is safe');
check(parse('@').zimNames.length === 0, 'a lone @ is safe');

// ── it is actually wired in ────────────────────────────────────────────────

const doSearch = grab('doSearch');
check(/parseSearchScope\(query, zimsCache/.test(doSearch),
      'doSearch parses the typed scope');
check(/_activeScopeTokens = _scope\.tokens/.test(doSearch),
      'and records it where BOTH render passes can see it');
const render = grab('renderSearchResults');
check(/_activeScopeTokens/.test(render),
      'the result header echoes the tokens that were applied');
check(/_typedZims\.length\) zimParam = '&zim=' \+/.test(doSearch),
      'and a typed scope overrides the ambient one');

console.log('');
if (failures) {
  console.error(failures + ' search-scope check(s) failed');
  process.exit(1);
}
console.log('all search scope checks passed');
