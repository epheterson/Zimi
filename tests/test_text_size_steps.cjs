// Text size is five named steps, drawn as five A's that grow, wherever it is
// set: Reader View's palette and menu, Zimipedia's sheet and a book's sheet
// (Eric, 2026-09-30: "Smaller, Small, Default, Large, Larger ... no numbers").
// A size saved on the old scales (Reader View's four zooms, the sheets' nine
// pixel sizes) lands on the nearest step.
//
// Run: node tests/test_text_size_steps.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
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

const en = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'en.json'), 'utf8'));
const ctx = {
  tH: (k) => en[k] || '<<' + k + '>>',
  _getStorageJSON: (k, d) => (k in ctx.__store ? ctx.__store[k] : d),
  __store: {},
};
vm.createContext(ctx);
vm.runInContext([
  extract(/var READER_FONT_LEVELS = \[[^\]]*\];/, 'READER_FONT_LEVELS'),
  extract(/var TEXT_SIZE_STEPS = \[[^\]]*\];/, 'TEXT_SIZE_STEPS'),
  extract(/var TEXT_SIZE_GLYPH_PX = \[[^\]]*\];/, 'TEXT_SIZE_GLYPH_PX'),
  extract(/function _nearestStep\(list, v, fallback\)\s*\{[\s\S]*?\n\}/, '_nearestStep'),
  extract(/function _textSizeStepsHtml\(cls, cur, onpick\)\s*\{[\s\S]*?\n\}/, '_textSizeStepsHtml'),
  extract(/var _READING_SIZE_BASE = \d+;/, '_READING_SIZE_BASE'),
  extract(/var _READING_SIZES = [^\n]*/, '_READING_SIZES'),
  extract(/var _READING_LEADINGS = \[[^\]]*\];/, '_READING_LEADINGS'),
  extract(/var _READING_MARGINS = \[[^\]]*\];/, '_READING_MARGINS'),
  extract(/function _readingPrefs\(key, defaults\)\s*\{[\s\S]*?\n\}/, '_readingPrefs'),
].join('\n'), ctx);

// The control: five buttons, named, each A larger than the last, no digits
// a reader would read.
const html = vm.runInContext("_textSizeStepsHtml('rv-size', 3, '_setReaderFontStep')", ctx);
const buttons = html.match(/<button[^>]*>A<\/button>/g) || [];
ok('five A buttons', buttons.length === 5, String(buttons.length));
const names = buttons.map((b) => (b.match(/aria-label="([^"]*)"/) || [])[1]);
ok('named Smaller, Small, Default, Large, Larger', names.join(',') === 'Smaller,Small,Default,Large,Larger', names.join(','));
const px = buttons.map((b) => Number((b.match(/font-size:(\d+)px/) || [])[1]));
ok('each A is drawn larger than the one before', px.every((p, i) => i === 0 || p > px[i - 1]), px.join(','));
ok('the current step, and only it, is checked', buttons.map((b) => /aria-checked="true"/.test(b)).join() === 'false,false,false,true,false');
ok('a radiogroup named Text size', /role="radiogroup" aria-label="Text size"/.test(html));
ok('a tap picks its step', /onclick="event.stopPropagation\(\);_setReaderFontStep\(4\)"/.test(buttons[4]));
ok('no number is shown', html.replace(/<[^>]*>/g, '') === 'AAAAA');
ok('a sheet draws the same control (its clicks read data-size)', /data-size="0"/.test(buttons[0]) &&
  /_textSizeStepsHtml\('zb-seg zb-sizes', si\)/.test(src) && /_textSizeStepsHtml\('rv-size', READER_FONT_LEVELS\.indexOf\(lvl\), '_setReaderFontStep'\)/.test(src));

// The sheets' sizes: the same five shares of 19px as Reader View's zooms.
ok('the sheets\' five sizes', vm.runInContext('JSON.stringify(_READING_SIZES)', ctx) === '[16,17,19,22,25]', vm.runInContext('JSON.stringify(_READING_SIZES)', ctx));
const size = (stored) => {
  ctx.__store = { k: { size: stored, lh: 2, margin: 1 } };
  return vm.runInContext("_readingPrefs('k', { size: 19, lh: 2, margin: 1 }).size", ctx);
};
ok('a size from the old nine-step scale lands on the nearest step',
  size(14) === 16 && size(17) === 17 && size(21) === 22 && size(23) === 22 && size(26) === 25 && size(34) === 25,
  [14, 17, 21, 23, 26, 30, 34].map(size).join(','));
ok('no size saved, or not a size, is the reader\'s default', size(undefined) === 19 && size('big') === 19);

// Every language names the five steps.
for (const f of fs.readdirSync(path.join(root, 'i18n'))) {
  const d = JSON.parse(fs.readFileSync(path.join(root, 'i18n', f), 'utf8'));
  const missing = ['smaller', 'small', 'default', 'large', 'larger'].filter((k) => !d['text_size_' + k]);
  if (missing.length) ok('the steps are named in ' + f, false, missing.join(','));
}

process.exit(failures ? 1 : 0);
