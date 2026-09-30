// Export to ZIM, per list, + localized pluralization (bookmarks/export QA).
//
// Guards three behaviors:
//
// 1. _bmComposeExportJob builds ONE job per export: each ticked list becomes
//    a section (Liked by its name in the UI's language), a single ticked list
//    keeps the plain shape (its items unsectioned), an item in two ticked
//    lists goes in once, and (the Eric bug) an EMPTY ticked list is kept in
//    `sections` instead of being silently dropped. An all-empty selection
//    yields zero items (the UI disables Export on that).
//
// 2. _bmSanitizeZimName mirrors the server's _safe_name (manage.py) so the
//    prefill the user sees matches the filename the server writes.
//
// 3. tPlural picks <base>_one/_other via Intl.PluralRules for the active UI
//    language, and maps richer categories (ru "many", ar...) to _other while
//    only _one/_other keys ship.
//
// Same vm-extraction approach as test_bookmark_rename.cjs.
//
// Run: node tests/test_bookmark_export_compose.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from app.js');
  return m[0];
}

let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

// ── Compose: list fixtures ──────────────────────────────────────────────────
// Medical (Aspirin, Heart), Liked (Heart again), Research (EMPTY), and one
// item in no list.
function mkComposeSandbox() {
  const LISTS = [
    { id: 'liked', name: '', builtin: true },
    { id: 'med', name: 'Medical', builtin: false },
    { id: 'res', name: 'Research', builtin: false },
  ];
  const IN = {
    liked: [{ key: 'w\nA/Heart', zim: 'w', path: 'A/Heart', title: 'Heart' }],
    med: [
      { key: 'w\nA/Aspirin', zim: 'w', path: 'A/Aspirin', title: 'Aspirin' },
      { key: 'w\nA/Heart', zim: 'w', path: 'A/Heart', title: 'Heart' },
    ],
    res: [],
    '': [{ key: 'w\nA/Loose', zim: 'w', path: 'A/Loose', title: 'Loose' }],
  };
  const sandbox = {
    _BM_ROOT: '',
    Saved: {
      NAME_MAX: 120,
      lists: () => LISTS.map((l) => Object.assign({ count: IN[l.id].length }, l)),
      list: (id) => sandbox.Saved.lists().filter((l) => l.id === id)[0] || null,
      itemsFor: (q) => IN[q.list].slice(),
    },
    t: (k) => ({ saved_liked: 'Liked' }[k] || k),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extract(/function _savedListName\(l\)\s*\{[^\n]*\}/, '_savedListName') + '\n' +
    extract(/function _bmSanitizeZimName\(s\)\s*\{[\s\S]*?\n\}/, '_bmSanitizeZimName') +
    extract(/function _bmListNameById\(id\)\s*\{[\s\S]*?\n\}/, '_bmListNameById') +
    extract(/function _bmComposeExportJob\(ids, unfiled, nameRaw\)\s*\{[\s\S]*?\n\}/, '_bmComposeExportJob'),
    sandbox);
  return sandbox;
}

{
  const sb = mkComposeSandbox();

  // Several lists, an EMPTY one among them, and the items in no list: ONE job.
  const job = vm.runInContext(
    "_bmComposeExportJob(['liked','med','res'], true, ' My Export! ')", sb);
  ok('one job carries every item once, even one in two lists', job.bookmarks.length === 3,
    JSON.stringify(job.bookmarks.map((b) => b.path)));
  ok('an item in two ticked lists goes under the first', job.bookmarks.filter((b) => b.path === 'A/Heart').length === 1 &&
    job.bookmarks.some((b) => b.path === 'A/Heart' && b.section === 'Liked'));
  ok('title is the trimmed user text', job.title === 'My Export!');
  ok('name is the sanitized filename base', job.name === 'My_Export', 'got ' + job.name);
  ok('each list is a section, Liked by its name in the UI\'s language',
    JSON.stringify(job.sections) === JSON.stringify(['Liked', 'Medical', 'Research']), JSON.stringify(job.sections));
  ok('an EMPTY ticked list is NOT dropped (Eric bug)', job.sections.includes('Research'));
  ok('items in no list ride unsectioned',
    job.bookmarks.some((b) => b.path === 'A/Loose' && b.section === ''));

  // One list: the plain shape, its items unsectioned; an empty name → null.
  const single = vm.runInContext("_bmComposeExportJob(['med'], false, '')", sb);
  ok('one list: its items unsectioned, in its order',
    JSON.stringify(single.bookmarks.map((b) => b.path + '|' + b.section)) === JSON.stringify(['A/Aspirin|', 'A/Heart|']));
  ok('one list: no sections', JSON.stringify(single.sections) === '[]');
  ok('empty name → null (server picks default)', single.name === null && single.title === null);

  // Only the empty list → zero items.
  const empty = vm.runInContext("_bmComposeExportJob(['res'], false, 'Research')", sb);
  ok('only-empty selection yields zero items', empty.bookmarks.length === 0);

  // Sanitizer parity with manage.py _safe_name:
  //   re.sub(r"[^a-zA-Z0-9._-]+", "_", s).strip("_.")[:60]
  const san = (s) => vm.runInContext('_bmSanitizeZimName(' + JSON.stringify(s) + ')', sb);
  ok('sanitizer: spaces/punctuation collapse to _', san('Med kit: v2!') === 'Med_kit_v2');
  ok('sanitizer: keeps . _ - and alphanumerics', san('a-b_c.d9') === 'a-b_c.d9');
  ok('sanitizer: strips leading/trailing _ and .', san('..._name_...') === 'name');
  ok('sanitizer: caps at 60 chars', san('x'.repeat(80)).length === 60);
  ok('sanitizer: all-junk input → empty string', san('!!!') === '');
}

// ── tPlural ─────────────────────────────────────────────────────────────────
{
  const sandbox = {
    Intl: Intl,
    _i18n: {},
    _i18nFallback: {
      bm_count_one: '{n} bookmarked article',
      bm_count_other: '{n} bookmarked articles',
    },
    _currentLang: 'en',
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extract(/function t\(key, vars\)\s*\{[\s\S]*?\n\}/, 't') +
    extract(/function tPlural\(base, n, vars\)\s*\{[\s\S]*?\n\}/, 'tPlural'),
    sandbox);

  const tp = (lang, n) => {
    sandbox._currentLang = lang;
    return vm.runInContext('tPlural("bm_count", ' + n + ')', sandbox);
  };
  ok('en: 1 → singular', tp('en', 1) === '1 bookmarked article', tp('en', 1));
  ok('en: 0 → plural', tp('en', 0) === '0 bookmarked articles', tp('en', 0));
  ok('en: 5 → plural', tp('en', 5) === '5 bookmarked articles');

  // Russian: 5 is category "many" — no _many key ships, must fall back to _other.
  sandbox._i18n = { bm_count_one: '{n} статья', bm_count_other: '{n} статей' };
  ok('ru: 1 → one', tp('ru', 1) === '1 статья', tp('ru', 1));
  ok('ru: 5 (category "many") falls back to _other', tp('ru', 5) === '5 статей', tp('ru', 5));
  ok('ru: 21 (category "one") → one', tp('ru', 21) === '21 статья', tp('ru', 21));

  // A locale file missing the key entirely falls back to English.
  sandbox._i18n = {};
  ok('missing locale key falls back to en', tp('ru', 5) === '5 bookmarked articles');
}

process.exit(failures ? 1 : 0);
