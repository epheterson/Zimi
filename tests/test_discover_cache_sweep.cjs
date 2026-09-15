// Discover's stale-cache sweep must not eat settings.
//
// It matched on prefix: anything starting "zimi_d". Three real settings start
// that way, and one of them is zimi_darken_articles. So every Discover render
// deleted the person's choice and it snapped back to its default.
//
// That is the whole of #65, "Darken articles is always set". Three releases
// went into the darkening logic while the setting was being deleted underneath
// it. Eric found it on 1.9.4: "if i reload the page simulate stays unchecked
// but if I exit manage and re-enter it's checked again" — exiting manage
// returns to the home view, which renders Discover, which ran the sweep.
//
// A cache key is zimi_<stamp>_<YYYY-MM-DD>. The date is what makes it a cache
// key rather than a setting, so the date is what the sweep matches on.
//
// Run: node tests/test_discover_cache_sweep.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src.slice(src.indexOf('var _DISCOVER_CACHE_KEY_RE'),
                          src.indexOf('\n', src.indexOf('var _DISCOVER_CACHE_KEY_RE'))), sandbox);
const matches = (k) => sandbox._DISCOVER_CACHE_KEY_RE.test(k);

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

// ── swept: real cache keys ─────────────────────────────────────────────────
check(matches('zimi_disc6_2026-09-14'), 'a dated cache key is swept');
check(matches('zimi_disc7_2025-01-01'), 'so is one from an older stamp');
check(matches('zimi_d_2026-09-14'), 'and a one-letter stamp, which is still dated');

// ── kept: every setting, named individually ────────────────────────────────
// Listed out rather than generated, because the point is that these exact
// names were being deleted and a future prefix change must trip over them.
for (const key of [
  'zimi_darken_articles',   // #65
  'zimi_disc_scroll',
  'zimi_dl_filter',
  'zimi_article_theme',
  'zimi_app_theme',
  'zimi_bookmarks',
  'zimi_history',
  'zimi_manage_pw',
  'zimi_reader_theme',
  'zimi_library_sort',
]) {
  check(!matches(key), key + ' survives the sweep');
}

// A setting that acquires a date-shaped suffix later would be a real trap, so
// the boundary is anchored at both ends.
check(!matches('zimi_disc6_2026-09-14_extra'), 'a trailing segment is not a cache key');
check(!matches('prefix_zimi_disc6_2026-09-14'), 'nor is a key merely containing one');

// ── and the sweep actually uses it ─────────────────────────────────────────
const loader = src.slice(src.indexOf('function _loadDiscover('),
                         src.indexOf('function _loadDiscover(') + 4000);
check(/_DISCOVER_CACHE_KEY_RE\.test\(k\)/.test(loader), 'the sweep tests the shape');
check(!/k\.indexOf\('zimi_d'\) === 0/.test(loader), 'and no longer matches on prefix');

console.log('');
if (failures) {
  console.error(failures + ' discover-sweep check(s) failed');
  process.exit(1);
}
console.log('all discover cache sweep checks passed');
