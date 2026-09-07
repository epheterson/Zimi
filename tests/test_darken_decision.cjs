// Whether the darken-articles style belongs in the article document (#65).
//
// The rule: the person's explicit tick wins. Left to the default (follow the
// app theme), a captured site keeps its own design; ticked, the person asked
// for dark and gets it. Before this, a ticked box did nothing on a capture,
// which on a library made of captures reads as "the checkbox does nothing".
//
// Run: node tests/test_darken_decision.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
function extractFn(s, name) {
  const i = s.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(name + ' not found');
  let j = s.indexOf('{', i), d = 0;
  for (; j < s.length; j++) {
    if (s[j] === '{') d++;
    else if (s[j] === '}' && --d === 0) return s.slice(i, j + 1);
  }
  throw new Error('unbalanced ' + name);
}
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(extractFn(src, '_articleAppearance'), sandbox);
vm.runInContext(extractFn(src, '_darkenWanted'), sandbox);
const wanted = (on, explicit, reader, loc, capture, dark) =>
  vm.runInContext(`_darkenWanted(${on}, ${explicit}, ${reader}, ${JSON.stringify(loc)}, ${capture}, ${dark})`, sandbox);
const appearance = (on, explicit, reader, loc, capture, dark) =>
  vm.runInContext(`_articleAppearance(${on}, ${explicit}, ${reader}, ${JSON.stringify(loc)}, ${capture}, ${dark})`, sandbox);

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}

// on, explicit, readerView, loc, isCapture, declaresDark -> expected
const cases = [
  [true,  false, false, '/w/x/A/p', false, false, true,  'default-on darkens a plain ZIM article'],
  [false, false, false, '/w/x/A/p', false, false, false, 'off is off'],
  [true,  false, false, '/w/x/A/p', true,  false, false, 'default-on leaves a capture its own design'],
  [true,  true,  false, '/w/x/A/p', true,  false, true,  '#65: an explicit tick darkens a capture too'],
  [true,  true,  false, '/w/x/A/p', true,  true,  false, 'never invert a page that is already dark'],
  [true,  true,  true,  '/w/x/A/p', false, false, false, 'Reader View has its own theme'],
  [true,  true,  false, '/static/pdfjs/viewer.html', false, false, false, 'viewers are not articles'],
];
for (const [on, ex, rv, loc, cap, dark, expected, label] of cases) {
  check(wanted(on, ex, rv, loc, cap, dark) === expected, label);
}

// #65, the half that shipped broken in 1.9.2: the box has to work in the OTHER
// direction too. Every modern Wikipedia ZIM follows the OS through
// `skin-theme-clientpref-os`, so in dark mode the article is already dark and
// the old two-answer decision had nothing to add and nothing to remove.
const both = [
  // on, explicit, readerView, loc, isCapture, declaresDark -> expected
  [false, false, false, '/w/x/A/p', false, true,  'light',  'unticked on a page showing its own dark face asks for light'],
  [false, false, false, '/w/x/A/p', false, false, 'leave',  'unticked on an already-light page: nothing to do'],
  [true,  false, false, '/w/x/A/p', false, true,  'leave',  'ticked on a page already dark: let it be'],
  [true,  false, false, '/w/x/A/p', false, false, 'darken', 'ticked on a light page: darken it'],
  [true,  true,  false, '/w/x/A/p', true,  false, 'darken', 'an explicit tick still reaches a capture'],
  [false, false, true,  '/w/x/A/p', false, true,  'leave',  'Reader View owns its themes, in both directions'],
  [false, false, false, '/static/pdfjs/viewer.html', false, true, 'leave', 'viewers are never touched'],
];
for (const [on, ex, rv, loc, cap, dark, expected, label] of both) {
  const got = appearance(on, ex, rv, loc, cap, dark);
  check(got === expected, label + ' (got ' + got + ')');
}

// And the decision is what _applyArticleDarken actually consults.
const apply = extractFn(src, '_applyArticleDarken');
check(/_articleAppearance\(/.test(apply), '_applyArticleDarken asks _articleAppearance');
check(/_darkenArticlesExplicit\(\)/.test(apply), 'and passes whether the box was ticked');
check(/_askArticleFor\(doc, want === 'light'/.test(apply), 'and asks the page for its light face');

// The light request uses both knobs, and is reversible.
const ask = extractFn(src, '_askArticleFor');
check(/colorScheme/.test(ask), 'sets color-scheme, so a media-query dark mode stops matching');
check(/skin-theme-clientpref-day/.test(ask), "swaps MediaWiki's theme class, which is not a media query");
check(/dataset\.zimiMwTheme/.test(ask), 'remembers the original class so ticking restores it');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all darken decision checks passed');
