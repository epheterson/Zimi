// Made Here has to actually arrive.
//
// Eric, 2026-09-13, on the NAS: "Why does this never load?? 😭 drop the made
// here section entirely?" It never loaded, and nothing about the server was
// wrong — the endpoint answers in 41ms and the provenance it needs was already
// cached on disk. The pane erased its own answer.
//
// _creatorHtml() builds the pane as a STRING and, part way through building it,
// calls _creatorLoadInventory(). When the inventory is already in hand that
// used to fill the slot synchronously — writing into the DOM the pane is about
// to replace — and then the string being built, which still contains the
// "Loading…" placeholder, was assigned over the top. Nothing filled it again.
//
// The cruel part is that it happens precisely when the answer is ALREADY here,
// so the faster the server, the more reliably it hangs. Chasing it through the
// server was chasing the one part that was working.
//
// Run: node tests/test_creator_made_here.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');

const APP_JS = path.join(__dirname, '..', 'zimi', 'static', 'app.js');
const src = [APP_JS.replace('app.js', 'manage.js'), APP_JS].map((f) => fs.readFileSync(f, 'utf8')).join('\n');

function grab(name) {
  const needle = `function ${name}(`;
  const i = src.indexOf(needle);
  if (i < 0) throw new Error(name + ' not found in app.js');
  let j = src.indexOf('{', i), d = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1);
  }
  throw new Error('unbalanced ' + name);
}

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

const loader = grab('_creatorLoadInventory');

// The cached branch must not fill during the caller's own string-building.
const cachedBranch = loader.slice(
  loader.indexOf('if (_creatorInventory)'),
  loader.indexOf('if (_creatorInventory)') + 90
);
check(/setTimeout\(\s*fill/.test(cachedBranch),
      'an inventory already in hand is filled in AFTER the caller has painted');
check(!/if \(_creatorInventory\)\s*\{\s*fill\(\);/.test(loader),
      'and never synchronously, which is what put "Loading…" on top of it');

// The caller is the reason: it is still assembling the markup when it asks.
const builder = grab('_creatorHtml');
const askIndex = builder.indexOf('_creatorLoadInventory()');
const returnIndex = builder.lastIndexOf('return h');
check(askIndex > 0 && returnIndex > askIndex,
      'the pane still asks for the inventory before it has returned its HTML');
check(builder.indexOf("id=\"ms-cr-made\"") > 0,
      'and the slot it fills is written in that same string');

// A fetch that fails must leave a sentence, not a spinner. The spinner is the
// one state that cannot resolve itself.
check(/catch\(/.test(loader) || /\.catch\(/.test(loader),
      'a failed fetch is handled rather than left spinning');
check(/creator_made_empty/.test(loader),
      'and it says so in words');

console.log('');
if (failures) {
  console.error(failures + ' made-here check(s) failed');
  process.exit(1);
}
console.log('all made-here checks passed');
