// Manage > Installed: a ZIM's row carries the auto-updater's opt-out (the card
// menu no longer does). Shown only while auto-update is on and only for a ZIM
// the updater can reach; its state is the listing's `auto_update: false`.
//
// Run: node tests/test_manage_row_auto_update.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const src = ['manage.js', 'app.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label);
  return m[0];
}
let failures = 0;
const ok = (label, cond, detail) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
};

const posts = [];
const zims = { a: { name: 'a', file: 'a_2026-01.zim' }, b: { name: 'b', file: 'b_2026-01.zim', auto_update: false } };
const ctx = {
  JSON, t: (k) => k, escAttr: (s) => String(s),
  manageEnabled: true, _manageStatusData: { auto_update: { enabled: true } },
  _zimInfo: (n) => zims[n],
  manageFetch: (url, o) => { posts.push([url, JSON.parse(o.body)]); return Promise.resolve({ ok: true }); },
  renderInstalled: () => { ctx.repainted = true; },
};
vm.createContext(ctx);
vm.runInContext(extract(/var _DATED_ZIM_FILE_RE = .*;/, 'dated'), ctx);
vm.runInContext(extract(/var _AU_GLYPH = .*;/, 'glyph'), ctx);
vm.runInContext(extract(/function _zimAutoUpdateBtn\(z\) \{[\s\S]*?\n\}/, '_zimAutoUpdateBtn'), ctx);
vm.runInContext(extract(/function _toggleZimAutoUpdate\(name\) \{[\s\S]*?\n\}/, '_toggleZimAutoUpdate'), ctx);

const on = ctx._zimAutoUpdateBtn(zims.a), off = ctx._zimAutoUpdateBtn(zims.b);
ok('an updating ZIM shows a pressed button with a label',
  /aria-pressed="true"/.test(on) && /aria-label="au_zim_toggle"/.test(on) && /title="au_zim_toggle"/.test(on));
ok('a ZIM left alone shows it unpressed', /aria-pressed="false"/.test(off) && /ci-au-off/.test(off));
ok('not for a local file the updater cannot reach', ctx._zimAutoUpdateBtn({ name: 'c', file: 'c.zim' }) === '');
ok('not for a ZIM another program owns', ctx._zimAutoUpdateBtn({ name: 'd', file: 'd_2026-01.zim', external: 'NOMAD' }) === '');
ctx._manageStatusData.auto_update.enabled = false;
ok('not while auto-update is off', ctx._zimAutoUpdateBtn(zims.a) === '');
ctx._manageStatusData.auto_update.enabled = true;

ctx._toggleZimAutoUpdate('a');
ctx._toggleZimAutoUpdate('b');
setTimeout(() => {
  ok('pressing posts the opt-out, the other way for a ZIM already left alone',
    JSON.stringify(posts) === JSON.stringify([
      ['/manage/auto-update-skip', { zim: 'a', skip: true }],
      ['/manage/auto-update-skip', { zim: 'b', skip: false }]]), JSON.stringify(posts));
  ok('the listing entry follows and the list repaints',
    zims.a.auto_update === false && !('auto_update' in zims.b) && ctx.repainted === true);

  const i18n = path.join(root, 'i18n');
  const files = fs.readdirSync(i18n).filter((f) => f.endsWith('.json'));
  const orders = files.map((f) => {
    const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(i18n, f), 'utf8')));
    return keys.indexOf('au_zim_toggle') - keys.indexOf('zi_icon_full');
  });
  ok('the label exists in all ten languages, in the same place', files.length === 10 && orders.every((o) => o === 1), orders.join(','));
  process.exit(failures ? 1 : 0);
}, 20);
