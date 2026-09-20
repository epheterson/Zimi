// ZimiExchange, the surface: a tile in the apps row, a page Zimi owns in the
// reader, the top bar's box asking the library's own search across the
// sites, a question with an address of its own.
//
// Run: node tests/test_exchange_surface.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const page = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'exchange.html'), 'utf8');
let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

ok('the tile is one line in the apps row, like the others', /_exchangeTileHtml\(\) \{\n\s*return _appTileHtml\('exchange', t\('exchange'\), _EXCHANGE_SVG, _installedQaZims\(\)/.test(src) && /_mapsTileHtml\(\) \+ _tubeTileHtml\(\) \+ _exchangeTileHtml\(\)/.test(src));
ok('it is the page Zimi owns, in the reader, with its own history entry', /openReader\(_EXCHANGE_PAGE \+ '#' \+ _exchangeStrings\(q\)\)/.test(src) && /history\.pushState\(st, '', _exchangeUrl\(q\)\)/.test(src));
ok('/#exchange opens it cold, with a question when the address names one', /location\.hash === '#exchange' \|\| location\.hash\.indexOf\('#exchange\?'\) === 0/.test(src) && /exQ\.get\('q'\)/.test(src));
ok('Back and Forward return to it', /s\.mode === 'reader' && s\.exchange\) \{\n\s*openExchange\(true, s\.q \|\| ''\);/.test(src));
ok('a question has an address, replaced as you read', /d\.zimi === 'exchange-q' && _exchangeOpen[\s\S]*_exchangeUrl\(d\.q\)/.test(src) && /tell\(\{ zimi: 'exchange-q', q: zim \+ '\/' \+ page/.test(page));
ok('typing asks the page, which asks the library\'s own search across the sites', /_exchangeSearch\(val\)/.test(src) && /fetch\('\/search\?q=' \+ encodeURIComponent\(_q\) \+ '&zim=' \+ encodeURIComponent\(zims\)/.test(page) && /\/\^questions\\\/\\d\+\\\//.test(page));
ok('no reading controls on it', /!_isTubePage\(\) && !_isExchangePage\(\)/.test(src));
ok('the breadcrumb is ZimiExchange and the box says what it is for', /bcIcon\.title = t\('exchange'\)/.test(src) && (src.match(/q\.placeholder = t\('exchange_search_placeholder'\)/g) || []).length === 2);
ok('shelves per site with tags, a paged list per site or tag, a question view with answers', /class="shelf"/.test(page) && /openTag\(/.test(page) && /'\/exchange\/site\?zim='/.test(page) && /'\/exchange\/q\?zim='/.test(page) && /q-answers/.test(page));
ok('a link to another question stays inside ZimiExchange', /a\[data-q\]/.test(page));
ok('the empty page is a door to the Q&A category', /category: 'stack_exchange'/.test(page));
ok('the page takes the shared sheet, which holds both themes', /<!--@apps\.css@-->/.test(page) && !/prefers-color-scheme/.test(page));
for (const lang of fs.readdirSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n', lang), 'utf8'));
  if (d.exchange !== 'ZimiExchange') ok('it is called ZimiExchange in ' + lang, false);
  for (const k of ['exchange_search_placeholder', 'exchange_answers', 'exchange_empty', 'app_empty_exchange']) if (!d[k]) ok(k + ' in ' + lang, false);
}
process.exit(failures ? 1 : 0);
