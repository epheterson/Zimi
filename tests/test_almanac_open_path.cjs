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

// _almAfterPaint: every panel is a job for the quiet queue (app.js whenQuiet); nothing runs in the call that drew
// the page, and nothing when the Almanac closed or was drawn again meanwhile.
{
  const jobs = [], ran = [];
  const sb = { whenQuiet: (f, o) => jobs.push({ f, o }), QUIET_PRI_PANELS: 2, ALM_PANEL_MAX_WAIT_MS: 900, _almanacOpen: true, _almAfterPaintToken: 0 };
  vm.createContext(sb);
  vm.runInContext(fn(alm, '_almAfterPaint'), sb);
  sb._almAfterPaint([() => ran.push('a1'), () => ran.push('a2')]);
  check(ran.length === 0 && jobs.length === 2, 'the panels do not run in the call that drew the page: one quiet job each');
  check(jobs[0].o.key !== jobs[1].o.key && jobs.every(j => j.o.priority === 2), '...each its own key, ahead of the loads');
  jobs.shift().f(); jobs.shift().f(); check(ran.join() === 'a1,a2', '...and they run when the queue gets to them');
  sb._almAfterPaint([() => ran.push('b')]); sb._almAfterPaint([() => ran.push('c')]);
  jobs.shift().f(); jobs.shift().f();
  check(ran.join() === 'a1,a2,c', 'drawn again before they ran: only the newer draw counts');
  sb._almAfterPaint([() => ran.push('d')]); sb._almanacOpen = false; jobs.shift().f();
  check(ran.join() === 'a1,a2,c', 'closed before they ran: skipped');
}
check(/if \(anchor\) \{ \+\+_almAfterPaintToken; panels\.forEach\(function \(p\) \{ p\(\); \}\); \}\s*\n\s*else _almAfterPaint\(panels\)/.test(alm), 'a page drawn over itself (its reader keeps a place) is drawn whole at once, and the older draw\'s queued panels are called off');
check(/scroller\.scrollTop = 0;\s*\n\s*_renderAlmanacContent\(\);/.test(alm), 'a fresh open is at the top before it draws, so it is not taken for a redraw in place');

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

// _aeWarmSliced: the scene, the shaders, a first render and every map that is in go up before the view swaps in, and
// a view opening meanwhile does not cut it short (it is what the warming is for).
{
  const run = async (opening, first) => {
    const did = [];
    const mk = n => ({ value: n });
    const S = { scene: {}, camera: {}, renderer: { compile: () => did.push('compile'), render: () => did.push('render'), initTexture: t => did.push(t) },
      earthUni: { dayMap: mk('day'), nightMap: mk('night') }, moonUni: { moonMap: mk(null) } };
    const sb = { _ae: { gl: S }, _aeIsOpen: opening, _aeBreath: () => Promise.resolve(), _aeSceneAt: () => ({ ms: 0 }), _aeDisplayMs: () => 0,
      _aeUpdate: () => did.push('update') };
    vm.createContext(sb);
    vm.runInContext(fn(earth, '_aeWarmSliced'), sb);
    const ok = await sb._aeWarmSliced(S, first);
    return { ok, did: did.join(), ready: sb._ae.ready };
  };
  (async () => {
    for (const opening of [false, true]) {
      const r = await run(opening, true);
      check(r.ok && r.ready && r.did === 'update,compile,render,day,night', (opening ? 'the view opening meanwhile: ' : '') +
        'scene, shaders, a first render, then each map that is in, before it is ready (' + r.did + ')');
    }
    const late = await run(true, false);
    check(late.did === '', 'a later warm-up (a sharper map landing) does nothing on a view already open, which draws it anyway (' + late.did + ')');
    if (failures) { console.error('\n' + failures + ' failed'); process.exit(1); }
    console.log('\nall open-path checks passed');
  })();
}
