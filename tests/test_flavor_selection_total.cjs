// Catalog flavor switch must re-total the selection bar (Eric bug: check a
// ZIM, change its flavor, bottom-pill total kept the OLD flavor's size).
//
// Guards the extractable core of the fix:
//
// 1. _reselectDownloadUrl re-keys a SELECTED item from the old flavor URL to
//    the new one, carrying the new byte size, and reports a change so the
//    caller repaints the bar. Unselected items and no-op switches return
//    false and leave the map alone.
// 2. The selection-bar total (sum of _selectedDownloads values, exactly as
//    _renderSelectionBar computes it) reflects the newly chosen flavor.
// 3. renderCatalogItem's variant objects carry raw `bytes` alongside the
//    formatted size string, so selectCatalogFlavor has a number to hand over.
//
// Same vm-extraction approach as test_bookmark_rename.cjs.
//
// Run: node tests/test_flavor_selection_total.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from app.js');
  return m[0];
}

let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  // const at vm top level does not attach to the sandbox — rewrite to var.
  extract(/const _selectedDownloads = new Map\(\);[^\n]*/, '_selectedDownloads').replace('const ', 'var ') +
  '\n' +
  extract(/function _reselectDownloadUrl\(oldUrl, newUrl, bytes\)\s*\{[\s\S]*?\n\}/, '_reselectDownloadUrl'),
  sandbox);

const sel = sandbox._selectedDownloads;
const total = () => Array.from(sel.values()).reduce((a, b) => a + b, 0);

// ── Selected item, flavor switched: re-keyed, total follows the new size ──
sel.clear();
sel.set('http://x/wiki_full.zim', 90_000_000_000);
sel.set('http://x/other.zim', 1_000);
let changed = sandbox._reselectDownloadUrl('http://x/wiki_full.zim', 'http://x/wiki_mini.zim', 5_000_000_000);
ok('selected item re-keys on flavor switch', changed === true);
ok('old URL dropped from selection', !sel.has('http://x/wiki_full.zim'));
ok('new URL present with new size', sel.get('http://x/wiki_mini.zim') === 5_000_000_000);
ok('bar total re-computes to new flavor', total() === 5_000_001_000, 'got ' + total());
ok('unrelated selection untouched', sel.get('http://x/other.zim') === 1_000);

// ── Unselected item: switching flavor is a no-op on the selection ──
sel.clear();
sel.set('http://x/other.zim', 1_000);
changed = sandbox._reselectDownloadUrl('http://x/wiki_full.zim', 'http://x/wiki_mini.zim', 5);
ok('unselected item does not re-key', changed === false);
ok('selection map unchanged for unselected item', sel.size === 1 && total() === 1_000);

// ── Same-URL switch (picker re-picks current flavor): no churn ──
sel.clear();
sel.set('http://x/wiki_full.zim', 90);
changed = sandbox._reselectDownloadUrl('http://x/wiki_full.zim', 'http://x/wiki_full.zim', 90);
ok('same-URL switch is a no-op', changed === false && sel.get('http://x/wiki_full.zim') === 90);

// ── Missing byte size falls back to 0, never NaN ──
sel.clear();
sel.set('u1', 10);
sandbox._reselectDownloadUrl('u1', 'u2', undefined);
ok('undefined bytes coerces to 0 (no NaN total)', sel.get('u2') === 0 && total() === 0);

// ── Wiring: variant objects expose raw bytes; selectCatalogFlavor syncs cb ──
ok('withLabels variants carry raw bytes',
  /return \{ label, size, url: v\.download_url, bytes: v\.size_bytes \|\| 0 \};/.test(src));
const scf = extract(/function selectCatalogFlavor\(optionEl, index\)\s*\{[\s\S]*?\n\}/, 'selectCatalogFlavor');
ok('selectCatalogFlavor re-keys via _reselectDownloadUrl', scf.includes('_reselectDownloadUrl(cb.dataset.url, v.url, v.bytes)'));
ok('selectCatalogFlavor repaints the selection bar', scf.includes('_renderSelectionBar()'));
ok('selectCatalogFlavor updates checkbox dataset', scf.includes("cb.dataset.url = v.url") && scf.includes("cb.dataset.size = String(v.bytes || 0)"));

process.exit(failures ? 1 : 0);
