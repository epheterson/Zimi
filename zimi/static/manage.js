
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
  _searchCardClear();
  if (!manageEnabled) {
    // The gear must respond from first paint. On a large library the boot's
    // /list call blocks for seconds, and if the user clicks before the
    // manage-auth probe has set manageEnabled we must not leave the button
    // dead (#44). Resolve the probe on demand (cheap, lock-free endpoint) and
    // only bail if management is genuinely disabled.
    if (_manageProbed) { _dropManageBoot(); return false; }   // probe finished: disabled
    if (!_manageProbe) _manageProbe = _probeManageAuth();
    // The gear turns while the answer is on its way: on a busy server (a
    // library warming after a restart) that can be seconds, and a tap that
    // shows nothing reads as a dead button.
    var gear = document.getElementById('manage-btn');
    if (gear) gear.classList.add('busy');
    try { await _manageProbe; } finally { if (gear) gear.classList.remove('busy'); }
    if (!manageEnabled) { _dropManageBoot(); return false; }  // resolved to disabled
  }
  // Signed in first, over the page you are on: Manage painted under the
  // modal said "Loading catalog..." while it waited for the password (Eric,
  // 2026-09-21). Create's way. A cold /?manage shows the library behind it;
  // a second call while the sign-in is up (the boot's re-check) waits on it.
  if (_needsSignIn()) {
    if (_pwResolve) return false;
    _dropManageBoot();
    if (!(await _signInFirst())) return false;
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
  return true;
}

// Reveal the library after a cold boot into ?manage that resolved to "you may
// not manage": the manage-boot gate was hiding #main-view, so drop it and paint
// home. A no-op when the gate was never set (the normal in-SPA path).
function _dropManageBoot() {
  if (!document.documentElement.classList.contains('manage-boot')) return;
  document.documentElement.classList.remove('manage-boot');
  enterHome(false);
}
let manageLangFilter = null;
let catalogPage = 0;
let _catalogObserver = null;
let _catalogTotal = 0;
let _dlTimer = null;
let _availableUpdates = {};    // keyed by installed filename → update info
let _mergedToOther = new Set(); // categories merged into Other (< MIN_BROWSE_CAT items)

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
  _prefWrite(SK.HIDE_LANG_CHOOSER, '1');
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
  'maps':'maps',         // not set by Kiwix today (maps_en_* ship with no category); ready for when it is
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
  if (/(^|[^a-z0-9])lua\.org/.test(n)) return 'devdocs';
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
  // Maps: Kiwix's Maps2ZIM output (maps_en_<region>), StreetZim, AtlasZim
  if (/^maps(_|$)|streetzim|atlaszim/.test(n)) return 'maps';
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
        _setCatalogOrigin(false, 0, '', '');
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

// Where the catalog on screen came from, when it was not a live fetch.
var _catalogSource = '';
var _catalogAsOf = '';
var CATALOG_FRESH_S = 86400; // a copy younger than the server's 24h TTL is current, not worth a note

// One place sets where the catalog on screen came from, so a refreshed copy
// clears the source and date along with the stale flag.
function _setCatalogOrigin(stale, fetchedAt, source, asOf) {
  _catalogStaleAt = stale ? fetchedAt : 0;
  _catalogSource = stale ? source : '';
  _catalogAsOf = stale ? asOf : '';
}

function _catalogStaleNote() {
  // A catalog that may be months old says so. The shipped snapshot gets its
  // own wording because "offline copy from <date>" implies the person once
  // had it fresh, and on a machine that has never been online they did not.
  if (_catalogSource === 'snapshot' && _catalogAsOf) {
    // The snapshot's date is a plain YYYY-MM-DD, not a timestamp. Parsed as
    // UTC noon so a timezone west of Greenwich does not render it as the day
    // before, which is the classic way a date-only string slips backwards.
    var parts = _catalogAsOf.split('-');
    var day = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2], 12));
    var shown = isNaN(day.getTime()) ? _catalogAsOf : fmtDate(day);
    return '<div class="ms-hint" style="text-align:center;margin:4px 0 10px">' +
      tH('catalog_snapshot_note', {d: shown}) + '</div>';
  }
  var at = _catalogStaleAt || (_catalogAsOf ? Date.parse(_catalogAsOf) / 1000 : 0);
  if (!at || Date.now() / 1000 - at < CATALOG_FRESH_S) return '';
  var when = fmtDate(at * 1000);
  return '<div class="ms-hint" style="text-align:center;margin:4px 0 10px">' +
    tH('catalog_stale_note', {d: when}) + '</div>';
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
  items.push(...await _loadOwnCatalogRows());
  return {
    items: items,
    stale: !!data.stale,
    fetchedAt: data.stale ? (data.fetched_at || 0) : 0,
    // Which of the three states answered: live (absent), "cache" or
    // "snapshot". The server only sets it when it fell back.
    source: data.source || '',
    asOf: data.as_of || ''
  };
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
      _setCatalogOrigin(fresh.stale, fresh.fetchedAt, fresh.source, fresh.asOf);
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

  const { items, stale, fetchedAt, source, asOf } = await _fetchCatalogItems();
  // Offline: server returned its last-good catalog — note it quietly
  _setCatalogOrigin(stale, fetchedAt, source, asOf);
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
    .sort((a, b) => cmpText(a.title || a.file, b.title || b.file));
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

  // Group by category + language + project (the name before its first
  // underscore): as catalog_hierarchy._family_key, which says why.
  const families = new Map();
  for (const it of byName.values()) {
    const cat = (it.category || '').toLowerCase();
    const lang = (it.language || '').toLowerCase();
    const project = (it.name || '').toLowerCase().split('_')[0];
    if (!cat || !lang || !project) continue;
    const key = cat + '_' + lang + '_' + project;
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
    // A StreetZim region is installed under whatever name the file was given
    // (streetzim_hawaii, hawaii, osm-hawaii): match the region itself, which
    // the map's own metadata names.
    if (item.source === 'streetzim') {
      const want = (item.title || '').toLowerCase();
      const hit = zimsCache.find(z => z.map_source === 'StreetZim' && !claimed.has(z.file) && _mapName(z).toLowerCase() === want);
      if (hit) {
        item.installed = true;
        item._installedDate = hit.date || null;
        item._installedFile = hit.file;
        item._installedExternal = hit.external || null;
        item._installedName = hit.name;
        item._installedSizeGb = hit.size_gb;
        claimed.add(hit.file);
      }
      return;
    }
    for (const z of zimsCache) {
      const fb = (z.file || '').replace(/\.zim$/, '');
      if (!prefixes.some(p => fb === p || fb.startsWith(p + '_'))) continue;
      if (strict ? _flavorToken(fb) !== itemTok : claimed.has(z.file)) continue;
      item.installed = true;
      const m = fb.match(/(\d{4}-\d{2})$/);
      item._installedDate = m ? m[1] : null;
      item._installedFile = z.file;
      item._installedExternal = z.external || null;
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
    item._installedExternal = null;
    item._installedName = null;
    item._installedSizeGb = null;
    tryMatch(item, true);
  }
  for (const item of items) {
    if (!item.installed) tryMatch(item, false);
  }
}

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
  _fitSearchPlaceholder(t('search_catalog'));

  // Only show loading spinner if catalog hasn't been fetched yet
  if (!_catalogCache) results.innerHTML = '<div class="loading"><span class="spinner-inline"></span>' + tH('loading_catalog') + '</div>';

  loadFullCatalog().then(items => {
    // A search or a category opened while the catalog loaded is what the
    // page shows now; painting the gallery over it lost what was typed.
    if (_browseView !== 'gallery') return;
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
      if (count > 0 && count < MIN_BROWSE_CAT && cat.key !== OWN_CATALOG_CAT) {
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
      '<div class="browse-footer-count">' + esc(tPlural('n_sources', totalSources) + ' \u00B7 ' + tPlural('n_categories', activeCats)) + '</div>' +
    '</div>';
    h += '</div>';
    results.innerHTML = _catalogStaleNote() + h;
    // Auto-scroll pill bar so the active language pill is visible
    var activePill = results.querySelector('.catalog-lang-scroll .pill.active');
    if (activePill) activePill.scrollIntoView({inline: 'center', block: 'nearest'});
  }).catch(err => {
    // Only reached now when there is no catalog at all: no live fetch, no
    // cache, and no shipped snapshot. Everything else falls back on the
    // server side and renders normally with a dated note.
    //
    // Even here, do not wipe the view. A peer on this LAN offering ZIMs is a
    // fact about the local network and has nothing to do with whether Kiwix
    // answered; replacing the pane with one error line used to hide that,
    // which made an offline Zimi look emptier than it was.
    var note = '<div class="empty"><p>' + tH('failed_load_library') + '</p>' +
      '<div class="hint">' + esc(String(err)) + '</div></div>';
    results.innerHTML = note + _nearbyPeerSectionHtml();
  });
}

// The Maps category has two sources: Kiwix's maps, in the OPDS catalog, and
// StreetZim's, on the Internet Archive. A toggle at the top of the category
// picks one; nothing else in the catalog has a second source, so this is a
// toggle and not a sources feature. Eric, 2026-09-18: "since it's only maps
// sources how about a toggle in maps category?"
function _mapsSource() {
  return _rawGet(SK.MAPS_SOURCE) === 'streetzim' ? 'streetzim' : 'kiwix';
}
// The source was changed in another window: an open Maps pane lists the other source's maps.
document.addEventListener(PREF_APPLIED_EVENT, function(e) {
  if (e.detail.indexOf(SK.MAPS_SOURCE) >= 0 && _browseView === 'drilldown' && manageCategoryFilter === 'maps' && document.getElementById('catalog-results')) drillCategory('maps');
});
function setMapsSource(source) {
  _prefWrite(SK.MAPS_SOURCE, source === 'streetzim' ? source : null);
  drillCategory('maps');
}
function _mapsSourceToggleHtml() {
  var cur = _mapsSource();
  var pill = function(key, label) {
    return '<button class="pill' + (cur === key ? ' active' : '') + '" onclick="setMapsSource(\'' + key + '\')">' + label + '</button>';
  };
  return '<div class="pills maps-source-toggle">' + pill('kiwix', tH('maps_source_kiwix')) + pill('streetzim', tH('maps_source_streetzim')) + '</div>';
}
// The StreetZim listing arrives from a cache that a background refresh
// fills; the first look at it on a fresh install is empty and refreshing,
// so ask again a few times before saying there is nothing.
var _STREETZIM_POLL_MS = 5000;
var _STREETZIM_POLL_TRIES = 12;
// The note over StreetZim's regions: the link sits on the name (Eric: "put
// it behind the StreetZim text"), and no date: a listing is current unless
// it says otherwise, and a date reads as "old".
var _STREETZIM_URL = 'https://streetzim.web.app';
function _streetzimNoteHtml() {
  var note = tH('streetzim_note');
  var link = '<a href="' + _STREETZIM_URL + '" target="_blank" rel="noopener">StreetZim</a>';
  return note.indexOf('StreetZim') >= 0 ? note.replace('StreetZim', link) : note + ' ' + link;
}
async function _renderStreetZimMaps(results, catMeta, catName, attempt) {
  var data;
  try {
    data = await (await manageFetch('/manage/catalog-streetzim')).json();
  } catch (e) {
    results.innerHTML = '<div class="empty"><p>' + tH('failed_load_category') + '</p></div>';
    return;
  }
  var items = (data.items || []).map(function(it) { return Object.assign({}, it, {category: 'maps'}); });
  if (_catalogCache) _enrichCatalogInstalled(items);
  var grouped = groupVariants(items);
  grouped.sort(cmpTitle);
  var h = '<div class="browse-drilldown-header">' +
    '<button class="browse-back" onclick="renderBrowseGallery()">' + tH('back_to_catalog') + '</button>' +
    '<span class="browse-drilldown-title">' + (catMeta ? '<span class="browse-drilldown-icon">' + catMeta.icon + '</span>' : '') + esc(catName) + '</span>' +
    '<span class="browse-drilldown-count">' + tH('n_available', {n: grouped.length}) + '</span>' +
  '</div>' + _mapsSourceToggleHtml() +
  '<div class="ms-hint">' + _streetzimNoteHtml() + '</div>';
  if (grouped.length) {
    h += _renderCatalogGrid(grouped);
  } else if (data.refreshing && (attempt || 0) < _STREETZIM_POLL_TRIES) {
    h += _loadingHtml('loading_catalog');
    setTimeout(function() {
      if (manageTab === 'browse' && manageCategoryFilter === 'maps' && _mapsSource() === 'streetzim') {
        _renderStreetZimMaps(results, catMeta, catName, (attempt || 0) + 1);
      }
    }, _STREETZIM_POLL_MS);
  } else {
    h += '<div class="empty"><p>' + tH(data.source === 'none' ? 'streetzim_offline' : 'no_zims_category') + '</p></div>';
  }
  results.innerHTML = h;
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
  _fitSearchPlaceholder(t('search_in', {source: catName}));
  q.value = '';

  if (!_catalogCache) results.innerHTML = _loadingHtml('loading_catalog');

  if (catKey === 'maps' && _mapsSource() === 'streetzim') {
    _renderStreetZimMaps(results, catMeta, catName, 0);
    return;
  }

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

    // Language pills scoped to this category. Counted over the grouped
    // projects the drill shows, not the files behind them: a project with
    // four flavours is one card, and its pill said four.
    var langPills = _renderLangPills(_countLangsByCategory(groupVariants(filtered), catKey), 'filterCatalogLang');

    // Apply language filter after computing pill counts (so pills show all available languages).
    // _zimMatchesLang internally falls back to user prefs when no pill is set.
    if (manageLangFilter || _getPrefLanguages().length) {
      filtered = filtered.filter(function(item) { return _zimMatchesLang(item, manageLangFilter); });
    }
    const grouped = groupVariants(filtered);
    // The most complete edition of a project leads its category; the rest
    // go alphabetically.
    grouped.sort((a, b) => _mostComplete(b) - _mostComplete(a) || cmpTitle(a, b));
    let h = '<div class="browse-drilldown-header">' +
      '<button class="browse-back" onclick="renderBrowseGallery()">' + tH('back_to_catalog') + '</button>' +
      '<span class="browse-drilldown-title">' + (catMeta ? '<span class="browse-drilldown-icon">' + catMeta.icon + '</span>' : '') + esc(catName) + '</span>' +
      '<span class="browse-drilldown-count">' + tH('n_available', {n: grouped.length}) + '</span>' +
    '</div>';
    if (catKey === 'maps') h += _mapsSourceToggleHtml();
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
const _CATALOG_FILTER_TESTS = {
  source: (v, item) => [item.name, item.title, item.category].some(s => (s || '').toLowerCase().includes(v)),
  lang: (v, item) => (item.language || '').toLowerCase().split(',').some(c => _catalogLang(c.trim()) === _catalogLang(v)),
};

// A catalog field as it reads. Kiwix's feed escapes some summaries twice,
// so after one decode they still say "d&apos;articles" (95 of 2,653 in the
// shipped snapshot, mostly French).
const _CATALOG_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
function _catalogText(s) {
  return String(s || '').replace(/&(amp|lt|gt|quot|apos|#39);/g, (m, k) => _CATALOG_ENTITIES[k]);
}

function catalogItemMatches(parsed, item) {
  // Fields joined by a separator that is not a space, so a phrase cannot
  // run from the end of the title into the summary.
  const text = [_catalogText(item.title), _catalogText(item.summary)].join('\u0001');
  return searchQueryMatches(parsed, text) &&
    parsed.filters.every(f => _CATALOG_FILTER_TESTS[f.key](f.value, item) !== f.negate);
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
    const parsed = parseSearchQuery(query);
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
    const filtered = pool.filter(item => catalogItemMatches(parsed, item));
    const grouped = groupVariants(filtered);
    // Sort: actionable items first (not installed, not covered by an installed bundle),
    // then installed/covered items pushed to the back. Within each group, alphabetical.
    grouped.sort((a, b) => {
      const aDemoted = a.installed || (a.hierarchy && (a.hierarchy.is_subset_of || []).some(n => _catalogInstalledNames.has(n)));
      const bDemoted = b.installed || (b.hierarchy && (b.hierarchy.is_subset_of || []).some(n => _catalogInstalledNames.has(n)));
      if (aDemoted !== bDemoted) return aDemoted ? 1 : -1;
      return cmpTitle(a, b);
    });
    // Back to the category it searched in, or to the catalog. The query is
    // in the box; under the count, what its operators did.
    const back = manageCategoryFilter
      ? (_RTL_LANGS.has(_currentLang) ? tH('back') + ' \u2192' : '\u2190 ' + tH('back'))
      : tH('back_to_catalog');
    let h = '<div class="browse-drilldown-header">' +
      '<button class="browse-back" onclick="' + (manageCategoryFilter ? "drillCategory('" + escAttr(manageCategoryFilter) + "')" : 'renderBrowseGallery()') + '">' + back + '</button>' +
      '<span class="browse-drilldown-count">' + tPluralH('wiki_results', filtered.length) + '</span>' +
    '</div>' + searchChipsHtml(query, items);
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

function categorizeZim(name) {
  const n = name.toLowerCase();
  if (/medicine|wikem|ready\.gov/.test(n) || (n.startsWith('zimgit-') && /water|food|disaster|knots/.test(n))) return 'Medical';
  if (/stackoverflow|askubuntu|superuser|serverfault|stackexchange/.test(n)) return 'Stack Exchange';
  if (n.startsWith('devdocs_') || n === 'freecodecamp') return 'Dev Docs';
  if (/^ted_|^phzh_/.test(n) || /crashcourse|phet|appropedia|artofproblemsolving|edutechwiki|explainxkcd|coreeng/.test(n)) return 'Education';
  if (/wikihow|ifixit|off-the-grid/.test(n)) return 'How-To';
  if (/^wiki|^wikt/.test(n) || n === 'openstreetmap-wiki') return 'Wikimedia';
  if (/gutenberg|rationalwiki|theworldfactbook/.test(n)) return 'Books';
  if (/^maps(_|$)|streetzim|atlaszim/.test(n)) return 'Maps';
  return 'Other';
}

function formatSize(bytes) { return fmtBytes(bytes); }

// Bold download arrow for catalog buttons — the ↓ glyph reads too thin.
const _DL_ARROW_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v13M6 11l6 6 6-6"/></svg>';

// Installed and covered-by-an-installed-bundle rows are noise when browsing
// for something new — collapse them behind a count button at the list end.
let _showHiddenCatalog = false;

function _mostComplete(g) { return g.hierarchy && g.hierarchy.coverage_advantage_bundle ? 1 : 0; }
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
  if (item.article_count) metaTags.push(fmtNum(item.article_count) + ' ' + t('articles'));
  if (item.date) metaTags.push(item.date);
  const sizes = variants.map(v => v.size_bytes).sort((a, b) => a - b);
  if (sizes.length > 1) {
    metaTags.push('<span title="' + escAttr(t('size_range_hint')) + '">' +
      formatSize(sizes[0]) + ' – ' + formatSize(sizes[sizes.length - 1]) + '</span>');
  } else {
    metaTags.push(formatSize(sizes[0]));
  }
  const letterChar = (esc(item.title || item.name)[0] || '?').toUpperCase();
  // A /catalog-icon/ path is already ours: it comes from the snapshot shipped
  // in the package and is served locally. Proxying it through /manage/thumb
  // would ask the server to fetch from itself, which is exactly the network
  // round trip an offline machine cannot make.
  const iconSrc = !item.icon_url ? ''
    : item.icon_url.startsWith('/catalog-icon/') || item.icon_url.startsWith('data:') ? item.icon_url
    : '/manage/thumb?url=' + encodeURIComponent(item.icon_url);
  // StreetZim's regions have no icon on the Archive; a pin says what they
  // are better than the first letter of "Alaska".
  const iconHtml = (!iconSrc && item.source === 'streetzim')
    ? '<span class="ci-pin">' + _MAPS_SVG + '</span>'
    : iconSrc
    ? '<img src="' + escAttr(iconSrc) + '" alt="" width="40" height="40" loading="lazy"' +
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
    const hasUpdate = _catalogHasUpdate(instVariant, updVariant);
    if (hasUpdate) {
      // Update available — show update button (same style as manage view)
      actionsHtml = '<button class="ci-update-btn" onclick="downloadZim(\'' + escAttr(updVariant.download_url) + '\', this, true)" title="' + escAttr(t('from_to_update', {from: instVariant._installedDate, to: updVariant.date})) + '">' +
        tH('update') + '</button>';
    } else {
      actionsHtml = instVariant._installedExternal ? '' : '<span class="ci-installed-badge">' + tH('installed_badge') + '</span>';
    }
    if (instVariant._installedFile) {
      actionsHtml += _zimDeleteBtn(instVariant._installedFile, instVariant._installedExternal);
    }
  } else if (item.own) {
    actionsHtml = '<button class="ci-add-btn" onclick="event.stopPropagation();_addOwnZim(\'' + escJs(item.name) + '\')">' + tH('add_own') + '</button>';
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
      // One file: its size alone. "Full" names a choice that is not there.
      var only = variantLabel(withLabels[0].url, vUrls) ? withLabels[0].label + ' (' + withLabels[0].size + ')' : withLabels[0].size;
      actionsHtml = '<button class="ci-add-btn" aria-label="' + escAttr(t('download_size', {size: only})) + '"' +
        ' onclick="event.stopPropagation();downloadZim(\'' + escAttr(withLabels[0].url) + '\', this)">' +
        _DL_ARROW_SVG + esc(only) + '</button>';
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
      '<div class="ci-title">' + esc(_catalogText(item.title) || item.name) + _catLangTag(item.language, item.name) + '</div>' +
      // In its own direction: a French summary under a Hebrew interface was
      // cut at its start ("…ne sélection") rather than its end.
      (item.summary ? '<div class="ci-summary" dir="auto">' + esc(_catalogText(item.summary)) + '</div>' : '') +
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
    _fitSearchPlaceholder(t('filter_installed'));
    renderInstalled();
  } else if (tab === 'downloads') {
    _fitSearchPlaceholder(t('search_placeholder'));
    refreshDownloads();
  } else if (tab === 'collections') {
    _fitSearchPlaceholder(t('search_placeholder'));
    renderCollectionsTab();
  } else if (tab === 'history') {
    _fitSearchPlaceholder(t('search_placeholder'));
    _act.showAll = false;   // re-entering the tab defaults back to the capped view
    renderActivityLog();
  } else if (tab === 'activity') {
    _fitSearchPlaceholder(t('search_placeholder'));
    renderActivityTab();
  } else {
    // Default catalog language pill to the UI language UNLESS the user has
    // a multi-language preference — then leave the pill empty so the prefs
    // filter is what's in effect.
    if (!_getPrefLanguages().length && _currentLang) manageLangFilter = _currentLang;
    renderBrowseGallery();
  }
  _syncSearchHelp();
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
      ' <span style="font-weight:400;color:var(--text2);font-size:12px">(' + tPluralH('n_sources', collZims.length) + ')</span></span>' +
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
        const catZims = catMap[cat].slice().sort(cmpTitle);
        h += '<div class="manage-installed-group"><div class="ci-section-label">' + _countedLabelHtml(_catDisplayName(cat), catZims.length) + '</div>';
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
        h += '<div class="mc-row"><span class="mc-label">' + tH('title_index') + '</span><span class="mc-value">' + tPlural('n_sources', totalZims) + '</span></div>';
      }

      // Full-text index row — denominator is total ZIMs, not just ones with title indexes
      const ftsTotal = building ? totalZims : totalZims;  // always use total ZIMs
      if (withFts.length >= ftsTotal && ftsTotal > 0 && !building) {
        h += '<div class="mc-row"><span class="mc-label">' + tH('fulltext_index') + '</span><span class="mc-value">' + tPlural('n_sources', ftsTotal) + '</span></div>';
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
  if (_manageNeedsSetupKey && !_manageSetupKeyIssued) {
    output.innerHTML =
      '<div class="manage-wrap"><div class="lang-welcome-card manage-locked-card">' +
        '<div class="lang-welcome-text">' +
          '<strong>' + tH('manage_setup_on_host_title') + '</strong>' +
          '<p>' + tH('manage_setup_on_host_body') + '</p>' +
        '</div>' +
      '</div></div>';
    return;
  }
  if (_manageNeedsSetupKey) {
    output.innerHTML = '<div class="manage-wrap"><div class="lang-welcome-card manage-locked-card setup-card">' +
      '<div class="lang-welcome-text"><strong>' + tH('setup_settings_title') + '</strong><p>' + tH('setup_body') + '</p></div>' +
      _setupFormHtml(_setupState, 'setup') + '</div></div>';
    return;
  }
  if (_manageOutside) {
    output.innerHTML = '<div class="manage-wrap"><div class="lang-welcome-card manage-locked-card"><div class="lang-welcome-text">' +
      '<strong>' + tH('outside_locked_title') + '</strong><p>' + tH('outside_locked_body') + '</p></div></div></div>';
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
function _fetchHasPw() {
  return serverFetch('/manage/has-password', { credentials: 'same-origin' })
    .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, j: j }; }, function() { return { ok: r.ok, j: {} }; }); })
    .catch(function() { return { ok: false, j: {} }; });
}
// The switch as the saved state draws it: where a failed save puts it back.
function _setupRevert() {
  var req = document.getElementById('setup-req');
  if (!req) return;
  req.checked = _setupReqSaved(_setupState);
  _setupSync();
}
var _SETUP_ERRORS = { needs_setup_key: 'setup_bad_key', needs_password: 'setup_need_pw', env_controlled: 'configured_via_env',
  outside_network: 'outside_locked_body', open_locked: 'open_locked', wrong_password: 'wrong_password' };
async function _setupSubmit(opts) {
  var quiet = !!(opts && opts.quiet);
  var form = document.getElementById('setup-form');
  if (!form) return false;
  var val = function(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; };
  var err = document.getElementById('setup-error'), auto = !!(opts && opts.auto);
  var show = function(k) {
    err.textContent = t(k); err.style.display = 'block';
    if (auto) _setupRevert();  // nothing was saved, so the switches say so
    return false;
  };
  var setup = form.dataset.mode === 'setup', st = _setupState;
  var req = document.getElementById('setup-req').checked;
  var body = { require_password: req, remember: true };
  // The username field is the form's until a password exists, then Your
  // account's, where it is sent only once edited: an untouched field (shown
  // as "admin" when none is stored) must not rename the account.
  var user = document.getElementById('setup-user');
  if (user && (form.contains(user) || user.value !== user.defaultValue)) body.username = val('setup-user');
  var key = val('setup-key');
  if (document.getElementById('setup-key') && !key) return show('setup_need_key');
  // Reached only by pressing the button that names it.
  if (!req) body.open_confirm = true;
  var cur = document.getElementById('setup-cur');
  if (cur && !cur.hidden) {
    body.current_password = document.getElementById('setup-cur-pw').value;
    if (!body.current_password) return show('setup_need_pw');
  }
  if (req && !_setupHasStoredPw(st)) {
    body.password = val('setup-pw');
    if (!body.password) return show('setup_need_pw');
    if (body.password !== val('setup-pw2')) return show('setup_mismatch');
  }
  var headers = { 'Content-Type': 'application/json' };
  if (key) headers['X-Zimi-Setup-Key'] = key;
  var res;
  try {
    res = await (setup ? fetch : manageFetch)('/manage/access', { method: 'POST', headers: headers,
      credentials: 'same-origin', body: JSON.stringify(body) });
  } catch (e) { return show('setup_failed'); }
  var d = await res.json().catch(function() { return {}; });
  if (!res.ok) return show(_SETUP_ERRORS[d.error] || 'setup_failed');
  if (user && body.username) user.defaultValue = user.value;
  if (d.token) { _manageUser = body.username || 'admin'; _manageToken = d.token; _saveManageToken(d.token, true); }
  if (quiet) return true;
  if (setup) { location.reload(); return true; }
  var was = _manageAccess;
  _manageAccess = d.access || _manageAccess;
  _showToast(t('saved'));
  // A switch that saved itself stays where it is; a change of mode redraws,
  // since the fields under the switches belong to the mode.
  if (auto && was === _manageAccess) { if (err) err.style.display = 'none'; return true; }
  // Drawn again with the switch held where it was on screen: the accounts
  // the password brings arrive above it, in two steps (the pane, then the
  // users list), and the page jumped at each.
  _holdAccessAnchor();
  _renderMsUsers();
  return true;
}
var _accessAnchor = null;
function _holdAccessAnchor() {
  var el = document.getElementById('setup-req');
  _accessAnchor = el ? el.getBoundingClientRect().top : null;
}
function _keepAccessAnchor() {
  var el = document.getElementById('setup-req');
  if (_accessAnchor === null || !el) return;
  window.scrollBy(0, el.getBoundingClientRect().top - _accessAnchor);
  _accessAnchor = null;
}
// The welcome card for a fresh install. The internet sees only that it is
// being set up: no field, nothing to guess at.
function _openSetup(st) {
  _setupState = st;
  var card = document.getElementById('setup-card');
  card.innerHTML = st.inside === false
    ? '<h2>' + tH('setup_waiting_title') + '</h2><p class="subtitle">' + tH('setup_waiting_body') + '</p>'
    : '<h2>' + tH('welcome') + '</h2><p class="subtitle">' + tH('setup_body') + '</p>' + _setupFormHtml(st, 'setup');
  var gateHelp = _gateHelpHtml();
  if (gateHelp) card.innerHTML += '<p class="gate-help">' + gateHelp + '</p>';
  document.getElementById('setup-overlay').classList.add('open');
  var first = card.querySelector('input:not([type=checkbox])');
  if (first && first.id === 'setup-key') first.focus();
}

var _manageRenderId = 0;
async function renderManage() {
  if (_managePublicLocked) { _renderManagePublicLocked(); return; }
  // A signed-in non-admin has no admin console. Show their minimal account card
  // (name, access scope, log out) — never the manage tabs, and never a
  // /manage/status call (it would 401 and re-prompt for sign-in).
  if (_userSession && !_manageToken) { _renderUserManage(); return; }
  const installedCount = zimsCache ? zimsCache.length : 0;
  // Two draws can overlap (two language switches in a row): only the newest
  // lands, on the section it was asked for. The older one, answered last,
  // used to land on Library.
  var myRender = ++_manageRenderId, target = _pendingMsSection;

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
        '<button class="ms-nav-item" data-ms="languages" onclick="switchMs(\'languages\')">' + tH('languages_section') + '</button>' +
        '<button class="ms-nav-item" data-ms="creator" onclick="switchMs(\'creator\')">' + tH('ms_creator') + '</button>' +
        '<button class="ms-nav-item" data-ms="server" onclick="switchMs(\'server\')">' + tH('ms_server') + '</button>' +
        // Access: who can manage Zimi, your account, who can read, the users
        // and the API token. Without a password it holds the first and last.
        '<button class="ms-nav-item" data-ms="users" onclick="switchMs(\'users\')">' + tH('access_title') + '</button>' +
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
    if (myRender !== _manageRenderId) return;
    _manageStatusData = data;
    switchMs('library');
    // Warm the Server-pane fetches now (token is set from the status call
    // above, so these won't trigger a second auth prompt) — the Server pane
    // then paints from fresh data instead of the OFF-default shell.
    _prefetchServerSettings();
    // Honor a deep-link (card menu → "Reorder sections…") once the view mounts.
    var _ms = _pendingMsSection || target;
    _pendingMsSection = null;
    if (_ms) switchMs(_ms);
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
    // A repaint (a language arriving late, a refresh) keeps the catalog
    // search that is on screen rather than dropping back to the gallery.
    var _catalogQuery = _browseView === 'search' ? q.value.trim() : '';
    if (manageCategoryFilter) {
      drillCategory(manageCategoryFilter);
    } else if (_catalogQuery) {
      browseCatalogFilter(_catalogQuery);
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
      _displayNameRowHtml() +
      '<div class="ms-actions" style="margin-top:16px">' +
        '<button class="set-btn" onclick="userLogout()">' + tH('log_out') + '</button>' +
      '</div>' +
      // A signed-in user's own "My data" card: export/import a file, or sync
      // bookmarks/history/preferences to their server account (Save/Restore).
      '<div style="border-top:1px solid var(--border);margin-top:18px;padding-top:14px">' +
        _myDataCardHtml() +
      '</div>' +
    '</div></div>';
}
var _manageStatusData = null;
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
  // A prefetch that failed (a 401 before the password was given) is not an
  // answer to hand the pane later: it drops out, so the pane asks afresh.
  // Kept, it left Manage on "Loading…" after a sign-in until a reload
  // (Eric: "we're stuck loading it didn't finish after i unlocked").
  p.catch(function() { if (_msPrefetch[url] && _msPrefetch[url].promise === p) delete _msPrefetch[url]; });
}
function _prefetchServerSettings() {
  _msPrime('/manage/mirror', function() { return authedFetch('/manage/mirror').then(_msJson); });
  _msPrime('/manage/bt-status');
  _msPrime('/manage/peers', function() { return authedFetch('/manage/peers').then(_msJson); });
  _msPrime('/manage/cache-info');
  _msPrime('/manage/hot');
  _msPrime('/manage/stats');
}
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
    case 'preferences':
      pane.innerHTML = _msPreferencesHtml(); _renderAppsSection(); break;
    case 'languages':
      pane.innerHTML = _msLanguagesHtml(); _paintLangPrefs(); _renderVoicePrefs(); _msScrollPending(); break;
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
  if (!pane) return Promise.resolve();
  // Accounts matter only behind a password: on the network alone there are
  // none, and while anyone can manage Zimi none can be made or changed.
  var accounts = _manageAccess === 'password';
  if (!pane.querySelector('#ms-who')) pane.innerHTML = '<div class="loading"><span class="spinner-inline"></span>' + tH('loading') + '</div>';
  // Everything is asked for first and drawn once: drawn as each answer came,
  // the switch moved three times when the password came back on.
  var users = accounts ? manageFetch('/manage/users').then(function(r) { return r.json(); }).catch(function() { return null; }) : null;
  return Promise.all([_accessAnswers(), users]).then(function(got) {
    // Another section may have opened meanwhile; #ms-pane is every section's.
    if (_msSection !== 'users' || !document.body.contains(pane)) return;
    if (accounts) _usersData = got[1];
    // The password switch follows the accounts it guards, with the API token
    // under it; with the password off it stands alone.
    pane.innerHTML = '<div id="ms-users-body">' + (!accounts ? '' : got[1] ? _msUsersHtml() :
        '<div style="color:var(--text2);font-size:13px">' + tH('could_not_load_stats') + '</div>') + '</div>' +
      '<div id="ms-who" class="ms-access-who"></div>' +
      '<div id="ms-security" class="ms-access-token"></div>';
    _drawAccessCards(got[0]);
    _keepAccessAnchor();
  });
}
function _accessAnswers() {
  return Promise.all([
    manageFetch('/manage/has-password').then(function(r) { return r.json(); }).catch(function() { return {}; }),
    manageFetch('/manage/has-token').then(function(r) { return r.json(); }).catch(function() { return {}; })
  ]);
}
// Who can manage Zimi (the setup page's rows, in place) and the API token.
function _renderAccessCards() {
  return _accessAnswers().then(_drawAccessCards);
}
function _drawAccessCards(results) {
  var who = document.getElementById('ms-who'), tok = document.getElementById('ms-security');
  if (!who || !tok) return;
  _setupState = results[0];
  // Opened by ZIMI_MANAGE_OPEN: the environment owns it, so no rows.
  who.innerHTML = results[0].open_env && _manageAccess === 'open' ? '' :
    '<div class="ms-section-label">' + tH('access_manage') + '</div>' + _setupFormHtml(results[0], 'settings');
  who.hidden = !who.innerHTML;
  // The token is for programs, and only a password makes them ask for it:
  // while it is off the token is kept, unused, until it comes back on.
  tok.innerHTML = results[0].access !== 'password' ? '' : '<div class="mc-row"><span class="mc-label">' + tH('api_token') + '</span><span class="mc-value">' +
    (results[1].has_token
      ? '<button class="pill" onclick="_regenerateToken()">' + tH('roll') + '</button> ' +
        '<button class="pill" onclick="_revokeToken()">' + tH('revoke') + '</button>'
      : '<button class="pill" onclick="_generateToken()">' + tH('generate') + '</button>') +
    '</span></div>';
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

  // Your account, under Public access: the primary admin's name is edited
  // here (it saves itself), with Change password and Log out beside it.
  var self = '<div class="ms-user-account ms-user-account-self">' +
    '<div class="ms-section-label">' + tH('users_your_account') + '</div>' +
    (isPrimary ? _setupUserFieldHtml(selfName, true) : '') +
    '<div class="ms-user-row">' +
      (isPrimary ? '' : '<span class="ms-user-main"><strong>' + esc(selfName) + '</strong> ' + _roleBadge('admin') + '</span>') +
      '<span class="ms-user-self-actions">' +
        '<button class="ms-btn" onclick="managePassword()">' + tH('change_password') + '</button>' +
        (_hasStoredManageToken()
          ? '<button class="ms-btn" onclick="manageLogout()">' + tH('log_out') + '</button>'
          : '') +
      '</span>' +
    '</div>' +
    _displayNameRowHtml() +
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

  // Public access card — governs what an ANONYMOUS visitor sees: the
  // broadest policy here, so first.
  var h = _publicAccessCard() + self;

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
      // The name they go by in games, when it is not their account's.
      if (u.display && u.display !== u.name) seen += ' · ' + tH('users_goes_by', { name: u.display });
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
        _switchRowsHtml([{ id: 'new-user-can-create', title: tH('users_can_create'), onchange: '' }]) +
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
  h += '<div class="ctx-sep"></div><div class="ctx-item" data-action="display">' + tH('users_set_display') + '</div>';
  h += '<div class="ctx-sep"></div><div class="ctx-item danger" data-action="delete">' + tH('delete') + '</div>';
  var r = btn.getBoundingClientRect();
  window._openMenuAt(h, r.left, r.bottom + 2, function(action, item) {
    if (action === 'set-pw') _setUserPassword(name);
    else if (action === 'role') _setUserRole(name, item.dataset.role);
    else if (action === 'allowlist') _editUserAllowlist(name);
    else if (action === 'can-create') _setUserCanCreate(name, !u.can_create);
    else if (action === 'display') _setUserDisplay(u);
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
      _showToast(_openLockedOr(r.j, 'users_create_failed'));
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
      ? '<span class="ms-allow-count">' + fmtNum(o.article_count) + '</span>' : '';
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
    ? '<div class="ms-pa-env">' + tH('users_pa_env') + ' <code dir="ltr">ZIMI_PUBLIC_ACCESS=' + esc(pa.env_mode || '') + '</code></div>'
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

// The server's refusal while anyone can manage Zimi, in the reader's
// words; else the given key's text.
function _openLockedOr(j, key) {
  return j && j.error === 'open_locked' ? t('open_locked') : t(key);
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
  var body = document.getElementById('ms-users-body');
  if (body) body.innerHTML = _msUsersHtml();
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
    if (!r.ok) { errEl.textContent = _openLockedOr(r.j, 'users_create_failed'); errEl.style.display = 'block'; return; }
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
// What someone goes by in games and on the boards, set for them (the same sheet and rules as their own).
function _setUserDisplay(u) {
  _displayNameSheet({
    current: u.display || u.name,
    title: t('users_set_display_for', { name: u.name }),
    save: function (val) {
      return _usersPost({ action: 'set-display', name: u.name, display: val }).then(function (r) {
        if (r.ok) { _usersData = r.j; _refreshUsersPane(); }
        return { status: r.ok ? 200 : (r.j && r.j.error === 'name taken' ? 409 : 400), j: r.j };
      });
    },
  });
}

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
// null means the server has not finished looking — finding out whether the
// rendered engine works means launching a browser. "Not looked" is not "not
// installed", and showing the second for the first tells an admin their
// browser is missing when it is not.
function _creatorStateHtml(ready, hint) {
  if (ready === null || ready === undefined) {
    return '<span class="app-update-quiet">' + tH('creator_checking') + '</span>';
  }
  var cls = ready ? 'app-update-badge' : 'app-update-quiet';
  var text = tH(ready ? 'creator_installed' : 'creator_not_installed');
  return '<span class="' + cls + '"' + (hint ? ' title="' + escAttr(hint) + '"' : '') + '>' + text + '</span>';
}

// The one command that fixes a missing part. Shown under the row it belongs
// to, and only when that part is actually missing — never while we are still
// finding out, or the pane offers an install for something already installed.
function _creatorInstallHtml(ready, cmd) {
  if (ready === null || ready === undefined) return '';
  return ready ? '' : '<code class="app-update-cmd" dir="ltr">' + esc(cmd) + '</code>';
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
  // nav tab already says Capture, and that engine-status block reads as debug
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
// The sidecar's row, from the whole payload rather than from the sidecar
// object: null there means the server is still looking, and both the first
// paint and the later patch have to say so the same way.
function _creatorSidecarCell(d) {
  return d.sidecar ? _creatorSidecarHtml(d.sidecar) : _creatorStateHtml(null);
}
function _creatorSidecarCmd(d) {
  return _creatorInstallHtml(d.sidecar ? d.sidecar.installed : null, _creatorSetupCmd('zimi import --setup', d));
}
// A setup command aimed at THIS server's data dir: run from a terminal without
// the service's config, the bare command installs into another one and the
// engine stays grey with nothing to say why (#61; the Create page already
// names it, see create.js _createSidecarCommand).
function _creatorSetupCmd(base, d) {
  return d && d.data_dir ? base + ' --data-dir ' + _shellQuote(d.data_dir) : base;
}

// Every capture engine names its version beside its state, short, as a
// link to what the engine is (Eric, 2026-10-05: "Just show version and
// maybe I can click link to discover what the engine is ... for the
// browsers they're like dim small under that row").
var _ENGINE_LINKS = {
  chromium: ['Chromium', 'https://www.chromium.org/'],
  playwright: ['Playwright', 'https://playwright.dev/'],
  warc2zim: ['warc2zim', 'https://github.com/openzim/warc2zim'],
  arcticzim: ['ArcticZim', 'https://github.com/IMayBeABitShy/ArcticZim/commit/']
};
function _engineLink(key, version, path) {
  var e = _ENGINE_LINKS[key];
  return '<a class="cr-ver" href="' + escAttr(e[1] + (path || '')) + '" target="_blank" rel="noopener" title="' + escAttr(e[0]) + '">' + esc(version) + '</a>';
}
function _creatorVersionedHtml(versionHtml, ready) {
  return (versionHtml ? versionHtml + ' ' : '') + _creatorStateHtml(ready);
}
function _creatorSidecarHtml(sidecar) {
  return _creatorVersionedHtml(sidecar.version ? _engineLink('warc2zim', sidecar.version) : '', sidecar.installed);
}
// "Chromium 153.0.8010.12, Playwright 1.63.0": its major on the row, the
// whole of it dim under the row.
function _browserParts(d) {
  var m = /Chromium ([^,\s]+)(?:, Playwright ([^,\s]+))?/.exec((d.browser_ready && d.browser_version) || '');
  return m ? { chromium: m[1], playwright: m[2] || '' } : null;
}
// Its versions are the line under it (Eric, 2026-10-05: "Drop the 153 the
// versions are already below, right-align").
function _creatorBrowserCell(d) {
  return _creatorStateHtml(d.browser_ready);
}
function _creatorBrowserDetail(d) {
  var p = _browserParts(d);
  if (!p) return '';
  return '<div class="ms-hint cr-detail">' + _engineLink('chromium', 'Chromium ' + p.chromium) +
    (p.playwright ? ' · ' + _engineLink('playwright', 'Playwright ' + p.playwright) : '') + '</div>';
}
function _creatorRedditCell(d) {
  return _creatorVersionedHtml(d.reddit_version ? _engineLink('arcticzim', d.reddit_version, d.reddit_version) : '', d.reddit_ready);
}


// Whether captures from the web may reach a private address: an admin's switch,
// not a capture default, so it sits apart from the form, wired to the same
// admin-only POST half of /manage/creator.
function _creatorPrivateRow(d) {
  var locked = !!d.private_locked;
  return { id: 'ms-cr-allow_private', title: tH('creator_private'), desc: tH(locked ? 'creator_private_locked_open' : 'creator_private_hint'),
    on: !locked && _creatorSwitchOn(d, 'allow_private'), disabled: locked, onchange: '_setCreatorDefault(\'allow_private\', this)' };
}
// A stored switch, or the factory one the server answers for block_ads and
// capture_variants (their *_default fields); the rest are off until stored.
function _creatorSwitchOn(d, key) {
  if ((key + '_default') in d) return !!d[key + '_default'];
  return !!(d.defaults && d.defaults[key] === true);
}

// The defaults form is Create's own (create.js draws it from its field table),
// so the pane fetches create.js the first time it needs it.
function _creatorDefaultsHtml(d) {
  if (typeof _createDefaultsFormHtml === 'function') return _createDefaultsFormHtml(d);
  _creatorLoadForm();
  return _loadingHtml();
}
function _creatorLoadForm() {
  _loadScript('/static/create.js?v=1').then(function(ok) {
    if (!ok) return;
    _createLoaded = true;
    var slot = document.getElementById('ms-cr-defaults');
    if (slot && _creatorData) slot.innerHTML = _createDefaultsFormHtml(_creatorData);
  });
}


function _creatorQueueHtml(queue) {
  return queue
    ? esc(t('creator_queue_n', { n: queue }))
    : '<span class="app-update-quiet">' + tH('creator_queue_empty') + '</span>';
}

function _creatorHtml(d) {
  var sep = '<div style="border-top:1px solid var(--border);margin:16px 0 14px"></div>';

  // Defaults a new capture starts with — the control you actually touch.
  var h = '<div class="ms-section-label">' + tH('creator_defaults') + '</div>' +
    '<div class="ms-hint cr-defaults-hint">' + tH('creator_defaults_hint') + '</div>' +
    '<div class="cr-defaults" id="ms-cr-defaults">' + _creatorDefaultsHtml(d) + '</div>' +
    _switchRowsHtml([_creatorPrivateRow(d)]);

  // The queue, when it matters.
  h += sep + '<div class="ms-section-label">' + tH('creator_queue') + '</div>' +
    _mcRow(tH('creator_queued'), '<span id="ms-cr-queue">' + _creatorQueueHtml(d.queue) + '</span>');

  // Capabilities — the "what's installed" report.
  h += sep + '<div class="ms-section-label">' + tH('creator_engines') + '</div>' +
    '<div class="ms-hint" style="margin-bottom:10px">' + tH('creator_engines_hint') + '</div>' +
    _mcRow(tH('creator_browser'), '<span id="ms-cr-browser">' + _creatorBrowserCell(d) + '</span>') +
    '<div id="ms-cr-browser-detail">' + _creatorBrowserDetail(d) + '</div>' +
    '<div id="ms-cr-browser-cmd">' + _creatorInstallHtml(d.browser_ready, "pip install 'zimi[browser]' && playwright install chromium") + '</div>' +
    _mcRow(tH('creator_sidecar'), '<span id="ms-cr-sidecar">' + _creatorSidecarCell(d) + '</span>') +
    '<div id="ms-cr-sidecar-cmd">' + _creatorSidecarCmd(d) + '</div>' +
    _mcRow(tH('creator_reddit'), '<span id="ms-cr-reddit">' + _creatorRedditCell(d) + '</span>') +
    '<div id="ms-cr-reddit-cmd">' + _creatorInstallHtml(d.reddit_ready, _creatorSetupCmd('zimi create --setup-reddit', d)) + '</div>';

  // Created LAST: an unbounded, growing list, and the slow half to gather
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
  // Never synchronously. This is called from inside _creatorHtml, WHILE that
  // function is still building the string it is about to return — so a fill
  // that runs now writes into the DOM the pane is about to replace, and the
  // "Loading…" placeholder in the string being built lands on top of it and
  // stays there for ever (Eric: "MADE HERE never completes Loading…").
  //
  // Nothing about the fetch made this visible: it happens precisely when the
  // answer is ALREADY here, so the faster the server is, the more reliably it
  // hangs. A timeout puts the fill after the caller's innerHTML assignment,
  // the same way _msCreatorHtml already defers its own first render.
  if (_creatorInventory) { setTimeout(fill, 0); return; }
  // Never a sign-in prompt from here: a signed-in reader opening their own
  // settings got the admin one, and Cancel sent them home.
  authedFetch('/manage/creator/inventory').then(function(r) {
    if (!r.ok) throw new Error('inventory ' + r.status);
    return r.json();
  }).then(function(d) {
    _creatorInventory = d;
    fill();
  }).catch(function() {
    var el = document.getElementById('ms-cr-made');
    if (el) el.innerHTML = '<div class="ms-hint">' + tH('creator_made_empty') + '</div>';
  });
}

// The provenance types, in the order the breakdown reads them. Each chip is
// its count in words, pluralized (creator_made_<type>_<plural category>: "5
// pages", not "5 page"), the number in bold. A type with a zero count is left
// out of the chip row entirely: a wall of "0 · 0 · 0" is noise, not information.
// The table's Type column names each with the label key paired here.
var _CREATOR_TYPE_KEYS = {
  page: 'zi_kind_page', site: 'zi_kind_site', video: 'zi_kind_video',
  import: 'zi_kind_import', folder: 'zi_kind_folder',
  export: 'zi_kind_export', edit: 'zi_kind_edit', reddit: 'create_mode_reddit'
};
function _creatorMadeChip(type, n) {
  return '<span class="cr-made-chip">' +
    tPluralH('creator_made_' + type, n).replace(String(n), '<b>' + n + '</b>') + '</span>';
}
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
  Object.keys(_CREATOR_TYPE_KEYS).forEach(function(type) {
    if (counts[type]) chips += _creatorMadeChip(type, counts[type]);
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
  var put = function(id, html) {
    var el = document.getElementById(id);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  };
  put('ms-cr-browser', _creatorBrowserCell(d));
  put('ms-cr-browser-detail', _creatorBrowserDetail(d));
  put('ms-cr-browser-cmd', _creatorInstallHtml(d.browser_ready, "pip install 'zimi[browser]' && playwright install chromium"));
  put('ms-cr-sidecar', _creatorSidecarCell(d));
  put('ms-cr-sidecar-cmd', _creatorSidecarCmd(d));
  put('ms-cr-reddit', _creatorRedditCell(d));
  put('ms-cr-reddit-cmd', _creatorInstallHtml(d.reddit_ready, _creatorSetupCmd('zimi create --setup-reddit', d)));
  put('ms-cr-queue', _creatorQueueHtml(d.queue));
  var priv = document.getElementById('ms-cr-allow_private');
  if (priv) {
    // The same rule as _creatorPrivateRow: off and held while anyone manages Zimi.
    priv.checked = !d.private_locked && _creatorSwitchOn(d, 'allow_private');
    priv.disabled = !!d.private_locked;
  }
}

// How long to wait before asking again while the server is still probing what
// this machine can capture with. A browser launch is the slow one, measured at
// about 2.5s on a NAS.
var CREATOR_PROBE_RETRY_MS = 1500;
var _creatorProbeTimer = null;

function _renderCreatorSection() {
  if (!document.getElementById('ms-creator')) return;
  manageFetch('/manage/creator').then(function(r) { return r.json(); }).then(function(d) {
    var first = !_creatorData;
    var changed = first || JSON.stringify(_creatorData) !== JSON.stringify(d);
    _creatorData = d;
    var slot = document.getElementById('ms-creator');
    if (!slot || _msSection !== 'creator') return;
    if (first) slot.innerHTML = _creatorHtml(d);
    else if (changed) _patchCreatorSection(d);
    // The pane paints at once with what is known and fills the capability rows
    // in when the server's probe lands, rather than holding the whole thing
    // back for a browser launch.
    clearTimeout(_creatorProbeTimer);
    if (d.probing) {
      _creatorProbeTimer = setTimeout(function() {
        if (_msSection === 'creator') _renderCreatorSection();
      }, CREATOR_PROBE_RETRY_MS);
    }
  }).catch(function() {
    var slot = document.getElementById('ms-creator');
    // A cached paint stays up through a failed refresh — stale beats blank.
    if (slot && !_creatorData) slot.innerHTML = '<div class="ms-hint">' + tH('could_not_load') + '</div>';
    // One failed ask must not end the asking: "Checking…" then stayed until
    // the pane was left and reopened (Eric: "stuck checking?").
    clearTimeout(_creatorProbeTimer);
    if (_creatorData && _creatorData.probing) {
      _creatorProbeTimer = setTimeout(function() {
        if (_msSection === 'creator') _renderCreatorSection();
      }, CREATOR_PROBE_RETRY_MS);
    }
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
  _postCreatorDefaults(body).then(function(d) {
    input.checked = _creatorSwitchOn(d, key);
    _showToast(t('saved'));
  }).catch(function() {
    input.checked = !want;
    _showToast(t('error'));
  }).finally(function() { input.disabled = false; });
}

// A value default edited: stored when the server accepts it, and the field
// settles on what the server kept (a time limit typed as 480m reads 8h). An
// empty field clears the default. A refusal is shown as the server's own
// sentence and the field goes back to what is stored.
function _setCreatorField(key, input) {
  var body = {};
  body[key] = input.value.trim();
  input.disabled = true;
  _postCreatorDefaults(body).then(function(d) {
    if (input.tagName === 'SELECT') input.value = (d.defaults && d.defaults[key]) || '';
    else if (input.inputMode === 'decimal') input.value = d.defaults && d.defaults[key] != null ? String(d.defaults[key]) : '';
    else input.value = (d.defaults_text && d.defaults_text[key]) || '';
    _showToast(t('saved'));
  }).catch(function(e) {
    var d = _creatorData || {};
    if (input.tagName === 'SELECT') input.value = (d.defaults && d.defaults[key]) || '';
    else input.value = (d.defaults_text && d.defaults_text[key]) || '';
    _showToast((e && e.serverMessage) || t('error'));
  }).finally(function() {
    input.disabled = false;
    if (input.tagName === 'SELECT' && typeof _createMarkDefault === 'function') _createMarkDefault(input);
  });
}

// A list default (the kinds a capture leaves out) ticked or unticked: the
// whole list is stored, and the boxes settle on what the server kept.
function _setCreatorList(key, name) {
  var boxes = Array.prototype.slice.call(document.querySelectorAll('input[name="' + name + '"]'));
  var body = {};
  body[key] = boxes.filter(function(b) { return b.checked; }).map(function(b) { return b.value; });
  var settle = function(d) {
    var kept = (d && d.defaults && d.defaults[key]) || [];
    boxes.forEach(function(b) { b.checked = kept.indexOf(b.value) >= 0; });
  };
  _postCreatorDefaults(body).then(function(d) { settle(d); _showToast(t('saved')); })
    .catch(function(e) { settle(_creatorData); _showToast((e && e.serverMessage) || t('error')); });
}

// POST /manage/creator and keep the pane's copy of the stored defaults in step.
// A 400 carries the sentence to show, on the rejection as ``serverMessage``.
function _postCreatorDefaults(body) {
  return manageFetch('/manage/creator', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r) {
    return r.json().catch(function() { return {}; }).then(function(d) {
      if (!r.ok) {
        var err = new Error('http ' + r.status);
        err.serverMessage = d && d.error;
        throw err;
      }
      if (_creatorData) {
        _creatorData.block_ads_default = d.block_ads_default;
        _creatorData.capture_variants_default = d.capture_variants_default;
        _creatorData.defaults = d.defaults;
        _creatorData.defaults_text = d.defaults_text;
      }
      return d;
    });
  });
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
// The frequency control. Same id, same handler, same env lock as before — the
// poll gating and two other renderers read #auto-update-freq by name.
function _autoUpdateSelectHtml(au) {
  var cur = au.enabled ? (au.frequency || 'weekly') : 'disabled';
  var opts = AU_FREQUENCIES.map(function(f) {
    return '<option value="' + f + '"' + (f === cur ? ' selected' : '') + '>' +
      esc(t('au_' + f)) + '</option>';
  }).join('');
  // Styled as every Settings select is (.ms-pane select).
  var lock = au.locked ? ' disabled title="' + escAttr(t('au_controlled_by_env')) + '"' : '';
  var select = '<select id="auto-update-freq" onchange="toggleAutoUpdate()"' + lock + '>' + opts + '</select>';
  // A greyed-out control with the reason hidden in a hover tooltip reads as
  // broken, and did (#69): the reporter saw "Daily" that would not change and
  // no way to learn why. The reason goes beside it.
  if (au.locked) {
    select += '<div class="ms-hint au-why">' + tH('au_controlled_by_env') + '</div>';
  }
  return select;
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

// What the ZIM count is made of, under it and quieter: the ones from the
// catalog (the updater can check them for a newer edition) and the local ones
// (made here, or brought in with no catalog edition to match). Only when
// there are local ones: an all-catalog library needs no breakdown.
function _libSplitHtml(coverage) {
  if (!coverage) return '';
  var tracked = (coverage.tracked || []).length;
  var local = (coverage.skipped || []).length;
  if (!local) return '';
  return '<div class="mc-row mc-sub"><span class="mc-label">' + tH('au_from_catalog') + '</span><span class="mc-value">' + esc(String(tracked)) + '</span></div>' +
    '<div class="mc-row mc-sub"><span class="mc-label">' + tH('au_local') + '</span><span class="mc-value">' + esc(String(local)) + '</span></div>';
}

// What each folder another program owns contributes, one quiet line under the
// total it is part of: "Project NOMAD  9" under the ZIM count, its size
// under the total size.
function _libShareRowsHtml(shares, size) {
  return (shares || []).map(function(f) {
    return '<div class="mc-row mc-sub"><span class="mc-label">' + esc(f.label) + '</span><span class="mc-value">' +
      esc(size ? fmtSize(f.size_gb) : String(f.zims)) + '</span></div>';
  }).join('');
}
function _paintLibShares(d) {
  var c = document.getElementById('ms-share-count'), z = document.getElementById('ms-share-size');
  if (c) c.innerHTML = _libShareRowsHtml(d.from_folders, false);
  if (z) z.innerHTML = _libShareRowsHtml(d.from_folders, true);
}

function _autoUpdateHtml(au) {
  // Frequency alone. The last-run / next-run clock rows are gone: operational
  // noise the operator did not ask for. How much of the library the updater
  // can check reads under the ZIM count (_libSplitHtml).
  return '<div class="ms-section-label">' + tH('auto_update') + '</div>' +
    _mcRow(tH('au_frequency'), _autoUpdateSelectHtml(au)) + _autoUpdateScopeHtml(au);
}
// Which ZIMs the updater leaves alone, said once under the frequency, only
// when there are some: local ones, and those another program looks after.
function _autoUpdateScopeHtml(au) {
  var folders = ((_manageStatusData && _manageStatusData.from_folders) || []).map(function(f) { return f.label; });
  var local = au.coverage && (au.coverage.skipped || []).length;
  if (!folders.length && !local) return '';
  var line = folders.length ? tH('au_scope_folders', { label: folders.join(', ') }) : tH('au_scope_local');
  return '<div class="ms-hint">' + line + '</div>';
}

// Repaint the section from server truth. The library pane draws it once from
// the status payload it already has (so the select is never missing while a
// second request is in flight), then this fills in the select and the split.
function _renderAutoUpdateSection() {
  var el = document.getElementById('ms-auto-update');
  if (!el) return;
  manageFetch('/manage/auto-update').then(function(r) { return r.json(); }).then(function(d) {
    var slot = document.getElementById('ms-auto-update');
    if (slot) slot.innerHTML = _autoUpdateHtml(d);
    var split = document.getElementById('ms-lib-split');
    if (split) split.innerHTML = _libSplitHtml(d.coverage);
  }).catch(function() {});
}

function _msLibraryHtml() {
  var d = _manageStatusData;
  if (!d) return '<div class="loading"><span class="spinner-inline"></span>Loading\u2026</div>';
  var h = '<div class="mc-row"><span class="mc-label">' + tH('zim_files') + '</span><span class="mc-value" id="ms-zim-count">' + esc(String(d.zim_count)) + '</span></div>' +
    '<div id="ms-lib-split"></div>' +
    '<div id="ms-share-count">' + _libShareRowsHtml(d.from_folders, false) + '</div>' +
    '<div class="mc-row"><span class="mc-label">' + tH('total_size') + '</span><span class="mc-value" id="ms-total-size">' + fmtSize(d.total_size_gb) + '</span></div>' +
    '<div id="ms-share-size">' + _libShareRowsHtml(d.from_folders, true) + '</div>' +
    // Summary line + (only when updates exist) an expandable detail panel. The
    // row's state, clickability and detail are all driven by _renderUpdatesSummary
    // — the single writer — so the top-level label never strands on "Checking…".
    '<div id="update-status" class="mc-row">' +
      '<span class="mc-label">' + tH('updates') + '</span>' +
      '<span class="mc-value" style="color:var(--text2)"><span class="spinner-inline"></span>' + tH('updates_checking') + '</span>' +
      // "Update all" lives on this row, right after the count it acts on;
      // _renderUpdatesSummary keeps the element across repaints.
      '<button id="update-all-btn" class="manage-btn-action" onclick="event.stopPropagation();triggerUpdate()" style="display:none">' + tH('update_all') + '</button></div>' +
    '<div id="updates-detail" class="updates-detail" style="display:none"></div>' +
    // Space before the ZIM auto-update block so its header doesn't crowd the
    // app-update line above it (Eric: "no spacing after Updates line").
    '<div id="ms-auto-update" style="margin-top:16px">' + _autoUpdateHtml(d.auto_update || {}) + '</div>' +
    '<div class="ms-actions">' +
      '<button class="set-btn" onclick="manageImportZim()">' + tH('import_zim') + '</button>' +
      '<button id="refresh-cache-btn" class="set-btn" onclick="settingsRefreshCache()">' + tH('refresh_cache') + '</button>' +
      '<button id="library-health-btn" class="set-btn" onclick="runLibraryHealth()">' + tH('library_health') + '</button>' +
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
    return cmpText(a.name, b.name);
  });
  var body = rows.map(function(r) {
    if (r.kind === 'torrent_meta') {
      return '<div class="health-row health-info">' +
        '<span class="health-mark">' + _healthMark('info') + '</span>' +
        '<span class="health-name">' + esc(r.name) + '</span>' +
        '<span class="health-detail">' + esc(t('health_torrent_meta')) + '</span></div>';
    }
    var issues = (r.issues && r.issues.length) ? esc(r.issues.join(', ')) :
      (r.entries != null ? esc(t('health_entries', { n: fmtNum(r.entries) })) : '');
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
  return '<div class="ms-section-label">' + tH('reorder_sections') + '</div>' +
    '<div class="ms-hint">' + tH('reorder_hint') + '</div>' +
    '<button class="pill" onclick="_msToggleCollapse(\'ms-reorder\', this)">' + tH('show_list') + '</button>' +
    '<div class="ms-collapsed-list" id="ms-reorder"' +
      ' onclick="_reorderClick(event)" ondragstart="_reorderDragStart(event)"' +
      ' ondragover="_reorderDragOver(event)" ondrop="_reorderDrop(event)"' +
      ' ondragend="_reorderDragEnd(event)">' + _reorderSectionsHtml() + '</div>';
}

// Languages: the languages shown, and the voices that say them (Eric,
// 2026-10-23: "a Languages tab under settings and group all this stuff,
// it's getting large").
function _msLanguagesHtml() {
  _vgAllOpen = false;
  return _languagesCardHtml() +
    '<div class="ms-section-label" id="ms-voices">' + tH('voices_section') + '</div>' +
    '<div id="' + _VOICES_WRAP_ID + '">' + _voicePrefsHtml() + '</div>';
}

function _msPreferencesHtml() {
  _appsCardOpen = {};
  // Apps: every app a row of the same shape, and whether results open in
  // them right under it. The rows offered to everyone (the server's choice)
  // paint from its answer into #ms-apps; an account that may not set them
  // sees none. A signed-in account's own choice follows, titled so the two
  // cards are not mistaken for one.
  var h = '<div id="ms-apps-wrap"><div id="ms-apps">' + _serverAppsHtml() + '</div></div>' +
    (_appsAllowedByServer() && _userSession
      ? _appPicksHtml(APP_NAMES.filter(_appsAllowedByServer), _appShown, '_setUserApp', false, 'user', tH('show_apps'))
      : '') +
    _switchRowsHtml([{ id: 'ms-open-in-apps', title: tH('open_in_apps'), desc: tH('open_in_apps_hint'),
      on: _openInApps() && _openInAppsPossible(), disabled: !_openInAppsPossible(), onchange: '_setOpenInApps(this.checked)' },
      { id: 'ms-show-discover', title: tH('show_discover'), on: !_getStorageFlag(SK.HIDE_DISCOVER),
        onchange: '_setShowDiscover(this.checked)' }]) +

    '<div class="ms-section-label">' + tH('ms_display_section') + '</div>' +
    '<div class="ms-theme-label">' + tH('app_theme') + '</div>' +
    _appThemeSegHtml() +
    '<div class="ms-hint" id="app-theme-hint">' + _appThemeHintHtml() + '</div>' +

    // Reading: everything about how an article reads, in one place. The two
    // choices first, then the switches.
    '<div class="ms-section-label">' + tH('ms_reader_section') + '</div>' +
    '<div class="ms-theme-label">' + tH('article_theme') + '</div>' +
    _articleThemeSegHtml() +
    '<div class="ms-hint">' + tH('article_theme_hint') + '</div>' +
    // Links that leave the library for the web (#99): marked, or plain text.
    '<div class="ms-theme-label" style="margin-top:16px">' + tH('ext_links') + '</div>' +
    _segHtml('ext-links-seg', 'ext_links', _extLinksSegInner()) +
    '<div class="ms-hint">' + tH('ext_links_hint') + '</div>' +
    _switchRowsHtml([
      // The mirror of the in-article palette's AUTO switch, same key.
      { id: 'ms-reader-auto', title: tH('reader_auto'),
        on: _readerAuto(), onchange: '_setReaderAuto(this.checked)' },
      { id: 'ms-darken-articles', title: tH('darken_articles'), desc: tH('darken_articles_hint'),
        on: _darkenArticlesOn(), onchange: '_setDarkenArticles(this.checked)' },
      { title: tH('show_cross_links'), on: !_getStorageFlag(SK.HIDE_XZIM_LINKS),
        onchange: '_setStorageFlag(SK.HIDE_XZIM_LINKS, !this.checked)' },
    ]) +

    // Default download flavor: one selector row, like the theme.
    '<div class="ms-section-label">' + tH('default_flavor') + '</div>' +
    _segHtml('ms-flavor-seg', 'default_flavor', _flavorSegInner()) +
    '<div class="ms-hint">' + tH('default_flavor_hint') + '</div>';
  // My data is this browser's (bookmarks, history, these preferences): it
  // lives with the preferences, not with the server's settings.
  h += '<div class="ms-mydata" style="margin-top:24px">' + _myDataCardHtml() + '</div>';
  // Security (password + logout) lives in the Users pane ("Your account").
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
      '<code class="app-update-cmd" dir="ltr">' + esc(cmd) + '</code>';
  }
  if (type === 'snap') return '<div class="ms-hint">' + tH('app_update_how_snap') + '</div>';
  if (type === 'desktop-mac' || type === 'desktop-windows') {
    // Sparkle/WinSparkle self-updates only under Automatically: offline, Ask
    // first and Never never start it, so the releases page is the path.
    return (d.offline || (d.check_mode && d.check_mode !== 'auto'))
      ? '<div class="ms-hint">' + tH('app_update_how_releases') + ' ' + _appUpdateReleasesLink(d) + '</div>'
      : '<div class="ms-hint">' + tH('app_update_how_desktop') + '</div>';
  }
  // appimage, plain frozen linux, and anything unrecognized: point at releases.
  return '<div class="ms-hint">' + tH('app_update_how_releases') + ' ' + _appUpdateReleasesLink(d) + '</div>';
}

// How long a release must have been public before this instance is offered
// it. Locked (ZIMI_UPDATE_DELAY_DAYS) renders the same select, disabled with
// the standard env-controlled note, so the setting stays visible instead of
// vanishing on the deployments most likely to set it.
//
// One row: label and <select>. The setting's explanation is the select's
// tooltip; only a lock earns a visible line, because it says why the control
// does nothing.
function _appUpdateSelectRow(o) {
  var lockNote = t('env_controlled', { v: o.envVar });
  return '<div class="mc-row" style="align-items:center">' +
      '<span class="mc-label">' + esc(t(o.labelKey)) + '</span>' +
      // Styled as every Settings select is (.ms-pane select).
      '<span class="mc-value"><select id="' + escAttr(o.id) + '"' +
        ' title="' + escAttr(o.locked ? lockNote : t(o.hintKey)) + '"' + (o.locked ? ' disabled' : '') +
        ' onchange="' + escAttr(o.onchange) + '">' + o.options + '</select></span></div>' +
    (o.locked ? '<div class="ms-hint">' + esc(lockNote) + '</div>' : '');
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
    : (d.offline || d.check_mode === 'never' ? '' : '<button class="pill" onclick="_appUpdateCheckNow()">' +
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
  return d.offline ? '' : _appUpdateCheckHtml(d) + _appUpdateDelayHtml(d);
}

// "Check for updates": Ask first / Automatically / Never, the choice the
// satellite data offers too, with the same labels (alm_earth_sat_<mode>).
function _appUpdateCheckHtml(d) {
  // A selector row, as every three-way choice in Settings is; locked, its
  // buttons are disabled and the hint names the variable.
  var locked = !!d.check_locked;
  var btns = (d.check_modes || ['ask', 'auto', 'never']).map(function(m) {
    var on = m === d.check_mode;
    return '<button type="button" class="app-theme-btn' + (on ? ' active' : '') + '" role="radio" aria-checked="' + on + '"' +
      (locked ? ' disabled' : '') + ' onclick="_appUpdateSetCheck(\'' + escAttr(m) + '\')"><span>' + tH(m === 'never' ? 'app_check_never' : 'alm_earth_sat_' + m) + '</span></button>';
  }).join('');
  return '<div class="ms-theme-label">' + tH('app_update_check') + '</div>' +
    '<div class="app-theme-seg" id="' + _APP_UPDATE_CHECK_ID + '" role="radiogroup" tabindex="-1" aria-label="' + escAttr(t('app_update_check')) + '" title="' + escAttr(t('app_update_check_hint')) + '">' + btns + '</div>' +
    (locked ? '<div class="ms-hint">' + esc(t('env_controlled', { v: d.check_env || 'ZIMI_UPDATE_CHECK' })) + '</div>' : '');
}
var _APP_UPDATE_CHECK_ID = 'app-update-check';

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
    status = '<span class="app-update-badge">' + tH('app_update_available', { v: d.latest }) + '</span>';
  } else if (d.update_held) {
    // The release exists and we know it — say so quietly instead of showing
    // "up to date", which would be a lie the user could check.
    status = '<span class="app-update-quiet">' +
      tH('app_update_held', { v: d.latest, d: tPlural('app_update_delay_days', _appUpdateHeldDays(d)) }) + '</span>';
  } else if (d.offline) {
    status = '<span class="app-update-quiet">' + tH('app_update_offline') + '</span>';
  } else if (d.check_mode === 'never') {
    // A months-old "Up to date" would be a claim nobody is checking.
    status = '<span class="app-update-quiet">' + tH('app_update_checks_off') + '</span>';
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
// says so and everything else stays put — the choices the admin made are
// still true, whatever the network did.
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

// The update settings answer with the full app-update payload, so the
// response IS the repainted state. The only reachable error is the env lock
// (the select is disabled then, so that means a second browser raced a config
// change) — say so and repaint from server truth.
function _appUpdateSaveSetting(path, body, envVar) {
  if (!document.getElementById(_APP_UPDATE_ID)) return;
  _appUpdateShowChecking();
  return manageFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d && d.error) { _showToast(t('env_controlled', { v: envVar })); _renderAppUpdate(false); return; }
    _appUpdatePaint(d);
  }).catch(function() { _renderAppUpdate(false); });
}

function _appUpdateSetCheck(mode) {
  var saved = _appUpdateSaveSetting('/manage/app-update-mode', { mode: mode }, 'ZIMI_UPDATE_CHECK');
  if (saved) saved.then(_renderNetSection);
}

function _appUpdateSetDelay(days) {
  _appUpdateSaveSetting('/manage/app-update-delay', { delay_days: parseInt(days, 10) }, 'ZIMI_UPDATE_DELAY_DAYS');
}

// "What Zimi fetches from the internet" (outbound.py): every destination, one
// row each, what sets it off and whether it happens on its own. Folded to one
// line, the count of each, so a phone reads the answer without scrolling past
// ten rows; open, each row says where it goes and links to its switch.
var _NET_ID = 'ms-net';
// A row's switch, as the element this pane draws it in (scrolled to), or the
// settings section that has it. Rows without one change only by the person's
// own action (a download, a capture) or by ZIMI_OFFLINE.
var _NET_CONTROLS = {
  update_check: _APP_UPDATE_CHECK_ID,
  voices: 'ms-voices',
  sharing: 'ms-mirror-status',
  auto_update: 'library'
};

function _netGo(control) {
  var target = _NET_CONTROLS[control];
  if (target === 'ms-voices') { _openSettingsAt(target); return false; }
  if (_MS_SECTIONS.indexOf(target) >= 0) { switchMs(target); return false; }
  var el = document.getElementById(target);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (el.focus) el.focus({ preventScroll: true });
  }
  return false;
}

// Offline, no row has a switch to go to: ZIMI_OFFLINE has taken them all.
function _netRowHtml(r, offline) {
  var hosts = (r.hosts || []).map(function(h) { return '<code dir="ltr">' + esc(h) + '</code>'; }).join(' ');
  var go = !offline && _NET_CONTROLS[r.control]
    ? '<a href="#" class="net-go" onclick="return _netGo(\'' + escAttr(r.control) + '\')">' + tH('net_change') + '</a>'
    : '';
  // The link sits in the state's column, right under it, on every row: at
  // the end of whichever line came last it wandered row to row (Eric:
  // "change isn't even uniformly placed").
  return '<li class="net-row">' +
    '<span class="net-name">' + tH('net_' + r.id) + '</span>' +
    '<span class="net-state net-state-' + escAttr(r.state) + '">' + tH('net_state_' + r.state) + '</span>' +
    '<span class="net-what">' + tH('net_' + r.id + '_when') + '</span>' +
    '<span class="net-act">' + go + '</span>' +
    (hosts ? '<span class="net-where">' + hosts + '</span>' : '') +
    '</li>';
}

function _netSummaryHtml(d) {
  if (d.offline) return tH('net_offline');
  var n = { auto: 0, ask: 0, off: 0 };
  (d.rows || []).forEach(function(r) {
    if (r.state === 'auto' || r.state === 'ask') n[r.state]++;
    else if (r.state !== 'lan') n.off++;
  });
  return tH('net_summary', { a: n.auto, b: n.ask, c: n.off });
}

function _netHtml(d) {
  return '<details class="net-details"><summary>' + _netSummaryHtml(d) + '</summary>' +
    '<ul class="net-rows">' + (d.rows || []).map(function(r) { return _netRowHtml(r, d.offline); }).join('') + '</ul>' +
    '<div class="ms-hint">' + tH('net_hint') + '</div></details>';
}

// The element is looked up after the fetch (see _renderEnvSection for why).
// The <details> keeps whether it is open across a repaint after a change.
async function _renderNetSection() {
  var d = null;
  try { d = await _msFetch('/manage/outbound'); } catch (e) {}
  var el = document.getElementById(_NET_ID);
  if (!el) return;
  if (!d) { el.innerHTML = '<div class="ms-hint">' + tH('net_unavailable') + '</div>'; return; }
  var open = !!el.querySelector('details[open]');
  el.innerHTML = _netHtml(d);
  if (open) el.querySelector('details').open = true;
}

// The server-wide apps switch. The element is looked up after the fetch
// (see _renderEnvSection for why).
async function _renderAppsSection() {
  var d = null, refused = false;
  try { d = await _msFetch('/manage/apps'); } catch (e) { refused = /^http 40[13]$/.test(e && e.message); }
  var wrap = document.getElementById('ms-apps-wrap');
  if (!document.getElementById('ms-apps')) return;
  // Only the server saying no takes the rows away. No answer at all (offline,
  // the server restarting) leaves them as the page drew them, from the apps
  // it was served with: hiding them then made Preferences jump, and empty
  // offline.
  if (!d) { if (wrap && refused) wrap.hidden = true; return; }
  if (wrap) wrap.hidden = false;
  _serverApps = Array.isArray(d.shown) ? d.shown : (d.enabled ? APPS_DEFAULT : []);
  _serverAppsLocked = !!d.env_locked;
  _setHtmlIfChanged('ms-apps', _serverAppsHtml());
  _syncOpenInAppsRow();
}
// What the server offers, as far as the page knows: the stamp it booted with
// (the default apps, none, or the names), until /manage/apps answers.
var _serverApps = null;
var _serverAppsLocked = false;
function _serverAppsNow() { return _serverApps || APP_NAMES.filter(_appsAllowedByServer); }
function _serverAppsHtml() {
  var shown = _serverAppsNow();
  return _appPicksHtml(APP_NAMES, function(app) { return shown.indexOf(app) >= 0; }, '_setAppForServer', _serverAppsLocked, 'server', tH('apps_section'), _serverAppsAllHtml()) +
    (_serverAppsLocked ? '<div class="ms-hint">' + tH('env_controlled', { v: 'ZIMI_APPS' }) + '</div>' : '');
}
// All and None sit on the section's header line, out of the rows' way.
function _serverAppsAllHtml() {
  return _serverAppsLocked ? ''
    : '<button type="button" class="set-head-btn" onclick="_setAppsForServerAll(true)">' + tH('filter_all') + '</button>' +
      '<button type="button" class="set-head-btn" onclick="_setAppsForServerAll(false)">' + tH('apps_none') + '</button>';
}
// Every app is listed, an opt-in one (off until switched on) included.
function _setAppsForServerAll(on) { _postServerApps(on ? APP_NAMES : []); }
function _setAppForServer(app, on) {
  var shown = _serverAppsNow();
  _postServerApps(APP_NAMES.filter(function(a) { return a === app ? on : shown.indexOf(a) >= 0; }));
}
function _postServerApps(shown) {
  manageFetch('/manage/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shown: shown }) })
    .then(function(r) { return r.json(); }).then(function(d) {
      if (d && d.error) { _showToast(t('env_controlled', { v: 'ZIMI_APPS' })); }
      // The shell's stamp is read at render; refresh it here so the home
      // page follows without a reload.
      if (d && Array.isArray(d.shown)) _setAppsStamp(d.shown.join(',') === APPS_DEFAULT.join(',') ? null : d.shown.join(',') || '0');
      _renderAppsSection();
      // And the home page behind, if that is what is showing: the Apps row
      // stayed until something else redrew it (#88).
      if (mode === 'home' && typeof renderHome === 'function') renderHome();
    }).catch(function() { _renderAppsSection(); });
}

// The environment panel. Read-only, and usually empty: the common install
// overrides nothing, and saying so plainly is the useful answer.
// A path, a URL, an env name: left to right in a right-to-left page, so
// /zims keeps its slash at the start in Hebrew. Isolated, so it never
// reorders the words around it. ``html`` is already escaped.
function _ltr(html) { return '<bdi dir="ltr">' + html + '</bdi>'; }

async function _renderEnvSection() {
  var rows;
  var fetched;
  try {
    fetched = await _msFetch('/manage/env');
  } catch (e) {
    fetched = null;
  }
  // The element is looked up AFTER the fetch, never before: this runs while
  // _msServerHtml is still building the pane's markup, so at call time there
  // is no #ms-env yet. Capturing null then and testing it later left the
  // section on "Loading…" for good (Eric, from his phone, 2026-09-19).
  var el = document.getElementById('ms-env');
  if (!el) return;
  if (fetched === null) {
    // This panel's one job is to answer "is something overriding my
    // settings", and a failed poll must not look like "nothing is".
    el.innerHTML = '<div class="ms-hint">' + tH('env_unavailable') + '</div>';
    return;
  }
  rows = fetched.vars || [];
  if (!rows.length) {
    el.innerHTML = '<div class="ms-hint">' + tH('env_none') + '</div>';
    return;
  }
  // Values come from the operator's own environment, so they are escaped like
  // any other untrusted string. Secrets arrive as the word "set" and are
  // rendered in the same slot, so the row shape never gives away which is which.
  // Folded, like Internet use: the summary is the names themselves, which is
  // the answer most visits want; a tap opens what each one does.
  el.innerHTML = '<details class="net-details env-details"><summary><span class="env-names" dir="ltr">' +
    rows.map(function(r) { return esc(r.name); }).join(', ') + '</span></summary>' +
  '<div class="env-rows">' + rows.map(function(r) {
    return '<div class="env-row">' +
      '<code class="env-name">' + _ltr(esc(r.name)) + '</code>' +
      '<code class="env-value' + (r.secret ? ' env-secret' : '') + '">' +
        (r.value === '' ? tH('env_empty') : _ltr(esc(r.value))) + '</code>' +
      '<div class="env-what">' + esc(r.description) +
        (r.locks ? ' <span class="env-locks">' + tH('env_locks', {v: r.locks}) + '</span>' : '') +
        (r.source === 'config' ? ' <span class="env-locks">' + tH('env_from_config', {path: _ltr(esc(r.path))}) + '</span>' : '') +
      '</div></div>';
  }).join('') + '</div>' +
  '<div class="ms-hint">' + tH('env_hint') + '</div></details>';
}

function _msServerHtml() {
  // Sharing is the star of v1.7 — it leads the Server pane. Render the
  // last-known rows immediately (stale toggles beat a blank slab that
  // pops in); _renderMirrorSection repaints from server truth right after.
  var shareCached = '';
  try { shareCached = localStorage.getItem(SK.SHARE_ROWS) || ''; } catch (e) {}
  _natCheckedThisOpening = false;
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
  // Other programs' libraries (Project NOMAD), read where they are. Painted by
  // _renderLibFolders once the card is in the DOM.
  var _libFoldersSlot = '<div id="ms-libfolders" class="ms-libfolders"></div>';
  if (IS_DESKTOP) {
    storageSec +=
      '<div class="ms-field"><label>' + tH('zim_folder') + '</label>' +
      '<div style="display:flex;gap:8px"><input type="text" id="ms-zim-dir" dir="ltr" readonly value="' + escAttr(t('loading')) + '" style="flex:1">' +
      '<button class="set-btn" onclick="msChooseZimFolder()">' + tH('choose_folder') + '</button></div></div>' +
      '<div class="ms-field"><label>' + tH('data_folder') + '</label>' +
      '<div style="display:flex;gap:8px"><input type="text" id="ms-data-dir" dir="ltr" readonly value="' + escAttr(t('loading')) + '" style="flex:1">' +
      '<button class="set-btn" onclick="msChooseDataFolder()">' + tH('choose_folder') + '</button></div></div>' +
      '<div class="ms-hint">' + tH('data_folder_hint') + '</div>' +
      '<div class="ms-field" style="display:flex;align-items:center;gap:8px"><label style="margin:0">' + tH('port') + '</label><input type="number" id="ms-port" min="1024" max="65535" value="8899" style="width:90px">' +
        '<button class="manage-btn-action" onclick="settingsSaveInline()" style="margin-inline-start:auto">' + tH('save') + '</button></div>' +
      '<div class="ms-hint">' + tH('restart_hint') + '</div>' +
      // Painted by _renderDesktopLan from the app's own config, not /manage.
      '<div id="ms-lan"></div>' + _libFoldersSlot;
    setTimeout(_renderDesktopLan, 0);
  } else {
    storageSec +=
      '<div class="ms-field"><label>' + tH('zim_folder') + '</label><input type="text" id="ms-zim-dir" dir="ltr" readonly value="' + escAttr(t('loading')) + '"></div>' +
      '<div class="ms-field"><label>' + tH('data_folder') + '</label><input type="text" id="ms-data-dir" dir="ltr" readonly value="' + escAttr(t('loading')) + '"></div>' +
      '<div class="ms-hint">' + tH('configured_via_env') + '</div>' + _libFoldersSlot;
  }

  // The server's backup; My data, this browser's, is under Preferences.
  var backupSec = '<div id="ms-backup" class="ms-backup">' + _serverBackupCardHtml() + '</div>';

  var hotSec = '<div class="ms-section-label">' + tH('hot_zims') + '</div>' +
    '<div class="ms-hint">' + tH('hot_zims_hint') + '</div>' +
    '<div id="ms-hot-zims" style="margin-top:10px">' + tH('loading') + '</div>' +
    '<div style="margin-top:14px" id="ms-cache-info-wrap">' +
      '<div id="ms-cache-info" style="color:var(--text2);font-size:12px">' + tH('loading') + '</div></div>';

  // What the environment is overriding. Last, under Storage's neighbours,
  // because on most installs it says "nothing" — it is a thing you go looking
  // for when a control will not move, not something to read past every time.
  // The apps row, for everyone on this server. Painted from the server's
  // answer; env-locked reads as such rather than as a control that does
  // nothing.
  var envSec = '<div class="ms-section-label">' + tH('env_section') + '</div>' +
    '<div id="ms-env">' + tH('loading') + '</div>';

  // Internet use, last on the tab: everything this server can fetch, and
  // which of it happens without anyone asking.
  var netSec = '<div class="ms-section-label">' + tH('net_section') + '</div>' +
    '<div id="' + _NET_ID + '">' + tH('loading') + '</div>';

  // Sharing, Downloads, Storage, My Data / Server Backups, App Updates, Hot
  // ZIMs + cache, the environment, and Internet use last. Who can manage
  // Zimi and the API token are under Access.
  var h = [sharingSec, downloadsSec, storageSec, backupSec, updatesSec, hotSec, envSec, netSec].join(sep);
  _renderEnvSection();
  _renderNetSection();
  // These populate elements by id, so they must run AFTER this HTML is in
  // the DOM — not mid-string. Deferring one tick also lets the cached
  // sharing rows paint first, so the section never flashes empty.
  setTimeout(function() {
    if (_msSection !== 'server') return;
    _renderHotZimsSection();
    _renderSeedingSection();
    _renderMirrorSection();
    _renderDownloadSchedule();
    _renderLibFolders();
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
      '<div id="ms-bg-work" style="margin-top:10px"></div>' +
      '<div class="ms-cache-actions" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">' +
        '<button class="pill" onclick="_cacheAction(this,\'clear-search\')">' + tH('clear_search_cache') + '</button>' +
        '<button class="pill" onclick="_cacheAction(this,\'clear-suggest\')">' + tH('clear_suggest_cache') + '</button>' +
        '<button class="pill" onclick="_cacheAction(this,\'rebuild-title\')">' + tH('rebuild_title_indexes') + '</button>' +
        '<button class="pill" onclick="_cacheAction(this,\'rebuild-qid\')">' + tH('rebuild_qid_indexes') + '</button>' +
        '<span id="ms-cache-status" class="ms-hint" style="margin:0;align-self:center"></span>' +
      '</div>';
    el.innerHTML = sh;
    _renderBackgroundWork();
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


// What the server is still building on its own: the title indexes, the Q-ID
// scan, did-you-mean and ZimiTube's video details, which after a start or an
// update can run for minutes to hours. From the activity poll (in-memory, no
// disk), refreshed while anything is building and only while this section is
// open; when nothing is, it says so, which is the other half of the answer.
const _BG_WORK_POLL_MS = 5000;
let _bgWorkTimer = null;

function _bgWorkRow(label, value) {
  return '<div class="mc-row"><span class="mc-label">' + label + '</span>' +
    '<span class="mc-value" style="color:var(--amber)">' + value + '</span></div>';
}

async function _renderBackgroundWork() {
  clearTimeout(_bgWorkTimer);
  const el = document.getElementById('ms-bg-work');
  if (!el || _msSection !== 'server') return;
  let a;
  try { a = await (await manageFetch('/manage/activity')).json(); } catch (e) { return; }
  const rows = [];
  const ix = a.indexing || {};
  if (ix.state === 'building') {
    rows.push(_bgWorkRow(tH('title_indexes'),
      (ix.current ? esc(_zimTitleWithLang(ix.current)) + ' · ' : '') + tH('n_of_total', {n: ix.ready || 0, total: ix.total || 0})));
  }
  for (const job of (a.background || [])) {
    // The ZIM by its title, then how far along: "Wikipedia (Español) · 1 of 1".
    const where = job.current ? esc(_zimTitleWithLang(job.current)) : tH('in_progress');
    const count = job.total ? ' · ' + tH('n_of_total', {n: Math.min(job.done + 1, job.total), total: job.total}) : '';
    rows.push(_bgWorkRow(tH(_BG_WORK_LABEL[job.kind] || job.kind), where + count));
  }
  // What failed stays on screen: a ZIM whose rebuild failed keeps its old
  // index, and "up to date" would say otherwise.
  const failed = {};
  for (const name of (ix.failed || [])) (failed.titles = failed.titles || []).push(name);
  for (const f of (a.failed || [])) (failed[f.kind] = failed[f.kind] || []).push(f.name);
  const fails = Object.keys(failed).map(function(kind) {
    const label = kind === 'titles' ? tH('title_indexes') : tH(_BG_WORK_LABEL[kind] || kind);
    const names = failed[kind].filter(Boolean).map(esc).join(', ');
    return '<div class="mc-row"><span class="mc-label">' + label + '</span>' +
      '<span class="mc-value" style="color:var(--error)">' + tH('bg_failed') + (names ? ' · ' + names : '') + '</span></div>';
  });
  // Before the startup builder has begun there is nothing to report yet,
  // which is not the same as nothing left to do.
  const starting = !rows.length && ix.state === 'idle';
  let status = '';
  if (!rows.length && !fails.length) status = '<div class="ms-hint" style="margin:0">' + tH(starting ? 'bg_starting' : 'bg_idle') + '</div>';
  el.innerHTML = '<div class="ms-hint" style="margin:0 0 4px">' + tH('bg_heading') + '</div>' + rows.join('') + fails.join('') + status;
  if (rows.length || starting) _bgWorkTimer = setTimeout(_renderBackgroundWork, _BG_WORK_POLL_MS);
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
// One line for the closed card: which engine, and whether it is reachable
// (the built-in engine's port) or connected (a client). One dot for both.
function _btSummaryHtml(bt, starting, stColor) {
  var kind = (bt.client || {}).kind, running = bt.status === 'ready' && bt.sidecar_running;
  var engine = kind ? _btcName(kind) : t('bt_engine_builtin');
  var detail, color = stColor;
  if (starting || !running) {
    detail = t(starting ? 'bt_state_starting' : kind ? 'btc_not_connected' : 'bt_state_' + bt.status);
    if (kind && !starting) color = 'var(--error)';
  }
  else if (kind) detail = t('btc_connected');
  else {
    var reach = bt.nat ? bt.nat.reachable : null;
    detail = t('bt_port_word') + ' ' + (bt.bt_port || '') + ' ' + t(reach == null ? 'bt_port_unknown' : reach ? 'bt_port_open' : 'bt_port_closed');
    if (reach === false) color = '#d9a13d';
  }
  return '<span class="share-port-dot" style="background:' + color + '"></span><span class="bt-summary-text"><b>' + esc(engine) + '</b> · ' + esc(detail) + '</span>';
}
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
  statusEl.innerHTML = _btSummaryHtml(bt, starting, stColor);
  // Open by itself when the client it should use does not answer.
  const more = document.getElementById('ms-bt-more');
  const kind = (bt.client || {}).kind;
  if (more && kind && bt.enabled && !bt.sidecar_running && !starting && !window._btMoreTouched) more.open = true;
  // The server already works out WHY it is off — no wheel for this Python, or
  // the switch is set by the environment. Saying only "unavailable" leaves the
  // person with nothing to do about it (#70).
  // A key and its variables, translated here. The server used to compose the
  // sentence itself, which made it English in all ten languages.
  //
  // It goes UNDER the row's own text, where Mirror already puts its backup
  // line — not in the toggle column beside the switch. A sentence in that
  // column takes its width from the sentence, which left the row's description
  // ("Download and seed ZIMs over BitTorrent.") squeezed onto two lines with a
  // third of the card empty beside it, and the reason floating mid-row next to
  // a switch it is not about (#74).
  var whyEl = document.getElementById('ms-bt-why');
  if (whyEl) {
    var why = bt.hint_key ? t(bt.hint_key, bt.hint_vars || {}) : '';
    whyEl.innerHTML = why ? esc(why) : '';
    whyEl.hidden = !why;
  }
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
// noteHtml is a row-level note that must stay readable when the row is
// inactive — the sentence saying WHY it is inactive. It sits beside the title
// and description rather than inside them, because an inactive row dims its
// text and a child cannot be less transparent than its parent: an exemption
// rule nested inside the dimmed block would have been dead CSS.
function _shareSwitch(key, on, locked, envVar, titleKey, descHtml, inactive, underSwitchHtml, noteHtml) {
  return '<div class="share-row' + (locked ? ' share-locked' : '') + (inactive ? ' share-inactive' : '') + '">' +
    '<div class="share-row-text">' +
      '<div class="share-row-dim">' +
        '<div class="share-row-title">' + tH(titleKey) + '</div>' +
        '<div class="share-row-desc">' + descHtml + '</div>' +
        (locked && envVar ? '<div class="share-row-desc share-row-locknote">' + tH('env_controlled', {v: envVar}) + '</div>' : '') +
      '</div>' +
      (noteHtml || '') +
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

// Show/hide and enable/disable the BT card's inner controls in place, no
// re-render (they're always in the DOM). Env-locked fields stay locked.
// What only seeding uses (Mirror, the nightly upload window) is marked
// .needs-bt and not shown while BitTorrent is off, unless it is on itself and
// so can be switched off. #ms-pane carries the state for every card in it.
function _markBtOff(off) {
  var pane = document.getElementById('ms-pane');
  if (pane) pane.classList.toggle('ms-bt-off', off);
}
function _applyTorrentToggleInPlace(on) {
  _markBtOff(!on);
  const controls = document.getElementById('ms-bt-controls');
  const upnp = document.getElementById(_UPNP_ID);
  _showIfOn('ms-bt-more', on);
  if (controls) {
    controls.classList.toggle('share-controls-off', !on);
    Array.from(controls.querySelectorAll('input, button')).concat(upnp ? [upnp] : []).forEach(function(el) {
      if (el.dataset.envlock === '1') return;
      el.disabled = !on;
    });
  }
  const st = document.getElementById('ms-bt-status');
  // The same one line as when it is running, saying it is starting.
  if (st && on) st.innerHTML = _btSummaryHtml({ client: window._btcSaved || {} }, true, 'var(--text3)');
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
  // Off, the switch already says so; only "active" adds anything.
  if (!active) return '';
  return '<span class="share-port-dot" style="background:#6abf69"></span>' + esc(t('seeding_state_active'));
}

function _applyMirrorToggleInPlace(on) {
  const mact = document.getElementById('ms-mirror-active');
  if (mact) mact.innerHTML = _mirrorStatusHtml(on);
}

function _showIfOn(id, on) { var e = document.getElementById(id); if (e) e.hidden = !on; }
function _undoBtSetting(key, on) {
  if (key === 'torrent') _applyTorrentToggleInPlace(on);
  else if (key === 'mirror') _applyMirrorToggleInPlace(on);
  else if (key === 'peer_share') _showIfOn('ms-peer-name', on);
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
  else if (key === 'peer_share') _showIfOn('ms-peer-name', on);
  try {
    const body = {}; body[key] = on;
    const r = await manageFetch('/manage/bt-settings', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      cb.checked = !on; _showToast(t('save_failed'));
      _undoBtSetting(key, !on);
    }
  } catch (e) {
    cb.checked = !on; _showToast(t('save_failed'));
    _undoBtSetting(key, !on);
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

// Port row: [port input] [reachability dot] [retry]. Always rendered
// (disabled when BT is off) so the card height never changes on toggle.
function _portRowInner(bt, btOn) {
  var nat = bt.nat || null;
  var dotColor = !nat || nat.reachable == null ? 'var(--text3)' : (nat.reachable ? '#6abf69' : 'var(--error)');
  var dotTitle = !nat || nat.reachable == null ? t('bt_port_unknown') : (nat.reachable ? t('bt_port_open') : t('bt_port_closed'));
  var portLock = bt.bt_port_env_locked;
  var portDis = (portLock || !btOn) ? ' disabled' : '';
  return '<label>' + tH('bt_port_word') + '</label>' +
    '<span class="share-port-group">' +
      '<input type="number" class="share-num-input share-port-input" min="1024" max="65535" value="' + (bt.bt_port || '') + '"' +
        portDis + (portLock ? ' data-envlock="1" title="' + escAttr(t('env_controlled', {v: 'ZIMI_BT'})) + '"' : '') +
        ' aria-label="' + escAttr(t('bt_port_word')) + '" onchange="_setBtPort(this)">' +
      // Reachability light sits right beside the port it describes.
      '<span class="share-port-dot" id="share-port-dot" title="' + escAttr(dotTitle) + '" style="background:' + dotColor + '"></span>' +
      '<button class="share-port-retry"' + (btOn ? '' : ' disabled') + ' onclick="_natRecheck(this)" title="' + escAttr(t('bt_port_recheck_hint')) + '" aria-label="' + escAttr(t('retry')) + '">' + _SVG_REFRESH + '</button>' +
    '</span>';
}

// UPnP: a row of the built-in engine's own, under its port.
var _UPNP_ID = 'ms-bt-upnp';
function _upnpHtml(bt, btOn) {
  var lock = bt.upnp_env_locked;
  return '<div class="share-field btc-builtin"><label for="' + _UPNP_ID + '"' + (lock ? ' title="' + escAttr(t('env_controlled', {v: 'ZIMI_BT'})) + '"' : '') + '>UPnP</label>' +
    '<span><span class="switch switch-sm"><input type="checkbox" role="switch" id="' + _UPNP_ID + '"' + (bt.upnp_enabled ? ' checked' : '') +
    ((lock || !btOn) ? ' disabled' : '') + (lock ? ' data-envlock="1"' : '') + ' onchange="_setUpnp(this)"><span class="switch-slider"></span></span></span></div>';
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

// Whether peers can reach the port is asked of the port checker only when
// someone looks: the Recheck button, or the sharing settings opening with
// BitTorrent on (once per opening; nothing at startup or in the background).
// The opening's own check fails quietly: the dot keeps saying "unknown".
var _natCheckedThisOpening = false;
function _natCheckOnOpen(btOn) {
  if (!btOn || _natCheckedThisOpening) return;
  _natCheckedThisOpening = true;
  _natRecheck(document.querySelector('#share-port-row .share-port-retry'), true);
}

async function _natRecheck(btn, quiet) {
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }  // CSS spins the SVG; don't touch innerHTML
  try {
    const r = await manageFetch('/manage/nat-recheck', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}' });
    await r.json().catch(function() { return null; });
    if (!r.ok && !quiet) _showToast(t('error'));
  } catch (e) {
    if (!quiet) _showToast(t('error'));
  }
  if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
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
  // Unavailable means the machine cannot do this, whatever the stored setting
  // says. The switch showed ON beside the word "unavailable", which is the
  // panel contradicting itself — and inviting a click that cannot work. It
  // reads off and refuses the click; the reason underneath says why.
  const btUsable = !bt || bt.status !== 'unavailable';
  const btOn = !!m.torrent_enabled && btUsable;
  _markBtOff(!btOn);
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
  const limitRow = '<div class="share-field btc-builtin"><label title="' + escAttr(t('bt_limit_hint')) + '">' + tH('bt_up_limit_label') + '</label>' +
    '<span class="share-port-group">' +
    '<input type="number" min="0" step="0.5" value="' + upMb + '"' + disA(m.bt_up_env_locked) + lockA(m.bt_up_env_locked) +
    ' class="share-num-input" aria-label="' + escAttr(t('bt_limit_up')) + '" title="' + escAttr(t('bt_limit_hint')) + '" onchange="_setBtLimit(this,\'up\')">' +
    '<span class="share-field-note">↑ MB/s</span></span></div>';

  // Max connections: libtorrent's global socket cap (real, enforced). Pure BT
  // engine setting, so it greys with the engine.
  const connRow = '<div class="share-field btc-builtin"><label title="' + escAttr(t('bt_max_conn_hint')) + '">' + tH('bt_max_conn_label') + '</label>' +
    '<span class="share-port-group">' +
    '<input type="number" min="10" max="2000" step="10" value="' + (m.bt_max_connections != null ? m.bt_max_connections : 200) + '"' +
    disA(m.bt_max_connections_env_locked) + lockA(m.bt_max_connections_env_locked) +
    ' class="share-num-input" aria-label="' + escAttr(t('bt_max_conn_label')) + '" title="' + escAttr(t('bt_max_conn_hint')) + '" onchange="_setBtMaxConn(this)">' +
    '</span></div>';

  const portRow = '<div class="share-field share-port-row btc-builtin" id="share-port-row">' + _portRowInner(bt || {}, btOn) + '</div>';

  const selfName = (peers && peers.self) || '';
  const nameRow = '<div class="share-field"><label title="' + escAttr(t('peer_name_hint')) + '">' + tH('peer_advertising_as') + '</label>' +
    '<input type="text" class="peer-name-input" value="' + escAttr(selfName) + '" maxlength="63"' +
    (m.peer_name_env_locked ? ' disabled' : '') + lockA(m.peer_name_env_locked) +
    ' title="' + escAttr(t('peer_name_hint')) + '" aria-label="' + escAttr(t('peer_advertising_as')) + '" onchange="_setPeerName(this)"></div>';

  // Controls always in the DOM; with BT off the wrapper hides them
  // (.share-controls-off) and a toggle flips them in place, no re-render.
  // A client the operator runs owns its own limits, connections and port, so
  // those rows hide (.btc-ext) as soon as one is picked, before it is saved;
  // the ratio (Zimi's ledger), the queue and the name stay.
  window._btcSaved = (bt && bt.client) || {};
  const ext = !!window._btcSaved.kind;
  const btControls = '<div class="share-bt-controls' + (btOn ? '' : ' share-controls-off') + (ext ? ' btc-ext' : '') + '" id="ms-bt-controls">' +
    _btcEngineRow(bt) + ratioRow + limitRow + connRow + portRow + _upnpHtml(bt || {}, btOn) + '</div>' +
    '<!--btc-->';

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
    // The variable that set it, named once: off, the reason line under the
    // row says "BitTorrent is off (ZIMI_TORRENT=0)"; on, the lock note does.
    _shareSwitch('torrent', btOn, m.torrent_env_locked, btOn ? (m.torrent_env_var || 'ZIMI_BT') : '',
      'share_bt_title', tH('share_bt_desc'),
      // inactive, not locked: locked means an operator pinned it with an env
      // var and says so. Unavailable is the machine's answer, and the reason
      // line already gives it — claiming ZIMI_BT did this would be a lie.
      !btUsable, '',
      // Reason first, then the fields it explains. Both sit outside the dimmed
      // block: the reason so it stays readable, the fields because `disabled`
      // already greys them and dimming twice reads as damage.
      // Closed, the card says how BitTorrent is doing in one line; the
      // settings open under it, by themselves when something needs fixing.
      '<div class="ms-hint bt-why" id="ms-bt-why" hidden></div>' +
      '<details class="bt-more" id="ms-bt-more"' + (btOn ? '' : ' hidden') + '>' +
        '<summary class="bt-summary" id="ms-bt-status" onclick="window._btMoreTouched=true">' + (window._btStatusHtml || '') + '</summary>' + btControls + '</details>') +
    _shareSwitch('mirror', m.enabled, m.env_locked, 'ZIMI_BT',
      'share_mirror_title', tH('share_mirror_desc') + mirrorInner, !btOn, mirrorStatus)
      .replace('class="share-row', 'class="needs-bt' + (m.enabled ? ' is-on' : '') + ' share-row') +
    _shareSwitch('peer_share', m.peer_share, m.peer_share_env_locked, 'ZIMI_NEARBY',
      'share_nearby_title', tH('share_nearby_desc') +
        (m.peer_ip_unreachable ? '<div class="share-row-desc share-nearby-warn">⚠ ' + tH('nearby_bridge_warning') + '</div>' : ''),
      false, '', '<div id="ms-peer-name"' + (m.peer_share ? '' : ' hidden') + '><div class="share-bt-controls">' + nameRow + '</div></div>') +
  '</div>';
  if (prog.phase) _scheduleMirrorProgressPoll();
  // A redraw (a saved port, UPnP, a client saved) keeps the settings open
  // that the person was working in.
  var wasOpen = !!(document.getElementById('ms-bt-more') || {}).open;
  el.innerHTML = h.replace('<!--btc-->', _btcFormHtml(bt));
  if (wasOpen) document.getElementById('ms-bt-more').open = true;
  // The first-paint copy leaves out the client's form (its address and
  // login): browser storage is no place for them, and the real paint follows.
  try { localStorage.setItem(SK.SHARE_ROWS, h.replace('<!--btc-->', '')); } catch (e) {}
  // Fill the status dot + port dot in place.
  _renderSeedingSection();
  _natCheckOnOpen(btOn);
}


// ── The engine: built in, or a client the operator already runs (#53) ──
// The *arr apps' download-client form: URL, login, category, path mappings.
// kind: [name, the address it usually answers on]
var BT_CLIENTS = { qbittorrent: ['qBittorrent', 'http://qbittorrent:8080'], transmission: ['Transmission', 'http://transmission:9091'] };
function _btcName(kind) { return (BT_CLIENTS[kind] || [''])[0]; }
function _btcEngineRow(bt) {
  // A dropdown, as the other either/ors in Settings are. Locked by the
  // environment, or while anyone can manage Zimi; the reason is its title.
  var c = (bt && bt.client) || {}, kind = c.kind || '';
  var lock = !!c.locked;
  var why = c.locked === 'open' ? t('btc_locked_open') : lock ? t('env_controlled', { v: c.locked }) : '';
  var opt = function(val, label) {
    return '<option value="' + val + '"' + (val === kind ? ' selected' : '') + '>' + label + '</option>';
  };
  return '<div class="share-field"><label for="btc-engine">' + tH('bt_engine') + '</label>' +
    '<select id="btc-engine" class="btc-engine"' + (lock ? ' disabled title="' + escAttr(why) + '"' : '') + ' onchange="_btcEngine(this.value)">' +
    opt('', tH('bt_engine_builtin')) + Object.keys(BT_CLIENTS).map(function(k) { return opt(k, _btcName(k)); }).join('') + '</select></div>';
}
function _btcFormHtml(bt) {
  // The client's fields sit in the same label | field grid as the engine's
  // rows above them, so the card reads as one list.
  var c = (bt && bt.client) || {}, lock = c.locked, kind = c.kind || '';
  var dis = lock ? ' disabled' : '';
  var row = function(id, label, val, ph, type, auto) {
    return '<div class="share-field"><label for="' + id + '">' + tH(label) + '</label><input id="' + id + '" class="peer-name-input" type="' + (type || 'text') + '"' +
      ' autocomplete="' + (auto || 'off') + '" spellcheck="false" autocapitalize="off"' +
      (val ? ' value="' + escAttr(val) + '"' : '') + (ph ? ' placeholder="' + escAttr(ph) + '"' : '') + dis + '></div>';
  };
  return '<div class="btc-form" id="ms-btc" data-kind="' + kind + '"' + (kind ? '' : ' hidden') + '>' +
    '<div class="ms-hint" id="btc-note"' + (lock ? '' : ' hidden') + '>' + _btcNote(lock) + '</div>' +
    '<div class="share-bt-controls">' +
      row('btc-url', 'btc_url', c.url, kind ? BT_CLIENTS[kind][1] : '').replace('<input ', '<input dir="ltr" ') +
      row('btc-user', 'setup_username', c.user, t('btc_optional')) +
      row('btc-pw', 'btc_password', '', c.password_set ? t('btc_password_saved') : t('btc_optional'), 'password', 'new-password') +
      row('btc-cat', 'btc_category', c.category && c.category !== 'zimi' ? c.category : '', 'zimi') +
      '<div class="share-field btc-paths-field"><label title="' + escAttr(t('btc_paths_hint', { client: _btcName(kind) })) + '">' + tH('btc_paths') + '</label>' +
        '<div><div class="btc-paths" id="btc-paths">' + _btcPathRows(c.paths, kind, lock) + '</div>' +
        (lock ? '' : '<button type="button" class="btc-path-add" onclick="_btcPathAdd()">+ ' + tH('btc_path_add') + '</button>') +
        '</div></div>' +
    '</div>' +
    '<div class="btc-result" id="btc-result" role="status"></div>' +
    (lock ? '' : '<div class="btn-row"><button type="button" class="set-btn" onclick="_btcSubmit(true)">' + tH('btc_test') + '</button>' +
      '<button type="button" class="set-btn primary" onclick="_btcSubmit(false)">' + tH('save') + '</button></div>') +
    '</div>' +
    '<div class="btn-row btc-back" id="btc-back" hidden><button type="button" class="set-btn primary" onclick="_btcBackToBuiltin()">' + tH('btc_use_builtin') + '</button></div>';
}
// Path mappings, the *arr way: one row per folder, the client's path beside
// Zimi's. Sent as the "remote=local" lines the server keeps.
function _btcPathRow(remote, local, kind, dis) {
  // Each field carries its own name for the phone, where the two stack and
  // the column heads above them go.
  var inp = function(cls, val, ph, label) {
    return '<label class="btc-path-cell"><span>' + esc(label) + '</span><input type="text" dir="ltr" class="peer-name-input ' + cls + '" value="' + escAttr(val || '') + '" placeholder="' + escAttr(ph) + '"' +
      ' spellcheck="false" autocapitalize="off" autocomplete="off"' + (dis ? ' disabled' : '') + '></label>';
  };
  return '<div class="btc-path-row">' +
    inp('btc-path-remote', remote, '/downloads', t('btc_path_remote', { client: _btcName(kind) })) +
    '<span class="btc-path-arrow" aria-hidden="true">→</span>' +
    inp('btc-path-local', local, '/data/downloads', t('btc_path_local')) +
    (dis ? '' : '<button type="button" class="btc-path-del" aria-label="' + escAttr(t('remove')) + '" onclick="_btcPathDel(this)">×</button>') +
    '</div>';
}
function _btcPathRows(text, kind, dis) {
  var pairs = String(text || '').split(/[;\n]/).map(function(l) {
    var i = l.indexOf('=');
    return i < 0 ? null : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }).filter(Boolean);
  if (!pairs.length) pairs = [['', '']];
  var head = '<div class="btc-path-row btc-path-head"><span>' + tH('btc_path_remote', { client: _btcName(kind) }) + '</span><span></span><span>' +
    tH('btc_path_local') + '</span>' + (dis ? '' : '<span></span>') + '</div>';
  return head + pairs.map(function(p) { return _btcPathRow(p[0], p[1], kind, dis); }).join('');
}
function _btcPathAdd() {
  var box = document.getElementById('btc-paths');
  box.insertAdjacentHTML('beforeend', _btcPathRow('', '', document.getElementById('ms-btc').getAttribute('data-kind')));
  box.lastElementChild.querySelector('input').focus();
}
function _btcPathDel(btn) {
  var rows = document.querySelectorAll('#btc-paths .btc-path-row:not(.btc-path-head)');
  if (rows.length > 1) { btn.parentNode.remove(); return; }
  btn.parentNode.querySelectorAll('input').forEach(function(i) { i.value = ''; });
}
// The rows as remote=local lines, or null when a row has only one side (it
// is marked, rather than silently left out of what is saved).
function _btcPathsText() {
  var half = false;
  var lines = Array.prototype.map.call(document.querySelectorAll('#btc-paths .btc-path-row:not(.btc-path-head)'), function(r) {
    var ins = r.querySelectorAll('input'), a = ins[0].value.trim(), b = ins[1].value.trim();
    var bad = !a !== !b;
    ins.forEach(function(i) { i.classList.toggle('btc-path-bad', bad && !i.value.trim()); });
    half = half || bad;
    return a && b ? a + '=' + b : '';
  });
  return half ? null : lines.filter(Boolean).join('\n');
}
// Only a locked form explains itself: why its fields cannot be changed.
function _btcNote(lock) {
  return lock === 'open' ? tH('btc_locked_open') : lock ? tH('configured_via_env') : '';
}
async function _btcEngine(kind) {
  var form = document.getElementById('ms-btc');
  if (!form) return;
  var controls = document.getElementById('ms-bt-controls');
  if (controls) controls.classList.toggle('btc-ext', !!kind);
  var saved = window._btcSaved || {};
  _showIfOn('btc-back', false);
  if (kind) {
    // The form follows the client picked; what was typed for another one
    // (its address, its login) does not carry over.
    if (form.getAttribute('data-kind') !== kind) {
      form.setAttribute('data-kind', kind);
      var same = saved.kind === kind;
      var u = document.getElementById('btc-url');
      u.value = same ? (saved.url || '') : '';
      u.placeholder = BT_CLIENTS[kind][1];
      document.getElementById('btc-user').value = same ? (saved.user || '') : '';
      var pw = document.getElementById('btc-pw');
      pw.value = '';
      pw.placeholder = same && saved.password_set ? t('btc_password_saved') : t('btc_optional');

      document.querySelector('.btc-paths-field > label').title = t('btc_paths_hint', { client: _btcName(kind) });
      document.getElementById('btc-paths').innerHTML = _btcPathRows(same ? saved.paths : '', kind, saved.locked);
      document.getElementById('btc-result').textContent = '';
    }
    form.hidden = false;
    var url = document.getElementById('btc-url');
    if (url && !url.value) url.focus();
    return;
  }
  form.hidden = true;
  // Back to the built-in engine takes Zimi's torrents out of the client, so
  // it waits for a deliberate press instead of happening on the pick.
  _showIfOn('btc-back', !!saved.kind && !saved.locked);
}
async function _btcBackToBuiltin() {
  var res = null;
  try { res = await _btcPost({ kind: '' }); } catch (e) { /* said below */ }
  // Refused (the environment owns it, or the password is off): say so, or
  // the card redraws as it was and the button looks broken.
  if (!res || !res.ok) _showToast(_btcErr((res && res.d) || {}, { client: _btcName((window._btcSaved || {}).kind) }));
  _renderMirrorSection();
}
function _btcBody() {
  var v = function(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; };
  var body = { kind: document.getElementById('ms-btc').getAttribute('data-kind'), url: v('btc-url'), user: v('btc-user'),
    category: v('btc-cat'), paths: _btcPathsText() };
  var pw = document.getElementById('btc-pw').value;
  if (pw) body.password = pw;
  return body;
}
async function _btcPost(body) {
  var r = await manageFetch('/manage/bt-client', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: r.ok, d: await r.json().catch(function() { return {}; }) };
}
// The server's reason in the reader's language: a key with its values, or
// Zimi's own sentence (a refused login, a client too old).
var _BTC_ERRORS = { bad_url: 'btc_bad_url', open_locked: 'btc_locked_open', env_controlled: 'configured_via_env', bad_kind: 'error' };
function _btcErr(d, client) {
  if (d.error_key) return t(d.error_key, { client: client.client, code: d.code });
  return _BTC_ERRORS[d.error] ? t(_BTC_ERRORS[d.error]) : (d.error || t('error'));
}
async function _btcSubmit(test) {
  var out = document.getElementById('btc-result');
  var body = _btcBody(), client = { client: _btcName(body.kind) };
  if (!body.url) { out.className = 'btc-result btc-bad'; out.textContent = t('btc_need_url', client); return; }
  if (body.paths === null) { out.className = 'btc-result btc-bad'; out.textContent = t('btc_paths_half'); return; }
  if (test) body.test = true;
  out.className = 'btc-result'; out.textContent = t(test ? 'btc_testing' : 'saving');
  var res;
  try { res = await _btcPost(body); } catch (e) { out.className = 'btc-result btc-bad'; out.textContent = t('error'); return; }
  var d = res.d;
  if (!res.ok || !d.ok && test) { out.className = 'btc-result btc-bad'; out.textContent = _btcErr(d, client); return; }
  if (!test) { _showToast(t('saved')); _renderMirrorSection(); return; }
  // What works, then what each mapping would add: the test is where a person
  // finds out the two containers do not see the same disk.
  // The downloads folder is the one that must be visible; the library is a
  // choice (seed in place, or copy in), so it is said plainly, not as an error.
  var lines = [[t('btc_ok', { client: client.client, version: d.version }), ''],
    d.visible ? [t('btc_sees_downloads', { path: d.save_path }), ''] : [t('btc_no_downloads', { path: d.save_path }), 'btc-bad'],
    [d.library_mapped ? t('btc_library_mapped', client) : t('btc_library_unmapped', client), '']];
  out.className = 'btc-result';
  out.innerHTML = lines.map(function(l) { return '<div class="' + l[1] + '">' + esc(l[0]) + '</div>'; }).join('');
}

// ── Other library folders: another program's ZIMs, read where they are ──
// The folder stays that program's. Zimi never deletes, renames or updates a
// file in it, so there is nothing here to confirm, only to add or to stop reading.
const LIB_FOLDERS_URL = '/manage/library-folders';
async function _libFoldersPost(body) {
  var r = await manageFetch(LIB_FOLDERS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: r.ok, d: await r.json().catch(function() { return {}; }) };
}
function _libFolderRowHtml(title, desc, right, notes) {
  return '<div class="share-row set-row lf-row"><span class="share-row-text"><span class="share-row-title">' + title + '</span>' +
    '<span class="share-row-desc lf-path" dir="ltr">' + desc + '</span>' +
    (notes || []).map(function(n) { return '<span class="share-row-desc lf-note">' + esc(n) + '</span>'; }).join('') +
    '</span>' + right + '</div>';
}
function _libFolderCountHtml(count) { return ' <span class="lf-count">' + esc(count) + '</span>'; }
// What the folder holds that the library does not show, in a quiet line each.
function _libFolderNotes(f) {
  var notes = [];
  if ((f.shadowed || []).length) notes.push(t('lib_folders_shadowed', { n: f.shadowed.length }));
  if ((f.unreadable || []).length) notes.push(t('lib_folders_unreadable', { n: f.unreadable.length }) + ': ' +
    f.unreadable.map(function(u) { return u.file + ' (' + t('zim_unreadable_' + u.why) + ')'; }).join(', '));
  return notes;
}
const LIB_FOLDER_PLACEHOLDER = '/opt/project-nomad/storage/zim';
// Project NOMAD mode: Zimi asks NOMAD's own API to download, update and delete
// in NOMAD's library, so NOMAD's records, Kiwix and assistant stay in step.
// Off until the owner turns it on; read-only is what the page says otherwise.
const NOMAD_URL_PLACEHOLDER = 'http://nomad_admin:8080';
function _nomadModeHtml(n) {
  if (!n || !n.available) return '';
  var status = '';
  if (n.enabled) {
    status = n.reason === 'ok'
      ? t('nomad_mode_ok', { version: n.version })
      : t('nomad_mode_why_' + n.reason, { version: n.version, supported: (n.supported || []).join(', ') });
  }
  var url = n.enabled && !n.locked
    ? '<div class="lf-add"><input type="text" id="lf-nomad-url" dir="ltr" class="peer-name-input" value="' + escAttr(n.url || '') +
      '" placeholder="' + escAttr(NOMAD_URL_PLACEHOLDER) + '" aria-label="' + escAttr(t('nomad_mode_url')) +
      '" onkeydown="if(event.key===\'Enter\')_setNomadMode(true)">' +
      '<button type="button" class="set-btn" onclick="_setNomadMode(true)">' + tH('save') + '</button></div>'
    : '';
  return '<div class="ms-section-label">' + tH('nomad_mode_title') + '</div>' +
    _switchRowsHtml([{ id: 'ms-nomad-mode', title: tH('nomad_mode_toggle'), desc: tH('nomad_mode_desc'),
      on: !!n.enabled, disabled: !!n.locked, onchange: '_setNomadMode(this.checked)' }]) +
    (status ? '<div class="ms-hint nomad-status ' + (n.reason === 'ok' ? 'ok' : 'warn') + '">' + esc(status) + '</div>' : '') + url;
}
function _setNomadMode(on) {
  var inp = document.getElementById('lf-nomad-url');
  return _libFolderSend({ action: 'nomad', enabled: !!on, url: inp ? inp.value.trim() : '' });
}
async function _renderLibFolders() {
  var el = document.getElementById('ms-libfolders');
  if (!el) return;
  var d;
  try {
    var r = await manageFetch(LIB_FOLDERS_URL);
    // Naming a folder on the server's disk is for the primary admin; anyone
    // else sees no card at all, not a field that answers with a refusal.
    if (!r.ok) { el.innerHTML = ''; return; }
    d = await r.json();
  } catch (e) { return; }
  window._libFolders = d;
  var rows = (d.folders || []).map(function(f, i) {
    var count = f.present ? tPlural('lib_folders_zims', f.zims) : t('lib_folders_missing');
    var drop = f.source === 'env'
      ? '<button type="button" class="set-btn" onclick="_showToast(t(\'configured_via_env\'))">env</button>'
      : '<span class="lf-btns"><button type="button" class="set-btn" onclick="_libFolderRename(' + i + ')">' + tH('lib_folders_rename') + '</button>' +
        '<button type="button" class="set-btn" onclick="_libFolderAct(\'remove\', ' + i + ')">' + tH('lib_folders_stop') + '</button></span>';
    return _libFolderRowHtml(esc(f.label) + _libFolderCountHtml(count), esc(f.path), drop, _libFolderNotes(f));
  });
  // The offer comes once, ahead of the list, and leaves for good on either answer.
  var offers = (d.suggestions || []).map(function(sg, i) {
    return _libFolderRowHtml(tH('lib_folders_offer', { label: sg.label }) + _libFolderCountHtml(tPlural('lib_folders_zims', sg.zims)),
      esc(sg.path),
      '<span class="lf-btns"><button type="button" class="set-btn primary" onclick="_libFolderAct(\'add\', ' + i + ', true)">' + tH('lib_folders_add') + '</button>' +
      '<button type="button" class="set-btn" onclick="_libFolderAct(\'dismiss\', ' + i + ', true)">' + tH('lib_folders_not_now') + '</button></span>');
  });
  var add = '<div class="lf-add"><input type="text" id="lf-path" dir="ltr" class="peer-name-input" placeholder="' + escAttr(LIB_FOLDER_PLACEHOLDER) +
    '" aria-label="' + escAttr(t('lib_folders_title')) + '" onkeydown="if(event.key===\'Enter\')_libFolderAdd()">' +
    '<button type="button" class="set-btn" onclick="_libFolderAdd()">' + tH('lib_folders_add_folder') + '</button></div>';
  el.innerHTML = '<div class="ms-section-label">' + tH('lib_folders_title') + '</div>' +
    (offers.concat(rows).length ? '<div class="share-rows set-rows">' + offers.concat(rows).join('') + '</div>' : '') +
    add + '<div id="lf-msg" class="ms-hint">' + tH('lib_folders_hint') + '</div>' + _nomadModeHtml(d.nomad);
}
async function _libFolderRename(i) {
  var f = ((window._libFolders || {}).folders || [])[i];
  if (!f) return;
  var name = window.prompt(t('lib_folders_rename_prompt'), f.label);
  if (name === null) return;
  await _libFolderSend({ action: 'label', path: f.path, label: name });
}
async function _libFolderAct(action, i, offer) {
  var d = window._libFolders || {};
  var f = (offer ? d.suggestions : d.folders)[i];
  if (!f) return;
  await _libFolderSend({ action: action, path: f.path, label: f.label });
}
async function _libFolderAdd() {
  var inp = document.getElementById('lf-path');
  if (!inp || !inp.value.trim()) return;
  await _libFolderSend({ action: 'add', path: inp.value.trim() });
}
async function _libFolderSend(body) {
  var msg = document.getElementById('lf-msg');
  if (msg) msg.textContent = t('saving');
  var res;
  try { res = await _libFoldersPost(body); } catch (e) { if (msg) msg.textContent = t('error'); return; }
  if (!res.ok) { if (msg) msg.textContent = res.d.error_key ? t(res.d.error_key) : (res.d.error || t('error')); return; }
  // The library changed under the page: the lists that draw it start over.
  if (body.action !== 'dismiss') {
    zimsCache = await _fetchList();
    _rebuildZimsMap();
    _catalogCache = null;
    var count = document.getElementById('ms-zim-count');
    if (count) count.textContent = String(zimsCache ? zimsCache.length : 0);
  }
  _renderLibFolders();
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

  var toggle = _switchRowsHtml([{ title: tH('dl_schedule_toggle'), on: enabled, disabled: locked,
    onchange: '_setDownloadScheduleEnabled(this.checked)' }]);
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
  var uploadRow = '<div class="needs-bt' + (uploadRestrict ? ' is-on' : '') + '">' +
    _switchRowsHtml([{ title: tH('dl_upload_restrict'), on: uploadRestrict, disabled: locked,
      onchange: '_setUploadRestrict(this.checked)' }]) +
    (uploadRestrict ?
      '<div class="share-field ms-dl-trickle"><label>' + tH('dl_upload_trickle') + '</label>' +
        '<span class="share-port-group">' +
        '<input type="number" min="1" step="10" value="' + (s.upload_trickle_kb || 50) + '" id="ms-dl-trickle"' +
          (locked ? ' disabled' : '') + ' class="share-num-input" aria-label="' + escAttr(t('dl_upload_trickle')) +
          '" onchange="_setUploadTrickle(this)">' +
        '<span class="share-field-note">' + tH('dl_speed_unit') + '</span></span></div>' +
        '<div class="ms-hint">' + tH('dl_upload_trickle_hint') + '</div>' +
        (s.upload_throttled ? '<div class="ms-hint">' + tH('dl_upload_throttled_now') + '</div>' : '')
      : '') + '</div>';

  // How many downloads run at once, HTTP and BitTorrent alike; the rest queue.
  var maxLocked = !!s.max_active_downloads_locked;
  var maxRow = '<div class="share-field ms-dl-speed"><label title="' + escAttr(t('bt_max_dl_hint')) + '">' + tH('bt_max_dl_label') + '</label>' +
    '<span class="share-port-group">' +
    '<input type="number" min="1" max="20" step="1" value="' + (s.max_active_downloads != null ? s.max_active_downloads : 4) + '"' +
      (maxLocked ? ' disabled' : '') + ' class="share-num-input" aria-label="' + escAttr(t('bt_max_dl_label')) +
      '" title="' + escAttr(t('bt_max_dl_hint')) + '" onchange="_setBtMaxDl(this)">' +
    '</span></div>';

  // Limits first (how many, how fast), then the nightly window with the
  // upload restriction that shares its times right under it.
  el.innerHTML = maxRow + speedRow + toggle + lockNote + windowBlock + uploadRow;
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
//                      (POST/GET /userdata). Settings and the saved store follow any signed-in account, the admin too, on their own (_prefTake, _savedPull).
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
// _PREF_KEYS is defined with SK, at the top.

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

// An import's Merge data switch, on by default. Turned off, the file replaces
// everything, and the row says so in red under its title.
function _mergeRowHtml(id) {
  return _switchRowsHtml([{ id: id, cls: 'merge-row', title: tH('backup_merge'), on: true,
    desc: tH('backup_replace_warn'),
    onchange: "this.closest('.set-row').classList.toggle('merge-off', !this.checked)" }]);
}
// Replace only when the switch is there and turned off: an import with no
// pane open (an account restore) always merges.
function _replaceChosen(id) {
  var cb = document.getElementById(id);
  return !!(cb && !cb.checked);
}

// ── Card markup ──
// "My data" is the only card a signed-in non-admin sees (rendered standalone by
// _renderUserManage); an admin finds it under Preferences (it is this
// browser's), the server's backup under Server.
// What the signed-in person is called in games and on this server's boards
// (app.js _displayNameSheet), with the way to change it.
function _displayNameRowHtml() {
  if (typeof _gamesAccount === 'undefined' || !_gamesAccount) return '';
  return '<div class="ms-user-row ms-display-row"><span class="ms-user-main">' + tH('display_name_label') + ' <strong>' +
    esc(_displayName || '') + '</strong></span><button class="ms-btn" onclick="_displayNameSheet()">' + tH('display_name_change') + '</button></div>';
}

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
    _mergeRowHtml('ms-mydata-merge') +
    '<div id="ms-mydata-result" class="ms-backup-import"></div>';
}

function _serverBackupCardHtml() {
  return '<div class="ms-section-label">' + tH('backup_server_title') + '</div>' +
    '<div class="ms-hint">' + tH('backup_server_intro') + '</div>' +
    '<div class="ms-backup-actions">' +
      '<button class="pill" onclick="exportServerBackup()">' + tH('backup_export_file') + '</button>' +
      '<button class="pill" onclick="document.getElementById(\'ms-server-file\').click()">' + tH('backup_import_file') + '</button>' +
      '<input type="file" id="ms-server-file" accept="application/json,.json" style="display:none" onchange="importServerBackupFile(this)">' +
      '<span id="ms-server-status" class="ms-hint" style="margin:0;align-self:center"></span>' +
    '</div>' +
    _mergeRowHtml('ms-server-merge') +
    '<div id="ms-server-import" class="ms-backup-import"></div>';
}

function _downloadJson(filename, obj) {
  var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

// History lives in localStorage (a signed-in user's copy rides in their own
// /userdata blob). Identity is zim+path, newest (by timestamp) wins on
// conflict. What is saved has a store of its own with its own merge (Saved).
function _historyKey(b) {
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
// a file, from a file, or to/from the signed-in user's server account. The
// saved store rides as `saved`; a file from before 1.12 carries bookmarks and
// folders instead, and they come in through the same migration. ──
function _collectBrowserData() {
  return {
    saved: Saved.data(),
    history: _histLoad().slice(),
    preferences: _collectPreferences(),
  };
}

function _applyBrowserData(data, overwrite, fromAccount) {
  var res = { bm: { added: 0, dupes: 0 } };
  if (data && data.preferences && typeof data.preferences === 'object') {
    Object.keys(data.preferences).forEach(function(k) {
      if (_PREF_KEYS.indexOf(k) === -1) return;  // ignore unknown/foreign keys
      _prefWrite(k, data.preferences[k]);
    });
  }
  if (data) res.bm = _savedTake(data, overwrite, fromAccount);
  if (data && Array.isArray(data.history)) {
    // The history the panel shows (it used to go to a key nothing read).
    _persistHist = _mergeByKey(_histLoad(), data.history, _historyKey, overwrite).list;
    _histSave();
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
  var res = _applyBrowserData(bundle, _replaceChosen('ms-mydata-merge'));
  _setBackupStatus('ms-mydata-status', 'backup_mydata_imported');
  _showMyDataResult(res);
}

async function saveMyDataToServer() {
  _setBackupStatus('ms-mydata-status', 'working');
  try {
    var res = await fetch('/userdata', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(_collectBrowserData(), { account: _accountId })),
    });
    if (res.status === 401 || res.status === 409) _accountRecheck();
    if (!res.ok) throw new Error('http ' + res.status);
    // The account merged this browser's store with its own: take the result.
    var back = await res.json().catch(function() { return null; });
    if (back && back.saved) Saved.merge(back.saved, { fromSync: true });
    _setBackupStatus('ms-mydata-status', 'backup_saved_server');
  } catch (e) { _setBackupStatus('ms-mydata-status', 'error'); }
}

async function restoreMyDataFromServer() {
  _setBackupStatus('ms-mydata-status', 'working');
  var data;
  try {
    var res = await fetch(_accountUrl('/userdata'), { credentials: 'same-origin' });
    if (res.status === 401 || res.status === 409) _accountRecheck();
    if (!res.ok) throw new Error('http ' + res.status);
    data = await res.json();
  } catch (e) { _setBackupStatus('ms-mydata-status', 'error'); return; }
  var res2 = _applyBrowserData(data || {}, _replaceChosen('ms-mydata-merge'), true);
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
  var overwrite = _replaceChosen('ms-server-merge');
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
  var overwrite = _replaceChosen('ms-server-merge');
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
  if (!_libraryKnown) { el.innerHTML = _libraryUnavailableHtml(); _renderOfflineHome(); return; }
  if (!zims.length) {
    el.innerHTML = '<div class="empty"><p>' + tH('no_zims_installed') + '</p><div class="hint">' + tH('switch_to_catalog') + '</div></div>';
    return;
  }

  // Group by category. ZIMs with pending updates are pulled into a separate
  // "Updates available" pseudo-group rendered first so they're easy to spot.
  const groups = {};
  const pendingUpdates = [];
  // The search grammar, as the catalog has it: "-wiki" leaves the wikis out (#94).
  const installedParsed = filterText ? parseSearchQuery(filterText) : null;
  for (const z of zims) {
    const cat = _zimCat(z);  // real category or OTHER_CAT — matches the home grouping
    if (manageCategoryFilter && cat !== manageCategoryFilter) continue;
    if (manageLangFilter && !_zimMatchesLang(z, manageLangFilter)) continue;
    if (installedParsed && !_libraryMatches(installedParsed, z, cat)) continue;
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
    items.sort(cmpTitle);
    items_h += '<div class="manage-installed-group' + (cat === '__updates__' ? ' mig-updates' : '') + '">';
    const groupLabel = cat === '__updates__' ? t('updates_available_section') : _catDisplayName(cat);
    // Real-category headers are drop targets for the row DnD (#37) — data-cat
    // names the destination; the Updates pseudo-group is never a target.
    const dropAttr = cat === '__updates__' ? '' : ' data-cat="' + escAttr(cat) + '"';
    items_h += '<div class="ci-section-label"' + dropAttr + '>' + _countedLabelHtml(groupLabel, items.length) + '</div>';
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
      if (z.unreadable) meta.push('<span class="ci-bad">' + esc(t('zim_unreadable_' + z.unreadable)) + '</span>');
      if (z.also_in) meta.push('<span>' + esc(t('zim_also_in', { label: z.also_in })) + '</span>');
      if (z.via) meta.push('<span>' + esc(t('zim_via', { label: z.via })) + '</span>');
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
          _zimDeleteBtn(z.file, z.external);
      } else {
        actionsHtml = (z.external ? '' : '<span class="ci-installed-badge">' + tH('installed_badge') + '</span>') +
          _zimDeleteBtn(z.file, z.external);
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

  // Changing it asks for the current password first: the browser keeps a
  // session token now, never the password, so it has nothing to offer as
  // proof on its own.
  let current = '';
  if (has.has_password) {
    current = await new Promise(function(resolve) {
      openPwModal(t('change_password'), {placeholder: t('current_password'), hideRemember: true});
      document.getElementById('pw-remove-btn').style.display = 'none';
      _pwResolve = function(pw) { _pwResolve = null; resolve(pw); };
      _pwReject = function() { resolve(null); };
    });
    if (current === null) return;
  }
  openPwModal(has.has_password ? t('change_password') : t('set_password'), {placeholder: t('new_password'), hideRemember: true});
  document.getElementById('pw-remove-btn').style.display = has.has_password ? '' : 'none';

  _pwResolve = async function(newPw) {
    // submitPw set _manageUser from the (now visible) username field; store it
    // alongside the new password so future logins must present it.
    const wasRemembered = !!localStorage.getItem(SK.MANAGE_PW);
    const body = {password: newPw, username: _manageUser || 'admin', remember: wasRemembered};
    if (has.has_password) body.current = current;
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
    // The server hands back a fresh session for the new password.
    const d = await res.json().catch(() => ({}));
    _manageToken = (newPw && d.token) || '';
    if (_manageToken) _saveManageToken(_manageToken, wasRemembered);
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
    if (err.error) _showToast(err.error === 'open_locked' ? t('open_locked') : err.error);
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
    if (err.error) _showToast(err.error === 'open_locked' ? t('open_locked') : err.error);
    return;
  }
  var data = await res.json();
  var el = document.getElementById('ms-security');
  if (el) {
    el.innerHTML = '<div style="padding:10px;background:var(--surface);border:1px solid var(--amber-border);border-radius:8px;font-family:monospace;font-size:12px;word-break:break-all">' +
      '<div style="color:var(--text2);font-size:11px;margin-bottom:4px">' + tH('copy_token_now') + '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<span>' + esc(data.token) + '</span>' +
      '<button class="pill" data-token="' + escAttr(data.token) + '" onclick="_copyText(this.dataset.token)">' + tH('copy') + '</button>' +
      '</div></div>' +
      '<button class="pill" style="margin-top:8px" onclick="_renderAccessCards()">' + tH('done') + '</button>';
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
  _renderAccessCards();
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
    // Kiwix's catalog resolves through the mirror machinery; anything else
    // (StreetZim on the Internet Archive) is a plain HTTPS fetch of a .zim,
    // which is what the import path does.
    const endpoint = /^https:\/\/archive\.org\//.test(url) ? '/manage/import' : '/manage/download';
    const res = await manageFetch(endpoint, {
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

// ── Zimi's own ZIMs (the Almanac, Games) in the Catalog ──
// Deleting one is an ordinary delete (the server records it as removed: the file is part of the
// package and stays). The Catalog lists them from the package (/manage/own-zims), offline too,
// as normal rows in the Zimi category; a removed one offers Add, instantly, with no download.
var OWN_CATALOG_CAT = 'zimi';
async function _loadOwnCatalogRows() {
  try {
    var d = await (await manageFetch('/manage/own-zims')).json();
    return (d.zims || []).map(function(r) {
      return { name: r.name, title: r.title, summary: r.description, icon_url: r.icon, size_bytes: r.size_bytes,
        article_count: r.entries, date: r.date, language: 'eng', category: OWN_CATALOG_CAT, own: true };
    });
  } catch (e) { return []; }
}
async function _addOwnZim(name) {
  try {
    var d = await (await manageFetch('/manage/own-zims', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: name, removed: false})
    })).json();
    if (d.error) { _showToast(t('error') + ': ' + d.error); return; }
  } catch (e) { _showToast(t('error')); return; }
  zimsCache = await _fetchList();
  _rebuildZimsMap();
  _enrichCatalogItems(_catalogCache || []);
  var count = document.getElementById('ms-zim-count');
  if (count) count.textContent = String(zimsCache.length);
  if (mode === 'manage') _rerenderCatalogIfSafe();
}

// A catalog row offers Update when its catalog edition is newer than the file
// installed. Never for a ZIM in a folder another program owns: an update would
// download a second full copy into Zimi's own library beside the original.
function _catalogHasUpdate(inst, upd) {
  return !inst._installedExternal && !!(inst._installedDate && upd.date && upd.download_url
    && inst._installedDate < upd.date.substring(0, 7));
}
// A ZIM in a folder another program owns (Project NOMAD) is Zimi's to read and
// not to delete: the row says whose it is where the delete button would be.
function _zimDeleteBtn(file, external) {
  if (external) return '<button type="button" class="ci-installed-badge ci-from" data-label="' + escAttr(external) +
    '" onclick="event.stopPropagation();_ownedNote(this)">' + esc(t('in_folder', { label: external })) + '</button>';
  return '<button class="ci-delete-btn" onclick="deleteZim(\'' + escAttr(file) + '\', this)" title="' + escAttr(t('delete_zim')) + '">\u00D7</button>';
}
// Touch has no hover: a tap on the badge says why there is no Delete.
function _ownedNote(el) { _showToast(t('folder_not_ours', { label: el.getAttribute('data-label') })); }
async function deleteZim(filename, btn) {
  if (!btn) return;
  var gone = (zimsCache || []).filter(function(z) { return z.file === filename; })[0];
  var goneName = gone && gone.name;
  // ZimiGames takes this browser's play with it: a dialog says so, in place of the two clicks.
  if (goneName === _GAMES_ZIM) {
    if (!await _appConfirm(_deleteConfirmText(goneName), t('delete'))) return;
    btn.classList.add('confirming');
  }
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
    if (data.error_key) {
      // Refused: not Zimi's file (a page from before it knew). Put the card
      // back and say so in words.
      zimsCache = await _fetchList();
      _rebuildZimsMap();
      if (card) card.style.display = '';
      btn.disabled = false;
      btn.classList.remove('confirming');
      btn.textContent = '\u00D7';
      _showToast(t(data.error_key, { label: data.label || '' }));
      return;
    }
    if (data.error) {
      // Restore card on error
      if (card) card.style.display = '';
      btn.textContent = t('error') + ': ' + data.error;
      return;
    }
    if (card) card.remove();
    _afterZimDeleted(goneName);
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
    const statusVal = document.getElementById('ms-zim-count');
    if (statusVal) statusVal.textContent = String(zimsCache ? zimsCache.length : 0);
    _renderAutoUpdateSection();
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
  var code = _normLang(lang);
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
// Patch an element's children to match new markup instead of replacing them.
// Rebuilding innerHTML on every poll made the Downloads tab flicker: each
// rebuild re-created every <img>, which the browser paints blank for a frame,
// and restarted the sweeping-bar animation from zero. Same tag in the same
// place is kept and its attributes and text brought up to date; anything else
// is swapped. Inline onclick handlers are attributes, so they survive too.
function _morphInto(el, html) {
  var tpl = document.createElement('template');
  tpl.innerHTML = html;
  _morphChildren(el, tpl.content);
}
function _morphChildren(oldParent, newParent) {
  var oldKids = Array.prototype.slice.call(oldParent.childNodes);
  var newKids = Array.prototype.slice.call(newParent.childNodes);
  var n = Math.max(oldKids.length, newKids.length);
  for (var i = 0; i < n; i++) {
    var o = oldKids[i], w = newKids[i];
    if (!w) { oldParent.removeChild(o); continue; }
    if (!o) { oldParent.appendChild(w); continue; }
    if (o.nodeType !== w.nodeType || (o.nodeType === 1 && o.tagName !== w.tagName)) {
      oldParent.replaceChild(w, o);
      continue;
    }
    if (o.nodeType === 3) { if (o.nodeValue !== w.nodeValue) o.nodeValue = w.nodeValue; continue; }
    if (o.nodeType !== 1) continue;
    _morphAttrs(o, w);
    _morphChildren(o, w);
  }
}
function _morphAttrs(o, w) {
  var i, a;
  for (i = o.attributes.length - 1; i >= 0; i--) {
    a = o.attributes[i].name;
    if (!w.hasAttribute(a)) o.removeAttribute(a);
  }
  for (i = 0; i < w.attributes.length; i++) {
    a = w.attributes[i];
    if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
  }
  // Properties an attribute no longer drives once the element exists.
  if ('disabled' in o && o.disabled !== w.disabled) o.disabled = w.disabled;
}

// Recent transfer rate per download, from the bytes that arrived between two
// polls. The average since start (bytes / elapsed) is what the row used to
// show; it lags a swarm that just found peers by minutes and never catches a
// stall. This follows the transfer within a couple of polls, smoothed so one
// slow poll does not swing the ETA.
var _dlRates = {};
var _DL_RATE_SMOOTHING = 0.6;  // weight kept from the previous estimate
var _DL_STALL_BPS = 1024;      // under this, no ETA: it would only grow
function _dlRecentRate(dl, now) {
  var prev = _dlRates[dl.id];
  var bytes = dl.downloaded_bytes || 0;
  var bps = null;
  // Ids restart from 1 with the server, so a tab left open across a restart
  // meets a new download under an old id; the filename tells them apart.
  if (prev && prev.file !== dl.filename) prev = null;
  if (prev && now > prev.t && bytes >= prev.bytes) {
    var inst = (bytes - prev.bytes) / ((now - prev.t) / 1000);
    bps = prev.bps == null ? inst : prev.bps * _DL_RATE_SMOOTHING + inst * (1 - _DL_RATE_SMOOTHING);
  }
  _dlRates[dl.id] = {t: now, bytes: bytes, bps: bps, file: dl.filename};
  return bps;
}
// Forget downloads that left the list, so the map does not grow for the
// life of the tab.
function _pruneDlRates(dls) {
  var live = {};
  for (var i = 0; i < dls.length; i++) live[dls[i].id] = true;
  Object.keys(_dlRates).forEach(function(id) { if (!live[id]) delete _dlRates[id]; });
}
// "1h 12m left", "4m left", "under a minute left". Coarse on purpose: an ETA
// to the second on a swarm is a number that changes faster than it can be read.
function _fmtEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return t('dl_eta_under_minute');
  var m = Math.max(1, Math.round(seconds / 60));
  var time;
  if (m < 60) time = m + 'm';
  else if (m < 24 * 60) time = Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  else time = Math.floor(m / 1440) + 'd' + (Math.floor((m % 1440) / 60) ? ' ' + Math.floor((m % 1440) / 60) + 'h' : '');
  return t('dl_eta_left', {time: time});
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
      _pruneDlRates(dls);
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
    // They are built apart and appended AFTER the downloads: a download in
    // flight is the thing this tab exists for, and it was rendering below two
    // idle seeds. The seeding section always carries its own heading, so the
    // two never read as one list.
    let seedHtml = '';
    if (filter === 'seeding' || filter === 'all') {
      // Bulk seed controls sit at the TOP RIGHT of the seeds section (title
      // left, actions right — same reading order as the downloads bulk bar).
      // Pause/Resume all only when a seed is in that state to act on;
      // Remove all always. Under "All" they appear once there are 2+ seeds
      // (a single seed's own row buttons cover it). The hint line spells out
      // what Remove actually does — see /manage/seeding-action: the torrent
      // is de-listed and its ledger intent dropped, files stay on disk.
      if (seedingTorrents.length) {
        const bulk = filter === 'seeding' || seedingTorrents.length >= 2;
        const anyPausableSeed = bulk && seedingTorrents.some(s => s.state !== 'paused');
        const anyResumableSeed = bulk && seedingTorrents.some(s => s.state === 'paused');
        seedHtml += '<div class="dl-seed-head">' +
          '<span class="dl-seed-head-title">' + tH('seeding_tab') + '</span>' +
          '<div class="dl-seed-actions">' +
            (anyPausableSeed ? '<button class="dl-bulk-btn" onclick="pauseAllSeeds()">' + tH('dl_pause_all') + '</button>' : '') +
            (anyResumableSeed ? '<button class="dl-bulk-btn" onclick="resumeAllSeeds()">' + tH('dl_resume_all') + '</button>' : '') +
            (bulk ? '<button class="dl-cancel-btn" onclick="_seedAction(null, \'stop_all\', this)" title="' + escAttr(t('stop_all_seeds_tip')) + '">' + tH('stop_all_seeds') + '</button>' : '') +
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
        seedHtml += '<div class="dl-item dl-seed-item">' +
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
        seedHtml += '<div class="dl-empty">' + tH('seeding_empty') + '</div>';
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
    const _dlNow = Date.now();
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
      // Recent rate when two polls have seen it move, the average since start
      // until then. A paused or queued row is not moving; forget its rate so
      // resuming starts a fresh estimate rather than an ETA from stale bytes.
      let bps = 0;
      // Verifying is disk, not network: the counter climbs at disk speed and
      // a rate taken from it would promise an ETA the swarm cannot keep.
      if (dl.paused || dl.queued || dl.done || dl.checking) delete _dlRates[dl.id];
      else {
        const recent = useCache ? (_dlRates[dl.id] || {}).bps : _dlRecentRate(dl, _dlNow);
        bps = recent != null ? recent : (dl.elapsed > 0 && dl.downloaded_bytes > 0 ? dl.downloaded_bytes / dl.elapsed : 0);
      }
      const speed = (bps / 1024 / 1024).toFixed(1);
      // Below a kilobyte a second the transfer is stalled, and an ETA from
      // a rate decaying toward zero grows without bound ("12d left").
      const eta = (bps > _DL_STALL_BPS && dl.total_bytes && dl.total_bytes > dl.downloaded_bytes)
        ? _fmtEta((dl.total_bytes - dl.downloaded_bytes) / bps) : '';

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
      } else if (dl.checking) {
        // libtorrent re-verifying what is already on disk after a restart.
        // Nothing is being downloaded; the bar shows how much has been read.
        h += '<span class="dl-size">' + tH('dl_verifying', {pct: Math.round(pct)}) + '</span>';
      } else if (indeterminate) {
        h += '<span class="dl-size">' + tH('bt_connecting') + '</span>';
      } else {
        h += '<span class="dl-size">' + dlStr + ' / ' + totalStr + ' · ' + Math.round(pct) + '% · ' + speed + ' MB/s' + (eta ? ' · ' + esc(eta) : '') + '</span>';
      }
      h += '</div>';

      if (!dl.done && !dl.error) {
        h += '<div class="dl-progress' + (dl.paused ? ' dl-paused' : '') + (indeterminate ? ' dl-indeterminate' : '') + (dl.checking ? ' dl-checking' : '') +
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
    h += seedHtml;
    h += '</div>';  // close .dl-grid
    h += '</div>';  // close .manage-card
    _morphInto(dlEl, h);
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
      const updateBtn = document.getElementById('update-all-btn');
      if (anyActive) {
        // Downloads still running: the count stays "N available" and the
        // button beside it counts down the updates still in flight.
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
        const countVal = document.getElementById('ms-zim-count');
        if (countVal) countVal.textContent = String(sd.zim_count);
        const sizeVal = document.getElementById('ms-total-size');
        if (sizeVal) sizeVal.textContent = fmtSize(sd.total_size_gb);
        _paintLibShares(sd);
        _renderAutoUpdateSection();
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
    versions.textContent = u.installed_date + ' → ' + u.latest_date + (u.size_bytes ? ' · ' + formatSize(u.size_bytes) : '');
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
    if (u.renamed_to) {
      const ren = document.createElement('div');
      ren.className = 'updates-detail-fnames';
      ren.textContent = t('renamed_upstream', {name: u.renamed_to});
      row.appendChild(ren);
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
  return '<svg title="Auto-update ' + escAttr(sel.value) + '" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;opacity:0.5;margin-right:5px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
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
    value = '<span class="mc-value" style="color:var(--amber)">' + _autoUpdateTimerHtml() + tPluralH('updates_available', count) +
      '<svg class="mc-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span>';
    clickable = true;
  } else {
    value = '<span class="mc-value" style="color:var(--text2)">' + tH('all_up_to_date') + '</span>';
  }
  // The button is detached across the repaint so its disabled/progress state
  // survives, then set right after the count.
  if (updateBtn && updateBtn.parentNode) updateBtn.parentNode.removeChild(updateBtn);
  el.innerHTML = label + '<span class="mc-updates-end">' + value + '</span>';
  if (updateBtn) el.lastChild.appendChild(updateBtn);
  if (clickable) {
    el.classList.add('mc-row-clickable');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.style.cursor = 'pointer';
    el.title = t('updates_show_detail');
    el.onclick = _toggleUpdatesDetail;
    el.onkeydown = function(e) { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); _toggleUpdatesDetail(); } };
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
