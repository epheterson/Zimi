// A /w/ deep link must not pile up history entries.
//
// Issue #78, mr-gepardas on 1.9.5: opening /w/{zim}/{path} directly "breaks
// the back button functionality", and the address bar turns into /?a=...
// under them.
//
// The address change is by design. A raw /w/ URL is a bare ZIM page with no
// search, no reader controls and no way back into the library, so the server
// answers a top-level navigation with the SPA shell and the client boots the
// article inside it. /?a= is that article's canonical address.
//
// The broken Back was real, and was one missing argument. openArticle takes
// {replace: true} precisely so a deep-link boot REPLACES the entry the
// browser just created rather than pushing a second one onto it, and its
// comment says so: "browser Back then leaves the site instead of surfacing a
// phantom home the user never visited". The /?a= boot passed it. The /w/ boot
// was a separate hand-rolled copy of the same three lines, and did not.
//
// Measured before and after on a cold context with the worker blocked: three
// entries for one navigation, then two (the minimum, since the browser's own
// initial entry counts).
//
// The fix is that there is now one boot path rather than two, which is also
// why this test asserts against the source: the failure mode is somebody
// re-inlining those three lines.
//
// Run: node tests/test_deep_link_history.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

function fn(name) {
  // `async function` too: init() is one, and matching only the bare keyword
  // silently selected the wrong text.
  let i = src.indexOf('async function ' + name + '(');
  if (i < 0) i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(name + ' not found');
  let d = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1);
  }
  throw new Error('unbalanced ' + name);
}

// ── both deep-link forms boot the same way ─────────────────────────────────

const route = fn('route');
const wBranch = route.slice(route.indexOf("path.startsWith('/w/')"));

check(/_bootDeepLinkArticle\(name, articlePath\)/.test(wBranch),
      'a /w/ deep link boots through the shared helper');
check(!/openArticle\(name, articlePath\)\s*;/.test(wBranch),
      'and no longer calls openArticle directly, which is what dropped the replace');
check(/_bootDeepLinkArticle\(aZim, aPath\)/.test(route),
      'the /?a= form uses the same helper');

// ── and that helper replaces rather than pushes ────────────────────────────

const boot = fn('_bootDeepLinkArticle');
check(/openArticle\([^)]*\{\s*replace:\s*true\s*\}\)/.test(boot),
      'the helper replaces the boot entry instead of pushing onto it');
check(/enterSource\([^,]+,\s*false\)/.test(boot),
      'and enters the source without pushing an entry of its own');

// ── the option it depends on still exists ──────────────────────────────────

const open = fn('openArticle');
check(/opts && opts\.replace/.test(open) && /history\.replaceState/.test(open),
      'openArticle still honours {replace: true}');
check(/history\.pushState/.test(open),
      'and still pushes for ordinary in-app navigation');

console.log('');
if (failures) {
  console.error(failures + ' deep-link history check(s) failed');
  process.exit(1);
}
console.log('all deep-link history checks passed');
