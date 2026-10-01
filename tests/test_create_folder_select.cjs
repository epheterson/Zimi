// Folder mode's tree selection, driven out of the shipped create.js.
//
// The tree is lazy (one folder level per request), so the selection has to
// mean the right thing over a tree that is only partly known: ticking a
// folder takes all of it, listed or not; unticking one file inside a ticked
// folder keeps every other thing in it ticked; ticking the last unticked
// child of a fully listed folder is the folder; and the request names one
// folder, or the folder a subset shares plus the subset.
//
// Same approach as tests/test_create_ui.cjs: slice the pure prefix of the
// file and run it in a sandbox, so the test drives the real code.
//
// Run: node tests/test_create_folder_select.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'create.js'), 'utf8');
const MARKER = '// ── the surface ──';
const cut = SRC.indexOf(MARKER);
if (cut < 0) throw new Error('the pure/DOM boundary marker moved: update this test');
const APP = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
const STOP_BLOCK = APP.match(/\/\/ ── why a capture stopped ──[\s\S]*?\/\/ ── end why a capture stopped ──/);

const sandbox = { t: (k) => k, URL: URL, _fmtBytes: (b) => b + ' B' };
vm.createContext(sandbox);
if (STOP_BLOCK) vm.runInContext(STOP_BLOCK[0] + '\n', sandbox);
vm.runInContext(SRC.slice(0, cut), sandbox);

let failures = 0;
function eq(got, want, label) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

const S = sandbox;
for (const name of ['_createTreeToggle', '_createTreeState', '_createTreeRequest', '_createTreeSplitNeeds', '_createBuildRequest', '_createBodyKey', '_createPreviewRows']) {
  if (typeof S[name] !== 'function') { console.error('FAIL: ' + name + ' is missing from create.js'); process.exit(1); }
}

// root
//   docs/            (listed, complete)
//     a.pdf  b.pdf  img/ (listed, complete: x.png y.png)
//   media/           (listed, NOT complete: more to load)
//     v.mp4
//   notes.md
const tree = {
  kind: { '': 'dir', docs: 'dir', 'docs/a.pdf': 'file', 'docs/b.pdf': 'file', 'docs/img': 'dir',
    'docs/img/x.png': 'file', 'docs/img/y.png': 'file', media: 'dir', 'media/v.mp4': 'file', 'notes.md': 'file' },
  kids: { '': ['docs', 'media', 'notes.md'], docs: ['docs/img', 'docs/a.pdf', 'docs/b.pdf'],
    'docs/img': ['docs/img/x.png', 'docs/img/y.png'], media: ['media/v.mp4'] },
  done: { '': true, docs: true, 'docs/img': true, media: false }
};
const keys = (sel) => Object.keys(sel).sort();
const plain = (o) => JSON.parse(JSON.stringify(o));

// Ticking a folder is the folder.
let sel = S._createTreeToggle({}, tree, 'docs');
eq(keys(sel), ['docs'], 'tick a folder');
eq(S._createTreeState(sel, 'docs/img/x.png'), 'on', 'its contents read as ticked');
eq(S._createTreeState(sel, ''), 'mixed', 'the root reads as partly ticked');
eq(plain(S._createTreeRequest(sel, tree)), { source: 'docs', only: [] }, 'one folder ticked: that folder is the root');

// Unticking one file inside splits the folder, level by level.
sel = S._createTreeToggle(sel, tree, 'docs/img/x.png');
eq(keys(sel), ['docs/a.pdf', 'docs/b.pdf', 'docs/img/y.png'], 'untick inside a ticked folder keeps the rest');
eq(S._createTreeState(sel, 'docs'), 'mixed', 'the folder is now partly ticked');
eq(S._createTreeState(sel, 'docs/img'), 'mixed', 'and so is the subfolder');
eq(plain(S._createTreeRequest(sel, tree)), { source: 'docs', only: ['a.pdf', 'b.pdf', 'img/y.png'] },
  'a subset: the shared folder is the root, the rest is relative to it');

// Ticking it back collapses all the way up.
sel = S._createTreeToggle(sel, tree, 'docs/img/x.png');
eq(keys(sel), ['docs'], 'ticking the last child of complete folders collapses to the folder');

// A folder whose listing is not complete never collapses: its unlisted
// files were never ticked.
sel = S._createTreeToggle({}, tree, 'media/v.mp4');
eq(keys(sel), ['media/v.mp4'], 'every listed child of an incomplete folder is not the folder');
eq(S._createTreeState(sel, 'media'), 'mixed', 'the incomplete folder reads as partly ticked');
eq(plain(S._createTreeRequest(sel, tree)), { source: 'media', only: ['v.mp4'] }, 'one file: its folder is the root');

// Unticking inside a ticked folder whose listing is incomplete must load the
// rest first; the pure half says which folders.
eq(plain(S._createTreeSplitNeeds({ media: true }, tree, 'media/v.mp4')), ['media'], 'split needs the incomplete listing');
eq(plain(S._createTreeSplitNeeds({ docs: true }, tree, 'docs/img/x.png')), [], 'complete listings need nothing');

// Things in different folders share the root.
sel = S._createTreeToggle(S._createTreeToggle({}, tree, 'notes.md'), tree, 'docs/a.pdf');
eq(plain(S._createTreeRequest(sel, tree)), { source: '.', only: ['docs/a.pdf', 'notes.md'] }, 'mixed levels share the create root');

// Ticking a folder replaces what was ticked inside it.
sel = S._createTreeToggle({ 'docs/a.pdf': true, 'docs/img/x.png': true }, tree, 'docs');
eq(keys(sel), ['docs'], 'ticking a folder takes over its ticked contents');

// The root itself.
sel = S._createTreeToggle({}, tree, '');
eq(plain(S._createTreeRequest(sel, tree)), { source: '.', only: [] }, 'the whole root');
eq(S._createTreeRequest({}, tree), null, 'nothing ticked is no request');

// The request body carries the subset, and the probe key changes with it.
const body = S._createBuildRequest('folder', { source: 'docs', only: ['a.pdf'], title: '' });
eq(plain(body), { mode: 'folder', source: 'docs', only: ['a.pdf'] }, 'the body carries only');
const whole = S._createBuildRequest('folder', { source: 'docs', only: [], title: '' });
eq(whole.only, undefined, 'a whole folder sends no subset');
eq(S._createBodyKey(body) !== S._createBodyKey(whole), true, 'a different subset is a different probe');
eq(S._createBuildRequest('page', { source: 'https://e.org', only: ['x'] }).only, undefined, 'only belongs to folder mode');

// What the preview says about a folder: totals, families, sidecar facts.
const rows = S._createPreviewRows({
  mode: 'folder', files: 4, bytes: 100, truncated: false, families: { page: 1, document: 2, video: 1 },
  unsupported: 1, plays_some: 1, metadata: { title: 'Box', publisher: 'Me' }, metadata_file: 'zimi.txt', described: 2
});
eq(rows.map((r) => r.k), ['create_pv_files', 'create_folder_fam_page', 'create_folder_fam_document',
  'create_folder_fam_video', 'create_pv_left_out', 'create_pv_plays_some', 'create_pv_meta_file',
  'create_pv_title', 'create_pv_publisher', 'create_pv_described'], 'the folder preview rows');
eq(rows[0].v, '4 · 100 B', 'files and size');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
