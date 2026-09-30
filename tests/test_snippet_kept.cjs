// A search result's snippet is asked of the server once. The quick first
// pass and the full results draw many of the same cards; each redraw used
// to ask for every snippet again (40 asks for 20 results).
//
// Run: node tests/test_snippet_kept.cjs   (exit 0 = pass)

const vm = require('vm');
const src = require('./app_source.cjs')();

let failures = 0;
const check = (ok, label) => { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); };

function grab(head) {
  const i = src.indexOf('\n' + head);
  if (i < 0) throw new Error('not found: ' + head);
  const start = i + 1;
  const lineEnd = src.indexOf('\n', start);
  if (!src.slice(start, lineEnd).trimEnd().endsWith('{')) return src.slice(start, lineEnd);
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
}

const asked = [];
const box = {
  Map, Promise,
  fetch: (url) => {
    asked.push(url);
    return new Promise(r => setTimeout(() => r({ ok: !url.includes('broken'), json: () => Promise.resolve({ snippet: 'about ' + url }) }), 5));
  },
};
vm.createContext(box);
vm.runInContext([
  grab('var _snippetKept = '), grab('var _snippetPending = '), grab('var SNIPPET_KEPT_MAX = '),
  grab('function _snippetData('),
].join('\n'), box);

(async () => {
  // Two redraws asking at once, then a third after the answer: one ask.
  const [a, b] = await Promise.all([box._snippetData('wiki', 'A/Water'), box._snippetData('wiki', 'A/Water')]);
  const c = await box._snippetData('wiki', 'A/Water');
  check(asked.length === 1, 'one ask for the same snippet, in flight or kept (' + asked.length + ')');
  check(a.snippet && a === b && b === c, 'every card gets the same answer');

  await box._snippetData('wiki', 'A/Fire');
  check(asked.length === 2, 'a different page is its own ask');

  // A failed answer is not kept: the next draw asks again.
  await box._snippetData('wiki', 'broken');
  await box._snippetData('wiki', 'broken');
  check(asked.length === 4, 'a failed snippet is asked again');

  // Bounded: the oldest goes first.
  box.SNIPPET_KEPT_MAX = 3;
  vm.runInContext('SNIPPET_KEPT_MAX = 3', box);
  for (const p of ['x1', 'x2', 'x3']) await box._snippetData('wiki', p);
  check(vm.runInContext('_snippetKept.size', box) === 3, 'the kept snippets stay within their bound');
  check(!vm.runInContext("_snippetKept.has('wiki\\nA/Water')", box), 'the oldest is let go first');

  // The results' queue stops at a redraw instead of asking for the rest.
  check(/while \(!signal\.aborted && active < concurrency/.test(src), 'a redraw stops the old queue');
  check(/const data = await _snippetData\(zim, path\);\s*\/\/[^\n]*\n\s*if \(signal\.aborted\) return;/.test(src), 'an old card is not written into after a redraw');

  if (failures) { console.error(failures + ' failed'); process.exit(1); }
  console.log('all passed');
})();
