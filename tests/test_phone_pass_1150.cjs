// 1.15.0 final fixes from the phone pass: the catalog's note only when it is
// really stale, Capture's name, no repeated tab titles, the Apps list, no
// recency dot on Home's count line, Zimi's category last, a game's Menu
// toggle and veil, ZimiGames' delete.
//
// Run: node tests/test_phone_pass_1150.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
let failures = 0;
function ok(name, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || detail === undefined ? '' : '  ' + detail));
  if (!cond) failures++;
}
function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label);
  return m[0];
}
const body = (name) => extract(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'), name);

// 1. The catalog note.
const DAY = 86400;
const ctx = {
  console, Date,
  fmtDate: (ms) => 'D' + Math.round(ms / 1000),
  tH: (k, v) => k + ':' + JSON.stringify(v || {}),
};
vm.createContext(ctx);
vm.runInContext([
  'var _catalogStaleAt = 0, _catalogSource = "", _catalogAsOf = "";',
  extract(/var CATALOG_FRESH_S = \d+;/, 'CATALOG_FRESH_S'),
  body('_setCatalogOrigin'), body('_catalogStaleNote'),
].join('\n'), ctx);
const now = Date.now() / 1000;
ctx._setCatalogOrigin(false, 0, '', '');
ok('a live catalog says nothing', ctx._catalogStaleNote() === '');
ctx._setCatalogOrigin(true, now - 60, 'cache', '2026-10-27');
ok('a copy a minute old says nothing, whatever its date', ctx._catalogStaleNote() === '');
ctx._setCatalogOrigin(true, now - 3 * DAY, 'cache', '');
ok('a copy three days old says so', /catalog_stale_note/.test(ctx._catalogStaleNote()));
ctx._setCatalogOrigin(false, 0, '', '');
ok('once refreshed the note goes, though the date was set before (the "Offline" bug)', ctx._catalogStaleNote() === '' && ctx._catalogAsOf === '' && ctx._catalogSource === '');
ctx._setCatalogOrigin(true, 0, 'snapshot', '2026-09-16');
ok('the shipped snapshot keeps its own note', /catalog_snapshot_note/.test(ctx._catalogStaleNote()));
ok('nothing calls the old offline key', !/catalog_offline_note/.test(src));

// 3. Capture, in every language, and no em dash in the strings added here.
const dir = path.join(root, 'i18n');
const newKeys = ['ms_creator', 'catalog_stale_note', 'delete_games_confirm'];
for (const f of fs.readdirSync(dir)) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  ok(f + ': the Creator tab is renamed', f === 'en.json' ? d.ms_creator === 'Capture' : d.ms_creator !== 'Creator' && !!d.ms_creator);
  ok(f + ': new strings have no em dash', newKeys.every((k) => d[k] && !/—/.test(d[k])));
  ok(f + ': no "offline" key left', !('catalog_offline_note' in d));
}

// 4. A tab's name is not repeated as a heading in it.
ok('Language tab opens on its card, not a "Language" heading', !/class="ms-section-label" id="ms-languages"/.test(src) && /id="ms-languages"/.test(src));

// 5. Apps list: All/None after the rows; Settings wears Home's glyphs.
const picks = body('_appPicksHtml');
ok('All/None follow the rows', picks.indexOf('rows + (head') > 0 && picks.indexOf('rows + (head') < picks.indexOf("class=\"apps-head\""));
ok('Settings icons are Home\'s glyphs', /function _appSettingsIcon\(app\) \{ return _appIcon\(app\); \}/.test(src));
ok('Home\'s own-app tiles wear the line glyphs', !/_ownIconHtml\(_GAMES_ZIM, _GAMES_SVG/.test(src) && !/_ownIconHtml\(_ALMANAC_ZIM, _ALMANAC_SVG, OWN/.test(src));

// 6. No recency dot on Home's count line.
ok('the count line carries no recency dots', !/_recencyDotsHtml/.test(src) && !/statsHtml = _recency/.test(src));

// 7. Zimi's category goes last, a monochrome mark.
const cats = vm.runInNewContext(extract(/function _catIcon\(paths\) \{[\s\S]*?\n\}/, '_catIcon') + '\n' +
  extract(/const BROWSE_CATEGORIES = \[[\s\S]*?\n\];/, 'BROWSE_CATEGORIES').replace(/^const /, 'var ') + '\nBROWSE_CATEGORIES');
ok('Zimi is the last category', cats[cats.length - 1].key === 'zimi', cats.map((c) => c.key).join(','));
ok('its mark is a stroke in the category style', /stroke="currentColor"/.test(cats[cats.length - 1].icon) && !/<img|<image/.test(cats[cats.length - 1].icon));

// 8/9. A game's Menu toggles; its sheet veils Zimi's bar too.
ok('a second tap on Menu closes the sheet', /what === 'menu' && _gameSheetOpen\(\)/.test(body('_gameDo')) && /closeMenu\(\)/.test(body('_gameDo')));
ok('the frame is watched for a sheet', /_watchGameSheets\(frame\)/.test(src) && /classList\.toggle\('game-sheet'/.test(src));
const css = fs.readFileSync(path.join(root, 'app.css'), 'utf8');
ok('the veil on the bar lets taps through', /body\.game-sheet \.topbar::after[^}]*pointer-events: none/.test(css));
ok('Find in page stays out of apps and games (f7a2a056: a game has no text to find)', /_isAppPage\(\)/.test(body('_findApplies')));

// 10. Almanac pills rest at the start edge.
const alm = fs.readFileSync(path.join(root, 'almanac.js'), 'utf8');
ok('the lit pill is brought to the start edge, not the middle', /a\.left - b\.left/.test(alm) && !/a\.width \/ 2/.test(alm.slice(alm.indexOf('function _almSecBarPaint'), alm.indexOf('function _almSecGo'))));

// 11. ZimiGames' delete.
ok('deleting ZimiGames says what goes', /_deleteConfirmText\(zim, zinfo\.title\)/.test(src) && /zim === _GAMES_ZIM \? t\('delete_games_confirm'\)/.test(src));
const after = body('_afterZimDeleted');
ok('it clears the games\' keys and the worker\'s copy', /_GAMES_STORE_PREFIX/.test(after) && /forget-own/.test(after));

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
