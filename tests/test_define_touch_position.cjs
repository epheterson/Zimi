// DOM-free regression test for the Define-chip touch/iOS positioning logic.
//
// Guards three properties added for the iOS system-callout collision fix:
//   1. Touch devices get a bigger clearance below the selection than desktop
//      (_defineRangeRect's margin), so the chip doesn't sit under the OS
//      callout's tail even though both default to "below the selection."
//   2. Touch devices flip the chip ABOVE the selection when it's near the top
//      of the viewport — that's exactly where iOS itself has no room above
//      and flips its own callout below, so mirroring keeps them apart.
//   3. Desktop (non-touch) positioning is completely unaffected: no near-top
//      flip, margin stays at the original 4px.
//
// Pure-helper approach, same pattern as test_reader_font.cjs: extract the
// constants + functions straight from app.js by source markers, eval them in
// a sandboxed vm context with a controllable matchMedia + a fake popover
// element, and assert on the computed style.left/top.
//
// Run: node tests/test_define_touch_position.cjs   (exit 0 = pass, non-zero = fail)

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

const cDelay = extract(/var _DEFINE_TOUCH_DELAY = \d+;.*$/m, '_DEFINE_TOUCH_DELAY');
const cMargin = extract(/var _DEFINE_TOUCH_MARGIN = \d+;.*$/m, '_DEFINE_TOUCH_MARGIN');
const cNearTop = extract(/var _DEFINE_NEAR_TOP_PX = \d+;.*$/m, '_DEFINE_NEAR_TOP_PX');
const fIsTouch = extract(/function _defineIsTouch\(\)\s*\{[\s\S]*?\n\}/, '_defineIsTouch');
const fRangeRect = extract(/function _defineRangeRect\(frame, range\)\s*\{[\s\S]*?\n\}/, '_defineRangeRect');
const fPosition = extract(/function _definePosition\(rect\)\s*\{[\s\S]*?\n\}/, '_definePosition');

// Controllable "is this a touch/coarse-pointer device" flag, flipped per test.
let touchMode = false;

function makeFrame(top, left) {
  return { getBoundingClientRect: () => ({ top: top, left: left, bottom: top, right: left }) };
}
function makeRange(top, bottom, left, right) {
  return { getBoundingClientRect: () => ({ top: top, bottom: bottom, left: left, right: right }) };
}
function makePopover(w, h) {
  const style = {};
  return {
    classList: { add: () => {} },
    offsetWidth: w, offsetHeight: h,
    style,
  };
}

const sandbox = {
  window: {
    matchMedia: () => ({ matches: touchMode }),
    innerWidth: 390,
    innerHeight: 800,
  },
};
vm.createContext(sandbox);
vm.runInContext([cDelay, cMargin, cNearTop, fIsTouch, fRangeRect, fPosition].join('\n'), sandbox);

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ok  - ' + name); }
  else { console.log('  FAIL - ' + name); failures++; }
}

// 1. Desktop: unchanged 4px margin below the selection.
{
  touchMode = false;
  const frame = makeFrame(100, 20);
  const range = makeRange(150, 170, 30, 60); // selection well below viewport top
  const rect = vm.runInContext('_defineRangeRect(frame, range)', Object.assign(sandbox, { frame, range }));
  check('desktop margin is 4px below the selection bottom', rect.y === 170 + 100 + 4);
}

// 2. Touch: bigger clearance below the selection (collision margin).
{
  touchMode = true;
  const frame = makeFrame(100, 20);
  const range = makeRange(150, 170, 30, 60);
  const rect = vm.runInContext('_defineRangeRect(frame, range)', Object.assign(sandbox, { frame, range }));
  const margin = vm.runInContext('_DEFINE_TOUCH_MARGIN', sandbox);
  check('touch margin exceeds desktop margin', margin > 4);
  check('touch rect.y uses the touch margin', rect.y === 170 + 100 + margin);
}

// 3. Desktop positioning: no near-top flip even when the selection is at the
// very top of the viewport — only touch devices mirror the OS callout flip.
{
  touchMode = false;
  const popover = makePopover(200, 60);
  sandbox.__pop = popover;
  vm.runInContext('_definePopover = __pop', sandbox);
  const rect = { x: 20, y: 40, top: 10 }; // near top; would trigger the touch flip
  vm.runInContext('_definePosition(__rect)', Object.assign(sandbox, { __rect: rect }));
  check('desktop stays below near the top (no flip)', popover.style.top === '40px');
}

// 4. Touch positioning away from the top: stays below, per the default.
{
  touchMode = true;
  const popover = makePopover(200, 60);
  sandbox.__pop = popover;
  vm.runInContext('_definePopover = __pop', sandbox);
  const rect = { x: 20, y: 400, top: 380 }; // nowhere near the viewport top
  vm.runInContext('_definePosition(__rect)', Object.assign(sandbox, { __rect: rect }));
  check('touch away from the top stays below', popover.style.top === '400px');
}

// 5. Touch positioning near the top: flips ABOVE the selection, mirroring
// iOS's own callout-below-when-no-room-above behavior.
{
  touchMode = true;
  const popover = makePopover(200, 60);
  sandbox.__pop = popover;
  vm.runInContext('_definePopover = __pop', sandbox);
  const nearTop = vm.runInContext('_DEFINE_NEAR_TOP_PX', sandbox);
  const margin = vm.runInContext('_DEFINE_TOUCH_MARGIN', sandbox);
  const rect = { x: 20, y: 60, top: nearTop - 20 }; // inside the near-top zone
  vm.runInContext('_definePosition(__rect)', Object.assign(sandbox, { __rect: rect }));
  const expectedY = Math.max(8, rect.top - 60 - margin);
  check('touch near the top flips above the selection', popover.style.top === expectedY + 'px');
}

if (failures) { console.log('\n' + failures + ' check(s) FAILED'); process.exit(1); }
console.log('\nAll Define touch-position checks passed.');
