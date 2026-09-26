// The apps on a phone: Zimi's header steps aside while an app page or the
// Almanac is read, the jump-to-top button stays out of Zimi's own pages,
// Back lands where you were in a list, and a long thread folds. Eric,
// 2026-09-25: "For all our apps see if the others need any considerations
// too."
//
// Run: node tests/test_apps_mobile.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const app = read('app.js'), appCss = read('app.css'), apps = read('apps.js'), appsCss = read('apps.css');
const tube = read('tube.html'), exchange = read('exchange.html'), reddot = read('reddot.html'), almanac = read('almanac.js');

let failures = 0;
function ok(label, cond) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; }
function grab(src, re, label) { const m = src.match(re); if (!m) throw new Error('could not extract ' + label); return m[0]; }

// ── the shell decides when the header steps aside ──────────────────────────
const classes = new Set();
const ctx = { document: { body: { classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); }, contains: c => classes.has(c) } } } };
vm.createContext(ctx);
vm.runInContext([
  grab(app, /var _CHROME_STEP = [^\n]*\n/, '_CHROME_STEP'),
  grab(app, /var _chromeBase = [^\n]*\n/, '_chromeBase'),
  grab(app, /function _setChromeAway\(on\) \{[\s\S]*?\n\}/, '_setChromeAway'),
  grab(app, /function _chromeScroll\(y\) \{[\s\S]*?\n\}/, '_chromeScroll'),
  grab(app, /function _chromeImmersive\(on\) \{[\s\S]*?\n\}/, '_chromeImmersive'),
  grab(app, /function _chromeReset\(\) \{[\s\S]*?\n\}/, '_chromeReset'),
].join('\n'), ctx);
const away = () => classes.has('chrome-away');
ctx._chromeScroll(40); ok('near the top the header stays', !away());
ctx._chromeScroll(400); ok('scrolling down into the content sends it away', away());
ctx._chromeScroll(395); ok('a bounce of a few pixels leaves it where it is', away());
ctx._chromeScroll(380); ok('scrolling back up brings it back', !away());
for (let y = 384; y <= 400; y += 4) ctx._chromeScroll(y);
ok('a slow scroll down still adds up', away());
ctx._chromeScroll(10); ok('back at the top it is there', !away());
ctx._chromeImmersive(true); ok('a page can hold it away (a video playing sideways)', away());
ctx._chromeScroll(0); ok('and while held, scrolling does not bring it back', away());
ctx._chromeImmersive(false); ok('letting go brings it back', !away());
ctx._chromeScroll(900); ctx._chromeImmersive(true); ctx._chromeReset();
ok('leaving the page resets it', !away() && ctx._chromeBase === 0);

ok('only an app page can move it, by the two words apps.js speaks',
  /d\.zimi === 'scroll' && typeof d\.y === 'number' && _isAppPage\(\)/.test(app) && /d\.zimi === 'immersive' && _isAppPage\(\)/.test(app));
ok('closing an app, opening a page and leaving the Almanac put it back',
  /_booksOpen = false;\n  _chromeReset\(\);/.test(app) && /function openReader\(url\) \{\n  _chromeReset\(\);/.test(app) && /_almanacOpen = false;\n  if \(typeof _chromeReset === 'function'\) _chromeReset\(\);/.test(almanac));
ok('the Almanac scrolls it away too', /content\.addEventListener\('scroll', function\(\) \{ if \(_almanacOpen\) _chromeScroll\(content\.scrollTop\); \}/.test(almanac));
ok('the hiding is a phone thing, and moves the page into the room it leaves',
  /@media \(max-width: 900px\), \(max-height: 500px\) \{[\s\S]*?body\.chrome-away \{ --under-topbar: var\(--conn-h\); \}[\s\S]*?body\.chrome-away \.topbar:not\(:focus-within\) \{ transform: translateY\(-100%\); \}/.test(appCss));

// ── the page side ──────────────────────────────────────────────────────────
const told = [];
const listeners = {};
const win = { scrollY: 0, parent: null, addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); }, scrollTo: (x, y) => { win.scrollY = y; } };
win.parent = { postMessage: m => told.push(m) };
const pctx = { window: win, document: { addEventListener() {}, documentElement: {} }, location: { origin: 'x', hash: '' }, requestAnimationFrame: fn => fn(), MutationObserver: function() {} };
vm.createContext(pctx);
vm.runInContext(apps, pctx);
win.scrollY = 321; listeners.scroll.forEach(f => f());
ok('an app page tells the shell where it is scrolled to', told.some(m => m.zimi === 'scroll' && m.y === 321));
pctx.appChrome.immersive(true);
ok('and can hold the header away', told.some(m => m.zimi === 'immersive' && m.on === true));
win.scrollY = 1500; pctx.keepPlace(); win.scrollY = 0; pctx.returnToPlace();
ok('Back from a thing lands where the list was', win.scrollY === 1500);

ok('each app keeps its place as a thing opens from the list and returns to it on the way back',
  [exchange, reddot, tube].every(s => /if \(!document\.getElementById\('home'\)\.hidden\) keepPlace\(\);/.test(s) && /if \(!silent\) returnToPlace\(\);/.test(s)));

// ── no jump-to-top in Zimi's own pages ─────────────────────────────────────
const inject = app.indexOf("_topBtn.id = 'zimi-top'");
const guard = app.lastIndexOf('if (!_frameIsOurOwnPage(frame)) try {', inject);
ok('the jump-to-top button and the capture corset are for captured pages, not the apps', guard > 0 && inject - guard < 6000);

// ── a video sideways ───────────────────────────────────────────────────────
ok('ZimiTube fits the picture to a sideways screen and holds the header away while it plays',
  /@media \(orientation: landscape\) and \(max-height: 500px\) \{\n    \.player \.stage, \.player\.theater \.stage \{ max-height: 100vh; max-width: calc\(100vh \* 16 \/ 9\);/.test(tube) &&
  /appChrome\.immersive\(on\)/.test(tube) && (tube.match(/sideways\((vid|p)\);/g) || []).length === 2 && /_docked = playing && !silent \? _now : -1;\n  appChrome\.immersive\(false\);/.test(tube));

// ── a long thread folds ────────────────────────────────────────────────────
const fold = new vm.Script(grab(reddot, /function fold\(line\) \{[\s\S]*?\n\}/, 'fold') + '; fold(line);');
const cls = new Set(); const attrs = {};
const line = { parentNode: { classList: { toggle: c => { if (cls.has(c)) { cls.delete(c); return false; } cls.add(c); return true; } } }, setAttribute: (k, v) => { attrs[k] = v; } };
const fctx = vm.createContext({ line });
fold.runInContext(fctx);
ok('a comment\'s line folds it with its replies', cls.has('folded') && attrs['aria-expanded'] === 'false');
fold.runInContext(fctx);
ok('and a second tap opens it', !cls.has('folded') && attrs['aria-expanded'] === 'true');
ok('folded, the line says how many replies went with it, in the page\'s own words',
  /data-more="' \+ esc\(' · ' \+ count\(n, STR\.comment, STR\.comments\)\)/.test(reddot) && /\.c\.folded > :not\(\.cm\) \{ display: none; \}/.test(reddot));

// ── fingers and directions ─────────────────────────────────────────────────
ok('on a touch screen the small parts grow toward a thumb', /@media \(pointer: coarse\) \{[\s\S]*?\.actions a, \.actions button \{ min-height: 44px;/.test(appsCss));
ok('each block of a body keeps its own direction, and code runs left to right',
  /\.prose :is\(p, li[^)]*\) \{ unicode-bidi: plaintext; \}/.test(appsCss) && /\.prose pre \{ direction: ltr; text-align: left; \}/.test(appsCss));

console.log(failures ? '\n' + failures + ' failed' : '\nall passed');
process.exit(failures ? 1 : 0);
