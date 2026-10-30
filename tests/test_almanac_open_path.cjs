// The Almanac's open path and the drag into 3D (Eric, 2026-10-30: "tapping almanac app opens so slow feels
// broken. And drag hero moon to enter 3D doesn't work or is also slow?"): the panels under the calendar are drawn
// after the first paint, a lift asked for before the 3D file is in is kept, and every map is uploaded before the swap.
//
// Run: node tests/test_almanac_open_path.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', f), 'utf8').replace(/\r\n/g, '\n');
const alm = read('almanac.js'), earth = read('almanac-earth.js');
const fn = (src, name) => {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('could not extract ' + name);
  return m[0];
};
let failures = 0;
const check = (ok, label) => { if (ok) console.log('ok: ' + label); else { console.error('FAIL: ' + label); failures++; } };

// _almAfterPaint: a frame, then a task; nothing when the Almanac closed or was drawn again meanwhile.
{
  const frames = [], tasks = [], ran = [];
  const sb = { requestAnimationFrame: f => frames.push(f), setTimeout: f => tasks.push(f), _almanacOpen: true, _almAfterPaintToken: 0 };
  vm.createContext(sb);
  vm.runInContext(fn(alm, '_almAfterPaint'), sb);
  sb._almAfterPaint(() => ran.push('a'));
  check(ran.length === 0 && frames.length === 1, 'the panels do not run in the call that drew the page');
  frames.shift()(); check(ran.length === 0 && tasks.length === 1, '...nor in the frame: a task after it');
  tasks.shift()(); check(ran.join() === 'a', '...they run in that task');
  sb._almAfterPaint(() => ran.push('b')); sb._almAfterPaint(() => ran.push('c'));
  frames.shift()(); frames.shift()(); tasks.shift()(); tasks.shift()();
  check(ran.join() === 'a,c', 'drawn again before they ran: only the newer draw counts');
  sb._almAfterPaint(() => ran.push('d')); frames.shift()(); sb._almanacOpen = false; tasks.shift()();
  check(ran.join() === 'a,c', 'closed before they ran: skipped');
}
check(/anchor\) panels\(\);\s*\n\s*else _almAfterPaint\(panels\)/.test(alm), 'a page drawn over itself (its reader keeps a place) is drawn whole at once');

// _almMoonLift: kept until the 3D view's file is in.
{
  const calls = [], timers = [];
  const sb = { window: {}, _almanacOpen: true, ALM_LIFT_WAIT_MS: 100, ALM_LIFT_WAIT_TRIES: 100,
    setInterval: f => { timers.push(f); return timers.length; }, clearInterval: n => { timers[n - 1] = null; } };
  sb.window.openAlmanacEarth = undefined;
  vm.createContext(sb);
  vm.runInContext(fn(alm, '_almMoonLift'), sb);
  sb._almMoonLift();
  check(calls.length === 0 && timers.length === 1, 'a lift before the 3D file is in waits for it');
  timers[0](); check(calls.length === 0, '...and keeps waiting');
  sb.window.openAlmanacEarth = o => calls.push(o.target + ':' + o.fromHero);
  timers[0]();
  check(calls.join() === 'moon:true', '...lifts the Moon the moment it is in');
  sb._almMoonLift();
  check(calls.length === 2 && timers.length === 1, 'with the file in, a lift is at once');
}

// _aeUploadMaps: the maps the warm render did not reach go up now.
{
  const up = [];
  const mk = n => ({ value: n });
  const S = { renderer: { initTexture: t => up.push(t) }, earthUni: { dayMap: mk('day'), nightMap: mk('night') }, moonUni: { moonMap: mk('moon') } };
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(fn(earth, '_aeUploadMaps'), sb);
  sb._aeUploadMaps(S);
  check(up.join() === 'day,night,moon', 'the day, night and Moon maps are uploaded before the swap');
  S.moonUni.moonMap.value = null; up.length = 0; sb._aeUploadMaps(S);
  check(up.join() === 'day,night', 'a map not in yet is skipped');
  check(/_aeUploadMaps\(S\);\s*\n\}/.test(earth.slice(earth.indexOf('function _aeWarm'))), '_aeWarm ends by uploading them');
}

if (failures) { console.error('\n' + failures + ' failed'); process.exit(1); }
console.log('\nall open-path checks passed');
