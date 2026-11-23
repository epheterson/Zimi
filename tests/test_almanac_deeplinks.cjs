// The Almanac's deep links, their pure parts executed from the shipped source: what the address says is read back the way it was
// written (a drive, a visit, Stand here, a mission), and junk in it is ignored rather than half-applied.
//
// Run: node tests/test_almanac_deeplinks.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', f), 'utf8');
let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}
function extractVar(src, name) {
  const at = src.indexOf('var ' + name + ' =');
  if (at < 0) throw new Error('var ' + name + ' not found');
  return src.slice(at, src.indexOf(';\n', at) + 2);
}

const fly = read('almanac-fly.js'), alm = read('almanac.js'), earth = read('almanac-earth.js'), sites = read('almanac-sites.js'), stand = read('almanac-stand.js'), missions = read('almanac-missions.js');
const S = { Math, Number, String, Object, JSON, URLSearchParams, isFinite, encodeURIComponent, console };
vm.createContext(S);
const run = (c) => vm.runInContext(c, S);
for (const f of ['_almLinkNums', '_almLinkParse']) run(extractFn(alm, f));
for (const f of ['_aeLinkSelWrite']) run(extractFn(earth, f));
run(extractVar(earth, 'AE_LINK_SEL_RE'));
run('var AE_LINK_ID_RE = /^[a-z0-9_]{1,32}$/; var AE_DRIVE_BODIES = ["earth", "moon", "mars"]; var AM_LINK_PACE = 1;');
run('function _aeDeg(r) { return r * 180 / Math.PI; } function _aeRad(d) { return d * Math.PI / 180; }');
for (const f of ['_asLinkNum', '_asLinkWrite', '_asValidSpot']) run(extractFn(sites, f));
run('var _ae = {}; var _aeLinkModes = {}; var _aeLinkModePending = null;');
run(extractFn(earth, '_aeLinkModeNow'));

// -- Reading the address ---------------------------------------------------------------------------------------------------------
const L = run("_almLinkParse('#almanac?t=1900000000&v=moon&m=drive&k=1.5,2.5,3,4,-90,1,11&x=' + encodeURIComponent('lm:moon:Apollo 15'))");
check(L.m === 'drive' && L.k === '1.5,2.5,3,4,-90,1,11' && L.v === 'moon', 'a mode and its values are read');
check(L.x === 'lm:moon:Apollo 15', 'a selection is read decoded');
const J = run("_almLinkParse('#almanac?m=%00%20&k=a,b&x=')");
check(J.k === 'a,b' && run("_almLinkNums('a,b', 2)") === null, 'values that are not numbers are none');
check(run("_almLinkNums('1,2', 3)") === null && run("_almLinkNums('1,2,,', 3)") === null && run("_almLinkNums('1,Infinity,3', 3)") === null, 'too few, empty or infinite values are none');
check(run("_almLinkNums('1,2,3', 3)").join() === '1,2,3', 'exactly n numbers are read');
const E = run("_almLinkParse('#almanac')");
check(E.m === '' && E.k === '' && E.x === '', 'a plain address says no mode and no selection');

// -- Writing and reading back ---------------------------------------------------------------------------------------------------
run(`_ae.site = { row: ['Apollo 15', 26.1322, 3.6339, 'landing'], drive: true, seat: true, camera: { az: 1, el: 0.3, dist: 14.5 },
  rover: { x: 12.345, y: -6.789, hdg: Math.PI / 2 } };`);
const d = run('_asLinkWrite()').split(',').map(Number);
check(d.length === 7 && d[0] === 26.1322 && d[1] === 3.6339, 'a drive writes the row, then the rover');
check(Math.abs(d[2] - 12.35) < 0.01 && Math.abs(d[3] + 6.79) < 0.01 && Math.abs(d[4] - 90) < 0.1 && d[5] === 1 && d[6] === 14.5, 'the rover place, heading, seat and chase distance round-trip');
run('_ae.site.rover.hdg = _aeRad(-179.96)');
check(run('_asLinkWrite()').split(',')[4] === '-180', 'a heading is written in -180..180');
run(`_ae.site.drive = false; _ae.site.rover = null;`);
const v = run('_asLinkWrite()').split(',').map(Number);
check(v.length === 5 && Math.abs(v[2] - 57.3) < 0.1 && Math.abs(v[3] - 17.2) < 0.1 && v[4] === 14.5, 'a visit writes the row and the orbit camera');
run('_ae.site.drive = true; _ae.site.rover = null; _ae.site.linked = null');
check(run('_asLinkWrite()') === null, 'a drive whose rover is not yet built says nothing');
check(run('_asValidSpot(95, 0)') === false && run('_asValidSpot(-30, 200)') === true, 'a latitude beyond the pole is no spot');

// -- What a mode says while its link is being opened ----------------------------------------------------------------------------
run('_ae.site = null; _aeLinkModePending = { m: "mission", k: "apollo11,10,0,1" };');
check(run('_aeLinkModeNow()').join('|') === 'mission|apollo11,10,0,1', 'while a link opens its mode, the address keeps the link\'s own values');
run('_aeLinkModePending = null;');
check(run('_aeLinkModeNow()') === null, 'no mode, no m');

// -- Junk is ignored, not half-applied -----------------------------------------------------------------------------------------
run('var enterFly = function () { calls.push("fly"); }, _aeLinkWait = function () {}; var _aeStandable = function (k) { return k === "moon"; }, _aeStandAt = function () { return { then: function () {} }; }, _aeMissionStart = function () { calls.push("mission"); }, _aeWhenSites = function () { calls.push("sites"); }; var calls = [];');
run(extractFn(earth, '_aeLinkModeDone')); run(extractFn(earth, '_aeLinkModeOpen'));
const open = (m, k, vb) => { run('calls.length = 0; _aeLinkModePending = null'); return run(`_aeLinkModeOpen({ m: ${JSON.stringify(m)}, k: ${JSON.stringify(k)}, v: ${JSON.stringify(vb)} })`); };
check(open('drive', '1,2,3,4,5,1,9', 'moon') === true && run('calls.join()') === 'sites', 'a good drive link is taken');
check(open('drive', '1,2,3,4,5,1', 'moon') === false && open('drive', 'x,2,3,4,5,1,9', 'moon') === false, 'a drive with too few or non-numeric values is left alone');
check(open('drive', '1,2,3,4,5,1,9', 'jupiter') === false, 'a drive on a body with no ground is left alone');
check(open('site', '1,2,3,4,5', 'mars') === true && open('site', '1,2,3,4', 'mars') === false, 'a visit takes exactly five values');
check(open('stand', '1,2,3,4,1', 'moon') === true && open('stand', '95,2,3,4,1', 'moon') === false && open('stand', '1,2,3,4,1', 'mars') === false, 'Stand here needs a place on a body that has a ground');
check(open('mission', 'apollo11,-30.5,1,1', 'earth') === true && run('calls.join()') === 'mission', 'a mission link is taken');
check(open('mission', 'apollo11,-30.5,1', 'earth') === false && open('mission', 'Apollo 11,1,0,1', 'earth') === false && open('mission', 'plan,1,0,1', 'earth') === false && open('mission', 'apollo11,1,0,9', 'earth') === false, 'a mission link with a bad id, T+ or speed is left alone');
check(open('fly', '1,2,3,0,0,1,0', 'earth') === true && open('fly', '1,2,3,0,0,1,2', 'earth') === false && open('fly', '1,2,3,0,0,1', 'earth') === false, 'a ship link needs seven numbers and a cockpit flag of 0 or 1');
check(open('warp', '1', 'moon') === false && open('', '', 'moon') === false, 'a mode this build does not know is no mode');

// -- The selection ----------------------------------------------------------------------------------------------------------------
check(run("AE_LINK_SEL_RE.test('lm:moon:Apollo 15') && AE_LINK_SEL_RE.test('sent:voyager1') && AE_LINK_SEL_RE.test('sat:25544')"), 'a landmark, a Sent row and a satellite are selectable');
check(!run("AE_LINK_SEL_RE.test('') || AE_LINK_SEL_RE.test('xx:1') || AE_LINK_SEL_RE.test('lm:' + 'a'.repeat(200))"), 'an empty, unknown or oversize selection is not');
run('_ae.lm = { body: "moon", row: ["Apollo 15", 26, 3, "landing"] }; _ae.sent = null; _ae.selected = null; function _aeSelectedSat() { return null; }');
check(run('_aeLinkSelWrite()') === 'lm:moon:Apollo 15', 'a landmark card is written with its body and name');
run('_ae.lm = null; _ae.sent = { o: { id: "voyager1" } };');
check(run('_aeLinkSelWrite()') === 'sent:voyager1', 'a Sent row is written by its id');
run('_ae.sent = null; function _aeSelectedSat() { return { omm: { NORAD_CAT_ID: 25544 } }; }');
check(run('_aeLinkSelWrite()') === 'sat:25544', 'a satellite is written by its NORAD id');

// The other files' writers are in place and key on the same modes.
check(/_aeLinkModes\.stand = function/.test(stand) && /_aeLinkModes\.mission = function/.test(missions) && /_aeLinkModes\.drive = function/.test(sites) && /_aeLinkModes\.site = function/.test(sites) && /_aeLinkModes\.fly = function/.test(fly), 'every mode has its writer');

process.exit(failures ? 1 : 0);
