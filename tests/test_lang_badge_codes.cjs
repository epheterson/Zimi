// A ZIM's language badge names its language, not a different one.
//
// ZIM metadata carries ISO 639-3 codes; the badge clipped them to their first
// two letters, which is right for eng/deu and wrong wherever the 639-1 code is
// not the prefix: Maltese (mlt) showed ML, Malayalam's code; Bosnian (bos) BO,
// Tibetan's; Tswana (tsn) TS, Tsonga's. Found on the NAS library, which holds
// wiktionary_mt, wiktionary_bs and wiktionary_tn.
//
// Run: node tests/test_lang_badge_codes.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
const S = {};
vm.createContext(S);
vm.runInContext(src.match(/const _LANG3TO2 = \{[^}]*\};/)[0].replace('const', 'var'), S);
vm.runInContext('var _currentLang = "en";', S);
vm.runInContext(extractFn('_normLang') + extractFn('_zimLangBadgeInfo'), S);

let failures = 0;
const cases = { mlt: 'MT', bos: 'BS', tsn: 'TN', eng: null, deu: 'DE', heb: 'HE', zho: 'ZH', fr: 'FR', xyz: 'XYZ' };
for (const [lang, want] of Object.entries(cases)) {
  const info = S._zimLangBadgeInfo({ language: lang, name: 'x_' + lang }, false);
  const got = info ? info.code : null;
  if (got !== want) { console.error('FAIL: ' + lang + ' badge is ' + got + ', want ' + want); failures++; }
  else console.log('ok: ' + lang + ' -> ' + got);
}
if (failures) process.exit(1);
