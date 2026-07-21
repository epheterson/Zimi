// DOM-free regression test for the reader font-scale helper (_applyReaderFont).
//
// Guards the fix where the neutral 100% level must be NON-DESTRUCTIVE: at the
// default level the helper must REMOVE its inline font-size override (so a ZIM's
// own root size — e.g. devdocs' html{font-size:62.5%} rem reset — governs),
// while non-default levels still pin N%. A literal fontSize:100% regresses this.
//
// Pure-helper approach: extract the constants + the two font functions straight
// from app.js by source markers, eval them in a sandbox with stubbed
// localStorage, and drive them against a fake documentElement.style that records
// setProperty/removeProperty and the fontSize assignment.
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

// A fake style that mirrors the CSSStyleDeclaration surface the code touches.
function makeDoc() {
  const rec = { set: 0, removed: 0, value: undefined, present: false };
  const style = {
    get fontSize() { return rec.present ? rec.value : ''; },
    set fontSize(v) { rec.value = v; rec.present = true; rec.set++; },
    removeProperty(name) {
      if (name === 'font-size') { rec.present = false; rec.value = undefined; rec.removed++; }
    },
  };
  return { doc: { documentElement: { style } }, rec };
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

// 1. Default (no key set): must REMOVE the override, never set a value.
{
  delete store['zimi_reader_font_scale'];
  const { doc, rec } = makeDoc();
  sandbox.APPLY = sandbox._applyReaderFont; // expose for call
  vm.runInContext('_applyReaderFont(globalThis.__doc)', Object.assign(sandbox, { __doc: doc }));
  check('default level removes font-size (removeProperty called)', rec.removed === 1);
  check('default level does not set font-size', rec.set === 0 && rec.present === false);
}

// 2. Non-default level pins N%.
{
  store['zimi_reader_font_scale'] = '130';
  const { doc, rec } = makeDoc();
  vm.runInContext('_applyReaderFont(globalThis.__doc)', Object.assign(sandbox, { __doc: doc }));
  check('level 130 sets font-size to 130%', rec.value === '130%' && rec.set === 1);
  check('level 130 does not remove', rec.removed === 0);
}

// 3. Live cycle back to 100 clears a previously-set override.
{
  store['zimi_reader_font_scale'] = '115';
  const { doc, rec } = makeDoc();
  vm.runInContext('_applyReaderFont(globalThis.__doc)', Object.assign(sandbox, { __doc: doc }));
  check('level 115 sets 115%', rec.value === '115%');
  // Now cycle to default and re-apply on the SAME doc (mirrors _cycleReaderFont
  // calling _applyReaderFont on the live contentDocument).
  store['zimi_reader_font_scale'] = '100';
  vm.runInContext('_applyReaderFont(globalThis.__doc)', sandbox);
  check('cycling to 100 removes the live override', rec.present === false && rec.removed === 1);
}

// 4. An unknown/garbage stored value falls back to default → remove.
{
  store['zimi_reader_font_scale'] = '999';
  const { doc, rec } = makeDoc();
  vm.runInContext('_applyReaderFont(globalThis.__doc)', Object.assign(sandbox, { __doc: doc }));
  check('garbage value falls back to default and removes', rec.removed === 1 && rec.set === 0);
}

if (failures) { console.log('\n' + failures + ' check(s) FAILED'); process.exit(1); }
console.log('\nAll reader-font checks passed.');
