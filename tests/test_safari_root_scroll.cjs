// Safari on macOS stops wheel scrolling altogether when a page root's vertical
// overscroll-behavior is anything but auto (found 2026-10-24: Eric could not
// scroll Home or any article in Safari; WebKit measured with Playwright). The
// shell, the apps and the article CSS keep the no-bounce rule for touch
// screens only. Run: node tests/test_safari_root_scroll.cjs
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'zimi', 'static');
let failed = 0;
function ok(name, cond) { if (!cond) { failed++; console.log('FAIL', name); } else console.log('ok', name); }

// CSS files: a root rule (html / :root) may set overscroll-behavior-x, but a
// shorthand or -y only inside the touch media query.
for (const f of ['app.css', 'apps.css']) {
  const css = fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const touch = /@media\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)\s*\{[^{}]*\{[^{}]*\}\s*\}/g;
  const outside = css.replace(touch, '');
  const bad = (outside.match(/(^|[}\s])(html|:root)\b[^{]*\{[^}]*overscroll-behavior(-y)?\s*:\s*(none|contain)/g) || []);
  ok(f + ': no vertical overscroll-behavior on the root outside the touch query', bad.length === 0);
}
// The article and app-page CSS built in app.js goes through _noBounceCss.
const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
ok('app.js: no literal root overscroll-behavior:none', !/'html[^']*\{overscroll-behavior:none/.test(js));
ok('app.js: _noBounceCss keeps the vertical rule inside the touch query',
  /function _noBounceCss\(root\) \{\s*return root \+ '\{overscroll-behavior-x:none\}@media \(hover:none\) and \(pointer:coarse\)\{/.test(js));
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
