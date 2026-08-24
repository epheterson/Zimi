// How many things a ZIM holds, as a person would count them.
//
// Eric, looking at the home screen: "Count of articles also isn't right." A
// 645MB post-disaster library and a 67MB medical one both introduced
// themselves as "1 entries" — the wrong number AND the wrong grammar, in the
// one count on the page that never used the plural helper.
//
// The number is libzim's `article_count`, and libzim counts what the ZIM
// DECLARES an article. Right for an encyclopedia, wrong for a document
// collection: every zimgit library declares one article — its index — and
// keeps its hundreds of PDFs as ordinary entries.
//
// Run: node tests/test_zim_count.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
const m = src.match(/function _zimCount\(z\) \{[\s\S]*?\n\}/);
if (!m) { console.error('could not extract _zimCount from app.js'); process.exit(1); }

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(m[0], sandbox);
const { _zimCount } = sandbox;

let failures = 0;
function check(cond, label) {
  if (cond) { console.log('ok: ' + label); }
  else { console.error('FAIL: ' + label); failures++; }
}

check(_zimCount({ article_count: 1, entries: 803 }) === 803,
  'a document collection is counted by its documents, not by its index page');
check(_zimCount({ article_count: 1, entries: 904 }) === 904,
  'and the 645MB post-disaster library says 904, not 1');

// The case where 1 IS the truth: a captured page is one page plus the images
// and stylesheets it needs, and those are marked as Zimi's own.
check(_zimCount({ article_count: 1, entries: 413, zimi_export: true }) === 1,
  'a captured page stays one page, however many assets it carried');

// The normal case must be untouched.
check(_zimCount({ article_count: 18982214, entries: 27199904 }) === 18982214,
  'a real article count is always preferred');
check(_zimCount({ article_count: 3329, entries: 12980 }) === 3329,
  'xkcd counts its comics, not its thumbnails');

// Degenerate inputs answer without inventing anything.
check(_zimCount({ article_count: 1, entries: 1 }) === 1,
  'one entry and one article is simply one');
check(_zimCount({ entries: 42 }) === 42, 'no article count falls back to entries');
check(_zimCount({}) === undefined, 'a ZIM that reports neither reports nothing');
check(_zimCount(null) === undefined, 'nothing in, nothing out');

console.log(failures ? `\n${failures} FAILED` : '\nPASS');
process.exit(failures ? 1 : 0);
