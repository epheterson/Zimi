// A year before 1 keeps its era in the almanac's dates.
//
// Intl omits the era unless asked, so the time machine at -270000 read
// "January 1, 270001", which looks like the far future. _almEraOpts asks for
// it only for such years, so an ordinary date gains no "AD".
//
// Run: node tests/test_almanac_era.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac.js'), 'utf8');
const start = src.indexOf('function _almEraOpts(');
let i = src.indexOf('{', start), d = 0;
for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; }
const S = { Object, Intl, Date };
vm.createContext(S);
vm.runInContext(src.slice(start, i + 1), S);
const opts = { month: 'long', day: 'numeric', year: 'numeric' };
const bc = new Date(0); bc.setFullYear(-270000, 0, 1);
const ad = new Date(0); ad.setFullYear(2026, 8, 22);
let failures = 0;
const check = (ok, label) => { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); };
check(/BC/.test(new Intl.DateTimeFormat('en', S._almEraOpts(bc, opts)).format(bc)), 'year -270000 reads BC');
check(!/AD|BC/.test(new Intl.DateTimeFormat('en', S._almEraOpts(ad, opts)).format(ad)), '2026 gains no era');
if (failures) process.exit(1);
