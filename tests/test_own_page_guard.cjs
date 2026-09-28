// The reader's clean-up passes must never run on Zimi's own pages.
//
// Issue #71, reported by Joe (WB3IHY) with the cause and the fix: every PDF
// opened through the reader stayed permanently blank, in every browser, while
// the same viewer URL opened directly rendered fine.
//
// Two reasonable behaviours collided. The reader loads Zimi's bundled pdf.js
// viewer into the SAME iframe it loads ZIM articles into, and that iframe's
// onload runs the passes that tidy up a captured web page — stopping runaway
// animations, dropping empty ad slots, collapsing hollow blocks.
//
// At the instant frame.onload fires, pdf.js has parsed the document but has
// not painted a canvas; that happens a moment later, off its own
// IntersectionObserver. So #viewerContainer is right then a tall, empty,
// transparent box containing no embedded media, which is exactly how the
// hollow-block sweep recognises an abandoned ad slot. It set
// height: 0 !important, nothing was ever in view again for pdf.js's observer,
// and no page ever rendered. Not a transient layout problem: a hard inline
// write that no resize or reload in that session undoes.
//
// The rest of the onload handler already knew about this distinction — three
// separate blocks below the sweep check the frame's path for /static/ before
// touching anything. These two did not. The guard is now a named function so
// there is one answer to "is this our own page", and this test is what stops
// the next pass being added without asking it.
//
// Run: node tests/test_own_page_guard.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = path.join(__dirname, '..', 'zimi', 'static', 'app.js');
const src = fs.readFileSync(APP_JS, 'utf8');

function grab(name) {
  const needle = `function ${name}(`;
  const i = src.indexOf(needle);
  if (i < 0) throw new Error(name + ' not found in app.js');
  let j = src.indexOf('{', i), d = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1);
  }
  throw new Error('unbalanced ' + name);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(grab('_frameIsOurOwnPage'), sandbox);
const isOurs = sandbox._frameIsOurOwnPage;

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

const frameAt = (pathname) => ({ contentWindow: { location: { pathname } } });

// ── ours ───────────────────────────────────────────────────────────────────
check(isOurs(frameAt('/static/pdfjs/web/viewer.html')) === true,
      'the pdf.js viewer is our own page');
check(isOurs(frameAt('/static/anything/else.html')) === true,
      'so is anything else we ship under /static/');

// ── not ours ───────────────────────────────────────────────────────────────
check(isOurs(frameAt('/w/wikipedia_en/A/Whale')) === false,
      'a ZIM article is not our page');
check(isOurs(frameAt('/w/zimgit-water/files/Water.pdf')) === false,
      'nor is a raw PDF served straight out of a ZIM');
check(isOurs(frameAt('/')) === false, 'nor is the app root');
// A path that merely CONTAINS /static/ is a ZIM's own file, not ours. Captured
// sites are full of them.
check(isOurs(frameAt('/w/somesite/static/app.js')) === false,
      'a captured site with its own /static/ directory is still a capture');

// ── a frame we cannot read ─────────────────────────────────────────────────
// Cross-origin throws on location access. Answering "ours" there would skip
// the clean-up on real captured pages, which is the larger loss of the two.
check(isOurs({ get contentWindow() { throw new Error('cross-origin'); } }) === false,
      'an unreadable frame is treated as a page, not as one of our tools');
check(isOurs({}) === false, 'and so is a frame with no window at all');

// ── the guard is actually wired to the passes ──────────────────────────────
// Reading the source rather than the behaviour, because the call site lives
// inside a long onload handler that cannot be lifted out. If the passes stop
// asking, the bug is back and this is what notices.
const settleBlock = src.slice(
  src.indexOf('var _settlePasses = function()'),
  src.indexOf('if (_replayAlive) setTimeout(_settlePasses')
);
check(/_frameIsOurOwnPage\(frame\)(\s*\|\|\s*_bookDoc)?\s*\)\s*return;/.test(settleBlock),
      'the settle passes ask before touching the document (and pass a book by)');
check(settleBlock.indexOf('_frameIsOurOwnPage') <
      settleBlock.indexOf('_sweepBlockingOverlays'),
      'and they ask FIRST, before either pass runs');
check(/_settleCapturedChrome\(frame\)/.test(settleBlock),
      'both passes are still behind that one guard');

console.log('');
if (failures) {
  console.error(failures + ' own-page guard check(s) failed');
  process.exit(1);
}
console.log('all own-page guard checks passed');
