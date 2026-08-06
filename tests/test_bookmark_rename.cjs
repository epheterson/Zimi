// DOM-light regression tests for bookmark/folder inline rename (bookmarks v2).
//
// Two bugs/behaviors this guards:
//
// 1. "Rename keeps exiting edit mode on arrow keys / spacebar." The tree's
//    delegated keydown (_bmTreeKeydown) matched the row CONTAINING the inline
//    input: ArrowUp/Down moved row focus (the input blurred, which commits) and
//    Space did preventDefault + row.click() (rerender destroyed the input).
//    Fixed twice over: _bmTreeKeydown bails when the event target is an input,
//    and _bmBindEditInput stops propagation of every key so nothing upstream
//    (tree handler, document-level Escape) ever sees keys typed into an edit.
//
// 2. Bookmark rename semantics (_bkRename): custom name lives in `title` (the
//    one display field every consumer reads), original title parks in
//    `origTitle`; empty rename — or typing the original back — reverts.
//
// Same vm-extraction approach as test_ctx_submenu_placement.cjs.
//
// Run: node tests/test_bookmark_rename.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
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

// ── _bkRename ───────────────────────────────────────────────────────────────
{
  const sandbox = { saves: 0 };
  vm.createContext(sandbox);
  sandbox._titleFromPath = p => 'From:' + p;
  sandbox._bkSave = function () { sandbox.saves++; };
  sandbox.setBooks = function (list) { sandbox._books = list; };
  sandbox._bkLoad = function () { return sandbox._books; };
  sandbox._bkFind = function (zim, p) {
    return sandbox._books.findIndex(b => b.zim === zim && b.path === p);
  };
  vm.runInContext(
    extract(/function _bkRename\(zim, path, name\)\s*\{[\s\S]*?\n\}/, '_bkRename'),
    sandbox);
  const books = [{ zim: 'w', path: 'A/B', title: 'Original', timestamp: 1 }];
  sandbox.setBooks(books);
  const b = books[0];

  vm.runInContext("_bkRename('w','A/B','My Name')", sandbox);
  ok('rename sets title', b.title === 'My Name', 'got ' + b.title);
  ok('rename parks original in origTitle', b.origTitle === 'Original', 'got ' + b.origTitle);
  ok('rename persists (save called)', sandbox.saves === 1);

  vm.runInContext("_bkRename('w','A/B','Other Name')", sandbox);
  ok('second rename keeps the ORIGINAL origTitle', b.origTitle === 'Original', 'got ' + b.origTitle);
  ok('second rename sets new title', b.title === 'Other Name');

  vm.runInContext("_bkRename('w','A/B','')", sandbox);
  ok('empty rename reverts title', b.title === 'Original', 'got ' + b.title);
  ok('empty rename clears origTitle', !('origTitle' in b));

  vm.runInContext("_bkRename('w','A/B','Custom')", sandbox);
  vm.runInContext("_bkRename('w','A/B','Original')", sandbox);
  ok('typing the original back = revert, not a custom name',
    b.title === 'Original' && !('origTitle' in b));

  // No title on the record → original derives from the path.
  const books2 = [{ zim: 'w', path: 'A/C', timestamp: 2 }];
  sandbox.setBooks(books2);
  vm.runInContext("_bkRename('w','A/C','Nice')", sandbox);
  ok('untitled record derives original from path',
    books2[0].title === 'Nice' && books2[0].origTitle === 'From:A/C',
    JSON.stringify(books2[0]));
  vm.runInContext("_bkRename('w','A/C','')", sandbox);
  ok('untitled record reverts to path-derived title', books2[0].title === 'From:A/C');

  const savesBefore = sandbox.saves;
  vm.runInContext("_bkRename('w','NOPE','x')", sandbox);
  ok('unknown bookmark is a no-op', sandbox.saves === savesBefore);
}

// ── _bmBindEditInput: every key stays in the input ──────────────────────────
{
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    extract(/function _bmBindEditInput\(input, commit\)\s*\{[\s\S]*?\n\}/, '_bmBindEditInput'),
    sandbox);

  const handlers = {};
  const input = { addEventListener: (type, fn) => { handlers[type] = fn; } };
  const commits = [];
  sandbox.input = input;
  sandbox.commit = v => commits.push(v);
  vm.runInContext('_bmBindEditInput(input, commit)', sandbox);

  function press(key) {
    const e = { key: key, stopped: false, prevented: false,
      stopPropagation() { this.stopped = true; },
      preventDefault() { this.prevented = true; } };
    handlers.keydown(e);
    return e;
  }

  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Home', 'End', 'a', 'F2'].forEach(k => {
    const e = press(k);
    ok("input swallows '" + k + "' (stopPropagation, no preventDefault, no commit)",
      e.stopped && !e.prevented && commits.length === 0);
  });

  let e = press('Enter');
  ok('Enter commits(true) and stops', e.stopped && e.prevented &&
    commits.length === 1 && commits[0] === true);
  e = press('Escape');
  ok('Escape commits(false) and stops', e.stopped && e.prevented &&
    commits.length === 2 && commits[1] === false);
  handlers.blur({});
  ok('blur commits(true)', commits.length === 3 && commits[2] === true);
}

// ── _bmTreeKeydown: guard for inline edits, still live for rows ─────────────
{
  const sandbox = { focused: [], prevented: 0 };
  vm.createContext(sandbox);
  sandbox._bmRows = function () { return sandbox._rows; };
  sandbox._bmFocusRow = function (r) { sandbox.focused.push(r); };
  sandbox._bmRowKey = () => 'k';
  sandbox._bmRowByKey = () => null;
  sandbox._bmParentRow = () => null;
  sandbox._folIsCollapsed = () => false;
  sandbox._folToggleCollapse = () => {};
  sandbox._bmRerender = () => {};
  sandbox._bmOpenRowMenu = () => {};
  vm.runInContext(
    extract(/function _bmTreeKeydown\(e\)\s*\{[\s\S]*?\n\}/, '_bmTreeKeydown'),
    sandbox);

  function row(name) {
    return { name, classList: { contains: () => false },
      parentNode: { id: 'bm-tree' }, dataset: { fid: '' },
      click() { this.clicked = true; } };
  }
  const r1 = row('r1'), r2 = row('r2');
  sandbox._rows = [r1, r2];

  function fire(key, target) {
    const e = { key, target, prevented: false,
      preventDefault() { this.prevented = true; } };
    sandbox.e = e;
    vm.runInContext('_bmTreeKeydown(e)', sandbox);
    return e;
  }

  // Keys typed into the rename/new-folder input never drive the tree.
  ['ArrowDown', 'ArrowUp', ' ', 'Home', 'End', 'Enter', 'F2'].forEach(k => {
    const e = fire(k, { tagName: 'INPUT', closest: () => r1 });
    ok("tree ignores '" + k + "' from an input (no preventDefault, no focus move)",
      !e.prevented && sandbox.focused.length === 0 && !r1.clicked);
  });

  // Control: the same keys on a real row still work (guard is not over-broad).
  let e = fire('ArrowDown', { tagName: 'DIV', closest: () => r1 });
  ok('ArrowDown on a row still navigates',
    e.prevented && sandbox.focused.length === 1 && sandbox.focused[0] === r2);
  e = fire(' ', { tagName: 'DIV', closest: () => r1 });
  ok('Space on a row still activates it', e.prevented && r1.clicked === true);
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL PASS');
process.exit(failures ? 1 : 0);
