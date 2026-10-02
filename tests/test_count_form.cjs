// One form for a count, and nothing said twice.
//
// A 1.13 design review: "Recently added 1", "(1)" and "1" side by side;
// ZimiTube's "English Duniya English" (the title already names its language)
// and "All 1 ›" over a shelf that holds back nothing.
//
// Run: node tests/test_count_form.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const tube = fs.readFileSync(path.join(root, 'tube.html'), 'utf8');
let failures = 0;
function ok(name, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || detail === undefined ? '' : '  ' + detail));
  if (!cond) failures++;
}

// The Library's groups: the label, then the number, not "(n)".
ok('no group label counts in brackets', !/' \(' \+ (catZims|items)\.length \+ '\)'/.test(app));
const ctx = { esc: (s) => String(s) };
vm.createContext(ctx);
vm.runInContext(app.match(/function _countedLabelHtml\(label, n\) \{[\s\S]*?\n\}/)[0], ctx);
ok('a counted label is the label and a quiet number', ctx._countedLabelHtml('Maps', 3) === 'Maps <span class="label-n">3</span>');

// ZimiTube: a source's language only when its title does not already say it.
const t = { esc: (s) => String(s), STR: { langs: { eng: 'English', fra: 'French' } }, _zims: [{ language: 'eng' }, { language: 'fra' }] };
vm.createContext(t);
vm.runInContext(tube.match(/function langOf\(z\) \{[\s\S]*?\n\}/)[0], t);
ok('"English Duniya" is not followed by English', t.langOf({ title: 'English Duniya', language: 'eng' }) === '');
ok('"TED" is (two languages among the sources)', /English/.test(t.langOf({ title: 'TED', language: 'eng' })));
ok('"Englishness" is not "English"', /English/.test(t.langOf({ title: 'Englishness talks', language: 'eng' })));
t._zims = [{ language: 'eng' }];
ok('one language among the sources: none named', t.langOf({ title: 'TED', language: 'eng' }) === '');

// All only when the shelf holds back some.
ok('a shelf offers All only past what it shows', /\(z\.count > mine\.length \? '<button class="all"/.test(tube));

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
