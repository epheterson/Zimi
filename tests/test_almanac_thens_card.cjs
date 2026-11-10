// The There and then card (almanac-thens.js): the moment's date and local time come first, plainly, and "Stand there then" is the one
// primary button; the live sky beside it is quiet. Nothing travels on the first tap (the card is a caption, the button is the trip).
// Run: node tests/test_almanac_thens_card.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'zimi', 'static');
let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}

const S = vm.createContext({
  Intl, Date, JSON, Math, String, Array, isFinite,
  _aeT: (k) => '[' + k + ']',
  _almAsset: (p) => p,
  _almEsc: (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
  _almTzForLocation: () => 'America/Los_Angeles',
  _tzFmt: (tz, o) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz }, o)),
});
vm.runInContext(fs.readFileSync(path.join(STATIC, 'almanac-thens.js'), 'utf8'), S);

const data = JSON.parse(fs.readFileSync(path.join(STATIC, 'earth', 'thens-v1.json'), 'utf8'));
const earth = data.moments.find((m) => m.id === 'launch-starlink-4-31-la');
const other = data.moments.find((m) => m.place.body && m.place.body !== 'earth');
const html = vm.runInContext('_atDetailHtml', S)(earth);

const first = html.indexOf('</h3>');
check(first > 0 && html.slice(first + 5).startsWith('<p class="at-when">'), 'the first line after the title is the date and time');
const when = (html.match(/<p class="at-when">([^<]*)<\/p>/) || [])[1] || '';
check(/2022/.test(when) && /\d:\d\d/.test(when) && /Oct/.test(when), 'it reads the local date and time plainly: ' + when);
check(/\b6:\d\d PM\b/.test(when), 'in the place\'s own zone (Los Angeles evening, not UTC): ' + when);
check((html.match(/at-primary/g) || []).length === 1 && /class="ae-btn at-primary" id="at-stand"/.test(html), 'exactly one primary button, and it is Stand there then');
check(/id="at-sky"/.test(html) && !/at-primary" id="at-sky"/.test(html), 'the live sky is there and quiet');
check(!/<li><svg[^>]*><path d="M4 6h16v14H4z/.test(html), 'the date is not repeated in the facts');
if (other) {
  const h2 = vm.runInContext('_atDetailHtml', S)(other);
  check((h2.match(/at-primary/g) || []).length === 1 && !/id="at-sky"/.test(h2), 'on another body: one primary button and no live sky');
}
const css = fs.readFileSync(path.join(STATIC, 'almanac-launches.js'), 'utf8');
check(/\.al-acts \.at-primary[^}]*background:var\(--amber\)/.test(css), 'the primary button is the amber one');
process.exit(failures ? 1 : 0);
