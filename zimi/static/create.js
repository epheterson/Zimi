// Create a ZIM — the web face of `zimi create` / `zimi import`.
//
// Lazy-loaded by openCreate() in app.js the first time an admin taps the +.
// Renders a full-page surface over the library (the Almanac's shape) and talks
// to three endpoints: POST /manage/create, GET /manage/create/status, and
// POST /manage/create/cancel.
//
// The whole design is one idea: pick what you are packaging, give it the one
// thing it needs, watch it run. Every mode shows exactly one primary input and
// at most two flags — that is the form you see. Depth limits, byte budgets,
// media quality and content language are real controls people need, so they
// live one click away behind "Advanced" rather than in a manual: simple by
// default, complete when asked. Fewer VISIBLE controls IS the feature; fewer
// controls full stop just moves the work somewhere the browser cannot go.

// Poll cadence. The floor is deliberate: this runs on a Pi that is also serving
// the library, and a crawl emits at most a line per page. On 429 or a network
// blip the interval doubles up to the ceiling instead of surfacing an error —
// a progress pane that gives up because the rate limiter blinked is worse than
// a slow one.
var CREATE_POLL_MS = 2000;
var CREATE_POLL_MAX_MS = 10000;
// Mirrors the server's ring buffer, so the client never holds more tail than
// the server is willing to produce.
var CREATE_LOG_MAX = 500;
// What the server's probe stops counting at, so the preview can say "12+"
// rather than claiming a playlist is exactly as long as the sample.
var CREATE_PROBE_CAP = 12;

var _CREATE_ICONS = {
  folder: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  page: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>',
  site: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/></svg>',
  video: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><polygon points="10 9 15 12 10 15 10 9"/></svg>',
  bookmarks: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>',
  'import': '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8"/><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M10 12h4"/></svg>'
};

// The one description of every mode: what it is called, what it asks for, what
// it needs to work, and which options it offers where. Tiles, forms and the
// request body are all derived from this — adding a mode means adding a row.
//
//   network     — refuses to run when ZIMI_OFFLINE is set
//   sidecar     — needs the warc2zim helper (installed on first use, online)
//   flags       — shown on the form itself; two is the ceiling, on purpose
//   advanced    — shown inside the collapsed "Advanced" disclosure
//   hints       — per-mode placeholder overrides, for text and number fields
//   pick        — per-mode preselected option, for selects, where one field's
//                 real default differs by engine (a crawl budget is not a
//                 video one). A select has no placeholder, so a default it is
//                 meant to arrive with has to be a chosen option.
//   browse      — the source is a server path, so offer the folder picker
// Bookmarks is one of the six ways to make a ZIM and the only one whose source
// is not on the server: the bookmarks live in this browser's localStorage. So it
// is a CLIENT mode — it never reaches /manage/create, and its button hands off
// to the export selector that already exists in the bookmarks panel rather than
// growing a second, worse folder picker here.
var CREATE_BOOKMARKS_DEF = {
  id: 'bookmarks', network: false, client: true, flags: [], advanced: []
};

// Order is LIKELY USE, which is not the same as likely to succeed. Capturing
// something off the web is why almost everyone opens this page, so the three
// URL modes lead, cheapest first; then bookmarks, which is a handful of
// articles you already chose; then the two that start from something already
// sitting on the server, which is the rarest way in and the one you only reach
// deliberately. Folder is emphatically not first — leading with "type a path on
// the server" is what made round one feel like a shot in the dark.
var CREATE_MODE_DEFS = [
  {
    id: 'page', network: true, multiline: true,
    label: 'create_label_page_url', placeholder: 'create_ph_url',
    flags: [], advanced: ['language']
  },
  {
    id: 'site', network: true,
    label: 'create_label_site_url', placeholder: 'create_ph_url',
    flags: ['max_pages'],
    advanced: ['max_depth', 'max_bytes', 'delay', 'language', 'ignore_robots'],
    pick: { max_bytes: '500M' }
  },
  {
    id: 'video', network: true,
    label: 'create_label_video_url', placeholder: 'create_ph_video',
    flags: ['audio_only', 'limit'],
    advanced: ['format', 'max_bytes', 'language'],
    pick: { max_bytes: '4G' }
  },
  CREATE_BOOKMARKS_DEF,
  {
    id: 'folder', network: false, browse: true,
    label: 'create_label_folder', placeholder: 'create_ph_folder',
    flags: [], advanced: ['language']
  },
  {
    id: 'import', network: false, sidecar: true,
    label: 'create_label_archive', placeholder: 'create_ph_archive',
    flags: [], advanced: ['name']
  }
];

// Size budgets, as amounts rather than as a syntax to remember. The values are
// the strings the engines' own parse_size already accepts, so the web form does
// not invent a second dialect of a field the CLI already has. Empty means "the
// engine's own default", which is the honest name for leaving it alone.
var CREATE_SIZE_OPTIONS = [
  { v: '', k: 'create_size_default' },
  { v: '100M', t: '100 MB' },
  { v: '500M', t: '500 MB' },
  { v: '1G', t: '1 GB' },
  { v: '4G', t: '4 GB' },
  { v: '16G', t: '16 GB' },
  { v: '64G', t: '64 GB' }
];

// Content languages, ISO 639-3, in each language's own name — someone choosing
// the language of their content reads it in that language. Not a complete list
// and not meant to be: it is the common cases, and the probe's detection covers
// the rest by reading what the source itself declares.
var CREATE_LANGUAGE_OPTIONS = [
  { v: '', k: 'create_language_auto' },
  { v: 'ara', t: 'العربية (ara)' },
  { v: 'ben', t: 'বাংলা (ben)' },
  { v: 'deu', t: 'Deutsch (deu)' },
  { v: 'eng', t: 'English (eng)' },
  { v: 'fas', t: 'فارسی (fas)' },
  { v: 'fra', t: 'Français (fra)' },
  { v: 'heb', t: 'עברית (heb)' },
  { v: 'hin', t: 'हिन्दी (hin)' },
  { v: 'ind', t: 'Indonesia (ind)' },
  { v: 'ita', t: 'Italiano (ita)' },
  { v: 'jpn', t: '日本語 (jpn)' },
  { v: 'kor', t: '한국어 (kor)' },
  { v: 'nld', t: 'Nederlands (nld)' },
  { v: 'pol', t: 'Polski (pol)' },
  { v: 'por', t: 'Português (por)' },
  { v: 'rus', t: 'Русский (rus)' },
  { v: 'spa', t: 'Español (spa)' },
  { v: 'swa', t: 'Kiswahili (swa)' },
  { v: 'tur', t: 'Türkçe (tur)' },
  { v: 'ukr', t: 'Українська (ukr)' },
  { v: 'vie', t: 'Tiếng Việt (vie)' },
  { v: 'zho', t: '中文 (zho)' }
];

// Every option any form can show, described once: which control draws it, how
// it is read back out of the DOM, and how it becomes a request field. The
// server re-validates all of it — these bounds are about not sending obvious
// nonsense, never about being the check that matters.
//
//   control — number | text | check | select
//   kind    — how the value is coerced: int, num (fractional), bool, text
//   min     — below this the field means "use the engine's default", so it is
//             left out entirely rather than sent as 0
//   options — for selects: bare strings (label from an i18n key built off the
//             field name) or {v, t|k} rows carrying a literal label or a key
var CREATE_FIELDS = {
  max_pages: {
    id: 'create-max-pages', control: 'number', label: 'create_max_pages',
    kind: 'int', min: 1, max: 5000, ph: '200'
  },
  limit: {
    id: 'create-limit', control: 'number', label: 'create_video_limit',
    kind: 'int', min: 1, max: 500, ph: '25'
  },
  audio_only: {
    id: 'create-audio-only', control: 'check', label: 'create_audio_only',
    kind: 'bool', onchange: '_createSyncFormat()'
  },
  max_depth: {
    id: 'create-max-depth', control: 'number', label: 'create_max_depth',
    kind: 'int', min: 0, max: 10, ph: '5'
  },
  delay: {
    id: 'create-delay', control: 'number', label: 'create_delay',
    kind: 'num', min: 0, max: 60, step: '0.1', ph: '0.5'
  },
  max_bytes: {
    id: 'create-max-bytes', control: 'select', label: 'create_max_bytes',
    kind: 'text', options: CREATE_SIZE_OPTIONS
  },
  ignore_robots: {
    id: 'create-ignore-robots', control: 'check', label: 'create_ignore_robots',
    kind: 'bool', note: 'create_ignore_robots_note'
  },
  // Auto first, and the probe fills it in: the page you are capturing already
  // declares its language, so making someone recall an ISO 639-3 code was the
  // purest form of the shot in the dark.
  language: {
    id: 'create-language', control: 'select', label: 'create_language',
    kind: 'text', options: CREATE_LANGUAGE_OPTIONS
  },
  // Named presets only. The server accepts these four words and nothing else —
  // a yt-dlp format expression is a downloader instruction, and it stays on the
  // command line where the person typing it is already at a shell.
  format: {
    id: 'create-format', control: 'select', label: 'create_format',
    kind: 'text', options: ['720p', '1080p', '480p', 'best']
  },
  name: {
    id: 'create-name', control: 'text', label: 'create_name',
    kind: 'text', ph: 'my-archive'
  }
};

// Where another project does the actual work, its name goes on the surface that
// does it — the form you fill in and the pane you watch. Same shape as the
// footer's "Powered by Kiwix": a fact, quietly stated, and a link out.
var CREATE_CREDITS = {
  video: { name: 'yt-dlp', url: 'https://github.com/yt-dlp/yt-dlp' },
  'import': { name: 'warc2zim', url: 'https://github.com/openzim/warc2zim' }
};

// ── state ───────────────────────────────────────────────────────────────────
var _createSelected = null;   // mode id whose form is expanded, or null
var _createCursor = 0;        // lines consumed so far (server's cursor space)
var _createLines = [];        // the tail we are showing
var _createTimer = null;
var _createPollMs = CREATE_POLL_MS;
var _createStatus = null;     // last status payload
var _createOffline = false;
var _createImportReady = true;
var _createSubmitting = false;
// Whether the job the server is holding is OURS to show. The server keeps the
// last job around after it finishes, which is what lets a reopened page pick a
// running crawl back up — but it also means yesterday's finished job would
// otherwise greet you instead of the picker. An active job is adopted on sight;
// a finished one only stays on screen if this page put it there.
var _createAdopted = false;
var _createTilesKey = null;   // availability the tiles were last drawn from
// The last probe reply, and what it was a reply ABOUT. Keeping the source
// alongside it is what stops a preview of the previous folder sitting
// underneath the path you have since retyped.
var _createPreview = null;
var _createPreviewSource = '';
var _createProbing = false;
// The folder picker's current directory, or null when it is closed.
var _createBrowsePath = null;
var _createBrowseRows = null;

// ── pure logic (unit-tested in tests/test_create_ui.cjs) ─────────────────────

// A mode's availability, given what the server told us about itself. Offline is
// the interesting case: page/site/video genuinely cannot run, but an archive
// import only needs the network the FIRST time, to install its helper — so an
// offline machine with the helper already there keeps the tile live.
function _createModeAvailable(def, offline, importReady) {
  if (def.client) return true;   // nothing to fetch and nothing to install
  if (!offline) return true;
  if (def.network) return false;
  if (def.sidecar) return !!importReady;
  return true;
}

// Whether a mode's tile is shown to this viewer at all. A creator account
// (a signed-in user with the per-user create permission) gets the modes that
// capture the web plus bookmarks; folder and import read the SERVER'S disk,
// which the server refuses them (primary admin only) — so the tiles never
// appear rather than appearing and failing. Admin visibility is unchanged.
function _createModeVisible(def, creatorOnly) {
  if (!creatorOnly) return true;
  return def.id !== 'folder' && def.id !== 'import';
}

function _createDef(id) {
  for (var i = 0; i < CREATE_MODE_DEFS.length; i++) {
    if (CREATE_MODE_DEFS[i].id === id) return CREATE_MODE_DEFS[i];
  }
  return null;
}

// Every option a mode owns, in the order it is drawn: the visible flags first,
// then whatever the disclosure holds.
function _createModeFields(def) {
  return (def.flags || []).concat(def.advanced || []);
}

// One raw form value → what belongs in the request body, or undefined for
// "say nothing and let the engine use its own default". Blank, unparseable and
// below-minimum all collapse to that same silence: they are the same statement.
function _createFieldValue(key, fields) {
  var f = CREATE_FIELDS[key];
  if (!f) return undefined;
  var raw = fields ? fields[key] : undefined;
  if (f.kind === 'bool') return raw ? true : undefined;
  var text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return undefined;
  if (f.kind === 'int' || f.kind === 'num') {
    var n = f.kind === 'int' ? parseInt(text, 10) : parseFloat(text);
    if (!isFinite(n) || n < f.min) return undefined;
    return n;
  }
  return text;
}

// Form fields → request body. The server re-validates all of it; this is about
// sending exactly what a mode means and nothing it does not — a value left in
// the DOM by a form the user closed belongs to that form, not to this one.
function _createBuildRequest(modeId, fields) {
  var def = _createDef(modeId);
  if (!def || def.client) return null;
  var source = String((fields && fields.source) || '').trim();
  if (!source) return null;
  var body = { mode: def.id, source: source };
  var title = String((fields && fields.title) || '').trim();
  if (title) body.title = title;
  var keys = _createModeFields(def);
  for (var i = 0; i < keys.length; i++) {
    var value = _createFieldValue(keys[i], fields);
    if (value !== undefined) body[keys[i]] = value;
  }
  // Audio-only picks the format itself, so a quality preset alongside it would
  // describe a preference nothing reads. The server drops it too.
  if (body.audio_only) delete body.format;
  return body;
}

// A probe reply as the lines the preview shows, in reading order. Pure and
// table-driven so the .cjs test can hold every mode's shape: what the preview
// claims is the whole promise the page makes before a job runs, and a preview
// that says the wrong number is worse than no preview at all.
//
// Rows are {k, v}: an i18n KEY and an already-formatted value. The server sends
// counts and byte totals, never sentences, so nothing here needs translating at
// the far end.
function _createPreviewRows(p) {
  if (!p) return [];
  var rows = [];
  var add = function(k, v) { if (v !== undefined && v !== null && v !== '') rows.push({ k: k, v: String(v) }); };
  if (p.mode === 'folder') {
    add('create_pv_files', p.files + (p.files_capped ? '+' : ''));
    add('create_pv_size', _fmtBytes(p.bytes || 0));
    add('create_pv_main', p.main);
  } else if (p.mode === 'video') {
    add('create_pv_videos', p.videos + (p.videos >= CREATE_PROBE_CAP ? '+' : ''));
    add('create_pv_playlist', p.playlist);
    add('create_pv_channel', p.uploader);
  } else if (p.mode === 'import') {
    add('create_pv_size', _fmtBytes(p.bytes || 0));
    add('create_pv_helper', t(p.sidecar_ready ? 'create_pv_ready' : 'create_pv_installs'));
  } else {
    if (p.urls > 1) add('create_pv_pages', String(p.urls));
    add('create_pv_title', p.title);
    add(p.urls > 1 ? 'create_pv_first' : 'create_pv_address', p.final_url);
    add('create_pv_size', _fmtBytes(p.bytes || 0));
    if (p.robots_allowed !== undefined) {
      add('create_pv_robots', t(p.robots_allowed ? 'create_pv_robots_ok' : 'create_pv_robots_no'));
    }
  }
  if (p.language) add('create_pv_language', p.language + ' ' + t('create_pv_detected'));
  return rows;
}

// Fold a status reply into the tail we are showing. The server sends only what
// is new for our cursor and tells us where that leaves us, so a reply we have
// already seen (a retry, a duplicated poll) adds nothing — and a cursor that
// went backwards, which happens when a new job resets the counter, restarts the
// tail instead of interleaving two jobs' output.
function _createMergeLines(lines, cursor, payload) {
  var next = payload && typeof payload.cursor === 'number' ? payload.cursor : cursor;
  var fresh = (payload && payload.lines) || [];
  if (next < cursor) { lines = []; cursor = 0; }
  var merged = cursor === 0 && lines.length === 0 ? fresh.slice() : lines.concat(fresh);
  if (merged.length > CREATE_LOG_MAX) merged = merged.slice(merged.length - CREATE_LOG_MAX);
  return { lines: merged, cursor: Math.max(next, cursor) };
}

// ── the surface ─────────────────────────────────────────────────────────────

// ``replaceState`` true means this history entry IS Create — a cold load of
// /#create, where pushing would leave a phantom entry behind the page you
// landed on. False means Create is a step forward, so Back returns to where
// you came from.
function _openCreateInner(replaceState) {
  _createOpen = true;
  // The reload-into-Create boot gate (stamped by the head bootstrap before the
  // first paint) has done its job once the real Create chrome is up.
  document.documentElement.classList.remove('create-boot');
  var url = location.pathname + location.search + '#create';
  try {
    if (replaceState) history.replaceState({ mode: 'create' }, '', url);
    else history.pushState({ mode: 'create' }, '', url);
  } catch (e) {}
  document.getElementById('create-view').classList.add('open');
  var mv = document.getElementById('main-view');
  if (mv) mv.classList.add('hidden');
  _setWindowTitle(t('create_zim'));
  if (typeof updateTopbar === 'function') updateTopbar();
  _renderCreate();
  // First poll carries probe=1: it is the one call that pays for the sidecar
  // check, and it also picks up a job already running from another tab.
  _createPoll(true);
}

function closeCreate() {
  if (!_createOpen) return;
  _createOpen = false;
  _createStopPolling();
  document.getElementById('create-view').classList.remove('open');
  var mv = document.getElementById('main-view');
  if (mv) mv.classList.remove('hidden');
  _setWindowTitle('Zimi');
  // Shared with the pre-load shell in app.js so both paths strip the hash the
  // same way — a leftover #create would reopen this page on the next reload.
  if (typeof _dropCreateHash === 'function') _dropCreateHash();
  if (typeof updateTopbar === 'function') updateTopbar();
}

function _renderCreate() {
  var el = document.getElementById('create-content');
  if (!el) return;
  el.innerHTML =
    '<div class="create-inner">' +
      '<div class="create-head">' +
        '<div class="create-title">' + tH('create_zim') + '</div>' +
        '<div class="ms-pa-sub">' + tH('create_intro') + '</div>' +
      '</div>' +
      '<div id="create-picker">' +
        '<div class="create-tiles" id="create-tiles"></div>' +
      '</div>' +
      '<div id="create-run"></div>' +
    '</div>';
  _renderCreateTiles();
  _renderCreateForm();
}

// The tile list, with the open form spliced in directly beneath the tile it
// belongs to — a form that appears at the bottom of the list reads as a
// separate thing rather than as that tile opening up.
function _renderCreateTiles() {
  var host = document.getElementById('create-tiles');
  if (!host) return;
  _createTilesKey = _createAvailabilityKey();
  var creatorOnly = _createViewerIsCreator();
  var html = '';
  for (var i = 0; i < CREATE_MODE_DEFS.length; i++) {
    var def = CREATE_MODE_DEFS[i];
    if (!_createModeVisible(def, creatorOnly)) continue;
    var live = _createModeAvailable(def, _createOffline, _createImportReady);
    var desc = live
      ? tH('create_mode_' + def.id + '_desc')
      : tH(def.sidecar ? 'create_offline_sidecar_note' : 'create_offline_note');
    html +=
      '<button type="button" class="create-tile' +
        (_createSelected === def.id ? ' active' : '') + (live ? '' : ' disabled') + '"' +
        (live ? '' : ' disabled') +
        ' aria-pressed="' + (_createSelected === def.id ? 'true' : 'false') + '"' +
        ' onclick="_createSelectMode(\'' + def.id + '\')">' +
        '<span class="create-tile-glyph">' + _CREATE_ICONS[def.id] + '</span>' +
        '<span class="ms-pa-choice-body">' +
          '<span class="ms-pa-choice-title">' + tH('create_mode_' + def.id) + '</span>' +
          '<span class="ms-pa-choice-desc">' + desc + '</span>' +
        '</span>' +
      '</button>';
    if (_createSelected === def.id) html += '<div id="create-form-slot"></div>';
  }
  host.innerHTML = html;
}

// What the tiles are drawn FROM. Re-rendering them on every poll would wipe a
// half-typed form, so the run pane only redraws them when this changes.
function _createAvailabilityKey() {
  return (_createOffline ? '1' : '0') + (_createImportReady ? '1' : '0');
}

// True when the viewer is a signed-in creator account rather than an admin —
// feeds _createModeVisible. Reads app.js's session state defensively so the
// pure prefix of this file stays evaluable in the .cjs test sandbox.
function _createViewerIsCreator() {
  return !!(typeof _userSession !== 'undefined' && _userSession && _userSession.canCreate);
}

function _createSelectMode(id) {
  _createSelected = _createSelected === id ? null : id;
  // A preview describes one source under one mode. Neither survives the switch.
  _createPreview = null;
  _createPreviewSource = '';
  _createBrowsePath = null;
  _createBrowseRows = null;
  _renderCreateTiles();
  _renderCreateForm();
  var input = document.getElementById('create-source');
  if (input) input.focus();
}

// One option's control. Everything that varies between them — the element, the
// bounds, the placeholder — comes from CREATE_FIELDS, so a new option is a row
// in that table and nothing here changes.
function _createFieldHtml(key, def) {
  var f = CREATE_FIELDS[key];
  if (!f) return '';
  var label = tH(f.label);
  if (f.control === 'check') {
    return '<label class="create-flag">' +
      '<input type="checkbox" id="' + f.id + '"' +
      (f.onchange ? ' onchange="' + f.onchange + '"' : '') + '>' + label + '</label>';
  }
  if (f.control === 'select') {
    // Options are either bare strings, whose label is an i18n key built from
    // the field name (the original convention, kept for the video presets), or
    // {v, t|k} rows carrying a literal label or a key of their own. Language
    // and size names are literals on purpose: "Français" and "500 MB" read the
    // same in every UI language, and translating them would be inventing work.
    var opts = '';
    for (var i = 0; i < f.options.length; i++) {
      var o = f.options[i];
      var value = typeof o === 'string' ? o : o.v;
      var text = typeof o === 'string' ? tH(f.label + '_' + o) : (o.k ? tH(o.k) : esc(o.t));
      var pre = (def && def.pick && def.pick[key] === value) ? ' selected' : '';
      opts += '<option value="' + escAttr(value) + '"' + pre + '>' + text + '</option>';
    }
    return '<label class="create-flag">' + label +
      '<select class="create-field create-pick" id="' + f.id + '">' + opts + '</select></label>';
  }
  var ph = (def && def.hints && def.hints[key]) || f.ph || '';
  var number = f.control === 'number';
  return '<label class="create-flag">' + label +
    '<input type="' + (number ? 'number' : 'text') + '"' +
    ' class="create-field ' + (number ? 'create-num' : 'create-short') + '" id="' + f.id + '"' +
    (f.min !== undefined ? ' min="' + f.min + '"' : '') +
    (f.max !== undefined ? ' max="' + f.max + '"' : '') +
    (f.step ? ' step="' + f.step + '"' : '') +
    ' spellcheck="false" autocapitalize="none" autocorrect="off"' +
    ' placeholder="' + escAttr(ph) + '"></label>';
}

// A row of controls plus any warnings they carry. The notes sit under the row
// rather than in it: a sentence wrapped inside a flex row of short fields reads
// as a broken control, not as a caution.
function _createFieldsHtml(keys, def) {
  var controls = '';
  var notes = '';
  for (var i = 0; i < keys.length; i++) {
    controls += _createFieldHtml(keys[i], def);
    var f = CREATE_FIELDS[keys[i]];
    if (f && f.note) notes += '<div class="create-caption">' + tH(f.note) + '</div>';
  }
  return controls ? '<div class="create-flags">' + controls + '</div>' + notes : '';
}

// The credit line for a mode whose work is really another project's.
function _createCreditHtml(modeId) {
  var c = CREATE_CREDITS[modeId];
  if (!c) return '';
  return '<div class="create-caption create-credit">' + tH('powered_by') + ' ' +
    '<a href="' + escAttr(c.url) + '" target="_blank" rel="noopener">' + esc(c.name) + '</a>' +
    '</div>';
}

// ── the preview ─────────────────────────────────────────────────────────────

function _renderCreatePreview() {
  var host = document.getElementById('create-preview');
  if (!host) return;
  if (_createProbing) {
    host.innerHTML = '<div class="create-status"><span class="spinner-inline" aria-hidden="true"></span>' +
      '<span>' + tH('create_pv_looking') + '</span></div>';
    return;
  }
  var p = _createPreview;
  if (!p) { host.innerHTML = ''; return; }
  var rows = _createPreviewRows(p);
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    html += '<div class="create-pv-row"><span class="create-pv-k">' + tH(rows[i].k) +
      '</span><span class="create-pv-v">' + esc(rows[i].v) + '</span></div>';
  }
  // A warning is the whole point of looking first, so it sits above the facts
  // and keeps the engine's own sentence when there is one.
  var warn = '';
  if (p.warning_key || p.detail) {
    warn = '<div class="create-pv-warn">' +
      (p.warning_key ? tH(p.warning_key) : '') +
      (p.detail ? '<div class="create-pv-detail">' + esc(p.detail) + '</div>' : '') +
      '</div>';
  }
  host.innerHTML = '<div class="create-preview-box' + (p.ok ? '' : ' not-ok') + '">' +
    warn + html + '</div>';
}

// Ask the server what is actually there. Fired when the source stops changing,
// which is the moment the question becomes answerable.
async function _createProbeSource() {
  var fields = _createFormFields();
  var body = _createBuildRequest(_createSelected, fields);
  if (!body) { _createPreview = null; _createPreviewSource = ''; _renderCreatePreview(); return; }
  if (body.source === _createPreviewSource && _createPreview) return;  // already answered
  _createProbing = true;
  _createPreviewSource = body.source;
  _renderCreatePreview();
  try {
    var res = await authedFetch('/manage/create/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      // A refusal here is the same refusal the run would give, so it belongs
      // where the run's refusals go rather than in the preview box.
      _createPreview = null;
      _createFormError(data.error || t('create_error_generic'));
    } else {
      _createPreview = data;
      _createFormError('');
      _createApplyDetectedLanguage(data);
    }
  } catch (e) {
    _createPreview = null;
  } finally {
    _createProbing = false;
    _renderCreatePreview();
  }
}

// The payoff for detecting a language: put it in the control, but never over
// a choice the admin already made by hand.
function _createApplyDetectedLanguage(p) {
  if (!p || !p.language) return;
  var el = document.getElementById(CREATE_FIELDS.language.id);
  if (!el || el.value) return;
  for (var i = 0; i < el.options.length; i++) {
    if (el.options[i].value === p.language) { el.value = p.language; return; }
  }
}

// ── the folder picker ───────────────────────────────────────────────────────

function _createToggleBrowse() {
  if (_createBrowsePath !== null) {
    _createBrowsePath = null;
    _createBrowseRows = null;
    _renderCreateBrowse();
    return;
  }
  var src = document.getElementById('create-source');
  _createBrowseLoad((src && src.value.trim()) || '');
}

async function _createBrowseLoad(path) {
  try {
    var res = await authedFetch('/manage/create/browse?path=' + encodeURIComponent(path || ''));
    var data = await res.json();
    if (!res.ok) {
      // An unreadable or missing directory is not a dead end: fall back to
      // wherever the picker opens by default rather than closing on an error.
      if (path) { _createBrowseLoad(''); return; }
      _createFormError(data.error || t('create_error_generic'));
      return;
    }
    _createBrowsePath = data.path;
    _createBrowseRows = data;
    _renderCreateBrowse();
  } catch (e) {
    _createFormError(t('create_error_generic'));
  }
}

// Choosing a folder fills the field AND asks what is in it, because the two
// questions ("which folder" and "what is in it") are one question.
function _createBrowsePick() {
  var src = document.getElementById('create-source');
  if (src && _createBrowsePath) src.value = _createBrowsePath;
  _createBrowsePath = null;
  _createBrowseRows = null;
  _renderCreateBrowse();
  _createProbeSource();
}

function _renderCreateBrowse() {
  var host = document.getElementById('create-browse');
  if (!host) return;
  var d = _createBrowseRows;
  if (_createBrowsePath === null || !d) { host.innerHTML = ''; return; }
  var rows = '';
  if (d.parent) {
    rows += '<button type="button" class="create-dir up" onclick="_createBrowseLoad(' +
      "'" + escJs(d.parent) + "'" + ')">' + tH('create_browse_up') + '</button>';
  }
  for (var i = 0; i < d.entries.length; i++) {
    var child = d.path.replace(/\/$/, '') + '/' + d.entries[i];
    rows += '<button type="button" class="create-dir" onclick="_createBrowseLoad(' +
      "'" + escJs(child) + "'" + ')">' + esc(d.entries[i]) + '</button>';
  }
  if (!d.entries.length) rows += '<div class="create-caption">' + tH('create_browse_empty') + '</div>';
  host.innerHTML =
    '<div class="create-browse-box">' +
      '<div class="create-browse-head">' + esc(d.path) + '</div>' +
      '<div class="create-browse-list">' + rows + '</div>' +
      (d.truncated ? '<div class="create-caption">' + tH('create_browse_truncated') + '</div>' : '') +
      '<div class="create-actions">' +
        '<button type="button" class="ms-btn ms-btn-primary" onclick="_createBrowsePick()">' + tH('create_browse_use') + '</button>' +
        '<button type="button" class="ms-btn" onclick="_createToggleBrowse()">' + tH('cancel') + '</button>' +
      '</div>' +
    '</div>';
}

// The bookmarks form: a count and a handoff. There is already a folder-picking
// export selector in the bookmarks panel, and it is the right one — rebuilding a
// second, thinner version of it here would mean two places to fix the day the
// export grammar changes.
function _createBookmarksFormHtml() {
  var n = (typeof _bkLoad === 'function') ? _bkLoad().length : 0;
  return '<div class="create-form">' +
    '<div class="create-pv-row"><span class="create-pv-k">' + tH('create_pv_bookmarks') + '</span>' +
      '<span class="create-pv-v">' + esc(String(n)) + '</span></div>' +
    '<div class="create-caption">' + tH('create_bookmarks_note') + '</div>' +
    '<div class="create-actions">' +
      '<button type="button" class="ms-btn ms-btn-primary"' + (n ? '' : ' disabled') +
        ' onclick="_createOpenBookmarkExport()">' + tH('create_bookmarks_choose') + '</button>' +
    '</div>' +
  '</div>';
}

// Leave the Create page on the way through: the selector is a modal over the
// library, and stacking it over a full-page surface it knows nothing about is
// how you get two Escape handlers arguing.
function _createOpenBookmarkExport() {
  closeCreate();
  if (typeof _bmOpenExport === 'function') _bmOpenExport();
}

// The source control. Three shapes, one decision: a list of addresses needs
// room to be a list, a server path needs the picker beside it, everything else
// is one line.
function _createSourceControlHtml(def) {
  var attrs = ' class="create-field" id="create-source" spellcheck="false"' +
    ' autocapitalize="none" autocorrect="off" placeholder="' + escAttr(t(def.placeholder)) + '"';
  if (def.multiline) {
    return '<textarea rows="3"' + attrs + '></textarea>' +
      '<div class="create-caption">' + tH('create_pages_note') + '</div>';
  }
  if (def.browse) {
    return '<div class="create-source-row">' +
      '<input type="text"' + attrs + '>' +
      '<button type="button" class="ms-btn" onclick="_createToggleBrowse()">' + tH('create_browse') + '</button>' +
    '</div>';
  }
  return '<input type="text"' + attrs + '>';
}

function _renderCreateForm() {
  var slot = document.getElementById('create-form-slot');
  if (!slot) return;
  var def = _createDef(_createSelected);
  if (!def) { slot.innerHTML = ''; return; }
  if (def.client) { slot.innerHTML = _createBookmarksFormHtml(); return; }
  var advanced = _createFieldsHtml(def.advanced || [], def);
  slot.innerHTML =
    '<div class="create-form">' +
      '<label class="ms-form-label" for="create-source">' + tH(def.label) + '</label>' +
      _createSourceControlHtml(def) +
      '<div id="create-browse"></div>' +
      '<div id="create-preview"></div>' +
      '<label class="ms-form-label" for="create-title">' + tH('create_label_title') + '</label>' +
      '<input type="text" class="create-field" id="create-title" placeholder="' + escAttr(t('create_ph_title')) + '">' +
      _createFieldsHtml(def.flags || [], def) +
      (advanced
        ? '<details class="create-adv">' +
            '<summary>' + tH('create_advanced') + '</summary>' + advanced +
          '</details>'
        : '') +
      _createCreditHtml(def.id) +
      '<div class="create-actions">' +
        '<button type="button" class="ms-btn ms-btn-primary" id="create-start" onclick="_createSubmit()">' + tH('create_start') + '</button>' +
        '<span class="create-error" id="create-form-error"></span>' +
      '</div>' +
    '</div>';
  var src = document.getElementById('create-source');
  if (src) {
    src.addEventListener('keydown', function(e) {
      // In a list of addresses, Enter starts the next one.
      if (e.key === 'Enter' && !def.multiline) { e.preventDefault(); _createSubmit(); }
    });
    // 'change' rather than 'input': it fires when the value has settled and
    // focus leaves, which is exactly when the question "what is there?" becomes
    // answerable without probing every keystroke.
    src.addEventListener('change', function() { _createProbeSource(); });
  }
  _createSyncFormat();
  _renderCreatePreview();
  _renderCreateBrowse();
}

// Audio-only makes the quality preset moot. Greying it out says that where the
// admin is looking, instead of leaving a live-looking control that changes
// nothing about the job.
function _createSyncFormat() {
  var fmt = document.getElementById(CREATE_FIELDS.format.id);
  var audio = document.getElementById(CREATE_FIELDS.audio_only.id);
  if (fmt) fmt.disabled = !!(audio && audio.checked);
}

function _createFormFields() {
  var el = function(id) { return document.getElementById(id); };
  var fields = {
    source: (el('create-source') || {}).value || '',
    title: (el('create-title') || {}).value || ''
  };
  for (var key in CREATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(CREATE_FIELDS, key)) continue;
    var f = CREATE_FIELDS[key];
    var node = el(f.id);
    fields[key] = !node ? '' : (f.control === 'check' ? !!node.checked : node.value);
  }
  return fields;
}

function _createFormError(msg) {
  var el = document.getElementById('create-form-error');
  if (el) el.textContent = msg || '';
}

async function _createSubmit() {
  if (_createSubmitting) return;
  var body = _createBuildRequest(_createSelected, _createFormFields());
  if (!body) { _createFormError(t('create_needs_source')); return; }
  _createFormError('');
  _createSubmitting = true;
  var btn = document.getElementById('create-start');
  if (btn) btn.disabled = true;
  try {
    var res = await authedFetch('/manage/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      // The server's refusals name what the admin typed ("not a folder on this
      // server", "a ZIM is already being created") — show them as they are.
      _createFormError(data.error || t('create_error_generic'));
      return;
    }
    // A new job resets the tail; the merge helper also guards this server-side.
    _createLines = [];
    _createCursor = 0;
    _createAdopted = true;
    _createPollMs = CREATE_POLL_MS;
    _createPoll();
  } catch (e) {
    _createFormError(t('create_error_generic'));
  } finally {
    _createSubmitting = false;
    var b = document.getElementById('create-start');
    if (b) b.disabled = false;
  }
}

async function _createCancel() {
  var btn = document.getElementById('create-cancel-btn');
  if (btn) btn.disabled = true;
  try {
    await authedFetch('/manage/create/cancel', { method: 'POST' });
  } catch (e) {}
  _createPoll();
}

// Leave the finished job on screen behind us and go back to the picker.
function _createReset() {
  _createStatus = null;
  _createAdopted = false;
  _createLines = [];
  _createCursor = 0;
  _createSelected = null;
  _renderCreate();
}

async function _createOpenResult(name) {
  // The ZIM registered itself as it was written, but this client's cached list
  // predates it — refresh before navigating or the source view finds nothing.
  try {
    zimsCache = await _fetchList();
    _rebuildZimsMap();
  } catch (e) {}
  closeCreate();
  enterSource(name, true);
}

// ── polling ─────────────────────────────────────────────────────────────────

function _createStopPolling() {
  if (_createTimer) { clearTimeout(_createTimer); _createTimer = null; }
}

function _createSchedulePoll() {
  _createStopPolling();
  if (!_createOpen) return;
  _createTimer = setTimeout(function() { _createPoll(); }, _createPollMs);
}

async function _createPoll(probe) {
  _createStopPolling();
  if (!_createOpen) return;
  var url = '/manage/create/status?since=' + _createCursor + (probe ? '&probe=1' : '');
  try {
    var res = await authedFetch(url);
    if (!res.ok) {
      // 429 is the rate limiter, not a failure: back off and keep watching.
      _createPollMs = Math.min(_createPollMs * 2, CREATE_POLL_MAX_MS);
      _createSchedulePoll();
      return;
    }
    var data = await res.json();
    _createPollMs = CREATE_POLL_MS;
    _createOffline = !!data.offline;
    if (typeof data.import_ready === 'boolean') _createImportReady = data.import_ready;
    if (data.active) _createAdopted = true;
    var merged = _createMergeLines(_createLines, _createCursor, data);
    _createLines = merged.lines;
    _createCursor = merged.cursor;
    _createStatus = _createAdopted ? data : null;
    _renderCreateRun();
    if (data.active) _createSchedulePoll();
  } catch (e) {
    _createPollMs = Math.min(_createPollMs * 2, CREATE_POLL_MAX_MS);
    _createSchedulePoll();
  }
}

// ── running / done / failed ─────────────────────────────────────────────────

function _renderCreateRun() {
  var host = document.getElementById('create-run');
  var picker = document.getElementById('create-picker');
  if (!host) return;
  var s = _createStatus;
  // Nothing has ever run in this server's lifetime, or we reset: only the picker.
  if (!s || (!s.active && !s.done)) {
    host.innerHTML = '';
    if (picker) picker.hidden = false;
    // Only when the server changed its mind about what is possible — otherwise
    // the probe reply would erase a form the user is already typing into.
    if (_createTilesKey !== _createAvailabilityKey()) {
      _renderCreateTiles();
      _renderCreateForm();
    }
    return;
  }
  if (picker) picker.hidden = true;

  var head;
  if (s.active) {
    head =
      '<div class="create-status">' +
        '<span class="spinner-inline" aria-hidden="true"></span>' +
        '<span>' + tH(s.cancelling ? 'create_cancelling' : 'create_running') + '</span>' +
      '</div>';
  } else if (s.cancelled) {
    head = '<div class="create-status">' + tH('create_cancelled') + '</div>';
  } else if (s.ok) {
    head = '';
  } else {
    head =
      '<div class="create-status">' + tH('create_failed') + '</div>' +
      '<div class="create-error">' + esc(s.error || '') + '</div>';
  }

  var log = '';
  if (_createLines.length) {
    var body = '';
    for (var i = 0; i < _createLines.length; i++) {
      body += '<div class="create-log-line">' + esc(_createLines[i]) + '</div>';
    }
    log = '<div class="create-log" id="create-log">' + body + '</div>';
  } else if (s.active) {
    log = '<div class="create-log create-empty">' + tH('create_no_output') + '</div>';
  }

  var actions = '';
  if (s.active) {
    actions =
      '<div class="create-actions">' +
        (s.cancellable
          ? '<button type="button" class="ms-btn ms-btn-danger" id="create-cancel-btn"' +
            (s.cancelling ? ' disabled' : '') + ' onclick="_createCancel()">' +
            tH(s.cancelling ? 'create_cancelling' : 'create_cancel') + '</button>'
          : '<span class="create-caption">' + tH('create_uncancellable') + '</span>') +
      '</div>';
  } else {
    actions =
      '<div class="create-actions">' +
        '<button type="button" class="ms-btn" onclick="_createReset()">' + tH('create_another') + '</button>' +
      '</div>';
  }

  var done = '';
  if (s.done && s.ok && s.result && s.result.name) {
    done =
      '<div class="create-done">' +
        '<div class="ms-pa-choice-title">' + tH('create_done_title') + '</div>' +
        '<div class="create-done-name">' + esc(s.result.title || s.result.name) + '</div>' +
        (s.result.title && s.result.title !== s.result.name
          ? '<div class="create-caption">' + esc(s.result.name) + '.zim</div>' : '') +
        '<div class="create-actions">' +
          '<button type="button" class="ms-btn ms-btn-primary" onclick="_createOpenResult(\'' +
            escJs(s.result.name) + '\')">' + tH('create_open') + '</button>' +
        '</div>' +
      '</div>';
  }

  host.innerHTML = head + done + log + _createCreditHtml(s.mode) + actions;
  // Follow the tail. A user who has scrolled up to read an earlier line keeps
  // their place — only pin to the bottom when we were already there.
  var logEl = document.getElementById('create-log');
  if (logEl && s.active) logEl.scrollTop = logEl.scrollHeight;
}
