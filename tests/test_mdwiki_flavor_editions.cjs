// MDWiki ships TWO builds under one OPDS name (#50): the unsuffixed complete
// build (mdwiki_en_all_2025-11.zim, 10.75 GB, includes video) and the maxi
// build (mdwiki_en_all_maxi_2025-11.zim, 2.30 GB). Zimi labeled both "Full",
// so the catalog dropdown showed two identical rows, the library flavor pill
// marked BOTH as current (nothing switchable), the installed-detection prefix
// match let each entry claim the other's file, and the card's Update button
// could download the other edition alongside the installed one.
//
// Guards the extractable core of the fix:
//
// 1. _flavorToken — filename flavor token (client twin of _detect_flavor).
// 2. variantLabel with sibling URLs — unsuffixed next to a maxi sibling says
//    "Full + video", never a second "Full".
// 3. groupVariants/_newestPerFlavor — same name + same token = date editions;
//    only the NEWEST renders (task fixture: two maxi editions → one row).
// 4. _flavorOrder — maxi outranks the unsuffixed video build under the
//    default "full" preference, so the big video edition is never the
//    silent default download.
// 5. getFlavorVariants — "current" compares tokens, not rendered labels:
//    exactly one checkmark, the other edition stays switchable.
// 6. _enrichCatalogInstalled — flavor-aware matching: only the truly
//    installed edition claims the file (loose fallback still covers a
//    delisted flavor so the badge survives).
//
// Same vm-extraction approach as test_flavor_selection_total.cjs.
//
// Run: node tests/test_mdwiki_flavor_editions.cjs   (exit 0 = pass)

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

// English strings the extracted functions resolve through t().
const STRINGS = { full: 'Full', full_video: 'Full + video', no_images: 'No images', mini: 'Mini' };
const sandbox = {
  t: k => STRINGS[k] || k,
  formatSize: b => String(b),
  _getPrefFlavor: () => 'full',
  _catalogCache: null,
  zimsCache: null,
};
vm.createContext(sandbox);
vm.runInContext(
  extract(/function _flavorToken\(url\)\s*\{[\s\S]*?\n\}/, '_flavorToken') + '\n' +
  extract(/function _newestPerFlavor\(list\)\s*\{[\s\S]*?\n\}/, '_newestPerFlavor') + '\n' +
  extract(/function variantLabel\(url, siblingUrls\)\s*\{[\s\S]*?\n\}/, 'variantLabel') + '\n' +
  extract(/function groupVariants\(items\)\s*\{[\s\S]*?\n\}/, 'groupVariants') + '\n' +
  extract(/const _FLAVOR_RANKS = \{[\s\S]*?\};/, '_FLAVOR_RANKS').replace('const ', 'var ') + '\n' +
  extract(/function _flavorOrder\(url\)\s*\{[\s\S]*?\n\}/, '_flavorOrder') + '\n' +
  extract(/function getFlavorVariants\(installedZim\)\s*\{[\s\S]*?\n\}/, 'getFlavorVariants') + '\n' +
  extract(/function _enrichCatalogInstalled\(items\)\s*\{[\s\S]*?\n\}/, '_enrichCatalogInstalled'),
  sandbox);

// The two real catalog entries for mdwiki_en_all (live Kiwix OPDS shape).
const MDWIKI_VIDEO = {
  name: 'mdwiki_en_all', title: 'MDWiki Medical Encyclopedia', date: '2025-11-14',
  download_url: 'https://lb.download.kiwix.org/zim/other/mdwiki_en_all_2025-11.zim.meta4',
  size_bytes: 10752257024, article_count: 50000,
};
const MDWIKI_MAXI = {
  name: 'mdwiki_en_all', title: 'MDWiki Medical Encyclopedia', date: '2025-11-12',
  download_url: 'https://lb.download.kiwix.org/zim/other/mdwiki_en_all_maxi_2025-11.zim.meta4',
  size_bytes: 2302838784, article_count: 50000,
};

// ── _flavorToken: filename is the flavor identity ──
ok('token: maxi from .zim.meta4 URL', sandbox._flavorToken(MDWIKI_MAXI.download_url) === 'maxi');
ok('token: unsuffixed build is null', sandbox._flavorToken(MDWIKI_VIDEO.download_url) === null);
ok('token: nopic file', sandbox._flavorToken('wikipedia_en_100_nopic_2026-07.zim') === 'nopic');
ok('token: mini file', sandbox._flavorToken('wikipedia_en_100_mini_2026-07.zim') === 'mini');
ok('token: no false positive on topic names', sandbox._flavorToken('devdocs_en_minitest_2026-01.zim') === null);

// ── variantLabel: never two identical "Full" rows in one group ──
const urls = [MDWIKI_VIDEO.download_url, MDWIKI_MAXI.download_url];
const labelVideo = sandbox.variantLabel(MDWIKI_VIDEO.download_url, urls) || sandbox.t('full');
const labelMaxi = sandbox.variantLabel(MDWIKI_MAXI.download_url, urls) || sandbox.t('full');
ok('maxi labels "Full"', labelMaxi === 'Full', 'got ' + labelMaxi);
ok('unsuffixed sibling labels "Full + video"', labelVideo === 'Full + video', 'got ' + labelVideo);
ok('labels differ (the #50 bug)', labelVideo !== labelMaxi);
ok('unsuffixed WITHOUT maxi sibling keeps default label',
  (sandbox.variantLabel('https://x/foo_en_all_2026-01.zim.meta4', ['https://x/foo_en_all_2026-01.zim.meta4']) || 'Full') === 'Full');

// ── groupVariants: the mdwiki pair stays two variants, one card ──
let groups = sandbox.groupVariants([MDWIKI_VIDEO, MDWIKI_MAXI]);
ok('mdwiki groups to one card', groups.length === 1);
ok('both flavors survive grouping', groups[0].variants.length === 2);
ok('group date is the newest edition', groups[0].date === '2025-11-14');

// ── groupVariants: same name + SAME token = date editions → newest only ──
const MAXI_OLD = { ...MDWIKI_MAXI, date: '2025-05-10',
  download_url: 'https://lb.download.kiwix.org/zim/other/mdwiki_en_all_maxi_2025-05.zim.meta4' };
groups = sandbox.groupVariants([MAXI_OLD, MDWIKI_MAXI]);
ok('two same-flavor editions collapse to one row', groups.length === 1 && groups[0].variants.length === 1);
ok('the NEWER edition wins', groups[0].variants[0].download_url === MDWIKI_MAXI.download_url);
groups = sandbox.groupVariants([MDWIKI_MAXI, MAXI_OLD]); // order must not matter
ok('newer edition wins regardless of catalog order',
  groups[0].variants.length === 1 && groups[0].variants[0].download_url === MDWIKI_MAXI.download_url);

// ── _flavorOrder: the video build is never the silent default download ──
const sorted = [MDWIKI_VIDEO.download_url, MDWIKI_MAXI.download_url]
  .sort((a, b) => sandbox._flavorOrder(b) - sandbox._flavorOrder(a));
ok('default "full" preference picks maxi over the video build',
  sorted[0] === MDWIKI_MAXI.download_url);

// ── getFlavorVariants: token-based "current", exactly one checkmark ──
sandbox._catalogCache = [MDWIKI_VIDEO, MDWIKI_MAXI];
let variants = sandbox.getFlavorVariants({ file: 'mdwiki_en_all_maxi_2025-11.zim' });
ok('installed maxi: two dropdown rows', variants.length === 2);
ok('installed maxi: exactly ONE current', variants.filter(v => v.current).length === 1);
ok('installed maxi: current is the maxi ("Full") row',
  (variants.find(v => v.current) || {}).label === 'Full');
ok('installed maxi: the other row is switchable and says video',
  (variants.find(v => !v.current) || {}).label === 'Full + video');

variants = sandbox.getFlavorVariants({ file: 'mdwiki_en_all_2025-11.zim' });
ok('installed video build: current is "Full + video"',
  variants.filter(v => v.current).length === 1 &&
  (variants.find(v => v.current) || {}).label === 'Full + video');

// Same-token date editions in the raw cache must not double a dropdown row.
sandbox._catalogCache = [MAXI_OLD, MDWIKI_MAXI, MDWIKI_VIDEO];
variants = sandbox.getFlavorVariants({ file: 'mdwiki_en_all_maxi_2025-05.zim' });
ok('stale cache edition dedupes in the pill dropdown', variants.length === 2);

// ── _enrichCatalogInstalled: each entry claims only ITS edition ──
function freshItems() { return [{ ...MDWIKI_VIDEO }, { ...MDWIKI_MAXI }]; }
sandbox.zimsCache = [{ file: 'mdwiki_en_all_maxi_2025-11.zim', name: 'mdwiki_en_all_maxi', size_gb: 2.3 }];
let items = freshItems();
sandbox._enrichCatalogInstalled(items);
ok('maxi install: maxi entry claims it', items[1].installed === true &&
  items[1]._installedFile === 'mdwiki_en_all_maxi_2025-11.zim');
ok('maxi install: video entry does NOT claim it', items[0].installed === false);

sandbox.zimsCache = [{ file: 'mdwiki_en_all_2025-11.zim', name: 'mdwiki_en_all', size_gb: 10.7 }];
items = freshItems();
sandbox._enrichCatalogInstalled(items);
ok('video install: video entry claims it', items[0].installed === true);
ok('video install: maxi entry does NOT claim it', items[1].installed === false);

// Uninstall → both entries clear → the card offers a plain download again.
sandbox.zimsCache = [];
items = freshItems();
items[0].installed = items[1].installed = true; // stale flags from last render
sandbox._enrichCatalogInstalled(items);
ok('after uninstall nothing claims the group', !items[0].installed && !items[1].installed);

// Delisted-flavor fallback: an installed nopic whose catalog entry vanished
// still badges the group (loose pass) instead of inviting a re-download.
sandbox.zimsCache = [{ file: 'mdwiki_en_all_nopic_2024-06.zim', name: 'mdwiki_en_all_nopic', size_gb: 1.1 }];
items = freshItems();
sandbox._enrichCatalogInstalled(items);
ok('delisted flavor still marks the group installed',
  items.some(it => it.installed && it._installedFile === 'mdwiki_en_all_nopic_2024-06.zim'));

// ── Wiring: the Update button follows the installed edition's flavor ──
const rci = extract(/function renderCatalogItem\(group\)\s*\{[\s\S]*?\n\}/, 'renderCatalogItem');
ok('update pick is token-matched to the installed file',
  rci.includes("_flavorToken(v.download_url) === instTok"));
ok('update button downloads the SAME-flavor edition',
  rci.includes("downloadZim(\\'' + escAttr(updVariant.download_url)"));
ok('catalog dropdown labels are sibling-aware',
  rci.includes('variantLabel(v.download_url, vUrls)'));

process.exit(failures ? 1 : 0);
