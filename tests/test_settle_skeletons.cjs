// Skeletons in a captured page.
//
// A site draws a grey shimmering box while it waits for a fetch. In an archive
// that fetch never happens, so the box waits forever — Eric found a captured
// CNN front page pulsing at him with content that could not arrive.
//
// `animation-iteration-count: 1` stops the pulse but does not resolve it: what
// is left is a bar frozen mid-shimmer, still claiming an article is coming. So
// an EMPTY skeleton is removed (a placeholder for nothing is not information)
// and one that holds real content keeps it and only loses the animation.
//
// That last distinction is the whole risk in this change — throwing away text
// somebody wrote would be far worse than a grey box — so it is what this pins.
// The selector matching is the browser's job and is not re-tested here.
//
// Run: node tests/test_settle_skeletons.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from app.js');
  return m[0];
}

let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  extract(/var SKELETON_SELECTOR = \[[\s\S]*?\]\.join\(','\);/, 'SKELETON_SELECTOR') +
  '\n' +
  extract(/function _isHollow\(el\)\s*\{[\s\S]*?\n\}/, '_isHollow') +
  '\n' +
  extract(/function _settleCapturedChrome\(frame\)\s*\{[\s\S]*?\n\}/, '_settleCapturedChrome'),
  sandbox);

// A DOM small enough to reason about: elements know their text, their media,
// whether they were removed, and what inline styles were forced onto them.
function el(opts) {
  return {
    text: opts.text || '',
    media: !!opts.media,
    removed: false,
    forced: {},
    get innerText() { return this.text; },
    querySelector(sel) { return this.media ? {} : null; },
    remove() { this.removed = true; },
    style: {
      setProperty(k, v, pri) { this.__owner.forced[k] = v; }
    }
  };
}
function wire(e) { e.style.__owner = e; return e; }

function settle(skeletons) {
  const appended = [];
  const doc = {
    body: {},
    documentElement: { appendChild: (n) => appended.push(n) },
    head: { appendChild: (n) => appended.push(n) },
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    querySelectorAll(sel) {
      // Only the skeleton pass is under test; the sticky pass asks for 'body *'.
      return sel === 'body *' ? [] : skeletons;
    }
  };
  const win = { getComputedStyle: () => ({ position: 'static' }) };
  vm.runInContext('_settleCapturedChrome', sandbox)({
    contentDocument: doc, contentWindow: win
  });
  return appended;
}

// ── an empty skeleton is a promise that cannot be kept ──────────────────────

const empty = wire(el({}));
settle([empty]);
ok('an empty skeleton is removed', empty.removed === true);

const boxOfBoxes = wire(el({ text: '   \n  ' }));
settle([boxOfBoxes]);
ok('whitespace does not count as content', boxOfBoxes.removed === true);

// ── real content survives; only the animation goes ──────────────────────────

const withText = wire(el({ text: 'Hurricane makes landfall' }));
settle([withText]);
ok('a skeleton holding text is kept', withText.removed === false);
ok('  ...and stops animating', withText.forced.animation === 'none');

const withImage = wire(el({ media: true }));
settle([withImage]);
ok('a skeleton holding an image is kept', withImage.removed === false);
ok('  ...and stops animating', withImage.forced.animation === 'none');

// ── the stylesheet that stops the pulse in the first place ──────────────────

const sheet = settle([]);
ok('a settle stylesheet is still injected', sheet.length === 1);

// ── the names sites actually use ────────────────────────────────────────────

const sel = vm.runInContext('SKELETON_SELECTOR', sandbox);
['skeleton', 'shimmer', 'placeholder', 'loading', 'loader'].forEach((word) => {
  ok('selector covers "' + word + '"', sel.indexOf(word) !== -1);
});
ok('selector covers aria-busy', sel.indexOf('aria-busy') !== -1);
ok('selector matches case-insensitively', /\si\]/.test(sel),
   'isLoading and IS_LOADING are the same intent');

console.log(failures ? '\n' + failures + ' failed' : '\nall passed');
process.exit(failures ? 1 : 0);
