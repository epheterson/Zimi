// Create a ZIM — the web face of `zimi create` / `zimi import`.
//
// Lazy-loaded by openCreate() in app.js the first time an admin taps the +.
// Renders a full-page surface over the library (the Almanac's shape) and talks
// to three endpoints: POST /manage/create, GET /manage/create/status, and
// POST /manage/create/cancel.
//
// The whole design is one idea: pick what you are packaging, give it the one
// thing it needs, watch it run. Every mode has exactly one primary input and at
// most two flags; depth limits, byte budgets, media formats, language and
// description stay on the command line, and the caption says so rather than
// leaving people to guess. Fewer controls IS the feature — a form with fifteen
// fields would be easier to write and much worse to use.

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
// it needs to work, and which flags it offers. Tiles, forms and the request
// body are all derived from this — adding a mode means adding a row here.
//
//   network     — refuses to run when ZIMI_OFFLINE is set
//   sidecar     — needs the warc2zim helper (installed on first use, online)
//   flags       — the 2-3 knobs worth a form field; everything else is CLI-only
var CREATE_MODE_DEFS = [
  {
    id: 'folder', network: false,
    label: 'create_label_folder', placeholder: 'create_ph_folder', flags: []
  },
  {
    id: 'page', network: true,
    label: 'create_label_page_url', placeholder: 'create_ph_url', flags: []
  },
  {
    id: 'site', network: true,
    label: 'create_label_site_url', placeholder: 'create_ph_url',
    flags: ['max_pages']
  },
  {
    id: 'video', network: true,
    label: 'create_label_video_url', placeholder: 'create_ph_video',
    flags: ['audio_only', 'limit']
  },
  {
    id: 'import', network: false, sidecar: true,
    label: 'create_label_archive', placeholder: 'create_ph_archive', flags: []
  }
];

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

// Form fields → request body. The server re-validates all of it; this is about
// sending exactly what a mode means and nothing it does not.
function _createBuildRequest(modeId, fields) {
  var def = null;
  for (var i = 0; i < CREATE_MODE_DEFS.length; i++) {
    if (CREATE_MODE_DEFS[i].id === modeId) def = CREATE_MODE_DEFS[i];
  }
  if (!def) return null;
  var source = String((fields && fields.source) || '').trim();
  if (!source) return null;
  var body = { mode: def.id, source: source };
  var title = String((fields && fields.title) || '').trim();
  if (title) body.title = title;
  if (def.flags.indexOf('max_pages') >= 0) {
    var pages = parseInt(fields.max_pages, 10);
    if (pages > 0) body.max_pages = pages;
  }
  if (def.flags.indexOf('audio_only') >= 0 && fields.audio_only) {
    body.audio_only = true;
  }
  if (def.flags.indexOf('limit') >= 0) {
    var limit = parseInt(fields.limit, 10);
    if (limit > 0) body.limit = limit;
  }
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

function _createDef(id) {
  for (var i = 0; i < CREATE_MODE_DEFS.length; i++) {
    if (CREATE_MODE_DEFS[i].id === id) return CREATE_MODE_DEFS[i];
  }
  return null;
}

function _renderCreateForm() {
  var slot = document.getElementById('create-form-slot');
  if (!slot) return;
  var def = _createDef(_createSelected);
  if (!def) { slot.innerHTML = ''; return; }
  var flags = '';
  if (def.flags.indexOf('max_pages') >= 0) {
    flags +=
      '<label class="create-flag">' + tH('create_max_pages') +
        '<input type="number" class="create-field create-num" id="create-max-pages" min="1" max="5000" placeholder="200">' +
      '</label>';
  }
  if (def.flags.indexOf('audio_only') >= 0) {
    flags +=
      '<label class="create-flag">' +
        '<input type="checkbox" id="create-audio-only">' + tH('create_audio_only') +
      '</label>';
  }
  if (def.flags.indexOf('limit') >= 0) {
    flags +=
      '<label class="create-flag">' + tH('create_video_limit') +
        '<input type="number" class="create-field create-num" id="create-limit" min="1" max="500" placeholder="25">' +
      '</label>';
  }
  slot.innerHTML =
    '<div class="create-form">' +
      '<label class="ms-form-label" for="create-source">' + tH(def.label) + '</label>' +
      '<input type="text" class="create-field" id="create-source" spellcheck="false" autocapitalize="none" autocorrect="off" placeholder="' + escAttr(t(def.placeholder)) + '">' +
      '<label class="ms-form-label" for="create-title">' + tH('create_label_title') + '</label>' +
      '<input type="text" class="create-field" id="create-title" placeholder="' + escAttr(t('create_ph_title')) + '">' +
      (flags ? '<div class="create-flags">' + flags + '</div>' : '') +
      '<div class="create-caption">' + tH('create_advanced_note') + ' <code>zimi create --help</code></div>' +
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
}

function _createFormFields() {
  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function checked(id) { var el = document.getElementById(id); return !!(el && el.checked); }
  return {
    source: val('create-source'),
    title: val('create-title'),
    max_pages: val('create-max-pages'),
    limit: val('create-limit'),
    audio_only: checked('create-audio-only')
  };
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

  host.innerHTML = head + done + log + actions;
  // Follow the tail. A user who has scrolled up to read an earlier line keeps
  // their place — only pin to the bottom when we were already there.
  var logEl = document.getElementById('create-log');
  if (logEl && s.active) logEl.scrollTop = logEl.scrollHeight;
}
