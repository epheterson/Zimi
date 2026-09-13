// What a raw ZIM article is painted, and who decides.
//
// The chain is OS -> Zimi -> articles. Zimi MAY follow the system; articles
// follow ZIMI. That middle link was missing: an article carrying its own dark
// mode read prefers-color-scheme, which is the system's answer, so a dark Zimi
// on a light Mac served a light article inside a dark app.
//
// Eric, 2026-09-13: "Zimi can optionally follow OS, but articles follow Zimi."
//
// Two settings now, answering different questions:
//
//   Article theme   WHEN articles are dark. Match Zimi, or pinned either way.
//   Simulate dark   WHAT to do about an article with no dark mode of its own.
//
// The old single checkbox conflated them, and its unticked branch forced a
// page that HAD a dark mode back to light — the request to stop simulating
// read as a request to be light, which is why the setting was unexplainable.
// That branch is gone: unticked now means "don't fake one", nothing more.
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
vm.runInContext(extractFn(src, '_articleScheme'), sandbox);
vm.runInContext(extractFn(src, '_shouldSimulateDark'), sandbox);
const scheme = (...a) => sandbox._articleScheme(...a);
const simulate = (...a) => sandbox._shouldSimulateDark(...a);

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

const ART = '/w/wikipedia_en/A/Whale';
const VIEWER = '/static/pdfjs/web/viewer.html';

// ── what we ask the page to paint ──────────────────────────────────────────
// readerViewOn, loc, articlesDark -> scheme
check(scheme(false, ART, true) === 'dark',
      'articles dark: the page is ASKED for dark, not left to read the OS');
check(scheme(false, ART, false) === 'light',
      'articles light: asked for light, so a dark OS cannot override Zimi');
check(scheme(true, ART, true) === '',
      'Reader View owns its themes and is handed back its own judgement');
check(scheme(false, VIEWER, true) === '',
      'so are the viewers we ship under /static/');

// ── and when we fake one ───────────────────────────────────────────────────
// articlesDark, simulate, explicit, readerView, loc, isCapture, paintsDark
const cases = [
  [true,  true,  false, false, ART,    false, false, true,
   'asked for dark, came back light, simulate on: darken it'],
  [true,  true,  false, false, ART,    false, true,  false,
   'came back dark: it has its own, and inverting would undo it'],
  [true,  false, false, false, ART,    false, false, false,
   'simulate off: a plain article stays light, and that is the whole setting'],
  [false, true,  false, false, ART,    false, false, false,
   'articles are light: there is nothing to simulate'],
  // #65 both halves. A capture keeps the design it was captured with unless the
  // person went and ticked the box, at which point it had better do something.
  [true,  true,  false, false, ART,    true,  false, false,
   'a capture left at the default keeps its own design'],
  [true,  true,  true,  false, ART,    true,  false, true,
   '#65: an explicit tick reaches a capture too'],
  [true,  true,  true,  true,  ART,    false, false, false,
   'Reader View is never inverted, however the box is set'],
  [true,  true,  true,  false, VIEWER, false, false, false,
   'nor is the PDF viewer (#71 was this pass touching our own page)'],
];
for (const [d, s, e, rv, loc, cap, paints, expected, label] of cases) {
  const got = simulate(d, s, e, rv, loc, cap, paints);
  check(got === expected, label + (got === expected ? '' : ' (got ' + got + ')'));
}

// The removed branch, named so it cannot come back by accident: unticking must
// never force a page that has a dark mode into its light face.
check(simulate(true, false, false, false, ART, false, true) === false &&
      scheme(false, ART, true) === 'dark',
      'unticking simulate does not drag a genuinely-dark page back to light');

// ── the applier asks BEFORE it measures ────────────────────────────────────
// "Has a dark mode" is not something a document declares. The only way to know
// is to ask and look, and looking through our own invert would answer the
// question with our own answer.
const apply = extractFn(src, '_applyArticleDarken');
const at = (needle) => apply.indexOf(needle);
check(at('_dropArticleDarken(doc)') > 0, 'our own invert comes off first');
check(at('_dropArticleDarken(doc)') < at('_askArticleFor(doc, scheme)'),
      'before the ask, so the measurement is of the page and not of us');
check(at('_askArticleFor(doc, scheme)') < at('_articleDeclaresDark(doc)'),
      'and the measurement happens after the ask, never before it');
check(/_articlesAreDark\(\)/.test(apply), 'darkness comes from the article theme');

// ── the ask can name either face, and is reversible ────────────────────────
const ask = extractFn(src, '_askArticleFor');
// color-scheme governs the UA surface — scrollbars, form controls, the canvas
// behind a transparent body — and NOT how prefers-color-scheme resolves. It
// was documented as doing the latter and does not; measuring that is what
// found the media-query half of #65 had never worked.
check(/colorScheme/.test(ask), 'sets color-scheme, for the UA surface');
check(/_retuneColorSchemeQueries\(doc, mode\)/.test(ask),
      'and rewrites the queries, which is what actually moves a media-query page');
const mwMap = src.slice(src.indexOf('var _MW_THEME_CLASS'), src.indexOf('function _askArticleFor'));
check(/light: 'skin-theme-clientpref-day'/.test(mwMap) &&
      /dark: 'skin-theme-clientpref-night'/.test(mwMap) &&
      /_MW_THEME_CLASS\[mode\]/.test(ask),
      "and swaps MediaWiki's theme class both ways: it is not a media query");
check(/dataset\.zimiMwTheme/.test(ask),
      'remembering what the ZIM shipped, so handing it back restores -os');

// ── rewriting somebody else's media query, surgically ──────────────────────
// prefers-color-scheme cannot be overridden from outside, so the condition is
// edited. Only that term: a rule guarded by a width or a print target must
// keep its guard, which `not all` on the whole rule would have thrown away.
vm.runInContext(
  ["_PCS_ALWAYS", "_PCS_NEVER", "_PCS_DARK_RE", "_PCS_LIGHT_RE"]
    .map(n => src.slice(src.indexOf('var ' + n + ' ='), src.indexOf('\n', src.indexOf('var ' + n + ' =')))).join('\n')
  + '\n' + extractFn(src, '_retunedQuery'), sandbox);
const tuned = (q, m) => sandbox._retunedQuery(q, m);

const A = '(min-width: 0px)', N = '(min-width: 999999px)';
check(tuned('(prefers-color-scheme: dark)', 'dark') === A,
      'a dark block is made to match when articles are dark');
check(tuned('(prefers-color-scheme: dark)', 'light') === N,
      'and made never to match when they are light');
check(tuned('(prefers-color-scheme: light)', 'light') === A,
      'a light block, the other way round');
check(tuned('screen and (min-width: 700px) and (prefers-color-scheme: dark)', 'dark') ===
      'screen and (min-width: 700px) and ' + A,
      'the width guard on a rule survives the rewrite');
check(tuned('(prefers-color-scheme:dark)', 'dark') === A,
      'whitespace in the condition is the author\'s business, not ours');
check(tuned('print', 'dark') === 'print',
      'a query with no colour term is left exactly alone');
check(tuned('(prefers-color-scheme: dark)', '') === '(prefers-color-scheme: dark)',
      "handing the page back restores the author's own condition");

// ── the two settings are independent ───────────────────────────────────────
const dark = extractFn(src, '_articlesAreDark');
check(/_appTheme(Is)?Dark\(\)/.test(dark) && /'match'/.test(dark),
      'Match Zimi resolves through the app theme, not through the OS directly');
const sim = extractFn(src, '_darkenArticlesOn');
check(!/_appThemeIsDark/.test(sim),
      'and simulate no longer changes meaning when the app theme flips');

console.log('');
if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all article appearance checks passed');
