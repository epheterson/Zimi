// app.js whenQuiet: background work runs one job to a task, only when no finger is down and nothing has touched,
// scrolled or typed for QUIET_MS (Safari has no requestIdleCallback; the 1 ms stand-in put seconds of GPU setup on
// the main thread the moment a finger arrived: Eric, 2026-10-30).
//
// Run: node tests/test_quiet_work.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
const block = src.slice(src.indexOf('// ── Quiet work ──'), src.indexOf('// The 4096 map, asked for once'));
let failures = 0;
const check = (ok, label) => { if (ok) console.log('ok: ' + label); else { console.error('FAIL: ' + label); failures++; } };

let now = 1000, timers = [], listeners = {};
const sb = {
  performance: { now: () => now },
  window: { addEventListener: (n, f) => { listeners[n] = f; } },
  setTimeout: (f, ms) => { timers.push({ f, at: now + ms }); return timers.length; },
  requestAnimationFrame: f => f(),
  Promise,
};
vm.createContext(sb);
vm.runInContext(block, sb);
const run = c => vm.runInContext(c, sb);
// Advance the clock, firing due timers (and the promises they start) in order.
const advance = async ms => {
  const end = now + ms;
  for (let i = 0; i < 5; i++) await Promise.resolve();
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    if (!timers.length || timers[0].at > end) break;
    const t = timers.shift(); now = Math.max(now, t.at); t.f();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  now = end;
};

(async () => {
  const log = [], at = [];
  const QUIET = run('QUIET_MS'), GAP = run('QUIET_GAP_MS');
  sb.log = log; sb.stamp = () => at.push(now);
  run("whenQuiet(function () { log.push('b'); stamp(); }, { priority: 5, maxWaitMs: 1e9 }); whenQuiet(function () { log.push('a'); stamp(); }, { priority: 2, maxWaitMs: 1e9 });");
  await advance(GAP - 1); check(log.length === 0, 'nothing runs in the task that asked');
  listeners.touchstart();                      // a finger lands
  const down = now;
  await advance(5000); check(log.length === 0, 'a finger that is down holds every job, however long they wait');
  listeners.touchend();
  const up = now;
  await advance(QUIET - 10); check(log.length === 0, 'just lifted: still not quiet');
  await advance(1000);
  check(log.join() === 'a,b', 'quiet: the lower priority number runs first');
  check(at[0] - up >= QUIET && at[1] - at[0] >= GAP, '...after QUIET_MS of no touch, and the next one a gap later, in a task of its own');

  // A scroll keeps the queue waiting; a job overdue and with the finger up runs anyway.
  log.length = 0;
  run("whenQuiet(function () { log.push('late'); }, { key: 'k', maxWaitMs: 800 });");
  for (let i = 0; i < 6; i++) { listeners.scroll(); await advance(200); }
  check(log.join() === 'late', 'a job that has waited past its maxWaitMs runs although the page keeps scrolling');

  // A job returning a promise holds the queue until it settles.
  log.length = 0;
  run("var release; whenQuiet(function () { log.push('slow'); return new Promise(function (r) { release = r; }); }, { maxWaitMs: 1e9 }); whenQuiet(function () { log.push('next'); }, { maxWaitMs: 1e9 });");
  await advance(2000); check(log.join() === 'slow', 'a job that returns a promise holds the queue');
  run('release()'); await advance(2000); check(log.join() === 'slow,next', '...until it settles');

  // quietNow runs a queued job at once (the person's intent) and cancel drops one.
  log.length = 0;
  run("whenQuiet(function () { log.push('x'); }, { key: 'x', maxWaitMs: 1e9 }); whenQuiet(function () { log.push('y'); }, { key: 'y', maxWaitMs: 1e9 });");
  check(run("quietNow('x')") === true, 'quietNow finds the queued job');
  await Promise.resolve(); await Promise.resolve();
  check(log.join() === 'x', '...and runs it now');
  run("quietCancel('y')"); await advance(3000); check(log.join() === 'x', 'a cancelled job never runs');
  check(run("quietNow('x')") === false, 'quietNow says false for a job that is not queued');

  // quietBreath: a frame, then quiet.
  log.length = 0; listeners.scroll();
  run("quietBreath().then(function () { log.push('breath'); });");
  await advance(10); check(log.length === 0, 'a breath waits for no touch in QUIET_BREATH_MS');
  await advance(run('QUIET_BREATH_MS') + 100); check(log.join() === 'breath', '...then lets the slice go on');
  listeners.touchstart(); log.length = 0;
  run("quietBreath().then(function () { log.push('breath2'); });");
  await advance(5000); check(log.length === 0, 'a finger down holds a breath for as long as it is down');
  listeners.touchend(); await advance(run('QUIET_BREATH_MS') + 100); check(log.join() === 'breath2', '...and lets it go once it is up');

  if (failures) { console.error('\n' + failures + ' failed'); process.exit(1); }
  console.log('\nall quiet-work checks passed');
})();
