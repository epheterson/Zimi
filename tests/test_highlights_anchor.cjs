// Highlights (1.12): a passage found again by what it says.
//
// Runs highlights.js's matcher on text alone (the page's text as the engine
// compares it: no whitespace, lower case): the same words with other spacing
// and case, the same words three times over (the context decides, then the
// place in the page), a newer build with text added before and the passage
// re-spaced, a passage that is gone, right-to-left text, and a long passage
// kept as its start and end. The DOM side (text nodes split and re-wrapped,
// Reader View, a book's pages) runs in tests/test_highlights_live.py.
//
// Run: node tests/test_highlights_anchor.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'highlights.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src + '\nthis.E = ZimiHighlightsEngine;', ctx);
const E = ctx.E;

let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}
const C = E._canon;
// A selector as the engine makes one: the passage, 32 characters of context
// on either side, where it starts as a share of the text.
function describe(text, start, end) {
  const T = C(text), s = C(text.slice(0, start)).length, e = s + C(text.slice(start, end)).length;
  return { exact: text.slice(start, end).replace(/\s+/g, ' ').trim(), prefix: T.slice(Math.max(0, s - 32), s), suffix: T.slice(e, e + 32), pos: s / T.length };
}
// Where the match lands, as the words of the original text around it.
function found(text, sel) {
  const T = C(text), at = E._locateIn(T, sel);
  return at ? T.slice(at.start, at.end) : null;
}
function startOf(text, sel) { const at = E._locateIn(C(text), sel); return at ? at.start : -1; }

const PAGE = 'A lighthouse is a tower that guides ships. The old lighthouse stood on the northern cape for two centuries. ' +
  'Sailors in the fog trusted the old lighthouse to take them past the reef. ' +
  'When the storm came in 1881 the old lighthouse lost its lamp, and the keeper wrote it down.';
// The n-th place of w in s, in any case (as the engine compares).
const nth = (s, w, n) => { let i = -1; for (let k = 0; k <= n; k++) i = s.toLowerCase().indexOf(w.toLowerCase(), i + 1); return i; };

// ── the same words, spaced and cased otherwise ──
{
  const sel = describe(PAGE, nth(PAGE, 'the old lighthouse', 1), nth(PAGE, 'the old lighthouse', 1) + 18);
  const respaced = PAGE.replace(/ the old lighthouse to take/, ' the\n   OLD\u00a0Light\u00adhouse   to take');
  ok('whitespace, a no-break space and a soft hyphen are not compared', found(respaced, sel) === 'theoldlighthouse');
  ok('nor is case', startOf(respaced, sel) === startOf(PAGE, sel) && startOf(PAGE, sel) >= 0);
  ok('the text is compared without whitespace and in lower case', C('  The Old\n\tLighthouse ') === 'theoldlighthouse');
  ok('a character whose lower case is longer keeps the length', C('\u0130stanbul').length === '\u0130stanbul'.length);
}

// ── three times the same words ──
{
  const T = C(PAGE);
  [0, 1, 2].forEach((n) => {
    const s = nth(PAGE, 'the old lighthouse', n), sel = describe(PAGE, s, s + 18);
    ok('repeat ' + (n + 1) + ' of 3 is found where it was, not at the first', startOf(PAGE, sel) === C(PAGE.slice(0, s)).length);
  });
  // The context alone decides, whatever the place says.
  const s = nth(PAGE, 'the old lighthouse', 2), sel = describe(PAGE, s, s + 18);
  sel.pos = 0;
  ok('the context outweighs a wrong place in the page', startOf(PAGE, sel) === C(PAGE.slice(0, s)).length);
  ok('matches are counted in the compared text', T.indexOf('theoldlighthouse') >= 0);
}
{
  // Same words, same context each time (a refrain): the place decides.
  const verse = 'Row, row, row your boat. ';
  const song = verse.repeat(6);
  [0, 3, 5].forEach((n) => {
    const s = n * verse.length, sel = describe(song, s, s + 23);
    ok('a refrain repeated word for word: verse ' + (n + 1) + ' by its place in the page', startOf(song, sel) === C(song.slice(0, s)).length);
  });
}

// ── a newer build of the same page ──
{
  const s = nth(PAGE, 'the storm came in 1881', 0), sel = describe(PAGE, s, s + 22);
  const newer = 'Contents. Etymology: from Greek pharos. ' + PAGE.replace('When the storm came in 1881', 'When the  Storm came in\n1881') +
    ' See also: lightships, beacons and daymarks, and the long history of the keepers.';
  ok('a newer build, text added before and after, the passage re-spaced: found', found(newer, sel) === 'thestormcamein1881');
  const lost = describe(PAGE, PAGE.indexOf('guides ships'), PAGE.indexOf('guides ships') + 12);
  ok('words that are gone from the newer build: not found, never a guess', found(PAGE.replace('guides ships', 'warns vessels'), lost) === null);
  const s2 = nth(PAGE, 'the old lighthouse', 1), sel2 = describe(PAGE, s2, s2 + 18);
  const moved = 'The old lighthouse was painted white in 1920. ' + PAGE;
  ok('another repeat added in front: the one highlighted is still the one found', startOf(moved, sel2) === C(moved.slice(0, moved.indexOf('Sailors'))).length + C('Sailors in the fog trusted ').length);
}

// ── right to left ──
{
  const ar = 'كانت المنارة القديمة على الرأس الشمالي. ثم هدمت العاصفة المنارة القديمة في الشتاء. وبنى الناس المنارة القديمة من جديد.';
  const s = nth(ar, 'المنارة القديمة', 1), sel = describe(ar, s, s + 'المنارة القديمة'.length);
  ok('Arabic: the second of three repeats', startOf(ar, sel) === C(ar.slice(0, s)).length && found(ar, sel) === C('المنارة القديمة'));
  const he = 'המגדלור הישן עמד על הכף. הסערה פגעה במגדלור הישן. ';
  const s2 = he.indexOf('במגדלור הישן'), sel2 = describe(he, s2, s2 + 'במגדלור הישן'.length);
  ok('Hebrew, with a direction mark inserted and re-spaced: found', found(he.replace('במגדלור הישן', '\u200fבמגדלור   הישן'), sel2) === C('במגדלור הישן'));
  const vowels = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ';
  ok('Arabic with its marks is found as written', found(vowels, describe(vowels, 7, 19)) === C(vowels.slice(7, 19)));
}

// ── a long passage: its start and its end ──
{
  const words = [];
  for (let i = 0; i < 160; i++) words.push('word' + i);
  const text = 'Before. ' + words.join(' ') + ' After.';
  const s = text.indexOf('word10 '), e = text.indexOf('word150') + 'word150'.length;
  const shown = text.slice(s, e);
  const sel = { exact: shown.slice(0, 300), end: shown.slice(-300), n: C(shown).length, prefix: C(text.slice(0, s)).slice(-32), suffix: C(text.slice(e)).slice(0, 32), pos: 0.01 };
  const at = E._locateIn(C(text), sel);
  ok('a passage longer than 600 characters is found by its start and end', at && C(text).slice(at.start, at.end) === C(shown));
  const grown = text.replace('word80 ', 'word80 and a few words more ');
  const at2 = E._locateIn(C(grown), sel);
  ok('and still when a few words were added in its middle', at2 && C(grown).slice(at2.start, at2.end).endsWith('word150'));
  ok('but not when its end is gone', E._locateIn(C(text.replace('word150', 'nothing')), sel) === null);
}

ok('an empty passage is never found', E._locateIn('abc', { exact: '   ' }) === null && E._locateIn('abc', null) === null);

console.log(failures ? '\n' + failures + ' FAILED' : '\nall anchoring checks passed');
process.exit(failures ? 1 : 0);
