// Create a ZIM — the web face of `zimi create` / `zimi import`.
//
// Lazy-loaded by openCreate() in app.js the first time an admin taps the +.
// Renders a full-page surface over the library (the Almanac's shape) and talks
// to four endpoints: POST /manage/create, GET /manage/create/status,
// POST /manage/create/probe and POST /manage/create/cancel.
//
// ROUND 3 — the shape of this page, and why.
//
// Round 2 gave every mode its own expanding form, and each of those forms
// carried its own Title field and its own Advanced disclosure. Six copies of
// the same two controls is not six choices, it is one control rendered six
// times, and the page read as a stack of near-identical sections. Worse, the
// Create button of an open form sat one row above the tile that opens the next
// one, so reaching for Create and landing on "Video" — which then wiped what
// you had typed — was a matter of a few pixels.
//
// So: ONE panel. The modes are a compact row of chips at the top; the panel
// below them carries the source field, the preview, Title, the flags and
// Advanced for whichever chip is lit. Switching chips swaps the panel's
// contents and NOTHING ELSE, and every mode keeps its own answers while you
// look at another one (_createModeState) — peeking at Video no longer costs you
// the URL you typed under Web page. Create is a full-width button at the very
// bottom of the panel, as far from the chips as the panel is tall.
//
// The second half of round 3 is watching the work. A crawl used to be a
// spinner and a log, which says "something is happening" and nothing else. The
// server now emits structured events beside its log lines, and this file turns
// them into the thing that is actually happening: a phase strip, a tree of
// pages that grows as they are discovered and fills as their assets land, and
// a counter that keeps moving through packaging — the phase that used to look
// like a hang. The log is still there, one click away, and it is still the
// truth; the visualization is the joy. A server that sends no events gets the
// log view exactly as before, with nothing broken and nothing to configure.

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
// Rows the tree will draw. A site crawl may legitimately reach five thousand
// pages; five thousand DOM subtrees on a phone is a frozen tab. Past this the
// pages keep being counted and the surplus collapses into one summary row, so
// the structure stays readable and the numbers stay true. The ceiling is well
// clear of any crawl a browser tab is a sensible place to watch.
var CREATE_TREE_MAX_NODES = 300;
// Recent jobs shown under the picker. The server bounds its own history; this
// is the client refusing to draw a wall of them if it ever stops.
var CREATE_RECENT_MAX = 10;
// How much of a source address the run header shows before cutting it. The
// full value stays on the element as a tooltip; see _createShortSource.
var CREATE_SOURCE_MAX = 56;

var _CREATE_ICONS = {
  page: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>',
  site: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/></svg>',
  video: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><polygon points="10 9 15 12 10 15 10 9"/></svg>',
  bookmarks: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>',
  'import': '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8"/><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M10 12h4"/></svg>',
  // The finished article. Bigger than the chip glyphs because it is the one
  // thing on the done card that is purely an image of what you just made.
  zim: '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2z"/><path d="M4 17.5A2 2 0 0 1 6 16h12"/><path d="M9 4v9l2.5-1.6L14 13V4"/></svg>'
};

// The one description of every mode: what it is called, what it asks for, what
// it needs to work, and which options it offers where. Chips, the panel and the
// request body are all derived from this — adding a mode means adding a row.
//
//   network     — refuses to run when ZIMI_OFFLINE is set
//   sidecar     — needs the warc2zim helper (installed on first use, online)
//   flags       — shown on the panel itself; two is the ceiling, on purpose
//   advanced    — shown inside the collapsed "Advanced" disclosure
//   hints       — per-mode placeholder overrides, for text and number fields
//   pick        — per-mode preselected option, for selects, where one field's
//                 real default differs by engine (a crawl budget is not a
//                 video one). A select has no placeholder, so a default it is
//                 meant to arrive with has to be a chosen option.
//   serverPath  — the source is somewhere on the SERVER'S disk rather than out
//                 on the web, which is why the server keeps it for the primary
//                 admin alone. A creator account never sees it. Import is the
//                 only one left: folder mode is CLI-only now ("do remove
//                 folder, I said that would be CLI only"), refused by the
//                 server and drawn nowhere here.
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
// articles you already chose; then import, which starts from something
// already sitting on the server — the rarest way in and the one you only
// reach deliberately.
var CREATE_MODE_DEFS = [
  {
    id: 'page', network: true, multiline: true,
    label: 'create_label_page_url', placeholder: 'create_ph_url',
    flags: ['engine'], advanced: ['block_ads', 'capture_variants', 'language']
  },
  {
    id: 'site', network: true,
    label: 'create_label_site_url', placeholder: 'create_ph_site_url',
    flags: ['engine', 'max_pages'],
    advanced: ['max_depth', 'max_bytes', 'delay', 'block_ads', 'capture_variants',
      'language', 'ignore_robots'],
    pick: { max_bytes: '500M' }
  },
  {
    id: 'video', network: true,
    label: 'create_label_video_url', placeholder: 'create_ph_video',
    flags: ['audio_only', 'limit'],
    advanced: ['format', 'max_bytes', 'language'],
    pick: { max_bytes: '4G' }
  },
  CREATE_BOOKMARKS_DEF
  // Import (WARC/WACZ) is CLI-only, like folder capture: it reads a server
  // path, and a web door onto the server's disk is exactly what the folder
  // retreat closed. `zimi import <file>` is its one door. No tile here.
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
  // The escape hatch. The server's parser has always taken any size text
  // ("2G", "750M", "512MiB") — only this list stood between the person and
  // the value they meant (Eric wanted 2GB; the list jumped 1G to 4G).
  { v: '__custom', k: 'create_size_custom' },
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
// The three ways to capture a web page, as the three ways they are. Not a
// select and not behind Advanced: which engine runs is the one choice that
// changes what the ZIM CONTAINS rather than how much of it there is, so it is
// on the panel, every answer visible, with the cost of each written under it.
//
// They are in order of what survives. Fast keeps the text. Rendered keeps the
// picture. Alive keeps the behaviour — and each step up costs an install and
// a wait, which is what the descriptions say.
//
// The empty value is the fast engine, so choosing it sends nothing and the
// server's own default is what runs — there is one place the default lives and
// it is not here. `needs` names a capability the server has to report before
// the option is live at all, and it is a key into CREATE_ENGINE_NEEDS rather
// than a boolean, because "what is missing" is what the caption has to say;
// see _createEngineHtml.
var CREATE_ENGINE_OPTIONS = [
  { v: '', k: 'create_engine_fast', d: 'create_engine_fast_desc' },
  {
    v: 'rendered', k: 'create_engine_rendered', d: 'create_engine_rendered_desc',
    needs: 'browser'
  },
  {
    v: 'alive', k: 'create_engine_alive', d: 'create_engine_alive_desc',
    needs: 'alive'
  }
];

// What each capability is MADE OF, as parts that install separately. The alive
// engine needs two of them and the caption has to name the one that is
// actually missing — a server that has the browser and not the sidecar should
// see one command, not both.
var CREATE_ENGINE_NEEDS = {
  browser: ['browser'],
  alive: ['browser', 'sidecar']
};
// The exact command that installs each part. Not translated — these are things
// you paste into a shell.
var CREATE_PART_INSTALL = {
  browser: "pip install 'zimi[browser]' && playwright install chromium",
  sidecar: 'zimi import --setup'
};

var CREATE_FIELDS = {
  engine: {
    id: 'create-engine', control: 'engine', label: 'create_engine',
    kind: 'text', options: CREATE_ENGINE_OPTIONS
  },
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
    kind: 'text', options: CREATE_SIZE_OPTIONS, customSize: true
  },
  ignore_robots: {
    id: 'create-ignore-robots', control: 'check', label: 'create_ignore_robots',
    kind: 'bool', note: 'create_ignore_robots_note'
  },
  // The only checkbox on this page that starts CHECKED, which is why it is a
  // kind of its own: every other one is off until you turn it on, so it can say
  // nothing when unticked and let the server default. This one has to be able
  // to say `false`, or unticking it would be a click that changed nothing.
  //
  // `needsEngine` is what keeps it honest: blocking is something a BROWSER does
  // to requests it is about to make, and the fast engine fetches only what the
  // page's own markup names. Under that engine the row is not drawn and the
  // field is not sent — see _createFieldApplies.
  block_ads: {
    id: 'create-block-ads', control: 'check', label: 'create_block_ads',
    kind: 'bool', on: true, needsEngine: ['rendered', 'alive'],
    note: 'create_block_ads_note'
  },
  // The responsive-image sweep, which is the second default-CHECKED box and
  // reads the same way as the first: silence means the row never drew, and an
  // explicit false means somebody unticked it.
  //
  // `needsEngine` is the RECORDING engine alone, and narrower than block_ads on
  // purpose. A browser asks for one image out of each srcset — the one that
  // suits the screen it has — so every other size is a request the replay will
  // make on a differently shaped screen and the archive cannot answer. Only the
  // alive engine keeps an archive to put them in; a rendered capture stores the
  // one picture it rendered and has nowhere for the rest. Drawing this under
  // the rendered engine would be a switch over nothing.
  capture_variants: {
    id: 'create-capture-variants', control: 'check', label: 'create_capture_variants',
    kind: 'bool', on: true, needsEngine: ['alive'],
    note: 'create_capture_variants_note'
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
  }
  // The `name` override belonged to import, which is CLI-only now
  // (`zimi import <file> --name ...`); no web mode reaches it.
};

// Where another project does the actual work, its name goes on the surface that
// does it — the form you fill in and the pane you watch. Same shape as the
// footer's "Powered by Kiwix": a fact, quietly stated, and a link out.
var CREATE_CREDITS = {
  video: { name: 'yt-dlp', url: 'https://github.com/yt-dlp/yt-dlp' },
  'import': { name: 'warc2zim', url: 'https://github.com/openzim/warc2zim' }
};

// ── the progress model ──────────────────────────────────────────────────────
//
// The server emits seven phases; the strip shows four steps. The fold is not
// laziness, it is what a person watching actually distinguishes: fetching a
// page and fetching that page's images are the same activity to everyone
// except the crawler, registering the finished file is the last half-second of
// packaging it, and packaging a ZIM and converting a recording into one are
// the same sentence — "it is writing the file now". Four steps that each
// visibly take time beat seven where three blink past.
var CREATE_PHASE_STEPS = {
  probe: 0, fetch: 1, assets: 1, 'package': 2, convert: 2, register: 3, done: 3
};
var CREATE_STEP_KEYS = [
  'create_step_discover', 'create_step_fetch', 'create_step_package', 'create_step_ready'
];
// Counters worth a headline, in reading order. Anything else the server counts
// is folded into the tree rather than given a number of its own.
var CREATE_COUNT_KEYS = ['entries', 'assets', 'bytes'];

// ── how much longer ─────────────────────────────────────────────────────────
//
// Eric, watching a crawl sit at 8/200: "Super slow can you see it? can we
// provide time estimates for any of these steps?" The pace is the politeness
// delay doing its job, but "8/200" alone makes a knowable wait feel like an
// unknowable one. So the client times itself: it already receives a running
// count on every poll, and a count against a clock is a rate.
//
// ONE estimator serves every phase and every engine, because the event stream
// has already flattened them into the same `entries` count — a crawl's captured
// pages, a write pass's written entries, a playlist's downloaded videos. Three
// special cases would be three copies of one division.
//
// What it will NOT do is hold still. An ETA that keeps displaying after the
// rate it was computed from has stopped existing is the worst thing on this
// page: it turns a stall into a promise. When the count stops arriving the
// estimate disappears, and the watchdog — which is the thing that actually
// knows — is left to say a job has died.

// Count samples the rate is averaged over. Short enough to follow a crawl that
// speeds up when it hits a fast section, long enough that one slow page does
// not swing the answer.
var CREATE_ETA_WINDOW = 8;
// A newest sample older than this means nothing is arriving any more, so there
// is no rate to divide by and the estimate goes away.
var CREATE_ETA_STALE_MS = 30000;
// Under this the window is too young to divide by: two samples a poll apart
// on a job that just started say almost nothing.
var CREATE_ETA_MIN_SPAN_MS = 4000;

// The rolling rate, and what it implies about what is left.
//
// `samples` are {t, n} in arrival order, `total` the denominator the server
// reported (or undefined). Returns {rate (per second), remaining, ms}, with
// `remaining` and `ms` null when the total is unknown — a rate is still worth
// showing, an invented finish line is not. Null when there is nothing
// defensible to say at all.
function _createEstimate(samples, total, now) {
  if (!samples || samples.length < 2) return null;
  var first = samples[0];
  var last = samples[samples.length - 1];
  if (now - last.t > CREATE_ETA_STALE_MS) return null;
  var span = last.t - first.t;
  var moved = last.n - first.n;
  if (span < CREATE_ETA_MIN_SPAN_MS || moved <= 0) return null;
  var rate = moved / (span / 1000);
  // A total the count has already passed is a total that meant something else
  // (a cap the crawl is about to stop at, a estimate the engine revised), and
  // subtracting from it would give a negative wait.
  if (typeof total !== 'number' || total <= last.n) {
    return { rate: rate, remaining: null, ms: null };
  }
  var remaining = total - last.n;
  return { rate: rate, remaining: remaining, ms: Math.round((remaining / rate) * 1000) };
}

// One sample per count that actually moved, and never two at one instant.
//
// Both rules are about the SPAN the rate is divided by. A repeated value
// carries no time information. And a poll that delivers four pages delivers
// them all at the same millisecond — recording four samples there would fill
// the window with one moment and leave the span at zero, which is exactly how
// this failed the first time it ran.
function _createPushSample(samples, n, now) {
  var last = samples[samples.length - 1];
  if (last && last.n === n) return samples;
  if (last && last.t === now) samples.pop();
  samples.push({ t: now, n: n });
  if (samples.length > CREATE_ETA_WINDOW) samples.splice(0, samples.length - CREATE_ETA_WINDOW);
  return samples;
}

// An estimate as the one short phrase it is allowed to be. Always hedged: the
// frontier of a crawl grows while it is being walked, so every number here is
// a reading of the present rate and not a commitment.
function _createEtaText(est) {
  if (!est) return '';
  if (est.ms === null) {
    // A pace slower than one a minute rounds to "0/min", which is a page
    // saying nothing is happening while something is. Better to say nothing.
    var perMinute = Math.round(est.rate * 60);
    return perMinute > 0 ? t('create_eta_rate', { n: perMinute }) : '';
  }
  if (est.ms < 60000) return t('create_eta_soon');
  var mins = Math.round(est.ms / 60000);
  if (mins < 60) return t('create_eta_min', { n: mins });
  return t('create_eta_hour', { h: Math.floor(mins / 60), m: mins % 60 });
}

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

// Whether a mode is offered to THIS viewer at all, which is a different
// question from whether it would work. One reason a mode is not on the page,
// and it is the server's rule drawn honestly: the viewer is a creator, not an
// admin — a creator account may capture the web and package its own
// bookmarks, but the mode that reads the SERVER'S disk (import) stays with
// the primary admin.
//
// Hidden rather than disabled: a greyed-out chip advertises a feature, and
// there is nothing here to advertise to someone who will never be allowed it.
// The server enforces the rule independently — this decides which door is
// drawn, never which door is locked.
function _createModeVisible(def, creatorOnly) {
  return !(def.serverPath && creatorOnly);
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

// Whether a field means anything under the engine currently chosen. A field
// with no `needsEngine` always does — which is all of them but one.
function _createFieldApplies(f, engine) {
  if (!f || !f.needsEngine) return true;
  return f.needsEngine.indexOf(String(engine || '')) >= 0;
}

// One raw form value → what belongs in the request body, or undefined for
// "say nothing and let the engine use its own default". Blank, unparseable and
// below-minimum all collapse to that same silence: they are the same statement.
function _createFieldValue(key, fields) {
  var f = CREATE_FIELDS[key];
  if (!f) return undefined;
  if (!_createFieldApplies(f, fields && fields.engine)) return undefined;
  var raw = fields ? fields[key] : undefined;
  // A checkbox that starts checked has to send both answers — its unticked
  // state is a decision, where an ordinary flag's is the absence of one. What
  // it must NOT do is send `false` for a control that was never drawn: an
  // unmounted field reads as '' here, and that is silence, not a refusal.
  if (f.kind === 'bool' && f.on) {
    return (raw === undefined || raw === null || raw === '') ? undefined : !!raw;
  }
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
// sending exactly what a mode means and nothing it does not — a value belonging
// to a mode the user merely looked at belongs to that mode, not to this one.
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
  // A count the probe could not take, rendered as nothing rather than as the
  // word "undefined". The guard in add() cannot do this on its own: `undefined
  // + ''` is the STRING "undefined", so any concatenation done before the
  // guard has already turned a missing number into a non-empty value that
  // sails straight through it. That is the whole of the "Videos undefined"
  // bug — a video probe on a server without yt-dlp sends no count.
  var countUpTo = function(n, cap) {
    return typeof n === 'number' && isFinite(n) ? n + (n >= cap ? '+' : '') : '';
  };
  if (p.mode === 'video') {
    add('create_pv_videos', countUpTo(p.videos, CREATE_PROBE_CAP));
    add('create_pv_playlist', p.playlist);
    add('create_pv_channel', p.uploader);
  } else if (p.mode === 'import') {
    add('create_pv_size', _fmtBytes(p.bytes || 0));
    add('create_pv_helper', t(p.sidecar_ready ? 'create_pv_ready' : 'create_pv_installs'));
  } else {
    if (p.urls > 1) add('create_pv_pages', String(p.urls));
    add('create_pv_title', p.title);
    add(p.urls > 1 ? 'create_pv_first' : 'create_pv_address', p.final_url);
    // NO size row, for a page either. The probe fetches the HTML and nothing
    // else, so `bytes` is the document's own weight — and on a modern page the
    // document is the small part. CNN's is 5.6MB against a 36MB ZIM: the
    // preview promised a sixth of what arrived, which is the worst kind of
    // wrong because it looks precise. Site mode already dropped this row for
    // exactly the same reason and page mode kept it out of habit.
    //
    // What IS known before a byte is fetched is how many files the page
    // references, and that is the honest expectation-setter: "392 files" tells
    // a person this is a big capture without pretending to know its size. The
    // live byte counter during the run is the only real number and it arrives
    // seconds later.
    // and no file count either. It replaced the size estimate and Eric read it
    // as the same promise in different units — fairly, because it is: 358
    // references counted in the markup against 413 entries written. Every
    // number this preview has ever shown about the OUTCOME has been wrong,
    // and the run's own counter is right seconds later. So the preview says
    // what it knows for certain — the title, the address, the language — and
    // stops guessing.
    if (p.robots_allowed !== undefined) {
      add('create_pv_robots', t(p.robots_allowed ? 'create_pv_robots_ok' : 'create_pv_robots_no'));
    }
  }
  if (p.language) add('create_pv_language', p.language + ' ' + t('create_pv_detected'));
  return rows;
}

// Text a one-line header can hold. Neither a URL with a long query nor a title
// somebody pasted has a natural end, and this page has no horizontal scroll to
// spare them; the full value goes on as a tooltip at the call site.
function _createClamp(text) {
  var out = String(text || '');
  return out.length > CREATE_SOURCE_MAX
    ? out.slice(0, CREATE_SOURCE_MAX - 1) + '…' : out;
}

// A source, as a header shows it: without the scheme, since every one of these
// is http and the eight characters buy nothing.
function _createShortSource(text) {
  return _createClamp(String(text || '').replace(/^https?:\/\//i, ''));
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

// The same cursor arithmetic for the event stream, with one addition: whether
// this server speaks events at all. A build that predates them sends neither
// field, and the answer to that is the log view exactly as it was — not an
// error, not an empty tree, and nothing in the console.
function _createMergeEvents(cursor, payload) {
  var supported = !!payload &&
    (typeof payload.event_cursor === 'number' || Array.isArray(payload.events));
  var next = payload && typeof payload.event_cursor === 'number'
    ? payload.event_cursor : cursor;
  var reset = next < cursor;
  if (reset) cursor = 0;
  return {
    supported: supported,
    reset: reset,
    events: (payload && payload.events) || [],
    cursor: Math.max(next, cursor)
  };
}

// Counters that ARRIVE in bursts and should not READ as bursts.
//
// The page polls every two seconds and applies everything that happened in
// between at once, so a crawl fetching twenty assets a second shows a number
// that sits still and then jumps by forty. The work was smooth; only the
// reporting was lumpy. (Eric: "counters roll in bursts, want smoother
// realtime.")
//
// So the DISPLAYED number walks toward the measured one instead of snapping to
// it. It only ever LAGS: every value shown was true at some moment, and the
// number on screen is never larger than the number the server last reported.
// That is the whole difference between smoothing a measurement and inventing
// one — a counter that extrapolated would print totals that had not happened
// yet, which is the kind of thing this release has spent its time removing.
//
// Time-based rather than per-frame, so a slow device sees the same pace as a
// fast one instead of a slower crawl.
var CREATE_COUNT_EASE_MS = 420;

function _createCountStep(shown, target, dt) {
  if (typeof target !== 'number') return shown;
  if (typeof shown !== 'number') return target;   // first sight: just be right
  // Never animate DOWNWARD. A counter only falls when a new job resets it, and
  // watching the last job's numbers count down into the new one is worse than
  // no animation at all.
  if (target <= shown) return target;
  var k = 1 - Math.exp(-Math.max(0, dt) / CREATE_COUNT_EASE_MS);
  var next = shown + (target - shown) * k;
  // Land exactly, and never stall: with an integer display, an approach that
  // only ever covers a fraction of a shrinking gap would creep for ever a
  // count short.
  if (target - next < 1) return target;
  return Math.max(next, shown + 1);
}

// The visualization's whole state, as data. Kept separate from the DOM so the
// renderer can be incremental — a tree that is rebuilt from scratch on every
// two-second poll would restart every animation and lose the scroll position of
// the person reading it.
function _createNewViz() {
  return {
    phase: '',        // the last phase the server named
    step: -1,         // furthest step reached, so a skipped phase strands nothing
    detail: '',       // the server's caption for that phase, if it sent one
    nodes: {},        // id → {id, parent, label, state, assets:{total,done}}
    order: [],        // node ids, in the order they were first seen
    roots: [],        // node ids with no parent
    holding: {},      // parent id → child ids waiting for that parent to arrive
    assets: {},       // asset id → its last state, so a repeat never double-counts
    counts: {},       // what → {n, total}
    samples: [],      // {t, n} for the entries count, newest last; see _createEstimate
    byPath: {},       // site path → the id of the page that claimed it
    pages: 0          // captured pages, for the "and N more" line
  };
}

function _createNewNode(ev) {
  return {
    id: ev.id, parent: ev.parent || '', label: ev.label || ev.id,
    state: ev.state || 'pending', assets: { total: 0, done: 0 }
  };
}

// Is an asset's state one it will not come back from? Only a final state
// advances a page's fill; "active" means the request is in flight.
function _createAssetFinal(state) {
  return state === 'done' || state === 'failed';
}

// Where a captured page hangs, when the engine did not say.
//
// The crawler reports which page it captured, never which page linked to it,
// and the server is right not to invent the second from the first — a
// discovery tree nobody measured would be a prettier lie than a flat list. So
// the tree branches on the one relationship that IS in the data: the site's own
// address space. `/docs/install` sits under `/docs` when `/docs` was captured
// too, and under the seed page otherwise. Every row is a page the crawl really
// fetched — there are no containers invented to make the picture prettier.
//
// A server-supplied `parent` always wins over this, so the day an engine does
// report parentage the renderer needs no changes at all.

// A node's address as a path, with the query and any trailing slash off, and ''
// for the site root — which is what a bare host (the seed page's label) and a
// video title both amount to.
function _createPathOf(label) {
  var text = String(label || '');
  if (text.indexOf('/') < 0) return '';   // a host, a playlist title: the root
  var cut = text.indexOf('?');
  if (cut >= 0) text = text.slice(0, cut);
  while (text.length > 1 && text.charAt(text.length - 1) === '/') {
    text = text.slice(0, -1);
  }
  return text === '/' ? '' : text;
}

// The deepest already-captured page this path sits inside, or '' for a row that
// belongs at the top level. Longest match wins, so a page lands as close to
// home as the crawl has actually been.
function _createParentByPath(viz, path) {
  if (!path) return '';
  var at = path.lastIndexOf('/');
  while (at > 0) {
    var ancestor = path.slice(0, at);
    if (viz.byPath[ancestor]) return viz.byPath[ancestor];
    at = ancestor.lastIndexOf('/');
  }
  return viz.byPath[''] || '';   // the seed page, when there is one
}


// Fold a batch of events into the view model, and report what moved so the DOM
// layer can touch only those rows.
//
// Every operation here is idempotent: a node re-sent with the same state is a
// no-op, a count is an absolute value rather than an increment, and the phase
// only ever moves forward. That is what lets the client tolerate a duplicated
// poll, a retried request and events arriving out of order without keeping a
// per-event ledger of what it has already applied.
function _createApplyEvents(viz, events) {
  // `touched` is the dedupe index behind `updated`. A five-thousand-page crawl
  // arriving in one batch is fifteen thousand asset events, and scanning a
  // growing array for each of them turns this into an O(n²) pass that visibly
  // stutters — measured at 673ms for that batch before this map, 19ms after.
  var changed = { phase: false, counts: false, added: [], updated: [], touched: {} };
  var list = events || [];
  var i;
  for (i = 0; i < list.length; i++) {
    var ev = list[i];
    if (!ev || !ev.t) continue;
    if (ev.t === 'phase') {
      // Fetching pages and writing them run at rates that have nothing to do
      // with each other, so the window starts again at a phase BOUNDARY —
      // when the phase actually changes, never merely when a phase event
      // arrives. A duplicated poll re-sends the one it already sent, and
      // throwing the window away for it would be a rate that never settles.
      if (viz.phase !== (ev.phase || '')) viz.samples = [];
      viz.phase = ev.phase || '';
      viz.detail = ev.detail || '';
      var step = _createPhaseStep(ev.phase);
      if (step > viz.step) viz.step = step;
      changed.phase = true;
    } else if (ev.t === 'count') {
      if (!ev.what) continue;
      viz.counts[ev.what] = { n: Number(ev.n) || 0, total: ev.total };
      changed.counts = true;
    } else if (ev.t === 'node') {
      _createApplyNode(viz, ev, changed);
    }
  }
  // The rate is timed in POLLS, not in events: a batch that carries four pages
  // carries them at one instant, so it is one reading of how far the job has
  // got and not four. Taken after the batch, so it is the newest count in it.
  if (changed.counts && viz.counts.entries) {
    _createPushSample(viz.samples, viz.counts.entries.n, Date.now());
  }
  // A child whose parent never showed up would otherwise wait forever. Events
  // that belong together arrive in one poll, so a parent later in the same
  // batch has already been caught above; anything still held at the end of the
  // batch is treated as a root, because showing it in the wrong place beats not
  // showing that the page was captured at all.
  for (var parentId in viz.holding) {
    if (!Object.prototype.hasOwnProperty.call(viz.holding, parentId)) continue;
    var held = viz.holding[parentId];
    for (i = 0; i < held.length; i++) {
      var node = viz.nodes[held[i]];
      if (!node) continue;
      node.parent = '';
      viz.roots.push(node.id);
      changed.added.push(node.id);
    }
    delete viz.holding[parentId];
  }
  return changed;
}

// One row to redraw, recorded once however many events touched it.
function _createMarkUpdated(changed, id) {
  if (changed.touched[id]) return;
  changed.touched[id] = 1;
  changed.updated.push(id);
}

// One node event. Pages become rows; assets fill the row of the page they were
// found on and are never rows themselves — a hundred stylesheet URLs is a log,
// not a picture. "entry" is reserved for the packaging side and ignored here.
function _createApplyNode(viz, ev, changed) {
  if (!ev.id) return;
  if (ev.kind === 'asset') {
    var owner = viz.nodes[ev.parent];
    var was = viz.assets[ev.id];
    viz.assets[ev.id] = ev.state || 'pending';
    if (!owner) return;
    if (was === undefined) owner.assets.total++;
    if (_createAssetFinal(ev.state) && !_createAssetFinal(was)) owner.assets.done++;
    _createMarkUpdated(changed, owner.id);
    return;
  }
  if (ev.kind && ev.kind !== 'page') return;
  var existing = viz.nodes[ev.id];
  if (existing) {
    // Omitted fields keep their previous value: the server re-sends an id to
    // move its state or to attach the title it did not have at discovery.
    if (ev.label) existing.label = ev.label;
    if (ev.state) existing.state = ev.state;
    _createMarkUpdated(changed, ev.id);
    return;
  }
  var node = _createNewNode(ev);
  viz.nodes[node.id] = node;
  viz.order.push(node.id);
  viz.pages++;
  // First claim on an address wins it: a redirect chain that lands two ids on
  // one path must not make the second the parent of the first's children.
  var path = _createPathOf(node.label);
  if (viz.byPath[path] === undefined) viz.byPath[path] = node.id;
  if (!node.parent) node.parent = _createParentByPath(viz, path);
  if (node.parent && !viz.nodes[node.parent]) {
    (viz.holding[node.parent] = viz.holding[node.parent] || []).push(node.id);
    return;   // held out of `added` so the DOM never has to insert under a
              // parent row that does not exist yet
  }
  if (!node.parent) viz.roots.push(node.id);
  changed.added.push(node.id);
  var waiting = viz.holding[node.id];
  if (waiting) {
    delete viz.holding[node.id];
    for (var i = 0; i < waiting.length; i++) changed.added.push(waiting[i]);
  }
}

// A server phase → the visible step it belongs to, or -1 for a phase name this
// client has never heard of. An unknown phase must not move the strip: a newer
// server inventing a seventh phase should leave the strip where it was rather
// than throwing it back to Discover.
function _createPhaseStep(phase) {
  var step = CREATE_PHASE_STEPS[phase];
  return step === undefined ? -1 : step;
}

// Which sentence a finished job gets. The server's journal already names its
// own state, so this mostly agrees with it; the fallback is for a record from
// a build that only recorded the booleans.
//
// Interrupted is deliberately NOT a failure: the job did not fail, the machine
// went away underneath it, and calling that a failure sends someone hunting for
// a bug in a URL that was fine.
function _createHistoryState(h) {
  if (!h) return '';
  // Answered first, because the fallbacks below read `ok` — and a job that has
  // not finished has ok:false for the plainest possible reason. Falling through
  // would call a running capture "failed" while it was still running. Nothing
  // does today (every render skips live rows first), and this is here so that
  // remains a property of the state machine rather than of one call site.
  if (_createHistoryLive(h)) return h.state;
  if (h.state && CREATE_HISTORY_KEYS[h.state]) return h.state;
  if (h.interrupted) return 'interrupted';
  if (h.cancelled) return 'cancelled';
  if (h.ok) return 'ok';
  return 'failed';
}

// A job the Recent list has nothing to say about yet: it is on screen right
// now, as the run pane or as a queue row.
function _createHistoryLive(h) {
  return !!h && (h.state === 'running' || h.state === 'queued');
}

// Most of these sentences already exist, because a finished job says the same
// thing an hour later as it did the moment it landed. Only the two ways a job
// can end without anyone deciding it should are new — nothing on this page
// could say either of them before.
var CREATE_HISTORY_KEYS = {
  ok: 'create_done_title',
  failed: 'create_failed',
  cancelled: 'create_cancelled',
  stalled: 'create_stalled',
  interrupted: 'create_hist_interrupted',
  // In the table but not normally on this list: a running job is the run pane's
  // to draw. Mapped so that a row which does reach the list has a true sentence
  // instead of a missing one. (`queued` is deliberately absent — its string
  // takes a queue position, which a plain row does not have; an unmapped state
  // renders no sentence, which is the honest thing to render.)
  running: 'create_running'
};

// What a history row is called. The admin's own title wins, then the ZIM's
// filename, then what was typed in, then the mode — a row reading only "Whole
// site" is still better than a row reading nothing.
function _createHistoryLabel(h) {
  if (!h) return '';
  return String(h.title || h.result || h.source ||
    (h.mode ? t('create_mode_' + h.mode) : '') || '');
}

// ── the job table, remembered ───────────────────────────────────────────────
//
// ONE table holds every job this browser has been told about, in whatever
// state it is in. A job that is running is a row like any other whose `state`
// happens to be `running`; which SURFACE draws a row — the run pane, the queue
// strip, the Recent list — follows from its state, and nothing has to keep two
// lists agreeing about the same job. (Eric: "Store the active job same as the
// history table and just different states.")
//
// The server has always modelled it this way: `_create_job_state` answers
// running/queued for a live job and its record goes in the same journal as the
// finished ones. It was this client that split them, dropping the live rows on
// arrival — so the table it kept could never answer "what was happening when I
// last looked", and the page had nothing to draw until a round trip came back.
//
// Remembering the table is what makes the page instant. A cached row is a HINT
// with no authority: the first poll's answer replaces the whole table, and a
// job that finished while the tab was closed simply reappears finished. That
// is why nothing here is gated on freshness — a stale row is not a wrong row,
// it is an old row about to be corrected, and the correction is one poll away.
var CREATE_JOBS_KEY = 'zimi_create_jobs';
// A little more than the Recent list shows, so the live rows the list filters
// out cannot push finished ones off the end of what is remembered.
var CREATE_JOBS_MAX = CREATE_RECENT_MAX + 4;

// Read defensively, exactly as _createCapsLoad does and for the same reason:
// this file's pure prefix is evaluated in the .cjs sandbox, where there is no
// localStorage at all, and an unreadable cache is simply no cache.
function _createJobsLoad() {
  try {
    var saved = JSON.parse(localStorage.getItem(CREATE_JOBS_KEY) || 'null');
    if (saved && Array.isArray(saved.jobs)) return saved.jobs;
  } catch (e) {}
  return [];
}

// Written when the table CHANGES, not on every poll. A running job polls every
// two seconds and its record carries a live phase, so writing unconditionally
// would put a synchronous disk write on that tick for the whole of a capture.
var _createJobsWritten = '';

function _createJobsSave(jobs) {
  var body;
  try {
    body = JSON.stringify({ v: 1, jobs: jobs });
  } catch (e) { return; }
  if (body === _createJobsWritten) return;
  _createJobsWritten = body;
  try {
    localStorage.setItem(CREATE_JOBS_KEY, body);
  } catch (e) {}
}

// The row the run pane should be drawing, if the table says one is running.
// Single slot by construction, so the first is the only.
function _createLiveRow(jobs) {
  for (var i = 0; i < (jobs || []).length; i++) {
    if (jobs[i] && jobs[i].state === 'running') return jobs[i];
  }
  return null;
}

// A remembered running row, dressed as the status payload the run pane reads.
// Only the identity fields are real — the header can be drawn from them, and
// the phase strip, counters and tree stay empty until the poll fills them.
// Nothing here invents progress: an empty strip that fills in is honest, a
// remembered percentage would not be.
function _createRowAsStatus(row) {
  return {
    id: row.id, mode: row.mode, source: row.source, title: row.title,
    phase: row.phase, active: true, done: false, fromCache: true
  };
}

// Is this status reply about a job that belongs to this page?
//
// The server holds ONE slot and a job stays in it after it finishes, until the
// next one takes the slot. So a poll made between "we submitted" and "our job
// starts" is answered with the PREVIOUS job — done, ok, result attached — and
// a page that had just started watching would adopt it, paint a stranger's
// completion screen over the capture its admin was waiting on, then flip back
// when their own job finally started. (Eric, mid-CNN: "it showed the old one
// your test I think the completion screen it was weird then back to progress
// on mine.")
//
// An ACTIVE job is ours whoever started it: picking a run up from another tab
// is the point of polling at all, and there is only ever one running. A
// FINISHED one is ours only if we were watching it — the job already on
// screen, or our own submission waiting its turn in the queue.
//
// A reply with no id at all is the server saying "no job", which every page is
// entitled to hear.
function _createForeignReply(data, jobId, queuedId) {
  if (!data || !data.id) return false;
  if (data.active || !data.done) return false;
  return data.id !== jobId && data.id !== queuedId;
}

// The table the server just sent, taken whole and remembered.
//
// Every row, live ones included. The poll used to drop running and queued jobs
// as they arrived, on the grounds that they are already on screen as the run
// pane or a queue row — true, and it is still true, which is why the Recent
// list skips them when it draws. But doing it HERE meant the table could not
// say "a job was running when you last looked", so it was not worth
// remembering, so the page had nothing to draw until the network answered.
// Deciding at render time instead costs one skip per row and buys the entire
// first paint.
function _createAdoptHistory(rows) {
  _createHistory = rows.slice(0, CREATE_JOBS_MAX);
  _createJobsSave(_createHistory);
}

// Draw what this browser was last told, before asking anything.
//
// Everything set here is provisional and all of it is replaceable by the first
// poll, which is why there is no freshness check: a remembered row that has
// since finished is not a wrong answer, it is last frame's answer, and the next
// frame is one round trip away. What it must NOT do is invent progress — the
// run pane gets identity only, so its phase strip and counters stay empty until
// the server says otherwise. A remembered percentage would be a lie shaped
// exactly like a fact.
function _createHydrate() {
  if (_createHistory.length || _createStatus) return;  // a live session wins
  var jobs = _createJobsLoad();
  if (!jobs.length) return;
  _createHistory = jobs;
  var live = _createLiveRow(jobs);
  if (!live) return;
  _createStatus = _createRowAsStatus(live);
  _createJobId = live.id || null;
  // NOT _createSawActive: that flag means "this tab watched a job run", and it
  // is what turns a job's disappearance into the "interrupted by a restart"
  // notice. A remembered row is not something this tab watched — so if the
  // server has no job, the page simply opens on the picker, which is the truth.
  _createAdopted = true;
}

// ── state ───────────────────────────────────────────────────────────────────
var _createSelected = null;   // the lit chip's mode id
var _createCursor = 0;        // log lines consumed so far (server's cursor space)
var _createLines = [];        // the tail we are showing
var _createLogCursor = 0;     // lines already IN the DOM, in that same space
var _createEventCursor = 0;   // events consumed so far
var _createEventsOk = false;  // this server speaks events
var _createViz = _createNewViz();
var _createVizChanges = null; // what the last merge moved, awaiting the DOM
var _createTimer = null;
var _createPollMs = CREATE_POLL_MS;
var _createStatus = null;     // last status payload
var _createOffline = false;
// ── what this server can do, and whether we have asked yet ──────────────────
//
// Probing a capability costs a subprocess, so it rides the page's first poll
// only. That used to mean every cold open drew the browser engines greyed with
// an install command underneath, then un-greyed them a fraction of a second
// later when the reply landed. Nothing had changed; the page had simply been
// guessing "not installed" out loud and then correcting itself.
//
// So a capability has THREE states, and the third is the whole fix: true,
// false, and null for "not asked yet". Only a KNOWN false greys an option.
// Null renders it plainly — no grey, no install command — so the answer
// arriving CONFIRMS the picture instead of redrawing it.
//
// Null is also only ever reachable on the very first visit, because the last
// answer this browser got is remembered: a server that genuinely lacks the
// browser settles into greyed once and stays there across reloads, rather than
// re-deriving itself every time the page opens. The remembered value is a
// hint, never an authority — the probe overwrites it on every open.
var CREATE_CAPS_KEY = 'zimi_create_caps';

// Read defensively: this file's pure prefix is evaluated in the .cjs test
// sandbox, where there is no localStorage at all. A ReferenceError inside the
// try is caught like any other, and an unreadable cache is simply no cache.
function _createCapsLoad() {
  try {
    var saved = JSON.parse(localStorage.getItem(CREATE_CAPS_KEY) || '{}');
    if (saved && typeof saved === 'object') return saved;
  } catch (e) {}
  return {};
}

var _createCaps = _createCapsLoad();

// A remembered capability, or null when this browser has never been told.
function _createCapBoot(name) {
  return typeof _createCaps[name] === 'boolean' ? _createCaps[name] : null;
}

// Record one answer, and write the cache only when the answer is news. A probe
// reply that agrees with what we already knew is the common case, and touching
// localStorage on every one of them would put a synchronous disk write on the
// two-second poll of a running job.
function _createRemember(name, value) {
  if (_createCaps[name] === value) return;
  _createCaps[name] = value;
  try {
    localStorage.setItem(CREATE_CAPS_KEY, JSON.stringify(_createCaps));
  } catch (e) {}
}

// Whether the server can convert an archive at all — the Import TILE's own
// question. Optimistic when unknown, because a tile that is there and then
// vanishes from under a click is worse than one that admits the job late.
// Once known, it is the known answer, so the tile stops vanishing entirely.
var _createImportReady = _createCapBoot('sidecar') !== false;
// Whether this server can run the rendered engine — the server's answer, or
// null until it gives one.
var _createBrowserReady = _createCapBoot('browser');
// Whether BOTH halves of the alive engine are here, as the server's own
// verdict — never inferred from the other two flags, because what the alive
// engine needs is the server's to decide and this client should not be the
// place that has to be updated when it changes.
var _createAliveReady = _createCapBoot('alive');
// Whether yt-dlp is installed on the server, as the server's own answer. The
// last capability to get one: without it the Video tile was offered
// unconditionally and the truth only arrived at probe time, as an error.
var _createVideoReady = _createCapBoot('video');
// The warc2zim sidecar alone. Not a third question to the server — it is
// `import_ready`, which the page already asks for, under the name that says
// what it means to an ENGINE rather than to the import mode. It exists so the
// missing-install caption can name the one command that is actually missing.
var _createSidecarReady = _createCapBoot('sidecar');
var _createHistory = [];
var _createWantHistory = false;
var _createJobId = null;      // the server's id for the job on screen
var _createQueue = [];
var _createQueuedId = null;   // our own submission, while it waits its turn
var _createSubmitting = false;
// Whether the job the server is holding is OURS to show. The server keeps the
// last job around after it finishes, which is what lets a reopened page pick a
// running crawl back up — but it also means yesterday's finished job would
// otherwise greet you instead of the picker. An active job is adopted on sight;
// a finished one only stays on screen if this page put it there.
var _createAdopted = false;
// The two halves of the restart story. We saw a job running; then the server
// said there is no job at all, which only happens when the process that was
// running it went away. That is a sentence, not a spinner.
var _createSawActive = false;
var _createInterrupted = false;
var _createTilesKey = null;   // availability the chips were last drawn from
// The last probe reply, and what it was a reply ABOUT. Keeping the source
// alongside it is what stops a preview of the previous folder sitting
// underneath the path you have since retyped.
var _createPreview = null;
var _createPreviewSource = '';
var _createProbing = false;
// Every mode's answers, kept while you look at another mode. Round 2 threw
// these away on every switch, which made the chips feel like a trapdoor: one
// curious click at "Video" and the address you had pasted under "Web page" was
// gone. Session-scoped on purpose — this is "do not lose my work mid-thought",
// not a draft that outlives the tab.
var _createModeState = {};
// Which run pane is mounted, and which job it belongs to. A new job rebuilds
// the pane; a poll on the same job updates it in place.
var _createRunKey = null;
var _createRunSeq = 0;
var _createIdleKey = null;
var _createTreeMounted = false;
var _createNodeEls = {};      // node id → its row element
var _createTreeShown = 0;
var _createTreeElided = 0;
var _createDoneMounted = false;

// Three judgements the surface below makes about what a number means. They sit
// up here, above the DOM, because each one was got wrong in a way no unit test
// could reach while it lived inside a render function — every one of them was
// found by a person looking at the screen.

// Which figure the done card shows for the file it just added. The card names
// the ZIM and says it is in the library, so the size beside that name has to
// be the size of the FILE — the same number the composition bar under it draws
// from, and the same one the library will show. It used to be bytes CARRIED,
// everything fetched on the way, which read 29.6 MB directly above a bar
// saying 29.9 MB for one file, and 6 MB apart on a site capture.
function _createDoneBytes(result, carriedFallback) {
  var shape = result && result.shape;
  var onDisk = shape && Number(shape.file_bytes);
  if (onDisk > 0) return onDisk;
  var stated = result && Number(result.bytes);
  if (stated > 0) return stated;
  return Number(carriedFallback) > 0 ? Number(carriedFallback) : 0;
}

// Whether a live counter is telling the truth in this mode. A crawl reports
// assets and bytes PER PAGE, starting over at each one, so they sawtooth —
// apple.com read 192 assets / 32.3 MB, then 146 / 9.2 MB — beside a pages
// counter that only climbs. There is no honest cumulative to show instead: the
// job's final totals are deduplicated across pages (821, where summing each
// page's final gives 850) and that is not known until the end. The per-page
// figure is already on screen and labelled, in the tree row it belongs to.
function _createMetricLive(what, mode, active) {
  if (!active || mode !== 'site') return true;
  return what !== 'assets' && what !== 'bytes';
}

// Whether a remembered row still has a ZIM behind it. Recent lives in this
// browser, the library lives on the server, and they part company the moment
// something is deleted anywhere. `known` is false only when the caller has a
// library list to check against — an unloaded list must never be read as an
// empty one, or a cold open declares every row dead.
function _createRowGone(job, known) {
  if (!job || !job.result || job.gone) return false;
  return !known;
}

// Copy this build introduces ahead of its i18n keys (the locale files belong
// to another change): t() falls back to the raw key, and a raw key on a
// button is worse than English. A translation added later wins automatically,
// because the key is still asked for first.
// "Stop early", not "Finish now": the button ends the crawl before its
// bounds, and calling that finishing reads as if the run were completing on
// its own terms (Eric: "it's not like finish finish it's like end early").
var CREATE_FALLBACK_TEXT = {
  create_finish_now: 'Stop early',
  create_finishing: 'Stopping…',
  create_stopped_early: 'Stopped early — this is everything captured up to the stop.',
  create_stopped_page_cap: 'Reached the {n}-page limit — a bigger limit captures more.',
  create_stopped_byte_budget: 'Reached the {size} size budget — everything up to it is here.',
  create_starting: 'Starting…'
};

function _createT(key) {
  var out = t(key);
  return out === key && CREATE_FALLBACK_TEXT[key] ? CREATE_FALLBACK_TEXT[key] : out;
}

// What ended a crawl, in the person's words. The server names the bound that
// ended it — "page cap (40)", "byte budget (500 MB)", "interrupted" — and the
// card used to say "Stopped early" for all three. Nobody stopped a crawl that
// reached the limit it was given; that one reached it (survey finding F10).
function _createStoppedText(stopped) {
  var why = String(stopped || '');
  if (!why) return '';
  var cap = why.match(/^page cap \((\d+)\)/);
  if (cap) return _createT('create_stopped_page_cap').replace('{n}', Number(cap[1]).toLocaleString());
  var budget = why.match(/^byte budget \((.+)\)/);
  if (budget) return _createT('create_stopped_byte_budget').replace('{size}', budget[1]);
  return _createT('create_stopped_early');
}

// What a live counter chip shows once the job is over. The bytes chip counts
// what was CARRIED while the run was on, which is the right number to watch
// climb and the wrong one to leave beside a finished file: "769 B size" next to
// a 498 KB result, "2.3 MB" beside a 573 KB one (survey findings F2, F9). At
// the end it becomes the file's own size, the number the card and the
// composition bar already agree on.
function _createChipTarget(what, n, s) {
  if (what === 'bytes' && s && s.done && !s.active && s.result) {
    return _createDoneBytes(s.result, n);
  }
  return n;
}

// Which engine a page wants, from what the probe saw. A page that builds
// itself in JavaScript comes out of the fast engine as an empty shell, and the
// probe already knows that; the person should not have to. Rendered when the
// server can run a browser, else Fast and the probe's own warning stands. The
// alive engine is never picked here: it is the one you reach for on purpose.
function _createEngineFor(p, browserReady) {
  if (!p || (p.mode !== 'page' && p.mode !== 'site')) return '';
  return p.spa && browserReady ? 'rendered' : '';
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
  // Opening Create is starting something, not returning to what finished.
  // A run that has ENDED is cleared here so the page opens on the form; a run
  // still going is left alone, because picking that up from another tab is
  // exactly what the poll below is for.
  _createForgetFinished();
  // What this browser was last told, drawn before anything is asked for. The
  // page used to open empty and stay empty for a round trip — on a NAS across
  // a LAN that is long enough to read as "nothing here", which is the wrong
  // answer when a capture is running (Eric: "The recently created and current
  // running one don't show fast on create page load but should be instant").
  // Ordered after _createForgetFinished on purpose: that clears out a run that
  // ENDED, and this puts back one that had not.
  _createHydrate();
  _renderCreate();
  // First poll carries probe=1 and history=1: the one call that pays for the
  // sidecar check and the recent list, and the one that picks up a job already
  // running from another tab. Its answer REPLACES everything hydrated above —
  // the cache is a first frame, never a source of truth.
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
      // No subtitle. Six self-describing tiles sit directly below this, and
      // the sentence that used to be here qualified the page into being wrong:
      // not your own content, not your own library.
      '<div class="create-head">' +
        '<div class="create-title">' + tH('create_zim') + '</div>' +
      '</div>' +
      // The feature is new in 1.9 and has met twenty-six sites; the web is
      // bigger. The release is final, the feature says it is a beta, and says
      // where to send a site that fails (Eric, 09-04: "the whole release
      // isn't beta, just that feature").
      '<div class="create-beta">' +
        '<span class="create-beta-tag">' + tH('create_beta_tag') + '</span>' +
        '<span class="create-beta-note">' + tH('create_beta_note') + ' ' +
          '<a href="' + escAttr(CREATE_ISSUES_URL) + '" target="_blank" rel="noopener">' +
            tH('create_report_site') + '</a></span>' +
      '</div>' +
      '<div id="create-picker" class="create-picker">' +
        // The address is the job, so it is the first field, and there is one
        // of it: the mode follows from the address (video is detected from
        // it; page-versus-site is a question about the address just typed),
        // so the chips sit under it as "what to make of this", not above it
        // as a decision taken blind (design review D2, 09-03).
        '<div class="create-address" id="create-address">' +
          '<label class="ms-form-label" for="create-source" id="create-address-label"></label>' +
          '<textarea rows="1" class="create-field" id="create-source" spellcheck="false"' +
            ' autocapitalize="none" autocorrect="off"></textarea>' +
          '<div class="create-caption" id="create-address-note" hidden></div>' +
        '</div>' +
        '<div class="create-modes" id="create-modes" role="tablist"' +
          ' aria-label="' + escAttr(t('create_zim')) + '"></div>' +
        '<div id="create-panel"></div>' +
      '</div>' +
      '<div id="create-queue"></div>' +
      '<div id="create-run"></div>' +
      '<div id="create-recent"></div>' +
    '</div>';
  _createWireAddress();
  _createRunKey = null;
  _createIdleKey = null;
  _renderCreateModes();
  _renderCreatePanel();
  // And whatever the table already says. These used to be reached only from
  // the poll, so the shell above was the whole of the first frame and the page
  // stood empty until the network answered — which was fine while the table
  // could only ever be empty at this point, and stopped being fine the moment
  // it could be remembered. Both are no-ops when there is nothing to draw.
  _renderCreateQueue();
  _renderCreateRun();
}

// The chips. Compact by design: a mode is a name and a glyph, and the sentence
// explaining it belongs to the panel of the mode you actually chose, not to
// five modes you did not. Six one-line descriptions stacked above the form was
// most of what made round 2 feel like a wall.
function _renderCreateModes() {
  var host = document.getElementById('create-modes');
  if (!host) return;
  _createTilesKey = _createAvailabilityKey();
  var visible = _createVisibleModes();
  // Whatever was lit may have stopped being a thing you can do. The chips are
  // drawn before the first poll answers, so the common case is exactly this:
  // the page opens on Web page, the server then says it is offline, and Web
  // page cannot run. Landing on the first mode that CAN run is the whole fix —
  // and nothing is lost, because each mode keeps its own answers.
  if (!_createSelected || !_createModeInList(visible, _createSelected) ||
      !_createModeAvailable(_createDef(_createSelected), _createOffline, _createImportReady)) {
    _createSelected = _createDefaultMode(visible);
  }
  var html = '';
  for (var i = 0; i < visible.length; i++) {
    var def = visible[i];
    var live = _createModeAvailable(def, _createOffline, _createImportReady);
    var on = _createSelected === def.id;
    // The reason a chip is dead is a whole sentence, and a chip has no room for
    // one. It goes where a sentence fits: the tooltip, and the panel below.
    var why = live ? '' :
      t(def.sidecar ? 'create_offline_sidecar_note' : 'create_offline_note');
    html +=
      '<button type="button" role="tab" class="create-chip' +
        (on ? ' active' : '') + (live ? '' : ' disabled') + '"' +
        (live ? '' : ' disabled title="' + escAttr(why) + '"') +
        ' aria-selected="' + (on ? 'true' : 'false') + '"' +
        ' onclick="_createSelectMode(\'' + def.id + '\')">' +
        '<span class="create-chip-glyph">' + _CREATE_ICONS[def.id] + '</span>' +
        '<span class="create-chip-name">' + tH('create_mode_' + def.id) + '</span>' +
      '</button>';
  }
  host.innerHTML = html;
}

function _createVisibleModes() {
  var creatorOnly = _createViewerIsCreator();
  var out = [];
  for (var i = 0; i < CREATE_MODE_DEFS.length; i++) {
    if (_createModeVisible(CREATE_MODE_DEFS[i], creatorOnly)) {
      out.push(CREATE_MODE_DEFS[i]);
    }
  }
  return out;
}

// True when the viewer is a signed-in creator account rather than an admin.
// app.js keeps _userSession null for admins and anonymous viewers, so a session
// that exists AND carries the create permission is exactly a creator. Read
// defensively: this file's pure prefix is evaluated in the .cjs test sandbox,
// where app.js does not exist.
function _createViewerIsCreator() {
  return !!(typeof _userSession !== 'undefined' && _userSession && _userSession.canCreate);
}

function _createModeInList(list, id) {
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return true;
  return false;
}

// The chip that is lit when the page opens. A picker with nothing picked is a
// panel with nothing in it, so something is always selected — the first mode
// that can actually run, which on an offline server is not "Web page".
function _createDefaultMode(list) {
  for (var i = 0; i < list.length; i++) {
    if (_createModeAvailable(list[i], _createOffline, _createImportReady)) return list[i].id;
  }
  return list.length ? list[0].id : null;
}

// What the chips are drawn FROM. Re-drawing them on every poll would mean
// re-drawing the panel underneath, so this only changes when the server changes
// its mind about what is possible.
// A capability's three states as one character, so "not asked yet" is distinct
// from "asked, and no". Collapsing them to a boolean here would re-introduce
// the flicker at the redraw layer even with the tri-state held correctly.
function _createCapChar(v) {
  return v === true ? '1' : v === false ? '0' : '?';
}

function _createAvailabilityKey() {
  return (_createOffline ? '1' : '0') + (_createImportReady ? '1' : '0') +
    _createCapChar(_createBrowserReady) + _createCapChar(_createAliveReady) +
    (_createViewerIsCreator() ? '1' : '0');
}

function _createSelectMode(id) {
  if (_createSelected === id) return;
  _createStashMode();
  _createSelected = id;
  _renderCreateModes();
  _renderCreatePanel();
  // The address is already there; what it means may have changed (a site
  // probe reads robots, a page probe does not). Ask again only when the
  // answer on file is not about this address in this mode.
  var def = _createDef(id);
  if (def && !def.client) _createProbeSource();
}

// ── per-mode state ──────────────────────────────────────────────────────────

function _createStateFor(id) {
  if (!_createModeState[id]) {
    _createModeState[id] = { values: {}, preview: null, previewSource: '' };
  }
  return _createModeState[id];
}

// Read the panel back into the mode that owns it. Only that mode's own fields:
// the DOM holds one panel at a time, so every other field reads as empty, and
// storing those emptiness would wipe what the other modes remember.
function _createStashMode() {
  var def = _createDef(_createSelected);
  if (!def || def.client) return;
  var state = _createStateFor(def.id);
  var title = document.getElementById('create-title');
  if (!title) return;   // the panel is not mounted; nothing to read
  // The address is not stashed: there is one, above the chips, and it
  // belongs to whatever you decide to make of it.
  state.title = title.value;
  var keys = _createModeFields(def);
  for (var i = 0; i < keys.length; i++) {
    var f = CREATE_FIELDS[keys[i]];
    var node = document.getElementById(f.id);
    if (!node) continue;
    state.values[keys[i]] = f.control === 'check' ? !!node.checked
      : f.control === 'engine' ? _createCheckedRadio(f.id)
      : node.value;
  }
  state.preview = _createPreview;
  state.previewSource = _createPreviewSource;
}

// Put a mode's answers back. A stored value is applied EXACTLY, including an
// empty one: having deliberately set the size budget back to "engine default"
// and finding 500 MB again on your return is the same broken promise as losing
// the URL. Nothing stored means the freshly rendered defaults stand.
function _createRestoreMode() {
  var def = _createDef(_createSelected);
  if (!def || def.client) return;
  var state = _createModeState[def.id];
  _createPreview = state ? (state.preview || null) : null;
  _createPreviewSource = state ? (state.previewSource || '') : '';
  if (!state) return;
  var title = document.getElementById('create-title');
  if (title && state.title !== undefined) title.value = state.title;
  for (var key in state.values) {
    if (!Object.prototype.hasOwnProperty.call(state.values, key)) continue;
    var f = CREATE_FIELDS[key];
    var node = f && document.getElementById(f.id);
    if (!node) continue;
    if (f.control === 'check') node.checked = !!state.values[key];
    else if (f.control === 'engine') _createSetRadio(f.id, state.values[key]);
    else node.value = state.values[key];
  }
}

// ── the panel ───────────────────────────────────────────────────────────────

// One option's control. Everything that varies between them — the element, the
// bounds, the placeholder — comes from CREATE_FIELDS, so a new option is a row
// in that table and nothing here changes.
function _createFieldHtml(key, def) {
  var f = CREATE_FIELDS[key];
  if (!f) return '';
  var label = tH(f.label);
  if (f.control === 'engine') return _createEngineHtml(f);
  if (f.control === 'check') {
    // The row carries an id of its own so a field that only applies to some
    // engines can be hidden whole — label and all — rather than left as a
    // dangling word beside a checkbox that went away.
    return '<label class="create-flag" id="' + f.id + '-row">' +
      '<input type="checkbox" id="' + f.id + '"' + (f.on ? ' checked' : '') +
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
    // A select that carries the custom-size hatch grows a free-entry box that
    // shows only while "Custom…" is chosen. The value crosses in the same
    // field; the server's size parser is the single grammar.
    var extra = f.customSize
      ? '<input type="text" class="create-field create-short" id="' + f.id + '-custom"' +
        ' hidden placeholder="2G" spellcheck="false" autocapitalize="none" autocorrect="off"' +
        ' aria-label="' + escAttr(tH('create_size_custom')) + '">'
      : '';
    var change = f.customSize ? ' onchange="_createSizeSelect(this)"' : '';
    return '<label class="create-flag">' + label +
      '<select class="create-field create-pick" id="' + f.id + '"' + change + '>' + opts + '</select></label>' + extra;
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

// Whether the server has reported a capability as usable. The server's own
// verdict where it has one — what the alive engine needs is the server's
// business, not something this client should be re-deriving from parts.
// Tri-state: true, false, or null for "the server has not said yet".
function _createCapabilityReady(name) {
  return name === 'alive' ? _createAliveReady : _createBrowserReady;
}

// Whether one PART of a capability is installed. Only ever used to decide
// which install command the caption prints; never to enable an option.
function _createPartReady(part) {
  return part === 'sidecar' ? _createSidecarReady : _createBrowserReady;
}

// Whether to grey an option out. KNOWN missing only — an unanswered probe is
// not a refusal, and rendering it as one is what made the picker flicker.
function _createCapabilityMissing(name) {
  return _createCapabilityReady(name) === false;
}

// The engine picker: the radios drawn as one control, each with the sentence
// that tells you which one you want. It takes the full width of the flags row
// on purpose — it is a choice with consequences, not a checkbox.
//
// An option whose capability the server does not have is DISABLED rather than
// hidden, and this is the one place on the page where that is right: these are
// things Zimi does, they are simply not installed here, and the fix is the
// command the caption prints. Hiding them would leave someone believing Zimi
// cannot do this at all.
function _createEngineHtml(f) {
  // Folded: the probe picks the engine (see _createAutoPickEngine), and the
  // summary states the pick. The three options, thirty words each, used to be
  // the largest thing on the form, on a decision most people cannot make.
  var html = '<details class="create-seg-field create-engine-fold" id="create-engine-fold">' +
    '<summary class="create-seg-label"><span>' + tH(f.label) + '</span> ' +
      '<b id="create-engine-pick">' + tH(f.options[0].k) + '</b> ' +
      '<span class="create-engine-change">' + tH('create_engine_change') + '</span></summary>' +
    '<div class="create-seg" id="' + f.id + '" role="radiogroup"' +
    ' aria-label="' + escAttr(t(f.label)) + '">';
  var commands = [];
  for (var i = 0; i < f.options.length; i++) {
    var o = f.options[i];
    var off = !!o.needs && _createCapabilityMissing(o.needs);
    if (off) _createAddCommands(commands, o.needs);
    html += '<label class="create-seg-opt' + (off ? ' is-off' : '') + '">' +
      '<input type="radio" name="' + f.id + '" value="' + escAttr(o.v) + '"' +
      (i === 0 ? ' checked' : '') + (off ? ' disabled' : '') +
      ' onchange="_createEngineChosen()">' +
      '<span class="create-seg-name">' + tH(o.k) + '</span>' +
      '<span class="create-seg-desc">' + tH(o.d) + '</span>' +
    '</label>';
  }
  html += '</div>';
  if (commands.length) {
    var code = '';
    for (var c = 0; c < commands.length; c++) {
      code += ' <code>' + esc(commands[c]) + '</code>';
    }
    html += '<div class="create-caption">' + tH('create_engine_missing') + code + '</div>';
  }
  return html + '</details>';
}

// Append one unmet capability's install commands to the caption's list: the
// parts it is KNOWN to be missing, minus anything another option already asked
// for — the browser is missing for two of the three engines and printing its
// command twice would read as a stutter.
//
// A part the server has not reported on prints nothing. This function only
// runs for an option that is already greyed on a known-false capability, so
// the caption can still come out empty — a capability whose own flag is false
// while its parts are unreported. An install line that names no command is
// better than one that names a command the server never asked for.
function _createAddCommands(into, capability) {
  var parts = CREATE_ENGINE_NEEDS[capability] || [];
  for (var i = 0; i < parts.length; i++) {
    var cmd = CREATE_PART_INSTALL[parts[i]];
    if (cmd && _createPartReady(parts[i]) === false && into.indexOf(cmd) < 0) into.push(cmd);
  }
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
    if (f && f.note) {
      notes += '<div class="create-caption" id="' + f.id + '-note">' +
        tH(f.note) + '</div>';
    }
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

// The one address field, wired once when the page mounts. It outlives every
// mode switch: what you typed is what you are making a ZIM of, whichever
// way you decide to make it.
function _createWireAddress() {
  var src = document.getElementById('create-source');
  if (!src) return;
  src.addEventListener('keydown', function(e) {
    // In a list of addresses, Enter starts the next one; anywhere else it
    // starts the job.
    var def = _createDef(_createSelected);
    if (e.key === 'Enter' && !(def && def.multiline)) { e.preventDefault(); _createSubmit(); }
  });
  // 'change' rather than 'input': it fires when the value has settled and
  // focus leaves, which is exactly when the question "what is there?" becomes
  // answerable without probing every keystroke.
  src.addEventListener('change', function() {
    // Typing a new address over a finished run means "make THAT one" — the
    // done card for the last capture must not sit there looking like the
    // answer to it (Eric: typing apple.com after CNN "reloaded the completed
    // page for the last one").
    _createClearFinished();
    _createProbeSource();
  });
}

// The address field dressed for the mode that is lit: its label, its
// placeholder, room for a list when the mode takes one. The value is never
// touched here. A mode with no address (bookmarks) hides the field.
function _renderCreateAddress() {
  var wrap = document.getElementById('create-address');
  var src = document.getElementById('create-source');
  var label = document.getElementById('create-address-label');
  var note = document.getElementById('create-address-note');
  if (!wrap || !src) return;
  var def = _createDef(_createSelected);
  var takesAddress = !!(def && !def.client);
  wrap.hidden = !takesAddress;
  if (!takesAddress) return;
  if (label) label.textContent = t(def.label);
  src.placeholder = t(def.placeholder);
  src.rows = def.multiline ? 3 : 1;
  if (note) { note.textContent = def.multiline ? t('create_pages_note') : ''; note.hidden = !def.multiline; }
}

// The one panel. Everything the selected mode needs, once, in the order you
// answer it: what am I packaging, what did the server find, what shall it be
// called, the two flags that matter, everything else behind a disclosure — and
// then, alone at the bottom with nothing beside it to misclick, Create.
function _renderCreatePanel() {
  var host = document.getElementById('create-panel');
  if (!host) return;
  var def = _createDef(_createSelected);
  if (!def) { host.innerHTML = ''; return; }
  var live = _createModeAvailable(def, _createOffline, _createImportReady);
  var desc = '<div class="create-panel-desc">' + tH('create_mode_' + def.id + '_desc') + '</div>';
  _renderCreateAddress();
  if (!live) {
    host.innerHTML = '<div class="create-panel">' + desc +
      '<div class="create-panel-blocked">' +
        tH(def.sidecar ? 'create_offline_sidecar_note' : 'create_offline_note') +
      '</div></div>';
    return;
  }
  if (def.client) { host.innerHTML = '<div class="create-panel">' + desc + _createBookmarksBodyHtml() + '</div>'; return; }
  var advanced = _createFieldsHtml(def.advanced || [], def);
  host.innerHTML =
    '<div class="create-panel">' +
      desc +
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
      '<div class="create-go">' +
        '<button type="button" class="ms-btn ms-btn-primary create-go-btn" id="create-start"' +
          ' onclick="_createSubmit()">' + tH('create_start') + '</button>' +
        '<div class="create-error" id="create-form-error"></div>' +
      '</div>' +
    '</div>';
  _createRestoreMode();
  _createSyncFormat();
  _createSyncEngine();
  _renderCreatePreview();
}

// The bookmarks panel: a count and a handoff. There is already a folder-picking
// export selector in the bookmarks panel, and it is the right one — rebuilding a
// second, thinner version of it here would mean two places to fix the day the
// export grammar changes.
function _createBookmarksBodyHtml() {
  var n = (typeof _bkLoad === 'function') ? _bkLoad().length : 0;
  return '<div class="create-pv-row"><span class="create-pv-k">' + tH('create_pv_bookmarks') + '</span>' +
      '<span class="create-pv-v">' + esc(String(n)) + '</span></div>' +
    '<div class="create-caption">' + tH('create_bookmarks_note') + '</div>' +
    '<div class="create-go">' +
      '<button type="button" class="ms-btn ms-btn-primary create-go-btn"' +
        ' onclick="_createOpenBookmarkExport()">' + tH('create_bookmarks_choose') + '</button>' +
    '</div>';
}

// Leave the Create page on the way through: the selector is a modal over the
// library, and stacking it over a full-page surface it knows nothing about is
// how you get two Escape handlers arguing.
function _createOpenBookmarkExport() {
  closeCreate();
  if (typeof _bmOpenExport === 'function') _bmOpenExport();
}

// Audio-only makes the quality preset moot. Greying it out says that where the
// admin is looking, instead of leaving a live-looking control that changes
// nothing about the job.
function _createSyncFormat() {
  var fmt = document.getElementById(CREATE_FIELDS.format.id);
  var audio = document.getElementById(CREATE_FIELDS.audio_only.id);
  if (fmt) fmt.disabled = !!(audio && audio.checked);
}

// Options that belong to one engine appear when that engine is chosen and are
// gone otherwise — HIDDEN rather than disabled, which is the opposite of what
// the engine picker itself does, and deliberately. A disabled engine is a thing
// Zimi does that this machine has not installed, and saying so is useful. Ad
// blocking under the fast engine is not installable; it is not a thing at all,
// and a permanently greyed control would only invite the question.
// Whether the person has picked an engine by hand this time. Until they do,
// the probe's answer picks it (D1 of the design review); once they have, it
// is theirs and the probe keeps its opinion to the preview.
var _createEngineTouched = false;
var _createAutoProbing = false;

function _createAutoPickEngine(p) {
  if (_createEngineTouched || _createAutoProbing) return false;
  var want = _createEngineFor(p, _createCapabilityReady('browser') === true);
  var have = _createCheckedRadio(CREATE_FIELDS.engine.id);
  if (want === have) return false;
  var input = document.querySelector('input[name="' + CREATE_FIELDS.engine.id + '"][value="' + want + '"]');
  if (!input || input.disabled) return false;
  input.checked = true;
  _createSyncEngine();
  // The verdict is the engine's: ask again with the one that will run, so the
  // preview says "the rendered engine is what will capture it" rather than
  // the fast engine's refusal.
  _createAutoProbing = true;
  _createPreviewSource = '';
  _createProbeSource().finally(function() { _createAutoProbing = false; });
  return true;
}

function _createEngineChosen() {
  _createEngineTouched = true;
  _createSyncEngine();
}

function _createSyncEngineSummary(engine) {
  var pick = document.getElementById('create-engine-pick');
  if (!pick) return;
  var opt = null;
  for (var i = 0; i < CREATE_ENGINE_OPTIONS.length; i++) {
    if (CREATE_ENGINE_OPTIONS[i].v === engine) opt = CREATE_ENGINE_OPTIONS[i];
  }
  var text = opt ? t(opt.k) : '';
  if (pick.textContent !== text) pick.textContent = text;
}

function _createSyncEngine() {
  _createSyncEngineSummary(_createCheckedRadio(CREATE_FIELDS.engine.id));
  var engine = _createCheckedRadio(CREATE_FIELDS.engine.id);
  for (var key in CREATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(CREATE_FIELDS, key)) continue;
    var f = CREATE_FIELDS[key];
    if (!f.needsEngine) continue;
    var applies = _createFieldApplies(f, engine);
    var parts = [f.id + '-row', f.id + '-note'];
    for (var i = 0; i < parts.length; i++) {
      var node = document.getElementById(parts[i]);
      if (node) node.hidden = !applies;
    }
  }
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
    fields[key] = !node ? ''
      : f.control === 'check' ? !!node.checked
      : f.control === 'engine' ? _createCheckedRadio(f.id)
      : f.customSize && node.value === '__custom'
        ? ((document.getElementById(f.id + '-custom') || {}).value || '').trim()
      : node.value;
  }
  return fields;
}

// Reveal the free-entry size box only while its select says Custom…; focus
// it on reveal so choosing Custom is one gesture, not two.
function _createSizeSelect(sel) {
  var box = document.getElementById(sel.id + '-custom');
  if (!box) return;
  var custom = sel.value === '__custom';
  box.hidden = !custom;
  if (custom) box.focus();
}

// A radio group has no value of its own — the checked input has it.
function _createCheckedRadio(name) {
  var hit = document.querySelector('input[name="' + name + '"]:checked');
  return hit ? hit.value : '';
}

// Restoring a radio group. A stored choice the server can no longer honour —
// "rendered" on a machine whose browser has since gone — leaves the default
// checked rather than checking a disabled option nothing would run.
function _createSetRadio(name, value) {
  var opts = document.querySelectorAll('input[name="' + name + '"]');
  for (var i = 0; i < opts.length; i++) {
    if (opts[i].value === value && !opts[i].disabled) { opts[i].checked = true; return; }
  }
}

function _createFormError(msg) {
  var el = document.getElementById('create-form-error');
  if (el) el.textContent = msg || '';
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
  // A note is not a warning: it says something true about the source that
  // changes what to expect, and it sits under the facts rather than over them.
  var note = p.note_key ? '<div class="create-caption">' + tH(p.note_key) + '</div>' : '';
  host.innerHTML = '<div class="create-preview-box' + (p.ok ? '' : ' not-ok') + '">' +
    warn + html + note + '</div>';
}

// Ask the server what is actually there. Fired when the source stops changing,
// which is the moment the question becomes answerable.
async function _createProbeSource() {
  var mode = _createSelected;
  var fields = _createFormFields();
  var body = _createBuildRequest(mode, fields);
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
    // The panel may have moved on while the server was looking. A reply about
    // the mode you left belongs to that mode's slot, never to the one on screen.
    if (mode !== _createSelected) {
      var slot = _createStateFor(mode);
      slot.preview = res.ok ? data : null;
      slot.previewSource = body.source;
      return;
    }
    if (!res.ok) {
      // A refusal here is the same refusal the run would give, so it belongs
      // where the run's refusals go rather than in the preview box.
      _createPreview = null;
      _createFormError(data.error || t('create_error_generic'));
    } else if (data.mode && data.mode !== mode && _createDef(data.mode) &&
        _createModeInList(_createVisibleModes(), data.mode)) {
      // The server looked and saw something else: a YouTube or PeerTube
      // address typed under Web page is a video, and yt-dlp said so. The
      // chip moves to what the address is; the answer is kept under it.
      var was = mode;
      _createProbing = false;
      _createSelectMode(data.mode);
      _createPreview = data;
      _createPreviewSource = body.source;
      var left = _createStateFor(was);
      left.preview = null;
      left.previewSource = '';
    } else {
      _createPreview = data;
      // Remembered here, at the moment it is known: the probe finds the icon
      // seconds before a job exists, and the run header wants it from the
      // first frame rather than after the first poll.
      _createHeadIcon = (data && typeof data.icon === 'string' && data.icon) || null;
      _createFormError('');
      _createApplyDetectedLanguage(data);
      if (_createAutoPickEngine(data)) return;  // re-probing with the engine it wants
    }
  } catch (e) {
    if (mode === _createSelected) _createPreview = null;
  } finally {
    _createProbing = false;
    if (mode === _createSelected) _renderCreatePreview();
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

// ── submitting ──────────────────────────────────────────────────────────────

async function _createSubmit() {
  if (_createSubmitting) return;
  var body = _createBuildRequest(_createSelected, _createFormFields());
  if (!body) { _createFormError(t('create_needs_source')); return; }
  _createFormError('');
  _createStashMode();
  // Whatever finished before is not this. Cleared BEFORE the request goes out,
  // because the first poll after a submit can still answer with the previous
  // job — the server has not swapped jobs yet — and for that beat the screen
  // showed the last capture's completion card under the new one's name (Eric:
  // "I change domain and click create and it shows the old one's completion
  // screen before refreshing to the new one").
  _createForgetFinished();
  _createSubmitting = true;
  // The press must answer the finger NOW, not after the round trip: the
  // button goes busy synchronously (label swap + disabled) so the click never
  // reads as ignored while the server thinks (Eric: "it doesn't immediately
  // respond... it should have some kinda instant feedback not just sit there").
  var btn = document.getElementById('create-start');
  var btnLabel = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.classList.add('busy');
    btn.textContent = _createT('create_starting');
  }
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
    _createStartWatching(data);
  } catch (e) {
    _createFormError(t('create_error_generic'));
  } finally {
    _createSubmitting = false;
    var b = document.getElementById('create-start');
    if (b) {
      b.disabled = false;
      b.classList.remove('busy');
      if (btnLabel) b.innerHTML = btnLabel;
    }
  }
}

// A fresh submission: throw away the last job's tail, tree and counters, and
// remember our place in the queue if the server put us in one.
function _createStartWatching(data) {
  _createResetRun();
  _createAdopted = true;
  _createInterrupted = false;
  _createQueuedId = (data && data.status === 'queued' && data.id) ? data.id : null;
  // The id of the job we just started is ours from this moment, not from the
  // first poll that happens to say "active". A one-page capture of a small
  // site finishes inside a second — before that poll — and its first reply
  // says done for an id this page had never recorded, which
  // _createForeignReply then read as somebody else's finished job: the run
  // pane never appeared and the form came back with the probe card (survey
  // finding F15).
  if (data && data.status === 'started' && data.id) _createJobId = data.id;
  if (data && data.status === 'queued' && typeof data.position === 'number') {
    _createQueue = [{ id: data.id, position: data.position, mode: data.mode }];
    _renderCreateQueue();
  }
  _createPollMs = CREATE_POLL_MS;
  _createPoll();
}

// Take a FINISHED run off the screen (a running one is left alone — that is a
// job in flight, not a stale answer). Used when a new source is entered over a
// completed capture.
// Drop a FINISHED run from the screen and from the state the renderer reads.
// Never touches a live one: _createClearFinished already refuses while a job
// is active, and this adds the job identity so a stale poll cannot repaint
// what was just cleared.
function _createForgetFinished() {
  if (_createStatus && _createStatus.active) return;
  _createJobId = null;
  _createQueuedId = null;
  _createDoneMounted = true;   // let _createClearFinished do its work
  _createClearFinished();
  _createStatus = null;
}

function _createClearFinished() {
  if (!_createDoneMounted) return;
  var status = _createStatus;
  if (status && status.active) return;
  _createResetRun();
  var slot = document.getElementById('create-done-slot');
  if (slot) slot.innerHTML = '';
  var tree = document.getElementById('create-tree-wrap');
  if (tree) tree.hidden = true;
  var metrics = document.getElementById('create-metrics');
  if (metrics) metrics.innerHTML = '';
  _createStatus = null;
  _renderCreatePreview();
}

function _createResetRun() {
  // The counters' DISPLAY, not their values — those live in the viz, which is
  // rebuilt below. Left behind, the new job's counters would start wherever the
  // last job's happened to be sitting and then walk down to zero.
  _createCountShown = {};
  if (_createCountRaf && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(_createCountRaf);
  }
  _createCountRaf = 0;
  _createLines = [];
  _createCursor = 0;
  _createLogCursor = 0;
  _createEventCursor = 0;
  _createViz = _createNewViz();
  _createVizChanges = null;
  _createNodeEls = {};
  _createTreeShown = 0;
  _createTreeElided = 0;
  _createTreeMounted = false;
  _createDoneMounted = false;
  _createRunSeq++;
  _createRunKey = null;
  _createRunStartedAt = 0;
}

// Cancel the running job, or drop a queued one. Both are the same endpoint; an
// id names a job that has not started, an empty body means "whatever is
// running", which is what every build of the server has always understood.
async function _createCancel(queuedId) {
  var btn = document.getElementById('create-cancel-btn');
  if (btn) btn.disabled = true;
  try {
    await authedFetch('/manage/create/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queuedId ? { id: queuedId } : {})
    });
  } catch (e) {}
  if (queuedId && queuedId === _createQueuedId) _createQueuedId = null;
  _createPoll();
}

// Leave the finished job behind and go back to the picker.
function _createReset() {
  _createStatus = null;
  _createAdopted = false;
  _createInterrupted = false;
  _createResetRun();
  _renderCreateRun();
}

async function _createOpenResult(name) {
  // The ZIM registered itself as it was written, but this client's cached list
  // predates it — refresh before navigating or the source view finds nothing.
  try {
    zimsCache = await _fetchList();
    _rebuildZimsMap();
  } catch (e) {}
  // Recent is a log, and a log outlives what it describes: a ZIM made last
  // week and deleted since still has a row, and its Open button used to walk
  // into an empty source view. Ask the refreshed list first and say so plainly
  // instead.
  if (!(zimsCache || []).some(function (z) { return z.name === name; })) {
    _createMarkGone(name);
    return;
  }
  closeCreate();
  enterSource(name, true);
}

// Every remembered row checked against the library, before Recent is drawn.
//
// Recent lives in this browser and the library lives on the server, so the two
// drift apart the moment a ZIM is deleted from anywhere. Marking a row gone
// when its Open button failed — which is all this used to do — fixes exactly
// one row, and only for whoever walked into the dead end. After clearing out
// every made-here ZIM, nine rows still read "Added to the library" and still
// offered a door, each one waiting to disappoint somebody individually.
//
// No request: zimsCache is the library list this client already holds for the
// home grid and search. An empty cache means it has not loaded yet, not that
// the library is empty, so nothing is marked until there is something to
// compare against — otherwise a cold open would declare every row dead.
function _createReconcileGone() {
  if (!(zimsCache || []).length) return;
  var changed = false;
  for (var i = 0; i < _createHistory.length; i++) {
    var h = _createHistory[i];
    if (_createHistoryLive(h)) continue;
    if (!_createRowGone(h, !!_zimInfo(h && h.result))) continue;
    _createHistory[i] = Object.assign({}, h, { gone: true });
    changed = true;
  }
  if (changed) _createJobsSave(_createHistory);
}

// Turn a Recent row into what it now is: a record of something that was made
// and is no longer here. The row stays — it happened — and stops offering a
// door to nowhere.
function _createMarkGone(name) {
  for (var i = 0; i < _createHistory.length; i++) {
    if (_createHistory[i] && _createHistory[i].result === name) {
      _createHistory[i] = Object.assign({}, _createHistory[i], { gone: true });
    }
  }
  _createJobsSave(_createHistory);
  _renderCreateRecent();
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

async function _createPoll(first) {
  _createStopPolling();
  if (!_createOpen) return;
  var wantHistory = first || _createWantHistory;
  _createWantHistory = false;
  var url = '/manage/create/status?since=' + _createCursor +
    '&events_since=' + _createEventCursor +
    (first ? '&probe=1' : '') + (wantHistory ? '&history=1' : '');
  // The run this poll was issued for. A reply that lands after a NEW run
  // began (Create was tapped while it was in flight) describes the world
  // before that run, and may say "no job at all": the opening poll carries
  // probe=1, which on a cold server takes seconds, and its "nothing running"
  // used to arrive after our job had started, been adopted, even finished —
  // and the page believed it, dropped the result and showed the form
  // (survey finding F15, the restart case). Such a reply keeps only what
  // cannot go stale: the recent list.
  var seq = _createRunSeq;
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
    if (seq !== _createRunSeq) {
      if (Array.isArray(data.history)) _createAdoptHistory(data.history);
      _renderCreateRecent();
      return;
    }
    _createIngest(data);
    _renderCreateQueue();
    _renderCreateRun();
    // One more poll after a job finishes, to collect the history entry it just
    // became. Without it the Recent list would sit a poll behind for good.
    if (data.active || _createQueue.length || _createWantHistory) _createSchedulePoll();
  } catch (e) {
    _createPollMs = Math.min(_createPollMs * 2, CREATE_POLL_MAX_MS);
    _createSchedulePoll();
  }
}

// One status reply, folded into everything it touches. Kept apart from the poll
// so a test can drive it with a payload and no network.
function _createIngest(data) {
  _createOffline = !!data.offline;
  // Capability fields ride the probe poll only, so an ordinary poll simply
  // does not carry them — and must leave what we know alone. Each is written
  // only when the reply actually states it; anything else would let a two-
  // second heartbeat un-answer a question the server has already answered.
  if (typeof data.import_ready === 'boolean') {
    // One fact, two readers: the Import mode asks "can this server convert an
    // archive at all", the engine picker asks "is the alive engine's second
    // half here". Same sidecar, same answer.
    _createImportReady = data.import_ready;
    _createSidecarReady = data.import_ready;
    _createRemember('sidecar', data.import_ready);
  }
  if (typeof data.browser_ready === 'boolean') {
    _createBrowserReady = data.browser_ready;
    _createRemember('browser', data.browser_ready);
    // The probe can answer before this does (the opening poll is the slow
    // one): a preview judged with the browser unknown is judged again now.
    if (_createPreview) _createAutoPickEngine(_createPreview);
  }
  if (typeof data.alive_ready === 'boolean') {
    _createAliveReady = data.alive_ready;
    _createRemember('alive', data.alive_ready);
  }
  // Video's half of the same contract. It was the one capability with no
  // readiness answer, which is exactly why it was the one that shipped
  // offering a mode the server could not run.
  if (typeof data.video_ready === 'boolean') {
    _createVideoReady = data.video_ready;
    _createRemember('video', data.video_ready);
  }
  // The instance's stored capture defaults (Manage → Creator toggles) become
  // the checkboxes' initial state, so a default the admin flipped there is
  // what a fresh form shows. An explicit choice stashed for this mode still
  // wins when the stash restores over the render.
  if (data.capture_defaults) {
    if (typeof data.capture_defaults.block_ads === 'boolean') {
      CREATE_FIELDS.block_ads.on = data.capture_defaults.block_ads;
    }
    if (typeof data.capture_defaults.capture_variants === 'boolean') {
      CREATE_FIELDS.capture_variants.on = data.capture_defaults.capture_variants;
    }
  }
  // Whose job is this reply about? See _createForeignReply: a finished job the
  // server still has in its one slot may belong to somebody else entirely.
  var foreign = _createForeignReply(data, _createJobId, _createQueuedId);
  if (Array.isArray(data.history)) _createAdoptHistory(data.history);
  // A reply about somebody else's finished job says nothing about ours, and
  // it used to be allowed to say a great deal: it nulled the status and the
  // screen fell back to the form for one poll. The page's opening poll
  // carries probe=1, which takes seconds while it checks the sidecars, so on
  // a fresh page a person who taps Create straight away gets that stale
  // answer AFTER their own job is on screen — job, form, job, inside three
  // seconds (survey finding F7). Capabilities and the recent list above are
  // still worth taking from it; nothing about the run is.
  if (foreign) return;
  // A different id is a different job — our queued submission reaching the
  // front, or someone else's run starting — and nothing of the last one's tree,
  // tail or counters belongs on top of it.
  if (data.id && data.id !== _createJobId) {
    _createJobId = data.id;
    _createResetRun();
  }
  // The recent list is fetched when the page opens, so a job that finishes
  // while you watch would otherwise leave it a poll out of date forever.
  if (_createStatus && _createStatus.active && data.done) _createWantHistory = true;
  // A server with no queue support never sends the field, so the optimistic
  // entry a submission put there has to be cleared by the first reply that
  // proves the job is no longer waiting. A queue strip nobody can clear is the
  // eternal spinner wearing a different hat.
  if (Array.isArray(data.queue)) _createQueue = data.queue;
  // The fallback for a server too old to send a queue at all. `foreign` is
  // excluded because somebody else's job finishing says nothing about whether
  // OUR submission is still waiting — and clearing the strip on it would take
  // the admin's queue position off the screen while they were in it.
  else if (data.active || (data.done && !foreign)) _createQueue = [];

  if (data.active) {
    _createAdopted = true;
    _createSawActive = true;
    _createInterrupted = false;
    _createQueuedId = null;   // whatever we queued is either running or gone
  } else if (_createSawActive && !data.done) {
    // We watched a job run and the server now says there is no job at all. The
    // only way that happens is the process going away underneath it.
    _createSawActive = false;
    _createInterrupted = true;
    _createAdopted = false;
    _createQueue = [];
    _createQueuedId = null;
  }

  // A foreign job's log lines and tree events are not ours to merge either —
  // they would land in our tail and our tree, under our job's heading.
  if (!foreign) {
    var lines = _createMergeLines(_createLines, _createCursor, data);
    if (lines.cursor < _createCursor) _createLogCursor = 0;
    _createLines = lines.lines;
    _createCursor = lines.cursor;

    var events = _createMergeEvents(_createEventCursor, data);
    if (events.supported) _createEventsOk = true;
    if (events.reset) { _createViz = _createNewViz(); _createTreeMounted = false; }
    _createEventCursor = events.cursor;
    var moved = _createApplyEvents(_createViz, events.events);
    _createVizChanges = _createVizChanges ? _createMergeChanges(_createVizChanges, moved) : moved;
  }

  // Null on a foreign reply, which is the truth: this page has no job on the
  // server right now. The run pane comes down, the picker comes back, and the
  // queue strip — untouched above — still shows where our submission is.
  _createStatus = (_createAdopted && !foreign) ? data : null;
}

// Two batches of pending DOM work, combined — a render that was skipped (the
// pane was not mounted yet) must not lose the rows it was going to draw.
function _createMergeChanges(a, b) {
  var merged = {
    phase: a.phase || b.phase,
    counts: a.counts || b.counts,
    added: a.added.concat(b.added),
    updated: [],
    touched: {}
  };
  var all = a.updated.concat(b.updated);
  for (var i = 0; i < all.length; i++) _createMarkUpdated(merged, all[i]);
  return merged;
}

// ── the run pane ────────────────────────────────────────────────────────────

function _createReduceMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { return false; }
}

function _renderCreateRun() {
  var host = document.getElementById('create-run');
  var picker = document.getElementById('create-picker');
  if (!host) return;
  var s = _createStatus;
  var running = !!s && (s.active || s.done);
  if (!running) {
    // Nothing of ours is on the server: the picker, plus whatever explanation
    // the last job left behind.
    var key = _createInterrupted ? 'i' : '-';
    if (_createIdleKey !== key) {
      host.innerHTML = _createInterrupted ? _createInterruptedHtml() : '';
      _createIdleKey = key;
    }
    _createRunKey = null;
    if (picker) picker.hidden = false;
    if (_createTilesKey !== _createAvailabilityKey()) {
      _createStashMode();
      _renderCreateModes();
      _renderCreatePanel();
    }
    _renderCreateRecent();
    return;
  }
  if (picker) picker.hidden = true;
  _renderCreateRecent();
  _createIdleKey = null;
  var shellKey = (s.id || s.mode) + ':' + _createRunSeq;
  if (_createRunKey !== shellKey) {
    host.innerHTML = _createRunShellHtml(s);
    _createRunKey = shellKey;
    _createTreeMounted = false;
    _createNodeEls = {};
    _createTreeShown = 0;
    _createTreeElided = 0;
    _createLogCursor = 0;
    _createDoneMounted = false;
  }
  _createSyncRun(s);
}

// The pane, drawn once per job. Everything inside it is then updated in place:
// rebuilding this on a two-second timer is what would make the tree flicker,
// restart every row's arrival animation and yank the log back to the bottom
// under someone who had scrolled up to read it.
function _createRunShellHtml(s) {
  return '<div class="create-run">' +
    // The site's own mark, beside its name. A capture runs for a minute and a
    // half and this screen carried nothing identifying for any of it — Eric
    // asked for "favicon or anything" twice. The probe hands the icon back as
    // a data URI, so this costs the browser no request and works offline.
    '<div class="create-head">' +
      '<img class="create-head-icon" id="create-run-icon" alt="" hidden>' +
      '<div class="create-head-text">' +
        '<div class="create-title" id="create-run-title"></div>' +
        '<div class="create-caption" id="create-run-sub"></div>' +
      '</div>' +
    '</div>' +
    _createPhaseStripHtml() +
    '<div class="create-phase-detail" id="create-phase-detail" aria-live="polite"></div>' +
    '<div class="create-metrics" id="create-metrics"></div>' +
    // The result sits ABOVE the page list: on a 40-page crawl the card with
    // Open used to land under the whole tree, two screens down on a phone.
    // At the finish the list folds to one line and opens on a tap.
    '<div id="create-done-slot"></div>' +
    '<div id="create-fail-slot"></div>' +
    '<details class="create-tree-wrap" id="create-tree-wrap" hidden open>' +
      '<summary class="create-tree-summary" id="create-tree-summary" hidden></summary>' +
      '<div class="create-tree" id="create-tree"></div>' +
      '<div class="create-tree-more" id="create-tree-more" hidden></div>' +
    '</details>' +
    // Actions directly under the progress, log disclosure LAST and pushed
    // well clear of them: the log summary used to sit one row above Stop
    // early / Cancel, and a finger reaching to watch progress could end the
    // run instead (Eric: "scary close... I don't want to mis-click").
    '<div class="create-actions" id="create-run-actions"></div>' +
    _createCreditHtml(s.mode) +
    '<details class="create-logbox" id="create-logbox" style="margin-top:28px">' +
      '<summary>' + tH('create_log') + '</summary>' +
      '<div class="create-log" id="create-log"></div>' +
    '</details>' +
  '</div>';
}

// Four steps, and the one that is lit is the one happening now. A server that
// sends no phase events leaves the strip out entirely rather than showing four
// grey boxes that never move — an inert progress indicator is worse than none.
function _createPhaseStripHtml() {
  var html = '';
  for (var i = 0; i < CREATE_STEP_KEYS.length; i++) {
    html += '<div class="create-step" data-step="' + i + '">' +
      '<span class="create-step-dot" aria-hidden="true"></span>' +
      '<span class="create-step-name">' + tH(CREATE_STEP_KEYS[i]) + '</span>' +
    '</div>';
  }
  return '<div class="create-phases" id="create-phases" hidden>' + html + '</div>';
}

function _createSyncRun(s) {
  _createSyncHead(s);
  _createSyncPhases(s);
  _createSyncMetrics(s);
  _createSyncTree(s);
  _createSyncLog();
  _createSyncActions(s);
  _createSyncOutcome(s);
  _createVizChanges = null;
}

// What is being made, named, for the whole time it is being made.
//
// A run pane that opens with a progress strip and nothing else asks you to
// remember what you just started, and by the time you come back to the tab you
// do not. So: the title on top, the mode under it, from the first frame to the
// last. The title is whatever is honestly known — the one that was typed, else
// the one the engine read off the source once it had the source in hand (site
// capture says so in a line, and the server puts it on the job), else the
// address itself, which is always known and is never nothing.
function _createSyncHead(s) {
  var head = document.getElementById('create-run-title');
  var sub = document.getElementById('create-run-sub');
  if (!head || !sub) return;
  var title = String(s.title || '');
  var source = String(s.source || '');
  // Only ever ONE of the two lines carries the address: repeating it under
  // itself is noise, and the mode alone is the useful second line once the
  // thing has a name.
  var mode = s.mode ? t('create_mode_' + s.mode) : '';
  _createSetLine(head, title || _createShortSource(source), title ? '' : source);
  _createSetLine(sub, title ? mode + ' · ' + _createShortSource(source) : mode,
    title ? source : '');
  _createSetHeadIcon();
}

// The icon the probe found for whatever is being captured. Kept in a module
// var rather than read off the job: the probe knows it seconds before the job
// exists, and the point is to have something on screen from the first moment.
var _createHeadIcon = null;

function _createSetHeadIcon() {
  var img = document.getElementById('create-run-icon');
  if (!img) return;
  if (!_createHeadIcon) { img.hidden = true; img.removeAttribute('src'); return; }
  if (img.getAttribute('src') !== _createHeadIcon) img.setAttribute('src', _createHeadIcon);
  img.hidden = false;
}

// Set an element's text, and give it the full value as a tooltip when what is
// shown had to be cut. Kept together so the two can never disagree.
function _createSetLine(el, text, full) {
  if (el.textContent !== text) el.textContent = text;
  if (full && full !== text) el.setAttribute('title', full);
  else el.removeAttribute('title');
}

function _createSyncPhases(s) {
  var strip = document.getElementById('create-phases');
  if (!strip) return;
  var viz = _createViz;
  // The status carries the job's phase outright, which is what lets a page
  // opened halfway through a crawl light the right step immediately rather
  // than waiting for the next phase event — there may not be another one.
  var step = Math.max(viz.step, _createPhaseStep(s.phase));
  // A finished job is finished whatever the last phase event said: a crawl that
  // failed in Fetch must not leave the strip claiming it is still fetching, and
  // one that succeeded is Ready even if "done" never arrived as an event.
  if (s.done && s.ok) step = CREATE_STEP_KEYS.length - 1;
  // A failed job reports its phase as "done" as well; the dot that goes red
  // is the phase the server says it failed in, never Ready.
  if (s.done && !s.ok && !s.cancelled) {
    var failedAt = _createPhaseStep(s.failed_phase);
    step = failedAt >= 0 ? failedAt : Math.max(0, Math.min(viz.step, CREATE_STEP_KEYS.length - 2));
  }
  if (step < 0 && !_createEventsOk) { strip.hidden = true; return; }
  strip.hidden = false;
  var kids = strip.children;
  for (var i = 0; i < kids.length; i++) {
    var failed = s.done && !s.ok && !s.cancelled;
    var state = i < step ? 'done'
      : (i === step ? (failed ? 'failed' : (s.done ? 'done' : 'active')) : 'pending');
    kids[i].setAttribute('data-state', state);
    if (state === 'active') kids[i].setAttribute('aria-current', 'step');
    else kids[i].removeAttribute('aria-current');
  }
  // Step 2 is shared: packaging a ZIM and converting a recording into one are
  // the same sentence to a person — "it is writing the file now". But the
  // ALIVE engine spends nearly its whole run converting, so a box permanently
  // reading "Package" described the wrong activity for a minute at a time
  // (Eric: "I don't like how on Alive it all happens in Package phase, that
  // makes no sense"). One box, the name of whichever is actually running.
  var shared = kids[2] && kids[2].querySelector('.create-step-name');
  if (shared) {
    var key = s.phase === 'convert' ? 'create_step_convert' : 'create_step_package';
    var label = _createT(key);
    if (shared.textContent !== label) shared.textContent = label;
  }
  var detail = document.getElementById('create-phase-detail');
  if (detail) {
    // A detail that is just the mode name says nothing the chip above did not
    // already say, and the server sends exactly that when it has nothing
    // better. What belongs on this line then is what the job is doing — and on
    // a job that is over, nothing: the card below says how it ended, and the
    // engine's last word for itself ("ok") is not a sentence for anyone.
    var extra = (s.active && viz.detail && viz.detail !== s.mode) ? viz.detail : '';
    var text = s.active
      ? (s.cancelling ? t('create_cancelling')
        : s.finishing ? _createT('create_finishing')
        : (extra || t('create_running')))
      : '';
    // How much longer, on the same line and after it — a second line of its
    // own would give a hedged number more room than the thing it hedges. A job
    // being cancelled or finished early is not estimated: what is left is the
    // current page, and that is not a rate.
    if (text && !s.cancelling && !s.finishing) {
      var counts = viz.counts.entries;
      var eta = _createEtaText(
        _createEstimate(viz.samples, counts && counts.total, Date.now()));
      if (eta) text += ' · ' + eta;
    }
    if (detail.textContent !== text) detail.textContent = text;
  }
}

// The counters. Bytes are formatted here and never on the server; entries are
// the number Eric asked for by name, because packaging used to be the phase
// where a long job sat perfectly still and looked hung.
function _createSyncMetrics(s) {
  var host = document.getElementById('create-metrics');
  if (!host) return;
  var counts = _createViz.counts;
  var html = '';
  for (var i = 0; i < CREATE_COUNT_KEYS.length; i++) {
    var what = CREATE_COUNT_KEYS[i];
    var c = counts[what];
    if (!c) continue;
    // See _createMetricLive: a crawl's per-page counters would sawtooth here.
    if (!_createMetricLive(what, s.mode, s.active)) continue;
    // The number this markup carries is where the DISPLAY currently is, not
    // where the server is — see _createCountStep. Whenever a job is finished,
    // being cancelled, or the reader has asked for less motion, they are the
    // same thing, because there is nothing left to smooth toward.
    var shown = _createCountShownValue(what, _createChipTarget(what, c.n, s), s);
    var value = what === 'bytes' ? _fmtBytes(shown) : Number(shown).toLocaleString();
    var of = (typeof c.total === 'number' && c.total > 0)
      ? '<span class="create-metric-of">/ ' +
        (what === 'bytes' ? esc(_fmtBytes(c.total)) : esc(c.total.toLocaleString())) + '</span>'
      : '';
    html += '<div class="create-metric">' +
      '<span class="create-metric-n" data-count="' + escAttr(what) + '">' +
        esc(value) + '</span>' + of +
      // Singular when there is one of it, here as on the done card ("1 asset",
      // not "1 assets" — Eric caught it in the live counters too). Bytes has no
      // singular partner; the helper falls back to the plural key.
      '<span class="create-metric-k">' + _createCountLabel(what, c.n, s.mode) + '</span>' +
    '</div>';
  }
  // Packaging (and warc2zim's convert) write one big file and emit no per-item
  // events, so the counters above freeze at their fetch-phase totals and the
  // page reads as stuck (Eric: "just sits there while packaging"). Keep a
  // pulsing line of movement through those silent phases — appended below the
  // frozen counts, or standing alone when a silent engine never filled a tree.
  var silent = s.active && (_createViz.phase === 'package' || _createViz.phase === 'convert');
  if (silent || (!html && s.active && !_createViz.order.length)) {
    // What it SAYS matters as much as that it moves. The caption above already
    // reads "Creating…"; repeating it here was two lines of the same word and
    // no information (Eric: "a bunch of the same strings repeated"). During
    // packaging this names the actual work and answers the question the phase
    // provokes — no, it is not still fetching — and carries elapsed time so a
    // long write is visibly progressing rather than possibly hung.
    var msg = s.cancelling ? tH('create_cancelling')
      : (silent ? tH('create_packaging') : tH('create_running'));
    var since = _createElapsedText(s);
    html += '<div class="create-status"><span class="spinner-inline" aria-hidden="true"></span>' +
      '<span>' + msg + (since ? ' <span class="create-elapsed">' + esc(since) + '</span>' : '') + '</span></div>';
  }
  if (host.innerHTML !== html) host.innerHTML = html;
  _createCountsAnimate(s);
}

// Where each counter's DISPLAY currently sits. The structure above is rebuilt
// only when it changes; these values are then walked forward frame by frame
// below, writing text into the spans rather than rebuilding the markup — a full
// re-render sixty times a second would fight the tree renderer for exactly the
// reason that one is incremental.
var _createCountShown = {};
var _createCountRaf = 0;
var _createCountAt = 0;

// True when there is nothing to smooth toward: a job that has stopped should
// show its real final numbers at once rather than easing into them, and a
// reader who asked for less motion should never be shown a number in transit.
function _createCountsSnap(s) {
  return !s || !s.active || !!s.done || _createReduceMotion();
}

function _createCountShownValue(what, target, s) {
  if (_createCountsSnap(s)) { _createCountShown[what] = target; return target; }
  if (typeof _createCountShown[what] !== 'number') _createCountShown[what] = target;
  return Math.round(_createCountShown[what]);
}

function _createCountsAnimate(s) {
  if (_createCountRaf) return;                 // one loop, not one per poll
  if (_createCountsSnap(s)) return;
  if (typeof requestAnimationFrame !== 'function') return;
  _createCountAt = 0;
  var tick = function (now) {
    _createCountRaf = 0;
    var host = document.getElementById('create-metrics');
    if (!host) return;
    var dt = _createCountAt ? (now - _createCountAt) : 16;
    _createCountAt = now;
    var moving = false;
    var spans = host.querySelectorAll('.create-metric-n[data-count]');
    for (var i = 0; i < spans.length; i++) {
      var what = spans[i].getAttribute('data-count');
      var c = _createViz.counts[what];
      if (!c || typeof c.n !== 'number') continue;
      var next = _createCountStep(_createCountShown[what], c.n, dt);
      _createCountShown[what] = next;
      var text = what === 'bytes'
        ? _fmtBytes(next) : Number(Math.round(next)).toLocaleString();
      if (spans[i].textContent !== text) spans[i].textContent = text;
      if (next < c.n) moving = true;
    }
    if (moving) _createCountRaf = requestAnimationFrame(tick);
  };
  _createCountRaf = requestAnimationFrame(tick);
}

// ── the tree ────────────────────────────────────────────────────────────────

// Incremental by construction: added rows are inserted under their parent,
// updated rows have three attributes rewritten, and nothing else in the tree is
// touched. That is what holds at two hundred nodes and at two thousand.
function _createSyncTree() {
  var wrap = document.getElementById('create-tree-wrap');
  var root = document.getElementById('create-tree');
  if (!wrap || !root) return;
  var viz = _createViz;
  var status = _createStatus || {};
  // One page is not a list: its one row only repeated the heading above it.
  var single = status.mode === 'page' && viz.order.length <= 1 &&
    !(viz.counts.entries && viz.counts.entries.n > 1);
  if (!viz.order.length || single) { wrap.hidden = true; return; }
  wrap.hidden = false;
  _createFoldTree(wrap, status);
  var atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 24;
  if (!_createTreeMounted) {
    root.innerHTML = '';
    _createNodeEls = {};
    _createTreeShown = 0;
    _createTreeElided = 0;
    // order is discovery order, and a node is only ever added after its parent,
    // so one pass places every row correctly.
    for (var i = 0; i < viz.order.length; i++) _createAddNode(viz.order[i]);
    _createTreeMounted = true;
  } else {
    var ch = _createVizChanges;
    if (ch) {
      for (var a = 0; a < ch.added.length; a++) _createAddNode(ch.added[a]);
      for (var u = 0; u < ch.updated.length; u++) _createUpdateNode(ch.updated[u]);
    }
  }
  _createSyncTreeMore();
  // Follow the crawl, but never over the shoulder of someone reading back up
  // through it.
  if (atBottom) root.scrollTop = root.scrollHeight;
}

function _createAddNode(id) {
  var node = _createViz.nodes[id];
  if (!node || _createNodeEls[id]) return;
  if (_createTreeShown >= CREATE_TREE_MAX_NODES) {
    _createTreeElided++;   // counted, not drawn
    return;
  }
  var parentEl = node.parent && _createNodeEls[node.parent];
  var host = parentEl ? parentEl.lastElementChild : document.getElementById('create-tree');
  if (!host) return;
  var el = document.createElement('div');
  el.className = 'create-node create-node-new';
  el.setAttribute('data-nid', id);
  el.innerHTML =
    '<div class="create-node-row">' +
      '<span class="create-node-dot" aria-hidden="true"></span>' +
      '<span class="create-node-label"></span>' +
      '<span class="create-node-assets"></span>' +
    '</div>' +
    '<div class="create-node-bar"><i></i></div>' +
    '<div class="create-node-kids"></div>';
  host.appendChild(el);
  _createNodeEls[id] = el;
  _createTreeShown++;
  _createUpdateNode(id);
}

function _createUpdateNode(id) {
  var node = _createViz.nodes[id];
  var el = _createNodeEls[id];
  if (!node || !el) return;
  el.setAttribute('data-state', node.state || '');
  var label = el.querySelector('.create-node-label');
  if (label && label.textContent !== node.label) label.textContent = node.label;
  var total = node.assets.total;
  var counter = el.querySelector('.create-node-assets');
  if (counter) {
    var text = total ? node.assets.done + '/' + total : '';
    if (counter.textContent !== text) counter.textContent = text;
  }
  var bar = el.querySelector('.create-node-bar');
  if (bar) {
    bar.hidden = !total;
    var pct = total ? Math.round((node.assets.done / total) * 100) : 0;
    bar.firstElementChild.style.width = pct + '%';
  }
}

// What the tree is not showing. The pages keep being counted whether or not
// there is a row for them, so this row is the difference between the two — and
// the metrics above still report the real total.
function _createSyncTreeMore() {
  var more = document.getElementById('create-tree-more');
  if (!more) return;
  more.hidden = _createTreeElided <= 0;
  if (_createTreeElided > 0) {
    var text = t('create_tree_more', { n: _createTreeElided.toLocaleString() });
    if (more.textContent !== text) more.textContent = text;
  }
}

// ── the log ─────────────────────────────────────────────────────────────────

// Appended, never rebuilt. The cursor is in the server's line space, so the
// arithmetic survives the tail being trimmed underneath us: what is new is
// always the last (cursor - shown) lines of whatever we are holding.
function _createSyncLog() {
  var el = document.getElementById('create-log');
  if (!el) return;
  if (_createLogCursor > _createCursor) { el.innerHTML = ''; _createLogCursor = 0; }
  var fresh = Math.min(_createCursor - _createLogCursor, _createLines.length);
  if (fresh <= 0) return;
  var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  var start = _createLines.length - fresh;
  for (var i = start; i < _createLines.length; i++) {
    var line = document.createElement('div');
    line.className = 'create-log-line';
    line.textContent = _createLines[i];
    el.appendChild(line);
  }
  while (el.childElementCount > CREATE_LOG_MAX) el.removeChild(el.firstElementChild);
  _createLogCursor = _createCursor;
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ── actions and outcome ─────────────────────────────────────────────────────

function _createSyncActions(s) {
  var host = document.getElementById('create-run-actions');
  if (!host) return;
  var html;
  if (s.active) {
    // "Finish now" is Cancel's keeping twin, drawn only while the server says
    // it would still change anything (a site crawl in its network pass) and
    // gone the moment packaging starts. Cancel keeps meaning discard.
    var finish = (s.finishable || s.finishing)
      ? '<button type="button" class="ms-btn" id="create-finish-btn"' +
        (s.finishing || s.cancelling ? ' disabled' : '') +
        ' onclick="_createFinishNow()">' +
        esc(_createT(s.finishing ? 'create_finishing' : 'create_finish_now')) +
        '</button>'
      : '';
    html = s.cancellable
      ? finish +
        '<button type="button" class="ms-btn ms-btn-danger" id="create-cancel-btn"' +
        (s.cancelling ? ' disabled' : '') + ' onclick="_createCancel()">' +
        tH(s.cancelling ? 'create_cancelling' : 'create_cancel') + '</button>'
      : '<span class="create-caption">' + tH('create_uncancellable') + '</span>';
  } else {
    html = '<button type="button" class="ms-btn" onclick="_createReset()">' +
      tH('create_another') + '</button>';
  }
  if (host.innerHTML !== html) host.innerHTML = html;
}

// Ask the running site crawl to stop fetching at the next page boundary and
// package everything captured so far — the CLI's Ctrl-C, as a button. The
// reply promises a request, not a stop; the poll carries the rest.
async function _createFinishNow() {
  var btn = document.getElementById('create-finish-btn');
  if (btn) btn.disabled = true;
  try {
    await authedFetch('/manage/create/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
  } catch (e) {}
  _createPoll();
}

// The end of the story: the card, or the reason there is no card. Mounted once
// — re-running this every poll would restart the arrival animation forever.
// At the finish the page list folds to one line ("40 pages") under the result;
// while the job runs it stays open, because watching it is the point then.
function _createFoldTree(wrap, s) {
  var summary = document.getElementById('create-tree-summary');
  if (!summary) return;
  var over = !!(s && s.done);
  if (over) {
    var n = _createViz.counts.entries && _createViz.counts.entries.n;
    var text = n ? Number(n).toLocaleString() + ' ' + _createCountLabel('entries', n, s.mode) : tH('create_log');
    if (summary.textContent !== text) summary.textContent = text;
    summary.hidden = false;
    if (wrap.open && !wrap._foldedOnce) { wrap.open = false; wrap._foldedOnce = true; }
  } else {
    summary.hidden = true;
    wrap.open = true;
    wrap._foldedOnce = false;
  }
}

// Where a failed site gets reported. The web is bigger than the survey that
// shaped these engines; a site that fails is a fixture we do not have yet.
// The link fills the issue in — address, how it was asked for, what it said —
// and opens GitHub in a new tab. Nothing is sent by itself.
var CREATE_ISSUES_URL = 'https://github.com/epheterson/Zimi/issues/new';

function _createReportUrl(s, what) {
  var source = (s && s.source) || '';
  var host = '';
  try { host = new URL(source.split('\n')[0]).host; } catch (e) { host = source.slice(0, 60); }
  var title = 'Capture: ' + (host || 'a site') + ' (' + ((s && s.mode) || 'page') + ')';
  var body = 'Address: ' + source + '\nMode: ' + ((s && s.mode) || '') +
    (s && s.engine ? '\nEngine: ' + s.engine : '') +
    '\n\nWhat happened:\n' + (what || '') + '\n\nWhat I expected:\n';
  return CREATE_ISSUES_URL + '?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
}

function _createReportLinkHtml(s, what) {
  return '<a class="create-report" href="' + escAttr(_createReportUrl(s, what)) + '"' +
    ' target="_blank" rel="noopener">' + tH('create_report_site') + '</a>';
}

function _createSyncOutcome(s) {
  if (!s.done || _createDoneMounted) return;
  _createDoneMounted = true;
  if (s.ok && s.result && s.result.name) { _createMountDone(s); return; }
  var fail = document.getElementById('create-fail-slot');
  if (!fail) return;
  if (s.cancelled) {
    fail.innerHTML = '<div class="create-status">' + tH('create_cancelled') + '</div>';
  } else {
    // A job the watchdog gave up on did not fail at anything — it stopped
    // getting answers. "Creation failed" over the server's own sentence about
    // ten minutes of silence reads like a bug in what you typed.
    fail.innerHTML =
      '<div class="create-status">' + tH(s.stalled ? 'create_stalled' : 'create_failed') + '</div>' +
      (s.error ? '<div class="create-error">' + esc(s.error) + '</div>' : '') +
      '<div class="create-caption">' + _createReportLinkHtml(s, s.error || '') + '</div>';
  }
}

// THE DONE MOMENT.
//
// The reward is the thing you made, arriving. The icon lands, the name settles
// under it, the size counts up to what it really is, and the way in appears.
// Under a second and a half, once, and never again — and with reduced motion it
// is simply there, complete, in one frame. It celebrates a finished ZIM and
// When the run on screen started, stamped client-side the first time a status
// says it is active — the live status reply carries phases and counts, not a
// clock, and this only ever labels the CURRENT run (reset clears it).
var _createRunStartedAt = 0;

// "m:ss" since this run started, or '' before there is a run to time.
function _createElapsedText(s) {
  if (!s || !s.active) return '';
  if (!_createRunStartedAt) _createRunStartedAt = Date.now();
  var secs = Math.max(0, Math.round((Date.now() - _createRunStartedAt) / 1000));
  // Under ten seconds a timer is noise, not reassurance.
  if (secs < 10) return '';
  return Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
}

// "1 entry", not "1 entries" (Eric). Every counted metric carries a singular
// partner key; anything without one falls back to the plural rather than
// inventing grammar for a language this file cannot reason about.
function _createCountLabel(metric, n, mode) {
  // A video job's entries are videos; "1 / 17 page" over a playlist was the
  // page-mode word on the wrong job (survey finding F14).
  var key = 'create_metric_' + (metric === 'entries' && mode === 'video' ? 'videos' : metric);
  if (Number(n) !== 1) return tH(key);
  // Not every metric HAS a singular partner (bytes is a size, not a count).
  // A missing key must fall back to the plural rather than print the key.
  var one = key + '_one';
  var got = tH(one);
  return (!got || got === one) ? tH(key) : got;
}

// The finished ZIM's composition, as the same segmented bar the cache
// breakdown uses (_segBarHtml, app.js) — one component, so the two never
// drift. Colors are per content kind and each segment states its size and
// count as text in the legend, never color alone.
// (The colour per kind lives in app.js beside _segBarHtml, because the About
// panel draws this same bar for ZIMs that were never made here and app.js is
// always loaded while this file is not. Two copies would be two things to keep
// in step for no gain.)

function _createInsideHtml(shape) {
  if (!shape || !shape.breakdown || !shape.breakdown.length) return '';
  if (typeof _segBarHtml !== 'function') return '';
  // Largest first, so the bar reads high-to-low and the legend matches it.
  var segs = shape.breakdown.slice().sort(function(a, b) {
    return (b.size_bytes || 0) - (a.size_bytes || 0);
  });
  // The bar is proportional to what is IN the ZIM; the headline number is the
  // file on disk, which compression makes smaller. Two honest numbers, so the
  // bar never has to pretend its segments add to the file size.
  var inner = segs.reduce(function(a, x) { return a + (x.size_bytes || 0); }, 0);
  var bar = _segBarHtml(segs, inner, _CREATE_KIND_COLORS, function(k) {
    return tH('create_kind_' + k);
  }, tH('create_inside_title'));
  if (!bar) return '';
  return '<div class="create-inside">' +
    '<div class="create-inside-head">' +
      '<span class="create-inside-title">' + tH('create_inside_title') + '</span>' +
      (shape.file_bytes
        ? '<span class="create-inside-total">' + esc(_fmtBytes(shape.file_bytes)) + '</span>'
        : '') +
    '</div>' + bar +
  '</div>';
}

// nothing else: there is no streak, no score and nothing to come back for.
function _createMountDone(s) {
  var host = document.getElementById('create-done-slot');
  if (!host) return;
  var r = s.result || {};
  var bytes = _createResultBytes(s);
  var entries = _createViz.counts.entries;
  var facts = '';
  if (entries && entries.n) {
    facts += '<span class="create-done-fact">' +
      esc(Number(entries.n).toLocaleString()) + ' ' + _createCountLabel('entries', entries.n, s.mode) + '</span>';
  }
  // The file's size, final at once. It used to roll up from 0 B over most of a
  // second while WHAT'S INSIDE beneath it already showed the total, so for that
  // window one screen held two sizes for one file (survey finding F1).
  if (bytes) facts += '<span class="create-done-fact" id="create-done-bytes">' + esc(_fmtBytes(bytes)) + '</span>';
  host.innerHTML =
    // No entrance animation: the file already exists, and the first sighting
    // of the result should be its best, not a card whose text cannot be read.
    '<div class="create-done">' +
      '<span class="create-done-icon">' + _CREATE_ICONS.zim + '</span>' +
      '<div class="create-done-body">' +
        '<div class="create-caption">' + tH('create_done_title') + '</div>' +
        '<div class="create-done-name">' + esc(r.title || r.name) + '</div>' +
        '<div class="create-done-facts">' +
          // The title is the thing; the filename is the library manager's.
          facts +
        '</div>' +
        // A crawl that stopped at a bound — the finish button, a page cap, a
        // byte budget — says so on the card: "40 pages" without "and I stopped
        // there" reads like a capture that believes it got everything.
        (r.stopped
          ? '<div class="create-caption">' + esc(_createStoppedText(r.stopped)) + '</div>'
          : '') +
        // A page with almost no readable text is more likely a login, consent
        // or paywall gate than the article (medium.com: 227 characters to
        // every engine, survey finding O5). Said here, on the card, because
        // nobody opens the server log of a job that finished green.
        (r.thin_page
          ? '<div class="create-caption create-done-warn">' +
              esc(_createT('create_warn_thin_page').replace('{n}', Number(r.text_chars || 0).toLocaleString())) +
              ' ' + _createReportLinkHtml(s, 'Only ' + Number(r.text_chars || 0) + ' characters of text came back.') +
            '</div>'
          : '') +
      '</div>' +
      '<button type="button" class="ms-btn ms-btn-primary create-done-open"' +
        ' onclick="_createOpenResult(\'' + escJs(r.name) + '\')">' + tH('create_open') + '</button>' +
    '</div>' +
    _createInsideHtml(r.shape);
}

// How big it turned out. The status reply may carry it; otherwise the last
// bytes counter the job emitted is the same number by a different route.
function _createResultBytes(s) {
  var c = _createViz.counts.bytes;
  return _createDoneBytes(s.result, c && c.n);
}

// ── the queue ───────────────────────────────────────────────────────────────

// One job at a time is the server's rule and a good one on a Pi. What the queue
// changes is only what happens to the SECOND request: it waits its turn and
// says where it is in line, instead of being refused with a sentence.
function _renderCreateQueue() {
  var host = document.getElementById('create-queue');
  if (!host) return;
  if (!_createQueue.length) { host.innerHTML = ''; return; }
  var html = '';
  for (var i = 0; i < _createQueue.length; i++) {
    var q = _createQueue[i];
    var mine = q.id && q.id === _createQueuedId;
    var name = q.title || (q.mode ? t('create_mode_' + q.mode) : '');
    html += '<div class="create-queued' + (mine ? ' mine' : '') + '">' +
      '<span class="create-queued-name">' + esc(name) + '</span>' +
      '<span class="create-queued-pos">' +
        tH('create_queued', { n: q.position === undefined ? i + 1 : q.position }) + '</span>' +
      (q.id
        ? '<button type="button" class="ms-btn" onclick="_createCancel(\'' + escJs(q.id) + '\')">' +
          tH('create_queue_drop') + '</button>'
        : '') +
    '</div>';
  }
  host.innerHTML = html;
}

// ── recent jobs ─────────────────────────────────────────────────────────────

// The server remembers what it did; before round 3 the page did not ask. A
// crawl that finished while the tab was closed, one that failed at three in the
// morning, one the restart took — all of it was invisible, and the only way to
// find out whether last night's job worked was to go looking in the library.
function _renderCreateRecent() {
  var host = document.getElementById('create-recent');
  if (!host) return;
  // Recent belongs to the picker. While a run pane is up it would list the very
  // job whose progress fills the screen above it.
  //
  // The test is the run pane's own — active or done — and not merely "a status
  // object exists". Those were the same thing while a status could only arrive
  // from a poll about a live job; they stopped being the same once a remembered
  // row could seed one, and a status that describes NO running job would have
  // blanked the Recent list for the rest of the session.
  var busy = !!_createStatus && (_createStatus.active || _createStatus.done);
  if (!_createHistory.length || busy) { host.innerHTML = ''; return; }
  _createReconcileGone();
  var rows = '';
  var shown = 0;
  for (var i = 0; i < _createHistory.length && shown < CREATE_RECENT_MAX; i++) {
    var h = _createHistory[i];
    // The live rows are in the table because the table holds every job, and
    // they are skipped here because the run pane and the queue strip are
    // already drawing them. Same job twice, described two different ways, is
    // what this skip exists to prevent — it was done at ingest before, which
    // is why the table could not be remembered.
    if (_createHistoryLive(h)) continue;
    shown++;
    var state = _createHistoryState(h);
    rows +=
      '<div class="create-hist" data-state="' + escAttr(state) + '">' +
        '<span class="create-hist-dot" aria-hidden="true"></span>' +
        '<span class="create-hist-body">' +
          '<span class="create-hist-name">' + esc(_createHistoryLabel(h)) + '</span>' +
          '<span class="create-hist-why">' +
            (h.gone ? tH('create_hist_gone')
              : (CREATE_HISTORY_KEYS[state] ? tH(CREATE_HISTORY_KEYS[state]) : '')) +
            (state === 'failed' && h.error ? ' — ' + esc(h.error) : '') +
          '</span>' +
        '</span>' +
        (state === 'ok' && h.result && !h.gone
          ? '<button type="button" class="ms-btn" onclick="_createOpenResult(\'' +
            escJs(h.result) + '\')">' + tH('create_open') + '</button>'
          : '') +
      '</div>';
  }
  host.innerHTML = '<div class="create-recent">' +
    '<div class="ms-form-label">' + tH('create_recent') + '</div>' + rows + '</div>';
}

// The eternal spinner's replacement. A job that was running when the server
// went down did not fail and is not still going; it stopped, and saying so in
// one sentence is the whole fix.
function _createInterruptedHtml() {
  return '<div class="create-notice">' + tH('create_restarted') + '</div>';
}
