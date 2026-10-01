// Settings: every tab's name says one thing, and what is this browser's sits
// with the preferences.
//
// A 1.13 design review found two tabs called Library (Manage's list of
// installed ZIMs, and Settings' pane of files, updates and upkeep), and My
// data (bookmarks, history, preferences: this browser's) under Server.
//
// Run: node tests/test_settings_tabs.cjs
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'zimi');
const src = fs.readFileSync(path.join(root, 'static', 'app.js'), 'utf8');
let failures = 0;
function ok(name, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || detail === undefined ? '' : '  ' + detail));
  if (!cond) failures++;
}
function body(name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  return m ? m[0] : '';
}

// The two rows of tabs, by the keys they are named with.
const manageKeys = [...src.matchAll(/class="manage-tab[^"]*"[^>]*data-tab="\w+"[^>]*>' \+ tH\('(\w+)'\)/g)].map((m) => m[1]);
const msKeys = [...src.matchAll(/class="ms-nav-item[^"]*" data-ms="\w+"[^>]*>' \+ tH\('(\w+)'\)/g)].map((m) => m[1]);
ok('both rows of tabs are found', manageKeys.length >= 5 && msKeys.length >= 4, manageKeys + ' / ' + msKeys);

const dir = path.join(root, 'static', 'i18n');
for (const f of fs.readdirSync(dir)) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const names = manageKeys.concat(msKeys).map((k) => (d[k] || '').trim().toLowerCase());
  const twice = names.filter((n, i) => n && names.indexOf(n) !== i);
  ok(f + ': no two tabs share a name', !twice.length, twice.join(', '));
}

// My data: under Preferences, not Server.
ok('My data is in the Preferences pane', /_myDataCardHtml\(\)/.test(body('_msPreferencesHtml')));
ok('...and the Server pane keeps only the server\'s backup', /_serverBackupCardHtml\(\)/.test(body('_msServerHtml')) && !/_myDataCardHtml|_backupHubHtml/.test(body('_msServerHtml')));

// Cut: a keyboard key in the empty Saved panel (a phone has none), and the
// Reader View switch's subtitle that only said its title again.
for (const f of fs.readdirSync(dir)) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  ok(f + ': the empty Saved panel names no key', !/\bB\b/.test(d.no_bookmarks || 'B'));
  ok(f + ': no "Open articles in Reader View" under "Always use Reader View"', !('reader_auto_hint' in d));
}
ok('neither Reader View switch carries a subtitle', !/reader_auto_hint/.test(src));

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
