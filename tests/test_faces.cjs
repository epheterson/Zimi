// A capture that kept both of the site's faces opens the right one.
//
// A site with a media-query dark mode serves a different page to a reader who
// prefers dark. A capture could only ever keep one, so someone reading in dark
// opened a captured site and got the light one — not what the site does.
//
// Run: node tests/test_faces.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(name + ' not found');
  let j = src.indexOf('{', i), d = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1);
  }
  throw new Error('unbalanced ' + name);
}

// `dark` here is whether ARTICLES are being drawn dark, which since
// 2026-09-13 is its own setting (Article theme: Match Zimi / Dark / Light)
// rather than the app theme read directly. Pinning articles dark in a light
// Zimi has to open the capture's dark face — it is the same question the rest
// of the reader now asks.
let dark = true;
const info = {
  twofaced: { main_path: 'A/index', faces: { main: 'light', other: { scheme: 'dark', path: 'A/index~other' } } },
  plain: { main_path: 'A/index' },
  darkmain: { main_path: 'A/index', faces: { main: 'dark', other: { scheme: 'light', path: 'A/index~other' } } },
};
const sandbox = { console, _zimInfo: (n) => info[n], _articlesAreDark: () => dark };
vm.createContext(sandbox);
vm.runInContext(grab('_facePathFor'), sandbox);
const pick = (zim, p) => vm.runInContext(`_facePathFor(${JSON.stringify(zim)}, ${JSON.stringify(p)})`, sandbox);

let failures = 0;
const check = (ok, label) => { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); };

dark = true;
check(pick('twofaced', 'A/index') === 'A/index~other', 'reading in dark opens the dark face');
dark = false;
check(pick('twofaced', 'A/index') === 'A/index', 'reading in light opens the light face');

dark = false;
check(pick('darkmain', 'A/index') === 'A/index~other', 'a dark-captured site opens its light face in light');
dark = true;
check(pick('darkmain', 'A/index') === 'A/index', 'and its own face in dark');

check(pick('plain', 'A/index') === 'A/index', 'a ZIM with one face is untouched');
check(pick('twofaced', 'A/somewhere/else') === 'A/somewhere/else', 'a deeper link is left exactly as asked');
check(pick('unknown', 'A/index') === 'A/index', 'an unknown ZIM is untouched');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all face checks passed');
