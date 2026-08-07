// Bookmark export composition + localized pluralization (bookmarks/export QA).
//
// Guards three behaviors:
//
// 1. _bmComposeExportJob builds ONE job per export: selected top-level folders
//    become sections ("Parent / Child" when nested), a single selected folder
//    keeps the old shape (own bookmarks unsectioned, subfolders as sections),
//    and — the Eric bug — an EMPTY selected folder is preserved in `sections`
//    instead of being silently dropped. An all-empty selection yields zero
//    bookmarks (the UI disables Export on that).
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

// ── Compose: folder fixtures ────────────────────────────────────────────────
// med (2 bookmarks: 1 own + 1 in card) > card; res (EMPTY); loose at root.
function mkComposeSandbox() {
  const FOLDERS = {
    med: { id: 'med', name: 'Medical', parent: '' },
    card: { id: 'card', name: 'Cardiology', parent: 'med' },
    res: { id: 'res', name: 'Research', parent: '' },
  };
  const BOOKMARKS = [
    { zim: 'w', path: 'A/Aspirin', title: 'Aspirin', folder: 'med' },
    { zim: 'w', path: 'A/Heart', title: 'Heart', folder: 'card' },
    { zim: 'w', path: 'A/Loose', title: 'Loose', folder: '' },
  ];
  const sandbox = {
    _BM_ROOT: '',
    _folNorm: (id) => (id == null ? '' : String(id)),
    _folById: (id) => FOLDERS[id] || null,
    _folChildren: (pid) =>
      Object.values(FOLDERS).filter((f) => f.parent === pid),
    _bkInFolder: (fid) => BOOKMARKS.filter((b) => (b.folder || '') === fid),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extract(/function _bmSanitizeZimName\(s\)\s*\{[\s\S]*?\n\}/, '_bmSanitizeZimName') +
    extract(/function _bmHasSelectedAncestor\(fid, selSet\)\s*\{[\s\S]*?\n\}/, '_bmHasSelectedAncestor') +
    extract(/function _bmComposeExportJob\(ids, unfiled, nameRaw\)\s*\{[\s\S]*?\n\}/, '_bmComposeExportJob'),
    sandbox);
  return sandbox;
}

{
  const sb = mkComposeSandbox();

  // Multi-selection: med (+card), EMPTY res, and unfiled → ONE job.
  const job = vm.runInContext(
    "_bmComposeExportJob(['med','card','res'], true, ' My Export! ')", sb);
  ok('one job carries all bookmarks', job.bookmarks.length === 3);
  ok('title is the trimmed user text', job.title === 'My Export!');
  ok('name is the sanitized filename base', job.name === 'My_Export', 'got ' + job.name);
  ok('top-level folders become sections',
    job.sections.includes('Medical') && job.sections.includes('Research'),
    JSON.stringify(job.sections));
  ok('nested selected subfolder keeps its place',
    job.sections.includes('Medical / Cardiology'), JSON.stringify(job.sections));
  ok('EMPTY selected folder is NOT dropped (Eric bug)',
    job.sections.includes('Research'));
  ok('unfiled bookmarks ride unsectioned',
    job.bookmarks.some((b) => b.path === 'A/Loose' && b.section === ''));
  ok('nested bookmark tagged with its combined section',
    job.bookmarks.some((b) => b.path === 'A/Heart' && b.section === 'Medical / Cardiology'));

  // Single-folder selection keeps the old shape: own bookmarks unsectioned,
  // subfolders as plain sections; empty name falls back to null (server default).
  const single = vm.runInContext("_bmComposeExportJob(['med','card'], false, '')", sb);
  ok('single-root: own bookmarks unsectioned',
    single.bookmarks.some((b) => b.path === 'A/Aspirin' && b.section === ''));
  ok('single-root: subfolder is a plain section',
    single.bookmarks.some((b) => b.path === 'A/Heart' && b.section === 'Cardiology'));
  ok('empty name → null (server picks default)', single.name === null && single.title === null);

  // Selecting ONLY the empty folder → zero bookmarks, section still present.
  const empty = vm.runInContext("_bmComposeExportJob(['res'], false, 'Research')", sb);
  ok('only-empty selection yields zero bookmarks', empty.bookmarks.length === 0);
  ok('only-empty selection: single-root shape keeps no phantom sections',
    JSON.stringify(empty.sections) === '[]', JSON.stringify(empty.sections));

  // Empty folder alongside a sibling in multi mode → its section survives.
  const mixed = vm.runInContext("_bmComposeExportJob(['med','res'], false, 'Mix')", sb);
  // (card is NOT selected here, so Heart stays behind — only Aspirin rides.)
  ok('empty sibling folder keeps its section in multi mode',
    mixed.sections.includes('Research') && mixed.bookmarks.length === 1,
    JSON.stringify(mixed.sections) + ' bms=' + mixed.bookmarks.length);

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
