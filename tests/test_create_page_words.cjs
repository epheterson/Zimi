// The Create page says what each part is for, where it can be read.
//
// A 1.13 design review of folder mode: the mode's description sat under the
// tree; files left out showed "left out" with the reason in a tooltip, cut
// off; the help text put the server's path and ZIMI_CREATE_ROOT in front of
// every admin; Bookmarks was lit by default with nothing saved; greyed-out
// tiles said why only in a tooltip a phone never shows.
//
// Run: node tests/test_create_page_words.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const src = fs.readFileSync(path.join(root, 'create.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'en.json'), 'utf8'));
let failures = 0;
function ok(name, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || detail === undefined ? '' : '  ' + detail));
  if (!cond) failures++;
}
function fn(name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) { console.log('FAIL  no ' + name); process.exit(1); }
  return m[0];
}

// Bookmarks is not the default with nothing saved.
{
  const ctx = { Saved: { all: () => [] } };
  vm.createContext(ctx);
  vm.runInContext(fn('_createModeAvailable') + '\n' + fn('_createDefaultMode') + '\n' + fn('_createSavedCount'), ctx);
  const modes = [{ id: 'page', network: true }, { id: 'bookmarks', client: true }, { id: 'folder', tree: true }];
  ctx._createOffline = true;
  vm.runInContext('var _createOffline = true, _createImportReady = false;', ctx);
  ok('offline with nothing saved: Folder is lit, not Bookmarks', ctx._createDefaultMode(modes) === 'folder', ctx._createDefaultMode(modes));
  ctx.Saved = { all: () => [{}] };
  ok('...with something saved, Bookmarks may be', ctx._createDefaultMode(modes) === 'bookmarks');
  ctx.Saved = { all: () => [] };
  ok('...and when nothing else can run, Bookmarks still is', ctx._createDefaultMode([{ id: 'page', network: true }, { id: 'bookmarks', client: true }]) === 'bookmarks');
}

// The order on the page: chips, why some are grey, what the mode makes, then what it asks for.
const at = (id) => src.indexOf("id=\"" + id + "\"");
ok('the mode description is above the address and the folder tree',
  at('create-modes') < at('create-modes-why') && at('create-modes-why') < at('create-mode-desc') && at('create-mode-desc') < at('create-address') && at('create-mode-desc') < at('create-folder-tree'));
ok('greyed-out chips are named, and why, in a line a phone can read', /function _renderCreateModesWhy\(visible\)/.test(src) && /create_offline_modes/.test(src) &&
  /\{modes\}/.test(en.create_offline_modes || '') && !/—/.test(en.create_offline_modes + en.create_offline_helper));

// A left-out file says why, in full.
ok('a left-out file shows its reason under its name, not in a tooltip alone', /<span class="create-ftree-why">' \+ esc\(why\) \+ '<\/span>/.test(src));
const css = fs.readFileSync(path.join(root, 'app.css'), 'utf8');
const why = (css.match(/\.create-ftree-why \{[^}]*\}/) || [''])[0];
ok('...and the reason wraps rather than being cut', /white-space: normal/.test(why) && !/text-overflow/.test(why));

// The server's path and ZIMI_CREATE_ROOT behind a toggle.
ok('the folder help names no path and no variable', !/\{dir\}|ZIMI_CREATE_ROOT/.test(en.create_folder_note));
ok('...they are behind "Where is this folder?"', /<details class="create-where" id="create-folder-where"/.test(src) && /\{dir\}/.test(en.create_folder_where) && /ZIMI_CREATE_ROOT/.test(en.create_folder_where));
for (const f of fs.readdirSync(path.join(root, 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(root, 'i18n', f), 'utf8'));
  const keys = ['create_folder_note', 'create_folder_where', 'create_folder_where_summary', 'create_offline_modes', 'create_offline_helper'];
  const bad = keys.filter((k) => !d[k] || (k === 'create_folder_note' && /\{dir\}|ZIMI_CREATE_ROOT/.test(d[k])));
  ok(f + ' has the words', !bad.length, bad.join(', '));
}

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
