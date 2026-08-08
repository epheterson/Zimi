// Primary navigation with a true URL must be a real <a href> (#49).
//
// The Zimi logo, the Almanac entry, home source tiles, search results,
// discover cards, zimgit rows, the breadcrumb icon and the history trail all
// used to be onclick-only elements — so Firefox's right-click menu offered no
// "Open Link in New Tab", and copy-link/drag did nothing. They are anchors
// now, with one interception rule shared by all of them:
//
//   plain left click            -> preventDefault + SPA navigation
//   meta/ctrl/shift/alt, or any -> untouched, so the browser's native link
//   non-primary button             handling (new tab/window/menu) applies
//
// What this locks in:
//   1. The interception matrix of _anchorNativeClick/_spaNav, executed.
//   2. The shipped markup: each element is an <a> carrying its true URL.
//   3. The one exception: a Zimi-export tile embeds its own download <a>,
//      and HTML forbids nested links (the parser would split the card), so
//      that card alone stays a div — and its inner buttons preventDefault so
//      they can never trigger the sibling anchors' navigation pattern.
//   4. The middle-click auxclick fallback skips real anchors (it exists for
//      the remaining div cards; on an anchor it would double-open).
//
// Run: node tests/test_nav_anchors.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'zimi');
const appSrc = fs.readFileSync(path.join(ROOT, 'static', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'templates', 'index.html'), 'utf8');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

// ── 1. Interception matrix, executed from shipped source ─────────────────
const sb = {};
vm.createContext(sb);
vm.runInContext(extractFn(appSrc, '_anchorNativeClick') + '\n' + extractFn(appSrc, '_spaNav'), sb);

function ev(props) {
  let prevented = false;
  return Object.assign({ button: 0, preventDefault() { prevented = true; }, get __prevented() { return prevented; } }, props);
}

check(sb._anchorNativeClick(ev({})) === false, 'plain left click is the SPA case');
for (const mod of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
  check(sb._anchorNativeClick(ev({ [mod]: true })) === true, mod + '-click stays native');
}
check(sb._anchorNativeClick(ev({ button: 1 })) === true, 'middle button stays native');
check(sb._anchorNativeClick(ev({ button: 2 })) === true, 'secondary button stays native');
check(sb._anchorNativeClick(null) === false, 'no event (keyboard-Enter synthetic path) is the SPA case');

let ran = false;
let e1 = ev({});
check(sb._spaNav(e1, () => { ran = true; }) === false && ran && e1.__prevented,
  '_spaNav on a plain click: preventDefault + run the SPA action + cancel the href');
ran = false;
let e2 = ev({ metaKey: true });
check(sb._spaNav(e2, () => { ran = true; }) === true && !ran && !e2.__prevented,
  '_spaNav on a modified click: no interception at all — the browser follows the href');

// ── 2. Shipped markup: real anchors with true URLs ───────────────────────
check(/<a id="logo" class="logo" href="\/"/.test(html), 'logo is <a href="/"> (index.html)');
check(/<a id="bc-icon" class="bc-icon"/.test(html), 'breadcrumb icon is an <a> (index.html)');
check(/bcIcon\.setAttribute\('href', '\/w\/' \+ encodeURIComponent\(activeSource\)\)/.test(appSrc),
  'breadcrumb icon carries the live source URL');
check(extractFn(appSrc, 'goHome').includes('_anchorNativeClick'), 'goHome lets native link gestures through');
check(extractFn(appSrc, 'bcClick').includes('_anchorNativeClick'), 'bcClick lets native link gestures through');

check(/<a class="discover-card" href="\/#almanac" onclick="return _spaNav\(event, openAlmanac\)"/.test(appSrc),
  'Almanac Today card is <a href="/#almanac">');
check(/<a class="result" href="' \+ escAttr\(_articleDeepLinkPath\(r\.zim, r\.path\)\)/.test(appSrc),
  'search results are anchors carrying the article deep link');
check(/<a class="discover-card dc-quote-card" href="' \+ escAttr\(_articleDeepLinkPath/.test(appSrc),
  'discover quote cards are anchors');
check(/<a class="discover-card dc-quote-card dc-word-card" href="' \+ escAttr\(_articleDeepLinkPath/.test(appSrc),
  'discover word cards are anchors');
check(/<a class="discover-card' \+ \(_isVid \? ' dc-video-card' : ''\) \+ '" href="' \+ escAttr\(_articleDeepLinkPath/.test(appSrc),
  'discover standard cards are anchors');
check(/<a class="history-item" href="' \+ escAttr\(_articleDeepLinkPath/.test(appSrc),
  'history-trail entries are anchors');
check(/href="' \+ escAttr\(_articleDeepLinkPath\(name, d\.path\)\)/.test(appSrc),
  'zimgit document rows are anchors when they have a path');
check(/href="\/w\/' \+ encodeURIComponent\(z\.name\) \+ '" onclick="return _spaSourceClick/.test(appSrc),
  'source tiles are anchors carrying /w/<name>');

// The interception handlers must actually be wired to those anchors.
for (const fn of ['_spaCardClick', '_spaSourceClick']) {
  check(new RegExp('onclick="return ' + fn + '\\(event, this\\)"').test(appSrc), fn + ' is wired inline');
}

// ── 3. The nested-link exception ─────────────────────────────────────────
check(/const cardTag = dlHtml \? 'div' : 'a'/.test(appSrc),
  'export tiles (which embed a download <a>) stay divs — HTML forbids nested links');
check(/event\.preventDefault\(\);event\.stopPropagation\(\);toggleFavorite/.test(appSrc),
  'the star button inside anchor tiles preventDefaults (a button in a link otherwise follows the href)');

// ── 4. auxclick fallback skips real anchors ──────────────────────────────
// (The reader iframe has its own auxclick handler — target the document-level
// card fallback specifically.)
const auxStart = appSrc.indexOf("document.addEventListener('auxclick'");
const aux = appSrc.slice(auxStart, appSrc.indexOf('});', auxStart) + 3);
check(/tagName === 'A' && el\.hasAttribute\('href'\)/.test(aux),
  'middle-click fallback defers to native handling on real links (no double-open)');

process.exit(failures ? 1 : 0);
