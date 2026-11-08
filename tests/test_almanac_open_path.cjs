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

// _almAfterPaint: the panels wait until the page has been shown a while (a hand on the page, a scroll, ends the wait),
// then every panel is a job for the quiet queue (app.js whenQuiet); nothing runs in the call that drew the page, and
// nothing when the Almanac closed or was drawn again meanwhile.
{
  const jobs = [], ran = [], shown = [], timers = [], listeners = {};
  const sc = { addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener: n => { delete listeners[n]; } };
  const sb = { whenQuiet: (f, o) => jobs.push({ f, o }), QUIET_PRI_PANELS: 2, ALM_PANEL_MAX_WAIT_MS: 900, ALM_PANELS_SETTLE_MS: 3200,
    _almanacOpen: true, _almAfterPaintToken: 0, document: { getElementById: () => sc }, _almShownAt: 1, performance: { now: () => 1 },
    _almWhenShown: f => shown.push(f), setTimeout: f => { timers.push(f); return timers.length; }, clearTimeout: () => {} };
  vm.createContext(sb);
  vm.runInContext(fn(alm, '_almWhenSettled') + fn(alm, '_almAfterPaint'), sb);
  sb._almAfterPaint([() => ran.push('a1'), () => ran.push('a2')]);
  check(ran.length === 0 && jobs.length === 0 && shown.length === 1, 'the panels do not run in the call that drew the page, nor before the page is shown');
  shown.shift()(); check(jobs.length === 0 && timers.length === 1, '...once it is shown they still wait out the settle window');
  timers.shift()();
  check(ran.length === 0 && jobs.length === 2, '...then each is a quiet job');
  check(jobs[0].o.key !== jobs[1].o.key && jobs.every(j => j.o.priority === 2), '...each its own key, ahead of the loads');
  jobs.shift().f(); jobs.shift().f(); check(ran.join() === 'a1,a2', '...and they run when the queue gets to them');
  sb._almShownAt = 0; sb._almAfterPaint([() => ran.push('p')]); shown.shift()();
  check(jobs.length === 1 && timers.length === 0, 'a page drawn when no page was just shown (a language changed) starts its panels at once');
  jobs.shift().f(); ran.pop(); sb._almShownAt = 1;
  sb._almAfterPaint([() => ran.push('s')]); shown.shift()();
  check(typeof listeners.scroll === 'function', 'a page being shown waits for a scroll too');
  listeners.scroll(); timers.shift()();
  check(jobs.length === 1, '...a hand on the page starts the panels at once, and only once');
  jobs.shift().f();
  sb._almAfterPaint([() => ran.push('b')]); shown.shift()(); sb._almAfterPaint([() => ran.push('c')]); shown.shift()();
  timers.shift()(); timers.shift()();
  check(jobs.length === 1, 'drawn again before they started: the older draw\'s wait ends with nothing');
  jobs.shift().f();
  check(ran.join() === 'a1,a2,s,c', 'drawn again before they ran: only the newer draw counts');
  sb._almAfterPaint([() => ran.push('d')]); shown.shift()(); sb._almanacOpen = false; timers.shift()();
  check(jobs.length === 0, 'closed before they ran: skipped');
}
check(/if \(anchor\) \{ \+\+_almAfterPaintToken; panels\.forEach\(function \(p\) \{ p\(\); \}\); \}\s*\n\s*else _almAfterPaint\(panels\)/.test(alm), 'a page drawn over itself (its reader keeps a place) is drawn whole at once, and the older draw\'s queued panels are called off');
check(/if \(scroller && !_almReturning\) scroller\.scrollTop = 0;[\s\S]*?_moonTexThen\(drawOnce\)/.test(alm), 'a fresh open is at the top before it draws, so it is not taken for a redraw in place');
check(/_almVeilBegin\(\)[\s\S]*?_renderAlmanacContent\(\)/.test(alm), 'a fresh open is veiled before its page is drawn');
check(!/_loadSunData\(at\(\)\)/.test(alm) && /_almSafePanel\(function \(\) \{ _loadSunData\(_almFocus \|\| now\); \}, null\);/.test(alm), 'the live sky starts with the first frame, not as a late panel');

// The veil (almanac.js _almVeilBegin/_almReveal): the page is shown once, when the sky says its first picture is on the
// canvas (or at the cap), and what waits for "shown" runs then, not before and not twice.
{
  const raf = [], shown = [], ran = [], skyKicks = [];
  const sb = { _almanacOpen: true, _almRevealing: true, _almSeaPending: true, _almRevealTimer: 0, _almShownAt: 0, _almShownJobs: [], _skyState: { settled: true },
    clearTimeout: () => {}, setTimeout: () => 1, performance: { now: () => 42 }, requestAnimationFrame: f => raf.push(f),
    _almVeilDown: () => shown.push('down'), _skyKickDirty: () => skyKicks.push(1), document: { fonts: null }, ALM_FONT_WAIT_MS: 1500 };
  vm.createContext(sb);
  vm.runInContext(fn(alm, '_almReveal') + fn(alm, '_almWhenShown') + fn(alm, '_almSkySettled'), sb);
  sb._almWhenShown(() => ran.push('a'));
  check(ran.length === 0, 'what waits for the page to be shown does not run while it is veiled');
  sb._almSkySettled();
  check(raf.length === 1 && shown.length === 0, 'the sky settling shows the page on the next frame, not in the call');
  raf.shift()();
  check(shown.join() === 'down' && ran.join() === 'a' && sb._almRevealing === false && sb._almShownAt === 42 && sb._almSeaPending === false,
    '...which lifts the veil, runs what waited, and stops waiting for the sea');
  check(skyKicks.length === 0, '...and does not repaint a sky that is already settled');
  sb._almSkySettled(); sb._almReveal();
  check(raf.length === 0 && shown.length === 1, 'a page already shown is not shown twice');
  sb._almWhenShown(() => ran.push('b'));
  check(ran.join() === 'a,b', 'and what asks after it is shown runs at once');
  sb._almRevealing = true; sb._skyState = { settled: false }; sb._almReveal();
  check(skyKicks.length === 1, 'a page shown at the cap with no picture yet has its sky painted as it can be, now');
}

// _almMoonLift: kept until the 3D view's file is in.
{
  const calls = [], timers = [], asked = [];
  const sb = { window: {}, _almanacOpen: true, ALM_LIFT_WAIT_MS: 100, ALM_LIFT_WAIT_TRIES: 100, _almLoadEarth: () => asked.push(1),
    setInterval: f => { timers.push(f); return timers.length; }, clearInterval: n => { timers[n - 1] = null; } };
  sb.window.openAlmanacEarth = undefined;
  vm.createContext(sb);
  vm.runInContext(fn(alm, '_almMoonLift'), sb);
  sb._almMoonLift();
  check(calls.length === 0 && timers.length === 1, 'a lift before the 3D file is in waits for it');
  check(asked.length === 1, '...and asks for the file, which no longer follows the page by itself');
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
