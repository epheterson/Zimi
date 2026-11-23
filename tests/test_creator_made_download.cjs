// Create page, the table of ZIMs made here: each row carries a Download that
// is the card menu's own download (one function, _downloadZimFile), and the
// sort headers and the name link are untouched.
//
// Run: node tests/test_creator_made_download.cjs   (exit 0 = pass)

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

const nav = [];
const ctx = {
  encodeURIComponent, JSON, Object,
  t: (k) => k, tH: (k) => k,
  esc: (s) => String(s).replace(/[&<>]/g, ''),
  escAttr: (s) => String(s).replace(/"/g, '&quot;'),
  fmtBytes: (n) => n + 'B', _relTime: () => 'now',
  _creatorSort: { key: 'title', dir: 1 },
  _CREATOR_TYPE_KEYS: { page: 'k_page' },
  _creatorMadeChip: () => '',
  _zimInfo: (n) => (n === 'wiki' ? { file: 'wiki_2026-01.zim' } : null),
  manageFetch: (url, opts) => { ctx.fetched = [url, JSON.parse(opts.body)]; return Promise.resolve({ json: () => Promise.resolve({ ticket: 'tk' }) }); },
  location: { set href(v) { nav.push(v); } },
};
vm.createContext(ctx);
vm.runInContext(extract(/var _DOWNLOAD_GLYPH = .*;/, 'glyph'), ctx);
vm.runInContext(extract(/function _creatorMadeHtml\(d\) \{[\s\S]*?\n\}/, '_creatorMadeHtml'), ctx);
vm.runInContext(extract(/function _downloadZimFile\(zim\) \{[\s\S]*?\n\}/, '_downloadZimFile'), ctx);

const html = ctx._creatorMadeHtml({
  created_counts: { page: 1 },
  created_list: [{ name: 'wiki', title: 'Wiki', type: 'page', size_bytes: 10, created_ts: 1 }],
});
ok('a row has a Download button on the shared function',
  /<button[^>]*class="ci-gear cr-made-dl"[^>]*data-zim="wiki"[^>]*onclick="_downloadZimFile\(this\.dataset\.zim\)"/.test(html));
ok('with an aria-label and a title from the existing key',
  /title="ctx_download_zim"/.test(html) && /aria-label="ctx_download_zim"/.test(html));
ok('four sort headers still, plus one unlabelled actions header',
  (html.match(/onclick="_creatorSortBy\(/g) || []).length === 4 && /<th><\/th>/.test(html));
ok('the name link is still the row link', /<a href="\/w\/wiki"[^>]*_spaSourceClick/.test(html));
ok('the card menu calls the same function', /action === 'download-zim'\) \{\s*closeCtx\(\);\s*_downloadZimFile\(zim\);/.test(src));

ctx._downloadZimFile('wiki');
setTimeout(() => {
  ok('it asks for a ticket for the file, then navigates with it',
    ctx.fetched && ctx.fetched[0] === '/manage/dl-ticket' && ctx.fetched[1].file === 'wiki_2026-01.zim'
    && nav[0] === '/dl/wiki_2026-01.zim?t=tk', JSON.stringify(nav));
  process.exit(failures ? 1 : 0);
}, 20);
