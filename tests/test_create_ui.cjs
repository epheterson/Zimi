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

// ── the five modes are the five the server accepts ──────────────────────────

eq(CREATE_MODE_DEFS.map(d => d.id),
  ['folder', 'page', 'site', 'video', 'import'],
  'mode ids match the server CREATE_MODES tuple');

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
  ['folder', ['language']],
  ['page', ['language']],
  ['site', ['max_depth', 'max_bytes', 'delay', 'language', 'ignore_robots']],
  ['video', ['format', 'max_bytes', 'language']],
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
  ['folder', 'import'],
  'offline with the sidecar installed leaves folder + import');
eq(CREATE_MODE_DEFS.filter(d => _createModeAvailable(d, true, false)).map(d => d.id),
  ['folder'],
  'offline without the sidecar leaves folder alone — import needs one online run');

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

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nPASS');
