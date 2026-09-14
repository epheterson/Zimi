// A row that cannot act reads as off, refuses the click, and says why.
//
// Eric, 2026-09-13, on the BitTorrent row with no libtorrent installed: "If it
// says unavailable it should be stuck off in disabled state with that message."
// The switch rendered amber and ON, six inches from the word "unavailable" —
// the panel contradicting itself, and inviting a click that could not work.
//
// The second half is the harder one. Marking a row inactive dims it, and the
// sentence explaining WHY it is inactive is the one thing there still worth
// reading. CSS opacity on the row makes that impossible to exempt from inside:
// a child cannot be less transparent than its parent, so the obvious
// `.share-inactive .bt-why { opacity: 1 }` is dead CSS that looks like a fix.
// The note is therefore rendered OUTSIDE the dimmed block, and this test is
// what stops someone folding it back in.
//
// Run: node tests/test_share_row_states.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');

const APP_JS = path.join(__dirname, '..', 'zimi', 'static', 'app.js');
const APP_CSS = path.join(__dirname, '..', 'zimi', 'static', 'app.css');
const js = fs.readFileSync(APP_JS, 'utf8');
const css = fs.readFileSync(APP_CSS, 'utf8');

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

function block(src, needle, stop) {
  const i = src.indexOf(needle);
  if (i < 0) throw new Error('not found: ' + needle);
  const j = src.indexOf(stop, i);
  return src.slice(i, j < 0 ? src.length : j);
}

// ── the switch answers to the machine, not to the stored preference ────────
const render = block(js, 'const btUsable', "_shareSwitch('mirror'");
check(/const btUsable = !bt \|\| bt\.status !== 'unavailable';/.test(render),
      'usability is read from the reported status');
check(/const btOn = !!m\.torrent_enabled && btUsable;/.test(render),
      'a stored "on" cannot show as on when the machine cannot do it');
check(/!btUsable,/.test(render),
      'and the row is passed as inactive, so the switch refuses the click');
// Unavailable is the machine's answer. Claiming an env var did it names a
// cause the operator can go and change, and there is nothing there to change.
check(!/torrent_env_locked \|\| !btUsable/.test(render),
      'unavailable is not dressed up as an environment lock');

// ── the reason renders outside the dimmed block ────────────────────────────
const shareSwitch = block(js, 'function _shareSwitch(', '\nvar _btSettingInFlight');
check(/noteHtml\)\s*\{/.test(shareSwitch), '_shareSwitch takes a note slot');
const dimStart = shareSwitch.indexOf('share-row-dim');
const noteAt = shareSwitch.indexOf('(noteHtml ||');
const dimEnd = shareSwitch.indexOf("'</div>' +", dimStart);
check(dimStart > 0 && noteAt > dimEnd,
      'the note is emitted after the dimmed block closes, not inside it');
check(/id="ms-bt-why"/.test(render) && render.indexOf('id="ms-bt-why"') > render.indexOf('!btUsable'),
      'the BitTorrent reason is passed in that note slot');

// ── and the CSS dims the block, never the row ──────────────────────────────
check(!/^\s*\.share-inactive \{[^}]*opacity/m.test(css),
      'no blanket opacity on .share-inactive — it would swallow the note');
check(/\.share-inactive \.share-row-dim,\s*\n\s*\.share-inactive \.share-row-right \{[^}]*opacity: 0\.5/.test(css),
      'the dim applies to the inert parts only');

console.log('');
if (failures) {
  console.error(failures + ' share-row state check(s) failed');
  process.exit(1);
}
console.log('all share-row state checks passed');
