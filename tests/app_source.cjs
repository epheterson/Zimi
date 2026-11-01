// app.js as the server serves it: the language-code table put in where the
// file marks its place (http._inline_lang_codes), from the one table both
// sides read (zimi/assets/lang-codes.json). A test that runs app.js's
// language code reads app.js through this.
//
// appSource(): the served text.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'zimi');
const MARK = '/*@lang-codes.json@*/{}';

module.exports = function appSource() {
  // A Windows checkout carries CRLF; the tests read it as served on POSIX.
  // manage.js (the Library Manager, fetched on first use) first, so its functions are
  // found before the stubs app.js keeps for them.
  const src = ['manage.js', 'app.js'].map((f) => fs.readFileSync(path.join(root, 'static', f), 'utf8')).join('\n').replace(/\r\n/g, '\n');
  if (!src.includes(MARK)) throw new Error('app.js has no ' + MARK);
  const table = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'lang-codes.json'), 'utf8'));
  return src.replace(MARK, JSON.stringify(table));
};

// localeHelpers(src): app.js's number, date, sort and week helpers (fmtNum,
// fmtDate, cmpText, cmpTitle, _weekFirstDay), to run in a vm context before
// any part that formats or sorts. Zimi's language is the context's
// _currentLang, English when it has none.
module.exports.localeHelpers = function localeHelpers(src) {
  const a = src.indexOf('function _uiLocale()'), b = src.indexOf('// Localized pluralization: picks');
  if (a < 0 || b < a) throw new Error('app.js locale helpers moved');
  return "if (typeof _currentLang === 'undefined') var _currentLang = 'en';\n" +
    "var _uiLangPrimary = typeof _uiLangPrimary === 'function' ? _uiLangPrimary : function() { return String(_currentLang || 'en').split('-')[0]; };\n" +
    "var _langPrimary = typeof _langPrimary === 'function' ? _langPrimary : function(t) { return String(t || '').split('-')[0]; };\n" +
    src.slice(a, b);
};
