// DOM-free regression test for the reader font-scale helper (_applyReaderFont).
//
// Guards two properties of the zoom-based scaler:
//   1. Scaling uses body.style.zoom (level/100), NOT a root font-size %. A root
//      font-size only rescales rem/em text, so px-bodied articles wouldn't grow —
//      the bug this replaced. `zoom` rescales every unit uniformly.
//   2. The neutral 100% level is NON-DESTRUCTIVE + self-cleaning: it REMOVES the
//      zoom override (never pins zoom:1) AND strips any leftover root font-size a
//      pre-zoom session may have pinned, so a ZIM's own root size governs again.
//   3. It NEVER sets body.style.width. `zoom` reflows text on its own (modern
//      WebKit re-lays-out at the zoom-divided viewport width → no x-scroll). A
//      body-width "compensation" (100/level%) is the transform:scale fix, and
//      under `zoom` it introduces horizontal scroll at zoom-out levels — verified
//      in the real reader (85% → width:117% → 69px pan). This guards its return.
//
// Pure-helper approach: extract the constants + the two font functions straight
// from app.js by source markers, eval them in a sandbox with stubbed
// localStorage, and drive them against a fake document whose body/documentElement
// styles record zoom + font-size mutations.
//
// Run: node tests/test_reader_font.cjs   (exit 0 = pass, non-zero = fail)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = path.join(__dirname, '..', 'zimi', 'static', 'app.js');
const src = fs.readFileSync(APP_JS, 'utf8');

function extract(re, label) {
  const m = src.match(re);
  if (!m) { throw new Error('could not extract ' + label + ' from app.js'); }
  return m[0];
}

// Grab the two module-scope constants and the two functions verbatim.
const cLevels = extract(/var READER_FONT_LEVELS = \[[^\]]*\];/, 'READER_FONT_LEVELS');
const cDefault = extract(/var READER_FONT_DEFAULT = \d+;/, 'READER_FONT_DEFAULT');
const fLevel = extract(/function _readerFontLevel\(\)\s*\{[\s\S]*?\n\}/, '_readerFontLevel');
const fApply = extract(/function _applyReaderFont\(doc\)\s*\{[\s\S]*?\n\}/, '_applyReaderFont');

// A fake document mirroring the CSSStyleDeclaration surface the code touches:
// body.style.zoom (set + removeProperty) and documentElement.style.fontSize
// (set + removeProperty), each recorded.
function makeDoc() {
  const rec = {
    zoomSet: 0, zoomRemoved: 0, zoomValue: undefined, zoomPresent: false,
    fsSet: 0, fsRemoved: 0, fsPresent: false,
    widthSet: 0, widthValue: undefined, widthPresent: false,
  };
  const bodyStyle = {
    get zoom() { return rec.zoomPresent ? rec.zoomValue : ''; },
    set zoom(v) { rec.zoomValue = v; rec.zoomPresent = true; rec.zoomSet++; },
    get width() { return rec.widthPresent ? rec.widthValue : ''; },
    set width(v) { rec.widthValue = v; rec.widthPresent = true; rec.widthSet++; },
    removeProperty(name) {
      if (name === 'zoom') { rec.zoomPresent = false; rec.zoomValue = undefined; rec.zoomRemoved++; }
      if (name === 'width') { rec.widthPresent = false; rec.widthValue = undefined; }
    },
  };
  const rootStyle = {
    get fontSize() { return rec.fsPresent ? '100%' : ''; },
    set fontSize(v) { rec.fsPresent = true; rec.fsSet++; },
    removeProperty(name) {
      if (name === 'font-size') { if (rec.fsPresent) rec.fsRemoved++; rec.fsPresent = false; }
    },
  };
  return { doc: { documentElement: { style: rootStyle }, body: { style: bodyStyle } }, rec };
}

const store = {};
const sandbox = {
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  },
  SK: { READER_FONT: 'zimi_reader_font_scale' },
};
vm.createContext(sandbox);
vm.runInContext([cLevels, cDefault, fLevel, fApply].join('\n'), sandbox);

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ok  - ' + name); }
  else { console.log('  FAIL - ' + name); failures++; }
}

// 1. Default (no key set): removes zoom, never sets it; never pins a font-size.
{
  delete store['zimi_reader_font_scale'];
  const { doc, rec } = makeDoc();
  vm.runInContext('_applyReaderFont(globalThis.__doc)', Object.assign(sandbox, { __doc: doc }));
  check('default level removes zoom', rec.zoomRemoved === 1 && rec.zoomPresent === false);
  check('default level does not set zoom', rec.zoomSet === 0);
  check('default level never pins a font-size', rec.fsSet === 0 && rec.fsPresent === false);
}

// 2. Non-default level sets body zoom = level/100, and does NOT touch font-size.
{
  store['zimi_reader_font_scale'] = '130';
  const { doc, rec } = makeDoc();
  vm.runInContext('_applyReaderFont(globalThis.__doc)', Object.assign(sandbox, { __doc: doc }));
  check('level 130 sets zoom to 1.3', rec.zoomValue === 1.3 && rec.zoomSet === 1);
  check('level 130 does not remove zoom', rec.zoomRemoved === 0);
  check('level 130 does not touch font-size', rec.fsSet === 0 && rec.fsRemoved === 0);
  check('level 130 never sets body width (no transform-scale comp)', rec.widthSet === 0 && rec.widthPresent === false);
}

// 2b. Zoom-OUT level (85%): still bare zoom, never a width compensation. A
// 100/level% width here would be 117% → wider-than-viewport → real x-scroll.
{
  store['zimi_reader_font_scale'] = '85';
  const { doc, rec } = makeDoc();
  vm.runInContext('_applyReaderFont(globalThis.__doc)', Object.assign(sandbox, { __doc: doc }));
  check('level 85 sets zoom to 0.85', rec.zoomValue === 0.85 && rec.zoomSet === 1);
  check('level 85 never sets body width', rec.widthSet === 0 && rec.widthPresent === false);
}

// 3. Live cycle back to 100 clears a previously-set zoom override.
{
  store['zimi_reader_font_scale'] = '115';
  const { doc, rec } = makeDoc();
  vm.runInContext('_applyReaderFont(globalThis.__doc)', Object.assign(sandbox, { __doc: doc }));
  check('level 115 sets zoom 1.15', rec.zoomValue === 1.15);
  store['zimi_reader_font_scale'] = '100';
  vm.runInContext('_applyReaderFont(globalThis.__doc)', sandbox);
  check('cycling to 100 removes the live zoom override', rec.zoomPresent === false && rec.zoomRemoved === 1);
}

// 4. A leftover root font-size from an older (pre-zoom) session is cleared at 100.
{
  store['zimi_reader_font_scale'] = '100';
  const { doc, rec } = makeDoc();
  rec.fsPresent = true; // simulate an inline font-size a pre-zoom build left behind
  vm.runInContext('_applyReaderFont(globalThis.__doc)', Object.assign(sandbox, { __doc: doc }));
  check('default level strips leftover root font-size', rec.fsRemoved === 1 && rec.fsPresent === false);
}

// 5. An unknown/garbage stored value falls back to default → remove zoom.
{
  store['zimi_reader_font_scale'] = '999';
  const { doc, rec } = makeDoc();
  vm.runInContext('_applyReaderFont(globalThis.__doc)', Object.assign(sandbox, { __doc: doc }));
  check('garbage value falls back to default and removes zoom', rec.zoomRemoved === 1 && rec.zoomSet === 0);
}

if (failures) { console.log('\n' + failures + ' check(s) FAILED'); process.exit(1); }
console.log('\nAll reader-font checks passed.');
