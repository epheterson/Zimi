// Discover in every language: which ZIM each card reads, and how it reads.
//
// The cards chose the ZIM with the most entries whatever its language, and
// On this day took only the English Wikipedia: with German, French and Hindi
// Wikipedias installed there was no card at all, and a Hebrew reader got the
// Word of the day from an English Wiktionary. The blurb check matched [\w],
// which is ASCII only, so every Hebrew, Arabic, Hindi, Russian and Chinese
// blurb came out empty and was dropped as "a repeat of the title".
//
// Run: node tests/test_discover_pick.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');

function slice(name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error(name + ' is missing from app.js');
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

const reAt = src.indexOf('var _WHOLE_WIKIPEDIA_RE');
const sandbox = { _currentLang: 'en', LIB: [] };
vm.createContext(sandbox);
vm.runInContext(
  (reAt >= 0 ? src.slice(reAt, src.indexOf('\n', reAt)) : '') + '\n' +
  slice('_defineLang2') + '\n' + slice('_featuredZimFor') + '\n' +
  slice('_blurbRepeatsTitle') + '\n' + slice('_otdDateLine') + '\n' +
  'function _zimInfo(n) { return LIB.find(function(z) { return z.name === n; }); }',
  sandbox);

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

function pick(ui, match, lib) {
  sandbox._currentLang = ui;
  sandbox.LIB = lib;
  return sandbox._featuredZimFor({ match }, lib.map((z) => z.name));
}

const LIB = [
  { name: 'wikipedia', language: 'en', entries: 7000000 },
  { name: 'wikipedia_de', language: 'de', entries: 3000000 },
  { name: 'wikipedia_de_climate-change', language: 'de', entries: 4000 },
  { name: 'wikipedia_hi', language: 'hi', entries: 250000 },
  { name: 'wiktionary', language: 'en', entries: 9000000 },
  { name: 'wiktionary_en_simple', language: 'en', entries: 50000 },
  { name: 'wiktionary_he', language: 'he', entries: 31000 },
  { name: 'wikiquote_es', language: 'es', entries: 16000 },
  { name: 'wikiquote_fr', language: 'fr', entries: 12000 },
];

check(pick('de', 'wikipedia', LIB) === 'wikipedia_de', 'German interface: German Wikipedia');
check(pick('hi', 'wikipedia', LIB) === 'wikipedia_hi', 'Hindi interface: Hindi Wikipedia');
check(pick('fr', 'wikipedia', LIB) === 'wikipedia', 'no French Wikipedia: English next');
check(pick('en', 'wiktionary', LIB) === 'wiktionary_en_simple', 'English: Simple English Wiktionary first');
check(pick('he', 'wiktionary', LIB) === 'wiktionary_he', 'Hebrew interface: Hebrew Wiktionary');
check(pick('fr', 'wikiquote', LIB) === 'wikiquote_fr', 'French interface: French Wikiquote');
check(pick('zh', 'wikiquote', LIB) === 'wikiquote_es', 'no Chinese or English one: the fullest installed');
check(pick('en', 'wikipedia', LIB.slice(1)) === 'wikipedia_de' && pick('de', 'wikipedia', LIB.slice(2, 3)) === null,
  'a library with only a German Wikipedia still has On this day, and a topic build is never it');

check(!sandbox._blurbRepeatsTitle('אתונה היא עיר הבירה של יוון', 'אתונה'), 'a Hebrew blurb is shown');
check(!sandbox._blurbRepeatsTitle('宁波市是浙江省的副省级市', '宁波'), 'a Chinese blurb is shown');
check(sandbox._blurbRepeatsTitle('Athens.', 'Athens'), 'a blurb that is the title is not');
check(sandbox._blurbRepeatsTitle('Москва', 'Москва (город)'), 'nor one that is part of the title');

sandbox._currentLang = 'de';
check(sandbox._otdDateLine('1066').endsWith(' 1066') && /\d\. /.test(sandbox._otdDateLine('1066')),
  'German date line: "25. September 1066"');
sandbox._currentLang = 'zh';
check(sandbox._otdDateLine('1066').indexOf('1066年') === 0, 'Chinese date line: "1066年9月25日"');
sandbox._currentLang = 'en';
check(/ 356 BC$/.test(sandbox._otdDateLine('356 BC')), 'a year before Christ follows the day as written');
check(sandbox._otdDateLine('0275'.replace(/^0+/, '')).endsWith(', 275'), 'a three-digit year is a date');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all discover pick checks passed');
