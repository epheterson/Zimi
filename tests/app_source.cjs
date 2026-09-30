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
  const src = fs.readFileSync(path.join(root, 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  if (!src.includes(MARK)) throw new Error('app.js has no ' + MARK);
  const table = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'lang-codes.json'), 'utf8'));
  return src.replace(MARK, JSON.stringify(table));
};
