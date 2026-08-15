// The Created bucket rule (library views): a ZIM Zimi itself made, with no
// filing of its own, groups under Created — wherever the file sits. A folder
// category, a heuristic hit or an explicit override (including the force-Other
// sentinel) always wins, because each of those is a filing somebody or
// something actually made.
//
// Extracted from app.js with the same vm approach as test_activity_rows.cjs so
// it runs without a browser.
//
// Run: node tests/test_created_bucket.cjs   (exit 0 = pass)

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

const sandbox = { _zimKinds: null };
vm.createContext(sandbox);
vm.runInContext(
  extract(/const OTHER_CAT = '[^']*';/, 'OTHER_CAT') +
  extract(/var CREATED_CAT = '[^']*';/, 'CREATED_CAT') +
  extract(/function _zimCat\(z\)\s*\{[\s\S]*?\n\}/, '_zimCat'),
  sandbox);

const cat = (z, kinds) => {
  sandbox._zimKinds = kinds === undefined ? { field_notes: { mode: 'site' } } : kinds;
  return vm.runInContext('_zimCat(' + JSON.stringify(z) + ')', sandbox);
};

ok('the bucket name matches what the created/ folder derives',
  vm.runInContext('CREATED_CAT', sandbox) === 'Created');

// The rule itself.
ok('a Zimi-made ZIM with no filing goes to Created',
  cat({ name: 'field_notes' }) === 'Created');
ok('a ZIM in the created/ folder lands in the SAME bucket',
  cat({ name: 'field_notes', category: 'Created', folder: 'created' }) === 'Created');

// Every explicit filing wins over provenance.
ok('a folder category wins over provenance',
  cat({ name: 'field_notes', category: 'Medical', folder: 'medical' }) === 'Medical');
ok('an override (arriving as a category) wins over provenance',
  cat({ name: 'field_notes', category: 'How-To' }) === 'How-To');
ok('the force-Other sentinel is respected, not second-guessed',
  cat({ name: 'field_notes', category: '__other__' }) === '__other__');

// Everything that is not the rule stays exactly as it was.
ok('a non-Zimi ZIM with no category stays in Other',
  cat({ name: 'wikipedia_en_all' }) === '__other__');
ok('before the kinds map arrives nothing moves',
  cat({ name: 'field_notes' }, null) === '__other__');
ok('an empty kinds map moves nothing',
  cat({ name: 'field_notes' }, {}) === '__other__');
ok('a missing record still buckets', cat(null) === '__other__');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
