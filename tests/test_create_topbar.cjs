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
const sync = js.slice(js.indexOf("var moreBtn = document.querySelector('.topbar-more')") - 400,
                      js.indexOf('_syncTopbarMoreSolo(moreBtn)') + 40);
check(/classList\.toggle\('creating', !!_createOpen\)/.test(sync),
      'body.creating tracks the page');
check(/_createOpen \? 'none'/.test(sync), 'and the trigger is hidden while it is up');
check(/body\.creating \.topbar-more \{ display: none !important; \}/.test(css),
      'with !important, because the mobile rule that shows ⋯ is !important too');

// The mobile rule this has to outrank still exists; if it is ever dropped, the
// override above is dead weight and should go with it.
const mobileRule = css.indexOf('.topbar-more { display: flex !important; }');
check(mobileRule > 0 && css.indexOf('body.creating .topbar-more') > mobileRule,
      'and the override comes after it in source order');

console.log('');
if (failures) {
  console.error(failures + ' create-topbar check(s) failed');
  process.exit(1);
}
console.log('all create-topbar checks passed');
