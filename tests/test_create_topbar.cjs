// The Create page carries no ⋯ menu, at any width.
//
// #68, tripplehelix: "Top bar menu is broken into a drop down when in the
// create zim page." Two separate mistakes ran into each other there.
//
// The first fix hid the inline Random/Language/gear buttons on Create, which
// put a wide desktop window into the mobile shape — three controls and a ⋯ —
// and that is what was reported. The inline buttons came back, but the ⋯ menu
// kept the branch that forced the nav group on at every width, so Random and
// Language ended up listed twice in the same bar. And because the reader group
// asks only whether an article is open, opening Create over an article
// carried Reader View and Read aloud in with it, on a page with no article.
// Five rows: two duplicated, two inert, one (Manage) behind the X anyway.
//
// So: no menu there. The way out is the X on desktop and the Zimi breadcrumb
// on a phone, and everything the menu offered is on the far side of it.
//
// Run: node tests/test_create_topbar.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.css'), 'utf8');

function fn(name) {
  const i = js.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(name + ' not found');
  let d = 0;
  for (let j = js.indexOf('{', i); j < js.length; j++) {
    if (js[j] === '{') d++;
    else if (js[j] === '}' && --d === 0) return js.slice(i, j + 1);
  }
  throw new Error('unbalanced ' + name);
}

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

const menu = fn('_buildTopbarMenuHtml');

// ── the menu's own contents ────────────────────────────────────────────────
check(/if \(readerOpen && !_almanacOpen && !_createOpen\)/.test(menu),
      'the reader group asks whether Create is open, not just whether an article is');
check(/if \(_isNarrow\(\)\) \{/.test(menu) && !/_isNarrow\(\) \|\| _createOpen/.test(menu),
      'the nav group is narrow-only again, so Random and Language are not listed twice');

// ── and the trigger itself ─────────────────────────────────────────────────
// Checked on both axes because they fail differently: the inline style covers
// the wide viewport, and only the class can beat the mobile rule.
// The ⋯ logic is its own function (_syncTopbarMore) so it can run again when
// an article loads; updateTopbar still owns body.creating.
check(/classList\.toggle\('creating', !!_createOpen\)/.test(fn('updateTopbar')),
      'body.creating tracks the page');
check(/_createOpen \? 'none'/.test(fn('_syncTopbarMore')), 'and the trigger is hidden while it is up');
check(/body\.creating \.topbar-more \{ display: none !important; \}/.test(css),
      'with !important, because the mobile rule that shows ⋯ is !important too');

// The mobile rule this has to outrank still exists; if it is ever dropped, the
// override above is dead weight and should go with it.
const mobileRule = css.indexOf('.topbar-more { display: flex !important; }');
check(mobileRule > 0 && css.indexOf('body.creating .topbar-more') > mobileRule,
      'and the override comes after it in source order');

// ── and the library chrome goes with it ────────────────────────────────────
// Random, the library/bookmark button and the history trail act on a library.
// Create is somewhere you went on purpose and is not a ZIM, the same as Manage
// and Almanac, so it joins them. Eric, 2026-09-13: "Bookmark button makes no
// sense there and history too... Language and X only?"
const sync2 = js.slice(js.indexOf('var libraryChromeOff'),
                       js.indexOf('_updateLibraryBtnIcon();'));
check(/var libraryChromeOff = mode === 'manage' \|\| _almanacOpen \|\| _createOpen;/.test(sync2),
      'Create hides the library chrome, like Manage and Almanac');
check(/var _readingArticle = readerOpen && !_almanacOpen && !_createOpen;/.test(js),
      'and an article open BEHIND Create does not leave its reader buttons in the bar');
check(/_readerViewAvailable\(\) && !_createOpen/.test(fn('_syncReaderViewBtn')),
      'including the Reader View button, which has no article to act on there');

// ── and the header says where you are ─────────────────────────────────────
// Create opens over whatever you were looking at. Without an identity of its
// own, that view showed through twice: the breadcrumb wore the last ZIM's icon
// and the search box wore its name — "Lit Docs", on the page where you make a
// new one. The Almanac already had this right, and says so in a comment:
// "never the underlying ZIM's icon bleeding through".
const topbar = fn('updateTopbar');
check(/if \(_createOpen\) \{[\s\S]*?bcIcon\.innerHTML = _CREATE_BC_ICON;/.test(topbar),
      'Create wears its own breadcrumb identity');
check(topbar.indexOf('if (_createOpen)') < topbar.indexOf('} else if (activeSource)'),
      'and it is asked before the underlying source, or the source still wins');
check(/bcIcon\.removeAttribute\('href'\)/.test(topbar.slice(topbar.indexOf('if (_createOpen)'),
                                                            topbar.indexOf('_almanacOpen) {'))),
      'identity only — there is no destination behind it to link to');
// The search box keeps its place and takes the page's name, exactly as the
// Almanac does one branch below. Before, it fell through to the ZIM behind.
check(/if \(_createOpen\) \{\s*\n[^}]*q\.placeholder = t\('create_zim'\);/.test(topbar),
      'the search box wears the page name, not the ZIM underneath');
check(topbar.indexOf("q.placeholder = t('create_zim')") <
      topbar.indexOf('q.placeholder = _zimTitle(currentSource)'),
      'and that branch is reached before the source one');

console.log('');
if (failures) {
  console.error(failures + ' create-topbar check(s) failed');
  process.exit(1);
}
console.log('all create-topbar checks passed');
