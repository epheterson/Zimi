// DOM-light regression tests for inline rename in the Saved panel (lists and items).
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
// 2. Rename semantics (Saved.rename): a custom name lives in `title` (the
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

// ── Saved.rename ────────────────────────────────────────────────────────────
{
  const store = {};
  const sandbox = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    SK: { SAVED: 'zimi_saved', SAVED_POS: 'zimi_saved_pos', SAVED_LEGACY_ASKED: 'zimi_saved_legacy_asked', BOOKMARKS: 'zimi_bookmarks', BM_FOLDERS: 'zimi_bm_folders', BOOK_PLACES: 'zimi_book_places' },
    Math, JSON, Object, Array, String, Number, isFinite, Date,
    saves: 0,
  };
  sandbox._savedChanged = function () { sandbox.saves++; };
  vm.createContext(sandbox);
  vm.runInContext(extract(/function _getStorageJSON\(key, fallback, session\) \{[\s\S]*?\nfunction _setStorageJSON\(key, value\) \{[\s\S]*?\n\}/, 'the storage helpers') + '\n' +
    extract(/var Saved = \(function \(\) \{[\s\S]*?\n\}\)\(\);/, 'Saved'), sandbox);
  const S = sandbox.Saved;
  const key = S.save({ zim: 'w', path: 'A/B', title: 'Original' });
  const b = () => S.get(key);

  const before = sandbox.saves;
  S.rename(key, 'My Name');
  ok('rename sets title', b().title === 'My Name', 'got ' + b().title);
  ok('rename parks original in origTitle', b().origTitle === 'Original', 'got ' + b().origTitle);
  ok('rename persists (a change is announced)', sandbox.saves === before + 1 && store.zimi_saved.indexOf('My Name') >= 0);

  S.rename(key, 'Other Name');
  ok('second rename keeps the ORIGINAL origTitle', b().origTitle === 'Original', 'got ' + b().origTitle);
  ok('second rename sets new title', b().title === 'Other Name');

  S.rename(key, '');
  ok('empty rename reverts title', b().title === 'Original', 'got ' + b().title);
  ok('empty rename clears origTitle', !('origTitle' in b()));

  S.rename(key, 'Custom');
  S.rename(key, 'Original');
  ok('typing the original back = revert, not a custom name',
    b().title === 'Original' && !('origTitle' in b()));

  const savesBefore = sandbox.saves;
  S.rename('w\nNOPE', 'x');
  ok('unknown item is a no-op', sandbox.saves === savesBefore);
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
  sandbox._bmIsCollapsed = () => false;
  sandbox._bmToggleCollapse = () => {};
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
