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

ok('the tile is one line in the apps row, fourth', /_appShown\('exchange'\) \? _exchangeTileHtml\(\) : ''\) \+ \(_appShown\('reddot'\) \? _reddotTileHtml\(\) : ''/.test(src));
ok('its empty state is the Create page with a subreddit address started, not the catalog', /var door = _APP_CATEGORY\[app\]/.test(src) && /_createRememberSource = _REDDIT_ADDRESS_START; openCreate\(\);/.test(src) && !/_APP_CATEGORY = \{[^}]*reddot/.test(src));
ok('it is the page Zimi owns, in the reader, with its own history entry', /openReader\(_REDDOT_PAGE \+ '#' \+ _reddotStrings\(p\)\)/.test(src) && /history\.pushState\(st, '', _reddotUrl\(p\)\)/.test(src));
ok('/#reddot opens it cold, with a post when the address names one', /location\.hash === '#reddot' \|\| location\.hash\.indexOf\('#reddot\?'\) === 0/.test(src) && /rdQ\.get\('p'\)/.test(src));
ok('Back and Forward steer the open page, and reload it only when it is gone', /s\.mode === 'reader' && s\.reddot\) \{\n\s*if \(!_appFrameRoute\(_reddotOpen, s\.p\)\) openReddot\(true, s\.p \|\| ''\);/.test(src) && /window\.__route = function\(id\)/.test(page));
ok("the header's arrow steps a post back to its list and a list to the home; at the home the shell leaves", /window\.__back = function\(\) \{\s*if \(!document\.getElementById\('pview'\)\.hidden\) \{ closeP\(\); return true; \}\s*if \(!document\.getElementById\('list'\)\.hidden\) \{ openHome\(\); return true; \}\s*return false;/.test(page));
ok("a post is a step in history; the header's arrow is the only back (no arrow chrome of the page's own); the page says when it is at its top; the dice pick a post", /_appStep\(\{ mode: 'reader', reddot: true, p: d\.p \}/.test(src) && !/class="back"/.test(page) && !/l-back|backlabel/.test(page) && /window\.__top = function\(\) \{ return document\.getElementById\('pview'\)\.hidden && document\.getElementById\('list'\)\.hidden; \};/.test(page) && /fetch\('\/reddot\/random'\)[\s\S]*?openP\(d\.zim, d\.page\)/.test(page));
ok('a post has an address, replaced as you read', /d\.zimi === 'reddot-p' && _reddotOpen[\s\S]*_reddotUrl\(d\.p\)/.test(src) && /tell\(\{ zimi: 'reddot-p', p: zim \+ '\/' \+ page/.test(page));
ok('the page\'s empty state sends people to Create on the Subreddit mode', /goCreate\(\)/.test(page) && /mode: 'reddit'/.test(page) && /d\.zimi === 'create' && d\.mode === 'reddit'/.test(src));
ok('typing asks the page, which asks the library\'s own search across the ZIMs', /_reddotSearch\(val\)/.test(src) && /fetch\('\/search\?q=' \+ encodeURIComponent\(_q\)/.test(page));
ok('no reading controls on it', /!_isExchangePage\(\) && !_isReddotPage\(\)/.test(src));
ok('the breadcrumb is Reddot and the box says what it is for', /bcIcon\.title = t\('reddot'\)/.test(src) && /return t\('reddot_search_placeholder'\)/.test(src) && (src.match(/q\.placeholder = _appPlaceholder\(\)/g) || []).length === 2);
ok('follow a subreddit and Home is their top posts in one list, followed shelves first', /reddot_follow/.test(page) && /function toggleFollow\(zim, sub\)/.test(page) && /function renderHomeFeed\(\)/.test(page) && /isFollowed\(b\.z\.name, b\.s\.subreddit\)/.test(page) && /renderHomeFeed\(\)">' \+ esc\(STR\.home\)/.test(page));
ok('shelves per subreddit, a paged list with Top and New, a post with its comment tree', /class="shelf"/.test(page) && /setSort\(/.test(page) && /'\/reddot\/sub\?zim='/.test(page) && /'\/reddot\/post\?zim='/.test(page) && /function commentHtml\(c\)/.test(page) && /\(c\.children \|\| \[\]\)\.map\(commentHtml\)/.test(page));
ok('the page takes the shared sheet, which holds both themes', /<!--@apps\.css@-->/.test(page) && !/prefers-color-scheme/.test(page));
// the Create page
ok('no Subreddit tile: a reddit.com/r/ address under Web page is a subreddit, and the preview says so', !/id: 'reddit', network: true, reddot: true/.test(create) && /CREATE_REDDIT_DEF = \{ id: 'reddit'/.test(create) && /_createRedditPanel && \(def\.id === 'page' \|\| def\.id === 'site'\)\) def = CREATE_REDDIT_DEF/.test(create) && /p\.mode === 'reddit'/.test(create) && /add\('create_mode_reddit', p\.title\)/.test(create) && /reddit: \{ name: 'ArcticZim'/.test(create));
ok('Reddot\'s doors open Create with the address started', /_REDDIT_ADDRESS_START = 'https:\/\/www\.reddit\.com\/r\/Kiwix'/.test(src) && (src.match(/_createRememberSource = _REDDIT_ADDRESS_START/g) || []).length === 2 && /seedEl\.dispatchEvent\(new Event\('input'\)\)/.test(create));
ok('the Create page can be opened on a remembered mode', /if \(typeof _createRememberMode === 'string' && _createRememberMode\) \{\n\s*_createSelected = _createRememberMode;/.test(create));
for (const lang of fs.readdirSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n', lang), 'utf8'));
  if (d.reddot !== 'Reddot') ok('it is called Reddot in ' + lang, false);
  for (const k of ['reddot_search_placeholder', 'reddot_comments', 'reddot_empty', 'app_empty_reddot', 'create_mode_reddit', 'create_pv_reddit_what', 'reddot_home', 'reddot_follow', 'reddot_following', 'reddot_home_hint']) if (!d[k]) ok(k + ' in ' + lang, false);
}
process.exit(failures ? 1 : 0);
