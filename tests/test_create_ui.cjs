// The Create page's pure logic, driven straight out of the shipped source.
//
// create.js is a DOM module, but three things in it are pure and are exactly
// where a bug would be invisible until someone lost a crawl to it:
//
//   _createModeAvailable — which tiles an offline server may still offer
//   _createBuildRequest  — form fields to request body (the mode/flag mapping)
//   _createMergeLines    — the polling cursor, including the two cases that
//                          only happen in the wild: a repeated reply and a
//                          cursor that goes backwards when a new job starts
//
// Same approach as tests/test_almanac_tz_resolution.cjs: slice the pure prefix
// of the shipped file (everything above the first DOM function) and evaluate it
// in a sandbox, so the test drives the real code rather than a transcription.
//
// Run: node tests/test_create_ui.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'zimi', 'static', 'create.js'), 'utf8');

const MARKER = '// ── the surface ──';
const cut = SRC.indexOf(MARKER);
if (cut < 0) throw new Error('the pure/DOM boundary marker moved — update this test');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(SRC.slice(0, cut), sandbox);

let failures = 0;
function check(ok, label) {
  if (ok) { console.log('ok: ' + label); return; }
  console.error('FAIL: ' + label);
  failures++;
}
function eq(got, want, label) {
  check(JSON.stringify(got) === JSON.stringify(want),
    label + (JSON.stringify(got) === JSON.stringify(want) ? '' :
      ' — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}

const {
  CREATE_MODE_DEFS, CREATE_FIELDS, CREATE_CREDITS, CREATE_LOG_MAX,
  _createModeAvailable, _createBuildRequest, _createMergeLines
} = sandbox;

// The slice must actually contain the logic — a refactor that moves one of
// these below the marker would otherwise silently stop testing it.
for (const [name, fn] of Object.entries({
  _createModeAvailable, _createBuildRequest, _createMergeLines
})) {
  check(typeof fn === 'function', 'extracted ' + name);
}

const def = id => CREATE_MODE_DEFS.find(d => d.id === id);

// ── the modes, and which of them the server has ever heard of ───────────────

// Order is LIKELY USE. Capturing something off the web is why almost everyone
// opens this page, so the URL modes lead; the two that start from something
// already on the server come last. Folder must NOT be first — leading with
// "type a path on the server" is the round-one complaint this page exists to
// answer, so this assertion is a product decision, not a detail.
eq(CREATE_MODE_DEFS.map(d => d.id),
  ['page', 'site', 'video', 'bookmarks', 'folder', 'import'],
  'tile order: the web modes first, bookmarks, then the server-side two');
check(CREATE_MODE_DEFS[0].id !== 'folder', 'folder is never the first tile');

// Bookmarks is a CLIENT mode — its source is this browser's localStorage, and
// the server's CREATE_MODES tuple does not contain it. Sending one would be a
// 400 at best; this is the assertion that keeps the two lists honest.
eq(CREATE_MODE_DEFS.filter(d => !d.client).map(d => d.id).sort(),
  ['folder', 'import', 'page', 'site', 'video'],
  'the server-bound modes are exactly the server CREATE_MODES tuple');

check(_createBuildRequest('bookmarks', { source: 'anything at all' }) === null,
  'a client mode refuses to build a server request, whatever is in the field');

// Elegance is a contract here, not a mood: the form you SEE stays small. Two
// visible flags is the ceiling, and everything else a mode offers has to live
// behind the Advanced disclosure rather than growing the default view.
for (const d of CREATE_MODE_DEFS) {
  check(d.flags.length <= 2,
    `${d.id} shows at most two flags outside the Advanced disclosure`);
}

// Every option a mode names must exist in the field table, or it renders as
// nothing and silently stops being sent.
for (const d of CREATE_MODE_DEFS) {
  for (const key of d.flags.concat(d.advanced || [])) {
    check(!!CREATE_FIELDS[key], `${d.id}'s "${key}" is described in CREATE_FIELDS`);
  }
  for (const key of Object.keys(d.hints || {})) {
    check((d.advanced || []).concat(d.flags).indexOf(key) >= 0,
      `${d.id}'s hint for "${key}" belongs to a field it actually shows`);
  }
}

// No option may be listed twice — once outside and once inside the disclosure
// would render two controls writing the same request field.
for (const d of CREATE_MODE_DEFS) {
  const all = d.flags.concat(d.advanced || []);
  check(new Set(all).size === all.length, `${d.id} lists each option once`);
}

// Every field in the table is reachable from some mode: an orphan row is a
// control nobody can see and a request field the server will never be sent.
const used = new Set();
for (const d of CREATE_MODE_DEFS) {
  for (const key of d.flags.concat(d.advanced || [])) used.add(key);
}
for (const key of Object.keys(CREATE_FIELDS)) {
  check(used.has(key), `the "${key}" field is offered by at least one mode`);
}

// The advanced sets, pinned. These are the flags the engines take that a
// browser can reach; changing one is a product decision, not a refactor.
eq(CREATE_MODE_DEFS.map(d => [d.id, d.advanced]), [
  ['page', ['block_ads', 'language']],
  ['site', ['max_depth', 'max_bytes', 'delay', 'block_ads', 'language', 'ignore_robots']],
  ['video', ['format', 'max_bytes', 'language']],
  ['bookmarks', []],
  ['folder', ['language']],
  ['import', ['name']]
], 'each mode advertises its documented advanced options');

// Quality is a closed list of preset NAMES. A yt-dlp format expression is an
// instruction to a downloader, and it stays on the CLI — so this select must
// never become free text.
eq(CREATE_FIELDS.format.control, 'select', 'quality is a select, never free text');
eq(CREATE_FIELDS.format.options, ['720p', '1080p', '480p', 'best'],
  'the quality presets match the server whitelist');

// ── attribution ─────────────────────────────────────────────────────────────

eq(Object.keys(CREATE_CREDITS).sort(), ['import', 'video'],
  'the modes another project does the work for are the ones that carry a credit');
eq(CREATE_CREDITS.video.name, 'yt-dlp', 'video credits yt-dlp');
eq(CREATE_CREDITS['import'].name, 'warc2zim', 'import credits warc2zim');
for (const [mode, c] of Object.entries(CREATE_CREDITS)) {
  check(/^https:\/\//.test(c.url), `${mode}'s credit links out over https`);
}

// ── availability ────────────────────────────────────────────────────────────

for (const d of CREATE_MODE_DEFS) {
  check(_createModeAvailable(d, false, false) === true,
    `${d.id} is available when the server is online`);
}
eq(CREATE_MODE_DEFS.filter(d => _createModeAvailable(d, true, true)).map(d => d.id),
  ['bookmarks', 'folder', 'import'],
  'offline with the sidecar installed leaves bookmarks, folder and import');
eq(CREATE_MODE_DEFS.filter(d => _createModeAvailable(d, true, false)).map(d => d.id),
  ['bookmarks', 'folder'],
  'offline without the sidecar: import drops out, the two local modes stay');

// ── request mapping ─────────────────────────────────────────────────────────

eq(_createBuildRequest('folder', { source: '  /srv/docs  ', title: ' Notes ' }),
  { mode: 'folder', source: '/srv/docs', title: 'Notes' },
  'folder: source and title are trimmed');

eq(_createBuildRequest('folder', { source: '/srv/docs', title: '   ' }),
  { mode: 'folder', source: '/srv/docs' },
  'a blank title is omitted, not sent as an empty string');

check(_createBuildRequest('folder', { source: '   ' }) === null,
  'an empty source refuses to build a request');
check(_createBuildRequest('nope', { source: '/srv/docs' }) === null,
  'an unknown mode refuses to build a request');

// Flags belong to the mode that declares them. A stale value left in the DOM
// from a previously-open form must not ride along with the next submission.
const noise = {
  source: 'https://example.org/', title: '',
  max_pages: '300', limit: '9', audio_only: true
};
eq(_createBuildRequest('page', noise),
  { mode: 'page', source: 'https://example.org/' },
  'page sends no flags even when the form has stale ones');
eq(_createBuildRequest('site', noise),
  { mode: 'site', source: 'https://example.org/', max_pages: 300 },
  'site sends only max_pages');
eq(_createBuildRequest('video', noise),
  { mode: 'video', source: 'https://example.org/', audio_only: true, limit: 9 },
  'video sends only audio_only + limit');
eq(_createBuildRequest('import', noise),
  { mode: 'import', source: 'https://example.org/' },
  'import sends no flags at all');

// Empty / nonsense numbers mean "use the engine's own default", so they are
// left out rather than sent as 0 or NaN.
eq(_createBuildRequest('site', { source: 'https://e.org/', max_pages: '' }),
  { mode: 'site', source: 'https://e.org/' },
  'a blank max_pages is omitted');
eq(_createBuildRequest('site', { source: 'https://e.org/', max_pages: 'lots' }),
  { mode: 'site', source: 'https://e.org/' },
  'an unparseable max_pages is omitted');
eq(_createBuildRequest('video', { source: 'https://e.org/', limit: '0' }),
  { mode: 'video', source: 'https://e.org/' },
  'a zero limit is omitted');
eq(_createBuildRequest('video', { source: 'https://e.org/', audio_only: false }),
  { mode: 'video', source: 'https://e.org/' },
  'an unchecked audio_only is omitted');

// ── the capture engine ──────────────────────────────────────────────────────
//
// The one option on this page that changes what the ZIM CONTAINS rather than
// how much of it there is, so the wiring gets its own block: the fast engine
// must send nothing (the default lives on the server, in one place), and the
// rendered engine must reach the two modes that capture a web page and no
// others.

for (const id of ['page', 'site']) {
  check(def(id).flags.includes('engine'),
    `${id} offers the engine choice on the panel, not behind Advanced`);
}
for (const id of ['video', 'folder', 'import']) {
  const d = def(id);
  check(!d.flags.concat(d.advanced).includes('engine'),
    `${id} does not offer an engine choice — it does not capture a web page`);
}

eq(_createBuildRequest('page', { source: 'https://e.org/', engine: 'rendered' }),
  { mode: 'page', source: 'https://e.org/', engine: 'rendered' },
  'page: the rendered engine is sent');
eq(_createBuildRequest('site', { source: 'https://e.org/', engine: 'rendered' }),
  { mode: 'site', source: 'https://e.org/', engine: 'rendered' },
  'site: the rendered engine is sent');
eq(_createBuildRequest('site', { source: 'https://e.org/', engine: '' }),
  { mode: 'site', source: 'https://e.org/' },
  'the fast engine sends nothing — the default belongs to the server');
eq(_createBuildRequest('video', { source: 'https://e.org/', engine: 'rendered' }),
  { mode: 'video', source: 'https://e.org/' },
  'a stale engine value from another mode never rides along');

check(sandbox.CREATE_ENGINE_OPTIONS[0].v === '',
  'the fast engine is the first option, and it is the empty one');
check(sandbox.CREATE_ENGINE_OPTIONS.some(o => o.v === 'rendered' && o.needs === 'browser'),
  'the rendered option declares the capability the server has to report');
check(sandbox.CREATE_ENGINE_OPTIONS.some(o => o.v === 'alive' && o.needs === 'alive'),
  'the alive option declares its own capability, not the browser it also needs');
for (const o of sandbox.CREATE_ENGINE_OPTIONS) {
  check(!!o.k && !!o.d,
    'every engine option carries a name AND the sentence under it');
}

// Order is what SURVIVES a capture: the text, then the picture, then the
// behaviour. Each step up costs an install and a wait, which is what the
// sentence under each one says.
eq(sandbox.CREATE_ENGINE_OPTIONS.map(o => o.v), ['', 'rendered', 'alive'],
  'the engines are offered in order of how much of the page comes with them');

// Every capability an option names must have a row saying how to install it,
// or a server without it shows a disabled option and no way to fix it.
for (const o of sandbox.CREATE_ENGINE_OPTIONS) {
  if (!o.needs) continue;
  check(!!sandbox.CREATE_ENGINE_NEEDS[o.needs],
    `the "${o.needs}" capability has a row in CREATE_ENGINE_NEEDS`);
}

// ── blocking ads and trackers ───────────────────────────────────────────────
//
// The one checked-by-default checkbox on the page, and the one field that only
// belongs to some engines. Both of those are ways to send the wrong thing, so
// both are pinned here.

for (const id of ['page', 'site']) {
  check((def(id).advanced || []).includes('block_ads'),
    `${id} offers ad blocking, behind Advanced`);
}
for (const id of ['video', 'folder', 'import']) {
  const d = def(id);
  check(!d.flags.concat(d.advanced || []).includes('block_ads'),
    `${id} does not offer ad blocking — nothing there drives a browser`);
}

check(sandbox.CREATE_FIELDS.block_ads.on === true,
  'the ad-blocking checkbox is drawn already ticked');

eq(_createBuildRequest('page',
  { source: 'https://e.org/', engine: 'rendered', block_ads: true }),
  { mode: 'page', source: 'https://e.org/', engine: 'rendered', block_ads: true },
  'blocking left on is sent as a real true, not as silence');
eq(_createBuildRequest('page',
  { source: 'https://e.org/', engine: 'alive', block_ads: false }),
  { mode: 'page', source: 'https://e.org/', engine: 'alive', block_ads: false },
  'unticking it sends false — the whole reason this field is not an ordinary flag');
eq(_createBuildRequest('site',
  { source: 'https://e.org/', engine: 'rendered', block_ads: false }),
  { mode: 'site', source: 'https://e.org/', engine: 'rendered', block_ads: false },
  'site mode carries the same answer');
eq(_createBuildRequest('page',
  { source: 'https://e.org/', engine: '', block_ads: true }),
  { mode: 'page', source: 'https://e.org/' },
  'under the fast engine the field is not sent at all — it would describe nothing');
eq(_createBuildRequest('page',
  { source: 'https://e.org/', engine: 'rendered', block_ads: '' }),
  { mode: 'page', source: 'https://e.org/', engine: 'rendered' },
  'a control that was never drawn is silence, never an unticked box');

check(sandbox._createFieldApplies(sandbox.CREATE_FIELDS.block_ads, 'rendered'),
  'the field applies under the rendered engine');
check(!sandbox._createFieldApplies(sandbox.CREATE_FIELDS.block_ads, ''),
  'the field does not apply under the fast engine');
check(sandbox._createFieldApplies(sandbox.CREATE_FIELDS.language, ''),
  'a field with no engine requirement applies everywhere');

// ── advanced options ────────────────────────────────────────────────────────

eq(_createBuildRequest('site', {
  source: 'https://e.org/', max_pages: '50', max_depth: '2',
  max_bytes: ' 2G ', delay: '1.5', language: 'fra', ignore_robots: true
}), {
  mode: 'site', source: 'https://e.org/', max_pages: 50, max_depth: 2,
  max_bytes: '2G', delay: 1.5, language: 'fra', ignore_robots: true
}, 'site sends its whole advanced set, sizes as typed and delays fractional');

eq(_createBuildRequest('folder', { source: '/srv/docs', language: 'deu' }),
  { mode: 'folder', source: '/srv/docs', language: 'deu' },
  'folder sends language and nothing else');

eq(_createBuildRequest('import', { source: '/srv/a.wacz', name: 'my-archive' }),
  { mode: 'import', source: '/srv/a.wacz', name: 'my-archive' },
  'import sends the name override');

// Depth zero is a real answer — the seed page and nothing it links to — so it
// must survive the "blank means default" filter that eats a zero page count.
eq(_createBuildRequest('site', { source: 'https://e.org/', max_depth: '0', delay: '0' }),
  { mode: 'site', source: 'https://e.org/', max_depth: 0, delay: 0 },
  'a zero depth and a zero delay are sent, not swallowed');

eq(_createBuildRequest('site', { source: 'https://e.org/', ignore_robots: false }),
  { mode: 'site', source: 'https://e.org/' },
  'an unchecked ignore_robots is omitted rather than sent as false');

eq(_createBuildRequest('site', { source: 'https://e.org/', max_bytes: '   ' }),
  { mode: 'site', source: 'https://e.org/' },
  'a blank size budget is omitted');

// A size that is not a size still goes to the server: parsing sizes is the
// server's job (it owns the same parser the CLI uses) and it answers with the
// message that names the fix. The client must not invent a second dialect.
eq(_createBuildRequest('site', { source: 'https://e.org/', max_bytes: 'banana' }),
  { mode: 'site', source: 'https://e.org/', max_bytes: 'banana' },
  'an unparseable size is passed through for the server to refuse');

// Advanced options belong to their mode exactly as visible flags do.
const advNoise = {
  source: 'https://e.org/', max_depth: '3', delay: '2',
  language: 'eng', name: 'stolen', ignore_robots: true, format: 'best'
};
eq(_createBuildRequest('page', advNoise),
  { mode: 'page', source: 'https://e.org/', language: 'eng' },
  'page takes only language from a form full of another mode\'s values');
eq(_createBuildRequest('video', advNoise),
  { mode: 'video', source: 'https://e.org/', format: 'best', language: 'eng' },
  'video takes only its own advanced options');
eq(_createBuildRequest('import', advNoise),
  { mode: 'import', source: 'https://e.org/', name: 'stolen' },
  'import takes only the name');

// Audio-only owns the format. Sending both would describe a preference that
// nothing downstream reads — the engine picks the audio selector regardless.
eq(_createBuildRequest('video', {
  source: 'https://e.org/', audio_only: true, format: '1080p'
}), { mode: 'video', source: 'https://e.org/', audio_only: true },
  'audio-only drops the quality preset');

// ── the polling cursor ──────────────────────────────────────────────────────

let s = _createMergeLines([], 0, { lines: ['a', 'b'], cursor: 2 });
eq(s, { lines: ['a', 'b'], cursor: 2 }, 'first poll takes everything');

s = _createMergeLines(s.lines, s.cursor, { lines: ['c'], cursor: 3 });
eq(s, { lines: ['a', 'b', 'c'], cursor: 3 }, 'later polls append');

s = _createMergeLines(s.lines, s.cursor, { lines: [], cursor: 3 });
eq(s, { lines: ['a', 'b', 'c'], cursor: 3 }, 'an empty reply changes nothing');

// A retried poll (same cursor answered twice) must not duplicate the tail. The
// server only ever sends what is new for the cursor we gave it, so "nothing
// new" is the honest reply and the cursor holds.
s = _createMergeLines(s.lines, s.cursor, { cursor: 3 });
eq(s, { lines: ['a', 'b', 'c'], cursor: 3 }, 'a reply with no lines field is inert');

// A new job restarts the server's counter. Interleaving the two jobs' output
// would be the worst outcome; the tail resets instead.
s = _createMergeLines(s.lines, s.cursor, { lines: ['fresh'], cursor: 1 });
eq(s, { lines: ['fresh'], cursor: 1 }, 'a cursor that went backwards restarts the tail');

// A malformed reply (no cursor at all) must not move us backwards or forwards.
s = _createMergeLines(['x'], 7, { lines: [] });
eq(s, { lines: ['x'], cursor: 7 }, 'a reply with no cursor holds position');

// The client never holds more tail than the server is willing to produce.
const flood = Array.from({ length: CREATE_LOG_MAX + 120 }, (_, i) => 'l' + i);
s = _createMergeLines([], 0, { lines: flood, cursor: flood.length });
check(s.lines.length === CREATE_LOG_MAX, 'the client tail is bounded too');
check(s.lines[s.lines.length - 1] === flood[flood.length - 1],
  'the bounded tail keeps the NEWEST lines');

// ── round 2: the preview rows ───────────────────────────────────────────────
//
// What the preview claims is the entire promise the page makes before a job
// runs. A preview that says the wrong number is worse than no preview: it is
// the shot in the dark with a confident voice.

const { _createPreviewRows } = sandbox;
check(typeof _createPreviewRows === 'function', 'extracted _createPreviewRows');

// The sandbox has no app.js, so lend it the two globals the rows are built
// from. `t` substitutes exactly as the real one does, so a phrase built from a
// key AND its numbers can be asserted whole.
sandbox._fmtBytes = b => b + ' B';
sandbox.t = (k, vars) => {
  let s = k;
  if (vars) for (const name in vars) s = s.split('{' + name + '}').join(vars[name]);
  return s;
};

const rowMap = p => Object.fromEntries(_createPreviewRows(p).map(r => [r.k, r.v]));

eq(rowMap({ mode: 'folder', files: 47, bytes: 1024, main: 'index.html', language: 'fra' }),
  {
    create_pv_files: '47',
    create_pv_size: '1024 B',
    create_pv_main: 'index.html',
    create_pv_language: 'fra create_pv_detected'
  },
  'folder rows: count, size, main page, detected language');

check(rowMap({ mode: 'folder', files: 20000, files_capped: true, bytes: 0 }).create_pv_files === '20000+',
  'a capped count says so rather than claiming an exact total');

// Absent facts are absent rows. A preview line reading "Main page:" with
// nothing after it is a worse answer than not asking the question.
eq(_createPreviewRows({ mode: 'folder', files: 0, bytes: 0 }).map(r => r.k),
  ['create_pv_files', 'create_pv_size'],
  'a missing main page and language drop their rows entirely');

eq(_createPreviewRows({ mode: 'page', title: 'Handbuch', final_url: 'http://x/', bytes: 8 }).map(r => r.k),
  ['create_pv_title', 'create_pv_address', 'create_pv_size'],
  'page rows, with no robots line when the server did not report one');

check(rowMap({ mode: 'site', title: 'T', final_url: 'u', bytes: 1, robots_allowed: false })
  .create_pv_robots === 'create_pv_robots_no',
  'site rows carry the robots verdict when there is one');

// Round 4, Eric: "The size shown up front isn't close to this why bother
// showing it?" The probe reads ONE page of a site; a crawl's bytes are mostly
// the assets of pages it never looked at. So site mode promises no size — the
// counter during the run is the number, and it counts real responses.
eq(_createPreviewRows({ mode: 'site', title: 'T', final_url: 'http://x/', bytes: 4096 })
  .map(r => r.k),
  ['create_pv_title', 'create_pv_address'],
  'site mode shows no size it cannot measure');
check(rowMap({ mode: 'page', title: 'T', final_url: 'http://x/', bytes: 4096 })
  .create_pv_size === '4096 B',
  'one page IS the whole capture, so page mode keeps its measured size');

check(rowMap({ mode: 'video', videos: 12 }).create_pv_videos === '12+',
  'a playlist sampled to the cap is reported as "12+", not as exactly 12');
check(rowMap({ mode: 'video', videos: 3 }).create_pv_videos === '3',
  'a playlist shorter than the cap is reported exactly');

check(rowMap({ mode: 'import', bytes: 9, sidecar_ready: false }).create_pv_helper === 'create_pv_installs',
  'import says whether its helper still has to install');

eq(_createPreviewRows(null), [], 'no probe reply means no rows');

// ── round 4: how much longer ─────────────────────────────────────────────────
//
// Eric, watching a crawl sit at 8/200: "Super slow can you see it? can we
// provide time estimates for any of these steps?" The estimate is a rolling
// rate against a known remainder, and the whole risk in it is the case where
// it should say nothing at all — an ETA that outlives the rate it came from
// turns a stall into a promise.

const { _createEstimate, _createEtaText, _createPushSample,
  CREATE_ETA_WINDOW, CREATE_ETA_STALE_MS } = sandbox;

// A run at a steady two per second, sampled once a second.
const steady = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ t: 1000 + i * 1000, n: (from + i) * 2 }));

let est = _createEstimate(steady(0, 9), 100, 1000 + 9000);
check(Math.round(est.rate) === 2, 'the rate is read off the window, in units a second');
check(est.remaining === 100 - 18, 'what is left is the total minus where it got to');
check(Math.round(est.ms / 1000) === 41, 'and the wait is that remainder at that rate');

// Revision: the same run, slowed to one per second half way, must report the
// NEW rate. That is what the window is for.
const slowed = [
  { t: 1000, n: 0 }, { t: 2000, n: 2 }, { t: 3000, n: 4 },
  { t: 8000, n: 5 }, { t: 13000, n: 6 },
];
check(_createEstimate(slowed, 100, 13000).rate < 1,
  'a crawl that slows down is reported at the rate it slowed to');

// An unknown or already-passed total buys a rate and nothing more: a finish
// line nobody reported is not one to invent.
check(_createEstimate(steady(0, 9), undefined, 10000).ms === null,
  'no total, no finish line — the rate stands alone');
check(_createEstimate(steady(0, 9), 5, 10000).ms === null,
  'a total the count has already passed is not a remainder');

// The four ways there is nothing defensible to say.
check(_createEstimate([{ t: 1000, n: 1 }], 100, 2000) === null, 'one sample is not a rate');
check(_createEstimate([], 100, 2000) === null, 'no samples, no estimate');
check(_createEstimate([{ t: 1000, n: 4 }, { t: 1500, n: 5 }], 100, 1500) === null,
  'a window younger than the minimum span is not divided by');
check(_createEstimate([{ t: 1000, n: 4 }, { t: 9000, n: 4 }], 100, 9000) === null,
  'a count that has not moved has no rate');
// The one that matters most: the stream went quiet, so the estimate goes away
// rather than freezing at whatever it last said.
check(_createEstimate(steady(0, 9), 100, 10000 + CREATE_ETA_STALE_MS + 1) === null,
  'a stale window yields NO estimate — a frozen ETA is a lie about a stall');

// The window is bounded and only records movement: a repeated count carries no
// time information and would only stretch the span it is averaged over.
let win = [];
for (let i = 0; i < CREATE_ETA_WINDOW + 20; i++) _createPushSample(win, i, 1000 + i * 10);
check(win.length === CREATE_ETA_WINDOW, 'the window is bounded');
check(win[win.length - 1].n === CREATE_ETA_WINDOW + 19, 'and keeps the NEWEST samples');
win = [];
_createPushSample(win, 7, 1000);
_createPushSample(win, 7, 2000);
_createPushSample(win, 8, 3000);
eq(win.map(s => s.n), [7, 8], 'a repeated count is not a new sample');

// The one that broke this on its first run: a poll delivering four pages
// delivers them at ONE instant, and four samples sharing a timestamp fill the
// window with a span of zero — which reads as "not enough history yet" forever.
win = [];
_createPushSample(win, 1, 5000);
_createPushSample(win, 2, 5000);
_createPushSample(win, 3, 5000);
eq(win, [{ t: 5000, n: 3 }], 'one instant is one sample, at the newest count');
_createPushSample(win, 9, 9000);
check(_createEstimate(win, 100, 9000) !== null,
  'so a window built from two polls is a window with a span');

// The phrasing, asserted as the sentence a person actually reads: for this
// stretch `t` is backed by the shipped English locale, so a missing key or a
// placeholder that does not match its format shows up here rather than on the
// page. Restored afterwards — everything else in this file asserts on keys.
const keyStub = sandbox.t;
const EN = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'zimi', 'static', 'i18n', 'en.json'), 'utf8'));
sandbox.t = (k, vars) => keyStub(EN[k] === undefined ? k : EN[k], vars);

check(_createEtaText(null) === '', 'no estimate, no phrase');
check(_createEtaText({ rate: 0.2, remaining: null, ms: null }) === '12/min',
  'a rate with no finish line is shown as a rate');
check(_createEtaText({ rate: 0.004, remaining: null, ms: null }) === '',
  'a pace that rounds to "0/min" says nothing rather than saying zero');
check(_createEtaText({ rate: 1, remaining: 30, ms: 30000 }) === 'under a minute left',
  'under a minute is a phrase, not "~0 min"');
check(_createEtaText({ rate: 1, remaining: 240, ms: 240000 }) === '~4 min left',
  'minutes read as minutes');
check(_createEtaText({ rate: 1, remaining: 5000, ms: 5000000 }) === '~1 h 23 min left',
  'and an hour-long crawl says hours');
// Every phrase is hedged or bounded — none of them promises a finish time.
for (const phrase of ['create_eta_min', 'create_eta_hour']) {
  check(EN[phrase].indexOf('~') === 0, phrase + ' leads with the hedge');
}
sandbox.t = keyStub;

// ── round 4: the run header's source line ───────────────────────────────────
//
// The run pane is headed by what is being made for as long as it is being
// made, and the second half of that line is the address. An address has no
// natural length, and this page has no horizontal scroll.

const { _createShortSource, CREATE_SOURCE_MAX } = sandbox;
check(_createShortSource('https://example.org/docs/') === 'example.org/docs/',
  'the scheme is dropped: every source here is http and it buys nothing');
check(_createShortSource('http://example.org/') === 'example.org/',
  'http goes too, not just https');
check(_createShortSource('') === '' && _createShortSource(null) === '',
  'no source is an empty line, never the string "null"');
const long = _createShortSource('https://e.org/' + 'x'.repeat(400));
check(long.length === CREATE_SOURCE_MAX, 'a long address is clamped to the budget');
check(long.slice(-1) === '…', 'and says it was clamped');
check(_createShortSource('e.org/short') === 'e.org/short',
  'a short address is left exactly as it is');

// ── round 2: the option tables ──────────────────────────────────────────────

const { CREATE_SIZE_OPTIONS, CREATE_LANGUAGE_OPTIONS } = sandbox;
check(CREATE_SIZE_OPTIONS[0].v === '' && !!CREATE_SIZE_OPTIONS[0].k,
  'the size select opens on "engine default", carrying an i18n key');
check(CREATE_LANGUAGE_OPTIONS[0].v === '' && !!CREATE_LANGUAGE_OPTIONS[0].k,
  'the language select opens on Auto');
check(CREATE_LANGUAGE_OPTIONS.slice(1).every(o => /^[a-z]{3}$/.test(o.v)),
  'every language option is an ISO 639-3 code the server will accept');
check(CREATE_LANGUAGE_OPTIONS.slice(1).every(o => !!o.t && !o.k),
  'language names are literals, not translation keys');

// Per-mode budget defaults have to name options that exist, or the select
// silently falls back to its first entry and the default is a lie.
for (const d of CREATE_MODE_DEFS) {
  if (!d.pick) continue;
  for (const key of Object.keys(d.pick)) {
    const opts = (sandbox.CREATE_FIELDS[key].options || []).map(o => (typeof o === 'string' ? o : o.v));
    check(opts.indexOf(d.pick[key]) >= 0,
      `${d.id}'s preselected ${key} (${d.pick[key]}) is a real option`);
  }
}

// ── round 3: the progress model ─────────────────────────────────────────────
//
// The visualization is fed by a stream the client does not control and cannot
// replay. Every rule below is one the server is allowed to break — a poll that
// answers twice, a phase name from a newer build, a node that arrives before
// its parent — and the model has to survive all of them without the person
// watching ever knowing it happened.

const {
  _createMergeEvents, _createApplyEvents, _createNewViz, _createPhaseStep,
  _createPathOf, _createParentByPath, _createHistoryState, _createHistoryLabel,
  _createModeVisible, CREATE_HISTORY_KEYS, CREATE_PHASE_STEPS, CREATE_STEP_KEYS,
  CREATE_TREE_MAX_NODES
} = sandbox;

for (const [name, fn] of Object.entries({
  _createMergeEvents, _createApplyEvents, _createPhaseStep, _createPathOf,
  _createParentByPath, _createHistoryState, _createModeVisible
})) {
  check(typeof fn === 'function', 'extracted ' + name);
}

// -- support detection -------------------------------------------------------
//
// A build that predates events sends neither field. The answer to that is the
// log view exactly as it was, so "supported" has to be false for the old shape
// and true for the new one even when the new one has nothing to say yet.
check(_createMergeEvents(0, { lines: [], cursor: 0 }).supported === false,
  'a reply with no events fields means this server does not speak events');
check(_createMergeEvents(0, { events: [], event_cursor: 0 }).supported === true,
  'an empty event batch still means the server speaks events');
check(_createMergeEvents(0, { event_cursor: 4 }).supported === true,
  'a cursor alone is enough to prove support');

let e = _createMergeEvents(0, { events: [{ i: 0 }, { i: 1 }], event_cursor: 2 });
eq([e.cursor, e.events.length, e.reset], [2, 2, false], 'first event poll takes everything');
e = _createMergeEvents(2, { events: [], event_cursor: 2 });
eq([e.cursor, e.reset], [2, false], 'an empty event reply holds position');
e = _createMergeEvents(9, { events: [{ i: 0 }], event_cursor: 1 });
eq([e.cursor, e.reset], [1, true], 'an event cursor that went backwards is a new job');
e = _createMergeEvents(5, { lines: [] });
eq([e.cursor, e.supported], [5, false], 'a reply with no event cursor holds position');

// -- phases ------------------------------------------------------------------
//
// Seven server phases, four visible steps. The fold is what a person watching
// actually distinguishes: fetching a page and fetching that page's images are
// one activity to everyone except the crawler, and packaging a ZIM and
// converting a recording into one are both "it is writing the file now".
eq(Object.keys(CREATE_PHASE_STEPS).sort(),
  ['assets', 'convert', 'done', 'fetch', 'package', 'probe', 'register'],
  'every phase the server documents has a step');
check(CREATE_STEP_KEYS.length === 4, 'the strip shows four steps');
for (const phase of Object.keys(CREATE_PHASE_STEPS)) {
  const step = _createPhaseStep(phase);
  check(step >= 0 && step < CREATE_STEP_KEYS.length,
    `the "${phase}" phase maps onto a step that exists`);
}
check(_createPhaseStep('fetch') === _createPhaseStep('assets'),
  'fetching a page and fetching its assets are one step');
// A newer server inventing a seventh phase must leave the strip where it was,
// not throw it back to the beginning.
check(_createPhaseStep('teleporting') === -1, 'an unknown phase moves nothing');
check(_createPhaseStep(undefined) === -1, 'a missing phase moves nothing');

// -- the model ---------------------------------------------------------------

const viz = () => _createNewViz();
const node = (id, extra) => Object.assign({ t: 'node', kind: 'page', id: id, label: id }, extra);

let v = viz();
let ch = _createApplyEvents(v, [
  { t: 'phase', phase: 'fetch', detail: 'site' },
  node('a', { state: 'active' }),
  { t: 'count', what: 'entries', n: 1, total: 10 }
]);
eq([ch.phase, ch.counts, ch.added], [true, true, ['a']], 'one batch reports what it moved');
eq([v.step, v.pages, v.counts.entries.n], [1, 1, 1], 'and the model holds it');

// The same batch applied twice must change nothing. This is the whole defence
// against a duplicated poll: there is no per-event ledger, so every operation
// has to be idempotent by construction.
const before = JSON.stringify(v);
_createApplyEvents(v, [
  { t: 'phase', phase: 'fetch', detail: 'site' },
  node('a', { state: 'active' }),
  { t: 'count', what: 'entries', n: 1, total: 10 }
]);
check(JSON.stringify(v) === before, 'replaying a batch changes nothing');
// Including the ETA's timing window, which is the one piece of state that
// carries a clock: a re-sent phase must not throw the rate away, and a count
// that has not moved must not be timed twice.
eq(v.samples.map(s => s.n), [1], 'a replayed batch does not disturb the window');

// A phase only ever moves forward: the server reports "done" for one file
// while a later line is still being derived, and the strip must not rewind.
_createApplyEvents(v, [{ t: 'phase', phase: 'package' }]);
_createApplyEvents(v, [{ t: 'phase', phase: 'fetch' }]);
check(v.step === 2, 'the strip never goes backwards');

// -- assets fill the page they landed on -------------------------------------
v = viz();
_createApplyEvents(v, [node('p1')]);
_createApplyEvents(v, [
  { t: 'node', kind: 'asset', id: 'p1#css', parent: 'p1', state: 'active' },
  { t: 'node', kind: 'asset', id: 'p1#img', parent: 'p1', state: 'active' }
]);
eq([v.nodes.p1.assets.total, v.nodes.p1.assets.done], [2, 0],
  'assets in flight are counted but have not landed');
_createApplyEvents(v, [
  { t: 'node', kind: 'asset', id: 'p1#css', parent: 'p1', state: 'done' },
  { t: 'node', kind: 'asset', id: 'p1#img', parent: 'p1', state: 'failed' }
]);
eq([v.nodes.p1.assets.total, v.nodes.p1.assets.done], [2, 2],
  'a failed asset has landed too — the page is not still waiting for it');
_createApplyEvents(v, [{ t: 'node', kind: 'asset', id: 'p1#css', parent: 'p1', state: 'done' }]);
eq([v.nodes.p1.assets.total, v.nodes.p1.assets.done], [2, 2],
  'a repeated asset never double-counts');
check(v.pages === 1, 'assets are not pages');

// -- a node re-sent is an update, never a second row -------------------------
v = viz();
_createApplyEvents(v, [node('u', { state: 'active', label: '/slow' })]);
ch = _createApplyEvents(v, [{ t: 'node', kind: 'page', id: 'u', state: 'done' }]);
eq([ch.added, ch.updated], [[], ['u']], 'the same id again is an update');
eq([v.nodes.u.state, v.nodes.u.label], ['done', '/slow'],
  'and an omitted field keeps its previous value');
check(v.pages === 1, 'an update does not count as another page');

// -- out-of-order parents ----------------------------------------------------
//
// A child held for a parent that never arrives would be a page the crawl
// captured and the tree never showed. It is released as a root at the end of
// the batch instead: in the wrong place beats invisible.
v = viz();
ch = _createApplyEvents(v, [
  node('kid', { parent: 'mum' }),
  node('mum')
]);
eq(ch.added, ['mum', 'kid'], 'a parent later in the batch still adopts its child');
check(v.nodes.kid.parent === 'mum', 'and the child keeps the parent it was given');

v = viz();
ch = _createApplyEvents(v, [node('orphan', { parent: 'never-arrives' })]);
eq(ch.added, ['orphan'], 'a parent that never arrives releases the child as a root');
check(v.nodes.orphan.parent === '', 'and the dangling parent reference is dropped');

// -- the derived tree --------------------------------------------------------
//
// The crawler reports which page it captured, never which page linked to it,
// so the tree branches on the site's own address space. Every row is still a
// page the crawl really fetched.
eq([_createPathOf('example.org'), _createPathOf('/docs/'), _createPathOf('/docs/install.html'),
    _createPathOf('/docs/list?page=2'), _createPathOf('/'), _createPathOf('Some Video Title')],
  ['', '/docs', '/docs/install.html', '/docs/list', '', ''],
  'a label becomes the path it addresses, or the root');

v = viz();
_createApplyEvents(v, [
  node('seed', { label: 'example.org' }),
  node('d', { label: '/docs/' }),
  node('i', { label: '/docs/install.html' }),
  node('deep', { label: '/docs/guide/advanced.html' }),
  node('lone', { label: '/about.html' })
]);
eq([v.nodes.d.parent, v.nodes.i.parent, v.nodes.lone.parent],
  ['seed', 'd', 'seed'],
  'pages hang off the section they are in, and off the seed otherwise');
check(v.nodes.deep.parent === 'd',
  'a page below an uncaptured level attaches to the deepest ancestor there is');
eq(v.roots, ['seed'], 'one root: the page the crawl started from');

// A server that DOES report parentage always wins — the derived tree is the
// fallback, not an override.
v = viz();
_createApplyEvents(v, [
  node('seed', { label: 'example.org' }),
  node('a', { label: '/docs/' }),
  node('b', { label: '/docs/x.html', parent: 'seed' })
]);
check(v.nodes.b.parent === 'seed', 'a server-sent parent beats the derived one');

// Two ids landing on one address (a redirect) must not make the second the
// parent of the first's children.
v = viz();
_createApplyEvents(v, [
  node('first', { label: '/docs/' }),
  node('second', { label: '/docs/' }),
  node('child', { label: '/docs/x.html' })
]);
check(v.nodes.child.parent === 'first', 'the first claim on an address keeps it');

// -- history -----------------------------------------------------------------
//
// Interrupted is deliberately NOT a failure: the job did not fail, the machine
// went away underneath it, and calling that a failure sends someone hunting
// for a bug in a URL that was fine.
for (const state of ['ok', 'failed', 'cancelled', 'stalled', 'interrupted']) {
  check(_createHistoryState({ state: state }) === state,
    `the server's own "${state}" verdict is taken as it is`);
  check(!!CREATE_HISTORY_KEYS[state], `"${state}" has a sentence to show`);
}
check(_createHistoryState({ ok: true }) === 'ok',
  'a record with only booleans still resolves');
check(_createHistoryState({ ok: false }) === 'failed', 'and defaults to failed');
check(_createHistoryState({ state: 'running' }) === 'failed',
  'a live state is not one of the four endings');

eq(_createHistoryLabel({ title: 'My Book', result: 'my_book', source: 'http://x/' }), 'My Book',
  'the admin\'s own title names the row');
eq(_createHistoryLabel({ result: 'my_book', source: 'http://x/' }), 'my_book',
  'then the file it wrote');
eq(_createHistoryLabel({ source: 'http://x/' }), 'http://x/', 'then what was typed in');
eq(_createHistoryLabel({ mode: 'site' }), 'create_mode_site', 'then the mode, but never nothing');

// -- who is offered which mode -----------------------------------------------
//
// Two reasons a mode is not drawn, and both are the server's rules shown
// honestly. Eric, on the round-2 folder flow: "I don't love showing the whole
// file system there." So the web surface stays CLOSED until the operator names
// a root. And a creator account — a signed-in user with the per-user create
// permission — never sees the two modes that read the SERVER'S disk, because
// the server keeps those for the primary admin.
//
// Hidden rather than disabled in both cases: a greyed-out chip advertises a
// feature, and there is nothing to advertise to someone who will never be
// allowed it. The server enforces both independently — this decides which door
// is DRAWN, never which one is locked.
const folder = def('folder');
check(folder.needsRoot === true, 'folder mode is the one that needs a root');
check(_createModeVisible(folder, '', false) === false, 'no root configured, no folder chip');
check(_createModeVisible(folder, '/srv/sources', false) === true,
  'a root configured brings it back');
for (const d of CREATE_MODE_DEFS) {
  if (d.id === 'folder') continue;
  check(_createModeVisible(d, '', false) === true,
    `${d.id} is offered to an admin whatever the root setting is`);
}

// The two server-path modes are exactly folder and import — the pair the
// server gates to the primary admin. Marked in the table rather than named in
// an if, so adding a third server-path mode cannot forget this rule.
eq(CREATE_MODE_DEFS.filter(d => d.serverPath).map(d => d.id), ['folder', 'import'],
  'folder and import are the modes that read the server\'s own disk');
eq(CREATE_MODE_DEFS.filter(d => _createModeVisible(d, '/srv/sources', true)).map(d => d.id),
  ['page', 'site', 'video', 'bookmarks'],
  'a creator gets the web modes and bookmarks, never the two server-path ones');
check(_createModeVisible(folder, '/srv/sources', true) === false,
  'a configured root does NOT open folder mode to a creator');

check(CREATE_TREE_MAX_NODES > 0 && CREATE_TREE_MAX_NODES <= 1000,
  'the tree draws a bounded number of rows, whatever the crawl size');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nPASS');
