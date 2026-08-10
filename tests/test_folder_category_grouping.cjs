// Folder-derived categories need no client code of their own — they ride the
// same grouping path as a hand-set category override. This test pins the two
// client behaviors that make that true, so a future refactor of the category
// helpers cannot quietly break folder filing:
//
// 1. _zimCat returns a folder category verbatim, so it becomes its own home
//    section instead of falling into the Other catch-all.
// 2. _catDisplayName passes an unknown category through as its own label
//    (no i18n key required for a folder an admin invented five minutes ago),
//    while still localizing the known English category names.
// 3. _catCanonKey folds case/whitespace, so a folder named "field guides" and
//    a category typed as "Field Guides" are one move target, not two.
//
// Same vm-extraction approach as test_flavor_selection_total.cjs.
//
// Run: node tests/test_folder_category_grouping.cjs   (exit 0 = pass)

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

// Translation stub: returns the key, so "localized" is visible as the i18n key
// while an untranslated pass-through shows the raw category name.
const sandbox = { t: (k) => k };
vm.createContext(sandbox);
vm.runInContext(
  // const at vm top level does not attach to the sandbox — rewrite to var.
  extract(/const OTHER_CAT = '__other__';/, 'OTHER_CAT').replace('const ', 'var ') + '\n' +
  extract(/const BROWSE_CATEGORIES = \[[\s\S]*?\n\];/, 'BROWSE_CATEGORIES').replace('const ', 'var ') + '\n' +
  extract(/const _CAT_TO_BROWSE_KEY = \{[\s\S]*?\n\};/, '_CAT_TO_BROWSE_KEY').replace('const ', 'var ') + '\n' +
  extract(/function _zimCat\(z\)\s*\{[\s\S]*?\n\}/, '_zimCat') + '\n' +
  extract(/function _catDisplayName\(key\)\s*\{[\s\S]*?\n\}/, '_catDisplayName') + '\n' +
  extract(/function _catCanonKey\(c\)\s*\{[^\n]*\}/, '_catCanonKey'),
  sandbox);

const { _zimCat, _catDisplayName, _catCanonKey, OTHER_CAT } = sandbox;

// ── Grouping: a folder category is a section of its own ──
ok('folder category groups under itself',
   _zimCat({ name: 'mushrooms', category: 'Field Guides', folder: 'field-guides' }) === 'Field Guides');
ok('uncategorized ZIM still falls to Other',
   _zimCat({ name: 'mystery' }) === OTHER_CAT);
ok('two ZIMs from one folder share a section',
   _zimCat({ category: 'Field Guides' }) === _zimCat({ category: 'Field Guides' }));

// ── Display: unknown names pass through, known names still localize ──
ok('folder category is its own label', _catDisplayName('Field Guides') === 'Field Guides');
ok('known category still localizes', _catDisplayName('Wikimedia') === 'cat_encyclopedias');
ok('Other sentinel reads as Other', _catDisplayName(OTHER_CAT) === 'cat_other');

// ── Move targets: a folder name and a typed name are one target ──
ok('canon key folds case and padding',
   _catCanonKey('Field Guides') === _catCanonKey('  field guides  '));
ok('distinct categories keep distinct keys',
   _catCanonKey('Field Guides') !== _catCanonKey('Medical'));

console.log(failures === 0 ? '\nAll checks passed' : '\n' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
