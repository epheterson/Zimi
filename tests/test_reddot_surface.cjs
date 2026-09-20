// Reddot, the surface: a tile in the apps row whose empty state is the
// Create page (nobody publishes subreddit ZIMs; you make them), a page Zimi
// owns in the reader, a post with an address of its own, and the Subreddit
// mode on the Create page.
//
// Run: node tests/test_reddot_surface.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const create = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'create.js'), 'utf8').replace(/\r\n/g, '\n');
const page = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'reddot.html'), 'utf8');
let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

ok('the tile is one line in the apps row, fourth', /_mapsTileHtml\(\) \+ _tubeTileHtml\(\) \+ _exchangeTileHtml\(\) \+ _reddotTileHtml\(\)/.test(src));
ok('its empty state is the Create page on the Subreddit mode, not the catalog', /var door = _APP_CATEGORY\[app\]/.test(src) && /_createRememberMode = \\'reddit\\'; openCreate\(\);/.test(src) && /var _APP_CATEGORY = \{ maps: 'maps', tube: 'ted', exchange: 'stack_exchange' \};/.test(src));
ok('it is the page Zimi owns, in the reader, with its own history entry', /openReader\(_REDDOT_PAGE \+ '#' \+ _reddotStrings\(p\)\)/.test(src) && /history\.pushState\(st, '', _reddotUrl\(p\)\)/.test(src));
ok('/#reddot opens it cold, with a post when the address names one', /location\.hash === '#reddot' \|\| location\.hash\.indexOf\('#reddot\?'\) === 0/.test(src) && /rdQ\.get\('p'\)/.test(src));
ok('Back and Forward return to it', /s\.mode === 'reader' && s\.reddot\) \{\n\s*openReddot\(true, s\.p \|\| ''\);/.test(src));
ok('a post has an address, replaced as you read', /d\.zimi === 'reddot-p' && _reddotOpen[\s\S]*_reddotUrl\(d\.p\)/.test(src) && /tell\(\{ zimi: 'reddot-p', p: zim \+ '\/' \+ page/.test(page));
ok('the page\'s empty state sends people to Create on the Subreddit mode', /goCreate\(\)/.test(page) && /mode: 'reddit'/.test(page) && /d\.zimi === 'create' && d\.mode === 'reddit'/.test(src));
ok('typing asks the page, which asks the library\'s own search across the ZIMs', /_reddotSearch\(val\)/.test(src) && /fetch\('\/search\?q=' \+ encodeURIComponent\(_q\)/.test(page));
ok('no reading controls on it', /!_isExchangePage\(\) && !_isReddotPage\(\)/.test(src));
ok('the breadcrumb is Reddot and the box says what it is for', /bcIcon\.title = t\('reddot'\)/.test(src) && (src.match(/q\.placeholder = t\('reddot_search_placeholder'\)/g) || []).length === 2);
ok('shelves per subreddit, a paged list with Top and New, a post with its comment tree', /class="shelf"/.test(page) && /setSort\(/.test(page) && /'\/reddot\/sub\?zim='/.test(page) && /'\/reddot\/post\?zim='/.test(page) && /function commentHtml\(c\)/.test(page) && /\(c\.children \|\| \[\]\)\.map\(commentHtml\)/.test(page));
ok('the page takes the shared sheet, which holds both themes', /<!--@apps\.css@-->/.test(page) && !/prefers-color-scheme/.test(page));
// the Create page
ok('the Create page offers a Subreddit mode that needs the internet', /id: 'reddit', network: true, reddot: true/.test(create) && /if \(def\.reddot\) return false;/.test(create));
ok('the Create page can be opened on a remembered mode', /if \(typeof _createRememberMode === 'string' && _createRememberMode\) \{\n\s*_createSelected = _createRememberMode;/.test(create));
for (const lang of fs.readdirSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n', lang), 'utf8'));
  if (d.reddot !== 'Reddot') ok('it is called Reddot in ' + lang, false);
  for (const k of ['reddot_search_placeholder', 'reddot_comments', 'reddot_empty', 'app_empty_reddot', 'create_mode_reddit', 'create_mode_reddit_desc', 'create_label_reddit', 'create_ph_reddit']) if (!d[k]) ok(k + ' in ' + lang, false);
}
process.exit(failures ? 1 : 0);
