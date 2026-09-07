// The two pictures on the Create done card.
//
// Live beside packaged, at the moment the person is looking at the result —
// the comparison the whole feature exists for. Drawn from the result's own
// `pictures` flags, served from the ZIM's metadata, never inlined.
//
// Run: node tests/test_create_shots.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'create.js'), 'utf8');
function extractFn(s, name) {
  const i = s.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(name + ' not found');
  let j = s.indexOf('{', i), d = 0;
  for (; j < s.length; j++) {
    if (s[j] === '{') d++;
    else if (s[j] === '}' && --d === 0) return s.slice(i, j + 1);
  }
  throw new Error('unbalanced ' + name);
}
const sandbox = {
  console,
  encodeURIComponent,
  escAttr: (s) => String(s).replace(/"/g, '&quot;'),
  tH: (k) => k,
};
vm.createContext(sandbox);
vm.runInContext(extractFn(src, '_createShotsHtml'), sandbox);
const html = (r) => vm.runInContext('_createShotsHtml(' + JSON.stringify(r) + ')', sandbox);

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}

const both = html({ name: 'space jam', pictures: { live: true, zim: true } });
check((both.match(/<a class="create-shot"/g) || []).length === 2, 'both pictures render as two links');
check(both.includes('/w/space%20jam/-/shot-live') && both.includes('/w/space%20jam/-/shot-zim'),
  'served from the ZIM metadata routes, name encoded');
check(both.includes('create-shots pair'), 'side by side when both exist');
check(!/data:image|base64/.test(both), 'never inlined');

const liveOnly = html({ name: 'x', pictures: { live: true, zim: false } });
check((liveOnly.match(/<a class="create-shot"/g) || []).length === 1 && !liveOnly.includes('pair'),
  'one picture renders alone, not as a pair');

check(html({ name: 'x', pictures: { live: false, zim: false } }) === '', 'no pictures, no strip');
check(html({ name: 'x' }) === '', 'no flags, no strip');
check(html({ pictures: { live: true, zim: true } }) === '', 'no name, no route, no strip');

// And the done card actually places it.
const done = extractFn(src, '_createMountDone');
check(/_createShotsHtml\(r\)/.test(done), '_createMountDone draws the pair');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all create-shots checks passed');
