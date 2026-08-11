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

var _CREATE_ICONS = {
  folder: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  page: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>',
  site: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/></svg>',
  video: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><polygon points="10 9 15 12 10 15 10 9"/></svg>',
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
//   hints       — per-mode placeholder overrides, where one field's real
//                 default differs by engine (a crawl budget is not a video one)
var CREATE_MODE_DEFS = [
  {
    id: 'folder', network: false,
    label: 'create_label_folder', placeholder: 'create_ph_folder',
    flags: [], advanced: ['language']
  },
  {
    id: 'page', network: true,
    label: 'create_label_page_url', placeholder: 'create_ph_url',
    flags: [], advanced: ['language']
  },
  {
    id: 'site', network: true,
    label: 'create_label_site_url', placeholder: 'create_ph_url',
    flags: ['max_pages'],
    advanced: ['max_depth', 'max_bytes', 'delay', 'language', 'ignore_robots'],
    hints: { max_bytes: '512M' }
  },
  {
    id: 'video', network: true,
    label: 'create_label_video_url', placeholder: 'create_ph_video',
    flags: ['audio_only', 'limit'],
    advanced: ['format', 'max_bytes', 'language'],
    hints: { max_bytes: '4G' }
  },
  {
    id: 'import', network: false, sidecar: true,
    label: 'create_label_archive', placeholder: 'create_ph_archive',
    flags: [], advanced: ['name']
  }
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
    id: 'create-max-bytes', control: 'text', label: 'create_max_bytes',
    kind: 'text', ph: '500M'
  },
  ignore_robots: {
    id: 'create-ignore-robots', control: 'check', label: 'create_ignore_robots',
    kind: 'bool', note: 'create_ignore_robots_note'
  },
  language: {
    id: 'create-language', control: 'text', label: 'create_language',
    kind: 'text', ph: 'eng'
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

// ── pure logic (unit-tested in tests/test_create_ui.cjs) ─────────────────────

// A mode's availability, given what the server told us about itself. Offline is
// the interesting case: page/site/video genuinely cannot run, but an archive
// import only needs the network the FIRST time, to install its helper — so an
// offline machine with the helper already there keeps the tile live.
function _createModeAvailable(def, offline, importReady) {
  if (!offline) return true;
  if (def.network) return false;
  if (def.sidecar) return !!importReady;
  return true;
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
  if (!def) return null;
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

function _openCreateInner() {
  _createOpen = true;
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
  var html = '';
  for (var i = 0; i < CREATE_MODE_DEFS.length; i++) {
    var def = CREATE_MODE_DEFS[i];
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

function _createSelectMode(id) {
  _createSelected = _createSelected === id ? null : id;
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
    var opts = '';
    for (var i = 0; i < f.options.length; i++) {
      opts += '<option value="' + escAttr(f.options[i]) + '">' +
        tH(f.label + '_' + f.options[i]) + '</option>';
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

function _renderCreateForm() {
  var slot = document.getElementById('create-form-slot');
  if (!slot) return;
  var def = _createDef(_createSelected);
  if (!def) { slot.innerHTML = ''; return; }
  var advanced = _createFieldsHtml(def.advanced || [], def);
  slot.innerHTML =
    '<div class="create-form">' +
      '<label class="ms-form-label" for="create-source">' + tH(def.label) + '</label>' +
      '<input type="text" class="create-field" id="create-source" spellcheck="false" autocapitalize="none" autocorrect="off" placeholder="' + escAttr(t(def.placeholder)) + '">' +
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
      if (e.key === 'Enter') { e.preventDefault(); _createSubmit(); }
    });
  }
  _createSyncFormat();
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
