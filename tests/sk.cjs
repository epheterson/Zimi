// app.js's storage-key table (`var SK = {...}`), to run in a vm context before
// any Almanac file that reads its setting keys from it at the top level. The
// names stay defined once, in app.js; a test never spells a key out.
//
// skSource(): app.js's text for the table.

const fs = require('fs');
const path = require('path');

module.exports = function skSource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const a = src.indexOf('\nvar SK = {');
  const b = src.indexOf('\n};\n', a);
  if (a < 0 || b < a) throw new Error('app.js has no SK table');
  return src.slice(a + 1, b + 4);
};

// prefWriteSource(): _prefWrite as the page has it once the account's sync is
// set aside: the key written to the context's localStorage, null removing it.
module.exports.prefWriteSource = function prefWriteSource() {
  return 'function _prefWrite(k, v) { try { if (v == null) { if (localStorage.removeItem) localStorage.removeItem(k); } else localStorage.setItem(k, String(v)); } catch (e) {} }';
};
