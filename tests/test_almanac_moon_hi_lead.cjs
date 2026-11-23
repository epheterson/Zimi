// The Moon's 4096 map is asked for ahead of where the 1024 one runs out (and when a flight to the Moon is on), so it is in before it shows.
// Run: node tests/test_almanac_moon_hi_lead.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(ok, label) { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); }
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-earth.js'), 'utf8');
function fn(name) {
  const a = src.indexOf('\nfunction ' + name + '(') + 1;
  if (a <= 0) throw new Error(name);
  let i = src.indexOf('{', a), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(a, i + 1); }
  throw new Error(name);
}
const lead = /var AE_MOON_HI_LEAD = (\d+);/.exec(src);
function asked(px, ae) {
  const C = { asks: 0, disc: px, AE_MOON_LO_MAP_W: 1024, AE_MOON_HI_LEAD: lead ? +lead[1] : 1, AE_TEX_MOON_HI: 'hi', AE_THREE_RED_FORMAT: 1,
    _ae: Object.assign({ ready: true, target: 'earth' }, ae), _aeIsOpen: true, _aeMoonDiscPx() { return C.disc; },
    _aeLoadMap() { C.asks++; }, _aeSharedHiMoon() {} };
  vm.createContext(C);
  vm.runInContext(fn('_aeMoonHiWanted'), C);
  C.go = () => vm.runInContext('_aeMoonHiWanted({ moonHiAsked: false, moonUni: { moonMapped: { value: 1 }, moonMap: {} } })', C);
  C.go();
  return C.asks === 1;
}
check(asked(100), 'a Moon disc 100 px wide (the small map still serves) already asks for the big map');
check(!asked(10), 'a speck does not');
check(asked(10, { orbitFly: { to: 'moon', endAt: null } }), 'a flight to the Moon asks for it from the start');
check(!asked(10, { orbitFly: { to: 'mars', endAt: null } }), 'a flight elsewhere does not');
process.exit(failures ? 1 : 0);
