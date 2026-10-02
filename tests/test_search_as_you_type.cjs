// #104: search-as-you-type must not burn the search budget. app.js's own
// input handler, driven by a fake clock: a 12-letter word typed fast (80 ms a
// key) sends one search and one suggest, for the word as typed, after the
// pause; nothing per keystroke.
//
// Run: node tests/test_search_as_you_type.cjs   (exit 0 = pass)

const vm = require('vm');
const src = require('./app_source.cjs')();

const start = src.indexOf("q.addEventListener('input', () => {");
if (start < 0) throw new Error('input handler not found');
let j = src.indexOf('{', start), d = 0;
for (; j < src.length; j++) {
  if (src[j] === '{') d++;
  else if (src[j] === '}' && --d === 0) break;
}
const handler = src.slice(src.indexOf('() =>', start), j + 1);

// A fake clock: timers fire in order as time advances.
let now = 0, nextId = 1;
const timers = new Map();
const setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; };
const clearTimeout = id => timers.delete(id);
function advance(ms) {
  const end = now + ms;
  for (;;) {
    const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]);
    now = due[1].at;
    due[1].fn();
  }
  now = end;
}

const sent = { search: [], suggest: [] };
const no = () => false, nop = () => {};
const sandbox = {
  setTimeout, clearTimeout,
  q: { value: '' },
  mode: 'search', currentSource: 'wikipedia_en_all', manageTab: 'installed',
  searchTimer: null, suggestTimer: null,
  searchMeta: { style: {} },
  _searchHelpExpanded: nop, _isWikiPage: no, _isBooksPage: no, _isDictPage: no, _isReddotPage: no,
  _isExchangePage: no, _isTubePage: no, _isMapPage: no,
  showHistoryDropdown: nop, hideSuggest: nop, clearSearch: nop, renderHome: nop,
  doSearch: v => sent.search.push(v),
  fetchSuggestions: v => sent.suggest.push(v),
};
vm.createContext(sandbox);
const onInput = vm.runInContext('(' + handler + ')', sandbox);

let failures = 0;
const check = (ok, label) => { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); };

const word = 'encyclopedia';
check(word.length === 12, 'a 12-letter word');
for (const ch of word) {
  sandbox.q.value += ch;
  onInput();
  advance(80);
}
check(sent.search.length === 0 && sent.suggest.length === 0, 'nothing is sent while typing');
advance(2000);
check(sent.search.length === 1 && sent.search[0] === word, 'one search, for the whole word: ' + JSON.stringify(sent.search));
check(sent.suggest.length === 1 && sent.suggest[0] === word, 'one suggest, for the whole word: ' + JSON.stringify(sent.suggest));

// "Try again in 1 seconds": the wait is a plural, in every language.
const fs = require('fs'), path = require('path');
check(/tPluralH\('search_rate_limited', e\.retryAfter\)/.test(src) && !/'search_rate_limited'\s*,\s*\{/.test(src), 'the wait is said through tPluralH');
const dir = path.join(__dirname, '..', 'zimi', 'static', 'i18n');
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const lang = f.replace('.json', ''), strings = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const n of [1, 2, 3, 5, 11, 21, 60]) {
    const s = strings['search_rate_limited_' + new Intl.PluralRules(lang).select(n)];
    check(typeof s === 'string' && !s.includes('{s}'), lang + ': a wait of ' + n);
  }
}
check(JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8')).search_rate_limited_one.endsWith('in {n} second.'), 'en: 1 second');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
