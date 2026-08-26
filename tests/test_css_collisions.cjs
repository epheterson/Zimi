// Two rules, one class name, two different components.
//
// app.css is one file with no build step, which is a deliberate choice and a
// real constraint: nothing warns you that the component you are styling today
// shares a class name with one somebody wrote two thousand lines earlier. CSS
// does not error on that. It merges them, silently, property by property, and
// what you get is a third layout neither author drew.
//
// That is exactly what happened to the create page's header. The run header
// was given `.create-head { display:flex; align-items:center; gap:12px }` so a
// favicon could sit beside the site's name. The page header already had
// `.create-head { display:flex; flex-direction:column; gap:4px }`. Same
// selector, same specificity, later rule wins per property — so the run header
// kept `column` from a rule it thought it was replacing and picked up
// `align-items:center` on top. A column that centres its children shrinks the
// text block to the title's own width and centres it, which left the mode line
// flush-left under a centred title:
//
//     [       CNN — Breaking News, Latest News and Videos       ]
//     [ Web page · cnn.com                                      ]
//
// Eric, at the release gate: 'The "web page" string not being centered on
// title is weird.' It was not a copy bug or a text-align bug. It was two
// components wearing one class name.
//
// So: a top-level selector may be declared more than once, but not twice with
// the same property, and not twice with layout properties — those two shapes
// are how one rule silently eats another. Additive cases (a base rule plus a
// later `position: relative`) are fine and stay fine.
//
// Run: node tests/test_css_collisions.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'zimi', 'static', 'app.css'), 'utf8');

// Properties that decide the SHAPE of a box rather than its paint. Two rules
// splitting these between them is the failure above; two rules splitting
// colour and font is just organisation.
const LAYOUT = new Set([
  'display', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content',
  'grid-template-columns', 'grid-template-rows', 'position',
]);

// Selectors legitimately declared twice, each with WHY. A base rule plus a
// later additive one is not the bug this test is about.
const ALLOWED = new Map([
  ['.topbar-more', 'base rule, plus a later `position: relative` for its menu'],
  ['.stat-card', 'base rule, plus a later `position: relative` for its badge'],
  ['.manage-settings',
   'the tab model deliberately re-declares display:none, with ' +
   '.as-tab-active restoring flex'],
]);

// ── parse: top-level rules only ─────────────────────────────────────────────
// Rules inside @media/@supports are SUPPOSED to restate selectors — that is
// what a media query is — so only the unconditional layer is checked.
function topLevelRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let depth = 0, buf = '', selector = '', atRule = false;
  for (const ch of clean) {
    if (ch === '{') {
      if (depth === 0) {
        selector = buf.trim();
        atRule = selector.startsWith('@');
        buf = '';
      }
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && selector && !atRule) rules.push({ selector, body: buf });
      if (depth === 0) { selector = ''; atRule = false; }
      buf = '';
      continue;
    }
    buf += ch;
  }
  return rules;
}

function props(body) {
  return new Set(
    [...body.matchAll(/(^|;)\s*(-{0,2}[a-z][a-z0-9-]*)\s*:/gi)].map(m => m[2].toLowerCase())
  );
}

let failures = 0;
function check(ok, label) {
  console.log((ok ? 'ok: ' : 'FAIL: ') + label);
  if (!ok) failures++;
}

const rules = topLevelRules(CSS);
check(rules.length > 500, `parsed ${rules.length} top-level rules`);

const bySelector = new Map();
for (const r of rules) {
  if (!bySelector.has(r.selector)) bySelector.set(r.selector, []);
  bySelector.get(r.selector).push(props(r.body));
}

const sameProp = [];
const layoutSplit = [];
for (const [selector, declarations] of bySelector) {
  if (declarations.length < 2) continue;
  if (ALLOWED.has(selector)) continue;

  // (a) the same property declared in two blocks: one of them is dead code,
  // and which one is dead depends on file order rather than on intent.
  const seen = new Set();
  const repeated = new Set();
  for (const d of declarations) for (const p of d) {
    if (seen.has(p)) repeated.add(p); else seen.add(p);
  }
  if (repeated.size) sameProp.push(`${selector} redeclares ${[...repeated].join(', ')}`);

  // (b) layout properties spread across two blocks: the merged box is a shape
  // neither block describes on its own.
  const withLayout = declarations.filter(d => [...d].some(p => LAYOUT.has(p)));
  if (withLayout.length > 1) {
    layoutSplit.push(
      `${selector} sets layout in ${withLayout.length} separate rules ` +
      `(${withLayout.map(d => [...d].filter(p => LAYOUT.has(p)).join('+')).join(' | ')})`
    );
  }
}

check(sameProp.length === 0,
  'no top-level selector declares the same property twice' +
  (sameProp.length ? '\n    ' + sameProp.join('\n    ') : ''));

check(layoutSplit.length === 0,
  'no top-level selector has its layout split across rules' +
  (layoutSplit.length ? '\n    ' + layoutSplit.join('\n    ') : ''));

// ── and the specific rule that got it wrong ─────────────────────────────────
// The run header's styling must stay scoped to the run, because the page
// header answers to the same class name and wants the opposite shape.
check(/\.create-run\s+\.create-head\s*\{[^}]*flex-direction:\s*row/.test(CSS),
  'the run header is a scoped ROW (icon beside the name), not a bare .create-head');
check(!/^\s*\.create-head\s*\{[^}]*align-items/m.test(CSS),
  'no bare .create-head rule centres its children — that is the run header\'s business');

console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`);
process.exit(failures ? 1 : 0);
