// DOM-free regression test for the Messages Across Time pill interaction
// (_selectRosettaText in almanac.js).
//
// The active inscription pill doubles as the encyclopedia link: the first tap
// selects the inscription, a second tap on the already-active pill opens the
// article through AlmanacLinks.open('rosetta:<id>') — the same closed-set
// resolution the old in-body title link used. Three properties are guarded:
//
//   1. Tapping an UNSELECTED pill selects it and re-renders; it must never
//      navigate on that same tap.
//   2. Tapping the SELECTED pill within the ghost-tap guard window right after
//      selection must NOT navigate (a fast double tap selects, nothing more).
//   3. Tapping the SELECTED pill after the guard window opens the article via
//      AlmanacLinks.open with the manifest id, and does not re-render.
//
// Plus static source guards: the redundant in-body restated-title link
// (rosetta-title-link / _lrosetta) is gone, the active pill carries
// aria-pressed, and the underline affordance class is gated on linkFor.
//
// Pure-helper approach, matching tests/test_almanac_tz_resolution.cjs: pull
// the handler straight out of almanac.js by source markers and eval it in a
// sandbox, so the test drives the shipped code rather than a copy.
//
// Run: node tests/test_rosetta_pill_link.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ALMANAC_JS = path.join(__dirname, '..', 'zimi', 'static', 'almanac.js');
const src = fs.readFileSync(ALMANAC_JS, 'utf8');

function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from almanac.js');
  return m[0];
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok  ' + name); }
  else { failures++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// ── Static source guards ────────────────────────────────────────────────────
check('restated in-body title link removed', !src.includes('rosetta-title-link'));
check('_lrosetta helper removed', !src.includes('_lrosetta'));
const pillLoop = extract(/\/\/ Inscription pills \(top row\)[\s\S]*?html \+= '<\/div>';/, 'pill render loop');
check('pill carries aria-pressed', pillLoop.includes('aria-pressed'));
check('underline class gated on linkFor', /linkable\s*=\s*isSel\s*&&\s*window\.AlmanacLinks\s*&&\s*AlmanacLinks\.linkFor\('rosetta:'/.test(pillLoop));
check('link hint uses alm_open_article', pillLoop.includes("t('alm_open_article')"));
check('rosetta-pill-link only when linkable', /linkable\s*\?\s*' rosetta-pill-link'/.test(pillLoop));

// ── Behavioral guards on the extracted handler ──────────────────────────────
const guardVars = extract(/var _rosettaSelectedAt = 0;[\s\S]*?var _ROSETTA_NAV_GUARD_MS = \d+;/, 'nav guard vars');
const fSelect = extract(/function _selectRosettaText\(idx\)\s*\{[\s\S]*?\n\}/, '_selectRosettaText');

let now = 1000000;
const opened = [];
const renders = [];
function FakeDate() { this.t = now; }   // constructible stub; only .now() and identity matter here
FakeDate.now = () => now;
const ctx = {
  Date: FakeDate,
  window: {},
  _rosettaTextIdx: 0,
  _rosettaManifest: [{ id: 'code-of-hammurabi' }, { id: 'rosetta-stone' }, { id: 'golden-record' }],
  _renderRosettaStone: (d) => renders.push(d),
};
ctx.window.AlmanacLinks = ctx.AlmanacLinks = { open: (key) => opened.push(key) };
vm.createContext(ctx);
vm.runInContext(guardVars + '\n' + fSelect, ctx);

// 1. Tap an unselected pill: selects + re-renders, never navigates.
ctx._selectRosettaText(1);
check('unselected tap selects', ctx._rosettaTextIdx === 1);
check('unselected tap re-renders', renders.length === 1);
check('unselected tap does not navigate', opened.length === 0);

// 2. Fast second tap on the now-active pill (inside guard window): no-op.
now += 100;
ctx._selectRosettaText(1);
check('fast double tap does not navigate', opened.length === 0, 'opened=' + JSON.stringify(opened));
check('fast double tap does not re-render', renders.length === 1);

// 3. Deliberate second tap after the guard window: opens the article.
now += 1000;
ctx._selectRosettaText(1);
check('second tap opens article', opened.length === 1 && opened[0] === 'rosetta:rosetta-stone', 'opened=' + JSON.stringify(opened));
check('second tap does not re-render', renders.length === 1);
check('second tap keeps selection', ctx._rosettaTextIdx === 1);

// 4. Missing AlmanacLinks (script not loaded): selected tap is a safe no-op.
ctx.window.AlmanacLinks = undefined;
now += 1000;
ctx._selectRosettaText(1);
check('no AlmanacLinks -> no throw, no nav', opened.length === 1);
ctx.window.AlmanacLinks = ctx.AlmanacLinks;

// 5. Switching to another pill re-arms the guard.
now += 1000;
ctx._selectRosettaText(2);
now += 50;
ctx._selectRosettaText(2);
check('guard re-arms after switching pills', opened.length === 1, 'opened=' + JSON.stringify(opened));
now += 1000;
ctx._selectRosettaText(2);
check('golden record opens by manifest id', opened.length === 2 && opened[1] === 'rosetta:golden-record');

if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
console.log('all rosetta pill-link checks passed');
