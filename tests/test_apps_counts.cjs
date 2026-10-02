// The Apps page counts what each app shows, not ZIM entries (1.12.1).
//
// A Gutenberg ZIM's card under Bookshelf said "900,000 entries" (its pages,
// covers and EPUBs together) where the shelf shows 60,000 books; a TED ZIM
// under ZimiTube counted its subtitles and thumbnails. Each card now counts
// what its app shows: books, videos, questions, posts, a wiki's articles,
// and a map by its publisher. The counts come with the library's list
// (server.note_app_items, noted when an app read them anyway), so drawing
// the page reads nothing.
//
// Run: node tests/test_apps_counts.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n', 'en.json'), 'utf8'));
let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}
function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from app.js');
  return m[0];
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ctx = {
  esc,
  tPlural: (base, n, vars) => {
    const key = base + '_' + (n === 1 ? 'one' : 'other');
    return String(en[key] || key).replace('{n}', (vars && vars.n) || n);
  },
};
vm.createContext(ctx);
vm.runInContext([
  extract(/function _mapSourceLabel\(z\) \{[\s\S]*?\n\}/, '_mapSourceLabel'),
  extract(/function _appItemsCount\(app, z\) \{[\s\S]*?\n\}/, '_appItemsCount'),
  extract(/function _appItemsHtml\(app, z\) \{[\s\S]*?\n\}/, '_appItemsHtml'),
].join('\n'), ctx);
const html = (app, z) => ctx._appItemsHtml(app, z);

const gutenberg = { name: 'gutenberg_en_all', kind: 'books', entries: 900000, article_count: 180000, items: { books: 60366 } };
ok('a Gutenberg ZIM counts its books, as the shelf read them', html('books', gutenberg) === '60,366 books', html('books', gutenberg));
ok('a whole-ZIM book is one book', html('books', { name: 'htdp', feeds: { books: 'whole' }, entries: 1500 }) === '1 book');
ok('a shelf not read yet says nothing rather than its entries', html('books', { name: 'wikisource', entries: 90000, article_count: 40000 }) === '');
const ted = { name: 'ted', kind: 'video', entries: 5000, shape: { breakdown: [{ key: 'video', count: 312 }, { key: 'images', count: 900 }, { key: 'data', count: 2000 }] } };
ok('a video ZIM ZimiTube has not opened counts its video files, not its thumbnails', html('tube', ted) === '312 videos', html('tube', ted));
ok('and what ZimiTube offers once it has read the ZIM', html('tube', Object.assign({ items: { tube: 305 } }, ted)) === '305 videos');
ok('a Q&A site counts its questions', html('exchange', { name: 'askubuntu', entries: 300000, article_count: 250000, items: { exchange: 1200 } }) === '1,200 questions');
ok('a subreddit ZIM counts its posts', html('reddot', { name: 'r_kiwix', entries: 3000, items: { reddot: 1 } }) === '1 post');
ok('a wiki counts its articles, and says so', html('wiki', { name: 'wikipedia', entries: 9000000, article_count: 6000000 }) === '6,000,000 articles');
ok('a map is named by its publisher, not counted in tiles', html('maps', { name: 'osm-hawaii', entries: 20000 }) === 'StreetZim');
ok('an unknown count leaves the card its size alone', /\[countOf\(z\), fmtSize\(z\.size_gb\)\]\.filter\(Boolean\)\.join\(' &middot; '\)/.test(src));
ok('the Apps page hands each app\'s count to its cards', /renderCardGrid\(zims, true, false, function\(z\) \{ return _appItemsHtml\(app, z\); \}\)/.test(src));
ok('the rest of the library keeps its entries', /countOf = countOf \|\| _zimCountHtml;/.test(src));
ok('the Apps page\'s totals line counts no entries', /homeScope && homeScope\.type === 'apps' \? '' : t\('articles_count'/.test(src));
ok('counting reads only the library list: no fetch', !/fetch\(/.test(extract(/function _appItemsCount\(app, z\) \{[\s\S]*?\n\}/, 'c') + extract(/function _appItemsHtml\(app, z\) \{[\s\S]*?\n\}/, 'h')));

// Every language has every app's count, in each of its plural forms.
const dir = path.join(__dirname, '..', 'zimi', 'static', 'i18n');
const missing = [];
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const app of ['books', 'tube', 'exchange', 'reddot', 'wiki']) {
    for (const form of ['one', 'other']) if (!d['app_items_' + app + '_' + form]) missing.push(f + ':' + app + '_' + form);
  }
}
ok('every language counts every app', !missing.length, missing.join(' '));

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
