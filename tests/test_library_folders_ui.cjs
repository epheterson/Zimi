// A catalog row offers Update only for a ZIM Zimi owns.
//
// A ZIM in a folder another program owns (Project NOMAD) is read in place and
// never updated by Zimi: Update would download a second full copy into Zimi's
// own library beside the original.
//
// Run: node tests/test_library_folders_ui.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = [path.join(__dirname, '..', 'zimi', 'static', 'manage.js'), path.join(__dirname, '..', 'zimi', 'static', 'app.js')].map((f) => fs.readFileSync(f, 'utf8')).join('\n').replace(/\r\n/g, '\n');
let failures = 0;
function ok(label, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
  if (!cond) failures++;
}

const m = src.match(/function _catalogHasUpdate\(inst, upd\) \{[\s\S]*?\n\}\n/);
if (!m) throw new Error('app.js has no _catalogHasUpdate');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(m[0] + '\nthis.f = _catalogHasUpdate;', ctx);
const has = ctx.f;

const newer = { date: '2026-03-01', download_url: 'https://x/y_2026-03.zim' };
ok('an owned ZIM with a newer edition offers Update', has({ _installedDate: '2026-01' }, newer) === true);
ok('the same date offers nothing', has({ _installedDate: '2026-03' }, newer) === false);
ok('a ZIM in another program\'s folder never offers Update', has({ _installedDate: '2026-01', _installedExternal: 'Project NOMAD' }, newer) === false);
ok('no download link offers nothing', has({ _installedDate: '2026-01' }, { date: '2026-03-01' }) === false);
ok('the catalog row asks the function', /const hasUpdate = _catalogHasUpdate\(instVariant, updVariant\);/.test(src));


// The count sublines and the badge
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n', 'en.json'), 'utf8'));
const esc = x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = (k, v) => (en[k] || k).replace(/\{(\w+)\}/g, (_, n) => (v && v[n] !== undefined ? v[n] : ''));
const grab = name => {
  const r = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n'));
  if (!r) throw new Error('app.js has no ' + name);
  return r[0];
};
const c2 = { esc, escAttr: esc, t, tH: (k, v) => esc(t(k, v)), fmtSize: g => g.toFixed(1) + ' GB' };
vm.createContext(c2);
vm.runInContext(grab('_libShareRowsHtml') + grab('_zimDeleteBtn') + '\nthis.rows = _libShareRowsHtml; this.badge = _zimDeleteBtn;', c2);
const shares = [{ label: 'Project NOMAD', zims: 9, size_gb: 2.5 }];
const countRow = c2.rows(shares, false), sizeRow = c2.rows(shares, true);
ok('the ZIM count gets a quiet subline with the folder label and its share', /mc-sub/.test(countRow) && countRow.includes('>Project NOMAD<') && !countRow.includes('From') && countRow.includes('>9<'));
ok('the total size gets its own subline', sizeRow.includes('>Project NOMAD<') && sizeRow.includes('2.5 GB'));
ok('no other folders, no sublines', c2.rows([], false) === '' && c2.rows(undefined, true) === '');
ok('a folder name cannot inject markup', !c2.rows([{ label: '<b>x</b>', zims: 1, size_gb: 0 }], false).includes('<b>'));
const badge = c2.badge('x.zim', 'Project NOMAD');
ok('another program\'s ZIM wears an In badge, not a Delete button', badge.includes('ci-installed-badge') && badge.includes('In Project NOMAD') && !badge.includes('deleteZim'));
ok('Zimi\'s own ZIM keeps its Delete button', c2.badge('x.zim', null).includes('deleteZim'));

// A phone has no hover: the badge is a button that says why, in words.
const c3 = { esc, escAttr: esc, t, tH: (k, v) => esc(t(k, v)), toasts: [] };
c3._showToast = m => c3.toasts.push(m);
vm.createContext(c3);
vm.runInContext(grab('_zimDeleteBtn') + grab('_ownedNote') + grab('_libFolderNotes') + '\nthis.badge = _zimDeleteBtn; this.note = _ownedNote; this.notes = _libFolderNotes;', c3);
const tapBadge = c3.badge('x.zim', 'Project NOMAD');
ok('the badge is a button, tappable on touch', tapBadge.startsWith('<button') && tapBadge.includes('_ownedNote(this)'));
c3.note({ getAttribute: () => 'Project NOMAD' });
ok('a tap says whose file it is and where to change it', c3.toasts[0] === 'Project NOMAD looks after this file. Remove or update it there.');
const notes = c3.notes({ shadowed: [{ file: 'a.zim' }], unreadable: [{ file: 'b.zim', why: 'permission' }] });
ok('the card says what is not shown and what cannot be opened', notes.length === 2 && notes[0].includes('1 not shown') && notes[1].includes('b.zim') && notes[1].includes('no permission'));
ok('a refused delete is shown by its translated key, not the raw error', /if \(data\.error_key\) \{[\s\S]*?_showToast\(t\(data\.error_key/.test(src));
ok('the two Add buttons have different names', en.lib_folders_add !== en.lib_folders_add_folder);
ok('the path hint is the path, short enough for a phone', /LIB_FOLDER_PLACEHOLDER = '\/opt\/project-nomad\/storage\/zim'/.test(src));

process.exit(failures ? 1 : 0);
