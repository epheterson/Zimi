// One job table, and the state is what decides which surface draws a row.
//
// The Create page used to keep two things: a "history" list of finished jobs,
// and a separate status object for the one that was running. The client built
// that split itself — the server has always put every job in one journal, with
// `_create_job_state` answering running/queued for a live one — and the client
// threw the live rows away as they arrived.
//
// The cost showed up as a blank page. Because the table could not say "a job
// was running when you last looked", it could not be remembered, so opening
// Create drew nothing at all until a round trip came back. On a NAS across a
// LAN that reads as "there is nothing here", which is the wrong answer when a
// capture is in progress. Eric, at the release gate: "The recently created and
// current running one don't show fast on create page load but should be
// instant." And the fix he asked for is a modelling fix, not a caching one:
// "Store the active job same as the history table and just different states."
//
// So this pins the model:
//
//   * the table holds every job, live ones included;
//   * a row's state decides where it is drawn, and the Recent list skips the
//     live ones at RENDER time rather than dropping them on arrival;
//   * the table is remembered, and a remembered running row can seed the run
//     pane's header — with identity only, never with invented progress;
//   * a running row is never mistaken for a failed one, which is the trap: the
//     old state fallback reads `ok`, and a job that has not finished has
//     ok:false for the plainest possible reason.
//
// Same vm-extraction approach as test_create_ui.cjs — the pure prefix of the
// shipped file, evaluated with a localStorage stub, so this drives the real
// code rather than a transcription of it.
//
// Run: node tests/test_create_job_table.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'zimi', 'static', 'create.js'), 'utf8');

const MARKER = '// ── the surface ──';
const cut = SRC.indexOf(MARKER);
if (cut < 0) throw new Error('the pure/DOM boundary marker moved — update this test');

// A localStorage the sandbox can actually use. create.js reads it defensively
// (there is none in this sandbox by default, and a ReferenceError inside its
// try is caught like any other), so without this stub every persistence test
// would trivially "pass" by writing nowhere.
function makeStore() {
  const data = new Map();
  return {
    writes: 0,
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { this.writes++; data.set(k, String(v)); },
    removeItem(k) { data.delete(k); },
    clear() { data.clear(); },
  };
}

function load() {
  const localStorage = makeStore();
  const sandbox = { localStorage, t: (k) => k };
  vm.createContext(sandbox);
  vm.runInContext(SRC.slice(0, cut), sandbox);
  return { sandbox, localStorage };
}

let failures = 0;
function check(ok, label) {
  if (ok) { console.log('ok: ' + label); return; }
  console.error('FAIL: ' + label);
  failures++;
}
function eq(got, want, label) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  check(same, label + (same ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
}

const RUNNING = { id: 'j3', mode: 'page', source: 'https://cnn.com/',
                  title: 'CNN', phase: 'fetch', state: 'running', ok: false };
const QUEUED  = { id: 'j4', mode: 'site', source: 'https://b.test/', state: 'queued', ok: false };
const DONE    = { id: 'j2', mode: 'page', source: 'https://a.test/', state: 'ok',
                  ok: true, result: 'a_test_2026-08.zim' };
const FAILED  = { id: 'j1', mode: 'page', source: 'https://c.test/', state: 'failed',
                  ok: false, error: 'no' };

// ── the model: every state is a row, and states are told apart ──────────────
{
  const { sandbox } = load();
  const { _createHistoryLive, _createHistoryState } = sandbox;

  check(_createHistoryLive(RUNNING), 'a running job is a live row');
  check(_createHistoryLive(QUEUED), 'a queued job is a live row');
  check(!_createHistoryLive(DONE), 'a finished job is not a live row');
  check(!_createHistoryLive(null), 'no row is not a live row');

  // THE TRAP. Before the live check moved to the front of _createHistoryState,
  // a running row fell through to `h.ok ? 'ok' : 'failed'` — and an unfinished
  // job has ok:false because it is unfinished. A capture that was running fine
  // would have been labelled "failed" the moment anything rendered it.
  eq(_createHistoryState(RUNNING), 'running', 'a running job reads as running, NOT failed');
  eq(_createHistoryState(QUEUED), 'queued', 'a queued job reads as queued');
  eq(_createHistoryState(DONE), 'ok', 'a finished job still reads as ok');
  eq(_createHistoryState(FAILED), 'failed', 'a failed job still reads as failed');

  // Every state the Recent list can draw has a sentence; the live ones are the
  // run pane's and the queue strip's business, and `queued` deliberately has
  // none here because its string wants a queue position a plain row lacks.
  const { CREATE_HISTORY_KEYS } = sandbox;
  for (const s of ['ok', 'failed', 'cancelled', 'stalled', 'interrupted', 'running']) {
    check(!!CREATE_HISTORY_KEYS[s], `state ${s} has a sentence`);
  }
}

// ── remembering the table ───────────────────────────────────────────────────
{
  const { sandbox, localStorage } = load();
  const { _createJobsSave, _createJobsLoad, CREATE_JOBS_KEY } = sandbox;

  eq(_createJobsLoad(), [], 'a browser that has never been told remembers nothing');

  const table = [RUNNING, DONE, FAILED];
  _createJobsSave(table);
  eq(_createJobsLoad(), table, 'the whole table round-trips, live rows included');
  check(localStorage.getItem(CREATE_JOBS_KEY) !== null, 'it is written under its own key');

  // A running job polls every two seconds. Writing on every identical poll
  // would put a synchronous disk write on that tick for the whole capture.
  const before = localStorage.writes;
  _createJobsSave(table);
  _createJobsSave(table);
  eq(localStorage.writes - before, 0, 'an unchanged table is not rewritten');
  _createJobsSave([DONE]);
  check(localStorage.writes > before, 'a changed table is written');
}

{
  const { sandbox, localStorage } = load();
  const { _createJobsLoad, CREATE_JOBS_KEY } = sandbox;
  // Junk in the cache is no cache, never a crash — this is the one piece of
  // state on the page that another program could have written.
  for (const junk of ['{', 'null', '[]', '{"jobs":"nope"}', '{"v":1}']) {
    localStorage.setItem(CREATE_JOBS_KEY, junk);
    eq(_createJobsLoad(), [], `unreadable cache (${junk}) is simply no cache`);
  }
}

// ── the first frame ─────────────────────────────────────────────────────────
{
  const { sandbox } = load();
  const { _createLiveRow } = sandbox;
  eq(_createLiveRow([DONE, RUNNING, FAILED]), RUNNING, 'the live row is found among finished ones');
  eq(_createLiveRow([DONE, FAILED]), null, 'a table of finished jobs has no live row');
  eq(_createLiveRow([]), null, 'an empty table has no live row');
  // Queued is live but is the QUEUE strip's row, not the run pane's: seeding a
  // progress pane for a job that has not started would show a capture that is
  // not happening.
  eq(_createLiveRow([QUEUED]), null, 'a queued job does not seed the run pane');
}

{
  const { sandbox } = load();
  const status = sandbox._createRowAsStatus(RUNNING);
  eq(status.id, 'j3', 'the seeded status carries the job identity');
  eq([status.mode, status.source, status.title], ['page', 'https://cnn.com/', 'CNN'],
     'and everything the run header draws');
  check(status.active === true, 'it presents as active, so the run pane draws it');
  check(status.fromCache === true, 'and admits where it came from');
  // The honesty constraint. A remembered percentage or entry count would be
  // indistinguishable from a measured one, and wrong the moment it was drawn.
  for (const invented of ['counts', 'pages', 'assets', 'bytes', 'entries', 'percent', 'events']) {
    check(!(invented in status), `it invents no ${invented}`);
  }
}

// ── hydrate: the whole first frame, end to end ──────────────────────────────
{
  const { sandbox } = load();
  sandbox._createJobsSave([RUNNING, DONE, FAILED]);

  const fresh = load();          // a new tab: nothing in memory, the cache on disk
  fresh.localStorage.setItem(sandbox.CREATE_JOBS_KEY,
    sandbox.localStorage.getItem(sandbox.CREATE_JOBS_KEY));
  fresh.sandbox._createHydrate();

  eq(fresh.sandbox._createHistory.length, 3, 'the table is on screen before anything is asked for');
  check(!!fresh.sandbox._createStatus, 'and the running job seeds the run pane');
  eq(fresh.sandbox._createStatus.id, 'j3', 'with the right job');
  eq(fresh.sandbox._createJobId, 'j3', 'which the page then treats as its own');
  check(fresh.sandbox._createAdopted === true, 'adopted, so the run pane renders it');
  // _createSawActive is "this tab watched a job run", and it is what turns a
  // job's disappearance into "interrupted by a server restart". A remembered
  // row was not watched by this tab, so a server with no job must open on the
  // picker rather than accuse itself of having crashed.
  check(!fresh.sandbox._createSawActive, 'a remembered row is not something this tab watched');
}

{
  const { sandbox } = load();
  sandbox._createJobsSave([DONE, FAILED]);
  const fresh = load();
  fresh.localStorage.setItem(sandbox.CREATE_JOBS_KEY,
    sandbox.localStorage.getItem(sandbox.CREATE_JOBS_KEY));
  fresh.sandbox._createHydrate();
  eq(fresh.sandbox._createHistory.length, 2, 'a table of finished jobs still paints Recent');
  check(fresh.sandbox._createStatus === null, 'and opens on the picker, with no run pane');
}

{
  // A live session outranks the cache: reopening Create mid-capture must not
  // overwrite what the polls have built with what the disk remembers.
  const { sandbox } = load();
  sandbox._createJobsSave([DONE]);
  sandbox._createHistory = [FAILED];
  sandbox._createHydrate();
  eq(sandbox._createHistory, [FAILED], 'hydrate defers to a table already in memory');
}

// ── the poll is the authority ───────────────────────────────────────────────
{
  const { sandbox } = load();
  const { _createAdoptHistory, _createJobsLoad, CREATE_JOBS_MAX } = sandbox;

  sandbox._createHistory = [RUNNING, DONE];
  // The server's answer replaces the table wholesale — which is how a job that
  // finished while the tab was shut comes back as a finished row rather than
  // lingering as the running one this browser remembered.
  _createAdoptHistory([{ ...RUNNING, state: 'ok', ok: true }, DONE]);
  eq(sandbox._createHistory.length, 2, 'the reply replaces the table');
  eq(sandbox._createHistory[0].state, 'ok', 'and a job that finished is finished');
  eq(_createJobsLoad()[0].state, 'ok', 'the new table is what gets remembered');

  // Live rows survive adoption now. That is the whole point: dropping them
  // here is what made the table not worth remembering.
  _createAdoptHistory([RUNNING, DONE]);
  check(sandbox._createHistory.some(h => h.state === 'running'),
    'a running row is KEPT in the table, not dropped on arrival');
  eq(_createJobsLoad().length, 2, 'and is remembered with the rest');

  // Bounded, so a long-lived browser cannot grow this without limit — and
  // bounded ABOVE what Recent shows, so the live rows the list skips cannot
  // push finished ones off the end of what is remembered.
  check(CREATE_JOBS_MAX > sandbox.CREATE_RECENT_MAX,
    'the table remembers more rows than the list draws');
  _createAdoptHistory(Array.from({ length: 100 }, (_, i) => ({ ...DONE, id: 'x' + i })));
  eq(sandbox._createHistory.length, CREATE_JOBS_MAX, 'the table is capped');
}

console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`);
process.exit(failures ? 1 : 0);
