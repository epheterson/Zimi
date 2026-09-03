// Three judgements the Create page makes about what a number or a row MEANS.
//
// Every one of them was wrong in a way the test suite could not see, and every
// one was found by a person looking at the screen — driving the real flow in a
// browser, on a real NAS, after deleting every ZIM we had made:
//
//   * the done card said 29.6 MB directly above a composition bar saying 29.9
//     MB for the same file (6 MB apart on a site capture). Both true, neither
//     labelled: the card was showing bytes CARRIED, the bar the file on disk.
//
//   * a whole-site crawl's counters went BACKWARDS — 192 assets / 32.3 MB, then
//     146 / 9.2 MB — because the server reports them per page and starts over
//     at each one, right next to a pages counter that only climbs.
//
//   * Recent listed nine rows reading "Added to the library", each with a live
//     Open button, for ZIMs that had been deleted. A row only admitted the
//     truth once somebody personally clicked it and hit the dead end.
//
// They live above create.js's pure/DOM boundary so they can be driven here
// rather than transcribed. Same vm extraction as the other create tests.
//
// Run: node tests/test_create_numbers_and_rows.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'zimi', 'static', 'create.js'), 'utf8');
const MARKER = '// ── the surface ──';
const cut = SRC.indexOf(MARKER);
if (cut < 0) throw new Error('the pure/DOM boundary marker moved — update this test');

const sandbox = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
                  t: (k) => k };
vm.createContext(sandbox);
vm.runInContext(SRC.slice(0, cut), sandbox);
const { _createDoneBytes, _createMetricLive, _createRowGone, _createStoppedText, _createChipTarget } = sandbox;

let failures = 0;
function check(ok, label) {
  if (ok) { console.log('ok: ' + label); return; }
  console.error('FAIL: ' + label);
  failures++;
}
function eq(got, want, label) {
  check(got === want, label + (got === want ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
}

// ── the card shows the file, not the journey ────────────────────────────────
{
  const withShape = { bytes: 31000000, shape: { file_bytes: 31322407 } };
  eq(_createDoneBytes(withShape, 29600000), 31322407,
     'the file on disk wins over bytes carried');

  // The bar draws from shape.file_bytes, so agreeing with it IS the fix.
  eq(_createDoneBytes(withShape, 29600000), withShape.shape.file_bytes,
     'card and composition bar quote the same number');

  eq(_createDoneBytes({ bytes: 5000 }, 4000), 5000,
     'a result with no shape falls back to what it stated');
  eq(_createDoneBytes({}, 4000), 4000,
     'and to bytes carried when it stated nothing');
  eq(_createDoneBytes(null, 0), 0, 'nothing known is zero, not NaN');
  eq(_createDoneBytes({ shape: { file_bytes: 0 } }, 77), 77,
     'a zero file_bytes is not a size — fall through rather than show 0 B');
}

// ── a counter is shown only where it means what it says ─────────────────────
{
  // One page: per-page and cumulative are the same figure, so nothing changes.
  check(_createMetricLive('assets', 'page', true), 'page mode keeps its live assets');
  check(_createMetricLive('bytes', 'page', true), 'page mode keeps its live size');

  // A running crawl: these two reset per page and would go backwards.
  check(!_createMetricLive('assets', 'site', true), 'a running crawl hides per-page assets');
  check(!_createMetricLive('bytes', 'site', true), 'a running crawl hides per-page size');

  // What it does know is how many pages, and that only ever climbs.
  check(_createMetricLive('pages', 'site', true), 'a running crawl still shows pages');
  check(_createMetricLive('entries', 'site', true), 'and entries, which are cumulative');

  // Finished: the totals are real and deduplicated, so they come back.
  check(_createMetricLive('assets', 'site', false), 'a finished crawl shows its real totals');
  check(_createMetricLive('bytes', 'site', false), 'including its real size');
}

// ── a row stops offering a door to nowhere ──────────────────────────────────
{
  const made = { result: 'www_cnn_com', state: 'ok', ok: true };
  check(_createRowGone(made, false), 'a row whose ZIM is not in the library is gone');
  check(!_createRowGone(made, true), 'a row whose ZIM is still there is not');
  check(!_createRowGone({ ...made, gone: true }, false), 'already-gone rows are left alone');
  check(!_createRowGone({ state: 'failed', ok: false }, false),
        'a job that never produced a ZIM is not "gone" — it never arrived');
  check(!_createRowGone(null, false), 'nothing is not a row');
}

// What ended a crawl, in the person's words (survey finding F10): a crawl
// that reached the limit it was given was not "stopped early" by anyone.
{
  check(_createStoppedText('page cap (40)') === 'Reached the 40-page limit — a bigger limit captures more.',
        'a page cap says the limit was reached, with the number: ' + _createStoppedText('page cap (40)'));
  check(_createStoppedText('byte budget (500 MB)') === 'Reached the 500 MB size budget — everything up to it is here.',
        'a byte budget says which budget: ' + _createStoppedText('byte budget (500 MB)'));
  check(_createStoppedText('interrupted') === 'Stopped early — this is everything captured up to the stop.',
        'a Stop from the person still reads as stopped early');
  check(_createStoppedText(null) === '' && _createStoppedText('') === '', 'nothing ended it: no caption');
}

// The bytes chip becomes the file's size once the job is over (F2, F9); the
// other chips, and a live bytes chip, keep counting what they count.
{
  const done = { done: true, active: false, result: { shape: { file_bytes: 498229 } } };
  check(_createChipTarget('bytes', 769, done) === 498229, 'a finished bytes chip is the file size');
  check(_createChipTarget('entries', 10, done) === 10, 'entries are left alone');
  check(_createChipTarget('bytes', 769, { done: false, active: true }) === 769, 'a live bytes chip keeps counting');
  check(_createChipTarget('bytes', 769, { done: true, active: false, result: null }) === 769,
        'a failed job has no file; the chip keeps its last honest number');
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall good');
