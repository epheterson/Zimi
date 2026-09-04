// ── Config (injected by server via inline script) ──
var _cfg = window.__ZIMI_CONFIG || {};
var _i18nVer = _cfg.i18nHash || '0';

// ── Storage Keys ──
var SK = {
  UI_LANG: 'zimi_ui_lang',
  HIDE_DISCOVER: 'zimi_hide_discover',
  // Almanac location. SESSION-scoped — the almanac is deliberately ephemeral,
  // so read it with _getSessionJSON, never _getStorageJSON.
  ALMANAC_LOC: 'zimi_almanac_location',
  ALMANAC_HL: 'zimi_almanac_highlights',
  HIDE_LANG_CHOOSER: 'zimi_hide_lang_chooser',
  // Last KNOWN answer to "may this browser create ZIMs?" — a boot-time hint so
  // the + can be drawn before the manage probe lands, never an authority. See
  // _createCanShow for why optimism here is safe in one direction only.
  CAN_CREATE: 'zimi_can_create',
  HIDE_XZIM_LINKS: 'zimi_hide_cross_zim_links',
  // When set, ZIM article HTML is run through the server-side a11y
  // rewriter (alt="" on images, h1 promotion, html lang). Off by
  // default to keep ZIM content byte-identical for purist users.
  A11Y_REWRITE: 'zimi_a11y_rewrite',
  LIBRARY_TAB: 'zimi_library_tab',
  // Home library layout: 'list' (default full cards) | 'tiles' (compact grid).
  LIBRARY_VIEW: 'zimi_library_view',
  BROWSE_HISTORY: 'zimi_browse_history',
  BOOKMARKS: 'zimi_bookmarks',
  // Bookmark folders (v2) — array of {id,name,parent,order}. Root is implicit
  // (a bookmark/folder with parent null|"" is top-level). Rides in the same
  // /userdata + My-data backup blob as BOOKMARKS.
  BM_FOLDERS: 'zimi_bm_folders',
  // Per-device UI state: ids of collapsed folders in the bookmarks tree.
  BM_COLLAPSED: 'zimi_bm_collapsed',
  MANAGE_PW: 'zimi_manage_pw',
  // Optional management username (v1.8) — a plain identifier, stored next to
  // the token so a remembered session keeps sending its X-Zimi-User header.
  MANAGE_USER: 'zimi_manage_user',
  PREF_LANGUAGES: 'zimi_pref_languages',
  PREF_FLAVOR: 'zimi_pref_flavor',
  // Reader font scale (percent, one of READER_FONT_LEVELS), applied as a `zoom`
  // on the iframe body and reapplied on every article load.
  READER_FONT: 'zimi_reader_font_scale',
  // Reader View settings palette (persisted — a real palette implies persistence,
  // unlike the session-only v1 toggle). Family: 'serif'|'sans'. Theme:
  // 'dark'|'light'|'sepia'. Auto: '1' opens every article straight into Reader View.
  READER_FAMILY: 'zimi_reader_family',
  READER_THEME: 'zimi_reader_theme',
  READER_AUTO: 'zimi_reader_auto',
  // One-shot: set once the "tap again for reading settings" coachmark has been
  // shown, so the hint never nags a returning reader.
  READER_COACH: 'zimi_reader_settings_coach',
  // Last-rendered SHARING rows (Server pane) — restored synchronously on
  // pane open so the section doesn't pop in after the status fetches.
  SHARE_ROWS: 'zimi_share_rows',
  // Last-active manage settings section (library|preferences|server|users).
  // Session-scoped so a reload (or re-entering Manage) lands on the same tab.
  MANAGE_SECTION: 'zimi_manage_section',
  // Video resume ledger: {"<zim>\n<path>#<i>": {t, d, ts}} — playback position
  // per video, restored on reopen and dropped once watched to completion.
  VIDEO_RESUME: 'zimi_video_resume',
  // Whole-app theme: 'auto' (follow prefers-color-scheme, dark fallback) |
  // 'dark' | 'light'. Default auto. Read/written via _appTheme/_setAppTheme;
  // the head bootstrap in index.html stamps the resolved value pre-paint.
  APP_THEME: 'zimi_app_theme',
  // Auto-darken raw (non-Reader-View) ZIM articles when the app is dark, so a
  // blinding-white ZIM page doesn't break dark mode. Tri-state: unset = follow
  // the app theme (on when dark); '1'/'0' = explicit override once toggled.
  DARKEN_ARTICLES: 'zimi_darken_articles',
};

// ── Storage Helpers ──
function _getStorageJSON(key, fallback, session) {
  try { var v = (session ? sessionStorage : localStorage).getItem(key); return v ? JSON.parse(v) : fallback; }
  catch(e) { return fallback; }
}
// Read for keys that live in sessionStorage rather than localStorage.
function _getSessionJSON(key, fallback) {
  return _getStorageJSON(key, fallback, true);
}
function _setStorageJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) {}
}
function _getStorageFlag(key) {
  return localStorage.getItem(key) === '1';
}

// ── Whole-app theme (Auto / Dark / Light) ──
// The token palette in app.css is driven by data-theme on <html>. Auto mode
// resolves the OS preference to a concrete 'dark'|'light' and stamps the SAME
// attribute, so the CSS has one code path (no reliance on prefers-color-scheme
// in the stylesheet). The head bootstrap sets it pre-paint; this re-applies on
// load and, in Auto, live-tracks the media query.
var APP_THEMES = ['auto', 'dark', 'light'];
function _appTheme() {
  var v = localStorage.getItem(SK.APP_THEME);
  return APP_THEMES.indexOf(v) >= 0 ? v : 'auto';
}
function _prefersLight() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
}
// Resolve a stored mode to the concrete theme actually painted. Auto → the OS
// preference, dark fallback (matches the index.html bootstrap exactly).
function _resolveAppTheme(mode) {
  mode = mode || _appTheme();
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return _prefersLight() ? 'light' : 'dark';
}
function _appThemeIsDark() { return _resolveAppTheme() === 'dark'; }
function _applyAppTheme() {
  var t = _resolveAppTheme();
  var el = document.documentElement;
  el.setAttribute('data-theme', t);
  // Keep the UA surface (scrollbars, form controls, Safari's tab backdrop) in
  // sync with the app theme — this is what prevents the dark compositor flash
  // on tab re-activation. Mirrors the head bootstrap.
  el.style.colorScheme = t;
}
function _setAppTheme(mode) {
  if (APP_THEMES.indexOf(mode) < 0) mode = 'auto';
  if (mode === 'auto') localStorage.removeItem(SK.APP_THEME);
  else localStorage.setItem(SK.APP_THEME, mode);
  _applyAppTheme();
  // Repaint the segmented control's active state in place, and re-apply article
  // darkening (its default follows the app theme, and the darken row's checked
  // state may flip when the theme does).
  var seg = document.getElementById('app-theme-seg');
  if (seg) seg.innerHTML = _appThemeSegInner();
  var darkChk = document.getElementById('ms-darken-articles');
  if (darkChk && localStorage.getItem(SK.DARKEN_ARTICLES) === null) darkChk.checked = _appThemeIsDark();
  try { _applyArticleDarken(_readerFrameDoc()); } catch (e) {}
  _reapplyReaderThemeIfAuto();
}
// When the reader theme is set to Auto, it follows the app theme — so an app
// theme change (manual or OS flip) must re-stamp an open reader. Hoisted, so it
// can be called from the app-theme handlers above the reader definitions.
function _reapplyReaderThemeIfAuto() {
  if (typeof _readerThemeMode !== 'function' || _readerThemeMode() !== 'auto') return;
  try { var d = _readerFrameDoc(); if (d && _readerViewOn) _applyReaderTheme(d); } catch (e) {}
  try { _tintReaderChrome(); } catch (e) {}
}
// Install once: when in Auto, a live OS light/dark flip re-resolves the theme.
var _appThemeMediaBound = false;
function _bindAppThemeMedia() {
  if (_appThemeMediaBound || !window.matchMedia) return;
  _appThemeMediaBound = true;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  var onFlip = function() {
    if (_appTheme() !== 'auto') return; // explicit choice ignores the OS
    _applyAppTheme();
    try { _applyArticleDarken(_readerFrameDoc()); } catch (e) {}
    _reapplyReaderThemeIfAuto();
  };
  if (mq.addEventListener) mq.addEventListener('change', onFlip);
  else if (mq.addListener) mq.addListener(onFlip); // Safari <14
}

// ── Auto-darken raw articles ──
// Whether the darken-articles adaptation should be applied to a raw ZIM page.
// Default follows the app theme (on when dark); an explicit toggle overrides.
function _darkenArticlesOn() {
  var v = localStorage.getItem(SK.DARKEN_ARTICLES);
  if (v === '1') return true;
  if (v === '0') return false;
  return _appThemeIsDark();
}
function _setDarkenArticles(on) {
  localStorage.setItem(SK.DARKEN_ARTICLES, on ? '1' : '0');
  try { _applyArticleDarken(_readerFrameDoc()); } catch (e) {}
}

// ── App-theme segmented control (Display settings) ──
// Auto / Dark / Light, matching the reader palette's control language (pills).
var _APP_THEME_ICONS = {
  auto: '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/></svg>',
  dark: '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  light: '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
};
function _appThemeSegInner() {
  var cur = _appTheme();
  return APP_THEMES.map(function(m) {
    var on = m === cur;
    return '<button type="button" class="app-theme-btn' + (on ? ' active' : '') +
      '" role="radio" aria-checked="' + (on ? 'true' : 'false') +
      '" onclick="_setAppTheme(\'' + m + '\')">' + _APP_THEME_ICONS[m] +
      '<span>' + tH('theme_' + m) + '</span></button>';
  }).join('');
}
function _appThemeSegHtml() {
  return '<div class="app-theme-seg" id="app-theme-seg" role="radiogroup" aria-label="' +
    escAttr(t('app_theme')) + '">' + _appThemeSegInner() + '</div>';
}

// ── Article dark adaptation (raw / non-Reader-View pages) ──
var _ARTICLE_DARKEN_STYLE_ID = 'zimi-article-darken';
// The invert-based adaptation. invert(1) hue-rotate(180deg) on the root flips the
// page to dark while roughly preserving hue; media + math + anything painting its
// own background image is counter-inverted so photos/diagrams/formulas stay true.
// A slightly-off-white root background gives the invert a clean white to flip to
// pure near-black, so transparent pages don't leave a grey haze.
var _ARTICLE_DARKEN_CSS = [
  'html{background:#ffffff !important;filter:invert(1) hue-rotate(180deg) !important;',
    '-webkit-filter:invert(1) hue-rotate(180deg) !important}',
  // Counter-invert media + anything painting its own image so photos, diagrams,
  // maps and icons keep true colour under the root flip.
  'img,video,picture,canvas,svg,image,embed,object,iframe,',
  '[style*="background-image"]{filter:invert(1) hue-rotate(180deg) !important;',
    '-webkit-filter:invert(1) hue-rotate(180deg) !important}',
  // MediaWiki math is black line-art on a TRANSPARENT ground — an <img> fallback
  // (caught by the img rule above) or an inline <svg>. It must invert WITH the
  // page like text, NOT be counter-inverted, or the glyphs stay black on the dark
  // page and vanish. filter:none here leaves only the root flip → white glyphs.
  // Outranks the generic img/svg counter-invert by class specificity.
  '.mwe-math-element,.mwe-math-element img,.mwe-math-element svg,',
  '.mwe-math-fallback-image-inline,.mwe-math-fallback-image-display{',
    'filter:none !important;-webkit-filter:none !important}'
].join('');
// A page "declares its own dark scheme" (so we must NOT invert it, or we'd flip it
// back to blinding white) when it opts into dark via <meta name="color-scheme">
// or its body already paints a dark background.
function _articleDeclaresDark(doc) {
  try {
    var meta = doc.querySelector('meta[name="color-scheme"]');
    if (meta && /dark/i.test(meta.getAttribute('content') || '')) return true;
  } catch (e) {}
  try {
    var bg = doc.defaultView.getComputedStyle(doc.body).backgroundColor;
    var m = bg && bg.match(/rgba?\(([^)]+)\)/);
    if (m) {
      var p = m[1].split(',').map(parseFloat);
      var a = p.length > 3 ? p[3] : 1;
      // Only trust an opaque background; a transparent body defaults to white.
      if (a >= 0.5) {
        var lum = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
        if (lum < 0.4) return true;
      }
    }
  } catch (e) {}
  return false;
}
// Apply or remove the dark adaptation on a raw article document. No-op for
// Reader View (it owns its themes), PDF/static viewer pages, and pages that ship
// their own dark scheme. Idempotent — safe to call on any frame.onload or toggle.
function _applyArticleDarken(doc) {
  if (!doc || !doc.documentElement) return;
  var existing = doc.getElementById(_ARTICLE_DARKEN_STYLE_ID);
  var want = _darkenArticlesOn() && !_readerViewOn;
  if (want) {
    var loc = '';
    try { loc = doc.defaultView.location.pathname; } catch (e) {}
    if (loc.indexOf('/static/') === 0) want = false;         // pdf.js / viewers
    else if (_articleDeclaresDark(doc)) want = false;         // already dark
  }
  if (want) {
    if (!existing && doc.head) {
      var st = doc.createElement('style');
      st.id = _ARTICLE_DARKEN_STYLE_ID;
      st.textContent = _ARTICLE_DARKEN_CSS;
      doc.head.appendChild(st);
    }
  } else if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }
}

// Shared "dismiss on outside interaction" for menus/popovers. Registers a
// capture-phase click listener on BOTH the parent document AND the reader iframe
// document. The iframe half is the crucial bit: the reader content is iframed,
// so a tap inside the article never bubbles to the parent — without listening on
// the frame doc, an open palette/menu would stay stuck when you tap the article.
// `keepEls` are elements whose interior clicks must NOT dismiss (the menu itself
// and, usually, its trigger so a second tap toggles cleanly instead of
// double-firing). `onDismiss` runs on the first outside interaction; if it
// returns false the dismissal is vetoed and the listener keeps watching (e.g. a
// transient locked state). Returns a detach fn; also auto-detaches once it fires.
function _dismissOnOutside(keepEls, onDismiss) {
  keepEls = (Array.isArray(keepEls) ? keepEls : [keepEls]).filter(Boolean);
  function inside(target) {
    return keepEls.some(function(el) { return el.contains && el.contains(target); });
  }
  var detached = false;
  function detach() {
    if (detached) return;
    detached = true;
    document.removeEventListener('click', handler, true);
    var f = _readerFrameDoc();
    if (f) { try { f.removeEventListener('click', handler, true); } catch (_) {} }
  }
  function handler(e) {
    if (e && e.target && inside(e.target)) return;
    if (onDismiss() === false) return;
    detach();
  }
  // Defer a tick so the click that opened the menu doesn't instantly dismiss it.
  setTimeout(function() {
    document.addEventListener('click', handler, true);
    var f = _readerFrameDoc();
    if (f) { try { f.addEventListener('click', handler, true); } catch (_) {} }
  }, 0);
  return detach;
}

// ── Manage token storage ──
// localStorage = persistent ("Remember me" checked).
// sessionStorage = current-tab-only (default). Read both, prefer persistent.
function _readManageToken() {
  return localStorage.getItem(SK.MANAGE_PW) || sessionStorage.getItem(SK.MANAGE_PW) || '';
}
function _saveManageToken(token, remember) {
  // Clear both first so toggling "remember me" never leaves stale copies.
  localStorage.removeItem(SK.MANAGE_PW);
  sessionStorage.removeItem(SK.MANAGE_PW);
  localStorage.removeItem(SK.MANAGE_USER);
  sessionStorage.removeItem(SK.MANAGE_USER);
  if (!token) return;
  var store = remember ? localStorage : sessionStorage;
  store.setItem(SK.MANAGE_PW, token);
  // Persist the username alongside so it rides with the same remember scope.
  if (_manageUser) store.setItem(SK.MANAGE_USER, _manageUser);
}
function _readManageUser() {
  return localStorage.getItem(SK.MANAGE_USER) || sessionStorage.getItem(SK.MANAGE_USER) || '';
}
function _clearManageToken() {
  localStorage.removeItem(SK.MANAGE_PW);
  sessionStorage.removeItem(SK.MANAGE_PW);
  localStorage.removeItem(SK.MANAGE_USER);
  sessionStorage.removeItem(SK.MANAGE_USER);
}
// Auth headers for every manage request: Bearer token + optional username.
// One builder so the two dozen call sites can't drift out of sync.
function _authHeaders(token) {
  token = token || _manageToken;
  var h = {};
  if (token) {
    h['Authorization'] = 'Bearer ' + token;
    if (_manageUser) h['X-Zimi-User'] = _manageUser;
  }
  return h;
}
function _hasStoredManageToken() {
  return !!_readManageToken();
}

// User-preferred languages for the catalog. Empty = no filter (show all).
function _getPrefLanguages() {
  return _getStorageJSON(SK.PREF_LANGUAGES, []) || [];
}
function _setPrefLanguages(langs) {
  _setStorageJSON(SK.PREF_LANGUAGES, langs);
}
function _savePrefLanguagesFromInput(raw) {
  const codes = (raw || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  _setPrefLanguages(codes);
}

// Common language pills for the Preferences UI. Order roughly by global Wikipedia use.
const _LANG_PREF_OPTIONS = ['en', 'fr', 'de', 'es', 'pt', 'ru', 'zh', 'ar', 'hi', 'he', 'ja', 'it', 'multi'];

function _renderLangPrefPills() {
  const selected = new Set(_getPrefLanguages());
  return _LANG_PREF_OPTIONS.map(function(code) {
    const isOn = selected.has(code);
    const label = code === 'multi' ? t('multi_lang') : (_langDisplayName(code) || code.toUpperCase());
    return '<button class="ms-lang-pill' + (isOn ? ' active' : '') +
      '" onclick="_togglePrefLanguage(\'' + code + '\')">' +
      '<span class="ms-lang-code">' + code + '</span> ' + esc(label) + '</button>';
  }).join('');
}

function _togglePrefLanguage(code) {
  const current = new Set(_getPrefLanguages());
  if (current.has(code)) current.delete(code);
  else current.add(code);
  _setPrefLanguages(Array.from(current));
  const el = document.getElementById('ms-lang-pills');
  if (el) el.innerHTML = _renderLangPrefPills();
}

// Preferred download flavor: "full" (with images), "nopic", or "mini".
// Used to sort variant pickers so the user's default lands at the top.
function _getPrefFlavor() {
  return localStorage.getItem(SK.PREF_FLAVOR) || 'full';
}
function _setPrefFlavor(f) {
  localStorage.setItem(SK.PREF_FLAVOR, f);
}
function _flavorRadio(value, label) {
  const checked = _getPrefFlavor() === value ? ' checked' : '';
  return '<label class="ms-flavor-pill"><input type="radio" name="zimi-flavor" value="' +
    value + '"' + checked + ' onchange="_setPrefFlavor(\'' + value + '\')"> ' + label + '</label>';
}

// ── State ──
let mode = 'home'; // 'home' | 'source' | 'search' | 'manage'
let currentSource = null;
let readerOpen = false;
let _readerTimeout = null;
let readerSource = null; // ZIM name of what's in reader (for topbar badge when no explicit source)
let sourceAutoReader = false; // true when enterSource auto-opened the reader (non-zimgit homepage)
let _popstateNoAutoReader = false; // suppress auto-reader on popstate navigation
let articleHistory = []; // [{zim, path, title, timestamp}] — max 50 entries
let currentArticle = null; // {zim, path} — what's currently in the reader
let _domainZimMap = {}; // {domain: zim_name} — for cross-ZIM link classification
let _resolveCache = {}; // {url: {found, zim, path}} — cached batch resolve results
let zimsCache = null;
let _zimsByName = new Map();
function _rebuildZimsMap() { _zimsByName = new Map((zimsCache || []).map(z => [z.name, z])); }
function _zimInfo(name) { return _zimsByName.get(name) || null; }
let manageEnabled = false;
let _managePwRequired = false; // server is password-protected and we have no token yet
// Passwordless instance reached over a non-private hop: management is LAN-only
// and there is no password to enter, so we explain instead of prompting (#36).
let _managePublicLocked = false;
let _manageNeedsSetupKey = false;
let _manageUnlocked = true; // manage is always available (auth via env var only)

// May we hit ambient /manage/* endpoints (activity bar, peer discovery)?
// Yes when we hold a token, or when the server isn't password-protected.
// Avoids a stream of 401s/403s (and console noise) before the operator logs in.
function _canPollManage() { return !!_manageToken || (!_managePwRequired && !_managePublicLocked); }
let activeCategories = new Set();
let activeSourceFilters = new Set();
let allResults = {};
let searchController = null;
let searchTimer = null;
let suggestTimer = null;
let suggestItems = [];
let suggestIndex = -1;
let snippetController = null;
let collectionsCache = null; // {version, favorites, collections}
let _expandedCollection = null; // which collection is expanded for ZIM picking
// #37 home section order: array of "cat:<key>"/"col:<name>"/"other" keys.
// Populated by _fetchList from /list?layout=1; drives renderHome section ordering.
let _sectionOrder = [];
// #37 user-declared empty sections (category names with no ZIM yet). Offered as
// Move-to targets and reorder rows so a section can be created before it holds
// anything. Populated by _fetchList; written via _saveLibraryLayout({sections}).
let _declaredSections = [];
// The reserved category VALUE stored as an override to force a ZIM into the
// uncategorized "Other" bucket, and the client-internal group key that bucket
// uses. The heuristic never emits it, so its only source is an explicit move.
const OTHER_CAT = '__other__';
// The reserved section-order key for the Other section (server mirrors it).
const OTHER_KEY = 'other';
// Which ms-nav section to jump to after the (async) manage view mounts.
let _pendingMsSection = null;

// Single reader of /list — normalizes the additive ?layout=1 envelope
// ({zims, section_order}) back to the bare ZIM array every caller expects, and
// stashes the section order as a side effect. Older/plain array responses still
// work (section order simply stays empty).
async function _fetchList() {
  const r = await serverFetch('/list?layout=1');
  const data = await r.json();
  if (Array.isArray(data)) { _sectionOrder = []; _declaredSections = []; return data; }
  _sectionOrder = Array.isArray(data.section_order) ? data.section_order : [];
  _declaredSections = Array.isArray(data.sections) ? data.sections : [];
  return Array.isArray(data.zims) ? data.zims : [];
}
let homeScope = null; // {type:'favorites'|'category'|'collection', label, zimNames:[]}
// #34 library recency filter: null | 'added' | 'updated'. Transient view state —
// deliberately NOT persisted, so a reload always lands on the full library. An
// active pill narrows the existing home sections in place (like a language pill),
// combining with homeLangFilter (AND).
let homeRecentFilter = null;
// Library language filter: a Set of ZIM language codes. Empty = all languages.
// Transient view state — reset when leaving/entering a scope, never persisted,
// so a reload always lands on the full library. Multi-select toggle, matching
// the search-results lang pills.
let homeLangFilter = new Set();
// Home language filter pills live in the search dropdown, where the
// user picks a filter (see showHistoryDropdown). On home itself the pills row is
// hidden by default (clean home) and only appears above the content while a
// filter is actively applied, so its un-filter controls stay reachable.
// True only while pillsBar currently holds the home filter pills (vs the
// search-results source/language pills, which are always shown). Gates the
// visibility toggle so it never touches the search-results pills. Transient.
let _pillsAreHomeFilters = false;
// Cached recency+language pills HTML, rebuilt each renderHome, so the search
// dropdown can render the same pills at its top without recomputing.
let _homeFilterRowsHtml = '';
function _updateHomeFiltersVisibility() {
  if (!_pillsAreHomeFilters || !pillsBar.innerHTML) return;
  const filterActive = !!homeRecentFilter || homeLangFilter.size > 0;
  pillsBar.style.display = filterActive ? '' : 'none';
}


// ── Language filter ──
let activeLanguageFilters = new Set();

const RESULTS_PER_PAGE = 20;
let visibleResultCount = RESULTS_PER_PAGE;

// ── i18n ──
const _AVAILABLE_LANGS = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'zh', name: '中文' },
  { code: 'ar', name: 'العربية' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'he', name: 'עברית' },
];
const _RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur']);
let _i18n = {}; // current language strings
let _i18nFallback = {}; // English fallback
let _currentLang = 'en';

function t(key, vars) {
  var s = _i18n[key] || _i18nFallback[key] || key;
  if (vars) for (var k in vars) s = s.replaceAll('{' + k + '}', vars[k]);
  return s;
}
// HTML-escaped version of t() for use in innerHTML/attribute contexts
function tH(key, vars) {
  return t(key, vars).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// Localized pluralization: picks "<base>_<category>" via Intl.PluralRules for
// the active UI language, falling back to "<base>_other" when that category
// key does not exist. Locale files currently ship only _one/_other; languages
// with richer plural categories (ru few/many, ar, he...) resolve to _other
// until per-category keys are added. {n} is injected automatically.
function tPlural(base, n, vars) {
  var cat = 'other';
  try { cat = new Intl.PluralRules(_currentLang).select(Number(n) || 0); } catch (e) {}
  var key = base + '_' + cat;
  if (_i18n[key] === undefined && _i18nFallback[key] === undefined) key = base + '_other';
  var v = { n: n };
  if (vars) for (var k in vars) v[k] = vars[k];
  return t(key, v);
}
function tPluralH(base, n, vars) {
  return tPlural(base, n, vars).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _loadingHtml(key) { return '<div class="loading"><span class="spinner-inline"></span>' + tH(key || 'loading') + '</div>'; }

// In-app confirmation — replaces window.confirm everywhere (Eric: "Delete
// confirmation should be in app ui"). Reuses the password overlay's shell so
// it themes correctly on both palettes. Resolves true only on the primary
// button; overlay tap, Cancel, and Escape all resolve false.
function _appConfirm(message, okLabel) {
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'pw-overlay open';
    overlay.innerHTML =
      '<div class="pw-box" role="alertdialog" aria-modal="true">' +
        '<h3>' + esc(message) + '</h3>' +
        '<div class="pw-actions">' +
          '<button type="button" id="ac-cancel">' + tH('cancel') + '</button>' +
          '<button type="button" class="pw-primary" id="ac-ok">' + esc(okLabel || t('ok')) + '</button>' +
        '</div>' +
      '</div>';
    function done(answer) {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(answer);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
    }
    overlay.addEventListener('click', function(e) { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    overlay.querySelector('#ac-cancel').onclick = function() { done(false); };
    var ok = overlay.querySelector('#ac-ok');
    ok.onclick = function() { done(true); };
    ok.focus();
  });
}

async function _loadI18n(lang) {
  if (lang === 'en') {
    // Load English inline (always available)
    try {
      var res = await fetch('/static/i18n/en.json?v=' + _i18nVer);
      if (res.ok) { _i18nFallback = await res.json(); _i18n = _i18nFallback; }
    } catch(e) {}
    return;
  }
  // Load target language + English fallback in parallel
  try {
    var [langRes, enRes] = await Promise.allSettled([
      fetch('/static/i18n/' + lang + '.json?v=' + _i18nVer),
      fetch('/static/i18n/en.json?v=' + _i18nVer)
    ]);
    if (enRes.status === 'fulfilled' && enRes.value.ok) _i18nFallback = await enRes.value.json();
    if (langRes.status === 'fulfilled' && langRes.value.ok) _i18n = await langRes.value.json();
    else _i18n = _i18nFallback;
  } catch(e) { _i18n = _i18nFallback; }
}

function _detectLanguage() {
  // Check localStorage first, then browser language
  var saved = localStorage.getItem(SK.UI_LANG);
  if (saved && _AVAILABLE_LANGS.some(l => l.code === saved)) return saved;
  var nav = (navigator.language || '').split('-')[0].toLowerCase();
  if (_AVAILABLE_LANGS.some(l => l.code === nav)) return nav;
  return 'en';
}

function _applyRTL(lang) {
  if (_RTL_LANGS.has(lang)) {
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.lang = lang;
  } else {
    document.documentElement.removeAttribute('dir');
    document.documentElement.lang = lang;
  }
}

var _langLoadId = 0; // Guard against race conditions on rapid language switching
async function setLanguage(lang) {
  _currentLang = lang;
  localStorage.setItem(SK.UI_LANG, lang);
  var myId = ++_langLoadId;
  await _loadI18n(lang);
  if (_langLoadId !== myId) return; // Superseded by a newer setLanguage call
  _applyRTL(lang);
  _applyI18nToDOM();
  _renderLangDropdown();
  // Re-render current view so all dynamic strings update
  // Skip re-rendering when reader is open — renderSource auto-opens the ZIM homepage,
  // which would overwrite the article the user is reading.
  if (readerOpen) {
    // Just update topbar/labels — reader iframe content stays put
  } else if (mode === 'manage') {
    renderManage();
  } else if (mode === 'source' && currentSource) {
    renderSource(currentSource);
  } else {
    renderHome();
  }
  updateTopbar();
  // Re-render library panel if open
  var libPanel = document.getElementById('history-panel');
  if (libPanel && libPanel.classList.contains('open')) renderLibraryPanel();
  // If reading an article, re-check language banner in reader context
  if (readerOpen && currentArticle) _checkReaderLangBanner();
  // Sync almanac: re-render all content with new translations
  if (typeof _onGlobalLanguageChanged === 'function') _onGlobalLanguageChanged(lang);
  if (_almanacOpen && typeof _renderAlmanacContent === 'function') _renderAlmanacContent();
}

// Remove any stale language banner (actual banner logic lives in _renderLangDropdown)
function _checkReaderLangBanner() {
  var old = document.getElementById('lang-banner');
  if (old) old.remove();
}

// Legacy download-count badge shim. The topbar activity badge (.topbar-badge,
// see _applyActivityBadge) is now the single source of truth for the gear count
// — it already surfaces downloads plus indexing/seeding. Painting a second
// `.manage-badge` here stacked two badges on the same gear (double-badge bug),
// so this now just nudges the activity poll for immediate feedback on a
// download start/stop and lets that one badge own the gear. Kept as a named
// function so the download call sites read intentionally.
function _showManageBadge(show, count) {
  // Drop any stale `.manage-badge` left by an older cached app.js, then defer to
  // the activity badge.
  var btn = document.getElementById('manage-btn');
  var stale = btn && btn.querySelector('.manage-badge');
  if (stale) stale.remove();
  if (window._nudgeActivityPoll) window._nudgeActivityPoll();
}

function _langBannerDownload(lang, catMatch) {
  // Fallback for welcome card — drill into catalog
  var banner = document.getElementById('lang-banner');
  if (banner) { banner.remove(); }
  closeReader();
  manageTab = 'browse';
  var prefix = (catMatch === 'wikipedia' || !catMatch) ? 'wikipedia_' + lang + '_all' : null;
  _pendingDrill = { catKey: catMatch || 'wikipedia', lang: lang, namePrefix: prefix };
  enterManage();
}


function _applyI18nToDOM() {
  // Update static elements with data-i18n attributes
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(function(el) {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach(function(el) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
  // Update search placeholder based on current context
  _updateSearchPlaceholder();
}

function _updateSearchPlaceholder() {
  if (!q) return;
  if (mode === 'manage') {
    var manageMode = document.querySelector('.manage-tab.active');
    if (manageMode && manageMode.dataset.tab === 'catalog') {
      q.placeholder = t('search_catalog');
    } else {
      q.placeholder = t('filter_installed');
    }
  } else if (currentSource) {
    var info = _zimInfo(currentSource);
    q.placeholder = t('search_in', { source: (info && info.title) || currentSource });
  } else {
    q.placeholder = t('search_placeholder');
  }
}

// Sizes are DECIMAL, everywhere, and this is the only place that says so.
//
// The app used to divide by 1024 and print "GB" — a GiB wearing the wrong
// name — in five separate hand-rolled formatters that did not even agree with
// each other. At these file sizes the gap is not academic:
// wikipedia_en_all_maxi is 123,980,647,016 bytes, which Zimi called 115 GB
// while the NAS, Finder, df and Kiwix's own library page all called it 124 GB.
// Nine gigabytes of disagreement, on the screen whose job is answering "will
// this fit".
//
// The Python side's format_bytes() is this same function, thresholds and
// decimal places included, and tests/test_size_units.py holds the two to one
// table of expected strings so they cannot drift apart again.
var BYTES_PER_KB = 1000;
var BYTES_PER_MB = 1000 * 1000;
var BYTES_PER_GB = 1000 * 1000 * 1000;
// Where GB stops carrying a decimal: below ten a tenth says something about a
// ZIM, above it "115 GB" reads better than "115.5 GB" down a list.
var GB_WHOLE_FROM = 10;

function fmtBytes(bytes, html) {
  var b = Math.max(0, Number(bytes) || 0);
  var n, u;
  if (b < BYTES_PER_KB) { n = String(Math.round(b)); u = ' B'; }
  else if (b < BYTES_PER_MB) { n = (b / BYTES_PER_KB).toFixed(1); u = ' KB'; }
  else if (b < BYTES_PER_GB) { n = (b / BYTES_PER_MB).toFixed(1); u = ' MB'; }
  else {
    var gb = b / BYTES_PER_GB;
    n = gb >= GB_WHOLE_FROM ? String(Math.round(gb)) : gb.toFixed(1);
    u = ' GB';
  }
  return html ? '<span class="num">' + n + '</span>' + u : n + u;
}

// The same size, for the callers that only ever held a GB figure (the API's
// size_gb, which is now decimal GB computed from the same constant). One
// entry point too many, but zero implementations too many: it lands in
// fmtBytes like everything else, so nothing can quote a different number.
function fmtSize(gb, html) {
  return fmtBytes((Number(gb) || 0) * BYTES_PER_GB, html);
}
// Localized count line for a ZIM's card/info panel. Prefers the real article
// count (libzim `article_count`, added by the metadata cache) and falls back to
// the raw entry count for stale caches that predate the field. Empty string
// when neither is a number (e.g. an unreadable ZIM whose entries is '?').
function _zimCountHtml(z) {
  const n = _zimCount(z);
  // tPlural, not t: this line read "1 entries" on the home screen for every
  // single-article library — a 67MB medical collection announcing itself with
  // a grammar mistake. The helper has been here the whole time and this was
  // the one count that did not use it.
  return typeof n === 'number' ? tPlural('n_entries', n, {n: n.toLocaleString()}) : '';
}

// How many things a ZIM holds, as a person would count them.
//
// `article_count` is libzim's, and libzim only counts what the ZIM declares an
// ARTICLE. That is right for an encyclopedia and wrong for a document
// collection: every zimgit library — food preparation, knots, medicine,
// post-disaster, water — declares ONE article, its index, and keeps its
// hundreds of PDFs as ordinary entries. So the home screen introduced a 645MB
// survival library as "1 entry".
//
// A Zimi-made capture is the case where 1 is the truth: one page, plus the
// images and stylesheets that page needs. Those are marked, so they keep the
// article count and everything else falls back to entries when the article
// count is obviously not describing the ZIM.
function _zimCount(z) {
  if (!z) return undefined;
  const articles = typeof z.article_count === 'number' ? z.article_count : undefined;
  const entries = typeof z.entries === 'number' ? z.entries : undefined;
  if (articles === undefined) return entries;
  if (z.zimi_export) return articles;      // a capture really is one page
  if (articles <= 1 && entries > 1) return entries;
  return articles;
}
// True for ZIMs Zimi itself exported (bookmark exports). Server flags them
// from Creator metadata; the description sniff covers caches built before the
// flag existed. Their cards show the full creation date — for an export,
// "when did I make this" is the date that matters.
function _isZimiExport(z) {
  return !!(z && (z.zimi_export || /exported by Zimi/.test(z.description || '')));
}
// ── DOM refs ──
const q = document.getElementById('q');
const output = document.getElementById('output');

// Delegated click for the "Did you mean" correction link. The suggestion
// derives from third-party ZIM title words, so the anchor carries it in an
// HTML-attribute-encoded data-sugg (no inline onclick — a JS-string escape
// alone doesn't survive a double-quote in attribute position).
output.addEventListener('click', function(e) {
  var link = e.target.closest('.did-you-mean a[data-sugg]');
  if (!link) return;
  e.preventDefault();
  applyDidYouMean(link.getAttribute('data-sugg'));
});
const mainView = document.getElementById('main-view');
const statsBar = document.getElementById('stats-bar');
const pillsBar = document.getElementById('pills-bar');
const sourceHeaderEl = document.getElementById('source-header');
const searchMeta = document.getElementById('search-meta');
const logoEl = document.getElementById('logo');
const backBtn = document.getElementById('back-btn');
const bcSep = document.getElementById('bc-sep');
const bcIcon = document.getElementById('bc-icon');
const randomBtn = document.getElementById('random-btn');
const manageBtnEl = document.getElementById('manage-btn');
const _gearSvg = manageBtnEl.innerHTML; // capture gear icon for toggle
const newtabBtn = document.getElementById('newtab-btn');
const suggestDropdown = document.getElementById('suggest-dropdown');
const footerEl = document.getElementById('footer');

// ── Manage password ──
let _manageToken = '';
// Optional management username (v1.8). '' = none; when set it rides along in
// the X-Zimi-User header (see _authHeaders). Restored from storage on load.
let _manageUser = _readManageUser();
let _manageSavedReader = null; // saved reader state when entering manage
let _pwResolve = null;
let _pwReject = null;

// ── Multi-user session (v1.8) ──
// A logged-in NAMED USER (not admin). The session cookie does the actual
// server-side filtering; this just shapes the client chrome (hide the admin
// gear, show name + logout). null = admin or anonymous.
// {name, restricted, canCreate} — canCreate mirrors the account's per-user
// create permission (/whoami can_create); the server gates regardless.
let _userSession = null;
// When true, the password modal is in "sign in" mode (POST /login: user OR
// admin) rather than the admin-only manage-retry flow.
let _pwLoginMode = false;

var _ACCT_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

// Open the shared modal in sign-in mode (reachable by anyone, incl. a kid on a
// password-protected instance who can't open manage).
function openLoginModal() {
  _pwLoginMode = true;
  _pwResolve = null; _pwReject = null;
  openPwModal(t('sign_in'));
}

function _showPwError(msg) {
  var el = document.getElementById('pw-error');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
  var inp = document.getElementById('pw-input');
  if (inp) { inp.value = ''; inp.focus(); }
}

// POST /login → {status, j}. Cookie (if a user) is set by the server.
function doLogin(username, password, remember) {
  return fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username: username, password: password, remember: remember })
  }).then(function(r) { return r.json().then(function(j) { return { status: r.status, j: j }; }); });
}

// Apply a user session to the UI. Server-side filtering is already live via the
// cookie; here we hide manage and reload the (now restricted) library view.
function _applyUserSession(name, canCreate) {
  _userSession = { name: name, restricted: true, canCreate: !!canCreate };
  // A user is never admin — drop any admin token so ambient manage polls stop.
  _manageToken = ''; _clearManageToken();
  if (manageBtnEl) manageBtnEl.style.display = 'none';
  _refreshAfterAuthChange();
}

function userLogout() {
  fetch('/logout', { method: 'POST', credentials: 'same-origin' }).catch(function(){}).then(function() {
    _userSession = null;
    // Reboot at the ROOT so the boot gate re-runs from a clean anonymous state.
    // In private mode it re-shows the non-dismissible login gate (never a stale
    // library); in open/limited it reboots into the anonymous/filtered view. We
    // navigate to '/' (not reload the current URL): the user may be on a /w/
    // article that, reloaded anonymous in private mode, renders raw 401 JSON
    // instead of the gate. An in-place refetch would strand a private instance
    // on an empty home with no gate.
    location.replace('/');
  });
}

// Reload the library after a login/logout so the filtered view is reflected.
async function _refreshAfterAuthChange() {
  try { zimsCache = await _fetchList(); _rebuildZimsMap(); _libraryKnown = true; }
  catch (e) {
    zimsCache = [];
    _libraryKnown = false;
    _noteConn(_isOfflineError(e) ? CONN_OFFLINE : CONN_ERROR);
    _renderConnBanner();
  }
  if (typeof goHome === 'function') goHome();
  else route(false);
}

// Boot-time auth probe + gate. Runs BEFORE the library renders so a private
// instance paints the login form as its FIRST frame (no empty-chrome flash),
// and a token-authed admin is recognised without a spurious re-gate on reload.
// Returns true when the login gate was shown — the caller then skips the whole
// library boot; a successful sign-in reloads into a clean, authorised boot.
//
// Why whoami must carry the admin token: the admin's credential is a Bearer
// token kept in client storage, NOT the session cookie the named-user path
// rides on. A bare whoami (cookie only) can't see the admin, answers
// `anonymous + login_required`, and used to bounce a just-signed-in admin
// straight back to the login screen ("login wouldn't stick").
async function _bootAuthGate() {
  // Present any stored admin token so whoami can authenticate a token-admin.
  if (!_manageToken) { var saved = _readManageToken(); if (saved) _manageToken = saved; }
  var j;
  try {
    var r = await serverFetch('/whoami', {
      credentials: 'same-origin',
      headers: _manageToken ? _authHeaders() : {},
    });
    j = await r.json();
  } catch (e) {
    // Unreachable server: we cannot know whether this instance is private, so
    // we do NOT gate. Fall through to the normal boot, where /list will fail
    // the same way and the offline state (not a fake empty library) paints.
    return false;
  }
  // First-login hint: the server only sends this when the default username
  // ("admin") applies (no custom username, no named users). The login modal
  // reads it to show "Default username: admin".
  _defaultUsernameHint = (j && j.default_username) || '';
  if (j && j.role === 'user') {
    _userSession = { name: j.name, restricted: !!j.restricted, canCreate: !!j.can_create };
    if (manageBtnEl) manageBtnEl.style.display = 'none';
    return false;
  }
  if (j && j.role === 'admin') {
    return false;  // token-authed admin — proceed to the full library.
  }
  // Private public-access mode: an anonymous visitor (no valid cookie or token)
  // sees nothing but the login screen. The server already 401s every read; the
  // gate makes the CLIENT match with an opaque, non-dismissible login overlay
  // rendered as the first frame, instead of a half-populated home whose fetches
  // all fail in the background.
  if (j && j.login_required) {
    // A stored token that didn't authenticate above is stale — drop it so the
    // gate isn't skipped on the next reload.
    if (_manageToken) { _manageToken = ''; _clearManageToken(); }
    _applyI18nToDOM();  // localise the modal's static labels before it shows
    _enterLoginGate();
    return true;
  }
  return false;
}
// '' unless the server says the default username applies (see _bootAuthGate).
var _defaultUsernameHint = '';

// ── Login gate (private public-access mode) ──
// True while an anonymous visitor is held at the forced login screen.
var _loginRequired = false;
function _enterLoginGate() {
  _loginRequired = true;
  document.body.classList.add('login-gate');
  openLoginModal();
}
function _exitLoginGate() {
  _loginRequired = false;
  document.body.classList.remove('login-gate');
}

// Token-adding fetch for *ambient* /manage/* calls (activity bar, peer
// discovery, status/mirror polls). Sends the manage token when we have one
// so these work on password-protected servers, but never prompts for a
// password on 401 — background polling must fail silently, unlike the
// interactive manageFetch below.
// 429 responses surface as a typed error so callers keep their last-known
// content and reschedule, instead of rendering the error JSON as an empty
// state (the downloads panel used to blank itself this way, #30).
function _throwIfRateLimited(res) {
  if (res.status === 429) {
    var err = new Error('rate_limited');
    err.rateLimited = true;
    err.retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10) || 5;
    throw err;
  }
  return res;
}

function authedFetch(url, opts) {
  opts = opts || {};
  if (_manageToken) {
    opts.headers = Object.assign({}, opts.headers, _authHeaders());
  }
  return fetch(url, opts).then(_throwIfRateLimited);
}

function manageFetch(url, opts) {
  opts = opts || {};
  if (_manageToken) {
    opts.headers = Object.assign({}, opts.headers, _authHeaders());
  }
  return fetch(url, opts).then(_throwIfRateLimited).then(function(res) {
    if (res.status === 401) {
      return new Promise(function(resolve, reject) {
        // Single auth door: any unauthorized manage call opens the UNIFIED
        // sign-in modal (there is no separate "Sign in" entry). It accepts a
        // named user (→ their filtered library) OR the admin (→ full manage);
        // submitPw routes /login by role. For the admin case it calls the
        // resolver below, which verifies the token by retrying THIS request.
        _pwLoginMode = true;
        var rejectFn = function() {
          // User cancelled — leave manage view
          goHome();
          reject(new Error('auth_cancelled'));
        };
        _pwResolve = function(token) {
          // Verify password (and username, if any) before accepting it.
          // submitPw has already set _manageUser from the modal field, so
          // _authHeaders folds in the X-Zimi-User header.
          var verifyOpts = Object.assign({}, opts);
          verifyOpts.headers = Object.assign({}, verifyOpts.headers, _authHeaders(token));
          fetch(url, verifyOpts).then(function(retryRes) {
            if (retryRes.status === 401) {
              // Wrong password — show error, restore reject handler, keep modal open
              document.getElementById('pw-error').textContent = t('wrong_password');
              document.getElementById('pw-error').style.display = 'block';
              document.getElementById('pw-input').value = '';
              document.getElementById('pw-input').focus();
              _pwReject = rejectFn;
              return;
            }
            // Correct password
            _manageToken = token;
            _saveManageToken(token, document.getElementById('pw-remember').checked);
            closePwModal();
            resolve(retryRes);
          });
        };
        _pwReject = rejectFn;
        openPwModal(t('sign_in'));
      });
    }
    return res;
  });
}

function manageLogout() {
  _manageToken = '';
  _clearManageToken();
  // Drop any server-side session too — a SECONDARY admin authenticates to a
  // session cookie, not just the client-held token — then reboot at the ROOT so
  // the boot gate re-runs anonymous. Without the reboot the admin keeps the full
  // library they already loaded on screen: in private mode that reads as "logged
  // out but still see everything" even though the server now 401s every
  // anonymous read. We navigate to '/' (not reload the current URL): an admin
  // can now open articles in private mode, so the current URL may be a /w/
  // article that, reloaded anonymous, renders raw 401 JSON instead of the gate.
  fetch('/logout', { method: 'POST', credentials: 'same-origin' })
    .catch(function(){})
    .then(function() { location.replace('/'); });
}

// Element that had focus before the modal opened; we restore focus
// here on close so keyboard users don't lose their place.
let _pwPreviousFocus = null;

function openPwModal(title, opts) {
  document.getElementById('pw-title').textContent = title || t('enter_password');
  // Prefill: the session's known username (change-password continuity), else the
  // server-flagged default. The default is 'admin' ONLY when the sole account is
  // the primary admin (server sends default_username then — see _bootAuthGate);
  // once named users exist the field starts blank so a user types their own name
  // rather than a misleading 'admin'.
  var uEl = document.getElementById('pw-username');
  if (uEl) uEl.value = _manageUser || _defaultUsernameHint || '';
  // First-login hint ("Default username: admin") — only in sign-in mode and
  // only when the server says the default applies (no custom username/users).
  var hintEl = document.getElementById('pw-username-hint');
  if (hintEl) {
    var showHint = _pwLoginMode && !!_defaultUsernameHint;
    hintEl.style.display = showHint ? 'block' : 'none';
    if (showHint) hintEl.textContent = t('default_username_hint').replace('{name}', _defaultUsernameHint);
  }
  document.getElementById('pw-input').value = '';
  document.getElementById('pw-input').placeholder = (opts && opts.placeholder) || t('password');
  document.getElementById('pw-input').autocomplete = (opts && opts.hideRemember) ? 'new-password' : 'current-password';
  document.getElementById('pw-error').style.display = 'none';
  document.getElementById('pw-remember-row').style.display = (opts && opts.hideRemember) ? 'none' : 'flex';
  document.getElementById('pw-remove-btn').style.display = 'none';
  // The private-mode login gate is non-dismissible (closePwModal no-ops while
  // _loginRequired), so hide the Cancel button there — an inert Cancel just
  // reads as broken. It shows in every other (dismissible) use of the modal.
  var pwCancel = document.getElementById('pw-cancel');
  if (pwCancel) pwCancel.style.display = _loginRequired ? 'none' : '';
  _pwPreviousFocus = document.activeElement;
  const overlay = document.getElementById('pw-overlay');
  overlay.classList.add('open');
  document.addEventListener('keydown', _pwKeyHandler);
  setTimeout(function() { document.getElementById('pw-input').focus(); }, 50);
}

function closePwModal() {
  // The private-mode login gate is non-dismissible: Cancel / Esc / any close
  // path is a no-op, since there is nothing behind it but 401s. Only a
  // successful sign-in (which calls _exitLoginGate) can leave.
  if (_loginRequired) return;
  document.getElementById('pw-overlay').classList.remove('open');
  document.removeEventListener('keydown', _pwKeyHandler);
  if (_pwReject) { _pwReject(); _pwReject = null; }
  _pwResolve = null;
  _pwLoginMode = false;  // never leave sign-in mode armed for the next opener
  // Restore focus to where the user was before we hijacked it.
  if (_pwPreviousFocus && typeof _pwPreviousFocus.focus === 'function') {
    try { _pwPreviousFocus.focus(); } catch (_) {}
  }
  _pwPreviousFocus = null;
}

function _pwKeyHandler(e) {
  // Esc closes the modal — standard a11y pattern for dialogs. Exception: the
  // login gate (private mode) is non-dismissible — there is nothing behind it
  // to reveal, so Esc is swallowed.
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!_loginRequired) closePwModal();
    return;
  }
  // Tab focus-trap: cycle within the modal so keyboard users can't
  // accidentally escape to the background page.
  if (e.key !== 'Tab') return;
  const overlay = document.getElementById('pw-overlay');
  if (!overlay || !overlay.classList.contains('open')) return;
  const focusables = overlay.querySelectorAll(
    'input:not([type=hidden]):not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
  );
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function submitPw() {
  const pw = document.getElementById('pw-input').value.trim();
  if (!pw) return;
  // Capture the optional username so _authHeaders sends X-Zimi-User on the
  // verify/retry. Blank field → 'admin' (matches the passwordless keychain UX
  // and the server's any-value-passes rule when no username is configured).
  const uEl = document.getElementById('pw-username');
  const uname = (uEl && uEl.value.trim()) || 'admin';
  _manageUser = uname;
  // Sign-in mode: unified /login (a named user OR the admin account).
  if (_pwLoginMode) {
    const remember = document.getElementById('pw-remember').checked;
    doLogin(uname, pw, remember).then(function(res) {
      if (res.status !== 200) { _showPwError(t('wrong_password')); return; }
      if (res.j.role === 'user') {
        // Named user: no manage powers. Abandon any pending manage request
        // (it's admin-only — retrying would just 401 again) and switch to the
        // filtered library. Their account state lives in Manage → Users.
        _pwResolve = null; _pwReject = null;
        _pwLoginMode = false;
        // Leaving the private-mode gate: reload into a clean authenticated
        // state so the whole app boots with the session's filtered view.
        if (_loginRequired) { _exitLoginGate(); location.reload(); return; }
        closePwModal();
        _applyUserSession(res.j.name, !!res.j.can_create);
        return;
      }
      // Admin via the sign-in modal. A SECONDARY admin authenticates to a
      // session token (res.j.token); the PRIMARY admin's token is the password.
      var tok = res.j.token || pw;
      if (res.j.secondary && res.j.name) _manageUser = res.j.name;
      _pwLoginMode = false;
      if (_pwResolve) {
        // Opened from a manage 401: hand the token to the resolver, which
        // verifies it by retrying the original request, persists it, closes the
        // modal, and resolves so the in-flight manage view paints in place.
        var resolver = _pwResolve; _pwResolve = null; _pwReject = null;
        resolver(tok);
      } else if (_loginRequired) {
        // Admin signing in from the private-mode gate: persist the token and
        // reload into a clean, fully authorized boot (whoami → admin, no gate).
        _manageToken = tok; _saveManageToken(tok, remember);
        _exitLoginGate();
        location.reload();
      } else {
        // Opened directly (no pending request): store the token and enter
        // manage deterministically (enterManage, never toggleManage — the
        // latter would toggle OFF when opened from within manage).
        _manageToken = tok; _saveManageToken(tok, remember);
        closePwModal();
        if (typeof enterManage === 'function') enterManage();
      }
    });
    return;
  }
  if (_pwResolve) {
    _pwReject = null;  // prevent cancel on close
    document.getElementById('pw-error').style.display = 'none';
    _pwResolve(pw);
    // Don't close modal here — manageFetch closes it after verifying the password works
  }
}

// Breadcrumb identity for the Almanac — a calendar-with-a-star glyph, sized to
// match a ZIM's 22px icon, tinted by the chrome via currentColor.
var _ALMANAC_BC_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18"/><path d="M8 2.5v4M16 2.5v4"/><path d="M12 12l.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z"/></svg>';

// ── Topbar ──
function updateTopbar() {
  const activeSource = currentSource || readerSource;
  // Back button: show when user has navigated deep enough that the breadcrumb
  // icons (Zimi logo = home, source icon = ZIM top-level) aren't sufficient.
  // That means: article history exists (stepped into articles), scoped home
  // view, or search results. NOT shown for basic reader-open-from-source
  // (back = click source icon or Escape).
  const showBack = articleHistory.length > 0 || mode === 'search' || homeScope;
  backBtn.style.display = showBack ? 'flex' : 'none';

  // Breadcrumb: Zimi / [icon] — search bar shows source name as placeholder.
  // The Almanac opens as an overlay over the home/ZIM view but is its own
  // destination, so it shows its OWN identity here (icon + "Almanac"), mirroring
  // how entering a ZIM does — never the underlying ZIM's icon bleeding through.
  if (_almanacOpen) {
    bcSep.style.display = 'inline';
    bcIcon.style.display = 'inline-flex';
    bcIcon.title = t('almanac');
    bcIcon.innerHTML = _ALMANAC_BC_ICON;
    // Identity only — no destination behind it, so no link affordance either.
    bcIcon.removeAttribute('href');
  } else if (activeSource) {
    bcSep.style.display = 'inline';
    bcIcon.style.display = 'inline-flex';
    const info = _zimInfo(activeSource);
    const title = _zimTitle(activeSource);
    bcIcon.title = title;
    // Real link (#49): the source view has a true URL, so right/middle/
    // modifier clicks can open it in a new tab; bcClick keeps plain clicks SPA.
    bcIcon.setAttribute('href', '/w/' + encodeURIComponent(activeSource));
    if (info && info.has_icon) {
      bcIcon.innerHTML = '<img src="/w/' + encodeURIComponent(activeSource) + '/-/icon" alt="" width="22" height="22" alt="' + escAttr(title) + '">';
    } else {
      bcIcon.innerHTML = '<span class="bc-letter">' + (esc(title)[0] || 'Z').toUpperCase() + '</span>';
    }
  } else {
    bcSep.style.display = 'none';
    bcIcon.style.display = 'none';
    bcIcon.title = '';
    bcIcon.removeAttribute('href');
  }

  // Manage/Almanac: gear → X close. Reader open: gear → X close reader.
  // Always show this button so topbar has a stable 4-icon layout.
  var _closeSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  // Every "this slot is now a close X" case differs only in what the click does
  // and whether the button is highlighted, so they share one setter.
  var _setCloseBtn = function(onclick, highlighted) {
    manageBtnEl.innerHTML = _closeSvg;
    manageBtnEl.title = t('close');
    manageBtnEl.style.color = highlighted ? 'var(--amber)' : '';
    manageBtnEl.style.borderColor = highlighted ? 'var(--amber-border)' : '';
    manageBtnEl.style.background = highlighted ? 'var(--amber-glow)' : '';
    manageBtnEl.onclick = onclick;
  };
  if (mode === 'manage') {
    manageBtnEl.style.display = 'flex';
    _setCloseBtn(function(e) { toggleManage(e); }, true);
  } else if (_createOpen) {
    manageBtnEl.style.display = 'flex';
    _setCloseBtn(closeCreate, false);
  } else if (_almanacOpen || readerOpen) {
    // Hide X when another button takes the 4th slot (save on desktop, pop-out on
    // web). On mobile .manage-btn is hidden anyway (close is the back-btn /
    // breadcrumb) and the pop-out now lives in the ... menu, so this only affects
    // desktop-web where the inline pop-out still shows.
    var hasSaveBtn = !_almanacOpen && IS_DESKTOP && currentArticle && /\.(pdf|epub)$/i.test(currentArticle.path || '');
    // Pop-out (open in browser) only makes sense from an installed/standalone
    // PWA — in a plain browser tab you're already in a browser, so it's hidden
    // (the close X takes the slot back).
    var hasNewtab = !_almanacOpen && readerOpen && _isStandalonePWA();
    manageBtnEl.style.display = (hasSaveBtn || hasNewtab) ? 'none' : 'flex';
    _setCloseBtn(_almanacOpen ? closeAlmanac : function() { closeReader(); goHome(); }, false);
  } else {
    manageBtnEl.style.display = 'flex';
    manageBtnEl.innerHTML = _gearSvg;
    manageBtnEl.title = t('library_manager');
    manageBtnEl.style.color = '';
    manageBtnEl.style.borderColor = '';
    manageBtnEl.style.background = '';
    manageBtnEl.onclick = function(e) { toggleManage(e); };
  }

  newtabBtn.style.display = (readerOpen && !_almanacOpen && _isStandalonePWA()) ? 'flex' : 'none';
  // Reader-only controls: font scale (always when reading) + read-aloud (only
  // when the browser exposes the offline Web Speech API). Hidden when the
  // reader isn't the active surface — and read-aloud never appears at all
  // when unsupported, so no dead button.
  var _readingArticle = readerOpen && !_almanacOpen;
  // On a phone the reader topbar was carrying nine controls. Font size and
  // Read aloud are the two least-reached, and both already live in the ⋯
  // menu's reader group — so on a narrow viewport they fold there and leave
  // the inline row to the essentials (Eric: reconsider what's behind ⋯, we
  // have a lot going on). Desktop keeps them inline; the space is there.
  var _foldReaderExtras = _readingArticle && _isNarrow();
  var fontBtn = document.getElementById('font-btn');
  if (fontBtn) fontBtn.style.display = (_readingArticle && !_foldReaderExtras) ? 'flex' : 'none';
  // Bookmarks-panel opener — reader only (#65). Everywhere else the library
  // button already opens the panel, but while reading it becomes the
  // save-bookmark toggle, which left the bookmark tree unreachable without
  // leaving the article. Deliberately NOT folded into the ⋯ menu: reaching a
  // saved article should stay one tap from the page you're on.
  var bmPanelBtn = document.getElementById('bm-panel-btn');
  if (bmPanelBtn) bmPanelBtn.style.display = _readingArticle ? 'flex' : 'none';
  var ttsBtn = document.getElementById('tts-btn');
  if (ttsBtn) ttsBtn.style.display = (_readingArticle && _TTS_AVAILABLE && !_foldReaderExtras) ? 'flex' : 'none';
  _syncReaderViewBtn(); // book/reader-view glyph — gated on extractable content
  // Desktop: show save button when viewing a downloadable file (PDF, EPUB)
  var saveBtn = document.getElementById('save-btn');
  if (saveBtn) {
    var showSave = IS_DESKTOP && readerOpen && currentArticle &&
      /\.(pdf|epub)$/i.test(currentArticle.path || '');
    saveBtn.style.display = showSave ? 'flex' : 'none';
  }
  randomBtn.style.display = (mode !== 'manage' && !_almanacOpen && !_createOpen) ? 'flex' : 'none';
  document.getElementById('library-btn').style.display = (mode !== 'manage' && !_almanacOpen && !_createOpen) ? 'flex' : 'none';
  // Create-a-ZIM lives in the ⋯ menu at every width — creation is an
  // occasional, deliberate act, so it stays out of the primary topbar. The ⋯
  // trigger is CSS-hidden on a wide viewport at rest, so reveal it (inline
  // style; the mobile !important rules still win) whenever the menu would
  // carry the Create row. See _buildTopbarMenuHtml.
  _createRememberCanShow();
  // Also revealed while the Create page itself is up: with + gone from the
  // topbar, the ⋯ menu is the only route OUT of that page (Manage, Language)
  // on a wide viewport — hiding it there strands the admin.
  var moreBtn = document.querySelector('.topbar-more');
  if (moreBtn) {
    moreBtn.style.display = (_createMenuRowAvailable() || _createOpen) ? 'flex' : '';
    _syncTopbarMoreSolo(moreBtn);
  }
  document.getElementById('lang-selector-btn').style.display =
    _getStorageFlag(SK.HIDE_LANG_CHOOSER) ? 'none' : '';
  _updateLibraryBtnIcon();

  // Search placeholder
  if (_almanacOpen) {
    q.placeholder = t('almanac');
  } else if (currentSource) {
    q.placeholder = _zimTitle(currentSource);
  } else if (readerOpen && readerSource) {
    q.placeholder = _zimTitle(readerSource);
  } else if (mode === 'manage') {
    if (manageTab === 'installed') {
      q.placeholder = t('filter_installed');
    } else if (manageCategoryFilter) {
      const catMeta = BROWSE_CATEGORIES.find(c => c.key === manageCategoryFilter);
      q.placeholder = t('search_in', {source: catMeta ? t(catMeta.i18n) : manageCategoryFilter});
    } else {
      q.placeholder = t('search_catalog');
    }
  } else if (homeScope) {
    q.placeholder = t('search_in', {source: homeScope.label});
  } else {
    q.placeholder = t('search_placeholder');
  }

  // Footer
  updateFooter();

  // Batch-download bar only belongs to the Catalog tab — hide elsewhere,
  // keeping the selection so it reappears when the user returns.
  _renderSelectionBar();

  document.body.classList.toggle('in-manage', mode === 'manage');
  // Reading an article: the inline Reader View / font / read-aloud controls fold
  // into the ⋯ menu (desktop too, matching mobile), and CSS `order` pins the
  // close X to the far right with ⋯ just before it. No DOM is moved — display
  // and flex order only — so repeated opens can't duplicate any button.
  document.body.classList.toggle('reading', _readingArticle);

  // Re-attach the background-activity badge: this function rewrites the gear's
  // innerHTML above (wiping any child badge), and Manage mode suppresses it
  // (that view surfaces downloads in its own tabs). Safe no-op before the first
  // poll (badge state defaults to inactive).
  _applyActivityBadge();
}

function bcClick(e) {
  // Clicking the icon in the breadcrumb goes to the source view
  if (e.target.closest && e.target.closest('#logo')) return; // the logo's own handler navigates
  if (_anchorNativeClick(e)) return; // bc-icon is a real link (#49) — new-tab gestures stay native
  e.preventDefault();
  if (_almanacOpen) return; // the Almanac breadcrumb is identity only — no nav into the ZIM behind it
  if (currentSource && (readerOpen || mode === 'search')) {
    if (readerOpen) closeReader();
    enterSource(currentSource, false);
  }
}

function updateFooter() {
  if (readerOpen) {
    footerEl.style.display = 'none';
  } else {
    footerEl.style.display = '';
  }
}

// ── Connection state ──
//
// Absence of data is not data. The PWA shell is service-worker cached, so it
// boots perfectly well with a dead backend; before this, every data fetch that
// failed fell into the same `catch { zimsCache = [] }` as a server that
// genuinely answered "you have zero ZIMs", and home rendered a confident "No
// knowledge sources found". That reads as "my library was wiped".
//
// Every server exchange is classified into exactly one of three states:
//   'online'  — the server answered. ANY HTTP status counts, including 401/403
//               /404/500: an answer is an answer, and the auth gate owns 401.
//   'offline' — the request never reached the server: fetch threw at the
//               network layer, or the service worker returned its synthetic
//               offline response (X-Zimi-Offline) in place of one.
//   'error'   — the server answered but the payload was unusable (malformed
//               JSON, unexpected shape). Rare, and still not "you own nothing".
// Auth-gating is deliberately NOT a connection state: _bootAuthGate owns it.
const CONN_OK = 'online', CONN_OFFLINE = 'offline', CONN_ERROR = 'error';
// Reconnect probe backoff, ms. Capped so a long outage settles into a cheap
// 30s heartbeat rather than hammering a server that may be mid-restart.
const CONN_PROBE_STEPS = [3000, 5000, 10000, 20000, 30000];
let _connState = CONN_OK;
// False once an attempt to load /list failed for ANY reason. Gates every
// "no ZIMs" claim in the UI: we only assert an empty library when the server
// actually told us it was empty.
let _libraryKnown = true;
let _connProbeTimer = null;
let _connProbeStep = 0;
let _connProbeSeq = 0;
let _connRecovering = false;

// Tagged error meaning "never reached the server". Thrown by serverFetch so
// callers can branch on cause without re-sniffing the failure.
function _offlineError() {
  const e = new Error('zimi-offline');
  e.zimiOffline = true;
  return e;
}
function _isOfflineError(e) { return !!(e && e.zimiOffline); }

// The service worker's stand-in for an answer, not an answer from the server.
function _isOfflineResponse(res) {
  if (!res) return false;
  try {
    if (res.headers.get('X-Zimi-Offline') === '1') return true;
    // Older cached SW without the header: its offline page is the only 503 that
    // returns HTML from an endpoint the app only ever asks for JSON.
    return res.status === 503 && (res.headers.get('Content-Type') || '').indexOf('text/html') === 0;
  } catch (e) { return false; }
}

// Mirrors sw.js NETWORK_ONLY_PREFIXES. A 200 from any OTHER route may have come
// out of the service worker's cache, which proves nothing about the server being
// up — it is exactly how a dead backend came to look reachable. Only these
// routes (and the cache-busted /health probe) can promote the state to online.
const _LIVE_PROOF_PREFIXES = ['/whoami', '/login', '/logout', '/list', '/search', '/suggest', '/random'];
function _isLiveProof(url) {
  const p = String(url).split('?')[0];
  for (let i = 0; i < _LIVE_PROOF_PREFIXES.length; i++) {
    const pre = _LIVE_PROOF_PREFIXES[i];
    if (p === pre || p.indexOf(pre + '/') === 0) return true;
  }
  return String(url).indexOf('/health?ping=') === 0;
}

// The single front door for anything that talks to the Zimi server. Classifies
// the outcome (updating the banner as a side effect) and throws a tagged
// offline error rather than letting an unreachable server masquerade as data.
//
// The classification is deliberately asymmetric: a failure ALWAYS proves the
// server is unreachable (nothing else produces the SW's offline response), but a
// success only proves it when the route could not have been served from cache.
async function serverFetch(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    _noteConn(CONN_OFFLINE);
    throw _offlineError();
  }
  if (_isOfflineResponse(res)) {
    _noteConn(CONN_OFFLINE);
    throw _offlineError();
  }
  if (_isLiveProof(url)) _noteConn(CONN_OK);
  return res;
}

// Record the outcome of a server exchange. Transitions drive the banner and,
// on a fall to offline, start the reconnect probe.
function _noteConn(state) {
  if (state === _connState) {
    // Still online and the library is stale-unknown from an earlier outage
    // (e.g. only /list failed): keep probing until the library is back.
    if (state === CONN_OK && !_libraryKnown && !_connProbeTimer) _scheduleConnProbe();
    return;
  }
  _connState = state;
  if (state === CONN_OK) {
    _stopConnProbe();
    _renderConnBanner();
  } else {
    _renderConnBanner();
    _scheduleConnProbe();
  }
}

// ── Connection banner ──
// Calm, persistent, non-blocking. Sits between the topbar and the content (it
// pushes rather than overlays, so cached articles and the almanac stay fully
// readable) and offers an explicit Retry alongside the automatic probe.
function _connBannerEl() {
  let el = document.getElementById('conn-banner');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'conn-banner';
  el.className = 'conn-banner';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
  return el;
}

function _renderConnBanner() {
  const offline = _connState !== CONN_OK;
  if (!offline && _libraryKnown) {
    const existing = document.getElementById('conn-banner');
    if (existing) existing.remove();
    document.documentElement.style.setProperty('--conn-h', '0px');
    return;
  }
  const el = _connBannerEl();
  // Server answered but we still can't show the library: a different, honest
  // sentence from "no network at all".
  const msgKey = _connState === CONN_OFFLINE ? 'conn_offline_msg'
    : (_connState === CONN_ERROR ? 'conn_error_msg' : 'conn_library_stale_msg');
  el.innerHTML =
    '<span class="conn-dot" aria-hidden="true"></span>' +
    '<span class="conn-msg">' + tH(msgKey) + '</span>' +
    '<button type="button" class="conn-retry" onclick="_connRetryClick(this)">' + tH('conn_retry') + '</button>';
  _syncConnBannerHeight();
}

// The banner's height is content-dependent (it wraps on narrow screens), so the
// layout offset every under-topbar surface uses is measured, not assumed.
function _syncConnBannerHeight() {
  const el = document.getElementById('conn-banner');
  const h = el ? el.offsetHeight : 0;
  document.documentElement.style.setProperty('--conn-h', h + 'px');
}

function _connRetryClick(btn) {
  if (btn) { btn.disabled = true; btn.textContent = t('conn_retrying'); }
  _connProbeStep = 0;
  _connProbeNow();
}

function _stopConnProbe() {
  if (_connProbeTimer) { clearTimeout(_connProbeTimer); _connProbeTimer = null; }
  _connProbeStep = 0;
}

function _scheduleConnProbe() {
  if (_connProbeTimer) return;
  const delay = CONN_PROBE_STEPS[Math.min(_connProbeStep, CONN_PROBE_STEPS.length - 1)];
  _connProbeTimer = setTimeout(function() {
    _connProbeTimer = null;
    _connProbeStep++;
    _connProbeNow();
  }, delay);
}

// One reachability check. The cache-busting query is deliberate: /health is a
// network-first route, so a plain request could be answered from the SW cache
// and report a dead server as alive.
async function _connProbeNow() {
  if (_connRecovering) return;
  const seq = ++_connProbeSeq;
  _connRecovering = true;
  let reachable = false;
  try {
    await serverFetch('/health?ping=' + Date.now(), { cache: 'no-store' });
    reachable = true;
  } catch (e) {
    reachable = false;
  }
  _connRecovering = false;
  if (seq !== _connProbeSeq) return;  // superseded by a newer probe
  if (!reachable) { _renderConnBanner(); _scheduleConnProbe(); return; }
  await _connRecover();
}

// The server is back. Reload the library and repaint whatever the user is
// looking at, so recovery needs no manual reload.
async function _connRecover() {
  const hadLibrary = _libraryKnown;
  try {
    zimsCache = await _fetchList();
    _rebuildZimsMap();
    _libraryKnown = true;
  } catch (e) {
    _noteConn(_isOfflineError(e) ? CONN_OFFLINE : CONN_ERROR);
    _scheduleConnProbe();
    return;
  }
  _stopConnProbe();
  _renderConnBanner();
  if (!hadLibrary) {
    // Only announce when something actually changed on screen.
    _showToast(t('conn_restored'));
    if (mode === 'manage') renderInstalled();
    else if (!readerOpen && !currentSource && !readerSource) renderHome();
  }
}

// Browser-level connectivity events are a hint, not the truth (a laptop can be
// on Wi-Fi with the Zimi server down, or offline-flagged yet reachable on LAN),
// so a regain triggers a probe rather than clearing the banner outright.
function _bindConnEvents() {
  window.addEventListener('online', function() { _connProbeStep = 0; _connProbeNow(); });
  window.addEventListener('offline', function() { _noteConn(CONN_OFFLINE); });
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && (_connState !== CONN_OK || !_libraryKnown)) {
      _connProbeStep = 0;
      _connProbeNow();
    }
  });
  window.addEventListener('resize', _syncConnBannerHeight);
}

// Shared honest-empty markup for any surface that would otherwise assert "no
// ZIMs" while _libraryKnown is false.
function _libraryUnavailableHtml() {
  return '<div class="empty conn-empty">' +
    '<p>' + tH('library_unavailable') + '</p>' +
    '<p class="hint">' + tH('library_unavailable_hint') + '</p>' +
    '<button type="button" class="conn-retry conn-retry-inline" onclick="_connRetryClick(this)">' + tH('conn_retry') + '</button>' +
    '</div>';
}

// ── Init ──
async function init() {
  // Re-apply the app theme (the head bootstrap already stamped it pre-paint) and
  // start live-tracking the OS preference when in Auto mode.
  _applyAppTheme();
  _bindAppThemeMedia();
  // bfcache restore (Safari back/forward) re-runs no other script — re-assert
  // the theme so a restored page can't paint with a stale scheme.
  window.addEventListener('pageshow', function(e) { if (e.persisted) _applyAppTheme(); });
  // Initialize i18n before anything else
  _currentLang = _detectLanguage();
  _applyRTL(_currentLang);
  await _loadI18n(_currentLang);

  // Decide auth BEFORE any library chrome paints. On a private instance an
  // anonymous visitor gets the login form as the first frame (no empty flash),
  // and a token-authed admin is recognised so a reload never re-gates them. A
  // shown gate reloads the page on successful sign-in, so we stop the boot here.
  if (await _bootAuthGate()) return;

  // Learn manage-auth state in parallel with /list. /manage/has-password is a
  // cheap, lock-free endpoint, so this resolves long before /list on a large
  // library — the gear is then live the moment the library paints instead of
  // dead until the whole boot finishes (#44). _initSecondary reuses this probe.
  _manageProbe = _probeManageAuth();

  _bindConnEvents();
  // Paint the topbar BEFORE blocking on /list. The shell is fully interactive
  // from here on — the ⋯ menu (Create rides the remembered hint), search — so a
  // tap during a slow library load reaches a live control instead of landing on
  // a button that has not been drawn yet. updateTopbar runs again with real
  // authority once /list and the manage probe land, and corrects anything the
  // hint got wrong.
  updateTopbar();
  output.innerHTML = '<div class="loading"><span class="spinner-inline"></span>' + tH('loading_library') + '</div>';
  // Only block on /list — everything else loads in background.
  // A failure here must NOT collapse into "the library is empty": zimsCache
  // stays a safe [] for the hundreds of call sites that iterate it, but
  // _libraryKnown records that the emptiness is our ignorance, not a fact.
  try {
    zimsCache = await _fetchList();
    _libraryKnown = true;
  } catch(e) {
    zimsCache = [];
    _libraryKnown = false;
    _noteConn(_isOfflineError(e) ? CONN_OFFLINE : CONN_ERROR);
    _renderConnBanner();
  }
  _rebuildZimsMap();
  // Migrate bookmarks if ZIM names changed
  _migrateBookmarks();
  // Render immediately with what we have
  if (!history.state) history.replaceState({ mode: 'home' }, '', location.href);
  _applyI18nToDOM();
  route(false);
  _desktopCheckOnboarding();
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/static/sw.js', { scope: '/' }).catch(function() {});
  }
  // Fetch secondary data in parallel, update UI as each arrives
  _initSecondary();
}

// Resolves once we know whether the server wants a password. Ambient
// pollers await this so they never fire an unauthenticated request (a 401
// resource error in the console) during the bootstrap race.
let _manageProbe = null;
// True once _probeManageAuth has finished at least once — lets enterManage
// tell "manage genuinely disabled" (bail) apart from "state not known yet"
// (open on demand). See #44.
let _manageProbed = false;

async function _probeManageAuth() {
  try {
    // Public pre-auth endpoint — learns password state without a 401 probe.
    const hres = await serverFetch('/manage/has-password');
    if (!hres.ok) { manageEnabled = false; return; }  // 404 = manage disabled
    manageEnabled = true;
    const h = await hres.json();
    const saved = _readManageToken();
    if (saved) _manageToken = saved;
    if (h.has_password && !_manageToken) {
      _managePwRequired = true;  // protected + not yet authenticated
      return;
    }
    const mres = await authedFetch('/manage/status');
    if (mres.ok) {
      const mdata = await mres.json();
      manageEnabled = !!mdata.manage_enabled;
    } else if (mres.status === 403) {
      // Passwordless instance, non-private client: no password exists to enter,
      // so surface an explanation instead of a bogus prompt (#36). manage stays
      // "enabled" so the tab is reachable and renders the locked banner.
      _managePublicLocked = true;
      // Bootstrap-from-remote: the server has no password AND we are not on the
      // host, so the door is the setup key it printed to its log, not a
      // password (GHSA-5mw2-53vv-9pw6). Remember which locked state this is so
      // the banner asks for the right thing.
      try {
        var _ld = await mres.clone().json();
        _manageNeedsSetupKey = !!(_ld && _ld.needs_setup_key);
      } catch (e) { _manageNeedsSetupKey = false; }
    } else if (mres.status === 401) {
      // Stored token went stale — drop BOTH copies (leaving the persisted
      // one meant every future load retried it, 401'd, and re-prompted).
      _manageToken = '';
      _clearManageToken();
      _managePwRequired = true;
    }
  } catch (e) {}
  finally { _manageProbed = true; }
}

async function _initSecondary() {
  var needsRerender = false;
  // Reuse the probe init() already kicked off in parallel with /list; only
  // start one here if that didn't run (e.g. a code path that skips init()).
  if (!_manageProbe) _manageProbe = _probeManageAuth();
  var _probeDone = _manageProbe.then(() => { needsRerender = true; });
  await Promise.allSettled([
    _probeDone,
    // Collections/favorites
    fetch('/collections').then(async cres => {
      if (cres.ok) { collectionsCache = await cres.json(); needsRerender = true; }
    }).catch(function(){}),
    // Version for footer
    fetch('/health').then(async hres => {
      if (hres.ok) {
        const hdata = await hres.json();
        if (hdata.version) document.getElementById('footer-version').textContent = hdata.version + ' ';
      }
    }).catch(function(){}),
    // Domain→ZIM map for cross-ZIM links
    fetch('/resolve?domains=1').then(async dres => {
      if (dres.ok) _domainZimMap = await dres.json();
    }).catch(function(){})
  ]);
  // Always update topbar after secondary data (manage status determines gear visibility)
  updateTopbar();
  // Create was opened before we could know whether this client may create —
  // either from a cold /#create load or from a tap during the library fetch.
  // Now we know. If the answer is no, leave rather than sit on a page whose
  // every button the server will refuse.
  if (_createOpen && !_canCreate()) {
    closeCreate();
    _showToast(t('create_needs_admin'));
  }
  // Re-check URL for ?manage now that manageEnabled is known (route() ran before this resolved)
  var params = new URLSearchParams(location.search);
  if (params.get('manage') !== null && manageEnabled && mode !== 'manage') {
    enterManage(null, _validMsSection(params.get('manage')));
    return;
  }
  // Re-render homepage if manage/collections changed (adds collection sections,
  // manage button). Not while manage is open: on a slow library the gear can be
  // used long before this resolves, and painting home over it leaves the manage
  // chrome (X button, catalog placeholder) on top of the home view.
  if (needsRerender && mode !== 'manage' && !readerOpen && !currentSource && !readerSource) renderHome();
}

function route(push) {
  const path = location.pathname;
  const search = location.search;
  const params = new URLSearchParams(search);
  // Restore Almanac on reload if #almanac hash is present. The head bootstrap
  // already stamped html.almanac-boot, so the home render below stays invisible
  // and the dark almanac shell is what the first paint shows.
  if (location.hash === '#almanac') {
    enterHome(false);
    openAlmanac(true);
    // Backstop: if the almanac never comes up (a module error mid-parse slips
    // past the loader's onerror), drop the boot gate so the library isn't left
    // permanently hidden behind an empty shell.
    setTimeout(function () {
      if (!_almanacOpen) document.documentElement.classList.remove('almanac-boot');
    }, 8000);
    return;
  }
  // Same for the Create page (#create). Opened optimistically: whether this
  // client may create is not known until the manage probe lands, and every
  // /manage/create* route is admin-gated server-side anyway — so the page
  // opens now and _initSecondary closes it if the answer comes back no. The
  // alternative, waiting, is the home-then-switch flash Eric asked us to kill.
  if (location.hash === '#create') {
    enterHome(false);
    openCreate(true);
    setTimeout(function () {
      if (!_createOpen) document.documentElement.classList.remove('create-boot');
    }, 8000);
    return;
  }
  // Booting straight into Manage (?manage in the URL). Same no-flash contract
  // as #create: the head bootstrap stamped html.manage-boot to hold the library
  // back, so open manage optimistically now — enterManage awaits the auth probe
  // and drops the gate once it has rendered manage in place. If this client may
  // not manage, enterManage reveals the library and the backstop drops the gate.
  if (params.get('manage') !== null && document.documentElement.classList.contains('manage-boot')) {
    enterManage(null, _validMsSection(params.get('manage')));
    setTimeout(function () {
      if (mode !== 'manage') document.documentElement.classList.remove('manage-boot');
    }, 8000);
    return;
  }
  // A view the user opened during a slow boot is not something to route over.
  if (_createOpen) return;
  if (params.get('manage') !== null && manageEnabled) { enterManage(null, _validMsSection(params.get('manage'))); return; }
  // Article deep link: /?a=<zim>/<path>. Root path always boots the SPA, so this
  // reliably opens full Zimi chrome on the target article regardless of browser
  // (see _articleDeepLink). Split on the first '/' — zim names never contain one.
  var aParam = params.get('a');
  if (aParam) {
    var aSlash = aParam.indexOf('/');
    var aZim = aSlash === -1 ? aParam : aParam.slice(0, aSlash);
    var aPath = aSlash === -1 ? '' : aParam.slice(aSlash + 1);
    if (aZim && aPath) {
      _bootDeepLinkArticle(aZim, aPath);
      return;
    }
    if (aZim) { enterSource(aZim, push); return; }
  }
  if (path.startsWith('/w/')) {
    let rest;
    try { rest = decodeURIComponent(path.slice(3)); } catch(e) { rest = path.slice(3); }
    const slashIdx = rest.indexOf('/');
    const name = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    const articlePath = slashIdx === -1 ? null : rest.slice(slashIdx + 1);
    if (name) {
      // If URL has a query, restore the search
      const qParam = params.get('q');
      if (qParam) {
        enterSource(name, false);
        q.value = qParam;
        doSearch(qParam, false);
        return;
      }
      // If URL has an article path, open the article directly
      if (articlePath) {
        enterSource(name, false);
        openArticle(name, articlePath);
        return;
      }
      enterSource(name, push);
      return;
    }
  }
  // Scoped home: /?scope=type:label
  const scopeParam = params.get('scope');
  if (scopeParam) {
    const state = history.state;
    if (state && state.scope) {
      // Restore scope from history state (has zimNames)
      enterScope(state.scope.type, state.scope.label, state.scope.zimNames, false);
    } else {
      // Reconstruct scope from URL param
      const [stype, ...rest] = scopeParam.split(':');
      const slabel = rest.join(':');
      const scopeZims = _resolveScopeZims(stype, slabel);
      if (scopeZims.length) {
        enterScope(stype, slabel, scopeZims, false);
      } else {
        enterHome(push);
      }
    }
    return;
  }
  // Global search: /?q=term
  const qParam = params.get('q');
  if (qParam) {
    enterHome(false);
    q.value = qParam;
    doSearch(qParam, false);
    return;
  }
  if (zimsCache && zimsCache.length === 1) {
    enterSource(zimsCache[0].name, false);
    history.replaceState(null, '', '/w/' + encodeURIComponent(zimsCache[0].name));
    return;
  }
  enterHome(push);
}

// Boot straight into a shared article deep link (/?a=<zim>/<path>). The history
// stack must be exactly [article] so browser Back leaves the site rather than
// surfacing a phantom "home"/source page the user never actually visited. Two
// steps get us there:
//  1. Suppress the source's main-article auto-open (renderSource, synchronous):
//     left on, it stamps currentArticle with the ZIM homepage, which openArticle
//     then pushes into articleHistory — lighting up the Back arrow and giving
//     browser Back a bogus destination.
//  2. REPLACE the boot entry instead of pushing, so no extra entry is created.
async function _bootDeepLinkArticle(zim, path) {
  _popstateNoAutoReader = true;
  try {
    await enterSource(zim, false);
  } finally {
    _popstateNoAutoReader = false;
  }
  openArticle(zim, path, null, { replace: true });
}

function _showToast(msg, duration) {
  var toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:10px 16px;font-size:13px;color:var(--text2);z-index:300;box-shadow:0 4px 16px rgba(0,0,0,0.3)';
  toast.textContent = msg;
  document.body.appendChild(toast);
  // Mirror to the screen-reader live region so non-sighted users hear it too.
  var live = document.getElementById('a11y-toast-region');
  if (live) {
    live.textContent = '';
    setTimeout(function() { live.textContent = msg; }, 50);
  }
  setTimeout(function() { if (toast.parentNode) toast.remove(); }, duration || 3000);
}

// True when Zimi is running as an installed/standalone app surface (iOS/Android
// home-screen PWA, or a desktop PWA window) rather than a plain browser tab.
// "Open in browser" is only meaningful here (and in the desktop app).
function _isStandalonePWA() {
  try {
    return window.matchMedia('(display-mode:standalone)').matches || navigator.standalone === true;
  } catch (e) { return false; }
}

// Shareable URL for whatever is on screen: an article's ?a= deep link (full
// Zimi chrome), never the raw /w/ path — a bare /w/ URL renders header-less ZIM
// content in some browsers. Falls back to the current location off-article.
function _currentPageUrl() {
  return currentArticle
    ? _articleDeepLink(currentArticle.zim, currentArticle.path)
    : location.href;
}

// ── Open in browser (escape the app shell into a real browser tab) ──
function _openInBrowser() {
  var url = _currentPageUrl();
  // Desktop app: hand off to the system browser via the pywebview bridge.
  if (IS_DESKTOP && window.pywebview && window.pywebview.api && window.pywebview.api.open_external) {
    window.pywebview.api.open_external(url).catch(function() {});
    return;
  }
  if (_isStandalonePWA()) {
    // iOS PWA can't window.open to Safari — copy the URL to the clipboard.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function() { _showToast(t('link_copied')); });
    } else {
      prompt(t('copy_link'), url);
    }
    return;
  }
  window.open(url, '_blank', 'noopener');
}

// ── Navigation ──
function goHome(e) {
  // The logo is a real <a href="/"> (#49): keep modified/non-primary clicks
  // native so open-in-new-tab works; only a plain left click stays SPA.
  if (e && _anchorNativeClick(e)) return;
  if (e) e.preventDefault();
  if (typeof _almReturnScroll !== 'undefined') _almReturnScroll = null; // explicit Home cancels almanac return
  if (_createOpen) closeCreate();
  if (_almanacOpen) closeAlmanac();
  // Clear manage auth when leaving manage
  if (mode === 'manage' && !_hasStoredManageToken()) _manageToken = '';
  // Already on clean home page → scroll to top
  if (mode === 'home' && !readerOpen && !currentSource && !homeScope) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  closeReader();
  currentSource = null;
  readerSource = null;
  sourceAutoReader = false;
  activeCategories.clear();
  enterHome(true);
  // Scroll to top after navigating home
  setTimeout(function() { window.scrollTo({ top: 0 }); }, 0);
}

function goBack() {
  if (_createOpen) { closeCreate(); return; }
  if (_almanacOpen) { closeAlmanac(); return; }
  if (readerOpen) {
    // Step back through article history before closing reader
    if (articleHistory.length > 0) {
      _stepBackToArticle(articleHistory.pop(), true);
      return;
    }
    // Article was opened from the almanac — drive Back through history so the
    // popstate handler reopens the almanac at its saved scroll position.
    if (typeof _almReturnScroll !== 'undefined' && _almReturnScroll != null) {
      history.back();
      return;
    }
    closeReader();
    // Only go home if reader was auto-opened by enterSource AND user hasn't searched
    if (sourceAutoReader) {
      sourceAutoReader = false;
      currentSource = null;
      enterHome(true);
    }
    // Otherwise mainView still has content (search results, document list, etc)
    return;
  }
  // Not in reader — navigate up the breadcrumb
  if (mode === 'search' && currentSource) {
    // Back from scoped search → return to source
    enterSource(currentSource, true);
  } else {
    goHome(null);
  }
}

// ── History trail ──
var _historyTrail = document.getElementById('history-trail');
var _histLongPressTimer = null;
var _histLongPressActive = false; // true after long-press fires — suppresses the following click

function _showHistoryTrail() {
  if (articleHistory.length === 0) return; // nothing to show
  var h = '';
  for (var i = articleHistory.length - 1; i >= 0; i--) {
    var item = articleHistory[i];
    // Real links (#49): each trail entry has a true deep-link URL, so
    // right/middle/modifier clicks can open it in a new tab natively.
    h += '<a class="history-item" href="' + escAttr(_articleDeepLinkPath(item.zim, item.path)) + '" data-idx="' + i + '">';
    h += '<span class="hi-source">' + esc(_zimTitle(item.zim)) + '</span>';
    h += '<span class="hi-title">' + esc(item.title || item.path) + '</span>';
    h += '</a>';
  }
  _historyTrail.innerHTML = h;
  // Position below the back button
  var btn = backBtn.getBoundingClientRect();
  _historyTrail.style.left = Math.max(4, btn.left) + 'px';
  _historyTrail.style.top = (btn.bottom + 4) + 'px';
  _historyTrail.classList.add('visible');
}

function _hideHistoryTrail() {
  _historyTrail.classList.remove('visible');
}

function _navigateHistoryItem(el) {
  var item = el.closest('.history-item');
  if (!item) return false;
  var idx = parseInt(item.dataset.idx, 10);
  if (isNaN(idx) || idx < 0 || idx >= articleHistory.length) return false;
  var target = articleHistory[idx];
  articleHistory.splice(idx);
  _hideHistoryTrail();
  currentArticle = null;
  openArticle(target.zim, target.path, target.title);
  return true;
}

// Click on trail item (for right-click-then-click flow). Items are real
// links (#49): keep new-tab gestures native, intercept plain clicks for SPA.
_historyTrail.addEventListener('click', function(e) {
  if (_anchorNativeClick(e)) return;
  e.preventDefault();
  _navigateHistoryItem(e.target);
});

// Hover highlight during long-press drag
_historyTrail.addEventListener('mouseover', function(e) {
  var item = e.target.closest('.history-item');
  _historyTrail.querySelectorAll('.history-item').forEach(function(el) { el.classList.toggle('hover', el === item); });
});
_historyTrail.addEventListener('mouseleave', function() {
  _historyTrail.querySelectorAll('.history-item.hover').forEach(function(el) { el.classList.remove('hover'); });
});

// Long-press on back button (500ms) — show history trail, support slide-to-select
backBtn.addEventListener('mousedown', function(e) {
  if (e.button !== 0) return;
  _histLongPressActive = false;
  _histLongPressTimer = setTimeout(function() {
    _histLongPressTimer = null;
    _histLongPressActive = true;
    _showHistoryTrail();
  }, 500);
});
backBtn.addEventListener('mouseleave', function() {
  if (_histLongPressTimer) { clearTimeout(_histLongPressTimer); _histLongPressTimer = null; }
});

// On mouseup anywhere: if long-press trail is open, check if releasing over a trail item
document.addEventListener('mouseup', function(e) {
  if (!_histLongPressActive) {
    // Short press — cancel timer if still pending
    if (_histLongPressTimer) { clearTimeout(_histLongPressTimer); _histLongPressTimer = null; }
    return;
  }
  _histLongPressActive = false;
  // Check if released over a trail item
  var el = document.elementFromPoint(e.clientX, e.clientY);
  if (el && _historyTrail.contains(el)) {
    _navigateHistoryItem(el);
  } else {
    _hideHistoryTrail();
  }
});

backBtn.addEventListener('click', function(e) {
  if (_historyTrail.classList.contains('visible')) { _hideHistoryTrail(); e.preventDefault(); return; }
  goBack();
});

// Right-click on back button — show history trail
backBtn.addEventListener('contextmenu', function(e) {
  e.preventDefault();
  if (_histLongPressTimer) { clearTimeout(_histLongPressTimer); _histLongPressTimer = null; }
  _showHistoryTrail();
});

// Close history trail on outside click (for right-click flow)
document.addEventListener('click', function(e) {
  if (_historyTrail.classList.contains('visible') && !_historyTrail.contains(e.target) && e.target !== backBtn) {
    _hideHistoryTrail();
  }
});
// Close history trail when iframe gets focus (clicks inside iframe don't bubble to parent)
window.addEventListener('blur', function() {
  if (_historyTrail.classList.contains('visible')) _hideHistoryTrail();
});

function enterHome(push) {
  mode = 'home';
  currentSource = null;
  readerSource = null;
  sourceAutoReader = false;
  homeScope = null;
  // The recency/language filters are scoped to whatever card set is showing (#37)
  // — leaving a scope drops any filter picked inside it so home starts clean.
  homeRecentFilter = null;
  homeLangFilter.clear();
  _currentSearchQuery = null;
  articleHistory = [];
  currentArticle = null;
  q.value = '';
  searchMeta.style.display = 'none';
  sourceHeaderEl.style.display = 'none';
  activeSourceFilters.clear();
  hideSuggest();
  if (push) history.pushState({ mode: 'home' }, '', '/');
  updateTopbar();
  renderHome();
}

function _resolveScopeZims(type, label) {
  if (!zimsCache) return [];
  if (type === 'favorites') {
    return (collectionsCache && collectionsCache.favorites) || [];
  }
  if (type === 'category') {
    return zimsCache.filter(z => z.category === label).map(z => z.name);
  }
  if (type === 'collection' && collectionsCache && collectionsCache.collections) {
    const coll = Object.values(collectionsCache.collections).find(c => c.label === label);
    return coll ? (coll.zims || []) : [];
  }
  return [];
}

function enterScope(type, label, zimNames, push) {
  mode = 'home';
  currentSource = null;
  readerSource = null;
  sourceAutoReader = false;
  homeScope = { type, label, zimNames };
  // New section, new card set — drop any recency/language filter picked in
  // whatever view we're leaving (home or a different section).
  homeRecentFilter = null;
  homeLangFilter.clear();
  q.value = '';
  searchMeta.style.display = 'none';
  sourceHeaderEl.style.display = 'none';
  activeSourceFilters.clear();
  hideSuggest();
  if (push) history.pushState({ mode: 'home', scope: homeScope }, '', '/?scope=' + encodeURIComponent(type + ':' + label));
  var docTitle = label + ' \u2014 Zimi';
  document.title = docTitle;
  _setWindowTitle(docTitle);
  updateTopbar();
  renderHome();
}

async function enterSource(name, push) {
  const info = _zimInfo(name);
  if (!info) { enterHome(push); return; }
  _markZimOpened(name);  // opening a source clears its New/Updated badge (#34)
  // Modifier-click: open in new browser tab
  if (_isModClick()) {
    _lastMouseEvent = null;
    window.open('/w/' + encodeURIComponent(name) + '?view=1', '_blank');
    return;
  }
  mode = 'source';
  currentSource = name;
  readerSource = null;
  _currentSearchQuery = null;
  sourceAutoReader = false;
  q.value = '';
  searchMeta.style.display = 'none';
  activeSourceFilters.clear();
  hideSuggest();
  if (push) history.pushState({ mode: 'source', source: name }, '', '/w/' + encodeURIComponent(name));
  var docTitle = (info.title || name) + ' \u2014 Zimi';
  document.title = docTitle;
  _setWindowTitle(docTitle);
  updateTopbar();
  await renderSource(name);
}

// Drop ZIMs already shown in the language auto-collection so they don't appear
// twice on home. No-op when that section is absent.
function _dedupLang(items, langNames) {
  return langNames && langNames.size
    ? items.filter(function(z) { return !langNames.has(z.name); })
    : items;
}

// Order home sections ({key, html}) by the saved section_order (#37): listed
// keys first in their saved order, then any unlisted section in its default
// (build) order. Keys are "cat:<category>"/"col:<collection>".
function _orderSections(sections) {
  var order = _sectionOrder || [];
  var byKey = new Map(sections.map(function(s) { return [s.key, s]; }));
  var out = [];
  order.forEach(function(k) {
    if (byKey.has(k)) { out.push(byKey.get(k)); byKey.delete(k); }
  });
  sections.forEach(function(s) { if (byKey.has(s.key)) out.push(s); });
  return out;
}

// The bucket a ZIM Zimi itself made files under when nobody filed it anywhere
// else. The literal matches what the created/ subfolder derives ('Created' via
// _folder_category server-side), so folder-filed and loose creations share ONE
// section instead of splitting on where the file happens to sit.
var CREATED_CAT = 'Created';

// A ZIM's effective category for grouping/ordering: its override/heuristic value,
// or OTHER_CAT for the uncategorized catch-all (empty value, or the explicit
// force-Other sentinel). One source of truth so home, the Installed list and the
// reorder list bucket a ZIM identically.
//
// One insertion between those two: a ZIM with Zimi-made provenance (the kinds
// map the type badges already fetch) and NO filing of its own — no category
// from a folder, no heuristic hit, no override (an override, including the
// force-Other sentinel, always arrives as a category and is respected) — files
// under Created. This is what folds CLI creations and pre-created/-folder
// captures into the same section the created/ folder feeds, with zero server
// cost.
function _zimCat(z) {
  if (!z) return OTHER_CAT;
  if (z.category && z.category !== OTHER_CAT) return z.category;
  if (!z.category && _zimKinds && z.name && _zimKinds[z.name]) return CREATED_CAT;
  return OTHER_CAT;
}

// The unified {key,label} list of reorderable home sections — collections
// (non-empty) + categories in use + user-declared empty sections + the Other
// catch-all (when anything is uncategorized) — in effective order. Shared by the
// manage reorder panel. `empty` marks a declared section with no ZIM yet (so it
// can be removed); `other` marks the uncategorized catch-all row.
function _currentReorderSections() {
  var sections = [];
  var colls = (collectionsCache && collectionsCache.collections) || {};
  for (var cname in colls) {
    if ((colls[cname].zims || []).some(function(n) { return _zimInfo(n); })) {
      sections.push({ key: 'col:' + cname, label: colls[cname].label || cname });
    }
  }
  var inUse = new Set(), canon = new Set(), cats = [], hasOther = false;
  (zimsCache || []).forEach(function(z) {
    var c = _zimCat(z);
    if (c === OTHER_CAT) { hasOther = true; return; }
    if (!inUse.has(c)) { inUse.add(c); canon.add(_catCanonKey(c)); cats.push(c); }
  });
  cats.sort().forEach(function(c) { sections.push({ key: 'cat:' + c, label: _catDisplayName(c) }); });
  // Declared empty sections: shown so they can be ordered / removed / targeted
  // before any ZIM lives in them. Skip any whose ZIMs have since arrived (now
  // in `cats`) so a section never appears twice.
  (_declaredSections || []).forEach(function(name) {
    if (canon.has(_catCanonKey(name))) return;
    canon.add(_catCanonKey(name));
    sections.push({ key: 'cat:' + name, label: _catDisplayName(name), empty: true });
  });
  if (hasOther) sections.push({ key: OTHER_KEY, label: t('cat_other'), other: true });
  return _orderSections(sections);
}

// Manage-row gear → the compact Move to… menu, anchored under the button.
function _ciGearClick(btn) {
  var r = btn.getBoundingClientRect();
  _openZimMenu(btn.dataset.zim, r.left, r.bottom + 2, true);
}

// Tag glyph marking a category reorder row, so collections (layers glyph) and
// categories read as different kinds of section at a glance while sharing one list.
var _CATEGORY_GLYPH = '<svg class="reorder-type-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';

// The Other catch-all row's glyph (a tray) — distinct from the category tag and
// collection layers so the three kinds of section read apart at a glance.
var _OTHER_GLYPH = '<svg class="reorder-type-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';

// One draggable reorder row (keyboard fallback via the ▲▼ buttons). `first`/
// `last` pre-disable the buttons at the ends of the list; drag/keyboard moves
// keep them in sync via _reorderRefreshDisabled. Collections, categories and the
// Other catch-all share one list, told apart by a per-type icon. A declared-empty
// category (`s.empty`) also carries a ✕ to remove it before any ZIM lives there.
function _reorderRowHtml(s, first, last) {
  var isCol = s.key.indexOf('col:') === 0;
  var glyph = s.other ? _OTHER_GLYPH : (isCol ? _COLLECTION_GLYPH : _CATEGORY_GLYPH);
  var cls = 'reorder-row' + (isCol ? ' reorder-row-col' : '') +
    (s.other ? ' reorder-row-other' : '') + (s.empty ? ' reorder-row-empty' : '');
  var removeBtn = s.empty
    ? '<button class="reorder-remove" data-remove="' + escAttr(s.key.slice(4)) +
        '" title="' + escAttr(t('remove_section')) + '" aria-label="' + escAttr(t('remove_section')) + '">×</button>'
    : '';
  return '<div class="' + cls + '" data-key="' + escAttr(s.key) + '" draggable="true">' +
    '<span class="reorder-grip" aria-hidden="true">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="19" r="1.6"/><circle cx="15" cy="19" r="1.6"/></svg>' +
    '</span>' +
    '<span class="reorder-type">' + glyph + '</span>' +
    '<span class="reorder-label">' + esc(s.label) + '</span>' +
    removeBtn +
    '<span class="reorder-btns">' +
      '<button class="reorder-btn" data-dir="up"' + (first ? ' disabled' : '') + ' aria-label="' + escAttr(t('move_up')) + '">▲</button>' +
      '<button class="reorder-btn" data-dir="down"' + (last ? ' disabled' : '') + ' aria-label="' + escAttr(t('move_down')) + '">▼</button>' +
    '</span>' +
  '</div>';
}

function _reorderListHtml(items, group) {
  var rows = items.map(function(s, i) {
    return _reorderRowHtml(s, i === 0, i === items.length - 1);
  }).join('');
  return '<div class="reorder-list" data-group="' + group + '">' + rows + '</div>';
}

// Collections and categories reorder together in one flat, draggable list, in
// the saved order — a per-type icon (layers vs tag) tells them apart, and a row
// can move freely anywhere in the list. The persisted order is every row
// top-to-bottom, so what you drag is exactly what home renders.
function _reorderSectionsHtml() {
  var sections = _currentReorderSections();
  var list = sections.length
    ? _reorderListHtml(sections, 'all')
    : '<div class="ms-hint">' + tH('reorder_empty') + '</div>';
  // "Add section" creates an empty category up front, so a user can build the
  // shelf before moving ZIMs onto it. Lives inside #ms-reorder so its click is
  // caught by the same delegated handler as the row controls.
  return list +
    '<button type="button" class="pill reorder-add" data-add="1">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
      esc(t('add_section')) +
    '</button>';
}

// Order category names by the saved section order (cat: keys), unlisted A-Z.
// Shared by the installed-tab filter pills so they mirror the home page.
function _orderCatsBySaved(cats) {
  var pos = {};
  (_sectionOrder || []).forEach(function(k, i) {
    if (k.indexOf('cat:') === 0) pos[k.slice(4)] = i;
    else if (k === OTHER_KEY) pos[OTHER_CAT] = i;  // Other rides its reserved key
  });
  return cats.slice().sort(function(a, b) {
    var pa = pos[a], pb = pos[b];
    if (pa == null && pb == null) {
      if (a === OTHER_CAT) return 1;   // unlisted Other defaults last, like home
      if (b === OTHER_CAT) return -1;
      return a.localeCompare(b);
    }
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pa - pb;
  });
}

// Single writer for the home section order. The reorder panel (drag + up/down)
// funnels through here so the optimistic local update, the POST, the failure
// toast, and — the fix for stale-home — the post-save resync all live in one
// place. The server validates/normalizes the order
// (drops unknown keys via _SECTION_KEY_RE), so we adopt its echoed order as
// authoritative and, when home is the visible view, re-render it immediately so
// the list matches the pills without waiting for the next navigation.
function _persistSectionOrder(order) {
  _sectionOrder = order;
  return _saveLibraryLayout({ section_order: order }).then(function(res) {
    if (!res.ok) { _showToast(res.status === 403 ? t('layout_locked') : t('error')); return; }
    return res.json().then(function(body) {
      if (body && Array.isArray(body.section_order)) _sectionOrder = body.section_order;
      if (mode === 'home' && !readerOpen && !currentSource) renderHome();
    }).catch(function() {});
  }).catch(function() { _showToast(t('error')); });
}

// Refresh ▲▼ disabled state at the ends of every group in the reorder panel.
function _reorderRefreshDisabled() {
  var cont = document.getElementById('ms-reorder');
  if (!cont) return;
  cont.querySelectorAll('.reorder-list').forEach(function(list) {
    var rows = list.querySelectorAll('.reorder-row');
    rows.forEach(function(r, i) {
      var up = r.querySelector('[data-dir="up"]'), dn = r.querySelector('[data-dir="down"]');
      if (up) up.disabled = (i === 0);
      if (dn) dn.disabled = (i === rows.length - 1);
    });
  });
}

// Per-move POST (not debounced): reorders are discrete, infrequent, and each
// leaves a complete valid order — immediate durability beats coalescing here.
// The order is every row in the single list, top-to-bottom.
function _persistReorder() {
  var cont = document.getElementById('ms-reorder');
  if (!cont) return;
  var order = Array.prototype.map.call(cont.querySelectorAll('.reorder-row'), function(r) { return r.dataset.key; });
  _persistSectionOrder(order);
}

// Re-render the reorder panel in place (after add/remove) so the new row set and
// the ▲▼ end-state stay correct without a full manage repaint.
function _rerenderReorderPanel() {
  var cont = document.getElementById('ms-reorder');
  if (cont) cont.innerHTML = _reorderSectionsHtml();
}

// Swap the "+ Add category" pill for an inline input row (no prompt() dialog):
// autofocus, Enter commits, Esc/blank cancels. Lives inside #ms-reorder so the
// delegated drag/click handlers still see it, but the input's own key/blur
// listeners own the commit/cancel flow.
function _showAddSectionInput() {
  var cont = document.getElementById('ms-reorder');
  if (!cont) return;
  var addBtn = cont.querySelector('.reorder-add');
  if (!addBtn) return;
  var row = document.createElement('div');
  row.className = 'reorder-add-row';
  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'reorder-add-input';
  input.maxLength = 60;
  input.placeholder = t('add_section_prompt');
  input.setAttribute('aria-label', t('add_section_prompt'));
  var ok = document.createElement('button');
  ok.type = 'button'; ok.className = 'reorder-add-ok';
  ok.setAttribute('aria-label', t('add_section'));
  ok.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
  var cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'reorder-add-cancel';
  cancel.setAttribute('aria-label', t('cancel'));
  cancel.textContent = '×';
  row.appendChild(input); row.appendChild(ok); row.appendChild(cancel);
  addBtn.replaceWith(row);
  input.focus();
  var closed = false;
  function restore() { if (!closed) { closed = true; _rerenderReorderPanel(); } }
  function commit() {
    if (closed) return;
    var name = input.value.trim();
    if (!name) { restore(); return; }
    var canon = _catCanonKey(name);
    var dup = _currentReorderSections().some(function(s) {
      return s.key.indexOf('cat:') === 0 && _catCanonKey(s.key.slice(4)) === canon;
    });
    if (dup) { _showToast(t('section_exists')); input.focus(); input.select(); return; }
    closed = true;
    _commitAddSection(name);
  }
  input.addEventListener('keydown', function(e) {
    // stopPropagation so Enter/Esc commit or cancel the add only — they must not
    // bubble to the global keydown handler and close the whole manage overlay.
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); restore(); }
  });
  ok.addEventListener('click', commit);
  cancel.addEventListener('click', restore);
  input.addEventListener('blur', function() {
    // A blur onto the ✓/× buttons is handled by their click; otherwise a blank
    // blur just tidies the row away. Defer so the button click lands first.
    setTimeout(function() {
      if (closed) return;
      var a = document.activeElement;
      if (a === ok || a === cancel) return;
      if (!input.value.trim()) restore();
    }, 120);
  });
}

// Persist a new empty section (a declared category): append to `sections`, then
// re-render the panel. Validation (blank/duplicate) happens in the inline input
// flow above before we get here.
function _commitAddSection(name) {
  _declaredSections = (_declaredSections || []).concat([name]);
  _rerenderReorderPanel();
  _saveLibraryLayout({ sections: _declaredSections }).then(function(res) {
    if (!res.ok) {
      _declaredSections = _declaredSections.filter(function(n) { return n !== name; });
      _rerenderReorderPanel();
      _showToast(res.status === 403 ? t('layout_locked') : t('error'));
    } else { _showToast(t('saved')); }
  }).catch(function() {
    _declaredSections = _declaredSections.filter(function(n) { return n !== name; });
    _rerenderReorderPanel(); _showToast(t('error'));
  });
}

// Remove an empty declared section (only offered on rows with no ZIM yet). Drops
// it from both `sections` and any lingering section_order slot, then persists.
function _removeSection(name) {
  var prev = (_declaredSections || []).slice();
  _declaredSections = prev.filter(function(n) { return _catCanonKey(n) !== _catCanonKey(name); });
  _sectionOrder = (_sectionOrder || []).filter(function(k) {
    return !(k.indexOf('cat:') === 0 && _catCanonKey(k.slice(4)) === _catCanonKey(name));
  });
  _rerenderReorderPanel();
  _saveLibraryLayout({ sections: _declaredSections, section_order: _sectionOrder }).then(function(res) {
    if (!res.ok) {
      _declaredSections = prev; _rerenderReorderPanel();
      _showToast(res.status === 403 ? t('layout_locked') : t('error'));
    }
  }).catch(function() { _declaredSections = prev; _rerenderReorderPanel(); _showToast(t('error')); });
}

// Delegated clicks inside #ms-reorder: Add section, remove an empty section, and
// the ▲▼ keyboard fallback for drag (move a row up/down within the list).
function _reorderClick(e) {
  if (e.target.closest('[data-add]')) { _showAddSectionInput(); return; }
  var rm = e.target.closest('[data-remove]');
  if (rm) { _removeSection(rm.dataset.remove); return; }
  var btn = e.target.closest('.reorder-btn');
  if (!btn || btn.disabled) return;
  var row = btn.closest('.reorder-row');
  var list = row.parentNode;
  if (btn.dataset.dir === 'up' && row.previousElementSibling) {
    list.insertBefore(row, row.previousElementSibling);
  } else if (btn.dataset.dir === 'down' && row.nextElementSibling) {
    list.insertBefore(row.nextElementSibling, row);
  } else { return; }
  _reorderRefreshDisabled();
  _persistReorder();
}

// HTML5 drag reordering of the section rows, delegated from the #ms-reorder
// container (drag events bubble). Collections and categories share one list, so
// a row can move anywhere in it. Live insert on dragover makes the move feel
// direct; dragend persists.
var _reDrag = null;
function _reorderDragStart(e) {
  var row = e.target.closest('.reorder-row');
  if (!row) return;
  _reDrag = row; row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', row.dataset.key); } catch (_) {}
}
function _reorderDragOver(e) {
  var row = e.target.closest('.reorder-row');
  if (!_reDrag || !row || row === _reDrag) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  var rect = row.getBoundingClientRect();
  var after = (e.clientY - rect.top) > rect.height / 2;
  row.parentNode.insertBefore(_reDrag, after ? row.nextSibling : row);
}
function _reorderDrop(e) { if (_reDrag) e.preventDefault(); }
function _reorderDragEnd() {
  if (!_reDrag) return;
  _reDrag.classList.remove('dragging');
  _reDrag = null;
  _reorderRefreshDisabled();
  _persistReorder();
}

// ── Touch reordering (mobile) ──
// HTML5 drag doesn't fire on touch, so the reorder rows also support a
// long-press-drag started on the row's grip (touch-action:none in CSS lets us
// own the gesture there instead of the list scrolling). A short hold arms the
// drag (haptic confirm); after that, touchmove reorders the DOM live and locks
// page scroll (preventDefault), and touchend persists. The ▲▼ keyboard fallback
// is untouched. Delegated on document so it survives every panel re-render.
var _reTouch = null;  // {row, startY, dragging, timer, onGrip}
var _RE_TOUCH_HOLD_MS = 160;
function _reorderTouchStart(e) {
  if (e.touches.length !== 1) return;
  var grip = e.target.closest && e.target.closest('.reorder-grip');
  if (!grip) return;
  var row = grip.closest('.reorder-row');
  if (!row || !row.parentNode || !document.getElementById('ms-reorder')) return;
  var t = e.touches[0];
  _reTouch = { row: row, startY: t.clientY, dragging: false, timer: null };
  _reTouch.timer = setTimeout(function() {
    if (!_reTouch) return;
    _reTouch.timer = null;
    _reTouch.dragging = true;
    row.classList.add('dragging');
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (_) {} }
  }, _RE_TOUCH_HOLD_MS);
}
function _reorderTouchMove(e) {
  if (!_reTouch) return;
  var t = e.touches[0];
  if (!t) return;
  if (!_reTouch.dragging) {
    // Moving from the grip before the hold arms is still drag intent — start now.
    if (Math.abs(t.clientY - _reTouch.startY) > 6) {
      if (_reTouch.timer) { clearTimeout(_reTouch.timer); _reTouch.timer = null; }
      _reTouch.dragging = true;
      _reTouch.row.classList.add('dragging');
    } else return;
  }
  e.preventDefault();  // scroll lock while dragging
  var row = _reTouch.row;
  var list = row.parentNode;
  var rows = list.querySelectorAll('.reorder-row');
  for (var i = 0; i < rows.length; i++) {
    var other = rows[i];
    if (other === row) continue;
    var rect = other.getBoundingClientRect();
    if (t.clientY >= rect.top && t.clientY <= rect.bottom) {
      var after = (t.clientY - rect.top) > rect.height / 2;
      list.insertBefore(row, after ? other.nextSibling : other);
      break;
    }
  }
}
function _reorderTouchEnd() {
  if (!_reTouch) return;
  if (_reTouch.timer) clearTimeout(_reTouch.timer);
  var wasDragging = _reTouch.dragging;
  _reTouch.row.classList.remove('dragging');
  _reTouch = null;
  if (wasDragging) { _reorderRefreshDisabled(); _persistReorder(); }
}
document.addEventListener('touchstart', _reorderTouchStart, { passive: true });
document.addEventListener('touchmove', _reorderTouchMove, { passive: false });
document.addEventListener('touchend', _reorderTouchEnd);
document.addEventListener('touchcancel', _reorderTouchEnd);

// ── Render: Home ──
function renderHome(filter) {
  // We could not ask the server. Say so — never "No knowledge sources found",
  // which reads as "your library was wiped". Discover is skipped too: its cards
  // are drawn from the (unknown) installed set.
  if (!_libraryKnown) {
    statsBar.innerHTML = ''; statsBar.style.display = 'none';
    pillsBar.innerHTML = ''; pillsBar.style.display = 'none'; pillsBar.className = 'pills';
    output.innerHTML = _libraryUnavailableHtml();
    return;
  }
  if (!zimsCache || zimsCache.length === 0) {
    statsBar.innerHTML = ''; statsBar.style.display = 'none';
    pillsBar.innerHTML = ''; pillsBar.style.display = 'none'; pillsBar.className = 'pills';
    output.innerHTML = '<div id="discover-row"></div>'
      + '<div class="empty"><p>' + tH('no_sources_found') + '</p><p class="hint">' + tH('add_zims') + '</p>'
      + (manageEnabled ? '<a href="/?manage" onclick="event.preventDefault();enterManage();setTimeout(function(){switchManageTab(\'browse\')},50)" style="display:inline-block;margin-top:16px;color:var(--amber);font-weight:500;font-size:14px;text-decoration:none;border-bottom:1px solid var(--amber-border)">' + tH('catalog_link') + '</a>' : '')
      + '</div>';
    _loadDiscover();
    return;
  }

  // Determine base ZIM set (scoped or all)
  let baseZims = zimsCache;
  if (homeScope) {
    const scopeSet = new Set(homeScope.zimNames);
    baseZims = zimsCache.filter(z => scopeSet.has(z.name));
  }

  // Filter ZIMs by title/name/description when filter text provided
  let zims = baseZims;
  if (filter) {
    const fl = filter.toLowerCase();
    const words = fl.split(/\s+/).filter(Boolean);
    zims = baseZims.filter(z => {
      const t = ((z.title || '') + ' ' + z.name + ' ' + (z.description || '')).toLowerCase();
      return words.every(w => t.includes(w));
    });
  }

  // The recency + language pills also make sense scoped to a section (#37) —
  // they filter that section's cards, computed below from the already-scoped
  // `sorted`/`sortedAll` sets. Typing a filter still drops back to "All" / all
  // languages so state stays sane (scope transitions reset filters themselves,
  // in enterScope/enterHome, so re-rendering the same scope doesn't clobber a
  // filter the user just picked).
  if (filter) { homeRecentFilter = null; homeLangFilter.clear(); }

  const totalEntries = baseZims.reduce((s, z) => s + (typeof z.entries === 'number' ? z.entries : 0), 0);
  const totalGb = baseZims.reduce((s, z) => s + z.size_gb, 0);

  const n = baseZims.length;
  var statsHtml;
  if (filter && zims.length !== baseZims.length) {
    statsHtml = '<span class="num">' + zims.length + '</span> ' + tH('sources_matching', {n: zims.length, total: n, query: filter});
  } else {
    statsHtml = t('sources_count', {n: '<span class="num">' + n + '</span>'}) + ' &middot; ' +
      t('articles_count', {n: '<span class="num">' + totalEntries.toLocaleString() + '</span>'}) + ' &middot; ' +
      fmtSize(totalGb, true);
  }

  // Check if Discover will be active (not hidden and not filtered/scoped)
  var discoverHidden = _getStorageFlag(SK.HIDE_DISCOVER);
  var discoverWillShow = !homeScope && !filter && !homeRecentFilter && !homeLangFilter.size && !discoverHidden;

  // Counts sit at the BOTTOM in every discover-capable home state — the clean
  // idle view AND while a language filter is active — so tapping a
  // filter pill never makes the counts bar jump from bottom to top (#8). The
  // top stats bar is used only when discover is user-hidden or the view is
  // scoped / text-filtered.
  var countsAtBottom = !homeScope && !filter && !discoverHidden;
  if (countsAtBottom) {
    // Counts render at the bottom of the content — keep the top bar empty.
    statsBar.innerHTML = ''; statsBar.style.display = 'none';
  } else if (!homeScope && !filter && discoverHidden) {
    // Discover hidden — stats clickable to re-enable
    statsBar.innerHTML = '<a href="#" onclick="event.preventDefault();localStorage.removeItem(\'zimi_hide_discover\');renderHome()" style="color:inherit;text-decoration:none" title="' + escAttr(t('show_discover')) + '">' + statsHtml + '</a>';
    statsBar.style.display = '';
  } else {
    statsBar.innerHTML = statsHtml;
    statsBar.style.display = '';
  }

  const sortedAll = zims.filter(z => z.entries !== '?').sort((a, b) => (b.entries || 0) - (a.entries || 0));

  // Language filter data — count of ZIMs per language, over the whole library.
  // The pill row only appears with ≥2 distinct languages; a mono-language
  // library never sees it (and any stale filter state is dropped).
  var _langCounts = {};
  sortedAll.forEach(z => { var l = z.language || ''; if (l && _isValidLangCode(l)) _langCounts[l] = (_langCounts[l] || 0) + 1; });
  var _langCodes = Object.keys(_langCounts).sort((a, b) => _langCounts[b] - _langCounts[a]);
  var _showLangPills = !filter && _langCodes.length >= 2;
  if (!_showLangPills) homeLangFilter.clear();

  // Apply the language filter first. Empty filter = the full library.
  const _langSorted = homeLangFilter.size
    ? sortedAll.filter(z => homeLangFilter.has(z.language || ''))
    : sortedAll;

  // #34 recency lists, computed from the language-narrowed set so the two filters
  // compose (AND). The counts drive the pill labels; an ACTIVE recency pill then
  // narrows `sorted` in place so the existing sections filter down to just those
  // ZIMs — exactly like a language pill — rather than spawning a separate view.
  var _recentAdded = _langSorted.filter(_zimRecentAdded).sort(_byFirstSeenDesc);
  var _recentUpdated = _langSorted.filter(_zimRecentUpdated).sort(_byUpdatedDesc);
  // A language narrowing can empty the active recency list — its pill is hidden
  // then, so fall back to All rather than strand the view on an empty filter.
  if (homeRecentFilter === 'added' && !_recentAdded.length) homeRecentFilter = null;
  if (homeRecentFilter === 'updated' && !_recentUpdated.length) homeRecentFilter = null;
  const sorted = homeRecentFilter === 'added' ? _recentAdded
    : homeRecentFilter === 'updated' ? _recentUpdated
    : _langSorted;

  const groups = {};
  sorted.forEach(z => {
    const key = _zimCat(z);  // real category, or OTHER_CAT for the catch-all
    if (!groups[key]) groups[key] = [];
    groups[key].push(z);
  });

  const cats = Object.keys(groups).filter(c => c !== OTHER_CAT).sort();

  // #34 library filter pills: All · Recently added · Recently updated · language
  // pills. Each recency pill only appears when it has something to show, so we
  // never present a filter that lands on an empty view. Rendered above the content
  // while a filter is active (and in the search dropdown), so un-filtering stays
  // reachable.
  var _rows = '';
  var _hasRecency = !filter && (_recentAdded.length || _recentUpdated.length);
  if (_hasRecency) {
    _rows += '<div class="pills-row" role="group" aria-label="' + escAttr(t('filter_by_recency')) + '">';
    _rows += _recentPill(null, tH('filter_all'), homeRecentFilter === null);
    if (_recentAdded.length) {
      _rows += _recentPill('added', tH('filter_recently_added') +
        ' <span class="pill-count">' + _recentAdded.length + '</span>', homeRecentFilter === 'added');
    }
    if (_recentUpdated.length) {
      _rows += _recentPill('updated', tH('recently_updated') +
        ' <span class="pill-count">' + _recentUpdated.length + '</span>', homeRecentFilter === 'updated');
    }
    _rows += '</div>';
  }
  if (_showLangPills) {
    _rows += '<div class="lang-pills" role="group" aria-label="' + escAttr(t('filter_by_language')) + '">';
    _rows += _allResetPill(homeLangFilter.size === 0, 'clearHomeLang()');
    _rows += _langCodes.map(function(code) {
      return _homeLangPill(code, _langCounts[code], homeLangFilter.has(code));
    }).join('');
    _rows += '</div>';
  }
  _homeFilterRowsHtml = _rows; // the search dropdown renders the same pills
  if (_rows) {
    pillsBar.className = 'pills';
    pillsBar.innerHTML = _rows;
    _pillsAreHomeFilters = true;
    // Hidden by default (clean home) — shown above the content only while a
    // filter is actively applied. _updateHomeFiltersVisibility encodes that.
    _updateHomeFiltersVisibility();
  } else {
    // No pills otherwise (scoped/filtered/nothing recent, no languages) — sections
    // organize home.
    pillsBar.innerHTML = ''; pillsBar.style.display = 'none'; pillsBar.className = 'pills';
    _pillsAreHomeFilters = false;
    homeRecentFilter = null; // guard: pill row gone, so no stale filter state
    homeLangFilter.clear();
  }

  let h = '';

  // Scope header with back link — Favorites, a category or a collection all
  // drill in here, so keep a way back to "All sources".
  if (homeScope) {
    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">' +
      '<a href="#" onclick="event.preventDefault();enterHome(true)" style="color:var(--text2);text-decoration:none;font-size:13px">' + tH('all_sources') + '</a>' +
      '<span style="color:var(--border)">/</span>' +
      '<span style="font-size:13px;font-weight:600;color:var(--amber)">' + esc(homeScope.label) + '</span>' +
    '</div>';
  }

  // The compact/full layout toggle is injected onto the first section header
  // after render (see _placeViewToggle) rather than sitting in a bar of its own.

  // Show article search hint at the top when filtering
  if (filter) {
    const scopeEntries = baseZims.reduce((s, z) => s + (typeof z.entries === 'number' ? z.entries : 0), 0);
    h += '<div class="search-deeper" onclick="doSearch(\'' + escAttr(filter) + '\')" tabindex="0" ' +
      'onkeydown="if(event.key===\'Enter\')doSearch(\'' + escAttr(filter) + '\')">' +
      tH('search_articles', {n: scopeEntries.toLocaleString(), query: filter}) + '</div>';
  }

  // Discover (only on unscoped, unfiltered, unfiltered-by-language home)
  var _showDiscover = !homeScope && !filter && !homeRecentFilter && !homeLangFilter.size;
  if (_showDiscover) {
    h += '<div id="discover-row"></div>';
  }

  // Language welcome card (non-English UI, no matching ZIMs installed)
  if (!homeScope && !filter && _currentLang !== 'en') {
    var _welcomeLang = (_AVAILABLE_LANGS.find(function(l) { return l.code === _currentLang; }) || {}).name || _currentLang;
    var _hasLangZims = (zimsCache || []).some(function(z) { return z.language === _currentLang; });
    var _welcomeDismissed = localStorage.getItem('zimi_welcome_' + _currentLang) === '0';
    if (!_welcomeDismissed) {
      if (!_hasLangZims && manageEnabled) {
        h += '<div class="lang-welcome-card" id="lang-welcome">' +
          '<div class="lang-welcome-text">' +
            '<strong>' + tH('welcome_lang_title', {lang: _welcomeLang}) + '</strong>' +
            '<p>' + tH('welcome_lang_body', {lang: _welcomeLang}) + '</p>' +
          '</div>' +
          '<div class="lang-welcome-actions">' +
            '<button class="lang-banner-btn" onclick="localStorage.setItem(\'zimi_welcome_\'+_currentLang,\'0\');_langBannerDownload(_currentLang,\'wikipedia\')">' + tH('welcome_lang_browse') + '</button>' +
            '<button class="lang-banner-dismiss" onclick="localStorage.setItem(\'zimi_welcome_\'+_currentLang,\'0\');var el=document.getElementById(\'lang-welcome\');if(el)el.remove()">\u2715</button>' +
          '</div>' +
        '</div>';
      } else {
        var _langZimCount = (zimsCache || []).filter(function(z) { return z.language === _currentLang; }).length;
        h += '<div class="lang-welcome-card lang-welcome-subtle" id="lang-welcome">' +
          '<span>' + tH('welcome_lang_have', {n: _langZimCount, lang: _welcomeLang}) + '</span>' +
          '<button class="lang-banner-dismiss" onclick="localStorage.setItem(\'zimi_welcome_\'+_currentLang,\'0\');var el=document.getElementById(\'lang-welcome\');if(el)el.remove()">\u2715</button>' +
        '</div>';
      }
    }
  }

  // Bookmarks moved to library panel (H/B key or topbar icon)

  // Favorites section at top (only on unscoped home)
  if (!homeScope) {
    const favNames = (collectionsCache && collectionsCache.favorites) || [];
    if (!filter && favNames.length > 0) {
      const favZims = favNames.map(n => _zimInfo(n)).filter(Boolean);
      if (favZims.length > 0) {
        const favZimNames = favZims.map(z => z.name);
        h += '<div class="cat-heading clickable" onclick="enterScope(\'favorites\',\'\u2605 ' + escJs(t('favorites')) + '\',' + escJs(JSON.stringify(favZimNames)) + ',true)">\u2605 ' + tH('favorites') + '</div>';
        h += renderCardGrid(favZims, true, true);
      }
    }
    // Collections now render inside the unified, reorderable section list below
    // (#37) \u2014 no longer pinned above categories.
  }

  // Language auto-collection: when UI is non-English, show matching-language ZIMs as their own section
  var _langSectionNames = new Set();
  if (!homeScope && !filter && _currentLang !== 'en') {
    var _uiLangName = (_AVAILABLE_LANGS.find(function(l) { return l.code === _currentLang; }) || {}).name || _currentLang;
    var _langZims = sorted.filter(function(z) { return z.language === _currentLang; });
    if (_langZims.length > 0) {
      _langZims.forEach(function(z) { _langSectionNames.add(z.name); });
      var _langZimNames = _langZims.map(function(z) { return z.name; });
      h += '<div class="cat-heading clickable" onclick="enterScope(\'language\',\'' + escJs(_uiLangName) + '\',' + escJs(JSON.stringify(_langZimNames)) + ',true)">' +
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" style="vertical-align:-2px;margin-right:4px"><circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="3" ry="6.5"/><line x1="1.5" y1="8" x2="14.5" y2="8"/></svg>' +
        esc(_uiLangName) + '</div>';
      h += renderCardGrid(_langZims, true, true);
    }
  }

  if (filter && zims.length === 0) {
    h += '<div class="empty"><p>' + tH('no_sources_matching', {query: filter}) + '</p></div>';
  } else if (homeScope) {
    // Scoped view: plain category headings, no reordering or collections.
    cats.forEach(cat => {
      var catItems = _dedupLang(groups[cat], _langSectionNames);
      if (catItems.length === 0) return;
      h += '<div class="cat-heading">' + esc(_catDisplayName(cat)) + '</div>';
      h += renderCardGrid(catItems, true);
    });
    // Other (uncategorized) sorts last in a scoped view — not reorderable here.
    var _scopeOther = _dedupLang(groups[OTHER_CAT] || [], _langSectionNames);
    if (_scopeOther.length > 0) {
      h += '<div class="cat-heading cat-heading-other">' + tH('cat_other') + '</div>';
      h += renderCardGrid(_scopeOther, true);
    }
  } else {
    // Unscoped home: collections + categories + the Other catch-all in one
    // reorderable list (#37), ordered by the saved section_order (unlisted
    // sections keep default order — Other is built last so it defaults last).
    var _sections = [];
    if (!filter && collectionsCache && collectionsCache.collections) {
      for (const [cname, coll] of Object.entries(collectionsCache.collections)) {
        const collZims = (coll.zims || []).map(n => _zimInfo(n)).filter(Boolean);
        if (collZims.length > 0) {
          const collZimNames = collZims.map(z => z.name);
          _sections.push({ key: 'col:' + cname, html:
            '<div class="cat-heading clickable" onclick="enterScope(\'collection\',\'' + escJs(coll.label || cname) + '\',' + escJs(JSON.stringify(collZimNames)) + ',true)">' + esc(coll.label || cname) + '</div>' +
            renderCardGrid(collZims, true, true) });
        }
      }
    }
    cats.forEach(cat => {
      var catItems = _dedupLang(groups[cat], _langSectionNames);
      if (catItems.length === 0) return;
      const catZimNames = catItems.map(z => z.name);
      _sections.push({ key: 'cat:' + cat, html:
        '<div class="cat-heading clickable" onclick="enterScope(\'category\',\'' + escJs(_catDisplayName(cat)) + '\',' + escJs(JSON.stringify(catZimNames)) + ',true)">' + esc(_catDisplayName(cat)) + '</div>' +
        renderCardGrid(catItems, true) });
    });
    var _otherItems = _dedupLang(groups[OTHER_CAT] || [], _langSectionNames);
    if (_otherItems.length > 0) {
      _sections.push({ key: OTHER_KEY, html:
        '<div class="cat-heading cat-heading-other">' + tH('cat_other') + '</div>' +
        renderCardGrid(_otherItems, true) });
    }
    h += _orderSections(_sections).map(function(s) { return s.html; }).join('');
  }

  // Counts at the bottom whenever the top bar is suppressed (idle discover view
  // or an active recency/language filter) — a stable anchor, no jump (#8).
  if (countsAtBottom) {
    h += '<div class="stats-bar" style="padding:28px 0 0">' + statsHtml + '</div>';
  }

  // Preserve existing discover content to avoid flash (pop-in → disappear → reappear)
  // But invalidate if the language changed (cached HTML has baked-in translated strings)
  var _prevDiscoverHtml = null;
  var _prevDiscoverScroll = 0;
  if (_showDiscover) {
    var _prevRow = document.getElementById('discover-row');
    if (_prevRow && _prevRow.innerHTML && _prevRow.dataset.lang === _currentLang) {
      _prevDiscoverHtml = _prevRow.innerHTML;
      // scrollLeft is a live DOM property, not serialized by innerHTML — capture
      // it so the strip keeps its place across a home re-render (e.g. Back from
      // an opened discover card) instead of snapping to the first card.
      var _prevScrollEl = _prevRow.querySelector('.discover-scroll');
      if (_prevScrollEl) _prevDiscoverScroll = _prevScrollEl.scrollLeft;
    }
  }
  output.innerHTML = h;
  _placeViewToggle();
  // The library is on screen; only now go find out what made each of these
  // ZIMs. Deliberately after the paint — reading provenance opens archives, and
  // no card should wait on that. A no-op once the map has arrived.
  _loadZimKinds();
  if (_showDiscover) {
    if (_prevDiscoverHtml) {
      // Restore cached discover DOM — avoid re-fetch flash
      var newRow = document.getElementById('discover-row');
      if (newRow) {
        newRow.innerHTML = _prevDiscoverHtml; newRow.dataset.lang = _currentLang;
        if (_prevDiscoverScroll) {
          var _newScrollEl = newRow.querySelector('.discover-scroll');
          if (_newScrollEl) _newScrollEl.scrollLeft = _prevDiscoverScroll;
        }
      }
    } else {
      _loadDiscover();
    }
  }
}

// Resolve a ZIM's language into a badge intent: a short uppercase code ({code}),
// a multi-language count ({multi:n}), or null (no badge — language-agnostic, or
// it matches the current UI language, where a badge would just be noise). Shared
// by the inline list badge and the compact-tile corner badge so the exclusion
// rules never drift between the two views. `force` keeps the code even when it
// matches the UI language — used to disambiguate identically-titled source pills,
// where dropping the current language would leave a collision unlabelled.
function _zimLangBadgeInfo(z, force) {
  var lang = (z.language || '').toLowerCase();
  if (!lang || lang === 'all') return null;
  if (lang.includes(',')) { var n = lang.split(',').length; return n > 1 ? {multi: n} : null; }
  if (lang === 'mul' || lang === 'multi' || /^mul/i.test(z.name)) return null;
  if (!force && lang === _currentLang) return null;
  // Two-letter uppercase code (DE, AR, FR…). ISO 639-1 codes are already two
  // letters; longer codes are clipped to their first two.
  return {code: (lang.length > 2 ? lang.slice(0, 2) : lang).toUpperCase()};
}

// Inline language badge (search + full list rows). Full language name in the
// tooltip; the visible label is the short code so identically-named ZIMs in
// different languages are distinguishable at a glance. `force` forwards to
// _zimLangBadgeInfo (see there). `full` swaps the visible label to the native
// full language name ("Français", not "FR") — used by the compact tiles, where
// the chip owns its own line and has the width to spell the language out.
function _langBadge(z, force, full) {
  var info = _zimLangBadgeInfo(z, force);
  if (!info) return '';
  if (info.multi) {
    return '<span class="lang-badge multi" title="' + escAttr(t('multilingual', {n: info.multi})) + '">' +
      info.multi + ' ' + tH('language').toLowerCase() + '</span>';
  }
  var name = _langDisplayName(z.language) || info.code;
  if (full) {
    var lc = (z.language || '').toLowerCase().slice(0, 2);
    var native = _NATIVE_LANG_NAMES[lc] || name;
    return '<span class="lang-badge lang-badge-full" title="' + escAttr(name) + '">' + esc(native) + '</span>';
  }
  return '<span class="lang-badge" title="' + escAttr(name) + '">' + esc(info.code) + '</span>';
}

// New/Updated badges (#34). A badge flags a ZIM the user hasn't looked at since
// it appeared or changed. It clears the moment they open the ZIM (tracked per
// browser), and as a backstop auto-expires after a week even if never opened —
// so a badge never lingers indefinitely on a source you keep ignoring.
var _ZIM_BADGE_BACKSTOP_DAYS = 7;
var _ZIM_OPENED_KEY = 'zimi_zim_opened';

function _getZimOpenedMap() {
  try { return JSON.parse(localStorage.getItem(_ZIM_OPENED_KEY)) || {}; }
  catch (e) { return {}; }
}
// Record that the user opened a ZIM now — this is what clears its badge. Always
// writes the latest time so a later update can re-badge, then clear again.
function _markZimOpened(name) {
  if (!name) return;
  var m = _getZimOpenedMap();
  m[name] = Date.now() / 1000;
  try { localStorage.setItem(_ZIM_OPENED_KEY, JSON.stringify(m)); } catch (e) {}
}
// Returns null, or {label:'new'|'updated'}. A ZIM is fresh when its newest
// event (first install or last update) is more recent than the user's last open
// of it, and within the backstop window.
function _zimBadge(z) {
  if (!z) return null;
  var fresh = Math.max(z.first_seen || 0, z.updated_at || 0);
  if (!fresh) return null;
  if ((Date.now() / 1000 - fresh) >= _ZIM_BADGE_BACKSTOP_DAYS * 86400) return null;
  if ((_getZimOpenedMap()[z.name] || 0) >= fresh) return null;
  return { label: (z.updated_at || 0) > (z.first_seen || 0) ? 'updated' : 'new' };
}

// ── #34 library filter pills: "Recently added" / "Recently updated" ──
// A distinct window from _ZIM_BADGE_BACKSTOP_DAYS on purpose: the badge is a
// short nudge that clears the moment you open a ZIM, whereas these pills are a
// durable "what landed this month" lens for someone managing a large library.
var _ZIM_RECENT_WINDOW_DAYS = 30;
function _zimRecentAdded(z) {
  var fs = z && z.first_seen;
  if (!fs) return false;
  return (Date.now() / 1000 - fs) < _ZIM_RECENT_WINDOW_DAYS * 86400;
}
function _zimRecentUpdated(z) {
  // An update means the file changed after first install (updated_at > first_seen).
  // A fresh install has updated_at unset (or == first_seen) and counts as "added",
  // not "updated" — matching how _zimBadge distinguishes the two.
  var ua = z && z.updated_at;
  if (!ua || ua <= (z.first_seen || 0)) return false;
  return (Date.now() / 1000 - ua) < _ZIM_RECENT_WINDOW_DAYS * 86400;
}
function _byFirstSeenDesc(a, b) { return (b.first_seen || 0) - (a.first_seen || 0); }
function _byUpdatedDesc(a, b) { return (b.updated_at || 0) - (a.updated_at || 0); }

// One recency filter pill. kind=null is the "All" reset; aria-pressed reflects
// state so the row is usable from the keyboard (each pill is a real <button>).
function _recentPill(kind, labelHtml, active) {
  return '<button class="pill' + (active ? ' active' : '') + '"' +
    ' aria-pressed="' + (active ? 'true' : 'false') + '"' +
    ' onclick="filterHomeRecent(' + (kind ? "'" + kind + "'" : 'null') + ')">' + labelHtml + '</button>';
}

// Toggle the recency filter: clicking the active pill (or "All") returns to the
// full library. Narrows the existing home sections in place — same model as the
// language pills.
function filterHomeRecent(kind) {
  hideSuggest(); // the pill may have been picked from the search dropdown
  homeRecentFilter = (homeRecentFilter === kind) ? null : kind;
  renderHome();
}

// One language filter pill for the home library. Multi-select toggle; the
// native language name matches the search-results lang pills (reusing the
// existing _NATIVE_LANG_NAMES map, with _langDisplayName as fallback).
function _homeLangPill(code, count, active) {
  var name = _NATIVE_LANG_NAMES[code] || _langDisplayName(code) || code.toUpperCase();
  return '<button class="pill' + (active ? ' active' : '') + '"' +
    ' aria-pressed="' + (active ? 'true' : 'false') + '"' +
    // escJs, not escAttr: an entity-escaped quote decodes back to a live quote
    // inside the onclick JS string — third-party ZIM language codes must not
    // be able to break out.
    ' onclick="filterHomeLang(\'' + escJs(code) + '\')">' +
    esc(name) + ' <span class="pill-count">' + count + '</span></button>';
}

function filterHomeLang(code) {
  hideSuggest(); // the pill may have been picked from the search dropdown
  // Toggle membership; empty Set = all languages.
  if (homeLangFilter.has(code)) homeLangFilter.delete(code);
  else homeLangFilter.add(code);
  renderHome();
}

// "All" reset for the home language row — clears every language selection.
function clearHomeLang() {
  hideSuggest();
  homeLangFilter.clear();
  renderHome();
}

// Re-run a stored search — the same path the history dropdown uses.
function _runRecentSearch(query, zim) {
  q.value = query;
  if (zim) enterSource(zim);
  doSearch(query);
}

// Home library layout: compact "tiles" vs the default full-card "list". A
// per-browser preference (localStorage) so it survives reloads; default is the
// current card list.
function _getLibraryView() {
  return localStorage.getItem(SK.LIBRARY_VIEW) === 'tiles' ? 'tiles' : 'list';
}
function _setLibraryView(mode) {
  if (mode !== 'tiles') mode = 'list';
  try { localStorage.setItem(SK.LIBRARY_VIEW, mode); } catch (e) {}
  renderHome();  // scope/recency filters are module state, so this re-renders in place
}
// The grid/list segmented toggle. Both glyphs are always shown; the active one
// is aria-pressed. It's a global view control but lives on the first section
// header's line (right-aligned) — _placeViewToggle injects it there after render.
// stopPropagation keeps a click off the enclosing clickable heading's onclick.
function _libViewToggleHtml() {
  var view = _getLibraryView();
  var listSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><line x1="5" y1="3.5" x2="14" y2="3.5"/><line x1="5" y1="8" x2="14" y2="8"/><line x1="5" y1="12.5" x2="14" y2="12.5"/><circle cx="2" cy="3.5" r="1"/><circle cx="2" cy="8" r="1"/><circle cx="2" cy="12.5" r="1"/></svg>';
  var gridSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="4.5" height="4.5" rx="1"/><rect x="9.5" y="2" width="4.5" height="4.5" rx="1"/><rect x="2" y="9.5" width="4.5" height="4.5" rx="1"/><rect x="9.5" y="9.5" width="4.5" height="4.5" rx="1"/></svg>';
  return '<span class="lib-view-toggle" role="group" aria-label="' + escAttr(t('library_view')) + '">' +
    '<button class="lib-view-btn' + (view === 'list' ? ' active' : '') + '" aria-pressed="' + (view === 'list') + '" title="' + escAttr(t('view_list')) + '" aria-label="' + escAttr(t('view_list')) + '" onclick="event.stopPropagation();_setLibraryView(\'list\')">' + listSvg + '</button>' +
    '<button class="lib-view-btn' + (view === 'tiles' ? ' active' : '') + '" aria-pressed="' + (view === 'tiles') + '" title="' + escAttr(t('view_tiles')) + '" aria-label="' + escAttr(t('view_tiles')) + '" onclick="event.stopPropagation();_setLibraryView(\'tiles\')">' + gridSvg + '</button>' +
    '</span>';
}

// Place the segmented view toggle on the first section header (Favorites, or the
// first category/collection) — a global control that reuses the first header's
// line rather than a bar of its own. No-op when there is no header to host it.
function _placeViewToggle() {
  if (!zimsCache || !zimsCache.length) return;
  var heading = output.querySelector('.cat-heading');
  if (!heading || heading.querySelector('.lib-view-toggle')) return;
  heading.classList.add('has-view-toggle');
  heading.insertAdjacentHTML('beforeend', _libViewToggleHtml());
}

// ── About this ZIM: provenance badges, and the panel behind them ────────────
//
// Every ZIM carries its own description in metadata, and the ones Zimi made
// carry a provenance history besides. Two surfaces read it, both from
// /zim-info: a quiet type badge on the card (what this ZIM IS), and a panel on
// right-click/long-press (everything the file says about itself). Neither
// invents a row — a ZIM published by somebody else shows its publisher's own
// fields and no history, because that is the truth about it.
//
// The badge is derived from METADATA and never from the title. A capture whose
// title happens to read "(alive)" gets no badge for it; a capture whose Tags
// carry zimi:alive does.

// {name: {mode, engine, edits, ts, counts, blocked}} for the ZIMs Zimi made.
// A name absent from the map gets no badge — which is every Kiwix ZIM.
var _zimKinds = null;
var _zimKindsPending = false;

// A creation mode → the badge's label key. `import` is the one mode no history
// record states: it is inferred server-side from the converter that wrote the
// file (see _zimi_kind in http.py).
var _PROV_MODE_KEYS = {
  folder: 'zi_kind_folder',
  page: 'zi_kind_page',
  pages: 'zi_kind_pages',
  site: 'zi_kind_site',
  video: 'zi_kind_video',
  bookmarks: 'zi_kind_bookmarks',
  import: 'zi_kind_import',
};
// The engine outranks the mode where the two differ: a replay ZIM opens into a
// replay shell and behaves unlike an article ZIM, whatever it captured.
function _provKindKey(kind) {
  if (!kind) return '';
  if (kind.engine === 'alive') return 'zi_kind_alive';
  return _PROV_MODE_KEYS[kind.mode] || 'zi_kind_zimi';
}

// The badge's tooltip: one sentence saying where this ZIM came from. Whole
// sentences per case rather than glued fragments, so every language can put the
// clauses in its own order.
function _provSummary(kind) {
  if (!kind) return '';
  var when = kind.ts ? _relTime(kind.ts) : '';
  if (!when) return t('zi_tip_made');
  if (kind.edits > 0) return tPlural('zi_tip_edited', kind.edits, { when: when });
  return t('zi_tip_made_when', { when: when });
}

// The badge for a kind — no kind, no badge, which is every ZIM Zimi did not
// make. The panel renders from the kind its own fetch returned; the cards
// render from the map (below), so neither has to wait on the other.
function _provBadgeFor(kind) {
  if (!kind) return '';
  return '<span class="prov-badge' + (kind.engine === 'alive' ? ' prov-alive' : '') +
    '" title="' + escAttr(_provSummary(kind)) + '">' + tH(_provKindKey(kind)) + '</span>';
}

function _provBadgeHtml(name) {
  return _provBadgeFor(_zimKinds && _zimKinds[name]);
}

// Fetched once per page load, after the first paint: reading provenance means
// opening archives, and no card should wait on that. Every render after this
// resolves includes the badges inline; the cards already on screen get them
// from _paintProvBadges.
function _loadZimKinds() {
  if (_zimKinds || _zimKindsPending) return;
  _zimKindsPending = true;
  serverFetch('/zim-info?kinds=1')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      _zimKinds = (d && d.kinds) || {};
      _paintProvBadges();
      _refreshCreatedBuckets();
    })
    .catch(function () { _zimKinds = {}; })
    .finally(function () { _zimKindsPending = false; });
}

// Kinds land after the first paint. If any uncategorized ZIM just gained its
// Created filing (see _zimCat), repaint whichever list view is actually on
// screen once, so home and the manage Library agree from the first look. Uses
// the same view guard the connectivity-restore path uses: never repaint over
// an open reader or source view.
function _refreshCreatedBuckets() {
  var moved = (zimsCache || []).some(function(z) {
    return !z.category && _zimKinds && _zimKinds[z.name];
  });
  if (!moved) return;
  if (mode === 'manage') {
    if (manageTab === 'installed') renderInstalled();
  } else if (!readerOpen && !currentSource && !readerSource) {
    renderHome();
  }
}

// No-op on a card that already carries its badge, so this is safe to call after
// any render.
function _paintProvBadges() {
  if (!_zimKinds) return;
  document.querySelectorAll('.stat-card[data-zim]').forEach(function (card) {
    if (card.querySelector('.prov-badge')) return;
    var html = _provBadgeHtml(card.dataset.zim);
    if (!html) return;
    var nameRow = card.querySelector('.name');
    if (nameRow) nameRow.insertAdjacentHTML('beforeend', html);
  });
}

// ── The panel ──

var _ZI_OVERLAY_ID = 'zim-about';
// Which count keys a provenance record can carry, and what each one is called.
var _ZI_COUNT_KEYS = { pages: 'zi_n_pages', assets: 'zi_n_assets', videos: 'zi_n_videos' };
var _ZI_OP_KEYS = { created: 'zi_op_created', edited: 'zi_op_edited', truncated: 'zi_op_truncated' };
// The mode the truncation marker carries — a bookkeeping value, not a capture
// mode, so it never gets a chip of its own.
var _ZI_HISTORY_MODE = 'history';

// Absolute local date-time for a provenance timestamp. The relative form rides
// in the tooltip, where it explains the absolute one instead of replacing it.
function _ziWhen(tsSec) {
  var d = new Date(tsSec * 1000);
  try {
    return d.toLocaleString(_currentLang || 'en',
      { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return d.toLocaleString();
  }
}

function _ziRow(labelKey, valueHtml) {
  if (!valueHtml) return '';
  return '<div class="zi-row"><span class="zi-k">' + tH(labelKey) + '</span>' +
    '<span class="zi-v">' + valueHtml + '</span></div>';
}

// A Source is linked only when it IS a URL — openZIM's own rule for the field,
// and the reason a folder name stays plain text here.
function _ziSourceHtml(source) {
  if (!source) return '';
  if (!/^https?:\/\//i.test(source)) return esc(source);
  return '<a href="' + escAttr(source) + '" target="_blank" rel="noopener noreferrer">' + esc(source) + '</a>';
}

function _ziTagsHtml(tags) {
  if (!tags || !tags.length) return '';
  return tags.map(function (tag) {
    return '<span class="zi-tag">' + esc(tag) + '</span>';
  }).join('');
}

// The numbers a record knows, in one line. Only the keys actually present are
// named — a record that never counted assets must not claim zero of them.
function _ziCountsText(counts) {
  if (!counts) return '';
  var out = [];
  for (var key in _ZI_COUNT_KEYS) {
    if (typeof counts[key] === 'number') out.push(tPlural(_ZI_COUNT_KEYS[key], counts[key]));
  }
  if (typeof counts.records === 'number') out.push(tPlural('zi_n_records', counts.records));
  if (typeof counts.bytes === 'number') out.push(_fmtBytes(counts.bytes));
  return out.join(' · ');
}

// What a capture REFUSED, when it refused anything. The list identity belongs
// beside the number: "214 blocked" is a fact about the capture, and which
// published list said so is what makes it reproducible.
function _ziBlockedHtml(blocked) {
  if (!blocked || !blocked.requests) return '';
  var base = blocked.list
    ? tPlural('zi_blocked', blocked.requests, { list: blocked.list })
    : tPlural('zi_blocked_bare', blocked.requests);
  var sub = [];
  if (blocked.domains) sub.push(tPlural('zi_n_domains', blocked.domains));
  if (blocked.snapshot) sub.push(t('zi_blocked_snapshot', { date: blocked.snapshot }));
  if (blocked.override) sub.push(t('zi_blocked_override'));
  return '<div class="zi-ev-fact zi-ev-blocked">' + esc(base) + '</div>' +
    (sub.length ? '<div class="zi-ev-fact zi-ev-sub">' + esc(sub.join(' · ')) + '</div>' : '');
}

// The engines that ran, named with their versions — plus Zimi's own version,
// which every record stamps.
function _ziToolsText(record) {
  var out = [];
  if (record.zimi) out.push('Zimi ' + record.zimi);
  var tools = record.tools || {};
  for (var name in tools) out.push(name + ' ' + tools[name]);
  return out.join(' · ');
}

function _ziRecordHtml(record) {
  var op = _ZI_OP_KEYS[record.op] ? t(_ZI_OP_KEYS[record.op]) : (record.op || '');
  var mode = record.mode && record.mode !== _ZI_HISTORY_MODE
    ? '<span class="zi-ev-mode">' + tH(_PROV_MODE_KEYS[record.mode] || 'zi_kind_zimi') + '</span>'
    : '';
  var when = record.ts
    ? '<span class="zi-ev-when" title="' + escAttr(_relTime(record.ts)) + '">' + esc(_ziWhen(record.ts)) + '</span>'
    : '';
  var counts = _ziCountsText(record.counts);
  var tools = _ziToolsText(record);
  return '<li class="zi-ev">' +
    '<div class="zi-ev-head"><span class="zi-ev-op">' + esc(op) + '</span>' + mode + when + '</div>' +
    // The detail sentence is what the FILE says, written when the ZIM was made.
    // It is provenance, not UI copy, so it is shown verbatim and never
    // translated — a record that changed wording per reader would be worthless.
    (record.detail ? '<div class="zi-ev-detail">' + esc(record.detail) + '</div>' : '') +
    (counts ? '<div class="zi-ev-fact">' + esc(counts) + '</div>' : '') +
    _ziBlockedHtml(record.blocked) +
    (tools ? '<div class="zi-ev-fact zi-ev-sub">' + esc(tools) + '</div>' : '') +
    '</li>';
}

// Metadata fields with no row of their own, listed under their own keys. The
// keys are the file's, not the UI's, so they are shown verbatim rather than
// translated or title-cased.
function _ziOtherHtml(other) {
  var keys = other ? Object.keys(other) : [];
  if (!keys.length) return '';
  return '<div class="zi-sec">' + tH('zi_other') + '</div><div class="zi-rows">' +
    keys.map(function (key) {
      return '<div class="zi-row"><span class="zi-k zi-k-raw">' + esc(key) + '</span>' +
        '<span class="zi-v">' + esc(other[key]) + '</span></div>';
    }).join('') + '</div>';
}

function _ziBodyHtml(info) {
  // Same icon rule the cards follow: the ZIM's own illustration when it has
  // one, its initial otherwise. An empty frame would read as a broken image.
  var iconHtml = '<span class="zi-icon">' + (info.has_icon
    ? '<img src="/w/' + encodeURIComponent(info.name) + '/-/icon" alt="" width="48" height="48">'
    : '<span class="zi-letter">' + (esc(info.title || info.name)[0] || '?').toUpperCase() + '</span>') +
    '</span>';
  // Articles and entries are different numbers (entries count redirects and
  // assets too), and the panel is the one place precise enough to say both.
  var num = function (v) { return typeof v === 'number' ? esc(v.toLocaleString()) : ''; };
  var head = '<div class="zi-id">' + iconHtml +
    // From the kind this fetch returned, not the cards' map: the panel opens
    // from surfaces the map was never loaded for.
    '<div class="zi-id-text"><div class="zi-title">' + esc(info.title || info.name) +
    _provBadgeFor(info.kind) + '</div>' +
    (info.description ? '<div class="zi-desc">' + esc(info.description) + '</div>' : '') +
    '</div></div>';
  var rows =
    (info.long_description ? '<div class="zi-long">' + esc(info.long_description) + '</div>' : '') +
    '<div class="zi-rows">' +
    _ziRow('zi_identifier', esc(info.name)) +
    _ziRow('zi_file', esc(info.file)) +
    _ziRow('language', info.language ? esc(_langDisplayName(info.language) || info.language) : '') +
    _ziRow('zi_articles', num(info.article_count)) +
    _ziRow('zi_entries', num(info.entries)) +
    _ziRow('zi_size', info.size_bytes ? esc(_fmtBytes(info.size_bytes)) : '') +
    _ziRow('zi_date', esc(info.date)) +
    _ziRow('zi_creator', esc(info.creator)) +
    _ziRow('zi_publisher', esc(info.publisher)) +
    _ziRow('zi_source', _ziSourceHtml(info.source)) +
    _ziRow('zi_scraper', esc(info.scraper)) +
    _ziRow('zi_flavour', esc(info.flavour)) +
    _ziRow('zi_tags', _ziTagsHtml(info.tags)) +
    '</div>';
  // A ZIM Zimi did not make has no history, and says so plainly rather than
  // showing an empty heading or inventing rows from its publisher's fields.
  var history = (info.history && info.history.length)
    ? '<div class="zi-sec">' + tH('zi_history') + '</div><ul class="zi-timeline">' +
      info.history.map(_ziRecordHtml).join('') + '</ul>'
    : '<div class="zi-none">' + tH('zi_no_history') + '</div>';
  var warn = info.readable ? '' : '<div class="zi-warn">' + tH('zi_unreadable') + '</div>';
  // What the ZIM is made of, out of the same reply as everything else. Absent
  // until the background worker has measured this file, and absent reads as no
  // bar — which is right, because nobody has established the fact yet.
  var shape = _ziShapeHtml(info.shape);
  // Whatever else the publisher wrote goes last, under its own keys: a field
  // this build has no row for is still a field the file carries, but it is a
  // footnote to the story the timeline tells, not a preface to it.
  return warn + head + rows + shape + history + _ziOtherHtml(info.other);
}

// What the ZIM is made of, as the same segmented bar the create page's done
// card and the cache breakdown use — one component (_segBarHtml), so the three
// never drift apart. Eric: "I want the file breakdown bar chart in about this
// zim for all zims."
//
// A sampled answer SAYS it is sampled. Reading six thousand entries out of six
// million gives proportions worth drawing and totals that are estimates, and a
// panel that printed the estimate in the same voice as a measurement would be
// doing the thing this release spent a day removing.
function _ziShapeHtml(shape) {
  if (!shape || !shape.breakdown || !shape.breakdown.length) return '';
  if (typeof _segBarHtml !== 'function') return '';
  var segs = shape.breakdown.slice().sort(function (a, b) {
    return (b.size_bytes || 0) - (a.size_bytes || 0);
  });
  // The bar is proportional to what is INSIDE; the file on disk is smaller,
  // because a ZIM is compressed. Two honest numbers rather than one bar
  // pretending its segments add up to the file size.
  var inner = segs.reduce(function (a, x) { return a + (x.size_bytes || 0); }, 0);
  var bar = _segBarHtml(segs, inner, _CREATE_KIND_COLORS, function (k) {
    return tH('create_kind_' + k);
  }, t('create_inside_title'));
  if (!bar) return '';
  var note = shape.sampled
    ? '<div class="zi-shape-note">' + tH('zi_shape_sampled', {
        n: (shape.sampled_entries || 0).toLocaleString(),
        total: (shape.total_entries || 0).toLocaleString()
      }) + '</div>'
    : '';
  return '<div class="zi-sec">' + tH('create_inside_title') + '</div>' + bar + note;
}

// The colours the create page's done card uses, so one ZIM looks the same
// whichever surface describes it. Defined here because app.js always loads and
// create.js is lazy — the About panel must not depend on having opened Create.
var _CREATE_KIND_COLORS = {
  images: '#f59e0b',
  video: '#a78bfa',
  audio: '#c084fc',
  pages: '#60a5fa',
  documents: '#38bdf8',
  data: '#22d3ee',
  fonts: '#34d399',
  styles: '#f472b6',
  scripts: '#fbbf24',
  other: '#6e6e7a',
};

function _ziKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); _closeZimAbout(); }
}

function _closeZimAbout() {
  var ov = document.getElementById(_ZI_OVERLAY_ID);
  if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  document.documentElement.classList.remove('zi-open');
  document.removeEventListener('keydown', _ziKeydown);
}

// Opens the panel immediately with a loading line, then fills it — the fetch
// opens the archive, and on a cold library that is not instant. Every write
// re-finds the body, so a panel closed mid-flight is never resurrected.
function _openZimAbout(zim) {
  _closeZimAbout();
  var ov = document.createElement('div');
  ov.className = 'zi-overlay';
  ov.id = _ZI_OVERLAY_ID;
  ov.innerHTML =
    '<div class="zi-panel" role="dialog" aria-modal="true" aria-label="' + escAttr(t('about_zim')) + '">' +
    '<div class="zi-head"><span class="zi-head-title">' + tH('about_zim') + '</span>' +
    '<button class="zi-close" aria-label="' + escAttr(t('close')) + '" onclick="_closeZimAbout()">✕</button>' +
    '</div><div class="zi-body"><div class="zi-none">' + tH('loading') + '</div></div></div>';
  document.body.appendChild(ov);
  // Freeze the library behind the panel. Without this the page kept scrolling
  // under a modal, which is the one thing a modal is for.
  document.documentElement.classList.add('zi-open');
  ov.addEventListener('click', function (e) { if (e.target === ov) _closeZimAbout(); });
  document.addEventListener('keydown', _ziKeydown);
  var closeBtn = ov.querySelector('.zi-close');
  if (closeBtn) closeBtn.focus();
  var write = function (html) {
    var body = document.querySelector('#' + _ZI_OVERLAY_ID + ' .zi-body');
    if (body) body.innerHTML = html;
  };
  serverFetch('/zim-info?zim=' + encodeURIComponent(zim))
    .then(function (r) {
      if (!r.ok) throw new Error('zim-info ' + r.status);
      return r.json();
    })
    .then(function (info) { write(_ziBodyHtml(info)); })
    .catch(function () { write('<div class="zi-none">' + tH('zi_load_failed') + '</div>'); });
}

function renderCardGrid(items, showStars, showCategory) {
  if (!items || !items.length) return '';
  const favs = (collectionsCache && collectionsCache.favorites) || [];
  const isTiles = _getLibraryView() === 'tiles';
  const gridCls = isTiles ? 'stats-grid tiles' : 'stats-grid';
  // Export cards carry a download slot that fills only when peer-share is live
  // (see _fillCardDlSlots) — probed after the caller's synchronous insert.
  // Download-this-ZIM is right-click / Manage-⋯ only; no card pill.
  return '<div class="' + gridCls + '">' + items.map(z => {
    const icon = z.has_icon
      ? '<img src="/w/' + encodeURIComponent(z.name) + '/-/icon" alt="" width="48" height="48" loading="lazy">'
      : '<span class="icon-letter">' + esc(z.title || z.name)[0].toUpperCase() + '</span>';
    const isFav = favs.includes(z.name);
    // preventDefault too: the card is now an anchor (#49), and a button click
    // inside a link otherwise still follows the link's href.
    const starHtml = showStars
      ? '<button class="star-btn' + (isFav ? ' starred' : '') + '" onclick="event.preventDefault();event.stopPropagation();toggleFavorite(\'' + escAttr(z.name) + '\')" title="' + escAttr(isFav ? t('remove_from_favorites') : t('add_to_favorites')) + '">' + (isFav ? '\u2605' : '\u2606') + '</button>'
      : '';
    const catPrefix = showCategory && z.category ? '<span class="card-cat">' + esc(z.category) + '</span> &middot; ' : '';
    const badge = _langBadge(z, false, isTiles);
    const qidIcon = z.has_qids
      ? '<span class="qid-badge" title="' + escAttr(t('cross_lang_linking')) + '"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6l-3 3 3 3"/><path d="M1 9h10"/><path d="M12 10l3-3-3-3"/><path d="M15 7H5"/></svg></span>'
      : '';
    const badgeInfo = _zimBadge(z);
    const isUpd = badgeInfo && badgeInfo.label === 'updated';
    const newHtml = badgeInfo
      ? '<span class="new-badge' + (isUpd ? ' updated-badge' : '') + '" title="' + escAttr(t(isUpd ? 'recently_updated' : 'recently_installed')) + '">' + tH(isUpd ? 'updated_badge' : 'new_badge') + '</span>'
      : '';
    // Every card is a real link (#49): right/middle/modifier clicks open the
    // source natively. Downloading the raw .zim is a rare, deliberate act —
    // it lives on right-click and the Manage row's ⋯ menu, never as a pill
    // taking space on the card (Eric: "no big buttons... it's rare to need").
    const cardTag = 'a';
    const cardNav = ' href="/w/' + encodeURIComponent(z.name) + '" onclick="return _spaSourceClick(event, this)"';
    return '<' + cardTag + ' class="stat-card' + (newHtml ? ' is-new' : '') + '" data-zim="' + escAttr(z.name) + '"' + cardNav + '>' +
      starHtml +
      '<div class="card-icon">' + icon + '</div>' +
      '<div class="card-info">' +
        // new-badge lives in the title row (list) — never over the left icon;
        // CSS lifts it to a tile corner in compact view (icon is centred there).
        // The title text is wrapped in .zt so the tile layout can clamp it to two
        // lines independently and drop the language chip onto its own line below
        // (in the list the .zt span is inline, so nothing changes there).
        '<div class="name">' + newHtml + '<span class="zt">' + esc(z.title || z.name) + '</span>' + badge + qidIcon + _provBadgeHtml(z.name) + '</div>' +
        (z.description ? '<div class="desc">' + esc(z.description) + '</div>' : '') +
        '<div class="detail">' + catPrefix + _zimCountHtml(z) +
        ' &middot; ' + fmtSize(z.size_gb) +
        (_isZimiExport(z) && z.date ? ' &middot; ' + esc(z.date) : '') +
        '</div>' +
      '</div></' + cardTag + '>';
  }).join('') + '</div>';
}

// ── Discover: computed cards first, random fill to ~4 ──
// Slot order: 1) Today (always), 2) APOD (if installed), 3) On This Day (if Wikipedia), 4+) 🎲 Random
var _discoverLoading = false;

function _moonPhase(date) {
  // True phase from the Moon–Sun elongation (Meeus, main periodic terms).
  // The old linear-synodic model drifted the age and quarter dates up to
  // ~0.6 day and mislabeled the quarters (equal 1/8 bins made "First
  // Quarter" span 31–69% illumination).
  var rad = Math.PI / 180;
  var JD = date.getTime() / 86400000 + 2440587.5;
  var T = (JD - 2451545.0) / 36525.0;
  var D  = 297.8501921 + 445267.1114034 * T - 0.0018819 * T * T;   // elongation
  var M  = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T;    // sun anomaly
  var Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T;   // moon anomaly
  var F  = 93.2720950 + 483202.0175233 * T - 0.0036539 * T * T;    // moon arg. of lat.
  var Lp = 218.3164477 + 481267.88123421 * T;                      // moon mean longitude
  var Ls = 280.4664567 + 36000.76982779 * T;                       // sun mean longitude
  var lambdaMoon = Lp
    + 6.289 * Math.sin(Mp * rad)
    + 1.274 * Math.sin((2 * D - Mp) * rad)
    + 0.658 * Math.sin(2 * D * rad)
    + 0.214 * Math.sin(2 * Mp * rad)
    - 0.186 * Math.sin(M * rad)
    - 0.114 * Math.sin(2 * F * rad)
    + 0.059 * Math.sin((2 * D - 2 * Mp) * rad)
    + 0.057 * Math.sin((2 * D - M - Mp) * rad);
  var lambdaSun = Ls
    + (1.9146 - 0.004817 * T) * Math.sin(M * rad)
    + 0.019993 * Math.sin(2 * M * rad);
  var elong = (((lambdaMoon - lambdaSun) % 360) + 360) % 360; // 0=new, 180=full
  var phase = elong / 360;
  var illumExact = (1 - Math.cos(elong * rad)) / 2 * 100;
  var illum = Math.round(illumExact * 10) / 10;
  // Name by NARROW windows around the principal phases (±0.6 day), so the
  // crescent/gibbous ranges get their fair share and quarters read ~50%.
  var w = 0.02, name;
  if (phase < w || phase > 1 - w) name = 'New Moon';
  else if (phase < 0.25 - w) name = 'Waxing Crescent';
  else if (phase < 0.25 + w) name = 'First Quarter';
  else if (phase < 0.5 - w) name = 'Waxing Gibbous';
  else if (phase < 0.5 + w) name = 'Full Moon';
  else if (phase < 0.75 - w) name = 'Waning Gibbous';
  else if (phase < 0.75 + w) name = 'Last Quarter';
  else name = 'Waning Crescent';
  return { phase: phase, name: name, illumination: illum };
}

// Moon time-travel animation — shared by the hero disc and the sky-scene moon.
// A jump doesn't snap the phase: the moon is sampled at real intermediate
// instants so the terminator sweeps along its TRUE path (a two-week jump really
// passes through full on its way from gibbous to new), as if a camera stayed on
// it the whole way. Tilt is NOT sampled this way -- the parallactic angle
// cycles daily, so real tilt-at-t strobes; the renderers interpolate tilt
// straight from A to B instead.
var _MOON_SYNODIC_MS = 29.530588853 * 86400000;   // one lunation
// Duration scales gently with the span so a one-day nudge is quick and a
// multi-week sweep lingers, capped so a deep-time jump can't run long.
var _MOON_ANIM_BASE_MS = 600;
var _MOON_ANIM_PER_CYCLE_MS = 420;
var _MOON_ANIM_MAX_MS = 1500;
// Past this many lunations we stop animating every real cycle (thousands would
// strobe) and instead sweep a bounded number that still LANDS on the true
// destination phase -- fast-flowing phases rather than a blur.
var _MOON_ANIM_MAX_CYCLES = 3;

// Moon phase { phase, illumination } at animation progress e in [0,1] for a
// jump from fromTime to toTime (ms). Real astronomy along the true time path
// within the cycle cap; a compressed-but-correct sweep beyond it.
function _moonAnimPhaseAt(fromTime, toTime, e) {
  var span = toTime - fromTime;
  if (Math.abs(span) <= _MOON_ANIM_MAX_CYCLES * _MOON_SYNODIC_MS) {
    return _moonPhase(new Date(fromTime + span * e));
  }
  var p0 = _moonPhase(new Date(fromTime)).phase;
  var p1 = _moonPhase(new Date(toTime)).phase;
  var dir = span >= 0 ? 1 : -1;
  var frac = dir > 0 ? (((p1 - p0) % 1) + 1) % 1 : -((((p0 - p1) % 1) + 1) % 1);
  var advance = frac + dir * _MOON_ANIM_MAX_CYCLES;   // whole cycles + landing frac
  var ph = (((p0 + advance * e) % 1) + 1) % 1;
  return { phase: ph, illumination: (1 - Math.cos(ph * 2 * Math.PI)) / 2 * 100 };
}

// How long to sweep a jump of the given span (ms), scaled and capped.
function _moonAnimDurMs(fromTime, toTime) {
  var cycles = Math.abs(toTime - fromTime) / _MOON_SYNODIC_MS;
  return Math.max(_MOON_ANIM_BASE_MS,
    Math.min(_MOON_ANIM_MAX_MS, _MOON_ANIM_BASE_MS + cycles * _MOON_ANIM_PER_CYCLE_MS));
}

var _MOON_PHASE_I18N = {
  'New Moon': 'moon_new', 'Waxing Crescent': 'moon_waxing_crescent',
  'First Quarter': 'moon_first_quarter', 'Waxing Gibbous': 'moon_waxing_gibbous',
  'Full Moon': 'moon_full', 'Waning Gibbous': 'moon_waning_gibbous',
  'Last Quarter': 'moon_last_quarter', 'Waning Crescent': 'moon_waning_crescent'
};
function _localMoonName(name) { return _MOON_PHASE_I18N[name] ? t(_MOON_PHASE_I18N[name]) : name; }

// ── Moon rendering — the real photo, shaded per-pixel, shared everywhere ──
// The old renderer stacked two solid half-discs under a scaled-ellipse
// terminator: a razor-sharp edge, a hard seam at the quarters, no limb
// darkening. This draws the full-resolution moon photo and multiplies it by a
// physically-shaded brightness map — normal·Sun for a soft terminator, limb
// darkening toward the rim, and an earthshine FLOOR so the shadowed side stays
// a visible (cool, dim) sphere rather than going black. Static per phase, so
// it's computed once and cached.
var _MOON_TEX = new Image();
var _moonTexReady = false;
_MOON_TEX.onload = function() {
  _moonTexReady = true;
  _moonSpriteCache = {};
  if (typeof _repaintMoons === 'function') _repaintMoons();
};
_MOON_TEX.src = '/static/moon.png?v=2';

var _moonSpriteCache = {};

// Hermite ease between two edges. Also used by the lazy-loaded almanac
// scripts, which app.js always loads first.
function _smoothstep(a, b, x) {
  var t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Sprite for an illuminated fraction (0..1) and waxing flag → data URL.
// Untilted (lit limb on the right when waxing); the caller rotates it.
function _renderMoonSprite(illumFrac, waxing, sizePx) {
  var key = Math.round(illumFrac * 100) + (waxing ? 'w' : 'a') + 'x' + sizePx +
    (_moonTexReady ? 't' : '');
  if (_moonSpriteCache[key]) return _moonSpriteCache[key];
  var url = _moonSpriteCanvas(illumFrac, waxing, sizePx).toDataURL('image/png');
  _moonSpriteCache[key] = url;
  return url;
}

// The unshaded source pixels for a sprite size — the moon photo (or, before it
// loads, a neutral grey disc) rasterized at N and read back ONCE per size.
// _moonSpriteCanvas used to drawImage + getImageData per phase bucket; the
// readback is a GPU sync stall (WebKit measured ~6.6ms/bucket at 128px, ~100
// buckets on a cold fast lever throw). Shading now copies these cached pixels,
// so a new bucket costs only the JS shading loop + one putImageData.
var _moonTexBaseCache = {};
function _moonTexBaseData(N) {
  var key = N + (_moonTexReady ? 't' : '');
  if (_moonTexBaseCache[key]) return _moonTexBaseCache[key];
  var cv = document.createElement('canvas');
  cv.width = cv.height = N;
  var ctx = cv.getContext('2d', { willReadFrequently: true });
  // Same-origin photo, so getImageData won't taint.
  if (_moonTexReady) {
    ctx.drawImage(_MOON_TEX, 0, 0, N, N);
  } else {
    ctx.fillStyle = '#b8b4aa';
    ctx.beginPath(); ctx.arc(N / 2, N / 2, N / 2, 0, Math.PI * 2); ctx.fill();
  }
  var img = ctx.getImageData(0, 0, N, N);
  _moonTexBaseCache[key] = img;
  return img;
}

// The shaded moon as a <canvas> (cached) — the sky scene draws it directly so
// its dark side shows the same earthshine as the hero, not a black shadow.
var _moonSpriteCanvasCache = {};
function _moonSpriteCanvas(illumFrac, waxing, sizePx) {
  var key = Math.round(illumFrac * 100) + (waxing ? 'w' : 'a') + 'x' + sizePx +
    (_moonTexReady ? 't' : '');
  if (_moonSpriteCanvasCache[key]) return _moonSpriteCanvasCache[key];

  // Render at the display's device resolution (2× the CSS size on retina),
  // capped at 512, so the per-pixel shading — terminator haze, limb darkening,
  // the edge — stays crisp when the hero moon is zoomed. The maria come from
  // the 256px photo, so their fine detail is bounded by that source; upscaling
  // the shading past it still sharpens every gradient the math draws.
  var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
  var N = Math.min(512, Math.max(64, Math.round(sizePx * dpr)));
  var cv = document.createElement('canvas');
  cv.width = cv.height = N;
  var ctx = cv.getContext('2d');
  var base = _moonTexBaseData(N);
  var img = new ImageData(new Uint8ClampedArray(base.data), N, N);
  var data = img.data;

  // Sun direction: phase angle P from illuminated fraction (k = (1+cosP)/2).
  var cosP = 2 * illumFrac - 1;
  var sinP = Math.sqrt(Math.max(0, 1 - cosP * cosP));
  var sx = (waxing ? 1 : -1) * sinP, sz = cosP;
  var term = 0.055;                 // terminator half-width (haze) in dot units
  // Earthshine: the shadowed side stays clearly visible (a dim, cool disc),
  // brightest near new moon when the Earth is "full" in the Moon's sky.
  var earth = 0.16 + 0.10 * (1 - illumFrac);

  for (var py = 0; py < N; py++) {
    var y = (py + 0.5) / N * 2 - 1;              // +1 top .. -1 bottom
    for (var px = 0; px < N; px++) {
      var x = (px + 0.5) / N * 2 - 1;
      var r2 = x * x + y * y;
      var o = (py * N + px) * 4;
      if (r2 >= 1.0) { data[o + 3] = 0; continue; }
      var z = Math.sqrt(1 - r2);                 // toward viewer
      var lit = _smoothstep(-term, term, x * sx + z * sz);
      var limb = Math.pow(z, 0.42);              // limb darkening
      var litI = lit * limb;                     // sunlit component
      var darkI = (1 - lit) * earth * limb;      // earthshine component
      var m = litI + darkI;
      var warm = m > 0 ? litI / m : 0;           // 1 = fully sunlit, 0 = earthshine
      // Multiply the photo by brightness; sunlit side warm, earthshine cool.
      var R = data[o] * m * (0.99 + 0.05 * warm);
      var G = data[o + 1] * m;
      var B = data[o + 2] * m * (1.18 - 0.18 * warm);
      // Antialias the limb over the outer ~1px ring.
      var edge = _smoothstep(1.0, 1.0 - 2.4 / N, r2);
      data[o] = Math.min(255, R);
      data[o + 1] = Math.min(255, G);
      data[o + 2] = Math.min(255, B);
      data[o + 3] = 255 * edge;
    }
  }
  ctx.putImageData(img, 0, 0);
  _moonSpriteCanvasCache[key] = cv;
  return cv;
}

// Shared moon renderer — hero (almanac) + Today card. Returns HTML embedding
// the shaded sprite as an <img>, rotated by tiltDeg (the sprite math stays
// untilted so it's phase-cacheable; orientation is a whole-disc rotation).
function _renderMoonHTML(m, wrapClass, tiltDeg) {
  var illumFrac = m.illumination / 100;
  var waxing = _moonIsWaxing(m);
  var isHero = wrapClass === 'almanac-moon';
  var size = isHero ? 200 : 48;
  var url = _renderMoonSprite(illumFrac, waxing, size);
  var tilt = (tiltDeg || 0).toFixed(1);
  var base = wrapClass === 'dc-moon-wrap' ? 'translate(-50%,-50%) ' : '';
  var rot = tiltDeg ? 'rotate(' + tilt + 'deg)' : '';
  var xform = (base + rot).trim();
  return '<div class="' + wrapClass + '"' + (xform ? ' style="transform:' + xform + '"' : '') + '>' +
    '<img class="' + (isHero ? 'almanac-moon-sprite' : 'dc-moon-sprite') + ' moon-sprite" ' +
    'data-illum="' + illumFrac.toFixed(4) + '" data-waxing="' + (waxing ? 1 : 0) + '" data-size="' + size + '" ' +
    'src="' + url + '" alt="" width="' + size + '" height="' + size + '" />' +
    '</div>';
}

// Repaint already-rendered moon sprites in place — called when the texture
// finishes loading so a moon drawn before the albedo was ready upgrades to
// the textured version without a full re-render.
function _repaintMoons() {
  var imgs = document.querySelectorAll('img.moon-sprite');
  for (var i = 0; i < imgs.length; i++) {
    var el = imgs[i];
    var url = _renderMoonSprite(
      parseFloat(el.getAttribute('data-illum')) || 0,
      el.getAttribute('data-waxing') === '1',
      parseInt(el.getAttribute('data-size'), 10) || 48
    );
    if (el.src !== url) el.src = url;
  }
}

// ── Canonical moon orientation — ONE derivation for every renderer ──
// The hero disc (almanac.js _heroMoonTiltDeg), the sky-scene moon
// (almanac-sky.js) and the Today discover card (below) must all show the SAME
// moon for the same instant and place. They all rotate the same untilted
// sprite (lit limb at 3 o'clock when waxing) by the screen tilt computed here:
// -(chi - q) - 90, where chi is the bright-limb position angle (Meeus 48.5)
// and q the parallactic angle. This lives in app.js because the Today card
// renders before almanac.js loads; almanac.js delegates to it.

// Geocentric equatorial coordinates of the Moon — the same orbital-element
// evaluation _moonPosition (almanac.js) starts from, hoisted here so the two
// files cannot drift apart.
function _moonEqCoords(date) {
  var JD = 2440587.5 + date.getTime() / 86400000;
  var T = (JD - 2451545.0) / 36525;
  var D2R = Math.PI / 180;
  var L0 = (218.3165 + 481267.8813 * T) % 360;   // mean longitude
  var M  = (134.9634 + 477198.8676 * T) % 360;   // mean anomaly
  var Ms = (357.5291 +  35999.0503 * T) % 360;   // sun mean anomaly
  var F  = (93.2720  + 483202.0175 * T) % 360;   // argument of latitude
  var D  = (297.8502 + 445267.1115 * T) % 360;   // mean elongation
  var lng = L0
    + 6.289 * Math.sin(M * D2R)
    - 1.274 * Math.sin((2 * D - M) * D2R)
    - 0.658 * Math.sin(2 * D * D2R)
    - 0.214 * Math.sin(2 * M * D2R)
    - 0.186 * Math.sin(Ms * D2R);
  var lat_ec = 5.128 * Math.sin(F * D2R)
    + 0.281 * Math.sin((M + F) * D2R)
    + 0.278 * Math.sin((F - M) * D2R);
  var eps = 23.44 * D2R;
  var lngR = lng * D2R, latR = lat_ec * D2R;
  var dec = Math.asin(Math.sin(latR) * Math.cos(eps) + Math.cos(latR) * Math.sin(eps) * Math.sin(lngR));
  var ra = Math.atan2(Math.sin(lngR) * Math.cos(eps) - Math.tan(latR) * Math.sin(eps), Math.cos(lngR));
  return { JD: JD, T: T, ra: ra, dec: dec, eps: eps, Ms: Ms };
}

// Screen tilt (degrees, CSS/canvas rotation sense) of the untilted moon sprite
// for an observer at lat/lon: the bright limb faces the Sun as seen in that
// sky. chi is measured from celestial north; subtracting the parallactic
// angle q gives it from the observer's vertical; the sprite's lit limb starts
// at 3 o'clock and CSS rotation runs opposite the position-angle sense, hence
// -(chi - q) - 90.
function _moonScreenTiltDeg(date, lat, lon) {
  var eq = _moonEqCoords(date);
  var D2R = Math.PI / 180;
  var GMST = (280.46061837 + 360.98564736629 * (eq.JD - 2451545.0)) % 360;
  var HA = (GMST + lon) * D2R - eq.ra;
  var latR = lat * D2R;
  var q = Math.atan2(Math.sin(HA), Math.tan(latR) * Math.cos(eq.dec) - Math.sin(eq.dec) * Math.cos(HA));
  // Sun's equatorial position (low-precision) for the bright-limb angle chi.
  var Lsun = 280.4665 + 36000.7698 * eq.T;
  var lamSun = (Lsun + 1.915 * Math.sin(eq.Ms * D2R) + 0.020 * Math.sin(2 * eq.Ms * D2R)) * D2R;
  var raSun = Math.atan2(Math.cos(eq.eps) * Math.sin(lamSun), Math.cos(lamSun));
  var decSun = Math.asin(Math.sin(eq.eps) * Math.sin(lamSun));
  var dA = raSun - eq.ra;
  var chi = Math.atan2(Math.cos(decSun) * Math.sin(dA),
    Math.sin(decSun) * Math.cos(eq.dec) - Math.cos(decSun) * Math.sin(eq.dec) * Math.cos(dA));
  return -((chi - q) * 180 / Math.PI) - 90;
}

// Waxing predicate — shared so no renderer flips the terminator side on its
// own convention (the sky scene once used <= where the hero used <).
function _moonIsWaxing(m) { return m.phase < 0.5; }

// Today-card tilt: canonical derivation at the almanac's location fallback
// (same synthetic default as almanac.js _getLocation, which may not be loaded).
function _quickMoonTilt(date) {
  var ll = _getSessionJSON(SK.ALMANAC_LOC, null);
  var lat = ll ? ll.lat : 34, lon = ll ? ll.lon : -date.getTimezoneOffset() / 60 * 15;
  return _moonScreenTiltDeg(date, lat, lon);
}

// Lightweight almanac teaser for the Today discover card.
// Checks cached highlights (from almanac.js) first, falls back to simple computation.
function _todayTeaser() {
  var now = new Date(), y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
  // Check cache from full almanac computation
  {
    var cache = _getStorageJSON(SK.ALMANAC_HL, null);
    if (cache && cache.date === now.toISOString().substring(0, 10) && cache.items && cache.items.length > 0) {
      var it = cache.items[0];
      if (it.type === 'holiday') return it.name;
      if (it.type === 'meteor') return it.days === 0 ? t('teaser_peak_tonight', { name: it.name }) + ' \u00b7 ZHR ' + it.zhr
        : t('teaser_in_days', { name: it.name, n: it.days }) + ' \u00b7 ZHR ' + it.zhr;
      if (it.type === 'eclipse') return it.name + (it.until ? ' \u00b7 ' + it.until : '');
    }
  }
  var todayMidnight = new Date(y, now.getMonth(), d);
  // Collect ALL upcoming events, then pick the nearest
  var events = [];
  // Meteor shower peaks — [month, day, name, ZHR]
  var showers = [[1,3,'Quadrantids',120],[4,22,'Lyrids',18],[5,6,'Eta Aquariids',50],
    [8,12,'Perseids',100],[10,21,'Orionids',20],[11,17,'Leonids',15],
    [12,14,'Geminids',150],[12,22,'Ursids',10]];
  for (var i = 0; i < showers.length; i++) {
    var s = showers[i], peak = new Date(y, s[0]-1, s[1]);
    if (peak < todayMidnight) peak = new Date(y+1, s[0]-1, s[1]);
    var days = Math.round((peak - todayMidnight) / 86400000);
    events.push({ days: days, name: s[2], extra: ' \u00b7 ZHR ' + s[3], tonight: true });
  }
  // Equinoxes & solstices — use season-aware names for Southern Hemisphere
  var _tLoc = _getSessionJSON(SK.ALMANAC_LOC, null);
  var _tSouth = _tLoc && _tLoc.lat < 0;
  var eqNames = _tSouth
    ? [t('season_autumn') + ' ' + t('alm_equinox'), t('season_winter') + ' ' + t('alm_solstice'), t('season_spring') + ' ' + t('alm_equinox'), t('season_summer') + ' ' + t('alm_solstice')]
    : [t('season_spring') + ' ' + t('alm_equinox'), t('season_summer') + ' ' + t('alm_solstice'), t('season_autumn') + ' ' + t('alm_equinox'), t('season_winter') + ' ' + t('alm_solstice')];
  var eqs = [[3,20,eqNames[0]],[6,21,eqNames[1]],[9,22,eqNames[2]],[12,21,eqNames[3]]];
  for (var j = 0; j < eqs.length; j++) {
    var eq = eqs[j], eqDate = new Date(y, eq[0]-1, eq[1]);
    if (eqDate < todayMidnight) eqDate = new Date(y+1, eq[0]-1, eq[1]);
    events.push({ days: Math.round((eqDate - todayMidnight) / 86400000), name: eq[2], extra: '' });
  }
  // Notable holidays
  var holidays = [[1,1,"New Year's Day"],[2,14,"Valentine's Day"],[3,17,"St. Patrick's Day"],
    [3,8,"Int'l Women's Day"],[4,22,'Earth Day'],[5,1,'May Day'],
    [7,4,'Independence Day'],[10,31,'Halloween'],
    [12,25,'Christmas Day'],[12,31,"New Year's Eve"]];
  for (var k = 0; k < holidays.length; k++) {
    var h = holidays[k], hDate = new Date(y, h[0]-1, h[1]);
    if (hDate < todayMidnight) hDate = new Date(y+1, h[0]-1, h[1]);
    events.push({ days: Math.round((hDate - todayMidnight) / 86400000), name: h[2], extra: '' });
  }
  // Sort by nearest
  events.sort(function(a, b) { return a.days - b.days; });
  var ev = events[0];
  if (!ev) return null;
  if (ev.days === 0) return (ev.tonight ? t('teaser_peak_tonight', { name: ev.name }) : t('teaser_today', { name: ev.name })) + ev.extra;
  return t('teaser_in_days', { name: ev.name, n: ev.days }) + ev.extra;
}

function _renderTodayCard() {
  var now = new Date();
  var m = _moonPhase(now);
  var tilt = _quickMoonTilt(now);
  var stars = '';
  for (var i = 0; i < 18; i++) {
    var sx = Math.floor(Math.random() * 100);
    var sy = Math.floor(Math.random() * 100);
    var delay = (Math.random() * 3).toFixed(1);
    var size = Math.random() > 0.7 ? 3 : 2;
    stars += '<div class="dc-star" style="left:' + sx + '%;top:' + sy + '%;width:' + size + 'px;height:' + size + 'px;animation-delay:' + delay + 's"></div>';
  }
  var glowOpacity = (m.illumination / 100 * 0.12 + 0.02).toFixed(2);
  return '<div class="dc-today">' + stars +
    '<div class="dc-moon-glow" style="background:radial-gradient(circle, rgba(232,224,208,' + glowOpacity + ') 0%, transparent 65%)"></div>' +
    _renderMoonHTML(m, 'dc-moon-wrap', tilt) +
    '</div>';
}

// -- Create a ZIM (lazy-loaded from /static/create.js) --
// Same shape as the Almanac below: a full-page surface over the library, its
// module fetched only when an admin actually opens it. The module overrides
// _openCreateInner and closeCreate; what lives here is the shell.
var _createOpen = false;
var _createLoaded = false;

// ``replaceState`` true means "this history entry IS Create" (a cold load of
// /#create), false means "Create is a step forward from where we were".
function openCreate(replaceState) {
  // Modifier-click: open Create in a new browser tab, like the Almanac.
  if (_isModClick()) {
    _lastMouseEvent = null;
    window.open('/#create', '_blank');
    return;
  }
  if (_createOpen) return;
  if (_createLoaded) { _openCreateInner(replaceState); return; }
  var el = document.createElement('script');
  el.src = '/static/create.js?v=1';
  el.onload = function() { _createLoaded = true; _openCreateInner(replaceState); };
  // Offline with a cold cache: the module was never fetched. Say so rather
  // than leaving a button that appears to do nothing.
  el.onerror = function() {
    // Drop the boot gate too, or a cold load of /#create leaves the library
    // hidden behind a shell that is never going to fill in.
    document.documentElement.classList.remove('create-boot');
    _showToast(t('create_unavailable_offline'));
  };
  document.head.appendChild(el);
}

// Both overridden by create.js once it loads.
function _openCreateInner() {}

function closeCreate() {
  if (!_createOpen) return;
  _createOpen = false;
  document.getElementById('create-view').classList.remove('open');
  mainView.classList.remove('hidden');
  _setWindowTitle('Zimi');
  _dropCreateHash();
  updateTopbar();
}

// Strip #create without adding a history entry — the almanac's contract, so
// closing Create leaves the URL as the page behind it rather than a hash that
// would reopen on reload.
function _dropCreateHash() {
  if (location.hash !== '#create') return;
  try {
    history.replaceState(history.state, '', location.pathname + location.search);
  } catch (e) {}
}

// True when THIS client may create ZIMs: management is on, and the viewer is
// either an admin (holds credentials or needs none) or a signed-in user whose
// account carries the per-user create permission (/whoami can_create). The
// server enforces the answer regardless of what this returns.
function _canCreate() {
  if (!manageEnabled) return false;
  if (_userSession) return !!_userSession.canCreate;
  return !_managePwRequired && !_managePublicLocked;
}

// Whether to DRAW the + before we can prove the answer.
//
// _canCreate() needs the manage probe, which lands after /list on a cold boot —
// so on a big library the + was simply missing for as long as the library took
// to arrive, and a tap in that window hit nothing. A dead button is worse than
// an early one, so the last KNOWN answer is remembered and used until the real
// one arrives; _createRememberCanShow reconciles it every time updateTopbar
// runs with authority.
//
// The optimism is one-directional and that is the whole safety argument: the
// hint is only ever written by an authoritative check, so a browser that was
// never an admin never shows a +. The only wrong state possible is an admin
// who has since been demoted seeing the button for the length of one probe,
// and every /manage/create* route is admin-gated server-side regardless.
function _createCanShow() {
  return _manageProbed ? _canCreate() : _getStorageFlag(SK.CAN_CREATE);
}

function _createRememberCanShow() {
  if (!_manageProbed) return;  // nothing authoritative to record yet
  try {
    if (_canCreate()) localStorage.setItem(SK.CAN_CREATE, '1');
    else localStorage.removeItem(SK.CAN_CREATE);
  } catch (e) {}
}

// Whether the ⋯ menu should carry the Create-a-ZIM row right now: the home
// screen, and a client the last authoritative answer (or the remembered boot
// hint — see _createCanShow) says may create. One predicate, shared by the
// menu builder and by updateTopbar's decision to reveal the ⋯ trigger.
function _createMenuRowAvailable() {
  return mode === 'home' && !readerOpen && !_almanacOpen && !_createOpen && _createCanShow();
}

// -- Almanac mini-app (lazy-loaded from /static/almanac.js) --
var _almanacOpen = false;
var _almanacLoaded = false;

function openAlmanac(replaceState) {
  // Modifier-click: open Almanac in new browser tab
  if (_isModClick()) {
    _lastMouseEvent = null;
    window.open('/#almanac', '_blank');
    return;
  }
  if (!_almanacLoaded) {
    // The almanac is split across sibling modules (it outgrew one file). They
    // share a global scope, so load them in sequence and only open once the
    // last one lands — opening early would call into functions not yet defined.
    var almanacModules = [
      '/static/almanac-links.js?v=45',
      '/static/almanac-orrery.js?v=45',
      '/static/almanac-sky.js?v=45',
      '/static/almanac.js?v=45'
    ];
    var loadNext = function(i) {
      if (i >= almanacModules.length) {
        _almanacLoaded = true;
        _openAlmanacInner(replaceState);
        return;
      }
      var s = document.createElement('script');
      s.src = almanacModules[i];
      s.onload = function() { loadNext(i + 1); };
      // Offline with a cold cache: these modules were never fetched, so there is
      // nothing to serve. Say so — a console line and a button that appears to
      // do nothing is the same "silent absence" the connection banner exists to
      // eliminate.
      s.onerror = function() {
        console.error('Failed to load ' + almanacModules[i]);
        // Drop the reload-into-almanac boot gate so the library becomes
        // visible again instead of an empty dark shell.
        document.documentElement.classList.remove('almanac-boot');
        _showToast(t('almanac_unavailable_offline'));
      };
      document.head.appendChild(s);
    };
    loadNext(0);
    return;
  }
  _openAlmanacInner(replaceState);
}

// (Almanac rendering code lives in /static/almanac.js)
// closeAlmanac is defined there but referenced by the HTML close button,
// so we provide a stub that delegates once loaded.
function closeAlmanac() {
  // Will be overridden when almanac.js loads
  if (!_almanacOpen) return;
  _almanacOpen = false;
  document.getElementById('almanac-view').classList.remove('open');
  mainView.classList.remove('hidden');
  _setWindowTitle('Zimi');
  updateTopbar();
}

function _dismissDiscover() {
  localStorage.setItem(SK.HIDE_DISCOVER, '1');
  _discoverLoading = false;
  renderHome();  // Re-render to move stats bar to top
  // Show undo toast
  var toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:10px 16px;font-size:13px;color:var(--text2);z-index:300;box-shadow:0 4px 16px rgba(0,0,0,0.3)';
  toast.innerHTML = tH('discover_hidden') + ' <a href="#" style="color:var(--amber);text-decoration:none" onclick="event.preventDefault();localStorage.removeItem(\'zimi_hide_discover\');this.parentNode.remove();renderHome()">' + tH('undo') + '</a>';
  document.body.appendChild(toast);
  setTimeout(function() { if (toast.parentNode) toast.remove(); }, 5000);
}

// ─── Discover Card Pipeline ─────────────────────────────────────────────
// Cards come from two sources:
//   1. Computed (client-side only): Today card — moon, date, season
//   2. Server slots: Content cards from FEATURED_ZIMS — matched against
//      installed ZIM files, fetched via /random?zim=...&thumb=1
// Remaining slots filled with random picks from visual ZIMs (>100 entries).
// Results cached in localStorage per day. Card order: first content card,
// then Today, then remaining content cards.
//
// Card types (see _renderDiscover for rendering):
//   'loading'   — skeleton placeholder while fetching
//   'today'     — computed moon/date/season → opens Almanac mini-app
//   'apod'      — NASA Astronomy Picture of the Day (dated lookup)
//   'onthisday' — Wikipedia historical events for today's date
//   'country'   — CIA World Factbook country (dated)
//   'random'    — random article from a ZIM (Word, Quote, Book, Talk, Comic, or random fill)
//
// Future: Card definitions could be extracted to a plugin system where
// each card type is a separate file with its own render/fetch logic.
// See FEATURED_ZIMS for the content slot registry.
// ─────────────────────────────────────────────────────────────────────────
function _loadDiscover() {
  if (_discoverLoading) return;
  var el = document.getElementById('discover-row');
  if (_getStorageFlag(SK.HIDE_DISCOVER)) {
    if (el) el.innerHTML = '';
    return;
  }
  if (!el) return;
  var now = new Date();
  // LOCAL date, not toISOString (UTC): an evening render used to store
  // today's cards under tomorrow-UTC's key, serving yesterday's Picture
  // of the Day all the next day.
  var today = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
  var cacheKey = 'zimi_' + (window.__ZIMI_CONFIG && __ZIMI_CONFIG.discoverStamp || 'disc6') + '_' + today;
  // Clean up old Discover cache keys (from previous days or old versions)
  try {
    var staleKeys = [];
    for (var si = 0; si < localStorage.length; si++) {
      var k = localStorage.key(si);
      if (k && k.indexOf('zimi_d') === 0 && k !== cacheKey) staleKeys.push(k);
    }
    staleKeys.forEach(function(k) { localStorage.removeItem(k); });
  } catch(e) {}
  try {
    var cached = JSON.parse(localStorage.getItem(cacheKey));
    if (cached && cached.length > 1) {
      // Ensure Today card is not first if content cards exist
      if (cached[0] && cached[0].type === 'today' && cached.length > 1 && cached[1] && cached[1].type !== 'today') {
        cached = [cached[1], cached[0]].concat(cached.slice(2));
      }
      _renderDiscover(el, cached);
      return;
    }
  } catch(e) {}

  // Today card is always present (computed client-side, no server call needed)
  var computed = [{ type: 'today' }];
  var names = (zimsCache || []).map(function(z) { return z.name; });
  var mmdd = ('0' + (now.getMonth() + 1)).slice(-2) + ('0' + now.getDate()).slice(-2);

  // Named content slots from FEATURED_ZIMS — match installed ZIMs
  var serverSlots = [];
  var usedNames = {};
  for (var fi = 0; fi < FEATURED_ZIMS.length; fi++) {
    var feat = FEATURED_ZIMS[fi];
    var zimName = null;
    var zimEntries = -1;
    for (var ni = 0; ni < names.length; ni++) {
      var n = names[ni];
      if (n === feat.match || n.indexOf(feat.match) === 0) {
        // For wikipedia, prefer _en_all or exact match (skip _en_medicine etc.)
        if (feat.match === 'wikipedia' && n !== 'wikipedia' && !/^wikipedia_en_all/i.test(n)) continue;
        // For wiktionary, prefer simple (English-only — no language filtering needed)
        if (feat.match === 'wiktionary' && /simple/i.test(n)) { zimName = n; zimEntries = Infinity; continue; }
        // Prefer ZIM with most entries (richest content)
        var zInfo = _zimInfo(n);
        var ec = (zInfo && typeof zInfo.entries === 'number') ? zInfo.entries : 0;
        if (ec > zimEntries) { zimName = n; zimEntries = ec; }
      }
    }
    if (!zimName) continue;
    usedNames[zimName] = true;
    var dated = feat.type === 'apod' || feat.type === 'onthisday' || feat.type === 'country';
    serverSlots.push({name: zimName, dated: dated, type: feat.type, label: t(feat.i18nLabel), icon: feat.icon});
  }

  // Random fill: pick visual ZIMs not already used as named slots
  var TARGET = 6;
  var randomNeeded = Math.max(0, TARGET - computed.length - serverSlots.length);
  var skipCats = {'Stack Exchange':1, 'Dev Docs':1};
  var skipPattern = /^zimgit/i;
  var visualZims = (zimsCache || []).filter(function(z) {
    return typeof z.entries === 'number' && z.entries > 100
      && !skipPattern.test(z.name) && !skipCats[z.category] && !usedNames[z.name];
  });
  // Shuffle and pick
  for (var ri = visualZims.length - 1; ri > 0; ri--) {
    var rj = Math.floor(Math.random() * (ri + 1));
    var tmp = visualZims[ri]; visualZims[ri] = visualZims[rj]; visualZims[rj] = tmp;
  }
  for (var k = 0; k < randomNeeded && k < visualZims.length; k++) {
    serverSlots.push({name: visualZims[k].name, dated: false, type: 'random'});
  }

  if (serverSlots.length === 0) {
    // No ZIM content — show Today card + teaser
    _renderDiscover(el, computed);
    return;
  }

  // Show loading skeletons first, then Today card at position 2 (matching final layout)
  var loadingCount = Math.min(serverSlots.length, 3);
  var loadingItems = [];
  loadingItems.push({ type: 'loading' });  // Position 1: skeleton (will become first content card)
  for (var ci = 0; ci < computed.length; ci++) loadingItems.push(computed[ci]);  // Position 2: Today/moon
  for (var li = 1; li < loadingCount; li++) loadingItems.push({ type: 'loading' });  // Remaining skeletons
  _renderDiscover(el, loadingItems);
  _discoverLoading = true;

  // Track resolved results as they arrive so the timeout path can collect partial results
  var _discoverResults = [];
  var _discoverFetches = serverSlots.map(function(s, idx) {
    _discoverResults.push(null);
    var url = '/random?zim=' + encodeURIComponent(s.name) + '&thumb=1&require_thumb=1';
    if (s.dated) url += '&date=' + mmdd;
    url += '&seed=' + mmdd;
    return fetch(url)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d || d.error) { return null; }
        var item = { zim: s.name, path: d.path, title: d.title || _titleFromPath(d.path || ''),
                 thumbnail: d.thumbnail || null, blurb: d.blurb || null,
                 attribution: d.attribution || null, speaker: d.speaker || null, author: d.author || null, part_of_speech: d.part_of_speech || null,
                 date: d.date || null, type: s.type, label: s.label || null, icon: s.icon || null };
        _discoverResults[idx] = item; // Store immediately on resolve
        return item;
      })
      .catch(function() { return null; });
  });
  var _discoverTimeout = new Promise(function(resolve) { setTimeout(function() { resolve('timeout'); }, 15000); });
  Promise.race([Promise.all(_discoverFetches), _discoverTimeout]).then(function(results) {
    if (results === 'timeout') {
      // On timeout: use whatever resolved so far from the side-channel array
      results = _discoverResults.slice();
    }
    _discoverLoading = false;
    // Named slots (have label) show even without thumbnails; random fill requires thumbnails
    // Skip items with no title AND no path (failed dated entry lookups)
    var items = results.filter(function(r) { return r && (r.thumbnail || r.label) && (r.title || r.path); });
    // Move Today card to position 2 if there's content to show first
    var all;
    if (items.length > 0) {
      all = [items[0]].concat(computed).concat(items.slice(1));
    } else {
      all = computed.concat(items);
    }
    // Only cache if all (or nearly all) cards resolved — prevents partial results
    // from persisting all day when some ZIMs were temporarily unavailable
    if (items.length > 0 && items.length >= serverSlots.length - 1) {
      try { localStorage.setItem(cacheKey, JSON.stringify(all)); } catch(e) {}
    }
    // If we got partial results (cold start), auto-retry after 10s
    var missing = serverSlots.length - items.length;
    if (missing > 1 && !localStorage.getItem(cacheKey)) {
      setTimeout(function() { if (!localStorage.getItem(cacheKey)) renderHome(); }, 10000);
    }
    var el2 = document.getElementById('discover-row');
    if (el2) _renderDiscover(el2, all);
  });
}
function _renderDiscover(el, items) {
  var h = '<div class="discover-section"><div class="discover-label"><span>' + tH('discover') + '</span><button class="dc-dismiss" onclick="event.stopPropagation();_dismissDiscover()" title="' + escAttr(t('hide_discover')) + '">\u00D7</button></div><div class="discover-scroll">';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it) continue; // Skip null results (e.g. failed dated entry lookups)

    // ─── Card: Loading Skeleton ───────────────────────────────────────
    // Shown while fetch requests are in-flight. Replaced by real cards once data arrives.
    if (it.type === 'loading') {
      h += '<div class="discover-card dc-no-click dc-loading">' +
        '<div class="dc-thumb dc-skel"></div>' +
        '<div class="dc-body">' +
          '<div class="dc-skel-line" style="width:60%"></div>' +
          '<div class="dc-skel-line" style="width:80%"></div>' +
        '</div></div>';
      continue;
    }

    // ─── Card: Today ──────────────────────────────────────────────────
    // Moon phase + date + season. Clicking opens the Almanac mini-app (almanac.js).
    // Content is fully computed client-side — no server call needed.
    if (it.type === 'today') {
      var _m = _moonPhase(new Date());
      var _now = new Date();
      var _lang = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
      var _dateTitle = _now.toLocaleDateString(_lang, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      var _y = _now.getFullYear();
      // Season detection — flip for Southern Hemisphere if location is set
      var _nSeasons = ['winter', 'spring', 'summer', 'autumn', 'winter'];
      var _sSeasons = ['summer', 'autumn', 'winter', 'spring', 'summer']; // Southern Hemisphere
      var _storedLoc = _getSessionJSON(SK.ALMANAC_LOC, null);
      var _isSouth = _storedLoc && _storedLoc.lat < 0;
      var _seasonKeys = _isSouth ? _sSeasons : _nSeasons;
      var _sBounds = [
        { k: 0, s: new Date(_y - 1, 11, 21), e: new Date(_y, 2, 20) },
        { k: 1, s: new Date(_y, 2, 20), e: new Date(_y, 5, 21) },
        { k: 2, s: new Date(_y, 5, 21), e: new Date(_y, 8, 22) },
        { k: 3, s: new Date(_y, 8, 22), e: new Date(_y, 11, 21) },
        { k: 4, s: new Date(_y, 11, 21), e: new Date(_y + 1, 2, 20) }
      ];
      var _seasonStr = '';
      for (var _si = 0; _si < _sBounds.length; _si++) {
        if (_now >= _sBounds[_si].s && _now < _sBounds[_si].e) {
          _seasonStr = t('season_' + _seasonKeys[_sBounds[_si].k]) + ' ' + Math.round((_now - _sBounds[_si].s) / (_sBounds[_si].e - _sBounds[_si].s) * 100) + '%';
          break;
        }
      }
      var _teaser = _todayTeaser();
      h += '<a class="discover-card" href="/#almanac" onclick="return _spaNav(event, openAlmanac)">' +
        _renderTodayCard() +
        '<div class="dc-body">' +
          '<div class="dc-source"><span>' + tH('today') + '</span></div>' +
          '<div class="dc-title">' + esc(_dateTitle) + '</div>' +
          '<div class="dc-blurb">' + _localMoonName(_m.name) + (_seasonStr ? ' \u00b7 ' + _seasonStr : '') + '</div>' +
          '<div class="dc-blurb">' + _m.illumination + '% ' + tH('alm_illuminated') + '</div>' +
          (_teaser ? '<div class="dc-blurb" style="color:var(--amber)">' + _teaser + '</div>' : '') +
        '</div></a>';
      continue;
    }

    // ─── Shared: metadata extraction ──────────────────────────────────
    // Common fields used by Quote, Word, and Standard card types.

    // Date badge: only for APOD cards (extracted from path or response)
    var dateStr = null;
    if (it.type === 'apod') {
      dateStr = it.date || null;
      if (!dateStr) {
        var apMatch = (it.path || '').match(/ap(\d{2})(\d{2})(\d{2})/);
        if (apMatch) {
          var yr = parseInt(apMatch[1],10);
          dateStr = (yr >= 90 ? '19' : '20') + apMatch[1] + '-' + apMatch[2] + '-' + apMatch[3];
        }
      }
    }
    var dateHtml = dateStr ? '<span class="dc-date">' + esc(_fmtDiscoverDate(dateStr)) + '</span>' : '';

    // ZIM icon (small favicon shown in source line)
    var zimInfo = _zimInfo(it.zim);
    var iconHtml = '';
    if (zimInfo && zimInfo.has_icon) {
      // Decorative — the source label next to it conveys the same info
      iconHtml = '<img class="dc-zim-icon" src="/w/' + encodeURIComponent(it.zim) + '/-/icon" loading="lazy" alt="">';
    }

    // Source label: re-resolve from ZIM name (not cached label) so language switches work
    var sourceLabel, badgeHtml = '';
    if (it.label) {
      // Re-resolve label from FEATURED_ZIMS if possible (cached label may be in old language)
      var _feat = it.zim && FEATURED_ZIMS.find(function(f) { return it.zim.indexOf(f.match) !== -1; });
      sourceLabel = _feat ? t(_feat.i18nLabel) : it.label;
    } else if (it.type === 'random') {
      sourceLabel = _zimTitle(it.zim);
      badgeHtml = '<span class="dc-dice">\uD83C\uDFB2</span>';
    } else {
      sourceLabel = _zimTitle(it.zim);
    }

    // Display title: cleaned for each content type
    var displayTitle = it.title || it.path;
    if (it.type === 'apod' && displayTitle) {
      displayTitle = displayTitle.replace(/^APOD:\s*\d{4}\s+\w+\s+\d+\s*[\u2013\-]\s*/i, '');
    }
    if (it.type === 'onthisday' && displayTitle) {
      displayTitle = displayTitle.replace(/^Portal:Current events\/?/, '').replace(/_/g, ' ');
      if (!displayTitle) displayTitle = it.title || t('historical_event');
    }
    // On This Day: put the date context on the card ("July 27, 1777 — event")
    // so it reads honestly even if the target article never restates the date.
    // The headline stays the article title; this replaces the blurb.
    if (it.type === 'onthisday' && it.event_text) {
      var _otdLang = (typeof _currentLang !== 'undefined') ? _currentLang : 'en';
      var _otdDate = new Date().toLocaleDateString(_otdLang, { month: 'long', day: 'numeric' });
      it.blurb = _otdDate + (it.event_year ? ', ' + it.event_year : '') + ' — ' + it.event_text;
    }

    // Detect quote content (for special card template)
    var isQuote = it.blurb && (it.blurb.charAt(0) === '\u201c' || it.blurb.charAt(0) === '"');
    if (!isQuote && /wikiquote/i.test(it.zim || '') && (it.blurb || it.title)) isQuote = true;
    var blurbHtml = it.blurb ? '<div class="dc-blurb' + (isQuote ? ' dc-quote' : '') + '">' + esc(it.blurb) + '</div>' : '';

    // ─── Card: Quote ────────────────────────────────────────────────
    // Full-width card with decorative quote mark, serif text, and attribution.
    // Used for Wikiquote and any content that starts with a quote character.
    if (isQuote) {
      var attrName = it.attribution || it.speaker || (/^[A-Z][a-z]+ [A-Z]/.test(displayTitle) ? displayTitle : '');
      var cleanQuote = it.blurb ? it.blurb.replace(/^[\u201c\u201d"]+\s*/, '').replace(/[\u201d"]+\s*$/, '') : displayTitle;
      var attrLine = (attrName && attrName !== cleanQuote)
        ? '<div class="dc-attribution">\u2014 ' + esc(attrName) + '</div>'
        : '';
      h += '<a class="discover-card dc-quote-card" href="' + escAttr(_articleDeepLinkPath(it.zim, it.path)) + '" data-zim="' + escAttr(it.zim) + '" data-path="' + escAttr(it.path) + '" data-title="' + escAttr(it.title || '') + '" onclick="return _spaCardClick(event, this)">' +
        '<div class="dc-body">' +
          '<div class="dc-header">' + iconHtml + '<span>' + esc(sourceLabel || t('quote_of_day')) + '</span></div>' +
          '<div class="dc-quote-mark">\u201C</div>' +
          '<div class="dc-blurb dc-quote">' + esc(cleanQuote) + '</div>' +
          attrLine +
        '</div></a>';

    // ─── Card: Word of the Day ──────────────────────────────────────
    // Full-width card with headword, part of speech, and definition.
    // Used for Wiktionary content.
    } else if (/wiktionary/i.test(it.zim || '')) {
      h += '<a class="discover-card dc-quote-card dc-word-card" href="' + escAttr(_articleDeepLinkPath(it.zim, it.path)) + '" data-zim="' + escAttr(it.zim) + '" data-path="' + escAttr(it.path) + '" data-title="' + escAttr(it.title || '') + '" onclick="return _spaCardClick(event, this)">' +
        '<div class="dc-body">' +
          '<div class="dc-header">' + iconHtml + '<span>' + esc(sourceLabel) + '</span></div>' +
          '<div class="dc-headword">' + esc(displayTitle) + '</div>' +
          (it.part_of_speech ? '<div class="dc-pos">' + esc(it.part_of_speech) + '</div>' : '') +
          (it.blurb ? '<div class="dc-def">' + esc(it.blurb) + '</div>' : '') +
        '</div></a>';

    // ─── Card: Standard ─────────────────────────────────────────────
    // Thumbnail + source + title + blurb. Used for APOD, On This Day,
    // Country of the Day, TED Talks, Books, Comics, and random picks.
    } else {
      // Thumbnail — filter out generic site chrome images
      var thumbHtml;
      var hasGoodThumb = it.thumbnail && !/home_on\.png|banner_ext|photo_on\.gif/i.test(it.thumbnail);
      if (hasGoodThumb) {
        var thumbClass = 'dc-thumb' + (/gutenberg/i.test(it.zim || '') ? ' dc-book-cover' : '');
        thumbHtml = '<img class="' + thumbClass + '" src="' + escAttr(it.thumbnail) + '" loading="lazy" alt="" onerror="this.style.display=\'none\'" onload="if(this.naturalWidth<80||this.naturalHeight<60)this.style.display=\'none\'">';
      } else if (it.type === 'country') {
        thumbHtml = '<div class="dc-icon-thumb" style="background:linear-gradient(135deg,#0a1628,#162040)"><span style="font-size:40px;line-height:1">&#x1F30D;</span></div>';
      } else {
        thumbHtml = '<div class="dc-icon-thumb">' + iconHtml + '</div>';
      }
      // Speaker/author line (TED talks, books)
      var speakerHtml = '';
      if (it.speaker && it.speaker !== displayTitle) {
        speakerHtml = '<div class="dc-speaker">' + esc(it.speaker) + '</div>';
      } else if (it.author) {
        speakerHtml = '<div class="dc-speaker">' + esc(it.author) + '</div>';
      }
      // Skip blurb if it essentially duplicates the title
      var showBlurb = blurbHtml;
      if (it.blurb && displayTitle) {
        var blurbNorm = it.blurb.replace(/[^\w\s]/g, '').toLowerCase().trim();
        var titleNorm = displayTitle.replace(/[^\w\s]/g, '').toLowerCase().trim();
        if (blurbNorm === titleNorm || titleNorm.indexOf(blurbNorm) >= 0 || blurbNorm.indexOf(titleNorm) >= 0) {
          showBlurb = '';
        }
      }
      // Video ZIMs: overlay a play badge on the thumbnail and mark the card so
      // it reads as "play a random video" for AT users, not "open article".
      var _isVid = _isVideoZim(it.zim);
      var playBadge = _isVid ? '<span class="dc-play-badge" aria-hidden="true"></span>' : '';
      var vidAttrs = _isVid ? ' data-video="1" aria-label="' + escAttr(t('play_video') + ': ' + displayTitle) + '"' : '';
      h += '<a class="discover-card' + (_isVid ? ' dc-video-card' : '') + '" href="' + escAttr(_articleDeepLinkPath(it.zim, it.path)) + '" data-zim="' + escAttr(it.zim) + '" data-path="' + escAttr(it.path) + '" data-title="' + escAttr(it.title || '') + '"' + vidAttrs + ' onclick="return _spaCardClick(event, this)">' +
        thumbHtml + playBadge +
        '<div class="dc-body">' +
          '<div class="dc-source">' + iconHtml + '<span>' + esc(sourceLabel) + '</span>' + badgeHtml + dateHtml + '</div>' +
          '<div class="dc-title">' + esc(displayTitle) + '</div>' +
          speakerHtml +
          showBlurb +
        '</div></a>';
    }
  }
  h += '</div></div>';
  el.innerHTML = h;
  el.dataset.lang = _currentLang; // Track language for cache invalidation on lang switch
  // Restore saved scroll position (e.g., after navigating back from an article)
  try {
    var savedScroll = sessionStorage.getItem('zimi_disc_scroll');
    if (savedScroll) {
      var scrollEl = el.querySelector('.discover-scroll');
      if (scrollEl) scrollEl.scrollLeft = parseInt(savedScroll, 10);
      sessionStorage.removeItem('zimi_disc_scroll');
    }
  } catch(e) {}
}
function _fmtDiscoverDate(dateStr) {
  try {
    var d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString(_currentLang || 'en', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch(e) {
    return dateStr;
  }
}

async function toggleFavorite(zimName) {
  try {
    const res = await fetch('/favorites', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ..._authHeaders()},
      body: JSON.stringify({zim: zimName})
    });
    const data = await res.json();
    if (data.favorites) {
      if (!collectionsCache) collectionsCache = {version: 1, favorites: [], collections: {}};
      collectionsCache.favorites = data.favorites;
    }
    // Re-render current view to update stars
    if (mode === 'home') renderHome();
    else if (mode === 'search') renderSearchResults(allResults, currentSource);
  } catch(e) {}
}

function toggleCategory(cat) {
  if (activeCategories.has(cat)) activeCategories.delete(cat);
  else activeCategories.add(cat);
  renderHome();
}

// ── Category overrides + section order (#37) ──
//
// Default "Move to…" targets: the _categorize_zim heuristic's English category
// names (minus the Other catch-all). These are the values stored as overrides —
// server-side grouping keys off the same names — so the round-trip stays exact.
const _DEFAULT_MOVE_CATEGORIES = ['Wikimedia', 'Stack Exchange', 'Dev Docs', 'Education', 'Medical', 'How-To', 'Books'];

// Canonical key for de-duplicating category targets. Two categories collide when
// they render to the SAME row for the user — which is the localized display name,
// case-insensitive. Keying dedup off the raw value is wrong: the default 'Wikimedia'
// and an in-use 'Encyclopedias' are different strings but display identically (both
// "Encyclopedias"), so raw-value dedup let both through — the duplicate-rows bug.
function _catCanonKey(c) { return (c ? _catDisplayName(c) : '').trim().toLowerCase(); }

// Move targets = defaults ∪ in-use categories ∪ user-declared empty sections,
// so a custom category the user already created (with or without ZIMs) is a
// reuse target rather than something to re-type. Defaults come first (canonical
// English keys the server stores); the Other catch-all is always offered last.
function _moveTargetCategories() {
  var seen = new Set();
  var out = [];
  function add(c) {
    if (!c || c === OTHER_CAT) return;  // Other is appended explicitly, last
    var canon = _catCanonKey(c);
    if (!canon || seen.has(canon)) return;
    seen.add(canon); out.push(c);
  }
  _DEFAULT_MOVE_CATEGORIES.forEach(add);
  (zimsCache || []).forEach(function(z) { add(z.category); });
  (_declaredSections || []).forEach(add);
  out.push(OTHER_CAT);
  return out;
}

// Submenu markup shared by the card right-click menu and the manage-row gear —
// ONE implementation, two triggers. Data-attributes only (no inline onclick):
// category names are user free-text, and the delegated menu handler reads them
// off dataset, sidestepping the escJs-in-onclick trap.
function _moveSubmenuHtml(zim) {
  // _zimCat resolves the effective bucket (incl. the Other catch-all) so the ✓
  // lands on Other for an uncategorized ZIM, not just an explicitly-moved one.
  var curCanon = _catCanonKey(_zimCat(_zimInfo(zim))); // mark by display, not raw value
  var h = '';
  _moveTargetCategories().forEach(function(c) {
    var isCur = curCanon && _catCanonKey(c) === curCanon;
    h += '<div class="ctx-item" data-action="move-to" data-cat="' + escAttr(c) + '">' +
      (isCur ? '✓ ' : '') + esc(_catDisplayName(c)) + '</div>';
  });
  h += '<div class="ctx-sep"></div>';
  h += '<div class="ctx-item" data-action="move-new">' + tH('move_new_category') + '</div>';
  return h;
}

// POST a layout patch ({overrides} and/or {section_order}) to the auth-gated
// endpoint. Always a /manage write, so it rides manageFetch's token.
function _saveLibraryLayout(patch) {
  return manageFetch('/manage/library-layout', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(patch)
  });
}

// Re-render whichever ZIM list is actually on screen after a Move to… action.
// Move to… fires from three places sharing this one handler: the home-page card
// menu, the Installed tab, and the Catalog tab. renderHome() and renderManage()
// both paint into the SAME #output element — calling renderHome() unconditionally
// while the Manage overlay is open replaced its whole DOM with the home grid,
// which read to the user as being "sent to the home screen" for a settings
// action. Route to the pane that's actually active instead.
function _refreshZimListView() {
  if (mode === 'manage') {
    if (manageTab === 'installed') renderInstalled();
    else if (manageTab === 'browse') {
      if (_browseView === 'drilldown' && manageCategoryFilter) drillCategory(manageCategoryFilter);
      else renderBrowseGallery();
    }
  } else {
    renderHome();
  }
}

// Assign a ZIM to a category: optimistic local update + re-render in place, then
// persist. Reverts and toasts on failure (e.g. 403 public-locked); toasts the
// existing generic "Saved" confirmation on success.
function _moveZimTo(zim, category) {
  var zinfo = _zimInfo(zim);
  var prev = zinfo ? zinfo.category : null;
  if (zinfo) zinfo.category = category;
  _refreshZimListView();
  var ov = {}; ov[zim] = category;
  _saveLibraryLayout({ overrides: ov }).then(function(res) {
    if (!res.ok) {
      if (zinfo) zinfo.category = prev;
      _refreshZimListView();
      _showToast(res.status === 403 ? t('layout_locked') : t('error'));
    } else {
      _showToast(t('saved'));
    }
  }).catch(function() {
    if (zinfo) zinfo.category = prev; _refreshZimListView(); _showToast(t('error'));
  });
}

// ── Context menu for homepage ZIM cards ──
(function() {
  const menu = document.getElementById('zim-ctx-menu');
  if (!menu) return;
  let _ctxZim = null;
  let _ctxCard = null;
  let _ctxX = 0, _ctxY = 0;
  let _ctxCompact = false;  // gear trigger shows just the layout actions
  let _kbSub = null;        // the submenu trigger currently opened by keyboard
  // When set, this menu was raised by a non-ZIM caller (e.g. the Users pane).
  // The click handler routes data-action taps to this callback instead of the
  // built-in ZIM actions, so the whole positioning / keyboard-nav / dismiss
  // machinery is reused verbatim rather than duplicated per menu.
  let _ctxCustomAction = null;

  function closeCtx() { menu.classList.remove('visible'); _ctxZim = null; _ctxCard = null; _kbSub = null; _ctxCustomAction = null; }

  // ── Keyboard navigation (ARIA menu pattern) ──
  // The menu + its Move to…/Collections submenus are reachable by keyboard:
  // Up/Down cycle, Home/End jump, Enter/Space activate (or open a submenu),
  // Right/Enter open a submenu, Left/Escape back out, Escape closes. Shared by
  // the card right-click menu and the ⋯ gear menu (same #zim-ctx-menu element).
  function _ctxItems(container) {
    return Array.prototype.slice.call(container.querySelectorAll(':scope > .ctx-item'));
  }
  function _ctxSubOf(item) { return item ? item.querySelector(':scope > .ctx-sub') : null; }
  // The items the arrow keys currently move through: an open submenu's items,
  // else the top-level items.
  function _ctxCurrentList() {
    if (_kbSub) { var sub = _ctxSubOf(_kbSub); if (sub) return _ctxItems(sub); }
    return _ctxItems(menu);
  }
  function _ctxFocus(item) { if (item) item.focus({ preventScroll: true }); }
  function _ctxOpenSub(trigger) {
    var sub = _ctxSubOf(trigger);
    if (!sub) return false;
    trigger.classList.add('kb-open');
    trigger.setAttribute('aria-expanded', 'true');
    _kbSub = trigger;
    var items = _ctxItems(sub);
    if (items.length) _ctxFocus(items[0]);
    return true;
  }
  function _ctxCloseSub() {
    if (!_kbSub) return;
    var trigger = _kbSub;
    trigger.classList.remove('kb-open');
    trigger.setAttribute('aria-expanded', 'false');
    _kbSub = null;
    _ctxFocus(trigger);
  }
  // Stamp roles/tabindex and focus the first item — run on every open.
  function _prepMenuA11y() {
    menu.setAttribute('role', 'menu');
    _kbSub = null;
    _ctxItems(menu).forEach(function(it) {
      it.setAttribute('role', 'menuitem');
      it.setAttribute('tabindex', '-1');
      var sub = _ctxSubOf(it);
      if (sub) {
        it.setAttribute('aria-haspopup', 'true');
        it.setAttribute('aria-expanded', 'false');
        _ctxItems(sub).forEach(function(si) { si.setAttribute('role', 'menuitem'); si.setAttribute('tabindex', '-1'); });
      }
    });
    var first = _ctxItems(menu)[0];
    if (first) setTimeout(function() { _ctxFocus(first); }, 0);
  }
  menu.addEventListener('keydown', function(e) {
    if (!menu.classList.contains('visible')) return;
    var list = _ctxCurrentList();
    var idx = list.indexOf(document.activeElement);
    var cur = idx >= 0 ? list[idx] : null;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (list.length) _ctxFocus(list[idx < 0 ? 0 : (idx + 1) % list.length]);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (list.length) _ctxFocus(list[idx < 0 ? list.length - 1 : (idx - 1 + list.length) % list.length]);
        break;
      case 'Home':
        e.preventDefault(); if (list.length) _ctxFocus(list[0]); break;
      case 'End':
        e.preventDefault(); if (list.length) _ctxFocus(list[list.length - 1]); break;
      case 'ArrowRight':
        if (cur && _ctxSubOf(cur)) { e.preventDefault(); _ctxOpenSub(cur); }
        break;
      case 'ArrowLeft':
        if (_kbSub) { e.preventDefault(); _ctxCloseSub(); }
        break;
      case 'Enter':
      case ' ':
        if (!cur) return;
        e.preventDefault();
        if (_ctxSubOf(cur)) _ctxOpenSub(cur); else cur.click();
        break;
      case 'Escape':
        e.preventDefault(); e.stopPropagation();
        if (_kbSub) _ctxCloseSub(); else closeCtx();
        break;
    }
  });

  var CTX_EDGE = 8;     // keep-clear margin from every viewport edge
  var CTX_SUB_TOP = 4;  // a submenu overhangs its trigger's top edge by this much
  var CTX_SUB_GAP = 4;  // clearance a pinned submenu keeps from its trigger row
  // Where a submenu of size sw×sh goes, given its trigger's viewport rect `r`.
  // Horizontally it prefers to open right, else flips left, else PINS to the
  // viewport: the parent menu is itself clamped on screen, so on a phone its
  // right edge sits ~8px from the edge and neither side has room — the old
  // "no room right, not enough room left, open right anyway" path is what put
  // the category list off screen with every label truncated.
  // Vertically it hangs from the trigger's top edge, pulled up and capped so a
  // long category list scrolls inside itself rather than running off the bottom.
  // Pure function of numbers so the contract is unit-testable.
  function _ctxSubPlacement(r, sw, sh, vw, vh) {
    var w = Math.min(sw, vw - 2 * CTX_EDGE), h = Math.min(sh, vh - 2 * CTX_EDGE);
    var x, y, pinned = false;
    if (r.right + w <= vw - CTX_EDGE) x = r.right;
    else if (r.left - w >= CTX_EDGE) x = r.left - w;
    else { pinned = true; x = Math.min(Math.max(CTX_EDGE, r.left), vw - w - CTX_EDGE); }
    if (!pinned) {
      y = Math.max(CTX_EDGE, Math.min(r.top - CTX_SUB_TOP, vh - h - CTX_EDGE));
    } else {
      // Pinned means the submenu lands on top of its own parent menu, so it has
      // to clear the TRIGGER ROW: the finger that opened it is still on that
      // row, and the click that tap becomes would otherwise activate whichever
      // category ended up underneath — one tap silently moving a ZIM. Drop it
      // below the trigger, else above, else take the taller side and scroll.
      var below = vh - r.bottom - CTX_EDGE - CTX_SUB_GAP;
      var above = r.top - CTX_EDGE - CTX_SUB_GAP;
      if (h <= below || below >= above) { h = Math.min(h, below); y = r.bottom + CTX_SUB_GAP; }
      else { h = Math.min(h, above); y = r.top - CTX_SUB_GAP - h; }
    }
    return { x: x, y: y, w: w, h: h, pinned: pinned };
  }
  function posMenu(x, y) {
    // Measure off-paint: reveal for layout but keep it invisible until it sits at
    // its final spot, so it never flashes at (0,0) before we know its size — the
    // "flaky open"/edge-flash the two-step position used to show for a frame.
    menu.style.maxHeight = ''; menu.style.overflowY = '';  // clear any prior clamp
    menu.style.visibility = 'hidden';
    menu.style.left = '0'; menu.style.top = '0';
    menu.classList.add('visible');
    var vw = window.innerWidth, vh = window.innerHeight;
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    // A menu taller than the viewport must scroll inside itself, not run off the
    // bottom: cap its height and let it scroll before the on-screen clamp runs.
    var maxH = vh - 16;
    if (mh > maxH) { menu.style.maxHeight = maxH + 'px'; menu.style.overflowY = 'auto'; mh = maxH; }
    // Clamp the menu fully on-screen on both axes — a long-press near the
    // bottom or left edge of a phone must never park the menu off-viewport.
    // Math.max(8,…) guards the near edge; the outer Math.max keeps the near
    // edge winning when the menu is taller/wider than the viewport itself.
    var finalX = Math.min(Math.max(8, x), Math.max(8, vw - mw - 8));
    var finalY = Math.min(Math.max(8, y), Math.max(8, vh - mh - 8));
    menu.style.left = finalX + 'px';
    menu.style.top = finalY + 'px';
    // Place every submenu (Move to…'s categories, Collections, the Users role
    // list) while the menu is still hidden, so the whole assembly appears in one
    // paint. Each one is MEASURED rather than assumed: the width a submenu
    // actually wants decides which side it can open on, and it is measured twice
    // — once for its natural width, then again for the height that width implies
    // once long labels wrap. Assuming a fixed width is what made the old
    // flip-left test answer "there's room" when there wasn't.
    _ctxItems(menu).forEach(function(item) {
      var sub = _ctxSubOf(item);
      if (!sub) return;
      var r = item.getBoundingClientRect();
      sub.classList.remove('fitted');
      sub.style.cssText = 'visibility:hidden;display:block;width:auto;max-width:none;max-height:none';
      var natW = sub.offsetWidth;
      var w = Math.min(natW, vw - 2 * CTX_EDGE);
      sub.style.width = w + 'px';
      // Narrower than it wants: labels wrap onto a second line instead of being
      // cut off, and the height below accounts for the taller result.
      if (w < natW) sub.classList.add('fitted');
      var p = _ctxSubPlacement(r, w, sub.offsetHeight, vw, vh);
      // Offsets are relative to the trigger (its padding box is the submenu's
      // containing block); the values above are viewport coordinates.
      sub.style.cssText = 'left:' + (p.x - r.left) + 'px;top:' + (p.y - r.top) + 'px;' +
        'width:' + p.w + 'px;max-height:' + p.h + 'px';
    });
    menu.style.visibility = '';  // reveal at the final position: a single paint
    _prepMenuA11y();
  }

  // Layout action (Move to…) — appended to the full menu and the sole content
  // of the compact gear menu. Gated on manage (auth-gated write). Reordering is
  // NOT a per-row action; it lives as a link in the library header (its own view).
  function _layoutItemsHtml(zim) {
    if (!manageEnabled) return '';
    return '<div class="ctx-item">' + tH('move_to') + ' ›<div class="ctx-sub">' + _moveSubmenuHtml(zim) + '</div></div>';
  }

  function showMainMenu() {
    var zim = _ctxZim;
    // About belongs on EVERY library card, so both menu shapes carry it — the
    // compact gear menu (an Installed row) as much as the full card menu.
    var aboutItem = '<div class="ctx-item" data-action="about">' + tH('about_zim') + '</div>';
    // Download the raw .zim — the plainest way to carry a made-here ZIM to
    // another machine. Admin-gated like delete: /dl/ answers the admin
    // regardless of the sharing switches.
    var dlItem = manageEnabled
      ? '<div class="ctx-item" data-action="download-zim">' + tH('ctx_download_zim') + '</div>'
      : '';
    if (_ctxCompact) {
      var layout = _layoutItemsHtml(zim);
      menu.innerHTML = aboutItem + dlItem + (layout ? '<div class="ctx-sep"></div>' + layout : '');
      posMenu(_ctxX, _ctxY);
      return;
    }
    var favs = (collectionsCache && collectionsCache.favorites) || [];
    var isFav = favs.includes(zim);
    var colls = (collectionsCache && collectionsCache.collections) || {};
    var h = '<div class="ctx-item" data-action="open">' + tH('open') + '</div>';
    if (!IS_DESKTOP) h += '<div class="ctx-item" data-action="newtab">' + tH('open_new_tab') + '</div>';
    h += '<div class="ctx-sep"></div>';
    h += '<div class="ctx-item" data-action="favorite">' + (isFav ? tH('remove_from_favorites') : tH('add_to_favorites')) + '</div>';
    // Collections submenu (hover to expand)
    h += '<div class="ctx-item">' + tH('collections_tab') + ' \u203A<div class="ctx-sub">';
    for (var cName in colls) {
      var coll = colls[cName];
      var inColl = (coll.zims || []).indexOf(zim) >= 0;
      h += '<div class="ctx-item" data-action="toggle-coll" data-coll="' + escAttr(cName) + '">' +
        (inColl ? '\u2713 ' : '') + esc(coll.label || cName) + '</div>';
    }
    if (Object.keys(colls).length > 0) h += '<div class="ctx-sep"></div>';
    h += '<div class="ctx-item" data-action="new-collection">' + tH('new_collection') + '</div>';
    h += '</div></div>';
    var layoutItems = _layoutItemsHtml(zim);
    if (layoutItems) { h += '<div class="ctx-sep"></div>' + layoutItems; }
    h += '<div class="ctx-sep"></div>' + aboutItem + dlItem;
    if (manageEnabled) {
      h += '<div class="ctx-sep"></div>';
      h += '<div class="ctx-item danger" data-action="delete">' + tH('delete') + '</div>';
    }
    menu.innerHTML = h;
    posMenu(_ctxX, _ctxY);
  }

  // Exposed so the manage-row gear can raise the same menu (compact variant).
  window._openZimMenu = function(zim, x, y, compact) {
    _ctxZim = zim; _ctxCard = null; _ctxCompact = !!compact;
    _ctxCustomAction = null;
    _ctxX = x; _ctxY = y;
    showMainMenu();
  };

  // Generic opener: render arbitrary .ctx-item markup at (x,y) and route every
  // data-action tap/Enter to `onAction(action, itemEl)`. Returning false from
  // the callback keeps the menu open; anything else closes it. Reuses posMenu,
  // the ARIA keyboard nav and outside-dismiss that the ZIM menu already has.
  window._openMenuAt = function(html, x, y, onAction) {
    _ctxZim = null; _ctxCard = null; _ctxCompact = false;
    _ctxCustomAction = onAction || null;
    _ctxX = x; _ctxY = y;
    menu.innerHTML = html;
    posMenu(x, y);
  };

  // Right-click resolves its ZIM through _lpHit, the same way long-press does.
  // It used to read the name out of the card's `onclick` attribute, which only
  // the export variant still has: since cards became real links (#49) an
  // ordinary ZIM has an href and no onclick, so right-click silently did
  // nothing on almost every card in the library while touch kept working. One
  // resolver, both input types, and neither can rot without the other.
  document.addEventListener('contextmenu', function(e) {
    var hit = _lpHit(e.target);
    if (!hit) { closeCtx(); return; }
    e.preventDefault();
    // Prevent text selection
    window.getSelection().removeAllRanges();
    _ctxZim = hit.zim;
    _ctxCard = hit.card;
    _ctxCompact = false;
    _ctxCustomAction = null;
    _ctxX = e.clientX + 2;
    _ctxY = e.clientY + 2;
    showMainMenu();
  });

  // Prevent text selection on stat-cards during mousedown
  document.addEventListener('mousedown', function(e) {
    if (e.button === 2 && e.target.closest('.stat-card')) {
      e.preventDefault();
    }
  });

  // ── Long-press = right-click on touch (#37) ──
  // Touch has no contextmenu, so a 500ms press on a ZIM card (home .stat-card or
  // an Installed row) opens the same menu right-click does — the mobile answer to
  // "where's Move to…". iOS's own callout is killed by -webkit-touch-callout:none
  // on the cards (app.css).
  //
  // One lifecycle, one latch (`_lpFired` = "this gesture opened the menu"):
  //   arm     touchstart on a card → reset the latch, add lp-armed, start 500ms timer
  //   fire    timer elapses undisturbed → latch=true, haptic, open menu at the press
  //   cancel  a >10px move (a scroll) or multi-touch clears the armed timer
  //   suppress touchend after a fire eats the ONE trailing synthetic click on the
  //           pressed card (so the press doesn't also open the ZIM)
  //   dismiss tap-away / scroll / Esc / action-selected — the shared menu machinery
  //
  // The latch MUST describe only the gesture that is ending. It is reset at the top
  // of every touchstart so a fire never leaks into the next tap: a stale true there
  // made touchend swallow the tap-away's dismiss click, leaving the menu closeable
  // only by scrolling — the exact inversion field-testing hit.
  var _lpTimer = null, _lpCard = null, _lpStartX = 0, _lpStartY = 0, _lpFired = false;
  function _lpHit(target) {
    var card = target.closest && target.closest('.stat-card, .catalog-item[data-zim]');
    if (!card) return null;
    var zim = card.dataset && card.dataset.zim;
    if (!zim) {
      var m = (card.getAttribute('onclick') || '').match(/enterSource\('([^']+)'/);
      zim = m && m[1];
    }
    return zim ? { card: card, zim: zim } : null;
  }
  // While a press is armed (or has fired), the card must not start a text
  // selection under the finger. A root class flips user-select off on the cards
  // (app.css), and the selectstart guard below blocks the range outright.
  function _lpCancel() {
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
    document.documentElement.classList.remove('lp-armed');
  }
  document.addEventListener('selectstart', function(e) {
    if (_lpTimer || _lpFired) e.preventDefault();
  });
  document.addEventListener('touchstart', function(e) {
    _lpFired = false;  // gesture start: never inherit a prior press's fired latch
    if (e.touches.length !== 1) { _lpCancel(); return; }
    var hit = _lpHit(e.target);
    if (!hit) return;
    var t = e.touches[0];
    _lpStartX = t.clientX; _lpStartY = t.clientY;
    document.documentElement.classList.add('lp-armed');
    _lpTimer = setTimeout(function() {
      _lpTimer = null; _lpFired = true; _lpCard = hit.card;
      if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
      if (window.getSelection) { try { window.getSelection().removeAllRanges(); } catch (_) {} }
      _ctxZim = hit.zim; _ctxCard = hit.card; _ctxCompact = false; _ctxCustomAction = null;
      _ctxX = _lpStartX + 2; _ctxY = _lpStartY + 2;
      showMainMenu();
    }, 500);
  }, { passive: true });
  document.addEventListener('touchmove', function(e) {
    if (!_lpTimer) return;
    var t = e.touches[0];
    if (t && (Math.abs(t.clientX - _lpStartX) > 10 || Math.abs(t.clientY - _lpStartY) > 10)) _lpCancel();
  }, { passive: true });
  // Suppress the ONE synthetic open-click a fire leaves behind, two ways for two
  // engines — both now safe because the latch can't outlive its gesture (reset at
  // the next touchstart). iOS: preventDefault on touchend cancels the simulated
  // click outright. Android: touchend can't, so the capture-phase guard below eats
  // it — but only when it lands on the pressed card, so a tap-away is never caught
  // and always reaches the outside-dismiss handler.
  document.addEventListener('touchend', function(e) {
    _lpCancel();
    if (_lpFired) e.preventDefault();
  });
  document.addEventListener('touchcancel', _lpCancel, { passive: true });
  document.addEventListener('click', function(e) {
    if (_lpFired && _lpCard && _lpCard.contains(e.target)) {
      e.preventDefault(); e.stopPropagation(); _lpFired = false;
    }
  }, true);

  // Dismiss on scroll like a native menu: the fixed-position menu would
  // otherwise float detached over scrolled-away content. Capture so a scroll in
  // any nested scroller (the manage list, the home grid) closes it too.
  //
  // …but only for a scroll the USER started. A tap that lands on the menu makes
  // a scroll-snap container underneath it (the discover strip) re-snap and emit
  // a scroll event with its offsets unchanged — dismissing on that closed the
  // whole menu the instant a finger touched "Move to…", which is what made the
  // submenu look unreachable on a phone. A pointer that went down inside the
  // menu cannot be dragging the page, so any scroll it produces is the menu's
  // own doing; a wheel outside the menu is a real scroll and re-arms dismissal.
  var _ctxSelfScroll = false;
  function _ctxTrackPointer(e) { _ctxSelfScroll = menu.contains(e.target); }
  document.addEventListener('touchstart', _ctxTrackPointer, { capture: true, passive: true });
  document.addEventListener('mousedown', _ctxTrackPointer, true);
  document.addEventListener('wheel', function(e) { if (!menu.contains(e.target)) _ctxSelfScroll = false; },
    { capture: true, passive: true });
  window.addEventListener('scroll', function() {
    if (_ctxSelfScroll) return;
    if (menu.classList.contains('visible')) closeCtx();
  }, true);

  menu.addEventListener('click', function(e) {
    var item = e.target.closest('[data-action]');
    if (!item) return;
    var action = item.dataset.action;
    var zim = _ctxZim;
    var card = _ctxCard;
    e.stopPropagation();

    // Custom (non-ZIM) menu: delegate to the caller's handler.
    if (_ctxCustomAction) {
      var keepOpen = _ctxCustomAction(action, item) === false;
      if (!keepOpen) closeCtx();
      return;
    }

    if (action === 'open') {
      closeCtx(); enterSource(zim, true);
    } else if (action === 'about') {
      closeCtx(); _openZimAbout(zim);
    } else if (action === 'newtab') {
      closeCtx(); window.open('/w/' + encodeURIComponent(zim), '_blank');
    } else if (action === 'move-to') {
      var cat = item.dataset.cat;
      closeCtx();
      _moveZimTo(zim, cat);
    } else if (action === 'move-new') {
      closeCtx();
      var nc = prompt(t('move_new_category_prompt'));
      if (!nc || !nc.trim()) return;
      _moveZimTo(zim, nc.trim());
    } else if (action === 'favorite') {
      closeCtx(); toggleFavorite(zim);
    } else if (action === 'toggle-coll') {
      var collName = item.dataset.coll;
      closeCtx();
      var data = collectionsCache || {favorites: [], collections: {}};
      var coll = data.collections && data.collections[collName];
      if (!coll) return;
      var zims = coll.zims ? coll.zims.slice() : [];
      var idx = zims.indexOf(zim);
      if (idx >= 0) zims.splice(idx, 1); else zims.push(zim);
      manageFetch('/collections', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: collName, label: coll.label || collName, zims: zims})
      }).then(function(res) { if (res.ok) { coll.zims = zims; renderHome(); } });
    } else if (action === 'new-collection') {
      closeCtx();
      var name = prompt(t('collection_placeholder'));
      if (!name || !name.trim()) return;
      var slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
      manageFetch('/collections', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: slug, label: name.trim(), zims: [zim]})
      }).then(function(res) { return res.json(); }).then(function() {
        fetch('/collections').then(function(r) { return r.json(); }).then(function(c) {
          collectionsCache = c; renderHome();
        });
      });
    } else if (action === 'download-zim') {
      closeCtx();
      var zdl = _zimInfo(zim);
      var dlFile = (zdl && zdl.file) || zim;
      // A navigation carries no auth headers, so authorization travels as a
      // one-time two-minute ticket minted here (POST /manage/dl-ticket) and
      // spent by the URL — without it a passworded instance answered the
      // navigation with an HTML refusal Safari saved as name.zim.html.
      manageFetch('/manage/dl-ticket', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({file: dlFile})
      }).then(function(r) { return r.json(); }).then(function(d) {
        location.href = '/dl/' + encodeURIComponent(dlFile) +
          (d && d.ticket ? '?t=' + encodeURIComponent(d.ticket) : '');
      }).catch(function() {
        location.href = '/dl/' + encodeURIComponent(dlFile);
      });
    } else if (action === 'delete') {
      closeCtx();
      var zinfo = _zimInfo(zim);
      if (!zinfo || !zinfo.file) return;
      _appConfirm(t('delete_zim_confirm', {name: zinfo.title || zim}), t('delete')).then(function(sure) {
      if (!sure) return;
      // Optimistic: remove card immediately
      if (card) card.style.display = 'none';
      zimsCache = zimsCache.filter(function(z) { return z.name !== zim; });
      _rebuildZimsMap();
      manageFetch('/manage/delete', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({filename: zinfo.file})
      }).then(function() {
        renderHome();
      });
      });
    }
  });

  document.addEventListener('click', function(e) { if (!menu.contains(e.target)) closeCtx(); });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeCtx(); });
})();

// Markup for a "Download this ZIM" link (peer-share /dl/ endpoint, direct HTTP
// range). Shared by the source header and every download slot so the pill is
// defined once. `cls` lets each context match its neighbours' styling. The
// stopPropagation keeps the click off the card/row the pill sits inside —
// /dl/ answers Content-Disposition: attachment, so the anchor's own default
// saves the file without navigating.
function _dlPillHtml(file, cls) {
  return '<a class="' + (cls || 'pill dl-pill') + '" href="/dl/' + encodeURIComponent(file) +
    '" download="' + escAttr(file) + '" onclick="event.stopPropagation()">⬇ ' + tH('download_zim') + '</a>';
}

// Probe the peer-share endpoint once and cache whether it will serve files to
// this client. /dl/ availability is server-GLOBAL (share on/off + this client's
// IP), not per-file, so one probe gates every download pill — never N probes
// for N rows. Uses a 1-byte ranged GET, not HEAD: the server's do_HEAD answers
// 200 for every path, so HEAD can't tell a live /dl/ from a gated one.
// 206/200 → live; 403 (WAN or sharing off) / 404 → gated.
let _dlProbe = null;  // {ts, promise:Promise<boolean>}
const DL_PROBE_TTL_MS = 30000;
function _probeDlShare(file) {
  const now = Date.now();
  if (_dlProbe && (now - _dlProbe.ts) < DL_PROBE_TTL_MS) return _dlProbe.promise;
  const p = (async () => {
    if (!file) return false;
    try {
      const res = await fetch('/dl/' + encodeURIComponent(file), {headers: {'Range': 'bytes=0-0'}});
      const ok = res.status === 206 || res.status === 200;
      // Don't pull the body: if an intermediary ignored Range and answered 200,
      // arrayBuffer() would download the whole ZIM invisibly. Cancel instead.
      try { if (res.body) res.body.cancel(); } catch (e) {}
      return ok;
    } catch (e) { return false; }
  })();
  _dlProbe = {ts: now, promise: p};
  return p;
}

// Reveal the source-header download link only when peer-share is live.
async function _probeZimDownload(name, info) {
  const file = info && info.file;
  if (!file) return;
  const ok = await _probeDlShare(file);
  if (!ok) return;
  // The panel may have moved on while we were probing.
  if (mode !== 'source' || currentSource !== name) return;
  const box = document.getElementById('sh-download');
  if (!box) return;
  box.innerHTML = _dlPillHtml(file);
  box.hidden = false;
}

// Fill hidden download slots with a pill ONLY when the peer-share endpoint is
// live for this client — one global probe gates every slot (see _probeDlShare),
// and a gated client simply never sees a download affordance (no button that
// nags to turn sharing on). `prefix` lets a slot carry its own separator so an
// unfilled slot renders nothing at all.
function _fillDlSlots(root, selector, cls, prefix) {
  const slots = root.querySelectorAll(selector);
  if (!slots.length) return;
  _probeDlShare(slots[0].getAttribute('data-file')).then(function(ok) {
    if (!ok) return;
    slots.forEach(function(slot) {
      const file = slot.getAttribute('data-file');
      if (file) { slot.innerHTML = (prefix || '') + _dlPillHtml(file, cls); slot.hidden = false; }
    });
  });
}

// Reveal a download pill on every installed manage-list row.
function _fillInstalledDownloads(el) {
  _fillDlSlots(el, '.ci-dl[data-file]', 'ci-installed-badge dl-pill');
}

// Same reveal for the export cards on the home grid. renderCardGrid returns a
// string its callers insert synchronously, so a 0-tick defer lands after the
// slots are in the DOM.
function _fillCardDlSlots() {
  _fillDlSlots(document, '.card-dl-slot[data-file]', 'card-dl-pill', ' &middot; ');
}

// Jump straight into a source's homepage article in the reader (skip the
// intermediate source page). Shared by both auto-open sites in renderSource so
// the "become the reader" steps stay in one place.
function _autoOpenSourceMain(name, mainPath) {
  sourceHeaderEl.style.display = 'none';
  output.innerHTML = '';
  sourceAutoReader = true;
  currentArticle = { zim: name, path: mainPath };
  openReader('/w/' + encodeURIComponent(name) + '/' + mainPath);
}

// ── zimgit / PDF collection document list ──
// A zimgit-* ZIM is a collection of PDFs described by database.js. We render it
// as a searchable document list (title + author + size + description) instead of
// a reader — the header already flags it as a document collection.
var _zimgitDocs = [];      // documents for the collection currently shown
var _zimgitZimName = '';   // ZIM they belong to (for the filter's re-render)

function _zimgitDocHtml(name, d, i) {
  var hasPath = !!d.path;
  // With a path the row is a real link (#49) — new-tab gestures work natively,
  // and the anchor is focusable/Enter-activatable without div scaffolding.
  var tag = hasPath ? 'a' : 'div';
  var navAttrs = hasPath
    ? ' href="' + escAttr(_articleDeepLinkPath(name, d.path)) + '" data-zim="' + escAttr(name) + '" data-path="' + escAttr(d.path) + '" data-title="' + escAttr(d.title || '') + '" onclick="return _spaCardClick(event, this)"'
    : '';
  var meta = [];
  if (d.author) meta.push(esc(d.author));
  if (d.size) meta.push(_fmtBytes(d.size));
  var metaHtml = meta.length ? '<div class="zg-meta">' + meta.join(' · ') + '</div>' : '';
  return '<' + tag + ' class="result zg-doc"' + navAttrs +
    ' style="animation-delay:' + (i * 0.04) + 's">' +
    '<div class="zg-icon" aria-hidden="true">PDF</div>' +
    '<div class="result-body">' +
      '<div class="title">' + esc(d.title) + '</div>' +
      (d.description ? '<div class="snippet">' + esc(d.description) + '</div>' : '') +
      metaHtml +
    '</div></' + tag + '>';
}

function _renderZimgitCatalog(name, docs) {
  _zimgitDocs = docs;
  _zimgitZimName = name;
  // The filter earns its space only on longer lists; short ones scan fine.
  var showFilter = docs.length > 6;
  var h = '<div class="cat-heading">' + tH('documents', {n: docs.length}) + '</div>';
  if (showFilter) {
    h += '<input type="search" id="zg-filter" class="zg-filter" autocomplete="off" ' +
      'placeholder="' + escAttr(t('filter_documents')) + '" aria-label="' + escAttr(t('filter_documents')) + '" ' +
      'oninput="_filterZimgitCatalog(this.value)">';
  }
  h += '<div class="results" id="zg-results">' +
    docs.map(function(d, i) { return _zimgitDocHtml(name, d, i); }).join('') + '</div>';
  output.innerHTML = h;
}

function _filterZimgitCatalog(q) {
  var qq = (q || '').trim().toLowerCase();
  var results = document.getElementById('zg-results');
  if (!results) return;
  var filtered = !qq ? _zimgitDocs : _zimgitDocs.filter(function(d) {
    return (d.title || '').toLowerCase().indexOf(qq) >= 0 ||
           (d.description || '').toLowerCase().indexOf(qq) >= 0 ||
           (d.author || '').toLowerCase().indexOf(qq) >= 0;
  });
  if (!filtered.length) {
    results.innerHTML = '<div class="zg-empty">' + tH('no_matching_documents') + '</div>';
    return;
  }
  results.innerHTML = filtered.map(function(d, i) {
    return _zimgitDocHtml(_zimgitZimName, d, i);
  }).join('');
}

// ── Render: Source ──
async function renderSource(name) {
  const info = _zimInfo(name);
  if (!info) return;

  statsBar.style.display = 'none';
  pillsBar.innerHTML = ''; pillsBar.style.display = 'none'; pillsBar.className = 'pills';

  // Build source header HTML (shown only for catalog/empty ZIMs)
  const iconHtml = info.has_icon
    ? '<img src="/w/' + encodeURIComponent(name) + '/-/icon" alt="" width="64" height="64">'
    : '<span class="icon-letter" style="font-size:28px">' + esc(info.title || name)[0].toUpperCase() + '</span>';
  // zimgit-* ZIMs are PDF/document collections, not encyclopedias — the header
  // says so, and below they get a searchable document list instead of a reader.
  const isZimgit = name.startsWith('zimgit-');
  const collectionChip = isZimgit
    ? ' &middot; <span class="sh-chip">' + tH('document_collection') + '</span>'
    : '';
  const headerHtml = '<div class="source-header">' +
    '<div class="sh-icon">' + iconHtml + '</div>' +
    '<div class="sh-info">' +
      '<h1>' + esc(info.title || name) + '</h1>' +
      '<div class="sh-meta">' + _zimCountHtml(info) +
      ' &middot; ' + fmtSize(info.size_gb) + collectionChip + '</div>' +
      (info.description ? '<div class="sh-desc">' + esc(info.description) + '</div>' : '') +
    '</div></div>';

  // For ZIMs with a homepage, go straight to reader (skip intermediate page)
  // Unless navigating back via popstate — show the source page instead
  if (info.main_path && !isZimgit && !_popstateNoAutoReader) {
    _autoOpenSourceMain(name, info.main_path);
    return;
  }

  // Catalog ZIMs or ZIMs without main_path — show source header
  sourceHeaderEl.innerHTML = headerHtml;
  sourceHeaderEl.style.display = '';
  output.innerHTML = _loadingHtml();

  // No download link in the source header \u2014 the raw .zim is a rare,
  // deliberate grab that lives on right-click / the Manage \u22ef menu.

  // Try catalog (zimgit PDF collections show document list)
  try {
    const res = await fetch('/catalog?zim=' + encodeURIComponent(name));
    const data = await res.json();
    if (mode !== 'source' || currentSource !== name) return; // stale
    if (data.documents && data.documents.length) {
      _renderZimgitCatalog(name, data.documents);
      return;
    }
  } catch(e) {}

  if (mode !== 'source' || currentSource !== name) return;

  // main_path ZIM that isn't a catalog: auto-open the homepage in the reader —
  // UNLESS auto-open is suppressed (popstate back / deep-link boot), in which
  // case leave the source header visible and don't touch currentArticle. Missing
  // this guard was what let a deep-link boot stamp currentArticle with the ZIM
  // homepage, which then leaked a phantom entry into articleHistory.
  if (info.main_path) {
    if (_popstateNoAutoReader) { output.innerHTML = ''; }
    else _autoOpenSourceMain(name, info.main_path);
  } else if (info.entries === 0 || info.entries === '?') {
    output.innerHTML = '<div class="empty"><p>' + tH('no_content') + '</p><p class="hint">' + tH('zim_corrupted') + '</p></div>';
  } else {
    output.innerHTML = '';
  }
}

// ── Search ──
// ── History-in-dropdown: show recent history when search bar is focused ──
var _searchFocusedByUser = false;
// Clicking an ALREADY-focused box (desktop autofocus) fires no focus event, so
// open the dropdown here too or the filter pills would be unreachable.
function _searchBoxPressed() {
  _searchFocusedByUser = true;
  if (document.activeElement === q && !q.value.trim() && mode !== 'manage') showHistoryDropdown();
}
q.addEventListener('mousedown', _searchBoxPressed);
q.addEventListener('touchstart', _searchBoxPressed);
q.addEventListener('focus', function() {
  // Open the dropdown (filter pills + recent history) on user-initiated focus
  // only — not autofocus-on-load, which would spoil the clean default home.
  if (_searchFocusedByUser && !q.value.trim() && mode !== 'manage') showHistoryDropdown();
  // Only hide topbar icons on mobile when user tapped the search box (not autofocus on load)
  if (_searchFocusedByUser && _isNarrow()) {
    document.querySelector('.topbar').classList.add('search-focused');
  }
  _searchFocusedByUser = false;
});
q.addEventListener('blur', function() {
  document.querySelector('.topbar').classList.remove('search-focused');
});

q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const val = q.value.trim();
  // Suggest (200ms debounce) — include history items when typing
  clearTimeout(suggestTimer);
  if (val && val.length >= 1 && mode !== 'manage') {
    // Show filtered history immediately, then fetch remote suggestions
    showHistoryDropdown(val);
    if (val.length >= 2) suggestTimer = setTimeout(() => fetchSuggestions(val), 200);
  } else if (!val && mode !== 'manage') {
    showHistoryDropdown();
  } else {
    hideSuggest();
  }
  // Full search or clear
  if (!val) { hideSuggest(); clearSearch(); return; }
  if (mode === 'manage') {
    searchTimer = setTimeout(() => {
      if (manageTab === 'installed') {
        renderInstalled(val);
      } else {
        browseCatalogFilter(val);
      }
    }, 300);
    return;
  }
  // On homepage: live-filter ZIM sources; article search only on Enter
  if (!currentSource && (mode === 'home' || mode === 'search')) {
    mode = 'home';
    searchMeta.style.display = 'none';
    renderHome(val);
    return;
  }
  searchTimer = setTimeout(() => doSearch(val), 500);
});

q.addEventListener('keydown', e => {
  // Suggest keyboard navigation
  if (suggestDropdown.style.display !== 'none') {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      suggestIndex = Math.min(suggestIndex + 1, suggestItems.length - 1);
      highlightSuggest();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      suggestIndex = Math.max(suggestIndex - 1, -1);
      highlightSuggest();
      return;
    }
    if (e.key === 'Enter' && suggestIndex >= 0) {
      e.preventDefault();
      selectSuggest(suggestIndex);
      return;
    }
    if (e.key === 'Escape') {
      hideSuggest();
      return;
    }
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchTimer);
    clearTimeout(suggestTimer);
    hideSuggest();
    if (mode === 'manage') {
      if (manageTab === 'installed') {
        renderInstalled(q.value.trim());
      } else {
        const val = q.value.trim();
        if (val) { browseCatalogFilter(val); } else { renderBrowseGallery(); }
      }
      return;
    }
    doSearch(q.value.trim());
  }
});


// Re-run the search with a "Did you mean" correction the user clicked.
function applyDidYouMean(suggestion) {
  if (!suggestion) return;
  var q = document.getElementById('q');
  if (q) q.value = suggestion;
  doSearch(suggestion, true);
}

async function doSearch(query, push) {
  if (push === undefined) push = true;
  if (!query) return;
  _currentSearchQuery = query;
  clearTimeout(suggestTimer);
  hideSuggest();

  // Reject all-stop-word queries (e.g. "what", "the", "is it")
  const STOPS = new Set(['a','an','and','are','as','at','be','by','for','from','has','have','how','i','in','is','it','its','my','not','of','on','or','so','that','the','this','to','was','we','what','when','where','which','who','will','with','you']);
  const meaningful = query.toLowerCase().split(/\s+/).filter(w => !STOPS.has(w));
  if (!meaningful.length) {
    mode = 'search';
    statsBar.style.display = 'none';
    pillsBar.innerHTML = ''; pillsBar.style.display = 'none'; pillsBar.className = 'pills';
    searchMeta.style.display = 'none';
    output.innerHTML = '<div class="empty"><p>' + tH('try_specific') + '</p><p class="hint">' + tH('common_words', {word: query}) + '</p></div>';
    updateTopbar();
    return;
  }

  if (searchController) searchController.abort();
  searchController = new AbortController();

  const scope = currentSource;
  mode = 'search';
  sourceAutoReader = false; // user searched — don't auto-home on back
  visibleResultCount = RESULTS_PER_PAGE;

  // Close reader or almanac if open
  if (readerOpen) closeReader();
  if (_createOpen) closeCreate();
  if (_almanacOpen) closeAlmanac();

  mainView.classList.remove('hidden');
  if (!scope) sourceHeaderEl.style.display = 'none';
  statsBar.style.display = 'none';
  pillsBar.innerHTML = ''; pillsBar.style.display = 'none'; pillsBar.className = 'pills';
  searchMeta.style.display = 'none';
  output.innerHTML = '<div class="loading"><span class="spinner-inline"></span>' + tH('searching_titles') + '</div>';
  updateTopbar();

  let zimParam = scope ? '&zim=' + encodeURIComponent(scope) : '';
  if (!scope && homeScope) {
    zimParam = '&zim=' + encodeURIComponent(homeScope.zimNames.join(','));
  }
  const searchT0 = performance.now();
  const searchUrl = scope ? '/w/' + encodeURIComponent(scope) + '?q=' + encodeURIComponent(query) : '/?q=' + encodeURIComponent(query);

  try {
    // ── Progressive two-phase search: fast title matches first, then full FTS ──
    // Phase 1: fast title search (parallel per-ZIM, no lock contention)
    const r1 = await serverFetch('/search?q=' + encodeURIComponent(query) + '&limit=10' + zimParam + '&fast=1',
      { signal: searchController.signal });
    const d1 = await r1.json();
    const phase1Elapsed = ((performance.now() - searchT0) / 1000).toFixed(1);
    d1._clientElapsed = phase1Elapsed;
    d1._query = query;
    allResults = d1;
    if (push) {
      // Replace (not push) if we're already on a search page — prevents duplicate entries
      // from autosearch timer + Enter key both calling doSearch
      var hs = history.state;
      if (hs && hs.mode === 'search') {
        history.replaceState({ mode: 'search', query: query, source: scope }, '', searchUrl);
      } else {
        history.pushState({ mode: 'search', query: query, source: scope }, '', searchUrl);
      }
    }
    renderSearchResults(allResults, scope);
    // Persist search to browse history
    _histPushSearch(query, scope, (d1.results || []).length);

    if (d1.partial) {
      // Show honest progress: "N title matches (Xs) — searching content..."
      const titleCount = (d1.results || []).length;
      const indicator = document.createElement('div');
      indicator.className = 'content-search-indicator';
      indicator.id = 'fts-indicator';
      const msg = titleCount > 0
        ? titleCount + ' title match' + (titleCount !== 1 ? 'es' : '') + ' (' + phase1Elapsed + 's) \u2014 '
        : '';
      indicator.innerHTML = '<span class="spinner-inline"></span>' + msg + tH('searching_content');
      output.prepend(indicator);

      // Live elapsed timer
      const timerInterval = setInterval(() => {
        const el = document.getElementById('fts-indicator');
        if (!el) { clearInterval(timerInterval); return; }
        const now = ((performance.now() - searchT0) / 1000).toFixed(0);
        el.innerHTML = '<span class="spinner-inline"></span>' + msg + tH('searching_content_time', {time: now});
      }, 1000);

      // Phase 2: full Xapian FTS (sequential under _zim_lock, searches every ZIM)
      const r2 = await serverFetch('/search?q=' + encodeURIComponent(query) + '&limit=10' + zimParam,
        { signal: searchController.signal });
      const d2 = await r2.json();
      clearInterval(timerInterval);
      d2._clientElapsed = ((performance.now() - searchT0) / 1000).toFixed(1);
      d2._query = query;
      allResults = mergeSearchResults(d1, d2);
      renderSearchResults(allResults, scope);
    }
  } catch(e) {
    if (e.name === 'AbortError') return;
    // "Search failed / try again" implies the server tried and something went
    // wrong there. If we never reached it, say that instead and offer Retry.
    if (_isOfflineError(e)) {
      output.innerHTML = '<div class="empty conn-empty"><p>' + tH('search_offline') + '</p>' +
        '<p class="hint">' + tH('search_offline_hint') + '</p>' +
        '<button type="button" class="conn-retry conn-retry-inline" onclick="_connRetryClick(this)">' + tH('conn_retry') + '</button></div>';
      return;
    }
    output.innerHTML = '<div class="empty"><p>' + tH('search_failed') + '</p><p class="hint">' + tH('try_again') + '</p></div>';
  }
}

function mergeSearchResults(phase1, phase2) {
  // Deduplicate by zim+path, keeping higher-scored version
  const seen = new Map();
  for (const r of (phase1.results || [])) {
    const key = r.zim + ':' + r.path;
    const existing = seen.get(key);
    if (!existing || r.score > existing.score) seen.set(key, r);
  }
  for (const r of (phase2.results || [])) {
    const key = r.zim + ':' + r.path;
    const existing = seen.get(key);
    if (!existing || r.score > existing.score) seen.set(key, r);
  }
  const merged = Array.from(seen.values()).sort((a, b) => b.score - a.score);

  // Merge by_source counts (take max from either phase)
  const bySource = { ...(phase1.by_source || {}) };
  for (const [k, v] of Object.entries(phase2.by_source || {})) {
    bySource[k] = Math.max(bySource[k] || 0, v);
  }

  // Merge by_language counts (take max from either phase)
  const byLanguage = { ...(phase1.by_language || {}) };
  for (const [k, v] of Object.entries(phase2.by_language || {})) {
    byLanguage[k] = Math.max(byLanguage[k] || 0, v);
  }

  return {
    results: merged,
    by_source: bySource,
    by_language: byLanguage,
    total: merged.length,
    elapsed: phase2.elapsed,
    partial: false,
    did_you_mean: phase2.did_you_mean || phase1.did_you_mean,
    _clientElapsed: phase2._clientElapsed,
    _query: phase2._query,
  };
}

function _sourceIconHtml(zimName, size) {
  const info = _zimInfo(zimName);
  const title = (info && info.title) || zimName;
  if (info && info.has_icon) {
    return '<img src="/w/' + encodeURIComponent(zimName) + '/-/icon" alt="" width="' + size + '" height="' + size + '">';
  }
  return '<span class="rs-letter">' + (esc(title)[0] || 'Z').toUpperCase() + '</span>';
}

var _NATIVE_LANG_NAMES = {
  en:'English',fr:'Français',de:'Deutsch',es:'Español',pt:'Português',
  ru:'Русский',zh:'中文',ja:'日本語',ko:'한국어',ar:'العربية',hi:'हिन्दी',
  it:'Italiano',nl:'Nederlands',pl:'Polski',tr:'Türkçe',sv:'Svenska',
  he:'עברית',uk:'Українська',cs:'Čeština',ro:'Română',hu:'Magyar',
  el:'Ελληνικά',da:'Dansk',fi:'Suomi',no:'Norsk',th:'ไทย',vi:'Tiếng Việt',
  id:'Bahasa Indonesia',ms:'Bahasa Melayu',fa:'فارسی',ca:'Català',
  bn:'বাংলা',ta:'தமிழ்',te:'తెలుగు',ur:'اردو',mul:'Multiple'
};

function toggleLanguageFilter(lang) {
  if (activeLanguageFilters.has(lang)) activeLanguageFilters.delete(lang);
  else activeLanguageFilters.add(lang);
  renderSearchResults(allResults, currentSource);
}

// "All" reset pills at the head of each search filter row — one click each on
// the two Alls returns the results to the unfiltered set.
function clearLanguageFilter() {
  activeLanguageFilters.clear();
  renderSearchResults(allResults, currentSource);
}
function clearSourceFilter() {
  activeSourceFilters.clear();
  visibleResultCount = RESULTS_PER_PAGE;
  renderSearchResults(allResults, null);
}
// One "All" reset pill (active when no filter is applied on its row).
function _allResetPill(active, handler) {
  return '<button class="pill' + (active ? ' active' : '') + '" aria-pressed="' +
    active + '" onclick="' + handler + '">' + tH('filter_all') + '</button>';
}

function renderSearchResults(data, scope) {
  if (snippetController) { snippetController.abort(); snippetController = null; }
  let items = data.results || [];
  const bySource = data.by_source || {};
  const byLanguage = data.by_language || {};
  const totalCount = data.total || items.length;

  // Build cross-reference: which languages per source, which sources per language
  var cache_lang_map = {};
  (zimsCache || []).forEach(function(z) { cache_lang_map[z.name] = z.language || ''; });
  var langsBySource = {};  // source → Set of lang codes
  var sourcesByLang = {};  // lang → Set of sources
  for (var ri = 0; ri < items.length; ri++) {
    var rItem = items[ri];
    var rLang = cache_lang_map[rItem.zim] || '';
    if (!langsBySource[rItem.zim]) langsBySource[rItem.zim] = new Set();
    langsBySource[rItem.zim].add(rLang);
    if (!sourcesByLang[rLang]) sourcesByLang[rLang] = new Set();
    sourcesByLang[rLang].add(rItem.zim);
  }

  // Language filter pills (global search only, multiple languages)
  var langPillsHtml = '';
  const langCodes = Object.keys(byLanguage);
  if (!scope && langCodes.length > 1) {
    // Sort by count descending, same as source pills
    langPillsHtml = '<div class="lang-pills" role="group" aria-label="' + escAttr(t('filter_by_language')) + '">' +
      _allResetPill(activeLanguageFilters.size === 0, 'clearLanguageFilter()') +
      langCodes.sort(function(a, b) { return (byLanguage[b] || 0) - (byLanguage[a] || 0); }).map(function(lang) {
      var name = _NATIVE_LANG_NAMES[lang] || lang;
      // Dim language pills when a source filter is active and that source has no results in this language
      var dimmed = activeSourceFilters.size > 0 && ![...activeSourceFilters].some(function(s) { return langsBySource[s] && langsBySource[s].has(lang); });
      return '<button class="pill' + (activeLanguageFilters.has(lang) ? ' active' : '') + (dimmed ? ' dimmed' : '') +
        '" aria-pressed="' + activeLanguageFilters.has(lang) + '" onclick="toggleLanguageFilter(\'' + escAttr(lang) + '\')">' +
        esc(name) + ' (' + byLanguage[lang] + ')</button>';
    }).join('') + '</div>';
  }

  // Source filter pills (global search only, multiple sources)
  const sourceNames = Object.keys(bySource);
  if (!scope && sourceNames.length > 1) {
    // When two+ sources share a display title (e.g. wikipedia + wikipedia_de both
    // read "Wikipedia"), tag each colliding pill with its language code so they're
    // tellable apart. Unique titles stay clean. Reuses the tile lang-badge look.
    var _titleCounts = {};
    sourceNames.forEach(function(s) { var tt = _zimTitle(s); _titleCounts[tt] = (_titleCounts[tt] || 0) + 1; });
    // Sort by count descending so most relevant sources are visible first
    var sourcePillsHtml = _allResetPill(activeSourceFilters.size === 0, 'clearSourceFilter()') +
      sourceNames.sort(function(a, b) { return (bySource[b] || 0) - (bySource[a] || 0); }).map(function(s) {
      // Dim source pills when a language filter is active and this source has no results in that language
      var dimmed = activeLanguageFilters.size > 0 && ![...activeLanguageFilters].some(function(lang) { return sourcesByLang[lang] && sourcesByLang[lang].has(s); });
      var _si = _zimInfo(s);
      var badge = (_si && _titleCounts[_zimTitle(s)] > 1) ? ' ' + _langBadge(_si, true) : '';
      return '<button class="pill' + (activeSourceFilters.has(s) ? ' active' : '') + (dimmed ? ' dimmed' : '') +
        '" aria-pressed="' + activeSourceFilters.has(s) + '" onclick="toggleSourceFilter(\'' + escAttr(s) + '\')">' +
        esc(_zimTitle(s)) + badge + ' (' + bySource[s] + ')</button>';
    }).join('');
    pillsBar.className = 'pills';
    // Source pills first, then language pills below (consistent with catalog).
    // These are search-results pills, always shown — not the focus-gated home
    // filter rows, so clear the marker the home path sets.
    _pillsAreHomeFilters = false;
    pillsBar.innerHTML = '<div class="pills-row">' + sourcePillsHtml + '</div>' + langPillsHtml;
    pillsBar.style.display = '';
  } else if (langPillsHtml) {
    pillsBar.className = 'pills';
    _pillsAreHomeFilters = false;
    pillsBar.innerHTML = langPillsHtml;
    pillsBar.style.display = '';
  }

  // Apply language filter
  if (activeLanguageFilters.size > 0) {
    var cache_lang = {};
    (zimsCache || []).forEach(function(z) { cache_lang[z.name] = z.language || ''; });
    items = items.filter(function(r) { return activeLanguageFilters.has(cache_lang[r.zim] || ''); });
  }

  if (activeSourceFilters.size > 0) {
    items = items.filter(r => activeSourceFilters.has(r.zim));
  }

  const displayElapsed = data._clientElapsed || (data.elapsed ? data.elapsed.toFixed(1) : null);
  document.getElementById('search-count').textContent = t('n_results', {n: totalCount});
  document.getElementById('search-time').textContent = displayElapsed ? t('in_time', {time: displayElapsed}) : '';
  searchMeta.style.display = items.length ? 'flex' : 'none';

  // "Did you mean X?" — a clickable correction, shown only when results are
  // sparse (server already gates on <3, but merged counts can differ).
  var dymHtml = '';
  if (data.did_you_mean && totalCount < 3) {
    var sugg = data.did_you_mean;
    dymHtml = '<div class="did-you-mean">' +
      t('did_you_mean', {s: '<a href="#" data-sugg="' + escAttr(sugg) + '">' + esc(sugg) + '</a>'}) +
      '</div>';
  }

  if (!items.length) {
    output.innerHTML = '<div class="empty">' + dymHtml + '<p>' + tH('no_results') + '</p><p class="hint">' + tH('try_different') + '</p></div>';
    return;
  }

  // Show matching ZIM sources above results (global search only)
  let zimMatchHtml = '';
  if (!scope && zimsCache && data._query) {
    const ql = data._query.toLowerCase();
    const qw = ql.split(/\s+/).filter(Boolean);
    const matches = zimsCache.filter(z => {
      const t = ((z.title || '') + ' ' + z.name + ' ' + (z.description || '')).toLowerCase();
      return qw.every(w => t.includes(w));
    });
    if (matches.length > 0 && matches.length <= 8) {
      zimMatchHtml = '<div class="stats-grid" style="margin-bottom:16px">' + matches.map(z => {
        const icon = z.has_icon
          ? '<img src="/w/' + encodeURIComponent(z.name) + '/-/icon" alt="" width="48" height="48" loading="lazy">'
          : '<span class="icon-letter">' + esc(z.title || z.name)[0].toUpperCase() + '</span>';
        // Real link (#49) — and data-zim keeps the long-press context menu
        // working now that there is no enterSource(...) onclick to parse.
        return '<a class="stat-card" data-zim="' + escAttr(z.name) + '" href="/w/' + encodeURIComponent(z.name) + '" onclick="return _spaSourceClick(event, this)">' +
          '<div class="card-icon">' + icon + '</div>' +
          '<div class="card-info">' +
            '<div class="name">' + esc(z.title || z.name) + '</div>' +
            (z.description ? '<div class="desc">' + esc(z.description) + '</div>' : '') +
            '<div class="detail">' + _zimCountHtml(z) +
            ' &middot; ' + fmtSize(z.size_gb) + '</div>' +
          '</div></a>';
      }).join('') + '</div>';
    }
  }

  // Pagination: show only first visibleResultCount items
  const visible = items.slice(0, visibleResultCount);
  const remaining = items.length - visibleResultCount;

  let html = dymHtml + zimMatchHtml + '<div class="results">' + visible.map((r, i) => {
    const sourceRow = !scope
      ? '<div class="result-source">' + _sourceIconHtml(r.zim, 20) +
        '<span class="rs-name">' + esc(_zimTitle(r.zim)) + '</span></div>'
      : '';
    // Real link (#49): anchors are natively focusable and Enter-activatable,
    // so the tabindex/role/onkeydown scaffolding a div needed goes away.
    return '<a class="result" href="' + escAttr(_articleDeepLinkPath(r.zim, r.path)) + '" data-zim="' + escAttr(r.zim) + '" data-path="' + escAttr(r.path) + '" data-title="' + escAttr(r.title || '') + '" style="animation-delay:' + (Math.min(i, 5) * 0.04) + 's" onclick="return _spaCardClick(event, this)">' +
      '<div class="result-thumb" data-needs-thumb="1"></div>' +
      '<div class="result-body">' + sourceRow +
      '<div class="title">' + esc(r.title) + '</div>' +
      (r.snippet ? '<div class="snippet">' + esc(r.snippet) + '</div>' : '<div class="snippet" data-needs-snippet="1"></div>') +
      '</div></a>';
  }).join('') + '</div>';

  if (remaining > 0) {
    html += '<div class="load-more"><button onclick="showMoreResults()">' +
      tH('show_more', {n: Math.min(RESULTS_PER_PAGE, remaining)}) + '</button></div>';
  }

  if (displayElapsed) {
    html += '<div class="results-summary">' + tH('found_results_in', {n: totalCount, time: displayElapsed}) + '</div>';
  }

  output.innerHTML = html;

  loadSnippets();
}

function showMoreResults() {
  visibleResultCount += RESULTS_PER_PAGE;
  // Preserve the FTS progress indicator if phase 2 is still running
  var indicator = document.getElementById('fts-indicator');
  var savedIndicator = indicator ? indicator.cloneNode(true) : null;
  renderSearchResults(allResults, currentSource);
  if (savedIndicator && !document.getElementById('fts-indicator')) {
    output.prepend(savedIndicator);
  }
}

function _zimTitle(name) {
  const info = _zimInfo(name);
  return (info && info.title) || name;
}
// True for ZIMs whose articles are primarily playable video (TED, TED-Ed, Khan
// Academy talk collections). Drives the play badge on discover cards so a
// "random" pick from one reads as "play a video", not "read an article".
function _isVideoZim(name) {
  return /^ted[_-]|(^|_)ted-ed|khanacademy|^khan[_-]/i.test(name || '');
}
function _zimTitleWithLang(name) {
  var info = _zimInfo(name);
  var title = (info && info.title) || name;
  if (info && info.language && info.language !== _currentLang) {
    title += ' (' + _langDisplayName(info.language) + ')';
  }
  return title;
}

// ── Async Snippets + Thumbnails ──
async function loadSnippets() {
  if (snippetController) snippetController.abort();
  snippetController = new AbortController();
  const signal = snippetController.signal;

  // Collect all result cards that need either snippets or thumbnails
  const cards = document.querySelectorAll('.result[data-zim][data-path]');
  const queue = [];
  cards.forEach(function(card) {
    const needsSnippet = card.querySelector('[data-needs-snippet="1"]');
    const needsThumb = card.querySelector('[data-needs-thumb]');
    if (needsSnippet || needsThumb) queue.push(card);
  });
  if (!queue.length) return;

  const concurrency = 4;
  let active = 0;
  let idx = 0;

  function next() {
    while (active < concurrency && idx < queue.length) {
      const card = queue[idx++];
      const zim = card.dataset.zim;
      const path = card.dataset.path;
      if (!zim || !path) continue;
      const snippetEl = card.querySelector('[data-needs-snippet="1"]');
      active++;
      fetchSnippet(snippetEl || card.querySelector('.snippet'), zim, path, signal, card)
        .finally(() => { active--; next(); });
    }
  }
  next();
}

async function fetchSnippet(snippetEl, zim, path, signal, card) {
  try {
    const res = await fetch('/snippet?zim=' + encodeURIComponent(zim) + '&path=' + encodeURIComponent(path), { signal });
    const data = await res.json();
    // Populate snippet text if needed
    if (snippetEl && snippetEl.hasAttribute('data-needs-snippet')) {
      if (data.snippet) {
        snippetEl.textContent = data.snippet;
        snippetEl.removeAttribute('data-needs-snippet');
        snippetEl.style.opacity = '0';
        requestAnimationFrame(() => { snippetEl.style.opacity = '1'; });
      } else {
        snippetEl.remove();
      }
    }
    // Populate thumbnail if returned
    if (data.thumbnail && card) {
      var thumbEl = card.querySelector('.result-thumb[data-needs-thumb]');
      if (thumbEl) {
        var img = new Image();
        img.onload = function() {
          if (img.naturalWidth >= 60 && img.naturalHeight >= 40) {
            thumbEl.innerHTML = '';
            thumbEl.appendChild(img);
            thumbEl.classList.add('loaded');
            thumbEl.removeAttribute('data-needs-thumb');
          }
        };
        img.src = data.thumbnail;
      }
    }
  } catch(e) {
    if (e.name !== 'AbortError' && snippetEl && snippetEl.hasAttribute('data-needs-snippet')) snippetEl.remove();
  }
}

function toggleSourceFilter(s) {
  if (activeSourceFilters.has(s)) activeSourceFilters.delete(s);
  else activeSourceFilters.add(s);
  visibleResultCount = RESULTS_PER_PAGE;
  renderSearchResults(allResults, null);
}

// The search box × affordance (and Escape): wipe the query, results and filter
// state, returning to the current context's clean view. Keeps focus in the box
// so the user can keep typing.
function clearSearchInput() {
  q.value = '';
  hideSuggest();
  clearSearch();
  q.focus();
}

function clearSearch() {
  activeSourceFilters.clear();
  if (snippetController) { snippetController.abort(); snippetController = null; }
  searchMeta.style.display = 'none';
  visibleResultCount = RESULTS_PER_PAGE;
  if (mode === 'manage') {
    if (manageTab === 'browse') {
      if (manageCategoryFilter) drillCategory(manageCategoryFilter);
      else renderBrowseGallery();
    } else {
      renderInstalled();
    }
  } else if (currentSource) {
    mode = 'source';
    updateTopbar();
    renderSource(currentSource);
  } else {
    mode = 'home';
    updateTopbar();
    renderHome();
  }
}

// ── Suggest / Autocomplete ──
let suggestController = null;
let _suggestSeq = 0; // sequence counter to discard stale responses

async function fetchSuggestions(query) {
  // Cancel any in-flight suggest request
  if (suggestController) suggestController.abort();
  suggestController = new AbortController();
  const seq = ++_suggestSeq;

  const zimParam = currentSource ? '&zim=' + encodeURIComponent(currentSource) : '';
  try {
    const res = await fetch('/suggest?q=' + encodeURIComponent(query) + '&limit=6' + zimParam,
      { signal: suggestController.signal });
    const data = await res.json();
    // Discard if a newer request has been issued or input lost focus
    if (seq !== _suggestSeq || document.activeElement !== q) return;
    // data is {zim_name: [{path, title}, ...], ...}
    suggestItems = [];
    for (const [zim, items] of Object.entries(data)) {
      for (const item of items) {
        if (item.error) continue;
        suggestItems.push({ zim, path: item.path, title: item.title });
      }
    }
    // Deduplicate by title
    const seen = new Set();
    suggestItems = suggestItems.filter(s => {
      const key = s.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 6);

    if (suggestItems.length) showSuggest();
    else hideSuggest();
  } catch(e) {
    if (e.name !== 'AbortError') hideSuggest();
  }
}

// Close suggestions when clicking anywhere outside the search box/dropdown
document.addEventListener('mousedown', (e) => {
  if (!suggestDropdown.contains(e.target) && e.target !== q) {
    hideSuggest();
  }
});

function showHistoryDropdown(filter) {
  var h = _histLoad();
  var fl = filter ? filter.toLowerCase() : '';
  // Filter pills ride at the top of the dropdown in the focus state (not while
  // typing) — this is where recency/language filters are picked. They filter
  // the current library view — the whole library on unscoped home, or just the
  // section's ZIMs inside a scope (favorites/category/collection) — so they
  // belong on home in general: never inside a single ZIM (currentSource), a
  // search, or manage. Picking a pill closes the dropdown and renders the
  // filtered view.
  // Gate: never inside a single ZIM (currentSource), a search, manage, or while
  // READING an article opened from home (readerOpen — the mode can still read
  // 'home' behind the reader overlay, #7). And when a filter is already ACTIVE
  // the pills-bar is shown above the content, so the dropdown must not duplicate
  // the same rows — the handoff is idle→dropdown, in-use→pills-bar (#9).
  var _filterActive = !!homeRecentFilter || homeLangFilter.size > 0;
  var pillsHtml = (!filter && _homeFilterRowsHtml && mode === 'home' &&
      !currentSource && !readerOpen && !_filterActive)
    ? '<div class="suggest-filters">' + _homeFilterRowsHtml + '</div>' : '';
  var items = [];
  var seen = new Set();
  for (var i = 0; i < h.length && items.length < 8; i++) {
    var entry = h[i];
    var label, sub, key;
    if (entry.type === 'search') {
      label = typeof entry.query === 'string' ? entry.query : '';
      sub = entry.zim ? _zimTitle(entry.zim) : t('all_sources').replace(/^\u2190\s*/, '');
      key = 's:' + label.toLowerCase();
    } else {
      label = (typeof entry.title === 'string' && entry.title) || _titleFromPath(entry.path || '');
      sub = entry.zim ? _zimTitle(entry.zim) : '';
      key = 'a:' + (entry.zim || '') + ':' + (entry.path || '');
    }
    if (!label) continue;
    if (fl && !label.toLowerCase().includes(fl) && !sub.toLowerCase().includes(fl)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ entry: entry, label: label, sub: sub, isSearch: entry.type === 'search', idx: i });
  }
  if (!items.length && !pillsHtml) {
    if (!filter) hideSuggest();
    return;
  }
  // Merge into suggestItems for keyboard navigation
  suggestItems = items.map(function(it) {
    return it.isSearch
      ? { _hist: true, _histSearch: true, query: it.entry.query, zim: it.entry.zim || '', label: it.label, sub: it.sub }
      : { _hist: true, zim: it.entry.zim, path: it.entry.path, title: it.label, label: it.label, sub: it.sub };
  });
  suggestIndex = -1;
  var icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;opacity:0.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  var searchIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;opacity:0.5"><circle cx="11" cy="11" r="8"/><path stroke-linecap="round" d="m21 21-4.3-4.3"/></svg>';
  var recentHeader = (filter || !items.length) ? '' : '<div style="padding:6px 14px 2px;font-size:11px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:0.06em">' + tH('suggest_recent') + '</div>';
  suggestDropdown.innerHTML = pillsHtml + recentHeader +
    items.map(function(it, i) {
      return '<div class="suggest-item" data-i="' + i + '" onmousedown="selectSuggest(' + i + ')" style="display:flex;align-items:center;gap:8px">' +
        (it.isSearch ? searchIcon : icon) +
        '<div style="flex:1;min-width:0"><div class="sg-title">' + esc(it.label) + '</div>' +
        '<div class="sg-source">' + esc(it.sub) + '</div></div></div>';
    }).join('');
  suggestDropdown.style.display = 'block';
}

function showSuggest() {
  suggestIndex = -1;
  suggestDropdown.innerHTML = suggestItems.map((s, i) =>
    '<div class="suggest-item" data-i="' + i + '" onmousedown="selectSuggest(' + i + ')">' +
    '<div class="sg-title">' + esc(s.title) + '</div>' +
    (!currentSource ? '<div class="sg-source">' + esc(_zimTitle(s.zim)) + '</div>' : '') +
    '</div>'
  ).join('');
  suggestDropdown.style.display = 'block';
}

function hideSuggest() {
  suggestDropdown.style.display = 'none';
  suggestIndex = -1;
  if (suggestController) { suggestController.abort(); suggestController = null; }
}

function highlightSuggest() {
  suggestDropdown.querySelectorAll('.suggest-item').forEach((el, i) => {
    el.classList.toggle('active', i === suggestIndex);
  });
}

function selectSuggest(i) {
  const s = suggestItems[i];
  if (!s) return;
  hideSuggest();
  // History search item: re-execute the search
  if (s._histSearch) {
    _runRecentSearch(s.query, s.zim);
    return;
  }
  // Regular suggestion or history article
  q.value = s.title;
  openArticle(s.zim, s.path, s.title);
}

// ── Library Manager ──
function toggleManage(e) {
  if (e) e.preventDefault();
  if (mode === 'manage') {
    _manageToken = '';
    // Use history.back() to trigger popstate, which restores reader if saved
    if (_manageSavedReader) { history.back(); return; }
    // null, not e: this is a close action, not link navigation — a modifier
    // held during the click must not make goHome defer to a native gesture.
    goHome(null); return;
  }
  enterManage(e);
}

function _restoreSavedReader() {
  var s = _manageSavedReader;
  if (!s) return false;
  _manageSavedReader = null;
  mode = 'home'; // restore mode from manage
  readerOpen = true;
  currentArticle = s.currentArticle;
  articleHistory = s.articleHistory;
  readerSource = s.readerSource;
  currentSource = s.currentSource;
  _articleLangData = s.langData;
  _articleLangKey = s.langKey;
  var reader = document.getElementById('reader');
  reader.classList.add('open');
  mainView.classList.add('hidden');
  document.documentElement.style.overflowY = 'hidden';
  updateTopbar();
  _setWindowTitle(s.windowTitle || (currentArticle && currentArticle.title) || 'Zimi');
  return true;
}

async function enterManage(e, section) {
  if (e && e.preventDefault) e.preventDefault();
  if (!manageEnabled) {
    // The gear must respond from first paint. On a large library the boot's
    // /list call blocks for seconds, and if the user clicks before the
    // manage-auth probe has set manageEnabled we must not leave the button
    // dead (#44). Resolve the probe on demand (cheap, lock-free endpoint) and
    // only bail if management is genuinely disabled.
    if (_manageProbed) { _dropManageBoot(); return; }   // probe finished: disabled
    if (!_manageProbe) _manageProbe = _probeManageAuth();
    await _manageProbe;
    if (!manageEnabled) { _dropManageBoot(); return; }  // resolved to disabled
  }
  // Decide which settings section to land on: an explicit arg (deep link /
  // ?manage=<section>) wins, else a section a caller already staged in
  // _pendingMsSection (e.g. Reorder → preferences), else the last one used
  // this session, else Library. renderManage honors _pendingMsSection.
  var _msTarget = _validMsSection(section) || _pendingMsSection || _lastMsSection() || 'library';
  _pendingMsSection = _msTarget;
  // Manage is reachable from the Create page's ⋯ menu. Create is a full-page
  // surface that hides #main-view — left open, Manage renders under a dead
  // Create page (Eric, mobile: "go to manage from create view it doesn't
  // load right"). closeCreate no-ops when the surface is down.
  if (_createOpen && typeof closeCreate === 'function') {
    try { closeCreate(); } catch (err) {}
  }
  // The History/Bookmarks side panel floats over the right edge; close it so
  // it doesn't overlap and truncate the full Manage view.
  _closeLibraryPanel();
  // Save reader state so back navigation can restore the article
  if (readerOpen) {
    _manageSavedReader = {
      currentArticle: currentArticle,
      articleHistory: articleHistory.slice(),
      readerSource: readerSource,
      currentSource: currentSource,
      langData: _articleLangData,
      langKey: _articleLangKey,
      windowTitle: document.title
    };
    // Hide reader visually but keep iframe loaded
    _ttsStop(); // stop read-aloud — the reader (and its stop button) is now hidden
    readerOpen = false;
    document.getElementById('reader').classList.remove('open');
    mainView.classList.remove('hidden');
    document.documentElement.style.overflowY = 'auto';
  } else {
    _manageSavedReader = null;
  }
  mode = 'manage';
  manageTab = 'settings';  // settings greet you; library tabs one tap away
  currentSource = null;
  readerSource = null;
  sourceAutoReader = false;
  q.value = '';
  statsBar.style.display = 'none';
  pillsBar.innerHTML = ''; pillsBar.style.display = 'none'; pillsBar.className = 'pills';
  searchMeta.style.display = 'none';
  sourceHeaderEl.style.display = 'none';
  hideSuggest();
  history.pushState({ mode: 'manage' }, '', _msSectionUrl(_msTarget));
  updateTopbar();
  renderManage();
  // Manage is now painted in #main-view — drop the cold-boot gate so it shows
  // (no-op on the normal in-SPA path, where the class was never set).
  document.documentElement.classList.remove('manage-boot');
  // Warm the Creator inventory while the user reads whatever section greeted
  // them, so opening the Creator tab is instant instead of waiting on the walk
  // (#47). _creatorLoadInventory caches for the session and its DOM fill no-ops
  // until the Creator pane is actually on screen.
  if (typeof _creatorLoadInventory === 'function') _creatorLoadInventory();
}

// Reveal the library after a cold boot into ?manage that resolved to "you may
// not manage": the manage-boot gate was hiding #main-view, so drop it and paint
// home. A no-op when the gate was never set (the normal in-SPA path).
function _dropManageBoot() {
  if (!document.documentElement.classList.contains('manage-boot')) return;
  document.documentElement.classList.remove('manage-boot');
  enterHome(false);
}

let manageTab = 'installed';
let manageCategoryFilter = null;
let manageLangFilter = null;
let catalogPage = 0;
let _catalogObserver = null;
let _catalogTotal = 0;
let _dlTimer = null;

// ── Browse gallery data layer ──
let _catalogCache = null;      // All catalog items (fetched once)
let _browseView = 'gallery';   // 'gallery' | 'drilldown' | 'search'
let _availableUpdates = {};    // keyed by installed filename → update info
let _mergedToOther = new Set(); // categories merged into Other (< MIN_BROWSE_CAT items)
var _pendingDrill = null; // { catKey, lang } — set by _langBannerDownload to drill on first render

// UI language codes match catalog codes (both ISO 639-1 two-letter)
// Shared language pill renderer — used by both Installed and Catalog tabs
// counts: {langCode: n}, onclick: function name, validSet: optional Set of valid lang codes (others dimmed)
function _renderLangPills(counts, onclick, validSet) {
  var langs = Object.keys(counts).filter(_isValidLangCode).sort(function(a, b) { return (counts[b] || 0) - (counts[a] || 0); });
  if (langs.length < 2) return '';
  if (_getStorageFlag(SK.HIDE_LANG_CHOOSER)) return '';
  var searchSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path stroke-linecap="round" d="m21 21-4.3-4.3"/></svg>';
  var h = '<div class="catalog-lang-row" oncontextmenu="_langChooserCtxMenu(event)">' +
    '<div class="catalog-lang-search-btn" onclick="_toggleLangSearch(this)" title="' + tH('filter_languages') + '">' + searchSvg + '</div>' +
    '<div class="catalog-lang-scroll" id="catalog-lang-scroll">';
  for (var j = 0; j < langs.length; j++) {
    var lc = langs[j];
    var name = _langDisplayName(lc) || lc;
    var active = manageLangFilter === lc;
    var dimmed = validSet && !validSet.has(lc);
    var count = counts[lc] || 0;
    h += '<button class="pill' + (active ? ' active' : '') + (dimmed ? ' dimmed' : '') +
      '" data-lang="' + escAttr(lc) + '" data-lang-name="' + escAttr(name.toLowerCase()) + '"' +
      ' onclick="' + onclick + '(\'' + escAttr(lc) + '\')">' +
      esc(name) + ' <span class="pill-count">' + count + '</span></button>';
  }
  h += '</div></div>';
  return h;
}

function _toggleLangSearch(btn) {
  if (btn.classList.contains('expanded')) {
    btn.classList.remove('expanded');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path stroke-linecap="round" d="m21 21-4.3-4.3"/></svg>';
    // Show all pills again
    var scroll = btn.nextElementSibling;
    if (scroll) Array.from(scroll.children).forEach(function(p) { p.style.display = ''; });
    return;
  }
  btn.classList.add('expanded');
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><circle cx="11" cy="11" r="8"/><path stroke-linecap="round" d="m21 21-4.3-4.3"/></svg>' +
    '<input type="text" placeholder="' + tH('filter_generic') + '" oninput="_filterLangPills(this)" autofocus>';
  var inp = btn.querySelector('input');
  if (inp) { inp.focus(); inp.addEventListener('click', function(e) { e.stopPropagation(); }); }
}

function _langChooserCtxMenu(e) {
  e.preventDefault();
  // Show a small popup with "Hide Language Chooser" option
  var existing = document.getElementById('lang-chooser-ctx');
  if (existing) existing.remove();
  var div = document.createElement('div');
  div.id = 'lang-chooser-ctx';
  div.style.cssText = 'position:fixed;z-index:9999;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:4px 0;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-size:13px';
  div.style.left = e.clientX + 'px';
  div.style.top = e.clientY + 'px';
  div.innerHTML = '<div style="padding:8px 16px;cursor:pointer;color:var(--text2);white-space:nowrap" onmouseenter="this.style.background=\'var(--surface2)\'" onmouseleave="this.style.background=\'none\'" onclick="_hideLangChooser()">Hide language chooser</div>';
  document.body.appendChild(div);
  var dismiss = function() { div.remove(); document.removeEventListener('click', dismiss); };
  setTimeout(function() { document.addEventListener('click', dismiss); }, 0);
}

function _hideLangChooser() {
  localStorage.setItem(SK.HIDE_LANG_CHOOSER, '1');
  manageLangFilter = null;
  var ctx = document.getElementById('lang-chooser-ctx');
  if (ctx) ctx.remove();
  // Re-render the active view
  if (manageTab === 'installed') renderInstalled();
  else if (_browseView === 'drilldown' && manageCategoryFilter) drillCategory(manageCategoryFilter);
  else renderBrowseGallery();
}

function _filterLangPills(inp) {
  var val = inp.value.toLowerCase().trim();
  var scroll = inp.closest('.catalog-lang-row').querySelector('.catalog-lang-scroll');
  if (!scroll) return;
  Array.from(scroll.children).forEach(function(pill) {
    var langName = pill.getAttribute('data-lang-name') || '';
    var langCode = pill.getAttribute('data-lang') || '';
    pill.style.display = (!val || langName.indexOf(val) >= 0 || langCode.indexOf(val) >= 0) ? '' : 'none';
  });
}

// Normalize a single language code to 2-letter
function _normLang(c) {
  if (!c) return '';
  c = c.trim().toLowerCase();
  if (c === 'mul') return '';  // "multilingual" — skip, not a real language
  return _LANG3TO2[c] || c;   // Keep original if no mapping (don't truncate)
}

// Parse ZIM language string into array of normalized 2-letter codes
function _parseLangs(langStr) {
  if (!langStr) return [];
  return langStr.toLowerCase().split(',').map(function(c) {
    return _normLang(c);
  }).filter(Boolean);
}

// Check if ZIM matches a language filter (handles multilingual + mixed code lengths)
function _zimMatchesLang(item, lang) {
  if (lang) {
    var norm = _normLang(lang);
    return _parseLangs(item.language).indexOf(norm) >= 0;
  }
  // No explicit language pill selected — fall back to user prefs if set.
  var prefs = _getPrefLanguages();
  if (!prefs.length) return true;
  var langs = _parseLangs(item.language);
  for (var i = 0; i < prefs.length; i++) {
    if (langs.indexOf(_normLang(prefs[i])) >= 0) return true;
  }
  return false;
}

function _countLangsByCategory(items, catKey) {
  var counts = {};
  var knownKeys = new Set(BROWSE_CATEGORIES.map(function(c) { return c.key; }));
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (catKey) {
      var cat = item.category || 'other';
      if (catKey === 'other') { if (cat !== 'other' && knownKeys.has(cat) && !_mergedToOther.has(cat)) continue; }
      else if (cat !== catKey) continue;
    }
    var langs = _parseLangs(item.language);
    for (var j = 0; j < langs.length; j++) {
      counts[langs[j]] = (counts[langs[j]] || 0) + 1;
    }
  }
  return counts;
}

function filterCatalogLang(lang) {
  // Save lang pill scroll position before re-render
  var scrollEl = document.getElementById('catalog-lang-scroll');
  var savedScroll = scrollEl ? scrollEl.scrollLeft : 0;
  manageLangFilter = (manageLangFilter === lang) ? null : lang;
  // Don't clear _catalogCache — catalog data doesn't change, only the filter does.
  // Clearing it forces a server re-fetch (which can be rate-limited by Kiwix OPDS).
  if (_browseView === 'drilldown' && manageCategoryFilter) drillCategory(manageCategoryFilter);
  else if (_browseView === 'search') { var v = q.value.trim(); if (v) browseCatalogFilter(v); else renderBrowseGallery(); }
  else renderBrowseGallery();
  // Restore scroll position after re-render
  requestAnimationFrame(function() {
    var newScrollEl = document.getElementById('catalog-lang-scroll');
    if (newScrollEl) newScrollEl.scrollLeft = savedScroll;
  });
}

// ── Browse category gallery metadata ──
const BROWSE_CATEGORIES = [
  { key: 'wikipedia',      i18n: 'cat_encyclopedias',  icon: '\u{1F30D}', descKey: 'cat_encyclopedias_desc' },
  { key: 'stack_exchange', i18n: 'cat_qa',             icon: '\u{1F4AC}', descKey: 'cat_qa_desc' },
  { key: 'devdocs',        i18n: 'cat_devdocs',        icon: '\u{1F4BB}', descKey: 'cat_devdocs_desc' },
  { key: 'ted',            i18n: 'cat_video',          icon: '\u{1F3AC}', descKey: 'cat_video_desc' },
  { key: 'education',      i18n: 'cat_education',      icon: '\u{1F393}', descKey: 'cat_education_desc' },
  { key: 'gutenberg',      i18n: 'cat_books',          icon: '\u{1F4DA}', descKey: 'cat_books_desc' },
  { key: 'medical',        i18n: 'cat_medical',        icon: '\u{1FA7A}', descKey: 'cat_medical_desc' },
  { key: 'survival',       i18n: 'cat_survival',       icon: '\u{1F9ED}', descKey: 'cat_survival_desc' },
  { key: 'gaming',         i18n: 'cat_gaming',         icon: '\u{1F3AE}', descKey: 'cat_gaming_desc' },
  { key: 'other',          i18n: 'cat_other',          icon: '\u{1F4E6}', descKey: 'cat_other_desc' },
];

// Category key → localized display name
function _catDisplayName(key) {
  if (key === OTHER_CAT) return t('cat_other');  // the forced-Other sentinel reads as "Other"
  // Accept both BROWSE_CATEGORIES keys ('wikipedia') and English names ('Wikimedia')
  var browseKey = _CAT_TO_BROWSE_KEY[key] || key;
  var meta = BROWSE_CATEGORIES.find(function(c) { return c.key === browseKey; });
  return meta ? t(meta.i18n) : key;
}

// Language code → display name (handles ISO 639-1, 639-3, multi-lang, special codes)
var _langDisplayCache = {};
var _langDisplayCacheLang = '';
var _SPECIAL_LANG = { mul:'Multilingual', mis:'Other', und:'Unknown', zxx:'No language' };
// Fallback names for ISO 639-3 codes that Intl.DisplayNames doesn't handle
var _LANG3_NAMES = {
  stq:'Saterland Frisian',nds:'Low German',szl:'Silesian',lmo:'Lombard',scn:'Sicilian',
  vec:'Venetian',pms:'Piedmontese',nap:'Neapolitan',eml:'Emilian-Romagnol',lij:'Ligurian',
  frr:'North Frisian',bar:'Bavarian',ksh:'Colognian',pfl:'Palatinate German',als:'Alemannic',
  gsw:'Swiss German',wuu:'Wu Chinese',yue:'Cantonese',min:'Minangkabau',ace:'Acehnese',
  bjn:'Banjar',bug:'Buginese',gor:'Gorontalo',ban:'Balinese',bew:'Betawi',mad:'Madurese',
  nso:'Northern Sotho',ssw:'Swazi',tsn:'Tswana',xho:'Xhosa',ven:'Venda',tso:'Tsonga',
  nbl:'Southern Ndebele',sot:'Southern Sotho',din:'Dinka',lug:'Ganda',run:'Rundi',
  kin:'Kinyarwanda',nya:'Chichewa',sna:'Shona',wol:'Wolof',ful:'Fula',bam:'Bambara',
  orm:'Oromo',tir:'Tigrinya',som:'Somali',ibo:'Igbo',lin:'Lingala',twi:'Twi',
  ckb:'Central Kurdish',pnb:'Western Punjabi',arz:'Egyptian Arabic',azb:'South Azerbaijani',
  ceb:'Cebuano',war:'Waray',ilo:'Ilocano',bcl:'Central Bicolano',pag:'Pangasinan',
  tuk:'Turkmen',tat:'Tatar',bak:'Bashkir',chv:'Chuvash',sah:'Yakut',tyv:'Tuvan',
  kbd:'Kabardian',ady:'Adyghe',oss:'Ossetian',che:'Chechen',ava:'Avar',lez:'Lezgian',
  dag:'Dagbani',nia:'Nias',diq:'Zazaki',lad:'Ladino',roh:'Romansh',fur:'Friulian',
  ext:'Extremaduran',ast:'Asturian',arg:'Aragonese',oci:'Occitan',cos:'Corsican',
  srd:'Sardinian',ltz:'Luxembourgish',fry:'Western Frisian',bre:'Breton',glv:'Manx',
  gla:'Scottish Gaelic',cor:'Cornish',hak:'Hakka Chinese',gan:'Gan Chinese',
  cdo:'Min Dong',nan:'Min Nan',bho:'Bhojpuri',mai:'Maithili',mag:'Magahi',
  new:'Newari',dzo:'Dzongkha',div:'Divehi',mlt:'Maltese',hat:'Haitian Creole',
  pap:'Papiamento',tpi:'Tok Pisin',bis:'Bislama',smo:'Samoan',ton:'Tongan',
  fij:'Fijian',mri:'Maori',haw:'Hawaiian',cha:'Chamorro',mah:'Marshallese',
  chr:'Cherokee',nav:'Navajo',iku:'Inuktitut',kal:'Kalaallisut',que:'Quechua',
  aym:'Aymara',grn:'Guarani',sco:'Scots',nno:'Norwegian Nynorsk',nob:'Norwegian Bokmål',
  srn:'Sranan Tongo',jav:'Javanese',sun:'Sundanese',mlg:'Malagasy',tet:'Tetum',
  tah:'Tahitian',aar:'Afar',vol:'Volapük',ido:'Ido',ina:'Interlingua',
  epo:'Esperanto',lat:'Latin',san:'Sanskrit',pli:'Pali',bod:'Tibetan',zsm:'Malay',
  // Codes that Intl.DisplayNames can't resolve (from Kiwix OPDS catalog)
  ami:'Amis',blk:'Pa\'O',far:'Farsian',kbp:'Kabiyé',kld:'Gamilaraay',lbe:'Lak',
  lld:'Ladin',mnw:'Mon',nah:'Nahuatl',nhe:'Eastern Huasteca Nahuatl',nrf:'Jèrriais',
  olo:'Livvi-Karelian',pih:'Norfuk',pwn:'Paiwan',rmq:'Caló',roa:'Romance',
  szy:'Sakizaya',tay:'Atayal',tsz:'Purépecha',
  // Additional codes from Kiwix OPDS catalog
  hif:'Fiji Hindi',bpy:'Bishnupriya',pcm:'Nigerian Pidgin',fat:'Fanti',
  vls:'West Flemish',dsb:'Lower Sorbian',csb:'Kashubian',anp:'Angika',
  sgs:'Samogitian',alt:'Southern Altai',mhr:'Eastern Mari',frp:'Arpitan',
  udm:'Udmurt',crh:'Crimean Tatar',nqo:"N'Ko",ang:'Old English'
};
function _langDisplayName(code) {
  if (!code) return '';
  var uiLang = _currentLang || 'en';
  if (_langDisplayCacheLang !== uiLang) { _langDisplayCache = {}; _langDisplayCacheLang = uiLang; }
  if (_langDisplayCache[code]) return _langDisplayCache[code];
  // Special codes
  if (_SPECIAL_LANG[code]) { _langDisplayCache[code] = _SPECIAL_LANG[code]; return _SPECIAL_LANG[code]; }
  // Multi-language codes (TED talks etc.) → "Multilingual"
  if (code.includes(',')) { _langDisplayCache[code] = 'Multilingual'; return 'Multilingual'; }
  // Try Intl.DisplayNames: first with 2-letter mapping, then raw code
  var c2 = _LANG3TO2[code];
  var tries = c2 ? [c2, code] : [code];
  try {
    var dn = new Intl.DisplayNames([uiLang, 'en'], { type: 'language' });
    for (var i = 0; i < tries.length; i++) {
      try {
        var name = dn.of(tries[i]);
        if (name && name !== tries[i] && name !== code) { _langDisplayCache[code] = name; return name; }
      } catch(e2) {}
    }
  } catch(e) {}
  // Fallback: hardcoded name table for ISO 639-3 codes
  if (_LANG3_NAMES[code]) { _langDisplayCache[code] = _LANG3_NAMES[code]; return _LANG3_NAMES[code]; }
  // Last resort: capitalize
  _langDisplayCache[code] = code.toUpperCase();
  return _langDisplayCache[code];
}

// Filter out truly invalid language entries (empty, single char, numeric)
function _isValidLangCode(code) {
  return code && code.length >= 2 && /[a-z]/i.test(code);
}

// Language display: "Multilingual (24 langs)" or "French" instead of raw codes
const LANG_NAMES = {
  en:'English',fr:'French',de:'German',es:'Spanish',pt:'Portuguese',it:'Italian',
  ru:'Russian',ar:'Arabic',zh:'Chinese',ja:'Japanese',ko:'Korean',hi:'Hindi',
  tr:'Turkish',pl:'Polish',nl:'Dutch',sv:'Swedish',vi:'Vietnamese',th:'Thai',
  he:'Hebrew',el:'Greek',ro:'Romanian',hu:'Hungarian',fa:'Persian',id:'Indonesian',
  uk:'Ukrainian',cs:'Czech',da:'Danish',fi:'Finnish',no:'Norwegian',ca:'Catalan',
  mul:'Multilingual',
  // 3-letter fallbacks for any un-normalized legacy data
  eng:'English',fra:'French',deu:'German',spa:'Spanish',por:'Portuguese',ita:'Italian',
  rus:'Russian',ara:'Arabic',zho:'Chinese',jpn:'Japanese',kor:'Korean',hin:'Hindi',
  heb:'Hebrew'
};
function formatLanguage(langStr) {
  if (!langStr) return '';
  const codes = langStr.toLowerCase().split(',').map(c => c.trim()).filter(Boolean);
  if (codes.length === 0) return '';
  if (codes.length === 1) {
    if (codes[0] === 'en' || codes[0] === 'eng') return ''; // Don't show English when it's the only language
    return LANG_NAMES[codes[0]] || _langDisplayName(codes[0]) || codes[0].toUpperCase();
  }
  // Multilingual
  if (codes.length <= 3) return codes.map(c => LANG_NAMES[c] || _langDisplayName(c) || c.toUpperCase()).join(', ');
  return t('multilingual', {n: codes.length});
}

// 3-letter → 2-letter language code for tags
const _LANG3TO2 = {eng:'en',fra:'fr',deu:'de',spa:'es',por:'pt',ita:'it',rus:'ru',ara:'ar',zho:'zh',jpn:'ja',kor:'ko',hin:'hi',tur:'tr',pol:'pl',nld:'nl',swe:'sv',vie:'vi',tha:'th',heb:'he',ell:'el',ron:'ro',hun:'hu',fas:'fa',far:'fa',ind:'id',ukr:'uk',ces:'cs',dan:'da',fin:'fi',nor:'no',cat:'ca',mul:'mul',msa:'ms',ben:'bn',tam:'ta',tel:'te',urd:'ur',srp:'sr',hrv:'hr',bos:'bs',slk:'sk',slv:'sl',bul:'bg',lit:'lt',lav:'lv',est:'et',swa:'sw',amh:'am',hau:'ha',yor:'yo',zul:'zu',afr:'af',gle:'ga',cym:'cy',eus:'eu',glg:'gl',kat:'ka',hye:'hy',mkd:'mk',sqi:'sq',bel:'be',kaz:'kk',uzb:'uz',tgl:'tl',mal:'ml',kan:'kn',guj:'gu',mar:'mr',mya:'my',khm:'km',lao:'lo',sin:'si',nep:'ne',pan:'pa',aze:'az',mon:'mn',tgk:'tg',kir:'ky',isl:'is',fao:'fo',kur:'ku',ori:'or',jav:'jv',sun:'su',asm:'as',snd:'sd',kas:'ks',kik:'ki',sme:'se',lim:'li',pam:'pam',tir:'ti',lin:'ln',wol:'wo',som:'so',run:'rn',bis:'bi',nav:'nv',dzo:'dz',vol:'vo',ina:'ia',tat:'tt',bak:'ba',chv:'cv',oss:'os',tuk:'tk',sah:'sah'};
// Extract actual language from ZIM name when catalog says "mul" or comma-separated
// e.g. "ted_fr_design" → "fr", "wikipedia_de_all" → "de"
function _langFromName(name) {
  if (!name) return '';
  var parts = name.toLowerCase().split('_');
  if (parts.length >= 2) {
    var code = parts[1];
    if (code.length === 2 && /^[a-z]{2}$/.test(code) && code !== 'en') return code;
    if (code.length === 3 && _LANG3TO2[code] && _LANG3TO2[code] !== 'en') return _LANG3TO2[code];
  }
  return '';
}
function _catLangTag(langStr, itemName) {
  if (!langStr) return '';
  var codes = langStr.toLowerCase().split(',').map(c => c.trim()).filter(Boolean);
  if (codes.length === 0 || (codes.length === 1 && (codes[0] === 'en' || codes[0] === 'eng'))) return '';
  // 'all' = language-agnostic content — an "ALL" tag conveys nothing.
  if (codes.length === 1 && codes[0] === 'all') return '';
  // For multilingual items (TED, etc.), try to extract actual language from name
  if (codes.length > 1 || codes[0] === 'mul') {
    var nameLang = _langFromName(itemName);
    if (nameLang) return '<span class="ci-lang-tag">' + esc(_langDisplayName(nameLang)) + '</span>';
  }
  if (codes.length === 1) {
    var c2 = _LANG3TO2[codes[0]] || codes[0];
    return '<span class="ci-lang-tag">' + esc(_langDisplayName(c2)) + '</span>';
  }
  // Multilingual — show "Multilingual" tag
  if (codes.length > 3) return '<span class="ci-lang-tag">' + esc(t('multilingual', {n: codes.length})) + '</span>';
  return codes.map(c => {
    var c2 = _LANG3TO2[c] || c;
    return '<span class="ci-lang-tag">' + esc(_langDisplayName(c2)) + '</span>';
  }).join('');
}

// OPDS category → browse category mapping (case-insensitive)
// All 17 known OPDS categories mapped to our 9 browse categories
const _OPDS_CAT_MAP = {
  'wikipedia':'wikipedia', 'wikibooks':'wikipedia', 'wikiquote':'wikipedia',
  'wikisource':'wikipedia', 'wikiversity':'wikipedia', 'wikinews':'wikipedia',
  'wikivoyage':'wikipedia', 'wiktionary':'wikipedia', 'vikidia':'wikipedia',
  'stack_exchange':'stack_exchange',
  'ted':'ted',
  'gutenberg':'gutenberg',
  'mooc':'education', 'phet':'education',
  'ifixit':'education',  // iFixit, WikiHow → Education & How-To
};

function autoCategorize(item) {
  const cat = (item.category || '').toLowerCase();
  const n = (item.name || '').toLowerCase();
  // 1. Map known OPDS categories (covers ~730 of 1074 items)
  if (_OPDS_CAT_MAP[cat]) return _OPDS_CAT_MAP[cat];
  // 2. For empty/other categories, classify by name (~344 items)
  // Wikipedia family
  if (/^wiki[a-z]|^wikt|mediawiki|openstreetmap-wiki/.test(n)) return 'wikipedia';
  // Dev & tech docs
  if (n.startsWith('devdocs_') || n.startsWith('coreyms_')) return 'devdocs';
  if (/freecodecamp|mdn_|^docs\.|^peps\.|php\.net|archlinux|alpinelinux/.test(n)) return 'devdocs';
  if (/gentoo|termux|postmarketos|neos-wiki|unrealircd|bitcoin|cheatography/.test(n)) return 'devdocs';
  if (/devhints|cloudflare|getbootstrap|gobyexample|dart\.dev|lesscss/.test(n)) return 'devdocs';
  if (/lua\.org/.test(n)) return 'devdocs';
  // Q&A
  if (/stackoverflow|stackexchange|askubuntu|superuser|serverfault/.test(n)) return 'stack_exchange';
  // Education (broad — catches tutorials, courses, how-to, reference)
  if (/libretexts|crashcourse|phet|khan|openstax|coursera|explainxkcd/.test(n)) return 'education';
  if (/planetmath|mspeekenbrink|voa_learning|prunelle|bogleheads|finiki/.test(n)) return 'education';
  if (/citizendium|metakgp|appropedia|internet-encyclopedia|artofproblemsolving/.test(n)) return 'education';
  if (/edutechwiki|womenshistory|chopin\.lib|hitchwiki|football/.test(n)) return 'education';
  if (/biology|statistic|stats|learning|genomics|energypedia|proofwiki|ethanweed/.test(n)) return 'education';
  if (/stacks\.math|ncase\.me|encyclopedie|diksha|ghana-bece|ncert/.test(n)) return 'education';
  if (/ifixit|wikihow|cooking|publicdomainrecipes/.test(n)) return 'education';
  if (/mutopia|blender\.org|theworldfactbook/.test(n)) return 'education';
  // Books & literature
  if (/gutenberg|booksdash|xkcd/.test(n)) return 'gutenberg';
  // TED & video
  if (/^ted_/.test(n)) return 'ted';
  // Medical
  if (/medicine|medlineplus|mdwiki|librepathology|wikem|cdc\.gov|skin-of-color/.test(n)) return 'medical';
  // Survival & preparedness
  if (/zimgit-|ready\.gov|survivorlibrary|urban-prepper|solar\.lowtech/.test(n)) return 'survival';
  if (/canadian_prep|armypubs|cd3wd|selfreliance|s2underground|usda-2015/.test(n)) return 'survival';
  // Gaming & fandom
  if (/dandwiki|evageeks|frackinuniverse|granbluefantasy/.test(n)) return 'gaming';
  if (/the_infosphere|zdoom|westeros/.test(n)) return 'gaming';
  if (/minecraft|pokemon|bulba|stardew|rimworld|riskofrain|whitewolf/.test(n)) return 'gaming';
  return 'other';
}

var _catalogStaleAt = 0; // >0: catalog served from stale/offline cache (epoch s)

// Stale-while-revalidate: when the server serves a stale catalog it kicks a
// background refresh against Kiwix. We poll once the refresh should have
// landed and quietly repaint if the data changed. One poller at a time.
var _catalogRevalidating = false;
var CATALOG_REVALIDATE_MS = 5000;   // let the server's background refresh land
var CATALOG_REVALIDATE_TRIES = 4;   // ~20s of polling, then wait for next visit

function _scheduleCatalogRevalidate() {
  if (_catalogRevalidating) return;
  _catalogRevalidating = true;
  var tries = 0;
  var poll = async function() {
    tries++;
    var done = false;
    try {
      var res = await manageFetch('/manage/catalog?lang=&count=500&start=0');
      var data = await res.json();
      if (!data.error && !data.stale) {
        // Fresh copy is ready — rebuild the full catalog and quietly repaint
        // the current view (only if the user hasn't scrolled away).
        _catalogCache = null;
        _catalogStaleAt = 0;
        await loadFullCatalog();
        _rerenderCatalogIfSafe();
        done = true;
      }
    } catch (e) { /* transient — retry or give up */ }
    if (!done && tries < CATALOG_REVALIDATE_TRIES) setTimeout(poll, CATALOG_REVALIDATE_MS);
    else _catalogRevalidating = false;
  };
  setTimeout(poll, CATALOG_REVALIDATE_MS);
}

function _rerenderCatalogIfSafe() {
  if (manageTab !== 'browse') return; // user left — cache is fresh for next visit
  var results = document.getElementById('catalog-results');
  if (!results) return;
  // Don't yank the page mid-scroll — only repaint at/near the top, which is
  // the just-landed case where the stale copy was shown.
  var sc = document.scrollingElement || document.documentElement;
  if ((sc && sc.scrollTop > 60) || results.scrollTop > 60) return;
  if (_browseView === 'drilldown' && manageCategoryFilter) drillCategory(manageCategoryFilter);
  else if (_browseView === 'search') { var v = q.value.trim(); if (v) browseCatalogFilter(v); else renderBrowseGallery(); }
  else renderBrowseGallery();
}

function _catalogStaleNote() {
  if (!_catalogStaleAt) return '';
  var when = new Date(_catalogStaleAt * 1000).toLocaleDateString();
  return '<div class="ms-hint" style="text-align:center;margin:4px 0 10px">' +
    tH('catalog_offline_note', {d: when}) + '</div>';
}

// Session-persisted catalog so a page reload / PWA relaunch paints the library
// instantly instead of blocking on a fresh OPDS fetch. Bumped suffix = format
// change (clears old copies). Revalidation runs once per page load.
const CATALOG_SESSION_KEY = 'zimi_catalog_v1';
let _catalogSessionRevalidated = false;

// Fetch the full catalog from the server (all pages), auto-categorized but not
// yet enriched. Returns { items, stale, fetchedAt }. Shared by the cold load
// and the session-cache revalidation so the paging/categorize logic lives once.
async function _fetchCatalogItems() {
  // No server-side lang filter — Kiwix OPDS uses 3-letter ISO 639-3 codes but
  // our UI uses 2-letter codes; language filtering happens client-side.
  const res = await manageFetch('/manage/catalog?lang=&count=500&start=0');
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const total = data.total || 0;
  let items = data.items || [];
  if (total > 500) {
    const fetches = [];
    for (let start = 500; start < total; start += 500) {
      fetches.push(
        manageFetch('/manage/catalog?lang=&count=500&start=' + start)
          .then(r => r.json()).then(d => d.items || [])
      );
    }
    const pages = await Promise.all(fetches);
    for (const page of pages) items.push(...page);
  }
  for (const item of items) item.category = autoCategorize(item);
  return { items: items, stale: !!data.stale, fetchedAt: data.stale ? (data.fetched_at || 0) : 0 };
}

// Enrich in place: installed flags, hierarchy, peer availability, name index.
function _enrichCatalogItems(items) {
  _enrichCatalogInstalled(items);
  _enrichCatalogHierarchy(items);
  _enrichCatalogPeers(items);
  _catalogInstalledNames = new Set(items.filter(it => it.installed).map(it => it.name));
}

// Persist a catalog copy for instant paint on the next page load. Enrichment
// (installed/peer state) is recomputed on hydrate against the live library, so
// storing the fetched items is enough. Best-effort — quota/disabled is fine.
function _saveCatalogSession(items) {
  try { sessionStorage.setItem(CATALOG_SESSION_KEY, JSON.stringify(items)); }
  catch (e) { /* cache is a nicety, not a requirement */ }
}

// Populate _catalogCache synchronously from sessionStorage if it's empty, so
// the catalog views can skip their cold spinner and render instantly. Kicks a
// single background revalidation to catch any change since the copy was saved.
// Returns true when the in-memory cache is now populated.
function _ensureCatalogHydrated() {
  if (_catalogCache) return true;
  let items;
  try {
    const raw = sessionStorage.getItem(CATALOG_SESSION_KEY);
    if (!raw) return false;
    items = JSON.parse(raw);
  } catch (e) { return false; }
  if (!Array.isArray(items) || !items.length) return false;
  _enrichCatalogItems(items);
  _catalogCache = items;
  _kickPeerEnrichment();
  _revalidateSessionCatalog();
  return true;
}

// One background refresh after a session-cache hydrate: fetch fresh, rebuild,
// and quietly repaint (at-top-only, via _rerenderCatalogIfSafe). Runs once.
function _revalidateSessionCatalog() {
  if (_catalogSessionRevalidated) return;
  _catalogSessionRevalidated = true;
  setTimeout(async function() {
    try {
      const fresh = await _fetchCatalogItems();
      _catalogStaleAt = fresh.stale ? fresh.fetchedAt : 0;
      _enrichCatalogItems(fresh.items);
      _catalogCache = fresh.items;
      if (!fresh.stale) _saveCatalogSession(fresh.items);
      _rerenderCatalogIfSafe();
      if (fresh.stale) _scheduleCatalogRevalidate();
    } catch (e) { /* offline — keep the hydrated copy */ }
  }, 0);
}

// Kick off peer-list discovery in the background. When it lands, enrich +
// re-render whichever catalog view is current.
function _kickPeerEnrichment() {
  _loadPeerData().then(loaded => {
    if (!loaded || !_catalogCache) return;
    _enrichCatalogPeers(_catalogCache);
    if (manageTab === 'browse') {
      if (_browseView === 'drilldown' && manageCategoryFilter) drillCategory(manageCategoryFilter);
      else if (_browseView !== 'gallery') return; // search view re-renders on its own
      else renderBrowseGallery();
    }
  }).catch(() => {});
}

async function loadFullCatalog() {
  if (_catalogCache) return _catalogCache;

  const { items, stale, fetchedAt } = await _fetchCatalogItems();
  // Offline: server returned its last-good catalog — note it quietly
  _catalogStaleAt = stale ? fetchedAt : 0;
  _enrichCatalogItems(items);
  _catalogCache = items;
  if (!stale) _saveCatalogSession(items);
  // Server served a stale copy and is revalidating against Kiwix — poll once
  // the refresh should have landed and quietly repaint if the data changed.
  if (stale) _scheduleCatalogRevalidate();
  _kickPeerEnrichment();
  return _catalogCache;
}

let _catalogInstalledNames = new Set();

// LAN peer awareness: maps catalog name (or stripped filename stem) to
// list of peer names that have it. Populated lazily by _loadPeerData
// after catalog loads. Empty when no peers / not yet loaded.
let _catalogPeerStems = new Map();  // stem → [peerName, ...]  (display)
let _catalogPeerFiles = new Map();  // stem → [{peer, file, size}]  (download)
// Everything every peer advertises, flat. Feeds the "Nearby" catalog section:
// peer ZIMs that match NO catalog item (bookmark exports, custom imports)
// would otherwise be invisible — the stem maps above only annotate items the
// Kiwix catalog already knows about.
let _peerZimEntries = [];           // [{peer, file, size, title, export, stems:[...]}]
let _peerMatchedStems = new Set();  // stems _enrichCatalogPeers found a catalog item for
let _peersLoadedAt = 0;
const PEER_LIST_REFRESH_MS = 60_000;

async function _loadPeerData() {
  // Don't refresh more than once a minute. Returns true on first-time
  // load (caller may want to re-render); false otherwise.
  if (Date.now() - _peersLoadedAt < PEER_LIST_REFRESH_MS && _peersLoadedAt > 0) {
    return false;
  }
  // Skip peer discovery on a protected server until the operator is logged
  // in. Callers retry periodically, so before the bootstrap auth probe
  // exists just decline — never fetch unprobed.
  if (!_manageProbe) return false;
  try { await _manageProbe; } catch (e) {}
  if (!_canPollManage()) return false;
  let peers = [];
  try {
    const r = await authedFetch('/manage/peers');
    if (!r.ok) return false;
    const d = await r.json();
    peers = d.peers || [];
  } catch (e) {
    return false;
  }
  const newMap = new Map();
  const newFiles = new Map();
  const newEntries = [];
  if (!peers.length) {
    _catalogPeerStems = newMap;
    _catalogPeerFiles = newFiles;
    _peerZimEntries = newEntries;
    _peersLoadedAt = Date.now();
    return false;
  }
  await Promise.all(peers.map(async p => {
    try {
      const lr = await manageFetch('/manage/peers/list?peer=' + encodeURIComponent(p.name));
      if (!lr.ok) return;
      const ld = await lr.json();
      for (const z of (ld.list || [])) {
        const file = z.file || '';
        const fb = file.replace(/\.zim$/, '');
        // Strip date and (optionally) flavor so the stem matches the
        // catalog item's `name` field (e.g. wikipedia_ce_all_nopic_2026-01
        // → wikipedia_ce_all).
        const dated = fb.replace(/_\d{4}-\d{2}$/, '');
        const stem = dated.replace(/_(maxi|nopic|mini)$/, '');
        if (!stem) continue;
        // Index BOTH the flavor-stripped stem and the dated form so
        // either match path in _enrichCatalogPeers will hit. Names drive
        // the "📡 has it" pill; entries carry the exact file + peer so the
        // pill can pull it directly over the LAN.
        const entry = {peer: p.name, file: file, size: z.size_bytes};
        for (const key of [stem, dated]) {
          if (!newMap.has(key)) newMap.set(key, []);
          if (!newMap.get(key).includes(p.name)) newMap.get(key).push(p.name);
          if (!newFiles.has(key)) newFiles.set(key, []);
          if (file) newFiles.get(key).push(entry);
        }
        if (file) {
          newEntries.push({
            peer: p.name, file: file, size: z.size_bytes,
            title: z.title || z.name || fb,
            export: !!z.zimi_export,
            stems: [stem, dated],
          });
        }
      }
    } catch (_) {}
  }));
  _catalogPeerStems = newMap;
  _catalogPeerFiles = newFiles;
  _peerZimEntries = newEntries;
  _peersLoadedAt = Date.now();
  return true;
}

function _enrichCatalogPeers(items) {
  _peerMatchedStems = new Set();
  if (!_catalogPeerStems.size) {
    for (const it of items) { it.peer_names = []; it.peer_entries = []; }
    return;
  }
  for (const it of items) {
    const candidates = [it.name];
    if (it.download_url) {
      const fname = it.download_url.split('/').pop()
        .replace(/\.meta4$/, '').replace(/\.zim$/, '');
      const urlStem = fname.replace(/_\d{4}-\d{2}$/, '');
      if (urlStem && urlStem !== it.name) candidates.push(urlStem);
    }
    let names = [];
    let entries = [];
    for (const c of candidates) {
      const hit = _catalogPeerStems.get(c);
      if (hit && hit.length) {
        names = hit;
        entries = _catalogPeerFiles.get(c) || [];
        _peerMatchedStems.add(c);
        break;
      }
    }
    it.peer_names = names;
    it.peer_entries = entries;
  }
}

// Peer ZIMs the Kiwix catalog knows nothing about, grouped by file across
// peers. This is how another device's bookmark exports (or custom imports)
// surface here at all. Files already in the local library are kept but
// badged installed, matching how catalog rows treat what you have.
function _peerOnlyEntries() {
  if (!_peerZimEntries.length) return [];
  const localFiles = new Set((zimsCache || []).map(z => z.file));
  const byFile = new Map();
  for (const e of _peerZimEntries) {
    if (e.stems.some(s => _peerMatchedStems.has(s))) continue;
    let g = byFile.get(e.file);
    if (!g) {
      g = {file: e.file, title: e.title, size: e.size, export: e.export,
           peers: [], installed: localFiles.has(e.file)};
      byFile.set(e.file, g);
    }
    if (!g.peers.includes(e.peer)) g.peers.push(e.peer);
  }
  return [...byFile.values()]
    .sort((a, b) => (a.title || a.file).localeCompare(b.title || b.file));
}

// "Nearby" catalog section: rows for peer-only ZIMs, pullable over the LAN
// via the same /manage/download-from-peer path the peer pills use. Empty
// string when every advertised file matched a catalog item (the common case).
function _nearbyPeerSectionHtml() {
  const entries = _peerOnlyEntries();
  if (!entries.length) return '';
  let rows = '';
  for (const e of entries) {
    const peerNames = e.peers.map(p => p.replace(/^zimi-/, '')).join(', ');
    const action = e.installed
      ? '<span class="ci-installed-badge">' + tH('installed_badge') + '</span>'
      : '<button class="ci-add-btn" onclick="event.stopPropagation();_downloadFromPeer(\'' +
          escJs(e.peers[0]) + '\', \'' + escJs(e.file) + '\')">' +
          // _fmtBytes, not formatSize: exports are typically well under the
          // 1 MB floor formatSize rounds to ("Download 0 MB" reads broken).
          (e.size ? tH('download_size', {size: esc(_fmtBytes(e.size))}) : tH('download')) +
        '</button>';
    rows += '<div class="catalog-item" style="margin-bottom:4px">' +
      '<div class="ci-icon" style="width:32px;text-align:center;display:flex;align-items:center;justify-content:center;color:var(--text2)">' +
        (e.export ? '🔖' : '📡') + '</div>' +
      '<div class="ci-info" style="flex:1;min-width:0">' +
        '<div class="ci-title" style="font-size:13px">' + esc(e.title) + '</div>' +
        '<div class="ci-meta"><span>' + tH('nearby_on_device', {peers: esc(peerNames)}) + '</span></div>' +
      '</div>' +
      '<div class="ci-actions">' + action + '</div>' +
    '</div>';
  }
  return '<div class="featured-section" style="padding:0 0 8px">' +
    '<div class="ci-section-label">📡 ' + tH('nearby_section') + '</div>' +
    rows +
  '</div>';
}

function _peerHint(item) {
  const peers = item && item.peer_names;
  if (!peers || !peers.length) return '';
  // Strip the "zimi-" prefix for readability ("zimi-elpnas" → "elpnas").
  const names = peers.map(p => p.replace(/^zimi-/, ''));
  // A busy network could have many peers with the same ZIM — collapse to
  // "{n} nearby" on the pill; the tooltip keeps the full list.
  const fullList = names.join(', ');
  const display = names.length > 1 ? t('n_nearby', {n: names.length}) : names[0];
  // Already installed? Show the pill but don't re-trigger a download.
  if (item.installed) {
    return '<span class="ci-peer-pill" title="' + escAttr(t('peer_has_zim', {peers: fullList})) + '">' +
      '<span aria-hidden="true">📡</span>' + esc(display) + '</span>';
  }
  // Not installed and a peer has it → pull the actual file straight from the
  // peer over the LAN (works fully offline). Pick the best-flavor file among
  // the peer's entries (full > nopic > mini, modulated by user preference).
  const entries = (item.peer_entries || []).filter(e => e && e.file);
  if (!entries.length) {
    return '<span class="ci-peer-pill" title="' + escAttr(t('peer_has_zim', {peers: fullList})) + '">' +
      '<span aria-hidden="true">📡</span>' + esc(display) + '</span>';
  }
  const best = entries.slice().sort((a, b) => _flavorOrder(b.file) - _flavorOrder(a.file))[0];
  return '<button type="button" class="ci-peer-pill ci-peer-pill-clickable" ' +
    'title="' + escAttr(t('peer_pill_click_tip', {peers: fullList})) + '" ' +
    'aria-label="' + escAttr(t('peer_pill_click_tip', {peers: fullList})) + '" ' +
    'onclick="event.stopPropagation();_downloadFromPeer(\'' + escJs(best.peer) + '\', \'' + escJs(best.file) + '\')">' +
    '<span aria-hidden="true">📡</span>' + esc(display) + '</button>';
}

async function _downloadFromPeer(peerName, file) {
  // Pull the ZIM directly from the LAN peer over HTTP — no internet/Kiwix
  // needed. The server resolves peer→host:port from discovery state; we only
  // pass the peer name + file.
  const shortPeer = (peerName || '').replace(/^zimi-/, '');
  try {
    const res = await manageFetch('/manage/download-from-peer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peer: peerName, file: file }),
    });
    const data = await res.json();
    if (data.error) {
      if (typeof _showToast === 'function') _showToast(t('error') + ': ' + data.error);
      return;
    }
    if (typeof _showToast === 'function') {
      _showToast(t('downloading_from_peer', {peer: shortPeer}));
    }
    _dlPrevAllDone = false;
    _dlRecentStart = Date.now();
    _showManageBadge(true, 1);
    refreshDownloads();
    if (window._nudgeActivityPoll) window._nudgeActivityPoll();
  } catch (e) {
    if (typeof _showToast === 'function') _showToast(t('error'));
  }
}

function _hierarchyHint(item) {
  const h = item && item.hierarchy;
  if (!h) return '';
  // Subset whose bundle the user already has → reassure them.
  const installedBundle = (h.is_subset_of || []).find(n => _catalogInstalledNames.has(n));
  if (installedBundle) {
    return '<span class="ci-hier-installed" title="' + escAttr(installedBundle) + '">' +
      tH('covered_by', {name: esc(installedBundle)}) + '</span>';
  }
  // Subset whose bundle is uninstalled → flag the larger option.
  if (h.is_subset_of && h.is_subset_of.length) {
    return '<span class="ci-hier-subset" title="' + escAttr(h.is_subset_of.join(', ')) + '">' +
      tH('part_of', {name: esc(h.is_subset_of[0])}) + '</span>';
  }
  // Bundle that supersedes others.
  if (h.supersedes && h.supersedes.length) {
    let badges = '<span class="ci-hier-bundle">' +
      tH('includes_n_variants', {n: h.supersedes.length}) + '</span>';
    // Coverage signal: bundle has more articles than sum of subsets.
    if (h.coverage_advantage_bundle) {
      badges += ' <span class="ci-hier-coverage" title="' + escAttr(t('coverage_advantage_explain')) + '">' +
        tH('coverage_advantage') + '</span>';
    }
    // Freshness signal: subsets are newer than this bundle — the user might
    // want a subset for the latest content even though the bundle is bigger.
    if (h.freshness_advantage_subsets && h.freshness_advantage_subsets.length) {
      badges += ' <span class="ci-hier-freshness" title="' + escAttr(h.freshness_advantage_subsets.join(', ')) + '">' +
        tH('freshness_advantage', {n: h.freshness_advantage_subsets.length}) + '</span>';
    }
    return badges;
  }
  return '';
}

// Mirror of zimi/catalog_hierarchy.py:bundle_relationships in JS.
// Runs over the merged full catalog so relationships can cross pagination.
// Keep these constants in lockstep with catalog_hierarchy.py — drift = bugs.
const _DATE_RE = /(\d{4})-(\d{2})/;
const _DATE_TOKEN_RE = /^\d{4}-\d{2}$/;
const _BUNDLE_RE = /(?:^|_)all(_.*)?$/;
// Quality/display suffixes that can follow `_all` and still be a universal bundle.
// Topic-specific names like `angular.js` or `cheatography` are NOT display variants.
const _DISPLAY_VARIANTS = new Set(['maxi', 'mini', 'nopic', 'novid', 'nodet']);

function _hierarchyName(name) {
  const lower = (name || '').toLowerCase();
  const m = lower.match(_BUNDLE_RE);
  if (!m) return false;
  if (!m[1]) return true; // ends exactly with `_all`
  const parts = m[1].slice(1).split('_').filter(Boolean);
  return parts.every(p => _DISPLAY_VARIANTS.has(p) || _DATE_TOKEN_RE.test(p));
}
function _hierarchyDate(name) {
  const m = (name || '').match(_DATE_RE);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}
function _hierarchyArticleCount(it) {
  return parseInt(it.article_count || 0, 10) || 0;
}

function _enrichCatalogHierarchy(items) {
  // Dedupe by name, keep highest article_count.
  const byName = new Map();
  for (const it of items) {
    if (!it.name) continue;
    const prev = byName.get(it.name);
    if (!prev || _hierarchyArticleCount(it) > _hierarchyArticleCount(prev)) {
      byName.set(it.name, it);
    }
  }

  // Group by category + language.
  const families = new Map();
  for (const it of byName.values()) {
    const cat = (it.category || '').toLowerCase();
    const lang = (it.language || '').toLowerCase();
    if (!cat || !lang) continue;
    const key = cat + '_' + lang;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(it);
  }

  // Default empty hierarchy for every item, not just deduped/grouped ones.
  for (const it of items) {
    it.hierarchy = {is_subset_of: [], supersedes: [], freshness_advantage_subsets: [], coverage_advantage_bundle: false};
  }

  for (const members of families.values()) {
    const bundles = members.filter(m => _hierarchyName(m.name));
    const subsets = members.filter(m => !_hierarchyName(m.name));
    if (!bundles.length || !subsets.length) continue;

    const canonical = bundles.reduce((a, b) => _hierarchyArticleCount(b) > _hierarchyArticleCount(a) ? b : a);
    const canonName = canonical.name;
    const canonCount = _hierarchyArticleCount(canonical);
    const canonDate = _hierarchyDate(canonName);

    const validSubsets = subsets.filter(s => !canonCount || _hierarchyArticleCount(s) <= canonCount);
    const subsetNames = validSubsets.map(s => s.name);
    const fresher = validSubsets
      .filter(s => {
        const d = _hierarchyDate(s.name);
        return canonDate && d && (d[0] > canonDate[0] || (d[0] === canonDate[0] && d[1] > canonDate[1]));
      })
      .map(s => s.name);
    const sumSubsetArticles = validSubsets.reduce((sum, s) => sum + _hierarchyArticleCount(s), 0);
    const coverageAdvantage = canonCount > 0 && canonCount > sumSubsetArticles;

    // Apply to ALL items with these names (including dupes that didn't make it
    // into byName — they share the relationship metadata).
    for (const it of items) {
      if (subsetNames.includes(it.name)) {
        it.hierarchy.is_subset_of = [canonName];
      }
      if (it.name === canonName) {
        it.hierarchy.supersedes = subsetNames.slice();
        it.hierarchy.freshness_advantage_subsets = fresher.slice();
        it.hierarchy.coverage_advantage_bundle = coverageAdvantage;
      }
    }
  }
}

function _enrichCatalogInstalled(items) {
  // Match installed ZIMs to catalog items. Two prefixes are tried because
  // Kiwix's OPDS `name` field can be truncated/inconsistent (e.g. it returns
  // "canadian_prep_winterprepping" for a file actually named
  // "canadian_prepper_winterprepping_en_2026-02.zim"). Falling back to the
  // prefix derived from the download URL recovers those cases.
  //
  // Two passes over the items. Prefix alone conflates flavor editions:
  // "mdwiki_en_all" prefix-matches the installed mdwiki_en_all_maxi_* file,
  // so the unsuffixed video-build entry claimed a maxi install (and vice
  // versa) — the badge, delete button, and update pick all pointed at the
  // wrong edition (#50). Pass 1 therefore requires the filename flavor token
  // to agree. Pass 2 is the loose fallback for files NO entry claimed, so an
  // install whose exact flavor Kiwix has since delisted still shows as
  // installed instead of inviting a duplicate download.
  if (!zimsCache) return;

  const claimed = new Set();
  const tryMatch = (item, strict) => {
    // Build candidate prefixes to match installed filenames against.
    const prefixes = [item.name];
    if (item.download_url) {
      // Strip path, .meta4, .zim, and trailing _YYYY-MM date to get the
      // project's stable prefix as Kiwix actually filenames it.
      const fname = item.download_url.split('/').pop()
        .replace(/\.meta4$/, '').replace(/\.zim$/, '');
      const urlPrefix = fname.replace(/_\d{4}-\d{2}$/, '');
      if (urlPrefix && urlPrefix !== item.name) prefixes.push(urlPrefix);
    }
    const itemTok = _flavorToken(item.download_url || item.name);
    for (const z of zimsCache) {
      const fb = (z.file || '').replace(/\.zim$/, '');
      if (!prefixes.some(p => fb === p || fb.startsWith(p + '_'))) continue;
      if (strict ? _flavorToken(fb) !== itemTok : claimed.has(z.file)) continue;
      item.installed = true;
      const m = fb.match(/(\d{4}-\d{2})$/);
      item._installedDate = m ? m[1] : null;
      item._installedFile = z.file;
      item._installedName = z.name;
      item._installedSizeGb = z.size_gb;
      claimed.add(z.file);
      return;
    }
  };

  for (const item of items) {
    item.installed = false;
    item._installedDate = null;
    item._installedFile = null;
    item._installedName = null;
    item._installedSizeGb = null;
    tryMatch(item, true);
  }
  for (const item of items) {
    if (!item.installed) tryMatch(item, false);
  }
}

// ─── Featured ZIM Registry ────────────────────────────────────────────
// Each entry maps a ZIM name prefix to a Discover card slot.
// Fields:
//   match  — ZIM name prefix to match against installed ZIMs
//   type   — card type: 'apod' (dated), 'onthisday' (dated), 'country' (dated), 'random'
//   label  — display name shown on the card (e.g. "Quote of the Day")
//   icon   — emoji shown in catalog promo when ZIM not installed
//   promo  — source name shown in catalog install prompt
//   unlock — description of what installing this ZIM unlocks
//
// To add a new featured card: add an entry here, ensure _renderDiscover
// handles the type, and the card will appear automatically when the ZIM
// is installed. Future: this registry could live in a separate file or
// even be embedded in ZIM metadata.
// ──────────────────────────────────────────────────────────────────────
// Monochrome SVG icons for Discover cards (match navbar icon style)
const _FEAT_SVG = {
  telescope: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 21l6-11"/><path d="M12 21l-6-11"/><circle cx="12" cy="4" r="2"/><path d="M14 4l7 4-3 1"/><path d="M10 4L3 8l3 1"/></svg>',
  globe: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/><path d="M12 3c3 3 3 15 0 18"/></svg>',
  book: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M4 4.5A2.5 2.5 0 016.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15z"/></svg>',
  plane: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17.8 19.2L16 11l3.5-3.5C20.3 6.7 21 5.4 21 4.6c0-.4-.1-.6-.3-.8s-.4-.3-.8-.3c-.8 0-2.1.7-2.9 1.5L13.5 8.5 5 6.7l-1 1 6.2 3.5-3.5 3.5-2.2-.7-1 1 3.2 2 2 3.2 1-1-.7-2.2 3.5-3.5 3.5 6.2 1-1z"/></svg>',
  books: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 016.5 17H11v-14H6.5A2.5 2.5 0 004 5.5v14z"/><path d="M13 17h4.5a2.5 2.5 0 002.5-2.5v-14H13v17z"/></svg>',
  quote: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.76-2-1.88-2H3.88C2.76 3 2 3.75 2 5v6c0 1.25.76 2 1.88 2H8c0 4-3 5-5 5v3z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.76-2-1.88-2h-4.24C14.76 3 14 3.75 14 5v6c0 1.25.76 2 1.88 2H20c0 4-3 5-5 5v3z"/></svg>',
  play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  pen: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  map: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>',
};
const FEATURED_ZIMS = [
  { match: 'apod.nasa', type: 'apod', i18nLabel: 'picture_of_day', icon: _FEAT_SVG.telescope, promo: 'NASA APOD' },
  { match: 'wikipedia',     type: 'onthisday', i18nLabel: 'on_this_day',        icon: _FEAT_SVG.globe, promo: 'Wikipedia' },
  { match: 'wiktionary',    type: 'random',    i18nLabel: 'word_of_day',        icon: _FEAT_SVG.book, promo: 'Wiktionary' },
  { match: 'wikivoyage',    type: 'random',    i18nLabel: 'destination_of_day', icon: _FEAT_SVG.plane, promo: 'Wikivoyage' },
  { match: 'gutenberg',     type: 'random',    i18nLabel: 'book_of_day',        icon: _FEAT_SVG.books, promo: 'Project Gutenberg' },
  { match: 'wikiquote',     type: 'random',    i18nLabel: 'quote_of_day',       icon: _FEAT_SVG.quote, promo: 'Wikiquote' },
  { match: 'ted',           type: 'random',    i18nLabel: 'talk_of_day',        icon: _FEAT_SVG.play, promo: 'TED Talks' },
  { match: 'xkcd',          type: 'random',    i18nLabel: 'comic_of_day',       icon: _FEAT_SVG.pen, promo: 'xkcd' },
  { match: 'theworldfactbook', type: 'country', i18nLabel: 'country_of_day',    icon: _FEAT_SVG.map, promo: 'CIA World Factbook' },
];

function _isFeaturedInstalled(feat, grouped) {
  // Check ALL matching catalog groups — if any variant in any group is installed, this featured ZIM is installed
  // Also check zimsCache directly: installed ZIM names often don't match catalog names exactly
  if (zimsCache) {
    for (var z of zimsCache) {
      if (z.name === feat.match || z.name.startsWith(feat.match + '_') || (z.name.indexOf(feat.match) >= 0 && z.name.indexOf('_') >= 0)) {
        return true;
      }
    }
  }
  return grouped.some(g => (g.name === feat.match || g.name.startsWith(feat.match + '_')) && (g.variants || [g]).some(v => v.installed));
}

function buildFeaturedCarousel(items) {
  const grouped = groupVariants(items);
  var uiLang = (_currentLang || 'en').substring(0, 2);
  let cards = '';
  for (const feat of FEATURED_ZIMS) {
    if (_isFeaturedInstalled(feat, grouped)) continue;
    // Find ONE best match: prefer user's UI language, fall back to English
    // Exclude multilingual ZIMs (language contains commas or is 'mul')
    var allMatches = grouped.filter(function(g) {
      var n = g.name;
      var lang = g.language || '';
      // Skip multilingual entries
      if (lang.includes(',') || lang === 'mul' || lang.startsWith('mul')) return false;
      if (n === feat.match) return true;
      if (!n.startsWith(feat.match + '_')) return false;
      // Skip specialized subsets (medicine, wp_one, etc.)
      if (feat.match === 'wikipedia') {
        var suffix = n.substring(feat.match.length + 1);
        var sl = suffix.split('_')[0];
        return suffix === sl || suffix.startsWith(sl + '_all');
      }
      return true;
    });
    if (!allMatches.length) continue;
    // Only show UI language or English — don't fall back to random languages
    var best = allMatches.find(function(g) { return (g.language || '').startsWith(uiLang); })
      || allMatches.find(function(g) { return (g.language || '').startsWith('en'); });
    if (!best) continue;
    var variants = best.variants || [best];
    // Sibling URLs keep colliding labels apart (unsuffixed vs maxi, #50).
    var vUrls = variants.map(function(v) { return v.download_url; });
    var withLabels = variants.filter(function(v) { return v.download_url; }).map(function(v) {
      return { label: variantLabel(v.download_url, vUrls) || t('full'), size: formatSize(v.size_bytes), url: v.download_url, bytes: v.size_bytes || 0 };
    });
    withLabels.sort(function(a, b) { return _flavorOrder(b.url) - _flavorOrder(a.url); }); // Full first
    if (!withLabels.length) continue;
    var langTag = _catLangTag(best.language, best.name);
    var actionsHtml;
    if (withLabels.length > 1) {
      var fvid = '_dfv_' + feat.match;
      window[fvid] = withLabels;
      var top = withLabels[0];
      actionsHtml = '<div class="ci-dl-split" data-variants="' + fvid + '" data-selected="0">' +
        '<button class="ci-add-btn ci-dl-main" onclick="event.stopPropagation();var s=this.closest(\'.ci-dl-split\');downloadZim(window[s.dataset.variants][+s.dataset.selected].url, this)">' +
          tH('download_size', {size: esc(top.label + ' (' + top.size + ')')}) +
        '</button>' +
        '<button class="ci-dl-chevron" onclick="event.stopPropagation();showCatalogFlavorPicker(this)">' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>' +
        '</button>' +
      '</div>';
    } else {
      actionsHtml = '<button class="ci-add-btn" onclick="event.stopPropagation();downloadZim(\'' + escAttr(withLabels[0].url) + '\', this)">' +
        tH('download_size', {size: withLabels[0].size}) + '</button>';
    }
    cards += '<div class="catalog-item" style="margin-bottom:4px">' +
      '<div class="ci-icon" style="width:32px;text-align:center;display:flex;align-items:center;justify-content:center;color:var(--text2)">' + feat.icon + '</div>' +
      '<div class="ci-info" style="flex:1;min-width:0">' +
        '<div class="ci-title" style="font-size:13px">' + esc(best.title || best.name) + langTag + '</div>' +
        '<div class="ci-meta"><span>' + tH(feat.i18nLabel) + '</span></div>' +
      '</div>' +
      '<div class="ci-actions">' + actionsHtml + '</div>' +
    '</div>';
  }
  if (!cards) return '';
  return '<div class="featured-section" style="padding:0 0 8px">' +
    '<div class="ci-section-label">' + tH('discover') + '</div>' +
    cards +
  '</div>';
}


function renderBrowseGallery() {
  // If a pending drill was queued (e.g. from language banner download), execute it instead
  if (_pendingDrill) {
    var drill = _pendingDrill;
    _pendingDrill = null;
    manageLangFilter = drill.lang || null;
    _catalogCache = null;
    drillCategory(drill.catKey, drill.namePrefix);
    return;
  }
  const results = document.getElementById('catalog-results');
  if (!results) return;
  _ensureCatalogHydrated(); // instant paint from the session cache when present
  _browseView = 'gallery';
  manageCategoryFilter = null;
  pillsBar.innerHTML = ''; pillsBar.style.display = 'none'; pillsBar.className = 'pills';
  q.placeholder = t('search_catalog');

  // Only show loading spinner if catalog hasn't been fetched yet
  if (!_catalogCache) results.innerHTML = '<div class="loading"><span class="spinner-inline"></span>' + tH('loading_catalog') + '</div>';

  loadFullCatalog().then(items => {
    // Count unique ZIMs per category (group variants by name)
    const catNames = {};    // cat -> Set of names
    const catInstalled = {};
    for (const item of items) {
      const cat = item.category || 'other';
      if (!catNames[cat]) catNames[cat] = new Set();
      catNames[cat].add(item.name);
      if (item.installed) catInstalled[cat] = (catInstalled[cat] || 0) + 1;
    }
    const catCounts = {};
    for (const [cat, names] of Object.entries(catNames)) catCounts[cat] = names.size;

    // Build gallery cards in BROWSE_CATEGORIES order
    const knownKeys = new Set(BROWSE_CATEGORIES.map(c => c.key));
    // Collect unknown categories into "other"
    let otherExtra = 0, otherInstalledExtra = 0;
    for (const [cat, count] of Object.entries(catCounts)) {
      if (!knownKeys.has(cat)) {
        otherExtra += count;
        otherInstalledExtra += (catInstalled[cat] || 0);
      }
    }
    if (otherExtra > 0) catCounts['other'] = (catCounts['other'] || 0) + otherExtra;
    if (otherInstalledExtra > 0) catInstalled['other'] = (catInstalled['other'] || 0) + otherInstalledExtra;

    // Merge small categories (< 3 items) into Other
    const MIN_BROWSE_CAT = 3;
    _mergedToOther = new Set();
    for (const cat of BROWSE_CATEGORIES) {
      if (cat.key === 'other') continue;
      const count = catCounts[cat.key] || 0;
      if (count > 0 && count < MIN_BROWSE_CAT) {
        _mergedToOther.add(cat.key);
        catCounts['other'] = (catCounts['other'] || 0) + count;
        catInstalled['other'] = (catInstalled['other'] || 0) + (catInstalled[cat.key] || 0);
        catCounts[cat.key] = 0;
      }
    }

    // When a language filter is active, compute per-category filtered counts
    var filteredCatCounts = catCounts;
    var filteredCatInstalled = catInstalled;
    if (manageLangFilter) {
      filteredCatCounts = {};
      filteredCatInstalled = {};
      var filteredCatNames = {};
      for (const item of items) {
        if (!_zimMatchesLang(item, manageLangFilter)) continue;
        const cat = item.category || 'other';
        if (!filteredCatNames[cat]) filteredCatNames[cat] = new Set();
        filteredCatNames[cat].add(item.name);
        if (item.installed) filteredCatInstalled[cat] = (filteredCatInstalled[cat] || 0) + 1;
      }
      for (const [cat, names] of Object.entries(filteredCatNames)) filteredCatCounts[cat] = names.size;
      // Merge unknown cats into 'other'
      for (const [cat, count] of Object.entries(filteredCatCounts)) {
        if (!knownKeys.has(cat)) {
          filteredCatCounts['other'] = (filteredCatCounts['other'] || 0) + count;
          filteredCatInstalled['other'] = (filteredCatInstalled['other'] || 0) + (filteredCatInstalled[cat] || 0);
        }
      }
      for (const cat of _mergedToOther) {
        if (filteredCatCounts[cat]) {
          filteredCatCounts['other'] = (filteredCatCounts['other'] || 0) + filteredCatCounts[cat];
          filteredCatInstalled['other'] = (filteredCatInstalled['other'] || 0) + (filteredCatInstalled[cat] || 0);
          filteredCatCounts[cat] = 0;
        }
      }
    }

    let h = '<div class="browse-gallery">';
    // Language pills from full (unfiltered) catalog
    h += _renderLangPills(_countLangsByCategory(items, null), 'filterCatalogLang');
    if (!manageLangFilter) h += buildFeaturedCarousel(items);
    // Peer-only ZIMs (bookmark exports, custom imports) have no language
    // metadata worth filtering on — Nearby shows whenever peers offer them.
    h += _nearbyPeerSectionHtml();
    h += '<div class="browse-grid">';

    for (const cat of BROWSE_CATEGORIES) {
      const totalCount = catCounts[cat.key] || 0;
      if (totalCount === 0 && cat.key !== 'other') continue;
      const count = filteredCatCounts[cat.key] || 0;
      const installed = filteredCatInstalled[cat.key] || 0;
      const dimmed = manageLangFilter && count === 0;
      const countLine = t('n_available', {n: count}) + (installed > 0 ? ' \u00B7 ' + t('n_installed_count', {n: installed}) : '');
      h += '<div class="browse-cat-card' + (dimmed ? ' dimmed' : '') + '" onclick="drillCategory(\'' + escAttr(cat.key) + '\')">' +
        '<div class="bcc-icon">' + cat.icon + '</div>' +
        '<div class="bcc-info">' +
          '<div class="bcc-name">' + tH(cat.i18n) + '</div>' +
          '<div class="bcc-desc">' + tH(cat.descKey) + '</div>' +
          '<div class="bcc-count">' + esc(countLine) + '</div>' +
        '</div>' +
        '<div class="bcc-arrow">\u203A</div>' +
      '</div>';
    }
    h += '</div>';
    // Footer: count centered, language dropdown moved below
    var activeCats = BROWSE_CATEGORIES.filter(function(c) { return (filteredCatCounts[c.key] || 0) > 0; }).length;
    var totalSources = (manageLangFilter || _getPrefLanguages().length)
      ? groupVariants(items.filter(function(it) { return _zimMatchesLang(it, manageLangFilter); })).length
      : groupVariants(items).length;
    h += '<div class="browse-footer">' +
      '<div class="browse-footer-count">' + totalSources.toLocaleString() + ' sources \u00B7 ' + activeCats + ' categories</div>' +
    '</div>';
    h += '</div>';
    results.innerHTML = _catalogStaleNote() + h;
    // Auto-scroll pill bar so the active language pill is visible
    var activePill = results.querySelector('.catalog-lang-scroll .pill.active');
    if (activePill) activePill.scrollIntoView({inline: 'center', block: 'nearest'});
  }).catch(err => {
    results.innerHTML = '<div class="empty"><p>' + tH('failed_load_library') + '</p><div class="hint">' + esc(String(err)) + '</div></div>';
  });
}

function drillCategory(catKey, namePrefix) {
  // New category = fresh view; don't carry the show-hidden expansion over.
  if (manageCategoryFilter !== catKey) _showHiddenCatalog = false;
  const results = document.getElementById('catalog-results');
  if (!results) return;
  _ensureCatalogHydrated(); // instant paint from the session cache when present
  _browseView = 'drilldown';
  manageCategoryFilter = catKey;
  pillsBar.innerHTML = ''; pillsBar.style.display = 'none'; pillsBar.className = 'pills';

  const catMeta = BROWSE_CATEGORIES.find(c => c.key === catKey);
  const catName = catMeta ? t(catMeta.i18n) : catKey;
  q.placeholder = t('search_in', {source: catName});
  q.value = '';

  if (!_catalogCache) results.innerHTML = _loadingHtml('loading_catalog');

  loadFullCatalog().then(items => {
    // Filter to this category (+ unknown/merged cats go to "other")
    const knownKeys = new Set(BROWSE_CATEGORIES.map(c => c.key));
    let filtered = items.filter(item => {
      const cat = item.category || 'other';
      if (catKey === 'other') return cat === 'other' || !knownKeys.has(cat) || _mergedToOther.has(cat);
      return cat === catKey;
    });

    // Optional name prefix filter (e.g. "wikipedia" to exclude wiktionary/wikisource/etc.)
    if (namePrefix) {
      var pfx = namePrefix.toLowerCase();
      filtered = filtered.filter(function(item) { return (item.name || '').toLowerCase().startsWith(pfx); });
    }

    // Language pills scoped to this category (counts from unfiltered items)
    var langPills = _renderLangPills(_countLangsByCategory(filtered, catKey), 'filterCatalogLang');

    // Apply language filter after computing pill counts (so pills show all available languages).
    // _zimMatchesLang internally falls back to user prefs when no pill is set.
    if (manageLangFilter || _getPrefLanguages().length) {
      filtered = filtered.filter(function(item) { return _zimMatchesLang(item, manageLangFilter); });
    }
    const grouped = groupVariants(filtered);
    // Sort: installed first, then alphabetical
    grouped.sort((a, b) => (a.title || a.name || '').localeCompare(b.title || b.name || ''));
    let h = '<div class="browse-drilldown-header">' +
      '<button class="browse-back" onclick="renderBrowseGallery()">' + tH('back_to_catalog') + '</button>' +
      '<span class="browse-drilldown-title">' + (catMeta ? catMeta.icon + ' ' : '') + esc(catName) + '</span>' +
      '<span class="browse-drilldown-count">' + tH('n_available', {n: grouped.length}) + '</span>' +
    '</div>';
    h += langPills;
    if (grouped.length) {
      h += _renderCatalogGrid(grouped);
    } else {
      h += '<div class="empty"><p>' + tH('no_zims_category') + '</p></div>';
    }
    results.innerHTML = _catalogStaleNote() + h;
    // Auto-scroll pill bar so the active language pill is visible
    var activePill = results.querySelector('.catalog-lang-scroll .pill.active');
    if (activePill) activePill.scrollIntoView({inline: 'center', block: 'nearest'});
  }).catch(err => {
    results.innerHTML = '<div class="empty"><p>' + tH('failed_load_category') + '</p></div>';
  });
}

function browseCatalogFilter(query) {
  if (!query) { renderBrowseGallery(); return; }
  const results = document.getElementById('catalog-results');
  if (!results) return;
  _ensureCatalogHydrated(); // instant paint from the session cache when present
  _browseView = 'search';
  pillsBar.innerHTML = ''; pillsBar.style.display = 'none'; pillsBar.className = 'pills';

  if (!_catalogCache) {
    results.innerHTML = _loadingHtml('loading_catalog');
  }
  loadFullCatalog().then(items => {
    const lq = query.toLowerCase();
    const knownKeys = new Set(BROWSE_CATEGORIES.map(c => c.key));
    // Filter within current category if drilled down, otherwise all
    let pool = items;
    if (manageCategoryFilter) {
      pool = items.filter(item => {
        const cat = item.category || 'other';
        if (manageCategoryFilter === 'other') return cat === 'other' || !knownKeys.has(cat) || _mergedToOther.has(cat);
        return cat === manageCategoryFilter;
      });
    }
    const filtered = pool.filter(item => {
      const title = (item.title || item.name || '').toLowerCase();
      const summary = (item.summary || '').toLowerCase();
      return title.includes(lq) || summary.includes(lq) || (item.name || '').toLowerCase().includes(lq);
    });
    const grouped = groupVariants(filtered);
    // Sort: actionable items first (not installed, not covered by an installed bundle),
    // then installed/covered items pushed to the back. Within each group, alphabetical.
    grouped.sort((a, b) => {
      const aDemoted = a.installed || (a.hierarchy && (a.hierarchy.is_subset_of || []).some(n => _catalogInstalledNames.has(n)));
      const bDemoted = b.installed || (b.hierarchy && (b.hierarchy.is_subset_of || []).some(n => _catalogInstalledNames.has(n)));
      if (aDemoted !== bDemoted) return aDemoted ? 1 : -1;
      return (a.title || a.name || '').localeCompare(b.title || b.name || '');
    });
    let h = '<div class="browse-drilldown-header">' +
      '<button class="browse-back" onclick="' + (manageCategoryFilter ? "drillCategory('" + escAttr(manageCategoryFilter) + "')" : 'renderBrowseGallery()') + '">\u2190 Back</button>' +
      '<span class="browse-drilldown-count">' + t('n_results', {n: filtered.length}) + ' \u2014 \u201C' + esc(query) + '\u201D</span>' +
    '</div>';
    if (grouped.length) {
      h += _renderCatalogGrid(grouped);
    } else {
      h += '<div class="empty"><p>' + tH('no_matching_zims') + '</p></div>';
    }
    results.innerHTML = _catalogStaleNote() + h;
  }).catch(() => {
    results.innerHTML = '<div class="empty"><p>' + tH('failed_search_catalog') + '</p></div>';
  });
}

// ── Category mapping (mirrors server _categorize_zim) ──
const MANAGE_CATEGORIES = [
  'Wikimedia', 'Stack Exchange', 'Dev Docs', 'Education', 'Medical', 'How-To', 'Books', 'Other'
];

// Map English category names from categorizeZim() → BROWSE_CATEGORIES keys for localization
const _CAT_TO_BROWSE_KEY = {
  'Wikimedia': 'wikipedia', 'Stack Exchange': 'stack_exchange', 'Dev Docs': 'devdocs',
  'Education': 'education', 'Medical': 'medical', 'How-To': 'survival',
  'Books': 'gutenberg', 'Other': 'other'
};

function categorizeZim(name) {
  const n = name.toLowerCase();
  if (/medicine|wikem|ready\.gov/.test(n) || (n.startsWith('zimgit-') && /water|food|disaster|knots/.test(n))) return 'Medical';
  if (/stackoverflow|askubuntu|superuser|serverfault|stackexchange/.test(n)) return 'Stack Exchange';
  if (n.startsWith('devdocs_') || n === 'freecodecamp') return 'Dev Docs';
  if (/^ted_|^phzh_/.test(n) || /crashcourse|phet|appropedia|artofproblemsolving|edutechwiki|explainxkcd|coreeng/.test(n)) return 'Education';
  if (/wikihow|ifixit|off-the-grid/.test(n)) return 'How-To';
  if (/^wiki|^wikt/.test(n) || n === 'openstreetmap-wiki') return 'Wikimedia';
  if (/gutenberg|rationalwiki|theworldfactbook/.test(n)) return 'Books';
  return 'Other';
}

function formatSize(bytes) { return fmtBytes(bytes); }

// Bold download arrow for catalog buttons — the ↓ glyph reads too thin.
const _DL_ARROW_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v13M6 11l6 6 6-6"/></svg>';

// Installed and covered-by-an-installed-bundle rows are noise when browsing
// for something new — collapse them behind a count button at the list end.
let _showHiddenCatalog = false;

function _catalogItemDemoted(g) {
  const variants = g.variants || [g];
  if (variants.some(v => v.installed)) return true;
  return !!(g.hierarchy && (g.hierarchy.is_subset_of || []).some(n => _catalogInstalledNames.has(n)));
}

// Render a grouped catalog list with demoted rows collapsed. Returns HTML.
function _renderCatalogGrid(grouped) {
  const visible = grouped.filter(g => !_catalogItemDemoted(g));
  const hidden = grouped.filter(_catalogItemDemoted);
  let h = '';
  if (visible.length || hidden.length) {
    h += '<div class="catalog-grid">';
    for (const item of visible) h += renderCatalogItem(item);
    if (_showHiddenCatalog) for (const item of hidden) h += renderCatalogItem(item);
    h += '</div>';
  }
  if (hidden.length) {
    h += '<div style="text-align:center;margin-top:10px"><button class="pill" onclick="_toggleHiddenCatalog()">' +
      tH(_showHiddenCatalog ? 'hide_installed_covered' : 'show_installed_covered', {n: hidden.length}) +
      '</button></div>';
  }
  return h;
}

function _toggleHiddenCatalog() {
  _showHiddenCatalog = !_showHiddenCatalog;
  if (_browseView === 'drilldown' && manageCategoryFilter) drillCategory(manageCategoryFilter);
  else if (_browseView === 'search') { var v = q.value.trim(); if (v) browseCatalogFilter(v); }
  else renderBrowseGallery();
}

function groupVariants(items) {
  const groups = {};
  for (const item of items) {
    const key = item.name;
    if (!groups[key]) groups[key] = { ...item, variants: [] };
    groups[key].variants.push(item);
    if (item.article_count > (groups[key].article_count || 0)) groups[key].article_count = item.article_count;
    if (item.summary && !groups[key].summary) groups[key].summary = item.summary;
    if (item.icon_url && !groups[key].icon_url) groups[key].icon_url = item.icon_url;
    // The card's date tag should reflect the group's NEWEST edition, not
    // whichever entry the catalog happened to list first.
    if ((item.date || '') > (groups[key].date || '')) groups[key].date = item.date;
  }
  // Same name + same flavor token = two DATE EDITIONS of one build, not two
  // flavors. Rendering both gives identically-labeled rows that invite a
  // second, redundant download (#50) — keep only the newest edition of each.
  for (const g of Object.values(groups)) g.variants = _newestPerFlavor(g.variants);
  return Object.values(groups);
}

// Flavor token from a ZIM filename or download URL — the client twin of
// library.py's _detect_flavor. The token in the filename is the only flavor
// signal the client and server share; the OPDS `flavour` field is unreliable
// (empty on Kiwix's unsuffixed complete builds). null = the unsuffixed build.
function _flavorToken(url) {
  const f = ((url || '').split('/').pop() || '').replace(/\.zim(\.meta4)?$/, '');
  if (/(^|_)maxi(_|$)/.test(f)) return 'maxi';
  if (/(^|_)nopic(_|$)/.test(f)) return 'nopic';
  if (/(^|_)mini(_|$)/.test(f)) return 'mini';
  return null;
}

// Collapse same-flavor-token entries (date editions of one build) down to the
// newest edition. Items must carry download_url + date (OPDS shape).
function _newestPerFlavor(list) {
  const out = [];
  for (const item of list) {
    // No URL = nothing downloadable to conflate; never merge those, and never
    // let one displace a real entry (that would drop the group's only URL).
    const i = item.download_url
      ? out.findIndex(v => v.download_url && _flavorToken(v.download_url) === _flavorToken(item.download_url))
      : -1;
    if (i < 0) out.push(item);
    else if ((item.date || '') > (out[i].date || '')) out[i] = item;
  }
  return out;
}

// siblingUrls (optional): download URLs of the other variants in the same
// group. Needed to disambiguate Kiwix's unsuffixed complete build: alone it
// reads as the default "Full", but next to a maxi sibling (mdwiki_en_all,
// wikipedia_en_100, ...) both would say "Full" while differing by gigabytes
// of video (#50) — so the unsuffixed one must say what it adds.
function variantLabel(url, siblingUrls) {
  if (!url) return '';
  const tok = _flavorToken(url);
  if (tok === 'maxi') return t('full');
  if (tok === 'nopic') return t('no_images');
  if (tok === 'mini') return t('mini');
  if (siblingUrls && siblingUrls.some(u => u && u !== url && _flavorToken(u) === 'maxi')) {
    return t('full_video');
  }
  return '';
}

// Higher = preferred. Highest score belongs to the user's preferred flavor.
// Used by sort callers — DESC sort puts the preferred flavor first.
// maxi outranks the unsuffixed complete build under the "full" preference:
// that preference promises articles+images, not a surprise multi-GB video
// edition — the video build stays an explicit dropdown choice (#50).
const _FLAVOR_RANKS = {
  full:  { maxi: 4, plain: 3, nopic: 2, mini: 1 },
  nopic: { nopic: 4, maxi: 3, plain: 2, mini: 1 },
  mini:  { mini: 4, nopic: 3, maxi: 2, plain: 1 },
};
function _flavorOrder(url) {
  const ranks = _FLAVOR_RANKS[_getPrefFlavor()] || _FLAVOR_RANKS.full;
  return ranks[_flavorToken(url) || 'plain'];
}

function renderCatalogItem(group) {
  const item = group;
  const variants = group.variants || [item];
  const metaTags = [];
  if (item.article_count) metaTags.push(item.article_count.toLocaleString() + ' ' + t('articles'));
  if (item.date) metaTags.push(item.date);
  const sizes = variants.map(v => v.size_bytes).sort((a, b) => a - b);
  if (sizes.length > 1) {
    metaTags.push('<span title="' + escAttr(t('size_range_hint')) + '">' +
      formatSize(sizes[0]) + ' – ' + formatSize(sizes[sizes.length - 1]) + '</span>');
  } else {
    metaTags.push(formatSize(sizes[0]));
  }
  const letterChar = (esc(item.title || item.name)[0] || '?').toUpperCase();
  const iconHtml = item.icon_url
    ? '<img src="/manage/thumb?url=' + encodeURIComponent(item.icon_url) + '" alt="" width="40" height="40" loading="lazy"' +
      ' onerror="_ciThumbFallback(this)" data-letter="' + escAttr(letterChar) + '">'
    : '<span class="ci-letter">' + letterChar + '</span>';
  const anyInstalled = variants.some(v => v.installed);
  let actionsHtml = '';
  if (anyInstalled) {
    const instVariant = variants.find(v => v.installed) || item;
    // An update must be the SAME flavor edition as the installed file. The
    // old "first non-installed variant" pick could hand a maxi install the
    // group's unsuffixed video build — a 10+ GB different edition downloaded
    // ALONGSIDE the existing one instead of replacing it (#50, echoes #16).
    const instTok = _flavorToken(instVariant._installedFile || '');
    const updVariant = variants.find(v => v.download_url && _flavorToken(v.download_url) === instTok) || instVariant;
    const hasUpdate = instVariant._installedDate && updVariant.date && updVariant.download_url
      && instVariant._installedDate < updVariant.date.substring(0, 7);
    if (hasUpdate) {
      // Update available — show update button (same style as manage view)
      actionsHtml = '<button class="ci-update-btn" onclick="downloadZim(\'' + escAttr(updVariant.download_url) + '\', this, true)" title="' + escAttr(t('from_to_update', {from: instVariant._installedDate, to: updVariant.date})) + '">' +
        tH('update') + '</button>';
    } else {
      actionsHtml = '<span class="ci-installed-badge">' + tH('installed_badge') + '</span>';
    }
    if (instVariant._installedFile) {
      actionsHtml += '<button class="ci-delete-btn" onclick="deleteZim(\'' + escAttr(instVariant._installedFile) + '\', this)" title="' + escAttr(t('delete_zim')) + '">\u00D7</button>';
    }
  } else {
    // Sibling URLs disambiguate colliding labels (unsuffixed vs maxi → both
    // "Full" without them, see variantLabel).
    const vUrls = variants.map(v => v.download_url);
    const withLabels = variants.filter(v => v.download_url).map(v => {
      const label = variantLabel(v.download_url, vUrls) || t('full');
      const size = formatSize(v.size_bytes);
      return { label, size, url: v.download_url, bytes: v.size_bytes || 0 };
    });
    withLabels.sort((a, b) => _flavorOrder(b.url) - _flavorOrder(a.url));
    if (withLabels.length > 1) {
      // Integrated button: "Download Full (size) ▾" — click chevron to change flavor
      var vid = '_cfv_' + group.name.replace(/[^a-z0-9_]/gi, '_');
      window[vid] = withLabels;
      var best = withLabels[0]; // Full is sorted first
      actionsHtml = '<div class="ci-dl-split" data-variants="' + vid + '" data-selected="0">' +
        '<button class="ci-add-btn ci-dl-main" aria-label="' + escAttr(t('download_size', {size: best.label + ' (' + best.size + ')'})) + '"' +
          ' onclick="event.stopPropagation();var s=this.closest(\'.ci-dl-split\');downloadZim(window[s.dataset.variants][+s.dataset.selected].url, this)">' +
          _DL_ARROW_SVG + esc(best.label + ' (' + best.size + ')') +
        '</button>' +
        '<button class="ci-dl-chevron" onclick="event.stopPropagation();showCatalogFlavorPicker(this)" title="' + escAttr(t('choose_flavor')) + '">' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>' +
        '</button>' +
      '</div>';
    } else if (withLabels.length === 1) {
      actionsHtml = '<button class="ci-add-btn" aria-label="' + escAttr(t('download_size', {size: withLabels[0].label + ' (' + withLabels[0].size + ')'})) + '"' +
        ' onclick="event.stopPropagation();downloadZim(\'' + escAttr(withLabels[0].url) + '\', this)">' +
        _DL_ARROW_SVG + esc(withLabels[0].label + ' (' + withLabels[0].size + ')') + '</button>';
    }
  }
  const catAttr = item.category ? ' data-category="' + escAttr(item.category) + '"' : '';
  const instName = anyInstalled ? (variants.find(v => v.installed && v._installedName) || {})._installedName || '' : '';
  const openAttr = instName ? ' style="cursor:pointer" onclick="if(!event.target.closest(\'button\')&&!event.target.closest(\'.flavor-pill\')){enterSource(\'' + escJs(instName) + '\',true)}"' : '';
  const hierarchyHtml = _hierarchyHint(item);
  const peerHtml = _peerHint(item);
  // Multi-select checkbox — only when there's something to download.
  let selectHtml = '';
  if (!anyInstalled) {
    const dlVariants = variants.filter(v => v.download_url);
    if (dlVariants.length > 0) {
      const sorted = dlVariants.slice().sort((a, b) => _flavorOrder(b.download_url) - _flavorOrder(a.download_url));
      const best = sorted[0];
      const checked = _selectedDownloads.has(best.download_url) ? ' checked' : '';
      selectHtml = '<input type="checkbox" class="ci-select"' + checked +
        ' data-url="' + escAttr(best.download_url) + '"' +
        ' data-size="' + (best.size_bytes || 0) + '"' +
        ' onclick="event.stopPropagation();_toggleDownloadSelection(this)"' +
        ' title="' + escAttr(t('select_for_batch')) + '">';
    }
  }
  // Gear on installed rows opens the same Move to… menu the card right-click
  // does (right-click alone isn't discoverable). data-zim + delegated handler,
  // no user strings in an inline onclick.
  const gearHtml = (instName && manageEnabled)
    ? '<button class="ci-gear" data-zim="' + escAttr(instName) + '" onclick="event.stopPropagation();_ciGearClick(this)" title="' + escAttr(t('organize')) + '" aria-label="' + escAttr(t('organize')) + '">⋯</button>'
    : '';
  const isCovered = !anyInstalled && item.hierarchy
    && (item.hierarchy.is_subset_of || []).some(n => _catalogInstalledNames.has(n));
  return '<div class="catalog-item' + (anyInstalled ? ' ci-installed-item' : '') +
    (isCovered ? ' ci-covered' : '') + '"' + catAttr + openAttr + '>' +
    selectHtml +
    '<div class="ci-icon">' + iconHtml + '</div>' +
    '<div class="ci-info">' +
      '<div class="ci-title">' + esc(item.title || item.name) + _catLangTag(item.language, item.name) + '</div>' +
      (item.summary ? '<div class="ci-summary">' + esc(item.summary) + '</div>' : '') +
      '<div class="ci-meta">' + metaTags.map(function(m){return '<span>'+m+'</span>'}).join(' &middot; ') + '</div>' +
      (hierarchyHtml ? '<div class="ci-hier">' + hierarchyHtml + '</div>' : '') +
    '</div>' +
    // Peer pill rides in the action row, directly left of the download button
    '<div class="ci-actions">' + gearHtml + peerHtml + actionsHtml + '</div>' +
  '</div>';
}

// Thumbnail proxy failures (origin 502, offline) would otherwise leave a
// permanent white square — swap in the letter icon instead.
function _ciThumbFallback(img) {
  const span = document.createElement('span');
  span.className = 'ci-letter';
  span.textContent = img.dataset.letter || '?';
  img.replaceWith(span);
}

// Selection state for the multi-select Download bar.
const _selectedDownloads = new Map(); // url → size_bytes

function _toggleDownloadSelection(cb) {
  const url = cb.dataset.url;
  const size = parseInt(cb.dataset.size, 10) || 0;
  if (cb.checked) {
    _selectedDownloads.set(url, size);
  } else {
    _selectedDownloads.delete(url);
  }
  _renderSelectionBar();
}

// Re-key a selected download when its flavor changes so the selection-bar
// total tracks the chosen variant (a checked item plus a flavor switch used
// to keep totalling the OLD flavor's size). Returns true when it changed.
function _reselectDownloadUrl(oldUrl, newUrl, bytes) {
  if (oldUrl === newUrl || !_selectedDownloads.has(oldUrl)) return false;
  _selectedDownloads.delete(oldUrl);
  _selectedDownloads.set(newUrl, bytes || 0);
  return true;
}

function _renderSelectionBar() {
  let bar = document.getElementById('ci-selection-bar');
  if (_selectedDownloads.size === 0) {
    if (bar) bar.remove();
    return;
  }
  // Selection survives leaving the Catalog tab; the bar does not.
  const inCatalog = mode === 'manage' && manageTab === 'browse';
  if (!inCatalog) {
    if (bar) bar.style.display = 'none';
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ci-selection-bar';
    bar.className = 'ci-selection-bar';
    document.body.appendChild(bar);
  }
  bar.style.display = '';
  while (bar.firstChild) bar.removeChild(bar.firstChild);
  const totalSize = Array.from(_selectedDownloads.values()).reduce((a, b) => a + b, 0);
  const sizeStr = totalSize > 0 ? ' · ' + formatSize(totalSize) : '';
  const count = document.createElement('span');
  count.className = 'ci-sel-count';
  count.textContent = t('n_selected', {n: _selectedDownloads.size}) + sizeStr;
  const clearBtn = document.createElement('button');
  clearBtn.className = 'pill';
  clearBtn.textContent = t('clear');
  clearBtn.onclick = _clearDownloadSelection;
  const dlBtn = document.createElement('button');
  dlBtn.className = 'manage-btn-action';
  dlBtn.textContent = t('download_selected');
  dlBtn.onclick = () => _downloadSelected(dlBtn);
  bar.appendChild(count);
  bar.appendChild(clearBtn);
  bar.appendChild(dlBtn);
}

function _clearDownloadSelection() {
  _selectedDownloads.clear();
  document.querySelectorAll('.ci-select').forEach(cb => { cb.checked = false; });
  _renderSelectionBar();
}

async function _downloadSelected(btn) {
  const urls = Array.from(_selectedDownloads.keys());
  const sizes = urls.map(u => _selectedDownloads.get(u) || 0);
  btn.disabled = true;
  const origLabel = btn.textContent;
  btn.innerHTML = '<span class="spinner-inline"></span>' + tH('loading');
  try {
    const res = await manageFetch('/manage/download-batch', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({urls, sizes}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'failed');
    _showToast(t('downloads_started', {n: data.started || 0}));
    _dlRecentStart = Date.now();
    _clearDownloadSelection();
    // The batch is now the user's focus — take them to it.
    switchManageTab('downloads');
    if (window._nudgeActivityPoll) window._nudgeActivityPoll();
  } catch (e) {
    _showToast(t('error'));
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}

// ── Tab switching ──
function switchManageTab(tab) {
  manageTab = tab;
  // Mobile: the settings card doubles as the 'settings' tab's content.
  const msCard = document.getElementById('manage-status');
  if (msCard) msCard.classList.toggle('as-tab-active', tab === 'settings');
  manageCategoryFilter = null;
  manageLangFilter = null;
  _browseView = 'gallery';
  document.querySelectorAll('.manage-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.manage-tab-content').forEach(c => c.classList.toggle('active', c.id === 'manage-' + tab));
  q.value = '';
  pillsBar.innerHTML = ''; pillsBar.style.display = 'none'; pillsBar.className = 'pills';
  if (tab === 'installed') {
    q.placeholder = t('filter_installed');
    renderInstalled();
  } else if (tab === 'downloads') {
    q.placeholder = t('search_placeholder');
    refreshDownloads();
  } else if (tab === 'collections') {
    q.placeholder = t('search_placeholder');
    renderCollectionsTab();
  } else if (tab === 'history') {
    q.placeholder = t('search_placeholder');
    _act.showAll = false;   // re-entering the tab defaults back to the capped view
    renderActivityLog();
  } else if (tab === 'activity') {
    q.placeholder = t('search_placeholder');
    renderActivityTab();
  } else {
    // Default catalog language pill to the UI language UNLESS the user has
    // a multi-language preference — then leave the pill empty so the prefs
    // filter is what's in effect.
    if (!_getPrefLanguages().length && _currentLang) manageLangFilter = _currentLang;
    renderBrowseGallery();
  }
  _renderSelectionBar();
}

// ── Collections tab ──
async function renderCollectionsTab() {
  const el = document.getElementById('manage-collections');
  if (!el) return;
  // Fetch fresh collections
  try {
    const res = await fetch('/collections');
    if (res.ok) collectionsCache = await res.json();
  } catch(e) {}
  const data = collectionsCache || {favorites: [], collections: {}};
  const colls = data.collections || {};
  const zims = zimsCache || [];

  let h = '';

  // Create collection form
  h += '<div class="manage-card"><h2>' + tH('collections_tab') + '</h2>';
  h += '<div class="coll-form">' +
    '<input id="coll-label" placeholder="' + escAttr(t('collection_placeholder')) + '" autocomplete="off">' +
    '<button onclick="createCollection()">' + tH('create') + '</button>' +
  '</div>';

  // Each collection with inline ZIM picker
  for (const [name, coll] of Object.entries(colls)) {
    const label = coll.label || name;
    const collZims = coll.zims || [];
    const expanded = _expandedCollection === name;
    h += '<div class="coll-item" style="flex-direction:column;align-items:stretch" onclick="toggleCollExpand(\'' + escAttr(name) + '\')">';
    h += '<div style="display:flex;align-items:center;gap:12px">' +
      '<span class="coll-name" style="flex:1">' + esc(label) +
      ' <span style="font-weight:400;color:var(--text2);font-size:12px">(' + tH('n_sources', {n: collZims.length}) + ')</span></span>' +
      '<button class="coll-del" onclick="event.stopPropagation();deleteCollection(\'' + escAttr(name) + '\', this)" title="' + escAttr(t('delete_collection')) + '">\u00D7</button>' +
    '</div>';
    if (expanded) {
      // ZIM picker — same library card layout as the Installed list (shared
      // _zimCardHtml), grouped by category like the homepage. A tap toggles
      // collection membership; members render selected (checkmark).
      const catMap = {};
      for (const z of zims) {
        const cat = z.category || categorizeZim(z.name);
        if (!catMap[cat]) catMap[cat] = [];
        catMap[cat].push(z);
      }
      h += '<div class="coll-picker" onclick="event.stopPropagation()">';
      for (const cat of Object.keys(catMap).sort()) {
        const catZims = catMap[cat].slice().sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
        h += '<div class="manage-installed-group"><div class="ci-section-label">' + esc(_catDisplayName(cat)) + ' (' + catZims.length + ')</div>';
        for (const z of catZims) {
          const inColl = collZims.includes(z.name);
          const meta = [];
          const countHtml = _zimCountHtml(z);
          if (countHtml) meta.push(countHtml);
          meta.push(fmtSize(z.size_gb));
          h += _zimCardHtml(z, {
            selected: inColl,
            onclick: 'event.stopPropagation();toggleCollZim(\'' + escAttr(name) + '\',\'' + escAttr(z.name) + '\')',
            metaHtml: meta.map(function(m){return '<span>'+m+'</span>'}).join(' &middot; '),
            actionsHtml: '<span class="ci-coll-check">' + (inColl ? '✓' : '') + '</span>',
          });
        }
        h += '</div>';
      }
      h += '</div>';
    }
    h += '</div>';
  }

  if (!Object.keys(colls).length) {
    h += '<div style="font-size:13px;color:var(--text2)">' + tH('no_collections') + '</div>';
  }
  h += '<div style="font-size:12px;color:var(--text2);margin-top:12px;opacity:0.7">' + tH('collection_hint') + '</div>';
  h += '</div>';

  el.innerHTML = h;
}

async function createCollection() {
  const labelEl = document.getElementById('coll-label');
  if (!labelEl || !labelEl.value.trim()) return;
  const label = labelEl.value.trim();
  try {
    const opts = {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({label, zims: []})};
    Object.assign(opts.headers, _authHeaders());
    const res = await fetch('/collections', opts);
    if (res.ok) {
      labelEl.value = '';
      renderCollectionsTab();
    }
  } catch(e) {}
}

async function deleteCollection(name, btn) {
  if (!btn) return;
  // Two-click confirmation
  if (!btn.classList.contains('confirming')) {
    btn.classList.add('confirming');
    btn.textContent = t('delete_confirm');
    btn.style.fontSize = '11px';
    btn.style.color = 'var(--amber)';
    setTimeout(() => { if (btn.classList.contains('confirming')) { btn.classList.remove('confirming'); btn.textContent = '\u00D7'; btn.style.fontSize = ''; btn.style.color = ''; }}, 3000);
    return;
  }
  try {
    const opts = {method: 'DELETE', headers: _authHeaders()};
    const res = await fetch('/collections?name=' + encodeURIComponent(name), opts);
    if (res.ok) renderCollectionsTab();
  } catch(e) {}
}

function toggleCollExpand(name) {
  _expandedCollection = _expandedCollection === name ? null : name;
  renderCollectionsTab();
}

async function toggleCollZim(collName, zimName) {
  const data = collectionsCache || {favorites: [], collections: {}};
  const coll = data.collections[collName];
  if (!coll) return;
  const zims = coll.zims || [];
  const idx = zims.indexOf(zimName);
  if (idx >= 0) zims.splice(idx, 1);
  else zims.push(zimName);
  try {
    const opts = {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: collName, label: coll.label || collName, zims})};
    Object.assign(opts.headers, _authHeaders());
    const res = await fetch('/collections', opts);
    if (res.ok) {
      // Update cache in place so re-render is instant
      coll.zims = zims;
      renderCollectionsTab();
    }
  } catch(e) {}
}

// ── History tab ──
// ── Activity ────────────────────────────────────────────────────────────────
// Everything that has happened to this library, in one list: a download, an
// auto-update, a creation run, an export, a deletion — each line saying what it
// was, how it went and WHO did it. A ZIM updated by the auto-updater and the
// same ZIM updated by a person are the same transfer and different events, and
// only one of them means somebody made a decision.
//
// The server keeps the journal (/manage/activity-log, last 200 records). The
// fetch here is deliberately unfiltered: 200 records is one small read, and
// filtering in the client is what lets the type and actor boxes be multi-select
// and repaint with no round trip. The endpoint takes ?type= / ?actor= for API
// callers who want the server to do it.

var _ACT_RENDER_CAP = 50;  // rows before the "Show all" expander

// One glyph per type, so the list is scannable before a word of it is read.
function _actGlyph(d) {
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
}
var _ACT_GLYPHS = {
  download: _actGlyph('<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>'),
  update:   _actGlyph('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4h-4"/>'),
  create:   _actGlyph('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  import:   _actGlyph('<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  export:   _actGlyph('<path d="M12 21V9"/><path d="M8 13l4-4 4 4"/><path d="M4 9V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/>'),
  delete:   _actGlyph('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
  health:   _actGlyph('<path d="M3 12h4l2-5 3 10 2-5h7"/>'),
  restore:  _actGlyph('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>')
};
var _ACT_FALLBACK_GLYPH = _actGlyph('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>');

// A record with no subject is about the server itself, not about one ZIM —
// named here so it is named in the reader's language.
var _ACT_SUBJECT_FALLBACK = {
  health: 'act_subject_library',
  restore: 'act_subject_backup',
  export: 'act_subject_bookmarks'
};
// What the optional count counts, per type.
var _ACT_COUNT_LABEL = {export: 'act_n_bookmarks', restore: 'act_n_sections'};

// View state. Filters are stored as what is turned ON — the pills come up
// deselected, which means "show everything", exactly like the Library view's
// category pills: nothing is lit until you tap, a tap selects one value to
// filter by, a second tap lets go of it. An empty selection on an axis is no
// filter on that axis, so a type that first appears in the journal after the
// view was opened is always visible.
var _act = {
  records: [], types: [], actors: [],
  selTypes: {}, selActors: {},
  showAll: false
};

// The filter value for a record's actor: a username, or the kind. Mirrors the
// server's _activity_actor_key so both sides group the same way.
function _actActorKey(r) {
  // A named person is the notable case. Everything else — an explicit server
  // action, or a pre-tracking record with no actor at all — is the server's
  // own doing, so it groups as one "Server" rather than splitting into a
  // mysterious dash beside it (Eric: "replace my '-' with Server... why are
  // they not grouping like that already?").
  var a = r.actor || {};
  return (a.kind === 'user' && a.name) ? a.name : 'server';
}
// Pre-1.9 history has no actor, and "Unknown" read as an accusation — as
// though somebody had done this and Zimi would not say who. An em-dash is the
// truthful shape: there is nothing in this column, because nothing was ever
// recorded there. The sentence explaining that lives in the tooltip, where a
// sentence fits, and the chip stays dim so the eye skips it.
var ACT_ACTOR_NONE = '—';

function _actActorLabel(key) {
  if (key === 'server') return t('act_actor_server');
  if (key === 'unknown') return ACT_ACTOR_NONE;
  return key;
}

// The hover sentence for an actor chip, or '' for one that needs none. Two
// values are jargon to everyone who did not build this: the em-dash, and
// "admin" — which is not a username but the password holder, and is worth
// distinguishing from a person with an account of that name.
function _actActorTitle(key) {
  if (key === 'unknown') return t('act_actor_unknown_hint');
  if (key === 'admin') return t('act_actor_admin_hint');
  return '';
}
function _actTypeLabel(type) {
  var key = 'act_type_' + type;
  var label = t(key);
  return label === key ? type : label;
}
// The verb for a row: past tense when it worked ("Downloaded"), the noun plus
// what went wrong when it didn't ("Download · Failed").
function _actVerb(r) {
  if (r.outcome === 'ok') {
    var key = 'act_ev_' + r.type;
    var verb = t(key);
    return verb === key ? _actTypeLabel(r.type) : verb;
  }
  return _actTypeLabel(r.type) + ' · ' + t('act_out_' + r.outcome);
}

function _actFilterCount() {
  return Object.keys(_act.selTypes).length + Object.keys(_act.selActors).length;
}
function _actVisibleRecords() {
  var anyType = Object.keys(_act.selTypes).length > 0;
  var anyActor = Object.keys(_act.selActors).length > 0;
  return _act.records.filter(function(r) {
    return (!anyType || _act.selTypes[r.type]) &&
           (!anyActor || _act.selActors[_actActorKey(r)]);
  });
}

// The live library record for a journal subject, when the ZIM is still here —
// it carries the icon and makes the row clickable. Matched on title first
// (what the journal stores) and on name second (what an older record or a
// filename-derived subject looks like).
function _actZim(subject) {
  if (!subject || !zimsCache) return null;
  return zimsCache.find(function(z) { return z.title === subject; }) ||
         zimsCache.find(function(z) { return z.name === subject; }) || null;
}

async function renderActivityLog(refetch) {
  const el = document.getElementById('manage-history');
  if (!el) return;
  if (refetch !== false || !_act.records.length) {
    el.innerHTML = _loadingHtml();
    try {
      const res = await manageFetch('/manage/activity-log');
      const data = await res.json();
      _act.records = data.records || [];
      _act.types = data.types || [];
      _act.actors = data.actors || [];
    } catch (e) {
      el.innerHTML = '<div class="empty"><p>' + tH('could_not_load') + '</p></div>';
      return;
    }
  }
  el.innerHTML = _actHeaderHtml() + _actListHtml();
}

// The filters, as two rows of pills across the top rather than a popover.
//
// A popover was the wrong container for this. Filtering here is the normal way
// to read the journal, not an occasional adjustment — "what did the
// auto-updater do" and "what did I do" are the two questions the view exists
// to answer — and a filter you have to open, read, tick and dismiss makes the
// normal case the expensive one. It also hid its own state: the button showed
// a count, so the only way to see WHICH four things were off was to reopen the
// box. Pills are the state and the control at once, and they are the pattern
// the rest of the app already filters with.
function _actHeaderHtml() {
  // Nothing to filter yet: an empty journal gets the empty state, not a row of
  // pills with nothing behind them.
  if (!_act.records.length) return '';
  return '<div class="act-filters">' +
    _actPillRow(tH('act_filter_types'), _act.types, _act.selTypes, 'type', _actTypeLabel) +
    _actPillRow(tH('act_filter_who'), _act.actors, _act.selActors, 'actor', _actActorLabel) +
  '</div>';
}

// How many records carry one value on one axis, over the WHOLE journal rather
// than the filtered slice — the same rule the server follows for the
// vocabulary itself. A count that moved as you filtered would be telling you
// about your own clicks instead of about the library.
function _actAxisCount(kind, value) {
  var n = 0;
  for (var i = 0; i < _act.records.length; i++) {
    var r = _act.records[i];
    if ((kind === 'type' ? r.type : _actActorKey(r)) === value) n++;
  }
  return n;
}

// One axis. `sel` is the map of SELECTED values; empty means no filter, which
// is how the row comes up — every pill dark, everything showing, the Library
// view's own pill grammar. A lit pill is a filter you chose; tapping it again
// lets it go, so there is no All pill to keep true.
function _actPillRow(title, values, sel, kind, label) {
  if (!values.length) return '';
  var h = '<div class="act-filter-row">' +
    '<span class="act-filter-label">' + title + '</span>' +
    '<div class="pills-row act-filter-pills">';
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    var on = !!sel[v];
    var title2 = kind === 'actor' ? _actActorTitle(v) : '';
    // escJs, not escAttr: an entity-escaped quote decodes back to a live quote
    // inside the onclick JS string, and an actor value is a username somebody
    // else chose.
    h += '<button class="pill act-pill' + (on ? ' active' : '') + '"' +
      ' aria-pressed="' + (on ? 'true' : 'false') + '"' +
      (title2 ? ' title="' + escAttr(title2) + '"' : '') +
      ' onclick="_actToggleFilter(\'' + kind + '\', \'' + escJs(v) + '\')">' +
      esc(label(v)) + ' <span class="pill-count">' + _actAxisCount(kind, v) + '</span>' +
    '</button>';
  }
  return h + '</div></div>';
}

function _actListHtml() {
  var all = _actVisibleRecords();
  if (!all.length) {
    if (_actFilterCount()) {
      return '<div class="empty"><p>' + tH('act_empty_filtered') + '</p>' +
        '<p class="hint"><a href="#" onclick="_actClearFilters();return false">' + tH('act_filter_clear') + '</a></p></div>';
    }
    return '<div class="empty"><p>' + tH('act_empty') + '</p><p class="hint">' + tH('act_empty_hint') + '</p></div>';
  }
  var capped = !_act.showAll && all.length > _ACT_RENDER_CAP;
  var records = capped ? all.slice(0, _ACT_RENDER_CAP) : all;
  var h = '';
  var day = null;
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var d = new Date((r.ts || 0) * 1000);
    var key = d.toLocaleDateString(_currentLang || 'en', {year: 'numeric', month: 'short', day: 'numeric'});
    if (key !== day) {
      if (day !== null) h += '</div>';
      h += '<div class="act-day"><div class="ci-section-label">' + esc(key) + '</div>';
      day = key;
    }
    h += _actRowHtml(r);
  }
  if (day !== null) h += '</div>';
  if (capped) {
    h += '<button class="dl-clear-btn hist-show-all" onclick="_actRevealAll()">' +
      tH('show_all_n', {n: all.length}) + '</button>';
  }
  return h;
}

function _actRowHtml(r) {
  var fallback = _ACT_SUBJECT_FALLBACK[r.type];
  var subject = r.subject || (fallback ? t(fallback) : _actTypeLabel(r.type));
  var zim = _actZim(r.subject);
  var icon = (zim && zim.has_icon && zim.name)
    ? '<img src="/w/' + encodeURIComponent(zim.name) + '/-/icon" alt="" width="40" height="40" loading="lazy">'
    : (_ACT_GLYPHS[r.type] || _ACT_FALLBACK_GLYPH);

  var meta = ['<span class="act-verb' + (r.outcome === 'ok' ? '' : ' bad') + '">' + esc(_actVerb(r)) + '</span>'];
  if (r.bytes) meta.push('<span>' + fmtBytes(r.bytes) + '</span>');
  if (r.count && _ACT_COUNT_LABEL[r.type]) {
    meta.push('<span>' + esc(t(_ACT_COUNT_LABEL[r.type], {n: r.count})) + '</span>');
  }
  if (r.detail) meta.push('<span class="act-detail">' + esc(r.detail) + '</span>');

  var actorKey = _actActorKey(r);
  var actorTitle = _actActorTitle(actorKey);
  var chip = '<span class="act-chip act-chip-' + esc(actorKey === 'server' || actorKey === 'unknown' ? actorKey : 'user') + '"' +
    (actorTitle ? ' title="' + escAttr(actorTitle) + '"' : '') + '>' +
    esc(_actActorLabel(actorKey)) + '</span>';

  return '<div class="catalog-item act-row"' +
      (zim ? ' style="cursor:pointer" onclick="enterSource(\'' + escJs(zim.name) + '\',true)"' : '') + '>' +
    '<div class="ci-icon act-icon">' + icon + '</div>' +
    '<div class="ci-info">' +
      '<div class="ci-title">' + esc(subject) + '</div>' +
      '<div class="ci-meta">' + meta.join(' &middot; ') + '</div>' +
    '</div>' +
    '<div class="ci-actions act-side">' + chip +
      '<span class="act-time">' + esc(_relTime(r.ts)) + '</span>' +
    '</div>' +
  '</div>';
}

// Repaint from the records already in hand — filtering never re-fetches.
function _actRepaint() { renderActivityLog(false); }

function _actToggleFilter(kind, value) {
  var sel = kind === 'type' ? _act.selTypes : _act.selActors;
  if (sel[value]) delete sel[value]; else sel[value] = true;
  _actRepaint();
}
function _actClearFilters() {
  _act.selTypes = {};
  _act.selActors = {};
  _actRepaint();
}

function _actRevealAll() { _act.showAll = true; _actRepaint(); }

// ── Stats tab (merged server stats + usage) ──
async function renderActivityTab() {
  const el = document.getElementById('manage-activity');
  if (!el) return;
  el.innerHTML = _loadingHtml();
  try {
    const [statsRes, usageRes] = await Promise.all([
      // detail=1: this is the one view that renders the per-index list, and
      // the only caller worth the walk over every title index on disk.
      manageFetch('/manage/stats?detail=1').catch(() => null),
      manageFetch('/manage/usage').catch(() => null)
    ]);
    let h = '';

    // Server stats section
    if (statsRes && statsRes.ok) {
      const sdata = await statsRes.json();
      const m = sdata.metrics || {};
      const d = sdata.disk || {};
      const au = sdata.auto_update || {};
      // Sync auto-update dropdown on Library Status card
      const freqSel = document.getElementById('auto-update-freq');
      if (freqSel) freqSel.value = au.enabled ? (au.frequency || 'weekly') : 'disabled';
      const uptime = m.uptime_seconds || 0;
      const uptimeStr = uptime < 3600 ? Math.round(uptime / 60) + 'm' :
                        uptime < 86400 ? Math.round(uptime / 3600) + 'h' :
                        Math.round(uptime / 86400) + 'd';
      h += '<div class="manage-card"><h2>' + tH('server') + '</h2>';
      h += '<div class="mc-row"><span class="mc-label">' + tH('uptime') + '</span><span class="mc-value">' + uptimeStr + '</span></div>';
      h += '<div class="mc-row"><span class="mc-label">' + tH('requests') + '</span><span class="mc-value">' + (m.total_requests || 0) + '</span></div>';
      if (m.endpoints) {
        const eps = Object.entries(m.endpoints).sort((a,b) => b[1].count - a[1].count).slice(0, 5);
        for (const [ep, info] of eps) {
          h += '<div class="mc-row" style="padding-left:16px"><span class="mc-label" style="font-size:12px">' + esc(ep) + '</span><span class="mc-value" style="font-size:12px">' + info.count + ' (' + info.avg_latency_ms + 'ms avg)</span></div>';
        }
      }
      if (m.rate_limited) h += '<div class="mc-row"><span class="mc-label">' + tH('rate_limited') + '</span><span class="mc-value" style="color:var(--amber)">' + m.rate_limited + '</span></div>';
      if (d.zim_size_gb) h += '<div class="mc-row"><span class="mc-label">' + tH('zim_disk_usage') + '</span><span class="mc-value">' + d.zim_size_gb + ' GB</span></div>';
      if (d.disk_free_gb) h += '<div class="mc-row"><span class="mc-label">' + tH('disk_free') + '</span><span class="mc-value">' + d.disk_free_gb + ' GB</span></div>';
      if (sdata.linked_zims) h += '<div class="mc-row"><span class="mc-label">' + tH('cross_linked') + '</span><span class="mc-value">' + sdata.linked_zims + ' of ' + sdata.zim_count + ' sources <span style="color:var(--text2);font-size:11px">(' + sdata.domain_count + ' ' + tH('domains') + ')</span></span></div>';
      h += '</div>';

      // Save title_index data for rendering after usage
      var _ti = sdata.title_index;
      var _xzimRefs = sdata.cross_zim_refs;
    }

    // Usage stats section (above title index — more relevant to user)
    if (usageRes && usageRes.ok) {
      const data = await usageRes.json();
      h += '<div class="manage-card"><h2>' + tH('usage') + '</h2>';
      h += '<div class="mc-row"><span class="mc-label">' + tH('total_searches') + '</span><span class="mc-value">' + (data.searches || 0) + '</span></div>';
      h += '<div class="mc-row"><span class="mc-label">' + tH('total_reads') + '</span><span class="mc-value">' + (data.article_reads || 0) + '</span></div>';
      h += '</div>';

      const topZims = data.top_zims || [];
      if (topZims.length > 0) {
        h += '<div class="manage-card"><h2>' + tH('top_sources') + '</h2>';
        for (const z of topZims) {
          const info = _zimInfo(z.name);
          const title = info ? (info.title || z.name) : z.name;
          const total = (z.reads || 0) + (z.searches || 0);
          h += '<div class="mc-row"><span class="mc-label">' + esc(title) + '</span>' +
            '<span class="mc-value">' + total + ' <span style="font-weight:400;color:var(--text2);font-size:11px">(' + (z.reads || 0) + ' ' + t('reads') + ', ' + (z.searches || 0) + ' ' + t('searches') + ')</span></span></div>';
        }
        h += '</div>';
      }
    }

    // Search index card (compact, below usage)
    if (typeof _ti !== 'undefined' && _ti) {
      const ti = _ti;
      h += '<div class="manage-card"><h2>' + tH('search_index') + '</h2>';

      // Building state
      if (ti.state === 'building') {
        h += '<div class="mc-row"><span class="mc-label">' + tH('building_indexes') + '</span><span class="mc-value" style="color:var(--amber)">' +
          (ti.building_now ? esc(ti.building_now) + '&hellip;' : tH('in_progress')) + '</span></div>';
      }

      // Categorize indexes — use ti.total (all ZIMs) as denominator, not just indexed ones
      const allIdx = ti.indexes || [];
      const withFts = allIdx.filter(x => x.has_fts && x.entries > 0);
      const noFts = allIdx.filter(x => !x.has_fts && x.entries > 0);
      const totalZims = ti.total || 0;
      const building = ti.state === 'building';

      // Title index row
      if (building) {
        h += '<div class="mc-row"><span class="mc-label">' + tH('title_index') + '</span><span class="mc-value" style="color:var(--amber)">' +
          tH('n_of_total', {n: ti.ready, total: totalZims}) +
          (ti.building_now ? ' <span style="font-size:11px">(' + esc(ti.building_now) + '&hellip;)</span>' : '') +
          '</span></div>';
      } else if (ti.ready < totalZims) {
        h += '<div class="mc-row"><span class="mc-label">' + tH('title_index') + '</span><span class="mc-value">' + tH('n_of_total', {n: ti.ready, total: totalZims}) + '</span></div>';
      } else {
        h += '<div class="mc-row"><span class="mc-label">' + tH('title_index') + '</span><span class="mc-value">' + t('n_sources', {n: totalZims}) + '</span></div>';
      }

      // Full-text index row — denominator is total ZIMs, not just ones with title indexes
      const ftsTotal = building ? totalZims : totalZims;  // always use total ZIMs
      if (withFts.length >= ftsTotal && ftsTotal > 0 && !building) {
        h += '<div class="mc-row"><span class="mc-label">' + tH('fulltext_index') + '</span><span class="mc-value">' + t('n_sources', {n: ftsTotal}) + '</span></div>';
      } else {
        h += '<div class="mc-row"><span class="mc-label">' + tH('fulltext_index') + '</span><span class="mc-value">' + tH('n_of_total', {n: withFts.length, total: ftsTotal}) + '</span></div>';
      }

      // Errors
      if (ti.errors && ti.errors.length > 0) {
        for (const [name, err] of ti.errors) {
          h += '<div class="mc-row"><span class="mc-label" style="color:var(--amber)">' + esc(name) + '</span><span class="mc-value" style="font-size:11px;color:var(--text2)">' + esc(err) + '</span></div>';
        }
      }

      // Sources without FTS — show build options (only when not actively building title indexes)
      if (noFts.length > 0 && !building) {
        h += '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">';
        h += '<div style="font-size:12px;color:var(--text2);margin-bottom:4px">' + tH('fts_hint') + '</div>';
        for (const idx of noFts) {
          const sizeLbl = fmtBytes((idx.size_mb || 0) * BYTES_PER_MB);
          const estMin = Math.max(1, Math.ceil(idx.size_mb / 500));
          const timeLbl = estMin >= 60 ? Math.round(estMin / 60) + ' hr' : '~' + estMin + ' min';
          h += '<div class="mc-row" style="align-items:center"><span class="mc-label">' + esc(idx.name) + ' <span style="color:var(--text2);font-weight:400">(' + sizeLbl + ', ' + timeLbl + ')</span></span>';
          h += '<button onclick="buildFts(\'' + escAttr(idx.name) + '\', this)" style="font-size:11px;padding:3px 10px;cursor:pointer;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text1);white-space:nowrap">' + tH('build') + '</button>';
          h += '</div>';
        }
        h += '</div>';
      }
      h += '</div>';
    }

    // Cross-ZIM references
    var xrefs = (typeof _xzimRefs !== 'undefined') ? _xzimRefs : null;
    if (xrefs && xrefs.length > 0) {
      h += '<div class="manage-card"><h2>' + tH('cross_zim_nav') + '</h2>';
      h += '<div style="display:flex;flex-direction:column;gap:4px">';
      for (var xi = 0; xi < xrefs.length && xi < 20; xi++) {
        var xr = xrefs[xi];
        h += '<div style="display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 8px;background:var(--surface);border-radius:6px">';
        h += '<span style="color:var(--text)">' + esc(xr.from) + '</span>';
        h += '<span style="color:var(--text2)">\u2192</span>';
        h += '<span style="color:var(--text)">' + esc(xr.to) + '</span>';
        h += '<span style="margin-inline-start:auto;color:var(--text2);font-size:11px">' + xr.count + ' link' + (xr.count !== 1 ? 's' : '') + '</span>';
        h += '</div>';
      }
      h += '</div></div>';
    }

    if (!h) {
      h = '<div style="text-align:center;padding:24px;color:var(--text2);font-size:13px">' + tH('no_stats_yet') + '</div>';
    }
    h += '<div style="text-align:center;padding:8px;font-size:11px;color:var(--text2);opacity:0.5">' + tH('stats_in_memory') + '</div>';
    el.innerHTML = h;
  } catch(e) {
    el.innerHTML = '<div class="empty"><p>' + tH('could_not_load_stats') + '</p></div>';
  }
}

// ── Manage entry point ──
// Passwordless instance reachable from a non-private network: there is no
// password to enter, so explain the LAN-only state instead of prompting (#36).
function _renderManagePublicLocked() {
  // Two locked shapes. Without a password AND off-host, the door is the
  // one-time setup key the server logged — so offer a field for it, which on
  // success sets the first admin password in the same step. Otherwise (the
  // pre-existing #36 case) just explain the LAN-only state.
  if (_manageNeedsSetupKey) {
    output.innerHTML =
      '<div class="manage-wrap"><div class="lang-welcome-card manage-locked-card">' +
        '<div class="lang-welcome-text">' +
          '<strong>' + tH('manage_setup_key_title') + '</strong>' +
          '<p>' + tH('manage_setup_key_body') + '</p>' +
          '<div class="ms-user-add" style="max-width:340px;margin-top:12px">' +
            '<input type="text" id="setup-key-input" autocomplete="off" spellcheck="false" ' +
              'autocapitalize="characters" placeholder="XXXX-XXXX-XXXX">' +
            '<input type="password" id="setup-pw-input" autocomplete="new-password" ' +
              'placeholder="' + escAttr(tH('manage_setup_key_pw_ph')) + '" style="margin-top:8px">' +
            '<div class="pw-actions" style="margin-top:10px">' +
              '<button class="ms-btn ms-btn-primary" onclick="_submitSetupKey()">' +
                tH('manage_setup_key_submit') + '</button>' +
            '</div>' +
            '<div class="pw-error" id="setup-key-error"></div>' +
          '</div>' +
        '</div>' +
      '</div></div>';
    return;
  }
  output.innerHTML =
    '<div class="manage-wrap">' +
      '<div class="lang-welcome-card manage-locked-card">' +
        '<div class="lang-welcome-text">' +
          '<strong>' + tH('manage_public_locked_title') + '</strong>' +
          '<p>' + tH('manage_public_locked_body') + '</p>' +
        '</div>' +
      '</div>' +
    '</div>';
}

// Spend the setup key: set the first admin password with the key as the
// bearer authorization the bootstrap gate accepts, then sign in with the
// password just set. One gesture from a locked remote client to full admin.
async function _submitSetupKey() {
  var key = (document.getElementById('setup-key-input') || {}).value || '';
  var pw = (document.getElementById('setup-pw-input') || {}).value || '';
  var err = document.getElementById('setup-key-error');
  key = key.trim();
  if (!key || !pw) {
    if (err) { err.textContent = tH('manage_setup_key_needboth'); err.style.display = 'block'; }
    return;
  }
  try {
    var res = await fetch('/manage/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zimi-Setup-Key': key },
      body: JSON.stringify({ password: pw })
    });
    if (!res.ok) {
      if (err) { err.textContent = tH('manage_setup_key_bad'); err.style.display = 'block'; }
      return;
    }
    // Password is set; the key is spent. Authenticate with it and enter.
    _manageNeedsSetupKey = false;
    _managePublicLocked = false;
    _manageToken = pw;
    _saveManageToken(pw);
    location.reload();
  } catch (e) {
    if (err) { err.textContent = tH('manage_setup_key_bad'); err.style.display = 'block'; }
  }
}

async function renderManage() {
  if (_managePublicLocked) { _renderManagePublicLocked(); return; }
  // A signed-in non-admin has no admin console. Show their minimal account card
  // (name, access scope, log out) — never the manage tabs, and never a
  // /manage/status call (it would 401 and re-prompt for sign-in).
  if (_userSession && !_manageToken) { _renderUserManage(); return; }
  const installedCount = zimsCache ? zimsCache.length : 0;

  output.innerHTML =
    '<div class="manage-wrap">' +
    '<div class="manage-tabs">' +
      // Settings lives in its own first tab on every viewport.
      '<button class="manage-tab manage-tab-settings' + (manageTab === 'settings' ? ' active' : '') + '" data-tab="settings" onclick="switchManageTab(\'settings\')">' + tH('ms_settings_tab') + '</button>' +
      '<button class="manage-tab' + (manageTab === 'browse' ? ' active' : '') + '" data-tab="browse" onclick="switchManageTab(\'browse\')">' + tH('catalog_tab') + '</button>' +
      '<button class="manage-tab' + (manageTab === 'installed' ? ' active' : '') + '" data-tab="installed" onclick="switchManageTab(\'installed\')">' + tH('installed_tab') + '</button>' +
      '<button class="manage-tab' + (manageTab === 'collections' ? ' active' : '') + '" data-tab="collections" onclick="switchManageTab(\'collections\')">' + tH('collections_tab') + '</button>' +
      '<button class="manage-tab' + (manageTab === 'downloads' ? ' active' : '') + '" data-tab="downloads" onclick="switchManageTab(\'downloads\')">' + tH('downloads') + '<span id="dl-tab-badge" class="dl-tab-badge" style="display:none"></span></button>' +
      '<button class="manage-tab' + (manageTab === 'history' ? ' active' : '') + '" data-tab="history" onclick="switchManageTab(\'history\')">' + tH('activity_tab') + '</button>' +
    '</div>' +
'<div id="manage-status" class="manage-settings' + (manageTab === 'settings' ? ' as-tab-active' : '') + '">' +
      '<div class="ms-nav" id="ms-nav">' +
        '<button class="ms-nav-item active" data-ms="library" onclick="switchMs(\'library\')">' + tH('ms_library') + '</button>' +
        '<button class="ms-nav-item" data-ms="preferences" onclick="switchMs(\'preferences\')">' + tH('ms_display') + '</button>' +
        '<button class="ms-nav-item" data-ms="creator" onclick="switchMs(\'creator\')">' + tH('ms_creator') + '</button>' +
        '<button class="ms-nav-item" data-ms="server" onclick="switchMs(\'server\')">' + tH('ms_server') + '</button>' +
        '<button class="ms-nav-item" data-ms="users" onclick="switchMs(\'users\')">' + tH('ms_users') + '</button>' +
      '</div>' +
      '<div id="ms-pane" class="ms-pane"><div class="loading"><span class="spinner-inline"></span>Loading\u2026</div></div>' +
    '</div>' +
    '<div id="manage-installed" class="manage-tab-content' + (manageTab === 'installed' ? ' active' : '') + '"></div>' +
    '<div id="manage-downloads" class="manage-tab-content' + (manageTab === 'downloads' ? ' active' : '') + '"></div>' +
    '<div id="manage-collections" class="manage-tab-content' + (manageTab === 'collections' ? ' active' : '') + '"></div>' +
    '<div id="manage-history" class="manage-tab-content' + (manageTab === 'history' ? ' active' : '') + '"></div>' +
    '<div id="manage-browse" class="manage-tab-content' + (manageTab === 'browse' ? ' active' : '') + '">' +
      '<div id="catalog-results"></div>' +
    '</div>' +
    '</div>';

  // Status card — fetch data and render into settings panel
  try {
    const res = await manageFetch('/manage/status');
    const data = await res.json();
    _manageStatusData = data;
    switchMs('library');
    // Warm the Server-pane fetches now (token is set from the status call
    // above, so these won't trigger a second auth prompt) — the Server pane
    // then paints from fresh data instead of the OFF-default shell.
    _prefetchServerSettings();
    // Honor a deep-link (card menu → "Reorder sections…") once the view mounts.
    if (_pendingMsSection) { var _ms = _pendingMsSection; _pendingMsSection = null; switchMs(_ms); }
    // Sync auto-update dropdown from server
    const au = data.auto_update || {};
    const freqSel = document.getElementById('auto-update-freq');
    if (freqSel) {
      freqSel.value = au.enabled ? (au.frequency || 'weekly') : 'disabled';
      if (au.locked) {
        freqSel.disabled = true;
        freqSel.title = t('au_controlled_by_env');
        freqSel.style.opacity = '0.5';
      }
    }
    // The Updates line is refreshed by switchMs('library') above (and on every
    // library re-mount), so no separate check is needed here.
  } catch(e) {
    var pane = document.getElementById('ms-pane');
    if (pane) pane.innerHTML = '<div style="color:var(--text2);font-size:13px">' + tH('could_not_load_stats') + '</div>';
  }

  // Render active tab content
  pillsBar.innerHTML = ''; pillsBar.style.display = 'none'; pillsBar.className = 'pills';
  if (manageTab === 'installed') {
    renderInstalled();
  } else if (manageTab === 'collections') {
    renderCollectionsTab();
  } else if (manageTab === 'history') {
    renderActivityLog();
  } else if (manageTab === 'activity') {
    renderActivityTab();
  } else {
    if (manageCategoryFilter) {
      drillCategory(manageCategoryFilter);
    } else {
      renderBrowseGallery();
    }
  }
  refreshDownloads();
  // Pre-fetch catalog in background so flavor pills can populate on installed tab
  if (!_catalogCache) {
    loadFullCatalog().then(() => { if (manageTab === 'installed') renderInstalled(); }).catch(() => {});
  }
}

// The minimal Manage view a signed-in non-admin sees: who they are, their
// access scope, and Log out. No admin powers, no self password change (the
// light version has no self-service endpoint — an admin resets it from Users).
function _renderUserManage() {
  var name = (_userSession && _userSession.name) || '';
  var restricted = !!(_userSession && _userSession.restricted);
  var role = restricted ? 'limited' : 'user';
  var scope = restricted ? tH('users_scope_limited') : tH('users_all_access');
  output.innerHTML =
    '<div class="manage-wrap"><div style="max-width:520px;margin:16px auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px">' +
      '<div class="ms-section-label">' + tH('ms_users') + '</div>' +
      '<div class="ms-user-row" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">' +
        '<span style="flex:1"><strong>' + esc(name) + '</strong> ' + _roleBadge(role) +
        ' <span style="color:var(--text2);font-size:12px">' + scope + '</span></span>' +
      '</div>' +
      '<div class="ms-actions" style="margin-top:16px">' +
        '<button class="manage-btn-action" onclick="userLogout()" style="background:var(--surface2);color:var(--text);border:1px solid var(--border)">' + tH('log_out') + '</button>' +
      '</div>' +
      // A signed-in user's own "My data" card: export/import a file, or sync
      // bookmarks/history/preferences to their server account (Save/Restore).
      '<div style="border-top:1px solid var(--border);margin-top:18px;padding-top:14px">' +
        _myDataCardHtml() +
      '</div>' +
    '</div></div>';
}

// ── macOS-style settings panel sections ──
var _msSection = 'library';
var _manageStatusData = null;

// ── Server-settings prefetch ──────────────────────────────────────────────
// Entering the manage view fires the Server-pane fetches immediately and in
// parallel, so by the time the user opens the Server sub-pane the data is
// already in flight or resolved — no slow serial load, no flash of OFF-default
// toggles. Entries are single-use: a re-render triggered by a user action
// (toggling a setting) always refetches fresh, so the cache can never serve a
// stale value back over a change the user just made.
var _msPrefetch = {};              // url -> { ts, promise-of-parsed-json }
var _MS_PREFETCH_TTL = 15000;      // 15s: bridges entry → first server-pane paint

function _msJson(r) {
  if (!r || !r.ok) throw new Error('http ' + (r && r.status));
  return r.json();
}
function _msDefaultFetcher(url) {
  return function() { return manageFetch(url).then(_msJson); };
}
function _msFetch(url, fetcher) {
  // Consume a fresh prefetch if one exists; otherwise fetch now. Single-use.
  var e = _msPrefetch[url];
  if (e) {
    delete _msPrefetch[url];
    if ((Date.now() - e.ts) < _MS_PREFETCH_TTL) return e.promise;
  }
  return (fetcher || _msDefaultFetcher(url))();
}
function _msPrime(url, fetcher) {
  var p = (fetcher || _msDefaultFetcher(url))();
  _msPrefetch[url] = { ts: Date.now(), promise: p };
  p.catch(function() {});  // silence unhandled-rejection; consumers re-await
}
function _prefetchServerSettings() {
  _msPrime('/manage/mirror', function() { return authedFetch('/manage/mirror').then(_msJson); });
  _msPrime('/manage/bt-status');
  _msPrime('/manage/peers', function() { return authedFetch('/manage/peers').then(_msJson); });
  _msPrime('/manage/cache-info');
  _msPrime('/manage/hot');
  _msPrime('/manage/stats');
}

// Manage settings sections + the URL/session plumbing that lets a reload (or a
// fresh tap on Manage) land back on the section the user last had open.
var _MS_SECTIONS = ['library', 'preferences', 'creator', 'server', 'users'];
function _validMsSection(s) { return _MS_SECTIONS.indexOf(s) >= 0 ? s : null; }
function _msSectionUrl(section) { return (!section || section === 'library') ? '/?manage' : '/?manage=' + section; }
function _lastMsSection() {
  try { return _validMsSection(sessionStorage.getItem(SK.MANAGE_SECTION)); } catch (e) { return null; }
}

function switchMs(section) {
  _msSection = section;
  // Persist + reflect in the URL so a Safari reload of /?manage=<section>
  // (or re-entering Manage) restores this section instead of defaulting to
  // Library. replaceState keeps a single Manage history entry, consistent with
  // the existing ?manage routing (see route()/enterManage).
  try { sessionStorage.setItem(SK.MANAGE_SECTION, section); } catch (e) {}
  if (mode === 'manage') {
    try { history.replaceState({ mode: 'manage' }, '', _msSectionUrl(section)); } catch (e) {}
  }
  document.querySelectorAll('.ms-nav-item').forEach(function(b) {
    b.classList.toggle('active', b.dataset.ms === section);
  });
  var pane = document.getElementById('ms-pane');
  if (!pane) return;
  switch(section) {
    case 'library': pane.innerHTML = _msLibraryHtml(); break;
    case 'preferences': pane.innerHTML = _msPreferencesHtml(); break;
    case 'creator': pane.innerHTML = _msCreatorHtml(); break;
    case 'server': pane.innerHTML = _msServerHtml(); break;
    case 'users': _renderMsUsers(); break;
  }
  // The library pane owns the Updates line — refresh it on every mount so a
  // re-entry (nav away and back) never re-renders "Checking…" and then strands
  // there. checkForUpdates repaints instantly from cache when it's fresh.
  if (section === 'library') {
    _renderUpdatesSummary();
    checkForUpdates();
    _renderAutoUpdateSection();
  }
}

// ── Users management (admin-only, multi-user v1) ──
var _usersData = null;  // { users:[...], zims:[names] } from /manage/users

function _renderMsUsers() {
  var pane = document.getElementById('ms-pane');
  if (!pane) return;
  pane.innerHTML = '<div class="loading"><span class="spinner-inline"></span>' + tH('loading') + '</div>';
  manageFetch('/manage/users').then(function(res) { return res.json(); }).then(function(data) {
    _usersData = data;
    if (_msSection === 'users') pane.innerHTML = _msUsersHtml();
  }).catch(function() {
    pane.innerHTML = '<div style="color:var(--text2);font-size:13px">' + tH('could_not_load_stats') + '</div>';
  });
}

// Role → localized badge. Admin gets the amber badge; user/limited are muted.
function _roleBadge(role) {
  var key = role === 'admin' ? 'users_role_admin' : (role === 'limited' ? 'users_role_limited' : 'users_role_user');
  var cls = role === 'admin' ? 'ms-role-badge ms-role-admin' : 'ms-role-badge';
  return '<span class="' + cls + '">' + tH(key) + '</span>';
}

// One user row: name + role badge + scope · last-seen, with a single ⋯ menu
// holding every mutation (set password / change role / edit allowlist / delete).
// No controls are visible at rest — the menu is the only affordance. `opts`
// carries the trailing ⋯ button (empty for the never-managed primary admin).
function _userRowHtml(name, role, meta, menuAttr) {
  return '<div class="ms-user-row">' +
    '<span class="ms-user-main"><strong>' + esc(name) + '</strong> ' + _roleBadge(role) +
    (meta ? ' <span class="ms-user-meta">' + meta + '</span>' : '') + '</span>' +
    (menuAttr
      ? '<button class="ci-gear ms-user-menu-btn" ' + menuAttr + '>⋯</button>'
      : '') +
  '</div>';
}

function _msUsersHtml() {
  var d = _usersData || { users: [], zims: [] };
  var isPrimary = d.self_kind === 'primary';
  var selfName = _manageAccountName();

  // (a) Your Account FIRST — the signed-in admin, with Change password and Log
  // out as visible buttons (no ⋯ for your own row). This is where password/logout
  // live, moved out of Preferences → Security.
  var h = '<div class="ms-user-account ms-user-account-self">' +
    '<div class="ms-section-label">' + tH('users_your_account') + '</div>' +
    '<div class="ms-user-row">' +
      '<span class="ms-user-main"><strong>' + esc(selfName) + '</strong> ' + _roleBadge('admin') + '</span>' +
      '<span class="ms-user-self-actions">' +
        '<button class="ms-btn" onclick="managePassword()">' + tH('change_password') + '</button>' +
        (_hasStoredManageToken()
          ? '<button class="ms-btn" onclick="manageLogout()">' + tH('log_out') + '</button>'
          : '') +
      '</span>' +
    '</div>' +
  '</div>';

  // (b) Everyone else. Build the list excluding yourself, so a single-admin
  // install shows no list at all (no self-duplication). A secondary admin sees
  // the primary admin (never manageable) plus the other named users.
  var others = [];
  if (d.primary_admin && !isPrimary) {
    others.push({ name: d.primary_admin.name, role: 'admin', _primary: true });
  }
  d.users.forEach(function(u) {
    if (!isPrimary && u.name === selfName) return; // that's you — already shown above
    others.push(u);
  });

  // Public access card — governs what an ANONYMOUS visitor sees. Sits above the
  // user list because it is the broadest policy on the page.
  h += _publicAccessCard();

  h += '<div class="ms-users-section">';
  // Titled like the two cards above it (Your account / Public access), so the
  // pane reads as three named sections instead of an unlabeled list.
  h += '<div class="ms-section-label">' + tH('ms_users') + '</div>';
  h += '<div class="ms-users-intro">' + tH('users_intro') + '</div>';
  if (others.length) {
    h += '<div class="ms-users-list">';
    others.forEach(function(u) {
      // The primary admin: amber ADMIN badge + label, never manageable (no ⋯).
      if (u._primary) {
        h += _userRowHtml(u.name, 'admin', tH('users_primary_admin'), '');
        return;
      }
      // A secondary admin cannot manage other admins (server enforces; UI hides).
      var canManage = isPrimary || u.role !== 'admin';
      var scopeText = u.role === 'limited'
        ? (u.all_access ? tH('users_all_access') : (u.allowlist.length + ' ' + tH('users_zim_count')))
        : tH('users_all_access');
      // Limited scope doubles as the discoverable entry point to editing the
      // allowlist — clicking "7 ZIMs" on the row opens the picker directly.
      var scope = (u.role === 'limited' && canManage)
        ? '<a class="ms-user-scope-link" onclick="event.stopPropagation();_editUserAllowlist(' + escAttr(JSON.stringify(u.name)) + ')" title="' + escAttr(t('users_edit_allowlist')) + '">' + scopeText + '</a>'
        : scopeText;
      // Last-login: relative time (localized) or "never signed in".
      var seen = u.last_login
        ? tH('users_last_login') + ' ' + esc(_relTime(u.last_login))
        : tH('users_last_never');
      // Surface the create grant on the row itself — the toggle lives in the
      // ⋯ menu, but a permission nobody can see is a permission nobody audits.
      if (u.can_create && u.role !== 'admin') seen += ' · ' + tH('users_can_create');
      var menuAttr = canManage
        ? 'onclick="event.stopPropagation();_openUserMenu(this,' + escAttr(JSON.stringify(u.name)) + ')" title="' + escAttr(t('users_options')) + '" aria-label="' + escAttr(t('users_options')) + '" aria-haspopup="menu"'
        : '';
      h += _userRowHtml(u.name, u.role, scope + ' · ' + seen, menuAttr);
    });
    h += '</div>';
  }
  // Add user: one button; the form is revealed only on demand (no fields at rest).
  h += '<div class="ms-user-addbar">' +
    '<button class="ms-btn ms-btn-primary" id="add-user-toggle" onclick="_toggleAddUser()">+ ' + tH('users_add') + '</button>' +
    '<div id="add-user-form" class="ms-user-add" hidden>' +
      '<input id="new-user-name" type="text" placeholder="' + escAttr(tH('users_name_ph')) + '" autocomplete="username" maxlength="32">' +
      '<input id="new-user-pw" type="password" placeholder="' + escAttr(tH('password')) + '" autocomplete="new-password">' +
      '<div class="ms-form-label">' + tH('users_access_label') + '</div>' +
      _rolePills('new-user', 'user', isPrimary) +
      '<div id="new-user-allowlist" style="display:none;margin-top:8px">' + _allowlistPicker([]) + '</div>' +
      // Creation, as its own labeled line: a regular user defaults to NOT
      // creating and the checkbox is the explicit grant. The WHOLE section
      // disappears when the admin role is picked — admin means everything, so
      // a creation control there is noise (Eric: "Admin means all we get it").
      '<div id="new-user-creation">' +
        '<div class="ms-form-label">' + tH('users_creation_label') + '</div>' +
        '<label class="ms-check-row"><input type="checkbox" id="new-user-can-create"> ' +
          tH('users_can_create') + '</label>' +
      '</div>' +
      '<div id="new-user-error" class="pw-error" style="display:none"></div>' +
      '<div class="ms-actions">' +
        '<button class="ms-btn ms-btn-primary" onclick="_createUser()">' + tH('users_create') + '</button>' +
        '<button class="ms-btn" onclick="_toggleAddUser()">' + tH('cancel') + '</button>' +
      '</div>' +
    '</div>' +
  '</div>';
  h += '</div>';
  return h;
}

// Best-effort display name for the signed-in admin account card. The primary
// admin's name comes back with the users payload; a secondary admin falls back
// to its stored username, then a generic label.
function _manageAccountName() {
  var d = _usersData || {};
  if (d.self_kind === 'primary' && d.primary_admin) return d.primary_admin.name;
  return _readManageUser() || t('users_your_account');
}

// ⋯ menu for a managed user. Set password / Change role › / Edit allowlist
// (limited only) / Delete. Reuses the shared ctx-menu (keyboard-navigable).
function _openUserMenu(btn, name) {
  var u = ((_usersData && _usersData.users) || []).find(function(x) { return x.name === name; });
  if (!u) return;
  var isPrimary = _usersData && _usersData.self_kind === 'primary';
  var roles = [['user', 'users_role_user'], ['limited', 'users_role_limited']];
  if (isPrimary) roles.push(['admin', 'users_role_admin']);
  var h = '<div class="ctx-item" data-action="set-pw">' + tH('users_set_password') + '</div>';
  h += '<div class="ctx-item">' + tH('users_change_role') + ' ›<div class="ctx-sub">';
  roles.forEach(function(r) {
    h += '<div class="ctx-item" data-action="role" data-role="' + r[0] + '">' +
      (u.role === r[0] ? '✓ ' : '') + tH(r[1]) + '</div>';
  });
  h += '</div></div>';
  if (u.role === 'limited') {
    h += '<div class="ctx-item" data-action="allowlist">' + tH('users_edit_allowlist') + '</div>';
  }
  // Creation is a per-user grant only for non-admins — an admin creates
  // everything, so the row simply isn't there for them (no explanatory
  // subtitle either; admin means all).
  if (u.role !== 'admin') {
    h += '<div class="ctx-sep"></div>';
    h += '<div class="ctx-item" data-action="can-create">' + (u.can_create ? '✓ ' : '') + tH('users_can_create') + '</div>';
  }
  h += '<div class="ctx-sep"></div><div class="ctx-item danger" data-action="delete">' + tH('delete') + '</div>';
  var r = btn.getBoundingClientRect();
  window._openMenuAt(h, r.left, r.bottom + 2, function(action, item) {
    if (action === 'set-pw') _setUserPassword(name);
    else if (action === 'role') _setUserRole(name, item.dataset.role);
    else if (action === 'allowlist') _editUserAllowlist(name);
    else if (action === 'can-create') _setUserCanCreate(name, !u.can_create);
    else if (action === 'delete') _deleteUser(name);
  });
}

// Reveal / hide the add-user form (fields exist only while open).
function _toggleAddUser() {
  var form = document.getElementById('add-user-form');
  var toggle = document.getElementById('add-user-toggle');
  if (!form || !toggle) return;
  var open = form.hasAttribute('hidden');
  if (open) {
    form.removeAttribute('hidden');
    toggle.style.display = 'none';
    var nm = document.getElementById('new-user-name');
    if (nm) nm.focus();
  } else {
    form.setAttribute('hidden', '');
    toggle.style.display = '';
  }
}

// Localized relative time for a unix-seconds timestamp (e.g. "3 hours ago").
// Intl.RelativeTimeFormat handles every UI language with no per-language strings.
function _relTime(tsSec) {
  if (!tsSec) return '';
  var diff = Math.round(Date.now() / 1000 - tsSec);  // seconds elapsed (past → +)
  var units = [['year', 31536000], ['month', 2592000], ['week', 604800],
               ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  try {
    var rtf = new Intl.RelativeTimeFormat(_currentLang || 'en', { numeric: 'auto' });
    for (var i = 0; i < units.length; i++) {
      if (Math.abs(diff) >= units[i][1]) {
        return rtf.format(-Math.round(diff / units[i][1]), units[i][0]);
      }
    }
    return rtf.format(0, 'second');  // within the last second
  } catch (e) {
    return new Date(tsSec * 1000).toLocaleDateString();
  }
}

// Admin password reset (item 3): set a NEW password for any manageable user, no
// current password required — this is an admin override via the set-password
// action. A plain prompt keeps it self-contained (the pw modal is reserved for
// the sign-in / change-own-password flows).
function _setUserPassword(name) {
  var pw = prompt(t('users_set_password_prompt').replace('{name}', name));
  if (pw === null) return;  // cancelled
  pw = pw.trim();
  if (!pw) return;
  _usersPost({ action: 'set-password', name: name, password: pw }).then(function(r) {
    if (r.ok) {
      _usersData = r.j;
      _refreshUsersPane();
      _showToast(t('users_password_set').replace('{name}', name));
    } else {
      _showToast(t('users_create_failed'));
    }
  });
}

// Radio-pill role picker. `showAdmin` gates the Admin option to the primary
// admin (only the primary may create/promote secondary admins).
function _rolePills(idPrefix, selected, showAdmin) {
  var roles = [['user', 'users_role_user'], ['limited', 'users_role_limited']];
  if (showAdmin) roles.push(['admin', 'users_role_admin']);
  var h = '<div class="pills-row" id="' + idPrefix + '-role" role="radiogroup" aria-label="' + escAttr(tH('users_access_label')) + '">';
  roles.forEach(function(r) {
    var on = r[0] === selected;
    h += '<button type="button" class="pill' + (on ? ' active' : '') + '" role="radio" aria-checked="' + on + '" data-role="' + r[0] + '" onclick="_selectRole(\'' + idPrefix + '\', \'' + r[0] + '\')">' + tH(r[1]) + '</button>';
  });
  return h + '</div>';
}

function _selectRole(idPrefix, role) {
  var group = document.getElementById(idPrefix + '-role');
  if (group) group.querySelectorAll('.pill').forEach(function(p) {
    var on = p.getAttribute('data-role') === role;
    p.classList.toggle('active', on);
    p.setAttribute('aria-checked', on);
  });
  // Allowlist editor only makes sense for the limited role.
  var al = document.getElementById(idPrefix + '-allowlist');
  if (al) al.style.display = role === 'limited' ? 'block' : 'none';
  // Creation is meaningless for an admin (admin creates everything), so the
  // whole section disappears rather than turning into a subtitle.
  var creation = document.getElementById(idPrefix + '-creation');
  if (creation) creation.style.display = role === 'admin' ? 'none' : '';
}

function _selectedRole(idPrefix) {
  var el = document.querySelector('#' + idPrefix + '-role .pill.active');
  return el ? el.getAttribute('data-role') : 'user';
}

// Installed-ZIM options for the allowlist pickers: the rich server list
// (title + language + article_count) when present, else the bare names list
// mapped through the client title cache. Shared by the per-user Limited picker
// and the public-access Limited picker.
function _pickerOptions() {
  var d = _usersData || {};
  if (d.zim_options && d.zim_options.length) return d.zim_options;
  return (d.zims || []).map(function(name) {
    return {
      name: name,
      title: (typeof _zimTitle === 'function' ? _zimTitle(name) : '') || name,
      language: '',
      article_count: null
    };
  });
}

// Searchable, legible checklist of installed ZIMs. `selected` = array of chosen
// names. Renders real titles + language badges + article counts, a search box,
// select-all/none, and a live "N of M selected" summary. Every instance is
// self-scoped via `.ms-allowlist-picker` so multiple can coexist on a page; the
// `.allowlist-cb` class keeps `_collectAllowlist(containerId)` working.
function _allowlistPicker(selected) {
  var sel = new Set(selected || []);
  var opts = _pickerOptions();
  if (!opts.length) return '<div class="ms-allow-empty">' + tH('users_no_zims') + '</div>';
  var chosen = opts.filter(function(o) { return sel.has(o.name); }).length;
  var rows = opts.map(function(o) {
    var on = sel.has(o.name);
    var lang = o.language
      ? '<span class="ms-allow-lang">' + esc(String(o.language).toUpperCase()) + '</span>' : '';
    var count = (o.article_count != null)
      ? '<span class="ms-allow-count">' + Number(o.article_count).toLocaleString() + '</span>' : '';
    var hay = ((o.title || '') + ' ' + o.name + ' ' + (o.language || '')).toLowerCase();
    return '<label class="ms-allow-row" data-hay="' + escAttr(hay) + '">' +
      '<input type="checkbox" class="allowlist-cb" value="' + escAttr(o.name) + '"' +
        (on ? ' checked' : '') + ' onchange="_allowlistSync(this)"> ' +
      '<span class="ms-allow-name"><span class="ms-allow-title">' + esc(o.title || o.name) + '</span>' + lang + '</span>' +
      count +
    '</label>';
  }).join('');
  return '<div class="ms-allowlist-picker" data-total="' + opts.length + '">' +
    '<div class="ms-allow-tools">' +
      '<input type="search" class="ms-allow-search" placeholder="' + escAttr(tH('users_allow_search')) +
        '" oninput="_allowlistFilter(this)" aria-label="' + escAttr(tH('users_allow_search')) + '">' +
      '<button type="button" class="ms-allow-link" onclick="_allowlistSelectAll(this,true)">' + tH('users_allow_all') + '</button>' +
      '<button type="button" class="ms-allow-link" onclick="_allowlistSelectAll(this,false)">' + tH('users_allow_none') + '</button>' +
    '</div>' +
    '<div class="ms-allow-summary" aria-live="polite">' +
      t('users_allow_count', { n: chosen, total: opts.length }) +
    '</div>' +
    '<div class="ms-allow-list">' + rows + '</div>' +
  '</div>';
}

function _allowlistRoot(el) { return el.closest ? el.closest('.ms-allowlist-picker') : null; }

// Live filter: show only rows whose title/name/language contains the query.
function _allowlistFilter(input) {
  var root = _allowlistRoot(input);
  if (!root) return;
  var q = (input.value || '').trim().toLowerCase();
  root.querySelectorAll('.ms-allow-row').forEach(function(r) {
    r.style.display = (!q || r.getAttribute('data-hay').indexOf(q) !== -1) ? '' : 'none';
  });
}

// Select-all / none acts on the VISIBLE rows only, so it composes with search
// (e.g. "search 'wiki' → select all" tags just the Wikipedias).
function _allowlistSelectAll(btn, on) {
  var root = _allowlistRoot(btn);
  if (!root) return;
  root.querySelectorAll('.ms-allow-row').forEach(function(r) {
    if (r.style.display === 'none') return;
    var cb = r.querySelector('.allowlist-cb');
    if (cb) cb.checked = on;
  });
  _allowlistUpdateSummary(root);
}

function _allowlistSync(cb) {
  var root = _allowlistRoot(cb);
  if (root) _allowlistUpdateSummary(root);
}

function _allowlistUpdateSummary(root) {
  var total = root.getAttribute('data-total');
  var n = root.querySelectorAll('.allowlist-cb:checked').length;
  var s = root.querySelector('.ms-allow-summary');
  if (s) s.textContent = t('users_allow_count', { n: n, total: total });
}

function _collectAllowlist(containerId) {
  var out = [];
  document.querySelectorAll('#' + containerId + ' .allowlist-cb:checked').forEach(function(cb) { out.push(cb.value); });
  return out;
}

// ── Public access policy (anonymous visitors) ──────────────────────────────
// Three modes shape what a not-logged-in visitor sees: Open (everything),
// Limited (a chosen allowlist), Sign-in required (nothing but the login
// screen). Reuses the same allowlist picker as per-user Limited.
function _publicAccessCard() {
  var pa = (_usersData && _usersData.public_access) || { mode: 'open', allowlist: [] };
  var mode = pa.mode || 'open';
  var envLocked = !!pa.env_controlled;
  var modes = [
    ['open', 'users_pa_open', 'users_pa_open_desc'],
    ['limited', 'users_pa_limited', 'users_pa_limited_desc'],
    ['private', 'users_pa_private', 'users_pa_private_desc']
  ];
  var choices = modes.map(function(m) {
    var on = m[0] === mode;
    return '<label class="ms-pa-choice' + (on ? ' active' : '') + (envLocked ? ' disabled' : '') + '">' +
      '<input type="radio" name="ms-pa-mode" value="' + m[0] + '"' + (on ? ' checked' : '') +
        (envLocked ? ' disabled' : '') + ' onchange="_onPublicAccessMode(this.value)"> ' +
      '<span class="ms-pa-choice-body">' +
        '<span class="ms-pa-choice-title">' + tH(m[1]) + '</span>' +
        '<span class="ms-pa-choice-desc">' + tH(m[2]) + '</span>' +
      '</span>' +
    '</label>';
  }).join('');
  var picker = '<div id="ms-pa-allowlist" class="ms-pa-allowlist"' + (mode === 'limited' ? '' : ' hidden') + '>' +
    _allowlistPicker(pa.allowlist || []) +
    '<button class="ms-btn ms-btn-primary ms-pa-save" onclick="_savePublicAccessLimited()">' + tH('save') + '</button>' +
  '</div>';
  var envNote = envLocked
    ? '<div class="ms-pa-env">' + tH('users_pa_env') + ' <code>ZIMI_PUBLIC_ACCESS=' + esc(pa.env_mode || '') + '</code></div>'
    : '';
  return '<div class="ms-pa-card">' +
    '<div class="ms-section-label">' + tH('users_pa_title') + '</div>' +
    '<div class="ms-pa-sub">' + tH('users_pa_sub') + '</div>' +
    envNote +
    '<div class="ms-pa-choices">' + choices + '</div>' +
    picker +
  '</div>';
}

// Radio change: reflect selection, reveal the picker for Limited, and save
// Open/Private immediately (they need no further input). Limited waits for the
// explicit Save so the admin can choose ZIMs first.
function _onPublicAccessMode(mode) {
  document.querySelectorAll('.ms-pa-choice').forEach(function(c) {
    var r = c.querySelector('input');
    c.classList.toggle('active', !!(r && r.checked));
  });
  var picker = document.getElementById('ms-pa-allowlist');
  if (picker) picker.hidden = (mode !== 'limited');
  if (mode !== 'limited') _publicAccessPost({ mode: mode });
}

function _savePublicAccessLimited() {
  _publicAccessPost({ mode: 'limited', allowlist: _collectAllowlist('ms-pa-allowlist') });
}

function _publicAccessPost(payload) {
  return manageFetch('/manage/public-access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function(res) {
    return res.json().then(function(j) { return { ok: res.ok, j: j }; });
  }).then(function(r) {
    if (r.ok && r.j && r.j.public_access) {
      if (_usersData) _usersData.public_access = r.j.public_access;
      _refreshUsersPane();
      _showToast(t('users_pa_saved'));
    } else {
      _showToast(t('users_create_failed'));
    }
    return r;
  });
}

function _usersPost(payload) {
  return manageFetch('/manage/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function(res) { return res.json().then(function(j) { return { ok: res.ok, j: j }; }); });
}

// Re-render the Users pane in place after a mutation (shared by every action).
function _refreshUsersPane() {
  if (_msSection !== 'users') return;
  var pane = document.getElementById('ms-pane');
  if (pane) pane.innerHTML = _msUsersHtml();
}

function _createUser() {
  var name = (document.getElementById('new-user-name').value || '').trim();
  var pw = document.getElementById('new-user-pw').value || '';
  var role = _selectedRole('new-user');
  var errEl = document.getElementById('new-user-error');
  if (!name || !pw) { errEl.textContent = t('users_need_name_pw'); errEl.style.display = 'block'; return; }
  var payload = { action: 'create', name: name, password: pw, role: role };
  if (role === 'limited') payload.allowlist = _collectAllowlist('new-user-allowlist');
  var cb = document.getElementById('new-user-can-create');
  var grantCreate = !!(cb && cb.checked && role !== 'admin');
  _usersPost(payload).then(function(r) {
    if (!r.ok) { errEl.textContent = t('users_create_failed'); errEl.style.display = 'block'; return; }
    if (!grantCreate) { _usersData = r.j; _refreshUsersPane(); return; }
    // The form's Creation checkbox rides the existing set-can-create action —
    // the account exists either way, so refresh from whichever answer is last.
    _usersPost({ action: 'set-can-create', name: name, can_create: true }).then(function(r2) {
      _usersData = (r2.ok && r2.j) ? r2.j : r.j;
      _refreshUsersPane();
    });
  });
}

function _deleteUser(name) {
  _appConfirm(t('users_delete_confirm').replace('{name}', name), t('delete')).then(function(sure) {
  if (!sure) return;
  _usersPost({ action: 'delete', name: name }).then(function(r) {
    if (r.ok) { _usersData = r.j; _refreshUsersPane(); }
  });
  });
}

// Change a user's role from the ⋯ menu. Switching to "limited" carries the
// existing allowlist forward (edit it via the separate Edit allowlist item).
function _setUserRole(name, role) {
  if (!_validMsSection(_msSection)) return;
  var u = ((_usersData && _usersData.users) || []).find(function(x) { return x.name === name; });
  if (u && u.role === role) return;  // no-op tap on the current role
  var payload = { action: 'set-role', name: name, role: role };
  if (role === 'limited') payload.allowlist = (u && u.allowlist) || [];
  _usersPost(payload).then(function(r) {
    if (r.ok) { _usersData = r.j; _refreshUsersPane(); }
  });
}

// Grant or revoke the per-user create permission from the ⋯ menu. Admin-role
// accounts never show the item (they create implicitly).
function _setUserCanCreate(name, on) {
  _usersPost({ action: 'set-can-create', name: name, can_create: !!on }).then(function(r) {
    if (r.ok) { _usersData = r.j; _refreshUsersPane(); }
  });
}

// Allowlist editor for a limited user (overlay-free: swaps the pane). Role is
// set separately via the ⋯ menu, so this pane is allowlist-only.
function _editUserAllowlist(name) {
  var u = ((_usersData && _usersData.users) || []).find(function(x) { return x.name === name; });
  if (!u) return;
  var pane = document.getElementById('ms-pane');
  pane.innerHTML =
    '<button class="ms-btn" onclick="_renderMsUsers()" style="margin-bottom:12px">← ' + tH('back') + '</button>' +
    '<div class="ms-section-label">' + tH('users_edit_allowlist') + ' — ' + esc(name) + '</div>' +
    '<div id="edit-user-allowlist" style="margin-top:8px">' + _allowlistPicker(u.allowlist) + '</div>' +
    '<button class="ms-btn ms-btn-primary" style="margin-top:12px" onclick="_saveUserAllowlist(' + escAttr(JSON.stringify(name)) + ')">' + tH('save') + '</button>';
}

function _saveUserAllowlist(name) {
  var payload = { action: 'set-role', name: name, role: 'limited', allowlist: _collectAllowlist('edit-user-allowlist') };
  _usersPost(payload).then(function(r) {
    if (r.ok) { _usersData = r.j; _renderMsUsers(); }
  });
}

// ── Creator settings ────────────────────────────────────────────────────────
//
// What this server can capture with, where it may write, what it refuses by
// default, and what is waiting. Every one of these facts already existed — but
// only inside the create page's own status poll, which meant the only way for
// an admin to learn that the browser engine was missing was to open the create
// form and notice an option greyed out. Capabilities of the SERVER belong with
// the server's other settings; the create form should be where you use them,
// not where you discover them.
//
// Read-only on purpose. Every value here is set by an install or an env var,
// and a control that looked editable but wasn't would be worse than a row.

// A yes/no capability as a coloured word rather than a checkbox — nothing here
// is settable from this pane, so a control would be a lie.
function _creatorStateHtml(ready, hint) {
  var cls = ready ? 'app-update-badge' : 'app-update-quiet';
  var text = tH(ready ? 'creator_installed' : 'creator_not_installed');
  return '<span class="' + cls + '"' + (hint ? ' title="' + escAttr(hint) + '"' : '') + '>' + text + '</span>';
}

// The one command that fixes a missing part. Shown under the row it belongs
// to, and only when that part is actually missing.
function _creatorInstallHtml(ready, cmd) {
  return ready ? '' : '<code class="app-update-cmd">' + esc(cmd) + '</code>';
}

// The last /manage/creator payload, for the life of the page. The pane paints
// from this INSTANTLY on every re-entry (the two subprocess-backed probes made
// each entry flash "Loading…" for as long as the server took) and refreshes
// silently behind that paint, patching only the leaves that changed — the same
// scoped-update discipline the app-update block keeps (never rebuild a pane
// that is already on screen).
var _creatorData = null;

function _msCreatorHtml() {
  // No technical "Capture engines / decided by what is installed" lead — the
  // nav tab already says Creator, and that engine-status block reads as debug
  // output (Eric: "starts with CAPTURE ENGINES... very weird"). The pane now
  // opens with what you've made and the defaults; capabilities sit last.
  var h = '<div id="ms-creator" class="ms-creator">' +
    // First-ever open: the app's styled loading line, never bare browser text.
    (_creatorData ? _creatorHtml(_creatorData) : _loadingHtml()) +
    '</div>';
  setTimeout(function() {
    if (_msSection !== 'creator') return;
    _renderCreatorSection();
  }, 0);
  return h;
}

// The sidecar's value cell: version first, muted, then the verdict — so the
// verdict word right-aligns flush with every other row's, instead of the
// version breaking the status column (Eric: "The version isn't aligned").
function _creatorSidecarHtml(sidecar) {
  return (sidecar.version ? '<span class="app-update-quiet">' + esc(sidecar.version) + '</span> ' : '') +
    _creatorStateHtml(sidecar.installed);
}

// A capture-default switch — the app's own .switch control, wired to the
// admin-only POST half of /manage/creator so the choice persists server-side.
function _creatorDefaultSwitch(key, labelKey, on) {
  return '<label class="switch"><input type="checkbox" role="switch" id="ms-cr-' + key + '"' +
    (on ? ' checked' : '') +
    ' aria-label="' + escAttr(t(labelKey)) + '"' +
    ' onchange="_setCreatorDefault(\'' + key + '\', this)"><span class="switch-slider"></span></label>';
}

function _creatorQueueHtml(queue) {
  return queue
    ? esc(t('creator_queue_n', { n: queue }))
    : '<span class="app-update-quiet">' + tH('creator_queue_empty') + '</span>';
}

function _creatorHtml(d) {
  var sidecar = d.sidecar || {};
  var sep = '<div style="border-top:1px solid var(--border);margin:16px 0 14px"></div>';

  // Defaults a new capture starts with — the control you actually touch.
  var h = '<div class="ms-section-label">' + tH('creator_defaults') + '</div>' +
    _mcRow(tH('create_block_ads'), _creatorDefaultSwitch('block_ads', 'create_block_ads', d.block_ads_default)) +
    _mcRow(tH('create_capture_variants'), _creatorDefaultSwitch('capture_variants', 'create_capture_variants', d.capture_variants_default)) +
    '<div class="ms-hint">' + tH('creator_defaults_hint') + '</div>';

  // The queue, when it matters.
  h += sep + '<div class="ms-section-label">' + tH('creator_queue') + '</div>' +
    _mcRow(tH('creator_queued'), '<span id="ms-cr-queue">' + _creatorQueueHtml(d.queue) + '</span>');

  // Capabilities — the "what's installed" report.
  h += sep + '<div class="ms-section-label">' + tH('creator_engines') + '</div>' +
    '<div class="ms-hint" style="margin-bottom:10px">' + tH('creator_engines_hint') + '</div>' +
    _mcRow(tH('creator_browser'), '<span id="ms-cr-browser">' + _creatorStateHtml(d.browser_ready) + '</span>') +
    '<div id="ms-cr-browser-cmd">' + _creatorInstallHtml(d.browser_ready, "pip install 'zimi[browser]' && playwright install chromium") + '</div>' +
    _mcRow(tH('creator_sidecar'), '<span id="ms-cr-sidecar">' + _creatorSidecarHtml(sidecar) + '</span>') +
    '<div id="ms-cr-sidecar-cmd">' + _creatorInstallHtml(sidecar.installed, 'zimi import --setup') + '</div>' +
    _mcRow(tH('creator_alive'), '<span id="ms-cr-alive">' + _creatorStateHtml(d.alive_ready) + '</span>');

  // Made here LAST — an unbounded, growing list, and the slow half to gather
  // (a provenance walk of the library), so it never blocks the pane. It fills
  // in from its own request; until then a spinner sits in its slot.
  h += sep + '<div class="ms-section-label">' + tH('creator_made') + '</div>' +
    '<div id="ms-cr-made">' + _loadingHtml() + '</div>';
  _creatorLoadInventory();
  return h;
}

// The made-here inventory rides its own request so the Creator pane can paint
// instantly. Cached for the session; a background create/delete invalidates it
// through _renderCreatorSection's refresh.
var _creatorInventory = null;
function _creatorLoadInventory() {
  var fill = function() {
    var el = document.getElementById('ms-cr-made');
    if (el && _msSection === 'creator') el.innerHTML = _creatorMadeHtml(_creatorInventory || {});
  };
  if (_creatorInventory) { fill(); return; }
  manageFetch('/manage/creator/inventory').then(function(r) { return r.json(); }).then(function(d) {
    _creatorInventory = d;
    fill();
  }).catch(function() {
    var el = document.getElementById('ms-cr-made');
    if (el) el.innerHTML = '<div class="ms-hint">' + tH('creator_made_empty') + '</div>';
  });
}

// The provenance types, in the order the breakdown reads them, paired with the
// i18n key for each label. A type with a zero count is left out of the chip
// row entirely — a wall of "0 · 0 · 0" is noise, not information.
var _CREATOR_TYPE_KEYS = {
  page: 'zi_kind_page', site: 'zi_kind_site', video: 'zi_kind_video',
  import: 'zi_kind_import', folder: 'zi_kind_folder',
  export: 'zi_kind_export', edit: 'zi_kind_edit'
};
var _creatorSort = { key: 'created_ts', dir: -1 };  // newest first by default

// The by-type counts as amber chips, then a sortable table of everything Zimi
// made. Client-side sort — the server sends the rows unsorted with every field
// the header needs. Empty when nothing has been created here yet.
function _creatorMadeHtml(d) {
  var counts = d.created_counts || {};
  var list = (d.created_list || []).slice();
  if (!list.length) {
    return '<div class="ms-hint">' + tH('creator_made_empty') + '</div>';
  }
  var chips = '';
  Object.keys(_CREATOR_TYPE_KEYS).forEach(function(t) {
    var n = counts[t] || 0;
    if (!n) return;
    chips += '<span class="cr-made-chip"><b>' + n + '</b> ' + tH(_CREATOR_TYPE_KEYS[t]) + '</span>';
  });
  var s = _creatorSort;
  list.sort(function(a, b) {
    var av = a[s.key], bv = b[s.key];
    if (s.key === 'title') { av = (av || a.name || '').toLowerCase(); bv = (bv || b.name || '').toLowerCase(); }
    else { av = av || 0; bv = bv || 0; }
    return av < bv ? -s.dir : av > bv ? s.dir : 0;
  });
  var arrow = function(k) { return s.key === k ? (s.dir < 0 ? ' ↓' : ' ↑') : ''; };
  var th = function(k, label) {
    return '<th class="cr-made-th" onclick="_creatorSortBy(\'' + k + '\')">' + tH(label) + arrow(k) + '</th>';
  };
  var rows = list.map(function(z) {
    return '<tr>' +
      '<td class="cr-made-name"><a href="/w/' + encodeURIComponent(z.name) + '"' +
        ' data-zim="' + escAttr(z.name) + '" onclick="return _spaSourceClick(event, this)">' +
        esc(z.title || z.name) + '</a></td>' +
      '<td>' + tH(_CREATOR_TYPE_KEYS[z.type] || 'zi_kind_zimi') + '</td>' +
      '<td class="cr-made-num">' + (z.size_bytes ? fmtBytes(z.size_bytes) : '') + '</td>' +
      '<td class="cr-made-num">' + (z.created_ts ? _relTime(z.created_ts) : '') + '</td>' +
    '</tr>';
  }).join('');
  return '<div class="cr-made-chips">' + chips + '</div>' +
    '<div class="cr-made-wrap"><table class="cr-made-table"><thead><tr>' +
      th('title', 'creator_col_name') + th('type', 'creator_col_type') +
      th('size_bytes', 'creator_col_size') + th('created_ts', 'creator_col_when') +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// Re-sort in place: same column flips direction, a new column sorts descending
// (numbers big-first, names A-Z on the flip). Only the made-here block repaints.
function _creatorSortBy(key) {
  if (_creatorSort.key === key) _creatorSort.dir = -_creatorSort.dir;
  else _creatorSort = { key: key, dir: key === 'title' ? 1 : -1 };
  var el = document.getElementById('ms-cr-made');
  if (el && _creatorInventory) el.innerHTML = _creatorMadeHtml(_creatorInventory);
}

// Scoped background refresh: leaf nodes only, so a visible pane never rebuilds
// under the reader (or under a finger halfway to a switch).
function _patchCreatorSection(d) {
  var sidecar = d.sidecar || {};
  var put = function(id, html) {
    var el = document.getElementById(id);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  };
  put('ms-cr-browser', _creatorStateHtml(d.browser_ready));
  put('ms-cr-browser-cmd', _creatorInstallHtml(d.browser_ready, "pip install 'zimi[browser]' && playwright install chromium"));
  put('ms-cr-sidecar', _creatorSidecarHtml(sidecar));
  put('ms-cr-sidecar-cmd', _creatorInstallHtml(sidecar.installed, 'zimi import --setup'));
  put('ms-cr-alive', _creatorStateHtml(d.alive_ready));
  put('ms-cr-queue', _creatorQueueHtml(d.queue));
  ['block_ads', 'capture_variants'].forEach(function(key) {
    var input = document.getElementById('ms-cr-' + key);
    if (input) input.checked = !!d[key + '_default'];
  });
}

function _renderCreatorSection() {
  if (!document.getElementById('ms-creator')) return;
  manageFetch('/manage/creator').then(function(r) { return r.json(); }).then(function(d) {
    var first = !_creatorData;
    var changed = first || JSON.stringify(_creatorData) !== JSON.stringify(d);
    _creatorData = d;
    var slot = document.getElementById('ms-creator');
    if (!slot || _msSection !== 'creator') return;
    if (first) { slot.innerHTML = _creatorHtml(d); return; }
    if (changed) _patchCreatorSection(d);
  }).catch(function() {
    var slot = document.getElementById('ms-creator');
    // A cached paint stays up through a failed refresh — stale beats blank.
    if (slot && !_creatorData) slot.innerHTML = '<div class="ms-hint">' + tH('could_not_load') + '</div>';
  });
}

// A capture-default toggle flipped: persist server-side, and settle the switch
// on whatever the server answers (revert on failure — the control must never
// show a state the file does not hold).
function _setCreatorDefault(key, input) {
  var want = !!input.checked;
  input.disabled = true;
  var body = {};
  body[key] = want;
  manageFetch('/manage/creator', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(_msJson).then(function(d) {
    if (_creatorData) {
      _creatorData.block_ads_default = d.block_ads_default;
      _creatorData.capture_variants_default = d.capture_variants_default;
    }
    input.checked = !!d[key + '_default'];
    _showToast(t('saved'));
  }).catch(function() {
    input.checked = !want;
    _showToast(t('error'));
  }).finally(function() { input.disabled = false; });
}

// ── ZIM auto-update ─────────────────────────────────────────────────────────
//
// Was one select. A select is a fine control and a terrible report: it said
// how often the updater is *supposed* to run and nothing about whether it ever
// had, what it did, or when it would go again — so the only way to find out
// was to notice a ZIM's date changing. Everything here already existed on the
// server; none of it had a place to be read.
//
// The coverage line is the part that earns the section. Zimi has no per-ZIM
// opt-out; what it has is a reach — the updater matches an installed file to a
// newer edition by the date in its filename, so an undated ZIM is invisible to
// it. That is most of what `zimi create` writes, and a file that silently
// never updates is exactly the kind of thing a library owner should not have
// to deduce.
var AU_FREQUENCIES = ['disabled', 'daily', 'weekly', 'monthly'];
var _AU_SELECT_CSS = 'font-size:12px;padding:3px 8px;border-radius:4px;' +
  'border:1px solid var(--border);background:var(--surface2);color:var(--text)';

// The frequency control. Same id, same handler, same env lock as before — the
// poll gating and two other renderers read #auto-update-freq by name.
function _autoUpdateSelectHtml(au) {
  var cur = au.enabled ? (au.frequency || 'weekly') : 'disabled';
  var opts = AU_FREQUENCIES.map(function(f) {
    return '<option value="' + f + '"' + (f === cur ? ' selected' : '') + '>' +
      esc(t('au_' + f)) + '</option>';
  }).join('');
  var lock = au.locked
    ? ' disabled title="' + escAttr(t('au_controlled_by_env')) + '" style="' + _AU_SELECT_CSS + ';opacity:0.5"'
    : ' style="' + _AU_SELECT_CSS + '"';
  return '<select id="auto-update-freq" onchange="toggleAutoUpdate()"' + lock + '>' + opts + '</select>';
}

// One label/value row, which is the shape every settings row in these panes
// already has.
function _mcRow(label, value) {
  return '<div class="mc-row"><span class="mc-label">' + label +
    '</span><span class="mc-value">' + value + '</span></div>';
}

// What the last pass did: the timestamp, plain. The detail lives in the
// Activity journal, where anyone curious will look anyway — a deep-link from
// this row read as noise, not as help.
function _autoUpdateLastHtml(au) {
  if (!au.last_check) {
    // Not "never": the stamp is process memory, so a restart erases it while
    // the updater's history stays in the journal. Saying "never" would be a
    // claim about the library that this field cannot support.
    return '<span style="color:var(--text2)">' + tH('au_not_this_session') + '</span>';
  }
  return esc(_relTime(au.last_check));
}

function _autoUpdateNextHtml(au) {
  if (!au.enabled) return '<span style="color:var(--text2)">' + tH('au_disabled') + '</span>';
  // Enabled but never run this session: the loop's first pass is 30 seconds
  // after it starts, so there is no useful time to print — only "imminently".
  if (!au.next_check) return '<span style="color:var(--text2)">' + tH('au_next_soon') + '</span>';
  return esc(_relTime(au.next_check));
}

// How the library splits for the updater: catalog ZIMs it can check against a
// newer edition, versus local or custom ones (created here, or with no dated
// edition to match) that there is simply nothing to check. Two plain counts,
// no wall of filenames — those names read as debug output, not information.
function _autoUpdateCoverageHtml(coverage) {
  if (!coverage) return '';
  var tracked = (coverage.tracked || []).length;
  var custom = (coverage.skipped || []).length;
  // Nothing local or custom → nothing worth explaining: every source is a
  // catalog ZIM the updater checks, which is the quiet, expected state.
  if (!custom) return '';
  return _mcRow(tH('au_from_catalog'),
      esc(t('au_from_catalog_n', { n: tracked, total: tracked + custom }))) +
    _mcRow(tH('au_local_custom'), esc(String(custom)));
}

function _autoUpdateHtml(au, coverage) {
  // Frequency + what the library splits into for the updater. The last-run /
  // next-run clock rows are gone — operational noise the operator did not ask
  // for; what they want to know is how much of the library is even checkable
  // (Eric: "why not say how many are local/custom instead").
  return '<div class="ms-section-label">' + tH('auto_update') + '</div>' +
    _mcRow(tH('au_frequency'), _autoUpdateSelectHtml(au)) +
    _autoUpdateCoverageHtml(coverage);
}

// Repaint the section from server truth. The library pane draws it once from
// the status payload it already has (so the select is never missing while a
// second request is in flight), then this fills in last/next/coverage.
function _renderAutoUpdateSection() {
  var el = document.getElementById('ms-auto-update');
  if (!el) return;
  manageFetch('/manage/auto-update').then(function(r) { return r.json(); }).then(function(d) {
    var slot = document.getElementById('ms-auto-update');
    if (slot) slot.innerHTML = _autoUpdateHtml(d, d.coverage);
  }).catch(function() {});
}

function _msLibraryHtml() {
  var d = _manageStatusData;
  if (!d) return '<div class="loading"><span class="spinner-inline"></span>Loading\u2026</div>';
  var h = '<div class="mc-row"><span class="mc-label">' + tH('zim_files') + '</span><span class="mc-value">' + esc(String(d.zim_count)) + '</span></div>' +
    '<div class="mc-row"><span class="mc-label">' + tH('total_size') + '</span><span class="mc-value">' + fmtSize(d.total_size_gb) + '</span></div>' +
    // Summary line + (only when updates exist) an expandable detail panel. The
    // row's state, clickability and detail are all driven by _renderUpdatesSummary
    // — the single writer — so the top-level label never strands on "Checking…".
    '<div id="update-status" class="mc-row">' +
      '<span class="mc-label">' + tH('updates') + '</span>' +
      '<span class="mc-value" style="color:var(--text2)"><span class="spinner-inline"></span>' + tH('updates_checking') + '</span></div>' +
    '<div id="updates-detail" class="updates-detail" style="display:none"></div>' +
    // Space before the ZIM auto-update block so its header doesn't crowd the
    // app-update line above it (Eric: "no spacing after Updates line").
    '<div id="ms-auto-update" style="margin-top:16px">' + _autoUpdateHtml(d.auto_update || {}, null) + '</div>' +
    '<div class="ms-actions">' +
      '<button class="manage-btn-action" onclick="manageImportZim()" style="background:var(--surface2);color:var(--text);border:1px solid var(--border)">' + tH('import_zim') + '</button>' +
      '<button id="refresh-cache-btn" class="manage-btn-action" onclick="settingsRefreshCache()" style="background:var(--surface2);color:var(--text);border:1px solid var(--border)">' + tH('refresh_cache') + '</button>' +
      '<button id="library-health-btn" class="manage-btn-action" onclick="runLibraryHealth()" style="background:var(--surface2);color:var(--text);border:1px solid var(--border)">' + tH('library_health') + '</button>' +
      '<button id="update-all-btn" class="manage-btn-action" onclick="triggerUpdate()" style="display:none;margin-inline-start:auto">' + tH('update_all') + '</button>' +
    '</div>' +
    '<div id="library-health-section" class="library-health"></div>' +
    '<div id="tmp-files-section"></div>' +
    _msReorderHtml();
  // Async-load tmp file info
  manageFetch('/manage/stats').catch(function() { return null; }).then(function(r) { return r && r.json(); }).then(function(s) {
    if (!s) return;
    var el = document.getElementById('tmp-files-section');
    if (!el || !s.disk || !s.disk.tmp_files || !s.disk.tmp_files.length) return;
    var files = s.disk.tmp_files;
    var totalBytes = files.reduce(function(a, f) { return a + f.size_bytes; }, 0);
    var html = '<div class="mc-row" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">' +
      '<span class="mc-label">' + tH('partial_downloads') + '</span>' +
      '<span class="mc-value" style="color:var(--text2)">' + files.length + ' file' + (files.length > 1 ? 's' : '') + ' · ' + _fmtBytes(totalBytes) + '</span></div>';
    files.forEach(function(f) {
      html += '<div class="mc-row" style="padding-left:8px"><span class="mc-label" style="font-size:12px;color:var(--text2)">' + esc(f.filename.replace('.zim.tmp','')) + '</span>' +
        '<span class="mc-value" style="font-size:12px;color:var(--text2)">' + _fmtBytes(f.size_bytes) + ' · ' + f.age_hours + 'h ago</span></div>';
    });
    html += '<div class="ms-actions"><button class="manage-btn-action" onclick="cleanupTmpFiles()" id="cleanup-tmp-btn" style="background:var(--surface2);color:var(--amber);border:1px solid var(--border);font-size:12px">' + tH('clean_up') + '</button></div>';
    el.innerHTML = html;
  }).catch(function() {});
  return h;
}

// Kept as a name because create.js and the About panel call it; the one
// implementation lives in fmtBytes.
function _fmtBytes(b) { return fmtBytes(b); }

// ── Library health report ──
var _healthPoll = null;
function runLibraryHealth() {
  var btn = document.getElementById('library-health-btn');
  var sec = document.getElementById('library-health-section');
  if (btn) btn.disabled = true;
  if (sec) sec.innerHTML = _loadingHtml('library_health_running');
  manageFetch('/manage/health-check', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function() { _pollLibraryHealth(); })
    .catch(function() {
      if (btn) btn.disabled = false;
      if (sec) sec.innerHTML = '<div class="mc-row"><span class="mc-value" style="color:var(--amber)">' + tH('library_health_failed') + '</span></div>';
    });
}
function _pollLibraryHealth() {
  clearTimeout(_healthPoll);
  manageFetch('/manage/health').then(function(r) { return r.json(); }).then(function(st) {
    var sec = document.getElementById('library-health-section');
    if (!sec) return;
    if (st.phase === 'running') {
      sec.innerHTML = _loadingHtml('library_health_running') +
        '<div class="mc-row"><span class="mc-value" style="color:var(--text2)">' +
        t('library_health_progress', { done: st.done || 0, total: st.total || 0 }) + '</span></div>';
      _healthPoll = setTimeout(_pollLibraryHealth, 600);
    } else if (st.phase === 'done') {
      _renderHealthReport(st);
      var btn = document.getElementById('library-health-btn');
      if (btn) btn.disabled = false;
    } else {
      sec.innerHTML = '<div class="mc-row"><span class="mc-value" style="color:var(--amber)">' + tH('library_health_failed') + '</span></div>';
      var b2 = document.getElementById('library-health-btn');
      if (b2) b2.disabled = false;
    }
  }).catch(function() {
    var b3 = document.getElementById('library-health-btn');
    if (b3) b3.disabled = false;
  });
}
function _healthMark(status) {
  if (status === 'ok') return '<span style="color:#34d399" title="' + escAttr(t('healthy')) + '">✓</span>';
  if (status === 'info') return '<span style="color:var(--text2)" title="' + escAttr(t('health_info')) + '">ⓘ</span>';
  return '<span style="color:var(--amber)" title="' + escAttr(t('warning')) + '">⚠</span>';
}
// The catalog item for an installed ZIM name, or null. Used to offer
// "Redownload" only for ZIMs Zimi knows how to fetch again (catalog-known).
function _catalogItemForZim(name) {
  if (!name || !_catalogCache) return null;
  return _catalogCache.find(function(it) {
    if (it.name === name) return true;
    var u = it.download_url || (it.variants && it.variants[0] && it.variants[0].download_url);
    if (!u) return false;
    var sn = u.split('/').pop().replace(/\.zim$/, '').replace(/_maxi.*$/, '').replace(/_\d{4}-\d{2}$/, '');
    return sn === name;
  }) || null;
}
// Best download URL for a catalog item (richest flavor, else its own URL).
function _catalogItemUrl(it) {
  if (!it) return null;
  if (it.variants && it.variants.length) {
    var v = it.variants.filter(function(x) { return x.download_url; })
      .sort(function(a, b) { return _flavorOrder(b.download_url) - _flavorOrder(a.download_url); })[0];
    if (v) return v.download_url;
  }
  return it.download_url || null;
}
// Two-click confirm (mirrors deleteZim): first tap arms, second redownloads.
function healthRedownload(url, btn) {
  if (!btn) return;
  if (!btn.classList.contains('confirming')) {
    btn.classList.add('confirming');
    btn.textContent = t('health_redownload_confirm');
    setTimeout(function() {
      if (btn.classList.contains('confirming')) {
        btn.classList.remove('confirming');
        btn.textContent = t('health_redownload');
      }
    }, 4000);
    return;
  }
  btn.classList.remove('confirming');
  downloadZim(url, btn, true);
}
function _renderHealthReport(st) {
  var sec = document.getElementById('library-health-section');
  if (!sec) return;
  var s = st.summary || { total: 0, healthy: 0, warnings: 0 };
  var summaryLine = s.warnings
    ? t('library_health_summary_warn', { healthy: s.healthy, warnings: s.warnings })
    : t('library_health_summary_ok', { total: s.total });
  if (s.torrent_files) summaryLine += ' · ' + t('health_torrent_files', { n: s.torrent_files });
  var rank = { warn: 0, ok: 1, info: 2 };  // warnings first, torrent-metadata last
  var rows = (st.report || []).slice().sort(function(a, b) {
    var ra = rank[a.status] != null ? rank[a.status] : 1;
    var rb = rank[b.status] != null ? rank[b.status] : 1;
    if (ra !== rb) return ra - rb;
    return (a.name || '').localeCompare(b.name || '');
  });
  var body = rows.map(function(r) {
    if (r.kind === 'torrent_meta') {
      return '<div class="health-row health-info">' +
        '<span class="health-mark">' + _healthMark('info') + '</span>' +
        '<span class="health-name">' + esc(r.name) + '</span>' +
        '<span class="health-detail">' + esc(t('health_torrent_meta')) + '</span></div>';
    }
    var issues = (r.issues && r.issues.length) ? esc(r.issues.join(', ')) :
      (r.entries != null ? esc(t('health_entries', { n: Number(r.entries).toLocaleString() })) : '');
    // Which indexes this ZIM has, as small labelled badges (not bare "title"/
    // "Q-ID" tokens, which read as leftover garbage next to the entry count).
    var idx = [];
    if (r.title_index === 'current') idx.push(t('health_title_index'));
    else if (r.title_index === 'stale') idx.push(t('health_title_index_stale'));
    if (r.qid_index === 'present') idx.push(t('health_qid_index'));
    var meta = idx.map(function(label) {
      return '<span class="health-idx-badge">' + esc(label) + '</span>';
    }).join('');
    if (meta) meta = ' ' + meta;
    // A broken/degraded ZIM that Zimi knows how to fetch again gets a
    // Redownload action wired into the normal download flow.
    var action = '';
    if (r.status === 'warn') {
      var it = _catalogItemForZim(r.name);
      var url = _catalogItemUrl(it);
      if (url) {
        action = '<button class="health-redownload-btn" onclick="healthRedownload(\'' +
          escAttr(url) + '\', this)">' + tH('health_redownload') + '</button>';
      }
    }
    return '<div class="health-row ' + (r.status === 'warn' ? 'health-warn' : '') + '">' +
      '<span class="health-mark">' + _healthMark(r.status) + '</span>' +
      '<span class="health-name">' + esc(r.title || r.name) + '</span>' +
      '<span class="health-detail">' + issues + meta + '</span>' + action + '</div>';
  }).join('');
  sec.innerHTML = '<div class="health-summary">' + esc(summaryLine) + '</div>' +
    '<div class="health-table">' + body + '</div>';
}

// Data-dir storage breakdown (Server settings → Caches). Distinct, accessible
// hues — never color alone: every segment carries a text label + value in the
// legend and its title/aria text.
var _CACHE_SEG_COLORS = {
  title_indexes: '#f59e0b',
  qid_indexes: '#d97706',
  catalog_caches: '#60a5fa',
  staging: '#34d399',
  other: '#6e6e7a',
};
function _cacheSegLabel(key) {
  var m = {
    title_indexes: t('title_indexes'),
    qid_indexes: t('qid_indexes'),
    catalog_caches: t('catalog_caches'),
    staging: t('cache_staging'),
    other: t('cache_other'),
  };
  return m[key] || key;
}
// The segmented proportion bar + its legend, shared by the cache breakdown
// (Server settings) and the create page's finished-capture summary. One
// component so the two never drift: same geometry, same accessibility contract
// — every segment carries its label and value as TEXT in the legend and in its
// own title, so the bar is never the only thing saying what is what.
//
// segs:   [{key, size_bytes, count}] — caller sorts; zero-size entries dropped
// colors: {key: css color}, labelFn: key -> human label
// Returns '' when there is nothing to show.
function _segBarHtml(segs, total, colors, labelFn, ariaLabel) {
  if (!total || !segs || !segs.length) return '';
  var bars = '', legend = '', aria = [];
  segs.forEach(function(s) {
    if (!s.size_bytes) return;
    var pct = s.size_bytes / total * 100;
    var color = colors[s.key] || 'var(--text2)';
    var label = labelFn(s.key);
    var val = _fmtBytes(s.size_bytes);
    // A count, where the caller tracked one: "images 50.9 MB · 410".
    var countTxt = (typeof s.count === 'number' && s.count > 0) ? ' · ' + s.count : '';
    bars += '<span class="cache-seg" style="width:' + pct.toFixed(2) + '%;background:' + color +
      '" title="' + escAttr(label + ' — ' + val + countTxt) + '"></span>';
    legend += '<span class="cache-legend-item"><span class="cache-legend-swatch" style="background:' + color + '"></span>' +
      esc(label) + ' <b>' + val + '</b>' + (countTxt ? '<span class="cache-legend-n">' + esc(countTxt) + '</span>' : '') + '</span>';
    aria.push(label + ' ' + val + countTxt);
  });
  if (!bars) return '';
  return '<div class="cache-bar" role="img" aria-label="' + escAttr((ariaLabel || '') + ': ' + aria.join(', ')) + '">' + bars + '</div>' +
    '<div class="cache-legend">' + legend + '</div>';
}

function _cacheBreakdownHtml(d) {
  // Sort segments largest→smallest so the bar reads high-to-low and the legend
  // order matches. Copy first — never mutate the fetched payload.
  var segs = (d.breakdown || []).slice().sort(function(a, b) {
    return (b.size_bytes || 0) - (a.size_bytes || 0);
  });
  var total = d.data_dir_total_bytes || segs.reduce(function(a, s) { return a + s.size_bytes; }, 0);
  var titleRow = '<div class="mc-section-title">' + tH('cache_storage_title') +
    (total ? ' · ' + _fmtBytes(total) : '') + '</div>';
  if (!total) return titleRow + '<div class="ms-hint" style="margin:2px 0 8px">' + tH('cache_empty') + '</div>';
  var barHtml = _segBarHtml(segs, total, _CACHE_SEG_COLORS, _cacheSegLabel, t('cache_storage_title'));
  var top = '';
  if (d.top_zims && d.top_zims.length) {
    top = '<div class="cache-top-zims"><span class="cache-top-label">' + tH('cache_top_zims') + ':</span> ' +
      d.top_zims.map(function(z) { return esc(z.name) + ' (' + _fmtBytes(z.size_bytes) + ')'; }).join(', ') + '</div>';
  }
  return titleRow + barHtml + top;
}

async function cleanupTmpFiles() {
  var btn = document.getElementById('cleanup-tmp-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('cleaning'); }
  try {
    var r = await manageFetch('/manage/cleanup-tmp', {method: 'POST'});
    var data = await r.json();
    var el = document.getElementById('tmp-files-section');
    if (el) { el.style.opacity = '0.3'; setTimeout(function() { el.innerHTML = ''; el.style.opacity = ''; }, 300); }
    if (data.removed && data.removed.length) {
      _showToast(t('partial_removed', {n: data.removed.length}));
    } else {
      _showToast(t('no_partial'));
    }
  } catch(e) {
    _showToast(t('failed_clean'));
    if (btn) { btn.disabled = false; btn.textContent = t('clean_up'); }
  }
}

function _msToggleCollapse(id, btn) {
  const el = document.getElementById(id);
  if (!el) return;
  const open = el.classList.toggle('ms-open');
  btn.textContent = open ? t('hide_list') : t('show_list');
}

// Section reorder + add-section panel (#37). Lives under Library settings — the
// one obvious home for organizing the library. Collapsed by default.
// Draggable rows, ▲▼ keyboard fallback, Add/remove sections.
function _msReorderHtml() {
  return '<div class="ms-section-label" style="margin-top:20px">' + tH('reorder_sections') + '</div>' +
    '<div class="ms-hint">' + tH('reorder_hint') + '</div>' +
    '<button class="pill" onclick="_msToggleCollapse(\'ms-reorder\', this)">' + tH('show_list') + '</button>' +
    '<div class="ms-collapsed-list" id="ms-reorder"' +
      ' onclick="_reorderClick(event)" ondragstart="_reorderDragStart(event)"' +
      ' ondragover="_reorderDragOver(event)" ondrop="_reorderDrop(event)"' +
      ' ondragend="_reorderDragEnd(event)">' + _reorderSectionsHtml() + '</div>';
}

function _msPreferencesHtml() {
  var showXzim = !_getStorageFlag(SK.HIDE_XZIM_LINKS);
  var showDiscover = !_getStorageFlag(SK.HIDE_DISCOVER);
  var showLangChooser = !_getStorageFlag(SK.HIDE_LANG_CHOOSER);
  var darkenOn = _darkenArticlesOn();
  var h = '<div class="ms-section-label">' + tH('ms_display_section') + '</div>' +
    // App theme: Auto / Dark / Light segmented control.
    '<div class="ms-theme-label">' + tH('app_theme') + '</div>' +
    _appThemeSegHtml() +
    '<div class="ms-hint">' + tH('app_theme_hint') + '</div>' +
    // Reading: article-appearance options, grouped apart from the app chrome.
    // Darken raw (non-Reader-View) articles — default follows the app theme.
    '<div class="ms-section-label" style="margin-top:20px">' + tH('ms_reader_section') + '</div>' +
    '<label class="ms-check"><input type="checkbox" id="ms-darken-articles"' + (darkenOn ? ' checked' : '') +
      ' onchange="_setDarkenArticles(this.checked)"> ' + tH('darken_articles') + '</label>' +
    '<div class="ms-hint">' + tH('darken_articles_hint') + '</div>' +
    '<div style="border-top:1px solid var(--border);margin:16px 0 14px"></div>' +
    '<label class="ms-check"><input type="checkbox"' + (showDiscover ? ' checked' : '') +
      ' onchange="if(!this.checked)localStorage.setItem(\'zimi_hide_discover\',\'1\');else localStorage.removeItem(\'zimi_hide_discover\');renderHome()"> ' + tH('show_discover') + '</label>' +
    '<label class="ms-check"><input type="checkbox"' + (showXzim ? ' checked' : '') +
      ' onchange="if(!this.checked)localStorage.setItem(\'zimi_hide_cross_zim_links\',\'1\');else localStorage.removeItem(\'zimi_hide_cross_zim_links\')"> ' + tH('show_cross_links') + '</label>' +
    // Default download flavor (above languages — reached more often)
    '<div class="ms-section-label" style="margin-top:20px">' + tH('default_flavor') + '</div>' +
    '<div class="ms-hint">' + tH('default_flavor_hint') + '</div>' +
    '<div class="ms-flavor-row">' +
      _flavorRadio('full', tH('flavor_full')) +
      _flavorRadio('nopic', tH('flavor_nopic')) +
      _flavorRadio('mini', tH('flavor_mini')) +
    '</div>' +
    // Languages section combines display toggle + multi-select pref.
    // The pill list is long — collapsed behind a toggle by default.
    '<div class="ms-section-label" style="margin-top:20px">' + tH('languages_section') + '</div>' +
    '<label class="ms-check"><input type="checkbox"' + (showLangChooser ? ' checked' : '') +
      ' onchange="if(!this.checked)localStorage.setItem(\'zimi_hide_lang_chooser\',\'1\');else localStorage.removeItem(\'zimi_hide_lang_chooser\');if(window.updateTopbar)updateTopbar()"> ' + tH('show_lang_chooser') + '</label>' +
    '<div class="ms-hint" style="margin-top:8px">' + tH('catalog_languages_hint_short') + '</div>' +
    '<button class="pill" onclick="_msToggleCollapse(\'ms-lang-pills\', this)">' + tH('show_list') + '</button>' +
    '<div class="ms-lang-pills ms-collapsed-list" id="ms-lang-pills">' + _renderLangPrefPills() + '</div>';
  // Reader section — mirror of the in-article palette's AUTO switch, so the
  // setting is discoverable without first opening an article. Same wording,
  // same localStorage key (via _setReaderAuto).
  var readerAutoOn = _readerAuto();
  h += '<div class="ms-section-label" style="margin-top:20px">' + tH('ms_reader') + '</div>' +
    '<label class="ms-check"><input type="checkbox" id="ms-reader-auto"' + (readerAutoOn ? ' checked' : '') +
      ' onchange="_setReaderAuto(this.checked)"> ' + tH('reader_auto') + '</label>' +
    '<div class="ms-hint">' + tH('reader_auto_hint') + '</div>';
  // Accessibility section
  var a11yOn = _getStorageFlag(SK.A11Y_REWRITE);
  h += '<div class="ms-section-label" style="margin-top:20px">' + tH('ms_accessibility') + '</div>' +
    '<label class="ms-check"><input type="checkbox"' + (a11yOn ? ' checked' : '') +
      ' onchange="if(this.checked)localStorage.setItem(\'zimi_a11y_rewrite\',\'1\');else localStorage.removeItem(\'zimi_a11y_rewrite\')"> ' + tH('a11y_rewrite_label') + '</label>' +
    '<div class="ms-hint">' + tH('a11y_rewrite_hint') + '</div>';
  // Security (password + logout) now lives in the Users pane ("Your account").
  return h;
}

// ---- App updates (Manage ▸ Server) ----------------------------------------
// The Zimi APPLICATION's own release check — a different feature from the
// "Auto-update" toggle elsewhere in Manage, which refreshes ZIM content.
// Shell snippets are deliberately NOT i18n'd: commands are commands.
var _APP_UPDATE_CMDS = {
  docker: 'docker compose pull && docker compose up -d',
  pip: 'pip install --upgrade zimi',
  homebrew: 'brew upgrade --cask zimi'
};

function _appUpdateReleasesLink(d) {
  return '<a class="app-update-link" href="' + escAttr(d.releases_url || 'https://github.com/epheterson/Zimi/releases') +
    '" target="_blank" rel="noopener">' + tH('app_update_releases') + '</a>';
}

// The per-install-type upgrade instruction, shown only when an update exists.
function _appUpdateHowHtml(d) {
  var type = d.install_type || '';
  var cmd = _APP_UPDATE_CMDS[type];
  if (cmd) {
    var hintKey = type === 'docker' ? 'app_update_how_docker'
      : type === 'homebrew' ? 'app_update_how_brew' : 'app_update_how_pip';
    return '<div class="ms-hint">' + tH(hintKey) + '</div>' +
      '<code class="app-update-cmd">' + esc(cmd) + '</code>';
  }
  if (type === 'snap') return '<div class="ms-hint">' + tH('app_update_how_snap') + '</div>';
  if (type === 'desktop-mac' || type === 'desktop-windows') {
    // Sparkle/WinSparkle self-updates — unless offline mode disabled the
    // appcast, in which case the releases page is the only path.
    return d.offline
      ? '<div class="ms-hint">' + tH('app_update_how_releases') + ' ' + _appUpdateReleasesLink(d) + '</div>'
      : '<div class="ms-hint">' + tH('app_update_how_desktop') + '</div>';
  }
  // appimage, plain frozen linux, and anything unrecognized: point at releases.
  return '<div class="ms-hint">' + tH('app_update_how_releases') + ' ' + _appUpdateReleasesLink(d) + '</div>';
}

// Latest vs beta, and how long a release must have been public before this
// instance is offered it. Locked (ZIMI_UPDATE_CHANNEL / ZIMI_UPDATE_DELAY_DAYS)
// renders the same select, disabled with the standard env-controlled note, so
// the setting stays visible instead of vanishing on the deployments most
// likely to set it.
var _APP_UPDATE_CHANNEL_LABELS = {
  latest: 'app_update_channel_latest',
  beta: 'app_update_channel_beta'
};
var _APP_UPDATE_SELECT_CSS = 'font-size:12px;padding:3px 8px;border-radius:4px;' +
  'border:1px solid var(--border);background:var(--surface2);color:var(--text)';

// One row shape for both update selects: label, <select>, and either the
// setting's hint or the env-controlled note when the env var owns it.
function _appUpdateSelectRow(o) {
  var lockNote = t('env_controlled', { v: o.envVar });
  return '<div class="mc-row" style="align-items:center">' +
      '<span class="mc-label">' + esc(t(o.labelKey)) + '</span>' +
      '<span class="mc-value"><select id="' + escAttr(o.id) + '" style="' + _APP_UPDATE_SELECT_CSS +
        (o.locked ? ';opacity:0.5' : '') + '"' +
        (o.locked ? ' disabled title="' + escAttr(lockNote) + '"' : '') +
        ' onchange="' + escAttr(o.onchange) + '">' + o.options + '</select></span></div>' +
    '<div class="ms-hint">' + esc(o.locked ? lockNote : t(o.hintKey)) + '</div>';
}

// String(value) matters: escAttr() turns a falsy value into '', which would
// give the zero-day option an empty value and post a NaN delay.
function _appUpdateOption(value, label, selected) {
  return '<option value="' + escAttr(String(value)) + '"' + (selected ? ' selected' : '') + '>' +
    esc(label) + '</option>';
}

function _appUpdateChannelHtml(d) {
  var cur = d.channel || 'latest';
  var opts = (d.channels || ['latest', 'beta']).map(function(c) {
    var key = _APP_UPDATE_CHANNEL_LABELS[c];
    return _appUpdateOption(c, key ? t(key) : c, c === cur);
  }).join('');
  return _appUpdateSelectRow({
    id: 'app-update-channel',
    labelKey: 'app_update_channel',
    hintKey: 'app_update_channel_hint',
    envVar: d.channel_env || 'ZIMI_UPDATE_CHANNEL',
    locked: !!d.channel_locked,
    onchange: '_appUpdateSetChannel(this.value)',
    options: opts
  });
}

// A saved delay the presets don't cover (set over the API or by an env var)
// gets its own option rather than being silently rounded to a preset.
function _appUpdateDelayHtml(d) {
  var cur = d.delay_days || 0;
  var choices = (d.delay_choices || [0, 1, 3, 7, 14, 30]).slice();
  if (choices.indexOf(cur) < 0) choices.push(cur);
  choices.sort(function(a, b) { return a - b; });
  var opts = choices.map(function(n) {
    return _appUpdateOption(n, n === 0 ? t('app_update_delay_none') : tPlural('app_update_delay_days', n), n === cur);
  }).join('');
  return _appUpdateSelectRow({
    id: 'app-update-delay',
    labelKey: 'app_update_delay',
    hintKey: 'app_update_delay_hint',
    envVar: d.delay_env || 'ZIMI_UPDATE_DELAY_DAYS',
    locked: !!d.delay_days_locked,
    onchange: '_appUpdateSetDelay(this.value)',
    options: opts
  });
}

var _MS_PER_DAY = 86400000;

// Days still to wait before a held release is offered — always at least 1, so
// the last hours read "1 day" rather than "0 days".
function _appUpdateHeldDays(d) {
  var ms = (d.held_until || 0) * 1000 - Date.now();
  return Math.max(1, Math.ceil(ms / _MS_PER_DAY));
}

// The app-update block, as three independently repaintable slots.
//
// It used to be one string, and "Check now" replaced the whole of it with a
// single "Checking…" line: the block collapsed from five rows to one, shoving
// everything below it up the pane and back down a moment later, and the two
// selects were destroyed and rebuilt around a request that could not change
// them. That read as the pane reloading itself. Now a check touches the status
// slot alone, so the block keeps its height and its controls keep their
// identity — and a settings save repaints the same way, instead of deleting
// the select the admin just used.
var _APP_UPDATE_ID = 'ms-app-update';
var _APP_UPDATE_STATUS_ID = 'ms-app-update-status';
var _APP_UPDATE_HOW_ID = 'ms-app-update-how';
var _APP_UPDATE_SETTINGS_ID = 'ms-app-update-settings';

// The last payload, kept so the checking state can be drawn over the version
// and the settings that are still true while the request is in flight.
var _appUpdateData = null;

// Write into a slot only when the markup actually differs. A <select> that is
// re-assigned identical HTML is still a NEW element — it loses focus and shuts
// an open dropdown — so "no change" has to mean "do not touch it".
function _setHtmlIfChanged(id, html) {
  var el = document.getElementById(id);
  if (el && el.innerHTML !== html) el.innerHTML = html;
}

// The version row and the status row: the two lines a check can change.
// `checking` swaps the verdict for the in-flight line and the button for a
// spinner, keeping both rows exactly where they were.
function _appUpdateStatusHtml(d, checking) {
  var status = checking
    ? '<span class="app-update-quiet">' + tH('app_update_checking') + '</span>'
    : _appUpdateVerdictHtml(d);
  var action = checking
    ? '<span class="spinner-inline" aria-hidden="true"></span>'
    : (d.offline ? '' : '<button class="pill" onclick="_appUpdateCheckNow()">' +
        tH('app_update_check_now') + '</button>');
  return '<div class="mc-row"><span class="mc-label">' + tH('app_update_version') + '</span>' +
    '<span class="mc-value">' + esc(d.current || '?') + '</span></div>' +
    '<div class="mc-row"><span class="mc-label">' + status + '</span>' +
    '<span class="mc-value">' + action + '</span></div>';
}

function _appUpdateHowSlot(d) {
  return d.update_available ? _appUpdateHowHtml(d) : '';
}

// Offline mode does no checking at all, so these would be controls with
// nothing behind them.
function _appUpdateSettingsSlot(d) {
  return d.offline ? '' : _appUpdateChannelHtml(d) + _appUpdateDelayHtml(d);
}

function _appUpdateHtml(d) {
  return '<div id="' + _APP_UPDATE_STATUS_ID + '">' + _appUpdateStatusHtml(d, false) + '</div>' +
    '<div id="' + _APP_UPDATE_HOW_ID + '">' + _appUpdateHowSlot(d) + '</div>' +
    '<div id="' + _APP_UPDATE_SETTINGS_ID + '">' + _appUpdateSettingsSlot(d) + '</div>';
}

// Repaint from a payload: the whole block on first mount, and slot by slot
// after that, so nothing that did not change is rebuilt.
function _appUpdatePaint(d) {
  _appUpdateData = d;
  var host = document.getElementById(_APP_UPDATE_ID);
  if (!host) return;
  if (!document.getElementById(_APP_UPDATE_STATUS_ID)) {
    host.innerHTML = _appUpdateHtml(d);
    return;
  }
  _setHtmlIfChanged(_APP_UPDATE_STATUS_ID, _appUpdateStatusHtml(d, false));
  _setHtmlIfChanged(_APP_UPDATE_HOW_ID, _appUpdateHowSlot(d));
  _setHtmlIfChanged(_APP_UPDATE_SETTINGS_ID, _appUpdateSettingsSlot(d));
}

// One line of the status slot: what this build is, relative to what is out
// there. Split out of the block so a check can redraw the verdict alone.
function _appUpdateVerdictHtml(d) {
  var status;
  if (d.update_available) {
    status = '<span class="app-update-badge">' + tH('app_update_available', { v: d.latest }) + '</span>' +
      (d.prerelease ? ' <span class="app-update-quiet">' + tH('app_update_prerelease') + '</span>' : '');
  } else if (d.update_held) {
    // The release exists and we know it — say so quietly instead of showing
    // "up to date", which would be a lie the user could check.
    status = '<span class="app-update-quiet">' +
      tH('app_update_held', { v: d.latest, d: tPlural('app_update_delay_days', _appUpdateHeldDays(d)) }) + '</span>';
  } else if (d.offline) {
    status = '<span class="app-update-quiet">' + tH('app_update_offline') + '</span>';
  } else if (d.latest && !d.error) {
    // Up to date: one quiet line, no celebration.
    status = '<span class="app-update-quiet">' + tH('app_update_up_to_date') + '</span>';
  } else {
    status = '<span class="app-update-quiet">' + tH(d.error ? 'app_update_failed' : 'app_update_never') + '</span>';
  }
  return status;
}

// Show the in-flight state without moving anything: the status row alone
// changes, and only when the block is already mounted. On a cold mount there
// is no shape to preserve and the loading placeholder is still right.
function _appUpdateShowChecking() {
  if (!document.getElementById(_APP_UPDATE_STATUS_ID)) return;
  _setHtmlIfChanged(_APP_UPDATE_STATUS_ID,
    _appUpdateStatusHtml(_appUpdateData || {}, true));
}

// A failed check must not take the settings down with it. The verdict line
// says so and everything else stays put — the channel and delay the admin set
// are still true, whatever the network did.
function _appUpdateShowError() {
  var host = document.getElementById(_APP_UPDATE_ID);
  if (!host) return;
  if (!document.getElementById(_APP_UPDATE_STATUS_ID)) {
    host.innerHTML = '<div class="ms-hint">' + tH('app_update_failed') + '</div>';
    return;
  }
  var d = _appUpdateData || {};
  _setHtmlIfChanged(_APP_UPDATE_STATUS_ID,
    _appUpdateStatusHtml({ current: d.current, offline: d.offline, error: true }, false));
}

function _renderAppUpdate(force) {
  if (!document.getElementById(_APP_UPDATE_ID)) return;
  if (force) _appUpdateShowChecking();
  var req = force
    ? manageFetch('/manage/app-update-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    : manageFetch('/manage/app-update');
  req.then(function(r) { return r.json(); })
    .then(_appUpdatePaint)
    .catch(_appUpdateShowError);
}

function _appUpdateCheckNow() { _renderAppUpdate(true); }

// Both update settings answer with the full app-update payload, so the
// response IS the repainted state. The only reachable error is the env lock
// (the select is disabled then, so that means a second browser raced a config
// change) — say so and repaint from server truth.
function _appUpdateSaveSetting(path, body, envVar) {
  if (!document.getElementById(_APP_UPDATE_ID)) return;
  _appUpdateShowChecking();
  manageFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d && d.error) { _showToast(t('env_controlled', { v: envVar })); _renderAppUpdate(false); return; }
    _appUpdatePaint(d);
  }).catch(function() { _renderAppUpdate(false); });
}

// Switching channel re-checks server-side (the cached answer belongs to the
// other channel); the delay is applied when the payload is built, so neither
// needs a follow-up fetch.
function _appUpdateSetChannel(channel) {
  _appUpdateSaveSetting('/manage/app-update-channel', { channel: channel }, 'ZIMI_UPDATE_CHANNEL');
}

function _appUpdateSetDelay(days) {
  _appUpdateSaveSetting('/manage/app-update-delay', { delay_days: parseInt(days, 10) }, 'ZIMI_UPDATE_DELAY_DAYS');
}

function _msServerHtml() {
  // Sharing is the star of v1.7 — it leads the Server pane. Render the
  // last-known rows immediately (stale toggles beat a blank slab that
  // pops in); _renderMirrorSection repaints from server truth right after.
  var shareCached = '';
  try { shareCached = localStorage.getItem(SK.SHARE_ROWS) || ''; } catch (e) {}
  var sep = '<div style="border-top:1px solid var(--border);margin:16px 0 14px"></div>';

  // App updates FIRST — the thing an operator opens Server settings to check.
  // NOT the ZIM-content "Auto-update" toggle; ids stay app_update-prefixed.
  var updatesSec = '<div class="ms-section-label">' + tH('app_update_section') + '</div>' +
    '<div id="' + _APP_UPDATE_ID + '" class="ms-app-update">' + tH('loading') + '</div>';

  var sharingSec = '<div class="ms-section-label">' + tH('sharing_section') + '</div>' +
    '<div id="ms-mirror-status" class="share-rows-slot">' + (shareCached || _shareSkeletonHtml()) + '</div>';

  var downloadsSec = '<div class="ms-section-label">' + tH('downloads_section') + '</div>' +
    '<div id="ms-dl-schedule" class="ms-dl-schedule">' + tH('loading') + '</div>';

  // Storage owns its desktop variant so the section can move freely — the old
  // reorder-fragile string split is gone.
  var storageSec = '<div class="ms-section-label">' + tH('storage_section') + '</div>';
  if (IS_DESKTOP) {
    storageSec +=
      '<div class="ms-field"><label>' + tH('zim_folder') + '</label>' +
      '<div style="display:flex;gap:8px"><input type="text" id="ms-zim-dir" readonly value="' + escAttr(t('loading')) + '" style="flex:1">' +
      '<button class="manage-btn-action" style="background:var(--surface2);color:var(--text);border:1px solid var(--border)" onclick="msChooseZimFolder()">' + tH('choose_folder') + '</button></div></div>' +
      '<div class="ms-field"><label>' + tH('data_folder') + '</label>' +
      '<div style="display:flex;gap:8px"><input type="text" id="ms-data-dir" readonly value="' + escAttr(t('loading')) + '" style="flex:1">' +
      '<button class="manage-btn-action" style="background:var(--surface2);color:var(--text);border:1px solid var(--border)" onclick="msChooseDataFolder()">' + tH('choose_folder') + '</button></div></div>' +
      '<div class="ms-hint">' + tH('data_folder_hint') + '</div>' +
      '<div class="ms-field" style="display:flex;align-items:center;gap:8px"><label style="margin:0">' + tH('port') + '</label><input type="number" id="ms-port" min="1024" max="65535" value="8899" style="width:90px">' +
        '<button class="manage-btn-action" onclick="settingsSaveInline()" style="margin-inline-start:auto">' + tH('save') + '</button></div>' +
      '<div class="ms-hint">' + tH('restart_hint') + '</div>';
  } else {
    storageSec +=
      '<div class="ms-field"><label>' + tH('zim_folder') + '</label><input type="text" id="ms-zim-dir" readonly value="' + escAttr(t('loading')) + '"></div>' +
      '<div class="ms-field"><label>' + tH('data_folder') + '</label><input type="text" id="ms-data-dir" readonly value="' + escAttr(t('loading')) + '"></div>' +
      '<div class="ms-hint">' + tH('configured_via_env') + '</div>';
  }

  // My data + Server backups — two self-titled cards, no extra heading.
  var backupSec = '<div id="ms-backup" class="ms-backup">' + _backupHubHtml() + '</div>';

  var tokenSec = '<div id="ms-security">' + tH('loading') + '</div>';

  var hotSec = '<div class="ms-section-label">' + tH('hot_zims') + '</div>' +
    '<div class="ms-hint">' + tH('hot_zims_hint') + '</div>' +
    '<div id="ms-hot-zims" style="margin-top:10px">' + tH('loading') + '</div>' +
    '<div style="margin-top:14px" id="ms-cache-info-wrap">' +
      '<div id="ms-cache-info" style="color:var(--text2);font-size:12px">' + tH('loading') + '</div></div>';

  // Sharing, Downloads, Storage, My Data / Server Backups, then App Updates
  // just before the API Token, and Hot ZIMs + cache last (Eric moved Updates
  // down from the top on the second pass).
  var h = [sharingSec, downloadsSec, storageSec, backupSec, updatesSec, tokenSec, hotSec].join(sep);
  // Async fill security
  Promise.all([
    fetch('/manage/has-password').then(function(r) { return r.json(); }).catch(function() { return {}; }),
    manageFetch('/manage/has-token').then(function(r) { return r.json(); }).catch(function() { return {}; })
  ]).then(function(results) {
    var hasPw = results[0].has_password;
    var hasToken = results[1].has_token;
    var el = document.getElementById('ms-security');
    if (!el) return;
    var sh = '<div class="mc-row"><span class="mc-label">' + tH('api_token') + '</span><span class="mc-value">';
    if (hasToken) {
      sh += '<button class="pill" onclick="_regenerateToken()">' + tH('roll') + '</button> ' +
        '<button class="pill" onclick="_revokeToken()">' + tH('revoke') + '</button>';
    } else {
      sh += '<button class="pill" onclick="_generateToken()">' + tH('generate') + '</button>';
    }
    sh += '</span></div>';
    el.innerHTML = sh;
  });
  // These populate elements by id, so they must run AFTER this HTML is in
  // the DOM — not mid-string. Deferring one tick also lets the cached
  // sharing rows paint first, so the section never flashes empty.
  setTimeout(function() {
    if (_msSection !== 'server') return;
    _renderHotZimsSection();
    _renderSeedingSection();
    _renderMirrorSection();
    _renderDownloadSchedule();
    _renderAppUpdate();
  }, 0);
  _msFetch('/manage/cache-info').then(function(d) {
    var el = document.getElementById('ms-cache-info');
    if (!el || !d.caches) return;
    var c = d.caches;
    var sh = _cacheBreakdownHtml(d) +
      '<div class="mc-row"><span class="mc-label">' + tH('title_indexes') + '</span><span class="mc-value">' +
      (c.title_indexes.count || 0) + ' files, ' + _fmtBytes(c.title_indexes.size_bytes) + '</span></div>' +
      '<div class="mc-row"><span class="mc-label">' + tH('qid_indexes') + '</span><span class="mc-value">' +
      (c.qid_indexes.count || 0) + ' files, ' + _fmtBytes(c.qid_indexes.size_bytes) + '</span></div>' +
      '<div class="ms-cache-actions" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">' +
        '<button class="pill" onclick="_cacheAction(this,\'clear-search\')">' + tH('clear_search_cache') + '</button>' +
        '<button class="pill" onclick="_cacheAction(this,\'clear-suggest\')">' + tH('clear_suggest_cache') + '</button>' +
        '<button class="pill" onclick="_cacheAction(this,\'rebuild-title\')">' + tH('rebuild_title_indexes') + '</button>' +
        '<button class="pill" onclick="_cacheAction(this,\'rebuild-qid\')">' + tH('rebuild_qid_indexes') + '</button>' +
        '<span id="ms-cache-status" class="ms-hint" style="margin:0;align-self:center"></span>' +
      '</div>';
    el.innerHTML = sh;
  }).catch(function() {});
  // Async fill from stats
  _msFetch('/manage/stats').then(function(s) {
    var el = document.getElementById('ms-zim-dir');
    if (el && s.disk && s.disk.zim_dir) el.value = s.disk.zim_dir;
    else if (el) el.value = '(unknown)';
    var el2 = document.getElementById('ms-data-dir');
    if (el2 && s.disk && s.disk.data_dir) el2.value = s.disk.data_dir;
    else if (el2) el2.value = '(unknown)';
    // For desktop, fill port
    var portEl = document.getElementById('ms-port');
    if (portEl && s.port) portEl.value = s.port;
  }).catch(function() {
    var el = document.getElementById('ms-zim-dir');
    if (el) el.value = '(unavailable)';
    var el2 = document.getElementById('ms-data-dir');
    if (el2) el2.value = '(unavailable)';
  });
  return h;
}


// Below this many installed ZIMs, the warm-everything default is fine and
// the hot-cache UI gets in the way. Render it collapsed under a "Show" toggle
// so users with a small library can still pin if they want to.
const _HOT_ZIMS_MIN = 10;
let _hotZimsForceShow = false;

async function _renderHotZimsSection() {
  let hotData, zims;
  try {
    [hotData, zims] = await Promise.all([
      _msFetch('/manage/hot'),
      _fetchList(),
    ]);
  } catch (e) {
    const errEl = document.getElementById('ms-hot-zims');
    if (errEl) errEl.textContent = t('error');
    return;
  }
  const container = document.getElementById('ms-hot-zims');
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  const hasHotConfigured = (hotData.hot_zims || []).length > 0;
  // Always collapsed by default — the pin list is noisy. A one-line
  // summary (when pins exist) plus the expand button.
  if (!hotData.env_locked && !_hotZimsForceShow) {
    if (hasHotConfigured) {
      const summary = document.createElement('div');
      summary.className = 'ms-hint';
      summary.style.marginBottom = '6px';
      summary.textContent = t('hot_zims_pinned_n', {n: (hotData.hot_zims || []).length});
      container.appendChild(summary);
    }
    const toggle = document.createElement('button');
    toggle.className = 'pill ms-hot-show';
    toggle.textContent = t('hot_zims_show_anyway');
    toggle.onclick = () => {
      _hotZimsForceShow = true;
      _renderHotZimsSection();
    };
    container.appendChild(toggle);
    return;
  }

  if (hotData.env_locked) {
    const note = document.createElement('div');
    note.className = 'ms-hint';
    note.style.color = 'var(--amber)';
    note.textContent = t('hot_zims_env_locked');
    container.appendChild(note);
    return;
  }

  const hotSet = new Set(hotData.hot_zims || []);
  const zimNames = (Array.isArray(zims) ? zims : []).map(z => z.name).filter(Boolean).sort();
  const zimTitles = Object.fromEntries(
    (Array.isArray(zims) ? zims : []).map(z => [z.name, z.title || z.name])
  );
  if (zimNames.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ms-hint';
    empty.textContent = t('no_zims_installed');
    container.appendChild(empty);
    return;
  }

  // Toolbar: search box + select-all / clear-all buttons.
  const toolbar = document.createElement('div');
  toolbar.className = 'hot-zims-toolbar';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'hot-zims-search';
  search.placeholder = t('hot_zims_search_placeholder');
  search.addEventListener('input', () => _filterHotZimsList(search.value));
  const allBtn = document.createElement('button');
  allBtn.className = 'pill';
  allBtn.textContent = t('select_all');
  allBtn.onclick = () => _toggleAllHotZims(true);
  const noneBtn = document.createElement('button');
  noneBtn.className = 'pill';
  noneBtn.textContent = t('select_none');
  noneBtn.onclick = () => _toggleAllHotZims(false);
  toolbar.appendChild(search);
  toolbar.appendChild(allBtn);
  toolbar.appendChild(noneBtn);
  container.appendChild(toolbar);

  const list = document.createElement('div');
  list.className = 'hot-zims-list';
  zimNames.forEach(name => {
    const row = document.createElement('label');
    row.className = 'hot-zims-row';
    row.dataset.search = (name + ' ' + (zimTitles[name] || '')).toLowerCase();
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = hotSet.has(name);
    const title = document.createElement('span');
    title.className = 'hot-zims-title';
    title.textContent = zimTitles[name] || name;
    const id = document.createElement('span');
    id.className = 'hot-zims-id';
    id.textContent = name;
    row.appendChild(cb);
    row.appendChild(title);
    row.appendChild(id);
    list.appendChild(row);
  });
  container.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'hot-zims-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'manage-btn-action';
  saveBtn.textContent = t('save');
  saveBtn.onclick = () => _saveHotZims(saveBtn);
  actions.appendChild(saveBtn);
  // Inverse of the "Choose hot ZIMs…" expander — collapse the list back to the
  // one-line summary (the section had a Show but no Hide) (W1.5).
  const hideBtn = document.createElement('button');
  hideBtn.className = 'pill ms-hot-hide';
  hideBtn.textContent = t('hot_zims_hide');
  hideBtn.onclick = () => { _hotZimsForceShow = false; _renderHotZimsSection(); };
  actions.appendChild(hideBtn);
  const status = document.createElement('span');
  status.id = 'ms-hot-status';
  status.className = 'ms-hint';
  status.style.margin = '0';
  actions.appendChild(status);
  container.appendChild(actions);
}

function _filterHotZimsList(query) {
  const q = query.trim().toLowerCase();
  document.querySelectorAll('#ms-hot-zims .hot-zims-row').forEach(row => {
    row.style.display = !q || row.dataset.search.includes(q) ? '' : 'none';
  });
}

function _toggleAllHotZims(checked) {
  // Apply to currently-visible rows only (so search-narrow then select-all works).
  document.querySelectorAll('#ms-hot-zims .hot-zims-row').forEach(row => {
    if (row.style.display === 'none') return;
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = checked;
  });
}

// Lightweight status refresh — updates ONLY the BT status dot/label and the
// port reachability dot, in place. No seeding list (that lives in the
// Downloads tab; rendering it here changed height and made the pane jump),
// no full-section rebuild. Kept the name so the many callers don't churn.
async function _renderSeedingSection() {
  let bt;
  try {
    bt = await _msFetch('/manage/bt-status');
  } catch (e) {
    return; // keep last-known status (#30)
  }
  const statusEl = document.getElementById('ms-bt-status');
  if (!statusEl) return;
  // Green only when the sidecar process is actually up — "ready" alone means
  // the binary exists. While it's coming up the label says "starting…" so
  // text and dot never disagree; a short settle poll flips it green.
  const starting = bt.status === 'ready' && bt.enabled && !bt.sidecar_running
    && _btSettlePollsLeft > 0;
  const stColor = bt.status === 'ready'
    ? (bt.sidecar_running ? '#6abf69' : 'var(--text3)')
    : bt.status === 'unavailable' ? '#d9a13d' : 'var(--text3)';
  const stateLabel = starting ? t('bt_state_starting') : t('bt_state_' + bt.status);
  statusEl.innerHTML = '<span class="share-port-dot" style="background:' + stColor + '"></span>' + esc(stateLabel);
  window._btStatusHtml = statusEl.innerHTML;
  // Port reachability dot, updated in place (no row rebuild).
  const pdot = document.getElementById('share-port-dot');
  if (pdot) {
    const reach = bt.nat ? bt.nat.reachable : null;
    pdot.style.background = reach == null ? 'var(--text3)' : (reach ? '#6abf69' : 'var(--error)');
    pdot.title = reach == null ? t('bt_port_unknown') : (reach ? t('bt_port_open') : t('bt_port_closed'));
  }
  if (starting) {
    _btSettlePollsLeft--;
    clearTimeout(window._btSettleTimer);
    window._btSettleTimer = setTimeout(function() {
      if (mode === 'manage') _renderSeedingSection();
    }, _BT_SETTLE_POLL_MS);
  } else {
    _btSettlePollsLeft = 0;
  }
}

// The v1.7 sharing hero: three switches — BitTorrent (with seed ratio),
// Mirror, Nearby. Env-locked settings render disabled with the env hint.
// `inactive` greys a switch that depends on another being on (Mirror with
// BT off): unmodifiable, but its saved state persists untouched.
function _shareSwitch(key, on, locked, envVar, titleKey, descHtml, inactive, underSwitchHtml) {
  return '<div class="share-row' + (locked ? ' share-locked' : '') + (inactive ? ' share-inactive' : '') + '">' +
    '<div class="share-row-text">' +
      '<div class="share-row-title">' + tH(titleKey) + '</div>' +
      '<div class="share-row-desc">' + descHtml + '</div>' +
      (locked ? '<div class="share-row-desc share-row-locknote">' + tH('env_controlled', {v: envVar}) + '</div>' : '') +
    '</div>' +
    '<div class="share-row-right">' +
      '<label class="switch"><input type="checkbox" role="switch"' + (on ? ' checked' : '') + ((locked || inactive) ? ' disabled' : '') +
        ' aria-label="' + escAttr(t(titleKey)) + '"' +
        ' onchange="_setBtSetting(\'' + key + '\', this)"><span class="switch-slider"></span></label>' +
      (underSwitchHtml || '') +
    '</div>' +
  '</div>';
}

var _btSettingInFlight = false;
// Settle poll: after an action that (re)spawns the sidecar, re-check status
// every 1.5s until RPC answers (green dot) or the budget runs out. Armed
// only by those actions — a dead sidecar on plain pane open shows honestly.
var _btSettlePollsLeft = 0;
var _BT_SETTLE_POLL_MS = 1500;
var _BT_SETTLE_POLL_MAX = 10;

// Enable/disable the BT card's inner controls in place — no re-render, no
// height change (they're always in the DOM; a toggle only flips `disabled`
// and dims the group). Env-locked fields stay locked.
function _applyTorrentToggleInPlace(on) {
  const controls = document.getElementById('ms-bt-controls');
  if (controls) {
    controls.classList.toggle('share-controls-off', !on);
    controls.querySelectorAll('input, button').forEach(function(el) {
      // data-nogate stays editable with BT off: it governs HTTP downloads too
      // (e.g. the concurrent-download cap), not just the BT engine.
      if (el.dataset.envlock === '1' || el.dataset.nogate === '1') return;
      el.disabled = !on;
    });
  }
  const st = document.getElementById('ms-bt-status');
  if (st) st.innerHTML = '<span class="share-port-dot" style="background:var(--text3)"></span>' +
    esc(t(on ? 'bt_state_starting' : 'bt_state_off'));
  // Mirror depends on BT: grey its card + disable its switch instantly.
  const mrow = document.querySelector('#ms-mirror-status input[onchange*="\'mirror\'"]');
  const mcard = mrow && mrow.closest('.share-row');
  if (mcard) {
    mcard.classList.toggle('share-inactive', !on);
    if (mrow.dataset.envlock !== '1') mrow.disabled = !on;
  }
  // Mirror can't be active without BT — reflect its true state in the
  // shared right-column status dot.
  const mact = document.getElementById('ms-mirror-active');
  if (mact) mact.innerHTML = _mirrorStatusHtml(on && mrow && mrow.checked);
}

// Shared status line for the Mirror card's right column — same shape as the
// BT "ready" dot so the two cards' lights sit in identical spots.
function _mirrorStatusHtml(active) {
  return '<span class="share-port-dot" style="background:' + (active ? '#6abf69' : 'var(--text3)') + '"></span>' +
    esc(active ? t('seeding_state_active') : t('bt_state_off'));
}

function _applyMirrorToggleInPlace(on) {
  const mact = document.getElementById('ms-mirror-active');
  if (mact) mact.innerHTML = _mirrorStatusHtml(on);
}

async function _setBtSetting(key, cb) {
  const on = cb.checked;
  cb.disabled = true;
  _btSettingInFlight = true;
  // Optimistic, in-place feedback the instant a switch flips — no rebuild,
  // so nothing jumps and there's zero perceived lag (Eric: "every toggle is
  // delayed and jumpy"). The server write happens in the background.
  if (key === 'torrent') _applyTorrentToggleInPlace(on);
  else if (key === 'mirror') _applyMirrorToggleInPlace(on);
  try {
    const body = {}; body[key] = on;
    const r = await manageFetch('/manage/bt-settings', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      cb.checked = !on; _showToast(t('save_failed'));
      if (key === 'torrent') _applyTorrentToggleInPlace(!on);
      else if (key === 'mirror') _applyMirrorToggleInPlace(!on);
    }
  } catch (e) {
    cb.checked = !on; _showToast(t('save_failed'));
    if (key === 'torrent') _applyTorrentToggleInPlace(!on);
    else if (key === 'mirror') _applyMirrorToggleInPlace(!on);
  }
  cb.disabled = false;
  _btSettingInFlight = false;
  // Turning BT on spawns the sidecar server-side — watch it come up (updates
  // just the status dot in place, never the whole section).
  if (key === 'torrent' && cb.checked) _btSettlePollsLeft = _BT_SETTLE_POLL_MAX;
  _renderSeedingSection();
}

async function _setBtLimit(inp, which) {
  // MB/s in the UI → KB/s on the wire. 0 = unlimited.
  const mbps = Math.max(0, parseFloat(inp.value) || 0);
  inp.value = mbps;
  const kb = Math.round(mbps * 1024);
  const body = {}; body[which === 'up' ? 'bt_up_kb' : 'bt_down_kb'] = kb;
  try {
    const r = await manageFetch('/manage/bt-settings', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    if (!r.ok) _showToast(t('save_failed')); else _showToast(t('saved'));
  } catch (e) { _showToast(t('save_failed')); }
}

async function _setPeerName(inp) {
  const v = inp.value.trim().slice(0, 63);
  try {
    const r = await manageFetch('/manage/bt-settings', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({peer_name: v})
    });
    if (!r.ok) _showToast(t('save_failed'));
    else _showToast(t('saved'));
  } catch (e) { _showToast(t('save_failed')); }
}

async function _setSeedRatio(inp) {
  const v = Math.max(0, Math.min(10, parseFloat(inp.value) || 0));
  inp.value = v;
  try {
    const r = await manageFetch('/manage/bt-settings', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({seed_ratio: v})
    });
    if (!r.ok) _showToast(t('save_failed'));
  } catch (e) { _showToast(t('save_failed')); }
}

// One POST helper for the numeric BT settings that only need save/toast
// feedback (concurrent downloads, max connections).
async function _postBtSetting(body) {
  try {
    const r = await manageFetch('/manage/bt-settings', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    if (!r.ok) { _showToast(t('save_failed')); return; }
    _showToast(t('saved'));
  } catch (e) { _showToast(t('save_failed')); }
}

async function _setBtMaxDl(inp) {
  const v = Math.max(1, Math.min(20, parseInt(inp.value, 10) || 4));
  inp.value = v;
  await _postBtSetting({max_active_downloads: v});
}

async function _setBtMaxConn(inp) {
  const v = Math.max(10, Math.min(2000, parseInt(inp.value, 10) || 200));
  inp.value = v;
  await _postBtSetting({bt_max_connections: v});
}

// Clean reload glyph — the old ⟳ unicode char rendered inconsistently and
// looked amateur next to the crafted inputs. Inline SVG is pixel-stable.
var _SVG_REFRESH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';

// Port row: [port input] [reachability dot] [retry] [UPnP]. Always rendered
// (disabled when BT is off) so the card height never changes on toggle.
function _portRowInner(bt, btOn) {
  var nat = bt.nat || null;
  var dotColor = !nat || nat.reachable == null ? 'var(--text3)' : (nat.reachable ? '#6abf69' : 'var(--error)');
  var dotTitle = !nat || nat.reachable == null ? t('bt_port_unknown') : (nat.reachable ? t('bt_port_open') : t('bt_port_closed'));
  var portLock = bt.bt_port_env_locked;
  var upnpLock = bt.upnp_env_locked;
  var portDis = (portLock || !btOn) ? ' disabled' : '';
  var upnpDis = (upnpLock || !btOn) ? ' disabled' : '';
  return '<label>' + tH('bt_port_word') + '</label>' +
    '<span class="share-port-group">' +
      '<input type="number" class="share-num-input share-port-input" min="1024" max="65535" value="' + (bt.bt_port || '') + '"' +
        portDis + (portLock ? ' data-envlock="1" title="' + escAttr(t('env_controlled', {v: 'ZIMI_BT'})) + '"' : '') +
        ' aria-label="' + escAttr(t('bt_port_word')) + '" onchange="_setBtPort(this)">' +
      // Reachability light sits right beside the port it describes.
      '<span class="share-port-dot" id="share-port-dot" title="' + escAttr(dotTitle) + '" style="background:' + dotColor + '"></span>' +
      '<button class="share-port-retry"' + (btOn ? '' : ' disabled') + ' onclick="_natRecheck(this)" title="' + escAttr(t('bt_port_recheck_hint')) + '" aria-label="' + escAttr(t('retry')) + '">' + _SVG_REFRESH + '</button>' +
      '<label class="share-upnp"' + (upnpLock ? ' title="' + escAttr(t('env_controlled', {v: 'ZIMI_BT'})) + '"' : '') + '>' +
        '<input type="checkbox"' + (bt.upnp_enabled ? ' checked' : '') + upnpDis + (upnpLock ? ' data-envlock="1"' : '') + ' onchange="_setUpnp(this)"> UPnP' +
      '</label>' +
    '</span>';
}

async function _setBtPort(inp) {
  var v = parseInt(inp.value, 10);
  if (!(v >= 1024 && v <= 65535)) { _showToast(t('error')); return; }
  try {
    const r = await manageFetch('/manage/bt-settings', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({bt_port: v})
    });
    if (!r.ok) { _showToast(t('save_failed')); return; }
    _showToast(t('saved'));
    // The sidecar respawns on the new port; watch it come back up
    _btSettlePollsLeft = _BT_SETTLE_POLL_MAX;
    setTimeout(function() { _renderMirrorSection(); _renderSeedingSection(); }, 4000);
  } catch (e) { _showToast(t('save_failed')); }
}

function _natBadge(nat) {
  if (!nat || nat.reachable == null) return '<span style="color:var(--text3)">? ' + tH('bt_port_unknown') + '</span>';
  return nat.reachable
    ? '<span style="color:#6abf69">\u2713 ' + tH('bt_port_open') + '</span>'
    : '<span style="color:var(--error)">\u2717 ' + tH('bt_port_closed') + '</span>';
}

async function _natRecheck(btn) {
  btn.disabled = true;
  btn.classList.add('spinning');  // CSS spins the SVG; don't touch innerHTML
  try {
    const r = await manageFetch('/manage/nat-recheck', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}' });
    await r.json().catch(function() { return null; });
    if (!r.ok) _showToast(t('error'));
  } catch (e) {
    _showToast(t('error'));
  }
  btn.disabled = false;
  btn.classList.remove('spinning');
  // Update only the port row — a full section re-render makes everything
  // blink for a one-line change.
  try {
    const rb = await manageFetch('/manage/bt-status');
    if (rb.ok) {
      const bt = await rb.json();
      const row = document.getElementById('share-port-row');
      if (row && bt.enabled) row.innerHTML = _portRowInner(bt, true);
    }
  } catch (e) {}
}

async function _setUpnp(cb) {
  try {
    const r = await manageFetch('/manage/bt-settings', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({upnp: cb.checked})
    });
    if (!r.ok) { _showToast(t('save_failed')); cb.checked = !cb.checked; return; }
    // A fresh mapping attempt makes the toggle feel real
    if (cb.checked) manageFetch('/manage/nat-recheck', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}' }).then(function() { _renderMirrorSection(); }).catch(function() {});
  } catch (e) { _showToast(t('save_failed')); cb.checked = !cb.checked; }
}

function _mirrorProgressText(prog) {
  return tH(prog.phase === 'seeding' ? 'mirror_progress_seeding' : 'mirror_progress_archiving',
    {a: prog.done, b: prog.total});
}

// Poll updates ONLY the progress line's text — a full section re-render
// every 3s made the page jump ("bouncing") on phones.
function _scheduleMirrorProgressPoll() {
  if (window._mirrorProgTimer) clearTimeout(window._mirrorProgTimer);
  window._mirrorProgTimer = setTimeout(async function() {
    if (mode !== 'manage') return;
    var el = document.getElementById('mirror-progress-line');
    if (!el) return;
    try {
      const r = await authedFetch('/manage/mirror');
      // A single transient failure (429 under load, a blip) used to kill the
      // poll loop for good, freezing the progress line mid-count while the sync
      // ran on underneath (#30's sibling). Keep polling and preserve the
      // last-known line instead; only stop when a *successful* poll says the
      // sync has finished (no phase).
      if (!r.ok) { _scheduleMirrorProgressPoll(); return; }
      const m = await r.json();
      const prog = m.progress || {};
      if (prog.phase) {
        el.style.display = '';
        el.innerHTML = _mirrorProgressText(prog);
        _scheduleMirrorProgressPoll();
      } else {
        el.style.display = 'none';
      }
    } catch (e) {
      _scheduleMirrorProgressPoll();
    }
  }, 3000);
}

// First-ever paint of the Server pane, before any cached rows exist: the
// full three-card structure with static copy and off toggles, so the
// section is never a blank slab. Live states hydrate in via
// _renderMirrorSection a tick later (structure matches, so no bounce).
// Shown only on the first-ever visit, before the prefetch resolves and when
// no last-known rows are cached. A neutral skeleton — never the OFF-default
// switches, which read as "sharing is off" when the truth is simply unknown.
function _shareSkeletonHtml() {
  var row = '<div class="share-row-skeleton"><span class="sk-line sk-line-wide"></span><span class="sk-line sk-line-narrow"></span></div>';
  return '<div class="share-rows share-rows-skeleton" aria-busy="true">' + row + row + row + '</div>';
}

async function _renderMirrorSection() {
  if (_btSettingInFlight) return; // never repaint over an in-flight toggle
  let m, bt = null, peers = null;
  // Reuse the manage-entry prefetch when it's still warm; a re-render after a
  // user toggle finds no cache and fetches fresh (single-use), so a change is
  // never overwritten by stale prefetched data.
  const mirrorP = _msFetch('/manage/mirror', function() { return authedFetch('/manage/mirror').then(_msJson); });
  const btP = _msFetch('/manage/bt-status');
  const peersP = _msFetch('/manage/peers', function() { return authedFetch('/manage/peers').then(_msJson); });
  try {
    m = await mirrorP;
  } catch (e) {
    return;
  }
  try { bt = await btP; } catch (e) { bt = null; }
  try { peers = await peersP; } catch (e) { peers = null; }
  const el = document.getElementById('ms-mirror-status');
  if (!el) return;
  const btOn = !!m.torrent_enabled;
  // disabled= when BT off OR the field is env-locked; lock= marks env-locked
  // fields so an in-place toggle never re-enables them.
  const disA = (locked) => ((!btOn || locked) ? ' disabled' : '');
  const lockA = (locked) => (locked ? ' data-envlock="1"' : '');

  // The rows below form a strict two-column grid (label | control), aligned via
  // .share-bt-controls in app.css. Each .share-field carries exactly two
  // children — a <label> and one control group — so their columns line up.
  // Verbose guidance lives in the label's title= tooltip, not an inline note
  // that would wrap into a paragraph on a phone.
  const ratioRow = '<div class="share-field"><label title="' + escAttr(t('seed_ratio_zero_hint')) + '">' + tH('seed_ratio_label') + '</label>' +
    '<span class="share-port-group">' +
    '<input type="number" min="0" max="10" step="0.1" value="' + (m.seed_ratio_cap != null ? m.seed_ratio_cap : 2) + '"' +
    disA(m.seed_ratio_env_locked) + lockA(m.seed_ratio_env_locked) +
    ' class="share-num-input" aria-label="' + escAttr(t('seed_ratio_label')) + '" title="' + escAttr(t('seed_ratio_zero_hint')) + '" onchange="_setSeedRatio(this)">' +
    '<span class="share-field-note">×</span></span></div>';

  // Upload bandwidth cap (MB/s in the UI, 0 = unlimited). Mirror + seeding ride
  // this too. The DOWNLOAD cap lives in the Downloads card below (one global
  // number governs HTTP + BT) so it isn't rendered twice.
  const upMb = m.bt_up_kb ? +(m.bt_up_kb / 1024).toFixed(2) : 0;
  const limitRow = '<div class="share-field"><label title="' + escAttr(t('bt_limit_hint')) + '">' + tH('bt_up_limit_label') + '</label>' +
    '<span class="share-port-group">' +
    '<input type="number" min="0" step="0.5" value="' + upMb + '"' + disA(m.bt_up_env_locked) + lockA(m.bt_up_env_locked) +
    ' class="share-num-input" aria-label="' + escAttr(t('bt_limit_up')) + '" title="' + escAttr(t('bt_limit_hint')) + '" onchange="_setBtLimit(this,\'up\')">' +
    '<span class="share-field-note">↑ MB/s</span></span></div>';

  // Concurrent downloads: how many run at once, the rest queue. Governs HTTP
  // and BT alike, so it stays editable even with the BT engine off
  // (data-nogate) — only an env var locks it.
  const dlRow = '<div class="share-field"><label title="' + escAttr(t('bt_max_dl_hint')) + '">' + tH('bt_max_dl_label') + '</label>' +
    '<span class="share-port-group">' +
    '<input type="number" min="1" max="20" step="1" value="' + (m.max_active_downloads != null ? m.max_active_downloads : 4) + '"' +
    (m.max_active_downloads_env_locked ? ' disabled' : '') + lockA(m.max_active_downloads_env_locked) + ' data-nogate="1"' +
    ' class="share-num-input" aria-label="' + escAttr(t('bt_max_dl_label')) + '" title="' + escAttr(t('bt_max_dl_hint')) + '" onchange="_setBtMaxDl(this)">' +
    '</span></div>';

  // Max connections: libtorrent's global socket cap (real, enforced). Pure BT
  // engine setting, so it greys with the engine.
  const connRow = '<div class="share-field"><label title="' + escAttr(t('bt_max_conn_hint')) + '">' + tH('bt_max_conn_label') + '</label>' +
    '<span class="share-port-group">' +
    '<input type="number" min="10" max="2000" step="10" value="' + (m.bt_max_connections != null ? m.bt_max_connections : 200) + '"' +
    disA(m.bt_max_connections_env_locked) + lockA(m.bt_max_connections_env_locked) +
    ' class="share-num-input" aria-label="' + escAttr(t('bt_max_conn_label')) + '" title="' + escAttr(t('bt_max_conn_hint')) + '" onchange="_setBtMaxConn(this)">' +
    '</span></div>';

  const portRow = '<div class="share-field share-port-row" id="share-port-row">' + _portRowInner(bt || {}, btOn) + '</div>';

  const selfName = (peers && peers.self) || '';
  const nameRow = '<div class="share-field"><label title="' + escAttr(t('peer_name_hint')) + '">' + tH('peer_advertising_as') + '</label>' +
    '<input type="text" class="peer-name-input" value="' + escAttr(selfName) + '" maxlength="63"' +
    (m.peer_name_env_locked ? ' disabled' : '') + lockA(m.peer_name_env_locked) +
    ' title="' + escAttr(t('peer_name_hint')) + '" aria-label="' + escAttr(t('peer_advertising_as')) + '" onchange="_setPeerName(this)"></div>';

  // Controls always present; the wrapper dims + disables them when BT is off,
  // so toggling never adds/removes rows (no layout jump).
  const btControls = '<div class="share-bt-controls' + (btOn ? '' : ' share-controls-off') + '" id="ms-bt-controls">' +
    ratioRow + limitRow + dlRow + connRow + portRow + nameRow + '</div>';

  // Mirror status sits under its toggle in the right column — the SAME spot
  // as the BitTorrent "ready" dot — so both cards' status lights line up.
  // Green "active" when on, grey "off" when not; the toggle can't be on
  // without BT, so mirrorActive already folds that in.
  const mirrorActive = m.enabled && btOn;
  const mirrorStatus = '<div id="ms-mirror-active" class="share-bt-status-right">' +
    _mirrorStatusHtml(mirrorActive) + '</div>';
  const prog = m.progress || {};
  // "When is the backup updated?" — surface the offline catalog copy's last
  // write (refreshed on catalog revalidation and every 12h maintenance pass,
  // the same pass that refreshes mirror seeds + the .torrent archive).
  const backupTs = m.enabled && m.catalog_backup_ts
    ? '<div class="ms-hint">' + tH('mirror_backup_updated', {when: _relTime(m.catalog_backup_ts)}) + '</div>' : '';
  const mirrorInner = backupTs +
    '<div class="ms-hint share-mirror-progress" id="mirror-progress-line"' + (prog.phase ? '' : ' style="display:none"') + '>' +
      (prog.phase ? _mirrorProgressText(prog) : '') + '</div>';

  let h = '<div class="share-rows">' +
    _shareSwitch('torrent', btOn, m.torrent_env_locked, 'ZIMI_BT',
      'share_bt_title', tH('share_bt_desc') + btControls,
      false, '<div id="ms-bt-status" class="share-bt-status-right">' + (window._btStatusHtml || '') + '</div>') +
    _shareSwitch('mirror', m.enabled, m.env_locked, 'ZIMI_BT',
      'share_mirror_title', tH('share_mirror_desc') + mirrorInner, !btOn, mirrorStatus) +
    _shareSwitch('peer_share', m.peer_share, m.peer_share_env_locked, 'ZIMI_NEARBY',
      'share_nearby_title', tH('share_nearby_desc') +
        (m.peer_ip_unreachable ? '<div class="share-row-desc share-nearby-warn">⚠ ' + tH('nearby_bridge_warning') + '</div>' : '')) +
  '</div>';
  if (prog.phase) _scheduleMirrorProgressPoll();
  el.innerHTML = h;
  try { localStorage.setItem(SK.SHARE_ROWS, h); } catch (e) {}
  // Fill the status dot + port dot in place.
  _renderSeedingSection();
}


// ── Download scheduling card (nightly window + global download speed cap) ──
async function _renderDownloadSchedule() {
  var el = document.getElementById('ms-dl-schedule');
  if (!el) return;
  var s;
  try { s = await (await manageFetch('/manage/download-schedule')).json(); }
  catch (e) { el.textContent = t('error'); return; }
  window._dlSchedule = s;
  var enabled = !!s.enabled, locked = !!s.locked, speedLocked = !!s.download_kb_locked;

  var toggle = '<label class="ms-toggle-row"><input type="checkbox"' +
    (enabled ? ' checked' : '') + (locked ? ' disabled' : '') +
    ' onchange="_setDownloadScheduleEnabled(this.checked)"> ' + tH('dl_schedule_toggle') + '</label>';
  var lockNote = locked ? '<div class="ms-hint">' + tH('dl_window_env_locked') + '</div>' : '';

  // The window times drive BOTH download-queueing and the upload restrictor, so
  // show them whenever either is on (the download-status chip is downloads-only).
  var windowBlock = '';
  if (enabled || s.upload_restrict) {
    var chip = enabled ? '<span class="dl-window-chip ' + (s.in_window ? 'dl-window-in' : 'dl-window-out') + '">' +
      (s.in_window ? tH('dl_in_window') : tH('dl_waiting_window')) + '</span>' : '';
    windowBlock =
      '<div class="ms-dl-window">' +
        '<label>' + tH('dl_window_start') + ' <input type="time" id="ms-dl-start" value="' + escAttr(s.start) + '"' +
          (locked ? ' disabled' : '') + ' onchange="_setDownloadWindow()"></label>' +
        '<label>' + tH('dl_window_end') + ' <input type="time" id="ms-dl-end" value="' + escAttr(s.end) + '"' +
          (locked ? ' disabled' : '') + ' onchange="_setDownloadWindow()"></label>' +
        chip +
      '</div>' +
      (enabled ? '<div class="ms-hint">' + tH('dl_window_hint') + '</div>' : '');
  }

  // Compose as [label] [input] [unit] on one line, hint on its own muted line
  // below — the .share-field pattern the BitTorrent card uses (a plain .ms-field
  // would stretch the input full-width and shove the unit into the hint).
  var speedRow =
    '<div class="share-field ms-dl-speed"><label>' + tH('dl_speed_limit') + '</label>' +
    '<span class="share-port-group">' +
    '<input type="number" min="0" step="64" value="' + (s.download_kb || 0) + '" id="ms-dl-speed"' +
      (speedLocked ? ' disabled' : '') + ' class="share-num-input" aria-label="' + escAttr(t('dl_speed_limit')) +
      '" onchange="_setDownloadSpeed(this)">' +
    '<span class="share-field-note">' + tH('dl_speed_unit') + '</span></span></div>' +
    '<div class="ms-hint">' + tH('dl_speed_hint') + '</div>' +
    (speedLocked ? '<div class="ms-hint">' + tH('dl_speed_env_locked') + '</div>' : '');

  // Upload restrictor: trickle seeding outside the window (one row; the trickle
  // field + "throttling now" note only appear once it's on).
  var uploadRestrict = !!s.upload_restrict;
  var uploadRow =
    '<label class="ms-toggle-row"><input type="checkbox"' +
      (uploadRestrict ? ' checked' : '') + (locked ? ' disabled' : '') +
      ' onchange="_setUploadRestrict(this.checked)"> ' + tH('dl_upload_restrict') + '</label>' +
    (uploadRestrict ?
      '<div class="share-field ms-dl-trickle"><label>' + tH('dl_upload_trickle') + '</label>' +
        '<span class="share-port-group">' +
        '<input type="number" min="1" step="10" value="' + (s.upload_trickle_kb || 50) + '" id="ms-dl-trickle"' +
          (locked ? ' disabled' : '') + ' class="share-num-input" aria-label="' + escAttr(t('dl_upload_trickle')) +
          '" onchange="_setUploadTrickle(this)">' +
        '<span class="share-field-note">' + tH('dl_speed_unit') + '</span></span></div>' +
        '<div class="ms-hint">' + tH('dl_upload_trickle_hint') + '</div>' +
        (s.upload_throttled ? '<div class="ms-hint">' + tH('dl_upload_throttled_now') + '</div>' : '')
      : '');

  el.innerHTML = toggle + lockNote + windowBlock + speedRow + uploadRow;
}

async function _postDownloadSchedule(body) {
  try {
    await manageFetch('/manage/download-schedule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch (e) {}
  _renderDownloadSchedule();
}
function _setDownloadScheduleEnabled(on) { return _postDownloadSchedule({ enabled: !!on }); }
function _setDownloadWindow() {
  var st = document.getElementById('ms-dl-start'), en = document.getElementById('ms-dl-end');
  if (!st || !en) return;
  return _postDownloadSchedule({ enabled: true, start: st.value, end: en.value });
}
function _setDownloadSpeed(input) {
  return _postDownloadSchedule({ download_kb: Math.max(0, parseInt(input.value, 10) || 0) });
}
function _setUploadRestrict(on) { return _postDownloadSchedule({ upload_restrict: !!on }); }
function _setUploadTrickle(input) {
  return _postDownloadSchedule({ upload_trickle_kb: Math.max(1, parseInt(input.value, 10) || 50) });
}


// ── Backup & export hub ──────────────────────────────────────────────────
// The hub is TWO clearly separated cards, each with its own Export + Import:
//   • "My data"      — this browser's bookmarks, history and preferences. Always
//                      exportable/importable to a file; a signed-in NAMED user
//                      also gets Save-to / Restore-from their own server account
//                      (POST/GET /userdata). Admin-without-a-user stays file-only.
//   • "Server backup"— ADMIN-only, the full server bundle (/manage/backup
//                      scope=server): library list, collections, layout, users
//                      with hashes, access policy, schedule, sharing prefs, seed
//                      intents, hot list, auto-update, event history, per-user
//                      data. Preview-then-apply.
// Import validates the bundle's scope against the card it landed on (a server
// bundle rejected by the My-data card and vice-versa). Keep _PREF_KEYS and
// _BACKUP_SCHEMA_VERSION in lockstep with the server.
var _BACKUP_SCHEMA = 'zimi-backup';
var _BACKUP_SCHEMA_VERSION = 3;
var _PREF_KEYS = [
  SK.UI_LANG, SK.HIDE_DISCOVER, SK.HIDE_LANG_CHOOSER, SK.HIDE_XZIM_LINKS,
  SK.A11Y_REWRITE, SK.LIBRARY_VIEW, SK.PREF_LANGUAGES, SK.PREF_FLAVOR,
  SK.READER_FONT, SK.READER_FAMILY, SK.READER_THEME, SK.READER_AUTO,
];

function _collectPreferences() {
  var out = {};
  _PREF_KEYS.forEach(function(k) {
    try { var v = localStorage.getItem(k); if (v !== null) out[k] = v; } catch (e) {}
  });
  return out;
}

// The parsed SERVER bundle awaiting the admin's Apply confirmation. Nothing is
// written until _serverBackupApply() runs — server import is preview-then-apply.
var _pendingServerBackup = null;

function _setBackupStatus(id, key) {
  var el = document.getElementById(id);
  if (el) el.textContent = key ? t(key) : '';
}

function _cbChecked(id) {
  var cb = document.getElementById(id);
  return !!(cb && cb.checked);
}

// ── Card markup ──
// "My data" is the only card a signed-in non-admin sees (rendered standalone by
// _renderUserManage); the admin Server pane shows both via _backupHubHtml.
function _myDataCardHtml() {
  var signedIn = !!(_userSession && _userSession.name);
  var serverBtns = signedIn
    ? '<button class="pill" onclick="saveMyDataToServer()">' + tH('backup_save_server') + '</button>' +
      '<button class="pill" onclick="restoreMyDataFromServer()">' + tH('backup_restore_server') + '</button>'
    : '';
  // Signed-in named users get the account explanation (Save to server exists
  // for them); everyone else gets browser-local + file export only.
  var intro = signedIn ? tH('backup_mydata_intro_account') : tH('backup_mydata_intro');
  return '<div class="ms-section-label">' + tH('backup_mydata_title') + '</div>' +
    '<div class="ms-hint">' + intro + '</div>' +
    '<div class="ms-backup-actions">' +
      '<button class="pill" onclick="exportMyData()">' + tH('backup_export_file') + '</button>' +
      '<button class="pill" onclick="document.getElementById(\'ms-mydata-file\').click()">' + tH('backup_import_file') + '</button>' +
      serverBtns +
      '<input type="file" id="ms-mydata-file" accept="application/json,.json" style="display:none" onchange="importMyDataFile(this)">' +
      '<span id="ms-mydata-status" class="ms-hint" style="margin:0;align-self:center"></span>' +
    '</div>' +
    '<label class="ms-toggle-row"><input type="checkbox" id="ms-mydata-overwrite"> ' + tH('backup_overwrite') + '</label>' +
    '<div id="ms-mydata-result" class="ms-backup-import"></div>';
}

function _serverBackupCardHtml() {
  return '<div class="ms-section-label" style="margin-top:22px">' + tH('backup_server_title') + '</div>' +
    '<div class="ms-hint">' + tH('backup_server_intro') + '</div>' +
    '<div class="ms-backup-actions">' +
      '<button class="pill" onclick="exportServerBackup()">' + tH('backup_export_file') + '</button>' +
      '<button class="pill" onclick="document.getElementById(\'ms-server-file\').click()">' + tH('backup_import_file') + '</button>' +
      '<input type="file" id="ms-server-file" accept="application/json,.json" style="display:none" onchange="importServerBackupFile(this)">' +
      '<span id="ms-server-status" class="ms-hint" style="margin:0;align-self:center"></span>' +
    '</div>' +
    '<label class="ms-toggle-row"><input type="checkbox" id="ms-server-overwrite"> ' + tH('backup_overwrite') + '</label>' +
    '<div id="ms-server-import" class="ms-backup-import"></div>';
}

function _backupHubHtml() {
  return _myDataCardHtml() + _serverBackupCardHtml();
}

function _downloadJson(filename, obj) {
  var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

// Bookmarks/history live in localStorage; the server never sees them (a signed-in
// user's copy rides in their own /userdata blob). Identity is zim+path, newest
// (by timestamp) wins on conflict — mirrors the server's merge rules.
function _bookmarkKey(b) {
  return (b && b.zim ? b.zim : '') + '\n' + (b && b.path ? b.path : '');
}

function _mergeByKey(current, incoming, keyFn, overwrite) {
  if (overwrite) return { list: incoming.slice(), added: incoming.length, dupes: 0 };
  var out = current.slice(), idx = {}, added = 0, dupes = 0;
  out.forEach(function(x, i) { idx[keyFn(x)] = i; });
  incoming.forEach(function(x) {
    var k = keyFn(x);
    if (k in idx) {
      dupes++;
      if ((x.timestamp || 0) >= (out[idx[k]].timestamp || 0)) out[idx[k]] = x;
    } else { idx[k] = out.length; out.push(x); added++; }
  });
  return { list: out, added: added, dupes: dupes };
}

// ── My data (browser half) — the one payload the My-data card moves, whether to
// a file, from a file, or to/from the signed-in user's server account. ──
function _collectBrowserData() {
  return {
    bookmarks: _getStorageJSON(SK.BOOKMARKS, []),
    folders: _getStorageJSON(SK.BM_FOLDERS, []),
    history: _getStorageJSON(SK.BROWSE_HISTORY, []),
    preferences: _collectPreferences(),
  };
}

// Folders merge by id (not zim+path). Newer (higher order/updated wins isn't
// meaningful for folders, so incoming simply overrides an existing id) — this
// keeps a restored/synced tree consistent with the bookmarks that reference it.
function _folderKey(f) { return (f && f.id) ? String(f.id) : ''; }

function _applyBrowserData(data, overwrite) {
  var res = { bm: { added: 0, dupes: 0 } };
  if (data && data.preferences && typeof data.preferences === 'object') {
    Object.keys(data.preferences).forEach(function(k) {
      if (_PREF_KEYS.indexOf(k) === -1) return;  // ignore unknown/foreign keys
      try { localStorage.setItem(k, data.preferences[k]); } catch (e) {}
    });
  }
  if (data && Array.isArray(data.bookmarks)) {
    res.bm = _mergeByKey(_getStorageJSON(SK.BOOKMARKS, []), data.bookmarks, _bookmarkKey, overwrite);
    _setStorageJSON(SK.BOOKMARKS, res.bm.list);
    if (typeof _bookmarks !== 'undefined') _bookmarks = null;  // drop the in-memory cache
  }
  if (data && Array.isArray(data.folders)) {
    var fm = _mergeByKey(_getStorageJSON(SK.BM_FOLDERS, []), data.folders, _folderKey, overwrite);
    _setStorageJSON(SK.BM_FOLDERS, fm.list);
    if (typeof _bmFolders !== 'undefined') _bmFolders = null;  // drop the in-memory cache
  }
  if (data && Array.isArray(data.history)) {
    _setStorageJSON(SK.BROWSE_HISTORY, _mergeByKey(_getStorageJSON(SK.BROWSE_HISTORY, []), data.history, _bookmarkKey, overwrite).list);
  }
  return res;
}

function _showMyDataResult(res) {
  var box = document.getElementById('ms-mydata-result');
  if (box) box.innerHTML = '<div class="ms-backup-pv-line">' +
    tH('backup_pv_bookmarks', { added: res.bm.added, dupes: res.bm.dupes }) + '</div>';
}

function exportMyData() {
  var bundle = Object.assign({
    schema: _BACKUP_SCHEMA,
    schema_version: _BACKUP_SCHEMA_VERSION,
    scope: 'my-data',
    created: new Date().toISOString(),
  }, _collectBrowserData());
  _downloadJson('zimi-my-data-' + new Date().toISOString().slice(0, 10) + '.json', bundle);
  _setBackupStatus('ms-mydata-status', 'backup_mydata_exported');
}

function importMyDataFile(input) {
  var f = input.files && input.files[0];
  if (!f) return;
  var reader = new FileReader();
  reader.onload = function() { _applyMyDataFile(reader.result); input.value = ''; };
  reader.onerror = function() { _setBackupStatus('ms-mydata-status', 'backup_bad_file'); input.value = ''; };
  reader.readAsText(f);
}

function _applyMyDataFile(text) {
  var bundle;
  try { bundle = JSON.parse(text); } catch (e) { bundle = null; }
  if (!bundle || bundle.schema !== _BACKUP_SCHEMA) {
    _setBackupStatus('ms-mydata-status', 'backup_bad_file');
    return;
  }
  // Scope-vs-card guard: a server bundle belongs on the Server backup card.
  if (bundle.scope === 'server') {
    _setBackupStatus('ms-mydata-status', 'backup_wrong_card_server');
    return;
  }
  var res = _applyBrowserData(bundle, _cbChecked('ms-mydata-overwrite'));
  _setBackupStatus('ms-mydata-status', 'backup_mydata_imported');
  _showMyDataResult(res);
}

async function saveMyDataToServer() {
  _setBackupStatus('ms-mydata-status', 'working');
  try {
    var res = await fetch('/userdata', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_collectBrowserData()),
    });
    if (!res.ok) throw new Error('http ' + res.status);
    _setBackupStatus('ms-mydata-status', 'backup_saved_server');
  } catch (e) { _setBackupStatus('ms-mydata-status', 'error'); }
}

async function restoreMyDataFromServer() {
  _setBackupStatus('ms-mydata-status', 'working');
  var data;
  try {
    var res = await fetch('/userdata', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('http ' + res.status);
    data = await res.json();
  } catch (e) { _setBackupStatus('ms-mydata-status', 'error'); return; }
  var res2 = _applyBrowserData(data || {}, _cbChecked('ms-mydata-overwrite'));
  _setBackupStatus('ms-mydata-status', 'backup_restored_server');
  _showMyDataResult(res2);
}

// ── Server backup (admin) — full bundle, preview-then-apply ──
async function exportServerBackup() {
  _setBackupStatus('ms-server-status', 'working');
  var bundle;
  try {
    var res = await manageFetch('/manage/backup?scope=server');
    if (!res.ok) throw new Error('http ' + res.status);
    bundle = await res.json();
  } catch (e) { _setBackupStatus('ms-server-status', 'error'); return; }
  _downloadJson('zimi-server-backup-' + new Date().toISOString().slice(0, 10) + '.json', bundle);
  _setBackupStatus('ms-server-status', 'backup_exported');
}

function importServerBackupFile(input) {
  var f = input.files && input.files[0];
  if (!f) return;
  var reader = new FileReader();
  reader.onload = function() { _previewServerBackup(reader.result); input.value = ''; };
  reader.onerror = function() { _setBackupStatus('ms-server-status', 'backup_bad_file'); input.value = ''; };
  reader.readAsText(f);
}

// Step 1 of 2: compute the diff and show it. Applies NOTHING.
async function _previewServerBackup(text) {
  var bundle;
  try { bundle = JSON.parse(text); } catch (e) { bundle = null; }
  if (!bundle || bundle.schema !== _BACKUP_SCHEMA) {
    _setBackupStatus('ms-server-status', 'backup_bad_file');
    return;
  }
  // Scope-vs-card guard: a My-data bundle belongs on the My data card.
  if (bundle.scope !== 'server') {
    _setBackupStatus('ms-server-status', 'backup_wrong_card_mydata');
    return;
  }
  _pendingServerBackup = bundle;
  _setBackupStatus('ms-server-status', 'working');
  var overwrite = _cbChecked('ms-server-overwrite');
  var srv = {};
  try {
    var res = await manageFetch('/manage/backup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, bundle, { action: 'preview', overwrite: overwrite })),
    });
    var d = await res.json().catch(function() { return {}; });
    if (!res.ok) { _setBackupStatus('ms-server-status', 'error'); return; }
    srv = d.preview || {};
  } catch (e) { _setBackupStatus('ms-server-status', 'error'); return; }
  _setBackupStatus('ms-server-status', '');
  _renderServerBackupPreview(srv);
}

function _renderServerBackupPreview(srv) {
  var box = document.getElementById('ms-server-import');
  if (!box) return;
  var lines = [];
  if (srv.collections) {
    lines.push(tH('backup_pv_collections', { added: srv.collections.col_added, replaced: srv.collections.col_replaced }));
    lines.push(tH('backup_pv_favorites', { added: srv.collections.fav_added, dupes: srv.collections.fav_dupes }));
  }
  if (srv.layout && (srv.layout.over_added || srv.layout.over_changed)) {
    lines.push(tH('backup_pv_overrides', { added: srv.layout.over_added, changed: srv.layout.over_changed }));
  }
  if (srv.users) lines.push(tH('backup_pv_users', { added: srv.users.added, replaced: srv.users.replaced }));
  if (srv.user_data) lines.push(tH('backup_pv_userdata', { n: srv.user_data.users }));
  if (srv.history) lines.push(tH('backup_pv_history', { n: srv.history.events }));
  if (srv.settings && srv.settings.length) lines.push(tH('backup_pv_settings', { n: srv.settings.length }));
  if (srv.missing_zims) lines.push(tH('backup_pv_missing', { n: srv.missing_zims }));
  box.innerHTML =
    '<div class="ms-backup-preview">' +
      '<div class="ms-hint">' + tH('backup_preview_title') + '</div>' +
      lines.map(function(l) { return '<div class="ms-backup-pv-line">' + l + '</div>'; }).join('') +
      '<div class="ms-backup-actions">' +
        '<button class="pill" onclick="_serverBackupApply()">' + tH('backup_apply') + '</button>' +
        '<button class="pill" onclick="_serverBackupCancel()">' + tH('backup_cancel') + '</button>' +
      '</div>' +
    '</div>';
}

function _serverBackupCancel() {
  _pendingServerBackup = null;
  var box = document.getElementById('ms-server-import');
  if (box) box.innerHTML = '';
  _setBackupStatus('ms-server-status', 'backup_cancelled');
}

// Step 2 of 2: the admin confirmed — write the server bundle.
async function _serverBackupApply() {
  var bundle = _pendingServerBackup;
  if (!bundle) return;
  var overwrite = _cbChecked('ms-server-overwrite');
  _setBackupStatus('ms-server-status', 'working');
  try {
    await manageFetch('/manage/backup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, bundle, { action: 'apply', overwrite: overwrite })),
    });
  } catch (e) {}
  _setBackupStatus('ms-server-status', 'backup_imported');
  _pendingServerBackup = null;
  // Library: offer to re-seed any ZIMs the backup lists but we don't have.
  _renderMissingZims(bundle.library || []);
}

async function _renderMissingZims(library) {
  var box = document.getElementById('ms-server-import');
  if (!box) return;
  box.innerHTML = '';
  if (!Array.isArray(library) || !library.length) return;
  // Which backup ZIMs aren't installed here? An unreachable server would leave
  // this set empty and declare every ZIM in the backup missing — a fabricated
  // shopping list. Bail with an honest note instead.
  var installed = new Set();
  try {
    var list = await (await serverFetch('/list')).json();
    (Array.isArray(list) ? list : (list.zims || [])).forEach(function(z) { if (z && z.name) installed.add(z.name); });
  } catch (e) {
    box.innerHTML = '<div class="ms-hint">' + tH('conn_offline_msg') + '</div>';
    return;
  }
  var missing = library.filter(function(z) { return z && z.name && !installed.has(z.name); });
  if (!missing.length) {
    box.innerHTML = '<div class="ms-hint">' + tH('backup_library_complete') + '</div>';
    return;
  }
  // Resolve download URLs from the catalog by ZIM name.
  try { await loadFullCatalog(); } catch (e) {}
  var urls = [], unresolved = 0;
  missing.forEach(function(z) {
    var url = _catalogItemUrl(_catalogItemForZim(z.name));
    if (url) urls.push(url); else unresolved++;
  });
  var note = unresolved ? '<div class="ms-hint">' + tH('backup_missing_unresolved', { n: unresolved }) + '</div>' : '';
  if (!urls.length) { box.innerHTML = '<div class="ms-hint">' + tH('backup_missing_none') + '</div>' + note; return; }
  box.innerHTML =
    '<div class="ms-hint">' + tH('backup_missing_found', { n: urls.length }) + '</div>' +
    '<button class="pill" id="ms-backup-dl-btn" onclick=\'_downloadMissingZims(' + JSON.stringify(urls) + ')\'>' +
      tH('backup_download_missing', { n: urls.length }) + '</button>' + note;
}

async function _downloadMissingZims(urls) {
  var btn = document.getElementById('ms-backup-dl-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('starting'); }
  try {
    // Reuse the batch download machinery — it honors the download schedule, so
    // a nightly window parks these as "scheduled" automatically.
    var r = await manageFetch('/manage/download-batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: urls }),
    });
    var d = await r.json();
    if (btn) btn.textContent = t('backup_queued', { n: d.started || 0 });
    _dlPrevAllDone = false;
    refreshDownloads();
    if (window._nudgeActivityPoll) window._nudgeActivityPoll();
  } catch (e) { if (btn) { btn.textContent = t('error'); btn.disabled = false; } }
}


async function _cacheAction(btn, action) {
  const status = document.getElementById('ms-cache-status');
  btn.disabled = true;
  if (status) status.textContent = t('working');
  try {
    const res = await manageFetch('/manage/cache-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'failed');
    if (status) status.textContent = data.status === 'started' ? t('rebuild_started') : t('cleared');
    // Rebuild kicks off background work — nudge the activity poller so
    // the topbar bar surfaces within ~250ms instead of waiting up to 30s
    // for the next idle-cadence poll.
    if (window._nudgeActivityPoll) window._nudgeActivityPoll();
  } catch (e) {
    if (status) status.textContent = t('error');
  } finally {
    btn.disabled = false;
  }
}


async function _saveHotZims(btn) {
  const checks = document.querySelectorAll('#ms-hot-zims input[type="checkbox"]:checked');
  const names = Array.from(checks).map(c => c.value);
  const status = document.getElementById('ms-hot-status');
  btn.disabled = true;
  if (status) status.textContent = t('saving');
  try {
    const res = await manageFetch('/manage/hot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hot_zims: names }),
    });
    if (!res.ok) throw new Error('save failed');
    if (status) status.textContent = t('saved') + ' · ' + t('restart_hint');
  } catch (e) {
    if (status) status.textContent = t('error');
  } finally {
    btn.disabled = false;
  }
}


async function toggleAutoUpdate() {
  const freqSel = document.getElementById('auto-update-freq');
  if (!freqSel) return;
  const val = freqSel.value;
  const enabled = val !== 'disabled';
  try {
    await manageFetch('/manage/auto-update', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({enabled: enabled, frequency: enabled ? val : 'weekly'})
    });
  } catch(e) { /* ignore */ }
  // The summary line carries the auto-update timer glyph, so it restates
  // itself when the frequency changes. Through the single writer rather than
  // the hand-patch that used to live here: that copy rebuilt the row without
  // its caret or its click handler, so changing the frequency while updates
  // were pending silently made the "3 updates available" row unopenable.
  _renderUpdatesSummary();
  // Last run and next run both move when the schedule does.
  _renderAutoUpdateSection();
  // Start fast polling when enabling — server starts downloads after 30s delay
  if (enabled && !_dlTimer) {
    _dlTimer = setTimeout(refreshDownloads, 3000);
  }
}

// Layers glyph marking a collection pill in the installed reorder row, so it
// reads as a grouping (not a category) at a glance.
var _COLLECTION_GLYPH = '<svg class="col-pill-glyph" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>';

function getInstalledPillsHtml() {
  const zims = zimsCache || [];
  // Build cross-reference: which cats exist per lang, which langs exist per cat
  const catsByLang = {};  // lang → Set of cats
  const langsByCat = {};  // cat → Set of langs
  const langCounts = {};  // lang → count
  for (const z of zims) {
    const cat = z.category || categorizeZim(z.name);
    const langs = _parseLangs(z.language);
    for (const lang of langs) {
      if (!catsByLang[lang]) catsByLang[lang] = new Set();
      catsByLang[lang].add(cat);
      if (!langsByCat[cat]) langsByCat[cat] = new Set();
      langsByCat[cat].add(lang);
      langCounts[lang] = (langCounts[lang] || 0) + 1;
    }
  }
  // Sections are read in the saved home order so the filter pills match what
  // home renders. `allCats` is still computed above purely to gate the language
  // row below.
  const allCats = _orderCatsBySaved([...new Set(Object.keys(langsByCat))]);
  const sections = _currentReorderSections();
  let h = '';
  // These pills FILTER the installed library: one row, one job. Collections
  // live in their own tab and reordering lives in Library settings, so neither
  // gets a look-alike pill here that navigates away instead of filtering.
  // Count only what actually renders: a lone category pill filters nothing, so
  // the row stays hidden until there are at least two categories to choose from.
  const catSections = sections.filter(function(s) { return s.key.indexOf('col:') !== 0; });
  if (catSections.length > 1) {
    h += '<div class="pills installed-cat-pills" style="margin-bottom:8px">';
    for (const s of catSections) {
      // The Other catch-all rides the reserved 'other' key (not a cat: slice).
      const cat = s.key === OTHER_KEY ? OTHER_CAT : s.key.slice(4);
      const dimmed = manageLangFilter && langsByCat[cat] && !langsByCat[cat].has(manageLangFilter);
      h += '<button class="pill cat-pill' + (manageCategoryFilter === cat ? ' active' : '') + (dimmed ? ' dimmed' : '') +
        '" data-key="' + escAttr(s.key) + '" data-cat="' + escAttr(cat) +
        '" onclick="filterManageCategory(\'' + escAttr(cat) + '\')">' + esc(_catDisplayName(cat)) + '</button>';
    }
    h += '</div>';
  }
  // Language pills — horizontal scroll with counts, no search button
  var langKeys = Object.keys(langCounts).filter(_isValidLangCode).sort(function(a, b) { return (langCounts[b] || 0) - (langCounts[a] || 0); });
  if (langKeys.length > 1 && !_getStorageFlag(SK.HIDE_LANG_CHOOSER) && allCats.length > 1) {
    h += '<div class="pills-divider"></div>';
  }
  if (langKeys.length > 1 && !_getStorageFlag(SK.HIDE_LANG_CHOOSER)) {
    var validLangs = manageCategoryFilter ? new Set(langsByCat[manageCategoryFilter] || []) : null;
    h += '<div class="catalog-lang-row" oncontextmenu="_langChooserCtxMenu(event)" style="justify-content:center">';
    h += '<div class="catalog-lang-scroll">';
    for (var li = 0; li < langKeys.length; li++) {
      var lc = langKeys[li];
      var lname = _langDisplayName(lc) || lc;
      var active = manageLangFilter === lc;
      var dimmed = validLangs && !validLangs.has(lc);
      var count = langCounts[lc] || 0;
      h += '<button class="pill' + (active ? ' active' : '') + (dimmed ? ' dimmed' : '') +
        '" onclick="filterManageLang(\'' + escAttr(lc) + '\')">' +
        esc(lname) + ' <span style="opacity:0.5;font-size:10px">' + count + '</span></button>';
    }
    h += '</div></div>';
  }
  return h;
}

function filterManageCategory(cat) {
  manageCategoryFilter = (manageCategoryFilter === cat) ? null : cat;
  renderInstalled();
}

function filterManageLang(lang) {
  manageLangFilter = (manageLangFilter === lang) ? null : lang;
  renderInstalled();
}

// ── Installed tab: render ZIMs grouped by category ──
// Shared library-style ZIM card (icon + title + meta + actions). Used by the
// Installed list AND the collection picker so a ZIM looks identical wherever
// it appears — one layout, no fork. Callers supply the meta string and the
// trailing actions; opts.selected marks it (collection membership).
// opts: { metaHtml, actionsHtml, onclick, extraClass, selected }
function _zimCardHtml(z, opts) {
  opts = opts || {};
  const iconHtml = z.has_icon
    ? '<img src="/w/' + encodeURIComponent(z.name) + '/-/icon" alt="" width="40" height="40" loading="lazy">'
    : '<span class="ci-letter">' + (esc(z.title || z.name)[0] || '?').toUpperCase() + '</span>';
  const langTag = (z.language && z.language !== 'en')
    ? '<span class="ci-lang-tag">' + esc(_langDisplayName(z.language)) + '</span>' : '';
  const cls = 'catalog-item' + (opts.extraClass ? ' ' + opts.extraClass : '') + (opts.selected ? ' ci-selected' : '');
  // opts.dragZim makes the row a drag source for the Installed-list section DnD
  // (#37): data-zim names the ZIM; draggable is pointer-only (touch uses the
  // long-press menu), so it never fights list scroll on mobile.
  const dragAttr = opts.dragZim ? ' draggable="true" data-zim="' + escAttr(opts.dragZim) + '"' : '';
  return '<div class="' + cls + '"' + dragAttr +
      (opts.onclick ? ' style="cursor:pointer" onclick="' + opts.onclick + '"' : '') + '>' +
    '<div class="ci-icon">' + iconHtml + '</div>' +
    '<div class="ci-info">' +
      '<div class="ci-title">' + esc(z.title || z.name) + langTag + '</div>' +
      '<div class="ci-meta">' + (opts.metaHtml || '') + '</div>' +
    '</div>' +
    '<div class="ci-actions">' + (opts.actionsHtml || '') + '</div>' +
  '</div>';
}

function renderInstalled(filterText) {
  const el = document.getElementById('manage-installed');
  if (!el) return;
  const zims = zimsCache || [];
  // Same rule as home: only claim "nothing installed" when the server said so.
  if (!_libraryKnown) { el.innerHTML = _libraryUnavailableHtml(); return; }
  if (!zims.length) {
    el.innerHTML = '<div class="empty"><p>' + tH('no_zims_installed') + '</p><div class="hint">' + tH('switch_to_catalog') + '</div></div>';
    return;
  }

  // Group by category. ZIMs with pending updates are pulled into a separate
  // "Updates available" pseudo-group rendered first so they're easy to spot.
  const groups = {};
  const pendingUpdates = [];
  for (const z of zims) {
    const cat = _zimCat(z);  // real category or OTHER_CAT — matches the home grouping
    if (manageCategoryFilter && cat !== manageCategoryFilter) continue;
    if (manageLangFilter && !_zimMatchesLang(z, manageLangFilter)) continue;
    if (filterText) {
      const ft = filterText.toLowerCase();
      const title = (z.title || z.name).toLowerCase();
      const catLower = cat.toLowerCase();
      if (!title.includes(ft) && !catLower.includes(ft) && !z.name.toLowerCase().includes(ft)) continue;
    }
    if (_availableUpdates[z.file]) {
      pendingUpdates.push(z);
      continue;
    }
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(z);
  }

  // No small-category merging here: home and the filter pills both show
  // real categories, so a lone WikEM must read "Medical & Health (1)" in
  // all three places — collapsing it to "Other" contradicted them.
  // Order groups by the saved section order (one source of truth), so the
  // Installed list matches the home page and the filter pills instead of falling
  // back to A-Z after a reorder.
  const catOrder = _orderCatsBySaved(Object.keys(groups));
  // Render pending-updates pseudo-group first.
  if (pendingUpdates.length) {
    catOrder.unshift('__updates__');
    groups['__updates__'] = pendingUpdates;
  }
  let items_h = '';
  for (const cat of catOrder) {
    const items = groups[cat];
    if (!items || !items.length) continue;
    items.sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
    items_h += '<div class="manage-installed-group' + (cat === '__updates__' ? ' mig-updates' : '') + '">';
    const groupLabel = cat === '__updates__' ? t('updates_available_section') : _catDisplayName(cat);
    // Real-category headers are drop targets for the row DnD (#37) — data-cat
    // names the destination; the Updates pseudo-group is never a target.
    const dropAttr = cat === '__updates__' ? '' : ' data-cat="' + escAttr(cat) + '"';
    items_h += '<div class="ci-section-label"' + dropAttr + '>' + esc(groupLabel) + ' (' + items.length + ')</div>';
    for (const z of items) {
      const meta = [];
      const countHtml = _zimCountHtml(z);
      if (countHtml) meta.push(countHtml);
      meta.push(fmtSize(z.size_gb));
      // Show date from ZIM metadata. Bookmark exports keep the full creation
      // date (their whole identity is "what I saved, when"); catalog ZIMs
      // stay on the YYYY-MM release stamp.
      const dateStr = z.date ? (_isZimiExport(z) ? z.date : z.date.substring(0, 7)) : null;
      if (dateStr) meta.push(dateStr);
      // Flavor badge from filename. When catalog variants exist, the current
      // variant's label is group-aware — an installed unsuffixed build shows
      // "Full + video" next to a maxi sibling instead of a second "Full" (#50).
      const variants = getFlavorVariants(z);
      const _curVariant = variants.find(v => v.current);
      const flavor = _curVariant ? _curVariant.label : variantLabel(z.file);
      // Show flavor as clickable pill if alternatives exist, otherwise just text
      if (variants.length > 1) {
        const vid = '_fv_' + z.name;
        window[vid] = variants;
        meta.push('<span class="flavor-pill" onclick="event.stopPropagation();showFlavorPicker(this, \'' + escAttr(z.name) + '\', window[\'' + vid + '\'])">' +
          esc(flavor || t('full')) +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>' +
        '</span>');
      } else if (flavor) {
        // Only show non-default flavors (Mini, No images) for single-variant ZIMs
        meta.push('<span style="color:var(--text2);font-weight:500">' + esc(flavor) + '</span>');
      }
      const upd = _availableUpdates[z.file];
      let actionsHtml = '';
      if (upd) {
        actionsHtml = '<button class="ci-update-btn" onclick="downloadZim(\'' + escAttr(upd.download_url) + '\', this, true)" title="' + escAttr(t('from_to_update', {from: dateStr || '?', to: upd.latest_date})) + '">' +
          tH('update') + '</button>' +
          '<button class="ci-delete-btn" onclick="deleteZim(\'' + escAttr(z.file) + '\', this)" title="' + escAttr(t('delete_zim')) + '">\u00D7</button>';
      } else {
        actionsHtml = '<span class="ci-installed-badge">' + tH('installed_badge') + '</span>' +
          '<button class="ci-delete-btn" onclick="deleteZim(\'' + escAttr(z.file) + '\', this)" title="' + escAttr(t('delete_zim')) + '">\u00D7</button>';
      }
      // No inline download pill: the raw .zim lives on the row's \u22ef menu
      // (Download ZIM file), which the peer-share gate still governs.
      // Same Move to\u2026 gear the catalog rows carry \u2014 the Installed tab is where
      // a user organizes their library, so it needs the entry point too. data-zim
      // + delegated handler, one submenu impl, no user strings in inline onclick.
      const gearHtml = manageEnabled
        ? '<button class="ci-gear" data-zim="' + escAttr(z.name) + '" onclick="event.stopPropagation();_ciGearClick(this)" title="' + escAttr(t('organize')) + '" aria-label="' + escAttr(t('organize')) + '">\u22ef</button>'
        : '';
      items_h += _zimCardHtml(z, {
        extraClass: upd ? 'ci-has-update' : '',
        onclick: 'if(!event.target.closest(\'button\')&&!event.target.closest(\'.flavor-pill\')){enterSource(\'' + escJs(z.name) + '\',true)}',
        metaHtml: meta.map(function(m){return '<span>'+m+'</span>'}).join(' &middot; '),
        actionsHtml: gearHtml + actionsHtml,
        dragZim: manageEnabled ? z.name : null,
      });
    }
    items_h += '</div>';
  }
  if (!items_h) items_h = '<div class="empty"><p>' + tH('no_matching_zims') + '</p></div>';

  el.innerHTML = getInstalledPillsHtml() + items_h;
  // Provenance kinds feed the Created bucket (see _zimCat); a deep link that
  // lands on Manage without ever painting home still needs them. No-op once
  // the map has arrived.
  _loadZimKinds();
  // Pointer DnD: drag a row onto a section header to move that ZIM there (#37).
  // Assigned per render (idempotent) since innerHTML above replaced the children.
  el.ondragstart = _installedDragStart;
  el.ondragover = _installedDragOver;
  el.ondragleave = _installedDragLeave;
  el.ondrop = _installedDrop;
  el.ondragend = _installedDragEnd;
  // (installed download pills removed \u2014 \u22ef menu carries it)
}

// ── Installed-list drag-to-move (#37) ──
// Drag a ZIM row onto a category section header to reassign it — the dense,
// touch-safe surface (mobile organizes via the long-press menu, not DnD). The
// dragged ZIM rides in a module var (dataTransfer text is a fallback for the
// browser's own bookkeeping). Headers light up via .drop-target while hovered.
var _instDragZim = null;
var _instDropTarget = null;
function _installedDragStart(e) {
  var row = e.target.closest('.catalog-item[data-zim]');
  if (!row) return;
  _instDragZim = row.dataset.zim;
  row.classList.add('ci-dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', _instDragZim); } catch (_) {}
}
function _installedDragOver(e) {
  if (!_instDragZim) return;
  var hdr = e.target.closest('.ci-section-label[data-cat]');
  if (!hdr) { _installedClearDrop(); return; }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (_instDropTarget !== hdr) {
    _installedClearDrop();
    _instDropTarget = hdr; hdr.classList.add('drop-target');
  }
}
function _installedDragLeave(e) {
  if (_instDropTarget && !_instDropTarget.contains(e.relatedTarget)) _installedClearDrop();
}
function _installedClearDrop() {
  if (_instDropTarget) { _instDropTarget.classList.remove('drop-target'); _instDropTarget = null; }
}
function _installedDrop(e) {
  var hdr = e.target.closest('.ci-section-label[data-cat]');
  if (!hdr || !_instDragZim) { _installedClearDrop(); return; }
  e.preventDefault();
  var cat = hdr.dataset.cat;
  var zim = _instDragZim;
  _installedClearDrop();
  // No-op if it's already in that bucket, so a stray drop doesn't toast "Saved".
  var cur = _zimInfo(zim);
  if (cur && _zimCat(cur) !== cat) _moveZimTo(zim, cat);
}
function _installedDragEnd() {
  _instDragZim = null;
  _installedClearDrop();
  var d = document.querySelector('.catalog-item.ci-dragging');
  if (d) d.classList.remove('ci-dragging');
}

async function managePassword() {
  const has = await manageFetch('/manage/has-password').then(r => r.json()).catch(() => ({}));
  if (has.env_controlled) {
    _showToast(t('env_controlled', {v: 'ZIMI_MANAGE_PASSWORD'}));
    return;
  }
  const errEl = document.getElementById('pw-error');
  const overlay = document.getElementById('pw-overlay');

  openPwModal(has.has_password ? t('change_password') : t('set_password'), {placeholder: t('new_password'), hideRemember: true});
  document.getElementById('pw-remove-btn').style.display = has.has_password ? '' : 'none';

  _pwResolve = async function(newPw) {
    // submitPw set _manageUser from the (now visible) username field; store it
    // alongside the new password so future logins must present it.
    const body = {password: newPw, username: _manageUser || 'admin'};
    if (has.has_password && _manageToken) body.current = _manageToken;
    const res = await manageFetch('/manage/set-password', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      errEl.textContent = d.error || t('error');
      errEl.style.display = 'block';
      overlay.classList.add('open');
      return;
    }
    // After setting/changing the password, keep the session authenticated AND
    // preserve the user's "Remember me" choice: if the old token was persisted
    // (localStorage), re-persist the new one so a password change doesn't
    // silently log them out next visit. Previously this always cleared storage,
    // which defeated Remember me for anyone who ever changed their password.
    const wasRemembered = !!localStorage.getItem(SK.MANAGE_PW);
    _manageToken = newPw || '';
    if (newPw) _saveManageToken(newPw, wasRemembered);
    else _clearManageToken();
    closePwModal();
    renderManage();
  };
}

function _confirmRemovePassword(btn) {
  if (btn.dataset.confirming) {
    // Second click — actually remove
    manageClearPassword();
    return;
  }
  btn.dataset.confirming = '1';
  btn.textContent = t('confirm_remove') || 'Are you sure?';
  btn.style.color = 'var(--amber)';
  setTimeout(function() {
    delete btn.dataset.confirming;
    btn.textContent = t('remove');
    btn.style.color = 'var(--text2)';
  }, 3000);
}

async function manageClearPassword() {
  const body = {password: '', current: _manageToken || ''};
  const res = await manageFetch('/manage/set-password', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    var err = await res.json().catch(function() { return {}; });
    if (err.error) _showToast(err.error);
    return;
  }
  if (res.ok) {
    _manageToken = '';
    _clearManageToken();
    closePwModal();
    renderManage();
  }
}

async function _generateToken() {
  var res = await manageFetch('/manage/generate-token', { method: 'POST' });
  if (!res.ok) {
    var err = await res.json().catch(function() { return {}; });
    if (err.error) _showToast(err.error);
    return;
  }
  var data = await res.json();
  var el = document.getElementById('ms-security');
  if (el) {
    el.innerHTML = '<div style="padding:10px;background:var(--surface);border:1px solid var(--amber-border);border-radius:8px;font-family:monospace;font-size:12px;word-break:break-all">' +
      '<div style="color:var(--text2);font-size:11px;margin-bottom:4px">' + tH('copy_token_now') + '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<span>' + esc(data.token) + '</span>' +
      '<button class="pill" onclick="navigator.clipboard.writeText(\'' + escAttr(data.token) + '\');this.textContent=t(\'copied\')">' + tH('copy') + '</button>' +
      '</div></div>' +
      '<button class="pill" style="margin-top:8px" onclick="switchMs(\'server\')">' + tH('done') + '</button>';
  }
}

async function _regenerateToken() {
  if (!(await _appConfirm(t('confirm_regenerate_token')))) return;
  await manageFetch('/manage/revoke-token', { method: 'POST' });
  _generateToken();
}

async function _revokeToken() {
  if (!(await _appConfirm(t('confirm_revoke_token')))) return;
  await manageFetch('/manage/revoke-token', { method: 'POST' });
  switchMs('server');
}

function getFlavorVariants(installedZim) {
  // Find catalog variants that match this installed ZIM's base name.
  // Same-token date editions collapse to the newest — two dropdown rows for
  // one build would both read as the same flavor (#50).
  if (!_catalogCache) return [];
  // Installed file: "wikipedia_en_all_maxi_2024-05.zim" → base: "wikipedia_en_all"
  const fb = (installedZim.file || '').replace(/\.zim$/, '');
  const matching = _newestPerFlavor(_catalogCache.filter(item => {
    return fb.startsWith(item.name + '_') || fb === item.name;
  }));
  if (matching.length <= 1) return [];
  // "Current" compares filename flavor TOKENS, not rendered labels: label
  // equality marked BOTH mdwiki builds current (both read "Full"), leaving
  // two checkmarks and nothing switchable (#50). Sorting by token (not the
  // English label strings) also survives translation.
  const instTok = _flavorToken(installedZim.file);
  const urls = matching.map(item => item.download_url);
  const rank = u => ({ mini: 0, nopic: 1, maxi: 2 })[_flavorToken(u)] ?? 3;
  return matching.map(item => ({
    label: variantLabel(item.download_url, urls) || t('full'),
    size: formatSize(item.size_bytes),
    url: item.download_url,
    current: _flavorToken(item.download_url) === instTok,
  })).sort((a, b) => rank(a.url) - rank(b.url));
}

function showFlavorPicker(btn, zimName, variants) {
  // Remove any existing popup
  closeFlavorPopup();
  const rect = btn.getBoundingClientRect();
  // Backdrop to close on click outside
  const backdrop = document.createElement('div');
  backdrop.className = 'flavor-popup-backdrop';
  backdrop.onclick = closeFlavorPopup;
  document.body.appendChild(backdrop);
  // Popup
  const popup = document.createElement('div');
  popup.className = 'flavor-popup';
  popup.id = 'flavor-popup';
  let html = '<div class="flavor-popup-title">' + tH('choose_flavor') + '</div>';
  for (const v of variants) {
    if (v.current) {
      html += '<div class="flavor-option current">' +
        '<div class="flavor-option-check">\u2713</div>' +
        '<div class="flavor-option-label">' + esc(v.label) + '</div>' +
        '<div class="flavor-option-size">' + esc(v.size) + '</div>' +
      '</div>';
    } else {
      html += '<div class="flavor-option" onclick="switchToFlavor(\'' + escAttr(v.url) + '\', \'' + escAttr(zimName) + '\')">' +
        '<div class="flavor-option-check"></div>' +
        '<div class="flavor-option-label">' + esc(v.label) + '</div>' +
        '<div class="flavor-option-size">' + esc(v.size) + '</div>' +
      '</div>';
    }
  }
  popup.innerHTML = html;
  document.body.appendChild(popup);
  // Position below the pill, clamped to viewport
  const popW = popup.offsetWidth;
  let left = rect.right - popW;
  if (left < 8) left = 8;
  let top = rect.bottom + 6;
  if (top + popup.offsetHeight > window.innerHeight - 8) top = rect.top - popup.offsetHeight - 6;
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
}

function closeFlavorPopup() {
  const popup = document.getElementById('flavor-popup');
  if (popup) popup.remove();
  const bd = document.querySelector('.flavor-popup-backdrop');
  if (bd) bd.remove();
}

function switchToFlavor(downloadUrl, zimName) {
  closeFlavorPopup();
  // Find a nearby download button or create a virtual one for progress tracking
  downloadZim(downloadUrl, null);
}

function showCatalogFlavorPicker(chevronBtn) {
  closeFlavorPopup();
  var split = chevronBtn.closest('.ci-dl-split');
  var variants = window[split.dataset.variants];
  var selected = +split.dataset.selected;
  var rect = chevronBtn.getBoundingClientRect();
  var backdrop = document.createElement('div');
  backdrop.className = 'flavor-popup-backdrop';
  backdrop.onclick = closeFlavorPopup;
  document.body.appendChild(backdrop);
  var popup = document.createElement('div');
  popup.className = 'flavor-popup';
  popup.id = 'flavor-popup';
  var html = '';
  for (var i = 0; i < variants.length; i++) {
    var v = variants[i];
    var isCurrent = (i === selected);
    html += '<div class="flavor-option' + (isCurrent ? ' current' : '') + '"' +
      (isCurrent ? '' : ' onclick="selectCatalogFlavor(this,' + i + ')"') + '>' +
      '<div class="flavor-option-check">' + (isCurrent ? '\u2713' : '') + '</div>' +
      '<div class="flavor-option-label">' + esc(v.label) + '</div>' +
      '<div class="flavor-option-size">' + esc(v.size) + '</div>' +
    '</div>';
  }
  popup.innerHTML = html;
  popup.dataset.splitId = split.dataset.variants;
  document.body.appendChild(popup);
  var left = rect.right - popup.offsetWidth;
  if (left < 8) left = 8;
  var top = rect.bottom + 6;
  if (top + popup.offsetHeight > window.innerHeight - 8) top = rect.top - popup.offsetHeight - 6;
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
}

function selectCatalogFlavor(optionEl, index) {
  var popup = optionEl.closest('.flavor-popup');
  var splitId = popup.dataset.splitId;
  closeFlavorPopup();
  // Find the split button and update it
  var split = document.querySelector('.ci-dl-split[data-variants="' + splitId + '"]');
  if (!split) return;
  var variants = window[splitId];
  var v = variants[index];
  split.dataset.selected = index;
  var mainBtn = split.querySelector('.ci-dl-main');
  mainBtn.textContent = t('download_size', {size: v.label + ' (' + v.size + ')'});
  // Point the row's multi-select checkbox at the chosen flavor too; if the
  // item is already checked, re-total the selection bar with the new size.
  var itemEl = split.closest('.catalog-item');
  var cb = itemEl ? itemEl.querySelector('.ci-select') : null;
  if (cb) {
    if (_reselectDownloadUrl(cb.dataset.url, v.url, v.bytes)) _renderSelectionBar();
    cb.dataset.url = v.url;
    cb.dataset.size = String(v.bytes || 0);
  }
}

async function _downloadPack(btn, urls) {
  if (btn) { btn.disabled = true; btn.textContent = t('starting'); }
  var started = 0;
  for (var i = 0; i < urls.length; i++) {
    try {
      const res = await manageFetch('/manage/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urls[i] }),
      });
      const data = await res.json();
      if (!data.error) started++;
    } catch(e) {}
  }
  if (btn) { btn.textContent = started + ' queued'; btn.classList.add('ci-installed-badge'); }
}
async function _downloadPackFromSelects(btn) {
  // Collect URLs from each featured card's flavor dropdown (or single-button cards)
  var urls = [];
  document.querySelectorAll('.featured-card').forEach(function(card) {
    var sel = card.querySelector('.fc-pack-select');
    if (sel) { urls.push(sel.value); return; }
    var singleBtn = card.querySelector('.ci-add-btn');
    if (singleBtn) {
      var oc = singleBtn.getAttribute('onclick') || '';
      var m = oc.match(/downloadZim\('([^']+)'/);
      if (m) urls.push(m[1]);
    }
  });
  if (urls.length) await _downloadPack(btn, urls);
}

async function manageImportZim() {
  var url = prompt(t('import_url_prompt'));
  if (!url || !url.trim()) return;
  url = url.trim();
  if (!url.startsWith('https://')) {
    _showToast(t('url_must_https'));
    return;
  }
  if (!/\.zim(\?|#|$)/.test(url)) {
    _showToast(t('url_must_zim'));
    return;
  }
  try {
    var resp = await manageFetch('/manage/import', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url: url})
    });
    var data = await resp.json();
    if (!resp.ok) { _showToast(data.error || t('import_failed', {error: ''})); return; }
    _showToast(t('import_started', {name: url.split('/').pop().split('?')[0]}));
    renderManage();
  } catch(e) {
    _showToast(t('import_failed', {error: e.message}));
  }
}

async function downloadZim(url, btn, isUpdate) {
  if (btn) { btn.disabled = true; btn.textContent = t('starting'); }
  try {
    const res = await manageFetch('/manage/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (data.error) { if (btn) { btn.textContent = t('error'); btn.disabled = false; } return; }
    if (btn) {
      btn.dataset.dlUrl = url;
      btn.textContent = isUpdate ? t('updating') : t('downloading');
      btn.classList.add('ci-installed-badge');
      // Hide sibling variant buttons (only show the one being downloaded)
      const variantsDiv = btn.closest('.ci-variants');
      if (variantsDiv) {
        variantsDiv.querySelectorAll('.ci-variant-btn').forEach(b => {
          if (b !== btn) b.style.display = 'none';
        });
      }
    }
    _dlPrevAllDone = false; // ensure completion transition fires even for fast downloads
    _dlRecentStart = Date.now();
    _showManageBadge(true, 1);
    refreshDownloads();
    if (window._nudgeActivityPoll) window._nudgeActivityPoll();
  } catch(e) {
    if (btn) { btn.textContent = t('error'); btn.disabled = false; }
  }
}

async function deleteZim(filename, btn) {
  if (!btn) return;
  // Two-click confirmation: first click shows "Delete?", second click confirms
  if (!btn.classList.contains('confirming')) {
    btn.classList.add('confirming');
    btn.textContent = t('delete_confirm');
    btn.title = t('click_to_confirm');
    // Reset after 4 seconds if not confirmed
    setTimeout(() => { if (btn.classList.contains('confirming')) { btn.classList.remove('confirming'); btn.textContent = '\u00D7'; btn.title = t('delete_zim'); }}, 4000);
    return;
  }
  btn.textContent = t('deleting');
  btn.disabled = true;
  const card = btn.closest('.catalog-item');
  // Optimistic: hide card immediately
  if (card) card.style.display = 'none';
  zimsCache = (zimsCache || []).filter(function(z) { return z.file !== filename; });
  _rebuildZimsMap();
  try {
    const res = await manageFetch('/manage/delete', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({filename})
    });
    const data = await res.json();
    if (data.error) {
      // Restore card on error
      if (card) card.style.display = '';
      btn.textContent = t('error') + ': ' + data.error;
      return;
    }
    if (card) card.remove();
    _catalogCache = null;
    // A deleted ZIM may be one Zimi made — drop the cached made-here inventory
    // so it (and the freed capture name) refresh, instead of lingering in the
    // Creator list (Eric: "after I delete they still live there").
    _creatorInventory = null;
    if (typeof _creatorLoadInventory === 'function' && _msSection === 'creator') _creatorLoadInventory();
    zimsCache = await _fetchList();
    _rebuildZimsMap();
    const tabBtn = document.querySelector('.manage-tab[data-tab="installed"]');
    if (tabBtn) tabBtn.textContent = t('installed_tab');
    // Update status card count
    const statusVal = document.querySelector('#manage-status .mc-value');
    if (statusVal) statusVal.textContent = String(zimsCache ? zimsCache.length : 0);
    // Re-render current view
    if (manageTab === 'installed') renderInstalled();
    else if (_browseView === 'drilldown' && manageCategoryFilter) drillCategory(manageCategoryFilter);
    else if (_browseView === 'gallery') renderBrowseGallery();
  } catch(e) {
    btn.textContent = t('error');
  }
}

async function buildFts(name, btn) {
  if (!btn) return;
  btn.textContent = t('building');
  btn.disabled = true;
  try {
    const res = await manageFetch('/manage/build-fts', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name})
    });
    const data = await res.json();
    if (data.error) { btn.textContent = t('error'); btn.title = data.error; return; }
    if (data.status === 'already_exists') { btn.textContent = t('already_built'); return; }
    btn.textContent = t('done_elapsed', {time: data.elapsed || '?'});
  } catch(e) {
    btn.textContent = t('error');
  }
}

// Language chip for a downloads/seeds row — full language name where we can
// resolve it (space allows here, unlike the tiles), 2-letter code in the
// tooltip. Derived from an installed ZIM's language or, failing that, parsed
// from the file/ZIM name, so identically-titled transfers (several Wikipedias)
// are distinguishable. Returns '' for English / language-agnostic content.
function _dlLangBadge(name, installedLang) {
  var lang = (installedLang || '').toLowerCase();
  if (!lang || lang === 'all' || lang === 'mul' || lang === 'multi' || lang.includes(',')) {
    lang = (_langFromName(name) || '').toLowerCase();  // name-derived fallback
  }
  if (!lang || lang === 'en' || lang === 'eng') return '';
  var code = lang.length > 2 ? (_LANG3TO2[lang] || lang.slice(0, 2)) : lang;
  if (code === 'en') return '';
  var full = _langDisplayName(code) || code.toUpperCase();
  return '<span class="lang-badge dl-lang-badge" title="' + escAttr(code.toUpperCase()) + '">' + esc(full) + '</span>';
}

function dlTitle(dl) {
  const fn = dl.filename || '';
  const url = dl.url || '';
  const urlBase = url.replace(/\.meta4$/, '');
  // 1. Exact match in installed cache
  if (zimsCache) {
    const exact = zimsCache.find(z => z.file === fn);
    if (exact) return exact.title || exact.name;
  }
  // 2. Check _availableUpdates — match by download URL
  for (const u of Object.values(_availableUpdates)) {
    if (u.download_url && url) {
      const uBase = u.download_url.replace(/\.meta4$/, '');
      if (uBase === urlBase) return u.title || u.name;
    }
  }
  // 3. Base-name match in installed cache (for updates: same ZIM, different date)
  const base = fn.replace(/\.zim$/, '').replace(/_\d{4}-\d{2}$/, '');
  if (zimsCache && base) {
    const match = zimsCache.find(z => {
      const zbase = (z.file || '').replace(/\.zim$/, '').replace(/_\d{4}-\d{2}$/, '');
      return zbase === base;
    });
    if (match) return match.title || match.name;
  }
  // 4. Catalog cache match by download URL
  if (_catalogCache && url) {
    for (const item of _catalogCache) {
      if (item.download_url) {
        const iBase = item.download_url.replace(/\.meta4$/, '');
        if (iBase === urlBase) return item.title || item.name;
      }
    }
  }
  // 5. Humanize filename
  return base.replace(/_/g, ' ').replace(/\./g, ' ');
}

let _dlPrevAllDone = true; // track when downloads finish to trigger refresh
let _dlPrevCompletedCount = 0; // per-download completion → refresh library list
let _dlRecentStart = 0;   // timestamp of last download start (grace period for server lag)

function _updateDownloadsTabBadge(activeCount) {
  const badge = document.getElementById('dl-tab-badge');
  if (!badge) return;
  if (activeCount > 0) {
    badge.textContent = String(activeCount);
    badge.style.display = '';
  } else {
    badge.textContent = '';
    badge.style.display = 'none';
  }
}

let _dlRefreshing = false;
// Last downloads payload, cached so tapping a filter pill can repaint instantly
// from data we already have instead of waiting for the next fetch (#6).
let _dlLastDls = null, _dlLastSeeds = [], _dlLastSeedCap = 2, _dlLastOps = null;
// The export state persists server-side until the NEXT export, so a done/error
// card is only shown after we watched this export run in this page session —
// otherwise last week's export would haunt the panel forever.
let _dlExportSeen = false;

// Synthetic job cards for background server operations (bookmark→ZIM export,
// library health check). Visibility only — controls live in their own UIs.
function _dlOpsCardsHtml(ops) {
  const ex = (ops && ops.export) || {};
  const hc = (ops && ops.health) || {};
  if (ex.phase === 'running') _dlExportSeen = true;
  const bar = (done, total) => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return '<div class="dl-progress' + (total ? '' : ' dl-indeterminate') +
      '"><div class="dl-progress-bar"' + (total ? ' style="width:' + pct + '%"' : '') + '></div></div>';
  };
  const row = (label, right) =>
    '<div class="dl-row"><span class="dl-name">' + label + '</span>' + right + '</div>';
  let h = '';
  if (ex.phase === 'running') {
    h += '<div class="dl-item dl-op-item">' +
      row(tH('dl_export_job'), '<span class="dl-size">' + (ex.total ? (ex.done || 0) + ' / ' + ex.total : '') + '</span>') +
      bar(ex.done || 0, ex.total || 0) + '</div>';
  } else if (_dlExportSeen && ex.phase === 'done') {
    h += '<div class="dl-item dl-op-item">' +
      row(tH('dl_export_job'), '<span class="dl-done">\u2713 ' + tH('dl_complete') + '</span>') + '</div>';
  } else if (_dlExportSeen && ex.phase === 'error') {
    h += '<div class="dl-item dl-op-item">' +
      row(tH('dl_export_job'), '<span class="dl-error">' + tH('save_to_zim_failed') + '</span>') + '</div>';
  }
  if (hc.phase === 'running') {
    h += '<div class="dl-item dl-op-item">' +
      row(tH('dl_health_job'), '<span class="dl-size">' + (hc.total ? (hc.done || 0) + ' / ' + hc.total : '') + '</span>') +
      bar(hc.done || 0, hc.total || 0) + '</div>';
  }
  return h;
}

// True while an op should keep the downloads panel alive (rendered card or
// active work) — feeds both the empty-state check and the poll cadence.
function _dlOpsActive(ops) {
  const ex = (ops && ops.export) || {};
  const hc = (ops && ops.health) || {};
  return ex.phase === 'running' || hc.phase === 'running' ||
    (_dlExportSeen && (ex.phase === 'done' || ex.phase === 'error'));
}
async function refreshDownloads() {
  // Re-entrancy guard: overlapping calls double-fetch /list and corrupt
  // the completed-count bookkeeping.
  if (_dlRefreshing) return;
  _dlRefreshing = true;
  try { await _refreshDownloadsInner(); } finally { _dlRefreshing = false; }
}

// useCache=true renders from the last fetched payload with no network round-trip
// and no polling/library side-effects — the instant filter-pill repaint (#6).
async function _refreshDownloadsInner(useCache) {
  if (!useCache && _dlTimer) { clearTimeout(_dlTimer); _dlTimer = null; }
  const dlEl = document.getElementById('manage-downloads');
  if (!dlEl) return;
  try {
    let dls, seedingTorrents = [], seedingCap = 2, ops = null;
    if (useCache && _dlLastDls) {
      dls = _dlLastDls; seedingTorrents = _dlLastSeeds; seedingCap = _dlLastSeedCap; ops = _dlLastOps;
    } else {
      const [res, seedRes, actRes] = await Promise.all([
        manageFetch('/manage/downloads'),
        authedFetch('/manage/seeding').catch(() => null),
        authedFetch('/manage/activity', { credentials: 'same-origin' }).catch(() => null),
      ]);
      const data = await res.json();
      dls = data.downloads || [];
      if (seedRes && seedRes.ok) {
        try {
          const sd = await seedRes.json();
          seedingTorrents = (sd.torrents || []).filter(t => t.completed_bytes > 0);
          seedingCap = sd.ratio_cap || 2;
        } catch (e) {}
      }
      if (actRes && actRes.ok) {
        try { ops = await actRes.json(); } catch (e) {}
      }
      _dlLastDls = dls; _dlLastSeeds = seedingTorrents; _dlLastSeedCap = seedingCap; _dlLastOps = ops;
    }
    const opsHtml = _dlOpsCardsHtml(ops);
    if (!dls.length && !seedingTorrents.length && !opsHtml) {
      // Grace period: keep polling fast for 10s after a download was started
      // (server may not have registered it yet)
      if (!useCache && _dlRecentStart && Date.now() - _dlRecentStart < 10000) {
        _dlTimer = setTimeout(refreshDownloads, 1000);
        return;
      }
      while (dlEl.firstChild) dlEl.removeChild(dlEl.firstChild);
      const emptyEl = document.createElement('div');
      emptyEl.className = 'dl-empty';
      emptyEl.textContent = t('no_active_downloads');
      dlEl.appendChild(emptyEl);
      _dlPrevAllDone = true;
      _showManageBadge(false);
      _updateDownloadsTabBadge(0);
      // Keep polling if auto-update may start downloads (skip on cache repaint —
      // the caller fires a real refresh that owns the poll schedule).
      const sel = document.getElementById('auto-update-freq');
      if (!useCache && sel && sel.value !== 'disabled' && mode === 'manage') _dlTimer = setTimeout(refreshDownloads, 5000);
      return;
    }
    _dlRecentStart = 0; // clear grace once server reports downloads
    const anyActive = dls.some(d => !d.done);
    const allDone = !anyActive;
    // Scheduled rows show "starts HH:MM" from the window config — fetch it once
    // when a scheduled item first appears, then repaint so the time fills in.
    if (dls.some(d => d.scheduled) && !window._dlSchedule && !window._dlScheduleFetching) {
      window._dlScheduleFetching = true;
      manageFetch('/manage/download-schedule').then(r => r.json()).then(s => {
        window._dlSchedule = s || {}; window._dlScheduleFetching = false; refreshDownloads();
      }).catch(() => { window._dlScheduleFetching = false; });
    }
    const queuedDls = dls.filter(d => d.queued);
    const downloadingDls = dls.filter(d => !d.done && !d.queued);
    const completedDls = dls.filter(d => d.done);
    const filter = localStorage.getItem('zimi_dl_filter') || 'all';
    const visibleDls = (filter === 'queued') ? queuedDls
      : (filter === 'downloading') ? downloadingDls
      : (filter === 'completed') ? completedDls
      : (filter === 'seeding') ? []
      : downloadingDls.concat(queuedDls).concat(completedDls);
    // A download finished while others still run — refresh the library
    // list NOW so the new ZIM is browsable without waiting for the batch.
    // (The heavier status/updates refresh still runs on the final one.)
    if (!useCache && completedDls.length > _dlPrevCompletedCount && !allDone) {
      try {
        zimsCache = await _fetchList();
        _rebuildZimsMap();
        if (_catalogCache) _enrichCatalogInstalled(_catalogCache);
        // Flip peer pills / download buttons to Installed in an open catalog
        if (manageTab === 'browse') {
          if (_browseView === 'drilldown' && manageCategoryFilter) drillCategory(manageCategoryFilter);
          else if (_browseView === 'search') { var _q = q.value.trim(); if (_q) browseCatalogFilter(_q); }
        }
      } catch (e) {}
    }
    _dlPrevCompletedCount = completedDls.length;
    let h = '<div class="manage-card"><div class="dl-head"><h2>' + tH('downloads') + '</h2>';
    if (allDone) {
      h += '<button class="dl-clear-btn" onclick="clearDownloads()">' + tH('clear') + '</button>';
    }
    h += '</div>';
    // Filter pill bar — All / Downloading / Queued / Completed
    const pill = (key, label, count) =>
      '<button class="pill dl-filter-pill' + (filter === key ? ' active' : '') +
      '" onclick="_setDownloadFilter(\'' + key + '\')">' +
      label + (count > 0 ? ' <span class="pill-count">' + count + '</span>' : '') +
      '</button>';
    h += '<div class="dl-filter-bar">' +
      pill('all', tH('all'), dls.length) +
      pill('downloading', tH('downloads_active'), downloadingDls.length) +
      pill('queued', tH('downloads_queued'), queuedDls.length) +
      pill('completed', tH('downloads_completed'), completedDls.length) +
      (seedingTorrents.length ? pill('seeding', tH('seeding_tab'), seedingTorrents.length) : '') +
    '</div>';
    // Bulk controls — only meaningful with more than one download; single items
    // have their own per-row controls. Pause/Resume all appear only when there's
    // something in that state to act on; Delete all always confirms first.
    // Bulk Pause/Resume only — each acts on a real, reversible download state.
    // The old "Delete all" was removed: it wiped the visible list (and came
    // back on reload), which read as broken rather than useful. Per-row
    // controls remove a single download when that is actually what you want.
    if (dls.length >= 2) {
      const pausableCount = downloadingDls.filter(d => !d.paused && !d.scheduled).length;
      const resumableCount = dls.filter(d => d.paused).length;
      if (pausableCount || resumableCount) {
        h += '<div class="dl-bulk-bar">';
        if (pausableCount) h += '<button class="dl-bulk-btn" onclick="pauseAllDownloads()">' + tH('dl_pause_all') + '</button>';
        if (resumableCount) h += '<button class="dl-bulk-btn" onclick="resumeAllDownloads()">' + tH('dl_resume_all') + '</button>';
        h += '</div>';
      }
    }
    h += '<div class="dl-grid">';
    // Background-operation cards ride at the top of the default view only —
    // they aren't downloads, so the specific filters leave them out.
    if (filter === 'all') h += opsHtml;
    // Seed cards render under "Seeding" AND under "All" — All means all.
    // (With zero downloads and active seeds, All used to render blank.)
    if (filter === 'seeding' || filter === 'all') {
      // Bulk seed controls sit at the TOP RIGHT of the seeds section (title
      // left, actions right — same reading order as the downloads bulk bar).
      // Pause/Resume all only when a seed is in that state to act on;
      // Remove all always. Under "All" they appear once there are 2+ seeds
      // (a single seed's own row buttons cover it). The hint line spells out
      // what Remove actually does — see /manage/seeding-action: the torrent
      // is de-listed and its ledger intent dropped, files stay on disk.
      if (seedingTorrents.length && (filter === 'seeding' || seedingTorrents.length >= 2)) {
        const anyPausableSeed = seedingTorrents.some(s => s.state !== 'paused');
        const anyResumableSeed = seedingTorrents.some(s => s.state === 'paused');
        h += '<div class="dl-seed-head">' +
          '<span class="dl-seed-head-title">' + tH('seeding_tab') + '</span>' +
          '<div class="dl-seed-actions">' +
            (anyPausableSeed ? '<button class="dl-bulk-btn" onclick="pauseAllSeeds()">' + tH('dl_pause_all') + '</button>' : '') +
            (anyResumableSeed ? '<button class="dl-bulk-btn" onclick="resumeAllSeeds()">' + tH('dl_resume_all') + '</button>' : '') +
            '<button class="dl-cancel-btn" onclick="_seedAction(null, \'stop_all\', this)" title="' + escAttr(t('stop_all_seeds_tip')) + '">' + tH('stop_all_seeds') + '</button>' +
          '</div></div>' +
          '<div class="dl-seed-hint">' + tH('seed_remove_hint') + '</div>';
      }
      for (const sd of seedingTorrents) {
        // Prefer the installed ZIM's real title; the card opens it
        const base = (sd.filename || '').replace(/\.zim$/, '');
        const zim = (zimsCache || []).find(z => z.name === base.replace(/_\d{4}-\d{2}$/, '') || (z.file || '') === sd.filename);
        const sName = zim ? (zim.title || zim.name) : base.replace(/_\d{4}-\d{2}$/, '').replace(/_/g, ' ');
        const zimName = zim ? zim.name : base.replace(/_\d{4}-\d{2}$/, '');
        const paused = sd.state === 'paused';
        const connected = sd.peers || 0;
        // "Sharing" reads as a state a person understands. Idle = nobody's
        // pulling right now (not broken); active = show what's going out.
        // (Replaces the old "waiting for requests" copy that confused.)
        // Idle = nothing moving right now, even for a seed that has uploaded
        // plenty before. The meta line carries the LIVE rate; the lifetime
        // total lives on the goal line below — it used to appear in both,
        // which read as the same number printed twice.
        const idle = !sd.up_speed;
        // Lifetime uploaded bytes vs the goal (ratio cap x file size). Mirror
        // seeds run uncapped, so they show uploaded + an ∞ label instead.
        const up = sd.cumulative_uploaded_bytes != null ? sd.cumulative_uploaded_bytes : (sd.uploaded_bytes || 0);
        const cap = sd.cap_bytes || 0;
        const size = sd.file_size_bytes || sd.completed_bytes || 0;
        const isMirror = sd.mirror || !cap;
        const curRatio = size ? up / size : (sd.ratio || 0);
        const goalStr = isMirror
          ? tH('seed_mirror_uploaded', {up: _fmtBytes(up)})
          : tH('seed_uploaded_of', {up: _fmtBytes(up), goal: _fmtBytes(cap), ratio: curRatio.toFixed(1), cap: seedingCap});
        const pct = isMirror ? 0 : Math.min(100, Math.round((up / cap) * 100));
        const meta = paused
          ? tH('seed_paused_note')
          : idle
            ? tH('seed_waiting', {n: connected})
            : tH('seed_active', {speed: _fmtBytes(sd.up_speed), n: connected});
        h += '<div class="dl-item dl-seed-item">' +
          '<div class="dl-row">' +
          '<span class="dl-seed-icon">' + _sourceIconHtml(zimName, 22) + '</span>' +
          '<span class="dl-name dl-seed-link" onclick="enterSource(\'' + escAttr(escJs(zimName)) + '\', true)" title="' + escAttr(sName) + '">' + esc(sName) + '</span>' +
          _dlLangBadge(zimName, (_zimInfo(zimName) || {}).language) +
          '<span class="dl-size">' + meta + '</span></div>' +
          '<div class="dl-seed-goal">' + esc(goalStr) +
            (sd.added ? '<span class="dl-seed-age"> · ' + tH('seed_added_when', {when: _relTime(sd.added)}) + '</span>' : '') +
          '</div>' +
          (isMirror ? '' : '<div class="dl-progress" title="' + escAttr(t('seed_bar_tip', {cap: seedingCap})) + '"><div class="dl-progress-bar" style="width:' + pct + '%"></div></div>') +
          '<div class="dl-actions"><div class="dl-meta"></div><div class="dl-btns">' +
            '<button class="dl-pause-btn" onclick="_seedAction(\'' + escAttr(escJs(sd.id)) + '\', \'' + (paused ? 'resume' : 'pause') + '\', this)">' + (paused ? tH('resume') : tH('pause')) + '</button>' +
            '<button class="dl-cancel-btn" onclick="_seedAction(\'' + escAttr(escJs(sd.id)) + '\', \'stop\', this)">' + tH('stop_seed') + '</button>' +
          '</div></div>' +
          '</div>';
      }
      if (filter === 'seeding' && !seedingTorrents.length) {
        h += '<div class="dl-empty">' + tH('seeding_empty') + '</div>';
      }
    }
    if (filter !== 'seeding' && filter !== 'all' && !visibleDls.length) {
      h += '<div class="dl-empty">' + tH('dl_filter_empty') + '</div>';
    }
    // Under "All", a completed download that's now seeding is represented by
    // its seed card above — don't also render its redundant "Complete"
    // download card (that's the "showed up twice" the seed card + the
    // lingering done-download entry produced for the same BT file).
    const _seedNames = new Set(seedingTorrents.map(s => s.filename));
    const renderDls = (filter === 'all')
      ? visibleDls.filter(dl => !(dl.done && _seedNames.has(dl.filename)))
      : visibleDls;
    for (const dl of renderDls) {
      const title = dlTitle(dl);
      // one formatter, defined once — see fmtBytes near fmtSize.
      const totalStr = dl.total_bytes ? fmtBytes(dl.total_bytes) : '?';
      const dlStr = fmtBytes(dl.downloaded_bytes);
      // Total unknown = BT still fetching metadata / finding peers. Show a
      // sweeping bar + label instead of a lying "0 MB / ? · 0.0 MB/s".
      // Queued items also sweep — a 0%-wide bar reads as stalled
      const indeterminate = (!dl.total_bytes || dl.queued) && !dl.paused;
      const pct = dl.total_bytes ? (dl.percent || 0) : 0;
      const speed = dl.elapsed > 0 && dl.downloaded_bytes > 0 ? ((dl.downloaded_bytes / 1024 / 1024) / dl.elapsed).toFixed(1) : '0';

      h += '<div class="dl-item">';
      h += '<div class="dl-row"><span class="dl-name">' + esc(title) + '</span>' +
        _dlLangBadge(dl.filename || dl.name, null);
      if (dl.error) {
        h += '<span class="dl-error">' + esc(dl.error) + '</span>';
      } else if (dl.done) {
        h += '<span class="dl-done">\u2713 ' + tH('dl_complete') + '</span>';
      } else if (dl.scheduled) {
        var _win = (window._dlSchedule && window._dlSchedule.start) || '';
        h += '<span class="dl-scheduled" title="' + escAttr(t('dl_scheduled_tip')) + '">\u23f0 ' +
          tH('dl_scheduled') + (_win ? ' \u00b7 ' + tH('dl_scheduled_starts', {time: esc(_win)}) : '') + '</span>';
      } else if (indeterminate) {
        h += '<span class="dl-size">' + tH('bt_connecting') + '</span>';
      } else {
        h += '<span class="dl-size">' + dlStr + ' / ' + totalStr + ' · ' + Math.round(pct) + '% · ' + speed + ' MB/s</span>';
      }
      h += '</div>';

      if (!dl.done && !dl.error) {
        h += '<div class="dl-progress' + (dl.paused ? ' dl-paused' : '') + (indeterminate ? ' dl-indeterminate' : '') +
          '"><div class="dl-progress-bar"' + (indeterminate ? '' : ' style="width:' + pct + '%"') + '></div></div>';
        var sourcePill = dl.source === 'bt'
          ? '<span class="dl-source dl-source-bt" title="' + escAttr(t('dl_via_bt_tip')) + '">' +
              tH('dl_via_bt') +
              (dl.bt_peers > 0 ? ' · ' + tH('n_peers', {n: dl.bt_peers}) : '') +
            '</span>'
          : '';
        // Delta-update salvage: pieces reused from the previous version so
        // only changed data downloads. Only meaningful on a BT transfer.
        var reusePill = (dl.source === 'bt' && dl.reused_bytes > 0)
          ? '<span class="dl-source dl-source-reuse" title="' + escAttr(t('dl_delta_reuse_tip')) + '">' +
              tH('dl_delta_reuse', {size: fmtBytes(dl.reused_bytes)}) +
            '</span>'
          : '';
        // Mirror info describes the HTTP path — on a BT transfer it reads as
        // nonsense next to the peer count, so show one or the other.
        var mirrorInfo = (dl.source !== 'bt' && dl.mirror_host) ? '<span class="dl-mirror" title="' + esc(dl.mirror_host) + '">' + esc(dl.mirror_host) + (dl.mirror_count > 1 ? ' (' + tH('n_mirrors', {n: dl.mirror_count}) + ')' : '') + '</span>' : '';
        var pauseBtn = dl.queued ? '' :
          '<button class="dl-pause-btn" onclick="pauseDownload(\'' + escAttr(dl.id) + '\',' + (dl.paused ? 'false' : 'true') + ')">' +
            (dl.paused ? tH('resume') : tH('pause')) + '</button>';
        // Scheduled items wait for the nightly window; offer an override that
        // starts (or normally-queues) the item right now.
        var startNowBtn = dl.scheduled
          ? '<button class="dl-pause-btn" onclick="startDownloadNow(\'' + escAttr(dl.id) + '\')" title="' + escAttr(t('dl_start_now_tip')) + '">' + tH('dl_start_now') + '</button>'
          : '';
        // Escape hatch for a slow swarm: only on an active BT transfer.
        var switchBtn = '';
        if (dl.source === 'bt' && !dl.queued) {
          switchBtn = dl.switching_direct
            ? '<button class="dl-pause-btn" disabled>' + tH('dl_switching_direct') + '</button>'
            : '<button class="dl-pause-btn" onclick="switchToDirect(\'' + escAttr(dl.id) + '\')" title="' + escAttr(t('dl_switch_direct_tip')) + '">' + tH('dl_switch_direct') + '</button>';
        }
        // Status chips left, controls right — the same two columns in every row.
        h += '<div class="dl-actions"><div class="dl-meta">' + sourcePill + reusePill + mirrorInfo +
          '</div><div class="dl-btns">' + switchBtn + startNowBtn + pauseBtn +
          '<button class="dl-cancel-btn" onclick="cancelDownload(\'' + escAttr(dl.id) + '\')">' + tH('cancel') + '</button></div></div>';
      }
      if (dl.error && dl.error !== 'Cancelled') {
        h += '<div class="dl-actions"><div class="dl-meta"></div><div class="dl-btns">' +
          '<button class="dl-retry-btn" onclick="downloadZim(\'' + escAttr(dl.url) + '\')">' + tH('retry') + '</button></div></div>';
      }
      h += '</div>';
    }
    h += '</div>';  // close .dl-grid
    h += '</div>';  // close .manage-card
    dlEl.innerHTML = h;
    // Update catalog item buttons with download progress
    for (const dl of dls) {
      const btns = document.querySelectorAll('[data-dl-url]');
      for (const btn of btns) {
        if (btn.dataset.dlUrl === dl.url || btn.dataset.dlUrl.replace(/\.meta4$/, '') === dl.url) {
          var chevron = btn.parentElement && btn.parentElement.querySelector('.ci-dl-chevron');
          if (dl.done) { btn.textContent = t('installed_badge'); btn.classList.remove('ci-dl-circle'); btn.onclick = null; if (chevron) chevron.style.display = 'none'; }
          else if (dl.error) { btn.textContent = t('error'); btn.disabled = false; btn.classList.remove('ci-dl-circle'); if (chevron) chevron.style.display = ''; }
          else if (dl.percent > 0) {
            var pct = Math.round(dl.percent);
            var circ = 2 * Math.PI * 10; // circumference for r=10
            var offset = circ * (1 - pct / 100);
            btn.innerHTML = '<span class="ci-dl-ring" title="' + pct + '% · click to cancel">' +
              '<svg viewBox="0 0 24 24" width="24" height="24">' +
              '<circle cx="12" cy="12" r="10" stroke="var(--border)" stroke-width="2" fill="none"/>' +
              '<circle cx="12" cy="12" r="10" stroke="var(--amber)" stroke-width="2" fill="none" stroke-dasharray="' + circ.toFixed(2) + '" stroke-dashoffset="' + offset.toFixed(2) + '" stroke-linecap="round" transform="rotate(-90 12 12)"/>' +
              '</svg>' +
              '<span class="ci-dl-x">\u00d7</span></span>';
            btn.classList.add('ci-dl-circle');
            btn.onclick = function(e) { e.stopPropagation(); cancelDownload(dl.id); };
            if (chevron) chevron.style.display = 'none';
          }
          else { btn.textContent = dl.is_update ? t('updating') : t('downloading'); btn.classList.remove('ci-dl-circle'); if (chevron) chevron.style.display = 'none'; }
        }
      }
    }
    // Track update progress — count downloads still in-flight
    if (Object.keys(_availableUpdates).length > 0) {
      const doneUrls = new Set();
      for (const dl of dls) {
        if (dl.done) doneUrls.add(dl.url);
      }
      // Count updates whose download is still active (not done)
      let stillRunning = 0;
      for (const u of Object.values(_availableUpdates)) {
        if (!u.download_url) continue;
        const stripped = u.download_url.replace(/\.meta4$/, '');
        if (!doneUrls.has(stripped) && !doneUrls.has(u.download_url)) stillRunning++;
      }
      const anyActive = dls.some(d => !d.done);
      const updateEl = document.getElementById('update-status');
      const updateBtn = document.getElementById('update-all-btn');
      if (anyActive) {
        // Downloads still running — transient "N remaining" progress line (not a
        // state the summary writer models). Non-clickable while in flight.
        if (updateEl) {
          updateEl.onclick = null; updateEl.classList.remove('mc-row-clickable');
          updateEl.innerHTML = '<span class="mc-label">' + tH('updates') + '</span><span class="mc-value" style="color:var(--amber)">' + stillRunning + ' ' + tH('remaining') + '</span>';
        }
        if (updateBtn && updateBtn.disabled) updateBtn.textContent = t('updating_n', {n: stillRunning});
      } else {
        // All downloads finished — drop successful ones, then repaint through the
        // single summary writer so state/clickability stay consistent.
        for (const dl of dls) {
          if (dl.done && !dl.error) {
            for (const [key, u] of Object.entries(_availableUpdates)) {
              const stripped = (u.download_url || '').replace(/\.meta4$/, '');
              if (dl.url === stripped || dl.url === u.download_url) { delete _availableUpdates[key]; break; }
            }
          }
        }
        _updatesStatus = 'ready';
        _renderUpdatesSummary();
      }
    }
    // When downloads finish, refresh the library to show new installs
    if (!useCache && allDone && !_dlPrevAllDone) {
      _dlPrevAllDone = true;
      try {
        zimsCache = await _fetchList();
        _rebuildZimsMap();
        _availableUpdates = {};
        // Re-merge install status into existing catalog (no OPDS re-fetch needed)
        if (_catalogCache) _enrichCatalogInstalled(_catalogCache);
        renderInstalled();
        checkForUpdates(true);
        // Update status card counts
        const sr = await manageFetch('/manage/status');
        const sd = await sr.json();
        const statusEl = document.getElementById('manage-status');
        if (statusEl) {
          statusEl.querySelector('.mc-value').textContent = String(sd.zim_count);
          const sizeVal = statusEl.querySelectorAll('.mc-value')[1];
          if (sizeVal) sizeVal.textContent = fmtSize(sd.total_size_gb);
        }
        // Update tab count
        const tabBtn = document.querySelector('.manage-tab[data-tab="installed"]');
        if (tabBtn) tabBtn.textContent = t('installed_tab');
        // Re-render browse view so download buttons update to "Installed"
        if (_browseView === 'drilldown' && manageCategoryFilter) drillCategory(manageCategoryFilter);
        else if (_browseView === 'search') { var sq = q.value.trim(); if (sq) browseCatalogFilter(sq); }
        else if (_browseView === 'gallery') renderBrowseGallery();
      } catch(e) {}
    }
    _dlPrevAllDone = allDone;
    const activeCount = dls.filter(d => !d.done).length;
    _showManageBadge(anyActive, activeCount);
    _updateDownloadsTabBadge(activeCount);
    if (!useCache && mode === 'manage') {
      // Poll fast while downloads active, slow-poll when auto-update enabled (server may start downloads)
      const sel = document.getElementById('auto-update-freq');
      const autoOn = sel && sel.value !== 'disabled';
      if (anyActive) _dlTimer = setTimeout(refreshDownloads, 2000);
      else if (_dlOpsActive(ops)) _dlTimer = setTimeout(refreshDownloads, 2000);
      else if (autoOn) _dlTimer = setTimeout(refreshDownloads, 10000);
    }
  } catch(e) {
    // Rate-limited: keep what's rendered and retry when the server says
    // so — never blank the panel (#30).
    if (e && e.rateLimited && mode === 'manage') {
      _dlTimer = setTimeout(refreshDownloads, Math.max(2, e.retryAfter) * 1000);
    }
  }
}

async function _seedAction(id, action, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await manageFetch('/manage/seeding-action', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(id ? {id: id, action: action} : {action: action})
    });
    if (!r.ok) _showToast(t('error'));
  } catch (e) { _showToast(t('error')); }
  if (btn) btn.disabled = false;
  refreshDownloads();
  _renderSeedingSection();
}

async function clearDownloads() {
  try {
    await manageFetch('/manage/clear-downloads', { method: 'POST' });
    _dlExportSeen = false; // also dismiss a finished export's job card
    const dlEl = document.getElementById('manage-downloads');
    if (dlEl) dlEl.innerHTML = '';
  } catch(e) {}
}

// The detail panel lists the pending updates from _availableUpdates — the same
// data the summary line counts, so the two can never disagree (no second fetch).
// Reachable only when there ARE updates (the row is inert otherwise).
function _toggleUpdatesDetail() {
  const el = document.getElementById('updates-detail');
  if (!el) return;
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  const updates = Object.values(_availableUpdates);
  if (!updates.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  while (el.firstChild) el.removeChild(el.firstChild);
  updates.forEach(u => {
    const row = document.createElement('div');
    row.className = 'updates-detail-row';
    const top = document.createElement('div');
    top.className = 'updates-detail-top';
    const name = document.createElement('span');
    name.className = 'updates-detail-name';
    name.textContent = u.title || u.name;
    const versions = document.createElement('span');
    versions.className = 'updates-detail-versions';
    versions.textContent = u.installed_date + ' → ' + u.latest_date;
    top.appendChild(name);
    top.appendChild(versions);
    row.appendChild(top);
    // Filename diff so the user can spot weirdness (e.g. flavor changes that
    // shouldn't happen — already filtered by _check_updates but visible if
    // anything slips through).
    const nextFname = (u.download_url || '').split('/').pop().replace(/\.meta4$/, '');
    if (u.installed_file && nextFname && nextFname !== u.installed_file) {
      const fnames = document.createElement('div');
      fnames.className = 'updates-detail-fnames';
      fnames.textContent = u.installed_file + '  →  ' + nextFname;
      row.appendChild(fnames);
    }
    el.appendChild(row);
  });
}

function _setDownloadFilter(filter) {
  localStorage.setItem('zimi_dl_filter', filter);
  // Instant feedback: flip the pill highlight now…
  document.querySelectorAll('.dl-filter-pill').forEach(function(p) {
    p.classList.toggle('active', p.getAttribute('onclick').indexOf("'" + filter + "'") >= 0);
  });
  // …and repaint the list from data we already have, so the filter applies
  // immediately instead of waiting for the next fetch (#6). Bypasses the
  // re-entrancy guard: cache mode does no network I/O and schedules no timer.
  if (_dlLastDls) _refreshDownloadsInner(true);
  // Then a real refresh for fresh data + to resume the poll schedule.
  refreshDownloads();
}

// Every download control is the same call: POST the download id, then re-read
// the list. A failure is silent and skips the refresh — the row keeps showing
// its last known state rather than flickering.
async function _downloadAction(path, id) {
  try {
    await manageFetch(path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id}),
    });
    refreshDownloads();
  } catch (e) {}
}

function pauseDownload(id, pause) {
  return _downloadAction(pause ? '/manage/pause' : '/manage/resume', id);
}

function cancelDownload(id) { return _downloadAction('/manage/cancel', id); }

// Bulk download controls. Download counts are small (a handful at most), so
// fan out the existing per-item endpoints in parallel and refresh once at the
// end rather than adding a batch endpoint. Each acts on the last-rendered list
// (_dlLastDls); individual failures are swallowed so one bad id can't strand
// the rest.
function _bulkDownloadAction(path, targets) {
  return Promise.all((targets || []).map(d => manageFetch(path, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: d.id}),
  }).catch(() => {})));
}
async function pauseAllDownloads() {
  const targets = (_dlLastDls || []).filter(d => !d.done && !d.queued && !d.scheduled && !d.paused);
  await _bulkDownloadAction('/manage/pause', targets);
  refreshDownloads();
}
async function resumeAllDownloads() {
  const targets = (_dlLastDls || []).filter(d => d.paused);
  await _bulkDownloadAction('/manage/resume', targets);
  refreshDownloads();
}
// Bulk seed controls: fan out the existing per-seed pause/resume endpoint over
// the last-rendered seed list (same pattern as _bulkDownloadAction — seed
// counts are small, and each call is one independent engine flag, so a batch
// endpoint would buy nothing). Failures are swallowed per seed.
async function _bulkSeedAction(action, targets) {
  await Promise.all((targets || []).map(s => manageFetch('/manage/seeding-action', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({id: s.id, action: action}),
  }).catch(() => {})));
  refreshDownloads();
  _renderSeedingSection();
}
function pauseAllSeeds() {
  return _bulkSeedAction('pause', (_dlLastSeeds || []).filter(s => s.state !== 'paused'));
}
function resumeAllSeeds() {
  return _bulkSeedAction('resume', (_dlLastSeeds || []).filter(s => s.state === 'paused'));
}

// Override the nightly window for one scheduled item — start it now.
function startDownloadNow(id) { return _downloadAction('/manage/download-start-now', id); }

function switchToDirect(id) { return _downloadAction('/manage/switch-direct', id); }

async function triggerUpdate() {
  const updates = Object.values(_availableUpdates);
  if (!updates.length) return;
  const btn = document.getElementById('update-all-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('updating_n', {n: updates.length}); }
  // Mark individual Update buttons so refreshDownloads() can show per-row progress
  for (const u of updates) {
    document.querySelectorAll('.ci-update-btn').forEach(b => {
      if (b.getAttribute('onclick') && b.getAttribute('onclick').includes(u.download_url)) {
        b.dataset.dlUrl = u.download_url;
        b.disabled = true;
        b.textContent = t('queued');
      }
    });
  }
  let started = 0;
  for (const u of updates) {
    try {
      const res = await manageFetch('/manage/download', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({url: u.download_url}) });
      const data = await res.json();
      if (data.id) started++;
    } catch(e) {}
  }
  // Don't reset button — refreshDownloads() will track progress and update it
  if (started > 0) { _dlPrevAllDone = false; refreshDownloads(); }
  else if (btn) { btn.disabled = false; btn.textContent = t('update_all'); }
}

function _autoUpdateTimerHtml() {
  const sel = document.getElementById('auto-update-freq');
  if (!sel || sel.value === 'disabled') return '';
  return '<svg title="Auto-update ' + sel.value + '" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;opacity:0.5;margin-right:5px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
}

var _lastUpdateCheck = 0;
var _UPDATE_CHECK_INTERVAL = 86400000;  // 24 hours
// Top-level Updates line state: 'checking' | 'ready' | 'error'. The count comes
// from _availableUpdates, so this only tracks the check lifecycle.
var _updatesStatus = 'checking';

// Single writer for the top-level Updates summary line (#update-status). Every
// path that changes update state (mount, check, download progress) funnels here
// so the label always reflects the real state — the fix for the label stranding
// on "Checking…" while the detail panel showed the true result. The row is only
// clickable/expandable when there ARE updates; up-to-date, checking and error are
// a plain line with no dead expander.
function _renderUpdatesSummary() {
  var el = document.getElementById('update-status');
  if (!el) return;
  var count = Object.keys(_availableUpdates).length;
  var updateBtn = document.getElementById('update-all-btn');
  var label = '<span class="mc-label">' + tH('updates') + '</span>';
  var value, clickable = false;
  if (_updatesStatus === 'checking') {
    value = '<span class="mc-value" style="color:var(--text2)"><span class="spinner-inline"></span>' + tH('updates_checking') + '</span>';
  } else if (_updatesStatus === 'error') {
    value = '<span class="mc-value" style="color:var(--text2)">' + tH('updates_check_failed') + '</span>';
  } else if (count > 0) {
    value = '<span class="mc-value" style="color:var(--amber)">' + _autoUpdateTimerHtml() + tH('updates_available', {n: count}) +
      '<svg class="mc-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span>';
    clickable = true;
  } else {
    value = '<span class="mc-value" style="color:var(--text2)">' + tH('all_up_to_date') + '</span>';
  }
  el.innerHTML = label + value;
  if (clickable) {
    el.classList.add('mc-row-clickable');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.style.cursor = 'pointer';
    el.title = t('updates_show_detail');
    el.onclick = _toggleUpdatesDetail;
    el.onkeydown = function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _toggleUpdatesDetail(); } };
  } else {
    el.classList.remove('mc-row-clickable');
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
    el.style.cursor = '';
    el.removeAttribute('title');
    el.onclick = null;
    el.onkeydown = null;
    var det = document.getElementById('updates-detail');
    if (det) { det.style.display = 'none'; while (det.firstChild) det.removeChild(det.firstChild); }
  }
  if (updateBtn) {
    if (count > 0 && _updatesStatus === 'ready') { updateBtn.style.display = ''; if (!updateBtn.disabled) updateBtn.textContent = t('update_all'); }
    else updateBtn.style.display = 'none';
  }
}

async function checkForUpdates(force) {
  const el = document.getElementById('update-status');
  if (!el) return;
  // Use cached results if checked recently — repaint from _availableUpdates.
  var now = Date.now();
  if (!force && _lastUpdateCheck && (now - _lastUpdateCheck < _UPDATE_CHECK_INTERVAL)) {
    _updatesStatus = 'ready';
    _renderUpdatesSummary();
    return;
  }
  _updatesStatus = 'checking';
  _renderUpdatesSummary();
  try {
    const res = await manageFetch('/manage/check-updates');
    _lastUpdateCheck = now;
    const data = await res.json();
    _availableUpdates = {};
    if (data.updates) {
      for (const u of data.updates) {
        if (u.installed_file) _availableUpdates[u.installed_file] = u;
      }
    }
    _updatesStatus = 'ready';
    _renderUpdatesSummary();
    // Re-render installed tab to show inline update buttons
    if (manageTab === 'installed') renderInstalled();
  } catch(e) {
    _updatesStatus = 'error';
    _renderUpdatesSummary();
  }
}

async function refreshLibrary() {
  try {
    const res = await manageFetch('/manage/refresh', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'refreshed') {
      try {
        zimsCache = await _fetchList();
        _rebuildZimsMap();
      } catch(e) {}
      renderManage();
    }
  } catch(e) {}
}


// ── Helpers ──
function _pdfViewerUrl(pdfUrl) {
  // pdfUrl is already percent-encoded (/w/zim/path%20name.pdf).
  // PDF.js viewer fetches via XHR (Sec-Fetch-Dest: empty), so the server
  // serves raw content without needing ?raw=1 (that's only for browser navigation).
  // Don't append ?raw=1 — it gets parsed as a separate query param by URLSearchParams
  // and breaks the file path extraction in PDF.js's parseQueryString.
  var lang = (typeof _currentLang !== 'undefined' && _currentLang) ? _currentLang : '';
  var localeMap = { 'fr': 'fr', 'de': 'de', 'es': 'es-ES', 'pt': 'pt-BR', 'ru': 'ru', 'zh': 'zh-CN', 'ar': 'ar', 'he': 'he', 'hi': 'hi-IN' };
  var locale = localeMap[lang] || '';
  return '/static/pdfjs/web/viewer.html?file=' + pdfUrl + (locale ? '#locale=' + locale : '');
}
// Single-page docs (devdocs) surface result paths like 'index#backslash' where
// 'index' is the real ZIM entry and '#backslash' is an in-page fragment. Encode
// the path segments but keep '#fragment' raw so the browser scrolls to the
// section instead of requesting a nonexistent 'index%23backslash' entry.
function _splitPathFragment(path) {
  var h = path.indexOf('#');
  if (h === -1) return { base: path, frag: '' };
  return { base: path.slice(0, h), frag: path.slice(h) };
}
function _articleUrl(zim, path) {
  var p = _splitPathFragment(path);
  return '/w/' + encodeURIComponent(zim) + '/' + p.base.split('/').map(encodeURIComponent).join('/') + p.frag;
}
function _titleFromPath(path) {
  // Drop any in-page '#fragment' — a title should name the article, not the anchor
  // (single-page devdocs links carry 'index#section' style paths).
  var base = _splitPathFragment(path).base;
  return decodeURIComponent(base.split('/').pop() || '').replace(/_/g, ' ');
}
function _saveCurrentFile() {
  // Desktop: save the currently viewed file (PDF, EPUB) to disk
  if (!currentArticle) return;
  var url = _articleUrl(currentArticle.zim, currentArticle.path) + '?raw=1';
  _downloadFile(url);
}
function _downloadFile(url) {
  // Desktop app: use native save dialog via pywebview bridge
  if (IS_DESKTOP && window.pywebview && window.pywebview.api && window.pywebview.api.download_file) {
    var filename = decodeURIComponent((url.split('?')[0]).split('/').pop() || 'download');
    window.pywebview.api.download_file(url, filename).then(function(path) {
      if (path) console.log('[Zimi] Saved to:', path);
    }).catch(function(e) { console.warn('[Zimi] Download failed:', e); });
    return;
  }
  // Browser: trigger standard download
  var a = document.createElement('a');
  a.href = url; a.download = ''; a.style.display = 'none';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
function _stepBackToArticle(prev, replaceState) {
  // Navigate reader to a previous article from history.
  // replaceState=true for in-app back (URL hasn't changed yet),
  // replaceState=false for browser back (URL already changed by popstate).
  currentArticle = { zim: prev.zim, path: prev.path };
  readerSource = prev.zim;
  var url = _articleUrl(prev.zim, prev.path);
  var lurl = url.toLowerCase();
  // Address bar keeps the SPA's canonical ?a= form (never raw /w/ — see openArticle).
  if (replaceState) {
    history.replaceState({ mode: 'reader', zim: prev.zim, path: prev.path }, '', _articleDeepLinkPath(prev.zim, prev.path));
  }
  if (lurl.endsWith('.pdf')) url = _pdfViewerUrl(url);
  var docTitle = (prev.title || _titleFromPath(prev.path)) + ' \u2014 Zimi';
  document.title = docTitle;
  _setWindowTitle(docTitle);
  updateTopbar();
  openReader(url);
}

// ── Reader font scale ──
// A single cycling control (chosen over an A−/A+ pair to conserve the already
// crowded topbar) steps through these percentages, applied as a `zoom` on the
// iframe body and reapplied on every article load. Persisted in localStorage.
var READER_FONT_LEVELS = [85, 100, 115, 130];
var READER_FONT_DEFAULT = 100;

function _readerFontLevel() {
  var v = parseInt(localStorage.getItem(SK.READER_FONT), 10);
  return READER_FONT_LEVELS.indexOf(v) >= 0 ? v : READER_FONT_DEFAULT;
}
function _applyReaderFont(doc) {
  if (!doc || !doc.documentElement) return;
  var level = _readerFontLevel();
  try {
    // Scale via `zoom` on <body>, not a root font-size %. A root font-size only
    // rescales rem/em-sized text — an article whose body copy is in absolute px
    // (common outside MediaWiki) wouldn't budge, so users saw only headings grow.
    // `zoom` rescales every unit uniformly (px, rem, images) and is supported in
    // Safari/Chrome forever and Firefox 126+. We never combine the two: root% ×
    // zoom would double-scale rem docs.
    var body = doc.body || doc.documentElement;
    if (level === READER_FONT_DEFAULT) {
      // Default (100%): REMOVE the override rather than pin zoom:1. Also strip any
      // leftover root font-size an older (pre-zoom) session may have pinned, so a
      // ZIM's own root size (e.g. devdocs' html{font-size:62.5%} rem reset) governs
      // again. Cycling back to 100 routes through here too, so it clears live.
      body.style.removeProperty('zoom');
      doc.documentElement.style.removeProperty('font-size');
    } else {
      // `zoom` (NOT a width-compensated transform) is deliberate: modern WebKit
      // RE-LAYS-OUT at the zoom-divided viewport width, so text reflows and no
      // horizontal scroll appears. Verified empirically in the real reader (iOS
      // WebKit engine, 390px): maxScrollLeft == 0 at every level (85/100/115/130).
      // Do NOT add a body-width "compensation" (100/level%): that's the fix for
      // transform:scale, which doesn't reflow — under `zoom` it makes the body
      // wider than the viewport at zoom-OUT levels (85% → width:117% → a real
      // 69px x-scroll) and only wastes width at zoom-in. Bare zoom is correct.
      body.style.zoom = level / 100;
    }
  } catch(e) {}
}
function _syncFontBtnGlyph() {
  var btn = document.getElementById('font-btn');
  if (!btn) return;
  var level = _readerFontLevel();
  var idx = READER_FONT_LEVELS.indexOf(level); if (idx < 0) idx = 1;
  var glyph = btn.querySelector('.font-glyph');
  if (glyph) glyph.style.fontSize = (12 + idx * 2) + 'px'; // 12/14/16/18px live preview
  var label = t('font_size') + ' — ' + level + '%';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  _syncTopbarMenuReaderItems(); // keep the ... menu row (if open) in step
}
function _cycleReaderFont() {
  var idx = READER_FONT_LEVELS.indexOf(_readerFontLevel());
  var next = READER_FONT_LEVELS[(idx + 1) % READER_FONT_LEVELS.length];
  try { localStorage.setItem(SK.READER_FONT, String(next)); } catch(e) {}
  var frame = document.getElementById('reader-frame');
  try { if (frame && frame.contentDocument) _applyReaderFont(frame.contentDocument); } catch(e) {}
  _syncFontBtnGlyph();
}

// ── Reader text-to-speech (offline Web Speech API) ──
// Binary speak/stop model only — speechSynthesis.pause() is flaky across
// browsers, so we never expose pause. Long articles are split into short
// utterances (the API chokes on very long strings) and queued; stop cancels
// the whole queue.
var _TTS_AVAILABLE = (typeof window !== 'undefined') && ('speechSynthesis' in window);
var _ttsSpeaking = false;

function _ttsChunkText(text, maxLen) {
  maxLen = maxLen || 240;
  var out = [];
  if (!text) return out;
  // Collapse whitespace so newlines don't confuse sentence detection.
  var clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return out;
  // Split into sentences, keeping terminal punctuation (Latin + CJK).
  var sentences = clean.match(/[^.!?。！？]+[.!?。！？]+|\S[^.!?。！？]*$/g) || [clean];
  var buf = '';
  for (var i = 0; i < sentences.length; i++) {
    var s = sentences[i].trim();
    if (!s) continue;
    // A single sentence longer than maxLen: hard-split on word boundaries.
    if (s.length > maxLen) {
      if (buf) { out.push(buf); buf = ''; }
      var words = s.split(' ');
      var line = '';
      for (var w = 0; w < words.length; w++) {
        var word = words[w];
        if (line && (line.length + 1 + word.length) > maxLen) { out.push(line); line = word; }
        else { line = line ? (line + ' ' + word) : word; }
      }
      if (line) buf = line; // carry remainder to pack with the next sentence
      continue;
    }
    if (buf && (buf.length + 1 + s.length) > maxLen) { out.push(buf); buf = s; }
    else { buf = buf ? (buf + ' ' + s) : s; }
  }
  if (buf) out.push(buf);
  return out;
}

// Shared main-content locator for a ZIM article document. Returns the element
// that holds the article body (dropping surrounding nav/chrome) or null when no
// recognizable container exists. Both Read-aloud and Reader View build on this —
// one selector, one place to tune it. Callers decide their own body fallback.
var _READER_MAIN_SELECTOR = '#mw-content-text, .mw-parser-output, main, article, [role="main"]';
function _readerMainContent(doc) {
  if (!doc) return null;
  var main = null;
  try { main = doc.querySelector(_READER_MAIN_SELECTOR); } catch(e) {}
  return main;
}
function _ttsExtractText(doc) {
  if (!doc) return '';
  // Prefer the article's main content element — that alone drops surrounding
  // nav/chrome cheaply. Fall back to the whole body (acceptable v1).
  var main = _readerMainContent(doc) || doc.body;
  if (!main) return '';
  return (main.innerText || main.textContent || '').trim();
}
function _ttsLang(doc) {
  var l = '';
  try { l = (doc && doc.documentElement && doc.documentElement.lang) || ''; } catch(e) {}
  if (!l) {
    var info = _zimInfo(readerSource || (currentArticle && currentArticle.zim) || '');
    if (info && info.language) l = info.language;
  }
  return l || '';
}
function _ttsSetSpeaking(on) {
  _ttsSpeaking = on;
  _syncTopbarMenuReaderItems(); // mobile: reflect speaking-state on the ... menu row
  var btn = document.getElementById('tts-btn');
  if (!btn) return;
  btn.classList.toggle('speaking', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  var label = on ? t('tts_stop') : t('tts_speak');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}
function _ttsStop() {
  if (!_TTS_AVAILABLE) return;
  try { window.speechSynthesis.cancel(); } catch(e) {}
  if (_ttsSpeaking) _ttsSetSpeaking(false);
}
function _ttsSpeak() {
  if (!_TTS_AVAILABLE) return;
  var frame = document.getElementById('reader-frame');
  var doc; try { doc = frame && frame.contentDocument; } catch(e) { doc = null; }
  if (!doc) return;
  var chunks = _ttsChunkText(_ttsExtractText(doc), 240);
  if (!chunks.length) return;
  var lang = _ttsLang(doc);
  var synth = window.speechSynthesis;
  synth.cancel(); // clear any residual queue before starting fresh
  _ttsSetSpeaking(true);
  chunks.forEach(function(chunk, idx) {
    var u = new SpeechSynthesisUtterance(chunk);
    if (lang) u.lang = lang;
    if (idx === chunks.length - 1) u.onend = function() { _ttsSetSpeaking(false); };
    u.onerror = function() { _ttsSetSpeaking(false); };
    synth.speak(u);
  });
}
function _ttsToggle() {
  if (_ttsSpeaking) _ttsStop();
  else _ttsSpeak();
}

// ── Reader View (Safari-Reader-style clean typography) ──
// Re-renders the current ZIM article as a single, distraction-free reading column
// inside the SAME iframe — no reload, no server round-trip. On: we clone the
// article's main content (reusing _readerMainContent so TTS and Reader View agree
// on what "the article" is), strip the ZIM's chrome (navboxes, infoboxes, edit
// links, TOC), and swap the frame body for a minimal shell themed via CSS vars
// (dark/light/sepia + serif/sans — see the settings palette). The original body is
// stashed as a detached node so Off restores it byte-for-byte. `_readerViewOn` is
// the live on/off state (module var, reapplied on every frame.onload — sticky
// across in-ZIM navigation); the palette settings (theme/family/size/AUTO) persist
// in localStorage. AUTO opens every eligible article straight into Reader View.
var _readerViewOn = false;
var READER_VIEW_MIN_CHARS = 200; // extraction floor: below this we treat the page as un-readerable
var _READER_VIEW_STYLE_ID = 'zimi-reader-style';
var _READER_VIEW_STASH = '__zimiReaderStash'; // property name on the frame document
// Tap-to-full-size lightbox (inside the reader iframe). An image is "zoomable"
// only when its natural width exceeds its displayed width by more than this slop
// (px) — i.e. it was actually scaled down and there's more detail to reveal.
var _READER_LIGHTBOX_CLASS = 'zimi-img-lightbox';
var _READER_LIGHTBOX_SLOP = 2;
// Full-bleed lightbox overlay chrome — the scrim, the pan/zoom image, and the
// close button. Shared VERBATIM by Reader View (_readerViewInjectStyle) and the
// normal article frame (_bindNormalReaderLightbox); only the zoom-in cursor /
// focus-ring rule differs per context, so it's added at each call site. Defined
// once here so the two hosts can never drift.
var _READER_LIGHTBOX_OVERLAY_CSS = [
  '.' + _READER_LIGHTBOX_CLASS + '{position:fixed;inset:0;z-index:2147483000;',
    'background:rgba(0,0,0,0.9);overflow:auto;display:flex;cursor:zoom-out;',
    '-webkit-overflow-scrolling:touch;overscroll-behavior:contain}',
  '.' + _READER_LIGHTBOX_CLASS + ' .zimi-lightbox-img{margin:auto;display:block;',
    'max-width:none !important;max-height:none !important;height:auto !important;',
    'width:auto !important;border-radius:0;cursor:zoom-out}',
  '.zimi-lightbox-close{position:fixed;top:12px;right:14px;width:40px;height:40px;',
    'border-radius:50%;border:none;background:rgba(0,0,0,0.55);color:#fff;',
    'font-size:20px;line-height:1;cursor:pointer;display:flex;align-items:center;',
    'justify-content:center;z-index:1;-webkit-backdrop-filter:blur(6px);',
    'backdrop-filter:blur(6px)}',
  '.zimi-lightbox-close:hover,.zimi-lightbox-close:focus-visible{background:rgba(0,0,0,0.8);outline:2px solid #fff}'
].join('');
// Chrome that Reader View drops. Wikipedia/MediaWiki-heavy; harmless no-ops on
// other ZIM DOMs (stackexchange/devdocs) whose main element is already clean.
var _READER_VIEW_STRIP = [
  'script', 'style', 'link', 'noscript',
  '.mw-editsection', '.navbox', '.vertical-navbox', '.navbox-inner',
  '.noprint', '.mw-jump-link', '.infobox', '.metadata', '.ambox', '.mbox-small',
  '.sistersitebox', '.sidebar', '.side-box', '.hatnote', '.shortdescription',
  '.printfooter', '.catlinks', '.mw-hidden-catlinks', '#toc', '.toc',
  '.mw-empty-elt', '.mw-editsection-like'
].join(',');
// Layout props that force a nested inner scroller; stripped from clone inline
// styles and overridden (scoped) in the reader shell CSS. Kept in one place so
// the inline-strip and the CSS rule can't drift apart.
var _READER_CONSTRAIN_PROPS = ['height', 'max-height', 'min-height', 'overflow', 'overflow-x', 'overflow-y'];
// Book-open glyph shared by the desktop button and the mobile ... menu row.
var _READER_VIEW_ICON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
var _RV_PRINT_ICON = '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>';
var _RV_SHARE_ICON = '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

function _readerFrameDoc() {
  var frame = document.getElementById('reader-frame');
  var doc = null;
  try { doc = frame && frame.contentDocument; } catch(e) { doc = null; }
  return doc;
}

// ── Reader View settings (persisted palette) ──
var READER_FAMILIES = ['serif', 'sans'];
// Concrete palettes the reader body can paint (rv-theme-* classes / bg map).
var READER_THEMES = ['dark', 'light', 'sepia'];
// User-selectable modes in the picker. 'auto' follows the app theme: dark→dark,
// light→SEPIA (a warm paper tone reads better out of the box than raw white).
// A user's explicit pick (dark/light/sepia) always wins and persists. Stored
// value is the MODE; _readerTheme() resolves it to a palette.
var READER_THEME_MODES = ['auto', 'dark', 'light', 'sepia'];
// The <body> background each theme paints — mirrors --rv-bg in the injected CSS.
// Used to tint the iframe/loading chrome so AUTO mode never flashes ZIM-white.
var READER_THEME_BG = { dark: '#0a0a0b', light: '#fbfbf9', sepia: '#f4ecd8' };
function _readerFamily() {
  var v = localStorage.getItem(SK.READER_FAMILY);
  return READER_FAMILIES.indexOf(v) >= 0 ? v : 'serif';
}
// The stored picker selection: 'auto' (default) | 'dark' | 'light' | 'sepia'.
function _readerThemeMode() {
  var v = localStorage.getItem(SK.READER_THEME);
  return READER_THEME_MODES.indexOf(v) >= 0 ? v : 'auto';
}
// The concrete palette actually painted. Auto resolves a dark app to 'dark' (the
// reader matches the surrounding chrome) and a light app to 'sepia' (warm paper
// out of the box, rather than a stark white page).
function _readerTheme() {
  var m = _readerThemeMode();
  if (m === 'auto') return _appThemeIsDark() ? 'dark' : 'sepia';
  return READER_THEMES.indexOf(m) >= 0 ? m : 'dark';
}
function _readerAuto() { return _getStorageFlag(SK.READER_AUTO); }
function _readerThemeBg() { return READER_THEME_BG[_readerTheme()] || READER_THEME_BG.dark; }

// Stamp the current theme + family onto the reader body as rv-theme-*/rv-font-*
// classes so the injected CSS var palettes take effect. Safe to call on any doc.
function _applyReaderTheme(doc) {
  if (!doc || !doc.body) return;
  var cl = doc.body.classList;
  READER_THEMES.forEach(function(th) { cl.remove('rv-theme-' + th); });
  READER_FAMILIES.forEach(function(fm) { cl.remove('rv-font-' + fm); });
  cl.add('rv-theme-' + _readerTheme());
  cl.add('rv-font-' + _readerFamily());
}

// Is Reader View offer-able for whatever is currently in the frame? False for
// pdf.js viewer pages, zimgit catalogs, and any doc whose main content is too
// thin to be worth re-rendering (guards against a broken half-render).
function _readerViewAvailable() {
  if (!readerOpen || _almanacOpen) return false;
  var frame = document.getElementById('reader-frame');
  var doc = _readerFrameDoc();
  if (!doc || !doc.body) return false;
  var loc = '';
  try { loc = frame.contentWindow.location.pathname; } catch(e) { return false; }
  if (loc.indexOf('/static/') === 0) return false; // pdf.js / other static viewers
  // When already applied, the stash proves it was readerable — keep it offered.
  if (doc[_READER_VIEW_STASH]) return true;
  var main = _readerMainContent(doc);
  if (!main || main === doc.body) return false;
  var len = (main.innerText || main.textContent || '').trim().length;
  return len >= READER_VIEW_MIN_CHARS;
}

function _readerViewTitle(doc) {
  var el = null;
  try { el = doc.querySelector('#firstHeading, .mw-first-heading, h1, .title'); } catch(e) {}
  var txt = el && (el.innerText || el.textContent || '').trim();
  if (txt) return txt;
  return (doc.title || '').trim();
}

// Strip chrome and make tables horizontally scrollable inside the CLONE only —
// the live document is untouched until the caller swaps it in.
function _readerViewClean(root, doc) {
  try {
    var junk = root.querySelectorAll(_READER_VIEW_STRIP);
    for (var i = 0; i < junk.length; i++) {
      if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
    }
  } catch(e) {}
  // Neutralize INLINE layout constraints that would make the clone a fixed-height
  // inner scroller inside the reader column (the devdocs-class bug: a main element
  // sized `height:100%;overflow:scroll`). Class-based constraints from the ZIM's
  // own stylesheet — still live in the iframe head — are handled by the reader
  // shell CSS override in _readerViewInjectStyle; this only clears style="" props.
  try {
    var constrained = [root].concat(Array.prototype.slice.call(root.querySelectorAll('[style]')));
    for (var s = 0; s < constrained.length; s++) {
      var st = constrained[s].style;
      if (!st) continue;
      _READER_CONSTRAIN_PROPS.forEach(function(p) { try { st.removeProperty(p); } catch(e) {} });
    }
  } catch(e) {}
  // Wrap wide tables so they scroll rather than blow out the reading column.
  try {
    var tables = root.querySelectorAll('table');
    for (var j = 0; j < tables.length; j++) {
      var tbl = tables[j];
      if (tbl.parentNode && tbl.parentNode.classList &&
          tbl.parentNode.classList.contains('zimi-table-wrap')) continue;
      var wrap = doc.createElement('div');
      wrap.className = 'zimi-table-wrap';
      tbl.parentNode.insertBefore(wrap, tbl);
      wrap.appendChild(tbl);
    }
  } catch(e) {}
  // Flatten MediaWiki CSS-crop thumbnails. A "cropped" lead image clips a large
  // source to a small window via an ancestor's overflow:hidden plus an inner
  // wrapper positioned with a NEGATIVE offset. Reader View forces
  // overflow:visible on every descendant (to kill devdocs-style inner
  // scrollers), which defeats the clip and lets the full-size image blow past
  // the column's right edge. Detect the crop by its tell — a negative top/left
  // inline offset — and un-crop it so the whole image flows and caps at the
  // column width (aspect preserved). Bare/figure images have no such wrapper, so
  // normal-size images are untouched.
  try {
    var negOffset = /(?:^|;)\s*(?:top|left)\s*:\s*-/i;
    var styled = root.querySelectorAll('[style]');
    for (var c = 0; c < styled.length; c++) {
      var crop = styled[c];
      if (!negOffset.test(crop.getAttribute('style') || '')) continue;
      ['position', 'top', 'left', 'width', 'height', 'max-width'].forEach(function(p) {
        try { crop.style.removeProperty(p); } catch(e) {}
      });
      crop.style.maxWidth = '100%';
      // Free the fixed widths on the crop's wrapper chain (.thumbimage /
      // .thumbinner / .noresize carry inline px widths that would still pin the
      // image), stopping at the reading root.
      var anc = crop.parentNode, hops = 0;
      while (anc && anc !== root && anc.nodeType === 1 && hops < 4) {
        if (anc.style && (anc.style.width || /(?:thumb|noresize)/.test(anc.className || ''))) {
          try { anc.style.removeProperty('width'); anc.style.removeProperty('height'); } catch(e) {}
          anc.style.maxWidth = '100%';
        }
        anc = anc.parentNode; hops++;
      }
      // The image itself carries width=/height= attrs sized to the FULL source —
      // clear them so it scales down to the column instead of overflowing.
      var cimgs = crop.querySelectorAll('img');
      for (var ci = 0; ci < cimgs.length; ci++) {
        cimgs[ci].removeAttribute('width');
        cimgs[ci].removeAttribute('height');
        cimgs[ci].style.width = 'auto';
        cimgs[ci].style.maxWidth = '100%';
        cimgs[ci].style.height = 'auto';
      }
    }
  } catch(e) {}
}

function _readerViewInjectStyle(doc) {
  if (doc.getElementById(_READER_VIEW_STYLE_ID)) return;
  // Themes/fonts are driven by CSS custom properties set on `body.zimi-reader-active`
  // and swapped by the rv-theme-*/rv-font-* body classes (_applyReaderTheme). The
  // iframe can't see the parent's variables, so the palettes are defined here.
  // Light + sepia are designed as first-class palettes (not inverted dark) with
  // WCAG-AA link/text contrast. Body font follows --rv-font (Serif/Sans toggle);
  // headings stay in the system-sans stack in every theme — the classic reader
  // signal and a stable hierarchy cue.
  var css = [
    // ── Theme variable palettes (defaults = dark) ──
    'body.zimi-reader-active{--rv-bg:#0a0a0b;--rv-fg:#e8e8ed;--rv-head:#f5f5f7;',
      '--rv-muted:#8a8a94;--rv-border:#27272b;--rv-link:#f59e0b;--rv-code:#1c1c20;',
      '--rv-pre:#141416;--rv-th:#1c1c20;',
      '--rv-font:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;',
      'background:var(--rv-bg) !important;margin:0 !important}',
    'body.zimi-reader-active.rv-font-sans{--rv-font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    'body.zimi-reader-active.rv-theme-light{--rv-bg:#fbfbf9;--rv-fg:#1f1f22;--rv-head:#0a0a0b;',
      '--rv-muted:#63636b;--rv-border:#e3e2dd;--rv-link:#aa4e08;--rv-code:#f0efe9;',
      '--rv-pre:#f5f4ee;--rv-th:#f0efe9}',
    'body.zimi-reader-active.rv-theme-sepia{--rv-bg:#f4ecd8;--rv-fg:#463a28;--rv-head:#2b2010;',
      '--rv-muted:#736341;--rv-border:#e0d4b4;--rv-link:#8f4d12;--rv-code:#ece0c2;',
      '--rv-pre:#efe6cb;--rv-th:#ece0c2}',
    // ── Shell ──
    // overflow-x:hidden is the belt-and-suspenders clip for wide media (e.g.
    // wikivoyage's 2000px region maps): the img/figure/video rule below already
    // caps them at 100%, and the only descendants that legitimately overflow —
    // .zimi-table-wrap and <pre> — carry their OWN overflow-x:auto, so they
    // scroll inside their box rather than pushing the shell. Clipping here can
    // never eat their scroll.
    '.zimi-reader{background:var(--rv-bg);color:var(--rv-fg);min-height:100vh;box-sizing:border-box;',
      'padding:24px 20px 96px;font-family:var(--rv-font);overflow-x:hidden;max-width:100%;',
      'font-size:19px;line-height:1.65;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
    // Kill class-based fixed-height / inner-scroll constraints the ZIM's own
    // stylesheet (still live in the iframe head) imposes on the cloned content —
    // e.g. devdocs' `._content{height:100%;overflow-y:scroll}`, which otherwise
    // renders as a nested scrollbar + empty region inside the reader column.
    // Scoped OFF the table wrapper and <pre> so their intentional horizontal
    // scroll survives; the shell itself keeps its min-height:100vh (not a descendant).
    '.zimi-reader *:not(.zimi-table-wrap):not(pre){height:auto !important;max-height:none !important;',
      'min-height:0 !important;overflow:visible !important}',
    '.zimi-reader-body{max-width:68ch;margin:0 auto}',
    // Headings follow the reader's font-family choice (serif/sans) like the body,
    // via --rv-font — a serif pick that left headings sans looked half-applied.
    '.zimi-reader h1,.zimi-reader h2,.zimi-reader h3,.zimi-reader h4,.zimi-reader h5,.zimi-reader h6{',
      'font-family:var(--rv-font);line-height:1.25;',
      'color:var(--rv-head);font-weight:700;margin:1.6em 0 0.5em}',
    // Title needs the h1-qualified selector to out-specify the heading rule above —
    // otherwise its `margin:1.6em 0 0.5em` (≈61px top) wins and shoves the article
    // down into the "dead space" this release removes.
    '.zimi-reader h1.zimi-reader-title{font-size:2em;margin:0 0 0.7em;line-height:1.2;',
      'border-bottom:1px solid var(--rv-border);padding-bottom:0.35em}',
    '.zimi-reader h2{font-size:1.5em;border-bottom:1px solid var(--rv-border);padding-bottom:0.2em}',
    '.zimi-reader h3{font-size:1.25em}.zimi-reader h4{font-size:1.1em}',
    '.zimi-reader p{margin:0 0 1.1em}',
    '.zimi-reader a{color:var(--rv-link);text-decoration:none}',
    '.zimi-reader a:hover{text-decoration:underline}',
    // Strictly contain wide media. !important out-specifies any width the ZIM's
    // own (still-live) stylesheet or presentational width= attribute imposes.
    '.zimi-reader img,.zimi-reader figure,.zimi-reader video,.zimi-reader svg,.zimi-reader canvas,.zimi-reader iframe{',
      'max-width:100% !important;height:auto}',
    '.zimi-reader img{border-radius:6px;margin:0.4em 0;display:block}',
    // Tap-to-full-size: only images whose source is larger than the scaled-down
    // display get the affordance (class added by _readerMarkImage). zoom-in cue +
    // a subtle focus ring so keyboard users can see the target.
    '.zimi-reader img.zimi-zoomable{cursor:zoom-in}',
    '.zimi-reader img.zimi-zoomable:focus-visible{outline:2px solid var(--rv-link);outline-offset:3px}',
    // Full-bleed lightbox chrome (scrim + pan/zoom image + close button): the
    // scrim is itself the scroll container (overflow:auto) so a larger-than-
    // viewport image PANS on both axes via native scroll (drag/trackpad on
    // desktop, swipe on touch). margin:auto on the image — NOT flex centering —
    // so it centers when small yet never clips its top/left edge when it
    // overflows. Shared with the normal reader frame; see the constant above.
    _READER_LIGHTBOX_OVERLAY_CSS,
    '.zimi-reader figure{margin:1.3em auto}',
    // Caption legibility: mwoffliner ships two markup generations — Parsoid
    // (<figure typeof>/<figcaption>, background-color:inherit from a hardcoded
    // #f9f9f9 painted on the figure) and legacy (.thumb>.thumbinner>.thumbcaption,
    // no explicit color of its own). Either shape can carry a caption box
    // color/background baked into the ZIM's own (still-live, see head comment
    // above) stylesheet that has no idea which reader theme is active — it reads
    // fine in the ZIM's native page but can land as illegible (e.g. dark text on
    // a dark strip) once our light/dark/sepia palette is layered on top.
    // !important forces both shapes onto the theme's own muted-text/no-fill
    // pair so contrast always matches the active palette, never the source.
    '.zimi-reader figcaption,.zimi-reader .thumbcaption{font-size:0.78em;',
      'color:var(--rv-muted) !important;background:none !important;',
      'font-family:-apple-system,sans-serif;margin-top:0.4em;line-height:1.45}',
    '.zimi-reader figcaption{text-align:center}',
    // Every figure shape, not just the two MediaWiki ones — a warc2zim or
    // devdocs capture emits a bare <figure> with its own fill, and forcing the
    // caption to the theme's muted ink over a fill we left alone is how a
    // legible caption becomes an illegible one.
    '.zimi-reader .thumb,.zimi-reader .thumbinner,.zimi-reader figure{',
      'background:none !important;border-color:var(--rv-border) !important}',
    '.zimi-reader ul,.zimi-reader ol{margin:0 0 1.1em 1.4em}',
    '.zimi-reader li{margin:0.3em 0}',
    '.zimi-reader blockquote{border-left:3px solid var(--rv-border);margin:1.3em 0;padding-left:1em;color:var(--rv-muted)}',
    '.zimi-reader hr{border:none;border-top:1px solid var(--rv-border);margin:2em 0}',
    '.zimi-reader sup,.zimi-reader sub{font-size:0.75em}',
    '.zimi-reader pre,.zimi-reader code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '.zimi-reader pre{background:var(--rv-pre);border:1px solid var(--rv-border);border-radius:8px;padding:14px;',
      'overflow-x:auto;font-size:0.82em;line-height:1.5}',
    '.zimi-reader code{background:var(--rv-code);padding:0.1em 0.4em;border-radius:4px;font-size:0.86em}',
    '.zimi-reader pre code{background:none;padding:0;font-size:1em}',
    '.zimi-table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:1.3em 0;max-width:100%}',
    '.zimi-reader table{border-collapse:collapse;font-family:-apple-system,sans-serif;font-size:0.84em}',
    '.zimi-reader th,.zimi-reader td{border:1px solid var(--rv-border);padding:6px 10px;text-align:left;vertical-align:top}',
    '.zimi-reader th{background:var(--rv-th);color:var(--rv-head);font-weight:600}',
    // ── Print / Save as PDF ──
    // The palette's Print row calls frame.contentWindow.print(), so only THIS
    // iframe document prints. Force a clean sheet independent of the on-screen
    // theme: white page, black text, links de-styled to plain text, media
    // contained, and break-avoid hints so figures/tables/code don't split across
    // pages. Any open lightbox scrim is hidden so it can't paint over the page.
    '@media print{',
      'html,body.zimi-reader-active{background:#fff !important}',
      'body.zimi-reader-active,body.zimi-reader-active.rv-theme-light,body.zimi-reader-active.rv-theme-sepia{',
        '--rv-bg:#fff;--rv-fg:#000;--rv-head:#000;--rv-muted:#333;--rv-border:#bbb;',
        '--rv-link:#000;--rv-code:#f2f2f2;--rv-pre:#f7f7f7;--rv-th:#eee}',
      '.zimi-reader{color:#000 !important;background:#fff !important;padding:0 !important;',
        'font-size:12pt;max-width:100%}',
      '.zimi-reader a{color:#000 !important;text-decoration:none}',
      '.zimi-reader img,.zimi-reader figure,.zimi-reader svg,.zimi-reader table,.zimi-reader pre,',
        '.zimi-reader blockquote{page-break-inside:avoid;break-inside:avoid;max-width:100% !important}',
      '.zimi-reader h1,.zimi-reader h2,.zimi-reader h3{page-break-after:avoid;break-after:avoid}',
      '.' + _READER_LIGHTBOX_CLASS + ',.zimi-lightbox-close{display:none !important}',
    '}'
  ].join('');
  var style = doc.createElement('style');
  style.id = _READER_VIEW_STYLE_ID;
  style.textContent = css;
  (doc.head || doc.documentElement).appendChild(style);
}

// ── Reader View image lightbox ──
// True when the image was scaled down (source has more detail than shown), so a
// full-size view is worth offering. naturalWidth is 0 until the image loads —
// callers re-check on the load event.
function _readerImgZoomable(img) {
  if (!img || img.tagName !== 'IMG') return false;
  var nw = img.naturalWidth || 0;
  var cw = img.clientWidth || 0;
  return nw > 0 && cw > 0 && nw > cw + _READER_LIGHTBOX_SLOP;
}
// True when an anchor points at an image FILE rather than an article — its <img>
// child should open the lightbox, not navigate. Covers image extensions, the
// ZIM's _assets_/ media path, and MediaWiki's file-link classes.
function _isImageFileLink(a) {
  if (!a) return false;
  var href = a.getAttribute('href') || '';
  if (/\.(jpe?g|png|gif|svg|webp|avif|bmp)(?:[?#]|$)/i.test(href)) return true;
  if (/(?:^|\/)_assets_\//.test(href)) return true;
  var cls = ' ' + (a.className || '') + ' ';
  return / (?:image|mw-file-description) /.test(cls);
}
// Lightbox-eligible in the NORMAL reader frame: zoomable AND its click otherwise
// does nothing. A bare image, or one wrapped in a file/image link, qualifies; an
// image wrapped in an anchor that navigates to an article does NOT (that anchor
// must keep navigating).
function _readerImgLightboxable(img) {
  if (!_readerImgZoomable(img)) return false;
  var a = img.closest ? img.closest('a[href]') : null;
  if (a && !_isImageFileLink(a)) return false;
  return true;
}
// Add/remove the affordance on a single image: zoomable images become focusable
// button-role targets (Enter/Space + tap open the lightbox). Idempotent.
function _readerMarkImage(img) {
  if (!img || img.tagName !== 'IMG') return;
  if (_readerImgZoomable(img)) {
    if (img.classList.contains('zimi-zoomable')) return;
    img.classList.add('zimi-zoomable');
    img.setAttribute('tabindex', '0');
    img.setAttribute('role', 'button');
    var label = t('reader_full_size');
    img.setAttribute('aria-label', img.alt ? (img.alt + ' — ' + label) : label);
  } else if (img.classList.contains('zimi-zoomable')) {
    img.classList.remove('zimi-zoomable');
    img.removeAttribute('tabindex');
    img.removeAttribute('role');
    img.removeAttribute('aria-label');
  }
}
// Mark every image in the freshly-built shell. Already-loaded images resolve
// synchronously; the delegated capture 'load' listener (bound in
// _readerBindLightbox) handles those that finish later.
function _readerMarkImages(shell) {
  if (!shell) return;
  var imgs = shell.querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) _readerMarkImage(imgs[i]);
}
// Open the full-bleed pan/zoom overlay for one image. Appended to the shell so it
// inherits the reader theme context; the scrim is opaque enough to read over any
// theme (dark/light/sepia). Focus is trapped on the close button and restored to
// the originating image on close.
function _readerOpenLightbox(img) {
  var doc = img && img.ownerDocument;
  if (!doc || !doc.body) return;
  if (doc.querySelector('.' + _READER_LIGHTBOX_CLASS)) return; // never stack
  var overlay = doc.createElement('div');
  overlay.className = _READER_LIGHTBOX_CLASS;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', img.alt || t('reader_full_size'));
  // Body carries the font-zoom (`zoom`) — neutralize it here so the overlay is a
  // true viewport cover and the image shows at real natural pixels, not zoom×natural.
  var lvl = _readerFontLevel();
  if (lvl !== READER_FONT_DEFAULT) overlay.style.zoom = String(100 / lvl);

  var full = doc.createElement('img');
  full.className = 'zimi-lightbox-img';
  full.src = img.currentSrc || img.src;
  if (img.alt) full.alt = img.alt;

  var closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'zimi-lightbox-close';
  closeBtn.setAttribute('aria-label', t('close'));
  closeBtn.innerHTML = '✕';

  overlay.appendChild(full);
  overlay.appendChild(closeBtn);

  function onKey(e) {
    var k = e.key;
    if (k === 'Escape' || e.keyCode === 27) { e.preventDefault(); close(); return; }
    // Focus trap: the close button is the only tab stop while the overlay is open.
    if (k === 'Tab') { e.preventDefault(); closeBtn.focus(); }
  }
  function close() {
    doc.removeEventListener('keydown', onKey, true);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    try { img.focus(); } catch(e) {} // return focus to the trigger
  }
  // Tap anywhere (scrim or image) closes; a drag scrolls (pan) and fires no click.
  overlay.addEventListener('click', function() { close(); });
  doc.addEventListener('keydown', onKey, true);
  doc.body.appendChild(overlay);
  try { overlay.scrollTop = 0; overlay.scrollLeft = 0; } catch(e) {}
  try { closeBtn.focus(); } catch(e) {}
}
// Bind the delegated listeners ONCE per shell (guarded by a flag so re-entrant
// applies can't double-bind). Delegation on the shell survives in-place mutations
// and covers every current/future descendant image without per-image wiring.
function _readerBindLightbox(shell, doc) {
  if (!shell || shell.__zimiLightboxBound) return;
  shell.__zimiLightboxBound = true;
  shell.addEventListener('click', function(e) {
    var img = e.target && e.target.closest ? e.target.closest('img') : null;
    if (!img || !shell.contains(img)) return;
    if (!_readerImgZoomable(img)) return; // authoritative check at tap time
    e.preventDefault();
    _readerOpenLightbox(img);
  });
  shell.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('zimi-zoomable')) return;
    e.preventDefault();
    _readerOpenLightbox(img);
  });
  // load doesn't bubble — capture it to mark images that decode after apply.
  shell.addEventListener('load', function(e) {
    if (e.target && e.target.tagName === 'IMG') _readerMarkImage(e.target);
  }, true);
  _readerMarkImages(shell);
}

// ── Video resume ───────────────────────────────────────────────────────
// Remember where the viewer stopped in each video (TED/Khan talks, any ZIM
// with an HTML5 <video>) and pick up there next time. Keyed by zim+path+index
// so a page with several clips tracks each independently. The ledger is a
// single localStorage object, trimmed to the most-recent _VIDEO_RESUME_MAX.
var _VIDEO_RESUME_MAX = 100;    // ledger cap (oldest evicted first)
var _VIDEO_RESUME_MIN = 5;      // seconds — below this, not worth resuming
var _VIDEO_RESUME_DONE = 0.95;  // ≥95% watched → treat as finished, drop it
var _VIDEO_RESUME_THROTTLE = 5000; // ms between timeupdate writes
function _videoResumeKey(zim, path, i) { return zim + '\n' + path + '#' + i; }
function _videoResumeTrim(led) {
  var keys = Object.keys(led);
  if (keys.length <= _VIDEO_RESUME_MAX) return;
  keys.sort(function(a, b) { return (led[a].ts || 0) - (led[b].ts || 0); });
  for (var i = 0; i < keys.length - _VIDEO_RESUME_MAX; i++) delete led[keys[i]];
}
function _bindVideoResume(frame, zim, path) {
  var doc; try { doc = frame.contentDocument; } catch(e) { return; }
  if (!doc || !zim || !path) return;
  var vids = doc.querySelectorAll('video');
  for (var i = 0; i < vids.length; i++) (function(v, idx) {
    if (v.__zimiResume) return;
    v.__zimiResume = true;
    var key = _videoResumeKey(zim, path, idx);
    var restore = function() {
      var led = _getStorageJSON(SK.VIDEO_RESUME, {}) || {};
      var rec = led[key];
      // Skip if we'd land within a second of the end — nothing left to watch.
      if (rec && rec.t > _VIDEO_RESUME_MIN && (!v.duration || rec.t < v.duration - 1)) {
        try { v.currentTime = rec.t; } catch(e) {}
      }
    };
    if (v.readyState >= 1) restore();
    else v.addEventListener('loadedmetadata', restore, { once: true });
    var last = 0;
    v.addEventListener('timeupdate', function() {
      var now = Date.now();
      if (now - last < _VIDEO_RESUME_THROTTLE) return;
      last = now;
      var d = v.duration || 0, tt = v.currentTime || 0;
      var led = _getStorageJSON(SK.VIDEO_RESUME, {}) || {};
      if (d && tt / d >= _VIDEO_RESUME_DONE) { delete led[key]; }
      else if (tt > _VIDEO_RESUME_MIN) { led[key] = { t: tt, d: d, ts: now }; }
      else return;
      _videoResumeTrim(led);
      _setStorageJSON(SK.VIDEO_RESUME, led);
    });
    // Watched to the end → clear so a rewatch starts clean.
    v.addEventListener('ended', function() {
      var led = _getStorageJSON(SK.VIDEO_RESUME, {}) || {};
      if (led[key]) { delete led[key]; _setStorageJSON(SK.VIDEO_RESUME, led); }
    });
  })(vids[i], i);
}

// Graceful "video not included in this ZIM" affordance. Broken-scrape ZIMs
// (e.g. ted_en_technology) render an article whose <video> points at a 0-byte /
// missing media entry — the player just sits dead. On a GENUINE load/decode
// failure we swap the dead player for a small centered message. "Genuine" =
// the element carries a MediaError (v.error) or has exhausted every <source>
// with none playable (networkState === NETWORK_NO_SOURCE). A healthy video mid-
// load is networkState LOADING with error === null, so it never trips this.
// The box uses neutral grey tones + color:inherit so it reads correctly whether
// the app is light, dark, or the raw page is running under the auto-dark invert.
function _bindVideoError(frame) {
  var doc; try { doc = frame.contentDocument; } catch(e) { return; }
  if (!doc) return;
  var vids = doc.querySelectorAll('video');
  for (var i = 0; i < vids.length; i++) (function(v) {
    if (v.__zimiErrBound) return;
    v.__zimiErrBound = true;
    var shown = false;
    function failed() {
      // NETWORK_NO_SOURCE === 3: browser tried all sources, none playable.
      return !!v.error || v.networkState === 3;
    }
    function show() {
      if (shown || !failed() || !v.parentNode) return;
      shown = true;
      var w = v.offsetWidth || parseInt(v.getAttribute('width'), 10) || 0;
      var h = v.offsetHeight || parseInt(v.getAttribute('height'), 10) || 0;
      var box = doc.createElement('div');
      box.className = 'zimi-video-missing';
      box.setAttribute('role', 'status');
      box.style.cssText = 'display:flex;flex-direction:column;gap:10px;' +
        'align-items:center;justify-content:center;text-align:center;' +
        'box-sizing:border-box;padding:24px 16px;border-radius:8px;' +
        'background:rgba(127,127,127,0.14);border:1px solid rgba(127,127,127,0.35);' +
        'color:inherit;font:500 14px/1.4 system-ui,-apple-system,sans-serif;' +
        'min-height:' + (h > 40 ? h : 160) + 'px;' +
        (w > 40 ? 'max-width:' + w + 'px;' : '') + 'width:100%;';
      box.innerHTML = '<svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" ' +
        'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
        'stroke-linejoin="round" style="opacity:.7"><path d="m23 7-7 5 7 5V7z"/>' +
        '<rect x="1" y="5" width="15" height="14" rx="2" ry="2"/><line x1="2" y1="2" x2="22" y2="22"/></svg>' +
        '<span></span>';
      box.lastChild.textContent = t('video_not_included');
      v.parentNode.insertBefore(box, v);
      v.style.display = 'none';
      v.__zimiErrBox = box;
    }
    function recover() {
      // NETWORK_NO_SOURCE was not a final verdict: on a page whose own JS
      // attaches sources late (an alive-engine capture of apple.com does),
      // the video can come good AFTER the overlay went up. A real error
      // never fires loadeddata, so this only ever unwinds false alarms.
      if (!shown || !v.__zimiErrBox) return;
      if (v.__zimiErrBox.parentNode) v.__zimiErrBox.parentNode.removeChild(v.__zimiErrBox);
      v.__zimiErrBox = null;
      v.style.display = '';
      shown = false;
    }
    // Capture so a failing <source> child's error (which doesn't bubble) is seen.
    v.addEventListener('error', show, true);
    v.addEventListener('stalled', show);
    v.addEventListener('emptied', show);
    v.addEventListener('loadeddata', recover);
    v.addEventListener('canplay', recover);
    // Catch sources that already resolved to nothing before we bound — but a
    // no-source state gets a second look before it is believed: scripts that
    // build their <source> list at runtime are legitimate, not broken.
    if (v.error) show();
    else setTimeout(function () {
      if (v.error) { show(); return; }
      if (v.networkState === 3) setTimeout(show, 1500);
    }, 1500);
  })(vids[i]);
}

// Bind the tap-to-full-size lightbox to the NORMAL (non-Reader-View) article
// frame, reusing the Reader View overlay + open/mark helpers. Two differences
// from the Reader View binding: eligibility also excludes article-navigating
// anchors (_readerImgLightboxable), and the listeners live on the DOCUMENT with
// capture so they run BEFORE the frame's link interceptor — a file/image-link-
// wrapped thumbnail opens the lightbox instead of navigating. Bound once per
// document (fresh each article load); it self-skips while Reader View owns the
// body, since that shell carries its own binding.
function _bindNormalReaderLightbox(frame) {
  var doc = frame.contentDocument;
  if (!doc || !doc.body) return;
  var body = doc.body;
  if (!doc.getElementById('zimi-normal-lightbox-css')) {
    var style = doc.createElement('style');
    style.id = 'zimi-normal-lightbox-css';
    // Overlay chrome (shared) + the zoom-in cursor / focus ring, unscoped since
    // there's no .zimi-reader wrapper here. Amber focus ring matches the app.
    style.textContent = _READER_LIGHTBOX_OVERLAY_CSS +
      'img.zimi-zoomable{cursor:zoom-in}' +
      'img.zimi-zoomable:focus-visible{outline:2px solid #f59e0b;outline-offset:3px}';
    (doc.head || doc.documentElement).appendChild(style);
  }
  var active = function() { return body.classList.contains('zimi-reader-active'); };
  var mark = function(img) { if (!active() && _readerImgLightboxable(img)) _readerMarkImage(img); };
  if (!doc.__zimiNormalLightbox) {
    doc.__zimiNormalLightbox = true;
    doc.addEventListener('click', function(e) {
      if (active()) return; // Reader View shell owns clicks in reader mode
      var img = e.target && e.target.closest ? e.target.closest('img') : null;
      if (!img || !_readerImgLightboxable(img)) return;
      e.preventDefault();
      e.stopPropagation(); // beat the link interceptor for file-link-wrapped images
      _readerOpenLightbox(img);
    }, true);
    doc.addEventListener('keydown', function(e) {
      if (active()) return;
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var img = e.target;
      if (!img || img.tagName !== 'IMG' || !img.classList.contains('zimi-zoomable')) return;
      e.preventDefault();
      _readerOpenLightbox(img);
    });
    // load doesn't bubble — capture it on the document to mark lazy images.
    doc.addEventListener('load', function(e) {
      if (e.target && e.target.tagName === 'IMG') mark(e.target);
    }, true);
  }
  var imgs = body.querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) mark(imgs[i]);
}

// Build the shell and swap it in. Returns true on success. All fallible DOM work
// (query, clone, clean) happens BEFORE the live document is mutated, so a failure
// leaves the original page fully intact — never a half-render.
function _readerViewApply(doc) {
  if (!doc || !doc.body) return false;
  if (doc[_READER_VIEW_STASH]) return true; // already applied to this document
  var main = _readerMainContent(doc);
  if (!main || main === doc.body) return false;
  var text = (main.innerText || main.textContent || '').trim();
  if (text.length < READER_VIEW_MIN_CHARS) return false;

  var clone = main.cloneNode(true);
  _readerViewClean(clone, doc);
  var title = _readerViewTitle(doc);
  // Some ZIMs put the article's title <h1> INSIDE the main container; our styled
  // .zimi-reader-title would then double it. Drop the in-content copy when its
  // text matches the title we're about to render.
  if (title) {
    try {
      var dup = clone.querySelector('#firstHeading, .mw-first-heading, h1');
      if (dup && (dup.innerText || dup.textContent || '').trim() === title && dup.parentNode) {
        dup.parentNode.removeChild(dup);
      }
    } catch(e) {}
  }

  var shell = doc.createElement('div');
  shell.className = 'zimi-reader';
  var article = doc.createElement('article');
  article.className = 'zimi-reader-body';
  if (title) {
    var h1 = doc.createElement('h1');
    h1.className = 'zimi-reader-title';
    h1.textContent = title;
    article.appendChild(h1);
  }
  article.appendChild(clone);
  shell.appendChild(article);

  _readerViewInjectStyle(doc);
  // Swap: stash every existing body child (detached, order-preserving) then show
  // the shell. Document-level listeners (link interception) live on the document,
  // not the body, so they keep working on the cloned content.
  var stash = doc.createElement('div');
  while (doc.body.firstChild) stash.appendChild(doc.body.firstChild);
  doc[_READER_VIEW_STASH] = stash;
  doc.body.appendChild(shell);
  doc.body.classList.add('zimi-reader-active');
  _applyReaderTheme(doc); // stamp theme + family classes → CSS var palette
  try { doc.defaultView.scrollTo(0, 0); } catch(e) {}
  _applyReaderFont(doc); // font zoom composes over the shell
  _readerBindLightbox(shell, doc); // tap-to-full-size on scaled-down images
  return true;
}

function _readerViewRestore(doc) {
  if (!doc || !doc[_READER_VIEW_STASH]) return;
  var shell = doc.querySelector('.zimi-reader');
  if (shell && shell.parentNode) shell.parentNode.removeChild(shell);
  var stash = doc[_READER_VIEW_STASH];
  while (stash.firstChild) doc.body.appendChild(stash.firstChild);
  doc[_READER_VIEW_STASH] = null;
  doc.body.classList.remove('zimi-reader-active');
  READER_THEMES.forEach(function(th) { doc.body.classList.remove('rv-theme-' + th); });
  READER_FAMILIES.forEach(function(fm) { doc.body.classList.remove('rv-font-' + fm); });
  _applyReaderFont(doc);
}

function _readerViewToggle() {
  var doc = _readerFrameDoc();
  if (!doc) return;
  if (_readerViewOn) {
    _readerViewOn = false;
    try { _readerViewRestore(doc); } catch(e) {}
    _closeReaderPalette();
  } else {
    var ok = false;
    try { ok = _readerViewApply(doc); } catch(e) { ok = false; }
    if (!ok) {
      // Extraction failed mid-toggle: undo anything partial and quietly stay off.
      try { _readerViewRestore(doc); } catch(e) {}
      _readerViewOn = false;
      _syncReaderViewBtn();
      return;
    }
    _readerViewOn = true;
  }
  _tintReaderChrome(); // paint (on) or clear (off) the iframe/loading tint
  // Reader View owns its own themes: strip the raw-article dark filter when it
  // turns on (it would invert the reader shell), restore it when it turns off.
  try { _applyArticleDarken(doc); } catch(e) {}
  _ttsStop(); // the visible content changed under any in-progress speech
  _syncReaderViewBtn();
}

// Reflect availability + on/off state onto the desktop button and the ... menu row.
function _syncReaderViewBtn() {
  var avail = _readerViewAvailable();
  var btn = document.getElementById('readerview-btn');
  if (btn) {
    btn.style.display = avail ? 'flex' : 'none';
    btn.setAttribute('aria-pressed', _readerViewOn ? 'true' : 'false');
    // While Reader View is ON the button becomes the settings affordance — the
    // rv-on class paints a small "more" dot so it's discoverable that a second
    // tap opens the palette (rather than exiting the mode).
    btn.classList.toggle('rv-on', _readerViewOn && avail);
  }
  var item = document.getElementById('tbm-readerview');
  if (item) {
    item.setAttribute('aria-checked', _readerViewOn ? 'true' : 'false');
    var sw = item.querySelector('.rv-switch');
    if (sw) sw.classList.toggle('on', _readerViewOn);
  }
  if (!avail) _closeReaderPalette();
  else if (_readerViewOn) _maybeShowReaderCoach();
}

// First time a device lands in Reader View, float a one-shot coachmark by the
// book button — "tap again for reading settings" — so the hidden palette gets
// discovered. Fires at most once (localStorage flag), auto-dismisses after 4s,
// and closes on tap. Covers both manual entry and AUTO mode.
function _maybeShowReaderCoach() {
  if (_getStorageFlag(SK.READER_COACH)) return;
  var btn = document.getElementById('readerview-btn');
  if (!btn || btn.style.display === 'none') return;
  // Only meaningful where the book button is actually on screen (desktop). On
  // mobile the button is CSS-hidden and the reading settings are already
  // top-level inside the ⋯ menu, so the "tap again" hint is redundant — skip it
  // (offsetParent is null / zero-size when hidden by the max-width media query).
  if (!btn.offsetParent && !(btn.offsetWidth || btn.offsetHeight)) return;
  try { localStorage.setItem(SK.READER_COACH, '1'); } catch (e) {}
  var tip = document.createElement('div');
  tip.className = 'reader-coach';
  tip.setAttribute('role', 'status');
  tip.textContent = t('reader_settings_hint');
  document.body.appendChild(tip);
  var r = btn.getBoundingClientRect();
  tip.style.top = (r.bottom + 9) + 'px';
  tip.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  requestAnimationFrame(function() { tip.classList.add('visible'); });
  var kill = function() {
    tip.classList.remove('visible');
    setTimeout(function() { if (tip.parentNode) tip.remove(); }, 200);
  };
  var timer = setTimeout(kill, 4000);
  tip.addEventListener('click', function() { clearTimeout(timer); kill(); });
}

// The book button / mobile menu row entry point. OFF → one tap enters Reader View
// (low-friction, Safari-like). ON → the button becomes the settings affordance and
// opens the palette (exit lives as an explicit row inside), so a second topbar
// control isn't needed and an accidental tap never dumps you out of the mode.
function _readerViewButtonAction() {
  if (_readerViewOn) _toggleReaderPalette();
  else _readerViewToggle();
}

// ── Reader View settings palette ──
// Live setters: with Reader View on, theme/family swap via CSS-var class stamping
// (no DOM rebuild) and size composes the existing font zoom. Each persists and
// re-renders the open palette so its active states stay truthful.
function _setReaderFamily(fam) {
  if (READER_FAMILIES.indexOf(fam) < 0) return;
  try { localStorage.setItem(SK.READER_FAMILY, fam); } catch(e) {}
  var doc = _readerFrameDoc(); if (doc && _readerViewOn) _applyReaderTheme(doc);
  _renderReaderPalette();
}
function _setReaderTheme(theme) {
  if (READER_THEME_MODES.indexOf(theme) < 0) return;
  try { localStorage.setItem(SK.READER_THEME, theme); } catch(e) {}
  var doc = _readerFrameDoc(); if (doc && _readerViewOn) _applyReaderTheme(doc);
  // Keep the iframe/chrome tint in step so scroll-past-content shows theme bg.
  _tintReaderChrome();
  _renderReaderPalette();
}
function _stepReaderFont(dir) {
  var idx = READER_FONT_LEVELS.indexOf(_readerFontLevel());
  if (idx < 0) idx = READER_FONT_LEVELS.indexOf(READER_FONT_DEFAULT);
  var next = Math.min(READER_FONT_LEVELS.length - 1, Math.max(0, idx + dir));
  try { localStorage.setItem(SK.READER_FONT, String(READER_FONT_LEVELS[next])); } catch(e) {}
  var doc = _readerFrameDoc();
  try { if (doc) _applyReaderFont(doc); } catch(e) {}
  _syncFontBtnGlyph();
  _renderReaderPalette();
}
// Persist the reader AUTO flag and reflect it live. Shared by the reader
// palette switch and the mirrored checkbox in manage → preferences, so the
// two controls always drive the one localStorage key with identical behavior.
function _setReaderAuto(on) {
  on = !!on;
  try { localStorage.setItem(SK.READER_AUTO, on ? '1' : '0'); } catch(e) {}
  // Turning AUTO on while a readerable article sits in raw view: apply immediately
  // so the toggle has visible effect, not just on the next article.
  if (on && !_readerViewOn && _readerViewAvailable()) _readerViewToggle();
  _renderReaderPalette();
  // Keep the prefs checkbox in sync if it happens to be mounted.
  var cb = document.getElementById('ms-reader-auto');
  if (cb) cb.checked = on;
}
function _toggleReaderAuto() {
  _setReaderAuto(!_readerAuto());
}

// Paint the iframe + loading overlay in the reader theme background. Prevents the
// ZIM's own white paint bleeding at the edges (light/sepia) and, in AUTO mode, is
// the "dark mode unbroken" guard — the gap before Reader View applies shows theme
// bg, never ZIM-white. Reverts to #fff when Reader View is off.
function _tintReaderChrome() {
  var frame = document.getElementById('reader-frame');
  var loading = document.getElementById('reader-loading');
  var bg = (_readerViewOn || _readerAuto()) ? _readerThemeBg() : '';
  if (frame) frame.style.background = bg || '#fff';
  if (loading) loading.style.background = bg || '';
}

var _READER_PALETTE_ID = 'reader-palette';
var _READER_SIZE_LABELS = { 85: 'S', 100: 'M', 115: 'L', 130: 'XL' };
function _readerPaletteHtml() {
  return '<div class="rv-pal-head">' + _READER_VIEW_ICON + '<span>' + tH('reader_view') +
    '</span></div>' + _readerSettingsRowsHtml();
}
// ── Shared Reader-View control builders ──
// One theme swatch / family pill / size stepper, used by BOTH the full desktop
// palette (with row labels + AUTO) and the compact inline block in the ⋯ menu
// (label-less). Defined once so the two hosts can never drift.
function _rvSwatchHtml(key, theme) {
  // 'auto' reuses the app-theme control's already-localized "Auto" label so no
  // new i18n key is needed; the concrete palettes keep their reader_theme_* keys.
  var lbl = tH(key === 'auto' ? 'theme_auto' : 'reader_theme_' + key);
  return '<button type="button" class="rv-swatch rv-sw-' + key + (theme === key ? ' active' : '') +
    '" role="radio" aria-checked="' + (theme === key ? 'true' : 'false') +
    '" title="' + lbl + '" aria-label="' + lbl +
    '" onclick="event.stopPropagation();_setReaderTheme(\'' + key + '\')"><span class="rv-sw-dot"></span>' +
    '<span class="rv-sw-label">' + lbl + '</span></button>';
}
function _rvSwatchesHtml(mode) {
  // `mode` is the stored selection (auto|dark|light|sepia) so the Auto swatch
  // lights up when chosen — not the resolved palette.
  return '<div class="rv-swatches" role="radiogroup" aria-label="' + tH('reader_theme') + '">' +
    _rvSwatchHtml('auto', mode) + _rvSwatchHtml('dark', mode) +
    _rvSwatchHtml('light', mode) + _rvSwatchHtml('sepia', mode) + '</div>';
}
function _rvFamPillHtml(key, fam) {
  return '<button type="button" class="rv-pill' + (fam === key ? ' active' : '') +
    '" role="radio" aria-checked="' + (fam === key ? 'true' : 'false') +
    '" style="font-family:' + (key === 'serif' ? 'Georgia,serif' : '-apple-system,sans-serif') +
    '" onclick="event.stopPropagation();_setReaderFamily(\'' + key + '\')">' + tH('reader_font_' + key) + '</button>';
}
function _rvFamPillsHtml(fam) {
  return '<div class="rv-pills" role="radiogroup" aria-label="' + tH('reader_font_family') + '">' +
    _rvFamPillHtml('serif', fam) + _rvFamPillHtml('sans', fam) + '</div>';
}
function _rvSizeStepperHtml(lvl) {
  var minSize = lvl === READER_FONT_LEVELS[0];
  var maxSize = lvl === READER_FONT_LEVELS[READER_FONT_LEVELS.length - 1];
  return '<div class="rv-size">' +
    '<button type="button" class="rv-size-btn"' + (minSize ? ' disabled' : '') +
      ' aria-label="' + tH('reader_size_smaller') + '" onclick="event.stopPropagation();_stepReaderFont(-1)">A<span class="rv-minus">&minus;</span></button>' +
    '<span class="rv-size-val">' + (_READER_SIZE_LABELS[lvl] || lvl + '%') + '</span>' +
    '<button type="button" class="rv-size-btn"' + (maxSize ? ' disabled' : '') +
      ' aria-label="' + tH('reader_size_larger') + '" onclick="event.stopPropagation();_stepReaderFont(1)">A<span class="rv-plus">+</span></button>' +
    '</div>';
}

// Compact controls for the ⋯ menu when Reader View is on: theme swatches row +
// a combined font-family/size row. No title labels, no AUTO (settings-only now),
// no print/share/exit — just the two everyday controls, sized to fit 390px.
function _readerCompactControlsHtml() {
  return '<div class="rv-compact">' +
    _rvSwatchesHtml(_readerThemeMode()) +
    '<div class="rv-compact-fontrow">' + _rvFamPillsHtml(_readerFamily()) + _rvSizeStepperHtml(_readerFontLevel()) + '</div>' +
  '</div>';
}

// The full settings rows (theme / family / size / AUTO / print / share / exit)
// for the standalone book-button palette (desktop). Kept head-less so the
// palette can wrap it with its own heading.
function _readerSettingsRowsHtml() {
  var fam = _readerFamily(), auto = _readerAuto();
  var lvl = _readerFontLevel();
  var h = '';
  // Theme (swatches keyed off the stored mode so Auto reflects the selection)
  h += '<div class="rv-row"><div class="rv-row-label">' + tH('reader_theme') + '</div>' +
    _rvSwatchesHtml(_readerThemeMode()) + '</div>';
  // Font family
  h += '<div class="rv-row"><div class="rv-row-label">' + tH('reader_font_family') + '</div>' +
    _rvFamPillsHtml(fam) + '</div>';
  // Text size (reuses the persisted zoom levels as A−/A+)
  h += '<div class="rv-row"><div class="rv-row-label">' + tH('reader_text_size') + '</div>' +
    _rvSizeStepperHtml(lvl) + '</div>';
  // AUTO mode
  h += '<button type="button" class="rv-toggle-row" role="switch" aria-checked="' + (auto ? 'true' : 'false') +
    '" onclick="event.stopPropagation();_toggleReaderAuto()">' +
    '<span class="rv-toggle-text"><span class="rv-toggle-title">' + tH('reader_auto') + '</span>' +
    '<span class="rv-toggle-sub">' + tH('reader_auto_hint') + '</span></span>' +
    '<span class="rv-switch' + (auto ? ' on' : '') + '" aria-hidden="true"><span class="rv-knob"></span></span></button>';
  // Print / Save as PDF (+ native Share where supported). Only while Reader View
  // is active: printing the clean reader shell yields a beautiful page (see the
  // @media print rules in _readerViewInjectStyle); printing a raw ZIM page is out
  // of scope. Share rides navigator.share (mobile Safari / Android) — hidden when
  // the platform can't share.
  var canPrint = _readerViewOn && _readerPrintable();
  var canShare = _readerViewOn && typeof navigator !== 'undefined' && !!navigator.share;
  if (canPrint || canShare) {
    h += '<div class="rv-pal-divider" role="separator"></div>';
    if (canPrint) {
      h += '<button type="button" class="rv-action-row" onclick="event.stopPropagation();_closeReaderControls();_readerPrint()">' +
        _RV_PRINT_ICON + '<span>' + tH('reader_print') + '</span></button>';
    }
    if (canShare) {
      h += '<button type="button" class="rv-action-row" onclick="event.stopPropagation();_closeReaderControls();_readerShare()">' +
        _RV_SHARE_ICON + '<span>' + tH('reader_share') + '</span></button>';
    }
  }
  h += '<div class="rv-pal-divider" role="separator"></div>';
  h += '<button type="button" class="rv-exit-row" onclick="_closeReaderControls();_readerViewToggle()">' +
    '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
    tH('reader_exit') + '</button>';
  return h;
}
function _renderReaderPalette() {
  var pal = document.getElementById(_READER_PALETTE_ID);
  if (pal && pal.classList.contains('visible')) pal.innerHTML = _readerPaletteHtml();
  // Keep the compact copy inside the ⋯ menu (mobile) live too, so active states
  // for theme/family/size stay truthful without reopening the menu.
  var inline = document.querySelector('#topbar-menu.visible .tbm-reader-settings');
  if (inline) inline.innerHTML = _readerCompactControlsHtml();
}
// Close whichever reader-controls host is open — the standalone book-button
// palette (desktop) and/or the inline settings section in the ⋯ menu (mobile).
// Both null-check, so calling from either context is safe.
function _closeReaderControls() {
  _closeReaderPalette();
  _closeTopbarMenu();
}
// Print is only offered where window.print() is a real function. Desktop and
// mobile Safari/Chrome all qualify; the row is hidden where it would dead-click.
function _readerPrintable() {
  return typeof window !== 'undefined' && typeof window.print === 'function';
}
var _readerPaletteDetach = null;
function _toggleReaderPalette() {
  var pal = document.getElementById(_READER_PALETTE_ID);
  if (!pal) return;
  if (pal.classList.contains('visible')) { _closeReaderPalette(); return; }
  pal.innerHTML = _readerPaletteHtml();
  pal.classList.add('visible');
  // Keep the palette AND its trigger button as "inside" so swatch/size taps and a
  // second tap on the book button behave; a tap on the article iframe dismisses.
  _readerPaletteDetach = _dismissOnOutside(
    [pal, document.getElementById('readerview-btn')], _closeReaderPalette);
}
function _closeReaderPalette() {
  var pal = document.getElementById(_READER_PALETTE_ID);
  if (pal) pal.classList.remove('visible');
  if (_readerPaletteDetach) { _readerPaletteDetach(); _readerPaletteDetach = null; }
}
var _READER_PRINT_ROOT_ID = 'zimi-print-root';
var _READER_PRINT_STYLE_ID = 'zimi-print-style';
// Print / Save as PDF. Printing the IFRAME's own window (frame.contentWindow.print)
// is silently a no-op in iOS standalone Safari — the reported bug. Instead we clone
// the cleaned Reader-View shell into a hidden container in the PARENT document and
// print the PARENT window, which works across desktop, mobile Safari and PWAs. The
// clone's relative image/link URLs are resolved to absolute from the live iframe
// DOM (they'd otherwise resolve against the parent URL and break).
function _readerPrint() {
  if (!_readerPrintable()) return;
  var doc = _readerFrameDoc();
  var liveShell = doc && doc.querySelector('.zimi-reader');
  // Reader View guarantees the .zimi-reader shell; without it there's nothing
  // clean to print, so bail rather than print the whole app chrome.
  if (!liveShell) { try { window.print(); } catch (e) {} return; }

  var clone = liveShell.cloneNode(true);
  // Resolve URLs from the live, already-rendered elements (their .src/.href
  // properties are absolute) onto the structurally-identical clone.
  function _absFix(sel, prop, attr) {
    var live = liveShell.querySelectorAll(sel), cl = clone.querySelectorAll(sel);
    for (var i = 0; i < cl.length && i < live.length; i++) {
      try { cl[i].setAttribute(attr, live[i][prop]); } catch (e) {}
      if (attr === 'src') cl[i].removeAttribute('srcset'); // relative srcset would win
    }
  }
  _absFix('img', 'src', 'src');
  _absFix('a', 'href', 'href');
  // Drop interactive-only affordances that don't belong on paper.
  var lb = clone.querySelectorAll('.' + _READER_LIGHTBOX_CLASS + ',.zimi-lightbox-close');
  for (var j = 0; j < lb.length; j++) if (lb[j].parentNode) lb[j].parentNode.removeChild(lb[j]);

  _readerPrintCleanup(); // clear any prior run
  var style = document.createElement('style');
  style.id = _READER_PRINT_STYLE_ID;
  style.textContent = [
    // On screen the print root is never shown; it only exists for @media print.
    '#' + _READER_PRINT_ROOT_ID + '{display:none}',
    '@media print{',
      // Hide the entire app; reveal only the print root, black-on-white.
      'body>*{display:none !important}',
      'body>#' + _READER_PRINT_ROOT_ID + '{display:block !important}',
      'html,body{background:#fff !important;margin:0 !important;padding:0 !important}',
      '#' + _READER_PRINT_ROOT_ID + '{color:#000;background:#fff;font-size:12pt;line-height:1.6;',
        'font-family:Georgia,"Times New Roman",serif;max-width:100%;padding:0 4mm}',
      '#' + _READER_PRINT_ROOT_ID + ' .zimi-reader-title{font-size:20pt;font-weight:700;margin:0 0 0.6em;line-height:1.25}',
      '#' + _READER_PRINT_ROOT_ID + ' h1,#' + _READER_PRINT_ROOT_ID + ' h2,#' + _READER_PRINT_ROOT_ID + ' h3{',
        'page-break-after:avoid;break-after:avoid;line-height:1.3}',
      '#' + _READER_PRINT_ROOT_ID + ' a{color:#000 !important;text-decoration:none}',
      '#' + _READER_PRINT_ROOT_ID + ' img,#' + _READER_PRINT_ROOT_ID + ' figure,#' + _READER_PRINT_ROOT_ID + ' svg,',
        '#' + _READER_PRINT_ROOT_ID + ' table,#' + _READER_PRINT_ROOT_ID + ' pre,#' + _READER_PRINT_ROOT_ID + ' blockquote{',
        'page-break-inside:avoid;break-inside:avoid;max-width:100% !important;height:auto}',
      '#' + _READER_PRINT_ROOT_ID + ' th,#' + _READER_PRINT_ROOT_ID + ' td{border:1px solid #bbb;padding:6px 10px;text-align:left}',
      '#' + _READER_PRINT_ROOT_ID + ' pre,#' + _READER_PRINT_ROOT_ID + ' code{background:#f2f2f2;white-space:pre-wrap;word-wrap:break-word}',
    '}'
  ].join('');
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.id = _READER_PRINT_ROOT_ID;
  root.appendChild(clone);
  document.body.appendChild(root);

  // Tear down after printing. afterprint covers desktop + most mobile; a timeout
  // backstops iOS where afterprint can be flaky.
  var done = false;
  var teardown = function () { if (done) return; done = true; _readerPrintCleanup(); window.removeEventListener('afterprint', teardown); };
  window.addEventListener('afterprint', teardown);
  setTimeout(teardown, 60000);
  try { window.print(); }
  catch (e) { teardown(); }
}
function _readerPrintCleanup() {
  var el = document.getElementById(_READER_PRINT_ROOT_ID); if (el) el.remove();
  var st = document.getElementById(_READER_PRINT_STYLE_ID); if (st) st.remove();
}
// Build a Zimi SPA deep link for an article: /?a=<zim>/<path>. Anchored on the
// root path (always served as the SPA shell) with the target in a query param, so
// opening it boots full Zimi chrome and lands straight on the article — unlike a
// raw /w/<zim>/<path> link, which servers ambiguously serve as bare ZIM content
// when the Sec-Fetch-Dest hint is missing (older Safari, in-app browsers).
function _articleDeepLinkPath(zim, path) {
  return '/?a=' + encodeURIComponent(zim + '/' + path);
}
function _articleDeepLink(zim, path) {
  return location.origin + _articleDeepLinkPath(zim, path);
}
// Native share of the current article (title + a SPA deep link). Only wired when
// navigator.share exists (the palette row is hidden otherwise).
function _readerShare() {
  if (typeof navigator === 'undefined' || !navigator.share) return;
  var doc = _readerFrameDoc();
  var title = (doc && doc.title) || document.title || 'Zimi';
  navigator.share({ title: title, url: _currentPageUrl() }).catch(function () {});
}

// ── Reader ──
function openReader(url) {
  // Same-document fragment scroll fast-path. When the frame already holds the
  // target document and only the #fragment differs, a location.replace() below
  // performs a SAME-DOCUMENT scroll and fires NO load event — so the loading
  // overlay (shown unconditionally further down) would hang until the 15s safety
  // timeout. Single-page docs (devdocs) whose TOC links are page-qualified
  // ('index#anchor', not bare '#anchor') route every anchor click through here,
  // making each in-page jump look like a 15s page load (issue #38). Detect the
  // same-base target and scroll in place instead of running the reload cycle.
  if (url.slice(0, 3) === '/w/' && url.indexOf('#') !== -1) {
    var _frame0 = document.getElementById('reader-frame');
    var _curHref = ''; try { _curHref = _frame0.contentWindow.location.href; } catch (e) {}
    var _absTarget = location.origin + url;
    var _docBase = function (u) { var i = u.indexOf('#'); return i < 0 ? u : u.slice(0, i); };
    if (_curHref && _docBase(_curHref) === _docBase(_absTarget) && _curHref !== _absTarget) {
      readerOpen = true;
      mainView.classList.add('hidden');
      document.getElementById('reader').classList.add('open');
      document.documentElement.style.overflowY = 'hidden';
      document.getElementById('reader-loading').classList.add('hidden');
      _frame0.style.visibility = 'visible';
      if (_readerTimeout) clearTimeout(_readerTimeout);
      var _frag = _absTarget.slice(_absTarget.indexOf('#') + 1);
      // Set the hash for URL consistency, then scroll the target into view
      // explicitly. Relying on the hash alone is unreliable here — the browser
      // skips its fragment-scroll when the hash is set programmatically right
      // after we reveal the frame — so resolve the anchor (by id, then name) and
      // scrollIntoView, matching the native jump the old full reload produced.
      try { _frame0.contentWindow.location.hash = '#' + _frag; } catch (e) {}
      try {
        var _fdoc = _frame0.contentDocument;
        var _dec = _frag; try { _dec = decodeURIComponent(_frag); } catch (e) {}
        var _tgt = _fdoc.getElementById(_dec) || _fdoc.getElementById(_frag) ||
                   _fdoc.querySelector('[name="' + _cssEsc(_dec) + '"]');
        if (_tgt) _tgt.scrollIntoView();
      } catch (e) {}
      updateTopbar();
      return;
    }
  }
  // EPUBs: download (Gutenberg has HTML equivalents)
  var lurl = url.toLowerCase();
  if (lurl.endsWith('.epub')) {
    var extUrl = url + (url.includes('?') ? '&' : '?') + 'raw=1';
    if (!/^https?:\/\//.test(extUrl)) extUrl = location.origin + extUrl;
    _downloadFile(extUrl);
    return false;
  }
  // PDFs: render in embedded pdf.js viewer (skip if already a viewer URL)
  if (lurl.endsWith('.pdf') && !url.startsWith('/static/pdfjs/')) {
    url = _pdfViewerUrl(url);
  }
  // A11y rewrite opt-in: only ZIM article URLs (/w/...), not PDFs or static.
  if (_getStorageFlag(SK.A11Y_REWRITE) && url.startsWith('/w/') && !lurl.endsWith('.pdf')) {
    url += (url.includes('?') ? '&' : '?') + 'a11y=1';
  }
  readerOpen = true;
  _ttsStop();          // never carry speech across a new article load
  _ttsSetSpeaking(false); // reset the button label to "Read aloud"
  _syncFontBtnGlyph();    // reflect the persisted font level on the control
  const reader = document.getElementById('reader');
  const frame = document.getElementById('reader-frame');
  const loading = document.getElementById('reader-loading');

  mainView.classList.add('hidden');
  reader.classList.add('open');
  // Hide main document scroll so iframe becomes primary scroller (iOS tap-to-top)
  document.documentElement.style.overflowY = 'hidden';
  loading.classList.remove('hidden');
  // Tint the iframe + loading overlay to the reader theme when Reader View is
  // sticky or AUTO is armed, so the load gap shows theme bg (never ZIM-white).
  _tintReaderChrome();
  // "Dark mode unbroken": when Reader View will apply to the incoming doc (sticky
  // or AUTO), keep the iframe itself invisible until onload has swapped in the
  // reader shell. The tinted overlay fades in over 0.3s, so on a fast local load
  // it can't be trusted to fully mask the raw white ZIM paint — hiding the frame
  // outright guarantees the first painted frame is the reader, never the original.
  // (visibility:hidden preserves layout + load, so extraction still works.)
  var _maskFrame = _readerViewOn || _readerAuto();
  frame.style.visibility = _maskFrame ? 'hidden' : 'visible';

  // Punch-out button: for pdf.js viewer URLs, link to the raw PDF for download
  if (url.startsWith('/static/pdfjs/')) {
    var fileParam = new URL(url, location.origin).searchParams.get('file');
    // Add ?raw=1 for direct browser download (bypasses SPA shell)
    newtabBtn.href = fileParam ? (fileParam + (fileParam.includes('?') ? '&' : '?') + 'raw=1') : url;
  } else {
    // Middle/⌘-click parity: use the ?a= deep link (full Zimi chrome), matching
    // what _openInBrowser opens on a plain click.
    newtabBtn.href = currentArticle ? _articleDeepLinkPath(currentArticle.zim, currentArticle.path) : url;
  }

  frame.onerror = function() {
    loading.classList.add('hidden');
    frame.style.visibility = 'visible'; // never leave the frame masked on error
  };
  // Safety timeout: if iframe doesn't load within 15s, hide spinner
  if (_readerTimeout) clearTimeout(_readerTimeout);
  _readerTimeout = setTimeout(function() {
    if (readerOpen && !loading.classList.contains('hidden')) {
      loading.classList.add('hidden');
    }
    frame.style.visibility = 'visible'; // reveal even if the load stalled
  }, 15000);
  frame.onload = function() {
    clearTimeout(_readerTimeout);
    if (!readerOpen) { loading.classList.add('hidden'); return; } // reader was closed — don't update title
    _ttsStop(); // stop any in-progress speech when the article changes
    // AUTO / sticky Reader View: transform the freshly loaded document BEFORE we
    // reveal it. The reader was on for the previous article (sticky, Safari-like)
    // or AUTO is armed → re-apply to this doc. The tinted loading overlay stays up
    // until the shell exists, so the raw ZIM page never flashes ("dark mode
    // unbroken"). Non-eligible docs (PDF viewer, thin pages) fall through silently.
    var _wantReader = _readerViewOn || _readerAuto();
    _readerViewOn = false; // the new document has no shell yet
    if (_wantReader) {
      var _rdoc = null; try { _rdoc = frame.contentDocument; } catch(e) { _rdoc = null; }
      if (_rdoc && _readerViewAvailable()) {
        var _rok = false; try { _rok = _readerViewApply(_rdoc); } catch(e) { _rok = false; }
        if (_rok) _readerViewOn = true;
      }
    }
    _tintReaderChrome(); // reset frame bg to #fff if reader ended up off
    _syncReaderViewBtn();
    // Auto-darken a raw (non-Reader-View) ZIM page when the app is dark, so the
    // white page doesn't break dark mode. No-op under Reader View / dark pages.
    try { _applyArticleDarken(frame.contentDocument); } catch(e) {}
    frame.style.visibility = 'visible'; // reveal now — shell (or raw doc) is ready to paint
    loading.classList.add('hidden');
    try { _applyReaderFont(frame.contentDocument); } catch(e) {} // reapply persisted font scale
    // Capture mousedown inside iframe for modifier-click detection + dismiss context menu
    try {
      frame.contentDocument.addEventListener('mousedown', function(e) { _lastMouseEvent = e; _lastMouseTime = Date.now(); _hideLinkCtxMenu(); }, true);
    } catch(e) {}
    // Word lookup: wire selection/double-tap → Define popover (dormant when no
    // wiktionary ZIM is installed). Works in the normal reader AND Reader View
    // (same document, listeners attached once per load survive the transform).
    try { _defineAttachToDoc(frame); } catch(e) {}
    // A consent wall that the ARCHIVE rebuilds every time it is opened.
    try { _sweepBlockingOverlays(frame); } catch(e) {}
    // A captured page's JS-driven chrome, put back in its place.
    try { _settleCapturedChrome(frame); } catch(e) {}
    // Inject responsive CSS + scroll-to-top button for mobile
    try {
      // Web-mirror pages (alive engine, zimit) ship a browser's-eye recording of
      // a real site: their own viewport meta, their own responsive CSS, their own
      // replay shim (wombat). The mwoffliner first-aid below actively BREAKS them
      // — max-width:100% on img squishes apple.com's 734px container-cropped
      // tiles into the 393px viewport while the site's height rule holds, so
      // every tile distorts. Wombat's presence in the document IS the web-mirror
      // signal: such pages get only the scroll-to-top button, never the corset.
      var _isWebMirror = false;
      try {
        _isWebMirror = !!(frame.contentWindow._wb_wombat ||
          frame.contentDocument.querySelector('script[src*="wombat"]'));
      } catch(e) { _isWebMirror = false; }
      var _rStyle = frame.contentDocument.createElement('style');
      _rStyle.textContent = (_isWebMirror ? [] : [
        // Horizontal containment for raw mwoffliner pages: the whole viewport must
        // never scroll sideways on a phone (e.g. wikipedia/Caribbean's wide country
        // tables + locator map). Genuinely-wide content (tables, <pre>) keeps its
        // OWN inner scroll so it stays readable; everything else is capped to the
        // column, and the body clips any last sliver of overflow. Mirrors the Reader
        // View containment strategy — safe precisely because wide blocks inner-scroll.
        'html,body{overflow-x:hidden;max-width:100%}',
        // video/audio need the same 100% cap as img: TED/Khan talk pages carry a
        // fixed width= (e.g. 640) that overflows a phone viewport without it.
        'img,video{max-width:100%;height:auto}audio{width:100%;max-width:100%}',
        // Wide tables inner-scroll instead of pushing the page; min-width:0 lets
        // flex/table cells shrink below their content's intrinsic width.
        'table{max-width:100%;overflow-x:auto;display:block}td,th{min-width:0}',
        'pre{overflow-x:auto;max-width:100%}',
        // Fixed-width mwoffliner blocks (image thumbs, locator maps, galleries,
        // floated infoboxes) that carry an inline pixel width wider than a phone —
        // rein them into the column so they don't force page-level overflow.
        '.thumb,.thumbinner,figure,.gallery,.mw-kartographer-map,.mw-kartographer-maplink,' +
          '.floatright,.floatleft,.tright,.tleft{max-width:100%!important}'
      ]).concat([
        '#zimi-top{position:fixed;bottom:20px;right:20px;width:40px;height:40px;border-radius:50%;background:rgba(0,0,0,0.6);color:#fff;border:none;font-size:20px;cursor:pointer;display:none;align-items:center;justify-content:center;z-index:9999;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}'
      ]).join('');
      // A page with no viewport meta was laid out for a desktop: xkcd's comic
      // sits in a 780px table. A phone browser shows such a page zoomed out to
      // fit; inside this frame it was clipped at the right edge instead, half
      // the comic gone (seen 2026-09-03). Scale the document to the frame the
      // way the phone would, only when the page did not say it is responsive.
      // Measured BEFORE the overflow rule below hides the overflow it measures.
      try {
        var _d = frame.contentDocument, _w = frame.contentWindow;
        if (!_isWebMirror && !_d.querySelector('meta[name="viewport"]')) {
          // The page's real width is the furthest right edge anything reaches
          // (a centred fixed-width table overflows both sides equally, and the
          // document's scrollWidth reports only the right-hand spill).
          var _wide = _d.documentElement.scrollWidth, _have = _w.innerWidth;
          var _all = _d.body ? _d.body.getElementsByTagName('*') : [];
          for (var _i = 0; _i < _all.length && _i < 3000; _i++) {
            var _r = _all[_i].getBoundingClientRect();
            // Its extent, counting spill to the left of the frame (a centred
            // table spills both ways). Anything parked far off-screen — a
            // skip link at -9999px — is not layout and is ignored.
            if (_r.width <= 0 || _r.left < -_have * 2 || _r.right > _have * 6) continue;
            var _extent = _r.right - Math.min(_r.left, 0);
            if (_extent > _wide) _wide = _extent;
          }
          if (_wide > _have + 8 && _have > 0) {
            _d.documentElement.style.zoom = String(_have / _wide);
          }
        }
      } catch(e) {}
      frame.contentDocument.head.appendChild(_rStyle);
      var _topBtn = frame.contentDocument.createElement('button');
      _topBtn.id = 'zimi-top';
      _topBtn.innerHTML = '\u2191';
      _topBtn.onclick = function() { frame.contentWindow.scrollTo({top:0,behavior:'smooth'}); };
      frame.contentDocument.body.appendChild(_topBtn);
      var _scrollTicking = false;
      frame.contentWindow.addEventListener('scroll', function() {
        if (!_scrollTicking) { _scrollTicking = true; requestAnimationFrame(function() {
          _topBtn.style.display = frame.contentWindow.scrollY > 300 ? 'flex' : 'none';
          _scrollTicking = false;
        }); }
      }, {passive: true});
    } catch(e) {}
    // Only intercept clicks in ZIM content, not in static viewer pages (pdf.js)
    var _frameLoc = ''; try { _frameLoc = frame.contentWindow.location.pathname; } catch(e) {}
    if (!_frameLoc.startsWith('/static/')) try {
      // Tap-to-full-size lightbox for the raw article frame. Bound first so its
      // capture click handler precedes the link interceptor below.
      try { _bindNormalReaderLightbox(frame); } catch(e) {}
      // Video resume: derive zim+path from the frame's real /w/ location so it
      // keys correctly even after in-iframe navigation (not just openArticle).
      try {
        var _vm = _frameLoc.match(/^\/w\/([^\/]+)\/(.+)$/);
        if (_vm) _bindVideoResume(frame, decodeURIComponent(_vm[1]), decodeURIComponent(_vm[2]));
      } catch(e) {}
      // Dead-player affordance for broken-scrape ZIMs (0-byte / missing media).
      // Independent of the resume binding above — runs for any /w/ article frame.
      try { _bindVideoError(frame); } catch(e) {}
      var _handleFrameLink = function(e) {
        var a = e.target.closest('a[href]');
        if (!a) return;
        var href = a.getAttribute('href') || '';
        // Hash-only links (#/route, #heading): let iframe handle natively (SPA routing, anchors)
        if (href.startsWith('#')) return;
        // The interstitial's own "Open on the live web" button. Without this
        // bypass the stay-in-archive fallback below would catch it — the
        // domain maps to the very ZIM that just missed — and navigate back to
        // the same interstitial: a button that visibly does nothing (Eric,
        // on exactly that button: "when I click open it isn't opening").
        if (a.dataset && a.dataset.zimiLive === '1') {
          e.preventDefault();
          window.open(a.href, '_blank');
          return;
        }
        // Wombat (zimit-scraped ZIMs) rewrites <a href> ATTRIBUTES to look
        // like the original archived URL (e.g. "https://ersatztv.org/docs/")
        // and ALSO installs its own click handler that re-resolves them.
        // That re-resolution doubles the path (issue #17 — ersatztv ZIM).
        // We borrow Kiwix's `_no_rewrite=true` trick: ask wombat to give us
        // the actual in-archive URL it computed at page-load time, and use
        // THAT for navigation.
        var fullUrl;
        try {
          var _prevNoRewrite = a._no_rewrite;
          a._no_rewrite = true;
          var realHref = a.href;
          a._no_rewrite = _prevNoRewrite;
          // If wombat rewrote, realHref is the actual archive URL. If
          // there's no wombat, this is identical to the regular .href.
          fullUrl = realHref;
        } catch (ex) {
          var frameLoc = frame.contentWindow.location;
          try { fullUrl = new URL(href, frameLoc.href).href; } catch(ex2) { fullUrl = a.href; }
        }
        var lhref = href.toLowerCase();
        // EPUB: download
        if (lhref.endsWith('.epub')) {
          e.preventDefault();
          if (!fullUrl.includes('raw=1')) fullUrl += (fullUrl.includes('?') ? '&' : '?') + 'raw=1';
          _downloadFile(fullUrl);
          return;
        }
        // In-ZIM links (same-origin /w/<zim>/<path>): route through openArticle for history tracking
        var wMatch = fullUrl.startsWith(location.origin) && fullUrl.match(/\/w\/([^\/]+)\/(.+)/);
        if (wMatch) {
          e.preventDefault();
          var linkZim = decodeURIComponent(wMatch[1]);
          var linkPath = decodeURIComponent(wMatch[2]).replace(/\?.*$/, ''); // strip query params, keep hash
          openArticle(linkZim, linkPath);
          return;
        }
        // External links: try cross-ZIM resolution, fall back to new tab
        // Check both raw href (https://...) and protocol-relative (//domain/...)
        if ((/^https?:\/\//.test(href) || /^\/\//.test(href)) && !fullUrl.startsWith(location.origin)) {
          e.preventDefault();
          // Quick client-side check: skip /resolve if domain isn't in any installed ZIM
          try {
            var linkHost = new URL(fullUrl).hostname;
            var linkBare = linkHost.replace(/^www\./, '');
            if (!_domainZimMap[linkHost] && !_domainZimMap[linkBare]) {
              window.open(fullUrl, '_blank');
              return;
            }
          } catch(ex) {}
          // Check cached resolve results first (populated by batch resolve on load)
          var _cached = _resolveCache && _resolveCache[fullUrl];
          if (_cached && _cached.found) {
            openArticle(_cached.zim, _cached.path);
            return;
          }
          var fromZim = readerSource || (currentArticle && currentArticle.zim) || '';
          // When resolve says "not captured" but the domain BELONGS to an
          // installed ZIM, stay in the archive: navigate to the mirrored
          // path so the reader serves the page if it exists and the
          // not-captured interstitial (with its explicit live-web link) if
          // it does not. Leaving the archive is always a stated choice, so
          // window.open(live) is reserved for domains no ZIM claims.
          var _mapped = _domainZimMap[linkHost] || _domainZimMap[linkBare] || '';
          function _stayInArchive() {
            try {
              var u = new URL(fullUrl);
              openArticle(_mapped, u.hostname + u.pathname + (u.search || ''));
              return true;
            } catch (ex) { return false; }
          }
          fetch('/resolve?url=' + encodeURIComponent(fullUrl) + (fromZim ? '&from=' + encodeURIComponent(fromZim) : ''))
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (data.found) openArticle(data.zim, data.path);
              else if (_mapped && _stayInArchive()) return;
              else window.open(fullUrl, '_blank');
            })
            .catch(function() {
              if (!(_mapped && _stayInArchive())) window.open(fullUrl, '_blank');
            });
        }
      };
      // capture: true so we run before wombat's own click interceptor.
      frame.contentDocument.addEventListener('click', _handleFrameLink, true);
      // Middle-click fires auxclick, not click — handle it for new-tab support
      frame.contentDocument.addEventListener('auxclick', function(e) {
        if (e.button === 1) _handleFrameLink(e);
      });
      // NB: deliberately NO contextmenu listener inside the article frame. The
      // system context menu is load-bearing on article content (copy, open link
      // in new tab, look up, translate, image save…), so right-click inside a ZIM
      // page must yield ONLY the browser's own menu. Zimi's custom link menu is
      // offered on chrome article links (search results / tiles) in the parent
      // document instead — see the delegated contextmenu handler below.
    } catch(e) { /* cross-origin — ZIM content loaded from a different origin */ }
    // Classify links: batch-resolve external URLs to find which ones are available locally
    // Only highlight links that actually resolve to a different installed ZIM
    // Feature flag: enabled by default, user can hide via Settings checkbox
    var _currentZim = readerSource || (currentArticle && currentArticle.zim) || '';
    if (!_getStorageFlag(SK.HIDE_XZIM_LINKS) && Object.keys(_domainZimMap).length > 0 && !_frameLoc.startsWith('/static/')) try {
      var styleEl = frame.contentDocument.createElement('style');
      styleEl.textContent = '.zimi-xzim{text-decoration-style:dotted;text-decoration-color:var(--amber,#f59e0b)}';
      frame.contentDocument.head.appendChild(styleEl);
      // Collect external URLs that might resolve to installed ZIMs
      var urlMap = {}; // url → [anchor elements]
      var links = frame.contentDocument.querySelectorAll('a[href]');
      var frameLoc2 = frame.contentWindow.location;
      links.forEach(function(a) {
        var h2 = a.getAttribute('href') || '';
        var full2;
        try { full2 = new URL(h2, frameLoc2.href).href; } catch(ex) { return; }
        if (full2.startsWith(location.origin)) return;
        if (!/^https?:\/\//.test(full2)) return;
        try {
          var host2 = new URL(full2).hostname;
          var bare2 = host2.replace(/^www\./, '');
          if (_domainZimMap[host2] || _domainZimMap[bare2]) {
            // This domain has a matching ZIM — collect for batch resolve
            if (!urlMap[full2]) urlMap[full2] = [];
            urlMap[full2].push(a);
          }
          // Unresolved external links: no special styling (leave as normal links)
        } catch(ex) {}
      });
      // Batch resolve collected URLs — chunked to stay under body limits
      _resolveCache = {}; // Reset per page load
      var extUrls = Object.keys(urlMap).slice(0, 300); // Cap to prevent pathological load on large articles
      if (extUrls.length > 0) {
        var CHUNK_SIZE = 30;
        var chunks = [];
        for (var ci2 = 0; ci2 < extUrls.length; ci2 += CHUNK_SIZE) {
          chunks.push(extUrls.slice(ci2, ci2 + CHUNK_SIZE));
        }
        var _applyResults = function(results) {
          for (var u in results) {
            _resolveCache[u] = results[u];
            var anchors = urlMap[u];
            if (!anchors) continue;
            if (results[u].found && results[u].zim !== _currentZim) {
              anchors.forEach(function(a) { a.classList.add('zimi-xzim'); });
            }
          }
        };
        var _missedDomains = {};
        var _resolvedCount = 0, _totalCount = extUrls.length;
        var _chunksCompleted = 0;
        // Process chunks in parallel (max 3 concurrent)
        var _chunkIdx = 0;
        var _runChunk = function() {
          if (_chunkIdx >= chunks.length) {
            // Log summary once when all chains have finished
            _chunksCompleted++;
            if (_chunksCompleted === Math.min(3, chunks.length)) {
              var missedKeys = Object.keys(_missedDomains);
              if (missedKeys.length > 0) {
                console.log('[Zimi] Cross-ZIM: ' + _resolvedCount + '/' + _totalCount + ' links resolved, ' + missedKeys.length + ' unique domains missed');
                console.log('[Zimi] Unresolved domains: ' + missedKeys.join(', '));
              } else if (_resolvedCount > 0) {
                console.log('[Zimi] Cross-ZIM: ' + _resolvedCount + '/' + _totalCount + ' links resolved');
              }
            }
            return Promise.resolve();
          }
          var chunk = chunks[_chunkIdx++];
          return fetch('/resolve', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({urls: chunk})
          }).then(function(r) {
            if (!r.ok) throw new Error('resolve returned ' + r.status);
            return r.json();
          }).then(function(data) {
            var results = data.results || {};
            _applyResults(results);
            for (var u2 in results) {
              if (results[u2].found) { _resolvedCount++; }
              else { try { _missedDomains[new URL(u2).hostname] = true; } catch(ex) {} }
            }
          }).catch(function(err) {
            console.warn('[Zimi] Cross-ZIM resolve chunk failed:', err.message || err);
          }).then(_runChunk);
        };
        // Launch up to 3 parallel chains
        var _parallel = Math.min(3, chunks.length);
        for (var pi = 0; pi < _parallel; pi++) _runChunk();
      }
    } catch(e) { /* cross-origin */ }
    // Update document/window title from iframe content (skip for pdf.js — it reports
    // "PDF.js viewer" which overwrites the good title already set by openArticle)
    if (!_frameLoc.startsWith('/static/')) try {
      var iTitle = frame.contentDocument && frame.contentDocument.title;
      if (!iTitle) {
        // Fallback: extract from iframe URL path
        var seg = _titleFromPath(frame.contentWindow.location.pathname);
        if (seg && seg !== 'blank') iTitle = seg;
      }
      if (iTitle) {
        var docTitle = iTitle + ' \u2014 Zimi';
        document.title = docTitle;
        _setWindowTitle(docTitle);
      }
    } catch(e) { /* cross-origin or closed */ }
    // Track current article for bookmark button (iframe may have navigated via relative link)
    try {
      var _fPath = frame.contentWindow.location.pathname;
      var _wm = _fPath.match(/^\/w\/([^\/]+)\/(.+)/);
      if (_wm) {
        var _navZim = decodeURIComponent(_wm[1]);
        var _navPath = decodeURIComponent(_wm[2]);
        currentArticle = { zim: _navZim, path: _navPath };
        _updateLibraryBtnIcon();
      }
    } catch(e) {}
    // Check language banner for view-in-lang options + prefetch article languages
    if (currentArticle) {
      _checkReaderLangBanner();
      _prefetchArticleLangs();
    }
    // Reader View: reapply the session preference to the freshly-loaded article
    // (same pattern as _applyReaderFont), then sync the toggle's availability.
    // Placed last so the injected scroll-to-top button + responsive style are
    // already in place and get stashed with the rest of the original body.
    if (_readerViewOn) { try { _readerViewApply(frame.contentDocument); } catch(e) {} }
    _syncReaderViewBtn();
  };
  // Use location.replace to avoid polluting parent history stack
  // (setting iframe.src adds a session history entry that breaks the back button)
  try { frame.contentWindow.location.replace(url); } catch(e) { frame.src = url; }
  updateTopbar();
}

// ── Persistent History (localStorage) ──
var _persistHist = null; // lazy-loaded
var _currentSearchQuery = null; // tracks which search led to article clicks
var _HIST_KEY = 'zimi_history';
var _HIST_MAX = 200;
var _MS_PER_DAY = 86400000;

function _histLoad() {
  if (_persistHist !== null) return _persistHist;
  try { _persistHist = JSON.parse(localStorage.getItem(_HIST_KEY)) || []; }
  catch(e) { _persistHist = []; }
  return _persistHist;
}
function _histSave() {
  if (!_persistHist) return;
  try { localStorage.setItem(_HIST_KEY, JSON.stringify(_persistHist)); } catch(e) {}
}
function _histPushArticle(zim, path, title) {
  var h = _histLoad();
  // Deduplicate: remove if same zim+path exists recently (within last 5 entries)
  for (var i = 0; i < Math.min(5, h.length); i++) {
    if (h[i].type === 'article' && h[i].zim === zim && h[i].path === path) {
      h.splice(i, 1);
      break;
    }
  }
  var entry = { type: 'article', zim: zim, path: path, title: title || _titleFromPath(path), timestamp: Date.now() };
  if (_currentSearchQuery) entry.fromQuery = _currentSearchQuery;
  h.unshift(entry);
  if (h.length > _HIST_MAX) h.length = _HIST_MAX;
  _histSave();
}
function _histPushSearch(query, zimName, resultCount) {
  var h = _histLoad();
  // Deduplicate recent identical searches
  if (h.length > 0 && h[0].type === 'search' && h[0].query === query && h[0].zim === (zimName || '')) return;
  h.unshift({ type: 'search', zim: zimName || '', query: query, resultCount: resultCount || 0, timestamp: Date.now() });
  if (h.length > _HIST_MAX) h.length = _HIST_MAX;
  _histSave();
}
function _histClear() {
  _persistHist = [];
  try { localStorage.removeItem(_HIST_KEY); } catch(e) {}
  renderLibraryPanel();
}
function _histRemove(idx) {
  var h = _histLoad();
  if (idx >= 0 && idx < h.length) {
    h.splice(idx, 1);
    _histSave();
  }
  renderLibraryPanel();
}
function _histDateGroup(ts) {
  var now = new Date();
  var d = new Date(ts);
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var yesterday = new Date(today - _MS_PER_DAY);
  var weekAgo = new Date(today - 6 * _MS_PER_DAY);
  if (d >= today) return t('today');
  if (d >= yesterday) return t('yesterday');
  if (d >= weekAgo) return t('this_week');
  return t('older');
}
// Both panel openers (the app-wide library button and the reader's bookmarks
// button, #65) mirror the panel's open state with the same class.
function _libPanelBtnState(open) {
  // The panel-open highlight belongs to the button that OPENS the panel. In
  // the reader the topbar library-btn is the bookmark-this-article toggle, not
  // the panel opener, so it must never light up when the panel opens (Eric:
  // tapping the bookmarks view highlighted the bookmark button). bm-panel-btn
  // is the reader's panel opener and always reflects the state.
  var bmBtn = document.getElementById('bm-panel-btn');
  if (bmBtn) bmBtn.classList.toggle('panel-open', open);
  var libBtn = document.getElementById('library-btn');
  if (libBtn) libBtn.classList.toggle('panel-open', open && !readerOpen);
}
function toggleLibraryPanel(forceTab) {
  var panel = document.getElementById('history-panel');
  var isOpen = panel.classList.contains('open');
  if (isOpen && (!forceTab || forceTab === _getLibraryTab())) {
    // Close if already open on same tab (or no tab specified)
    panel.classList.remove('open');
    _libPanelBtnState(false);
  } else {
    // Open (or switch tabs if already open on different tab)
    if (forceTab) { _setLibraryTab(forceTab); _updateLibraryBtnIcon(); }
    renderLibraryPanel();
    panel.classList.add('open');
    _libPanelBtnState(true);
  }
}
function _closeLibraryPanel() {
  var panel = document.getElementById('history-panel');
  if (panel) panel.classList.remove('open');
  _libPanelBtnState(false);
}
function _switchLibraryTab(tab) {
  _setLibraryTab(tab);
  _updateLibraryBtnIcon();
  renderLibraryPanel();
}
function renderLibraryPanel() {
  var panel = document.getElementById('history-panel');
  var tab = _getLibraryTab();
  var isHistory = (tab === 'history');
  var html = '<div class="library-panel-header">' +
    '<div class="library-tabs">' +
    '<button class="library-tab' + (isHistory ? ' active' : '') + '" onclick="_switchLibraryTab(\'history\')">' + tH('kbd_history') + '</button>' +
    '<button class="library-tab' + (!isHistory ? ' active' : '') + '" onclick="_switchLibraryTab(\'bookmarks\')">' + tH('kbd_bookmark') + '</button>' +
    '</div>' +
    '<button class="hp-clear" style="margin-left:8px" onclick="_closeLibraryPanel()">\u2715</button>' +
    '</div>';
  if (isHistory) {
    html += _renderHistoryContent();
  } else {
    html += _renderBookmarksContent();
  }
  panel.innerHTML = html;
  _bmEnsureBound();  // idempotent — attaches the bookmark-tree delegation once
  if (!isHistory) _bmSyncRovingTabindex(false);
}
function _renderHistoryContent() {
  var h = _histLoad();
  if (h.length === 0) {
    return '<div class="hp-empty">' + tH('no_history_panel') + '</div>';
  }
  var html = '';
  var currentGroup = '';
  var firstGroup = true;
  var i = 0;
  while (i < h.length) {
    var item = h[i];
    var group = _histDateGroup(item.timestamp);
    if (group !== currentGroup) {
      if (currentGroup) html += '</div>';
      if (firstGroup) {
        // First day heading shares its row with the Clear action (one line).
        html += '<div class="hp-group"><div class="hp-group-head">' +
          '<div class="hp-group-label">' + esc(group) + '</div>' +
          '<button class="hp-clear" onclick="_histClear()">' + tH('clear') + '</button></div>';
        firstGroup = false;
      } else {
        html += '<div class="hp-group"><div class="hp-group-label">' + esc(group) + '</div>';
      }
      currentGroup = group;
    }
    if (item.type === 'search') {
      var searchSub = item.zim ? _zimTitle(item.zim) : t('all_sources').replace(/^\u2190\s*/, '');
      if (item.resultCount) searchSub += ' \u00B7 ' + item.resultCount + ' results';
      html += '<div class="hp-item" onclick="_closeLibraryPanel();' + (item.zim ? 'enterSource(\'' + escJs(item.zim) + '\',false);' : '') + 'q.value=\'' + escJs(item.query) + '\';doSearch(\'' + escJs(item.query) + '\')">' +
        '<div class="hp-icon">\uD83D\uDD0D</div>' +
        '<div class="hp-detail"><div class="hp-title">' + esc(item.query) + '</div>' +
        '<div class="hp-sub">' + esc(searchSub) + '</div></div>' +
        '<button class="hp-item-del" onclick="event.stopPropagation();_histRemove(' + i + ')">\u2715</button></div>';
      var j = i + 1;
      while (j < h.length && h[j].type === 'article' && h[j].fromQuery === item.query) {
        var child = h[j];
        var cIcon = child.zim ? _sourceIconHtml(child.zim, 16) : '';
        var cSub = child.zim ? _zimTitleWithLang(child.zim) : '';
        html += '<div class="hp-item" style="padding-left:38px" onclick="_closeLibraryPanel();openArticle(\'' + escJs(child.zim) + '\',\'' + escJs(child.path) + '\',\'' + escJs(child.title || '') + '\')">' +
          '<div class="hp-icon" style="width:22px;height:22px">' + cIcon + '</div>' +
          '<div class="hp-detail"><div class="hp-title">' + esc(child.title || child.path) + '</div>' +
          '<div class="hp-sub">' + esc(cSub) + '</div></div>' +
          '<button class="hp-item-del" onclick="event.stopPropagation();_histRemove(' + j + ')">\u2715</button></div>';
        j++;
      }
      i = j;
    } else if (item.type === 'article') {
      var aIcon = item.zim ? _sourceIconHtml(item.zim, 20) : _BM_PAGE_SVG;
      var aSub = item.zim ? _zimTitleWithLang(item.zim) : '';
      html += '<div class="hp-item" onclick="_closeLibraryPanel();openArticle(\'' + escJs(item.zim) + '\',\'' + escJs(item.path) + '\',\'' + escJs(item.title || '') + '\')">' +
        '<div class="hp-icon">' + aIcon + '</div>' +
        '<div class="hp-detail"><div class="hp-title">' + esc(item.title || item.path) + '</div>' +
        '<div class="hp-sub">' + esc(aSub) + '</div></div>' +
        '<button class="hp-item-del" onclick="event.stopPropagation();_histRemove(' + i + ')">\u2715</button></div>';
      i++;
    } else {
      i++;
    }
  }
  if (currentGroup) html += '</div>';
  return html;
}
// \u2500\u2500 Bookmarks tab: folder tree (v2) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Rows are data-attribute driven so one delegated handler set on the persistent
// #history-panel covers click-to-open, collapse, context menus and pointer DnD
// across innerHTML re-renders (see _bmEnsureBound). Folders render above their
// bookmarks within a parent; each is independently ordered.
var _BM_INDENT = 14;        // px of indent per nesting level
var _bmBound = false;       // delegated listeners attached once to the panel

// Folder/page glyphs in the app's own icon language (thin stroke, currentColor,
// round caps and joins, the same family as the topbar SVGs). The OS-flavored
// emoji folder read as foreign next to them and ignored the theme ink.
var _BM_SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
var _BM_FOLDER_SVG = '<svg width="17" height="17" ' + _BM_SVG_ATTRS + '><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
var _BM_FOLDER_OPEN_SVG = '<svg width="17" height="17" ' + _BM_SVG_ATTRS + '><path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/></svg>';
var _BM_PAGE_SVG = '<svg width="15" height="15" ' + _BM_SVG_ATTRS + '><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

function _renderBookmarksContent() {
  var bk = _bkLoad();
  var folders = _folLoad();
  if (!bk.length && !folders.length) {
    // Still offer New folder so an empty library can start organizing. The
    // (empty) tree host must exist even now, because _bmNewFolderPrompt mounts
    // its inline input INTO #bm-tree — without it the very first folder could
    // never be created (the button did nothing on a pristine bookmarks tab).
    return '<div class="hp-actions bm-actions">' +
      '<button class="hp-action-btn" onclick="_bmNewFolderPrompt(\'\')">' + tH('bm_new_folder') + '</button></div>' +
      '<div class="hp-empty">' + tH('no_bookmarks') + '</div>' +
      '<div class="bm-tree" id="bm-tree" data-fid="" role="tree" aria-label="' + escAttr(t('bookmarks')) + '"></div>';
  }
  var html = '<div class="hp-actions bm-actions">' +
    '<button class="hp-action-btn" onclick="_bmNewFolderPrompt(\'\')">' + tH('bm_new_folder') + '</button>' +
    '<button id="export-bookmarks-btn" class="hp-action-btn" onclick="_bmOpenExport()">' + tH('save_to_zim') + '</button></div>';
  html += '<div class="bm-tree" id="bm-tree" data-fid="" role="tree"' +
    ' aria-label="' + escAttr(t('bookmarks')) + '">' + _bmChildrenHtml(_BM_ROOT, 0) + '</div>';
  return html;
}

// Recursive body of a folder (its child folders, then its bookmarks).
function _bmChildrenHtml(folderId, depth) {
  var html = '';
  _folChildren(folderId).forEach(function (f) {
    html += _bmFolderRowHtml(f, depth);
    if (!_folIsCollapsed(f.id)) html += _bmChildrenHtml(f.id, depth + 1);
  });
  _bkInFolder(folderId).forEach(function (b) { html += _bmBookmarkRowHtml(b, depth); });
  return html;
}

function _bmFolderRowHtml(f, depth) {
  var collapsed = _folIsCollapsed(f.id);
  var count = _folBookmarkCount(f.id);
  var pad = 6 + depth * _BM_INDENT;
  return '<div class="bm-row bm-folder" data-fid="' + escAttr(f.id) + '" data-depth="' + depth + '"' +
    ' style="padding-left:' + pad + 'px" role="treeitem" aria-level="' + (depth + 1) + '"' +
    ' aria-expanded="' + (!collapsed) + '" tabindex="-1">' +
    '<span class="bm-twist' + (collapsed ? '' : ' open') + '" data-role="twist">\u25B8</span>' +
    '<span class="bm-ficon">' + (collapsed ? _BM_FOLDER_SVG : _BM_FOLDER_OPEN_SVG) + '</span>' +
    '<span class="bm-name">' + esc(f.name) + '</span>' +
    '<span class="bm-count">' + count + '</span>' +
    '<button class="bm-gear" data-role="menu" title="' + escAttr(t('more_actions')) + '" aria-label="' + escAttr(t('more_actions')) + '">\u22EF</button>' +
    '</div>';
}

// True once the library list has arrived and this bookmark's ZIM is not in it \u2014
// the source was deleted or renamed under the bookmark. Opening one of these
// lands the reader on a page that never loads, so the row says so up front.
// Gated on a loaded list, or every row would read as dead during boot.
function _bkSourceMissing(b) {
  return !!(b.zim && zimsCache && zimsCache.length && !_zimInfo(b.zim));
}

function _bmBookmarkRowHtml(b, depth) {
  var missing = _bkSourceMissing(b);
  var icon = b.zim ? _sourceIconHtml(b.zim, 20) : _BM_PAGE_SVG;
  var sub = missing ? t('bm_source_missing') : (b.zim ? _zimTitleWithLang(b.zim) : '');
  var pad = 6 + depth * _BM_INDENT;
  return '<div class="bm-row bm-bk' + (missing ? ' bm-missing' : '') + '"' +
    ' data-zim="' + escAttr(b.zim) + '" data-path="' + escAttr(b.path) + '"' +
    ' data-fid="' + escAttr(_bkFolderOf(b)) + '" data-depth="' + depth + '"' +
    ' style="padding-left:' + pad + 'px" role="treeitem" aria-level="' + (depth + 1) + '" tabindex="-1">' +
    // Stands in for the folder rows' twist so a bookmark sits to the RIGHT of
    // the folder holding it, not left of it.
    '<span class="bm-twist bm-twist-gap"></span>' +
    '<span class="bm-bicon">' + icon + '</span>' +
    '<span class="bm-detail"><span class="bm-name">' + esc(b.title || _titleFromPath(b.path)) + '</span>' +
    (sub ? '<span class="bm-sub">' + esc(sub) + '</span>' : '') + '</span>' +
    '<button class="bm-gear" data-role="menu" title="' + escAttr(t('more_actions')) + '" aria-label="' + escAttr(t('more_actions')) + '">\u22EF</button>' +
    '</div>';
}

// ── Keyboard: the tree behaves like one ────────────────────────────────────
// Roving tabindex (ARIA tree pattern): Tab reaches the tree once, arrows move
// within it. Rows are rebuilt wholesale on every change, so the focused row is
// remembered by key and re-focused after the rebuild.
var _bmFocusKey = null;

function _bmRowKey(row) {
  if (!row) return null;
  return row.classList.contains('bm-folder')
    ? 'f:' + row.dataset.fid
    : 'b:' + row.dataset.zim + '\n' + row.dataset.path;
}
function _bmRowByKey(key) {
  if (!key) return null;
  var host = document.getElementById('bm-tree');
  if (!host) return null;
  if (key.slice(0, 2) === 'f:') return host.querySelector('.bm-folder[data-fid="' + _cssEsc(key.slice(2)) + '"]');
  var parts = key.slice(2).split('\n');
  return host.querySelector('.bm-bk[data-zim="' + _cssEsc(parts[0]) + '"][data-path="' + _cssEsc(parts[1]) + '"]');
}
function _bmRows() {
  var host = document.getElementById('bm-tree');
  return host ? Array.prototype.slice.call(host.querySelectorAll('.bm-row')) : [];
}
// Exactly one row is tabbable: the remembered one, else the first.
function _bmSyncRovingTabindex(focus) {
  var rows = _bmRows();
  if (!rows.length) return;
  var target = _bmRowByKey(_bmFocusKey) || rows[0];
  rows.forEach(function (r) { r.tabIndex = (r === target) ? 0 : -1; });
  if (focus) target.focus();
}
function _bmFocusRow(row) {
  if (!row) return;
  _bmFocusKey = _bmRowKey(row);
  _bmRows().forEach(function (r) { r.tabIndex = (r === row) ? 0 : -1; });
  row.focus();
}
// The row whose subtree contains `row` — Left arrow's "go to my parent".
function _bmParentRow(row) {
  var fid = row.classList.contains('bm-folder')
    ? _folNorm((_folById(row.dataset.fid) || {}).parent)
    : _folNorm(row.dataset.fid);
  if (fid === _BM_ROOT) return null;
  return _bmRowByKey('f:' + fid);
}

function _bmTreeKeydown(e) {
  // An inline edit (rename / new folder) owns the keyboard. Without this guard
  // the tree handler steals ArrowUp/Down (focus moves to another row, the input
  // blurs and commits) and Space (preventDefault + row.click() rerenders the
  // tree), killing the edit mid-word.
  var tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
  var row = e.target.closest ? e.target.closest('.bm-row') : null;
  if (!row || !row.parentNode || row.parentNode.id !== 'bm-tree') return;
  var rows = _bmRows();
  var i = rows.indexOf(row);
  var isFolder = row.classList.contains('bm-folder');
  var expanded = isFolder && !_folIsCollapsed(row.dataset.fid);
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); _bmFocusRow(rows[Math.min(i + 1, rows.length - 1)]); break;
    case 'ArrowUp': e.preventDefault(); _bmFocusRow(rows[Math.max(i - 1, 0)]); break;
    case 'Home': e.preventDefault(); _bmFocusRow(rows[0]); break;
    case 'End': e.preventDefault(); _bmFocusRow(rows[rows.length - 1]); break;
    case 'ArrowRight':
      e.preventDefault();
      if (isFolder && !expanded) { _bmFocusKey = _bmRowKey(row); _folToggleCollapse(row.dataset.fid); _bmRerender(); }
      else if (isFolder && rows[i + 1]) _bmFocusRow(rows[i + 1]);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (isFolder && expanded) { _bmFocusKey = _bmRowKey(row); _folToggleCollapse(row.dataset.fid); _bmRerender(); }
      else _bmFocusRow(_bmParentRow(row));
      break;
    case 'Enter': case ' ':
      e.preventDefault();
      _bmFocusKey = _bmRowKey(row);
      row.click();
      break;
    case 'ContextMenu': case 'F2': {
      e.preventDefault();
      var r = row.getBoundingClientRect();
      _bmOpenRowMenu(row, r.left + 24, r.bottom + 2);
      break;
    }
    default: return;
  }
}

// Re-render the bookmarks tab. renderLibraryPanel rebuilds the panel innerHTML;
// the delegated listeners live on the persistent panel element so they survive.
function _bmRerender() {
  if (_getLibraryTab() !== 'bookmarks') return;
  var hadFocus = document.activeElement && document.activeElement.closest &&
    !!document.activeElement.closest('.bm-row');
  renderLibraryPanel();
  _bmSyncRovingTabindex(hadFocus);
}

// Export entry point: the tree selector, optionally pre-ticked to one folder.
function _bmOpenExport(folderId) {
  _bmExportSelector(folderId);
}

// One keyboard contract for every inline edit input in the tree: Enter commits,
// Escape cancels, and EVERY key stops here. The blanket stopPropagation is the
// fix for edits dying mid-word \u2014 upstream of this input sit the tree's
// delegated keydown (_bmTreeKeydown: arrows move row focus, blurring the input,
// which commits; Space "clicks" the row) and the document-level Escape handler
// that would slam the whole panel shut. Blur commits, so clicking away keeps
// what was typed.
function _bmBindEditInput(input, commit) {
  input.addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', function () { commit(true); });
}

// \u2500\u2500 New folder (inline input, not prompt()) \u2500\u2500
function _bmNewFolderPrompt(parentId) {
  _bmCloseInlineInput();
  var host = document.getElementById('bm-tree');
  if (!host) { // empty state: rerender with a tree first
    _bmRerender();
    host = document.getElementById('bm-tree');
    if (!host) return;
  }
  var depth = 0;
  if (parentId) {
    var pr = host.querySelector('.bm-folder[data-fid="' + _cssEsc(parentId) + '"]');
    depth = pr ? (parseInt(pr.dataset.depth, 10) + 1) : 0;
  }
  var wrap = document.createElement('div');
  wrap.className = 'bm-row bm-newfolder';
  wrap.style.paddingLeft = (6 + depth * _BM_INDENT) + 'px';
  wrap.innerHTML = '<span class="bm-ficon">' + _BM_FOLDER_SVG + '</span>' +
    '<input class="bm-newfolder-input" type="text" placeholder="' + escAttr(t('bm_folder_name')) + '" maxlength="60">';
  // Insert at the top of the target parent's child region (root: top of tree).
  if (parentId) {
    var anchor = host.querySelector('.bm-folder[data-fid="' + _cssEsc(parentId) + '"]');
    if (anchor && anchor.nextSibling) host.insertBefore(wrap, anchor.nextSibling);
    else host.appendChild(wrap);
  } else {
    host.insertBefore(wrap, host.firstChild);
  }
  var input = wrap.querySelector('input');
  input.focus();
  var commit = function (save) {
    if (wrap._done) return; wrap._done = true;
    if (save) {
      var name = input.value.trim();
      if (name) { _folCreate(name, parentId); }
    }
    _bmRerender();
  };
  _bmBindEditInput(input, commit);
}
function _bmCloseInlineInput() {
  var ex = document.querySelector('.bm-newfolder, .bm-renaming');
  if (ex && ex.parentNode) ex.parentNode.removeChild(ex);
}

// \u2500\u2500 Inline rename (folders and bookmarks share one mechanism) \u2500\u2500
// Swap the row's .bm-name for an input; Enter/blur commit (apply gets the
// trimmed value, empty string included), Escape cancels. Semantics of an empty
// commit are the caller's call: folders keep their old name, bookmarks revert
// to the article's own title.
function _bmInlineRenameRow(row, value, apply) {
  if (!row) return;
  var nameEl = row.querySelector('.bm-name');
  if (!nameEl) return;
  var input = document.createElement('input');
  input.className = 'bm-rename-input';
  input.type = 'text'; input.value = value; input.maxLength = 60;
  nameEl.replaceWith(input);
  row.classList.add('bm-renaming');
  input.focus(); input.select();
  var done = function (save) {
    if (row._renDone) return; row._renDone = true;
    if (save) apply(input.value.trim());
    _bmRerender();
  };
  _bmBindEditInput(input, done);
}
function _bmRenameFolder(fid) {
  var f = _folById(fid);
  if (!f) return;
  var row = document.querySelector('.bm-folder[data-fid="' + _cssEsc(fid) + '"]');
  _bmInlineRenameRow(row, f.name, function (name) { if (name) _folRename(fid, name); });
}
function _bmRenameBookmark(zim, path) {
  var idx = _bkFind(zim, path);
  if (idx < 0) return;
  var b = _bkLoad()[idx];
  var row = document.querySelector('.bm-bk[data-zim="' + _cssEsc(zim) + '"][data-path="' + _cssEsc(path) + '"]');
  _bmInlineRenameRow(row, b.title || _titleFromPath(b.path), function (name) { _bkRename(zim, path, name); });
}

// \u2500\u2500 Delete (a non-empty folder asks what to do with its contents) \u2500\u2500
function _bmDeleteFolder(fid) {
  var f = _folById(fid);
  if (!f) return;
  var count = _folBookmarkCount(fid);
  var kids = _folChildren(fid).length;
  if (!count && !kids) { _folDelete(fid, 'promote'); _bmRerender(); return; }
  // Non-empty \u2192 offer Move-out vs Delete-all. Reuse the generic menu at center.
  // Deferred so the folder menu's own closeCtx (fired after this action) doesn't
  // immediately close the choice menu we're opening. A folder holding only
  // subfolders is counted in subfolders \u2014 "0 bookmarks" is not what's at stake.
  var note = count
    ? tH('bm_delete_folder_q', { name: f.name, n: count })
    : tH('bm_delete_folder_subs_q', { name: f.name, n: kids });
  var html = '<div class="ctx-note">' + note + '</div>' +
    '<div class="ctx-item" data-action="promote">' + tH('bm_delete_keep') + '</div>' +
    '<div class="ctx-item danger" data-action="purge">' + tH('bm_delete_all') + '</div>';
  var vw = window.innerWidth, vh = window.innerHeight;
  setTimeout(function () {
    window._openMenuAt(html, vw / 2 - 90, vh / 2 - 60, function (action) {
      if (action === 'promote') { _folDelete(fid, 'promote'); _bmRerender(); }
      else if (action === 'purge') { _folDelete(fid, 'contents'); _bmRerender(); }
    });
  }, 0);
}

// \u2500\u2500 Move to\u2026 submenu (flat, indented list of every folder + Root) \u2500\u2500
function _bmMoveSubmenuHtml(excludeFolderId) {
  // excludeFolderId (for moving a FOLDER) hides itself and its subtree so a
  // cycle can't be picked.
  var banned = {};
  if (excludeFolderId) {
    banned[_folNorm(excludeFolderId)] = 1;
    _folDescendants(excludeFolderId).forEach(function (d) { banned[d] = 1; });
  }
  var html = '<div class="ctx-item" data-action="mv-root">' + tH('bm_root') + '</div>';
  var walk = function (parentId, depth) {
    _folChildren(parentId).forEach(function (f) {
      if (banned[f.id]) return;
      html += '<div class="ctx-item" data-action="mv" data-fid="' + escAttr(f.id) + '"' +
        ' style="padding-left:' + (10 + depth * 12) + 'px"><span class="ctx-fico">' + _BM_FOLDER_SVG + '</span>' + esc(f.name) + '</div>';
      walk(f.id, depth + 1);
    });
  };
  walk(_BM_ROOT, 0);
  return html;
}

function _bmFolderMenu(fid, x, y) {
  var f = _folById(fid);
  if (!f) return;
  var html = '<div class="ctx-item" data-action="newsub">' + tH('bm_new_subfolder') + '</div>' +
    '<div class="ctx-item">' + tH('move_to') + ' \u203A<div class="ctx-sub">' + _bmMoveSubmenuHtml(fid) + '</div></div>' +
    '<div class="ctx-item" data-action="rename">' + tH('rename') + '</div>' +
    '<div class="ctx-sep"></div>' +
    '<div class="ctx-item" data-action="export">' + tH('bm_export_folder') + '</div>' +
    '<div class="ctx-sep"></div>' +
    '<div class="ctx-item danger" data-action="delete">' + tH('delete') + '</div>';
  window._openMenuAt(html, x, y, function (action, itemEl) {
    if (action === 'newsub') _bmNewFolderPrompt(fid);
    else if (action === 'rename') _bmRenameFolder(fid);
    else if (action === 'delete') _bmDeleteFolder(fid);
    else if (action === 'export') _bmOpenExport(fid);
    else if (action === 'mv-root') { _folReparent(fid, _BM_ROOT); _bmRerender(); }
    else if (action === 'mv') { _folReparent(fid, itemEl.dataset.fid); _bmRerender(); }
  });
}

function _bmBookmarkMenu(zim, path, x, y) {
  var row = document.querySelector('.bm-bk[data-zim="' + _cssEsc(zim) + '"][data-path="' + _cssEsc(path) + '"]');
  var missing = !!(row && row.classList.contains('bm-missing'));
  var html = (missing
      ? '<div class="ctx-note">' + tH('bm_source_missing') + '</div>'
      : '<div class="ctx-item" data-action="open">' + tH('open') + '</div>') +
    '<div class="ctx-item">' + tH('move_to') + ' \u203A<div class="ctx-sub">' + _bmMoveSubmenuHtml('') + '</div></div>' +
    '<div class="ctx-item" data-action="rename">' + tH('rename') + '</div>' +
    '<div class="ctx-sep"></div>' +
    '<div class="ctx-item danger" data-action="remove">' + tH('bm_remove') + '</div>';
  window._openMenuAt(html, x, y, function (action, itemEl) {
    if (action === 'open') { _closeLibraryPanel(); openArticle(zim, path, ''); }
    else if (action === 'rename') _bmRenameBookmark(zim, path);
    else if (action === 'remove') { _bkRemove(zim, path); _bmRerender(); }
    else if (action === 'mv-root') { _bkSetFolder(zim, path, _BM_ROOT); _bmRerender(); }
    else if (action === 'mv') { _bkSetFolder(zim, path, itemEl.dataset.fid); _bmRerender(); }
  });
}

// \u2500\u2500 Delegated interaction: click / contextmenu / pointer DnD + long-press \u2500\u2500
var _bmDrag = null;        // active drag state
var _bmLpTimer = null;     // touch long-press timer
var _bmPointerStart = null;

function _bmEnsureBound() {
  if (_bmBound) return;
  var panel = document.getElementById('history-panel');
  if (!panel) return;
  _bmBound = true;

  panel.addEventListener('click', function (e) {
    if (_getLibraryTab() !== 'bookmarks') return;
    var menuBtn = e.target.closest('.bm-gear');
    var row = e.target.closest('.bm-row');
    if (!row) return;
    // A row mid-edit acts as a form, not a row: a click inside it must neither
    // open the article nor toggle collapse (the input's blur already committed).
    if (row.classList.contains('bm-renaming') || row.classList.contains('bm-newfolder')) return;
    if (menuBtn) {
      e.preventDefault(); e.stopPropagation();
      var r = menuBtn.getBoundingClientRect();
      _bmOpenRowMenu(row, r.left, r.bottom + 2);
      return;
    }
    if (row.classList.contains('bm-folder')) {
      // Twist or anywhere on the folder row toggles collapse.
      _folToggleCollapse(row.dataset.fid);
      _bmRerender();
    } else if (row.classList.contains('bm-bk')) {
      if (row.classList.contains('bm-missing')) { _showToast(t('bm_source_missing')); return; }
      _closeLibraryPanel();
      openArticle(row.dataset.zim, row.dataset.path, row.querySelector('.bm-name') ? row.querySelector('.bm-name').textContent : '');
    }
  });

  panel.addEventListener('contextmenu', function (e) {
    if (_getLibraryTab() !== 'bookmarks') return;
    var row = e.target.closest('.bm-row');
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();  // keep the document-level closeCtx from closing what we just opened
    _bmOpenRowMenu(row, e.clientX + 2, e.clientY + 2);
  });

  // Pointer DnD + touch long-press. One handler set, both input types.
  panel.addEventListener('pointerdown', _bmPointerDown);
  panel.addEventListener('keydown', function (e) {
    if (_getLibraryTab() !== 'bookmarks') return;
    _bmTreeKeydown(e);
  });
  // Clicking a row makes it the tabbable one, so Tab returns where you were.
  panel.addEventListener('focusin', function (e) {
    var row = e.target.closest ? e.target.closest('.bm-row') : null;
    if (row) _bmFocusKey = _bmRowKey(row);
  });
}

function _bmOpenRowMenu(row, x, y) {
  if (row.classList.contains('bm-folder')) _bmFolderMenu(row.dataset.fid, x, y);
  else if (row.classList.contains('bm-bk')) _bmBookmarkMenu(row.dataset.zim, row.dataset.path, x, y);
}

function _bmPointerDown(e) {
  if (_getLibraryTab() !== 'bookmarks') return;
  if (e.button && e.button !== 0) return;  // primary button only — right-click opens the menu
  if (e.target.closest('.bm-gear') || e.target.closest('input')) return; // let buttons/inputs work
  var row = e.target.closest('.bm-row');
  if (!row || row.classList.contains('bm-newfolder') || row.classList.contains('bm-renaming')) return;
  var touch = e.pointerType === 'touch';
  _bmPointerStart = { x: e.clientX, y: e.clientY, row: row, id: e.pointerId, touch: touch, moved: false };
  document.addEventListener('pointermove', _bmPointerMove, { passive: false });
  document.addEventListener('pointerup', _bmPointerUp);
  document.addEventListener('pointercancel', _bmPointerUp);
  if (touch) {
    // Long-press-to-lift: hold 320ms without a scroll \u2192 drag mode + haptic.
    _bmLpTimer = setTimeout(function () {
      _bmLpTimer = null;
      if (_bmPointerStart && !_bmPointerStart.moved) {
        if (navigator.vibrate) { try { navigator.vibrate(8); } catch (_) {} }
        _bmBeginDrag(_bmPointerStart.row, _bmPointerStart.x, _bmPointerStart.y);
      }
    }, 320);
  }
}

function _bmBeginDrag(row, x, y) {
  var kind = row.classList.contains('bm-folder') ? 'folder' : 'bk';
  var ghost = document.createElement('div');
  ghost.className = 'bm-drag-ghost';
  ghost.textContent = (row.querySelector('.bm-name') || {}).textContent || '';
  document.body.appendChild(ghost);
  ghost.style.left = x + 'px'; ghost.style.top = y + 'px';
  row.classList.add('bm-dragging');
  _bmDrag = { kind: kind, row: row, ghost: ghost, liftX: x, liftY: y, movedSinceLift: false };
}

function _bmPointerMove(e) {
  if (!_bmPointerStart) return;
  var dx = e.clientX - _bmPointerStart.x, dy = e.clientY - _bmPointerStart.y;
  if (!_bmDrag) {
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      _bmPointerStart.moved = true;
      if (_bmPointerStart.touch) {
        // Movement before the hold fired = a scroll; let it be, cancel the lift.
        if (_bmLpTimer) { clearTimeout(_bmLpTimer); _bmLpTimer = null; _bmTeardownPointer(); }
        return;
      }
      _bmBeginDrag(_bmPointerStart.row, e.clientX, e.clientY);  // mouse: lift on move
    } else { return; }
  }
  e.preventDefault();
  _bmDrag.movedSinceLift = _bmDrag.movedSinceLift || Math.abs(e.clientX - _bmDrag.liftX) > 4 || Math.abs(e.clientY - _bmDrag.liftY) > 4;
  _bmDrag.x = e.clientX; _bmDrag.y = e.clientY;
  _bmDrag.ghost.style.left = e.clientX + 'px';
  _bmDrag.ghost.style.top = e.clientY + 'px';
  _bmUpdateDropTarget(e.clientX, e.clientY);
  _bmEdgeScroll(e.clientY);
}

// Hold the pointer near the top or bottom edge of the panel and the tree
// scrolls under it. Without this, a drop target more than one screen away from
// the lift point is simply unreachable — which is every real library.
var _BM_EDGE = 52;          // px from a panel edge that starts the scroll
var _BM_EDGE_STEP = 14;     // px per frame
var _bmEdgeTimer = null, _bmEdgeDir = 0;
function _bmEdgeScroll(y) {
  var panel = document.getElementById('history-panel');
  if (!panel) return;
  var r = panel.getBoundingClientRect();
  _bmEdgeDir = (y < r.top + _BM_EDGE) ? -1 : (y > r.bottom - _BM_EDGE) ? 1 : 0;
  if (!_bmEdgeDir) { _bmStopEdgeScroll(); return; }
  if (_bmEdgeTimer) return;
  _bmEdgeTimer = setInterval(function () {
    if (!_bmDrag) { _bmStopEdgeScroll(); return; }
    var before = panel.scrollTop;
    panel.scrollTop += _bmEdgeDir * _BM_EDGE_STEP;
    if (panel.scrollTop === before) { _bmStopEdgeScroll(); return; }  // hit an end
    _bmUpdateDropTarget(_bmDrag.x, _bmDrag.y);  // rows moved under a still pointer
  }, 16);
}
function _bmStopEdgeScroll() {
  if (_bmEdgeTimer) { clearInterval(_bmEdgeTimer); _bmEdgeTimer = null; }
  _bmEdgeDir = 0;
}

// Resolve what a drop at (x,y) would do and reflect it with indicator classes.
function _bmUpdateDropTarget(x, y) {
  _bmClearDropMarks();
  var el = document.elementFromPoint(x, y);
  var host = document.getElementById('bm-tree');
  if (!host) return;
  var row = el && el.closest ? el.closest('.bm-row') : null;
  if (row && (row === _bmDrag.row)) { _bmDrag.drop = null; return; }
  if (!row) {
    // Over the tree but not a row \u2192 drop into root (append).
    if (host.contains(el)) { host.classList.add('bm-drop-root'); _bmDrag.drop = { mode: 'into', fid: _BM_ROOT }; }
    else { _bmDrag.drop = null; }
    return;
  }
  var rect = row.getBoundingClientRect();
  var rel = (y - rect.top) / rect.height;
  if (row.classList.contains('bm-folder')) {
    if (_bmDrag.kind === 'bk') {
      // A bookmark can only ever go INSIDE a folder \u2014 bookmarks always sort
      // after folders within a parent, so "before this folder" has no meaning.
      // Show the one thing that can happen rather than a line that lies.
      row.classList.add('bm-drop-into');
      _bmDrag.drop = { mode: 'into', fid: row.dataset.fid };
      return;
    }
    // Dropping a folder into its own descendant is illegal \u2014 treat as reorder.
    var intoOk = !_folWouldCycle(_bmDrag.row.dataset.fid, row.dataset.fid);
    if (rel < 0.30 || !intoOk) {
      row.classList.add('bm-drop-before');
      _bmDrag.drop = { mode: 'before-folder', fid: row.dataset.fid };
    } else {
      row.classList.add('bm-drop-into');
      _bmDrag.drop = { mode: 'into', fid: row.dataset.fid };
    }
  } else if (_bmDrag.kind === 'folder') {
    // A folder over a bookmark resolves to that bookmark's folder \u2014 otherwise
    // every bookmark row is a dead zone that still draws a drop line.
    var into = _folNorm(row.dataset.fid);
    if (_folNorm(_folById(_bmDrag.row.dataset.fid).parent) === into ||
        _folWouldCycle(_bmDrag.row.dataset.fid, into)) { _bmDrag.drop = null; return; }
    _bmMarkFolderTarget(into);
    _bmDrag.drop = { mode: 'into', fid: into };
  } else {  // bookmark over bookmark \u2192 reorder within its folder (before / after)
    if (rel < 0.5) { row.classList.add('bm-drop-before'); _bmDrag.drop = { mode: 'before-bk', row: row }; }
    else { row.classList.add('bm-drop-after'); _bmDrag.drop = { mode: 'after-bk', row: row }; }
  }
}

// Highlight the row of the folder a drop would land in (the tree itself when
// that folder is root), so the target is never left to inference.
function _bmMarkFolderTarget(fid) {
  var host = document.getElementById('bm-tree');
  if (!host) return;
  if (_folNorm(fid) === _BM_ROOT) { host.classList.add('bm-drop-root'); return; }
  var row = host.querySelector('.bm-folder[data-fid="' + _cssEsc(fid) + '"]');
  if (row) row.classList.add('bm-drop-into');
}

function _bmClearDropMarks() {
  var host = document.getElementById('history-panel');
  if (!host) return;
  var tree = document.getElementById('bm-tree');
  if (tree) tree.classList.remove('bm-drop-root');
  host.querySelectorAll('.bm-drop-into,.bm-drop-before,.bm-drop-after').forEach(function (n) {
    n.classList.remove('bm-drop-into', 'bm-drop-before', 'bm-drop-after');
  });
}

function _bmPointerUp(e) {
  if (_bmLpTimer) { clearTimeout(_bmLpTimer); _bmLpTimer = null; }
  var drag = _bmDrag, start = _bmPointerStart;
  _bmTeardownPointer();
  if (!drag) return;  // was never lifted \u2192 a plain click/scroll, handled elsewhere
  if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
  drag.row.classList.remove('bm-dragging');
  _bmClearDropMarks();
  // Touch lift released in place without moving \u2192 show the context menu instead.
  if (start && start.touch && !drag.movedSinceLift) {
    _bmSwallowNextClick(drag.row);
    _bmOpenRowMenu(drag.row, start.x + 2, start.y + 2);
    _bmDrag = null;
    return;
  }
  _bmCommitDrop(drag);
  _bmDrag = null;
}

function _bmCommitDrop(drag) {
  var d = drag.drop;
  if (!d) return;
  if (d.mode === 'into') _folExpand(d.fid);  // never drop something into a folder that hides it
  if (drag.kind === 'bk') {
    var zim = drag.row.dataset.zim, path = drag.row.dataset.path;
    if (d.mode === 'into') _bkSetFolder(zim, path, d.fid);
    else if (d.mode === 'before-bk' || d.mode === 'after-bk') {
      var tgt = d.row;
      var destFid = tgt.dataset.fid;
      var beforeKey = null;
      if (d.mode === 'before-bk') beforeKey = tgt.dataset.zim + '\n' + tgt.dataset.path;
      else {
        // after \u2192 before the NEXT bookmark sibling in the same folder, if any
        var sibs = _bkInFolder(destFid);
        var ti = sibs.findIndex(function (b) { return b.zim === tgt.dataset.zim && b.path === tgt.dataset.path; });
        if (ti >= 0 && ti + 1 < sibs.length) beforeKey = sibs[ti + 1].zim + '\n' + sibs[ti + 1].path;
      }
      _bkSetFolder(zim, path, destFid, beforeKey);
    }
  } else {  // folder
    var fid = drag.row.dataset.fid;
    if (d.mode === 'into') _folReparent(fid, d.fid);
    else if (d.mode === 'before-folder') {
      var tf = _folById(d.fid);
      if (tf) {
        // reparent to the target's parent, then order before it
        if (_folNorm(tf.parent) !== _folNorm(_folById(fid).parent)) _folReparent(fid, tf.parent);
        _folReorder(fid, d.fid);
      }
    }
  }
  _bmRerender();
}

// A touch release fires a synthetic click a moment later. Left alone it lands on
// the row, and the document's outside-dismiss handler shuts the menu the
// long-press just opened — making the row menu unreachable by finger. Swallow
// that one click, but scope it to the pressed ROW: an early tap on a menu item
// (which sits outside the row) must still reach the menu, or opening then quickly
// choosing an action reads as flaky. Time-boxed and one-shot as a backstop.
var _BM_SYNTH_CLICK_MS = 400;
function _bmSwallowNextClick(row) {
  var until = Date.now() + _BM_SYNTH_CLICK_MS;
  var kill = function (e) {
    document.removeEventListener('click', kill, true);
    if (Date.now() < until && (!row || row.contains(e.target))) { e.preventDefault(); e.stopPropagation(); }
  };
  document.addEventListener('click', kill, true);
  setTimeout(function () { document.removeEventListener('click', kill, true); }, _BM_SYNTH_CLICK_MS);
}

function _bmTeardownPointer() {
  _bmStopEdgeScroll();
  document.removeEventListener('pointermove', _bmPointerMove);
  document.removeEventListener('pointerup', _bmPointerUp);
  document.removeEventListener('pointercancel', _bmPointerUp);
  _bmPointerStart = null;
}

function _pushArticleHistory(zim, path) {
  if (!zim || !path) return;
  // Use current document title if available (more accurate than URL-derived)
  var docTitle = document.title.replace(/ — Zimi$/, '');
  var fallback = _titleFromPath(path);
  var title = (docTitle && docTitle !== 'Zimi') ? docTitle : fallback;
  articleHistory.push({ zim: zim, path: path, title: title, timestamp: Date.now() });
  if (articleHistory.length > 50) articleHistory.shift();
}

// ── Bookmarks (localStorage) ──
var _bookmarks = null;
var _BK_KEY = SK.BOOKMARKS;
var _BK_MAX = 200;

function _bkLoad() {
  if (_bookmarks !== null) return _bookmarks;
  try { _bookmarks = JSON.parse(localStorage.getItem(_BK_KEY)) || []; }
  catch(e) { _bookmarks = []; }
  return _bookmarks;
}
function _bkSave() {
  if (!_bookmarks) return;
  try { localStorage.setItem(_BK_KEY, JSON.stringify(_bookmarks)); } catch(e) {}
}
function _bkFind(zim, path) {
  return _bkLoad().findIndex(function(b) { return b.zim === zim && b.path === path; });
}
function _bkIsBookmarked(zim, path) { return _bkFind(zim, path) >= 0; }
function _bkAdd(zim, path, title) {
  var bk = _bkLoad();
  if (_bkFind(zim, path) >= 0) return; // already bookmarked
  bk.unshift({ zim: zim, path: path, title: title || _titleFromPath(path), timestamp: Date.now() });
  if (bk.length > _BK_MAX) bk.length = _BK_MAX;
  _bkSave();
}
function _bkRemove(zim, path) {
  var idx = _bkFind(zim, path);
  if (idx >= 0) { _bkLoad().splice(idx, 1); _bkSave(); }
}
// Rename a bookmark. The record's `title` stays THE display field, so every
// consumer (tree rows, export-to-ZIM article titles, /userdata sync blob) sees
// the custom name with no extra plumbing; the article's own title moves to
// `origTitle` so an empty rename can restore it. Typing the original back is
// the same revert (origTitle cleared) rather than a no-op custom name.
function _bkRename(zim, path, name) {
  var idx = _bkFind(zim, path);
  if (idx < 0) return;
  var b = _bkLoad()[idx];
  var orig = (b.origTitle != null && b.origTitle !== '') ? b.origTitle : (b.title || _titleFromPath(b.path));
  if (name && name !== orig) { b.origTitle = orig; b.title = name; }
  else { delete b.origTitle; b.title = orig; }
  _bkSave();
}

// ── Bookmark folders (v2) ──────────────────────────────────────────────────
// Nested folders, arbitrary depth. Folders are their own records keyed by a
// generated id; each bookmark carries a `folder` id (null/"" = root) plus an
// `order` for intra-folder sort. Migration is implicit: a pre-v2 bookmark has
// no `folder` (→ root) and no `order` (→ falls back to timestamp-desc). Empty
// folders are representable (the whole reason folders are separate records).
// The two localStorage keys ride in the same /userdata + backup blob as
// BOOKMARKS (see _collectBrowserData). ROOT is the implicit null parent.
var _BM_ROOT = '';               // canonical root folder id
var _bmFolders = null;           // in-memory cache of the folders array

function _folLoad() {
  if (_bmFolders !== null) return _bmFolders;
  try { _bmFolders = JSON.parse(localStorage.getItem(SK.BM_FOLDERS)) || []; }
  catch (e) { _bmFolders = []; }
  if (!Array.isArray(_bmFolders)) _bmFolders = [];
  return _bmFolders;
}
function _folSave() {
  if (!_bmFolders) return;
  try { localStorage.setItem(SK.BM_FOLDERS, JSON.stringify(_bmFolders)); } catch (e) {}
}
function _folNorm(id) { return (id == null) ? _BM_ROOT : String(id); }
function _folById(id) {
  id = _folNorm(id);
  if (id === _BM_ROOT) return null;
  return _folLoad().find(function (f) { return f.id === id; }) || null;
}
function _folExists(id) { return _folNorm(id) === _BM_ROOT || !!_folById(id); }
// A stable, collision-resistant id — time in base36 plus a little randomness.
function _folNewId() {
  return 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}
// Child folders of `parentId`, ordered by `order` then name (case-insensitive).
function _folChildren(parentId) {
  parentId = _folNorm(parentId);
  return _folLoad().filter(function (f) { return _folNorm(f.parent) === parentId; })
    .sort(function (a, b) {
      var d = (a.order || 0) - (b.order || 0);
      return d || (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });
}
// The folder a bookmark actually lives in. A reference to a folder that no
// longer exists (a merge from a device that deleted it, or data written by a
// build that dropped a save) resolves to root, so such a bookmark stays
// reachable instead of disappearing from every folder at once.
function _bkFolderOf(b) {
  var id = _folNorm(b.folder);
  return _folExists(id) ? id : _BM_ROOT;
}
// Bookmarks directly inside `folderId`, ordered by `order` then timestamp-desc
// (so pre-v2 bookmarks — no order — keep their recency ordering).
function _bkInFolder(folderId) {
  folderId = _folNorm(folderId);
  return _bkLoad().filter(function (b) { return _bkFolderOf(b) === folderId; })
    .sort(function (a, b) {
      var ao = (a.order == null) ? Infinity : a.order;
      var bo = (b.order == null) ? Infinity : b.order;
      if (ao !== bo) return ao - bo;
      return (b.timestamp || 0) - (a.timestamp || 0);
    });
}
// Every descendant folder id of `id` (not including `id`) — for delete + the
// reparent cycle guard.
function _folDescendants(id) {
  var out = [], stack = _folChildren(id).map(function (f) { return f.id; });
  while (stack.length) {
    var cur = stack.pop();
    out.push(cur);
    _folChildren(cur).forEach(function (f) { stack.push(f.id); });
  }
  return out;
}
// True if `candidate` is `id` or an ancestor of it — a folder can't be moved
// into itself or its own subtree.
function _folWouldCycle(id, candidateParent) {
  candidateParent = _folNorm(candidateParent);
  if (candidateParent === _folNorm(id)) return true;
  return _folDescendants(id).indexOf(candidateParent) >= 0;
}
function _folNextOrder(parentId) {
  var kids = _folChildren(parentId);
  return kids.length ? (kids[kids.length - 1].order || 0) + 1 : 0;
}
function _bkNextOrder(folderId) {
  var items = _bkInFolder(folderId);
  var last = items[items.length - 1];
  var lo = last && last.order != null ? last.order : items.length - 1;
  return (items.length ? lo : -1) + 1;
}
function _folCreate(name, parentId) {
  name = (name || '').trim() || t('bm_untitled_folder');
  parentId = _folNorm(parentId);
  var rec = { id: _folNewId(), name: name, parent: parentId, order: _folNextOrder(parentId) };
  _folLoad().push(rec);
  _folSave();
  return rec.id;
}
function _folRename(id, name) {
  var f = _folById(id);
  if (!f) return;
  f.name = (name || '').trim() || f.name;
  _folSave();
}
// Reparent a folder. Returns false (no-op) when the move would create a cycle.
function _folReparent(id, newParent) {
  var f = _folById(id);
  if (!f) return false;
  newParent = _folNorm(newParent);
  if (_folWouldCycle(id, newParent)) return false;
  f.parent = newParent;
  f.order = _folNextOrder(newParent);
  _folSave();
  return true;
}
// Delete a folder. mode 'contents' removes its bookmarks + subfolders (deep);
// mode 'promote' lifts its bookmarks and child folders up to its own parent.
function _folDelete(id, mode) {
  var f = _folById(id);
  if (!f) return;
  var parent = _folNorm(f.parent);
  var subtree = _folDescendants(id).concat([id]);
  if (mode === 'promote') {
    _bkLoad().forEach(function (b) { if (_folNorm(b.folder) === _folNorm(id)) b.folder = parent; });
    _folChildren(id).forEach(function (c) { c.parent = parent; });
    _bmFolders = _folLoad().filter(function (x) { return x.id !== id; });
    _bkSave();  // the promoted bookmarks changed folder — persist, or they orphan
  } else {  // 'contents' (default): purge everything under this folder
    var kill = {};
    subtree.forEach(function (sid) { kill[sid] = 1; });
    _bookmarks = _bkLoad().filter(function (b) { return !kill[_folNorm(b.folder)]; });
    _bmFolders = _folLoad().filter(function (x) { return !kill[x.id]; });
    _bkSave();
  }
  _folSave();
}
// Move a bookmark into `folderId`. `beforeKey` (a _bookmarkKey) optionally
// places it right before that sibling; omitted → appended to the end.
function _bkSetFolder(zim, path, folderId, beforeKey) {
  var idx = _bkFind(zim, path);
  if (idx < 0) return;
  var bk = _bkLoad();
  var b = bk[idx];
  folderId = _folExists(folderId) ? _folNorm(folderId) : _BM_ROOT;
  b.folder = folderId;
  // Reorder within the destination: rebuild the ordered sibling list with `b`
  // inserted at the requested slot, then write back contiguous order values.
  var sibs = _bkInFolder(folderId).filter(function (x) { return x !== b; });
  var at = sibs.length;
  if (beforeKey) {
    var p = sibs.findIndex(function (x) { return _bookmarkKey(x) === beforeKey; });
    if (p >= 0) at = p;
  }
  sibs.splice(at, 0, b);
  sibs.forEach(function (x, i) { x.order = i; });
  _bkSave();
}
// Reorder a folder among its siblings, before `beforeId` (or append).
function _folReorder(id, beforeId) {
  var f = _folById(id);
  if (!f) return;
  var sibs = _folChildren(f.parent).filter(function (x) { return x.id !== id; });
  var at = sibs.length;
  if (beforeId) {
    var p = sibs.findIndex(function (x) { return x.id === beforeId; });
    if (p >= 0) at = p;
  }
  sibs.splice(at, 0, f);
  sibs.forEach(function (x, i) { x.order = i; });
  _folSave();
}
// Per-device collapse state (not synced — it's UI, not data).
function _folCollapsedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(SK.BM_COLLAPSED)) || []); }
  catch (e) { return new Set(); }
}
function _folIsCollapsed(id) { return _folCollapsedSet().has(_folNorm(id)); }
function _folSaveCollapsed(s) {
  try { localStorage.setItem(SK.BM_COLLAPSED, JSON.stringify(Array.from(s))); } catch (e) {}
}
function _folToggleCollapse(id) {
  var s = _folCollapsedSet();
  id = _folNorm(id);
  if (s.has(id)) s.delete(id); else s.add(id);
  _folSaveCollapsed(s);
}
function _folExpand(id) {
  var s = _folCollapsedSet();
  if (s.delete(_folNorm(id))) _folSaveCollapsed(s);
}
// Recursive count of bookmarks under a folder (self + descendants) — the badge.
function _folBookmarkCount(id) {
  var ids = [_folNorm(id)].concat(_folDescendants(id).map(_folNorm));
  var set = {}; ids.forEach(function (x) { set[x] = 1; });
  return _bkLoad().filter(function (b) { return set[_bkFolderOf(b)]; }).length;
}

// Export to ZIM: POST the client's bookmark list (server has no copy) and poll
// until the export ZIM is written and rescanned into the library.
// ── Tree export selector ─────────────────────────────────────────────────────
// A folder-tree checkbox picker. Grouping DECISION (v1.8.2): ONE ZIM per
// export, named by the user (the name field prefills from the selection).
// Every selected top-level folder becomes a SECTION inside that ZIM; nested
// selected subfolders keep their place as "Parent / Child" sections. A single
// selected folder keeps the old shape (its own bookmarks unsectioned, its
// subfolders as sections). An EMPTY selected folder still contributes its
// section header — a ticked folder is never silently dropped — and a selection
// with zero articles overall disables Export with a "nothing to export" note.
// Each ZIM carries the real article HTML + images + styling.
function _bmExportSelector(preFolderId) {
  _bmCloseExport();
  var rootBk = _bkInFolder(_BM_ROOT).length;
  var tree = '';
  // Opened from a folder's menu → just that subtree. Opened from the tab's
  // "Export to ZIM" → everything, matching what that button did before the
  // selector existed. Opening a picker with nothing ticked makes its own
  // primary button fail on the first press.
  var walk = function (parentId, depth) {
    _folChildren(parentId).forEach(function (f) {
      var checked = preFolderId
        ? (f.id === preFolderId || _folDescendants(preFolderId).indexOf(f.id) >= 0)
        : true;
      tree += '<label class="bm-exp-row" style="padding-left:' + (8 + depth * 16) + 'px">' +
        '<input type="checkbox" data-fid="' + escAttr(f.id) + '"' + (checked ? ' checked' : '') + '>' +
        '<span class="bm-exp-ico">' + _BM_FOLDER_SVG + '</span>' +
        '<span class="bm-exp-name">' + esc(f.name) + '</span>' +
        '<span class="bm-exp-count">' + _folBookmarkCount(f.id) + '</span></label>';
      walk(f.id, depth + 1);
    });
  };
  walk(_BM_ROOT, 0);
  if (rootBk) {
    tree += '<label class="bm-exp-row" style="padding-left:8px">' +
      '<input type="checkbox" data-fid="__unfiled__"' + (preFolderId ? '' : ' checked') + '>' +
      '<span class="bm-exp-ico">' + _BM_PAGE_SVG + '</span>' +
      '<span class="bm-exp-name">' + tH('bm_export_unfiled') + '</span>' +
      '<span class="bm-exp-count">' + rootBk + '</span></label>';
  }
  if (!tree) tree = '<div class="bm-exp-empty">' + tH('no_bookmarks') + '</div>';
  var ov = document.createElement('div');
  ov.className = 'bm-export-overlay';
  ov.id = 'bm-export-overlay';
  ov.innerHTML =
    '<div class="bm-export-modal" role="dialog" aria-modal="true" aria-label="' + escAttr(t('bm_export_title')) + '">' +
    '<div class="bm-export-head">' + tH('bm_export_title') + '</div>' +
    '<div class="bm-export-desc">' + tH('bm_export_desc') + '</div>' +
    '<div class="bm-export-tree" id="bm-export-tree">' + tree + '</div>' +
    '<label class="bm-export-name-row" for="bm-export-name">' + tH('bm_export_name_label') +
    '<input id="bm-export-name" type="text" maxlength="60" spellcheck="false" autocomplete="off"></label>' +
    '<div class="bm-export-count" id="bm-export-count"></div>' +
    '<div class="bm-export-status" id="bm-export-status"></div>' +
    '<div class="bm-export-actions">' +
    '<button class="hp-action-btn" id="bm-export-all" onclick="_bmExportToggleAll()"></button>' +
    '<span style="flex:1"></span>' +
    '<button class="hp-action-btn" onclick="_bmCloseExport()">' + tH('cancel') + '</button>' +
    '<button class="hp-action-btn primary" id="bm-export-go" onclick="_bmExportSubmit()">' + tH('bm_export_go') + '</button>' +
    '</div></div>';
  document.body.appendChild(ov);
  // Name prefills from the selection and keeps tracking it until the user
  // types; a manual edit pins it (the picker never overwrites user input).
  var nameInput = ov.querySelector('#bm-export-name');
  nameInput.value = _bmExportDefaultName();
  nameInput.addEventListener('input', function () { nameInput.dataset.dirty = '1'; });
  // Checking a folder auto-(un)checks its descendants; you can still uncheck one.
  ov.querySelector('#bm-export-tree').addEventListener('change', function (e) {
    var cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    if (cb.dataset.fid !== '__unfiled__') {
      _folDescendants(cb.dataset.fid).forEach(function (id) {
        var d = ov.querySelector('input[data-fid="' + _cssEsc(id) + '"]');
        if (d) d.checked = cb.checked;
      });
    }
    _bmExportSyncUI();
  });
  ov.addEventListener('click', function (e) { if (e.target === ov) _bmCloseExport(); });
  _bmExportSyncUI();
}
function _bmCloseExport() {
  clearTimeout(_exportPoll);
  var ov = document.getElementById('bm-export-overlay');
  if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
}
// One button for both directions — with the tree pre-ticked, a "Select all"
// that can only ever be a no-op is a dead control.
function _bmExportBoxes() {
  var ov = document.getElementById('bm-export-overlay');
  return ov ? Array.prototype.slice.call(ov.querySelectorAll('#bm-export-tree input[type=checkbox]')) : [];
}
function _bmExportToggleAll() {
  var boxes = _bmExportBoxes();
  var wantAll = boxes.some(function (cb) { return !cb.checked; });
  boxes.forEach(function (cb) { cb.checked = wantAll; });
  _bmExportSyncAllBtn();
}
function _bmExportSyncAllBtn() {
  var btn = document.getElementById('bm-export-all');
  if (!btn) return;
  var boxes = _bmExportBoxes();
  btn.textContent = boxes.length && boxes.every(function (cb) { return cb.checked; })
    ? t('select_none') : t('select_all');
}
// One pass that keeps the modal honest after every tick: the Select all/none
// label, the live article count, the name prefill (until user-edited) and the
// Export button. ZERO selected articles disables Export — an all-empty
// selection reads "nothing to export" instead of silently writing a husk.
function _bmExportSyncUI() {
  _bmExportSyncAllBtn();
  var ov = document.getElementById('bm-export-overlay');
  if (!ov) return;
  var nameInput = ov.querySelector('#bm-export-name');
  if (nameInput && !nameInput.dataset.dirty) nameInput.value = _bmExportDefaultName();
  var sel = _bmExportSelection();
  var picked = sel.ids.length > 0 || sel.unfiled;
  var n = _bmComposeExportJob(sel.ids, sel.unfiled, '').bookmarks.length;
  var countEl = ov.querySelector('#bm-export-count');
  if (countEl) countEl.textContent = tPlural('bm_count', n);
  var go = ov.querySelector('#bm-export-go');
  if (go) go.disabled = !n;
  var status = ov.querySelector('#bm-export-status');
  if (status) {
    status.style.color = picked && !n ? 'var(--amber)' : '';
    status.textContent = !picked ? t('bm_export_none_selected') : (!n ? t('bm_export_nothing') : '');
  }
}
// Checked folder ids in tree (DOM) order + the unfiled flag.
function _bmExportSelection() {
  var ids = [], unfiled = false;
  _bmExportBoxes().forEach(function (cb) {
    if (!cb.checked) return;
    if (cb.dataset.fid === '__unfiled__') unfiled = true;
    else ids.push(cb.dataset.fid);
  });
  return { ids: ids, unfiled: unfiled };
}
// Client mirror of the server's _safe_name (manage.py): the characters a ZIM
// filename base may carry. Used only for the prefill/preview; the server
// re-sanitizes what it receives.
function _bmSanitizeZimName(s) {
  s = String(s == null ? '' : s).replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[_.]+/, '').replace(/[_.]+$/, '');
  return s.slice(0, 60);
}
function _bmHasSelectedAncestor(fid, selSet) {
  var f = _folById(fid);
  var p = f ? _folNorm(f.parent) : _BM_ROOT;
  while (p !== _BM_ROOT) {
    if (selSet[p]) return true;
    var pf = _folById(p);
    p = pf ? _folNorm(pf.parent) : _BM_ROOT;
  }
  return false;
}
// The name the picker suggests: the folder's own name when exactly one
// top-level folder is ticked, otherwise plain "Bookmarks".
function _bmExportDefaultName() {
  var sel = _bmExportSelection();
  var selSet = {};
  sel.ids.forEach(function (id) { selSet[id] = 1; });
  var roots = sel.ids.filter(function (id) {
    return _folById(id) && !_bmHasSelectedAncestor(id, selSet);
  });
  if (roots.length === 1 && !sel.unfiled) return _folById(roots[0]).name;
  return 'Bookmarks';
}
// Compose THE export job (one ZIM per export — see the grouping decision
// above). `ids` = checked folder ids in tree order, `unfiled` = loose
// bookmarks ticked, `nameRaw` = the user's name-field text. Empty selected
// folders still land in `sections` so the ZIM index shows them honestly.
function _bmComposeExportJob(ids, unfiled, nameRaw) {
  var selSet = {};
  ids.forEach(function (id) { selSet[id] = 1; });
  var roots = ids.filter(function (id) {
    return _folById(id) && !_bmHasSelectedAncestor(id, selSet);
  });
  var single = roots.length === 1 && !unfiled;
  var bms = [];
  var sections = [];
  var addSection = function (name) {
    if (name && sections.indexOf(name) < 0) sections.push(name);
  };
  roots.forEach(function (rootId) {
    var rootName = _folById(rootId).name;
    var queue = [rootId];
    while (queue.length) {
      var cur = queue.shift();
      var isSelf = (cur === rootId);
      var secName = single
        ? (isSelf ? '' : _folById(cur).name)
        : (isSelf ? rootName : rootName + ' / ' + _folById(cur).name);
      addSection(secName);
      _bkInFolder(cur).forEach(function (b) {
        bms.push({ zim: b.zim, path: b.path, title: b.title || '', section: secName });
      });
      _folChildren(cur).forEach(function (c) { if (selSet[c.id]) queue.push(c.id); });
    }
  });
  if (unfiled) {
    _bkInFolder(_BM_ROOT).forEach(function (b) {
      bms.push({ zim: b.zim, path: b.path, title: b.title || '', section: '' });
    });
  }
  var title = String(nameRaw || '').trim().slice(0, 120);
  return {
    name: _bmSanitizeZimName(title) || null,
    title: title || null,
    sections: sections,
    bookmarks: bms,
  };
}
function _bmExportSubmit() {
  var sel = _bmExportSelection();
  var nameEl = document.getElementById('bm-export-name');
  var job = _bmComposeExportJob(sel.ids, sel.unfiled, nameEl ? nameEl.value : '');
  var status = document.getElementById('bm-export-status');
  var go = document.getElementById('bm-export-go');
  if (!sel.ids.length && !sel.unfiled) {
    if (status) { status.textContent = t('bm_export_none_selected'); status.style.color = 'var(--amber)'; }
    return;
  }
  if (!job.bookmarks.length) {
    if (status) { status.textContent = t('bm_export_nothing'); status.style.color = 'var(--amber)'; }
    return;
  }
  if (go) go.disabled = true;
  if (status) { status.style.color = ''; status.textContent = t('save_to_zim_working'); }
  manageFetch('/manage/export-bookmarks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exports: [job] }),
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (res && res.error) { _bmExportModalFail(); return; }
    _bmPollExport();
  }).catch(_bmExportModalFail);
}
function _bmExportModalFail() {
  var status = document.getElementById('bm-export-status');
  var go = document.getElementById('bm-export-go');
  if (go) go.disabled = false;
  if (status) { status.textContent = t('save_to_zim_failed'); status.style.color = 'var(--amber)'; }
}
function _bmPollExport() {
  clearTimeout(_exportPoll);
  manageFetch('/manage/export-bookmarks').then(function (r) { return r.json(); }).then(function (st) {
    var status = document.getElementById('bm-export-status');
    if (st.phase === 'running') {
      if (status) status.textContent = t('save_to_zim_working') + (st.total ? ' (' + st.done + '/' + st.total + ')' : '');
      _exportPoll = setTimeout(_bmPollExport, 600);
    } else if (st.phase === 'done') {
      var files = (st.files && st.files.length) ? st.files : (st.file ? [st.file] : []);
      if (status) { status.style.color = '#34d399'; status.textContent = tPlural('bm_export_done', files.length); }
      // Close the modal shortly, then reveal the first new ZIM in the library.
      setTimeout(function () { _bmCloseExport(); _revealExportedZim(files[0]); }, 900);
    } else if (st.phase === 'error') {
      _bmExportModalFail();
    }
  }).catch(_bmExportModalFail);
}

var _exportPoll = null;
// After a successful bookmark export, pull the refreshed library list (the
// server already rescanned the new file into its cache), re-render the home
// library so the new source's card exists, close the library panel so it's
// visible, then scroll to the card and give it a brief highlight pulse.
async function _revealExportedZim(file) {
  if (!file) return;
  try {
    zimsCache = await _fetchList();
    _rebuildZimsMap();
  } catch (e) { return; }
  var z = (zimsCache || []).find(function(x) { return x.file === file; });
  var name = z ? z.name : file.replace(/\.zim$/, '');
  if (!readerOpen && !currentSource && !readerSource) {
    try { renderHome(); } catch (e) {}
  }
  _closeLibraryPanel();
  // Defer so the freshly rendered cards + the panel close settle first.
  setTimeout(function() {
    var sel = '.stat-card[data-zim="' + _cssEsc(name) + '"]';
    var card = document.querySelector(sel);
    if (!card) return;
    try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { try { card.scrollIntoView(); } catch (e2) {} }
    card.classList.add('zimi-just-added');
    setTimeout(function() { card.classList.remove('zimi-just-added'); }, 2600);
  }, 120);
}
function toggleBookmark() {
  if (!currentArticle) return;
  var zim = currentArticle.zim, path = currentArticle.path;
  var title = document.title.replace(/ — Zimi$/, '');
  if (title === 'Zimi' || !title) title = _titleFromPath(path);
  if (_bkIsBookmarked(zim, path)) {
    _bkRemove(zim, path);
  } else {
    _bkAdd(zim, path, title);
  }
  _updateLibraryBtnIcon();
}
var _libClockSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
var _libBookmarkSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
var _libBookmarkFilledSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
function _getLibraryTab() { return localStorage.getItem(SK.LIBRARY_TAB) || 'history'; }
function _setLibraryTab(tab) { localStorage.setItem(SK.LIBRARY_TAB, tab); }
function _updateLibraryBtnIcon() {
  var btn = document.getElementById('library-btn');
  if (!btn) return;
  var tab = _getLibraryTab();
  if (readerOpen && currentArticle && _bkIsBookmarked(currentArticle.zim, currentArticle.path)) {
    btn.innerHTML = _libBookmarkFilledSvg;
    btn.style.color = 'var(--amber)';
    btn.title = t('bookmarked_remove');
  } else if (readerOpen) {
    btn.innerHTML = _libBookmarkSvg;
    btn.style.color = '';
    btn.title = t('bookmark_add');
  } else {
    // On the home grid the library button OPENS the panel. It carries the one
    // library glyph — the same glyph the reader's bm-panel-btn carries — so
    // "open the library" looks identical wherever you are (Eric: consistent
    // icon on home and in zims). The open tab no longer changes the icon.
    btn.innerHTML = _libClockSvg;
    btn.style.color = '';
    btn.title = t('library');
  }
  // Keep the reader's panel opener on the very same glyph, so it reads as
  // "open the library" and never as a second bookmark button next to the
  // add-bookmark toggle (library-btn) beside it.
  var panelBtn = document.getElementById('bm-panel-btn');
  if (panelBtn) {
    panelBtn.innerHTML = _libClockSvg;
    // The GLYPH is shared with library-btn on purpose (above). The name is
    // not: this one opens the panel on the BOOKMARKS tab, under B. It used to
    // be handed t('library') along with the icon, so its tooltip read
    // "Library (H)" — the wrong name and a shortcut belonging to a different
    // button — while its aria-label still said Bookmarks. Two names for one
    // control, and neither audience got the true one.
    panelBtn.title = t('bookmarks');
  }
}
function openArticle(zim, path, title, opts) {
  // Any normal article open cancels a pending "return to almanac" intent; the
  // almanac deep-link path re-stamps it immediately after this call returns.
  _almReturnScroll = null;
  // Modifier-click: always open in new browser tab
  if (_isModClick()) {
    _lastMouseEvent = null;
    var p = _splitPathFragment(path);
    var url = '/w/' + encodeURIComponent(zim) + '/' + p.base.split('/').map(encodeURIComponent).join('/') + '?view=1' + p.frag;
    window.open(url, '_blank');
    return;
  }
  // Save discover scroll position before navigating away
  var discScroll = document.querySelector('.discover-scroll');
  if (discScroll && discScroll.scrollLeft > 0) {
    try { sessionStorage.setItem('zimi_disc_scroll', String(Math.round(discScroll.scrollLeft))); } catch(e) {}
  }
  var url = _articleUrl(zim, path);
  readerSource = zim;
  // EPUB: download (Gutenberg has HTML equivalents for all EPUBs)
  var lurl = url.toLowerCase();
  if (lurl.endsWith('.epub')) {
    var extUrl = location.origin + url + '?raw=1';
    _downloadFile(extUrl);
    return;
  }
  // Track article history: push current article before navigating away
  if (currentArticle) _pushArticleHistory(currentArticle.zim, currentArticle.path);
  currentArticle = { zim: zim, path: path };
  // Start interlang prefetch immediately (don't wait for iframe load)
  _prefetchArticleLangs();
  // Persist to browse history (localStorage)
  _histPushArticle(zim, path, title || _titleFromPath(path));
  // Address bar always carries the SPA's canonical deep-link form (?a=<zim>/<path>),
  // never the raw /w/ content URL. A /w/<zim>/<path> URL is served as the BARE ZIM
  // article (no Zimi chrome), so leaving one in the bar strands the user in a
  // headerless page on reload. The ?a= form always reboots full SPA chrome (route()),
  // and being a query on '/', not a '.pdf' path, it also sidesteps the PDF
  // raw-binary-on-reload hazard the old ?view=1 kludge guarded against.
  var canonUrl = _articleDeepLinkPath(zim, path);
  var st = { mode: 'reader', zim: zim, path: path };
  // Deep-link boot replaces the boot entry so the history stack is exactly
  // [article] — browser Back then leaves the site instead of surfacing a phantom
  // home the user never visited.
  if (opts && opts.replace) history.replaceState(st, '', canonUrl);
  else history.pushState(st, '', canonUrl);
  // PDF: route through pdf.js viewer (renders in reader iframe like any article)
  if (lurl.endsWith('.pdf')) {
    url = _pdfViewerUrl(url);
  }
  openReader(url);
  // Use explicit title if provided (e.g. from catalog or search results),
  // fall back to deriving from the URL path segment
  var readerTitle = title || _titleFromPath(path);
  if (readerTitle) {
    var t2 = readerTitle + ' — Zimi';
    document.title = t2;
    _setWindowTitle(t2);
  }
}

function closeReader() {
  if (!readerOpen) return;
  _ttsStop(); // stop read-aloud when leaving the reader
  // Sync the address bar back to the view the reader was covering — an
  // explicit close otherwise strands the article URL (a reload would
  // reopen the closed article). On popstate-driven closes the history
  // has already moved, so state.mode is no longer 'reader' and this
  // block is skipped.
  if (history.state && history.state.mode === 'reader') {
    var query = q.value.trim();
    if (mode === 'search' && query) {
      var scope = currentSource || null;
      var searchUrl = scope ? '/w/' + encodeURIComponent(scope) + '?q=' + encodeURIComponent(query) : '/?q=' + encodeURIComponent(query);
      history.replaceState({ mode: 'search', query: query, source: scope }, '', searchUrl);
    } else if (mode === 'source' && currentSource) {
      history.replaceState({ mode: 'source', source: currentSource }, '', '/w/' + encodeURIComponent(currentSource));
    } else {
      history.replaceState({ mode: 'home' }, '', '/');
    }
  }
  readerOpen = false;
  readerSource = null;
  currentArticle = null;
  articleHistory = [];
  _manageSavedReader = null; // discard saved state when reader is explicitly closed
  document.getElementById('reader').classList.remove('open');
  // Use location.replace to avoid adding a history entry (iframe.src pollutes back button)
  var f = document.getElementById('reader-frame');
  try { f.contentWindow.location.replace('about:blank'); } catch(e) { f.src = 'about:blank'; }
  mainView.classList.remove('hidden');
  // Restore main document scroll (iOS tap-to-top for home page)
  document.documentElement.style.overflowY = 'auto';
  _articleLangData = null; _articleLangKey = '';
  updateTopbar();
  _setWindowTitle('Zimi');
}


// ── Language selector dropdown ──

// Cached article-language data for current article (prefetched when reader opens)
var _articleLangData = null; // {languages: [{lang, zim, path}], available: [{lang, catalog_name}]}
var _articleLangKey = '';    // "zim:path" key to invalidate cache on article change

function _prefetchArticleLangs() {
  // Skip if language chooser is hidden (no dropdown to show interlang in)
  if (_getStorageFlag(SK.HIDE_LANG_CHOOSER)) return;
  if (!currentArticle) { _articleLangData = null; _articleLangKey = ''; return; }
  var key = currentArticle.zim + ':' + currentArticle.path;
  if (key === _articleLangKey) return; // already cached
  _articleLangKey = key;
  _articleLangData = null;
  fetch('/article-languages?zim=' + encodeURIComponent(currentArticle.zim) + '&path=' + encodeURIComponent(currentArticle.path))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (_articleLangKey === key) {
        _articleLangData = data;
        // Re-render dropdown if visible (updates interlang icons after data arrives)
        var _dd = document.getElementById('lang-dropdown');
        if (_dd && _dd.classList.contains('visible')) _renderLangDropdown();
      }
    })
    .catch(function() {});
}

function _renderLangDropdown() {
  var dd = document.getElementById('lang-dropdown');
  if (!dd) return;
  var h = '';
  // Map article-language data to UI language codes for quick lookup
  var switchMap = {}; // {langCode: {zim, path}} — languages where current article exists
  if (readerOpen && _articleLangData) {
    var langs = _articleLangData.languages || [];
    for (var ai = 0; ai < langs.length; ai++) {
      var al = langs[ai];
      switchMap[al.lang] = { zim: al.zim, path: al.path };
    }
  }

  var switchIcon = '<svg class="ld-switch-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' +
    '<path d="M4 6l-3 3 3 3"/><path d="M1 9h10"/><path d="M12 10l3-3-3-3"/><path d="M15 7H5"/></svg>';

  var inReader = readerOpen && currentArticle;

  // When reading article in a different language than UI: show quick switch at top
  var zimInfo = inReader && _zimInfo(currentArticle.zim);
  var articleLang = zimInfo ? zimInfo.language : null;
  if (inReader && articleLang && articleLang !== _currentLang && switchMap[_currentLang]) {
    var sl = _AVAILABLE_LANGS.find(function(ll) { return ll.code === _currentLang; });
    var sName = sl ? sl.name : _currentLang;
    var sw = switchMap[_currentLang];
    var targetPath = sw.path.replace(/^A\//, '').replace(/_/g, ' ');
    try { targetPath = decodeURIComponent(targetPath); } catch(e) {}
    h += '<div class="lang-dropdown-item switchable" onclick="_langSwitchArticle(\'' + escJs(sw.zim) + '\',\'' + escJs(sw.path) + '\')">' +
      '<span class="ld-switch-label"><span class="ld-switch-lang">' + esc(tH('view_in_lang', {lang: sName})) + '</span>' +
      '<span class="ld-switch-article">' + esc(targetPath) + '</span></span>' +
      '<span class="ld-switch">' + switchIcon + '</span></div>';
    h += '<div class="ld-divider"></div>';
  }

  // Show loading indicator when interlang data hasn't arrived yet
  if (inReader && !_articleLangData) {
    h += '<div class="lang-dropdown-item" style="color:var(--text2);font-size:12px;justify-content:center"><span class="spinner-inline" style="width:14px;height:14px"></span></div>';
    h += '<div class="ld-divider"></div>';
  }

  // All languages — click name to switch UI language; interlang icon inline when article has translation
  for (var i = 0; i < _AVAILABLE_LANGS.length; i++) {
    var l = _AVAILABLE_LANGS[i];
    var active = l.code === _currentLang ? ' active' : '';
    var right = '';
    if (l.code === _currentLang) {
      right = '<span class="check">\u2713</span>';
    } else if (inReader && switchMap[l.code]) {
      // Article exists in this language — show inline switch icon
      right = '<span class="ld-interlang" onclick="event.stopPropagation();_langSwitchArticle(\'' +
        escJs(switchMap[l.code].zim) + '\',\'' + escJs(switchMap[l.code].path) + '\')" title="' +
        escAttr(t('view_in_lang', {lang: l.name})) + '">' + switchIcon + '</span>';
    }
    h += '<div class="lang-dropdown-item' + active + '" onclick="_selectLang(\'' + l.code + '\')">' +
      '<span>' + esc(l.name) + '</span>' + right + '</div>';
  }

  // Download suggestion: only for the current UI language's Wikipedia, if not installed
  if (inReader && manageEnabled) {
    var isWiki = zimInfo && /^wikipedia/i.test(zimInfo.name || '');
    if (isWiki) {
      var dlLang = _AVAILABLE_LANGS.find(function(l) { return l.code === _currentLang; });
      if (dlLang) {
        var hasMainWiki = (zimsCache || []).some(function(z) {
          return z.language === dlLang.code && /^wikipedia(_[a-z]{2,3})?$/i.test(z.name);
        });
        if (!hasMainWiki) {
          h += '<div class="ld-divider"></div>';
          h += '<div class="lang-dropdown-item ld-download" onclick="_langDropdownGetWiki(\'' + dlLang.code + '\')">' +
            '<span>' + esc(tH('download_lang_wiki', {lang: dlLang.name})) + '</span>' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg></div>';
        }
      }
    }
  }
  dd.innerHTML = h;
}

function _langDropdownGetWiki(lang) {
  _closeLangDropdown();
  manageTab = 'browse';
  // Strict prefix: "wikipedia_fr_all" matches only the main encyclopedia, not medicine/wp1 subsets
  _pendingDrill = { catKey: 'wikipedia', lang: lang, namePrefix: 'wikipedia_' + lang + '_all' };
  enterManage();
}

function _langSwitchArticle(zim, path) {
  _closeLangDropdown();
  openArticle(zim, path);
}

async function _selectLang(code) {
  // If already on this language, just close
  if (code === _currentLang) { _closeLangDropdown(); return; }
  _langDropdownLocked = true;
  // Check if we have a direct article match from prefetched data
  var directMatch = null;
  if (readerOpen && currentArticle && _articleLangData) {
    var langs = _articleLangData.languages || [];
    for (var ai = 0; ai < langs.length; ai++) {
      if (langs[ai].lang === code) { directMatch = langs[ai]; break; }
    }
  }
  try {
    await setLanguage(code);
  } finally {
    _langDropdownLocked = false;
  }
  _closeLangDropdown();
  // Navigate directly to the article in the new language if we have a match
  if (directMatch) {
    openArticle(directMatch.zim, directMatch.path);
  }
}

function toggleLangDropdown(event) {
  event.stopPropagation();
  // Force a fresh prefetch if we don't have data yet
  if (readerOpen && currentArticle && !_articleLangData) {
    _articleLangKey = ''; // Reset key to force refetch
  }
  _prefetchArticleLangs();
  var dd = document.getElementById('lang-dropdown');
  if (dd.classList.contains('visible')) {
    _closeLangDropdown();
    return;
  }
  _renderLangDropdown();
  var btn = document.getElementById('lang-selector-btn');
  var rect = btn.getBoundingClientRect();
  // On mobile the lang button is hidden (display:none) — fall back to the ... menu button
  if (rect.width === 0) {
    var moreBtn = document.querySelector('.topbar-more');
    if (moreBtn) rect = moreBtn.getBoundingClientRect();
  }
  dd.style.top = (rect.bottom + 4) + 'px';
  var isRTL = document.documentElement.getAttribute('dir') === 'rtl';
  if (isRTL) {
    dd.style.left = Math.max(4, rect.left) + 'px';
    dd.style.right = 'auto';
  } else {
    dd.style.right = Math.max(4, window.innerWidth - rect.right) + 'px';
    dd.style.left = 'auto';
  }
  dd.classList.add('visible');
  // Dismiss on outside interaction (iframe taps included). Clicks inside the
  // dropdown are ignored by the helper; a transient locked state vetoes the
  // close (returns false) so the listener keeps watching. Keep the selector
  // button "inside" for a clean second-tap toggle.
  _langDropdownDetach = _dismissOnOutside([dd, btn], function() {
    if (_langDropdownLocked) return false;
    _closeLangDropdown();
  });
}

var _langDropdownLocked = false;
var _langDropdownDetach = null;
function _closeLangDropdown() {
  if (_langDropdownLocked) return;
  document.getElementById('lang-dropdown').classList.remove('visible');
  if (_langDropdownDetach) { _langDropdownDetach(); _langDropdownDetach = null; }
}

// ── Mobile topbar overflow menu ──
// Single source of truth for the mobile breakpoint (matches the max-width:600px
// media query that shows the ... menu and hides the inline secondary actions).
// Also decides which rows the ... menu owns: on a wide viewport the inline
// Random/Language/Manage buttons are still visible, so the menu must not
// re-list them.
function _isNarrow() {
  return !!(window.matchMedia && window.matchMedia('(max-width: 600px)').matches);
}

// Compact SVGs reused by the reader controls when they migrate into the ... menu.
var _TBM_TTS_ICON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
var _TBM_NEWTAB_ICON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
// The same + the inline button draws, at menu-row weight.
var _TBM_CREATE_ICON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

// Keep the font + TTS menu rows (if the menu is open) in sync with live state.
// _cycleReaderFont / _ttsSetSpeaking call this so the label updates in place
// without closing the menu.
function _syncTopbarMenuReaderItems() {
  var rvItem = document.getElementById('tbm-readerview');
  if (rvItem) {
    rvItem.setAttribute('aria-checked', _readerViewOn ? 'true' : 'false');
    var sw = rvItem.querySelector('.rv-switch');
    if (sw) sw.classList.toggle('on', _readerViewOn);
  }
  var ttsItem = document.getElementById('tbm-tts');
  if (ttsItem) {
    ttsItem.setAttribute('aria-pressed', _ttsSpeaking ? 'true' : 'false');
    var lbl = ttsItem.querySelector('.tbm-label');
    if (lbl) lbl.textContent = t(_ttsSpeaking ? 'tts_stop' : 'tts_speak');
  }
}

// Rebuild the ⋯ menu contents in place (used when a control inside it — the
// Reader View switch — flips state and the row set must change without closing).
function _readerViewMenuToggle() {
  _readerViewToggle();
  _rebuildTopbarMenu();
}
// Repaint the ⋯ menu in place (only while it's open) so a control inside it can
// flip state and change the row set without closing the menu.
function _rebuildTopbarMenu() {
  var menu = document.getElementById('topbar-menu');
  if (menu && menu.classList.contains('visible')) menu.innerHTML = _buildTopbarMenuHtml();
}

// Single source of truth for the ⋯ menu markup, so both the initial open and an
// in-place rebuild (Reader View toggled) render identical structure.
function _buildTopbarMenuHtml() {
  var h = '';
  // The ⋯ menu holds whatever is hidden from the inline topbar in the current
  // state, in two groups separated by a divider:
  //   • Reader controls — folded in whenever an article is open (mobile always;
  //     desktop while reading, where body.reading CSS hides the inline reader
  //     buttons). Reader View toggle first; its compact controls under it when
  //     on; then Read aloud; then Open in browser last.
  //   • App navigation (Random / Language / Manage) — only when the topbar is
  //     collapsed (mobile), where those inline buttons are hidden. On a wide
  //     viewport they stay inline, so listing them here too would duplicate them.
  var readerGroup = '';
  if (readerOpen && !_almanacOpen) {
    var rvAvail = _readerViewAvailable();
    var rvOn = _readerViewOn && rvAvail;
    // 1. Reader View toggle — always first. A switch: tapping flips it and the
    // menu rebuilds in place (compact controls appear/disappear beneath).
    if (rvAvail) {
      readerGroup += '<button class="topbar-menu-item tbm-rv-toggle" id="tbm-readerview" role="switch" aria-checked="' + (rvOn ? 'true' : 'false') +
        '" onclick="event.stopPropagation();_readerViewMenuToggle()">' + _READER_VIEW_ICON +
        ' <span class="tbm-label">' + tH('reader_view') + '</span>' +
        '<span class="rv-switch' + (rvOn ? ' on' : '') + '" aria-hidden="true"><span class="rv-knob"></span></span></button>';
    }
    // 2. Compact settings directly under the toggle when Reader View is on —
    // theme swatches + font/size only, no title labels, no AUTO (settings-only).
    if (rvOn) {
      readerGroup += '<div class="tbm-reader-settings">' + _readerCompactControlsHtml() + '</div>';
    }
    // 3. Read aloud.
    if (_TTS_AVAILABLE) {
      readerGroup += '<button class="topbar-menu-item" id="tbm-tts" aria-pressed="' + (_ttsSpeaking ? 'true' : 'false') +
        '" onclick="event.stopPropagation();_ttsToggle()">' + _TBM_TTS_ICON +
        ' <span class="tbm-label">' + tH(_ttsSpeaking ? 'tts_stop' : 'tts_speak') + '</span></button>';
    }
    // 4. Open in browser — LAST, and only where it's meaningful: the desktop app
    // or an installed/standalone PWA. In a plain browser tab you're already in a
    // browser, so it's hidden. Opens the ?a= deep link (full Zimi chrome).
    if (IS_DESKTOP || _isStandalonePWA()) {
      readerGroup += '<button class="topbar-menu-item" onclick="_closeTopbarMenu();_openInBrowser()">' + _TBM_NEWTAB_ICON +
        ' ' + tH('open_in_browser') + '</button>';
    }
  }

  // App-navigation group — only when the topbar is collapsed (mobile). On a wide
  // viewport Random / Language / Manage stay inline, so re-listing them here
  // would double them up (the desktop reader duplication bug).
  var navGroup = '';
  // Create a ZIM — a ⋯ menu row at EVERY width (there is no inline + button):
  // creation is an occasional act, so it lives out of the way but first in the
  // list. Visible on the home screen to an admin/creator; _createCanShow()
  // carries the boot-time hint, so the row is there on a cold load instead of
  // appearing a second later. The /#create URL keeps working regardless.
  if (_createMenuRowAvailable()) {
    navGroup += '<button class="topbar-menu-item" onclick="_closeTopbarMenu();openCreate()">' +
      _TBM_CREATE_ICON + ' ' + tH('create_zim') + '</button>';
  }
  // The Create page hides the inline Random/Language/gear buttons at every
  // width, so while it is open the ⋯ menu must carry the nav group even on a
  // wide viewport — otherwise a desktop admin has no route to Manage at all.
  if (_isNarrow() || _createOpen) {
    navGroup += '<button class="topbar-menu-item" onclick="_closeTopbarMenu();randomArticle(event)"><span class="dice" style="font-size:16px">&#x1F3B2;</span> ' + tH('random') + '</button>';
    if (!_getStorageFlag(SK.HIDE_LANG_CHOOSER)) navGroup += '<button class="topbar-menu-item" onclick="_closeTopbarMenu();toggleLangDropdown(event)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="3" ry="6.5"/><line x1="1.5" y1="8" x2="14.5" y2="8"/></svg> ' + tH('language') + '</button>';
    // Manage row: while downloads are active, carry the count and route the tap
    // straight to the downloads view (the badge on the ⋯ button is only a dot).
    var _mgSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    var _dlN = _activityBadge.count;
    var _mgClick = _dlN > 0 ? '_openDownloadsView(event)' : '_closeTopbarMenu();toggleManage(event)';
    var _mgCount = _dlN > 0 ? '<span class="tbm-count">' + (_dlN > 99 ? '99+' : _dlN) + '</span>' : '';
    // Single account door: Manage. There is no separate "Sign in" — an
    // unauthenticated visitor who taps Manage gets the unified sign-in modal
    // (named user OR admin), and a signed-in user lands on their minimal account
    // card (name, access, log out). See manageFetch's 401 handler + renderManage.
    if (_userSession) {
      navGroup += '<div class="topbar-menu-divider" role="separator"></div>';
      navGroup += '<div class="topbar-menu-label">' + tH('signed_in_as') + ' ' + esc(_userSession.name) + '</div>';
      navGroup += '<button class="topbar-menu-item" onclick="_closeTopbarMenu();toggleManage(event)">' + _ACCT_ICON + ' ' + tH('manage') + '</button>';
    } else {
      navGroup += '<button class="topbar-menu-item" onclick="' + _mgClick + '">' + _mgSvg + ' ' + tH('manage') + _mgCount + '</button>';
    }
  }

  h = readerGroup;
  // Divider only when both groups are present, so neither a reader-only (desktop)
  // nor a nav-only (mobile home) menu ends up with a stray separator.
  if (readerGroup && navGroup) h += '<div class="topbar-menu-divider" role="separator"></div>';
  h += navGroup;
  return h;
}

// ── The one-item rule ────────────────────────────────────────────────────────
// An overflow menu that would hold exactly ONE plain action is no menu at all
// ("No ⋯ menu for a single item"): the trigger becomes that action — its icon,
// its label, its click — and goes back to being ⋯ the moment a second row
// exists. The rule is structural (it counts what the builder would render), so
// any future state that leaves one row inherits it. Rows that are not plain
// actions — a switch, a settings block, a signed-in label — keep the menu:
// they need its chrome to live in.
function _topbarMenuSoloItem() {
  var probe = document.createElement('div');
  probe.innerHTML = _buildTopbarMenuHtml();
  if (probe.querySelector('.tbm-reader-settings, .topbar-menu-label, [role="switch"]')) return null;
  var items = probe.querySelectorAll('.topbar-menu-item');
  return items.length === 1 ? items[0] : null;
}

// The trigger's stock ⋯ face, captured from the markup the first time so the
// restore path never hard-codes what index.html renders.
var _topbarMoreDefault = null;
var _topbarMoreIsSolo = false;
function _syncTopbarMoreSolo(btn) {
  if (!_topbarMoreDefault) {
    // Clone-and-strip: the activity badge is a child _applyActivityBadge owns;
    // baking a serialized copy of it into the stock face would duplicate it.
    var stock = btn.cloneNode(true);
    var badge = stock.querySelector('.topbar-badge');
    if (badge) badge.remove();
    _topbarMoreDefault = {
      html: stock.innerHTML,
      aria: btn.getAttribute('data-i18n-aria'),
      label: btn.getAttribute('aria-label') || 'More'
    };
  }
  var solo = _topbarMenuSoloItem();
  if (solo) {
    var label = (solo.textContent || '').trim();
    var icon = solo.querySelector('svg, .dice');
    btn.innerHTML = icon ? icon.outerHTML : _topbarMoreDefault.html;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    // Park the i18n hook: the language applier would stamp "More" back over
    // the action's own name on the next language pass.
    btn.removeAttribute('data-i18n-aria');
    btn.onclick = function(e) { e.stopPropagation(); solo.click(); };
    _topbarMoreIsSolo = true;
  } else if (_topbarMoreIsSolo) {
    btn.innerHTML = _topbarMoreDefault.html;
    btn.title = '';
    btn.setAttribute('aria-label', _topbarMoreDefault.label);
    if (_topbarMoreDefault.aria) btn.setAttribute('data-i18n-aria', _topbarMoreDefault.aria);
    // The solo assignment shadowed the inline attribute handler; hand the
    // stock behaviour back explicitly.
    btn.onclick = _toggleTopbarMenu;
    _topbarMoreIsSolo = false;
  }
}

function _toggleTopbarMenu(event) {
  event.stopPropagation();
  var menu = document.getElementById('topbar-menu');
  if (menu.classList.contains('visible')) {
    menu.classList.remove('visible');
    return;
  }
  var html = _buildTopbarMenuHtml();
  if (!html) return; // nothing to show (e.g. desktop reader with no foldable controls)
  menu.innerHTML = html;
  menu.classList.add('visible');
  // Close on outside interaction — including a tap inside the reader iframe,
  // which a plain document listener never sees. The ⋯ trigger is kept "inside"
  // so a second tap toggles the menu shut via its own handler.
  _topbarMenuDetach = _dismissOnOutside(
    [menu, document.querySelector('.topbar-more')], _closeTopbarMenu);
}
var _topbarMenuDetach = null;
function _closeTopbarMenu() {
  var menu = document.getElementById('topbar-menu');
  if (menu) menu.classList.remove('visible');
  if (_topbarMenuDetach) { _topbarMenuDetach(); _topbarMenuDetach = null; }
}

// ── Bookmark migration for renamed ZIMs ──

function _migrateBookmarks() {
  // Check if any bookmarks/history reference old ZIM names and update them
  // This runs once on startup when ZIM names have changed (e.g. wikipedia → wikipedia_fr)
  if (!zimsCache || zimsCache.length === 0) return;
  var knownNames = new Set(zimsCache.map(function(z) { return z.name; }));
  var migrated = false;

  // Migrate browsing history and bookmarks
  [[SK.BROWSE_HISTORY, 'migrated'], [SK.BOOKMARKS, 'bmMigrated']].forEach(function(pair) {
    var items = _getStorageJSON(pair[0], []);
    var changed = false;
    items.forEach(function(item) {
      if (item.zim && !knownNames.has(item.zim)) {
        var candidates = zimsCache.filter(function(z) { return z.name.startsWith(item.zim + '_') || z.name === item.zim; });
        if (candidates.length === 1) { item.zim = candidates[0].name; changed = true; }
      }
    });
    if (changed) _setStorageJSON(pair[0], items);
    if (pair[0] === SK.BROWSE_HISTORY && changed) migrated = true;
  });
}

// ── Random ──
async function randomArticle(event) {
  if (event) event.preventDefault();
  if (_createOpen) closeCreate();
  if (_almanacOpen) closeAlmanac();
  if (mode === 'manage') { mode = 'home'; updateTopbar(); }
  var btn = document.getElementById('random-btn');
  if (btn._randomBusy) return;
  btn._randomBusy = true;
  btn.classList.add('rolling');
  try {
    var zimParam = currentSource ? '?zim=' + encodeURIComponent(currentSource) : '';
    // Unscoped rolls retry a couple of times — right after startup the
    // ZIM list/archives may not be warm yet and the first roll can 500
    // or come back empty; a silent no-op reads as a dead button.
    var attempts = currentSource ? 1 : 3;
    for (var i = 0; i < attempts; i++) {
      var res = await fetch('/random' + zimParam);
      var data = await res.json().catch(function() { return {error: 'bad json'}; });
      if (!data.error) { openArticle(data.zim, data.path, data.title); return; }
      if (i < attempts - 1) await new Promise(function(r) { setTimeout(r, 400); });
    }
    // Fallback for zimgit/PDF ZIMs: pick random doc from catalog
    if (currentSource) {
      var catRes = await fetch('/catalog?zim=' + encodeURIComponent(currentSource));
      var catData = await catRes.json();
      if (catData.documents && catData.documents.length) {
        var docs = catData.documents.filter(function(d) { return d.path; });
        if (docs.length) {
          var pick = docs[Math.floor(Math.random() * docs.length)];
          openArticle(currentSource, pick.path, pick.title);
          return;
        }
      }
    }
    // Current source failed — try global random
    if (currentSource) {
      res = await fetch('/random');
      data = await res.json();
      if (!data.error) { openArticle(data.zim, data.path, data.title); }
    }
  } catch(e) {
    console.warn('Random article failed:', e);
  } finally {
    btn.classList.remove('rolling');
    btn._randomBusy = false;
  }
}

// ── Keyboard ──
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    // Topmost popovers first — otherwise Escape falls through to goBack()/close
    // and dumps a keyboard user out of the reader instead of shutting the popover.
    if (_definePopover && _definePopover.classList.contains('open')) { _defineHide(); return; }
    var _rp = document.getElementById(_READER_PALETTE_ID);
    if (_rp && _rp.classList.contains('visible')) { _closeReaderPalette(); return; }
    var _tm = document.getElementById('topbar-menu');
    if (_tm && _tm.classList.contains('visible')) { _closeTopbarMenu(); return; }
    var _ld = document.getElementById('lang-dropdown');
    if (_ld && _ld.classList.contains('visible')) { _closeLangDropdown(); return; }
    var _hp = document.getElementById('history-panel');
    if (_hp && _hp.classList.contains('open')) { _closeLibraryPanel(); return; }
    if (suggestDropdown.style.display !== 'none') { hideSuggest(); return; }
    if (_createOpen) { closeCreate(); return; }
    if (_almanacOpen) { closeAlmanac(); return; }
    if (readerOpen) { goBack(); return; }
    if (q.value) { q.value = ''; hideSuggest(); clearSearch(); return; }
    if (mode === 'manage' && _manageSavedReader) { _manageToken = ''; history.back(); return; }
    if (mode === 'source' || mode === 'manage') { enterHome(true); return; }
    return;
  }
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === '/' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); _searchFocusedByUser = true; q.focus(); }
  if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey && mode !== 'manage') { e.preventDefault(); randomArticle(e); }
  if (e.key === 'h' && !e.metaKey && !e.ctrlKey && !e.altKey && mode !== 'manage') { e.preventDefault(); toggleLibraryPanel('history'); }
  if (e.key === 'b' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (readerOpen) { toggleBookmark(); _updateLibraryBtnIcon(); }
    else if (mode !== 'manage') toggleLibraryPanel('bookmarks');
  }
});

// ── History ──
window.addEventListener('popstate', (e) => {
  hideSuggest();
  _hideHistoryTrail();
  if (_createOpen) { closeCreate(); return; }
  // Close Space if open
  if (_almanacOpen) { closeAlmanac(); return; }
  // Restore reader when navigating back from manage view
  if (mode === 'manage' && _manageSavedReader) {
    _manageToken = '';
    _restoreSavedReader();
    return;
  }
  // Step through article history when reader is open (mirrors in-app back button)
  if (readerOpen && articleHistory.length > 0) {
    _stepBackToArticle(articleHistory.pop(), false);
    return;
  }
  if (readerOpen) closeReader();
  q.value = '';
  activeCategories.clear();
  activeSourceFilters.clear();
  sourceAutoReader = false;
  // Route based on state, not URL (avoids re-opening reader on back)
  var s = e.state;
  if (s && s.mode === 'home' && s.scope) {
    enterScope(s.scope.type, s.scope.label, s.scope.zimNames, false);
  } else if (s && s.mode === 'home') {
    enterHome(false);
  } else if (s && s.mode === 'search' && s.query) {
    // Going back to search results — restore cached results instantly if available
    if (s.source) {
      _popstateNoAutoReader = true;
      enterSource(s.source, false);
      _popstateNoAutoReader = false;
    } else {
      mode = 'search'; currentSource = null; sourceAutoReader = false;
      sourceHeaderEl.style.display = 'none';
      mainView.classList.remove('hidden');
    }
    q.value = s.query;
    if (allResults && allResults._query === s.query && (allResults.results || []).length > 0) {
      // Instant restore from in-memory cache
      renderSearchResults(allResults, currentSource);
      updateTopbar();
    } else {
      doSearch(s.query, false);
    }
  } else if (s && s.mode === 'reader' && s.zim) {
    // Going back to a reader state — show the source page, don't re-open reader
    _popstateNoAutoReader = true;
    enterSource(s.zim, false);
    _popstateNoAutoReader = false;
  } else if (s && s.mode === 'source' && s.source) {
    // Going back to source — show source page, don't auto-open reader
    _popstateNoAutoReader = true;
    enterSource(s.source, false);
    _popstateNoAutoReader = false;
  } else if (s && s.mode === 'almanac') {
    // Back from an almanac-originated article — reopen the almanac at its spot.
    if (typeof _reopenAlmanacFromLink === 'function') _reopenAlmanacFromLink();
    else route(false);
  } else {
    // Fallback: route from URL
    route(false);
  }
});

// ── Util ──
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function escAttr(s) { return esc(s).replace(/'/g, '&#39;').replace(/"/g, '&quot;'); }
// Escape a value for use inside a CSS attribute selector. Generated ids and ZIM
// names reach querySelector all over the app; older engines lack CSS.escape.
function _cssEsc(s) { s = String(s == null ? '' : s); return (window.CSS && CSS.escape) ? CSS.escape(s) : s; }
// Escape for JS string literal inside HTML onclick attribute (survives HTML decode then JS parse)
// Escape a value for a JS string literal INSIDE an onclick="..." attribute.
// The result is parsed as HTML first, so quotes/&/< are emitted as HTML
// entities (not backslash escapes) — that's what lets JSON.stringify(...)
// arguments survive into the handler intact.
function escJs(s) { return (s || '').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/'/g, "\\'").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

// ── Desktop app integration (pywebview) ──
// pywebview injects window.pywebview AFTER page load, so we can't check at parse time.
// Instead, listen for the 'pywebviewready' event and set IS_DESKTOP then.
let IS_DESKTOP = false;

// ── Modifier-click detection ──
// Track last mousedown so openArticle() can detect cmd/ctrl/middle-click
// even from inline onclick="" handlers that don't pass the event.
var _lastMouseEvent = null;
var _lastMouseTime = 0;
document.addEventListener('mousedown', function(e) {
  _lastMouseEvent = e;
  _lastMouseTime = Date.now();
}, true);
function _isModClick() {
  var e = _lastMouseEvent;
  if (!e) return false;
  // Stale check: ignore if mousedown was >500ms ago (e.g. keyboard-triggered)
  if (Date.now() - _lastMouseTime > 500) return false;
  return e.metaKey || e.ctrlKey || e.button === 1;
}

// ── Real-anchor SPA navigation (#49) ──
// Primary navigation with a true URL is a real <a href>, so the browser's own
// link affordances work: right-click → open in new tab, middle-click,
// cmd/ctrl/shift-click, copy link, drag. Only a plain left click is
// intercepted for in-app navigation.
function _anchorNativeClick(e) {
  return !!(e && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey ||
    (e.button != null && e.button !== 0)));
}
// Inline-handler shim: `onclick="return _spaNav(event, fn)"` — true lets the
// browser follow the href natively, false cancels it after running the SPA
// navigation instead.
function _spaNav(e, fn) {
  if (_anchorNativeClick(e)) return true;
  e.preventDefault();
  fn();
  return false;
}
// Anchor-card variants reading the data-* the card already carries, so the
// zim/path/title triple isn't escaped into the markup a second time.
function _spaCardClick(e, el) {
  return _spaNav(e, function () {
    openArticle(el.getAttribute('data-zim'), el.getAttribute('data-path'), el.getAttribute('data-title') || '');
  });
}
function _spaSourceClick(e, el) {
  return _spaNav(e, function () { enterSource(el.getAttribute('data-zim'), true); });
}

// ── Middle-click (auxclick) handler for search results, discover cards, etc. ──
// onclick doesn't fire on middle-click — auxclick does.
document.addEventListener('auxclick', function(e) {
  if (e.button !== 1) return; // Only handle middle-click
  var el = e.target.closest('[data-zim][data-path]');
  if (!el) return;
  // Real-link cards (#49): the browser's own middle-click already opens the
  // href (the SPA deep link) — don't shadow it with a second tab.
  if (el.tagName === 'A' && el.hasAttribute('href')) return;
  e.preventDefault();
  var zim = el.getAttribute('data-zim');
  var path = el.getAttribute('data-path');
  // Always open in new browser tab
  var url = '/w/' + encodeURIComponent(zim) + '/' + path.split('/').map(encodeURIComponent).join('/') + '?view=1';
  window.open(url, '_blank');
});

// ── Link Context Menu ──
var _linkCtxMenu = document.getElementById('link-ctx-menu');
var _linkCtxData = null; // {zim, path, title, url}

function _showLinkCtxMenu(x, y, data) {
  _linkCtxData = data;
  var isMac = /Mac/.test(navigator.platform);
  var mod = isMac ? '\u2318' : 'Ctrl+';
  var items = '';
  if (!IS_DESKTOP) {
    items += '<div class="zimi-ctx-item" onclick="_ctxOpenNewWindow()">' + tH('open_new_tab') + '<span class="ctx-key">' + mod + 'Click</span></div>';
  }
  items += '<div class="zimi-ctx-item" onclick="_ctxCopyLink()">' + tH('copy_link') + '</div>';
  if (data.title) {
    items += '<div class="zimi-ctx-item" onclick="_ctxCopyTitle()">' + tH('copy_title') + '</div>';
  }
  _linkCtxMenu.innerHTML = items;
  _linkCtxMenu.classList.add('open');
  // Position: keep within viewport
  var rect = _linkCtxMenu.getBoundingClientRect();
  var menuW = _linkCtxMenu.offsetWidth || 200;
  var menuH = _linkCtxMenu.offsetHeight || 100;
  if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 8;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8;
  _linkCtxMenu.style.left = x + 'px';
  _linkCtxMenu.style.top = y + 'px';
}

function _hideLinkCtxMenu() {
  _linkCtxMenu.classList.remove('open');
  _linkCtxData = null;
}

function _ctxOpenNewWindow() {
  var data = _linkCtxData;
  _hideLinkCtxMenu();
  if (!data) return;
  var url = data.url || ('/w/' + encodeURIComponent(data.zim) + '/' + data.path.split('/').map(encodeURIComponent).join('/'));
  window.open(url, '_blank');
}

function _ctxCopyLink() {
  var data = _linkCtxData;
  _hideLinkCtxMenu();
  if (!data) return;
  var url = data.url || (location.origin + '/w/' + encodeURIComponent(data.zim) + '/' + data.path.split('/').map(encodeURIComponent).join('/'));
  navigator.clipboard.writeText(url).catch(function() {});
}

function _ctxCopyTitle() {
  var data = _linkCtxData;
  _hideLinkCtxMenu();
  if (!data) return;
  navigator.clipboard.writeText(data.title).catch(function() {});
}

// ── Word lookup (Define) ──
// Select or double-tap a word in the reader → a small "Define" popover; tapping
// it pulls the first definition from the best installed wiktionary ZIM (one
// /suggest + one article fetch). Entirely dormant — zero UI — when no
// wiktionary ZIM is installed.
var _definePopover = document.getElementById('define-popover');
var _defineState = null; // {word, zim, path} of the active lookup
var _defineDebounce = null;
// A right-click can create/keep a selection that reaches selectionchange, which
// would pop the Define trigger next to the native context menu. Set on
// contextmenu, cleared by the next primary (left) mousedown, and honored in
// _defineConsider so a right-click-originated selection never offers Define.
var _defineSuppressChip = false;
var _DEFINE_BOOK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
var _DEFINE_MAX_WORD = 40;
var _DEFINE_MAX_CHARS = 600; // cap on extracted definition length

// Two-letter language prefix for loose matching ('eng'→'en', 'en-US'→'en').
function _defineLang2(l) { return (l || '').toLowerCase().slice(0, 2); }

// Pick the best installed wiktionary ZIM for an article language. Preference:
// article language → UI language → English → any wiktionary. Returns the ZIM
// info object or null (→ feature dormant).
function _defineFindWiktionary(articleLang) {
  var wikts = (zimsCache || []).filter(function(z) {
    return z && z.name && /wiktionary/i.test(z.name);
  });
  if (!wikts.length) return null;
  var prefs = [_defineLang2(articleLang), _defineLang2(_currentLang), 'en'];
  for (var i = 0; i < prefs.length; i++) {
    if (!prefs[i]) continue;
    for (var j = 0; j < wikts.length; j++) {
      if (_defineLang2(wikts[j].language) === prefs[i]) return wikts[j];
    }
  }
  return wikts[0]; // best-effort: some wiktionary beats none
}

function _defineIsWord(s) {
  if (!s) return false;
  s = s.trim();
  if (!s || s.length > _DEFINE_MAX_WORD) return false;
  if (/\s/.test(s)) return false;           // single word only (v1)
  return /[\p{L}]/u.test(s);                 // must contain a letter
}

// Touch/coarse-pointer devices (iOS, Android) get the system's own text-
// selection callout (Copy / Look Up / …), which our chip must stay clear of —
// mouse/trackpad devices have no such overlay so their layout is untouched.
function _defineIsTouch() {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
}
var _DEFINE_TOUCH_DELAY = 350;  // ms — let the OS callout's own animation settle first
var _DEFINE_TOUCH_MARGIN = 14;  // px gap below the selection, clear of the callout's tail
var _DEFINE_NEAR_TOP_PX = 120;  // selection this close to the viewport top leaves iOS no
                                 // room to place its callout above, so it flips below —
                                 // mirror that by flipping our chip above instead

// Range rect in PARENT-window coords (iframe offset + range rect). Shared by the
// selection path and tap-to-define, which each have a Range in hand.
function _defineRangeRect(frame, range) {
  try {
    var r = range.getBoundingClientRect();
    var fr = frame.getBoundingClientRect();
    var margin = _defineIsTouch() ? _DEFINE_TOUCH_MARGIN : 4;
    return { x: r.left + fr.left, y: r.bottom + fr.top + margin, top: r.top + fr.top };
  } catch (e) { return null; }
}
function _defineSelRect(frame, sel) {
  try { return _defineRangeRect(frame, sel.getRangeAt(0)); } catch (e) { return null; }
}

function _definePosition(rect) {
  if (!rect) return;
  _definePopover.classList.add('open');
  var w = _definePopover.offsetWidth || 200;
  var h = _definePopover.offsetHeight || 60;
  var vw = window.innerWidth, vh = window.innerHeight, M = 8;
  var x = rect.x, y = rect.y;
  // On touch, the OS callout normally renders ABOVE the selection (our chip
  // defaults below it, via the margin in _defineRangeRect) — but near the top
  // of the viewport iOS has no room above and flips its callout below instead,
  // so flip our chip above to stay out of its way.
  if (_defineIsTouch() && rect.top < _DEFINE_NEAR_TOP_PX) {
    y = rect.top - h - _DEFINE_TOUCH_MARGIN;
  }
  // Flip above the selection if it would overflow the bottom.
  if (y + h > vh - M) y = rect.top - h - M;
  // Hard clamp to the viewport on all four edges — a selection near any edge (or
  // a card that grew taller/wider than the chip) must never spill off-screen.
  x = Math.max(M, Math.min(x, vw - w - M));
  y = Math.max(M, Math.min(y, vh - h - M));
  _definePopover.style.left = x + 'px';
  _definePopover.style.top = y + 'px';
}

// Re-run positioning against the anchor rect stored at trigger time. Called after
// the popover's content swaps (chip → loading → card), since the card is taller
// and wider than the chip and would otherwise keep the chip's coordinates and
// spill off-screen.
function _defineReposition() {
  if (_defineState && _defineState.rect) _definePosition(_defineState.rect);
}

function _defineHide() {
  if (!_definePopover) return;
  _definePopover.classList.remove('open');
  _definePopover.innerHTML = '';
  _defineState = null;
}

// Any scroll — inside the article iframe or the outer page — invalidates the
// popover's anchor, so dismiss it. Cheap no-op when nothing is open.
function _defineHideOnScroll() {
  if (_definePopover && _definePopover.classList.contains('open')) _defineHide();
}

// Stage 1 — show the "Define" trigger next to the selected word.
function _defineShowTrigger(frame, word, wikt, rect) {
  _defineState = { word: word, zim: wikt.name, path: null, rect: rect };
  _definePopover.innerHTML = '<div class="define-trigger" onclick="_defineRun()">' +
    _DEFINE_BOOK_ICON + '<span>' + tH('define') + '</span></div>';
  _definePosition(rect);
}

// Stage 2 — run the lookup (one /suggest + one article fetch) and render.
function _defineRun() {
  var st = _defineState;
  if (!st) return;
  _definePopover.innerHTML = '<div class="define-card"><div class="define-word">' +
    esc(st.word) + '</div><div class="define-status">' + tH('define_loading') +
    '</div></div>';
  _defineReposition(); // the card is bigger than the chip — re-clamp to viewport
  var q = st.word;
  fetch('/suggest?q=' + encodeURIComponent(q.toLowerCase()) + '&limit=6&zim=' + encodeURIComponent(st.zim))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var hits = (data && data[st.zim]) || [];
      // Prefer an exact case-insensitive title match (wiktionary entries are
      // lowercase words), else the raw word, else the first suggestion.
      var hit = null, ql = q.toLowerCase();
      for (var i = 0; i < hits.length; i++) {
        if ((hits[i].title || '').toLowerCase() === ql) { hit = hits[i]; break; }
      }
      if (!hit) hit = hits[0];
      if (!hit) { _defineRenderMiss(st.word); return; }
      st.path = hit.path;
      return fetch(_articleUrl(st.zim, hit.path) + '?raw=1')
        .then(function(r) { return r.text(); })
        .then(function(html) { _defineRenderResult(st, hit, html); });
    })
    .catch(function() { _defineRenderMiss(st.word); });
}

function _defineRenderMiss(word) {
  if (!_defineState) return;
  _definePopover.innerHTML = '<div class="define-card"><div class="define-word">' +
    esc(word) + '</div><div class="define-status">' + tH('define_no_results') +
    '</div></div>';
  _defineReposition();
}

// Pull the first definition block(s) from a wiktionary article's raw HTML.
// Pragmatic: the first ordered list under the parser output holds the senses;
// take its first few items, dropping nested examples/quotations.
function _defineExtract(html) {
  try {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var root = doc.querySelector('.mw-parser-output') || doc.body;
    if (!root) return '';
    var ol = root.querySelector('ol');
    if (ol) {
      var out = doc.createElement('ol');
      var items = ol.querySelectorAll(':scope > li');
      for (var i = 0; i < items.length && i < 4; i++) {
        var li = items[i].cloneNode(true);
        // Drop nested example/quotation/synonym blocks — senses only.
        li.querySelectorAll('ul, dl, ol, .h-usage-example, .citation-whole').forEach(function(n) { n.remove(); });
        var txt = (li.textContent || '').trim();
        if (!txt) continue;
        var nli = doc.createElement('li');
        nli.textContent = txt.length > 200 ? txt.slice(0, 200) + '…' : txt;
        out.appendChild(nli);
      }
      if (out.children.length) return out.outerHTML;
    }
    // Fallback: first meaningful paragraph.
    var p = root.querySelector('p');
    if (p) {
      var pt = (p.textContent || '').trim();
      if (pt) return '<p>' + esc(pt.slice(0, _DEFINE_MAX_CHARS)) + '</p>';
    }
  } catch (e) {}
  return '';
}

function _defineRenderResult(st, hit, html) {
  if (!_defineState || _defineState.word !== st.word) return; // superseded
  var body = _defineExtract(html);
  var lang = _defineLang2(_zimInfo(st.zim) && _zimInfo(st.zim).language);
  var head = '<div class="define-word">' + esc(st.word) +
    (lang ? ' <span class="define-lang">' + esc(lang) + '</span>' : '') + '</div>';
  var content = body
    ? '<div class="define-body">' + body + '</div>'
    : '<div class="define-status">' + tH('define_no_results') + '</div>';
  _definePopover.innerHTML = '<div class="define-card">' + head + content +
    '<a class="define-open" onclick="_defineOpenFull()">' + tH('define_open_full') + '</a></div>';
  _defineReposition(); // final card size known — re-clamp so it can't spill off-screen
}

function _defineOpenFull() {
  var st = _defineState;
  _defineHide();
  if (st && st.zim && st.path) openArticle(st.zim, st.path);
}

// Consider the current selection inside the reader iframe; show or hide the
// trigger accordingly. Debounced from the noisy selectionchange event.
function _defineConsider(frame) {
  if (!readerOpen || !_definePopover) return;
  if (_defineSuppressChip) return; // selection came from a right-click — no trigger
  var doc, sel;
  try { doc = frame.contentDocument; sel = frame.contentWindow.getSelection(); }
  catch (e) { return; } // cross-origin ZIM — feature can't reach the selection
  if (!sel || sel.isCollapsed) { _defineHide(); return; }
  var word = sel.toString().trim();
  if (!_defineIsWord(word)) { _defineHide(); return; }
  var wikt = _defineFindWiktionary(_ttsLang(doc));
  if (!wikt) return; // dormant: no wiktionary installed
  var rect = _defineSelRect(frame, sel);
  if (rect) _defineShowTrigger(frame, word, wikt, rect);
}

// ── Consent walls that the archive rebuilds ──
//
// The capture engines strip a blocking overlay when they serialize a page, but
// the ALIVE engine cannot: it records the WARC before serialization on purpose
// (serializing mutates the page, and the recording is meant to hold what the
// site did, not what Zimi provoked), then warc2zim replays those responses with
// the site's own JavaScript still running. That JS rebuilds the modal every
// time the ZIM is opened. Alive's whole promise is that the scripts still run,
// so the fix cannot be "stop running them" — it has to happen here, in the
// document, after they have run.
//
// Same rule as the renderer's, for the same reason and with the same limits:
// `fixed` only (a sticky masthead is page furniture and stays), covering most
// of the viewport, plus empty fixed boxes of any size — an ad slot whose ad was
// blocked at capture time, which renders as a black bar over the headline.
//
// This removes; it never clicks. No consent is given, no cookie is set, no
// request is sent. The element being deleted is one whose buttons call scripts
// that no longer exist.
var OVERLAY_VIEWPORT_SHARE = 0.55;   // must match renderer.py's constant
var OVERLAY_WATCH_MS = 15000;        // how long a rebuilt wall still gets caught

// What a site calls the grey box it shows while waiting for a fetch. In an
// archive that fetch never happens, so the box is a promise of content that
// cannot arrive — it pulses at the reader forever, which is what Eric saw on a
// captured CNN front page. Conventional names, matched on a substring because
// every framework spells them slightly differently (skeleton-item, isLoading,
// shimmer__bar); aria-busy is the one the platform itself defines.
// Below this an empty box is a gap in the design, not a hole; a standard ad
// unit is 250px and the slots that hold one start there.
var HOLLOW_BLOCK_MIN_PX = 200;

var SKELETON_SELECTOR = [
  '[class*="skeleton" i]', '[class*="shimmer" i]', '[class*="placeholder" i]',
  '[class*="loading" i]', '[class*="-loader" i]', '[class*="loader-" i]',
  '[aria-busy="true"]'
].join(',');

// Whether an element holds anything a reader would miss. Text or media counts;
// a box of empty boxes does not. Shared by the overlay sweep and the skeleton
// settle because both are answering the same question — is there anything here
// worth keeping — and answering it two ways is how they drift apart.
function _isHollow(el) {
  return !(el.innerText || '').trim() &&
         !el.querySelector('img, video, canvas, svg, iframe');
}

// ── a page captured without its JavaScript ──
//
// The fast engine stores the markup and drops every script, which is what
// makes it fast and what makes its archives readable in twenty years. The cost
// arrives in the chrome, because on a modern page the chrome is JavaScript:
//
//  * An ad slot reserves its height in CSS and waits for a script to fill or
//    collapse it. No script ever comes, so a captured CNN front page opens on
//    five hundred pixels of nothing (Eric: "Huge space above the header?").
//  * A sticky header is positioned by a scroll handler. Without one it stays
//    pinned at the offset it had when the snapshot was taken, so it floats in
//    the middle of the article as you scroll past (Eric: "that header doesn't
//    move when i scroll the page very weird").
//  * A skeleton placeholder pulses until its content arrives. It never
//    arrives, so it pulses forever (Eric: "There's some pulsing content").
//
// None of that is the page being captured badly — every one of those elements
// is faithfully stored. It is chrome that only ever made sense with a script
// behind it, and in a static archive the honest thing is to let it settle.
//
// Runs on every ZIM. Each rule only fires on the exact condition it names, and
// a Wikipedia article has no empty ad slots, nothing sticky that matters, and
// nothing that pulses.
function _settleCapturedChrome(frame) {
  var doc = frame.contentDocument;
  var win = frame.contentWindow;
  if (!doc || !win || !doc.body) return;

  var css = doc.createElement('style');
  css.setAttribute('data-zimi', 'settle');
  css.textContent = [
    // An animation that repeats forever is waiting for something. Let it
    // finish its first pass and stop, rather than pulse at the reader all day.
    '*, *::before, *::after { animation-iteration-count: 1 !important; }',
    // A reserved box with nothing in it is a hole where an ad was going to be.
    '[class*="ad-"]:empty, [class*="-ad"]:empty, [class*="advert"]:empty,',
    '[id*="ad-"]:empty, [id*="-ad"]:empty, ins:empty { display: none !important; }'
  ].join('\n');
  (doc.head || doc.documentElement).appendChild(css);

  // Sticky needs a scroll handler that is no longer here. Static puts the
  // element back in the flow it was written for, which is where a reader
  // expects to find it. Done in JS because CSS cannot select on a computed
  // position, and only for elements that really are sticky.
  try {
    var all = doc.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var cs = win.getComputedStyle(all[i]);
      if (cs && cs.position === 'sticky') all[i].style.setProperty('position', 'static', 'important');
    }
  } catch (e) {}

  // Skeletons. `animation-iteration-count: 1` above already stops the pulse,
  // but stopping it is not the same as resolving it: what is left is a grey bar
  // frozen mid-shimmer, still claiming an article is on its way.
  //
  // Empty ones go. A placeholder for content that cannot arrive is not
  // information, and closing the gap reads better than a hole that looks like a
  // bug. One that DOES hold something keeps its content and only loses the
  // animation — the class name is a hint about intent, never permission to
  // throw away text somebody wrote.
  try {
    var skeletons = doc.querySelectorAll(SKELETON_SELECTOR);
    for (var s = 0; s < skeletons.length; s++) {
      var el = skeletons[s];
      if (_isHollow(el)) el.remove();
      else el.style.setProperty('animation', 'none', 'important');
    }
  } catch (e) {}

  // A tall box with nothing in it — no text, no picture, no background — is a
  // hole where a script was going to put something. The ad-slot rule catches
  // the ones with honest names; theverge.com's are 250px divs named o1ls9x,
  // and the front page read as stories separated by white voids. Collapsed,
  // not removed: a page that later fills one by script (an alive capture)
  // gets its box back.
  try {
    var blocks = doc.body.querySelectorAll('div, section, aside');
    for (var b = 0; b < blocks.length; b++) {
      var box = blocks[b];
      var rect = box.getBoundingClientRect();
      if (rect.height < HOLLOW_BLOCK_MIN_PX || rect.width < 100) continue;
      if (!_isHollow(box)) continue;
      var cs = win.getComputedStyle(box);
      if (cs.backgroundImage !== 'none' || cs.position === 'fixed') continue;
      if (box.querySelector('iframe, canvas, object, embed')) continue;
      box.style.setProperty('height', '0', 'important');
      box.style.setProperty('min-height', '0', 'important');
      box.style.setProperty('padding', '0', 'important');
      box.style.setProperty('margin', '0', 'important');
      box.style.setProperty('overflow', 'hidden', 'important');
    }
  } catch (e) {}
}

function _sweepBlockingOverlays(frame) {
  var doc = frame.contentDocument;
  var win = frame.contentWindow;
  if (!doc || !win || !doc.body) return;

  var sweep = function() {
    var covered = win.innerWidth * win.innerHeight * OVERLAY_VIEWPORT_SHARE;
    var hit = 0;
    var all = doc.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var cs;
      try { cs = win.getComputedStyle(el); } catch (e) { continue; }
      if (!cs || cs.position !== 'fixed') continue;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      var blocking = r.width * r.height >= covered;
      if (!blocking && !_isHollow(el)) continue;
      el.remove();
      hit++;
    }
    // A modal locks the page behind it and the lock outlives the modal: a body
    // left at overflow:hidden is an article nobody can scroll.
    if (hit) {
      [doc.documentElement, doc.body].forEach(function(el) {
        if (el) el.style.setProperty('overflow', 'visible', 'important');
      });
    }
    return hit;
  };

  sweep();
  // The wall usually arrives AFTER load — that is what makes it a replay
  // problem rather than a markup one. Watch for it, then stop: an observer
  // that lives as long as the article is a cost every reader pays for a
  // problem almost no archive has.
  if (typeof win.MutationObserver !== 'function') return;
  var obs = new win.MutationObserver(function() { sweep(); });
  try {
    obs.observe(doc.documentElement, { childList: true, subtree: true });
    win.setTimeout(function() { obs.disconnect(); }, OVERLAY_WATCH_MS);
  } catch (e) {}
}

function _defineAttachToDoc(frame) {
  var doc = frame.contentDocument;
  if (!doc) return;
  var onSel = function() {
    clearTimeout(_defineDebounce);
    // Touch devices wait out the OS selection-callout's own animation before the
    // chip appears; desktop's shorter debounce (no callout to fight) is unchanged.
    var delay = _defineIsTouch() ? _DEFINE_TOUCH_DELAY : 220;
    _defineDebounce = setTimeout(function() { _defineConsider(frame); }, delay);
  };
  doc.addEventListener('dblclick', function() {
    clearTimeout(_defineDebounce);
    _defineConsider(frame);
  });
  doc.addEventListener('mouseup', onSel);
  doc.addEventListener('selectionchange', onSel);
  // A right-click arms suppression (and clears any live trigger); the next
  // primary mousedown disarms it so ordinary selection/double-click still work.
  doc.addEventListener('contextmenu', function() { _defineSuppressChip = true; _defineHide(); }, true);
  // Tapping inside the article dismisses a stale popover.
  doc.addEventListener('mousedown', function(e) {
    if (e.button === 0) _defineSuppressChip = false;
    if (_defineState && _defineState.path !== null) _defineHide();
  }, true);
  // Scrolling the article moves the anchor word out from under the popover, so
  // dismiss it (like a native selection callout) rather than leave it stranded at
  // a stale position. Covers both the raw frame and Reader View (same window).
  try { frame.contentWindow.addEventListener('scroll', _defineHideOnScroll, { passive: true }); } catch (e) {}
  // No discovery tip. It was rate-limited twice and Eric still met it twice
  // more; a teaching aid that has to be tuned that often is one nobody wanted.
  // Define is still there on a selection or a double-tap, and it is now found
  // the way every other text gesture on a phone is found — by trying it.
}

// Close context menu on click anywhere
document.addEventListener('click', function() { _hideLinkCtxMenu(); });
// Tap outside the Define popover closes it (clicks inside are handled by its own controls).
document.addEventListener('mousedown', function(e) {
  if (_definePopover && _definePopover.classList.contains('open') && !_definePopover.contains(e.target)) _defineHide();
}, true);
// Outer-page scroll (capture, so it also catches scroll on any nested container)
// dismisses the popover; the iframe's own scroll is wired per-load in
// _defineAttachToDoc since iframe scroll events don't bubble to the parent.
window.addEventListener('scroll', _defineHideOnScroll, { passive: true });
document.addEventListener('scroll', _defineHideOnScroll, { passive: true, capture: true });
document.addEventListener('contextmenu', function(e) {
  // If clicking outside existing menu, close it
  if (_linkCtxMenu.classList.contains('open') && !_linkCtxMenu.contains(e.target)) {
    _hideLinkCtxMenu();
  }
});

// Attach context menu to article links in the main page
// Uses event delegation — checks data attributes first, then parses onclick
document.addEventListener('contextmenu', function(e) {
  var el = e.target.closest('[onclick*="openArticle"]');
  if (!el) return;
  var zim, path, title;
  // Prefer data attributes (search results have data-zim/data-path)
  if (el.dataset.zim && el.dataset.path) {
    zim = el.dataset.zim;
    path = el.dataset.path;
    // Try to get title from the result title element
    var titleEl = el.querySelector('.result-title, .dc-title, .hp-title');
    title = titleEl ? titleEl.textContent.trim() : null;
  } else {
    // Parse from onclick attribute
    var onclick = el.getAttribute('onclick') || '';
    var m = onclick.match(/openArticle\s*\(\s*'([^']*)'\s*,\s*'([^']*)'\s*(?:,\s*'([^']*)')?\s*\)/);
    if (!m) return;
    zim = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    path = m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    title = m[3] ? m[3].replace(/\\'/g, "'").replace(/\\\\/g, '\\') : null;
  }
  e.preventDefault();
  e.stopPropagation();
  _showLinkCtxMenu(e.clientX, e.clientY, { zim: zim, path: path, title: title });
});


function _desktopInit() {
  IS_DESKTOP = true;
  console.log('[Zimi] Desktop mode enabled, pywebview bridge ready');
  // Refresh topbar — newtab button visibility depends on IS_DESKTOP
  updateTopbar();
  // Check onboarding if init already ran (zimsCache populated)
  if (zimsCache !== null) _desktopCheckOnboarding();
}

function _setWindowTitle(title) {
  document.title = title;
  // pywebview bridge: try direct call, with fallback polling
  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_title) {
    window.pywebview.api.set_title(title).catch(function(e) {
      console.warn('[Zimi] set_title failed:', e);
    });
  }
}

// Detect pywebview even if the 'pywebviewready' event was missed
// (can happen when load_url navigates to server after initial HTML load)
(function _detectDesktop() {
  if (window.pywebview && window.pywebview.api) {
    if (!IS_DESKTOP) _desktopInit();
    return;
  }
  // Poll for up to 10 seconds after page load
  let attempts = 0;
  const timer = setInterval(function() {
    if (window.pywebview && window.pywebview.api) {
      clearInterval(timer);
      if (!IS_DESKTOP) _desktopInit();
    } else if (++attempts > 50) {
      clearInterval(timer); // give up after 10s
    }
  }, 200);
})();

async function _desktopCheckOnboarding() {
  if (!IS_DESKTOP) return;
  // Only show onboarding if desktop + no ZIMs + first run
  if (zimsCache && zimsCache.length === 0) {
    try {
      const cfg = await pywebview.api.get_config();
      if (cfg.is_first_run) {
        const el = document.getElementById('onboard-path');
        if (el) el.value = cfg.zim_dir || '';
        document.getElementById('onboard-start').disabled = !cfg.zim_dir;
        document.getElementById('desktop-onboarding').classList.add('open');
      }
    } catch(e) {}
  }
}

async function desktopChooseFolder(inputId) {
  if (!IS_DESKTOP) return;
  const input = document.getElementById(inputId);
  try {
    const folder = await pywebview.api.choose_folder(input.value || null);
    if (folder) {
      input.value = folder;
      // Enable the Get Started button if this is onboarding
      if (inputId === 'onboard-path') {
        document.getElementById('onboard-start').disabled = false;
      }
    }
  } catch(e) {}
}

async function desktopFinishOnboarding() {
  if (!IS_DESKTOP) return;
  const path = document.getElementById('onboard-path').value;
  if (!path) return;
  try {
    const needsRestart = await pywebview.api.save_config({ zim_dir: path });
    document.getElementById('desktop-onboarding').classList.remove('open');
    if (needsRestart) {
      await pywebview.api.restart();
    }
  } catch(e) {}
}

// pywebview fires this event once the JS bridge is ready
window.addEventListener('pywebviewready', function() { _desktopInit(); });

// ── Server Settings overlay ──
let _settingsOriginal = {};

async function settingsSaveInline() {
  if (!IS_DESKTOP || !window.pywebview) return;
  const updates = {};
  const zimDir = document.getElementById('ms-zim-dir');
  const dataDir = document.getElementById('ms-data-dir');
  const portInput = document.getElementById('ms-port');
  if (zimDir && zimDir.value !== _settingsOriginal.zim_dir) updates.zim_dir = zimDir.value;
  if (dataDir && dataDir.value !== (_settingsOriginal.data_dir || '')) updates.data_dir = dataDir.value;
  if (portInput) { var p = parseInt(portInput.value, 10); if (p !== _settingsOriginal.port) updates.port = p; }
  if (Object.keys(updates).length === 0) return;
  try {
    const needsRestart = await pywebview.api.save_config(updates);
    if (needsRestart) setTimeout(() => pywebview.api.restart(), 500);
  } catch(e) {}
}
async function msChooseZimFolder() {
  if (!IS_DESKTOP || !window.pywebview) return;
  try {
    var path = await pywebview.api.choose_folder();
    if (path) document.getElementById('ms-zim-dir').value = path;
  } catch(e) {}
}
async function msChooseDataFolder() {
  if (!IS_DESKTOP || !window.pywebview) return;
  try {
    var path = await pywebview.api.choose_folder();
    if (path) document.getElementById('ms-data-dir').value = path;
  } catch(e) {}
}

let _refreshing = false;
async function settingsRefreshCache() {
  if (_refreshing) return;
  _refreshing = true;
  // Works from settings overlay (desktop) or inline settings panel
  const msgEl = document.getElementById('settings-restart-msg');
  const btn = document.getElementById('refresh-cache-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('refreshing'); }
  if (msgEl) {
    msgEl.textContent = t('refreshing_cache');
    msgEl.className = 'settings-restart-msg show';
  }
  try {
    await manageFetch('/manage/refresh', { method: 'POST' });
    if (msgEl) msgEl.textContent = t('cache_refreshed');
    // Reload ZIM list
    try { zimsCache = await _fetchList(); _rebuildZimsMap(); } catch(e) {}
    if (btn) btn.textContent = t('refreshed');
    var overlay = document.getElementById('settings-overlay');
    if (msgEl && overlay && overlay.classList.contains('open')) {
      setTimeout(function() { closeSettings(); renderManage(); }, 800);
    } else {
      renderManage();
    }
  } catch(e) {
    if (msgEl) msgEl.textContent = t('refresh_failed');
    if (btn) btn.textContent = t('error');
  } finally {
    setTimeout(function() { _refreshing = false; }, 2000);
  }
}

// ── Background activity badge ────────────────────────────────────────
// Polls /manage/activity every 5s while something is happening; pauses
// (but doesn't permanently die) when idle. Surfaces the result as a compact
// amber badge on the Manage entry point (gear on desktop, ⋯ on mobile) rather
// than a full-width bar — no layout shift, and it's clickable (→ downloads).
//
// Two intervals: ACTIVE_MS while building/downloading/seeding > 0,
// IDLE_MS while quiet. Idle polling stays live so a manual rebuild or
// download started AFTER initial idle still surfaces. _renderActivity
// returns true when activity is showing, false when idle — the poller
// uses that to swap intervals, never to stop.
let _activityTimer = null;
let _activityIdle = false;
const _ACTIVITY_POLL_ACTIVE_MS = 5000;
const _ACTIVITY_POLL_IDLE_MS = 30000;

// Snapshot of current background work for the topbar badge. count = the number
// shown on the gear (in-flight + queued downloads); active = whether ANY work is
// happening (downloads/indexing/seeding); tip = the full detail string for the
// hover title + aria-label (keeps indexing/seeding surfaced even though the
// count is downloads-only).
var _activityBadge = { count: 0, active: false, tip: '' };

// Jump to the downloads view — where the old bar's click would have gone.
// Enters Manage first if needed, then selects the downloads tab.
function _openDownloadsView(e) {
  if (e) { if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); }
  _closeTopbarMenu();
  if (mode !== 'manage') {
    if (!manageEnabled) return;
    enterManage();
  }
  switchManageTab('downloads');
}

// Paint the badge onto whichever Manage entry point is live (CSS shows exactly
// one: gear on desktop, ⋯ on mobile). Idempotent — called by the poller AND at
// the end of updateTopbar (which rewrites the gear's innerHTML, wiping any child
// badge). Suppressed in Manage mode: that view surfaces downloads in its tabs,
// and the gear is a close-X there.
function _applyActivityBadge() {
  var st = _activityBadge || { active: false, count: 0, tip: '' };
  // Suppress in Manage (downloads live in its own tabs) and while the Almanac
  // overlay is open — there the Manage entry point becomes the close X, so the
  // badge would bleed onto it (W1.1).
  var suppress = (typeof mode !== 'undefined' && mode === 'manage') ||
    (typeof _almanacOpen !== 'undefined' && _almanacOpen) || !st.active;
  var hosts = [
    { el: document.getElementById('manage-btn'), forceDot: false }, // desktop gear: count
    { el: document.querySelector('.topbar-more'), forceDot: true }, // mobile ⋯: dot
  ];
  hosts.forEach(function(h) {
    if (!h.el) return;
    var badge = h.el.querySelector('.topbar-badge');
    if (suppress) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'topbar-badge';
      badge.setAttribute('role', 'status');
      badge.onclick = _openDownloadsView;
      h.el.appendChild(badge);
    }
    var asDot = h.forceDot || st.count <= 0;
    badge.classList.toggle('dot', asDot);
    badge.textContent = asDot ? '' : (st.count > 99 ? '99+' : String(st.count));
    badge.title = st.tip;
    badge.setAttribute('aria-label', st.tip);
    badge.style.display = 'flex';
  });
}

function _renderActivity(a) {
  if (!a) return false;
  // Full detail string for the hover title + aria-label (plain text — set via
  // .title / aria-label, so use t() not tH() and no markup). Mirrors what the
  // old bar showed, so indexing + seeding stay surfaced alongside downloads.
  const parts = [];
  if (a.indexing && a.indexing.state === 'building') {
    const cur = a.indexing.current ? a.indexing.current + ' · ' : '';
    parts.push(t('activity_indexing') + ' ' + cur + (a.indexing.ready || 0) + '/' + (a.indexing.total || 0));
  }
  const dl = a.downloads || {};
  const dlCount = (dl.active || 0) + (dl.queued || 0);
  if ((dl.active || 0) > 0) {
    let d = dl.active + ' ' + t('activity_downloading');
    if (dl.name) d += ' — ' + dl.name; // "1 downloading — openstreetmap-wiki"
    parts.push(d);
  }
  if ((dl.queued || 0) > 0) parts.push(dl.queued + ' ' + t('activity_queued'));
  const seed = (a.seeding || {}).torrents || 0;
  if (seed > 0) parts.push(seed + ' ' + t('activity_seeding'));
  // Other background jobs: bookmark→ZIM export, library health check.
  const ex = a.export || {};
  if (ex.phase === 'running') {
    parts.push(t('activity_exporting') + (ex.total ? ' ' + (ex.done || 0) + '/' + ex.total : ''));
  }
  const hc = a.health || {};
  if (hc.phase === 'running') {
    parts.push(t('activity_health') + (hc.total ? ' ' + (hc.done || 0) + '/' + hc.total : ''));
  }

  _activityBadge.count = dlCount;
  _activityBadge.active = parts.length > 0;
  _activityBadge.tip = parts.join(' · ');
  _applyActivityBadge();
  return parts.length > 0;
}

function _scheduleNextActivityPoll(idle) {
  if (_activityTimer) clearTimeout(_activityTimer);
  const delay = idle ? _ACTIVITY_POLL_IDLE_MS : _ACTIVITY_POLL_ACTIVE_MS;
  _activityIdle = !!idle;
  _activityTimer = setTimeout(_pollActivity, delay);
}

async function _pollActivity() {
  // On a password-protected server, don't poll (and 401-spam) until logged
  // in. The 'load' event can fire before init() reaches _initSecondary(),
  // so when the probe doesn't exist yet, defer — never fetch unprobed.
  if (!_manageProbe) { _scheduleNextActivityPoll(false); return; }
  try { await _manageProbe; } catch (e) {}
  if (!_canPollManage()) { _scheduleNextActivityPoll(true); return; }
  try {
    const res = await authedFetch('/manage/activity', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      // What the LAST poll saw, read before this one repaints the badge.
      const wasActive = !!(_activityBadge && _activityBadge.active);
      const stillActive = _renderActivity(data);
      // Background work just finished while the Activity view is open — the
      // journal gained a line the reader is looking straight at. This is the
      // only moment worth a refetch: the badge poll already told us something
      // ended, so the list costs one small read instead of a timer of its own.
      if (wasActive && !stillActive && mode === 'manage' && manageTab === 'history') {
        renderActivityLog();
      }
      _scheduleNextActivityPoll(!stillActive);
      return;
    }
    // Auth failure or manage disabled — back off to idle cadence (don't spam).
    _scheduleNextActivityPoll(true);
  } catch (e) {
    // Network blip (laptop sleep, etc.) — keep polling at idle cadence.
    _scheduleNextActivityPoll(true);
  }
}

function _startActivityPolling() {
  if (_activityTimer) return;
  _pollActivity();
}

// Public hook: client code that triggers server work (cache-action,
// download-start, etc.) can call this to make the bar appear within
// seconds rather than waiting up to ACTIVITY_POLL_IDLE_MS.
function _nudgeActivityPoll() {
  if (_activityTimer) clearTimeout(_activityTimer);
  _activityTimer = setTimeout(_pollActivity, 250);
}
window._nudgeActivityPoll = _nudgeActivityPoll;

// Kick off the poller on load. Even if nothing is happening, one call
// confirms the endpoint works; subsequent calls follow active/idle cadence.
window.addEventListener('load', _startActivityPolling);

init();
