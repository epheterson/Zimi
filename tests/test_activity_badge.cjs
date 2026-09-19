// The download badge (#80). It appeared on the gear AND on the ⋯ (which on a
// desktop is the Create "+"), and on the X the gear becomes in the reader and
// on the Create page, and as a dot for indexing or seeding with no number to
// explain it. Eric: "Should only be on gear and downloads tab representing
// active downloads."
//
// Run: node tests/test_activity_badge.cjs   (exit 0 = pass)

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

// A gear with a badge slot, and a ⋯ that must never get one.
function makeEl() {
  const el = { children: [], style: {}, appendChild(c) { this.children.push(c); c.parent = this; c.classList.owner = c; }, querySelector(sel) { return this.children.find(c => c.className === sel.slice(1)) || null; } };
  return el;
}
const gear = makeEl(), more = makeEl();
const ctx = {
  mode: 'home', readerOpen: false, _almanacOpen: false, _createOpen: false,
  _activityBadge: { count: 2, active: true, tip: '2 downloading' },
  _openDownloadsView: () => {},
  document: {
    getElementById: id => id === 'manage-btn' ? gear : null,
    querySelector: sel => sel === '.topbar-more' ? more : null,
    createElement: () => ({ style: {}, classList: { toggle() {}, add(c) { if (c === 'dot') this.owner.dotted = true; } }, setAttribute(k, v) { this[k] = v; }, remove() { const p = this.parent; if (p) p.children = p.children.filter(c => c !== this); } }),
  },
};
vm.createContext(ctx);
vm.runInContext([
  extract(/function _gearIsAGear\(\) \{[\s\S]*?\n\}/, '_gearIsAGear'),
  extract(/function _applyActivityBadge\(\) \{[\s\S]*?\n\}/, '_applyActivityBadge'),
].join('\n'), ctx);

ctx._applyActivityBadge();
ok('two downloads: the gear carries a dot, not a number', gear.children.length === 1 && gear.children[0].textContent === '' && gear.children[0].dotted === true);
ok('the ⋯ carries nothing', more.children.length === 0);

ctx._activityBadge = { count: 0, active: true, tip: 'Indexing 3/10' };
ctx._applyActivityBadge();
ok('indexing with no download: no badge, no dot', gear.children.length === 0);

for (const state of [['mode', 'manage'], ['readerOpen', true], ['_almanacOpen', true], ['_createOpen', true]]) {
  ctx.mode = 'home'; ctx.readerOpen = false; ctx._almanacOpen = false; ctx._createOpen = false;
  ctx._activityBadge = { count: 2, active: true, tip: '' };
  ctx._applyActivityBadge();
  ctx[state[0]] = state[1];
  ctx._applyActivityBadge();
  ok('never on the X the gear becomes (' + state[0] + ')', gear.children.length === 0);
}

ok('the downloads tab keeps its own count', /class="dl-tab-badge"/.test(src));
ok('the ⋯ Manage row on a phone carries the count as a pill', /class="tbm-count"/.test(src) && !/forceDot/.test(src));
ok('the gear dot says what it is on hover', /badge\.title = st\.tip;/.test(src));

process.exit(failures ? 1 : 0);
