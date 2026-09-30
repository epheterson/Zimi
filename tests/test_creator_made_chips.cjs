// Settings > Creator > Made here: each chip is its count in words, through
// the plural helper, in every language ("5 pages", never "5 page"; Russian
// "5 страниц", "2 страницы"). The number stays bold.
//
// Run: node tests/test_creator_made_chips.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
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
const load = lang => JSON.parse(fs.readFileSync(path.join(root, 'i18n', lang + '.json'), 'utf8'));

function context(lang) {
  const ctx = { _currentLang: lang, _i18n: load(lang), _i18nFallback: load('en'), Intl };
  ctx.t = (k, v) => {
    let s = ctx._i18n[k] !== undefined ? ctx._i18n[k] : ctx._i18nFallback[k];
    Object.keys(v || {}).forEach(n => { s = s.split('{' + n + '}').join(String(v[n])); });
    return s;
  };
  vm.createContext(ctx);
  vm.runInContext(extract(/function tPlural\(base, n, vars\) \{[\s\S]*?\n\}/, 'tPlural'), ctx);
  vm.runInContext(extract(/function tPluralH\(base, n, vars\) \{[\s\S]*?\n\}/, 'tPluralH'), ctx);
  vm.runInContext(extract(/var _CREATOR_TYPE_KEYS = \{[\s\S]*?\n\};/, 'the types'), ctx);
  vm.runInContext(extract(/function _creatorMadeChip\(type, n\) \{[\s\S]*?\n\}/, '_creatorMadeChip'), ctx);
  return ctx;
}

const en = context('en');
ok('5 pages, not 5 page', en._creatorMadeChip('page', 5) === '<span class="cr-made-chip"><b>5</b> pages</span>', en._creatorMadeChip('page', 5));
ok('1 page', en._creatorMadeChip('page', 1) === '<span class="cr-made-chip"><b>1</b> page</span>');
ok('2 subreddits', /<b>2<\/b> subreddits/.test(en._creatorMadeChip('reddit', 2)));
const ru = context('ru');
ok('ru: 5 страниц', /<b>5<\/b> страниц</.test(ru._creatorMadeChip('page', 5)), ru._creatorMadeChip('page', 5));
ok('ru: 2 страницы', /<b>2<\/b> страницы</.test(ru._creatorMadeChip('page', 2)));
ok('ru: 21 страница', /<b>21<\/b> страница</.test(ru._creatorMadeChip('page', 21)));
const ar = context('ar');
ok('ar: 2 is its own word', ar._creatorMadeChip('page', 2).indexOf('صفحتان') >= 0);

// Every type has its words in every language, one per plural category.
const types = Object.keys(en._CREATOR_TYPE_KEYS || vm.runInContext('_CREATOR_TYPE_KEYS', en));
const missing = [];
fs.readdirSync(path.join(root, 'i18n')).filter(f => f.endsWith('.json')).forEach(f => {
  const d = JSON.parse(fs.readFileSync(path.join(root, 'i18n', f), 'utf8'));
  types.forEach(type => ['one', 'other'].forEach(c => {
    const k = 'creator_made_' + type + '_' + c;
    if (!d[k] || /[—–]/.test(d[k])) missing.push(f + ':' + k);
  }));
});
ok('every type, every language', types.length === 8 && missing.length === 0, missing.join(' '));
process.exit(failures ? 1 : 0);
