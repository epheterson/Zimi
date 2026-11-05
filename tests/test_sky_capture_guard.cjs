// The live sky copies its strip above the horizon into a small canvas (_skyCaptureLight). A sky whose canvas is not
// laid out yet (0 wide, as on CI's headless runs) must be skipped: drawImage throws on a 0-wide canvas source, and
// that error surfaced on every Almanac page in CI.
// Run: node tests/test_sky_capture_guard.cjs
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-sky.js'), 'utf8');
const fn = src.match(/function _skyCaptureLight\(s, src, gpu\) \{[\s\S]*?\n\}/)[0];
const ctx2d = {
  setTransform() {},
  drawImage(img) { if (!img.width || !img.height) throw new Error("Failed to execute 'drawImage': a canvas element with a width or height of 0"); },
};
const sandbox = {
  SKY_HORIZON_Y: 0.6, SKY_REFLECT_DOWN: 4,
  document: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) },
};
vm.createContext(sandbox);
vm.runInContext(fn, sandbox);
const s = { W: 390, H: 300 };
assert.doesNotThrow(() => sandbox._skyCaptureLight(s, { width: 0, height: 0 }, null), 'a 0-wide sky canvas is skipped');
console.log('all passed');
